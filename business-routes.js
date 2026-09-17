"use strict";

const express = require("express");
const { randomUUID } = require("node:crypto");
const { auth } = require("./auth-middleware");
const { wrap } = require("./auth-routes");
const { mutate } = require("./db");
const D = require("./domain");

const ENTITY_ROLES = {
  employees: D.HR,
  clients: [...D.OPS, "accounting"],
  expenses: [...D.OPS, "accounting"],
  inventory: D.OPS,
  suppliers: D.OPS,
  vehicles: D.OPS,
  tools: D.OPS,
  maintenance: D.OPS,
};

const fromCents = (n) => Math.round(Number(n) || 0) / 100;
const same = D.same;

function optionalText(v, name, max = 500) {
  return D.text(v == null ? "" : String(v), name, max, true);
}

function email(v, name = "E-mail", optional = false) {
  const out = D.text(v == null ? "" : String(v), name, 255, optional);
  if (!out && optional) return "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out)) D.fail(`${name} invalide.`);
  return out.toLowerCase();
}

function recordCompany(d, collection, record) {
  if (record?.company) return record.company;
  if (record?.project) {
    return d.projects.find((p) => same(p.id, record.project))?.company || null;
  }
  if (collection === "employees") return record?.company || null;
  return null;
}

function ensureCompanyAccess(d, user, companyId) {
  const company = D.ref(d, "companies", companyId);
  if (!D.inCompany(user, company.id)) D.fail("Entreprise non autorisée.", 403);
  return company;
}

function ensureEntityAccess(d, user, collection, record) {
  const roles = ENTITY_ROLES[collection];
  if (!roles || !D.privileged(user, roles)) D.fail("Accès refusé.", 403);
  const company = recordCompany(d, collection, record);
  if (company && !D.inCompany(user, company)) D.fail("Accès refusé.", 403);
}

function ensureFinanceAccess(d, user, record) {
  if (!D.privileged(user, D.FIN)) D.fail("Accès refusé.", 403);
  const company = recordCompany(d, "invoices", record);
  if (company && !D.inCompany(user, company)) D.fail("Accès refusé.", 403);
}

