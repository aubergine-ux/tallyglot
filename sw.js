// Service worker: makes Tallyglot installable and usable offline.
//
// Everything on this origin is fetched from the network first, so a deploy is
// picked up at once; the copy in the cache answers when the network does not
// (or takes longer than a few seconds). Requests to translation platforms are
// not touched: the app keeps its own cache of those in localStorage.

const VERSION = '2.0.0';
const CACHE = `tallyglot-${VERSION}`;
const TIMEOUT = 4000;

// The app shell, cached on install so the first offline visit already works.
// Pages and data are added to the cache as they are used.
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'assets/styles.css',
  'assets/pages.css',
  'assets/icon.svg',
  'assets/icon-192.png',
  'locales/index.json',
  'locales/en.json',
  'src/api.js',
  'src/app.js',
  'src/badge.js',
  'src/core.js',
  'src/i18n.js',
  'src/presets.js',
  'src/store.js',
  'src/ui.js',
  'src/platforms/crowdin.js',
  'src/platforms/index.js',
  'src/platforms/lokalise.js',
  'src/platforms/pontoon.js',
  'src/platforms/shared.js',
  'src/platforms/transifex.js',
  'src/platforms/weblate.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // One missing file must not stop the install: add them one by one.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('tallyglot-') && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  // The page address may carry ?view=…; every one of them is the same shell.
  const key = request.mode === 'navigate' ? './' : request;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const response = await fetch(request, { signal: controller.signal });
    if (response.ok) cache.put(key, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(key, { ignoreSearch: request.mode === 'navigate' });
    if (cached) return cached;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(request));
});
