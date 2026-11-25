"use strict";
// « WhatsApp »: the group's number linked like WhatsApp Web, through a stand-in for WhatsApp
// (test/fake-whatsapp.cjs). Linking, history, new messages and notifications, numbers known by
// their private id (@lid), sending with 10 seconds to cancel, files and pieces of the
// application, quick replies, the assistant, filing, reminders, access.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const bcrypt = require("bcryptjs");
const { database } = require("./database");
const { migrate, loadState } = require("../db");
const { createApp } = require("../server");
const D = require("../domain");
const W = require("../whatsapp");
const R = require("../whatsapp-routes");
const { fakeWhatsApp } = require("./fake-whatsapp.cjs");

process.env.JWT_SECRET = "test-only-secret-with-at-least-32-characters";
const ENV = ["WHATSAPP_NOTICE_DELAY_MS", "WHATSAPP_SEND_GAP_MS", "WHATSAPP_TYPING_MS", "WEBMAIL_UNDO_SECONDS", "AI_API_URL", "AI_API_KEY", "AI_MODEL"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const wa = fakeWhatsApp();
let downloads = 0;
let db, server, provider, url;
const tokens = {};
const prompts = [];
const SOPHIE = "41791234567@s.whatsapp.net";
const PAUL = "41795550000@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const now = () => Math.floor(Date.now() / 1000);
const pause = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const settle = async () => {
  await pause(10);
  await W._flush();
  await pause(10);
  await W._flush();
};

async function call(path, who, body) {
  const response = await fetch(url + "/api/" + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + tokens[who], ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const type = response.headers.get("content-type") || "";
  return { status: response.status, headers: response.headers, data: type.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer()) };
}
const chat = (jid, path = "") => `whatsapp/chats/${encodeURIComponent(jid)}${path}`;

test.before(async () => {
  provider = http
    .createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw);
        prompts.push({ system: body.messages[0].content, user: body.messages.at(-1).content });
        const text = /résumes/.test(body.messages[0].content) ? "- Sophie confirme le déménagement de samedi.\nÀ faire : envoyer la facture." : "Bonjour Sophie, c’est noté pour samedi. Belle journée !";
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
      });
    })
    .listen(0, "127.0.0.1");
  await new Promise((r) => provider.once("listening", r));
  Object.assign(process.env, {
    WHATSAPP_NOTICE_DELAY_MS: "0",
    WHATSAPP_SEND_GAP_MS: "0",
    WHATSAPP_TYPING_MS: "0",
    WEBMAIL_UNDO_SECONDS: "0",
    AI_API_URL: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
    AI_API_KEY: "fake",
    AI_MODEL: "fake-model",
  });
  await W._reset();
  W._setSocketFactory(wa.factory, async () => {
    downloads++;
    return Buffer.from("JPEGDATA");
  });
  db = await database();
  await migrate(db);
  const hash = await bcrypt.hash("A-Strong-Test-Password", 4);
  for (const [email, role, company, extra] of [
    ["wa-admin@test.invalid", "admin", "group", {}],
    ["wa-manager@test.invalid", "manager", "home", {}],
    ["wa-lea@test.invalid", "employee", "moving", { employee_id: "e1" }],
    ["wa-client@test.invalid", "client", "moving", { client_id: "c1" }],
  ])
    await db.query("INSERT INTO users(email,password_hash,role,name,avatar,company,employee_id,client_id) VALUES($1,$2,$3,$4,'',$5,$6,$7)", [email, hash, role, "Compte " + role, company, extra.employee_id || null, extra.client_id || null]);
  const d = D.emptyState();
  d.companies.find((c) => c.id === "moving").billing = { iban: "CH9300762011623852957", street: "Rue Test", buildingNumber: "2", zip: "1000", city: "Lausanne", country: "CH", email: "factures@sousa.invalid" };
  d.employees = [{ id: "e1", company: "moving", name: "Léa Martin", status: "Actif" }];
  d.clients = [{ id: "c1", company: "moving", name: "Sophie Bernard", street: "Rue du Lac", buildingNumber: "4", zip: "1000", city: "Lausanne", country: "CH", email: "sophie@example.invalid", phone: "079 123 45 67" }];
  d.projects = [{ id: "P-1", title: "Déménagement Bernard", clientId: "c1", company: "moving", team: ["e1"], status: "En cours", address: "Rue du Lac 4" }];
  const admin = { id: 1, role: "admin", company: "group" };
  const invoice = D.applyCommand(d, admin, { action: "create", collection: "invoices", payload: { company: "moving", clientId: "c1", title: "Déménagement", date: "2026-11-20", due: "2026-12-20", lines: [{ description: "Déménagement", quantity: 1, unit: "forfait", unitPrice: 900, vatRate: 8.1, discount: 0 }] } }).result;
  D.applyCommand(d, admin, { action: "invoice.issue", payload: { id: invoice.id } });
  d.invoiceId = invoice.id;
  await db.query("UPDATE app_state SET data=$1 WHERE id=1", [JSON.stringify(d)]);
  server = createApp(db).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  url = "http://127.0.0.1:" + server.address().port;
  for (const who of ["admin", "manager", "lea", "client"]) {
    const r = await fetch(url + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `wa-${who}@test.invalid`, password: "A-Strong-Test-Password" }) });
    tokens[who] = (await r.json()).token;
    assert.ok(tokens[who], "login " + who);
  }
});

