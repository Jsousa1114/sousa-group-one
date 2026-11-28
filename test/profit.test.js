"use strict";
// Profitability: one calculation everywhere — sales and costs excluding VAT, labour at each
// employee's hourly cost, material taken from stock, purchases without their VAT, credit notes.
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const P = require("../profit");
const D = require("../domain");
const { database } = require("./database");
const { migrate } = require("../db");
const { createApp } = require("../server");

process.env.JWT_SECRET = "test-only-secret-with-at-least-32-characters";

test("hourly cost: salary × 13 / hours really worked × (1 + 18 % charges); hourly wage; part time; fixed cost", () => {
  assert.equal(P.hourlyCost({ salary: 6000, salaryPeriod: "monthly", weeklyHours: 42 }).rate, 47.64, "6000 × 13 / (42 h × 46 weeks) × 1.18");
  assert.equal(P.hourlyCost({ salary: 6000, salaryPeriod: "monthly", activity: 50 }).rate, 95.28, "no weekly hours given: 50 % of 42 h");
  assert.equal(P.hourlyCost({ salary: 30, salaryPeriod: "hourly" }).rate, 35.4);
  assert.equal(P.hourlyCost({ salary: 6000, weeklyHours: 42 }, { chargesPercent: 20, salariesPerYear: 12 }).rate, 44.72);
  assert.equal(P.hourlyCost({ id: "e9", salary: 6000 }, { rates: { e9: 65 } }).rate, 65);
  assert.equal(P.hourlyCost({ salary: 0 }).source, "missing");
  assert.equal(P.settingsOf({ chargesPercent: 500 }).chargesPercent, 18, "out of range: the default");
});

test("a project's profitability: the example of the analysis, credit notes, change orders, material, warnings", () => {
  const data = {
    employees: [
      { id: "e1", name: "Léa", salary: 6000, salaryPeriod: "monthly", weeklyHours: 42 },
      { id: "e2", name: "Sans salaire" },
    ],
    invoices: [
      { id: "F1", project: "P1", status: "Émise", amount: 10810, net: 10000, paid: 0 },
      { id: "F2", project: "P1", status: "Brouillon", amount: 5000, net: 4625 },
      { id: "F3", project: "P1", status: "Annulée", amount: 999, net: 999 },
    ],
    quotes: [
      { id: "D1", project: "P1", status: "Accepté", amount: 12972, net: 12000 },
      { id: "D2", project: "P1", status: "Refusé", amount: 1000, net: 1000 },
    ],
    payments: [
      { invoice: "F1", amount: 5000, kind: undefined },
      { invoice: "F1", amount: 1081, kind: "credit" },
    ],
    time: [
      { project: "P1", employeeId: "e1", hours: 60, status: "Validée" },
      { project: "P1", employeeId: "e2", hours: 4, status: "Validée" },
      { project: "P1", employeeId: "e1", hours: 8, status: "En attente" },
      { project: "P2", employeeId: "e1", hours: 100, status: "Validée" },
    ],
    expenses: [
      { project: "P1", amount: 3243, vatRate: 8.1 },
      { project: "P1", amount: 100, vatRate: 0 },
      { project: "P1", amount: 108.1 },
    ],
    inventory: [{ id: "i1", name: "Câble 3G2.5", unit: "m", buy: 1.5 }, { id: "i2", name: "Prise", unit: "pce", buy: 0 }],
  };
  const movements = [
    { inventory_id: "i1", quantity: -100 }, // taken for the project
    { inventory_id: "i1", quantity: 20 }, // brought back
    { inventory_id: "i1", quantity: -30 }, // transfer: out of one place…
    { inventory_id: "i1", quantity: 30 }, // …into another
    { inventory_id: "i2", quantity: -4 },
  ];
  const r = P.projectProfit(data, { id: "P1", status: "En cours", team: ["e1"], plannedHours: 50, plannedMaterial: 1000 }, { movements, changeOrders: [{ amount: 500, status: "approved" }, { amount: 900, status: "sent" }] });
  assert.equal(r.sales.invoicedHT, 10000, "excluding VAT; drafts and invoices cancelled without credit note left out");
  assert.equal(r.sales.creditedHT, 1000, "credit note of 1081 TTC = 1000 excluding VAT");
  assert.equal(r.sales.salesHT, 9000);
  assert.equal(r.sales.priceHT, 12500, "accepted quote + accepted change order");
  assert.equal(r.sales.remainingToInvoiceHT, 3500);
  assert.equal(r.sales.paid, 5000, "the credit note is not money received");
  assert.equal(r.costs.labourHours, 64);
  assert.equal(r.costs.labour, Math.round(60 * 47.64 * 100) / 100, "only validated hours, at each employee's cost");
  assert.equal(r.costs.unvaluedHours, 4);
  assert.equal(r.costs.pendingHours, 8);
  assert.equal(r.costs.material, 120, "80 m consumed × 1.50 (transfers cancel out)");
  assert.deepEqual(r.costs.materialLines.map((x) => [x.name, x.quantity]), [["Câble 3G2.5", 80], ["Prise", 4]]);
  assert.equal(r.costs.purchases, 3200, "3243 with 8.1 % = 3000; 100 without VAT; 108.10 assumed 8.1 % = 100");
  assert.equal(r.margin, Math.round((9000 - (2858.4 + 120 + 3200)) * 100) / 100);
  assert.equal(r.marginPct, Math.round(((9000 - 6178.4) / 9000) * 10000) / 100);
  assert.ok(r.forecast);
  assert.equal(r.forecast.plannedCost, Math.round((50 * 47.64 + 1000) * 100) / 100);
  assert.equal(r.forecast.priceHT, 12500);
  const warnings = r.warnings.join(" | ");
  assert.match(warnings, /4 h sans coût horaire/);
  assert.match(warnings, /8 h pas encore validées/);
  assert.match(warnings, /sans prix d’achat/);
  assert.match(warnings, /1 dépense sans taux de TVA : 8.1 % supposé/);
  assert.match(warnings, /Heures prévues dépassées : 64 h pour 50 h/);
  // The old formula: invoiced TTC − expenses: 10 810 − 3451.10 = 7358.90, far above.
  assert.ok(r.margin < 3000);
  const t = P.total([r, r]);
  assert.equal(t.salesHT, 18000);
  assert.equal(t.margin, r.margin * 2);
});

