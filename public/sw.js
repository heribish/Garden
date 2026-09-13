/* garden PWA shell — network-first for pages, cache static assets for offline open */
const CACHE = "garden-v3";
const PRECACHE = [
  "/",
  "/shop",
  "/account",
  "/vendor",
  "/driver",
  "/admin",
  "/manifest.webmanifest",
  "/assets/tzshop.css",
  "/assets/tzshop.js",
  "/assets/i18n.js",
  "/assets/location.js",
  "/assets/support-widget.js",
  "/assets/favicon.svg",
  "/assets/icon-192.png",
  "/assets/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isApi(url) {
  return url.pathname.startsWith("/api/");
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (isApi(url)) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match("/shop")))
  );
});
