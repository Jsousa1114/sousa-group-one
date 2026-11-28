"use strict";
const Contacts = require("./contacts");
// Client replies read from each company's Gmail inbox (IMAP, same address and app password).
// Only two kinds of messages are kept: replies to an e-mail sent by the application (matched
// by Message-ID), and messages from the address of a known client. The rest of the mailbox is
// never stored. Attachments are listed by name only.
const { randomUUID, createHash } = require("node:crypto");
const D = require("./domain");
const { loadState } = require("./db");
const mailer = require("./mailer");

const companyOf = (state, id) => {
  const c = (state?.companies || []).find((x) => D.same(x.id, id));
  return c ? { id: String(c.id), name: c.name || "", code: c.code || "" } : { id: String(id || "") };
};

// One entry per Gmail account, with the companies that send from it.
function accounts(state) {
  const byUser = new Map();
  for (const c of state.companies || []) {
    const settings = mailer.imapSettings(companyOf(state, c.id));
    if (!settings?.host) continue;
    const entry = byUser.get(settings.user) || { ...settings, companies: [] };
    entry.companies.push(String(c.id));
    byUser.set(settings.user, entry);
  }
  return [...byUser.values()];
}

// Reads the messages that arrived since the last check (at most `limit`).
async function fetchNew(account, row, { limit = 40 } = {}) {
  const { ImapFlow } = require("imapflow");
  const client = new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: { user: account.user, pass: account.pass },
    logger: false,
    emitLogs: false,
    socketTimeout: 60000,
  });
  // Without a listener, a network error event would stop the whole server.
  client.on("error", (error) => console.warn("mail.inbox.imap_error", error?.code || "unknown"));
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const uidValidity = String(client.mailbox.uidValidity);
    const lastUid = row.uid_validity === uidValidity ? Number(row.last_uid) || 0 : 0;
    const found = (await client.search(lastUid ? { uid: `${lastUid + 1}:*` } : { since: new Date(row.since) }, { uid: true })) || [];
    const uids = found.filter((uid) => uid > lastUid).sort((a, b) => a - b).slice(0, limit);
    const messages = [];
    if (uids.length)
      for await (const message of client.fetch(uids.join(","), { uid: true, size: true, source: true }, { uid: true }))
        messages.push({ uid: message.uid, source: message.size > 5 * 1024 * 1024 ? null : message.source });
    return { uidValidity, messages, maxUid: uids.length ? uids.at(-1) : lastUid };
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

