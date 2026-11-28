"use strict";
// Several e-mails and phone numbers per client: checked, the main one first, recognised everywhere,
// and a document can be sent to several of the client's addresses.
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const C = require("../contacts");
const D = require("../domain");
const { database } = require("./database");
const { migrate } = require("../db");
const { createApp } = require("../server");
const { fakeSmtp } = require("./fake-smtp.cjs");

process.env.JWT_SECRET = "test-only-secret-with-at-least-32-characters";

test("lists: main first, labels, duplicates removed, older records read as before", () => {
  const old = { email: "contact@client.test", phone: "021 111 22 33", mobile: "079 444 55 66" };
  assert.deepEqual(C.emails(old), [{ label: "", address: "contact@client.test" }]);
  assert.deepEqual(C.phones(old).map((p) => p.number), ["021 111 22 33", "079 444 55 66"]);
  const out = C.normalize({
    emails: [
      { label: "Secrétariat", address: " secretariat@amb.test " },
      { label: "Doublon", address: "SECRETARIAT@amb.test" },
      { label: "Ambassadeur", address: "amb@amb.test" },
      { label: "Vide", address: "" },
    ],
    phones: [
      { label: "Standard", number: "031 352 83 29" },
      { label: "Même numéro", number: "+41 31 352 83 29" },
      { label: "Mobile", number: "0041 79 111 22 33" },
    ],
  });
  assert.equal(out.email, "secretariat@amb.test");
  assert.equal(out.phone, "031 352 83 29");
  assert.deepEqual(out.emails.map((e) => e.label), ["Secrétariat", "Ambassadeur"]);
  assert.deepEqual(out.phones.map((p) => p.label), ["Standard", "Mobile"]);
  assert.throws(() => C.normalize({ emails: [{ address: "pas-un-mail" }] }), /E-mail invalide/);
  assert.throws(() => C.normalize({ emails: [] }), /au moins une adresse/);
  assert.throws(() => C.normalize({ emails: [{ address: "a@b.ch" }], phones: [{ number: "appelez-moi" }] }), /Numéro invalide/);
  assert.throws(() => C.normalize({ emails: Array.from({ length: 11 }, (_, i) => ({ address: `a${i}@b.ch` })) }), /10 adresses/);
  // An older form sending only « email » replaces the main address and keeps the others.
  const current = { emails: out.emails, phones: out.phones };
  const changed = C.normalize({ email: "nouveau@amb.test" }, current);
  assert.deepEqual(changed.emails.map((e) => e.address), ["nouveau@amb.test", "amb@amb.test"]);
  assert.equal(changed.emails[0].label, "Secrétariat");
  assert.equal(changed.phones.length, 2, "numbers untouched");
});

test("any address or number of a client recognises it", () => {
  const clients = [
    { id: "c1", name: "Ambassade", emails: [{ address: "secretariat@amb.test" }, { address: "amb@amb.test" }], phones: [{ number: "031 352 83 29" }, { number: "+41 79 111 22 33" }] },
    { id: "c2", name: "Ancien", email: "ancien@client.test", phone: "021 000 00 00", mobile: "078 999 88 77" },
    { id: "c3", name: "Supprimé", email: "x@client.test", phone: "076 555 44 33", deletedAt: "2026-01-01" },
  ];
  assert.equal(C.findByEmail(clients, "AMB@amb.test").id, "c1");
  assert.equal(C.findByEmail(clients, "ancien@client.test").id, "c2");
  assert.equal(C.findByEmail(clients, "x@client.test"), null, "deleted clients are not matched");
  assert.equal(C.findByPhone(clients, "0791112233").id, "c1");
  assert.equal(C.findByPhone(clients, "+41313528329").id, "c1");
  assert.equal(C.findByPhone(clients, "0041 78 999 88 77").id, "c2", "the older « mobile » field too");
  assert.equal(C.findByPhone(clients, "123"), null);
  assert.match(C.searchText(clients[0]), /amb@amb\.test.*\+41 79 111 22 33/);
});

