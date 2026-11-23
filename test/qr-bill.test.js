"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { SwissQRBill } = require("swissqrbill/pdf");
const { renderPDF } = require("../finance-pdf");

const A4_HEIGHT = 841.89;
const PAYMENT_PART_HEIGHT = 297.64; // 105 mm
const billing = (iban) => ({ street: "Avenue de la Gare", buildingNumber: "12", zip: "1003", city: "Lausanne", country: "CH", iban });
const issuer = (iban) => ({ name: "Sousa Home Service", billing: billing(iban) });
const customer = { name: "Sophie Bernard", street: "Chemin des Vignes", buildingNumber: "4", zip: "1800", city: "Vevey", country: "CH" };
const invoice = (lines = 1, extra = {}) => ({
  id: "F-2026-900",
  title: "Travaux",
  status: "Émise",
  language: "fr",
  date: "2026-11-20",
  due: "2026-12-20",
  amount: 1081 * lines,
  paid: 0,
  lines: Array.from({ length: lines }, (_, i) => ({ description: "Travaux " + (i + 1), quantity: 1, unitPrice: 1000 })),
  ...extra,
});

// Records where the payment part is drawn and on which page, without changing the rendering.
async function placement(r, iban) {
  const original = SwissQRBill.prototype.attachTo;
  const calls = [];
  SwissQRBill.prototype.attachTo = function (doc, x, y) {
    calls.push({ x, y, height: doc.page.height, page: doc.bufferedPageRange().count });
    return original.call(this, doc, x, y);
  };
  try {
    const pdf = await renderPDF(r, "invoices", issuer(iban), customer, true);
    return { pdf, calls };
  } finally {
    SwissQRBill.prototype.attachTo = original;
  }
}

test("QR payment part sits at the bottom of an A4 page, on the invoice page when it fits", async () => {
  const short = await placement(invoice(1), "CH9300762011623852957");
  assert.equal(short.calls.length, 1);
  assert.equal(short.calls[0].x, 0);
  assert.ok(Math.abs(short.calls[0].height - A4_HEIGHT) < 1);
  assert.ok(Math.abs(short.calls[0].y - (A4_HEIGHT - PAYMENT_PART_HEIGHT)) < 1);
  assert.equal(short.calls[0].page, 1, "a short invoice keeps the payment part on its single page");

  const long = await placement(invoice(14), "CH9300762011623852957");
  assert.ok(Math.abs(long.calls[0].y - (A4_HEIGHT - PAYMENT_PART_HEIGHT)) < 1);
  assert.ok(long.calls[0].page >= 2, "a long invoice moves the payment part to the bottom of a new page");
  assert.equal(long.pdf.subarray(0, 4).toString(), "%PDF");
});

test("QR-bill errors are explained in French", async () => {
  await assert.rejects(
    () => renderPDF(invoice(1), "invoices", issuer("CH4431999123000889012"), customer, true),
    /QR-IBAN.*27 chiffres/,
  );
  await assert.rejects(
    () =>
      renderPDF(invoice(1, { paymentReference: "210000000003139471430009017" }), "invoices", issuer("CH9300762011623852957"), customer, true),
    /n’est utilisable qu’avec un QR-IBAN/,
  );
  const ok = await renderPDF(invoice(1, { paymentReference: "210000000003139471430009017" }), "invoices", issuer("CH4431999123000889012"), customer, true);
  assert.equal(ok.subarray(0, 4).toString(), "%PDF");
});
