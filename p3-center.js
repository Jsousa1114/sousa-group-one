"use strict";

(() => {
  let lastQuote = null,
    lastOcr = null,
    recognition = null;

  const core = () => window.SGOChatCore;
  const esc = (value) => core()?.esc?.(value) ?? String(value ?? "");
  const state = () => core()?.getState?.() || {};
  const profile = () => core()?.getProfile?.() || {};
  const api = (path, body) => core().api("operations/p3/" + path, body);
  const today = () => new Date().toISOString().slice(0, 10);
  const plusDays = (days) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const money = (n) =>
    new Intl.NumberFormat("fr-CH", {
      style: "currency",
      currency: "CHF",
      minimumFractionDigits: 2,
    }).format(Number(n) || 0);

  const canFinance = () =>
    ["admin", "direction", "accounting"].includes(profile().role);
  const canPlan = () =>
    ["admin", "direction", "manager"].includes(profile().role);
  const canSuggestPlanning = () =>
    ["admin", "direction", "manager", "hr"].includes(profile().role);
  const canExpense = () =>
    ["admin", "direction", "manager", "accounting"].includes(profile().role);

  function projectOptions(selected = "") {
    return (state().projects || [])
      .map(
        (p) =>
          `<option value="${esc(p.id)}" ${String(p.id) === String(selected) ? "selected" : ""}>${esc(p.title || p.id)} · ${esc(p.id)}</option>`,
      )
      .join("");
  }

  function companyOptions(selected = "") {
    return (state().companies || [])
      .filter((c) => c.id !== "group")
      .map(
        (c) =>
          `<option value="${esc(c.id)}" ${String(c.id) === String(selected) ? "selected" : ""}>${esc(c.name || c.id)}</option>`,
      )
      .join("");
  }

  function clientOptions(selected = "") {
    return (state().clients || [])
      .map(
        (c) =>
          `<option value="${esc(c.id)}" ${String(c.id) === String(selected) ? "selected" : ""} data-company="${esc(c.company || "")}">${esc(c.name || c.id)}</option>`,
      )
      .join("");
  }

  function button(label, action, kind = "") {
    return `<button type="button" class="btn ${kind}" data-p3-action="${esc(action)}">${esc(label)}</button>`;
  }

  function badge(text, ok = true) {
    return `<span class="ops-severity ${ok ? "low" : "medium"}">${esc(text)}</span>`;
  }

  function featureCards(status) {
    const rows = [
      ["Assistant interne", status.features?.assistant],
      ["Devis assisté", status.features?.quoteDraft],
      ["OCR factures fournisseurs", status.features?.supplierInvoiceOcr],
      ["OCR matériel", status.features?.materialOcr],
      ["Compte rendu vocal → texte", status.features?.voiceToText],
      ["Résumé journalier chantier", status.features?.dailySummary],
      ["Détection d’anomalies", status.features?.anomalyDetection],
      ["Prévision charge équipe", status.features?.workloadForecast],
      ["Planification assistée", status.features?.assistedPlanning],
    ];
    return `<div class="ops-kpis">${rows
      .map(
        ([label, ready]) =>
          `<article class="card ops-kpi"><span>${esc(label)}</span><b>${ready ? "Prêt" : "À configurer"}</b><small>${ready ? "module actif" : "configuration requise"}</small></article>`,
      )
      .join("")}</div>`;
  }

  function workloadTable(workload) {
    const weeks = workload.weeks || [];
    const employees = workload.employees || [];
    if (!employees.length)
      return '<article class="card empty">Aucune donnée de charge disponible.</article>';
    return `<article class="card">
      <div class="ops-card-head"><div><h3>Prévision de charge</h3><p>Capacité et heures déjà planifiées sur les prochaines semaines.</p></div></div>
      <div class="table"><table>
        <thead><tr><th>Salarié</th>${weeks
          .map((w) => `<th>Semaine du ${esc(w.start)}</th>`)
          .join("")}<th>Total</th></tr></thead>
        <tbody>${employees
          .map(
            (e) => `<tr><td><b>${esc(e.name)}</b><br><small>${esc(e.job || "")}</small></td>${(e.weeks || [])
              .map(
                (w) =>
                  `<td>${Number(w.planned || 0).toFixed(1)} / ${Number(w.capacity || 0).toFixed(1)} h<br><small>${Number(w.utilization || 0).toFixed(0)}% · ${esc(w.status)}</small></td>`,
              )
              .join("")}<td><b>${Number(e.totalPlanned || 0).toFixed(1)} h</b></td></tr>`,
          )
          .join("")}</tbody>
      </table></div>
    </article>`;
  }

  function anomaliesCard(anomalies) {
    return `<article class="card">
      <div class="ops-card-head"><div><h3>Détection d’anomalies</h3><p>Budget, délais, stock, tâches et volumes d’heures inhabituels.</p></div></div>
      <div class="ops-insights">
        ${anomalies.length
          ? anomalies
              .slice(0, 20)
              .map(
                (x) => `<article class="ops-insight">
                  <span class="ops-severity ${esc(x.severity)}">${esc(x.severity)}</span>
                  <span><b>${esc(x.title)}</b><small>${esc(x.body)}</small></span>
                </article>`,
              )
              .join("")
          : '<p class="muted">Aucune anomalie importante détectée dans votre périmètre.</p>'}
      </div>
    </article>`;
  }

  function renderQuoteResult(payload) {
    lastQuote = payload;
    const target = document.getElementById("p3QuoteResult");
    if (!target) return;
    const draft = payload?.draft || {};
    target.innerHTML = `
      <article class="card">
        <div class="ops-card-head"><div><h3>Brouillon proposé</h3><p>${esc(payload.mode === "ai" ? "Généré avec le fournisseur IA configuré." : "Préparé localement. Complétez les prix avant création.")}</p></div>${badge(payload.mode === "ai" ? "IA" : "Local", true)}</div>
        ${payload.warning ? `<p class="notice">${esc(payload.warning)}</p>` : ""}
        <div class="form-grid">
          <label>Objet<input id="p3QuoteTitle" value="${esc(draft.title || "")}" maxlength="200"></label>
          <label>Acompte %<input id="p3QuoteDeposit" type="number" min="0" max="100" step="0.1" value="${esc(draft.depositPercent || 0)}"></label>
          <label class="span-2">Objet détaillé<textarea id="p3QuoteScope" rows="3" maxlength="5000">${esc(draft.scope || "")}</textarea></label>
          <label class="span-2">Message<textarea id="p3QuoteMessage" rows="2" maxlength="5000">${esc(draft.message || "")}</textarea></label>
          <label class="span-2">Conditions<textarea id="p3QuoteTerms" rows="2" maxlength="5000">${esc(draft.terms || "")}</textarea></label>
          <label class="span-2">Non compris / options<textarea id="p3QuoteExclusions" rows="2" maxlength="5000">${esc(draft.exclusions || "")}</textarea></label>
        </div>
        <div class="table"><table><thead><tr><th>Prestation</th><th>Qté</th><th>Unité</th><th>Prix unit.</th><th>TVA %</th><th>Remise %</th></tr></thead>
          <tbody id="p3QuoteLines">${(draft.lines || [])
            .map(
              (line, index) => `<tr data-index="${index}">
                <td><input data-field="description" value="${esc(line.description || "")}" maxlength="500"><input data-field="details" value="${esc(line.details || "")}" maxlength="5000" placeholder="Détails"></td>
                <td><input data-field="quantity" type="number" min="0.001" step="0.001" value="${esc(line.quantity ?? 1)}"></td>
                <td><input data-field="unit" value="${esc(line.unit || "forfait")}" maxlength="30"></td>
                <td><input data-field="unitPrice" type="number" min="0" step="0.01" value="${esc(line.unitPrice ?? 0)}"></td>
                <td><input data-field="vatRate" type="number" min="0" max="100" step="0.1" value="${esc(line.vatRate ?? 8.1)}"></td>
                <td><input data-field="discount" type="number" min="0" max="100" step="0.1" value="${esc(line.discount ?? 0)}"></td>
              </tr>`,
            )
            .join("")}</tbody>
        </table></div>
        <div class="form-actions">
          ${canFinance() ? button("Créer le devis brouillon", "create-quote", "primary") : '<span class="muted">La création du devis est réservée à la direction/comptabilité.</span>'}
        </div>
      </article>`;
  }

  // Readable OCR results: the lines as a table, a warning when the reading is uncertain,
  // and the raw data kept out of the way for checking.
  function invoiceItems(data) {
    const items = Array.isArray(data.items) ? data.items.slice(0, 50) : [];
    if (!items.length) return "";
    return `<div class="table"><table><thead><tr><th>Désignation</th><th>Qté</th><th>Prix unitaire</th><th>Montant</th></tr></thead><tbody>${items
      .map(
        (x) =>
          `<tr><td>${esc(x.description || "")}${x.reference ? ` <small>${esc(x.reference)}</small>` : ""}</td><td>${esc(x.quantity ?? "")} ${esc(x.unit || "")}</td><td>${x.unitPrice == null ? "—" : esc(money(x.unitPrice))}</td><td>${x.amount == null ? "—" : esc(money(x.amount))}</td></tr>`,
      )
      .join("")}</tbody></table></div>`;
  }
  function confidenceNote(data) {
    const warnings = (Array.isArray(data.warnings) ? data.warnings : []).filter(Boolean).slice(0, 5);
    const low = typeof data.confidence === "number" && data.confidence < 0.7;
    if (!low && !warnings.length) return "";
    return `<p class="notice warning">${low ? "Lecture incertaine : vérifiez chaque champ avant d’enregistrer." : ""}${warnings.map((w) => " " + esc(w)).join("")}</p>`;
  }
  function rawDetails(data) {
    return `<details class="p3-raw"><summary>Détails techniques</summary><pre class="ops-summary-text">${esc(JSON.stringify(data, null, 2))}</pre></details>`;
  }

  function renderOcrResult(payload) {
    lastOcr = payload;
    const target = document.getElementById("p3OcrResult");
    if (!target) return;
    const data = payload?.data || {};
    if (payload.mode === "supplier_invoice") {
      target.innerHTML = `<article class="card">
        <h3>Facture fournisseur extraite</h3>
        <div class="form-grid">
          <label>Fournisseur<input id="p3OcrSupplier" value="${esc(data.supplier || "")}"></label>
          <label>N° facture<input value="${esc(data.invoiceNumber || "")}" readonly></label>
          <label>Date<input id="p3OcrDate" type="date" value="${esc(data.date || today())}"></label>
          <label>Total CHF<input id="p3OcrTotal" type="number" min="0" step="0.01" value="${esc(data.total ?? "")}"></label>
        </div>
        ${confidenceNote(data)}
        <div class="form-actions">${canExpense() ? button("Créer la dépense", "create-expense", "primary") : ""}</div>
        ${invoiceItems(data)}
        ${rawDetails(data)}
      </article>`;
    } else {
      const items = Array.isArray(data.items) ? data.items : [];
      target.innerHTML = `<article class="card">
        <h3>Matériel reconnu</h3>
        <div class="table"><table><thead><tr><th>Désignation</th><th>Référence</th><th>EAN/SKU</th><th>Qté</th><th>Prix</th></tr></thead><tbody>
          ${items.length
            ? items
                .map(
                  (x) => `<tr><td>${esc(x.description || "")}</td><td>${esc(x.reference || "")}</td><td>${esc(x.ean || x.sku || "")}</td><td>${esc(x.quantity ?? "")} ${esc(x.unit || "")}</td><td>${x.unitPrice == null ? "—" : money(x.unitPrice)}</td></tr>`,
                )
                .join("")
            : '<tr><td colspan="5">Aucun article reconnu.</td></tr>'}
        </tbody></table></div>
        ${confidenceNote(data)}
        ${rawDetails(data)}
      </article>`;
    }
  }

  function renderSuggestions(payload) {
    const target = document.getElementById("p3PlanningResult");
    if (!target) return;
    const rows = payload?.suggestions || [];
    target.innerHTML = rows.length
      ? `<div class="ops-grid-2">${rows
          .map(
            (x) => `<article class="card">
              <div class="ops-card-head"><div><h3>${esc(x.name)}</h3><p>${esc(x.job || "Fonction non renseignée")}</p></div><b>${Number(x.score || 0).toFixed(0)} pts</b></div>
              <p>${esc((x.reasons || []).join(" · "))}</p>
              <p class="muted">Charge semaine : ${Number(x.weeklyPlanned || 0).toFixed(1)} / ${Number(x.weeklyCapacity || 0).toFixed(1)} h</p>
              ${canPlan() ? `<button type="button" class="btn primary" data-p3-action="assign-suggestion" data-employee-id="${esc(x.employeeId)}">Affecter ce salarié</button>` : ""}
            </article>`,
          )
          .join("")}</div>`
      : '<article class="card empty">Aucun salarié disponible sur ce créneau.</article>';
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Lecture du fichier impossible."));
      reader.readAsDataURL(file);
    });
  }

  // Each AI tool is a reusable block: the full assistant page assembles them, and the
  // contextual buttons (Dépenses, Devis, Matériel, Planning, fiche chantier) open one in a dialog.
  // Default company: the workspace selected in the menu, else the user's own company, else the
  // company of the first client. The default client always belongs to it (the server requires it).
  function defaults() {
    const companies = (state().companies || []).filter((c) => c.id !== "group").map((c) => String(c.id));
    const clients = state().clients || [];
    const pick = [document.getElementById("companyFilter")?.value, profile().company, clients[0]?.company, companies[0]]
      .map((x) => String(x || ""))
      .find((x) => x && companies.includes(x)) || "";
    const client = clients.find((c) => !pick || String(c.company || "") === pick)?.id || "";
    return { company: pick, client };
  }
  function assistantCard() {
    return `
          <article class="card">
            <h3>Assistant interne</h3>
            <p class="muted">Interroge les données auxquelles votre compte a déjà accès.</p>
            <label>Chantier ciblé (facultatif)<select id="p3AssistantProject"><option value="">Vue globale</option>${projectOptions()}</select></label>
            <label>Question<textarea id="p3AssistantQuestion" rows="4" placeholder="Ex. Quels chantiers demandent mon attention ?"></textarea></label>
            <div class="form-actions">${button("Analyser", "assistant", "primary")}</div>
            <pre id="p3AssistantAnswer" class="ops-summary-text">Posez une question pour commencer.</pre>
          </article>`;
  }
  function voiceCard(projectId = "") {
    return `
          <article class="card">
            <h3>Compte rendu vocal → texte</h3>
            <p class="muted">Dictez depuis le navigateur ou transcrivez un fichier audio si le service serveur est configuré.</p>
            <div class="form-grid">
              <label>Chantier<select id="p3VoiceProject"><option value="">Choisir…</option>${projectOptions(projectId)}</select></label>
              <label>Date<input id="p3VoiceDate" type="date" value="${today()}"></label>
              <label class="span-2">Compte rendu<textarea id="p3VoiceText" rows="6" placeholder="Le texte dicté apparaîtra ici."></textarea></label>
              <label class="span-2">Fichier audio<input id="p3VoiceFile" type="file" accept="audio/*"></label>
            </div>
            <div class="form-actions">
              ${button("Démarrer la dictée", "dictate")}
              ${button("Transcrire le fichier", "transcribe")}
              ${button("Enregistrer au chantier", "save-voice-report", "primary")}
            </div>
          </article>`;
  }
  function quoteCard() {
    const d = defaults();
    return `
        <article class="card">
          <h3>Création de devis assistée</h3>
          <div class="form-grid">
            <label>Entreprise<select id="p3QuoteCompany">${companyOptions(d.company)}</select></label>
            <label>Client<select id="p3QuoteClient">${clientOptions(d.client)}</select></label>
            <label>Chantier (facultatif)<select id="p3QuoteProject"><option value="">Aucun</option>${projectOptions()}</select></label>
            <label>TVA %<input id="p3QuoteVat" type="number" min="0" max="100" step="0.1" value="8.1"></label>
            <label class="span-2">Objet<input id="p3QuoteRequestedTitle" maxlength="200" placeholder="Ex. Mise en conformité électrique"></label>
            <label class="span-2">Brief<textarea id="p3QuoteBrief" rows="5" placeholder="Décrivez les travaux, quantités connues, contraintes et prix déjà convenus."></textarea></label>
          </div>
          <div class="form-actions">${button("Préparer le devis", "quote-draft", "primary")}</div>
        </article>`;
  }
  function ocrCard(mode = "supplier_invoice", providerConfigured = true) {
    const d = defaults();
    return `
          <article class="card">
            <h3>OCR facture fournisseur / matériel</h3>
            <div class="form-grid">
              <label>Type<select id="p3OcrMode"><option value="supplier_invoice" ${mode === "supplier_invoice" ? "selected" : ""}>Facture fournisseur</option><option value="material" ${mode === "material" ? "selected" : ""}>Matériel / référence</option></select></label>
              <label>Photo ou image<input id="p3OcrFile" type="file" accept="image/*"></label>
              <label>Entreprise<select id="p3OcrCompany">${companyOptions(d.company)}</select></label>
              <label>Chantier (facultatif)<select id="p3OcrProject"><option value="">Aucun</option>${projectOptions()}</select></label>
            </div>
            <p class="muted">Prenez la photo bien à plat et lisible. Elle est réduite automatiquement avant l’envoi.</p>
            <div class="form-actions">${button("Lire le document", "ocr", "primary")}</div>
            ${!providerConfigured ? '<p class="muted">Le module est prêt, mais la lecture OCR nécessite AI_API_URL + AI_API_KEY côté serveur.</p>' : ""}
          </article>`;
  }
  function planningCard() {
    return `
          <article class="card">
            <h3>Planification assistée</h3>
            ${canSuggestPlanning()
              ? `<div class="form-grid">
                  <label>Chantier<select id="p3PlanProject"><option value="">Choisir…</option>${projectOptions()}</select></label>
                  <label>Date<input id="p3PlanDate" type="date" value="${today()}"></label>
                  <label>Début<input id="p3PlanStart" type="time" value="08:00"></label>
                  <label>Fin<input id="p3PlanEnd" type="time" value="17:00"></label>
                </div>
                <div class="form-actions">${button("Proposer l’équipe", "planning-suggestions", "primary")}</div>`
              : '<p class="muted">La proposition d’affectation est réservée aux responsables et RH.</p>'}
          </article>`;
  }

  async function render(container) {
    if (!container) return;
    container.innerHTML = '<article class="card"><p>Chargement de l’assistant…</p></article>';
    try {
      const [status, workload, anomalyPayload] = await Promise.all([
        api("status"),
        api("workload?weeks=4"),
        api("anomalies"),
      ]);
      aiStatus = status;
      container.innerHTML = `
        <section class="ops-summary">
          <div class="ops-card-head">
            <div><span class="ops-eyebrow">Assistant intelligent</span><h2>Intelligence & automatisation avancée</h2><p>Assistant, devis, lecture de documents, dictée vocale, détection d’anomalies, charge de l’équipe et planification assistée.</p></div>
            <div>${badge(status.providerConfigured ? "IA configurée" : "IA externe non configurée", status.providerConfigured)} ${badge(status.transcriptionConfigured ? "Transcription serveur" : "Dictée navigateur", true)}</div>
          </div>
        </section>

        ${featureCards(status)}

        <div class="ops-grid-2">${assistantCard()}${voiceCard()}</div>
        ${quoteCard()}
        <div id="p3QuoteResult"></div>
        <div class="ops-grid-2">${ocrCard("supplier_invoice", status.providerConfigured)}${planningCard()}</div>
        <div id="p3OcrResult"></div>
        <div id="p3PlanningResult"></div>

        ${workloadTable(workload)}
        ${anomaliesCard(anomalyPayload.anomalies || [])}
      `;
    } catch (error) {
      container.innerHTML = `<article class="card"><p class="error">${esc(error.message || "Chargement impossible.")}</p></article>`;
    }
  }

  function quoteLinesFromDom() {
    return [...document.querySelectorAll("#p3QuoteLines tr")].map((row) => {
      const value = (field) => row.querySelector(`[data-field="${field}"]`)?.value ?? "";
      return {
        description: value("description"),
        details: value("details"),
        quantity: Number(value("quantity")),
        unit: value("unit"),
        unitPrice: Number(value("unitPrice")),
        vatRate: Number(value("vatRate")),
        discount: Number(value("discount")),
      };
    });
  }

  function startDictation() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      core().toast("La dictée vocale n’est pas disponible dans ce navigateur.");
      return;
    }
    if (recognition) {
      recognition.stop();
      recognition = null;
      return;
    }
    const target = document.getElementById("p3VoiceText");
    recognition = new SpeechRecognition();
    recognition.lang = "fr-CH";
    recognition.continuous = true;
    recognition.interimResults = true;
    let finalText = target?.value ? target.value.trim() + " " : "";
    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i][0]?.transcript || "";
        if (event.results[i].isFinal) finalText += text.trim() + " ";
        else interim += text;
      }
      if (target) target.value = (finalText + interim).trim();
    };
    recognition.onerror = () => core().toast("La dictée vocale a été interrompue.");
    recognition.onend = () => {
      recognition = null;
    };
    recognition.start();
    core().toast("Dictée démarrée.");
  }

  // Keep the quote form consistent: a client belongs to one company.
  document.addEventListener("change", (event) => {
    const companySelect = document.getElementById("p3QuoteCompany"),
      clientSelect = document.getElementById("p3QuoteClient");
    if (!companySelect || !clientSelect) return;
    if (event.target === clientSelect) {
      const company = clientSelect.selectedOptions[0]?.dataset.company || "";
      if (company) companySelect.value = company;
    } else if (event.target === companySelect) {
      const current = clientSelect.selectedOptions[0];
      if (!current || (current.dataset.company && current.dataset.company !== companySelect.value)) {
        const first = [...clientSelect.options].find((o) => !o.dataset.company || o.dataset.company === companySelect.value);
        if (first) clientSelect.value = first.value;
      }
    }
  });

  document.addEventListener("click", async (event) => {
    const buttonNode = event.target.closest("[data-p3-action]");
    if (!buttonNode) return;
    const action = buttonNode.dataset.p3Action;
    try {
      if (action === "assistant") {
        const question = document.getElementById("p3AssistantQuestion")?.value || "";
        const projectId = document.getElementById("p3AssistantProject")?.value || "";
        const target = document.getElementById("p3AssistantAnswer");
        if (!question.trim()) return core().toast("Écrivez une question.");
        target.textContent = "Analyse…";
        const out = await api("assistant", {
          question: projectId ? question + "\nChantier ciblé : " + projectId : question,
          projectId,
        });
        target.textContent = out.answer || "Aucune réponse.";
      } else if (action === "quote-draft") {
        if (!canFinance()) return core().toast("Accès devis non autorisé.");
        const out = await api("quote-draft", {
          company: document.getElementById("p3QuoteCompany")?.value || "",
          clientId: document.getElementById("p3QuoteClient")?.value || "",
          projectId: document.getElementById("p3QuoteProject")?.value || "",
          title: document.getElementById("p3QuoteRequestedTitle")?.value || "",
          brief: document.getElementById("p3QuoteBrief")?.value || "",
          vatRate: Number(document.getElementById("p3QuoteVat")?.value || 0),
        });
        renderQuoteResult(out);
      } else if (action === "create-quote") {
        if (!lastQuote) return;
        const lines = quoteLinesFromDom();
        if (!lines.length || lines.some((line) => !(line.unitPrice > 0)))
          return core().toast("Complétez tous les prix unitaires avant de créer le devis.");
        await core().mutate(
          "create",
          {
            company: document.getElementById("p3QuoteCompany")?.value || lastQuote.company,
            clientId: document.getElementById("p3QuoteClient")?.value || lastQuote.clientId,
            project: document.getElementById("p3QuoteProject")?.value || "",
            title: document.getElementById("p3QuoteTitle")?.value || "Devis assisté",
            lines,
            language: "fr",
            message: document.getElementById("p3QuoteMessage")?.value || "",
            terms: document.getElementById("p3QuoteTerms")?.value || "",
            scope: document.getElementById("p3QuoteScope")?.value || "",
            exclusions: document.getElementById("p3QuoteExclusions")?.value || "",
            paymentNote: "",
            depositPercent: Number(document.getElementById("p3QuoteDeposit")?.value || 0),
            signature: true,
            date: today(),
            valid: plusDays(30),
          },
          "quotes",
        );
      } else if (action === "ocr") {
        const file = document.getElementById("p3OcrFile")?.files?.[0];
        if (!file) return core().toast("Choisissez une photo ou une image.");
        const label = buttonNode.textContent;
        buttonNode.disabled = true;
        buttonNode.textContent = "Lecture en cours…";
        try {
          const data = await readImage(file);
          const out = await api("ocr", {
            mode: document.getElementById("p3OcrMode")?.value || "supplier_invoice",
            imageDataUrl: data,
          });
          renderOcrResult(out);
        } finally {
          buttonNode.disabled = false;
          buttonNode.textContent = label;
        }
      } else if (action === "create-expense") {
        if (!lastOcr || lastOcr.mode !== "supplier_invoice") return;
        const supplier = document.getElementById("p3OcrSupplier")?.value || "";
        const amount = Number(document.getElementById("p3OcrTotal")?.value || 0);
        const date = document.getElementById("p3OcrDate")?.value || "";
        if (!supplier.trim() || !(amount > 0) || !date)
          return core().toast("Vérifiez le fournisseur, la date et le total.");
        await core().mutate(
          "create",
          {
            company: document.getElementById("p3OcrCompany")?.value || "",
            project: document.getElementById("p3OcrProject")?.value || "",
            supplier,
            amount,
            date,
          },
          "expenses",
        );
      } else if (action === "dictate") {
        startDictation();
      } else if (action === "transcribe") {
        const file = document.getElementById("p3VoiceFile")?.files?.[0];
        if (!file) return core().toast("Choisissez un fichier audio.");
        if (file.size > 5 * 1024 * 1024)
          return core().toast("Audio trop volumineux (5 Mo max).");
        const data = await readFile(file);
        const out = await api("transcribe", { audioDataUrl: data });
        const target = document.getElementById("p3VoiceText");
        target.value = [target.value.trim(), out.text || ""].filter(Boolean).join("\n");
      } else if (action === "save-voice-report") {
        const projectId = document.getElementById("p3VoiceProject")?.value || "";
        const text = document.getElementById("p3VoiceText")?.value || "";
        if (!projectId || !text.trim())
          return core().toast("Choisissez un chantier et ajoutez un compte rendu.");
        await core().api("operations/project/" + encodeURIComponent(projectId) + "/report", {
          reportDate: document.getElementById("p3VoiceDate")?.value || today(),
          weather: "",
          summary: text.trim(),
          issues: "",
          materials: "",
          team: "",
        });
        core().toast("Compte rendu enregistré sur le chantier.");
      } else if (action === "planning-suggestions") {
        const out = await api("planning-suggestions", {
          projectId: document.getElementById("p3PlanProject")?.value || "",
          date: document.getElementById("p3PlanDate")?.value || "",
          start: document.getElementById("p3PlanStart")?.value || "",
          end: document.getElementById("p3PlanEnd")?.value || "",
          limit: 6,
        });
        renderSuggestions(out);
      } else if (action === "assign-suggestion") {
        if (!canPlan()) return;
        const project = document.getElementById("p3PlanProject")?.value || "";
        const projectRow = (state().projects || []).find((p) => String(p.id) === String(project));
        await core().mutate(
          "create",
          {
            employeeId: buttonNode.dataset.employeeId,
            project,
            date: document.getElementById("p3PlanDate")?.value || "",
            start: document.getElementById("p3PlanStart")?.value || "",
            end: document.getElementById("p3PlanEnd")?.value || "",
            location: projectRow?.address || "",
          },
          "planning",
        );
      }
    } catch (error) {
      core().toast(error.message || "Action impossible.");
    }
  });

  // ---------------------------------------------------------------------------
  // AI everywhere: a global "Assistant" panel opened from the top bar, the AI tools in a
  // dialog, and contextual buttons on the pages where each tool is needed.
  // ---------------------------------------------------------------------------
  let aiStatus = null,
    statusRequest = null,
    chat = [],
    chatOwner = null,
    asking = false;
  const ic = (name) => window.SGOIcon?.(name) || "";
  const isClient = () => profile().role === "client";
  const aiReady = () => !!aiStatus?.providerConfigured;

  // Phone photos are often 3–10 MB: shrink them to a size that is plenty for reading a document.
  async function readImage(file) {
    if (!/^image\//.test(file.type || "") && !/\.(heic|heif)$/i.test(file.name || ""))
      throw new Error("Choisissez une photo ou une image.");
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close?.();
      return canvas.toDataURL("image/jpeg", 0.85);
    } catch {
      if (file.size > 5 * 1024 * 1024) throw new Error("Image trop volumineuse (5 Mo max).");
      return readFile(file);
    }
  }

  const TOOLS = {
    "ocr-invoice": { title: "Lire une facture fournisseur", icon: "camera", label: "Lire une facture", allowed: () => canExpense() && aiReady(), html: () => ocrCard("supplier_invoice") + '<div id="p3OcrResult"></div>' },
    "ocr-material": { title: "Reconnaître du matériel", icon: "camera", label: "Reconnaître du matériel", allowed: () => aiReady(), html: () => ocrCard("material") + '<div id="p3OcrResult"></div>' },
    quote: { title: "Devis avec l’IA", icon: "sparkle", label: "Devis avec l’IA", allowed: () => canFinance() && aiReady(), html: () => quoteCard() + '<div id="p3QuoteResult"></div>' },
    voice: { title: "Compte rendu vocal", icon: "mic", label: "Compte rendu vocal", allowed: () => !isClient(), html: (o) => voiceCard(o.projectId || "") },
    planning: { title: "Proposer l’équipe", icon: "users", label: "Proposer l’équipe", allowed: () => canSuggestPlanning(), html: () => planningCard() + '<div id="p3PlanningResult"></div>' },
  };
  // Contextual buttons, added next to the page's own actions.
  const PAGE_TOOLS = { expenses: "ocr-invoice", quotes: "quote", inventory: "ocr-material", planning: "planning" };

  function openTool(name, options = {}) {
    const tool = TOOLS[name];
    if (!tool) return;
    if (!tool.allowed()) return core().toast("Cet outil n’est pas disponible pour votre compte.");
    closePanel();
    // The full assistant page already holds the same forms: point to it instead of duplicating ids.
    const existing = document.querySelector("#content #p3OcrFile, #content #p3QuoteBrief");
    if (existing) {
      existing.closest(".card")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    core().modal(tool.title, `<div class="p3-tool">${tool.html(options)}</div>`);
  }

  function ensureStatus() {
    if (aiStatus || isClient()) return Promise.resolve(aiStatus);
    if (!statusRequest)
      statusRequest = api("status")
        .then((s) => (aiStatus = s))
        .catch(() => null)
        .finally(() => (statusRequest = null));
    return statusRequest;
  }

  // ----- Conversation, kept per user for the browser tab -----
  const chatKey = () => "sgo_ai_chat_" + (profile().id || "");
  function loadChat() {
    if (chatOwner === chatKey()) return;
    chatOwner = chatKey();
    try {
      chat = JSON.parse(sessionStorage.getItem(chatOwner) || "[]");
    } catch {
      chat = [];
    }
  }
  function saveChat() {
    try {
      sessionStorage.setItem(chatKey(), JSON.stringify(chat.slice(-30)));
    } catch {
      // Private browsing: the conversation simply is not kept.
    }
  }
  const SUGGESTIONS = {
    dashboard: ["Qu’est-ce qui demande mon attention aujourd’hui ?", "Résume l’activité de la semaine."],
    projects: ["Quels chantiers sont en retard ?", "Quels chantiers dépassent leur budget ?"],
    invoices: ["Quelles factures sont en retard de paiement ?", "Combien reste-t-il à encaisser ?"],
    quotes: ["Quels devis attendent une réponse ?"],
    planning: ["Qui est disponible demain ?", "Quelle est la charge de l’équipe cette semaine ?"],
    time: ["Quelles heures restent à valider ?"],
    absences: ["Qui est absent cette semaine ?"],
    inventory: ["Quel matériel est sous le stock minimum ?"],
    expenses: ["Quelles sont les plus grosses dépenses du mois ?"],
  };
  const DEFAULT_SUGGESTIONS = ["Qu’est-ce qui demande mon attention aujourd’hui ?", "Quels chantiers sont en retard ?"];
  // The project currently open in a dialog, if any, so questions are about it.
  const openProjectId = () =>
    document.querySelector('#modalWrap:not(.hidden) [data-pro-action="project-central"]')?.dataset.id || "";

  function ensurePanel() {
    let panel = document.getElementById("aiPanel");
    if (panel) return panel;
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div id="aiBackdrop" class="ai-backdrop" hidden data-p3-panel="close"></div>
      <aside id="aiPanel" class="ai-panel" hidden role="dialog" aria-labelledby="aiPanelTitle">
        <header class="ai-panel-head">
          <div><h2 id="aiPanelTitle">${ic("sparkle")}<span>Assistant</span></h2><p>Répond à partir des données auxquelles vous avez accès.</p></div>
          <div class="ai-panel-actions">
            <button type="button" class="ai-icon-btn" data-p3-panel="clear" title="Nouvelle discussion" aria-label="Nouvelle discussion">${ic("refresh")}</button>
            <button type="button" class="ai-icon-btn" data-p3-panel="close" title="Fermer" aria-label="Fermer l’assistant">${ic("x")}</button>
          </div>
        </header>
        <div id="aiTools" class="ai-tools" aria-label="Outils"></div>
        <div id="aiMessages" class="ai-messages" aria-live="polite"></div>
        <div id="aiSuggestions" class="ai-suggestions"></div>
        <form id="aiComposer" class="ai-composer">
          <textarea id="aiQuestion" rows="2" maxlength="2500" placeholder="Posez votre question…" aria-label="Votre question"></textarea>
          <button type="submit" class="ai-send" aria-label="Envoyer">${ic("send")}</button>
        </form>
      </aside>`,
    );
    return document.getElementById("aiPanel");
  }

  function renderPanel() {
    const panel = ensurePanel();
    loadChat();
    const page = core().getPage?.() || "";
    panel.querySelector("#aiTools").innerHTML = Object.entries(TOOLS)
      .filter(([, tool]) => tool.allowed())
      .map(([id, tool]) => `<button type="button" class="ai-tool" data-p3-open="${id}">${ic(tool.icon)}<span>${esc(tool.label)}</span></button>`)
      .join("");
    const messages = panel.querySelector("#aiMessages");
    messages.innerHTML = chat.length
      ? chat
          .map((m, i) =>
            m.role === "user"
              ? `<div class="ai-msg ai-user"><p>${esc(m.text)}</p></div>`
              : m.role === "error"
                ? `<div class="ai-msg ai-error"><p>${esc(m.text)}</p>${i === chat.length - 1 ? '<button type="button" class="btn secondary" data-p3-panel="retry">Réessayer</button>' : ""}</div>`
                : `<div class="ai-msg ai-answer"><p>${esc(m.text)}</p></div>`,
          )
          .join("") + (asking ? '<div class="ai-msg ai-answer ai-typing"><p>L’assistant réfléchit…</p></div>' : "")
      : `<div class="ai-welcome"><p><b>Bonjour ${esc((profile().name || "").split(" ")[0] || "")} !</b></p><p>Posez une question sur vos chantiers, factures, planning ou stock. Je réponds à partir des données que votre compte peut voir.</p>${aiReady() ? "" : '<p class="muted">L’IA externe n’est pas configurée : les réponses sont des résumés simples calculés par l’application.</p>'}</div>`;
    messages.scrollTop = messages.scrollHeight;
    const questions = SUGGESTIONS[page] || DEFAULT_SUGGESTIONS;
    panel.querySelector("#aiSuggestions").innerHTML = asking
      ? ""
      : questions.map((q) => `<button type="button" class="ai-chip" data-p3-ask="${esc(q)}">${esc(q)}</button>`).join("");
    panel.querySelector(".ai-send").disabled = asking;
  }

  function setLauncherState(open) {
    document.querySelector("[data-p3-panel='toggle']")?.setAttribute("aria-expanded", String(open));
  }
  function openPanel() {
    if (isClient()) return;
    const panel = ensurePanel();
    renderPanel();
    panel.hidden = false;
    document.getElementById("aiBackdrop").hidden = false;
    document.body.classList.add("ai-panel-open");
    setLauncherState(true);
    // On phones, focusing the field would open the keyboard over the suggestions: let the user tap it.
    if (!window.matchMedia?.("(max-width: 760px)").matches)
      setTimeout(() => document.getElementById("aiQuestion")?.focus(), 0);
  }
  function closePanel() {
    const panel = document.getElementById("aiPanel");
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    document.getElementById("aiBackdrop").hidden = true;
    document.body.classList.remove("ai-panel-open");
    setLauncherState(false);
  }

  async function ask(question) {
    question = String(question || "").trim();
    if (!question || asking) return;
    loadChat();
    chat.push({ role: "user", text: question });
    asking = true;
    saveChat();
    renderPanel();
    const projectId = openProjectId();
    const pageTitle = document.getElementById("title")?.textContent?.trim() || "";
    try {
      const out = await api("assistant", {
        question:
          question +
          (pageTitle ? "\n(Page affichée : " + pageTitle + ")" : "") +
          (projectId ? "\nChantier ciblé : " + projectId : ""),
        projectId,
      });
      chat.push({ role: "ai", text: out.answer || "Aucune réponse." });
    } catch (error) {
      chat.push({ role: "error", text: (error.message || "Le service IA est indisponible.") + " Vous pouvez réessayer." });
    } finally {
      asking = false;
      saveChat();
      renderPanel();
    }
  }

  function ensureLauncher() {
    const top = document.querySelector(".top-actions");
    if (!top || top.querySelector("[data-p3-panel='toggle']")) return;
    top.insertAdjacentHTML(
      "afterbegin",
      `<button type="button" class="icon ai-launch" data-p3-panel="toggle" aria-label="Assistant IA" title="Assistant IA" aria-expanded="false">${ic("sparkle")}<span class="ai-launch-label">Assistant</span></button>`,
    );
  }
  function removeLauncher() {
    document.querySelector("[data-p3-panel='toggle']")?.remove();
    closePanel();
  }

  function addPageButton() {
    const toolId = PAGE_TOOLS[core().getPage?.() || ""];
    const tool = TOOLS[toolId];
    const actions = document.querySelector("#content .section-head > .actions");
    if (!tool || !actions || actions.querySelector("[data-p3-open]") || !tool.allowed()) return;
    actions.insertAdjacentHTML(
      "beforeend",
      `<button type="button" class="btn secondary ai-action" data-p3-open="${toolId}" data-keep-visible>${ic(tool.icon)}<span>${esc(tool.label)}</span></button>`,
    );
  }
  function addProjectButton() {
    if (isClient()) return;
    // Optional chaining: the observer can fire while a test window is being closed.
    const central = document?.querySelector?.('#modalBody [data-pro-action="project-central"]');
    if (!central || central.parentElement.querySelector("[data-p3-open='voice']")) return;
    central.insertAdjacentHTML(
      "afterend",
      ` <button type="button" class="btn secondary ai-action" data-p3-open="voice" data-project="${esc(central.dataset.id || "")}">${ic("mic")}<span>Compte rendu vocal</span></button>`,
    );
  }

  function afterRender() {
    if (!profile()?.id || isClient()) return removeLauncher();
    ensureLauncher();
    ensureStatus().then(() => {
      addPageButton();
      if (!document.getElementById("aiPanel")?.hidden) renderPanel();
    });
  }

  {
    const modalBody = document.getElementById("modalBody");
    if (modalBody && window.MutationObserver)
      new MutationObserver(() => addProjectButton()).observe(modalBody, { childList: true });
  }
  document.addEventListener("click", (event) => {
    const open = event.target.closest("[data-p3-open]");
    if (open) return openTool(open.dataset.p3Open, { projectId: open.dataset.project || "" });
    const chip = event.target.closest("[data-p3-ask]");
    if (chip) return ask(chip.dataset.p3Ask);
    const control = event.target.closest("[data-p3-panel]");
    if (!control) return;
    const action = control.dataset.p3Panel;
    if (action === "toggle") document.getElementById("aiPanel")?.hidden === false ? closePanel() : openPanel();
    else if (action === "close") closePanel();
    else if (action === "clear") {
      chat = [];
      saveChat();
      renderPanel();
    } else if (action === "retry") {
      const last = [...chat].reverse().find((m) => m.role === "user");
      if (last) {
        chat = chat.slice(0, chat.lastIndexOf(last));
        ask(last.text);
      }
    }
  });
  document.addEventListener("submit", (event) => {
    if (event.target.id !== "aiComposer") return;
    event.preventDefault();
    const field = document.getElementById("aiQuestion");
    const question = field.value;
    field.value = "";
    ask(question);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.getElementById("aiPanel")?.hidden === false && document.getElementById("modalWrap")?.classList.contains("hidden"))
      closePanel();
    if (event.target.id === "aiQuestion" && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      document.getElementById("aiComposer").requestSubmit();
    }
  });

  window.SGOP3Center = { render, openTool, openPanel, closePanel, afterRender };
})();