test.after(async () => {
  await W._reset();
  server?.close();
  provider?.close();
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
});

test("the application introduces itself as WhatsApp accepts it in 2026 (desktop « WIN_HYBRID », or WhatsApp Web)", async () => {
  const B = await import("baileys");
  W._correctDesktopIdentity(B);
  W._correctDesktopIdentity(B);
  const kinds = B.proto.ClientPayload.WebInfo.WebSubPlatform;
  const sent = (browser) => {
    const config = { version: [2, 3000, 1], browser, syncFullHistory: true, countryCode: "CH" };
    const login = B.proto.ClientPayload.decode(B.proto.ClientPayload.encode(B.generateLoginNode("41790000000:7@s.whatsapp.net", config)).finish());
    const register = B.proto.ClientPayload.decode(B.proto.ClientPayload.encode(B.generateRegistrationNode(B.initAuthCreds(), config)).finish());
    return [login.webInfo.webSubPlatform, register.webInfo.webSubPlatform];
  };
  assert.deepEqual(sent(B.Browsers.windows("Desktop")), [kinds.WIN_HYBRID, kinds.WIN_HYBRID], "not the retired WIN32");
  assert.deepEqual(sent(B.Browsers.windows("Chrome")), [kinds.WEB_BROWSER, kinds.WEB_BROWSER]);
});

