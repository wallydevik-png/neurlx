// Kill-switch service worker.
// A previous version (neurlx-v1) cached HTML navigation responses and
// served them forever, which caused the app to render a blank document
// on preview and Cloudflare. This replacement takes control, deletes
// every cache, unregisters itself, and reloads open clients so the
// next request goes straight to the network.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch (_) {}
      try {
        await self.registration.unregister();
      } catch (_) {}
      const clients = await self.clients.matchAll({ type: "window" });
      for (const client of clients) {
        try { client.navigate(client.url); } catch (_) {}
      }
    })(),
  );
});

// Do not intercept fetches — let the network handle everything.