let db, server, url;
const tokens = {};
async function call(path, who, body) {
  const res = await fetch(url + "/api/" + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + tokens[who], ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
let invoiceId, paidInvoiceId;
test.before(async () => {
  db = await database();
  await migrate(db);
  const hash = await bcrypt.hash("A-Strong-Test-Password", 4);
  for (const [email, role, company] of [
    ["pf-admin@test.invalid", "admin", "group"],
    ["pf-accounting@test.invalid", "accounting", "home"],
    ["pf-manager@test.invalid", "manager", "home"],
  ])
    await db.query("INSERT INTO users(email,password_hash,role,name,avatar,company) VALUES($1,$2,$3,$4,'',$5)", [email, hash, role, "PF " + role, company]);
  const d = D.emptyState();
  const admin = { id: 1, role: "admin", company: "group" };
  d.clients = [{ id: "c1", company: "home", name: "Ambassade", email: "a@amb.test", city: "Berne" }];
  d.employees = [{ id: "e1", name: "Léa", company: "home", companies: ["home"], status: "Actif", salary: 6000, salaryPeriod: "monthly", weeklyHours: 42, activity: 100, vacation: 25 }];
  d.projects = [{ id: "SH-1", company: "home", clientId: "c1", title: "Rénovation", address: "Rue 1", status: "En cours", team: ["e1"], budget: 10810, cost: 0, start: "2026-11-01", end: "2026-12-01" }];
  d.time = [{ id: "t1", project: "SH-1", employeeId: "e1", hours: 10, status: "Validée", date: "2026-11-10" }];
  const inv = D.applyCommand(d, admin, { action: "create", collection: "invoices", payload: { company: "home", clientId: "c1", project: "SH-1", title: "Travaux", date: "2026-11-01", due: "2026-11-30", lines: [{ description: "Travaux", quantity: 1, unitPrice: 1000, vatRate: 8.1 }] } }).result;
  D.applyCommand(d, admin, { action: "invoice.issue", payload: { id: inv.id } });
  invoiceId = inv.id;
  const paid = D.applyCommand(d, admin, { action: "create", collection: "invoices", payload: { company: "home", clientId: "c1", title: "Dépannage", date: "2026-11-01", due: "2026-11-30", lines: [{ description: "Dépannage", quantity: 1, unitPrice: 200, vatRate: 0 }] } }).result;
  D.applyCommand(d, admin, { action: "invoice.issue", payload: { id: paid.id } });
  D.applyCommand(d, admin, { action: "create", collection: "payments", payload: { invoice: paid.id, amount: 200, date: "2026-11-05", method: "Virement" } });
  paidInvoiceId = paid.id;
  D.applyCommand(d, admin, { action: "create", collection: "expenses", payload: { company: "home", project: "SH-1", supplier: "Elektro", amount: 216.2, vatRate: 8.1, date: "2026-11-03" } });
  await db.query("UPDATE app_state SET data=$1 WHERE id=1", [JSON.stringify(d)]);
  server = createApp(db).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  url = "http://127.0.0.1:" + server.address().port;
  for (const who of ["admin", "accounting", "manager"]) {
    const r = await fetch(url + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `pf-${who}@test.invalid`, password: "A-Strong-Test-Password" }) });
    tokens[who] = (await r.json()).token;
  }
});
test.after(async () => {
  server?.close();
  await db?.end?.();
});

