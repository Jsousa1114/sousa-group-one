"use strict";
// Bank statements from Swiss e-banking (ISO 20022 « camt.053 », « camt.054 », « camt.052 »;
// XML, or several XML files in a ZIP) and the invoices each credit pays.
const zlib = require("node:zlib");
const { createHash } = require("node:crypto");
const { parseDocument } = require("htmlparser2");

const MAX_FILES = 200,
  MAX_BYTES = 40 * 1024 * 1024;

// A ZIP holds the XML files of several days or accounts (PostFinance, UBS…): read its directory.
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error("Fichier ZIP illisible.");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16),
    total = 0;
  const out = [];
  if (count > MAX_FILES) throw new Error("Trop de fichiers dans le ZIP.");
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Fichier ZIP illisible.");
    const method = buf.readUInt16LE(p + 10),
      size = buf.readUInt32LE(p + 20),
      full = buf.readUInt32LE(p + 24),
      nameLen = buf.readUInt16LE(p + 28),
      extraLen = buf.readUInt16LE(p + 30),
      commentLen = buf.readUInt16LE(p + 32),
      local = buf.readUInt32LE(p + 42),
      name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/") || !/\.xml$/i.test(name)) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error("Fichier ZIP illisible.");
    total += full;
    if (total > MAX_BYTES) throw new Error("Le ZIP est trop volumineux.");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28),
      data = buf.subarray(start, start + size);
    if (method === 0) out.push({ name, xml: data.toString("utf8") });
    else if (method === 8) out.push({ name, xml: zlib.inflateRawSync(data, { maxOutputLength: MAX_BYTES }).toString("utf8") });
    else throw new Error("Compression ZIP non prise en charge.");
  }
  if (!out.length) throw new Error("Aucun relevé XML dans le ZIP.");
  return out;
}

const localName = (n) => String(n?.name || "").split(":").pop();
const kids = (n, name) => (n?.children || []).filter((c) => c.type === "tag" && localName(c) === name);
const kid = (n, ...path) => path.reduce((x, part) => (x ? kids(x, part)[0] : undefined), n);
function textOf(n) {
  if (!n) return "";
  if (n.type === "text") return n.data;
  return (n.children || []).map(textOf).join("");
}
const txt = (n, ...path) => textOf(path.length ? kid(n, ...path) : n).trim();
function all(n, name, out = []) {
  for (const c of n?.children || [])
    if (c.type === "tag") {
      if (localName(c) === name) out.push(c);
      all(c, name, out);
    }
  return out;
}
const cents = (v) => {
  const n = Number(String(v || "").trim());
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};
const day = (node) => {
  const d = txt(node, "Dt") || txt(node, "DtTm").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "";
};

// The credits (money received) of one camt XML document.
function parseCamt(xml) {
  if (!/<(\w+:)?Document[\s>]/.test(xml) || !/camt\.05[234]/.test(xml))
    throw new Error("Ce fichier n’est pas un relevé bancaire camt.053 / camt.054.");
  const doc = parseDocument(xml, { xmlMode: true });
  const containers = [...all(doc, "Stmt"), ...all(doc, "Ntfctn"), ...all(doc, "Rpt")];
  const credits = [];
  let account = "";
  for (const box of containers) {
    const iban = txt(box, "Acct", "Id", "IBAN").replace(/\s/g, "").toUpperCase();
    account ||= iban;
    kids(box, "Ntry").forEach((ntry, entryIndex) => {
      if (txt(ntry, "CdtDbtInd") !== "CRDT" || txt(ntry, "RvslInd") === "true") return;
      const status = txt(ntry, "Sts", "Cd") || txt(ntry, "Sts");
      if (status && status !== "BOOK") return;
      const amountNode = kid(ntry, "Amt"),
        entryAmount = cents(textOf(amountNode)),
        currency = amountNode?.attribs?.Ccy || "CHF",
        date = day(kid(ntry, "BookgDt")) || day(kid(ntry, "ValDt")),
        entryRef = txt(ntry, "AcctSvcrRef"),
        entryInfo = txt(ntry, "AddtlNtryInf");
      const txs = kids(ntry, "NtryDtls").flatMap((d) => kids(d, "TxDtls"));
      (txs.length ? txs : [null]).forEach((tx, txIndex) => {
        if (tx && txt(tx, "CdtDbtInd") && txt(tx, "CdtDbtInd") !== "CRDT") return;
        let amount = tx
          ? cents(txt(tx, "Amt") || txt(tx, "AmtDtls", "TxAmt", "Amt") || txt(tx, "AmtDtls", "InstdAmt", "Amt"))
          : entryAmount;
        if (!Number.isFinite(amount) && txs.length === 1) amount = entryAmount;
        if (!Number.isFinite(amount) || amount <= 0) return;
        const parties = tx ? kid(tx, "RltdPties") : null;
        const debtor =
          txt(parties, "Dbtr", "Nm") || txt(parties, "Dbtr", "Pty", "Nm") || txt(parties, "UltmtDbtr", "Nm") || txt(parties, "UltmtDbtr", "Pty", "Nm");
        const debtorIban = txt(parties, "DbtrAcct", "Id", "IBAN").replace(/\s/g, "");
        const reference = tx
          ? all(tx, "CdtrRefInf")
              .map((r) => txt(r, "Ref"))
              .find(Boolean) || ""
          : "";
        const text = [
          ...(tx ? all(tx, "Ustrd").map((n) => txt(n)) : []),
          ...(tx ? all(tx, "AddtlRmtInf").map((n) => txt(n)) : []),
          tx ? txt(tx, "AddtlTxInf") : "",
          entryInfo,
        ]
          .filter(Boolean)
          .join(" · ")
          .slice(0, 500);
        const refs = tx ? kid(tx, "Refs") : null;
        const bankRef = txt(refs, "AcctSvcrRef") || txt(refs, "UETR") || "";
        const e2e = txt(refs, "EndToEndId");
        const basis = bankRef
          ? "bank:" + bankRef
          : [entryRef || "", e2e && e2e !== "NOTPROVIDED" ? e2e : "", date, amount, reference, text, debtor, entryIndex, txIndex].join("|");
        credits.push({
          key: createHash("sha256").update(iban + "|" + basis).digest("hex"),
          account: iban,
          date,
          amount: amount / 100,
          currency,
          reference: reference.replace(/\s/g, "").toUpperCase(),
          text,
          debtor: debtor.slice(0, 140),
          debtorIban,
        });
      });
    });
  }
  return { account, credits };
}

