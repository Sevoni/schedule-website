import { createStore, setRequestLogger } from './store.js';

// Нормализация названия группы: trim + toLowerCase.
// Campus.syktsu.ru принимает любой регистр, но в БД храним всегда нижний,
// чтобы "131-Ибо" и "131-ИБо" не создавали разные записи.
function normalizeGroup(g) {
  return (g || '').trim().toLowerCase();
}

// Разбор мета-записи группы `campus-updated:{group}`.
// Новый формат — JSON { campusUpdatedAt, lastSync, lastWeek } (все строки или
// null). Легаси-формат — голая строка даты кампуса (без JSON) — мигрируется
// на лету: возвращаем объект только с campusUpdatedAt, остальные поля null.
// Первая же запись после обновления перепишет ключ в JSON.
function parseCampusMeta(raw) {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') {
      return {
        campusUpdatedAt: j.campusUpdatedAt || null,
        lastSync: j.lastSync || null,
        lastWeek: j.lastWeek || null,
      };
    }
  } catch (e) { /* не JSON — легаси-строка, обрабатываем ниже */ }
  return { campusUpdatedAt: raw, lastSync: null, lastWeek: null };
}

// ── Валидация формата группы и weekCode (серверная) ────────────
// Группа: 3 цифры, опциональная буква, дефис, 3-4 буквы (пример: "131-ИБо",
// "131-ИБ"). Сервер работает с lowercase-строками (см. normalizeGroup),
// поэтому regex написан на lowercase-строку и совпадает по смыслу с
// GROUP_RE на фронте (app.js).
const GROUP_RE = /^\d{3}[а-яё]?-[а-яё]{3,4}$/;

function isValidGroup(g) {
  return typeof g === 'string' && GROUP_RE.test(g);
}

// weekCode: "<номер недели>_<группа в lowercase>" (например "50_131-ибо")
// либо специальное значение 'current' (пустой week → 'current').
const WEEK_CODE_RE = /^\d{1,3}_[a-z0-9а-яё-]{2,30}$/;

function isValidWeekCode(w) {
  return typeof w === 'string' && (w === 'current' || WEEK_CODE_RE.test(w));
}

// Проверка привязки weekCode к группе: часть после '_' должна совпадать с
// (lowercase) группой. Защищает от загрязнения пространства ключей
// schedule:{group}:* чужими weekCode — writer группы A не сможет записать
// weekCode с группой B (см. handleUpload / handleSyncFromCampus).
// Спецзначение 'current' (легаси-ключ schedule:{group}:current) пропускается.
function weekCodeMatchesGroup(weekCode, group) {
  if (weekCode === 'current') return true;
  if (!isValidWeekCode(weekCode) || !group) return false;
  return weekCode.endsWith('_' + group);
}

// ════════════════════════════════════════════════════════════════
// ── Single-flight / per-key mutex ────────────────────────────────
// Сериализует read-modify-write циклы (get → modify → put) по одному ключу
// внутри isolate'а Cloudflare Worker. Worker обрабатывает запросы без
// многопоточности (кооперативная concurrency через await), поэтому цепочки
// промисов достаточно для взаимного исключения: глобальная Map обещаний
// персистентна в рамках isolate. Блокировка покрывает весь read→modify→write
// цикл (D1-запись асинхронная), что исключает потерю данных при параллельных
// запросах из разных вкладок/вебхуков. Защита от зависания — таймаут (по
// умолчанию 30с): если критический участок не завершился, блокировка всё
// равно освобождается, а вызов получает ошибку. Ошибка fn освобождает
// блокировку через finally, не блокируя следующих в очереди.
//
// ⚠️ ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ (VULN-005): при таймауте Promise.race возвращает
// ошибку и освобождает lock, НО fn() не отменяется — он продолжает
// выполняться в фоне («зомби») параллельно со следующим запросом по тому же
// ключу. Отменить fn() невозможно: D1 не поддерживает AbortController /
// AbortSignal (см. store.js — ни один метод не принимает signal и не
// прокидывает его в db.prepare(...)), а fn() здесь — только неотменяемые
// D1-записи. Принято как допустимое: таймаут 30с щедрый (D1-операции по
// одному ключу — миллисекунды), а все критические участки (hw:/inv-by-group:/
// tg:subs:/tg:groups:) делают только D1-записи без внешних side-эффектов —
// TG-уведомления и purge CDN вынесены ВНЕ блоков withKeyLock. Не пытайтесь
// «исправить» это добавлением AbortController — он не сработает для D1.
const KEY_LOCKS = new Map();

async function withKeyLock(key, fn, timeoutMs = 30000) {
  const prev = KEY_LOCKS.get(key) || Promise.resolve();
  let release;
  const tail = new Promise((res) => { release = res; });
  const chain = prev.then(() => tail);
  KEY_LOCKS.set(key, chain);
  try {
    // Ждём освобождения предыдущего критического участка (разрешение его tail).
    await prev;
    let timer = null;
    const timeoutP = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`key lock timeout: ${key}`)), timeoutMs);
    });
    try {
      return await Promise.race([fn(), timeoutP]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } finally {
    release();
    if (KEY_LOCKS.get(key) === chain) KEY_LOCKS.delete(key);
  }
}

// ── Валидация/санитизация данных при заливке (defense in depth) ─────────
// Фронтенд экранирует вывод (escHtml), но writer'ы присылают произвольный
// JSON. Здесь «мягко» приводим поля к ожидаемой форме: строки обрезаем и
// удаляем управляющие символы, не-строковые значения отбрасываем, лишние
// ключи выкидываем. Злонамеренная разметка <img onerror=...> переживает
// заливку, но рендерится как текст (фронт скейпит), а источник в базе —
// без исполняемых тегов.

function sanitizeString(v, maxLen = 200) {
  if (typeof v === 'number') v = String(v);
  if (typeof v !== 'string') return '';
  return v.slice(0, maxLen).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

// Санитизация campusUpdatedAt (метка времени обновления кампуса).
// Ожидаемый формат — ISO-дата "yyyy-MM-ddTHH:mm:ss" (локальное время кампуса)
// с возможными суффиксами ".mmm" / "Z" / "+hh:mm" — см. extractCampusUpdatedAt
// и parseCampusUpdatedAtTs на фронте; легаси-строки кампуса в том же формате
// проходят как есть. Мусор (произвольные строки, гигантские значения,
// управляющие символы) отбрасываем — возвращаем null, чтобы вызывающий код
// не записал его в мету группы.
function sanitizeCampusUpdatedAt(v) {
  if (typeof v !== 'string') return null;
  const s = sanitizeString(v, 64).trim();
  if (!s) return null;
  const ok = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(s);
  return ok ? s : null;
}

// Лимиты санитизации списка предметов (POST /api/subjects), чтобы нельзя было
// залить гигантские объекты/массивы.
const MAX_SUBJECTS = 300;         // максимум элементов в списке
const MAX_SUBJECT_TYPES = 20;     // максимум pairTypes у одного предмета
const MAX_SUBGROUP_CODES = 10;    // максимум кодов подгрупп на один тип
const SUBJECT_SUBGROUP_RE = /^[12]$/; // допустимые коды подгрупп: "1" / "2"

// Whitelist-санитизация массива предметов subjects:{group}:{sem}.
// Валидный элемент (см. serializeSubjects / computeWeekSubjects, и тот же
// формат на фронте в app.js):
//   { subject: string, pairTypes: [code...], subgroups: { [code]: [code...] } }
// Невалидные элементы отбрасываем, строки ограничиваем по длине и чистим от
// управляющих символов, типы пар — только из ALLOWED_PAIR_TYPES, коды подгрупп
// — только "1"/"2". Семантика валидных данных не меняется.
function sanitizeSubjects(subjects) {
  if (!Array.isArray(subjects)) return [];
  const out = [];
  for (const s of subjects) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
    const subject = sanitizeString(s.subject, 200).trim();
    if (!subject) continue;

    const pairTypes = [];
    const seenTypes = new Set();
    for (const t of Array.isArray(s.pairTypes) ? s.pairTypes : []) {
      const ts = sanitizeString(t, 20);
      if (ALLOWED_PAIR_TYPES.has(ts) && !seenTypes.has(ts)) {
        seenTypes.add(ts);
        pairTypes.push(ts);
        if (pairTypes.length >= MAX_SUBJECT_TYPES) break;
      }
    }

    const subgroups = {};
    if (s.subgroups && typeof s.subgroups === 'object' && !Array.isArray(s.subgroups)) {
      for (const [k, codes] of Object.entries(s.subgroups)) {
        const kk = sanitizeString(k, 20);
        if (!ALLOWED_PAIR_TYPES.has(kk)) continue; // не-whitelist тип — пропускаем
        if (!Array.isArray(codes)) continue;
        const cleanCodes = [];
        const seen = new Set();
        for (const c of codes) {
          const cs = sanitizeString(c, 10);
          if (SUBJECT_SUBGROUP_RE.test(cs) && !seen.has(cs)) {
            seen.add(cs);
            cleanCodes.push(cs);
            if (cleanCodes.length >= MAX_SUBGROUP_CODES) break;
          }
        }
        if (cleanCodes.length) subgroups[kk] = cleanCodes;
      }
    }

    out.push({ subject, pairTypes, subgroups });
    if (out.length >= MAX_SUBJECTS) break;
  }
  return out;
}

const SCHEDULE_PAIR_KEYS = ['subject', 'teacher', 'room', 'type', 'subgroup', 'num', 'time'];

const ALLOWED_PAIR_TYPES = new Set(['л', 'пр', 'пз', 'лаб', 'с', 'зчО', 'зач', 'экз']);

// Допустимые значения enum-полей домашнего задания. В отличие от расписания,
// в ДЗ дополнительно разрешён 'any' («любой тип пары» / «обе подгруппы») —
// это значение по умолчанию, которое шлёт фронтенд. Пустая строка тоже
// допустима: handleAddHw приводит её к 'any' через `clean.pairType || 'any'`,
// а браузер при редактировании записи с невалидным значением (старые грязные
// данные) не находит опцию в <select> и отправляет именно ''.
const ALLOWED_HW_PAIR_TYPES = new Set(['л', 'пр', 'пз', 'лаб', 'с', 'зчО', 'зач', 'экз', 'any']);
const ALLOWED_HW_SUBGROUPS = new Set(['1', '2', 'any']);

function sanitizePair(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const out = {};
  for (const k of SCHEDULE_PAIR_KEYS) {
    if (p[k] === undefined || p[k] === null) continue;
    if (k === 'num') {
      const n = parseInt(p[k], 10);
      if (Number.isFinite(n) && n >= 1 && n <= 8) out[k] = n;
      continue;
    }
    if (k === 'time') {
      const t = sanitizeString(p[k], 10);
      if (/^\d{1,2}:\d{2}$/.test(t)) out[k] = t;
      continue;
    }
    if (k === 'type') {
      const t = sanitizeString(p[k], 20);
      if (ALLOWED_PAIR_TYPES.has(t)) out[k] = t;
      continue;
    }
    const s = sanitizeString(p[k]);
    if (s !== '') out[k] = s;
  }
  return out;
}

function sanitizeDay(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const out = {};
  if (d.date != null) out.date = sanitizeString(d.date, 40);
  out.pairs = Array.isArray(d.pairs)
    ? d.pairs.map(sanitizePair).filter((x) => x !== null)
    : [];
  return out;
}

// Защита от прототип-загрязнения: не берём служебные ключи дней.
const RESERVED_DAY_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function sanitizeScheduleData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const out = {};
  if (data.group != null) out.group = sanitizeString(data.group, 100);
  if (data.weekStart != null) out.weekStart = sanitizeString(data.weekStart, 40);
  if (data.weekEnd != null) out.weekEnd = sanitizeString(data.weekEnd, 40);
  out.days = {};
  if (data.days && typeof data.days === 'object' && !Array.isArray(data.days)) {
    for (const [dayName, dayData] of Object.entries(data.days)) {
      if (RESERVED_DAY_KEYS.has(dayName)) continue;
      const clean = sanitizeDay(dayData);
      if (clean) out.days[sanitizeString(dayName, 40)] = clean;
    }
  }
  return out;
}

function sanitizeWeeks(weeks, group) {
  if (!Array.isArray(weeks)) return null;
  const out = weeks
    .map((w) => {
      if (!w || typeof w !== 'object' || Array.isArray(w)) return null;
      // Допустимый weekCode для списка недель: реальная неделя по WEEK_CODE_RE
      // (не спецзначение 'current') И привязанная к этой группе (часть после
      // '_' === group). Мусорные значения и weekCode чужой группы молча
      // отбрасываем — так же, как это делают GET-пути (isValidWeekCode).
      // Это защищает weeks:{group} от само-загрязнения произвольными ключами.
      if (!w.value || typeof w.value !== 'string' || !WEEK_CODE_RE.test(w.value) || !weekCodeMatchesGroup(w.value, group)) {
        return null;
      }
      const rec = {};
      rec.value = sanitizeString(w.value, 60);
      if (w.text != null) rec.text = sanitizeString(w.text, 250);
      return rec;
    })
    .filter((w) => w !== null);
  // Если после фильтрации не осталось ни одной валидной недели — считаем
  // payload невалидным (не сохраняем пустой/мусорный список weeks).
  return out.length ? out : null;
}

function sanitizeHwFields(body) {
  const out = {};
  for (const k of ['subject', 'author']) {
    if (body[k] != null) out[k] = sanitizeString(body[k], k === 'subject' ? 200 : 100);
  }
  if (body.task != null) out.task = sanitizeString(body.task, 5000);
  if (body.pairType != null) out.pairType = sanitizeString(body.pairType, 20);
  if (body.subgroup != null) out.subgroup = sanitizeString(body.subgroup, 10);
  if (body.dueDate != null) out.dueDate = sanitizeString(body.dueDate, 40);
  return out;
}

// Валидация dueDate для ДЗ с dueMode='date'. Единственный допустимый формат —
// строгая локальная дата "YYYY-MM-DD" (именно так её формирует календарь на
// фронте, formatDateISO, и именно в этом формате сервер пересчитывает nextPair
// в findNextPairDate). Проверяем реальную календарную дату: месяц 01-12, день
// 01-31 с учётом числа дней в месяце и високосных годов (февраль 28/29).
// Разумный диапазон года (1900-9999) отсекает мусор вроде "0000-01-01".
// Возвращает нормализованную строку "YYYY-MM-DD" или null (невалидно/мусор).
function sanitizeDueDate(v) {
  if (typeof v !== 'string') return null;
  const s = sanitizeString(v, 40).trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = +m[1], month = +m[2], day = +m[3];
  if (year < 1900 || year > 9999) return null;
  if (month < 1 || month > 12) return null;
  const leap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day < 1 || day > daysInMonth) return null;
  return s;
}

// Валидация enum-полей ДЗ (pairType / subgroup). Возвращает null, если оба поля
// отсутствуют (частичный PUT) или допустимы, иначе — строку с описанием ошибки
// (вызывающий код превращает её в 400). Пустая строка допустима: она означает
// «любой тип/подгруппа» и нормализуется в 'any' в handleAddHw / хранится как
// 'any'-эквивалент при обновлении. Значения нормализуем через sanitizeString
// (та же логика, что в sanitizeHwFields), чтобы число/мусор были строками.
function validateHwEnums(body) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return null;
  if (body.pairType != null) {
    const t = sanitizeString(body.pairType, 20);
    if (t !== '' && !ALLOWED_HW_PAIR_TYPES.has(t)) return `Invalid pairType "${t}"`;
  }
  if (body.subgroup != null) {
    const s = sanitizeString(body.subgroup, 10);
    if (s !== '' && !ALLOWED_HW_SUBGROUPS.has(s)) return `Invalid subgroup "${s}"`;
  }
  return null;
}

// ── Лимит размера тела запроса (анти-DoS) ──────────────────────
// Читаем JSON тела не целиком в память, а с жёстким лимитом по мере
// чтения потока. Возвращает:
//   { ok: true, json }                      — тело прочитано и распарсено
//   { ok: false, tooLarge: true }           — превышен MAX_BODY_BYTES → 413
//   { ok: false, parseError: true }         — битый JSON → 400
const MAX_BODY_BYTES = 1024 * 1024; // 1 МБ
const MAX_BATCH_SCHEDULES = 30; // sync-from-campus / schedule-batch (фронт шлёт ≤5)
const MAX_BATCH_HW_UPDATES = 500; // /api/hw/batch
const MAX_WEEKS_LIST = 300; // upload type=weeks
const MAX_WEEKS_PER_GET = 60; // максимум weekCode на /api/schedules и /api/bootstrap

async function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  if (!request.body) return { ok: true, json: {} };
  // CSRF-защита (JSON-smuggling): HTML-формы не умеют отправлять
  // Content-Type: application/json — только urlencoded/multipart/text/plain.
  // Отбиваем любое тело не-JSON, чтобы text/plain-форма не протащила
  // валидный JSON без CORS-preflight (enctype="text/plain").
  const ct = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') {
    return { ok: false, parseError: true };
  }
  const len = Number(request.headers.get('content-length') || 0);
  if (len > maxBytes) return { ok: false, tooLarge: true };
  const reader = request.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      return { ok: false, tooLarge: true };
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  try {
    return { ok: true, json: JSON.parse(new TextDecoder().decode(buf)) };
  } catch {
    return { ok: false, parseError: true };
  }
}

// ── Заголовки безопасности: применяются ко ВСЕМ /api/* ответам ─────────
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  // L10: COOP/CORP — защита от XS-Leaks и загрузки API в чужом контексте.
  // Для JSON-API CORP 'same-origin' безопасен (читается с того же origin;
  // CORS-клиентам вроде curl не мешает). preload в HSTS НЕ добавляем — он
  // требует регистрации в hstspreload.org (вне рамок кода).
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  // Идентично статике в frontend/_headers — API и Pages не противоречат.
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=()',
};

// ── CORS: строгая политика вместо Access-Control-Allow-Origin: * ────────
// Разрешаем только проверенные origin'ы: список из env-переменной
// ALLOWED_ORIGINS (через запятую) + preview-домены Cloudflare Pages
// (*.schedule-worker.pages.dev) — только при ALLOW_PREVIEW_CORS === 'true'
// (по умолчанию выключено: на проде "false", локально включается в .dev.vars).
// Same-origin и curl-запросы без Origin не требуют CORS — для них заголовков
// нет вообще.
const CORS_HEADER_NAMES = [
  'Access-Control-Allow-Origin',
  'Access-Control-Allow-Methods',
  'Access-Control-Allow-Headers',
  'Access-Control-Max-Age',
  'Vary',
];

function isAllowedOrigin(origin, env) {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    const extra = String(env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (extra.includes(u.origin)) return true;
    // Preview-домены Cloudflare Pages: https://<hash>.schedule-worker.pages.dev
    // Разрешены ТОЛЬКО при ALLOW_PREVIEW_CORS === 'true' (по умолчанию false).
    if (env.ALLOW_PREVIEW_CORS === 'true' && u.hostname.endsWith('.schedule-worker.pages.dev')) return true;
    return false;
  } catch {
    return false;
  }
}

// CORS-заголовки для конкретного запроса. Пустой объект = CORS запрещён.
function corsHeadersFor(request, env) {
  const origin = request.headers.get('Origin');
  if (!isAllowedOrigin(origin, env)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

// Снять CORS-заголовки с кэшируемой копии ответа (кэш не должен зависеть
// от Origin запроса — при отдаче из кэша они накладываются заново).
function stripCorsHeaders(headers) {
  for (const k of CORS_HEADER_NAMES) headers.delete(k);
  return headers;
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    // Случайный ID запроса: попадает в логи (console.error) и в ответ при
    // ошибке 500, чтобы можно было сопоставить жалобу пользователя с записью
    // в логах Cloudflare. Наружу уходит только безобидный ID, не детали.
    const requestId = crypto.randomUUID().slice(0, 8);

    // CORS вычисляется для каждого запроса: строгий whitelist вместо '*'.
    // Same-origin запросы и curl (без Origin) получают пустой набор — для
    // них CORS-заголовки не нужны. Security-заголовки — в securityHeaders,
    // они накладываются в jsonResponse на все ответы.
    const corsHeaders = corsHeadersFor(request, env);

    // ── Анти-DoS: быстрый отсев огромных тел по Content-Length ──
    // Полный контроль (в т.ч. chunked-запросов без Content-Length) — в
    // readJsonBody() при фактическом чтении каждого обработчиком.
    if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
      const len = Number(request.headers.get('content-length') || 0);
      if (len > MAX_BODY_BYTES) {
        return jsonResponse({ error: 'Payload Too Large' }, corsHeaders, 413);
      }
    }

    if (method === 'OPTIONS') {
      // Preflight: отвечаем с CORS-заголовками только разрешённым origin'ам.
      const headers = { ...securityHeaders, ...corsHeaders };
      return new Response(null, { status: 204, headers });
    }

    // Логирование производительности D1: привязываем общий logger к запросу.
    const store = createStore(env);
    setRequestLogger(store._logger);

    // context.waitUntil позволяет дать фоновым задачам (Telegram-уведомления)
    // дойти до конца ПОСЛЕ отправки ответа клиенту — не блокируя его, но и не
    // убивая висящий fetch при завершении handler'а. context передаётся
    // параметром в cachedGet и фоновые notify-функции (не через глобал).

    // ── Rate limiting (защита от спама) ──────────────────
    // Применяется ко всем запросам до маршрутизации. Возвращает Response(429)
    // при превышении лимита или null — тогда выполняем обычный маршрут.
    // Использует D1 через store._db для атомарного инкремента счётчика.
    // Политика недоступности D1 решается внутри checkRateLimit
    // (fail-closed для verify, fail-open для остальных категорий).
    // Исключения отсюда быть не должно; аварийный catch — fail-closed последней инстанции.
    try {
      const limited = await applyRateLimits(store, request, path, method, corsHeaders);
      if (limited) return limited;
    } catch (rlErr) {
      console.error('[ratelimit] unexpected error (fail-closed):', rlErr.message);
      return rateLimitResponse(corsHeaders, 60, { kind: 'unknown' });
    }

    try {
      // ── Public endpoints ──────────────────────────────────
      if (path === '/api/status' && method === 'GET') {
        return await cachedGet(request, env, corsHeaders, () => handleStatus(request, env, corsHeaders), context);
      }
      if (path === '/api/schedule' && method === 'GET') {
        return await cachedGet(request, env, corsHeaders, () => handleGetSchedule(request, env, corsHeaders), context);
      }
      if (path === '/api/weeks' && method === 'GET') {
        return await cachedGet(request, env, corsHeaders, () => handleGetWeeks(request, env, corsHeaders), context);
      }
      if (path === '/api/schedules' && method === 'GET') {
        return await cachedGet(request, env, corsHeaders, () => handleGetSchedules(request, env, corsHeaders), context);
      }
      if (path === '/api/bootstrap' && method === 'GET') {
        return await cachedGet(request, env, corsHeaders, () => handleBootstrap(request, env, corsHeaders), context);
      }
      if (path === '/api/upload' && method === 'POST') {
        const guard = await requireWriter(request, env, corsHeaders);
        if (guard) return guard;
        return await handleUpload(request, env, corsHeaders);
      }
      if (path === '/api/subjects' && method === 'GET') {
        return await cachedGet(request, env, corsHeaders, () => handleGetSubjects(request, env, corsHeaders), context);
      }
      if (path === '/api/subjects' && method === 'POST') {
        const guard = await requireWriter(request, env, corsHeaders);
        if (guard) return guard;
        return await handlePutSubjects(request, env, corsHeaders);
      }
      if (path === '/api/hw' && method === 'GET') {
        return await cachedGet(request, env, corsHeaders, () => handleGetHw(request, env, corsHeaders), context);
      }
      if (path === '/api/hw' && method === 'POST') {
        const guard = await requireWriter(request, env, corsHeaders);
        if (guard) return guard;
        return await handleAddHw(request, env, corsHeaders, context);
      }
      if (path === '/api/hw' && method === 'PUT') {
        const guard = await requireWriter(request, env, corsHeaders);
        if (guard) return guard;
        return await handleUpdateHw(request, env, corsHeaders, context);
      }
      if (path === '/api/hw/batch' && method === 'PUT') {
        const guard = await requireWriter(request, env, corsHeaders);
        if (guard) return guard;
        return await handleBatchUpdateHw(request, env, corsHeaders);
      }
      if (path === '/api/hw' && method === 'DELETE') {
        const guard = await requireWriter(request, env, corsHeaders);
        if (guard) return guard;
        return await handleDeleteHw(request, env, corsHeaders, context);
      }
      if (path === '/api/hw/recalc' && method === 'POST') {
        const guard = await requireWriter(request, env, corsHeaders);
        if (guard) return guard;
        return await handleRecalcHw(request, env, corsHeaders);
      }

      // ── Announcements (глобальные объявления от owner) ──
      if (path === '/api/announcements' && method === 'GET') {
        return await cachedGet(request, env, corsHeaders, () => handleGetAnnouncements(request, env, corsHeaders), context);
      }
      if (path === '/api/announcements' && method === 'POST') {
        return await handleAddAnnouncement(request, env, corsHeaders);
      }
      if (path === '/api/announcements' && method === 'PUT') {
        return await handleUpdateAnnouncement(request, env, corsHeaders);
      }
      if (path === '/api/announcements' && method === 'DELETE') {
        return await handleDeleteAnnouncement(request, env, corsHeaders);
      }

      // ── Campus sync (frontend-parse flow) ───────────────
      if (path === '/api/check-campus-update' && method === 'POST') {
        const guard = await requireWriter(request, env, corsHeaders);
        if (guard) return guard;
        return await handleCheckCampusUpdate(request, env, corsHeaders);
      }
      if (path === '/api/sync-from-campus' && method === 'POST') {
        const guard = await requireWriter(request, env, corsHeaders);
        if (guard) return guard;
        return await handleSyncFromCampus(request, env, corsHeaders, context);
      }

      // ── Invite endpoints (writer/owner only) ────────────
      if (path === '/api/invite/create' && method === 'POST') {
        const guard = await requireWriter(request, env, corsHeaders);
        if (guard) return guard;
        return await handleInviteCreate(request, env, corsHeaders);
      }
      // ── Owner cookie login/logout (публичные) ──────────────
      if (path === '/api/owner/login' && method === 'POST') {
        return await handleOwnerLogin(request, env, corsHeaders);
      }
      if (path === '/api/owner/logout' && method === 'POST') {
        return await handleOwnerLogout(request, env, corsHeaders);
      }
      if (path === '/api/owner/status' && method === 'GET') {
        return await handleOwnerStatus(request, env, corsHeaders);
      }
      if (path === '/api/writer/status' && method === 'GET') {
        return await handleWriterStatus(request, env, corsHeaders);
      }
      if (path === '/api/writer/logout' && method === 'POST') {
        return await handleWriterLogout(request, env, corsHeaders);
      }
      if (path === '/api/invite/verify' && method === 'POST') {
        return await handleInviteVerify(request, env, corsHeaders);
      }
      if (path === '/api/invite' && method === 'GET') {
        // Read-only: CSRF-заголовок не нужен (нет side-эффектов).
        // handleInviteList сам проверяет auth.role === 'owner' → 403.
        return await handleInviteList(request, env, corsHeaders);
      }
      if (path === '/api/invite' && method === 'DELETE') {
        const guard = await requireWriter(request, env, corsHeaders);
        if (guard) return guard;
        return await handleInviteDelete(request, env, corsHeaders);
      }
      if (path === '/api/invite' && method === 'PUT') {
        const guard = await requireWriter(request, env, corsHeaders);
        if (guard) return guard;
        return await handleInviteRename(request, env, corsHeaders);
      }

      // ── Telegram bot endpoints ──────────────────────────
      if (path === '/api/tg/webhook' && method === 'POST') {
        return await handleTgWebhook(request, env);
      }
      if (path === '/api/tg/status' && method === 'POST') {
        return await handleTgStatus(request, env, corsHeaders);
      }

      store._logger.flush(`${method} ${path}`);
      return jsonResponse({ error: 'Not Found' }, corsHeaders, 404);
    } catch (e) {
      // Детали исключения — ТОЛЬКО в логи (wrangler tail / Dashboard), клиенту
      // уходит generic-сообщение: e.message может раскрывать устройство системы
      // (SQL, имена таблиц, пути). requestId позволяет найти запись в логах.
      console.error('[api] unhandled error requestId=' + requestId + ':', e && (e.stack || e.message));
      store._logger.flush(`${method} ${path} (error)`);
      return jsonResponse({ error: 'Internal Server Error', requestId }, corsHeaders, 500);
    }
  },

  // Cron-триггер (см. wrangler.toml [triggers]): ежедневная очистка
  // протухших записей, которые в KV удалялись сами по expirationTtl.
  async scheduled(event, env) {
    try {
      const store = createStore(env);
      const res = await store.cleanupExpired();
      console.log('D1 cleanupExpired done:', JSON.stringify(res?.meta || res));
    } catch (e) {
      console.log('D1 cleanupExpired failed:', e.message);
    }
  },
};

