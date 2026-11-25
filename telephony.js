"use strict";
// « Téléphone »: each person's calls go through the company's exchange (Asterisk, on the same
// server). Their mobile forwards its calls to their Swiss operator number; the exchange hands
// every call to this module (ARI), which rings the person's browsers (computer, phone), plays
// the recording announcement, records, falls back to a voicemail, places the calls made from
// the application with the person's own mobile number shown, and keeps the history. After
// each recorded call the assistant writes a summary and proposes what to do (telephony-ai.js).
const fs = require("node:fs");
const path = require("node:path");
const dgram = require("node:dgram");
const { createCipheriv, createDecipheriv, createHash, randomBytes } = require("node:crypto");
const WebSocket = require("ws");
const config = require("./telephony-config");

const APP = "sgo";
const runtime = {
  ws: null,
  connected: false,
  error: "",
  retry: 0,
  timer: null,
  publicIp: "",
  publicIpAt: 0,
  operatorState: "unknown",
  started: false,
  stopping: false,
};
const calls = new Map(); // call key → call
const byChannel = new Map(); // channel id → call key
const playbacks = new Map(); // playback id → { key, then }
const recent = new Map(); // user id → timestamps of calls made (limit)
let processor = null; // (db, callId) → summary; set by telephony-ai.js
let notifier = null; // tests can watch notifications

const dir = () => process.env.TELEPHONY_DIR || path.join(__dirname, "telephony");
const etcDir = () => path.join(dir(), "etc");
const recordingDir = () => path.join(dir(), "spool", "recording");
const ariBase = () => String(process.env.ASTERISK_ARI_URL || "http://host.docker.internal:8188").replace(/\/+$/, "");

// --- secrets kept in the database, sealed with the server key ---
function stateKey() {
  return createHash("sha256").update("sgo-phone:" + (process.env.PHONE_STATE_KEY || process.env.JWT_SECRET || "")).digest();
}
function seal(text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", stateKey(), iv);
  const data = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  return "v1:" + Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}
