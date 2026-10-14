/* Service worker: lets phones install the map to the home screen and reopen it offline.
   Pages and data are network-first (always the latest when online; the last copy when offline).
   Versioned static files are cache-first. Weather and other sites are never cached here. */
var VERSION = "__VERSION__";
var CACHE = "shadehop-" + VERSION;

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.add("./"); })
    .catch(function () { /* offline install: cache as pages are visited */ }));
  self.skipWaiting();
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf("shadehop-") === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function networkFirst(req) {
  return fetch(req).then(function (res) {
    if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
    return res;
  }).catch(function () {
    return caches.match(req, { ignoreSearch: req.mode === "navigate" }).then(function (hit) { return hit || caches.match("./"); });
  });
}

function cacheFirst(req) {
  return caches.match(req).then(function (hit) {
    return hit || fetch(req).then(function (res) {
      if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      return res;
    });
  });
}

self.addEventListener("fetch", function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;  // map tiles, Google, etc.
  if (url.pathname.indexOf("/api/weather") >= 0) return;                     // always live
  if (url.pathname.indexOf("/static/") >= 0) { e.respondWith(cacheFirst(req)); return; }
  e.respondWith(networkFirst(req));
});
