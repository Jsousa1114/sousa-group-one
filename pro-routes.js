"use strict";

const express = require("express");
const { randomUUID } = require("node:crypto");
const PDFDocument = require("pdfkit");
const D = require("./domain");
const { auth } = require("./auth-middleware");
const { loadState, persistedState, syncEntityMirror } = require("./db");

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const same = D.same;
const schemaPromises = new WeakMap();
const TRASHABLE = new Set([
  "clients",
  "projects",
  "documents",
  "inventory",
  "suppliers",
  "vehicles",
  "tools",
  "maintenance",
  "quotes",
  "invoices",
]);
const PERMISSIONS = [
  ["salary.view", "Voir les salaires"],
  ["invoice.edit", "Modifier les factures"],
  ["client.delete", "Mettre un client à la corbeille"],
  ["companies.all", "Voir toutes les entreprises"],
  ["margin.view", "Consulter les marges"],
  ["time.edit", "Modifier / valider les heures"],
  ["hr.access", "Accéder aux fonctions RH"],
  ["data.export", "Exporter les données"],
  ["project.close", "Terminer un chantier"],
  ["project.acceptance", "Signer / valider la réception d'un chantier"],
  ["notification.manage", "Configurer ses notifications ciblées"],
  ["vehicle.manage", "Gérer les échéances et le suivi véhicules"],
  ["trash.restore", "Restaurer depuis la corbeille"],
  ["settings.branding", "Modifier la marque / le white-label"],
  ["settings.modules", "Activer ou désactiver des modules"],
  ["settings.billing", "Configurer l'abonnement / la facturation SaaS"],
];

const DEFAULT_PERMISSION_KEYS = {
  admin: PERMISSIONS.map(([key]) => key),
  direction: PERMISSIONS.map(([key]) => key),
  hr: ["salary.view", "time.edit", "hr.access", "data.export"],
  manager: ["client.delete", "time.edit", "project.close", "project.acceptance", "notification.manage", "vehicle.manage", "data.export"],
  accounting: ["invoice.edit", "margin.view", "data.export"],
  employee: [],
  client: [],
};

const defaultModules = {
  dashboard: true,
  employees: true,
  time: true,
  planning: true,
  absences: true,
  projects: true,
  crm: true,
  quotes: true,
  invoices: true,
  payments: true,
  inventory: true,
  vehicles: true,
  tools: true,
  maintenance: true,
  documents: true,
  messaging: true,
  reports: true,
  clientPortal: true,
};

function clean(value, max = 500, optional = false) {
  if (optional && (value == null || String(value).trim() === "")) return "";
  const text = String(value ?? "").trim();
  if (!text || text.length > max) D.fail("Texte invalide.");
  return text;
}
function companiesFor(user) {
  if (user.company === "group" && D.privileged(user, ["admin", "direction"])) return null;
  return [...new Set((user.companies || [user.company]).filter((x) => x && x !== "group").map(String))];
}
function companyAllowed(user, company) {
  if (!company) return false;
  const allowed = companiesFor(user);
  return allowed == null || allowed.includes(String(company));
}
function active(rows) {
  return (rows || []).filter((row) => !row.deletedAt);
}
function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Zurich",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