test("only administrators of the group link the number; the QR code and the code stay with them", async () => {
  assert.deepEqual((await call("whatsapp/status", "manager")).data, { access: false });
  assert.deepEqual((await call("whatsapp/status", "client")).data, { access: false });
  assert.equal((await call("whatsapp/link", "manager", { method: "qr" })).status, 403);
  const before = await call("whatsapp/status", "admin");
  assert.equal(before.data.access, true);
  assert.equal(before.data.canManage, true);
  assert.equal(before.data.connected, false);

  // WhatsApp out of reach is said plainly; a QR code shown and never scanned has « expiré ».
  assert.equal((await call("whatsapp/link", "admin", { method: "qr" })).status, 200);
  assert.equal(wa.socket().options.identity, "desktop", "a new link starts as the desktop application (whole history)");
  let count = wa.calls.sockets;
  wa.close(408, "WebSocket Error (getaddrinfo ENOTFOUND web.whatsapp.com)");
  await settle();
  await pause(400);
  assert.equal(wa.calls.sockets, count, "no other try when the server has no way out");
  const unreachable = await call("whatsapp/status", "admin");
  assert.equal(unreachable.data.status, "idle");
  assert.match(unreachable.data.error, /n’arrive pas à joindre WhatsApp/);
  assert.equal((await call("whatsapp/link", "admin", { method: "qr" })).status, 200);
  wa.showQr();
  await settle();
  wa.close(408);
  await settle();
  assert.match((await call("whatsapp/status", "admin")).data.error, /QR code a expiré/);

  // WhatsApp closes before any QR code (428): tried again at once as WhatsApp Web, then said.
  assert.equal((await call("whatsapp/link", "admin", { method: "qr" })).status, 200);
  count = wa.calls.sockets;
  wa.close(428, "Connection Terminated");
  await settle();
  for (let i = 0; i < 100 && wa.calls.sockets === count; i++) await pause(10);
  assert.equal(wa.calls.sockets, count + 1);
  assert.equal(wa.socket().options.identity, "chrome");
  assert.equal((await call("whatsapp/status", "admin")).data.status, "waiting", "still waiting for the QR code");
  wa.showQr();
  await settle();
  assert.match((await call("whatsapp/status", "admin")).data.qrSvg, /^<svg /, "the QR code of the second try is shown");
  wa.close(428, "Connection Terminated");
  await settle();
  await call("whatsapp/link", "admin", { method: "qr" });
  count = wa.calls.sockets;
  wa.close(428, "Connection Terminated");
  await settle();
  for (let i = 0; i < 100 && wa.calls.sockets === count; i++) await pause(10);
  wa.close(428, "Connection Terminated");
  await settle();
  await pause(400);
  assert.equal(wa.calls.sockets, count + 1, "two tries, no loop");
  const refused = await call("whatsapp/status", "admin");
  assert.equal(refused.data.status, "idle");
  assert.match(refused.data.error, /fermé la connexion avant de donner un QR code \(code 428\)/);

  assert.equal((await call("whatsapp/link", "admin", { method: "code", phone: "12" })).status, 400);
  assert.equal((await call("whatsapp/link", "admin", { method: "code", phone: "+41 79 000 00 00" })).status, 200);
  wa.showQr();
  await settle();
  assert.deepEqual(wa.calls.pairing, ["41790000000"]);
  const coded = await call("whatsapp/status", "admin");
  assert.equal(coded.data.pairingCode, "ABCD1234");

  assert.equal((await call("whatsapp/link", "admin", { method: "qr" })).status, 200);
  wa.showQr();
  await settle();
  const qr = await call("whatsapp/status", "admin");
  assert.match(qr.data.qrSvg, /^<svg /);
  assert.equal(qr.data.status, "waiting");

  // Scanned: the session is saved (encrypted), WhatsApp asks for a restart, then it is open.
  const sockets = wa.calls.sockets;
  wa.scan();
  await settle();
  wa.close(515);
  await settle();
  for (let i = 0; i < 50 && wa.calls.sockets === sockets; i++) await pause(10);
  assert.equal(wa.calls.sockets, sockets + 1, "reconnected after the restart asked by WhatsApp");
  wa.open();
  await settle();
  const open = await call("whatsapp/status", "admin");
  assert.equal(open.data.connected, true);
  assert.equal(open.data.me.phone, "+41 79 000 00 00");
  assert.equal(open.data.qrSvg, "");
  assert.ok(wa.calls.presence.some(([type]) => type === "unavailable"), "stays « offline » so the phone keeps its notifications");
  const rows = (await db.query("SELECT key,value FROM whatsapp_auth")).rows;
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.value.startsWith("v1:") && !/noiseKey|signedIdentityKey|Buffer/.test(r.value)), "session stored encrypted");
  assert.equal((await call("whatsapp/link", "admin", { method: "qr" })).status, 409, "already linked");
});

