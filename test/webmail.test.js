"use strict";
// « Boîte mail »: the companies' Gmail mailboxes, read through an in-memory Gmail (labels,
// conversations, Gmail search) and sent through a fake SMTP server.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const bcrypt = require("bcryptjs");
const { database } = require("./database");
const { migrate } = require("../db");
const { createApp } = require("../server");
const D = require("../domain");
const W = require("../webmail");
const { fakeSmtp } = require("./fake-smtp.cjs");
const { fakeGmail } = require("./fake-gmail.cjs");

process.env.JWT_SECRET = "test-only-secret-with-at-least-32-characters";
const ENV = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS", "SMTP_USER_HOME", "SMTP_PASS_HOME", "SMTP_USER_MOVING", "SMTP_PASS_MOVING", "IMAP_HOST", "MAIL_REPLY_TO", "AI_API_URL", "AI_API_KEY", "AI_MODEL", "WEBMAIL_UNDO_SECONDS"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const MOVING = "62595bda-dfc6-44c2-8aed-804a3183806f";
const PASS = "gmailapppass16ch";
let password = PASS;
let db, server, smtp, provider, url;
const tokens = {};
const sent = [];
const aiPrompts = [];
const gmail = { "moving@sousa.test": fakeGmail({ password: () => password }), "home@sousa.test": fakeGmail({ password: () => password }) };
const moving = gmail["moving@sousa.test"];
const seeded = {};
const decode = (raw) => Buffer.from(raw.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8");

async function call(path, who, body) {
  const response = await fetch(url + "/api/" + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + tokens[who], ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const type = response.headers.get("content-type") || "";
  return { status: response.status, headers: response.headers, data: type.includes("json") ? await response.json() : Buffer.from(await response.arrayBuffer()) };
}
const box = (path) => `webmail/${MOVING}/${path}`;

test.before(async () => {
  smtp = fakeSmtp(() => password, sent).listen(0, "127.0.0.1");
  await new Promise((r) => smtp.once("listening", r));
  provider = http
    .createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw);
        aiPrompts.push({ system: body.messages[0].content, user: body.messages.at(-1).content });
        const text = /résumes/.test(body.messages[0].content) ? "- Sophie paie à la fin du mois.\nÀ faire : rien" : "Bonjour Madame Bernard,\n\nMerci, c’est noté.\n\nMeilleures salutations";
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
      });
    })
    .listen(0, "127.0.0.1");
  await new Promise((r) => provider.once("listening", r));
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, {
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(smtp.address().port),
    SMTP_SECURE: "false",
    SMTP_USER_MOVING: "moving@sousa.test",
    SMTP_PASS_MOVING: PASS,
    SMTP_USER_HOME: "home@sousa.test",
    SMTP_PASS_HOME: PASS,
    IMAP_HOST: "imap.fake.test",
    AI_API_URL: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
    AI_API_KEY: "fake",
    AI_MODEL: "fake-model",
    // Sent at once in these tests; the 10 seconds to cancel are tested on their own below.
    WEBMAIL_UNDO_SECONDS: "0",
  });
  W._reset();
  W._setClientFactory((imap) => gmail[imap.user].factory(imap));

  // Sophie's conversation: her message, our reply (in « Envoyés » only), her answer.
  seeded.first = await moving.add({ from: "Sophie Bernard <sophie@example.invalid>", subject: "Facture du déménagement", text: "Bonjour,\nJe paie la facture à la fin du mois.", threadId: 500, messageId: "<sophie-1@example.invalid>", date: new Date("2026-11-24T08:00:00Z") });
  seeded.ours = await moving.add({ from: "Sousa Moving <moving@sousa.test>", to: ["sophie@example.invalid"], subject: "Re: Facture du déménagement", text: "Merci pour votre message.", threadId: 500, labels: ["\\Sent"], flags: ["\\Seen"], messageId: "<ours-1@sousa.test>", date: new Date("2026-11-24T09:00:00Z") });
  seeded.last = await moving.add({ from: "Sophie Bernard <sophie@example.invalid>", cc: ["compta@example.invalid"], subject: "Re: Facture du déménagement", text: "Parfait, merci !\n\nLe lun. 24 nov. 2026, Sousa Moving a écrit :\n> Merci pour votre message.", threadId: 500, messageId: "<sophie-2@example.invalid>", references: "<sophie-1@example.invalid> <ours-1@sousa.test>", inReplyTo: "<ours-1@sousa.test>", date: new Date("2026-11-24T10:00:00Z") });
  seeded.marc = await moving.add({
    from: "Marc Lenoir <marc@exemple.ch>",
    subject: "Devis déménagement juin",
    html: '<p onclick="steal()">Bonjour, voici le <b>plan</b>.</p><script>alert(1)</script><img src="cid:logo@marc"><img src="https://tracker.example/p.gif"><a href="javascript:alert(2)">piège</a>',
    attachments: [
      { filename: "logo.png", content: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"), contentType: "image/png", cid: "logo@marc" },
      { filename: "Plan été.pdf", content: Buffer.from("%PDF-1.4 plan"), contentType: "application/pdf" },
    ],
    date: new Date("2026-11-25T07:00:00Z"),
  });
  seeded.news = await moving.add({ from: "Lettre <news@lettre.example>", subject: "Nouveautés de novembre", text: "…", flags: ["\\Seen"], date: new Date("2026-11-25T08:00:00Z") });
  await gmail["home@sousa.test"].add({ from: "Client Home <client@home.example>", to: ["home@sousa.test"], subject: "Salle de bain", text: "Bonjour" });

  db = await database();
  await migrate(db);
  const hash = await bcrypt.hash("A-Strong-Test-Password", 4);
  for (const [email, role, company, extra] of [
    ["wm-admin@test.invalid", "admin", "group", {}],
    ["wm-manager@test.invalid", "manager", "home", {}],
    ["wm-lea@test.invalid", "employee", MOVING, { employee_id: "e1" }],
    ["wm-client@test.invalid", "client", MOVING, { client_id: "c1" }],
  ])
    await db.query("INSERT INTO users(email,password_hash,role,name,avatar,company,employee_id,client_id) VALUES($1,$2,$3,$4,'',$5,$6,$7)", [email, hash, role, "Compte " + role, company, extra.employee_id || null, extra.client_id || null]);
  const d = D.emptyState();
  d.companies.find((c) => c.id === "moving").id = MOVING;
  d.companies.find((c) => c.id === MOVING).billing = { iban: "CH9300762011623852957", street: "Rue Test", buildingNumber: "2", zip: "1000", city: "Lausanne", country: "CH", email: "factures@sousa.invalid" };
  d.employees = [{ id: "e1", company: MOVING, name: "Léa Martin", status: "Actif" }];
  d.clients = [{ id: "c1", company: MOVING, name: "Sophie Bernard", street: "Rue du Lac", buildingNumber: "4", zip: "1000", city: "Lausanne", country: "CH", email: "sophie@example.invalid" }];
  d.projects = [
    { id: "P-1", title: "Déménagement Bernard", clientId: "c1", company: MOVING, team: ["e1"], status: "En cours", address: "Rue du Lac 4" },
    { id: "P-HOME", title: "Salle de bain", clientId: "", company: "home", team: [], status: "En cours", address: "" },
  ];
  const admin = { id: 1, role: "admin", company: "group" };
  const invoice = D.applyCommand(d, admin, { action: "create", collection: "invoices", payload: { company: MOVING, clientId: "c1", title: "Déménagement", date: "2026-11-20", due: "2026-12-20", lines: [{ description: "Déménagement", quantity: 1, unit: "forfait", unitPrice: 1000, vatRate: 8.1, discount: 0 }] } }).result;
  D.applyCommand(d, admin, { action: "invoice.issue", payload: { id: invoice.id } });
  seeded.invoiceId = invoice.id;
  await db.query("UPDATE app_state SET data=$1 WHERE id=1", [JSON.stringify(d)]);
  server = createApp(db).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  url = "http://127.0.0.1:" + server.address().port;
  for (const who of ["admin", "manager", "lea", "client"]) {
    const r = await fetch(url + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `wm-${who}@test.invalid`, password: "A-Strong-Test-Password" }) });
    tokens[who] = (await r.json()).token;
    assert.ok(tokens[who], "login " + who);
  }
});

