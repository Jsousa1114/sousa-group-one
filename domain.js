"use strict";
const { randomUUID } = require("node:crypto");
const Finance = require("./finance");
class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const fail = (message, status = 400) => {
  throw new AppError(message, status);
};
const ROLES = [
  "admin",
  "direction",
  "hr",
  "manager",
  "accounting",
  "employee",
  "client",
];
const COLLECTIONS = [
  "companies",
  "employees",
  "clients",
  "projects",
  "time",
  "absences",
  "planning",
  "quotes",
  "invoices",
  "payments",
  "expenses",
  "inventory",
  "suppliers",
  "vehicles",
  "tools",
  "maintenance",
  "documents",
  "messages",
  "clocks",
];
const STAFF = ["admin", "direction"],
  HR = [...STAFF, "hr"],
  OPS = [...STAFF, "manager"],
  FIN = [...STAFF, "accounting"];
const access = {
  companies: STAFF,
  employees: HR,
  clients: [...OPS, "accounting"],
  projects: OPS,
  planning: OPS,
  quotes: FIN,
  invoices: FIN,
  payments: FIN,
  expenses: [...OPS, "accounting"],
  inventory: OPS,
  suppliers: OPS,
  vehicles: OPS,
  tools: OPS,
  maintenance: OPS,
};
const same = (a, b) => a != null && b != null && String(a) === String(b);
const employeeCompanies = (e) =>
  [
    ...new Set([e.company, ...(Array.isArray(e.companies) ? e.companies : [])]),
  ].filter((c) => c && c !== "group");
const inCompany = (u, c) =>
  u.role === "employee" || (u.employee_id && u.company !== "group")
    ? (u.companies || [u.company]).includes(c) && c !== "group"
    : u.company === "group" || u.company === c;
function effectiveUser(data, u) {
  if (u.role === "client" || (!u.employee_id && u.role !== "employee"))
    return u;
  const e = data.employees?.find((e) => same(e.id, u.employee_id));
  if (!e || e.deletedAt) fail("Compte salarié désactivé.", 401);
  if (u.company === "group" && u.role !== "employee") return u;
  return { ...u, company: e.company, companies: employeeCompanies(e) };
}
const employeeInCompany = (e, c) =>
  !e.deletedAt && employeeCompanies(e).includes(c);
