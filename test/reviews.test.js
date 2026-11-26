"use strict";
// « Avis Google »: once per finished and paid job, after the delay; the same Google link for
// everyone, a private message, and a way to stop such e-mails.
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { database } = require("./database");
const { migrate } = require("../db");
const { createApp } = require("../server");
const D = require("../domain");
const { fakeSmtp } = require("./fake-smtp.cjs");
const R = require("../review-routes");

process.env.JWT_SECRET = "test-only-secret-with-at-least-32-characters";
const ENV = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASS", "SMTP_USER_HOME", "SMTP_PASS_HOME", "APP_URL", "WEBAUTHN_ORIGIN"];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const GOOGLE = "https://g.page/r/CbSousaHome/review";
let db, server, smtp, url;
const tokens = {},
  messages = [];
const iso = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const decode = (raw) => raw.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
async function call(path, who, body) {
  const r = await fetch(url + "/api/" + path, {
    method: body ? "POST" : "GET",
    headers: { ...(who ? { Authorization: "Bearer " + tokens[who] } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

test("google link check and « finished and paid »", () => {
  assert.equal(R.googleUrl("https://g.page/r/abc/review"), "https://g.page/r/abc/review");
  assert.equal(R.googleUrl("https://maps.app.goo.gl/xyz"), "https://maps.app.goo.gl/xyz");
  assert.ok(R.googleUrl("https://www.google.ch/maps/place/Sousa"));
  assert.throws(() => R.googleUrl("https://evil.example/google.com"), /fiche Google/);
  assert.throws(() => R.googleUrl("http://g.page/r/abc"), /fiche Google/);
  const data = {
    invoices: [
      { id: "F1", project: "P1", status: "Payée" },
      { id: "F2", project: "P2", status: "Partiellement payée" },
      { id: "F3", project: "P3", status: "Brouillon" },
    ],
    payments: [{ invoice: "F1", date: "2026-11-20" }],
  };
  assert.equal(R.paidOn(data, { id: "P1", status: "Terminé", completedAt: "2026-11-10T08:00:00Z" }), "2026-11-20");
  assert.equal(R.paidOn(data, { id: "P2", status: "Terminé", completedAt: "2026-11-10T08:00:00Z" }), "");
  assert.equal(R.paidOn(data, { id: "P3", status: "Terminé", completedAt: "2026-11-10T08:00:00Z" }), "", "no issued invoice yet");
  assert.equal(R.paidOn(data, { id: "P1", status: "En cours" }), "");
});

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
  });
  require("../mailer")._reset();
  db = await database();
  await migrate(db);
  const hash = await bcrypt.hash("A-Strong-Test-Password", 4);
  for (const [email, role, company] of [
    ["r-admin@test.invalid", "admin", "group"],
    ["r-manager@test.invalid", "manager", "home"],
    ["r-employee@test.invalid", "employee", "home"],
  ])
    await db.query("INSERT INTO users(email,password_hash,role,name,avatar,company,employee_id) VALUES($1,$2,$3,$4,'',$5,$6)", [email, hash, role, "R " + role, company, role === "employee" ? "e1" : null]);
  const d = D.emptyState();
  d.employees = [{ id: "e1", name: "R employee", company: "home", companies: ["home"], status: "Actif", vacation: 20 }];
  d.clients = [
    { id: "c1", company: "home", name: "Sophie Bernard", email: "sophie@example.invalid", phone: "079 888 77 66" },
    { id: "c2", company: "home", name: "Marc Rossi", email: "marc@example.invalid" },
    { id: "c3", company: "home", name: "Sans E-mail", email: "" },
    { id: "c4", company: "home", name: "Ancien Client", email: "ancien@example.invalid" },
  ];
  const later = new Date(Date.now() + 60_000).toISOString();
  d.projects = [
    { id: "P-OK", company: "home", clientId: "c1", title: "Salle de bain", status: "Terminé", completedAt: later, team: [] },
    { id: "P-UNPAID", company: "home", clientId: "c2", title: "Cuisine", status: "Terminé", completedAt: later, team: [] },
    { id: "P-NOMAIL", company: "home", clientId: "c3", title: "Peinture", status: "Terminé", completedAt: later, team: [] },
    { id: "P-OLD", company: "home", clientId: "c4", title: "Ancien chantier", status: "Terminé", completedAt: "2025-01-10T08:00:00Z", team: [] },
  ];
  d.invoices = [
    { id: "F-1", company: "home", clientId: "c1", project: "P-OK", amount: 1000, paid: 1000, status: "Payée" },
    { id: "F-2", company: "home", clientId: "c2", project: "P-UNPAID", amount: 900, paid: 100, status: "Partiellement payée" },
    { id: "F-3", company: "home", clientId: "c3", project: "P-NOMAIL", amount: 500, paid: 500, status: "Payée" },
    { id: "F-4", company: "home", clientId: "c4", project: "P-OLD", amount: 500, paid: 500, status: "Payée" },
  ];
  d.payments = [
    { id: "pay1", invoice: "F-1", amount: 1000, date: iso(-5) },
    { id: "pay3", invoice: "F-3", amount: 500, date: iso(-5) },
    { id: "pay4", invoice: "F-4", amount: 500, date: "2025-01-20" },
  ];
  await db.query("UPDATE app_state SET data=$1 WHERE id=1", [JSON.stringify(d)]);
  server = createApp(db).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  url = "http://127.0.0.1:" + server.address().port;
  for (const who of ["admin", "manager", "employee"]) {
    const r = await fetch(url + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `r-${who}@test.invalid`, password: "A-Strong-Test-Password" }) });
    tokens[who] = (await r.json()).token;
  }
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