function unseal(value) {
  if (!String(value || "").startsWith("v1:")) return "";
  const raw = Buffer.from(String(value).slice(3), "base64");
  const decipher = createDecipheriv("aes-256-gcm", stateKey(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

async function setting(db, key, fallback = null) {
  const row = (await db.query("SELECT value FROM phone_settings WHERE key=$1", [key])).rows[0];
  if (!row) return fallback;
  try {
    return JSON.parse(unseal(row.value));
  } catch {
    return fallback;
  }
}
const saveSetting = (db, key, data) =>
  db.query("INSERT INTO phone_settings(key,value,updated_at) VALUES($1,$2,NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()", [key, seal(JSON.stringify(data))]);

// --- numbers ---
// Swiss habits: « 079 123 45 67 » and « 0041 79… » become +41 79 123 45 67.
function e164(raw) {
  let d = String(raw || "").replace(/[^\d+]/g, "");
  if (!d || d === "+") return "";
  if (d.startsWith("+")) d = "+" + d.slice(1).replace(/\+/g, "");
  else if (d.startsWith("00")) d = "+" + d.slice(2);
  else if (d.startsWith("0")) d = "+41" + d.slice(1);
  else if (d.length >= 11) d = "+" + d;
  else if (d.length === 9) d = "+41" + d;
  else return "";
  return /^\+[1-9]\d{6,14}$/.test(d) ? d : "";
}
const phoneKey = (raw) => String(raw || "").replace(/\D/g, "").slice(-9);
function display(number) {
  const n = e164(number);
  if (!n) return String(number || "") || "Numéro masqué";
  const m = n.match(/^\+41(\d{2})(\d{3})(\d{2})(\d{2})$/);
  return m ? `+41 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : n;
}
// Short numbers (emergency 112, 117, 118, 144, 143, 147…) are dialled as such.
const SHORT = /^(1\d{2,3})$/;
function dialable(raw, operator = {}) {
  const digits = String(raw || "").replace(/[^\d+]/g, "");
  if (SHORT.test(digits)) return { number: digits, dial: digits, allowed: true };
  const number = e164(raw);
  if (!number) return { number: "", allowed: false, reason: "Numéro invalide." };
  if (/^\+4190[016]/.test(number)) return { number, allowed: false, reason: "Les numéros payants (0900, 0901, 0906) ne peuvent pas être appelés depuis l’application." };
  const europe = /^\+(3\d|4\d)/.test(number);
  if (!europe && !operator.allowWorld) return { number, allowed: false, reason: "Seuls la Suisse et l’Europe peuvent être appelées (réglage du central)." };
  const format = operator.dialFormat || "+";
  const dial = format === "00" ? "00" + number.slice(1) : format === "national" && number.startsWith("+41") ? "0" + number.slice(3) : format === "national" ? "00" + number.slice(1) : number;
  return { number, dial, allowed: true };
}

// --- the exchange's control interface (ARI) ---
let ariPassword = "";
async function ari(method, p, query = {}, body) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (v == null || v === "") continue;
    for (const item of Array.isArray(v) ? v : [v]) params.append(k, String(item));
  }
  const url = `${ariBase()}/ari${p}${[...params].length ? "?" + params : ""}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: "Basic " + Buffer.from(`${APP}:${ariPassword}`).toString("base64"), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  if (!res.ok) {
    const error = new Error(`ARI ${method} ${p.split("/").slice(0, 2).join("/")} ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return text ? JSON.parse(text) : null;
}
const quiet = (promise) => promise.catch(() => null);

// --- settings → files → exchange ---
async function lines(db) {
  const rows = (
    await db.query(
      `SELECT l.*,u.name AS user_name FROM phone_lines l JOIN users u ON u.id=l.user_id
       WHERE l.enabled=true AND u.disabled=false ORDER BY l.user_id`,
    )
  ).rows;
  return rows.map((r) => ({ ...r, secret: unseal(r.sip_secret) }));
}

async function apply(db, { reload = true } = {}) {
  let ari_ = await setting(db, "ari");
  if (!ari_?.password) {
    ari_ = { password: randomBytes(24).toString("base64url") };
    await saveSetting(db, "ari", ari_);
  }
  ariPassword = ari_.password;
  const operator = await setting(db, "operator");
  const relay = (await setting(db, "relay")) || {};
  const list = await lines(db);
  const files = config.files({
    ariPassword,
    operator,
    relay,
    publicIp: runtime.publicIp,
    lines: list.map((l) => ({ userId: l.user_id, secret: l.secret, name: l.user_name, did: e164(l.did) || l.did || "" })),
    sipPort: Number(process.env.ASTERISK_SIP_PORT || 5060),
  });
  let changed = [];
  try {
    changed = config.write(etcDir(), files);
    runtime.folderError = false;
  } catch (error) {
    runtime.folderError = true;
    runtime.error = "Le dossier du central n’est pas accessible.";
    console.warn("[telephone] écriture des réglages impossible :", error.code || error.message);
    return [];
  }
  if (reload && runtime.connected) {
    if (changed.includes("pjsip.conf")) await quiet(ari("PUT", "/asterisk/modules/res_pjsip.so"));
    if (changed.includes("rtp.conf")) await quiet(ari("PUT", "/asterisk/modules/res_rtp_asterisk.so"));
  }
  return changed;
}

function connect(db) {
  if (runtime.stopping) return;
  clearTimeout(runtime.timer);
  const url = ariBase().replace(/^http/, "ws") + `/ari/events?app=${APP}&subscribeAll=false`;
  const ws = new WebSocket(url, { headers: { Authorization: "Basic " + Buffer.from(`${APP}:${ariPassword}`).toString("base64") }, handshakeTimeout: 8000 });
  runtime.ws = ws;
  ws.on("open", async () => {
    runtime.connected = true;
    runtime.retry = 0;
    runtime.error = "";
    console.log("[telephone] central connecté.");
    await quiet(ari("POST", `/applications/${APP}/subscription`, { eventSource: "endpoint:PJSIP" }));
    // Settings written while the exchange was away are taken now.
    await quiet(ari("PUT", "/asterisk/modules/res_pjsip.so"));
    await quiet(ari("PUT", "/asterisk/modules/res_rtp_asterisk.so"));
    operatorState().catch(() => {});
  });
  ws.on("message", (raw) => {
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    handle(db, event).catch((error) => console.warn("[telephone] événement non traité :", event?.type, error?.message || error));
  });
  ws.on("error", (error) => {
    if (!runtime.connected) runtime.error = error.code === "ECONNREFUSED" || error.code === "ENOTFOUND" ? "Le central téléphonique ne répond pas." : runtime.error;
  });
  ws.on("close", () => {
    if (runtime.ws !== ws) return;
    runtime.connected = false;
    runtime.ws = null;
    if (runtime.stopping) return;
    const delay = Math.min(30000, 2000 * 2 ** Math.min(runtime.retry++, 4));
    runtime.timer = setTimeout(() => connect(db), delay);
    runtime.timer.unref?.();
  });
}

async function operatorState() {
  const ep = await ari("GET", "/endpoints/PJSIP/operator").catch(() => null);
  runtime.operatorState = ep?.state || "unknown";
  return runtime.operatorState;
}

// --- public address of the office (for the operator and the relay), by STUN ---
function stunAddress(server, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const [host, port] = String(server || "stun.l.google.com:19302").replace(/^stun:/, "").split(":");
    const socket = dgram.createSocket("udp4");
    const id = randomBytes(12);
    const done = (value) => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve(value);
    };
    const timer = setTimeout(() => done(""), timeoutMs);
    socket.on("error", () => done(""));
    socket.on("message", (msg) => {
      if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0101 || !msg.subarray(8, 20).equals(id)) return;
      let p = 20;
      while (p + 4 <= msg.length) {
        const type = msg.readUInt16BE(p);
        const len = msg.readUInt16BE(p + 2);
        if ((type === 0x0020 || type === 0x0001) && msg[p + 5] === 1) {
          const raw = msg.subarray(p + 8, p + 12);
          const ip = type === 0x0020 ? [...raw].map((b, i) => b ^ [0x21, 0x12, 0xa4, 0x42][i]) : [...raw];
          return done(ip.join("."));
        }
        p += 4 + len + ((4 - (len % 4)) % 4);
      }
      done("");
    });
    const req = Buffer.alloc(20);
    req.writeUInt16BE(0x0001, 0);
    req.writeUInt16BE(0, 2);
    req.writeUInt32BE(0x2112a442, 4);
    id.copy(req, 8);
    socket.send(req, Number(port || 3478), host, (error) => error && done(""));
  });
}
async function refreshPublicIp(db) {
  if (process.env.PHONE_PUBLIC_IP) runtime.publicIp = process.env.PHONE_PUBLIC_IP;
  else {
    const relay = (await setting(db, "relay")) || {};
    const ip = await stunAddress(relay.stun || "stun.l.google.com:19302");
    if (ip) runtime.publicIp = ip;
  }
  runtime.publicIpAt = Date.now();
}

// --- calls ---
const newKey = () => randomBytes(9).toString("base64url");
function track(call, channelId) {
  if (channelId) byChannel.set(channelId, call.key);
}
function forget(call) {
  clearTimeout(call.ringTimer);
  for (const [ch, key] of byChannel) if (key === call.key) byChannel.delete(ch);
  for (const [pb, info] of playbacks) if (info.key === call.key) playbacks.delete(pb);
  calls.delete(call.key);
}

async function notify(db, userIds, payload) {
  if (notifier) notifier(userIds, payload);
  await require("./messaging-routes")
    .notifyUsers(db, userIds, { category: "phone", ...payload })
    .catch(() => {});
}

async function lineForInbound(db, channel, exten) {
  const all = await lines(db);
  const withDid = all.filter((l) => l.did);
  const find = (raw) => {
    const key = phoneKey(raw);
    return key.length >= 6 ? withDid.find((l) => phoneKey(l.did) === key) : null;
  };
  let line = find(exten);
  if (!line) {
    const to = await quiet(ari("GET", `/channels/${channel.id}/variable`, { variable: "PJSIP_HEADER(read,To)" }));
    const user = String(to?.value || "").match(/sips?:([^@;>]+)/)?.[1];
    if (user) line = find(user);
  }
  // A single person with a number: every call is theirs.
  if (!line && withDid.length === 1) line = withDid[0];
  return line || null;
}

async function onInbound(db, channel, exten) {
  const line = await lineForInbound(db, channel, exten);
  if (!line) {
    console.warn("[telephone] appel pour un numéro inconnu, refusé.");
    await quiet(ari("DELETE", `/channels/${channel.id}`, { reason: "no_answer" }));
    return;
  }
  const number = e164(channel.caller?.number) || "";
  const id = (
    await db.query("INSERT INTO phone_calls(user_id,direction,number,status) VALUES($1,'in',$2,'ringing') RETURNING id", [line.user_id, number])
  ).rows[0].id;
  const call = { key: newKey(), id: Number(id), userId: line.user_id, direction: "in", number, external: channel.id, internal: null, bridge: null, state: "ringing", endpoint: config.endpointOf(line.user_id), ringSeconds: Math.min(60, Math.max(10, Number(line.ring_seconds) || 25)) };
  call.deadline = Date.now() + call.ringSeconds * 1000;
  calls.set(call.key, call);
  track(call, channel.id);
  await quiet(ari("POST", `/channels/${channel.id}/ring`));
  const who = await contactName(db, number);
  call.who = who;
  notify(db, [line.user_id], { title: "Appel entrant", body: `${who || display(number)}`, url: "/?open=phone", tag: "call-" + id, entityType: "phone-call", entityId: String(id) });
  call.ringTimer = setTimeout(() => voicemail(db, call).catch(() => {}), call.ringSeconds * 1000);
  const ep = await quiet(ari("GET", `/endpoints/PJSIP/${call.endpoint}`));
  if (ep?.state === "online") await ringLine(db, call);
  else call.waiting = true; // rings as soon as the application opens (EndpointStateChange)
}

async function ringLine(db, call) {
  if (call.state !== "ringing" || call.internal) return;
  call.waiting = false;
  const seconds = Math.max(5, Math.round((call.deadline - Date.now()) / 1000));
  const name = String(call.who || "").replace(/["<>]/g, "");
  try {
    const leg = await ari("POST", "/channels", {
      endpoint: `Local/${call.endpoint}-${seconds}@sgo-ring/n`,
      app: APP,
      appArgs: `leg,${call.key}`,
      callerId: `"${name || display(call.number)}" <${call.number || "anonymous"}>`,
      timeout: seconds + 5,
    });
    call.internal = leg.id;
    track(call, leg.id);
  } catch (error) {
    console.warn("[telephone] impossible de faire sonner la ligne :", error.message);
  }
}

async function voicemail(db, call) {
  if (call.state !== "ringing") return;
  call.state = "voicemail";
  clearTimeout(call.ringTimer);
  if (call.internal) await quiet(ari("DELETE", `/channels/${call.internal}`));
  await quiet(ari("POST", `/channels/${call.external}/answer`));
  const own = fs.existsSync(path.join(recordingDir(), `sgo-greeting-${call.userId}.wav`));
  const group = fs.existsSync(path.join(recordingDir(), "sgo-greeting.wav"));
  const media = [own ? `recording:sgo-greeting-${call.userId}` : group ? "recording:sgo-greeting" : "sound:vm-intro", "sound:beep"];
  try {
    const pb = await ari("POST", `/channels/${call.external}/play`, { media, lang: "fr" });
    playbacks.set(pb.id, { key: call.key, then: "voicemail-record" });
  } catch {
    await recordVoicemail(db, call);
  }
}
async function recordVoicemail(db, call) {
  if (call.state !== "voicemail") return;
  call.recording = `vm-${call.id}-${Date.now().toString(36)}`;
  await quiet(
    ari("POST", `/channels/${call.external}/record`, { name: call.recording, format: "wav", maxDurationSeconds: 180, maxSilenceSeconds: 8, ifExists: "overwrite", beep: "false", terminateOn: "#" }),
  );
}

async function talk(db, call, legId) {
  clearTimeout(call.ringTimer);
  call.state = "talking";
  call.answeredAt = new Date();
  await db.query("UPDATE phone_calls SET status='answered',answered_at=NOW() WHERE id=$1", [call.id]);
  const other = call.direction === "in" ? call.external : call.internal;
  await quiet(ari("POST", `/channels/${other}/answer`));
  const bridge = await ari("POST", "/bridges", { type: "mixing", name: "call-" + call.id });
  call.bridge = bridge.id;
  await ari("POST", `/bridges/${bridge.id}/addChannel`, { channel: [call.external, call.internal || legId].join(",") });
  const recording = (await setting(db, "recording")) || {};
  const announcement = fs.existsSync(path.join(recordingDir(), "sgo-announce.wav"));
  // Recorded only when the people called have heard the announcement (Swiss law).
  if (recording.enabled !== false && announcement) {
    try {
      const pb = await ari("POST", `/bridges/${bridge.id}/play`, { media: "recording:sgo-announce", lang: "fr" });
      playbacks.set(pb.id, { key: call.key, then: "record" });
    } catch {
      // without the announcement, no recording
    }
  }
}
async function startRecording(db, call) {
  if (call.state !== "talking" || !call.bridge) return;
  call.recording = `call-${call.id}-${Date.now().toString(36)}`;
  await quiet(ari("POST", `/bridges/${call.bridge}/record`, { name: call.recording, format: "wav", maxDurationSeconds: 7200, ifExists: "overwrite", beep: "false" }));
}

async function onOutbound(db, channel, exten) {
  const endpoint = String(channel.name || "").match(/^PJSIP\/(sgo\d+)-/)?.[1];
  const userId = Number(String(endpoint || "").slice(3));
  const line = (await lines(db)).find((l) => Number(l.user_id) === userId);
  const operator = await setting(db, "operator");
  const target = dialable(exten, operator || {});
  const refuse = async (reason) => quiet(ari("DELETE", `/channels/${channel.id}`, { reason }));
  if (!line || !operator?.host) return refuse("congestion");
  if (!target.allowed) {
    console.warn("[telephone] appel refusé :", target.reason);
    return refuse("congestion");
  }
  const now = Date.now();
  const mine = (recent.get(userId) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (mine.length >= Number(process.env.PHONE_CALLS_PER_10MIN || 30)) return refuse("congestion");
  recent.set(userId, [...mine, now]);
  const id = (await db.query("INSERT INTO phone_calls(user_id,direction,number,status) VALUES($1,'out',$2,'ringing') RETURNING id", [userId, target.number])).rows[0].id;
  const call = { key: newKey(), id: Number(id), userId, direction: "out", number: target.number, internal: channel.id, external: null, bridge: null, state: "ringing" };
  calls.set(call.key, call);
  track(call, channel.id);
  await quiet(ari("POST", `/channels/${channel.id}/ring`));
  const shown = e164(line.mobile) || e164(line.did) || "";
  try {
    const out = await ari("POST", "/channels", {
      endpoint: `PJSIP/${target.dial}@operator`,
      app: APP,
      appArgs: `out,${call.key}`,
      callerId: `"${String(line.user_name || "").replace(/["<>]/g, "")}" <${shown}>`,
      timeout: 60,
    });
    call.external = out.id;
    track(call, out.id);
    // Refused at once by the operator: the channel may already be gone.
    if (!(await quiet(ari("GET", `/channels/${out.id}`))) && calls.has(call.key)) await hangup(db, call, out.id, 0);
  } catch (error) {
    console.warn("[telephone] l’opérateur n’accepte pas l’appel :", error.message);
    await finish(db, call, "failed");
    await refuse("congestion");
  }
}

