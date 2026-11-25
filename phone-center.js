// « Téléphone » page and the telephone that follows the person on every page: calls of their own
// line in the browser (computer or phone), the history with the assistant's summaries and what
// it proposes to do (quote, invoice, task, appointment, new client, call back), the voicemail,
// the SMS of their Android phone, and the administrators' settings (operator, relay, lines,
// recording announcement).
(() => {
  "use strict";
  const core = () => window.SGOChatCore;
  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  const ic = (name) => window.SGOIcon?.(name) || "";
  const enc = encodeURIComponent;
  const toast = (message) => core()?.toast?.(message);
  async function call(method, path, body) {
    const res = await fetch("/api/phone/" + path, {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.error || "Réponse serveur invalide.");
      error.status = res.status;
      throw error;
    }
    return data;
  }
  const get = (path) => call("GET", path);
  const post = (path, body = {}) => call("POST", path, body);

  const STATUS = {
    completed: "Appel",
    answered: "En cours",
    ringing: "Sonne",
    missed: "Manqué",
    voicemail: "Message vocal",
    busy: "Occupé",
    "no-answer": "Pas de réponse",
    failed: "Échec",
    cancelled: "Annulé",
  };
  const ACTION_TITLES = {
    "quote.prepare": "Préparer un devis",
    "invoice.prepare": "Préparer une facture",
    "task.create": "Nouvelle tâche",
    "planning.create": "Rendez-vous au planning",
    "client.create": "Nouveau client",
    callback: "Rappeler",
  };
  const FILTERS = [
    ["all", "Tous"],
    ["missed", "Manqués"],
    ["voicemail", "Messages vocaux"],
    ["callbacks", "À rappeler"],
  ];

  const st = {
    user: "",
    me: null,
    meAt: 0,
    meLoading: null,
    tab: "calls",
    filter: "all",
    calls: [],
    more: false,
    callsLoading: false,
    callsError: "",
    selected: null,
    detailLoading: false,
    dial: "",
    threads: [],
    thread: null,
    team: [],
    panel: "keypad", // keypad | call | sms | sms-setup
    reading: false,
  };
  const phone = {
    ua: null,
    key: "",
    registered: false,
    error: "",
    session: null,
    direction: "",
    peer: null,
    state: "", // incoming | calling | talking
    muted: false,
    startedAt: 0,
    audio: null,
    tone: null,
    timer: null,
    dtmf: false,
  };
  let pollTimer = null;
  let handledUrl = "";

  const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const swissDate = (iso) => (iso ? String(iso).slice(0, 10).split("-").reverse().join(".") : "");
  function when(at) {
    if (!at) return "";
    const d = new Date(at);
    const sameDay = d.toDateString() === new Date().toDateString();
    const time = d.toLocaleTimeString("fr-CH", { hour: "2-digit", minute: "2-digit" });
    if (sameDay) return time;
    const yesterday = new Date(Date.now() - 86400000).toDateString() === d.toDateString();
    return (yesterday ? "Hier" : d.toLocaleDateString("fr-CH", { day: "2-digit", month: "2-digit" })) + " " + time;
  }
  const duration = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
  const digits = (v) => String(v || "").replace(/[^\d+*#]/g, "");
  const phoneKey = (v) => String(v || "").replace(/\D/g, "").slice(-9);
  function display(number) {
    const d = String(number || "");
    const m = d.match(/^\+41(\d{2})(\d{3})(\d{2})(\d{2})$/);
    return m ? `+41 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : d || "Numéro masqué";
  }
  function clientOf(number) {
    const key = phoneKey(number);
    if (key.length < 6) return null;
    return (core()?.getState?.()?.clients || []).find((c) => phoneKey(c.phone) === key || phoneKey(c.mobile) === key) || null;
  }
  const nameOf = (number, fallback = "") => clientOf(number)?.name || fallback || display(number);

  // -------------------------------------------------------------------------
  // Line and telephone
  // -------------------------------------------------------------------------
  // In the menu for people with a line, and for the administrators who set the lines.
  function hasAccess() {
    return !!st.me?.access && !!(st.me.line || st.me.canManage);
  }
  function unreadTotal() {
    return Number(st.me?.unseen?.calls || 0) + Number(st.me?.unseen?.sms || 0);
  }
  async function loadMe(force = false) {
    const profile = core()?.getProfile?.();
    if (!profile) return null;
    if (st.user !== String(profile.id)) {
      st.user = String(profile.id);
      st.me = null;
      st.meAt = 0;
    }
    if (!force && st.me && Date.now() - st.meAt < 60000) return st.me;
    if (st.meLoading) return st.meLoading;
    st.meLoading = get("me")
      .then((me) => {
        const before = unreadTotal();
        const hadAccess = hasAccess();
        st.me = me;
        st.meAt = Date.now();
        // The menu shows « Téléphone » once the line is known.
        if (hadAccess !== hasAccess()) core()?.render?.();
        else if (before !== unreadTotal()) updateNavBadge();
        ensurePhone().catch(() => {});
        return me;
      })
      .catch(() => st.me)
      .finally(() => (st.meLoading = null));
    return st.meLoading;
  }
  function updateNavBadge() {
    const item = document.querySelector('.nav-item[data-page="phone"]');
    if (!item) return;
    const n = unreadTotal();
    let badge = item.querySelector(".nav-unread");
    if (!n) return badge?.remove();
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "nav-unread";
      item.append(badge);
    }
    badge.textContent = n > 99 ? "99+" : String(n);
  }

  function loadLibrary() {
    if (window.JsSIP) return Promise.resolve();
    if (loadLibrary.promise) return loadLibrary.promise;
    loadLibrary.promise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "/vendor/jssip.min.js";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        loadLibrary.promise = null;
        reject(new Error("Téléphone indisponible."));
      };
      document.head.append(s);
    });
    return loadLibrary.promise;
  }

  async function ensurePhone() {
    const conn = st.me?.connection;
    if (!conn) return stopPhone();
    const key = conn.username + "|" + conn.password;
    // The pass to the exchange is renewed when the connection drops (it is valid 12 hours).
    phone.path = conn.path;
    phone.ice = conn.iceServers || [];
    if (phone.ua && phone.key === key) return;
    if (phone.session) return; // never during a call
    await loadLibrary();
    stopPhone();
    phone.key = key;
    const url = () => (location.protocol === "https:" ? "wss://" : "ws://") + location.host + phone.path;
    const socket = new window.JsSIP.WebSocketInterface(url());
    const ua = new window.JsSIP.UA({
      sockets: [socket],
      uri: `sip:${conn.username}@sgo.invalid`,
      password: conn.password,
      register: true,
      register_expires: 300,
      session_timers: false,
      user_agent: "Sousa Group One",
      connection_recovery_min_interval: 2,
      connection_recovery_max_interval: 30,
    });
    phone.ua = ua;
    ua.on("registered", () => {
      phone.registered = true;
      phone.error = "";
      renderState();
    });
    ua.on("unregistered", () => {
      phone.registered = false;
      renderState();
    });
    ua.on("registrationFailed", () => {
      phone.registered = false;
      phone.error = "La ligne n’a pas pu se connecter au central.";
      renderState();
    });
    ua.on("disconnected", () => {
      phone.registered = false;
      renderState();
      // A renewed pass is needed after 12 hours: the telephone is rebuilt when idle.
      if (!phone.session && socket.url !== url())
        setTimeout(() => {
          if (phone.ua === ua && !phone.session) {
            phone.key = "";
            ensurePhone().catch(() => {});
          }
        }, 1000);
    });
    ua.on("newRTCSession", ({ session, originator }) => onSession(session, originator));
    ua.start();
  }
  function stopPhone() {
    if (!phone.ua) return;
    try {
      phone.ua.stop();
    } catch {
      // already stopped
    }
    phone.ua = null;
    phone.key = "";
    phone.registered = false;
  }

  // Sounds: ringing (incoming) and ringback (outgoing), made in the browser.
  let audioCtx = null;
  function tone(kind) {
    stopTone();
    try {
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      audioCtx.resume?.();
    } catch {
      return;
    }
    const play = () => {
      const now = audioCtx.currentTime;
      const gain = audioCtx.createGain();
      gain.connect(audioCtx.destination);
      const freqs = kind === "ring" ? [523, 659] : [425];
      const length = kind === "ring" ? 0.9 : 1;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(kind === "ring" ? 0.18 : 0.08, now + 0.03);
      gain.gain.setValueAtTime(kind === "ring" ? 0.18 : 0.08, now + length - 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + length);
      for (const [i, f] of freqs.entries()) {
        const o = audioCtx.createOscillator();
        o.frequency.value = f;
        o.connect(gain);
        o.start(now + (kind === "ring" ? i * 0.15 : 0));
        o.stop(now + length);
      }
    };
    play();
    phone.tone = setInterval(play, kind === "ring" ? 2000 : 5000);
    if (kind === "ring" && navigator.vibrate) navigator.vibrate([400, 200, 400]);
  }
  function stopTone() {
    clearInterval(phone.tone);
    phone.tone = null;
  }

  function attachAudio(session) {
    if (!phone.audio) {
      phone.audio = document.createElement("audio");
      phone.audio.autoplay = true;
      phone.audio.className = "ph-remote";
      document.body.append(phone.audio);
    }
    const pc = session.connection;
    if (!pc) return;
    const show = () => {
      const stream = new MediaStream();
      pc.getReceivers().forEach((r) => r.track && stream.addTrack(r.track));
      phone.audio.srcObject = stream;
      phone.audio.play?.().catch(() => {});
    };
    pc.addEventListener("track", show);
    show();
  }

  function onSession(session, originator) {
    const busy = phone.session || core()?.hasDirectCall?.();
    if (originator === "remote" && busy) {
      session.terminate({ status_code: 486, reason_phrase: "Busy Here" });
      return;
    }
    phone.session = session;
    phone.direction = originator === "remote" ? "in" : "out";
    phone.muted = false;
    phone.dtmf = false;
    const number = originator === "remote" ? session.remote_identity?.uri?.user || "" : phone.dialed || "";
    phone.peer = { number, name: originator === "remote" ? nameOf(number, session.remote_identity?.display_name) : nameOf(number) };
    phone.state = originator === "remote" ? "incoming" : "calling";
    if (phone.state === "incoming") tone("ring");
    session.on("peerconnection", () => attachAudio(session));
    // The call starts without waiting for every network path (relay) to be known.
    let readyTimer = null;
    session.on("icecandidate", (e) => {
      if (!readyTimer) readyTimer = setTimeout(() => e.ready(), 1500);
    });
    session.on("progress", () => {
      if (phone.direction === "out") tone("ringback");
    });
    session.on("accepted", () => {
      stopTone();
      phone.state = "talking";
      phone.startedAt = Date.now();
      attachAudio(session);
      renderCallBox();
    });
    const end = (e) => {
      stopTone();
      clearTimeout(readyTimer);
      if (phone.session !== session) return;
      const reason = e?.cause;
      if (phone.direction === "out" && phone.state === "calling") {
        const text = { Busy: "Le correspondant est occupé.", Rejected: "Appel refusé.", "Unavailable": "Correspondant injoignable.", "Not Found": "Numéro introuvable.", "No Answer": "Pas de réponse.", "User Denied Media Access": "Le micro est bloqué : autorisez-le dans le navigateur." }[reason];
        if (text) toast(text);
        else if (reason && reason !== "Canceled" && reason !== "Terminated") toast("L’appel n’a pas abouti (" + reason + ").");
      } else if (reason === "User Denied Media Access") toast("Le micro est bloqué : autorisez-le dans le navigateur.");
      phone.session = null;
      phone.state = "";
      phone.peer = null;
      clearInterval(phone.timer);
      renderCallBox();
      // The history (and soon the summary) shows the call that just ended.
      setTimeout(() => refreshAfterCall(), 2500);
      setTimeout(() => refreshAfterCall(), 12000);
    };
    session.on("ended", end);
    session.on("failed", end);
    renderCallBox();
  }
  function refreshAfterCall() {
    loadMe(true);
    if (core()?.getPage?.() === "phone" && st.tab === "calls") loadCalls(true);
  }

  function dialOut(raw) {
    const number = digits(raw);
    if (!number || number.replace(/\D/g, "").length < 3) return toast("Entrez un numéro.");
    if (!phone.ua || !phone.registered) return toast(st.me?.line ? "La ligne n’est pas encore connectée au central." : "Aucune ligne n’est attribuée à votre compte.");
    if (phone.session || core()?.hasDirectCall?.()) return toast("Un appel est déjà en cours.");
    phone.dialed = number;
    try {
      phone.ua.call(`sip:${number}@sgo.invalid`, { mediaConstraints: { audio: true, video: false }, pcConfig: { iceServers: phone.ice || [] } });
    } catch (error) {
      toast(error.message || "Appel impossible.");
    }
  }
  function answer() {
    if (!phone.session || phone.state !== "incoming") return;
    stopTone();
    phone.session.answer({ mediaConstraints: { audio: true, video: false }, pcConfig: { iceServers: phone.ice || [] } });
  }
  function hangup() {
    if (!phone.session) return;
    // Declined here: the call goes to voicemail and the person's other devices stop ringing.
    if (phone.state === "incoming") post("decline").catch(() => {});
    try {
      if (phone.state === "incoming") phone.session.terminate({ status_code: 486, reason_phrase: "Busy Here" });
      else phone.session.terminate();
    } catch {
      // already over
    }
  }

  // The call box, on every page.
  function renderCallBox() {
    let box = document.getElementById("phCallBox");
    if (!phone.session) {
      box?.remove();
      return;
    }
    if (!box) {
      box = document.createElement("section");
      box.id = "phCallBox";
      box.className = "ph-callbox";
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-live", "assertive");
      document.body.append(box);
    }
    const p = phone.peer || {};
    const client = clientOf(p.number);
    const label = phone.state === "incoming" ? "Appel entrant" : phone.state === "calling" ? "Appel en cours…" : "En communication";
    const keys = "123456789*0#".split("");
    box.dataset.state = phone.state;
    box.innerHTML = `
      <div class="ph-callbox-head">
        <span class="ph-avatar">${ic("phone")}</span>
        <div class="ph-callbox-text">
          <small>${esc(label)}</small>
          <b>${esc(p.name || display(p.number))}</b>
          <span>${esc(p.name && p.name !== display(p.number) ? display(p.number) : client?.city || "")}</span>
        </div>
        ${phone.state === "talking" ? `<time id="phTimer">${duration(Math.round((Date.now() - phone.startedAt) / 1000))}</time>` : ""}
      </div>
      ${phone.dtmf ? `<div class="ph-dtmf">${keys.map((k) => `<button type="button" class="ph-key" data-ph="dtmf" data-key="${k}">${k}</button>`).join("")}</div>` : ""}
      <div class="ph-callbox-actions">
        ${
          phone.state === "incoming"
            ? `<button type="button" class="ph-round ph-red" data-ph="hangup" aria-label="Refuser" title="Refuser (messagerie)">${ic("hangup")}</button><button type="button" class="ph-round ph-green" data-ph="answer" aria-label="Répondre" title="Répondre">${ic("phone")}</button>`
            : `${phone.state === "talking" ? `<button type="button" class="ph-round${phone.muted ? " on" : ""}" data-ph="mute" aria-pressed="${phone.muted}" aria-label="${phone.muted ? "Réactiver le micro" : "Couper le micro"}" title="${phone.muted ? "Réactiver le micro" : "Couper le micro"}">${ic(phone.muted ? "mic-off" : "mic")}</button><button type="button" class="ph-round${phone.dtmf ? " on" : ""}" data-ph="dtmf-toggle" aria-label="Clavier" title="Clavier">${ic("list")}</button>` : ""}<button type="button" class="ph-round ph-red" data-ph="hangup" aria-label="Raccrocher" title="Raccrocher">${ic("hangup")}</button>`
        }
      </div>`;
    clearInterval(phone.timer);
    if (phone.state === "talking")
      phone.timer = setInterval(() => {
        const t = document.getElementById("phTimer");
        if (t) t.textContent = duration(Math.round((Date.now() - phone.startedAt) / 1000));
      }, 1000);
  }

  // -------------------------------------------------------------------------
  // Page
  // -------------------------------------------------------------------------
  function render(root) {
    if (!root) return;
    const profile = core()?.getProfile?.();
    if (profile && st.user !== String(profile.id)) {
      st.user = String(profile.id);
      st.me = null;
    }
    if (!st.me) {
      root.innerHTML = `<div class="ph"><p class="muted">Chargement du téléphone…</p></div>`;
      loadMe(true).then(() => core()?.getPage?.() === "phone" && render(document.getElementById("phoneRoot")));
      return;
    }
    const me = st.me;
    if (!me.access) {
      root.innerHTML = `<div class="ph"><div class="ph-empty">${ic("lock")}<p>Le téléphone n’est pas disponible pour votre compte.</p></div></div>`;
      return;
    }
    root.innerHTML = `
      <div class="ph${st.reading ? " ph-reading" : ""}" id="phApp">
        <div class="ph-top">
          <div class="ph-title">
            <b>${me.line ? "Ma ligne " + esc(me.line.didDisplay || "") : "Téléphone"}</b>
            <span id="phState"></span>
          </div>
          <div class="ph-top-actions">
            ${me.line ? `<button type="button" class="btn primary" data-ph="keypad">${ic("phone")}<span>Composer</span></button>` : ""}
            ${me.line ? `<button type="button" class="btn secondary" data-ph="greeting">${ic("mic")}<span>Mon répondeur</span></button>` : ""}
            ${me.canManage ? `<button type="button" class="btn secondary" data-ph="admin">${ic("settings")}<span>Réglages</span></button>` : ""}
          </div>
        </div>
        ${me.line ? "" : noLine(me)}
        ${me.line && me.canManage && !me.recording?.announcement ? `<p class="ph-note">${ic("alert")}<span>Les appels ne sont pas enregistrés ni résumés tant que l’annonce « cet appel est enregistré » n’est pas enregistrée (Réglages).</span></p>` : ""}
        <div class="ph-main">
          <section class="card ph-list">
            <div class="ph-tabs" role="tablist">
              ${[["calls", "Appels", Number(me.unseen?.calls || 0)], ["sms", "SMS", Number(me.unseen?.sms || 0)], ...(me.canManage ? [["team", "Équipe", 0]] : [])]
                .map(([id, label, n]) => `<button type="button" class="ph-tab${st.tab === id ? " active" : ""}" role="tab" aria-selected="${st.tab === id}" data-ph="tab" data-id="${id}">${esc(label)}${n ? ` <small>${n}</small>` : ""}</button>`)
                .join("")}
            </div>
            <div id="phList"></div>
          </section>
          <section class="card ph-panel" id="phPanel"></section>
        </div>
      </div>`;
    renderState();
    renderList();
    renderPanel();
    if (st.tab === "calls" && !st.calls.length && !st.callsLoading) loadCalls(true);
    if (st.tab === "sms" && !st.threads.length) loadThreads();
    if (st.tab === "team" && !st.team.length) loadTeam();
  }
  function noLine(me) {
    return `<div class="ph-empty">${ic("phone")}<p>Aucune ligne n’est attribuée à votre compte.</p><small>${me.canManage ? "Ajoutez votre ligne dans Réglages : numéro de l’opérateur et votre numéro de mobile." : "Demandez-la à un administrateur du groupe."}</small></div>`;
  }
  function renderState() {
    const el = document.getElementById("phState");
    if (!el) return;
    const s = st.me?.status || {};
    let cls = "off";
    let text = "Hors ligne";
    if (!st.me?.line) {
      el.innerHTML = "";
      return;
    }
    if (!s.connected) text = "Central téléphonique injoignable";
    else if (phone.registered) {
      cls = "on";
      text = "Prête à recevoir vos appels";
    } else if (phone.error) text = phone.error;
    else text = "Connexion…";
    el.className = "ph-state " + cls;
    el.innerHTML = `${ic(cls === "on" ? "check" : "alert")}<span>${esc(text)}</span>`;
  }

  async function loadCalls(reset = false) {
    st.callsLoading = true;
    if (reset) st.callsError = "";
    try {
      const out = await get(`calls?filter=${enc(st.filter)}&offset=${reset ? 0 : st.calls.length}`);
      st.calls = reset ? out.calls : [...st.calls, ...out.calls];
      st.more = out.more;
      if (st.selected) {
        const fresh = st.calls.find((c) => c.id === st.selected.id);
        if (fresh && (fresh.aiStatus !== st.selected.aiStatus || fresh.summary !== st.selected.summary)) openCall(fresh.id, { quiet: true });
      }
      if (reset && st.calls.some((c) => !c.seen)) post("calls/seen").then(() => loadMe(true)).catch(() => {});
    } catch (error) {
      st.callsError = error.message;
    } finally {
      st.callsLoading = false;
      if (core()?.getPage?.() === "phone") renderList();
    }
  }
  async function loadThreads() {
    try {
      st.threads = (await get("sms")).threads;
    } catch (error) {
      st.callsError = error.message;
    }
    if (core()?.getPage?.() === "phone") renderList();
  }
  async function loadTeam() {
    try {
      st.team = (await get("team")).calls;
    } catch (error) {
      st.callsError = error.message;
    }
    if (core()?.getPage?.() === "phone") renderList();
  }

  function callIcon(c) {
    if (c.status === "voicemail") return ic("mic");
    if (c.status === "missed") return ic("phone");
    return ic(c.direction === "in" ? "phone" : "send");
  }
  function callRowHtml(c, team = false) {
    const who = nameOf(c.number, c.caller?.name);
    const missed = ["missed", "voicemail"].includes(c.status);
    const label = c.direction === "out" ? (c.status === "completed" ? "Appel passé" : STATUS[c.status]) : c.status === "completed" ? "Appel reçu" : STATUS[c.status];
    return `<button type="button" class="ph-row${missed ? " missed" : ""}${st.selected?.id === c.id ? " active" : ""}${!c.seen && missed ? " unread" : ""}" data-ph="open-call" data-id="${c.id}">
      <span class="ph-row-icon ${c.direction}${missed ? " missed" : ""}">${callIcon(c)}</span>
      <span class="ph-row-main">
        <span class="ph-row-top"><b>${esc(who)}</b><time>${esc(when(c.startedAt))}</time></span>
        <span class="ph-row-bottom"><span>${esc([team ? c.userName : "", label, c.seconds ? duration(c.seconds) : ""].filter(Boolean).join(" · "))}</span>${c.aiStatus === "done" ? `<span class="ph-chip">${ic("sparkle")}Résumé</span>` : c.aiStatus === "pending" || c.aiStatus === "running" || c.aiStatus === "waiting" ? `<span class="ph-chip muted">Résumé…</span>` : ""}${c.actions?.some((a) => a.status === "pending") ? `<span class="ph-chip warn">${c.actions.filter((a) => a.status === "pending").length} à faire</span>` : ""}</span>
        ${c.summary ? `<span class="ph-row-summary">${esc(c.summary.split("\n")[0].replace(/^- /, ""))}</span>` : ""}
      </span>
    </button>`;
  }
  function renderList() {
    const el = document.getElementById("phList");
    if (!el) return;
    if (st.tab === "calls") {
      el.innerHTML = `
        <div class="ph-filters">${FILTERS.map(([id, label]) => `<button type="button" class="ph-filter${st.filter === id ? " active" : ""}" data-ph="filter" data-id="${id}">${esc(label)}</button>`).join("")}</div>
        <div class="ph-rows">
          ${st.callsError ? `<p class="ph-error">${esc(st.callsError)}</p>` : ""}
          ${st.calls.map((c) => callRowHtml(c)).join("") || (st.callsLoading ? '<p class="muted ph-none">Chargement…</p>' : `<p class="muted ph-none">${st.filter === "all" ? "Aucun appel pour l’instant." : "Rien ici."}</p>`)}
          ${st.more ? '<button type="button" class="btn secondary ph-more" data-ph="more">Plus anciens</button>' : ""}
        </div>`;
      return;
    }
    if (st.tab === "team") {
      el.innerHTML = `<p class="ph-hint">Résumés des appels de toute l’équipe (sans les enregistrements ni les SMS).</p><div class="ph-rows">${st.team.map((c) => callRowHtml(c, true)).join("") || '<p class="muted ph-none">Aucun résumé pour l’instant.</p>'}</div>`;
      return;
    }
    const sms = st.me?.line?.sms || {};
    el.innerHTML = `
      <div class="ph-sms-head">
        ${sms.mode === "android" ? `<button type="button" class="btn secondary" data-ph="sms-new">${ic("plus")}<span>Nouveau SMS</span></button>` : ""}
        <button type="button" class="btn secondary" data-ph="sms-setup">${ic("settings")}<span>${sms.mode === "android" ? "Téléphone relié" : "Relier mes SMS"}</span></button>
      </div>
      <div class="ph-rows">
        ${
          st.threads
            .map(
              (t) => `<button type="button" class="ph-row${t.unread ? " unread" : ""}${st.thread?.number === t.number ? " active" : ""}" data-ph="open-thread" data-number="${esc(t.number)}">
            <span class="ph-row-icon">${ic("message")}</span>
            <span class="ph-row-main"><span class="ph-row-top"><b>${esc(t.name || clientOf(t.number)?.name || t.display)}</b><time>${esc(when(t.at))}</time></span>
            <span class="ph-row-bottom"><span>${esc((t.fromMe ? "Vous : " : "") + t.last)}</span>${t.unread ? `<span class="ph-count">${t.unread}</span>` : ""}</span></span>
          </button>`,
            )
            .join("") || `<p class="muted ph-none">${sms.mode === "android" ? "Aucun SMS pour l’instant." : "Les SMS de votre numéro arrivent ici une fois votre téléphone Android relié."}</p>`
        }
      </div>`;
  }

  // Right panel: keypad, a call's details, an SMS conversation.
  function renderPanel() {
    const el = document.getElementById("phPanel");
    if (!el) return;
    document.getElementById("phApp")?.classList.toggle("ph-reading", !!st.reading);
    const back = `<button type="button" class="btn secondary ph-back" data-ph="back">${ic("arrow-left")}<span>Retour</span></button>`;
    if (st.panel === "call" && st.selected) return (el.innerHTML = back + callDetail(st.selected));
    if (st.panel === "sms" && st.thread) return (el.innerHTML = back + smsThread(st.thread));
    if (st.panel === "sms-setup") return (el.innerHTML = back + smsSetup());
    el.innerHTML = keypad();
  }
  function keypad() {
    const keys = [["1", ""], ["2", "ABC"], ["3", "DEF"], ["4", "GHI"], ["5", "JKL"], ["6", "MNO"], ["7", "PQRS"], ["8", "TUV"], ["9", "WXYZ"], ["*", ""], ["0", "+"], ["#", ""]];
    const shown = st.me?.line?.mobileDisplay || st.me?.line?.didDisplay || "";
    return `
      <div class="ph-keypad">
        <label class="ph-dial-label" for="phDial">Numéro ou nom d’un client</label>
        <div class="ph-dial"><input id="phDial" inputmode="tel" autocomplete="off" value="${esc(st.dial)}" placeholder="079 123 45 67"><button type="button" class="ph-icon-btn" data-ph="backspace" aria-label="Effacer" title="Effacer">${ic("arrow-left")}</button></div>
        <div id="phSuggest" class="ph-suggest"></div>
        <div class="ph-keys">${keys.map(([k, sub]) => `<button type="button" class="ph-key" data-ph="key" data-key="${k}"><b>${k}</b><small>${sub}</small></button>`).join("")}</div>
        <button type="button" class="ph-round ph-green ph-dial-call" data-ph="dial" aria-label="Appeler" title="Appeler">${ic("phone")}</button>
        ${shown ? `<p class="ph-hint">Le correspondant verra ${esc(shown)}.</p>` : ""}
      </div>`;
  }
  function suggestions() {
    const el = document.getElementById("phSuggest");
    if (!el) return;
    const q = st.dial.trim().toLowerCase();
    if (q.length < 2) return (el.innerHTML = "");
    const numeric = /^[\d\s+]+$/.test(q);
    const list = (core()?.getState?.()?.clients || [])
      .filter((c) => (c.phone || c.mobile) && (numeric ? phoneKey(c.phone).includes(q.replace(/\D/g, "").slice(-9)) || phoneKey(c.mobile).includes(q.replace(/\D/g, "").slice(-9)) : String(c.name || "").toLowerCase().includes(q)))
      .slice(0, 5);
    el.innerHTML = list.map((c) => `<button type="button" class="ph-suggest-item" data-ph="pick" data-number="${esc(c.phone || c.mobile)}"><b>${esc(c.name)}</b><small>${esc(c.phone || c.mobile)}</small></button>`).join("");
  }

  async function openCall(id, { quiet = false } = {}) {
    st.panel = "call";
    st.reading = true;
    if (!quiet) {
      st.selected = st.calls.find((c) => c.id === id) || st.team.find((c) => c.id === id) || { id, loading: true };
      renderList();
      renderPanel();
    }
    try {
      const fromTeam = st.tab === "team" && st.team.some((c) => c.id === id);
      st.selected = fromTeam ? st.team.find((c) => c.id === id) : (await get("calls/" + id)).call;
    } catch (error) {
      st.selected = { id, error: error.message };
    }
    renderPanel();
  }
  function actionCard(a, i, c) {
    const rows = [];
    const state = core()?.getState?.() || {};
    const client = (state.clients || []).find((x) => String(x.id) === String(a.clientId));
    const project = (state.projects || []).find((x) => String(x.id) === String(a.projectId));
    const company = (state.companies || []).find((x) => x.id === a.company);
    if (company) rows.push(["Entreprise", company.name]);
    if (client) rows.push(["Client", client.name]);
    if (project) rows.push(["Chantier", project.title || project.id]);
    if (a.type === "quote.prepare") rows.push(["Objet", a.title || "—"], ["Travaux", a.brief || "—"]);
    if (a.type === "invoice.prepare") {
      rows.push(["Objet", a.title || "—"]);
      for (const l of a.lines || []) rows.push(["Ligne", `${l.description} — ${l.quantity} ${l.unit}${l.unitPrice ? ` à CHF ${Number(l.unitPrice).toFixed(2)}` : " (prix à compléter)"}`]);
    }
    if (a.type === "task.create") rows.push(["Tâche", a.title], ...(a.dueDate ? [["Échéance", swissDate(a.dueDate)]] : []));
    if (a.type === "planning.create") rows.push(["Date", `${swissDate(a.date)} ${a.start || ""}–${a.end || ""}`], ["Salarié", (state.employees || []).find((e) => String(e.id) === String(a.employeeId))?.name || "à choisir"]);
    if (a.type === "client.create") rows.push(["Nom", a.name || "—"], ["Téléphone", a.phone || display(c.number)], ...(a.email ? [["E-mail", a.email]] : []), ...(a.city ? [["Adresse", [a.street, a.zip, a.city].filter(Boolean).join(" ")]] : []));
    if (a.type === "callback") rows.push(["Quand", a.dueDate ? swissDate(a.dueDate) : "à choisir"], ...(a.note ? [["Pour", a.note]] : []));
    const own = !c.userName;
    const footer =
      a.status === "done"
        ? `<p class="ph-action-state ok">${ic("check")}<span>Fait</span></p>`
        : a.status === "dismissed"
          ? `<p class="ph-action-state">Ignoré</p>`
          : own
            ? `<div class="ph-action-buttons"><button type="button" class="btn primary" data-ph="act" data-i="${i}">${esc(a.type === "quote.prepare" ? "Ouvrir le devis" : a.type === "client.create" ? "Créer le client" : a.type === "callback" ? "Programmer le rappel" : "Créer")}</button><button type="button" class="btn secondary" data-ph="dismiss" data-i="${i}">Ignorer</button></div>`
            : "";
    return `<div class="ph-action"><b>${esc(ACTION_TITLES[a.type] || a.type)}</b><dl>${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>${footer}</div>`;
  }
  function callDetail(c) {
    if (c.loading) return '<p class="muted ph-none">Chargement…</p>';
    if (c.error) return `<p class="ph-error">${esc(c.error)}</p>`;
    const client = (core()?.getState?.()?.clients || []).find((x) => String(x.id) === String(c.clientId)) || clientOf(c.number);
    const who = client?.name || c.caller?.name || display(c.number);
    const kind = c.direction === "out" ? "Appel passé" : c.status === "voicemail" ? "Message vocal" : c.status === "missed" ? "Appel manqué" : "Appel reçu";
    const own = !c.userName;
    const ai = {
      waiting: "Le résumé arrive dans un instant…",
      pending: "Le résumé arrive dans un instant…",
      running: "L’assistant écoute l’appel…",
      failed: c.aiError || "Le résumé n’a pas pu être fait.",
      unavailable: "L’assistant IA n’est pas configuré : pas de résumé.",
      none: c.recorded ? "" : c.status === "completed" ? "Appel non enregistré : pas de résumé." : "",
    }[c.aiStatus];
    return `
      <div class="ph-detail">
        <div class="ph-detail-head">
          <span class="ph-avatar big">${ic(c.status === "voicemail" ? "mic" : "phone")}</span>
          <div><b>${esc(who)}</b><small>${esc([display(c.number), kind, when(c.startedAt), c.seconds ? duration(c.seconds) : ""].filter(Boolean).join(" · "))}${c.userName ? " · " + esc(c.userName) : ""}</small></div>
        </div>
        ${
          own
            ? `<div class="ph-detail-tools">
          ${c.number ? `<button type="button" class="btn primary" data-ph="call-back" data-number="${esc(c.number)}">${ic("phone")}<span>Rappeler</span></button>` : ""}
          ${c.number && st.me?.line?.sms?.mode === "android" ? `<button type="button" class="btn secondary" data-ph="sms-to" data-number="${esc(c.number)}">${ic("message")}<span>SMS</span></button>` : ""}
          <button type="button" class="btn secondary" data-ph="remind">${ic("bell")}<span>${c.callbackAt ? "Rappel le " + esc(when(c.callbackAt)) : "Me le rappeler"}</span></button>
          ${client ? `<button type="button" class="btn secondary" data-action="client-edit" data-id="${esc(client.id)}">${ic("user")}<span>Fiche client</span></button>` : ""}
        </div>`
            : ""
        }
        ${own && c.hasRecording ? `<audio class="ph-audio" controls preload="none" src="/api/phone/calls/${c.id}/recording"></audio>` : ""}
        ${c.summary ? `<div class="ph-summary"><b>${ic("sparkle")}Résumé</b><ul>${c.summary.split("\n").map((l) => `<li>${esc(l.replace(/^- /, ""))}</li>`).join("")}</ul></div>` : ai ? `<p class="ph-hint">${esc(ai)}${own && ["failed", "unavailable"].includes(c.aiStatus) && c.hasRecording ? ` <button type="button" class="btn secondary" data-ph="summarize">Réessayer</button>` : ""}</p>` : ""}
        ${c.actions?.length ? `<div class="ph-actions"><h4>À faire après l’appel</h4>${c.actions.map((a, i) => actionCard(a, i, c)).join("")}</div>` : ""}
        ${c.transcript ? `<details class="ph-transcript"><summary>Transcription</summary><pre>${esc(c.transcript)}</pre></details>` : ""}
      </div>`;
  }

  async function openThread(number) {
    st.panel = "sms";
    st.reading = true;
    st.thread = { number, display: display(number), messages: [], loading: true };
    renderPanel();
    try {
      st.thread = await get("sms/" + enc(number));
      const t = st.threads.find((x) => x.number === number);
      if (t?.unread) {
        t.unread = 0;
        loadMe(true);
      }
    } catch (error) {
      st.thread = { number, display: display(number), messages: [], error: error.message };
    }
    renderList();
    renderPanel();
    const box = document.querySelector(".ph-bubbles");
    if (box) box.scrollTop = box.scrollHeight;
  }
  function smsThread(t) {
    const linked = st.me?.line?.sms?.mode === "android";
    const tick = { pending: "Envoi…", sent: "Envoyé", delivered: "Distribué", failed: "Échec" };
    return `
      <div class="ph-detail ph-sms">
        <div class="ph-detail-head"><span class="ph-avatar big">${ic("message")}</span><div><b>${esc(t.name || clientOf(t.number)?.name || t.display)}</b><small>${esc(t.display)}</small></div>
          <button type="button" class="ph-icon-btn" data-ph="call-back" data-number="${esc(t.number)}" aria-label="Appeler" title="Appeler">${ic("phone")}</button></div>
        ${t.error ? `<p class="ph-error">${esc(t.error)}</p>` : ""}
        <div class="ph-bubbles">${(t.messages || []).map((m) => `<div class="ph-bubble${m.fromMe ? " me" : ""}"><p>${esc(m.body)}</p><small>${esc(when(m.at))}${m.fromMe ? " · " + esc(tick[m.status] || m.status) : ""}</small></div>`).join("") || (t.loading ? '<p class="muted ph-none">Chargement…</p>' : '<p class="muted ph-none">Aucun message.</p>')}</div>
        ${linked ? `<form class="ph-sms-form" id="phSmsForm"><textarea name="text" rows="2" maxlength="1600" placeholder="Écrire un SMS" required></textarea><button type="submit" class="ph-round ph-green" aria-label="Envoyer" title="Envoyer">${ic("send")}</button></form>` : '<p class="ph-hint">Reliez votre téléphone Android pour répondre par SMS.</p>'}
      </div>`;
  }
  function smsSetup() {
    const sms = st.me?.line?.sms || {};
    if (!st.me?.line) return noLine(st.me);
    if (sms.mode === "android")
      return `<div class="ph-detail"><h3>SMS reliés</h3><p>Les SMS reçus sur votre téléphone Android arrivent ici, et vos réponses partent de votre numéro${sms.status === "ok" ? "" : " (en attente du premier SMS reçu)"}.</p><button type="button" class="btn secondary" data-ph="sms-unlink">${ic("x")}<span>Délier</span></button></div>`;
    return `
      <div class="ph-detail ph-setup">
        <h3>Relier les SMS de votre téléphone</h3>
        <p class="ph-note">${ic("alert")}<span>Seulement avec un téléphone <b>Android</b>. Sur iPhone, Apple ne permet à aucune application de lire ou d’envoyer les SMS : ils restent sur le téléphone.</span></p>
        <ol>
          <li>Sur le téléphone, installez l’application gratuite <b>SMS Gateway for Android</b> (Google Play, ou sms-gate.app).</li>
          <li>Ouvrez-la, activez <b>Cloud server</b>, appuyez sur <b>Start</b>, puis <b>Sign up</b>. Autorisez l’envoi et la réception des SMS.</li>
          <li>Recopiez ci-dessous l’<b>utilisateur</b> et le <b>mot de passe</b> affichés dans la section Cloud server.</li>
        </ol>
        <form id="phSmsSetup" class="ph-form">
          <label>Utilisateur<input name="login" autocomplete="off" required></label>
          <label>Mot de passe<input name="password" type="password" autocomplete="new-password" required></label>
          <label class="ph-check"><input type="checkbox" name="encrypted" checked><span>Chiffrer de bout en bout (recommandé)</span></label>
          <div class="ph-passphrase" id="phPassphrase"><p>Dans l’application Android : <b>Settings → Encryption → Passphrase</b>, saisissez exactement :</p><code id="phPassphraseValue">…</code></div>
          <details><summary>Serveur privé (facultatif)</summary><label>Adresse du serveur<input name="url" placeholder="https://api.sms-gate.app/3rdparty/v1"></label></details>
          <button type="submit" class="btn primary">${ic("check")}<span>Relier</span></button>
        </form>
      </div>`;
  }

  // -------------------------------------------------------------------------
  // Recording a message in the browser (announcement, voicemail greeting) → 8 kHz WAV
  // -------------------------------------------------------------------------
  async function toWav8k(blob) {
    const buffer = await blob.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    let audio;
    try {
      audio = await ctx.decodeAudioData(buffer);
    } finally {
      ctx.close?.();
    }
    const frames = Math.max(1, Math.ceil(audio.duration * 8000));
    const off = new OfflineAudioContext(1, frames, 8000);
    const src = off.createBufferSource();
    src.buffer = audio;
    src.connect(off.destination);
    src.start();
    const data = (await off.startRendering()).getChannelData(0);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v));
    const gain = peak > 0.01 ? Math.min(4, 0.7 / peak) : 1;
    const out = new DataView(new ArrayBuffer(44 + data.length * 2));
    const text = (o, s) => [...s].forEach((ch, i) => out.setUint8(o + i, ch.charCodeAt(0)));
    text(0, "RIFF");
    out.setUint32(4, 36 + data.length * 2, true);
    text(8, "WAVE");
    text(12, "fmt ");
    out.setUint32(16, 16, true);
    out.setUint16(20, 1, true);
    out.setUint16(22, 1, true);
    out.setUint32(24, 8000, true);
    out.setUint32(28, 16000, true);
    out.setUint16(32, 2, true);
    out.setUint16(34, 16, true);
    text(36, "data");
    out.setUint32(40, data.length * 2, true);
    for (let i = 0; i < data.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, data[i] * gain)) * 0x7fff, true);
    const bytes = new Uint8Array(out.buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { dataUrl: "data:audio/wav;base64," + btoa(binary), url: URL.createObjectURL(new Blob([bytes], { type: "audio/wav" })), seconds: data.length / 8000 };
  }
  const recorder = { media: null, chunks: [], stream: null, target: "", result: null };
  function soundCard(target, title, hint, present) {
    return `<div class="ph-sound" data-target="${target}">
      <b>${esc(title)}</b><small>${esc(hint)}</small>
      <p class="ph-sound-state">${present ? `${ic("check")}<span>Enregistrée</span>` : `${ic("alert")}<span>Pas encore enregistrée</span>`}</p>
      <div class="ph-sound-tools">
        <button type="button" class="btn secondary" data-ph="rec-start" data-target="${target}">${ic("mic")}<span>Enregistrer</span></button>
        <button type="button" class="btn secondary" data-ph="rec-stop" data-target="${target}" hidden>${ic("stop")}<span>Arrêter</span></button>
        <label class="btn secondary ph-file">${ic("paperclip")}<span>Fichier audio</span><input type="file" accept="audio/*" data-ph-file="${target}" hidden></label>
        ${present ? `<button type="button" class="btn secondary" data-ph="rec-remove" data-target="${target}">${ic("trash")}<span>Supprimer</span></button>` : ""}
      </div>
      <div class="ph-sound-preview" data-preview="${target}"></div>
    </div>`;
  }
  async function recordStart(target) {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast("Enregistrement impossible avec ce navigateur : choisissez un fichier audio.");
    try {
      recorder.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return toast("Le micro est bloqué : autorisez-le dans le navigateur.");
    }
    recorder.chunks = [];
    recorder.target = target;
    recorder.media = new MediaRecorder(recorder.stream);
    recorder.media.ondataavailable = (e) => e.data?.size && recorder.chunks.push(e.data);
    recorder.media.onstop = async () => {
      recorder.stream.getTracks().forEach((t) => t.stop());
      await preview(target, new Blob(recorder.chunks, { type: recorder.media.mimeType || "audio/webm" }));
    };
    recorder.media.start();
    const card = document.querySelector(`.ph-sound[data-target="${target}"]`);
    card?.querySelector('[data-ph="rec-start"]')?.setAttribute("hidden", "");
    card?.querySelector('[data-ph="rec-stop"]')?.removeAttribute("hidden");
    const p = card?.querySelector(".ph-sound-state");
    if (p) p.innerHTML = `${ic("mic")}<span>Enregistrement… parlez maintenant</span>`;
  }
  async function preview(target, blob) {
    const el = document.querySelector(`[data-preview="${target}"]`);
    try {
      const wav = await toWav8k(blob);
      if (wav.seconds < 1 || wav.seconds > 120) throw new Error("L’enregistrement doit durer entre 1 seconde et 2 minutes.");
      recorder.result = { target, ...wav };
      if (el) el.innerHTML = `<audio controls src="${wav.url}"></audio><button type="button" class="btn primary" data-ph="rec-save" data-target="${target}">${ic("check")}<span>Utiliser cet enregistrement</span></button>`;
    } catch (error) {
      toast(error.message || "Ce fichier audio ne peut pas être lu.");
    }
    const card = document.querySelector(`.ph-sound[data-target="${target}"]`);
    card?.querySelector('[data-ph="rec-start"]')?.removeAttribute("hidden");
    card?.querySelector('[data-ph="rec-stop"]')?.setAttribute("hidden", "");
  }
  async function saveSound(target, remove = false) {
    const path = target === "greeting-own" ? "greeting" : "admin/sound/" + target;
    await post(path, remove ? { remove: true } : { audio: recorder.result?.dataUrl });
    recorder.result = null;
    toast(remove ? "Message supprimé." : "Message enregistré.");
    await loadMe(true);
    if (target === "greeting-own") openGreeting();
    else openAdmin();
  }

  function openGreeting() {
    core().modal(
      "Mon répondeur",
      `<div class="ph-modal">
        <p>Quand vous ne répondez pas (ou refusez l’appel), le correspondant entend ce message, puis peut laisser un message vocal : il arrive dans vos appels, résumé par l’assistant.</p>
        ${soundCard("greeting-own", "Message d’accueil personnel", "Ex. « Bonjour, vous êtes sur la ligne de Jean, de Sousa Group. Laissez-moi un message après le bip. »", !!st.me?.line?.greeting)}
        <p class="ph-hint">Sans message personnel : le message du groupe, sinon une annonce standard.</p>
      </div>`,
    );
  }

  // -------------------------------------------------------------------------
  // Administrators' settings
  // -------------------------------------------------------------------------
  async function openAdmin() {
    let a;
    try {
      a = await get("admin");
    } catch (error) {
      return toast(error.message);
    }
    st.admin = a;
    const o = a.operator;
    const s = a.status || {};
    const lineUsers = new Set(a.lines.map((l) => l.userId));
    core().modal(
      "Réglages du téléphone",
      `<div class="ph-modal ph-admin">
        <p class="ph-state ${s.connected ? "on" : "off"}">${ic(s.connected ? "check" : "alert")}<span>${s.connected ? `Central téléphonique connecté${s.operator === "online" ? " · opérateur joignable" : s.operator === "offline" ? " · opérateur injoignable" : ""}` : "Central téléphonique injoignable (installé avec la mise à jour du serveur)"}</span></p>
        <section>
          <h3>1. Opérateur suisse (compte SIP)</h3>
          <p class="ph-hint">Les informations données par l’opérateur pour un « SIP trunk » ou « compte SIP » compatible Asterisk. Demandez aussi l’option <b>CLIP no screening</b> pour afficher le mobile de chacun.</p>
          <form id="phOperator" class="ph-form ph-grid">
            <label>Serveur SIP<input name="host" value="${esc(o.host)}" placeholder="sip.operateur.ch"></label>
            <label>Port<input name="port" inputmode="numeric" value="${esc(o.port)}" placeholder="5060"></label>
            <label>Identifiant SIP<input name="username" value="${esc(o.username)}" autocomplete="off"></label>
            <label>Mot de passe SIP<input name="password" type="password" autocomplete="new-password" placeholder="${o.hasPassword ? "•••••••• (inchangé)" : ""}"></label>
            <details class="span-2"><summary>Options avancées</summary>
              <div class="ph-grid">
                <label>Identifiant d’authentification (si différent)<input name="authUsername" value="${esc(o.authUsername)}" autocomplete="off"></label>
                <label>« From » imposé par l’opérateur<input name="fromUser" value="${esc(o.fromUser)}" autocomplete="off"></label>
                <label>Format des numéros composés<select name="dialFormat"><option value="+"${o.dialFormat === "+" ? " selected" : ""}>+41 79…</option><option value="00"${o.dialFormat === "00" ? " selected" : ""}>0041 79…</option><option value="national"${o.dialFormat === "national" ? " selected" : ""}>079…</option></select></label>
                <label class="ph-check"><input type="checkbox" name="register"${o.register ? " checked" : ""}><span>Enregistrement auprès de l’opérateur</span></label>
                <label class="ph-check"><input type="checkbox" name="allowWorld"${o.allowWorld ? " checked" : ""}><span>Autoriser les appels hors d’Europe</span></label>
              </div>
            </details>
            <button type="submit" class="btn primary span-2">${ic("check")}<span>Enregistrer l’opérateur</span></button>
          </form>
        </section>
        <section>
          <h3>2. Lignes</h3>
          <p class="ph-hint">Pour chaque personne : le numéro suisse donné par l’opérateur (vers lequel son mobile renvoie ses appels) et son mobile (affiché quand elle appelle).</p>
          <div class="ph-lines">${a.lines
            .map(
              (l) => `<div class="ph-line-row"><b>${esc(l.name)}</b><span>${esc(l.did ? display(l.did) : "sans numéro")} ← ${esc(l.mobile ? display(l.mobile) : "mobile ?")}</span><small>${l.sms === "android" ? "SMS reliés" : "SMS non reliés"} · sonne ${l.ringSeconds} s</small><button type="button" class="ph-icon-btn" data-ph="line-edit" data-id="${l.userId}" aria-label="Modifier" title="Modifier">${ic("edit")}</button><button type="button" class="ph-icon-btn" data-ph="line-remove" data-id="${l.userId}" aria-label="Retirer" title="Retirer">${ic("trash")}</button></div>`,
            )
            .join("") || '<p class="muted">Aucune ligne.</p>'}</div>
          <form id="phLine" class="ph-form ph-grid">
            <label>Personne<select name="userId" required><option value="">Choisir…</option>${a.users.map((u) => `<option value="${u.id}">${esc(u.name)}${lineUsers.has(u.id) ? " (a déjà une ligne)" : ""}</option>`).join("")}</select></label>
            <label>Numéro de l’opérateur<input name="did" inputmode="tel" placeholder="021 555 00 00"></label>
            <label>Son mobile<input name="mobile" inputmode="tel" placeholder="079 123 45 67"></label>
            <label>Sonne pendant (secondes)<input name="ringSeconds" type="number" min="10" max="60" value="25"></label>
            <button type="submit" class="btn primary span-2">${ic("plus")}<span>Enregistrer la ligne</span></button>
          </form>
        </section>
        <section>
          <h3>3. Enregistrement et résumés</h3>
          <p class="ph-hint">La loi suisse demande de prévenir le correspondant avant d’enregistrer. L’annonce est jouée aux deux personnes au début de chaque appel ; l’enregistrement commence après.</p>
          ${soundCard("announcement", "Annonce d’enregistrement", "Ex. « Bonjour, cet appel est enregistré afin d’en faire un résumé. »", a.recording.announcement)}
          ${soundCard("greeting", "Message d’accueil du répondeur (groupe)", "Joué quand personne ne répond, avant le bip.", a.recording.greeting)}
          <form id="phRecording" class="ph-form ph-grid">
            <label class="ph-check"><input type="checkbox" name="enabled"${a.recording.enabled ? " checked" : ""}><span>Enregistrer et résumer les appels</span></label>
            <label>Garder les enregistrements (jours)<input name="keepDays" type="number" min="1" max="3650" value="${a.recording.keepDays}"></label>
            <button type="submit" class="btn primary span-2">${ic("check")}<span>Enregistrer</span></button>
          </form>
        </section>
        <section>
          <h3>4. Relais pour les appels hors du bureau</h3>
          <p class="ph-hint">Adresse « TURN » d’un service de relais (ex. turn:relais.exemple.com:3478), utilisateur et mot de passe. Il sert aussi aux appels internes de la messagerie.</p>
          <form id="phRelay" class="ph-form ph-grid">
            <label class="span-2">Adresses du relais (une par ligne)<textarea name="turnUrls" rows="2" placeholder="turn:relais.exemple.com:3478">${esc((a.relay.turnUrls || []).join("\n"))}</textarea></label>
            <label>Utilisateur<input name="turnUser" value="${esc(a.relay.turnUser)}" autocomplete="off"></label>
            <label>Mot de passe<input name="turnPassword" type="password" autocomplete="new-password" placeholder="${a.relay.hasPassword ? "•••••••• (inchangé)" : ""}"></label>
            <label class="span-2">Serveur STUN (facultatif)<input name="stun" value="${esc(a.relay.stun)}" placeholder="stun.l.google.com:19302"></label>
            <button type="submit" class="btn primary span-2">${ic("check")}<span>Enregistrer le relais</span></button>
          </form>
        </section>
      </div>`,
    );
  }
  function editLine(userId) {
    const l = st.admin?.lines.find((x) => x.userId === Number(userId));
    const form = document.getElementById("phLine");
    if (!l || !form) return;
    form.userId.value = String(l.userId);
    form.did.value = l.did ? display(l.did) : "";
    form.mobile.value = l.mobile ? display(l.mobile) : "";
    form.ringSeconds.value = l.ringSeconds;
    form.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // -------------------------------------------------------------------------
  // What the assistant proposed, done in a click
  // -------------------------------------------------------------------------
  function fillWhenReady(fill, tries = 0) {
    if (fill() || tries > 30) return;
    setTimeout(() => fillWhenReady(fill, tries + 1), 60);
  }
  async function runAction(c, i) {
    const a = c.actions[i];
    const enc2 = encodeURIComponent;
    let ref = "";
    if (a.type === "quote.prepare") {
      if (!window.SGOP3Center?.openTool) return toast("L’outil de devis n’est pas disponible pour votre compte.");
      window.SGOP3Center.openTool("quote");
      fillWhenReady(() => {
        const brief = document.getElementById("p3QuoteBrief");
        if (!brief) return false;
        const set = (id, v) => {
          const el = document.getElementById(id);
          if (el && v && [...(el.options || [{ value: v }])].some((o) => o.value === v)) el.value = v;
        };
        set("p3QuoteCompany", a.company);
        document.getElementById("p3QuoteCompany")?.dispatchEvent(new Event("change", { bubbles: true }));
        setTimeout(() => set("p3QuoteClient", a.clientId), 30);
        const title = document.getElementById("p3QuoteRequestedTitle");
        if (title && a.title) title.value = a.title;
        brief.value = a.brief || "";
        return true;
      });
      ref = "devis";
    } else if (a.type === "invoice.prepare") {
      if (!a.company || !a.clientId) return toast("Choisissez d’abord le client dans une facture : l’assistant ne l’a pas reconnu.");
      const due = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      const created = await core().command("create", { company: a.company, clientId: a.clientId, project: a.projectId || "", title: a.title || "Facture", date: today(), due, lines: (a.lines || []).map((l) => ({ ...l, vatRate: 8.1, discount: 0 })) }, "invoices");
      ref = created?.id || "";
      if (ref) {
        const opener = document.createElement("button");
        opener.type = "button";
        opener.hidden = true;
        opener.dataset.action = "invoice";
        opener.dataset.id = ref;
        document.body.append(opener);
        opener.click();
        opener.remove();
      }
    } else if (a.type === "task.create") {
      await core().api("operations/tasks", { projectId: a.projectId, title: a.title, priority: a.priority || "normal", dueDate: a.dueDate || null, status: "todo" });
      toast("Tâche créée.");
    } else if (a.type === "planning.create") {
      if (!a.employeeId || !a.date || !a.start || !a.end) return toast("Il manque le salarié, la date ou l’horaire : complétez-le dans le planning.");
      const project = (core().getState().projects || []).find((p) => String(p.id) === String(a.projectId));
      await core().command("create", { employeeId: a.employeeId, project: a.projectId, date: a.date, start: a.start, end: a.end, location: project?.address || "" }, "planning");
      toast("Rendez-vous ajouté au planning.");
    } else if (a.type === "client.create") {
      const opener = document.createElement("button");
      opener.type = "button";
      opener.hidden = true;
      opener.dataset.action = "new";
      opener.dataset.id = "clients";
      document.body.append(opener);
      opener.click();
      opener.remove();
      fillWhenReady(() => {
        const phoneField = document.getElementById("f_phone");
        if (!phoneField) return false;
        const set = (id, v) => {
          const el = document.getElementById(id);
          if (el && v && !el.value) el.value = v;
        };
        phoneField.value = a.phone || display(c.number);
        set("f_name", a.name);
        set("f_email", a.email);
        set("f_street", a.street);
        set("f_zip", a.zip);
        set("f_city", a.city);
        if (a.company) {
          const company = document.getElementById("f_company");
          if (company && [...company.options].some((o) => o.value === a.company)) company.value = a.company;
        }
        return true;
      });
      ref = "client";
    } else if (a.type === "callback") {
      const at = new Date((a.dueDate || today()) + "T09:00:00");
      if (at < new Date()) at.setTime(Date.now() + 2 * 3600000);
      await post(`calls/${c.id}/callback`, { at: at.toISOString(), note: a.note || "" });
      toast("Rappel programmé le " + at.toLocaleString("fr-CH", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) + ".");
    }
    const out = await post(`calls/${c.id}/actions/${i}`, { status: "done", ref });
    st.selected = { ...st.selected, actions: out.call.actions, callbackAt: a.type === "callback" ? new Date().toISOString() : st.selected.callbackAt };
    const row = st.calls.find((x) => x.id === c.id);
    if (row) row.actions = out.call.actions;
    renderPanel();
    renderList();
  }

  function openRemind(c) {
    const at = (h) => {
      const d = new Date();
      d.setHours(h, 0, 0, 0);
      if (d < new Date()) d.setDate(d.getDate() + 1);
      return d;
    };
    const choices = [
      ["Dans 1 heure", new Date(Date.now() + 3600000)],
      ["Cet après-midi (14 h)", at(14)],
      ["Demain matin (9 h)", (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; })()],
    ];
    core().modal(
      "Me le rappeler",
      `<form id="phRemindForm" class="ph-form ph-modal" data-id="${c.id}">
        <p>Une notification vous rappellera de rappeler ${esc(nameOf(c.number))}.</p>
        <div class="ph-choices">${choices.map(([label, d]) => `<button type="button" class="btn secondary" data-ph="remind-pick" data-at="${d.toISOString()}">${esc(label)}</button>`).join("")}</div>
        <label>Ou le<input type="datetime-local" name="at" required></label>
        <label>Note<input name="note" maxlength="300" placeholder="Ex. confirmer la date d’intervention"></label>
        <div class="ph-choices">${c.callbackAt ? `<button type="button" class="btn secondary" data-ph="remind-cancel">Annuler le rappel</button>` : ""}<button type="submit" class="btn primary">${ic("bell")}<span>Programmer</span></button></div>
      </form>`,
    );
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------
  document.addEventListener("click", async (event) => {
    if (audioCtx?.state === "suspended") audioCtx.resume?.();
    const el = event.target.closest("[data-ph]");
    if (!el) return;
    const what = el.dataset.ph;
    try {
      if (what === "answer") return answer();
      if (what === "hangup") return hangup();
      if (what === "mute") {
        if (!phone.session) return;
        phone.muted = !phone.muted;
        phone.muted ? phone.session.mute({ audio: true }) : phone.session.unmute({ audio: true });
        return renderCallBox();
      }
      if (what === "dtmf-toggle") {
        phone.dtmf = !phone.dtmf;
        return renderCallBox();
      }
      if (what === "dtmf") return phone.session?.sendDTMF?.(el.dataset.key);
      if (what === "tab") {
        st.tab = el.dataset.id;
        st.panel = "keypad";
        st.reading = false;
        st.callsError = "";
        render(document.getElementById("phoneRoot"));
        return;
      }
      if (what === "filter") {
        st.filter = el.dataset.id;
        st.calls = [];
        renderList();
        return loadCalls(true);
      }
      if (what === "more") return loadCalls(false);
      if (what === "open-call") return openCall(Number(el.dataset.id));
      if (what === "open-thread") return openThread(el.dataset.number);
      if (what === "back" || what === "keypad") {
        st.reading = false;
        st.panel = "keypad";
        st.selected = null;
        st.thread = null;
        renderList();
        renderPanel();
        if (what === "keypad") document.getElementById("phDial")?.focus();
        return;
      }
      if (what === "key") {
        st.dial += el.dataset.key;
        const input = document.getElementById("phDial");
        if (input) input.value = st.dial;
        if (phone.session && phone.state === "talking") phone.session.sendDTMF?.(el.dataset.key);
        return suggestions();
      }
      if (what === "backspace") {
        st.dial = st.dial.slice(0, -1);
        const input = document.getElementById("phDial");
        if (input) input.value = st.dial;
        return suggestions();
      }
      if (what === "pick") {
        st.dial = el.dataset.number;
        const input = document.getElementById("phDial");
        if (input) input.value = st.dial;
        document.getElementById("phSuggest").innerHTML = "";
        return;
      }
      if (what === "dial") return dialOut(st.dial);
      if (what === "call-back") return dialOut(el.dataset.number);
      if (what === "sms-to") {
        st.tab = "sms";
        render(document.getElementById("phoneRoot"));
        loadThreads();
        return openThread(el.dataset.number);
      }
      if (what === "sms-new") {
        const raw = window.prompt("Numéro du destinataire (ex. 079 123 45 67) :");
        if (!raw) return;
        const d = digits(raw);
        const number = d.startsWith("+") ? d : d.startsWith("00") ? "+" + d.slice(2) : d.startsWith("0") ? "+41" + d.slice(1) : "+" + d;
        return openThread(number);
      }
      if (what === "sms-setup") {
        st.panel = "sms-setup";
        st.reading = true;
        renderPanel();
        const box = document.getElementById("phPassphraseValue");
        if (box) get("sms-passphrase").then((r) => (box.textContent = r.passphrase)).catch(() => {});
        return;
      }
      if (what === "sms-unlink") {
        if (!window.confirm("Délier les SMS de votre téléphone ?")) return;
        await call("DELETE", "sms/setup");
        await loadMe(true);
        toast("SMS déliés.");
        return renderPanel();
      }
      if (what === "remind") return st.selected && openRemind(st.selected);
      if (what === "remind-pick") {
        const form = document.getElementById("phRemindForm");
        const d = new Date(el.dataset.at);
        form.at.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        return;
      }
      if (what === "remind-cancel") {
        const form = document.getElementById("phRemindForm");
        await post(`calls/${form.dataset.id}/callback`, { at: null });
        core().closeModal?.();
        toast("Rappel annulé.");
        return openCall(Number(form.dataset.id), { quiet: true });
      }
      if (what === "summarize") {
        el.disabled = true;
        st.selected = (await post(`calls/${st.selected.id}/summarize`)).call;
        renderPanel();
        return loadCalls(true);
      }
      if (what === "act" || what === "dismiss") {
        const c = st.selected;
        el.disabled = true;
        if (what === "act") await runAction(c, Number(el.dataset.i));
        else {
          const out = await post(`calls/${c.id}/actions/${el.dataset.i}`, { status: "dismissed" });
          st.selected = { ...c, actions: out.call.actions };
          renderPanel();
          renderList();
        }
        return;
      }
      if (what === "greeting") return openGreeting();
      if (what === "admin") return openAdmin();
      if (what === "line-edit") return editLine(el.dataset.id);
      if (what === "line-remove") {
        if (!window.confirm("Retirer cette ligne ?")) return;
        await call("DELETE", "admin/lines/" + el.dataset.id);
        toast("Ligne retirée.");
        return openAdmin();
      }
      if (what === "rec-start") return recordStart(el.dataset.target);
      if (what === "rec-stop") return recorder.media?.state === "recording" && recorder.media.stop();
      if (what === "rec-save") return saveSound(el.dataset.target);
      if (what === "rec-remove") {
        if (!window.confirm("Supprimer cet enregistrement ?")) return;
        return saveSound(el.dataset.target, true);
      }
    } catch (error) {
      el.disabled = false;
      toast(error.message || "Action impossible.");
    }
  });

  document.addEventListener("input", (event) => {
    if (event.target.id === "phDial") {
      st.dial = event.target.value;
      suggestions();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.target.id === "phDial" && event.key === "Enter") {
      event.preventDefault();
      dialOut(st.dial);
    }
  });
  document.addEventListener("change", async (event) => {
    const target = event.target.dataset?.phFile;
    if (target && event.target.files?.[0]) await preview(target, event.target.files[0]);
    if (event.target.name === "encrypted" && event.target.form?.id === "phSmsSetup") document.getElementById("phPassphrase")?.toggleAttribute("hidden", !event.target.checked);
  });

  document.addEventListener("submit", async (event) => {
    const form = event.target;
    const ids = ["phOperator", "phLine", "phRecording", "phRelay", "phSmsForm", "phSmsSetup", "phRemindForm"];
    if (!ids.includes(form.id)) return;
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    if (button) button.disabled = true;
    try {
      const f = Object.fromEntries(new FormData(form));
      if (form.id === "phOperator") {
        await call("PUT", "admin/operator", { host: f.host, port: f.port, username: f.username, password: f.password, authUsername: f.authUsername, fromUser: f.fromUser, dialFormat: f.dialFormat, register: !!form.register.checked, allowWorld: !!form.allowWorld.checked });
        toast("Opérateur enregistré.");
        return openAdmin();
      }
      if (form.id === "phLine") {
        if (!f.userId) throw new Error("Choisissez la personne.");
        await call("PUT", "admin/lines/" + f.userId, { did: f.did, mobile: f.mobile, ringSeconds: Number(f.ringSeconds) || 25 });
        toast("Ligne enregistrée.");
        await loadMe(true);
        return openAdmin();
      }
      if (form.id === "phRecording") {
        await call("PUT", "admin/recording", { enabled: !!form.enabled.checked, keepDays: Number(f.keepDays) || 30 });
        toast("Réglage enregistré.");
        return openAdmin();
      }
      if (form.id === "phRelay") {
        await call("PUT", "admin/relay", { turnUrls: f.turnUrls, turnUser: f.turnUser, turnPassword: f.turnPassword, stun: f.stun });
        toast("Relais enregistré.");
        return openAdmin();
      }
      if (form.id === "phSmsSetup") {
        const passphrase = form.encrypted.checked ? document.getElementById("phPassphraseValue")?.textContent || "" : "";
        await post("sms/setup", { login: f.login, password: f.password, url: f.url, encrypted: form.encrypted.checked, passphrase });
        await loadMe(true);
        toast("SMS reliés : envoyez-vous un SMS pour essayer.");
        st.panel = "keypad";
        st.reading = false;
        return render(document.getElementById("phoneRoot"));
      }
      if (form.id === "phSmsForm") {
        const text = String(f.text || "").trim();
        if (!text) return;
        const out = await post("sms/send", { number: st.thread.number, text });
        st.thread.messages.push(out.message);
        renderPanel();
        const box = document.querySelector(".ph-bubbles");
        if (box) box.scrollTop = box.scrollHeight;
        loadThreads();
        return;
      }
      if (form.id === "phRemindForm") {
        const at = new Date(f.at);
        await post(`calls/${form.dataset.id}/callback`, { at: at.toISOString(), note: f.note });
        core().closeModal?.();
        toast("Rappel programmé.");
        return openCall(Number(form.dataset.id), { quiet: true });
      }
    } catch (error) {
      toast(error.message || "Enregistrement impossible.");
    } finally {
      if (button?.isConnected) button.disabled = false;
    }
  });

  // -------------------------------------------------------------------------
  // Life cycle
  // -------------------------------------------------------------------------
  function afterRender() {
    const profile = core()?.getProfile?.();
    if (!profile) return;
    if (profile.role === "client") return;
    loadMe().then(() => updateNavBadge());
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      loadMe(true);
      if (core()?.getPage?.() === "phone" && !document.hidden) {
        if (st.tab === "calls") loadCalls(true);
        if (st.tab === "sms") {
          loadThreads();
          if (st.thread?.number && st.panel === "sms") openThreadQuiet(st.thread.number);
        }
      }
    }, 20000);
    const params = new URLSearchParams(location.search);
    if (params.get("open") === "phone" && handledUrl !== location.search) {
      handledUrl = location.search;
      prepare({ call: params.get("call") || "", sms: params.get("sms") || "" });
      history.replaceState(null, "", "/");
      core().setPage?.("phone");
    }
  }
  async function openThreadQuiet(number) {
    try {
      const fresh = await get("sms/" + enc(number));
      if (st.thread?.number === number && fresh.messages.length !== st.thread.messages.length) {
        st.thread = fresh;
        renderPanel();
      }
    } catch {
      // next time
    }
  }
  function prepare({ call: callId = "", sms = "" } = {}) {
    if (callId) {
      st.tab = "calls";
      setTimeout(() => openCall(Number(callId)), 0);
    } else if (sms) {
      st.tab = "sms";
      setTimeout(() => openThread(sms), 0);
    }
  }

  window.SGOPhone = { render, afterRender, hasAccess, unreadTotal, prepare, dial: dialOut, _state: st, _phone: phone };
  // The module may load after the first page was drawn.
  if (core()?.getProfile?.()) afterRender();
})();
