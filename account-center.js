"use strict";
(() => {
  let cache = null,
    loading = false,
    defaultsAppliedFor = "";
  const core = () => window.SGOChatCore,
    esc = (v) => core()?.esc?.(v) ?? String(v ?? ""),
    roles = {
      admin: "Administration",
      direction: "Direction",
      hr: "RH",
      manager: "Responsable",
      accounting: "Comptabilité",
      employee: "Salarié",
      client: "Client",
    };
  const fmt = (v) =>
    v
      ? new Intl.DateTimeFormat("fr-CH", {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(v))
      : "—";
  const dateOnly = (v) =>
    v
      ? new Intl.DateTimeFormat("fr-CH", { dateStyle: "medium" }).format(
          new Date(v + (String(v).length === 10 ? "T12:00:00" : "")),
        )
      : "—";
  const companyName = (id) =>
    core()
      ?.getState?.()
      ?.companies?.find((c) => String(c.id) === String(id))?.name || id || "—";
  function initials(name) {
    return String(name || "?")
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((x) => x[0]?.toUpperCase())
      .join("");
  }
  function switchRow(name, label, checked, help = "") {
    return `<label class="account-switch"><span><b>${esc(label)}</b>${help ? `<small>${esc(help)}</small>` : ""}</span><input type="checkbox" name="${esc(name)}" ${checked ? "checked" : ""}><i></i></label>`;
  }
  function info(label, value) {
    return `<div class="account-info"><span>${esc(label)}</span><b>${esc(value || "—")}</b></div>`;
  }
  function avatar(summary) {
    return summary.account.photo
      ? `<img class="account-avatar" src="${esc(summary.account.photo)}" alt="">`
      : `<div class="account-avatar account-avatar-initial">${esc(initials(summary.account.name))}</div>`;
  }
  function sessionLabel(agent = "") {
    const a = String(agent);
    const browser = a.includes("Edg/")
      ? "Edge"
      : a.includes("Chrome/")
        ? "Chrome"
        : a.includes("Safari/") && !a.includes("Chrome/")
          ? "Safari"
          : a.includes("Firefox/")
            ? "Firefox"
            : "Navigateur";
    const device = /iPhone/.test(a)
      ? "iPhone"
      : /iPad/.test(a)
        ? "iPad"
        : /Android/.test(a)
          ? "Android"
          : /Macintosh/.test(a)
            ? "Mac"
            : /Windows/.test(a)
              ? "Windows"
              : "Appareil";
    return device + " · " + browser;
  }
  function expiryBadge(value) {
    if (!value) return "";
    const days = Math.ceil((new Date(value + "T12:00:00") - Date.now()) / 86400000);
    if (days < 0) return '<span class="account-expiry danger">Expiré</span>';
    if (days <= 60)
      return `<span class="account-expiry warning">Expire dans ${days} j</span>`;
    return "";
  }
  function render(summary) {
    const root = document.getElementById("accountCenter");
    if (!root) return;
    const e = summary.employee,
      c = summary.client,
      p = summary.preferences,
      notif = p.notifications,
      privacy = p.privacy,
      companies = summary.account.companies || [],
      docs = summary.documents || [],
      permitWarning = e?.residencePermitExpiry
        ? expiryBadge(e.residencePermitExpiry)
        : "";

    root.className = "account-center";
    root.innerHTML = `
      <section class="account-profile-card">
        <div class="account-profile-main">
          ${avatar(summary)}
          <div class="account-profile-copy">
            <span class="account-online-dot"></span>
            <h2>${esc(summary.account.name)}</h2>
            <p>${esc(e?.job || roles[summary.account.role] || summary.account.role)}</p>
            <div class="account-tags">
              <span>${esc(roles[summary.account.role] || summary.account.role)}</span>
              ${companies.map((id) => `<span>${esc(companyName(id))}</span>`).join("")}
            </div>
          </div>
        </div>
        <div class="account-profile-actions">
          ${e || c ? '<button class="btn primary" data-account-action="edit-profile">Modifier mon profil</button>' : ""}
          <button class="btn" data-account-nav="messages">Messages</button>
        </div>
      </section>

      <div class="account-grid">
        <section class="card account-section">
          <div class="account-section-head"><div><span class="account-icon">👤</span><h3>Informations personnelles</h3></div></div>
          <div class="account-info-grid">
            ${info("E-mail", summary.account.email)}
            ${info("Téléphone", e?.phone || c?.phone)}
            ${info("Adresse", e ? [e.street, e.zip, e.city].filter(Boolean).join(", ") : c ? [c.street, c.buildingNumber, c.zip, c.city].filter(Boolean).join(" ") : "")}
            ${info("Pays", e?.country || c?.country)}
            ${e ? info("Date de naissance", dateOnly(e.birthDate)) : ""}
            ${e ? info("Nationalité", e.nationality) : ""}
            ${e ? `<div class="account-info"><span>Permis de séjour</span><b>${esc(e.residencePermit || "—")} ${permitWarning}</b></div>` : ""}
            ${e ? info("Contact d’urgence", [e.emergencyName, e.emergencyPhone].filter(Boolean).join(" · ")) : ""}
          </div>
        </section>

        <section class="card account-section">
          <div class="account-section-head"><div><span class="account-icon">💼</span><h3>Informations professionnelles</h3></div></div>
          <div class="account-kpis">
            <div><b>${Number(summary.professional.monthHours || 0).toFixed(2)} h</b><span>Heures ce mois</span></div>
            <div><b>${summary.professional.activeProjects}</b><span>Chantiers actifs</span></div>
            ${e ? `<div><b>${esc(e.vacation ?? "—")}</b><span>Jours de vacances</span></div>` : ""}
          </div>
          <div class="account-info-grid">
            ${e ? info("Fonction", e.job) : ""}
            ${e ? info("Date d’entrée", dateOnly(e.entry)) : ""}
            ${e ? info("Type de contrat", e.contractType) : ""}
            ${e ? info("Taux d’activité", e.activity !== "" ? e.activity + " %" : "") : ""}
            ${info("Entreprise principale", companyName(summary.account.company))}
            ${info("Accès entreprises", companies.map(companyName).join(" · "))}
          </div>
          <div class="account-shortcuts">
            ${e ? '<button class="btn" data-account-nav="planning">Mon planning</button><button class="btn" data-account-nav="time">Mes heures</button><button class="btn" data-account-nav="absences">Mes absences</button>' : ""}
            <button class="btn" data-account-nav="projects">Mes chantiers</button>
          </div>
        </section>

        <section class="card account-section account-security">
          <div class="account-section-head"><div><span class="account-icon">🔐</span><h3>Sécurité du compte</h3></div><span class="status ${summary.security.twoFactorEnabled ? "ok" : "warning"}">${summary.security.twoFactorEnabled ? "2FA active" : "2FA inactive"}</span></div>
          <div class="account-security-actions">
            <button class="btn" data-action="password-form">Changer le mot de passe</button>
            <button class="btn ${summary.security.twoFactorEnabled ? "danger" : "primary"}" data-account-action="${summary.security.twoFactorEnabled ? "2fa-disable" : "2fa-setup"}">${summary.security.twoFactorEnabled ? "Désactiver la 2FA" : "Activer la 2FA"}</button>
          </div>
          <p class="muted">Dernière connexion : ${esc(fmt(summary.security.lastLoginAt))} · ${esc(summary.security.lastLoginIp || "IP non disponible")}</p>
          <h4>Appareils connectés</h4>
          <div class="account-sessions">
            ${summary.security.sessions.length ? summary.security.sessions.map((s) => `
              <div class="account-session">
                <div><b>${esc(sessionLabel(s.userAgent))}${s.current ? ' <span class="status ok">Cet appareil</span>' : ""}</b><span>Dernière activité ${esc(fmt(s.lastSeen))}${s.ip ? " · " + esc(s.ip) : ""}</span></div>
                <button class="btn danger" data-account-action="revoke-session" data-id="${esc(s.id)}">${s.current ? "Déconnecter" : "Fermer la session"}</button>
              </div>`).join("") : '<p class="muted">Aucune session enregistrée.</p>'}
          </div>
          <button class="btn" data-account-action="logout-others">Déconnecter tous les autres appareils</button>
        </section>

        <section class="card account-section">
          <div class="account-section-head"><div><span class="account-icon">🔔</span><h3>Notifications</h3></div></div>
          <form id="accountNotificationForm">
            ${switchRow("messages", "Messages privés", notif.messages)}
            ${switchRow("groups", "Groupes", notif.groups)}
            ${switchRow("calls", "Appels", notif.calls)}
            ${switchRow("projects", "Chantiers", notif.projects)}
            ${switchRow("planning", "Planning", notif.planning)}
            ${switchRow("absences", "Absences", notif.absences)}
            ${switchRow("finance", "Devis et factures", notif.finance)}
            ${switchRow("push", "Notifications push", notif.push)}
            ${switchRow("sound", "Son", notif.sound)}
            ${switchRow("vibration", "Vibration", notif.vibration)}
            <button type="submit" class="btn primary">Enregistrer</button>
          </form>
        </section>

        <section class="card account-section">
          <div class="account-section-head"><div><span class="account-icon">🛡️</span><h3>Messagerie et confidentialité</h3></div></div>
          <label class="account-select">Chiffrement des nouveaux messages
            <select id="accountE2eeMode">
              <option value="auto">Automatique</option>
              <option value="strict">Strict — bloquer sans E2EE</option>
              <option value="off">Désactivé</option>
            </select>
          </label>
          <form id="accountPrivacyForm">
            ${switchRow("lastSeen", "Afficher ma dernière connexion", privacy.lastSeen)}
            ${switchRow("online", "Afficher quand je suis en ligne", privacy.online)}
            ${switchRow("readReceipts", "Confirmations de lecture ✓✓", privacy.readReceipts)}
            <button type="submit" class="btn primary">Enregistrer</button>
          </form>
          <button class="btn" data-suite-action="push">Activer / vérifier les notifications push</button>
          <p class="muted">La clé privée E2EE reste dans ce navigateur.</p>
        </section>

        <section class="card account-section">
          <div class="account-section-head"><div><span class="account-icon">⚙️</span><h3>Préférences de l’application</h3></div></div>
          <form id="accountPreferenceForm" class="account-form-grid">
            <label>Langue<select name="language">
              <option value="fr">Français</option><option value="en">English</option><option value="de">Deutsch</option><option value="it">Italiano</option><option value="pt">Português</option><option value="es">Español</option><option value="sq">Shqip</option>
            </select></label>
            <label>Apparence<select name="theme"><option value="system">Système</option><option value="dark">Sombre</option><option value="light">Clair</option></select></label>
            <label>Entreprise par défaut<select name="defaultCompany"><option value="">Toutes mes données</option>${core().getState().companies.filter((x) => x.id !== "group").map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("")}</select></label>
            <label>Page d’accueil<select name="defaultPage"><option value="dashboard">Tableau de bord</option><option value="time">Heures</option><option value="planning">Planning</option><option value="projects">Chantiers</option><option value="messages">Messages</option><option value="settings">Mon compte</option></select></label>
            <label>Format de date<select name="dateFormat"><option value="CH">Suisse · 27.09.2026</option><option value="ISO">ISO · 2026-09-27</option></select></label>
            <label>Taille du texte<select name="textSize"><option value="small">Petite</option><option value="normal">Normale</option><option value="large">Grande</option></select></label>
            <button type="submit" class="btn primary">Enregistrer les préférences</button>
          </form>
        </section>

        <section class="card account-section account-documents">
          <div class="account-section-head"><div><span class="account-icon">📁</span><h3>Mes documents</h3></div>${e ? '<button class="btn primary" data-account-action="upload-document">Ajouter</button>' : ""}</div>
          <div class="account-document-list">
            ${docs.length ? docs.map((d) => `<div class="account-document"><div><b>${esc(d.documentType || d.name)}</b><span>${esc(d.name)} · ${esc(dateOnly(String(d.createdAt).slice(0,10)))} ${expiryBadge(d.expiresAt)}</span></div><button class="btn" data-account-action="download-document" data-id="${esc(d.id)}" data-name="${esc(d.name)}">Ouvrir</button></div>`).join("") : '<p class="muted">Aucun document personnel disponible.</p>'}
          </div>
        </section>

        <section class="card account-section">
          <div class="account-section-head"><div><span class="account-icon">🕘</span><h3>Activité de mon compte</h3></div></div>
          <div class="account-timeline">
            ${summary.recentUsage?.lastTime ? `<div><i></i><span><b>Dernier pointage · ${esc(summary.recentUsage.lastTime.hours)} h</b><small>${esc(dateOnly(summary.recentUsage.lastTime.date))}${summary.recentUsage.lastTime.project ? " · " + esc(core().getState().projects?.find((p) => String(p.id) === String(summary.recentUsage.lastTime.project))?.title || summary.recentUsage.lastTime.project) : ""}</small></span></div>` : ""}
            ${summary.recentUsage?.lastMessage ? `<div><i></i><span><b>${summary.recentUsage.lastMessage.sentByMe ? "Dernier message envoyé" : "Dernier message reçu"}</b><small>${esc(fmt(summary.recentUsage.lastMessage.createdAt))}</small></span></div>` : ""}
            ${summary.activity.length ? summary.activity.map((a) => `<div><i></i><span><b>${esc(a.action)}</b><small>${esc(fmt(a.created_at))}</small></span></div>`).join("") : (!summary.recentUsage?.lastTime && !summary.recentUsage?.lastMessage ? '<p class="muted">Aucune activité récente.</p>' : "")}
          </div>
        </section>

        <section class="card account-section account-danger-zone">
          <div class="account-section-head"><div><span class="account-icon">⚠️</span><h3>Zone sensible</h3></div></div>
          <p class="muted">Ces actions concernent uniquement votre compte. L’historique métier de l’entreprise n’est jamais supprimé automatiquement.</p>
          <div class="account-shortcuts">
            <button class="btn" data-account-action="export-data">Télécharger mes données</button>
            <button class="btn" data-account-action="disable-notifications">Désactiver toutes les notifications</button>
            <button class="btn" data-account-action="logout-others">Fermer les autres sessions</button>
            <button class="btn danger" data-account-action="deactivation">${summary.pendingDeactivation ? "Demande de désactivation en attente" : "Demander la désactivation du compte"}</button>
          </div>
        </section>
      </div>
    `;
    const prefsForm = document.getElementById("accountPreferenceForm");
    for (const key of ["language","theme","defaultCompany","defaultPage","dateFormat","textSize"])
      if (prefsForm?.elements[key]) prefsForm.elements[key].value = p[key] || "";
    const e2ee = document.getElementById("accountE2eeMode");
    if (e2ee) e2ee.value = localStorage.getItem("sgo_e2ee_mode") || "auto";
    applyPrefs(p);
  }
  function applyPrefs(prefs) {
    window.SGOAccountPreferences = prefs;
    document.documentElement.lang = prefs.language || "fr";
    document.documentElement.dataset.textSize = prefs.textSize || "normal";
    const theme = prefs.theme || "system",
      light = theme === "light" || (theme === "system" && matchMedia("(prefers-color-scheme: light)").matches);
    document.body.classList.toggle("light", light);
    localStorage.setItem("sgo_theme", light ? "light" : "dark");
  }
  async function load(force = false) {
    if (loading) return;
    if (cache && !force) return render(cache);
    loading = true;
    try {
      cache = await core().api("account/summary");
      render(cache);
    } catch (e) {
      core().notice(e.message);
    } finally {
      loading = false;
    }
  }
  async function savePrefs(part, values) {
    const current = cache?.preferences || (await core().api("account/preferences")).preferences,
      next = {
        ...current,
        [part]: part ? { ...(current[part] || {}), ...values } : undefined,
      };
    if (!part) Object.assign(next, values);
    delete next.undefined;
    const out = await core().api("account/preferences", { preferences: next });
    cache.preferences = out.preferences;
    applyPrefs(out.preferences);
    core().toast("Préférences enregistrées.");
    render(cache);
  }
  async function photoData(file) {
    if (!file?.size) return undefined;
    if (file.size > 300000) throw new Error("Photo de 300 Ko maximum.");
    return await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }
  function editProfile() {
    const e = cache.employee, c = cache.client, value = e || c;
    core().modal("Modifier mon profil", `
      <form id="accountProfileForm" class="account-form-grid">
        ${e ? '<label>Photo<input type="file" name="photoFile" accept="image/jpeg,image/png,image/webp"></label>' : ""}
        <label>Téléphone<input name="phone" value="${esc(value?.phone || "")}" maxlength="40"></label>
        <label>Rue<input name="street" value="${esc(value?.street || "")}" maxlength="200"></label>
        ${c ? `<label>Numéro<input name="buildingNumber" value="${esc(c.buildingNumber || "")}" maxlength="30"></label>` : ""}
        <label>Code postal<input name="zip" value="${esc(value?.zip || "")}" maxlength="20"></label>
        <label>Ville<input name="city" value="${esc(value?.city || "")}" maxlength="200"></label>
        <label>Pays<input name="country" value="${esc(value?.country || "")}" maxlength="100"></label>
        ${e ? `<label>Contact d’urgence<input name="emergencyName" value="${esc(e.emergencyName || "")}"></label><label>Téléphone d’urgence<input name="emergencyPhone" value="${esc(e.emergencyPhone || "")}"></label>` : ""}
        <p id="formError" class="error"></p>
        <div class="form-actions"><button type="button" class="btn" data-action="close-modal">Annuler</button><button class="btn primary" type="submit">Enregistrer</button></div>
      </form>`);
  }
  function setup2fa() {
    core().modal("Activer la double authentification", `
      <form id="account2faSetupForm">
        <p>Confirmez d’abord votre mot de passe.</p>
        <label>Mot de passe actuel<input type="password" name="currentPassword" autocomplete="current-password" required></label>
        <p id="formError" class="error"></p>
        <div class="form-actions"><button type="button" class="btn" data-action="close-modal">Annuler</button><button class="btn primary" type="submit">Continuer</button></div>
      </form>`);
  }
  function disable2fa() {
    core().modal("Désactiver la double authentification", `
      <form id="account2faDisableForm">
        <label>Mot de passe actuel<input type="password" name="currentPassword" required></label>
        <label>Code à 6 chiffres<input name="code" inputmode="numeric" maxlength="6" required></label>
        <p id="formError" class="error"></p>
        <button class="btn danger" type="submit">Désactiver la 2FA</button>
      </form>`);
  }
  function uploadDocument() {
    core().modal("Ajouter un document personnel", `
      <form id="accountDocumentForm">
        <label>Type<select name="documentType" required>
          <option>Carte d’identité</option><option>Passeport</option><option>Permis de conduire</option><option>Permis de séjour</option><option>Contrat</option><option>CFC</option><option>Certificat</option><option>Formation</option><option>Attestation</option><option>Autre document RH</option>
        </select></label>
        <label>Description<input name="description" maxlength="200"></label>
        <label>Date d’expiration<input type="date" name="expiresAt"></label>
        <label>Fichier<input type="file" name="file" accept="application/pdf,image/jpeg,image/png,image/webp" required></label>
        <p id="formError" class="error"></p>
        <button class="btn primary" type="submit">Ajouter le document</button>
      </form>`);
  }
  document.addEventListener("click", async (event) => {
    const nav = event.target.closest("[data-account-nav]");
    if (nav) {
      document.querySelector(`[data-page="${CSS.escape(nav.dataset.accountNav)}"]`)?.click();
      return;
    }
    const b = event.target.closest("[data-account-action]");
    if (!b) return;
    try {
      const a = b.dataset.accountAction;
      if (a === "edit-profile") editProfile();
      else if (a === "2fa-setup") setup2fa();
      else if (a === "2fa-disable") disable2fa();
      else if (a === "upload-document") uploadDocument();
      else if (a === "logout-others") {
        await core().api("account/sessions/logout-others", {});
        core().toast("Autres appareils déconnectés.");
        await load(true);
      } else if (a === "revoke-session") {
        const out = await core().api("account/sessions/" + encodeURIComponent(b.dataset.id) + "/revoke", {});
        if (out.current) return location.reload();
        await load(true);
      } else if (a === "download-document") {
        const r = await core().authFetch("/api/state/documents/" + encodeURIComponent(b.dataset.id));
        if (!r.ok) throw new Error("Document inaccessible.");
        const url = URL.createObjectURL(await r.blob()),
          link = document.createElement("a");
        link.href = url; link.download = b.dataset.name || "document"; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      } else if (a === "disable-notifications") {
        const disabled = Object.fromEntries(
          Object.keys(cache.preferences.notifications).map((key) => [key, false]),
        );
        await savePrefs("notifications", disabled);
        core().toast("Toutes les notifications ont été désactivées.");
      } else if (a === "export-data") {
        const r = await core().authFetch("/api/account/export");
        if (!r.ok) throw new Error("Export impossible.");
        const url = URL.createObjectURL(await r.blob()),
          link = document.createElement("a");
        link.href = url; link.download = "sousa-group-one-mes-donnees.json"; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      } else if (a === "deactivation") {
        if (cache.pendingDeactivation) return;
        core().modal("Demander la désactivation", `<form id="accountDeactivateForm"><p>Votre historique métier restera conservé. Un administrateur devra traiter la demande.</p><label>Motif (facultatif)<textarea name="reason" maxlength="1000"></textarea></label><p id="formError" class="error"></p><button class="btn danger" type="submit">Envoyer la demande</button></form>`);
      }
    } catch (e) { core().notice(e.message); }
  });
  document.addEventListener("change", (event) => {
    if (event.target?.id === "accountE2eeMode") {
      localStorage.setItem("sgo_e2ee_mode", event.target.value);
      core().toast("Réglage E2EE enregistré.");
    }
  });
  document.addEventListener("submit", async (event) => {
    const f = event.target;
    if (!/^account/.test(f.id)) return;
    event.preventDefault();
    const data = new FormData(f),
      err = f.querySelector("#formError");
    try {
      if (f.id === "accountProfileForm") {
        const payload = Object.fromEntries(data);
        delete payload.photoFile;
        const photo = await photoData(data.get("photoFile"));
        if (photo !== undefined) payload.photo = photo;
        await core().api("account/profile", payload);
        await core().refresh(false);
        core().closeModal(true);
        await load(true);
        core().toast("Profil mis à jour.");
      } else if (f.id === "account2faSetupForm") {
        const out = await core().api("account/2fa/setup", { currentPassword: data.get("currentPassword") });
        core().modal("Configurer l’application d’authentification", `
          <form id="account2faEnableForm">
            <p>Ajoutez ce compte dans Google Authenticator, Microsoft Authenticator ou 1Password.</p>
            <div class="account-secret"><code>${esc(out.secret)}</code><button type="button" class="btn" data-account-copy="${esc(out.secret)}">Copier</button></div>
            <details><summary>Lien de configuration</summary><code class="account-uri">${esc(out.uri)}</code></details>
            <label>Code à 6 chiffres<input name="code" inputmode="numeric" maxlength="6" required autofocus></label>
            <p id="formError" class="error"></p>
            <button class="btn primary" type="submit">Vérifier et activer</button>
          </form>`);
      } else if (f.id === "account2faEnableForm") {
        await core().api("account/2fa/enable", { code: data.get("code") });
        core().closeModal(true); await load(true); core().toast("Double authentification activée.");
      } else if (f.id === "account2faDisableForm") {
        await core().api("account/2fa/disable", Object.fromEntries(data));
        core().closeModal(true); await load(true); core().toast("Double authentification désactivée.");
      } else if (f.id === "accountNotificationForm") {
        await savePrefs(
          "notifications",
          Object.fromEntries(
            Object.keys(cache.preferences.notifications).map((key) => [
              key,
              data.has(key),
            ]),
          ),
        );
      } else if (f.id === "accountPrivacyForm") {
        await savePrefs("privacy", Object.fromEntries(Object.keys(cache.preferences.privacy).map((k) => [k, data.has(k)])));
      } else if (f.id === "accountPreferenceForm") {
        await savePrefs(null, Object.fromEntries(data));
      } else if (f.id === "accountDocumentForm") {
        const file = data.get("file");
        if (!file?.size || file.size > 5 * 1024 * 1024) throw new Error("Fichier de 5 Mo maximum.");
        const content = await new Promise((resolve, reject) => {
          const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1]); r.onerror = reject; r.readAsDataURL(file);
        });
        await core().api("state/documents", {
          action: "Document personnel ajouté",
          revision: core().getRevision(),
          requestId: crypto.randomUUID(),
          payload: {
            company: cache.employee.companies?.[0] || cache.account.company,
            employeeId: cache.employee.id,
            category: "identity",
            documentType: data.get("documentType"),
            description: data.get("description"),
            expiresAt: data.get("expiresAt"),
            name: file.name,
            mime: file.type,
            content,
          },
        });
        await core().refresh(false); core().closeModal(true); await load(true); core().toast("Document ajouté.");
      } else if (f.id === "accountDeactivateForm") {
        await core().api("account/deactivation-request", { reason: data.get("reason") });
        core().closeModal(true); await load(true); core().toast("Demande envoyée.");
      }
    } catch (e) {
      if (err) err.textContent = e.message;
      else core().notice(e.message);
    }
  });
  document.addEventListener("click", async (event) => {
    const b = event.target.closest("[data-account-copy]");
    if (!b) return;
    await navigator.clipboard?.writeText(b.dataset.accountCopy);
    core().toast("Clé copiée.");
  });
  async function bootstrapPrefs() {
    try {
      const me = core()?.getProfile?.();
      if (!me) return;
      const out = await core().api("account/preferences"),
        prefs = out.preferences;
      applyPrefs(prefs);
      const userKey = String(me.id || me.email || "");
      if (defaultsAppliedFor !== userKey) {
        defaultsAppliedFor = userKey;
        const params = new URLSearchParams(location.search);
        if (!params.has("open")) {
          if (prefs.defaultCompany) core().setCompany?.(prefs.defaultCompany);
          if (
            core().getPage?.() === "dashboard" &&
            prefs.defaultPage &&
            prefs.defaultPage !== "dashboard"
          )
            core().setPage?.(prefs.defaultPage);
        }
      }
    } catch {}
  }
  window.SGOAccountCenter = {
    afterRender() {
      if (core()?.getPage?.() === "settings") load();
      else if (!window.SGOAccountPreferences) bootstrapPrefs();
    },
    refresh: () => load(true),
  };
})();