test("the history arrives: conversations named from the contacts, numbers known by their private id joined", async () => {
  const ts = now() - 3600;
  wa.emit("messaging-history.set", {
    isLatest: true,
    progress: 100,
    lidPnMappings: [{ lid: "99887766@lid", pn: PAUL }],
    contacts: [
      { id: SOPHIE, notify: "Sophie B." },
      { id: "99887766@lid", phoneNumber: PAUL, name: "Paul Rochat" },
    ],
    chats: [{ id: SOPHIE, unreadCount: 1, conversationTimestamp: ts }, { id: GROUP, conversationTimestamp: ts - 100 }],
    messages: [
      { key: { remoteJid: SOPHIE, fromMe: false, id: "S1" }, message: { conversation: "Bonjour, le déménagement est bien samedi ?" }, messageTimestamp: ts - 600, pushName: "Sophie B." },
      { key: { remoteJid: SOPHIE, fromMe: true, id: "S2" }, message: { conversation: "Oui, samedi à 8h." }, messageTimestamp: ts - 500, status: 4 },
      { key: { remoteJid: SOPHIE, fromMe: false, id: "S3" }, message: { imageMessage: { mimetype: "image/jpeg", fileLength: 2048, caption: "Le salon", jpegThumbnail: Buffer.from("thumb") } }, messageTimestamp: ts - 400 },
      { key: { remoteJid: SOPHIE, fromMe: false, id: "S4" }, message: { documentWithCaptionMessage: { message: { documentMessage: { fileName: "Inventaire.pdf", mimetype: "application/pdf", fileLength: 4096 } } } }, messageTimestamp: ts - 300 },
      { key: { remoteJid: "99887766@lid", fromMe: false, id: "P1" }, message: { conversation: "Avez-vous un garde-meuble ?" }, messageTimestamp: ts - 200 },
      { key: { remoteJid: GROUP, fromMe: false, id: "G1", participant: "55554444@lid", participantAlt: "41796660000@s.whatsapp.net" }, message: { conversation: "Camion chargé" }, messageTimestamp: ts - 100, pushName: "Marco" },
      { key: { remoteJid: "status@broadcast", fromMe: false, id: "ST1" }, message: { conversation: "statut" }, messageTimestamp: ts },
    ],
  });
  await settle();
  await pause(50);
  const list = await call("whatsapp/chats", "admin");
  assert.equal(list.status, 200);
  const byJid = Object.fromEntries(list.data.chats.map((c) => [c.jid, c]));
  assert.deepEqual(Object.keys(byJid).sort(), [GROUP, SOPHIE, PAUL].sort(), "status updates are left out; the @lid conversation is under Paul's number");
  assert.equal(byJid[SOPHIE].name, "Sophie B.");
  assert.equal(byJid[SOPHIE].phone, "+41 79 123 45 67");
  assert.equal(byJid[SOPHIE].unread, 1);
  assert.equal(byJid[SOPHIE].lastText, "Document · Inventaire.pdf");
  assert.equal(byJid[PAUL].name, "Paul Rochat");
  assert.equal(byJid[GROUP].name, "Équipe chantier");
  assert.equal(byJid[GROUP].group, true);
  const messages = await call(chat(SOPHIE, "/messages"), "admin");
  assert.deepEqual(
    messages.data.messages.map((m) => [m.id, m.kind, m.fromMe]),
    [
      ["S1", "text", false],
      ["S2", "text", true],
      ["S3", "image", false],
      ["S4", "document", false],
    ],
  );
  assert.equal(messages.data.messages[1].status, 4);
  assert.equal(messages.data.messages[2].body, "Le salon");
  assert.match(messages.data.messages[2].thumb, /^data:image\/jpeg;base64,/);
  assert.equal(messages.data.messages[3].fileName, "Inventaire.pdf");
  const group = await call(chat(GROUP, "/messages"), "admin");
  assert.equal(group.data.messages[0].senderName, "Marco");
  assert.equal(group.data.messages[0].sender, "41796660000@s.whatsapp.net");
  const search = await call("whatsapp/chats?q=garde-meuble", "admin");
  assert.deepEqual(search.data.chats.map((c) => c.jid), [PAUL], "search in the messages");
  assert.deepEqual((await call("whatsapp/chats?q=795550", "admin")).data.chats.map((c) => c.jid), [PAUL], "search by number");
});

