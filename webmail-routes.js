"use strict";
// Routes of the « Boîte mail » page (/api/webmail). The mailbox itself is read from Gmail by
// webmail.js; this file checks who may open which mailbox, sends the messages written in the
// application (through the same Gmail account, so Gmail keeps them in « Messages envoyés »),
// and asks the assistant for a summary or a reply when the reader clicks the button.
const express = require("express");
const D = require("./domain");
const { auth } = require("./auth-middleware");
const { loadState } = require("./db");
const mailer = require("./mailer");
const MS = require("./mail-settings");
const W = require("./webmail");

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const MAX_ATTACHMENTS = 18 * 1024 * 1024; // Gmail refuses messages over 25 MB once encoded

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
const asHtml = (text) => W.linkify(W.escapeHtml(String(text || ""))).replace(/\r?\n/g, "<br>");

// Signature proposed in a new message: the person, the company and its contact details
// (taken from the company's e-mail settings).
function signatureFor(user, box, settings) {
  const s = settings?.signature || {};
  const contact = [s.phone, s.website].filter(Boolean).join(" · ");
  return ["", "--", user.name || "", box.own ? box.names[0] : "", contact].filter((line, i) => i < 2 || line).join("\n");
}

// The text quoted under a reply or a forward, in text and in HTML.
function quoteOf(original, mode) {
  if (!original) return { text: "", html: "" };
  if (mode === "forward") {
    const lines = [
      "---------- Message transféré ----------",
      `De : ${who(original.from)}`,
      `Date : ${swissDateTime(original.date)}`,
      `Objet : ${original.subject || ""}`,
      `À : ${original.to.map(who).join(", ")}`,
      ...(original.cc.length ? [`Cc : ${original.cc.map(who).join(", ")}`] : []),
    ];
    return {
      text: lines.join("\n") + "\n\n" + original.text,
      html: `<div class="gmail_quote"><div class="gmail_attr">${lines.map(W.escapeHtml).join("<br>")}</div><br>${asHtml(original.text)}</div>`,
    };
  }
  const header = `Le ${swissDateTime(original.date)}, ${who(original.from)} a écrit :`;
  return {
    text: header + "\n" + original.text.split("\n").map((line) => "> " + line).join("\n"),
    html: `<div class="gmail_quote"><div class="gmail_attr">${W.escapeHtml(header)}<br></div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${asHtml(original.text)}</blockquote></div>`,
  };
}

// Addresses typed by the person: "a@b.ch, Jean <c@d.ch>; e@f.ch".
function addressesFrom(value, label) {
  const list = mailer
    .addressList(value)
    .map((a) => (a.match(/<([^<>]+)>\s*$/)?.[1] || a).trim())
    .filter(Boolean);
  const bad = list.find((a) => !mailer.validEmail(a));
  if (bad) D.fail(`Adresse e-mail invalide (${label}) : ${bad.slice(0, 80)}`);
  return [...new Map(list.map((a) => [a.toLowerCase(), a])).values()];
}

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
        const settings = await MS.getSettings(db, box.companies[0]).catch(() => null);
        out.push({ id: box.id, label: box.label, address: box.address, companies: box.companies, unread: W.unreadOf(box), signature: signatureFor(req.user, box, settings) });
      }
      res.json({ mailboxes: out, canManage: groupAdmin(req.user), configured: W.mailboxes(state).length > 0 });
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

  // New message, reply, reply to all or forward, sent from the mailbox's Gmail account.
  r.post(
    "/:box/send",
    wrap(async (req, res) => {
      const { state, box } = await open(req);
      const b = req.body || {};
      const to = addressesFrom(b.to, "destinataire");
      const cc = addressesFrom(b.cc, "copie");
      const bcc = addressesFrom(b.bcc, "copie cachée");
      if (!to.length) D.fail("Indiquez au moins un destinataire.");
      if (to.length + cc.length + bcc.length > 50) D.fail("50 destinataires au maximum.");
      const subject = String(b.subject || "").replace(/[\r\n]+/g, " ").trim().slice(0, 250);
      const message = String(b.text || "").replace(/\r/g, "").slice(0, 100000);
      if (!subject && !message.trim()) D.fail("Écrivez un objet ou un message.");
      const mode = ["reply", "replyAll", "forward"].includes(b.mode) ? b.mode : "new";
      const ref = b.ref && typeof b.ref === "object" ? b.ref : null;
      const original = mode !== "new" && ref ? await W.messageView(box, ref.folder, ref.uid) : null;
      if (mode !== "new" && !original) D.fail("Message d’origine introuvable.", 404);

      const uploads = Array.isArray(b.uploads) ? b.uploads : [];
      if (uploads.length > 10) D.fail("10 fichiers ajoutés au maximum.");
      const attachments = [];
      let total = 0;
      for (const u of uploads) {
        const content = Buffer.from(String(u?.data || ""), "base64");
        if (!content.length) D.fail("Un fichier ajouté est vide.");
        total += content.length;
        if (total > MAX_ATTACHMENTS) D.fail("Pièces jointes : 18 Mo au maximum au total (limite de Gmail).", 413);
        const type = String(u?.type || "").toLowerCase();
        attachments.push({
          filename: String(u?.name || "fichier").replace(/[\r\n"\\/]+/g, "_").slice(0, 150) || "fichier",
          content,
          contentType: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) ? type : "application/octet-stream",
        });
      }
      if (mode === "forward") {
        const wanted = Array.isArray(b.forwardParts) ? b.forwardParts.map(String) : original.attachments.map((a) => a.part);
        const parts = original.attachments.map((a) => a.part).filter((p) => wanted.includes(p));
        attachments.push(...(await W.attachmentsFor(box, ref.folder, ref.uid, parts, MAX_ATTACHMENTS - total)));
      }
      checkSendRate(req.user.id);

      const quote = mode !== "new" && b.quote !== false ? quoteOf(original, mode) : { text: "", html: "" };
      const text = message + (quote.text ? "\n\n" + quote.text : "");
      const html =
        `<div dir="ltr" style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2328">${asHtml(message)}</div>` +
        (quote.html ? "<br>" + quote.html : "");
      const references = original ? [...original.references, original.messageId].filter(Boolean) : [];
      const recipients = [...to, ...cc].map((a) => a.toLowerCase());
      const client = (state.clients || []).find((c) => !c.deletedAt && recipients.includes(String(c.email || "").trim().toLowerCase()));
      const info = await require("./mail-routes").sendLogged(
        db,
        { kind: "webmail", company: box.companies[0], entityType: client ? "clients" : null, entityId: client ? client.id : null, createdBy: req.user.id },
        {
          to: to.join(", "),
          cc,
          bcc,
          subject,
          text,
          html,
          attachments,
          company: companyRef(state, box.companies[0]),
          fromName: box.own ? box.names[0] : "",
          replyTo: box.address,
          inReplyTo: original?.messageId || "",
          references,
        },
      );
      if (original && mode !== "forward") await W.markAnswered(box, ref.folder, ref.uid);
      res.json({ ok: true, messageId: info?.messageId || "" });
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

module.exports = { routes, checkNewMail, quoteOf, signatureFor, addressesFrom };
