"use strict";
const express = require("express");
const { randomUUID, randomBytes } = require("node:crypto");
const D = require("./domain");
const { auth } = require("./auth-middleware");
const { syncEntityMirror } = require("./db");

const schemaPromises = new WeakMap();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clean = (v, max = 500, optional = false) => {
  if (optional && (v == null || String(v).trim() === "")) return "";
  if (typeof v !== "string" || !v.trim() || v.trim().length > max) D.fail("Texte invalide.");
  return v.trim();
};
const num = (v, min = 0, max = 1e12) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) D.fail("Nombre invalide.");
  return n;
};
const money = (v) => Math.round(num(v, 0, 1e9) * 100) / 100;
const bool = (v) => v === true || v === "true" || v === 1 || v === "1";
const isoDate = (v, optional = true) => {
  if (optional && !v) return null;
  return D.iso(String(v));
};
const allowed = (v, values, label = "Valeur") => {
  if (!values.includes(v)) D.fail(label + " invalide.");
  return v;
};
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (date, days) => {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString().slice(0, 10);
};
const advanceDate = (date, frequency) => {
  const d = new Date(date + "T12:00:00Z");
  if (frequency === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else if (frequency === "quarterly") d.setUTCMonth(d.getUTCMonth() + 3);
  else if (frequency === "yearly") d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
};
const staff = (u) => D.privileged(u, ["admin", "direction", "hr", "manager", "accounting"]);
const ops = (u) => D.privileged(u, [...D.OPS, "accounting"]);
const finance = (u) => D.privileged(u, D.FIN);
const hr = (u) => D.privileged(u, D.HR);
const companyAllowed = (u, company) =>
  !!company && company !== "group" && D.inCompany(u, company);

async function ensureSchema(db) {
  if (schemaPromises.has(db)) return schemaPromises.get(db);
  const promise = (async () => {
    const q = (sql) => db.query(sql);
    await q("ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS parent_task_id TEXT");
    await q("ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS milestone_id TEXT");
    await q(`CREATE TABLE IF NOT EXISTS p1_dashboard_preferences(
      user_id INTEGER PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await q(`CREATE TABLE IF NOT EXISTS p1_project_milestones(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      company TEXT NOT NULL,
      title TEXT NOT NULL,
      due_date DATE,
      status TEXT NOT NULL DEFAULT 'planned',
      notes TEXT,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await q("CREATE INDEX IF NOT EXISTS p1_milestones_project_idx ON p1_project_milestones(project_id,due_date)");
    await q(`CREATE TABLE IF NOT EXISTS p1_project_photo_meta(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      document_id TEXT,
      company TEXT NOT NULL,
      album TEXT NOT NULL DEFAULT 'pendant',
      annotation JSONB NOT NULL DEFAULT '[]'::jsonb,
      note TEXT,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await q(`CREATE TABLE IF NOT EXISTS p1_time_policies(
      company TEXT PRIMARY KEY,
      auto_break_after_hours NUMERIC(6,2) NOT NULL DEFAULT 6,
      auto_break_minutes INTEGER NOT NULL DEFAULT 30,
      geolocation_enabled BOOLEAN NOT NULL DEFAULT false,
      holiday_dates JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_by INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await q(`CREATE TABLE IF NOT EXISTS p1_time_geolocation(
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      employee_id TEXT,
      project_id TEXT,
      time_id TEXT,
      action TEXT NOT NULL,
      latitude NUMERIC(10,7) NOT NULL,
      longitude NUMERIC(10,7) NOT NULL,
      accuracy NUMERIC(10,2),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await q("CREATE INDEX IF NOT EXISTS p1_geo_employee_idx ON p1_time_geolocation(employee_id,created_at DESC)");
    await q(`CREATE TABLE IF NOT EXISTS p1_finance_templates(
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      name TEXT NOT NULL,
      title TEXT,
      lines JSONB NOT NULL DEFAULT '[]'::jsonb,
      defaults JSONB NOT NULL DEFAULT '{}'::jsonb,
      active BOOLEAN NOT NULL DEFAULT true,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await q(`CREATE TABLE IF NOT EXISTS p1_price_catalog(
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      sku TEXT,
      name TEXT NOT NULL,
      category TEXT,
      unit TEXT NOT NULL DEFAULT 'pcs',
      price NUMERIC(14,2) NOT NULL DEFAULT 0,
      vat_rate NUMERIC(6,2) NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT true,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(company,sku)
    )`);
    await q(`CREATE TABLE IF NOT EXISTS p1_client_pricing(
      client_id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      discount_pct NUMERIC(6,2) NOT NULL DEFAULT 0,
      payment_days INTEGER NOT NULL DEFAULT 30,
      price_tier TEXT,
      updated_by INTEGER NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await q(`CREATE TABLE IF NOT EXISTS p1_recurring_invoices(
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      client_id TEXT NOT NULL,
      project_id TEXT,
      title TEXT NOT NULL,
      lines JSONB NOT NULL,
      frequency TEXT NOT NULL,
      next_run DATE NOT NULL,
      payment_days INTEGER NOT NULL DEFAULT 30,
      active BOOLEAN NOT NULL DEFAULT true,
      created_by INTEGER NOT NULL,
      last_invoice_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await q(`CREATE TABLE IF NOT EXISTS p1_credit_notes(
      id TEXT PRIMARY KEY,
      number TEXT NOT NULL UNIQUE,
      company TEXT NOT NULL,
      invoice_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      amount NUMERIC(14,2) NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'issued',
      created_by INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await q(`CREATE TABLE IF NOT EXISTS p1_invoice_reminders(
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL,
      stage INTEGER NOT NULL,
      amount_due NUMERIC(14,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(invoice_id,stage)
    )`);
    await q(`CREATE TABLE IF NOT EXISTS p1_payment_links(
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ,
      active BOOLEAN NOT NULL DEFAULT true,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await q(`CREATE TABLE IF NOT EXISTS p1_purchase_orders(
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      supplier_id TEXT,
      supplier_name TEXT NOT NULL,
      project_id TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      ordered_at DATE,
      expected_at DATE,
      lines JSONB NOT NULL DEFAULT '[]'::jsonb,
      total NUMERIC(14,2) NOT NULL DEFAULT 0,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await q(`CREATE TABLE IF NOT EXISTS p1_inventory_barcodes(
      inventory_id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      updated_by INTEGER NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await q(`CREATE TABLE IF NOT EXISTS p1_inventory_location_stock(
      inventory_id TEXT NOT NULL,
      location_id TEXT NOT NULL,
      quantity NUMERIC(16,3) NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(inventory_id,location_id)
    )`);
    await q(`CREATE TABLE IF NOT EXISTS p1_tool_events(
      id TEXT PRIMARY KEY,
      tool_id TEXT NOT NULL,
      company TEXT NOT NULL,
      event_type TEXT NOT NULL,
      employee_id TEXT,
      note TEXT,
      due_date DATE,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await q(`CREATE TABLE IF NOT EXISTS p1_vehicle_events(
      id TEXT PRIMARY KEY,
      vehicle_id TEXT NOT NULL,
      company TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_date DATE NOT NULL,
      due_date DATE,
      km NUMERIC(14,1),
      note TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await q(`CREATE TABLE IF NOT EXISTS p1_maintenance_plans(
      id TEXT PRIMARY KEY,
      maintenance_id TEXT,
      company TEXT NOT NULL,
      client_id TEXT NOT NULL,
      project_id TEXT,
      title TEXT NOT NULL,
      frequency TEXT NOT NULL,
      next_run DATE NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      sla_hours INTEGER,
      auto_invoice BOOLEAN NOT NULL DEFAULT false,
      invoice_lines JSONB NOT NULL DEFAULT '[]'::jsonb,
      payment_days INTEGER NOT NULL DEFAULT 30,
      active BOOLEAN NOT NULL DEFAULT true,
      created_by INTEGER NOT NULL,
      last_work_order_id TEXT,
      last_invoice_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await q(`CREATE TABLE IF NOT EXISTS p1_integration_profiles(
      provider TEXT PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT false,
      mode TEXT NOT NULL DEFAULT 'manual',
      label TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_by INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await q(`INSERT INTO schema_migrations(version) VALUES
      ('2026-09-27-p1-complete-suite')
      ON CONFLICT(version) DO NOTHING`);
  })().catch((e) => {
    schemaPromises.delete(db);
    throw e;
  });
  schemaPromises.set(db, promise);
  return promise;
}

async function stateContext(db, user) {
  const row = (await db.query("SELECT data,revision FROM app_state WHERE id=1")).rows[0];
  const data = D.normalize(row?.data);
  return { data, view: D.viewState(data, user), revision: row?.revision || 0 };
}
function projectFor(ctx, user, id, write = false) {
  const visible = ctx.view.projects.find((p) => D.same(p.id, id));
  if (!visible) D.fail("Chantier inaccessible.", 403);
  const full = D.ref(ctx.data, "projects", id);
  if (write && !(ops(user) || (user.role === "employee" && (full.team || []).some((x) => D.same(x, user.employee_id)))))
    D.fail("Modification chantier non autorisée.", 403);
  return full;
}
function scopeCompanies(user) {
  if (user.company === "group" && staff(user)) return null;
  return (user.companies || [user.company]).filter((x) => x && x !== "group");
}
function inScope(user, company) {
  const companies = scopeCompanies(user);
  return companies == null || companies.includes(company);
}
function sanitizeLines(lines) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 200) D.fail("Prestations requises.");
  return lines.map((x) => ({
    description: clean(String(x.description || x.name || ""), 500),
    details: clean(String(x.details || ""), 3000, true),
    quantity: num(x.quantity ?? 1, 0.001, 1e7),
    unit: clean(String(x.unit || "pcs"), 30),
    unitPrice: money(x.unitPrice ?? x.price ?? 0),
    discount: num(x.discount ?? 0, 0, 100),
    vatRate: num(x.vatRate ?? 0, 0, 100),
  }));
}
function lineTotal(line) {
  const gross = Number(line.quantity) * Number(line.unitPrice);
  return Math.round(gross * (1 - Number(line.discount || 0) / 100) * (1 + Number(line.vatRate || 0) / 100) * 100) / 100;
}
async function notify(db, userIds, category, title, body, url = "") {
  for (const userId of [...new Set(userIds.map(Number).filter(Number.isFinite))])
    await db.query(
      `INSERT INTO user_notifications(id,user_id,category,title,body,url)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), userId, category.slice(0,60), title.slice(0,200), String(body || "").slice(0,1000), String(url || "").slice(0,1000)],
    );
}
async function withStateWrite(db, actorId, action, fn) {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const row = (await c.query("SELECT data,revision FROM app_state WHERE id=1 FOR UPDATE")).rows[0];
    const rawUser = (await c.query("SELECT * FROM users WHERE id=$1", [actorId])).rows[0];
    if (!rawUser || rawUser.disabled || rawUser.deleted_at) throw new Error("Utilisateur automatisation indisponible.");
    const data = D.normalize(row.data);
    const user = D.effectiveUser(data, rawUser);
    const result = await fn(c, data, user);
    await c.query(
      "UPDATE app_state SET data=$1,revision=revision+1,updated_at=NOW(),updated_by=$2 WHERE id=1",
      [JSON.stringify(result.data || data), user.email],
    );
    await syncEntityMirror(c, result.data || data, result.changed || undefined);
    await c.query(
      "INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)",
      [user.email, action.slice(0,100), JSON.stringify(result.audit || {})],
    );
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
async function createInvoiceFromPlan(db, plan, source) {
  let created;
  await withStateWrite(db, plan.created_by, source, async (c, data, user) => {
    const client = data.clients.find((x) => D.same(x.id, plan.client_id));
    if (!client) throw new Error("Client récurrent introuvable.");
    const issueDate = today();
    const pricing = (
      await c.query("SELECT discount_pct,payment_days FROM p1_client_pricing WHERE client_id=$1", [String(plan.client_id)])
    ).rows[0];
    const defaultDiscount = Number(pricing?.discount_pct || 0);
    const sourceLines = Array.isArray(plan.lines) ? plan.lines : (plan.invoice_lines || []);
    const invoiceLines = sourceLines.map((line) => ({
      ...line,
      discount: Number(line.discount || 0) || defaultDiscount,
    }));
    const payload = {
      company: plan.company,
      clientId: plan.client_id,
      project: plan.project_id || "",
      title: plan.title,
      lines: invoiceLines,
      date: issueDate,
      due: plusDays(issueDate, Number(pricing?.payment_days || plan.payment_days || 30)),
      language: "fr",
      message: source === "maintenance.recurring.invoice" ? "Facturation automatique du contrat de maintenance." : "Facturation récurrente.",
      terms: "",
      scope: plan.title,
      exclusions: "",
      paymentNote: "",
      paymentReference: "",
      depositPercent: 0,
    };
    const out = D.applyCommand(data, user, { action: "create", collection: "invoices", payload }, new Date().toISOString());
    created = out.result;
    return { data: out.data, changed: ["invoices"], audit: { invoiceId: created.id, source } };
  });
  return created;
}
async function processInvoiceReminders(db) {
  const state = D.normalize((await db.query("SELECT data FROM app_state WHERE id=1")).rows[0]?.data);
  const now = Date.now();
  let count = 0;
  for (const invoice of state.invoices.filter((x) => !x.deletedAt && x.status !== "Brouillon" && x.status !== "Payée" && x.due)) {
    const remaining = Math.max(0, Number(invoice.amount || 0) - Number(invoice.paid || 0));
    if (!remaining) continue;
    const lateDays = Math.floor((now - Date.parse(invoice.due + "T12:00:00Z")) / 86400000);
    const stage = lateDays >= 30 ? 30 : lateDays >= 14 ? 14 : lateDays >= 7 ? 7 : 0;
    if (!stage) continue;
    const exists = (await db.query("SELECT 1 FROM p1_invoice_reminders WHERE invoice_id=$1 AND stage=$2", [String(invoice.id), stage])).rows[0];
    if (exists) continue;
    await db.query(
      "INSERT INTO p1_invoice_reminders(id,invoice_id,stage,amount_due) VALUES($1,$2,$3,$4)",
      [randomUUID(), String(invoice.id), stage, remaining],
    );
    const recipients = (await db.query("SELECT id FROM users WHERE client_id=$1 AND disabled=false AND deleted_at IS NULL", [String(invoice.clientId)])).rows.map((x) => x.id);
    await notify(db, recipients, "invoice", "Rappel facture " + invoice.id, remaining.toFixed(2) + " CHF restent à payer · retard J+" + stage, "?open=invoices");
    count++;
  }
  return count;
}
async function runDueJobs(db) {
  await ensureSchema(db);
  let invoices = 0, maintenance = 0;
  const dueInvoices = (await db.query("SELECT * FROM p1_recurring_invoices WHERE active=true AND next_run<=CURRENT_DATE ORDER BY next_run LIMIT 50")).rows;
  for (const row of dueInvoices) {
    try {
      const invoice = await createInvoiceFromPlan(db, row, "finance.recurring.invoice");
      await db.query("UPDATE p1_recurring_invoices SET last_invoice_id=$1,next_run=$2,updated_at=NOW() WHERE id=$3", [invoice.id, advanceDate(row.next_run, row.frequency), row.id]);
      invoices++;
    } catch (e) {
      console.error("Recurring invoice failed", row.id, e.message);
    }
  }
  const dueMaintenance = (await db.query("SELECT * FROM p1_maintenance_plans WHERE active=true AND next_run<=CURRENT_DATE ORDER BY next_run LIMIT 50")).rows;
  for (const row of dueMaintenance) {
    try {
      const workId = randomUUID();
      await db.query(
        `INSERT INTO work_orders(id,company,client_id,project_id,maintenance_id,title,status,priority,scheduled_at,created_by)
         VALUES($1,$2,$3,$4,$5,$6,'planned',$7,$8,$9)`,
        [workId,row.company,row.client_id,row.project_id,row.maintenance_id,row.title,row.priority,new Date(row.next_run+"T08:00:00Z"),row.created_by],
      );
      let invoiceId = null;
      if (row.auto_invoice && Array.isArray(row.invoice_lines) && row.invoice_lines.length) {
        const invoice = await createInvoiceFromPlan(db, row, "maintenance.recurring.invoice");
        invoiceId = invoice.id;
      }
      await db.query(
        "UPDATE p1_maintenance_plans SET last_work_order_id=$1,last_invoice_id=COALESCE($2,last_invoice_id),next_run=$3,updated_at=NOW() WHERE id=$4",
        [workId,invoiceId,advanceDate(row.next_run,row.frequency),row.id],
      );
      maintenance++;
    } catch (e) {
      console.error("Maintenance plan failed", row.id, e.message);
    }
  }
  const reminders = await processInvoiceReminders(db);
  return { invoices, maintenance, reminders };
}

function routes(db) {
  const r = express.Router();

  r.get("/payment/:token", wrap(async (req,res) => {
    await ensureSchema(db);
    const link = (await db.query(
      "SELECT * FROM p1_payment_links WHERE token=$1 AND active=true AND (expires_at IS NULL OR expires_at>NOW())",
      [String(req.params.token)]
    )).rows[0];
    if (!link) return res.status(404).json({ error: "Lien invalide ou expiré." });
    const data = D.normalize((await db.query("SELECT data FROM app_state WHERE id=1")).rows[0]?.data);
    const invoice = data.invoices.find((x) => D.same(x.id, link.invoice_id) && !x.deletedAt && x.status !== "Brouillon");
    if (!invoice) return res.status(404).json({ error: "Facture introuvable." });
    const client = data.clients.find((x) => D.same(x.id, invoice.clientId));
    const company = data.companies.find((x) => x.id === invoice.company);
    res.json({
      invoice: { id: invoice.id, date: invoice.date, due: invoice.due, amount: invoice.amount, paid: invoice.paid || 0, currency: invoice.currency || "CHF", title: invoice.title, paymentReference: invoice.paymentReference || "" },
      client: { name: client?.name || "" },
      issuer: { name: company?.name || "", iban: company?.billing?.iban || "" },
    });
  }));

  r.use(auth(db));
  r.use(wrap(async (req,res,next) => { await ensureSchema(db); next(); }));

  r.get("/status", wrap(async (req,res) => {
    const tables = [
      "p1_dashboard_preferences",
      "p1_project_milestones",
      "p1_project_photo_meta",
      "p1_time_policies",
      "p1_time_geolocation",
      "p1_finance_templates",
      "p1_price_catalog",
      "p1_client_pricing",
      "p1_recurring_invoices",
      "p1_credit_notes",
      "p1_invoice_reminders",
      "p1_payment_links",
      "p1_purchase_orders",
      "p1_inventory_barcodes",
      "p1_inventory_location_stock",
      "p1_tool_events",
      "p1_vehicle_events",
      "p1_maintenance_plans",
      "p1_integration_profiles"
    ];
    const counts = {};
    for (const table of tables) counts[table] = Number((await db.query("SELECT COUNT(*)::int n FROM "+table)).rows[0]?.n || 0);
    const features = {
      dashboard: true,
      globalSearch: true,
      notifications: true,
      projectTasks: true,
      kanban: true,
      milestones: true,
      checklists: true,
      dailyReports: true,
      punchList: true,
      clientSignatures: true,
      changeOrders: true,
      photoAlbumsAnnotations: true,
      projectQr: true,
      simplifiedClocking: true,
      optionalGeolocation: true,
      automaticBreaks: true,
      overtimeNightSunday: true,
      timeApproval: true,
      payrollExport: true,
      onboardingOffboarding: true,
      complianceAlerts: true,
      employeeHistory: true,
      workOrders: true,
      recurringInvoices: true,
      creditNotes: true,
      invoiceReminders: true,
      paymentLinks: true,
      quoteTemplates: true,
      priceCatalog: true,
      clientPricing: true,
      purchaseOrders: true,
      stockMovements: true,
      barcodeQr: true,
      multipleLocations: true,
      minimumStockAlerts: true,
      toolTracking: true,
      advancedVehicles: true,
      recurringMaintenance: true,
      automaticInterventions: true,
      automaticMaintenanceBilling: true,
      sla: true,
      p1Translations: true
    };
    const external = {
      ebill: !!process.env.EBILL_API_KEY,
      banking: !!process.env.BANKING_API_KEY,
      bexio: !!process.env.BEXIO_API_TOKEN,
      abacus: !!process.env.ABACUS_API_TOKEN,
      winbiz: !!process.env.WINBIZ_API_TOKEN,
    };
    const featureValues = Object.values(features);
    res.json({
      ready: featureValues.every(Boolean),
      completion: {
        corePercent: Math.round((featureValues.filter(Boolean).length / featureValues.length) * 100),
        coreReady: featureValues.every(Boolean),
        externalConfigured: Object.values(external).filter(Boolean).length,
        externalTotal: Object.keys(external).length,
      },
      features,
      counts,
      external,
    });
  }));

  r.get("/dashboard", wrap(async (req,res) => {
    const ctx = await stateContext(db,req.user);
    const prefs = (await db.query("SELECT data FROM p1_dashboard_preferences WHERE user_id=$1",[req.user.id])).rows[0]?.data || {};
    const outstanding = ctx.view.invoices.reduce((n,x)=>n+Math.max(0,Number(x.amount||0)-Number(x.paid||0)),0);
    const todayDate = today();
    const myPlanning = req.user.employee_id ? ctx.view.planning.filter((x)=>D.same(x.employeeId,req.user.employee_id)&&x.date>=todayDate).sort((a,b)=>(a.date+a.start).localeCompare(b.date+b.start)).slice(0,5) : [];
    const unread = Number((await db.query("SELECT COUNT(*)::int n FROM user_notifications WHERE user_id=$1 AND read_at IS NULL",[req.user.id])).rows[0]?.n||0);
    let clientActions = { changeOrders: [], workOrders: [] };
    if (req.user.role === "client" && req.user.client_id) {
      const projectIds = ctx.view.projects.map((x) => String(x.id));
      if (projectIds.length) {
        clientActions.changeOrders = (
          await db.query(
            "SELECT id,project_id,title,description,amount,status,created_at FROM project_change_orders WHERE project_id=ANY($1::text[]) AND status='sent' ORDER BY created_at DESC",
            [projectIds],
          )
        ).rows;
      }
      clientActions.workOrders = (
        await db.query(
          "SELECT id,project_id,title,description,status,scheduled_at,customer_signature,signed_at FROM work_orders WHERE client_id=$1 AND status<>'cancelled' ORDER BY scheduled_at DESC NULLS LAST,created_at DESC LIMIT 100",
          [String(req.user.client_id)],
        )
      ).rows;
    }
    res.json({
      preferences: prefs,
      role: req.user.role,
      clientActions,
      kpis: {
        projects: ctx.view.projects.filter((x)=>x.status!=="Terminé").length,
        hours: ctx.view.time.reduce((n,x)=>n+Number(x.hours||0),0),
        outstanding,
        invoices: ctx.view.invoices.length,
        quotes: ctx.view.quotes.length,
        vacation: req.user.employee_id ? Number(ctx.view.employees.find((e)=>D.same(e.id,req.user.employee_id))?.vacation||0) : null,
        unread,
      },
      planning: myPlanning,
    });
  }));
  r.post("/dashboard/preferences", wrap(async (req,res) => {
    const data = req.body && typeof req.body === "object" ? req.body : {};
    const safe = {
      widgets: Array.isArray(data.widgets) ? data.widgets.map(String).slice(0,20) : [],
      compact: bool(data.compact),
      showPlanning: data.showPlanning !== false,
      showAlerts: data.showAlerts !== false,
    };
    await db.query(
      `INSERT INTO p1_dashboard_preferences(user_id,data) VALUES($1,$2)
       ON CONFLICT(user_id) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()`,
      [req.user.id,JSON.stringify(safe)],
    );
    res.json({ok:true,preferences:safe});
  }));

  r.post("/client/work-order/:id/sign", wrap(async (req,res) => {
    if (req.user.role !== "client" || !req.user.client_id)
      D.fail("Compte client requis.",403);
    const row = (
      await db.query(
        "SELECT * FROM work_orders WHERE id=$1 AND client_id=$2 AND status<>'cancelled'",
        [String(req.params.id), String(req.user.client_id)],
      )
    ).rows[0];
    if (!row) D.fail("Bon de travail inaccessible.",404);
    if (row.customer_signature) D.fail("Ce bon de travail est déjà signé.");
    const signature = clean(String(req.body?.signature || ""), 500);
    await db.query(
      "UPDATE work_orders SET customer_signature=$1,signed_at=NOW(),updated_at=NOW() WHERE id=$2",
      [signature,row.id],
    );
    await notify(
      db,
      (await db.query(
        "SELECT id FROM users WHERE disabled=false AND deleted_at IS NULL AND role=ANY($1::text[]) AND (company='group' OR company=$2)",
        [["admin","direction","manager"], row.company],
      )).rows.map((x)=>x.id),
      "project",
      "Bon de travail signé",
      row.title + " · signature client reçue",
      "?open=projects",
    );
    res.json({ok:true,id:row.id,signedAt:new Date().toISOString()});
  }));

  r.get("/project/:id/full", wrap(async (req,res) => {
    const ctx = await stateContext(db,req.user), project=projectFor(ctx,req.user,req.params.id);
    const pid=String(project.id);
    const [milestones,tasks,checklist,reports,punch,changes,photos] = await Promise.all([
      db.query("SELECT * FROM p1_project_milestones WHERE project_id=$1 ORDER BY due_date NULLS LAST,created_at",[pid]),
      db.query("SELECT * FROM project_tasks WHERE project_id=$1 ORDER BY position,created_at",[pid]),
      db.query("SELECT * FROM project_checklist_items WHERE project_id=$1 ORDER BY created_at",[pid]),
      db.query("SELECT * FROM project_daily_reports WHERE project_id=$1 ORDER BY report_date DESC,created_at DESC",[pid]),
      db.query("SELECT * FROM project_punch_items WHERE project_id=$1 ORDER BY created_at DESC",[pid]),
      db.query("SELECT * FROM project_change_orders WHERE project_id=$1 ORDER BY created_at DESC",[pid]),
      db.query("SELECT * FROM p1_project_photo_meta WHERE project_id=$1 ORDER BY created_at DESC",[pid]),
    ]);
    res.json({project,milestones:milestones.rows,tasks:tasks.rows,checklist:checklist.rows,reports:reports.rows,punch:punch.rows,changeOrders:changes.rows,photos:photos.rows});
  }));
  r.post("/project/:id/milestone", wrap(async (req,res) => {
    const ctx=await stateContext(db,req.user), p=projectFor(ctx,req.user,req.params.id,true), b=req.body||{}, id=b.id?String(b.id):randomUUID();
    const status=allowed(String(b.status||"planned"),["planned","in_progress","done","blocked"],"Statut");
    await db.query(
      `INSERT INTO p1_project_milestones(id,project_id,company,title,due_date,status,notes,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,due_date=EXCLUDED.due_date,status=EXCLUDED.status,notes=EXCLUDED.notes,updated_at=NOW()`,
      [id,String(p.id),p.company,clean(String(b.title||""),250),isoDate(b.dueDate),status,clean(String(b.notes||""),3000,true)||null,req.user.id]
    );
    res.json({ok:true,id});
  }));
  r.post("/project/:id/milestone/delete", wrap(async (req,res) => {
    const ctx=await stateContext(db,req.user); projectFor(ctx,req.user,req.params.id,true);
    await db.query("DELETE FROM p1_project_milestones WHERE id=$1 AND project_id=$2",[String(req.body?.id||""),String(req.params.id)]);
    res.json({ok:true});
  }));
  r.post("/project/:id/subtask", wrap(async (req,res) => {
    const ctx=await stateContext(db,req.user), p=projectFor(ctx,req.user,req.params.id,true), b=req.body||{}, id=b.id?String(b.id):randomUUID();
    if (!b.parentTaskId) D.fail("Tâche parente requise.");
    const parent=(await db.query("SELECT id FROM project_tasks WHERE id=$1 AND project_id=$2",[String(b.parentTaskId),String(p.id)])).rows[0];
    if(!parent) D.fail("Tâche parente introuvable.");
    await db.query(
      `INSERT INTO project_tasks(id,project_id,company,title,description,status,priority,assigned_employee_id,due_date,position,created_by,parent_task_id,milestone_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,description=EXCLUDED.description,status=EXCLUDED.status,priority=EXCLUDED.priority,assigned_employee_id=EXCLUDED.assigned_employee_id,due_date=EXCLUDED.due_date,parent_task_id=EXCLUDED.parent_task_id,milestone_id=EXCLUDED.milestone_id,updated_at=NOW()`,
      [id,String(p.id),p.company,clean(String(b.title||""),250),clean(String(b.description||""),3000,true)||null,allowed(String(b.status||"todo"),["todo","in_progress","blocked","done"],"Statut"),allowed(String(b.priority||"normal"),["low","normal","high","urgent"],"Priorité"),b.assignedEmployeeId?String(b.assignedEmployeeId):null,isoDate(b.dueDate),Number(b.position)||0,req.user.id,String(b.parentTaskId),b.milestoneId?String(b.milestoneId):null]
    );
    res.json({ok:true,id});
  }));
  r.post("/project/:id/photo-meta", wrap(async (req,res) => {
    const ctx=await stateContext(db,req.user), p=projectFor(ctx,req.user,req.params.id,true), b=req.body||{}, id=b.id?String(b.id):randomUUID();
    const album=allowed(String(b.album||"pendant"),["avant","pendant","apres","reserve","autre"],"Album");
    const annotation=Array.isArray(b.annotation)?b.annotation.slice(0,100):[];
    await db.query(
      `INSERT INTO p1_project_photo_meta(id,project_id,document_id,company,album,annotation,note,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(id) DO UPDATE SET document_id=EXCLUDED.document_id,album=EXCLUDED.album,annotation=EXCLUDED.annotation,note=EXCLUDED.note,updated_at=NOW()`,
      [id,String(p.id),b.documentId?String(b.documentId):null,p.company,album,JSON.stringify(annotation),clean(String(b.note||""),3000,true)||null,req.user.id]
    );
    res.json({ok:true,id});
  }));
  r.get("/project/:id/history", wrap(async (req,res) => {
    const ctx=await stateContext(db,req.user), p=projectFor(ctx,req.user,req.params.id), pid=String(p.id);
    const [events,tasks,milestones,geo] = await Promise.all([
      db.query("SELECT event_type,payload,created_at FROM app_events WHERE project_id=$1 ORDER BY created_at DESC LIMIT 300",[pid]),
      db.query("SELECT id,title,status,created_at,updated_at FROM project_tasks WHERE project_id=$1 ORDER BY updated_at DESC LIMIT 200",[pid]),
      db.query("SELECT id,title,status,due_date,created_at,updated_at FROM p1_project_milestones WHERE project_id=$1 ORDER BY updated_at DESC LIMIT 100",[pid]),
      db.query("SELECT action,employee_id,accuracy,created_at FROM p1_time_geolocation WHERE project_id=$1 ORDER BY created_at DESC LIMIT 100",[pid]),
    ]);
    const times=ctx.view.time.filter((x)=>D.same(x.project,p.id)).map((x)=>({type:"time",at:x.endedAt||x.date,title:(x.hours||0)+" h",data:x}));
    const rows=[
      ...events.rows.map((x)=>({type:"event",at:x.created_at,title:x.event_type,data:x.payload})),
      ...tasks.rows.map((x)=>({type:"task",at:x.updated_at,title:x.title,data:{status:x.status,id:x.id}})),
      ...milestones.rows.map((x)=>({type:"milestone",at:x.updated_at,title:x.title,data:{status:x.status,dueDate:x.due_date,id:x.id}})),
      ...geo.rows.map((x)=>({type:"geolocation",at:x.created_at,title:"Pointage "+x.action,data:{employeeId:x.employee_id,accuracy:x.accuracy}})),
      ...times
    ].sort((a,b)=>String(b.at||"").localeCompare(String(a.at||""))).slice(0,500);
    res.json({project:{id:p.id,title:p.title},history:rows});
  }));

  r.get("/time/policy", wrap(async (req,res) => {
    const company=String(req.query.company||req.user.company||"");
    if(!companyAllowed(req.user,company)) D.fail("Entreprise non autorisée.",403);
    const row=(await db.query("SELECT * FROM p1_time_policies WHERE company=$1",[company])).rows[0] || {company,auto_break_after_hours:6,auto_break_minutes:30,geolocation_enabled:false,holiday_dates:[]};
    res.json({policy:row});
  }));
  r.post("/time/policy", wrap(async (req,res) => {
    if(!D.privileged(req.user,[...D.HR,"manager"])) D.fail("Accès RH requis.",403);
    const b=req.body||{}, company=String(b.company||req.user.company||"");
    if(!companyAllowed(req.user,company)) D.fail("Entreprise non autorisée.",403);
    const holidays=Array.isArray(b.holidayDates)?b.holidayDates.map((x)=>isoDate(x,false)).slice(0,100):[];
    await db.query(
      `INSERT INTO p1_time_policies(company,auto_break_after_hours,auto_break_minutes,geolocation_enabled,holiday_dates,updated_by)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(company) DO UPDATE SET auto_break_after_hours=EXCLUDED.auto_break_after_hours,auto_break_minutes=EXCLUDED.auto_break_minutes,geolocation_enabled=EXCLUDED.geolocation_enabled,holiday_dates=EXCLUDED.holiday_dates,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
      [company,num(b.autoBreakAfterHours??6,0,24),Math.round(num(b.autoBreakMinutes??30,0,240)),bool(b.geolocationEnabled),JSON.stringify(holidays),req.user.id]
    );
    res.json({ok:true});
  }));
  r.post("/time/geolocation", wrap(async (req,res) => {
    if(!req.user.employee_id) D.fail("Compte salarié requis.",403);
    const b=req.body||{}, action=allowed(String(b.action||""),["start","stop"],"Action"), projectId=String(b.projectId||"");
    const ctx=await stateContext(db,req.user), project=projectFor(ctx,req.user,projectId);
    const policy=(await db.query("SELECT geolocation_enabled FROM p1_time_policies WHERE company=$1",[project.company])).rows[0];
    if(!policy?.geolocation_enabled) return res.json({ok:true,stored:false});
    const lat=Number(b.latitude), lng=Number(b.longitude), accuracy=b.accuracy==null?null:Number(b.accuracy);
    if(!Number.isFinite(lat)||lat < -90||lat>90||!Number.isFinite(lng)||lng < -180||lng>180) D.fail("Position invalide.");
    await db.query(
      "INSERT INTO p1_time_geolocation(id,user_id,employee_id,project_id,time_id,action,latitude,longitude,accuracy) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [randomUUID(),req.user.id,String(req.user.employee_id),projectId,b.timeId?String(b.timeId):null,action,lat,lng,Number.isFinite(accuracy)?accuracy:null]
    );
    res.json({ok:true,stored:true});
  }));
  r.post("/time/auto-break", wrap(async (req,res) => {
    if(!req.user.employee_id) D.fail("Compte salarié requis.",403);
    const timeId=String(req.body?.timeId||"");
    const c=await db.connect();
    try{
      await c.query("BEGIN");
      const row=(await c.query("SELECT data FROM app_state WHERE id=1 FOR UPDATE")).rows[0], data=D.normalize(row.data);
      const entry=data.time.find((x)=>D.same(x.id,timeId));
      if(!entry||!D.same(entry.employeeId,req.user.employee_id)) D.fail("Heures introuvables.",404);
      const project=data.projects.find((x)=>D.same(x.id,entry.project));
      if(!project) D.fail("Chantier introuvable.");
      const policy=(await c.query("SELECT * FROM p1_time_policies WHERE company=$1",[project.company])).rows[0];
      if(!policy||Number(policy.auto_break_minutes)<=0) { await c.query("ROLLBACK"); return res.json({ok:true,applied:false}); }
      const gross=(Date.parse(entry.endedAt)-Date.parse(entry.startedAt))/3600000;
      const current=Number(entry.break||0);
      if(!Number.isFinite(gross)||gross < Number(policy.auto_break_after_hours)||current>=Number(policy.auto_break_minutes)) {
        await c.query("ROLLBACK"); return res.json({ok:true,applied:false});
      }
      const extra=Number(policy.auto_break_minutes)-current;
      entry.break=Number(policy.auto_break_minutes);
      entry.seconds=Math.max(0,Number(entry.seconds||0)-Math.round(extra*60));
      entry.hours=Math.round(entry.seconds/3.6)/1000;
      entry.autoBreakApplied=true;
      await c.query("UPDATE app_state SET data=$1,revision=revision+1,updated_at=NOW(),updated_by=$2 WHERE id=1",[JSON.stringify(data),req.user.email]);
      await syncEntityMirror(c,data,["time"]);
      await c.query("COMMIT");
      res.json({ok:true,applied:true,minutes:entry.break,hours:entry.hours});
    }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
  }));
  r.get("/time/summary", wrap(async (req,res) => {
    const month=String(req.query.month||"");
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) D.fail("Mois invalide.");
    const ctx=await stateContext(db,req.user), companies=[...new Set(ctx.view.time.map((x)=>x.company).filter(Boolean))], policyMap={};
    for(const c of companies) policyMap[c]=(await db.query("SELECT holiday_dates FROM p1_time_policies WHERE company=$1",[c])).rows[0]?.holiday_dates||[];
    const rows={};
    for(const t of ctx.view.time.filter((x)=>String(x.date||"").startsWith(month+"-"))){
      const key=String(t.employeeId), company=t.company||ctx.data.projects.find((p)=>D.same(p.id,t.project))?.company;
      rows[key] ||= {employeeId:key,name:ctx.view.employees.find((e)=>D.same(e.id,key))?.name||key,total:0,holiday:0};
      rows[key].total += Number(t.hours||0);
      if((policyMap[company]||[]).includes(t.date)) rows[key].holiday += Number(t.hours||0);
    }
    res.json({month,rows:Object.values(rows).map((x)=>({...x,total:Math.round(x.total*100)/100,holiday:Math.round(x.holiday*100)/100}))});
  }));

  r.get("/finance", wrap(async (req,res) => {
    if(!finance(req.user)) D.fail("Accès comptabilité requis.",403);
    const ctx=await stateContext(db,req.user), companies=scopeCompanies(req.user), filter=(x)=>companies==null||companies.includes(x.company);
    const [templates,catalog,pricing,recurring,credits,reminders,links] = await Promise.all([
      db.query("SELECT * FROM p1_finance_templates ORDER BY updated_at DESC"),
      db.query("SELECT * FROM p1_price_catalog ORDER BY category,name"),
      db.query("SELECT * FROM p1_client_pricing ORDER BY updated_at DESC"),
      db.query("SELECT * FROM p1_recurring_invoices ORDER BY next_run"),
      db.query("SELECT * FROM p1_credit_notes ORDER BY created_at DESC LIMIT 200"),
      db.query("SELECT * FROM p1_invoice_reminders ORDER BY created_at DESC LIMIT 200"),
      db.query("SELECT id,invoice_id,expires_at,active,created_at FROM p1_payment_links ORDER BY created_at DESC LIMIT 200"),
    ]);
    res.json({
      templates:templates.rows.filter(filter),catalog:catalog.rows.filter(filter),pricing:pricing.rows.filter(filter),recurring:recurring.rows.filter(filter),credits:credits.rows.filter(filter),
      reminders:reminders.rows,links:links.rows,
      clients:ctx.view.clients.map((x)=>({id:x.id,name:x.name,company:x.company})),
      invoices:ctx.view.invoices.filter((x)=>!x.deletedAt).map((x)=>({id:x.id,clientId:x.clientId,company:x.company,amount:x.amount,paid:x.paid||0,due:x.due,status:x.status,title:x.title}))
    });
  }));
  r.post("/finance/template", wrap(async (req,res) => {
    if(!finance(req.user)) D.fail("Accès comptabilité requis.",403);
    const b=req.body||{}, company=String(b.company||""); if(!companyAllowed(req.user,company)) D.fail("Entreprise non autorisée.",403);
    const id=b.id?String(b.id):randomUUID(), lines=sanitizeLines(b.lines||[]);
    await db.query(
      `INSERT INTO p1_finance_templates(id,company,name,title,lines,defaults,active,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,title=EXCLUDED.title,lines=EXCLUDED.lines,defaults=EXCLUDED.defaults,active=EXCLUDED.active,updated_at=NOW()`,
      [id,company,clean(String(b.name||""),200),clean(String(b.title||""),250,true)||null,JSON.stringify(lines),JSON.stringify(b.defaults&&typeof b.defaults==="object"?b.defaults:{}),b.active!==false,req.user.id]
    ); res.json({ok:true,id});
  }));
  r.post("/finance/catalog", wrap(async (req,res) => {
    if(!finance(req.user)) D.fail("Accès comptabilité requis.",403);
    const b=req.body||{}, company=String(b.company||""); if(!companyAllowed(req.user,company)) D.fail("Entreprise non autorisée.",403);
    const id=b.id?String(b.id):randomUUID();
    await db.query(
      `INSERT INTO p1_price_catalog(id,company,sku,name,category,unit,price,vat_rate,active,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(id) DO UPDATE SET sku=EXCLUDED.sku,name=EXCLUDED.name,category=EXCLUDED.category,unit=EXCLUDED.unit,price=EXCLUDED.price,vat_rate=EXCLUDED.vat_rate,active=EXCLUDED.active,updated_at=NOW()`,
      [id,company,clean(String(b.sku||""),80,true)||null,clean(String(b.name||""),250),clean(String(b.category||""),120,true)||null,clean(String(b.unit||"pcs"),30),money(b.price||0),num(b.vatRate||0,0,100),b.active!==false,req.user.id]
    ); res.json({ok:true,id});
  }));
  r.post("/finance/client-pricing", wrap(async (req,res) => {
    if(!finance(req.user)) D.fail("Accès comptabilité requis.",403);
    const ctx=await stateContext(db,req.user), client=ctx.view.clients.find((x)=>D.same(x.id,req.body?.clientId));
    if(!client) D.fail("Client inaccessible.",403);
    await db.query(
      `INSERT INTO p1_client_pricing(client_id,company,discount_pct,payment_days,price_tier,updated_by)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(client_id) DO UPDATE SET discount_pct=EXCLUDED.discount_pct,payment_days=EXCLUDED.payment_days,price_tier=EXCLUDED.price_tier,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
      [String(client.id),client.company,num(req.body?.discountPct||0,0,100),Math.round(num(req.body?.paymentDays??30,0,365)),clean(String(req.body?.priceTier||""),80,true)||null,req.user.id]
    ); res.json({ok:true});
  }));
  r.post("/finance/recurring", wrap(async (req,res) => {
    if(!finance(req.user)) D.fail("Accès comptabilité requis.",403);
    const b=req.body||{}, ctx=await stateContext(db,req.user), client=ctx.view.clients.find((x)=>D.same(x.id,b.clientId));
    if(!client) D.fail("Client inaccessible.",403);
    const id=b.id?String(b.id):randomUUID(), frequency=allowed(String(b.frequency||"monthly"),["weekly","monthly","quarterly","yearly"],"Fréquence"), lines=sanitizeLines(b.lines);
    await db.query(
      `INSERT INTO p1_recurring_invoices(id,company,client_id,project_id,title,lines,frequency,next_run,payment_days,active,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT(id) DO UPDATE SET client_id=EXCLUDED.client_id,project_id=EXCLUDED.project_id,title=EXCLUDED.title,lines=EXCLUDED.lines,frequency=EXCLUDED.frequency,next_run=EXCLUDED.next_run,payment_days=EXCLUDED.payment_days,active=EXCLUDED.active,updated_at=NOW()`,
      [id,client.company,String(client.id),b.projectId?String(b.projectId):null,clean(String(b.title||""),250),JSON.stringify(lines),frequency,isoDate(b.nextRun,false),Math.round(num(b.paymentDays??30,0,365)),b.active!==false,req.user.id]
    ); res.json({ok:true,id});
  }));
  r.post("/finance/credit-note", wrap(async (req,res) => {
    if(!finance(req.user)) D.fail("Accès comptabilité requis.",403);
    const ctx=await stateContext(db,req.user), inv=ctx.view.invoices.find((x)=>D.same(x.id,req.body?.invoiceId)&&!x.deletedAt);
    if(!inv) D.fail("Facture inaccessible.",403);
    const amount=money(req.body?.amount); if(amount>Number(inv.amount||0)) D.fail("Avoir supérieur à la facture.");
    const id=randomUUID(), number="AV-"+new Date().getUTCFullYear()+"-"+String(Number((await db.query("SELECT COUNT(*)::int n FROM p1_credit_notes WHERE EXTRACT(YEAR FROM created_at)=EXTRACT(YEAR FROM NOW())")).rows[0]?.n||0)+1).padStart(4,"0");
    await db.query(
      "INSERT INTO p1_credit_notes(id,number,company,invoice_id,client_id,amount,reason,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'issued',$8)",
      [id,number,inv.company,String(inv.id),String(inv.clientId),amount,clean(String(req.body?.reason||""),2000),req.user.id]
    ); res.json({ok:true,id,number});
  }));
  r.post("/finance/payment-link", wrap(async (req,res) => {
    if(!finance(req.user)) D.fail("Accès comptabilité requis.",403);
    const ctx=await stateContext(db,req.user), inv=ctx.view.invoices.find((x)=>D.same(x.id,req.body?.invoiceId)&&!x.deletedAt&&x.status!=="Brouillon");
    if(!inv) D.fail("Facture émise inaccessible.",403);
    const token=randomBytes(32).toString("hex"), id=randomUUID(), days=Math.round(num(req.body?.days??30,1,365));
    await db.query("INSERT INTO p1_payment_links(id,invoice_id,token,expires_at,created_by) VALUES($1,$2,$3,NOW()+($4::text||' days')::interval,$5)",[id,String(inv.id),token,String(days),req.user.id]);
    res.json({ok:true,id,url:"/pay.html?token="+encodeURIComponent(token),apiUrl:"/api/p1/payment/"+token,expiresInDays:days});
  }));
  r.post("/finance/run-reminders", wrap(async (req,res) => {
    if(!finance(req.user)) D.fail("Accès comptabilité requis.",403);
    res.json({ok:true,created:await processInvoiceReminders(db)});
  }));

  r.get("/procurement", wrap(async (req,res) => {
    if(!ops(req.user)) D.fail("Accès achats requis.",403);
    const ctx=await stateContext(db,req.user), companies=scopeCompanies(req.user), filter=(x)=>companies==null||companies.includes(x.company);
    const [locations,orders,barcodes,balances]=await Promise.all([
      db.query("SELECT * FROM inventory_locations ORDER BY company,name"),
      db.query("SELECT * FROM p1_purchase_orders ORDER BY created_at DESC LIMIT 300"),
      db.query("SELECT * FROM p1_inventory_barcodes"),
      db.query("SELECT * FROM p1_inventory_location_stock ORDER BY inventory_id,location_id")
    ]);
    const allowedLocations = locations.rows.filter(filter);
    const locationIds = new Set(allowedLocations.map((x)=>String(x.id)));
    res.json({locations:allowedLocations,orders:orders.rows.filter(filter),barcodes:barcodes.rows,balances:balances.rows.filter((x)=>locationIds.has(String(x.location_id))),inventory:ctx.view.inventory,suppliers:ctx.view.suppliers});
  }));
  r.post("/procurement/location", wrap(async (req,res) => {
    if(!ops(req.user)) D.fail("Accès achats requis.",403);
    const b=req.body||{}, company=String(b.company||""); if(!companyAllowed(req.user,company)) D.fail("Entreprise non autorisée.",403);
    const id=b.id?String(b.id):randomUUID();
    await db.query(
      `INSERT INTO inventory_locations(id,company,name,type) VALUES($1,$2,$3,$4)
       ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,type=EXCLUDED.type`,
      [id,company,clean(String(b.name||""),200),allowed(String(b.type||"warehouse"),["warehouse","vehicle","project","other"],"Type")]
    ); res.json({ok:true,id});
  }));
  r.post("/procurement/order", wrap(async (req,res) => {
    if(!ops(req.user)) D.fail("Accès achats requis.",403);
    const b=req.body||{}, ctx=await stateContext(db,req.user), supplier=ctx.view.suppliers.find((x)=>D.same(x.id,b.supplierId));
    if(!supplier) D.fail("Fournisseur inaccessible.",403);
    const id=b.id?String(b.id):randomUUID(), lines=sanitizeLines(b.lines), total=Math.round(lines.reduce((n,x)=>n+lineTotal(x),0)*100)/100;
    await db.query(
      `INSERT INTO p1_purchase_orders(id,company,supplier_id,supplier_name,project_id,status,ordered_at,expected_at,lines,total,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT(id) DO UPDATE SET supplier_id=EXCLUDED.supplier_id,supplier_name=EXCLUDED.supplier_name,project_id=EXCLUDED.project_id,status=EXCLUDED.status,ordered_at=EXCLUDED.ordered_at,expected_at=EXCLUDED.expected_at,lines=EXCLUDED.lines,total=EXCLUDED.total,updated_at=NOW()`,
      [id,supplier.company,String(supplier.id),supplier.name,b.projectId?String(b.projectId):null,allowed(String(b.status||"draft"),["draft","ordered","partially_received","received","cancelled"],"Statut"),isoDate(b.orderedAt),isoDate(b.expectedAt),JSON.stringify(lines),total,req.user.id]
    ); res.json({ok:true,id,total});
  }));
  r.post("/procurement/stock-move", wrap(async (req,res) => {
    if(!ops(req.user)) D.fail("Accès stock requis.",403);
    const b=req.body||{}, ctx=await stateContext(db,req.user),
      item=ctx.view.inventory.find((x)=>D.same(x.id,b.inventoryId));
    if(!item) D.fail("Article inaccessible.",403);
    const quantity=num(b.quantity,0.001,1e9),
      fromId=b.fromLocationId?String(b.fromLocationId):null,
      toId=b.toLocationId?String(b.toLocationId):null;
    if(!fromId&&!toId) D.fail("Choisissez une origine ou une destination.");
    if(fromId&&toId&&fromId===toId) D.fail("Origine et destination identiques.");
    const ids=[fromId,toId].filter(Boolean),
      locs=ids.length?(await db.query("SELECT * FROM inventory_locations WHERE id=ANY($1::text[])",[ids])).rows:[];
    if(locs.length!==ids.length||locs.some((x)=>x.company!==item.company))
      D.fail("Dépôt incompatible.",403);
    const client=await db.connect();
    try{
      await client.query("BEGIN");
      if(fromId){
        const current=Number((await client.query(
          "SELECT quantity FROM p1_inventory_location_stock WHERE inventory_id=$1 AND location_id=$2 FOR UPDATE",
          [String(item.id),fromId]
        )).rows[0]?.quantity||0);
        if(current<quantity) D.fail("Stock insuffisant dans le dépôt source.");
        await client.query(
          `INSERT INTO p1_inventory_location_stock(inventory_id,location_id,quantity)
           VALUES($1,$2,$3)
           ON CONFLICT(inventory_id,location_id) DO UPDATE SET quantity=p1_inventory_location_stock.quantity+$3,updated_at=NOW()`,
          [String(item.id),fromId,-quantity]
        );
        await client.query(
          `INSERT INTO inventory_movements(id,inventory_id,company,location_id,project_id,employee_id,quantity,movement_type,note,created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [randomUUID(),String(item.id),item.company,fromId,b.projectId?String(b.projectId):null,req.user.employee_id||null,-quantity,toId?"transfer":"out",clean(String(b.note||""),1000,true)||null,req.user.id]
        );
      }
      if(toId){
        await client.query(
          `INSERT INTO p1_inventory_location_stock(inventory_id,location_id,quantity)
           VALUES($1,$2,$3)
           ON CONFLICT(inventory_id,location_id) DO UPDATE SET quantity=p1_inventory_location_stock.quantity+$3,updated_at=NOW()`,
          [String(item.id),toId,quantity]
        );
        await client.query(
          `INSERT INTO inventory_movements(id,inventory_id,company,location_id,project_id,employee_id,quantity,movement_type,note,created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [randomUUID(),String(item.id),item.company,toId,b.projectId?String(b.projectId):null,req.user.employee_id||null,quantity,fromId?"transfer":"in",clean(String(b.note||""),1000,true)||null,req.user.id]
        );
      }
      await client.query("COMMIT");
    }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
    if(!fromId||!toId){
      await withStateWrite(db,req.user.id,"inventory.location.move",async(_c,data)=>{
        const live=data.inventory.find((x)=>D.same(x.id,item.id));
        if(!live) D.fail("Article introuvable.");
        live.stock=Math.max(0,Number(live.stock||0)+(toId?quantity:-quantity));
        return {data,changed:["inventory"],audit:{inventoryId:item.id,fromId,toId,quantity}};
      });
    }
    res.json({ok:true,inventoryId:item.id,fromLocationId:fromId,toLocationId:toId,quantity});
  }));

  r.post("/procurement/barcode", wrap(async (req,res) => {
    if(!ops(req.user)) D.fail("Accès stock requis.",403);
    const ctx=await stateContext(db,req.user), item=ctx.view.inventory.find((x)=>D.same(x.id,req.body?.inventoryId));
    if(!item) D.fail("Article inaccessible.",403);
    const code=clean(String(req.body?.code||""),160);
    await db.query(
      `INSERT INTO p1_inventory_barcodes(inventory_id,code,updated_by) VALUES($1,$2,$3)
       ON CONFLICT(inventory_id) DO UPDATE SET code=EXCLUDED.code,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
      [String(item.id),code,req.user.id]
    ); res.json({ok:true});
  }));
  r.get("/procurement/lookup/:code", wrap(async (req,res) => {
    const row=(await db.query("SELECT inventory_id FROM p1_inventory_barcodes WHERE code=$1",[String(req.params.code)])).rows[0];
    if(!row) return res.status(404).json({error:"Code inconnu."});
    const ctx=await stateContext(db,req.user), item=ctx.view.inventory.find((x)=>D.same(x.id,row.inventory_id));
    if(!item) D.fail("Article inaccessible.",403);
    res.json({item});
  }));

  r.get("/assets", wrap(async (req,res) => {
    const ctx=await stateContext(db,req.user), toolIds=new Set(ctx.view.tools.map((x)=>String(x.id))), vehicleIds=new Set(ctx.view.vehicles.map((x)=>String(x.id)));
    const [te,ve]=await Promise.all([db.query("SELECT * FROM p1_tool_events ORDER BY created_at DESC LIMIT 500"),db.query("SELECT * FROM p1_vehicle_events ORDER BY event_date DESC,created_at DESC LIMIT 500")]);
    res.json({tools:ctx.view.tools,vehicles:ctx.view.vehicles,toolEvents:te.rows.filter((x)=>toolIds.has(String(x.tool_id))),vehicleEvents:ve.rows.filter((x)=>vehicleIds.has(String(x.vehicle_id)))});
  }));
  r.post("/assets/tool-event", wrap(async (req,res) => {
    if(!ops(req.user)) D.fail("Accès outillage requis.",403);
    const b=req.body||{}, ctx=await stateContext(db,req.user), tool=ctx.view.tools.find((x)=>D.same(x.id,b.toolId));
    if(!tool) D.fail("Outil inaccessible.",403);
    const id=randomUUID(), type=allowed(String(b.eventType||"assignment"),["assignment","return","lost","broken","maintenance","inspection"],"Événement");
    await db.query("INSERT INTO p1_tool_events(id,tool_id,company,event_type,employee_id,note,due_date,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[id,String(tool.id),tool.company,type,b.employeeId?String(b.employeeId):null,clean(String(b.note||""),2000,true)||null,isoDate(b.dueDate),req.user.id]);
    await withStateWrite(db,req.user.id,"tool.event",async(_c,data)=>{
      const live=data.tools.find((x)=>D.same(x.id,tool.id));
      if(!live) D.fail("Outil introuvable.");
      if(type==="assignment"){if(!b.employeeId)D.fail("Salarié requis pour une attribution.");live.employeeId=String(b.employeeId);live.status="Attribué";}
      else if(type==="return"){delete live.employeeId;live.status="Disponible";}
      else if(type==="lost") live.status="Perdu";
      else if(type==="broken") live.status="Cassé";
      else if(type==="maintenance") live.status="Maintenance";
      return {data,changed:["tools"],audit:{toolId:tool.id,eventType:type}};
    });
    res.json({ok:true,id});
  }));
  r.post("/assets/vehicle-event", wrap(async (req,res) => {
    if(!ops(req.user)) D.fail("Accès véhicules requis.",403);
    const b=req.body||{}, ctx=await stateContext(db,req.user), v=ctx.view.vehicles.find((x)=>D.same(x.id,b.vehicleId));
    if(!v) D.fail("Véhicule inaccessible.",403);
    const id=randomUUID(), type=allowed(String(b.eventType||"service"),["service","tires","insurance","inspection","damage","fuel","km","assignment"],"Événement");
    await db.query("INSERT INTO p1_vehicle_events(id,vehicle_id,company,event_type,event_date,due_date,km,note,metadata,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",[id,String(v.id),v.company,type,isoDate(b.eventDate||today(),false),isoDate(b.dueDate),b.km==null?null:num(b.km,0,1e8),clean(String(b.note||""),3000,true)||null,JSON.stringify(b.metadata&&typeof b.metadata==="object"?b.metadata:{}),req.user.id]);
    await withStateWrite(db,req.user.id,"vehicle.event",async(_c,data)=>{
      const live=data.vehicles.find((x)=>D.same(x.id,v.id));
      if(!live) D.fail("Véhicule introuvable.");
      if(b.km!=null) live.km=Number(b.km);
      if(type==="damage") live.status="À réparer";
      else if(type==="service"){live.status="Disponible";live.service=b.dueDate?String(b.dueDate):live.service;}
      else if(type==="assignment"&&b.employeeId){live.employeeId=String(b.employeeId);live.status="Attribué";}
      return {data,changed:["vehicles"],audit:{vehicleId:v.id,eventType:type}};
    });
    res.json({ok:true,id});
  }));

  r.get("/maintenance", wrap(async (req,res) => {
    const ctx=await stateContext(db,req.user), companies=scopeCompanies(req.user);
    const rows=(await db.query("SELECT * FROM p1_maintenance_plans ORDER BY next_run")).rows.filter((x)=>companies==null||companies.includes(x.company));
    res.json({plans:rows,maintenance:ctx.view.maintenance,clients:ctx.view.clients});
  }));
  r.post("/maintenance/plan", wrap(async (req,res) => {
    if(!ops(req.user)) D.fail("Accès maintenance requis.",403);
    const b=req.body||{}, ctx=await stateContext(db,req.user), client=ctx.view.clients.find((x)=>D.same(x.id,b.clientId));
    if(!client) D.fail("Client inaccessible.",403);
    const id=b.id?String(b.id):randomUUID(), frequency=allowed(String(b.frequency||"monthly"),["weekly","monthly","quarterly","yearly"],"Fréquence"), priority=allowed(String(b.priority||"normal"),["low","normal","high","urgent"],"Priorité"), lines=bool(b.autoInvoice)?sanitizeLines(b.invoiceLines):[];
    if(bool(b.autoInvoice)&&!finance(req.user)) D.fail("La facturation automatique doit être configurée par la comptabilité.",403);
    await db.query(
      `INSERT INTO p1_maintenance_plans(id,maintenance_id,company,client_id,project_id,title,frequency,next_run,priority,sla_hours,auto_invoice,invoice_lines,payment_days,active,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT(id) DO UPDATE SET maintenance_id=EXCLUDED.maintenance_id,client_id=EXCLUDED.client_id,project_id=EXCLUDED.project_id,title=EXCLUDED.title,frequency=EXCLUDED.frequency,next_run=EXCLUDED.next_run,priority=EXCLUDED.priority,sla_hours=EXCLUDED.sla_hours,auto_invoice=EXCLUDED.auto_invoice,invoice_lines=EXCLUDED.invoice_lines,payment_days=EXCLUDED.payment_days,active=EXCLUDED.active,updated_at=NOW()`,
      [id,b.maintenanceId?String(b.maintenanceId):null,client.company,String(client.id),b.projectId?String(b.projectId):null,clean(String(b.title||""),250),frequency,isoDate(b.nextRun,false),priority,b.slaHours?Math.round(num(b.slaHours,1,720)):null,bool(b.autoInvoice),JSON.stringify(lines),Math.round(num(b.paymentDays??30,0,365)),b.active!==false,req.user.id]
    ); res.json({ok:true,id});
  }));

  r.get("/employee/:id/history", wrap(async (req,res) => {
    const ctx=await stateContext(db,req.user), employee=ctx.view.employees.find((x)=>D.same(x.id,req.params.id));
    if(!employee) D.fail("Salarié inaccessible.",403);
    if(!(hr(req.user)||D.same(req.user.employee_id,employee.id))) D.fail("Accès RH requis.",403);
    const id=String(employee.id);
    const [life,tools,geo]=await Promise.all([
      db.query("SELECT phase,label,completed,completed_at,created_at FROM employee_lifecycle_items WHERE employee_id=$1 ORDER BY created_at DESC",[id]),
      db.query("SELECT event_type,note,due_date,created_at,tool_id FROM p1_tool_events WHERE employee_id=$1 ORDER BY created_at DESC",[id]),
      db.query("SELECT action,project_id,accuracy,created_at FROM p1_time_geolocation WHERE employee_id=$1 ORDER BY created_at DESC LIMIT 300",[id]),
    ]);
    const rows=[
      ...ctx.view.time.filter((x)=>D.same(x.employeeId,id)).map((x)=>({type:"time",at:x.endedAt||x.date,title:(x.hours||0)+" h",data:x})),
      ...ctx.view.planning.filter((x)=>D.same(x.employeeId,id)).map((x)=>({type:"planning",at:x.date,title:"Planning",data:x})),
      ...ctx.view.absences.filter((x)=>D.same(x.employeeId,id)).map((x)=>({type:"absence",at:x.from,title:x.type,data:x})),
      ...life.rows.map((x)=>({type:"lifecycle",at:x.completed_at||x.created_at,title:x.label,data:x})),
      ...tools.rows.map((x)=>({type:"tool",at:x.created_at,title:x.event_type,data:x})),
      ...geo.rows.map((x)=>({type:"geolocation",at:x.created_at,title:"Pointage "+x.action,data:x})),
    ].sort((a,b)=>String(b.at||"").localeCompare(String(a.at||""))).slice(0,800);
    res.json({employee:{id:employee.id,name:employee.name,company:employee.company},history:rows});
  }));

  r.get("/integrations", wrap(async (req,res) => {
    if(!D.privileged(req.user,D.STAFF)) D.fail("Accès direction requis.",403);
    const rows=(await db.query("SELECT * FROM p1_integration_profiles ORDER BY provider")).rows;
    const runtime={
      ebill:!!process.env.EBILL_API_KEY,banking:!!process.env.BANKING_API_KEY,bexio:!!process.env.BEXIO_API_TOKEN,
      abacus:!!process.env.ABACUS_API_TOKEN,winbiz:!!process.env.WINBIZ_API_TOKEN,email:!!process.env.SMTP_URL,sms:!!process.env.SMS_API_KEY
    };
    res.json({profiles:rows,runtime});
  }));
  r.post("/integrations", wrap(async (req,res) => {
    if(!D.privileged(req.user,D.STAFF)) D.fail("Accès direction requis.",403);
    const b=req.body||{}, provider=allowed(String(b.provider||""),["ebill","banking","bexio","abacus","winbiz","email","sms"],"Connecteur");
    await db.query(
      `INSERT INTO p1_integration_profiles(provider,enabled,mode,label,metadata,updated_by)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(provider) DO UPDATE SET enabled=EXCLUDED.enabled,mode=EXCLUDED.mode,label=EXCLUDED.label,metadata=EXCLUDED.metadata,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
      [provider,bool(b.enabled),allowed(String(b.mode||"manual"),["manual","api","export"],"Mode"),clean(String(b.label||""),200,true)||null,JSON.stringify(b.metadata&&typeof b.metadata==="object"?b.metadata:{}),req.user.id]
    );
    res.json({ok:true,note:"Les secrets API restent exclusivement dans les variables d’environnement serveur."});
  }));

  r.post("/run-jobs", wrap(async (req,res) => {
    if(!D.privileged(req.user,["admin","direction"])) D.fail("Accès direction requis.",403);
    res.json({ok:true,...await runDueJobs(db)});
  }));

  return r;
}

module.exports = { routes, ensureSchema, runDueJobs, processInvoiceReminders };
