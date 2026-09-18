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
    amount: require("./finance").paymentSummary(r).requested,
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
  const extra = {
    fr: [
      "Non compris / options",
      "Acompte",
      "Montant de l’acompte",
      "Acompte restant",
      "Montant à payer",
      "Page",
      "de",
      "Qté",
      "Total",
      "Objet",
    ],
    de: [
      "Nicht enthalten / Optionen",
      "Anzahlung",
      "Anzahlungsbetrag",
      "Offene Anzahlung",
      "Zahlbetrag",
      "Seite",
      "von",
      "Menge",
      "Gesamt",
      "Betreff",
    ],
    it: [
      "Non incluso / opzioni",
      "Acconto",
      "Importo acconto",
      "Acconto residuo",
      "Importo da pagare",
      "Pagina",
      "di",
      "Qtà",
      "Totale",
      "Oggetto",
    ],
    en: [
      "Not included / options",
      "Deposit",
      "Deposit amount",
      "Remaining deposit",
      "Amount payable",
      "Page",
      "of",
      "Qty",
      "Total",
      "Subject",
    ],
  }[r.language] || [
    "Non compris / options",
    "Acompte",
    "Montant de l’acompte",
    "Acompte restant",
    "Montant à payer",
    "Page",
    "de",
    "Qté",
    "Total",
    "Objet",
  ];
  const payment = require("./finance").paymentSummary(r);
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
    margins: { top: 40, left: 40, right: 40, bottom: 30 },
    bufferPages: true,
    info: { Title: r.id, Author: issuer.name },
  });
  const path = require("node:path");
  pdf.registerFont(
    "Liberation Sans",
    path.join(__dirname, "assets/fonts/LiberationSans-Regular.ttf"),
  );
  pdf.registerFont(
    "Liberation Sans-Bold",
    path.join(__dirname, "assets/fonts/LiberationSans-Bold.ttf"),
  );
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    pdf.on("data", (c) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });
  const regular = "Liberation Sans",
    bold = "Liberation Sans-Bold";
  const left = 40,
    right = 555,
    bottom = 775;
  let y = 40;
  const money = (n) =>
    Number(n || 0)
      .toFixed(2)
      .replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  const date = (v) => (v ? v.split("-").reverse().join(".") : "");
  function font(size = 10.5, heavy = false) {
    pdf
      .font(heavy ? bold : regular)
      .fontSize(size)
      .fillColor("#111111");
  }
  function wrap(value, width, size = 10.5, heavy = false) {
    font(size, heavy);
    const out = [];
    for (const paragraph of String(value || "")
      .replace(/\r/g, "")
      .split("\n")) {
      let current = "";
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const candidate = current ? current + " " + word : word;
        if (pdf.widthOfString(candidate) <= width) {
          current = candidate;
          continue;
        }
        if (current) out.push(current);
        current = "";
        for (const char of word) {
          if (current && pdf.widthOfString(current + char) > width) {
            out.push(current);
            current = "";
          }
          current += char;
        }
      }
      out.push(current);
    }
    return out;
  }
  function draw(
    value,
    x,
    yy,
    width,
    size = 10.5,
    heavy = false,
    align = "left",
  ) {
    font(size, heavy);
    pdf.text(String(value || ""), x, yy, { width, align, lineBreak: false });
  }
  function newPage(table = false) {
    pdf.addPage();
    y = 40;
    if (table) tableHeader();
  }
  function ensure(height, table = false) {
    if (y + height > bottom) newPage(table);
  }
  function paragraph(
    value,
    { width = 515, size = 10.5, heavy = false, gap = 12 } = {},
  ) {
    if (!value) return;
    for (const line of wrap(value, width, size, heavy)) {
      ensure(16);
      draw(line, left, y, width, size, heavy);
      y += 16;
    }
    y += gap;
  }
  function section(title, value) {
    if (!value) return;
    ensure(48);
    paragraph(title, { size: 12, heavy: true, gap: 4 });
    paragraph(value, { gap: 20 });
  }
  function tableHeader() {
    draw(t[6], 40, y, 295, 10.5, true);
    draw(extra[7], 350, y, 42, 9.5, true);
    draw(
      r.tax > 0 ? t[8] : r.language === "fr" ? "Prix" : t[8],
      404,
      y,
      65,
      10,
      true,
    );
    draw(extra[8], 482, y, 73, 10.5, true, "right");
    y += 22;
    rule();
    y += 9;
  }
  function rule(x = 40) {
    pdf
      .save()
      .strokeColor("#cccccc")
      .lineWidth(0.5)
      .dash(1, { space: 2 })
      .moveTo(x, y)
      .lineTo(right, y)
      .stroke()
      .restore();
  }
  const logo =
    issuer.id === "home" || r.company === "home"
      ? path.join(__dirname, "assets/logos/home.png")
      : null;
  if (logo) pdf.image(logo, 40, 40, { width: 68, height: 68 });
  else draw("SOUSA", 40, 50, 230, 25, true);
  draw(t[quote ? 0 : 1], 300, 44, 255, 22, true, "right");
  if (r.status === "Brouillon") draw(t[2], 270, 76, 285, 9, true, "right");
  const billing = issuer.billing || {};
  const issuerLines = [
    issuer.name,
    [billing.street, billing.buildingNumber].filter(Boolean).join(" "),
    [billing.zip, billing.city].filter(Boolean).join(" "),
    billing.country === "CH" ? "" : billing.country,
    billing.vatNumber,
    billing.email,
  ].filter(Boolean);
  let sy = 124;
  issuerLines.forEach((v, i) => {
    for (const line of wrap(v, 250, 10.5, i === 0)) {
      draw(line, 40, sy, 250, 10.5, i === 0);
      sy += 15;
    }
  });
  let cy = 169;
  const customerLines = [
    customer.name,
    [customer.street, customer.buildingNumber].filter(Boolean).join(" "),
    [customer.zip, customer.city].filter(Boolean).join(" "),
    customer.country === "CH" ? "" : customer.country,
  ].filter(Boolean);
  customerLines.forEach((v, i) => {
    for (const line of wrap(v, 210, 10.5, i === 0)) {
      draw(line, 338, cy, 217, 10.5, i === 0);
      cy += 15;
    }
  });
  y = Math.max(sy, cy) + 20;
  for (const [key, value] of [
    [t[quote ? 0 : 1] + " N°", r.id],
    [t[3], date(r.date)],
    [t[quote ? 4 : 5], date(r.valid || r.due)],
    ...(r.quoteId ? [[t[17], r.quoteId]] : []),
  ]) {
    const a = wrap(key, 100, 10),
      b = wrap(value, 300, 10.5);
    ensure(Math.max(a.length, b.length) * 16);
    a.forEach((v, i) => draw(v, 40, y + i * 16, 100, 10));
    b.forEach((v, i) => draw(v, 145, y + i * 16, 300, 10.5));
    y += Math.max(a.length, b.length) * 16 + 3;
  }
  y += 14;
  if (r.message) paragraph(r.message);
  if (payment.depositPercent)
    paragraph(extra[1] + " : " + payment.depositPercent + " %", { gap: 12 });
  paragraph(extra[9] + " : " + r.title, { gap: r.scope ? 4 : 22 });
  if (r.scope) paragraph(r.scope, { gap: 24 });
  ensure(65);
  tableHeader();
  for (const l of r.lines || [
    { description: r.title, quantity: 1, unitPrice: r.amount },
  ]) {
    const lines = [
      ...wrap(l.description, 295, 10.5, true).map((v) => ({
        value: v,
        heavy: true,
      })),
      ...(l.details
        ? wrap(l.details, 295).map((v) => ({ value: v, heavy: false }))
        : []),
      ...(l.discount || l.vatRate
        ? wrap(
            (l.discount ? t[9] + " : " + l.discount + " %   " : "") +
              (l.vatRate ? t[10] + " : " + l.vatRate + " %" : ""),
            295,
            9,
          ).map((v) => ({ value: v, size: 9 }))
        : []),
    ];
    const height = lines.length * 15 + 18;
    if (height <= bottom - 80) ensure(height, true);
    let first = true;
    for (const line of lines) {
      ensure(18, true);
      if (first) {
        draw(
          String(l.quantity) + (l.unit && l.unit !== "pcs" ? " " + l.unit : ""),
          350,
          y,
          42,
          9.5,
        );
        draw(money(l.unitPrice), 402, y, 67, 10.5);
        draw(
          money(l.total ?? Math.round(l.quantity * l.unitPrice * 100) / 100),
          482,
          y,
          73,
          10.5,
          false,
          "right",
        );
        first = false;
      }
      draw(line.value, 40, y, 295, line.size || 10.5, line.heavy);
      y += 15;
    }
    y += 3;
    rule();
    y += 12;
  }
  y += 12;
  section(extra[0], r.exclusions);
  section(t[15], r.terms);
  // Keep the monetary summary intact; payment instructions can span pages before it.
  paragraph(r.paymentNote, { gap: 18 });
  const totals = [];
  if (r.discountAmount) totals.push([t[9], money(r.discountAmount)]);
  if (r.tax > 0) {
    totals.push([t[11], money(r.net)]);
    for (const g of r.taxGroups || [])
      if (g.tax) totals.push([t[10] + " " + g.rate + " %", money(g.tax)]);
  }
  totals.push([extra[8] + " (CHF)", money(r.amount)]);
  if (payment.depositPercent)
    totals.push(
      [extra[1], payment.depositPercent + " %"],
      [extra[2], money(payment.depositAmount)],
    );
  if (!quote && r.paid)
    totals.push([t[13], money(r.paid)], [t[14], money(payment.balance)]);
  if (!quote && payment.depositPercent)
    totals.push([
      payment.isDeposit ? extra[3] : extra[4],
      money(payment.requested),
    ]);
  ensure(totals.length * 22 + 30);
  rule(350);
  y += 12;
  totals.forEach(([key, value], i) => {
    draw(key, 350, y, 137, 10, i === totals.length - 1);
    draw(value, 490, y, 65, 10.5, i === totals.length - 1, "right");
    y += 22;
  });
  if (!qr && billing.iban) {
    y += 12;
    paragraph("IBAN : " + billing.iban, { size: 9 });
  }
  if (r.paymentReference)
    paragraph("Reference : " + r.paymentReference, { size: 9 });
  if (quote && r.signature !== false) {
    ensure(65);
    y += 25;
    paragraph(t[16] + " : __________________________________");
  }
  if (qr) {
    newPage();
    pdf.y = 40;
    qr.attachTo(pdf, 0, 40);
  }
  const range = pdf.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    pdf.switchToPage(range.start + i);
    const savedBottom = pdf.page.margins.bottom;
    pdf.page.margins.bottom = 0;
    draw(
      extra[5] + " " + (i + 1) + " " + extra[6] + " " + range.count,
      40,
      815,
      515,
      9,
      false,
      "center",
    );
    pdf.page.margins.bottom = savedBottom;
  }
  pdf.end();
  return done;
}
module.exports = { renderPDF, qrData };