test.after(async () => {
  W._reset();
  server?.close();
  smtp?.close();
  provider?.close();
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
});

test("each Gmail account is a mailbox; administrators of the group see them all, others only what is granted", async () => {
  const admin = await call("webmail/status", "admin");
  assert.equal(admin.status, 200);
  assert.deepEqual(
    admin.data.mailboxes.map((b) => [b.id, b.label, b.address]).sort((a, b) => a[1].localeCompare(b[1])),
    [
      ["home", "Sousa Home Service", "home@sousa.test"],
      [MOVING, "Sousa Moving", "moving@sousa.test"],
    ],
  );
  assert.equal(admin.data.canManage, true);
  assert.deepEqual(admin.data.mailboxes.find((b) => b.id === MOVING).signature, { person: "Compte admin", company: "Sousa Moving", contact: "", extra: "", logo: "/assets/logos/moving.png" });
  for (const who of ["manager", "lea"]) assert.deepEqual((await call("webmail/status", who)).data.mailboxes, [], who + " has no access yet");
  assert.deepEqual((await call("webmail/status", "client")).data.mailboxes, []);
  assert.equal((await call(box("folders"), "lea")).status, 404);
  assert.equal((await call(box("messages?folder=inbox"), "client")).status, 403);

  assert.equal((await call("webmail/access", "manager")).status, 403);
  const access = await call("webmail/access", "admin");
  assert.equal(access.status, 200);
  const lea = access.data.users.find((u) => u.email === "wm-lea@test.invalid");
  assert.deepEqual(lea.granted, []);
  assert.ok(!access.data.users.some((u) => u.role === "client"), "clients are not listed");
  assert.deepEqual(access.data.users.find((u) => u.email === "wm-admin@test.invalid").automatic.sort(), ["home", MOVING].sort());

  const clientId = (await db.query("SELECT id FROM users WHERE email='wm-client@test.invalid'")).rows[0].id;
  assert.equal((await call("webmail/access", "admin", { userId: clientId, mailboxes: [MOVING] })).status, 400);
  const saved = await call("webmail/access", "admin", { userId: lea.id, mailboxes: [MOVING, "unknown-box"] });
  assert.deepEqual(saved.data.granted, [MOVING]);
  const leaStatus = await call("webmail/status", "lea");
  assert.deepEqual(leaStatus.data.mailboxes.map((b) => b.id), [MOVING]);
  assert.equal(leaStatus.data.canManage, false);
  assert.equal((await call("webmail/home/folders", "lea")).status, 404, "only the granted mailbox");
  const audit = (await db.query("SELECT action,metadata FROM audit_logs WHERE action='webmail.access'")).rows;
  assert.equal(audit.length, 1);
});

