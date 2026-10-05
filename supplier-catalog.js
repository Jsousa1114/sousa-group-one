"use strict";
const D = require("./domain");
const VENDORS = Object.freeze([
  {
    id: "em",
    name: "Electro-Matériel",
    url: "https://www.elektro-material.ch/fr/shop",
    loginUrl: "https://www.elektro-material.ch/fr/cms/home",
    loginHelp:
      "Sur le site EM, ouvrez la rubrique de connexion à votre compte.",
  },
  {
    id: "sonepar",
    name: "Sonepar Suisse",
    url: "https://www.sonepar.ch/fr",
    loginUrl: "https://www.sonepar.ch/fr",
    loginHelp:
      "Sur le site Sonepar, ouvrez la rubrique de connexion à votre compte.",
  },
  {
    id: "otto-fischer",
    name: "Otto Fischer",
    url: "https://www.ottofischer.ch/fr/",
    loginUrl: "https://www.ottofischer.ch/fr/account/login/?next=%2Ffr%2F",
    loginHelp:
      "Saisissez vos identifiants directement sur la page de connexion Otto Fischer.",
  },
]);
const HEADERS = [
  "reference",
  "designation",
  "ean",
  "numero_e",
  "unite",
  "prix_chf_ht",
  "prix_pour",
  "conditionnement",
  "type_prix",
  "date_prix",
  "valable_jusquau",
];
const OPTIONAL_HEADERS = ["image_url", "produit_url", "notes_prix"];
function supplierURL(value, image = false) {
  if (!value) return "";
  try {
    const u = new URL(value);
    if (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.port &&
      (u.hostname === "elektro-material.ch" ||
        u.hostname.endsWith(".elektro-material.ch") ||
        (image && u.hostname === "emagpim-1d1da.kxcdn.com"))
    )
      return u.href;
  } catch {}
  D.fail("Lien article ou image : URL HTTPS Electro-Matériel requise.");
}
// Canonical CSV: supplier exports must be mapped to these explicit fields before import.
function parseCSV(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 4 * 1024 * 1024)
    D.fail("CSV limité à 4 Mo.");
  text = text.replace(/^\uFEFF/, "");
  const sep = text.split(/\r?\n/)[0].includes(";") ? ";" : ",";
  const rows = [];
  let row = [],
    field = "",
    quoted = false,
    ended = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        ended = true;
      } else field += c;
    } else if (c === '"') {
      if (field || ended) D.fail("Guillemets CSV invalides.");
      quoted = true;
    } else if (c === sep || c === "\n" || c === "\r") {
      row.push(field);
      field = "";
      ended = false;
      if (c !== sep) {
        if (row.some((x) => x.trim())) rows.push(row);
        row = [];
        if (c === "\r" && text[i + 1] === "\n") i++;
      }
    } else {
      if (ended) D.fail("CSV invalide après un guillemet.");
      field += c;
    }
  }
  if (quoted) D.fail("Guillemet CSV non fermé.");
  row.push(field);
  if (row.some((x) => x.trim())) rows.push(row);
  const header = rows.shift()?.map((x) => x.trim().toLowerCase());
  if (
    !header ||
    new Set(header).size !== header.length ||
    header.some((x) => ![...HEADERS, ...OPTIONAL_HEADERS].includes(x)) ||
    HEADERS.some((x) => !header.includes(x))
  )
    D.fail("Colonnes incorrectes : utilisez le modèle CSV.");
  if (!rows.length || rows.length > 10000)
    D.fail("Import requis : 1 à 10 000 articles par fichier.");
  return rows.map((cells, i) => {
    if (cells.length !== header.length)
      D.fail(`Ligne ${i + 2} : nombre de colonnes incorrect.`);
    return Object.fromEntries(header.map((key, n) => [key, cells[n].trim()]));
  });
}
function validateRows(csv, now = new Date()) {
  const seen = new Set(),
    today = now.toISOString().slice(0, 10);
  const date = (v) =>
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    Number.isFinite(Date.parse(v)) &&
    new Date(v).toISOString().slice(0, 10) === v;
  return parseCSV(csv).map((x, i) => {
    const bad = (s) => D.fail(`Ligne ${i + 2} : ${s}`);
    if (!x.reference || x.reference.length > 100 || seen.has(x.reference))
      bad("référence absente, trop longue ou en double.");
    seen.add(x.reference);
    if (!x.designation || x.designation.length > 500)
      bad("désignation requise (500 caractères maximum).");
    if (x.ean) {
      if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(x.ean))
        bad("EAN/GTIN invalide.");
      const digits = x.ean.split("").map(Number),
        check = digits.pop();
      const sum = digits
        .reverse()
        .reduce((s, n, k) => s + n * (k % 2 ? 1 : 3), 0);
      if ((10 - (sum % 10)) % 10 !== check) bad("clé EAN/GTIN incorrecte.");
      x.ean = x.ean.padStart(14, "0");
    }
    x.numero_e = x.numero_e.replace(/[ .-]/g, "");
    if (x.numero_e && !/^\d{9}$/.test(x.numero_e))
      bad("numéro E : 9 chiffres attendus.");
    if (!["pcs", "m", "kg", "l"].includes(x.unite))
      bad("unité attendue : pcs, m, kg ou l.");
    if (!["net", "public"].includes(x.type_prix))
      bad("type_prix attendu : net ou public.");
    for (const key of ["prix_chf_ht", "prix_pour", "conditionnement"]) {
      if (key === "conditionnement" && x[key] === "") {
        x[key] = null;
        continue;
      }
      if (!/^\d+(?:[.,]\d+)?$/.test(x[key]))
        bad(`${key} : nombre positif requis.`);
      x[key] = Number(x[key].replace(",", "."));
      if (!(x[key] > 0 && x[key] <= 1e8)) bad(`${key} hors limites.`);
    }
    if (
      x.unite === "pcs" &&
      (!Number.isInteger(x.prix_pour) ||
        (x.conditionnement !== null && !Number.isInteger(x.conditionnement)))
    )
      bad("quantités de pièces entières requises.");
    if (!date(x.date_prix) || x.date_prix > today)
      bad("date_prix invalide ou future.");
    if (
      x.valable_jusquau &&
      (!date(x.valable_jusquau) || x.valable_jusquau < x.date_prix)
    )
      bad("date de fin de validité invalide.");
    for (const key of ["image_url", "produit_url"]) {
      if ((x[key] || "").length > 2048) bad("lien trop long.");
      x[key] = supplierURL(x[key], key === "image_url");
    }
    x.notes_prix = x.notes_prix || "";
    if (x.notes_prix.length > 1000) bad("notes de prix trop longues.");
    return x;
  });
}
function compare(rows, quantity, now = new Date()) {
  const groups = new Map(),
    today = now.toISOString().slice(0, 10);
  for (const row of rows) {
    const x = row.article;
    // Prefer GTIN; never infer equivalence from descriptions or supplier references.
    const identity = x.ean
      ? `GTIN ${x.ean}`
      : x.numero_e
        ? `E ${x.numero_e}`
        : `${row.vendor} / ${x.reference}`;
    const key = [identity, x.unite, x.type_prix].join("|");
    const stale = now - Date.parse(x.date_prix + "T00:00:00Z") > 30 * 86400000;
    const expired = !!x.valable_jusquau && x.valable_jusquau < today;
    const ordered = x.conditionnement
      ? Math.ceil(quantity / x.conditionnement - 1e-10) * x.conditionnement
      : null;
    const total =
      ordered === null
        ? null
        : Math.round(((ordered * x.prix_chf_ht) / x.prix_pour) * 100) / 100;
    const offer = {
      ...x,
      vendor: row.vendor,
      source: row.source,
      importedAt: row.imported_at,
      unitPrice: x.prix_chf_ht / x.prix_pour,
      ordered,
      total,
      stale,
      expired,
    };
    if (!groups.has(key))
      groups.set(key, {
        identity,
        unit: x.unite,
        priceType: x.type_prix,
        offers: [],
      });
    groups.get(key).offers.push(offer);
  }
  return [...groups.values()].map((group) => {
    group.offers.sort((a, b) => (a.total ?? Infinity) - (b.total ?? Infinity));
    const usable = group.offers.filter(
      (x) => !x.stale && !x.expired && x.total !== null && !x.notes_prix,
    );
    const comparable = new Set(usable.map((x) => x.vendor)).size >= 2;
    return {
      ...group,
      comparable,
      bestTotal: comparable ? usable[0].total : null,
    };
  });
}
module.exports = {
  VENDORS,
  HEADERS,
  OPTIONAL_HEADERS,
  parseCSV,
  validateRows,
  compare,
};
