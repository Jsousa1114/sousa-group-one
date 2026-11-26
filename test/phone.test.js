"use strict";
// « Téléphone »: settings written for the exchange, each person's line, calls driven through a
// stand-in for the exchange (test/fake-asterisk.cjs): ringing the browsers, the announcement then
// the recording, voicemail, outgoing calls with the mobile number shown, busy lines, refused
// numbers; the assistant's summary and proposals; SMS of an Android phone (webhooks, encryption).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const bcrypt = require("bcryptjs");
const WebSocket = require("ws");
const { database } = require("./database");
const { migrate } = require("../db");
const { createApp } = require("../server");
const D = require("../domain");
const { fakeAsterisk } = require("./fake-asterisk.cjs");

process.env.JWT_SECRET = "test-only-secret-with-at-least-32-characters";
const ENV = ["TELEPHONY_DIR", "ASTERISK_ARI_URL", "PHONE_PUBLIC_IP", "PHONE_SUMMARY_DELAY_MS", "AI_API_URL", "AI_API_KEY", "AI_MODEL", "APP_URL"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const TEL = fs.mkdtempSync(path.join(os.tmpdir(), "sgo-phone-"));
Object.assign(process.env, { TELEPHONY_DIR: TEL, PHONE_PUBLIC_IP: "203.0.113.7", PHONE_SUMMARY_DELAY_MS: "0", APP_URL: "https://app.example.invalid" });
const T = require("../telephony");
const AI = require("../telephony-ai");
const PR = require("../phone-routes");
const SMS = require("../sms-gateway");
const C = require("../telephony-config");

const ast = fakeAsterisk();
let db, server, provider, url;
const tokens = {};
const prompts = [];
const ids = {};
const pause = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout: " + label);
    await pause(15);
  }
}
async function call(p, who, body, method) {
  const res = await fetch(url + "/api/phone/" + p, {
    method: method || (body ? "POST" : "GET"),
    headers: { Authorization: "Bearer " + tokens[who], ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const type = res.headers.get("content-type") || "";
  return { status: res.status, data: type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}
// A short recording as the exchange writes it (8 kHz, 16 bits, mono).
function wav(seconds, freq = 440) {
  const n = Math.round(seconds * 8000);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / 8000) * 8000), i * 2);
  return AI.wavOf({ channels: 1, rate: 8000, bits: 16 }, data);
}
const recording = (name) => path.join(TEL, "spool", "recording", name + ".wav");
const lastCall = async () => (await db.query("SELECT * FROM phone_calls ORDER BY id DESC LIMIT 1")).rows[0];

test.before(async () => {
  provider = http
    .createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw);
        const parts = Array.isArray(body.messages.at(-1).content) ? body.messages.at(-1).content : [];
        prompts.push({ system: body.messages[0].content, text: parts[0]?.text || body.messages.at(-1).content, audio: parts.filter((p) => p.type === "input_audio") });
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    transcript: "Correspondant : Bonjour, il faudrait trois prises T13 au salon.\nEmployé : Je vous fais un devis.",
                    summary: "- Sophie Bernard demande 3 prises T13 au salon.\n- Devis promis pour demain.",
                    caller: { name: "Sophie Bernard" },
                    clientId: "c1",
                    actions: [
                      { type: "quote.prepare", company: "electricite", clientId: "c1", title: "Prises salon", brief: "Poser 3 prises T13 au salon." },
                      { type: "task.create", projectId: "P-1", title: "Prévoir les prises", priority: "high" },
                      { type: "task.create", projectId: "INVENTE", title: "Hors contexte" },
                      { type: "callback", dueDate: "2026-12-01", note: "Confirmer la date" },
                      { type: "rm -rf", title: "inconnu" },
                    ],
                  }),
                },
              },
            ],
          }),
        );
      });
    })
    .listen(0, "127.0.0.1");
  await new Promise((r) => provider.once("listening", r));
  Object.assign(process.env, { AI_API_URL: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`, AI_API_KEY: "fake", AI_MODEL: "fake-model", ASTERISK_ARI_URL: await ast.listen() });
  db = await database();
  await migrate(db);
  const hash = await bcrypt.hash("A-Strong-Test-Password", 4);
  for (const [who, role, company, extra] of [
    ["admin", "admin", "group", {}],
    ["lea", "employee", "electricite", { employee_id: "e1" }],
    ["marc", "manager", "electricite", {}],
    ["client", "client", "electricite", { client_id: "c1" }],
  ]) {
    const out = await db.query("INSERT INTO users(email,password_hash,role,name,avatar,company,employee_id,client_id) VALUES($1,$2,$3,$4,'',$5,$6,$7) RETURNING id", [`ph-${who}@test.invalid`, hash, role, { admin: "Jean Sousa", lea: "Léa Martin", marc: "Marc Rochat", client: "Sophie" }[who], company, extra.employee_id || null, extra.client_id || null]);
    ids[who] = Number(out.rows[0].id);
  }
  const d = D.emptyState();
  d.employees = [{ id: "e1", company: "electricite", name: "Léa Martin", status: "Actif" }];
  d.clients = [{ id: "c1", company: "electricite", name: "Sophie Bernard", phone: "079 888 77 66", city: "Lausanne" }];
  d.projects = [{ id: "P-1", title: "Rénovation Bernard", clientId: "c1", company: "electricite", team: ["e1"], status: "En cours" }];
  await db.query("UPDATE app_state SET data=$1 WHERE id=1", [JSON.stringify(d)]);
  server = createApp(db).listen(0, "127.0.0.1");
  PR.attach(server);
  await new Promise((r) => server.once("listening", r));
  url = "http://127.0.0.1:" + server.address().port;
  for (const who of ["admin", "lea", "marc", "client"]) {
    const r = await fetch(url + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `ph-${who}@test.invalid`, password: "A-Strong-Test-Password" }) });
    tokens[who] = (await r.json()).token;
    assert.ok(tokens[who], "login " + who);
  }
});

test.after(async () => {
  await T._reset();
  SMS._setFetch(null);
  server?.close();
  provider?.close();
  await ast.close();
  fs.rmSync(TEL, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
});

test("the exchange's settings: operator, lines and relay written as Asterisk files, secrets escaped", () => {
  const files = C.files({
    ariPassword: "ari-pass",
    operator: { host: "sip.operateur.ch", username: "1234567", password: "pa;ss\nword", register: true },
    relay: { stun: "stun.example.ch:3478", turnUrls: ["turns:relay.example.ch:443?transport=tcp", "turn:relay.example.ch:3478"], turnUser: "u", turnPassword: "p" },
    publicIp: "203.0.113.7",
    lines: [{ userId: 7, secret: "s3cret", name: 'Léa "L"', did: "+41215550000" }],
  });
  assert.match(files["pjsip.conf"], /^password = pa\\;ssword$/m, "« ; » escaped, line breaks removed");
  assert.match(files["pjsip.conf"], /^\[operator-registration\]\ntype = registration/m);
  assert.match(files["pjsip.conf"], /^external_media_address = 203\.0\.113\.7$/m);
  assert.match(files["pjsip.conf"], /^\[sgo7\]\ntype = endpoint[\s\S]*?webrtc = yes/m);
  assert.match(files["pjsip.conf"], /^callerid = "Léa L" <\+41215550000>$/m);
  assert.match(files["pjsip.conf"], /^endpoint_identifier_order = username,ip$/m);
  assert.match(files["rtp.conf"], /^turnaddr = relay\.example\.ch:3478$/m, "the exchange uses the UDP relay address");
  assert.match(files["rtp.conf"], /^stunaddr = stun\.example\.ch:3478$/m);
  assert.match(files["ari.conf"], /^password = ari-pass$/m);
  const noRegistration = C.files({ ariPassword: "x", operator: { host: "10.0.0.5", username: "u", password: "p", register: false }, lines: [] });
  assert.doesNotMatch(noRegistration["pjsip.conf"], /type = registration/);
  assert.equal(C.relayHost(["turns:a.b:443?transport=tcp"]), "", "TLS-only relays are for the browsers");
  // Swisscom « Téléphonie IP locale »: the Internet-Box is the server, its device is the sender.
  const box = C.pjsip({ operator: { host: "192.168.1.1", port: 5060, username: "225", authUsername: "sousa-group-one", password: "p" }, lines: [] });
  assert.match(box, /^from_user = 225$/m);
  assert.match(box, /^username = sousa-group-one$/m);
  assert.match(box, /^client_uri = sip:225@192\.168\.1\.1$/m);
  // Swisscom « SIP Credentials »: through the outbound proxy.
  const credentials = C.pjsip({ operator: { host: "voip.swisscom.ch", username: "u", password: "p", outboundProxy: "fs1.voip.swisscom.ch" }, lines: [] });
  assert.equal((credentials.match(/^outbound_proxy = sip:fs1\.voip\.swisscom\.ch\\;lr$/gm) || []).length, 3, "registration, address and calls");
  assert.match(credentials, /^match = fs1\.voip\.swisscom\.ch$/m);
  assert.doesNotMatch(credentials, /^from_user/m, "the person's mobile can be shown");
  assert.match(C.manager({ amiPassword: "m" }), /^permit = 172\.16\.0\.0\/255\.240\.0\.0$/m);
});

test("numbers: Swiss habits, display, what may be dialled", () => {
  assert.equal(T.e164("079 123 45 67"), "+41791234567");
  assert.equal(T.e164("0041 79 123 45 67"), "+41791234567");
  assert.equal(T.e164("41791234567"), "+41791234567");
  assert.equal(T.e164("+33 6 12 34 56 78"), "+33612345678");
  assert.equal(T.e164("anonymous"), "");
  assert.equal(T.display("+41791234567"), "+41 79 123 45 67");
  assert.equal(T.dialable("0901 123 456").allowed, false, "premium numbers refused");
  assert.equal(T.dialable("+1 212 555 0100").allowed, false, "outside Europe refused by default");
  assert.equal(T.dialable("+1 212 555 0100", { allowWorld: true }).allowed, true);
  assert.deepEqual(T.dialable("117"), { number: "117", dial: "117", allowed: true }, "emergency numbers dialled as they are");
  assert.equal(T.dialable("079 123 45 67", { dialFormat: "00" }).dial, "0041791234567");
  assert.equal(T.dialable("079 123 45 67", { dialFormat: "national" }).dial, "0791234567");
});

test("only group administrators set the phone; clients never reach it", async () => {
  assert.deepEqual((await call("me", "client")).data, { access: false });
  assert.equal((await call("admin", "marc")).status, 403);
  assert.equal((await call("admin/operator", "lea", { host: "sip.x.ch", username: "u" }, "PUT")).status, 403);
  assert.equal((await call("admin/operator", "admin", { host: "sip x;y", username: "u" }, "PUT")).status, 400);
  const spaced = await call("admin/operator", "admin", { host: "192.168.1.1", username: "Swisscom jardiniere" }, "PUT");
  assert.equal(spaced.status, 400, "a name with a space would break the exchange's settings");
  assert.match(spaced.data.error, /ni espace/);
  assert.equal((await call("admin/operator", "admin", { host: "voip.swisscom.ch", username: "u", outboundProxy: "fs1 voip" }, "PUT")).status, 400);
  assert.equal((await call("admin/operator", "admin", { host: "127.0.0.1", port: 5090, username: "sgotest", password: "operator-secret" }, "PUT")).status, 200);
  const admin = (await call("admin", "admin")).data;
  assert.equal(admin.operator.hasPassword, true);
  assert.equal(admin.operator.dialFormat, "+");
  assert.equal((await call("admin/operator", "admin", { host: "192.168.1.1", username: "225", authUsername: "sousa-group-one" }, "PUT")).status, 200);
  assert.equal((await call("admin", "admin")).data.operator.dialFormat, "national", "numbers dialled the Swiss way through the Internet-Box");
  assert.equal((await call("admin/operator", "admin", { host: "127.0.0.1", port: 5090, username: "sgotest", dialFormat: "+" }, "PUT")).status, 200);
  assert.ok("registration" in admin.status);
  assert.equal(JSON.stringify(admin).includes("operator-secret"), false, "the password never comes back");
  assert.equal((await call("admin/operator", "admin", { host: "127.0.0.1", port: 5090, username: "sgotest" }, "PUT")).status, 200);
  assert.match(fs.readFileSync(path.join(TEL, "etc", "pjsip.conf"), "utf8"), /password = operator-secret/, "kept when left empty");

  assert.equal((await call(`admin/lines/${ids.client}`, "admin", { did: "0215550000" }, "PUT")).status, 404, "no line for a client");
  assert.equal((await call(`admin/lines/${ids.lea}`, "admin", { did: "abc" }, "PUT")).status, 400);
  assert.equal((await call(`admin/lines/${ids.lea}`, "admin", { did: "021 555 00 00", mobile: "079 123 45 67", ringSeconds: 15 }, "PUT")).status, 200);
  assert.equal((await call(`admin/lines/${ids.admin}`, "admin", { did: "+41 21 555 00 00" }, "PUT")).status, 409, "a number belongs to one person");
  assert.equal((await call(`admin/lines/${ids.admin}`, "admin", { did: "021 555 00 01", mobile: "079 000 00 01" }, "PUT")).status, 200);
  const pj = fs.readFileSync(path.join(TEL, "etc", "pjsip.conf"), "utf8");
  assert.match(pj, new RegExp(`^\\[sgo${ids.lea}\\]\\ntype = endpoint`, "m"));
  assert.ok(fs.existsSync(path.join(TEL, "etc", "ready")), "the exchange may start");

  const relay = await call("admin/relay", "admin", { turnUrls: "turn:relay.example.ch:3478\nturns:relay.example.ch:443?transport=tcp", turnUser: "u", turnPassword: "relay-secret" }, "PUT");
  assert.equal(relay.status, 200);
  assert.equal((await call("admin/relay", "admin", { turnUrls: "http://evil" }, "PUT")).status, 400);
  const config = await fetch(url + "/api/state/calls/config", { headers: { Authorization: "Bearer " + tokens.lea } }).then((r) => r.json());
  assert.ok(config.iceServers.some((s) => [].concat(s.urls).includes("turn:relay.example.ch:3478") && s.credential === "relay-secret"), "the internal calls use the same relay");
});

test("the browser's connection: line given to its owner, a signed pass, the proxy to the exchange", async () => {
  const lea = (await call("me", "lea")).data;
  assert.equal(lea.line.didDisplay, "+41 21 555 00 00");
  assert.equal(lea.connection.username, "sgo" + ids.lea);
  assert.ok(lea.connection.password.length >= 24);
  assert.ok(lea.connection.iceServers.some((s) => [].concat(s.urls).includes("turn:relay.example.ch:3478")));
  assert.equal((await call("me", "marc")).data.line, null, "no line, no connection");
  const ticket = new URL(lea.connection.path, "http://x").searchParams.get("ticket");
  assert.equal(PR.ticketUser(ticket), ids.lea);
  assert.equal(PR.ticketUser(ticket.replace(/.$/, (c) => (c === "A" ? "B" : "A"))), 0, "a changed pass is refused");
  assert.equal(PR.ticketUser(`${ids.lea}.${Math.floor(Date.now() / 1000) - 10}.x`), 0);
  const refused = await new Promise((resolve) => {
    const ws = new WebSocket(url.replace("http", "ws") + "/api/phone/sip?ticket=1.9999999999.forged", "sip");
    ws.on("unexpected-response", (req, res) => resolve(res.statusCode));
    ws.on("open", () => resolve("open"));
    ws.on("error", () => resolve("error"));
  });
  assert.equal(refused, 401);
  const echoed = await new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace("http", "ws") + lea.connection.path, "sip");
    ws.on("open", () => ws.send("REGISTER sip:sgo.invalid SIP/2.0"));
    ws.on("message", (m) => {
      resolve({ data: String(m), protocol: ws.protocol });
      ws.close();
    });
    ws.on("error", reject);
  });
  assert.deepEqual(echoed, { data: "echo:REGISTER sip:sgo.invalid SIP/2.0", protocol: "sip" }, "carried to the exchange as it is");
});

test("the application drives the exchange: it connects, then reloads the settings", async () => {
  await T.start(db);
  await until(() => ast.connected(), "connected");
  assert.match(ast.appAuth(), /^Basic /);
  const password = fs.readFileSync(path.join(TEL, "etc", "ari.conf"), "utf8").match(/password = (\S+)/)[1];
  assert.equal(Buffer.from(ast.appAuth().slice(6), "base64").toString(), "sgo:" + password, "with the password written for the exchange");
  await until(() => ast.last("PUT", /res_pjsip\.so$/), "pjsip reloaded");
  await until(() => ast.all("POST", /\/applications\/sgo\/subscription$/).some((c) => c.query.eventSource === `endpoint:PJSIP/sgo${ids.lea}`), "presence followed");
  assert.ok(ast.all("POST", /\/applications\/sgo\/subscription$/).some((c) => c.query.eventSource === "endpoint:PJSIP/operator"), "and the operator's");
  await until(() => T.status().connected, "status");
  // A line added later is followed as soon as it exists (the exchange may start with none).
  assert.equal((await call(`admin/lines/${ids.marc}`, "admin", { did: "021 555 00 09" }, "PUT")).status, 200);
  await until(() => ast.all("POST", /\/applications\/sgo\/subscription$/).some((c) => c.query.eventSource === `endpoint:PJSIP/sgo${ids.marc}`), "new line followed");
  assert.equal((await call(`admin/lines/${ids.marc}`, "admin", undefined, "DELETE")).status, 200);
});

test("a customer calls: the browsers ring, the announcement plays, then the call is recorded and summarised", async () => {
  await call("admin/sound/announcement", "admin", { audio: "data:audio/wav;base64," + wav(2, 1000).toString("base64") });
  assert.ok(fs.existsSync(recording("sgo-announce")));
  assert.equal((await call("admin/sound/announcement", "admin", { audio: "data:audio/wav;base64,AAAA" })).status, 400);
  const notices = [];
  T._setNotifier((users, payload) => notices.push({ users, ...payload }));
  ast.endpoints["sgo" + ids.lea] = "online";
  ast.emit({ type: "StasisStart", args: ["inbound", "+41215550000"], channel: ast.channel("in1", "PJSIP/operator-0001", { caller: { number: "0798887766" } }) });
  const originate = await until(() => ast.last("POST", /^\/channels$/), "rings the line");
  assert.match(originate.query.endpoint, new RegExp(`^Local/sgo${ids.lea}-1\\d@sgo-ring/n$`), "every device of the person rings");
  assert.match(originate.query.callerId, /^"Sophie Bernard" <\+41798887766>$/, "the client's name shown");
  assert.ok(ast.last("POST", /^\/channels\/in1\/ring$/), "the caller hears it ringing");
  const row = await lastCall();
  assert.equal(row.direction, "in");
  assert.equal(row.number, "+41798887766");
  assert.ok(notices.some((n) => n.title === "Appel entrant" && n.users.includes(ids.lea)));
  // Léa answers
  const key = originate.query.appArgs.split(",")[1];
  const legId = ast.lastOriginated();
  ast.emit({ type: "StasisStart", args: ["leg", key], channel: ast.channel(legId, "Local/x;1") });
  const play = await until(() => ast.last("POST", /^\/bridges\/[^/]+\/play$/), "announcement");
  assert.equal(play.query.media, "recording:sgo-announce");
  assert.ok(ast.last("POST", /^\/channels\/in1\/answer$/));
  assert.equal(ast.last("POST", /^\/bridges\/[^/]+\/addChannel$/).query.channel, "in1," + legId);
  await pause(50);
  assert.equal(ast.all("POST", /\/record$/).length, 0, "nothing recorded before the announcement");
  ast.emit({ type: "PlaybackFinished", playback: { id: ast.lastPlayback() } });
  const record = await until(() => ast.last("POST", /^\/bridges\/[^/]+\/record$/), "recording");
  assert.match(record.query.name, /^call-\d+-/);
  assert.equal((await lastCall()).status, "answered");
  fs.mkdirSync(path.dirname(recording("x")), { recursive: true });
  fs.writeFileSync(recording(record.query.name), wav(4));
  // The customer hangs up
  ast.channels.delete("in1");
  ast.emit({ type: "ChannelDestroyed", cause: 16, channel: { id: "in1" } });
  await until(() => ast.last("DELETE", new RegExp(`^/channels/${legId}$`)), "other side hung up");
  const done = await until(async () => (await lastCall()).ai_status === "done" && (await lastCall()), "summarised");
  assert.equal(done.status, "completed");
  assert.equal(done.recorded, true);
  assert.equal(prompts.at(-1).audio.length, 1, "the recording given to the assistant");
  assert.equal(prompts.at(-1).audio[0].input_audio.format, "wav");
  assert.match(prompts.at(-1).text, /Sophie Bernard/);
  assert.match(prompts.at(-1).text, /Rénovation Bernard/, "with the client's site");
  const detail = (await call("calls/" + done.id, "lea")).data.call;
  assert.match(detail.summary, /3 prises T13/);
  assert.equal(detail.clientId, "c1");
  assert.deepEqual(detail.actions.map((a) => a.type), ["quote.prepare", "task.create", "callback"], "invented site and unknown actions dropped");
  assert.equal(detail.actions[1].projectId, "P-1");
  assert.match(detail.transcript, /trois prises/);
  ids.call = done.id;
  // Only Léa hears her recordings; administrators read the summaries
  const audio = await call(`calls/${done.id}/recording`, "lea");
  assert.equal(audio.status, 200);
  assert.equal(audio.data.subarray(0, 4).toString(), "RIFF");
  assert.equal((await call(`calls/${done.id}/recording`, "admin")).status, 404);
  const team = (await call("team", "admin")).data.calls;
  assert.ok(team.some((c) => c.id === done.id && c.summary && c.transcript === undefined && !c.hasRecording));
  assert.equal((await call("team", "lea")).status, 403);
  T._setNotifier(null);
});

test("proposals are confirmed or ignored by the person; a call back becomes a notification", async () => {
  const done = await call(`calls/${ids.call}/actions/1`, "lea", { status: "done", ref: "tache" });
  assert.equal(done.data.call.actions[1].status, "done");
  assert.equal((await call(`calls/${ids.call}/actions/9`, "lea", { status: "done" })).status, 404);
  assert.equal((await call(`calls/${ids.call}/actions/0`, "marc", { status: "done" })).status, 404, "not someone else's call");
  assert.equal((await call(`calls/${ids.call}/callback`, "lea", { at: new Date(Date.now() - 3600000).toISOString() })).status, 400);
  assert.equal((await call(`calls/${ids.call}/callback`, "lea", { at: new Date(Date.now() + 60000).toISOString(), note: "Confirmer la date" })).status, 200);
  await db.query("UPDATE phone_calls SET callback_at=NOW() - INTERVAL '1 minute' WHERE id=$1", [ids.call]);
  assert.equal(await PR.processCallbacks(db), 1);
  const n = (await db.query("SELECT title,body FROM user_notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1", [ids.lea])).rows[0];
  assert.match(n.title, /^Rappeler Sophie Bernard/);
  assert.equal(n.body, "Confirmer la date");
});

test("not answered: the caller hears the greeting and leaves a message, summarised", async () => {
  ast.calls.length = 0;
  ast.endpoints["sgo" + ids.lea] = "offline";
  ast.emit({ type: "StasisStart", args: ["inbound", "41215550000"], channel: ast.channel("in2", "PJSIP/operator-0002", { caller: { number: "+41798887766" } }) });
  await until(() => ast.last("GET", /\/endpoints\/PJSIP\/sgo/), "presence checked");
  await pause(50);
  assert.equal(ast.all("POST", /^\/channels$/).length, 0, "the application is closed: nothing rings yet");
  // Léa opens the application: it rings at once
  ast.endpoints["sgo" + ids.lea] = "online";
  ast.emit({ type: "EndpointStateChange", endpoint: { resource: "sgo" + ids.lea, state: "online" } });
  await until(() => ast.last("POST", /^\/channels$/), "rings once online");
  // Léa declines: voicemail
  const legId = ast.lastOriginated();
  ast.channels.delete(legId);
  ast.emit({ type: "ChannelDestroyed", cause: 21, channel: { id: legId } });
  const greeting = await until(() => ast.last("POST", /^\/channels\/in2\/play$/), "greeting");
  assert.deepEqual([].concat(greeting.query.media), ["sound:vm-intro", "sound:beep"]);
  assert.ok(ast.last("POST", /^\/channels\/in2\/answer$/));
  ast.emit({ type: "PlaybackFinished", playback: { id: ast.lastPlayback() } });
  const rec = await until(() => ast.last("POST", /^\/channels\/in2\/record$/), "message recorded");
  assert.match(rec.query.name, /^vm-\d+-/);
  assert.equal(rec.query.terminateOn, "#");
  fs.writeFileSync(recording(rec.query.name), wav(3, 660));
  ast.emit({ type: "RecordingFinished", recording: { name: rec.query.name } });
  await until(() => ast.last("DELETE", /^\/channels\/in2$/), "hung up after the message");
  const row = await until(async () => {
    const r = await lastCall();
    return r.ai_status === "done" && r;
  }, "voicemail summarised");
  assert.equal(row.status, "voicemail");
  assert.match(prompts.at(-1).text, /^Message vocal/);
  const missed = (await call("me", "lea")).data.unseen.calls;
  assert.equal(missed, 1, "counted until seen");
  await call("calls/seen", "lea", {});
  assert.equal((await call("me", "lea")).data.unseen.calls, 0);
});

test("calling out: the mobile number shown, busy lines and refused numbers", async () => {
  ast.calls.length = 0;
  ast.emit({ type: "StasisStart", args: ["outbound", "0798887766"], channel: ast.channel("b1", `PJSIP/sgo${ids.lea}-00000009`) });
  const out = await until(() => ast.last("POST", /^\/channels$/), "operator called");
  assert.equal(out.query.endpoint, "PJSIP/+41798887766@operator");
  assert.equal(out.query.callerId, '"Léa Martin" <+41791234567>', "her mobile number shown");
  assert.ok(ast.last("POST", /^\/channels\/b1\/ring$/), "she hears it ringing");
  const outId = ast.lastOriginated();
  ast.channels.delete(outId);
  ast.emit({ type: "ChannelDestroyed", cause: 17, channel: { id: outId } });
  const hung = await until(() => ast.last("DELETE", /^\/channels\/b1$/), "browser told");
  assert.equal(hung.query.reason, "busy");
  assert.equal((await lastCall()).status, "busy");
  // a premium number never reaches the operator
  const before = (await db.query("SELECT COUNT(*)::int AS n FROM phone_calls")).rows[0].n;
  ast.calls.length = 0;
  ast.emit({ type: "StasisStart", args: ["outbound", "0901123456"], channel: ast.channel("b2", `PJSIP/sgo${ids.lea}-0000000a`) });
  await until(() => ast.last("DELETE", /^\/channels\/b2$/), "refused");
  assert.equal(ast.all("POST", /^\/channels$/).length, 0);
  assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM phone_calls")).rows[0].n, before);
});

test("SMS from an Android phone: linked, received through a signed webhook, sent encrypted end to end", async () => {
  // the application's own format, both ways
  const sealed = SMS.encrypt("Bonjour Sophie", "abcd-efgh-ijkl-mnop");
  assert.match(sealed, /^\$aes-256-cbc\/pbkdf2-sha1\/v2\$i=300000\$[^$]+\$[^$]+\$[^$]+$/);
  assert.equal(SMS.decrypt(sealed, "abcd-efgh-ijkl-mnop"), "Bonjour Sophie");
  assert.throws(() => SMS.decrypt(sealed, "wrong-passphrase"));
  const relay = [];
  SMS._setFetch(async (u, opts) => {
    relay.push({ url: u, method: opts.method, auth: opts.headers.Authorization, body: opts.body ? JSON.parse(opts.body) : null });
    const reply = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body) });
    if (opts.method === "GET") return reply(200, [{ id: "old", url: "https://app.example.invalid/api/phone/sms/hook/oldtoken" }]);
    if (u.endsWith("/webhooks")) return reply(201, { id: "wh-" + relay.length });
    if (u.endsWith("/messages")) return reply(202, { id: "msg-1", state: "Pending" });
    return reply(204, {});
  });
  assert.equal((await call("sms/setup", "marc", { login: "u", password: "p" })).status, 403, "no line, no SMS");
  assert.equal((await call("sms/setup", "lea", { login: "u", password: "p", encrypted: true, passphrase: "short" })).status, 400);
  const linked = await call("sms/setup", "lea", { login: "LOGIN1", password: "pw1", encrypted: true, passphrase: "abcd-efgh-ijkl-mnop" });
  assert.equal(linked.status, 200);
  assert.ok(relay.some((r) => r.method === "DELETE" && r.url.endsWith("/webhooks/old")), "earlier hooks of this server removed");
  const hooks = relay.filter((r) => r.method === "POST" && r.url.endsWith("/webhooks"));
  assert.deepEqual(hooks.map((h) => h.body.event), SMS.EVENTS);
  assert.equal(hooks[0].auth, "Basic " + Buffer.from("LOGIN1:pw1").toString("base64"));
  const hookUrl = hooks[0].body.url;
  assert.match(hookUrl, /^https:\/\/app\.example\.invalid\/api\/phone\/sms\/hook\/[\w-]{20,}$/);
  const hookPath = new URL(hookUrl).pathname;
  // a message arrives, then the same one again (retries): kept once
  const body = JSON.stringify({ event: "sms:received", deviceId: "d1", payload: { messageId: "m1", message: "Bonjour, vous passez quand ?", phoneNumber: "+41798887766", receivedAt: new Date(Date.now() - 3600000).toISOString() } });
  for (let i = 0; i < 2; i++) assert.equal((await fetch(url + hookPath, { method: "POST", headers: { "Content-Type": "application/json" }, body })).status, 200);
  assert.equal((await fetch(url + "/api/phone/sms/hook/unknown-token", { method: "POST", headers: { "Content-Type": "application/json" }, body })).status, 404);
  const threads = (await call("sms", "lea")).data.threads;
  assert.equal(threads.length, 1);
  assert.equal(threads[0].name, "Sophie Bernard");
  assert.equal(threads[0].unread, 1);
  assert.equal((await call("me", "lea")).data.unseen.sms, 1);
  assert.equal((await call("sms", "marc")).data.threads.length, 0, "each person's SMS are their own");
  const thread = (await call("sms/" + encodeURIComponent("+41798887766"), "lea")).data;
  assert.equal(thread.messages[0].body, "Bonjour, vous passez quand ?");
  assert.equal((await call("me", "lea")).data.unseen.sms, 0, "read once opened");
  // Léa answers: text and number encrypted for the relay
  const sent = await call("sms/send", "lea", { number: "079 888 77 66", text: "Demain à 8h, bonne journée !" });
  assert.equal(sent.status, 200);
  const msg = relay.find((r) => r.url.endsWith("/messages"));
  assert.equal(msg.body.isEncrypted, true);
  assert.equal(SMS.decrypt(msg.body.textMessage.text, "abcd-efgh-ijkl-mnop"), "Demain à 8h, bonne journée !");
  assert.equal(SMS.decrypt(msg.body.phoneNumbers[0], "abcd-efgh-ijkl-mnop"), "+41798887766");
  assert.equal(JSON.stringify(msg.body).includes("Demain"), false, "the relay cannot read it");
  // delivered
  await fetch(url + hookPath, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "sms:delivered", payload: { messageId: "msg-1", phoneNumber: "+41798887766", deliveredAt: "2026-11-27T09:31:00Z" } }) });
  const after = (await call("sms/" + encodeURIComponent("+41798887766"), "lea")).data.messages;
  assert.equal(after.find((m) => m.fromMe).status, "delivered");
});

test("a phone that signs its webhooks: wrong or missing signatures refused", async () => {
  const line = (await db.query("SELECT sms_token,sms_secret FROM phone_lines WHERE user_id=$1", [ids.lea])).rows[0];
  const secret = JSON.parse(T.unseal(line.sms_secret));
  await db.query("UPDATE phone_lines SET sms_secret=$2 WHERE user_id=$1", [ids.lea, T.seal(JSON.stringify({ ...secret, signingKey: "sign-key" }))]);
  const body = JSON.stringify({ event: "sms:received", payload: { messageId: "m2", message: "Signé", phoneNumber: "+41798887766", receivedAt: new Date().toISOString() } });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = require("node:crypto").createHmac("sha256", "sign-key").update(body + ts).digest("hex");
  const hook = url + "/api/phone/sms/hook/" + line.sms_token;
  assert.equal((await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body })).status, 401);
  assert.equal((await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json", "X-Signature": (sig[0] === "0" ? "1" : "0") + sig.slice(1), "X-Timestamp": ts }, body })).status, 401);
  assert.equal((await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json", "X-Signature": sig, "X-Timestamp": ts }, body })).status, 200);
  // a batch of messages
  const batch = JSON.stringify({ event: "sms:batch:received", payload: { messages: [{ messageId: "m3", message: "Un", phoneNumber: "+41790000001", receivedAt: new Date().toISOString() }, { messageId: "m4", message: "Deux", phoneNumber: "+41790000001", receivedAt: new Date().toISOString() }] } });
  const sig2 = require("node:crypto").createHmac("sha256", "sign-key").update(batch + ts).digest("hex");
  assert.equal((await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json", "X-Signature": sig2, "X-Timestamp": ts }, body: batch })).status, 200);
  assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM phone_sms WHERE number='+41790000001'")).rows[0].n, 2);
  assert.equal((await call("sms/setup", "lea", undefined, "DELETE")).status, 200);
  assert.equal((await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body })).status, 404, "unlinked: the address is dead");
});

test("old recordings are removed after the chosen delay; summaries stay", async () => {
  await call("admin/recording", "admin", { enabled: true, keepDays: 1 }, "PUT");
  const row = (await db.query("SELECT id,recording FROM phone_calls WHERE id=$1", [ids.call])).rows[0];
  assert.ok(fs.existsSync(recording(row.recording)));
  await db.query("UPDATE phone_calls SET started_at=NOW() - INTERVAL '3 days' WHERE id=$1", [ids.call]);
  assert.ok((await AI.cleanup(db)) >= 1);
  assert.equal(fs.existsSync(recording(row.recording)), false);
  const after = (await db.query("SELECT recording,summary FROM phone_calls WHERE id=$1", [ids.call])).rows[0];
  assert.equal(after.recording, null);
  assert.match(after.summary, /prises/);
});
