"use strict";
// The profitability of a project, the same everywhere in the application.
//
//   Sales (excluding VAT) = issued invoices − credit notes
//   Costs                 = labour (validated hours × hourly cost of each employee)
//                         + material taken from stock for the project (at purchase price)
//                         + purchases and expenses (excluding VAT)
//   Margin                = sales − costs
//
// The agreed price (accepted quotes + accepted change orders) shows what is left to invoice, and,
// with the planned hours and material, the expected margin.

const DEFAULTS = {
  chargesPercent: 18, // employer charges on top of the salary (AVS/AI/APG, AC, LPP, LAA…)
  salariesPerYear: 13, // 13th month salary
  weeksPerYear: 46, // weeks actually worked (52 − holidays − public holidays)
  fullTimeHours: 42, // weekly hours of a full-time job, when the employee's are not given
  purchaseVat: 8.1, // VAT assumed in an expense recorded without its rate
};
const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const same = (a, b) => a != null && b != null && String(a) === String(b);

function settingsOf(raw = {}) {
  const s = { ...DEFAULTS, ...(raw || {}) };
  const clamp = (v, min, max, d) => (Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : d);
  return {
    chargesPercent: clamp(s.chargesPercent, 0, 100, DEFAULTS.chargesPercent),
    salariesPerYear: clamp(s.salariesPerYear, 12, 14, DEFAULTS.salariesPerYear),
    weeksPerYear: clamp(s.weeksPerYear, 30, 52, DEFAULTS.weeksPerYear),
    fullTimeHours: clamp(s.fullTimeHours, 20, 60, DEFAULTS.fullTimeHours),
    purchaseVat: clamp(s.purchaseVat, 0, 30, DEFAULTS.purchaseVat),
    rates: Object.fromEntries(Object.entries(s.rates || {}).filter(([, v]) => Number(v) > 0 && Number(v) < 1000).map(([k, v]) => [String(k), Number(v)])),
  };
}

// What one worked hour of this employee costs the company (salary and employer charges).
function hourlyCost(e, raw) {
  const s = settingsOf(raw);
  const override = s.rates[String(e?.id)];
  if (override) return { rate: round(override), source: "fixed" };
  const salary = num(e?.salary);
  if (!(salary > 0)) return { rate: 0, source: "missing" };
  const charges = 1 + s.chargesPercent / 100;
  if (e.salaryPeriod === "hourly") return { rate: round(salary * charges), source: "hourly" };
  const weekly = num(e.weeklyHours) > 0 ? num(e.weeklyHours) : (s.fullTimeHours * (num(e.activity) || 100)) / 100;
  const hours = weekly * s.weeksPerYear;
  if (!(hours > 0)) return { rate: 0, source: "missing" };
  return { rate: round(((salary * s.salariesPerYear) / hours) * charges), source: "monthly" };
}

// Excluding VAT: an invoice's « net », or its amount when the net is not known.
const netOf = (doc) => (Number.isFinite(Number(doc?.net)) && doc.net !== "" ? num(doc.net) : num(doc?.amount));
const htRatio = (doc) => (num(doc?.amount) > 0 ? netOf(doc) / num(doc.amount) : 1);
const isCredit = (p) => p?.kind === "credit";

// The project's documents, as the project sheet and the dashboards see them.
function projectDocuments(data, p) {
  const ids = new Set((p.invoiceIds || []).map(String));
  const invoices = (data.invoices || []).filter((i) => !i.deletedAt && (same(i.project, p.id) || ids.has(String(i.id))));
  const quotes = (data.quotes || []).filter((q) => !q.deletedAt && (same(q.project, p.id) || same(q.id, p.quoteId)));
  return { invoices, quotes };
}

/**
 * data: { invoices, quotes, payments, time, employees, expenses, inventory } (the state)
 * extra: { movements: inventory movements of the project, changeOrders: of the project, settings }
 */
