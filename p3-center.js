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
  const swissDate = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(iso || "") ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : iso || "");
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
    const ai = !!status.providerConfigured;
    const rows = [
      ["Assistant (bouton en haut)", ai],
      ["Devis avec l’IA", ai],
      ["Lecture de factures (photo, PDF)", ai],
      ["Bons de livraison → stock", ai],
      ["Comptes rendus dictés", true],
      ["E-mails aux clients", ai],
      ["Détection d’anomalies", status.features?.anomalyDetection],
      ["Planification assistée", status.features?.assistedPlanning],
    ];
    return `<div class="ops-kpis">${rows
      .map(
        ([label, ready]) =>
          `<article class="card ops-kpi"><span>${esc(label)}</span><b>${ready ? "Prêt" : "À configurer"}</b><small>${ready ? "module actif" : "configuration requise"}</small></article>`,
      )
      .join("")}</div>`;
  }

  const FEATURE_LABELS = { assistant: "Assistant", quote: "Devis", ocr_invoice: "Factures", ocr_material: "Matériel", report: "Comptes rendus", email: "E-mails" };
  function usageCard(usage) {
    const rows = usage.rows || [];
    const people = new Map();
    for (const r of rows) {
      const p = people.get(r.user_id) || { name: r.name, calls: 0, failures: 0, today: 0, features: [] };
      p.calls += r.calls;
      p.failures += r.failures;
      p.today += r.today;
      p.features.push(`${FEATURE_LABELS[r.feature] || r.feature} ${r.calls}`);
      people.set(r.user_id, p);
    }
    const total = rows.reduce((n, r) => n + r.calls, 0);
    return `<article class="card">
      <div class="ops-card-head"><div><h3>Utilisation de l’IA (30 derniers jours)</h3><p>${total} demande${total > 1 ? "s" : ""}${usage.provider ? " envoyée" + (total > 1 ? "s" : "") + " à " + esc(usage.provider) : ""}. Limite : ${usage.limit ? usage.limit + " demandes par personne et par jour" : "aucune"}. Seuls les nombres sont enregistrés, jamais les questions.</p></div></div>
      ${people.size
        ? `<div class="table"><table><thead><tr><th>Personne</th><th>Aujourd’hui</th><th>30 jours</th><th>Échecs</th><th>Détail</th></tr></thead><tbody>${[...people.values()]
            .sort((a, b) => b.calls - a.calls)
            .map((p) => `<tr><td>${esc(p.name)}</td><td>${p.today}</td><td>${p.calls}</td><td>${p.failures}</td><td><small>${esc(p.features.join(" · "))}</small></td></tr>`)
            .join("")}</tbody></table></div>`
        : '<p class="muted">Aucune demande pour l’instant.</p>'}
    </article>`;
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

  // Where a proposed price comes from, and the supplier purchase price as a hint.
  function priceNote(line) {
    const notes = [];
    if (line.priceSource === "brief") notes.push("prix indiqué dans votre demande");
    else if (line.priceSource) notes.push("prix repris de " + line.priceSource);
    if (line.purchase)
      notes.push(`achat ${line.purchase.vendor} ${line.purchase.reference} : ${money(line.purchase.price)}${line.purchase.unit ? " / " + line.purchase.unit : ""}`);
    return notes.length ? `<small class="p3-price-note">${esc(notes.join(" · "))}</small>` : "";
  }

  function renderQuoteResult(payload) {
    lastQuote = payload;
    const target = document.getElementById("p3QuoteResult");
    if (!target) return;
    const draft = payload?.draft || {};
    const questions = draft.questions || [];
    const withPurchase = (draft.lines || []).some((line) => line.purchase);
    target.innerHTML = `
      <article class="card">
        <div class="ops-card-head"><div><h3>Brouillon proposé</h3><p>${esc(payload.mode === "ai" ? "Préparé par l’IA : relisez chaque ligne. Les prix ne viennent que de votre demande ou de vos anciens devis." : "Préparé localement. Complétez les prix avant création.")}</p></div>${badge(payload.mode === "ai" ? "IA" : "Local", true)}</div>
        ${payload.warning ? `<p class="notice">${esc(payload.warning)}</p>` : ""}
        ${questions.length ? `<div class="notice warning"><b>Informations à vérifier avec le client :</b><ul>${questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul></div>` : ""}
        <div class="form-grid">
          <label>Objet<input id="p3QuoteTitle" value="${esc(draft.title || "")}" maxlength="200"></label>
          <label>Acompte %<input id="p3QuoteDeposit" type="number" min="0" max="100" step="0.1" value="${esc(draft.depositPercent || 0)}"></label>
          <label class="span-2">Objet détaillé<textarea id="p3QuoteScope" rows="3" maxlength="5000">${esc(draft.scope || "")}</textarea></label>
          <label class="span-2">Message<textarea id="p3QuoteMessage" rows="2" maxlength="5000">${esc(draft.message || "")}</textarea></label>
          <label class="span-2">Conditions<textarea id="p3QuoteTerms" rows="2" maxlength="5000">${esc(draft.terms || "")}</textarea></label>
          <label class="span-2">Non compris / options<textarea id="p3QuoteExclusions" rows="2" maxlength="5000">${esc(draft.exclusions || "")}</textarea></label>
        </div>
        ${withPurchase ? `<div class="p3-margin"><label>Marge sur le prix d’achat %<input id="p3QuoteMargin" type="number" min="0" max="500" step="1" value="30"></label>${button("Calculer les prix manquants", "apply-margin")}</div>` : ""}
        <div class="table"><table><thead><tr><th>Prestation</th><th>Qté</th><th>Unité</th><th>Prix unit.</th><th>TVA %</th><th>Remise %</th></tr></thead>
          <tbody id="p3QuoteLines">${(draft.lines || [])
            .map(
              (line, index) => `<tr data-index="${index}" ${line.purchase ? `data-purchase="${esc(line.purchase.price)}"` : ""}>
                <td><input data-field="description" value="${esc(line.description || "")}" maxlength="500"><input data-field="details" value="${esc(line.details || "")}" maxlength="5000" placeholder="Détails">${priceNote(line)}</td>
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

  const mailReady = () => !!window.SGOMailCenter?.status?.()?.configured;
  // The Gmail address of the company the message is about.
  const mailFrom = (kind) => {
    const id = document.getElementById("p3MailTarget")?.value || "";
    const list = kind === "invoice_reminder" ? state().invoices : kind === "quote_followup" ? state().quotes : state().projects;
    const record = (list || []).find((x) => String(x.id) === String(id));
    return window.SGOMailCenter?.addressFor?.(record?.company) || "";
  };
  const canStock = () => ["admin", "direction", "manager"].includes(profile().role);

  function renderOcrResult(payload) {
    lastOcr = payload;
    const target = document.getElementById("p3OcrResult");
    if (!target) return;
    const data = payload?.data || {};
    const match = payload?.match || {};
    if (payload.mode === "supplier_invoice") {
      const supplier = match.supplier || data.supplier || "";
      // The project mentioned on the invoice, if any, is preselected.
      if (match.projectId) {
        const select = document.getElementById("p3OcrProject");
        if (select && [...select.options].some((o) => o.value === match.projectId)) select.value = match.projectId;
      }
      const duplicates = match.duplicates || [];
      target.innerHTML = `<article class="card">
        <h3>Facture fournisseur extraite</h3>
        ${duplicates.length ? `<p class="notice warning"><b>Cette facture semble déjà enregistrée :</b> ${duplicates.map((d) => esc(`${d.supplier} · ${money(d.amount)} · ${swissDate(d.date)}${d.reference ? " · n° " + d.reference : ""}`)).join(" ; ")}. Vérifiez avant de l’enregistrer à nouveau.</p>` : ""}
        <div class="form-grid">
          <label>Fournisseur<input id="p3OcrSupplier" value="${esc(supplier)}"><small class="p3-price-note">${supplier ? (match.knownSupplier ? "Fournisseur déjà connu" : "Nouveau fournisseur") : ""}</small></label>
          <label>N° facture<input id="p3OcrReference" value="${esc(data.invoiceNumber || "")}" maxlength="80"></label>
          <label>Date<input id="p3OcrDate" type="date" value="${esc(data.date || today())}"></label>
          <label>Total CHF<input id="p3OcrTotal" type="number" min="0" step="0.01" value="${esc(data.total ?? "")}"></label>
        </div>
        ${match.projectId ? `<p class="muted">Chantier reconnu sur la facture : <b>${esc(match.projectTitle || match.projectId)}</b> (présélectionné ci-dessus).</p>` : ""}
        ${confidenceNote(data)}
        <div class="form-actions">${canExpense() ? button("Créer la dépense", "create-expense", "primary") : ""}</div>
        ${invoiceItems(data)}
        ${rawDetails(data)}
      </article>`;
    } else {
      const items = Array.isArray(data.items) ? data.items.slice(0, 50) : [];
      const found = match.items || [];
      target.innerHTML = `<article class="card">
        <h3>Matériel reconnu${data.deliveryNumber ? ` · bon ${esc(data.deliveryNumber)}` : ""}</h3>
        ${canStock() && items.length ? '<p class="muted">Cochez les lignes à entrer en stock et vérifiez les quantités. Les articles inconnus seront créés avec la référence indiquée.</p>' : ""}
        <div class="table"><table><thead><tr>${canStock() ? "<th>Entrer</th>" : ""}<th>Désignation</th><th>Référence</th><th>Qté</th><th>Prix</th><th>Dans le stock</th></tr></thead><tbody id="p3StockLines">
          ${items.length
            ? items
                .map((x, i) => {
                  const known = found[i];
                  const ref = x.reference || x.sku || x.ean || "";
                  return `<tr data-index="${i}" ${known ? `data-inventory-id="${esc(known.inventoryId)}"` : ""}>
                    ${canStock() ? `<td><input type="checkbox" data-field="take" ${known ? "checked" : ""} aria-label="Entrer cette ligne en stock"></td>` : ""}
                    <td>${canStock() && !known ? `<input data-field="name" value="${esc(x.description || "")}" maxlength="200">` : esc(x.description || "")}</td>
                    <td>${canStock() && !known ? `<input data-field="sku" value="${esc(ref)}" maxlength="60" placeholder="Référence">` : esc(ref)}</td>
                    <td>${canStock() ? `<input data-field="quantity" type="number" min="0.001" step="0.001" value="${esc(x.quantity ?? 1)}">` : esc(x.quantity ?? "")} ${esc(x.unit || "")}</td>
                    <td>${x.unitPrice == null ? "—" : money(x.unitPrice)}</td>
                    <td>${known ? `${esc(known.name)} <small>(${esc(known.stock)} ${esc(known.unit || "")})</small>` : '<span class="muted">Nouvel article</span>'}</td>
                  </tr>`;
                })
                .join("")
            : '<tr><td colspan="6">Aucun article reconnu.</td></tr>'}
        </tbody></table></div>
        ${confidenceNote(data)}
        ${canStock() && items.length ? `<div class="form-actions">${button("Entrer en stock", "stock-receipt", "primary")}</div>` : ""}
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
            <div id="p3AssistantAnswer" class="ai-rich ops-summary-text">Posez une question pour commencer.</div>
          </article>`;
  }
  function voiceCard(projectId = "") {
    return `
          <article class="card">
            <h3>Compte rendu vocal → texte</h3>
            <p class="muted">Dictez ce qui a été fait, les problèmes et le matériel : l’IA range ensuite le texte dans les bonnes rubriques.</p>
            <div class="form-grid">
              <label>Chantier<select id="p3VoiceProject"><option value="">Choisir…</option>${projectOptions(projectId)}</select></label>
              <label>Date<input id="p3VoiceDate" type="date" value="${today()}"></label>
              <label class="span-2">Compte rendu<textarea id="p3VoiceText" rows="6" placeholder="Le texte dicté apparaîtra ici."></textarea></label>
              <label class="span-2">Fichier audio<input id="p3VoiceFile" type="file" accept="audio/*"></label>
            </div>
            <div class="form-actions">
              ${button("Démarrer la dictée", "dictate")}
              ${aiReady() ? button("Mettre en forme avec l’IA", "structure-report") : ""}
              ${aiStatus?.transcriptionConfigured ? button("Transcrire le fichier", "transcribe") : ""}
              ${button("Enregistrer au chantier", "save-voice-report", "primary")}
            </div>
            <div id="p3VoiceFields" class="form-grid" hidden>
              <label class="span-2">Problèmes / risques<textarea id="p3VoiceIssues" rows="3"></textarea></label>
              <label class="span-2">Matériel<textarea id="p3VoiceMaterials" rows="2"></textarea></label>
              <label>Équipe présente<input id="p3VoiceTeam" maxlength="1000"></label>
              <label>Météo<input id="p3VoiceWeather" maxlength="200"></label>
            </div>
          </article>`;
  }
  const LANGUAGE_OPTIONS = '<option value="fr">Français</option><option value="de">Allemand</option><option value="it">Italien</option><option value="en">Anglais</option>';
  function quoteCard() {
    const d = defaults();
    return `
        <article class="card">
          <h3>Création de devis assistée</h3>
          <p class="muted">Décrivez les travaux : l’IA propose les lignes, reprend vos prix déjà pratiqués et affiche les prix d’achat de vos catalogues fournisseurs.</p>
          <div class="form-grid">
            <label>Entreprise<select id="p3QuoteCompany">${companyOptions(d.company)}</select></label>
            <label>Client<select id="p3QuoteClient">${clientOptions(d.client)}</select></label>
            <label>Chantier (facultatif)<select id="p3QuoteProject"><option value="">Aucun</option>${projectOptions()}</select></label>
            <label>TVA %<input id="p3QuoteVat" type="number" min="0" max="100" step="0.1" value="8.1"></label>
            <label>Langue du devis<select id="p3QuoteLanguage">${LANGUAGE_OPTIONS}</select></label>
            <label>Objet<input id="p3QuoteRequestedTitle" maxlength="200" placeholder="Ex. Mise en conformité électrique"></label>
            <label class="span-2">Description des travaux<textarea id="p3QuoteBrief" rows="5" placeholder="Ex. Poser 3 prises T13 encastrées et 1 interrupteur dans le salon, tirer 15 m de câble. Prise à 85.- comme d’habitude."></textarea></label>
          </div>
          <div class="form-actions">${button("Préparer le devis", "quote-draft", "primary")}</div>
        </article>`;
  }
  function ocrCard(mode = "supplier_invoice", providerConfigured = true) {
    const d = defaults();
    return `
          <article class="card">
            <h3>${mode === "material" ? "Matériel ou bon de livraison" : "Lecture de facture fournisseur"}</h3>
            <div class="form-grid">
              <label>Type<select id="p3OcrMode"><option value="supplier_invoice" ${mode === "supplier_invoice" ? "selected" : ""}>Facture fournisseur</option><option value="material" ${mode === "material" ? "selected" : ""}>Matériel / bon de livraison</option></select></label>
              <label>Photos ou PDF<input id="p3OcrFile" type="file" accept="image/*,application/pdf,.pdf" multiple></label>
              <label>Entreprise<select id="p3OcrCompany">${companyOptions(d.company)}</select></label>
              <label>Chantier (facultatif)<select id="p3OcrProject"><option value="">Aucun</option>${projectOptions()}</select></label>
            </div>
            <p class="muted">Une photo bien à plat, plusieurs photos d’un même document ou un PDF (4 pages au maximum). Les images sont réduites automatiquement avant l’envoi.</p>
            <div class="form-actions">${button("Lire le document", "ocr", "primary")}</div>
            ${!providerConfigured ? '<p class="muted">Le module est prêt, mais la lecture OCR nécessite AI_API_URL + AI_API_KEY côté serveur.</p>' : ""}
          </article>`;
  }
  function emailCard(options = {}) {
    const kind = options.kind || "invoice_reminder";
    return `
          <article class="card">
            <h3>Rédiger un e-mail au client</h3>
            <p class="muted">L’IA prépare le texte à partir des montants et dates de l’application. Vous le relisez, puis l’envoyez depuis votre messagerie.</p>
            <div class="form-grid">
              <label>Message<select id="p3MailKind">
                ${canFinance() ? `<option value="invoice_reminder" ${kind === "invoice_reminder" ? "selected" : ""}>Relance de facture</option><option value="quote_followup" ${kind === "quote_followup" ? "selected" : ""}>Suivi de devis</option>` : ""}
                <option value="project_update" ${kind === "project_update" ? "selected" : ""}>Avancement du chantier</option>
              </select></label>
              <label>Concerne<select id="p3MailTarget">${mailTargets(canFinance() ? kind : "project_update", options.id)}</select></label>
              <label>Ton<select id="p3MailTone"><option value="cordial">Cordial</option><option value="ferme">Ferme</option></select></label>
              <label>Langue<select id="p3MailLanguage">${LANGUAGE_OPTIONS}</select></label>
              <label class="span-2">Précisions (facultatif)<textarea id="p3MailNotes" rows="2" maxlength="2000" placeholder="Ex. proposer un paiement en deux fois"></textarea></label>
            </div>
            <div class="form-actions">${button("Rédiger", "email-draft", "primary")}</div>
            <div id="p3MailResult"></div>
          </article>`;
  }
  // The records an e-mail can be about: unpaid invoices, quotes waiting for an answer, open projects.
  function mailTargets(kind, selected = "") {
    const s = state();
    const client = (id) => (s.clients || []).find((c) => String(c.id) === String(id))?.name || "";
    const option = (id, label) => `<option value="${esc(id)}" ${String(id) === String(selected) ? "selected" : ""}>${esc(label)}</option>`;
    let rows = [];
    if (kind === "invoice_reminder")
      rows = (s.invoices || [])
        .filter((i) => i.status !== "Brouillon" && (Number(i.amount) || 0) > (Number(i.paid) || 0))
        .sort((a, b) => String(a.due).localeCompare(String(b.due)))
        .map((i) => option(i.id, `${i.id} · ${client(i.clientId)} · reste ${money((Number(i.amount) || 0) - (Number(i.paid) || 0))}${i.due && i.due < today() ? " · en retard" : ""}`));
    else if (kind === "quote_followup")
      rows = (s.quotes || [])
        .filter((q) => !["Accepté", "Refusé", "Brouillon"].includes(q.status))
        .map((q) => option(q.id, `${q.id} · ${client(q.clientId)} · ${q.title || ""}`));
    else
      rows = (s.projects || [])
        .filter((p) => !["Terminé", "Archivé"].includes(p.status))
        .map((p) => option(p.id, `${p.title || p.id} · ${client(p.clientId)}`));
    return rows.join("") || '<option value="">Aucun élément concerné</option>';
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
      const admin = ["admin", "direction"].includes(profile().role);
      const [status, workload, anomalyPayload, usage] = await Promise.all([
        api("status"),
        api("workload?weeks=4"),
        api("anomalies"),
        admin ? api("usage").catch(() => null) : null,
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
        ${status.providerConfigured && (canFinance() || canPlan()) ? emailCard({ kind: canFinance() ? "invoice_reminder" : "project_update" }) : ""}

        ${workloadTable(workload)}
        ${anomaliesCard(anomalyPayload.anomalies || [])}
        ${usage ? usageCard(usage) : ""}
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

  // The e-mail target list follows the chosen kind of message.
  document.addEventListener("change", (event) => {
    if (event.target?.id !== "p3MailKind") return;
    const target = document.getElementById("p3MailTarget");
    if (target) target.innerHTML = mailTargets(event.target.value);
  });

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
        const out = await api("assistant", { question, projectId, page: "Pilotage – Assistant intelligent" });
        target.innerHTML = richText(out.answer || "Aucune réponse.");
      } else if (action === "quote-draft") {
        if (!canFinance()) return core().toast("Accès devis non autorisé.");
        const out = await api("quote-draft", {
          company: document.getElementById("p3QuoteCompany")?.value || "",
          clientId: document.getElementById("p3QuoteClient")?.value || "",
          projectId: document.getElementById("p3QuoteProject")?.value || "",
          title: document.getElementById("p3QuoteRequestedTitle")?.value || "",
          brief: document.getElementById("p3QuoteBrief")?.value || "",
          vatRate: Number(document.getElementById("p3QuoteVat")?.value || 0),
          language: document.getElementById("p3QuoteLanguage")?.value || "fr",
        });
        renderQuoteResult(out);
      } else if (action === "apply-margin") {
        const margin = Number(document.getElementById("p3QuoteMargin")?.value);
        if (!Number.isFinite(margin) || margin < 0) return core().toast("Indiquez une marge valide.");
        let filled = 0;
        for (const row of document.querySelectorAll("#p3QuoteLines tr[data-purchase]")) {
          const price = row.querySelector('[data-field="unitPrice"]');
          if (Number(price.value) > 0) continue;
          price.value = (Math.round(Number(row.dataset.purchase) * (1 + margin / 100) * 20) / 20).toFixed(2);
          filled += 1;
        }
        core().toast(filled ? `${filled} prix calculé${filled > 1 ? "s" : ""} à partir du prix d’achat.` : "Aucun prix manquant avec prix d’achat connu.");
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
            language: lastQuote.language || "fr",
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
        const files = [...(document.getElementById("p3OcrFile")?.files || [])];
        if (!files.length) return core().toast("Choisissez une photo, plusieurs photos ou un PDF.");
        const label = buttonNode.textContent;
        buttonNode.disabled = true;
        buttonNode.textContent = "Préparation du document…";
        try {
          const images = await documentPages(files);
          buttonNode.textContent = images.length > 1 ? `Lecture des ${images.length} pages…` : "Lecture en cours…";
          const out = await api("ocr", {
            mode: document.getElementById("p3OcrMode")?.value || "supplier_invoice",
            images,
          });
          renderOcrResult(out);
        } finally {
          buttonNode.disabled = false;
          buttonNode.textContent = label;
        }
      } else if (action === "stock-receipt") {
        if (!lastOcr || lastOcr.mode !== "material") return;
        const lines = [], create = [];
        for (const row of document.querySelectorAll("#p3StockLines tr[data-index]")) {
          if (!row.querySelector('[data-field="take"]')?.checked) continue;
          const quantity = Number(row.querySelector('[data-field="quantity"]')?.value);
          if (!(quantity > 0)) return core().toast("Vérifiez les quantités cochées.");
          if (row.dataset.inventoryId) lines.push({ inventoryId: row.dataset.inventoryId, quantity });
          else {
            const sku = row.querySelector('[data-field="sku"]')?.value.trim() || "";
            const name = row.querySelector('[data-field="name"]')?.value.trim() || "";
            if (!sku || !name) return core().toast("Indiquez la désignation et la référence des nouveaux articles.");
            const item = (lastOcr.data?.items || [])[Number(row.dataset.index)] || {};
            create.push({ sku, name, quantity, unit: item.unit || "pce", buy: Number(item.unitPrice) || 0 });
          }
        }
        if (!lines.length && !create.length) return core().toast("Cochez au moins une ligne.");
        buttonNode.disabled = true;
        try {
          const out = await api("stock-receipt", {
            company: document.getElementById("p3OcrCompany")?.value || "",
            deliveryNumber: lastOcr.data?.deliveryNumber || "",
            lines,
            create,
          });
          await core().refresh();
          const count = (out.updated || []).length + (out.created || []).length;
          core().toast(`${count} article${count > 1 ? "s" : ""} entré${count > 1 ? "s" : ""} en stock.`);
          document.getElementById("p3OcrResult").innerHTML = `<article class="card"><h3>Stock mis à jour</h3><ul>${[...(out.updated || []), ...(out.created || []).map((x) => ({ ...x, created: true }))]
            .map((x) => `<li><b>${esc(x.name)}</b> : +${esc(x.quantity)} → ${esc(x.stock)} en stock${x.created ? " (nouvel article)" : ""}</li>`)
            .join("")}</ul></article>`;
        } finally {
          buttonNode.disabled = false;
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
            reference: document.getElementById("p3OcrReference")?.value.trim() || "",
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
      } else if (action === "structure-report") {
        const field = document.getElementById("p3VoiceText");
        if (!field?.value.trim()) return core().toast("Dictez ou écrivez d’abord le compte rendu.");
        if (recognition) {
          recognition.stop();
          recognition = null;
        }
        const label = buttonNode.textContent;
        buttonNode.disabled = true;
        buttonNode.textContent = "Mise en forme…";
        try {
          const out = await api("report-structure", { text: field.value });
          field.value = out.summary || field.value;
          const set = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.value = value || "";
          };
          set("p3VoiceIssues", out.issues);
          set("p3VoiceMaterials", out.materials);
          set("p3VoiceTeam", out.team);
          set("p3VoiceWeather", out.weather);
          const fields = document.getElementById("p3VoiceFields");
          if (fields) fields.hidden = false;
          core().toast("Compte rendu mis en forme : relisez avant d’enregistrer.");
        } finally {
          buttonNode.disabled = false;
          buttonNode.textContent = label;
        }
      } else if (action === "save-voice-report") {
        const projectId = document.getElementById("p3VoiceProject")?.value || "";
        const text = document.getElementById("p3VoiceText")?.value || "";
        if (!projectId || !text.trim())
          return core().toast("Choisissez un chantier et ajoutez un compte rendu.");
        const value = (id) => document.getElementById(id)?.value.trim() || "";
        await core().api("operations/project/" + encodeURIComponent(projectId) + "/report", {
          reportDate: document.getElementById("p3VoiceDate")?.value || today(),
          weather: value("p3VoiceWeather"),
          summary: text.trim(),
          issues: value("p3VoiceIssues"),
          materials: value("p3VoiceMaterials"),
          team: value("p3VoiceTeam"),
        });
        core().toast("Compte rendu enregistré sur le chantier.");
      } else if (action === "email-draft") {
        const id = document.getElementById("p3MailTarget")?.value || "";
        if (!id) return core().toast("Choisissez la facture, le devis ou le chantier concerné.");
        const label = buttonNode.textContent;
        buttonNode.disabled = true;
        buttonNode.textContent = "Rédaction…";
        const kind = document.getElementById("p3MailKind")?.value || "";
        await window.SGOMailCenter?.loadStatus?.();
        try {
          const out = await api("email-draft", {
            kind,
            id,
            tone: document.getElementById("p3MailTone")?.value || "cordial",
            language: document.getElementById("p3MailLanguage")?.value || "fr",
            notes: document.getElementById("p3MailNotes")?.value || "",
          });
          document.getElementById("p3MailResult").innerHTML = `<div class="p3-mail">
            <div class="form-grid">
              <label>Destinataire<input id="p3MailTo" type="email" value="${esc(out.to || "")}" placeholder="Adresse e-mail du client"></label>
              <label>Objet<input id="p3MailSubject" value="${esc(out.subject || "")}" maxlength="200"></label>
              <label class="span-2">Texte<textarea id="p3MailBody" rows="12">${esc(out.body || "")}</textarea></label>
            </div>
            ${mailReady() && kind !== "project_update" ? `<label class="mail-check"><input type="checkbox" id="p3MailAttach" checked> Joindre ${kind === "invoice_reminder" ? "la facture (PDF avec bulletin QR)" : "le devis (PDF)"}</label>` : ""}
            <div class="form-actions">${button("Copier le texte", "copy-mail")}${mailReady() ? button("Ouvrir dans ma messagerie", "open-mail") + button("Envoyer", "send-mail", "primary") : button("Ouvrir dans ma messagerie", "open-mail", "primary")}</div>
            ${mailReady() && mailFrom(kind) ? `<p class="muted">Envoyé depuis ${esc(mailFrom(kind))}.</p>` : ""}
          </div>`;
        } finally {
          buttonNode.disabled = false;
          buttonNode.textContent = label;
        }
      } else if (action === "send-mail") {
        const to = document.getElementById("p3MailTo")?.value.trim() || "";
        if (!to) return core().toast("Indiquez l’adresse e-mail du client.");
        if (!confirm(`Envoyer cet e-mail à ${to} ?`)) return;
        buttonNode.disabled = true;
        try {
          const out = await core().api("mail/client-message", {
            kind: document.getElementById("p3MailKind")?.value || "",
            id: document.getElementById("p3MailTarget")?.value || "",
            to,
            subject: document.getElementById("p3MailSubject")?.value || "",
            body: document.getElementById("p3MailBody")?.value || "",
            attach: document.getElementById("p3MailAttach")?.checked !== false,
          });
          document.getElementById("p3MailResult").innerHTML = `<p class="notice">E-mail envoyé à ${esc(out.to)}${out.attached ? " avec le document en pièce jointe" : ""}.</p>`;
          core().toast("E-mail envoyé.");
        } finally {
          buttonNode.disabled = false;
        }
      } else if (action === "copy-mail") {
        const text = (document.getElementById("p3MailSubject")?.value || "") + "\n\n" + (document.getElementById("p3MailBody")?.value || "");
        await copyText(text);
      } else if (action === "open-mail") {
        const to = document.getElementById("p3MailTo")?.value.trim() || "";
        const subject = document.getElementById("p3MailSubject")?.value || "";
        const body = document.getElementById("p3MailBody")?.value || "";
        // mailto links are limited in length by some e-mail programs.
        const link = "mailto:" + encodeURIComponent(to) + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body.slice(0, 1800));
        window.location.href = link;
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
  async function readImage(file, maxSide = 2000) {
    if (!/^image\//.test(file.type || "") && !/\.(heic|heif)$/i.test(file.name || ""))
      throw new Error("Choisissez des photos ou un PDF.");
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
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

  // PDF invoices are turned into page images in the browser (pdf.js, loaded only when needed),
  // so any AI provider able to read photos can read them.
  let pdfLibrary = null;
  async function openPdf(file) {
    if (file.size > 20 * 1024 * 1024) throw new Error("PDF trop volumineux (20 Mo max).");
    if (!pdfLibrary) {
      pdfLibrary = await import("/vendor/pdfjs/pdf.min.mjs");
      pdfLibrary.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
    }
    const task = pdfLibrary.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, enableXfa: false });
    try {
      return { task, doc: await task.promise };
    } catch (error) {
      task.destroy?.();
      throw new Error(error?.name === "PasswordException" ? "Ce PDF est protégé par un mot de passe." : "Ce PDF ne peut pas être ouvert.");
    }
  }
  async function renderPdfPages(doc, max, maxSide) {
    const pages = [];
    for (let n = 1; n <= Math.min(doc.numPages, max); n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(3, maxSide / Math.max(base.width, base.height)) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvas, viewport, background: "#ffffff" }).promise;
      pages.push(canvas.toDataURL("image/jpeg", 0.85));
      page.cleanup();
    }
    return pages;
  }
  async function pdfPages(file, max, maxSide) {
    const { task, doc } = await openPdf(file);
    try {
      if (doc.numPages > max) core().toast(`Seules les ${max} premières pages du PDF sont lues.`);
      return await renderPdfPages(doc, max, maxSide);
    } finally {
      // Frees the PDF worker and its memory.
      task.destroy?.();
    }
  }
  // Documents: the text of the PDF when it has one (cheap, and long contracts fit), otherwise
  // the first pages as images (scanned documents).
  async function pdfContent(file) {
    const { task, doc } = await openPdf(file);
    try {
      const parts = [];
      const max = Math.min(doc.numPages, 40);
      for (let n = 1; n <= max; n++) {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        parts.push(`--- Page ${n} ---\n` + content.items.map((i) => (i.str || "") + (i.hasEOL ? "\n" : " ")).join("").replace(/[ \t]+/g, " ").trim());
        page.cleanup();
      }
      const text = parts.join("\n\n");
      const letters = text.replace(/--- Page \d+ ---|\s/g, "").length;
      if (letters >= max * 80) return { text: text.slice(0, 80000), pages: doc.numPages };
      return { images: await renderPdfPages(doc, 6, 1500), pages: doc.numPages };
    } finally {
      task.destroy?.();
    }
  }

  async function documentPages(files) {
    const MAX = 4;
    const pdfCount = files.filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name || "")).length;
    const maxSide = files.length > 1 || pdfCount ? 1700 : 2000;
    const pages = [];
    for (const file of files) {
      if (pages.length >= MAX) break;
      if (file.type === "application/pdf" || /\.pdf$/i.test(file.name || "")) pages.push(...(await pdfPages(file, MAX - pages.length, maxSide)));
      else pages.push(await readImage(file, maxSide));
    }
    if (files.length > MAX && pages.length >= MAX) core().toast(`Seules les ${MAX} premières pages sont lues.`);
    if (!pages.length) throw new Error("Aucune page lisible.");
    return pages;
  }

  // AI answers: a small, safe subset of Markdown (bold, lists, line breaks) and references
  // such as [[F-2026-0004]] turned into buttons that open the record.
  function referenceButton(id) {
    const s = state();
    const project = (s.projects || []).find((p) => String(p.id) === id);
    const kind = project ? "project" : (s.invoices || []).some((x) => String(x.id) === id) ? "invoice" : (s.quotes || []).some((x) => String(x.id) === id) ? "quote" : "";
    if (!kind) return esc(id);
    const label = project ? project.title || id : id;
    return `<button type="button" class="ai-ref" data-p3-ref="${kind}" data-id="${esc(id)}" title="Ouvrir ${esc(id)}">${esc(label)}</button>`;
  }
  function inline(text) {
    const refs = [];
    let out = String(text).replace(/\u0000/g, "").replace(/\[\[([A-Za-z0-9][A-Za-z0-9_.\-]{0,79})\]\]/g, (_, id) => {
      refs.push(id);
      return "\u0000" + (refs.length - 1) + "\u0000";
    });
    out = esc(out)
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, "$1<i>$2</i>")
      .replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,;:!?]|$)/g, "$1<i>$2</i>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
    return out.replace(/\u0000(\d+)\u0000/g, (_, i) => referenceButton(refs[Number(i)]));
  }
  function richText(text) {
    const lines = String(text || "").replace(/\r/g, "").split("\n");
    const html = [];
    let list = null;
    const close = () => {
      if (list) html.push(`</${list}>`);
      list = null;
    };
    for (const raw of lines) {
      const line = raw.trim();
      const bullet = line.match(/^[-*•]\s+(.*)$/);
      const numbered = line.match(/^\d+[.)]\s+(.*)$/);
      if (bullet || numbered) {
        const kind = bullet ? "ul" : "ol";
        if (list !== kind) {
          close();
          html.push(`<${kind}>`);
          list = kind;
        }
        html.push(`<li>${inline((bullet || numbered)[1])}</li>`);
        continue;
      }
      close();
      if (!line) continue;
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      html.push(`<p>${heading ? `<b>${inline(heading[1])}</b>` : inline(line)}</p>`);
    }
    close();
    return html.join("");
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      document.execCommand?.("copy");
      area.remove();
    }
    core().toast("Texte copié.");
  }

  const TOOLS = {
    "ocr-invoice": { title: "Lire une facture fournisseur", icon: "camera", label: "Lire une facture", field: "p3OcrFile", allowed: () => canExpense() && aiReady(), html: () => ocrCard("supplier_invoice") + '<div id="p3OcrResult"></div>' },
    "ocr-material": { title: "Matériel et bons de livraison", icon: "camera", label: "Lire un bon de livraison", field: "p3OcrFile", allowed: () => aiReady(), html: () => ocrCard("material") + '<div id="p3OcrResult"></div>' },
    quote: { title: "Devis avec l’IA", icon: "sparkle", label: "Devis avec l’IA", field: "p3QuoteBrief", allowed: () => canFinance() && aiReady(), html: () => quoteCard() + '<div id="p3QuoteResult"></div>' },
    email: { title: "E-mail au client", icon: "mail", label: "E-mail au client", field: "p3MailKind", allowed: () => aiReady() && (canFinance() || canPlan()), html: (o) => emailCard(o) },
    voice: { title: "Compte rendu vocal", icon: "mic", label: "Compte rendu vocal", field: "p3VoiceText", allowed: () => !isClient(), html: (o) => voiceCard(o.projectId || "") },
    planning: { title: "Proposer l’équipe", icon: "users", label: "Proposer l’équipe", field: "p3PlanProject", allowed: () => canSuggestPlanning(), html: () => planningCard() + '<div id="p3PlanningResult"></div>' },
  };
  // Contextual buttons, added next to the page's own actions.
  const PAGE_TOOLS = {
    expenses: { tool: "ocr-invoice" },
    quotes: { tool: "quote" },
    inventory: { tool: "ocr-material" },
    planning: { tool: "planning" },
    invoices: { tool: "email", label: "Relance par e-mail", kind: "invoice_reminder" },
  };

  function openTool(name, options = {}) {
    const tool = TOOLS[name];
    if (!tool) return;
    if (!tool.allowed()) return core().toast("Cet outil n’est pas disponible pour votre compte.");
    closePanel();
    // The full assistant page already holds the same forms: point to it instead of duplicating ids.
    const existing = document.querySelector("#content #" + tool.field);
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
            ${ttsSupported() ? `<button type="button" class="ai-icon-btn" data-p3-panel="voice-mode" title="Conversation vocale : les réponses sont lues à voix haute" aria-label="Conversation vocale" aria-pressed="false">${ic("speaker")}</button>` : ""}
            <button type="button" class="ai-icon-btn" data-p3-panel="clear" title="Nouvelle discussion" aria-label="Nouvelle discussion">${ic("refresh")}</button>
            <button type="button" class="ai-icon-btn" data-p3-panel="close" title="Fermer" aria-label="Fermer l’assistant">${ic("x")}</button>
          </div>
        </header>
        <div id="aiTools" class="ai-tools" aria-label="Outils"></div>
        <div id="aiMessages" class="ai-messages" aria-live="polite"></div>
        <div id="aiSuggestions" class="ai-suggestions"></div>
        <form id="aiComposer" class="ai-composer">
          <textarea id="aiQuestion" rows="2" maxlength="2500" placeholder="Posez une question ou demandez une action…" aria-label="Votre question"></textarea>
          ${speechSupported() ? `<button type="button" class="ai-mic" data-p3-panel="mic" aria-label="Poser la question à voix haute" title="Poser la question à voix haute" aria-pressed="false">${ic("mic")}</button>` : ""}
          <button type="submit" class="ai-send" aria-label="Envoyer">${ic("send")}</button>
        </form>
        <p id="aiFootnote" class="ai-footnote"></p>
      </aside>`,
    );
    return document.getElementById("aiPanel");
  }

  // ----- Actions proposed by the AI, carried out only once the person confirms -----
  const ACTION_TITLES = {
    "task.create": "Nouvelle tâche",
    "punch.create": "Nouvelle réserve",
    "report.create": "Compte rendu de chantier",
    "time.add": "Heures travaillées",
    "planning.create": "Affectation au planning",
    "absence.request": "Demande d’absence",
  };
  const ABSENCE_TYPES = ["Vacances", "Maladie", "Autre"];
  const PRIORITY = { low: "Basse", normal: "Normale", high: "Haute", urgent: "Urgente", critical: "Critique" };
  const ACTION_BLOCK = /```action\s*([\s\S]*?)```/g;
  // The text shown to the person: action blocks are replaced by their confirmation cards
  // (an unfinished block, while the answer is still arriving, is hidden too).
  const visibleText = (text) => String(text || "").replace(ACTION_BLOCK, "").replace(/```action[\s\S]*$/, "").trim();
  function parseActions(text) {
    const actions = [];
    for (const match of String(text || "").matchAll(ACTION_BLOCK)) {
      try {
        const a = JSON.parse(match[1]);
        if (a && ACTION_TITLES[a.type] && actions.length < 3) actions.push({ ...a, status: "pending" });
      } catch {
        // A malformed block is ignored rather than guessed.
      }
    }
    return actions;
  }
  const projectOf = (id) => (state().projects || []).find((p) => String(p.id) === String(id));
  const employeeOf = (id) => (state().employees || []).find((e) => String(e.id) === String(id));
  function describeAction(a) {
    const rows = [];
    const project = a.projectId ? projectOf(a.projectId) : null;
    const missing = [];
    const need = (value, label) => {
      if (value == null || String(value).trim() === "") missing.push(label);
    };
    if (["task.create", "punch.create", "report.create", "time.add", "planning.create"].includes(a.type)) {
      if (!project) missing.push("chantier");
      else rows.push(["Chantier", project.title || project.id]);
    }
    if (a.type === "task.create" || a.type === "punch.create") {
      need(a.title, "titre");
      rows.push([a.type === "task.create" ? "Tâche" : "Réserve", a.title || "—"]);
      if (a.dueDate) rows.push(["Échéance", swissDate(a.dueDate)]);
      const level = a.priority || a.severity;
      if (level) rows.push([a.type === "task.create" ? "Priorité" : "Gravité", PRIORITY[level] || level]);
      if (a.assigneeId) rows.push(["Responsable", employeeOf(a.assigneeId)?.name || a.assigneeId]);
    } else if (a.type === "report.create") {
      need(a.summary, "résumé");
      rows.push(["Date", swissDate(a.date || today())], ["Résumé", a.summary || "—"]);
      if (a.issues) rows.push(["Problèmes", a.issues]);
    } else if (a.type === "time.add") {
      if (!a.employeeId && !profile().employee_id) missing.push("salarié");
      need(a.date, "date");
      need(a.start, "début");
      need(a.end, "fin");
      if (a.employeeId) rows.push(["Salarié", employeeOf(a.employeeId)?.name || a.employeeId]);
      rows.push(["Date", swissDate(a.date)], ["Horaire", `${a.start || "?"} – ${a.end || "?"}${Number(a.break) ? ` (pause ${Number(a.break)} min)` : ""}`]);
      if (a.note) rows.push(["Commentaire", a.note]);
    } else if (a.type === "planning.create") {
      need(a.employeeId, "salarié");
      need(a.date, "date");
      rows.push(["Salarié", employeeOf(a.employeeId)?.name || a.employeeId || "—"], ["Date", swissDate(a.date)], ["Horaire", `${a.start || "?"} – ${a.end || "?"}`]);
      need(a.start, "début");
      need(a.end, "fin");
    } else if (a.type === "absence.request") {
      if (!a.employeeId && !profile().employee_id) missing.push("salarié");
      need(a.from, "début");
      need(a.to, "fin");
      if (a.employeeId) rows.push(["Salarié", employeeOf(a.employeeId)?.name || a.employeeId]);
      rows.push(["Type", ABSENCE_TYPES.includes(a.absenceType) ? a.absenceType : "Vacances"]);
      rows.push(["Période", `du ${swissDate(a.from)} au ${swissDate(a.to)}`]);
    }
    return { title: ACTION_TITLES[a.type], rows, missing };
  }
  async function executeAction(a) {
    const me = profile();
    const enc = encodeURIComponent;
    if (a.type === "task.create")
      return core().api("operations/tasks", { projectId: a.projectId, title: a.title, priority: a.priority || "normal", dueDate: a.dueDate || null, assignedEmployeeId: a.assigneeId || null, status: "todo" });
    if (a.type === "punch.create")
      return core().api("operations/project/" + enc(a.projectId) + "/punch", { title: a.title, severity: a.severity || "normal", dueDate: a.dueDate || null });
    if (a.type === "report.create")
      return core().api("operations/project/" + enc(a.projectId) + "/report", { reportDate: a.date || today(), summary: a.summary, issues: a.issues || "", weather: "", materials: "", team: "" });
    if (a.type === "time.add")
      return core().command("time.add", { employeeId: a.employeeId || me.employee_id, project: a.projectId, date: a.date, start: a.start, end: a.end, break: Number(a.break || 0), note: a.note || "" });
    if (a.type === "planning.create")
      return core().command("create", { employeeId: a.employeeId, project: a.projectId, date: a.date, start: a.start, end: a.end, location: projectOf(a.projectId)?.address || "" }, "planning");
    if (a.type === "absence.request")
      return core().command("absence.request", { employeeId: a.employeeId || me.employee_id, from: a.from, to: a.to, type: ABSENCE_TYPES.includes(a.absenceType) ? a.absenceType : "Vacances", comment: a.comment || "" });
    throw new Error("Action inconnue.");
  }
  function actionCard(a, msgIndex, actionIndex) {
    const d = describeAction(a);
    const ids = `data-msg="${msgIndex}" data-act="${actionIndex}"`;
    let footer;
    if (a.status === "done") footer = `<p class="ai-action-state ok">${ic("check")}<span>Enregistré</span></p>`;
    else if (a.status === "cancelled") footer = '<p class="ai-action-state">Annulé</p>';
    else if (a.status === "running") footer = '<p class="ai-action-state">Enregistrement…</p>';
    else if (d.missing.length) footer = `<p class="ai-action-state warn">Information manquante : ${esc(d.missing.join(", "))}. Précisez-la dans votre message.</p>`;
    else
      footer = `${a.status === "error" ? `<p class="ai-action-state warn">${esc(a.error || "Enregistrement impossible.")}</p>` : ""}<div class="ai-action-buttons"><button type="button" class="btn primary" data-p3-act="confirm" ${ids}>${a.status === "error" ? "Réessayer" : "Confirmer"}</button><button type="button" class="btn secondary" data-p3-act="cancel" ${ids}>Annuler</button></div>`;
    return `<div class="ai-action-card"><b>${esc(d.title)}</b><dl>${d.rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>${footer}</div>`;
  }

  // ----- Reading answers aloud (the browser's own voices, no extra service) -----
  const ttsSupported = () => typeof window !== "undefined" && "speechSynthesis" in window && typeof window.SpeechSynthesisUtterance === "function";
  let speaking = null,
    voiceMode = false;
  try {
    voiceMode = localStorage.getItem("sgo_ai_voice") === "1";
  } catch {
    voiceMode = false;
  }
  function speechLanguage(text) {
    const t = " " + String(text).toLowerCase() + " ";
    const score = (words) => words.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
    const scores = {
      "pt-PT": score([" não ", " você", "ção ", " está ", " obrigado", " são ", " uma ", " para o "]),
      "de-CH": score([" und ", " der ", " die ", " ist ", " nicht ", " mit ", " für "]),
      "it-CH": score([" che ", " della ", " sono ", " non ", " per il ", " è ", " gli "]),
      "en-GB": score([" the ", " and ", " is ", " are ", " with ", " you "]),
      "fr-CH": score([" le ", " la ", " les ", " des ", " est ", " et ", " pour ", " vous "]),
    };
    return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
  }
  function pickVoice(lang) {
    const voices = window.speechSynthesis.getVoices?.() || [];
    const base = lang.slice(0, 2);
    return voices.find((v) => v.lang === lang) || voices.find((v) => v.lang?.startsWith(base + "-CH")) || voices.find((v) => v.lang?.startsWith(base)) || null;
  }
  function speechText(text) {
    return visibleText(text)
      .replace(/\[\[([^\]]+)\]\]/g, (_, id) => projectOf(id)?.title || id)
      .replace(/\*\*|`|_/g, "")
      .replace(/CHF\s?([\d']+)\.(\d{2})/g, (_, a, b) => `${a.replace(/'/g, " ")} francs${b !== "00" ? " " + b : ""}`)
      .replace(/^[-*•]\s+/gm, "")
      .trim();
  }
  function stopSpeaking() {
    if (!ttsSupported()) return;
    speaking = null;
    window.speechSynthesis.cancel();
    refreshSpeakButtons();
  }
  function speak(text, key, onEnd) {
    if (!ttsSupported()) return;
    window.speechSynthesis.cancel();
    const clean = speechText(text);
    if (!clean) return;
    const lang = speechLanguage(clean);
    const voice = pickVoice(lang);
    // Long texts are read sentence by sentence: some browsers stop a single long utterance.
    const chunks = clean.match(/[^.!?\n]+[.!?]*\s*|\n+/g)?.map((c) => c.trim()).filter(Boolean) || [clean];
    const token = {};
    speaking = { key, token };
    chunks.forEach((chunk, i) => {
      const u = new window.SpeechSynthesisUtterance(chunk);
      u.lang = voice?.lang || lang;
      if (voice) u.voice = voice;
      u.rate = 1.03;
      if (i === chunks.length - 1)
        u.onend = () => {
          if (speaking?.token !== token) return;
          speaking = null;
          refreshSpeakButtons();
          onEnd?.();
        };
      window.speechSynthesis.speak(u);
    });
    refreshSpeakButtons();
  }
  function refreshSpeakButtons() {
    for (const b of document.querySelectorAll("[data-p3-speak]")) {
      const active = speaking?.key === b.dataset.p3Speak;
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", String(active));
      b.title = active ? "Arrêter la lecture" : "Écouter";
    }
  }
  function speakButton(key) {
    return ttsSupported() ? `<button type="button" class="ai-tool-btn" data-p3-speak="${esc(key)}" title="Écouter" aria-label="Écouter" aria-pressed="false">${ic("speaker")}</button>` : "";
  }

  function messageHtml(m, i) {
    if (m.role === "user") return `<div class="ai-msg ai-user"><p>${esc(m.text)}</p></div>`;
    if (m.role === "error")
      return `<div class="ai-msg ai-error"><p>${esc(m.text)}</p>${i === chat.length - 1 ? '<button type="button" class="btn secondary" data-p3-panel="retry">Réessayer</button>' : ""}</div>`;
    const text = visibleText(m.text);
    const body = text ? richText(text) : m.streaming ? "<p class=\"ai-wait\">L’assistant réfléchit…</p>" : "";
    const cards = (m.actions || []).map((a, k) => actionCard(a, i, k)).join("");
    const tools = m.streaming ? "" : `<div class="ai-msg-tools">${speakButton("chat:" + i)}<button type="button" class="ai-tool-btn" data-p3-copy="${i}" title="Copier la réponse" aria-label="Copier la réponse">${ic("copy")}</button></div>`;
    return `<div class="ai-msg ai-answer${m.streaming ? " ai-streaming" : ""}" data-index="${i}"><div class="ai-rich">${body}</div>${cards}${tools}</div>`;
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
      ? chat.map(messageHtml).join("")
      : `<div class="ai-welcome"><p><b>Bonjour ${esc((profile().name || "").split(" ")[0] || "")} !</b></p><p>Posez une question sur vos chantiers, factures, planning ou stock, ou demandez une action : « Ajoute une tâche… », « J’ai travaillé de 7 h à 16 h hier sur… ». Vous confirmez toujours avant l’enregistrement.</p>${aiReady() ? "" : '<p class="muted">L’IA externe n’est pas configurée : les réponses sont des résumés simples calculés par l’application.</p>'}</div>`;
    messages.scrollTop = messages.scrollHeight;
    const questions = SUGGESTIONS[page] || DEFAULT_SUGGESTIONS;
    panel.querySelector("#aiSuggestions").innerHTML = asking
      ? ""
      : questions.map((q) => `<button type="button" class="ai-chip" data-p3-ask="${esc(q)}">${esc(q)}</button>`).join("");
    // While an answer arrives, the send button becomes a stop button.
    const send = panel.querySelector(".ai-send");
    send.innerHTML = ic(asking ? "stop" : "send");
    send.setAttribute("aria-label", asking ? "Arrêter la réponse" : "Envoyer");
    send.title = asking ? "Arrêter la réponse" : "Envoyer";
    send.classList.toggle("stop", asking);
    const voiceToggle = panel.querySelector("[data-p3-panel='voice-mode']");
    if (voiceToggle) {
      voiceToggle.setAttribute("aria-pressed", String(voiceMode));
      voiceToggle.classList.toggle("active", voiceMode);
    }
    // Transparency: where the questions go, and how much of the daily allowance is used.
    const usage = aiStatus?.usage;
    const footnote = [
      aiStatus?.provider ? `Questions et données utiles envoyées à ${aiStatus.provider}.` : "",
      usage?.limit && usage.today >= usage.limit * 0.8 ? `${usage.today} / ${usage.limit} demandes utilisées aujourd’hui.` : "",
    ].filter(Boolean).join(" ");
    panel.querySelector("#aiFootnote").textContent = footnote;
    refreshSpeakButtons();
  }

  // Only the answer being written is redrawn while it arrives.
  let liveFrame = 0;
  function updateLiveAnswer() {
    if (liveFrame) return;
    liveFrame = (window.requestAnimationFrame || setTimeout)(() => {
      liveFrame = 0;
      const index = chat.length - 1;
      const node = document.querySelector(`#aiMessages .ai-msg[data-index="${index}"] .ai-rich`);
      if (!node || !chat[index]) return;
      const messages = document.getElementById("aiMessages");
      const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
      node.innerHTML = richText(visibleText(chat[index].text)) || "<p class=\"ai-wait\">L’assistant réfléchit…</p>";
      if (atBottom) messages.scrollTop = messages.scrollHeight;
    });
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
    voiceQuestion?.abort?.();
    if (speaking?.key?.startsWith("chat:")) stopSpeaking();
  }

  // The answer arrives piece by piece (server-sent events). Without streaming support the
  // server simply answers in JSON, which is handled the same way.
  async function streamAssistant(payload, onDelta, signal) {
    const response = await fetch("/api/operations/p3/assistant", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, stream: true }),
      signal,
    });
    const type = response.headers?.get?.("content-type") || "";
    if (!response.ok || !type.includes("text/event-stream")) {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data.error || "Le service IA est indisponible.");
        error.status = response.status;
        throw error;
      }
      if (data.answer) onDelta(data.answer);
      return { mode: data.mode || "ai" };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "",
      mode = "ai";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const message = JSON.parse(line.slice(5));
          if (message.delta) onDelta(message.delta);
          if (message.mode) mode = message.mode;
          if (message.error) throw new Error(message.error);
        }
      }
    }
    return { mode };
  }

  let askController = null;
  async function ask(question, { spoken = false } = {}) {
    question = String(question || "").trim();
    if (!question || asking) return;
    loadChat();
    stopSpeaking();
    // Earlier turns let the AI understand follow-up questions ("et le mois prochain ?").
    const history = chat
      .filter((m) => m.role === "user" || m.role === "ai")
      .slice(-8)
      .map((m) =>
        m.role === "user"
          ? { role: "user", content: m.text }
          : {
              role: "assistant",
              content:
                visibleText(m.text) +
                (m.actions || []).map((a) => `\n[Action ${a.type} proposée : ${a.status === "done" ? "confirmée et enregistrée" : a.status === "cancelled" ? "annulée" : "non confirmée"}]`).join(""),
            },
      );
    chat.push({ role: "user", text: question });
    const answer = { role: "ai", text: "", streaming: true };
    chat.push(answer);
    asking = true;
    saveChat();
    renderPanel();
    const projectId = openProjectId();
    const pageTitle = document.getElementById("title")?.textContent?.trim() || "";
    askController = typeof AbortController === "function" ? new AbortController() : null;
    let stopped = false;
    try {
      const out = await streamAssistant(
        { question, history, page: pageTitle, projectId },
        (delta) => {
          answer.text += delta;
          updateLiveAnswer();
        },
        askController?.signal,
      );
      if (!answer.text.trim()) answer.text = "Aucune réponse.";
      if (out.mode === "ai" && aiStatus?.usage) aiStatus.usage.today += 1;
    } catch (error) {
      stopped = error?.name === "AbortError";
      if (stopped) answer.text = (answer.text ? answer.text + "\n\n" : "") + "_Réponse arrêtée._";
      else if (answer.text) answer.text += "\n\n_" + (error.message || "Réponse interrompue.") + "_";
      else {
        chat.pop();
        chat.push({ role: "error", text: (error.message || "Le service IA est indisponible.") + " Vous pouvez réessayer." });
      }
    } finally {
      delete answer.streaming;
      answer.actions = parseActions(answer.text);
      asking = false;
      askController = null;
      saveChat();
      renderPanel();
    }
    // Spoken question, or conversation mode: the answer is read aloud, then (spoken question
    // in conversation mode) the microphone opens again for the next question.
    if (!stopped && chat.at(-1) === answer && (spoken || voiceMode) && !document.getElementById("aiPanel")?.hidden)
      speak(answer.text, "chat:" + (chat.length - 1), () => {
        const mic = document.querySelector("#aiPanel .ai-mic");
        if (spoken && voiceMode && mic && !document.getElementById("aiPanel")?.hidden && !answer.actions?.some((a) => a.status === "pending"))
          toggleVoiceQuestion(mic);
      });
  }

  // Asking out loud: the browser's own dictation fills the field, then the question is sent.
  const speechSupported = () => !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  let voiceQuestion = null;
  function toggleVoiceQuestion(control) {
    if (voiceQuestion) {
      voiceQuestion.stop();
      return;
    }
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return core().toast("La dictée n’est pas disponible dans ce navigateur.");
    stopSpeaking();
    const field = document.getElementById("aiQuestion");
    const recognizer = new SpeechRecognition();
    recognizer.lang = "fr-CH";
    recognizer.interimResults = true;
    recognizer.continuous = false;
    let heard = "";
    recognizer.onresult = (event) => {
      heard = [...event.results].map((r) => r[0]?.transcript || "").join(" ").trim();
      field.value = heard;
    };
    recognizer.onerror = (event) => {
      if (event.error === "not-allowed") core().toast("Autorisez le micro pour poser la question à voix haute.");
    };
    recognizer.onend = () => {
      voiceQuestion = null;
      control.classList.remove("listening");
      control.setAttribute("aria-pressed", "false");
      if (heard) {
        field.value = "";
        ask(heard, { spoken: true });
      }
    };
    voiceQuestion = recognizer;
    control.classList.add("listening");
    control.setAttribute("aria-pressed", "true");
    recognizer.start();
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
    const entry = PAGE_TOOLS[core().getPage?.() || ""];
    const tool = TOOLS[entry?.tool];
    const actions = document.querySelector("#content .section-head > .actions");
    if (!tool || !actions || actions.querySelector("[data-p3-open]") || !tool.allowed()) return;
    actions.insertAdjacentHTML(
      "beforeend",
      `<button type="button" class="btn secondary ai-action" data-p3-open="${entry.tool}" ${entry.kind ? `data-kind="${esc(entry.kind)}"` : ""} data-keep-visible>${ic(tool.icon)}<span>${esc(entry.label || tool.label)}</span></button>`,
    );
  }
  function addProjectButton() {
    if (isClient()) return;
    // Optional chaining: the observer can fire while a test window is being closed.
    const central = document?.querySelector?.('#modalBody [data-pro-action="project-central"]');
    if (!central || central.parentElement.querySelector("[data-p3-open='voice']")) return;
    const id = esc(central.dataset.id || "");
    central.insertAdjacentHTML(
      "afterend",
      ` <button type="button" class="btn secondary ai-action" data-p3-open="voice" data-project="${id}">${ic("mic")}<span>Compte rendu vocal</span></button>` +
        (TOOLS.email.allowed() ? ` <button type="button" class="btn secondary ai-action" data-p3-open="email" data-kind="project_update" data-target="${id}">${ic("mail")}<span>Message au client</span></button>` : ""),
    );
  }

  // ----- Point du jour on the dashboard -----
  let briefing = null,
    briefingLoading = false;
  const localDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich" }).format(new Date());
  function renderBriefing() {
    const card = document.getElementById("aiBriefing");
    if (!card) return;
    const time = briefing?.createdAt ? new Date(briefing.createdAt).toLocaleTimeString("fr-CH", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Zurich" }) : "";
    card.innerHTML = `<div class="ai-briefing-head">
        <h2>${ic("sparkle")}<span>Point du jour</span></h2>
        <div class="ai-briefing-actions">${briefing?.text ? speakButton("briefing") : ""}<button type="button" class="ai-tool-btn" data-p3-briefing="refresh" title="Actualiser" aria-label="Actualiser le point du jour" ${briefingLoading ? "disabled" : ""}>${ic("refresh")}</button></div>
      </div>
      <div class="ai-rich">${briefingLoading && !briefing?.text ? "<p class=\"ai-wait\">Préparation de votre point du jour…</p>" : briefing?.error ? `<p class="muted">${esc(briefing.error)}</p>` : richText(briefing?.text || "")}</div>
      ${time && !briefing?.error ? `<p class="ai-briefing-meta">Préparé à ${esc(time)}${briefing.mode === "ai" && aiStatus?.provider ? " par l’assistant" : ""}.</p>` : ""}`;
    refreshSpeakButtons();
  }
  async function loadBriefing(refresh = false) {
    if (briefingLoading) return;
    briefingLoading = true;
    renderBriefing();
    try {
      briefing = { ...(await api("briefing" + (refresh ? "?refresh=1" : ""))), loadedFor: localDay() };
    } catch (error) {
      briefing = { error: error.message || "Point du jour indisponible.", loadedFor: localDay() };
    } finally {
      briefingLoading = false;
      renderBriefing();
    }
  }
  function addBriefingCard() {
    if (isClient() || core().getPage?.() !== "dashboard") return;
    const welcome = document.querySelector("#content .workspace-welcome");
    if (!welcome || document.getElementById("aiBriefing")) return;
    // On the home page it comes after the buttons and « À faire », which it sums up.
    const slot = document.querySelector("#content #homeMore");
    const card = '<section id="aiBriefing" class="card ai-briefing" aria-live="polite" aria-label="Point du jour"></section>';
    if (slot) slot.insertAdjacentHTML("afterbegin", card);
    else welcome.insertAdjacentHTML("afterend", card);
    renderBriefing();
    if (!briefing || briefing.loadedFor !== localDay()) loadBriefing();
  }

  // ----- Documents: summary and questions -----
  let docSession = null;
  function addDocumentButtons(root = document) {
    if (isClient() || !aiReady()) return;
    for (const download of root?.querySelectorAll?.('#content [data-action="download"][data-id], #modalBody [data-action="download"][data-id]') || []) {
      if (download.parentElement.querySelector(`[data-p3-doc="${window.CSS?.escape ? window.CSS.escape(download.dataset.id) : download.dataset.id}"]`)) continue;
      download.insertAdjacentHTML("afterend", ` <button type="button" class="btn secondary ai-action" data-p3-doc="${esc(download.dataset.id)}">${ic("sparkle")}<span>Résumer</span></button>`);
    }
  }
  const MIME = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", txt: "text/plain" };
  async function documentContent(doc) {
    const response = await fetch("/api/state/documents/" + encodeURIComponent(doc.id), { credentials: "same-origin" });
    if (!response.ok) throw new Error("Téléchargement impossible ou accès expiré.");
    const extension = String(doc.name || "").split(".").pop().toLowerCase();
    const file = new File([await response.blob()], doc.name || "document", { type: MIME[extension] || "application/octet-stream" });
    if (extension === "pdf") return pdfContent(file);
    if (extension === "txt") return { text: (await file.text()).slice(0, 80000) };
    if (MIME[extension]?.startsWith("image/")) return { images: [await readImage(file, 1800)] };
    throw new Error("Ce type de fichier ne peut pas être résumé (PDF, image ou texte uniquement).");
  }
  function renderDocThread() {
    const target = document.getElementById("p3DocThread");
    if (!target || !docSession) return;
    target.innerHTML = docSession.turns
      .map((t, i) =>
        t.role === "user"
          ? `<div class="ai-msg ai-user"><p>${esc(t.text)}</p></div>`
          : `<div class="ai-msg ai-answer${t.error ? " ai-error" : ""}"><div class="ai-rich">${t.waiting ? '<p class="ai-wait">Lecture du document…</p>' : t.error ? `<p>${esc(t.text)}</p>` : richText(t.text)}</div>${t.waiting || t.error ? "" : `<div class="ai-msg-tools">${speakButton("doc:" + i)}<button type="button" class="ai-tool-btn" data-p3-doc-copy="${i}" title="Copier" aria-label="Copier">${ic("copy")}</button></div>`}</div>`,
      )
      .join("");
    const form = document.getElementById("p3DocAsk");
    if (form) form.querySelector("button").disabled = docSession.busy;
    refreshSpeakButtons();
  }
  async function askDocument(question = "") {
    if (!docSession || docSession.busy) return;
    docSession.busy = true;
    // Earlier questions and answers about this document (the summary counts as an answer).
    const history = docSession.turns
      .filter((t) => !t.error && !t.waiting)
      .slice(-6)
      .map((t) => ({ role: t.role === "user" ? "user" : "assistant", content: t.text }));
    if (question) docSession.turns.push({ role: "user", text: question });
    const answer = { role: "ai", text: "", waiting: true };
    docSession.turns.push(answer);
    renderDocThread();
    try {
      if (!docSession.content) docSession.content = await documentContent(docSession.doc);
      const out = await api("document", { documentId: docSession.doc.id, ...docSession.content, question, history });
      answer.text = out.answer || "Aucune réponse.";
      if (aiStatus?.usage) aiStatus.usage.today += 1;
    } catch (error) {
      answer.text = error.message || "Lecture impossible.";
      answer.error = true;
    } finally {
      answer.waiting = false;
      docSession.busy = false;
      renderDocThread();
    }
  }
  function openDocument(id) {
    const doc = (state().documents || []).find((d) => String(d.id) === String(id));
    if (!doc) return core().toast("Document introuvable.");
    docSession = { doc, content: null, turns: [], busy: false };
    core().modal(
      "Résumé · " + (doc.name || "document"),
      `<div class="p3-doc">
        <div id="p3DocThread" class="p3-doc-thread" aria-live="polite"></div>
        <form id="p3DocAsk" class="ai-composer">
          <textarea id="p3DocQuestion" rows="2" maxlength="2000" placeholder="Poser une question sur ce document (délais, montants, obligations…)" aria-label="Question sur le document"></textarea>
          <button type="submit" class="ai-send" aria-label="Envoyer">${ic("send")}</button>
        </form>
        <p class="ai-footnote">Le contenu du document est envoyé${aiStatus?.provider ? " à " + esc(aiStatus.provider) : " au service IA"} pour cette lecture. Vérifiez les points importants dans l’original.</p>
      </div>`,
    );
    askDocument();
  }

  function afterRender() {
    if (!profile()?.id || isClient()) return removeLauncher();
    ensureLauncher();
    addBriefingCard();
    ensureStatus().then(() => {
      addPageButton();
      addDocumentButtons();
      if (!document.getElementById("aiPanel")?.hidden) renderPanel();
    });
  }

  {
    const modalBody = document.getElementById("modalBody");
    if (modalBody && window.MutationObserver)
      new MutationObserver(() => {
        addProjectButton();
        addDocumentButtons();
      }).observe(modalBody, { childList: true, subtree: true });
  }
  document.addEventListener("click", async (event) => {
    const open = event.target.closest("[data-p3-open]");
    if (open)
      return openTool(open.dataset.p3Open, { projectId: open.dataset.project || "", kind: open.dataset.kind || "", id: open.dataset.target || "" });
    const ref = event.target.closest("[data-p3-ref]");
    if (ref) {
      // Open the record with the application's own action, after closing the panel.
      closePanel();
      const opener = document.createElement("button");
      opener.type = "button";
      opener.hidden = true;
      opener.dataset.action = ref.dataset.p3Ref;
      opener.dataset.id = ref.dataset.id;
      document.body.append(opener);
      opener.click();
      opener.remove();
      return;
    }
    const copy = event.target.closest("[data-p3-copy]");
    if (copy) return copyText(visibleText(chat[Number(copy.dataset.p3Copy)]?.text || ""));
    const docCopy = event.target.closest("[data-p3-doc-copy]");
    if (docCopy) return copyText(docSession?.turns[Number(docCopy.dataset.p3DocCopy)]?.text || "");
    const speakNode = event.target.closest("[data-p3-speak]");
    if (speakNode) {
      const key = speakNode.dataset.p3Speak;
      if (speaking?.key === key) return stopSpeaking();
      const [kind, index] = key.split(":");
      const text = kind === "chat" ? chat[Number(index)]?.text : kind === "doc" ? docSession?.turns[Number(index)]?.text : briefing?.text;
      return speak(text || "", key);
    }
    const doc = event.target.closest("[data-p3-doc]");
    if (doc) return openDocument(doc.dataset.p3Doc);
    if (event.target.closest("[data-p3-briefing='refresh']")) return loadBriefing(true);
    const act = event.target.closest("[data-p3-act]");
    if (act) {
      const message = chat[Number(act.dataset.msg)];
      const action = message?.actions?.[Number(act.dataset.act)];
      if (!action || action.status === "running" || action.status === "done") return;
      if (act.dataset.p3Act === "cancel") action.status = "cancelled";
      else {
        action.status = "running";
        renderPanel();
        try {
          await executeAction(action);
          action.status = "done";
          action.error = "";
          core().toast("Enregistré.");
        } catch (error) {
          action.status = "error";
          action.error = error.message || "Enregistrement impossible.";
        }
      }
      saveChat();
      return renderPanel();
    }
    const chip = event.target.closest("[data-p3-ask]");
    if (chip) return ask(chip.dataset.p3Ask);
    const control = event.target.closest("[data-p3-panel]");
    if (!control) return;
    const action = control.dataset.p3Panel;
    if (action === "toggle") document.getElementById("aiPanel")?.hidden === false ? closePanel() : openPanel();
    else if (action === "close") closePanel();
    else if (action === "mic") toggleVoiceQuestion(control);
    else if (action === "voice-mode") {
      voiceMode = !voiceMode;
      try {
        localStorage.setItem("sgo_ai_voice", voiceMode ? "1" : "0");
      } catch {
        // Not kept in private browsing.
      }
      if (!voiceMode) stopSpeaking();
      core().toast(voiceMode ? "Conversation vocale : les réponses seront lues à voix haute." : "Lecture automatique désactivée.");
      renderPanel();
    } else if (action === "clear") {
      askController?.abort();
      stopSpeaking();
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
    if (event.target.id === "p3DocAsk") {
      event.preventDefault();
      const field = document.getElementById("p3DocQuestion");
      const question = field.value.trim();
      if (!question || docSession?.busy) return;
      field.value = "";
      askDocument(question);
      return;
    }
    if (event.target.id !== "aiComposer") return;
    event.preventDefault();
    if (asking) return askController?.abort();
    const field = document.getElementById("aiQuestion");
    const question = field.value;
    field.value = "";
    ask(question);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.getElementById("aiPanel")?.hidden === false && document.getElementById("modalWrap")?.classList.contains("hidden"))
      closePanel();
    if (["aiQuestion", "p3DocQuestion"].includes(event.target.id) && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      // Enter never stops an answer that is arriving: only the stop button does.
      if (event.target.id === "aiQuestion" && asking) return;
      event.target.form?.requestSubmit();
    }
  });

  window.SGOP3Center = { render, openTool, openPanel, closePanel, afterRender };
})();
