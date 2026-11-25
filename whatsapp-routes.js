"use strict";
// Routes of the « WhatsApp » page (/api/whatsapp): linking the number (administrators of the
// group), who may open it, conversations and messages stored by whatsapp.js, sending (10 seconds
// to cancel, or a time chosen), quick replies, the assistant, filing in documents, reminders.
const express = require("express");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const D = require("./domain");
const { auth } = require("./auth-middleware");
const { loadState } = require("./db");
const W = require("./whatsapp");
const C = require("./webmail-compose");

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const A = W.ACCOUNT;
const SNIPPETS = "wa:" + A; // quick replies share the table of the mailbox ones
const MAX_FILES = 18 * 1024 * 1024;
const groupAdmin = (user) => user?.role === "admin" && user?.company === "group";
const validJid = (jid) => /^[0-9A-Za-z.:_-]{3,80}@(s\.whatsapp\.net|g\.us|lid)$/.test(String(jid || ""));
const printable = (text) => String(text || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");

// Name shown for a conversation: the saved contact, the name the person gave, the number.
const NAME_SQL = `COALESCE(NULLIF(w.name,''), NULLIF(k.name,''), NULLIF(k.notify,''))`;

function chatView(row) {
  return {
    jid: row.jid,
    name: row.display || W.phoneOf(row.jid) || (W.isGroup(row.jid) ? "Groupe" : "Contact"),
    phone: W.phoneOf(row.jid),
    group: !!row.is_group,
    unread: Number(row.unread) || 0,
    lastAt: row.last_at ? new Date(row.last_at).toISOString() : null,
    lastText: row.last_text || "",
    lastFromMe: !!row.last_from_me,
    archived: !!row.archived,
    muted: !!(row.muted_until && new Date(row.muted_until) > new Date()),
    snoozedUntil: row.snoozed_until && new Date(row.snoozed_until) > new Date() ? new Date(row.snoozed_until).toISOString() : null,
  };
}

function messageView(row, names) {
  let reactions = {};
  try {
    reactions = JSON.parse(row.reactions || "{}");
  } catch {
    reactions = {};
  }
  return {
    id: row.id,
    fromMe: !!row.from_me,
    sender: row.sender,
    senderName: row.from_me ? "Moi" : names.get(row.sender) || row.sender_name || W.phoneOf(row.sender) || "",
    at: new Date(row.at).toISOString(),
    kind: row.kind,
    body: row.deleted ? "" : row.body || "",
    mime: row.media_mime,
    fileName: row.media_name,
    size: row.media_size ? Number(row.media_size) : null,
    thumb: row.deleted ? null : row.thumb,
    quotedId: row.quoted_id,
    quotedText: row.quoted_text,
    status: row.status,
    deleted: !!row.deleted,
    edited: !!row.edited,
    reactions: Object.values(reactions),
  };
}

const swissDateTime = (iso) =>
  new Date(iso).toLocaleString("fr-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

// A conversation as a PDF (the « Classer » button).
function transcriptPdf(chat, messages) {
  const PDFDocument = require("pdfkit");
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: "A4", margin: 56, info: { Title: printable("WhatsApp " + chat.name), Creator: "Sousa Group One" } });
    const chunks = [];
    pdf.on("data", (c) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
    pdf.registerFont("regular", path.join(__dirname, "assets/fonts/LiberationSans-Regular.ttf"));
    pdf.registerFont("bold", path.join(__dirname, "assets/fonts/LiberationSans-Bold.ttf"));
    const width = pdf.page.width - 112;
    pdf.font("regular").fontSize(9).fillColor("#5b6779").text(printable(`WhatsApp · ${W.LABEL}`), { width });
    pdf.moveDown(0.5);
    pdf.font("bold").fontSize(15).fillColor("#1f2a37").text(printable(chat.name + (chat.phone ? " · " + chat.phone : "")), { width });
    pdf.font("regular").fontSize(9).fillColor("#5b6779").text(printable(`${messages.length} messages, du ${swissDateTime(messages[0].at)} au ${swissDateTime(messages.at(-1).at)}`), { width });
    pdf.moveDown(0.8);
    for (const m of messages) {
      const label = m.kind === "text" ? "" : `[${W.KIND_LABEL[m.kind] || "Message"}${m.fileName ? " : " + m.fileName : ""}] `;
      pdf.font("bold").fontSize(9.5).fillColor(m.fromMe ? "#283f61" : "#1f2a37").text(printable(`${m.senderName || (m.fromMe ? "Moi" : chat.name)} · ${swissDateTime(m.at)}`), { width });
      pdf.font("regular").fontSize(10.5).fillColor("#1f2a37").text(printable(m.deleted ? "(message supprimé)" : label + (m.body || "")), { width, lineGap: 1.5 });
      pdf.moveDown(0.5);
    }
    pdf.end();
  });
}