test("a new message: unread, a notification for everyone who may open WhatsApp, edits, deletions, reactions, ticks", async () => {
  await db.query("DELETE FROM user_notifications");
  wa.emit("messages.upsert", { type: "notify", messages: [{ key: { remoteJid: SOPHIE, fromMe: false, id: "S5" }, message: { extendedTextMessage: { text: "Parfait, merci !", contextInfo: { stanzaId: "S2", quotedMessage: { conversation: "Oui, samedi à 8h." } } } }, messageTimestamp: now(), pushName: "Sophie B." }] });
  await settle();
  await pause(60);
  const sophie = (await call("whatsapp/chats", "admin")).data.chats.find((c) => c.jid === SOPHIE);
  assert.equal(sophie.unread, 2);
  assert.equal(sophie.lastText, "Parfait, merci !");
  const notes = (await db.query("SELECT u.email,n.category,n.title,n.body,n.url FROM user_notifications n JOIN users u ON u.id=n.user_id")).rows;
  assert.deepEqual(notes.map((n) => [n.email, n.category, n.title, n.body]), [["wa-admin@test.invalid", "whatsapp", "WhatsApp · Sophie B.", "Parfait, merci !"]]);
  assert.equal(notes[0].url, `/?open=whatsapp&chat=${encodeURIComponent(SOPHIE)}`);
  assert.equal((await call("whatsapp/status", "admin")).data.unread, 2);

  wa.emit("messages.reaction", [{ key: { remoteJid: SOPHIE, fromMe: true, id: "S2" }, reaction: { text: "👍", key: { remoteJid: SOPHIE, fromMe: false, id: "R1" } } }]);
  wa.emit("messages.update", [{ key: { remoteJid: SOPHIE, fromMe: true, id: "S2" }, update: { status: 5 } }]);
  wa.emit("messages.upsert", { type: "notify", messages: [{ key: { remoteJid: SOPHIE, fromMe: false, id: "S6" }, message: { protocolMessage: { type: 14, key: { id: "S5" }, editedMessage: { conversation: "Parfait, merci beaucoup !" } } }, messageTimestamp: now() }] });
  wa.emit("messages.upsert", { type: "notify", messages: [{ key: { remoteJid: SOPHIE, fromMe: false, id: "S7" }, message: { protocolMessage: { type: 0, key: { id: "S3" } } }, messageTimestamp: now() }] });
  await settle();
  const list = (await call(chat(SOPHIE, "/messages"), "admin")).data.messages;
  const m = Object.fromEntries(list.map((x) => [x.id, x]));
  assert.deepEqual(m.S2.reactions, ["👍"]);
  assert.equal(m.S2.status, 5);
  assert.equal(m.S5.body, "Parfait, merci beaucoup !");
  assert.equal(m.S5.edited, true);
  assert.equal(m.S5.quotedText, "Oui, samedi à 8h.");
  assert.equal(m.S3.deleted, true);
  assert.equal(m.S3.thumb, null);
  assert.ok(!m.S6 && !m.S7, "edits and deletions are not messages");
});

test("opening marks read on the phone too; media downloaded once then kept", async () => {
  wa.calls.read.length = 0;
  assert.equal((await call(chat(SOPHIE, "/read"), "admin", {})).status, 200);
  assert.deepEqual(wa.calls.read.map((k) => k.id).sort(), ["S4", "S5"]);
  assert.equal((await call("whatsapp/chats", "admin")).data.chats.find((c) => c.jid === SOPHIE).unread, 0);
  const pdf = await call(`whatsapp/media/${encodeURIComponent(SOPHIE)}/S4`, "admin");
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.match(pdf.headers.get("content-disposition"), /^inline; filename="Inventaire\.pdf"/);
  assert.equal(pdf.data.toString(), "JPEGDATA");
  const again = await call(`whatsapp/media/${encodeURIComponent(SOPHIE)}/S4?download=1`, "admin");
  assert.equal(again.headers.get("content-type"), "application/octet-stream");
  assert.equal(downloads, 1, "downloaded from WhatsApp once, then kept");
  assert.equal((await call(`whatsapp/media/${encodeURIComponent(SOPHIE)}/S3`, "admin")).status, 404, "deleted");
  assert.equal((await call(`whatsapp/media/${encodeURIComponent(SOPHIE)}/S1`, "admin")).status, 404, "text has no file");
});

test("access: an administrator ticks the people who may open WhatsApp", async () => {
  assert.equal((await call(chat(SOPHIE, "/messages"), "lea")).status, 403);
  assert.equal((await call("whatsapp/access", "lea")).status, 403);
  const list = await call("whatsapp/access", "admin");
  const lea = list.data.users.find((u) => u.name === "Compte employee");
  assert.equal(lea.granted, false);
  assert.ok(list.data.users.find((u) => u.name === "Compte admin").automatic);
  assert.ok(!list.data.users.some((u) => u.role === "client"));
  const clientId = (await db.query("SELECT id FROM users WHERE email='wa-client@test.invalid'")).rows[0].id;
  assert.equal((await call("whatsapp/access", "admin", { userId: clientId, granted: true })).status, 400);
  assert.equal((await call("whatsapp/access", "admin", { userId: lea.id, granted: true })).status, 200);
  const status = await call("whatsapp/status", "lea");
  assert.equal(status.data.access, true);
  assert.equal(status.data.canManage, false);
  assert.equal(status.data.qrSvg, "");
  assert.equal((await call("whatsapp/unlink", "lea", {})).status, 403);
  assert.equal((await call(chat(SOPHIE, "/messages"), "lea")).status, 200);
});

