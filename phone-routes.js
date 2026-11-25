"use strict";
// « Téléphone »: each person's line (calls in the browser, history, summaries, SMS from an
// Android phone), and the administrators' settings (operator, relay, lines, announcement).
// The browsers reach the exchange through this server (/api/phone/sip, WebSocket), never
// directly: the connection is opened only with a pass signed for the signed-in person.
const express = require("express");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { createHmac, randomBytes, timingSafeEqual } = require("node:crypto");
const D = require("./domain");
const { auth } = require("./auth-middleware");
const T = require("./telephony");
const AI = require("./telephony-ai");
const SMS = require("./sms-gateway");

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const groupAdmin = (u) => !!u && u.role === "admin" && u.company === "group";
const staff = (u) => !!u && u.role !== "client";
const clean = (v, n = 200) => String(v ?? "").replace(/[\r\n\0]/g, " ").trim().slice(0, n);
const audit = (db, req, action, metadata = {}) =>
  db.query("INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)", [req.user?.email || "", action, JSON.stringify(metadata)]).catch(() => {});

// --- pass for the browser's connection to the exchange (12 hours) ---
const ticketKey = () => createHmac("sha256", "sgo-phone-ticket").update(process.env.JWT_SECRET || "").digest();
function ticketFor(userId, hours = 12) {
  const until = Math.floor(Date.now() / 1000) + hours * 3600;
  const body = `${Number(userId)}.${until}`;
  return body + "." + createHmac("sha256", ticketKey()).update(body).digest("base64url");
}
function ticketUser(ticket) {
  const [id, until, sig] = String(ticket || "").split(".");
  if (!id || !until || !sig) return 0;
  const expected = createHmac("sha256", ticketKey()).update(`${id}.${until}`).digest("base64url");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return 0;
  if (Number(until) < Date.now() / 1000) return 0;
  return Number(id) || 0;
}

