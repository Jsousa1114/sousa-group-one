"use strict";
(() => {
  const DB_NAME = "sgo-p2-offline";
  const STORE = "mutations";
  let source = null;
  let installPrompt = null;
  let refreshTimer = null;
  let flushing = false;

  const core = () => window.SGOChatCore;
  const safeOfflineMutation = ({ action, collection, endpoint }) =>
    endpoint === "state/command" &&
    (
      ["time", "documents"].includes(String(collection || "")) ||
      ["clock.start", "clock.pause", "clock.resume", "clock.stop", "clock.switch"].includes(String(action || ""))
    );

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) return reject(new Error("IndexedDB indisponible."));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE))
          db.createObjectStore(STORE, { keyPath: "requestId" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function tx(mode, fn) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        let value;
        try { value = fn(store); } catch (error) { reject(error); return; }
        t.oncomplete = () => resolve(value);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error("Transaction interrompue."));
      });
    } finally { db.close(); }
  }
  async function queueMutation(item) {
    if (!safeOfflineMutation(item)) return false;
    await tx("readwrite", (store) => store.put({
      ...item,
      queuedAt: new Date().toISOString(),
    }));
    try {
      const reg = await navigator.serviceWorker?.ready;
      await reg?.sync?.register?.("sgo-offline-sync");
    } catch {}
    window.dispatchEvent(new CustomEvent("sgo-offline-queue-change"));
    return true;
  }
  async function listQueue() {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
        req.onsuccess = () => resolve((req.result || []).sort((a,b)=>String(a.queuedAt).localeCompare(String(b.queuedAt))));
        req.onerror = () => reject(req.error);
      });
    } finally { db.close(); }
  }
  async function removeQueue(requestId) {
    await tx("readwrite", (store) => store.delete(requestId));
    window.dispatchEvent(new CustomEvent("sgo-offline-queue-change"));
  }
  async function flushQueue() {
    if (flushing || !navigator.onLine || !core()?.api) return { sent: 0, remaining: (await listQueue().catch(()=>[])).length };
    flushing = true;
    let sent = 0;
    try {
      const items = await listQueue();
      for (const item of items) {
        try {
          await core().refresh(false);
          await core().api(item.endpoint, {
            action: item.action,
            payload: item.payload,
            collection: item.collection,
            revision: core().getRevision?.() || 0,
            requestId: item.requestId,
          });
          await removeQueue(item.requestId);
          sent++;
        } catch (error) {
          if (!navigator.onLine || !error?.status || error.status === 409) break;
          throw error;
        }
      }
      if (sent) {
        await core().refresh();
        core().toast(sent + " modification(s) hors ligne synchronisée(s).");
      }
      return { sent, remaining: (await listQueue()).length };
    } finally { flushing = false; }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    const run = () => {
      if (document.hidden || !navigator.onLine || !core()?.refresh) return;
      if (core()?.canRefreshMessages && !core().canRefreshMessages()) {
        refreshTimer = setTimeout(run, 1000);
        return;
      }
      core().refresh().catch(() => {});
    };
    refreshTimer = setTimeout(run, 500);
  }
  function startRealtime() {
    if (source || !window.EventSource || !navigator.onLine) return;
    source = new EventSource("/api/p2/events", { withCredentials: true });
    source.addEventListener("change", scheduleRefresh);
    source.onerror = () => {
      source?.close();
      source = null;
      setTimeout(() => {
        if (!document.getElementById("app")?.classList.contains("hidden")) startRealtime();
      }, 5000);
    };
  }
  function stopRealtime() {
    source?.close();
    source = null;
  }
  function syncBodyClasses() {
    document.body.classList.toggle("high-readability", localStorage.getItem("sgo_high_readability") === "1");
    document.body.classList.toggle("tablet-mode", localStorage.getItem("sgo_tablet_mode") === "1");
  }
  function setHighReadability(enabled) {
    localStorage.setItem("sgo_high_readability", enabled ? "1" : "0");
    syncBodyClasses();
  }
  function setTabletMode(enabled) {
    localStorage.setItem("sgo_tablet_mode", enabled ? "1" : "0");
    syncBodyClasses();
  }
  async function installApp() {
    if (!installPrompt) return false;
    installPrompt.prompt();
    const choice = await installPrompt.userChoice.catch(() => null);
    if (choice?.outcome === "accepted") installPrompt = null;
    return choice?.outcome === "accepted";
  }
  function canInstall() { return !!installPrompt; }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    window.dispatchEvent(new CustomEvent("sgo-install-available"));
  });
  window.addEventListener("appinstalled", () => { installPrompt = null; });
  window.addEventListener("online", () => {
    startRealtime();
    flushQueue().catch((e) => core()?.notice?.(e.message));
  });
  window.addEventListener("offline", stopRealtime);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && navigator.onLine) startRealtime();
  });
  navigator.serviceWorker?.addEventListener?.("message", (event) => {
    if (event.data?.type === "SGO_FLUSH_OFFLINE") flushQueue().catch(() => {});
  });

  const observer = new MutationObserver(() => {
    const loggedIn = !document.getElementById("app")?.classList.contains("hidden");
    if (loggedIn && navigator.onLine) startRealtime();
    else if (!loggedIn) stopRealtime();
  });
  observer.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["class"] });
  syncBodyClasses();

  window.SGOP2Runtime = {
    queueMutation,
    listQueue,
    flushQueue,
    safeOfflineMutation,
    installApp,
    canInstall,
    setHighReadability,
    setTabletMode,
    highReadability: () => document.body.classList.contains("high-readability"),
    tabletMode: () => document.body.classList.contains("tablet-mode"),
    realtimeConnected: () => !!source,
  };
})();
