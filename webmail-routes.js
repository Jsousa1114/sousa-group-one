"use strict";
// Routes of the « Boîte mail » page (/api/webmail). The mailbox itself is read from Gmail by
// webmail.js; this file checks who may open which mailbox, and hands what is written to
// webmail-compose.js (formatting, signature, drafts, outbox: 10 seconds to cancel or a time
// chosen) and the links with the application to webmail-organize.js (documents, reminders).
// The assistant summarises a conversation or proposes a reply when the reader asks.
const express = require("express");
const { randomUUID } = require("node:crypto");
const D = require("./domain");
const { auth } = require("./auth-middleware");
const { loadState } = require("./db");
const W = require("./webmail");

const C = require("./webmail-compose");
const O = require("./webmail-organize");

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const companyRef = (state, id) => {
  const c = (state?.companies || []).find((x) => D.same(x.id, id));
  return c ? { id: String(c.id), name: c.name || "", code: c.code || "" } : { id: String(id || "") };
};
const who = (a) => (a ? (a.name ? `${a.name} <${a.address}>` : a.address) : "");
const swissDateTime = (iso) => {
  const d = new Date(iso || 0);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("fr-CH", { timeZone: "Europe/Zurich", weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
};
const sendTimes = new Map(); // user id -> send times of the last hour
function checkSendRate(userId) {
  const now = Date.now();
  const recent = (sendTimes.get(userId) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length >= 60) D.fail("Limite atteinte : 60 e-mails par heure depuis l’application. Réessayez plus tard.", 429);
  recent.push(now);
  sendTimes.set(userId, recent);
}

const attachmentHeader = (inline, filename) => {
  const ascii = String(filename || "piece-jointe").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename || "piece-jointe")}`;
};

function routes(db) {
  const r = express.Router();
  r.use(auth(db));
  const stateOf = async () => (await loadState(db)).data;
  const groupAdmin = (user) => user.role === "admin" && user.company === "group";
  const open = async (req) => {
    if (req.user.role === "client") D.fail("Accès non autorisé.", 403);
    const state = await stateOf();
    return { state, box: await W.openable(db, state, req.user, req.params.box) };
  };

  // Mailboxes the person may open, with their unread count and the proposed signature.
  r.get(
    "/status",
    wrap(async (req, res) => {
      if (req.user.role === "client") return res.json({ mailboxes: [], canManage: false, configured: false });
      const state = await stateOf();
      const out = [];
      for (const box of await W.accessible(db, state, req.user)) {
        const { companyRecord, ...signature } = await C.signatureParts(db, state, req.user.name, box);
        out.push({ id: box.id, label: box.label, address: box.address, companies: box.companies, unread: W.unreadOf(box), signature });
      }
      res.json({ mailboxes: out, canManage: groupAdmin(req.user), configured: W.mailboxes(state).length > 0, undoSeconds: C.undoSeconds() });
    }),
  );

  // Who may open which mailbox (administrators of the group only).
  r.get(
    "/access",
    wrap(async (req, res) => {
      if (!groupAdmin(req.user)) D.fail("Accès non autorisé.", 403);
      const state = await stateOf();
      const boxes = W.mailboxes(state);
      const users = (await db.query("SELECT id,name,email,role,company FROM users WHERE disabled=false AND deleted_at IS NULL AND role<>'client' ORDER BY name")).rows;
      const grants = (await db.query("SELECT user_id,mailbox FROM mailbox_access")).rows;
      res.json({
        mailboxes: boxes.map((b) => ({ id: b.id, label: b.label, address: b.address })),
        users: users.map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          company: u.company === "group" ? "Sousa Group" : companyRef(state, u.company).name || u.company,
          granted: grants.filter((g) => Number(g.user_id) === Number(u.id)).map((g) => String(g.mailbox)),
          automatic: boxes.filter((b) => W.automaticAccess(u, b)).map((b) => b.id),
        })),
      });
    }),
  );

  r.post(
    "/access",
    wrap(async (req, res) => {
      if (!groupAdmin(req.user)) D.fail("Accès non autorisé.", 403);
      const userId = Number(req.body?.userId);
      const target = (await db.query("SELECT id,email,role FROM users WHERE id=$1 AND deleted_at IS NULL", [userId])).rows[0];
      if (!target) D.fail("Compte introuvable.", 404);
      if (target.role === "client") D.fail("Un compte client ne peut pas ouvrir les boîtes mail de l’entreprise.");
      const known = W.mailboxes(await stateOf()).map((b) => b.id);
      const wanted = [...new Set((Array.isArray(req.body?.mailboxes) ? req.body.mailboxes : []).map(String))].filter((id) => known.includes(id));
      await db.query("DELETE FROM mailbox_access WHERE user_id=$1 AND mailbox = ANY($2::text[])", [userId, known]);
      for (const id of wanted)
        await db.query("INSERT INTO mailbox_access(user_id,mailbox,granted_by) VALUES($1,$2,$3) ON CONFLICT(user_id,mailbox) DO NOTHING", [userId, id, req.user.id]);
      await db.query("INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)", [
        req.user.email || "",
        "webmail.access",
        JSON.stringify({ user: target.email, mailboxes: wanted }),
      ]);
      res.json({ ok: true, granted: wanted });
    }),
  );

  r.get(
    "/:box/folders",
    wrap(async (req, res) => {
      const { box } = await open(req);
      const folders = await W.folderList(box, req.query.fresh === "1");
      const counts = await W.folderCounts(box);
      res.json({ address: box.address, folders: folders.map(({ id, name, special }) => ({ id, name, special, ...(counts[id] || {}) })) });
    }),
  );

  r.get(
    "/:box/messages",
    wrap(async (req, res) => {
      const { box } = await open(req);
      res.json(await W.listMessages(box, req.query.folder, { page: req.query.page, query: req.query.q }));
    }),
  );

  r.get(
    "/:box/conversation",
    wrap(async (req, res) => {
      const { box } = await open(req);
      res.json(await W.conversation(box, req.query.folder, req.query.uid));
    }),
  );

  // The message itself, in an isolated frame: no script, remote images only on request.
  r.get(
    "/:box/frame",
    wrap(async (req, res) => {
      const images = req.query.images === "1";
      res.set(W.frameHeaders(images));
      try {
        const { box } = await open(req);
        res.send(await W.frame(box, req.query.folder, req.query.uid, images));
      } catch (error) {
        res
          .status(error.status || 500)
          .send(`<!doctype html><meta charset="utf-8"><p style="font:14px Arial,sans-serif;color:#8a1c1c">${W.escapeHtml(error.expose ? error.message : "Message illisible pour le moment.")}</p>`);
      }
    }),
  );

  r.get(
    "/:box/attachment",
    wrap(async (req, res) => {
      const { box } = await open(req);
      const file = await W.attachment(box, req.query.folder, req.query.uid, req.query.part);
      const inline = req.query.inline === "1" && file.viewable;
      res.set({
        "Content-Type": inline ? file.contentType : "application/octet-stream",
        "Content-Disposition": attachmentHeader(inline, file.filename),
        "Content-Length": String(file.content.length),
        "Cache-Control": "private, no-store",
      });
      res.end(file.content);
    }),
  );

  r.post(
    "/:box/action",
    wrap(async (req, res) => {
      const { box } = await open(req);
      const b = req.body || {};
      res.json(await W.act(box, b.folder, { uids: b.uids, threads: b.threads, action: String(b.action || ""), target: b.target }));
    }),
  );

  // New message, reply, reply to all or forward, sent from the mailbox's Gmail account: it
  // leaves after 10 seconds (« Annuler ») or at the time chosen (sendAt).
  r.post(
    "/:box/send",
    wrap(async (req, res) => {
      const { state, box } = await open(req);
      const b = req.body || {};
      let sendAt = null;
      if (b.sendAt) {
        const at = new Date(b.sendAt);
        if (Number.isNaN(at.getTime())) D.fail("Date d’envoi invalide.");
        if (at.getTime() < Date.now() + 60 * 1000) D.fail("Choisissez un moment dans le futur pour l’envoi programmé.");
        if (at.getTime() > Date.now() + 366 * 86400000) D.fail("Un envoi se programme au plus un an à l’avance.");
        sendAt = at;
      }
      const payload = await C.prepare(db, state, req.user, box, b);
      checkSendRate(req.user.id);
      if (!sendAt && !C.undoSeconds()) {
        const info = await C.deliver(db, state, box, payload);
        return res.json({ ok: true, sent: true, messageId: info?.messageId || "" });
      }
      res.json({ ok: true, sent: false, ...(await C.queue(db, box, req.user, payload, { sendAt })) });
    }),
  );

  // Messages waiting to leave (programmed), and those that could not be sent.
  r.get(
    "/:box/outbox",
    wrap(async (req, res) => {
      const { box } = await open(req);
      const rows = (
        await db.query(
          `SELECT o.id,o.kind,o.status,o.send_at,o.subject,o.recipients,o.error,o.user_id,u.name AS user_name FROM webmail_outbox o LEFT JOIN users u ON u.id=o.user_id
           WHERE o.mailbox=$1 AND ((o.status='scheduled' AND o.kind='scheduled') OR (o.status='failed' AND o.created_at > NOW() - INTERVAL '7 days'))
           ORDER BY o.send_at LIMIT 200`,
          [box.id],
        )
      ).rows;
      res.json({ messages: rows.map((r) => ({ id: r.id, kind: r.kind, status: r.status, sendAt: new Date(r.send_at).toISOString(), subject: r.subject, recipients: r.recipients, error: r.error, by: r.user_name || "", mine: Number(r.user_id) === Number(req.user.id) })) });
    }),
  );

  r.get(
    "/:box/outbox/:id",
    wrap(async (req, res) => {
      const { box } = await open(req);
      const row = (await db.query("SELECT id,status,error,send_at FROM webmail_outbox WHERE id=$1 AND mailbox=$2", [req.params.id, box.id])).rows[0];
      if (!row) D.fail("Envoi introuvable.", 404);
      res.json({ id: row.id, status: row.status, error: row.error, sendAt: new Date(row.send_at).toISOString() });
    }),
  );

  // « Annuler » (in the 10 seconds) or cancelling a programmed message. With draft: true the
  // message goes back to « Brouillons », attachments included.
  r.post(
    "/:box/outbox/:id/cancel",
    wrap(async (req, res) => {
      const { box } = await open(req);
      const row = (
        await db.query("UPDATE webmail_outbox SET status='cancelled' WHERE id=$1 AND mailbox=$2 AND status IN ('scheduled','failed') AND payload IS NOT NULL AND (user_id=$3 OR $4) RETURNING *", [
          req.params.id,
          box.id,
          req.user.id,
          groupAdmin(req.user),
        ])
      ).rows[0];
      if (!row) {
        const current = (await db.query("SELECT status FROM webmail_outbox WHERE id=$1 AND mailbox=$2", [req.params.id, box.id])).rows[0];
        if (current?.status === "sent" || current?.status === "sending") D.fail("Trop tard : l’e-mail est déjà parti.", 409);
        D.fail("Envoi introuvable.", 404);
      }
      const payload = JSON.parse(row.payload);
      let draft = null;
      if (req.body?.draft) draft = await C.saveDraft(box, { ...payload, draftUid: 0 });
      res.json({
        ok: true,
        draft,
        compose: { to: payload.to, cc: payload.cc, bcc: payload.bcc, subject: payload.subject, html: payload.html, mode: payload.mode, ref: payload.ref, quote: payload.quote, signature: payload.signature, files: payload.files.map((f) => f.name) },
      });
    }),
  );

  // Drafts, kept in Gmail's « Brouillons ».
  r.post(
    "/:box/draft",
    wrap(async (req, res) => {
      const { state, box } = await open(req);
      const payload = await C.prepare(db, state, req.user, box, req.body || {}, { draft: true });
      const saved = await C.saveDraft(box, payload);
      const attachments = saved.uid ? (await C.openDraft(box, saved.uid).catch(() => null))?.attachments || [] : [];
      res.json({ ok: true, ...saved, attachments });
    }),
  );

  r.get(
    "/:box/draft",
    wrap(async (req, res) => {
      const { box } = await open(req);
      res.json(await C.openDraft(box, req.query.uid));
    }),
  );

  r.post(
    "/:box/draft/delete",
    wrap(async (req, res) => {
      const { box } = await open(req);
      await W.removeDraft(box, req.body?.uid);
      res.json({ ok: true });
    }),
  );

  // Quick replies of a mailbox, shared by everyone who may open it.
  r.get(
    "/:box/snippets",
    wrap(async (req, res) => {
      const { box } = await open(req);
      const rows = (await db.query("SELECT id,title,body FROM webmail_snippets WHERE mailbox=$1 ORDER BY lower(title) LIMIT 100", [box.id])).rows;
      res.json({ snippets: rows.map((r) => ({ id: r.id, title: r.title, html: r.body })) });
    }),
  );

  r.post(
    "/:box/snippets",
    wrap(async (req, res) => {
      const { box } = await open(req);
      const title = String(req.body?.title || "").replace(/\s+/g, " ").trim().slice(0, 80);
      const html = C.cleanComposeHtml(String(req.body?.html || "").slice(0, 20000));
      if (!title) D.fail("Donnez un nom à la réponse rapide.");
      if (!C.htmlToText(html)) D.fail("Écrivez le texte de la réponse rapide.");
      const id = String(req.body?.id || "");
      if (id) {
        const updated = (await db.query("UPDATE webmail_snippets SET title=$3,body=$4,updated_at=NOW() WHERE id=$1 AND mailbox=$2 RETURNING id", [id, box.id, title, html])).rows[0];
        if (!updated) D.fail("Réponse rapide introuvable.", 404);
        return res.json({ ok: true, id });
      }
      const count = Number((await db.query("SELECT COUNT(*)::int AS n FROM webmail_snippets WHERE mailbox=$1", [box.id])).rows[0].n);
      if (count >= 100) D.fail("100 réponses rapides au maximum par boîte.");
      const created = randomUUID();
      await db.query("INSERT INTO webmail_snippets(id,mailbox,title,body,created_by) VALUES($1,$2,$3,$4,$5)", [created, box.id, title, html, req.user.id]);
      res.json({ ok: true, id: created });
    }),
  );

  r.post(
    "/:box/snippets/:id/delete",
    wrap(async (req, res) => {
      const { box } = await open(req);
      await db.query("DELETE FROM webmail_snippets WHERE id=$1 AND mailbox=$2", [req.params.id, box.id]);
      res.json({ ok: true });
    }),
  );

  // « Classer » : the e-mail (PDF) and/or attachments saved in a site's or a client's documents.
  r.post(
    "/:box/file",
    wrap(async (req, res) => {
      const { box } = await open(req);
      const b = req.body || {};
      const result = await O.fileMessage(db, req.user, box, { folder: b.folder, uid: b.uid, target: b.target, message: b.message !== false, parts: b.parts });
      res.json({ ok: true, saved: result.saved, target: result.targetName });
    }),
  );

  // « Me le rappeler »
  r.post(
    "/:box/remind",
    wrap(async (req, res) => {
      const { box } = await open(req);
      const b = req.body || {};
      res.json({ ok: true, ...(await O.remind(db, req.user, box, { folder: b.folder, uid: b.uid, threadId: b.threadId, at: b.at })) });
    }),
  );

  r.get(
    "/:box/reminders",
    wrap(async (req, res) => {
      const { box } = await open(req);
      res.json({ reminders: await O.listReminders(db, box) });
    }),
  );

  r.post(
    "/:box/reminders/:id/cancel",
    wrap(async (req, res) => {
      const { box } = await open(req);
      res.json(await O.cancelReminder(db, box, req.params.id));
    }),
  );

  // Assistant: summary of the conversation, or a reply to check before sending.
  r.post(
    "/:box/ai",
    wrap(async (req, res) => {
      const { state, box } = await open(req);
      const p3 = require("./p3-intelligence-routes");
      if (!p3.aiConfigured()) D.fail("L’assistant IA n’est pas configuré sur le serveur.", 503);
      const mode = req.body?.mode === "reply" ? "reply" : "summary";
      const conv = await W.conversation(box, req.body?.folder, req.body?.uid);
      const { replyText } = require("./mail-inbox");
      let budget = 16000;
      const blocks = [];
      for (const m of conv.messages.slice(-6).reverse()) {
        const own = m.from?.address === box.address.toLowerCase();
        const body = replyText({ text: m.text }).slice(0, 5000) || m.snippet || "";
        const block = `${own ? "Message envoyé par nous" : "Message reçu"}\nDe : ${who(m.from)}\nDate : ${swissDateTime(m.date)}\nÀ : ${m.to.map(who).join(", ")}\nObjet : ${m.subject}\n\n${body}`;
        if (block.length > budget) break;
        budget -= block.length;
        blocks.unshift(block);
      }
      const companyName = box.own ? box.names[0] : "Sousa Group";
      // What we know about the client who wrote, to answer questions about invoices or quotes.
      const lastIn = [...conv.messages].reverse().find((m) => m.from?.address && m.from.address !== box.address.toLowerCase());
      const view = D.viewState(state, req.user);
      const client = lastIn ? (view.clients || []).find((c) => !c.deletedAt && String(c.email || "").trim().toLowerCase() === lastIn.from.address) : null;
      let facts = "";
      if (client) {
        const money = (n) => "CHF " + (Number(n) || 0).toFixed(2);
        const unpaid = (view.invoices || []).filter(
          (i) => D.same(i.clientId, client.id) && !i.deletedAt && !i.archivedAt && !["Payée", "Brouillon"].includes(i.status) && (Number(i.amount) || 0) - (Number(i.paid) || 0) > 0.004,
        );
        const quotes = (view.quotes || []).filter((q) => D.same(q.clientId, client.id) && !q.deletedAt && !q.archivedAt && q.status === "Émise");
        facts =
          `Client connu : ${client.name}.` +
          (unpaid.length ? ` Factures ouvertes : ${unpaid.slice(0, 5).map((i) => `${i.id} (reste ${money((Number(i.amount) || 0) - (Number(i.paid) || 0))}, échéance ${i.due || "?"})`).join(", ")}.` : " Aucune facture ouverte.") +
          (quotes.length ? ` Devis en attente : ${quotes.slice(0, 5).map((q) => `${q.id} (${money(q.amount)})`).join(", ")}.` : "") +
          "\n\n";
      }
      const instruction = String(req.body?.instruction || "").replace(/\s+/g, " ").trim().slice(0, 500);
      const system =
        mode === "reply"
          ? `Tu es l’assistant de ${companyName}, entreprise suisse du groupe Sousa. Tu rédiges la réponse de ${req.user.name || "l’utilisateur"} au dernier message reçu de cette conversation e-mail. ` +
            "Règles : réponds dans la langue du dernier message reçu ; vouvoiement sauf si l’interlocuteur tutoie ; ton professionnel, cordial et concis ; commence par une salutation adaptée ; " +
            "termine par une formule courte (« Meilleures salutations ») sans nom ni signature (elle est ajoutée ensuite) ; pas d’objet ; texte brut sans Markdown ; " +
            "n’invente jamais un prix, une date, un délai ou un engagement : si une information manque, écris [à compléter]."
          : `Tu résumes une conversation e-mail pour ${req.user.name || "l’utilisateur"} de ${companyName}. Réponds en français, en texte brut : ` +
            "2 à 4 lignes commençant par « - » avec l’essentiel (qui demande quoi, montants, dates), puis une ligne « À faire : … » (ou « À faire : rien »). N’invente rien.";
      const user = (instruction ? `Consigne : ${instruction}\n\n` : "") + facts + "Conversation, du plus ancien au plus récent :\n\n" + blocks.join("\n\n-----\n\n");
      const out = await p3.meteredAi(db, req.user, mode === "reply" ? "mail_reply" : "mail_summary", { system, user, timeoutMs: 40000 });
      res.json({ mode, text: String(out || "").trim() });
    }),
  );

  return r;
}

// New messages in the inboxes: a notification to everyone who may open the mailbox.
let checking = false;
async function checkNewMail(db) {
  if (checking) return { skipped: true };
  checking = true;
  try {
    const state = (await loadState(db)).data;
    return await W.checkNewMail(db, state, {
      notify: async (box, messages) => {
        const users = await W.usersWithAccess(db, box);
        if (!users.length) return;
        const first = messages[0];
        const sender = (m) => m.from?.name || m.from?.address || "Expéditeur inconnu";
        const title = messages.length === 1 ? `Nouvel e-mail de ${sender(first)}` : `${messages.length} nouveaux e-mails · ${box.label}`;
        const body =
          messages.length === 1
            ? `${first.subject || "(sans objet)"} · ${box.label}`
            : "De " + [...new Set(messages.map(sender))].slice(0, 3).join(", ") + (new Set(messages.map(sender)).size > 3 ? "…" : "");
        await require("./messaging-routes")
          .notifyUsers(db, users, { category: "mail", title, body, url: `/?open=mailbox&box=${encodeURIComponent(box.id)}`, entityType: "mailbox", entityId: box.id })
          .catch(() => {});
      },
    });
  } finally {
    checking = false;
  }
}

module.exports = { routes, checkNewMail };