test("folders, unread counts, list newest first and Gmail search", async () => {
  const folders = await call(box("folders"), "admin");
  assert.equal(folders.status, 200);
  assert.deepEqual(
    folders.data.folders.map((f) => f.id),
    ["inbox", "flagged", "sent", "drafts", "all", "junk", "trash", "label:Clients"],
  );
  assert.equal(folders.data.folders.find((f) => f.id === "sent").name, "Messages envoyés");
  assert.equal(folders.data.folders[0].unseen, 3);
  const list = await call(box("messages?folder=inbox"), "admin");
  assert.deepEqual(list.data.messages.map((m) => m.subject), ["Nouveautés de novembre", "Devis déménagement juin", "Re: Facture du déménagement", "Facture du déménagement"]);
  const marc = list.data.messages[1];
  assert.equal(marc.attachments, 1, "the logo shown in the message is not counted");
  assert.equal(marc.from.address, "marc@exemple.ch");
  assert.equal(list.data.messages[2].threadId, "500");
  const found = await call(box("messages?folder=inbox&q=" + encodeURIComponent("lenoir")), "admin");
  assert.deepEqual(found.data.messages.map((m) => m.subject), ["Devis déménagement juin"]);
  assert.equal((await call(box("messages?folder=label:Nope"), "admin")).status, 404);
});

test("opening a message shows the whole conversation, our replies included, and marks it read", async () => {
  const conv = await call(box(`conversation?folder=inbox&uid=${seeded.last.id}`), "lea");
  assert.equal(conv.status, 200);
  assert.equal(conv.data.folder, "all");
  assert.deepEqual(conv.data.messages.map((m) => m.from.address), ["sophie@example.invalid", "moving@sousa.test", "sophie@example.invalid"]);
  assert.deepEqual(conv.data.messages.map((m) => m.seen), [false, true, false], "read state before opening");
  assert.equal(conv.data.messages[2].cc[0].address, "compta@example.invalid");
  assert.ok(!("body" in conv.data.messages[0]), "the message body is only served in its frame");
  assert.ok(seeded.first.flags.has("\\Seen") && seeded.last.flags.has("\\Seen"), "marked as read in Gmail");
  const inbox = await call(box("folders"), "admin");
  assert.equal(inbox.data.folders[0].unseen, 1);
});

test("a message is shown cleaned, in a frame without scripts, with remote images on request", async () => {
  const frame = await call(box(`frame?folder=inbox&uid=${seeded.marc.id}`), "admin");
  assert.equal(frame.status, 200);
  const html = frame.data.toString();
  const csp = frame.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /sandbox allow-same-origin allow-popups/);
  assert.doesNotMatch(csp, /allow-scripts/);
  assert.match(csp, /img-src data:;/);
  assert.doesNotMatch(html, /<script|onclick|javascript:/i);
  assert.match(html, /<img src="data:image\/png;base64,/);
  assert.match(html, /data-remote-src="https:\/\/tracker\.example\/p\.gif"/);
  const images = await call(box(`frame?folder=inbox&uid=${seeded.marc.id}&images=1`), "admin");
  assert.match(images.headers.get("content-security-policy"), /img-src data: https:/);
  assert.match(images.data.toString(), /<img src="https:\/\/tracker\.example\/p\.gif"/);
  const conv = await call(box(`conversation?folder=inbox&uid=${seeded.marc.id}`), "admin");
  assert.equal(conv.data.messages[0].remoteImages, true);
  assert.deepEqual(conv.data.messages[0].attachments.map((a) => a.filename), ["Plan été.pdf"]);
  const missing = await call(box(`frame?folder=inbox&uid=9999`), "admin");
  assert.equal(missing.status, 404);
  assert.match(missing.data.toString(), /Message introuvable/);
});

test("attachments are downloaded with their name, and opened only when the browser can show them safely", async () => {
  const conv = await call(box(`conversation?folder=inbox&uid=${seeded.marc.id}`), "admin");
  const part = conv.data.messages[0].attachments[0].part;
  const file = await call(box(`attachment?folder=all&uid=${conv.data.messages[0].uid}&part=${part}`), "admin");
  assert.equal(file.status, 200);
  assert.equal(file.data.toString(), "%PDF-1.4 plan");
  assert.equal(file.headers.get("content-type"), "application/octet-stream");
  assert.match(file.headers.get("content-disposition"), /^attachment; filename="Plan ete\.pdf"; filename\*=UTF-8''Plan%20%C3%A9t%C3%A9\.pdf$/);
  const inline = await call(box(`attachment?folder=all&uid=${conv.data.messages[0].uid}&part=${part}&inline=1`), "admin");
  assert.equal(inline.headers.get("content-type"), "application/pdf");
  assert.match(inline.headers.get("content-disposition"), /^inline;/);
  assert.equal((await call(box(`attachment?folder=all&uid=${conv.data.messages[0].uid}&part=../1`), "admin")).status, 404);
});