// One side left: the other is hung up, the call is written down, the recording summarised.
async function hangup(db, call, channelId, cause) {
  if (call.ending) return;
  const fromCaller = channelId === call.external;
  if (call.state === "ringing" && call.direction === "in" && !fromCaller) {
    // The person declined, or no device answered in time: voicemail.
    call.internal = null;
    return voicemail(db, call);
  }
  call.ending = true;
  let status;
  if (call.state === "talking") status = "completed";
  else if (call.state === "voicemail") status = call.recording ? "voicemail" : "missed";
  else if (call.direction === "in") status = "missed";
  else if (!fromCaller) status = "cancelled";
  else status = Number(cause) === 17 ? "busy" : [18, 19, 21].includes(Number(cause)) ? "no-answer" : "failed";
  for (const ch of [call.external, call.internal]) if (ch && ch !== channelId) await quiet(ari("DELETE", `/channels/${ch}`, status === "busy" ? { reason: "busy" } : {}));
  if (call.bridge) await quiet(ari("DELETE", `/bridges/${call.bridge}`));
  await finish(db, call, status);
}

async function finish(db, call, status) {
  call.ending = true;
  const recorded = !!call.recording;
  await db.query("UPDATE phone_calls SET status=$2,ended_at=NOW(),recording=$3,recorded=$4,ai_status=$5 WHERE id=$1", [call.id, status, call.recording || null, recorded, recorded ? "waiting" : "none"]);
  if (status === "missed" || status === "voicemail") {
    const who = call.who || display(call.number);
    notify(db, [call.userId], { title: status === "voicemail" ? "Nouveau message vocal" : "Appel manqué", body: who, url: "/?open=phone", tag: "call-" + call.id, entityType: "phone-call", entityId: String(call.id) });
  }
  // The recording is complete once the exchange has closed the file.
  if (recorded) {
    call.finishTimer = setTimeout(() => summarizeLater(db, call.id), Number(process.env.PHONE_SUMMARY_DELAY_MS ?? 2500));
    call.finishTimer.unref?.();
  }
  forget(call);
}
function summarizeLater(db, id) {
  db.query("UPDATE phone_calls SET ai_status='pending' WHERE id=$1 AND ai_status='waiting'", [id])
    .then(() => (processor ? processor(db, id) : null))
    .catch((error) => console.warn("[telephone] résumé impossible :", error?.message || error));
}