// Reads what the person uploaded: one XML file, or a ZIP of XML files.
function readStatement(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Error("Fichier vide.");
  if (buf.length > MAX_BYTES) throw new Error("Fichier trop volumineux.");
  const files = buf.readUInt32LE(0) === 0x04034b50 ? unzip(buf) : [{ name: "releve.xml", xml: buf.toString("utf8").replace(/^﻿/, "") }];
  const accounts = new Set(),
    seen = new Set(),
    credits = [];
  for (const f of files) {
    const out = parseCamt(f.xml);
    if (out.account) accounts.add(out.account);
    for (const c of out.credits)
      if (!seen.has(c.key)) {
        seen.add(c.key);
        credits.push(c);
      }
  }
  credits.sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount);
  return { accounts: [...accounts], credits };
}

const norm = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(sa|sarl|ag|gmbh|sàrl|famille|m|mme|monsieur|madame)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
function sameName(a, b) {
  const x = norm(a).split(" ").filter((w) => w.length > 2),
    y = new Set(norm(b).split(" ").filter((w) => w.length > 2));
  return x.some((w) => y.has(w));
}
const compactId = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// Proposes, for each credit, the invoice it pays: « sure » (its QR reference or its number is in
// the payment), « check » (an amount and a name that fit, or an amount that does not), or nothing.
function matchCredits(credits, invoices, clients, { imported = new Set(), requested = (i) => i.amount - (i.paid || 0) } = {}) {
  const open = invoices.filter(
    (i) => !i.deletedAt && !i.archivedAt && !["Brouillon", "Payée", "Annulée"].includes(i.status) && Math.round(i.amount * 100) - Math.round((i.paid || 0) * 100) > 0,
  );
  const remaining = (i) => Math.round(i.amount * 100) - Math.round((i.paid || 0) * 100);
  const client = (i) => clients.find((c) => String(c.id) === String(i.clientId));
  const byRef = new Map(),
    byId = new Map();
  for (const i of open) {
    if (i.paymentReference) byRef.set(String(i.paymentReference).replace(/\s/g, "").toUpperCase(), i);
    byId.set(compactId(i.id), i);
  }
  const taken = new Map(); // invoice → cents already proposed in this statement
  return credits.map((c) => {
    const base = { ...c, status: "unknown", invoice: "", note: "", suggestions: [] };
    if (imported.has(c.key)) return { ...base, status: "done", note: "Déjà enregistré lors d’un import précédent." };
    if (c.currency && c.currency !== "CHF") return { ...base, note: `Montant en ${c.currency} : à enregistrer à la main.` };
    const amount = Math.round(c.amount * 100);
    let inv = c.reference ? byRef.get(c.reference) : null,
      how = inv ? "référence QR" : "";
    if (!inv) {
      const found = String(c.text || "").toUpperCase().match(/\b[A-Z]{1,4}\s?-?\s?\d{4}\s?-?\s?\d{2,6}\b/g) || [];
      inv = found.map((f) => byId.get(compactId(f))).find(Boolean) || null;
      if (inv) how = "numéro de facture";
    }
    if (inv) {
      const left = remaining(inv) - (taken.get(inv.id) || 0);
      if (amount <= left) {
        taken.set(inv.id, (taken.get(inv.id) || 0) + amount);
        const partial = amount < left && amount !== Math.round(Number(requested(inv)) * 100);
        return { ...base, status: "sure", invoice: inv.id, note: `Reconnu par ${how}${partial ? " · paiement partiel" : ""}.` };
      }
      return { ...base, status: "check", invoice: "", suggestions: [inv.id], note: `Facture ${inv.id} trouvée (${how}), mais le montant dépasse le solde restant.` };
    }
    const fits = open.filter((i) => {
      const left = remaining(i) - (taken.get(i.id) || 0);
      return amount === left || amount === Math.round(Number(requested(i)) * 100);
    });
    const named = fits.filter((i) => c.debtor && sameName(c.debtor, client(i)?.name || i.customer?.name));
    const pick = named.length === 1 ? named[0] : fits.length === 1 ? fits[0] : null;
    if (pick)
      return {
        ...base,
        status: "check",
        suggestions: [pick.id],
        note: named.length === 1 ? "Même montant et même nom que la facture : vérifiez avant d’enregistrer." : "Même montant qu’une facture ouverte : vérifiez le payeur.",
      };
    return { ...base, suggestions: fits.slice(0, 5).map((i) => i.id), note: fits.length ? "Plusieurs factures ont ce montant : choisissez." : "Aucune facture ouverte ne correspond." };
  });
}

module.exports = { readStatement, parseCamt, matchCredits, unzip };