test("archive, labels, back to the inbox, trash and deletion follow Gmail's rules", async () => {
  const news = seeded.news.id;
  assert.equal((await call(box("action"), "admin", { folder: "inbox", uids: [news], action: "archive" })).data.done, 1);
  assert.ok(!seeded.news.labels.has("\\Inbox") && !seeded.news.trash, "archived: out of the inbox, still in All messages");
  assert.ok(moving.messagesIn("[Gmail]/Tous les messages").includes(seeded.news));
  await call(box("action"), "admin", { folder: "all", uids: [news], action: "inbox" });
  assert.ok(seeded.news.labels.has("\\Inbox"), "back to the inbox by label, never by moving out of All messages");
  await call(box("action"), "admin", { folder: "inbox", uids: [news], action: "move", target: "label:Clients" });
  assert.ok(seeded.news.labels.has("Clients") && !seeded.news.labels.has("\\Inbox"), "« move to » adds the label and leaves the inbox");
  await call(box("action"), "admin", { folder: "label:Clients", uids: [news], action: "star" });
  assert.ok(seeded.news.flags.has("\\Flagged"));
  await call(box("action"), "admin", { folder: "label:Clients", uids: [news], action: "unread" });
  assert.ok(!seeded.news.flags.has("\\Seen"));
  const refused = await call(box("action"), "admin", { folder: "label:Clients", uids: [news], action: "delete" });
  assert.equal(refused.status, 400);
  await call(box("action"), "admin", { folder: "label:Clients", uids: [news], action: "trash" });
  assert.ok(seeded.news.trash);
  await call(box("action"), "admin", { folder: "trash", uids: [news], action: "delete" });
  assert.ok(seeded.news.deleted);
  // A whole conversation at once, by its Gmail thread.
  await call(box("action"), "admin", { folder: "inbox", threads: ["500"], action: "unread" });
  assert.ok(!seeded.first.flags.has("\\Seen") && !seeded.last.flags.has("\\Seen"));
  await call(box("action"), "admin", { folder: "inbox", threads: ["500"], action: "read" });
  assert.equal((await call(box("action"), "admin", { folder: "inbox", uids: [1], action: "explode" })).status, 400);
});

test("replying keeps the conversation, quotes the message, and is recorded", async () => {
  const before = sent.length;
  const reply = await call(box("send"), "lea", {
    mode: "replyAll",
    ref: { folder: "all", uid: seeded.last.id },
    to: "sophie@example.invalid",
    cc: "compta@example.invalid",
    subject: "Re: Facture du déménagement",
    text: "Bonjour Madame Bernard,\nC’est bien noté.\n\n--\nLéa Martin",
    uploads: [{ name: "conditions.pdf", type: "application/pdf", data: Buffer.from("%PDF conditions").toString("base64") }],
  });
  assert.equal(reply.status, 200, JSON.stringify(reply.data));
  assert.equal(sent.length, before + 1);
  const raw = decode(sent.at(-1).raw);
  assert.match(raw, /^From: Sousa Moving <moving@sousa\.test>/m);
  assert.match(raw, /^Cc: compta@example\.invalid/m);
  assert.match(raw, /^Reply-To: moving@sousa\.test/m);
  assert.match(raw, /^In-Reply-To: <sophie-2@example\.invalid>/m);
  assert.match(raw, /^References: <sophie-1@example\.invalid> <ours-1@sousa\.test>\s+<sophie-2@example\.invalid>|<sophie-1@example\.invalid> <ours-1@sousa\.test> <sophie-2@example\.invalid>/m);
  assert.match(raw, /Sophie Bernard <sophie@example\.invalid> a écrit :/);
  assert.match(raw, /> Parfait, merci !/);
  assert.match(raw, /filename=conditions\.pdf/);
  assert.ok(seeded.last.flags.has("\\Answered"), "the message answered is marked in Gmail");
  const log = (await db.query("SELECT kind,status,company,entity_type,entity_id,recipient FROM email_log ORDER BY created_at DESC LIMIT 1")).rows[0];
  assert.deepEqual([log.kind, log.status, log.company, log.entity_type, log.entity_id], ["webmail", "sent", MOVING, "clients", "c1"]);

  const forward = await call(box("send"), "admin", { mode: "forward", ref: { folder: "inbox", uid: seeded.marc.id }, to: "equipe@sousa.test", subject: "Fwd: Devis déménagement juin", text: "Pour info." });
  assert.equal(forward.status, 200, JSON.stringify(forward.data));
  const fwd = decode(sent.at(-1).raw);
  assert.match(fwd, /---------- Message transféré ----------/);
  assert.match(sent.at(-1).raw, /JVBERi0xLjQgcGxhbg/, "the PDF goes with the forward");
  assert.ok(!seeded.marc.flags.has("\\Answered"), "a forward is not an answer");

  for (const [body, pattern] of [
    [{ to: "", subject: "x", text: "y" }, /au moins un destinataire/],
    [{ to: "pas-une-adresse", subject: "x", text: "y" }, /Adresse e-mail invalide \(destinataire\)/],
    [{ to: "a@b.ch", cc: "faux", subject: "x", text: "y" }, /\(copie\)/],
    [{ to: "a@b.ch", subject: "", text: "  " }, /objet ou un message/],
    [{ to: "a@b.ch", subject: "x", text: "y", uploads: [{ name: "vide.txt", data: "" }] }, /vide/],
  ]) {
    const r = await call(box("send"), "admin", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.data.error, pattern);
  }
  const outsider = await call("webmail/home/send", "lea", { to: "a@b.ch", subject: "x", text: "y" });
  assert.equal(outsider.status, 404, "Léa cannot send from a mailbox she cannot open");
});

