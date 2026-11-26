"use strict";
// « Devis déménagement » (Finances › Devis): the inventory room by room (or from photos, or filled
// in by the client through a link), the estimate, then the quote.
(() => {
  const core = () => window.SGOChatCore;
  const esc = (v) => core().esc(String(v ?? ""));
  const money = (n) => Number(n || 0).toLocaleString("fr-CH", { style: "currency", currency: "CHF" });
  let cfg = null,
    cur = null,
    est = null,
    overrides = {},
    timer = 0,
    seq = 0;

  const blank = (company) => ({ id: null, company, clientId: "", title: "", status: "En cours", quoteId: "", inventory: { items: {}, custom: [], details: { fromLift: false, toLift: false }, notes: "" } });
  const itemsOf = () => cur.inventory.items || (cur.inventory.items = {});
  const det = () => cur.inventory.details || (cur.inventory.details = {});

  async function open() {
    try {
      cfg = await core().api("moving/config");
    } catch (e) {
      return core().toast(e.message);
    }
    if (!cfg.companies.length) return core().toast("Aucune entreprise de déménagement accessible.");
    list();
  }
  async function list() {
    core().modal("Devis déménagement", '<p class="muted">Chargement…</p>');
    let rows = [];
    try {
      rows = (await core().api("moving/inventories")).inventories;
    } catch (e) {
      return (document.getElementById("modalBody").textContent = e.message);
    }
    const tone = (s) => (s === "Reçu du client" ? "warning" : s === "Devis créé" ? "ok" : s === "Envoyé au client" ? "info" : "neutral");
    document.getElementById("modalBody").innerHTML = `<div class="mv-list"><p class="muted">Faites l’inventaire pièce par pièce (ou à partir de photos), ou envoyez un lien au client pour qu’il le remplisse lui-même. L’application calcule le volume, le camion, l’équipe et la durée, puis prépare le devis.</p><div class="mv-list-actions"><button type="button" class="btn primary" data-mv="new">Nouvel inventaire</button>${cfg.canSettings ? '<button type="button" class="btn secondary" data-mv="settings">Réglages des prix</button>' : ""}</div>${
      rows.length
        ? `<ul class="trade-list">${rows
            .map(
              (x) =>
                `<li class="trade-item"><div class="trade-what"><b>${esc(x.title || x.clientName || "Inventaire n° " + x.id)}</b><span>${esc(x.clientName || "Client à indiquer")}</span><small>${esc(x.inventory?.details?.fromAddress || "")}${x.inventory?.details?.toAddress ? " → " + esc(x.inventory.details.toAddress) : ""}</small></div><div class="trade-due"><span class="status ${tone(x.status)}">${esc(x.status)}</span>${x.quoteId ? `<small>Devis ${esc(x.quoteId)}</small>` : ""}</div><div class="trade-actions"><button type="button" class="btn primary" data-mv="edit" data-id="${x.id}">Ouvrir</button></div></li>`,
            )
            .join("")}</ul>`
        : ""
    }</div>`;
  }

  function stepper(id, label, m3) {
    const q = itemsOf()[id] || 0;
    return `<li class="mv-item ${q ? "has" : ""}"><span class="mv-item-name">${esc(label)}<small>${m3} m³</small></span><span class="mv-stepper"><button type="button" class="mv-step" data-mv-item="${id}" data-delta="-1" aria-label="Retirer : ${esc(label)}" ${q ? "" : "disabled"}>−</button><output aria-live="polite">${q}</output><button type="button" class="mv-step" data-mv-item="${id}" data-delta="1" aria-label="Ajouter : ${esc(label)}">+</button></span></li>`;
  }
  function editor() {
    const d = det();
    const companies = cfg.companies;
    const clients = (core().getState().clients || []).filter((c) => !c.deletedAt && (!c.company || c.company === cur.company));
    const locked = !!cur.quoteId;
    const access = (side, title) =>
      `<fieldset class="mv-access"><legend>${title}</legend><label class="wide">Adresse<input data-mv-d="${side}Address" maxlength="200" value="${esc(d[side + "Address"] || "")}" placeholder="Rue, numéro, NPA, localité"></label><label>Étage<input type="number" data-mv-d="${side}Floor" min="-3" max="40" value="${esc(d[side + "Floor"] ?? 0)}"></label><label class="mv-check"><input type="checkbox" data-mv-d="${side}Lift" ${d[side + "Lift"] ? "checked" : ""}> Ascenseur</label><label class="mv-check"><input type="checkbox" data-mv-d="${side}Carry" ${d[side + "Carry"] ? "checked" : ""}> Camion à plus de 20 m</label></fieldset>`;
    document.getElementById("modalBody").innerHTML = `<div class="mv-editor">${locked ? `<p class="mv-locked">Le devis <b>${esc(cur.quoteId)}</b> a été créé à partir de cet inventaire.</p>` : ""}<div class="mv-grid">${companies.length > 1 ? `<label>Entreprise<select data-mv-f="company">${companies.map((c) => `<option value="${esc(c.id)}" ${c.id === cur.company ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>` : ""}<label>Client<select data-mv-f="clientId"><option value="">— Nouveau client (au moment du devis) —</option>${clients.map((c) => `<option value="${esc(c.id)}" ${String(c.id) === String(cur.clientId) ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label><label>Titre<input data-mv-f="title" maxlength="120" value="${esc(cur.title)}" placeholder="Ex. Déménagement Keller"></label></div>${access("from", "Départ")}${access("to", "Arrivée")}<div class="mv-grid"><label>Distance entre les adresses (km)<input type="number" data-mv-d="distanceKm" min="0" max="2000" step="1" value="${esc(d.distanceKm ?? "")}"></label><label>Date souhaitée<input type="date" data-mv-d="date" value="${esc(d.date || "")}"></label></div><section class="mv-photos"><h4>Remplir avec des photos</h4><p class="muted">Prenez une photo de chaque pièce : l’IA compte les meubles et les ajoute à l’inventaire. Vérifiez ensuite les quantités.</p><label class="btn secondary mv-photo-btn">Choisir des photos<input type="file" id="mvPhotos" accept="image/*" multiple hidden></label><span id="mvPhotoState" class="muted" aria-live="polite"></span></section><h4>Meubles et objets</h4>${cfg.catalog
      .map((g) => {
        const n = g.items.reduce((t, i) => t + (itemsOf()[i.id] || 0), 0);
        return `<details class="mv-room" ${n ? "open" : ""}><summary><b>${esc(g.room)}</b>${n ? ` <span class="bank-count">${n}</span>` : ""}</summary><ul class="mv-items">${g.items.map((i) => stepper(i.id, i.label, i.m3)).join("")}</ul></details>`;
      })
      .join("")}<details class="mv-room" open><summary><b>Autres objets</b></summary><ul class="mv-items">${(cur.inventory.custom || [])
      .map(
        (c, i) =>
          `<li class="mv-item has"><span class="mv-item-name">${esc(c.label)}<small>${c.m3} m³</small></span><span class="mv-stepper"><button type="button" class="mv-step" data-mv-custom="${i}" data-delta="-1" aria-label="Retirer : ${esc(c.label)}">−</button><output>${c.qty}</output><button type="button" class="mv-step" data-mv-custom="${i}" data-delta="1" aria-label="Ajouter : ${esc(c.label)}">+</button></span></li>`,
      )
      .join("")}</ul><form class="mv-add" id="mvAdd"><input name="label" maxlength="80" placeholder="Objet (ex. aquarium, coffre-fort)" required><select name="m3" aria-label="Taille"><option value="0.2">Petit (0,2 m³)</option><option value="0.5" selected>Moyen (0,5 m³)</option><option value="1">Grand (1 m³)</option><option value="2">Très grand (2 m³)</option></select><button type="submit" class="btn secondary">Ajouter</button></form></details><div class="mv-grid"><label>Cartons fournis par nous<input type="number" data-mv-d="cartonsSupplied" min="0" max="999" value="${esc(d.cartonsSupplied ?? 0)}"></label><label>Meubles à démonter / remonter<input type="number" data-mv-d="assembly" min="0" max="99" value="${esc(d.assembly ?? 0)}"></label><label class="mv-check"><input type="checkbox" data-mv-d="packing" ${d.packing ? "checked" : ""}> Emballage par nos soins</label></div><label>Remarques<textarea data-mv-f="notes" maxlength="2000">${esc(cur.inventory.notes || "")}</textarea></label><section class="mv-estimate" id="mvEstimate" aria-live="polite"><p class="muted">Calcul…</p></section><div class="mv-actions"><button type="button" class="btn secondary" data-mv="back">‹ Inventaires</button>${cur.id ? '<button type="button" class="btn danger" data-mv="delete">Supprimer</button>' : ""}<button type="button" class="btn secondary" data-mv="save">Enregistrer</button><button type="button" class="btn secondary" data-mv="link">Lien pour le client</button>${cfg.canQuote && !locked ? '<button type="button" class="btn primary" data-mv="quote">Créer le devis</button>' : ""}</div></div>`;
    schedule(0);
  }
  function schedule(ms = 350) {
    clearTimeout(timer);
    timer = setTimeout(computeEstimate, ms);
  }
  async function computeEstimate() {
    const host = document.getElementById("mvEstimate");
    if (!host || !cur) return;
    const current = ++seq;
    try {
      est = await core().api("moving/estimate", { company: cur.company, inventory: cur.inventory, overrides });
    } catch (e) {
      if (current === seq) host.innerHTML = `<p class="trade-error">${esc(e.message)}</p>`;
      return;
    }
    if (current !== seq || !document.getElementById("mvEstimate")) return;
    const s = cfg.settings[cur.company] || {};
    host.innerHTML = `<h4>Estimation</h4><div class="mv-figures"><div><span>Volume</span><b>${est.volume} m³</b></div><div><span>Véhicule</span><b>${esc(est.truck.label)}${est.trips > 1 ? ` × ${est.trips}` : ""}</b></div><div><span>Déménageurs</span><b>${est.movers}</b></div><div><span>Durée</span><b>${est.hours} h</b></div></div><div class="mv-grid"><label>Véhicule<select data-mv-o="truck"><option value="">Automatique</option>${(s.trucks || []).map((t, i) => `<option value="${i}" ${String(overrides.truck) === String(i) ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</select></label><label>Déménageurs<input type="number" data-mv-o="movers" min="1" max="12" placeholder="${est.movers}" value="${esc(overrides.movers || "")}"></label><label>Heures<input type="number" data-mv-o="hours" min="0.5" max="200" step="0.5" placeholder="${est.computedHours}" value="${esc(overrides.hours || "")}"></label></div><table class="mv-lines"><tbody>${est.lines.map((l) => `<tr><td>${esc(l.description)}</td><td>${esc(l.quantity)} ${esc(l.unit)}</td><td>${money(l.quantity * l.unitPrice)}</td></tr>`).join("")}</tbody><tfoot><tr><td colspan="2">Total TTC (TVA ${esc(s.vatRate ?? 8.1)} %)</td><td><b>${money(est.total)}</b></td></tr></tfoot></table>${!est.volume ? '<p class="muted">Ajoutez des meubles pour obtenir une estimation.</p>' : ""}`;
  }
  async function save(quiet) {
    const r = await core().api("moving/inventories/save", { id: cur.id, company: cur.company, clientId: cur.clientId, title: cur.title, inventory: cur.inventory });
    cur.id = r.id;
    if (!quiet) core().toast("Inventaire enregistré.");
  }
  async function edit(id) {
    try {
      const x = (await core().api("moving/inventories/" + id)).inventory;
      cur = { ...x, inventory: { items: {}, custom: [], details: {}, notes: "", ...(x.inventory || {}) } };
      overrides = {};
      core().modal(cur.title || cur.clientName || "Inventaire", "");
      editor();
    } catch (e) {
      core().toast(e.message);
    }
  }
  // Photos are made smaller in the browser before they leave (1280 px, JPEG).
  async function shrink(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, ko) => {
        const i = new Image();
        i.onload = () => ok(i);
        i.onerror = () => ko(new Error("Photo illisible."));
        i.src = url;
      });
      const k = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.8);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  async function photos(input) {
    const files = [...(input.files || [])].slice(0, 6);
    const state = document.getElementById("mvPhotoState");
    if (!files.length) return;
    state.textContent = `Analyse de ${files.length} photo${files.length > 1 ? "s" : ""}…`;
    try {
      const images = [];
      for (const f of files) images.push(await shrink(f));
      const r = await core().api("moving/photos", { company: cur.company, images });
      let added = 0;
      for (const [id, q] of Object.entries(r.items)) {
        itemsOf()[id] = (itemsOf()[id] || 0) + q;
        added += q;
      }
      for (const c of r.custom) {
        (cur.inventory.custom ||= []).push(c);
        added += c.qty;
      }
      editor();
      core().toast(`${added} objet${added > 1 ? "s" : ""} ajouté${added > 1 ? "s" : ""} : vérifiez les quantités.${r.warnings.length ? " " + r.warnings.join(" ") : ""}`);
    } catch (e) {
      state.textContent = e.message;
    } finally {
      input.value = "";
    }
  }
  async function makeLink() {
    try {
      await save(true);
      const r = await core().api(`moving/inventories/${cur.id}/link`, {});
      const client = (core().getState().clients || []).find((c) => String(c.id) === String(cur.clientId));
      const message = `Bonjour, pour préparer le devis de votre déménagement, merci de remplir l’inventaire de vos meubles ici (lien valable ${r.days} jours) : ${r.url}`;
      const phone = String(client?.phone || "").replace(/[^\d+]/g, "").replace(/^00/, "+").replace(/^0(?=[1-9])/, "+41");
      core().modal(
        "Lien pour le client",
        `<p>Le client remplit lui-même l’inventaire depuis son téléphone, sans compte. Vous êtes prévenu dès qu’il l’envoie.</p><label>Lien<input id="mvLink" readonly value="${esc(r.url)}"></label><div class="go-apps"><button type="button" class="btn primary" data-mv="copy">Copier le lien</button>${client?.email ? `<a class="btn secondary" href="mailto:${esc(encodeURIComponent(client.email))}?subject=${encodeURIComponent("Inventaire pour votre déménagement")}&body=${encodeURIComponent(message)}">Envoyer par e-mail</a>` : ""}${phone ? `<a class="btn secondary" target="_blank" rel="noopener" href="https://wa.me/${esc(phone.replace("+", ""))}?text=${encodeURIComponent(message)}">Envoyer par WhatsApp</a>` : ""}</div><p class="muted">Un nouveau lien remplace le précédent.</p><button type="button" class="btn secondary" data-mv="edit" data-id="${cur.id}">‹ Retour à l’inventaire</button>`,
      );
    } catch (e) {
      core().toast(e.message);
    }
  }
  async function makeQuote() {
    try {
      await save(true);
      let newClient = null;
      if (!cur.clientId) {
        const v = await new Promise((resolve) => {
          core().modal(
            "Nouveau client",
            `<form id="mvClient" class="trade-form"><label>Nom<input name="name" required maxlength="200"></label><label>E-mail<input name="email" type="email" required></label><label>Téléphone<input name="phone" maxlength="40"></label><label>Localité<input name="city" required maxlength="200"></label><div class="trade-form-actions"><button type="submit" class="btn primary">Créer le devis</button></div></form>`,
          );
          document.getElementById("mvClient").onsubmit = (e) => {
            e.preventDefault();
            resolve(Object.fromEntries(new FormData(e.target)));
          };
        });
        newClient = v;
      }
      const r = await core().api(`moving/inventories/${cur.id}/quote`, { overrides, newClient });
      core().closeModal(true);
      await core().refresh?.();
      core().setPage?.("quotes");
      core().toast(`Devis ${r.quoteId} créé en brouillon (${money(r.amount)}). Relisez-le puis envoyez-le comme d’habitude.`);
    } catch (e) {
      core().toast(e.message);
    }
  }
  function settingsForm() {
    const company = cfg.companies[0].id;
    const s = cfg.settings[company];
    const f = (k, label, step = "0.05") => `<label>${label}<input type="number" name="${k}" min="0" step="${step}" value="${esc(s[k])}" required></label>`;
    core().modal(
      "Réglages des prix — déménagement",
      `<form id="mvSettings" class="trade-form">${cfg.companies.length > 1 ? `<label>Entreprise<select name="company">${cfg.companies.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")}</select></label>` : `<input type="hidden" name="company" value="${esc(company)}">`}<p class="muted">Ces prix servent au calcul des devis. Les valeurs proposées au départ sont des exemples : mettez vos propres tarifs.</p><div class="mv-grid">${f("moverRate", "Prix par déménageur et par heure (CHF)")}${f("kmRate", "Prix au kilomètre (CHF)")}${f("cartonPrice", "Prix d’un carton (CHF)")}${f("packingPerM3", "Emballage, par m³ (CHF)")}${f("assemblyPrice", "Démontage/remontage, par meuble (CHF)")}${f("pianoPrice", "Supplément piano (CHF)")}${f("productivity", "Rendement : m³ chargés et déchargés par déménageur et par heure")}${f("minHours", "Minimum d’heures facturées", "0.5")}${f("vatRate", "TVA (%)", "0.1")}</div><h4>Véhicules</h4>${s.trucks
        .map(
          (t, i) =>
            `<div class="mv-grid mv-truck"><label>Nom<input name="truckLabel${i}" value="${esc(t.label)}" maxlength="60"></label><label>Volume (m³)<input type="number" name="truckM3${i}" min="1" value="${esc(t.m3)}"></label><label>Prix par heure (CHF)<input type="number" name="truckRate${i}" min="0" step="0.05" value="${esc(t.rate)}"></label></div>`,
        )
        .join("")}<div class="trade-form-actions"><button type="button" class="btn secondary" data-mv="back">‹ Inventaires</button><button type="submit" class="btn primary">Enregistrer</button></div></form>`,
    );
  }

  document.addEventListener("click", async (e) => {
    if (e.target.closest?.('[data-moving-action="open"]')) return open();
    const step = e.target.closest?.(".mv-step");
    if (step && cur) {
      const delta = Number(step.dataset.delta);
      if (step.dataset.mvItem) {
        const id = step.dataset.mvItem;
        const q = Math.max(0, Math.min(999, (itemsOf()[id] || 0) + delta));
        if (q) itemsOf()[id] = q;
        else delete itemsOf()[id];
        const li = step.closest(".mv-item");
        li.querySelector("output").textContent = q;
        li.querySelector('[data-delta="-1"]').disabled = !q;
        li.classList.toggle("has", !!q);
      } else {
        const i = Number(step.dataset.mvCustom);
        const c = cur.inventory.custom[i];
        c.qty = Math.max(0, Math.min(999, c.qty + delta));
        if (!c.qty) {
          cur.inventory.custom.splice(i, 1);
          editor();
          return;
        }
        step.closest(".mv-item").querySelector("output").textContent = c.qty;
      }
      return schedule();
    }
    const b = e.target.closest?.("[data-mv]");
    if (!b) return;
    const what = b.dataset.mv;
    try {
      if (what === "new") {
        cur = blank(cfg.companies[0].id);
        overrides = {};
        core().modal("Nouvel inventaire", "");
        editor();
      } else if (what === "edit") edit(b.dataset.id);
      else if (what === "back") list();
      else if (what === "save") await save();
      else if (what === "link") makeLink();
      else if (what === "quote") makeQuote();
      else if (what === "settings") settingsForm();
      else if (what === "copy") {
        const input = document.getElementById("mvLink");
        input.select();
        await navigator.clipboard?.writeText(input.value).catch(() => document.execCommand?.("copy"));
        core().toast("Lien copié.");
      } else if (what === "delete" && confirm("Supprimer cet inventaire ?")) {
        await core().api(`moving/inventories/${cur.id}/delete`, {});
        core().toast("Inventaire supprimé.");
        list();
      }
    } catch (err) {
      core().toast(err.message);
    }
  });
  document.addEventListener("input", (e) => {
    if (!cur || !e.target.closest?.(".mv-editor")) return;
    const t = e.target;
    if (t.dataset.mvD) {
      det()[t.dataset.mvD] = t.type === "checkbox" ? t.checked : t.type === "number" ? (t.value === "" ? "" : Number(t.value)) : t.value;
      schedule();
    } else if (t.dataset.mvF) {
      if (t.dataset.mvF === "notes") cur.inventory.notes = t.value;
      else cur[t.dataset.mvF] = t.value;
      if (t.dataset.mvF === "company") editor();
    } else if (t.dataset.mvO) {
      overrides[t.dataset.mvO] = t.value;
      schedule();
    }
  });
  document.addEventListener("change", (e) => {
    if (e.target.id === "mvPhotos") photos(e.target);
    else if (e.target.dataset?.mvD && e.target.type === "checkbox") {
      det()[e.target.dataset.mvD] = e.target.checked;
      schedule();
    } else if (e.target.dataset?.mvO) {
      overrides[e.target.dataset.mvO] = e.target.value;
      schedule();
    }
  });
  document.addEventListener("submit", async (e) => {
    if (e.target.id === "mvAdd") {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(e.target));
      (cur.inventory.custom ||= []).push({ label: String(v.label).trim().slice(0, 80), m3: Number(v.m3), qty: 1 });
      editor();
    } else if (e.target.id === "mvSettings") {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(e.target));
      const trucks = [];
      for (let i = 0; v["truckLabel" + i] !== undefined; i++) if (String(v["truckLabel" + i]).trim()) trucks.push({ label: v["truckLabel" + i], m3: Number(v["truckM3" + i]), rate: Number(v["truckRate" + i]) });
      const settings = Object.fromEntries(["moverRate", "kmRate", "cartonPrice", "packingPerM3", "assemblyPrice", "pianoPrice", "productivity", "minHours", "vatRate"].map((k) => [k, Number(v[k])]));
      try {
        const r = await core().api("moving/settings", { company: v.company, settings: { ...settings, trucks } });
        cfg.settings[v.company] = r.settings;
        core().toast("Prix enregistrés.");
        list();
      } catch (err) {
        core().toast(err.message);
      }
    }
  });
  window.SGOMoving = { open, afterRender() {} };
})();
