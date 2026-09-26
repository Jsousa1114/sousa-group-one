"use strict";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))),
      self.clients.claim(),
    ]),
  );
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
