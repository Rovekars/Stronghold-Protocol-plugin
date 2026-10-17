/* Stronghold Protocol — service worker.
 * Purpose: make the client immune to flaky system proxies that intermittently hijack requests to the
 * game server (rendered as the "无法启用 3D / WebGL" fallback toast, missing avatars, failed module imports).
 * Strategy: EVERY same-origin GET is network-first with a cached fallback (the SW exists only as an offline
 * / proxy-hijack safety net, never as a speed layer). v2: the old stale-while-revalidate path for /js//shared/
 * served one version behind on every reload (a stale first paint, fresh only on the NEXT reload), which made
 * client updates appear to "not apply" — all code paths now go network-first so a single normal reload is enough.
 * WebSocket / healthz / cross-origin are untouched. No cache = plain passthrough (behaviour identical to no SW).
 */
const CACHE = 'sp-cache-v2';

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    } catch { /* ignore */ }
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (!req || req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  const p = url.pathname;
  if (p === '/healthz' || p.startsWith('/ws')) return; // never touch the live wire

  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      try { const c = await caches.open(CACHE); c.put(req, fresh.clone()); } catch { /* ignore */ }
      return fresh;
    } catch {
      const hit = await caches.match(req);
      if (hit) return hit;
      return new Response('', { status: 504, statusText: 'offline' });
    }
  })());
});
