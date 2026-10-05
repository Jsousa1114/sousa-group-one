"use strict";
(() => {
  const core = () => window.SGOChatCore;
  const esc = (v) => core().esc(String(v ?? ""));
  const api = (path, body) => core().api("suppliers/" + path, body);
  const money = (n) =>
    Number(n).toLocaleString("fr-CH", {
      style: "currency",
      currency: "CHF",
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
  const productMedia = (o) => {
    const safe = (value, image = false) => {
      try {
        const u = new URL(value);
        return u.protocol === "https:" &&
          !u.username &&
          !u.password &&
          !u.port &&
          (u.hostname === "elektro-material.ch" ||
            u.hostname.endsWith(".elektro-material.ch") ||
            (image && u.hostname === "emagpim-1d1da.kxcdn.com"))
          ? u.href
          : "";
      } catch {
        return "";
      }
    };
    const image = safe(o.image_url, true),
      link = safe(o.produit_url);
    return `${image ? `<img class="supplier-product-image" src="${esc(image)}" alt="${esc(o.designation)}" loading="lazy" referrerpolicy="no-referrer" width="96" height="96">` : '<span class="supplier-no-image">Photo non disponible</span>'}${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">Fiche Electro-Matériel ↗</a>` : ""}`;
  };
  let chosenCompany = "",
    query = "",
    quantity = 1,
    selectedVendor = "em",
    offset = 0,
    sequence = 0;
  function companyOptions(selected) {
    return (core().getState().companies || [])
      .filter((x) => x.id !== "group")
      .map(
        (x) =>
          `<option value="${esc(x.id)}" ${selected === x.id ? "selected" : ""}>${esc(x.name)}</option>`,
      )
      .join("");
  }
  async function render(host) {
    if (!host) return;
    const current = ++sequence;
    let directory,
      request = 0;
    const companies = (core().getState().companies || []).filter(
      (x) => x.id !== "group",
    );
    const c =
      core().getCompany() ||
      chosenCompany ||
      (companies.length === 1 ? companies[0].id : "");
    chosenCompany = companies.some((x) => x.id === c) ? c : "";
    host.className = "supplier-suite";
    host.innerHTML = `<section class="card"><div class="supplier-heading"><div><p class="muted">ACHATS ÉLECTRIQUES</p><h2>Catalogues & comparaison</h2><p>Vos tarifs fournisseurs, réunis par article.</p></div><label>Entreprise<select id="supplierCompany"><option value="">Choisir une entreprise</option>${companyOptions(chosenCompany)}</select></label></div><div id="supplierDirectory" class="supplier-grid"><p>Chargement des fournisseurs…</p></div><p><strong>Connexion personnelle sur le site du fournisseur.</strong> Le bouton ouvre un nouvel onglet où vous saisissez vous-même vos identifiants. Votre session reste sur ce site ; Sousa Group One ne reçoit pas vos mots de passe et ne synchronise pas les prix par cette connexion.</p><p class="muted">Import de vos exports tarifaires au format CSV du modèle. Aucune synchronisation automatique : les catalogues complets et vos remises nécessitent des données fournies par vos comptes fournisseurs.</p><div class="supplier-actions"><button type="button" class="btn" id="supplierEnable">Ajouter Electro-Matériel à mes fournisseurs</button><button type="button" class="btn" id="supplierTemplate">Modèle CSV</button></div><p id="supplierStatus" role="status"></p></section><section class="card"><h3>Matériel & prix</h3><form id="supplierSearch" class="supplier-actions"><label>Article, référence, EAN ou numéro E<input name="q" value="${esc(query)}" placeholder="Rechercher dans les tarifs importés"></label><label>Catalogue<select name="vendor"><option value="em">Electro-Matériel</option><option value="">Tous les fournisseurs</option><option value="sonepar">Sonepar Suisse</option><option value="otto-fischer">Otto Fischer</option></select></label><label>Quantité souhaitée<input name="quantity" type="number" min="0.001" step="any" max="10000000" value="${esc(quantity)}" required></label><button class="btn primary" type="submit">Rechercher</button></form><p class="muted">CHF hors TVA et frais de livraison. Tarifs nets et publics séparés. Comparaison par GTIN/EAN identique, ou numéro E lorsque le GTIN est absent. Prix de plus de 30 jours à confirmer. Disponibilité et frais supplémentaires à vérifier auprès du fournisseur.</p><div id="supplierResults" aria-live="polite"></div></section>`;
    const status = (message) => {
      if (host.isConnected)
        host.querySelector("#supplierStatus").textContent = message;
    };
    host.querySelector("#supplierCompany").onchange = (e) => {
      chosenCompany = e.target.value;
      core().setCompany(chosenCompany);
    };
    host.querySelector('#supplierSearch [name="vendor"]').value =
      selectedVendor;
    host.querySelector("#supplierSearch").onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      query = String(f.get("q"));
      quantity = Number(f.get("quantity"));
      selectedVendor = String(f.get("vendor"));
      offset = 0;
      await load();
    };
    host.querySelector("#supplierEnable").onclick = async (e) => {
      if (!chosenCompany)
        return status(
          "Choisissez une entreprise pour ajouter ses fournisseurs.",
        );
      e.target.disabled = true;
      try {
        const out = await api("enable", {
          company: chosenCompany,
          vendor: "em",
        });
        await core().refresh();
        core().toast(
          out.added
            ? `${out.added} fournisseur(s) ajouté(s).`
            : "Les fournisseurs sont déjà présents.",
        );
      } catch (error) {
        status(error.message);
      } finally {
        e.target.disabled = false;
      }
    };
    try {
      directory = await api("directory");
    } catch (error) {
      status(error.message);
      return;
    }
    if (current !== sequence || !host.isConnected) return;
    host.querySelector("#supplierTemplate").onclick = () => {
      const blob = new Blob(["\uFEFF" + directory.headers.join(";") + "\r\n"], {
        type: "text/csv;charset=utf-8",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "modele-tarifs-fournisseurs.csv";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    host.querySelector("#supplierDirectory").innerHTML = directory.vendors
      .map(
        (v) =>
          `<article class="supplier-vendor"><span class="supplier-monogram" aria-hidden="true">${esc(v.id === "em" ? "EM" : v.id === "sonepar" ? "S" : "OF")}</span><h3>${esc(v.name)}</h3><p data-vendor-status="${esc(v.id)}">Aucun tarif chargé</p><a class="btn primary" data-supplier-login="${esc(v.id)}" href="${esc(v.loginUrl || v.url)}" target="_blank" rel="noopener noreferrer" aria-label="Se connecter chez ${esc(v.name)} — nouvel onglet">Se connecter chez ${esc(v.name)} ↗</a><small>${esc(v.loginHelp || "Connectez-vous sur le site officiel du fournisseur.")}</small><a class="btn" href="${esc(v.url)}" target="_blank" rel="noopener noreferrer">Ouvrir le catalogue officiel ↗</a><button type="button" class="btn" data-import="${esc(v.id)}">Importer mes prix</button></article>`,
      )
      .join("");
    host.querySelectorAll("[data-import]").forEach((button) => {
      button.onclick = () => {
        if (!chosenCompany)
          return status(
            "Choisissez d’abord l’entreprise à laquelle appartiennent ces tarifs.",
          );
        importForm(
          directory.vendors.find((v) => v.id === button.dataset.import),
          chosenCompany,
          load,
        );
      };
    });
    async function load() {
      const id = ++request;
      const results = host.querySelector("#supplierResults");
      if (!directory) {
        results.textContent = "Chargement des fournisseurs…";
        return;
      }
      if (!chosenCompany) {
        results.textContent =
          "Sélectionnez une entreprise pour consulter ses tarifs.";
        return;
      }
      results.textContent = "Chargement des tarifs…";
      try {
        const out = await api(
          "catalog?" +
            new URLSearchParams({
              company: chosenCompany,
              q: query,
              quantity: String(quantity),
              vendor: selectedVendor,
              offset: String(offset),
            }),
        );
        if (id !== request || !host.isConnected) return;
        for (const v of directory.vendors) {
          const catalog = out.catalogs.find((x) => x.vendor === v.id);
          host.querySelector(`[data-vendor-status="${v.id}"]`).textContent =
            catalog
              ? `${catalog.count} articles · import ${new Date(catalog.importedAt).toLocaleDateString("fr-CH")}`
              : "Aucun tarif chargé";
        }
        results.innerHTML = !out.groups.length
          ? `<p>Aucun article trouvé. Importez vos prix depuis une carte fournisseur pour commencer.</p>`
          : `${out.totalGroups > 200 ? `<p>Articles regroupés ${offset + 1}–${offset + out.groups.length} sur ${out.totalGroups}.</p>` : ""}${out.groups.map((g) => `<article class="supplier-comparison"><div class="supplier-heading"><h4>${esc(g.identity)} · ${esc(g.unit)}</h4><span class="badge">${g.priceType === "net" ? "Tarif négocié" : "Tarif public"}</span></div>${!g.comparable && !selectedVendor ? '<p class="muted">Comparaison indisponible : au moins deux fournisseurs avec un tarif récent et valide sont nécessaires.</p>' : ""}<div class="supplier-table"><table><thead><tr><th>Fournisseur / article</th><th>Prix unitaire HT</th><th>Quantité facturée</th><th>Total HT</th><th>Date / source</th></tr></thead><tbody>${g.offers.map((o) => `<tr class="${g.comparable && !o.stale && !o.expired && !o.notes_prix && o.total !== null && o.total === g.bestTotal ? "supplier-best" : ""}"><td>${productMedia(o)}<strong>${esc(directory.vendors.find((v) => v.id === o.vendor)?.name)}</strong><br>${esc(o.designation)}<br><small>${esc(o.reference)}</small></td><td>${money(o.unitPrice)} / ${esc(o.unite)}<br><small>${money(o.prix_chf_ht)} pour ${esc(o.prix_pour)}</small></td><td>${o.ordered === null ? "À confirmer" : `${esc(o.ordered)} ${esc(o.unite)}`}<br><small>${o.conditionnement ? `Lot de ${esc(o.conditionnement)}` : "Conditionnement non relevé"}</small></td><td><strong>${o.total === null ? "Non calculable" : money(o.total)}</strong>${g.comparable && !o.stale && !o.expired && !o.notes_prix && o.total !== null && o.total === g.bestTotal ? "<br><span>Meilleur total comparable</span>" : ""}</td><td>${esc(o.date_prix)}${o.expired ? " · Expiré" : o.stale ? " · À confirmer (> 30 jours)" : ""}<br><small>${esc(o.source)}</small>${o.notes_prix ? `<p class="supplier-price-note">${esc(o.notes_prix)}</p>` : ""}${o.valable_jusquau ? "<br>Valable jusqu’au " + esc(o.valable_jusquau) : ""}</td></tr>`).join("")}</tbody></table></div></article>`).join("")}`;
        results.querySelectorAll(".supplier-product-image").forEach((img) => {
          img.onerror = () => {
            const placeholder = document.createElement("span");
            placeholder.className = "supplier-no-image";
            placeholder.textContent = "Photo indisponible";
            img.replaceWith(placeholder);
          };
          if (img.complete && !img.naturalWidth) img.onerror();
        });
        if (offset || out.nextOffset != null) {
          const nav = document.createElement("nav");
          nav.className = "supplier-actions";
          nav.setAttribute("aria-label", "Pages du catalogue");
          for (const [label, next] of [
            ["Précédent", offset ? Math.max(0, offset - 200) : null],
            ["Suivant", out.nextOffset],
          ]) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "btn";
            button.textContent = label;
            button.disabled = next == null;
            button.onclick = async () => {
              offset = next;
              await load();
            };
            nav.append(button);
          }
          results.append(nav);
        }
      } catch (error) {
        if (id === request && host.isConnected)
          results.textContent = error.message;
      }
    }
    await load();
  }
  function importForm(vendor, company, reload) {
    core().modal(
      "Importer les prix · " + vendor.name,
      `<form id="supplierImportForm"><p>L’import remplace tous les articles précédemment importés pour ce fournisseur et cette entreprise. Utilisez le modèle CSV ; aucun tarif n’est ajouté sans validation.</p><p><strong>Colonnes :</strong> référence, désignation, EAN et/ou numéro E ; unité <code>pcs, m, kg, l</code> ; prix CHF HT ; nombre d’unités couvertes par ce prix ; conditionnement minimal (laisser vide s’il est inconnu : aucun total ne sera calculé) ; type <code>net</code> ou <code>public</code> ; date du prix et fin de validité facultative au format <code>AAAA-MM-JJ</code>.</p><p>Colonnes facultatives : <code>image_url</code> et <code>produit_url</code> (liens HTTPS Electro-Matériel), <code>notes_prix</code> (frais et réserves ; exclut le tarif du classement du meilleur prix).</p><p>Un fichier correspond à un tarif applicable à toutes les quantités. Les remises par palier, frais cuivre, écocontributions et transport doivent être vérifiés séparément. Sans EAN ni numéro E, l’article reste consultable mais ne sera pas rapproché d’un autre fournisseur.</p><label>Source du tarif<input name="source" maxlength="200" required placeholder="Ex. export de mon compte client du 04.10.2026"></label><label>Fichier CSV (4 Mo, 10 000 articles maximum)<input type="file" name="file" accept=".csv,text/csv" required></label><div id="supplierPreview" role="status"></div><button type="submit" class="btn primary">Vérifier le fichier</button><button type="button" class="btn" id="supplierConfirm" disabled>Confirmer le remplacement</button></form>`,
    );
    const form = document.querySelector("#supplierImportForm"),
      preview = form.querySelector("#supplierPreview"),
      confirm = form.querySelector("#supplierConfirm");
    let validated = null;
    form.oninput = () => {
      validated = null;
      confirm.disabled = true;
      preview.textContent =
        "Fichier ou source modifié : vérifiez à nouveau avant de confirmer.";
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      confirm.disabled = true;
      validated = null;
      const button = form.querySelector('[type="submit"]');
      button.disabled = true;
      try {
        const file = form.elements.file.files[0];
        if (!file || file.size > 4 * 1024 * 1024)
          throw new Error("Sélectionnez un CSV de 4 Mo maximum.");
        const data = {
          company,
          vendor: vendor.id,
          source: form.elements.source.value,
          csv: await file.text(),
        };
        const result = await api("preview", data);
        // Do not confirm a preview if its inputs changed while the request was running.
        if (
          form.elements.file.files[0] !== file ||
          form.elements.source.value !== data.source
        )
          throw new Error(
            "Les champs ont changé. Vérifiez à nouveau le fichier.",
          );
        validated = data;
        preview.innerHTML = `<p><strong>${result.count} articles valides.</strong> ${result.unmatched} sans identifiant de comparaison.</p><ul>${result.sample.map((x) => `<li>${esc(x.reference)} · ${esc(x.designation)} · ${money(x.prix_chf_ht)} pour ${esc(x.prix_pour)} ${esc(x.unite)}</li>`).join("")}</ul><p>Ces articles remplaceront le tarif ${esc(vendor.name)} de l’entreprise sélectionnée.</p>`;
        confirm.disabled = false;
      } catch (error) {
        preview.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    };
    confirm.onclick = async () => {
      if (!validated) return;
      confirm.disabled = true;
      try {
        const result = await api("import", validated);
        core().closeModal();
        core().toast(`${result.count} articles importés.`);
        await reload();
      } catch (error) {
        preview.textContent = error.message;
        confirm.disabled = false;
      }
    };
  }
  window.SGOSuppliers = { render };
})();
