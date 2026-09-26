"use strict";
const $ = (id) => document.getElementById(id);
const companyLogoPath = (id, issuer) =>
  `/assets/logos/${SousaFinance.companyBrand(id, issuer || state?.companies.find((c) => c.id === id))}.png`;
let financeClientDraft = null;
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const money = (n) =>
  new Intl.NumberFormat("fr-CH", {
    style: "currency",
    currency: "CHF",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(n) || 0);
const date = (v) =>
  v
    ? new Date(v.length === 10 ? v + "T12:00:00" : v).toLocaleDateString(
        "fr-CH",
      )
    : "—";
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Zurich",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const same = (a, b) => a != null && b != null && String(a) === String(b);
let token = sessionStorage.getItem("sgo_session"),
  state = null,
  profile = null,
  contacts = [],
  revision = 0,
  page = "dashboard",
  company = "",
  selectedRecipient = "",
  userAccounts = [],
  pending = false,
  lastFocus;
// Remove data cached by the previous version, including the old long-lived token.
localStorage.removeItem("sgo_token");
localStorage.removeItem("sgo_complete_v4");
const roles = {
  admin: "Administration",
  direction: "Direction",
  hr: "RH",
  manager: "Responsable",
  accounting: "Comptabilité",
  employee: "Salarié",
  client: "Client",
};
const core = ["admin", "direction"],
  hr = [...core, "hr"],
  ops = [...core, "manager"],
  fin = [...core, "accounting"];
const menus = {
  dashboard: ["Tableau de bord", Object.keys(roles)],
  companies: ["Entreprises", core],
  employees: ["Salariés et comptes", [...hr, "manager"]],
  time: ["Heures", [...hr, "manager", "accounting", "employee"]],
  planning: ["Planning", [...hr, "manager", "employee"]],
  absences: ["Absences", [...hr, "manager", "employee"]],
  projects: ["Chantiers", [...ops, "accounting", "employee", "client"]],
  clients: ["Clients", [...ops, "accounting"]],
  quotes: ["Devis", [...fin, "client"]],
  invoices: ["Factures", [...fin, "client"]],
  payments: ["Paiements", fin],
  expenses: ["Dépenses", [...ops, "accounting"]],
  inventory: ["Matériel", [...ops, "accounting", "employee"]],
  suppliers: ["Fournisseurs", [...ops, "accounting"]],
  vehicles: ["Véhicules", [...ops, "accounting"]],
  tools: ["Outillage", [...ops, "accounting", "employee"]],
  maintenance: ["Maintenance", [...ops, "accounting", "client"]],
  documents: ["Documents", Object.keys(roles)],
  messages: ["Messages", Object.keys(roles)],
  reports: ["Rapports", [...core, "hr", "accounting", "manager"]],
  users: ["Comptes", ["admin"]],
  audit: ["Journal", hr],
  settings: ["Mon compte", Object.keys(roles)],
};
const createRoles = {
  companies: core,
  employees: hr,
  clients: [...ops, "accounting"],
  projects: ops,
  planning: ops,
  quotes: fin,
  invoices: fin,
  payments: fin,
  expenses: [...ops, "accounting"],
  inventory: ops,
  suppliers: ops,
  vehicles: ops,
  tools: ops,
  maintenance: ops,
};
const can = (rs) => rs.includes(profile?.role);
const visible = (k) =>
  (state?.[k] || []).filter((x) => {
    if (k === "employees" && x.deletedAt) return false;
    if (!company) return true;
    const employee =
      k === "employees"
        ? x
        : state.employees.find((e) => same(e.id, x.employeeId));
    if (k === "employees" || k === "absences")
      return (
        !employee ||
        [employee.company, ...(employee.companies || [])].includes(company)
      );
    const scope =
      x.company ||
      (x.project &&
        state.projects.find((p) => same(p.id, x.project))?.company) ||
      employee?.company;
    return !scope || scope === company;
  });
const find = (k, id) => state[k]?.find((x) => same(x.id, id));
const name = (k, id) => {
  const r = find(k, id);
  return r?.name || r?.title || id || "—";
};
const btn = (label, action, id = "", kind = "secondary") =>
  `<button type="button" class="btn ${kind}" data-action="${esc(action)}" data-id="${esc(id)}">${esc(label)}</button>`;
const badge = (s) => `<span class="status neutral">${esc(s)}</span>`;
const kpi = (label, value) =>
  `<article class="card kpi"><p class="muted">${esc(label)}</p><b class="kpi-value">${esc(value)}</b></article>`;
const cards = (items) =>
  `<div class="grid g3 section">${items.map((x) => kpi(...x)).join("")}</div>`;
function table(headers, rows) {
  return rows.length
    ? `<article class="card"><div class="table"><table><thead><tr>${headers.map((x) => `<th>${esc(x)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((x) => `<td>${x ?? ""}</td>`).join("")}</tr>`).join("")}</tbody></table></div></article>`
    : '<article class="card empty">Aucun élément pour le moment.</article>';
}
function heading(title, actions = "") {
  return `<div class="section-head"><h3>${esc(title)}</h3><div class="actions">${actions}</div></div>`;
}
function toast(t) {
  $("toast").textContent = t;
  $("toast").classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("toast").classList.add("hidden"), 4500);
}
function notice(t) {
  $("notice").textContent = t;
  $("notice").classList.toggle("hidden", !t);
}
async function api(path, body) {
  const r = await fetch("/api/" + path, {
    method: body ? "POST" : "GET",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && path !== "auth/login") clearSession();
    const e = new Error(data.error || "Réponse serveur invalide.");
    e.status = r.status;
    throw e;
  }
  return data;
}
function clearSession() {
  document.body.dataset.brand = "group";
  token = null;
  state = null;
  profile = null;
  contacts = [];
  userAccounts = [];
  selectedRecipient = "";
  company = "";
  page = "dashboard";
  revision = 0;
  sessionStorage.removeItem("sgo_session");
  $("content").replaceChildren();
  $("modalBody").replaceChildren();
  $("printArea").replaceChildren();
  $("modalWrap").classList.add("hidden");
  $("app").classList.add("hidden");
  $("login").classList.remove("hidden");
}
async function refresh(renderNow = true) {
  const out = await api("state");
  state = out.data;
  revision = out.revision;
  profile = out.profile;
  contacts = out.contacts;
  if (renderNow) render();
}
async function mutate(
  action,
  payload = {},
  collection,
  endpoint = "state/command",
  form,
) {
  if (pending) return;
  pending = true;
  const buttons = [...document.querySelectorAll("button[type=submit]")];
  buttons.forEach((b) => (b.disabled = true));
  let saved = false;
  const requestId = form?.dataset.requestId || crypto.randomUUID();
  if (form) form.dataset.requestId = requestId;
  try {
    const out = await api(endpoint, {
      action,
      payload,
      collection,
      revision,
      requestId,
    });
    saved = true;
    if (form) delete form.dataset.requestId;
    await refresh();
    closeModal(true);
    notice("");
    toast("Modification enregistrée.");
    return out.result;
  } catch (e) {
    if (e.status === 409) {
      if (form) delete form.dataset.requestId;
      await refresh(false).catch(() => {});
      e.message += " Votre formulaire est conservé.";
    }
    if (saved) {
      closeModal(true);
      notice(
        "Modification enregistrée, mais actualisation impossible. Cliquez sur Actualiser.",
      );
    } else {
      const target = $("formError");
      if (target) target.textContent = e.message;
      else notice(e.message);
    }
  } finally {
    pending = false;
    buttons.forEach((b) => (b.disabled = false));
  }
}
$("loginForm").onsubmit = async (e) => {
  e.preventDefault();
  const b = e.target.querySelector("button");
  b.disabled = true;
  $("loginError").textContent = "";
  try {
    const out = await api("auth/login", {
      email: $("email").value,
      password: $("password").value,
    });
    token = out.token;
    sessionStorage.setItem("sgo_session", token);
    await refresh(false);
    $("password").value = "";
    $("login").classList.add("hidden");
    $("app").classList.remove("hidden");
    render();
  } catch (err) {
    $("loginError").textContent = err.message;
    clearSession();
  } finally {
    b.disabled = false;
  }
};
$("companyFilter").onchange = (e) => {
  company = e.target.value;
  render();
};
function render() {
  if (!state || !profile) return;
  if (company && !state.companies.some((c) => c.id === company)) company = "";
  const activeCompanyId = company || profile.company;
  document.body.dataset.brand = SousaFinance.companyBrand(
    activeCompanyId,
    state.companies.find((c) => c.id === activeCompanyId),
  );
  if (!menus[page]?.[1].includes(profile.role)) page = "dashboard";
  $("title").textContent = menus[page][0];
  $("userName").textContent = profile.name + " · " + roles[profile.role];
  $("nav").innerHTML = Object.entries(menus)
    .filter(([k, [, rs]]) => rs.includes(profile.role) && k !== "users")
    .map(
      ([k, [label]]) =>
        `<button class="nav-item ${page === k ? "active" : ""}" data-page="${k}">${esc(label)}</button>`,
    )
    .join("");
  $("companyFilter").innerHTML =
    '<option value="">Toutes mes données</option>' +
    state.companies
      .filter((c) => c.id !== "group")
      .map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`)
      .join("");
  $("companyFilter").value = company;
  $("activeCompanyLogo").src = companyLogoPath(company || profile.company);
  $("activeCompanyLogo").alt =
    name("companies", company || profile.company) || "Sousa Group";
  $("content").innerHTML = views[page] ? views[page]() : genericPage(page);
  if (
    (page === "users" || page === "employees") &&
    profile.role === "admin" &&
    profile.company === "group"
  )
    loadUsers();
  if (page === "audit") loadAudit();
}
function projectRows(list) {
  return table(
    ["Chantier", "Client", "Statut", "Avancement", "Actions"],
    list.map((p) => [
      esc(p.title) + "<br><small>" + esc(p.id) + "</small>",
      esc(name("clients", p.clientId)),
      badge(p.status),
      esc(p.progress || 0) + " %",
      btn("Ouvrir", "project", p.id),
    ]),
  );
}
function sum(k, field) {
  return visible(k).reduce((n, r) => n + (Number(r[field]) || 0), 0);
}
function dashboard() {
  if (profile.role === "client")
    return (
      heading("Mes chantiers") +
      cards([
        ["Chantiers", visible("projects").length],
        ["Factures", visible("invoices").length],
        [
          "Solde à payer",
          money(sum("invoices", "amount") - sum("invoices", "paid")),
        ],
      ]) +
      projectRows(visible("projects"))
    );
  if (profile.role === "employee") {
    const e = find("employees", profile.employee_id);
    return (
      cards([
        ["Heures enregistrées", sum("time", "hours").toFixed(2) + " h"],
        ["Vacances disponibles", (e?.vacation ?? 0) + " jours"],
        ["Chantiers affectés", visible("projects").length],
      ]) +
      clockView() +
      projectRows(visible("projects"))
    );
  }
  return (
    cards([
      ["Salariés visibles", visible("employees").length],
      [
        "Chantiers ouverts",
        visible("projects").filter((p) => p.status !== "Terminé").length,
      ],
      ["Encaissements enregistrés", money(sum("payments", "amount"))],
    ]) +
    heading("Chantiers") +
    projectRows(visible("projects"))
  );
}
function clockView() {
  if (!profile.employee_id) return "";
  const c = state.clocks[0];
  return `<article class="card section"><h3>Mon pointage</h3><p>${c ? `Commencé le ${esc(new Date(c.startedAt).toLocaleString("fr-CH"))} · ${c.pauseAt ? "En pause" : "En cours"}` : "Aucun pointage actif"}</p>${c ? btn(c.pauseAt ? "Reprendre" : "Pause", c.pauseAt ? "clock.resume" : "clock.pause") + " " + btn("Terminer", "clock.stop", "", "danger") : `<label for="clockProject">Chantier</label><select id="clockProject">${options("projects")}</select>${btn("Commencer", "clock.start", "", "primary")}`}</article>`;
}
function timeView() {
  return (
    clockView() +
    heading(
      "Heures enregistrées",
      (can([...hr, "manager", "employee"])
        ? btn("Ajouter des heures", "time-add", "", "primary") + " "
        : "") + btn("Exporter CSV", "export", "time"),
    ) +
    table(
      ["Salarié", "Chantier", "Début", "Fin", "Pause", "Heures", "Statut", ""],
      visible("time").map((t) => [
        esc(name("employees", t.employeeId)),
        esc(name("projects", t.project)),
        esc(
          t.startedAt
            ? new Date(t.startedAt).toLocaleString("fr-CH", {
                timeZone: "Europe/Zurich",
              })
            : t.start,
        ),
        esc(
          t.endedAt
            ? new Date(t.endedAt).toLocaleString("fr-CH", {
                timeZone: "Europe/Zurich",
              })
            : t.end,
        ),
        esc(t.break) + " min",
        Number(t.hours).toFixed(2),
        badge(t.status),
        can([...hr, "manager"]) && t.status !== "Validé"
          ? btn("Valider", "time.approve", t.id)
          : "",
      ]),
    )
  );
}
let planningDate = today(),
  planningMode = "week",
  planningEmployee = "";
function manualTimeForm() {
  formShell(
    [
      ...(profile.role === "employee"
        ? []
        : [["employeeId", "Salarié", "@employees"]]),
      ["project", "Chantier", "@projects"],
      ["date", "Date", "date", today()],
      ["start", "Début", "time", "08:00"],
      ["end", "Fin", "time", "12:00"],
      ["break", "Pause (minutes)", "number", "0"],
      ["note", "Commentaire", "textarea?"],
    ],
    "time.add",
    '<p class="muted">Horaires suisses. La pause est déduite automatiquement. Les heures seront à valider. Pour une nuit, saisissez une ligne par jour.</p>',
    "Ajouter des heures",
  );
  if (profile.role === "employee")
    $("entityForm").insertAdjacentHTML(
      "beforeend",
      `<input type="hidden" id="f_employeeId" name="employeeId" value="${esc(profile.employee_id)}">`,
    );
  planningProjects();
}
function planningDay(value, offset = 0) {
  const d = new Date(value + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
function planningWeek() {
  const day = new Date(planningDate + "T12:00:00Z").getUTCDay();
  const start = planningDay(planningDate, -((day + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => planningDay(start, i));
}
function planningForm(employeeId = "", day = planningDate, copy = null) {
  newForm("planning");
  if (employeeId) $("f_employeeId").value = employeeId;
  planningProjects();
  $("f_date").value = day;
  $("f_start").value = copy?.start || "08:00";
  $("f_end").value = copy?.end || "12:00";
  if (copy) {
    $("f_project").value = copy.project;
    $("f_location").value = copy.location || "";
  }
}
function planningProjects() {
  const employee = find("employees", $("f_employeeId").value);
  const previous = $("f_project").value;
  const projects = visible("projects").filter((p) =>
    [employee?.company, ...(employee?.companies || [])].includes(p.company),
  );
  $("f_project").innerHTML = projects.length
    ? projects
        .map((p) => `<option value="${esc(p.id)}">${esc(p.title)}</option>`)
        .join("")
    : '<option value="">Aucun chantier pour cette entreprise</option>';
  if (projects.some((p) => same(p.id, previous)))
    $("f_project").value = previous;
}
function planningView() {
  const days = planningWeek();
  const staff = visible("employees").filter(
    (e) => profile.role !== "employee" || same(e.id, profile.employee_id),
  );
  if (!staff.some((e) => same(e.id, planningEmployee))) planningEmployee = "";
  const selected = staff.filter(
    (e) => !planningEmployee || same(e.id, planningEmployee),
  );
  const entries = visible("planning")
    .filter(
      (p) =>
        p.date >= days[0] &&
        p.date <= days[6] &&
        selected.some((e) => same(e.id, p.employeeId)),
    )
    .sort(
      (a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start),
    );
  const hours = (rows) =>
    rows
      .reduce((sum, p) => {
        const minutes = (t) =>
          Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
        return sum + (minutes(p.end) - minutes(p.start)) / 60;
      }, 0)
      .toLocaleString("fr-CH", { maximumFractionDigits: 2 });
  const controls = `<div class="planning-controls">${btn("‹ Semaine précédente", "planning-nav", "-7")}${btn("Aujourd’hui", "planning-nav", "today")}${btn("Semaine suivante ›", "planning-nav", "7")}<label>Date<input id="planningDate" type="date" value="${planningDate}"></label><label>Salarié<select id="planningEmployee"><option value="">Toute l’équipe</option>${staff.map((e) => `<option value="${esc(e.id)}" ${same(e.id, planningEmployee) ? "selected" : ""}>${esc(e.name)}</option>`).join("")}</select></label>${btn("Semaine par salarié", "planning-mode", "week", planningMode === "week" ? "primary" : "")}${btn("Liste de la semaine", "planning-mode", "list", planningMode === "list" ? "primary" : "")}</div><p class="muted">Du ${date(days[0])} au ${date(days[6])} · ${selected.length} salarié(s) · ${hours(entries)} h planifiées, pauses non déduites.</p>`;
  const calendar = `<div class="planning-scroll" role="region" aria-label="Calendrier hebdomadaire par salarié" tabindex="0"><table class="planning-calendar"><caption>Planning du ${date(days[0])} au ${date(days[6])}</caption><thead><tr><th scope="col">Salarié / heures</th>${days.map((d, i) => `<th scope="col" class="${d === today() ? "planning-today" : ""}">${["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"][i]} ${date(d)}</th>`).join("")}</tr></thead><tbody>${selected
    .map(
      (e) =>
        `<tr><th scope="row">${esc(e.name)}<small>${hours(entries.filter((p) => same(p.employeeId, e.id)))} h planifiées</small></th>${days
          .map((d) => {
            const shifts = entries.filter(
              (p) => same(p.employeeId, e.id) && p.date === d,
            );
            const absent = state.absences.some(
              (a) =>
                same(a.employeeId, e.id) &&
                a.status === "Approuvée" &&
                a.from <= d &&
                a.to >= d,
            );
            return `<td class="${d === today() ? "planning-today" : ""}">${absent ? '<div class="planning-absence">Absent · validé</div>' : ""}${shifts.map((p) => `<button class="planning-shift" data-action="planning-detail" data-id="${esc(p.id)}"><b>${esc(p.start)}–${esc(p.end)}</b><span>${esc(name("projects", p.project))}</span>${p.location ? `<small>${esc(p.location)}</small>` : ""}</button>`).join("")}${!shifts.length && !absent ? '<span class="planning-empty">Sans affectation</span>' : ""}${can(ops) && !absent ? `<button class="planning-add" data-action="planning-slot" data-employee="${esc(e.id)}" data-date="${d}" aria-label="Planifier ${esc(e.name)} le ${date(d)}">+ Planifier</button>` : ""}</td>`;
          })
          .join("")}</tr>`,
    )
    .join("")}</tbody></table></div>`;
  return (
    heading(
      "Planning de l’équipe",
      (can(ops) ? btn("Planifier", "new", "planning", "primary") + " " : "") +
        btn("Exporter CSV", "export", "planning"),
    ) +
    controls +
    (selected.length
      ? planningMode === "week"
        ? calendar
        : table(
            ["Date", "Début", "Fin", "Salarié", "Chantier", "Lieu", ""],
            entries.map((p) => [
              date(p.date),
              esc(p.start),
              esc(p.end),
              esc(name("employees", p.employeeId)),
              esc(name("projects", p.project)),
              esc(p.location),
              btn("Détails", "planning-detail", p.id),
            ]),
          )
      : '<p class="empty">Aucun salarié dans cette vue.</p>') +
    '<p class="muted">Une ligne par salarié. Cliquez sur un créneau pour ses détails ou sur + Planifier pour ajouter une affectation. Sur téléphone, faites défiler le calendrier horizontalement ou utilisez la liste. Les absences validées et les chevauchements sont bloqués à l’enregistrement.</p>'
  );
}
function absenceView() {
  return (
    heading(
      "Absences",
      can([...hr, "employee"])
        ? btn("Demander une absence", "absence-form", "", "primary")
        : "",
    ) +
    table(
      ["Salarié", "Type", "Du", "Au", "Jours ouvrés", "État", ""],
      visible("absences").map((a) => [
        esc(name("employees", a.employeeId)),
        esc(a.type),
        date(a.from),
        date(a.to),
        esc(a.days),
        badge(a.status),
        can(hr) && a.status === "En attente"
          ? btn("Approuver", "absence.approve", a.id) +
            " " +
            btn("Refuser", "absence.reject", a.id)
          : "",
      ]),
    )
  );
}
let showArchivedFinance = false;
function financeView(k) {
  const quote = k === "quotes";
  return (
    heading(
      quote ? "Devis" : "Factures",
      can(fin)
        ? btn("Créer", "new", k, "primary") +
            " " +
            btn("Exporter CSV", "export", k) +
            " " +
            btn("Paramètres de facturation", "billing-settings") +
            " " +
            btn(
              showArchivedFinance
                ? "Masquer les archives"
                : "Afficher les archives",
              "finance-archives",
            )
        : "",
    ) +
    table(
      [
        "Numéro",
        "Client",
        "Objet",
        "Montant",
        "Échéance",
        ...(quote ? [] : ["Payé", "Solde"]),
        "Statut",
        "",
      ],
      visible(k)
        .filter((r) => showArchivedFinance || !r.archivedAt)
        .map((r) => [
          esc(r.id),
          esc(name("clients", r.clientId)),
          esc(r.title),
          money(r.amount),
          date(quote ? r.valid : r.due),
          ...(quote ? [] : [money(r.paid), money(r.amount - (r.paid || 0))]),
          badge(
            !quote &&
              r.status !== "Brouillon" &&
              r.status !== "Payée" &&
              r.due < today()
              ? "En retard"
              : r.status,
          ),
          btn("Ouvrir", quote ? "quote" : "invoice", r.id) +
            (r.archivedAt ? " · Archivé" : ""),
        ]),
    )
  );
}
function documentsView() {
  return (
    heading(
      "Documents",
      profile.role !== "client"
        ? btn("Ajouter un fichier", "document-form", "", "primary")
        : "",
    ) +
    table(
      ["Fichier", "Dossier", "Taille", "Date", ""],
      visible("documents").map((d) => [
        esc(d.name),
        esc(
          d.project ||
            name(
              d.employeeId ? "employees" : "clients",
              d.employeeId || d.clientId,
            ),
        ),
        Math.ceil(d.size / 1024) + " Ko",
        date(d.createdAt),
        btn("Télécharger", "download", d.id),
      ]),
    )
  );
}
function messagesView() {
  if (!contacts.length)
    return '<article class="card empty">Aucun destinataire disponible. Un administrateur doit créer et activer les comptes des interlocuteurs.</article>';
  if (!contacts.some((c) => same(c.id, selectedRecipient)))
    selectedRecipient = String(contacts[0].id);
  const list = state.messages.filter(
    (m) =>
      same(m.senderId, selectedRecipient) ||
      same(m.recipientId, selectedRecipient),
  );
  return `<article class="card"><label for="recipient">Conversation avec</label><select id="recipient">${contacts.map((c) => `<option value="${c.id}" ${same(c.id, selectedRecipient) ? "selected" : ""}>${esc(c.name)} · ${esc(roles[c.role])}</option>`).join("")}</select><div class="messages">${list.map((m) => `<div class="message ${same(m.senderId, profile.id) ? "mine" : ""}"><p class="prewrap">${esc(m.text)}</p><small>${esc(m.sender)} · ${esc(new Date(m.createdAt).toLocaleString("fr-CH"))}</small></div>`).join("") || '<p class="muted">Aucun message.</p>'}</div><form id="messageForm"><label for="messageText">Message</label><textarea id="messageText" name="text" maxlength="5000" required></textarea><p id="formError" class="error" role="alert"></p><button type="submit" class="btn primary">Envoyer</button></form></article>`;
}
function reportsView() {
  const months = new Map();
  for (const p of visible("payments")) {
    const m = p.date.slice(0, 7);
    months.set(m, (months.get(m) || 0) + p.amount);
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
const views = {
  dashboard,
  time: timeView,
  planning: planningView,
  absences: absenceView,
  projects: () =>
    heading(
      "Chantiers",
      can(ops) ? btn("Créer un chantier", "new", "projects", "primary") : "",
    ) + projectRows(visible("projects")),
  quotes: () => financeView("quotes"),
  invoices: () => financeView("invoices"),
  documents: documentsView,
  messages: messagesView,
  reports: reportsView,
  employees: () =>
    genericPage("employees") +
    (profile.role === "admin" && profile.company === "group"
      ? heading(
          "Autres comptes",
          btn("Créer un accès", "user-form", "", "primary"),
        ) +
        '<p class="muted">Comptes sans fiche salarié active : clients, partenaires et administration.</p><div id="usersList">Chargement…</div>'
      : ""),
  users: () =>
    heading(
      "Comptes utilisateurs",
      btn("Créer un accès", "user-form", "", "primary"),
    ) + '<div id="usersList">Chargement…</div>',
  audit: () =>
    heading("Journal serveur") + '<div id="auditList">Chargement…</div>',
  settings: () =>
    heading("Mon compte") +
    `<article class="card"><p>${esc(profile.email)}</p><p>Authentification : mot de passe. Double authentification non configurée.</p>${btn("Changer mon mot de passe", "password-form")}<p class="muted">Les sauvegardes de la base et des fichiers doivent être configurées chez l’hébergeur. Aucun statut de sauvegarde automatique n’est présumé.</p></article>`,
};
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
    ["brand", "Marque"],
    ["model", "Modèle"],
    ["km", "Kilométrage"],
    ["service", "Entretien"],
  ],
  tools: [
    ["name", "Nom"],
    ["serial", "N° série"],
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
function genericPage(k) {
  const cols = columns[k] || [];
  return (
    heading(
      menus[k][0],
      (createRoles[k] && can(createRoles[k])
        ? btn("Ajouter", "new", k, "primary") + " "
        : "") + btn("Exporter CSV", "export", k),
    ) +
    table(
      [
        ...cols.map((c) => c[1]),
        ...(k === "employees" ? ["Fiche et compte"] : []),
        ...(k === "clients" && profile.role === "admin" ? ["Accès"] : []),
      ],
      visible(k).map((r) => [
        ...cols.map(([f]) =>
          ["amount", "buy", "sell", "salary"].includes(f)
            ? money(r[f])
            : ["date", "next", "service"].includes(f)
              ? date(r[f])
              : f === "clientId"
                ? esc(name("clients", r[f]))
                : f === "company"
                  ? k === "employees"
                    ? [...new Set([r.company, ...(r.companies || [])])]
                        .map((c) => esc(name("companies", c)))
                        .join(" · ")
                    : esc(name("companies", r[f]))
                  : k === "companies" && f === "name"
                    ? `<span class="company-identity"><img class="company-row-logo" src="${companyLogoPath(r.id)}" alt="" />${esc(r[f])}</span>`
                    : esc(r[f] ?? "—"),
        ),
        ...(k === "employees"
          ? [
              btn("Ouvrir la fiche", "employee-detail", r.id) +
                `<div data-employee-account="${esc(r.id)}" class="muted">${profile.role === "admin" && profile.company === "group" ? "Chargement du compte…" : ""}</div>` +
                (can(hr)
                  ? " " +
                    btn("Entreprises / accès", "employee-companies", r.id) +
                    " " +
                    btn("Supprimer", "employee-delete", r.id, "danger")
                  : ""),
            ]
          : []),
        ...(k === "clients" && profile.role === "admin"
          ? [btn("Créer un compte", "linked-user", k + ":" + r.id)]
          : []),
      ]),
    )
  );
}
function options(k, blank = false) {
  return (
    (blank ? '<option value="">Aucun</option>' : "") +
    (state[k] || [])
      .filter((r) => k !== "employees" || !r.deletedAt)
      .filter((r) => k !== "companies" || r.id !== "group")
      .map(
        (r) =>
          `<option value="${esc(r.id)}">${esc(r.name || r.title || r.id)}</option>`,
      )
      .join("")
  );
}
// Field definitions shared by the creation dialogs; server validation remains authoritative.
const schemas = {
  companies: [
    ["name", "Nom"],
    ["code", "Code"],
    ["type", "Secteur"],
  ],
  employees: [
    ["name", "Nom"],
    ["job", "Fonction"],
    ["company", "Entreprise", "@companies"],
    ["email", "E-mail", "email"],
    ["phone", "Téléphone", "tel?"],
    ["salary", "Salaire mensuel CHF", "number"],
    ["activity", "Taux d’activité %", "number", "100"],
    ["vacation", "Solde de vacances (jours)", "number", "20"],
    ["entry", "Date d’entrée", "date"],
  ],
  clients: [
    ["name", "Nom"],
    ["company", "Entreprise", "@companies"],
    ["email", "E-mail", "email"],
    ["phone", "Téléphone", "tel?"],
    ["street", "Rue", "text?"],
    ["buildingNumber", "Numéro", "text?"],
    ["zip", "Code postal", "text?"],
    ["city", "Ville"],
    ["country", "Pays (code ISO)", "text", "CH"],
    ["type", "Type", "text?"],
  ],
  projects: [
    ["title", "Titre"],
    ["company", "Entreprise", "@companies"],
    ["clientId", "Client", "@clients"],
    ["address", "Adresse"],
    ["start", "Début", "date"],
    ["end", "Fin", "date"],
    ["budget", "Budget CHF", "number"],
    ["description", "Description", "textarea?"],
  ],
  planning: [
    ["employeeId", "Salarié", "@employees"],
    ["project", "Chantier", "@projects"],
    ["date", "Date", "date"],
    ["start", "Début", "time"],
    ["end", "Fin", "time"],
    ["location", "Lieu", "text?"],
  ],
  quotes: [
    ["company", "Entreprise", "@companies"],
    ["clientId", "Client", "@clients"],
    ["project", "Chantier", "@projects?"],
    ["title", "Objet"],
    ["date", "Date", "date"],
    ["valid", "Valable jusqu’au", "date"],
  ],
  invoices: [
    ["company", "Entreprise", "@companies"],
    ["clientId", "Client", "@clients"],
    ["project", "Chantier", "@projects?"],
    ["title", "Objet"],
    ["date", "Date", "date"],
    ["due", "Échéance", "date"],
  ],
  payments: [
    ["invoice", "Facture", "@invoices"],
    ["amount", "Montant CHF", "number"],
    ["date", "Date", "date"],
    ["method", "Mode", "text", "Virement"],
  ],
  expenses: [
    ["company", "Entreprise", "@companies"],
    ["supplier", "Fournisseur"],
    ["project", "Chantier", "@projects?"],
    ["amount", "Montant CHF", "number"],
    ["date", "Date", "date"],
  ],
  inventory: [
    ["company", "Entreprise", "@companies"],
    ["sku", "Référence"],
    ["name", "Nom"],
    ["category", "Catégorie", "text?"],
    ["stock", "Stock", "number", "0"],
    ["min", "Minimum", "number", "0"],
    ["unit", "Unité", "text", "pcs"],
    ["buy", "Achat CHF", "number", "0"],
    ["sell", "Vente CHF", "number", "0"],
  ],
  suppliers: [
    ["company", "Entreprise", "@companies"],
    ["name", "Nom"],
    ["contact", "Contact", "text?"],
    ["email", "E-mail", "email"],
    ["phone", "Téléphone", "tel?"],
  ],
  vehicles: [
    ["company", "Entreprise", "@companies"],
    ["plate", "Plaque"],
    ["brand", "Marque"],
    ["model", "Modèle"],
    ["km", "Kilométrage", "number", "0"],
    ["service", "Prochain entretien", "date?"],
  ],
  tools: [
    ["company", "Entreprise", "@companies"],
    ["name", "Nom"],
    ["serial", "Numéro de série"],
  ],
  maintenance: [
    ["company", "Entreprise", "@companies"],
    ["clientId", "Client", "@clients"],
    ["title", "Titre"],
    ["frequency", "Fréquence", "text", "Mensuelle"],
    ["next", "Prochaine visite", "date"],
    ["amount", "Valeur annuelle CHF", "number"],
  ],
};
function field([key, label, type = "text", value = ""]) {
  const optional = type.endsWith("?");
  type = type.replace("?", "");
  const required = optional ? "" : "required",
    attr = `id="f_${key}" name="${key}" ${required}`;
  return (
    `<label for="f_${key}">${esc(label)}${optional ? " (facultatif)" : ""}</label>` +
    (type.startsWith("@")
      ? `<select ${attr}>${options(type.slice(1), optional)}</select>`
      : type === "textarea"
        ? `<textarea ${attr} maxlength="5000">${esc(value)}</textarea>`
        : `<input ${attr} type="${type}" value="${esc(value || (type === "date" ? today() : ""))}" ${type === "number" ? 'min="0" step="0.01"' : ""} ${type === "password" ? (key === "currentPassword" ? 'autocomplete="current-password"' : 'minlength="12" autocomplete="new-password"') : ""}>`)
  );
}
function modal(title, html) {
  lastFocus = document.activeElement;
  $("modalTitle").textContent = title;
  $("modalBody").innerHTML = html;
  $("modalWrap").classList.remove("hidden");
  $("modalBody").querySelector("input,select,button")?.focus();
}
function closeModal(force = false) {
  if (pending && !force) return;
  $("modalWrap").classList.add("hidden");
  $("modalBody").replaceChildren();
  lastFocus?.focus();
}
function formShell(fields, kind, extra = "", title = "Ajouter") {
  modal(
    title,
    `<form id="entityForm" data-kind="${esc(kind)}">${fields.map(field).join("")}${extra}<p id="formError" role="alert" class="error"></p><div class="form-actions">${btn("Annuler", "close-modal")}<button type="submit" class="btn primary">Enregistrer</button></div></form>`,
  );
}
function lineRow(l = {}) {
  return `<div class="invoice-line"><label>Description<input name="lineDescription" required maxlength="500" value="${esc(l.description || "")}"></label><label class="line-details">Détails de la prestation<textarea name="lineDetails" maxlength="5000" rows="3">${esc(l.details || "")}</textarea></label><label>Quantité<input name="lineQuantity" type="number" step="0.001" min="0.001" value="${esc(l.quantity ?? 1)}" required></label><label>Unité<input name="lineUnit" maxlength="30" value="${esc(l.unit || "pcs")}"></label><label>Prix HT CHF<input name="linePrice" type="number" step="0.01" min="0" value="${esc(l.unitPrice ?? "")}" required></label><label>Remise %<input name="lineDiscount" type="number" step="0.01" min="0" max="100" value="${esc(l.discount ?? 0)}" required></label><label>TVA %<input name="lineVat" type="number" step="0.01" min="0" max="100" list="vatRates" value="${esc(l.vatRate ?? 0)}" required></label>${btn("Retirer", "remove-line")}</div>`;
}
function financeLines(f = $("entityForm")) {
  return [...f.querySelectorAll(".invoice-line")].map((row) =>
    Object.fromEntries(
      [
        ["description", "lineDescription"],
        ["details", "lineDetails"],
        ["quantity", "lineQuantity"],
        ["unit", "lineUnit"],
        ["unitPrice", "linePrice"],
        ["discount", "lineDiscount"],
        ["vatRate", "lineVat"],
      ].map(([key, name]) => [key, row.querySelector(`[name=${name}]`).value]),
    ),
  );
}
function financeTotals() {
  if (!$("financeTotals")) return;
  try {
    const t = SousaFinance.calculate(financeLines());
    $("financeTotals").textContent =
      `Brut HT ${money(t.subtotal)} · Remise ${money(t.discountAmount)} · Net HT ${money(t.net)} · TVA ${money(t.tax)} · Total TTC ${money(t.amount)}`;
    const deposit = SousaFinance.paymentSummary({
      ...t,
      depositPercent: $("entityForm").elements.depositPercent?.value || 0,
    });
    if (deposit.depositPercent)
      $("financeTotals").textContent +=
        ` · Acompte ${deposit.depositPercent} % : ${money(deposit.depositAmount)}`;
  } catch (e) {
    $("financeTotals").textContent = e.message;
  }
}
function afterDays(dateValue, days = 30) {
  const d = new Date(dateValue + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString().slice(0, 10);
}
function financeForm(k, r, initial) {
  const co =
    r?.company ||
    initial?.company ||
    company ||
    visible("clients")[0]?.company ||
    visible("companies").find((c) => c.id !== "group")?.id;
  const settings = find("companies", co)?.billing || {};
  const value = r ||
    initial || {
      company: co,
      date: today(),
      valid: afterDays(today()),
      due: afterDays(today(), settings.paymentDays ?? 30),
      message: settings.defaultMessage,
      terms: settings.defaultTerms,
      language: "fr",
    };
  formShell(
    schemas[k],
    r ? "finance.update" : k,
    `<p class="muted">1. Client et dates · 2. Prestations · 3. Vérification puis émission</p><p>${btn("Créer un client", "finance-client", k)}</p><h4>Prestations</h4><p class="muted">Prix hors taxe. Choisissez le taux applicable à chaque prestation ; 0 % par défaut.</p><datalist id="vatRates"><option value="0"><option value="2.6"><option value="3.8"><option value="8.1"></datalist><div id="lines">${(value.lines || [{}]).map(lineRow).join("")}</div>${btn("Ajouter une ligne", "add-line")}<div id="financeTotals" class="finance-totals" role="status" aria-live="polite"></div><label>Langue du document<select name="language">${[
      ["fr", "Français"],
      ["de", "Deutsch"],
      ["it", "Italiano"],
      ["en", "English"],
    ]
      .map(([v, t]) => `<option value="${v}">${t}</option>`)
      .join(
        "",
      )}</select></label>${field(["message", "Introduction / message au client", "textarea?"])}${field(["scope", "Objet détaillé des travaux", "textarea?"])}${field(["exclusions", "Non compris / options", "textarea?"])}${field(["terms", "Conditions", "textarea?"])}<label>Acompte demandé (%)<input name="depositPercent" type="number" min="0" max="100" step="0.01" value="0" required></label><p class="muted">0 = sans acompte. Le QR demandera l’acompte restant, puis le solde une fois l’acompte encaissé.</p>${field(["paymentNote", "Consigne de paiement", "textarea?"])}${field(["paymentReference", "Référence bancaire structurée (facultatif)", "text?"])}${k === "quotes" ? '<label>Zone de signature<select name="signature"><option value="true">Oui</option><option value="false">Non</option></select></label>' : ""}${r ? `<input type="hidden" name="id" value="${esc(r.id)}"><input type="hidden" name="kind" value="${k}">` : ""}`,
    r
      ? "Modifier le brouillon"
      : k === "quotes"
        ? "Nouveau devis"
        : "Nouvelle facture",
  );
  for (const [key, v] of Object.entries(value)) {
    const input = $("entityForm").elements.namedItem(key);
    if (input && v != null && !["lines", "kind", "id"].includes(key))
      input.value = String(v);
  }
  filterFinanceClient();
  financeTotals();
  const previous = [...state.quotes, ...state.invoices]
    .filter((x) => x.company === co)
    .flatMap((x) => x.lines || []);
  const unique = [
    ...new Map(previous.map((l) => [l.description, l])).values(),
  ].slice(0, 100);
  if (unique.length) {
    $("lines").insertAdjacentHTML(
      "beforebegin",
      `<label>Réutiliser une prestation<select id="reuseLine"><option value="">Choisir dans les documents précédents…</option>${unique.map((l, i) => `<option value="${i}">${esc(l.description)}</option>`).join("")}</select></label>`,
    );
    $("reuseLine").addEventListener("change", (e) => {
      if (e.target.value !== "") {
        $("lines").insertAdjacentHTML(
          "beforeend",
          lineRow(unique[Number(e.target.value)]),
        );
        financeTotals();
        e.target.value = "";
      }
    });
  }
}
function filterFinanceClient() {
  if (!$("lines")) return;
  const co = $("f_company").value;
  for (const option of $("f_clientId").options)
    option.disabled = find("clients", option.value)?.company !== co;
  if ($("f_clientId").selectedOptions[0]?.disabled)
    $("f_clientId").value =
      [...$("f_clientId").options].find((o) => !o.disabled)?.value || "";
  const clientId = $("f_clientId").value;
  for (const option of $("f_project").options) {
    const project = find("projects", option.value);
    option.disabled =
      !!option.value &&
      (project?.company !== co || !same(project?.clientId, clientId));
  }
  if ($("f_project").selectedOptions[0]?.disabled) $("f_project").value = "";
}
function billingSettings() {
  formShell(
    [
      ["company", "Entreprise", "@companies"],
      ...[
        "street",
        "buildingNumber",
        "zip",
        "city",
        "country",
        "vatNumber",
        "iban",
        "email",
      ].map((k, i) => [
        k,
        [
          "Rue",
          "Numéro",
          "Code postal",
          "Ville",
          "Pays (CH/LI)",
          "Numéro TVA",
          "IBAN",
          "E-mail",
        ][i],
        "text?",
      ]),
      ["paymentDays", "Délai de paiement (jours)", "number", "30"],
      ["defaultMessage", "Message par défaut", "textarea?"],
      ["defaultTerms", "Conditions par défaut", "textarea?"],
    ],
    "finance.settings",
    '<p class="muted">Ces coordonnées seront conservées sur les documents lors de leur émission.</p>',
    "Paramètres de facturation",
  );
  if (company) $("f_company").value = company;
  loadBillingSettings();
}
function loadBillingSettings() {
  const s = find("companies", $("f_company").value)?.billing || {};
  for (const input of $("entityForm").elements)
    if (input.name && input.name !== "company")
      input.value =
        s[input.name] ??
        (input.name === "country"
          ? "CH"
          : input.name === "paymentDays"
            ? 30
            : "");
}
function newForm(k) {
  if (!schemas[k]) return;
  if (["quotes", "invoices"].includes(k)) return financeForm(k);
  formShell(
    schemas[k],
    k,
    ["quotes", "invoices"].includes(k)
      ? `<h4 class="spaced">Lignes du document</h4><div id="lines">${lineRow()}</div>${btn("Ajouter une ligne", "add-line")}`
      : "",
    menus[k][0],
  );
  if (company && $("f_company")) $("f_company").value = company;
}
function projectModal(id) {
  const p = find("projects", id);
  if (!p) return;
  modal(
    p.title,
    (can([...ops, ...fin])
      ? btn("Chantier terminé → Facturation", "project-finish", id, "primary")
      : "") +
      (p.invoiceIds || [])
        .filter((i) => find("invoices", i))
        .map((i) => btn("Ouvrir la facture " + i, "invoice", i))
        .join(" ") +
      `<p>${esc(p.description)}</p><p>${esc(p.address)}</p><p>${date(p.start)} – ${date(p.end)} · ${esc(p.progress)} %</p><p>Équipe : ${(p.team || []).map((id) => esc(name("employees", id))).join(", ") || "Non affectée"}</p>${p.budget !== undefined ? `<p>Budget ${money(p.budget)} · Coûts ${money(p.cost)}</p>` : ""}${can(ops) ? btn("Modifier le suivi", "project-edit", id) : ""}<h4 class="spaced">Documents et photos</h4>${table(
        ["Fichier", ""],
        state.documents
          .filter((x) => same(x.project, id))
          .map((d) => [esc(d.name), btn("Télécharger", "download", d.id)]),
      )}`,
  );
}
function documentModal(k, id) {
  const r = find(k, id);
  if (!r) return;
  const payment = SousaFinance.paymentSummary(r);
  const c = r.customer || find("clients", r.clientId),
    co = r.issuer || find("companies", r.company);
  const address = (a) =>
    esc(
      [a?.street, a?.buildingNumber, a?.zip, a?.city, a?.country]
        .filter(Boolean)
        .join(" "),
    );
  const html = `<div class="document"><div class="document-head"><div><h2>${esc(co?.name || "Sousa Group")}</h2><p>${address(co?.billing)}</p><p>${esc(co?.billing?.vatNumber)}</p></div><div><b>${k === "quotes" ? "DEVIS" : "FACTURE"}</b><p>${esc(r.id)}</p><p>${date(r.date)}</p>${r.status === "Brouillon" ? "<b>BROUILLON — NON ÉMIS</b>" : ""}</div></div><p>Client : ${esc(c?.name)}<br>${address(c)}<br>${esc(c?.email)}</p><h3>${esc(r.title)}</h3>${table(
    ["Description", "Quantité", "Prix HT", "Remise", "TVA", "Total TTC"],
    (
      r.lines || [{ description: r.title, quantity: 1, unitPrice: r.amount }]
    ).map((l) => [
      `<b>${esc(l.description)}</b><p class="preserve-lines">${esc(l.details)}</p>`,
      esc(l.quantity) + " " + esc(l.unit),
      money(l.unitPrice),
      esc(l.discount || 0) + " %",
      esc(l.vatRate || 0) + " %",
      money(
        l.total ?? Math.round(l.quantity * Math.round(l.unitPrice * 100)) / 100,
      ),
    ]),
  )}${r.net !== undefined ? `<p>Remise : ${money(r.discountAmount)} · Net HT : ${money(r.net)}</p>${(r.taxGroups || []).map((g) => `<p>TVA ${esc(g.rate)} % sur ${money(g.base)} : ${money(g.tax)}</p>`).join("")}` : ""}<div class="doc-total"><b>Total TTC : ${money(r.amount)}</b></div><p>${k === "quotes" ? "Valable jusqu’au" : "Échéance"} : ${date(r.valid || r.due)}</p>${k === "invoices" ? `<p>Payé : ${money(r.paid)} · Solde : ${money(r.amount - (r.paid || 0))}</p>` : ""}<p>IBAN : ${esc(co?.billing?.iban || "Non renseigné")}</p><p class="preserve-lines">${esc(r.message)}</p><p class="preserve-lines">${esc(r.terms)}</p>${r.acceptedAt ? `<p>Acceptation enregistrée le ${esc(new Date(r.acceptedAt).toLocaleString("fr-CH"))}.</p>` : ""}${k === "quotes" && r.signature !== false ? '<p class="spaced">Date et signature : ______________________________</p>' : ""}${r.invoiceId ? `<p>Facture liée : ${esc(r.invoiceId)}</p>` : ""}${r.quoteId ? `<p>Devis d’origine : ${esc(r.quoteId)}</p>` : ""}</div>`;
  const brandedHtml = html.replace(
    '<div class="document-head">',
    `<img class="document-logo" src="${companyLogoPath(r.company, co)}" alt="${esc(co?.name || "Sousa Group")}" /><div class="document-head">`,
  );
  $("printArea").innerHTML = brandedHtml;
  const appendix = `<div class="document"><p class="preserve-lines">${esc(r.scope)}</p>${r.exclusions ? `<h4>Non compris / options</h4><p class="preserve-lines">${esc(r.exclusions)}</p>` : ""}<p class="preserve-lines">${esc(r.paymentNote)}</p>${payment.depositPercent ? `<p>Acompte : ${payment.depositPercent} % · Montant : ${money(payment.depositAmount)}</p><p>Acompte restant : ${money(payment.depositRemaining)} · Solde total : ${money(payment.balance)}</p>` : ""}</div>`;
  modal(
    r.id,
    btn("Imprimer / PDF", "finance-pdf", k + ":" + id) +
      " " +
      (can(fin) && r.status === "Brouillon"
        ? btn(
            "Émettre",
            k === "quotes" ? "quote.issue" : "invoice.issue",
            id,
            "primary",
          )
        : "") +
      " " +
      (profile.role === "client" && k === "quotes" && r.status === "Émise"
        ? btn("Accepter le devis", "quote.accept", id, "primary")
        : "") +
      (can(fin)
        ? `<div class="actions spaced">${r.status === "Brouillon" ? btn("Modifier", "finance-edit", k + ":" + id) : ""} ${btn("Dupliquer", "finance-copy", k + ":" + id)} ${k === "quotes" && r.status === "Émise" ? btn("Enregistrer la réponse", "quote-decision", id) : ""} ${k === "quotes" && r.status === "Accepté" && !r.invoiceId ? btn("Convertir en facture", "quote-convert", id, "primary") : ""} ${k === "invoices" && r.status !== "Brouillon" && r.status !== "Payée" ? btn("Enregistrer un paiement", "invoice-payment", id) : ""}</div>`
        : "") +
      ` <p>${btn("Télécharger PDF", "finance-pdf", k + ":" + id)} ${k === "invoices" && r.status !== "Brouillon" && r.status !== "Payée" ? btn("PDF avec QR de paiement", "finance-qr", k + ":" + id) : ""} ${can(fin) && r.status !== "Brouillon" ? btn("Préparer e-mail avec PDF (.eml)", "finance-email", k + ":" + id) : ""}</p>` +
      (r.status === "Brouillon"
        ? '<p class="notice">Brouillon — non émis</p>'
        : "") +
      brandedHtml +
      appendix +
      (r.project && find("projects", r.project)
        ? btn("Ouvrir le chantier", "project", r.project)
        : "") +
      (r.workSummary
        ? `<h4>Récapitulatif du chantier</h4><p class="preserve-lines">${esc(r.workSummary)}</p>`
        : "") +
      (can(fin) && r.completionSnapshot
        ? `<h4>Données internes du chantier</h4><p>${r.completionSnapshot.time.length} saisie(s) d’heures · ${r.completionSnapshot.expenses.length} dépense(s) · ${r.completionSnapshot.documents.length} document(s)</p>${table(
            ["Dépense", "Montant"],
            r.completionSnapshot.expenses.map((e) => [
              esc(e.supplier),
              money(e.amount),
            ]),
          )}<p>Les pièces originales et le suivi restent consultables depuis le chantier. Les heures et dépenses ne sont pas ajoutées automatiquement au prix du devis.</p>`
        : "") +
      (can(fin)
        ? `<div class="actions spaced">${k === "quotes" && r.status === "Accepté" ? btn(r.project ? "Ouvrir le chantier" : "Créer le chantier", "quote-project", id, "primary") : ""} ${r.status === "Brouillon" ? btn("Supprimer le brouillon", "finance-delete", k + ":" + id, "danger") : btn(r.archivedAt ? "Restaurer" : "Archiver", "finance-archive", k + ":" + id)}</div>`
        : ""),
  );
}
async function loadUsers() {
  try {
    const out = await api("state/users");
    userAccounts = out.users;
    document.querySelectorAll("[data-employee-account]").forEach((el) => {
      const u = userAccounts.find((u) =>
        same(u.employee_id, el.dataset.employeeAccount),
      );
      el.textContent = u
        ? `${roles[u.role]} · ${u.disabled ? "Compte désactivé" : "Compte actif"}`
        : "Sans compte";
    });
    if (!$("usersList")) return;
    $("usersList").innerHTML = table(
      ["Nom", "E-mail", "Rôle", "Salarié", "Statut", ""],
      out.users
        .filter(
          (u) =>
            page !== "employees" ||
            !state.employees.some(
              (e) => !e.deletedAt && same(e.id, u.employee_id),
            ),
        )
        .filter((u) => !company || u.company === company)
        .map((u) => [
          esc(u.name),
          esc(u.email),
          esc(roles[u.role]),
          u.employee_id ? esc(name("employees", u.employee_id)) : "Non",
          u.disabled ? "Désactivé" : "Actif",
          btn("Modifier / relier", "edit-user", u.id) +
            " " +
            btn("Réinitialiser le mot de passe", "reset-password", u.id) +
            " " +
            (!same(u.id, profile.id) && !u.disabled
              ? btn("Désactiver", "disable-user", u.id, "danger")
              : "") +
            " " +
            (!same(u.id, profile.id)
              ? btn("Supprimer", "delete-user", u.id, "danger")
              : ""),
        ]),
    );
  } catch (e) {
    if ($("usersList")) $("usersList").textContent = e.message;
  }
}
async function employeeDetail(id) {
  const e = find("employees", id);
  if (!e || e.deletedAt) return;
  const admin = profile.role === "admin" && profile.company === "group";
  let accountHtml = "";
  if (admin) {
    try {
      userAccounts = (await api("state/users")).users;
      const u = userAccounts.find((u) => same(u.employee_id, id));
      accountHtml =
        `<h3>Compte de connexion</h3>` +
        (u
          ? `<p>${esc(u.email)} · ${esc(roles[u.role])} · ${u.disabled ? "Désactivé" : "Actif"}</p><div class="actions">${btn("Modifier le compte", "edit-user", u.id)} ${btn("Réinitialiser le mot de passe", "reset-password", u.id)} ${!same(u.id, profile.id) ? btn("Supprimer le compte", "delete-user", u.id, "danger") : ""}</div>`
          : `<p>Aucun compte de connexion.</p>${btn("Créer son compte", "linked-user", "employees:" + id, "primary")}`);
    } catch (err) {
      accountHtml = `<p class="error">${esc(err.message)}</p>`;
    }
  }
  modal(
    "Fiche salarié et compte",
    `<h3>${esc(e.name)}</h3><p>${esc(e.job || "")} · ${esc(e.email || "")} · ${esc(e.phone || "")}</p><p>${[...new Set([e.company, ...(e.companies || [])])].map((c) => esc(name("companies", c))).join(" · ")}</p>${can(hr) ? `<p>Salaire mensuel : ${money(e.salary)} · Activité : ${esc(e.activity ?? "—")} % · Vacances : ${esc(e.vacation ?? "—")} jours</p><div class="actions">${btn("Entreprises / accès", "employee-companies", id)} ${btn("Supprimer le salarié", "employee-delete", id, "danger")}</div>` : ""}${accountHtml}`,
  );
}
async function loadAudit() {
  try {
    const out = await api("state/audit");
    if ($("auditList"))
      $("auditList").innerHTML = table(
        ["Date", "Utilisateur", "Action", "Référence"],
        out.rows.map((r) => [
          esc(new Date(r.created_at).toLocaleString("fr-CH")),
          esc(r.user_email),
          esc(r.action),
          esc(r.metadata?.id),
        ]),
      );
  } catch (e) {
    if ($("auditList")) $("auditList").textContent = e.message;
  }
}
function userForm(link) {
  formShell(
    [
      ["name", "Nom"],
      ["email", "E-mail", "email"],
      ["password", "Mot de passe initial (12 caractères minimum)", "password"],
      ["company", "Entreprise", "@companies"],
      ["employeeId", "Fiche salarié", "@employees?"],
      ["clientId", "Fiche client", "@clients?"],
    ],
    "user",
    `<label for="f_isEmployee">Cette personne est-elle un salarié ?</label><select id="f_isEmployee" name="isEmployee"><option value="no">Non — compte sans fiche salarié</option><option value="yes">Oui — compte lié à un salarié</option></select><p class="muted">La fiche salarié et le compte seront créés ensemble. Vous pouvez aussi relier une fiche existante.</p><label for="f_role">Rôle et droits d’accès</label><select id="f_role" name="role">${Object.entries(
      roles,
    )
      .map(([k, v]) => `<option value="${k}">${v}</option>`)
      .join(
        "",
      )}</select><p class="muted">Transmettez le mot de passe initial à la personne par un canal privé. Elle pourra le changer dans Mon compte.</p>`,
    "Créer un accès",
  );
  $("f_company").insertAdjacentHTML(
    "afterbegin",
    '<option value="group">Sousa Group (toutes les entreprises)</option>',
  );
  const typeChoice = $("f_isEmployee"),
    typeLabel = typeChoice.labels[0],
    typeHelp = typeChoice.nextElementSibling;
  $("f_company").after(typeLabel, typeChoice, typeHelp);
  $("f_employeeId").options[0].textContent = "Créer une nouvelle fiche salarié";
  $("f_employeeId").labels[0].textContent = "Fiche salarié";
  $("f_employeeId").insertAdjacentHTML(
    "afterend",
    `<fieldset id="newEmployeeFields"><legend>Informations du nouveau salarié</legend>${[
      ["employeeJob", "Fonction"],
      ["employeePhone", "Téléphone", "tel?"],
      ["employeeSalary", "Salaire mensuel CHF", "number"],
      ["employeeActivity", "Taux d’activité %", "number", "100"],
      ["employeeVacation", "Solde de vacances (jours)", "number", "20"],
      ["employeeEntry", "Date d’entrée", "date"],
    ]
      .map(field)
      .join("")}</fieldset>`,
  );
  $("f_clientId").options[0].textContent = "Créer une nouvelle fiche client";
  $("f_clientId").labels[0].textContent = "Fiche client";
  $("f_clientId").insertAdjacentHTML(
    "afterend",
    `<fieldset id="newClientFields"><legend>Informations du nouveau client</legend><p>Le nom, l’e-mail et l’entreprise du compte seront repris dans la fiche client.</p>${[
      ["clientPhone", "Téléphone", "tel?"],
      ["clientStreet", "Rue", "text?"],
      ["clientBuildingNumber", "Numéro", "text?"],
      ["clientZip", "Code postal", "text?"],
      ["clientCity", "Ville"],
      ["clientCountry", "Pays (code)", "text", "CH"],
      ["clientType", "Type de client", "text", "Particulier"],
    ]
      .map(field)
      .join("")}</fieldset>`,
  );
  $("f_employeeId").insertAdjacentHTML(
    "afterend",
    `<fieldset id="accountCompanies"><legend>Entreprises du salarié</legend><p>Cochez les entreprises autorisées. Le rôle définit les fonctions disponibles dans chacune d’elles. Avec le rôle Salarié, seuls les chantiers affectés sont accessibles. Un accès Groupe conserve son périmètre global.</p>${state.companies
      .filter((c) => c.id !== "group")
      .map(
        (c) =>
          `<label><input type="checkbox" name="employeeCompanies" value="${esc(c.id)}"> ${esc(c.name)}</label>`,
      )
      .join("")}</fieldset>`,
  );
  $("f_role").value = "manager";
  if (link) {
    const [k, id] = link.split(":"),
      r = find(k, id);
    if (r) {
      $("f_name").value = r.name;
      $("f_email").value = r.email;
      $("f_company").value = r.company;
      $("f_role").value = k === "employees" ? "employee" : "client";
      $(k === "employees" ? "f_employeeId" : "f_clientId").value = r.id;
    }
  }
  $("f_isEmployee").value = $("f_employeeId").value ? "yes" : "no";
  syncUserForm();
}
function syncUserForm() {
  const employee = $("f_isEmployee").value === "yes",
    client = $("f_role").value === "client";
  const e = $("f_employeeId"),
    c = $("f_clientId");
  e.disabled = !employee;
  e.required = false;
  e.hidden = !employee;
  e.labels[0].hidden = !employee;
  e.classList.toggle("hidden", !employee);
  e.labels[0].classList.toggle("hidden", !employee);
  c.disabled = !client;
  c.required = false;
  c.hidden = !client;
  c.labels[0].hidden = !client;
  c.classList.toggle("hidden", !client);
  c.labels[0].classList.toggle("hidden", !client);
  if (!employee) e.value = "";
  if (!client) c.value = "";
  const fields = $("newEmployeeFields"),
    createEmployee = employee && !e.value;
  fields.disabled = !createEmployee;
  fields.classList.toggle("hidden", !createEmployee);
  const membershipFields = $("accountCompanies"),
    linkedEmployee = find("employees", e.value);
  membershipFields.disabled = !employee;
  membershipFields.classList.toggle("hidden", !employee);
  const source = e.value || "new";
  if (membershipFields.dataset.source !== source) {
    const assigned = linkedEmployee
      ? [linkedEmployee.company, ...(linkedEmployee.companies || [])]
      : [];
    membershipFields
      .querySelectorAll("input")
      .forEach((x) => (x.checked = assigned.includes(x.value)));
    membershipFields.dataset.source = source;
  }
  const primary = linkedEmployee?.company || $("f_company").value;
  membershipFields.querySelectorAll("input").forEach((x) => {
    if (x.value === primary) x.checked = true;
  });
  const clientFields = $("newClientFields"),
    createClient = client && !c.value;
  clientFields.disabled = !createClient;
  clientFields.classList.toggle("hidden", !createClient);
}
function downloadBlob(blob, name) {
  const a = document.createElement("a"),
    url = URL.createObjectURL(blob);
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
function exportData(k) {
  const rows = visible(k);
  if (!rows.length) return toast("Aucune donnée à exporter.");
  const keys = [...new Set(rows.flatMap(Object.keys))].filter(
    (k) => !["lines", "team"].includes(k),
  );
  const csv = [keys, ...rows.map((r) => keys.map((k) => r[k] ?? ""))]
    .map((row) => row.map(csvCell).join(";"))
    .join("\r\n");
  downloadBlob(
    new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }),
    "Sousa_" + k + ".csv",
  );
}
document.addEventListener("change", (e) => {
  if (
    $("entityForm")?.dataset.kind === "user" &&
    [
      "f_isEmployee",
      "f_role",
      "f_employeeId",
      "f_clientId",
      "f_company",
    ].includes(e.target.id)
  ) {
    if (e.target.id === "f_isEmployee") {
      if (e.target.value === "yes") $("f_role").value = "employee";
      else if ($("f_role").value === "employee") $("f_role").value = "manager";
    } else if (e.target.value === "employee") $("f_isEmployee").value = "yes";
    else if (e.target.value === "client") $("f_isEmployee").value = "no";
    syncUserForm();
  }
  if (
    e.target.id === "f_employeeId" &&
    ["planning", "time.add"].includes($("entityForm")?.dataset.kind)
  )
    planningProjects();
  if (
    e.target.id === "planningDate" &&
    /^\d{4}-\d{2}-\d{2}$/.test(e.target.value)
  ) {
    planningDate = e.target.value;
    render();
  }
  if (e.target.id === "planningEmployee") {
    planningEmployee = e.target.value;
    render();
  }
  if (e.target.id === "recipient") {
    selectedRecipient = e.target.value;
    render();
  }
});
document.addEventListener("click", async (e) => {
  const nav = e.target.closest("[data-page]");
  if (nav) {
    page = nav.dataset.page;
    render();
    $("sidebar").classList.remove("open");
    $("backdrop").classList.add("hidden");
    return;
  }
  const b = e.target.closest("[data-action]");
  if (!b || pending) return;
  const a = b.dataset.action,
    id = b.dataset.id;
  try {
    if (a === "close-modal") closeModal();
    else if (a === "open-side") {
      $("sidebar").classList.add("open");
      $("backdrop").classList.remove("hidden");
    } else if (a === "close-side") {
      $("sidebar").classList.remove("open");
      $("backdrop").classList.add("hidden");
    } else if (a === "logout") {
      await api("auth/logout", {});
      clearSession();
    } else if (a === "theme") {
      document.body.classList.toggle("light");
      localStorage.setItem(
        "sgo_theme",
        document.body.classList.contains("light") ? "light" : "dark",
      );
    } else if (a === "refresh") {
      await refresh();
      notice("");
      toast("Données actualisées.");
    } else if (a === "planning-nav") {
      planningDate =
        id === "today" ? today() : planningDay(planningDate, Number(id));
      render();
    } else if (a === "planning-mode") {
      planningMode = id === "list" ? "list" : "week";
      render();
    } else if (a === "planning-slot") {
      planningForm(b.dataset.employee, b.dataset.date);
    } else if (a === "planning-detail") {
      const p = find("planning", id);
      if (p)
        modal(
          "Affectation",
          `<p><b>${esc(name("employees", p.employeeId))}</b></p><p>${date(p.date)} · ${esc(p.start)}–${esc(p.end)}</p><p>${esc(name("projects", p.project))}</p><p>${esc(p.location)}</p>${can(ops) ? btn("Copier vers un autre créneau", "planning-copy", p.id) + " " + btn("Supprimer", "planning.delete", p.id, "danger") : ""}`,
        );
    } else if (a === "planning-copy") {
      const p = find("planning", id);
      if (p) planningForm(p.employeeId, planningDay(p.date, 1), p);
    } else if (a === "new") {
      if (id === "planning") planningForm(planningEmployee);
      else newForm(id);
    } else if (a === "finance-archives") {
      showArchivedFinance = !showArchivedFinance;
      render();
    } else if (a === "finance-delete" || a === "finance-archive") {
      const [kind, rid] = id.split(":");
      const r = find(kind, rid);
      if (
        confirm(
          a === "finance-delete"
            ? `Supprimer le brouillon ${rid} ?`
            : r.archivedAt
              ? `Restaurer ${rid} ?`
              : `Archiver ${rid} ? Les montants, paiements et l’historique restent conservés.`,
        )
      ) {
        const out = await mutate(
          a === "finance-delete" ? "finance.delete" : "finance.archive",
          { kind, id: rid, restore: !!r.archivedAt },
        );
        if (out) closeModal();
      }
    } else if (a === "quote-project") {
      const q = find("quotes", id);
      const project = q.project
        ? find("projects", q.project)
        : await mutate("quote.project", { id });
      if (project) {
        page = "projects";
        render();
        projectModal(project.id);
      }
    } else if (a === "project-finish") {
      if (
        confirm(
          "Terminer ce chantier et préparer sa facturation ? Les prestations du devis seront reprises. Vérifiez les suppléments avant d’émettre la facture.",
        )
      ) {
        const result = await mutate("project.finish", { id });
        if (result) {
          closeModal();
          if (can(fin)) {
            page = "invoices";
            render();
            if (result.invoiceIds?.[0])
              documentModal("invoices", result.invoiceIds[0]);
          } else projectModal(id);
        }
      }
    } else if (a === "project") projectModal(id);
    else if (a === "quote" || a === "invoice")
      documentModal(a === "quote" ? "quotes" : "invoices", id);
    else if (a === "print") window.print();
    else if (a === "billing-settings") billingSettings();
    else if (a === "finance-edit") {
      const [k, rid] = id.split(":");
      financeForm(k, find(k, rid));
    } else if (a === "finance-client") {
      financeClientDraft = {
        kind: id,
        value: {
          ...Object.fromEntries(new FormData($("entityForm"))),
          lines: financeLines(),
        },
      };
      newForm("clients");
      $("f_company").value = financeClientDraft.value.company;
      $("entityForm").dataset.returnFinance = "true";
    } else if (a === "finance-copy") {
      const [k, rid] = id.split(":");
      await mutate("finance.duplicate", {
        kind: k,
        id: rid,
        date: today(),
        valid: afterDays(today()),
        due: afterDays(today()),
      });
    } else if (a === "quote-convert") {
      formShell(
        [
          ["date", "Date de facture", "date", today()],
          ["due", "Échéance", "date", afterDays(today())],
        ],
        "quote.convert",
        `<input type="hidden" name="id" value="${esc(id)}"><p>Les prestations, remises, TVA et coordonnées du devis seront reprises.</p>`,
        "Convertir en facture",
      );
    } else if (a === "quote-decision") {
      formShell(
        [["note", "Référence de la réponse du client", "textarea"]],
        "quote.decide",
        `<input type="hidden" name="id" value="${esc(id)}"><label>Réponse<select name="status"><option>Accepté</option><option>Refusé</option></select></label>`,
        "Enregistrer la réponse reçue",
      );
    } else if (a === "invoice-payment") {
      newForm("payments");
      $("f_invoice").value = id;
      const invoice = find("invoices", id);
      $("f_amount").value =
        SousaFinance.paymentSummary(invoice).requested.toFixed(2);
    } else if (["finance-pdf", "finance-qr", "finance-email"].includes(a)) {
      const [k, rid] = id.split(":");
      const extension = a === "finance-email" ? "eml" : "pdf";
      const includeQR =
        a === "finance-qr" ||
        (a === "finance-email" &&
          k === "invoices" &&
          confirm(
            "Inclure le QR bancaire ? Choisissez Annuler pour préparer le PDF sans QR.",
          ));
      const response = await fetch(
        `/api/state/finance/${k}/${encodeURIComponent(rid)}.${extension}${includeQR ? "?qr=1" : ""}`,
        { headers: { Authorization: "Bearer " + token } },
      );
      if (!response.ok)
        throw new Error(
          (await response.json()).error || "Téléchargement impossible.",
        );
      const url = URL.createObjectURL(await response.blob()),
        link = document.createElement("a");
      link.href = url;
      link.download = rid + "." + extension;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      if (extension === "eml")
        toast(
          "Brouillon téléchargé : ouvrez-le dans votre messagerie pour l’envoyer. Aucun e-mail envoyé par l’application.",
        );
    } else if (a === "add-line")
      $("lines").insertAdjacentHTML("beforeend", lineRow());
    else if (a === "remove-line") {
      if (document.querySelectorAll(".invoice-line").length > 1)
        b.closest(".invoice-line").remove();
      financeTotals();
    } else if (a === "project-edit") {
      const p = find("projects", id);
      formShell(
        [
          ["progress", "Avancement %", "number", p.progress],
          ["description", "Description", "textarea?", p.description],
        ],
        "project.update",
        `<input type="hidden" name="id" value="${esc(id)}"><label>Statut<select name="status">${["Planifié", "En cours", "Terminé", "À facturer"].map((s) => `<option ${s === p.status ? "selected" : ""}>${s}</option>`).join("")}</select></label><label>Équipe<select name="team" multiple>${state.employees
          .filter(
            (e) =>
              !e.deletedAt &&
              [e.company, ...(e.companies || [])].includes(p.company),
          )
          .map(
            (e) =>
              `<option value="${esc(e.id)}" ${(p.team || []).some((x) => same(x, e.id)) ? "selected" : ""}>${esc(e.name)}</option>`,
          )
          .join("")}</select></label>`,
        "Modifier le chantier",
      );
    } else if (
      ["clock.start", "clock.pause", "clock.resume", "clock.stop"].includes(a)
    )
      await mutate(
        a,
        a === "clock.start" ? { project: $("clockProject").value } : {},
      );
    else if (["time.approve", "quote.issue", "invoice.issue"].includes(a))
      await mutate(a, { id });
    else if (a === "quote.accept") {
      if (confirm("Confirmer l’acceptation de ce devis ?"))
        await mutate(a, { id });
    } else if (a === "planning.delete") {
      if (confirm("Supprimer cette affectation ?")) await mutate(a, { id });
    } else if (a === "absence.approve" || a === "absence.reject")
      await mutate("absence.decide", {
        id,
        status: a === "absence.approve" ? "Approuvée" : "Refusée",
      });
    else if (a === "absence-form")
      formShell(
        [
          ...(profile.role === "employee"
            ? []
            : [["employeeId", "Salarié", "@employees"]]),
          ["from", "Du", "date"],
          ["to", "Au", "date"],
          ["comment", "Commentaire", "textarea?"],
        ],
        "absence.request",
        '<label>Type<select name="type"><option>Vacances</option><option>Maladie</option><option>Autre</option></select></label><p class="muted">Le décompte exclut les samedis et dimanches. Vérifiez les jours fériés et les horaires particuliers avant validation.</p>',
        "Demande d’absence",
      );
    else if (a === "export") exportData(id);
    else if (a === "employee-detail") await employeeDetail(id);
    else if (a === "user-form") userForm();
    else if (a === "time-add") manualTimeForm();
    else if (a === "employee-companies") {
      const employee = find("employees", id);
      const memberships = [employee.company, ...(employee.companies || [])];
      formShell(
        [],
        "employee.companies",
        `<input type="hidden" name="id" value="${esc(id)}"><p>Un seul compte pour les entreprises cochées. L’entreprise principale doit rester sélectionnée. Le salarié voit uniquement les chantiers auxquels il est affecté.</p><fieldset><legend>Entreprises de ${esc(employee.name)}</legend>${state.companies
          .filter((c) => c.id !== "group")
          .map(
            (c) =>
              `<label><input type="checkbox" name="companies" value="${esc(c.id)}" ${memberships.includes(c.id) ? "checked" : ""}> ${esc(c.name)}${c.id === employee.company ? " (principale)" : ""}</label>`,
          )
          .join("")}</fieldset>`,
        "Entreprises et accès",
      );
    } else if (a === "employee-delete") {
      const employee = find("employees", id);
      if (
        confirm(
          `Supprimer ${employee.name} des salariés actifs ? Son compte sera désactivé et ses affectations à partir d’aujourd’hui annulées. L’historique des heures et documents sera conservé.`,
        )
      )
        await mutate("employee.delete", { id });
    } else if (a === "linked-user") userForm(id);
    else if (a === "edit-user") {
      const u = userAccounts.find((x) => same(x.id, id));
      userForm();
      $("f_password").required = false;
      $("f_password").labels[0].textContent =
        "Nouveau mot de passe (facultatif, 12 caractères minimum)";
      $("f_password").placeholder =
        "Laisser vide pour conserver le mot de passe";
      $("f_name").value = u.name;
      $("f_email").value = u.email;
      $("f_company").value = u.company;
      $("f_employeeId").value = u.employee_id || "";
      $("f_clientId").value = u.client_id || "";
      $("f_role").value = u.role;
      $("f_isEmployee").value = u.employee_id ? "yes" : "no";
      syncUserForm();
      $("entityForm").insertAdjacentHTML(
        "beforeend",
        `<input type="hidden" name="id" value="${esc(u.id)}">`,
      );
    } else if (a === "delete-user") {
      const u = userAccounts.find((x) => same(x.id, id));
      if (
        confirm(
          `Supprimer le compte de ${u.name} (${u.email}) ? Ses sessions seront fermées. Sa fiche salarié ou client et l’historique métier seront conservés.`,
        )
      )
        await mutate("delete", { id }, null, "state/users/delete");
    } else if (a === "disable-user") {
      if (confirm("Désactiver ce compte et ses sessions ?"))
        await mutate("disable", { id }, null, "state/users/disable");
    } else if (a === "reset-password")
      formShell(
        [["password", "Nouveau mot de passe", "password"]],
        "reset-password",
        `<input type="hidden" name="id" value="${esc(id)}">`,
        "Réinitialiser le mot de passe",
      );
    else if (a === "password-form")
      formShell(
        [
          ["currentPassword", "Mot de passe actuel", "password"],
          ["password", "Nouveau mot de passe", "password"],
        ],
        "password",
        "",
        "Changer mon mot de passe",
      );
    else if (a === "document-form")
      formShell(
        [
          ["company", "Entreprise", "@companies"],
          ["project", "Chantier", "@projects?"],
          ["employeeId", "Salarié", "@employees?"],
          ["clientId", "Client", "@clients?"],
        ],
        "document",
        '<label>Visibilité<select name="visibility"><option value="team">Équipe uniquement</option>' +
          (can(ops)
            ? '<option value="client">Partager avec le client</option>'
            : "") +
          '</select></label><p>Choisissez un seul dossier. PDF, image ou texte, 5 Mo maximum.</p><label>Fichier<input type="file" name="file" accept="application/pdf,image/jpeg,image/png,image/webp,text/plain" required></label>',
        "Ajouter un fichier",
      );
    else if (a === "download") {
      const doc = find("documents", id),
        r = await fetch("/api/state/documents/" + encodeURIComponent(id), {
          headers: { Authorization: "Bearer " + token },
        });
      if (!r.ok) throw new Error("Téléchargement impossible ou accès expiré.");
      downloadBlob(await r.blob(), doc.name);
    }
  } catch (err) {
    notice(err.message);
  }
});
document.addEventListener("submit", async (e) => {
  const f = e.target;
  if (!["entityForm", "messageForm"].includes(f.id)) return;
  e.preventDefault();
  if (pending) return;
  const data = new FormData(f),
    p = Object.fromEntries(data);
  const k = f.dataset.kind;
  try {
    if (f.id === "messageForm")
      return await mutate(
        "message",
        { text: p.text, recipientId: selectedRecipient },
        null,
        "state/messages",
        f,
      );
    if (k === "password") {
      await api("auth/password", p);
      clearSession();
      toast("Mot de passe changé. Reconnectez-vous.");
      return;
    }
    if (k === "document") {
      const file = data.get("file");
      if (!file.size || file.size > 5 * 1024 * 1024)
        throw new Error("Choisissez un fichier de 5 Mo maximum.");
      const content = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result.split(",")[1]);
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      delete p.file;
      return await mutate(
        "document",
        { ...p, name: file.name, mime: file.type, content },
        null,
        "state/documents",
        f,
      );
    }
    if (k === "user" && p.isEmployee === "yes")
      p.employeeCompanies = data.getAll("employeeCompanies");
    if (k === "user" && p.isEmployee === "yes" && !p.employeeId) {
      p.newEmployee = {
        job: p.employeeJob,
        phone: p.employeePhone,
        salary: p.employeeSalary,
        activity: p.employeeActivity,
        vacation: p.employeeVacation,
        entry: p.employeeEntry,
      };
    }
    if (k === "user" && p.role === "client" && !p.clientId) {
      p.newClient = {
        phone: p.clientPhone,
        street: p.clientStreet,
        buildingNumber: p.clientBuildingNumber,
        zip: p.clientZip,
        city: p.clientCity,
        country: p.clientCountry,
        type: p.clientType,
      };
    }
    if (k === "user" || k === "reset-password") {
      const account = await mutate(
        k,
        p,
        null,
        k === "user" ? "state/users" : "state/users/password",
        f,
      );
      if (account?.employeeId) await employeeDetail(account.employeeId);
      return;
    }
    if (k === "project.update") p.team = data.getAll("team");
    if (k === "employee.companies") p.companies = data.getAll("companies");
    if (["quotes", "invoices", "finance.update"].includes(k))
      p.lines = financeLines(f);
    const result = await mutate(
      k.includes(".") ? k : "create",
      p,
      k.includes(".") ? undefined : k,
      "state/command",
      f,
    );
    if (result && k === "employees") await employeeDetail(result.id);
    if (result && k === "planning") {
      planningDate = p.date;
      render();
    }
    if (
      result &&
      k === "clients" &&
      f.dataset.returnFinance &&
      financeClientDraft
    ) {
      const draft = financeClientDraft;
      financeClientDraft = null;
      const value = {
        ...draft.value,
        clientId: result.id,
        company: result.company,
        project: "",
      };
      if (value.id) financeForm(draft.kind, value);
      else financeForm(draft.kind, null, value);
    }
  } catch (err) {
    const target = $("formError");
    if (target) target.textContent = err.message;
    else notice(err.message);
  }
});
document.addEventListener("input", (e) => {
  if (e.target.closest(".invoice-line") || e.target.name === "depositPercent")
    financeTotals();
});
document.addEventListener("change", (e) => {
  if (["f_company", "f_clientId"].includes(e.target.id)) filterFinanceClient();
  if (
    e.target.id === "f_company" &&
    $("entityForm")?.dataset.kind === "finance.settings"
  )
    loadBillingSettings();
});
document.addEventListener("keydown", (e) => {
  if ($("modalWrap").classList.contains("hidden")) return;
  if (e.key === "Escape") closeModal();
  if (e.key === "Tab") {
    const els = [
        ...$("modalWrap").querySelectorAll("button,input,select,textarea"),
      ].filter((x) => !x.disabled && x.type !== "hidden"),
      first = els[0],
      last = els.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
});
document.body.classList.toggle(
  "light",
  localStorage.getItem("sgo_theme") === "light",
);
if (token)
  refresh(false)
    .then(() => {
      $("login").classList.add("hidden");
      $("app").classList.remove("hidden");
      render();
    })
    .catch((e) => {
      clearSession();
      $("loginError").textContent = e.message;
    });
setInterval(() => {
  if (
    token &&
    !pending &&
    $("modalWrap").classList.contains("hidden") &&
    document.visibilityState === "visible" &&
    !$("messageText")?.value
  )
    refresh().catch((e) => notice(e.message));
}, 30000);
// Remove legacy offline caches. Sensitive application data is never cached by this version.
if ("serviceWorker" in navigator)
  navigator.serviceWorker
    .getRegistrations()
    .then((rs) => Promise.all(rs.map((r) => r.unregister())))
    .catch(() => {});
if ("caches" in window)
  caches
    .keys()
    .then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith("sgo") || k.startsWith("sousa"))
          .map((k) => caches.delete(k)),
      ),
    )
    .catch(() => {});
