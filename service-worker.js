// This service worker replaces an earlier version that aggressively cached
// app.js/index.html, which caused old (demo) code to keep being served
// after updates. It self-destructs: it deletes all caches, unregisters
// itself, and reloads any open tabs so fresh files are always fetched
// from the network from now on.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.registration.unregister())
      .then(() => self.clients.matchAll())
      .then(clients => clients.forEach(client => client.navigate(client.url)))
  );
});