test("new messages: one notification for everyone who may open the mailbox, the first check only records", async () => {
  const { checkNewMail } = require("../webmail-routes");
  await db.query("DELETE FROM user_notifications");
  const first = await checkNewMail(db);
  assert.equal(first.checked, 2);
  assert.equal(first.fresh, 0);
  await moving.add({ from: "Paul Rochat <paul@rochat.example>", subject: "Garde-meuble", text: "Avez-vous de la place ?" });
  await moving.add({ from: "Sousa Moving <moving@sousa.test>", subject: "Copie à moi-même", text: "x" });
  await moving.add({ from: "Déjà lu <lu@example.invalid>", subject: "Lu sur le téléphone", text: "x", flags: ["\\Seen"] });
  const second = await checkNewMail(db);
  assert.equal(second.fresh, 1);
  const notes = (await db.query("SELECT u.email,n.category,n.title,n.body,n.url FROM user_notifications n JOIN users u ON u.id=n.user_id ORDER BY u.email")).rows;
  assert.deepEqual(
    notes.map((n) => [n.email, n.category, n.title, n.body, n.url]),
    [
      ["wm-admin@test.invalid", "mail", "Nouvel e-mail de Paul Rochat", "Garde-meuble · Sousa Moving", `/?open=mailbox&box=${MOVING}`],
      ["wm-lea@test.invalid", "mail", "Nouvel e-mail de Paul Rochat", "Garde-meuble · Sousa Moving", `/?open=mailbox&box=${MOVING}`],
    ],
  );
  assert.equal((await checkNewMail(db)).fresh, 0, "each message is reported once");
  const status = await call("webmail/status", "lea");
  assert.equal(status.data.mailboxes[0].unread, 2, "unread count for the menu, as in Gmail (the copy to ourselves too)");
  // Someone who turned the « Nouveaux e-mails » notifications off gets none.
  const leaId = (await db.query("SELECT id FROM users WHERE email='wm-lea@test.invalid'")).rows[0].id;
  await db.query("INSERT INTO account_preferences(user_id,data) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET data=EXCLUDED.data", [leaId, JSON.stringify({ notifications: { mail: false } })]);
  await moving.add({ from: "Nina <nina@example.invalid>", subject: "Question", text: "?" });
  await checkNewMail(db);
  const nina = (await db.query("SELECT user_id FROM user_notifications WHERE body LIKE 'Question%'")).rows;
  assert.equal(nina.length, 1, "only the administrator");
});

test("the assistant summarises a conversation and proposes a reply using what we know about the client", async () => {
  const summary = await call(box("ai"), "admin", { folder: "inbox", uid: seeded.last.id, mode: "summary" });
  assert.equal(summary.status, 200, JSON.stringify(summary.data));
  assert.match(summary.data.text, /À faire : rien/);
  assert.match(aiPrompts.at(-1).user, /Je paie la facture à la fin du mois/);
  assert.doesNotMatch(aiPrompts.at(-1).user, /> Merci pour votre message/, "quoted text is left out");
  const reply = await call(box("ai"), "admin", { folder: "inbox", uid: seeded.last.id, mode: "reply", instruction: "remercier" });
  assert.equal(reply.status, 200);
  assert.match(reply.data.text, /^Bonjour Madame Bernard/);
  assert.match(aiPrompts.at(-1).user, /Consigne : remercier/);
  assert.match(aiPrompts.at(-1).user, new RegExp(`Client connu : Sophie Bernard\\. Factures ouvertes : ${seeded.invoiceId}`));
  assert.match(aiPrompts.at(-1).system, /n’invente jamais un prix/);
  // An employee who may read the mailbox still does not see the invoices.
  assert.equal((await call(box("ai"), "lea", { folder: "inbox", uid: seeded.last.id, mode: "reply" })).status, 200);
  assert.doesNotMatch(aiPrompts.at(-1).user, /Factures ouvertes/);
  const usage = (await db.query("SELECT feature FROM ai_usage ORDER BY feature")).rows.map((r) => r.feature);
  assert.deepEqual([...new Set(usage)], ["mail_reply", "mail_summary"]);
});

