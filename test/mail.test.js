"use strict";
// E-mails through a fake SMTP server: invoices with their PDF, assistant messages,
// a refused Gmail login, and the automatic payment reminders.
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const bcrypt = require("bcryptjs");
const { database } = require("./database");
const { migrate } = require("../db");
const { createApp } = require("../server");
const D = require("../domain");

process.env.JWT_SECRET = "test-only-secret-with-at-least-32-characters";
const ENV = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS", "SMTP_USER_HOME", "SMTP_PASS_HOME", "SMTP_USER_MOVING", "SMTP_PASS_MOVING", "MAIL_FROM_NAME", "MAIL_REPLY_TO", "AI_API_URL", "AI_API_KEY"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
let db, server, smtp, url;
const tokens = {};
const messages = [];

// A minimal SMTP server: AUTH PLAIN with one password, then records each message.
function fakeSmtp(password) {
  return net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "",
      inData = false,
      current = null;
    const send = (line) => socket.write(line + "\r\n");
    send("220 fake.smtp ESMTP");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            messages.push(current);
            send("250 2.0.0 queued");
          } else current.raw += (line.startsWith("..") ? line.slice(1) : line) + "\n";
          continue;
        }
        const command = line.toUpperCase();
        if (command.startsWith("EHLO") || command.startsWith("HELO")) socket.write("250-fake.smtp\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
        else if (command.startsWith("AUTH PLAIN")) {
          const parts = Buffer.from(line.split(" ")[2] || "", "base64").toString().split("\0");
          send(parts[2] === password() ? "235 2.7.0 accepted" : "535 5.7.8 bad credentials");
        } else if (command.startsWith("MAIL FROM")) {
          current = { from: line, to: [], raw: "" };
          send("250 ok");
        } else if (command.startsWith("RCPT TO")) {
          current.to.push(line);
          send("250 ok");
        } else if (command === "DATA") {
          inData = true;
          send("354 go ahead");
        } else if (command === "QUIT") {
          send("221 bye");
          socket.end();
        } else send("250 ok");
      }
    });
    socket.on("error", () => {});
  });
}

let smtpPassword = "app-password-16c";
const MOVING_ID = "62595bda-dfc6-44c2-8aed-804a3183806f";
const fixture = () => {
  const d = D.emptyState();
  d.clients = [
    { id: "c1", company: "home", name: "Sophie Bernard", street: "Rue du Lac", buildingNumber: "4", zip: "1000", city: "Lausanne", country: "CH", email: "sophie@example.invalid" },
    { id: "c2", company: "home", name: "Sans E-mail SA", street: "Rue B", buildingNumber: "1", zip: "1000", city: "Lausanne", country: "CH", email: "" },
  ];
  // Like on the live installation: a company created in the application has a generated id.
  d.companies.find((c) => c.id === "moving").id = MOVING_ID;
  d.companies.find((c) => c.id === "home").billing = { iban: "CH9300762011623852957", street: "Rue Test", buildingNumber: "2", zip: "1000", city: "Lausanne", country: "CH", email: "factures@sousa.invalid" };
  const admin = { id: 1, role: "admin", company: "group" };
  const invoice = (clientId, date, due) => {
    const created = D.applyCommand(d, admin, {
      action: "create",
      collection: "invoices",
      payload: { company: "home", clientId, title: "Travaux", date, due, valid: due, lines: [{ description: "Pose de prises", quantity: 2, unit: "pce", unitPrice: 100, vatRate: 8.1, discount: 0 }] },
    }).result;
    D.applyCommand(d, admin, { action: "invoice.issue", payload: { id: created.id } });
    return created.id;
  };
  const ids = {
    recent: invoice("c1", "2026-10-19", "2026-11-18"),
    old: invoice("c1", "2026-09-01", "2026-10-01"),
    noEmail: invoice("c2", "2026-10-19", "2026-11-18"),
  };
  const draft = D.applyCommand(d, admin, {
    action: "create",
    collection: "invoices",
    payload: { company: "home", clientId: "c1", title: "Brouillon", date: "2026-11-20", due: "2026-12-20", lines: [{ description: "x", quantity: 1, unit: "pce", unitPrice: 10, vatRate: 8.1, discount: 0 }] },
  }).result;
  ids.draft = draft.id;
  return { d, ids };
};
let ids;

