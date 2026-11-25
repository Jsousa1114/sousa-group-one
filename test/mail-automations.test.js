"use strict";
// E-mails, second part: per-company settings and templates, laid-out e-mails with the logo,
// extra attachments, sending at issue, quote follow-ups, appointment confirmations, client
// portal invitations, forgotten password and client replies read from the inbox.
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { database } = require("./database");
const { migrate } = require("../db");
const { createApp } = require("../server");
const D = require("../domain");
const { fakeSmtp } = require("./fake-smtp.cjs");

process.env.JWT_SECRET = "test-only-secret-with-at-least-32-characters";
const ENV = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS", "SMTP_USER_HOME", "SMTP_PASS_HOME", "APP_URL", "WEBAUTHN_ORIGIN", "IMAP_HOST"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
let db, server, smtp, url;
const tokens = {};
const messages = [];
const ids = {};
const day = (offset) => {
  const d = new Date("2026-11-25T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

async function call(path, who, body) {
  const response = await fetch(url + "/api/" + path, {
    method: body ? "POST" : "GET",
    headers: { ...(who ? { Authorization: "Bearer " + tokens[who] } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const type = response.headers.get("content-type") || "";
  return { status: response.status, headers: response.headers, data: type.includes("json") ? await response.json() : await response.text() };
}
const decode = (raw) => raw.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const login = async (email, password) => {
  const r = await fetch(url + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  return { status: r.status, data: await r.json() };
};

test.before(async () => {
  smtp = fakeSmtp(() => "home-app-pass", messages).listen(0, "127.0.0.1");
  await new Promise((r) => smtp.once("listening", r));
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, {
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(smtp.address().port),
    SMTP_SECURE: "false",
    SMTP_USER_HOME: "sousa.home@example.invalid",
    SMTP_PASS_HOME: "home-app-pass",
    APP_URL: "https://app.example.invalid",
    IMAP_HOST: "127.0.0.1",
  });
  require("../mailer")._reset();
  db = await database();
  await migrate(db);
  const hash = await bcrypt.hash("A-Strong-Test-Password", 4);
  for (const [email, role, company] of [
    ["auto-admin@test.invalid", "admin", "group"],
    ["auto-accounting@test.invalid", "accounting", "home"],
    ["auto-manager@test.invalid", "manager", "home"],
  ])
    await db.query("INSERT INTO users(email,password_hash,role,name,avatar,company) VALUES($1,$2,$3,$4,'',$5)", [email, hash, role, "Jean " + role, company]);
  const d = D.emptyState();
  const admin = { id: 1, role: "admin", company: "group" };
  d.companies.find((c) => c.id === "home").billing = { iban: "CH9300762011623852957", street: "Rue Test", buildingNumber: "2", zip: "1000", city: "Lausanne", country: "CH", email: "factures@sousa.invalid" };
  d.clients = [
    { id: "c1", company: "home", name: "Sophie Bernard", street: "Rue du Lac", buildingNumber: "4", zip: "1000", city: "Lausanne", country: "CH", email: "sophie@example.invalid" },
    { id: "c2", company: "home", name: "Marc Rossi", street: "Rue B", buildingNumber: "1", zip: "1000", city: "Lausanne", country: "CH", email: "marc@example.invalid" },
  ];
  d.employees = [{ id: "e1", name: "Lucas Martin", company: "home", companies: ["home"], status: "Actif", vacation: 20 }];
  d.projects = [{ id: "P-1", title: "Rénovation salle de bain", clientId: "c1", company: "home", team: ["e1"], status: "En cours", address: "Rue du Lac 4, Lausanne", start: day(-10), end: day(20) }];
  const create = (collection, payload) => D.applyCommand(d, admin, { action: "create", collection, payload }).result;
  const line = [{ description: "Pose", quantity: 1, unit: "forfait", unitPrice: 1000, vatRate: 8.1, discount: 0 }];
  ids.quote = create("quotes", { company: "home", clientId: "c1", title: "Salle de bain", date: day(-8), valid: day(30), lines: line }).id;
  D.applyCommand(d, admin, { action: "quote.issue", payload: { id: ids.quote } });
  ids.draftInvoice = create("invoices", { company: "home", clientId: "c2", title: "Tableau", date: day(0), due: day(30), lines: line }).id;
  d.documents = [{ id: "doc-plan", company: "home", project: "P-1", clientId: "c1", name: "Plan.pdf", category: "Plan", visibility: "team", size: 20, createdAt: day(-3) }];
  // Interventions: one planned before the confirmations were switched on, one after.
  d.planning = [
    { id: "pl-old", employeeId: "e1", company: "home", project: "P-1", date: day(3), start: "08:00", end: "12:00", location: "", createdAt: "2026-11-01T08:00:00Z" },
    { id: "pl-new", employeeId: "e1", company: "home", project: "P-1", date: day(6), start: "07:30", end: "16:00", location: "Rue du Lac 4, Lausanne", createdAt: "2026-11-24T10:00:00Z" },
  ];
  await db.query("UPDATE app_state SET data=$1 WHERE id=1", [JSON.stringify(d)]);
  await require("../storage").saveFile(db, "doc-plan", Buffer.from("%PDF-1.4 plan"), "application/pdf");
  server = createApp(db).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  url = "http://127.0.0.1:" + server.address().port;
  for (const who of ["admin", "accounting", "manager"]) tokens[who] = (await login(`auto-${who}@test.invalid`, "A-Strong-Test-Password")).data.token;
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

test("each company's texts, signature, delays and hidden copy are kept and validated", async () => {
  const before = await call("mail/settings/home", "accounting");
  assert.equal(before.status, 200);
  assert.match(before.data.settings.templates.invoice.body, /\{montant\}/);
  assert.equal(before.data.fields.client, "nom du client");
  assert.equal((await call("mail/settings/home", "manager")).status, 403);
  const invalid = await call("mail/settings/home", "admin", { reminderStages: [14, 7, 30] });
  assert.equal(invalid.status, 400);
  assert.match(invalid.data.error, /croissants/);
  assert.equal((await call("mail/settings/home", "admin", { bcc: "pas-une-adresse" })).status, 400);
  const out = await call("mail/settings/home", "admin", {
    signature: { phone: "021 555 12 34", website: "sousa-home.ch" },
    bcc: "archives@sousa.invalid",
    reminderStages: [10, 20, 40],
    templates: { invoice: { subject: "Votre facture {document}", body: "Bonjour {client},\n\nVoici la facture {document} de {montant}." } },
  });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.deepEqual(out.data.settings.reminderStages, [10, 20, 40]);
  assert.equal(out.data.settings.templates.invoice.custom, true);
  assert.equal(out.data.settings.templates.quote.custom, false);
  // Switching an automatic sending on needs an account for the company.
  assert.equal((await call("mail/settings/tech", "admin", { automations: { quoteFollowup: { enabled: true } } })).status, 503);
});

test("the preview shows the laid-out e-mail with its logo, in a locked frame", async () => {
  const out = await call("mail/preview?company=home&template=invoice", "accounting");
  assert.equal(out.status, 200);
  assert.match(out.headers.get("content-security-policy"), /default-src 'none'; style-src 'unsafe-inline'; img-src data:/);
  assert.match(out.data, /data:image\/png;base64,/);
  assert.match(out.data, /Votre facture F-2026-0042/);
  assert.match(out.data, /Tél\. 021 555 12 34/);
});

test("an invoice is sent laid out, with the logo, the hidden copy and extra attachments", async () => {
  const admin = { id: 1, role: "admin", company: "group" };
  const row = await db.query("SELECT data FROM app_state WHERE id=1");
  const d = row.rows[0].data;
  D.applyCommand(d, admin, { action: "invoice.issue", payload: { id: ids.draftInvoice } });
  await db.query("UPDATE app_state SET data=$1,revision=revision+1 WHERE id=1", [JSON.stringify(d)]);
  const draft = await call(`mail/draft/invoices/${ids.draftInvoice}`, "accounting");
  assert.equal(draft.data.to, "marc@example.invalid");
  assert.equal(draft.data.subject, `Votre facture ${ids.draftInvoice}`);
  assert.match(draft.data.body, /Bonjour Marc Rossi/);
  assert.equal(draft.data.from, "sousa.home@example.invalid");
  const before = messages.length;
  const out = await call(`mail/finance/invoices/${ids.draftInvoice}`, "accounting", {
    documentIds: ["doc-plan"],
    uploads: [{ name: "conditions.txt", type: "text/plain", content: Buffer.from("Conditions générales").toString("base64") }],
  });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.equal(out.data.attachments, 3);
  const message = messages[before];
  const raw = decode(message.raw);
  assert.match(raw, /Content-Type: text\/html/);
  assert.match(raw, /cid:logo@sousa/);
  assert.match(raw, /Content-ID: <logo@sousa>/);
  assert.match(raw, /filename=.?Plan\.pdf/);
  assert.match(raw, /filename=.?conditions\.txt/);
  assert.match(raw, /Meilleures salutations\s+Jean accounting\s+Sousa Home Service/);
  assert.ok(message.to.some((t) => /archives@sousa\.invalid/.test(t)), "the hidden copy is a recipient");
  assert.doesNotMatch(raw, /^Bcc:/m, "but not visible in the message");
  // A document of another client is refused.
  assert.equal((await call(`mail/finance/invoices/${ids.draftInvoice}`, "accounting", { documentIds: ["nope"] })).status, 403);
});

test("documents can go out automatically at issue, when the company asked for it", async () => {
  await call("mail/settings/home", "admin", { automations: { autoSendInvoices: { enabled: true } } });
  const { autoSendIssued } = require("../mail-routes");
  const admin = { id: 1, role: "admin", company: "group" };
  const d = (await db.query("SELECT data FROM app_state WHERE id=1")).rows[0].data;
  const inv = D.applyCommand(d, admin, {
    action: "create",
    collection: "invoices",
    payload: { company: "home", clientId: "c1", title: "Acompte", date: day(0), due: day(30), lines: [{ description: "Acompte", quantity: 1, unit: "forfait", unitPrice: 500, vatRate: 8.1, discount: 0 }] },
  }).result;
  D.applyCommand(d, admin, { action: "invoice.issue", payload: { id: inv.id } });
  await db.query("UPDATE app_state SET data=$1,revision=revision+1 WHERE id=1", [JSON.stringify(d)]);
  const before = messages.length;
  await autoSendIssued(db, 1, "invoices", inv.id);
  assert.equal(messages.length, before + 1);
  assert.match(decode(messages[before].raw), new RegExp("Votre facture " + inv.id));
  const logged = (await db.query("SELECT kind,status FROM email_log WHERE entity_id=$1", [inv.id])).rows;
  assert.deepEqual(logged, [{ kind: "invoice-auto", status: "sent" }]);
  // Quotes were not switched on.
  await autoSendIssued(db, 1, "quotes", ids.quote);
  assert.equal(messages.length, before + 1);
});

test("quote follow-ups and appointment e-mails go out once, only after being switched on", async () => {
  const { processEmailAutomations } = require("../mail-routes");
  await call("mail/settings/home", "admin", { automations: { quoteFollowup: { enabled: true, days: 7 }, appointments: { enabled: true, dayBefore: true } } });
  await db.query(
    "UPDATE mail_settings SET config=jsonb_set(jsonb_set(config,'{automations,quoteFollowup,enabledAt}','\"2026-11-15T08:00:00Z\"'),'{automations,appointments,enabledAt}','\"2026-11-20T08:00:00Z\"') WHERE company='home'",
  );
  const before = messages.length;
  const run = await processEmailAutomations(db, new Date("2026-11-25T09:00:00Z")); // Wednesday 10:00
  assert.equal(run.quoteFollowups, 1, "issued 8 days ago, follow-up after 7");
  assert.equal(run.appointments, 1, "only the intervention planned after the switch");
  const subjects = messages.slice(before).map((m) => decode(m.raw).match(/^Subject: (.*)$/m)?.[1] || "");
  assert.ok(subjects.some((s) => s.includes(ids.quote)), subjects.join(" | "));
  const confirmation = messages.slice(before).map((m) => decode(m.raw)).find((raw) => /Confirmation de notre intervention/.test(raw));
  assert.ok(confirmation, "confirmation sent");
  assert.match(confirmation, /07:30/);
  assert.match(confirmation, /16:00/);
  assert.match(confirmation, /Lucas/);
  const again = await processEmailAutomations(db, new Date("2026-11-25T13:00:00Z"));
  assert.equal(again.quoteFollowups + again.appointments, 0, "once only");
  // The day before (a Monday), the reminder.
  const eve = await processEmailAutomations(db, new Date("2026-11-30T09:00:00Z"));
  assert.equal(eve.appointmentReminders, 1);
  assert.match(decode(messages.at(-1).raw), /Rappel : notre intervention demain/);
  // The intervention planned before the switch never got e-mails.
  const old = (await db.query("SELECT COUNT(*)::int AS n FROM email_log WHERE entity_id=$1", ["P-1|" + day(3)])).rows[0].n;
  assert.equal(old, 0);
});

test("a client is invited to the portal, chooses a password with the link, then signs in", async () => {
  const list = await call("mail/portal-clients", "admin");
  assert.equal(list.status, 200);
  assert.equal(list.data.clients.find((c) => c.id === "c2").hasAccount, false);
  assert.equal((await call("mail/invite-client", "accounting", { clientId: "c2" })).status, 403);
  const before = messages.length;
  const out = await call("mail/invite-client", "admin", { clientId: "c2" });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  const raw = decode(messages[before].raw);
  const token = raw.match(/https:\/\/app\.example\.invalid\/\?invite=([A-Za-z0-9_-]+)/)?.[1];
  assert.ok(token, "the link is in the e-mail");
  const account = (await db.query("SELECT * FROM users WHERE client_id='c2'")).rows[0];
  assert.equal(account.role, "client");
  assert.equal((await login("marc@example.invalid", "anything-long-enough")).status, 401, "unusable before the link");
  const check = await call("mail-public/token?token=" + token);
  assert.deepEqual([check.data.valid, check.data.purpose, check.data.email], [true, "invite", "ma•••@example.invalid"]);
  assert.equal((await call("mail-public/password", null, { token, password: "court" })).status, 400);
  const set = await call("mail-public/password", null, { token, password: "Un-Mot-De-Passe-Solide-2026" });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  assert.equal((await call("mail-public/password", null, { token, password: "Un-Autre-Mot-De-Passe-2026" })).status, 400, "single use");
  assert.equal((await login("marc@example.invalid", "Un-Mot-De-Passe-Solide-2026")).status, 200);
  const stored = (await db.query("SELECT token_hash FROM password_tokens")).rows.map((r) => r.token_hash);
  assert.ok(!stored.includes(token), "only a hash is stored");
});

test("forgotten password: same answer for unknown addresses, one-hour link, other sessions closed", async () => {
  const before = messages.length;
  const unknown = await call("mail-public/forgot", null, { email: "personne@example.invalid" });
  assert.equal(unknown.status, 200);
  assert.equal(messages.length, before, "nothing sent for an unknown address");
  const known = await call("mail-public/forgot", null, { email: "auto-manager@test.invalid" });
  assert.deepEqual(known.data, unknown.data, "the answer does not reveal whether the account exists");
  // The e-mail leaves in the background, after the answer.
  for (let i = 0; i < 50 && messages.length === before; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(messages.length, before + 1);
  const token = decode(messages[before].raw).match(/\?reset=([A-Za-z0-9_-]+)/)?.[1];
  assert.ok(token);
  assert.equal((await call("mail/status", "manager")).status, 200);
  assert.equal((await call("mail-public/password", null, { token, password: "Nouveau-Mot-De-Passe-2026" })).status, 200);
  assert.equal((await call("mail/status", "manager")).status, 401, "the old session is closed");
  assert.equal((await login("auto-manager@test.invalid", "A-Strong-Test-Password")).status, 401);
  const again = await login("auto-manager@test.invalid", "Nouveau-Mot-De-Passe-2026");
  assert.equal(again.status, 200);
  tokens.manager = again.data.token;
  await db.query("UPDATE password_tokens SET used_at=NULL,expires_at=NOW() - INTERVAL '1 minute'");
  assert.equal((await call("mail-public/token?token=" + token)).data.valid, false, "expired links are refused");
});

test("reset links never use the Host header of the request", async () => {
  const appUrl = process.env.APP_URL;
  delete process.env.APP_URL;
  try {
    const before = messages.length;
    const response = await fetch(url + "/api/mail-public/forgot", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-Host": "evil.invalid", Host: "evil.invalid" },
      body: JSON.stringify({ email: "auto-accounting@test.invalid" }),
    });
    assert.equal(response.status, 200);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(messages.length, before, "without a configured address, no link is sent");
  } finally {
    process.env.APP_URL = appUrl;
  }
});

test("client replies are read from the inbox and linked to the document they answer", async () => {
  const { processInbox, replyText } = require("../mail-inbox");
  const sent = (await db.query("SELECT message_id FROM email_log WHERE entity_id=$1 AND kind='quote-followup'", [ids.quote])).rows[0];
  assert.ok(sent?.message_id, "the Message-ID of sent e-mails is kept");
  const mail = (from, subject, extra, body) =>
    Buffer.from(`From: ${from}\r\nTo: sousa.home@example.invalid\r\nSubject: ${subject}\r\nMessage-ID: <${Math.random().toString(36).slice(2)}@client.invalid>\r\nDate: Wed, 25 Nov 2026 10:00:00 +0100\r\n${extra}Content-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`);
  const fetched = [
    { uid: 11, source: mail("Sophie Bernard <sophie@example.invalid>", "Re: Votre devis", `In-Reply-To: ${sent.message_id}\r\n`, "Bonjour,\nC'est d'accord pour le devis.\n\nLe mer. 25 nov. 2026 a écrit :\n> Nous revenons vers vous") },
    { uid: 12, source: mail("Marc Rossi <marc@example.invalid>", "Question", "", "Pouvez-vous passer jeudi ?") },
    { uid: 13, source: mail("Publicité <promo@shop.invalid>", "Offre", "", "Achetez !") },
    { uid: 14, source: mail("sousa.home@example.invalid", "Copie", "", "Message envoyé par l'entreprise") },
  ];
  const fetcher = async () => ({ uidValidity: "1", messages: fetched, maxUid: 14 });
  const out = await processInbox(db, { now: new Date("2026-11-25T10:00:00Z"), fetcher });
  assert.equal(out.stored, 2, "the reply and the known client; not the advert nor the company's own message");
  const inbox = await call("mail/inbox", "accounting");
  const reply = inbox.data.replies.find((r) => r.entity_id === ids.quote);
  assert.equal(reply.client, "Sophie Bernard");
  assert.equal(reply.body, "Bonjour,\nC'est d'accord pour le devis.", "the quoted message is cut");
  const question = inbox.data.replies.find((r) => r.from_address === "marc@example.invalid");
  assert.equal(question.client_id, "c2");
  assert.equal((await call("mail/status", "accounting")).data.unread, 2);
  assert.equal((await call(`mail/inbox/${reply.id}/read`, "accounting", {})).status, 200);
  assert.equal((await call("mail/status", "accounting")).data.unread, 1);
  const notices = (await db.query("SELECT title FROM user_notifications WHERE category='finance' ORDER BY created_at")).rows.map((r) => r.title);
  assert.ok(notices.includes("Réponse de Sophie Bernard"));
  // Processing again stores nothing twice.
  assert.equal((await processInbox(db, { fetcher })).stored, 0);
  assert.equal((await call("mail/inbox", "manager")).status, 403);
  assert.equal(replyText({ text: "Merci !\n\nOn Tue, Nov 24, 2026 at 9:00 AM Sousa wrote:\n> texte" }), "Merci !");
});
