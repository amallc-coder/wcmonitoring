/* Clinilytics — Wound Care · service worker (offline app shell) */
var CACHE = "clinilytics-v4";
var SHELL = ["./", "./index.html", "./manifest.json"];

self.addEventListener("install", function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL).catch(function () {}); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { if (k !== CACHE) return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  // Never cache API responses — they carry PHI and must not persist in Cache Storage.
  if (url.pathname.indexOf("/api/") >= 0) return; // pass through to network, no caching

  var sameOrigin = url.origin === self.location.origin;
  var isHTML = req.mode === "navigate"
    || (req.headers.get("accept") || "").indexOf("text/html") >= 0
    || url.pathname === "/" || url.pathname.slice(-1) === "/" || url.pathname.indexOf("index.html") >= 0;

  // App shell / HTML: NETWORK-FIRST so the latest deployed version always loads when online;
  // fall back to cache only when offline. (Prevents being stuck on a stale cached build.)
  if (sameOrigin && isHTML) {
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.status === 200) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
        return res;
      }).catch(function () {
        return caches.match(req).then(function (cached) { return cached || caches.match("./index.html") || caches.match("./"); });
      })
    );
    return;
  }

  // Other same-origin assets: cache-first with background refresh (works offline).
  if (sameOrigin) {
    e.respondWith(
      caches.match(req).then(function (cached) {
        var net = fetch(req).then(function (res) {
          if (res && res.status === 200) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
          return res;
        }).catch(function () { return cached; });
        return cached || net;
      })
    );
    return;
  }

  // Cross-origin (CDN libs/fonts): stale-while-revalidate, best-effort.
  e.respondWith(
    caches.match(req).then(function (cached) {
      var net = fetch(req).then(function (res) {
        if (res && (res.status === 200 || res.type === "opaque")) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
        return res;
      }).catch(function () { return cached; });
      return cached || net;
    })
  );
});