test("sending: text with a quoted message, a file with its caption, an invoice of the application", async () => {
  wa.calls.sent.length = 0;
  const text = await call(chat(SOPHIE, "/send"), "lea", { text: "Bonjour *Sophie*, à samedi !", quotedId: "S5" });
  assert.equal(text.status, 200, JSON.stringify(text.data));
  assert.equal(text.data.sent, true);
  assert.equal(wa.calls.sent[0].content.text, "Bonjour *Sophie*, à samedi !");
  assert.equal(wa.calls.sent[0].opts.quoted.key.id, "S5", "the quoted message is the stored one");
  const file = await call(chat(SOPHIE, "/send"), "lea", { text: "Le plan", uploads: [{ name: "plan.pdf", type: "application/pdf", data: Buffer.from("%PDF plan").toString("base64") }] });
  assert.equal(file.status, 200);
  assert.equal(wa.calls.sent[1].content.caption, "Le plan", "one file: the text becomes its caption");
  assert.equal(wa.calls.sent[1].content.fileName, "plan.pdf");
  assert.equal(wa.calls.sent.length, 2);
  const state = (await loadState(db)).data;
  const inv = await call(chat(SOPHIE, "/send"), "admin", { text: "Votre facture", appFiles: [{ kind: "invoices", id: state.invoiceId }] });
  assert.equal(inv.status, 200, JSON.stringify(inv.data));
  assert.equal(wa.calls.sent[2].content.fileName, `${state.invoiceId}.pdf`);
  assert.equal(wa.calls.sent[2].content.document.subarray(0, 5).toString(), "%PDF-");
  assert.equal((await call(chat(SOPHIE, "/send"), "lea", { text: "x", appFiles: [{ kind: "invoices", id: state.invoiceId }] })).status, 403, "an employee does not send invoices");
  const stored = (await call(chat(SOPHIE, "/messages"), "admin")).data.messages.filter((m) => m.fromMe && m.id.startsWith("OUT"));
  assert.deepEqual(stored.map((m) => [m.kind, m.body || m.fileName]), [
    ["text", "Bonjour *Sophie*, à samedi !"],
    ["document", "Le plan"],
    ["document", "Votre facture"],
  ]);
  assert.equal(stored[0].quotedText, "Parfait, merci beaucoup !");
  assert.equal((await call(chat(SOPHIE, "/send"), "lea", { text: "   " })).status, 400);
  assert.equal((await call(chat("nope", "/send"), "lea", { text: "x" })).status, 404);
});

test("10 seconds to cancel, and programmed sending", async () => {
  process.env.WEBMAIL_UNDO_SECONDS = "10";
  try {
    wa.calls.sent.length = 0;
    const queued = await call(chat(PAUL, "/send"), "admin", { text: "À annuler" });
    assert.equal(queued.data.kind, "undo");
    const cancelled = await call(`whatsapp/outbox/${queued.data.id}/cancel`, "admin", {});
    assert.deepEqual([cancelled.data.jid, cancelled.data.text], [PAUL, "À annuler"]);
    const second = await call(chat(PAUL, "/send"), "admin", { text: "Oui, nous avons de la place." });
    assert.equal((await R.processOutbox(db)).sent, 0);
    assert.equal((await R.processOutbox(db, { now: new Date(Date.now() + 15000) })).sent, 1);
    assert.deepEqual(wa.calls.sent.map((s) => s.content.text), ["Oui, nous avons de la place."]);
    assert.equal((await call(`whatsapp/outbox/${second.data.id}`, "admin")).data.status, "sent");
    assert.equal((await call(`whatsapp/outbox/${second.data.id}/cancel`, "admin", {})).status, 409);

    const at = new Date(Date.now() + 3 * 3600000).toISOString();
    const planned = await call(chat(PAUL, "/send"), "lea", { text: "Rappel : visite lundi.", sendAt: at });
    assert.equal(planned.data.kind, "scheduled");
    const list = await call("whatsapp/outbox", "admin");
    assert.deepEqual(list.data.messages.map((m) => [m.chat, m.preview, m.by]), [["Paul Rochat", "Rappel : visite lundi.", "Compte employee"]]);
    assert.equal((await R.processOutbox(db, { now: new Date(Date.now() + 4 * 3600000) })).sent, 1);
    assert.equal(wa.calls.sent.at(-1).content.text, "Rappel : visite lundi.");
    assert.deepEqual((await call("whatsapp/outbox", "admin")).data.messages, []);
  } finally {
    process.env.WEBMAIL_UNDO_SECONDS = "0";
  }
});

