"use strict";
// The client's moving inventory, opened from the link the company sent (no account).
(() => {
  const token = new URLSearchParams(location.search).get("t") || "";
  const root = document.getElementById("pubContent");
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  let data = null,
    inv = null,
    saving = false;
  const volumeOf = () => {
    let v = 0;
    for (const g of data.catalog) for (const i of g.items) v += (inv.items[i.id] || 0) * i.m3;
    for (const c of inv.custom || []) v += c.m3 * c.qty;
    return Math.round(v * 10) / 10;
  };
  const countOf = () => Object.values(inv.items).reduce((t, q) => t + q, 0) + (inv.custom || []).reduce((t, c) => t + c.qty, 0);

  async function api(body) {
    const r = await fetch("/api/moving-public/" + encodeURIComponent(token), {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || "Le service ne répond pas. Réessayez plus tard.");
    return out;
  }
  function summary() {
    const el = document.getElementById("pubSummary");
    if (el) el.innerHTML = `<b>${countOf()}</b> objet${countOf() > 1 ? "s" : ""} · environ <b>${volumeOf()} m³</b>`;
  }
  function render() {
    const d = inv.details || (inv.details = {});
    const locked = data.locked;
    const access = (side, title) =>
      `<fieldset class="mv-access"><legend>${title}</legend><label class="wide">Adresse<input data-d="${side}Address" maxlength="200" value="${esc(d[side + "Address"] || "")}" autocomplete="street-address"></label><label>Étage (0 = rez)<input type="number" data-d="${side}Floor" min="-3" max="40" inputmode="numeric" value="${esc(d[side + "Floor"] ?? 0)}"></label><label class="mv-check"><input type="checkbox" data-d="${side}Lift" ${d[side + "Lift"] ? "checked" : ""}> Il y a un ascenseur</label><label class="mv-check"><input type="checkbox" data-d="${side}Carry" ${d[side + "Carry"] ? "checked" : ""}> Le camion ne peut pas s’approcher (plus de 20 m)</label></fieldset>`;
    root.innerHTML = `${locked ? '<p class="pub-ok">Votre devis est en préparation à partir de cet inventaire. Pour toute modification, contactez l’entreprise.</p>' : data.submitted ? '<p class="pub-ok">Merci, votre inventaire a bien été envoyé. Vous pouvez encore le corriger puis le renvoyer.</p>' : ""}<form id="pubForm" class="mv-editor" ${locked ? "inert" : ""}><h2>1. Les adresses</h2>${access("from", "Départ")}${access("to", "Arrivée")}<label>Date souhaitée<input type="date" data-d="date" value="${esc(d.date || "")}"></label><h2>2. Vos meubles</h2><p class="muted">Touchez + pour chaque meuble à déménager.</p>${data.catalog
      .map(
        (g) =>
          `<details class="mv-room"><summary><b>${esc(g.room)}</b></summary><ul class="mv-items">${g.items
            .map((i) => {
              const q = inv.items[i.id] || 0;
              return `<li class="mv-item ${q ? "has" : ""}"><span class="mv-item-name">${esc(i.label)}</span><span class="mv-stepper"><button type="button" class="mv-step" data-item="${i.id}" data-delta="-1" aria-label="Retirer : ${esc(i.label)}" ${q ? "" : "disabled"}>−</button><output aria-live="polite">${q}</output><button type="button" class="mv-step" data-item="${i.id}" data-delta="1" aria-label="Ajouter : ${esc(i.label)}">+</button></span></li>`;
            })
            .join("")}</ul></details>`,
      )
      .join("")}<details class="mv-room" open><summary><b>Autres objets</b></summary><ul class="mv-items" id="pubCustom">${(inv.custom || [])
      .map((c, i) => `<li class="mv-item has"><span class="mv-item-name">${esc(c.label)}</span><span class="mv-stepper"><button type="button" class="mv-step" data-custom="${i}" data-delta="-1" aria-label="Retirer : ${esc(c.label)}">−</button><output>${c.qty}</output><button type="button" class="mv-step" data-custom="${i}" data-delta="1" aria-label="Ajouter : ${esc(c.label)}">+</button></span></li>`)
      .join("")}</ul><div class="mv-add"><input id="pubNewLabel" maxlength="80" placeholder="Autre objet (ex. aquarium)"><select id="pubNewSize" aria-label="Taille"><option value="0.2">Petit</option><option value="0.5" selected>Moyen</option><option value="1">Grand</option><option value="2">Très grand</option></select><button type="button" class="btn secondary" id="pubAdd">Ajouter</button></div></details><h2>3. Services</h2><label>Combien de cartons voulez-vous que nous apportions ?<input type="number" data-d="cartonsSupplied" min="0" max="999" inputmode="numeric" value="${esc(d.cartonsSupplied ?? 0)}"></label><label>Meubles à démonter et remonter<input type="number" data-d="assembly" min="0" max="99" inputmode="numeric" value="${esc(d.assembly ?? 0)}"></label><label class="mv-check"><input type="checkbox" data-d="packing" ${d.packing ? "checked" : ""}> Je souhaite que vous emballiez mes affaires</label><label>Remarques (accès, objets fragiles…)<textarea id="pubNotes" maxlength="2000">${esc(inv.notes || "")}</textarea></label></form><div class="pub-bar"><p id="pubSummary"></p>${locked ? "" : '<div class="pub-actions"><button type="button" class="btn secondary" id="pubSave">Enregistrer</button><button type="button" class="btn primary" id="pubSend">Envoyer mon inventaire</button></div>'}<p id="pubState" class="muted" aria-live="polite"></p></div>`;
    summary();
  }
  async function send(submit) {
    if (saving) return;
    saving = true;
    const state = document.getElementById("pubState");
    state.textContent = submit ? "Envoi…" : "Enregistrement…";
    try {
      inv.notes = document.getElementById("pubNotes").value;
      const r = await api({ inventory: inv, submit });
      if (submit) {
        data.submitted = true;
        render();
        document.getElementById("pubState").textContent = "Inventaire envoyé. Merci !";
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else state.textContent = "Enregistré. Vous pouvez revenir plus tard avec le même lien.";
      return r;
    } catch (e) {
      state.textContent = e.message;
    } finally {
      saving = false;
    }
  }
  root.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || !inv) return;
    if (b.classList.contains("mv-step")) {
      const delta = Number(b.dataset.delta);
      if (b.dataset.item) {
        const q = Math.max(0, Math.min(999, (inv.items[b.dataset.item] || 0) + delta));
        if (q) inv.items[b.dataset.item] = q;
        else delete inv.items[b.dataset.item];
        const li = b.closest(".mv-item");
        li.querySelector("output").textContent = q;
        li.querySelector('[data-delta="-1"]').disabled = !q;
        li.classList.toggle("has", !!q);
      } else {
        const c = inv.custom[Number(b.dataset.custom)];
        c.qty = Math.max(0, Math.min(999, c.qty + delta));
        if (!c.qty) inv.custom.splice(Number(b.dataset.custom), 1);
        inv.notes = document.getElementById("pubNotes").value;
        render();
      }
      summary();
    } else if (b.id === "pubAdd") {
      const label = document.getElementById("pubNewLabel").value.trim();
      if (!label) return document.getElementById("pubNewLabel").focus();
      (inv.custom ||= []).push({ label: label.slice(0, 80), m3: Number(document.getElementById("pubNewSize").value), qty: 1 });
      inv.notes = document.getElementById("pubNotes").value;
      render();
    } else if (b.id === "pubSave") send(false);
    else if (b.id === "pubSend") send(true);
  });
  root.addEventListener("input", (e) => {
    const k = e.target.dataset?.d;
    if (!k || !inv) return;
    inv.details[k] = e.target.type === "checkbox" ? e.target.checked : e.target.type === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value;
  });
  (async () => {
    try {
      data = await api();
      inv = { items: {}, custom: [], details: {}, notes: "", ...(data.inventory || {}) };
      inv.items ||= {};
      if (["home", "electricite", "tech", "moving", "solar", "events"].includes(data.company?.id)) document.body.dataset.brand = data.company.id;
      if (data.company?.name) {
        document.getElementById("pubCompany").textContent = data.company.name;
        document.title = "Inventaire de déménagement · " + data.company.name;
      }
      render();
    } catch (e) {
      root.innerHTML = `<p class="pub-error">${esc(e.message)}</p>`;
    }
  })();
})();
