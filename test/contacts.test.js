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

test("billing address and work sites: checked, where to go, on the document and the project", () => {
  assert.deepEqual(C.normalizeSites([{ label: "Résidence", street: "Elfenstrasse 3", zip: "3006", city: "Berne" }, { label: "", street: "", city: "" }, { street: "elfenstrasse 3", zip: "3006", city: "berne" }]).length, 1);
  assert.throws(() => C.normalizeSites([{ label: "Dépôt", street: "Rue A 1" }]), /incomplète \(« Dépôt »\)/);
  assert.throws(() => C.normalizeSites(Array.from({ length: 21 }, (_, i) => ({ street: "Rue " + i, city: "X" }))), /20 adresses/);
  const billing = { street: "Weltpoststrasse", buildingNumber: "20", zip: "3015", city: "Berne" };
  assert.equal(C.workAddress(billing), "Weltpoststrasse 20, 3015 Berne", "no site: the work is done at the billing address");
  assert.equal(C.workAddress({ ...billing, sites: [{ street: "Elfenstrasse 3", zip: "3006", city: "Berne" }] }), "Elfenstrasse 3, 3006 Berne");
  const d = D.emptyState();
  const admin = { id: 1, role: "admin", company: "group" };
  const c = D.applyCommand(d, admin, {
    action: "create",
    collection: "clients",
    payload: { name: "Ambassade", company: "home", email: "s@amb.test", ...billing, country: "CH", sites: [{ label: "Résidence de l’ambassadeur", street: "Elfenstrasse 3", zip: "3006", city: "Berne" }] },
  }).result;
  assert.equal(c.sites[0].label, "Résidence de l’ambassadeur");
  // An update without « sites » (older form) keeps them; an empty list removes them.
  D.applyCommand(d, admin, { action: "client.update", payload: { id: c.id, name: "Ambassade", city: "Berne" } });
  assert.equal(c.sites.length, 1);
  assert.throws(() => D.applyCommand(d, admin, { action: "client.update", payload: { id: c.id, name: "A", city: "B", sites: [{ street: "Rue sans localité" }] } }), /incomplète/);
  // The quote says where the work is done; once accepted, the project goes there.
  const q = D.applyCommand(d, admin, {
    action: "create",
    collection: "quotes",
    payload: { company: "home", clientId: c.id, title: "Tableau électrique", site: "Elfenstrasse 3, 3006 Berne", date: "2026-11-28", valid: "2026-12-28", lines: [{ description: "Tableau", quantity: 1, unitPrice: 1000, vatRate: 8.1 }] },
  }).result;
  assert.equal(q.site, "Elfenstrasse 3, 3006 Berne");
  D.applyCommand(d, admin, { action: "quote.issue", payload: { id: q.id } });
  D.applyCommand(d, admin, { action: "quote.decide", payload: { id: q.id, status: "Accepté", note: "Accord écrit de l’ambassade" } });
  const project = d.projects.find((p) => p.id === q.project);
  assert.equal(project.address, "Elfenstrasse 3, 3006 Berne");
  // Without a site on the quote, the client's first work address.
  D.applyCommand(d, admin, { action: "client.update", payload: { id: c.id, name: "Ambassade", city: "Berne", sites: [{ label: "Dépôt", street: "Route 9", zip: "3000", city: "Berne" }] } });
  const q2 = D.applyCommand(d, admin, { action: "create", collection: "quotes", payload: { company: "home", clientId: c.id, title: "Éclairage", date: "2026-11-28", valid: "2026-12-28", lines: [{ description: "Spots", quantity: 1, unitPrice: 300, vatRate: 8.1 }] } }).result;
  D.applyCommand(d, admin, { action: "quote.issue", payload: { id: q2.id } });
  D.applyCommand(d, admin, { action: "quote.decide", payload: { id: q2.id, status: "Accepté", note: "OK" } });
  assert.equal(d.projects.find((p) => p.id === q2.project).address, "Route 9, 3000 Berne");
});

test("the work site is printed on the PDF, the billing address stays in the customer box", async () => {
  const { renderPDF } = require("../finance-pdf");
  const r = { id: "D-2026-0009", title: "Tableau", date: "2026-11-28", valid: "2026-12-28", status: "Émise", language: "fr", site: "Elfenstrasse 3, 3006 Berne", lines: [{ description: "Tableau", quantity: 1, unitPrice: 100, vatRate: 0, discount: 0, unit: "pcs" }], amount: 100, subtotal: 100, net: 100, tax: 0, discount: 0, vat: [], depositPercent: 0, paid: 0 };
  const issuer = { id: "home", name: "Sousa Home", billing: { street: "Rue", zip: "1000", city: "Lausanne", country: "CH" } };
  const customer = { name: "Ambassade", street: "Weltpoststrasse", buildingNumber: "20", zip: "3015", city: "Berne", country: "CH" };
  const pdf = await renderPDF(r, "quotes", issuer, customer, false);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), useSystemFonts: true }).promise;
  const text = (await (await doc.getPage(1)).getTextContent()).items.map((i) => i.str).join(" ");
  assert.match(text, /Lieu d’intervention/);
  assert.match(text, /Elfenstrasse 3, 3006 Berne/);
  assert.match(text, /Weltpoststrasse 20/);
});
