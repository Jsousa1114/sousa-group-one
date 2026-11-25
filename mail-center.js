"use strict";
// E-mails from the application:
// - "Envoyer au client" on an issued quote or invoice (template texts, extra attachments,
//   preview), with the sendings and the client's replies shown on the document;
// - "E-mails et relances": sending addresses, settings of each company (automatic sendings,
//   texts, signature, hidden copy), overdue invoices, replies received, recent e-mails;
// - client portal invitations (Clients page);
// - "Mot de passe oublié" and choosing a password from a link (login screen).
(() => {
  const core = () => window.SGOChatCore;
  const esc = (value) =>
    core()?.esc?.(value) ?? String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const profile = () => core()?.getProfile?.() || {};
  const state = () => core()?.getState?.() || {};
  const ic = (name) => window.SGOIcon?.(name) || "";
  const isFinance = () => ["admin", "direction", "accounting"].includes(profile().role);
  const canEditSettings = () => ["admin", "direction", "accounting"].includes(profile().role);
  const canInvite = () => ["admin", "direction"].includes(profile().role);
  const swissDate = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(iso || "") ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : iso || "");
  const money = (n) => "CHF " + (Number(n) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  const dateTime = (value) =>
    value ? new Date(value).toLocaleString("fr-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

  let status = null,
    statusRequest = null;
  function loadStatus(force = false) {
    if (!profile()?.id || profile().role === "client") return Promise.resolve(null);
    if (status && !force) return Promise.resolve(status);
    if (!statusRequest)
      statusRequest = core()
        .api("mail/status")
        .then((s) => (status = s))
        .catch(() => null)
        .finally(() => (statusRequest = null));
    return statusRequest;
  }
  // The Gmail address a company sends from (its own account, or the default one).
  const addressFor = (company) => (status?.companies || []).find((c) => String(c.id) === String(company))?.address || "";

  const KIND_LABELS = {
    invoice: "Facture envoyée",
    quote: "Devis envoyé",
    "invoice-auto": "Facture envoyée à l’émission",
    "quote-auto": "Devis envoyé à l’émission",
    test: "Test d’envoi",
    "reminder-1": "1er rappel",
    "reminder-2": "2e rappel",
    "reminder-3": "Dernier rappel",
    "reminder-7": "Rappel (J+7)",
    "reminder-14": "2e rappel (J+14)",
    "reminder-30": "Dernier rappel (J+30)",
    "quote-followup": "Relance de devis",
    appointment: "Confirmation de RDV",
    "appointment-reminder": "Rappel de RDV",
    invite: "Invitation espace client",
    "password-reset": "Mot de passe oublié",
    "message-invoice_reminder": "Relance rédigée",
    "message-quote_followup": "Suivi de devis",
    "message-project_update": "Avancement chantier",
  };
  const STATUS_LABELS = { sent: "Envoyé", failed: "Échec", skipped: "Non envoyé" };
  function logRows(emails, withDocument = true) {
    if (!emails.length) return '<p class="muted">Aucun e-mail envoyé pour l’instant.</p>';
    return `<div class="table"><table><thead><tr><th>Date</th><th>Envoi</th>${withDocument ? "<th>Document</th>" : ""}<th>Destinataire</th><th>Résultat</th></tr></thead><tbody>${emails
      .map(
        (e) =>
          `<tr><td>${esc(dateTime(e.created_at))}</td><td>${esc(KIND_LABELS[e.kind] || e.kind)}</td>${withDocument ? `<td>${esc(e.entity_type === "appointments" ? "Rendez-vous" : e.entity_id || "—")}</td>` : ""}<td>${esc(e.recipient || "—")}</td><td><span class="status ${e.status === "sent" ? "neutral" : ""}">${esc(STATUS_LABELS[e.status] || e.status)}</span>${e.error ? `<br><small>${esc(e.error)}</small>` : ""}</td></tr>`,
      )
      .join("")}</tbody></table></div>`;
  }
  function replyRows(replies) {
    if (!replies.length) return '<p class="muted">Aucune réponse reçue pour l’instant.</p>';
    return `<div class="mail-replies">${replies
      .map(
        (r) => `<details class="mail-reply${r.read_at ? "" : " unread"}" data-reply="${esc(r.id)}">
          <summary><b>${esc(r.from_name || r.from_address)}</b>${r.client && r.client !== r.from_name ? ` <span class="muted">· ${esc(r.client)}</span>` : ""}<span class="mail-reply-meta">${esc(r.subject || "(sans objet)")}${r.entity_id ? ` · ${esc(r.entity_type === "appointments" ? "rendez-vous" : r.entity_id)}` : ""} · ${esc(dateTime(r.received_at))}</span></summary>
          <div class="mail-reply-body">${esc(r.body || "").replace(/\n/g, "<br>")}${(r.attachments || []).length ? `<p class="muted">Pièces jointes : ${(r.attachments || []).map((a) => esc(a.name)).join(", ")} (à ouvrir dans Gmail)</p>` : ""}<p><a href="mailto:${esc(r.from_address)}?subject=${encodeURIComponent("Re: " + (r.subject || ""))}">Répondre depuis ma messagerie</a></p></div>
        </details>`,
      )
      .join("")}</div>`;
  }

  // ----- Sending an issued quote or invoice -----
  const fileToBase64 = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = () => reject(new Error("Lecture du fichier impossible."));
      reader.readAsDataURL(file);
    });
  async function openSendForm(kind, id) {
    const doc = (state()[kind] || []).find((x) => String(x.id) === String(id));
    if (!doc) return;
    core().modal(`Envoyer ${kind === "quotes" ? "le devis" : "la facture"} ${doc.id}`, '<p class="muted">Préparation…</p>');
    let draft;
    try {
      draft = await core().api(`mail/draft/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`);
    } catch (error) {
      document.getElementById("modalBody").innerHTML = `<p class="error">${esc(error.message || "Préparation impossible.")}</p>`;
      return;
    }
    const unpaid = kind === "invoices" && doc.status !== "Payée";
    const company = (state().companies || []).find((c) => String(c.id) === String(doc.company));
    document.getElementById("modalBody").innerHTML = `<form id="mailSendForm" class="mail-form" data-kind="${esc(kind)}" data-id="${esc(doc.id)}" data-company="${esc(doc.company)}">
        <p class="muted">Envoyé depuis <b>${esc(draft.from)}</b>, mis en page avec le logo de ${esc(company?.name || "l’entreprise")}${draft.bcc ? `, copie cachée à ${esc(draft.bcc)}` : ""}. Le PDF est joint${unpaid ? " avec le bulletin QR" : ""}.</p>
        <label>Destinataire<input name="to" type="email" required value="${esc(draft.to)}" placeholder="adresse@client.ch"></label>
        <label>Objet<input name="subject" maxlength="200" required value="${esc(draft.subject)}"></label>
        <label>Message<textarea name="text" rows="8" maxlength="8000">${esc(draft.body)}</textarea></label>
        <p class="muted mail-closing">Ajouté automatiquement : « Meilleures salutations, ${esc(profile().name || "")}, ${esc(company?.name || "")} » et les coordonnées de l’entreprise${draft.portal ? ", avec un bouton vers l’espace client" : ""}.</p>
        ${unpaid ? '<label class="mail-check"><input type="checkbox" name="qr" checked> Joindre le bulletin de versement QR</label>' : ""}
        <fieldset class="mail-attachments"><legend>Autres pièces jointes</legend>
          ${(draft.documents || []).length ? draft.documents.map((d) => `<label class="mail-check"><input type="checkbox" name="documentIds" value="${esc(d.id)}"> ${esc(d.name)}${d.category ? ` <small class="muted">(${esc(d.category)})</small>` : ""}</label>`).join("") : '<p class="muted">Aucun document du client ou du chantier dans l’application.</p>'}
          <label>Ajouter des fichiers (5 Mo au total)<input type="file" name="uploads" multiple></label>
        </fieldset>
        <p id="mailSendError" class="error" role="alert"></p>
        <div class="form-actions"><button type="button" class="btn secondary" data-mail-preview-form>Aperçu</button><button type="submit" class="btn primary">${ic("send")}<span>Envoyer</span></button></div>
      </form>`;
  }
  function previewUrl(company, template, subject, body, signature = null) {
    const q = new URLSearchParams({ company, template });
    if (subject) q.set("subject", subject);
    if (body) q.set("body", body);
    if (signature) for (const [k, v] of Object.entries(signature)) q.set(k, v);
    return "/api/mail/preview?" + q.toString();
  }
  function showPreview(src) {
    const existing = document.getElementById("mailPreviewFrame");
    const html = `<div class="mail-preview" id="mailPreviewBox"><div class="mail-preview-head"><b>Aperçu de l’e-mail</b><button type="button" class="btn secondary" data-mail-preview-close>Fermer l’aperçu</button></div><iframe id="mailPreviewFrame" title="Aperçu de l’e-mail" src="${esc(src)}" sandbox></iframe></div>`;
    if (existing) existing.src = src;
    else document.getElementById("modalBody").insertAdjacentHTML("beforeend", html);
    document.getElementById("mailPreviewBox")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function enhanceDocumentModal() {
    const draftButton = document?.querySelector?.('#modalBody [data-action="finance-email"][data-id]');
    if (!draftButton || draftButton.dataset.mailEnhanced) return;
    draftButton.dataset.mailEnhanced = "1";
    if (!isFinance()) return;
    await loadStatus();
    const [kind, id] = draftButton.dataset.id.split(":");
    const doc = (state()[kind] || []).find((x) => String(x.id) === String(id));
    // Only when this company has a Gmail account; otherwise the .eml draft stays available.
    if (!doc || !addressFor(doc.company) || !draftButton.isConnected) return;
    draftButton.insertAdjacentHTML("beforebegin", `<button type="button" class="btn primary mail-send" data-mail-send="${esc(kind + ":" + id)}">${ic("mail")}<span>Envoyer au client</span></button> `);
    const anchor = draftButton.parentElement;
    draftButton.remove();
    try {
      const [out, inbox] = await Promise.all([
        core().api(`mail/log?entityType=${encodeURIComponent(kind)}&entityId=${encodeURIComponent(id)}&limit=10`),
        core().api(`mail/inbox?entityType=${encodeURIComponent(kind)}&entityId=${encodeURIComponent(id)}&limit=10`),
      ]);
      const sent = (out.emails || []).filter((e) => e.status === "sent");
      if (!anchor?.isConnected) return;
      let html = "";
      if (sent.length)
        html += `<p class="mail-history muted">${ic("check")}<span>Dernier envoi : ${esc(KIND_LABELS[sent[0].kind] || "e-mail")} le ${esc(dateTime(sent[0].created_at))} à ${esc(sent[0].recipient)}${sent.length > 1 ? ` · ${sent.length} envois` : ""}</span></p>`;
      if ((inbox.replies || []).length) html += `<section class="mail-doc-replies"><h4>Réponses du client</h4>${replyRows(inbox.replies)}</section>`;
      if (html) anchor.insertAdjacentHTML("afterend", html);
    } catch {
      // The history is a convenience.
    }
  }

  // ----- Settings of one company -----
  const AUTOMATION_TEXT = {
    invoiceReminders: ["Rappels des factures impayées", "Rappel au client après l’échéance, avec la facture et le bulletin QR."],
    quoteFollowup: ["Relance des devis sans réponse", "Un rappel poli, une seule fois, avec le devis joint."],
    appointments: ["Confirmation des rendez-vous", "Dès qu’une intervention est planifiée sur un chantier, le client reçoit la date, l’heure et l’adresse."],
    autoSendInvoices: ["Envoyer les factures à l’émission", "La facture part au client dès que vous cliquez sur « Émettre »."],
    autoSendQuotes: ["Envoyer les devis à l’émission", "Le devis part au client dès que vous cliquez sur « Émettre »."],
  };
  let editing = null;
  async function openSettings(companyId) {
    core().modal("Réglages des e-mails", '<p class="muted">Chargement…</p>');
    let out;
    try {
      out = await core().api("mail/settings/" + encodeURIComponent(companyId));
    } catch (error) {
      document.getElementById("modalBody").innerHTML = `<p class="error">${esc(error.message)}</p>`;
      return;
    }
    const s = out.settings;
    editing = { company: out.company, templates: JSON.parse(JSON.stringify(s.templates)), defaults: out.templates, current: "invoice" };
    const disabled = out.canEdit ? "" : "disabled";
    const a = s.automations;
    const toggle = (key, extra = "") =>
      `<div class="mail-auto"><label class="mail-check"><input type="checkbox" name="auto:${key}" ${a[key].enabled ? "checked" : ""} ${disabled}> <b>${esc(AUTOMATION_TEXT[key][0])}</b>${a[key].enabled && a[key].enabledAt ? ` <small class="muted">(depuis le ${esc(swissDate(a[key].enabledAt))})</small>` : ""}</label><small class="muted">${esc(AUTOMATION_TEXT[key][1])}</small>${extra}</div>`;
    document.getElementById("modalBody").innerHTML = `<form id="mailSettingsForm" class="mail-settings" data-company="${esc(out.company.id)}">
      <h3>${esc(out.company.name)}</h3>
      <section class="card"><h4>Envois automatiques</h4>
        <p class="muted">Chacun ne concerne que ce qui arrive après son activation : rien n’est envoyé en rafale pour le passé. Envois en semaine entre 8 h et 18 h (rappels de rendez-vous : aussi le week-end).</p>
        ${toggle("invoiceReminders", `<div class="mail-inline">Après l’échéance, à <input name="stage1" type="number" min="1" max="365" value="${s.reminderStages[0]}" ${disabled} aria-label="Premier rappel (jours)"> , <input name="stage2" type="number" min="1" max="365" value="${s.reminderStages[1]}" ${disabled} aria-label="Deuxième rappel (jours)"> et <input name="stage3" type="number" min="1" max="365" value="${s.reminderStages[2]}" ${disabled} aria-label="Dernier rappel (jours)"> jours</div>`)}
        ${toggle("quoteFollowup", `<div class="mail-inline">Relance <input name="quoteDays" type="number" min="1" max="90" value="${a.quoteFollowup.days}" ${disabled} aria-label="Jours avant la relance"> jours après l’envoi</div>`)}
        ${toggle("appointments", `<label class="mail-check"><input type="checkbox" name="dayBefore" ${a.appointments.dayBefore ? "checked" : ""} ${disabled}> Rappel au client la veille</label>`)}
        ${toggle("autoSendInvoices")}
        ${toggle("autoSendQuotes")}
      </section>
      <section class="card"><h4>Signature et copie</h4>
        <p class="muted">Le nom, l’adresse et l’e-mail de facturation${out.company.billingEmail ? ` (${esc(out.company.billingEmail)})` : ""} viennent des réglages de facturation de l’entreprise.</p>
        <div class="form-grid">
          <label>Téléphone<input name="phone" maxlength="40" value="${esc(s.signature.phone)}" ${disabled}></label>
          <label>Site internet<input name="website" maxlength="120" value="${esc(s.signature.website)}" ${disabled}></label>
          <label class="span-2">Ligne libre<input name="extra" maxlength="300" value="${esc(s.signature.extra)}" placeholder="Ex. Membre de l’USIE · Horaires 7h30–17h" ${disabled}></label>
          <label class="span-2">Copie cachée de chaque e-mail à<input name="bcc" type="email" value="${esc(s.bcc)}" placeholder="Laisser vide pour ne pas en recevoir" ${disabled}></label>
        </div>
      </section>
      <section class="card"><h4>Textes des e-mails</h4>
        <label>E-mail<select name="template">${Object.entries(out.templates).map(([k, t]) => `<option value="${esc(k)}">${esc(t.label)}${s.templates[k].custom ? " (modifié)" : ""}</option>`).join("")}</select></label>
        <label>Objet<input name="tSubject" maxlength="200" ${disabled}></label>
        <label>Texte<textarea name="tBody" rows="9" maxlength="6000" ${disabled}></textarea></label>
        <p class="muted">« Meilleures salutations », le nom de l’entreprise et sa signature sont ajoutés à la fin. Champs disponibles (cliquez pour insérer) :</p>
        <div class="mail-fields">${Object.entries(out.fields).map(([k, label]) => `<button type="button" class="ai-chip" data-mail-field="${esc(k)}" title="${esc(label)}" ${disabled}>{${esc(k)}}</button>`).join("")}</div>
        <div class="form-actions"><button type="button" class="btn secondary" data-mail-reset-template ${disabled}>Rétablir le texte d’origine</button><button type="button" class="btn secondary" data-mail-preview-settings>Aperçu</button></div>
      </section>
      <p id="mailSettingsError" class="error" role="alert"></p>
      ${out.canEdit ? '<div class="form-actions"><button type="submit" class="btn primary">Enregistrer les réglages</button></div>' : '<p class="muted">Seules la direction, l’administration et la comptabilité peuvent modifier ces réglages.</p>'}
    </form>`;
    loadTemplateFields();
  }
  function storeTemplateFields() {
    const form = document.getElementById("mailSettingsForm");
    if (!form || !editing) return;
    editing.templates[editing.current] = { subject: form.elements.tSubject.value, body: form.elements.tBody.value };
  }
  function loadTemplateFields() {
    const form = document.getElementById("mailSettingsForm");
    if (!form || !editing) return;
    editing.current = form.elements.template.value;
    const t = editing.templates[editing.current];
    form.elements.tSubject.value = t.subject;
    form.elements.tBody.value = t.body;
  }

  // ----- "E-mails et relances" window -----
  async function openCenter() {
    core().modal("E-mails et relances", '<div class="mail-center"><p class="muted">Chargement…</p></div>');
    const s = await loadStatus(true);
    const [reminders, log, inbox] = await Promise.all([
      s?.configured ? core().api("mail/reminders").catch(() => null) : null,
      core().api("mail/log?limit=30").catch(() => ({ emails: [] })),
      core().api("mail/inbox?limit=30").catch(() => ({ replies: [] })),
    ]);
    const box = document.querySelector("#modalBody .mail-center");
    if (!box) return;
    const companies = (s?.companies || []).filter((c) => c.id !== "group" || c.address);
    const autoBadges = (c) =>
      Object.entries(c.automations || {})
        .filter(([, on]) => on)
        .map(([k]) => `<span class="status neutral">${esc({ invoiceReminders: "Rappels", quoteFollowup: "Relance devis", appointments: "RDV", autoSendInvoices: "Factures auto", autoSendQuotes: "Devis auto" }[k])}</span>`)
        .join(" ");
    box.innerHTML = `
      <section class="card mail-status">
        <h3>${ic("mail")}<span>Entreprises</span></h3>
        <p>Chaque entreprise envoie depuis son propre Gmail, avec son nom et son logo. Ouvrez « Réglages » pour les envois automatiques, les textes et la signature.</p>
        ${companies.length
          ? `<div class="table"><table><thead><tr><th>Entreprise</th><th>Envoie depuis</th><th>Automatique</th><th></th></tr></thead><tbody>${companies
              .map(
                (c) =>
                  `<tr><td>${esc(c.name)}</td><td>${c.address ? `${esc(c.address)}${c.own ? "" : ' <small class="muted">(adresse par défaut)</small>'}` : '<span class="muted">Pas encore configurée</span>'}</td><td>${autoBadges(c) || '<span class="muted">—</span>'}</td><td class="mail-row-actions"><button type="button" class="btn secondary" data-mail-settings="${esc(c.id)}">Réglages</button>${c.address ? `<button type="button" class="btn secondary" data-mail-test="${esc(c.id)}">Tester</button>` : ""}</td></tr>`,
              )
              .join("")}</tbody></table></div>`
          : ""}
        ${s?.configured ? "" : '<p class="notice warning">Aucune adresse Gmail n’est encore configurée sur le serveur. En attendant, le bouton « Préparer e-mail » télécharge un brouillon à ouvrir dans votre messagerie.</p>'}
      </section>
      <section class="card"><h3>Réponses des clients${s?.unread ? ` <span class="mail-badge">${esc(s.unread)}</span>` : ""}</h3>
        <p class="muted">Les réponses aux e-mails de l’application et les messages des clients connus arrivent ici (vérification toutes les 10 minutes). Le reste de la boîte Gmail n’est jamais lu.</p>
        ${replyRows(inbox.replies || [])}</section>
      ${reminders
        ? `<section class="card"><h3>Factures en retard</h3>
            ${reminders.overdue.length
              ? `<div class="table"><table><thead><tr><th>Facture</th><th>Client</th><th>Retard</th><th>Reste dû</th><th>Prochain rappel</th></tr></thead><tbody>${reminders.overdue
                  .slice(0, 20)
                  .map(
                    (i) =>
                      `<tr><td>${esc(i.id)}</td><td>${esc(i.client)}${i.email ? "" : '<br><small class="error">sans adresse e-mail</small>'}</td><td>${esc(i.lateDays)} j</td><td>${esc(money(i.remaining))}</td><td>${i.remindersOn ? (i.nextReminder ? esc(swissDate(i.nextReminder)) : "—") : '<span class="muted">rappels désactivés</span>'}</td></tr>`,
                  )
                  .join("")}</tbody></table></div>`
              : '<p class="muted">Aucune facture en retard.</p>'}
          </section>`
        : ""}
      <section class="card"><h3>Derniers e-mails</h3>${logRows(log?.emails || [])}</section>`;
  }

  // ----- Client portal invitations -----
  async function openPortal() {
    core().modal("Espace client : invitations", '<p class="muted">Chargement…</p>');
    let out;
    try {
      out = await core().api("mail/portal-clients");
    } catch (error) {
      document.getElementById("modalBody").innerHTML = `<p class="error">${esc(error.message)}</p>`;
      return;
    }
    const companyName = (id) => (state().companies || []).find((c) => String(c.id) === String(id))?.name || "";
    document.getElementById("modalBody").innerHTML = `<div class="mail-center">
      <p>Le client reçoit un e-mail de son entreprise avec un lien pour créer son mot de passe (valable 7 jours). Il retrouve ensuite ses devis, factures, documents et chantiers.</p>
      <div class="table"><table><thead><tr><th>Client</th><th>E-mail</th><th>Espace client</th><th></th></tr></thead><tbody>${out.clients
        .map((c) => {
          const access = c.hasAccount && c.lastLogin ? `Actif · dernière connexion ${esc(dateTime(c.lastLogin))}` : c.invitedAt ? `Invité le ${esc(dateTime(c.invitedAt))}` : c.hasAccount ? "Compte créé" : '<span class="muted">Pas encore invité</span>';
          const action = !c.email
            ? '<small class="muted">Ajoutez son e-mail</small>'
            : !c.canSend
              ? '<small class="muted">Gmail de l’entreprise à configurer</small>'
              : c.hasAccount && c.lastLogin
                ? ""
                : `<button type="button" class="btn secondary" data-mail-invite="${esc(c.id)}">${c.invitedAt ? "Renvoyer" : "Inviter"}</button>`;
          return `<tr><td>${esc(c.name)}<br><small class="muted">${esc(companyName(c.company))}</small></td><td>${esc(c.email || "—")}</td><td>${access}</td><td>${action}</td></tr>`;
        })
        .join("")}</tbody></table></div></div>`;
  }

  function addPageButtons() {
    const page = core().getPage?.();
    const actions = document.querySelector("#content .section-head > .actions");
    if (!actions) return;
    if (isFinance() && ["invoices", "quotes"].includes(page) && !actions.querySelector("[data-mail-center]"))
      actions.insertAdjacentHTML(
        "beforeend",
        `<button type="button" class="btn secondary" data-mail-center data-keep-visible>${ic("mail")}<span>E-mails et relances</span>${status?.unread ? ` <span class="mail-badge" aria-label="${esc(status.unread)} réponse(s) non lue(s)">${esc(status.unread)}</span>` : ""}</button>`,
      );
    if (canInvite() && page === "clients" && status?.configured && !actions.querySelector("[data-mail-portal]"))
      actions.insertAdjacentHTML("beforeend", `<button type="button" class="btn secondary" data-mail-portal>${ic("mail")}<span>Inviter à l’espace client</span></button>`);
  }

  function afterRender() {
    if (!profile()?.id || profile().role === "client") return;
    loadStatus().then(() => addPageButtons());
  }

  // ----- Login screen: forgotten password, choosing a password from a link -----
  const loginForms = ["loginForm", "forgotForm", "setPasswordForm"];
  function showLoginForm(id) {
    for (const f of loginForms) document.getElementById(f)?.classList.toggle("hidden", f !== id);
  }
  async function openLinkFromUrl() {
    const params = new URLSearchParams(location.search);
    const token = params.get("reset") || params.get("invite");
    if (!token || !document.getElementById("setPasswordForm")) return;
    const form = document.getElementById("setPasswordForm");
    form.dataset.token = token;
    showLoginForm("setPasswordForm");
    const intro = document.getElementById("setPasswordIntro");
    try {
      const out = await (await fetch("/api/mail-public/token?token=" + encodeURIComponent(token))).json();
      if (!out.valid) {
        intro.textContent = "Ce lien n’est plus valable (déjà utilisé ou expiré). Demandez-en un nouveau avec « Mot de passe oublié ».";
        form.querySelector("button[type=submit]").disabled = true;
        return;
      }
      document.getElementById("setPasswordTitle").textContent = out.purpose === "invite" ? "Bienvenue dans votre espace client" : "Nouveau mot de passe";
      intro.textContent = `${out.purpose === "invite" ? "Choisissez le mot de passe de votre compte" : "Choisissez un nouveau mot de passe pour"} ${out.email}.`;
    } catch {
      intro.textContent = "Vérification du lien impossible. Réessayez dans un instant.";
    }
  }

  {
    const modalBody = document.getElementById("modalBody");
    if (modalBody && window.MutationObserver) new MutationObserver(() => enhanceDocumentModal()).observe(modalBody, { childList: true });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", openLinkFromUrl);
    else openLinkFromUrl();
  }

  document.addEventListener("click", async (event) => {
    const loginLink = event.target.closest("[data-login]");
    if (loginLink) {
      showLoginForm(loginLink.dataset.login === "forgot" ? "forgotForm" : "loginForm");
      if (loginLink.dataset.login === "forgot") document.getElementById("forgotEmail").value = document.getElementById("email")?.value || "";
      if (loginLink.dataset.login === "back" && /[?&](reset|invite)=/.test(location.search)) history.replaceState(null, "", "/");
      return;
    }
    const testButton = event.target.closest("[data-mail-test]");
    if (testButton) {
      testButton.disabled = true;
      try {
        const out = await core().api("mail/test", { company: testButton.dataset.mailTest });
        core().toast(`E-mail de test envoyé depuis ${out.from} à ${out.to}.`);
        openCenter();
      } catch (error) {
        core().toast(error.message || "Envoi impossible.");
        testButton.disabled = false;
      }
      return;
    }
    const send = event.target.closest("[data-mail-send]");
    if (send) {
      const [kind, id] = send.dataset.mailSend.split(":");
      return openSendForm(kind, id);
    }
    if (event.target.closest("[data-mail-center]")) return openCenter();
    if (event.target.closest("[data-mail-portal]")) return openPortal();
    const settings = event.target.closest("[data-mail-settings]");
    if (settings) return openSettings(settings.dataset.mailSettings);
    const invite = event.target.closest("[data-mail-invite]");
    if (invite) {
      const name = invite.closest("tr")?.querySelector("td")?.firstChild?.textContent || "ce client";
      if (!confirm(`Envoyer une invitation à l’espace client à ${name} ?`)) return;
      invite.disabled = true;
      try {
        const out = await core().api("mail/invite-client", { clientId: invite.dataset.mailInvite });
        core().toast("Invitation envoyée à " + out.to + ".");
        openPortal();
      } catch (error) {
        core().toast(error.message || "Invitation impossible.");
        invite.disabled = false;
      }
      return;
    }
    const field = event.target.closest("[data-mail-field]");
    if (field) {
      const area = document.querySelector("#mailSettingsForm [name=tBody]");
      if (area && !area.disabled) {
        const insert = "{" + field.dataset.mailField + "}";
        const start = area.selectionStart ?? area.value.length;
        area.value = area.value.slice(0, start) + insert + area.value.slice(area.selectionEnd ?? start);
        area.focus();
        area.selectionStart = area.selectionEnd = start + insert.length;
      }
      return;
    }
    if (event.target.closest("[data-mail-reset-template]")) {
      const form = document.getElementById("mailSettingsForm");
      const original = editing?.defaults?.[editing.current];
      if (form && original) {
        form.elements.tSubject.value = original.subject;
        form.elements.tBody.value = original.body;
      }
      return;
    }
    if (event.target.closest("[data-mail-preview-settings]")) {
      const form = document.getElementById("mailSettingsForm");
      storeTemplateFields();
      const t = editing.templates[editing.current];
      return showPreview(previewUrl(form.dataset.company, editing.current, t.subject, t.body, { phone: form.elements.phone.value, website: form.elements.website.value, extra: form.elements.extra.value }));
    }
    if (event.target.closest("[data-mail-preview-form]")) {
      const form = document.getElementById("mailSendForm");
      const template = form.dataset.kind === "quotes" ? "quote" : "invoice";
      return showPreview(previewUrl(form.dataset.company, template, form.elements.subject.value, form.elements.text.value));
    }
    if (event.target.closest("[data-mail-preview-close]")) return document.getElementById("mailPreviewBox")?.remove();
  });

  // Opening a reply marks it as read.
  document.addEventListener(
    "toggle",
    async (event) => {
      const reply = event.target;
      if (!reply?.matches?.("details[data-reply]") || !reply.open || !reply.classList.contains("unread")) return;
      reply.classList.remove("unread");
      try {
        await core().api(`mail/inbox/${encodeURIComponent(reply.dataset.reply)}/read`, {});
        if (status?.unread) status.unread -= 1;
      } catch {
        // Stays unread on the server; shown again next time.
      }
    },
    true,
  );

  document.addEventListener("change", (event) => {
    if (event.target?.name === "template" && event.target.closest("#mailSettingsForm")) {
      // Keep what was typed for the previous e-mail before showing the next one.
      const form = event.target.form;
      const previous = editing.current;
      editing.templates[previous] = { subject: form.elements.tSubject.value, body: form.elements.tBody.value };
      loadTemplateFields();
    }
  });

  document.addEventListener("submit", async (event) => {
    const form = event.target;
    if (form.id === "forgotForm") {
      event.preventDefault();
      const message = document.getElementById("forgotMessage");
      const button = form.querySelector("button[type=submit]");
      button.disabled = true;
      try {
        const out = await (
          await fetch("/api/mail-public/forgot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: document.getElementById("forgotEmail").value.trim() }) })
        ).json();
        message.textContent = out.message || "Si un compte existe pour cette adresse, un e-mail vient d’être envoyé.";
      } catch {
        message.textContent = "Envoi impossible pour le moment. Réessayez dans un instant.";
      } finally {
        button.disabled = false;
      }
      return;
    }
    if (form.id === "setPasswordForm") {
      event.preventDefault();
      const error = document.getElementById("setPasswordError");
      const password = document.getElementById("newPassword").value;
      error.textContent = "";
      if (password.length < 12) return (error.textContent = "Le mot de passe doit contenir au moins 12 caractères.");
      if (password !== document.getElementById("newPassword2").value) return (error.textContent = "Les deux mots de passe ne sont pas identiques.");
      const button = form.querySelector("button[type=submit]");
      button.disabled = true;
      try {
        const response = await fetch("/api/mail-public/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: form.dataset.token, password }) });
        const out = await response.json();
        if (!response.ok) throw new Error(out.error || "Enregistrement impossible.");
        history.replaceState(null, "", "/");
        showLoginForm("loginForm");
        document.getElementById("email").value = out.email || "";
        document.getElementById("password").value = "";
        document.getElementById("loginError").textContent = "";
        document.getElementById("password").focus();
        document.querySelector("#loginForm .login-help")?.insertAdjacentHTML("beforebegin", '<p class="notice" role="status">Mot de passe enregistré : connectez-vous.</p>');
      } catch (e) {
        error.textContent = e.message;
      } finally {
        button.disabled = false;
      }
      return;
    }
    if (form.id === "mailSettingsForm") {
      event.preventDefault();
      storeTemplateFields();
      const error = document.getElementById("mailSettingsError");
      error.textContent = "";
      const e = form.elements;
      const auto = (key) => e["auto:" + key].checked;
      const turnedOn = Object.keys(AUTOMATION_TEXT).filter((k) => auto(k));
      const payload = {
        signature: { phone: e.phone.value, website: e.website.value, extra: e.extra.value },
        bcc: e.bcc.value,
        reminderStages: [Number(e.stage1.value), Number(e.stage2.value), Number(e.stage3.value)],
        templates: editing.templates,
        automations: {
          invoiceReminders: { enabled: auto("invoiceReminders") },
          quoteFollowup: { enabled: auto("quoteFollowup"), days: Number(e.quoteDays.value) },
          appointments: { enabled: auto("appointments"), dayBefore: e.dayBefore.checked },
          autoSendInvoices: { enabled: auto("autoSendInvoices") },
          autoSendQuotes: { enabled: auto("autoSendQuotes") },
        },
      };
      const button = form.querySelector("button[type=submit]");
      button.disabled = true;
      try {
        await core().api("mail/settings/" + encodeURIComponent(form.dataset.company), payload);
        await loadStatus(true);
        core().toast(turnedOn.length ? `Réglages enregistrés (${turnedOn.length} envoi${turnedOn.length > 1 ? "s" : ""} automatique${turnedOn.length > 1 ? "s" : ""} actif${turnedOn.length > 1 ? "s" : ""}).` : "Réglages enregistrés.");
        openCenter();
      } catch (err) {
        error.textContent = err.message || "Enregistrement impossible.";
      } finally {
        button.disabled = false;
      }
      return;
    }
    if (form.id !== "mailSendForm") return;
    event.preventDefault();
    const button = form.querySelector("button[type=submit]");
    const error = document.getElementById("mailSendError");
    button.disabled = true;
    error.textContent = "";
    try {
      const files = [...(form.elements.uploads?.files || [])];
      if (files.reduce((n, f) => n + f.size, 0) > 5 * 1024 * 1024) throw new Error("Fichiers ajoutés : 5 Mo au maximum au total.");
      const uploads = [];
      for (const f of files.slice(0, 3)) uploads.push({ name: f.name, type: f.type, content: await fileToBase64(f) });
      const out = await core().api(`mail/finance/${encodeURIComponent(form.dataset.kind)}/${encodeURIComponent(form.dataset.id)}`, {
        to: form.elements.to.value.trim(),
        subject: form.elements.subject.value,
        text: form.elements.text.value,
        qr: form.elements.qr ? form.elements.qr.checked : undefined,
        documentIds: [...form.querySelectorAll("[name=documentIds]:checked")].map((x) => x.value),
        uploads,
      });
      core().closeModal(true);
      core().toast(`${form.dataset.kind === "quotes" ? "Devis envoyé" : "Facture envoyée"} à ${out.to}${out.attachments > 1 ? ` (${out.attachments} pièces jointes)` : ""}.`);
    } catch (e) {
      error.textContent = e.message || "Envoi impossible.";
    } finally {
      button.disabled = false;
    }
  });

  window.SGOMailCenter = { afterRender, status: () => status, loadStatus, openCenter, openSettings, openPortal, addressFor };
})();
