"use strict";
// « Importer le relevé bancaire » (Finances › Paiements): the e-banking file is read, each credit is
// matched to an invoice, the person checks, then the payments are recorded.
(() => {
  const core = () => window.SGOChatCore;
  const esc = (v) => core().esc(String(v ?? ""));
  const money = (n) => Number(n || 0).toLocaleString("fr-CH", { style: "currency", currency: "CHF" });
  const day = (d) => (d ? new Date(d + "T12:00:00").toLocaleDateString("fr-CH") : "—");
  let file64 = "",
    lines = [];

  function toBase64(buf) {
    const bytes = new Uint8Array(buf);
    let out = "";
    for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(out);
  }
  function openInvoices() {
    const st = core().getState();
    return (st.invoices || []).filter(
      (i) => !i.deletedAt && !i.archivedAt && !["Brouillon", "Payée", "Annulée"].includes(i.status) && Number(i.amount) - Number(i.paid || 0) > 0.004,
    );
  }
  const clientName = (id) => (core().getState().clients || []).find((c) => String(c.id) === String(id))?.name || "";
  function invoiceSelect(l) {
    const list = openInvoices();
    const first = [...new Set([l.invoice, ...(l.suggestions || [])].filter(Boolean))];
    const label = (i) => `${i.id} · ${clientName(i.clientId)} · reste ${money(Number(i.amount) - Number(i.paid || 0))}`;
    const known = (id) => list.find((i) => i.id === id);
    return `<select class="bank-invoice" data-key="${esc(l.key)}" aria-label="Facture payée par ce virement"><option value="">— Ne pas enregistrer —</option>${first
      .filter(known)
      .map((id) => `<option value="${esc(id)}" ${id === l.invoice ? "selected" : ""}>${esc(label(known(id)))}</option>`)
      .join("")}${first.length ? '<option disabled>──────────</option>' : ""}${list
      .filter((i) => !first.includes(i.id))
      .map((i) => `<option value="${esc(i.id)}">${esc(label(i))}</option>`)
      .join("")}</select>`;
  }
  function lineHtml(l) {
    const chosen = l.status === "sure";
    return `<li class="bank-line bank-${l.status}"><label class="bank-pick"><input type="checkbox" class="bank-tick" data-key="${esc(l.key)}" ${chosen ? "checked" : ""} aria-label="Enregistrer ce paiement"></label><div class="bank-what"><b>${money(l.amount)}</b> <span class="muted">${day(l.date)}</span><span>${esc(l.debtor || "Payeur non indiqué")}</span>${l.text ? `<small>${esc(l.text)}</small>` : ""}<small class="bank-note">${esc(l.note)}</small></div><div class="bank-to">${invoiceSelect(l)}</div></li>`;
  }
  function group(title, status, open, hint) {
    const list = lines.filter((l) => l.status === status);
    if (!list.length) return "";
    return `<details class="bank-group" ${open ? "open" : ""}><summary><b>${esc(title)}</b> <span class="bank-count">${list.length}</span>${hint ? ` <span class="muted">${esc(hint)}</span>` : ""}</summary><ul class="bank-lines">${list.map(lineHtml).join("")}</ul></details>`;
  }
  function selected() {
    const host = document.getElementById("bankResult");
    if (!host) return [];
    return [...host.querySelectorAll(".bank-tick:checked")]
      .map((c) => ({ key: c.dataset.key, invoice: host.querySelector(`.bank-invoice[data-key="${CSS.escape(c.dataset.key)}"]`)?.value || "" }))
      .filter((x) => x.invoice);
  }
  function refreshButton() {
    const button = document.getElementById("bankConfirm");
    if (!button) return;
    const items = selected();
    const total = items.reduce((t, x) => t + Number(lines.find((l) => l.key === x.key)?.amount || 0), 0);
    button.disabled = !items.length;
    button.textContent = items.length ? `Enregistrer ${items.length} paiement${items.length > 1 ? "s" : ""} (${money(total)})` : "Enregistrer les paiements";
  }
  function showResult(data) {
    lines = data.lines;
    const c = data.counts;
    document.getElementById("bankResult").innerHTML = `<p class="bank-summary">${data.companies.length ? `Compte de <b>${esc(data.companies.map((x) => x.name).join(", "))}</b> · ` : data.accounts.length ? `Compte ${esc(data.accounts.join(", "))} (non enregistré dans les paramètres de facturation : toutes vos factures sont proposées) · ` : ""}${lines.length} versement${lines.length > 1 ? "s" : ""} reçu${lines.length > 1 ? "s" : ""}.</p>${
      lines.length
        ? group("Reconnus", "sure", true, "cochés d’office") +
          group("À vérifier", "check", true, "cochez si c’est la bonne facture") +
          group("Non reconnus", "unknown", !c.sure && !c.check, "choisissez la facture si vous la connaissez") +
          group("Déjà enregistrés", "done", false, "")
        : '<p class="muted">Aucun versement reçu dans ce fichier.</p>'
    }<div class="bank-actions"><button type="button" class="btn primary" id="bankConfirm" disabled>Enregistrer les paiements</button></div>`;
    document.querySelectorAll(".bank-done .bank-tick, .bank-done .bank-invoice").forEach((el) => (el.disabled = true));
    refreshButton();
  }
  async function analyse(input) {
    const f = input.files?.[0];
    const out = document.getElementById("bankResult");
    if (!f) return;
    if (f.size > 16 * 1024 * 1024) {
      out.innerHTML = '<p class="bank-error">Fichier trop volumineux (16 Mo maximum).</p>';
      return;
    }
    out.innerHTML = '<p class="muted">Lecture du relevé…</p>';
    try {
      file64 = toBase64(await f.arrayBuffer());
      showResult(await core().api("bank/preview", { file: file64 }));
    } catch (e) {
      file64 = "";
      out.innerHTML = `<p class="bank-error">${esc(e.message)}</p>`;
    }
  }
  async function confirm() {
    const items = selected();
    if (!items.length || !file64) return;
    const button = document.getElementById("bankConfirm");
    button.disabled = true;
    try {
      const r = await core().api("bank/confirm", { file: file64, items });
      core().closeModal(true);
      await core().refresh?.();
      core().toast(
        `${r.created.length} paiement${r.created.length > 1 ? "s" : ""} enregistré${r.created.length > 1 ? "s" : ""}${r.skipped.length ? ` · ${r.skipped.length} ignoré${r.skipped.length > 1 ? "s" : ""}` : ""}.`,
      );
    } catch (e) {
      button.disabled = false;
      core().toast(e.message);
    }
  }
  function open() {
    file64 = "";
    lines = [];
    core().modal(
      "Importer le relevé bancaire",
      `<div class="bank-import"><ol class="bank-steps"><li>Dans votre e-banking (PostFinance, UBS, Raiffeisen, BCV…), téléchargez le relevé du compte au format <b>camt.054</b> ou <b>camt.053</b> (fichier XML, ou ZIP).</li><li>Choisissez ce fichier ci-dessous : l’application retrouve la facture de chaque versement grâce à la référence QR ou au numéro de facture.</li><li>Vérifiez, puis enregistrez. Un versement déjà enregistré ne l’est jamais deux fois.</li></ol><label class="bank-file">Fichier du relevé<input type="file" id="bankFile" accept=".xml,.zip,application/xml,text/xml,application/zip"></label><div id="bankResult" aria-live="polite"></div></div>`,
    );
  }
  document.addEventListener("change", (e) => {
    if (e.target.id === "bankFile") analyse(e.target);
    else if (e.target.closest?.("#bankResult")) {
      if (e.target.classList.contains("bank-invoice")) {
        const box = document.querySelector(`.bank-tick[data-key="${CSS.escape(e.target.dataset.key)}"]`);
        if (box && !box.disabled) box.checked = !!e.target.value;
      }
      refreshButton();
    }
  });
  document.addEventListener("click", (e) => {
    if (e.target.closest?.('[data-bank-action="open"]')) open();
    else if (e.target.closest?.("#bankConfirm")) confirm();
  });
  window.SGOBank = { open };
})();
