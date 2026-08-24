// Service Worker: офлайн-шелл для PWA.
// Стратегии:
//   - навигация (HTML)  — network-first, фолбэк на кэш (офлайн-старт)
//   - статика (js/css/svg/png/manifest) — stale-while-revalidate
//   - /api/* и кросс-доменные запросы (campus.syktsu.ru) — НЕ перехватываются:
//     данные офлайн и так берутся из localStorage-кэшей app.js, а кэшировать
//     API в SW поверх CDN-кэша воркера — лишний риск протухания.
//
// ⚠️ СОПРОВОЖДЕНИЕ: app.js/style.css не содержат хэшей в имени файла, поэтому
// ПРИ КАЖДОМ изменении статики бампать SW_VERSION — это единственный механизм
// инвалидации прекэша. ВМЕСТЕ с ним бампать '?v=' в register('/sw.js?v=…')
// в app.js (зонный дефолт CF на кастомном домене кэширует .js на 4 ч —
// свежий query обходит и HTTP-кэш, и edge). Новая версия подхватывается
// при следующем заходе (skipWaiting без уведомлений — осознанно).
const SW_VERSION = 'v2';
const CACHE_NAME = `shell-${SW_VERSION}`;

const PRECACHE = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Кросс-домен (campus.syktsu.ru) и /api/* — мимо SW.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Навигация: сеть прежде всего, при офлайне — закэшированный шелл.
  // В кэш кладём ТОЛЬКО успешные ответы (res.ok): иначе 404/5xx от Pages
  // перезаписали бы '/index.html' и офлайн-фолбэк показал бы ошибку вместо шелла.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME)
              .then((c) => c.put('/index.html', copy))
              .catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Статика: stale-while-revalidate — мгновенно из кэша, обновление в фоне.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME)
              .then((c) => c.put(req, copy))
              .catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
