/* Shared by the browser preview and the authoritative server calculation. */
(function (root) {
  "use strict";
  function decimal(v, label, min, max, digits) {
    if (v === "" || v == null || !/^\d+(\.\d+)?$/.test(String(v)))
      throw new Error(label + " invalide.");
    const n = Number(v),
      scale = 10 ** digits;
    if (
      !Number.isFinite(n) ||
      n < min ||
      n > max ||
      Math.abs(n * scale - Math.round(n * scale)) > 0.00001
    )
      throw new Error(label + " invalide.");
    return Math.round(n * scale);
  }
  function calculate(input) {
    if (!Array.isArray(input) || !input.length || input.length > 100)
      throw new Error("Ajoutez entre 1 et 100 lignes.");
    let subtotal = 0,
      discount = 0,
      net = 0,
      tax = 0;
    const groups = {};
    const lines = input.map((l) => {
      if (
        typeof l.description !== "string" ||
        !l.description.trim() ||
        l.description.trim().length > 500
      )
        throw new Error("Description invalide.");
      const q = decimal(l.quantity, "Quantité", 0.001, 100000, 3);
      const price = decimal(l.unitPrice, "Prix unitaire", 0, 1000000, 2);
      const rate = decimal(l.vatRate ?? 0, "TVA", 0, 100, 2);
      const rebate = decimal(l.discount ?? 0, "Remise", 0, 100, 2);
      const gross = Math.round((q * price) / 1000);
      const reduction = Math.round((gross * rebate) / 10000);
      const base = gross - reduction,
        vat = Math.round((base * rate) / 10000);
      subtotal += gross;
      discount += reduction;
      net += base;
      tax += vat;
      const group = (groups[rate] ||= { rate: rate / 100, base: 0, tax: 0 });
      group.base += base;
      group.tax += vat;
      const unit = String(l.unit || "pcs").trim();
      if (unit.length > 30) throw new Error("Unité invalide.");
      return {
        description: l.description.trim(),
        quantity: q / 1000,
        unitPrice: price / 100,
        unit,
        vatRate: rate / 100,
        discount: rebate / 100,
        net: base / 100,
        tax: vat / 100,
        total: (base + vat) / 100,
      };
    });
    if (net + tax <= 0 || net + tax > 1e10) throw new Error("Total invalide.");
    return {
      lines,
      subtotal: subtotal / 100,
      discountAmount: discount / 100,
      net: net / 100,
      tax: tax / 100,
      amount: (net + tax) / 100,
      taxGroups: Object.values(groups).map((g) => ({
        rate: g.rate,
        base: g.base / 100,
        tax: g.tax / 100,
      })),
    };
  }
  const api = { calculate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SousaFinance = api;
})(typeof window === "undefined" ? {} : window);
