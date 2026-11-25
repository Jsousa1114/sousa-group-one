"use strict";
// E-mails linked to the application: an e-mail (as a PDF) and its attachments saved in the
// documents of a site or a client, and reminders (« Me le rappeler »): the conversation leaves
// the inbox and comes back, unread, at the time chosen, with a notification.
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const D = require("./domain");
const W = require("./webmail");
const { loadState } = require("./db");

const who = (a) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : "");
const swissDateTime = (iso) => {
  const d = new Date(iso || 0);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("fr-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
};
const printable = (text) => String(text || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
const MAX_FILE = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// An e-mail as a PDF: who, when, subject, the text, the attachments' names.
// ---------------------------------------------------------------------------
function messagePdf(view, mailboxLabel) {
  const PDFDocument = require("pdfkit");
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: "A4", margin: 56, info: { Title: printable(view.subject || "E-mail"), Creator: "Sousa Group One" } });
    const chunks = [];
    pdf.on("data", (c) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
    pdf.registerFont("regular", path.join(__dirname, "assets/fonts/LiberationSans-Regular.ttf"));
    pdf.registerFont("bold", path.join(__dirname, "assets/fonts/LiberationSans-Bold.ttf"));
    const width = pdf.page.width - 112;
    pdf.font("regular").fontSize(9).fillColor("#5b6779").text(printable(`E-mail · ${mailboxLabel}`), { width });
    pdf.moveDown(0.6);
    pdf.font("bold").fontSize(15).fillColor("#1f2a37").text(printable(view.subject || "(sans objet)"), { width });
    pdf.moveDown(0.6);
    const line = (label, value) => {
      if (!value) return;
      pdf.font("bold").fontSize(10).fillColor("#1f2a37").text(label + " : ", { continued: true, width });
      pdf.font("regular").text(printable(value), { width });
    };
    line("De", who(view.from));
    line("À", (view.to || []).map(who).join(", "));
    line("Cc", (view.cc || []).map(who).join(", "));
    line("Date", swissDateTime(view.date));
    if (view.attachments?.length) line("Pièces jointes", view.attachments.map((a) => a.filename).join(", "));
    pdf.moveDown(0.5);
    const y = pdf.y;
    pdf.moveTo(56, y).lineTo(56 + width, y).strokeColor("#d8dee8").lineWidth(1).stroke();
    pdf.moveDown(0.8);
    pdf.font("regular").fontSize(10.5).fillColor("#1f2a37").text(printable(view.text || "(message sans texte)"), { width, lineGap: 2 });
    pdf.end();
  });
}

const fileName = (value) =>
  String(value || "")
    .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);

// Saves the e-mail and/or some of its attachments in the documents of a site or a client.
async function fileMessage(db, user, box, { folder, uid, target, message = true, parts = [] }) {
  const type = target?.type === "client" ? "client" : target?.type === "project" ? "project" : "";
  const targetId = String(target?.id || "");
  if (!type || !targetId) D.fail("Choisissez un chantier ou un client.");
  const view = await W.messageView(box, folder, uid);
  const files = [];
  if (message) {
    const day = view.date ? new Date(view.date).toISOString().slice(0, 10) : "";
    files.push({ name: fileName(`E-mail ${day} ${view.subject || "sans objet"}`) + ".pdf", mime: "application/pdf", content: await messagePdf(view, box.label) });
  }
  const wanted = [...new Set((Array.isArray(parts) ? parts : []).map(String))].slice(0, 10);
  for (const part of wanted) {
    if (!view.attachments.some((a) => a.part === part)) D.fail("Pièce jointe introuvable.", 404);
    const file = await W.attachment(box, folder, uid, part);
    if (file.content.length > MAX_FILE) D.fail(`« ${file.filename} » dépasse 10 Mo : enregistrez-le depuis Gmail.`, 413);
    files.push({ name: fileName(file.filename) || "piece-jointe", mime: file.contentType || "application/octet-stream", content: file.content });
  }
  if (!files.length) D.fail("Choisissez le message ou au moins une pièce jointe.");
  const storage = require("./storage");
  const { withStateWrite } = require("./p1-routes");
  return withStateWrite(db, user.id, "webmail.file", async (c, data, actor) => {
    if (actor.role === "client") D.fail("Accès non autorisé.", 403);
    const record = (type === "project" ? data.projects : data.clients || []).find((x) => D.same(x.id, targetId) && !x.deletedAt);
    if (!record) D.fail(type === "project" ? "Chantier introuvable." : "Client introuvable.", 404);
    if (!D.inCompany(actor, record.company)) D.fail("Dossier non autorisé.", 403);
    data.documents ||= [];
    const saved = [];
    for (const f of files) {
      const doc = {
        id: randomUUID(),
        name: f.name,
        company: record.company,
        project: type === "project" ? String(record.id) : "",
        employeeId: "",
        clientId: type === "client" ? String(record.id) : "",
        createdAt: new Date().toISOString(),
        uploadedBy: actor.id,
        visibility: "team",
        category: "E-mail",
        mime: f.mime,
        size: f.content.length,
      };
      if (!D.canDocument(data, actor, doc)) D.fail("Dossier non autorisé.", 403);
      await storage.saveFile(c, doc.id, f.content, f.mime);
      data.documents.push(doc);
      saved.push({ id: doc.id, name: doc.name });
    }
    return { data, changed: ["documents"], audit: { target: `${type}:${record.id}`, files: saved.length, mailbox: box.id }, saved, targetName: record.title || record.name || "" };
  });
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------
async function remind(db, user, box, { folder, uid, threadId = "", at }) {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) D.fail("Choisissez une date et une heure.");
  if (when.getTime() < Date.now() + 60 * 1000) D.fail("Choisissez un moment dans le futur.");
  if (when.getTime() > Date.now() + 366 * 86400000) D.fail("Un an au maximum.");
  const view = await W.messageView(box, folder, uid);
  const f = await W.folderOf(box, folder);
  const thread = /^\d{1,25}$/.test(String(threadId || "")) ? String(threadId) : "";
  // The conversation leaves the inbox now (archived) and comes back at the time chosen.
  if (f.id === "inbox") await W.act(box, "inbox", { uids: [Number(uid)], threads: thread ? [thread] : [], action: "archive" });
  const id = randomUUID();
  await db.query(
    `INSERT INTO webmail_reminders(id,mailbox,user_id,thread_id,message_id,subject,sender,remind_at,status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending')`,
    [id, box.id, user.id, thread || null, view.messageId || null, String(view.subject || "").slice(0, 250), who(view.from).slice(0, 300), when],
  );
  return { id, remindAt: when.toISOString(), archived: f.id === "inbox" };
}