const sendTimes = new Map();
function checkSendRate(userId) {
  const now = Date.now();
  const recent = (sendTimes.get(userId) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length >= 120) D.fail("Limite atteinte : 120 messages WhatsApp par heure depuis l’application.", 429);
  recent.push(now);
  sendTimes.set(userId, recent);
}

function routes(db) {
  const r = express.Router();
  r.use(auth(db));
  const stateOf = async () => (await loadState(db)).data;
  const open = async (req) => {
    if (!(await W.canOpen(db, req.user))) D.fail("Accès non autorisé à WhatsApp.", 403);
  };
  const chatOf = async (req) => {
    await open(req);
    const jid = String(req.params.jid || "");
    if (!validJid(jid)) D.fail("Conversation introuvable.", 404);
    const row = (
      await db.query(
        `SELECT w.*, ${NAME_SQL} AS display FROM whatsapp_chats w
         LEFT JOIN whatsapp_contacts k ON k.account=w.account AND k.jid=w.jid
         WHERE w.account=$1 AND w.jid=$2`,
        [A, jid],
      )
    ).rows[0];
    if (!row) D.fail("Conversation introuvable.", 404);
    return { jid, chat: chatView(row) };
  };
  const namesOf = async (jids) => {
    const list = [...new Set(jids.filter(Boolean))];
    if (!list.length) return new Map();
    const rows = (await db.query("SELECT jid,name,notify FROM whatsapp_contacts WHERE account=$1 AND jid = ANY($2::text[])", [A, list])).rows;
    return new Map(rows.map((r) => [r.jid, r.name || r.notify || ""]));
  };

  r.get(
    "/status",
    wrap(async (req, res) => {
      const access = await W.canOpen(db, req.user);
      if (!access) return res.json({ access: false });
      const status = W.status();
      const manage = groupAdmin(req.user);
      let qrSvg = "";
      if (manage && status.qr) qrSvg = await require("qrcode").toString(status.qr, { type: "svg", margin: 1, errorCorrectionLevel: "L" });
      const unread = Number((await db.query("SELECT COALESCE(SUM(unread),0)::int AS n FROM whatsapp_chats WHERE account=$1 AND archived=false AND (snoozed_until IS NULL OR snoozed_until <= NOW())", [A])).rows[0].n);
      res.json({
        access: true,
        canManage: manage,
        label: W.LABEL,
        unread,
        undoSeconds: C.undoSeconds(),
        status: status.status,
        connected: status.connected,
        me: status.me,
        error: status.error,
        history: status.history,
        // The QR code and the pairing code give access to the account: administrators only.
        qrSvg,
        pairingCode: manage ? status.pairingCode : "",
      });
    }),
  );

  r.post(
    "/link",
    wrap(async (req, res) => {
      if (!groupAdmin(req.user)) D.fail("Seuls les administrateurs du groupe relient WhatsApp.", 403);
      if (W.status().connected) D.fail("WhatsApp est déjà relié. Déliez-le d’abord pour en relier un autre.", 409);
      const phone = req.body?.method === "code" ? String(req.body?.phone || "").replace(/\D/g, "").replace(/^00/, "") : "";
      if (req.body?.method === "code" && !/^\d{8,15}$/.test(phone)) D.fail("Indiquez le numéro avec l’indicatif du pays, par exemple 41791234567.");
      await W.start(db, { fresh: true, phone });
      await db.query("INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)", [req.user.email || "", "whatsapp.link", JSON.stringify({ method: phone ? "code" : "qr" })]);
      res.json({ ok: true });
    }),
  );

  r.post(
    "/unlink",
    wrap(async (req, res) => {
      if (!groupAdmin(req.user)) D.fail("Seuls les administrateurs du groupe délient WhatsApp.", 403);
      await W.unlink(db);
      await db.query("INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)", [req.user.email || "", "whatsapp.unlink", "{}"]);
      res.json({ ok: true });
    }),
  );

  r.get(
    "/access",
    wrap(async (req, res) => {
      if (!groupAdmin(req.user)) D.fail("Accès non autorisé.", 403);
      const state = await stateOf();
      const users = (await db.query("SELECT id,name,email,role,company FROM users WHERE disabled=false AND deleted_at IS NULL AND role<>'client' ORDER BY name")).rows;
      const granted = new Set((await db.query("SELECT user_id FROM whatsapp_access WHERE account=$1", [A])).rows.map((g) => Number(g.user_id)));
      res.json({
        users: users.map((u) => ({
          id: u.id,
          name: u.name,
          role: u.role,
          company: u.company === "group" ? "Sousa Group" : (state.companies || []).find((c) => D.same(c.id, u.company))?.name || u.company,
          granted: granted.has(Number(u.id)),
          automatic: W.automaticAccess(u),
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
      if (target.role === "client") D.fail("Un compte client ne peut pas ouvrir le WhatsApp de l’entreprise.");
      if (req.body?.granted) await db.query("INSERT INTO whatsapp_access(user_id,account,granted_by) VALUES($1,$2,$3) ON CONFLICT(user_id,account) DO NOTHING", [userId, A, req.user.id]);
      else await db.query("DELETE FROM whatsapp_access WHERE user_id=$1 AND account=$2", [userId, A]);
      await db.query("INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)", [req.user.email || "", "whatsapp.access", JSON.stringify({ user: target.email, granted: !!req.body?.granted })]);
      res.json({ ok: true });
    }),
  );

  // Conversations, newest first. filter: all | unread | groups | archived | snoozed
  r.get(
    "/chats",
    wrap(async (req, res) => {
      await open(req);
      const filter = String(req.query.filter || "all");
      const q = String(req.query.q || "").trim().slice(0, 100);
      const offset = Math.max(0, Math.min(5000, Number.parseInt(req.query.offset, 10) || 0));
      const where = ["w.account=$1", "w.last_at IS NOT NULL"];
      const params = [A];
      const snoozed = "(w.snoozed_until IS NOT NULL AND w.snoozed_until > NOW())";
      if (filter === "archived") where.push("w.archived=true");
      else if (filter === "snoozed") where.push(snoozed);
      else {
        where.push("w.archived=false", "NOT " + snoozed);
        if (filter === "unread") where.push("w.unread > 0");
        if (filter === "groups") where.push("w.is_group=true");
      }
      if (q) {
        params.push("%" + q.toLowerCase().replace(/[\\%_]/g, (ch) => "\\" + ch) + "%");
        const digits = q.replace(/\D/g, "");
        params.push(digits.length >= 4 ? "%" + digits + "%" : "-no-digits-");
        where.push(
          `(lower(${NAME_SQL}) LIKE $2 OR w.jid LIKE $3 OR EXISTS (SELECT 1 FROM whatsapp_messages m WHERE m.account=w.account AND m.jid=w.jid AND m.deleted=false AND lower(m.body) LIKE $2))`,
        );
      }
      params.push(offset);
      const rows = (
        await db.query(
          `SELECT w.*, ${NAME_SQL} AS display FROM whatsapp_chats w
           LEFT JOIN whatsapp_contacts k ON k.account=w.account AND k.jid=w.jid
           WHERE ${where.join(" AND ")}
           ORDER BY w.last_at DESC LIMIT 61 OFFSET $${params.length}`,
          params,
        )
      ).rows;
      res.json({ chats: rows.slice(0, 60).map(chatView), more: rows.length > 60 });
    }),
  );

  r.get(
    "/chats/:jid/messages",
    wrap(async (req, res) => {
      const { jid, chat } = await chatOf(req);
      const before = req.query.before ? new Date(req.query.before) : null;
      const rows = (
        await db.query(
          `SELECT * FROM whatsapp_messages WHERE account=$1 AND jid=$2 ${before && !Number.isNaN(before.getTime()) ? "AND at < $3" : ""} ORDER BY at DESC, seq DESC LIMIT 61`,
          before && !Number.isNaN(before.getTime()) ? [A, jid, before] : [A, jid],
        )
      ).rows;
      const page = rows.slice(0, 60).reverse();
      const names = await namesOf(page.map((m) => m.sender));
      res.json({ chat, messages: page.map((m) => messageView(m, names)), more: rows.length > 60 });
    }),
  );

  r.post(
    "/chats/:jid/read",
    wrap(async (req, res) => {
      const { jid } = await chatOf(req);
      await W.markRead(db, jid);
      res.json({ ok: true });
    }),
  );

  // Archived or unread in the application only: WhatsApp on the phone is left as it is.
  r.post(
    "/chats/:jid/state",
    wrap(async (req, res) => {
      const { jid } = await chatOf(req);
      if (typeof req.body?.archived === "boolean") await db.query("UPDATE whatsapp_chats SET archived=$3 WHERE account=$1 AND jid=$2", [A, jid, req.body.archived]);
      if (req.body?.unread === true) await db.query("UPDATE whatsapp_chats SET unread=GREATEST(unread,1) WHERE account=$1 AND jid=$2", [A, jid]);
      res.json({ ok: true });
    }),
  );

  r.get(
    "/media/:jid/:id",
    wrap(async (req, res) => {
      await open(req);
      const jid = String(req.params.jid || "");
      if (!validJid(jid)) D.fail("Fichier introuvable.", 404);
      const file = await W.media(db, jid, String(req.params.id || "").slice(0, 100));
      const inline = req.query.download !== "1" && file.viewable;
      const ascii = String(file.name).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]|["\\]/g, "_");
      res.set({
        "Content-Type": inline ? file.mime : "application/octet-stream",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "Content-Length": String(file.content.length),
        "Cache-Control": "private, max-age=3600",
      });
      res.end(file.content);
    }),
  );

  // Writing: checked now, sent after the 10 seconds to cancel or at the time chosen.
  async function prepare(req, jid) {
    const state = await stateOf();
    const b = req.body || {};
    const text = String(b.text || "").replace(/\r/g, "").slice(0, 60000);
    const files = [];
    const uploads = Array.isArray(b.uploads) ? b.uploads : [];
    if (uploads.length > 10) D.fail("10 fichiers au maximum.");
    for (const u of uploads) {
      const data = String(u?.data || "");
      if (!data || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) D.fail("Un fichier ajouté est vide ou illisible.");
      const type = String(u?.type || "").toLowerCase();
      files.push({ name: String(u?.name || "fichier").replace(/[\r\n"\\/]+/g, "_").slice(0, 150) || "fichier", type: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) ? type : "application/octet-stream", data });
    }
    files.push(...(await C.appFiles(db, state, req.user, b.appFiles)));
    if (files.reduce((n, f) => n + Math.floor((f.data.length * 3) / 4), 0) > MAX_FILES) D.fail("Fichiers : 18 Mo au maximum au total.", 413);
    if (!text.trim() && !files.length) D.fail("Écrivez un message ou joignez un fichier.");
    const quotedId = b.quotedId ? String(b.quotedId).slice(0, 100) : "";
    if (quotedId && !(await db.query("SELECT 1 FROM whatsapp_messages WHERE account=$1 AND jid=$2 AND id=$3", [A, jid, quotedId])).rows[0]) D.fail("Le message cité est introuvable.", 404);
    return { jid, text, files, quotedId, userId: req.user.id };
  }

  async function queue(req, payload, sendAt) {
    const id = randomUUID();
    const scheduled = !!sendAt;
    const at = scheduled ? sendAt : new Date(Date.now() + C.undoSeconds() * 1000);
    const preview = (payload.text.trim() || payload.files.map((f) => f.name).join(", ")).replace(/\s+/g, " ").slice(0, 200);
    await db.query(
      "INSERT INTO whatsapp_outbox(id,account,jid,user_id,kind,status,send_at,preview,payload) VALUES($1,$2,$3,$4,$5,'scheduled',$6,$7,$8)",
      [id, A, payload.jid, req.user.id, scheduled ? "scheduled" : "undo", at, preview, JSON.stringify(payload)],
    );
    if (!scheduled) {
      const timer = setTimeout(() => processOutbox(db, { id }).catch(() => {}), Math.max(0, at.getTime() - Date.now()) + 50);
      timer.unref?.();
    }
    return { id, sendAt: at.toISOString(), kind: scheduled ? "scheduled" : "undo" };
  }

  function sendAtOf(value) {
    if (!value) return null;
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) D.fail("Date d’envoi invalide.");
    if (at.getTime() < Date.now() + 60 * 1000) D.fail("Choisissez un moment dans le futur pour l’envoi programmé.");
    if (at.getTime() > Date.now() + 366 * 86400000) D.fail("Un envoi se programme au plus un an à l’avance.");
    return at;
  }

  r.post(
    "/chats/:jid/send",
    wrap(async (req, res) => {
      const { jid } = await chatOf(req);
      const sendAt = sendAtOf(req.body?.sendAt);
      const payload = await prepare(req, jid);
      checkSendRate(req.user.id);
      if (!sendAt && !C.undoSeconds()) {
        const ids = await W.sendToChat(db, jid, payload);
        return res.json({ ok: true, sent: true, ids });
      }
      res.json({ ok: true, sent: false, ...(await queue(req, payload, sendAt)) });
    }),
  );

  // A new conversation with a number (one person at a time: no mass sending).
  r.post(
    "/new",
    wrap(async (req, res) => {
      await open(req);
      let digits = String(req.body?.phone || "").replace(/\D/g, "");
      if (digits.startsWith("00")) digits = digits.slice(2);
      else if (/^0\d{9}$/.test(digits)) digits = "41" + digits.slice(1);
      if (!/^\d{8,15}$/.test(digits)) D.fail("Numéro invalide : indiquez-le avec l’indicatif, par exemple +41 79 123 45 67.");
      const jid = digits + "@s.whatsapp.net";
      await db.query("INSERT INTO whatsapp_chats(account,jid,is_group,last_at) VALUES($1,$2,false,NOW()) ON CONFLICT(account,jid) DO NOTHING", [A, jid]);
      if (req.body?.name) await db.query("INSERT INTO whatsapp_contacts(account,jid,name) VALUES($1,$2,$3) ON CONFLICT(account,jid) DO UPDATE SET name=COALESCE(whatsapp_contacts.name,EXCLUDED.name)", [A, jid, String(req.body.name).slice(0, 120)]);
      res.json({ ok: true, jid });
    }),
  );

  r.get(
    "/outbox",
    wrap(async (req, res) => {
      await open(req);
      const rows = (
        await db.query(
          `SELECT o.id,o.jid,o.kind,o.status,o.send_at,o.preview,o.error,o.user_id,u.name AS user_name, ${NAME_SQL} AS display
           FROM whatsapp_outbox o LEFT JOIN users u ON u.id=o.user_id
           LEFT JOIN whatsapp_chats w ON w.account=o.account AND w.jid=o.jid
           LEFT JOIN whatsapp_contacts k ON k.account=o.account AND k.jid=o.jid
           WHERE o.account=$1 AND ((o.status='scheduled' AND o.kind='scheduled') OR (o.status='failed' AND o.created_at > NOW() - INTERVAL '7 days'))
           ORDER BY o.send_at LIMIT 200`,
          [A],
        )
      ).rows;
      res.json({
        messages: rows.map((o) => ({ id: o.id, jid: o.jid, chat: o.display || W.phoneOf(o.jid), status: o.status, sendAt: new Date(o.send_at).toISOString(), preview: o.preview, error: o.error, by: o.user_name || "" })),
      });
    }),
  );

  r.get(
    "/outbox/:id",
    wrap(async (req, res) => {
      await open(req);
      const row = (await db.query("SELECT id,status,error,send_at FROM whatsapp_outbox WHERE id=$1 AND account=$2", [req.params.id, A])).rows[0];
      if (!row) D.fail("Envoi introuvable.", 404);
      res.json({ id: row.id, status: row.status, error: row.error, sendAt: new Date(row.send_at).toISOString() });
    }),
  );

  r.post(
    "/outbox/:id/cancel",
    wrap(async (req, res) => {
      await open(req);
      const row = (
        await db.query("UPDATE whatsapp_outbox SET status='cancelled' WHERE id=$1 AND account=$2 AND status IN ('scheduled','failed') AND payload IS NOT NULL AND (user_id=$3 OR $4) RETURNING *", [
          req.params.id,
          A,
          req.user.id,
          groupAdmin(req.user),
        ])
      ).rows[0];
      if (!row) {
        const current = (await db.query("SELECT status FROM whatsapp_outbox WHERE id=$1 AND account=$2", [req.params.id, A])).rows[0];
        if (current?.status === "sent" || current?.status === "sending") D.fail("Trop tard : le message est déjà parti.", 409);
        D.fail("Envoi introuvable.", 404);
      }
      const payload = JSON.parse(row.payload);
      res.json({ ok: true, jid: row.jid, text: payload.text, files: payload.files.map((f) => f.name) });
    }),
  );

  // Quick replies (plain text, WhatsApp formatting with *gras* _italique_).
  r.get(
    "/snippets",
    wrap(async (req, res) => {
      await open(req);
      const rows = (await db.query("SELECT id,title,body FROM webmail_snippets WHERE mailbox=$1 ORDER BY lower(title) LIMIT 100", [SNIPPETS])).rows;
      res.json({ snippets: rows.map((s) => ({ id: s.id, title: s.title, text: s.body })) });
    }),
  );
  r.post(
    "/snippets",
    wrap(async (req, res) => {
      await open(req);
      const title = String(req.body?.title || "").replace(/\s+/g, " ").trim().slice(0, 80);
      const text = String(req.body?.text || "").replace(/\r/g, "").trim().slice(0, 5000);
      if (!title) D.fail("Donnez un nom à la réponse rapide.");
      if (!text) D.fail("Écrivez le texte de la réponse rapide.");
      const id = String(req.body?.id || "");
      if (id) {
        const done = (await db.query("UPDATE webmail_snippets SET title=$3,body=$4,updated_at=NOW() WHERE id=$1 AND mailbox=$2 RETURNING id", [id, SNIPPETS, title, text])).rows[0];
        if (!done) D.fail("Réponse rapide introuvable.", 404);
        return res.json({ ok: true, id });
      }
      if (Number((await db.query("SELECT COUNT(*)::int AS n FROM webmail_snippets WHERE mailbox=$1", [SNIPPETS])).rows[0].n) >= 100) D.fail("100 réponses rapides au maximum.");
      const created = randomUUID();
      await db.query("INSERT INTO webmail_snippets(id,mailbox,title,body,created_by) VALUES($1,$2,$3,$4,$5)", [created, SNIPPETS, title, text, req.user.id]);
      res.json({ ok: true, id: created });
    }),
  );
  r.post(
    "/snippets/:id/delete",
    wrap(async (req, res) => {
      await open(req);
      await db.query("DELETE FROM webmail_snippets WHERE id=$1 AND mailbox=$2", [req.params.id, SNIPPETS]);
      res.json({ ok: true });
    }),
  );

  // Assistant: summary of the conversation, or a reply to check before sending.
  r.post(
    "/chats/:jid/ai",
    wrap(async (req, res) => {
      const { jid, chat } = await chatOf(req);
      const p3 = require("./p3-intelligence-routes");
      if (!p3.aiConfigured()) D.fail("L’assistant IA n’est pas configuré sur le serveur.", 503);
      const mode = req.body?.mode === "reply" ? "reply" : "summary";
      const rows = (await db.query("SELECT * FROM whatsapp_messages WHERE account=$1 AND jid=$2 AND deleted=false ORDER BY at DESC, seq DESC LIMIT 40", [A, jid])).rows.reverse();
      if (!rows.length) D.fail("Aucun message dans cette conversation.");
      const names = await namesOf(rows.map((m) => m.sender));
      const lines = rows.map((m) => {
        const v = messageView(m, names);
        const label = v.kind === "text" ? "" : `[${W.KIND_LABEL[v.kind] || "Message"}${v.fileName ? " : " + v.fileName : ""}] `;
        return `${swissDateTime(v.at)} · ${v.fromMe ? "Nous" : v.senderName || chat.name} : ${label}${v.body}`.slice(0, 1200);
      });
      let transcript = lines.join("\n");
      if (transcript.length > 14000) transcript = transcript.slice(-14000);
      const state = await stateOf();
      const view = D.viewState(state, req.user);
      const key = W.phoneKey(chat.phone);
      const client = key ? (view.clients || []).find((c) => !c.deletedAt && W.phoneKey(c.phone) === key) : null;
      let facts = "";
      if (client) {
        const money = (n) => "CHF " + (Number(n) || 0).toFixed(2);
        const unpaid = (view.invoices || []).filter((i) => D.same(i.clientId, client.id) && !i.deletedAt && !i.archivedAt && !["Payée", "Brouillon"].includes(i.status) && (Number(i.amount) || 0) - (Number(i.paid) || 0) > 0.004);
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
          ? `Tu es l’assistant du groupe Sousa (entreprises suisses). Tu rédiges la réponse WhatsApp de ${req.user.name || "l’utilisateur"} au dernier message reçu de cette conversation. ` +
            "Règles : réponds dans la langue du dernier message reçu ; ton cordial et court comme sur WhatsApp (2 à 5 phrases) ; vouvoiement sauf si l’interlocuteur tutoie ; " +
            "pas de signature ; texte brut (seuls *gras* et _italique_ de WhatsApp sont permis) ; n’invente jamais un prix, une date, un délai ou un engagement : si une information manque, écris [à compléter]."
          : `Tu résumes une conversation WhatsApp pour ${req.user.name || "l’utilisateur"} du groupe Sousa. Réponds en français, en texte brut : ` +
            "2 à 4 lignes commençant par « - » avec l’essentiel (qui demande quoi, montants, dates, lieux), puis une ligne « À faire : … » (ou « À faire : rien »). N’invente rien.";
      const user = (instruction ? `Consigne : ${instruction}\n\n` : "") + facts + `Conversation avec ${chat.name}${chat.group ? " (groupe)" : ""}, du plus ancien au plus récent :\n\n` + transcript;
      const out = await p3.meteredAi(db, req.user, mode === "reply" ? "whatsapp_reply" : "whatsapp_summary", { system, user, timeoutMs: 40000 });
      res.json({ mode, text: String(out || "").trim() });
    }),
  );

  // « Classer »: the conversation (PDF) and/or some of its files saved in a site's or client's documents.
  r.post(
    "/chats/:jid/file",
    wrap(async (req, res) => {
      const { jid, chat } = await chatOf(req);
      const b = req.body || {};
      const type = b.target?.type === "client" ? "client" : b.target?.type === "project" ? "project" : "";
      const targetId = String(b.target?.id || "");
      if (!type || !targetId) D.fail("Choisissez un chantier ou un client.");
      const days = Math.max(1, Math.min(3650, Number(b.days) || 30));
      const files = [];
      if (b.transcript !== false) {
        const rows = (await db.query("SELECT * FROM whatsapp_messages WHERE account=$1 AND jid=$2 AND at > NOW() - ($3 || ' days')::interval ORDER BY at, seq LIMIT 2000", [A, jid, String(days)])).rows;
        if (!rows.length) D.fail("Aucun message sur cette période.");
        const names = await namesOf(rows.map((m) => m.sender));
        const messages = rows.map((m) => messageView(m, names));
        const day = new Date().toISOString().slice(0, 10);
        files.push({ name: `WhatsApp ${chat.name} ${day}.pdf`.replace(/[\\/:*?"<>|\r\n\t]+/g, " ").slice(0, 150), mime: "application/pdf", content: await transcriptPdf(chat, messages) });
      }
      for (const id of (Array.isArray(b.ids) ? b.ids : []).slice(0, 10)) {
        const file = await W.media(db, jid, String(id).slice(0, 100));
        if (file.content.length > 10 * 1024 * 1024) D.fail(`« ${file.name} » dépasse 10 Mo.`, 413);
        files.push({ name: file.name.replace(/[\\/:*?"<>|\r\n\t]+/g, " ").slice(0, 150), mime: file.mime, content: file.content });
      }
      if (!files.length) D.fail("Choisissez la conversation ou au moins un fichier.");
      const storage = require("./storage");
      const { withStateWrite } = require("./p1-routes");
      const result = await withStateWrite(db, req.user.id, "whatsapp.file", async (c, data, actor) => {
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
            category: "WhatsApp",
            mime: f.mime,
            size: f.content.length,
          };
          if (!D.canDocument(data, actor, doc)) D.fail("Dossier non autorisé.", 403);
          await storage.saveFile(c, doc.id, f.content, f.mime);
          data.documents.push(doc);
          saved.push({ id: doc.id, name: doc.name });
        }
        return { data, changed: ["documents"], audit: { target: `${type}:${record.id}`, files: saved.length }, saved, targetName: record.title || record.name || "" };
      });
      res.json({ ok: true, saved: result.saved, target: result.targetName });
    }),
  );

  // « Me le rappeler »: the conversation leaves the list and comes back at the time chosen.
  r.post(
    "/chats/:jid/remind",
    wrap(async (req, res) => {
      const { jid } = await chatOf(req);
      const at = new Date(req.body?.at);
      if (Number.isNaN(at.getTime())) D.fail("Choisissez une date et une heure.");
      if (at.getTime() < Date.now() + 60 * 1000) D.fail("Choisissez un moment dans le futur.");
      if (at.getTime() > Date.now() + 366 * 86400000) D.fail("Un an au maximum.");
      await db.query("UPDATE whatsapp_reminders SET status='cancelled',done_at=NOW() WHERE account=$1 AND jid=$2 AND status='pending'", [A, jid]);
      const id = randomUUID();
      await db.query("INSERT INTO whatsapp_reminders(id,account,jid,user_id,remind_at,status) VALUES($1,$2,$3,$4,$5,'pending')", [id, A, jid, req.user.id, at]);
      await db.query("UPDATE whatsapp_chats SET snoozed_until=$3 WHERE account=$1 AND jid=$2", [A, jid, at]);
      res.json({ ok: true, id, remindAt: at.toISOString() });
    }),
  );

  r.post(
    "/chats/:jid/unsnooze",
    wrap(async (req, res) => {
      const { jid } = await chatOf(req);
      await db.query("UPDATE whatsapp_reminders SET status='cancelled',done_at=NOW() WHERE account=$1 AND jid=$2 AND status='pending'", [A, jid]);
      await db.query("UPDATE whatsapp_chats SET snoozed_until=NULL WHERE account=$1 AND jid=$2", [A, jid]);
      res.json({ ok: true });
    }),
  );

  return r;
}

// Messages due (end of the 10 seconds, or programmed) and reminders due.
async function processOutbox(db, { id = null, now = new Date() } = {}) {
  const result = { sent: 0, failed: 0 };
  if (!id) {
    await db.query("UPDATE whatsapp_outbox SET status='failed',error=$2 WHERE status='sending' AND send_at < $1", [new Date(now.getTime() - 15 * 60000), "Envoi interrompu par un redémarrage du serveur. Vérifiez la conversation avant de renvoyer."]);
    await db.query("DELETE FROM whatsapp_outbox WHERE status IN ('sent','cancelled','failed') AND created_at < $1", [new Date(now.getTime() - 30 * 86400000)]);
  }
  const due = (await db.query(`SELECT id FROM whatsapp_outbox WHERE status='scheduled' AND send_at <= $1${id ? " AND id=$2" : ""} ORDER BY send_at LIMIT 25`, id ? [now, id] : [now])).rows;
  for (const { id: rowId } of due) {
    const row = (await db.query("UPDATE whatsapp_outbox SET status='sending' WHERE id=$1 AND status='scheduled' RETURNING *", [rowId])).rows[0];
    if (!row) continue;
    try {
      const raw = (await db.query("SELECT * FROM users WHERE id=$1", [row.user_id])).rows[0];
      if (!raw || raw.disabled || raw.deleted_at) D.fail("Le compte qui a écrit ce message n’est plus actif.");
      const state = (await loadState(db)).data;
      if (!(await W.canOpen(db, D.effectiveUser(state, raw)))) D.fail("Ce compte n’a plus accès à WhatsApp.");
      await W.sendToChat(db, row.jid, JSON.parse(row.payload));
      await db.query("UPDATE whatsapp_outbox SET status='sent',sent_at=NOW(),payload=NULL,error=NULL WHERE id=$1", [row.id]);
      result.sent++;
    } catch (error) {
      const message = error?.expose || error?.status < 500 ? String(error.message) : "Le message WhatsApp n’a pas pu être envoyé.";
      await db.query("UPDATE whatsapp_outbox SET status='failed',error=$2 WHERE id=$1", [row.id, message.slice(0, 500)]);
      if (row.kind === "scheduled")
        await require("./messaging-routes")
          .notifyUsers(db, [Number(row.user_id)], { category: "system", title: "Message WhatsApp non envoyé", body: `${row.preview || ""} : ${message}`.slice(0, 300), url: `/?open=whatsapp&chat=${encodeURIComponent(row.jid)}` })
          .catch(() => {});
      result.failed++;
    }
  }
  return result;
}

async function processReminders(db, { now = new Date() } = {}) {
  let done = 0;
  const due = (await db.query("SELECT id FROM whatsapp_reminders WHERE status='pending' AND remind_at <= $1 ORDER BY remind_at LIMIT 50", [now])).rows;
  for (const { id } of due) {
    const row = (await db.query("UPDATE whatsapp_reminders SET status='done',done_at=NOW() WHERE id=$1 AND status='pending' RETURNING *", [id])).rows[0];
    if (!row) continue;
    await db.query("UPDATE whatsapp_chats SET snoozed_until=NULL,archived=false,unread=GREATEST(unread,1) WHERE account=$1 AND jid=$2", [row.account, row.jid]);
    const chat = (await db.query(`SELECT w.jid, ${NAME_SQL} AS display FROM whatsapp_chats w LEFT JOIN whatsapp_contacts k ON k.account=w.account AND k.jid=w.jid WHERE w.account=$1 AND w.jid=$2`, [row.account, row.jid])).rows[0];
    await require("./messaging-routes")
      .notifyUsers(db, [Number(row.user_id)], { category: "reminders", title: "Rappel WhatsApp : " + (chat?.display || W.phoneOf(row.jid) || "conversation"), body: "La conversation est revenue en haut de la liste.", url: `/?open=whatsapp&chat=${encodeURIComponent(row.jid)}` })
      .catch(() => {});
    done++;
  }
  return { done };
}

module.exports = { routes, processOutbox, processReminders, transcriptPdf };
