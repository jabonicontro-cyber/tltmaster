// Taviron companion app service worker (docs/COMPANION_APP.md).
// Deliberately small, and it never stores company data. Pages, data and actions always come from the network; when a
// page cannot be reached it shows /offline. Since B133 (owner 2026-11-02) the offline page can show the driver's day
// saved on the phone by the app itself (browser storage, cleared at sign-out) — never by this worker. So that the
// offline page works without signal, this worker also keeps the app's own build files (/_next/static: scripts and
// styles with hashed names, identical for every company). No push, no background sync.
const CACHE = "taviron-shell-v2";
const SHELL = ["/offline", "/app-icons/icon-192.png"];
const STATIC = "/_next/static/";

// The build files the offline page needs, read from the offline page itself.
async function offlineAssets(cache) {
  try {
    const res = await fetch("/offline");
    const html = await res.text();
    const urls = [...new Set((html.match(/\/_next\/static\/[^"'\s)\\]+/g) || []))];
    await cache.addAll(urls);
  } catch {
    // Without them the offline page still shows its plain message.
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).then(() => offlineAssets(c))).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  // Build files: hashed names never change, so a kept copy is always right. Nothing else is kept.
  if (req.url.includes(STATIC)) {
    event.respondWith(
      caches.match(req.url).then((hit) => hit || fetch(req).then((res) => {
        if (res && res.ok) caches.open(CACHE).then((c) => c.put(req.url, res.clone())).catch(() => undefined);
        return res;
      })),
    );
    return;
  }
  // Only full page loads otherwise; data, actions and other assets go to the network untouched.
  if (req.mode !== "navigate") return;
  event.respondWith(fetch(req).catch(() => caches.match("/offline").then((r) => r || Response.error())));
});
