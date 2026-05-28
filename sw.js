// Fruitality service worker — offline-first cache for the prototype.
const CACHE = 'fruitality-prototype-v3';
const ASSETS = [
  '/',
  'index.html',
  'play.html',
  'play3d.html',
  'manifest.webmanifest',
  'assets/master-roster.png',
  'assets/watermelon.png',
  'assets/banana.png',
  'assets/pineapple.png',
  'assets/durian.png',
  'assets/kiwi.png',
  'assets/coconut.png',
  'assets/title-logo.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      c.addAll(ASSETS).catch(() => null)   // best-effort; failures don't break install
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(resp => {
      if (!resp || resp.status !== 200 || resp.type !== 'basic') return resp;
      const clone = resp.clone();
      caches.open(CACHE).then(c => c.put(req, clone)).catch(() => {});
      return resp;
    }).catch(() => cached))
  );
});