// The browser's SIP-over-WebSocket connection, carried to the exchange as it is.
function attach(server) {
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://local");
    if (url.pathname !== "/api/phone/sip") return;
    const userId = ticketUser(url.searchParams.get("ticket"));
    if (!userId) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    const target = new URL(String(process.env.ASTERISK_ARI_URL || "http://host.docker.internal:8188"));
    const upstream = net.connect(Number(target.port || 80), target.hostname, () => {
      const keep = ["upgrade", "connection", "sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"];
      const headers = keep.filter((k) => req.headers[k]).map((k) => `${k}: ${req.headers[k]}`);
      upstream.write(`GET /ws HTTP/1.1\r\nHost: ${target.host}\r\n${headers.join("\r\n")}\r\nX-Forwarded-For: ${String(req.socket.remoteAddress || "")}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.setTimeout(0);
    socket.setTimeout(0);
    socket.setNoDelay?.(true);
    upstream.setNoDelay?.(true);
    const close = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on("error", close);
    socket.on("error", close);
    upstream.on("close", close);
    socket.on("close", close);
  });
}

// --- recordings sent by the browser (announcement, voicemail greeting): 8 kHz WAV, 2 minutes ---
function wavFromDataUrl(dataUrl) {
  const m = String(dataUrl || "").match(/^data:audio\/(?:wav|x-wav|wave);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) D.fail("Enregistrement invalide (WAV attendu).");
  const buffer = Buffer.from(m[1], "base64");
  let wav;
  try {
    wav = AI.readWav(buffer);
  } catch {
    D.fail("Enregistrement invalide.");
  }
  if (wav.rate !== 8000 || wav.channels !== 1 || wav.bits !== 16) D.fail("Enregistrement invalide (8 kHz mono attendu).");
  const seconds = wav.data.length / 16000;
  if (seconds < 1 || seconds > 120) D.fail("L’enregistrement doit durer entre 1 seconde et 2 minutes.");
  return buffer;
}
const soundFile = (name) => path.join(T.recordingDir(), name + ".wav");
function saveSound(name, buffer) {
  fs.mkdirSync(T.recordingDir(), { recursive: true });
  fs.writeFileSync(soundFile(name) + ".tmp", buffer);
  fs.renameSync(soundFile(name) + ".tmp", soundFile(name));
}
const hasSound = (name) => fs.existsSync(soundFile(name));

function iceServers(relay = {}) {
  const list = [];
  const stun = String(relay.stun || "stun:stun.l.google.com:19302");
  list.push({ urls: stun.startsWith("stun:") ? stun : "stun:" + stun });
  const turn = (relay.turnUrls || []).filter((u) => /^turns?:/i.test(u));
  if (turn.length && relay.turnUser) list.push({ urls: turn, username: relay.turnUser, credential: relay.turnPassword || "" });
  return list;
}

function callRow(r, { full = false } = {}) {
  const actions = r.actions && typeof r.actions === "object" ? r.actions : {};
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    userName: r.user_name || undefined,
    direction: r.direction,
    number: r.number,
    display: T.display(r.number),
    startedAt: r.started_at,
    answeredAt: r.answered_at,
    endedAt: r.ended_at,
    seconds: r.answered_at && r.ended_at ? Math.max(0, Math.round((new Date(r.ended_at) - new Date(r.answered_at)) / 1000)) : 0,
    status: r.status,
    recorded: !!r.recorded,
    hasRecording: !!r.recording,
    aiStatus: r.ai_status,
    aiError: r.ai_error || "",
    summary: r.summary || "",
    caller: actions.caller || {},
    actions: Array.isArray(actions.list) ? actions.list : [],
    clientId: r.client_id || "",
    callbackAt: r.callback_at,
    callbackNote: r.callback_note || "",
    seen: !!r.seen,
    ...(full ? { transcript: r.transcript || "" } : {}),
  };
}

function routes(db) {
  const r = express.Router();

  // Received SMS and status changes, sent by the phone itself (no session: the address holds a
  // secret made for that line, and a signature is checked when the phone signs).
  r.post(
    "/sms/hook/:token",
    express.raw({ type: "*/*", limit: "2mb" }),
    wrap(async (req, res) => {
      const token = clean(req.params.token, 80);
      const line = (await db.query("SELECT * FROM phone_lines WHERE sms_token=$1 AND sms_mode='android'", [token])).rows[0];
      if (!line) return res.status(404).json({ error: "Inconnu." });
      let secret = {};
      try {
        secret = JSON.parse(T.unseal(line.sms_secret) || "{}");
      } catch {
        secret = {};
      }
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ""));
      if (!SMS.validSignature(raw, req.headers, secret.signingKey || "")) return res.status(401).json({ error: "Signature invalide." });
      let body;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        return res.status(400).json({ error: "Format invalide." });
      }
      const { received, statuses } = SMS.readEvent(body, secret.passphrase || "");
      const fresh = [];
      for (const m of received) {
        const number = T.e164(m.number) || clean(m.number, 40);
        const out = await db.query(
          `INSERT INTO phone_sms(user_id,number,direction,body,at,status,external_id) VALUES($1,$2,'in',$3,$4,'received',$5)
           ON CONFLICT (user_id,external_id) WHERE external_id IS NOT NULL DO NOTHING RETURNING id`,
          [line.user_id, number, m.body, m.at, m.id ? "in:" + m.id : null],
        );
        if (out.rows.length) fresh.push({ number, body: m.body });
      }
      for (const s of statuses)
        await db.query("UPDATE phone_sms SET status=$3 WHERE user_id=$1 AND external_id=$2 AND status<>'delivered'", [line.user_id, "out:" + s.id, s.status]);
      await db.query("UPDATE phone_lines SET sms_status='ok' WHERE user_id=$1 AND COALESCE(sms_status,'')<>'ok'", [line.user_id]);
      for (const m of fresh) {
        const who = (await T.contactName(db, m.number)) || T.display(m.number);
        await require("./messaging-routes")
          .notifyUsers(db, [line.user_id], { category: "phone", title: "SMS · " + who, body: m.body.slice(0, 160), url: "/?open=phone&sms=" + encodeURIComponent(m.number), entityType: "phone-sms", entityId: m.number })
          .catch(() => {});
      }
      res.json({ ok: true });
    }),
  );

  r.use(auth(db));
  r.use(express.json({ limit: "4mb" }));
  const needStaff = (req) => {
    if (!staff(req.user)) D.fail("Accès non autorisé.", 403);
  };
  const needAdmin = (req) => {
    if (!groupAdmin(req.user)) D.fail("Seuls les administrateurs du groupe règlent le téléphone.", 403);
  };
  const lineOf = async (userId) => (await db.query("SELECT * FROM phone_lines WHERE user_id=$1", [userId])).rows[0] || null;
  const ownCall = async (req) => {
    needStaff(req);
    const row = (await db.query("SELECT * FROM phone_calls WHERE id=$1 AND user_id=$2", [Number(req.params.id) || 0, req.user.id])).rows[0];
    if (!row) D.fail("Appel introuvable.", 404);
    return row;
  };

  // --- the person's own line ---
  r.get(
    "/me",
    wrap(async (req, res) => {
      if (!staff(req.user)) return res.json({ access: false });
      const line = await lineOf(req.user.id);
      const relay = (await T.setting(db, "relay")) || {};
      const unseen = (
        await db.query(
          `SELECT (SELECT COUNT(*)::int FROM phone_calls WHERE user_id=$1 AND seen=false AND status IN ('missed','voicemail')) AS calls,
                  (SELECT COUNT(*)::int FROM phone_sms WHERE user_id=$1 AND seen=false AND direction='in') AS sms`,
          [req.user.id],
        )
      ).rows[0];
      res.json({
        access: true,
        canManage: groupAdmin(req.user),
        status: T.status(),
        line: line?.enabled
          ? {
              did: line.did || "",
              didDisplay: line.did ? T.display(line.did) : "",
              mobile: line.mobile || "",
              mobileDisplay: line.mobile ? T.display(line.mobile) : "",
              ringSeconds: line.ring_seconds,
              sms: { mode: line.sms_mode, status: line.sms_status || "" },
              greeting: hasSound("sgo-greeting-" + req.user.id),
            }
          : null,
        connection: line?.enabled
          ? { path: "/api/phone/sip?ticket=" + encodeURIComponent(ticketFor(req.user.id)), username: "sgo" + req.user.id, password: T.unseal(line.sip_secret), iceServers: iceServers(relay) }
          : null,
        recording: { announcement: hasSound("sgo-announce"), enabled: ((await T.setting(db, "recording")) || {}).enabled !== false },
        unseen,
      });
    }),
  );

  r.post(
    "/decline",
    wrap(async (req, res) => {
      needStaff(req);
      res.json({ declined: await T.decline(db, req.user.id) });
    }),
  );
  r.get(
    "/calls",
    wrap(async (req, res) => {
      needStaff(req);
      const filter = String(req.query.filter || "all");
      const where = { missed: "AND status IN ('missed','voicemail')", voicemail: "AND status='voicemail'", summaries: "AND ai_status='done'", callbacks: "AND callback_at IS NOT NULL" }[filter] || "";
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const rows = (await db.query(`SELECT * FROM phone_calls WHERE user_id=$1 ${where} ORDER BY ${filter === "callbacks" ? "callback_at ASC" : "started_at DESC"} LIMIT 51 OFFSET $2`, [req.user.id, offset])).rows;
      res.json({ calls: rows.slice(0, 50).map((x) => callRow(x)), more: rows.length > 50 });
    }),
  );
  r.get(
    "/calls/:id",
    wrap(async (req, res) => res.json({ call: callRow(await ownCall(req), { full: true }) })),
  );
  r.post(
    "/calls/seen",
    wrap(async (req, res) => {
      needStaff(req);
      await db.query("UPDATE phone_calls SET seen=true WHERE user_id=$1 AND seen=false", [req.user.id]);
      res.json({ ok: true });
    }),
  );
  r.post(
    "/calls/:id/actions/:index",
    wrap(async (req, res) => {
      const row = await ownCall(req);
      const data = row.actions && typeof row.actions === "object" ? row.actions : {};
      const list = Array.isArray(data.list) ? data.list : [];
      const i = Number(req.params.index);
      if (!Number.isInteger(i) || !list[i]) D.fail("Proposition introuvable.", 404);
      const status = ["done", "dismissed", "pending"].includes(req.body?.status) ? req.body.status : "done";
      list[i] = { ...list[i], status, ...(req.body?.ref ? { ref: clean(req.body.ref, 80) } : {}) };
      await db.query("UPDATE phone_calls SET actions=$2 WHERE id=$1", [row.id, JSON.stringify({ ...data, list })]);
      res.json({ call: callRow({ ...row, actions: { ...data, list } }) });
    }),
  );
  r.post(
    "/calls/:id/summarize",
    wrap(async (req, res) => {
      const row = await ownCall(req);
      if (!row.recording) D.fail("Cet appel n’a pas d’enregistrement.");
      await db.query("UPDATE phone_calls SET ai_status='pending',ai_error=NULL WHERE id=$1", [row.id]);
      await AI.processCall(db, row.id);
      res.json({ call: callRow((await db.query("SELECT * FROM phone_calls WHERE id=$1", [row.id])).rows[0], { full: true }) });
    }),
  );
  r.post(
    "/calls/:id/callback",
    wrap(async (req, res) => {
      const row = await ownCall(req);
      const at = req.body?.at ? new Date(req.body.at) : null;
      if (at && (Number.isNaN(at.getTime()) || at < new Date(Date.now() - 60000))) D.fail("Choisissez un moment à venir.");
      await db.query("UPDATE phone_calls SET callback_at=$2,callback_note=$3 WHERE id=$1", [row.id, at, at ? clean(req.body?.note, 300) : null]);
      res.json({ ok: true });
    }),
  );
  r.get(
    "/calls/:id/recording",
    wrap(async (req, res) => {
      const row = await ownCall(req);
      const file = row.recording && soundFile(path.basename(row.recording));
      if (!file || !fs.existsSync(file)) D.fail("Enregistrement introuvable (supprimé après le délai de conservation).", 404);
      res.set("Content-Type", "audio/wav");
      res.set("Cache-Control", "private, no-store");
      fs.createReadStream(file).pipe(res);
    }),
  );
  r.delete(
    "/calls/:id/recording",
    wrap(async (req, res) => {
      const row = await ownCall(req);
      if (row.recording) fs.rmSync(soundFile(path.basename(row.recording)), { force: true });
      await db.query("UPDATE phone_calls SET recording=NULL WHERE id=$1", [row.id]);
      res.json({ ok: true });
    }),
  );
  r.post(
    "/greeting",
    wrap(async (req, res) => {
      needStaff(req);
      if (!(await lineOf(req.user.id))) D.fail("Aucune ligne n’est attribuée à votre compte.", 403);
      if (req.body?.remove) fs.rmSync(soundFile("sgo-greeting-" + req.user.id), { force: true });
      else saveSound("sgo-greeting-" + req.user.id, wavFromDataUrl(req.body?.audio));
      res.json({ ok: true, greeting: hasSound("sgo-greeting-" + req.user.id) });
    }),
  );

  // --- team summaries for the administrators (never the recordings nor the SMS) ---
  r.get(
    "/team",
    wrap(async (req, res) => {
      needAdmin(req);
      const rows = (
        await db.query(
          `SELECT c.*,u.name AS user_name FROM phone_calls c JOIN users u ON u.id=c.user_id
           WHERE c.ai_status='done' ORDER BY c.started_at DESC LIMIT 100`,
        )
      ).rows;
      res.json({ calls: rows.map((x) => ({ ...callRow(x), hasRecording: false })) });
    }),
  );

  // --- SMS ---
  r.get(
    "/sms",
    wrap(async (req, res) => {
      needStaff(req);
      const rows = (
        await db.query(
          `SELECT DISTINCT ON (number) number,body,at,direction,status,
                  (SELECT COUNT(*)::int FROM phone_sms s2 WHERE s2.user_id=s.user_id AND s2.number=s.number AND s2.seen=false AND s2.direction='in') AS unread
           FROM phone_sms s WHERE user_id=$1 ORDER BY number,at DESC`,
          [req.user.id],
        )
      ).rows.sort((a, b) => new Date(b.at) - new Date(a.at));
      const threads = [];
      for (const t of rows.slice(0, 200)) threads.push({ number: t.number, display: T.display(t.number), name: await T.contactName(db, t.number), last: t.body.slice(0, 120), at: t.at, fromMe: t.direction === "out", unread: t.unread });
      res.json({ threads });
    }),
  );
  r.get(
    "/sms/:number",
    wrap(async (req, res) => {
      needStaff(req);
      const number = T.e164(req.params.number) || clean(req.params.number, 40);
      const rows = (await db.query("SELECT * FROM phone_sms WHERE user_id=$1 AND number=$2 ORDER BY at DESC LIMIT 200", [req.user.id, number])).rows.reverse();
      await db.query("UPDATE phone_sms SET seen=true WHERE user_id=$1 AND number=$2 AND seen=false", [req.user.id, number]);
      res.json({ number, display: T.display(number), name: await T.contactName(db, number), messages: rows.map((m) => ({ id: Number(m.id), fromMe: m.direction === "out", body: m.body, at: m.at, status: m.status })) });
    }),
  );
  const smsTimes = new Map();
  r.post(
    "/sms/send",
    wrap(async (req, res) => {
      needStaff(req);
      const line = await lineOf(req.user.id);
      if (!line || line.sms_mode !== "android") D.fail("Les SMS ne sont pas reliés à votre téléphone.", 409);
      const number = T.e164(req.body?.number);
      if (!number) D.fail("Numéro invalide.");
      const text = String(req.body?.text || "").trim().slice(0, 1600);
      if (!text) D.fail("Le message est vide.");
      const now = Date.now();
      const recent = (smsTimes.get(req.user.id) || []).filter((t) => now - t < 60 * 60 * 1000);
      if (recent.length >= 60) D.fail("Limite atteinte : 60 SMS par heure depuis l’application.", 429);
      smsTimes.set(req.user.id, [...recent, now]);
      const secret = JSON.parse(T.unseal(line.sms_secret) || "{}");
      let sent;
      try {
        sent = await SMS.send(secret, number, text);
      } catch (error) {
        D.fail(error.message || "Le SMS n’a pas pu partir.", 502);
      }
      const row = (
        await db.query("INSERT INTO phone_sms(user_id,number,direction,body,status,external_id,seen) VALUES($1,$2,'out',$3,'pending',$4,true) RETURNING *", [req.user.id, number, text, sent.id ? "out:" + sent.id : null])
      ).rows[0];
      res.json({ message: { id: Number(row.id), fromMe: true, body: row.body, at: row.at, status: row.status } });
    }),
  );
  r.post(
    "/sms/setup",
    wrap(async (req, res) => {
      needStaff(req);
      const line = await lineOf(req.user.id);
      if (!line) D.fail("Aucune ligne n’est attribuée à votre compte. Demandez-la à un administrateur.", 403);
      const login = clean(req.body?.login, 120);
      const password = String(req.body?.password || "").slice(0, 200);
      if (!login || !password) D.fail("Indiquez l’utilisateur et le mot de passe affichés dans l’application Android.");
      const url = clean(req.body?.url, 300) || SMS.CLOUD_URL;
      if (!/^https:\/\//.test(url)) D.fail("L’adresse du serveur SMS doit commencer par https://.");
      const passphrase = req.body?.encrypted ? clean(req.body?.passphrase, 120) : "";
      if (req.body?.encrypted && passphrase.length < 12) D.fail("La phrase secrète doit faire au moins 12 caractères.");
      const base = String(process.env.APP_URL || process.env.WEBAUTHN_ORIGIN || "").replace(/\/+$/, "");
      if (!/^https:\/\//.test(base)) D.fail("Indiquez l’adresse publique de l’application (APP_URL) sur le serveur pour recevoir les SMS.", 503);
      const token = line.sms_token || SMS.newToken();
      const settings = { url, login, password, passphrase, signingKey: clean(req.body?.signingKey, 200) };
      let hooks;
      try {
        hooks = await SMS.register(settings, `${base}/api/phone/sms/hook/${token}`);
      } catch (error) {
        D.fail(error.message || "Le serveur SMS n’a pas accepté la liaison.", 502);
      }
      await db.query("UPDATE phone_lines SET sms_mode='android',sms_token=$2,sms_secret=$3,sms_status='linked',updated_at=NOW() WHERE user_id=$1", [req.user.id, token, T.seal(JSON.stringify({ ...settings, hooks }))]);
      await audit(db, req, "phone.sms.link", { encrypted: !!passphrase });
      res.json({ ok: true });
    }),
  );
  r.delete(
    "/sms/setup",
    wrap(async (req, res) => {
      needStaff(req);
      const line = await lineOf(req.user.id);
      if (line?.sms_mode === "android") {
        const secret = JSON.parse(T.unseal(line.sms_secret) || "{}");
        await SMS.unregister(secret, secret.hooks || []).catch(() => {});
      }
      await db.query("UPDATE phone_lines SET sms_mode='none',sms_secret=NULL,sms_status=NULL,updated_at=NOW() WHERE user_id=$1", [req.user.id]);
      await audit(db, req, "phone.sms.unlink");
      res.json({ ok: true });
    }),
  );
  r.get(
    "/sms-passphrase",
    wrap(async (req, res) => {
      needStaff(req);
      res.json({ passphrase: SMS.newPassphrase() });
    }),
  );

  // --- administrators: operator, relay, recordings, lines ---
  r.get(
    "/admin",
    wrap(async (req, res) => {
      needAdmin(req);
      const operator = (await T.setting(db, "operator")) || {};
      const relay = (await T.setting(db, "relay")) || {};
      const recording = (await T.setting(db, "recording")) || {};
      const lines = (
        await db.query(
          `SELECT l.*,u.name,u.email,u.role FROM phone_lines l JOIN users u ON u.id=l.user_id ORDER BY u.name`,
        )
      ).rows;
      const users = (await db.query("SELECT id,name,email,role,company FROM users WHERE disabled=false AND role<>'client' ORDER BY name")).rows;
      res.json({
        status: T.status(),
        operator: { host: operator.host || "", port: operator.port || "", username: operator.username || "", authUsername: operator.authUsername || "", fromUser: operator.fromUser || "", register: operator.register !== false, dialFormat: operator.dialFormat || "+", allowWorld: !!operator.allowWorld, hasPassword: !!operator.password },
        relay: { stun: relay.stun || "", turnUrls: relay.turnUrls || [], turnUser: relay.turnUser || "", hasPassword: !!relay.turnPassword },
        recording: { enabled: recording.enabled !== false, keepDays: Number(recording.keepDays) || 30, announcement: hasSound("sgo-announce"), greeting: hasSound("sgo-greeting") },
        lines: lines.map((l) => ({ userId: Number(l.user_id), name: l.name, email: l.email, role: l.role, did: l.did || "", mobile: l.mobile || "", ringSeconds: l.ring_seconds, enabled: l.enabled, sms: l.sms_mode })),
        users: users.map((u) => ({ id: Number(u.id), name: u.name, email: u.email, role: u.role })),
      });
    }),
  );
  r.put(
    "/admin/operator",
    wrap(async (req, res) => {
      needAdmin(req);
      const before = (await T.setting(db, "operator")) || {};
      const host = clean(req.body?.host, 200).replace(/^sips?:/i, "");
      if (host && !/^[A-Za-z0-9.-]+(:\d{2,5})?$/.test(host)) D.fail("Adresse du serveur de l’opérateur invalide (ex. sip.operateur.ch).");
      const port = req.body?.port ? Number(req.body.port) : "";
      if (port && !(port > 0 && port < 65536)) D.fail("Port invalide.");
      const username = clean(req.body?.username, 120);
      if (host && !username) D.fail("Indiquez l’identifiant SIP donné par l’opérateur.");
      const next = {
        host,
        port,
        username,
        authUsername: clean(req.body?.authUsername, 120),
        fromUser: clean(req.body?.fromUser, 120),
        password: req.body?.password ? String(req.body.password).slice(0, 200) : before.password || "",
        register: req.body?.register !== false,
        dialFormat: ["+", "00", "national"].includes(req.body?.dialFormat) ? req.body.dialFormat : "+",
        allowWorld: !!req.body?.allowWorld,
      };
      await T.saveSetting(db, "operator", next);
      await T.apply(db);
      await audit(db, req, "phone.operator", { host, username });
      res.json({ ok: true });
    }),
  );
  r.put(
    "/admin/relay",
    wrap(async (req, res) => {
      needAdmin(req);
      const before = (await T.setting(db, "relay")) || {};
      const urls = (Array.isArray(req.body?.turnUrls) ? req.body.turnUrls : String(req.body?.turnUrls || "").split(/[\s,]+/))
        .map((u) => clean(u, 200))
        .filter(Boolean);
      for (const u of urls) if (!/^turns?:[A-Za-z0-9.-]+(:\d{2,5})?(\?transport=(udp|tcp))?$/i.test(u)) D.fail("Adresse de relais invalide : " + u + " (ex. turn:relais.exemple.com:3478).");
      const stun = clean(req.body?.stun, 200);
      if (stun && !/^(stun:)?[A-Za-z0-9.-]+(:\d{2,5})?$/i.test(stun)) D.fail("Adresse STUN invalide.");
      await T.saveSetting(db, "relay", { stun, turnUrls: urls.slice(0, 6), turnUser: clean(req.body?.turnUser, 200), turnPassword: req.body?.turnPassword ? String(req.body.turnPassword).slice(0, 300) : before.turnPassword || "" });
      await T.apply(db);
      await audit(db, req, "phone.relay");
      res.json({ ok: true });
    }),
  );
  r.put(
    "/admin/recording",
    wrap(async (req, res) => {
      needAdmin(req);
      await T.saveSetting(db, "recording", { enabled: req.body?.enabled !== false, keepDays: Math.min(3650, Math.max(1, Number(req.body?.keepDays) || 30)) });
      await audit(db, req, "phone.recording", { enabled: req.body?.enabled !== false });
      res.json({ ok: true });
    }),
  );
  r.post(
    "/admin/sound/:kind",
    wrap(async (req, res) => {
      needAdmin(req);
      const name = { announcement: "sgo-announce", greeting: "sgo-greeting" }[req.params.kind];
      if (!name) D.fail("Inconnu.", 404);
      if (req.body?.remove) fs.rmSync(soundFile(name), { force: true });
      else saveSound(name, wavFromDataUrl(req.body?.audio));
      await audit(db, req, "phone.sound", { kind: req.params.kind, removed: !!req.body?.remove });
      res.json({ ok: true, present: hasSound(name) });
    }),
  );
  r.put(
    "/admin/lines/:userId",
    wrap(async (req, res) => {
      needAdmin(req);
      const userId = Number(req.params.userId);
      const user = (await db.query("SELECT id,role FROM users WHERE id=$1 AND disabled=false", [userId])).rows[0];
      if (!user || user.role === "client") D.fail("Compte introuvable.", 404);
      const did = req.body?.did ? T.e164(req.body.did) : "";
      if (req.body?.did && !did) D.fail("Numéro de la ligne invalide.");
      const mobile = req.body?.mobile ? T.e164(req.body.mobile) : "";
      if (req.body?.mobile && !mobile) D.fail("Numéro de mobile invalide.");
      if (did) {
        const taken = (await db.query("SELECT user_id FROM phone_lines WHERE did=$1 AND user_id<>$2", [did, userId])).rows[0];
        if (taken) D.fail("Ce numéro est déjà attribué à une autre personne.", 409);
      }
      const ring = Math.min(60, Math.max(10, Number(req.body?.ringSeconds) || 25));
      await db.query(
        `INSERT INTO phone_lines(user_id,did,mobile,sip_secret,ring_seconds,enabled) VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT(user_id) DO UPDATE SET did=EXCLUDED.did,mobile=EXCLUDED.mobile,ring_seconds=EXCLUDED.ring_seconds,enabled=EXCLUDED.enabled,updated_at=NOW()`,
        [userId, did || null, mobile || null, T.seal(randomBytes(24).toString("base64url")), ring, req.body?.enabled !== false],
      );
      await T.apply(db);
      await audit(db, req, "phone.line", { userId, did });
      res.json({ ok: true });
    }),
  );
  r.delete(
    "/admin/lines/:userId",
    wrap(async (req, res) => {
      needAdmin(req);
      await db.query("DELETE FROM phone_lines WHERE user_id=$1", [Number(req.params.userId)]);
      await T.apply(db);
      await audit(db, req, "phone.line.remove", { userId: Number(req.params.userId) });
      res.json({ ok: true });
    }),
  );
  return r;
}

// Call-backs that are due become a notification.
async function processCallbacks(db) {
  const rows = (await db.query("SELECT id,user_id,number,callback_note FROM phone_calls WHERE callback_at IS NOT NULL AND callback_at <= NOW() ORDER BY callback_at LIMIT 50")).rows;
  for (const row of rows) {
    await db.query("UPDATE phone_calls SET callback_at=NULL WHERE id=$1", [row.id]);
    const who = (await T.contactName(db, row.number)) || T.display(row.number);
    await require("./messaging-routes")
      .notifyUsers(db, [row.user_id], { category: "reminders", title: "Rappeler " + who, body: row.callback_note || "Rappel prévu après l’appel.", url: "/?open=phone&call=" + row.id, entityType: "phone-call", entityId: String(row.id) })
      .catch(() => {});
  }
  return rows.length;
}

module.exports = { routes, attach, ticketFor, ticketUser, processCallbacks, iceServers };
