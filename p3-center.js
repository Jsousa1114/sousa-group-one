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
        <pre class="ops-summary-text">${esc(JSON.stringify(data, null, 2))}</pre>
        <div class="form-actions">${canExpense() ? button("Créer la dépense", "create-expense", "primary") : ""}</div>
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
        <pre class="ops-summary-text">${esc(JSON.stringify(data, null, 2))}</pre>
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

  async function render(container) {
    if (!container) return;
    container.innerHTML = '<article class="card"><p>Chargement du P3…</p></article>';
    try {
      const [status, workload, anomalyPayload] = await Promise.all([
        api("status"),
        api("workload?weeks=4"),
        api("anomalies"),
      ]);
      const currentCompany =
        (state().companies || []).find((c) => c.id !== "group")?.id || "";
      const firstClient =
        (state().clients || []).find((c) => !currentCompany || c.company === currentCompany)?.id || "";
      container.innerHTML = `
        <section class="ops-summary">
          <div class="ops-card-head">
            <div><span class="ops-eyebrow">P3</span><h2>Intelligence & automatisation avancée</h2><p>Assistant, devis, OCR, voix, anomalies, charge équipe et planification assistée.</p></div>
            <div>${badge(status.providerConfigured ? "IA configurée" : "IA externe non configurée", status.providerConfigured)} ${badge(status.transcriptionConfigured ? "Transcription serveur" : "Dictée navigateur", true)}</div>
          </div>
        </section>

        ${featureCards(status)}

        <div class="ops-grid-2">
          <article class="card">
            <h3>Assistant interne</h3>
            <p class="muted">Interroge les données auxquelles votre compte a déjà accès.</p>
            <label>Chantier ciblé (facultatif)<select id="p3AssistantProject"><option value="">Vue globale</option>${projectOptions()}</select></label>
            <label>Question<textarea id="p3AssistantQuestion" rows="4" placeholder="Ex. Quels chantiers demandent mon attention ?"></textarea></label>
            <div class="form-actions">${button("Analyser", "assistant", "primary")}</div>
            <pre id="p3AssistantAnswer" class="ops-summary-text">Posez une question pour commencer.</pre>
          </article>

          <article class="card">
            <h3>Compte rendu vocal → texte</h3>
            <p class="muted">Dictez depuis le navigateur ou transcrivez un fichier audio si le service serveur est configuré.</p>
            <div class="form-grid">
              <label>Chantier<select id="p3VoiceProject"><option value="">Choisir…</option>${projectOptions()}</select></label>
              <label>Date<input id="p3VoiceDate" type="date" value="${today()}"></label>
              <label class="span-2">Compte rendu<textarea id="p3VoiceText" rows="6" placeholder="Le texte dicté apparaîtra ici."></textarea></label>
              <label class="span-2">Fichier audio<input id="p3VoiceFile" type="file" accept="audio/*"></label>
            </div>
            <div class="form-actions">
              ${button("Démarrer la dictée", "dictate")}
              ${button("Transcrire le fichier", "transcribe")}
              ${button("Enregistrer au chantier", "save-voice-report", "primary")}
            </div>
          </article>
        </div>

        <article class="card">
          <h3>Création de devis assistée</h3>
          <div class="form-grid">
            <label>Entreprise<select id="p3QuoteCompany">${companyOptions(currentCompany)}</select></label>
            <label>Client<select id="p3QuoteClient">${clientOptions(firstClient)}</select></label>
            <label>Chantier (facultatif)<select id="p3QuoteProject"><option value="">Aucun</option>${projectOptions()}</select></label>
            <label>TVA %<input id="p3QuoteVat" type="number" min="0" max="100" step="0.1" value="8.1"></label>
            <label class="span-2">Objet<input id="p3QuoteRequestedTitle" maxlength="200" placeholder="Ex. Mise en conformité électrique"></label>
            <label class="span-2">Brief<textarea id="p3QuoteBrief" rows="5" placeholder="Décrivez les travaux, quantités connues, contraintes et prix déjà convenus."></textarea></label>
          </div>
          <div class="form-actions">${button("Préparer le devis", "quote-draft", "primary")}</div>
        </article>
        <div id="p3QuoteResult"></div>

        <div class="ops-grid-2">
          <article class="card">
            <h3>OCR facture fournisseur / matériel</h3>
            <div class="form-grid">
              <label>Type<select id="p3OcrMode"><option value="supplier_invoice">Facture fournisseur</option><option value="material">Matériel / référence</option></select></label>
              <label>Image<input id="p3OcrFile" type="file" accept="image/jpeg,image/png,image/webp"></label>
              <label>Entreprise<select id="p3OcrCompany">${companyOptions(currentCompany)}</select></label>
              <label>Chantier (facultatif)<select id="p3OcrProject"><option value="">Aucun</option>${projectOptions()}</select></label>
            </div>
            <div class="form-actions">${button("Lire le document", "ocr", "primary")}</div>
            ${!status.providerConfigured ? '<p class="muted">Le module est prêt, mais la lecture OCR nécessite AI_API_URL + AI_API_KEY côté serveur.</p>' : ""}
          </article>

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
          </article>
        </div>
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
        if (!file) return core().toast("Choisissez une image.");
        if (file.size > 5 * 1024 * 1024)
          return core().toast("Image trop volumineuse (5 Mo max).");
        const data = await readFile(file);
        const out = await api("ocr", {
          mode: document.getElementById("p3OcrMode")?.value || "supplier_invoice",
          imageDataUrl: data,
        });
        renderOcrResult(out);
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
      core().toast(error.message || "Action P3 impossible.");
    }
  });

  window.SGOP3Center = { render };
})();
