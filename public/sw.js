// Taviron companion app service worker (docs/COMPANION_APP.md).
// Deliberately small: it never stores company data. Pages, data and actions always come from the network; when a
// page cannot be reached it shows /offline, which says plainly that nothing shown is current. No push, no sync.
const CACHE = "taviron-shell-v1";
const SHELL = ["/offline", "/app-icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Only full page loads are handled; everything else (data, actions, assets) goes to the network untouched.
  if (req.mode !== "navigate" || req.method !== "GET") return;
  event.respondWith(fetch(req).catch(() => caches.match("/offline").then((r) => r || Response.error())));
});
