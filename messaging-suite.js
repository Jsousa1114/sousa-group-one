"use strict";

(() => {
  const $ = (id) => document.getElementById(id),
    prefs = new Map(),
    presence = new Map(),
    reactionRows = [],
    favorites = new Set(),
    decrypted = new Map(),
    objectUrls = new Set();

  let activeUserId = null,
    metaLoadedAt = 0,
    presenceLoadedAt = 0,
    prefsLoadedAt = 0,
    pendingSharedRef = null,
    pendingForwardedFromId = "",
    archivedVisible = false,
    typingTimer = null,
    heartbeatTimer = null,
    pollTimer = null,
    urlHandledFor = null,
    pushRegistration = null,
    groupCall = null,
    groupInviteId = "",
    groupPollBusy = false,
    searchGeneration = 0;

  const core = () => window.SGOChatCore,
    cryptoBox = () => window.SGOMessageCrypto,
    profile = () => core()?.getProfile?.(),
    state = () => core()?.getState?.(),
    esc = (v) => core()?.esc?.(v) ?? String(v ?? "");

  function mode() {
    return localStorage.getItem("sgo_e2ee_mode") || "auto";
  }
  function conversationByKey(key) {
    const st = state(),
      me = profile();
    if (!st || !me || !key) return null;
    if (key.startsWith("thread:")) {
      const id = key.slice(7),
        thread = st.messageThreads?.find((t) => String(t.id) === id);
      return thread
        ? {
            key,
            type: "thread",
            id,
            thread,
            participantIds: (thread.participants || []).map(Number),
          }
        : null;
    }
    if (key.startsWith("direct:")) {
      const id = Number(key.slice(7)),
        contact = core().getContacts().find((c) => Number(c.id) === id);
      return contact
        ? {
            key,
            type: "direct",
            id: String(id),
            contact,
            participantIds: [Number(me.id), id],
          }
        : null;
    }
    return null;
  }
  function keyForMessage(message) {
    const me = profile();
    if (!message || !me) return "";
    if (message.threadId) return "thread:" + message.threadId;
    const other = String(message.senderId) === String(me.id)
      ? message.recipientId
      : message.senderId;
    return other ? "direct:" + other : "";
  }
  function currentConversation() {
    return core()?.getConversation?.() || null;
  }
  function contactName(id) {
    if (String(id) === String(profile()?.id)) return profile()?.name || "Vous";
    return core()?.getContacts?.().find((c) => String(c.id) === String(id))?.name || "Utilisateur";
  }
  async function refreshPrefs(force = false) {
    if (!profile()) return;
    if (!force && Date.now() - prefsLoadedAt < 15000) return;
    prefsLoadedAt = Date.now();
    const out = await core().api("messaging/preferences").catch(() => null);
    if (!out) return;
    prefs.clear();
    for (const item of out.preferences || []) prefs.set(item.key, item);
  }
  async function refreshMeta(force = false) {
    if (!profile()) return;
    if (!force && Date.now() - metaLoadedAt < 8000) return;
    metaLoadedAt = Date.now();
    const out = await core().api("messaging/message-meta").catch(() => null);
    if (!out) return;
    reactionRows.splice(0, reactionRows.length, ...(out.reactions || []));
    favorites.clear();
    for (const id of out.favorites || []) favorites.add(String(id));
  }
  async function refreshPresence(force = false) {
    if (!profile()) return;
    if (!force && Date.now() - presenceLoadedAt < 3500) return;
    presenceLoadedAt = Date.now();
    const out = await core().api("messaging/presence").catch(() => null);
    if (!out) return;
    presence.clear();
    for (const row of out.presence || []) presence.set(String(row.userId), row);
  }
  async function heartbeat(typingKey = null) {
    if (!profile()) return;
    await core().api("messaging/presence", { typingKey }).catch(() => {});
  }

  function vapidArray(value) {
    const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/"),
      padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4),
      raw = atob(padded),
      out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  async function ensureServiceWorker() {
    if (!("serviceWorker" in navigator)) return null;
    if (!pushRegistration)
      pushRegistration = await navigator.serviceWorker.register("/service-worker.js", {
        scope: "/",
        updateViaCache: "none",
      });
    return pushRegistration;
  }
  async function enablePush(interactive = false) {
    if (!("Notification" in window) || !("PushManager" in window))
      throw new Error("Les notifications push ne sont pas disponibles sur cet appareil.");
    let permission = Notification.permission;
    if (permission === "default" && interactive)
      permission = await Notification.requestPermission();
    if (permission !== "granted") {
      if (interactive) throw new Error("Autorisation de notifications refusée.");
      return false;
    }
    const reg = await ensureServiceWorker(),
      config = await core().api("messaging/push/key");
    if (!config.available || !config.publicKey)
      throw new Error("Les notifications push ne sont pas encore configurées sur le serveur.");
    let sub = await reg.pushManager.getSubscription();
    if (!sub)
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidArray(config.publicKey),
      });
    await core().api("messaging/push/subscription", {
      subscription: sub.toJSON(),
    });
    return true;
  }

  async function ensureUser() {
    const me = profile();
    if (!me) return;
    if (activeUserId !== String(me.id)) {
      activeUserId = String(me.id);
      prefs.clear();
      presence.clear();
      favorites.clear();
      reactionRows.splice(0);
      decrypted.clear();
      metaLoadedAt = presenceLoadedAt = prefsLoadedAt = 0;
      urlHandledFor = null;
      cryptoBox()?.ensureIdentity?.(core().api).catch(() => {});
      ensureServiceWorker()
        .then(() => {
          if (Notification?.permission === "granted") enablePush(false).catch(() => {});
        })
        .catch(() => {});
      heartbeat();
    }
    if (!heartbeatTimer)
      heartbeatTimer = setInterval(() => heartbeat(), 20000);
    if (!pollTimer)
      pollTimer = setInterval(() => {
        if (!profile()) return;
        if (core().getPage() === "messages") {
          refreshPresence(true).then(decoratePresence).catch(() => {});
          refreshMeta(true).then(decorateMessages).catch(() => {});
        }
        pollGroupInvites().catch(() => {});
      }, 3500);
  }

  function prefFor(key) {
    return prefs.get(key) || {
      key,
      pinned: false,
      archived: false,
      mutedUntil: null,
    };
  }
  async function savePref(key, patch) {
    const current = prefFor(key),
      next = { ...current, ...patch };
    await core().api("messaging/preferences", {
      key,
      pinned: !!next.pinned,
      archived: !!next.archived,
      mutedUntil: next.mutedUntil || null,
    });
    prefs.set(key, next);
    prefsLoadedAt = Date.now();
    decorateConversationList();
    decorateHeaderTools();
  }

  function decorateToolbar() {
    const head = document.querySelector(".chat-sidebar-head");
    if (!head || head.querySelector(".suite-chat-toolbar")) return;
    const bar = document.createElement("div");
    bar.className = "suite-chat-toolbar";
    bar.innerHTML = `
      <button type="button" data-suite-action="push" title="Notifications">🔔</button>
      <button type="button" data-suite-action="search" title="Rechercher dans tous les messages">🔎</button>
      <button type="button" data-suite-action="history" title="Historique des appels">📞</button>
      <button type="button" data-suite-action="archives" title="Archives">🗄</button>
    `;
    head.appendChild(bar);
  }

  function decorateComposer() {
    const form = $("messageForm");
    if (!form || form.querySelector("[data-suite-action='camera']")) return;
    const firstTool = form.querySelector(".chat-tool"),
      camera = document.createElement("button"),
      share = document.createElement("button");
    camera.type = share.type = "button";
    camera.className = share.className = "chat-tool suite-chat-tool";
    camera.dataset.suiteAction = "camera";
    camera.title = "Prendre une photo";
    camera.setAttribute("aria-label", "Prendre une photo");
    camera.textContent = "📷";
    share.dataset.suiteAction = "share";
    share.title = "Partager un devis, une facture ou un document";
    share.setAttribute("aria-label", "Partager un élément");
    share.textContent = "📄";
    form.insertBefore(camera, firstTool);
    form.insertBefore(share, firstTool);
    renderPendingShare();
  }
  function renderPendingShare() {
    const form = $("messageForm");
    if (!form) return;
    let bar = $("suiteSharedRefBar");
    if (!pendingSharedRef) {
      bar?.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "suiteSharedRefBar";
      bar.className = "suite-share-bar";
      form.parentElement.insertBefore(bar, form);
    }
    bar.innerHTML =
      "<span>📄 " +
      esc(pendingSharedRef.title || pendingSharedRef.id) +
      '</span><button type="button" data-suite-action="clear-share">✕</button>';
  }

  function decorateConversationList() {
    const list = $("conversationList");
    if (!list) return;
    const rows = [...list.querySelectorAll(".chat-contact")];
    for (const row of rows) {
      const key = row.dataset.id,
        pref = prefFor(key);
      row.classList.toggle("suite-pinned", !!pref.pinned);
      row.classList.toggle("suite-muted", !!(pref.mutedUntil && new Date(pref.mutedUntil) > new Date()));
      row.classList.toggle("suite-archived", !!pref.archived);
      if (pref.archived && !archivedVisible) row.hidden = true;
      if (!row.querySelector(".suite-conversation-flags")) {
        const flags = document.createElement("span");
        flags.className = "suite-conversation-flags";
        row.querySelector(".chat-contact-top")?.appendChild(flags);
      }
      const flags = row.querySelector(".suite-conversation-flags");
      if (flags)
        flags.textContent =
          (pref.pinned ? "📌" : "") +
          (pref.mutedUntil && new Date(pref.mutedUntil) > new Date() ? " 🔕" : "");
    }
    rows
      .sort((a, b) => Number(!!prefFor(b.dataset.id).pinned) - Number(!!prefFor(a.dataset.id).pinned))
      .forEach((row) => list.appendChild(row));
  }

  async function decoratePresence() {
    const conv = currentConversation(),
      subtitle = document.querySelector(".chat-header-person span");
    if (!conv || !subtitle) return;
    if (conv.type === "direct") {
      const p = presence.get(String(conv.contact.id));
      if (p?.typingKey === conv.key) subtitle.textContent = "écrit…";
      else if (p?.online) subtitle.textContent = "en ligne";
      else if (p?.lastSeen)
        subtitle.textContent =
          "vu " +
          new Date(p.lastSeen).toLocaleString("fr-CH", {
            hour: "2-digit",
            minute: "2-digit",
            day: "2-digit",
            month: "2-digit",
          });
    } else {
      const typing = conv.participantIds
        .filter((id) => String(id) !== String(profile().id))
        .filter((id) => presence.get(String(id))?.typingKey === conv.key)
        .map(contactName);
      if (typing.length) subtitle.textContent = typing.slice(0, 2).join(", ") + " écrit…";
    }
    document.querySelectorAll(".chat-contact").forEach((row) => {
      const key = row.dataset.id;
      if (!key?.startsWith("direct:")) return;
      const id = key.slice(7),
        p = presence.get(String(id));
      row.classList.toggle("suite-online", !!p?.online);
    });
  }

  async function encryptionStatus(conv) {
    const badge = $("suiteEncryptionBadge");
    if (!badge || !conv || !cryptoBox()) return;
    if (mode() === "off") {
      badge.textContent = "🔓 E2EE désactivé";
      badge.className = "suite-e2ee off";
      return;
    }
    try {
      const status = await cryptoBox().readiness(core().api, conv.participantIds);
      badge.textContent = status.ready
        ? "🔐 E2EE actif"
        : "🔓 E2EE en attente";
      badge.className = "suite-e2ee " + (status.ready ? "on" : "waiting");
      badge.title = status.ready
        ? "Les nouveaux messages et pièces jointes sont chiffrés de bout en bout."
        : "Certains participants doivent ouvrir l’application une fois pour enregistrer leur clé.";
    } catch {
      badge.textContent = "🔓 E2EE indisponible";
      badge.className = "suite-e2ee off";
    }
  }

  function decorateHeaderTools() {
    const header = document.querySelector(".chat-header"),
      conv = currentConversation();
    if (!header || !conv) return;
    let tools = header.querySelector(".suite-header-tools");
    if (!tools) {
      tools = document.createElement("div");
      tools.className = "suite-header-tools";
      const callActions = header.querySelector(".chat-call-actions");
      if (callActions) header.insertBefore(tools, callActions);
      else header.appendChild(tools);
    }
    const pref = prefFor(conv.key);
    tools.innerHTML = `
      <button type="button" id="suiteEncryptionBadge" class="suite-e2ee" data-suite-action="e2ee-info">🔐</button>
      ${conv.type === "thread" ? '<button type="button" data-suite-action="group-audio" title="Appel de groupe">👥📞</button><button type="button" data-suite-action="group-video" title="Appel vidéo de groupe">👥📹</button>' : ""}
      <button type="button" data-suite-action="chat-options" title="Options de la conversation">⋮</button>
    `;
    encryptionStatus(conv);
    header.classList.toggle("suite-muted-chat", !!(pref.mutedUntil && new Date(pref.mutedUntil) > new Date()));
  }

  function reactionsFor(id) {
    const map = new Map(),
      me = String(profile()?.id);
    for (const row of reactionRows.filter((r) => String(r.messageId) === String(id))) {
      if (!map.has(row.emoji)) map.set(row.emoji, { count: 0, mine: false });
      const v = map.get(row.emoji);
      v.count++;
      if (String(row.userId) === me) v.mine = true;
    }
    return map;
  }
  async function decryptedText(message) {
    if (!message?.encryption) return message?.text || "";
    if (decrypted.has(String(message.id))) return decrypted.get(String(message.id));
    const text = await cryptoBox().decryptText(
      core().api,
      message.encryption,
      profile().id,
    );
    decrypted.set(String(message.id), text);
    return text;
  }
  async function hydrateEncryptedMessage(message) {
    const node = document.querySelector('[data-message-id="' + CSS.escape(String(message.id)) + '"]');
    if (!node || !message.encryption || message.deletedForAll) return;
    const target = node.querySelector("[data-encrypted-text]");
    if (target && !target.dataset.decrypted) {
      try {
        const text = await decryptedText(message);
        target.textContent = text || (message.attachment ? "" : "🔐 Message chiffré");
        target.dataset.decrypted = "1";
      } catch {
        target.textContent = "🔐 Impossible de déchiffrer sur cet appareil.";
        target.classList.add("decrypt-error");
      }
    }
    const encryptedAttachment = node.querySelector("[data-encrypted-attachment]");
    if (encryptedAttachment && !encryptedAttachment.dataset.decrypted) {
      encryptedAttachment.dataset.decrypted = "loading";
      try {
        const response = await core().authFetch(
          "/api/state/messages/" + encodeURIComponent(message.id) + "/attachment",
        );
        if (!response.ok) throw new Error("Pièce jointe inaccessible");
        const blob = await cryptoBox().decryptAttachment(
            core().api,
            message.encryption,
            profile().id,
            await response.arrayBuffer(),
            message.attachment.originalMime || "application/octet-stream",
          ),
          url = URL.createObjectURL(blob);
        objectUrls.add(url);
        if (message.attachment.kind === "image") {
          encryptedAttachment.className = "chat-media-button";
          encryptedAttachment.innerHTML =
            '<img class="chat-image-preview loaded" alt=""><span>🔐 📷 ' +
            esc(message.attachment.name) +
            "</span>";
          encryptedAttachment.querySelector("img").src = url;
        } else if (message.attachment.kind === "audio") {
          encryptedAttachment.className = "chat-audio-wrap";
          encryptedAttachment.innerHTML =
            '<audio controls preload="metadata"></audio><span>🔐 🎤 ' +
            esc(message.attachment.name) +
            "</span>";
          encryptedAttachment.querySelector("audio").src = url;
        } else {
          encryptedAttachment.textContent = "🔐 📎 " + message.attachment.name;
        }
        encryptedAttachment.dataset.decrypted = "1";
        encryptedAttachment.onclick = () => {
          if (message.attachment.kind !== "audio") window.open(url, "_blank", "noopener");
        };
      } catch {
        encryptedAttachment.textContent = "🔐 Pièce jointe impossible à déchiffrer";
        encryptedAttachment.dataset.decrypted = "error";
      }
    }
  }

  function renderSharedRef(message, node) {
    if (!message.sharedRef || message.deletedForAll) return;
    const placeholder = node.querySelector("[data-shared-ref]");
    if (!placeholder || placeholder.dataset.ready) return;
    const ref = message.sharedRef,
      item = state()?.[ref.kind]?.find((x) => String(x.id) === String(ref.id)),
      kindLabel =
        ref.kind === "quotes"
          ? "Devis"
          : ref.kind === "invoices"
            ? "Facture"
            : "Document";
    placeholder.dataset.ready = "1";
    placeholder.className = "suite-shared-card";
    placeholder.innerHTML = `
      <span class="suite-shared-icon">📄</span>
      <span><b>${esc(kindLabel)}</b><small>${esc(item?.title || item?.name || ref.title || ref.id)}</small></span>
      <button type="button" data-suite-action="open-ref" data-suite-id="${esc(ref.kind + ":" + ref.id)}">Ouvrir</button>
    `;
  }

  function decorateMessages() {
    const st = state();
    if (!st || core().getPage() !== "messages") return;
    for (const message of st.messages || []) {
      const node = document.querySelector('[data-message-id="' + CSS.escape(String(message.id)) + '"]');
      if (!node) continue;
      if (message.encryption) hydrateEncryptedMessage(message);
      renderSharedRef(message, node);
      let actions = node.querySelector(".message-actions");
      if (!actions) continue;
      if (!actions.querySelector("[data-suite-action]")) {
        const mine = String(message.senderId) === String(profile().id),
          editAllowed =
            mine &&
            !message.system &&
            !message.deletedForAll &&
            Date.now() - new Date(message.createdAt).getTime() < 15 * 60 * 1000,
          deleteAllAllowed =
            mine &&
            !message.system &&
            !message.deletedForAll &&
            Date.now() - new Date(message.createdAt).getTime() < 60 * 60 * 1000;
        actions.insertAdjacentHTML(
          "beforeend",
          `
          <button type="button" data-suite-action="react" data-suite-id="${esc(message.id)}">😊</button>
          <button type="button" data-suite-action="favorite" data-suite-id="${esc(message.id)}">${favorites.has(String(message.id)) ? "★" : "☆"}</button>
          <button type="button" data-suite-action="forward" data-suite-id="${esc(message.id)}">↪ Transférer</button>
          ${editAllowed ? '<button type="button" data-suite-action="edit" data-suite-id="' + esc(message.id) + '">✎ Modifier</button>' : ""}
          ${deleteAllAllowed ? '<button type="button" class="danger-text" data-suite-action="delete-all" data-suite-id="' + esc(message.id) + '">🗑 Pour tous</button>' : ""}
        `,
        );
      }
      let strip = node.querySelector(".suite-reactions");
      if (!strip) {
        strip = document.createElement("div");
        strip.className = "suite-reactions";
        node.appendChild(strip);
      }
      const reactions = reactionsFor(message.id);
      strip.innerHTML = [...reactions]
        .map(
          ([emoji, value]) =>
            '<button type="button" class="' +
            (value.mine ? "mine" : "") +
            '" data-suite-action="react-direct" data-suite-id="' +
            esc(message.id) +
            '" data-suite-emoji="' +
            esc(emoji) +
            '">' +
            esc(emoji) +
            " " +
            value.count +
            "</button>",
        )
        .join("");
      node.classList.toggle("suite-favorite", favorites.has(String(message.id)));
    }
  }

  function openReactionPicker(id) {
    core().modal(
      "Réagir au message",
      '<div class="suite-reaction-picker">' +
        ["👍", "❤️", "😂", "😮", "😢", "🙏", "✅"]
          .map(
            (emoji) =>
              '<button type="button" data-suite-action="react-direct" data-suite-id="' +
              esc(id) +
              '" data-suite-emoji="' +
              emoji +
              '">' +
              emoji +
              "</button>",
          )
          .join("") +
        "</div>",
    );
  }
  async function toggleReaction(id, emoji) {
    await core().api("messaging/messages/" + encodeURIComponent(id) + "/reaction", {
      emoji,
    });
    await refreshMeta(true);
    decorateMessages();
    core().closeModal?.();
  }
  async function toggleFavorite(id) {
    await core().api("messaging/messages/" + encodeURIComponent(id) + "/favorite", {});
    await refreshMeta(true);
    decorateMessages();
  }

  async function editMessage(id) {
    const message = state()?.messages?.find((m) => String(m.id) === String(id));
    if (!message) return;
    const old = message.encryption ? await decryptedText(message) : message.text || "",
      next = prompt("Modifier le message :", old);
    if (next == null || next === old) return;
    if (message.encryption) {
      const conv = conversationByKey(keyForMessage(message)),
        encrypted = await cryptoBox().encryptPayload(
          core().api,
          conv.participantIds,
          next,
          null,
        );
      await core().api("messaging/messages/" + encodeURIComponent(id) + "/edit", {
        encryption: encrypted.encryption,
      });
      decrypted.delete(String(id));
    } else {
      await core().api("messaging/messages/" + encodeURIComponent(id) + "/edit", {
        text: next,
      });
    }
    await core().refresh();
  }
  async function deleteForAll(id) {
    if (!confirm("Supprimer ce message pour tous les participants ?")) return;
    await core().api(
      "messaging/messages/" + encodeURIComponent(id) + "/delete-for-all",
      {},
    );
    await core().refresh();
  }

  async function attachmentForForward(message) {
    if (!message.attachment) return null;
    const response = await core().authFetch(
      "/api/state/messages/" + encodeURIComponent(message.id) + "/attachment",
    );
    if (!response.ok) throw new Error("Pièce jointe inaccessible.");
    let blob;
    if (message.attachment.encrypted)
      blob = await cryptoBox().decryptAttachment(
        core().api,
        message.encryption,
        profile().id,
        await response.arrayBuffer(),
        message.attachment.originalMime || "application/octet-stream",
      );
    else blob = await response.blob();
    const content = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    return {
      name: message.attachment.name,
      mime:
        message.attachment.originalMime ||
        message.attachment.mime ||
        blob.type ||
        "application/octet-stream",
      kind: message.attachment.kind,
      content,
    };
  }
  function conversationChoices(action, sourceId = "") {
    const st = state(),
      contacts = core().getContacts(),
      rows = [
        ...contacts.map((c) => ({
          key: "direct:" + c.id,
          name: c.name,
          sub: "Conversation privée",
        })),
        ...(st.messageThreads || []).map((t) => ({
          key: "thread:" + t.id,
          name: t.name,
          sub: t.type === "project" ? "Chantier" : "Groupe",
        })),
      ];
    return (
      '<div class="suite-conversation-picker">' +
      rows
        .map(
          (row) =>
            '<button type="button" data-suite-action="' +
            action +
            '" data-suite-id="' +
            esc(sourceId) +
            '" data-suite-key="' +
            esc(row.key) +
            '"><b>' +
            esc(row.name) +
            "</b><small>" +
            esc(row.sub) +
            "</small></button>",
        )
        .join("") +
      "</div>"
    );
  }
  function openForward(id) {
    core().modal("Transférer vers…", conversationChoices("forward-target", id));
  }
  async function forwardTo(id, key) {
    const message = state()?.messages?.find((m) => String(m.id) === String(id));
    if (!message) return;
    const conv = conversationByKey(key);
    if (!conv) throw new Error("Conversation cible introuvable.");
    const text = message.encryption ? await decryptedText(message) : message.text || "",
      attachment = await attachmentForForward(message),
      payload = {
        text,
        recipientId: conv.type === "direct" ? Number(conv.id) : null,
        threadId: conv.type === "thread" ? conv.id : "",
        replyToId: "",
        forwardedFromId: message.id,
        sharedRef: message.sharedRef || null,
        attachment,
      },
      prepared = await prepareOutgoingMessage(payload, key);
    await core().sendMessage(prepared);
    core().selectConversation(key);
    core().closeModal();
  }

  async function openSharePicker() {
    const st = state(),
      entries = [
        ...(st.quotes || []).map((r) => ({
          kind: "quotes",
          id: r.id,
          title: r.title || r.id,
          sub: "Devis · " + r.status,
        })),
        ...(st.invoices || []).map((r) => ({
          kind: "invoices",
          id: r.id,
          title: r.title || r.id,
          sub: "Facture · " + r.status,
        })),
        ...(st.documents || []).map((r) => ({
          kind: "documents",
          id: r.id,
          title: r.name || r.id,
          sub: "Document",
        })),
      ];
    core().modal(
      "Partager dans la conversation",
      entries.length
        ? '<div class="suite-share-picker">' +
            entries
              .slice(0, 200)
              .map(
                (x) =>
                  '<button type="button" data-suite-action="select-share" data-suite-id="' +
                  esc(x.kind + ":" + x.id) +
                  '"><b>' +
                  esc(x.title) +
                  "</b><small>" +
                  esc(x.sub) +
                  "</small></button>",
              )
              .join("") +
            "</div>"
        : '<p class="muted">Aucun document visible à partager.</p>',
    );
  }
  function selectShare(value) {
    const i = value.indexOf(":"),
      kind = value.slice(0, i),
      id = value.slice(i + 1),
      target = state()?.[kind]?.find((x) => String(x.id) === String(id));
    pendingSharedRef = {
      kind,
      id,
      title: target?.title || target?.name || id,
    };
    core().closeModal();
    renderPendingShare();
    $("messageText")?.focus();
  }
  function openRef(value) {
    const i = value.indexOf(":"),
      kind = value.slice(0, i),
      id = value.slice(i + 1);
    if (kind === "quotes" || kind === "invoices") core().documentModal(kind, id);
    else if (kind === "documents") {
      core()
        .authFetch("/api/state/documents/" + encodeURIComponent(id))
        .then(async (r) => {
          if (!r.ok) throw new Error("Document inaccessible.");
          const url = URL.createObjectURL(await r.blob());
          objectUrls.add(url);
          window.open(url, "_blank", "noopener");
        })
        .catch((e) => core().notice(e.message));
    }
  }

  function openChatOptions() {
    const conv = currentConversation();
    if (!conv) return;
    const p = prefFor(conv.key),
      muted = p.mutedUntil && new Date(p.mutedUntil) > new Date();
    core().modal(
      "Options de la conversation",
      `<div class="suite-option-list">
        <button type="button" data-suite-action="pref-pin">${p.pinned ? "Retirer l’épingle" : "📌 Épingler"}</button>
        <button type="button" data-suite-action="pref-archive">${p.archived ? "Restaurer des archives" : "🗄 Archiver"}</button>
        <button type="button" data-suite-action="pref-mute">${muted ? "🔔 Réactiver les notifications" : "🔕 Mettre en sourdine"}</button>
      </div>`,
    );
  }
  function openMuteOptions() {
    core().modal(
      "Mettre en sourdine",
      '<div class="suite-option-list">' +
        '<button type="button" data-suite-action="mute-duration" data-suite-id="8h">8 heures</button>' +
        '<button type="button" data-suite-action="mute-duration" data-suite-id="1w">1 semaine</button>' +
        '<button type="button" data-suite-action="mute-duration" data-suite-id="forever">Toujours</button>' +
        "</div>",
    );
  }

  async function openCallHistory() {
    const out = await core().api("messaging/calls/history"),
      me = profile(),
      rows = [
        ...(out.direct || []).map((c) => {
          const incoming = String(c.calleeId) === String(me.id),
            otherId = incoming ? c.callerId : c.calleeId,
            otherName = incoming ? c.callerName : c.calleeName,
            icon = c.callType === "video" ? "📹" : "📞";
          return `<div class="suite-history-row"><span>${icon}</span><span><b>${esc(otherName)}</b><small>${incoming ? "Entrant" : "Sortant"} · ${esc(c.status)} · ${new Date(c.createdAt).toLocaleString("fr-CH")}</small></span><button type="button" data-suite-action="history-call" data-suite-id="${esc(otherId)}" data-suite-type="${esc(c.callType || "audio")}">Rappeler</button></div>`;
        }),
        ...(out.groups || []).map((c) => {
          const thread = state()?.messageThreads?.find((t) => String(t.id) === String(c.threadId));
          return `<div class="suite-history-row"><span>${c.callType === "video" ? "👥📹" : "👥📞"}</span><span><b>${esc(thread?.name || "Appel de groupe")}</b><small>${esc(c.status)} · ${new Date(c.createdAt).toLocaleString("fr-CH")}</small></span></div>`;
        }),
      ];
    core().modal(
      "Historique des appels",
      rows.length ? '<div class="suite-history">' + rows.join("") + "</div>" : '<p class="muted">Aucun appel.</p>',
    );
  }

  async function searchableText(message) {
    if (message.deletedForAll) return "";
    if (message.encryption) {
      try {
        return await decryptedText(message);
      } catch {
        return "";
      }
    }
    return message.text || "";
  }
  async function openSearch() {
    core().modal(
      "Rechercher dans la messagerie",
      '<label>Recherche<input id="suiteGlobalSearch" type="search" autocomplete="off" placeholder="Texte, fichier, devis, facture…"></label><div id="suiteSearchResults" class="suite-search-results"><p class="muted">Saisissez au moins 2 caractères.</p></div>',
    );
    $("suiteGlobalSearch")?.focus();
  }
  async function searchMessages(query) {
    const generation = ++searchGeneration,
      q = query.trim().toLocaleLowerCase("fr");
    if (q.length < 2) return [];
    const results = [];
    for (const message of state()?.messages || []) {
      const text = await searchableText(message),
        hay = [
          text,
          message.sender,
          message.attachment?.name,
          message.sharedRef?.title,
          message.sharedRef?.id,
        ]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase("fr");
      if (hay.includes(q))
        results.push({
          message,
          text:
            text ||
            message.attachment?.name ||
            message.sharedRef?.title ||
            "Message",
        });
      if (generation !== searchGeneration) return [];
    }
    return results.slice(-100).reverse();
  }
  function renderSearchResults(results) {
    const box = $("suiteSearchResults");
    if (!box) return;
    box.innerHTML = results.length
      ? results
          .map(
            ({ message, text }) =>
              '<button type="button" data-suite-action="search-result" data-suite-id="' +
              esc(message.id) +
              '"><b>' +
              esc(message.sender || "Message") +
              "</b><span>" +
              esc(text.slice(0, 180)) +
              "</span><small>" +
              esc(new Date(message.createdAt).toLocaleString("fr-CH")) +
              "</small></button>",
          )
          .join("")
      : '<p class="muted">Aucun résultat.</p>';
  }

  async function capturePhoto() {
    let input = $("suiteCameraInput");
    if (!input) {
      input = document.createElement("input");
      input.id = "suiteCameraInput";
      input.type = "file";
      input.accept = "image/*";
      input.setAttribute("capture", "environment");
      input.hidden = true;
      document.body.appendChild(input);
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        input.value = "";
        if (!file) return;
        try {
          const bitmap = await createImageBitmap(file),
            scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height)),
            canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(bitmap.width * scale));
          canvas.height = Math.max(1, Math.round(bitmap.height * scale));
          canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          bitmap.close?.();
          const blob = await new Promise((resolve) =>
            canvas.toBlob(resolve, "image/jpeg", 0.82),
          );
          if (!blob) throw new Error("Compression photo impossible.");
          if (blob.size > 5 * 1024 * 1024)
            throw new Error("La photo reste supérieure à 5 Mo.");
          const content = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          core().setAttachmentDraft({
            name: "photo-" + new Date().toISOString().replace(/[:.]/g, "-") + ".jpg",
            mime: "image/jpeg",
            kind: "image",
            content,
          });
        } catch (e) {
          core().notice(e.message);
        }
      });
    }
    input.click();
  }

  async function prepareOutgoingMessage(payload, targetKey = null) {
    const conv = targetKey ? conversationByKey(targetKey) : currentConversation(),
      next = {
        ...payload,
        forwardedFromId: payload.forwardedFromId || pendingForwardedFromId || "",
        sharedRef: payload.sharedRef || pendingSharedRef || null,
      };
    if (!conv) return next;
    const e2eeMode = mode();
    if (e2eeMode !== "off" && cryptoBox()) {
      try {
        const ready = await cryptoBox().readiness(core().api, conv.participantIds);
        if (ready.ready) {
          const encrypted = await cryptoBox().encryptPayload(
            core().api,
            conv.participantIds,
            next.text || "",
            next.attachment || null,
          );
          next.encryption = encrypted.encryption;
          next.attachment = encrypted.attachment;
          next.text = "";
        } else if (e2eeMode === "strict") {
          throw new Error(
            "Le chiffrement E2EE strict attend encore la clé d’un participant. Cette personne doit ouvrir l’application une fois.",
          );
        }
      } catch (e) {
        if (e2eeMode === "strict") throw e;
      }
    }
    pendingSharedRef = null;
    pendingForwardedFromId = "";
    return next;
  }

  async function renderSettings() {
    const content = $("content"),
      me = profile();
    if (!content || core().getPage() !== "settings" || !me) return;
    if (!content.querySelector(".suite-messaging-settings")) {
      const card = document.createElement("article");
      card.className = "card section suite-messaging-settings";
      card.innerHTML = `
        <h3>Messagerie sécurisée</h3>
        <label>Chiffrement des nouveaux messages
          <select id="suiteE2eeMode">
            <option value="auto">Automatique — E2EE quand toutes les clés sont disponibles</option>
            <option value="strict">Strict — bloquer l’envoi sans E2EE</option>
            <option value="off">Désactivé</option>
          </select>
        </label>
        <p class="muted">La clé privée reste dans ce navigateur. Le serveur ne reçoit que la clé publique et les ciphertexts.</p>
        <button type="button" class="btn primary" data-suite-action="push">Activer les notifications push</button>
        <p id="suitePushStatus" class="muted"></p>
        ${me.role === "admin" ? '<div id="suiteRetentionSettings" class="spaced"><h4>Conservation des communications</h4><p class="muted">Chargement…</p></div>' : ""}
      `;
      content.appendChild(card);
      $("suiteE2eeMode").value = mode();
    }
    const pushStatus = $("suitePushStatus");
    if (pushStatus)
      pushStatus.textContent =
        "Notifications navigateur : " +
        (window.Notification ? Notification.permission : "non disponible");
    if (me.role === "admin") await renderRetention();
  }
  async function renderRetention() {
    const box = $("suiteRetentionSettings");
    if (!box || box.dataset.loaded) return;
    const out = await core().api("messaging/retention").catch(() => null);
    if (!out) return;
    box.dataset.loaded = "1";
    const labels = {
      messages: "Messages",
      call_history: "Historique des appels",
      call_signals: "Données techniques d’appel",
    };
    box.innerHTML =
      "<h4>Conservation des communications</h4>" +
      (out.policies || [])
        .map(
          (p) =>
            '<label>' +
            esc(labels[p.scope] || p.scope) +
            '<input type="number" min="1" max="3650" value="' +
            esc(p.days) +
            '" data-retention-scope="' +
            esc(p.scope) +
            '"></label>',
        )
        .join("") +
      '<button type="button" class="btn" data-suite-action="retention-save">Enregistrer</button>';
  }

  // --- Group calls (mesh WebRTC, max 8 participants) ---
  async function groupMedia(callType) {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video:
        callType === "video"
          ? { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }
          : false,
    });
  }
  function ensureGroupOverlay() {
    let overlay = $("groupCallOverlay");
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = "groupCallOverlay";
    overlay.className = "group-call-overlay hidden";
    overlay.innerHTML = `
      <section class="group-call-card">
        <header><div><h3 id="groupCallTitle">Appel de groupe</h3><p id="groupCallStatus">Connexion…</p></div></header>
        <div id="groupCallGrid" class="group-call-grid"></div>
        <div class="group-call-controls">
          <button type="button" data-suite-action="group-mute" id="groupMute">🎙</button>
          <button type="button" data-suite-action="group-camera" id="groupCamera">📹</button>
          <button type="button" class="danger" data-suite-action="group-hangup">☎</button>
        </div>
      </section>`;
    document.body.appendChild(overlay);
    return overlay;
  }
  function groupTile(userId, stream, local = false) {
    const grid = $("groupCallGrid");
    if (!grid) return;
    let tile = grid.querySelector('[data-group-user="' + CSS.escape(String(userId)) + '"]');
    if (!tile) {
      tile = document.createElement("div");
      tile.className = "group-call-tile";
      tile.dataset.groupUser = String(userId);
      tile.innerHTML =
        '<video autoplay playsinline ' +
        (local ? "muted" : "") +
        '></video><div class="group-call-name">' +
        esc(local ? profile().name + " · vous" : contactName(userId)) +
        "</div>";
      grid.appendChild(tile);
    }
    const video = tile.querySelector("video");
    video.srcObject = stream;
    video.play().catch(() => {});
    if (groupCall?.callType !== "video") video.classList.add("audio-only");
  }
  async function sendGroupSignal(toUser, kind, payload) {
    if (!groupCall) return;
    await core().api(
      "messaging/group-calls/" + encodeURIComponent(groupCall.id) + "/signal",
      { toUser: Number(toUser), kind, payload },
    );
  }
  async function ensureGroupPeer(userId, initiator = false) {
    if (!groupCall || String(userId) === String(profile().id))
      return null;
    if (groupCall.peers.has(String(userId)))
      return groupCall.peers.get(String(userId));
    const pc = new RTCPeerConnection({
        iceServers: await core().loadIceServers(),
        iceCandidatePoolSize: 2,
      }),
      peer = { pc, userId: Number(userId), ice: [] };
    groupCall.peers.set(String(userId), peer);
    for (const track of groupCall.stream.getTracks())
      pc.addTrack(track, groupCall.stream);
    pc.onicecandidate = (e) => {
      if (e.candidate)
        sendGroupSignal(userId, "ice", e.candidate.toJSON()).catch(() => {});
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      groupTile(userId, stream, false);
      if (groupCall.callType === "audio") {
        let audio = document.querySelector('audio[data-group-audio="' + CSS.escape(String(userId)) + '"]');
        if (!audio) {
          audio = document.createElement("audio");
          audio.autoplay = true;
          audio.dataset.groupAudio = String(userId);
          $("groupCallOverlay").appendChild(audio);
        }
        audio.srcObject = stream;
        audio.play().catch(() => {});
      }
    };
    pc.onconnectionstatechange = () => {
      const tile = $("groupCallGrid")?.querySelector('[data-group-user="' + CSS.escape(String(userId)) + '"]');
      tile?.classList.toggle("disconnected", ["disconnected", "failed"].includes(pc.connectionState));
    };
    if (initiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await sendGroupSignal(userId, "offer", pc.localDescription);
    }
    return peer;
  }
  async function applyGroupSignal(signal) {
    if (!groupCall) return;
    const peer = await ensureGroupPeer(signal.fromUser, false),
      pc = peer.pc;
    if (signal.kind === "offer") {
      await pc.setRemoteDescription(signal.payload);
      for (const candidate of peer.ice.splice(0))
        await pc.addIceCandidate(candidate).catch(() => {});
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendGroupSignal(signal.fromUser, "answer", pc.localDescription);
    } else if (signal.kind === "answer") {
      await pc.setRemoteDescription(signal.payload);
      for (const candidate of peer.ice.splice(0))
        await pc.addIceCandidate(candidate).catch(() => {});
    } else if (signal.kind === "ice") {
      if (pc.remoteDescription) await pc.addIceCandidate(signal.payload).catch(() => {});
      else peer.ice.push(signal.payload);
    }
  }
  async function pollGroupSession() {
    if (!groupCall || groupPollBusy) return;
    groupPollBusy = true;
    try {
      const [membersOut, signalsOut] = await Promise.all([
          core().api("messaging/group-calls/" + encodeURIComponent(groupCall.id) + "/members"),
          core().api(
            "messaging/group-calls/" +
              encodeURIComponent(groupCall.id) +
              "/signals?after=" +
              groupCall.cursor,
          ),
        ]),
        joined = (membersOut.members || []).filter((m) => m.joinedAt && !m.leftAt);
      for (const member of joined) {
        if (String(member.userId) === String(profile().id)) continue;
        if (!groupCall.peers.has(String(member.userId))) {
          const initiator = Number(profile().id) < Number(member.userId);
          await ensureGroupPeer(member.userId, initiator);
        }
      }
      for (const signal of signalsOut.signals || []) {
        groupCall.cursor = Math.max(groupCall.cursor, Number(signal.id) || 0);
        await applyGroupSignal(signal);
      }
      $("groupCallStatus").textContent =
        joined.length + " participant" + (joined.length > 1 ? "s" : "");
    } catch (e) {
      if (e.status === 404 || e.status === 403) await stopGroupCall(false);
    } finally {
      groupPollBusy = false;
    }
  }
  async function startGroupSession(room, incoming = false) {
    if (groupCall) throw new Error("Un appel de groupe est déjà en cours.");
    if (window.activeCall) throw new Error("Un appel est déjà en cours.");
    const join = incoming
        ? await core().api(
            "messaging/group-calls/" + encodeURIComponent(room.id) + "/join",
            {},
          )
        : null,
      callType = room.callType || join?.callType || "audio",
      stream = await groupMedia(callType);
    groupCall = {
      id: room.id,
      threadId: room.threadId,
      createdBy: room.createdBy,
      callType,
      stream,
      peers: new Map(),
      cursor: 0,
      timer: null,
    };
    ensureGroupOverlay().classList.remove("hidden");
    $("groupCallTitle").textContent =
      (callType === "video" ? "Appel vidéo · " : "Appel audio · ") +
      (state()?.messageThreads?.find((t) => String(t.id) === String(room.threadId))?.name || "Groupe");
    $("groupCamera").classList.toggle("hidden", callType !== "video");
    groupTile(profile().id, stream, true);
    groupCall.timer = setInterval(() => pollGroupSession(), 1100);
    await pollGroupSession();
  }
  async function startGroupCall(callType) {
    const conv = currentConversation();
    if (!conv || conv.type !== "thread")
      throw new Error("Ouvrez une conversation de groupe ou de chantier.");
    const room = await core().api("messaging/group-calls", {
      threadId: conv.id,
      callType,
    });
    await startGroupSession(
      {
        id: room.id,
        threadId: conv.id,
        createdBy: profile().id,
        callType,
      },
      false,
    );
  }
  async function stopGroupCall(send = true) {
    const current = groupCall;
    if (!current) return;
    clearInterval(current.timer);
    for (const peer of current.peers.values()) peer.pc.close();
    current.stream.getTracks().forEach((track) => track.stop());
    document
      .querySelectorAll("#groupCallOverlay audio[data-group-audio]")
      .forEach((audio) => audio.remove());
    if (send) {
      const endpoint =
        String(current.createdBy) === String(profile().id)
          ? "/end"
          : "/leave";
      await core()
        .api(
          "messaging/group-calls/" + encodeURIComponent(current.id) + endpoint,
          {},
        )
        .catch(() => {});
    }
    groupCall = null;
    $("groupCallOverlay")?.classList.add("hidden");
    $("groupCallGrid")?.replaceChildren();
  }
  function showGroupInvite(room) {
    if (groupInviteId === String(room.id) || groupCall) return;
    groupInviteId = String(room.id);
    let banner = $("groupCallInvite");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "groupCallInvite";
      banner.className = "group-call-invite";
      document.body.appendChild(banner);
    }
    const thread = state()?.messageThreads?.find((t) => String(t.id) === String(room.threadId));
    banner.innerHTML =
      '<div><b>' +
      (room.callType === "video" ? "📹 Appel vidéo entrant" : "📞 Appel de groupe entrant") +
      "</b><span>" +
      esc(thread?.name || "Conversation de groupe") +
      '</span></div><button type="button" data-suite-action="group-accept" data-suite-id="' +
      esc(room.id) +
      '">Accepter</button><button type="button" data-suite-action="group-decline" data-suite-id="' +
      esc(room.id) +
      '">Refuser</button>';
    banner.dataset.room = JSON.stringify(room);
  }
  async function pollGroupInvites() {
    if (!profile() || groupCall) return;
    const out = await core().api("messaging/group-calls/pending").catch(() => null);
    if (!out) return;
    const room = (out.rooms || [])[0];
    if (room) showGroupInvite(room);
    else {
      groupInviteId = "";
      $("groupCallInvite")?.remove();
    }
  }

  function handleUrl() {
    const me = profile();
    if (!me || urlHandledFor === String(me.id)) return;
    const params = new URLSearchParams(location.search),
      open = params.get("open"),
      conversation = params.get("conversation"),
      thread = params.get("thread");
    if (open === "messages") {
      const key = conversation || (thread ? "thread:" + thread : "");
      if (key) core().selectConversation(key);
      else core().goToMessages();
    }
    urlHandledFor = String(me.id);
  }

  async function afterRender() {
    await ensureUser();
    handleUrl();
    if (core().getPage() === "settings") {
      renderSettings().catch(() => {});
      return;
    }
    if (core().getPage() !== "messages") return;
    decorateToolbar();
    decorateComposer();
    await Promise.all([
      refreshPrefs(),
      refreshMeta(),
      refreshPresence(),
    ]);
    decorateConversationList();
    decorateHeaderTools();
    decorateMessages();
    decoratePresence();
  }

  document.addEventListener("input", (event) => {
    if (event.target?.id === "messageText") {
      clearTimeout(typingTimer);
      const conv = currentConversation();
      if (conv && event.target.value.trim())
        heartbeat(conv.key).catch(() => {});
      typingTimer = setTimeout(() => heartbeat(null).catch(() => {}), 2600);
    }
    if (event.target?.id === "suiteGlobalSearch") {
      const query = event.target.value;
      searchMessages(query).then(renderSearchResults).catch(() => {});
    }
  });

  document.addEventListener("change", (event) => {
    if (event.target?.id === "suiteE2eeMode") {
      localStorage.setItem("sgo_e2ee_mode", event.target.value);
      if (core().getPage() === "messages") decorateHeaderTools();
    }
  });

  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-suite-action]");
    if (!button) return;
    event.preventDefault();
    const action = button.dataset.suiteAction,
      id = button.dataset.suiteId || "",
      key = button.dataset.suiteKey || "";
    try {
      if (action === "push") {
        await enablePush(true);
        core().toast("Notifications push activées.");
        renderSettings();
      } else if (action === "search") await openSearch();
      else if (action === "history") await openCallHistory();
      else if (action === "archives") {
        archivedVisible = !archivedVisible;
        decorateConversationList();
      } else if (action === "camera") await capturePhoto();
      else if (action === "share") await openSharePicker();
      else if (action === "clear-share") {
        pendingSharedRef = null;
        renderPendingShare();
      } else if (action === "select-share") selectShare(id);
      else if (action === "open-ref") openRef(id);
      else if (action === "react") openReactionPicker(id);
      else if (action === "react-direct")
        await toggleReaction(id, button.dataset.suiteEmoji);
      else if (action === "favorite") await toggleFavorite(id);
      else if (action === "edit") await editMessage(id);
      else if (action === "delete-all") await deleteForAll(id);
      else if (action === "forward") openForward(id);
      else if (action === "forward-target") await forwardTo(id, key);
      else if (action === "search-result") {
        const message = state()?.messages?.find((m) => String(m.id) === String(id));
        if (message) {
          core().closeModal();
          core().selectConversation(keyForMessage(message));
          setTimeout(
            () =>
              document
                .getElementById("msg-" + message.id)
                ?.scrollIntoView({ behavior: "smooth", block: "center" }),
            120,
          );
        }
      } else if (action === "chat-options") openChatOptions();
      else if (action === "pref-pin") {
        const conv = currentConversation(),
          p = prefFor(conv.key);
        await savePref(conv.key, { pinned: !p.pinned });
        core().closeModal();
      } else if (action === "pref-archive") {
        const conv = currentConversation(),
          p = prefFor(conv.key);
        await savePref(conv.key, { archived: !p.archived });
        core().closeModal();
      } else if (action === "pref-mute") {
        const conv = currentConversation(),
          p = prefFor(conv.key);
        if (p.mutedUntil && new Date(p.mutedUntil) > new Date()) {
          await savePref(conv.key, { mutedUntil: null });
          core().closeModal();
        } else openMuteOptions();
      } else if (action === "mute-duration") {
        const conv = currentConversation(),
          duration =
            id === "8h"
              ? 8 * 3600000
              : id === "1w"
                ? 7 * 86400000
                : 10 * 365 * 86400000;
        await savePref(conv.key, {
          mutedUntil: new Date(Date.now() + duration).toISOString(),
        });
        core().closeModal();
      } else if (action === "history-call") {
        core().closeModal();
        await core().startDirectCall(Number(id), button.dataset.suiteType || "audio");
      } else if (action === "e2ee-info") {
        core().modal(
          "Chiffrement de bout en bout",
          '<p>🔐 Lorsque tous les participants ont enregistré leur clé, le texte et les pièces jointes des nouveaux messages sont chiffrés dans le navigateur avant l’envoi.</p><p>La clé privée reste sur cet appareil. Utilisez le mode <b>Strict</b> dans Mon compte pour interdire tout envoi non chiffré.</p>',
        );
      } else if (action === "retention-save") {
        const inputs = document.querySelectorAll("[data-retention-scope]");
        for (const input of inputs)
          await core().api("messaging/retention", {
            scope: input.dataset.retentionScope,
            days: Number(input.value),
          });
        core().toast("Politique de conservation enregistrée.");
      } else if (action === "group-audio") await startGroupCall("audio");
      else if (action === "group-video") await startGroupCall("video");
      else if (action === "group-mute" && groupCall) {
        const tracks = groupCall.stream.getAudioTracks(),
          muted = tracks.every((track) => !track.enabled);
        tracks.forEach((track) => (track.enabled = muted));
        button.classList.toggle("muted", !muted);
        button.textContent = muted ? "🎙" : "🔇";
      } else if (action === "group-camera" && groupCall) {
        const tracks = groupCall.stream.getVideoTracks(),
          disabled = tracks.length && tracks.every((track) => !track.enabled);
        tracks.forEach((track) => (track.enabled = disabled));
        button.classList.toggle("muted", !disabled);
        button.textContent = disabled ? "📹" : "🚫";
      } else if (action === "group-hangup") await stopGroupCall(true);
      else if (action === "group-accept") {
        const banner = $("groupCallInvite"),
          room = JSON.parse(banner?.dataset.room || "{}");
        banner?.remove();
        groupInviteId = "";
        await startGroupSession(room, true);
      } else if (action === "group-decline") {
        await core().api(
          "messaging/group-calls/" + encodeURIComponent(id) + "/leave",
          {},
        );
        $("groupCallInvite")?.remove();
        groupInviteId = "";
      }
    } catch (e) {
      core().notice(e.message || "Action impossible.");
    }
  });

  // Prevent starting a 1:1 call while a group call is active.
  document.addEventListener(
    "click",
    (event) => {
      const button = event.target.closest("[data-action='call-start'],[data-action='call-video']");
      if (button && groupCall) {
        event.preventDefault();
        event.stopImmediatePropagation();
        core().notice("Terminez l’appel de groupe avant de lancer un appel privé.");
      }
    },
    true,
  );

  window.addEventListener("beforeunload", () => {
    if (groupCall) stopGroupCall(true).catch(() => {});
    for (const url of objectUrls) URL.revokeObjectURL(url);
  });

  window.SGOMessagingSuite = {
    afterRender,
    prepareOutgoingMessage,
  };

  // App.js can render before this script is evaluated on a restored session.
  setTimeout(() => afterRender().catch(() => {}), 0);
})();
