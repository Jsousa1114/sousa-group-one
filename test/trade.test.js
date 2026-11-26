"use strict";
// « Démarches »: OIBT periodic controls and safety reports (électricité), solar paperwork (solaire).
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { database } = require("./database");
const { migrate } = require("../db");
const { createApp } = require("../server");
const D = require("../domain");
const { controlState, companyKind, solarSteps, solarProgress } = require("../trade-routes");

process.env.JWT_SECRET = "test-only-secret-with-at-least-32-characters";
const iso = (offsetDays, from = new Date()) => new Date(from.getTime() + offsetDays * 864e5).toISOString().slice(0, 10);
const yearsAgo = (y, plusDays = 0) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - y);
  return iso(plusDays, d);
};

test("control state: late, to contact within 9 months, contacted, fine, unknown", () => {
  const today = "2026-11-26";
  assert.equal(controlState({ last_control: "2006-11-01", period_years: 20 }, today).state, "late");
  assert.equal(controlState({ last_control: "2007-03-01", period_years: 20 }, today).state, "soon");
  assert.equal(controlState({ last_control: "2007-03-01", period_years: 20, contacted_at: "2026-11-01" }, today).state, "contacted");
  assert.equal(controlState({ last_control: "2007-03-01", period_years: 20, contacted_at: "2026-06-01" }, today).state, "soon", "an old call does not count");
  assert.equal(controlState({ last_control: "2020-01-01", period_years: 20 }, today).state, "ok");
  assert.equal(controlState({ last_control: "2022-01-01", period_years: 5 }, today).state, "soon");
  assert.equal(controlState({ last_control: "2020-01-01", period_years: 5 }, today).due, "2025-01-01");
  assert.equal(controlState({ last_control: null, period_years: 20 }, today).state, "unknown");
  assert.equal(companyKind({ id: "electricite", type: "Électricité" }), "electricite");
  assert.equal(companyKind({ id: "x", name: "Sousa Solar", type: "Solaire" }), "solaire");
  assert.equal(companyKind({ id: "moving", type: "Déménagement" }), "demenagement");
  assert.equal(companyKind({ id: "home", type: "Services" }), "");
});

test("solar steps: template, custom steps after it, waiting after 21 days, progress without « non concerné »", () => {
  const old = iso(-30),
    recent = iso(-3);
  const steps = solarSteps([
    { step: "commune", status: "Fait", date: old },
    { step: "raccordement", status: "En cours", date: old },
    { step: "avis", status: "En cours", date: recent },
    { step: "go", status: "Non concerné" },
    { step: "xabc", label: "Subvention cantonale", position: 9, status: "À faire" },
  ]);
  assert.equal(steps.length, 10);
  assert.equal(steps.at(-1).label, "Subvention cantonale");
  assert.equal(steps.find((s) => s.step === "raccordement").waiting, true);
  assert.equal(steps.find((s) => s.step === "avis").waiting, false);
  const p = solarProgress(steps);
  assert.deepEqual([p.done, p.total, p.waiting], [1, 9, 1]);
  assert.equal(p.next.step, "raccordement");
});