function projectProfit(data, p, { movements = [], changeOrders = [], settings = {} } = {}) {
  const s = settingsOf(settings);
  const { invoices, quotes } = projectDocuments(data, p);
  const invoiceIds = new Set(invoices.map((i) => String(i.id)));
  const payments = (data.payments || []).filter((x) => invoiceIds.has(String(x.invoice)));
  const creditedBy = new Map();
  for (const x of payments.filter(isCredit)) creditedBy.set(String(x.invoice), (creditedBy.get(String(x.invoice)) || 0) + num(x.amount));
  // Issued invoices; one cancelled without a credit note does not count.
  const counted = invoices.filter((i) => i.status !== "Brouillon" && !(i.status === "Annulée" && !creditedBy.get(String(i.id))));
  const invoicedHT = counted.reduce((t, i) => t + netOf(i), 0);
  const creditedHT = counted.reduce((t, i) => t + (creditedBy.get(String(i.id)) || 0) * htRatio(i), 0);
  const paidCash = payments.filter((x) => !isCredit(x)).reduce((t, x) => t + num(x.amount), 0);
  const quotedHT = quotes.filter((q) => q.status === "Accepté").reduce((t, q) => t + netOf(q), 0);
  const changeOrdersHT = changeOrders.filter((x) => ["approved", "accepted"].includes(String(x.status).toLowerCase())).reduce((t, x) => t + num(x.amount), 0);

  // Labour: validated hours, each at its employee's hourly cost.
  const employees = new Map((data.employees || []).map((e) => [String(e.id), e]));
  const hours = (data.time || []).filter((t) => same(t.project, p.id) && !t.deletedAt);
  const validated = hours.filter((t) => t.status === "Validée");
  let labour = 0,
    labourHours = 0,
    unvaluedHours = 0;
  const people = new Map();
  for (const t of validated) {
    const h = num(t.hours);
    const e = employees.get(String(t.employeeId));
    const { rate } = hourlyCost(e, s);
    labourHours += h;
    if (rate > 0) labour += h * rate;
    else unvaluedHours += h;
    const row = people.get(String(t.employeeId)) || { employeeId: String(t.employeeId), name: e?.name || "", hours: 0, cost: 0 };
    row.hours += h;
    row.cost += h * rate;
    people.set(String(t.employeeId), row);
  }
  const pendingHours = hours.filter((t) => t.status !== "Validée").reduce((n, t) => n + num(t.hours), 0);

  // Material: what left the stock for this project, less what came back (transfers cancel out).
  const items = new Map((data.inventory || []).map((x) => [String(x.id), x]));
  const byItem = new Map();
  for (const m of movements) byItem.set(String(m.inventory_id), (byItem.get(String(m.inventory_id)) || 0) - num(m.quantity));
  const materialLines = [...byItem]
    .filter(([, q]) => q > 0)
    .map(([id, q]) => {
      const item = items.get(id);
      return { inventoryId: id, name: item?.name || "Article supprimé", unit: item?.unit || "", quantity: round(q), cost: round(q * num(item?.buy)), priced: num(item?.buy) > 0 };
    });
  const material = materialLines.reduce((t, x) => t + x.cost, 0);

  // Purchases: recorded with their VAT included; the VAT is recovered, the cost is the rest.
  const expenses = (data.expenses || []).filter((x) => !x.deletedAt && same(x.project, p.id));
  let purchases = 0,
    assumedVat = 0;
  for (const x of expenses) {
    const rate = x.vatRate === undefined || x.vatRate === null || x.vatRate === "" ? (assumedVat++, s.purchaseVat) : num(x.vatRate);
    purchases += num(x.amount) / (1 + rate / 100);
  }

  const salesHT = invoicedHT - creditedHT;
  const costs = labour + material + purchases;
  const margin = salesHT - costs;
  const priceHT = quotedHT + changeOrdersHT;

  // Expected: the planned hours (at the team's average cost) and material, against the agreed price.
  const plannedHours = num(p.plannedHours),
    plannedMaterial = num(p.plannedMaterial);
  let forecast = null;
  if (plannedHours > 0 || plannedMaterial > 0) {
    const team = (p.team || []).map((id) => hourlyCost(employees.get(String(id)), s).rate).filter((r) => r > 0);
    const average = team.length ? team.reduce((a, b) => a + b, 0) / team.length : labourHours > 0 && labour > 0 ? labour / (labourHours - unvaluedHours || 1) : 0;
    const plannedCost = plannedHours * average + plannedMaterial;
    const base = priceHT || num(p.budget);
    forecast = {
      plannedHours: round(plannedHours),
      plannedMaterial: round(plannedMaterial),
      averageRate: round(average),
      plannedCost: round(plannedCost),
      priceHT: round(base),
      margin: round(base - plannedCost),
      marginPct: base > 0 ? round(((base - plannedCost) / base) * 100) : null,
      hoursUsedPct: plannedHours > 0 ? round((labourHours / plannedHours) * 100) : null,
    };
  }
  const warnings = [];
  if (unvaluedHours > 0) warnings.push(`${round(unvaluedHours)} h sans coût horaire (salaire non renseigné).`);
  if (pendingHours > 0) warnings.push(`${round(pendingHours)} h pas encore validées (non comptées).`);
  if (materialLines.some((x) => !x.priced)) warnings.push("Du matériel sans prix d’achat (compté à 0).");
  if (assumedVat) warnings.push(`${assumedVat} dépense${assumedVat > 1 ? "s" : ""} sans taux de TVA : ${s.purchaseVat} % supposé.`);
  if (forecast?.plannedHours && labourHours > forecast.plannedHours) warnings.push(`Heures prévues dépassées : ${round(labourHours)} h pour ${forecast.plannedHours} h prévues.`);
  if (costs > 0 && salesHT <= 0 && p.status === "Terminé") warnings.push("Chantier terminé sans facture émise.");

  return {
    sales: {
      quotedHT: round(quotedHT),
      changeOrdersHT: round(changeOrdersHT),
      priceHT: round(priceHT),
      invoicedHT: round(invoicedHT),
      creditedHT: round(creditedHT),
      salesHT: round(salesHT),
      remainingToInvoiceHT: round(Math.max(0, priceHT - salesHT)),
      paid: round(paidCash),
    },
    costs: {
      labour: round(labour),
      labourHours: round(labourHours),
      unvaluedHours: round(unvaluedHours),
      pendingHours: round(pendingHours),
      people: [...people.values()].map((x) => ({ ...x, hours: round(x.hours), cost: round(x.cost) })),
      material: round(material),
      materialLines,
      purchases: round(purchases),
      purchasesCount: expenses.length,
      total: round(costs),
    },
    margin: round(margin),
    marginPct: salesHT > 0 ? round((margin / salesHT) * 100) : null,
    forecast,
    warnings,
  };
}

// The sums of several projects (a company, the group).
function total(rows) {
  const t = { salesHT: 0, costs: 0, labour: 0, material: 0, purchases: 0, margin: 0, priceHT: 0, remainingToInvoiceHT: 0, labourHours: 0 };
  for (const r of rows) {
    t.salesHT += r.sales.salesHT;
    t.priceHT += r.sales.priceHT;
    t.remainingToInvoiceHT += r.sales.remainingToInvoiceHT;
    t.costs += r.costs.total;
    t.labour += r.costs.labour;
    t.material += r.costs.material;
    t.purchases += r.costs.purchases;
    t.labourHours += r.costs.labourHours;
    t.margin += r.margin;
  }
  for (const k of Object.keys(t)) t[k] = round(t[k]);
  t.marginPct = t.salesHT > 0 ? round((t.margin / t.salesHT) * 100) : null;
  return t;
}

module.exports = { DEFAULTS, settingsOf, hourlyCost, projectProfit, total, netOf };
