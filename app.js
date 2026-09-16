"use strict";
const $ = (id) => document.getElementById(id);
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
  employees: ["Salariés", [...hr, "manager"]],
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
  (state?.[k] || []).filter(
    (x) => !company || !x.company || x.company === company,
  );
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
    await api(endpoint, { action, payload, collection, revision, requestId });
    saved = true;
    if (form) delete form.dataset.requestId;
    await refresh();
    closeModal(true);
    notice("");
    toast("Modification enregistrée.");
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
  if (!menus[page]?.[1].includes(profile.role)) page = "dashboard";
  $("title").textContent = menus[page][0];
  $("userName").textContent = profile.name + " · " + roles[profile.role];
  $("nav").innerHTML = Object.entries(menus)
    .filter(
      ([k, [, rs]]) =>
        rs.includes(profile.role) &&
        (k !== "users" || profile.company === "group"),
    )
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
  $("content").innerHTML = views[page] ? views[page]() : genericPage(page);
  if (page === "users") loadUsers();
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
    heading("Heures enregistrées", btn("Exporter CSV", "export", "time")) +
    table(
      ["Salarié", "Chantier", "Début", "Fin", "Pause", "Heures", "Statut", ""],
      visible("time").map((t) => [
        esc(name("employees", t.employeeId)),
        esc(t.project),
        esc(
          t.startedAt ? new Date(t.startedAt).toLocaleString("fr-CH") : t.start,
        ),
        esc(t.endedAt ? new Date(t.endedAt).toLocaleString("fr-CH") : t.end),
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
function planningView() {
  return (
    heading(
      "Affectations",
      can(ops)
        ? btn("Planifier", "new", "planning", "primary") +
            " " +
            btn("Exporter CSV", "export", "planning")
        : btn("Exporter CSV", "export", "planning"),
    ) +
    table(
      ["Date", "Début", "Fin", "Salarié", "Chantier", "Lieu", ""],
      [...visible("planning")]
        .sort(
          (a, b) =>
            a.date.localeCompare(b.date) || a.start.localeCompare(b.start),
        )
        .map((p) => [
          date(p.date),
          esc(p.start),
          esc(p.end),
          esc(name("employees", p.employeeId)),
          esc(p.project),
          esc(p.location),
          can(ops) ? btn("Supprimer", "planning.delete", p.id, "danger") : "",
        ]),
    )
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
function financeView(k) {
  const quote = k === "quotes";
  return (
    heading(
      quote ? "Devis" : "Factures",
      can(fin)
        ? btn("Créer", "new", k, "primary") +
            " " +
            btn("Exporter CSV", "export", k)
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
      visible(k).map((r) => [
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
        btn("Ouvrir", quote ? "quote" : "invoice", r.id),
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
        ...(["employees", "clients"].includes(k) && profile.role === "admin"
          ? ["Accès"]
          : []),
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
                  ? esc(name("companies", r[f]))
                  : esc(r[f] ?? "—"),
        ),
        ...(["employees", "clients"].includes(k) && profile.role === "admin"
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
    ["city", "Ville"],
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
function lineRow() {
  return (
    '<div class="invoice-line"><label>Description<input name="lineDescription" required maxlength="500"></label><label>Quantité<input name="lineQuantity" type="number" step="0.001" min="0.001" value="1" required></label><label>Prix unitaire CHF<input name="linePrice" type="number" step="0.01" min="0.01" required></label>' +
    btn("Retirer", "remove-line") +
    "</div>"
  );
}
function newForm(k) {
  if (!schemas[k]) return;
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
  const c = find("clients", r.clientId),
    co = find("companies", r.company);
  const html = `<div class="document"><div class="document-head"><div><h2>${esc(co?.name || "Sousa Group")}</h2></div><div><b>${k === "quotes" ? "DEVIS" : "FACTURE"}</b><p>${esc(r.id)}</p><p>${date(r.date)}</p></div></div><p>Client : ${esc(c?.name)}<br>${esc(c?.city)}<br>${esc(c?.email)}</p><h3>${esc(r.title)}</h3>${table(
    ["Description", "Quantité", "Prix unitaire", "Total"],
    (
      r.lines || [{ description: r.title, quantity: 1, unitPrice: r.amount }]
    ).map((l) => [
      esc(l.description),
      esc(l.quantity),
      money(l.unitPrice),
      money(Math.round(l.quantity * Math.round(l.unitPrice * 100)) / 100),
    ]),
  )}<div class="doc-total"><b>Total : ${money(r.amount)}</b></div><p>${k === "quotes" ? "Valable jusqu’au" : "Échéance"} : ${date(r.valid || r.due)}</p>${k === "invoices" ? `<p>Payé : ${money(r.paid)} · Solde : ${money(r.amount - (r.paid || 0))}</p>` : ""}${r.acceptedAt ? `<p>Accepté dans le portail le ${esc(new Date(r.acceptedAt).toLocaleString("fr-CH"))}.</p>` : ""}</div>`;
  $("printArea").innerHTML = html;
  modal(
    r.id,
    btn("Imprimer / PDF", "print") +
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
      html,
  );
}
async function loadUsers() {
  try {
    const out = await api("state/users");
    userAccounts = out.users;
    if (!$("usersList")) return;
    $("usersList").innerHTML = table(
      ["Nom", "E-mail", "Rôle", "Statut", ""],
      out.users.map((u) => [
        esc(u.name),
        esc(u.email),
        esc(roles[u.role]),
        u.disabled ? "Désactivé" : "Actif",
        btn("Modifier / relier", "edit-user", u.id) +
          " " +
          btn("Réinitialiser le mot de passe", "reset-password", u.id) +
          " " +
          (!same(u.id, profile.id) && !u.disabled
            ? btn("Désactiver", "disable-user", u.id, "danger")
            : ""),
      ]),
    );
  } catch (e) {
    if ($("usersList")) $("usersList").textContent = e.message;
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
    `<label for="f_role">Rôle</label><select id="f_role" name="role">${Object.entries(
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
    } else if (a === "new") newForm(id);
    else if (a === "project") projectModal(id);
    else if (a === "quote" || a === "invoice")
      documentModal(a === "quote" ? "quotes" : "invoices", id);
    else if (a === "print") window.print();
    else if (a === "add-line")
      $("lines").insertAdjacentHTML("beforeend", lineRow());
    else if (a === "remove-line") {
      if (document.querySelectorAll(".invoice-line").length > 1)
        b.closest(".invoice-line").remove();
    } else if (a === "project-edit") {
      const p = find("projects", id);
      formShell(
        [
          ["progress", "Avancement %", "number", p.progress],
          ["description", "Description", "textarea?", p.description],
        ],
        "project.update",
        `<input type="hidden" name="id" value="${esc(id)}"><label>Statut<select name="status">${["Planifié", "En cours", "Terminé", "À facturer"].map((s) => `<option ${s === p.status ? "selected" : ""}>${s}</option>`).join("")}</select></label><label>Équipe<select name="team" multiple>${state.employees
          .filter((e) => e.company === p.company)
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
    else if (a === "user-form") userForm();
    else if (a === "linked-user") userForm(id);
    else if (a === "edit-user") {
      const u = userAccounts.find((x) => same(x.id, id));
      userForm();
      $("f_name").value = u.name;
      $("f_email").value = u.email;
      $("f_company").value = u.company;
      $("f_employeeId").value = u.employee_id || "";
      $("f_clientId").value = u.client_id || "";
      $("f_role").value = u.role;
      $("entityForm").insertAdjacentHTML(
        "beforeend",
        `<input type="hidden" name="id" value="${esc(u.id)}">`,
      );
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
    if (k === "user" || k === "reset-password")
      return await mutate(
        k,
        p,
        null,
        k === "user" ? "state/users" : "state/users/password",
        f,
      );
    if (k === "project.update") p.team = data.getAll("team");
    if (["quotes", "invoices"].includes(k))
      p.lines = [...f.querySelectorAll(".invoice-line")].map((row) => ({
        description: row.querySelector("[name=lineDescription]").value,
        quantity: row.querySelector("[name=lineQuantity]").value,
        unitPrice: row.querySelector("[name=linePrice]").value,
      }));
    await mutate(
      k.includes(".") ? k : "create",
      p,
      k.includes(".") ? undefined : k,
      "state/command",
      f,
    );
  } catch (err) {
    const target = $("formError");
    if (target) target.textContent = err.message;
    else notice(err.message);
  }
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
