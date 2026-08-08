/* Offline-First Service Worker.
   Die App-Shell wird bei der Installation vollständig vorgeladen. Danach läuft
   Moto Mode ohne jede Netzverbindung — GPS-Tacho, Lautstärke-Logik und Ansagen
   brauchen kein Internet. Nur Kartendienste und Spotify tun das. */

const VERSION = 'moto-v17';
const TILE_HOSTS = ['tiles.openfreemap.org', 'tiles.versatiles.org'];
const TILE_CACHE = 'moto-tiles-v1';
const TILE_LIMIT = 2500;
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/app.js',
  'js/store.js',
  'js/gps.js',
  'js/limits.js',
  'js/nav.js',
  'js/poi.js',
  'js/phrases.js',
  'js/sun.js',
  'js/overpass.js',
  'js/map.js',
  'vendor/maplibre-gl.js',
  'vendor/maplibre-gl.css',
  'js/audio.js',
  'js/spotify.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== VERSION && k !== TILE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function cacheFirstTile(request) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (res.ok) {
      cache.put(request, res.clone());
      trimTiles(cache);
    }
    return res;
  } catch (err) {
    return hit || Response.error();
  }
}

/* Grob begrenzen, damit der Kachelcache nicht unbemerkt wächst. */
let trimming = false;
async function trimTiles(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    if (keys.length > TILE_LIMIT) {
      await Promise.all(keys.slice(0, keys.length - TILE_LIMIT).map((k) => cache.delete(k)));
    }
  } finally {
    trimming = false;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Kartenkacheln: erst Cache, dann Netz — so bleiben gefahrene Gegenden
  // auch ohne Verbindung sichtbar.
  if (TILE_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirstTile(request));
    return;
  }
  if (url.origin !== self.location.origin) return;   // Spotify, Valhalla & Co. durchreichen

  // Navigationen: immer die gecachte Shell ausliefern, Netz nur als Bonus.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match('index.html').then((hit) => hit || fetch(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) {
        // Im Hintergrund auffrischen, ohne den Start zu verzögern.
        fetch(request).then((res) => {
          if (res.ok) caches.open(VERSION).then((c) => c.put(request, res.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(request).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(request, copy));
        }
        return res;
      });
    })
  );
});
