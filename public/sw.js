// Minimal, safe service worker for NeurlX.
// - Never caches HTML navigations (always network) — avoids the blank-preview bug.
// - Provides an install target so browsers offer "Install app" (PWA).
// - Same-origin static assets get a lightweight cache-first with size cap.
// - Auto-activates and claims clients so updates roll out on next load.

const STATIC_CACHE = "neurlx-static-v3";
const MAX_STATIC = 60;

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k)),
    );
    await self.clients.claim();
  })());
});

async function trimCache(name, max) {
  try {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    if (keys.length <= max) return;
    for (const k of keys.slice(0, keys.length - max)) await cache.delete(k);
  } catch (_) {}
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Never cache HTML/navigations — always fetch fresh from network.
  const accept = req.headers.get("accept") || "";
  if (req.mode === "navigate" || accept.includes("text/html")) {
    event.respondWith(fetch(req).catch(() => new Response(
      "<!doctype html><meta charset=utf-8><title>Offline</title><body style=font-family:sans-serif;padding:2rem><h1>Offline</h1><p>NeurlX needs a network connection.</p>",
      { headers: { "content-type": "text/html; charset=utf-8" }, status: 503 },
    )));
    return;
  }

  // Static assets: cache-first with background refresh.
  if (/\.(?:js|css|woff2?|ttf|png|jpg|jpeg|svg|webp|ico|json)$/.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(STATIC_CACHE);
      const cached = await cache.match(req);
      const network = fetch(req).then((res) => {
        if (res && res.ok && res.type === "basic") {
          cache.put(req, res.clone()).then(() => trimCache(STATIC_CACHE, MAX_STATIC));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })());
  }
});