async function listReminders(db, box) {
  return (
    await db.query(
      `SELECT r.id,r.subject,r.sender,r.remind_at,r.thread_id,u.name AS user_name FROM webmail_reminders r LEFT JOIN users u ON u.id=r.user_id
       WHERE r.mailbox=$1 AND r.status='pending' ORDER BY r.remind_at LIMIT 200`,
      [box.id],
    )
  ).rows.map((r) => ({ id: r.id, subject: r.subject, sender: r.sender, remindAt: new Date(r.remind_at).toISOString(), threadId: r.thread_id, by: r.user_name || "" }));
}

// « Annuler le rappel »: the conversation comes back now.
async function cancelReminder(db, box, id) {
  const row = (await db.query("UPDATE webmail_reminders SET status='cancelled',done_at=NOW() WHERE id=$1 AND mailbox=$2 AND status='pending' RETURNING *", [String(id), box.id])).rows[0];
  if (!row) D.fail("Rappel introuvable ou déjà passé.", 404);
  await W.resurface(box, { threadId: row.thread_id || "", messageId: row.message_id || "" });
  return { ok: true };
}

async function processReminders(db, { now = new Date() } = {}) {
  const result = { done: 0, failed: 0 };
  const due = (await db.query("SELECT id FROM webmail_reminders WHERE status='pending' AND remind_at <= $1 ORDER BY remind_at LIMIT 50", [now])).rows;
  if (!due.length) return result;
  const state = (await loadState(db)).data;
  const boxes = W.mailboxes(state);
  for (const { id } of due) {
    const row = (await db.query("UPDATE webmail_reminders SET status='done',done_at=NOW() WHERE id=$1 AND status='pending' RETURNING *", [id])).rows[0];
    if (!row) continue;
    const box = boxes.find((b) => b.id === row.mailbox);
    try {
      if (!box) D.fail("Boîte mail introuvable.");
      await W.resurface(box, { threadId: row.thread_id || "", messageId: row.message_id || "" });
      result.done++;
    } catch (error) {
      await db.query("UPDATE webmail_reminders SET error=$2 WHERE id=$1", [row.id, String(error.message || "").slice(0, 300)]);
      result.failed++;
    }
    await require("./messaging-routes")
      // A reminder was asked for: it arrives even when « Nouveaux e-mails » is switched off.
      .notifyUsers(db, [Number(row.user_id)], {
        category: "reminders",
        title: "Rappel : " + (row.subject || "(sans objet)"),
        body: `${row.sender || ""}${box ? " · " + box.label : ""}`.slice(0, 300),
        url: `/?open=mailbox&box=${encodeURIComponent(row.mailbox)}`,
        entityType: "mailbox",
        entityId: row.mailbox,
      })
      .catch(() => {});
  }
  return result;
}

module.exports = { messagePdf, fileMessage, remind, listReminders, cancelReminder, processReminders };
