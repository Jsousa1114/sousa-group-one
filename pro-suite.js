"use strict";

(() => {
  let host = null;
  let activeTab = "overview";
  let planMode = "week";
  let planDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Zurich",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  let cache = {};
  let searchTimer = null;
  let configLoadedAt = 0;

  const core = () => window.SGOChatCore;
  const state = () => core()?.getState?.() || {};
  const profile = () => core()?.getProfile?.() || {};
  const esc = (value) => core()?.esc?.(value) ?? String(value ?? "");
  const api = (path, body) => core().api("pro/" + path, body);
  const money = (value) => new Intl.NumberFormat("fr-CH", { style: "currency", currency: "CHF" }).format(Number(value) || 0);
  const fmtDate = (value) => value ? new Date(String(value).length === 10 ? value + "T12:00:00" : value).toLocaleDateString("fr-CH") : "—";
  const fmtDateTime = (value) => value ? new Date(value).toLocaleString("fr-CH", { timeZone: "Europe/Zurich" }) : "—";
  const privileged = () => ["admin", "direction", "hr", "manager", "accounting"].includes(profile().role);
  const direction = () => ["admin", "direction"].includes(profile().role);
  const proCan = (key) => direction() || (cache.workspaceConfig?.permissions || []).includes(key);
  const company = () => core()?.getCompany?.() || "";
  const visible = (kind) => (state()[kind] || []).filter((x) => !x.deletedAt && (!company() || !x.company || String(x.company) === String(company())));
  const person = (id) => (state().employees || []).find((x) => String(x.id) === String(id))?.name || id || "—";
  const projectName = (id) => (state().projects || []).find((x) => String(x.id) === String(id))?.title || id || "—";

  function button(label, action, attrs = "", kind = "") {
    return `<button type="button" class="btn ${kind}" data-pro-action="${esc(action)}" ${attrs}>${esc(label)}</button>`;
  }
  function card(title, body, actions = "") {
    return `<article class="card pro-card"><div class="pro-card-head"><h3>${esc(title)}</h3><div>${actions}</div></div>${body}</article>`;
  }
  function empty(text) {
    return `<p class="muted">${esc(text)}</p>`;
  }
  function tabsMarkup() {
    const tabs = [
      ["overview", "À traiter"],
      ["projects", "Fiches chantier"],
      ["planning", "Planning Pro"],
      ["activity", "Activité"],
      ...(privileged() ? [["trash", "Corbeille"]] : []),
      ...(direction() ? [["permissions", "Permissions"], ["settings", "Vente / White-label"]] : []),
    ];
    if (!tabs.some(([id]) => id === activeTab)) activeTab = "overview";
    return `<div class="pro-tabs">${tabs.map(([id, label]) => `<button class="${activeTab === id ? "active" : ""}" data-pro-tab="${id}">${esc(label)}</button>`).join("")}</div>`;
  }
  function shell() {
    return `<section class="pro-suite">
      <div class="pro-hero">
        <div><span>CENTRE DE GESTION</span><h2>Un seul cockpit pour Sousa Group One</h2><p>Actions urgentes, chantiers, planning, activité, sécurité et configuration commerciale.</p></div>
        <div class="pro-hero-actions">${button("Recherche globale", "search", "", "primary")}</div>
      </div>
      ${tabsMarkup()}
      <div id="proBody"></div>
    </section>`;
  }

  const modulePageMap = {
    dashboard: "dashboard",
    employees: "employees",
    time: "time",
    planning: "planning",
    absences: "absences",
    projects: "projects",
    clients: "crm",
    quotes: "quotes",
    invoices: "invoices",
    payments: "payments",
    expenses: "invoices",
    inventory: "inventory",
    suppliers: "inventory",
    vehicles: "vehicles",
    tools: "tools",
    maintenance: "maintenance",
    documents: "documents",
    messages: "messaging",
    reports: "reports",
    pilotage: "crm",
    advanced: "dashboard",
    pro: "dashboard",
  };
  async function applyWorkspaceConfig(force = false) {
    if (!profile()?.id) return;
    if (!force && Date.now() - configLoadedAt < 60000 && cache.workspaceConfig) {
      applyConfigToUi(cache.workspaceConfig);
      return;
    }
    const cfg = await api("config");
    cache.workspaceConfig = cfg;
    configLoadedAt = Date.now();
    applyConfigToUi(cfg);
  }
  function applyConfigToUi(cfg) {
    if (!cfg) return;
    document.title = cfg.companyName || "Sousa Group One";
    if (cfg.accentColor) document.documentElement.style.setProperty("--accent", cfg.accentColor);
    if (cfg.primaryColor) document.documentElement.style.setProperty("--brand-primary", cfg.primaryColor);
    if (cfg.logoUrl) {
      document.querySelectorAll(".brand-logo").forEach((img) => { img.src = cfg.logoUrl; });
    }
    document.querySelectorAll(".brand b").forEach((el) => {
      if (cfg.companyName) el.textContent = String(cfg.companyName).replace(/\s+One$/i, "");
    });
    const modules = cfg.modules || {};
    document.querySelectorAll("#nav [data-page]").forEach((button) => {
      const moduleKey = modulePageMap[button.dataset.page];
      button.hidden = !!moduleKey && modules[moduleKey] === false;
    });
  }

  function actionKpi(label, value, action, kind = "") {
    return `<button type="button" class="pro-kpi ${kind}" data-pro-action="${esc(action)}"><b>${esc(value)}</b><span>${esc(label)}</span></button>`;
  }

  async function loadDashboard() {
    return api("dashboard" + (company() ? "?company=" + encodeURIComponent(company()) : ""));
  }

  async function renderOverview() {
    const out = await loadDashboard();
    cache.dashboard = out;
    const a = out.actions || {};
    const finance = out.finance;
    host.innerHTML = `
      <div class="pro-kpi-grid">
        ${actionKpi("Salariés au travail", a.workingNow || 0, "goto-time")}
        ${actionKpi("Chantiers actifs", a.activeProjects || 0, "goto-projects")}
        ${actionKpi("Chantiers en retard", a.overdueProjects || 0, "goto-projects", (a.overdueProjects || 0) ? "danger" : "")}
        ${actionKpi("Heures à valider", a.pendingTime || 0, "goto-time", (a.pendingTime || 0) ? "warning" : "")}
        ${actionKpi("Absences à valider", a.pendingAbsences || 0, "goto-absences", (a.pendingAbsences || 0) ? "warning" : "")}
        ${actionKpi("Rendez-vous aujourd'hui", a.appointmentsToday || 0, "goto-planning")}
        ${actionKpi("Factures échues", a.overdueInvoices || 0, "goto-invoices", (a.overdueInvoices || 0) ? "danger" : "")}
        ${actionKpi("Devis sans réponse", a.pendingQuotes || 0, "goto-quotes")}
        ${actionKpi("Stock faible", a.lowStock || 0, "goto-inventory", (a.lowStock || 0) ? "warning" : "")}
        ${actionKpi("Interventions urgentes", a.urgentWork || 0, "goto-projects", (a.urgentWork || 0) ? "danger" : "")}
        ${actionKpi("Notifications non lues", a.unreadNotifications || 0, "tab-activity")}
      </div>
      ${finance ? `<div class="pro-finance-grid">
        <article><span>CA facturé</span><b>${money(finance.revenue)}</b></article>
        <article><span>Marge estimée</span><b>${money(finance.margin)}</b></article>
        <article><span>Dépenses</span><b>${money(finance.expenses)}</b></article>
        <article><span>Impayés</span><b>${money(finance.outstanding)}</b></article>
        <article><span>Heures productives</span><b>${Number(finance.productiveHours || 0).toFixed(2)} h</b></article>
      </div>` : ""}
      ${finance?.byCompany?.length ? `<div class="pro-grid-2">
        ${card("Rentabilité par entreprise", simpleRows(finance.byCompany, (x) => `<button type="button" data-pro-action="company-profit" data-company="${esc(x.company)}"><span><b>${esc((state().companies || []).find((c) => String(c.id) === String(x.company))?.name || x.company)}</b><small>CA ${money(x.revenue)} · coût ${money(Math.max(Number(x.expenses || 0), Number(x.projectCost || 0)))} · impayés ${money(x.outstanding)}</small></span><strong>${money(x.margin)}</strong></button>`))}
        ${card("Rentabilité par chantier", simpleRows((finance.byProject || []).slice(0, 12), (x) => `<button type="button" data-pro-action="project-central" data-id="${esc(x.id)}"><span><b>${esc(x.title || x.id)}</b><small>${esc(x.id)} · CA ${money(x.revenue)} · coût ${money(x.cost)} · ${Number(x.productiveHours || 0).toFixed(1)} h</small></span><strong>${money(x.margin)}</strong></button>`))}
      </div>` : ""}
      <div class="pro-grid-2">
        ${card("Chantiers en retard", `<div class="pro-list">${(out.lists?.overdueProjects || []).map((x) => `<button type="button" data-pro-action="project-central" data-id="${esc(x.id)}"><span><b>${esc(x.title)}</b><small>${esc(x.id)} · prévu ${fmtDate(x.end)}</small></span><strong>Ouvrir</strong></button>`).join("") || empty("Aucun chantier en retard.")}</div>`)}
        ${card("Factures échues", `<div class="pro-list">${(out.lists?.overdueInvoices || []).map((x) => `<button type="button" data-pro-action="goto-invoice" data-id="${esc(x.id)}"><span><b>${esc(x.id)}</b><small>Échéance ${fmtDate(x.due)} · solde ${money(Number(x.amount || 0) - Number(x.paid || 0))}</small></span><strong>Ouvrir</strong></button>`).join("") || empty("Aucune facture échue.")}</div>`)}
        ${card("Stock faible", `<div class="pro-list">${(out.lists?.lowStock || []).map((x) => `<div><span><b>${esc(x.name)}</b><small>Stock ${esc(x.stock)} · minimum ${esc(x.min)}</small></span></div>`).join("") || empty("Aucune alerte stock.")}</div>`)}
        ${card("Interventions urgentes", `<div class="pro-list">${(out.lists?.urgentWork || []).map((x) => `<button type="button" data-pro-action="project-central" data-id="${esc(x.project_id || "")}"><span><b>${esc(x.title)}</b><small>${fmtDateTime(x.scheduled_at)} · ${esc(x.status)}</small></span><strong>Ouvrir</strong></button>`).join("") || empty("Aucune intervention urgente.")}</div>`)}
      </div>`;
  }

  async function renderProjects() {
    const projects = visible("projects").sort((a, b) => String(b.createdAt || b.start || "").localeCompare(String(a.createdAt || a.start || "")));
    host.innerHTML = `<div class="pro-toolbar"><div><h3>Fiche chantier centrale</h3><p class="muted">Le chantier devient le centre de toutes les données opérationnelles.</p></div><label class="pro-filter">Filtrer<input id="proProjectFilter" placeholder="N°, client, adresse, titre…"></label></div>
      <div id="proProjectList" class="pro-project-list">${projectCards(projects)}</div>`;
  }
  function projectCards(projects) {
    return projects.map((p) => {
      const client = (state().clients || []).find((x) => String(x.id) === String(p.clientId));
      return `<article class="card pro-project-card" data-search="${esc([p.id, p.title, p.address, client?.name, p.status].filter(Boolean).join(" ").toLowerCase())}">
        <div><span class="status neutral">${esc(p.status || "—")}</span><h3>${esc(p.title)}</h3><p>${esc(p.id)} · ${esc(client?.name || "Client")}</p><small>${esc(p.address || "")}</small></div>
        <div class="pro-project-progress"><b>${esc(p.progress || 0)}%</b><span><i style="width:${Math.max(0, Math.min(100, Number(p.progress) || 0))}%"></i></span></div>
        ${button("Ouvrir la fiche centrale", "project-central", `data-id="${esc(p.id)}"`, "primary")}
      </article>`;
    }).join("") || `<article class="card empty">Aucun chantier accessible.</article>`;
  }

  function section(title, body) {
    return `<section class="pro-project-section"><h3>${esc(title)}</h3>${body}</section>`;
  }
  function simpleRows(rows, renderer, none = "Aucun élément.") {
    return `<div class="pro-list">${rows.map(renderer).join("") || empty(none)}</div>`;
  }

  async function openProject(id) {
    if (!id) throw new Error("Chantier introuvable.");
    const out = await api("project/" + encodeURIComponent(id));
    cache.project = out;
    const p = out.project;
    const finance = out.finance;
    const team = out.team || [];
    const plan = out.planning || [];
    const time = out.time || [];
    const work = out.workOrders || [];
    const docs = out.documents || [];
    const threadButton = out.conversation ? button("Ouvrir la conversation chantier", "open-conversation", `data-key="thread:${esc(out.conversation.id)}"`, "primary") : "";
    const finishButton = !["Terminé", "Payé", "Archivé"].includes(p.status) && privileged() ? button("Terminer le chantier", "finish-project", `data-id="${esc(p.id)}"`, "primary") : "";
    core().modal(`Chantier ${p.id}`, `<div class="pro-project-detail">
      <div class="pro-project-header">
        <div><span class="status neutral">${esc(p.status)}</span><h2>${esc(p.title)}</h2><p>${esc(out.client?.name || "—")} · ${esc(p.address || "—")}</p><small>${esc(out.company?.name || p.company)} · ${fmtDate(p.start)} → ${fmtDate(p.end)}</small></div>
        <div class="pro-project-header-actions">${finishButton}${threadButton}</div>
      </div>
      <div class="pro-project-summary">
        <article><span>Avancement</span><b>${esc(p.progress || 0)}%</b></article>
        <article><span>Équipe</span><b>${team.length}</b></article>
        <article><span>Heures</span><b>${time.reduce((n, x) => n + Number(x.hours || 0), 0).toFixed(2)} h</b></article>
        <article><span>Documents</span><b>${docs.length}</b></article>
        ${finance ? `<article><span>Marge réelle</span><b>${money(finance.margin)}</b></article>` : ""}
      </div>
      ${section("Client, responsable & équipe", `<div class="pro-info-grid"><div><span>Client</span><b>${esc(out.client?.name || "—")}</b><small>${esc(out.client?.phone || "")} ${esc(out.client?.email || "")}</small></div><div><span>Adresse</span><b>${esc(p.address || "—")}</b></div><div><span>Responsable</span><b>${esc(p.managerName || p.responsible || "À définir")}</b></div><div><span>Salariés assignés</span><b>${team.map((x) => esc(x.name)).join(", ") || "Aucun"}</b></div></div>`)}
      ${section("Planning & rendez-vous", simpleRows([...plan, ...(out.appointments || [])], (x) => `<div><span><b>${esc(x.title || projectName(x.project))}</b><small>${x.date ? `${fmtDate(x.date)} · ${esc(x.start)}–${esc(x.end)} · ${esc(person(x.employeeId))}` : `${fmtDateTime(x.starts_at)} · ${esc(x.status || "")}`}</small></span></div>`, "Rien de planifié."))}
      ${section("Tâches, jalons & checklist", `<div class="pro-grid-3">${card("Tâches", simpleRows(out.tasks || [], (x) => `<div><span><b>${esc(x.title)}</b><small>${esc(x.status)} · ${fmtDate(x.due_date)}</small></span></div>`))}${card("Jalons", simpleRows(out.milestones || [], (x) => `<div><span><b>${esc(x.title)}</b><small>${esc(x.status)} · ${fmtDate(x.due_date)}</small></span></div>`))}${card("Checklist", simpleRows(out.checklist || [], (x) => `<div><span><b>${x.completed ? "✓ " : "○ "}${esc(x.label)}</b></span></div>`))}</div>`)}
      ${section("Photos, documents & rapports", `<div class="pro-grid-2">${card("Documents", simpleRows(docs, (x) => `<div><span><b>${esc(x.name)}</b><small>${esc(x.category || "Document")}</small></span></div>`))}${card("Albums photo", simpleRows(out.photoMeta || [], (x) => `<div><span><b>${esc(x.album)}</b><small>${esc(x.note || "")} · ${(x.annotation || []).length || 0} annotation(s)</small></span></div>`))}</div>${simpleRows(out.reports || [], (x) => `<div><span><b>Rapport ${fmtDate(x.report_date)}</b><small>${esc(x.summary || "")}</small></span></div>`, "Aucun rapport journalier.")}`)}
      ${section("Matériel, heures & dépenses", `<div class="pro-grid-3">${card("Matériel", simpleRows(out.materialMovements || [], (x) => `<div><span><b>${esc(x.inventory_id)}</b><small>${esc(x.movement_type)} · ${esc(x.quantity)}</small></span></div>`))}${card("Heures", simpleRows(time, (x) => `<div><span><b>${esc(person(x.employeeId))}</b><small>${fmtDate((x.startedAt || x.date || "").slice(0, 10))} · ${esc(x.hours)} h · ${esc(x.status)}</small></span></div>`))}${card("Dépenses", simpleRows(out.expenses || [], (x) => `<div><span><b>${esc(x.supplier || "Dépense")}</b><small>${money(x.amount)} · ${fmtDate(x.date)}</small></span></div>`))}</div>`)}
      ${finance ? section("Finance & marge réelle", `<div class="pro-finance-grid"><article><span>Budget</span><b>${money(finance.budget)}</b></article><article><span>Facturé</span><b>${money(finance.invoiced)}</b></article><article><span>Plus-values acceptées</span><b>${money(finance.acceptedChangeOrders)}</b></article><article><span>Coût réel</span><b>${money(finance.realCost)}</b></article><article><span>Marge</span><b>${money(finance.margin)}</b></article><article><span>Encaissé</span><b>${money(finance.paid)}</b></article></div>`) : ""}
      ${section("Devis, factures & paiements", `<div class="pro-grid-3">${card("Devis", simpleRows(out.quotes || [], (x) => `<button type="button" data-pro-action="open-finance" data-kind="quotes" data-id="${esc(x.id)}"><span><b>${esc(x.id)}</b><small>${esc(x.status)} · ${money(x.amount)}</small></span></button>`))}${card("Factures", simpleRows(out.invoices || [], (x) => `<button type="button" data-pro-action="open-finance" data-kind="invoices" data-id="${esc(x.id)}"><span><b>${esc(x.id)}</b><small>${esc(x.status)} · ${money(x.amount)}</small></span></button>`))}${card("Paiements", simpleRows(out.payments || [], (x) => `<div><span><b>${money(x.amount)}</b><small>${fmtDate(x.date)} · ${esc(x.method || "")}</small></span></div>`))}</div>`)}
      ${section("Interventions & signatures", simpleRows(work, (x) => `<div><span><b>${esc(x.title)}</b><small>${esc(x.status)} · ${fmtDateTime(x.scheduled_at)}${x.customer_signature ? ` · signé par ${esc(x.customer_signature)}` : " · signature en attente"}</small></span><a class="btn secondary" href="/api/pro/intervention/${encodeURIComponent(x.id)}.pdf">PDF</a></div>`, "Aucun bon d'intervention."))}
      ${section("Réception du chantier", out.acceptance
        ? `<div class="pro-info-grid"><div><span>Statut</span><b>✓ Réception signée</b><small>${fmtDateTime(out.acceptance.signed_at)}</small></div><div><span>Signataire</span><b>${esc(out.acceptance.signer_name)}</b><small>${esc(out.acceptance.notes || "")}</small></div></div><div class="form-actions"><a class="btn secondary" href="/api/pro/project/${encodeURIComponent(p.id)}/acceptance.pdf">Télécharger le PV</a>${proCan("project.acceptance") ? button("Refaire la signature", "project-acceptance", `data-id="${esc(p.id)}"`) : ""}</div>`
        : `<div class="pro-empty-action"><p class="muted">Aucune réception signée pour ce chantier.</p>${proCan("project.acceptance") || profile().role === "client" ? button("Faire signer la réception", "project-acceptance", `data-id="${esc(p.id)}"`, "primary") : ""}</div>`)}
      ${section("Réserves & plus-values", `<div class="pro-grid-2">${card("Réserves", simpleRows(out.punch || [], (x) => `<div><span><b>${esc(x.title)}</b><small>${esc(x.severity)} · ${esc(x.status)}</small></span></div>`))}${card("Plus-values", simpleRows(out.changeOrders || [], (x) => `<div><span><b>${esc(x.title)} · ${money(x.amount)}</b><small>${esc(x.status)}</small></span></div>`))}</div>`)}
      ${section("Historique des modifications", simpleRows(out.history || [], (x) => `<div><span><b>${esc(x.event_type)}</b><small>${fmtDateTime(x.created_at)} · ${esc(x.entity_type || "")}</small></span></div>`, "Aucune activité enregistrée."))}
    </div>`);
  }

  function projectAcceptanceForm(projectId) {
    const project = (state().projects || []).find((x) => String(x.id) === String(projectId)) || cache.project?.project || {};
    const existing = cache.project?.project?.id === projectId ? cache.project?.acceptance : null;
    core().modal("Réception du chantier", `<form id="proForm" data-kind="project-acceptance" data-project-id="${esc(projectId)}">
      <p><b>${esc(project.title || projectId)}</b></p>
      <label>Nom du signataire<input name="signerName" required maxlength="200" value="${esc(existing?.signer_name || profile().name || "")}"></label>
      <label>Signature électronique<input name="signature" required maxlength="2000" autocomplete="off" placeholder="Nom / validation électronique" value="${esc(existing?.signature || "")}"></label>
      <label>Observations / réserves<textarea name="notes" maxlength="3000" placeholder="Facultatif">${esc(existing?.notes || "")}</textarea></label>
      <label class="pro-check"><input type="checkbox" name="confirmed" required> Je confirme que le signataire valide la réception du chantier et les observations ci-dessus.</label>
      <p class="muted">La signature, l'utilisateur et l'horodatage sont conservés dans l'historique du chantier. Un PV PDF est généré automatiquement.</p>
      <p id="formError" class="error"></p><button class="btn primary" type="submit">Signer la réception</button>
    </form>`);
  }

  function shiftDate(value, days) {
    const d = new Date(value + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  function weekDates(value) {
    const d = new Date(value + "T12:00:00Z");
    const day = d.getUTCDay();
    const start = shiftDate(value, -((day + 6) % 7));
    return Array.from({ length: 7 }, (_, i) => shiftDate(start, i));
  }
  function monthDates(value) {
    const d = new Date(value + "T12:00:00Z");
    const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    const start = shiftDate(first.toISOString().slice(0, 10), -((first.getUTCDay() + 6) % 7));
    const end = shiftDate(last.toISOString().slice(0, 10), (7 - ((last.getUTCDay() + 6) % 7) - 1));
    const dates = [];
    for (let x = start; x <= end; x = shiftDate(x, 1)) dates.push(x);
    return dates;
  }
  function planningRows() {
    return visible("planning").slice().sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  }
  function conflict(row, all) {
    return all.some((x) => String(x.id) !== String(row.id) && String(x.employeeId) === String(row.employeeId) && x.date === row.date && x.start < row.end && x.end > row.start);
  }
  function shiftHtml(row, all) {
    const vehicle = (state().vehicles || []).find((x) => String(x.id) === String(row.vehicleId || "")),
      equipment = (row.toolIds || []).length,
      companyClass = "company-" + String(row.company || "group").replace(/[^a-z0-9_-]/gi, "").toLowerCase();
    return `<article class="pro-shift ${companyClass} ${conflict(row, all) ? "conflict" : ""}" draggable="true" data-pro-shift="${esc(row.id)}"><b>${esc(row.start)}–${esc(row.end)}</b><span>${esc(person(row.employeeId))}</span><small>${esc(projectName(row.project))}</small>${vehicle || equipment ? `<small>🚐 ${esc(vehicle?.plate || "—")} · 🧰 ${equipment}</small>` : ""}</article>`;
  }
  async function renderPlanning() {
    const all = planningRows();
    const dates = planMode === "day" ? [planDate] : planMode === "month" ? monthDates(planDate) : weekDates(planDate);
    const body = planMode === "day"
      ? `<div class="pro-day-plan pro-drop-zone" data-pro-drop-date="${esc(planDate)}">${all.filter((x) => x.date === planDate).map((x) => shiftHtml(x, all)).join("") || empty("Aucune affectation ce jour.")}</div>`
      : `<div class="${planMode === "month" ? "pro-month-plan" : "pro-week-plan"}">${dates.map((date) => `<section class="pro-plan-day pro-drop-zone ${date === planDate ? "selected" : ""}" data-pro-drop-date="${esc(date)}"><header><b>${fmtDate(date)}</b></header>${all.filter((x) => x.date === date).map((x) => shiftHtml(x, all)).join("")}</section>`).join("")}</div>`;
    host.innerHTML = `<div class="pro-toolbar"><div><h3>Planning visuel</h3><p class="muted">Glissez une affectation sur une autre date. Les conflits salariés, véhicules et équipements sont contrôlés.</p></div><div class="pro-planning-controls">${button("Nouvelle affectation", "plan-new", "", "primary")}${button("‹", "plan-prev")}<input id="proPlanDate" type="date" value="${esc(planDate)}">${button("Aujourd'hui", "plan-today")}${button("›", "plan-next")}<select id="proPlanMode"><option value="day" ${planMode === "day" ? "selected" : ""}>Jour</option><option value="week" ${planMode === "week" ? "selected" : ""}>Semaine</option><option value="month" ${planMode === "month" ? "selected" : ""}>Mois</option></select></div></div>${body}`;
  }

  function planningBulkForm() {
    const projects = visible("projects"),
      employees = visible("employees"),
      vehicles = visible("vehicles"),
      tools = visible("tools");
    core().modal("Nouvelle affectation planning", `<form id="proForm" data-kind="planning-bulk">
      <label>Chantier<select name="projectId" required>${projects.map((x) => `<option value="${esc(x.id)}">${esc(x.id)} · ${esc(x.title)}</option>`).join("")}</select></label>
      <label>Salariés <small class="muted">Ctrl/Cmd ou appui multiple</small><select name="employeeIds" multiple size="7" required>${employees.map((x) => `<option value="${esc(x.id)}">${esc(x.name)} · ${esc(x.job || "")}</option>`).join("")}</select></label>
      <div class="pro-grid-3">
        <label>Date<input type="date" name="date" required value="${esc(planDate)}"></label>
        <label>Début<input type="time" name="start" required value="07:30"></label>
        <label>Fin<input type="time" name="end" required value="16:30"></label>
      </div>
      <label>Lieu<input name="location" maxlength="300" placeholder="Adresse chantier ou autre lieu"></label>
      <label>Véhicule<select name="vehicleId"><option value="">Aucun véhicule</option>${vehicles.map((x) => `<option value="${esc(x.id)}">${esc(x.plate || x.id)} · ${esc([x.brand,x.model].filter(Boolean).join(" "))}</option>`).join("")}</select></label>
      <label>Équipements / outillage<select name="toolIds" multiple size="6">${tools.map((x) => `<option value="${esc(x.id)}">${esc(x.name || x.id)}</option>`).join("")}</select></label>
      <p class="muted">Les absences et les collisions de salarié, véhicule ou équipement sont bloquées avant enregistrement.</p>
      <p id="formError" class="error"></p><button class="btn primary" type="submit">Planifier</button>
    </form>`);
  }

  async function renderActivity() {
    const out = await api("activity");
    cache.activity = out;
    host.innerHTML = `<div class="pro-toolbar"><div><h3>Centre de notifications & activités</h3><p class="muted">Tout ce qui change dans l'application, au même endroit.</p></div><div>${proCan("notification.manage") ? button("Préférences", "notification-prefs") : ""} ${button("Tout marquer comme lu", "read-all")}</div></div>
      <div class="pro-grid-2">
        ${card("Notifications", simpleRows(out.notifications || [], (x) => `<button type="button" class="${x.read_at ? "" : "unread"}" data-pro-action="read-notification" data-id="${esc(x.id)}"><span><b>${esc(x.title)}</b><small>${esc(x.body || "")} · ${fmtDateTime(x.created_at)}</small></span>${x.read_at ? "" : "<i>●</i>"}</button>`, "Aucune notification."))}
        ${card("Activité du groupe", simpleRows(out.events || [], (x) => `<div><span><b>${esc(x.event_type)}</b><small>${fmtDateTime(x.created_at)} · ${esc(x.company || "Groupe")}${x.project_id ? ` · ${esc(x.project_id)}` : ""}</small></span></div>`, "Aucune activité."))}
      </div>`;
  }

  async function notificationPreferencesForm() {
    const out = await api("notification-preferences");
    const labels = {
      messages: "Messages",
      planning: "Planning",
      projects: "Chantiers",
      finance: "Devis, factures & paiements",
      crm: "CRM / relances",
      stock: "Stock faible / achats",
      maintenance: "Maintenance / échéances",
      hr: "RH / absences / heures",
      system: "Système / sécurité",
    };
    core().modal("Préférences de notifications", `<form id="proForm" data-kind="notification-preferences">
      <div class="pro-module-grid">${Object.entries(out.categories || {}).map(([key, enabled]) => `<label><input type="checkbox" name="category:${esc(key)}" ${enabled ? "checked" : ""}> ${esc(labels[key] || key)}</label>`).join("")}</div>
      <hr>
      <label class="pro-check"><input type="checkbox" name="quietEnabled" ${out.quietHours?.enabled ? "checked" : ""}> Activer les heures silencieuses</label>
      <div class="pro-grid-2"><label>Début<input type="time" name="quietStart" value="${esc(out.quietHours?.start || "21:00")}"></label><label>Fin<input type="time" name="quietEnd" value="${esc(out.quietHours?.end || "07:00")}"></label></div>
      <p class="muted">Les préférences servent de filtre central pour les alertes ciblées. Les alertes système critiques restent visibles dans le centre d'activité.</p>
      <p id="formError" class="error"></p><button class="btn primary" type="submit">Enregistrer</button>
    </form>`);
  }

  async function renderTrash() {
    const out = await api("trash");
    host.innerHTML = `<div class="pro-toolbar"><div><h3>Corbeille 30 jours</h3><p class="muted">Les éléments importants peuvent être restaurés avant suppression définitive.</p></div></div>
      <div class="pro-list pro-trash">${(out.items || []).map((x) => `<article class="card"><span><b>${esc(x.label || x.entity_id)}</b><small>${esc(x.entity_type)} · supprimé ${fmtDateTime(x.deleted_at)} · purge prévue ${fmtDateTime(x.purge_after)}</small></span><div>${button("Restaurer", "restore-trash", `data-id="${esc(x.id)}"`, "primary")} ${direction() ? button("Supprimer définitivement", "purge-trash", `data-id="${esc(x.id)}"`, "danger") : ""}</div></article>`).join("") || `<article class="card empty">La corbeille est vide.</article>`}</div>`;
  }

  async function renderPermissions() {
    const out = await api("permissions");
    cache.permissions = out;
    host.innerHTML = `<div class="pro-toolbar"><div><h3>Permissions fines</h3><p class="muted">Au-delà des rôles : salaires, factures, marges, RH, exports, suppressions, etc.</p></div></div>
      <div class="pro-permission-users">${(out.users || []).map((u) => `<article class="card"><div><b>${esc(u.name)}</b><small>${esc(u.role)} · ${esc(u.company)}</small></div>${button("Configurer", "permission-user", `data-id="${esc(u.id)}"`, "primary")}</article>`).join("")}</div>`;
  }
  function openPermission(userId) {
    const out = cache.permissions || {};
    const user = (out.users || []).find((x) => String(x.id) === String(userId));
    if (!user) return;
    const row = (key, label) => `<tr><td>${esc(label)}</td><td><input type="checkbox" name="grants" value="${esc(key)}" ${(user.grants || []).includes(key) ? "checked" : ""}></td><td><input type="checkbox" name="denials" value="${esc(key)}" ${(user.denials || []).includes(key) ? "checked" : ""}></td></tr>`;
    core().modal("Permissions · " + user.name, `<form id="proForm" data-kind="permissions" data-user-id="${esc(user.id)}"><p class="muted">Le rôle principal reste la base. Les autorisations et interdictions ci-dessous permettent d'affiner précisément l'accès.</p><div class="table"><table><thead><tr><th>Permission</th><th>Autoriser</th><th>Refuser</th></tr></thead><tbody>${(out.catalog || []).map((x) => row(x.key, x.label)).join("")}</tbody></table></div><button class="btn primary" type="submit">Enregistrer</button><p id="formError" class="error"></p></form>`);
  }

  async function renderSettings() {
    const out = await api("settings");
    cache.settings = out;
    const moduleLabels = { dashboard: "Tableau de bord", employees: "RH / salariés", time: "Pointage", planning: "Planning", absences: "Absences", projects: "Chantiers", crm: "CRM", quotes: "Devis", invoices: "Factures", payments: "Paiements", inventory: "Stock", vehicles: "Véhicules", tools: "Outillage", maintenance: "Maintenance", documents: "Documents", messaging: "Messagerie", reports: "Rapports", clientPortal: "Portail client" };
    host.innerHTML = `<div class="pro-toolbar"><div><h3>Préparation à la vente</h3><p class="muted">Chaque futur client peut avoir sa marque, ses modules et une base de données isolée.</p></div></div>
      <form id="proForm" data-kind="settings" class="pro-settings">
        ${card("Marque / White-label", `<label>Nom de l'application<input name="companyName" value="${esc(out.companyName)}"></label><label>Clé client / tenant<input name="tenantKey" value="${esc(out.tenantKey)}"></label><label>Logo URL<input name="logoUrl" value="${esc(out.logoUrl)}"></label><div class="pro-grid-2"><label>Couleur principale<input name="primaryColor" value="${esc(out.primaryColor)}"></label><label>Couleur accent<input name="accentColor" value="${esc(out.accentColor)}"></label></div><label>Domaine personnalisé<input name="customDomain" value="${esc(out.whiteLabel?.customDomain || "")}" placeholder="app.client.ch"></label><label>E-mail support<input name="supportEmail" value="${esc(out.whiteLabel?.supportEmail || "")}"></label>`)}
        ${card("Modules activables", `<div class="pro-module-grid">${Object.entries(out.modules || {}).map(([key, enabled]) => `<label><input type="checkbox" name="module:${esc(key)}" ${enabled ? "checked" : ""}> ${esc(moduleLabels[key] || key)}</label>`).join("")}</div>`)}
        ${card("Abonnement", `<div class="pro-grid-3"><label>Plan<input name="plan" value="${esc(out.billing?.plan || "internal")}"></label><label>Statut<input name="billingStatus" value="${esc(out.billing?.status || "active")}"></label><label>Utilisateurs / sièges<input type="number" min="1" name="seats" value="${esc(out.billing?.seats || "")}"></label></div><p class="muted">Isolation prévue : <b>${esc(out.isolation)}</b>. Pour les clients externes, le modèle recommandé est une base PostgreSQL + stockage fichiers séparés par client.</p>`)}
        <button class="btn primary" type="submit">Enregistrer la configuration</button><p id="formError" class="error"></p>
      </form>`;
  }

  async function renderCurrent() {
    if (!host) return;
    host.innerHTML = `<article class="card"><p>Chargement…</p></article>`;
    try {
      if (activeTab === "overview") await renderOverview();
      else if (activeTab === "projects") await renderProjects();
      else if (activeTab === "planning") await renderPlanning();
      else if (activeTab === "activity") await renderActivity();
      else if (activeTab === "trash") await renderTrash();
      else if (activeTab === "permissions") await renderPermissions();
      else if (activeTab === "settings") await renderSettings();
    } catch (error) {
      host.innerHTML = `<article class="card empty"><b>Impossible de charger le centre de gestion.</b><p>${esc(error.message)}</p></article>`;
    }
  }

  async function render(root) {
    host = root;
    root.innerHTML = shell();
    host = root.querySelector("#proBody");
    await renderCurrent();
  }

  async function showSearch(query = "") {
    core().modal("Recherche globale", `<div class="pro-global-search"><input id="proGlobalSearchInput" autocomplete="off" placeholder="Martin, facture 1023, Lausanne, chantier…" value="${esc(query)}"><div id="proGlobalSearchResults">${empty("Tapez au moins 2 caractères.")}</div></div>`);
    const input = document.getElementById("proGlobalSearchInput");
    input?.focus();
    if (query.length >= 2) await runSearch(query);
  }
  async function runSearch(query) {
    const target = document.getElementById("proGlobalSearchResults");
    if (!target) return;
    if (String(query).trim().length < 2) {
      target.innerHTML = empty("Tapez au moins 2 caractères.");
      return;
    }
    target.innerHTML = `<p class="muted">Recherche…</p>`;
    try {
      const out = await api("search?q=" + encodeURIComponent(query) + (company() ? "&company=" + encodeURIComponent(company()) : ""));
      target.innerHTML = `<div class="pro-search-results">${(out.results || []).map((x) => `<button type="button" data-pro-action="search-result" data-type="${esc(x.type)}" data-id="${esc(x.id)}" data-page="${esc(x.page || "")}" data-project="${esc(x.projectId || "")}" data-conversation="${esc(x.conversationKey || "")}"><span><b>${esc(x.title)}</b><small>${esc(x.type)} · ${esc(x.subtitle || "")}</small></span><strong>Ouvrir</strong></button>`).join("") || empty("Aucun résultat.")}</div>`;
    } catch (error) {
      target.innerHTML = `<p class="error">${esc(error.message)}</p>`;
    }
  }

  async function dashboardEnhance() {
    if (core()?.getPage?.() !== "dashboard") return;
    const content = document.getElementById("content");
    if (!content || content.querySelector(".pro-action-dashboard")) return;
    try {
      const out = await loadDashboard();
      const a = out.actions || {};
      content.insertAdjacentHTML("afterbegin", `<section class="pro-action-dashboard card"><div class="pro-card-head"><div><p class="eyebrow">CENTRE D'ACTIONS</p><h3>À traiter maintenant</h3></div>${button("Ouvrir le centre", "open-center", "", "primary")}</div><div class="pro-mini-kpis"><span><b>${esc(a.workingNow || 0)}</b> au travail</span><span class="${a.overdueProjects ? "attention" : ""}"><b>${esc(a.overdueProjects || 0)}</b> chantiers en retard</span><span class="${a.pendingTime ? "attention" : ""}"><b>${esc(a.pendingTime || 0)}</b> heures à valider</span><span class="${a.overdueInvoices ? "attention" : ""}"><b>${esc(a.overdueInvoices || 0)}</b> factures échues</span><span><b>${esc(a.unreadNotifications || 0)}</b> notifications</span></div></section>`);
    } catch {}
  }

  function ensureTopActions() {
    const top = document.querySelector(".top-actions");
    if (!top || top.querySelector("[data-pro-action='search']")) return;
    top.insertAdjacentHTML("afterbegin", `<button class="icon" type="button" data-pro-action="search" aria-label="Recherche globale" title="Recherche globale · Ctrl/⌘ K">⌕</button><button class="icon" type="button" data-pro-action="open-activity" aria-label="Notifications et activité" title="Notifications">🔔</button>`);
  }

  async function afterRender() {
    ensureTopActions();
    await applyWorkspaceConfig().catch(() => {});
    await dashboardEnhance();
  }

  document.addEventListener("click", async (event) => {
    const tab = event.target.closest("[data-pro-tab]");
    if (tab) {
      activeTab = tab.dataset.proTab;
      const shellEl = tab.closest(".pro-suite");
      shellEl.querySelector(".pro-tabs").outerHTML = tabsMarkup();
      host = shellEl.querySelector("#proBody");
      await renderCurrent();
      return;
    }
    const b = event.target.closest("[data-pro-action]");
    if (!b) return;
    const action = b.dataset.proAction;
    try {
      if (action === "search") await showSearch();
      else if (action === "open-center") { core().closeModal?.(true); core().setPage("pro"); }
      else if (action === "open-activity") { activeTab = "activity"; core().setPage("pro"); }
      else if (action === "tab-activity") { activeTab = "activity"; await renderCurrent(); }
      else if (action === "goto-time") core().setPage("time");
      else if (action === "goto-projects") { activeTab = "projects"; if (core().getPage() === "pro") await renderCurrent(); else core().setPage("pro"); }
      else if (action === "goto-absences") core().setPage("absences");
      else if (action === "goto-planning") core().setPage("planning");
      else if (action === "goto-invoices") core().setPage("invoices");
      else if (action === "goto-quotes") core().setPage("quotes");
      else if (action === "goto-inventory") core().setPage("inventory");
      else if (action === "goto-invoice") { core().setPage("invoices"); setTimeout(() => core().documentModal("invoices", b.dataset.id), 0); }
      else if (action === "project-central") await openProject(b.dataset.id || b.dataset.projectId);
      else if (action === "open-conversation") { core().closeModal(true); core().selectConversation(b.dataset.key); }
      else if (action === "open-finance") core().documentModal(b.dataset.kind, b.dataset.id);
      else if (action === "finish-project") {
        if (!confirm("Terminer ce chantier et préparer sa facturation ?")) return;
        await core().mutate("project.finish", { id: b.dataset.id });
        await openProject(b.dataset.id);
      }
      else if (action === "read-all") { await api("notifications/read", { all: true }); await renderActivity(); }
      else if (action === "read-notification") { await api("notifications/read", { id: b.dataset.id }); await renderActivity(); }
      else if (action === "restore-trash") { await api("trash/" + encodeURIComponent(b.dataset.id) + "/restore", {}); await core().refresh(false); await renderTrash(); core().toast("Élément restauré."); }
      else if (action === "purge-trash") {
        if (!confirm("Supprimer définitivement cet élément ? Cette action est irréversible.")) return;
        const r = await core().authFetch("/api/pro/trash/" + encodeURIComponent(b.dataset.id), { method: "DELETE" });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || "Suppression impossible.");
        await core().refresh(false); await renderTrash(); core().toast("Élément supprimé définitivement.");
      }
      else if (action === "permission-user") openPermission(b.dataset.id);
      else if (action === "plan-new") planningBulkForm();
      else if (action === "plan-prev") { planDate = shiftDate(planDate, planMode === "month" ? -28 : planMode === "week" ? -7 : -1); await renderPlanning(); }
      else if (action === "plan-next") { planDate = shiftDate(planDate, planMode === "month" ? 28 : planMode === "week" ? 7 : 1); await renderPlanning(); }
      else if (action === "plan-today") { planDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); await renderPlanning(); }
      else if (action === "search-result") {
        const type = b.dataset.type;
        core().closeModal(true);
        if (type === "project") await openProject(b.dataset.project || b.dataset.id);
        else if (type === "message" && b.dataset.conversation) core().selectConversation(b.dataset.conversation);
        else if (b.dataset.page) core().setPage(b.dataset.page);
      }
    } catch (error) {
      core().notice(error.message);
    }
  });

  document.addEventListener("input", (event) => {
    if (event.target.id === "proProjectFilter") {
      const q = event.target.value.trim().toLowerCase();
      document.querySelectorAll(".pro-project-card").forEach((el) => { el.hidden = q && !String(el.dataset.search || "").includes(q); });
    }
    if (event.target.id === "proGlobalSearchInput") {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch(event.target.value), 180);
    }
  });

  document.addEventListener("change", async (event) => {
    if (event.target.id === "proPlanDate") { planDate = event.target.value || planDate; await renderPlanning(); }
    if (event.target.id === "proPlanMode") { planMode = event.target.value; await renderPlanning(); }
  });

  let draggedShift = "";
  document.addEventListener("dragstart", (event) => {
    const el = event.target.closest("[data-pro-shift]");
    if (!el) return;
    draggedShift = el.dataset.proShift;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedShift);
  });
  document.addEventListener("dragover", (event) => {
    const zone = event.target.closest("[data-pro-drop-date]");
    if (!zone || !draggedShift) return;
    event.preventDefault();
    zone.classList.add("drag-over");
  });
  document.addEventListener("dragleave", (event) => event.target.closest("[data-pro-drop-date]")?.classList.remove("drag-over"));
  document.addEventListener("drop", async (event) => {
    const zone = event.target.closest("[data-pro-drop-date]");
    if (!zone || !draggedShift) return;
    event.preventDefault();
    zone.classList.remove("drag-over");
    const id = draggedShift;
    draggedShift = "";
    try {
      await api("planning/" + encodeURIComponent(id) + "/move", { date: zone.dataset.proDropDate });
      await core().refresh(false);
      await renderPlanning();
      core().toast("Planning déplacé.");
    } catch (error) { core().notice(error.message); }
  });
  document.addEventListener("dragend", () => { draggedShift = ""; document.querySelectorAll(".drag-over").forEach((x) => x.classList.remove("drag-over")); });

  document.addEventListener("submit", async (event) => {
    const form = event.target;
    if (form.id !== "proForm") return;
    event.preventDefault();
    const fd = new FormData(form);
    try {
      if (form.dataset.kind === "planning-bulk") {
        await api("planning/bulk", {
          projectId: fd.get("projectId"),
          employeeIds: fd.getAll("employeeIds"),
          date: fd.get("date"),
          start: fd.get("start"),
          end: fd.get("end"),
          location: fd.get("location"),
          vehicleId: fd.get("vehicleId"),
          toolIds: fd.getAll("toolIds"),
        });
        await core().refresh(false);
        core().closeModal(true);
        await renderPlanning();
        core().toast("Affectation ajoutée au planning.");
      } else if (form.dataset.kind === "permissions") {
        await api("permissions/" + encodeURIComponent(form.dataset.userId), { grants: fd.getAll("grants"), denials: fd.getAll("denials") });
        core().closeModal(true);
        await renderPermissions();
        core().toast("Permissions enregistrées.");
      } else if (form.dataset.kind === "settings") {
        const modules = {};
        for (const key of Object.keys(cache.settings?.modules || {})) modules[key] = fd.get("module:" + key) === "on";
        await api("settings", {
          companyName: fd.get("companyName"), tenantKey: fd.get("tenantKey"), logoUrl: fd.get("logoUrl"), primaryColor: fd.get("primaryColor"), accentColor: fd.get("accentColor"), modules,
          billing: { plan: fd.get("plan"), status: fd.get("billingStatus"), seats: fd.get("seats") },
          whiteLabel: { customDomain: fd.get("customDomain"), supportEmail: fd.get("supportEmail"), vatMode: "configurable" },
        });
        core().toast("Configuration enregistrée.");
        await applyWorkspaceConfig(true);
        await renderSettings();
      }
    } catch (error) {
      const target = form.querySelector("#formError");
      if (target) target.textContent = error.message; else core().notice(error.message);
    }
  });

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      showSearch().catch((error) => core().notice(error.message));
    }
  });

  window.SGOProSuite = { render, afterRender, openProject, showSearch };
  setTimeout(() => afterRender().catch(() => {}), 0);
})();