test("client records: create and update through the domain, permissions unchanged", () => {
  const d = D.emptyState();
  const admin = { id: 1, role: "admin", company: "group" };
  const c = D.applyCommand(d, admin, {
    action: "create",
    collection: "clients",
    payload: { name: "Ambassade", company: "home", city: "Berne", notes: "Badge à l’entrée", emails: [{ label: "Secrétariat", address: "s@amb.test" }, { address: "a@amb.test" }], phones: [{ number: "031 352 83 29" }] },
  }).result;
  assert.equal(c.email, "s@amb.test");
  assert.equal(c.phone, "031 352 83 29");
  assert.equal(c.notes, "Badge à l’entrée");
  D.applyCommand(d, admin, { action: "client.update", payload: { id: c.id, name: "Ambassade", city: "Berne", emails: [{ address: "a@amb.test" }, { address: "s@amb.test" }], phones: [] } });
  assert.equal(c.email, "a@amb.test");
  assert.equal(c.phone, "");
  assert.deepEqual(c.phones, []);
  assert.throws(() => D.applyCommand(d, admin, { action: "client.update", payload: { id: c.id, name: "A", city: "B", emails: [{ address: "faux" }] } }), /E-mail invalide/);
  assert.throws(() => D.applyCommand(d, { id: 2, role: "employee", company: "home", employee_id: "e1" }, { action: "client.update", payload: { id: c.id, name: "X", city: "Y" } }), /non autorisée|Compte salarié/);
});

let db, server, smtp, url, token;
const messages = [];
const ENV = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS", "SMTP_USER_HOME", "SMTP_PASS_HOME"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
test.before(async () => {
  smtp = fakeSmtp(() => "home-app-pass", messages).listen(0, "127.0.0.1");
  await new Promise((r) => smtp.once("listening", r));
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, { SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtp.address().port), SMTP_SECURE: "false", SMTP_USER_HOME: "sousa.home@example.invalid", SMTP_PASS_HOME: "home-app-pass" });
  require("../mailer")._reset();
  db = await database();
  await migrate(db);
  await db.query("INSERT INTO users(email,password_hash,role,name,avatar,company) VALUES($1,$2,'admin','Admin','', 'group')", ["c-admin@test.invalid", await bcrypt.hash("A-Strong-Test-Password", 4)]);
  const d = D.emptyState();
  const admin = { id: 1, role: "admin", company: "group" };
  d.companies.find((c) => c.id === "home").billing = { iban: "CH9300762011623852957", street: "Rue Test", buildingNumber: "2", zip: "1000", city: "Lausanne", country: "CH" };
  d.clients = [
    {
      id: "c1",
      company: "home",
      name: "Ambassade",
      street: "Rue A",
      buildingNumber: "1",
      zip: "3000",
      city: "Berne",
      country: "CH",
      email: "secretariat@amb.test",
      emails: [{ label: "Secrétariat", address: "secretariat@amb.test" }, { label: "Ambassadeur", address: "amb@amb.test" }],
      phones: [],
    },
  ];
  const inv = D.applyCommand(d, admin, { action: "create", collection: "invoices", payload: { company: "home", clientId: "c1", title: "Travaux", date: "2026-11-01", due: "2026-11-30", lines: [{ description: "Pose", quantity: 1, unitPrice: 500, vatRate: 0 }] } }).result;
  D.applyCommand(d, admin, { action: "invoice.issue", payload: { id: inv.id } });
  await db.query("UPDATE app_state SET data=$1 WHERE id=1", [JSON.stringify(d)]);
  server = createApp(db).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  url = "http://127.0.0.1:" + server.address().port;
  const r = await fetch(url + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "c-admin@test.invalid", password: "A-Strong-Test-Password" }) });
  token = (await r.json()).token;
});
test.after(async () => {
  server?.close();
  smtp?.close();
  await db?.end?.();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  require("../mailer")._reset();
});
const call = async (path, body) => {
  const r = await fetch(url + "/api/" + path, { method: body ? "POST" : "GET", headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, data: await r.json() };
};

test("an invoice can go to several of the client's addresses", async () => {
  const st = (await call("state")).data.data;
  const id = st.invoices[0].id;
  const draft = await call(`mail/draft/invoices/${id}`);
  assert.equal(draft.status, 200, JSON.stringify(draft.data));
  assert.deepEqual(draft.data.emails.map((e) => e.label), ["Secrétariat", "Ambassadeur"]);
  const sent = await call(`mail/finance/invoices/${id}`, { to: ["secretariat@amb.test", "amb@amb.test"], qr: false });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].to.length, 2);
  assert.match(messages[0].to.join(" "), /secretariat@amb\.test/);
  assert.match(messages[0].to.join(" "), /amb@amb\.test/);
  assert.equal((await call(`mail/finance/invoices/${id}`, { to: ["amb@amb.test", "pas-une-adresse"], qr: false })).status, 400);
  assert.equal((await call(`mail/finance/invoices/${id}`, { to: Array.from({ length: 6 }, (_, i) => `x${i}@amb.test`), qr: false })).status, 400);
});
