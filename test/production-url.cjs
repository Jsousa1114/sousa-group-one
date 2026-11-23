"use strict";
// Target of the scripts that hit a deployed instance (production-smoke, live-browser).
// Never hard-coded: the app is self-hosted and its public address can change.
const path = require("node:path");

function fail(message) {
  const script = path.relative(process.cwd(), process.argv[1] || "") || "<script>";
  console.error(message);
  console.error("Exemple : PRODUCTION_URL=https://app.example.com node " + script);
  process.exit(1);
}

function requireProductionUrl() {
  const raw = String(process.env.PRODUCTION_URL || "").trim();
  if (!raw) {
    fail("PRODUCTION_URL est absente : indiquez l'adresse de l'instance Sousa Group One à tester.");
  }
  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    fail("PRODUCTION_URL n'est pas une adresse http(s) valide : " + JSON.stringify(raw));
  }
  return raw.replace(/\/+$/, "");
}

module.exports = { requireProductionUrl };
