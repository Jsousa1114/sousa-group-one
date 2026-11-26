// « WhatsApp » page: the group's WhatsApp number, linked like WhatsApp Web. Conversations and
// messages (with photos, voice messages and documents), answering with formatting, files and
// pieces of the application, quick replies, 10 seconds to cancel, programmed sending, the client
// behind a number, the assistant, filing in documents and reminders. Linking the phone (QR code
// or code) is for administrators of the group.
(() => {
  "use strict";
  const core = () => window.SGOChatCore;
  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  const ic = (name) => window.SGOIcon?.(name) || "";
  const enc = encodeURIComponent;
  const api = (path, body) => core().api("whatsapp/" + path, body);
  const toast = (message) => core()?.toast?.(message);
  const role = () => core()?.getProfile?.()?.role || "";
  const MAX_UPLOAD = 18 * 1024 * 1024;
  const FIN_ROLES = ["admin", "direction", "accounting"];
  const CLIENT_EDITORS = ["admin", "direction", "manager", "accounting"];
  const KIND_LABEL = { image: "Photo", video: "Vidéo", voice: "Message vocal", audio: "Audio", document: "Document", sticker: "Autocollant", location: "Position", contact: "Contact", poll: "Sondage", other: "Message" };
  const FILTERS = [
    ["all", "Toutes"],
    ["unread", "Non lues"],
    ["groups", "Groupes"],
    ["archived", "Archivées"],
    ["snoozed", "Rappels"],
    ["outbox", "Programmés"],
  ];

  const st = {
    user: "",
    status: null,
    statusAt: 0,
    statusLoading: null,
    root: null,
    filter: "all",
    query: "",
    chats: [],
    more: false,
    chatsLoading: false,
    chatsError: "",
    chatsKey: "",
    outbox: [],
    jid: "",
    chat: null,
    messages: [],
    olderMore: false,
    convLoading: false,
    convError: "",
    reading: false,
    quoted: null,
    summary: null,
    picker: false,
  };
  const drafts = new Map(); // jid -> text written and not sent
  let files = [];
  let appFiles = [];
  let snippets = null;
  let statusTimer = null;
  let liveTimer = null;
  let handledUrl = "";

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------
  const hasAccess = () => !!st.status?.access;
  const unreadTotal = () => Number(st.status?.unread || 0);
  const connected = () => !!st.status?.connected;

  function resetIfUserChanged() {
    const me = core()?.getProfile?.();
    const id = me ? String(me.id || me.email || "") : "";
    if (id === st.user) return;
    Object.assign(st, { user: id, status: null, statusAt: 0, chats: [], chatsKey: "", jid: "", chat: null, messages: [], quoted: null, summary: null, reading: false, filter: "all", query: "" });
    drafts.clear();
    snippets = null;
  }

  async function loadStatus(force = false) {
    resetIfUserChanged();
    const me = core()?.getProfile?.();
    if (!me || me.role === "client") {
      st.status = { access: false };
      return st.status;
    }
    if (!force && st.status && Date.now() - st.statusAt < 25000) return st.status;
    if (st.statusLoading) return st.statusLoading;
    const before = hasAccess();
    const wasConnected = connected();
    st.statusLoading = api("status")
      .then((status) => {
        st.status = status;
        st.statusAt = Date.now();
        updateNavBadge();
        if (before !== hasAccess()) {
          const active = document.activeElement;
          const typing = active && document.getElementById("content")?.contains(active) && active.matches("input, textarea, select");
          if (!typing) core()?.render?.();
        } else if (st.root?.isConnected) {
          renderTop();
          if (wasConnected !== connected() || status.qrSvg || status.pairingCode || ["waiting", "connecting", "reconnecting"].includes(status.status)) renderLink();
        }
        return status;
      })
      .catch(() => st.status || { access: false })
      .finally(() => {
        st.statusLoading = null;
      });
    return st.statusLoading;
  }

  function updateNavBadge() {
    // The menu draws its own counters (sections, tabs, phone bar).
    if (core()?.updateBadges) return core().updateBadges();
    const item = document.querySelector('.nav-item[data-page="whatsapp"]');
    if (!item) return;
    const count = unreadTotal();
    let badge = item.querySelector(".nav-unread");
    if (!count) return badge?.remove();
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "nav-unread";
      item.append(" ", badge);
    }
    badge.textContent = count > 99 ? "99+" : String(count);
  }

  // -------------------------------------------------------------------------
  // Formatting
  // -------------------------------------------------------------------------
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  function shortDate(iso) {
    const d = new Date(iso || 0);
    if (!iso || Number.isNaN(d.getTime())) return "";
    const now = new Date();
    if (sameDay(d, now)) return d.toLocaleTimeString("fr-CH", { hour: "2-digit", minute: "2-digit" });
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameDay(d, yesterday)) return "Hier";
    if (now - d < 6 * 86400000) return d.toLocaleDateString("fr-CH", { weekday: "long" });
    return d.toLocaleDateString("fr-CH");
  }
  const time = (iso) => new Date(iso).toLocaleTimeString("fr-CH", { hour: "2-digit", minute: "2-digit" });
  const dayLabel = (iso) => {
    const d = new Date(iso);
    const now = new Date();
    if (sameDay(d, now)) return "Aujourd’hui";
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    if (sameDay(d, y)) return "Hier";
    return d.toLocaleDateString("fr-CH", { weekday: "long", day: "numeric", month: "long", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
  };
  const fullDate = (iso) => new Date(iso).toLocaleString("fr-CH", { weekday: "short", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  const size = (bytes) => (!bytes ? "" : bytes >= 1048576 ? (bytes / 1048576).toFixed(1).replace(".", ",") + " Mo" : Math.max(1, Math.round(bytes / 1024)) + " Ko");
  const money = (n) => "CHF " + (Number(n) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, "’");
  const hue = (text) => [...String(text || "")].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 11);
  const initials = (name) =>
    (String(name || "?")
      .replace(/^\+/, "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join("") || "?").toUpperCase();
  const avatar = (chat) => `<span class="wa-avatar${chat.group ? " group" : ""}" data-hue="${Math.floor(hue(chat.jid) / 30)}" aria-hidden="true">${chat.group ? ic("users") : esc(initials(chat.name))}</span>`;
  const mediaUrl = (m, download = false) => `/api/whatsapp/media/${enc(st.jid)}/${enc(m.id)}${download ? "?download=1" : ""}`;
  const phoneKey = (value) => {
    let digits = String(value || "").replace(/\D/g, "");
    if (digits.startsWith("00")) digits = digits.slice(2);
    return digits.length >= 9 ? digits.slice(-9) : "";
  };

  // WhatsApp formatting: *gras* _italique_ ~barré~ ```code``` and links.
  function formatted(text) {
    let out = esc(text);
    out = out.replace(/```([\s\S]+?)```/g, "<code>$1</code>");
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<b>$2</b>");
    out = out.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1<i>$2</i>");
    out = out.replace(/(^|[\s(])~([^~\n]+)~(?=[\s).,;:!?]|$)/g, "$1<s>$2</s>");
    out = out.replace(/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    return out.replace(/\n/g, "<br>");
  }

  // -------------------------------------------------------------------------
  // Page
  // -------------------------------------------------------------------------
  async function render(root) {
    if (!root) return;
    st.root = root;
    resetIfUserChanged();
    if (!st.status) root.innerHTML = `<div class="card wa-empty"><p>Chargement de WhatsApp…</p></div>`;
    await loadStatus();
    if (!root.isConnected || st.root !== root) return;
    if (!hasAccess()) {
      root.innerHTML = `<div class="card wa-empty">${ic("message")}<h3>WhatsApp</h3><p>WhatsApp ne vous est pas ouvert. Un administrateur peut vous en donner l’accès.</p></div>`;
      return;
    }
    root.innerHTML = `<div class="wa${st.reading ? " wa-reading" : ""}" id="waApp">
      <div class="wa-top" id="waTop"></div>
      <div id="waLink"></div>
      <div class="wa-main" id="waMain">
        <section class="wa-list card" id="waList" aria-label="Conversations"></section>
        <section class="wa-conv card" id="waConv" aria-label="Conversation"></section>
      </div>
    </div>`;
    renderTop();
    renderLink();
    renderList();
    renderConversation();
    fitHeight();
    if (st.chatsKey !== chatsKey()) loadChats();
    if (st.jid && !st.messages.length) openChat(st.jid, { quiet: true });
    ensureLive();
  }

  function fitHeight() {
    const main = document.getElementById("waMain");
    if (!main) return;
    if (window.innerWidth <= 900) {
      main.style.height = "";
      return;
    }
    const top = main.getBoundingClientRect().top + window.scrollY;
    main.style.height = Math.max(480, window.innerHeight - top - 18) + "px";
  }

  const chatsKey = () => [st.filter, st.query].join("|");

  function renderTop() {
    const el = document.getElementById("waTop");
    if (!el) return;
    const s = st.status || {};
    const state = s.connected
      ? `<span class="wa-state on">${ic("check")}Connecté${s.me?.phone ? " · " + esc(s.me.phone) : ""}</span>`
      : ["connecting", "reconnecting"].includes(s.status)
        ? `<span class="wa-state">${ic("refresh")}Connexion…</span>`
        : `<span class="wa-state off">${ic("alert")}Non relié</span>`;
    el.innerHTML = `
      <div class="wa-title"><b>${esc(s.label || "WhatsApp")}</b>${state}</div>
      <form class="wa-search" id="waSearch" role="search">${ic("search")}<input type="search" name="q" value="${esc(st.query)}" placeholder="Rechercher un nom, un numéro, un mot…" aria-label="Rechercher dans WhatsApp"></form>
      <div class="wa-top-actions">
        <button type="button" class="btn primary" data-wa="new" ${s.connected ? "" : "disabled"}>${ic("plus")}<span>Nouvelle conversation</span></button>
        <button type="button" class="btn secondary" data-wa="snippets">${ic("message")}<span>Réponses rapides</span></button>
        ${s.canManage ? `<button type="button" class="btn secondary" data-wa="access">${ic("lock")}<span>Accès</span></button>` : ""}
        ${s.canManage && s.connected ? `<button type="button" class="btn secondary" data-wa="unlink">${ic("x")}<span>Délier</span></button>` : ""}
      </div>`;
  }

  // Linking the phone (administrators), or the reason it is not linked.
  function renderLink() {
    const el = document.getElementById("waLink");
    if (!el) return;
    const s = st.status || {};
    if (s.connected) {
      el.innerHTML = s.history && !s.history.latest ? `<p class="wa-note">${ic("refresh")} Récupération de l’historique en cours${s.history.progress != null ? ` (${Math.round(s.history.progress)} %)` : ""}… Les anciennes conversations apparaissent au fur et à mesure.</p>` : "";
      return;
    }
    if (!s.canManage) {
      el.innerHTML = `<p class="wa-note">${ic("alert")} WhatsApp n’est pas connecté pour le moment${["connecting", "reconnecting"].includes(s.status) ? " (reconnexion en cours)" : " : un administrateur doit le relier"}. Les conversations déjà enregistrées restent lisibles.</p>`;
      return;
    }
    if (["connecting", "reconnecting"].includes(s.status)) {
      el.innerHTML = `<div class="card wa-link"><p>${ic("refresh")} Connexion à WhatsApp en cours…</p></div>`;
      return;
    }
    if (s.pairingCode) {
      el.innerHTML = `<div class="card wa-link"><h3>Entrez ce code sur le téléphone</h3>
        <p class="wa-code" aria-label="Code de liaison">${esc(s.pairingCode.replace(/^(.{4})(.{4})$/, "$1-$2"))}</p>
        <ol><li>Ouvrez WhatsApp sur le téléphone du groupe.</li><li>Réglages (ou ⋮) → <b>Appareils connectés</b> → <b>Connecter un appareil</b>.</li><li>Touchez <b>Connecter avec le numéro de téléphone à la place</b> et tapez ce code.</li></ol>
        <button type="button" class="btn secondary" data-wa="link-cancel">Annuler</button></div>`;
      return;
    }
    if (s.qrSvg) {
      el.innerHTML = `<div class="card wa-link wa-link-qr"><div class="wa-qr" role="img" aria-label="QR code de liaison WhatsApp">${s.qrSvg}</div>
        <div><h3>Scannez ce QR code avec le téléphone</h3>
        <ol><li>Ouvrez WhatsApp sur le téléphone du groupe.</li><li>Réglages (ou ⋮) → <b>Appareils connectés</b> → <b>Connecter un appareil</b>.</li><li>Visez ce QR code. Il change toutes les 20 secondes : c’est normal.</li></ol>
        <button type="button" class="btn secondary" data-wa="link-cancel">Annuler</button></div></div>`;
      return;
    }
    if (s.status === "waiting") {
      el.innerHTML = `<div class="card wa-link"><p>${ic("refresh")} Préparation du QR code…</p></div>`;
      return;
    }
    el.innerHTML = `<div class="card wa-link">
      <h3>Relier le WhatsApp du groupe</h3>
      ${s.error ? `<p class="wa-error">${esc(s.error)}</p>` : ""}
      <p>L’application se connecte comme <b>WhatsApp Web</b> : le téléphone continue de fonctionner normalement, et les conversations (avec leur historique) apparaissent ici.</p>
      <p class="wa-warning">${ic("alert")} Ce n’est pas un accès officiel de WhatsApp : WhatsApp peut bloquer un numéro qui lui semble automatisé. L’application envoie donc à rythme humain, une conversation à la fois, et ne fait jamais d’envoi en masse.</p>
      <div class="wa-link-actions">
        <button type="button" class="btn primary" data-wa="link-qr">${ic("camera")}<span>Afficher le QR code</span></button>
        <form class="wa-link-code" id="waLinkCode"><input name="phone" inputmode="tel" placeholder="Numéro du téléphone (ex. 41791234567)" aria-label="Numéro du téléphone"><button type="submit" class="btn secondary">Recevoir un code</button></form>
      </div>
    </div>`;
  }

  // -------------------------------------------------------------------------
  // Conversations list
  // -------------------------------------------------------------------------
  function renderList() {
    const el = document.getElementById("waList");
    if (!el) return;
    const previous = el.querySelector(".wa-rows")?.scrollTop || 0;
    const filters = `<div class="wa-filters" role="tablist">${FILTERS.map(
      ([id, label]) =>
        `<button type="button" role="tab" class="wa-filter${st.filter === id ? " active" : ""}" aria-selected="${st.filter === id}" data-wa="filter" data-id="${id}">${esc(label)}${
          id === "outbox" && st.outbox.length ? ` <small>${st.outbox.length}</small>` : ""
        }</button>`,
    ).join("")}</div>`;
    let body;
    if (st.filter === "outbox") body = outboxList();
    else if (st.chatsLoading && !st.chats.length) body = `<p class="muted wa-none">Chargement…</p>`;
    else if (st.chatsError) body = `<div class="wa-error"><p>${esc(st.chatsError)}</p></div>`;
    else if (!st.chats.length)
      body = `<p class="muted wa-none">${
        st.query ? "Aucune conversation ne correspond." : st.filter === "snoozed" ? "Aucun rappel. Ouvrez une conversation puis « Me le rappeler »." : connected() ? "Aucune conversation pour l’instant." : "Aucune conversation enregistrée."
      }</p>`;
    else
      body =
        st.chats
          .map(
            (c) => `<button type="button" class="wa-row${c.unread ? " unread" : ""}${c.jid === st.jid ? " open" : ""}" data-wa="open" data-jid="${esc(c.jid)}" ${c.jid === st.jid ? 'aria-current="true"' : ""}>
              ${avatar(c)}
              <span class="wa-row-main">
                <span class="wa-row-top"><b>${esc(c.name)}</b><time>${esc(c.snoozedUntil ? "Revient " + shortDate(c.snoozedUntil) : shortDate(c.lastAt))}</time></span>
                <span class="wa-row-bottom"><span class="wa-row-text">${c.lastFromMe ? "Vous : " : ""}${esc(c.lastText || "")}</span>${c.muted ? `<span title="Sourdine">${ic("bell-off")}</span>` : ""}${
                  c.unread ? `<span class="wa-count" aria-label="${c.unread} non lus">${c.unread > 99 ? "99+" : c.unread}</span>` : ""
                }</span>
              </span>
            </button>`,
          )
          .join("") + (st.more ? `<button type="button" class="btn secondary wa-more" data-wa="more">Plus de conversations</button>` : "");
    el.innerHTML = `${filters}<div class="wa-rows">${body}</div>`;
    const rows = el.querySelector(".wa-rows");
    if (rows) rows.scrollTop = previous;
  }

  function outboxList() {
    if (!st.outbox.length) return `<p class="muted wa-none">Aucun message programmé.</p>`;
    return st.outbox
      .map(
        (m) => `<div class="wa-x-row${m.status === "failed" ? " failed" : ""}">
          <div class="wa-x-main"><b>${esc(m.chat || "")}</b><small>${esc(m.preview || "")}</small>
          <small>${m.status === "failed" ? `<span class="wa-x-error">Non envoyé : ${esc(m.error || "")}</span>` : `${ic("clock")} ${esc(fullDate(m.sendAt))}`}${m.by ? " · " + esc(m.by) : ""}</small></div>
          <button type="button" class="btn secondary" data-wa="outbox-cancel" data-id="${esc(m.id)}" data-jid="${esc(m.jid)}">${m.status === "failed" ? "Reprendre le texte" : "Annuler l’envoi"}</button>
        </div>`,
      )
      .join("");
  }

  async function loadChats({ append = false, quiet = false } = {}) {
    const key = chatsKey();
    st.chatsKey = key;
    if (st.filter === "outbox") return loadOutbox();
    if (!quiet) {
      st.chatsLoading = true;
      st.chatsError = "";
      if (!append) st.chats = [];
      renderList();
    }
    try {
      const out = await api(`chats?filter=${enc(st.filter)}&q=${enc(st.query)}&offset=${append ? st.chats.length : 0}`);
      if (chatsKey() !== key) return;
      st.chats = append ? [...st.chats, ...out.chats.filter((c) => !st.chats.some((x) => x.jid === c.jid))] : out.chats;
      st.more = !!out.more;
      st.chatsError = "";
    } catch (error) {
      if (!quiet) st.chatsError = error.message;
    } finally {
      if (chatsKey() === key) {
        st.chatsLoading = false;
        renderList();
      }
    }
    loadOutbox(true);
  }

  async function loadOutbox(silent = false) {
    try {
      st.outbox = (await api("outbox")).messages || [];
    } catch {
      st.outbox = st.outbox || [];
    }
    if (!silent || st.filter === "outbox") renderList();
    else {
      const tab = document.querySelector('#waList [data-id="outbox"]');
      if (tab) tab.innerHTML = `Programmés${st.outbox.length ? ` <small>${st.outbox.length}</small>` : ""}`;
    }
  }

  // -------------------------------------------------------------------------
  // Conversation
  // -------------------------------------------------------------------------
  function clientCard() {
    const state = core()?.getState?.() || {};
    if (!st.chat || st.chat.group || !Array.isArray(state.clients)) return "";
    const key = phoneKey(st.chat.phone);
    if (!key) return "";
    const same = core().same || ((a, b) => String(a) === String(b));
    const client = state.clients.find((c) => !c.deletedAt && phoneKey(c.phone) === key);
    if (client) {
      const invoices = (state.invoices || []).filter(
        (i) => same(i.clientId, client.id) && !i.deletedAt && !i.archivedAt && !["Payée", "Brouillon"].includes(i.status) && (Number(i.amount) || 0) - (Number(i.paid) || 0) > 0.004,
      );
      const quotes = (state.quotes || []).filter((q) => same(q.clientId, client.id) && !q.deletedAt && !q.archivedAt && q.status === "Émise");
      const company = (state.companies || []).find((c) => same(c.id, client.company))?.name || "";
      const docs = [
        ...invoices.slice(0, 3).map((i) => `<button type="button" class="wa-chip" data-action="invoice" data-id="${esc(i.id)}">${ic("file")}Facture ${esc(i.id)} · reste ${esc(money((Number(i.amount) || 0) - (Number(i.paid) || 0)))}</button>`),
        ...quotes.slice(0, 3).map((q) => `<button type="button" class="wa-chip" data-action="quote" data-id="${esc(q.id)}">${ic("file")}Devis ${esc(q.id)} · ${esc(money(q.amount))}</button>`),
      ];
      return `<div class="wa-client">${ic("user")}<div class="wa-client-text"><b>Client : ${esc(client.name)}</b>${company ? `<small>${esc(company)}</small>` : ""}</div>${
        CLIENT_EDITORS.includes(role()) ? `<button type="button" class="btn secondary" data-action="client-edit" data-id="${esc(client.id)}">Fiche client</button>` : ""
      }${docs.length ? `<div class="wa-client-docs">${docs.join("")}</div>` : ""}</div>`;
    }
    if (!CLIENT_EDITORS.includes(role())) return "";
    return `<div class="wa-client unknown">${ic("user")}<div class="wa-client-text"><b>${esc(st.chat.name)}</b><small>${esc(st.chat.phone)} n’est pas encore dans vos clients.</small></div><button type="button" class="btn secondary" data-wa="create-client">${ic("plus")}<span>Créer le client</span></button></div>`;
  }

  function statusIcon(m) {
    if (!m.fromMe) return "";
    const s = Number(m.status) || 0;
    if (s <= 1) return `<span class="wa-tick" title="En attente">${ic("clock")}</span>`;
    if (s === 2) return `<span class="wa-tick" title="Envoyé">${ic("check")}</span>`;
    return `<span class="wa-tick double${s >= 4 ? " read" : ""}" title="${s >= 4 ? "Lu" : "Distribué"}">${ic("check")}${ic("check")}</span>`;
  }

  function mediaBlock(m) {
    if (m.deleted) return "";
    if (m.kind === "image" || m.kind === "sticker")
      return `<a class="wa-media${m.kind === "sticker" ? " sticker" : ""}" href="${esc(mediaUrl(m))}" target="_blank" rel="noopener" title="Ouvrir"><img src="${esc(m.thumb || mediaUrl(m))}" data-full="${esc(mediaUrl(m))}" alt="${esc(KIND_LABEL[m.kind])}" loading="lazy"></a>`;
    if (m.kind === "video") return `<a class="wa-file" href="${esc(mediaUrl(m))}" target="_blank" rel="noopener">${m.thumb ? `<img src="${esc(m.thumb)}" alt="" width="56" height="56">` : ic("video")}<span><b>Vidéo</b><small>${esc(size(m.size))}</small></span></a>`;
    if (m.kind === "voice" || m.kind === "audio") return `<audio class="wa-audio" controls preload="none" src="${esc(mediaUrl(m))}"></audio>`;
    if (m.kind === "document")
      return `<a class="wa-file" href="${esc(mediaUrl(m, !/^application\/pdf/.test(m.mime || "")))}" target="_blank" rel="noopener">${ic("file")}<span><b>${esc(m.fileName || "Document")}</b><small>${esc([String(m.mime || "").split("/")[1]?.toUpperCase(), size(m.size)].filter(Boolean).join(" · "))}</small></span>${ic("download")}</a>`;
    if (m.kind === "location") {
      const coords = String(m.body || "").split("\n").pop();
      return `<a class="wa-file" href="https://www.google.com/maps?q=${enc(coords)}" target="_blank" rel="noopener noreferrer">${ic("pin")}<span><b>Position</b><small>${esc(String(m.body || "").split("\n").slice(0, -1).join(" · ") || coords)}</small></span></a>`;
    }
    return "";
  }

  function bubble(m) {
    const group = st.chat?.group;
    const text = m.kind === "location" ? "" : m.kind === "voice" || m.kind === "audio" ? "" : m.body;
    return `<div class="wa-msg${m.fromMe ? " me" : ""}${m.deleted ? " deleted" : ""}" data-id="${esc(m.id)}">
      <div class="wa-bubble">
        ${group && !m.fromMe ? `<div class="wa-sender" data-hue="${Math.floor(hue(m.sender) / 30)}">${esc(m.senderName || "")}</div>` : ""}
        ${m.quotedText ? `<div class="wa-quote">${esc(m.quotedText)}</div>` : ""}
        ${mediaBlock(m)}
        ${m.deleted ? `<p class="wa-text"><i>Message supprimé</i></p>` : text ? `<p class="wa-text">${formatted(text)}</p>` : m.kind === "contact" || m.kind === "poll" || m.kind === "other" ? `<p class="wa-text">${formatted(m.body)}</p>` : ""}
        <div class="wa-meta">${m.edited ? "<small>modifié</small>" : ""}<time>${esc(time(m.at))}</time>${statusIcon(m)}</div>
        ${m.reactions?.length ? `<div class="wa-reactions">${m.reactions.map((r) => `<span>${esc(r)}</span>`).join("")}</div>` : ""}
        ${m.deleted ? "" : `<button type="button" class="wa-reply" data-wa="quote" data-id="${esc(m.id)}" title="Répondre à ce message" aria-label="Répondre à ce message">${ic("reply")}</button>`}
      </div>
    </div>`;
  }

  function thread() {
    let html = "";
    let day = "";
    for (const m of st.messages) {
      const d = new Date(m.at).toDateString();
      if (d !== day) {
        day = d;
        html += `<div class="wa-day"><span>${esc(dayLabel(m.at))}</span></div>`;
      }
      html += bubble(m);
    }
    return html;
  }

  function summaryBlock() {
    if (!st.summary) return "";
    if (st.summary.loading) return `<div class="wa-summary"><p class="muted">${ic("sparkle")} Résumé en cours…</p></div>`;
    if (st.summary.error) return `<div class="wa-summary wa-error"><p>${esc(st.summary.error)}</p></div>`;
    const lines = String(st.summary.text || "").split("\n").map((l) => l.trim()).filter(Boolean);
    const items = lines.filter((l) => /^[-•*]\s+/.test(l)).map((l) => `<li>${esc(l.replace(/^[-•*]\s+/, ""))}</li>`);
    const rest = lines.filter((l) => !/^[-•*]\s+/.test(l)).map((l) => `<p>${esc(l)}</p>`);
    return `<div class="wa-summary"><div class="wa-summary-head">${ic("sparkle")}<b>Résumé</b><button type="button" class="wa-icon-btn" data-wa="summary-close" aria-label="Fermer le résumé">${ic("x")}</button></div>${items.length ? `<ul>${items.join("")}</ul>` : ""}${rest.join("")}</div>`;
  }

  function composer() {
    const draft = drafts.get(st.jid) || "";
    const disabled = connected() ? "" : "disabled";
    const tool = (wrapChar, html, label) => `<button type="button" class="wa-tool" data-wa-wrap="${wrapChar}" title="${label}" aria-label="${label}">${html}</button>`;
    return `<form class="wa-compose" id="waCompose" novalidate>
      ${st.quoted ? `<div class="wa-quoting"><div><small>Réponse à ${esc(st.quoted.fromMe ? "vous-même" : st.quoted.senderName || st.chat?.name || "")}</small><p>${esc(st.quoted.body || KIND_LABEL[st.quoted.kind] || "")}</p></div><button type="button" class="wa-icon-btn" data-wa="quote-cancel" aria-label="Ne plus citer">${ic("x")}</button></div>` : ""}
      <div class="wa-tools">
        ${tool("*", "<b>G</b>", "Gras")}${tool("_", "<i>I</i>", "Italique")}${tool("~", "<s>S</s>", "Barré")}
        <select class="wa-snippet-select" data-wa-snippet aria-label="Réponses rapides"><option value="">Réponses rapides…</option></select>
        <label class="wa-tool" title="Joindre des fichiers" aria-label="Joindre des fichiers">${ic("paperclip")}<input type="file" id="waFiles" multiple hidden ${disabled}></label>
        <button type="button" class="wa-tool" data-wa="app-files" title="Joindre une facture, un devis ou un document de l’application" aria-label="Joindre depuis l’application" aria-expanded="${st.picker}">${ic("file")}</button>
        <button type="button" class="wa-tool" data-wa="ai-reply" title="Proposer une réponse (IA)" aria-label="Proposer une réponse (IA)">${ic("sparkle")}</button>
        <button type="button" class="wa-tool" data-wa="schedule-toggle" title="Programmer l’envoi" aria-label="Programmer l’envoi" aria-expanded="false">${ic("clock")}</button>
      </div>
      <div id="waAppPicker" class="wa-app-picker" ${st.picker ? "" : "hidden"}><input type="search" id="waAppSearch" placeholder="Rechercher une facture, un devis, un document…" aria-label="Rechercher dans l’application"><div id="waAppList" class="wa-app-list"></div></div>
      <ul id="waFileList" class="wa-file-list"></ul>
      <div class="wa-schedule" hidden><label>Envoyer le <input type="datetime-local" name="sendAt"></label><div class="wa-schedule-choices">${scheduleChoices()
        .map(([label, d]) => `<button type="button" class="btn secondary" data-wa="schedule-pick" data-value="${esc(localInput(d))}">${esc(label)}</button>`)
        .join("")}</div></div>
      <p id="waComposeError" class="error" role="alert"></p>
      <div class="wa-input-row">
        <textarea name="text" rows="1" placeholder="${connected() ? "Écrivez un message" : "WhatsApp n’est pas connecté"}" aria-label="Message" ${disabled}>${esc(draft)}</textarea>
        <button type="submit" class="btn primary wa-send" ${disabled} aria-label="Envoyer" title="Envoyer (Entrée)">${ic("send")}</button>
      </div>
    </form>`;
  }

  function renderConversation() {
    const el = document.getElementById("waConv");
    if (!el) return;
    document.getElementById("waApp")?.classList.toggle("wa-reading", !!st.reading);
    if (!st.jid) {
      el.innerHTML = `<div class="wa-placeholder">${ic("message")}<p>Sélectionnez une conversation.</p></div>`;
      return;
    }
    if (!st.chat && !st.convError) {
      el.innerHTML = `<div class="wa-head"><button type="button" class="btn secondary wa-back" data-wa="back">${ic("arrow-left")}<span>Retour</span></button></div><p class="muted wa-none">Ouverture…</p>`;
      return;
    }
    if (st.convError) {
      el.innerHTML = `<div class="wa-head"><button type="button" class="btn secondary wa-back" data-wa="back">${ic("arrow-left")}<span>Retour</span></button></div><div class="wa-error"><p>${esc(st.convError)}</p></div>`;
      return;
    }
    const c = st.chat;
    const tool = (what, icon, label) => `<button type="button" class="wa-icon-btn" data-wa="${what}" title="${label}" aria-label="${label}">${ic(icon)}</button>`;
    el.innerHTML = `
      <div class="wa-head">
        <button type="button" class="btn secondary wa-back" data-wa="back">${ic("arrow-left")}<span>Retour</span></button>
        ${avatar(c)}
        <div class="wa-head-text"><b>${esc(c.name)}</b><small>${esc(c.group ? "Groupe" : c.phone || "")}</small></div>
        <div class="wa-head-tools">
          ${tool("summary", "sparkle", "Résumer la conversation")}
          ${tool("file", "folder", "Classer dans les documents d’un chantier ou d’un client")}
          ${c.snoozedUntil ? tool("unsnooze", "bell-off", "Annuler le rappel") : tool("remind", "bell", "Me le rappeler")}
          ${tool(c.archived ? "unarchive" : "archive", c.archived ? "inbox" : "archive", c.archived ? "Remettre dans la liste" : "Archiver (dans l’application)")}
          ${tool("unread", "mail", "Marquer comme non lu")}
        </div>
      </div>
      ${clientCard()}
      <div id="waSummary">${summaryBlock()}</div>
      <div class="wa-thread" id="waThread">${st.olderMore ? `<button type="button" class="btn secondary wa-older" data-wa="older">Messages plus anciens</button>` : ""}${thread()}</div>
      ${composer()}`;
    const box = document.getElementById("waThread");
    if (box) box.scrollTop = box.scrollHeight;
    fillSnippets();
    renderFiles();
    if (st.picker) renderAppPicker();
    autoGrow(el.querySelector("textarea"));
  }

  function autoGrow(area) {
    if (!area) return;
    area.style.height = "auto";
    area.style.height = Math.min(area.scrollHeight, 180) + "px";
  }

  // Adds the messages that arrived without rebuilding what is being typed.
  function appendMessages(list) {
    const box = document.getElementById("waThread");
    if (!box) return renderConversation();
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    const known = new Set(st.messages.map((m) => m.id));
    const fresh = list.filter((m) => !known.has(m.id));
    const changed = list.filter((m) => known.has(m.id));
    for (const m of changed) {
      const i = st.messages.findIndex((x) => x.id === m.id);
      if (JSON.stringify(st.messages[i]) !== JSON.stringify(m)) {
        st.messages[i] = m;
        const node = box.querySelector(`.wa-msg[data-id="${window.CSS?.escape ? CSS.escape(m.id) : m.id}"]`);
        if (node) node.outerHTML = bubble(m);
      }
    }
    if (!fresh.length) return;
    let lastDay = st.messages.length ? new Date(st.messages.at(-1).at).toDateString() : "";
    for (const m of fresh) {
      st.messages.push(m);
      const d = new Date(m.at).toDateString();
      if (d !== lastDay) {
        lastDay = d;
        box.insertAdjacentHTML("beforeend", `<div class="wa-day"><span>${esc(dayLabel(m.at))}</span></div>`);
      }
      box.insertAdjacentHTML("beforeend", bubble(m));
    }
    if (near || fresh.some((m) => m.fromMe)) box.scrollTop = box.scrollHeight;
  }

  async function openChat(jid, { quiet = false } = {}) {
    if (!jid) return;
    const changed = jid !== st.jid;
    if (changed) {
      const area = document.querySelector("#waCompose textarea");
      if (area && st.jid) drafts.set(st.jid, area.value);
      Object.assign(st, { jid, chat: st.chats.find((c) => c.jid === jid) || null, messages: [], quoted: null, summary: null, convError: "", picker: false });
      files = [];
      appFiles = [];
    }
    if (!st.chat) st.chat = st.chats.find((c) => c.jid === jid) || null;
    st.reading = true;
    st.convLoading = true;
    if (!quiet) {
      renderList();
      renderConversation();
      if (window.innerWidth <= 900) window.scrollTo({ top: 0 });
    }
    try {
      const out = await api(`chats/${enc(jid)}/messages`);
      if (st.jid !== jid) return;
      st.chat = out.chat;
      st.messages = out.messages;
      st.olderMore = !!out.more;
      st.convError = "";
    } catch (error) {
      if (st.jid === jid) st.convError = error.message;
    } finally {
      if (st.jid === jid) {
        st.convLoading = false;
        renderConversation();
      }
    }
    const row = st.chats.find((c) => c.jid === jid);
    if (st.chat && (st.chat.unread || row?.unread)) {
      api(`chats/${enc(jid)}/read`, {}).catch(() => {});
      if (st.status) st.status.unread = Math.max(0, unreadTotal() - (row?.unread || st.chat.unread || 0));
      if (row) row.unread = 0;
      st.chat.unread = 0;
      renderList();
      updateNavBadge();
      setTimeout(() => loadStatus(true), 800);
    }
  }

  async function loadOlder() {
    if (!st.messages.length) return;
    const box = document.getElementById("waThread");
    const height = box?.scrollHeight || 0;
    try {
      const out = await api(`chats/${enc(st.jid)}/messages?before=${enc(st.messages[0].at)}`);
      st.messages = [...out.messages, ...st.messages];
      st.olderMore = !!out.more;
      renderConversation();
      const after = document.getElementById("waThread");
      if (after) after.scrollTop = after.scrollHeight - height;
    } catch (error) {
      toast(error.message);
    }
  }

  function closeChat() {
    const area = document.querySelector("#waCompose textarea");
    if (area && st.jid) drafts.set(st.jid, area.value);
    Object.assign(st, { jid: "", chat: null, messages: [], quoted: null, summary: null, reading: false });
    renderList();
    renderConversation();
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------
  const pad = (n) => String(n).padStart(2, "0");
  const localInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const atHour = (days, hour) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  const nextMonday = (hour) => {
    const d = atHour(1, hour);
    while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
    return d;
  };
  function scheduleChoices() {
    const choices = [];
    if (new Date().getHours() < 16) choices.push(["Cet après-midi (17:00)", atHour(0, 17)]);
    choices.push(["Demain matin (8:00)", atHour(1, 8)], ["Lundi matin (8:00)", nextMonday(8)]);
    return choices;
  }

  function renderFiles() {
    const list = document.getElementById("waFileList");
    if (!list) return;
    list.innerHTML = [
      ...files.map((f, i) => `<li>${ic("paperclip")}<span>${esc(f.name)}</span><small>${esc(size(f.size))}</small><button type="button" class="wa-icon-btn" data-wa="file-remove" data-index="${i}" aria-label="Retirer ${esc(f.name)}">${ic("x")}</button></li>`),
      ...appFiles.map((a, i) => `<li>${ic("file")}<span>${esc(a.label)}</span><small>de l’application</small><button type="button" class="wa-icon-btn" data-wa="app-remove" data-index="${i}" aria-label="Retirer ${esc(a.label)}">${ic("x")}</button></li>`),
    ].join("");
  }

  function appCandidates() {
    const s = core()?.getState?.() || {};
    const same = core().same || ((a, b) => String(a) === String(b));
    const key = phoneKey(st.chat?.phone);
    const clientIds = new Set((s.clients || []).filter((c) => key && phoneKey(c.phone) === key).map((c) => String(c.id)));
    const clientName = (id) => (s.clients || []).find((c) => same(c.id, id))?.name || "";
    const project = (id) => (s.projects || []).find((p) => same(p.id, id));
    const items = [];
    if (FIN_ROLES.includes(role())) {
      for (const i of s.invoices || [])
        if (!i.deletedAt && !i.archivedAt && i.status !== "Brouillon") items.push({ kind: "invoices", id: String(i.id), label: `Facture ${i.id}`, detail: [clientName(i.clientId), money(i.amount)].filter(Boolean).join(" · "), clientId: String(i.clientId || ""), date: i.date || "" });
      for (const q of s.quotes || [])
        if (!q.deletedAt && !q.archivedAt && q.status !== "Brouillon") items.push({ kind: "quotes", id: String(q.id), label: `Devis ${q.id}`, detail: [clientName(q.clientId), money(q.amount)].filter(Boolean).join(" · "), clientId: String(q.clientId || ""), date: q.date || "" });
    }
    for (const d of s.documents || []) {
      if (d.deletedAt || d.category === "identity") continue;
      const p = d.project ? project(d.project) : null;
      items.push({ kind: "documents", id: String(d.id), label: d.name || "Document", detail: p?.title || clientName(d.clientId) || "Document", clientId: String(d.clientId || p?.clientId || ""), date: String(d.createdAt || "").slice(0, 10) });
    }
    return items.sort((a, b) => (clientIds.has(b.clientId) ? 1 : 0) - (clientIds.has(a.clientId) ? 1 : 0) || String(b.date).localeCompare(String(a.date)));
  }
  function renderAppPicker() {
    const list = document.getElementById("waAppList");
    if (!list) return;
    const words = String(document.getElementById("waAppSearch")?.value || "").toLowerCase().split(/\s+/).filter(Boolean);
    const chosen = new Set(appFiles.map((a) => a.kind + ":" + a.id));
    const items = appCandidates().filter((x) => words.every((w) => `${x.label} ${x.detail}`.toLowerCase().includes(w)));
    list.innerHTML = items.length
      ? items
          .slice(0, 60)
          .map((x) => `<label class="wa-app-item"><input type="checkbox" data-wa-app="${esc(x.kind + ":" + x.id)}" data-label="${esc(x.label)}" ${chosen.has(x.kind + ":" + x.id) ? "checked" : ""}><span><b>${esc(x.label)}</b><small>${esc(x.detail)}</small></span></label>`)
          .join("")
      : `<p class="muted">Aucun élément trouvé.</p>`;
  }

  async function loadSnippets(force = false) {
    if (snippets && !force) return snippets;
    try {
      snippets = (await api("snippets")).snippets || [];
    } catch {
      snippets = [];
    }
    return snippets;
  }
  async function fillSnippets() {
    const select = document.querySelector("#waCompose [data-wa-snippet]");
    if (!select) return;
    const list = await loadSnippets();
    if (!select.isConnected) return;
    select.innerHTML = `<option value="">Réponses rapides…</option>${list.map((x) => `<option value="${esc(x.id)}">${esc(x.title)}</option>`).join("")}<option value="__save">＋ Enregistrer ce texte comme réponse rapide…</option>`;
  }

  function insertText(area, text) {
    const start = area.selectionStart ?? area.value.length;
    const end = area.selectionEnd ?? area.value.length;
    area.value = area.value.slice(0, start) + text + area.value.slice(end);
    area.selectionStart = area.selectionEnd = start + text.length;
    area.focus();
    autoGrow(area);
    drafts.set(st.jid, area.value);
  }

  const fileData = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = () => reject(new Error(`Impossible de lire ${file.name}.`));
      reader.readAsDataURL(file);
    });

  async function send(form) {
    const area = form.elements.text;
    const error = document.getElementById("waComposeError");
    error.textContent = "";
    const text = area.value;
    if (!text.trim() && !files.length && !appFiles.length) return;
    if (files.reduce((n, f) => n + f.size, 0) > MAX_UPLOAD) {
      error.textContent = "Fichiers : 18 Mo au maximum au total.";
      return;
    }
    const scheduling = !form.querySelector(".wa-schedule").hidden;
    const sendAt = scheduling ? form.elements.sendAt.value : "";
    if (scheduling && !sendAt) {
      error.textContent = "Choisissez la date et l’heure d’envoi.";
      return;
    }
    const button = form.querySelector(".wa-send");
    button.disabled = true;
    const jid = st.jid;
    const keep = { text, files: [...files], app: [...appFiles], quoted: st.quoted };
    try {
      const uploads = [];
      for (const f of files) uploads.push({ name: f.name, type: f.type, data: await fileData(f) });
      const body = { text, uploads, appFiles: appFiles.map(({ kind, id }) => ({ kind, id })), quotedId: st.quoted?.id || "" };
      if (sendAt) body.sendAt = new Date(sendAt).toISOString();
      const out = await api(`chats/${enc(jid)}/send`, body);
      drafts.delete(jid);
      files = [];
      appFiles = [];
      st.quoted = null;
      st.picker = false;
      if (out.sent) {
        await refreshConversation();
      } else if (out.kind === "scheduled") {
        toast(`Message programmé : ${fullDate(out.sendAt)}.`);
        loadOutbox(true);
      } else showUndo({ jid, id: out.id, sendAt: out.sendAt, keep });
      renderConversation();
      document.querySelector("#waCompose textarea")?.focus();
    } catch (err) {
      error.textContent = err.message;
      button.disabled = false;
    }
  }

  function undoHost() {
    let host = document.getElementById("waUndo");
    if (!host) {
      host = document.createElement("div");
      host.id = "waUndo";
      host.className = "wm-undo-host";
      host.setAttribute("aria-live", "polite");
      document.body.append(host);
    }
    return host;
  }
  function showUndo({ jid, id, sendAt, keep }) {
    const bar = document.createElement("div");
    bar.className = "wm-undo";
    undoHost().append(bar);
    const label = (keep.text.trim() || keep.files.map((f) => f.name).join(", ") || keep.app.map((a) => a.label).join(", ")).replace(/\s+/g, " ").slice(0, 40);
    let finished = false;
    const restore = () => {
      drafts.set(jid, keep.text);
      if (st.jid === jid) {
        files = keep.files;
        appFiles = keep.app;
        st.quoted = keep.quoted;
        renderConversation();
      }
    };
    const tick = () => {
      if (finished) return;
      const left = Math.max(0, Math.ceil((new Date(sendAt).getTime() - Date.now()) / 1000));
      if (left > 0) {
        bar.innerHTML = `<span>WhatsApp « ${esc(label)} » dans ${left} s</span><button type="button" class="btn secondary">Annuler</button>`;
        bar.querySelector("button").onclick = cancel;
        return setTimeout(tick, 250);
      }
      bar.innerHTML = `<span>Envoi WhatsApp…</span>`;
      check(0);
    };
    const check = async (tries) => {
      try {
        const out = await api(`outbox/${enc(id)}`);
        if (out.status === "sent") {
          finished = true;
          bar.innerHTML = `<span>${ic("check")} Message WhatsApp envoyé.</span>`;
          if (st.jid === jid) refreshConversation();
          return setTimeout(() => bar.remove(), 3000);
        }
        if (out.status === "failed") {
          finished = true;
          bar.classList.add("failed");
          bar.innerHTML = `<span>Non envoyé : ${esc(out.error || "erreur")}</span><button type="button" class="btn secondary">Reprendre le texte</button><button type="button" class="wm-icon-btn wa-icon-btn" aria-label="Fermer">${ic("x")}</button>`;
          const [again, close] = bar.querySelectorAll("button");
          again.onclick = () => {
            bar.remove();
            restore();
            if (st.jid !== jid) openChat(jid);
          };
          close.onclick = () => bar.remove();
          return;
        }
      } catch {
        // tried again below
      }
      if (tries < 20) setTimeout(() => check(tries + 1), 1500);
      else bar.remove();
    };
    const cancel = async () => {
      finished = true;
      bar.innerHTML = `<span>Annulation…</span>`;
      try {
        await api(`outbox/${enc(id)}/cancel`, {});
        bar.remove();
        restore();
        if (st.jid !== jid) openChat(jid);
        toast("Envoi annulé : le message est revenu dans la zone de saisie.");
      } catch (error) {
        bar.innerHTML = `<span>${esc(error.message)}</span>`;
        setTimeout(() => bar.remove(), 4000);
      }
    };
    tick();
  }

  async function refreshConversation() {
    if (!st.jid) return;
    const jid = st.jid;
    try {
      const out = await api(`chats/${enc(jid)}/messages`);
      if (st.jid !== jid) return;
      st.chat = { ...st.chat, ...out.chat };
      appendMessages(out.messages);
      if (out.chat.unread) {
        api(`chats/${enc(jid)}/read`, {}).catch(() => {});
        st.chat.unread = 0;
      }
    } catch {
      // next refresh
    }
  }

  async function aiReply() {
    const area = document.querySelector("#waCompose textarea");
    if (!area) return;
    if (area.value.trim() && !confirm("Remplacer le texte déjà écrit par la proposition de l’assistant ?")) return;
    const error = document.getElementById("waComposeError");
    error.textContent = "";
    const button = document.querySelector('[data-wa="ai-reply"]');
    button.disabled = true;
    area.placeholder = "L’assistant rédige une réponse…";
    try {
      const out = await api(`chats/${enc(st.jid)}/ai`, { mode: "reply" });
      area.value = out.text;
      drafts.set(st.jid, area.value);
      autoGrow(area);
      area.focus();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      button.disabled = false;
      area.placeholder = "Écrivez un message";
    }
  }

  async function summarize() {
    const jid = st.jid;
    st.summary = { loading: true };
    document.getElementById("waSummary").innerHTML = summaryBlock();
    try {
      const out = await api(`chats/${enc(jid)}/ai`, { mode: "summary" });
      if (st.jid !== jid) return;
      st.summary = { text: out.text };
    } catch (error) {
      if (st.jid !== jid) return;
      st.summary = { error: error.message };
    }
    const el = document.getElementById("waSummary");
    if (el) el.innerHTML = summaryBlock();
  }

  // -------------------------------------------------------------------------
  // Dialogs: new conversation, access, quick replies, filing, reminder, client
  // -------------------------------------------------------------------------
  function openNew() {
    const s = core()?.getState?.() || {};
    const withPhone = (s.clients || []).filter((c) => !c.deletedAt && phoneKey(c.phone));
    core().modal(
      "Nouvelle conversation WhatsApp",
      `<form id="waNewForm" class="wm-compose" novalidate>
        <label>Client<select name="client"><option value="">— Saisir un numéro —</option>${withPhone.map((c) => `<option value="${esc(c.id)}" data-phone="${esc(c.phone)}" data-name="${esc(c.name)}">${esc(c.name)} · ${esc(c.phone)}</option>`).join("")}</select></label>
        <label>Numéro<input name="phone" inputmode="tel" placeholder="+41 79 123 45 67"></label>
        <label>Nom (facultatif)<input name="name" maxlength="120"></label>
        <p class="muted">Une conversation à la fois : l’application n’envoie jamais de messages en masse.</p>
        <p id="waNewError" class="error" role="alert"></p>
        <div class="form-actions"><button type="button" class="btn secondary" data-action="close-modal">Annuler</button><button type="submit" class="btn primary">Ouvrir la conversation</button></div>
      </form>`,
    );
  }

  async function openAccess() {
    let data;
    try {
      data = await api("access");
    } catch (error) {
      return toast(error.message);
    }
    const roles = { admin: "Administrateur", direction: "Direction", hr: "RH", manager: "Responsable", accounting: "Comptabilité", employee: "Employé" };
    core().modal(
      "Accès à WhatsApp",
      `<div class="wm-access"><p>Les administrateurs du groupe ont toujours accès. Cochez les personnes qui peuvent lire et répondre aux messages WhatsApp du groupe. Chaque changement est enregistré tout de suite.</p>${data.users
        .map(
          (u) => `<div class="wm-access-user"><div><b>${esc(u.name)}</b><small>${esc(roles[u.role] || u.role)} · ${esc(u.company || "")}</small></div>
          <div class="wm-access-boxes"><label class="wm-access-box${u.automatic ? " auto" : ""}"><input type="checkbox" data-wa-access="${esc(u.id)}" ${u.automatic || u.granted ? "checked" : ""} ${u.automatic ? "disabled" : ""}> WhatsApp</label></div></div>`,
        )
        .join("")}<div class="form-actions"><button type="button" class="btn primary" data-action="close-modal">Terminé</button></div></div>`,
    );
  }

  async function openSnippets() {
    const list = await loadSnippets(true);
    core().modal(
      "Réponses rapides WhatsApp",
      `<div class="wm-snippets">
        <p class="muted">Des textes prêts à insérer (menu « Réponses rapides » sous la conversation). Partagés par tous ceux qui ont accès à WhatsApp.</p>
        <div class="wm-snippet-list">${
          list.length
            ? list.map((x) => `<div class="wm-snippet-row"><b>${esc(x.title)}</b><span class="wm-snippet-actions"><button type="button" class="btn secondary" data-wa="snippet-edit" data-id="${esc(x.id)}">Modifier</button><button type="button" class="btn danger" data-wa="snippet-delete" data-id="${esc(x.id)}">Supprimer</button></span></div>`).join("")
            : '<p class="muted">Aucune réponse rapide pour l’instant.</p>'
        }</div>
        <form id="waSnippetForm" class="wm-compose" novalidate>
          <h4>Nouvelle réponse rapide</h4>
          <input type="hidden" name="id">
          <label>Nom<input name="title" maxlength="80" placeholder="Ex. : Horaires d’ouverture"></label>
          <label>Texte<textarea name="text" rows="5" placeholder="Bonjour, nous sommes ouverts du lundi au vendredi…"></textarea></label>
          <p id="waSnippetError" class="error" role="alert"></p>
          <div class="form-actions"><button type="button" class="btn secondary" data-action="close-modal">Fermer</button><button type="submit" class="btn primary">Enregistrer</button></div>
        </form>
      </div>`,
    );
  }

  function openFile() {
    const s = core()?.getState?.() || {};
    const same = core().same || ((a, b) => String(a) === String(b));
    const projects = (s.projects || []).filter((p) => !p.deletedAt && p.status !== "Archivé");
    const clients = (s.clients || []).filter((c) => !c.deletedAt);
    if (!projects.length && !clients.length) return toast("Aucun chantier ni client disponible.");
    const key = phoneKey(st.chat?.phone);
    const client = key ? clients.find((c) => phoneKey(c.phone) === key) : null;
    const theirs = client ? projects.filter((p) => same(p.clientId, client.id)) : [];
    const option = (value, label) => `<option value="${esc(value)}">${esc(label)}</option>`;
    const groups = [
      client ? `<optgroup label="${esc(client.name)}">${option("client:" + client.id, "Client : " + client.name)}${theirs.map((p) => option("project:" + p.id, "Chantier : " + (p.title || p.id))).join("")}</optgroup>` : "",
      projects.length ? `<optgroup label="Chantiers">${projects.filter((p) => !theirs.includes(p)).map((p) => option("project:" + p.id, p.title || p.id)).join("")}</optgroup>` : "",
      clients.length ? `<optgroup label="Clients">${clients.filter((c) => c !== client).map((c) => option("client:" + c.id, c.name)).join("")}</optgroup>` : "",
    ].join("");
    const media = st.messages.filter((m) => !m.deleted && ["image", "video", "document", "voice", "audio"].includes(m.kind)).slice(-20).reverse();
    core().modal(
      "Classer dans les documents",
      `<form id="waFileForm" class="wm-compose" novalidate>
        <p class="muted">Conversation avec ${esc(st.chat?.name || "")}</p>
        <label>Où l’enregistrer<select name="target">${groups}</select></label>
        <fieldset class="wm-forward-files"><legend>Quoi</legend>
          <label class="wm-inline"><input type="checkbox" name="transcript" checked> La conversation en PDF, sur les <select name="days" class="wa-days" aria-label="Période"><option value="7">7 derniers jours</option><option value="30" selected>30 derniers jours</option><option value="90">3 derniers mois</option><option value="365">12 derniers mois</option></select></label>
          ${media.map((m) => `<label class="wm-inline"><input type="checkbox" name="media" value="${esc(m.id)}"> ${esc(m.fileName || KIND_LABEL[m.kind])} <small>(${esc(shortDate(m.at))}${m.size ? " · " + esc(size(m.size)) : ""})</small></label>`).join("")}
        </fieldset>
        <p id="waFileError" class="error" role="alert"></p>
        <div class="form-actions"><button type="button" class="btn secondary" data-action="close-modal">Annuler</button><button type="submit" class="btn primary">${ic("folder")}<span>Enregistrer</span></button></div>
      </form>`,
    );
  }

  function openRemind() {
    const s = core()?.getState?.() || {};
    const projects = (s.projects || []).filter((p) => !p.deletedAt && !["Terminé", "Archivé"].includes(p.status));
    const choices = [...scheduleChoices(), ["Dans une semaine", atHour(7, 8)]];
    core().modal(
      "Me le rappeler",
      `<form id="waRemindForm" class="wm-compose" novalidate>
        <p class="muted">La conversation quitte la liste et revient en haut, au moment choisi, avec une notification.</p>
        <div class="wm-schedule-choices">${choices.map(([label, d]) => `<button type="button" class="btn secondary" data-wa="remind-pick" data-value="${esc(localInput(d))}">${esc(label)}</button>`).join("")}</div>
        <label>Le<input type="datetime-local" name="at" value="${esc(localInput(atHour(1, 8)))}"></label>
        ${
          projects.length
            ? `<label class="wm-inline"><input type="checkbox" name="task"> Créer aussi une tâche sur un chantier</label>
               <div class="wm-task" hidden><label>Chantier<select name="project">${projects.map((p) => `<option value="${esc(p.id)}">${esc(p.title || p.id)}</option>`).join("")}</select></label>
               <label>Tâche<input name="taskTitle" maxlength="200" value="${esc(("WhatsApp : " + (st.chat?.name || "")).slice(0, 200))}"></label></div>`
            : ""
        }
        <p id="waRemindError" class="error" role="alert"></p>
        <div class="form-actions"><button type="button" class="btn secondary" data-action="close-modal">Annuler</button><button type="submit" class="btn primary">${ic("bell")}<span>Me le rappeler</span></button></div>
      </form>`,
    );
  }

  function createClient() {
    const opener = document.createElement("button");
    opener.type = "button";
    opener.hidden = true;
    opener.dataset.action = "new";
    opener.dataset.id = "clients";
    document.body.append(opener);
    opener.click();
    opener.remove();
    let tries = 0;
    const fill = () => {
      const phone = document.getElementById("f_phone");
      if (!phone) return ++tries < 20 && setTimeout(fill, 50);
      phone.value = st.chat?.phone || "";
      const name = document.getElementById("f_name");
      if (name && !name.value && st.chat?.name && !/^\+?\d[\d\s]+$/.test(st.chat.name)) name.value = st.chat.name;
    };
    fill();
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------
  document.addEventListener("click", async (event) => {
    const el = event.target.closest("[data-wa]");
    if (!el) return;
    const what = el.dataset.wa;
    if (what === "filter") {
      st.filter = el.dataset.id;
      st.chats = [];
      return loadChats();
    }
    if (what === "open") return openChat(el.dataset.jid);
    if (what === "more") return loadChats({ append: true });
    if (what === "older") return loadOlder();
    if (what === "back") return closeChat();
    if (what === "quote") {
      st.quoted = st.messages.find((m) => m.id === el.dataset.id) || null;
      const area = document.querySelector("#waCompose textarea");
      if (area) drafts.set(st.jid, area.value);
      renderConversation();
      return document.querySelector("#waCompose textarea")?.focus();
    }
    if (what === "quote-cancel") {
      st.quoted = null;
      const area = document.querySelector("#waCompose textarea");
      if (area) drafts.set(st.jid, area.value);
      return renderConversation();
    }
    if (what === "file-remove") {
      files.splice(Number(el.dataset.index), 1);
      return renderFiles();
    }
    if (what === "app-remove") {
      appFiles.splice(Number(el.dataset.index), 1);
      renderFiles();
      return renderAppPicker();
    }
    if (what === "app-files") {
      st.picker = !st.picker;
      document.getElementById("waAppPicker").hidden = !st.picker;
      el.setAttribute("aria-expanded", String(st.picker));
      if (st.picker) {
        renderAppPicker();
        document.getElementById("waAppSearch")?.focus();
      }
      return;
    }
    if (what === "schedule-toggle") {
      const form = el.closest("form");
      const box = form.querySelector(".wa-schedule");
      box.hidden = !box.hidden;
      el.setAttribute("aria-expanded", String(!box.hidden));
      el.classList.toggle("active", !box.hidden);
      if (!box.hidden && !form.elements.sendAt.value) form.elements.sendAt.value = localInput(atHour(1, 8));
      return;
    }
    if (what === "schedule-pick") {
      el.closest("form").elements.sendAt.value = el.dataset.value;
      return;
    }
    if (what === "remind-pick") {
      el.closest("form").elements.at.value = el.dataset.value;
      return;
    }
    if (what === "ai-reply") return aiReply();
    if (what === "summary") return summarize();
    if (what === "summary-close") {
      st.summary = null;
      document.getElementById("waSummary").innerHTML = "";
      return;
    }
    if (what === "new") return openNew();
    if (what === "access") return openAccess();
    if (what === "snippets") return openSnippets();
    if (what === "snippet-edit") {
      const snippet = (snippets || []).find((x) => x.id === el.dataset.id);
      const form = document.getElementById("waSnippetForm");
      if (!snippet || !form) return;
      form.querySelector("h4").textContent = "Modifier « " + snippet.title + " »";
      form.elements.id.value = snippet.id;
      form.elements.title.value = snippet.title;
      form.elements.text.value = snippet.text;
      return form.elements.title.focus();
    }
    if (what === "snippet-delete") {
      if (!confirm("Supprimer cette réponse rapide ?")) return;
      try {
        await api(`snippets/${enc(el.dataset.id)}/delete`, {});
        return openSnippets();
      } catch (error) {
        return toast(error.message);
      }
    }
    if (what === "file") return openFile();
    if (what === "remind") return openRemind();
    if (what === "unsnooze" || what === "archive" || what === "unarchive" || what === "unread") {
      const jid = st.jid;
      try {
        if (what === "unsnooze") await api(`chats/${enc(jid)}/unsnooze`, {});
        else await api(`chats/${enc(jid)}/state`, what === "unread" ? { unread: true } : { archived: what === "archive" });
        toast({ unsnooze: "Rappel annulé.", archive: "Conversation archivée dans l’application.", unarchive: "Conversation remise dans la liste.", unread: "Marquée comme non lue." }[what]);
        if (what === "archive" || what === "unread") closeChat();
        else if (st.chat) {
          st.chat.snoozedUntil = null;
          st.chat.archived = false;
          renderConversation();
        }
        loadChats({ quiet: true });
        loadStatus(true);
      } catch (error) {
        toast(error.message);
      }
      return;
    }
    if (what === "create-client") return createClient();
    if (what === "outbox-cancel") {
      el.disabled = true;
      try {
        const out = await api(`outbox/${enc(el.dataset.id)}/cancel`, {});
        drafts.set(out.jid, out.text || "");
        toast(out.files?.length ? "Envoi annulé : le texte est revenu dans la conversation (rajoutez les fichiers)." : "Envoi annulé : le texte est revenu dans la conversation.");
        await loadOutbox();
        st.filter = "all";
        loadChats();
        openChat(out.jid);
      } catch (error) {
        toast(error.message);
        el.disabled = false;
      }
      return;
    }
    if (what === "link-qr" || what === "link-cancel") {
      try {
        if (what === "link-qr") await api("link", { method: "qr" });
        else await api("unlink", {});
      } catch (error) {
        toast(error.message);
      }
      return pollLink();
    }
    if (what === "unlink") {
      if (!confirm("Délier WhatsApp ? L’application ne recevra plus les messages (ceux déjà enregistrés restent). Il faudra relier à nouveau avec le téléphone.")) return;
      try {
        await api("unlink", {});
        toast("WhatsApp est délié.");
      } catch (error) {
        toast(error.message);
      }
      return loadStatus(true);
    }
  });

  document.addEventListener("mousedown", (event) => {
    if (event.target.closest?.("[data-wa-wrap]")) event.preventDefault();
  });
  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-wa-wrap]");
    if (!button) return;
    const area = document.querySelector("#waCompose textarea");
    if (!area) return;
    const mark = button.dataset.waWrap;
    const start = area.selectionStart;
    const end = area.selectionEnd;
    const chosen = area.value.slice(start, end);
    area.value = area.value.slice(0, start) + mark + (chosen || "texte") + mark + area.value.slice(end);
    area.focus();
    area.selectionStart = start + 1;
    area.selectionEnd = start + 1 + (chosen || "texte").length;
    drafts.set(st.jid, area.value);
  });

  document.addEventListener("change", async (event) => {
    const t = event.target;
    if (t.id === "waFiles") {
      files.push(...t.files);
      t.value = "";
      const error = document.getElementById("waComposeError");
      if (error) error.textContent = files.reduce((n, f) => n + f.size, 0) > MAX_UPLOAD ? "Fichiers : 18 Mo au maximum au total." : "";
      return renderFiles();
    }
    if (t.dataset?.waApp) {
      const [kind, ...rest] = t.dataset.waApp.split(":");
      const id = rest.join(":");
      appFiles = appFiles.filter((a) => !(a.kind === kind && a.id === id));
      if (t.checked) appFiles.push({ kind, id, label: t.dataset.label || id });
      return renderFiles();
    }
    if (t.matches?.("[data-wa-snippet]")) {
      const value = t.value;
      t.value = "";
      const area = document.querySelector("#waCompose textarea");
      if (!value || !area) return;
      if (value === "__save") {
        if (!area.value.trim()) return toast("Écrivez d’abord le texte à enregistrer.");
        const title = String(prompt("Nom de la réponse rapide :") || "").trim();
        if (!title) return;
        try {
          await api("snippets", { title, text: area.value });
          await loadSnippets(true);
          fillSnippets();
          toast(`Réponse rapide « ${title} » enregistrée.`);
        } catch (error) {
          toast(error.message);
        }
        return;
      }
      const snippet = (snippets || []).find((x) => x.id === value);
      if (snippet) insertText(area, snippet.text);
      return;
    }
    if (t.dataset?.waAccess) {
      try {
        await api("access", { userId: Number(t.dataset.waAccess), granted: t.checked });
        toast("Accès enregistré.");
      } catch (error) {
        t.checked = !t.checked;
        toast(error.message);
      }
      return;
    }
    if (t.name === "client" && t.closest("#waNewForm")) {
      const option = t.selectedOptions[0];
      const form = t.closest("form");
      if (option?.dataset.phone) {
        form.elements.phone.value = option.dataset.phone;
        form.elements.name.value = option.dataset.name || "";
      }
      return;
    }
    if (t.name === "task" && t.closest("#waRemindForm")) t.closest("form").querySelector(".wm-task").hidden = !t.checked;
  });

  document.addEventListener("input", (event) => {
    if (event.target.id === "waAppSearch") return renderAppPicker();
    if (event.target.matches?.("#waCompose textarea")) {
      autoGrow(event.target);
      drafts.set(st.jid, event.target.value);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (!event.target.matches?.("#waCompose textarea") || event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    // On a phone, « Entrée » goes to the line; on a computer it sends (Maj+Entrée: new line).
    if (window.matchMedia?.("(pointer: coarse)").matches && !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    event.target.form.requestSubmit();
  });

  document.addEventListener("search", (event) => {
    if (event.target.closest?.("#waSearch") && !event.target.value && st.query) {
      st.query = "";
      loadChats();
    }
  });

  document.addEventListener("submit", async (event) => {
    const form = event.target;
    if (form.id === "waSearch") {
      event.preventDefault();
      st.query = form.elements.q.value.trim();
      if (st.filter === "outbox") st.filter = "all";
      return loadChats();
    }
    if (form.id === "waCompose") {
      event.preventDefault();
      return send(form);
    }
    if (form.id === "waLinkCode") {
      event.preventDefault();
      try {
        await api("link", { method: "code", phone: form.elements.phone.value });
      } catch (error) {
        return toast(error.message);
      }
      return pollLink();
    }
    if (form.id === "waNewForm") {
      event.preventDefault();
      try {
        const out = await api("new", { phone: form.elements.phone.value, name: form.elements.name.value });
        core().closeModal(true);
        st.filter = "all";
        st.query = "";
        await loadChats();
        openChat(out.jid);
      } catch (error) {
        document.getElementById("waNewError").textContent = error.message;
      }
      return;
    }
    if (form.id === "waSnippetForm") {
      event.preventDefault();
      try {
        await api("snippets", { id: form.elements.id.value || undefined, title: form.elements.title.value, text: form.elements.text.value });
        toast("Réponse rapide enregistrée.");
        snippets = null;
        openSnippets();
      } catch (error) {
        document.getElementById("waSnippetError").textContent = error.message;
      }
      return;
    }
    if (form.id === "waFileForm") {
      event.preventDefault();
      const [type, ...rest] = String(form.elements.target.value || "").split(":");
      const ids = [...form.querySelectorAll("input[name=media]:checked")].map((x) => x.value);
      if (!form.elements.transcript.checked && !ids.length) {
        document.getElementById("waFileError").textContent = "Choisissez la conversation ou au moins un fichier.";
        return;
      }
      const button = form.querySelector("[type=submit]");
      button.disabled = true;
      try {
        const out = await api(`chats/${enc(st.jid)}/file`, { target: { type, id: rest.join(":") }, transcript: form.elements.transcript.checked, days: Number(form.elements.days.value), ids });
        core().closeModal(true);
        toast(`${out.saved.length > 1 ? out.saved.length + " fichiers enregistrés" : "Enregistré"} dans les documents de ${out.target}.`);
        core().refresh?.(false);
      } catch (error) {
        document.getElementById("waFileError").textContent = error.message;
        button.disabled = false;
      }
      return;
    }
    if (form.id === "waRemindForm") {
      event.preventDefault();
      const value = form.elements.at.value;
      if (!value) {
        document.getElementById("waRemindError").textContent = "Choisissez la date et l’heure.";
        return;
      }
      const jid = st.jid;
      try {
        const out = await api(`chats/${enc(jid)}/remind`, { at: new Date(value).toISOString() });
        let task = "";
        if (form.elements.task?.checked)
          try {
            await core().api("operations/tasks", { projectId: form.elements.project.value, title: form.elements.taskTitle.value.trim() || "Message WhatsApp à traiter", description: `WhatsApp avec ${st.chat?.name || ""} (${st.chat?.phone || ""})`.slice(0, 3000), dueDate: value.slice(0, 10), priority: "normal" });
            task = " Tâche ajoutée au chantier.";
          } catch (error) {
            task = " (tâche non créée : " + error.message + ")";
          }
        core().closeModal(true);
        toast(`Rappel ${fullDate(out.remindAt)}.${task}`);
        closeChat();
        loadChats({ quiet: true });
      } catch (error) {
        document.getElementById("waRemindError").textContent = error.message;
      }
    }
  });

  window.addEventListener("resize", () => {
    if (core()?.getPage?.() === "whatsapp") fitHeight();
  });

  // -------------------------------------------------------------------------
  // Live: status (and the QR code), new messages while the page is open
  // -------------------------------------------------------------------------
  async function pollLink() {
    clearTimeout(statusTimer);
    await loadStatus(true);
    const s = st.status || {};
    if (core()?.getPage?.() === "whatsapp" && !s.connected && ["waiting", "connecting", "reconnecting"].includes(s.status)) statusTimer = setTimeout(pollLink, 2000);
    else if (s.connected) loadChats({ quiet: true });
  }

  function ensureLive() {
    if (liveTimer) return;
    liveTimer = setInterval(async () => {
      if (!core()?.getProfile?.() || document.visibilityState !== "visible") return;
      const onPage = core().getPage?.() === "whatsapp" && st.root?.isConnected && hasAccess();
      if (!onPage) {
        if (Date.now() - st.statusAt > 60000) loadStatus(true);
        return;
      }
      await loadStatus(true);
      if (["waiting", "connecting", "reconnecting"].includes(st.status?.status)) return pollLink();
      if (st.filter !== "outbox") loadChats({ quiet: true });
      if (st.jid) refreshConversation();
    }, 6000);
  }

  function afterRender() {
    const me = core()?.getProfile?.();
    if (!me) return;
    ensureLive();
    loadStatus().then(updateNavBadge);
    const params = new URLSearchParams(location.search);
    if (params.get("open") === "whatsapp" && handledUrl !== location.search) {
      handledUrl = location.search;
      const chat = params.get("chat");
      history.replaceState(null, "", "/");
      if (chat) {
        st.jid = chat;
        st.reading = true;
        st.messages = [];
      }
      core().setPage?.("whatsapp");
    }
  }

  function prepare({ chat = "" } = {}) {
    if (chat) {
      st.jid = chat;
      st.reading = true;
      st.messages = [];
    }
  }

  window.SGOWhatsApp = { render, afterRender, hasAccess, unreadTotal, loadStatus, prepare, _state: st };
  if (core()?.getProfile?.()) {
    afterRender();
    if (core().getPage?.() === "whatsapp") render(document.getElementById("whatsappRoot"));
  }
})();
