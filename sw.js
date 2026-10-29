// Offline support: the app itself is cached so it opens without a connection.
// Map tiles and street downloads always go to the network.
const CACHE = 'walktracker-v11';
const SHELL = [
  './', 'index.html', 'css/style.css', 'js/app.js', 'js/geo.js', 'js/gpx.js', 'js/db.js', 'js/power.js', 'js/stats.js', 'js/mapview.js', 'js/config.js', 'js/city.js', 'js/awake.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

// Mapbox GL JS comes from Mapbox's CDN. These URLs are pinned to one version,
// so they never change and can be served from the cache.
const MAPBOX_LIB = [
  'https://api.mapbox.com/mapbox-gl-js/v3.33.0/mapbox-gl.js',
  'https://api.mapbox.com/mapbox-gl-js/v3.33.0/mapbox-gl.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll([...SHELL, ...MAPBOX_LIB.map((u) => new Request(u, { mode: 'cors' }))]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first for our own files (so updates show up), cache as fallback when offline.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (MAPBOX_LIB.includes(e.request.url)) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
