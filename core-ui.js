"use strict";
(() => {
  const columns = {
  companies: [
    ["name", "Entreprise"],
    ["type", "Secteur"],
  ],
  employees: [
    ["name", "Nom"],
    ["job", "Fonction"],
    ["email", "E-mail"],
    ["company", "Entreprise"],
    ["vacation", "Vacances"],
  ],
  clients: [
    ["name", "Nom"],
    ["email", "E-mail"],
    ["phone", "Téléphone"],
    ["city", "Ville"],
  ],
  payments: [
    ["invoice", "Facture"],
    ["amount", "Montant"],
    ["date", "Date"],
    ["method", "Mode"],
  ],
  expenses: [
    ["supplier", "Fournisseur"],
    ["project", "Chantier"],
    ["amount", "Montant"],
    ["date", "Date"],
  ],
  inventory: [
    ["sku", "Référence"],
    ["name", "Article"],
    ["stock", "Stock"],
    ["min", "Minimum"],
    ["unit", "Unité"],
    ["buy", "Achat"],
    ["sell", "Vente"],
  ],
  suppliers: [
    ["name", "Nom"],
    ["contact", "Contact"],
    ["email", "E-mail"],
    ["phone", "Téléphone"],
  ],
  vehicles: [
    ["plate", "Plaque"],
    ["employeeId", "Attribué à"],
    ["brand", "Marque"],
    ["model", "Modèle"],
    ["km", "Kilométrage"],
    ["service", "Entretien"],
  ],
  tools: [
    ["name", "Nom"],
    ["serial", "N° série"],
    ["employeeId", "Attribué à"],
    ["status", "État"],
  ],
  maintenance: [
    ["title", "Contrat"],
    ["clientId", "Client"],
    ["frequency", "Fréquence"],
    ["next", "Prochaine visite"],
    ["amount", "Valeur annuelle"],
  ],
};

  function reportsView(ctx) {
    const { visible, sum, heading, btn, cards, money, table, esc } = ctx;
    const months = new Map();
    for (const p of visible("payments")) {
      const m = String(p.date || "").slice(0, 7);
      if (!m) continue;
      months.set(m, (months.get(m) || 0) + (Number(p.amount) || 0));
    }
    return (
      heading(
        "Rapports sur les données visibles",
        btn("Exporter CSV", "export", "projects"),
      ) +
      cards([
        ["Heures enregistrées", sum("time", "hours").toFixed(2) + " h"],
        ["Coûts chantiers", money(sum("projects", "cost"))],
        [
          "Budget moins coûts",
          money(sum("projects", "budget") - sum("projects", "cost")),
        ],
      ]) +
      table(
        ["Mois", "Encaissements"],
        [...months].sort().map(([m, n]) => [esc(m), money(n)]),
      )
    );
  }

  window.SGOCoreUI = { columns, reportsView };
})();
