"use strict";
// « Démarches » (Chantiers): OIBT controls for électricité, paperwork for solaire; the same panels
// inside the project sheet; their reminders on the home page.
(() => {
  const core = () => window.SGOChatCore;
  const esc = (v) => core().esc(String(v ?? ""));
  const icon = (n) => window.SGOIcon?.(n) || "";
  const day = (d) => (d ? new Date(d + "T12:00:00").toLocaleDateString("fr-CH") : "—");
  const todayIso = () => new Date().toISOString().slice(0, 10);
  let kinds = null,
    tab = "",
    filter = "todo",
    seq = 0,
    todoCache = { at: 0, items: [] };

  async function loadKinds() {
    kinds ||= await core().api("trade/kinds");
    return kinds;
  }
  const companies = () => (core().getState().companies || []).filter((c) => c.id !== "group");
  const tradeOf = (c) => window.SGOTradeKind?.(c) || "";
  const available = () => {
    const p = core().getProfile();
    const mine = (c) => p.company === "group" || p.company === c.id || (p.companies || []).includes(c.id);
    return {
      oibt: companies().some((c) => tradeOf(c) === "electricite" && mine(c)),
      solar: companies().some((c) => tradeOf(c) === "solaire" && mine(c)),
    };
  };
  const tone = { late: "danger", soon: "warning", contacted: "info", ok: "ok", unknown: "neutral" };

  async function render(host) {
    if (!host) return;
    const current = ++seq;
    const av = available();
    if (!tab || !av[tab]) tab = av.oibt ? "oibt" : "solar";
    host.innerHTML = `<div class="trade-tabs" role="tablist">${av.oibt ? `<button type="button" role="tab" class="trade-tab ${tab === "oibt" ? "active" : ""}" data-trade-tab="oibt" aria-selected="${tab === "oibt"}">Contrôles OIBT</button>` : ""}${av.solar ? `<button type="button" role="tab" class="trade-tab ${tab === "solar" ? "active" : ""}" data-trade-tab="solar" aria-selected="${tab === "solar"}">Démarches solaires</button>` : ""}</div><div id="tradeBody"><p class="muted">Chargement…</p></div>`;
    try {
      await loadKinds();
      const body = tab === "oibt" ? await oibtView() : await solarView();
      if (current === seq && document.getElementById("tradeBody")) document.getElementById("tradeBody").innerHTML = body;
    } catch (e) {
      if (current === seq && document.getElementById("tradeBody")) document.getElementById("tradeBody").innerHTML = `<p class="trade-error">${esc(e.message)}</p>`;
    }
  }
  const reload = () => render(document.getElementById("tradeRoot"));

  // ---- OIBT ----
  let oibt = null;
  async function oibtView() {
    oibt = await core().api("trade/oibt");
    const { installations, missingReports, counts, canWrite } = oibt;
    const list = installations.filter((x) => (filter === "todo" ? ["late", "soon", "unknown"].includes(x.state) : filter === "late" ? x.state === "late" : true));
    const chip = (id, label, n) => `<button type="button" class="trade-chip ${filter === id ? "active" : ""}" data-oibt-filter="${id}">${esc(label)}${n != null ? ` <b>${n}</b>` : ""}</button>`;
    const reports = missingReports.length
      ? `<section class="card trade-card"><h3>Rapports de sécurité à enregistrer</h3><p class="muted">Chantiers d’électricité terminés sans rapport de sécurité (RS) enregistré. En l’enregistrant, l’application calcule la date du prochain contrôle.</p><ul class="trade-list">${missingReports
          .map(
            (p) =>
              `<li class="trade-item"><div class="trade-what"><b>${esc(p.title)}</b><span>${esc(p.clientName)}${p.address ? " · " + esc(p.address) : ""}</span>${p.completedAt ? `<small>Terminé le ${day(p.completedAt)}</small>` : ""}</div><div class="trade-actions">${canWrite ? `<button type="button" class="btn primary" data-oibt-report="${esc(p.id)}">Enregistrer le RS</button>` : ""}</div></li>`,
          )
          .join("")}</ul></section>`
      : "";
    const rows = list.length
      ? `<ul class="trade-list">${list.map(installationHtml).join("")}</ul>`
      : `<article class="card empty">${icon("check")}<strong>${filter === "all" ? "Aucune installation suivie pour l’instant." : "Rien à faire pour l’instant."}</strong><span>${filter === "all" ? "Ajoutez les installations de vos clients, ou enregistrez le RS d’un chantier terminé." : "Les clients à appeler apparaîtront ici " + kinds.contactMonths + " mois avant l’échéance."}</span></article>`;
    return `<div class="trade-head"><div><h2>Contrôles périodiques OIBT</h2><p class="muted">Chaque installation doit être contrôlée tous les 1, 3, 5, 10 ou 20 ans selon son type. L’application vous dit qui appeler ${kinds.contactMonths} mois avant l’échéance.</p></div>${canWrite ? '<button type="button" class="btn primary" data-oibt-edit="">Ajouter une installation</button>' : ""}</div>${reports}<div class="trade-filters" role="group" aria-label="Filtrer">${chip("todo", "À faire", counts.late + counts.soon)}${chip("late", "Dépassés", counts.late)}${chip("all", "Toutes", installations.length)}</div>${rows}`;
  }
  function installationHtml(x) {
    const k = kinds.kinds[x.kind]?.label || "";
    const mail = x.email
      ? `mailto:${encodeURIComponent(x.email)}?subject=${encodeURIComponent("Contrôle périodique de votre installation électrique")}&body=${encodeURIComponent(
          `Bonjour,\n\nLe contrôle périodique de votre installation électrique${x.address ? " (" + x.address + ")" : ""} arrive à échéance le ${day(x.due)}. La loi (OIBT) demande un nouveau rapport de sécurité avant cette date.\n\nNous pouvons nous en charger : dites-nous quand vous êtes disponible.\n\nMeilleures salutations`,
        )}`
      : "";
    return `<li class="trade-item trade-${esc(x.state)}"><div class="trade-what"><b>${esc(x.label)}</b><span>${esc(x.clientName || "Client non indiqué")}${x.address ? " · " + esc(x.address) : ""}</span><small>${esc(k)} · tous les ${esc(x.periodYears)} ans · dernier contrôle ${day(x.lastControl)}${x.contactedAt ? " · contacté le " + day(x.contactedAt) : ""}</small></div><div class="trade-due"><span class="status ${tone[x.state]}">${esc(x.stateLabel || labelOf(x))}</span>${x.due ? `<small>Échéance ${day(x.due)}</small>` : ""}</div><div class="trade-actions">${x.phone ? `<a class="btn secondary" href="tel:${esc(x.phone.replace(/[^\d+]/g, ""))}">${icon("phone")} Appeler</a>` : ""}${mail ? `<a class="btn secondary" href="${esc(mail)}">${icon("mail")} E-mail</a>` : ""}${x.address ? `<button type="button" class="btn secondary go-btn" data-action="go-to" data-id="${esc(x.address)}">${icon("go")}<span>Y aller</span></button>` : ""}${oibt.canWrite ? `${["late", "soon"].includes(x.state) ? `<button type="button" class="btn secondary" data-oibt-do="contacted" data-id="${x.id}">Client contacté</button>` : ""}<button type="button" class="btn primary" data-oibt-do="controlled" data-id="${x.id}">Contrôle fait</button><button type="button" class="btn secondary" data-oibt-edit="${x.id}">Modifier</button>` : ""}</div></li>`;
  }
  const labelOf = (x) => ({ late: "Contrôle dépassé", soon: "À contacter", contacted: "Client contacté", ok: "À jour", unknown: "Date inconnue" })[x.state] || "";

  function kindOptions(selected) {
    return Object.entries(kinds.kinds)
      .map(([id, k]) => `<option value="${id}" data-years="${k.years}" ${id === selected ? "selected" : ""}>${esc(k.label)} (${k.years} ans)</option>`)
      .join("");
  }
  const periodOptions = (selected) => kinds.periods.map((y) => `<option value="${y}" ${Number(selected) === y ? "selected" : ""}>${y} ${y > 1 ? "ans" : "an"}</option>`).join("");
  function editInstallation(id) {
    const x = id ? oibt.installations.find((i) => String(i.id) === String(id)) : null;
    const elec = oibt.companies;
    const company = x?.company || (elec.length === 1 ? elec[0].id : "");
    const clients = (core().getState().clients || []).filter((c) => !c.deletedAt && (!company || !c.company || c.company === company));
    core().modal(
      x ? "Modifier l’installation" : "Ajouter une installation",
      `<form id="oibtForm" class="trade-form">${elec.length > 1 ? `<label>Entreprise<select name="company" required>${elec.map((c) => `<option value="${esc(c.id)}" ${c.id === company ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>` : `<input type="hidden" name="company" value="${esc(company)}">`}<label>Client<select name="clientId"><option value="">— Aucun —</option>${clients.map((c) => `<option value="${esc(c.id)}" ${String(c.id) === String(x?.clientId) ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label><label>Nom de l’installation<input name="label" required maxlength="160" value="${esc(x?.label || "")}" placeholder="Ex. Villa Bernard, immeuble Lac 4"></label><label>Adresse<input name="address" maxlength="300" value="${esc(x?.address || "")}" placeholder="Rue, numéro, NPA, localité"></label><label>Type<select name="kind">${kindOptions(x?.kind || "habitation")}</select></label><label>Contrôle tous les<select name="periodYears">${periodOptions(x?.periodYears || 20)}</select></label><label>Date du dernier rapport de sécurité<input type="date" name="lastControl" max="${todayIso()}" value="${esc(x?.lastControl || "")}"></label><label>Remarques<textarea name="notes" maxlength="2000">${esc(x?.notes || "")}</textarea></label><p class="muted">La périodicité figure sur l’avis du gestionnaire de réseau ; en cas de doute, vérifiez-la.</p><div class="trade-form-actions">${x ? `<button type="button" class="btn danger" data-oibt-do="archive" data-id="${x.id}">Retirer du suivi</button>` : ""}<button type="submit" class="btn primary">Enregistrer</button></div>${x ? `<input type="hidden" name="id" value="${x.id}">` : ""}</form>`,
    );
  }
  function reportForm(projectId, title = "") {
    core().modal(
      "Rapport de sécurité (RS)",
      `<form id="oibtReportForm" class="trade-form"><input type="hidden" name="projectId" value="${esc(projectId)}">${title ? `<p><b>${esc(title)}</b></p>` : ""}<label>Date du rapport de sécurité<input type="date" name="date" required max="${todayIso()}" value="${todayIso()}"></label><label>Type d’installation<select name="kind">${kindOptions("habitation")}</select></label><label>Prochain contrôle dans<select name="periodYears">${periodOptions(20)}</select></label><label class="trade-check"><input type="checkbox" name="track" checked> Suivre le prochain contrôle de cette installation</label><label>Remarques<textarea name="notes" maxlength="1000"></textarea></label><div class="trade-form-actions"><button type="submit" class="btn primary">Enregistrer</button></div></form>`,
    );
  }

  // ---- Solaire ----
  async function solarView() {
    const data = await core().api("trade/solar");
    const rows = data.projects.length
      ? `<ul class="trade-list">${data.projects
          .map(
            (p) =>
              `<li class="trade-item ${p.waiting ? "trade-soon" : ""}"><div class="trade-what"><b>${esc(p.title)}</b><span>${esc(p.clientName)}${p.address ? " · " + esc(p.address) : ""}</span><small>${p.next ? "Prochaine étape : " + esc(p.next.label) : "Toutes les démarches sont faites."}</small></div><div class="trade-due"><progress class="trade-progress" max="${p.total || 1}" value="${p.done}" aria-label="${p.done} sur ${p.total} étapes faites"></progress><small>${p.done} / ${p.total} étapes</small>${p.waiting ? `<span class="status warning">${p.waiting} à relancer</span>` : ""}</div><div class="trade-actions"><button type="button" class="btn primary" data-solar-open="${esc(p.id)}">Voir les démarches</button></div></li>`,
          )
          .join("")}</ul>`
      : `<article class="card empty">${icon("check")}<strong>Aucun chantier solaire en cours.</strong><span>Les démarches apparaissent ici dès qu’un chantier est créé pour l’entreprise solaire.</span></article>`;
    return `<div class="trade-head"><div><h2>Démarches des installations solaires</h2><p class="muted">Commune, gestionnaire de réseau, rapport de sécurité, mise en service, Pronovo… Une étape « En cours » depuis plus de 3 semaines est signalée « À relancer ».</p></div></div>${rows}`;
  }
  // The steps panel (project sheet or its own window). Clients see it without changing it.
  async function solarPanel(host, projectId) {
    const data = await core().api("trade/solar/project/" + encodeURIComponent(projectId));
    const { steps, progress, canWrite, states } = data;
    const pill = (s) => (s.waiting ? '<span class="status warning">À relancer</span>' : `<span class="status ${s.status === "Fait" ? "ok" : s.status === "En cours" ? "info" : "neutral"}">${esc(s.status)}</span>`);
    host.innerHTML = `<section class="trade-solar" data-solar-project="${esc(projectId)}"><h4 class="spaced">Démarches solaires <small class="muted">${progress.done} / ${progress.total} faites</small></h4><progress class="trade-progress wide" max="${progress.total || 1}" value="${progress.done}" aria-label="${progress.done} sur ${progress.total} étapes faites"></progress><ol class="trade-steps">${steps
      .map((s) =>
        canWrite
          ? `<li class="trade-step ${s.status === "Fait" ? "done" : ""}" data-step="${esc(s.step)}"><div class="trade-step-name"><b>${esc(s.label)}</b>${pill(s)}</div><div class="trade-step-fields"><label>État<select data-solar-field="status">${states.map((x) => `<option ${x === s.status ? "selected" : ""}>${esc(x)}</option>`).join("")}</select></label><label>Date<input type="date" data-solar-field="date" value="${esc(s.date)}"></label><label class="grow">Remarque<input data-solar-field="note" maxlength="500" value="${esc(s.note)}" placeholder="N° de dossier, contact…"></label></div></li>`
          : `<li class="trade-step ${s.status === "Fait" ? "done" : ""}"><div class="trade-step-name"><span class="trade-tick" aria-hidden="true">${s.status === "Fait" ? icon("check") : ""}</span><b>${esc(s.label)}</b>${s.status === "Non concerné" ? '<span class="muted">non concerné</span>' : pill(s)}${s.date && s.status !== "À faire" ? `<small class="muted">${day(s.date)}</small>` : ""}</div></li>`,
      )
      .join("")}</ol>${canWrite ? `<form class="trade-add-step" data-solar-add="${esc(projectId)}"><input name="label" maxlength="160" placeholder="Ajouter une étape (ex. subvention cantonale)" required><button type="submit" class="btn secondary">Ajouter</button></form>` : ""}</section>`;
  }
  // Saves one step and updates its label and the count in place (the fields stay as they are,
  // so a second change made right after is not lost).
  async function saveStep(row) {
    const section = row.closest("[data-solar-project]");
    const field = (f) => row.querySelector(`[data-solar-field="${f}"]`);
    const status = field("status").value;
    if (status !== "À faire" && !field("date").value) field("date").value = todayIso();
    row.classList.toggle("done", status === "Fait");
    const old = new Date(Date.now() - 21 * 864e5).toISOString().slice(0, 10);
    const waiting = status === "En cours" && field("date").value && field("date").value <= old;
    const pill = row.querySelector(".trade-step-name .status");
    if (pill) {
      pill.className = "status " + (waiting ? "warning" : status === "Fait" ? "ok" : status === "En cours" ? "info" : "neutral");
      pill.textContent = waiting ? "À relancer" : status;
    }
    const rows = [...section.querySelectorAll(".trade-step")].map((r) => r.querySelector('[data-solar-field="status"]')?.value);
    const counted = rows.filter((x) => x !== "Non concerné");
    const done = counted.filter((x) => x === "Fait").length;
    const bar = section.querySelector("progress");
    if (bar) {
      bar.max = counted.length || 1;
      bar.value = done;
    }
    const count = section.querySelector("h4 small");
    if (count) count.textContent = `${done} / ${counted.length} faites`;
    try {
      await core().api("trade/solar/step", { projectId: section.dataset.solarProject, step: row.dataset.step, status, date: field("date").value, note: field("note").value });
      core().toast("Démarche enregistrée.");
    } catch (e) {
      core().toast(e.message);
    }
  }


  // Inside the project sheet: solar steps, the safety report of an electrical job, the review request.
  async function projectModal(p) {
    const host = document.querySelector(`[data-trade-project="${CSS.escape(String(p.id))}"]`);
    if (!host) return;
    const company = companies().find((c) => c.id === p.company);
    const kind = tradeOf(company);
    const role = core().getProfile().role;
    const staff = !["client", "employee"].includes(role);
    host.innerHTML = '<div data-part="trade"></div><div data-part="review"></div>';
    const part = (k) => host.querySelector(`[data-part="${k}"]`);
    try {
      if (kind === "solaire") await solarPanel(part("trade"), p.id);
      else if (kind === "electricite" && ["Terminé", "À facturer"].includes(p.status) && staff) {
        const r = await core().api("trade/oibt/report/" + encodeURIComponent(p.id));
        part("trade").innerHTML = `<section class="trade-report"><h4 class="spaced">Rapport de sécurité (OIBT)</h4>${
          r.report ? `<p>${icon("check")} RS remis le ${day(r.report.deliveredOn)}.${r.report.installationId ? " Le prochain contrôle est suivi dans « Démarches »." : ""}</p>` : `<p class="muted">Aucun rapport de sécurité enregistré pour ce chantier.</p>`
        }${r.canWrite ? `<button type="button" class="btn ${r.report ? "secondary" : "primary"}" data-oibt-report="${esc(p.id)}" data-title="${esc(p.title)}">${r.report ? "Modifier le RS" : "Enregistrer le RS"}</button>` : ""}</section>`;
      }
    } catch (e) {
      part("trade").innerHTML = `<p class="trade-error">${esc(e.message)}</p>`;
    }
    if (staff && p.status === "Terminé") reviewPanel(part("review"), p).catch((e) => (part("review").innerHTML = `<p class="trade-error">${esc(e.message)}</p>`));
  }

  // ---- Avis Google ----
  async function reviewPanel(host, p) {
    const r = await core().api("reviews/project/" + encodeURIComponent(p.id));
    const q = r.request;
    const when = (v) => (v ? new Date(v).toLocaleDateString("fr-CH") : "");
    let status;
    if (q?.status === "Remarque reçue") status = `<p><span class="status warning">Remarque reçue</span> ${when(q.feedbackAt)}</p><blockquote class="review-quote">${esc(q.feedback)}</blockquote>`;
    else if (q?.status === "Avis Google ouvert") status = `<p><span class="status ok">Le client a ouvert la page Google</span> (demande du ${when(q.sentAt)})</p>`;
    else if (q?.status === "Envoyée") status = `<p><span class="status info">Avis demandé par e-mail</span> le ${when(q.sentAt)}</p>`;
    else if (q?.status === "Lien créé") status = `<p><span class="status info">Lien créé</span> le ${when(q.sentAt)} (à envoyer vous-même)</p>`;
    else if (q?.status === "Échec") status = `<p><span class="status danger">Envoi échoué</span> ${esc(q.error)}</p>`;
    else if (!r.configured) status = '<p class="muted">Les demandes d’avis ne sont pas encore réglées (lien de votre fiche Google).</p>';
    else if (r.enabled && r.paidOn) status = `<p class="muted">Demande automatique ${r.delayDays} jour${r.delayDays > 1 ? "s" : ""} après le paiement complet.</p>`;
    else if (r.enabled) status = '<p class="muted">La demande partira automatiquement quand les factures du chantier seront payées.</p>';
    else status = '<p class="muted">Demandes automatiques désactivées : vous pouvez l’envoyer vous-même.</p>';
    const canSend = r.configured && (!q || ["Échec", "Lien créé"].includes(q.status));
    host.innerHTML = `<section class="review-panel"><h4 class="spaced">Avis client</h4>${status}<div class="trade-actions">${canSend && r.clientEmail && r.mailReady ? `<button type="button" class="btn primary" data-review-send="${esc(p.id)}">Demander un avis par e-mail</button>` : ""}${canSend ? `<button type="button" class="btn secondary" data-review-link="${esc(p.id)}">Lien pour WhatsApp / SMS</button>` : ""}<button type="button" class="link-btn" data-review-action="settings">Réglages des avis Google</button></div>${canSend && !r.clientEmail ? '<p class="muted">Le client n’a pas d’adresse e-mail : utilisez le lien.</p>' : ""}${canSend && r.clientEmail && !r.mailReady ? '<p class="muted">L’envoi d’e-mails n’est pas configuré pour cette entreprise : utilisez le lien.</p>' : ""}</section>`;
  }
  async function reviewSettings() {
    core().modal("Avis Google", '<p class="muted">Chargement…</p>');
    let d;
    try {
      d = await core().api("reviews/settings");
    } catch (e) {
      return (document.getElementById("modalBody").textContent = e.message);
    }
    const first = d.companies[0];
    const form = (c) =>
      `<form id="reviewForm" class="trade-form"><label>Entreprise<select name="company" id="reviewCompany">${d.companies.map((x) => `<option value="${esc(x.id)}" ${x.id === c.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label><label>Lien de votre fiche Google<input name="googleUrl" type="url" value="${esc(c.googleUrl)}" placeholder="https://g.page/r/…/review" ${d.canEdit ? "" : "readonly"}></label><p class="muted">Dans Google Maps ou sur votre fiche d’établissement : « Demander des avis » ou « Partager », puis copiez le lien.</p><label>Envoyer la demande<select name="delayDays" ${d.canEdit ? "" : "disabled"}>${[1, 2, 3, 5, 7, 14].map((n) => `<option value="${n}" ${Number(c.delayDays) === n ? "selected" : ""}>${n} jour${n > 1 ? "s" : ""} après le paiement complet</option>`).join("")}</select></label><label class="trade-check"><input type="checkbox" name="enabled" ${c.enabled ? "checked" : ""} ${d.canEdit ? "" : "disabled"}> Demander l’avis automatiquement par e-mail (chantiers terminés et payés à partir d’aujourd’hui)</label>${c.mailReady ? "" : '<p class="trade-error">L’envoi d’e-mails n’est pas configuré pour cette entreprise : seules les demandes par lien (WhatsApp, SMS) sont possibles.</p>'}${d.appUrl ? "" : '<p class="trade-error">L’adresse de l’application (APP_URL) n’est pas indiquée sur le serveur.</p>'}<p class="muted">Chaque client reçoit le même lien vers Google (Google interdit de ne l’envoyer qu’aux clients satisfaits). Sur la même page, il peut aussi vous écrire en privé ou demander à ne plus recevoir ces messages.</p>${d.canEdit ? '<div class="trade-form-actions"><button type="submit" class="btn primary">Enregistrer</button></div>' : ""}</form>`;
    const recent = d.recent.length
      ? `<h4 class="spaced">Dernières demandes</h4><ul class="trade-list">${d.recent
          .map((x) => `<li class="trade-item"><div class="trade-what"><b>${esc(x.title)}</b><small>${esc(x.status)}${x.sentAt ? " · " + new Date(x.sentAt).toLocaleDateString("fr-CH") : ""}</small>${x.feedback ? `<blockquote class="review-quote">${esc(x.feedback)}</blockquote>` : ""}</div></li>`)
          .join("")}</ul>`
      : "";
    document.getElementById("modalBody").innerHTML = `<div id="reviewSettingsBody">${form(first)}</div>${recent}`;
    document.getElementById("reviewSettingsBody").onchange = (e) => {
      if (e.target.id === "reviewCompany") document.getElementById("reviewSettingsBody").innerHTML = form(d.companies.find((x) => x.id === e.target.value));
    };
    reviewSettings.data = d;
  }

  // Home: reminders added to « À faire ».
  async function afterRender() {
    if (core().getPage() !== "dashboard") return;
    const list = document.querySelector(".home-todo");
    if (!list || list.dataset.trade) return;
    const av = available();
    if (!av.oibt && !av.solar) return;
    const role = core().getProfile().role;
    if (["client", "employee"].includes(role)) return;
    list.dataset.trade = "1";
    try {
      if (Date.now() - todoCache.at > 60000) todoCache = { at: Date.now(), items: (await core().api("trade/todo")).items };
    } catch {
      return;
    }
    const box = document.querySelector(".home-todo");
    if (!box || !todoCache.items.length) return;
    let ul = box.querySelector(".home-todo-list");
    if (!ul) {
      box.querySelector(".home-empty")?.remove();
      ul = document.createElement("ul");
      ul.className = "home-todo-list";
      box.appendChild(ul);
    }
    for (const t of todoCache.items)
      ul.insertAdjacentHTML(
        "beforeend",
        `<li><button type="button" class="home-todo-item tone-${esc(t.tone)}" data-shortcut="trade" data-trade-tab="${esc(t.tab)}"><span class="home-todo-icon">${icon("shield")}</span><span class="home-todo-text"><b>${esc(t.text)}</b></span><span class="home-todo-go" aria-hidden="true">›</span></button></li>`,
      );
  }

  // Tabs chosen before the app opens the page (capture phase, ahead of its own handler).
  document.addEventListener(
    "click",
    (e) => {
      const t = e.target.closest?.("[data-trade-tab]");
      if (t) {
        tab = t.dataset.tradeTab;
        if (t.classList.contains("trade-tab")) {
          e.stopPropagation();
          reload();
        }
      }
    },
    true,
  );
  document.addEventListener("click", async (e) => {
    const f = e.target.closest?.("[data-oibt-filter]");
    if (f) {
      filter = f.dataset.oibtFilter;
      return reload();
    }
    const edit = e.target.closest?.("[data-oibt-edit]");
    if (edit) return editInstallation(edit.dataset.oibtEdit);
    const rep = e.target.closest?.("[data-oibt-report]");
    if (rep) return reportForm(rep.dataset.oibtReport, rep.dataset.title || oibt?.missingReports?.find((p) => p.id === rep.dataset.oibtReport)?.title || "");
    const act = e.target.closest?.("[data-oibt-do]");
    if (act) {
      const what = act.dataset.oibtDo;
      if (what === "controlled") {
        core().modal(
          "Contrôle fait",
          `<form id="oibtControlForm" class="trade-form"><input type="hidden" name="id" value="${esc(act.dataset.id)}"><label>Date du nouveau rapport de sécurité<input type="date" name="date" required max="${todayIso()}" value="${todayIso()}"></label><p class="muted">Le prochain contrôle sera calculé à partir de cette date.</p><div class="trade-form-actions"><button type="submit" class="btn primary">Enregistrer</button></div></form>`,
        );
        return;
      }
      if (what === "archive" && !confirm("Retirer cette installation du suivi ?")) return;
      try {
        await core().api("trade/oibt/action", { id: act.dataset.id, what });
        if (what === "archive") core().closeModal(true);
        core().toast(what === "contacted" ? "Noté : client contacté." : "Installation retirée du suivi.");
        todoCache.at = 0;
        reload();
      } catch (err) {
        core().toast(err.message);
      }
      return;
    }
    if (e.target.closest?.('[data-review-action="settings"]')) return reviewSettings();
    const rs = e.target.closest?.("[data-review-send]");
    if (rs) {
      rs.disabled = true;
      try {
        await core().api(`reviews/project/${encodeURIComponent(rs.dataset.reviewSend)}/send`, {});
        core().toast("Demande d’avis envoyée.");
        const p = (core().getState().projects || []).find((x) => String(x.id) === rs.dataset.reviewSend);
        if (p) reviewPanel(rs.closest('[data-part="review"]'), p);
      } catch (err) {
        rs.disabled = false;
        core().toast(err.message);
      }
      return;
    }
    const rl = e.target.closest?.("[data-review-link]");
    if (rl) {
      try {
        const r = await core().api(`reviews/project/${encodeURIComponent(rl.dataset.reviewLink)}/link`, {});
        const msg = `Bonjour${r.name ? " " + r.name : ""}, merci pour votre confiance ! Votre avis compte beaucoup pour nous : ${r.url}`;
        const phone = String(r.phone || "").replace(/[^\d+]/g, "").replace(/^00/, "+").replace(/^0(?=[1-9])/, "+41");
        core().modal(
          "Lien de demande d’avis",
          `<p>Envoyez ce message au client (WhatsApp, SMS…). Le lien mène à la même page que l’e-mail.</p><label>Message<textarea id="reviewMsg" readonly>${esc(msg)}</textarea></label><div class="go-apps"><button type="button" class="btn primary" data-review-copy>Copier le message</button>${phone ? `<a class="btn secondary" target="_blank" rel="noopener" href="https://wa.me/${esc(phone.replace("+", ""))}?text=${encodeURIComponent(msg)}">Ouvrir WhatsApp</a>` : ""}</div>`,
        );
      } catch (err) {
        core().toast(err.message);
      }
      return;
    }
    if (e.target.closest?.("[data-review-copy]")) {
      const t = document.getElementById("reviewMsg");
      t.select();
      await navigator.clipboard?.writeText(t.value).catch(() => document.execCommand?.("copy"));
      return core().toast("Message copié.");
    }
    const sol = e.target.closest?.("[data-solar-open]");
    if (sol) {
      core().modal("Démarches solaires", `<div id="solarModalPanel"><p class="muted">Chargement…</p></div>`);
      try {
        await solarPanel(document.getElementById("solarModalPanel"), sol.dataset.solarOpen);
      } catch (err) {
        document.getElementById("solarModalPanel").textContent = err.message;
      }
    }
  });
  document.addEventListener("change", (e) => {
    const field = e.target.closest?.("[data-solar-field]");
    if (field) saveStep(field.closest(".trade-step"));
    if (e.target.name === "kind" && e.target.closest("#oibtForm, #oibtReportForm")) {
      const years = e.target.selectedOptions[0]?.dataset.years;
      const period = e.target.form.elements.periodYears;
      if (years && period) period.value = years;
    }
    if (e.target.name === "clientId" && e.target.closest("#oibtForm")) {
      const c = (core().getState().clients || []).find((x) => String(x.id) === e.target.value);
      const form = e.target.form;
      if (c && !form.elements.address.value)
        // Where the installation is: the client's first work address, or its billing address.
        form.elements.address.value = window.SGOContacts?.workAddress(c) || [[c.street, c.buildingNumber].filter(Boolean).join(" "), [c.zip, c.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");
      if (c && !form.elements.label.value) form.elements.label.value = c.name;
    }
  });
  document.addEventListener("submit", async (e) => {
    const form = e.target;
    if (form.id === "reviewForm") {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(form));
      try {
        await core().api("reviews/settings", { company: v.company, googleUrl: v.googleUrl, delayDays: Number(v.delayDays), enabled: form.elements.enabled.checked });
        core().toast("Réglages des avis enregistrés.");
        reviewSettings();
      } catch (err) {
        core().toast(err.message);
      }
      return;
    }
    if (!["oibtForm", "oibtReportForm", "oibtControlForm"].includes(form.id) && !form.matches("[data-solar-add]")) return;
    e.preventDefault();
    const v = Object.fromEntries(new FormData(form));
    const button = form.querySelector('[type="submit"]');
    if (button) button.disabled = true;
    try {
      if (form.id === "oibtForm") {
        await core().api("trade/oibt/save", v);
        core().toast("Installation enregistrée.");
      } else if (form.id === "oibtReportForm") {
        await core().api("trade/oibt/report", { ...v, track: form.elements.track.checked });
        core().toast("Rapport de sécurité enregistré.");
      } else if (form.id === "oibtControlForm") {
        await core().api("trade/oibt/action", { id: v.id, what: "controlled", date: v.date });
        core().toast("Contrôle enregistré : prochaine échéance recalculée.");
      } else {
        const projectId = form.dataset.solarAdd;
        await core().api("trade/solar/step", { projectId, label: v.label, status: "À faire" });
        await solarPanel(form.closest("[data-solar-project]").parentElement, projectId);
        return;
      }
      core().closeModal(true);
      todoCache.at = 0;
      if (core().getPage() === "trade") reload();
    } catch (err) {
      core().toast(err.message);
      if (button) button.disabled = false;
    }
  });
  window.SGOTrade = { render, projectModal, afterRender, reviewSettings };
})();