let db, server, url;
const tokens = {};
async function call(path, who, body) {
  const r = await fetch(url + "/api/" + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + tokens[who], ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, data: await r.json() };
}
test.before(async () => {
  db = await database();
  await migrate(db);
  const hash = await bcrypt.hash("A-Strong-Test-Password", 4);
  for (const [email, role, company, extra] of [
    ["t-admin@test.invalid", "admin", "group", {}],
    ["t-manager@test.invalid", "manager", "electricite", {}],
    ["t-accounting@test.invalid", "accounting", "electricite", {}],
    ["t-solar@test.invalid", "manager", "solar", {}],
    ["t-client@test.invalid", "client", "solar", { client_id: "c3" }],
    ["t-other@test.invalid", "client", "solar", { client_id: "c4" }],
  ])
    await db.query("INSERT INTO users(email,password_hash,role,name,avatar,company,client_id) VALUES($1,$2,$3,$4,'',$5,$6)", [email, hash, role, "T " + role, company, extra.client_id || null]);
  const d = D.emptyState();
  d.clients = [
    { id: "c1", company: "electricite", name: "Sophie Bernard", phone: "079 888 77 66", email: "sophie@example.invalid", street: "Rue du Lac", buildingNumber: "4", zip: "1000", city: "Lausanne" },
    { id: "c2", company: "electricite", name: "Garage Dubois SA", city: "Morges" },
    { id: "c3", company: "solar", name: "Immo Léman", city: "Nyon" },
    { id: "c4", company: "solar", name: "Autre client", city: "Gland" },
  ];
  d.projects = [
    { id: "SE-1", company: "electricite", clientId: "c1", title: "Rénovation Bernard", address: "Rue du Lac 4, 1000 Lausanne", status: "Terminé", completedAt: iso(-5) + "T10:00:00Z", team: [] },
    { id: "SE-2", company: "electricite", clientId: "c2", title: "Borne Dubois", address: "Route 12, Morges", status: "En cours", team: [] },
    { id: "SS-1", company: "solar", clientId: "c3", title: "Solaire 12 kWc", address: "Ch. du Soleil 3, Nyon", status: "En cours", team: [] },
  ];
  await db.query("UPDATE app_state SET data=$1 WHERE id=1", [JSON.stringify(d)]);
  server = createApp(db).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  url = "http://127.0.0.1:" + server.address().port;
  for (const who of ["admin", "manager", "accounting", "solar", "client", "other"]) {
    const r = await fetch(url + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `t-${who}@test.invalid`, password: "A-Strong-Test-Password" }) });
    tokens[who] = (await r.json()).token;
  }
});
test.after(async () => {
  server?.close();
  await db?.end?.();
});

test("OIBT: installations, who to call, contacted, control done, safety report of a finished job", async () => {
  // Accounting reads, cannot write; solar staff and clients see nothing of electricity.
  assert.equal((await call("trade/oibt/save", "accounting", { company: "electricite", label: "X", kind: "habitation" })).status, 403);
  assert.equal((await call("trade/oibt", "client")).status, 403);
  assert.deepEqual((await call("trade/oibt", "solar")).data.installations, []);
  const late = await call("trade/oibt/save", "manager", { company: "electricite", clientId: "c2", label: "Garage Dubois", address: "Route 12, Morges", kind: "commerce", periodYears: 10, lastControl: yearsAgo(10, -30) });
  assert.equal(late.status, 200, JSON.stringify(late.data));
  const soon = await call("trade/oibt/save", "manager", { company: "electricite", clientId: "c1", label: "Villa Bernard", address: "Rue du Lac 4, 1000 Lausanne", kind: "habitation", periodYears: 20, lastControl: yearsAgo(20, 120) });
  await call("trade/oibt/save", "manager", { company: "electricite", label: "Immeuble récent", kind: "habitation", periodYears: 20, lastControl: yearsAgo(2) });
  assert.equal((await call("trade/oibt/save", "manager", { company: "electricite", label: "Mauvais", periodYears: 7 })).status, 400);
  assert.equal((await call("trade/oibt/save", "manager", { company: "solar", label: "Pas électricité", periodYears: 20 })).status, 403);
  assert.equal((await call("trade/oibt/save", "manager", { company: "electricite", clientId: "c3", label: "Client d’une autre entreprise", periodYears: 20 })).status, 400);
  let list = (await call("trade/oibt", "accounting")).data;
  assert.equal(list.canWrite, false);
  assert.deepEqual(list.counts, { late: 1, soon: 1, missingReports: 1 });
  const villa = list.installations.find((x) => x.label === "Villa Bernard");
  assert.equal(villa.state, "soon");
  assert.equal(villa.phone, "079 888 77 66");
  assert.equal(list.installations[0].label, "Garage Dubois", "the most urgent first");
  assert.equal(list.missingReports[0].id, "SE-1");
  // Called the client: no longer « à contacter » for two months.
  await call("trade/oibt/action", "manager", { id: soon.data.id, what: "contacted" });
  list = (await call("trade/oibt", "manager")).data;
  assert.equal(list.installations.find((x) => x.label === "Villa Bernard").state, "contacted");
  // The control is done: the next one is 10 years away.
  assert.equal((await call("trade/oibt/action", "manager", { id: late.data.id, what: "controlled", date: iso(1) })).status, 400, "not in the future");
  await call("trade/oibt/action", "manager", { id: late.data.id, what: "controlled", date: iso(0) });
  list = (await call("trade/oibt", "manager")).data;
  const garage = list.installations.find((x) => x.label === "Garage Dubois");
  assert.equal(garage.state, "ok");
  assert.equal(garage.due.slice(0, 4), String(new Date().getUTCFullYear() + 10));
  // The safety report of the finished job: the existing installation at that address is updated.
  assert.equal((await call("trade/oibt/report", "manager", { projectId: "SE-2", date: iso(0) })).status, 200, "a running job may also get its RS");
  const rep = await call("trade/oibt/report", "manager", { projectId: "SE-1", date: iso(-2), kind: "habitation", periodYears: 20 });
  assert.equal(rep.status, 200, JSON.stringify(rep.data));
  assert.equal(rep.data.installationId, soon.data.id);
  list = (await call("trade/oibt", "manager")).data;
  assert.equal(list.counts.missingReports, 0);
  assert.equal(list.installations.find((x) => x.id === soon.data.id).lastControl, iso(-2));
  assert.equal((await call("trade/oibt/report/SE-1", "manager")).data.report.deliveredOn, iso(-2));
  // Removed from the follow-up.
  await call("trade/oibt/action", "manager", { id: late.data.id, what: "archive" });
  assert.equal((await call("trade/oibt", "manager")).data.installations.some((x) => x.id === late.data.id), false);
});