async function handle(db, e) {
  const channel = e.channel;
  if (e.type === "StasisStart") {
    const [kind, arg] = e.args || [];
    if (kind === "inbound") return onInbound(db, channel, arg);
    if (kind === "outbound") return onOutbound(db, channel, arg);
    const call = calls.get(arg);
    if (kind === "leg" || kind === "out") {
      if (!call || call.state !== "ringing") return quiet(ari("DELETE", `/channels/${channel.id}`));
      track(call, channel.id);
      if (kind === "leg") call.internal = channel.id;
      else call.external = channel.id;
      return talk(db, call, channel.id);
    }
    return;
  }
  if (e.type === "StasisEnd" || e.type === "ChannelDestroyed") {
    const key = byChannel.get(channel?.id);
    const call = key && calls.get(key);
    if (!call) return;
    if (e.type === "StasisEnd" && call.state === "ringing" && channel.id === call.internal && call.direction === "in") return; // the leg is still ringing elsewhere
    byChannel.delete(channel.id);
    return hangup(db, call, channel.id, e.cause);
  }
  if (e.type === "PlaybackFinished") {
    const info = playbacks.get(e.playback?.id);
    if (!info) return;
    playbacks.delete(e.playback.id);
    const call = calls.get(info.key);
    if (!call) return;
    if (info.then === "record") return startRecording(db, call);
    if (info.then === "voicemail-record") return recordVoicemail(db, call);
    return;
  }
  if (e.type === "RecordingFinished" || e.type === "RecordingFailed") {
    const name = e.recording?.name;
    for (const call of calls.values())
      if (call.recording === name && call.state === "voicemail") {
        // The message is complete: the caller is thanked by hanging up.
        await quiet(ari("DELETE", `/channels/${call.external}`));
      }
    return;
  }
  if (e.type === "EndpointStateChange") {
    const ep = e.endpoint;
    if (ep?.resource === "operator") runtime.operatorState = ep.state;
    if (ep?.state === "online")
      for (const call of calls.values()) if (call.waiting && call.endpoint === ep.resource) await ringLine(db, call);
  }
}

