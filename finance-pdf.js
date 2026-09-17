"use strict";
const PDFDocument = require("pdfkit");
const { SwissQRBill } = require("swissqrbill/pdf");
const D = require("./domain");
const labels = {
  fr: [
    "DEVIS",
    "FACTURE",
    "BROUILLON — NON ÉMIS",
    "Date",
    "Valable jusqu’au",
    "Échéance",
    "Description",
    "Quantité",
    "Prix HT",
    "Remise",
    "TVA",
    "Net HT",
    "Total TTC",
    "Payé",
    "Solde",
    "Conditions",
    "Date et signature",
    "Devis d’origine",
  ],
  de: [
    "ANGEBOT",
    "RECHNUNG",
    "ENTWURF — NICHT AUSGESTELLT",
    "Datum",
    "Gültig bis",
    "Fällig am",
    "Beschreibung",
    "Menge",
    "Nettopreis",
    "Rabatt",
    "MWST",
    "Netto",
    "Gesamtbetrag",
    "Bezahlt",
    "Restbetrag",
    "Bedingungen",
    "Datum und Unterschrift",
    "Ursprüngliches Angebot",
  ],
  it: [
    "PREVENTIVO",
    "FATTURA",
    "BOZZA — NON EMESSA",
    "Data",
    "Valido fino al",
    "Scadenza",
    "Descrizione",
    "Quantità",
    "Prezzo netto",
    "Sconto",
    "IVA",
    "Netto",
    "Totale",
    "Pagato",
    "Saldo",
    "Condizioni",
    "Data e firma",
    "Preventivo originale",
  ],
  en: [
    "QUOTE",
    "INVOICE",
    "DRAFT — NOT ISSUED",
    "Date",
    "Valid until",
    "Due date",
    "Description",
    "Quantity",
    "Net price",
    "Discount",
    "VAT",
    "Net",
    "Total",
    "Paid",
    "Balance",
    "Terms",
    "Date and signature",
    "Original quote",
  ],
};
function qrData(r, issuer, customer) {
  const billing = issuer.billing || {};
  if (r.status === "Brouillon" || !r.due || r.amount <= (r.paid || 0))
    D.fail("Une facture émise avec un solde positif est requise pour le QR.");
  for (const a of [billing, customer])
    if (!a.street || !a.zip || !a.city || !a.country)
      D.fail(
        "Complétez les adresses structurées de l’entreprise et du client avant émission pour générer le QR.",
      );
  if (!billing.iban)
    D.fail("Configurez l’IBAN de l’entreprise avant émission.");
  const address = (a, name) => ({
    name,
    address: a.street,
    buildingNumber: a.buildingNumber || undefined,
    zip: a.zip,
    city: a.city,
    country: a.country,
  });
  return {
    currency: "CHF",
    amount: Math.round((r.amount - (r.paid || 0)) * 100) / 100,
    creditor: { ...address(billing, issuer.name), account: billing.iban },
    debtor: address(customer, customer.name),
    message: r.id,
    ...(r.paymentReference
      ? { reference: r.paymentReference.replace(/\s/g, "") }
      : {}),
  };
}
async function renderPDF(r, kind, issuer, customer, includeQR = false) {
  const t = labels[r.language] || labels.fr,
    quote = kind === "quotes";
  let qr;
  if (includeQR) {
    if (quote) D.fail("Le QR est réservé aux factures.");
    try {
      qr = new SwissQRBill(qrData(r, issuer, customer), {
        fontName: "Liberation Sans",
        language: (r.language || "fr").toUpperCase(),
      });
    } catch (e) {
      D.fail("QR non généré : " + e.message);
    }
  }
  const pdf = new PDFDocument({
    size: "A4",
    margin: 45,
    info: { Title: r.id, Author: issuer.name },
  });
  const chunks = [];
  pdf.registerFont(
    "Liberation Sans",
    require("node:path").join(
      __dirname,
      "assets/fonts/LiberationSans-Regular.ttf",
    ),
  );
  pdf.registerFont(
    "Liberation Sans-Bold",
    require("node:path").join(
      __dirname,
      "assets/fonts/LiberationSans-Bold.ttf",
    ),
  );
  const done = new Promise((resolve, reject) => {
    pdf.on("data", (c) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });
  const money = (n) => `${Number(n || 0).toFixed(2)} CHF`;
  const line = (s, size = 10) => {
    pdf
      .font("Liberation Sans")
      .fontSize(size)
      .fillColor("#20302b")
      .text(String(s || ""), { width: 505 })
      .moveDown(0.5);
  };
  const address = (a) =>
    [a.street, a.buildingNumber].filter(Boolean).join(" ") +
    "\n" +
    [a.zip, a.city, a.country].filter(Boolean).join(" ");
  pdf
    .font("Liberation Sans-Bold")
    .fontSize(22)
    .fillColor("#137456")
    .text(issuer.name);
  line(address(issuer.billing || {}));
  if (issuer.billing?.vatNumber)
    line("TVA / VAT : " + issuer.billing.vatNumber);
  pdf.moveDown();
  line(`${t[quote ? 0 : 1]} ${r.id}`, 18);
  if (r.status === "Brouillon") line(t[2], 12);
  line(`${t[3]} : ${r.date}   |   ${t[quote ? 4 : 5]} : ${r.valid || r.due}`);
  if (r.quoteId) line(`${t[17]} : ${r.quoteId}`);
  pdf.moveDown();
  line(customer.name, 12);
  line(address(customer));
  line(customer.email);
  pdf.moveDown();
  line(r.title, 15);
  for (const l of r.lines || [
    { description: r.title, quantity: 1, unitPrice: r.amount },
  ]) {
    const details = `${t[7]} : ${l.quantity} ${l.unit || ""}   |   ${t[8]} : ${money(l.unitPrice)}   |   ${t[9]} : ${l.discount || 0} %   |   ${t[10]} : ${l.vatRate || 0} %`;
    const height =
      pdf.fontSize(11).heightOfString(l.description, { width: 505 }) + 60;
    if (pdf.y + height > 760) pdf.addPage();
    line(l.description, 11);
    line(details, 9);
    line(
      `${t[11]} : ${money(l.net ?? Math.round(l.quantity * l.unitPrice * 100) / 100)}   |   ${t[12]} : ${money(l.total ?? Math.round(l.quantity * l.unitPrice * 100) / 100)}`,
    );
    pdf.moveTo(45, pdf.y).lineTo(550, pdf.y).strokeColor("#dde4e1").stroke();
    pdf.moveDown();
  }
  if (pdf.y > 610) pdf.addPage();
  if (r.net !== undefined) {
    line(
      `${t[9]} : ${money(r.discountAmount)}   |   ${t[11]} : ${money(r.net)}`,
    );
    for (const g of r.taxGroups || [])
      line(`${t[10]} ${g.rate} % : ${money(g.tax)}`);
  }
  line(`${t[12]} : ${money(r.amount)}`, 16);
  if (!quote)
    line(
      `${t[13]} : ${money(r.paid)}   |   ${t[14]} : ${money(r.amount - (r.paid || 0))}`,
    );
  if (issuer.billing?.iban) line("IBAN : " + issuer.billing.iban);
  if (r.paymentReference) line("Reference : " + r.paymentReference);
  if (r.message) {
    pdf.moveDown();
    line(r.message);
  }
  if (r.terms) {
    pdf.moveDown();
    line(t[15], 12);
    line(r.terms);
  }
  if (quote && r.signature !== false) {
    if (pdf.y > 675) pdf.addPage();
    pdf.moveDown(2);
    line(t[16] + " : __________________________________");
  }
  if (qr) {
    pdf.addPage();
    line(`${t[1]} ${r.id} — ${t[14]} : ${money(r.amount - (r.paid || 0))}`, 14);
    qr.attachTo(pdf);
  }
  pdf.end();
  return done;
}
module.exports = { renderPDF, qrData };
