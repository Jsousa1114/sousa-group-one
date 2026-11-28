"use strict";
// « Rentabilité »: the profitability of projects (see profit.js), their cost settings, and the
// sums per company. Shown to the people who may see margins.
const express = require("express");
const D = require("./domain");
const { auth } = require("./auth-middleware");
const { loadState } = require("./db");
const P = require("./profit");

const schemas = new WeakMap();
function ensureSchema(db) {
  if (!schemas.has(db))
    schemas.set(
      db,
      db
        .query(`CREATE TABLE IF NOT EXISTS profit_settings (company TEXT PRIMARY KEY, settings JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
        .catch((e) => {
          schemas.delete(db);
          throw e;
        }),
    );
  return schemas.get(db);
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
// Tables of other modules: missing on a new installation until they are first used.
async function rows(db, sql, params) {
  try {
    return (await db.query(sql, params)).rows;
  } catch {
    return [];
  }
}

async function settingsByCompany(db) {
  await ensureSchema(db);
  return new Map((await db.query("SELECT company,settings FROM profit_settings")).rows.map((x) => [x.company, x.settings]));
}
// The profitability of each project given, with the data the state does not hold.
async function profitsFor(db, data, projects) {
  const ids = projects.map((p) => String(p.id));
  if (!ids.length) return new Map();
  const [movements, changes, settings] = await Promise.all([
    rows(db, "SELECT inventory_id,quantity,project_id FROM inventory_movements WHERE project_id = ANY($1::text[])", [ids]),
    rows(db, "SELECT project_id,amount,status FROM project_change_orders WHERE project_id = ANY($1::text[])", [ids]),
    settingsByCompany(db),
  ]);
  const out = new Map();
  for (const p of projects)
    out.set(
      String(p.id),
      P.projectProfit(data, p, {
        movements: movements.filter((m) => String(m.project_id) === String(p.id)),
        changeOrders: changes.filter((c) => String(c.project_id) === String(p.id)),
        settings: settings.get(p.company) || {},
      }),
    );
  return out;
}
async function marginVisible(db, user) {
  if (D.privileged(user, ["admin", "direction", "accounting"])) return true;
  try {
    const pro = require("./pro-routes");
    await pro.ensureSchema(db);
    return await pro.hasPermission(db, user, "margin.view");
  } catch {
    return false;
  }
}
async function salaryVisible(db, user) {
  if (D.privileged(user, ["admin", "direction", "hr"])) return true;
  try {
    const pro = require("./pro-routes");
    await pro.ensureSchema(db);
    return await pro.hasPermission(db, user, "salary.view");
  } catch {
    return false;
  }
}
// One line per project for the lists and dashboards.
const flat = (p, r) => ({
  id: p.id,
  title: p.title,
  company: p.company,
  status: p.status,
  salesHT: r.sales.salesHT,
  priceHT: r.sales.priceHT,
  remainingToInvoiceHT: r.sales.remainingToInvoiceHT,
  costs: r.costs.total,
  labour: r.costs.labour,
  labourHours: r.costs.labourHours,
  material: r.costs.material,
  purchases: r.costs.purchases,
  margin: r.margin,
  marginPct: r.marginPct,
  forecastMarginPct: r.forecast?.marginPct ?? null,
  warnings: r.warnings.length,
});

function routes(db) {
  const r = express.Router();
  r.use(auth(db));
  r.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    ensureSchema(db).then(() => next(), next);
  });
  async function context(req) {
    const { data } = await loadState(db);
    const user = D.effectiveUser(data, req.user);
    return { data, user, view: D.viewState(data, user) };
  }

  r.get(
    "/project/:id",
    wrap(async (req, res) => {
      const { data, user, view } = await context(req);
      if (!(await marginVisible(db, user))) D.fail("Accès aux marges requis.", 403);
      const p = view.projects.find((x) => D.same(x.id, req.params.id) && !x.deletedAt);
      if (!p) D.fail("Chantier introuvable.", 404);
      const profit = (await profitsFor(db, data, [data.projects.find((x) => D.same(x.id, p.id))])).get(String(p.id));
      res.json({ profit, canSettings: D.privileged(user, D.STAFF) });
    }),
  );

  r.get(
    "/summary",
    wrap(async (req, res) => {
      const { data, user, view } = await context(req);
      if (!(await marginVisible(db, user))) D.fail("Accès aux marges requis.", 403);
      const company = String(req.query.company || "");
      const projects = view.projects.filter((p) => !p.deletedAt && (!company || p.company === company)).map((p) => data.projects.find((x) => D.same(x.id, p.id)) || p);
      const profits = await profitsFor(db, data, projects);
      const list = projects.map((p) => flat(p, profits.get(String(p.id))));
      const companies = [...new Set(projects.map((p) => p.company))].map((id) => ({
        company: id,
        name: data.companies.find((c) => c.id === id)?.name || id,
        ...P.total(projects.filter((p) => p.company === id).map((p) => profits.get(String(p.id)))),
      }));
      res.json({ projects: list.sort((a, b) => b.salesHT - a.salesHT), companies, total: P.total([...profits.values()]) });
    }),
  );

  r.get(
    "/settings",
    wrap(async (req, res) => {
      const { data, user } = await context(req);
      if (!(await marginVisible(db, user)) && !(await salaryVisible(db, user))) D.fail("Accès refusé.", 403);
      const settings = await settingsByCompany(db);
      const showRates = await salaryVisible(db, user);
      const companies = data.companies
        .filter((c) => c.id !== "group" && D.inCompany(user, c.id))
        .map((c) => {
          const s = P.settingsOf(settings.get(c.id));
          const employees = showRates
            ? data.employees
                .filter((e) => !e.deletedAt && D.employeeInCompany(e, c.id))
                .map((e) => ({ id: e.id, name: e.name, ...P.hourlyCost(e, s), fixed: s.rates[String(e.id)] || null }))
            : [];
          const { rates, ...general } = s;
          return { id: c.id, name: c.name, settings: general, employees };
        });
      res.json({ companies, defaults: P.DEFAULTS, canEdit: D.privileged(user, D.STAFF), showRates });
    }),
  );
  r.post(
    "/settings",
    wrap(async (req, res) => {
      const { data, user } = await context(req);
      if (!D.privileged(user, D.STAFF)) D.fail("Réservé à la direction.", 403);
      const company = String(req.body.company || "");
      if (!data.companies.some((c) => c.id === company && c.id !== "group") || !D.inCompany(user, company)) D.fail("Entreprise invalide.", 403);
      const b = req.body || {};
      const check = (v, name, min, max) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n < min || n > max) D.fail(`${name} invalide (${min} à ${max}).`);
        return n;
      };
      const current = (await settingsByCompany(db)).get(company) || {};
      const rates = { ...(current.rates || {}) };
      if (b.rates && typeof b.rates === "object" && (await salaryVisible(db, user)))
        for (const [id, v] of Object.entries(b.rates)) {
          if (!data.employees.some((e) => D.same(e.id, id))) continue;
          if (v === "" || v === null || Number(v) === 0) delete rates[String(id)];
          else rates[String(id)] = check(v, "Coût horaire", 1, 999);
        }
      const settings = {
        chargesPercent: check(b.chargesPercent, "Charges sociales (%)", 0, 100),
        salariesPerYear: check(b.salariesPerYear, "Nombre de salaires par an", 12, 14),
        weeksPerYear: check(b.weeksPerYear, "Semaines travaillées par an", 30, 52),
        fullTimeHours: check(b.fullTimeHours, "Heures par semaine à plein temps", 20, 60),
        purchaseVat: check(b.purchaseVat, "TVA des achats (%)", 0, 30),
        rates,
      };
      await db.query("INSERT INTO profit_settings(company,settings,updated_at) VALUES($1,$2,NOW()) ON CONFLICT (company) DO UPDATE SET settings=EXCLUDED.settings, updated_at=NOW()", [company, JSON.stringify(settings)]);
      await db.query("INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)", [user.email, "Réglages des coûts", JSON.stringify({ company })]);
      res.json({ ok: true });
    }),
  );
  return r;
}
module.exports = { routes, ensureSchema, profitsFor, marginVisible, flat };