test("quick replies, the assistant and filing in a site's documents", async () => {
  const created = await call("whatsapp/snippets", "lea", { title: "Horaires", text: "Nous sommes ouverts du lundi au vendredi, *7h-17h*." });
  assert.equal(created.status, 200);
  assert.deepEqual((await call("whatsapp/snippets", "admin")).data.snippets.map((s) => [s.title, s.text]), [["Horaires", "Nous sommes ouverts du lundi au vendredi, *7h-17h*."]]);
  assert.equal((await call("webmail/" + "x" + "/snippets", "admin")).status, 404, "kept apart from the mailboxes");
  await call(`whatsapp/snippets/${created.data.id}/delete`, "admin", {});
  assert.deepEqual((await call("whatsapp/snippets", "admin")).data.snippets, []);

  const summary = await call(chat(SOPHIE, "/ai"), "admin", { mode: "summary" });
  assert.equal(summary.status, 200, JSON.stringify(summary.data));
  assert.match(summary.data.text, /À faire : envoyer la facture/);
  assert.match(prompts.at(-1).user, /Bonjour, le déménagement est bien samedi \?/);
  assert.match(prompts.at(-1).user, /Client connu : Sophie Bernard\. Factures ouvertes/, "the client is recognised by the number");
  const reply = await call(chat(SOPHIE, "/ai"), "lea", { mode: "reply" });
  assert.match(reply.data.text, /^Bonjour Sophie/);
  assert.doesNotMatch(prompts.at(-1).user, /Factures ouvertes/, "an employee does not see the invoices");

  const filed = await call(chat(SOPHIE, "/file"), "lea", { target: { type: "project", id: "P-1" }, transcript: true, days: 30, ids: ["S4"] });
  assert.equal(filed.status, 200, JSON.stringify(filed.data));
  assert.equal(filed.data.target, "Déménagement Bernard");
  const docs = (await loadState(db)).data.documents.filter((x) => x.project === "P-1");
  assert.equal(docs.length, 2);
  assert.match(docs[0].name, /^WhatsApp Sophie B\. \d{4}-\d{2}-\d{2}\.pdf$/);
  assert.equal(docs[1].name, "Inventaire.pdf");
  assert.ok(docs.every((x) => x.category === "WhatsApp"));
  const pdf = await require("../storage").loadFile(db, docs[0].id);
  assert.equal(Buffer.from(pdf.content).subarray(0, 5).toString(), "%PDF-");
});

test("reminders, archiving and « unread » stay in the application", async () => {
  const at = new Date(Date.now() + 26 * 3600000).toISOString();
  assert.equal((await call(chat(PAUL, "/remind"), "lea", { at: new Date(Date.now() - 1000).toISOString() })).status, 400);
  assert.equal((await call(chat(PAUL, "/remind"), "lea", { at })).status, 200);
  assert.ok(!(await call("whatsapp/chats", "admin")).data.chats.some((c) => c.jid === PAUL), "out of the list until then");
  assert.deepEqual((await call("whatsapp/chats?filter=snoozed", "admin")).data.chats.map((c) => c.jid), [PAUL]);
  await db.query("DELETE FROM user_notifications");
  assert.equal((await R.processReminders(db)).done, 0);
  assert.equal((await R.processReminders(db, { now: new Date(Date.now() + 27 * 3600000) })).done, 1);
  const back = (await call("whatsapp/chats", "admin")).data.chats.find((c) => c.jid === PAUL);
  assert.ok(back && back.unread >= 1, "back in the list, unread");
  const notes = (await db.query("SELECT u.email,n.category,n.title FROM user_notifications n JOIN users u ON u.id=n.user_id")).rows;
  assert.deepEqual(notes.map((n) => [n.email, n.category, n.title]), [["wa-lea@test.invalid", "reminders", "Rappel WhatsApp : Paul Rochat"]]);

  await call(chat(GROUP, "/state"), "admin", { archived: true });
  assert.ok(!(await call("whatsapp/chats", "admin")).data.chats.some((c) => c.jid === GROUP));
  assert.deepEqual((await call("whatsapp/chats?filter=archived", "admin")).data.chats.map((c) => c.jid), [GROUP]);
  wa.emit("messages.upsert", { type: "notify", messages: [{ key: { remoteJid: GROUP, fromMe: false, id: "G2", participant: "41796660000@s.whatsapp.net" }, message: { conversation: "Arrivés" }, messageTimestamp: now(), pushName: "Marco" }] });
  await settle();
  assert.ok((await call("whatsapp/chats", "admin")).data.chats.some((c) => c.jid === GROUP), "a new message brings an archived conversation back, as in WhatsApp");
  wa.calls.read.length = 0;
  await call(chat(SOPHIE, "/state"), "admin", { unread: true });
  assert.equal((await call("whatsapp/chats", "admin")).data.chats.find((c) => c.jid === SOPHIE).unread, 1);
});

