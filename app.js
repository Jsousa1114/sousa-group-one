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
  selectedThreadId = "",
  chatReplyToId = "",
  chatAttachmentDraft = null,
  chatRecorder = null,
  mobileChatOpen = false,
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
  selectedThreadId = "";
  chatReplyToId = "";
  chatAttachmentDraft = null;
  chatRecorder = null;
  mobileChatOpen = false;
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
    .map(([k, [label]]) => {
      const unread =
        k === "messages"
          ? state.messages.filter(
              (m) => !same(m.senderId, profile.id) && !chatRead(m),
            ).length
          : 0;
      return `<button class="nav-item ${page === k ? "active" : ""}" data-page="${k}">${esc(label)}${unread ? ` <span class="nav-unread">${unread > 99 ? "99+" : unread}</span>` : ""}</button>`;
    })
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
  if (page === "messages" && $("messageThread")) {
    $("messageThread").scrollTop = $("messageThread").scrollHeight;
    hydrateChatAttachments();
    queueMicrotask(() => markChatRead());
  }
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
        (can([...hr, "manager"]) && t.status !== "Validé"
          ? btn("Valider", "time.approve", t.id)
          : "") +
          " " +
          deleteRecordButton("time", t),
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
        (can(hr) && a.status === "En attente"
          ? btn("Approuver", "absence.approve", a.id) +
            " " +
            btn("Refuser", "absence.reject", a.id)
          : "") +
          " " +
          deleteRecordButton("absences", a),
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
            (r.archivedAt ? " · Archivé" : "") +
            (can(fin)
              ? " " +
                (r.status === "Brouillon"
                  ? btn("Supprimer", "finance-delete", k + ":" + r.id, "danger")
                  : btn(
                      r.archivedAt ? "Restaurer" : "Archiver",
                      "finance-archive",
                      k + ":" + r.id,
                    ))
              : ""),
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
        btn("Télécharger", "download", d.id) +
          " " +
          deleteRecordButton("documents", d),
      ]),
    )
  );
}
function chatAvatar(person, extra = "") {
  const label = person?.name || "—",
    photo = person?.photo || "";
  return photo
    ? `<img class="chat-avatar ${esc(extra)}" src="${esc(photo)}" alt="" width="48" height="48" loading="lazy">`
    : `<span class="chat-avatar chat-avatar-initial ${esc(extra)}" aria-hidden="true">${esc(label.slice(0, 1).toUpperCase())}</span>`;
}
function chatTime(value) {
  return value
    ? new Date(value).toLocaleTimeString("fr-CH", {
        timeZone: "Europe/Zurich",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
}
function chatDate(value) {
  return new Date(value).toLocaleDateString("fr-CH", {
    timeZone: "Europe/Zurich",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}
function chatRead(m) {
  return (m.readBy || []).some((id) => same(id, profile.id));
}
function chatMessagePreview(m) {
  if (!m) return "Commencer une conversation";
  const prefix = same(m.senderId, profile.id) ? "Vous : " : "";
  if (m.text) return prefix + m.text;
  if (m.attachment?.kind === "image") return prefix + "📷 Photo";
  if (m.attachment?.kind === "audio") return prefix + "🎤 Message vocal";
  return prefix + "📎 " + (m.attachment?.name || "Fichier");
}
function chatAttachmentHtml(m) {
  if (!m.attachment) return "";
  const label = esc(m.attachment.name || "Pièce jointe");
  if (m.attachment.kind === "image")
    return `<button type="button" class="chat-media-button" data-action="chat-open-attachment" data-id="${esc(m.id)}"><img data-chat-media="${esc(m.id)}" alt="${label}" class="chat-image-preview"><span>📷 ${label}</span></button>`;
  if (m.attachment.kind === "audio")
    return `<div class="chat-audio-wrap"><audio controls preload="none" data-chat-media="${esc(m.id)}"></audio><button type="button" class="chat-attachment-link" data-action="chat-open-attachment" data-id="${esc(m.id)}">🎤 ${label}</button></div>`;
  return `<button type="button" class="chat-attachment-link" data-action="chat-open-attachment" data-id="${esc(m.id)}">📎 ${label} · ${Math.ceil((m.attachment.size || 0) / 1024)} Ko</button>`;
}
function chatReplyHtml(m, messages) {
  if (!m.replyToId) return "";
  const quoted = messages.find((x) => same(x.id, m.replyToId));
  if (!quoted) return "";
  return `<button type="button" class="chat-quote" data-action="chat-jump" data-id="${esc(quoted.id)}"><b>${esc(quoted.sender || "Message")}</b><span>${esc((quoted.text || chatMessagePreview(quoted)).slice(0, 120))}</span></button>`;
}
async function hydrateChatAttachments() {
  if (!token) return;
  for (const node of document.querySelectorAll("[data-chat-media]")) {
    const id = node.dataset.chatMedia;
    if (node.dataset.loaded) continue;
    node.dataset.loaded = "1";
    try {
      const r = await fetch("/api/state/messages/" + encodeURIComponent(id) + "/attachment", {
        headers: { Authorization: "Bearer " + token },
      });
      if (!r.ok) throw new Error("Pièce jointe inaccessible.");
      const blob = await r.blob(),
        objectUrl = URL.createObjectURL(blob);
      node.src = objectUrl;
      node.addEventListener("load", () => {
        if (node.tagName === "IMG") node.classList.add("loaded");
      }, { once: true });
    } catch {
      node.replaceWith(document.createTextNode("Pièce jointe indisponible"));
    }
  }
}
async function markChatRead() {
  if (!token || pending || page !== "messages") return;
  const payload = selectedThreadId
    ? { threadId: selectedThreadId }
    : { recipientId: selectedRecipient };
  if (!payload.threadId && !payload.recipientId) return;
  const unread = state.messages.some(
    (m) =>
      !same(m.senderId, profile.id) &&
      !chatRead(m) &&
      (payload.threadId
        ? same(m.threadId, payload.threadId)
        : !m.threadId && same(m.senderId, payload.recipientId)),
  );
  if (!unread) return;
  try {
    const out = await api("state/messages/read", {
      action: "message.read",
      payload,
      revision,
      requestId: crypto.randomUUID(),
    });
    revision = out.revision;
    await refresh();
  } catch (e) {
    if (e.status !== 409) notice(e.message);
  }
}
function threadForm(type = "group", projectId = "") {
  const projects = visible("projects");
  modal(
    type === "project" ? "Discussion de chantier" : "Nouveau groupe",
    `<form id="entityForm" data-kind="message.thread">
      <label>Nom<input name="name" maxlength="120" required placeholder="${type === "project" ? "Discussion chantier" : "Nom du groupe"}"></label>
      <label>Type<select name="type"><option value="group" ${type === "group" ? "selected" : ""}>Groupe</option><option value="project" ${type === "project" ? "selected" : ""}>Chantier</option></select></label>
      <label>Chantier<select name="projectId"><option value="">Aucun</option>${projects.map((p) => `<option value="${esc(p.id)}" ${same(p.id, projectId) ? "selected" : ""}>${esc(p.title)}</option>`).join("")}</select></label>
      <fieldset class="chat-participants"><legend>Participants</legend>${contacts.map((c) => `<label><input type="checkbox" name="participants" value="${esc(c.id)}"> ${esc(c.name)} · ${esc(roles[c.role] || c.role)}</label>`).join("")}</fieldset>
      <p id="formError" class="error" role="alert"></p>
      <div class="form-actions">${btn("Annuler", "close-modal")}<button type="submit" class="btn primary">Créer</button></div>
    </form>`,
  );
}
function messagesView() {
  const threads = state.messageThreads || [];
  if (!contacts.length && !threads.length)
    return '<article class="card empty">Aucune discussion disponible. Créez un groupe ou vérifiez les comptes autorisés.</article>';
  if (!selectedThreadId && !contacts.some((c) => same(c.id, selectedRecipient)))
    selectedRecipient = contacts[0] ? String(contacts[0].id) : "";
  if (selectedThreadId && !threads.some((t) => same(t.id, selectedThreadId)))
    selectedThreadId = "";

  const directConversations = contacts.map((contact) => {
      const messages = state.messages
        .filter(
          (m) =>
            !m.threadId &&
            ((same(m.senderId, profile.id) && same(m.recipientId, contact.id)) ||
              (same(m.senderId, contact.id) && same(m.recipientId, profile.id))),
        )
        .sort((x, y) => new Date(x.createdAt) - new Date(y.createdAt));
      return {
        key: "direct:" + contact.id,
        kind: "direct",
        contact,
        title: contact.name,
        subtitle: roles[contact.role] || contact.role,
        messages,
        last: messages.at(-1),
        unread: messages.filter((m) => !same(m.senderId, profile.id) && !chatRead(m)).length,
      };
    }),
    threadConversations = threads.map((thread) => {
      const messages = state.messages
        .filter((m) => same(m.threadId, thread.id))
        .sort((x, y) => new Date(x.createdAt) - new Date(y.createdAt));
      return {
        key: "thread:" + thread.id,
        kind: "thread",
        thread,
        title: thread.name,
        subtitle: thread.type === "project"
          ? "Chantier · " + (find("projects", thread.projectId)?.title || thread.projectId)
          : "Groupe · " + (thread.participants || []).length + " participants",
        messages,
        last: messages.at(-1),
        unread: messages.filter((m) => !same(m.senderId, profile.id) && !chatRead(m)).length,
      };
    }),
    conversations = [...directConversations, ...threadConversations].sort(
      (x, y) =>
        (y.last ? new Date(y.last.createdAt).getTime() : 0) -
          (x.last ? new Date(x.last.createdAt).getTime() : 0) ||
        x.title.localeCompare(y.title, "fr"),
    );
  let active = selectedThreadId
    ? conversations.find((c) => c.kind === "thread" && same(c.thread?.id, selectedThreadId))
    : conversations.find((c) => c.kind === "direct" && same(c.contact?.id, selectedRecipient));
  active ||= conversations[0];
  if (!active) return '<article class="card empty">Aucune discussion disponible.</article>';
  if (active.kind === "thread") {
    selectedThreadId = String(active.thread.id);
    selectedRecipient = "";
  } else {
    selectedRecipient = String(active.contact.id);
    selectedThreadId = "";
  }
  const list = active.messages;
  let day = "";
  const bubbles =
    list
      .map((m) => {
        const currentDay = chatDate(m.createdAt),
          separator = currentDay !== day
            ? `<div class="chat-day"><span>${esc(currentDay)}</span></div>`
            : "";
        day = currentDay;
        const mine = same(m.senderId, profile.id),
          readCount = (m.readBy || []).filter((id) => !same(id, m.senderId)).length,
          check = mine
            ? `<span class="message-check ${readCount ? "read" : ""}" title="${readCount ? "Lu" : "Envoyé"}">${readCount ? "✓✓" : "✓"}</span>`
            : "";
        return (
          separator +
          `<div class="message ${mine ? "mine" : "theirs"}" id="msg-${esc(m.id)}">
            ${active.kind === "thread" && !mine ? `<b class="message-sender">${esc(m.sender || "Participant")}</b>` : ""}
            ${chatReplyHtml(m, list)}
            ${chatAttachmentHtml(m)}
            ${m.text ? `<p class="prewrap">${esc(m.text)}</p>` : ""}
            <div class="message-meta"><time datetime="${esc(m.createdAt)}">${esc(chatTime(m.createdAt))}</time>${check}</div>
            <div class="message-actions">
              <button type="button" data-action="chat-reply" data-id="${esc(m.id)}">↩ Répondre</button>
              ${deleteRecordButton("messages", m)}
            </div>
          </div>`
        );
      })
      .join("") ||
    '<div class="chat-empty"><span>💬</span><p>Aucun message dans cette conversation.</p><small>Envoyez le premier message ci-dessous.</small></div>';

  return `<section class="whatsapp-chat ${mobileChatOpen ? "mobile-chat-open" : ""}">
    <aside class="chat-sidebar">
      <div class="chat-sidebar-head"><div><h3>Discussions</h3><span>${conversations.length} conversation${conversations.length > 1 ? "s" : ""}</span></div><div class="chat-new-actions"><button type="button" data-action="chat-new-group" title="Nouveau groupe">＋ Groupe</button><button type="button" data-action="chat-new-project" title="Discussion chantier">＋ Chantier</button></div></div>
      <label class="chat-search" for="conversationSearch"><span aria-hidden="true">⌕</span><input id="conversationSearch" type="search" autocomplete="off" placeholder="Rechercher une discussion" aria-label="Rechercher une discussion"></label>
      <div id="conversationList" class="chat-conversations">
        ${conversations.map((c) => {
          const preview = chatMessagePreview(c.last),
            search = `${c.title} ${c.subtitle} ${preview}`.toLowerCase(),
            isActive = c.key === active.key;
          return `<button type="button" class="chat-contact ${isActive ? "active" : ""}" data-action="chat-select" data-id="${esc(c.key)}" data-search="${esc(search)}">
            ${c.kind === "direct" ? chatAvatar(c.contact) : `<span class="chat-avatar chat-avatar-initial chat-group-avatar">${c.thread.type === "project" ? "🏗" : "👥"}</span>`}
            <span class="chat-contact-body">
              <span class="chat-contact-top"><b>${esc(c.title)}</b><time>${c.last ? esc(chatTime(c.last.createdAt)) : ""}</time></span>
              <span class="chat-contact-bottom"><span class="chat-preview">${esc(preview.slice(0, 82))}</span>${c.unread ? `<strong class="chat-unread">${c.unread > 99 ? "99+" : c.unread}</strong>` : `<small>${esc(c.subtitle)}</small>`}</span>
            </span>
          </button>`;
        }).join("")}
      </div>
    </aside>
    <section class="chat-main-panel">
      <header class="chat-header">
        <button type="button" class="chat-back" data-action="chat-back" aria-label="Retour aux discussions">←</button>
        ${active.kind === "direct" ? chatAvatar(active.contact) : `<span class="chat-avatar chat-avatar-initial chat-group-avatar">${active.thread.type === "project" ? "🏗" : "👥"}</span>`}
        <div class="chat-header-person"><strong>${esc(active.title)}</strong><span>${esc(active.subtitle)}</span></div>
      </header>
      <div id="messageThread" class="messages chat-thread" role="log" aria-live="polite" aria-label="Messages avec ${esc(active.title)}">${bubbles}</div>
      <div id="chatReplyBar" class="chat-reply-bar ${chatReplyToId ? "" : "hidden"}">
        <div><b>Réponse</b><span>${chatReplyToId ? esc((list.find((m) => same(m.id, chatReplyToId))?.text || "Message").slice(0, 100)) : ""}</span></div>
        <button type="button" data-action="chat-cancel-reply" aria-label="Annuler la réponse">✕</button>
      </div>
      <div id="chatAttachmentBar" class="chat-attachment-bar ${chatAttachmentDraft ? "" : "hidden"}">
        <span>${chatAttachmentDraft ? esc((chatAttachmentDraft.kind === "audio" ? "🎤 " : "📎 ") + chatAttachmentDraft.name) : ""}</span>
        <button type="button" data-action="chat-cancel-attachment" aria-label="Retirer la pièce jointe">✕</button>
      </div>
      <form id="messageForm" class="chat-composer">
        <input id="chatFile" type="file" hidden accept="image/jpeg,image/png,image/webp,image/gif,application/pdf,text/plain,audio/*">
        <button type="button" class="chat-tool" data-action="chat-file" aria-label="Ajouter une photo ou un fichier" title="Pièce jointe">📎</button>
        <button type="button" class="chat-tool" data-action="chat-voice" aria-label="Enregistrer un message vocal" title="Message vocal">🎤</button>
        <div class="chat-compose-field"><textarea id="messageText" name="text" rows="1" maxlength="5000" placeholder="Écrire un message" aria-label="Écrire un message"></textarea><p id="formError" class="error" role="alert"></p></div>
        <button type="submit" class="chat-send" aria-label="Envoyer le message" title="Envoyer">➤</button>
      </form>
    </section>
  </section>`;
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
const recordDeleteRoles = {
  companies: ["admin", "direction"],
  inventory: ops,
  suppliers: ops,
  vehicles: ops,
  tools: ops,
  maintenance: ops,
  payments: fin,
  expenses: [...ops, "accounting"],
  time: [...hr, "manager", "employee"],
  absences: [...hr, "employee"],
  documents: [...ops, "hr", "accounting", "employee"],
  messages: Object.keys(roles),
};
function deleteRecordButton(kind, r) {
  if (!recordDeleteRoles[kind] || !can(recordDeleteRoles[kind])) return "";
  if (kind === "companies" && r.id === "group") return "";
  if (
    profile.role === "employee" &&
    kind === "time" &&
    r.status !== "À valider"
  )
    return "";
  if (
    profile.role === "employee" &&
    kind === "absences" &&
    r.status !== "En attente"
  )
    return "";
  return btn(
    kind === "messages" ? "Supprimer pour moi" : "Supprimer",
    "record-delete",
    kind + ":" + r.id,
    "danger",
  );
}
function personListName(person, photo = "") {
  const label = person.name || "—";
  return `<span class="person-list-name">${photo ? `<img class="person-list-photo" src="${esc(photo)}" alt="" width="40" height="40" loading="lazy">` : `<span class="person-list-photo person-list-initial" aria-hidden="true">${esc(label.slice(0, 1).toUpperCase())}</span>`}<span>${esc(label)}</span></span>`;
}
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
        ...(recordDeleteRoles[k] && can(recordDeleteRoles[k])
          ? ["Actions"]
          : []),
        ...(k === "employees" ? ["Fiche et compte"] : []),
        ...(k === "clients" && can(createRoles.clients) ? ["Actions"] : []),
      ],
      visible(k).map((r) => [
        ...cols.map(([f]) =>
          ["amount", "buy", "sell", "salary"].includes(f)
            ? money(r[f])
            : ["date", "next", "service"].includes(f)
              ? date(r[f])
              : f === "employeeId"
                ? esc(r[f] ? name("employees", r[f]) : "Non attribué")
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
                      : k === "employees" && f === "name"
                        ? personListName(r, r.photo)
                        : esc(r[f] ?? "—"),
        ),
        ...(recordDeleteRoles[k] && can(recordDeleteRoles[k])
          ? [deleteRecordButton(k, r)]
          : []),
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
        ...(k === "clients" && can(createRoles.clients)
          ? [
              (profile.role === "admin"
                ? btn("Créer un compte", "linked-user", k + ":" + r.id) + " "
                : "") +
                btn("Modifier", "client-edit", r.id) +
                " " +
                btn("Supprimer le client", "client-delete", r.id, "danger"),
            ]
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
const employeeContactFields = [
  ["street", "Adresse / rue et numéro", "text?"],
  ["zip", "Code postal", "text?"],
  ["city", "Ville", "text?"],
  ["country", "Pays", "text?"],
  ["birthDate", "Date de naissance", "date?"],
  ["nationality", "Nationalité(s)", "text?"],
  [
    "residencePermit",
    "Permis de séjour (B, C, L, G, etc. ou non applicable)",
    "text?",
  ],
  ["residencePermitExpiry", "Expiration du permis de séjour", "date?"],
  ["emergencyName", "Contact d’urgence", "text?"],
  ["emergencyPhone", "Téléphone d’urgence", "tel?"],
  ["contractType", "Type de contrat", "text?"],
  ["endDate", "Fin du contrat", "date?"],
  ["notes", "Notes RH", "textarea?"],
];
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
    ["salaryPeriod", "Type de salaire", "salary-period"],
    ["salary", "Salaire mensuel (CHF/mois)", "number"],
    ["activity", "Taux d’activité %", "number", "100"],
    ["vacation", "Solde de vacances (jours)", "number", "20"],
    ["entry", "Date d’entrée", "date"],
    ...employeeContactFields,
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
    (type === "salary-period"
      ? `<select ${attr}><option value="monthly">Salaire mensuel</option><option value="hourly">Salaire horaire</option></select>`
      : type.startsWith("@")
        ? `<select ${attr}>${options(type.slice(1), optional)}</select>`
        : type === "textarea"
          ? `<textarea ${attr} maxlength="5000">${esc(value)}</textarea>`
          : `<input ${attr} type="${type}" value="${esc(value || (type === "date" && !optional ? today() : ""))}" ${type === "number" ? 'min="0" step="0.01"' : ""} ${type === "password" ? (key === "currentPassword" ? 'autocomplete="current-password"' : 'minlength="12" autocomplete="new-password"') : ""}>`)
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
    `<form id="entityForm" method="post" data-kind="${esc(kind)}">${fields.map(field).join("")}${extra}<p id="formError" role="alert" class="error"></p><div class="form-actions">${btn("Annuler", "close-modal")}<button type="submit" class="btn primary">Enregistrer</button></div></form>`,
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
function clientEdit(id) {
  const client = find("clients", id);
  if (!client) return;
  const fields = schemas.clients.filter(([key]) => key !== "company");
  formShell(
    fields,
    "client.update",
    `<input type="hidden" name="id" value="${esc(id)}"><p>L’e-mail de contact ne modifie pas l’identifiant du compte de connexion. Les documents déjà émis conservent leurs coordonnées d’origine.</p>`,
    "Modifier le client",
  );
  for (const [key] of fields)
    $("f_" + key).value = client[key] ?? (key === "country" ? "CH" : "");
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
      `<p>${esc(p.description)}</p><p>${esc(p.address)}</p><p>${date(p.start)} – ${date(p.end)} · ${esc(p.progress)} %</p><p>Équipe : ${(p.team || []).map((id) => esc(name("employees", id))).join(", ") || "Non affectée"}</p>${p.budget !== undefined ? `<p>Budget ${money(p.budget)} · Coûts ${money(p.cost)}</p>` : ""}${can(ops) ? btn("Modifier le suivi", "project-edit", id) + " " + btn("Supprimer le chantier", "project-delete", id, "danger") : ""} ${(() => { const thread = (state.messageThreads || []).find((t) => same(t.projectId, id)); return thread ? btn("Ouvrir la discussion", "chat-open-project", thread.id, "primary") : can(ops) ? btn("Créer la discussion chantier", "chat-create-project", id) : ""; })()}<h4 class="spaced">Documents et photos</h4>${table(
        ["Fichier", ""],
        state.documents
          .filter((x) => same(x.project, id))
          .map((d) => [
            esc(d.name),
            btn("Télécharger", "download", d.id) +
              " " +
              deleteRecordButton("documents", d),
          ]),
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
          personListName(
            u,
            state.employees.find((e) => same(e.id, u.employee_id))?.photo,
          ),
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
  const assignedTools = state.tools.filter((a) => same(a.employeeId, id));
  const assignedVehicles = state.vehicles.filter((a) => same(a.employeeId, id));
  const times = state.time.filter((t) => same(t.employeeId, id));
  const plans = state.planning
    .filter((t) => same(t.employeeId, id) && t.date >= today())
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const absences = state.absences.filter((t) => same(t.employeeId, id));
  const projects = state.projects.filter((p) =>
    (p.team || []).some((eid) => same(eid, id)),
  );
  const docs = state.documents.filter(
    (d) => same(d.employeeId, id) && d.category !== "identity",
  );
  const identityDocs = state.documents.filter(
    (d) => same(d.employeeId, id) && d.category === "identity",
  );
  const privateInfo = can(hr) || same(profile.employee_id, id);
  modal(
    "Fiche salarié et compte",
    `
    <div class="employee-header">${e.photo ? `<img class="employee-photo" src="${esc(e.photo)}" alt="Photo de ${esc(e.name)}">` : `<div class="employee-photo employee-placeholder" aria-label="Photo non renseignée">${esc(e.name.slice(0, 1))}</div>`}
    <div><h3>${esc(e.name)}</h3><p>${esc(e.job || "—")} · ${esc(e.status || "Actif")}</p><p>${[...new Set([e.company, ...(e.companies || [])])].map((c) => esc(name("companies", c))).join(" · ")}</p></div></div>
    ${can(hr) ? `<div class="actions">${btn("Modifier la fiche", "employee-edit", id, "primary")} ${btn("Entreprises / accès", "employee-companies", id)} ${btn("Supprimer le salarié", "employee-delete", id, "danger")}</div>` : ""}
    <div class="employee-summary"><article><strong>${assignedTools.length}</strong><span>Outils attribués</span></article><article><strong>${assignedVehicles.length}</strong><span>Véhicules attribués</span></article><article><strong>${times.reduce((sum, t) => sum + Number(t.hours || 0), 0).toFixed(2)} h</strong><span>Heures enregistrées visibles</span></article><article><strong>${projects.length}</strong><span>Chantiers affectés visibles</span></article></div>
    ${
      privateInfo
        ? `<details open><summary>Coordonnées et informations personnelles</summary><dl class="employee-info"><dt>E-mail de contact</dt><dd>${esc(e.email || "—")}</dd><dt>Téléphone</dt><dd>${esc(e.phone || "—")}</dd><dt>Adresse</dt><dd>${esc([e.street, e.zip, e.city, e.country].filter(Boolean).join(", ") || "Non renseignée")}</dd><dt>Date de naissance</dt><dd>${e.birthDate ? date(e.birthDate) : "—"}</dd><dt>Nationalité(s)</dt><dd>${esc(e.nationality || "Non renseignée")}</dd><dt>Permis de séjour</dt><dd>${esc(e.residencePermit || "Non renseigné")}</dd><dt>Expiration du permis</dt><dd>${e.residencePermitExpiry ? date(e.residencePermitExpiry) : "—"}</dd><dt>Contact d’urgence</dt><dd>${esc([e.emergencyName, e.emergencyPhone].filter(Boolean).join(" · ") || "—")}</dd></dl></details>
    <details><summary>Contrat et rémunération</summary><p>${e.salaryPeriod === "hourly" ? "Salaire horaire" : "Salaire mensuel"} : ${money(e.salary)}${e.salaryPeriod === "hourly" ? " / heure" : " / mois"}</p><p>Activité : ${esc(e.activity ?? "—")} % · Vacances : ${esc(e.vacation ?? "—")} jours</p><p>Contrat : ${esc(e.contractType || "Non renseigné")} · Entrée : ${e.entry ? date(e.entry) : "—"} · Fin : ${e.endDate ? date(e.endDate) : "—"}</p>${can(hr) && e.notes ? `<p class="employee-notes">${esc(e.notes)}</p>` : ""}</details>`
        : ""
    }
    ${
      can(hr)
        ? `<details open><summary>Documents d’identité et justificatifs</summary><p>Documents confidentiels réservés aux personnes disposant d’un accès RH.</p>${btn("Ajouter un justificatif", "employee-document", id)}${table(
            ["Type", "Fichier / description", "Ajouté le", ""],
            identityDocs.map((d) => [
              esc(d.documentType),
              esc(d.name) + (d.description ? `<br>${esc(d.description)}` : ""),
              date(d.createdAt.slice(0, 10)),
              btn("Télécharger", "download", d.id) +
                " " +
                deleteRecordButton("documents", d),
            ]),
          )}</details>`
        : ""
    }
    <details open><summary>Outils et véhicules</summary>${can(hr) ? btn("Gérer les attributions", "employee-assets", id) : ""}<h4>Outils</h4>${table(
      ["Outil", "N° série", "Entreprise"],
      assignedTools.map((a) => [
        esc(a.name),
        esc(a.serial),
        esc(name("companies", a.company)),
      ]),
    )}<h4>Véhicules</h4>${table(
      ["Plaque", "Véhicule", "Kilométrage", "Entretien"],
      assignedVehicles.map((a) => [
        esc(a.plate),
        esc([a.brand, a.model].filter(Boolean).join(" ")),
        esc(a.km),
        a.service ? date(a.service) : "—",
      ]),
    )}</details>
    <details><summary>Planning, heures et absences</summary><h4>Prochaines affectations</h4>${table(
      ["Date", "Horaires", "Chantier"],
      plans.map((p) => [
        date(p.date),
        esc(p.start + "–" + p.end),
        esc(name("projects", p.project)),
      ]),
    )}<h4>Heures enregistrées</h4>${table(
      ["Date", "Chantier", "Heures", "Statut"],
      times.map((t) => [
        date((t.startedAt || t.date || "").slice(0, 10)),
        esc(name("projects", t.project)),
        esc(t.hours),
        esc(t.status),
      ]),
    )}<h4>Absences</h4>${table(
      ["Du", "Au", "Type", "Statut"],
      absences.map((a) => [
        date(a.from),
        date(a.to),
        esc(a.type),
        esc(a.status),
      ]),
    )}</details>
    <details><summary>Chantiers et documents</summary>${table(
      ["Chantier", "Statut", ""],
      projects.map((p) => [
        esc(p.title),
        esc(p.status),
        btn("Ouvrir", "project", p.id),
      ]),
    )}${table(
      ["Document", ""],
      docs.map((d) => [
        esc(d.name),
        btn("Télécharger", "download", d.id) +
          " " +
          deleteRecordButton("documents", d),
      ]),
    )}</details>
    ${accountHtml ? `<details><summary>Compte de connexion</summary>${accountHtml}</details>` : ""}`,
  );
}
function employeeDocument(id) {
  const e = find("employees", id);
  formShell(
    [],
    "document",
    `<input type="hidden" name="employeeId" value="${esc(id)}"><input type="hidden" name="company" value="${esc(e.company)}"><input type="hidden" name="category" value="identity"><label>Type de document<select name="documentType">${["Carte d’identité", "Passeport", "Permis de conduire", "Permis de séjour", "Autre justificatif"].map((t) => `<option>${esc(t)}</option>`).join("")}</select></label><label>Description (facultative)<input name="description" maxlength="200" placeholder="Par exemple : recto ou verso"></label><label>Photo ou fichier<input type="file" name="file" accept="application/pdf,image/jpeg,image/png,image/webp" required></label><p>JPG, PNG, WebP ou PDF, 5 Mo maximum par fichier. Ajoutez le recto et le verso séparément. Accès réservé aux RH.</p>`,
    "Ajouter un justificatif — " + e.name,
  );
}
function employeeEdit(id) {
  const e = find("employees", id);
  formShell(
    schemas.employees.filter((f) => f[0] !== "company"),
    "employee.update",
    `<input type="hidden" name="id" value="${esc(id)}"><fieldset><legend>Photo</legend>${e.photo ? `<img class="employee-photo" src="${esc(e.photo)}" alt="Photo actuelle"><label><input type="checkbox" name="removePhoto"> Retirer la photo actuelle</label>` : ""}<label for="employeePhoto">Photo du salarié</label><input id="employeePhoto" type="file" name="photoFile" accept="image/jpeg,image/png,image/webp"><p>JPG, PNG ou WebP, 5 Mo maximum. La photo sera redimensionnée.</p></fieldset><p class="muted">L’e-mail de contact ne modifie pas l’identifiant du compte de connexion.</p>`,
    "Modifier la fiche salarié",
  );
  for (const [key] of schemas.employees)
    if (key !== "company" && $("f_" + key))
      $("f_" + key).value = e[key] ?? (key === "salaryPeriod" ? "monthly" : "");
  $("f_salary").labels[0].textContent =
    e.salaryPeriod === "hourly"
      ? "Salaire horaire (CHF/heure)"
      : "Salaire mensuel (CHF/mois)";
}
function employeeAssets(id) {
  const e = find("employees", id),
    companies = [e.company, ...(e.companies || [])];
  formShell(
    [],
    "employee.assets",
    `<input type="hidden" name="id" value="${esc(id)}"><p>Choisissez les équipements confiés à ${esc(e.name)}. Décochez-les lors de leur restitution.</p>${[
      "tools",
      "vehicles",
    ]
      .map(
        (k) =>
          `<fieldset><legend>${k === "tools" ? "Outils" : "Véhicules"}</legend>${
            state[k]
              .filter(
                (a) => companies.includes(a.company) || same(a.employeeId, id),
              )
              .map(
                (a) =>
                  `<label class="asset-choice"><input type="checkbox" name="${k}" value="${esc(a.id)}" ${same(a.employeeId, id) ? "checked" : ""} ${a.employeeId && !same(a.employeeId, id) ? "disabled" : ""}> ${esc(k === "tools" ? a.name + " · " + a.serial : a.plate + " · " + a.brand + " " + a.model)} — ${esc(name("companies", a.company))}${a.employeeId && !same(a.employeeId, id) ? " (déjà attribué)" : ""}</label>`,
              )
              .join("") ||
            "<p>Aucun équipement enregistré pour ses entreprises.</p>"
          }</fieldset>`,
      )
      .join("")}`,
    "Attributions du salarié",
  );
}
async function employeePhoto(file) {
  if (!file || !file.size) return undefined;
  if (
    file.size > 5 * 1024 * 1024 ||
    !["image/jpeg", "image/png", "image/webp"].includes(file.type)
  )
    throw new Error("Choisissez une photo JPG, PNG ou WebP de 5 Mo maximum.");
  const bitmap = await createImageBitmap(file);
  try {
    const ratio = Math.min(1, 320 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    canvas
      .getContext("2d")
      .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    bitmap.close();
  }
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
      ["employeeSalaryPeriod", "Type de salaire", "salary-period"],
      ["employeeSalary", "Salaire mensuel (CHF/mois)", "number"],
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
  if (["f_salaryPeriod", "f_employeeSalaryPeriod"].includes(e.target.id)) {
    const amount = $(
      e.target.id === "f_salaryPeriod" ? "f_salary" : "f_employeeSalary",
    );
    amount.labels[0].textContent =
      e.target.value === "hourly"
        ? "Salaire horaire (CHF/heure)"
        : "Salaire mensuel (CHF/mois)";
  }
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
    if (page === "messages") mobileChatOpen = false;
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
    if (a === "chat-select") {
      if (String(id).startsWith("thread:")) {
        selectedThreadId = String(id).slice(7);
        selectedRecipient = "";
      } else {
        selectedRecipient = String(id).replace(/^direct:/, "");
        selectedThreadId = "";
      }
      chatReplyToId = "";
      chatAttachmentDraft = null;
      mobileChatOpen = true;
      render();
    } else if (a === "chat-back") {
      mobileChatOpen = false;
      render();
    } else if (a === "chat-new-group") threadForm("group");
    else if (a === "chat-new-project") threadForm("project");
    else if (a === "chat-open-project") {
      page = "messages";
      selectedThreadId = String(id);
      selectedRecipient = "";
      mobileChatOpen = true;
      closeModal();
      render();
    } else if (a === "chat-create-project") {
      closeModal();
      threadForm("project", String(id));
    } else if (a === "chat-reply") {
      chatReplyToId = String(id);
      render();
      $("messageText")?.focus();
    } else if (a === "chat-cancel-reply") {
      chatReplyToId = "";
      render();
      $("messageText")?.focus();
    } else if (a === "chat-cancel-attachment") {
      chatAttachmentDraft = null;
      render();
      $("messageText")?.focus();
    } else if (a === "chat-jump") {
      document.getElementById("msg-" + id)?.scrollIntoView({ behavior: "smooth", block: "center" });
    } else if (a === "chat-file") $("chatFile")?.click();
    else if (a === "chat-open-attachment") {
      const r = await fetch("/api/state/messages/" + encodeURIComponent(id) + "/attachment", {
        headers: { Authorization: "Bearer " + token },
      });
      if (!r.ok) throw new Error("Pièce jointe inaccessible.");
      const blob = await r.blob(),
        url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } else if (a === "chat-voice") {
      if (chatRecorder?.state === "recording") {
        chatRecorder.stop();
        b.textContent = "🎤";
        b.classList.remove("recording");
      } else {
        if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
          throw new Error("Enregistrement vocal non disponible sur cet appareil.");
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true }),
          chunks = [],
          recorder = new MediaRecorder(stream);
        chatRecorder = recorder;
        recorder.ondataavailable = (event) => {
          if (event.data.size) chunks.push(event.data);
        };
        recorder.onstop = async () => {
          stream.getTracks().forEach((track) => track.stop());
          const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
          if (blob.size > 5 * 1024 * 1024) {
            notice("Message vocal trop volumineux (5 Mo maximum).");
            return;
          }
          const content = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          chatAttachmentDraft = {
            name: "message-vocal-" + Date.now() + ".webm",
            mime: (blob.type || "audio/webm").split(";")[0],
            content,
            kind: "audio",
          };
          chatRecorder = null;
          render();
        };
        recorder.start();
        b.textContent = "■";
        b.classList.add("recording");
      }
    } else if (a === "close-modal") closeModal();
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
    } else if (a === "record-delete") {
      const split = id.indexOf(":"),
        kind = id.slice(0, split),
        rid = id.slice(split + 1);
      const record = find(kind, rid);
      const prompt =
        kind === "messages"
          ? "Masquer ce message pour vous ? Il restera visible pour votre interlocuteur."
          : `Supprimer définitivement cet élément (${record?.name || record?.title || record?.id || rid}) ? Cette action est irréversible. Les totaux associés seront mis à jour. La suppression peut être bloquée si l’élément est lié à d’autres données.`;
      if (record && confirm(prompt)) {
        const result = await mutate("record.delete", { kind, id: rid });
        if (result)
          toast(
            kind === "messages"
              ? "Message supprimé pour vous."
              : "Élément supprimé.",
          );
      }
    } else if (a === "client-edit") {
      clientEdit(id);
    } else if (a === "client-delete") {
      const client = find("clients", id);
      if (
        client &&
        confirm(
          `Supprimer définitivement le client « ${client.name} » ? Cette action est irréversible. La suppression sera refusée si des données ou un compte de connexion sont liés.`,
        )
      ) {
        const result = await mutate("client.delete", { id });
        if (result) toast("Client supprimé.");
      }
    } else if (a === "project-delete") {
      const project = find("projects", id);
      if (
        project &&
        confirm(
          `Supprimer définitivement le chantier « ${project.title} » ? Cette action est irréversible. La suppression sera refusée si des heures, documents ou autres données y sont liés.`,
        )
      ) {
        const result = await mutate("project.delete", { id });
        if (result) toast("Chantier supprimé.");
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
    else if (a === "employee-edit") employeeEdit(id);
    else if (a === "employee-document") employeeDocument(id);
    else if (a === "employee-assets") employeeAssets(id);
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
  // Named form controls (e.g. name="id") shadow HTMLFormElement properties in browsers.
  const formId = f.getAttribute("id");
  if (!["entityForm", "messageForm"].includes(formId)) return;
  e.preventDefault();
  if (pending) return;
  const data = new FormData(f),
    p = Object.fromEntries(data);
  const k = f.dataset.kind;
  try {
    if (formId === "messageForm") {
      const payload = {
        text: p.text || "",
        recipientId: selectedThreadId ? null : selectedRecipient,
        threadId: selectedThreadId || "",
        replyToId: chatReplyToId || "",
        attachment: chatAttachmentDraft,
      };
      const result = await mutate(
        "message",
        payload,
        null,
        "state/messages",
        f,
      );
      if (result) {
        chatReplyToId = "";
        chatAttachmentDraft = null;
        render();
      }
      return result;
    }
    if (k === "message.thread") {
      p.participants = data.getAll("participants");
      if (p.type !== "project") p.projectId = "";
      const result = await mutate(
        "message.thread",
        p,
        null,
        "state/message-threads",
        f,
      );
      if (result?.id) {
        selectedThreadId = String(result.id);
        selectedRecipient = "";
        mobileChatOpen = true;
        render();
      }
      return result;
    }
    if (k === "employee.update") {
      const photo = await employeePhoto(data.get("photoFile"));
      delete p.photoFile;
      if (photo !== undefined) p.photo = photo;
      else if (p.removePhoto) p.photo = "";
      delete p.removePhoto;
    }
    if (k === "employee.assets") {
      p.tools = data.getAll("tools");
      p.vehicles = data.getAll("vehicles");
    }
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
      const result = await mutate(
        "document",
        { ...p, name: file.name, mime: file.type, content },
        null,
        "state/documents",
        f,
      );
      if (result && p.category === "identity")
        await employeeDetail(p.employeeId);
      return;
    }
    if (k === "user" && p.isEmployee === "yes")
      p.employeeCompanies = data.getAll("employeeCompanies");
    if (k === "user" && p.isEmployee === "yes" && !p.employeeId) {
      p.newEmployee = {
        job: p.employeeJob,
        phone: p.employeePhone,
        salary: p.employeeSalary,
        salaryPeriod: p.employeeSalaryPeriod,
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
    if (
      result &&
      ["employees", "employee.update", "employee.assets"].includes(k)
    )
      await employeeDetail(result.id);
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
  if (e.target.id === "conversationSearch") {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll(".chat-contact").forEach((row) => {
      row.hidden = !!q && !row.dataset.search.includes(q);
    });
  }
});
document.addEventListener("change", async (e) => {
  if (e.target.id === "chatFile") {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      notice("Pièce jointe de 5 Mo maximum.");
      e.target.value = "";
      return;
    }
    const content = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    chatAttachmentDraft = {
      name: file.name,
      mime: file.type || "application/octet-stream",
      content,
      kind: file.type.startsWith("image/") ? "image" : file.type.startsWith("audio/") ? "audio" : "file",
    };
    render();
    return;
  }
  if (["f_company", "f_clientId"].includes(e.target.id)) filterFinanceClient();
  if (
    e.target.id === "f_company" &&
    $("entityForm")?.dataset.kind === "finance.settings"
  )
    loadBillingSettings();
});
document.addEventListener("keydown", (e) => {
  if (
    e.target.id === "messageText" &&
    e.key === "Enter" &&
    !e.shiftKey &&
    !e.isComposing
  ) {
    e.preventDefault();
    e.target.form?.requestSubmit();
    return;
  }
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