async function ensureSchema(db) {
  if (schemaPromises.has(db)) return schemaPromises.get(db);
  const promise = (async () => {
    await db.query(`CREATE TABLE IF NOT EXISTS pro_trash(
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      company TEXT,
      label TEXT,
      snapshot JSONB NOT NULL,
      deleted_by INTEGER NOT NULL,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      purge_after TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
      restored_at TIMESTAMPTZ,
      restored_by INTEGER,
      purged_at TIMESTAMPTZ,
      purged_by INTEGER
    )`);
    await db.query("CREATE INDEX IF NOT EXISTS pro_trash_active_idx ON pro_trash(purged_at,restored_at,purge_after,deleted_at DESC)");
    await db.query(`CREATE TABLE IF NOT EXISTS pro_user_permissions(
      user_id INTEGER PRIMARY KEY,
      grants TEXT[] NOT NULL DEFAULT '{}',
      denials TEXT[] NOT NULL DEFAULT '{}',
      updated_by INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query("ALTER TABLE pro_user_permissions ADD COLUMN IF NOT EXISTS role_template_id TEXT");
    await db.query(`CREATE TABLE IF NOT EXISTS pro_role_templates(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      permissions TEXT[] NOT NULL DEFAULT '{}',
      modules JSONB NOT NULL DEFAULT '{}'::jsonb,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS pro_workspace_settings(
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK(id=1),
      tenant_key TEXT NOT NULL DEFAULT 'sousa-group',
      company_name TEXT NOT NULL DEFAULT 'Sousa Group One',
      logo_url TEXT NOT NULL DEFAULT '/assets/logos/group.png',
      primary_color TEXT NOT NULL DEFAULT '#111111',
      accent_color TEXT NOT NULL DEFAULT '#d4af37',
      modules JSONB NOT NULL DEFAULT '{}'::jsonb,
      billing JSONB NOT NULL DEFAULT '{}'::jsonb,
      white_label JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_by INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query(
      `INSERT INTO pro_workspace_settings(id,modules,billing,white_label)
       VALUES(1,$1,$2,$3)
       ON CONFLICT(id) DO NOTHING`,
      [
        JSON.stringify(defaultModules),
        JSON.stringify({ plan: "internal", status: "active", seats: null, renewsAt: null }),
        JSON.stringify({ customDomain: "", supportEmail: "", bankCoordinates: "", vatMode: "configurable" }),
      ],
    );
    await db.query(`CREATE TABLE IF NOT EXISTS pro_notification_preferences(
      user_id INTEGER PRIMARY KEY,
      categories JSONB NOT NULL DEFAULT '{}'::jsonb,
      quiet_hours JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS pro_project_acceptance(
      project_id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      client_id TEXT,
      signer_name TEXT NOT NULL,
      signature TEXT NOT NULL,
      notes TEXT,
      signed_by INTEGER,
      signed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS p1_project_milestones(
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
    await db.query(`CREATE TABLE IF NOT EXISTS p1_project_photo_meta(
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
    await db.query(`CREATE TABLE IF NOT EXISTS p2_appointments(
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      client_id TEXT NOT NULL,
      project_id TEXT,
      title TEXT NOT NULL,
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'requested',
      notes TEXT,
      created_by INTEGER NOT NULL,
      decided_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query(`INSERT INTO schema_migrations(version)
      VALUES('2026-09-27-pro-centre')
      ON CONFLICT(version) DO NOTHING`);
  })().catch((error) => {
    schemaPromises.delete(db);
    throw error;
  });
  schemaPromises.set(db, promise);
  return promise;
}

async function effectivePermissionKeys(db, user) {
  const base = new Set(DEFAULT_PERMISSION_KEYS[user.role] || []);
  const row = (await db.query("SELECT grants,denials FROM pro_user_permissions WHERE user_id=$1", [user.id])).rows[0];
  for (const key of row?.grants || []) base.add(String(key));
  for (const key of row?.denials || []) base.delete(String(key));
  return [...base];
}
async function hasPermission(db, user, key) {
  return (await effectivePermissionKeys(db, user)).includes(key);
}
async function requirePermission(db, user, key, message = "Permission requise.") {
  if (!(await hasPermission(db, user, key))) D.fail(message, 403);
}

async function stateContext(db, user) {
  const row = await loadState(db);
  return { row, data: row.data, view: D.viewState(row.data, user) };
}
async function withStateWrite(db, actorId, action, fn) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const row = await loadState(client, { forUpdate: true });
    const rawUser = (await client.query("SELECT * FROM users WHERE id=$1 AND disabled=false AND deleted_at IS NULL", [actorId])).rows[0];
    if (!rawUser) D.fail("Utilisateur indisponible.", 401);
    const user = D.effectiveUser(row.data, rawUser);
    const result = await fn(client, row.data, user);
    await client.query(
      "UPDATE app_state SET data=$1,revision=revision+1,updated_at=NOW(),updated_by=$2 WHERE id=1",
      [JSON.stringify(persistedState(result.data || row.data)), user.email],
    );
    await syncEntityMirror(client, result.data || row.data, result.changed || undefined);
    await client.query(
      "INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)",
      [user.email, action.slice(0, 100), JSON.stringify(result.audit || {})],
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function routes(db) {
  const router = express.Router();
  router.use(auth(db));
  router.use(wrap(async (req, res, next) => {
    await ensureSchema(db);
    next();
  }));

  router.get("/config", wrap(async (req, res) => {
    const row = (await db.query("SELECT company_name,logo_url,primary_color,accent_color,modules,white_label FROM pro_workspace_settings WHERE id=1")).rows[0];
    const role = (await db.query(
      `SELECT r.id,r.name,r.modules
       FROM pro_user_permissions p
       JOIN pro_role_templates r ON r.id=p.role_template_id AND r.active=true
       WHERE p.user_id=$1`,
      [req.user.id],
    )).rows[0];
    const workspaceModules = { ...defaultModules, ...(row.modules || {}) };
    const roleModules = role?.modules || {};
    const effectiveModules = Object.fromEntries(
      Object.entries(workspaceModules).map(([key, enabled]) => [
        key,
        enabled !== false && roleModules[key] !== false,
      ]),
    );
    res.json({
      companyName: row.company_name,
      logoUrl: row.logo_url,
      primaryColor: row.primary_color,
      accentColor: row.accent_color,
      modules: effectiveModules,
      supportEmail: row.white_label?.supportEmail || "",
      permissions: await effectivePermissionKeys(db, req.user),
      customRole: role ? { id: role.id, name: role.name } : null,
    });
  }));

  router.get("/status", wrap(async (req, res) => {
    const settings = (await db.query("SELECT * FROM pro_workspace_settings WHERE id=1")).rows[0];
    res.json({
      ready: true,
      capabilities: {
        centralProject: true,
        actionDashboard: true,
        globalSearch: true,
        activityCenter: true,
        trash30Days: true,
        granularPermissions: true,
        whiteLabel: true,
        moduleFlags: true,
        interventionPdf: true,
        multiCompany: true,
        profitabilityBreakdown: true,
        targetedNotifications: true,
        projectAcceptanceSignature: true,
      },
      settings: {
        tenantKey: settings.tenant_key,
        companyName: settings.company_name,
        modules: settings.modules,
      },
    });
  }));

  router.get("/dashboard", wrap(async (req, res) => {
    const { data, view } = await stateContext(db, req.user);
    const currentCompany = String(req.query.company || "");
    const scoped = (rows) => active(rows).filter((row) => !currentCompany || String(row.company || "") === currentCompany);
    const visibleEmployees = new Set(active(view.employees).map((x) => String(x.id)));
    const projects = scoped(view.projects);
    const times = scoped(view.time);
    const absences = active(view.absences);
    const invoices = scoped(view.invoices);
    const quotes = scoped(view.quotes);
    const inventory = scoped(view.inventory);
    const date = today();
    const workingNow = (data.clocks || []).filter((clock) => visibleEmployees.has(String(clock.employeeId)) && (!currentCompany || String(clock.company || data.projects?.find((p) => same(p.id, clock.project))?.company || "") === currentCompany));
    const activeProjects = projects.filter((p) => !["Terminé", "Payé", "Archivé"].includes(p.status));
    const overdueProjects = activeProjects.filter((p) => p.end && p.end < date);
    const pendingTime = times.filter((x) => x.status === "À valider");
    const pendingAbsences = absences.filter((x) => x.status === "En attente");
    const unpaid = invoices.filter((x) => Math.max(0, Number(x.amount || 0) - Number(x.paid || 0)) > 0 && x.status !== "Brouillon");
    const overdueInvoices = unpaid.filter((x) => x.due && x.due < date);
    const pendingQuotes = quotes.filter((x) => !["Accepté", "Refusé"].includes(x.status) && x.status !== "Brouillon");
    const lowStock = inventory.filter((x) => Number(x.min || 0) > 0 && Number(x.stock || 0) <= Number(x.min || 0));
    const appointments = (await db.query(
      "SELECT * FROM p2_appointments WHERE starts_at >= $1 AND starts_at < $2 ORDER BY starts_at",
      [new Date(`${date}T00:00:00+02:00`).toISOString(), new Date(`${date}T23:59:59+02:00`).toISOString()],
    )).rows.filter((x) => (x.status !== "cancelled") && companyAllowed(req.user, x.company) && (!currentCompany || x.company === currentCompany));
    const urgentWork = (await db.query(
      "SELECT id,company,project_id,title,status,priority,scheduled_at FROM work_orders WHERE status NOT IN ('completed','done','cancelled') AND priority='urgent' ORDER BY scheduled_at NULLS LAST,created_at DESC LIMIT 100",
    )).rows.filter((x) => companyAllowed(req.user, x.company) && (!currentCompany || x.company === currentCompany));
    const unread = Number((await db.query("SELECT COUNT(*)::int n FROM user_notifications WHERE user_id=$1 AND read_at IS NULL", [req.user.id])).rows[0]?.n || 0);
    const revenue = invoices.filter((x) => x.status !== "Brouillon").reduce((n, x) => n + Number(x.amount || 0), 0);
    const expenses = scoped(view.expenses).reduce((n, x) => n + Number(x.amount || 0), 0);
    const projectCost = projects.reduce((n, x) => n + Number(x.cost || 0), 0);
    const outstanding = unpaid.reduce((n, x) => n + Math.max(0, Number(x.amount || 0) - Number(x.paid || 0)), 0);
    const financeVisible = D.privileged(req.user, ["admin", "direction", "accounting"]) || await hasPermission(db, req.user, "margin.view");
    const projectFinance = financeVisible ? projects.map((project) => {
      const projectInvoices = invoices.filter((invoice) => same(invoice.project, project.id));
      const projectExpenses = scoped(view.expenses).filter((expense) => same(expense.project, project.id));
      const projectRevenue = projectInvoices.filter((invoice) => invoice.status !== "Brouillon").reduce((sum, invoice) => sum + Number(invoice.amount || 0), 0);
      const expenseTotal = projectExpenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
      const cost = Math.max(Number(project.cost || 0), expenseTotal);
      const projectOutstanding = projectInvoices.reduce((sum, invoice) => sum + Math.max(0, Number(invoice.amount || 0) - Number(invoice.paid || 0)), 0);
      const hours = times.filter((entry) => same(entry.project, project.id) && entry.status === "Validée").reduce((sum, entry) => sum + Number(entry.hours || 0), 0);
      return {
        id: project.id,
        title: project.title,
        company: project.company,
        revenue: money(projectRevenue),
        cost: money(cost),
        margin: money(projectRevenue - cost),
        outstanding: money(projectOutstanding),
        productiveHours: money(hours),
      };
    }).sort((a, b) => Math.abs(Number(b.revenue)) - Math.abs(Number(a.revenue))) : [];
    const companyIds = [...new Set(projects.map((project) => String(project.company || "")).filter(Boolean))];
    const companyFinance = financeVisible ? companyIds.map((companyId) => {
      const companyInvoices = invoices.filter((invoice) => String(invoice.company || "") === companyId);
      const companyExpenses = scoped(view.expenses).filter((expense) => String(expense.company || "") === companyId);
      const companyProjects = projects.filter((project) => String(project.company || "") === companyId);
      const companyTimes = times.filter((entry) => String(entry.company || "") === companyId && entry.status === "Validée");
      const companyRevenue = companyInvoices.filter((invoice) => invoice.status !== "Brouillon").reduce((sum, invoice) => sum + Number(invoice.amount || 0), 0);
      const companyExpenseTotal = companyExpenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
      const companyProjectCost = companyProjects.reduce((sum, project) => sum + Number(project.cost || 0), 0);
      return {
        company: companyId,
        revenue: money(companyRevenue),
        expenses: money(companyExpenseTotal),
        projectCost: money(companyProjectCost),
        margin: money(companyRevenue - Math.max(companyExpenseTotal, companyProjectCost)),
        outstanding: money(companyInvoices.reduce((sum, invoice) => sum + Math.max(0, Number(invoice.amount || 0) - Number(invoice.paid || 0)), 0)),
        productiveHours: money(companyTimes.reduce((sum, entry) => sum + Number(entry.hours || 0), 0)),
      };
    }) : [];
    res.json({
      at: new Date().toISOString(),
      company: currentCompany || null,
      actions: {
        workingNow: workingNow.length,
        activeProjects: activeProjects.length,
        overdueProjects: overdueProjects.length,
        pendingTime: pendingTime.length,
        pendingAbsences: pendingAbsences.length,
        appointmentsToday: appointments.length,
        overdueInvoices: overdueInvoices.length,
        pendingQuotes: pendingQuotes.length,
        lowStock: lowStock.length,
        urgentWork: urgentWork.length,
        unreadNotifications: unread,
      },
      lists: {
        overdueProjects: overdueProjects.slice(0, 20).map((x) => ({ id: x.id, title: x.title, end: x.end, status: x.status })),
        overdueInvoices: overdueInvoices.slice(0, 20).map((x) => ({ id: x.id, title: x.title, due: x.due, amount: x.amount, paid: x.paid || 0 })),
        lowStock: lowStock.slice(0, 20).map((x) => ({ id: x.id, name: x.name, stock: x.stock, min: x.min })),
        urgentWork: urgentWork.slice(0, 20),
      },
      finance: financeVisible ? {
        revenue: money(revenue),
        expenses: money(expenses),
        projectCost: money(projectCost),
        margin: money(revenue - Math.max(expenses, projectCost)),
        outstanding: money(outstanding),
        productiveHours: times.filter((x) => x.status === "Validée").reduce((n, x) => n + Number(x.hours || 0), 0),
        byCompany: companyFinance,
        byProject: projectFinance.slice(0, 30),
      } : null,
    });
  }));

  router.get("/project/:id", wrap(async (req, res) => {
    const { view } = await stateContext(db, req.user);
    const project = active(view.projects).find((x) => same(x.id, req.params.id));
    if (!project) D.fail("Chantier inaccessible.", 404);
    const pid = String(project.id);
    const client = active(view.clients).find((x) => same(x.id, project.clientId)) || null;
    const company = active(view.companies).find((x) => same(x.id, project.company)) || null;
    const planning = active(view.planning).filter((x) => same(x.project, pid));
    const time = active(view.time).filter((x) => same(x.project, pid));
    const expenses = active(view.expenses).filter((x) => same(x.project, pid));
    const documents = active(view.documents).filter((x) => same(x.project, pid));
    const quotes = active(view.quotes).filter((x) => same(x.project, pid) || same(x.id, project.quoteId));
    const invoices = active(view.invoices).filter((x) => same(x.project, pid) || (project.invoiceIds || []).some((id) => same(id, x.id)));
    const invoiceIds = new Set(invoices.map((x) => String(x.id)));
    const payments = active(view.payments).filter((x) => invoiceIds.has(String(x.invoice || x.invoiceId)));
    const [tasks, milestones, checklist, reports, punch, changes, photoMeta, movements, workOrders, appointments, events] = await Promise.all([
      db.query("SELECT * FROM project_tasks WHERE project_id=$1 ORDER BY position,created_at", [pid]),
      db.query("SELECT * FROM p1_project_milestones WHERE project_id=$1 ORDER BY due_date NULLS LAST,created_at", [pid]),
      db.query("SELECT * FROM project_checklist_items WHERE project_id=$1 ORDER BY created_at", [pid]),
      db.query("SELECT * FROM project_daily_reports WHERE project_id=$1 ORDER BY report_date DESC,created_at DESC", [pid]),
      db.query("SELECT * FROM project_punch_items WHERE project_id=$1 ORDER BY created_at DESC", [pid]),
      db.query("SELECT * FROM project_change_orders WHERE project_id=$1 ORDER BY created_at DESC", [pid]),
      db.query("SELECT * FROM p1_project_photo_meta WHERE project_id=$1 ORDER BY created_at DESC", [pid]),
      db.query("SELECT * FROM inventory_movements WHERE project_id=$1 ORDER BY created_at DESC LIMIT 500", [pid]),
      db.query("SELECT * FROM work_orders WHERE project_id=$1 ORDER BY scheduled_at DESC NULLS LAST,created_at DESC", [pid]),
      db.query("SELECT * FROM p2_appointments WHERE project_id=$1 ORDER BY starts_at DESC", [pid]),
      db.query("SELECT id,event_type,entity_type,entity_id,payload,created_at FROM app_events WHERE project_id=$1 ORDER BY created_at DESC LIMIT 300", [pid]),
    ]);
    const team = (project.team || []).map((id) => active(view.employees).find((x) => same(x.id, id))).filter(Boolean);
    const materialCost = movements.rows.filter((x) => Number(x.quantity || 0) > 0).reduce((sum, movement) => {
      const item = active(view.inventory).find((x) => same(x.id, movement.inventory_id));
      return sum + Math.abs(Number(movement.quantity || 0)) * Number(item?.buy || 0);
    }, 0);
    const expenseCost = expenses.reduce((sum, x) => sum + Number(x.amount || 0), 0);
    const recordedCost = Number(project.cost || 0);
    const realCost = Math.max(recordedCost, expenseCost + materialCost);
    const invoiced = invoices.filter((x) => x.status !== "Brouillon").reduce((sum, x) => sum + Number(x.amount || 0), 0);
    const acceptedChangeOrders = changes.rows.filter((x) => ["approved", "accepted"].includes(String(x.status).toLowerCase())).reduce((sum, x) => sum + Number(x.amount || 0), 0);
    const marginVisible = D.privileged(req.user, ["admin", "direction", "accounting"]) || await hasPermission(db, req.user, "margin.view");
    const thread = (view.messageThreads || []).find((x) => same(x.projectId, pid)) || null;
    const acceptance = (await db.query(
      "SELECT project_id,company,client_id,signer_name,signature,notes,signed_by,signed_at,updated_at FROM pro_project_acceptance WHERE project_id=$1",
      [pid],
    )).rows[0] || null;
    res.json({
      project,
      client,
      company,
      team,
      planning,
      time,
      expenses,
      documents,
      quotes,
      invoices,
      payments,
      tasks: tasks.rows,
      milestones: milestones.rows,
      checklist: checklist.rows,
      reports: reports.rows,
      punch: punch.rows,
      changeOrders: changes.rows,
      photoMeta: photoMeta.rows,
      materialMovements: movements.rows,
      workOrders: workOrders.rows,
      appointments: appointments.rows,
      conversation: thread,
      acceptance,
      history: events.rows,
      finance: marginVisible ? {
        budget: money(project.budget),
        invoiced: money(invoiced),
        acceptedChangeOrders: money(acceptedChangeOrders),
        realCost: money(realCost),
        margin: money(invoiced + acceptedChangeOrders - realCost),
        paid: money(payments.reduce((sum, x) => sum + Number(x.amount || 0), 0)),
      } : null,
    });
  }));

  router.get("/search", wrap(async (req, res) => {
    const query = String(req.query.q || "").trim().toLowerCase();
    if (query.length < 2) return res.json({ results: [] });
    const { view } = await stateContext(db, req.user);
    const currentCompany = String(req.query.company || "");
    const results = [];
    const add = (type, row, title, subtitle, page, extra = {}) => {
      if (!row || row.deletedAt || (currentCompany && row.company && String(row.company) !== currentCompany)) return;
      const hay = [row.id, title, subtitle, row.address, row.street, row.zip, row.city, row.country, row.email, row.phone, row.description, row.notes, row.source, row.next_action, row.status].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(query)) return;
      results.push({ type, id: String(row.id), title: String(title || row.id), subtitle: String(subtitle || ""), page, company: row.company || null, ...extra });
    };
    for (const row of active(view.clients)) add("client", row, row.name, [row.city, row.email].filter(Boolean).join(" · "), "clients");
    for (const row of active(view.projects)) add("project", row, row.title, `${row.id} · ${row.address || ""}`, "projects", { projectId: row.id });
    for (const row of active(view.employees)) add("employee", row, row.name, row.job || "Salarié", "employees");
    for (const row of active(view.quotes)) add("quote", row, row.id, `${row.title || "Devis"} · ${row.status || ""}`, "quotes");
    for (const row of active(view.invoices)) add("invoice", row, row.id, `${row.title || "Facture"} · ${row.status || ""}`, "invoices");
    for (const row of active(view.documents)) add("document", row, row.name, row.category || "Document", "documents");
    for (const row of active(view.vehicles)) add("vehicle", row, row.plate || row.id, [row.brand, row.model].filter(Boolean).join(" "), "vehicles");
    for (const row of active(view.inventory)) add("inventory", row, row.name, row.sku || "Matériel", "inventory");
    const crm = (await db.query("SELECT id,company,client_id,name,email,phone,street,zip,city,country,stage,value,next_action,source,notes FROM crm_opportunities ORDER BY updated_at DESC LIMIT 1000")).rows;
    for (const row of crm.filter((x) => companyAllowed(req.user, x.company))) add("crm", row, row.name, `${row.stage} · ${row.next_action || row.source || ""}`, "advanced");
    const messageMatches = active(view.messages).filter((x) => String(x.text || "").toLowerCase().includes(query)).slice(-30);
    for (const row of messageMatches) results.push({ type: "message", id: String(row.id), title: String(row.text || "Message").slice(0, 90), subtitle: "Message", page: "messages", conversationKey: row.threadId ? `thread:${row.threadId}` : `direct:${same(row.senderId, req.user.id) ? row.recipientId : row.senderId}` });
    res.json({ results: results.slice(0, 80) });
  }));

  router.post("/crm/:id/convert", wrap(async (req, res) => {
    const result = await withStateWrite(db, req.user.id, "crm.convert", async (client, data, user) => {
      const opportunity = (
        await client.query("SELECT * FROM crm_opportunities WHERE id=$1 FOR UPDATE", [String(req.params.id)])
      ).rows[0];
      if (!opportunity || !companyAllowed(user, opportunity.company))
        D.fail("Opportunité inaccessible.", 404);
      let working = data,
        clientRecord = opportunity.client_id
          ? (working.clients || []).find((x) => same(x.id, opportunity.client_id) && !x.deletedAt)
          : null;
      if (!clientRecord) {
        if (!opportunity.email || !opportunity.city)
          D.fail("Complétez au minimum l’e-mail et la ville du prospect avant conversion.");
        const created = D.applyCommand(
          working,
          user,
          {
            action: "create",
            collection: "clients",
            payload: {
              company: opportunity.company,
              name: opportunity.name,
              email: opportunity.email,
              phone: opportunity.phone || "",
              street: opportunity.street || "",
              buildingNumber: "",
              zip: opportunity.zip || "",
              city: opportunity.city,
              country: opportunity.country || "CH",
              type: "Prospect CRM",
            },
          },
          new Date().toISOString(),
        );
        working = created.data;
        clientRecord = created.result;
      }
      const now = new Date(),
        date = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Europe/Zurich",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(now),
        validDate = new Date(date + "T12:00:00Z");
      validDate.setUTCDate(validDate.getUTCDate() + 30);
      const quoteCreated = D.applyCommand(
        working,
        user,
        {
          action: "create",
          collection: "quotes",
          payload: {
            company: opportunity.company,
            clientId: clientRecord.id,
            title: "Offre – " + opportunity.name,
            lines: [{
              description: "Prestations à compléter",
              details: opportunity.notes || "",
              quantity: "1",
              unitPrice: "0",
              unit: "forfait",
              vatRate: "0",
              discount: "0",
            }],
            language: "fr",
            message: "",
            terms: "",
            scope: opportunity.notes || "",
            exclusions: "",
            paymentNote: "",
            depositPercent: 0,
            signature: true,
            date,
            valid: validDate.toISOString().slice(0, 10),
          },
        },
        now.toISOString(),
        true,
      );
      working = quoteCreated.data;
      quoteCreated.result.pricingRequired = true;
      await client.query(
        `UPDATE crm_opportunities SET client_id=$1,stage='proposal',
         next_action=$2,updated_at=NOW() WHERE id=$3`,
        [
          clientRecord.id,
          "Compléter et envoyer le devis " + quoteCreated.result.id,
          opportunity.id,
        ],
      );
      await client.query(
        `INSERT INTO app_events(event_type,actor_user_id,company,entity_type,entity_id,payload)
         VALUES('crm.converted',$1,$2,'crm',$3,$4)`,
        [
          user.id,
          opportunity.company,
          opportunity.id,
          JSON.stringify({ clientId: clientRecord.id, quoteId: quoteCreated.result.id }),
        ],
      );
      return {
        data: working,
        changed: ["clients", "quotes"],
        result: { clientId: clientRecord.id, quoteId: quoteCreated.result.id },
        audit: { opportunityId: opportunity.id, clientId: clientRecord.id, quoteId: quoteCreated.result.id },
      };
    });
    res.json({ ok: true, ...result.result });
  }));

  router.get("/activity", wrap(async (req, res) => {
    const after = Math.max(0, Number(req.query.after) || 0);
    const allowed = companiesFor(req.user);
    const params = [after];
    let scopeSql = "";
    if (allowed) {
      params.push(allowed);
      scopeSql = " AND (company IS NULL OR company=ANY($2::text[]))";
    }
    const events = (await db.query(
      `SELECT id,event_type,company,project_id,entity_type,entity_id,payload,created_at
       FROM app_events WHERE id>$1${scopeSql} ORDER BY id DESC LIMIT 200`, params,
    )).rows;
    const notifications = (await db.query(
      "SELECT id,category,title,body,url,read_at,created_at FROM user_notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200",
      [req.user.id],
    )).rows;
    res.json({ events, notifications });
  }));

  router.post("/notifications/read", wrap(async (req, res) => {
    if (req.body?.all) {
      await db.query("UPDATE user_notifications SET read_at=COALESCE(read_at,NOW()) WHERE user_id=$1", [req.user.id]);
    } else if (req.body?.id) {
      await db.query("UPDATE user_notifications SET read_at=COALESCE(read_at,NOW()) WHERE user_id=$1 AND id=$2", [req.user.id, String(req.body.id)]);
    } else D.fail("Notification requise.");
    res.json({ ok: true });
  }));

  router.get("/notification-preferences", wrap(async (req, res) => {
    const defaults = {
      messages: true,
      planning: true,
      projects: true,
      finance: true,
      crm: true,
      stock: true,
      maintenance: true,
      hr: true,
      system: true,
    };
    const row = (await db.query(
      "SELECT categories,quiet_hours,updated_at FROM pro_notification_preferences WHERE user_id=$1",
      [req.user.id],
    )).rows[0];
    res.json({
      categories: { ...defaults, ...(row?.categories || {}) },
      quietHours: row?.quiet_hours || { enabled: false, start: "21:00", end: "07:00" },
      updatedAt: row?.updated_at || null,
    });
  }));

  router.post("/notification-preferences", wrap(async (req, res) => {
    await requirePermission(db, req.user, "notification.manage", "Configuration des notifications non autorisée.");
    const allowedKeys = ["messages", "planning", "projects", "finance", "crm", "stock", "maintenance", "hr", "system"];
    const categories = Object.fromEntries(allowedKeys.map((key) => [key, req.body?.categories?.[key] !== false]));
    const quiet = req.body?.quietHours && typeof req.body.quietHours === "object" ? req.body.quietHours : {};
    const start = /^\d{2}:\d{2}$/.test(String(quiet.start || "")) ? String(quiet.start) : "21:00";
    const end = /^\d{2}:\d{2}$/.test(String(quiet.end || "")) ? String(quiet.end) : "07:00";
    const quietHours = { enabled: quiet.enabled === true, start, end };
    await db.query(
      `INSERT INTO pro_notification_preferences(user_id,categories,quiet_hours)
       VALUES($1,$2,$3)
       ON CONFLICT(user_id) DO UPDATE SET categories=EXCLUDED.categories,quiet_hours=EXCLUDED.quiet_hours,updated_at=NOW()`,
      [req.user.id, JSON.stringify(categories), JSON.stringify(quietHours)],
    );
    res.json({ ok: true, categories, quietHours });
  }));

  router.get("/trash", wrap(async (req, res) => {
    if (!D.privileged(req.user, ["admin", "direction", "hr", "manager", "accounting"])) D.fail("Accès équipe requis.", 403);
    const allowed = companiesFor(req.user);
    const rows = (await db.query(
      `SELECT id,entity_type,entity_id,company,label,deleted_at,purge_after,deleted_by
       FROM pro_trash WHERE restored_at IS NULL AND purged_at IS NULL ORDER BY deleted_at DESC LIMIT 500`,
    )).rows.filter((x) => !allowed || !x.company || allowed.includes(String(x.company)));
    res.json({ items: rows });
  }));

  router.post("/trash", wrap(async (req, res) => {
    const kind = String(req.body?.kind || "");
    const id = String(req.body?.id || "");
    if (!TRASHABLE.has(kind) || !id) D.fail("Élément non pris en charge par la corbeille.");
    if (kind === "clients") await requirePermission(db, req.user, "client.delete", "Suppression de client non autorisée.");
    if (kind === "quotes" || kind === "invoices") await requirePermission(db, req.user, "invoice.edit", "Accès finance requis.");
    const result = await withStateWrite(db, req.user.id, `${kind}.trash`, async (client, data, user) => {
      const collection = data[kind] || [];
      const record = collection.find((x) => same(x.id, id));
      if (!record || record.deletedAt) D.fail("Élément introuvable.", 404);
      const visible = D.viewState(data, user)[kind] || [];
      if (!visible.some((x) => same(x.id, id))) D.fail("Accès refusé.", 403);
      if (record.company && !companyAllowed(user, record.company)) D.fail("Entreprise non autorisée.", 403);
      const deletedAt = new Date().toISOString();
      record.deletedAt = deletedAt;
      record.deletedBy = user.id;
      const trashId = randomUUID();
      const label = String(record.name || record.title || record.plate || record.id || id).slice(0, 250);
      await client.query(
        `INSERT INTO pro_trash(id,entity_type,entity_id,company,label,snapshot,deleted_by,deleted_at,purge_after)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [trashId, kind, id, record.company || null, label, JSON.stringify(record), user.id, deletedAt, new Date(Date.now() + 30 * 86400000).toISOString()],
      );
      return { data, changed: [kind], result: { trashId, id, kind }, audit: { kind, id, trashId } };
    });
    res.json({ ok: true, ...result.result });
  }));

  router.post("/trash/:id/restore", wrap(async (req, res) => {
    await requirePermission(db, req.user, "trash.restore", "Restauration non autorisée.");
    const result = await withStateWrite(db, req.user.id, "trash.restore", async (client, data, user) => {
      const trash = (await client.query("SELECT * FROM pro_trash WHERE id=$1 AND restored_at IS NULL AND purged_at IS NULL FOR UPDATE", [String(req.params.id)])).rows[0];
      if (!trash) D.fail("Élément de corbeille introuvable.", 404);
      if (trash.company && !companyAllowed(user, trash.company)) D.fail("Entreprise non autorisée.", 403);
      const collection = data[trash.entity_type];
      if (!Array.isArray(collection)) D.fail("Collection invalide.");
      let record = collection.find((x) => same(x.id, trash.entity_id));
      if (record) {
        delete record.deletedAt;
        delete record.deletedBy;
      } else {
        record = { ...trash.snapshot };
        delete record.deletedAt;
        delete record.deletedBy;
        collection.push(record);
      }
      await client.query("UPDATE pro_trash SET restored_at=NOW(),restored_by=$1 WHERE id=$2", [user.id, trash.id]);
      return { data, changed: [trash.entity_type], result: { id: trash.entity_id, kind: trash.entity_type }, audit: { trashId: trash.id, kind: trash.entity_type, id: trash.entity_id } };
    });
    res.json({ ok: true, ...result.result });
  }));

  router.delete("/trash/:id", wrap(async (req, res) => {
    if (!D.privileged(req.user, ["admin", "direction"])) D.fail("Accès direction requis.", 403);
    const result = await withStateWrite(db, req.user.id, "trash.purge", async (client, data, user) => {
      const trash = (await client.query("SELECT * FROM pro_trash WHERE id=$1 AND restored_at IS NULL AND purged_at IS NULL FOR UPDATE", [String(req.params.id)])).rows[0];
      if (!trash) D.fail("Élément de corbeille introuvable.", 404);
      if (trash.company && !companyAllowed(user, trash.company)) D.fail("Entreprise non autorisée.", 403);
      const collection = data[trash.entity_type];
      if (Array.isArray(collection)) data[trash.entity_type] = collection.filter((x) => !same(x.id, trash.entity_id));
      await client.query("UPDATE pro_trash SET purged_at=NOW(),purged_by=$1 WHERE id=$2", [user.id, trash.id]);
      return { data, changed: [trash.entity_type], result: { id: trash.entity_id, kind: trash.entity_type }, audit: { trashId: trash.id, kind: trash.entity_type, id: trash.entity_id } };
    });
    res.json({ ok: true, ...result.result });
  }));

  router.get("/permissions", wrap(async (req, res) => {
    if (!D.privileged(req.user, ["admin", "direction"])) D.fail("Accès direction requis.", 403);
    const users = (await db.query(
      `SELECT u.id,u.name,u.email,u.role,u.company,
        COALESCE(p.grants,'{}') grants,COALESCE(p.denials,'{}') denials,p.role_template_id
       FROM users u LEFT JOIN pro_user_permissions p ON p.user_id=u.id
       WHERE u.deleted_at IS NULL ORDER BY u.name`,
    )).rows;
    res.json({ catalog: PERMISSIONS.map(([key, label]) => ({ key, label })), users });
  }));

  router.post("/permissions/:userId", wrap(async (req, res) => {
    if (!D.privileged(req.user, ["admin", "direction"])) D.fail("Accès direction requis.", 403);
    const userId = Number(req.params.userId);
    const valid = new Set(PERMISSIONS.map(([key]) => key));
    const grants = [...new Set((Array.isArray(req.body?.grants) ? req.body.grants : []).map(String).filter((x) => valid.has(x)))];
    const denials = [...new Set((Array.isArray(req.body?.denials) ? req.body.denials : []).map(String).filter((x) => valid.has(x)))];
    if (!Number.isInteger(userId) || userId <= 0) D.fail("Utilisateur invalide.");
    const target = (await db.query("SELECT id,company FROM users WHERE id=$1 AND deleted_at IS NULL", [userId])).rows[0];
    if (!target) D.fail("Utilisateur introuvable.", 404);
    if (target.company !== "group" && !companyAllowed(req.user, target.company)) D.fail("Utilisateur hors périmètre.", 403);
    await db.query(
      `INSERT INTO pro_user_permissions(user_id,grants,denials,role_template_id,updated_by)
       VALUES($1,$2,$3,NULL,$4)
       ON CONFLICT(user_id) DO UPDATE SET grants=EXCLUDED.grants,denials=EXCLUDED.denials,role_template_id=NULL,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
      [userId, grants, denials, req.user.id],
    );
    res.json({ ok: true, userId, grants, denials });
  }));

  router.get("/roles", wrap(async (req, res) => {
    if (!D.privileged(req.user, ["admin", "direction"])) D.fail("Accès direction requis.", 403);
    const roles = (await db.query(
      "SELECT id,name,description,permissions,modules,active,created_at,updated_at FROM pro_role_templates WHERE active=true ORDER BY name",
    )).rows;
    res.json({
      roles,
      catalog: PERMISSIONS.map(([key, label]) => ({ key, label })),
      modules: defaultModules,
    });
  }));

  router.post("/roles", wrap(async (req, res) => {
    await requirePermission(db, req.user, "settings.modules", "Gestion des rôles personnalisés non autorisée.");
    const body = req.body || {},
      id = body.id ? clean(String(body.id), 120) : "role-" + randomUUID(),
      name = clean(body.name, 120),
      description = clean(body.description, 1000, true) || null,
      validPermissions = new Set(PERMISSIONS.map(([key]) => key)),
      permissions = [...new Set((Array.isArray(body.permissions) ? body.permissions : []).map(String).filter((key) => validPermissions.has(key)))],
      requestedModules = body.modules && typeof body.modules === "object" ? body.modules : {},
      modules = Object.fromEntries(Object.keys(defaultModules).map((key) => [key, requestedModules[key] !== false]));
    await db.query(
      `INSERT INTO pro_role_templates(id,name,description,permissions,modules,created_by,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$6)
       ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,
       permissions=EXCLUDED.permissions,modules=EXCLUDED.modules,active=true,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
      [id, name, description, permissions, JSON.stringify(modules), req.user.id],
    );
    const assigned = (await db.query(
      `SELECT u.id,u.role
       FROM users u JOIN pro_user_permissions p ON p.user_id=u.id
       WHERE p.role_template_id=$1 AND u.deleted_at IS NULL`,
      [id],
    )).rows;
    const desired = new Set(permissions);
    for (const user of assigned) {
      const base = new Set(DEFAULT_PERMISSION_KEYS[user.role] || []),
        grants = [...desired].filter((key) => !base.has(key)),
        denials = [...base].filter((key) => !desired.has(key));
      await db.query(
        "UPDATE pro_user_permissions SET grants=$1,denials=$2,updated_by=$3,updated_at=NOW() WHERE user_id=$4",
        [grants, denials, req.user.id, user.id],
      );
    }
    res.json({ ok: true, id, name, assignedUpdated: assigned.length });
  }));

  router.post("/roles/:id/apply/:userId", wrap(async (req, res) => {
    await requirePermission(db, req.user, "settings.modules", "Affectation de rôle non autorisée.");
    const role = (await db.query(
      "SELECT id,name,permissions FROM pro_role_templates WHERE id=$1 AND active=true",
      [String(req.params.id)],
    )).rows[0];
    if (!role) D.fail("Rôle personnalisé introuvable.", 404);
    const userId = Number(req.params.userId),
      target = (await db.query(
        "SELECT id,role,company FROM users WHERE id=$1 AND deleted_at IS NULL",
        [userId],
      )).rows[0];
    if (!target) D.fail("Utilisateur introuvable.", 404);
    if (target.company !== "group" && !companyAllowed(req.user, target.company))
      D.fail("Utilisateur hors périmètre.", 403);
    const base = new Set(DEFAULT_PERMISSION_KEYS[target.role] || []),
      desired = new Set(role.permissions || []),
      grants = [...desired].filter((key) => !base.has(key)),
      denials = [...base].filter((key) => !desired.has(key));
    await db.query(
      `INSERT INTO pro_user_permissions(user_id,grants,denials,role_template_id,updated_by)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(user_id) DO UPDATE SET grants=EXCLUDED.grants,denials=EXCLUDED.denials,
       role_template_id=EXCLUDED.role_template_id,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
      [userId, grants, denials, role.id, req.user.id],
    );
    res.json({ ok: true, userId, role: { id: role.id, name: role.name }, grants, denials });
  }));

  router.post("/roles/:id/archive", wrap(async (req, res) => {
    await requirePermission(db, req.user, "settings.modules", "Archivage de rôle non autorisé.");
    const id = String(req.params.id);
    const assigned = Number((await db.query(
      "SELECT COUNT(*)::int n FROM pro_user_permissions WHERE role_template_id=$1",
      [id],
    )).rows[0]?.n || 0);
    if (assigned) D.fail("Ce rôle est encore affecté à un ou plusieurs utilisateurs.");
    const result = await db.query(
      "UPDATE pro_role_templates SET active=false,updated_by=$1,updated_at=NOW() WHERE id=$2 AND active=true RETURNING id",
      [req.user.id, id],
    );
    if (!result.rows.length) D.fail("Rôle personnalisé introuvable.", 404);
    res.json({ ok: true, id });
  }));

  router.get("/settings", wrap(async (req, res) => {
    if (!D.privileged(req.user, ["admin", "direction"])) D.fail("Accès direction requis.", 403);
    const row = (await db.query("SELECT * FROM pro_workspace_settings WHERE id=1")).rows[0];
    res.json({
      tenantKey: row.tenant_key,
      companyName: row.company_name,
      logoUrl: row.logo_url,
      primaryColor: row.primary_color,
      accentColor: row.accent_color,
      modules: { ...defaultModules, ...(row.modules || {}) },
      billing: row.billing || {},
      whiteLabel: row.white_label || {},
      isolation: "database-per-customer",
      commercialReadiness: {
        workspaceConfiguration: true,
        customRoles: true,
        databaseIsolation: process.env.TENANT_DATABASE_ISOLATION_CONFIRMED === "true",
        storageIsolation:
          require("./storage").available() &&
          process.env.TENANT_STORAGE_ISOLATION_CONFIRMED === "true",
        subscriptionBilling:
          process.env.SUBSCRIPTION_BILLING_CONFIRMED === "true",
      },
    });
  }));

  router.get("/tenant-manifest", wrap(async (req, res) => {
    if (!D.privileged(req.user, ["admin", "direction"])) D.fail("Accès direction requis.", 403);
    const settings = (await db.query("SELECT * FROM pro_workspace_settings WHERE id=1")).rows[0],
      roles = (await db.query(
        "SELECT id,name,description,permissions,modules FROM pro_role_templates WHERE active=true ORDER BY name",
      )).rows;
    res.set("Cache-Control", "private, no-store").json({
      version: 1,
      generatedAt: new Date().toISOString(),
      tenant: {
        key: settings.tenant_key,
        companyName: settings.company_name,
        logoUrl: settings.logo_url,
        primaryColor: settings.primary_color,
        accentColor: settings.accent_color,
        modules: { ...defaultModules, ...(settings.modules || {}) },
        billing: settings.billing || {},
        whiteLabel: settings.white_label || {},
        roles,
      },
      deploymentRequirements: {
        architecture: "database-per-customer",
        databaseIsolationConfirmed:
          process.env.TENANT_DATABASE_ISOLATION_CONFIRMED === "true",
        objectStorageConfigured: require("./storage").available(),
        storageIsolationConfirmed:
          process.env.TENANT_STORAGE_ISOLATION_CONFIRMED === "true",
        subscriptionBillingConfirmed:
          process.env.SUBSCRIPTION_BILLING_CONFIRMED === "true",
        requiredProductionControls: [
          "Base PostgreSQL dédiée au client",
          "Préfixe ou bucket de stockage objet dédié au client",
          "Sauvegardes et restauration testées",
          "Domaine et HTTPS du client",
          "Fournisseur d'abonnement connecté avant facturation automatique",
        ],
      },
    });
  }));

  router.post("/settings", wrap(async (req, res) => {
    await requirePermission(db, req.user, "settings.branding", "Configuration white-label non autorisée.");
    const current = (await db.query("SELECT * FROM pro_workspace_settings WHERE id=1")).rows[0];
    const body = req.body || {};
    const modules = body.modules && typeof body.modules === "object" ? { ...defaultModules, ...body.modules } : { ...defaultModules, ...(current.modules || {}) };
    const safeModules = Object.fromEntries(Object.entries(defaultModules).map(([key]) => [key, modules[key] !== false]));
    const billing = body.billing && typeof body.billing === "object" ? {
      plan: String(body.billing.plan || current.billing?.plan || "internal").slice(0, 80),
      status: String(body.billing.status || current.billing?.status || "active").slice(0, 40),
      seats: body.billing.seats == null || body.billing.seats === "" ? null : Math.max(1, Math.min(100000, Number(body.billing.seats) || 1)),
      renewsAt: body.billing.renewsAt || null,
    } : current.billing;
    const whiteLabel = body.whiteLabel && typeof body.whiteLabel === "object" ? {
      customDomain: String(body.whiteLabel.customDomain || "").slice(0, 255),
      supportEmail: String(body.whiteLabel.supportEmail || "").slice(0, 255),
      bankCoordinates: String(body.whiteLabel.bankCoordinates || "").slice(0, 1000),
      vatMode: String(body.whiteLabel.vatMode || "configurable").slice(0, 80),
    } : current.white_label;
    await db.query(
      `UPDATE pro_workspace_settings SET tenant_key=$1,company_name=$2,logo_url=$3,primary_color=$4,accent_color=$5,
       modules=$6,billing=$7,white_label=$8,updated_by=$9,updated_at=NOW() WHERE id=1`,
      [
        clean(String(body.tenantKey || current.tenant_key), 120),
        clean(String(body.companyName || current.company_name), 200),
        clean(String(body.logoUrl || current.logo_url), 500),
        String(body.primaryColor || current.primary_color).slice(0, 30),
        String(body.accentColor || current.accent_color).slice(0, 30),
        JSON.stringify(safeModules),
        JSON.stringify(billing),
        JSON.stringify(whiteLabel),
        req.user.id,
      ],
    );
    res.json({ ok: true });
  }));

  router.post("/planning/bulk", wrap(async (req, res) => {
    await requirePermission(db, req.user, "time.edit", "Modification du planning non autorisée.");
    const body = req.body || {},
      employeeIds = [...new Set((Array.isArray(body.employeeIds) ? body.employeeIds : []).map(String).filter(Boolean))],
      toolIds = [...new Set((Array.isArray(body.toolIds) ? body.toolIds : []).map(String).filter(Boolean))];
    if (!employeeIds.length || employeeIds.length > 30) D.fail("Sélectionnez entre 1 et 30 salariés.");
    const result = await withStateWrite(db, req.user.id, "planning.bulk", async (client, data, user) => {
      let working = data;
      const project = (working.projects || []).find((x) => same(x.id, body.projectId) && !x.deletedAt);
      if (!project || !D.canProject(working, user, project)) D.fail("Chantier inaccessible.", 403);
      const date = D.iso(String(body.date || "")),
        start = String(body.start || ""),
        end = String(body.end || ""),
        vehicleId = body.vehicleId ? String(body.vehicleId) : "";
      if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || end <= start)
        D.fail("Horaires invalides.");
      const employees = employeeIds.map((id) => (working.employees || []).find((x) => same(x.id, id) && !x.deletedAt));
      if (employees.some((x) => !x || !D.employeeInCompany(x, project.company)))
        D.fail("Un salarié sélectionné ne correspond pas à l’entreprise du chantier.");
      const vehicle = vehicleId ? (working.vehicles || []).find((x) => same(x.id, vehicleId) && !x.deletedAt) : null;
      if (vehicleId && (!vehicle || String(vehicle.company) !== String(project.company)))
        D.fail("Véhicule incompatible avec ce chantier.");
      const tools = toolIds.map((id) => (working.tools || []).find((x) => same(x.id, id) && !x.deletedAt));
      if (tools.some((x) => !x || String(x.company) !== String(project.company)))
        D.fail("Un équipement sélectionné ne correspond pas à l’entreprise du chantier.");
      const overlaps = (row) => !row.deletedAt && row.date === date && row.start < end && row.end > start;
      if (vehicleId && (working.planning || []).some((row) => overlaps(row) && same(row.vehicleId, vehicleId)))
        D.fail("Ce véhicule est déjà affecté sur ce créneau.", 409);
      for (const toolId of toolIds)
        if ((working.planning || []).some((row) => overlaps(row) && (row.toolIds || []).some((id) => same(id, toolId))))
          D.fail("Un équipement est déjà affecté sur ce créneau.", 409);
      const created = [];
      for (const employee of employees) {
        const out = D.applyCommand(
          working,
          user,
          {
            action: "create",
            collection: "planning",
            payload: {
              employeeId: employee.id,
              project: project.id,
              date,
              start,
              end,
              location: body.location || project.address || "",
            },
          },
          new Date().toISOString(),
        );
        working = out.data;
        out.result.vehicleId = vehicleId;
        out.result.toolIds = toolIds;
        created.push(out.result);
      }
      const users = employeeIds.length
        ? (await client.query(
            "SELECT id,employee_id FROM users WHERE employee_id=ANY($1::text[]) AND disabled=false AND deleted_at IS NULL",
            [employeeIds],
          )).rows
        : [];
      for (const account of users) {
        await client.query(
          `INSERT INTO user_notifications(id,user_id,category,title,body,url,entity_type,entity_id)
           VALUES($1,$2,'planning','Planning modifié',$3,$4,'project',$5)`,
          [
            randomUUID(),
            account.id,
            `${date} · ${start}–${end} · ${project.title}`,
            "/?page=planning",
            project.id,
          ],
        );
      }
      return {
        data: working,
        changed: ["planning", "projects"],
        result: { created, projectId: project.id },
        audit: { projectId: project.id, employeeIds, vehicleId, toolIds, date, start, end },
      };
    });
    res.json({ ok: true, ...result.result });
  }));

  router.post("/planning/:id/move", wrap(async (req, res) => {
    await requirePermission(db, req.user, "time.edit", "Modification du planning non autorisée.");
    const result = await withStateWrite(db, req.user.id, "planning.move", async (_client, data, user) => {
      const row = (data.planning || []).find((x) => same(x.id, req.params.id) && !x.deletedAt);
      if (!row) D.fail("Affectation introuvable.", 404);
      const employee = (data.employees || []).find((x) => same(x.id, req.body?.employeeId || row.employeeId) && !x.deletedAt);
      const project = (data.projects || []).find((x) => same(x.id, req.body?.projectId || row.project) && !x.deletedAt);
      if (!employee || !project || !D.canProject(data, user, project) || !D.employeeInCompany(employee, project.company)) D.fail("Affectation non autorisée.", 403);
      const date = D.iso(String(req.body?.date || row.date));
      const start = String(req.body?.start || row.start);
      const end = String(req.body?.end || row.end);
      if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || end <= start) D.fail("Horaires invalides.");
      const conflict = (data.planning || []).some((x) => !same(x.id, row.id) && !x.deletedAt && same(x.employeeId, employee.id) && x.date === date && x.start < end && x.end > start);
      if (conflict) D.fail("Conflit de planning pour ce salarié.", 409);
      row.employeeId = employee.id;
      row.company = project.company;
      row.project = project.id;
      row.date = date;
      row.start = start;
      row.end = end;
      if (req.body?.location != null) row.location = String(req.body.location).slice(0, 300);
      return { data, changed: ["planning"], result: row, audit: { id: row.id, date, start, end, employeeId: employee.id, projectId: project.id } };
    });
    res.json({ ok: true, planning: result.result });
  }));

  router.post("/project/:id/acceptance", wrap(async (req, res) => {
    const { view } = await stateContext(db, req.user);
    const project = active(view.projects).find((x) => same(x.id, req.params.id));
    if (!project) D.fail("Chantier inaccessible.", 404);
    const isClientSigner = req.user.role === "client" && req.user.client_id && same(project.clientId, req.user.client_id);
    if (!isClientSigner) await requirePermission(db, req.user, "project.acceptance", "Signature de réception non autorisée.");
    const signerName = clean(String(req.body?.signerName || req.user.name || ""), 200);
    const signature = clean(String(req.body?.signature || ""), 2000);
    const notes = clean(String(req.body?.notes || ""), 3000, true) || null;
    await db.query(
      `INSERT INTO pro_project_acceptance(project_id,company,client_id,signer_name,signature,notes,signed_by)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(project_id) DO UPDATE SET signer_name=EXCLUDED.signer_name,signature=EXCLUDED.signature,
       notes=EXCLUDED.notes,signed_by=EXCLUDED.signed_by,signed_at=NOW(),updated_at=NOW()`,
      [String(project.id), String(project.company), project.clientId ? String(project.clientId) : null, signerName, signature, notes, req.user.id],
    );
    await db.query(
      `INSERT INTO app_events(event_type,actor_user_id,company,project_id,entity_type,entity_id,payload)
       VALUES('project.acceptance.signed',$1,$2,$3,'project',$3,$4)`,
      [req.user.id, project.company, String(project.id), JSON.stringify({ signerName, clientId: project.clientId || null })],
    );
    res.json({ ok: true, projectId: String(project.id), signerName, signedAt: new Date().toISOString() });
  }));

  router.get("/project/:id/acceptance.pdf", wrap(async (req, res) => {
    const { view } = await stateContext(db, req.user);
    const project = active(view.projects).find((x) => same(x.id, req.params.id));
    if (!project) D.fail("Chantier inaccessible.", 404);
    const acceptance = (await db.query("SELECT * FROM pro_project_acceptance WHERE project_id=$1", [String(project.id)])).rows[0];
    if (!acceptance) D.fail("Aucune réception signée pour ce chantier.", 404);
    const client = active(view.clients).find((x) => same(x.id, project.clientId)) || null;
    const company = active(view.companies).find((x) => same(x.id, project.company)) || null;
    const pdf = new PDFDocument({ size: "A4", margin: 48, info: { Title: `Réception chantier ${project.id}` } });
    const chunks = [];
    pdf.on("data", (chunk) => chunks.push(chunk));
    const done = new Promise((resolve, reject) => { pdf.on("end", resolve); pdf.on("error", reject); });
    pdf.fontSize(20).text(company?.name || "Sousa Group One");
    pdf.moveDown(0.3).fontSize(14).text("Procès-verbal de réception");
    pdf.moveDown().fontSize(10).text(`Chantier : ${project.id} — ${project.title}`);
    pdf.text(`Client : ${client?.name || "—"}`);
    pdf.text(`Adresse : ${project.address || "—"}`);
    pdf.text(`Date de signature : ${new Date(acceptance.signed_at).toLocaleString("fr-CH", { timeZone: "Europe/Zurich" })}`);
    pdf.moveDown().fontSize(12).text("Validation", { underline: true });
    pdf.moveDown(0.3).fontSize(10).text(`Signataire : ${acceptance.signer_name}`);
    pdf.text(`Signature électronique : ${acceptance.signature}`);
    if (acceptance.notes) {
      pdf.moveDown().fontSize(12).text("Observations", { underline: true });
      pdf.moveDown(0.3).fontSize(10).text(acceptance.notes);
    }
    pdf.moveDown().fontSize(8).fillColor("#555555").text("Document généré par Sousa Group One. La trace de signature et l'horodatage sont conservés dans l'historique du chantier.");
    pdf.end();
    await done;
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="reception-${encodeURIComponent(project.id)}.pdf"`,
      "Cache-Control": "no-store",
    });
    res.send(Buffer.concat(chunks));
  }));

  router.get("/intervention/:id.pdf", wrap(async (req, res) => {
    const order = (await db.query("SELECT * FROM work_orders WHERE id=$1", [String(req.params.id)])).rows[0];
    if (!order || !companyAllowed(req.user, order.company)) D.fail("Rapport inaccessible.", 404);
    const { view } = await stateContext(db, req.user);
    const project = active(view.projects).find((x) => same(x.id, order.project_id)) || null;
    const client = active(view.clients).find((x) => same(x.id, order.client_id)) || null;
    const company = active(view.companies).find((x) => same(x.id, order.company)) || null;
    const times = project ? active(view.time).filter((x) => same(x.project, project.id)) : [];
    const expenses = project ? active(view.expenses).filter((x) => same(x.project, project.id)) : [];
    const docs = project ? active(view.documents).filter((x) => same(x.project, project.id)).slice(0, 20) : [];
    const pdf = new PDFDocument({ size: "A4", margin: 48, info: { Title: `Rapport d'intervention ${order.id}` } });
    const chunks = [];
    pdf.on("data", (chunk) => chunks.push(chunk));
    const done = new Promise((resolve, reject) => { pdf.on("end", resolve); pdf.on("error", reject); });
    pdf.fontSize(20).text(company?.name || "Sousa Group One");
    pdf.moveDown(0.3).fontSize(14).text("Rapport d'intervention");
    pdf.moveDown().fontSize(10).text(`N° ${order.id}`);
    pdf.text(`Date : ${order.scheduled_at ? new Date(order.scheduled_at).toLocaleString("fr-CH", { timeZone: "Europe/Zurich" }) : "—"}`);
    pdf.text(`Client : ${client?.name || "—"}`);
    pdf.text(`Chantier : ${project ? `${project.id} — ${project.title}` : "—"}`);
    pdf.text(`Adresse : ${project?.address || "—"}`);
    pdf.text(`Technicien : ${active(view.employees).find((x) => same(x.id, order.assigned_employee_id))?.name || "—"}`);
    pdf.moveDown().fontSize(12).text("Travail effectué", { underline: true });
    pdf.moveDown(0.3).fontSize(10).text(order.description || order.title || "—");
    pdf.moveDown().fontSize(12).text("Heures & coûts", { underline: true });
    pdf.moveDown(0.3).fontSize(10).text(`Heures enregistrées sur le chantier : ${times.reduce((n, x) => n + Number(x.hours || 0), 0).toFixed(2)} h`);
    pdf.text(`Dépenses enregistrées : CHF ${expenses.reduce((n, x) => n + Number(x.amount || 0), 0).toFixed(2)}`);
    if (docs.length) {
      pdf.moveDown().fontSize(12).text("Documents / photos", { underline: true });
      pdf.moveDown(0.3).fontSize(10);
      for (const doc of docs) pdf.text(`• ${doc.name}`);
    }
    pdf.moveDown().fontSize(12).text("Validation client", { underline: true });
    pdf.moveDown(0.3).fontSize(10).text(order.customer_signature ? `Signé par : ${order.customer_signature}` : "Signature : ______________________________");
    if (order.signed_at) pdf.text(`Signé le : ${new Date(order.signed_at).toLocaleString("fr-CH", { timeZone: "Europe/Zurich" })}`);
    pdf.end();
    await done;
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="rapport-intervention-${encodeURIComponent(order.id)}.pdf"`,
      "Cache-Control": "no-store",
    });
    res.send(Buffer.concat(chunks));
  }));

  return router;
}

module.exports = { routes, ensureSchema, PERMISSIONS, DEFAULT_PERMISSION_KEYS };
