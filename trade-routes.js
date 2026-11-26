"use strict";
// Work by trade:
// - Électricité: the periodic OIBT controls of the clients' installations (when the next safety
//   report is due, who to call) and the safety report (RS) of each finished job.
// - Solaire: the paperwork of each solar installation (commune, network operator, RS, commissioning,
//   Pronovo…) with its state, dates and the steps waiting too long.
const express = require("express");
const D = require("./domain");
const { auth } = require("./auth-middleware");
const { loadState } = require("./db");

const KINDS = {
  habitation: { label: "Habitation", years: 20 },
  commerce: { label: "Commerce, bureaux, artisanat", years: 10 },
  public: { label: "Locaux accueillant du public", years: 5 },
  special: { label: "Installation spéciale", years: 3 },
  other: { label: "Autre", years: 10 },
};
const PERIODS = [1, 3, 5, 10, 20];
// Contact the client this long before the report is due: the network operator usually asks the
// owner for it about six months ahead.
const CONTACT_MONTHS = 9;

const SOLAR_STEPS = [
  { id: "commune", label: "Annonce à la commune (ou permis de construire)" },
  { id: "raccordement", label: "Demande de raccordement au gestionnaire de réseau" },
  { id: "avis", label: "Avis d’installation au gestionnaire de réseau" },
  { id: "pose", label: "Pose de l’installation" },
  { id: "rs", label: "Contrôle final et rapport de sécurité (RS)" },
  { id: "mes", label: "Mise en service et compteur posé" },
  { id: "go", label: "Garanties d’origine (Pronovo), si requis" },
  { id: "ru", label: "Demande de rétribution unique (Pronovo)" },
  { id: "client", label: "Dossier remis au client" },
];
const STEP_STATES = ["À faire", "En cours", "Fait", "Non concerné"];
const WAIT_DAYS = 21;

