"use strict";
// Writing in the « Boîte mail »: the formatted text (cleaned), the signature with the company's
// logo, the attachments (files, the original's, the application's invoices, quotes and
// documents), drafts kept in Gmail's « Brouillons », and the outbox: a message waits 10 seconds
// (« Annuler ») or until the time chosen, then leaves through the company's Gmail account.
// Everything is checked when the message is written, so sending later cannot fail on a
// mistake the person could have corrected.
const { randomUUID } = require("node:crypto");
const MailComposer = require("nodemailer/lib/mail-composer");
const { parseDocument } = require("htmlparser2");
const renderDom = require("dom-serializer").default;
const { convert } = require("html-to-text");
const D = require("./domain");
const mailer = require("./mailer");
const MS = require("./mail-settings");
const W = require("./webmail");
const { loadState } = require("./db");

const MAX_ATTACHMENTS = 18 * 1024 * 1024; // Gmail refuses messages over 25 MB once encoded
const undoSeconds = () => {
  const n = Number(process.env.WEBMAIL_UNDO_SECONDS);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 30) : 10;
};
const esc = W.escapeHtml;
const who = (a) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : "");
const companyRef = (state, id) => {
  const c = (state?.companies || []).find((x) => D.same(x.id, id));
  return c ? { id: String(c.id), name: c.name || "", code: c.code || "" } : { id: String(id || "") };
};
const swissDateTime = (iso) => {
  const d = new Date(iso || 0);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("fr-CH", { timeZone: "Europe/Zurich", weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

// ---------------------------------------------------------------------------
// Formatted text: only simple formatting is kept (bold, italic, underline, lists, links).
// ---------------------------------------------------------------------------
const KEEP = new Set(["p", "div", "br", "b", "strong", "i", "em", "u", "s", "strike", "ul", "ol", "li", "a", "span", "blockquote", "h1", "h2", "h3", "hr"]);
const DROP = new Set(["script", "style", "iframe", "frame", "object", "embed", "img", "picture", "video", "audio", "svg", "math", "form", "input", "button", "select", "textarea", "meta", "link", "base", "title", "head", "template", "noscript", "canvas"]);

function cleanComposeHtml(html) {
  const doc = parseDocument(String(html || "").slice(0, 300000), { decodeEntities: true });
  const siblingsOf = (node) => node.parent?.children || doc.children;
  const remove = (node) => {
    const list = siblingsOf(node);
    const i = list.indexOf(node);
    if (i >= 0) list.splice(i, 1);
  };
  const unwrap = (node) => {
    const list = siblingsOf(node);
    const i = list.indexOf(node);
    if (i < 0) return;
    for (const child of node.children || []) child.parent = node.parent;
    list.splice(i, 1, ...(node.children || []));
  };
  const walk = (node) => {
    for (const child of [...(node.children || [])]) {
      if (child.type === "text") continue;
      const name = String(child.name || "").toLowerCase();
      if (child.type !== "tag" || DROP.has(name)) {
        remove(child);
        continue;
      }
      walk(child);
      if (!KEEP.has(name)) {
        unwrap(child);
        continue;
      }
      const href = String(child.attribs?.href || "").trim();
      child.attribs = {};
      if (name === "a") {
        if (/^(https?:|mailto:|tel:)/i.test(href.replace(/[\u0000-\u0020]+/g, ""))) {
          child.attribs.href = href;
          child.attribs.target = "_blank";
        } else unwrap(child);
      }
    }
  };
  walk(doc);
  return renderDom(doc, { encodeEntities: "utf8" }).trim();
}

const htmlToText = (html) =>
  convert(String(html || ""), {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
      { selector: "ul", options: { itemPrefix: "- " } },
      { selector: "h1", options: { uppercase: false } },
      { selector: "h2", options: { uppercase: false } },
      { selector: "h3", options: { uppercase: false } },
    ],
  }).trim();

const textToHtml = (text) =>
  String(text || "")
    .replace(/\r/g, "")
    .split(/\n{2,}/)
    .map((block) => `<p>${W.linkify(esc(block)).replace(/\n/g, "<br>")}</p>`)
    .join("");

// ---------------------------------------------------------------------------
// Signature: the person, the company, its phone and website, with the company's logo.
// ---------------------------------------------------------------------------
function signatureCompany(state, box) {
  const id = box.own ? box.companies[0] : box.companies.includes("group") ? "group" : box.companies[0];
  return (state.companies || []).find((c) => D.same(c.id, id)) || { id };
}

async function signatureParts(db, state, userName, box) {
  const company = signatureCompany(state, box);
  const settings = await MS.getSettings(db, company.id).catch(() => null);
  const s = settings?.signature || {};
  const name = box.own ? box.names[0] : company.name || "Sousa Group";
  const contact = [s.phone ? "Tél. " + s.phone : "", s.website || ""].filter(Boolean).join(" · ");
  const { companyBrand } = require("./finance");
  return { person: String(userName || ""), company: name, contact, extra: s.extra || "", logo: `/assets/logos/${companyBrand(company.id, company)}.png`, companyRecord: company };
}

async function signatureFor(db, state, userName, box) {
  const p = await signatureParts(db, state, userName, box);
  const logo = require("./mail-render").logoFor(p.companyRecord);
  const text = ["--", p.person, p.company, p.contact, p.extra].filter(Boolean).join("\n");
  const html =
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:20px;border-top:1px solid #e3e7ee"><tr>` +
    (logo ? `<td style="padding:12px 12px 0 0;vertical-align:top"><img src="cid:signature-logo@sousa" width="48" height="48" alt="${esc(p.company)}" style="display:block;border-radius:8px"></td>` : "") +
    `<td style="padding-top:12px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.45;color:#1f2a37">` +
    [p.person ? `<b>${esc(p.person)}</b>` : "", esc(p.company), esc(p.contact), esc(p.extra)].filter(Boolean).join("<br>") +
    `</td></tr></table>`;
  return { text, html, attachment: logo ? { filename: "logo.png", content: logo, contentType: "image/png", cid: "signature-logo@sousa" } : null };
}

// The text quoted under a reply or a forward.
function quoteOf(original, mode) {
  if (!original) return { text: "", html: "" };
  const body = W.linkify(esc(original.text)).replace(/\r?\n/g, "<br>");
  if (mode === "forward") {
    const lines = [
      "---------- Message transféré ----------",
      `De : ${who(original.from)}`,
      `Date : ${swissDateTime(original.date)}`,
      `Objet : ${original.subject || ""}`,
      `À : ${original.to.map(who).join(", ")}`,
      ...(original.cc.length ? [`Cc : ${original.cc.map(who).join(", ")}`] : []),
    ];
    return { text: lines.join("\n") + "\n\n" + original.text, html: `<div class="gmail_quote"><div class="gmail_attr">${lines.map(esc).join("<br>")}</div><br>${body}</div>` };
  }
  const header = `Le ${swissDateTime(original.date)}, ${who(original.from)} a écrit :`;
  return {
    text: header + "\n" + original.text.split("\n").map((line) => "> " + line).join("\n"),
    html: `<div class="gmail_quote"><div class="gmail_attr">${esc(header)}<br></div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${body}</blockquote></div>`,
  };
}

// ---------------------------------------------------------------------------
// Checking what was written
// ---------------------------------------------------------------------------
function addressesFrom(value, label) {
  const list = mailer
    .addressList(value)
    .map((a) => (a.match(/<([^<>]+)>\s*$/)?.[1] || a).trim())
    .filter(Boolean);
  const bad = list.find((a) => !mailer.validEmail(a));
  if (bad) D.fail(`Adresse e-mail invalide (${label}) : ${bad.slice(0, 80)}`);
  return [...new Map(list.map((a) => [a.toLowerCase(), a])).values()];
}

// Invoices, quotes (PDF made now) and documents of the application, as the person may see them.
async function appFiles(db, state, user, list) {
  if (!Array.isArray(list) || !list.length) return [];
  if (list.length > 10) D.fail("10 pièces de l’application au maximum.");
  const MR = require("./mail-routes");
  const view = D.viewState(state, user);
  const out = [];
  for (const item of list) {
    const kind = String(item?.kind || "");
    const id = String(item?.id || "");
    if (kind === "invoices" || kind === "quotes") {
      if (!D.privileged(user, D.FIN)) D.fail("Vous n’avez pas accès aux factures et aux devis.", 403);
      const doc = (view[kind] || []).find((x) => D.same(x.id, id) && !x.deletedAt);
      if (!doc) D.fail("Facture ou devis introuvable.", 404);
      if (doc.status === "Brouillon") D.fail(`Émettez ${kind === "invoices" ? "la facture" : "le devis"} ${doc.id} avant de l’envoyer.`);
      const { issuer, customer } = MR.financeParts(view, kind, doc);
      const pdf = await MR.financePdf(kind, doc, issuer, customer, kind === "invoices" && doc.status !== "Payée", { fallback: true });
      out.push({ name: `${doc.id}.pdf`, type: "application/pdf", data: Buffer.from(pdf).toString("base64") });
    } else if (kind === "documents") {
      const doc = (state.documents || []).find((d) => D.same(d.id, id) && !d.deletedAt);
      if (!doc || !D.canDocument(state, user, doc)) D.fail("Document inaccessible.", 403);
      const file = await require("./storage").loadFile(db, doc.id);
      if (!file) D.fail(`Fichier introuvable : ${doc.name}.`, 404);
      out.push({ name: String(doc.name || "document").slice(0, 150), type: doc.mime || "application/octet-stream", data: Buffer.from(file.content).toString("base64") });
    } else D.fail("Pièce jointe inconnue.");
  }
  return out;
}

const fileSize = (f) => Math.floor((String(f.data || "").length * 3) / 4);

// Everything needed to send (or save as a draft) later, checked now.
async function prepare(db, state, user, box, body, { draft = false } = {}) {
  const b = body || {};
  const to = addressesFrom(b.to, "destinataire");
  const cc = addressesFrom(b.cc, "copie");
  const bcc = addressesFrom(b.bcc, "copie cachée");
  if (!draft && !to.length) D.fail("Indiquez au moins un destinataire.");
  if (to.length + cc.length + bcc.length > 50) D.fail("50 destinataires au maximum.");
  const subject = String(b.subject || "").replace(/[\r\n]+/g, " ").trim().slice(0, 250);
  const html = cleanComposeHtml(b.html != null ? b.html : textToHtml(b.text || ""));
  const text = htmlToText(html);
  if (!draft && !subject && !text) D.fail("Écrivez un objet ou un message.");
  const mode = ["reply", "replyAll", "forward"].includes(b.mode) ? b.mode : "new";
  const ref = mode !== "new" && b.ref && typeof b.ref === "object" ? { folder: String(b.ref.folder || ""), uid: Number(b.ref.uid) || 0 } : null;
  const original = ref ? await W.messageView(box, ref.folder, ref.uid) : null;
  if (mode !== "new" && !original) D.fail("Message d’origine introuvable.", 404);
  const draftUid = Number.parseInt(b.draftUid, 10) > 0 ? Number.parseInt(b.draftUid, 10) : 0;

  const files = [];
  const uploads = Array.isArray(b.uploads) ? b.uploads : [];
  if (uploads.length > 10) D.fail("10 fichiers ajoutés au maximum.");
  for (const u of uploads) {
    const data = String(u?.data || "");
    if (!data || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) D.fail("Un fichier ajouté est vide ou illisible.");
    const type = String(u?.type || "").toLowerCase();
    files.push({ name: String(u?.name || "fichier").replace(/[\r\n"\\/]+/g, "_").slice(0, 150) || "fichier", type: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) ? type : "application/octet-stream", data });
  }
  files.push(...(await appFiles(db, state, user, b.appFiles)));
  const total = () => files.reduce((n, f) => n + fileSize(f), 0);
  const tooBig = () => total() > MAX_ATTACHMENTS && D.fail("Pièces jointes : 18 Mo au maximum au total (limite de Gmail).", 413);
  tooBig();
  // Attachments kept from the draft being edited, or taken from the forwarded message.
  const fetchParts = async (folder, uid, wanted, available) => {
    const parts = available.map((a) => a.part).filter((p) => wanted.includes(p));
    for (const file of await W.attachmentsFor(box, folder, uid, parts, MAX_ATTACHMENTS - total()))
      files.push({ name: file.filename, type: file.contentType, data: Buffer.from(file.content).toString("base64") });
  };
  if (draftUid && Array.isArray(b.draftParts) && b.draftParts.length) {
    const saved = await W.readDraft(box, draftUid);
    await fetchParts(saved.folder, draftUid, b.draftParts.map(String), saved.attachments);
  } else if (mode === "forward" && !draftUid) {
    const wanted = Array.isArray(b.forwardParts) ? b.forwardParts.map(String) : original.attachments.map((a) => a.part);
    await fetchParts(ref.folder, ref.uid, wanted, original.attachments);
  }
  tooBig();

  const quote = original && b.quote !== false ? quoteOf(original, mode) : { text: "", html: "" };
  const recipients = [...to, ...cc].map((a) => a.toLowerCase());
  const client = (state.clients || []).find((c) => !c.deletedAt && recipients.includes(String(c.email || "").trim().toLowerCase()));
  return {
    version: 1,
    box: box.id,
    userId: user.id,
    userName: user.name || "",
    to,
    cc,
    bcc,
    subject,
    html,
    text,
    mode,
    ref,
    quote: b.quote !== false,
    quoteText: quote.text,
    quoteHtml: quote.html,
    signature: b.signature !== false,
    inReplyTo: original?.messageId || "",
    references: original ? [...original.references, original.messageId].filter(Boolean) : [],
    files,
    draftUid,
    clientId: client ? String(client.id) : "",
  };
}

// The message as it leaves: the text, the signature, the quoted original, the attachments.
async function build(db, state, box, payload) {
  const signature = payload.signature ? await signatureFor(db, state, payload.userName, box) : null;
  const html =
    `<div dir="ltr" style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2a37">${payload.html}${signature?.html || ""}</div>` +
    (payload.quoteHtml ? "<br>" + payload.quoteHtml : "");
  const text = [payload.text, signature?.text, payload.quoteText].filter(Boolean).join("\n\n");
  const attachments = payload.files.map((f) => ({ filename: f.name, content: Buffer.from(f.data, "base64"), contentType: f.type }));
  if (signature?.attachment) attachments.push(signature.attachment);
  return { html, text, attachments };
}

async function deliver(db, state, box, payload) {
  const { html, text, attachments } = await build(db, state, box, payload);
  const info = await require("./mail-routes").sendLogged(
    db,
    { kind: "webmail", company: box.companies[0], entityType: payload.clientId ? "clients" : null, entityId: payload.clientId || null, createdBy: payload.userId },
    {
      to: payload.to.join(", "),
      cc: payload.cc,
      bcc: payload.bcc,
      subject: payload.subject,
      text,
      html,
      attachments,
      company: companyRef(state, box.companies[0]),
      fromName: box.own ? box.names[0] : "",
      replyTo: box.address,
      inReplyTo: payload.inReplyTo,
      references: payload.references,
    },
  );
  if (payload.ref && payload.mode !== "forward") await W.markAnswered(box, payload.ref.folder, payload.ref.uid);
  if (payload.draftUid) await W.removeDraft(box, payload.draftUid).catch(() => {});
  return info;
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------
function draftSource(box, payload) {
  const meta = Buffer.from(JSON.stringify({ mode: payload.mode, ref: payload.ref, quote: payload.quote, signature: payload.signature })).toString("base64");
  return new Promise((resolve, reject) => {
    const node = new MailComposer({
      from: { name: box.own ? box.names[0] : process.env.MAIL_FROM_NAME || "Sousa Group One", address: box.address },
      to: payload.to,
      cc: payload.cc,
      bcc: payload.bcc,
      subject: payload.subject,
      html: payload.html || "<p></p>",
      text: payload.text,
      inReplyTo: payload.inReplyTo || undefined,
      references: payload.references.length ? payload.references : undefined,
      headers: { "X-SGO-Compose": meta },
      attachments: payload.files.map((f) => ({ filename: f.name, content: Buffer.from(f.data, "base64"), contentType: f.type })),
    }).compile();
    node.keepBcc = true;
    node.build((error, raw) => (error ? reject(error) : resolve(raw)));
  });
}

async function saveDraft(box, payload) {
  return W.saveDraft(box, await draftSource(box, payload), payload.draftUid);
}

async function openDraft(box, uid) {
  const draft = await W.readDraft(box, uid);
  return {
    uid: draft.uid,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    html: cleanComposeHtml(draft.html || textToHtml(draft.text)),
    mode: ["reply", "replyAll", "forward"].includes(draft.meta.mode) ? draft.meta.mode : "new",
    ref: draft.meta.ref && typeof draft.meta.ref === "object" ? draft.meta.ref : null,
    quote: draft.meta.quote !== false,
    signature: draft.meta.signature !== false,
    attachments: draft.attachments,
  };
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------
async function queue(db, box, user, payload, { sendAt = null } = {}) {
  const id = randomUUID();
  const scheduled = !!sendAt;
  const at = scheduled ? new Date(sendAt) : new Date(Date.now() + undoSeconds() * 1000);
  await db.query(
    `INSERT INTO webmail_outbox(id,mailbox,user_id,kind,status,send_at,subject,recipients,payload)
     VALUES($1,$2,$3,$4,'scheduled',$5,$6,$7,$8)`,
    [id, box.id, user.id, scheduled ? "scheduled" : "undo", at, payload.subject.slice(0, 250), [...payload.to, ...payload.cc].join(", ").slice(0, 500), JSON.stringify(payload)],
  );
  if (!scheduled) {
    const timer = setTimeout(() => processOutbox(db, { id }).catch(() => {}), Math.max(0, at.getTime() - Date.now()) + 50);
    timer.unref?.();
  }
  return { id, sendAt: at.toISOString(), kind: scheduled ? "scheduled" : "undo" };
}

async function notifyFailure(db, row, box, message) {
  await require("./messaging-routes")
    .notifyUsers(db, [Number(row.user_id)], {
      category: "system",
      title: "E-mail non envoyé",
      body: `${row.subject || "(sans objet)"} : ${message}`.slice(0, 300),
      url: `/?open=mailbox&box=${encodeURIComponent(row.mailbox)}`,
      entityType: "mailbox",
      entityId: row.mailbox,
    })
    .catch(() => {});
}

// Sends what is due. Each message is taken by one run only (status « sending »).
async function processOutbox(db, { id = null, now = new Date() } = {}) {
  const result = { sent: 0, failed: 0 };
  if (!id) {
    // A message left « sending » by a restart is not sent twice: it is reported.
    const stuck = (await db.query("UPDATE webmail_outbox SET status='failed',error=$2 WHERE status='sending' AND send_at < $1 RETURNING *", [new Date(now.getTime() - 15 * 60000), "Envoi interrompu par un redémarrage du serveur. Vérifiez « Messages envoyés » avant de renvoyer."])).rows;
    for (const row of stuck) await notifyFailure(db, row, null, row.error);
    await db.query("DELETE FROM webmail_outbox WHERE status IN ('sent','cancelled','failed') AND created_at < $1", [new Date(now.getTime() - 30 * 86400000)]);
  }
  const due = (await db.query(`SELECT id FROM webmail_outbox WHERE status='scheduled' AND send_at <= $1${id ? " AND id=$2" : ""} ORDER BY send_at LIMIT 25`, id ? [now, id] : [now])).rows;
  for (const { id: rowId } of due) {
    const row = (await db.query("UPDATE webmail_outbox SET status='sending' WHERE id=$1 AND status='scheduled' RETURNING *", [rowId])).rows[0];
    if (!row) continue;
    try {
      const state = (await loadState(db)).data;
      const raw = (await db.query("SELECT * FROM users WHERE id=$1", [row.user_id])).rows[0];
      if (!raw || raw.disabled || raw.deleted_at) D.fail("Le compte qui a écrit ce message n’est plus actif.");
      const user = D.effectiveUser(state, raw);
      const box = await W.openable(db, state, user, row.mailbox);
      const info = await deliver(db, state, box, JSON.parse(row.payload));
      await db.query("UPDATE webmail_outbox SET status='sent',sent_at=NOW(),payload=NULL,message_id=$2,error=NULL WHERE id=$1", [row.id, String(info?.messageId || "").slice(0, 500) || null]);
      result.sent++;
    } catch (error) {
      const message = error?.expose || error?.status < 500 ? String(error.message) : "L’e-mail n’a pas pu être envoyé.";
      await db.query("UPDATE webmail_outbox SET status='failed',error=$2 WHERE id=$1", [row.id, message.slice(0, 500)]);
      if (row.kind === "scheduled") await notifyFailure(db, row, null, message);
      result.failed++;
    }
  }
  return result;
}

module.exports = {
  MAX_ATTACHMENTS,
  undoSeconds,
  cleanComposeHtml,
  htmlToText,
  textToHtml,
  signatureParts,
  signatureFor,
  quoteOf,
  addressesFrom,
  prepare,
  build,
  deliver,
  draftSource,
  saveDraft,
  openDraft,
  queue,
  processOutbox,
};