// ── Auth: role-based resolution ─────────────────────────────────
// Модель доступа:
//   reader  — аноним, группа из query/body. Только GET.
//   writer  — есть валидный token (inv:{token} в KV). POST/PUT/DELETE.
//   owner   — token совпал с env.OWNER_CODE (constant-time, timingSafeEqualStr).
//             writer + управление приглашениями.
//
// Token'ы приглашений — случайные 32-символьные строки (crypto.randomUUID
// без дефисов). Хранятся в KV: inv:{token} -> { group, createdAt, label? }.
// Код владельца — секрет env.OWNER_CODE (через `wrangler secret put`).

const INVITE_TTL = 365 * 24 * 60 * 60; // 365 дней

// Формат инвайт-токена: 32 hex-символа (crypto.randomUUID без дефисов).
// Единый источник истины для resolveAuth (D1-read inv:{token}) и для
// rate-limit категории verify (isBearerInviteToken) — чтобы условие
// «запрос делает D1-read» и условие «запрос считается в verify-счётчике»
// не могли разойтись при будущих правках.
const INVITE_TOKEN_RE = /^[0-9a-f]{32}$/i;

// Возвращает { group, role: 'owner'|'writer' } или null.
//   - Authorization: Bearer <token>:
//     * token совпал с env.OWNER_CODE (constant-time сравнение, timingSafeEqualStr) → owner (group из query/body)
//     * inv:{token} в KV → writer (group из записи)
//     * иначе null
//   - без заголовка, но с валидной HttpOnly-cookie __Host-owner_code → owner (viaCookie).
//     Cookie сверяется за постоянное время, D1 не трогается.
//   - без заголовка, но с валидной HttpOnly-cookie __Host-writer_tokens → writer
//     (viaCookie). Токены проверяются по D1 (inv:{token}), сопоставляются с
//     группой из запроса (см. parseWriterCookie).
//   - иначе null (аноним = reader)
async function resolveAuth(request, env) {
  const store = createStore(env);
  if (!env.DB) return null;

  const authHeader = request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    // Защита от гигантских токенов: не даём тратить CPU на timingSafeEqualStr
    // (owner) и D1-запросы (writer) с токенами произвольной длины. OWNER_CODE
    // генерируется длиной 24 (см. generate_owner_code.py), writer-инвайты — 32-hex,
    // так что разумный потолок 64 не ломает ни одну из веток.
    if (!token || token.length > 64) return null;
    // Owner: секретный код из env. Группу берём из query/body — за это
    // отвечает вызывающий код. OWNER_CODE не обязан быть 32-hex (алфавит
    // ascii_letters+digits+"-_"), поэтому здесь 32-hex НЕ требуем — только
    // постоянное по времени сравнение.
    if (env.OWNER_CODE && await timingSafeEqualStr(token, env.OWNER_CODE)) {
      return { role: 'owner', token };
    }

    // Writer: ищем inv:{token} в KV. Инвайт-токены всегда 32-hex (crypto.randomUUID
    // без дефисов), поэтому заранее отбрасываем мусорные ключи, чтобы не делать
    // лишних D1-запросов.
    if (INVITE_TOKEN_RE.test(token)) {
      try {
        const inv = await store.get(`inv:${token}`, { type: 'json' });
        if (inv && inv.group) {
          return { role: 'writer', token, group: normalizeGroup(inv.group) };
        }
      } catch (e) {
        console.log('resolveAuth inv-read failed:', e.message);
      }
    }
    return null;
  }

  // Authorization отсутствует — пробуем HttpOnly-cookie __Host-owner_code.
  // Код владельца JS не знает, D1 не затрагиваем.
  if (await ownerFromCookie(request, env)) {
    return { role: 'owner', viaCookie: true };
  }

  // HttpOnly-cookie __Host-writer_tokens: массив { g: группа, t: токен }.
  // Редактор может владеть токенами нескольких групп — ищем запись,
  // совпадающую с группой из запроса (иначе мультигрупповой редактор
  // получал бы 403 group mismatch при работе с любой группой, кроме
  // первой в куке). Валидность токена проверяем в D1 (inv:{token}).
  const writerEntries = parseWriterCookie(request);
  if (writerEntries.length > 0) {
    let targetGroup = null;
    try { targetGroup = await groupFromBodyOrQuery(request); } catch (_) { targetGroup = null; }
    for (const { g, t } of writerEntries) {
      if (targetGroup && g !== targetGroup) continue;
      try {
        const inv = await store.get(`inv:${t}`, { type: 'json' });
        if (inv && inv.group && normalizeGroup(inv.group) === g) {
          return { role: 'writer', group: g, viaCookie: true };
        }
      } catch (e) {
        console.log('resolveAuth writer-cookie inv-read failed:', e.message);
      }
    }
  }

  return null;
}

// Извлекает хэш владельца из HttpOnly cookie `__Host-owner_code` и сверяет с
// SHA-256(env.OWNER_CODE) постоянным по времени сравнением (timingSafeEqualStr).
// Cookie НЕ виден JavaScript'у — роль owner восстанавливается через него
// автоматически на каждом запросе без повторного ввода кода.
async function ownerFromCookie(request, env) {
  if (!env.OWNER_CODE) return false;
  const expected = await getOwnerCodeHash(env);
  if (!expected) return false;
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return false;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== OWNER_COOKIE_NAME) continue;
    let value = part.slice(eq + 1).trim();
    try { value = decodeURIComponent(value); } catch (_) { /* оставляем как есть */ }
    return await timingSafeEqualStr(value, expected);
  }
  return false;
}

// ── Writer-cookie (__Host-writer_tokens) ────────────────────────
//
// Токены приглашений редактора лежат в HttpOnly-cookie, а не в localStorage:
// JS их не видит (закрывает XSS-кражу токена), кука прикладывается браузером
// сама. В отличие от owner'а, у редактора может быть несколько групп — в куке
// хранится JSON-массив записей { g: группа, t: токен }:
//   __Host-writer_tokens = encodeURIComponent('[{"g":"131-ибо","t":"<32hex>"},...]')
// Токен лежит как есть: он и так случайный 32-hex (перебор невозможен), а
// кража куки = кража сессии — хэширование не добавило бы защиты. Срок жизни
// куки (6 мес) короче срока инвайта в D1 (365 дней) — роль восстанавливается
// повторным открытием той же #invite=-ссылки.

const WRITER_COOKIE_TTL = 15552000; // 6 месяцев (сек)
const WRITER_COOKIE_MAX_ENTRIES = 20; // предохранитель от раздувания куки
const WRITER_COOKIE_NAME = '__Host-writer_tokens';

// Читает записи writer-куки из запроса. Возвращает массив { g, t }.
// Невалидные записи отбрасываются — мусор в куке auth не ломает.
function parseWriterCookie(request) {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return [];
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== WRITER_COOKIE_NAME) continue;
    let raw = part.slice(eq + 1).trim();
    try { raw = decodeURIComponent(raw); } catch (_) { return []; }
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      const out = [];
      for (const item of arr) {
        const g = normalizeGroup(item && item.g);
        const t = typeof (item && item.t) === 'string' ? item.t.trim() : '';
        if (!g || !isValidGroup(g) || !/^[0-9a-f]{32}$/i.test(t)) continue;
        out.push({ g, t });
        if (out.length >= WRITER_COOKIE_MAX_ENTRIES) break;
      }
      return out;
    } catch (_) {
      return [];
    }
  }
  return [];
}