test("a refused Gmail password is explained in plain words", async () => {
  password = "changed-password";
  W._reset();
  try {
    const r = await call(box("folders"), "admin");
    assert.equal(r.status, 502);
    assert.equal(r.data.error, "Gmail a refusé la connexion à moving@sousa.test : vérifiez le mot de passe d’application.");
  } finally {
    password = PASS;
    W._reset();
  }
});

test("cleaning a message: scripts, events, forms and dangerous links go; quotes fold away", () => {
  const { html, remote, quoted } = W.sanitizeHtml(
    '<html><head><meta http-equiv="refresh" content="0;url=https://evil"><base href="https://evil/"><style onload="x()">p{color:red}</style></head>' +
      '<body onload="x()"><form action="https://evil"><input name="pw"><button>OK</button></form><iframe src="https://evil"></iframe>' +
      '<a href="java&#x0A;script:alert(1)">a</a><a href="mailto:x@y.ch">b</a><img src="cid:none"><svg><script>alert(2)</script></svg>' +
      '<div style="background:url(https://track.example/x.png)">c</div><blockquote type="cite">ancien</blockquote></body></html>',
  );
  assert.doesNotMatch(html, /<script|<iframe|<meta|<base|<form|<input|<button|onload|javascript|http-equiv/i);
  assert.match(html, /<a href="mailto:x@y\.ch" target="_blank" rel="noopener noreferrer">b<\/a>/);
  assert.match(html, /<details class="q"><summary title="Afficher le message précédent">•••<\/summary><blockquote type="cite">ancien<\/blockquote><\/details>/);
  assert.equal(remote, 1);
  assert.equal(quoted, true);
  assert.match(W.textToHtml("Salut\nhttps://a.ch/?x=1&y=2\n\nOn Mon, Bob wrote:\n> old").html, /<a href="https:\/\/a\.ch\/\?x=1&amp;y=2"[^>]*>.*<details class="q">/s);
});

// ---------------------------------------------------------------------------
// Writing: 10 seconds to cancel, programmed sending, drafts, formatting, signature, quick
// replies, pieces of the application; filing in documents; reminders.
// ---------------------------------------------------------------------------
const C = require("../webmail-compose");
const O = require("../webmail-organize");

test("after « Envoyer » there are 10 seconds to cancel, then the message leaves", async () => {
  process.env.WEBMAIL_UNDO_SECONDS = "10";
  try {
    const before = sent.length;
    const queued = await call(box("send"), "admin", { to: "client@exemple.ch", subject: "Annulé", html: "<p>Test</p>" });
    assert.equal(queued.status, 200, JSON.stringify(queued.data));
    assert.equal(queued.data.sent, false);
    assert.equal(queued.data.kind, "undo");
    assert.ok(new Date(queued.data.sendAt) - Date.now() > 8000);
    const cancelled = await call(box(`outbox/${queued.data.id}/cancel`), "admin", {});
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.data.compose.subject, "Annulé");
    assert.equal((await call(box(`outbox/${queued.data.id}`), "admin")).data.status, "cancelled");
    assert.equal((await call(box(`outbox/${queued.data.id}/cancel`), "admin", {})).status, 404, "only once");

    const second = await call(box("send"), "admin", { to: "client@exemple.ch", subject: "Parti", html: "<p>Test</p>" });
    assert.equal((await C.processOutbox(db)).sent, 0, "not before its time");
    const run = await C.processOutbox(db, { now: new Date(Date.now() + 15000) });
    assert.equal(run.sent, 1);
    assert.equal(sent.length, before + 1);
    assert.match(decode(sent.at(-1).raw), /^Subject: Parti/m);
    const status = await call(box(`outbox/${second.data.id}`), "admin");
    assert.equal(status.data.status, "sent");
    const late = await call(box(`outbox/${second.data.id}/cancel`), "admin", {});
    assert.equal(late.status, 409);
    assert.match(late.data.error, /déjà parti/);
    assert.equal((await db.query("SELECT payload FROM webmail_outbox WHERE id=$1", [second.data.id])).rows[0].payload, null, "the copy is removed once sent");
  } finally {
    process.env.WEBMAIL_UNDO_SECONDS = "0";
  }
});

test("programmed sending: listed, sent at its time, or put back in « Brouillons »", async () => {
  const at = new Date(Date.now() + 2 * 3600000).toISOString();
  assert.equal((await call(box("send"), "admin", { to: "a@b.ch", subject: "x", html: "y", sendAt: new Date(Date.now() + 5000).toISOString() })).status, 400, "at least a minute ahead");
  const planned = await call(box("send"), "lea", { to: "sophie@example.invalid", subject: "Rendez-vous de lundi", html: "<p>À lundi.</p>", sendAt: at });
  assert.equal(planned.status, 200, JSON.stringify(planned.data));
  assert.equal(planned.data.kind, "scheduled");
  const other = await call(box("send"), "lea", { to: "sophie@example.invalid", subject: "Brouillon programmé", html: "<p>Texte</p>", sendAt: at, uploads: [{ name: "plan.pdf", type: "application/pdf", data: Buffer.from("%PDF plan").toString("base64") }] });
  const list = await call(box("outbox"), "admin");
  assert.deepEqual(list.data.messages.map((m) => m.subject).sort(), ["Brouillon programmé", "Rendez-vous de lundi"]);
  assert.equal(list.data.messages[0].by, "Compte employee");

  const back = await call(box(`outbox/${other.data.id}/cancel`), "lea", { draft: true });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.ok(back.data.draft.uid > 0, "saved in Gmail's drafts");
  const draft = moving.store.messages.find((m) => m.id === back.data.draft.uid);
  assert.ok(draft.flags.has("\\Draft"));
  assert.match(draft.source.toString(), /X-SGO-Compose:/i);
  const reopened = await call(box(`draft?uid=${draft.id}`), "lea");
  assert.equal(reopened.data.subject, "Brouillon programmé");
  assert.deepEqual(reopened.data.attachments.map((a) => a.filename), ["plan.pdf"]);

  const before = sent.length;
  const run = await C.processOutbox(db, { now: new Date(Date.now() + 3 * 3600000) });
  assert.equal(run.sent, 1);
  assert.equal(sent.length, before + 1);
  assert.match(decode(sent.at(-1).raw), /Rendez-vous de lundi/);
  assert.deepEqual((await call(box("outbox"), "admin")).data.messages, []);
});

