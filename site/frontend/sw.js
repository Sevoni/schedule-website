// Service Worker: офлайн-шелл для PWA.
// Стратегии:
//   - навигация (HTML)  — network-first с таймаутом 5 с: если ответ не пришёл
//     за NAV_TIMEOUT_MS (офлайн, подвешивание РКН и т.п.) — отдаём кэш, а
//     сетевой запрос продолжается в фоне (event.waitUntil) и дописывает свежий
//     index.html в кэш, когда сеть всё-таки ответит (жёсткий предел —
//     NAV_BG_TIMEOUT_MS). В сеть ходим НОВЫМ запросом fetch(req.url): у
//     оригинального навигационного req redirect mode = "manual", и редирект
//     перехвата РКН превращался бы в opaqueredirect с ошибкой вкладки;
//     перехват детектим (opaqueredirect/чужой origin) и уходим в кэш.
//     Без кэша (первый визит/вытеснение) — ожидание сети ограничено
//     NAV_NOCACHE_TIMEOUT_MS (15 с), дальше честный 503. respondWith
//     всегда резолвится в Response (финальный .catch) — навигация никогда не
//     падает в ошибку браузера из-за SW. В кэш — только same-origin без
//     редиректов, чтобы заглушка перехвата не отравила шелл.
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
const SW_VERSION = 'v20';
const CACHE_NAME = `shell-${SW_VERSION}`;

// Навигация: сколько ждать сеть, прежде чем отдать кэш (5 с — TTFB Cloudflare
// даже на 3G обычно до 3,5 с; подвешивание РКН висит десятки секунд).
const NAV_TIMEOUT_MS = 5000;
// Жёсткий предел фоновой догрузки: вечно висящий fetch не должен держать SW.
const NAV_BG_TIMEOUT_MS = 30000;
// Предел ожидания сети, когда кэша НЕТ вообще (первый визит / вытеснен):
// дальше — честный 503, а не вечный спиннер (жёсткий abort — NAV_BG_TIMEOUT_MS).
const NAV_NOCACHE_TIMEOUT_MS = 15000;

const CRITICAL = ['/', '/index.html', '/app.js?v=v20', '/style.css?v=v20'];
const OPTIONAL = ['/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      const crit = await Promise.allSettled(CRITICAL.map((url) => cache.add(url)));
      await Promise.allSettled(OPTIONAL.map((url) => cache.add(url)));
      // skipWaiting — ТОЛЬКО если весь критический шелл закэширован.
      // Иначе (обновление на рваной сети) новый SW остался бы с дырявым
      // кэшем, а activate снёс бы старый рабочий — офлайн бы умер.
      // Без skipWaiting браузер сам повторит install при следующей навигации.
      if (crit.every((r) => r.status === 'fulfilled')) {
        self.skipWaiting();
      }
    })
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

  // Навигация: сеть прежде всего, но не дольше NAV_TIMEOUT_MS — иначе
  // подвешенный запрос (РКН, чёрная дыра) никогда не дойдёт до .catch().
  // ВАЖНО: ходим в сеть НОВЫМ запросом fetch(req.url), а не оригинальным
  // fetch(req): у навигационного req redirect mode = "manual", и ответ
  // с редиректом (перехват РКН/оператора без VPN) превращался бы в
  // opaqueredirect — отдача его в respondWith роняла вкладку в ошибку
  // браузера ("redirected response ... redirect mode is not follow").
  // У свежего запроса редиректы следуются, а перехват мы детектим ниже
  // (opaqueredirect / чужой финальный origin) и уходим в кэш.
  // В кэш кладём ТОЛЬКО своё (same-origin), успешное (res.ok) и без
  // редиректов: иначе заглушка РКН отравила бы '/index.html', а 404/5xx
  // от Pages показали бы ошибку вместо шелла.
  // Гарантия: respondWith всегда резолвится в Response — финальный .catch
  // отдаёт 503-текст, а не роняет навигацию в ошибку браузера.
  if (req.mode === 'navigate') {
    const ctrl = new AbortController();
    const hardStop = setTimeout(() => ctrl.abort(), NAV_BG_TIMEOUT_MS);

    const network = fetch(req.url, { signal: ctrl.signal }).then((res) => {
      if (!res || res.type === 'opaqueredirect') {
        // Перехват с редиректом — идём в сохранённый кэш.
        throw new Error('redirect-intercept');
      }
      let sameOrigin = false;
      try {
        sameOrigin = new URL(res.url).origin === self.location.origin;
      } catch (e) { /* кривой URL — считаем чужим */ }
      if (!sameOrigin) {
        // Финальный адрес чужой (страница-заглушка): в кэш не кладём
        // и браузеру её не отдаём — фолбэк в сохранённый шелл.
        throw new Error('cross-origin-final');
      }
      if (res.ok && !res.redirected) {
        const copy = res.clone();
        caches.open(CACHE_NAME)
          .then((c) => c.put('/index.html', copy))
          .catch(() => {});
      }
      return res;
    });

    // Гонка: ответ сети против таймера NAV_TIMEOUT_MS.
    const TIMED_OUT = Symbol('timed-out');
    const settled = new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(TIMED_OUT), NAV_TIMEOUT_MS);
      network.then(
        (res) => { clearTimeout(timer); resolve(res); },
        (err) => { clearTimeout(timer); reject(err); }
      );
    });

    // Фоновая догрузка: SW остаётся живым, пока fetch не завершится —
    // свежий index.html допишется в кэш даже после отдачи кэша по таймауту.
    event.waitUntil(
      network.then(() => {}, () => {}).finally(() => clearTimeout(hardStop))
    );

    const offlineResponse = () => new Response('Нет соединения', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });

    const fromCache = () => caches.match('/index.html').then((cached) => {
      if (cached) return cached;
      // Кэша нет (первый визит / вытеснен): ждём сеть, но не дольше
      // NAV_NOCACHE_TIMEOUT_MS — иначе вечный спиннер вместо честной ошибки.
      return Promise.race([
        network,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('no-cache-timeout')), NAV_NOCACHE_TIMEOUT_MS
        )),
      ]).catch(() => offlineResponse());
    });

    event.respondWith(
      settled.then(
        (res) => (res === TIMED_OUT ? fromCache() : res),
        () => fromCache()
      ).catch(() => offlineResponse())
    );
    return;
  }

  // Статика: stale-while-revalidate — мгновенно из кэша, обновление в фоне.
  // Если кэша нет, а сеть мертва/висит — отдаём 503, а не undefined
  // (respondWith(undefined) роняет запрос в ошибку браузера).
  // В кэш кладём только своё (same-origin) без редиректов — заглушка
  // перехвата не должна перезаписать app.js/style.css.
  const putIfClean = (reqToPut, res) => {
    if (!res || !res.ok || res.redirected) return;
    try {
      if (new URL(res.url).origin !== self.location.origin) return;
    } catch (e) { return; }
    const copy = res.clone();
    caches.open(CACHE_NAME)
      .then((c) => c.put(reqToPut, copy))
      .catch(() => {});
  };
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        fetch(req)
          .then((res) => putIfClean(req, res))
          .catch(() => {});
        return cached;
      }
      return Promise.race([
        fetch(req).then((res) => {
          putIfClean(req, res);
          return res;
        }),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('static-timeout')), NAV_NOCACHE_TIMEOUT_MS
        )),
      ]).catch(() => offlineResponse());
    }).catch(() => offlineResponse())
  );
});