async function call(path, who, body) {
  const response = await fetch(url + "/api/" + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + tokens[who], ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

test.before(async () => {
  smtp = fakeSmtp(() => smtpPassword).listen(0, "127.0.0.1");
  await new Promise((r) => smtp.once("listening", r));
  for (const k of ENV) delete process.env[k];
  db = await database();
  await migrate(db);
  const hash = await bcrypt.hash("A-Strong-Test-Password", 4);
  for (const [email, role, company, clientId] of [
    ["mail-admin@test.invalid", "admin", "group", null],
    ["mail-manager@test.invalid", "manager", "home", null],
    ["mail-client@test.invalid", "client", "home", "c1"],
  ])
    await db.query("INSERT INTO users(email,password_hash,role,name,avatar,company,client_id) VALUES($1,$2,$3,$4,'',$5,$6)", [email, hash, role, "Compte " + role, company, clientId]);
  const built = fixture();
  ids = built.ids;
  await db.query("UPDATE app_state SET data=$1 WHERE id=1", [JSON.stringify(built.d)]);
  server = createApp(db).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  url = "http://127.0.0.1:" + server.address().port;
  for (const who of ["admin", "manager", "client"]) {
    const r = await fetch(url + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `mail-${who}@test.invalid`, password: "A-Strong-Test-Password" }),
    });
    tokens[who] = (await r.json()).token;
  }
});

test.after(async () => {
  server?.close();
  smtp?.close();
  await db?.end?.();
  for (const [k, v] of Object.entries(saved))
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  require("../mailer")._reset();
});

const configure = () =>
  Object.assign(process.env, {
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(smtp.address().port),
    SMTP_SECURE: "false",
    SMTP_USER: "sousagroup.test@example.invalid",
    SMTP_PASS: "app-password-16c",
    MAIL_FROM_NAME: "Sousa Group One",
  });

test("without configuration, the application says so and sends nothing", async () => {
  const status = await call("mail/status", "admin");
  assert.equal(status.data.configured, false);
  const out = await call("mail/finance/invoices/" + ids.recent, "admin", {});
  assert.equal(out.status, 503);
  assert.match(out.data.error, /Aucune adresse Gmail n’est configurée pour Sousa Home Service/);
  assert.equal((await call("mail/status", "client")).status, 403);
});

test("an issued invoice is sent with its PDF, and the sending is recorded", async () => {
  configure();
  const status = await call("mail/status", "admin");
  assert.equal(status.data.configured, true);
  assert.equal(status.data.companies.find((c) => c.id === "home").address, "sousagroup.test@example.invalid");
  const before = messages.length;
  const out = await call("mail/finance/invoices/" + ids.recent, "admin", { subject: "Votre facture", text: "Bonjour,\n\nVoici la facture." });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.equal(out.data.to, "sophie@example.invalid");
  const message = messages[before];
  assert.match(message.to[0], /sophie@example\.invalid/);
  assert.match(message.raw, /Subject: Votre facture/);
  assert.match(message.raw, /Reply-To: factures@sousa\.invalid/);
  assert.match(message.raw, /Content-Type: application\/pdf; name=.?F-2026-\d+\.pdf/);
  assert.match(message.raw, /From: Sousa Home Service <sousagroup\.test@example\.invalid>/, "the company name is shown");
  const log = await call(`mail/log?entityType=invoices&entityId=${ids.recent}`, "admin");
  assert.equal(log.data.emails[0].status, "sent");
  assert.equal(log.data.emails[0].kind, "invoice");
  assert.ok(!("text" in log.data.emails[0]), "the content is not stored");
  // Drafts are not sent; only finance roles send documents.
  assert.equal((await call("mail/finance/invoices/" + ids.draft, "admin", {})).status, 400);
  assert.equal((await call("mail/finance/invoices/" + ids.recent, "manager", {})).status, 403);
  assert.equal((await call("mail/finance/invoices/" + ids.recent, "client", {})).status, 403);
});

test("each company sends from its own Gmail account, with its own name", async () => {
  configure();
  Object.assign(process.env, { SMTP_USER_HOME: "sousa.home@example.invalid", SMTP_PASS_HOME: "home-app-pass" });
  smtpPassword = "home-app-pass";
  try {
    const status = await call("mail/status", "admin");
    const home = status.data.companies.find((c) => c.id === "home");
    const tech = status.data.companies.find((c) => c.id === "tech");
    assert.deepEqual([home.address, home.own], ["sousa.home@example.invalid", true]);
    assert.deepEqual([tech.address, tech.own], ["sousagroup.test@example.invalid", false], "the default account covers the others");
    const before = messages.length;
    const out = await call("mail/finance/invoices/" + ids.recent, "admin", {});
    assert.equal(out.status, 200, JSON.stringify(out.data));
    assert.equal(out.data.from, "sousa.home@example.invalid");
    assert.match(messages[before].raw, /From: Sousa Home Service <sousa\.home@example\.invalid>/);
    assert.match(messages[before].from, /sousa\.home@example\.invalid/);
    const test = await call("mail/test", "admin", { company: "home" });
    assert.equal(test.data.from, "sousa.home@example.invalid");
    assert.equal((await call("mail/test", "admin", { company: "unknown" })).status, 403);
  } finally {
    delete process.env.SMTP_USER_HOME;
    delete process.env.SMTP_PASS_HOME;
    smtpPassword = "app-password-16c";
  }
});

