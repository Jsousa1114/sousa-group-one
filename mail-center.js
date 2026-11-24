"use strict";
// E-mails from the application: "Envoyer au client" on an issued quote or invoice, and the
// "E-mails et relances" window (sending test, automatic payment reminders, recent e-mails).
(() => {
  const core = () => window.SGOChatCore;
  const esc = (value) => core()?.esc?.(value) ?? String(value ?? "");
  const profile = () => core()?.getProfile?.() || {};
  const state = () => core()?.getState?.() || {};
  const ic = (name) => window.SGOIcon?.(name) || "";
  const isFinance = () => ["admin", "direction", "accounting"].includes(profile().role);
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
    test: "Test d’envoi",
    "reminder-7": "Rappel (J+7)",
    "reminder-14": "2e rappel (J+14)",
    "reminder-30": "Dernier rappel (J+30)",
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
          `<tr><td>${esc(dateTime(e.created_at))}</td><td>${esc(KIND_LABELS[e.kind] || e.kind)}</td>${withDocument ? `<td>${esc(e.entity_id || "—")}</td>` : ""}<td>${esc(e.recipient || "—")}</td><td><span class="status ${e.status === "sent" ? "neutral" : ""}">${esc(STATUS_LABELS[e.status] || e.status)}</span>${e.error ? `<br><small>${esc(e.error)}</small>` : ""}</td></tr>`,
      )
      .join("")}</tbody></table></div>`;
  }

  // ----- Sending an issued quote or invoice -----
  function defaultMessage(kind, doc) {
    const client = (doc.customer || (state().clients || []).find((c) => String(c.id) === String(doc.clientId)) || {}).name;
    const company = (doc.issuer || (state().companies || []).find((c) => String(c.id) === String(doc.company)) || {}).name || "Sousa Group One";
    const what = kind === "quotes" ? `notre devis ${doc.id}` : `notre facture ${doc.id}`;
    const due = kind === "invoices" && doc.due ? `, payable jusqu’au ${swissDate(doc.due)}` : "";
    const valid = kind === "quotes" && doc.valid ? `, valable jusqu’au ${swissDate(doc.valid)}` : "";
    return (
      `Bonjour${client ? " " + client : ""},\n\nVous trouverez en pièce jointe ${what}${doc.title ? " (" + doc.title + ")" : ""} d’un montant de ${money(doc.amount)}${due}${valid}.\n\n` +
      (kind === "quotes" ? "Nous restons à votre disposition pour toute question.\n\n" : "Le bulletin de versement QR figure sur la dernière page.\n\n") +
      `Meilleures salutations\n${company}`
    );
  }
  function openSendForm(kind, id) {
    const doc = (state()[kind] || []).find((x) => String(x.id) === String(id));
    if (!doc) return;
    const customer = doc.customer || (state().clients || []).find((c) => String(c.id) === String(doc.clientId)) || {};
    const company = (doc.issuer || (state().companies || []).find((c) => String(c.id) === String(doc.company)) || {}).name || "Sousa Group One";
    const unpaid = kind === "invoices" && doc.status !== "Payée";
    core().modal(
      `Envoyer ${kind === "quotes" ? "le devis" : "la facture"} ${doc.id}`,
      `<form id="mailSendForm" class="mail-form" data-kind="${esc(kind)}" data-id="${esc(doc.id)}">
        <p class="muted">Envoyé depuis ${esc(addressFor(doc.company) || "l’adresse configurée")}, avec le PDF en pièce jointe${unpaid ? " (et le bulletin QR)" : ""}.</p>
        <label>Destinataire<input name="to" type="email" required value="${esc(customer.email || "")}" placeholder="adresse@client.ch"></label>
        <label>Objet<input name="subject" maxlength="200" required value="${esc(`${kind === "quotes" ? "Devis" : "Facture"} ${doc.id} — ${company}`)}"></label>
        <label>Message<textarea name="text" rows="9" maxlength="8000">${esc(doc.message ? doc.message + "\n\nMeilleures salutations\n" + company : defaultMessage(kind, doc))}</textarea></label>
        ${unpaid ? '<label class="mail-check"><input type="checkbox" name="qr" checked> Joindre le bulletin de versement QR</label>' : ""}
        <p id="mailSendError" class="error" role="alert"></p>
        <div class="form-actions"><button type="submit" class="btn primary">${ic("send")}<span>Envoyer</span></button></div>
      </form>`,
    );
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
    // With e-mail configured, the application sends directly instead of preparing an .eml file.
    draftButton.insertAdjacentHTML("beforebegin", `<button type="button" class="btn primary mail-send" data-mail-send="${esc(kind + ":" + id)}">${ic("mail")}<span>Envoyer au client</span></button> `);
    draftButton.remove();
    try {
      const out = await core().api(`mail/log?entityType=${encodeURIComponent(kind)}&entityId=${encodeURIComponent(id)}&limit=5`);
      const sent = (out.emails || []).filter((e) => e.status === "sent");
      const target = document.querySelector(`#modalBody [data-mail-send="${kind}:${id}"]`)?.parentElement;
      if (sent.length && target)
        target.insertAdjacentHTML(
          "afterend",
          `<p class="mail-history muted">${ic("check")}<span>Dernier envoi : ${esc(dateTime(sent[0].created_at))} à ${esc(sent[0].recipient)}${sent.length > 1 ? ` · ${sent.length} envois` : ""}</span></p>`,
        );
    } catch {
      // The history is a convenience.
    }
  }

  // ----- "E-mails et relances" window -----
  async function openCenter() {
    core().modal("E-mails et relances", '<div class="mail-center"><p class="muted">Chargement…</p></div>');
    const s = await loadStatus(true);
    const [reminders, log] = await Promise.all([
      s?.configured ? core().api("mail/reminders").catch(() => null) : null,
      core().api("mail/log?limit=30").catch(() => ({ emails: [] })),
    ]);
    const box = document.querySelector("#modalBody .mail-center");
    if (!box) return;
    const canToggle = ["admin", "direction", "accounting"].includes(profile().role);
    const companies = (s?.companies || []).filter((c) => c.id !== "group" || c.address);
    box.innerHTML = `
      <section class="card mail-status">
        <h3>${ic("mail")}<span>Adresses d’envoi</span></h3>
        <p>Chaque entreprise envoie depuis son propre Gmail, avec son nom. Les réponses des clients arrivent sur l’e-mail de facturation de l’entreprise s’il est renseigné, sinon sur cette adresse.</p>
        ${companies.length
          ? `<div class="table"><table><thead><tr><th>Entreprise</th><th>Envoie depuis</th><th></th></tr></thead><tbody>${companies
              .map(
                (c) =>
                  `<tr><td>${esc(c.name)}</td><td>${c.address ? `${esc(c.address)}${c.own ? "" : ' <small class="muted">(adresse par défaut)</small>'}` : '<span class="muted">Pas encore configurée</span>'}</td><td>${c.address ? `<button type="button" class="btn secondary" data-mail-test="${esc(c.id)}">Tester</button>` : ""}</td></tr>`,
              )
              .join("")}</tbody></table></div>`
          : ""}
        ${s?.configured ? "" : '<p class="notice warning">Aucune adresse Gmail n’est encore configurée sur le serveur. En attendant, le bouton « Préparer e-mail » télécharge un brouillon à ouvrir dans votre messagerie.</p>'}
      </section>
      ${reminders
        ? `<section class="card">
            <h3>Relances automatiques des factures</h3>
            <p>Quand une facture émise n’est pas payée, le client reçoit un rappel par e-mail avec la facture et le bulletin QR : <b>7 jours</b> après l’échéance, puis <b>14 jours</b> (2e rappel) et <b>30 jours</b> (dernier rappel). Envoi en semaine entre 8 h et 18 h.</p>
            <p class="muted">Seules les échéances atteintes après l’activation déclenchent un rappel : aucune relance n’est envoyée en rafale pour les anciennes factures. Pour celles-ci, utilisez « Relance par e-mail ».</p>
            <label class="mail-check"><input type="checkbox" id="mailRemindersToggle" ${reminders.enabled ? "checked" : ""} ${canToggle ? "" : "disabled"}> Relances automatiques activées${reminders.enabled && reminders.enabledAt ? ` <span class="muted">(depuis le ${esc(swissDate(reminders.enabledAt))})</span>` : ""}</label>
            ${reminders.overdue.length
              ? `<div class="table"><table><thead><tr><th>Facture</th><th>Client</th><th>Retard</th><th>Reste dû</th><th>Prochain rappel</th></tr></thead><tbody>${reminders.overdue
                  .slice(0, 20)
                  .map(
                    (i) =>
                      `<tr><td>${esc(i.id)}</td><td>${esc(i.client)}${i.email ? "" : '<br><small class="error">sans adresse e-mail</small>'}</td><td>${esc(i.lateDays)} j</td><td>${esc(money(i.remaining))}</td><td>${i.nextReminder ? esc(swissDate(i.nextReminder)) : "—"}</td></tr>`,
                  )
                  .join("")}</tbody></table></div>`
              : '<p class="muted">Aucune facture en retard.</p>'}
          </section>`
        : ""}
      <section class="card"><h3>Derniers e-mails</h3>${logRows(log?.emails || [])}</section>`;
  }

  function addCenterButton() {
    if (!isFinance() || !["invoices", "quotes"].includes(core().getPage?.())) return;
    const actions = document.querySelector("#content .section-head > .actions");
    if (!actions || actions.querySelector("[data-mail-center]")) return;
    actions.insertAdjacentHTML("beforeend", `<button type="button" class="btn secondary" data-mail-center>${ic("mail")}<span>E-mails et relances</span></button>`);
  }

  function afterRender() {
    if (!profile()?.id || profile().role === "client") return;
    loadStatus().then(() => addCenterButton());
  }

  {
    const modalBody = document.getElementById("modalBody");
    if (modalBody && window.MutationObserver) new MutationObserver(() => enhanceDocumentModal()).observe(modalBody, { childList: true });
  }

  document.addEventListener("click", async (event) => {
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
  });
  document.addEventListener("change", async (event) => {
    if (event.target?.id !== "mailRemindersToggle") return;
    const toggle = event.target;
    const enabled = toggle.checked;
    if (enabled && !confirm("Activer les relances automatiques ? Les clients recevront un rappel par e-mail 7, 14 et 30 jours après l’échéance d’une facture impayée."))
      return (toggle.checked = false);
    toggle.disabled = true;
    try {
      await core().api("mail/reminders", { enabled });
      core().toast(enabled ? "Relances automatiques activées." : "Relances automatiques désactivées.");
      openCenter();
    } catch (error) {
      toggle.checked = !enabled;
      core().toast(error.message || "Réglage impossible.");
    } finally {
      toggle.disabled = false;
    }
  });
  document.addEventListener("submit", async (event) => {
    const form = event.target;
    if (form.id !== "mailSendForm") return;
    event.preventDefault();
    const button = form.querySelector("button[type=submit]");
    const error = document.getElementById("mailSendError");
    button.disabled = true;
    error.textContent = "";
    try {
      const out = await core().api(`mail/finance/${encodeURIComponent(form.dataset.kind)}/${encodeURIComponent(form.dataset.id)}`, {
        to: form.elements.to.value.trim(),
        subject: form.elements.subject.value,
        text: form.elements.text.value,
        qr: form.elements.qr ? form.elements.qr.checked : undefined,
      });
      core().closeModal(true);
      core().toast(`${form.dataset.kind === "quotes" ? "Devis envoyé" : "Facture envoyée"} à ${out.to}.`);
    } catch (e) {
      error.textContent = e.message || "Envoi impossible.";
    } finally {
      button.disabled = false;
    }
  });

  window.SGOMailCenter = { afterRender, status: () => status, loadStatus, openCenter, addressFor };
})();
