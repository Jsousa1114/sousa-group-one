"use strict";
(() => {
  const DB_NAME = "sgo-p2-offline";
  const STORE = "mutations";
  let eventSource = null;
  let eventRefreshTimer = null;
  let deferredInstallPrompt = null;
  let flushing = false;

  const core = () => window.SGOChatCore;
  const esc = (value) =>
    String(value == null ? "" : value).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE))
          db.createObjectStore(STORE, { keyPath: "requestId" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function withStore(mode, fn) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        let value;
        try {
          value = fn(store);
        } catch (error) {
          reject(error);
          return;
        }
        tx.oncomplete = () => resolve(value);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("Transaction annulée."));
      });
    } finally {
      db.close();
    }
  }

  async function queueCount() {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).count();
        req.onsuccess = () => resolve(req.result || 0);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }

  async function queuedItems() {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () =>
          resolve(
            (req.result || []).sort((a, b) =>
              String(a.createdAt).localeCompare(String(b.createdAt)),
            ),
          );
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  }

  async function removeQueued(requestId) {
    return withStore("readwrite", (store) => store.delete(requestId));
  }

  function safeOfflineMutation(item) {
    if (!item) return false;
    if (item.endpoint === "state/documents") return true;
    if (
      item.endpoint === "state/command" &&
      item.action === "create" &&
      ["time"].includes(String(item.collection || ""))
    )
      return true;
    return false;
  }

  async function queueMutation(item) {
    if (!safeOfflineMutation(item)) return false;
    await withStore("readwrite", (store) =>
      store.put({
        requestId: item.requestId,
        action: item.action,
        payload: item.payload || {},
        collection: item.collection || null,
        endpoint: item.endpoint || "state/command",
        createdAt: new Date().toISOString(),
      }),
    );
    updateOfflineBadge().catch(() => {});
    return true;
  }

  async function flushQueue() {
    if (flushing || !navigator.onLine || !core()?.getProfile?.()) return;
    flushing = true;
    try {
      const items = await queuedItems();
      for (const item of items) {
        try {
          await core().refresh(false);
          await core().api(item.endpoint, {
            action: item.action,
            payload: item.payload,
            collection: item.collection,
            revision: core().getRevision(),
            requestId: item.requestId,
          });
          await removeQueued(item.requestId);
        } catch (error) {
          if (error && error.status === 409) {
            try {
              await core().refresh(false);
              await core().api(item.endpoint, {
                action: item.action,
                payload: item.payload,
                collection: item.collection,
                revision: core().getRevision(),
                requestId: item.requestId,
              });
              await removeQueued(item.requestId);
              continue;
            } catch {}
          }
          break;
        }
      }
      await core().refresh().catch(() => {});
    } finally {
      flushing = false;
      updateOfflineBadge().catch(() => {});
    }
  }

  async function updateOfflineBadge() {
    const node = document.getElementById("p2OfflineQueueCount");
    if (node) node.textContent = String(await queueCount());
  }

  function scheduleLiveRefresh() {
    clearTimeout(eventRefreshTimer);
    eventRefreshTimer = setTimeout(() => {
      if (!core()?.getProfile?.()) return;
      core().refresh().catch(() => {});
      if (document.querySelector("#p2AdvancedPanel"))
        renderPanel(document.querySelector("#opsBody")).catch(() => {});
    }, 350);
  }

  function ensureRealtime() {
    if (eventSource || !navigator.onLine || !core()?.getProfile?.()) return;
    eventSource = new EventSource("/api/p2/events", { withCredentials: true });
    eventSource.addEventListener("update", scheduleLiveRefresh);
    eventSource.onerror = () => {
      try {
        eventSource.close();
      } catch {}
      eventSource = null;
      setTimeout(ensureRealtime, 4000);
    };
  }

  function stopRealtime() {
    if (!eventSource) return;
    try {
      eventSource.close();
    } catch {}
    eventSource = null;
  }

  function roleIs(...roles) {
    return roles.includes(core()?.getProfile?.()?.role);
  }

  async function get(path) {
    return core().api("p2/" + path);
  }

  async function post(path, body) {
    return core().api("p2/" + path, body);
  }

  function money(value) {
    return new Intl.NumberFormat("fr-CH", {
      style: "currency",
      currency: "CHF",
      maximumFractionDigits: 2,
    }).format(Number(value) || 0);
  }

  function statusLabel(value) {
    return (
      {
        pending: "En attente",
        approved: "Approuvé",
        rejected: "Refusé",
        confirmed: "Confirmé",
        cancelled: "Annulé",
        waiting_configuration: "À configurer",
        sent: "Envoyé",
        failed: "Échec",
      }[value] || value || "—"
    );
  }

  function chartBars(weeks) {
    const max = Math.max(1, ...(weeks || []).map((x) => Number(x.projected) || 0));
    if (!weeks?.length)
      return '<p class="muted">Pas encore de données de prévision.</p>';
    return (
      '<div class="p2-bars">' +
      weeks
        .map((x) => {
          const pct = Math.max(
            3,
            Math.round(((Number(x.projected) || 0) / max) * 100),
          );
          return (
            '<div class="p2-bar-row">' +
            '<span>' +
            esc(x.week) +
            "</span>" +
            '<div class="p2-bar-track"><i style="width:' +
            pct +
            '%"></i></div>' +
            "<b>" +
            esc(money(x.projected)) +
            "</b>" +
            "</div>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function renderAppointments(rows) {
    if (!rows?.length)
      return '<p class="muted">Aucune demande de rendez-vous.</p>';
    return (
      '<div class="p2-list">' +
      rows
        .slice(0, 12)
        .map(
          (x) =>
            '<article class="p2-list-row">' +
            "<div><b>" +
            esc(x.title) +
            "</b><small>" +
            esc(new Date(x.start_at).toLocaleString("fr-CH")) +
            " → " +
            esc(new Date(x.end_at).toLocaleString("fr-CH")) +
            "</small></div>" +
            '<span class="status neutral">' +
            esc(statusLabel(x.status)) +
            "</span>" +
            (roleIs("admin", "direction", "manager", "employee") &&
            x.status === "pending"
              ? '<div class="form-actions"><button class="btn" data-p2-action="appointment-status" data-id="' +
                esc(x.id) +
                '" data-status="confirmed">Confirmer</button><button class="btn danger" data-p2-action="appointment-status" data-id="' +
                esc(x.id) +
                '" data-status="rejected">Refuser</button></div>'
              : "") +
            "</article>",
        )
        .join("") +
      "</div>"
    );
  }

  function renderApprovals(rows) {
    if (!rows?.length)
      return '<p class="muted">Aucune approbation.</p>';
    return (
      '<div class="p2-list">' +
      rows
        .slice(0, 12)
        .map(
          (x) =>
            '<article class="p2-list-row">' +
            "<div><b>" +
            esc(x.title) +
            "</b><small>" +
            esc(x.request_type) +
            (x.amount != null ? " · " + esc(money(x.amount)) : "") +
            "</small></div>" +
            '<span class="status neutral">' +
            esc(statusLabel(x.status)) +
            "</span>" +
            (x.status === "pending" &&
            roleIs("admin", "direction", "manager", "hr", "accounting")
              ? '<div class="form-actions"><button class="btn" data-p2-action="approval-decision" data-id="' +
                esc(x.id) +
                '" data-decision="approved">Approuver</button><button class="btn danger" data-p2-action="approval-decision" data-id="' +
                esc(x.id) +
                '" data-decision="rejected">Refuser</button></div>'
              : "") +
            "</article>",
        )
        .join("") +
      "</div>"
    );
  }

  async function renderPanel(container) {
    if (!container) return;
    ensureRealtime();

    const profile = core().getProfile();
    const staff = roleIs(
      "admin",
      "direction",
      "manager",
      "hr",
      "accounting",
      "employee",
    );
    const financeStaff = roleIs(
      "admin",
      "direction",
      "manager",
      "accounting",
    );

    const requests = [
      get("status").catch(() => ({})),
      get("appointments").catch(() => ({ appointments: [] })),
      get("approvals").catch(() => ({ approvals: [] })),
    ];
    if (financeStaff) {
      requests.push(
        get("analytics/forecast?days=90").catch(() => ({ weeks: [] })),
        get("quote-followups").catch(() => ({ followups: [] })),
      );
    }
    const out = await Promise.all(requests);
    const status = out[0] || {};
    const appointments = out[1]?.appointments || [];
    const approvals = out[2]?.approvals || [];
    const forecast = financeStaff ? out[3] || {} : {};
    const followups = financeStaff ? out[4]?.followups || [] : [];
    const queued = await queueCount();

    const highReadability =
      localStorage.getItem("sgo_high_readability") === "1";

    container.innerHTML =
      '<section id="p2AdvancedPanel" class="p2-panel">' +
      '<div class="p2-hero card"><div><span class="ops-eyebrow">P2</span><h3>Plateforme avancée</h3><p>Temps réel, hors ligne, calendrier, validations et intégrations.</p></div>' +
      '<div class="form-actions">' +
      '<button class="btn" data-p2-action="toggle-readability">' +
      (highReadability ? "Lisibilité normale" : "Haute lisibilité") +
      "</button>" +
      '<button class="btn primary ' +
      (deferredInstallPrompt ? "" : "hidden") +
      '" id="p2InstallButton" data-p2-action="install">Installer l’application</button>' +
      "</div></div>" +
      '<div class="p2-kpis">' +
      '<article class="card"><span>Temps réel</span><b>' +
      (status.realtime ? "Actif" : "—") +
      "</b></article>" +
      '<article class="card"><span>Actions hors ligne</span><b id="p2OfflineQueueCount">' +
      esc(queued) +
      "</b></article>" +
      '<article class="card"><span>Email</span><b>' +
      (status.configured?.email ? "Connecté" : "À configurer") +
      "</b></article>" +
      '<article class="card"><span>SMS</span><b>' +
      (status.configured?.sms ? "Connecté" : "À configurer") +
      "</b></article>" +
      "</div>" +
      '<div class="p2-grid">' +
      '<article class="card"><div class="ops-card-head"><div><h3>Calendrier Google / Outlook</h3><p>Abonnement iCal à votre planning.</p></div></div>' +
      (status.calendarFeed
        ? '<p>Un flux calendrier est actif.</p><div class="form-actions"><button class="btn" data-p2-action="calendar-new">Régénérer le lien</button><button class="btn danger" data-p2-action="calendar-revoke">Révoquer</button></div>'
        : '<p class="muted">Créez un lien privé puis ajoutez-le comme calendrier par URL dans Google Calendar ou Outlook.</p><button class="btn primary" data-p2-action="calendar-new">Créer le lien calendrier</button>') +
      '<div id="p2CalendarResult"></div></article>' +
      '<article class="card"><h3>Rendez-vous</h3>' +
      (profile.role === "client"
        ? '<form id="p2AppointmentForm"><label>Motif<input name="title" maxlength="240" required></label><div class="grid g2"><label>Début<input type="datetime-local" name="startAt" required></label><label>Fin<input type="datetime-local" name="endAt" required></label></div><label>Note<textarea name="notes" maxlength="2000"></textarea></label><button class="btn primary" type="submit">Demander le rendez-vous</button></form>'
        : "") +
      renderAppointments(appointments) +
      "</article>" +
      '<article class="card"><h3>Approbations</h3>' +
      (staff
        ? '<form id="p2ApprovalForm"><div class="grid g2"><label>Type<select name="type"><option value="expense">Dépense</option><option value="purchase">Achat</option><option value="quote">Devis</option><option value="invoice">Facture</option><option value="absence">Absence</option><option value="change_order">Plus-value</option><option value="other">Autre</option></select></label><label>Montant CHF<input name="amount" type="number" min="0" step="0.01"></label></div><label>Titre<input name="title" maxlength="240" required></label><button class="btn primary" type="submit">Soumettre</button></form>'
        : "") +
      renderApprovals(approvals) +
      "</article>" +
      (financeStaff
        ? '<article class="card p2-wide"><div class="ops-card-head"><div><h3>Prévision de trésorerie — 90 jours</h3><p>Factures ouvertes + devis en cours pondérés à 35 %.</p></div><b>' +
          esc(money((forecast.outstandingInvoices || 0) + (forecast.weightedQuotes || 0))) +
          "</b></div>" +
          chartBars(forecast.weeks || []) +
          "</article>"
        : "") +
      (financeStaff
        ? '<article class="card"><h3>Relances devis</h3>' +
          (followups.length
            ? '<div class="p2-list">' +
              followups
                .slice(0, 10)
                .map(
                  (x) =>
                    '<div class="p2-list-row"><div><b>' +
                    esc(x.title) +
                    "</b><small>" +
                    esc(x.client) +
                    " · " +
                    esc(money(x.amount)) +
                    "</small></div><span>" +
                    esc(x.daysToValidity == null ? "À relancer" : x.daysToValidity + " j") +
                    "</span></div>",
                )
                .join("") +
              "</div>"
            : '<p class="muted">Aucune relance urgente.</p>') +
          "</article>"
        : "") +
      (financeStaff
        ? '<article class="card"><h3>Email / SMS intégré</h3><form id="p2OutboundForm"><label>Canal<select name="channel"><option value="email">Email</option><option value="sms">SMS</option></select></label><label>Destinataire<input name="recipient" required maxlength="320"></label><label>Objet<input name="subject" maxlength="300"></label><label>Message<textarea name="message" required maxlength="5000"></textarea></label><button class="btn primary" type="submit">Envoyer</button></form><p class="muted">Si le fournisseur n’est pas encore configuré, le message reste marqué « À configurer ».</p></article>'
        : "") +
      (profile.role === "admin" && profile.company === "group"
        ? '<article class="card"><h3>Permission personnalisée</h3><form id="p2PermissionForm"><label>ID utilisateur<input name="userId" type="number" min="1" required></label><label>Permission<input name="permission" placeholder="ex. approvals.decide" maxlength="120" required></label><label><input name="allowed" type="checkbox" checked> Autoriser</label><button class="btn primary" type="submit">Enregistrer</button></form></article>'
        : "") +
      "</div></section>";

    updateOfflineBadge().catch(() => {});
  }

  async function submitAppointment(form) {
    const data = new FormData(form);
    await post("appointments", {
      title: data.get("title"),
      startAt: data.get("startAt"),
      endAt: data.get("endAt"),
      notes: data.get("notes"),
    });
    core().toast("Demande de rendez-vous envoyée.");
    await renderPanel(document.querySelector("#opsBody"));
  }

  async function submitApproval(form) {
    const data = new FormData(form);
    await post("approvals", {
      company:
        core().getCompany() ||
        core().getProfile().company,
      type: data.get("type"),
      title: data.get("title"),
      amount: data.get("amount"),
    });
    core().toast("Demande d’approbation créée.");
    await renderPanel(document.querySelector("#opsBody"));
  }

  async function submitOutbound(form) {
    const data = new FormData(form);
    const result = await post("outbound", {
      channel: data.get("channel"),
      recipient: data.get("recipient"),
      subject: data.get("subject"),
      message: data.get("message"),
    });
    core().toast(
      result.status === "sent"
        ? "Message envoyé."
        : "Message enregistré. Le connecteur doit être configuré.",
    );
    await renderPanel(document.querySelector("#opsBody"));
  }

  async function submitPermission(form) {
    const data = new FormData(form);
    await post("permissions", {
      userId: Number(data.get("userId")),
      permission: data.get("permission"),
      allowed: data.get("allowed") === "on",
    });
    core().toast("Permission enregistrée.");
  }

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (
      ![
        "p2AppointmentForm",
        "p2ApprovalForm",
        "p2OutboundForm",
        "p2PermissionForm",
      ].includes(form.id)
    )
      return;
    event.preventDefault();
    const handler =
      form.id === "p2AppointmentForm"
        ? submitAppointment
        : form.id === "p2ApprovalForm"
          ? submitApproval
          : form.id === "p2OutboundForm"
            ? submitOutbound
            : submitPermission;
    handler(form).catch((error) =>
      core()?.notice?.(error.message || "Erreur P2."),
    );
  });

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-p2-action]");
    if (!button) return;
    const action = button.dataset.p2Action;
    (async () => {
      if (action === "install") {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice.catch(() => null);
        deferredInstallPrompt = null;
        button.classList.add("hidden");
      } else if (action === "toggle-readability") {
        const next = !document.body.classList.contains("high-readability");
        document.body.classList.toggle("high-readability", next);
        localStorage.setItem("sgo_high_readability", next ? "1" : "0");
        button.textContent = next ? "Lisibilité normale" : "Haute lisibilité";
      } else if (action === "calendar-new") {
        const out = await post("calendar/feed", {});
        const node = document.getElementById("p2CalendarResult");
        if (node)
          node.innerHTML =
            '<label>Lien privé<input readonly value="' +
            esc(out.url) +
            '"></label><button type="button" class="btn" data-p2-action="copy-calendar" data-url="' +
            esc(out.url) +
            '">Copier le lien</button>';
      } else if (action === "copy-calendar") {
        await navigator.clipboard.writeText(button.dataset.url || "");
        core().toast("Lien calendrier copié.");
      } else if (action === "calendar-revoke") {
        await post("calendar/feed", { action: "revoke" });
        core().toast("Lien calendrier révoqué.");
        await renderPanel(document.querySelector("#opsBody"));
      } else if (action === "appointment-status") {
        await post("appointments", {
          action: "status",
          id: button.dataset.id,
          status: button.dataset.status,
        });
        await renderPanel(document.querySelector("#opsBody"));
      } else if (action === "approval-decision") {
        await post("approvals", {
          action: "decide",
          id: button.dataset.id,
          decision: button.dataset.decision,
        });
        await renderPanel(document.querySelector("#opsBody"));
      }
    })().catch((error) =>
      core()?.notice?.(error.message || "Erreur P2."),
    );
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    document
      .getElementById("p2InstallButton")
      ?.classList.remove("hidden");
  });

  window.addEventListener("online", () => {
    ensureRealtime();
    flushQueue().catch(() => {});
  });
  window.addEventListener("offline", stopRealtime);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") ensureRealtime();
  });

  if (localStorage.getItem("sgo_high_readability") === "1")
    document.body.classList.add("high-readability");

  setInterval(() => {
    if (core()?.getProfile?.()) ensureRealtime();
  }, 5000);

  window.SGOP2 = {
    queueMutation,
    flushQueue,
    queueCount,
    renderPanel,
    ensureRealtime,
    stopRealtime,
  };
})();