test("credit notes lower the invoice's balance (not money received); old ones applied on request; refund beyond", async () => {
  // A credit note of 108.10 on the 1081 invoice: 972.90 left to pay.
  const credit = await call("p1/finance/credit-note", "accounting", { invoiceId, amount: 108.1, reason: "Geste commercial" });
  assert.equal(credit.status, 200, JSON.stringify(credit.data));
  assert.match(credit.data.number, /^AV-\d{4}-0001$/);
  let st = (await call("state", "admin")).data.data;
  let inv = st.invoices.find((i) => i.id === invoiceId);
  assert.equal(inv.paid, 108.1);
  assert.equal(inv.credited, 108.1);
  assert.equal(inv.status, "Partiellement payée");
  const pay = st.payments.find((p) => p.kind === "credit");
  assert.equal(pay.creditNote, credit.data.number);
  // A credit note on a paid invoice: to be refunded to the client.
  const refund = await call("p1/finance/credit-note", "accounting", { invoiceId: paidInvoiceId, amount: 50, reason: "Erreur de quantité" });
  assert.equal(refund.status, 200, JSON.stringify(refund.data));
  assert.equal(refund.data.refund, 50);
  assert.equal((await call("p1/finance/credit-note", "accounting", { invoiceId: paidInvoiceId, amount: 200, reason: "Trop" })).status, 400, "never beyond the invoice");
  assert.equal((await call("p1/finance/credit-note", "manager", { invoiceId, amount: 10, reason: "x" })).status, 403);
  // An older credit note recorded without being applied: applied on request, once.
  await db.query("INSERT INTO p1_credit_notes(id,number,company,invoice_id,client_id,amount,reason,status,created_by) VALUES('old1','AV-2026-0099','home',$1,'c1',100,'Ancien avoir','issued',1)", [invoiceId]);
  const apply = await call("p1/finance/credit-note/old1/apply", "accounting", {});
  assert.equal(apply.status, 200, JSON.stringify(apply.data));
  assert.equal((await call("p1/finance/credit-note/old1/apply", "accounting", {})).status, 400);
  st = (await call("state", "admin")).data.data;
  inv = st.invoices.find((i) => i.id === invoiceId);
  assert.equal(inv.credited, 208.1);
  assert.equal(Math.round((inv.amount - inv.paid) * 100) / 100, 872.9, "the balance reminders and the QR slip ask for");
  // Cash received in the analytics leaves credit notes out.
  const analytics = await call("operations/analytics", "admin");
  assert.equal(analytics.data.kpis.collected, 200);
});