test("formatting is kept, anything else removed, and the signature carries the company's logo", async () => {
  const r = await call(box("send"), "lea", {
    to: "client@exemple.ch",
    subject: "Mise en forme",
    html: '<p>Bonjour <b>Madame</b>,</p><ul><li>point <i>un</i></li></ul><p><a href="https://sousa.ch">site</a> <a href="javascript:alert(1)">piège</a></p><script>alert(2)</script><img src="https://tracker.example/x.png" onerror="x()">',
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const raw = decode(sent.at(-1).raw);
  assert.match(raw, /Bonjour <b>Madame<\/b>,/);
  assert.match(raw, /<li>point <i>un<\/i><\/li>/);
  assert.match(raw, /<a href="https:\/\/sousa\.ch" target="_blank">site<\/a> piège/);
  assert.doesNotMatch(raw, /<script|javascript:|tracker\.example|onerror/);
  assert.match(raw, /cid:signature-logo@sousa/);
  assert.match(raw, /Content-Type: image\/png/);
  assert.match(raw, /--\nCompte employee\nSousa Moving/, "signature in the text version");
  assert.match(raw, /- point un/, "readable text version");
  await call(box("send"), "lea", { to: "client@exemple.ch", subject: "Sans signature", html: "<p>Court.</p>", signature: false });
  assert.doesNotMatch(decode(sent.at(-1).raw), /signature-logo/);
  const status = await call("webmail/status", "lea");
  assert.deepEqual(Object.keys(status.data.mailboxes[0].signature).sort(), ["company", "contact", "extra", "logo", "person"]);
  assert.equal(status.data.mailboxes[0].signature.logo, "/assets/logos/moving.png");
});

test("invoices, quotes and documents of the application can be attached, as the person may see them", async () => {
  const r = await call(box("send"), "admin", { to: "sophie@example.invalid", subject: "Votre facture", html: "<p>Ci-joint.</p>", appFiles: [{ kind: "invoices", id: seeded.invoiceId }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const raw = sent.at(-1).raw;
  assert.match(raw, new RegExp(`filename=${seeded.invoiceId}\\.pdf`));
  assert.match(raw, /Content-Type: application\/pdf/);
  const refused = await call(box("send"), "lea", { to: "a@b.ch", subject: "x", html: "y", appFiles: [{ kind: "invoices", id: seeded.invoiceId }] });
  assert.equal(refused.status, 403);
  const unknown = await call(box("send"), "admin", { to: "a@b.ch", subject: "x", html: "y", appFiles: [{ kind: "documents", id: "nope" }] });
  assert.equal(unknown.status, 403);
});

test("a draft is kept in Gmail, reopened with its attachments, and removed once sent", async () => {
  const saved = await call(box("draft"), "lea", { to: "", subject: "Brouillon en cours", html: "<p>Pas fini</p>", uploads: [{ name: "photo.png", type: "image/png", data: Buffer.from("png").toString("base64") }] });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.deepEqual(saved.data.attachments.map((a) => a.filename), ["photo.png"]);
  const again = await call(box("draft"), "lea", { to: "sophie@example.invalid", subject: "Brouillon en cours", html: "<p>Presque fini</p>", draftUid: saved.data.uid, draftParts: saved.data.attachments.map((a) => a.part) });
  assert.ok(moving.store.messages.find((m) => m.id === saved.data.uid).deleted, "the previous version is replaced");
  const list = await call(box("messages?folder=drafts"), "lea");
  assert.ok(list.data.messages.some((m) => m.uid === again.data.uid && m.draft));
  const open = await call(box(`draft?uid=${again.data.uid}`), "lea");
  assert.deepEqual([open.data.to, open.data.subject, open.data.mode], [["sophie@example.invalid"], "Brouillon en cours", "new"]);
  assert.match(open.data.html, /Presque fini/);
  const send = await call(box("send"), "lea", { to: "sophie@example.invalid", subject: "Brouillon en cours", html: open.data.html, draftUid: again.data.uid, draftParts: open.data.attachments.map((a) => a.part) });
  assert.equal(send.status, 200, JSON.stringify(send.data));
  assert.match(sent.at(-1).raw, /filename=photo\.png/);
  assert.ok(moving.store.messages.find((m) => m.id === again.data.uid).deleted, "sent: the draft is removed");
});

test("quick replies are shared by everyone who opens the mailbox", async () => {
  const created = await call(box("snippets"), "lea", { title: "Envoi du devis", html: "<p>Bonjour,</p><p>Vous trouverez <b>notre devis</b> ci-joint.</p><script>x()</script>" });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const list = await call(box("snippets"), "admin");
  assert.deepEqual(list.data.snippets.map((x) => x.title), ["Envoi du devis"]);
  assert.doesNotMatch(list.data.snippets[0].html, /script/);
  assert.equal((await call(box("snippets"), "lea", { id: created.data.id, title: "Devis envoyé", html: "<p>Merci</p>" })).status, 200);
  assert.equal((await call(box("snippets"), "admin")).data.snippets[0].title, "Devis envoyé");
  assert.equal((await call(box("snippets"), "lea", { title: "", html: "<p>x</p>" })).status, 400);
  assert.equal((await call(box("snippets"), "manager")).status, 404, "not for someone without the mailbox");
  await call(box(`snippets/${created.data.id}/delete`), "admin", {});
  assert.deepEqual((await call(box("snippets"), "admin")).data.snippets, []);
});

test("an e-mail and its attachments are filed in a site's documents", async () => {
  const conv = await call(box(`conversation?folder=inbox&uid=${seeded.marc.id}`), "admin");
  const m = conv.data.messages[0];
  const r = await call(box("file"), "lea", { folder: m.folder, uid: m.uid, target: { type: "project", id: "P-1" }, message: true, parts: m.attachments.map((a) => a.part) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.target, "Déménagement Bernard");
  assert.equal(r.data.saved.length, 2);
  const state = (await require("../db").loadState(db)).data;
  const docs = state.documents.filter((d) => d.project === "P-1");
  assert.deepEqual(docs.map((d) => [d.name, d.category, d.company]), [
    ["E-mail 2026-11-25 Devis déménagement juin.pdf", "E-mail", MOVING],
    ["Plan été.pdf", "E-mail", MOVING],
  ]);
  const pdf = await require("../storage").loadFile(db, docs[0].id);
  assert.equal(Buffer.from(pdf.content).subarray(0, 5).toString(), "%PDF-");
  assert.equal(Buffer.from((await require("../storage").loadFile(db, docs[1].id)).content).toString(), "%PDF-1.4 plan");
  const other = await call(box("file"), "lea", { folder: m.folder, uid: m.uid, target: { type: "project", id: "P-HOME" }, message: true });
  assert.equal(other.status, 403, "not in a site of another company");
  assert.equal((await call(box("file"), "lea", { folder: m.folder, uid: m.uid, target: { type: "project", id: "P-1" }, message: false, parts: [] })).status, 400);
});

test("« Me le rappeler »: the conversation leaves the inbox and comes back unread, with a notification", async () => {
  const thread = await moving.add({ from: "Paul Rochat <paul@rochat.example>", subject: "Visite du garde-meuble", text: "Quand pouvons-nous venir ?", threadId: 900 });
  const at = new Date(Date.now() + 26 * 3600000).toISOString();
  assert.equal((await call(box("remind"), "lea", { folder: "inbox", uid: thread.id, threadId: "900", at: new Date(Date.now() - 1000).toISOString() })).status, 400);
  const r = await call(box("remind"), "lea", { folder: "inbox", uid: thread.id, threadId: "900", at });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.archived, true);
  assert.ok(!thread.labels.has("\\Inbox"), "out of the inbox until then");
  const list = await call(box("reminders"), "admin");
  assert.deepEqual(list.data.reminders.map((x) => [x.subject, x.sender]), [["Visite du garde-meuble", "Paul Rochat <paul@rochat.example>"]]);
  assert.equal((await O.processReminders(db)).done, 0, "not yet");
  thread.flags.add("\\Seen");
  await db.query("DELETE FROM user_notifications");
  assert.equal((await O.processReminders(db, { now: new Date(Date.now() + 27 * 3600000) })).done, 1);
  assert.ok(thread.labels.has("\\Inbox") && !thread.flags.has("\\Seen"), "back in the inbox, unread");
  const notes = (await db.query("SELECT u.email,n.title,n.body FROM user_notifications n JOIN users u ON u.id=n.user_id")).rows;
  assert.deepEqual(notes.map((n) => [n.email, n.title, n.body]), [["wm-lea@test.invalid", "Rappel : Visite du garde-meuble", "Paul Rochat <paul@rochat.example> · Sousa Moving"]]);
  assert.deepEqual((await call(box("reminders"), "admin")).data.reminders, []);

  // Cancelling brings the conversation back at once.
  await call(box("remind"), "lea", { folder: "inbox", uid: thread.id, threadId: "900", at });
  assert.ok(!thread.labels.has("\\Inbox"));
  const id = (await call(box("reminders"), "lea")).data.reminders[0].id;
  assert.equal((await call(box(`reminders/${id}/cancel`), "lea", {})).status, 200);
  assert.ok(thread.labels.has("\\Inbox"));
});
