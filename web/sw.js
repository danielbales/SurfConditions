const CACHE_NAME = 'surf-conditions-v57';
const WORKER_URL = 'https://surf-alerts.dbales1210.workers.dev';
const APP_SHELL = [
  '/SurfConditions/',
  '/SurfConditions/index.html',
  '/SurfConditions/style.css',
  '/SurfConditions/spot-stations.js',
  '/SurfConditions/app.js',
  '/SurfConditions/manifest.json',
  '/SurfConditions/icons/icon-192.png',
  '/SurfConditions/icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const isAppShell = url.hostname === self.location.hostname;

  if (isAppShell) {
    // Network-first for app shell: always fetch fresh, fall back to cache offline
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
  } else {
    // Network-first for API calls too
    event.respondWith(
      fetch(event.request)
        .catch(() => new Response(JSON.stringify({ error: 'offline' }), {
          headers: { 'Content-Type': 'application/json' }
        }))
    );
  }
});

// ─── Push Notifications ───────────────────────────────────────────────────────
function showSurfNotification(note) {
  const title = note?.title || '🌊 Surf Alert';
  const body = note?.body || 'Check conditions now';
  return self.registration.showNotification(title, {
    body,
    icon: '/SurfConditions/icons/icon-192.svg',
    badge: '/SurfConditions/icons/icon-192.svg',
    // Each beach gets its own tag so two alerts can both stay on screen.
    tag: note?.tag || 'surf-alert',
    renotify: true,
    vibrate: [200, 100, 200],
  });
}

self.addEventListener('push', event => {
  let payload = null;
  try {
    if (event.data) payload = event.data.json();
  } catch (e) {}

  if (payload?.title) {
    event.waitUntil(showSurfNotification(payload));
    return;
  }

  // Older alerts had an empty body. Fall back to the last stored message.
  event.waitUntil(
    fetch(`${WORKER_URL}/alert`)
      .then(r => r.json())
      .then(showSurfNotification)
      .catch(() => showSurfNotification({
        title: '🌊 Surf Alert',
        body: 'Good conditions — open Waves to check',
      }))
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
      const match = cs.find(c => c.url.includes('/SurfConditions'));
      return match ? match.focus() : clients.openWindow('/SurfConditions/');
    })
  );
});