test("solar: steps per installation, custom step, waiting reminders, client sees own project read-only", async () => {
  const first = await call("trade/solar/project/SS-1", "solar");
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.steps.length, 9);
  assert.equal(first.data.canWrite, true);
  assert.equal((await call("trade/solar/project/SE-1", "admin")).status, 400, "not a solar job");
  await call("trade/solar/step", "solar", { projectId: "SS-1", step: "commune", status: "Fait", date: iso(-40) });
  await call("trade/solar/step", "solar", { projectId: "SS-1", step: "raccordement", status: "En cours", date: iso(-25), note: "Dossier 2026-118" });
  await call("trade/solar/step", "solar", { projectId: "SS-1", step: "go", status: "Non concerné" });
  const custom = await call("trade/solar/step", "solar", { projectId: "SS-1", label: "Subvention cantonale", status: "À faire" });
  assert.match(custom.data.step, /^x/);
  assert.equal((await call("trade/solar/step", "solar", { projectId: "SS-1", step: "pose", status: "Peut-être" })).status, 400);
  // The client follows the paperwork of their own installation, without changing it.
  const seen = await call("trade/solar/project/SS-1", "client");
  assert.equal(seen.status, 200);
  assert.equal(seen.data.canWrite, false);
  assert.equal(seen.data.steps.find((s) => s.step === "raccordement").note, "Dossier 2026-118");
  assert.equal(seen.data.steps.at(-1).label, "Subvention cantonale");
  assert.equal((await call("trade/solar/step", "client", { projectId: "SS-1", step: "pose", status: "Fait" })).status, 403);
  assert.equal((await call("trade/solar/project/SS-1", "other")).status, 404);
  const overview = (await call("trade/solar", "solar")).data;
  assert.equal(overview.projects[0].id, "SS-1");
  assert.equal(overview.projects[0].waiting, 1);
  assert.deepEqual([overview.projects[0].done, overview.projects[0].total], [1, 9]);
  // Home « À faire ».
  const todo = (await call("trade/todo", "admin")).data.items;
  assert.ok(todo.some((t) => t.tab === "solar" && /sans réponse/.test(t.text)), JSON.stringify(todo));
  assert.ok(!todo.some((t) => t.tab === "oibt"), "nothing left to do for OIBT after the calls and controls");
  assert.deepEqual((await call("trade/todo", "client")).data.items, []);
});
