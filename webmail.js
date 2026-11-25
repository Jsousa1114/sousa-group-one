"use strict";
// « Boîte mail »: each company's Gmail mailbox inside the application. The Gmail account already
// used to send (address + app password) is read over IMAP when the mailbox is shown. Nothing is
// copied into the database: folders, messages, read marks and stars are Gmail's own, so the
// application, Gmail on the web and the phone always show the same thing.
//
// Who may open which mailbox: administrators of the group see every mailbox, an administrator of
// one company sees that company's mailbox, and anyone else only the mailboxes an administrator
// ticked for them (table mailbox_access). Clients never have access.
const { simpleParser } = require("mailparser");
const { parseDocument } = require("htmlparser2");
const renderDom = require("dom-serializer").default;
const D = require("./domain");
const mailer = require("./mailer");

const PAGE_SIZE = 40;
const FULL_PARSE_LIMIT = 8 * 1024 * 1024; // larger messages: text parts only, read part by part
const MAX_DOWNLOAD = 40 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Mailboxes and access
// ---------------------------------------------------------------------------
const companyRef = (c) => ({ id: String(c.id), name: c.name || "", code: c.code || "" });

// One mailbox per Gmail account. A company with its own account gives its id to the mailbox;
// the companies without their own account share the default account (id "default").
function mailboxes(state) {
  const list = [];
  const byAddress = new Map();
  for (const c of state?.companies || []) {
    const company = companyRef(c);
    const imap = mailer.imapSettings(company);
    if (!imap?.host || !imap.user) continue;
    const key = imap.user.toLowerCase();
    let box = byAddress.get(key);
    if (!box) {
      box = { id: imap.source === "company" ? company.id : "default", address: imap.user, own: imap.source === "company", companies: [], names: [], imap };
      byAddress.set(key, box);
      list.push(box);
    }
    box.companies.push(company.id);
    box.names.push(company.name || company.id);
  }
  for (const box of list) box.label = box.own ? box.names.join(" · ") : "Compte principal";
  return list;
}

// Access that does not need to be granted.
function automaticAccess(user, box) {
  if (!user || user.role !== "admin") return false;
  return user.company === "group" || box.companies.includes(String(user.company));
}

async function grantsOf(db, userId) {
  return new Set((await db.query("SELECT mailbox FROM mailbox_access WHERE user_id=$1", [userId])).rows.map((r) => String(r.mailbox)));
}

async function accessible(db, state, user) {
  if (!user || user.role === "client") return [];
  const grants = await grantsOf(db, user.id);
  return mailboxes(state).filter((box) => automaticAccess(user, box) || grants.has(box.id));
}

async function openable(db, state, user, id) {
  const box = (await accessible(db, state, user)).find((b) => b.id === String(id || ""));
  if (!box) D.fail("Boîte mail introuvable ou non autorisée.", 404);
  return box;
}

// Accounts allowed to open a mailbox (for the new-mail notifications).
async function usersWithAccess(db, box) {
  const users = (await db.query("SELECT id,role,company FROM users WHERE disabled=false AND deleted_at IS NULL AND role<>'client'")).rows;
  const granted = new Set((await db.query("SELECT user_id FROM mailbox_access WHERE mailbox=$1", [box.id])).rows.map((r) => Number(r.user_id)));
  return users.filter((u) => automaticAccess(u, box) || granted.has(Number(u.id))).map((u) => Number(u.id));
}

// ---------------------------------------------------------------------------
// IMAP connections: one per Gmail account, kept open and reused.
// ---------------------------------------------------------------------------
let createClient = (imap) => {
  const { ImapFlow } = require("imapflow");
  return new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: imap.secure,
    auth: { user: imap.user, pass: imap.pass },
    logger: false,
    emitLogs: false,
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 5 * 60 * 1000,
  });
};
const pool = new Map();

function drop(box) {
  const key = box.address.toLowerCase();
  const entry = pool.get(key);
  pool.delete(key);
  try {
    entry?.client?.close?.();
  } catch {
    // already closed
  }
}

async function connect(box) {
  const key = box.address.toLowerCase();
  let entry = pool.get(key);
  if (entry?.connecting) {
    await entry.connecting;
    return entry;
  }
  if (entry?.client?.usable) {
    entry.used = Date.now();
    return entry;
  }
  if (entry) drop(box);
  const client = createClient(box.imap);
  entry = { client, used: Date.now(), folders: null, foldersAt: 0, connecting: null };
  // Without a listener, a network error event would stop the whole server.
  client.on("error", (error) => console.warn("webmail.imap.error", error?.code || "unknown"));
  client.on("close", () => {
    if (pool.get(key) === entry) pool.delete(key);
  });
  pool.set(key, entry);
  entry.connecting = client.connect().then(
    () => {
      entry.connecting = null;
    },
    (error) => {
      if (pool.get(key) === entry) pool.delete(key);
      throw error;
    },
  );
  await entry.connecting;
  return entry;
}

// Connections unused for 15 minutes are closed (the new-mail check reopens them).
function closeIdle(maxAge = 15 * 60 * 1000) {
  for (const [key, entry] of pool)
    if (!entry.connecting && Date.now() - entry.used > maxAge) {
      pool.delete(key);
      entry.client.logout?.().catch?.(() => {});
    }
}