// Строка Set-Cookie для writer-куки. entries — массив { g, t }.
// Пустой массив → удаление куки.
function writerCookieSetHeader(entries) {
  if (!entries || entries.length === 0) {
    return `${WRITER_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  }
  const value = encodeURIComponent(JSON.stringify(entries.map(({ g, t }) => ({ g, t }))));
  return `${WRITER_COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${WRITER_COOKIE_TTL}`;
}

// Upsert записи { g, t } в writer-куку запроса (другие группы сохраняются).
function writerCookieUpsert(request, g, t) {
  const entries = parseWriterCookie(request).filter((e) => e.g !== g);
  entries.push({ g, t });
  return writerCookieSetHeader(entries.slice(-WRITER_COOKIE_MAX_ENTRIES));
}

// Извлекает группу для owner из query (GET/DELETE) или body (POST/PUT).
// Для writer группа уже известна из resolveAuth.
function groupFromAuth(auth, request) {
  if (auth && auth.role === 'writer' && auth.group) return normalizeGroup(auth.group);
  // owner / reader без группы в auth — берём из запроса
  return null;
}

async function groupFromBodyOrQuery(request) {
  try {
    if (request.method === 'GET' || request.method === 'DELETE') {
      const url = new URL(request.url);
      return normalizeGroup(url.searchParams.get('group'));
    }
    // clone, чтобы обработчик ниже тоже мог звать readJsonBody()
    const clone = request.clone();
    const bb = await readJsonBody(clone);
    if (!bb.ok) return null;
    return normalizeGroup(bb.json.group) || null;
  } catch {
    return null;
  }
}

// CSRF-защита для cookie-авторизации (2-й слой поверх Content-Type check):
// HttpOnly-кука __Host-owner_code прикладывается браузером автоматически, в т.ч. к
// same-site form-POST с поддомена того же registrable-домена (dpdns.org).
// Кастомный заголовок X-Requested-With форма поставить не может — его шлёт
// только наш JS (apiPost/apiPut/apiDelete в app.js; apiFetch — только GET,
// guard для GET не применяется). Если роль owner получена из куки (viaCookie),
// а заголовка нет — отбиваем 403. Bearer-авторизация заголовка не требует
// (формы его тоже не умеют слать). Возвращает Response (403) или null (ок).
function csrfGuardForCookieAuth(auth, request, corsHeaders) {
  if (auth && auth.viaCookie && (auth.role === 'owner' || auth.role === 'writer') &&
      request.headers.get('X-Requested-With') !== 'fetch') {
    return jsonResponse({ error: 'Forbidden: CSRF header required' }, corsHeaders, 403);
  }
  return null;
}

// Возвращает Response 403, если у запрошенного нет прав writer.
// Иначе возвращает null + значение не используется. Группа берётся из auth
// (writer) или из query/body (owner). Для reader — 403.
async function requireWriter(request, env, corsHeaders) {
  const auth = await resolveAuth(request, env);
  if (!auth || (auth.role !== 'writer' && auth.role !== 'owner')) {
    return jsonResponse({ error: 'Forbidden: writer access required' }, corsHeaders, 403);
  }
  const csrf = csrfGuardForCookieAuth(auth, request, corsHeaders);
  if (csrf) return csrf;
  if (auth.role === 'writer') {
    const targetGroup = await groupFromBodyOrQuery(request);
    if (!targetGroup || auth.group !== targetGroup) {
      return jsonResponse({ error: 'Forbidden: group mismatch' }, corsHeaders, 403);
    }
  }
  return null; // ок
}


// ── Приглашения ────────────────────────────────────────────────
//
// KV-ключи:
//   inv:{token}         -> { group, createdAt, label? }, TTL 365d
//   inv-by-group:{group} -> JSON [ { id, token, createdAt, label? }, ... ]
//
// id = первые 8 символов token (показываем пользователю как короткий id,
// сам token для отзыва через UI не светим, но хранится внутри inv-by-group).

// POST /api/invite/create
// Body: { group, label? }. Требует owner. Для owner — group из body.
// Возвращает { link, id }. Полный токен в теле ответа не возвращается:
// он уже зашит в link (#invite=), а отдельной поверхностью утечки быть не должен.
async function handleInviteCreate(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const auth = await resolveAuth(request, env);
  // Создавать ссылки-приглашения может ТОЛЬКО владелец (owner).
  // Writer (по ссылке-приглашению) создавать ссылки не может.
  if (!auth || auth.role !== 'owner') {
    return jsonResponse({ error: 'Forbidden: only owner can create invites' }, corsHeaders, 403);
  }
  const csrf = csrfGuardForCookieAuth(auth, request, corsHeaders);
  if (csrf) return csrf;

  const bb = await readJsonBody(request);
  if (bb.tooLarge) return jsonResponse({ error: 'Payload Too Large' }, corsHeaders, 413);
  if (bb.parseError) return jsonResponse({ error: 'Bad JSON' }, corsHeaders, 400);
  const body = bb.json;
  let group = normalizeGroup(body.group);

  // owner может создавать приглашения для любой группы.
  if (!group || !isValidGroup(group)) {
    return jsonResponse({ error: 'Missing group' }, corsHeaders, 400);
  }

  // label — опциональное название ссылки: чистим через sanitizeString
  // (лимит длины 100 + удаление управляющих символов), не-строки отбрасываем.
  const label = sanitizeString(body.label, 100);
  const token = crypto.randomUUID().replace(/-/g, '');
  const id = token.slice(0, 8);
  const createdAt = new Date().toISOString();

  const invRecord = { group, createdAt };
  if (label) invRecord.label = label;
  await store.put(`inv:${token}`, JSON.stringify(invRecord), {
    expirationTtl: INVITE_TTL,
  });

  // Добавляем в inv-by-group:{group}. RMW-цикл (get → push → put) сериализуем
  // withKeyLock — иначе два параллельных запроса owner'а на одну группу могут
  // перезаписать список (потеря записи). Сама запись inv:{token} выше уникальна
  // (случайный токен), ей блокировка не нужна, поэтому остаётся вне этого участка.
  await withKeyLock(`inv-by-group:${group}`, async () => {
    const listRaw = await store.get(`inv-by-group:${group}`, { type: 'json' }) || [];
    listRaw.push({ id, token, createdAt, label: label || undefined });
    await store.put(`inv-by-group:${group}`, JSON.stringify(listRaw), {
      expirationTtl: INVITE_TTL,
    });
  });

  // Формируем ссылку. ORIGIN — origin текущего запроса (та же Workers-домена).
  // При желании можно задать env.INVITE_ORIGIN для канонической ссылки.
  // Токен кладём в hash-фрагмент (#invite=), а не в query (?token=), чтобы он
  // не попадал в серверные логи, историю переходов и кэши. Старые ссылки
  // с ?token= фронтенд по-прежнему понимает (см. consumeInviteTokenFromUrl).
  const origin = env.INVITE_ORIGIN || new URL(request.url).origin;
  const link = `${origin}/#invite=${token}`;

  return jsonResponse({ ok: true, link, id }, corsHeaders);
}

// POST /api/owner/login
// Body: { code }. Публичный (без Bearer). Если code совпал с env.OWNER_CODE
// (constant-time сравнение, timingSafeEqualStr) — ставит HttpOnly-куку __Host-owner_code и
// возвращает { ok: true }. Иначе 403. Cookie не видна JavaScript'у, но
// прикрепляется браузером к каждому запросу на этот же сайт — роль owner
// восстанавливается автоматически.
const OWNER_COOKIE_TTL = 2592000; // 30 дней (сек)
const OWNER_COOKIE_NAME = '__Host-owner_code';

async function handleOwnerLogin(request, env, corsHeaders) {
  if (!env.OWNER_CODE) {
    return jsonResponse({ error: 'OWNER_CODE not configured' }, corsHeaders, 500);
  }

  const bb = await readJsonBody(request);
  if (bb.tooLarge) return jsonResponse({ error: 'Payload Too Large' }, corsHeaders, 413);
  if (bb.parseError) return jsonResponse({ error: 'Bad JSON' }, corsHeaders, 400);
  const body = bb.json;
  const code = (body.code || '').toString();
  // Защита от CPU-нагрузки: в timingSafeEqualStr пользовательский код
  // хешируется SHA-256 (sha256Digest), поэтому гигантский body.code (тело
  // ограничено только readJsonBody) заставлял бы воркер хешировать мегабайты
  // на каждый запрос. OWNER_CODE по умолчанию длиной 24 (generate_owner_code.py,
  // минимум 8), потолок 128 с большим запасом не ломает легальные коды.
  // Тот же приём, что лимит ≤64 в resolveAuth — проверка ДО хеширования.
  if (code.length > 128) {
    return jsonResponse({ error: 'Bad Request: owner code too long' }, corsHeaders, 400);
  }
  if (!code || !(await timingSafeEqualStr(code, env.OWNER_CODE))) {
    return jsonResponse({ error: 'Forbidden: wrong owner code' }, corsHeaders, 403);
  }

  // Observability для планового отзыва legacy-ссылок (?owner=). Фронтенд шлёт
  // source: 'legacy' только когда код пришёл из query-строки (легаси-ссылка,
  // код уже мог попасть в логи серверов). Логируем ТОЛЬКО факт — сам код не
  // логируем (не светим секрет повторно). Владелец видит это в `wrangler tail`
  // и знает, что legacy-код ещё используется — стоит сменить OWNER_CODE и
  // раздать новые #owner= ссылки. Поле необязательное: без него (ручной ввод
  // в настройках, curl) поведение не меняется.
  if (body.source === 'legacy') {
    console.log('[legacy] owner login via legacy ?owner= link — смените OWNER_CODE и раздайте новые #owner= ссылки');
  }

  // В куку кладём не сам код, а его SHA-256 хэш (base64url): утечка куки
  // больше не раскрывает секрет владельца и не даёт вечной компрометации.
  const ownerHash = await getOwnerCodeHash(env);
  const headers = {
    ...securityHeaders,
    ...corsHeaders,
    'Content-Type': 'application/json',
    // HttpOnly — код недоступен JS (закрывает XSS-кражу из localStorage/URL).
    // Secure — только по HTTPS. SameSite=Lax — кука шлётся на same-site запросы.
    'Set-Cookie': `${OWNER_COOKIE_NAME}=${ownerHash}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${OWNER_COOKIE_TTL}`,
  };
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

// GET /api/owner/status
// Публичный. Лёгкая проверка роли owner: возвращает { isOwner } по
// HttpOnly-cookie __Host-owner_code (или Authorization: Bearer <OWNER_CODE>).
// D1 НЕ трогает — только постоянновременное сравнение хэша куки.
// Нужен фронтенду, чтобы восстановить права владельца после перезагрузки,
// даже когда /api/bootstrap пропускается из-за тёплых клиентских кешей.
// Ответ всегда приватный: он зависит от пользователя и не должен попадать
// ни в браузерный, ни в CDN-кеш.
async function handleOwnerStatus(request, env, corsHeaders) {
  const authHeader = request.headers.get('Authorization');
  // OWNER_CODE генерируется длиной 24 (generate_owner_code.py) — гигантские
  // Bearer-токены отбрасываем, чтобы не тратить CPU на timingSafeEqualStr.
  const viaBearer = !!(env.OWNER_CODE &&
    authHeader && authHeader.startsWith('Bearer ') &&
    authHeader.slice(7).trim().length <= 64 &&
    await timingSafeEqualStr(authHeader.slice(7).trim(), env.OWNER_CODE));
  const isOwner = viaBearer || await ownerFromCookie(request, env);
  const headers = {
    ...securityHeaders,
    ...corsHeaders,
    'Content-Type': 'application/json',
    'Cache-Control': 'private, no-store',
  };
  return new Response(JSON.stringify({ isOwner: !!isOwner }), { status: 200, headers });
}

// POST /api/owner/logout
// Публичный. Удаляет куку __Host-owner_code. Роль owner сбрасывается в браузере.
// CSRF-защита (см. csrfGuardForCookieAuth): HttpOnly-кука __Host-owner_code
// прикладывается браузером автоматически, в т.ч. к same-site form-POST
// с поддомена dpdns.org — такой POST мог бы вылогинить владельца. Поэтому,
// если роль owner пришла из куки (auth.viaCookie), требуем заголовок
// X-Requested-With: fetch (его шлёт только наш JS — apiPost в app.js).
// Bearer-авторизация и запросы вообще без авторизации (идемпотентный logout
// «вхолостую») заголовок не требуют: гвард их пропускает. Эндпоинт остаётся
// публичным — logout работает и без Bearer.
async function handleOwnerLogout(request, env, corsHeaders) {
  const auth = await resolveAuth(request, env);
  const csrf = csrfGuardForCookieAuth(auth, request, corsHeaders);
  if (csrf) return csrf;

  const headers = {
    ...securityHeaders,
    ...corsHeaders,
    'Content-Type': 'application/json',
    'Set-Cookie': `${OWNER_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
  };
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

// GET /api/writer/status?group=...
// Публичный. Лёгкая проверка роли writer: возвращает { isWriter } по
// HttpOnly-cookie __Host-writer_tokens. Токена в куке нет/невалиден/не для
// этой группы → false. Нужен фронтенду, чтобы восстановить права редактора
// после перезагрузки (JS куку не видит). Ответ всегда приватный
// (private, no-store) — как /api/owner/status, в общий кэш не попадает.
async function handleWriterStatus(request, env, corsHeaders) {
  const url = new URL(request.url);
  const group = normalizeGroup(url.searchParams.get('group'));
  if (!group || !isValidGroup(group)) {
    return jsonResponse({ error: 'Missing group' }, corsHeaders, 400);
  }

  let isWriter = false;
  const store = createStore(env);
  if (env.DB) {
    for (const { g, t } of parseWriterCookie(request)) {
      if (g !== group) continue;
      try {
        const inv = await store.get(`inv:${t}`, { type: 'json' });
        if (inv && inv.group && normalizeGroup(inv.group) === g) {
          isWriter = true;
          break;
        }
      } catch (e) {
        console.log('handleWriterStatus inv-read failed:', e.message);
      }
    }
  }

  const headers = {
    ...securityHeaders,
    ...corsHeaders,
    'Content-Type': 'application/json',
    'Cache-Control': 'private, no-store',
  };
  return new Response(JSON.stringify({ isWriter: !!isWriter, group }), { status: 200, headers });
}

// POST /api/writer/logout
// Body: { group }. Публичный. Удаляет токен указанной группы из HttpOnly-cookie
// __Host-writer_tokens (токены других групп сохраняются). CSRF-защита как у
// /api/owner/logout: если роль пришла из куки (auth.viaCookie), требуем
// X-Requested-With: fetch — иначе same-site form-POST с поддомена dpdns.org
// мог бы молча вылогинить редактора. Без group — чистит куку целиком.
async function handleWriterLogout(request, env, corsHeaders) {
  const auth = await resolveAuth(request, env);
  const csrf = csrfGuardForCookieAuth(auth, request, corsHeaders);
  if (csrf) return csrf;

  const bb = await readJsonBody(request);
  if (bb.tooLarge) return jsonResponse({ error: 'Payload Too Large' }, corsHeaders, 413);
  if (bb.parseError) return jsonResponse({ error: 'Bad JSON' }, corsHeaders, 400);
  const group = normalizeGroup((bb.json || {}).group);
  let setCookie;
  if (group && isValidGroup(group)) {
    setCookie = writerCookieSetHeader(parseWriterCookie(request).filter((e) => e.g !== group));
  } else {
    setCookie = writerCookieSetHeader([]);
  }

  const headers = {
    ...securityHeaders,
    ...corsHeaders,
    'Content-Type': 'application/json',
    'Set-Cookie': setCookie,
  };
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

// POST /api/invite/verify
// Body: { token }. Публичный (без auth).
// Валидный токен  → 200 { ok: true, group, token }.
// Пустой токен или токен неверного формата (длина >64 или не 32-hex) → 400.
// Токен корректного 32-hex формата, но несуществующий/отозванный → 200
// { ok: false } — единый статус для всех «несуществующих» исходов убирает
// оракул по статус-коду (404 vs 400): нельзя отличить «токен не существует»
// от «токен отозван». 400 за неверный формат оракулом не является: вход, не
// прошедший строгую 32-hex проверку, по построению не может быть валидным
// токеном (все токены генерируются как crypto.randomUUID без дефисов — см.
// handleInviteCreate), поэтому по нему нельзя ничего узнать о реальных
// токенах. Фронтенд (consumeInviteTokenFromUrl) проверяет `resp.ok && data.ok`
// симметрично — для него 400 и 200 {ok:false} неразличимы и оба означают
// «ссылка недействительна». Проверка формата выполняется ДО обращения к D1
// и защищает хранилище от мусорных ключей (в теле может быть токен до 1 МБ).
// Перебор дополнительно закрыт rate limit 10/мин/IP (fail-closed)
// и 32-hex пространством токенов.
async function handleInviteVerify(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const bb = await readJsonBody(request);
  if (bb.tooLarge) return jsonResponse({ error: 'Payload Too Large' }, corsHeaders, 413);
  if (bb.parseError) return jsonResponse({ error: 'Bad JSON' }, corsHeaders, 400);
  const body = bb.json;
  const token = ((body || {}).token || '').toString().trim();
  if (!token) {
    return jsonResponse({ error: 'Missing token' }, corsHeaders, 400);
  }
  // Валидируем формат ДО обращения к D1: инвайт-токены всегда 32-hex
  // (crypto.randomUUID без дефисов — см. handleInviteCreate; тот же паттерн
  // и лимит ≤64 уже применяется в resolveAuth). Мусор (aaaa) или гигантское
  // значение (до 1 МБ в теле) не должны превращаться в ключ inv:{token} —
  // это лишний D1-read и мусор в таблице. Не-32-hex вход по построению не
  // может быть валидным токеном, поэтому 400 здесь оракулом не является
  // (см. комментарий функции).
  if (token.length > 64 || !/^[0-9a-f]{32}$/i.test(token)) {
    return jsonResponse({ error: 'Invalid token' }, corsHeaders, 400);
  }

  const inv = await store.get(`inv:${token}`, { type: 'json' });
  if (!inv || !inv.group) {
    // 200 (не 404): не даём оракул по статус-коду и не различаем
    // «не существует» / «отозван». Сюда попадают только токены корректного
    // 32-hex формата (битый формат отсечён выше — 400). См. комментарий функции.
    // cacheControl: 'no-store' — результат verify зависит от состояния инвайта
    // и не должен кэшироваться (jsonResponse ставит no-store для 4xx/5xx, для
    // 200 — только по явному cacheControl).
    return jsonResponse({ ok: false, error: 'Invite not found or revoked' }, corsHeaders, 200, { cacheControl: 'no-store' });
  }

  // Observability для планового отзыва legacy-ссылок (?token=). Фронтенд шлёт
  // source: 'legacy' только когда токен пришёл из query-строки (легаси-ссылка,
  // токен уже мог попасть в логи серверов). Логируем ТОЛЬКО факт и группу —
  // сам токен не логируем (не светим секрет повторно). Владелец видит это в
  // `wrangler tail` и знает, какие группы ещё сидят на legacy — их ссылки
  // пора отозвать и перевыпустить. Поле необязательное: без него (старые
  // клиенты, curl, revalidateInviteToken) поведение не меняется.
  if (body.source === 'legacy') {
    console.log(`[legacy] invite verified via legacy ?token= link; group=${normalizeGroup(inv.group)} — перевыпустите ссылку (#invite=)`);
  }

  // Успешная верификация ставит HttpOnly-cookie __Host-writer_tokens (upsert
  // по группе, 6 месяцев): роль редактора восстанавливается после перезагрузки
  // без повторного ввода ссылки, а токен недоступен JavaScript'у. Тело ответа
  // содержит только ok/group — полный токен в ответе не возвращается (JS он
  // не нужен; фронтенд читает только data.group), это убирает лишнюю
  // поверхность утечки секрета при XSS/расширении браузера.
  const headers = {
    ...securityHeaders,
    ...corsHeaders,
    'Content-Type': 'application/json',
    // Явный no-store: ответ ставит Set-Cookie — кэшироваться (CDN/браузером)
    // он не должен ни при каких условиях.
    'Cache-Control': 'no-store',
    'Set-Cookie': writerCookieUpsert(request, normalizeGroup(inv.group), token),
  };
  return new Response(JSON.stringify({ ok: true, group: normalizeGroup(inv.group) }), { status: 200, headers });
}

// GET /api/invite?group=...
// Только owner. Writer не имеет доступа к управлению ссылками.
//
// Без параметра id — список инвайтов БЕЗ полного токена (только id/createdAt/label):
// полный токен не должен постоянно лежать в DOM, чтобы при XSS/расширении на
// странице owner'а не утёк целиком.
// С параметром id — возвращает один инвайт вместе с полным токеном (вызывается
// фронтендом только в момент копирования ссылки).
async function handleInviteList(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const auth = await resolveAuth(request, env);
  if (!auth || auth.role !== 'owner') {
    return jsonResponse({ error: 'Forbidden: only owner can manage invites' }, corsHeaders, 403);
  }

  const url = new URL(request.url);
  const group = normalizeGroup(url.searchParams.get('group'));
  if (!group || !isValidGroup(group)) {
    return jsonResponse({ error: 'Missing group' }, corsHeaders, 400);
  }

  const listRaw = await store.get(`inv-by-group:${group}`, { type: 'json' }) || [];

  const id = (url.searchParams.get('id') || '').toString().trim();

  if (id) {
    // Один инвайт с полным токеном — только для копирования ссылки.
    const item = listRaw.find(it => it.id === id);
    if (!item) {
      return jsonResponse({ error: 'Invite not found' }, corsHeaders, 404);
    }
    const one = {
      id: item.id,
      token: item.token,
      createdAt: item.createdAt,
      ...(item.label ? { label: item.label } : {}),
    };
    return jsonResponse({ ok: true, item: one }, corsHeaders, 200, {
      cacheControl: CC_WRITER_GET,
      isPrivate: true,
    });
  }

  // Список БЕЗ токенов — токен подтягивается отдельным запросом по id.
  const items = listRaw.map(({ id, createdAt, label }) => ({
    id,
    createdAt,
    ...(label ? { label } : {}),
  }));
  return jsonResponse({ ok: true, items }, corsHeaders, 200, {
    cacheControl: CC_WRITER_GET,
    isPrivate: true,
  });
}

// DELETE /api/invite?id=...&group=...
// Только owner. Удаляет inv:{token} (поиск по id в inv-by-group) и
// чистит список. Id = первые 8 символов token.
async function handleInviteDelete(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const auth = await resolveAuth(request, env);
  if (!auth || auth.role !== 'owner') {
    return jsonResponse({ error: 'Forbidden: only owner can manage invites' }, corsHeaders, 403);
  }
  const csrf = csrfGuardForCookieAuth(auth, request, corsHeaders);
  if (csrf) return csrf;

  const url = new URL(request.url);
  const id = (url.searchParams.get('id') || '').toString().trim();
  const group = normalizeGroup(url.searchParams.get('group'));
  if (!id || !group || !isValidGroup(group)) {
    return jsonResponse({ error: 'Missing id or group' }, corsHeaders, 400);
  }

  // RMW-цикл (get → filter → put/delete) сериализуем withKeyLock — иначе два
  // параллельных запроса owner'а на одну группу (удаление разных инвайтов)
  // могут перезаписать список и потерять запись (см. handleInviteCreate).
  // Удаление inv:{token} — одиночная операция по уникальному ключу, но
  // оставляем её внутри блокировки: список и токен удаляются как одно целое
  // относительно других операций с этой группой. Ошибка блокировки (таймаут)
  // уходит в общий catch роутера → 500, как в остальных хендлерах.
  const lockResult = await withKeyLock(`inv-by-group:${group}`, async () => {
    const listRaw = await store.get(`inv-by-group:${group}`, { type: 'json' }) || [];
    const item = listRaw.find(it => it.id === id);
    if (!item) {
      return { notFound: true };
    }

    // Удаляем токен
    await store.delete(`inv:${item.token}`);

    // Чистим список
    const filtered = listRaw.filter(it => it.id !== id);
    if (filtered.length) {
      await store.put(`inv-by-group:${group}`, JSON.stringify(filtered), {
        expirationTtl: INVITE_TTL,
      });
    } else {
      await store.delete(`inv-by-group:${group}`);
    }

    return { notFound: false };
  });

  if (lockResult.notFound) {
    return jsonResponse({ error: 'Invite not found' }, corsHeaders, 404);
  }

  return jsonResponse({ ok: true }, corsHeaders);
}

// PUT /api/invite
// Body: { id, group, label }. Требует writer/owner. Обновляет название
// (label) ссылки: в inv-by-group:{group} и в inv:{token}. Пустая строка
// label = сброс названия.
async function handleInviteRename(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const auth = await resolveAuth(request, env);
  if (!auth || auth.role !== 'owner') {
    return jsonResponse({ error: 'Forbidden: only owner can manage invites' }, corsHeaders, 403);
  }
  const csrf = csrfGuardForCookieAuth(auth, request, corsHeaders);
  if (csrf) return csrf;

  const bb = await readJsonBody(request);
  if (bb.tooLarge) return jsonResponse({ error: 'Payload Too Large' }, corsHeaders, 413);
  if (bb.parseError) return jsonResponse({ error: 'Bad JSON' }, corsHeaders, 400);
  const body = bb.json;
  const id = (body.id || '').toString().trim();
  const group = normalizeGroup(body.group);
  if (!id || !group || !isValidGroup(group)) {
    return jsonResponse({ error: 'Missing id or group' }, corsHeaders, 400);
  }

  // RMW-цикл (get → findIndex → обновить label → put) сериализуем withKeyLock —
  // иначе два параллельных запроса owner'а на одну группу (переименование
  // разных инвайтов) могут перезаписать список и потерять запись (см.
  // handleInviteCreate). Синхронизация label в inv:{token} тоже внутри
  // блокировки: токен принадлежит ровно одной группе, сериализация по
  // inv-by-group:{group} исключает гонки по обоим ключам. Ошибка блокировки
  // (таймаут) уходит в общий catch роутера → 500, как в остальных хендлерах.
  const lockResult = await withKeyLock(`inv-by-group:${group}`, async () => {
    const listRaw = await store.get(`inv-by-group:${group}`, { type: 'json' }) || [];
    const idx = listRaw.findIndex(it => it.id === id);
    if (idx === -1) {
      return { notFound: true };
    }

    const newLabel = sanitizeString(body.label, 100).trim();
    listRaw[idx].label = newLabel || undefined;
    await store.put(`inv-by-group:${group}`, JSON.stringify(listRaw), {
      expirationTtl: INVITE_TTL,
    });

    // Синхронизируем label в inv:{token} (для консистентности).
    const token = listRaw[idx].token;
    if (token) {
      const inv = await store.get(`inv:${token}`, { type: 'json' });
      if (inv) {
        if (newLabel) inv.label = newLabel;
        else delete inv.label;
        await store.put(`inv:${token}`, JSON.stringify(inv), {
          expirationTtl: INVITE_TTL,
        });
      }
    }

    return { notFound: false, newLabel };
  });

  if (lockResult.notFound) {
    return jsonResponse({ error: 'Invite not found' }, corsHeaders, 404);
  }

  return jsonResponse({ ok: true, id, label: lockResult.newLabel || '' }, corsHeaders);
}

// ── Constant-time string comparison ────────────────────────────
// Защищает от timing-атак при сравнении секретов (TG_WEBHOOK_SECRET и т.п.).
// Возвращает true, если строки равны.
//
// Реализация: обе строки хэшируются SHA-256 (ровно 32 байта), и хэши
// сравниваются XOR-аккумулятором по этой фиксированной длине — время не
// зависит от длины входных строк (раньше цикл шёл по более короткой из них,
// и по задержке теоретически можно было угадать длину секрета). Хэш секрета
// (второго аргумента) кэшируется, чтобы повторное хэширование на каждом
// запросе тоже не зависело от длины секрета.
//
// Функция async — вызывающие места обязаны await'ить результат.

// Кэш SHA-256 для секретов, передаваемых вторым аргументом: они повторяются
// на каждом запросе. Ограничен 32 записями, вытесняется самая старая.
const TIMING_SAFE_HASH_CACHE_MAX = 32;
const secretHashCache = new Map(); // секрет → Uint8Array (32 байта)

async function sha256Digest(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return new Uint8Array(buf);
}

function getSecretHashCached(secret) {
  const hit = secretHashCache.get(secret);
  if (hit) return Promise.resolve(hit);
  return sha256Digest(secret).then((hash) => {
    secretHashCache.set(secret, hash);
    if (secretHashCache.size > TIMING_SAFE_HASH_CACHE_MAX) {
      // Map хранит порядок вставки — первый ключ это самая старая запись.
      secretHashCache.delete(secretHashCache.keys().next().value);
    }
    return hash;
  });
}

async function timingSafeEqualStr(a, b) {
  const sa = String(a == null ? '' : a);
  const sb = String(b == null ? '' : b);
  // Хэши фиксированной длины (32 байта каждый): время цикла не зависит от
  // длины строк, XOR-аккумулятор не допускает раннего выхода.
  const [ha, hb] = await Promise.all([
    sha256Digest(sa),
    getSecretHashCached(sb),
  ]);
  let diff = ha.length ^ hb.length;
  const len = Math.max(ha.length, hb.length);
  for (let i = 0; i < len; i++) diff |= (ha[i] || 0) ^ (hb[i] || 0);
  return diff === 0;
}

// SHA-256 хэш OWNER_CODE (base64url) с кэшем на время жизни контекста.
// Пересчитывается только при смене значения env.OWNER_CODE.
let ownerCodeHashCache = { code: null, hash: null };
async function sha256Hex(str) {
  let bin = '';
  for (const b of await sha256Digest(str)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function getOwnerCodeHash(env) {
  if (!env.OWNER_CODE) return '';
  if (ownerCodeHashCache.code !== env.OWNER_CODE) {
    ownerCodeHashCache = { code: env.OWNER_CODE, hash: await sha256Hex(env.OWNER_CODE) };
  }
  return ownerCodeHashCache.hash;
}

// ── GET /api/schedule?group=...&week=... ────────────────────────

async function handleGetSchedule(request, env, corsHeaders) {
  const url = new URL(request.url);
  const group = normalizeGroup(url.searchParams.get('group'));
  const weekCode = url.searchParams.get('week');

  if (!isValidGroup(group)) {
    return jsonResponse({ error: 'Invalid group' }, corsHeaders, 400);
  }
  if (weekCode && !isValidWeekCode(weekCode)) {
    return jsonResponse({ error: 'Invalid week parameter' }, corsHeaders, 400);
  }

  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  if (weekCode) {
    const data = await store.get(`schedule:${group}:${weekCode}`, { type: 'json' });
    if (data) {
      return jsonResponse(data, corsHeaders, 200, { cacheControl: await finalCacheControlForGet(request, env), isPrivate: await isAuthRequest(request, env) });
    }
    return jsonResponse({ error: 'Week not found' }, corsHeaders, 404);
  }

  return jsonResponse({ error: 'Missing week parameter' }, corsHeaders, 400);
}

// ── GET /api/weeks?group=... ───────────────────────────────────

async function handleGetWeeks(request, env, corsHeaders) {
  const url = new URL(request.url);
  const group = normalizeGroup(url.searchParams.get('group'));

  if (!isValidGroup(group)) {
    return jsonResponse({ error: 'Invalid group' }, corsHeaders, 400);
  }

  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const data = await store.get(`weeks:${group}`, { type: 'json' });
  if (data) return jsonResponse(data, corsHeaders, 200, { cacheControl: await cacheControlForGet(request, env), isPrivate: await isAuthRequest(request, env) });
  return jsonResponse({ error: 'No weeks data' }, corsHeaders, 404);
}

// ── GET /api/schedules?group=...&weeks=w1,w2,w3 ───────────────
// Агрегатор: возвращает сразу несколько недель одним SELECT ... IN (...).
// Возвращает { [weekCode]: data }. Заменяет N параллельных /api/schedule
// (каждый со своим HTTP-RTT) одним запросом — критично для открытия без VPN.

async function handleGetSchedules(request, env, corsHeaders) {
  const url = new URL(request.url);
  const group = normalizeGroup(url.searchParams.get('group'));
  const weeksParam = url.searchParams.get('weeks') || '';
  const weeks = weeksParam.split(',').map((s) => s.trim()).filter(Boolean);

  if (!isValidGroup(group)) {
    return jsonResponse({ error: 'Invalid group' }, corsHeaders, 400);
  }
  // Отбрасываем мусорные weekCode (защита от cachebusting CDN-кэша).
  const validWeeks = weeks.filter((w) => isValidWeekCode(w));
  if (validWeeks.length === 0) {
    return jsonResponse({ error: 'Missing weeks parameter' }, corsHeaders, 400);
  }
  // Жёсткий лимит числа weekCode: защита от гигантских IN(...) в D1
  // (лимит SQL-переменных 999) и от DoS на себя через большой weeks=.
  if (validWeeks.length > MAX_WEEKS_PER_GET) {
    return jsonResponse({ error: `Too many weeks (max ${MAX_WEEKS_PER_GET})` }, corsHeaders, 400);
  }

  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const keys = validWeeks.map((w) => `schedule:${group}:${w}`);
  const { entries } = await store.getMany(keys, { type: 'json' });

  const result = {};
  for (const e of entries) {
    if (e.value == null) continue;
    // e.key === `schedule:{group}:{week}` → вырезаем weekCode
    const weekCode = e.key.slice(`schedule:${group}:`.length);
    result[weekCode] = e.value;
  }

  const cc = await finalCacheControlForGet(request, env);
  return jsonResponse(result, corsHeaders, 200, { cacheControl: cc, isPrivate: await isAuthRequest(request, env) });
}

// ── GET /api/bootstrap?group=...&weeks=w1,w2,... ────────────────
// Агрегирующий эндпоинт холодного старта: одним запросом возвращает
// weeks + schedules + hw + subjects + campusUpdatedAt. Заменяет 4
// параллельных вызова (/api/weeks, /api/schedules, /api/hw, /api/subjects)
// на один HTTP-RTT — критично для холодного старта без VPN.
//
// Параметры:
//   group — обязательный
//   weeks — список weekCode через запятую (опциональный). Если пусто —
//          возвращаются только weeks/hw/subjects без расписаний.
//
// Ответ:
//   {
//     weeks: [...],
//     schedules: { [weekCode]: data },
//     hw: [...],
//     subjects: [...],
//     campusUpdatedAt: "..."
//   }
// Поля, которых нет в БД, заменяются на пустые значения ([] или {} или ""),
// чтобы фронтенд мог графтировать на старую схему без NPE.

async function handleBootstrap(request, env, corsHeaders) {
  const url = new URL(request.url);
  const group = normalizeGroup(url.searchParams.get('group'));
  const weeksParam = url.searchParams.get('weeks') || '';
  const weeks = weeksParam.split(',').map((s) => s.trim()).filter(Boolean);

  if (!isValidGroup(group)) {
    return jsonResponse({ error: 'Invalid group' }, corsHeaders, 400);
  }
  // Отбрасываем мусорные weekCode (защита от cachebusting CDN-кэша).
  const validWeeks = weeks.filter((w) => isValidWeekCode(w));
  // Жёсткий лимит числа weekCode: защита от гигантского db.batch() в D1
  // (лимит SQL-переменных 999 / размера batch) и от DoS на себя.
  if (validWeeks.length > MAX_WEEKS_PER_GET) {
    return jsonResponse({ error: `Too many weeks (max ${MAX_WEEKS_PER_GET})` }, corsHeaders, 400);
  }

  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  // Owner определяется по HttpOnly-cookie (без лишнего запроса к D1):
  // фронтенд после перезагрузки восстанавливает роль из поля isOwner.
  const auth = await resolveAuth(request, env);
  const isOwner = !!(auth && auth.role === 'owner');
  const isPrivate = await isAuthRequest(request, env);

  // Одним batch-запросом читаем все ключи: weeks, hw, subjects,
  // campus-updated и расписания. Один round-trip к D1 вместо 5.
  const semester = currentSemesterKey();
  const schedKeys = validWeeks.map((w) => `schedule:${group}:${w}`);
  const items = [
    { key: `weeks:${group}`, type: 'json' },
    { key: `hw:${group}`, type: 'json' },
    { key: `subjects:${group}:${semester}`, type: 'json' },
    { key: `campus-updated:${group}` },
    ...schedKeys.map((k) => ({ key: k, type: 'json' })),
  ];
  const [weeksData, hwData, subjectsData, campusUpdatedAt, ...schedValues] = await store.batchGet(items);

  const schedules = {};
  for (let i = 0; i < validWeeks.length; i++) {
    if (schedValues[i] != null) {
      schedules[validWeeks[i]] = schedValues[i];
    }
  }

  // Базовый /api/bootstrap?group= (без weeks) инвалидируется purge точно,
  // поэтому его TTL не трогаем. С weeks= — комбинации не перечислить, см.
  // CC_READER_GET_WEEKS (60 с). Выбор политики — в finalCacheControlForGet
  // (общая для MISS-пути и HIT-ветки cachedGet).
  const finalCc = await finalCacheControlForGet(request, env);
  return jsonResponse({
    weeks: weeksData || [],
    schedules,
    hw: hwData || [],
    subjects: subjectsData || [],
    campusUpdatedAt: parseCampusMeta(campusUpdatedAt)?.campusUpdatedAt || '',
    isOwner,
  }, corsHeaders, 200, { cacheControl: finalCc, isPrivate });
}
// Frontend парсит campus.syktsu.ru в браузере и отправляет сюда на сохранение

async function handleUpload(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const bb = await readJsonBody(request);
  if (bb.tooLarge) return jsonResponse({ error: 'Payload Too Large' }, corsHeaders, 413);
  if (bb.parseError) return jsonResponse({ error: 'Bad JSON' }, corsHeaders, 400);
  const body = bb.json;
  const { type } = body;

  if (type === 'weeks') {
    const { group: _group, weeks } = body;
    const group = normalizeGroup(_group);
    if (!group || !isValidGroup(group) || !weeks) {
      return jsonResponse({ error: 'Missing group or weeks' }, corsHeaders, 400);
    }
    if (weeks.length > MAX_WEEKS_LIST) {
      return jsonResponse({ error: 'Too many weeks (max 300)' }, corsHeaders, 400);
    }
    const cleanWeeks = sanitizeWeeks(weeks, group);
    if (!cleanWeeks) {
      return jsonResponse({ error: 'invalid payload' }, corsHeaders, 400);
    }
    await store.put(`weeks:${group}`, JSON.stringify(cleanWeeks), { expirationTtl: 21600000 });
    await purgeGroupCdnCache(env, group);
    return jsonResponse({ ok: true, type: 'weeks', count: cleanWeeks.length }, corsHeaders);
  }

  if (type === 'schedule') {
    const { group: _group, weekCode, data } = body;
    const group = normalizeGroup(_group);
    if (!group || !isValidGroup(group) || !data) {
      return jsonResponse({ error: 'Missing group or data' }, corsHeaders, 400);
    }
    const cleanData = sanitizeScheduleData(data);
    if (!cleanData) {
      return jsonResponse({ error: 'invalid payload' }, corsHeaders, 400);
    }
    const cleanWeekCode = sanitizeString(weekCode, 60);
    if (cleanWeekCode && !weekCodeMatchesGroup(cleanWeekCode, group)) {
      return jsonResponse({ error: 'Invalid weekCode' }, corsHeaders, 400);
    }
    const key = cleanWeekCode ? `schedule:${group}:${cleanWeekCode}` : `schedule:${group}:current`;
    await store.put(key, JSON.stringify(cleanData), { expirationTtl: 21600000 });

    const prevMeta = parseCampusMeta(await store.get(`campus-updated:${group}`));
    // putMetaMerge — атомарный merge по максимуму: при параллельных записях
    // мета не теряет более актуальные campusUpdatedAt/lastSync (см. store.js).
    await store.putMetaMerge(`campus-updated:${group}`, {
      campusUpdatedAt: prevMeta?.campusUpdatedAt || null,
      lastSync: new Date().toISOString(),
      lastWeek: cleanWeekCode || 'current',
    }, { expirationTtl: 21600000 });

    try {
      await updateSubjectsForCurrentSemester(env, group);
    } catch (e) {
      console.log('subjects update skipped:', e.message);
    }

    await purgeGroupCdnCache(env, group, cleanWeekCode ? [cleanWeekCode] : ['current']);

    return jsonResponse({ ok: true, type: 'schedule', group, weekCode: cleanWeekCode }, corsHeaders);
  }

  if (type === 'schedule-batch') {
    const { group: _group, schedules } = body;
    const group = normalizeGroup(_group);
    if (!group || !isValidGroup(group) || !Array.isArray(schedules)) {
      return jsonResponse({ error: 'Missing group or schedules' }, corsHeaders, 400);
    }

    if (schedules.length > MAX_BATCH_SCHEDULES) {
      return jsonResponse({ error: 'Too many schedules (max 30)' }, corsHeaders, 400);
    }

    const updated = [];
    const validWeekCodes = [];
    const subjectStmts = [];

    for (const { weekCode, data } of schedules) {
      if (!weekCode || !data) continue;
      const cleanWeekCode = sanitizeString(weekCode, 60);
      const cleanData = sanitizeScheduleData(data);
      if (!cleanWeekCode || !weekCodeMatchesGroup(cleanWeekCode, group) || !cleanData) continue;
      validWeekCodes.push(cleanWeekCode);

      const existing = await store.get(`schedule:${group}:${cleanWeekCode}`, { type: 'json' });
      const existingStr = existing ? JSON.stringify(stripComparable(existing)) : '';
      const newStr = JSON.stringify(stripComparable(cleanData));

      if (existingStr !== newStr) {
        await store.put(`schedule:${group}:${cleanWeekCode}`, JSON.stringify(cleanData), { expirationTtl: 21600000 });
        updated.push(cleanWeekCode);

          // Инкрементально обновим список предметов этой недели (собираем stmt
          // для пакетной записи после цикла, вместо N последовательных put).
          try {
            const stmt = addSubjectsFromWeekStmt(env, group, cleanWeekCode, cleanData);
            if (stmt) subjectStmts.push(stmt);
          } catch (e) {
            console.log('addSubjectsFromWeek skipped:', e.message);
          }
      }
    }

    // Пакетная запись вкладов предметов недель (один batch вместо N put).
    if (subjectStmts.length) {
      try {
        await store.batch(subjectStmts);
      } catch (e) {
        console.log('subjects batch skipped:', e.message);
      }
    }

    // Пересоберём агрегат предметов один раз, а не на каждую изменённую неделю
    try {
      await reaggregateSubjects(env, group, currentSemesterKey());
    } catch (e) {
      console.log('reaggregateSubjects skipped:', e.message);
    }

    const prevMeta = parseCampusMeta(await store.get(`campus-updated:${group}`));
    await store.putMetaMerge(`campus-updated:${group}`, {
      campusUpdatedAt: prevMeta?.campusUpdatedAt || null,
      lastSync: new Date().toISOString(),
      lastWeek: 'batch',
    }, { expirationTtl: 21600000 });

    await purgeGroupCdnCache(env, group, updated);

    return jsonResponse({
      ok: true,
      type: 'schedule-batch',
      updated: updated.length,
      total: schedules.length,
    }, corsHeaders);
  }

  return jsonResponse({ error: 'Invalid type' }, corsHeaders, 400);
}

function stripComparable(data) {
  if (!data || typeof data !== 'object') return data;
  const { parsedAt, campusUpdatedAt, ...rest } = data;
  return rest;
}

// ── POST /api/check-campus-update ─────────────────────────────
// Body: { group, campusUpdatedAt }
// Возвращает { needUpdate: bool, stored: <iso|null> }.
// needUpdate=false, если сохранённая в KV дата совпадает с присланной.

async function handleCheckCampusUpdate(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const bb = await readJsonBody(request);
  if (bb.tooLarge) return jsonResponse({ error: 'Payload Too Large' }, corsHeaders, 413);
  if (bb.parseError) return jsonResponse({ error: 'Bad JSON' }, corsHeaders, 400);
  const body = bb.json;
  const { group: _group, campusUpdatedAt } = body;
  const group = normalizeGroup(_group);

  if (!group || !isValidGroup(group)) {
    return jsonResponse({ error: 'Missing group' }, corsHeaders, 400);
  }

  const stored = parseCampusMeta(await store.get(`campus-updated:${group}`));
  const needUpdate = !stored || stored.campusUpdatedAt !== (campusUpdatedAt || '');

  // Обновляем lastSync при каждом вызове 🔄, даже если изменений нет.
  // Мета группы изолирована по ключу `campus-updated:{group}` — параллельные
  // вызовы для разных групп не затирают друг друга (раньше был общий sync:meta).
  // putMetaMerge — атомарный merge по максимуму (см. store.js).
  await store.putMetaMerge(`campus-updated:${group}`, {
    campusUpdatedAt: stored?.campusUpdatedAt || null,
    lastSync: new Date().toISOString(),
    lastWeek: stored?.lastWeek || 'check',
  }, { expirationTtl: 21600000 });

  return jsonResponse({ needUpdate, stored: stored?.campusUpdatedAt || null }, corsHeaders);
}

// ── POST /api/sync-from-campus ───────────────────────────────
// Фронт сам скачал и распарсил HTML с campus.syktsu.ru и прислал готовые
// расписания. Бэкенд сохраняет их, обновляет предметы (инкрементально по
// каждой неделе), пересчитывает ДЗ с dueMode='nextPair', и записывает
// дату обновления кампуса.
//
// Body: { group, campusUpdatedAt, schedules: [{ weekCode, data }, ...] }

async function handleSyncFromCampus(request, env, corsHeaders, context) {
  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const bb = await readJsonBody(request);
  if (bb.tooLarge) return jsonResponse({ error: 'Payload Too Large' }, corsHeaders, 413);
  if (bb.parseError) return jsonResponse({ error: 'Bad JSON' }, corsHeaders, 400);
  const body = bb.json;
  const { group: _group, campusUpdatedAt, schedules } = body;
  const group = normalizeGroup(_group);

  if (!group || !isValidGroup(group) || !Array.isArray(schedules)) {
    return jsonResponse({ error: 'Missing group or schedules' }, corsHeaders, 400);
  }

  if (schedules.length > MAX_BATCH_SCHEDULES) {
    return jsonResponse({ error: 'Too many schedules (max 30)' }, corsHeaders, 400);
  }

  const updated = [];
  const diffs = []; // накопленные diff расписания для уведомления
  const subjectStmts = [];

  for (const { weekCode, data } of schedules) {
    if (!weekCode || !data) continue;
    const cleanWeekCode = sanitizeString(weekCode, 60);
    const cleanData = sanitizeScheduleData(data);
    if (!cleanWeekCode || !weekCodeMatchesGroup(cleanWeekCode, group) || !cleanData) continue;

    const existing = await store.get(`schedule:${group}:${cleanWeekCode}`, { type: 'json' });
    const existingStr = existing ? JSON.stringify(stripComparable(existing)) : '';
    const newStr = JSON.stringify(stripComparable(cleanData));

    if (existingStr !== newStr) {
      const isNewWeek = !existing;

      // Diff и уведомление собираем ТОЛЬКО для уже существовавших недель.
      // Появление новой недели в расписании (её раньше не было в KV) не
      // считаем «изменением» и не шлём про неё уведомление.
      if (!isNewWeek) {
        try {
          const d = diffScheduleWeek(stripComparable(existing), stripComparable(cleanData));
          if (d) diffs.push(d);
        } catch (e) {
          console.log('diffScheduleWeek skipped:', e.message);
        }
      }

      await store.put(`schedule:${group}:${cleanWeekCode}`, JSON.stringify(cleanData), { expirationTtl: 21600000 });
      updated.push(cleanWeekCode);

      // Инкрементально обновляем список предметов этой недели (собираем stmt
      // для пакетной записи после цикла, вместо N последовательных put).
      try {
        const stmt = addSubjectsFromWeekStmt(env, group, cleanWeekCode, cleanData);
        if (stmt) subjectStmts.push(stmt);
      } catch (e) {
        console.log('addSubjectsFromWeek skipped:', e.message);
      }
    }
    }

    // Пакетная запись вкладов предметов недель (один batch вместо N put).
    if (subjectStmts.length) {
      try {
        await store.batch(subjectStmts);
      } catch (e) {
        console.log('subjects batch skipped:', e.message);
      }
    }

    // Пересоберём агрегат предметов один раз, а не на каждую изменённую неделю
    try {
      await reaggregateSubjects(env, group, currentSemesterKey());
    } catch (e) {
      console.log('reaggregateSubjects skipped:', e.message);
    }

    // Мета группы (campus-updated:{group}) записывается ОДИН раз ниже,
    // после пересчёта ДЗ: campusUpdatedAt обновляем только при реальном
    // изменении расписания (updated.length > 0), иначе сохраняем прежнее.

  // Пересчёт ДЗ с dueMode='nextPair' — расписание могло измениться
  let hwResult = null;
  try {
    hwResult = await recalcHomeworkForGroup(env, group);
  } catch (e) {
    console.log('recalcHomeworkForGroup skipped:', e.message);
  }

  // Читаем актуальный список предметов текущего семестра
  // (он был обновлён через addSubjectsFromWeek выше)
  let subjects = [];
  try {
    const semester = currentSemesterKey();
    subjects = (await store.get(`subjects:${group}:${semester}`, { type: 'json' })) || [];
  } catch (e) {
    console.log('subjects read skipped:', e.message);
  }

  // Единая мета-запись группы (вариант А): дату обновления кампуса
  // обновляем только если расписание реально изменилось (updated.length > 0)
  // и прислана новая дата; иначе сохраняем ПРЕЖНЕЕ значение — не стираем,
  // чтобы индикатор «Расписание обновлено …» не терял данные.
  const changed = updated.length > 0;
  const cleanCampus = sanitizeCampusUpdatedAt(campusUpdatedAt);
  const prevCampusMeta = parseCampusMeta(await store.get(`campus-updated:${group}`));
  // putMetaMerge — атомарный merge по максимуму: даже если параллельный запрос
  // записал более свежую дату кампуса, «старый» sync (устаревший HTML/кеш) не
  // затрёт её — БД оставит максимум из времён (см. store.js).
  await store.putMetaMerge(`campus-updated:${group}`, {
    campusUpdatedAt: (changed && cleanCampus) ? cleanCampus : (prevCampusMeta?.campusUpdatedAt || null),
    lastSync: new Date().toISOString(),
    lastWeek: 'batch',
  }, { expirationTtl: 21600000 });

  // Уведомляем подписчиков группы об изменениях в расписании (если есть diff).
  if (diffs.length > 0) {
    try {
      const buildText = buildScheduleDiffText(group, diffs);
      notifyGroupFilteredBg(env, group, buildText, context);
    } catch (e) {
      console.log('schedule notify skipped:', e.message);
    }
  }

  await purgeGroupCdnCache(env, group, updated);

  return jsonResponse({
    ok: true,
    type: 'sync-from-campus',
    updated: updated.length,
    total: schedules.length,
    // Возвращаем пользователю обновлённые списки сразу в ответе
    hw: hwResult ? hwResult.items : [],
    subjects,
  }, corsHeaders);
}

// ── GET /api/hw?group=... ──────────────────────────────────────

async function handleGetHw(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const url = new URL(request.url);
  const group = normalizeGroup(url.searchParams.get('group'));

  if (!isValidGroup(group)) {
    return jsonResponse({ error: 'Invalid group' }, corsHeaders, 400);
  }

  const data = await store.get(`hw:${group}`, { type: 'json' });
  // hw содержит данные всех студентов группы — кешируем для reader'ов на 30с.
  // Writer'ы (Authorization) видят актуальное состояние (no-store), чтобы при
  // только что добавленном ДЗ и сразу же загруженном списке не получить
  // устаревший кеш из CDN.
  return jsonResponse(data || [], corsHeaders, 200, { cacheControl: await cacheControlForGet(request, env), isPrivate: await isAuthRequest(request, env) });
}

// ── POST /api/hw ───────────────────────────────────────────────

async function handleAddHw(request, env, corsHeaders, context) {
  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const bb = await readJsonBody(request);
  if (bb.tooLarge) return jsonResponse({ error: 'Payload Too Large' }, corsHeaders, 413);
  if (bb.parseError) return jsonResponse({ error: 'Bad JSON' }, corsHeaders, 400);
  const body = bb.json;
  const { group: _group, subject, task, dueDate, dueMode, pairType, author, subgroup } = body;
  const group = normalizeGroup(_group);

  if (!group || !isValidGroup(group) || !subject) {
    return jsonResponse({ error: 'Missing group or subject' }, corsHeaders, 400);
  }

  if (!dueMode || !['nextPair', 'date'].includes(dueMode)) {
    return jsonResponse({ error: 'Invalid dueMode' }, corsHeaders, 400);
  }

  const enumError = validateHwEnums(body);
  if (enumError) {
    return jsonResponse({ error: enumError }, corsHeaders, 400);
  }

  const clean = sanitizeHwFields(body);

  // dueDate для dueMode='date' обязан быть валидной календарной датой
  // "YYYY-MM-DD" — мусор/произвольные строки отбиваем 400 до записи в БД.
  // Для 'nextPair' dueDate пересчитывается сервером ниже, клиентское значение
  // игнорируется.
  if (dueMode === 'date') {
    const d = sanitizeDueDate(body.dueDate);
    if (d === null) {
      return jsonResponse({ error: 'Invalid dueDate (expected YYYY-MM-DD)' }, corsHeaders, 400);
    }
    clean.dueDate = d;
  }

  const item = {
    id: crypto.randomUUID().replace(/-/g, ''),
    subject: clean.subject || '',
    pairType: clean.pairType || 'any',
    subgroup: clean.subgroup || 'any',
    task: clean.task || '',
    dueMode,
    dueDate: clean.dueDate || '',
    author: clean.author || '',
    createdAt: new Date().toISOString(),
  };

  // Если nextPair — посчитаем dueDate сразу на основе расписаний в БД.
  // Якорная дата — день создания: следующая пара ищется СТРОГО ПОСЛЕ него,
  // то есть ДЗ не попадает на день его создания.
  if (dueMode === 'nextPair') {
    item.dueDate = await computeNextPairDate(env, group, item.subject, item.pairType, new Date(item.createdAt), item.subgroup);
  }

  const key = `hw:${group}`;
  await withKeyLock(key, async () => {
    const existing = await store.get(key, { type: 'json' }) || [];
    existing.push(item);
    await store.put(key, JSON.stringify(existing), { expirationTtl: 21600000 });
  });

  notifyGroupFilteredBg(env, group, buildHwText('add', group, item, null), context);
  await purgeGroupCdnCache(env, group);

  return jsonResponse({ ok: true, item }, corsHeaders);
}

// ── PUT /api/hw ────────────────────────────────────────────────
// Body: { id, group, subject, pairType, subgroup, task, dueMode, dueDate, author }
// — обновляет все поля конкретного ДЗ.

async function handleUpdateHw(request, env, corsHeaders, context) {
  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const bb = await readJsonBody(request);
  if (bb.tooLarge) return jsonResponse({ error: 'Payload Too Large' }, corsHeaders, 413);
  if (bb.parseError) return jsonResponse({ error: 'Bad JSON' }, corsHeaders, 400);
  const body = bb.json;
  const { id, group: _group } = body;
  const group = normalizeGroup(_group);

  if (!id || !group || !isValidGroup(group)) {
    return jsonResponse({ error: 'Missing id or group' }, corsHeaders, 400);
  }

  // dueMode — опциональное поле при правке: если передано, должно быть одним
  // из допустимых значений (как при создании ДЗ в handleAddHw).
  if (body.dueMode != null && !['nextPair', 'date'].includes(body.dueMode)) {
    return jsonResponse({ error: 'Invalid dueMode' }, corsHeaders, 400);
  }

  // Enum-поля: если переданы — проверяем до обращения к базе. Частичные
  // обновления ({ id, group, dueDate }) проходят: отсутствующие поля не
  // проверяются и не меняются (см. ниже clean.pairType != null ? ... ).
  const enumError = validateHwEnums(body);
  if (enumError) {
    return jsonResponse({ error: enumError }, corsHeaders, 400);
  }

  const key = `hw:${group}`;
  const lockResult = await withKeyLock(key, async () => {
    const existing = await store.get(key, { type: 'json' }) || [];
    const idx = existing.findIndex(h => h.id === id);
    if (idx === -1) {
      return { notFound: true };
    }

    const prev = existing[idx];
    const clean = sanitizeHwFields(body);

    // Валидация dueDate: если итоговый режим ДЗ — 'date' и клиент передал
    // dueDate, тот обязан быть валидной датой "YYYY-MM-DD". Мусор отбиваем 400
    // до записи в БД. Частичные обновления без dueDate проходят (прежняя дата
    // сохраняется ниже), а для 'nextPair' dueDate пересчитывается сервером.
    const effectiveDueMode = body.dueMode != null ? body.dueMode : prev.dueMode;
    if (effectiveDueMode === 'date' && body.dueDate != null) {
      const d = sanitizeDueDate(body.dueDate);
      if (d === null) {
        return { invalidDueDate: true };
      }
      clean.dueDate = d;
    }

    const item = {
      ...prev,
      subject: clean.subject != null ? clean.subject : prev.subject,
      pairType: clean.pairType != null ? clean.pairType : prev.pairType,
      subgroup: clean.subgroup != null ? clean.subgroup : prev.subgroup,
      task: clean.task != null ? clean.task : prev.task,
      dueMode: body.dueMode != null ? body.dueMode : prev.dueMode,
      author: clean.author != null ? clean.author : prev.author,
    };

    if (item.dueMode === 'nextPair') {
      item.dueDate = await computeNextPairDate(env, group, item.subject, item.pairType, new Date(prev.createdAt), item.subgroup);
    } else {
      item.dueDate = clean.dueDate != null ? clean.dueDate : prev.dueDate;
    }

    existing[idx] = item;
    await store.put(key, JSON.stringify(existing), { expirationTtl: 21600000 });

    return { prev, item };
  });
  if (lockResult.invalidDueDate) {
    return jsonResponse({ error: 'Invalid dueDate (expected YYYY-MM-DD)' }, corsHeaders, 400);
  }
  const { prev, item } = lockResult;
  if (!item) {
    return jsonResponse({ error: 'Homework not found' }, corsHeaders, 404);
  }

  notifyGroupFilteredBg(env, group, buildHwText('update', group, item, prev), context);
  await purgeGroupCdnCache(env, group);

  return jsonResponse({ ok: true, item }, corsHeaders);
}

// ── PUT /api/hw/batch ─────────────────────────────────────────
// Body: { group, updates: [{ id, dueDate? }, ...] }
// Массовое обновление dueDate для нескольких ДЗ одним запросом — экономия
// N вызовов воркера при пересчёте nextPair (раньше NPUT /api/hw на каждое
// ДЗ, теперь один батч).
// Возвращает { ok: true, updated: [...], notFound: [...] }.
// Уведомления в Telegram НЕ отправляем — пересчёт фоновый, не от пользователя.

async function handleBatchUpdateHw(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const bb = await readJsonBody(request);
  if (bb.tooLarge) return jsonResponse({ error: 'Payload Too Large' }, corsHeaders, 413);
  if (bb.parseError) return jsonResponse({ error: 'Bad JSON' }, corsHeaders, 400);
  const body = bb.json;
  const { group: _group, updates } = body;
  const group = normalizeGroup(_group);

  if (!group || !isValidGroup(group) || !Array.isArray(updates) || updates.length === 0) {
    return jsonResponse({ error: 'Missing group or updates' }, corsHeaders, 400);
  }

  if (updates.length > MAX_BATCH_HW_UPDATES) {
    return jsonResponse({ error: 'Too many updates (max 500)' }, corsHeaders, 400);
  }

  // Валидация dueDate в батче до записи в БД: null — очистка даты (кампус
  // закончился, фронт шлёт null), строка должна быть валидной датой
  // "YYYY-MM-DD". Мусор/произвольные строки отбиваем 400 целиком.
  for (const upd of updates) {
    if (upd && upd.dueDate !== undefined && upd.dueDate !== null && sanitizeDueDate(upd.dueDate) === null) {
      return jsonResponse({ error: 'Invalid dueDate (expected YYYY-MM-DD or null)' }, corsHeaders, 400);
    }
  }

  const key = `hw:${group}`;
  const { updated, notFound, changed, existing } = await withKeyLock(key, async () => {
    const existing = await store.get(key, { type: 'json' }) || [];

    // Индекс для быстрого поиска
    const indexById = new Map();
    for (let i = 0; i < existing.length; i++) {
      indexById.set(existing[i].id, i);
    }

    const updated = [];
    const notFound = [];
    let changed = false;

    for (const upd of updates) {
      if (!upd || !upd.id) continue;
      const idx = indexById.get(upd.id);
      if (idx === undefined) {
        notFound.push(upd.id);
        continue;
      }
      const prev = existing[idx];
      // Только dueDate пока поддерживаем — пересчёт nextPair использует только
      // дату. Если понадобится менять другие поля — расширить здесь.
      // undefined — дата не меняется, null — очистка ('' = «следующая пара»),
      // строка — валидная дата "YYYY-MM-DD" (проверена выше до лока).
      let newDate;
      if (upd.dueDate === undefined) {
        newDate = prev.dueDate;
      } else if (upd.dueDate === null) {
        newDate = '';
      } else {
        newDate = sanitizeDueDate(upd.dueDate);
      }
      if (newDate !== prev.dueDate) {
        existing[idx] = { ...prev, dueDate: newDate };
        updated.push(existing[idx]);
        changed = true;
      } else {
        // Не изменилось — не пишем в updated, но и в notFound тоже не относим.
      }
    }

    if (changed) {
      await store.put(key, JSON.stringify(existing), { expirationTtl: 21600000 });
    }

    return { updated, notFound, changed, existing };
  });

  if (changed) {
    await purgeGroupCdnCache(env, group);
  }

  return jsonResponse({
    ok: true,
    updated: updated.length,
    notFound,
    items: existing,
  }, corsHeaders);
}

// ── DELETE /api/hw?id=...&group=... ────────────────────────────

async function handleDeleteHw(request, env, corsHeaders, context) {
  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  const group = normalizeGroup(url.searchParams.get('group'));

  if (!id || !group || !isValidGroup(group)) {
    return jsonResponse({ error: 'Missing id or group' }, corsHeaders, 400);
  }

  // Валидируем формат id ДО обращения к D1. Допустимы оба формата:
  //  - новые hw-ids: 32-hex (crypto.randomUUID без дефисов — см. handleAddHw);
  //  - legacy hw-ids (до перехода на randomUUID): base36 ~12-13 символов
  //    (Date.now().toString(36) + Math.random().toString(36).slice(2,6)).
  // Мусор (aaaa) или гигантское значение из query не должны превращаться
  // в поиск по массиву и лишний D1-read. Лимит ≤64 — защита от гигантских
  // ключей, как для инвайт-токенов (handleInviteVerify) и writer-куки.
  if (id.length > 64 || !(/^[0-9a-f]{32}$/i.test(id) || /^[0-9a-z]{8,16}$/i.test(id))) {
    return jsonResponse({ error: 'Invalid id' }, corsHeaders, 400);
  }

  const key = `hw:${group}`;
  const { removed, count } = await withKeyLock(key, async () => {
    const existing = await store.get(key, { type: 'json' }) || [];
    const removed = existing.find(h => h.id === id);
    const filtered = existing.filter(h => h.id !== id);

    await store.put(key, JSON.stringify(filtered), { expirationTtl: 21600000 });

    return { removed, count: filtered.length };
  });

  if (removed) {
    notifyGroupFilteredBg(env, group, buildHwText('delete', group, removed, null), context);
  }
  await purgeGroupCdnCache(env, group);

  return jsonResponse({ ok: true, count }, corsHeaders);
}

// ── GET /api/subjects?group=... ─────────────────────────────────
// Возвращает { semester, subjects: [{subject, pairTypes: ['л','пр',...]}] }

async function handleGetSubjects(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const url = new URL(request.url);
  const group = normalizeGroup(url.searchParams.get('group'));
  const semester = currentSemesterKey();

  if (!isValidGroup(group)) {
    return jsonResponse({ error: 'Invalid group' }, corsHeaders, 400);
  }

  const key = `subjects:${group}:${semester}`;
  // GET не пишет в D1. Пересборка предметов выполняется только на write-путях
  // (POST /api/upload, sync-from-campus). Фронт при пустом списке собирает
  // предметы из расписания текущей недели (fallback в app.js).
  const data = await store.get(key, { type: 'json' });

  return jsonResponse({ semester, subjects: data || [] }, corsHeaders, 200, { cacheControl: await cacheControlForGet(request, env), isPrivate: await isAuthRequest(request, env) });
}

// ── POST /api/subjects ─────────────────────────────────────────
// Body: { group, semester?, subjects } — пересохраняет список предметов.

async function handlePutSubjects(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const bb = await readJsonBody(request);
  if (bb.tooLarge) return jsonResponse({ error: 'Payload Too Large' }, corsHeaders, 413);
  if (bb.parseError) return jsonResponse({ error: 'Bad JSON' }, corsHeaders, 400);
  const body = bb.json;
  const { group: _group, subjects, semester } = body;
  const group = normalizeGroup(_group);
  if (!group || !isValidGroup(group) || !Array.isArray(subjects)) {
    return jsonResponse({ error: 'Missing group or subjects' }, corsHeaders, 400);
  }
  if (semester && !isValidSemesterKey(semester)) {
    return jsonResponse({ error: 'Invalid semester' }, corsHeaders, 400);
  }

  const sem = semester || currentSemesterKey();
  const cleanSubjects = sanitizeSubjects(subjects);
  await store.put(`subjects:${group}:${sem}`, JSON.stringify(cleanSubjects), {
    expirationTtl: 365 * 24 * 60 * 60,
  });
  await purgeGroupCdnCache(env, group);
  return jsonResponse({ ok: true, semester: sem, count: cleanSubjects.length }, corsHeaders);
}

// ── POST /api/hw/recalc ─────────────────────────────────────────
// Тело: { group } — пересчитывает dueDate для всех ДЗ с dueMode='nextPair'
// на основе всех расписаний в БД. Возвращает обновлённые items.

async function handleRecalcHw(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const bb = await readJsonBody(request);
  if (bb.tooLarge) return jsonResponse({ error: 'Payload Too Large' }, corsHeaders, 413);
  if (bb.parseError) return jsonResponse({ error: 'Bad JSON' }, corsHeaders, 400);
  const body = bb.json;
  const group = normalizeGroup(body.group);

  if (!group || !isValidGroup(group)) {
    return jsonResponse({ error: 'Missing group' }, corsHeaders, 400);
  }

  const result = await recalcHomeworkForGroup(env, group);
  if (result && result.changed) {
    await purgeGroupCdnCache(env, group);
  }
  return jsonResponse({ ok: true, ...result }, corsHeaders);
}

// ── Объявления (глобальные, для всех посетителей сайта) ─────────
//
// KV/D1-ключ: announcements -> JSON [ { id, text, createdAt, updatedAt? }, ... ]
// Новые сверху. Пишет ТОЛЬКО owner (writer'ы и reader'ы — 403).
// Лимит MAX_ANNOUNCEMENTS записей: при переполнении старые вытесняются,
// чтобы объём записи в D1 был ограничен независимо от поведения owner'а.
//
// GET  /api/announcements   — публичный, кешируется CDN (cachedGet)
// POST /api/announcements   — owner, body { text }
// PUT  /api/announcements   — owner, body { id, text } (ставит updatedAt)
// DELETE /api/announcements?id= — owner

const ANNOUNCEMENTS_KEY = 'announcements';
const MAX_ANNOUNCEMENTS = 20;
const ANNOUNCEMENT_TTL = 21600000; // ≈250 дней, как у остальных контентных ключей
const ANNOUNCEMENT_ID_RE = /^[0-9a-f]{32}$/i;

// Единая проверка «только owner» + CSRF-guard для cookie-авторизации.
// Паттерн тот же, что в handleInviteCreate: writer явно отклоняется.
async function requireOwner(request, env, corsHeaders) {
  const auth = await resolveAuth(request, env);
  if (!auth || auth.role !== 'owner') {
    return { error: jsonResponse({ error: 'Forbidden: only owner can manage announcements' }, corsHeaders, 403) };
  }
  const csrf = csrfGuardForCookieAuth(auth, request, corsHeaders);
  if (csrf) return { error: csrf };
  return { auth };
}

function loadAnnouncements(store) {
  return store.get(ANNOUNCEMENTS_KEY, { type: 'json' }).then((v) => (Array.isArray(v) ? v : []));
}

// GET /api/announcements — публичный список. Данные не зависят от группы и
// роли, поэтому cacheControlForGet достаточно: reader'ам public+CDN,
// owner/writer (Bearer или кука) — private no-store (свежий список).
async function handleGetAnnouncements(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }
  const items = await loadAnnouncements(store);
  return jsonResponse({ items }, corsHeaders, 200, { cacheControl: await cacheControlForGet(request, env), isPrivate: await isAuthRequest(request, env) });
}

// POST /api/announcements — создать объявление.
async function handleAddAnnouncement(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const own = await requireOwner(request, env, corsHeaders);
  if (own.error) return own.error;

  const bb = await readJsonBody(request);
  if (bb.tooLarge) return jsonResponse({ error: 'Payload Too Large' }, corsHeaders, 413);
  if (bb.parseError) return jsonResponse({ error: 'Bad JSON' }, corsHeaders, 400);

  // sanitizeString срезает длину И управляющие символы (\t\n\r сохраняются —
  // фронту они нужны для переносов строк через white-space:pre-wrap).
  const text = sanitizeString(bb.json.text, 2000).trim();
  if (!text) {
    return jsonResponse({ error: 'Missing announcement text' }, corsHeaders, 400);
  }

  const item = { id: crypto.randomUUID().replace(/-/g, ''), text, createdAt: new Date().toISOString() };

  // RMW-цикл под withKeyLock — иначе два параллельных POST owner'а
  // перезаписали бы список (потеря объявления), см. handleAddHw/handleInviteCreate.
  let overflow = false;
  await withKeyLock(ANNOUNCEMENTS_KEY, async () => {
    const list = await loadAnnouncements(store);
    list.unshift(item);
    if (list.length > MAX_ANNOUNCEMENTS) {
      list.length = MAX_ANNOUNCEMENTS;
      overflow = true;
    }
    await store.put(ANNOUNCEMENTS_KEY, JSON.stringify(list), { expirationTtl: ANNOUNCEMENT_TTL });
  });

  await purgeAnnouncementsCdnCache(env);
  return jsonResponse({ ok: true, item, overflow }, corsHeaders);
}

// PUT /api/announcements — отредактировать текст объявления.
// createdAt не меняем (порядок списка стабилен), ставим updatedAt — по нему
// фронт считает объявление «непрочитанным» повторно.
async function handleUpdateAnnouncement(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const own = await requireOwner(request, env, corsHeaders);
  if (own.error) return own.error;

  const bb = await readJsonBody(request);
  if (bb.tooLarge) return jsonResponse({ error: 'Payload Too Large' }, corsHeaders, 413);
  if (bb.parseError) return jsonResponse({ error: 'Bad JSON' }, corsHeaders, 400);

  const id = typeof bb.json.id === 'string' ? bb.json.id : '';
  if (!ANNOUNCEMENT_ID_RE.test(id)) {
    return jsonResponse({ error: 'Invalid id' }, corsHeaders, 400);
  }
  const text = sanitizeString(bb.json.text, 2000).trim();
  if (!text) {
    return jsonResponse({ error: 'Missing announcement text' }, corsHeaders, 400);
  }

  let updated = null;
  await withKeyLock(ANNOUNCEMENTS_KEY, async () => {
    const list = await loadAnnouncements(store);
    const it = list.find((a) => a && a.id === id);
    if (it) {
      it.text = text;
      it.updatedAt = new Date().toISOString();
      updated = it;
      await store.put(ANNOUNCEMENTS_KEY, JSON.stringify(list), { expirationTtl: ANNOUNCEMENT_TTL });
    }
  });

  if (!updated) {
    // Идемпотентная семантика без oracle существования: чужой/устаревший id
    // просто ни к чему не приводит.
    return jsonResponse({ ok: true, updated: false }, corsHeaders);
  }

  await purgeAnnouncementsCdnCache(env);
  return jsonResponse({ ok: true, updated: true, item: updated }, corsHeaders);
}

// DELETE /api/announcements?id= — удалить объявление.
async function handleDeleteAnnouncement(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const own = await requireOwner(request, env, corsHeaders);
  if (own.error) return own.error;

  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '';
  if (!ANNOUNCEMENT_ID_RE.test(id)) {
    return jsonResponse({ error: 'Invalid id' }, corsHeaders, 400);
  }

  let removed = false;
  await withKeyLock(ANNOUNCEMENTS_KEY, async () => {
    const list = await loadAnnouncements(store);
    const next = list.filter((a) => !(a && a.id === id));
    if (next.length !== list.length) {
      removed = true;
      await store.put(ANNOUNCEMENTS_KEY, JSON.stringify(next), { expirationTtl: ANNOUNCEMENT_TTL });
    }
  });

  if (removed) await purgeAnnouncementsCdnCache(env);
  return jsonResponse({ ok: true, removed }, corsHeaders);
}

// ── Семестр (ключ для storage) ─────────────────────────────────────
// Границы: 31 января → весна (31.01 - 30.06), 1 августа → осень (01.08 - 30.01).
// Возвращает строку вида "2025-2026-весна" / "2026-2027-осень".

function currentSemesterKey(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();

  // осень: с 1 августа по 30 января
  if (m >= 8) {
    return `${y}-${y + 1}-осень`;
  }
  if (m === 1 && d < 31) {
    return `${y - 1}-${y}-осень`;
  }
  // весна: с 31 января по 31 июля
  return `${y - 1}-${y}-весна`;
}

// Валидация ключа семестра из пользовательского ввода (POST /api/subjects).
// Формат строго совпадает с currentSemesterKey(): "2025-2026-осень" /
// "2025-2026-весна" — годы четырёхзначные и идут подряд (второй = первый + 1).
// Regex отсекает управляющие символы, кавычки и произвольные строки,
// поэтому отдельная sanitizeString не нужна.
function isValidSemesterKey(sem) {
  if (typeof sem !== 'string') return false;
  const m = /^(\d{4})-(\d{4})-(весна|осень)$/.exec(sem);
  if (!m) return false;
  return parseInt(m[2], 10) === parseInt(m[1], 10) + 1;
}

function semesterFromWeekDates(startStr, endStr) {
  // dd.MM.yyyy — классифицируем по концу недели
  if (!endStr) return null;
  const dt = parseDateLocal(endStr);
  if (!dt) return null;
  return currentSemesterKey(dt);
}

// Парсим dd.MM.yyyy в локальную полночь Date (как в браузере)
function parseDateLocal(str) {
  if (!str) return null;
  const m = str.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  return new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
}

// Форматирует Date в локальную yyyy-MM-dd (как даты расписания/ДЗ).
function fmtDate(dt) {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ── Предметы: хранение вклада каждой недели отдельно ──
// Чтобы обновление списка предметов при изменении расписания оставалось
// инкрементальным, но при этом корректно «обновляло» разбиение на подгруппы
// (а не только дописывало новые коды), вклад каждой недели хранится отдельным
// ключом subjects-week:{group}:{sem}:{weekCode}. При синхронизации одной недели
// пересчитывается только её вклад, а агрегат subjects:{group}:{sem}
// пересобирается слиянием всех недельных вкладов.

// map: subject -> { types: Set(pairType), sub: Map<pairType, Set<code>> }
//   -> [{ subject, pairTypes: [...], subgroups: { [pairType]: [code, ...] } }]
function serializeSubjects(map) {
  return [...map.entries()]
    .map(([subject, info]) => {
      const subgroups = {};
      for (const [t, codes] of info.sub) {
        if (codes.size) subgroups[t] = [...codes].sort();
      }
      return {
        subject,
        pairTypes: [...info.types].sort(),
        subgroups,
      };
    })
    .sort((a, b) => a.subject.localeCompare(b.subject, 'ru'));
}

// Чистая функция: вклад одной недели (предметы / типы / подгруппы).
function computeWeekSubjects(weekData) {
  const map = new Map();
  for (const day of Object.values(weekData.days || {})) {
    for (const p of (day.pairs || [])) {
      if (!p.subject) continue;
      if (!map.has(p.subject)) map.set(p.subject, { types: new Set(), sub: new Map() });
      const info = map.get(p.subject);
      if (p.type) info.types.add(p.type);
      const sub = (p.subgroup || '').replace(/\D/g, ''); // "1" / "2" / ""
      if (sub) {
        if (!info.sub.has(p.type)) info.sub.set(p.type, new Set());
        info.sub.get(p.type).add(sub);
      }
    }
  }
  return serializeSubjects(map);
}

// Сливает все недельные вклады семестра в агрегат subjects:{group}:{sem}.
async function reaggregateSubjects(env, group, semester) {
  const store = createStore(env);
  // Одним запросом забираем key+value всех недельных вкладов (вместо list + N*get).
  const { entries } = await store.listValues({ prefix: `subjects-week:${group}:${semester}:`, type: 'json' });
  const map = new Map();
  for (const { value: snap } of entries) {
    if (!Array.isArray(snap)) continue;
    for (const s of snap) {
      if (!s || !s.subject) continue;
      if (!map.has(s.subject)) map.set(s.subject, { types: new Set(s.pairTypes || []), sub: new Map() });
      const info = map.get(s.subject);
      for (const t of (s.pairTypes || [])) info.types.add(t);
      const subs = (s.subgroups && typeof s.subgroups === 'object') ? s.subgroups : {};
      for (const [t, codes] of Object.entries(subs)) {
        if (!Array.isArray(codes) || !codes.length) continue;
        if (!info.sub.has(t)) info.sub.set(t, new Set());
        for (const c of codes) info.sub.get(t).add(c);
      }
    }
  }
  const merged = serializeSubjects(map);
  await store.put(`subjects:${group}:${semester}`, JSON.stringify(merged), {
    expirationTtl: 365 * 24 * 60 * 60,
  });
}

// Записывает вклад одной недели (subjects-week:*). Пересборку агрегата
// вызывающий код делает один раз после цикла (см. reaggregateSubjects),
// чтобы не делать лишних KV-запросов на каждую изменённую неделю.
// Возвращает подготовленный stmt для записи вклада недели (subjects-week:*),
// либо null если данных нет. Запись выполняется вызывающим через store.batch(),
// чтобы не делать N последовательных put в цикле синхронизации.
function addSubjectsFromWeekStmt(env, group, weekCode, weekData) {
  if (!weekCode || !weekData || !weekData.days) return null;
  if (!weekCodeMatchesGroup(weekCode, group)) return null;

  const semester = semesterFromWeekDates(weekData.weekStart, weekData.weekEnd)
    || currentSemesterKey();

  const snapshot = computeWeekSubjects(weekData);
  const str = JSON.stringify(snapshot);
  const expiresAt = Date.now() + 365 * 24 * 60 * 60 * 1000;
  return env.DB.prepare(
    `INSERT INTO kv (key, value, expires_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at, updated_at=excluded.updated_at`
  ).bind(`subjects-week:${group}:${semester}:${weekCode}`, str, expiresAt, Date.now());
}

// ── Полная пересборка предметов текущего семестра ──
// Используется в редких случаях (одиночный schedule-upload). Пересчитывает
// недельные вклады всех расписаний семестра и пересобирает агрегат.
// Вызывается ТОЛЬКО из writer-путей. Горячий путь синхронизации (batch)
// использует инкрементальные addSubjectsFromWeekStmt + reaggregateSubjects.

async function updateSubjectsForCurrentSemester(env, group) {
  const store = createStore(env);
  const semester = currentSemesterKey();
  // Одним запросом все расписания группы (key+value) вместо list + N*get.
  const { entries } = await store.listValues({ prefix: `schedule:${group}:`, type: 'json' });
  if (!entries.length) return false;

  const ttl = 365 * 24 * 60 * 60;
  const now = Date.now();
  const ops = [];
  for (const { key, value: data } of entries) {
    const weekValue = key.split(`schedule:${group}:`)[1];
    if (!weekValue || weekValue === 'current') continue;
    if (!isValidWeekCode(weekValue)) continue;
    if (!data || !data.days) continue;
    if (semesterFromWeekDates(data.weekStart, data.weekEnd) !== semester) continue;

    const snapshot = computeWeekSubjects(data);
    const str = JSON.stringify(snapshot);
    const expiresAt = now + ttl * 1000;
    ops.push(
      store._db.prepare(
        `INSERT INTO kv (key, value, expires_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, expires_at=excluded.expires_at, updated_at=excluded.updated_at`
      ).bind(`subjects-week:${group}:${semester}:${weekValue}`, str, expiresAt, now)
    );
  }

  if (ops.length) await store.batch(ops);

  await reaggregateSubjects(env, group, semester);
  return true;
}

// ── Пересчёт dueDate для ДЗ с dueMode='nextPair' ────────────────────

async function recalcHomeworkForGroup(env, group) {
  const store = createStore(env);
  const key = `hw:${group}`;
  return withKeyLock(key, async () => {
    const homework = await store.get(key, { type: 'json' }) || [];
    if (homework.length === 0) return { updated: 0, items: [] };

    // Загружаем все расписания группы одним запросом (list + N*get → listValues).
    const { entries } = await store.listValues({ prefix: `schedule:${group}:`, type: 'json' });
    const weekData = [];
    for (const { key, value: data } of entries) {
      const weekValue = key.split(`schedule:${group}:`)[1];
      if (!weekValue || weekValue === 'current') continue;
      if (!isValidWeekCode(weekValue)) continue;
      if (data && data.days && data.weekStart) {
        const startDate = parseDateLocal(data.weekStart);
        if (startDate) weekData.push({ startDate, data });
      }
    }
    weekData.sort((a, b) => a.startDate - b.startDate);

    let changed = false;
    const updatedItems = [];
    for (const hw of homework) {
      if (hw.dueMode !== 'nextPair') {
        updatedItems.push(hw);
        continue;
      }
      // Ищем следующую пару относительно ДНЯ СОЗДАНИЯ ДЗ, а не относительно
      // сегодня. Так dueDate остаётся привязанным к той паре, для которой
      // было задано ДЗ, и не «переезжает» вперёд при каждой синхронизации.
      const fromDate = new Date(hw.createdAt);
      let newDate = findNextPairDate(weekData, hw.subject, hw.pairType, fromDate, hw.subgroup || 'any');
      if (!newDate) {
        // Пара после дня создания не найдена в сохранённом расписании —
        // оставляем прежнюю дату, чтобы ДЗ не теряло привязку к своему дню.
        updatedItems.push(hw);
        continue;
      }
      if (newDate === hw.dueDate) {
        updatedItems.push(hw);
        continue;
      }
      changed = true;
      const upd = { ...hw, dueDate: newDate };
      updatedItems.push(upd);
    }

    if (changed) {
      await store.put(key, JSON.stringify(updatedItems), { expirationTtl: 21600000 });
    }
    return { updated: changed ? updatedItems.length : 0, items: updatedItems, changed };
  });
}

// ── Найти следующую дату пары для предмета с учётом типа ──────────
// Возвращает дату в формате yyyy-MM-dd (локальная) или null.

function findNextPairDate(weekData, subject, pairType, fromDate, subgroup = 'any') {
  if (!subject || weekData.length === 0) return null;
  const baseLower = subject.trim().toLowerCase();
  const t = pairType || 'any';
  const subNum = (subgroup || 'any').replace(/\D/g, ''); // "1" / "2" / "" (любая)

  const fmt = fmtDate;
  const todayStr = fmt(fromDate);

  for (const week of weekData) {
    for (const [, dayInfo] of Object.entries(week.data.days || {})) {
      const dayDate = parseDateLocal(dayInfo.date);
      if (!dayDate) continue;
      const dayStr = fmt(dayDate);
      if (dayStr <= todayStr) continue;

      const has = (dayInfo.pairs || []).some(p => {
        if (!p.subject) return false;
        if (p.subject.trim().toLowerCase() !== baseLower) return false;
        if (t !== 'any' && p.type !== t) return false;
        // Для конкретной подгруппы учитываем только пары этой подгруппы.
        if (subNum) {
          const pairSub = (p.subgroup || '').replace(/\D/g, '');
          if (pairSub && pairSub !== subNum) return false;
        }
        return true;
      });
      if (has) return dayStr;
    }
  }
  return null;
}

// ── Вычислить дату следующей пары для одного ДЗ ─────────────────────

async function computeNextPairDate(env, group, subject, pairType, fromDate = new Date(), subgroup = 'any') {
  const store = createStore(env);
  const { entries } = await store.listValues({ prefix: `schedule:${group}:`, type: 'json' });
  const weekData = [];
  for (const { key, value: data } of entries) {
    const weekValue = key.split(`schedule:${group}:`)[1];
    if (!weekValue || weekValue === 'current') continue;
    if (!isValidWeekCode(weekValue)) continue;
    if (data && data.days && data.weekStart) {
      const startDate = parseDateLocal(data.weekStart);
      if (startDate) weekData.push({ startDate, data });
    }
  }
  weekData.sort((a, b) => a.startDate - b.startDate);
  return findNextPairDate(weekData, subject, pairType, fromDate, subgroup);
}

// ── Разделить название предмета на базу и тип пары ──────────────────
// "Математика (л)" -> { base: "Математика", type: "л" }


async function handleStatus(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ db: false }, corsHeaders);
  }

  const url = new URL(request.url);
  const group = normalizeGroup(url.searchParams.get('group'));
  if (group && !isValidGroup(group)) {
    return jsonResponse({ db: true, error: 'Invalid group' }, corsHeaders, 400);
  }

  const meta = group ? parseCampusMeta(await store.get(`campus-updated:${group}`)) : null;

  return jsonResponse({
    db: true,
    lastSync: meta?.lastSync || null,
    lastWeek: meta?.lastWeek || null,
    campusUpdatedAt: meta?.campusUpdatedAt || null,
  }, corsHeaders, 200, { cacheControl: await cacheControlForGet(request, env), isPrivate: await isAuthRequest(request, env) });
}

// ── Helper ─────────────────────────────────────────────────────

// Кеширование на стороне Cloudflare CDN (Custom Domain — kampussgu.dpdns.org).
// workers.dev CDN не кеширует, но кастомный домен через Workers Route — да.
// Стратегия:
//   - reader (нет Authorization):  public,  s-maxage=300, max-age=60  (CDN 5 мин, браузер 1 мин)
//   - writer (есть Authorization): private, no-store                  (приватность)
// Варьируем по Authorization, чтобы CDN не смешивал кеши reader/writer.
const CC_READER_GET  = 'public, max-age=60, s-maxage=300';
// Для ответов с неделями (/api/schedules, /api/bootstrap?weeks=, /api/schedule?week=):
// комбинаций weeks= бесконечно много, purge по точному URL невозможен,
// поэтому сокращаем срок жизни в CDN до 60 с — окно устаревания ≤ 1 мин.
const CC_READER_GET_WEEKS = 'public, max-age=60, s-maxage=60';
const CC_WRITER_GET  = 'private, no-store';
const CC_NO_STORE    = 'no-store';

async function cacheControlForGet(request, env) {
  const auth = request.headers.get('Authorization');
  if (auth && auth.startsWith('Bearer ')) return CC_WRITER_GET;
  // Owner с HttpOnly-cookie тоже приватный: bootstrap в этом случае несёт
  // isOwner, и его нельзя пускать в публичный CDN-кеш.
  if (await ownerFromCookie(request, env)) return CC_WRITER_GET;
  // Writer с HttpOnly-cookie тоже приватный: /api/invite, /api/subjects и прочие
  // writer-GET могут нести данные, привязанные к роли/группе редактора,
  // поэтому их нельзя пускать в публичный CDN-кеш.
  if (parseWriterCookie(request).length > 0) return CC_WRITER_GET;
  return CC_READER_GET;
}

// Итоговая политика Cache-Control для ответа на GET — ЕДИНАЯ точка выбора.
// Обёртка над cacheControlForGet + поправка для запросов, зависящих от
// параметров week/weeks (/api/schedule?week=, /api/schedules?weeks=,
// /api/bootstrap?weeks=): комбинаций таких параметров бесконечно много,
// purge по точному URL их не накрывает (см. purgeGroupCdnCache), поэтому
// для читательских ответов TTL сокращается до CC_READER_GET_WEEKS (60 с).
// Используется и в хендлерах (MISS-путь, где ставится Cache-Control), и в
// cachedGet при отдаче из кэша (HIT) — чтобы кэшированный ответ не нёс
// устаревший Cache-Control после смены констант политики: на HIT политика
// пересчитывается из ТЕКУЩИХ констант, а не берётся из кэшированной копии.
async function finalCacheControlForGet(request, env) {
  const cc = await cacheControlForGet(request, env);
  if (cc !== CC_READER_GET) return cc; // writer/owner — private, без поправок
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/api/schedules') return CC_READER_GET_WEEKS;
  if (path === '/api/schedule' && url.searchParams.get('week')) return CC_READER_GET_WEEKS;
  if (path === '/api/bootstrap') {
    const weeks = (url.searchParams.get('weeks') || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    // Совпадает с условием validWeeks.length > 0 в handleBootstrap.
    if (weeks.some((w) => isValidWeekCode(w))) return CC_READER_GET_WEEKS;
  }
  return cc;
}

// Есть ли у запроса аутентификация (writer/owner): Bearer-токен ИЛИ
// валидная HttpOnly-cookie __Host-owner_code ИЛИ непустая HttpOnly-cookie
// __Host-writer_tokens (та же логика, что в cacheControlForGet). Для таких
// ответов isPrivate=true: Vary:Authorization + private, чтобы CDN не смешивал
// их с reader-кешем.
async function isAuthRequest(request, env) {
  return (request.headers.get('Authorization') || '').startsWith('Bearer ') ||
    await ownerFromCookie(request, env) ||
    parseWriterCookie(request).length > 0;
}

// Инвалидация CDN-кеша для группы после записи. Удаляем кешированные GET-
// ответы для этой группы, чтобы следующий reader сразу увидел свежие данные.
// Cache API на кастомном домене работает; на workers.dev — нет (игнорируем
// ошибку). Это НЕ считает дополнительным вызовом воркера — вызывается внутри
// текущего запроса после успешной записи.
// Очищаем только ключи без Authorization (reader-кеш); writer-ответы и так
// private, no-store, не кешируются CDN'ом.
// changedWeeks — weekCode, которые реально записали: для них дополнительно
// удаляем точные ключи /api/schedule?week=. Комбинации /api/schedules?weeks=
// и /api/bootstrap?weeks= перечислить нельзя (Cache API удаляет только по
// точному URL, keys() нет) — их свежесть обеспечивает короткий s-maxage
// (CC_READER_GET_WEEKS, 60 с) на этих эндпоинтах.
async function purgeGroupCdnCache(env, group, changedWeeks = []) {
  try {
    if (typeof caches === 'undefined' || !caches.default) return;
    const cache = caches.default;
    const base = new URL(env.INVITE_ORIGIN || 'https://kampussgu.dpdns.org');
    const paths = [
      `/api/weeks?group=${encodeURIComponent(group)}`,
      `/api/schedules?group=${encodeURIComponent(group)}`,
      `/api/schedule?group=${encodeURIComponent(group)}`,
      `/api/hw?group=${encodeURIComponent(group)}`,
      `/api/subjects?group=${encodeURIComponent(group)}`,
      `/api/status?group=${encodeURIComponent(group)}`,
      `/api/bootstrap?group=${encodeURIComponent(group)}`,
    ];
    for (const w of changedWeeks || []) {
      paths.push(`/api/schedule?group=${encodeURIComponent(group)}&week=${encodeURIComponent(w)}`);
    }
    await Promise.all(
      paths.map((p) =>
        cache.delete(new URL(p, base).toString(), { ignoreMethod: true }).catch(() => {})
      )
    );
  } catch (e) {
    console.log('[cache] purge failed (ignored):', e.message);
  }
}

// Инвалидация CDN-кеша объявлений после записи. URL один и без query-параметров,
// поэтому purge детерминирован (в отличие от комбинаций /api/schedules?weeks=).
async function purgeAnnouncementsCdnCache(env) {
  try {
    if (typeof caches === 'undefined' || !caches.default) return;
    const base = new URL(env.INVITE_ORIGIN || 'https://kampussgu.dpdns.org');
    await caches.default
      .delete(new URL('/api/announcements', base).toString(), { ignoreMethod: true })
      .catch(() => {});
  } catch (e) {
    console.log('[cache] announcements purge failed (ignored):', e.message);
  }
}

// Ручное кеширование GET-ответов в CDN через Cache API (caches.default).
// Работает НЕЗАВИСИМО от Dashboard Cache Rules — гарантирует HIT для reader'ов
// даже на кастомном домене Pages, где Cache Rule может не применяться.
//
// Для writer/owner (с токеном или HttpOnly-cookie) кеш НЕ используется
// (private, no-store) — ответ всегда свежий. Для reader (без токена)
// проверяем кеш, при промахе — бьём воркер, кешируем ответ на TTL из
// Cache-Control (s-maxage).
//
// Возвращает Response. Если caches API недоступен — просто вызывает builder().
async function cachedGet(request, env, corsHeaders, builder, context) {
  const hasBearer = (request.headers.get('Authorization') || '').startsWith('Bearer ');
  const isOwnerCookie = await ownerFromCookie(request, env);
  // Writer/owner — без кеша: Bearer-токен, owner-кука ИЛИ writer-кука
  // (__Host-writer_tokens). Writer-GET могут нести данные, привязанные к роли
  // редактора, — их нельзя ни отдавать из общего CDN-кеша, ни класть в него.
  if (hasBearer || isOwnerCookie || parseWriterCookie(request).length > 0) {
    return builder();
  }

  let cache = null;
  try {
    if (typeof caches !== 'undefined' && caches.default) cache = caches.default;
  } catch (_) {
    cache = null;
  }

  const cacheKey = new Request(request.url, { method: 'GET' });

  if (cache) {
    try {
      const hit = await cache.match(cacheKey, { ignoreMethod: true });
      if (hit) {
        const h = new Headers(hit.headers);
        h.set('CF-Cache-Status', 'HIT');
        // В кэше могут лежать ответы со старыми CORS-заголовками (в т.ч. "*"),
        // поэтому CORS всегда пересчитывается для текущего запроса.
        stripCorsHeaders(h);
        for (const [k, v] of Object.entries(corsHeaders)) h.set(k, v);
        // Cache-Control тоже пересчитываем из ТЕКУЩИХ констант (см.
        // finalCacheControlForGet): в кэше могут лежать ответы, закешированные
        // при старой политике (старые TTL), и HIT не должен отдавать их с
        // устаревшими заголовками — значение берём то же, что поставил бы
        // MISS-путь для этого запроса.
        const cc = await finalCacheControlForGet(request, env);
        // Защита от выдачи приватного ответа из общего кэша: до HIT доходят
        // только reader'ы (для writer/owner выше ранний выход), но если
        // текущая политика для этого запроса вдруг непубличная — не отдаём
        // кэш, а идём в builder (MISS-семантика).
        if (cc !== CC_READER_GET && cc !== CC_READER_GET_WEEKS) return builder();
        h.set('Cache-Control', cc);
        return new Response(hit.body, { status: hit.status, headers: h });
      }
    } catch (_) {
      /* кеш недоступен — идём в builder */
    }
  }

  const resp = await builder();

  // Кешируем только успешные JSON-ответы с публичной Cache-Control-политикой.
  // private/no-store в Cache-Control — защита от регрессий: приватный ответ
  // (например, writer/owner) НЕ должен попасть в общий CDN-кеш, даже если
  // дойдёт до этой ветки (обычно такие запросы отсекаются выше). Заголовок
  // может отсутствовать — тогда кешируем как раньше.
  const respCacheControl = resp.headers.get('Cache-Control');
  const cacheable = !(respCacheControl && /\b(?:private|no-store)\b/i.test(respCacheControl));
  if (cache && resp.ok && resp.headers.get('Content-Type') === 'application/json' && cacheable) {
    try {
      const h = new Headers(resp.headers);
      h.set('CF-Cache-Status', 'MISS');
      // Кэш хранит ответ БЕЗ CORS-заголовков (они зависят от Origin запроса);
      // при отдаче из кэша (HIT) они накладываются заново. Тело дублируем
      // через tee: один поток клиенту (с CORS), второй — в кэш (без CORS).
      const [clientBody, cacheBody] = resp.body.tee();
      const forClient = new Response(clientBody, { status: resp.status, headers: h });
      const toStore = new Response(cacheBody, {
        status: resp.status,
        headers: stripCorsHeaders(new Headers(h)),
      });
      if (context && typeof context.waitUntil === 'function') {
        context.waitUntil(cache.put(cacheKey, toStore).catch(() => {}));
      } else {
        cache.put(cacheKey, toStore).catch(() => {});
      }
      return forClient;
    } catch (_) {
      return resp;
    }
  }

  return resp;
}

function jsonResponse(data, corsHeaders, status = 200, opts = {}) {
  const headers = { ...securityHeaders, ...corsHeaders, 'Content-Type': 'application/json' };
  if (opts.cacheControl) {
    headers['Cache-Control'] = opts.cacheControl;
    // Vary: Authorization ставим ТОЛЬКО для writer/owner-ответов (private),
    // чтобы CDN не путал их с reader-кешем. Для reader-ответов (public)
    // Vary НЕ ставим — иначе Cloudflare отказывается кешировать ответ в
    // CDN (считает ключ кеша зависимым от заголовка, которого у анонимных
    // запросов нет), и CF-Cache-Status остаётся пустым.
    if (opts.isPrivate) headers['Vary'] = 'Authorization';
  } else if (status >= 400) {
    // VULN-006: 4xx/5xx не должны кэшироваться. Если cacheControl задан явно —
    // уважаем его (не переопределяем). Без явного cacheControl на ошибках
    // ставим no-store по умолчанию, чтобы исключить кеширование по недосмотру.
    headers['Cache-Control'] = 'no-store';
  }
  return new Response(JSON.stringify(data), { status, headers });
}

// ════════════════════════════════════════════════════════════════
// ── Telegram notifications ─────────────────────────────────────
// ════════════════════════════════════════════════════════════════
//
// KV keys:
//   tg:subs:{group}            -> JSON [{ chatId, subgroup }, ...] — подписчики + подгруппа
//   tg:groups:{chatId}         -> JSON [group,...] — индекс для рассылки по chat
//   tg:chat:{group}            -> chatId (строка) — LEGACY, мигрируется в tg:subs:
//
// Лимиты Telegram: text до 4096 символов, messages не чаще ~30/сек.
// Уведомления шлём через sendRichMessage (Bot API 10.1+, Rich Messages) с
// Rich Markdown-форматированием вместо sendMessage + parse_mode=HTML.
// При ошибке sendRichMessage — фолбэк на старый sendMessage.

const TG_API_BASE = 'https://api.telegram.org';

// Срок жизни ключей Telegram-подписок (tg:subs:{group}, tg:groups:{chatId}),
// 180 суток в секундах. Ставится при КАЖДОЙ записи: создание, миграция legacy,
// обновление. store.put — upsert (ON CONFLICT ... expires_at = excluded.expires_at),
// поэтому повторный put продлевает срок (активность подписки = повторный /sub
// или смена подгруппы через инлайн-кнопку). Брошенные подписки (блок бота,
// удаление чата, забывчивость) протухают и удаляются ежедневным cron
// (cleanupExpired), что ограничивает неконтролируемый рост D1.
const TG_SUBS_TTL_SECONDS = 15552000; // 180 * 24 * 60 * 60

// Допустимые значения подгруппы в tg:subs:{group}: 'any' | '1' | '2'.
// Используется при обработке callback'ов выбора подгруппы (handleTgWebhook):
// всё остальное (sub_5:… и т.п.) НЕ создаёт подписку — «мёртвой» подписки,
// которая никогда не совпадёт при рассылке, быть не должно.
const TG_ALLOWED_SUBGROUPS = new Set(['1', '2', 'any']);

function maskChatId(id) {
  const s = String(id);
  return s.length <= 4 ? '***' : '***' + s.slice(-4);
}

async function tgApi(env, method, payload) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log('[tg] tgApi skipped: no TELEGRAM_BOT_TOKEN');
    return { ok: false, skipped: true, reason: 'no-token' };
  }
  try {
    console.log('[tg] tgApi ->', method, 'chat_id=', maskChatId(payload && payload.chat_id), 'textLen=', payload && payload.text ? payload.text.length : 0);
      const resp = await fetch(`${TG_API_BASE}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) {
      console.log('[tg] tgApi', method, 'failed: status=', resp.status, 'body=', JSON.stringify(data).slice(0, 300));
      return { ok: false, error: data };
    }
    console.log('[tg] tgApi', method, 'ok: chat_id=', maskChatId(payload && payload.chat_id));
    return { ok: true, result: data.result };
  } catch (e) {
    console.log('[tg] tgApi', method, 'exception:', e.name, e.message);
    return { ok: false, error: e.message };
  }
}

// Возвращает [{ chatId, subgroup }, ...] для группы.
// Миграция: старый формат ["chatId"] → [{ chatId, subgroup: "any" }].
async function getGroupSubscribers(env, group) {
  const store = createStore(env);
  const raw = await store.get(`tg:subs:${group}`, { type: 'json' });
  if (!raw) {
    // Проверяем ключ tg:chat:{group} (очень старый формат).
    const old = await store.get(`tg:chat:${group}`);
    if (old) {
      const list = [{ chatId: String(old), subgroup: 'any' }];
      await store.put(`tg:subs:${group}`, JSON.stringify(list), { expirationTtl: TG_SUBS_TTL_SECONDS });
      await store.delete(`tg:chat:${group}`);
      return list;
    }
    return [];
  }
  if (!Array.isArray(raw)) return [];
  // Миграция: массив строк → массив объектов.
  if (raw.length && typeof raw[0] === 'string') {
    const migrated = raw.map(id => ({ chatId: String(id), subgroup: 'any' }));
    await store.put(`tg:subs:${group}`, JSON.stringify(migrated), { expirationTtl: TG_SUBS_TTL_SECONDS });
    return migrated;
  }
  return raw;
}

async function addGroupSubscriber(env, group, chatId, subgroup) {
  const store = createStore(env);
  await withKeyLock(`tg:subs:${group}`, async () => {
    const list = await getGroupSubscribers(env, group);
    const existing = list.find(s => String(s.chatId) === String(chatId));
    if (existing) {
      if (subgroup) existing.subgroup = subgroup;
    } else {
      list.push({ chatId: String(chatId), subgroup: subgroup || 'any' });
    }
    await store.put(`tg:subs:${group}`, JSON.stringify(list), { expirationTtl: TG_SUBS_TTL_SECONDS });
  });
}

async function removeGroupSubscriber(env, group, chatId) {
  const store = createStore(env);
  await withKeyLock(`tg:subs:${group}`, async () => {
    const list = await getGroupSubscribers(env, group);
    const filtered = list.filter(s => String(s.chatId) !== String(chatId));
    if (filtered.length) await store.put(`tg:subs:${group}`, JSON.stringify(filtered), { expirationTtl: TG_SUBS_TTL_SECONDS });
    else await store.delete(`tg:subs:${group}`);
  });
}

// Фоновая отправка уведомления: не блокирует ответ клиенту (через
// context.waitUntil), но гарантирует, что fetch к Telegram дойдёт до конца
// после отправки ответа — иначе при неблокирующем вызове Worker убивает
// висящий fetch при завершении handler'а и уведомления теряются.
// context передаётся из fetch параметром (см. handleSyncFromCampus и др.).
function notifyGroupBg(env, group, text, opts = {}, context) {
  console.log('[tg] notifyGroupBg called for', group, 'ctx.waitUntil=', !!(context && typeof context.waitUntil === 'function'));
  const p = notifyGroup(env, group, text, opts).catch((e) =>
    console.log('[tg] notify skipped:', e && e.message)
  );
  if (context && typeof context.waitUntil === 'function') {
    context.waitUntil(p);
  } else {
    console.log('[tg] notifyGroupBg: NO ctx.waitUntil — promise may be killed on response end');
  }
  return p;
}

// Рассылает сообщение всем подписчикам группы (chat_id изолированы друг от друга).
async function notifyGroup(env, group, text, opts = {}) {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN) {
    console.log('[tg] notifyGroup early return: DB=', !!env.DB, 'token=', !!env.TELEGRAM_BOT_TOKEN);
    return;
  }
  const subs = await getGroupSubscribers(env, group);
  if (!subs.length) {
    console.log('[tg] notifyGroup: no subscribers for', group);
    return;
  }
  console.log('[tg] notifyGroup: sending to', subs.length, 'subs for', group, 'textLen=', text ? text.length : 0);

  const chunks = splitForTg(text, 4000);
  for (const sub of subs) {
    for (const c of chunks) {
      await sendTgRichMessagePaced(env, sub.chatId, c, { parseMode: opts.parseMode || 'HTML' });
      console.log('[tg] notifyGroup: send to', maskChatId(sub.chatId), 'ok');
    }
  }
}

// Единая точка отправки уведомления пользователю:
// 1) sendRichMessage с Rich Markdown (новый формат Bot API 10.1+);
// 2) если метод не поддержан — фолбэк на sendMessage с parse_mode=HTML.
async function sendTgRichMessage(env, chatId, htmlText, opts = {}) {
  const md = htmlToMarkdown(htmlText);
  let res = await tgApi(env, 'sendRichMessage', {
    chat_id: chatId,
    rich_message: { markdown: md },
  });
  if (!res.ok) {
    console.log('[tg] sendRichMessage failed, fallback to sendMessage:', JSON.stringify(res.error || res).slice(0, 200));
    res = await tgApi(env, 'sendMessage', {
      chat_id: chatId,
      text: htmlText,
      parse_mode: opts.parseMode || 'HTML',
      disable_web_page_preview: true,
    });
  }
  return res;
}

// ── Защита рассылки от лимитов Telegram (~30 msg/сек на бота) ──
// Большие рассылки (много подписчиков × много чанков) уходят в фоне через
// ctx.waitUntil, поэтому лёгкая пауза между сообщениями не влияет на время
// ответа клиенту, но не даёт упереться в лимит и получить 429 по флуд-контролю.

// Межсообщенческая пауза: 70 мс → ~14 msg/сек, комфортный запас под ~30 msg/сек.
const TG_MESSAGE_INTERVAL_MS = 70;
// Кап ожидания по 429 retry_after (Telegram может прислать и большие значения;
// ждать дольше не имеет смысла — после капа просто выходим с ошибкой).
const TG_RETRY_MAX_WAIT_MS = 5000;
// Максимум попыток отправки одного сообщения (учёт ретраев по 429).
const TG_MAX_SEND_ATTEMPTS = 3;

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Отправка одного сообщения с защитой от лимитов Telegram:
//   1) пауза TG_MESSAGE_INTERVAL_MS перед каждой отправкой — разносит
//      запросы к Bot API во времени (подписчики и чанки не летят «пачкой»);
//   2) при 429 с parameters.retry_after — ждём retry_after (с капом
//      TG_RETRY_MAX_WAIT_MS) и повторяем, до TG_MAX_SEND_ATTEMPTS раз;
//   3) прочие ошибки (битый текст и т.п.) НЕ ретраим — иначе можно вечно
//      долбить Telegram; выходим с результатом.
async function sendTgRichMessagePaced(env, chatId, htmlText, opts = {}) {
  await sleepMs(TG_MESSAGE_INTERVAL_MS);
  let res;
  for (let attempt = 1; attempt <= TG_MAX_SEND_ATTEMPTS; attempt++) {
    res = await sendTgRichMessage(env, chatId, htmlText, opts);
    if (res && res.ok) return res;
    const retryAfter =
      res && res.error && res.error.parameters && res.error.parameters.retry_after;
    if (typeof retryAfter === 'number' && retryAfter > 0 && attempt < TG_MAX_SEND_ATTEMPTS) {
      const waitMs = Math.min(retryAfter * 1000, TG_RETRY_MAX_WAIT_MS);
      console.log(`[tg] 429 retry_after=${retryAfter}s, waiting ${waitMs}ms (attempt ${attempt + 1}/${TG_MAX_SEND_ATTEMPTS})`);
      await sleepMs(waitMs);
      continue;
    }
    break;
  }
  return res;
}

// Самозакрывающиеся (void) HTML-теги — не «открывают» вложенность и не
// требуют закрывающего тега. В наших сообщениях их нет (используются только
// <b>/<i>/<code> и переносы строк '\n'), набор добавлен defense-in-depth:
// чтобы открытый тег такого рода не «завис» в стеке открытых тегов при
// разрезании длинного сообщения и не породил лишний </br> в конце куска.
const TG_VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr', 'source', 'area', 'base', 'col', 'embed', 'param', 'track']);

// Разбивает HTML-текст на атомарные токены: HTML-теги (<b>, </code>,
// <a href="…">), HTML-сущности (&amp;, &lt;, &#39;, …) и обычный текст между
// ними. Нужно для безопасного разрезания длинных HTML-сообщений по границам
// тегов/сущностей — кусок никогда не должен разорвать тег или сущность,
// иначе Telegram отдаёт 400 на sendMessage с parse_mode=HTML.
// Битый тег без '>' и длинный '&…' без ';' (не похожий на сущность)
// остаются в текстовом токене как есть — их режем как обычный текст.
function tokenizeTgHtml(text) {
  const tokens = [];
  let i = 0;
  let buf = '';
  while (i < text.length) {
    const ch = text[i];
    if (ch === '<') {
      const gt = text.indexOf('>', i + 1);
      if (gt === -1) { buf += text.slice(i); break; }
      if (buf) { tokens.push({ type: 'text', raw: buf }); buf = ''; }
      const raw = text.slice(i, gt + 1);
      const m = raw.match(/^<\s*\/?\s*([A-Za-z][A-Za-z0-9]*)/);
      const name = m ? m[1].toLowerCase() : '';
      tokens.push({
        type: 'tag',
        raw,
        name,
        closing: /^<\s*\//.test(raw),
        selfClosing: /\/>$/.test(raw) || TG_VOID_TAGS.has(name),
      });
      i = gt + 1;
    } else if (ch === '&') {
      const semi = text.indexOf(';', i + 1);
      // Короткие «&…;» (длиной до 12 симв.) — это сущность (&amp;, &lt;,
      // &gt;, &#39; …); атомарна, резать нельзя. Всё прочее — текст.
      if (semi !== -1 && semi - i <= 12) {
        if (buf) { tokens.push({ type: 'text', raw: buf }); buf = ''; }
        tokens.push({ type: 'entity', raw: text.slice(i, semi + 1) });
        i = semi + 1;
      } else { buf += ch; i++; }
    } else {
      buf += ch;
      i++;
    }
  }
  if (buf) tokens.push({ type: 'text', raw: buf });
  return tokens;
}

// Выбирает точку разреза в текстовом фрагменте: не дальше max символов и не
// разрывая суррогатную пару (эмодзи). При возможности режем по границе
// абзаца (\n\n), строки (\n) или слова (пробел) — так куски читаются лучше.
function safeTgCut(s, max) {
  if (max <= 0) return 0;
  if (s.length <= max) return s.length;
  const doubleNl = s.lastIndexOf('\n\n', max - 1);
  if (doubleNl > 0 && doubleNl + 2 <= max) return doubleNl + 2;
  const nl = s.lastIndexOf('\n', max - 1);
  if (nl > 0 && nl + 1 <= max) return nl + 1;
  const sp = s.lastIndexOf(' ', max - 1);
  if (sp > 0 && sp + 1 <= max) return sp + 1;
  let cut = max;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff && cut < s.length) cut -= 1; // не резать эмодзи
  return cut;
}

// Разбивает длинное HTML-сообщение для Telegram на куски ≤ maxLen (лимит
// sendMessage 4096, режем с запасом в 4000). Гарантии:
//   * куски НЕ разрывают HTML-тег (<b>, </code>, <a href="…">) и сущность
//     (&amp;, &lt;, …) — иначе Telegram отдаёт 400 на parse_mode=HTML;
//   * теги, оставшиеся открытыми к концу куска, в его хвосте закрываются
//     (</b></i>), а следующий кусок начинается с их повторного открытия
//     (<b><i>) — каждый кусок самодостаточно валиден;
//   * не разрывается суррогатная пара (эмодзи).
// Короткие сообщения (≤ maxLen) и пустые возвращаются как раньше — поведение
// обычного пути (уведомления короче 4000 символов) не меняется.
function splitForTg(text, maxLen) {
  if (!text) return [];
  if (text.length <= maxLen) return [text];

  const tokens = tokenizeTgHtml(text);
  const out = [];
  const stack = []; // открытые теги в порядке вложенности
  let cur = '';
  let dirty = false; // был ли реальный контент (не только переоткрытые теги)

  const closeTags = () => {
    let s = '';
    for (let i = stack.length - 1; i >= 0; i--) s += `</${stack[i]}>`;
    return s;
  };
  const openTags = () => {
    let s = '';
    for (const name of stack) s += `<${name}>`;
    return s;
  };
  const flush = () => {
    // Не публикуем «пустой» кусок-скобку (<b></b> без контента).
    if (!cur || !dirty) return;
    out.push(cur + closeTags());
    cur = openTags(); // следующий кусок продолжает открытые теги
    dirty = false;
  };

  for (const tok of tokens) {
    if (tok.type === 'text') {
      let rest = tok.raw;
      while (rest.length) {
        let room = maxLen - cur.length;
        if (room <= 0) { flush(); room = maxLen - cur.length; }
        if (rest.length <= room) { cur += rest; dirty = true; rest = ''; break; }
        const cut = safeTgCut(rest, room);
        cur += rest.slice(0, cut); dirty = true;
        rest = rest.slice(cut);
        flush();
      }
      continue;
    }
    // Тег или сущность — атомарный токен, добавляем целиком.
    if (cur.length + tok.raw.length > maxLen && cur) flush();
    cur += tok.raw; dirty = true;
    if (tok.type === 'tag') {
      if (tok.selfClosing) continue;
      if (tok.closing) {
        const idx = stack.lastIndexOf(tok.name);
        if (idx !== -1) stack.splice(idx, 1);
      } else if (tok.name) {
        stack.push(tok.name);
      }
    }
  }
  if (cur && dirty) flush();
  return out;
}

// Экранирование пользовательского текста для Rich Markdown (GFM).
// `*` и `_` НЕ экранируем — это markdown-разметка (жирный/курсив),
// которую пользователь может вводить в тексте ДЗ. Непарные разделители
// GFM оставляет как есть, поэтому одиночные звёздочки не ломают текст.
// `<` и `>` экранируем (защита в глубину): Rich Markdown принимает HTML-теги,
// поэтому литеральные < > из пользовательского текста не должны превращаться
// в разметку/ссылки — GFM рендерит экранированные \< \> как обычные символы.
function escMarkdown(s) {
  return String(s).replace(/[\\`~<>\[\]]/g, (ch) => '\\' + ch);
}

// Конвертация нашей HTML-разметки (escTg + <b>/<i>/<code>) в Rich Markdown —
// новый формат sendRichMessage (Bot API 10.1+). Rich Markdown совместим с
// GitHub Flavored Markdown и дополнительно принимает HTML-теги, но для
// красоты и читаемости переводим базовые теги в md-синтаксис.
function htmlToMarkdown(html) {
  // ВАЖНО (безопасность): &lt;/&gt; намеренно НЕ декодируем обратно в < >.
  // escTg экранирует пользовательские < > в &lt;/&gt;, а их декодирование здесь
  // превращало их в настоящие HTML-теги в Rich Markdown (он принимает HTML) —
  // т.е. открывало HTML-инъекцию: <a href="https://evil.ru"> из текста ДЗ
  // становилось кликабельной ссылкой, битый тег давал 400 от Telegram.
  // Сущности &lt;/&gt; Telegram рендерит как обычные < > — текст виден
  // корректно, но тегом/ссылкой не становится.
  const entities = { '&amp;': '&', '&quot;': '"', '&#39;': "'" };
  const decode = (s) => s.replace(/&(amp|quot|#39);/g, (m) => entities[m] || m);
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { out += escMarkdown(decode(html.slice(i))); break; }
    out += escMarkdown(decode(html.slice(i, lt)));
    const gt = html.indexOf('>', lt);
    if (gt === -1) { out += escMarkdown(html.slice(lt)); break; }
    const tag = html.slice(lt + 1, gt);
    if (tag === 'b' || tag === '/b') out += '**';
    else if (tag === 'i' || tag === '/i') out += '*';
    else if (tag === 'code' || tag === '/code') out += '`';
    else out += escMarkdown(html.slice(lt, gt + 1)); // незнакомый/битый тег — экранируем как текст, а не пропускаем как HTML
    i = gt + 1;
  }
  return out;
}

// ── Фильтрация уведомлений по подгруппе ─────────────────────────

function matchesSubgroup(pref, itemSubgroup) {
  if (pref === 'any') return true;
  if (!itemSubgroup || itemSubgroup === 'any') return true;
  return pref === itemSubgroup;
}

// Рассылка с персональной фильтрацией: buildText(chatId, subgroup) → string | null.
async function notifyGroupFiltered(env, group, buildText) {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN) return;
  const subs = await getGroupSubscribers(env, group);
  if (!subs.length) return;
  for (const sub of subs) {
    const text = await buildText(sub.chatId, sub.subgroup);
    if (!text) continue;
    const chunks = splitForTg(text, 4000);
    for (const c of chunks) {
      await sendTgRichMessagePaced(env, sub.chatId, c, { parseMode: 'HTML' });
    }
  }
}

function notifyGroupFilteredBg(env, group, buildText, context) {
  const p = notifyGroupFiltered(env, group, buildText).catch((e) =>
    console.log('[tg] notifyFiltered skipped:', e && e.message)
  );
  if (context && typeof context.waitUntil === 'function') {
    context.waitUntil(p);
  }
  return p;
}

// Генератор текста для diff расписания, фильтрованный по подгруппе.
function buildScheduleDiffText(group, diffs) {
  return async function (chatId, pref) {
    const filteredWeeks = [];
    for (const w of diffs) {
      const filteredLines = [];
      for (const item of w.lines) {
        // Строка-пара начинается с двух пробелов и несёт СТРУКТУРНУЮ подгруппу
        // в item.subgroup ('1' | '2' | ''). Заголовок дня (не пара) всегда
        // сохраняется. Фильтруем по полю, а не по regex на тексте — название
        // предмета не может дать ложного срабатывания (например, если сам
        // предмет содержит «· подгруппа 1»).
        if (item.text.startsWith('  ') && !matchesSubgroup(pref, item.subgroup)) continue;
        filteredLines.push(item);
      }
      const hasPairs = filteredLines.some(l => l.text.startsWith('  '));
      if (hasPairs) filteredWeeks.push({ weekLabel: w.weekLabel, lines: filteredLines });
    }
    if (!filteredWeeks.length) return null;
    return formatScheduleDiffBroadcast(group, filteredWeeks);
  };
}

// Генератор текста для ДЗ, фильтрованный по подгруппе.
function buildHwText(action, group, hw, prevHw) {
  return async function (chatId, pref) {
    if (!matchesSubgroup(pref, hw.subgroup)) return null;
    return formatHwMessage(action, group, hw, prevHw);
  };
}

// ── POST /api/tg/webhook ────────────────────────────────────────
// Telegram шлёт обновления бота на этот путь (setWebhook).
// Поддерживаемые команды:
//   /sub <group>       — подписаться на группу (инлайн-кнопки подгруппы)
//   /stop              — отвязывает chat_id от всех групп
//   /status            — показывает текущую подписку

// Ответ вебхука Telegram: аналог jsonResponse для этого пути. Telegram не
// шлёт Origin и не требует CORS — поэтому добавляем ТОЛЬКО базовый набор
// security-заголовков (тот же securityHeaders, что и у основных ответов),
// чтобы у каждого ответа вебхука был оборонительный пояс «защиты в глубину».
function tgWebhookResponse(body, status = 200) {
  return new Response(body, { status, headers: { ...securityHeaders } });
}

async function handleTgWebhook(request, env) {
  const store = createStore(env);
  if (!env.DB) return tgWebhookResponse('ok');

  // Защита от подделки updates: Telegram при setWebhook с secret_token
  // шлёт заголовок X-Telegram-Bot-Api-Secret-Token на каждый запрос.
  // Секрет обязателен — без него webhook отключён (503), подделки не принимаются.
  if (!env.TG_WEBHOOK_SECRET) {
    console.error('[tg] FATAL: TG_WEBHOOK_SECRET not set — webhook disabled');
    return tgWebhookResponse('Webhook disabled: configuration error', 503);
  }
  const provided = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!(await timingSafeEqualStr(provided, env.TG_WEBHOOK_SECRET))) {
    console.log('[tg] webhook rejected: bad secret_token');
    return tgWebhookResponse('Unauthorized', 401);
  }

  let update;
  const wb = await readJsonBody(request);
  if (!wb.ok) return tgWebhookResponse('ok');
  update = wb.json;

  // ── Callback query (инлайн-кнопки выбора подгруппы) ──
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = String(cq.message && cq.message.chat && cq.message.chat.id);
    const data = cq.data || '';
    // data = "sub_any:GROUP" | "sub_1:GROUP" | "sub_2:GROUP"
    // [12] вместо \d: callback с несуществующей подгруппой (sub_5:… и т.п.)
    // не распознаётся как выбор подгруппы и уходит в ветку «неизвестный
    // callback» — «мёртвая» подписка (никогда не совпадёт при рассылке)
    // не создаётся.
    const cbMatch = data.match(/^sub_(any|[12]):(.+)$/);
    // Валидируем chatId: Telegram может прислать callback_query без поля
    // message (напр. при кнопке "Delete" в боте на iOS/Android). Тогда
    // String(undefined) === 'undefined' — truthy, и без этой проверки
    // создалась бы «мёртвая» подписка с chatId='undefined'. Число с
    // нецифровыми символами отбрасываем заодно (защита от мусора).
    if (cbMatch && chatId && chatId !== 'undefined' && /^\d+$/.test(chatId)) {
      const subgroup = cbMatch[1] === 'any' ? 'any' : cbMatch[1];
      // Defense-in-depth: regex уже отсекает всё кроме any/1/2, но write-путь
      // дополнительно страхуем проверкой по константе — на случай будущих
      // ослаблений regex'а (группа не нормализуется, подписка не создаётся).
      const group = TG_ALLOWED_SUBGROUPS.has(subgroup) ? normalizeGroup(cbMatch[2]) : null;
      if (group && isValidGroup(group)) {
        // Сохраняем подписку + subgroup в tg:subs:{group}
        await addGroupSubscriber(env, group, chatId, subgroup);
        // Обновляем обратный индекс tg:groups:{chatId}
        await withKeyLock(`tg:groups:${chatId}`, async () => {
          const groupsRaw = await store.get(`tg:groups:${chatId}`, { type: 'json' }) || [];
          if (!groupsRaw.includes(group)) {
            groupsRaw.push(group);
            await store.put(`tg:groups:${chatId}`, JSON.stringify(groupsRaw), { expirationTtl: TG_SUBS_TTL_SECONDS });
          }
        });

        const subLabel = subgroup === 'any' ? 'обе подгруппы' : `подгруппа ${subgroup}`;
        await tgApi(env, 'sendMessage', {
          chat_id: chatId,
          text: `✅ Подписка на группу <b>${escTg(group)}</b> (<i>${escTg(subLabel)}</i>) оформлена!\n\nУведомления придут при изменениях расписания и новых ДЗ.\n\nКоманды:\n/status — статус подписки\n/stop — отписаться`,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
        // Отвечаем на callback, чтобы убрать "часики" на кнопке.
        await tgApi(env, 'answerCallbackQuery', { callback_query_id: cq.id });
        return tgWebhookResponse('ok');
      }
    }
    // Неизвестный callback — просто отвечаем.
    await tgApi(env, 'answerCallbackQuery', { callback_query_id: cq.id });
    return tgWebhookResponse('ok');
  }

  // ── Обычные сообщения ──
  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat) return tgWebhookResponse('ok');

  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

  // В групповых чатах игнорируем.
  if (isGroup) return tgWebhookResponse('ok');

  try {
    // /start — приветствие
    if (/^\/start(@\w+)?$/i.test(text)) {
      await tgApi(env, 'sendMessage', {
        chat_id: chatId,
        text: [
          '👋 Привет! Это бот расписания СыктГУ.',
          '',
          'Чтобы получать уведомления об изменениях расписания и новых ДЗ:',
          '',
          'Напиши <code>/sub</code> и номер группы.',
          'Например: <code>/sub 131-ИБо</code>',
          '',
          'После этого выбери подгруппу — и всё готово!',
          '',
          'Команды:',
          '/sub &lt;группа&gt; — подписаться',
          '/status — статус подписки',
          '/stop — отписаться',
        ].join('\n'),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    // /sub <group> — подписка
    } else if (/^\/sub(@\w+)?\s+(.+)$/i.test(text)) {
      const groupName = RegExp.$2.trim();
      const group = normalizeGroup(groupName);
      if (!group || !isValidGroup(group)) {
        await tgApi(env, 'sendMessage', {
          chat_id: chatId,
          text: '❌ Не удалось распознать название группы. Проверь формат (например: /sub 131-ИБо) и попробуй ещё раз.',
        });
        return tgWebhookResponse('ok');
      }
      // Проверяем, уже ли подписан.
      const groupsRaw = await store.get(`tg:groups:${chatId}`, { type: 'json' }) || [];
      if (groupsRaw.includes(group)) {
        const subs = await getGroupSubscribers(env, group);
        const existing = subs.find(s => String(s.chatId) === chatId);
        const pref = existing ? existing.subgroup : 'any';
        const subLabel = pref === 'any' ? 'обе подгруппы' : `подгруппа ${pref}`;
        await tgApi(env, 'sendMessage', {
          chat_id: chatId,
          text: `⚠️ Ты уже подписан на группу <b>${escTg(group)}</b> (<i>${escTg(subLabel)}</i>).\n\nСначала отпиши: <code>/stop</code>, потом снова <code>/sub ${escTg(group)}</code>.`,
          parse_mode: 'HTML',
        });
        return tgWebhookResponse('ok');
      }
      // Показываем инлайн-кнопки выбора подгруппы.
      await tgApi(env, 'sendMessage', {
        chat_id: chatId,
        text: `Выбери подгруппу для группы <b>${escTg(group)}</b>:`,
        parse_mode: 'HTML',
        reply_markup: JSON.stringify({
          inline_keyboard: [
            [{ text: 'Обе подгруппы', callback_data: `sub_any:${group}` }],
            [{ text: 'Подгруппа 1', callback_data: `sub_1:${group}` }],
            [{ text: 'Подгруппа 2', callback_data: `sub_2:${group}` }],
          ],
        }),
      });
    // /stop — отписка от всего
    } else if (/^\/stop(@\w+)?$/i.test(text)) {
      await unbindChat(env, chatId);
      await tgApi(env, 'sendMessage', {
        chat_id: chatId,
        text: '❌ Ты отписан от всех уведомлений.\n\nЧтобы снова подписаться: <code>/sub</code> &lt;группа&gt;',
        parse_mode: 'HTML',
      });
    // /status — текущая подписка
    } else if (/^\/status(@\w+)?$/i.test(text)) {
      const groupsRaw = await store.get(`tg:groups:${chatId}`, { type: 'json' }) || [];
      if (!groupsRaw.length) {
        await tgApi(env, 'sendMessage', {
          chat_id: chatId,
          text: 'ℹ️ Ты не подписан ни на одну группу.\n\nНапиши <code>/sub</code> и номер группы.',
          parse_mode: 'HTML',
        });
      } else {
        const lines = ['📋 Твои подписки:'];
        for (const g of groupsRaw) {
          const subs = await getGroupSubscribers(env, g);
          const existing = subs.find(s => String(s.chatId) === chatId);
          const pref = existing ? existing.subgroup : 'any';
          const subLabel = pref === 'any' ? 'обе подгруппы' : `подгруппа ${pref}`;
          lines.push(`• <b>${escTg(g)}</b> — ${escTg(subLabel)}`);
        }
        lines.push('', '/stop — отписаться от всего');
        await tgApi(env, 'sendMessage', {
          chat_id: chatId,
          text: lines.join('\n'),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
      }
    // Прочий текст — подсказка
    } else if (text && !text.startsWith('/')) {
      await tgApi(env, 'sendMessage', {
        chat_id: chatId,
        text: 'Напиши <code>/sub</code> и номер группы, чтобы подписаться.\nНапример: <code>/sub 131-ИБо</code>',
        parse_mode: 'HTML',
      });
    }
  } catch (e) {
    console.log('handleTgWebhook error:', e.message);
  }
  return tgWebhookResponse('ok');
}

async function unbindChat(env, chatId) {
  const store = createStore(env);
  await withKeyLock(`tg:groups:${chatId}`, async () => {
    const groupsRaw = await store.get(`tg:groups:${chatId}`, { type: 'json' }) || [];
    for (const g of groupsRaw) {
      const cur = await store.get(`tg:chat:${g}`);
      if (String(cur) === String(chatId)) await store.delete(`tg:chat:${g}`);
      await removeGroupSubscriber(env, g, chatId);
    }
    await store.delete(`tg:groups:${chatId}`);
  });
}

// ── POST /api/tg/status { group, chatId } ───────────────────────
// Публичный «оракул»: возвращает { subscribed, botUsername } — подписан ли
// ПЕРЕДАННЫЙ chatId к этой группе. Это осознанный компромисс: запрос приходит
// со страницы сайта (браузера), сервер не знает, кто реально спрашивает, и
// надёжно привязать ответ к отправителю нельзя. Поверхность утечки ограничена:
//   • строгая валидация chatId — только цифры, иначе 400 БЕЗ обращения к D1
//     (мусорный перебор abc/-1/12.5/управляющие символы вообще не «спрашивает»);
//   • rate-limit tgstatus 30/мин/IP (см. applyRateLimits) — валидный перебор
//     chatId (9–10 цифр) при такой скорости занимает годы;
//   • chatId в теле POST, а НЕ в query GET: личный chatId не должен попадать
//     в URL (логи Cloudflare/прокси, история браузера).
// Пустой chatId — штатный запрос сайта до привязки бота: отвечаем
// subscribed:false сразу, без чтения D1 (фронт при этом чистит localStorage).
// Отписка — только командой /stop в боте (webhook), где chatId берётся
// из самого апдейта Telegram (подписанного secret_token).

// chatId — числовой идентификатор чата Telegram (у ботов подписки только из
// личных чатов, поэтому id положительный). Принимаем строку из цифр (1–16)
// или неотрицательное целое число; остальное (строки с пробелами, знак,
// дробные, булевы, объекты) → 400.
const TG_CHAT_ID_RE = /^\d{1,16}$/;

async function handleTgStatus(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  const bb = await readJsonBody(request);
  if (!bb.ok) {
    if (bb.tooLarge) return jsonResponse({ error: 'Body too large' }, corsHeaders, 413);
    return jsonResponse({ error: 'Invalid JSON' }, corsHeaders, 400);
  }
  const body = bb.json || {};
  const group = normalizeGroup(body.group);
  if (!isValidGroup(group)) {
    return jsonResponse({ error: 'Invalid group' }, corsHeaders, 400);
  }
  const chatId = body.chatId != null ? String(body.chatId) : '';
  if (chatId !== '' && !TG_CHAT_ID_RE.test(chatId)) {
    return jsonResponse({ error: 'Invalid chatId' }, corsHeaders, 400);
  }
  if (!chatId) {
    return jsonResponse({
      subscribed: false,
      botUsername: env.TG_BOT_USERNAME || '',
    }, corsHeaders, 200, { cacheControl: CC_NO_STORE });
  }
  const subs = await getGroupSubscribers(env, group);
  const existing = subs.find(s => String(s.chatId) === chatId);
  return jsonResponse({
    subscribed: !!existing,
    botUsername: env.TG_BOT_USERNAME || '',
  }, corsHeaders, 200, { cacheControl: CC_NO_STORE });
}

// ════════════════════════════════════════════════════════════════
// ── Форматирование ДЗ и расписания для Telegram ─────────────────
// ════════════════════════════════════════════════════════════════

function escTg(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const TG_PAIR_TYPES = {
  'л': 'лекция',
  'пр': 'практика',
  'пз': 'практ. занятие',
  'лаб': 'лабораторная',
  'с': 'семинар',
  'зчО': 'зачёт с оценкой',
  'зач': 'зачёт',
  'экз': 'экзамен',
};

function pairTypeLabel(t) {
  return TG_PAIR_TYPES[t] || (t ? t : '');
}

// Структурный номер подгруппы пары: 'подгруппа 1' → '1', 'подгруппа 2' → '2',
// иначе '' (без подгруппы). Используется в diff для фильтрации по подгруппе
// подписчика — по полю пары, а не по regex на тексте (название предмета само
// может содержать «· подгруппа 1», что давало ложные срабатывания).
function pairSubgroupNum(p) {
  return p && p.subgroup ? String(p.subgroup).replace(/\D/g, '') : '';
}

// Краткая human строка одной пары для diff.
function pairBrief(p) {
  const subject = escTg(p.subject || '(без названия)');
  const tp = p.type ? ` <i>[${escTg(pairTypeLabel(p.type))}]</i>` : '';
  const sub = p.subgroup ? ` · ${escTg(p.subgroup)}` : '';
  const room = p.room ? ` · ${escTg(p.room)}` : '';
  const teacher = p.teacher ? ` · ${escTg(p.teacher)}` : '';
  const time = p.time ? `${escTg(p.time)} ` : '';
  return `${time}${subject}${tp}${sub}${room}${teacher}`;
}

// JSON-подобный «сигнатурный» ключ пары (без parsedAt/campusUpdatedAt у недели).
function pairKey(p) {
  return [p.time || '', p.subject || '', p.type || '', p.subgroup || '', p.room || '', p.teacher || ''].join('␟');
}

// Сравнивает старую и новую неделю, возвращает изменения по дням.
// Возвращает null, если изменений нет, либо структуру
// { weekLabel, lines: [{ text, subgroup }, ...] }, где subgroup — структурный
// номер подгруппы пары ('1' | '2' | '') для фильтрации при рассылке.
function diffScheduleWeek(oldWeek, newWeek) {
  const oldDays = (oldWeek && oldWeek.days) || {};
  const newDays = (newWeek && newWeek.days) || {};

  // Заголовок недели (для контекста сообщения).
  const ws = (newWeek && newWeek.weekStart) || (oldWeek && oldWeek.weekStart) || '';
  const we = (newWeek && newWeek.weekEnd) || (oldWeek && oldWeek.weekEnd) || '';
  const weekLabel = (ws && we) ? `с ${escTg(ws)} по ${escTg(we)}` : 'неделя';

  const lines = [];

  // Собираем все имена дней из обеих версий.
  const dayNames = new Set([...Object.keys(oldDays), ...Object.keys(newDays)]);

  // Сортировка дней по дате (если есть), иначе по имени.
  const sorted = [...dayNames].sort((a, b) => {
    const da = oldDays[a]?.date || newDays[a]?.date || '';
    const db = oldDays[b]?.date || newDays[b]?.date || '';
    return da.localeCompare(db);
  });

  for (const dn of sorted) {
    const oldPairs = (oldDays[dn] && oldDays[dn].pairs) || [];
    const newPairs = (newDays[dn] && newDays[dn].pairs) || [];
    const dateStr = (newDays[dn] && newDays[dn].date) || (oldDays[dn] && oldDays[dn].date) || '';
    const dayHeader = dateStr ? `${escTg(dn)} (${escTg(dateStr)})` : escTg(dn);

    const oldMap = new Map(oldPairs.map(p => [pairKey(p), p]));
    const newMap = new Map(newPairs.map(p => [pairKey(p), p]));

    const removed = oldPairs.filter(p => !newMap.has(pairKey(p)));
    const added = newPairs.filter(p => !oldMap.has(pairKey(p)));

    if (removed.length === 0 && added.length === 0) continue;

    // Каждая строка diff несёт СТРУКТУРНУЮ подгруппу пары (item.subgroup:
    // '1' | '2' | '') — фильтрация в buildScheduleDiffText идёт по полю,
    // а не по regex на тексте (предмет может сам содержать «· подгруппа 1»
    // в названии). Заголовок дня — не пара, у него subgroup ''.
    lines.push({ text: `<b>${dayHeader}</b>:`, subgroup: '' });
    for (const p of removed) lines.push({ text: `  ➖ ${pairBrief(p)}`, subgroup: pairSubgroupNum(p) });
    for (const p of added) lines.push({ text: `  ➕ ${pairBrief(p)}`, subgroup: pairSubgroupNum(p) });
  }

  if (lines.length === 0) return null;
  return { weekLabel, lines };
}

// Формирует итоговое сообщение об изменениях расписания.
function formatScheduleDiffBroadcast(group, changedWeeks) {
  // changedWeeks: [{ weekLabel, lines: [{ text, subgroup }, ...] }, ...]
  const parts = [];
  parts.push(`🔔 <b>Расписание группы ${escTg(group)} изменилось</b>`);
  parts.push('');
  for (const w of changedWeeks) {
    if (parts.length + w.lines.length + 2 > 3500) {
      parts.push('… (часть изменений опущена, см. на сайте)');
      break;
    }
    parts.push(`📅 <b>Неделя ${w.weekLabel}</b>`);
    for (const l of w.lines) {
      parts.push(l.text);
    }
    parts.push('');
  }
  return parts.join('\n');
}

// Формирует сообщение по ДЗ (полный текст — по решению пользователя).
function formatHwMessage(action, group, hw, prevHw) {
  const subject = escTg(hw.subject || '');
  const tp = hw.pairType && hw.pairType !== 'any'
    ? ` <i>[${escTg(pairTypeLabel(hw.pairType))}]</i>` : '';
  const sub = hw.subgroup && hw.subgroup !== 'any'
    ? ` · подгруппа ${escTg(hw.subgroup)}` : '';
  const task = escTg(hw.task || '(пусто)');
  const due = hw.dueDate ? escTg(hw.dueDate) : 'следующая пара';
  const author = hw.author ? ` · ${escTg(hw.author)}` : '';

  if (action === 'add') {
    return [
      `📝 <b>Новое ДЗ</b> · ${escTg(group)}${author}`,
      `<b>${subject}${tp}${sub}</b>`,
      `Срок: ${due}`,
      '',
      task,
    ].join('\n');
  }
  if (action === 'update') {
    const changed = [];
    if (prevHw) {
      if ((prevHw.subject || '') !== (hw.subject || '')) changed.push(`предмет: ${escTg(prevHw.subject)} → ${subject}`);
      if ((prevHw.dueDate || '') !== (hw.dueDate || '')) changed.push(`срок: ${escTg(prevHw.dueDate || 'след. пара')} → ${due}`);
      if ((prevHw.pairType || 'any') !== (hw.pairType || 'any')) changed.push(`тип: ${escTg(pairTypeLabel(prevHw.pairType))} → ${escTg(pairTypeLabel(hw.pairType))}`);
      // Изменение только текста задания не выносим отдельной строкой —
      // сам новый текст уже выводится ниже целиком.
    }
    const changeLine = changed.length ? `\n\nИзменения: ${changed.join('; ')}` : '';
    return [
      `✏️ <b>ДЗ изменено</b> · ${escTg(group)}${author}`,
      `<b>${subject}${tp}${sub}</b>`,
      `Срок: ${due}`,
      '',
      task,
      changeLine,
    ].join('\n');
  }
  // delete
  const delTask = escTg(hw.task || '');
  return [
    `🗑 <b>ДЗ удалено</b> · ${escTg(group)}`,
    `<b>${subject}${tp}${sub}</b>`,
    delTask,
  ].filter(Boolean).join('\n');
}

// ════════════════════════════════════════════════════════════════
// ── Rate limiting (защита от спама запросами) ───────────────────
// ════════════════════════════════════════════════════════════════
//
// Реализовано поверх существующей D1-таблицы kv (TTL через expires_at,
// авто-очистка cron'ом в 04:23 UTC через store.cleanupExpired()).
// Алгоритм: fixed-window counter. Ключ счётчика включает окно:
//   rl:<kind>:<id>:<windowStart>
// где windowStart = Math.floor(now / windowSec*1000). При смене окна
// счётчик автоматически начинает заново (новый ключ), старый протухает.
//
// Лимиты (окно 60 сек):
//   global  — 600/мин по IP, на ВСЕ запросы. Поднят с 120 (L9): за одним
//             cf-connecting-ip могут сидеть сотни честных людей (CGNAT/NAT
//             мобильных операторов, университетские/офисные сети) — лимит 120
//             давал ложные 429 «узлам». Легитимный writer-burst ~5-8 запросов
//             при sync => запас 75×; читатель ~1-3. Доля 429 отслеживается по
//             логу '[rate-limited]' (см. rateLimitResponse).
//   verify  — 10/мин по IP, на публичные POST /api/invite/verify,
//             /api/invite/create (D1-read oracle / owner-код).
//   tg      — 60/мин по IP, на POST /api/tg/webhook.
//
// Политика недоступности D1 (см. checkRateLimit / memRateLimitCheck):
//   verify (owner login/logout, invite verify/create) — fail-closed:
//     лимит проверить нельзя → 429 (degraded).
//   global/tg/tgstatus — fail-open, но ОГРАНИЧЕННЫЙ: обычный трафик
//     продолжает обслуживаться (не ломаем доступность сайта при аварии
//     D1 — за cf-connecting-ip сидят сотни честных людей за CGNAT/NAT),
//     однако включается in-memory fallback-счётчик, чтобы сбой D1 не
//     превращался в «безлимит» для чувствительных точек.
//
// ── Fixed-window: burst на границе окна (аудит, задача 11) ──
// Fixed-window counter допускает до 2× лимита за короткий промежуток у
// границы окна (600 в конце окна N + 600 в начале N+1 ≈ 1200 за ~2 сек).
// Это ПРИЗНАННЫЙ компромисс, алгоритм намеренно не меняется:
//   • Лимиты намеренно щадящие (global 600/мин, verify 10, tg 60,
//     tgstatus 30) и уже поднимались с 120, чтобы не давать ложных 429 за
//     CGNAT/NAT — за одним cf-connecting-ip сидят сотни честных людей.
//   • Burst 1200/2с с одного IP (или NAT-узла) поглощается самим
//     Cloudflare-краем и не является DoS-уровнем: лимит здесь — антиспам,
//     а не анти-DoS (см. RATE_LIMIT_GLOBAL).
//   • Любое ужесточение на границе вреднее, чем сам burst:
//       - sliding-window через D1 (вариант «а») — многократно больше
//         ключей/запросов к БД, а global-лимит применяется к КАЖДОМУ
//         запросу (горячий путь) — удвоение нагрузки на D1;
//       - сумма с соседним окном windowStart-1 (вариант «в») — из-за TTL
//         ключа (windowSec+60) счётчик прошлого окна живёт ещё минуту,
//         т.е. эффективный лимит нового окна режется почти вдвое → рост
//         ложных 429 у тяжёлых NAT-узлов (запрещено политикой доступности).
//   • Чувствительные оракулы (verify/tgstatus) защищают от перебора, а 2×
//     на границе (20–60 попыток) для 32-hex токенов и цифровых chatId всё
//     равно не даёт атакующему практического выигрыша.
// Решение: fixed-window оставляем как есть, ОБА пути счётчика (D1
// checkRateLimit и memory memRateLimitCheck) остаются согласованными.
// Если в будущем понадобится бороться с граничным burst — рассматривать
// вариант «в» (проверка/суммирование соседнего окна) с обязательным
// учётом рисков ложных 429, описанных выше.

// Именованные константы лимитов (окно 60 сек). Точечные лимиты (verify/tg/
// tgstatus) — антиспам-защита чувствительных публичных POST, их значения
// менять нельзя. Подробности политики (fail-open/fail-closed) — в checkRateLimit.
const RATE_LIMIT_WINDOW_SEC = 60;
// Глобальный лимит на все запросы с одного IP: 600/мин щадящий для общих IP
// (CGNAT/NAT), но всё ещё ограничивает скриптовый спам.
const RATE_LIMIT_GLOBAL = 600;
// Публичные «оракулы» (owner login/logout, invite verify/create): 10/мин.
const RATE_LIMIT_VERIFY = 10;
// Telegram webhook (шлёт исходящие в Telegram): 60/мин.
const RATE_LIMIT_TG_WEBHOOK = 60;
// /api/tg/status (оракул подписки по chatId): 30/мин.
// Значение намеренно НЕ ужесточаем: (1) сайт ходит сюда при каждом открытии
// настроек и смене группы, а за одним cf-connecting-ip (CGNAT/NAT) сидят десятки
// честных пользователей — лимит ниже дал бы ложные 429 (см. RATE_LIMIT_GLOBAL);
// (2) мусорный перебор отсекается строгой валидацией chatId (400 до D1),
// а валидный перебор цифр и так занимает годы при 30 запросах/мин/IP.
const RATE_LIMIT_TG_STATUS = 30;

// Извлекает IP клиента из каноничного заголовка Cloudflare.
// cf-connecting-ip ставится CF на каждом запросе к Worker.
function getClientIp(request) {
  return (request.headers.get('cf-connecting-ip') || '').trim();
}

// Дебаунс предупреждений о fail-open (не чаще раза в 30 сек), чтобы не заливать логи.
let lastRlWarnTime = 0;
function warnRlFailOpen(kind, id) {
  const now = Date.now();
  if (now - lastRlWarnTime < 30000) return;
  lastRlWarnTime = now;
  console.warn(`[ratelimit] no db (${kind}:${id}) — fail-open (bounded in-memory), verify — fail-closed`);
}

// ── In-memory fallback для fail-open категорий (global/tg/tgstatus) ──
// Когда D1 недоступен (нет биндинга или SQL-сбой), лимиты НЕ отключаем
// полностью («fail-open = безлимит»), а переходим на приблизительный
// счётчик в памяти ТЕКУЩЕГО изолята Worker. Это сохраняет доступность
// (лимит мягче, не нагружает D1, не даёт ложных 429 честным пользователям
// за CGNAT/NAT), но не позволяет во время аварии D1 забивать чувствительные
// точки без всякого ограничения.
// Ограничения (осознанно): счётчик per-isolate — изолятов несколько на
// локацию, и они пересоздаются, потому это лишь defense-in-depth ВЕРХНЕЙ
// границы, а не точный лимит. Ключ — `kind:id:windowStart`; старые окна
// чистятся оппортунистически, чтобы Map не рос бесконечно.
const memRlCounts = new Map();
const MEM_RL_MAX_KEYS = 2048;
function memRateLimitCheck(id, kind, limit, windowSec) {
  const now = Date.now();
  const windowStart = Math.floor(now / (windowSec * 1000));
  const key = `${kind}:${id}:${windowStart}`;
  const count = (memRlCounts.get(key) || 0) + 1;
  memRlCounts.set(key, count);

  // Оппортунистическая очистка: убираем протухшие окна, когда Map достиг порога,
  // чтобы память изолята не росла бесконечно при интенсивном трафике.
  if (memRlCounts.size >= MEM_RL_MAX_KEYS) {
    const cutoffWindow = Math.floor((now - 2 * windowSec * 1000) / (windowSec * 1000));
    for (const [k, c] of memRlCounts) {
      const ws = Number(k.slice(k.lastIndexOf(':') + 1));
      if (Number.isFinite(ws) && ws < cutoffWindow) memRlCounts.delete(k);
    }
  }

  if (count > limit) {
    const windowEndMs = (windowStart + 1) * windowSec * 1000;
    const retryAfter = Math.max(1, Math.ceil((windowEndMs - now) / 1000));
    return { limited: true, retryAfter, kind, id, count, limit, windowStart, degraded: true };
  }
  return { limited: false };
}

// Атомарно инкрементирует счётчик и проверяет лимит.
// Возвращает { limited: false } или { limited: true, retryAfter: <сек> }.
// Политика при недоступности D1:
//   failClosed=false (global/tg/tgstatus) — fail-open, но ОГРАНИЧЕННЫЙ:
//     переходим на in-memory fallback-счётчик (memRateLimitCheck), чтобы
//     авария D1 не превращалась в «безлимит» для чувствительных точек.
//   failClosed=true (verify: owner login/invite) — fail-closed
//     ({ limited: true, retryAfter: 60, degraded: true }): лимит проверить нельзя → отказ.
async function checkRateLimit(store, id, kind, limit, windowSec, opts = {}) {
  const { failClosed = false } = opts;
  if (!store || !store._db || !id) {
    warnRlFailOpen(kind, id);
    if (failClosed) return { limited: true, retryAfter: 60, degraded: true, kind, id };
    return memRateLimitCheck(id, kind, limit, windowSec);
  }
  const now = Date.now();
  const windowStart = Math.floor(now / (windowSec * 1000));
  const key = `rl:${kind}:${id}:${windowStart}`;
  const expiresAt = now + (windowSec + 60) * 1000; // +60 сек запас на TTL

  try {
    // Один атомарный запрос: UPSERT + RETURNING post-image счётчика.
    // Гонки нет: SQLite сериализует запись, RETURNING возвращает значение ПОСЛЕ инкремента.
    // value храним как TEXT (как всё в kv), поэтому ON CONFLICT — CAST,
    // а RETURNING CAST(value AS INTEGER) AS count возвращает уже число.
    const row = await store._db
      .prepare(
        `INSERT INTO kv (key, value, expires_at, updated_at) VALUES (?, '1', ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = CAST(CAST(value AS INTEGER) + 1 AS TEXT),
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at
         RETURNING CAST(value AS INTEGER) AS count`
      )
      .bind(key, expiresAt, now)
      .first();
    const count = row ? row.count : 1;

    if (count > limit) {
      // Сколько секунд до конца окна.
      const windowEndMs = (windowStart + 1) * windowSec * 1000;
      const retryAfter = Math.max(1, Math.ceil((windowEndMs - now) / 1000));
      // Доп. поля (kind/id/count/limit/windowStart) — для структурированного
      // лога '[rate-limited]' при 429 (мониторинг доли блокировок, L9).
      return { limited: true, retryAfter, kind, id, count, limit, windowStart };
    }
    return { limited: false };
  } catch (err) {
    // D1-сбой на уровне SQL: та же политика, что при недоступности базы —
    // fail-open, но ограниченный in-memory fallback-счётчиком (см. выше).
    console.warn(`[ratelimit] db error (${kind}:${id}): ${err.message}`);
    if (failClosed) return { limited: true, retryAfter: 60, degraded: true, kind, id };
    return memRateLimitCheck(id, kind, limit, windowSec);
  }
}

// Формирует 429-ответ с понятным сообщением и Retry-After.
// corsHeaders нужны, чтобы фронтенд (другой origin) мог прочитать тело.
// details — данные счётчика для мониторинга (L9): при передаче логируем
// структурированную строку '[rate-limited] kind=… ip=… windowStart=…
// count=… limit=…' (по ней через wrangler tail отслеживается доля 429).
// Ничего из тела запроса не логируется.
function rateLimitResponse(corsHeaders, retryAfter, details) {
  if (details) {
    console.warn(
      `[rate-limited] kind=${details.kind || 'unknown'} ` +
      `ip=${details.ip || 'unknown'} ` +
      `windowStart=${details.windowStart !== undefined ? details.windowStart : 'unknown'} ` +
      `count=${details.count !== undefined ? details.count : 'unknown'} ` +
      `limit=${details.limit !== undefined ? details.limit : 'unknown'}`
    );
  }
  const headers = {
    ...securityHeaders,
    ...corsHeaders,
    'Content-Type': 'application/json',
    'Retry-After': String(retryAfter || 5),
  };
  return new Response(
    JSON.stringify({
      error: 'Слишком много запросов. Попробуйте через несколько секунд.',
      retryAfter: retryAfter || 5,
    }),
    { status: 429, headers }
  );
}

// Единая точка применения лимитов. Возвращает Response(429) или null.
// Вызывается из fetch() после OPTIONS, до маршрутизации.
// Чувствительные публичные POST: invite verify/create и owner login/logout —
// D1-read oracle / оракул кода владельца. Для них — fail-closed (см. checkRateLimit).
function isVerifyPath(path) {
  return path === '/api/invite/verify' || path === '/api/invite/create' ||
         path === '/api/owner/login' || path === '/api/owner/logout' ||
         path === '/api/writer/logout';
}

// true, если запрос несёт Authorization: Bearer <32-hex> — ровно те запросы,
// которые в resolveAuth делают D1-read inv:{token} (поиск writer-инвайта).
// Эта D1-проба не покрыта точечным лимитом verify-путей, поэтому считается
// в той же категории verify (общий счётчик 10/мин/IP, fail-closed) для ЛЮБЫХ
// методов (GET/POST/PUT/DELETE). Regex обязан совпадать с INVITE_TOKEN_RE в
// resolveAuth: мусорные/короткие/не-32-hex Bearer не делают D1-read, поэтому
// в счётчик не попадают (защита от DoS на счётчик мусорными заголовками).
function isBearerInviteToken(request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7).trim();
  return INVITE_TOKEN_RE.test(token);
}

async function applyRateLimits(store, request, path, method, corsHeaders) {
  const ip = getClientIp(request);
  // Bearer-инвайт-проба считается в категории verify (см. isBearerInviteToken).
  const bearerInvite = isBearerInviteToken(request);
  if (!ip) {
    // fail-closed для чувствительных запросов: без IP лимит не проверить
    // (за CF не случается). Покрываем и verify-пути (POST), и Bearer-инвайт
    // (любой метод — без IP не отличить легитимного владельца от оракула).
    if ((method === 'POST' && isVerifyPath(path)) || bearerInvite) {
      return rateLimitResponse(corsHeaders, 60, { kind: 'verify' });
    }
    return null;
  }

  // 1) Глобальный IP-лимит на ВСЕ запросы. 600/мин (см. RATE_LIMIT_GLOBAL):
  //    за одним cf-connecting-ip могут сидеть сотни людей (CGNAT/NAT).
  const global = await checkRateLimit(store, ip, 'global', RATE_LIMIT_GLOBAL, RATE_LIMIT_WINDOW_SEC);
  if (global.limited) return rateLimitResponse(corsHeaders, global.retryAfter, global);

  // 2) Точечные лимиты (поверх глобального).
  // verify-категория: публичные «оракулы» (invite verify/create, owner login/
  // logout, writer logout) + любой запрос с Bearer-инвайт-токеном (D1-read
  // inv:{token} в resolveAuth). Общий счётчик — заодно не даёт жечь D1
  // перебором Bearer-токенов вне POST-ограничений. fail-closed (см. checkRateLimit).
  if ((method === 'POST' && isVerifyPath(path)) || bearerInvite) {
    const rl = await checkRateLimit(store, ip, 'verify', RATE_LIMIT_VERIFY, RATE_LIMIT_WINDOW_SEC, { failClosed: true });
    if (rl.limited) {
      if (rl.degraded) console.warn('[ratelimit] verify degraded: D1 недоступен, запрос отклонён');
      return rateLimitResponse(corsHeaders, rl.retryAfter, rl);
    }
  }
  // Остальные точечные лимиты — только для POST.
  if (method === 'POST') {
    // TG webhook — публичный, шлёт исходящие в Telegram.
    if (path === '/api/tg/webhook') {
      const rl = await checkRateLimit(store, ip, 'tg', RATE_LIMIT_TG_WEBHOOK, RATE_LIMIT_WINDOW_SEC);
      if (rl.limited) return rateLimitResponse(corsHeaders, rl.retryAfter, rl);
    }
    // /api/tg/status — публичный оракул подписки по chatId: замедлить перебор.
    // Плюс строгая валидация chatId в handleTgStatus (только цифры, иначе 400
    // без чтения D1) — мусорные пробы не попадают даже в счётчик «ответов».
    if (path === '/api/tg/status') {
      const rl = await checkRateLimit(store, ip, 'tgstatus', RATE_LIMIT_TG_STATUS, RATE_LIMIT_WINDOW_SEC);
      if (rl.limited) return rateLimitResponse(corsHeaders, rl.retryAfter, rl);
    }
  }

  return null;
}
