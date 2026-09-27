"use strict";
(() => {
  let activeTab = "overview",
    loaded = false,
    projectFilter = "",
    searchTimer = null,
    notificationCursor = null,
    notificationRows = [],
    stockCursor = null,
    stockRows = [],
    lifecycleEmployeeId = "",
    lifecyclePhase = "onboarding";

  const core = () => window.SGOChatCore;
  const esc = (v) => core()?.esc?.(v) ?? String(v ?? "");
  const profile = () => core()?.getProfile?.();
  const state = () => core()?.getState?.() || {};
  const money = (n) =>
    new Intl.NumberFormat("fr-CH", {
      style: "currency",
      currency: "CHF",
      minimumFractionDigits: 2,
    }).format(Number(n) || 0);
  const date = (v) =>
    v
      ? new Date(String(v).length === 10 ? v + "T12:00:00" : v).toLocaleDateString("fr-CH")
      : "—";
  const dt = (v) =>
    v
      ? new Date(v).toLocaleString("fr-CH", { timeZone: "Europe/Zurich" })
      : "—";
  const allowedStaff = () =>
    ["admin", "direction", "hr", "manager", "accounting"].includes(profile()?.role);
  const commercial = () =>
    ["admin", "direction", "manager", "accounting"].includes(profile()?.role);
  const operational = () =>
    ["admin", "direction", "manager", "employee"].includes(profile()?.role);
  const hrAllowed = () =>
    ["admin", "direction", "hr"].includes(profile()?.role);

  function root() {
    return document.getElementById("operationsCenter");
  }
  function button(label, action, extra = "", kind = "") {
    return `<button type="button" class="btn ${kind}" data-ops-action="${esc(action)}" ${extra}>${esc(label)}</button>`;
  }
  function tabs() {
    const items = [
      ["overview", "Vue d’ensemble"],
      ["p1", "P1 complet"],
      ["tasks", "Tâches / Kanban"],
      ...(commercial() ? [["crm", "CRM"]] : []),
      ...(operational() ? [["stock", "Stock"], ["workorders", "Bons de travail"]] : []),
      ...(allowedStaff() ? [["analytics", "Analytics"]] : []),
      ...(hrAllowed()
        ? [["payroll", "Paie RH"], ["lifecycle", "Cycle salarié"]]
        : []),
      ...(profile()?.role === "admin" || profile()?.role === "direction"
        ? [["automations", "Automatisations"], ["integrations", "Intégrations"]]
        : []),
      ["notifications", "Notifications"],
    ];
    if (!items.some(([id]) => id === activeTab)) activeTab = "overview";
    return `<div class="ops-tabs">${items
      .map(
        ([id, label]) =>
          `<button type="button" class="${activeTab === id ? "active" : ""}" data-ops-tab="${id}">${esc(label)}</button>`,
      )
      .join("")}</div>`;
  }
  function shell(body = '<article class="card"><p>Chargement…</p></article>') {
    return `
      <section class="ops-center">
        <div class="ops-hero">
          <div>
            <span class="ops-eyebrow">Sousa Group One</span>
            <h2>Pilotage</h2>
            <p>Chantiers, tâches, commercial, stock, interventions, analytics et automatisations.</p>
          </div>
          <div class="ops-search-wrap">
            <input id="opsGlobalSearch" type="search" placeholder="Rechercher client, chantier, salarié, facture, devis, document…" autocomplete="off">
            <div id="opsSearchResults" class="ops-search-results hidden"></div>
          </div>
        </div>
        ${tabs()}
        <div id="opsBody">${body}</div>
      </section>`;
  }
  function kpis(items) {
    return `<div class="ops-kpis">${items
      .map(
        ([label, value, note = ""]) =>
          `<article class="card ops-kpi"><span>${esc(label)}</span><b>${esc(value)}</b>${note ? `<small>${esc(note)}</small>` : ""}</article>`,
      )
      .join("")}</div>`;
  }
  function empty(text) {
    return `<article class="card empty">${esc(text)}</article>`;
  }
  function statusLabel(value) {
    const labels = {
      todo: "À faire",
      in_progress: "En cours",
      blocked: "Bloqué",
      done: "Terminé",
      lead: "Prospect",
      qualified: "Qualifié",
      proposal: "Proposition",
      won: "Gagné",
      lost: "Perdu",
      planned: "Planifié",
      cancelled: "Annulé",
      low: "Basse",
      normal: "Normale",
      high: "Haute",
      urgent: "Urgente",
    };
    return labels[value] || value || "—";
  }
  function severityBadge(level) {
    return `<span class="ops-severity ${esc(level)}">${esc(level === "critical" ? "Critique" : level === "high" ? "Haute" : level === "medium" ? "Moyenne" : "Info")}</span>`;
  }
  function projectOptions(selected = "") {
    return (state().projects || [])
      .map(
        (p) =>
          `<option value="${esc(p.id)}" ${String(p.id) === String(selected) ? "selected" : ""}>${esc(p.title)} · ${esc(p.id)}</option>`,
      )
      .join("");
  }
  function employeeOptions(selected = "", blank = true) {
    return (
      (blank ? '<option value="">Non attribué</option>' : "") +
      (state().employees || [])
        .filter((e) => !e.deletedAt)
        .map(
          (e) =>
            `<option value="${esc(e.id)}" ${String(e.id) === String(selected) ? "selected" : ""}>${esc(e.name)}</option>`,
        )
        .join("")
    );
  }
  function companyOptions(selected = "") {
    return (state().companies || [])
      .filter((c) => c.id !== "group")
      .map(
        (c) =>
          `<option value="${esc(c.id)}" ${String(c.id) === String(selected) ? "selected" : ""}>${esc(c.name)}</option>`,
      )
      .join("");
  }
  async function get(path) {
    return core().api("operations/" + path);
  }
  async function post(path, body) {
    return core().api("operations/" + path, body);
  }
  async function renderOverview() {
    const [overview, insights] = await Promise.all([get("overview"), get("insights")]);
    const crmValue = (overview.crm || []).reduce((n, x) => n + Number(x.value || 0), 0);
    const body = `
      ${kpis([
        ["Tâches ouvertes", overview.tasks.total - overview.tasks.done, overview.tasks.urgent + " urgente(s)"],
        ["En cours", overview.tasks.inProgress, overview.tasks.blocked + " bloquée(s)"],
        ["Notifications", overview.unreadNotifications, "non lues"],
        ["Pipeline CRM", money(crmValue), (overview.crm || []).reduce((n, x) => n + Number(x.count || 0), 0) + " opportunité(s)"],
      ])}
      <div class="ops-grid-2">
        <article class="card">
          <div class="ops-card-head"><div><h3>Alertes intelligentes</h3><p>Points qui méritent une action.</p></div></div>
          <div class="ops-insights">
            ${(insights.insights || []).length
              ? insights.insights
                  .map(
                    (x) => `<button type="button" class="ops-insight" data-ops-go-page="${esc(x.page)}" data-entity-id="${esc(x.entityId)}">
                    ${severityBadge(x.severity)}
                    <span><b>${esc(x.title)}</b><small>${esc(x.body)}</small></span>
                  </button>`,
                  )
                  .join("")
              : '<p class="muted">Aucune alerte importante actuellement.</p>'}
          </div>
        </article>
        <article class="card">
          <div class="ops-card-head"><div><h3>Kanban</h3><p>État global des tâches accessibles.</p></div></div>
          <div class="ops-mini-bars">
            ${[
              ["À faire", overview.tasks.todo],
              ["En cours", overview.tasks.inProgress],
              ["Bloqué", overview.tasks.blocked],
              ["Terminé", overview.tasks.done],
            ]
              .map(
                ([label, value]) =>
                  `<div><span>${esc(label)}</span><b>${esc(value)}</b></div>`,
              )
              .join("")}
          </div>
          <div class="form-actions">${button("Ouvrir le Kanban", "tab", 'data-tab="tasks"', "primary")}</div>
        </article>
      </div>`;
    root().querySelector("#opsBody").innerHTML = body;
  }
  async function renderTasks() {
    const out = await get("tasks" + (projectFilter ? "?projectId=" + encodeURIComponent(projectFilter) : ""));
    const tasks = out.tasks || [];
    const columns = [
      ["todo", "À faire"],
      ["in_progress", "En cours"],
      ["blocked", "Bloqué"],
      ["done", "Terminé"],
    ];
    root().querySelector("#opsBody").innerHTML = `
      <div class="ops-toolbar">
        <label>Chantier<select id="opsTaskProjectFilter"><option value="">Tous les chantiers</option>${projectOptions(projectFilter)}</select></label>
        <div class="form-actions">
          ${projectFilter && operational() ? button("Résumé du jour", "project-summary", "", "") : ""}
          ${operational() ? button("Nouvelle tâche", "new-task", "", "primary") : ""}
        </div>
      </div>
      <div class="ops-kanban">
        ${columns
          .map(
            ([status, label]) => `<section class="ops-kanban-col">
              <div class="ops-kanban-title"><h3>${label}</h3><span>${tasks.filter((x) => x.status === status).length}</span></div>
              <div class="ops-kanban-list">
                ${tasks
                  .filter((x) => x.status === status)
                  .map(
                    (t) => `<article class="card ops-task">
                      <div class="ops-task-top"><span class="ops-priority ${esc(t.priority)}">${esc(statusLabel(t.priority))}</span><small>${esc(t.project_id)}</small></div>
                      <h4>${esc(t.title)}</h4>
                      ${t.description ? `<p>${esc(t.description)}</p>` : ""}
                      <div class="ops-task-meta"><span>📅 ${date(t.due_date)}</span><span>👤 ${esc(t.assigned_employee_id || "—")}</span></div>
                      <div class="ops-task-actions">
                        ${["todo", "in_progress", "blocked", "done"]
                          .filter((x) => x !== status)
                          .map((x) => button(statusLabel(x), "task-status", `data-id="${esc(t.id)}" data-project="${esc(t.project_id)}" data-title="${esc(t.title)}" data-status="${x}" data-priority="${esc(t.priority)}"`))
                          .join("")}
                      </div>
                    </article>`,
                  )
                  .join("") || '<p class="muted">Aucune tâche.</p>'}
              </div>
            </section>`,
          )
          .join("")}
      </div>`;
  }
  async function renderCrm() {
    const out = await get("crm"),
      rows = out.opportunities || [],
      stages = [
        ["lead", "Prospects"],
        ["qualified", "Qualifiés"],
        ["proposal", "Propositions"],
        ["won", "Gagnés"],
        ["lost", "Perdus"],
      ];
    root().querySelector("#opsBody").innerHTML = `
      <div class="ops-toolbar"><div><b>Pipeline commercial</b><span class="muted"> ${rows.length} opportunité(s)</span></div>${button("Nouvelle opportunité", "new-crm", "", "primary")}</div>
      <div class="ops-crm-board">
      ${stages
        .map(
          ([stage, label]) => `<section class="ops-crm-col">
          <div class="ops-kanban-title"><h3>${label}</h3><span>${rows.filter((x) => x.stage === stage).length}</span></div>
          ${rows
            .filter((x) => x.stage === stage)
            .map(
              (x) => `<article class="card ops-crm-card">
                <h4>${esc(x.name)}</h4>
                <b>${money(x.value)}</b>
                <small>${esc(x.probability)} % · ${esc(x.company || "")}</small>
                ${x.next_action ? `<p>➡ ${esc(x.next_action)}</p>` : ""}
                <div class="form-actions">${button("Modifier", "edit-crm", `data-id="${esc(x.id)}"`)}</div>
              </article>`,
            )
            .join("") || '<p class="muted">Aucune opportunité.</p>'}
        </section>`,
        )
        .join("")}
      </div>`;
  }
  async function renderStock(reset = true) {
    if (reset) {
      stockCursor = null;
      stockRows = [];
    }
    const out = await get(
        "inventory/movements?limit=100" +
          (stockCursor ? "&cursor=" + encodeURIComponent(stockCursor) : ""),
      ),
      fresh = out.movements || [];
    stockRows = [...stockRows, ...fresh];
    stockCursor = out.nextCursor || null;
    const movements = stockRows;
    root().querySelector("#opsBody").innerHTML = `
      <div class="ops-toolbar"><div><b>Mouvements de stock</b><span class="muted"> ${movements.length} mouvement(s) chargé(s)</span></div>${operational() ? button("Nouveau mouvement", "new-stock", "", "primary") : ""}</div>
      <article class="card"><div class="table"><table><thead><tr><th>Date</th><th>Article</th><th>Type</th><th>Quantité</th><th>Chantier</th><th>Note</th></tr></thead><tbody>
      ${movements
        .map(
          (x) => `<tr><td>${esc(dt(x.created_at))}</td><td>${esc((state().inventory || []).find((i) => String(i.id) === String(x.inventory_id))?.name || x.inventory_id)}</td><td>${esc(x.movement_type)}</td><td>${esc(x.quantity)}</td><td>${esc(x.project_id || "—")}</td><td>${esc(x.note || "")}</td></tr>`,
        )
        .join("")}
      </tbody></table></div>${stockCursor ? `<div class="form-actions">${button("Charger plus", "stock-more")}</div>` : ""}</article>`;
  }
  async function renderWorkOrders() {
    const out = await get("work-orders"),
      rows = out.workOrders || [];
    root().querySelector("#opsBody").innerHTML = `
      <div class="ops-toolbar"><div><b>Bons de travail</b><span class="muted"> ${rows.length} intervention(s)</span></div>${operational() ? button("Nouveau bon", "new-workorder", "", "primary") : ""}</div>
      <div class="ops-list-cards">
        ${rows.length
          ? rows.map(
              (x) => `<article class="card ops-workorder">
                <div><span class="status neutral">${esc(statusLabel(x.status))}</span><span class="ops-priority ${esc(x.priority)}">${esc(statusLabel(x.priority))}</span></div>
                <h3>${esc(x.title)}</h3>
                <p>${esc(x.description || "")}</p>
                <small>Chantier: ${esc(x.project_id || "—")} · Prévu: ${esc(dt(x.scheduled_at))}</small>
                ${x.customer_signature ? '<strong class="ops-signed">✓ Signé client</strong>' : ""}
                <div class="form-actions">${button("Modifier", "edit-workorder", `data-id="${esc(x.id)}"`)}</div>
              </article>`,
            ).join("")
          : '<article class="card empty">Aucun bon de travail.</article>'}
      </div>`;
  }
  async function renderAnalytics() {
    const out = await get("analytics"),
      k = out.kpis || {};
    root().querySelector("#opsBody").innerHTML = `
      ${kpis([
        ["CA facturé", money(k.invoiceRevenue)],
        ["Encaissé", money(k.collected)],
        ["À encaisser", money(k.outstanding)],
        ["Dépenses", money(k.expenses)],
        ["Heures", (Number(k.hours) || 0).toFixed(1) + " h"],
        ["Chantiers ouverts", k.openProjects || 0],
      ])}
      <div class="ops-grid-2">
        <article class="card"><h3>Rentabilité par entreprise</h3><div class="table"><table><thead><tr><th>Entreprise</th><th>CA</th><th>Encaissé</th><th>Coûts chantier</th><th>Heures</th></tr></thead><tbody>
          ${(out.byCompany || []).map((x) => `<tr><td>${esc(x.name)}</td><td>${money(x.revenue)}</td><td>${money(x.paid)}</td><td>${money(x.projectCost)}</td><td>${Number(x.hours || 0).toFixed(1)} h</td></tr>`).join("")}
        </tbody></table></div></article>
        <article class="card"><h3>Charge équipe à venir</h3><div class="ops-load-list">
          ${(out.teamLoad || []).map((x) => `<div><span>${esc(x.name)}</span><b>${esc(x.hours)} h</b></div>`).join("") || '<p class="muted">Aucune charge future.</p>'}
        </div></article>
      </div>
      <article class="card"><h3>Rentabilité par chantier</h3><div class="table"><table><thead><tr><th>Chantier</th><th>CA</th><th>Coût</th><th>Marge</th><th>Avancement</th></tr></thead><tbody>
        ${(out.byProject || []).map((x) => `<tr><td>${esc(x.title)}</td><td>${money(x.revenue)}</td><td>${money(x.cost)}</td><td>${money(x.margin)}</td><td>${esc(x.progress)} %</td></tr>`).join("")}
      </tbody></table></div></article>`;
  }
  async function renderAutomations() {
    const [rules, hooks] = await Promise.all([get("automations"), get("webhooks")]);
    root().querySelector("#opsBody").innerHTML = `
      <div class="ops-grid-2">
        <article class="card"><div class="ops-card-head"><div><h3>Automatisations</h3><p>Réagir automatiquement aux événements métier.</p></div>${button("Ajouter", "new-automation", "", "primary")}</div>
          <div class="ops-simple-list">${(rules.rules || []).map((x) => `<div><span><b>${esc(x.name)}</b><small>${esc(x.event_type)} · ${x.enabled ? "Actif" : "Inactif"}</small></span></div>`).join("") || '<p class="muted">Aucune règle.</p>'}</div>
        </article>
        <article class="card"><div class="ops-card-head"><div><h3>Webhooks</h3><p>Envoyer les événements vers d’autres systèmes.</p></div>${button("Ajouter", "new-webhook", "", "primary")}</div>
          <div class="ops-simple-list">${(hooks.webhooks || []).map((x) => `<div><span><b>${esc(x.name)}</b><small>${esc(x.url)} · ${x.enabled ? "Actif" : "Inactif"}</small></span>${button("Tester", "test-webhook", `data-id="${esc(x.id)}"`)}</div>`).join("") || '<p class="muted">Aucun webhook.</p>'}</div>
        </article>
      </div>`;
  }
  async function renderIntegrations() {
    const [out, errorOut] = await Promise.all([
        get("integrations"),
        get("errors").catch(() => ({ errors: [] })),
      ]),
      runtime = out.runtime || {},
      integrations = out.integrations || [],
      recentErrors = errorOut.errors || [];
    const rows = [
      ["TURN appels", runtime.turnConfigured],
      ["IA / OCR", runtime.aiConfigured],
      ["Stockage objet", runtime.objectStorageConfigured],
      ["Monitoring erreurs", runtime.errorMonitoringConfigured],
    ];
    root().querySelector("#opsBody").innerHTML = `
      <article class="card">
        <h3>État des services externes</h3>
        <p class="muted">Le code de connexion est prêt. Les services payants ou tiers nécessitent leurs propres identifiants.</p>
        <div class="ops-integration-grid">
          ${rows.map(([name, ok]) => `<div class="${ok ? "connected" : "pending"}"><span>${ok ? "✓" : "!"}</span><b>${esc(name)}</b><small>${ok ? "Connecté" : "À configurer"}</small></div>`).join("")}
        </div>
      </article>
      <article class="card">
        <div class="ops-card-head"><div><h3>Erreurs récentes</h3><p>Journal interne des erreurs serveur 5xx.</p></div><span class="status ${recentErrors.length ? "warning" : "ok"}">${recentErrors.length ? recentErrors.length + " récente(s)" : "Aucune"}</span></div>
        <div class="ops-simple-list">
          ${recentErrors.slice(0, 12).map((x) => `<div><span><b>${esc(x.method + " " + x.path)}</b><small>${esc(dt(x.created_at))} · HTTP ${esc(x.status)} · ${esc(x.message || "")}</small></span></div>`).join("") || '<p class="muted">Aucune erreur enregistrée.</p>'}
        </div>
      </article>
      <article class="card">
        <h3>Connecteurs métier</h3>
        <div class="ops-simple-list">
          ${["bexio", "abacus", "winbiz", "ebill", "banking", "google_calendar", "microsoft_calendar", "email", "sms"]
            .map((provider) => {
              const row = integrations.find((x) => x.provider === provider);
              return `<div><span><b>${esc(provider.replaceAll("_", " "))}</b><small>${row?.enabled ? "Activé" : "Non configuré"}</small></span></div>`;
            })
            .join("")}
        </div>
      </article>`;
  }
  async function renderPayroll(monthValue = "") {
    const currentMonth =
        monthValue ||
        new Intl.DateTimeFormat("en-CA", {
          timeZone: "Europe/Zurich",
          year: "numeric",
          month: "2-digit",
        }).format(new Date()),
      summary = await get(
        "hr/time-summary?month=" + encodeURIComponent(currentMonth),
      ),
      rows = summary.rows || [];
    root().querySelector("#opsBody").innerHTML = `
      <article class="card">
        <div class="ops-card-head">
          <div>
            <h3>Heures & préparation paie</h3>
            <p>Contrôle mensuel des heures validées, heures supplémentaires et horaires spéciaux.</p>
          </div>
        </div>
        <div class="ops-toolbar">
          <label>Mois <input id="opsPayrollMonth" type="month" value="${esc(currentMonth)}"></label>
          ${button("Télécharger le CSV", "payroll-download", "", "primary")}
        </div>
        <div class="table"><table>
          <thead><tr><th>Salarié</th><th>Contrat</th><th>Objectif mois</th><th>Validées</th><th>À valider</th><th>Supplémentaires</th><th>Nuit</th><th>Dimanche</th></tr></thead>
          <tbody>${rows
            .map(
              (x) => `<tr>
                <td>${esc(x.name)}</td>
                <td>${x.weeklyHours ? esc(x.weeklyHours) + " h/sem." : "Non renseigné"}</td>
                <td>${x.targetHours == null ? "—" : esc(Number(x.targetHours).toFixed(2)) + " h"}</td>
                <td>${esc(Number(x.validatedHours || 0).toFixed(2))} h</td>
                <td>${esc(Number(x.pendingHours || 0).toFixed(2))} h</td>
                <td>${x.overtimeHours == null ? "—" : esc(Number(x.overtimeHours).toFixed(2)) + " h"}</td>
                <td>${esc(Number(x.nightHours || 0).toFixed(2))} h</td>
                <td>${esc(Number(x.sundayHours || 0).toFixed(2))} h</td>
              </tr>`,
            )
            .join("") || '<tr><td colspan="8">Aucune donnée.</td></tr>'}</tbody>
        </table></div>
        <p class="muted">Nuit : 23:00–06:00. L’objectif mensuel est calculé depuis les heures hebdomadaires contractuelles × 52 / 12. Les majorations salariales restent à appliquer selon le contrat, la CCT et les règles applicables.</p>
      </article>`;
  }

  async function renderLifecycle() {
    const employees = state().employees || [];
    if (!employees.length) {
      root().querySelector("#opsBody").innerHTML =
        '<article class="card empty">Aucun salarié accessible.</article>';
      return;
    }
    if (
      !lifecycleEmployeeId ||
      !employees.some((e) => String(e.id) === String(lifecycleEmployeeId))
    )
      lifecycleEmployeeId = String(employees[0].id);
    const out = await get(
        "hr/lifecycle?employeeId=" +
          encodeURIComponent(lifecycleEmployeeId) +
          "&phase=" +
          encodeURIComponent(lifecyclePhase),
      ),
      items = out.items || [],
      progress = out.progress || {},
      phaseLabel =
        lifecyclePhase === "onboarding" ? "Onboarding" : "Offboarding";
    root().querySelector("#opsBody").innerHTML = `
      <div class="ops-toolbar">
        <label>Salarié
          <select id="opsLifecycleEmployee">
            ${employees
              .map(
                (e) =>
                  `<option value="${esc(e.id)}" ${String(e.id) === String(lifecycleEmployeeId) ? "selected" : ""}>${esc(e.name)}</option>`,
              )
              .join("")}
          </select>
        </label>
        <label>Phase
          <select id="opsLifecyclePhase">
            <option value="onboarding" ${lifecyclePhase === "onboarding" ? "selected" : ""}>Onboarding</option>
            <option value="offboarding" ${lifecyclePhase === "offboarding" ? "selected" : ""}>Offboarding</option>
          </select>
        </label>
        <div class="form-actions">
          ${items.length ? button("Ajouter une étape", "lifecycle-add") : button("Initialiser " + phaseLabel, "lifecycle-init", "", "primary")}
        </div>
      </div>
      <article class="card">
        <div class="ops-card-head">
          <div>
            <h3>${esc(phaseLabel)} · ${esc(out.employee?.name || "")}</h3>
            <p>${esc(progress.completed || 0)} / ${esc(progress.total || 0)} étape(s) terminée(s)</p>
          </div>
          <span class="status ${progress.ready ? "ok" : "warning"}">${progress.ready ? "Prêt" : esc(progress.percent || 0) + " %"}</span>
        </div>
        <div class="ops-simple-list">
          ${items.length
            ? items
                .map(
                  (item) => `<div class="ops-lifecycle-row">
                    <label>
                      <input type="checkbox" data-lifecycle-toggle="${esc(item.id)}" ${item.completed ? "checked" : ""}>
                      <span><b>${esc(item.label)}</b><small>${item.required ? "Obligatoire" : "Facultatif"}${item.due_date ? " · échéance " + esc(date(item.due_date)) : ""}</small></span>
                    </label>
                    ${button("Supprimer", "lifecycle-delete", `data-id="${esc(item.id)}"`, "danger")}
                  </div>`,
                )
                .join("")
            : '<p class="muted">Aucune checklist initialisée pour cette phase.</p>'}
        </div>
      </article>`;
  }

  function lifecycleForm() {
    modal(
      lifecyclePhase === "onboarding"
        ? "Ajouter une étape d’onboarding"
        : "Ajouter une étape d’offboarding",
      `<form id="opsEntityForm" data-kind="lifecycle">
        <label>Étape<input name="label" required maxlength="300"></label>
        <label>Échéance<input type="date" name="dueDate"></label>
        <label><input type="checkbox" name="required" checked> Étape obligatoire</label>
        <p id="formError" class="error"></p>
        <div class="form-actions"><button class="btn primary" type="submit">Ajouter</button></div>
      </form>`,
    );
  }

  async function renderNotifications(reset = true) {
    if (reset) {
      notificationCursor = null;
      notificationRows = [];
    }
    const out = await get(
        "notifications?limit=50" +
          (notificationCursor
            ? "&cursor=" + encodeURIComponent(notificationCursor)
            : ""),
      ),
      fresh = out.notifications || [];
    notificationRows = [...notificationRows, ...fresh];
    notificationCursor = out.nextCursor || null;
    const rows = notificationRows;
    root().querySelector("#opsBody").innerHTML = `
      <div class="ops-toolbar"><div><b>Centre de notifications</b><span class="muted"> ${rows.length} chargée(s)</span></div>${button("Tout marquer comme lu", "read-all", "", "primary")}</div>
      <div class="ops-notifications">
        ${rows.length
          ? rows.map((x) => `<article class="card ops-notification ${x.read_at ? "" : "unread"}">
              <div><span class="ops-notification-category">${esc(x.category || "activité")}</span><small>${esc(dt(x.created_at))}</small></div>
              <h4>${esc(x.title)}</h4><p>${esc(x.body || "")}</p>
              ${x.url ? button("Ouvrir", "notification-open", `data-id="${esc(x.id)}" data-url="${esc(x.url)}"`) : ""}
            </article>`).join("")
          : '<article class="card empty">Aucune notification.</article>'}
      </div>
      ${notificationCursor ? `<div class="form-actions">${button("Charger plus", "notifications-more")}</div>` : ""}`;
  }
  async function renderTab() {
    if (!root()) return;
    root().querySelector("#opsBody").innerHTML = '<article class="card"><p>Chargement…</p></article>';
    try {
      if (activeTab === "overview") await renderOverview();
      else if (activeTab === "p1") {
        const host = root().querySelector("#opsBody");
        if (window.SGOP1Suite?.render) await window.SGOP1Suite.render(host);
        else host.innerHTML = '<article class="card empty">Module P1 indisponible.</article>';
      }
      else if (activeTab === "tasks") await renderTasks();
      else if (activeTab === "crm") await renderCrm();
      else if (activeTab === "stock") await renderStock();
      else if (activeTab === "workorders") await renderWorkOrders();
      else if (activeTab === "analytics") await renderAnalytics();
      else if (activeTab === "payroll") await renderPayroll();
      else if (activeTab === "lifecycle") await renderLifecycle();
      else if (activeTab === "automations") await renderAutomations();
      else if (activeTab === "integrations") await renderIntegrations();
      else if (activeTab === "notifications") await renderNotifications();
    } catch (e) {
      root().querySelector("#opsBody").innerHTML = `<article class="card empty"><b>Impossible de charger ce module.</b><p>${esc(e.message)}</p></article>`;
    }
  }
  function modal(title, html) {
    core().modal(title, html);
  }
  function taskForm(task = {}) {
    modal(
      task.id ? "Modifier la tâche" : "Nouvelle tâche",
      `<form id="opsEntityForm" data-kind="task" data-id="${esc(task.id || "")}">
        <label>Chantier<select name="projectId" required>${projectOptions(task.project_id || projectFilter)}</select></label>
        <label>Titre<input name="title" required maxlength="200" value="${esc(task.title || "")}"></label>
        <label>Description<textarea name="description" maxlength="3000">${esc(task.description || "")}</textarea></label>
        <label>Statut<select name="status">${["todo","in_progress","blocked","done"].map((x)=>`<option value="${x}" ${task.status===x?"selected":""}>${statusLabel(x)}</option>`).join("")}</select></label>
        <label>Priorité<select name="priority">${["low","normal","high","urgent"].map((x)=>`<option value="${x}" ${task.priority===x?"selected":""}>${statusLabel(x)}</option>`).join("")}</select></label>
        <label>Attribuer à<select name="assignedEmployeeId">${employeeOptions(task.assigned_employee_id)}</select></label>
        <label>Échéance<input type="date" name="dueDate" value="${esc(task.due_date || "")}"></label>
        <p id="formError" class="error"></p><div class="form-actions"><button class="btn primary" type="submit">Enregistrer</button></div>
      </form>`,
    );
  }
  async function crmForm(id = "") {
    const rows = (await get("crm")).opportunities || [],
      x = rows.find((r) => String(r.id) === String(id)) || {};
    modal(
      id ? "Modifier l’opportunité" : "Nouvelle opportunité",
      `<form id="opsEntityForm" data-kind="crm" data-id="${esc(x.id || "")}">
        <label>Entreprise<select name="company" required>${companyOptions(x.company || profile().company)}</select></label>
        <label>Nom<input name="name" required maxlength="250" value="${esc(x.name || "")}"></label>
        <label>Étape<select name="stage">${["lead","qualified","proposal","won","lost"].map((v)=>`<option value="${v}" ${x.stage===v?"selected":""}>${statusLabel(v)}</option>`).join("")}</select></label>
        <label>Valeur CHF<input type="number" min="0" step="0.01" name="value" value="${esc(x.value || 0)}"></label>
        <label>Probabilité %<input type="number" min="0" max="100" name="probability" value="${esc(x.probability || 0)}"></label>
        <label>Prochaine action<input name="nextAction" maxlength="1000" value="${esc(x.next_action || "")}"></label>
        <label>Date prochaine action<input type="datetime-local" name="nextActionAt" value="${x.next_action_at ? esc(new Date(x.next_action_at).toISOString().slice(0,16)) : ""}"></label>
        <label>Source<input name="source" maxlength="200" value="${esc(x.source || "")}"></label>
        <label>Notes<textarea name="notes" maxlength="5000">${esc(x.notes || "")}</textarea></label>
        <p id="formError" class="error"></p><div class="form-actions"><button class="btn primary" type="submit">Enregistrer</button></div>
      </form>`,
    );
  }
  function stockForm() {
    modal(
      "Mouvement de stock",
      `<form id="opsEntityForm" data-kind="stock">
        <label>Article<select name="inventoryId" required>${(state().inventory || []).map((x)=>`<option value="${esc(x.id)}">${esc(x.name)} · ${esc(x.stock)} ${esc(x.unit || "")}</option>`).join("")}</select></label>
        <label>Type<select name="movementType"><option value="in">Entrée</option><option value="out">Sortie</option><option value="adjustment">Ajustement</option><option value="transfer">Transfert</option></select></label>
        <label>Quantité<input type="number" step="0.001" name="quantity" required></label>
        <label>Chantier<select name="projectId"><option value="">Aucun</option>${projectOptions()}</select></label>
        <label>Note<textarea name="note" maxlength="1000"></textarea></label>
        <p id="formError" class="error"></p><div class="form-actions"><button class="btn primary" type="submit">Enregistrer</button></div>
      </form>`,
    );
  }
  async function workOrderForm(id = "") {
    const rows = (await get("work-orders")).workOrders || [],
      x = rows.find((r) => String(r.id) === String(id)) || {};
    modal(
      id ? "Modifier le bon de travail" : "Nouveau bon de travail",
      `<form id="opsEntityForm" data-kind="workorder" data-id="${esc(x.id || "")}">
        <label>Entreprise<select name="company" required>${companyOptions(x.company || profile().company)}</select></label>
        <label>Chantier<select name="projectId"><option value="">Aucun</option>${projectOptions(x.project_id)}</select></label>
        <label>Titre<input name="title" required maxlength="250" value="${esc(x.title || "")}"></label>
        <label>Description<textarea name="description" maxlength="5000">${esc(x.description || "")}</textarea></label>
        <label>Statut<select name="status">${["planned","in_progress","done","cancelled"].map((v)=>`<option value="${v}" ${x.status===v?"selected":""}>${statusLabel(v)}</option>`).join("")}</select></label>
        <label>Priorité<select name="priority">${["low","normal","high","urgent"].map((v)=>`<option value="${v}" ${x.priority===v?"selected":""}>${statusLabel(v)}</option>`).join("")}</select></label>
        <label>Prévu le<input type="datetime-local" name="scheduledAt" value="${x.scheduled_at ? esc(new Date(x.scheduled_at).toISOString().slice(0,16)) : ""}"></label>
        <label>Salarié<select name="assignedEmployeeId">${employeeOptions(x.assigned_employee_id)}</select></label>
        <label>Signature client<input name="customerSignature" maxlength="500" value="${esc(x.customer_signature || "")}" placeholder="Nom du client signataire"></label>
        <p id="formError" class="error"></p><div class="form-actions"><button class="btn primary" type="submit">Enregistrer</button></div>
      </form>`,
    );
  }
  function automationForm() {
    modal(
      "Nouvelle automatisation",
      `<form id="opsEntityForm" data-kind="automation">
        <label>Nom<input name="name" required maxlength="200"></label>
        <label>Entreprise<select name="company"><option value="">Toutes mes entreprises</option>${companyOptions()}</select></label>
        <label>Événement<select name="eventType"><option value="task.created">Tâche créée</option><option value="task.updated">Tâche modifiée</option><option value="crm.won">Opportunité gagnée</option><option value="project.daily_report">Rapport journalier</option><option value="project.change_order.approved">Plus-value approuvée</option></select></label>
        <label>Action<select name="actionType"><option value="notify">Créer une notification</option><option value="create_task">Créer une tâche chantier</option></select></label>
        <label>Titre de l’action<input name="actionTitle" maxlength="200"></label>
        <label>Priorité tâche<select name="priority"><option value="normal">Normale</option><option value="high">Haute</option><option value="urgent">Urgente</option></select></label>
        <p id="formError" class="error"></p><div class="form-actions"><button class="btn primary" type="submit">Créer</button></div>
      </form>`,
    );
  }
  function webhookForm() {
    modal(
      "Nouveau webhook",
      `<form id="opsEntityForm" data-kind="webhook">
        <label>Nom<input name="name" required maxlength="200"></label>
        <label>Entreprise<select name="company"><option value="">Toutes</option>${companyOptions()}</select></label>
        <label>URL HTTPS<input type="url" name="url" required placeholder="https://..."></label>
        <label>Événements<input name="eventTypes" value="*" placeholder="*,task.created,crm.won"></label>
        <p class="muted">Un secret de signature sera généré automatiquement.</p>
        <p id="formError" class="error"></p><div class="form-actions"><button class="btn primary" type="submit">Créer</button></div>
      </form>`,
    );
  }
  async function handleSubmit(form) {
    const data = new FormData(form),
      p = Object.fromEntries(data.entries()),
      kind = form.dataset.kind,
      id = form.dataset.id || "";
    try {
      if (kind === "task") {
        if (id) p.id = id;
        await post("tasks", p);
      } else if (kind === "crm") {
        if (id) p.id = id;
        p.value = Number(p.value || 0);
        p.probability = Number(p.probability || 0);
        await post("crm", p);
      } else if (kind === "stock") {
        p.quantity = Number(p.quantity);
        await post("inventory/movement", p);
      } else if (kind === "workorder") {
        if (id) p.id = id;
        await post("work-orders", p);
      } else if (kind === "lifecycle") {
        await post("hr/lifecycle/add", {
          employeeId: lifecycleEmployeeId,
          phase: lifecyclePhase,
          label: p.label,
          dueDate: p.dueDate || "",
          required: data.get("required") === "on",
        });
      } else if (kind === "automation") {
        const action =
          p.actionType === "create_task"
            ? { type: "create_task", title: p.actionTitle || p.name, priority: p.priority }
            : { type: "notify", title: p.actionTitle || p.name, category: "automation" };
        await post("automations", {
          name: p.name,
          company: p.company || null,
          eventType: p.eventType,
          conditions: {},
          actions: [action],
          enabled: true,
        });
      } else if (kind === "webhook") {
        const out = await post("webhooks", {
          name: p.name,
          company: p.company || null,
          url: p.url,
          eventTypes: String(p.eventTypes || "*").split(",").map((x) => x.trim()).filter(Boolean),
          enabled: true,
        });
        if (out.secret) core().notice("Webhook créé. Secret à conserver: " + out.secret);
      }
      core().closeModal(true);
      core().toast("Enregistré.");
      await renderTab();
    } catch (e) {
      const err = document.getElementById("formError");
      if (err) err.textContent = e.message;
      else core().notice(e.message);
    }
  }
  async function search(q) {
    const box = document.getElementById("opsSearchResults");
    if (!box) return;
    if (q.trim().length < 2) {
      box.classList.add("hidden");
      box.innerHTML = "";
      return;
    }
    try {
      const out = await get("search?q=" + encodeURIComponent(q.trim()));
      box.innerHTML =
        (out.results || [])
          .map(
            (x) => `<button type="button" data-ops-search-page="${esc(x.page)}" data-id="${esc(x.id)}"><b>${esc(x.title)}</b><span>${esc(x.type)} · ${esc(x.subtitle || "")}</span></button>`,
          )
          .join("") || '<p>Aucun résultat.</p>';
      box.classList.remove("hidden");
    } catch (e) {
      box.innerHTML = `<p>${esc(e.message)}</p>`;
      box.classList.remove("hidden");
    }
  }
  async function afterRender() {
    if (core()?.getPage?.() !== "pilotage" || !root()) return;
    root().innerHTML = shell();
    loaded = true;
    await renderTab();
  }

  document.addEventListener("click", async (event) => {
    const tab = event.target.closest("[data-ops-tab]");
    if (tab && core()?.getPage?.() === "pilotage") {
      activeTab = tab.dataset.opsTab;
      root().innerHTML = shell();
      await renderTab();
      return;
    }
    const b = event.target.closest("[data-ops-action]");
    if (!b) {
      const go = event.target.closest("[data-ops-go-page],[data-ops-search-page]");
      if (go) core().setPage(go.dataset.opsGoPage || go.dataset.opsSearchPage);
      return;
    }
    const a = b.dataset.opsAction;
    try {
      if (a === "tab") {
        activeTab = b.dataset.tab;
        root().innerHTML = shell();
        await renderTab();
      } else if (a === "project-summary") {
        if (!projectFilter) throw new Error("Choisissez un chantier.");
        const out = await get(
          "project/" + encodeURIComponent(projectFilter) + "/summary",
        );
        const m = out.metrics || {};
        modal(
          "Résumé automatique · " + (out.project?.title || projectFilter),
          `<section class="ops-summary">
            <div class="ops-kpis">
              <article class="card ops-kpi"><span>Heures</span><b>${esc(Number(m.hours || 0).toFixed(2))} h</b></article>
              <article class="card ops-kpi"><span>Équipe active</span><b>${esc(m.activeTeam || 0)}</b></article>
              <article class="card ops-kpi"><span>Tâches ouvertes</span><b>${esc(m.taskOpen || 0)}</b></article>
              <article class="card ops-kpi"><span>Réserves</span><b>${esc(m.openPunch || 0)}</b></article>
            </div>
            <article class="card">
              <h3>${esc(out.date || "")}</h3>
              <p><b>${esc(out.project?.status || "—")}</b> · Avancement ${esc(out.project?.progress || 0)} %</p>
              <h4>Résumé</h4>
              <pre class="ops-summary-text">${esc(out.summary || "")}</pre>
            </article>
            <div class="ops-grid-2">
              <article class="card">
                <h4>Points positifs</h4>
                <ul>${(out.highlights || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>Aucune activité enregistrée pour cette journée.</li>"}</ul>
              </article>
              <article class="card">
                <h4>Points à surveiller</h4>
                <ul>${(out.risks || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>Aucun point critique détecté.</li>"}</ul>
              </article>
            </div>
          </section>`,
        );
      } else if (a === "new-task") taskForm();
      else if (a === "task-status") {
        await post("tasks", {
          id: b.dataset.id,
          projectId: b.dataset.project,
          title: b.dataset.title,
          status: b.dataset.status,
          priority: b.dataset.priority || "normal",
        });
        await renderTasks();
      } else if (a === "new-crm") await crmForm();
      else if (a === "edit-crm") await crmForm(b.dataset.id);
      else if (a === "new-stock") stockForm();
      else if (a === "new-workorder") await workOrderForm();
      else if (a === "edit-workorder") await workOrderForm(b.dataset.id);
      else if (a === "new-automation") automationForm();
      else if (a === "new-webhook") webhookForm();
      else if (a === "test-webhook") {
        await post("webhooks/test", { id: b.dataset.id });
        core().toast("Webhook testé.");
      } else if (a === "lifecycle-init") {
        await post("hr/lifecycle/init", {
          employeeId: lifecycleEmployeeId,
          phase: lifecyclePhase,
        });
        core().toast("Checklist RH initialisée.");
        await renderLifecycle();
      } else if (a === "lifecycle-add") {
        lifecycleForm();
      } else if (a === "lifecycle-delete") {
        if (!confirm("Supprimer cette étape RH ?")) return;
        await post("hr/lifecycle/delete", { id: b.dataset.id });
        core().toast("Étape supprimée.");
        await renderLifecycle();
      } else if (a === "payroll-download") {
        const month = document.getElementById("opsPayrollMonth")?.value || "";
        if (!month) throw new Error("Choisissez un mois.");
        const response = await core().authFetch(
          "/api/operations/payroll-export?month=" + encodeURIComponent(month),
        );
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || "Export impossible.");
        }
        const blob = await response.blob(),
          url = URL.createObjectURL(blob),
          link = document.createElement("a");
        link.href = url;
        link.download = "sousa-payroll-" + month + ".csv";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        core().toast("Export paie téléchargé.");
      } else if (a === "stock-more") {
        await renderStock(false);
      } else if (a === "notifications-more") {
        await renderNotifications(false);
      } else if (a === "read-all") {
        await post("notifications/read", { all: true });
        await renderNotifications();
      } else if (a === "notification-open") {
        await post("notifications/read", { ids: [b.dataset.id] }).catch(() => {});
        const target = new URL(b.dataset.url, location.origin);
        const p = target.searchParams.get("open");
        if (p) core().setPage(p);
      }
    } catch (e) {
      core().notice(e.message);
    }
  });
  document.addEventListener("change", async (event) => {
    if (event.target.id === "opsTaskProjectFilter") {
      projectFilter = event.target.value;
      await renderTasks();
    }
    if (event.target.id === "opsPayrollMonth") {
      await renderPayroll(event.target.value);
    }
    if (event.target.id === "opsLifecycleEmployee") {
      lifecycleEmployeeId = event.target.value;
      await renderLifecycle();
    }
    if (event.target.id === "opsLifecyclePhase") {
      lifecyclePhase = event.target.value;
      await renderLifecycle();
    }
    if (event.target.matches("[data-lifecycle-toggle]")) {
      await post("hr/lifecycle/item", {
        id: event.target.dataset.lifecycleToggle,
        completed: event.target.checked,
      });
      await renderLifecycle();
    }
  });
  document.addEventListener("input", (event) => {
    if (event.target.id !== "opsGlobalSearch") return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => search(event.target.value), 220);
  });
  document.addEventListener("submit", async (event) => {
    if (event.target.id !== "opsEntityForm") return;
    event.preventDefault();
    await handleSubmit(event.target);
  });

  window.SGOOperationsCenter = {
    afterRender,
    openProject(projectId) {
      projectFilter = String(projectId || "");
      activeTab = "tasks";
      core().setPage("pilotage");
    },
  };
})();