test("profitability: who may see it, the project sheet, the dashboard, the analytics and the settings", async () => {
  assert.equal((await call("profit/project/SH-1", "manager")).status, 403, "margins: management and accounting");
  const r = await call("profit/project/SH-1", "accounting");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const f = r.data.profit;
  assert.equal(f.sales.invoicedHT, 1000);
  assert.equal(f.sales.creditedHT, Math.round((208.1 / 1.081) * 100) / 100);
  assert.equal(f.costs.labour, 476.4, "10 h × 47.64");
  assert.equal(f.costs.purchases, 200);
  // The same numbers in the project sheet, the dashboard and the analytics.
  const sheet = await call("pro/project/SH-1", "admin");
  assert.equal(sheet.data.finance.margin, f.margin);
  assert.equal(sheet.data.finance.costs.total, f.costs.total);
  const dash = await call("pro/dashboard", "admin");
  assert.equal(dash.data.finance.byProject.find((x) => x.id === "SH-1").margin, f.margin);
  const analytics = await call("operations/analytics", "admin");
  assert.equal(analytics.data.byProject.find((x) => x.id === "SH-1").margin, f.margin);
  const managerView = await call("operations/analytics", "manager");
  assert.equal(managerView.data.byProject.find((x) => x.id === "SH-1").margin, null, "no margin for a manager without the permission");
  const summary = await call("profit/summary", "admin");
  assert.equal(summary.data.total.margin, f.margin);
  // Settings: 20 % charges change the labour cost; a fixed cost for the employee.
  assert.equal((await call("profit/settings", "manager", { company: "home", chargesPercent: 20, salariesPerYear: 13, weeksPerYear: 46, fullTimeHours: 42, purchaseVat: 8.1 })).status, 403);
  const saved = await call("profit/settings", "admin", { company: "home", chargesPercent: 20, salariesPerYear: 13, weeksPerYear: 46, fullTimeHours: 42, purchaseVat: 8.1, rates: { e1: 60 } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal((await call("profit/project/SH-1", "admin")).data.profit.costs.labour, 600);
  const cfg = await call("profit/settings", "admin");
  const home = cfg.data.companies.find((c) => c.id === "home");
  assert.equal(home.settings.chargesPercent, 20);
  assert.equal(home.employees[0].fixed, 60);
  const acc = await call("profit/settings", "accounting");
  assert.deepEqual(acc.data.companies.find((c) => c.id === "home").employees, [], "salaries only for HR and management");
  assert.equal((await call("profit/settings", "admin", { company: "home", chargesPercent: 150, salariesPerYear: 13, weeksPerYear: 46, fullTimeHours: 42, purchaseVat: 8.1 })).status, 400);
});

test("planned hours and material on a project; VAT rate on an expense", async () => {
  const st = (await call("state", "admin")).data;
  const p = st.data.projects.find((x) => x.id === "SH-1");
  const body = (payload) => ({ requestId: "req-" + Math.random().toString(36).slice(2) + "-0123456789", revision: st.revision, action: "project.update", payload });
  const upd = await call("state/command", "admin", body({ id: "SH-1", status: p.status, progress: 40, description: "", team: ["e1"], plannedHours: 20, plannedMaterial: 300 }));
  assert.equal(upd.status, 200, JSON.stringify(upd.data));
  const f = (await call("profit/project/SH-1", "admin")).data.profit;
  assert.equal(f.forecast.plannedHours, 20);
  assert.equal(f.forecast.plannedCost, 20 * 60 + 300);
  const d = D.emptyState();
  d.projects = [];
  const exp = D.applyCommand(d, { id: 1, role: "admin", company: "group" }, { action: "create", collection: "expenses", payload: { company: "home", supplier: "X", amount: 100, vatRate: 2.6, date: "2026-11-01" } }).result;
  assert.equal(exp.vatRate, 2.6);
  assert.throws(() => D.applyCommand(d, { id: 1, role: "admin", company: "group" }, { action: "create", collection: "expenses", payload: { company: "home", supplier: "X", amount: 100, vatRate: 50, date: "2026-11-01" } }), /TVA invalide/);
});