const norm = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
function companyKind(c) {
  const t = norm([c?.type, c?.name, c?.id].join(" "));
  if (/electric/.test(t)) return "electricite";
  if (/solai|solar/.test(t)) return "solaire";
  if (/demenag|moving/.test(t)) return "demenagement";
  return "";
}
const isoDay = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : "");
function addYears(dayIso, years) {
  const d = new Date(dayIso + "T12:00:00Z");
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}
function addMonths(dayIso, months) {
  const d = new Date(dayIso + "T12:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}
const todayIso = () => new Date().toISOString().slice(0, 10);

// Where an installation stands: late, to contact, or fine.
function controlState(row, today = todayIso()) {
  const due = row.last_control ? addYears(isoDay(row.last_control), Number(row.period_years) || 20) : "";
  if (!due) return { due: "", state: "unknown", stateLabel: "Date inconnue" };
  const contacted = isoDay(row.contacted_at);
  const recentlyContacted = contacted && contacted >= addMonths(today, -2);
  if (due < today) return { due, state: "late", stateLabel: "Contrôle dépassé", contacted: !!recentlyContacted };
  if (due <= addMonths(today, CONTACT_MONTHS))
    return { due, state: recentlyContacted ? "contacted" : "soon", stateLabel: recentlyContacted ? "Client contacté" : "À contacter", contacted: !!recentlyContacted };
  return { due, state: "ok", stateLabel: "À jour" };
}

const schemas = new WeakMap();
function ensureSchema(db) {
  if (!schemas.has(db))
    schemas.set(
      db,
      (async () => {
        await db.query(`CREATE TABLE IF NOT EXISTS oibt_installations (
          id SERIAL PRIMARY KEY, company TEXT NOT NULL, client_id TEXT NOT NULL DEFAULT '',
          label TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'habitation',
          period_years INTEGER NOT NULL DEFAULT 20, last_control TEXT, project_id TEXT NOT NULL DEFAULT '',
          contacted_at TEXT, notes TEXT NOT NULL DEFAULT '', created_by INTEGER,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), archived_at TIMESTAMPTZ
        )`);
        await db.query(`CREATE TABLE IF NOT EXISTS oibt_reports (
          project_id TEXT PRIMARY KEY, company TEXT NOT NULL, delivered_on TEXT NOT NULL,
          notes TEXT NOT NULL DEFAULT '', installation_id INTEGER, created_by INTEGER,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
        await db.query(`CREATE TABLE IF NOT EXISTS solar_steps (
          project_id TEXT NOT NULL, step TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'À faire', date TEXT, note TEXT NOT NULL DEFAULT '',
          updated_by INTEGER, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(project_id, step)
        )`);
      })().catch((e) => {
        schemas.delete(db);
        throw e;
      }),
    );
  return schemas.get(db);
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const text = (v, name, max = 200, optional = true) => D.text(v == null ? "" : String(v), name, max, optional);
const day = (v, name, optional = true) => {
  if (optional && !v) return null;
  const s = String(v || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + "T12:00:00Z"))) D.fail(`${name} invalide.`);
  return s;
};

async function context(db, req) {
  const { data } = await loadState(db);
  const user = D.effectiveUser(data, req.user);
  return { data, user };
}
function tradeCompanies(data, user, kind) {
  return data.companies.filter((c) => c.id !== "group" && companyKind(c) === kind && D.inCompany(user, c.id));
}

// The steps of one solar installation, the template completed with what was recorded.
function solarSteps(rows) {
  const saved = new Map(rows.map((r) => [r.step, r]));
  const out = SOLAR_STEPS.map((s, i) => ({ step: s.id, label: s.label, position: i, custom: false }));
  for (const r of rows) if (!SOLAR_STEPS.some((s) => s.id === r.step)) out.push({ step: r.step, label: r.label, position: r.position, custom: true });
  return out
    .sort((a, b) => a.position - b.position)
    .map((s) => {
      const r = saved.get(s.step);
      const status = r?.status || "À faire",
        date = isoDay(r?.date);
      const waiting = status === "En cours" && date && date <= new Date(Date.now() - WAIT_DAYS * 864e5).toISOString().slice(0, 10);
      return { ...s, status, date, note: r?.note || "", waiting: !!waiting, updatedAt: r?.updated_at || null };
    });
}
function solarProgress(steps) {
  const counted = steps.filter((s) => s.status !== "Non concerné");
  const done = counted.filter((s) => s.status === "Fait").length;
  return { done, total: counted.length, next: counted.find((s) => s.status !== "Fait") || null, waiting: steps.filter((s) => s.waiting).length };
}

function routes(db) {
  const r = express.Router();
  r.use(auth(db));
  r.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    ensureSchema(db).then(() => next(), next);
  });
  const staff = (user) => D.privileged(user, [...D.OPS, "accounting"]);
  const writer = (user) => D.privileged(user, D.OPS);

  r.get("/kinds", (req, res) => res.json({ kinds: KINDS, periods: PERIODS, solarSteps: SOLAR_STEPS, stepStates: STEP_STATES, contactMonths: CONTACT_MONTHS }));

  // ---- OIBT ----
  r.get(
    "/oibt",
    wrap(async (req, res) => {
      const { data, user } = await context(db, req);
      if (!staff(user)) D.fail("Accès refusé.", 403);
      const companies = tradeCompanies(data, user, "electricite");
      const ids = companies.map((c) => c.id);
      const rows = ids.length
        ? (await db.query("SELECT * FROM oibt_installations WHERE archived_at IS NULL AND company = ANY($1::text[]) ORDER BY id", [ids])).rows
        : [];
      const clients = new Map(data.clients.map((c) => [String(c.id), c]));
      const installations = rows
        .map((x) => {
          const c = clients.get(String(x.client_id));
          return {
            id: x.id,
            company: x.company,
            clientId: x.client_id,
            clientName: c?.name || "",
            phone: c?.phone || "",
            email: c?.email || "",
            label: x.label,
            address: x.address,
            kind: x.kind,
            periodYears: x.period_years,
            lastControl: isoDay(x.last_control),
            contactedAt: isoDay(x.contacted_at),
            projectId: x.project_id,
            notes: x.notes,
            ...controlState(x),
          };
        })
        .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
      // Finished electrical jobs whose safety report was not recorded yet.
      const reports = ids.length ? (await db.query("SELECT project_id,delivered_on FROM oibt_reports WHERE company = ANY($1::text[])", [ids])).rows : [];
      const reported = new Map(reports.map((x) => [x.project_id, isoDay(x.delivered_on)]));
      const finished = data.projects.filter((p) => !p.deletedAt && ids.includes(p.company) && ["Terminé", "À facturer"].includes(p.status));
      const missingReports = finished
        .filter((p) => !reported.has(p.id))
        .map((p) => ({ id: p.id, title: p.title, company: p.company, clientId: p.clientId, clientName: clients.get(String(p.clientId))?.name || "", address: p.address || "", completedAt: isoDay(p.completedAt) }));
      res.json({
        companies: companies.map((c) => ({ id: c.id, name: c.name })),
        installations,
        missingReports,
        canWrite: writer(user),
        counts: {
          late: installations.filter((x) => x.state === "late").length,
          soon: installations.filter((x) => x.state === "soon").length,
          missingReports: missingReports.length,
        },
      });
    }),
  );

  async function installationInput(data, user, body, existing) {
    const company = String(body.company || existing?.company || "");
    if (!tradeCompanies(data, user, "electricite").some((c) => c.id === company)) D.fail("Choisissez l’entreprise d’électricité.", 403);
    const clientId = String(body.clientId ?? existing?.client_id ?? "");
    if (clientId) {
      const c = data.clients.find((x) => D.same(x.id, clientId) && !x.deletedAt);
      if (!c || (c.company && c.company !== company)) D.fail("Client introuvable dans cette entreprise.");
    }
    const kind = KINDS[body.kind] ? body.kind : existing?.kind || "habitation";
    const period = Number(body.periodYears ?? existing?.period_years ?? KINDS[kind].years);
    if (!PERIODS.includes(period)) D.fail("Périodicité invalide (1, 3, 5, 10 ou 20 ans).");
    const label = text(body.label ?? existing?.label, "Nom de l’installation", 160, false);
    return {
      company,
      clientId,
      label,
      address: text(body.address ?? existing?.address, "Adresse", 300),
      kind,
      period,
      lastControl: day(body.lastControl ?? isoDay(existing?.last_control), "Date du dernier contrôle"),
      notes: text(body.notes ?? existing?.notes, "Remarques", 2000),
    };
  }
  r.post(
    "/oibt/save",
    wrap(async (req, res) => {
      const { data, user } = await context(db, req);
      if (!writer(user)) D.fail("Modification non autorisée.", 403);
      const id = Number(req.body.id || 0);
      let existing = null;
      if (id) {
        existing = (await db.query("SELECT * FROM oibt_installations WHERE id=$1 AND archived_at IS NULL", [id])).rows[0];
        if (!existing || !D.inCompany(user, existing.company)) D.fail("Installation introuvable.", 404);
      }
      const v = await installationInput(data, user, req.body, existing);
      const row = id
        ? (
            await db.query(
              "UPDATE oibt_installations SET company=$2,client_id=$3,label=$4,address=$5,kind=$6,period_years=$7,last_control=$8,notes=$9,updated_at=NOW() WHERE id=$1 RETURNING id",
              [id, v.company, v.clientId, v.label, v.address, v.kind, v.period, v.lastControl, v.notes],
            )
          ).rows[0]
        : (
            await db.query(
              "INSERT INTO oibt_installations(company,client_id,label,address,kind,period_years,last_control,notes,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
              [v.company, v.clientId, v.label, v.address, v.kind, v.period, v.lastControl, v.notes, req.user.id],
            )
          ).rows[0];
      await db.query("INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)", [user.email, id ? "Installation OIBT modifiée" : "Installation OIBT ajoutée", JSON.stringify({ id: row.id, company: v.company })]);
      res.json({ ok: true, id: row.id });
    }),
  );
  async function ownInstallation(user, id) {
    const row = (await db.query("SELECT * FROM oibt_installations WHERE id=$1 AND archived_at IS NULL", [Number(id) || 0])).rows[0];
    if (!row || !D.inCompany(user, row.company)) D.fail("Installation introuvable.", 404);
    return row;
  }
  r.post(
    "/oibt/action",
    wrap(async (req, res) => {
      const { user } = await context(db, req);
      if (!writer(user)) D.fail("Modification non autorisée.", 403);
      const row = await ownInstallation(user, req.body.id);
      const what = String(req.body.what || "");
      if (what === "contacted") await db.query("UPDATE oibt_installations SET contacted_at=$2,updated_at=NOW() WHERE id=$1", [row.id, day(req.body.date || todayIso(), "Date")]);
      else if (what === "controlled") {
        const when = day(req.body.date || todayIso(), "Date du contrôle", false);
        if (when > todayIso()) D.fail("La date du contrôle ne peut pas être dans le futur.");
        await db.query("UPDATE oibt_installations SET last_control=$2,contacted_at=NULL,updated_at=NOW() WHERE id=$1", [row.id, when]);
      } else if (what === "archive") await db.query("UPDATE oibt_installations SET archived_at=NOW() WHERE id=$1", [row.id]);
      else D.fail("Action inconnue.");
      await db.query("INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)", [user.email, "Installation OIBT : " + what, JSON.stringify({ id: row.id })]);
      res.json({ ok: true });
    }),
  );
  // The safety report of a finished job: recorded, and the installation's periodic control
  // starts from it (created or updated for that client and address).
  r.post(
    "/oibt/report",
    wrap(async (req, res) => {
      const { data, user } = await context(db, req);
      if (!writer(user)) D.fail("Modification non autorisée.", 403);
      const p = data.projects.find((x) => D.same(x.id, req.body.projectId) && !x.deletedAt);
      if (!p || !tradeCompanies(data, user, "electricite").some((c) => c.id === p.company)) D.fail("Chantier introuvable.", 404);
      const when = day(req.body.date || todayIso(), "Date du rapport", false);
      if (when > todayIso()) D.fail("La date du rapport ne peut pas être dans le futur.");
      const kind = KINDS[req.body.kind] ? req.body.kind : "habitation";
      const period = Number(req.body.periodYears || KINDS[kind].years);
      if (!PERIODS.includes(period)) D.fail("Périodicité invalide (1, 3, 5, 10 ou 20 ans).");
      let installationId = null;
      if (req.body.track !== false) {
        const address = text(p.address, "Adresse", 300);
        const found = (
          await db.query("SELECT id FROM oibt_installations WHERE archived_at IS NULL AND company=$1 AND client_id=$2 AND lower(address)=lower($3) LIMIT 1", [p.company, String(p.clientId || ""), address])
        ).rows[0];
        installationId = found
          ? (await db.query("UPDATE oibt_installations SET last_control=$2,kind=$3,period_years=$4,project_id=$5,contacted_at=NULL,updated_at=NOW() WHERE id=$1 RETURNING id", [found.id, when, kind, period, p.id])).rows[0].id
          : (
              await db.query(
                "INSERT INTO oibt_installations(company,client_id,label,address,kind,period_years,last_control,project_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
                [p.company, String(p.clientId || ""), text(p.title, "Nom", 160, false), address, kind, period, when, p.id, req.user.id],
              )
            ).rows[0].id;
      }
      await db.query(
        `INSERT INTO oibt_reports(project_id,company,delivered_on,notes,installation_id,created_by) VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT (project_id) DO UPDATE SET delivered_on=EXCLUDED.delivered_on, notes=EXCLUDED.notes, installation_id=EXCLUDED.installation_id`,
        [p.id, p.company, when, text(req.body.notes, "Remarques", 1000), installationId, req.user.id],
      );
      await db.query("INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)", [user.email, "Rapport de sécurité enregistré", JSON.stringify({ project: p.id, installationId })]);
      res.json({ ok: true, installationId });
    }),
  );

  r.get(
    "/oibt/report/:projectId",
    wrap(async (req, res) => {
      const { data, user } = await context(db, req);
      if (!staff(user)) D.fail("Accès refusé.", 403);
      const p = data.projects.find((x) => D.same(x.id, req.params.projectId) && !x.deletedAt);
      if (!p || !D.canProject(data, user, p)) D.fail("Chantier introuvable.", 404);
      const elec = companyKind(data.companies.find((c) => c.id === p.company)) === "electricite";
      const row = elec ? (await db.query("SELECT delivered_on,notes,installation_id FROM oibt_reports WHERE project_id=$1", [p.id])).rows[0] : null;
      res.json({ electricity: elec, report: row ? { deliveredOn: isoDay(row.delivered_on), notes: row.notes, installationId: row.installation_id } : null, canWrite: writer(user) });
    }),
  );

  // ---- Solaire ----
  async function solarProject(data, user, id) {
    const p = data.projects.find((x) => D.same(x.id, id) && !x.deletedAt);
    if (!p || !D.canProject(data, user, p)) D.fail("Chantier introuvable.", 404);
    if (companyKind(data.companies.find((c) => c.id === p.company)) !== "solaire") D.fail("Ce chantier n’est pas un chantier solaire.");
    return p;
  }
  r.get(
    "/solar/project/:id",
    wrap(async (req, res) => {
      const { data, user } = await context(db, req);
      const p = await solarProject(data, user, req.params.id);
      const rows = (await db.query("SELECT * FROM solar_steps WHERE project_id=$1", [p.id])).rows;
      const steps = solarSteps(rows);
      res.json({ project: { id: p.id, title: p.title }, steps, progress: solarProgress(steps), canWrite: writer(user) && D.inCompany(user, p.company), states: STEP_STATES });
    }),
  );
  r.post(
    "/solar/step",
    wrap(async (req, res) => {
      const { data, user } = await context(db, req);
      const p = await solarProject(data, user, req.body.projectId);
      if (!writer(user)) D.fail("Modification non autorisée.", 403);
      const status = String(req.body.status || "");
      if (!STEP_STATES.includes(status)) D.fail("État invalide.");
      let step = String(req.body.step || "");
      const known = SOLAR_STEPS.find((s) => s.id === step);
      let label = known?.label || "",
        position = SOLAR_STEPS.findIndex((s) => s.id === step);
      if (!known) {
        const existing = step ? (await db.query("SELECT label,position FROM solar_steps WHERE project_id=$1 AND step=$2", [p.id, step])).rows[0] : null;
        if (existing) ({ label, position } = existing);
        else {
          label = text(req.body.label, "Nom de l’étape", 160, false);
          step = "x" + Date.now().toString(36);
          position = SOLAR_STEPS.length + Number((await db.query("SELECT COUNT(*)::int AS n FROM solar_steps WHERE project_id=$1 AND position >= $2", [p.id, SOLAR_STEPS.length])).rows[0].n);
        }
      }
      const date = day(req.body.date, "Date") || (status === "À faire" ? null : todayIso());
      await db.query(
        `INSERT INTO solar_steps(project_id,step,label,position,status,date,note,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW())
         ON CONFLICT (project_id,step) DO UPDATE SET status=EXCLUDED.status, date=EXCLUDED.date, note=EXCLUDED.note, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
        [p.id, step, label, position, status, date, text(req.body.note, "Remarque", 500), req.user.id],
      );
      await db.query("INSERT INTO audit_logs(user_email,action,metadata) VALUES($1,$2,$3)", [user.email, "Démarche solaire mise à jour", JSON.stringify({ project: p.id, step, status })]);
      res.json({ ok: true, step });
    }),
  );
  r.get(
    "/solar",
    wrap(async (req, res) => {
      const { data, user } = await context(db, req);
      if (!staff(user)) D.fail("Accès refusé.", 403);
      const ids = tradeCompanies(data, user, "solaire").map((c) => c.id);
      const projects = data.projects.filter((p) => !p.deletedAt && ids.includes(p.company));
      const rows = projects.length ? (await db.query("SELECT * FROM solar_steps WHERE project_id = ANY($1::text[])", [projects.map((p) => p.id)])).rows : [];
      const clients = new Map(data.clients.map((c) => [String(c.id), c.name]));
      const list = projects
        .map((p) => {
          const steps = solarSteps(rows.filter((x) => x.project_id === p.id));
          return { id: p.id, title: p.title, status: p.status, clientName: clients.get(String(p.clientId)) || "", address: p.address || "", ...solarProgress(steps) };
        })
        .filter((x) => x.done < x.total || x.status !== "Terminé")
        .sort((a, b) => b.waiting - a.waiting || a.done / (a.total || 1) - b.done / (b.total || 1));
      res.json({ projects: list, canWrite: writer(user) });
    }),
  );

  // What the home page lists under « À faire ».
  r.get(
    "/todo",
    wrap(async (req, res) => {
      const { data, user } = await context(db, req);
      if (!staff(user)) return res.json({ items: [] });
      const items = [];
      const elec = tradeCompanies(data, user, "electricite").map((c) => c.id);
      if (elec.length) {
        const rows = (await db.query("SELECT * FROM oibt_installations WHERE archived_at IS NULL AND company = ANY($1::text[])", [elec])).rows.map((x) => controlState(x));
        const late = rows.filter((x) => x.state === "late" && !x.contacted).length,
          soon = rows.filter((x) => x.state === "soon").length;
        if (late) items.push({ tone: "danger", page: "trade", tab: "oibt", text: `${late} contrôle${late > 1 ? "s" : ""} OIBT dépassé${late > 1 ? "s" : ""}` });
        if (soon) items.push({ tone: "warn", page: "trade", tab: "oibt", text: `${soon} client${soon > 1 ? "s" : ""} à contacter pour le contrôle OIBT` });
        const reported = new Set((await db.query("SELECT project_id FROM oibt_reports WHERE company = ANY($1::text[])", [elec])).rows.map((x) => x.project_id));
        const missing = data.projects.filter((p) => !p.deletedAt && elec.includes(p.company) && ["Terminé", "À facturer"].includes(p.status) && !reported.has(p.id)).length;
        if (missing) items.push({ tone: "warn", page: "trade", tab: "oibt", text: `${missing} rapport${missing > 1 ? "s" : ""} de sécurité à enregistrer` });
      }
      const sol = tradeCompanies(data, user, "solaire").map((c) => c.id);
      if (sol.length) {
        const projects = data.projects.filter((p) => !p.deletedAt && sol.includes(p.company)).map((p) => p.id);
        if (projects.length) {
          const rows = (await db.query("SELECT * FROM solar_steps WHERE project_id = ANY($1::text[])", [projects])).rows;
          const waiting = projects.reduce((n, id) => n + solarSteps(rows.filter((x) => x.project_id === id)).filter((s) => s.waiting).length, 0);
          if (waiting) items.push({ tone: "warn", page: "trade", tab: "solar", text: `${waiting} démarche${waiting > 1 ? "s" : ""} solaire${waiting > 1 ? "s" : ""} sans réponse depuis ${WAIT_DAYS} jours` });
        }
      }
      res.json({ items });
    }),
  );
  return r;
}
module.exports = { routes, ensureSchema, controlState, companyKind, solarSteps, solarProgress, KINDS, SOLAR_STEPS };
