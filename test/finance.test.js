const test = require("node:test"),
  assert = require("node:assert/strict");
const D = require("../domain"),
  F = require("../finance"),
  { renderPDF, qrData } = require("../finance-pdf");
const admin = { id: 1, role: "admin", company: "group" };
const now = "2026-09-17T12:00:00Z";
function fixture() {
  const d = D.emptyState();
  d.clients = [
    {
      id: "c1",
      company: "home",
      name: "Client Exemple",
      street: "Rue Exemple",
      buildingNumber: "1",
      zip: "1000",
      city: "Lausanne",
      country: "CH",
      email: "test@example.com",
    },
  ];
  d.companies.find((c) => c.id === "home").billing = {
    iban: "CH9300762011623852957",
    street: "Rue Test",
    buildingNumber: "2",
    zip: "1000",
    city: "Lausanne",
    country: "CH",
  };
  return d;
}
const payload = () => ({
  company: "home",
  clientId: "c1",
  title: "Travaux de test",
  date: "2026-09-17",
  valid: "2026-10-17",
  due: "2026-10-17",
  lines: [
    {
      description: "Main-d’œuvre",
      quantity: 2.5,
      unitPrice: 100,
      discount: 10,
      vatRate: 8.1,
      unit: "h",
    },
  ],
  terms: "Paiement à 30 jours.",
  message: "Merci.",
});
function cmd(d, action, p, collection, u = admin) {
  return D.applyCommand(d, u, { action, payload: p, collection }, now).result;
}
test("VAT, fractional quantities, per-line discounts and rounding reconcile", () => {
  const t = F.calculate([
    ...payload().lines,
    {
      description: "Matériel",
      quantity: 3,
      unitPrice: 19.95,
      discount: 0,
      vatRate: 2.6,
    },
  ]);
  assert.equal(t.subtotal, 309.85);
  assert.equal(t.discountAmount, 25);
  assert.equal(t.net, 284.85);
  assert.equal(t.tax, 19.79);
  assert.equal(t.amount, 304.64);
  assert.deepEqual(t.taxGroups, [
    { rate: 2.6, base: 59.85, tax: 1.56 },
    { rate: 8.1, base: 225, tax: 18.23 },
  ]);
  for (const patch of [
    { quantity: -1 },
    { discount: 101 },
    { vatRate: -1 },
    { unitPrice: 1.001 },
    { quantity: 1.0001 },
  ])
    assert.throws(() => F.calculate([{ ...payload().lines[0], ...patch }]));
});
test("accepted quote creates project; completion prepares one invoice with preserved pricing and private history", () => {
  const d = fixture(),
    q = cmd(d, "create", payload(), "quotes");
  cmd(d, "quote.issue", { id: q.id });
  cmd(d, "quote.decide", { id: q.id, status: "Accepté", note: "Accord écrit" });
  assert.equal(d.projects.length, 1);
  const p = d.projects[0];
  assert.equal(q.project, p.id);
  assert.equal(p.clientId, q.clientId);
  d.time.push({ id: "time1", project: p.id, hours: 3.5, employeeId: "e1" });
  d.expenses.push({
    id: "cost1",
    project: p.id,
    amount: 75,
    supplier: "Internal cost",
  });
  d.documents.push({
    id: "doc1",
    project: p.id,
    name: "Photo",
    content: "secret-binary",
  });
  assert.throws(
    () =>
      cmd(d, "project.finish", { id: p.id }, undefined, {
        role: "client",
        company: "home",
        client_id: "c1",
      }),
    /refusé/,
  );
  cmd(d, "project.finish", { id: p.id }, undefined, {
    role: "manager",
    company: "home",
    id: 2,
  });
  const inv = d.invoices[0];
  assert.equal(p.progress, 100);
  assert.equal(p.status, "Terminé");
  assert.equal(inv.status, "Brouillon");
  assert.equal(inv.amount, q.amount);
  assert.deepEqual(inv.lines, q.lines);
  assert.equal(inv.quoteId, q.id);
  assert.equal(inv.completionSnapshot.time[0].hours, 3.5);
  assert.equal(inv.completionSnapshot.documents[0].content, undefined);
  cmd(d, "project.finish", { id: p.id });
  assert.equal(d.invoices.length, 1);
  cmd(d, "invoice.issue", { id: inv.id });
  const customer = D.viewState(d, {
    role: "client",
    company: "home",
    client_id: "c1",
  });
  assert.equal(customer.invoices[0].completionSnapshot, undefined);
  assert.match(customer.invoices[0].workSummary, /3.50 h/);
  assert.throws(
    () => cmd(d, "finance.delete", { kind: "invoices", id: inv.id }),
    /Archivez/,
  );
  cmd(d, "finance.archive", { kind: "invoices", id: inv.id });
  assert.equal(inv.amount, q.amount);
  assert.ok(inv.archivedAt);
  cmd(d, "finance.archive", { kind: "invoices", id: inv.id, restore: true });
  assert.equal(inv.archivedAt, null);
});
test("draft deletion keeps numbering and completion recreates a deleted draft without duplicates", () => {
  const d = fixture(),
    q = cmd(d, "create", payload(), "quotes");
  cmd(d, "finance.delete", { kind: "quotes", id: q.id });
  assert.equal(D.viewState(d, admin).quotes.length, 0);
  const next = cmd(d, "create", payload(), "quotes");
  assert.notEqual(next.id, q.id);
  cmd(d, "quote.issue", { id: next.id });
  cmd(d, "quote.decide", { id: next.id, status: "Accepté", note: "Accord" });
  cmd(d, "project.finish", { id: next.project });
  const first = d.invoices[0];
  cmd(d, "finance.delete", { kind: "invoices", id: first.id });
  cmd(d, "project.finish", { id: next.project });
  assert.equal(d.invoices.filter((i) => !i.deletedAt).length, 1);
  assert.notEqual(next.invoiceId, first.id);
});
test("reference layout deposit follows quote conversion and payments without changing invoice total", async () => {
  const d = fixture(),
    p = {
      ...payload(),
      depositPercent: 30,
      exclusions: "Hors débarras",
      scope: "Objet détaillé",
      paymentNote: "Avant travaux",
      lines: [
        {
          description: "Nettoyage",
          details: "Prestations détaillées\nDeuxième ligne",
          quantity: 1,
          unitPrice: 1090,
        },
      ],
    };
  const q = cmd(d, "create", p, "quotes");
  cmd(d, "quote.issue", { id: q.id });
  cmd(d, "quote.decide", { id: q.id, status: "Accepté", note: "Test" });
  const inv = cmd(d, "quote.convert", { id: q.id, date: p.date, due: p.due });
  cmd(d, "invoice.issue", { id: inv.id });
  assert.equal(inv.lines[0].details, p.lines[0].details);
  assert.equal(inv.exclusions, p.exclusions);
  assert.equal(F.paymentSummary(inv).depositAmount, 327);
  assert.equal(qrData(inv, inv.issuer, inv.customer).amount, 327);
  cmd(
    d,
    "create",
    { invoice: inv.id, amount: 100, date: p.date, method: "Virement" },
    "payments",
  );
  assert.equal(qrData(inv, inv.issuer, inv.customer).amount, 227);
  cmd(
    d,
    "create",
    { invoice: inv.id, amount: 227, date: p.date, method: "Virement" },
    "payments",
  );
  assert.equal(qrData(inv, inv.issuer, inv.customer).amount, 763);
  assert.equal(inv.amount, 1090);
  assert.equal(inv.status, "Partiellement payée");
  for (const depositPercent of [-1, 101, 30.001])
    assert.throws(() =>
      cmd(fixture(), "create", { ...p, depositPercent }, "quotes"),
    );
  const pdf = await renderPDF(
    {
      ...inv,
      message: "",
      terms: "",
      scope: "",
      exclusions: "",
      paymentNote: "",
    },
    "invoices",
    inv.issuer,
    inv.customer,
    true,
  );
  assert.equal(
    (pdf.toString("latin1").match(/\/Type \/Page\b/g) || []).length,
    2,
    "Footer must not create extra pages",
  );
});
test("draft editing preserves numbering; issue locks content and snapshots parties", () => {
  const d = fixture(),
    q = cmd(d, "create", payload(), "quotes");
  assert.equal(
    D.viewState(d, { role: "client", company: "home", client_id: "c1" }).quotes
      .length,
    0,
  );
  cmd(d, "finance.update", {
    ...payload(),
    id: q.id,
    kind: "quotes",
    title: "Titre corrigé",
  });
  assert.equal(d.quotes.length, 1);
  assert.equal(q.id, "D-2026-0001");
  assert.equal(q.title, "Titre corrigé");
  cmd(d, "quote.issue", { id: q.id });
  d.clients[0].name = "Nouveau nom";
  assert.equal(q.customer.name, "Client Exemple");
  assert.throws(
    () => cmd(d, "finance.update", { ...payload(), id: q.id, kind: "quotes" }),
    /brouillon/,
  );
});
test("accepted quote converts once to a linked invoice and preserves financial terms", () => {
  const d = fixture(),
    q = cmd(d, "create", payload(), "quotes");
  assert.throws(
    () =>
      cmd(d, "quote.convert", {
        id: q.id,
        date: "2026-09-17",
        due: "2026-10-17",
      }),
    /Acceptez/,
  );
  cmd(d, "quote.issue", { id: q.id });
  cmd(d, "quote.decide", {
    id: q.id,
    status: "Accepté",
    note: "Accord de test",
  });
  const inv = cmd(d, "quote.convert", {
    id: q.id,
    date: "2026-09-17",
    due: "2026-10-17",
  });
  assert.equal(inv.amount, 243.23);
  assert.equal(inv.quoteId, q.id);
  assert.equal(q.invoiceId, inv.id);
  assert.equal(inv.terms, q.terms);
  assert.deepEqual(inv.lines, q.lines);
  assert.throws(
    () =>
      cmd(d, "quote.convert", {
        id: q.id,
        date: "2026-09-17",
        due: "2026-10-17",
      }),
    /déjà/,
  );
  cmd(d, "invoice.issue", { id: inv.id });
  cmd(
    d,
    "create",
    { invoice: inv.id, amount: 100, date: "2026-09-17", method: "Virement" },
    "payments",
  );
  assert.equal(qrData(inv, inv.issuer, inv.customer).amount, 143.23);
});
test("finance permissions cover editing conversion and billing settings", () => {
  const d = fixture(),
    q = cmd(d, "create", payload(), "quotes");
  for (const u of [
    { role: "hr", company: "home" },
    { role: "accounting", company: "tech" },
    { role: "client", company: "home", client_id: "c1" },
  ]) {
    for (const action of [
      "finance.update",
      "finance.duplicate",
      "quote.convert",
      "quote.decide",
    ])
      assert.throws(() =>
        cmd(d, action, { ...payload(), kind: "quotes", id: q.id }, null, u),
      );
    assert.throws(() =>
      cmd(d, "finance.settings", { company: "home", paymentDays: 30 }, null, u),
    );
  }
});
test("duplicates reset status payment and acceptance metadata", () => {
  const d = fixture(),
    q = cmd(d, "create", payload(), "quotes");
  cmd(d, "quote.issue", { id: q.id });
  cmd(d, "quote.decide", { id: q.id, status: "Accepté", note: "Test" });
  const copy = cmd(d, "finance.duplicate", {
    id: q.id,
    kind: "quotes",
    date: "2026-09-18",
    valid: "2026-10-18",
  });
  assert.notEqual(copy.id, q.id);
  assert.equal(copy.status, "Brouillon");
  assert.equal(copy.acceptedAt, undefined);
  assert.equal(copy.issuer, undefined);
});
test("PDF and QR PDF render in four languages and reject incomplete payment data", async () => {
  const d = fixture(),
    i = cmd(d, "create", payload(), "invoices");
  cmd(d, "invoice.issue", { id: i.id });
  for (const language of ["fr", "de", "it", "en"]) {
    const pdf = await renderPDF(
      { ...i, language },
      "invoices",
      i.issuer,
      i.customer,
      true,
    );
    assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
    assert.ok(pdf.length > 4000);
  }
  await assert.rejects(
    () => renderPDF(i, "invoices", { name: "Test" }, i.customer, true),
    /adresses/,
  );
  await assert.rejects(
    () =>
      renderPDF(
        { ...i, status: "Brouillon" },
        "invoices",
        i.issuer,
        i.customer,
        true,
      ),
    /émise/,
  );
});
test("company branding accepts generated IDs and issuer names with safe fallback", () => {
  const { companyBrand } = require("../finance");
  for (const [name, brand] of [
    ["Sousa Events", "events"],
    ["Sousa Moving", "moving"],
    ["Sousa Solar", "solar"],
    ["Sousa Électricité", "electricite"],
  ]) {
    assert.equal(companyBrand("company-generated-123", { name }), brand);
  }
  assert.equal(
    companyBrand("../../etc/passwd", { name: "constructor" }),
    "group",
  );
  assert.equal(companyBrand("home", { name: "Sousa Events" }), "home");
});

test("completion reuses legacy quote invoices and requires pricing without a quote", () => {
  const d = fixture(),
    q = cmd(d, "create", payload(), "quotes");
  cmd(d, "quote.issue", { id: q.id });
  cmd(d, "quote.decide", { id: q.id, status: "Accepté", note: "Accord" });
  const inv = cmd(d, "quote.convert", {
    id: q.id,
    date: "2026-09-17",
    due: "2026-10-17",
  });
  delete inv.project;
  cmd(d, "project.finish", { id: q.project });
  assert.equal(d.invoices.length, 1);
  assert.equal(inv.project, q.project);
  d.projects.push({
    id: "unquoted",
    company: "home",
    clientId: "c1",
    title: "Intervention",
    team: [],
  });
  cmd(d, "project.finish", { id: "unquoted" });
  const unquoted = d.invoices[1];
  assert.equal(unquoted.amount, 0);
  assert.throws(() => cmd(d, "invoice.issue", { id: unquoted.id }), /prix/);
  cmd(d, "finance.update", {
    ...payload(),
    id: unquoted.id,
    kind: "invoices",
    project: "unquoted",
  });
  cmd(d, "invoice.issue", { id: unquoted.id });
  assert.equal(unquoted.status, "Émise");
});