test("a company with a generated id is found by its name (SMTP_USER_MOVING for Sousa Moving)", async () => {
  configure();
  Object.assign(process.env, { SMTP_USER_MOVING: "sousa.moving@example.invalid", SMTP_PASS_MOVING: "moving-app-pass" });
  smtpPassword = "moving-app-pass";
  try {
    const status = await call("mail/status", "admin");
    const moving = status.data.companies.find((c) => c.name === "Sousa Moving");
    assert.equal(moving.id, MOVING_ID);
    assert.deepEqual([moving.address, moving.own], ["sousa.moving@example.invalid", true]);
    const before = messages.length;
    const out = await call("mail/test", "admin", { company: MOVING_ID });
    assert.equal(out.status, 200, JSON.stringify(out.data));
    assert.equal(out.data.from, "sousa.moving@example.invalid");
    assert.match(messages[before].raw, /From: Sousa Moving <sousa\.moving@example\.invalid>/);
  } finally {
    delete process.env.SMTP_USER_MOVING;
    delete process.env.SMTP_PASS_MOVING;
    smtpPassword = "app-password-16c";
  }
});

test("a refused Gmail login is explained in plain words and recorded as failed", async () => {
  configure();
  smtpPassword = "another-password";
  try {
    const out = await call("mail/test", "admin", {});
    assert.equal(out.status, 502);
    assert.match(out.data.error, /mot de passe d’application/);
    assert.doesNotMatch(out.data.error, /app-password-16c/);
    const log = await call("mail/log?limit=5", "admin");
    assert.equal(log.data.emails[0].kind, "test");
    assert.equal(log.data.emails[0].status, "failed");
  } finally {
    smtpPassword = "app-password-16c";
  }
  const ok = await call("mail/test", "admin", {});
  assert.equal(ok.status, 200);
  assert.equal(ok.data.to, "sousagroup.test@example.invalid");
});

test("a message prepared with the assistant can be sent, with the invoice attached", async () => {
  configure();
  const before = messages.length;
  const out = await call("mail/client-message", "admin", {
    kind: "invoice_reminder",
    id: ids.recent,
    to: "sophie@example.invalid",
    subject: "Rappel : facture " + ids.recent,
    body: "Bonjour,\n\nPetit rappel.\n\nMeilleures salutations",
  });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.equal(out.data.attached, true);
  assert.match(messages[before].raw, /application\/pdf/);
  // A manager cannot see invoices, so cannot send about them.
  assert.equal((await call("mail/client-message", "manager", { kind: "invoice_reminder", id: ids.recent, to: "x@example.invalid", subject: "x", body: "x" })).status, 403);
});

test("automatic reminders are opt-in, never retroactive, and sent once per stage", async () => {
  configure();
  const { processEmailReminders } = require("../mail-routes");
  const wednesday = new Date("2026-11-25T09:00:00Z"); // 10:00 in Zurich
  assert.equal((await processEmailReminders(db, wednesday)).sent, 0, "off by default");
  assert.equal((await call("mail/reminders", "manager", { enabled: true })).status, 403);
  const on = await call("mail/reminders", "admin", { enabled: true });
  assert.equal(on.data.enabled, true);
  // Pretend the reminders were switched on a few days ago.
  await db.query("UPDATE integration_settings SET config=jsonb_set(config,'{enabledAt}','\"2026-11-20T08:00:00Z\"') WHERE provider='invoice_email_reminders'");
  const before = messages.length;
  assert.equal((await processEmailReminders(db, new Date("2026-11-28T09:00:00Z"))).sent, 0, "not on Saturdays");
  const first = await processEmailReminders(db, wednesday);
  assert.equal(first.sent, 1, "only the invoice that reached J+7 after activation");
  const reminder = messages[before];
  assert.match(reminder.raw, /Subject: Rappel : facture/);
  assert.match(reminder.raw, /application\/pdf/);
  assert.match(reminder.to[0], /sophie@example\.invalid/);
  const rows = (await db.query("SELECT entity_id,kind,status FROM email_log WHERE kind LIKE 'reminder-%' ORDER BY created_at")).rows;
  assert.deepEqual(
    rows.map((r) => [r.entity_id, r.kind, r.status]).sort(),
    [
      [ids.noEmail, "reminder-7", "skipped"],
      [ids.recent, "reminder-7", "sent"],
    ].sort(),
    "the old invoice (J+30 reached before activation) gets nothing; no e-mail address is recorded once",
  );
  assert.equal((await processEmailReminders(db, new Date("2026-11-25T14:00:00Z"))).sent, 0, "once per stage");
  // A week later, the second reminder.
  const second = await processEmailReminders(db, new Date("2026-12-02T09:00:00Z"));
  assert.equal(second.sent, 1);
  assert.match(messages.at(-1).raw, /Subject: Deuxi=C3=A8me rappel|Subject: =\?UTF-8\?[QB]\?/);
  const overview = await call("mail/reminders", "admin");
  assert.ok(overview.data.overdue.some((i) => i.id === ids.noEmail && i.email === ""));
  const off = await call("mail/reminders", "admin", { enabled: false });
  assert.equal(off.data.enabled, false);
});
