// One-release cleanup worker for stale NeurlX app-shell caches.
// Installability is handled by manifest.json; NeurlX does not need an app-shell
// service worker unless offline mode is explicitly rebuilt later.

function isNeurlXAppCache(name) {
  return /^neurlx-|(^|-)precache-v\d+-|(^|-)runtime-/.test(name);
}

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      const cacheNames = await caches.keys();
      await Promise.allSettled(cacheNames.filter(isNeurlXAppCache).map((name) => caches.delete(name)));
      await self.clients.claim();
      const clients = await self.clients.matchAll({ type: "window" });
      await Promise.allSettled(clients.map((client) => client.navigate(client.url)));
    } finally {
      await self.registration.unregister();
    }
  })());
});