function friendly(error, box) {
  if (error?.expose) return error;
  const raw = String(error?.responseText || error?.message || "");
  console.warn("webmail.failed", error?.code || "unknown", error?.serverResponseCode || "");
  if (error?.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|authentication failed/i.test(raw))
    return new D.AppError(`Gmail a refusé la connexion à ${box.address} : vérifiez le mot de passe d’application.`, 502);
  if (/NONEXISTENT|Unknown Mailbox|doesn.t exist|not exist/i.test(raw) || error?.serverResponseCode === "NONEXISTENT")
    return new D.AppError("Ce dossier n’existe plus dans Gmail.", 404);
  if (["ETIMEOUT", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "NoConnection", "EConnectionClosed"].includes(error?.code))
    return new D.AppError("Gmail ne répond pas pour le moment. Réessayez dans un instant.", 503);
  return new D.AppError("La boîte mail est momentanément inaccessible. Réessayez dans un instant.", 502);
}

// Runs fn with the folder selected. A connection closed by Gmail in the meantime is reopened
// once; an authentication failure is reported straight away. An operation that hangs is
// stopped after 90 seconds (the connection is closed, so nothing stays blocked behind it).
const OPERATION_TIMEOUT = 90 * 1000;
async function withFolder(box, path, fn, retry = true) {
  let entry;
  let timer;
  const work = (async () => {
    entry = await connect(box);
    const lock = await entry.client.getMailboxLock(path);
    try {
      return await fn(entry.client, entry);
    } finally {
      lock.release();
    }
  })();
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("operation timeout"), { code: "ETIMEOUT", hung: true })), OPERATION_TIMEOUT);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } catch (error) {
    if (error?.hung) {
      work.catch(() => {});
      drop(box);
      throw friendly(error, box);
    }
    if (error?.expose) throw error;
    if (retry && !error?.authenticationFailed && !entry?.client?.usable) {
      drop(box);
      return withFolder(box, path, fn, false);
    }
    throw friendly(error, box);
  } finally {
    clearTimeout(timer);
  }
}

const isGmail = (client) => !!client?.capabilities?.has?.("X-GM-EXT-1");

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------
const SPECIAL = {
  "\\Inbox": ["inbox", "Boîte de réception", 0],
  "\\Flagged": ["flagged", "Messages suivis", 1],
  "\\Important": ["important", "Importants", 2],
  "\\Sent": ["sent", "Messages envoyés", 3],
  "\\Drafts": ["drafts", "Brouillons", 4],
  "\\Archive": ["archive", "Archives", 5],
  "\\All": ["all", "Tous les messages", 6],
  "\\Junk": ["junk", "Spam", 7],
  "\\Trash": ["trash", "Corbeille", 8],
};

async function folderList(box, fresh = false) {
  try {
    const entry = await connect(box);
    if (!fresh && entry.folders && Date.now() - entry.foldersAt < 5 * 60 * 1000) return entry.folders;
    const listed = await entry.client.list();
    const folders = [];
    const seen = new Set();
    for (const f of listed) {
      if (f.flags?.has?.("\\Noselect") || f.flags?.has?.("\\NonExistent")) continue;
      const special = String(f.path).toUpperCase() === "INBOX" ? SPECIAL["\\Inbox"] : SPECIAL[f.specialUse];
      if (special && !seen.has(special[0])) {
        seen.add(special[0]);
        folders.push({ id: special[0], path: f.path, name: special[1], order: special[2], special: true });
      } else if (!special) {
        const name = f.delimiter ? String(f.path).split(f.delimiter).join(" / ") : String(f.path);
        folders.push({ id: "label:" + f.path, path: f.path, name, order: 100, special: false });
      }
    }
    folders.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, "fr"));
    entry.folders = folders;
    entry.foldersAt = Date.now();
    return folders;
  } catch (error) {
    if (!error?.expose) drop(box);
    throw friendly(error, box);
  }
}

async function folderOf(box, id) {
  const wanted = String(id || "inbox");
  const found = (await folderList(box)).find((f) => f.id === wanted) || (await folderList(box, true)).find((f) => f.id === wanted);
  if (!found) D.fail("Dossier introuvable.", 404);
  return found;
}

// Unread counts of the inbox and spam, number of drafts.
async function folderCounts(box) {
  const folders = await folderList(box);
  const out = {};
  try {
    const entry = await connect(box);
    // The open folder only shows what arrived (or was read elsewhere) after a NOOP.
    await entry.client.noop?.().catch?.(() => {});
    for (const f of folders.filter((x) => ["inbox", "drafts", "junk"].includes(x.id))) {
      const s = await entry.client.status(f.path, { messages: true, unseen: true }).catch(() => null);
      if (s) out[f.id] = { total: Number(s.messages) || 0, unseen: Number(s.unseen) || 0 };
    }
  } catch (error) {
    throw friendly(error, box);
  }
  if (out.inbox) setUnread(box, out.inbox.unseen);
  return out;
}

// ---------------------------------------------------------------------------
// Message lists
// ---------------------------------------------------------------------------
const addresses = (list) =>
  (Array.isArray(list) ? list : [])
    .map((a) => ({ name: String(a?.name || "").slice(0, 160), address: String(a?.address || "").trim().toLowerCase().slice(0, 254) }))
    .filter((a) => a.address || a.name)
    .slice(0, 50);
