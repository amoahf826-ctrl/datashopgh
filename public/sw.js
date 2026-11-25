const CACHE_NAME = 'cheapdatabundle-shell-v2';
const APP_SHELL = ['/', '/app.webmanifest', '/cheapdatabundle-logo.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) {
        event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put('/', response.clone())));
      }
      return response;
    }).catch(async () => (await caches.match('/')) || Response.error()));
    return;
  }
  if (request.destination === 'image' || request.url.endsWith('/app.webmanifest')) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
      return response;
    })));
  }
});
