"use strict";

const STATIC_CACHE = "sgo-shell-2026-10-05-em-images",
  STATIC_ASSETS = [
    "/",
    "/index.html",
    "/styles.css",
    "/app.js",
    "/finance.js",
    "/messaging-crypto.js",
    "/messaging-suite.js",
    "/account-center.js",
    "/p2-runtime.js",
    "/p2-center.js",
    "/p1.css",
    "/p1-suite.js",
    "/pro-suite.js",
    "/supplier-suite.js",
    "/supplier.css",
    "/pro.css",
    "/passkeys.js",
    "/p2.css",
    "/visual-refresh.css",
    "/p3-center.js",
    "/operations-center.js",
    "/manifest.webmanifest",
    "/assets/logos/group.png",
    "/assets/logos/home.png",
    "/assets/logos/electricite.png",
    "/assets/logos/tech.png",
    "/assets/logos/moving.png",
    "/assets/logos/solar.png",
    "/assets/logos/events.png",
  ];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) =>
        Promise.allSettled(
          STATIC_ASSETS.map((url) =>
            fetch(url, { cache: "reload" }).then((response) => {
              if (response.ok) return cache.put(url, response);
            }),
          ),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter((key) => key !== STATIC_CACHE)
              .map((key) => caches.delete(key)),
          ),
        ),
      self.clients.claim(),
    ]),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/"))
    return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put("/index.html", copy));
          }
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(STATIC_CACHE);
          return (
            (await cache.match("/index.html")) ||
            new Response(
              "<!doctype html><title>Sousa Group One</title><p>Connexion indisponible. Reconnectez-vous pour synchroniser vos données.</p>",
              { headers: { "Content-Type": "text/html; charset=utf-8" } },
            )
          );
        }),
    );
    return;
  }

  if (
    /\.(?:js|css|png|svg|webmanifest)$/.test(url.pathname) ||
    STATIC_ASSETS.includes(url.pathname)
  ) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const network = fetch(req)
          .then((response) => {
            if (response.ok) cache.put(req, response.clone());
            return response;
          })
          .catch(() => null);
        // Executable assets must match the latest HTML after a deployment.
        // Retain the cached copy only when the network is unavailable.
        if (/\.(?:js|css|webmanifest)$/.test(url.pathname))
          return (await network) || cached || Response.error();
        return cached || (await network) || Response.error();
      }),
    );
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text?.() || "Nouvelle notification" };
  }
  const title = data.title || "Sousa Group One",
    options = {
      body: data.body || "Nouvelle activité",
      icon: "/assets/logos/group.png?v=push-20260927",
      badge: "/assets/logos/group.png?v=push-20260927",
      tag: data.tag || "sgo-notification",
      renotify: !!data.tag,
      silent: !!data.silent,
      vibrate: Array.isArray(data.vibrate) ? data.vibrate : [180, 90, 180],
      data: {
        url: data.url || "/",
        conversationKey: data.conversationKey || "",
        callRoomId: data.callRoomId || "",
      },
      actions: data.callRoomId
        ? [
            { action: "open", title: "Ouvrir" },
            { action: "dismiss", title: "Ignorer" },
          ]
        : [{ action: "open", title: "Ouvrir" }],
    };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.action === "dismiss") return;
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => {
        try {
          return new URL(client.url).origin === self.location.origin;
        } catch {
          return false;
        }
      });
      if (existing) {
        existing.navigate(target);
        return existing.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});


self.addEventListener("sync", (event) => {
  if (event.tag !== "sgo-offline-sync") return;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) client.postMessage({ type: "SGO_FLUSH_OFFLINE" });
    }),
  );
});