// Keeps the new part of a reply: the quoted earlier message is cut off.
function replyText(parsed) {
  let body = parsed.text || "";
  if (!body && parsed.html) {
    try {
      body = require("html-to-text").convert(parsed.html, { wordwrap: false });
    } catch {
      body = String(parsed.html).replace(/<[^>]+>/g, " ");
    }
  }
  const lines = body.replace(/\r/g, "").split("\n");
  const cut = lines.findIndex(
    (line) =>
      /^\s*(Le .{4,160}a écrit\s*:|On .{4,160}wrote\s*:|Am .{4,160}schrieb.*:|-{2,}\s*(Original Message|Message d’origine|Message d'origine)\s*-{2,})/i.test(line) ||
      /^\s*(De|From)\s*:\s*.+@.+/i.test(line),
  );
  const kept = (cut > 0 ? lines.slice(0, cut) : lines).filter((line, i, all) => !(line.startsWith(">") && all.slice(i).every((l) => l.startsWith(">") || !l.trim())));
  return kept.join("\n").trim().slice(0, 20000);
}

// People who can open the mailbox already get the « Boîte mail » notification for the message.
async function notifyFinance(db, company, title, body, skip = []) {
  const users = (
    await db.query("SELECT id,company FROM users WHERE role IN ('admin','direction','accounting') AND disabled=false AND deleted_at IS NULL")
  ).rows.filter((u) => (u.company === "group" || u.company === company) && !skip.includes(Number(u.id)));
  if (!users.length) return;
  await require("./messaging-routes")
    .notifyUsers(db, users.map((u) => u.id), { category: "finance", title, body, url: "/?open=invoices" })
    .catch(() => {});
}

// Links a message to what it answers, or at least to the client who wrote it.
async function classify(db, state, account, parsed) {
  const from = parsed.from?.value?.[0] || {};
  const address = String(from.address || "").trim().toLowerCase();
  const refs = [parsed.inReplyTo, ...(Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [])].filter(Boolean).map(String);
  let link = null;
  if (refs.length) {
    const sent = (await db.query("SELECT company,entity_type,entity_id FROM email_log WHERE message_id = ANY($1::text[]) ORDER BY created_at DESC LIMIT 1", [refs])).rows[0];
    if (sent) link = { company: sent.company, entityType: sent.entity_type, entityId: sent.entity_id };
  }
  let clientId = "";
  if (link?.entityType === "invoices" || link?.entityType === "quotes")
    clientId = String((state[link.entityType] || []).find((x) => D.same(x.id, link.entityId))?.clientId || "");
  else if (link?.entityType === "clients") clientId = String(link.entityId || "");
  else if (link?.entityType === "appointments") {
    const project = (state.projects || []).find((p) => D.same(p.id, String(link.entityId).split("|")[0]));
    clientId = String(project?.clientId || "");
  }
  if (!clientId && address) {
    const clients = (state.clients || []).filter((c) => !c.deletedAt && Contacts.hasEmail(c, address));
    const client = clients.find((c) => account.companies.includes(String(c.company))) || clients[0];
    if (client) clientId = String(client.id);
  }
  if (!link && !clientId) return null;
  const client = (state.clients || []).find((c) => D.same(c.id, clientId));
  return {
    company: link?.company || client?.company || account.companies[0] || null,
    clientId: clientId || null,
    entityType: link?.entityType || null,
    entityId: link?.entityId || null,
    fromAddress: address,
    fromName: String(from.name || client?.name || "").slice(0, 200),
  };
}

async function processInbox(db, { now = new Date(), fetcher = fetchNew } = {}) {
  const result = { checked: 0, stored: 0 };
  if (!mailer.configured()) return result;
  const { simpleParser } = require("mailparser");
  const state = (await loadState(db)).data;
  const webmail = require("./webmail");
  for (const account of accounts(state)) {
    const box = webmail.mailboxes(state).find((b) => b.address.toLowerCase() === String(account.user).toLowerCase());
    const mailboxReaders = box ? await webmail.usersWithAccess(db, box).catch(() => []) : [];
    let row = (await db.query("SELECT * FROM email_inbox_state WHERE account=$1", [account.user])).rows[0];
    if (!row)
      // First check: the last day only, never the whole mailbox.
      row = (
        await db.query("INSERT INTO email_inbox_state(account,since) VALUES($1,$2) RETURNING *", [account.user, new Date(now.getTime() - 86400000)])
      ).rows[0];
    let fetched;
    try {
      fetched = await fetcher(account, row);
    } catch (error) {
      const message = /auth/i.test(String(error?.authenticationFailed || error?.code || error?.message || ""))
        ? "Gmail a refusé la connexion à la boîte de réception (vérifiez le mot de passe d’application)."
        : "Boîte de réception injoignable pour le moment.";
      await db.query("UPDATE email_inbox_state SET last_error=$2,checked_at=NOW() WHERE account=$1", [account.user, message]);
      console.warn("mail.inbox.failed", error?.code || "unknown");
      continue;
    }
    result.checked++;
    for (const message of fetched.messages) {
      if (!message.source) continue;
      let parsed;
      try {
        parsed = await simpleParser(message.source);
      } catch {
        continue;
      }
      const from = String(parsed.from?.value?.[0]?.address || "").toLowerCase();
      // The account's own messages (sent copies, tests) are not replies.
      if (!from || from === account.user.toLowerCase()) continue;
      const link = await classify(db, state, account, parsed);
      if (!link) continue;
      const messageId = String(parsed.messageId || "uid-" + createHash("sha256").update(account.user + ":" + message.uid).digest("hex").slice(0, 24));
      const inserted = (
        await db.query(
          `INSERT INTO email_inbox(id,company,account,message_id,in_reply_to,from_address,from_name,subject,body,attachments,received_at,client_id,entity_type,entity_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(account,message_id) DO NOTHING RETURNING id`,
          [
            randomUUID(),
            link.company,
            account.user,
            messageId.slice(0, 500),
            parsed.inReplyTo ? String(parsed.inReplyTo).slice(0, 500) : null,
            link.fromAddress,
            link.fromName,
            String(parsed.subject || "").slice(0, 300),
            replyText(parsed),
            JSON.stringify((parsed.attachments || []).slice(0, 20).map((a) => ({ name: String(a.filename || "pièce jointe").slice(0, 120), size: a.size || 0 }))),
            parsed.date instanceof Date && !Number.isNaN(parsed.date.getTime()) ? parsed.date : now,
            link.clientId,
            link.entityType,
            link.entityId,
          ],
        )
      ).rows[0];
      if (inserted) {
        result.stored++;
        await notifyFinance(db, link.company, "Réponse de " + (link.fromName || link.fromAddress), String(parsed.subject || "Nouveau message").slice(0, 160), mailboxReaders);
      }
    }
    await db.query(
      "UPDATE email_inbox_state SET uid_validity=$2,last_uid=$3,last_error=NULL,checked_at=NOW() WHERE account=$1",
      [account.user, fetched.uidValidity, fetched.maxUid || 0],
    );
  }
  return result;
}

module.exports = { processInbox, replyText, accounts, fetchNew };