test("a number learned later joins its conversation; a new conversation with a number", async () => {
  wa.emit("messages.upsert", { type: "notify", messages: [{ key: { remoteJid: "11223344@lid", fromMe: false, id: "L1" }, message: { conversation: "Bonjour, c’est Nina" }, messageTimestamp: now() - 10, pushName: "Nina" }] });
  await settle();
  assert.ok((await call("whatsapp/chats", "admin")).data.chats.some((c) => c.jid === "11223344@lid"));
  wa.emit("lid-mapping.update", { lid: "11223344@lid", pn: "41797770000@s.whatsapp.net" });
  await settle();
  const chats = (await call("whatsapp/chats", "admin")).data.chats;
  assert.ok(!chats.some((c) => c.jid === "11223344@lid"));
  const nina = chats.find((c) => c.jid === "41797770000@s.whatsapp.net");
  assert.equal(nina.name, "Nina");
  assert.equal((await call(chat("41797770000@s.whatsapp.net", "/messages"), "admin")).data.messages[0].body, "Bonjour, c’est Nina");

  assert.equal((await call("whatsapp/new", "admin", { phone: "12" })).status, 400);
  const created = await call("whatsapp/new", "admin", { phone: "078 888 99 00", name: "Marc Lenoir" });
  assert.equal(created.data.jid, "41788889900@s.whatsapp.net");
  const opened = await call(chat(created.data.jid, "/messages"), "admin");
  assert.equal(opened.data.chat.name, "Marc Lenoir");
  assert.equal((await call(chat(created.data.jid, "/send"), "admin", { text: "Bonjour Monsieur Lenoir" })).status, 200);
});

test("unlinking keeps the messages; WhatsApp removing the device is reported; the server reconnects a linked phone", async () => {
  const sockets = wa.calls.sockets;
  await W.stop();
  await W.boot(db);
  assert.equal(wa.calls.sockets, sockets + 1, "a linked phone reconnects at server start");
  assert.equal(wa.socket().options.identity, "desktop", "with the identity it was linked with");
  wa.open();
  await settle();
  assert.equal((await call("whatsapp/status", "admin")).data.connected, true);

  wa.close(401);
  await settle();
  const out = await call("whatsapp/status", "admin");
  assert.equal(out.data.status, "logged_out");
  assert.match(out.data.error, /déconnecté l’application/);
  assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM whatsapp_auth")).rows[0].n, 0, "session removed");
  assert.equal((await call(chat(SOPHIE, "/send"), "admin", { text: "x" })).status, 503, "not connected");
  assert.ok((await call("whatsapp/chats", "admin")).data.chats.length >= 3, "stored conversations stay readable");

  await call("whatsapp/link", "admin", { method: "qr" });
  wa.scan();
  await settle();
  wa.open();
  await settle();
  const logouts = wa.calls.logout;
  assert.equal((await call("whatsapp/unlink", "admin", {})).status, 200);
  assert.equal(wa.calls.logout, logouts + 1, "the phone's list of devices loses this one");
  await settle();
  assert.equal((await call("whatsapp/status", "admin")).data.connected, false);
  assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM whatsapp_auth")).rows[0].n, 0);
  assert.ok((await call("whatsapp/chats", "admin")).data.chats.length >= 3);
  const audit = (await db.query("SELECT action FROM audit_logs WHERE action LIKE 'whatsapp.%' ORDER BY id")).rows.map((r) => r.action);
  assert.ok(audit.includes("whatsapp.link") && audit.includes("whatsapp.unlink") && audit.includes("whatsapp.access"));
});