const isoDate = (value) => {
  const d = value instanceof Date ? value : new Date(value || 0);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const decodedSize = (node) => Math.round((Number(node?.size) || 0) * (String(node?.encoding || "").toLowerCase() === "base64" ? 0.75 : 1));

// Body parts of a message from its structure: the text and HTML bodies and the attachments.
function partsOf(structure) {
  const attachments = [];
  let text = null;
  let html = null;
  const walk = (node, inRelated) => {
    if (!node) return;
    const type = String(node.type || "").toLowerCase();
    if (node.childNodes?.length) {
      for (const child of node.childNodes) walk(child, inRelated || type === "multipart/related");
      return;
    }
    const filename = String(node.dispositionParameters?.filename || node.parameters?.name || "").trim();
    const disposition = String(node.disposition || "").toLowerCase();
    if (!filename && disposition !== "attachment" && (type === "text/plain" || type === "text/html")) {
      if (type === "text/plain" && !text) text = node;
      if (type === "text/html" && !html) html = node;
      return;
    }
    const cid = String(node.id || "").replace(/[<>]/g, "").trim();
    const extension = { "message/rfc822": ".eml", "text/calendar": ".ics", "application/pdf": ".pdf" }[type] || "";
    attachments.push({
      part: String(node.part || "1"),
      filename: (filename || "piece-jointe" + extension).slice(0, 200),
      contentType: type || "application/octet-stream",
      size: decodedSize(node),
      cid,
      inline: disposition === "inline" || (!disposition && !!cid && inRelated),
    });
  };
  walk(structure, false);
  return { text, html, attachments };
}

function summarize(m) {
  const flags = m.flags || new Set();
  const parts = partsOf(m.bodyStructure);
  return {
    uid: Number(m.uid),
    threadId: m.threadId ? String(m.threadId) : null,
    seen: flags.has("\\Seen"),
    flagged: flags.has("\\Flagged"),
    answered: flags.has("\\Answered"),
    draft: flags.has("\\Draft"),
    important: !!m.labels?.has?.("\\Important"),
    date: isoDate(m.envelope?.date || m.internalDate),
    subject: String(m.envelope?.subject || "").slice(0, 300),
    from: addresses(m.envelope?.from)[0] || null,
    to: addresses(m.envelope?.to).slice(0, 10),
    cc: addresses(m.envelope?.cc).slice(0, 10),
    attachments: parts.attachments.filter((a) => !a.inline).length,
    size: Number(m.size) || 0,
  };
}

const LIST_QUERY = (gmail) => ({ uid: true, flags: true, envelope: true, internalDate: true, size: true, bodyStructure: true, threadId: true, labels: gmail });

// Newest first, PAGE_SIZE at a time. With a search: Gmail's own search syntax
// ("from:dupont has:attachment"), or a plain text search on other servers.
async function listMessages(box, folderId, { page = 0, query = "" } = {}) {
  const folder = await folderOf(box, folderId);
  page = Math.max(0, Math.min(500, Number.parseInt(page, 10) || 0));
  const q = String(query || "").replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  return withFolder(box, folder.path, async (client) => {
    const gmail = isGmail(client);
    const exists = Number(client.mailbox?.exists) || 0;
    let range;
    let byUid = false;
    let total = exists;
    if (q) {
      const found = (await client.search(gmail ? { gmraw: q } : { text: q }, { uid: true })) || [];
      found.sort((a, b) => b - a);
      total = found.length;
      range = found.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      byUid = true;
      if (!range.length) return { folder: folder.id, messages: [], total, page, more: false };
    } else {
      const end = exists - page * PAGE_SIZE;
      if (end < 1) return { folder: folder.id, messages: [], total, page, more: false };
      range = `${Math.max(1, end - PAGE_SIZE + 1)}:${end}`;
    }
    const messages = [];
    for await (const m of client.fetch(range, LIST_QUERY(gmail), { uid: byUid })) messages.push(summarize(m));
    messages.sort((a, b) => b.uid - a.uid);
    if (folder.id === "inbox" && !q && page === 0) setUnread(box, null);
    return { folder: folder.id, messages, total, page, more: (page + 1) * PAGE_SIZE < total };
  });
}

// ---------------------------------------------------------------------------
// HTML of a message: cleaned, then shown in an isolated frame that runs no script.
// ---------------------------------------------------------------------------
const REMOVE = new Set(["script", "iframe", "frame", "frameset", "object", "embed", "applet", "meta", "link", "base", "template", "portal", "audio", "video", "source", "track", "title", "noscript", "input", "select", "textarea", "button", "option", "dialog"]);
const UNWRAP = new Set(["html", "head"]);
const URL_ATTRS = new Set(["href", "src", "background", "xlink:href", "poster", "cite", "longdesc", "usemap", "lowsrc", "dynsrc"]);
const DROP_ATTRS = new Set(["srcdoc", "formaction", "action", "ping", "http-equiv", "srcset", "autofocus", "contenteditable", "draggable"]);
const SAFE_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|bmp);/i;

const compact = (value) => String(value || "").replace(/[\u0000-\u0020\u007f-\u00a0\u200b-\u200f\u2028\u2029\ufeff]+/g, "");

// Wraps quoted earlier messages in a closed <details> block ("•••"), like Gmail.
function isQuote(el) {
  const cls = ` ${String(el.attribs?.class || "").toLowerCase()} `;
  if (el.name === "blockquote" && String(el.attribs?.type || "").toLowerCase() === "cite") return true;
  if (/ gmail_quote( |_container )|( yahoo_quoted )|( moz-cite-prefix )/.test(cls) && el.name !== "span") return true;
  return el.name === "div" && ["divRplyFwdMsg", "appendonsend"].includes(String(el.attribs?.id || ""));
}