function identifier(d, collection, prefix, now = new Date().toISOString()) {
  const year = new Date(now).getUTCFullYear();
  const stem = `${prefix}-${year}-`;
  let n = 1;
  for (const row of d[collection] || []) {
    if (!String(row.id || "").startsWith(stem)) continue;
    n = Math.max(n, Number(String(row.id).slice(stem.length)) + 1 || 1);
  }
  return stem + String(n).padStart(4, "0");
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function financePayload(d, user, p, existing = null) {
  const company = existing
    ? D.ref(d, "companies", existing.company)
    : ensureCompanyAccess(d, user, p.company);
  if (!D.inCompany(user, company.id)) D.fail("Entreprise non autorisée.", 403);
  if (company.id === "group") D.fail("Choisissez une entreprise opérationnelle.");

  const client = D.ref(d, "clients", p.clientId || existing?.clientId);
  if (client.archived) D.fail("Ce client est archivé.");
  if (client.company && client.company !== company.id) D.fail("Client incompatible.");

  const projectId = p.project !== undefined ? p.project : existing?.project || "";
  const project = projectId ? D.ref(d, "projects", projectId) : null;
  if (project?.archived) D.fail("Ce chantier est archivé.");
  if (project && (project.company !== company.id || !same(project.clientId, client.id)))
    D.fail("Chantier incompatible.");

  if (!Array.isArray(p.lines) || !p.lines.length || p.lines.length > 100)
    D.fail("Au moins une ligne est requise.");

  const discountPercent = D.num(p.discountPercent ?? existing?.discountPercent ?? 0, "Remise", 0, 100);
  const defaultVat = D.num(
    company.defaultVatRate ?? 8.1,
    "TVA par défaut",
    0,
    100,
  );

  let netCents = 0;
  let vatCents = 0;
  const lines = p.lines.map((line) => {
    const quantity = D.num(line.quantity, "Quantité", 0.001, 100000);
    const unitCents = D.cents(line.unitPrice);
    const vatRate = D.num(line.vatRate ?? defaultVat, "TVA", 0, 100);
    const grossNetCents = Math.round(quantity * unitCents);
    const discountedNetCents = Math.round(grossNetCents * (100 - discountPercent) / 100);
    const lineVatCents = Math.round(discountedNetCents * vatRate / 100);
    netCents += discountedNetCents;
    vatCents += lineVatCents;
    return {
      description: D.text(line.description, "Description", 500),
      quantity,
      unitPrice: fromCents(unitCents),
      vatRate,
      netAmount: fromCents(discountedNetCents),
      vatAmount: fromCents(lineVatCents),
      total: fromCents(discountedNetCents + lineVatCents),
    };
  });

  const totalCents = netCents + vatCents;
  if (totalCents <= 0 || totalCents > 1e12) D.fail("Total invalide.");
  const depositPercent = D.num(p.depositPercent ?? existing?.depositPercent ?? 0, "Acompte", 0, 100);

  return {
    company: company.id,
    clientId: client.id,
    project: project?.id || "",
    title: D.text(p.title ?? existing?.title, "Objet"),
    lines,
    discountPercent,
    depositPercent,
    depositAmount: fromCents(Math.round(totalCents * depositPercent / 100)),
    netAmount: fromCents(netCents),
    vatAmount: fromCents(vatCents),
    amount: fromCents(totalCents),
    paymentTerms: optionalText(
      p.paymentTerms ?? existing?.paymentTerms ?? `${company.paymentDays || 30} jours`,
      "Conditions de paiement",
      500,
    ),
    notes: optionalText(p.notes ?? existing?.notes ?? "", "Notes", 3000),
    clientReference: optionalText(
      p.clientReference ?? existing?.clientReference ?? "",
      "Référence client",
      160,
    ),
    currency: "CHF",
  };
}

function updateEntity(d, user, collection, record, p) {
  ensureEntityAccess(d, user, collection, record);
  if (record.archived) D.fail("Restaurez cet élément avant de le modifier.");

  if (collection === "employees") {
    record.name = D.text(p.name, "Nom");
    record.job = D.text(p.job, "Fonction");
    record.email = email(p.email);
    record.phone = optionalText(p.phone, "Téléphone", 40);
    record.salary = fromCents(D.cents(p.salary));
    record.activity = D.num(p.activity, "Taux", 1, 100);
    record.vacation = D.num(p.vacation, "Solde vacances", 0, 366);
    record.entry = D.iso(p.entry);
    record.status = optionalText(p.status || "Actif", "Statut", 80) || "Actif";
  } else if (collection === "clients") {
    record.name = D.text(p.name, "Nom");
    record.email = email(p.email);
    record.phone = optionalText(p.phone, "Téléphone", 40);
    record.city = D.text(p.city, "Ville");
    record.type = optionalText(p.type, "Type", 80);
    record.status = optionalText(p.status || "Actif", "Statut", 80) || "Actif";
  } else if (collection === "inventory") {
    const sku = D.text(p.sku, "Référence", 60);
    if (
      d.inventory.some(
        (x) => !same(x.id, record.id) && x.company === record.company && x.sku === sku,
      )
    )
      D.fail("Référence déjà existante.");
    record.sku = sku;
    record.name = D.text(p.name, "Nom");
    record.category = optionalText(p.category, "Catégorie", 100);
    record.stock = D.num(p.stock, "Stock", 0, 1e9);
    record.min = D.num(p.min, "Minimum", 0, 1e9);
    record.unit = D.text(p.unit, "Unité", 20);
    record.buy = D.num(p.buy, "Prix achat", 0, 1e8);
    record.sell = D.num(p.sell, "Prix vente", 0, 1e8);
  } else if (collection === "suppliers") {
    record.name = D.text(p.name, "Nom");
    record.contact = optionalText(p.contact, "Contact", 100);
    record.email = email(p.email);
    record.phone = optionalText(p.phone, "Téléphone", 40);
  } else if (collection === "vehicles") {
    record.plate = D.text(p.plate, "Plaque", 30);
    record.brand = D.text(p.brand, "Marque");
    record.model = D.text(p.model, "Modèle");
    record.km = D.num(p.km, "Kilométrage", 0, 1e9);
    record.service = p.service ? D.iso(p.service) : "";
    record.status = optionalText(p.status || "Disponible", "Statut", 80) || "Disponible";
  } else if (collection === "tools") {
    record.name = D.text(p.name, "Nom");
    record.serial = D.text(p.serial, "Numéro de série", 100);
    record.status = optionalText(p.status || "Disponible", "Statut", 80) || "Disponible";
  } else if (collection === "maintenance") {
    const client = D.ref(d, "clients", p.clientId);
    if (client.company && client.company !== record.company) D.fail("Client incompatible.");
    record.clientId = client.id;
    record.title = D.text(p.title, "Titre");
    record.frequency = D.text(p.frequency, "Fréquence", 100);
    record.next = D.iso(p.next);
    record.amount = fromCents(D.cents(p.amount));
    record.status = optionalText(p.status || "Actif", "Statut", 80) || "Actif";
  } else if (collection === "expenses") {
    const oldProject = record.project
      ? d.projects.find((x) => same(x.id, record.project))
      : null;
    const newProject = p.project ? D.ref(d, "projects", p.project) : null;
    if (newProject && newProject.company !== record.company) D.fail("Chantier incompatible.");
    const newAmount = fromCents(D.cents(p.amount));
    if (oldProject)
      oldProject.cost = fromCents(
        Math.max(0, Math.round((oldProject.cost || 0) * 100) - Math.round((record.amount || 0) * 100)),
      );
    if (newProject)
      newProject.cost = fromCents(
        Math.round((newProject.cost || 0) * 100) + Math.round(newAmount * 100),
      );
    record.project = newProject?.id || "";
    record.supplier = D.text(p.supplier, "Fournisseur");
    record.amount = newAmount;
    record.date = D.iso(p.date);
    record.status = optionalText(p.status || "Enregistrée", "Statut", 80) || "Enregistrée";
  } else {
    D.fail("Module non modifiable.");
  }

  record.updatedAt = new Date().toISOString();
  return record;
}

async function deleteEntity(c, d, user, collection, record) {
  ensureEntityAccess(d, user, collection, record);
  if (!record.archived) D.fail("Archivez l’élément avant de le supprimer.");

  if (collection === "employees") {
    const linked = [
      d.projects.some((p) => (p.team || []).some((id) => same(id, record.id))),
      d.time.some((x) => same(x.employeeId, record.id)),
      d.planning.some((x) => same(x.employeeId, record.id)),
      d.absences.some((x) => same(x.employeeId, record.id)),
      d.documents.some((x) => same(x.employeeId, record.id)),
      (await c.query("SELECT 1 FROM users WHERE employee_id=$1 LIMIT 1", [String(record.id)])).rows.length > 0,
    ].some(Boolean);
    if (linked) D.fail("Suppression impossible : ce salarié possède un historique ou un compte.");
  }

  if (collection === "clients") {
    const linked = [
      d.projects.some((x) => same(x.clientId, record.id)),
      d.quotes.some((x) => same(x.clientId, record.id)),
      d.invoices.some((x) => same(x.clientId, record.id)),
      d.maintenance.some((x) => same(x.clientId, record.id)),
      d.documents.some((x) => same(x.clientId, record.id)),
      (await c.query("SELECT 1 FROM users WHERE client_id=$1 LIMIT 1", [String(record.id)])).rows.length > 0,
    ].some(Boolean);
    if (linked) D.fail("Suppression impossible : ce client possède un historique ou un compte.");
  }

  if (collection === "expenses" && record.project) {
    const project = d.projects.find((x) => same(x.id, record.project));
    if (project)
      project.cost = fromCents(
        Math.max(0, Math.round((project.cost || 0) * 100) - Math.round((record.amount || 0) * 100)),
      );
  }

  d[collection] = d[collection].filter((x) => !same(x.id, record.id));
  return { id: record.id, company: record.company || user.company };
}

function routes(db) {
  const router = express.Router();
  router.use(auth(db));

  router.post(
    "/company",
    wrap(async (req, res) => {
      res.json(
        await mutate(db, req.user, req.body, async (c, d) => {
          if (!D.privileged(req.user, D.STAFF)) D.fail("Accès refusé.", 403);
          const p = req.body.payload || {};
          const target = D.ref(d, "companies", p.id);
          if (!D.inCompany(req.user, target.id)) D.fail("Accès refusé.", 403);
          if (target.id === "group" && req.user.company !== "group") D.fail("Accès groupe requis.", 403);

          target.name = D.text(p.name, "Nom");
          target.type = D.text(p.type, "Secteur");
          target.address = optionalText(p.address, "Adresse", 300);
          target.zip = optionalText(p.zip, "NPA", 20);
          target.city = optionalText(p.city, "Ville", 100);
          target.country = optionalText(p.country || "Suisse", "Pays", 100) || "Suisse";
          target.email = p.email ? email(p.email) : "";
          target.phone = optionalText(p.phone, "Téléphone", 40);
          target.website = optionalText(p.website, "Site web", 250);
          target.uid = optionalText(p.uid, "IDE / TVA", 80);
          target.iban = optionalText(p.iban, "IBAN", 64).replace(/\s+/g, " ").toUpperCase();
          target.bankName = optionalText(p.bankName, "Banque", 160);
          target.defaultVatRate = D.num(p.defaultVatRate ?? 8.1, "TVA par défaut", 0, 100);
          target.paymentDays = D.num(p.paymentDays ?? 30, "Délai de paiement", 0, 365);
          target.footer = optionalText(p.footer, "Pied de page", 1000);
          target.legal = optionalText(p.legal, "Mentions légales", 1500);
          target.updatedAt = new Date().toISOString();
          return { id: target.id, company: target.id };
        }),
      );
    }),
  );

  router.post(
    "/entity",
    wrap(async (req, res) => {
      res.json(
        await mutate(db, req.user, req.body, async (c, d) => {
          const p = req.body.payload || {};
          const collection = req.body.collection;
          if (!ENTITY_ROLES[collection]) D.fail("Module non pris en charge.");
          const record = D.ref(d, collection, p.id);
          ensureEntityAccess(d, req.user, collection, record);

          if (req.body.action === "entity.update") {
            const out = updateEntity(d, req.user, collection, record, p);
            return { id: out.id, company: out.company || recordCompany(d, collection, out) || req.user.company };
          }
          if (req.body.action === "entity.archive") {
            if (!record.archived) {
              record.previousStatus = record.status || "";
              record.archived = true;
              record.archivedAt = new Date().toISOString();
              record.status = "Archivé";
            }
            return { id: record.id, company: record.company || req.user.company };
          }
          if (req.body.action === "entity.restore") {
            record.archived = false;
            record.archivedAt = "";
            record.status = record.previousStatus || record.status || "Actif";
            if (record.status === "Archivé") record.status = "Actif";
            delete record.previousStatus;
            return { id: record.id, company: record.company || req.user.company };
          }
          if (req.body.action === "entity.delete") {
            return await deleteEntity(c, d, req.user, collection, record);
          }
          D.fail("Action inconnue.");
        }),
      );
    }),
  );

  router.post(
    "/finance",
    wrap(async (req, res) => {
      res.json(
        await mutate(db, req.user, req.body, async (c, d) => {
          const p = req.body.payload || {};
          if (!D.privileged(req.user, D.FIN)) D.fail("Accès refusé.", 403);
          const op = req.body.action;

          if (op === "finance.create") {
            const collection = p.kind === "quote" ? "quotes" : p.kind === "invoice" ? "invoices" : null;
            if (!collection) D.fail("Type de document invalide.");
            const calculated = financePayload(d, req.user, p);
            const date = D.iso(p.date);
            const limit = D.iso(collection === "quotes" ? p.valid : p.due);
            if (limit < date) D.fail("Échéance antérieure à la date du document.");
            const row = {
              id: identifier(d, collection, collection === "quotes" ? "D" : "F"),
              createdAt: new Date().toISOString(),
              ...calculated,
              date,
              [collection === "quotes" ? "valid" : "due"]: limit,
              paid: 0,
              status: "Brouillon",
              version: 1,
            };
            d[collection].push(row);
            return { id: row.id, company: row.company };
          }

          if (op === "finance.update") {
            const collection = p.kind === "quote" ? "quotes" : p.kind === "invoice" ? "invoices" : null;
            if (!collection) D.fail("Type de document invalide.");
            const row = D.ref(d, collection, p.id);
            ensureFinanceAccess(d, req.user, row);
            if (row.status !== "Brouillon") D.fail("Seul un brouillon peut être modifié.");
            const calculated = financePayload(d, req.user, p, row);
            const date = D.iso(p.date);
            const limit = D.iso(collection === "quotes" ? p.valid : p.due);
            if (limit < date) D.fail("Échéance antérieure à la date du document.");
            Object.assign(row, calculated, {
              date,
              [collection === "quotes" ? "valid" : "due"]: limit,
              updatedAt: new Date().toISOString(),
              version: Number(row.version || 1) + 1,
            });
            return { id: row.id, company: row.company };
          }

          if (op === "finance.duplicate") {
            const collection = p.kind === "quote" ? "quotes" : p.kind === "invoice" ? "invoices" : null;
            if (!collection) D.fail("Type de document invalide.");
            const source = D.ref(d, collection, p.id);
            ensureFinanceAccess(d, req.user, source);
            const today = D.iso(p.date || new Date().toISOString().slice(0, 10));
            const company = D.ref(d, "companies", source.company);
            const limit = collection === "quotes"
              ? D.iso(p.valid || addDays(today, 30))
              : D.iso(p.due || addDays(today, company.paymentDays || 30));
            const row = {
              ...structuredClone(source),
              id: identifier(d, collection, collection === "quotes" ? "D" : "F"),
              createdAt: new Date().toISOString(),
              updatedAt: "",
              date: today,
              [collection === "quotes" ? "valid" : "due"]: limit,
              status: "Brouillon",
              paid: 0,
              acceptedAt: "",
              acceptedBy: "",
              cancelledAt: "",
              invoiceId: "",
              invoicedAt: "",
              sourceQuote: "",
              sourceDocument: source.id,
              version: 1,
            };
            d[collection].push(row);
            return { id: row.id, company: row.company };
          }

          if (op === "finance.convert") {
            const quote = D.ref(d, "quotes", p.id);
            ensureFinanceAccess(d, req.user, quote);
            if (quote.status !== "Accepté") D.fail("Le devis doit être accepté avant facturation.");
            if (d.invoices.some((x) => same(x.sourceQuote, quote.id) && x.status !== "Annulée"))
              D.fail("Une facture existe déjà pour ce devis.");
            const company = D.ref(d, "companies", quote.company);
            const date = D.iso(p.date || new Date().toISOString().slice(0, 10));
            const due = D.iso(p.due || addDays(date, company.paymentDays || 30));
            const invoice = {
              ...structuredClone(quote),
              id: identifier(d, "invoices", "F"),
              createdAt: new Date().toISOString(),
              updatedAt: "",
              sourceQuote: quote.id,
              date,
              due,
              valid: undefined,
              status: "Brouillon",
              paid: 0,
              acceptedAt: "",
              acceptedBy: "",
              version: 1,
            };
            delete invoice.valid;
            d.invoices.push(invoice);
            quote.invoicedAt = new Date().toISOString();
            quote.invoiceId = invoice.id;
            return { id: invoice.id, company: invoice.company };
          }

          if (op === "finance.cancel") {
            const collection = p.kind === "quote" ? "quotes" : p.kind === "invoice" ? "invoices" : null;
            if (!collection) D.fail("Type de document invalide.");
            const row = D.ref(d, collection, p.id);
            ensureFinanceAccess(d, req.user, row);
            if (row.status === "Brouillon") D.fail("Supprimez plutôt le brouillon.");
            if (collection === "invoices" && Number(row.paid || 0) > 0)
              D.fail("Une facture avec paiement doit être corrigée par un avoir, pas annulée.");
            if (["Annulé", "Annulée"].includes(row.status)) D.fail("Document déjà annulé.");
            row.previousStatus = row.status;
            row.status = collection === "quotes" ? "Annulé" : "Annulée";
            row.cancelledAt = new Date().toISOString();
            row.cancelReason = optionalText(p.reason, "Motif", 1000);
            return { id: row.id, company: row.company };
          }

          if (op === "finance.delete") {
            const collection = p.kind === "quote" ? "quotes" : p.kind === "invoice" ? "invoices" : null;
            if (!collection) D.fail("Type de document invalide.");
            const row = D.ref(d, collection, p.id);
            ensureFinanceAccess(d, req.user, row);
            if (row.status !== "Brouillon") D.fail("Seul un brouillon peut être supprimé.");
            if (collection === "invoices" && d.payments.some((x) => same(x.invoice, row.id)))
              D.fail("Cette facture possède des paiements.");
            d[collection] = d[collection].filter((x) => !same(x.id, row.id));
            return { id: row.id, company: row.company };
          }

          D.fail("Action financière inconnue.");
        }),
      );
    }),
  );

  router.get(
    "/history/:id",
    wrap(async (req, res) => {
      if (["employee", "client"].includes(req.user.role)) D.fail("Accès refusé.", 403);
      const rows = (
        await db.query(
          `SELECT user_email,action,metadata,created_at
             FROM audit_logs
            WHERE metadata->>'id'=$1
            ORDER BY id DESC
            LIMIT 100`,
          [String(req.params.id)],
        )
      ).rows;
      res.json({
        rows: rows.filter(
          (row) =>
            req.user.company === "group" ||
            !row.metadata?.company ||
            row.metadata.company === req.user.company,
        ),
      });
    }),
  );

  return router;
}

module.exports = { routes, financePayload, identifier };