const privileged = (u, roles) => roles.includes(u.role);
function employeeProfile(p) {
  const out = {};
  for (const key of [
    "street",
    "zip",
    "city",
    "country",
    "nationality",
    "residencePermit",
    "emergencyName",
    "emergencyPhone",
    "contractType",
    "notes",
  ])
    out[key] = text(p[key], key, key === "notes" ? 2000 : 200, true);
  out.residencePermitExpiry = p.residencePermitExpiry
    ? iso(p.residencePermitExpiry)
    : "";
  out.birthDate = p.birthDate ? iso(p.birthDate) : "";
  out.endDate = p.endDate ? iso(p.endDate) : "";
  if (out.endDate && p.entry && out.endDate < p.entry)
    fail("La fin du contrat précède la date d’entrée.");
  out.photo = p.photo || "";
  if (out.photo) {
    if (
      typeof out.photo !== "string" ||
      out.photo.length > 350000 ||
      !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(
        out.photo,
      )
    )
      fail("Photo invalide ou trop volumineuse.");
    const bytes = Buffer.from(out.photo.split(",")[1], "base64");
    const valid = out.photo.startsWith("data:image/jpeg;")
      ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : out.photo.startsWith("data:image/png;")
        ? bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : bytes.toString("ascii", 0, 4) === "RIFF" &&
          bytes.toString("ascii", 8, 12) === "WEBP";
    if (!valid) fail("Format de photo invalide.");
  }
  return out;
}
function emptyState() {
  return Object.fromEntries(
    COLLECTIONS.map((k) => [
      k,
      k === "companies"
        ? [
            { id: "group", code: "SG", name: "Sousa Group", type: "Groupe" },
            ...["electricite", "home", "tech", "moving", "solar", "events"].map(
              (id, i) => ({
                id,
                code: ["SE", "SHS", "ST", "SM", "SS", "SEV"][i],
                name: [
                  "Sousa Électricité",
                  "Sousa Home Service",
                  "Sousa Tech",
                  "Sousa Moving",
                  "Sousa Solar",
                  "Sousa Events",
                ][i],
                type: [
                  "Électricité",
                  "Services",
                  "Informatique",
                  "Déménagement",
                  "Solaire",
                  "Événementiel",
                ][i],
              }),
            ),
          ]
        : [],
    ]),
  );
}
function normalize(data) {
  const d = { ...emptyState(), ...(data || {}) };
  for (const k of COLLECTIONS) if (!Array.isArray(d[k])) d[k] = [];
  return d;
}
function text(v, name, max = 200, optional = false) {
  if (optional && (v == null || v === "")) return "";
  if (typeof v !== "string" || !v.trim() || v.trim().length > max)
    fail(`${name} invalide.`);
  return v.trim();
}
function num(v, name, min = 0, max = 1e9) {
  if (
    v === "" ||
    v == null ||
    !Number.isFinite(Number(v)) ||
    Number(v) < min ||
    Number(v) > max
  )
    fail(`${name} invalide.`);
  return Number(v);
}
function cents(v) {
  const n = num(v, "Montant", 0.01, 1e8);
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6)
    fail("Deux décimales maximum.");
  return Math.round(n * 100);
}
const fromCents = (n) => Math.round(n) / 100;
function iso(v) {
  const s = text(v, "Date", 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
    Number.isNaN(new Date(s + "T12:00:00Z").getTime()) ||
    new Date(s + "T12:00:00Z").toISOString().slice(0, 10) !== s
  )
    fail("Date invalide.");
  return s;
}
function time(v) {
  if (typeof v !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v))
    fail("Heure invalide.");
  return v;
}
function swissInstant(day, clock) {
  const target = Date.parse(`${day}T${clock}:00Z`);
  let instant = target;
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Zurich",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(
      fmt.formatToParts(new Date(instant)).map((p) => [p.type, p.value]),
    );
    const local = Date.parse(
      `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`,
    );
    if (local === target) return new Date(instant).toISOString();
    instant += target - local;
  }
  fail("Horaire inexistant lors du changement d’heure. Vérifiez la saisie.");
}
function ref(d, k, id) {
  const r = d[k].find((x) => same(x.id, id));
  if (!r) fail(`${k} : élément introuvable.`, 404);
  return r;
}
function company(d, u, id) {
  const c = ref(d, "companies", id);
  if (c.id === "group" || !inCompany(u, c.id))
    fail("Entreprise non autorisée.", 403);
  return c.id;
}
function canProject(d, u, p) {
  return (
    inCompany(u, p.company) &&
    (privileged(u, [...OPS, "accounting"]) ||
      (u.role === "employee" &&
        (p.team || []).some((id) => same(id, u.employee_id))) ||
      (u.role === "client" && same(p.clientId, u.client_id)))
  );
}
function canEmployee(u, e) {
  return (
    employeeCompanies(e).some((c) => inCompany(u, c)) &&
    (privileged(u, [...HR, "manager"]) || same(e.id, u.employee_id))
  );
}
function recordCompany(d, k, r) {
  if (r.company) return r.company;
  if (r.project) return d.projects.find((p) => same(p.id, r.project))?.company;
  return null;
}
function canFinance(d, u, r) {
  if (r.deletedAt) return false;
  const c = recordCompany(d, "invoices", r);
  return (
    (privileged(u, FIN) && (c ? inCompany(u, c) : u.company === "group")) ||
    (u.role === "client" &&
      r.status !== "Brouillon" &&
      same(r.clientId, u.client_id) &&
      (c ? inCompany(u, c) : u.company === "group"))
  );
}
function canDocument(d, u, r) {
  u = effectiveUser(d, u);
  if (r.category === "identity") {
    const e = d.employees.find((e) => same(e.id, r.employeeId));
    return (
      !!e &&
      !e.deletedAt &&
      privileged(u, HR) &&
      employeeCompanies(e).some((c) => inCompany(u, c))
    );
  }
  if (u.role === "client" && r.visibility !== "client") return false;
  if (r.project)
    return canProject(
      d,
      u,
      d.projects.find((p) => same(p.id, r.project)) || {},
    );
  if (r.employeeId)
    return (
      same(r.employeeId, u.employee_id) ||
      (privileged(u, HR) && inCompany(u, r.company))
    );
  if (r.clientId)
    return (
      same(r.clientId, u.client_id) ||
      (privileged(u, [...OPS, "accounting"]) && inCompany(u, r.company))
    );
  return (
    privileged(u, [...STAFF, "manager", "accounting", "hr"]) &&
    inCompany(u, r.company)
  );
}
function viewState(data, u) {
  u = effectiveUser(data, u);
  const d = normalize(data),
    v = emptyState();
  v.companies = d.companies.filter((c) => inCompany(u, c.id));
  v.employees = d.employees
    .filter((e) => canEmployee(u, e))
    .map((e) =>
      privileged(u, HR) || same(e.id, u.employee_id)
        ? e
        : Object.fromEntries(
            Object.entries(e).filter(
              ([k]) =>
                ![
                  "salary",
                  "salaryPeriod",
                  "vacation",
                  "email",
                  "phone",
                  "street",
                  "zip",
                  "city",
                  "country",
                  "birthDate",
                  "nationality",
                  "residencePermit",
                  "residencePermitExpiry",
                  "emergencyName",
                  "emergencyPhone",
                  "notes",
                  "contractType",
                  "endDate",
                ].includes(k),
            ),
          ),
    );
  v.projects = d.projects
    .filter(
      (p) =>
        canProject(d, u, p) || (u.role === "hr" && inCompany(u, p.company)),
    )
    .map((p) =>
      u.role === "client" || u.role === "employee" || u.role === "hr"
        ? Object.fromEntries(
            Object.entries(p).filter(([k]) => !["cost", "budget"].includes(k)),
          )
        : p,
    );
  const ps = new Set(v.projects.map((p) => String(p.id)));
  v.clients = d.clients
    .filter((c) =>
      u.role === "client"
        ? same(c.id, u.client_id)
        : (privileged(u, [...OPS, "accounting"]) &&
            (c.company ? inCompany(u, c.company) : u.company === "group")) ||
          v.projects.some((p) => same(p.clientId, c.id)),
    )
    .map((c) => (u.role === "employee" ? { id: c.id, name: c.name } : c));
  for (const k of ["time", "planning", "absences"])
    v[k] = d[k].filter((r) =>
      u.role === "employee"
        ? same(r.employeeId, u.employee_id) &&
          inCompany(
            u,
            recordCompany(d, k, r) ||
              d.employees.find((e) => same(e.id, r.employeeId))?.company,
          )
        : privileged(
            u,
            k === "time"
              ? [...HR, "manager", "accounting"]
              : [...HR, "manager"],
          ) &&
          (k === "absences"
            ? employeeCompanies(
                d.employees.find((e) => same(e.id, r.employeeId)) || {},
              ).some((c) => inCompany(u, c))
            : inCompany(
                u,
                recordCompany(d, k, r) ||
                  d.employees.find((e) => same(e.id, r.employeeId))?.company,
              )),
    );
  for (const k of ["quotes", "invoices"])
    v[k] = d[k]
      .filter((r) => canFinance(d, u, r))
      .map((r) =>
        u.role === "client"
          ? Object.fromEntries(
              Object.entries(r).filter(([key]) => key !== "completionSnapshot"),
            )
          : r,
      );
  v.payments = d.payments.filter(
    (r) => v.invoices.some((i) => same(i.id, r.invoice)) && privileged(u, FIN),
  );
  v.expenses = d.expenses.filter(
    (r) => privileged(u, [...OPS, "accounting"]) && inCompany(u, r.company),
  );
  for (const k of [
    "inventory",
    "vehicles",
    "tools",
    "suppliers",
    "maintenance",
  ])
    v[k] = d[k].filter(
      (r) =>
        (privileged(u, [...OPS, "accounting"]) ||
          (u.role === "hr" && ["tools", "vehicles"].includes(k)) ||
          (u.role === "employee" &&
            (k === "inventory" ||
              (["tools", "vehicles"].includes(k) &&
                same(r.employeeId, u.employee_id)))) ||
          (u.role === "client" &&
            k === "maintenance" &&
            same(r.clientId, u.client_id))) &&
        (r.company ? inCompany(u, r.company) : u.company === "group"),
    );
  v.documents = d.documents.filter((r) => canDocument(d, u, r));
  v.messages = d.messages.filter(
    (r) =>
      (same(r.senderId, u.id) || same(r.recipientId, u.id)) &&
      !(r.hiddenFor || []).some((id) => same(id, u.id)),
  );
  v.clocks = d.clocks.filter((r) => same(r.userId, u.id));
  return v;
}
function canContact(u, v, data) {
  if (data && (v.employee_id || v.role === "employee")) {
    const e = data.employees?.find((e) => same(e.id, v.employee_id));
    if (!e || e.deletedAt) return false;
    v = effectiveUser(data, v);
  }
  return (
    !v.disabled &&
    ((!["client", "employee"].includes(u.role) &&
      (inCompany(u, v.company) ||
        (v.companies || []).some((c) => inCompany(u, c)))) ||
      (["client", "employee"].includes(u.role) &&
        privileged(v, [...STAFF, "manager"]) &&
        (v.company === "group" ||
          (v.companies || [v.company]).some((c) => inCompany(u, c)))))
  );
}
function weekdays(start, end) {
  let n = 0;
  for (
    let t = new Date(start + "T12:00:00Z");
    t <= new Date(end + "T12:00:00Z");
    t.setUTCDate(t.getUTCDate() + 1)
  )
    if (![0, 6].includes(t.getUTCDay())) n++;
  return n;
}
function identifier(d, k, prefix, now) {
  const year = new Date(now).getUTCFullYear();
  let n = 1;
  const stem = `${prefix}-${year}-`;
  for (const r of d[k])
    if (String(r.id).startsWith(stem))
      n = Math.max(n, Number(String(r.id).slice(stem.length)) + 1 || 1);
  return stem + String(n).padStart(4, "0");
}
function quoteProject(d, q, now) {
  if (q.status !== "Accepté" || q.deletedAt) fail("Devis accepté requis.");
  let project = q.project ? ref(d, "projects", q.project) : null;
  if (!project) {
    const c = ref(d, "clients", q.clientId);
    project = {
      id: identifier(d, "projects", ref(d, "companies", q.company).code, now),
      company: q.company,
      clientId: q.clientId,
      title: q.title,
      address: [c.street, c.buildingNumber, c.zip, c.city]
        .filter(Boolean)
        .join(" "),
      description: q.scope || q.title,
      start: now.slice(0, 10),
      end: "",
      budget: q.amount,
      cost: 0,
      hours: 0,
      team: [],
      progress: 0,
      status: "Planifié",
      createdAt: now,
    };
    d.projects.push(project);
    q.project = project.id;
  }
  if (project.company !== q.company || !same(project.clientId, q.clientId))
    fail("Chantier incompatible.");
  project.quoteIds = [...new Set([...(project.quoteIds || []), q.id])];
  return project;
}
function finishProject(d, u, project, now) {
  if (!privileged(u, [...OPS, ...FIN]) || !inCompany(u, project.company))
    fail("Accès refusé.", 403);
  if (d.clocks.some((c) => same(c.project, project.id)))
    fail("Terminez les pointages actifs du chantier.");
  const quotes = d.quotes.filter(
    (q) => q.project === project.id && q.status === "Accepté" && !q.deletedAt,
  );
  let invoices = d.invoices.filter(
    (i) => i.project === project.id && !i.deletedAt,
  );
  const day = now.slice(0, 10),
    due = new Date(day + "T12:00:00Z");
  due.setUTCDate(
    due.getUTCDate() +
      Number(ref(d, "companies", project.company).billing?.paymentDays ?? 30),
  );
  for (const q of quotes.length ? quotes : invoices.length ? [] : [null]) {
    let inv = q
      ? d.invoices.find(
          (i) => !i.deletedAt && (i.quoteId === q.id || i.id === q.invoiceId),
        )
      : null;
    if (inv) {
      if (inv.project && inv.project !== project.id)
        fail("Une facture du devis est liée à un autre chantier.");
      if (inv.status === "Brouillon") inv.project = project.id;
      if (!invoices.some((i) => i.id === inv.id)) invoices.push(inv);
    }
    if (!inv) {
      // This operation explicitly permits a project manager to prepare a draft only.
      inv = applyCommand(
        d,
        { ...u, role: "accounting", company: project.company },
        {
          action: "create",
          collection: "invoices",
          payload: {
            ...(q || {
              title: project.title,
              lines: [
                {
                  description: project.title,
                  quantity: 1,
                  unitPrice: 0,
                  vatRate: 0,
                },
              ],
              scope: project.description,
            }),
            company: project.company,
            clientId: project.clientId,
            project: project.id,
            date: day,
            due: due.toISOString().slice(0, 10),
          },
        },
        now,
        !q,
      ).result;
      if (q) {
        inv.quoteId = q.id;
        q.invoiceId = inv.id;
        inv.issuer = structuredClone(
          q.issuer || ref(d, "companies", q.company),
        );
        inv.customer = structuredClone(
          q.customer || ref(d, "clients", q.clientId),
        );
      } else inv.pricingRequired = true;
      invoices.push(inv);
    }
  }
  project.status = "Terminé";
  project.progress = 100;
  project.completedAt ||= now;
  project.invoiceIds = invoices.map((i) => i.id);
  for (const inv of invoices)
    if (inv.status === "Brouillon") {
      inv.completionSnapshot = {
        project: structuredClone(project),
        time: structuredClone(
          d.time.filter((t) => same(t.project, project.id)),
        ),
        expenses: structuredClone(
          d.expenses.filter((e) => same(e.project, project.id)),
        ),
        documents: d.documents
          .filter((doc) => same(doc.project, project.id))
          .map(({ id, name }) => ({ id, name })),
        capturedAt: now,
      };
      inv.workSummary = `Chantier ${project.id} — ${project.title}\n${project.address || ""}\n${project.description || ""}\nHeures enregistrées : ${d.time
        .filter((t) => same(t.project, project.id))
        .reduce((n, t) => n + Number(t.hours || 0), 0)
        .toFixed(2)} h.\nTerminé le ${day}.`;
    }
  return project;
}
function applyCommand(
  data,
  u,
  cmd,
  now = new Date().toISOString(),
  allowUnpriced = false,
) {
  u = effectiveUser(data, u);
  const d = normalize(data),
    p = cmd.payload || {},
    action = cmd.action;
  let result;
  if (action === "create") {
    const k = cmd.collection;
    if (!access[k] || !privileged(u, access[k]))
      fail("Création non autorisée.", 403);
    let r = { id: randomUUID(), createdAt: now };
    if (k === "companies") {
      if (u.company !== "group") fail("Accès groupe requis.", 403);
      const code = text(p.code, "Code", 8).toUpperCase();
      if (!/^[A-Z0-9]+$/.test(code) || d.companies.some((c) => c.code === code))
        fail("Code déjà utilisé ou invalide.");
      r = {
        ...r,
        code,
        name: text(p.name, "Nom"),
        type: text(p.type, "Secteur"),
      };
    } else if (k === "employees") {
      const salaryPeriod =
        p.salaryPeriod === undefined ? "monthly" : p.salaryPeriod;
      if (!["monthly", "hourly"].includes(salaryPeriod))
        fail("Type de salaire invalide.");
      if (p.salary == null || String(p.salary).trim() === "")
        fail("Renseignez le salaire.");
      r = {
        ...r,
        name: text(p.name, "Nom"),
        job: text(p.job, "Fonction"),
        company: company(d, u, p.company),
        email: text(p.email, "E-mail"),
        phone: text(p.phone, "Téléphone", 40, true),
        salary: fromCents(cents(p.salary)),
        salaryPeriod,
        activity: num(p.activity, "Taux", 1, 100),
        vacation: num(p.vacation, "Solde vacances", 0, 366),
        entry: iso(p.entry),
        status: "Actif",
        ...employeeProfile(p),
      };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) fail("E-mail invalide.");
    } else if (k === "clients") {
      r = {
        ...r,
        name: text(p.name, "Nom"),
        company: company(d, u, p.company),
        email: text(p.email, "E-mail"),
        phone: text(p.phone, "Téléphone", 40, true),
        city: text(p.city, "Ville"),
        street: text(p.street, "Rue", 200, true),
        buildingNumber: text(p.buildingNumber, "Numéro", 20, true),
        zip: text(p.zip, "Code postal", 20, true),
        country: text(p.country || "CH", "Pays", 2),
        type: text(p.type, "Type", 80, true),
        status: "Actif",
      };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) fail("E-mail invalide.");
    } else if (k === "projects") {
      const c = company(d, u, p.company),
        client = ref(d, "clients", p.clientId);
      if (client.company && client.company !== c)
        fail("Le client appartient à une autre entreprise.");
      const team = Array.isArray(p.team) ? p.team : [];
      for (const id of team)
        if (!employeeInCompany(ref(d, "employees", id), c))
          fail("Équipe incompatible.");
      r = {
        ...r,
        id: identifier(d, k, ref(d, "companies", c).code, now),
        company: c,
        clientId: client.id,
        title: text(p.title, "Titre"),
        address: text(p.address, "Adresse"),
        start: iso(p.start),
        end: iso(p.end),
        budget: fromCents(cents(p.budget)),
        cost: 0,
        hours: 0,
        progress: 0,
        team,
        status: "Planifié",
        description: text(p.description, "Description", 5000, true),
      };
      if (r.end < r.start) fail("La fin précède le début.");
    } else if (k === "planning") {
      const e = ref(d, "employees", p.employeeId),
        proj = ref(d, "projects", p.project);
      if (
        !canProject(d, u, proj) ||
        !inCompany(u, proj.company) ||
        !employeeInCompany(e, proj.company)
      )
        fail("Affectation non autorisée.", 403);
      r = {
        ...r,
        employeeId: e.id,
        company: proj.company,
        project: proj.id,
        date: iso(p.date),
        start: time(p.start),
        end: time(p.end),
        location: text(p.location, "Lieu", 300, true),
      };
      if (r.end <= r.start) fail("La fin doit suivre le début.");
      if (
        d.planning.some(
          (x) =>
            same(x.employeeId, e.id) &&
            x.date === r.date &&
            x.start < r.end &&
            x.end > r.start,
        )
      )
        fail("Ce salarié a déjà une affectation sur ce créneau.");
      if (
        d.absences.some(
          (x) =>
            same(x.employeeId, e.id) &&
            x.status === "Approuvée" &&
            x.from <= r.date &&
            x.to >= r.date,
        )
      )
        fail("Ce salarié est absent.");
      if (!(proj.team || []).some((id) => same(id, e.id)))
        proj.team = [...(proj.team || []), e.id];
    } else if (k === "quotes" || k === "invoices") {
      const client = ref(d, "clients", p.clientId),
        c = company(d, u, p.company);
      if (client.company && client.company !== c) fail("Client incompatible.");
      const proj = p.project ? ref(d, "projects", p.project) : null;
      if (proj && (proj.company !== c || !same(proj.clientId, client.id)))
        fail("Chantier incompatible.");
      let totals;
      try {
        totals = Finance.calculate(p.lines, allowUnpriced);
      } catch (e) {
        fail(e.message);
      }
      r = {
        ...r,
        id: identifier(d, k, k === "quotes" ? "D" : "F", now),
        company: c,
        clientId: client.id,
        project: proj?.id || "",
        title: text(p.title, "Objet"),
        ...totals,
        currency: "CHF",
        language: ["fr", "de", "it", "en"].includes(p.language)
          ? p.language
          : "fr",
        message: text(p.message, "Message", 5000, true),
        terms: text(p.terms, "Conditions", 5000, true),
        scope: text(p.scope, "Objet détaillé", 5000, true),
        exclusions: text(p.exclusions, "Non compris / options", 5000, true),
        paymentNote: text(p.paymentNote, "Consigne de paiement", 1000, true),
        depositPercent:
          p.depositPercent === "" || p.depositPercent == null
            ? 0
            : num(p.depositPercent, "Acompte", 0, 100),
        paymentReference: text(
          p.paymentReference,
          "Référence de paiement",
          140,
          true,
        ),
        signature: p.signature !== false && p.signature !== "false",
        paid: 0,
        date: iso(p.date),
        [k === "quotes" ? "valid" : "due"]: iso(
          k === "quotes" ? p.valid : p.due,
        ),
        status: "Brouillon",
      };
      if ((r.valid || r.due) < r.date)
        fail("Échéance antérieure à la date du document.");
      try {
        Finance.paymentSummary(r);
      } catch (e) {
        fail(e.message);
      }
    } else if (k === "payments") {
      const inv = ref(d, "invoices", p.invoice);
      if (!canFinance(d, u, inv) || inv.status === "Brouillon")
        fail("Facture non émise ou non autorisée.");
      const amount = cents(p.amount),
        remaining =
          Math.round(inv.amount * 100) - Math.round((inv.paid || 0) * 100);
      if (amount > remaining) fail("Le paiement dépasse le solde restant.");
      r = {
        ...r,
        id: identifier(d, k, "P", now),
        invoice: inv.id,
        clientId: inv.clientId,
        company: inv.company,
        amount: fromCents(amount),
        date: iso(p.date),
        method: text(p.method, "Mode de paiement", 80),
        status: "Confirmé",
      };
      inv.paid = fromCents(Math.round((inv.paid || 0) * 100) + amount);
      inv.status = inv.paid === inv.amount ? "Payée" : "Partiellement payée";
    } else if (k === "expenses") {
      const c = company(d, u, p.company),
        proj = p.project ? ref(d, "projects", p.project) : null;
      if (proj && proj.company !== c) fail("Chantier incompatible.");
      r = {
        ...r,
        company: c,
        project: proj?.id || "",
        supplier: text(p.supplier, "Fournisseur"),
        amount: fromCents(cents(p.amount)),
        date: iso(p.date),
        status: "Enregistrée",
      };
      if (proj)
        proj.cost = fromCents(
          Math.round((proj.cost || 0) * 100) + Math.round(r.amount * 100),
        );
    } else if (k === "inventory") {
      r = {
        ...r,
        company: company(d, u, p.company),
        sku: text(p.sku, "Référence", 60),
        name: text(p.name, "Nom"),
        category: text(p.category, "Catégorie", 100, true),
        stock: num(p.stock, "Stock"),
        min: num(p.min, "Minimum"),
        unit: text(p.unit, "Unité", 20),
        buy: num(p.buy, "Prix achat"),
        sell: num(p.sell, "Prix vente"),
      };
      if (d.inventory.some((x) => x.company === r.company && x.sku === r.sku))
        fail("Référence déjà existante.");
    } else if (k === "suppliers") {
      r = {
        ...r,
        company: company(d, u, p.company),
        name: text(p.name, "Nom"),
        contact: text(p.contact, "Contact", 100, true),
        email: text(p.email, "E-mail"),
        phone: text(p.phone, "Téléphone", 40, true),
      };
    } else if (k === "vehicles") {
      r = {
        ...r,
        company: company(d, u, p.company),
        plate: text(p.plate, "Plaque", 30),
        brand: text(p.brand, "Marque"),
        model: text(p.model, "Modèle"),
        km: num(p.km, "Kilométrage"),
        service: p.service ? iso(p.service) : "",
        status: "Disponible",
      };
    } else if (k === "tools") {
      r = {
        ...r,
        company: company(d, u, p.company),
        name: text(p.name, "Nom"),
        serial: text(p.serial, "Numéro de série", 100),
        status: "Disponible",
      };
    } else if (k === "maintenance") {
      const c = company(d, u, p.company),
        cl = ref(d, "clients", p.clientId);
      if (cl.company && cl.company !== c) fail("Client incompatible.");
      r = {
        ...r,
        company: c,
        clientId: cl.id,
        title: text(p.title, "Titre"),
        frequency: text(p.frequency, "Fréquence", 100),
        next: iso(p.next),
        amount: fromCents(cents(p.amount)),
        status: "Actif",
      };
    }
    d[k].push(r);
    result = r;
  } else if (action === "finance.delete" || action === "finance.archive") {
    if (!["quotes", "invoices"].includes(p.kind)) fail("Document invalide.");
    const r = ref(d, p.kind, p.id);
    if (!privileged(u, FIN) || !canFinance(d, u, r)) fail("Accès refusé.", 403);
    if (action === "finance.delete") {
      if (r.status !== "Brouillon") fail("Archivez les documents déjà émis.");
      if (
        p.kind === "invoices" &&
        d.payments.some((pay) => same(pay.invoice, r.id))
      )
        fail("Des paiements sont liés à cette facture.");
      r.deletedAt = now;
      if (r.quoteId) {
        const q = ref(d, "quotes", r.quoteId);
        if (q.invoiceId === r.id) delete q.invoiceId;
      }
      if (r.project) {
        const project = ref(d, "projects", r.project);
        project.invoiceIds = (project.invoiceIds || []).filter(
          (id) => id !== r.id,
        );
      }
    } else {
      r.archivedAt = p.restore ? null : now;
    }
    result = { id: r.id };
  } else if (action === "quote.project") {
    const q = ref(d, "quotes", p.id);
    if (!privileged(u, FIN) || !canFinance(d, u, q)) fail("Accès refusé.", 403);
    result = quoteProject(d, q, now);
  } else if (action === "project.finish") {
    result = finishProject(d, u, ref(d, "projects", p.id), now);
  } else if (action === "record.delete") {
    const k = p.kind;
    const allowed = {
      companies: STAFF,
      inventory: OPS,
      suppliers: OPS,
      vehicles: OPS,
      tools: OPS,
      maintenance: OPS,
      payments: FIN,
      expenses: [...OPS, "accounting"],
      time: [...HR, "manager", "employee"],
      absences: [...HR, "employee"],
      documents: [...OPS, "hr", "accounting", "employee"],
      messages: ROLES,
    };
    if (!allowed[k] || !privileged(u, allowed[k]))
      fail("Suppression non autorisée.", 403);
    const r = ref(d, k, p.id);
    if (!viewState(d, u)[k].some((x) => same(x.id, r.id)))
      fail("Accès refusé.", 403);
    if (k === "messages") {
      r.hiddenFor = [...new Set([...(r.hiddenFor || []), u.id])];
      result = { id: r.id };
    } else {
      if (k === "companies") {
        if (r.id === "group") fail("Le groupe ne peut pas être supprimé.");
        if (
          COLLECTIONS.filter((c) => c !== k).some((c) =>
            d[c].some(
              (x) =>
                same(x.company, r.id) || (x.companies || []).includes(r.id),
            ),
          )
        )
          fail("Cette entreprise contient encore des données liées.");
      }
      if (
        ["tools", "vehicles"].includes(k) &&
        (r.employeeId || r.assignmentHistory?.length)
      )
        fail(
          "Cet équipement possède une attribution ou un historique à conserver.",
        );
      if (
        k === "suppliers" &&
        d.expenses.some(
          (x) =>
            (same(x.supplier, r.id) || x.supplier === r.name) &&
            same(x.company, r.company),
        )
      )
        fail("Ce fournisseur est lié à des dépenses.");
      if (
        k === "documents" &&
        !privileged(u, r.employeeId ? HR : [...OPS, "accounting"]) &&
        !same(r.uploadedBy, u.id)
      )
        fail(
          "Seul l’auteur ou un responsable du dossier peut supprimer ce document.",
          403,
        );
      if (
        k === "time" &&
        u.role === "employee" &&
        (r.status !== "À valider" || !same(r.employeeId, u.employee_id))
      )
        fail("Seules vos heures non validées peuvent être supprimées.", 403);
      if (
        k === "absences" &&
        u.role === "employee" &&
        (r.status !== "En attente" || !same(r.employeeId, u.employee_id))
      )
        fail("Seules vos demandes en attente peuvent être supprimées.", 403);
      if (
        ["time", "expenses"].includes(k) &&
        r.project &&
        d.invoices.some(
          (i) =>
            !i.deletedAt && same(i.project, r.project) && i.completionSnapshot,
        )
      )
        fail(
          "Cette donnée est liée à une facturation de chantier. Elle doit être conservée.",
        );
      if (
        k === "absences" &&
        r.status === "Approuvée" &&
        r.type === "Vacances"
      ) {
        const e = ref(d, "employees", r.employeeId);
        if (!employeeCompanies(e).every((c) => inCompany(u, c)))
          fail("Accès RH à toutes les entreprises du salarié requis.", 403);
        e.vacation = Number(e.vacation || 0) + Number(r.days || 0);
      }
      d[k] = d[k].filter((x) => !same(x.id, r.id));
      if (k === "payments") {
        const inv = ref(d, "invoices", r.invoice);
        inv.paid = fromCents(
          Math.max(
            0,
            Math.round(Number(inv.paid || 0) * 100) -
              Math.round(r.amount * 100),
          ),
        );
        inv.status =
          inv.paid >= inv.amount
            ? "Payée"
            : inv.paid > 0
              ? "Partiellement payée"
              : "Émise";
      }
      if (k === "time" && r.project)
        ref(d, "projects", r.project).hours = d.time
          .filter((t) => same(t.project, r.project))
          .reduce((sum, t) => sum + Number(t.hours || 0), 0);
      if (k === "expenses" && r.project) {
        const project = ref(d, "projects", r.project);
        project.cost = fromCents(
          Math.max(
            0,
            Math.round(Number(project.cost || 0) * 100) -
              Math.round(r.amount * 100),
          ),
        );
      }
      result = { id: r.id };
    }
  } else if (action === "client.update") {
    const r = ref(d, "clients", p.id);
    if (
      !privileged(u, access.clients) ||
      !(r.company ? inCompany(u, r.company) : u.company === "group")
    )
      fail("Modification du client non autorisée.", 403);
    const value = { ...r, ...p };
    const email = text(value.email, "E-mail", 255);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("E-mail invalide.");
    Object.assign(r, {
      name: text(value.name, "Nom"),
      email,
      phone: text(value.phone, "Téléphone", 40, true),
      street: text(value.street, "Rue", 200, true),
      buildingNumber: text(value.buildingNumber, "Numéro", 20, true),
      zip: text(value.zip, "Code postal", 20, true),
      city: text(value.city, "Ville"),
      country: text(value.country || "CH", "Pays", 2).toUpperCase(),
      type: text(value.type, "Type", 80, true),
    });
    result = r;
  } else if (action === "client.delete") {
    const client = ref(d, "clients", p.id);
    if (
      !privileged(u, access.clients) ||
      !(client.company ? inCompany(u, client.company) : u.company === "group")
    )
      fail("Suppression du client non autorisée.", 403);
    if (
      COLLECTIONS.filter((k) => k !== "clients").some((k) =>
        d[k].some((r) => same(r.clientId, client.id)),
      )
    )
      fail(
        "Ce client possède des chantiers, devis, factures ou documents liés. Sa suppression est bloquée pour conserver ces données.",
      );
    d.clients = d.clients.filter((r) => !same(r.id, client.id));
    result = { id: client.id };
  } else if (action === "project.delete") {
    const project = ref(d, "projects", p.id);
    if (!privileged(u, OPS) || !canProject(d, u, project))
      fail("Suppression du chantier non autorisée.", 403);
    const linked = COLLECTIONS.filter((k) => k !== "projects").some((k) =>
      d[k].some((r) => same(r.project, project.id)),
    );
    if (
      linked ||
      project.quoteId ||
      project.invoiceIds?.length ||
      Number(project.hours) > 0 ||
      Number(project.cost) > 0
    )
      fail(
        "Ce chantier contient des données liées (heures, planning, documents, devis, factures ou dépenses). Sa suppression est bloquée pour les conserver.",
      );
    d.projects = d.projects.filter((r) => !same(r.id, project.id));
    result = { id: project.id };
  } else if (action === "project.update") {
    if (!privileged(u, OPS)) fail("Accès refusé.", 403);
    const r = ref(d, "projects", p.id);
    if (!canProject(d, u, r)) fail("Accès refusé.", 403);
    if (!["Planifié", "En cours", "Terminé", "À facturer"].includes(p.status))
      fail("Statut invalide.");
    r.status = p.status;
    r.progress = num(p.progress, "Avancement", 0, 100);
    r.description = text(p.description, "Description", 5000, true);
    if (!Array.isArray(p.team)) fail("Équipe invalide.");
    for (const id of p.team)
      if (!employeeInCompany(ref(d, "employees", id), r.company))
        fail("Salarié d’une autre entreprise.");
    r.team = p.team;
    if (p.status === "Terminé") finishProject(d, u, r, now);
    result = r;
  } else if (action === "employee.update" || action === "employee.assets") {
    const e = ref(d, "employees", p.id);
    if (
      !privileged(u, HR) ||
      !employeeCompanies(e).every((c) => inCompany(u, c))
    )
      fail("Accès RH à toutes les entreprises du salarié requis.", 403);
    if (e.deletedAt) fail("Salarié supprimé.");
    if (action === "employee.update") {
      const value = { ...e, ...p, company: e.company };
      if (value.salary == null || String(value.salary).trim() === "")
        fail("Renseignez le salaire.");
      const salaryPeriod = value.salaryPeriod || "monthly";
      if (!["monthly", "hourly"].includes(salaryPeriod))
        fail("Type de salaire invalide.");
      const email = text(value.email, "E-mail", 255);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("E-mail invalide.");
      Object.assign(e, {
        name: text(value.name, "Nom"),
        job: text(value.job, "Fonction"),
        email,
        phone: text(value.phone, "Téléphone", 40, true),
        salary: fromCents(cents(value.salary)),
        salaryPeriod,
        activity: num(value.activity, "Taux", 1, 100),
        vacation: num(value.vacation, "Solde vacances", 0, 366),
        entry: iso(value.entry),
        ...employeeProfile(value),
      });
    } else {
      const selections = {};
      for (const k of ["tools", "vehicles"]) {
        if (!Array.isArray(p[k])) fail("Sélection de matériel invalide.");
        selections[k] = new Set(p[k].map(String));
        for (const id of selections[k]) {
          const asset = ref(d, k, id);
          if (
            !inCompany(u, asset.company) ||
            !employeeInCompany(e, asset.company)
          )
            fail("Matériel d’une entreprise non autorisée.", 403);
          if (asset.employeeId && !same(asset.employeeId, e.id))
            fail("Cet équipement est déjà attribué à un autre salarié.", 409);
        }
        for (const asset of d[k].filter((a) => same(a.employeeId, e.id)))
          if (!inCompany(u, asset.company))
            fail("Accès à l’entreprise de cet équipement requis.", 403);
      }
      for (const k of ["tools", "vehicles"])
        for (const asset of d[k]) {
          const next = selections[k].has(String(asset.id))
            ? e.id
            : same(asset.employeeId, e.id)
              ? ""
              : asset.employeeId;
          if ((asset.employeeId || "") === (next || "")) continue;
          asset.assignmentHistory ||= [];
          asset.assignmentHistory.push({
            from: asset.employeeId || "",
            to: next || "",
            date: now,
            by: u.id,
          });
          asset.employeeId = next;
        }
    }
    result = e;
  } else if (action === "employee.companies" || action === "employee.delete") {
    const e = ref(d, "employees", p.id);
    if (
      !privileged(u, HR) ||
      !employeeCompanies(e).every((c) => inCompany(u, c))
    )
      fail("Accès RH à toutes les entreprises du salarié requis.", 403);
    if (e.deletedAt) fail("Salarié déjà supprimé.");
    if (
      action === "employee.delete" &&
      d.clocks.some((c) => same(c.employeeId, e.id))
    )
      fail("Terminez le pointage du salarié avant cette modification.");
    if (action === "employee.companies") {
      if (!Array.isArray(p.companies) || !p.companies.length)
        fail("Sélectionnez au moins une entreprise.");
      const companies = [...new Set(p.companies.map((c) => company(d, u, c)))];
      if (!companies.includes(e.company))
        fail("Conservez l’entreprise principale du salarié.");
      if (
        d.planning.some(
          (r) =>
            same(r.employeeId, e.id) &&
            r.date >= now.slice(0, 10) &&
            !companies.includes(recordCompany(d, "planning", r)),
        )
      )
        fail(
          "Retirez les affectations futures des entreprises à supprimer avant de modifier les accès.",
        );
      if (
        d.clocks.some(
          (c) =>
            same(c.employeeId, e.id) &&
            !companies.includes(ref(d, "projects", c.project).company),
        )
      )
        fail("Terminez le pointage avant de retirer son entreprise.");
      if (
        [...d.tools, ...d.vehicles].some(
          (a) => same(a.employeeId, e.id) && !companies.includes(a.company),
        )
      )
        fail(
          "Restituez les outils et véhicules avant de retirer leur entreprise.",
        );
      e.companies = companies;
    } else {
      if ([...d.tools, ...d.vehicles].some((a) => same(a.employeeId, e.id)))
        fail(
          "Restituez les outils et véhicules avant de supprimer le salarié.",
        );
      e.deletedAt = now;
      e.status = "Supprimé";
      d.planning = d.planning.filter(
        (r) => !same(r.employeeId, e.id) || r.date < now.slice(0, 10),
      );
    }
    result = e;
  } else if (action === "finance.settings") {
    const co = ref(d, "companies", company(d, u, p.company));
    if (!privileged(u, FIN)) fail("Accès refusé.", 403);
    const settings = {};
    for (const key of [
      "street",
      "buildingNumber",
      "zip",
      "city",
      "vatNumber",
      "iban",
      "email",
    ])
      settings[key] = text(p[key], key, 200, true);
    settings.country = text(p.country || "CH", "Pays", 2).toUpperCase();
    settings.iban = settings.iban.replace(/\s/g, "").toUpperCase();
    if (settings.iban && !/^(CH|LI)\d{2}[A-Z0-9]{17}$/.test(settings.iban))
      fail("IBAN suisse ou liechtensteinois attendu.");
    if (
      settings.iban &&
      !require("swissqrbill/utils").isIBANValid(settings.iban)
    )
      fail("Clé de contrôle IBAN invalide.");
    settings.defaultMessage = text(p.defaultMessage, "Message", 5000, true);
    settings.defaultTerms = text(p.defaultTerms, "Conditions", 5000, true);
    settings.paymentDays = num(p.paymentDays, "Délai", 0, 365);
    co.billing = settings;
    result = co;
  } else if (action === "finance.update" || action === "finance.duplicate") {
    const k = p.kind;
    if (!["quotes", "invoices"].includes(k)) fail("Document invalide.");
    const r = ref(d, k, p.id);
    if (!privileged(u, FIN) || !canFinance(d, u, r)) fail("Accès refusé.", 403);
    if (action === "finance.update" && r.status !== "Brouillon")
      fail("Seul un brouillon peut être modifié.");
    const out = applyCommand(
      d,
      u,
      {
        action: "create",
        collection: k,
        payload:
          action === "finance.update"
            ? p
            : { ...r, date: iso(p.date), valid: p.valid, due: p.due },
      },
      now,
    ).result;
    if (action === "finance.update") {
      d[k].pop();
      if (r.quoteId && (p.clientId !== r.clientId || p.company !== r.company))
        fail(
          "La facture liée doit conserver le client et l’entreprise du devis.",
        );
      Object.assign(r, out, {
        id: r.id,
        createdAt: r.createdAt,
        updatedAt: now,
      });
      result = r;
    } else result = out;
  } else if (action === "quote.convert") {
    const q = ref(d, "quotes", p.id);
    if (!privileged(u, FIN) || !canFinance(d, u, q)) fail("Accès refusé.", 403);
    if (q.status !== "Accepté")
      fail("Acceptez le devis avant de le convertir.");
    if (
      q.invoiceId ||
      d.invoices.some((i) => i.quoteId === q.id && !i.deletedAt)
    )
      fail("Ce devis a déjà une facture.");
    result = applyCommand(
      d,
      u,
      {
        action: "create",
        collection: "invoices",
        payload: { ...q, date: p.date, due: p.due },
      },
      now,
    ).result;
    result.quoteId = q.id;
    result.issuer = structuredClone(q.issuer || ref(d, "companies", q.company));
    result.customer = structuredClone(
      q.customer || ref(d, "clients", q.clientId),
    );
    q.invoiceId = result.id;
  } else if (action === "quote.decide") {
    const q = ref(d, "quotes", p.id);
    if (!privileged(u, FIN) || !canFinance(d, u, q)) fail("Accès refusé.", 403);
    if (q.status !== "Émise" || q.valid < now.slice(0, 10))
      fail("Devis non émis ou expiré.");
    if (!["Accepté", "Refusé"].includes(p.status)) fail("Décision invalide.");
    const note = text(p.note, "Justificatif de la décision", 1000);
    q.status = p.status;
    q.decisionNote = note;
    q.decidedAt = now;
    q.decidedBy = u.id;
    if (p.status === "Accepté") {
      q.acceptedAt = now;
      q.acceptedBy = u.id;
      quoteProject(d, q, now);
    }
    result = q;
  } else if (action === "invoice.issue" || action === "quote.issue") {
    const k = action.startsWith("invoice") ? "invoices" : "quotes",
      r = ref(d, k, p.id);
    if (!privileged(u, FIN) || !canFinance(d, u, r)) fail("Accès refusé.", 403);
    if (r.status !== "Brouillon") fail("Document déjà émis.");
    if (r.pricingRequired && r.amount <= 0)
      fail(
        "Complétez les prestations et les prix avant d’émettre cette facture.",
      );
    r.issuer ||= structuredClone(ref(d, "companies", r.company));
    r.customer ||= structuredClone(ref(d, "clients", r.clientId));
    r.issuedAt = now;
    r.status = "Émise";
    result = r;
  } else if (action === "quote.accept") {
    const r = ref(d, "quotes", p.id);
    if (
      u.role !== "client" ||
      !same(r.clientId, u.client_id) ||
      !canFinance(d, u, r)
    )
      fail("Accès refusé.", 403);
    if (r.status !== "Émise" || r.valid < now.slice(0, 10))
      fail("Devis non émis ou expiré.");
    r.status = "Accepté";
    r.acceptedAt = now;
    r.acceptedBy = u.id;
    quoteProject(d, r, now);
    result = r;
  } else if (action === "clock.start") {
    if (!u.employee_id) fail("Compte non lié à un salarié.");
    const proj = ref(d, "projects", p.project);
    if (!canProject(d, u, proj)) fail("Chantier non autorisé.", 403);
    if (d.clocks.some((c) => same(c.userId, u.id)))
      fail("Pointage déjà en cours.");
    result = {
      id: randomUUID(),
      userId: u.id,
      employeeId: u.employee_id,
      project: proj.id,
      startedAt: now,
      pauseAt: null,
      breakMs: 0,
    };
    d.clocks.push(result);
  } else if (["clock.pause", "clock.resume", "clock.stop"].includes(action)) {
    const c = d.clocks.find((x) => same(x.userId, u.id));
    if (!c) fail("Aucun pointage actif.");
    if (action === "clock.pause") {
      if (c.pauseAt) fail("Pause déjà active.");
      c.pauseAt = now;
      result = c;
    } else if (action === "clock.resume") {
      if (!c.pauseAt) fail("Aucune pause active.");
      c.breakMs += new Date(now) - new Date(c.pauseAt);
      c.pauseAt = null;
      result = c;
    } else {
      const breaks =
          c.breakMs + (c.pauseAt ? new Date(now) - new Date(c.pauseAt) : 0),
        ms = new Date(now) - new Date(c.startedAt) - breaks;
      if (ms < 0) fail("Durée invalide.");
      result = {
        id: randomUUID(),
        employeeId: c.employeeId,
        project: c.project,
        date: c.startedAt.slice(0, 10),
        startedAt: c.startedAt,
        endedAt: now,
        break: Math.round(breaks / 600) / 100,
        seconds: Math.round(ms / 1000),
        hours: Math.round(ms / 3600) / 1000,
        status: "À valider",
      };
      d.time.push(result);
      d.clocks = d.clocks.filter((x) => x !== c);
      const proj = d.projects.find((x) => same(x.id, c.project));
      if (proj)
        proj.hours = d.time
          .filter((x) => same(x.project, proj.id))
          .reduce((a, x) => a + x.hours, 0);
    }
  } else if (action === "time.add") {
    if (!privileged(u, [...HR, "manager", "employee"]))
      fail("Saisie non autorisée.", 403);
    if (
      u.role === "employee" &&
      p.employeeId &&
      !same(p.employeeId, u.employee_id)
    )
      fail("Vous pouvez saisir uniquement vos heures.", 403);
    const e = ref(
      d,
      "employees",
      u.role === "employee" ? u.employee_id : p.employeeId,
    );
    const proj = ref(d, "projects", p.project);
    if (
      !employeeInCompany(e, proj.company) ||
      !inCompany(u, proj.company) ||
      (u.role === "employee" && !canProject(d, u, proj))
    )
      fail("Affectation non autorisée.", 403);
    const day = iso(p.date),
      start = time(p.start),
      end = time(p.end);
    if (end <= start)
      fail(
        "La fin doit suivre le début. Pour une nuit, saisissez une ligne par jour.",
      );
    const startedAt = swissInstant(day, start),
      endedAt = swissInstant(day, end);
    const pause = num(p.break ?? 0, "Pause", 0, 1440);
    if (!Number.isInteger(pause))
      fail("La pause doit être en minutes entières.");
    const seconds =
      (Date.parse(endedAt) - Date.parse(startedAt)) / 1000 - pause * 60;
    if (seconds <= 0)
      fail("La pause doit être inférieure à la durée travaillée.");
    if (Date.parse(endedAt) > Date.parse(now))
      fail(
        "Les heures travaillées ne peuvent pas être dans le futur. Utilisez le planning.",
      );
    if (d.clocks.some((c) => same(c.employeeId, e.id)))
      fail("Terminez le pointage actif avant d’ajouter des heures.");
    if (
      d.time.some(
        (t) =>
          same(t.employeeId, e.id) &&
          (t.startedAt && t.endedAt
            ? Date.parse(t.startedAt) < Date.parse(endedAt) &&
              Date.parse(t.endedAt) > Date.parse(startedAt)
            : t.date === day && t.start < end && t.end > start),
      )
    )
      fail(
        "Des heures existent déjà sur ce créneau, y compris dans une autre entreprise.",
      );
    result = {
      id: randomUUID(),
      employeeId: e.id,
      company: proj.company,
      project: proj.id,
      date: day,
      startedAt,
      endedAt,
      break: pause,
      seconds,
      hours: Math.round(seconds / 3.6) / 1000,
      status: "À valider",
      source: "manual",
      note: text(p.note, "Commentaire", 1000, true),
      createdAt: now,
      createdBy: u.id,
    };
    d.time.push(result);
    proj.hours = d.time
      .filter((t) => same(t.project, proj.id))
      .reduce((sum, t) => sum + Number(t.hours || 0), 0);
  } else if (action === "time.approve") {
    if (!privileged(u, [...HR, "manager"])) fail("Accès refusé.", 403);
    const r = ref(d, "time", p.id);
    if (
      !inCompany(
        u,
        recordCompany(d, "time", r) ||
          ref(d, "employees", r.employeeId).company,
      )
    )
      fail("Accès refusé.", 403);
    r.status = "Validé";
    result = r;
  } else if (action === "absence.request") {
    const e = ref(
      d,
      "employees",
      u.role === "employee" ? u.employee_id : p.employeeId,
    );
    if (e.deletedAt) fail("Salarié supprimé.");
    if (!(
      (privileged(u, HR) && inCompany(u, e.company)) ||
      (u.role === "employee" && same(e.id, u.employee_id))
    ))
      fail("Accès refusé.", 403);
    const from = iso(p.from),
      to = iso(p.to);
    if (to < from || new Date(to) - new Date(from) > 366 * 86400000)
      fail("Période invalide.");
    if (!["Vacances", "Maladie", "Autre"].includes(p.type))
      fail("Type invalide.");
    const days = weekdays(from, to);
    if (!days) fail("Aucun jour ouvré.");
    if (
      d.absences.some(
        (a) =>
          same(a.employeeId, e.id) &&
          a.status !== "Refusée" &&
          a.from <= to &&
          a.to >= from,
      )
    )
      fail("Une demande couvre déjà cette période.");
    result = {
      id: randomUUID(),
      employeeId: e.id,
      type: p.type,
      from,
      to,
      days,
      comment: text(p.comment, "Commentaire", 1000, true),
      status: "En attente",
    };
    d.absences.push(result);
  } else if (action === "absence.decide") {
    if (!privileged(u, HR)) fail("Accès refusé.", 403);
    const a = ref(d, "absences", p.id),
      e = ref(d, "employees", a.employeeId);
    if (!inCompany(u, e.company)) fail("Accès refusé.", 403);
    if (
      a.status !== "En attente" ||
      !["Approuvée", "Refusée"].includes(p.status)
    )
      fail("Décision invalide.");
    if (p.status === "Approuvée") {
      if (
        d.planning.some(
          (x) => same(x.employeeId, e.id) && x.date >= a.from && x.date <= a.to,
        )
      )
        fail("Retirez les affectations de planning avant validation.");
      if (a.type === "Vacances") {
        if ((e.vacation || 0) < a.days) fail("Solde de vacances insuffisant.");
        e.vacation -= a.days;
      }
    }
    a.status = p.status;
    result = a;
  } else if (action === "planning.delete") {
    if (!privileged(u, OPS)) fail("Accès refusé.", 403);
    const r = ref(d, "planning", p.id);
    if (!inCompany(u, ref(d, "employees", r.employeeId).company))
      fail("Accès refusé.", 403);
    d.planning = d.planning.filter((x) => x !== r);
    result = { id: r.id };
  } else fail("Action inconnue.");
  return { data: d, result };
}
module.exports = {
  employeeCompanies,
  employeeInCompany,
  effectiveUser,
  AppError,
  fail,
  ROLES,
  COLLECTIONS,
  STAFF,
  HR,
  OPS,
  FIN,
  same,
  inCompany,
  privileged,
  emptyState,
  normalize,
  viewState,
  canContact,
  canDocument,
  canProject,
  applyCommand,
  text,
  num,
  cents,
  iso,
  ref,
  weekdays,
};