test("automatic request: finished, paid, after the delay, once; the page offers Google to everyone", async () => {
  assert.equal((await call("reviews/settings", "employee")).status, 403);
  assert.equal((await call("reviews/settings", "manager", { company: "home", googleUrl: GOOGLE, enabled: true })).status, 403, "settings: management only");
  assert.equal((await call("reviews/settings", "admin", { company: "home", googleUrl: "https://example.com", enabled: true })).status, 400);
  const set = await call("reviews/settings", "admin", { company: "home", googleUrl: GOOGLE, enabled: true, delayDays: 3 });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  const cfg = (await call("reviews/settings", "manager")).data;
  assert.equal(cfg.companies.find((c) => c.id === "home").mailReady, true);
  // Outside office hours nothing leaves.
  assert.deepEqual(await R.processReviewRequests(db, { now: new Date("2026-11-29T10:00:00Z") }), { sent: 0 }, "a Sunday");
  // Today the delay (3 days after the payment) has not passed yet; five days later it has.
  assert.equal((await R.processReviewRequests(db, { anyTime: true })).sent, 0);
  const later = new Date(Date.now() + 5 * 864e5);
  const run = await R.processReviewRequests(db, { anyTime: true, now: later });
  assert.equal(run.sent, 1, "only the paid job with an e-mail, finished after switching on");
  assert.equal(messages.length, 1);
  const mail = decode(messages[0].raw);
  assert.match(messages[0].to[0], /sophie@example\.invalid/);
  assert.match(mail, /Votre avis sur notre travail/);
  assert.match(mail, /Salle de bain/);
  const token = mail.match(/https:\/\/app\.example\.invalid\/avis\?t=([A-Za-z0-9_-]+)/)[1];
  // Never twice.
  assert.equal((await R.processReviewRequests(db, { anyTime: true, now: later })).sent, 0);
  assert.equal(messages.length, 1);
  // The client's page: the Google link for everyone, a private message, stop.
  const page = await call("reviews-public/" + token);
  assert.equal(page.status, 200);
  assert.equal(page.data.googleUrl, GOOGLE);
  assert.equal((await call("reviews-public/" + token + "/google", null, {})).data.url, GOOGLE);
  let state = (await call("reviews/project/P-OK", "manager")).data;
  assert.equal(state.request.status, "Avis Google ouvert");
  assert.equal(state.request.clicked, true);
  const fb = await call("reviews-public/" + token + "/feedback", null, { text: "Très bon travail, un peu de poussière restée." });
  assert.equal(fb.status, 200);
  state = (await call("reviews/project/P-OK", "manager")).data;
  assert.equal(state.request.status, "Remarque reçue");
  assert.match(state.request.feedback, /poussière/);
  await call("reviews-public/" + token + "/optout", null, {});
  assert.equal((await call("reviews-public/" + token)).data.optedOut, true);
  assert.equal((await call("reviews-public/" + "y".repeat(30))).status, 404);
  // Manual request for an already asked job is refused.
  assert.equal((await call("reviews/project/P-OK/send", "manager", {})).status, 400);
});

test("manual request and link; client without e-mail; unpaid job; opted-out client", async () => {
  // No e-mail: the link for WhatsApp / SMS.
  assert.equal((await call("reviews/project/P-NOMAIL/send", "manager", {})).status, 400);
  const link = await call("reviews/project/P-NOMAIL/link", "manager", {});
  assert.equal(link.status, 200, JSON.stringify(link.data));
  assert.match(link.data.url, /\/avis\?t=/);
  // The manager may ask an unpaid finished job by hand.
  const before = messages.length;
  const manual = await call("reviews/project/P-UNPAID/send", "manager", {});
  assert.equal(manual.status, 200, JSON.stringify(manual.data));
  assert.equal(messages.length, before + 1);
  // The opted-out client (from the previous test) is not asked again, even by hand.
  await db.query("DELETE FROM review_requests WHERE project_id='P-OK'");
  const again = await call("reviews/project/P-OK/send", "manager", {});
  assert.equal(again.status, 400);
  assert.match(again.data.error, /ne plus recevoir/);
});
