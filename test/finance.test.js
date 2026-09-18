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