// --- who is calling: the person's clients, then the WhatsApp contacts ---
async function contactName(db, number) {
  const key = phoneKey(number);
  if (key.length < 6) return "";
  try {
    const { loadState } = require("./db");
    const data = (await loadState(db)).data || {};
    const client = (data.clients || []).find((c) => phoneKey(c.phone) === key || phoneKey(c.mobile) === key);
    if (client) return client.name || "";
    const employee = (data.employees || []).find((x) => phoneKey(x.phone) === key);
    if (employee) return employee.name || "";
  } catch {
    // the name is a convenience
  }
  return "";
}

// --- start, stop, status ---
async function start(db) {
  if (runtime.started) return;
  runtime.started = true;
  runtime.stopping = false;
  await db.query("UPDATE phone_calls SET status=CASE WHEN answered_at IS NULL THEN 'missed' ELSE 'completed' END,ended_at=COALESCE(ended_at,NOW()) WHERE ended_at IS NULL AND started_at < NOW() - INTERVAL '2 hours'").catch(() => {});
  await refreshPublicIp(db).catch(() => {});
  await apply(db, { reload: false });
  // At the very first start the shared folder may still be being prepared by the exchange.
  for (let i = 0; runtime.folderError && i < 30 && runtime.started; i++) {
    await new Promise((r) => setTimeout(r, 5000).unref?.());
    await apply(db, { reload: false });
  }
  connect(db);
}
async function stop() {
  runtime.stopping = true;
  runtime.started = false;
  clearTimeout(runtime.timer);
  const ws = runtime.ws;
  runtime.ws = null;
  runtime.connected = false;
  if (ws) {
    await new Promise((resolve) => {
      ws.once("close", resolve);
      try {
        ws.terminate();
      } catch {
        resolve();
      }
      setTimeout(resolve, 500).unref?.();
    });
  }
  for (const call of [...calls.values()]) forget(call);
}
// Every few minutes: the office's public address may change (home Internet).
async function maintain(db) {
  if (!runtime.started) return;
  const before = runtime.publicIp;
  await refreshPublicIp(db).catch(() => {});
  if (runtime.publicIp !== before) await apply(db);
  if (runtime.connected) await operatorState().catch(() => {});
}

// Declined on one device: the call goes to voicemail, and every device stops ringing.
async function decline(db, userId) {
  let n = 0;
  for (const call of calls.values())
    if (call.userId === Number(userId) && call.direction === "in" && call.state === "ringing") {
      await voicemail(db, call);
      n++;
    }
  return n;
}

function status() {
  return { connected: runtime.connected, error: runtime.connected ? "" : runtime.error, operator: runtime.operatorState, publicIp: runtime.publicIp, activeCalls: calls.size };
}

module.exports = {
  APP,
  e164,
  phoneKey,
  display,
  dialable,
  seal,
  unseal,
  setting,
  saveSetting,
  lines,
  apply,
  start,
  stop,
  maintain,
  status,
  decline,
  ari,
  stunAddress,
  recordingDir,
  dir,
  contactName,
  setProcessor: (fn) => (processor = fn),
  _calls: calls,
  _setNotifier: (fn) => (notifier = fn),
  _reset: async () => {
    await stop();
    recent.clear();
    Object.assign(runtime, { error: "", retry: 0, publicIp: "", operatorState: "unknown", stopping: false });
  },
};
