// « Boîte mail »: the companies' Gmail mailboxes inside the application. Folders, conversations,
// reading (each message in an isolated frame that runs no script, external images on request),
// replying, forwarding, attachments, the client behind an address, and the assistant (summary,
// proposed reply). Everything is read from and written to Gmail by the server (/api/webmail).
(() => {
  "use strict";
  const core = () => window.SGOChatCore;
  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  const ic = (name) => window.SGOIcon?.(name) || "";
  const enc = encodeURIComponent;
  const api = (path, body) => core().api("webmail/" + path, body);
  const toast = (message) => core()?.toast?.(message);
  const MAX_UPLOAD = 18 * 1024 * 1024;
  const ROLE_NAMES = { admin: "Administrateur", direction: "Direction", hr: "RH", manager: "Responsable", accounting: "Comptabilité", employee: "Employé" };
  const CLIENT_EDITORS = ["admin", "direction", "manager", "accounting"];
  const FOLDER_ICONS = { inbox: "inbox", flagged: "star", important: "alert", sent: "send", drafts: "file", archive: "archive", all: "mail", junk: "alert", trash: "trash" };
  const DONE = {
    archive: "Conversation archivée.",
    trash: "Conversation placée dans la corbeille.",
    spam: "Conversation signalée comme spam.",
    inbox: "Conversation remise dans la boîte de réception.",
    delete: "Conversation supprimée définitivement.",
    move: "Conversation déplacée.",
    read: "Marquée comme lue.",
    unread: "Marquée comme non lue.",
  };

  const st = {
    user: "",
    status: null,
    statusAt: 0,
    statusLoading: null,
    root: null,
    box: "",
    folder: "inbox",
    folders: [],
    foldersFor: "",
    foldersError: "",
    query: "",
    page: 0,
    list: [],
    total: 0,
    more: false,
    listKey: "",
    listLoading: false,
    listError: "",
    selected: new Set(),
    openRef: null,
    conv: null,
    convLoading: false,
    convError: "",
    expanded: new Set(),
    images: new Set(),
    summary: null,
    reading: false,
  };
  const drafts = new Map();
  let composeFiles = [];
  let timer = null;
  let handledUrl = "";

  // -------------------------------------------------------------------------
  // Status: which mailboxes the person may open, unread counts (menu badge)
  // -------------------------------------------------------------------------
  const hasAccess = () => !!st.status?.mailboxes?.length;
  const unreadTotal = () => (st.status?.mailboxes || []).reduce((total, b) => total + (Number(b.unread) || 0), 0);
  const currentBox = () => (st.status?.mailboxes || []).find((b) => b.id === st.box) || null;
  const ownAddress = () => String(currentBox()?.address || "").toLowerCase();

  function resetIfUserChanged() {
    const me = core()?.getProfile?.();
    const id = me ? String(me.id || me.email || "") : "";
    if (id === st.user) return;
    Object.assign(st, { user: id, status: null, statusAt: 0, box: "", folder: "inbox", folders: [], foldersFor: "", query: "", page: 0, list: [], listKey: "", conv: null, openRef: null, summary: null, reading: false });
    st.selected.clear();
    st.expanded.clear();
    st.images.clear();
    drafts.clear();
  }

  async function loadStatus(force = false) {
    resetIfUserChanged();
    const me = core()?.getProfile?.();
    if (!me || me.role === "client") {
      st.status = { mailboxes: [], canManage: false };
      return st.status;
    }
    if (!force && st.status && Date.now() - st.statusAt < 55000) return st.status;
    if (st.statusLoading) return st.statusLoading;
    const before = hasAccess();
    st.statusLoading = api("status")
      .then((status) => {
        st.status = status;
        st.statusAt = Date.now();
        afterStatus(before);
        return status;
      })
      .catch(() => st.status || { mailboxes: [] })
      .finally(() => {
        st.statusLoading = null;
      });
    return st.statusLoading;
  }

  function afterStatus(before) {
    updateNavBadge();
    if (before !== hasAccess()) {
      // The menu entry appears (or disappears): rebuild the page, unless someone is typing.
      const active = document.activeElement;
      const typing = active && document.getElementById("content")?.contains(active) && active.matches("input, textarea, select");
      if (!typing) core()?.render?.();
    } else if (st.root?.isConnected) updateBoxCounts();
  }

  // Unread counts on the mailbox buttons, without touching the search field being typed in.
  function updateBoxCounts() {
    for (const b of st.status?.mailboxes || []) {
      const button = document.querySelector(`#wmTop .wm-box[data-id="${cssq(b.id)}"]`);
      if (!button) continue;
      let badge = button.querySelector(".wm-count");
      if (!Number(b.unread)) {
        badge?.remove();
        continue;
      }
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "wm-count";
        button.append(badge);
      }
      badge.textContent = b.unread > 999 ? "999+" : String(b.unread);
      badge.setAttribute("aria-label", `${b.unread} non lus`);
    }
  }

  function updateNavBadge() {
    const item = document.querySelector('.nav-item[data-page="mailbox"]');
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

  function setBoxUnread(boxId, unread) {
    const box = (st.status?.mailboxes || []).find((b) => b.id === boxId);
    if (!box || !Number.isFinite(Number(unread))) return;
    box.unread = Number(unread);
    updateNavBadge();
  }

  // -------------------------------------------------------------------------
  // Formatting helpers
  // -------------------------------------------------------------------------
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  function shortDate(iso) {
    const d = new Date(iso || 0);
    if (Number.isNaN(d.getTime()) || !iso) return "";
    const now = new Date();
    if (sameDay(d, now)) return d.toLocaleTimeString("fr-CH", { hour: "2-digit", minute: "2-digit" });
    if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString("fr-CH", { day: "numeric", month: "short" });
    return d.toLocaleDateString("fr-CH");
  }
  function fullDate(iso) {
    const d = new Date(iso || 0);
    if (Number.isNaN(d.getTime()) || !iso) return "";
    return d.toLocaleString("fr-CH", { weekday: "short", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  const size = (bytes) => (bytes >= 1048576 ? (bytes / 1048576).toFixed(1).replace(".", ",") + " Mo" : Math.max(1, Math.round(bytes / 1024)) + " Ko");
  const money = (n) => "CHF " + (Number(n) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, "’");
  const nameOf = (a) => {
    if (!a) return "";
    if (a.address && a.address === ownAddress()) return "moi";
    return a.name || a.address || "";
  };
  const initials = (a) =>
    (String(a?.name || a?.address || "?")
      .replace(/@.*/, "")
      .split(/[\s._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join("") || "?").toUpperCase();
  const hue = (text) => [...String(text || "")].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
  // Colour of the initials: one of twelve, from the address (no inline style: the page's
  // security policy refuses style attributes).
  const avatar = (a) => `<span class="wm-avatar" data-hue="${Math.floor(hue(a?.address) / 30)}" aria-hidden="true">${esc(initials(a))}</span>`;
  const mkey = (m) => `${m.folder}:${m.uid}`;
  const folderName = () => st.folders.find((f) => f.id === st.folder)?.name || "Boîte de réception";
  const listKey = () => [st.box, st.folder, st.query].join("|");
  const unique = (list) => [...new Set(list.filter(Boolean))];
  const boxPath = (box = st.box) => enc(box);
  const cssq = (value) => (window.CSS?.escape ? window.CSS.escape(String(value)) : String(value).replace(/["\\]/g, "\\$&"));

  function trustedSenders() {
    try {
      return new Set(JSON.parse(localStorage.getItem("sgo_wm_images") || "[]"));
    } catch {
      return new Set();
    }
  }
  function trustSender(address) {
    try {
      const list = trustedSenders();
      list.add(address);
      localStorage.setItem("sgo_wm_images", JSON.stringify([...list].slice(-500)));
    } catch {
      // private browsing: only for this message
    }
  }

  // Conversations from the loaded messages (newest first): Gmail gives each one a thread id.
  function threads() {
    const out = [];
    const byKey = new Map();
    for (const m of st.list) {
      const key = m.threadId ? "t" + m.threadId : "u" + m.uid;
      let t = byKey.get(key);
      if (!t) {
        t = { key, threadId: m.threadId, latest: m, uids: [], count: 0, unread: false, flagged: false, attachments: false, people: [] };
        byKey.set(key, t);
        out.push(t);
      }
      t.uids.push(m.uid);
      t.count++;
      if (!m.seen) t.unread = true;
      if (m.flagged) t.flagged = true;
      if (m.attachments) t.attachments = true;
      const outgoing = ["sent", "drafts"].includes(st.folder) || m.from?.address === ownAddress();
      const person = outgoing ? (m.to?.[0] ? "À : " + nameOf(m.to[0]) : "(sans destinataire)") : nameOf(m.from) || "(inconnu)";
      if (!t.people.includes(person)) t.people.push(person);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Page
  // -------------------------------------------------------------------------
  async function render(root) {
    if (!root) return;
    st.root = root;
    resetIfUserChanged();
    if (!st.status) root.innerHTML = `<div class="card wm-empty"><p>Chargement de la boîte mail…</p></div>`;
    await loadStatus();
    if (!root.isConnected || st.root !== root) return;
    if (!hasAccess()) {
      root.innerHTML = `<div class="card wm-empty">${ic("mail")}<h3>Boîte mail</h3><p>${
        st.status?.configured === false
          ? "Aucune adresse Gmail n’est encore configurée sur le serveur."
          : "Aucune boîte mail ne vous est ouverte. Un administrateur peut vous en donner l’accès."
      }</p></div>`;
      return;
    }
    if (!currentBox()) selectBox(st.status.mailboxes[0].id, false);
    root.innerHTML = `<div class="wm" id="wmApp"><div class="wm-top" id="wmTop"></div><div class="wm-main" id="wmMain"><nav class="wm-folders" id="wmFolders" aria-label="Dossiers"></nav><section class="wm-list card" id="wmList" aria-label="Messages"></section><section class="wm-reader card" id="wmReader" aria-label="Lecture du message" tabindex="-1"></section></div></div>`;
    applyReading();
    renderTop();
    renderFolders();
    renderList();
    renderReader();
    fitHeight();
    if (st.foldersFor !== st.box) loadFolders();
    if (st.listKey !== listKey()) loadList();
  }

  // On a computer the three columns fill the window and scroll on their own.
  function fitHeight() {
    const main = document.getElementById("wmMain");
    if (!main) return;
    if (window.innerWidth <= 900) {
      main.style.height = "";
      return;
    }
    const top = main.getBoundingClientRect().top + window.scrollY;
    main.style.height = Math.max(460, window.innerHeight - top - 18) + "px";
  }

  function applyReading() {
    document.getElementById("wmApp")?.classList.toggle("wm-reading", !!st.reading);
  }

  function renderTop() {
    const el = document.getElementById("wmTop");
    if (!el) return;
    const boxes = st.status?.mailboxes || [];
    el.innerHTML = `
      <div class="wm-boxes" role="tablist" aria-label="Boîtes mail">${boxes
        .map(
          (b) =>
            `<button type="button" role="tab" class="wm-box${b.id === st.box ? " active" : ""}" aria-selected="${b.id === st.box}" data-wm="box" data-id="${esc(b.id)}"><span class="wm-box-name">${esc(b.label)}</span><small>${esc(b.address)}</small>${
              Number(b.unread) ? `<span class="wm-count" aria-label="${b.unread} non lus">${b.unread > 999 ? "999+" : b.unread}</span>` : ""
            }</button>`,
        )
        .join("")}</div>
      <form class="wm-search" id="wmSearch" role="search">
        ${ic("search")}
        <input type="search" name="q" value="${esc(st.query)}" placeholder="Rechercher dans ${esc(folderName().toLowerCase())}" aria-label="Rechercher dans les e-mails" title="Astuces : from:dupont · has:attachment · is:unread · after:2026/11/01">
      </form>
      <div class="wm-top-actions">
        <button type="button" class="btn primary" data-wm="compose">${ic("edit")}<span>Nouveau message</span></button>
        <button type="button" class="btn secondary wm-icon-btn" data-wm="refresh" title="Actualiser" aria-label="Actualiser">${ic("refresh")}</button>
        ${st.status?.canManage ? `<button type="button" class="btn secondary" data-wm="access">${ic("lock")}<span>Accès</span></button>` : ""}
      </div>`;
  }

  function renderFolders() {
    const el = document.getElementById("wmFolders");
    if (!el) return;
    if (!st.folders.length) {
      el.innerHTML = st.foldersError
        ? `<p class="wm-error">${esc(st.foldersError)}</p><button type="button" class="btn secondary" data-wm="refresh">Réessayer</button>`
        : `<p class="muted wm-loading">Dossiers…</p>`;
      return;
    }
    const count = (f) => {
      const n = f.id === "drafts" ? f.total : ["inbox", "junk"].includes(f.id) ? f.unseen : 0;
      return n ? `<span class="wm-folder-count">${n > 9999 ? "9999+" : n}</span>` : "";
    };
    const specials = st.folders.filter((f) => f.special);
    const labels = st.folders.filter((f) => !f.special);
    const button = (f) =>
      `<button type="button" class="wm-folder${f.id === st.folder ? " active" : ""}" data-wm="folder" data-id="${esc(f.id)}" ${f.id === st.folder ? 'aria-current="true"' : ""}>${ic(FOLDER_ICONS[f.id] || "folder")}<span>${esc(f.name)}</span>${count(f)}</button>`;
    el.innerHTML = `
      <div class="wm-folder-list">${specials.map(button).join("")}${labels.length ? `<p class="wm-folder-group">Libellés</p>${labels.map(button).join("")}` : ""}</div>
      <label class="wm-folder-select"><span>Dossier</span><select id="wmFolderSelect">${st.folders
        .map((f) => `<option value="${esc(f.id)}" ${f.id === st.folder ? "selected" : ""}>${esc(f.name)}${f.unseen && ["inbox", "junk"].includes(f.id) ? ` (${f.unseen})` : ""}</option>`)
        .join("")}</select></label>`;
  }

  function bulkActions() {
    const labels = st.folders.filter((f) => !f.special && f.id !== st.folder);
    const button = (action, icon, label, cls = "secondary") =>
      `<button type="button" class="btn ${cls} wm-bulk" data-wm="bulk" data-act="${action}" title="${esc(label)}">${ic(icon)}<span>${esc(label)}</span></button>`;
    const move = labels.length
      ? `<select class="wm-move" data-wm-move aria-label="Déplacer vers un libellé"><option value="">Déplacer vers…</option>${labels.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("")}</select>`
      : "";
    if (["trash", "junk"].includes(st.folder))
      return button("inbox", "inbox", st.folder === "junk" ? "Pas un spam" : "Restaurer") + button("delete", "trash", "Supprimer définitivement", "danger");
    return (
      (st.folder === "inbox" || !["archive", "all", "sent", "drafts"].includes(st.folder) ? button("archive", "archive", "Archiver") : button("inbox", "inbox", "Boîte de réception")) +
      button("trash", "trash", "Supprimer") +
      button("read", "mail-open", "Lu") +
      button("unread", "mail", "Non lu") +
      button("spam", "alert", "Spam") +
      move
    );
  }

  function renderList() {
    const el = document.getElementById("wmList");
    if (!el) return;
    const previous = el.querySelector(".wm-rows")?.scrollTop || 0;
    const list = threads();
    for (const key of [...st.selected]) if (!list.some((t) => t.key === key)) st.selected.delete(key);
    const all = list.length && list.every((t) => st.selected.has(t.key));
    const head = `<div class="wm-list-head">
        <label class="wm-check" title="Tout sélectionner"><input type="checkbox" id="wmSelectAll" ${all ? "checked" : ""} ${list.length ? "" : "disabled"}><span class="sr-only">Tout sélectionner</span></label>
        ${
          st.selected.size
            ? `<div class="wm-bulk-actions"><b>${st.selected.size} sélectionnée${st.selected.size > 1 ? "s" : ""}</b>${bulkActions()}</div>`
            : `<div class="wm-list-title"><b>${esc(st.query ? "Résultats" : folderName())}</b><small>${st.total ? `${st.total} message${st.total > 1 ? "s" : ""}` : ""}</small></div>`
        }
      </div>`;
    let body;
    if (st.listLoading && !st.list.length) body = `<p class="muted wm-loading">Chargement des messages…</p>`;
    else if (st.listError) body = `<div class="wm-error"><p>${esc(st.listError)}</p><button type="button" class="btn secondary" data-wm="refresh">Réessayer</button></div>`;
    else if (!list.length) body = `<p class="muted wm-none">${st.query ? "Aucun message ne correspond à la recherche." : "Aucun message dans ce dossier."}</p>`;
    else
      body = list
        .map((t) => {
          const m = t.latest;
          const open = st.openRef?.key === t.key;
          return `<div class="wm-row${t.unread ? " unread" : ""}${open ? " open" : ""}${st.selected.has(t.key) ? " selected" : ""}" data-key="${esc(t.key)}">
            <label class="wm-check"><input type="checkbox" data-wm-select="${esc(t.key)}" ${st.selected.has(t.key) ? "checked" : ""}><span class="sr-only">Sélectionner</span></label>
            <button type="button" class="wm-star${t.flagged ? " on" : ""}" data-wm="star" data-key="${esc(t.key)}" aria-pressed="${t.flagged}" title="${t.flagged ? "Ne plus suivre" : "Suivre"}" aria-label="${t.flagged ? "Ne plus suivre" : "Suivre"}">${ic("star")}</button>
            <button type="button" class="wm-row-main" data-wm="open" data-key="${esc(t.key)}" ${open ? 'aria-current="true"' : ""}>
              <span class="wm-row-who">${esc(t.people.slice(0, 3).join(", "))}${t.count > 1 ? ` <small>${t.count}</small>` : ""}</span>
              <span class="wm-row-subject">${m.draft ? '<em class="wm-draft">Brouillon</em> ' : ""}${esc(m.subject || "(sans objet)")}</span>
              <span class="wm-row-meta">${t.attachments ? `<span title="Pièce jointe">${ic("paperclip")}</span>` : ""}<time datetime="${esc(m.date || "")}">${esc(shortDate(m.date))}</time></span>
            </button>
          </div>`;
        })
        .join("");
    el.innerHTML = `${head}<div class="wm-rows">${body}${
      st.more ? `<button type="button" class="btn secondary wm-more" data-wm="more" ${st.listLoading ? "disabled" : ""}>${st.listLoading ? "Chargement…" : "Messages plus anciens"}</button>` : ""
    }</div>`;
    const rows = el.querySelector(".wm-rows");
    if (rows) rows.scrollTop = previous;
  }

  // -------------------------------------------------------------------------
  // Reading a conversation
  // -------------------------------------------------------------------------
  function frameUrl(m, images) {
    return `/api/webmail/${boxPath()}/frame?folder=${enc(m.folder)}&uid=${m.uid}${images ? "&images=1" : ""}`;
  }
  function attachmentUrl(m, a, inline = false) {
    return `/api/webmail/${boxPath()}/attachment?folder=${enc(m.folder)}&uid=${m.uid}&part=${enc(a.part)}${inline ? "&inline=1" : ""}`;
  }

  function clientCard() {
    const state = core()?.getState?.() || {};
    const role = core()?.getProfile?.()?.role;
    if (!Array.isArray(state.clients) || !st.conv) return "";
    const own = ownAddress();
    const lastIn = [...st.conv.messages].reverse().find((m) => m.from?.address && m.from.address !== own);
    const people = unique(st.conv.messages.flatMap((m) => [m.from, ...(m.to || []), ...(m.cc || [])]).map((a) => a?.address).filter((a) => a && a !== own));
    const client = state.clients.find((c) => !c.deletedAt && people.includes(String(c.email || "").trim().toLowerCase()));
    const same = core().same || ((a, b) => String(a) === String(b));
    if (client) {
      const invoices = (state.invoices || []).filter(
        (i) => same(i.clientId, client.id) && !i.deletedAt && !i.archivedAt && !["Payée", "Brouillon"].includes(i.status) && (Number(i.amount) || 0) - (Number(i.paid) || 0) > 0.004,
      );
      const quotes = (state.quotes || []).filter((q) => same(q.clientId, client.id) && !q.deletedAt && !q.archivedAt && q.status === "Émise");
      const company = (state.companies || []).find((c) => same(c.id, client.company))?.name || "";
      const docs = [
        ...invoices.slice(0, 4).map((i) => `<button type="button" class="wm-chip" data-action="invoice" data-id="${esc(i.id)}">${ic("file")}Facture ${esc(i.id)} · reste ${esc(money((Number(i.amount) || 0) - (Number(i.paid) || 0)))}</button>`),
        ...quotes.slice(0, 4).map((q) => `<button type="button" class="wm-chip" data-action="quote" data-id="${esc(q.id)}">${ic("file")}Devis ${esc(q.id)} · ${esc(money(q.amount))}</button>`),
      ];
      return `<div class="wm-client">${ic("user")}<div class="wm-client-text"><b>Client : ${esc(client.name)}</b>${company ? `<small>${esc(company)}</small>` : ""}</div>
        <div class="wm-client-docs">${docs.length ? docs.join("") : '<small class="muted">Aucune facture ouverte ni devis en attente.</small>'}</div>
        ${CLIENT_EDITORS.includes(role) ? `<button type="button" class="btn secondary" data-action="client-edit" data-id="${esc(client.id)}">Fiche client</button>` : ""}</div>`;
    }
    if (lastIn && CLIENT_EDITORS.includes(role))
      return `<div class="wm-client unknown">${ic("user")}<div class="wm-client-text"><b>${esc(lastIn.from.name || lastIn.from.address)}</b><small>${esc(lastIn.from.address)} n’est pas encore dans vos clients.</small></div><button type="button" class="btn secondary" data-wm="create-client">${ic("plus")}<span>Créer le client</span></button></div>`;
    return "";
  }

  function messageCard(m) {
    const key = mkey(m);
    const from = m.from || {};
    if (!st.expanded.has(key))
      return `<button type="button" class="wm-msg collapsed" data-wm="expand" data-mkey="${esc(key)}">${avatar(from)}<span class="wm-msg-from">${esc(nameOf(from) || "(inconnu)")}</span><span class="wm-msg-snippet">${esc(m.snippet || "")}</span><time>${esc(shortDate(m.date))}</time></button>`;
    const images = st.images.has(key);
    const recipients = [
      m.to?.length ? "À : " + m.to.map(nameOf).join(", ") : "",
      m.cc?.length ? "Cc : " + m.cc.map(nameOf).join(", ") : "",
      m.bcc?.length ? "Cci : " + m.bcc.map(nameOf).join(", ") : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const icon = (action, name, label) => `<button type="button" class="wm-icon-btn" data-wm="${action}" data-mkey="${esc(key)}" title="${label}" aria-label="${label}">${ic(name)}</button>`;
    return `<article class="wm-msg" data-mkey="${esc(key)}">
      <header class="wm-msg-head">
        ${avatar(from)}
        <div class="wm-msg-who"><b>${esc(from.name || from.address || "(inconnu)")}</b>${from.name ? ` <small>&lt;${esc(from.address)}&gt;</small>` : ""}<div class="wm-msg-to">${esc(recipients)}</div></div>
        <time datetime="${esc(m.date || "")}" title="${esc(fullDate(m.date))}">${esc(shortDate(m.date))}</time>
        <div class="wm-msg-actions">${icon("reply", "reply", "Répondre")}${icon("replyAll", "reply-all", "Répondre à tous")}${icon("forward", "forward", "Transférer")}${icon("collapse", "chevron-down", "Réduire")}</div>
      </header>
      ${m.draft ? '<p class="wm-note">Brouillon enregistré dans Gmail.</p>' : ""}
      ${
        m.remoteImages && !images
          ? `<div class="wm-note wm-images">${ic("image")}<span>Images externes masquées (elles signalent à l’expéditeur que le message est ouvert).</span><button type="button" class="link-button" data-wm="images" data-mkey="${esc(key)}">Afficher les images</button>${
              from.address ? `<button type="button" class="link-button" data-wm="images-always" data-mkey="${esc(key)}">Toujours pour cet expéditeur</button>` : ""
            }</div>`
          : ""
      }
      <iframe class="wm-frame" title="Contenu du message de ${esc(from.name || from.address || "l’expéditeur")}" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" src="${esc(frameUrl(m, images))}"></iframe>
      ${
        m.attachments?.length
          ? `<div class="wm-attachments">${m.attachments
              .map(
                (a) =>
                  `<div class="wm-att">${ic("paperclip")}<span class="wm-att-name" title="${esc(a.filename)}">${esc(a.filename)}</span><small>${esc(size(a.size))}</small>${
                    /^(application\/pdf|image\/(png|jpeg|gif|webp))$/.test(a.contentType) ? `<a class="btn secondary" href="${esc(attachmentUrl(m, a, true))}" target="_blank" rel="noopener">Ouvrir</a>` : ""
                  }<a class="btn secondary" href="${esc(attachmentUrl(m, a))}" download="${esc(a.filename)}" title="Télécharger">${ic("download")}<span class="sr-only">Télécharger</span></a></div>`,
              )
              .join("")}</div>`
          : ""
      }
    </article>`;
  }

  function summaryBlock() {
    if (!st.summary) return "";
    if (st.summary.loading) return `<div class="wm-summary"><p class="muted">${ic("sparkle")} Résumé en cours…</p></div>`;
    if (st.summary.error) return `<div class="wm-summary wm-error"><p>${esc(st.summary.error)}</p></div>`;
    const lines = String(st.summary.text || "").split("\n").map((l) => l.trim()).filter(Boolean);
    const items = lines.filter((l) => /^[-•*]\s+/.test(l)).map((l) => `<li>${esc(l.replace(/^[-•*]\s+/, ""))}</li>`);
    const rest = lines.filter((l) => !/^[-•*]\s+/.test(l)).map((l) => `<p>${esc(l)}</p>`);
    return `<div class="wm-summary"><div class="wm-summary-head">${ic("sparkle")}<b>Résumé</b><button type="button" class="wm-icon-btn" data-wm="summary-close" aria-label="Fermer le résumé" title="Fermer">${ic("x")}</button></div>${items.length ? `<ul>${items.join("")}</ul>` : ""}${rest.join("")}</div>`;
  }

  function renderReader() {
    const el = document.getElementById("wmReader");
    if (!el) return;
    if (!st.openRef) {
      el.innerHTML = `<div class="wm-placeholder">${ic("mail")}<p>Sélectionnez une conversation pour la lire.</p></div>`;
      return;
    }
    if (st.convLoading || (!st.conv && !st.convError)) {
      el.innerHTML = `<div class="wm-read-head"><button type="button" class="btn secondary wm-back" data-wm="back">${ic("arrow-left")}<span>Retour</span></button></div><p class="muted wm-loading">Ouverture du message…</p>`;
      return;
    }
    if (st.convError) {
      el.innerHTML = `<div class="wm-read-head"><button type="button" class="btn secondary wm-back" data-wm="back">${ic("arrow-left")}<span>Retour</span></button></div><div class="wm-error"><p>${esc(st.convError)}</p></div>`;
      return;
    }
    const conv = st.conv;
    const inTrash = ["trash", "junk"].includes(st.openRef.folder);
    const tool = (action, icon, label) => `<button type="button" class="wm-icon-btn" data-wm="conv" data-act="${action}" title="${label}" aria-label="${label}">${ic(icon)}</button>`;
    const labels = st.folders.filter((f) => !f.special && f.id !== st.openRef.folder);
    el.innerHTML = `
      <div class="wm-read-head">
        <button type="button" class="btn secondary wm-back" data-wm="back">${ic("arrow-left")}<span>Retour</span></button>
        <div class="wm-read-tools">${
          inTrash
            ? tool("inbox", "inbox", st.openRef.folder === "junk" ? "Pas un spam" : "Restaurer") + tool("delete", "trash", "Supprimer définitivement")
            : tool(st.openRef.folder === "inbox" ? "archive" : "inbox", st.openRef.folder === "inbox" ? "archive" : "inbox", st.openRef.folder === "inbox" ? "Archiver" : "Remettre dans la boîte de réception") +
              tool("trash", "trash", "Supprimer") +
              tool("unread", "mail", "Marquer comme non lu") +
              tool("spam", "alert", "Signaler comme spam")
        }${
          labels.length && !inTrash
            ? `<select class="wm-move" data-wm-move-conv aria-label="Déplacer vers un libellé"><option value="">Déplacer…</option>${labels.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("")}</select>`
            : ""
        }</div>
      </div>
      <h2 class="wm-subject">${esc(conv.subject || "(sans objet)")}</h2>
      ${clientCard()}
      <div class="wm-ai-bar">
        <button type="button" class="btn secondary" data-wm="summary">${ic("sparkle")}<span>Résumer</span></button>
        <button type="button" class="btn secondary" data-wm="ai-reply">${ic("sparkle")}<span>Proposer une réponse</span></button>
      </div>
      <div id="wmSummary">${summaryBlock()}</div>
      <div class="wm-thread">${conv.messages.map(messageCard).join("")}</div>
      <div class="wm-reply-bar">
        <button type="button" class="btn secondary" data-wm="reply">${ic("reply")}<span>Répondre</span></button>
        <button type="button" class="btn secondary" data-wm="replyAll">${ic("reply-all")}<span>Répondre à tous</span></button>
        <button type="button" class="btn secondary" data-wm="forward">${ic("forward")}<span>Transférer</span></button>
      </div>`;
    wireFrames(el);
  }

  // Replaces one message card (expand, collapse, images) without reloading the others.
  function renderMessage(key) {
    const m = st.conv?.messages.find((x) => mkey(x) === key);
    const old = document.querySelector(`#wmReader [data-mkey="${cssq(key)}"].wm-msg`);
    if (!m || !old) return renderReader();
    const holder = document.createElement("div");
    holder.innerHTML = messageCard(m);
    const card = holder.firstElementChild;
    old.replaceWith(card);
    wireFrames(card.parentElement || document.getElementById("wmReader"));
    return card;
  }

  // The frame takes the height of the message; "•••" and late images resize it. A click on an
  // e-mail address opens a new message in the application.
  function wireFrames(container) {
    for (const frame of container.querySelectorAll("iframe.wm-frame:not([data-wired])")) {
      frame.dataset.wired = "1";
      // Wired as soon as the text is there, without waiting for slow images.
      const wire = () => {
        let doc;
        try {
          doc = frame.contentDocument;
        } catch {
          return true;
        }
        if (!doc?.documentElement || doc.URL === "about:blank" || doc.readyState === "loading") return false;
        // Height of the content itself (the page's own height is never smaller than the frame).
        const fit = () => {
          const body = doc.body;
          if (!body) return;
          let bottom = 0;
          for (const el of body.children) bottom = Math.max(bottom, el.getBoundingClientRect().bottom);
          const height = Math.ceil(bottom + (doc.defaultView?.scrollY || 0) + 10);
          frame.style.height = Math.min(Math.max(height, 48), 30000) + "px";
        };
        fit();
        if (doc.wmWired) return true;
        doc.wmWired = true;
        try {
          new ResizeObserver(fit).observe(doc.body);
        } catch {
          // older browsers: resized on images and toggles only
        }
        doc.addEventListener("toggle", fit, true);
        for (const img of doc.images || []) img.addEventListener("load", fit);
        doc.addEventListener("click", (event) => {
          const link = event.target?.closest?.("a[href^='mailto:' i]");
          if (!link) return;
          event.preventDefault();
          const address = decodeURIComponent(String(link.getAttribute("href")).slice(7).split("?")[0] || "");
          openCompose({ mode: "new", to: address });
        });
        return true;
      };
      frame.addEventListener("load", wire);
      const poll = setInterval(() => {
        if (!frame.isConnected || wire()) clearInterval(poll);
      }, 80);
    }
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------
  function selectBox(id, load = true) {
    st.box = id;
    st.folder = "inbox";
    st.folders = [];
    st.foldersFor = "";
    st.foldersError = "";
    st.query = "";
    st.list = [];
    st.listKey = "";
    st.page = 0;
    st.total = 0;
    st.more = false;
    st.selected.clear();
    closeReader();
    if (load && st.root?.isConnected) {
      renderTop();
      renderFolders();
      renderList();
      renderReader();
      loadFolders();
      loadList();
    }
  }

  function closeReader() {
    st.openRef = null;
    st.conv = null;
    st.convError = "";
    st.summary = null;
    st.reading = false;
    applyReading();
  }

  async function loadFolders(fresh = false) {
    const box = st.box;
    try {
      const out = await api(`${boxPath(box)}/folders${fresh ? "?fresh=1" : ""}`);
      if (st.box !== box) return;
      st.folders = out.folders || [];
      st.foldersFor = box;
      st.foldersError = "";
      const inbox = st.folders.find((f) => f.id === "inbox");
      if (inbox) setBoxUnread(box, inbox.unseen);
    } catch (error) {
      if (st.box !== box) return;
      st.foldersError = error.message;
    }
    renderFolders();
    updateBoxCounts();
  }

  async function loadList({ append = false, quiet = false } = {}) {
    const box = st.box;
    const folder = st.folder;
    const query = st.query;
    const page = append ? st.page + 1 : 0;
    st.listKey = listKey();
    if (!quiet) {
      st.listLoading = true;
      st.listError = "";
      if (!append) st.list = [];
      renderList();
    }
    try {
      const out = await api(`${boxPath(box)}/messages?folder=${enc(folder)}&page=${page}&q=${enc(query)}`);
      if (st.box !== box || st.folder !== folder || st.query !== query) return;
      if (append) {
        const known = new Set(st.list.map((m) => m.uid));
        st.list = [...st.list, ...out.messages.filter((m) => !known.has(m.uid))];
      } else st.list = out.messages || [];
      st.page = page;
      st.total = out.total || 0;
      st.more = !!out.more;
      st.listError = "";
    } catch (error) {
      if (!quiet) st.listError = error.message;
    } finally {
      if (st.box === box && st.folder === folder && st.query === query) {
        st.listLoading = false;
        renderList();
      }
    }
  }

  async function openThread(key) {
    const t = threads().find((x) => x.key === key);
    if (!t) return;
    st.openRef = { folder: st.folder, uid: t.latest.uid, key, threadId: t.threadId, uids: [...t.uids] };
    st.conv = null;
    st.convError = "";
    st.convLoading = true;
    st.summary = null;
    st.reading = true;
    const wasUnread = t.unread;
    for (const m of st.list) if ((m.threadId ? "t" + m.threadId : "u" + m.uid) === key) m.seen = true;
    applyReading();
    renderList();
    renderReader();
    if (window.innerWidth <= 900) window.scrollTo({ top: 0 });
    try {
      const conv = await api(`${boxPath()}/conversation?folder=${enc(st.folder)}&uid=${t.latest.uid}`);
      if (st.openRef?.key !== key) return;
      st.conv = conv;
      st.expanded = new Set(conv.messages.filter((m, i) => i === conv.messages.length - 1 || !m.seen).map(mkey));
      const trusted = trustedSenders();
      for (const m of conv.messages) if (m.remoteImages && trusted.has(m.from?.address)) st.images.add(mkey(m));
    } catch (error) {
      if (st.openRef?.key === key) st.convError = error.message;
    } finally {
      if (st.openRef?.key === key) {
        st.convLoading = false;
        renderReader();
      }
    }
    if (wasUnread) loadFolders();
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------
  async function act(action, keys, { folder = st.folder, target = "" } = {}) {
    const list = threads().filter((t) => keys.includes(t.key));
    let uids = list.flatMap((t) => t.uids);
    let threadIds = list.map((t) => t.threadId).filter(Boolean);
    if (st.openRef && keys.includes(st.openRef.key) && !list.length) {
      uids = st.openRef.uids;
      threadIds = st.openRef.threadId ? [st.openRef.threadId] : [];
    }
    if (action === "star") {
      // Like Gmail: the latest message of the conversation gets the star.
      uids = list.map((t) => t.latest.uid);
      threadIds = [];
    }
    if (!uids.length && !threadIds.length) return;
    const count = Math.max(keys.length, 1);
    if (action === "delete" && !confirm(`Supprimer définitivement ${count > 1 ? `ces ${count} conversations` : "cette conversation"} ? Elle ne pourra pas être récupérée.`)) return;
    try {
      await api(`${boxPath()}/action`, { folder, uids, threads: threadIds, action, target });
    } catch (error) {
      toast(error.message);
      return;
    }
    // Gmail: moving from « Tous les messages », « Envoyés »… only adds the label.
    const leaves =
      ["trash", "spam", "delete"].includes(action) ||
      (action === "archive" && folder === "inbox") ||
      (action === "move" && !["all", "sent", "flagged", "important", "drafts"].includes(folder)) ||
      (action === "inbox" && ["trash", "junk", "archive"].includes(folder)) ||
      (action === "unstar" && folder === "flagged");
    const keyOf = (m) => (m.threadId ? "t" + m.threadId : "u" + m.uid);
    const starred = new Set(list.map((t) => t.latest.uid));
    if (leaves && folder === st.folder) {
      st.list = st.list.filter((m) => !keys.includes(keyOf(m)));
      st.total = Math.max(0, st.total - list.reduce((n, t) => n + t.count, 0));
    } else
      for (const m of st.list)
        if (keys.includes(keyOf(m))) {
          if (action === "read") m.seen = true;
          if (action === "unread") m.seen = false;
          if (action === "star" && starred.has(m.uid)) m.flagged = true;
          if (action === "unstar") m.flagged = false;
        }
    for (const key of keys) st.selected.delete(key);
    if (st.openRef && keys.includes(st.openRef.key) && (leaves || action === "unread")) closeReader();
    if (DONE[action]) toast(count > 1 && !["read", "unread"].includes(action) ? `${count} conversations traitées.` : DONE[action]);
    renderList();
    renderReader();
    loadFolders();
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------
  const prefixed = (prefix, subject) => {
    const s = String(subject || "").trim();
    const re = prefix.startsWith("Re") ? /^(re|aw|réf|ré)\s*:/i : /^(fwd?|tr|wg)\s*:/i;
    return re.test(s) ? s : prefix + s;
  };

  function addressBook() {
    const state = core()?.getState?.() || {};
    const fromClients = (state.clients || []).filter((c) => !c.deletedAt && c.email).map((c) => [String(c.email).trim(), c.name]);
    const fromMail = st.list.flatMap((m) => [m.from, ...(m.to || [])]).filter((a) => a?.address && a.address !== ownAddress()).map((a) => [a.address, a.name]);
    const seen = new Set();
    return [...fromClients, ...fromMail]
      .filter(([address]) => {
        const key = address.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 400);
  }

  function findMessage(key) {
    return st.conv?.messages.find((m) => mkey(m) === key) || st.conv?.messages.at(-1) || null;
  }

  function openCompose({ mode = "new", messageKey = "", to = "", autoAi = false } = {}) {
    const box = currentBox();
    if (!box) return;
    const message = mode === "new" ? null : findMessage(messageKey);
    if (mode !== "new" && !message) return;
    const key = `${box.id}|${mode}|${message ? mkey(message) : to || "new"}`;
    const own = box.address.toLowerCase();
    let toList = to ? [to] : [];
    let cc = [];
    let subject = "";
    if (message) {
      const fromUs = message.from?.address === own;
      const target = fromUs ? message.to || [] : message.replyTo?.length ? message.replyTo : [message.from];
      if (mode === "reply") toList = target.map((a) => a?.address);
      if (mode === "replyAll") {
        toList = unique([...target, ...(fromUs ? [] : message.to || [])].map((a) => a?.address).filter((a) => a && a !== own));
        cc = unique((message.cc || []).map((a) => a.address).filter((a) => a && a !== own && !toList.includes(a)));
      }
      subject = mode === "forward" ? prefixed("Fwd: ", message.subject) : prefixed("Re: ", message.subject);
    }
    const draft = drafts.get(key);
    const initialText = "\n" + String(box.signature || "");
    const values = draft || { to: toList.join(", "), cc: cc.join(", "), bcc: "", subject, text: initialText };
    composeFiles = [];
    const title = { new: "Nouveau message", reply: "Répondre", replyAll: "Répondre à tous", forward: "Transférer" }[mode];
    const boxes = st.status.mailboxes;
    const fromField =
      mode === "new" && boxes.length > 1
        ? `<label>De<select name="box">${boxes.map((b) => `<option value="${esc(b.id)}" ${b.id === box.id ? "selected" : ""}>${esc(b.label)} · ${esc(b.address)}</option>`).join("")}</select></label>`
        : `<input type="hidden" name="box" value="${esc(box.id)}"><p class="wm-from">De : <b>${esc(box.label)}</b> · ${esc(box.address)}</p>`;
    core().modal(
      title,
      `<form id="wmComposeForm" class="wm-compose" data-mode="${mode}" data-key="${esc(key)}" data-folder="${esc(message?.folder || "")}" data-uid="${message?.uid || ""}" novalidate>
        ${draft ? '<p class="wm-note">Brouillon repris là où vous l’aviez laissé.</p>' : ""}
        ${fromField}
        <label>À<input name="to" value="${esc(values.to)}" list="wmAddressBook" autocomplete="off" inputmode="email" placeholder="adresse@exemple.ch, autre@exemple.ch"></label>
        <button type="button" class="link-button wm-cc-toggle" data-wm="show-cc" ${values.cc || values.bcc ? "hidden" : ""}>Ajouter Cc / Cci</button>
        <div class="wm-cc" ${values.cc || values.bcc ? "" : "hidden"}>
          <label>Cc<input name="cc" value="${esc(values.cc)}" list="wmAddressBook" autocomplete="off" inputmode="email"></label>
          <label>Cci<input name="bcc" value="${esc(values.bcc)}" list="wmAddressBook" autocomplete="off" inputmode="email"></label>
        </div>
        <label>Objet<input name="subject" value="${esc(values.subject)}" maxlength="250"></label>
        ${
          mode === "reply" || mode === "replyAll"
            ? `<div class="wm-ai-compose"><input name="instruction" placeholder="Consigne pour l’IA (facultatif) : accepter le rendez-vous de mardi…" aria-label="Consigne pour l’IA"><button type="button" class="btn secondary" data-wm="compose-ai">${ic("sparkle")}<span>Proposer une réponse</span></button></div>`
            : ""
        }
        <label>Message<textarea name="text" rows="12">${esc(values.text)}</textarea></label>
        ${mode !== "new" ? `<label class="wm-inline"><input type="checkbox" name="quote" checked> Inclure le message d’origine en dessous</label>` : ""}
        ${
          mode === "forward" && message.attachments?.length
            ? `<fieldset class="wm-forward-files"><legend>Pièces jointes transférées</legend>${message.attachments
                .map((a) => `<label class="wm-inline"><input type="checkbox" name="forwardPart" value="${esc(a.part)}" checked> ${esc(a.filename)} <small>(${esc(size(a.size))})</small></label>`)
                .join("")}</fieldset>`
            : ""
        }
        <div class="wm-files"><label class="btn secondary wm-file-btn">${ic("paperclip")}<span>Joindre des fichiers</span><input type="file" id="wmFiles" multiple hidden></label><ul id="wmFileList" class="wm-file-list"></ul></div>
        <p id="wmComposeError" class="error" role="alert"></p>
        <div class="form-actions"><button type="button" class="btn secondary" data-wm="compose-cancel">Annuler</button><button type="submit" class="btn primary">${ic("send")}<span>Envoyer</span></button></div>
        <datalist id="wmAddressBook">${addressBook().map(([address, name]) => `<option value="${esc(address)}">${esc(name || "")}</option>`).join("")}</datalist>
      </form>`,
    );
    const form = document.getElementById("wmComposeForm");
    const field = form?.elements[mode === "new" && !toList.length && !draft ? "to" : "text"];
    if (field) {
      field.focus();
      if (field.name === "text") field.setSelectionRange(0, 0);
    }
    if (autoAi) composeAi(form);
  }

  function saveDraft(form) {
    if (!form) return;
    const text = form.elements.text.value;
    drafts.set(form.dataset.key, { to: form.elements.to.value, cc: form.elements.cc.value, bcc: form.elements.bcc.value, subject: form.elements.subject.value, text });
  }

  function renderFiles() {
    const list = document.getElementById("wmFileList");
    if (!list) return;
    list.innerHTML = composeFiles
      .map((f, i) => `<li>${ic("paperclip")}<span>${esc(f.name)}</span><small>${esc(size(f.size))}</small><button type="button" class="wm-icon-btn" data-wm="file-remove" data-index="${i}" aria-label="Retirer ${esc(f.name)}" title="Retirer">${ic("x")}</button></li>`)
      .join("");
  }

  const fileData = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = () => reject(new Error(`Impossible de lire ${file.name}.`));
      reader.readAsDataURL(file);
    });

  async function sendCompose(form) {
    const error = document.getElementById("wmComposeError");
    const button = form.querySelector("[type=submit]");
    error.textContent = "";
    if (!form.elements.to.value.trim()) {
      error.textContent = "Indiquez au moins un destinataire.";
      return form.elements.to.focus();
    }
    const total = composeFiles.reduce((n, f) => n + f.size, 0);
    if (total > MAX_UPLOAD) {
      error.textContent = "Pièces jointes : 18 Mo au maximum au total (limite de Gmail).";
      return;
    }
    button.disabled = true;
    button.querySelector("span").textContent = "Envoi…";
    try {
      const uploads = [];
      for (const f of composeFiles) uploads.push({ name: f.name, type: f.type, data: await fileData(f) });
      const mode = form.dataset.mode;
      const boxId = form.elements.box.value;
      await api(`${enc(boxId)}/send`, {
        to: form.elements.to.value,
        cc: form.elements.cc.value,
        bcc: form.elements.bcc.value,
        subject: form.elements.subject.value,
        text: form.elements.text.value,
        mode,
        ref: mode === "new" ? null : { folder: form.dataset.folder, uid: Number(form.dataset.uid) },
        quote: form.elements.quote ? form.elements.quote.checked : true,
        forwardParts: [...form.querySelectorAll("input[name=forwardPart]:checked")].map((x) => x.value),
        uploads,
      });
      drafts.delete(form.dataset.key);
      composeFiles = [];
      core().closeModal(true);
      toast("E-mail envoyé.");
      if (st.folder === "sent" && boxId === st.box) loadList({ quiet: true });
    } catch (err) {
      error.textContent = err.message;
      button.disabled = false;
      button.querySelector("span").textContent = "Envoyer";
    }
  }

  async function composeAi(form) {
    if (!form) return;
    const button = form.querySelector('[data-wm="compose-ai"]');
    const error = document.getElementById("wmComposeError");
    const textarea = form.elements.text;
    const signatureStart = textarea.value.indexOf("\n--\n");
    const written = (signatureStart >= 0 ? textarea.value.slice(0, signatureStart) : textarea.value).trim();
    if (written && !confirm("Remplacer le texte déjà écrit par la proposition de l’assistant ?")) return;
    if (button) {
      button.disabled = true;
      button.querySelector("span").textContent = "Rédaction…";
    }
    error.textContent = "";
    try {
      const out = await api(`${boxPath()}/ai`, { folder: form.dataset.folder, uid: Number(form.dataset.uid), mode: "reply", instruction: form.elements.instruction?.value || "" });
      const signature = signatureStart >= 0 ? textarea.value.slice(signatureStart) : "";
      textarea.value = String(out.text || "").trim() + "\n" + signature;
      textarea.focus();
      textarea.setSelectionRange(0, 0);
      saveDraft(form);
    } catch (err) {
      error.textContent = err.message;
    } finally {
      if (button?.isConnected) {
        button.disabled = false;
        button.querySelector("span").textContent = "Proposer une réponse";
      }
    }
  }

  async function summarize() {
    if (!st.conv || !st.openRef) return;
    const key = st.openRef.key;
    st.summary = { loading: true };
    document.getElementById("wmSummary").innerHTML = summaryBlock();
    try {
      const out = await api(`${boxPath()}/ai`, { folder: st.openRef.folder, uid: st.openRef.uid, mode: "summary" });
      if (st.openRef?.key !== key) return;
      st.summary = { text: out.text };
    } catch (error) {
      if (st.openRef?.key !== key) return;
      st.summary = { error: error.message };
    }
    const el = document.getElementById("wmSummary");
    if (el) el.innerHTML = summaryBlock();
  }

  // -------------------------------------------------------------------------
  // Client created from a sender
  // -------------------------------------------------------------------------
  function createClient() {
    const own = ownAddress();
    const lastIn = [...(st.conv?.messages || [])].reverse().find((m) => m.from?.address && m.from.address !== own);
    if (!lastIn) return;
    const opener = document.createElement("button");
    opener.type = "button";
    opener.hidden = true;
    opener.dataset.action = "new";
    opener.dataset.id = "clients";
    document.body.append(opener);
    opener.click();
    opener.remove();
    const box = currentBox();
    let tries = 0;
    const fill = () => {
      const email = document.getElementById("f_email");
      if (!email) return ++tries < 20 && setTimeout(fill, 50);
      email.value = lastIn.from.address;
      const name = document.getElementById("f_name");
      if (name && !name.value) name.value = lastIn.from.name || "";
      const company = document.getElementById("f_company");
      const mine = box?.companies?.find((id) => [...(company?.options || [])].some((o) => o.value === id));
      if (company && mine && box.id !== "default") company.value = mine;
    };
    fill();
  }

  // -------------------------------------------------------------------------
  // Access (administrators of the group)
  // -------------------------------------------------------------------------
  async function openAccess() {
    let data;
    try {
      data = await api("access");
    } catch (error) {
      return toast(error.message);
    }
    const rows = data.users
      .map((u) => {
        const boxes = data.mailboxes
          .map((b) => {
            const auto = u.automatic.includes(b.id);
            const checked = auto || u.granted.includes(b.id);
            return `<label class="wm-access-box${auto ? " auto" : ""}" title="${auto ? "Accès automatique (administrateur)" : esc(b.address)}"><input type="checkbox" data-wm-access="${esc(u.id)}" value="${esc(b.id)}" ${checked ? "checked" : ""} ${auto ? "disabled" : ""}> ${esc(b.label)}</label>`;
          })
          .join("");
        return `<div class="wm-access-user"><div><b>${esc(u.name)}</b><small>${esc(ROLE_NAMES[u.role] || u.role)} · ${esc(u.company || "")}</small></div><div class="wm-access-boxes">${boxes}</div></div>`;
      })
      .join("");
    core().modal(
      "Accès aux boîtes mail",
      `<div class="wm-access"><p>Les administrateurs du groupe voient toutes les boîtes. Cochez pour chaque personne les boîtes mail qu’elle peut ouvrir : elle pourra lire, envoyer et supprimer des e-mails de ces boîtes. Chaque changement est enregistré tout de suite.</p>${
        rows || '<p class="muted">Aucun autre compte.</p>'
      }<div class="form-actions"><button type="button" class="btn primary" data-action="close-modal">Terminé</button></div></div>`,
    );
  }

  async function saveAccess(input) {
    const userId = input.dataset.wmAccess;
    const boxes = [...document.querySelectorAll(`input[data-wm-access="${cssq(userId)}"]:checked:not(:disabled)`)].map((x) => x.value);
    try {
      await api("access", { userId: Number(userId), mailboxes: boxes });
      toast("Accès enregistré.");
    } catch (error) {
      input.checked = !input.checked;
      toast(error.message);
    }
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------
  document.addEventListener("click", async (event) => {
    const el = event.target.closest("[data-wm]");
    if (!el) return;
    const what = el.dataset.wm;
    if (what === "box") return el.dataset.id !== st.box && selectBox(el.dataset.id);
    if (what === "folder") return selectFolder(el.dataset.id);
    if (what === "refresh") {
      loadFolders(true);
      return loadList();
    }
    if (what === "more") return loadList({ append: true });
    if (what === "open") return openThread(el.dataset.key);
    if (what === "star") {
      const t = threads().find((x) => x.key === el.dataset.key);
      return t && act(t.flagged ? "unstar" : "star", [t.key]);
    }
    if (what === "bulk") return act(el.dataset.act, [...st.selected]);
    if (what === "conv") return st.openRef && act(el.dataset.act, [st.openRef.key], { folder: st.openRef.folder });
    if (what === "back") {
      closeReader();
      renderList();
      return renderReader();
    }
    if (what === "expand") {
      st.expanded.add(el.dataset.mkey);
      return renderMessage(el.dataset.mkey);
    }
    if (what === "collapse") {
      st.expanded.delete(el.dataset.mkey);
      return renderMessage(el.dataset.mkey);
    }
    if (what === "images" || what === "images-always") {
      const m = findMessage(el.dataset.mkey);
      if (what === "images-always" && m?.from?.address) trustSender(m.from.address);
      st.images.add(el.dataset.mkey);
      return renderMessage(el.dataset.mkey);
    }
    if (what === "compose") return openCompose({ mode: "new" });
    if (["reply", "replyAll", "forward"].includes(what)) return openCompose({ mode: what, messageKey: el.dataset.mkey || "" });
    if (what === "ai-reply") return openCompose({ mode: "reply", autoAi: true });
    if (what === "summary") return summarize();
    if (what === "summary-close") {
      st.summary = null;
      document.getElementById("wmSummary").innerHTML = "";
      return;
    }
    if (what === "create-client") return createClient();
    if (what === "access") return openAccess();
    if (what === "show-cc") {
      el.hidden = true;
      el.parentElement.querySelector(".wm-cc").hidden = false;
      return el.parentElement.querySelector("input[name=cc]")?.focus();
    }
    if (what === "compose-ai") return composeAi(el.closest("form"));
    if (what === "file-remove") {
      composeFiles.splice(Number(el.dataset.index), 1);
      return renderFiles();
    }
    if (what === "compose-cancel") {
      const form = el.closest("form");
      const text = form.elements.text.value;
      const empty = !text.replace(String(currentBox()?.signature || ""), "").trim() && !form.elements.subject.value.trim();
      if (!empty && !confirm("Abandonner ce message ? Le texte écrit sera perdu.")) return;
      drafts.delete(form.dataset.key);
      composeFiles = [];
      return core().closeModal(true);
    }
  });

  function selectFolder(id) {
    if (!id) return;
    st.folder = id;
    st.query = "";
    st.selected.clear();
    closeReader();
    renderTop();
    renderFolders();
    renderReader();
    loadList();
  }

  document.addEventListener("change", (event) => {
    const t = event.target;
    if (t.id === "wmFolderSelect") return selectFolder(t.value);
    if (t.id === "wmSelectAll") {
      st.selected = new Set(t.checked ? threads().map((x) => x.key) : []);
      return renderList();
    }
    if (t.dataset?.wmSelect) {
      if (t.checked) st.selected.add(t.dataset.wmSelect);
      else st.selected.delete(t.dataset.wmSelect);
      return renderList();
    }
    if (t.matches?.("[data-wm-move]") && t.value) return act("move", [...st.selected], { target: t.value });
    if (t.matches?.("[data-wm-move-conv]") && t.value && st.openRef) return act("move", [st.openRef.key], { folder: st.openRef.folder, target: t.value });
    if (t.dataset?.wmAccess) return saveAccess(t);
    if (t.id === "wmFiles") {
      composeFiles.push(...t.files);
      t.value = "";
      const total = composeFiles.reduce((n, f) => n + f.size, 0);
      const error = document.getElementById("wmComposeError");
      if (error) error.textContent = total > MAX_UPLOAD ? "Pièces jointes : 18 Mo au maximum au total (limite de Gmail)." : "";
      renderFiles();
    }
  });

  document.addEventListener("input", (event) => {
    const form = event.target.closest?.("#wmComposeForm");
    if (form) saveDraft(form);
  });

  document.addEventListener("search", (event) => {
    // The cross of the search field: back to the folder.
    if (event.target.closest?.("#wmSearch") && !event.target.value && st.query) {
      st.query = "";
      loadList();
    }
  });

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (form.id === "wmSearch") {
      event.preventDefault();
      st.query = form.elements.q.value.trim();
      st.selected.clear();
      closeReader();
      renderReader();
      return loadList();
    }
    if (form.id === "wmComposeForm") {
      event.preventDefault();
      sendCompose(form);
    }
  });

  window.addEventListener("resize", () => {
    if (core()?.getPage?.() === "mailbox") fitHeight();
  });

  // -------------------------------------------------------------------------
  // Refresh: unread counts every minute, and the open folder when nobody is busy in it
  // -------------------------------------------------------------------------
  async function tick() {
    if (!core()?.getProfile?.() || document.visibilityState !== "visible") return;
    await loadStatus(true);
    const onPage = core().getPage?.() === "mailbox" && st.root?.isConnected && hasAccess();
    if (onPage && !document.getElementById("wmComposeForm") && !st.selected.size && st.page === 0 && !st.listLoading && !st.query) {
      loadList({ quiet: true });
      loadFolders();
    }
  }
  function ensurePolling() {
    if (timer) return;
    timer = setInterval(tick, 60000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") tick();
    });
  }

  function afterRender() {
    const me = core()?.getProfile?.();
    if (!me) return;
    ensurePolling();
    loadStatus().then(updateNavBadge);
    // Notification « Nouvel e-mail »: /?open=mailbox&box=…
    const params = new URLSearchParams(location.search);
    if (params.get("open") === "mailbox" && handledUrl !== location.search) {
      handledUrl = location.search;
      const box = params.get("box");
      history.replaceState(null, "", "/");
      if (box && box !== st.box) selectBox(box, false);
      core().setPage?.("mailbox");
    }
  }

  // Opens a given mailbox the next time the page is shown (link of a notification).
  function prepare({ box = "" } = {}) {
    if (box && box !== st.box) selectBox(String(box), false);
  }

  window.SGOWebmail = { render, afterRender, hasAccess, unreadTotal, loadStatus, openCompose, prepare, _state: st };
  // The application may have shown its first page before this file was loaded: catch up.
  if (core()?.getProfile?.()) {
    afterRender();
    if (core().getPage?.() === "mailbox") render(document.getElementById("webmailRoot"));
  }
})();