function sanitizeHtml(html, cids = new Map()) {
  const doc = parseDocument(String(html || ""), { decodeEntities: true });
  let remote = 0;
  let quoted = false;
  const visit = (node, insideQuote) => {
    for (const child of [...(node.children || [])]) {
      if (child.type === "comment" || child.type === "directive" || child.type === "cdata") {
        remove(child);
        continue;
      }
      if (child.type === "script" || child.name === "script") {
        remove(child);
        continue;
      }
      if (child.type === "style") {
        cleanAttributes(child);
        continue;
      }
      if (child.type !== "tag") continue;
      const name = String(child.name || "").toLowerCase();
      if (REMOVE.has(name)) {
        remove(child);
        continue;
      }
      if (UNWRAP.has(name)) {
        visit(child, insideQuote);
        unwrap(child);
        continue;
      }
      if (name === "body" || name === "form") child.name = "div";
      cleanAttributes(child);
      visit(child, insideQuote || isQuote(child));
      if (!insideQuote && isQuote(child)) {
        quoted = true;
        wrapDetails(child);
      }
    }
  };
  const cleanAttributes = (el) => {
    for (const key of Object.keys(el.attribs || {})) {
      const name = key.toLowerCase();
      const value = String(el.attribs[key] || "");
      if (name.startsWith("on") || DROP_ATTRS.has(name)) {
        delete el.attribs[key];
        continue;
      }
      if (name === "style") {
        if (/expression\s*\(|javascript:|behavior\s*:|-moz-binding/i.test(value)) delete el.attribs[key];
        else if (/url\s*\(\s*['"]?\s*https?:/i.test(value)) remote++;
        continue;
      }
      if (!URL_ATTRS.has(name)) continue;
      const v = compact(value).toLowerCase();
      if (name === "href") {
        if (!/^(https?:|mailto:|tel:|#)/.test(v)) delete el.attribs[key];
        continue;
      }
      if (v.startsWith("cid:")) {
        const image = cids.get(value.trim().slice(4).replace(/[<>]/g, ""));
        if (image) el.attribs[key] = image;
        else delete el.attribs[key];
      } else if (SAFE_DATA_IMAGE.test(v)) {
        // embedded image: kept
      } else if (/^https?:/.test(v)) {
        remote++;
        el.attribs["data-remote-" + name] = value.trim();
        delete el.attribs[key];
      } else delete el.attribs[key];
    }
    if (el.name === "a" && el.attribs.href) {
      el.attribs.target = "_blank";
      el.attribs.rel = "noopener noreferrer";
    }
  };
  const remove = (node) => {
    const siblings = node.parent?.children || doc.children;
    const index = siblings.indexOf(node);
    if (index >= 0) siblings.splice(index, 1);
  };
  const unwrap = (node) => {
    const siblings = node.parent?.children || doc.children;
    const index = siblings.indexOf(node);
    if (index < 0) return;
    for (const child of node.children || []) child.parent = node.parent;
    siblings.splice(index, 1, ...(node.children || []));
  };
  const wrapDetails = (node) => {
    const siblings = node.parent?.children || doc.children;
    const index = siblings.indexOf(node);
    if (index < 0) return;
    const summary = { type: "tag", name: "summary", attribs: { title: "Afficher le message précédent" }, children: [] };
    summary.children = [{ type: "text", data: "•••", parent: summary }];
    const details = { type: "tag", name: "details", attribs: { class: "q" }, children: [summary, node], parent: node.parent };
    summary.parent = details;
    node.parent = details;
    siblings.splice(index, 1, details);
  };
  visit(doc, false);
  return { html: renderDom(doc, { decodeEntities: true, encodeEntities: "utf8" }), remote, quoted };
}

// Remote images are only loaded once the reader asks for them (they tell the sender that the
// message was opened, and from where).
const withImages = (html) => String(html).replace(/data-remote-(src|background|poster)=/g, "$1=");

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const linkify = (escaped) =>
  escaped.replace(/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);

const QUOTE_HEADER = /^\s*(Le .{4,200}a écrit\s*:|On .{4,200}wrote\s*:|Am .{4,200}schrieb.*:|-{2,}\s*(Original Message|Message d’origine|Message d'origine|Message transféré|Forwarded message)\s*-{2,})/i;
function textToHtml(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  let cut = lines.findIndex((line) => QUOTE_HEADER.test(line));
  if (cut < 0) {
    const first = lines.findIndex((line, i) => line.startsWith(">") && lines.slice(i).every((l) => l.startsWith(">") || !l.trim()));
    cut = first > 0 ? first : -1;
  }
  const block = (part) => `<pre class="t">${linkify(escapeHtml(part.join("\n")))}</pre>`;
  if (cut <= 0) return { html: block(lines), quoted: false };
  return { html: block(lines.slice(0, cut)) + `<details class="q"><summary title="Afficher le message précédent">•••</summary>${block(lines.slice(cut))}</details>`, quoted: true };
}

const FRAME_STYLE =
  "html,body{margin:0;padding:0;background:#fff;color:#1f2328;font:14px/1.55 -apple-system,'Segoe UI',Roboto,Arial,sans-serif;overflow-wrap:anywhere}" +
  "body{padding:2px 4px 6px}img{max-width:100%;height:auto}table{max-width:100%}pre.t{white-space:pre-wrap;font:inherit;margin:0}a{color:#0b57d0}" +
  "details.q>summary{list-style:none;display:inline-block;cursor:pointer;padding:0 8px;margin:8px 0;border-radius:8px;background:#e8eaed;color:#3c4043;font-size:12px;line-height:18px;letter-spacing:1px}" +
  "details.q>summary::-webkit-details-marker{display:none}";

function frameDocument(body) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="color-scheme" content="light"><style>${FRAME_STYLE}</style></head><body>${body}</body></html>`;
}

function frameHeaders(images) {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; img-src data:${images ? " https:" : ""}; font-src data:${images ? " https:" : ""}; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox`,
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
  };
}

// ---------------------------------------------------------------------------
// Reading messages
// ---------------------------------------------------------------------------
// Parsed messages, most recent last: at most 80 of them and about 64 MB in all.
const cache = new Map();
const CACHE_BYTES = 64 * 1024 * 1024;
let cacheBytes = 0;
const weight = (view) => (view.body?.length || 0) + (view.text?.length || 0) + 2048;
function cacheSet(key, value) {
  const old = cache.get(key);
  if (old) {
    cache.delete(key);
    cacheBytes -= weight(old);
  }
  cache.set(key, value);
  cacheBytes += weight(value);
  while (cache.size > 1 && (cache.size > 80 || cacheBytes > CACHE_BYTES)) {
    const [oldest, view] = cache.entries().next().value;
    cache.delete(oldest);
    cacheBytes -= weight(view);
  }
}

async function streamToBuffer(stream, max = MAX_DOWNLOAD) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > max) throw new D.AppError("Fichier trop volumineux pour être ouvert ici : ouvrez-le dans Gmail.", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Reads one message (the client must have the folder selected).
async function readMessage(client, box, folder, uid, fetched = null) {
  const key = `${box.address}|${folder.path}|${client.mailbox?.uidValidity}|${uid}`;
  const m = fetched || (await client.fetchOne(String(uid), { uid: true, flags: true, size: true, bodyStructure: true, envelope: true, internalDate: true }, { uid: true }));
  if (!m) D.fail("Message introuvable : il a peut-être été déplacé ou supprimé.", 404);
  const cached = cache.get(key);
  const flags = m.flags || new Set();
  const live = { seen: flags.has("\\Seen"), flagged: flags.has("\\Flagged"), draft: flags.has("\\Draft"), answered: flags.has("\\Answered") };
  if (cached) {
    cacheSet(key, cached);
    return { ...cached, ...live };
  }
  const parts = partsOf(m.bodyStructure);
  let parsed;
  if ((Number(m.size) || 0) <= FULL_PARSE_LIMIT) {
    const source = await client.download(String(uid), undefined, { uid: true, maxBytes: FULL_PARSE_LIMIT + 1024 });
    if (!source?.content) D.fail("Message introuvable : il a peut-être été déplacé ou supprimé.", 404);
    parsed = await simpleParser(await streamToBuffer(source.content), { skipTextToHtml: true, skipImageLinks: true, skipTextLinks: true });
  } else {
    // Large message (attachments): only its text parts are read.
    const read = async (node) => {
      if (!node) return "";
      const got = await client.download(String(uid), String(node.part || "1"), { uid: true, maxBytes: 4 * 1024 * 1024 });
      return got?.content ? (await streamToBuffer(got.content, 4 * 1024 * 1024)).toString("utf8") : "";
    };
    parsed = {
      html: await read(parts.html),
      text: await read(parts.text),
      attachments: [],
      from: { value: m.envelope?.from || [] },
      to: { value: m.envelope?.to || [] },
      cc: { value: m.envelope?.cc || [] },
      subject: m.envelope?.subject || "",
      date: m.envelope?.date || m.internalDate,
      messageId: m.envelope?.messageId || "",
      inReplyTo: m.envelope?.inReplyTo || "",
    };
  }
  const cids = new Map();
  let inlineBytes = 0;
  for (const a of parsed.attachments || [])
    if (a.contentId && /^image\/(png|jpe?g|gif|webp|bmp)$/i.test(a.contentType || "") && a.size <= 1024 * 1024 && inlineBytes + a.size <= 4 * 1024 * 1024) {
      inlineBytes += a.size;
      cids.set(String(a.contentId).replace(/[<>]/g, ""), `data:${a.contentType.toLowerCase()};base64,${a.content.toString("base64")}`);
    }
  let body;
  let remote = 0;
  if (parsed.html && String(parsed.html).length <= 3 * 1024 * 1024) {
    const clean = sanitizeHtml(parsed.html, cids);
    body = clean.html;
    remote = clean.remote;
  } else body = textToHtml(parsed.text || "").html;
  const referenced = new Set([...String(parsed.html || "").matchAll(/cid:([^"'\s)>]+)/gi)].map((x) => x[1].replace(/[<>]/g, "")));
  const text = String(parsed.text || "").replace(/\r/g, "");
  const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? String(parsed.references).split(/\s+/) : [];
  const view = {
    uid: Number(uid),
    messageId: String(parsed.messageId || "").slice(0, 500),
    inReplyTo: String(parsed.inReplyTo || "").slice(0, 500),
    references: references.filter(Boolean).slice(-20).map((r) => String(r).slice(0, 500)),
    subject: String(parsed.subject || "").slice(0, 300),
    date: isoDate(parsed.date || m.internalDate),
    from: addresses(parsed.from?.value)[0] || null,
    replyTo: addresses(parsed.replyTo?.value),
    to: addresses(parsed.to?.value),
    cc: addresses(parsed.cc?.value),
    bcc: addresses(parsed.bcc?.value),
    text: text.slice(0, 200000),
    snippet: text.replace(/\s+/g, " ").trim().slice(0, 200),
    remoteImages: remote > 0,
    attachments: parts.attachments.filter((a) => !(a.cid && referenced.has(a.cid))).map(({ part, filename, contentType, size }) => ({ part, filename, contentType, size })),
    body,
  };
  cacheSet(key, view);
  return { ...view, ...live };
}

const publicView = ({ body, ...rest }) => rest;

// A conversation: with Gmail, every message of the thread (from "All messages", except in Spam
// and Trash, which Gmail keeps apart); elsewhere, the message alone. Opening marks it as read.
async function conversation(box, folderId, uid) {
  uid = Number.parseInt(uid, 10);
  if (!(uid > 0)) D.fail("Message introuvable.", 404);
  const folder = await folderOf(box, folderId);
  const folders = await folderList(box);
  const all = folders.find((f) => f.id === "all");
  const first = await withFolder(box, folder.path, async (client) => {
    const m = await client.fetchOne(String(uid), { uid: true, threadId: true }, { uid: true });
    if (!m) D.fail("Message introuvable : il a peut-être été déplacé ou supprimé.", 404);
    return { threadId: m.threadId ? String(m.threadId) : null, gmail: isGmail(client) };
  });
  const where = first.gmail && first.threadId && all && !["trash", "junk"].includes(folder.id) ? all : folder;
  const result = await withFolder(box, where.path, async (client) => {
    let uids = [uid];
    if (first.gmail && first.threadId) {
      const found = (await client.search({ threadId: first.threadId }, { uid: true })) || [];
      if (found.length) uids = found.sort((a, b) => a - b).slice(-30);
    }
    const fetched = [];
    for await (const m of client.fetch(uids, { uid: true, flags: true, size: true, bodyStructure: true, envelope: true, internalDate: true }, { uid: true })) fetched.push(m);
    if (!fetched.length) D.fail("Message introuvable : il a peut-être été déplacé ou supprimé.", 404);
    const messages = [];
    for (const m of fetched) messages.push({ ...publicView(await readMessage(client, box, where, m.uid, m)), folder: where.id });
    messages.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.uid - b.uid);
    const unseen = messages.filter((x) => !x.seen).map((x) => x.uid);
    if (unseen.length) {
      await client.messageFlagsAdd(unseen, ["\\Seen"], { uid: true }).catch(() => {});
      setUnread(box, null);
    }
    return { threadId: first.threadId, folder: where.id, opened: { folder: folder.id, uid }, subject: messages.at(-1)?.subject || "", messages };
  });
  return result;
}

async function messageView(box, folderId, uid) {
  const folder = await folderOf(box, folderId);
  uid = Number.parseInt(uid, 10);
  if (!(uid > 0)) D.fail("Message introuvable.", 404);
  return withFolder(box, folder.path, (client) => readMessage(client, box, folder, uid));
}

async function frame(box, folderId, uid, images) {
  const view = await messageView(box, folderId, uid);
  return frameDocument(images ? withImages(view.body) : view.body);
}

const VIEWABLE = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"]);
async function attachment(box, folderId, uid, part) {
  if (!/^\d{1,3}(\.\d{1,3}){0,8}$/.test(String(part || ""))) D.fail("Pièce jointe introuvable.", 404);
  const view = await messageView(box, folderId, uid);
  const info = view.attachments.find((a) => a.part === String(part));
  if (!info) D.fail("Pièce jointe introuvable.", 404);
  const folder = await folderOf(box, folderId);
  const content = await withFolder(box, folder.path, async (client) => {
    const got = await client.download(String(view.uid), info.part, { uid: true, maxBytes: MAX_DOWNLOAD + 1 });
    if (!got?.content) D.fail("Pièce jointe introuvable.", 404);
    return streamToBuffer(got.content);
  });
  return { ...info, viewable: VIEWABLE.has(info.contentType), content };
}

// Several attachments as Buffers (to forward them), at most `max` bytes in all.
async function attachmentsFor(box, folderId, uid, parts, max) {
  const out = [];
  let total = 0;
  for (const part of parts) {
    const file = await attachment(box, folderId, uid, part);
    total += file.content.length;
    if (total > max) D.fail("Pièces jointes : 18 Mo au maximum au total (limite de Gmail).", 413);
    out.push({ filename: file.filename, content: file.content, contentType: file.contentType });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Actions on messages
// ---------------------------------------------------------------------------
const ACTIONS = new Set(["read", "unread", "star", "unstar", "archive", "trash", "spam", "inbox", "delete", "move"]);

async function act(box, folderId, { uids = [], threads = [], action, target = "" }) {
  if (!ACTIONS.has(action)) D.fail("Action inconnue.");
  const folder = await folderOf(box, folderId);
  const folders = await folderList(box);
  const find = (id) => folders.find((f) => f.id === id);
  const destination = action === "move" ? find(String(target)) : null;
  if (action === "move" && (!destination || destination.special)) D.fail("Libellé introuvable.", 404);
  if (action === "delete" && !["trash", "junk"].includes(folder.id)) D.fail("La suppression définitive se fait depuis la corbeille ou le spam.");
  const done = await withFolder(box, folder.path, async (client) => {
    const gmail = isGmail(client);
    let range = (Array.isArray(uids) ? uids : []).map((u) => Number.parseInt(u, 10)).filter((u) => u > 0);
    if (gmail)
      for (const t of (Array.isArray(threads) ? threads : []).slice(0, 100))
        if (/^\d{1,25}$/.test(String(t))) range.push(...((await client.search({ threadId: String(t) }, { uid: true })) || []));
    range = [...new Set(range)].slice(0, 2000);
    if (!range.length) return 0;
    const opt = { uid: true };
    const labels = { uid: true, useLabels: true };
    const moveTo = async (special, message) => {
      const to = find(special);
      if (!to) D.fail(message);
      if (to.path !== folder.path) await client.messageMove(range, to.path, opt);
    };
    if (action === "read") await client.messageFlagsAdd(range, ["\\Seen"], opt);
    else if (action === "unread") await client.messageFlagsRemove(range, ["\\Seen"], opt);
    else if (action === "star") await client.messageFlagsAdd(range, ["\\Flagged"], opt);
    else if (action === "unstar") await client.messageFlagsRemove(range, ["\\Flagged"], opt);
    else if (action === "trash") await moveTo("trash", "Corbeille introuvable.");
    else if (action === "spam") await moveTo("junk", "Dossier spam introuvable.");
    else if (action === "delete") await client.messageDelete(range, opt);
    else if (action === "archive") {
      // Gmail: archiving removes the "Inbox" label; the message stays in "All messages".
      if (gmail) await client.messageFlagsRemove(range, ["\\Inbox"], labels);
      else await moveTo("archive", "L’archivage n’est pas disponible pour cette boîte.");
    } else if (action === "inbox") {
      // Back to the inbox: from the trash or the spam the message is moved; elsewhere Gmail
      // only adds the "Inbox" label (moving out of "All messages" would delete it).
      if (gmail && !["trash", "junk"].includes(folder.id)) await client.messageFlagsAdd(range, ["\\Inbox"], labels);
      else await moveTo("inbox", "Boîte de réception introuvable.");
    } else if (action === "move") {
      if (gmail) {
        await client.messageFlagsAdd(range, [destination.path], labels);
        if (folder.id === "inbox") await client.messageFlagsRemove(range, ["\\Inbox"], labels);
        else if (!folder.special) await client.messageFlagsRemove(range, [folder.path], labels);
      } else await client.messageMove(range, destination.path, opt);
    }
    return range.length;
  });
  setUnread(box, null);
  return { done };
}

// Marks the message a reply was written to as answered (best effort).
async function markAnswered(box, folderId, uid) {
  try {
    const folder = await folderOf(box, folderId);
    await withFolder(box, folder.path, (client) => client.messageFlagsAdd([Number(uid)], ["\\Answered"], { uid: true }));
  } catch {
    // not important
  }
}

// ---------------------------------------------------------------------------
// Unread counters and new-mail check
// ---------------------------------------------------------------------------
const unread = new Map(); // address -> { unseen, at } ; unseen null = to be read again
function setUnread(box, unseen) {
  unread.set(box.address.toLowerCase(), { unseen, at: Date.now() });
}
const unreadOf = (box) => {
  const u = unread.get(box.address.toLowerCase());
  return u && Number.isFinite(u.unseen) ? u.unseen : null;
};

// For every mailbox: refreshes the unread counter and reports the messages that arrived since
// the previous check. The first check only records where the inbox stands.
async function checkNewMail(db, state, { notify = async () => {} } = {}) {
  const result = { checked: 0, fresh: 0 };
  for (const box of mailboxes(state)) {
    const account = box.address.toLowerCase();
    try {
      const row = (await db.query("SELECT * FROM webmail_state WHERE account=$1", [account])).rows[0];
      const seen = await withFolder(box, "INBOX", async (client) => {
        // NOOP first: the folder may already be open on this connection, and the server only
        // reports what arrived since then when asked.
        await client.noop?.().catch?.(() => {});
        const validity = String(client.mailbox?.uidValidity ?? "");
        const exists = Number(client.mailbox?.exists) || 0;
        const newest = exists ? await client.fetchOne("*", { uid: true }) : null;
        const last = Number(newest?.uid) || 0;
        const status = await client.status("INBOX", { unseen: true }).catch(() => null);
        const since = Number(row?.last_uid) || 0;
        const fresh = [];
        if (row && row.uid_validity === validity && last > since)
          for await (const m of client.fetch(`${since + 1}:*`, LIST_QUERY(isGmail(client)), { uid: true })) if (Number(m.uid) > since) fresh.push(m);
        return { validity, last, unseen: status ? Number(status.unseen) || 0 : null, fresh };
      });
      result.checked++;
      if (seen.unseen !== null) setUnread(box, seen.unseen);
      const highest = Math.max(seen.last, ...seen.fresh.map((m) => Number(m.uid)));
      await db.query(
        `INSERT INTO webmail_state(account,uid_validity,last_uid,checked_at,last_error) VALUES($1,$2,$3,NOW(),NULL)
         ON CONFLICT(account) DO UPDATE SET uid_validity=EXCLUDED.uid_validity,last_uid=EXCLUDED.last_uid,checked_at=NOW(),last_error=NULL`,
        [account, seen.validity, highest],
      );
      // First check, or a mailbox Gmail renumbered: only where the inbox stands is recorded.
      const incoming = seen.fresh.map(summarize).filter((m) => !m.seen && m.from?.address && m.from.address !== account);
      result.fresh += incoming.length;
      if (incoming.length) await notify(box, incoming);
    } catch (error) {
      const message = friendly(error, box).message;
      await db
        .query(
          `INSERT INTO webmail_state(account,last_error,checked_at) VALUES($1,$2,NOW())
           ON CONFLICT(account) DO UPDATE SET last_error=EXCLUDED.last_error,checked_at=NOW()`,
          [account, message],
        )
        .catch(() => {});
    }
  }
  closeIdle();
  return result;
}

// ---------------------------------------------------------------------------
// Drafts (kept in Gmail's « Brouillons ») and reminders
// ---------------------------------------------------------------------------
async function draftsFolder(box) {
  const folder = (await folderList(box)).find((f) => f.id === "drafts");
  if (!folder) D.fail("Le dossier « Brouillons » est introuvable dans cette boîte.", 404);
  return folder;
}

// Saves a draft (a complete message) and removes the version it replaces.
async function saveDraft(box, raw, replaces = 0) {
  const folder = await draftsFolder(box);
  const uid = await withFolder(box, folder.path, async (client) => {
    const out = await client.append(folder.path, raw, ["\\Draft", "\\Seen"]);
    const old = Number.parseInt(replaces, 10);
    if (old > 0 && old !== Number(out?.uid)) await client.messageDelete([old], { uid: true }).catch(() => {});
    return Number(out?.uid) || 0;
  });
  return { uid, folder: folder.id };
}

async function removeDraft(box, uid) {
  const id = Number.parseInt(uid, 10);
  if (!(id > 0)) return;
  const folder = await draftsFolder(box);
  await withFolder(box, folder.path, (client) => client.messageDelete([id], { uid: true }));
}

// A draft as the compose window needs it: recipients, subject, HTML, attachments and what it
// answers (stored by the application in its own header).
async function readDraft(box, uid) {
  const id = Number.parseInt(uid, 10);
  if (!(id > 0)) D.fail("Brouillon introuvable.", 404);
  const folder = await draftsFolder(box);
  return withFolder(box, folder.path, async (client) => {
    const m = await client.fetchOne(String(id), { uid: true, bodyStructure: true, size: true }, { uid: true });
    if (!m) D.fail("Brouillon introuvable : il a peut-être été envoyé ou supprimé.", 404);
    const got = await client.download(String(id), undefined, { uid: true, maxBytes: 40 * 1024 * 1024 });
    if (!got?.content) D.fail("Brouillon introuvable.", 404);
    const parsed = await simpleParser(await streamToBuffer(got.content), { skipImageLinks: true, skipTextLinks: true });
    let meta = {};
    try {
      meta = JSON.parse(Buffer.from(String(parsed.headers.get("x-sgo-compose") || ""), "base64").toString("utf8") || "{}");
    } catch {
      meta = {};
    }
    const list = (field) => addresses(parsed[field]?.value).map((a) => a.address).filter(Boolean);
    return {
      uid: id,
      folder: folder.id,
      to: list("to"),
      cc: list("cc"),
      bcc: list("bcc"),
      subject: String(parsed.subject || ""),
      html: parsed.html ? String(parsed.html) : "",
      text: String(parsed.text || ""),
      meta: meta && typeof meta === "object" ? meta : {},
      attachments: partsOf(m.bodyStructure).attachments.filter((a) => !a.inline).map(({ part, filename, contentType, size }) => ({ part, filename, contentType, size })),
    };
  });
}

// Puts a conversation back in the inbox, unread (end of a reminder).
async function resurface(box, { threadId = "", messageId = "" }) {
  const folders = await folderList(box);
  const all = folders.find((f) => f.id === "all");
  const inbox = folders.find((f) => f.id === "inbox");
  if (all && threadId) {
    const done = await withFolder(box, all.path, async (client) => {
      if (!isGmail(client)) return false;
      const uids = (await client.search({ threadId: String(threadId) }, { uid: true })) || [];
      if (!uids.length) return true;
      await client.messageFlagsAdd(uids, ["\\Inbox"], { uid: true, useLabels: true });
      await client.messageFlagsRemove([Math.max(...uids)], ["\\Seen"], { uid: true });
      return true;
    });
    if (done) return setUnread(box, null);
  }
  // Other servers: the archived message is moved back.
  const archive = folders.find((f) => f.id === "archive");
  if (!archive || !inbox || !messageId) return;
  await withFolder(box, archive.path, async (client) => {
    const uids = (await client.search({ header: { "message-id": messageId } }, { uid: true })) || [];
    if (!uids.length) return;
    await client.messageFlagsRemove(uids, ["\\Seen"], { uid: true });
    await client.messageMove(uids, inbox.path, { uid: true });
  });
  setUnread(box, null);
}

module.exports = {
  PAGE_SIZE,
  mailboxes,
  withFolder,
  folderOf,
  isGmail,
  saveDraft,
  removeDraft,
  readDraft,
  resurface,
  accessible,
  openable,
  automaticAccess,
  usersWithAccess,
  folderList,
  folderCounts,
  listMessages,
  conversation,
  messageView,
  frame,
  frameHeaders,
  attachment,
  attachmentsFor,
  act,
  markAnswered,
  checkNewMail,
  unreadOf,
  setUnread,
  sanitizeHtml,
  textToHtml,
  partsOf,
  escapeHtml,
  linkify,
  _setClientFactory(factory) {
    createClient = factory;
  },
  _reset() {
    for (const entry of pool.values()) {
      try {
        entry.client?.close?.();
      } catch {
        // ignore
      }
    }
    pool.clear();
    cache.clear();
    cacheBytes = 0;
    unread.clear();
  },
};
