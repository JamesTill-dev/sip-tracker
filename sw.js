/* Sip Tracker — service worker
 *
 * Strategy: precache the small static shell on install, then
 * serve cache-first with a network fallback. Any failed
 * navigation falls back to the cached index.html so the PWA
 * keeps opening offline.
 *
 * Bump CACHE whenever the precache list or any cached asset
 * changes — the activate step deletes every other cache. */

const CACHE = 'sip-v4';

// Relative paths so the app works from any subdirectory
// (GitHub Pages user/project sites, local file servers, etc.).
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './dexie.min.js',
  './supabase.js',
  // Supabase JS SDK — cross-origin, CORS-enabled, opaque-safe.
  // Lets cloud sync work offline after the first online load.
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

self.addEventListener('install', event => {
  // Tolerant install: cache each asset individually so a missing
  // optional file (e.g. supabase.js on a fresh clone) doesn't
  // brick the whole PWA installation.
  event.waitUntil(
    caches.open(CACHE).then(async cache => {
      await Promise.all(ASSETS.map(url =>
        cache.add(url).catch(err => console.warn('[sw] skipped', url, err))
      ));
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Never cache or intercept Supabase API calls — they're the
  // online-only side of sync and must always go to the network.
  const url = new URL(req.url);
  if (url.hostname.endsWith('.supabase.co')) return;

  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).catch(() => {
        // Offline + uncached: for top-level navigations, return
        // the app shell so the PWA still opens.
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      });
    })
  );
});
