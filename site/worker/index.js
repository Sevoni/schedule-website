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

const SCHEDULE_PAIR_KEYS = ['subject', 'teacher', 'room', 'type', 'subgroup', 'num', 'time'];

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

function sanitizeWeeks(weeks) {
  if (!Array.isArray(weeks)) return null;
  return weeks
    .map((w) => {
      if (!w || typeof w !== 'object' || Array.isArray(w)) return null;
      const out = {};
      if (w.value != null) out.value = sanitizeString(w.value, 60);
      if (w.text != null) out.text = sanitizeString(w.text, 250);
      return Object.keys(out).length ? out : null;
    })
    .filter((w) => w !== null);
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

// ── Лимит размера тела запроса (анти-DoS) ──────────────────────
// Читаем JSON тела не целиком в память, а с жёстким лимитом по мере
// чтения потока. Возвращает:
//   { ok: true, json }                      — тело прочитано и распарсено
//   { ok: false, tooLarge: true }           — превышен MAX_BODY_BYTES → 413
//   { ok: false, parseError: true }         — битый JSON → 400
const MAX_BODY_BYTES = 1024 * 1024; // 1 МБ

async function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  if (!request.body) return { ok: true, json: {} };
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

// Текущий request context (для ctx.waitUntil фоновых уведомлений).
// Устанавливается в начале fetch и используется в notifyGroupBg.
let currentCtx = null;

// ── Заголовки безопасности: применяются ко ВСЕМ /api/* ответам ─────────
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

// ── CORS: строгая политика вместо Access-Control-Allow-Origin: * ────────
// Разрешаем только проверенные origin'ы: preview-домены Cloudflare Pages
// (*.schedule-worker.pages.dev) + список из env-переменной ALLOWED_ORIGINS
// (через запятую). Same-origin и curl-запросы без Origin не требуют CORS —
// для них заголовков нет вообще.
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
    if (u.hostname.endsWith('.schedule-worker.pages.dev')) return true;
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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
    // убивая висящий fetch при завершении handler'а.
    currentCtx = context;

    // ── Rate limiting (защита от спама) ──────────────────
    // Применяется ко всем запросам до маршрутизации. Возвращает Response(429)
    // при превышении лимита или null — тогда выполняем обычный маршрут.
    // Использует D1 через store._db для атомарного инкремента счётчика.
    // При недоступности D1 — fail-open (пропускаем), чтобы не положить сайт.
    try {
      const limited = await applyRateLimits(store, request, path, method, corsHeaders);
      if (limited) return limited;
    } catch (rlErr) {
      console.log('[ratelimit] check failed (fail-open):', rlErr.message);
    }

    try {
      // ── Public endpoints ──────────────────────────────────
      if (path === '/api/status' && method === 'GET') {
        return await cachedGet(request, env, corsHeaders, () => handleStatus(request, env, corsHeaders));
      }
      if (path === '/api/schedule' && method === 'GET') {
        return await cachedGet(request, env, corsHeaders, () => handleGetSchedule(request, env, corsHeaders));
      }
      if (path === '/api/weeks' && method === 'GET') {
        return await cachedGet(request, env, corsHeaders, () => handleGetWeeks(request, env, corsHeaders));
      }
      if (path === '/api/schedules' && method === 'GET') {
        return await cachedGet(request, env, corsHeaders, () => handleGetSchedules(request, env, corsHeaders));
      }
      if (path === '/api/bootstrap' && method === 'GET') {
        return await cachedGet(request, env, corsHeaders, () => handleBootstrap(request, env, corsHeaders));
      }
      if (path === '/api/upload' && method === 'POST') {
        const guard = await requireWriter(request, env, corsHeaders);
        if (guard) return guard;
        return await handleUpload(request, env, corsHeaders);
      }
      if (path === '/api/subjects' && method === 'GET') {
        return await cachedGet(request, env, corsHeaders, () => handleGetSubjects(request, env, corsHeaders));
      }
      if (path === '/api/subjects' && method === 'POST') {
        const guard = await requireWriter(request, env, corsHeaders);
        if (guard) return guard;
        return await handlePutSubjects(request, env, corsHeaders);
      }
      if (path === '/api/hw' && method === 'GET') {
        return await cachedGet(request, env, corsHeaders, () => handleGetHw(request, env, corsHeaders));
      }
      if (path === '/api/hw' && method === 'POST') {
        const guard = await requireWriter(request, env, corsHeaders);
        if (guard) return guard;
        return await handleAddHw(request, env, corsHeaders);
      }
      if (path === '/api/hw' && method === 'PUT') {
        const guard = await requireWriter(request, env, corsHeaders);
        if (guard) return guard;
        return await handleUpdateHw(request, env, corsHeaders);
      }
      if (path === '/api/hw/batch' && method === 'PUT') {
        const guard = await requireWriter(request, env, corsHeaders);
        if (guard) return guard;
        return await handleBatchUpdateHw(request, env, corsHeaders);
      }
      if (path === '/api/hw' && method === 'DELETE') {
        const guard = await requireWriter(request, env, corsHeaders);
        if (guard) return guard;
        return await handleDeleteHw(request, env, corsHeaders);
      }
      if (path === '/api/hw/recalc' && method === 'POST') {
        const guard = await requireWriter(request, env, corsHeaders);
        if (guard) return guard;
        return await handleRecalcHw(request, env, corsHeaders);
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
        return await handleSyncFromCampus(request, env, corsHeaders);
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
      if (path === '/api/invite/verify' && method === 'POST') {
        return await handleInviteVerify(request, env, corsHeaders);
      }
      if (path === '/api/invite' && method === 'GET') {
        const guard = await requireWriter(request, env, corsHeaders);
        if (guard) return guard;
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
      if (path === '/api/tg/status' && method === 'GET') {
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
    } finally {
      currentCtx = null;
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

// Возвращает { group, role: 'owner'|'writer' } или null.
//   - Authorization: Bearer <token>:
//     * token совпал с env.OWNER_CODE (constant-time сравнение, timingSafeEqualStr) → owner (group из query/body)
//     * inv:{token} в KV → writer (group из записи)
//     * иначе null
//   - без заголовка, но с валидной HttpOnly-cookie owner_code → owner (viaCookie).
//     Cookie сверяется за постоянное время, D1 не трогается.
//   - иначе null (аноним = reader)
async function resolveAuth(request, env) {
  const store = createStore(env);
  if (!env.DB) return null;

  const authHeader = request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) {
      // Owner: секретный код из env. Группу берём из query/body — за это
      // отвечает вызывающий код.
      if (env.OWNER_CODE && timingSafeEqualStr(token, env.OWNER_CODE)) {
        return { role: 'owner', token };
      }

      // Writer: ищем inv:{token} в KV.
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

  // Authorization отсутствует — пробуем HttpOnly-cookie owner_code.
  // Код владельца JS не знает, D1 не затрагиваем.
  if (await ownerFromCookie(request, env)) {
    return { role: 'owner', viaCookie: true };
  }

  return null;
}

// Извлекает хэш владельца из HttpOnly cookie `owner_code` и сверяет с
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
    if (part.slice(0, eq).trim() !== 'owner_code') continue;
    let value = part.slice(eq + 1).trim();
    try { value = decodeURIComponent(value); } catch (_) { /* оставляем как есть */ }
    return timingSafeEqualStr(value, expected);
  }
  return false;
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

// Возвращает Response 403, если у запрошенного нет прав writer.
// Иначе возвращает null + значение не используется. Группа берётся из auth
// (writer) или из query/body (owner). Для reader — 403.
async function requireWriter(request, env, corsHeaders) {
  const auth = await resolveAuth(request, env);
  if (!auth || (auth.role !== 'writer' && auth.role !== 'owner')) {
    return jsonResponse({ error: 'Forbidden: writer access required' }, corsHeaders, 403);
  }
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
// Возвращает { link, id, token }.
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

  const bb = await readJsonBody(request);
  if (bb.tooLarge) return jsonResponse({ error: 'Payload Too Large' }, corsHeaders, 413);
  if (bb.parseError) return jsonResponse({ error: 'Bad JSON' }, corsHeaders, 400);
  const body = bb.json;
  let group = normalizeGroup(body.group);

  // owner может создавать приглашения для любой группы.
  if (!group || !isValidGroup(group)) {
    return jsonResponse({ error: 'Missing group' }, corsHeaders, 400);
  }

  const label = (body.label || '').toString().slice(0, 100);
  const token = crypto.randomUUID().replace(/-/g, '');
  const id = token.slice(0, 8);
  const createdAt = new Date().toISOString();

  const invRecord = { group, createdAt };
  if (label) invRecord.label = label;
  await store.put(`inv:${token}`, JSON.stringify(invRecord), {
    expirationTtl: INVITE_TTL,
  });

  // Добавляем в inv-by-group:{group}
  const listRaw = await store.get(`inv-by-group:${group}`, { type: 'json' }) || [];
  listRaw.push({ id, token, createdAt, label: label || undefined });
  await store.put(`inv-by-group:${group}`, JSON.stringify(listRaw), {
    expirationTtl: INVITE_TTL,
  });

  // Формируем ссылку. ORIGIN — origin текущего запроса (та же Workers-домена).
  // При желании можно задать env.INVITE_ORIGIN для канонической ссылки.
  // Токен кладём в hash-фрагмент (#invite=), а не в query (?token=), чтобы он
  // не попадал в серверные логи, историю переходов и кэши. Старые ссылки
  // с ?token= фронтенд по-прежнему понимает (см. consumeInviteTokenFromUrl).
  const origin = env.INVITE_ORIGIN || new URL(request.url).origin;
  const link = `${origin}/#invite=${token}`;

  return jsonResponse({ ok: true, link, id, token }, corsHeaders);
}

// POST /api/owner/login
// Body: { code }. Публичный (без Bearer). Если code совпал с env.OWNER_CODE
// (constant-time сравнение, timingSafeEqualStr) — ставит HttpOnly-куку owner_code и
// возвращает { ok: true }. Иначе 403. Cookie не видна JavaScript'у, но
// прикрепляется браузером к каждому запросу на этот же сайт — роль owner
// восстанавливается автоматически.
const OWNER_COOKIE_TTL = 2592000; // 30 дней (сек)
const OWNER_COOKIE_NAME = 'owner_code';

async function handleOwnerLogin(request, env, corsHeaders) {
  if (!env.OWNER_CODE) {
    return jsonResponse({ error: 'OWNER_CODE not configured' }, corsHeaders, 500);
  }

  const bb = await readJsonBody(request);
  if (bb.tooLarge) return jsonResponse({ error: 'Payload Too Large' }, corsHeaders, 413);
  if (bb.parseError) return jsonResponse({ error: 'Bad JSON' }, corsHeaders, 400);
  const body = bb.json;
  const code = (body.code || '').toString();
  if (!code || !timingSafeEqualStr(code, env.OWNER_CODE)) {
    return jsonResponse({ error: 'Forbidden: wrong owner code' }, corsHeaders, 403);
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
// HttpOnly-cookie owner_code (или Authorization: Bearer <OWNER_CODE>).
// D1 НЕ трогает — только постоянновременное сравнение хэша куки.
// Нужен фронтенду, чтобы восстановить права владельца после перезагрузки,
// даже когда /api/bootstrap пропускается из-за тёплых клиентских кешей.
// Ответ всегда приватный: он зависит от пользователя и не должен попадать
// ни в браузерный, ни в CDN-кеш.
async function handleOwnerStatus(request, env, corsHeaders) {
  const authHeader = request.headers.get('Authorization');
  const viaBearer = !!(env.OWNER_CODE &&
    authHeader && authHeader.startsWith('Bearer ') &&
    timingSafeEqualStr(authHeader.slice(7).trim(), env.OWNER_CODE));
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
// Публичный. Удаляет куку owner_code. Роль owner сбрасывается в браузере.
async function handleOwnerLogout(request, env, corsHeaders) {
  const headers = {
    ...securityHeaders,
    ...corsHeaders,
    'Content-Type': 'application/json',
    'Set-Cookie': `${OWNER_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
  };
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

// POST /api/invite/verify
// Body: { token }. Публичный (без auth). Возвращает { ok, group, token } либо 404.
async function handleInviteVerify(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const bb = await readJsonBody(request);
  if (bb.tooLarge) return jsonResponse({ error: 'Payload Too Large' }, corsHeaders, 413);
  if (bb.parseError) return jsonResponse({ error: 'Bad JSON' }, corsHeaders, 400);
  const body = bb.json;
  const token = (body.token || '').toString().trim();
  if (!token) {
    return jsonResponse({ error: 'Missing token' }, corsHeaders, 400);
  }

  const inv = await store.get(`inv:${token}`, { type: 'json' });
  if (!inv || !inv.group) {
    return jsonResponse({ error: 'Invite not found or revoked' }, corsHeaders, 404);
  }

  return jsonResponse({ ok: true, group: normalizeGroup(inv.group), token }, corsHeaders);
}

// GET /api/invite?group=...
// Только owner. Writer не имеет доступа к управлению ссылками.
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
  const items = listRaw.map(({ id, token, createdAt, label }) => ({
    id,
    token,
    createdAt,
    ...(label ? { label } : {}),
  }));
  return jsonResponse({ ok: true, items }, corsHeaders);
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

  const url = new URL(request.url);
  const id = (url.searchParams.get('id') || '').toString().trim();
  const group = normalizeGroup(url.searchParams.get('group'));
  if (!id || !group || !isValidGroup(group)) {
    return jsonResponse({ error: 'Missing id or group' }, corsHeaders, 400);
  }

  const listRaw = await store.get(`inv-by-group:${group}`, { type: 'json' }) || [];
  const item = listRaw.find(it => it.id === id);
  if (!item) {
    return jsonResponse({ error: 'Invite not found' }, corsHeaders, 404);
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

  const bb = await readJsonBody(request);
  if (bb.tooLarge) return jsonResponse({ error: 'Payload Too Large' }, corsHeaders, 413);
  if (bb.parseError) return jsonResponse({ error: 'Bad JSON' }, corsHeaders, 400);
  const body = bb.json;
  const id = (body.id || '').toString().trim();
  const group = normalizeGroup(body.group);
  if (!id || !group || !isValidGroup(group)) {
    return jsonResponse({ error: 'Missing id or group' }, corsHeaders, 400);
  }

  const listRaw = await store.get(`inv-by-group:${group}`, { type: 'json' }) || [];
  const idx = listRaw.findIndex(it => it.id === id);
  if (idx === -1) {
    return jsonResponse({ error: 'Invite not found' }, corsHeaders, 404);
  }

  const newLabel = (body.label || '').toString().slice(0, 100).trim();
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

  return jsonResponse({ ok: true, id, label: newLabel || '' }, corsHeaders);
}

// ── Constant-time string comparison ────────────────────────────
// Защищает от timing-атак при сравнении секретов (TG_WEBHOOK_SECRET и т.п.).
// Возвращает true, если строки равны. Длина сравнивается в постоянное время
// не идеально, но для секрета фиксированной длины этого достаточно.

function timingSafeEqualStr(a, b) {
  const sa = String(a == null ? '' : a);
  const sb = String(b == null ? '' : b);
  const ea = new TextEncoder().encode(sa);
  const eb = new TextEncoder().encode(sb);
  // Используем crypto.subtle через XOR-аккумулятор, чтобы не зависеть от
  // раннего выхода при первом несовпадении.
  let diff = ea.length ^ eb.length;
  const len = Math.min(ea.length, eb.length);
  for (let i = 0; i < len; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

// SHA-256 хэш OWNER_CODE (base64url) с кэшем на время жизни контекста.
// Пересчитывается только при смене значения env.OWNER_CODE.
let ownerCodeHashCache = { code: null, hash: null };
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  let bin = '';
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
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
      const cc = await cacheControlForGet(request, env);
      const finalCc = cc === CC_READER_GET ? CC_READER_GET_WEEKS : cc;
      return jsonResponse(data, corsHeaders, 200, { cacheControl: finalCc, isPrivate: await isAuthRequest(request, env) });
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

  const cc = await cacheControlForGet(request, env);
  const finalCc = cc === CC_READER_GET ? CC_READER_GET_WEEKS : cc;
  return jsonResponse(result, corsHeaders, 200, { cacheControl: finalCc, isPrivate: await isAuthRequest(request, env) });
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

  const baseCc = await cacheControlForGet(request, env);
  // Базовый /api/bootstrap?group= (без weeks) инвалидируется purge точно,
  // поэтому его TTL не трогаем. С weeks= — комбинации не перечислить, см.
  // CC_READER_GET_WEEKS (60 с).
  const finalCc = (validWeeks.length > 0 && baseCc === CC_READER_GET) ? CC_READER_GET_WEEKS : baseCc;
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
    const cleanWeeks = sanitizeWeeks(weeks);
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
    if (cleanWeekCode && !isValidWeekCode(cleanWeekCode)) {
      return jsonResponse({ error: 'Invalid weekCode' }, corsHeaders, 400);
    }
    const key = cleanWeekCode ? `schedule:${group}:${cleanWeekCode}` : `schedule:${group}:current`;
    await store.put(key, JSON.stringify(cleanData), { expirationTtl: 21600000 });

    const prevMeta = parseCampusMeta(await store.get(`campus-updated:${group}`));
    await store.put(`campus-updated:${group}`, JSON.stringify({
      campusUpdatedAt: prevMeta?.campusUpdatedAt || null,
      lastSync: new Date().toISOString(),
      lastWeek: cleanWeekCode || 'current',
    }), { expirationTtl: 21600000 });

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

    const updated = [];
    const validWeekCodes = [];
    const subjectStmts = [];

    for (const { weekCode, data } of schedules) {
      if (!weekCode || !data) continue;
      const cleanWeekCode = sanitizeString(weekCode, 60);
      const cleanData = sanitizeScheduleData(data);
      if (!cleanWeekCode || !isValidWeekCode(cleanWeekCode) || !cleanData) continue;
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
    await store.put(`campus-updated:${group}`, JSON.stringify({
      campusUpdatedAt: prevMeta?.campusUpdatedAt || null,
      lastSync: new Date().toISOString(),
      lastWeek: 'batch',
    }), { expirationTtl: 21600000 });

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
  await store.put(`campus-updated:${group}`, JSON.stringify({
    campusUpdatedAt: stored?.campusUpdatedAt || null,
    lastSync: new Date().toISOString(),
    lastWeek: stored?.lastWeek || 'check',
  }), { expirationTtl: 21600000 });

  return jsonResponse({ needUpdate, stored: stored?.campusUpdatedAt || null }, corsHeaders);
}

// ── POST /api/sync-from-campus ───────────────────────────────
// Фронт сам скачал и распарсил HTML с campus.syktsu.ru и прислал готовые
// расписания. Бэкенд сохраняет их, обновляет предметы (инкрементально по
// каждой неделе), пересчитывает ДЗ с dueMode='nextPair', и записывает
// дату обновления кампуса.
//
// Body: { group, campusUpdatedAt, schedules: [{ weekCode, data }, ...] }

async function handleSyncFromCampus(request, env, corsHeaders) {
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

  const updated = [];
  const diffs = []; // накопленные diff расписания для уведомления
  const subjectStmts = [];

  for (const { weekCode, data } of schedules) {
    if (!weekCode || !data) continue;
    const cleanWeekCode = sanitizeString(weekCode, 60);
    const cleanData = sanitizeScheduleData(data);
    if (!cleanWeekCode || !isValidWeekCode(cleanWeekCode) || !cleanData) continue;

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
  const prevCampusMeta = parseCampusMeta(await store.get(`campus-updated:${group}`));
  await store.put(`campus-updated:${group}`, JSON.stringify({
    campusUpdatedAt: (changed && campusUpdatedAt) ? campusUpdatedAt : (prevCampusMeta?.campusUpdatedAt || null),
    lastSync: new Date().toISOString(),
    lastWeek: 'batch',
  }), { expirationTtl: 21600000 });

  // Уведомляем подписчиков группы об изменениях в расписании (если есть diff).
  if (diffs.length > 0) {
    try {
      const buildText = buildScheduleDiffText(group, diffs);
      notifyGroupFilteredBg(env, group, buildText);
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

async function handleAddHw(request, env, corsHeaders) {
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

  const clean = sanitizeHwFields(body);

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
  const existing = await store.get(key, { type: 'json' }) || [];
  existing.push(item);
  await store.put(key, JSON.stringify(existing), { expirationTtl: 21600000 });

  notifyGroupFilteredBg(env, group, buildHwText('add', group, item, null));
  await purgeGroupCdnCache(env, group);

  return jsonResponse({ ok: true, item }, corsHeaders);
}

// ── PUT /api/hw ────────────────────────────────────────────────
// Body: { id, group, subject, pairType, subgroup, task, dueMode, dueDate, author }
// — обновляет все поля конкретного ДЗ.

async function handleUpdateHw(request, env, corsHeaders) {
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

  const key = `hw:${group}`;
  const existing = await store.get(key, { type: 'json' }) || [];
  const idx = existing.findIndex(h => h.id === id);
  if (idx === -1) {
    return jsonResponse({ error: 'Homework not found' }, corsHeaders, 404);
  }

  const prev = existing[idx];
  const clean = sanitizeHwFields(body);
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

  notifyGroupFilteredBg(env, group, buildHwText('update', group, item, prev));
  await purgeGroupCdnCache(env, group);

  return jsonResponse({ ok: true, item: existing[idx] }, corsHeaders);
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

  const key = `hw:${group}`;
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
    const newDate = upd.dueDate === undefined ? prev.dueDate : sanitizeString(upd.dueDate, 40);
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

async function handleDeleteHw(request, env, corsHeaders) {
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

  const key = `hw:${group}`;
  const existing = await store.get(key, { type: 'json' }) || [];
  const removed = existing.find(h => h.id === id);
  const filtered = existing.filter(h => h.id !== id);

  await store.put(key, JSON.stringify(filtered), { expirationTtl: 21600000 });

  if (removed) {
    notifyGroupFilteredBg(env, group, buildHwText('delete', group, removed, null));
  }
  await purgeGroupCdnCache(env, group);

  return jsonResponse({ ok: true, count: filtered.length }, corsHeaders);
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

  const sem = semester || currentSemesterKey();
  await store.put(`subjects:${group}:${sem}`, JSON.stringify(subjects), {
    expirationTtl: 365 * 24 * 60 * 60,
  });
  await purgeGroupCdnCache(env, group);
  return jsonResponse({ ok: true, semester: sem, count: subjects.length }, corsHeaders);
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
  const body = bb.ok ? bb.json : {};
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
  if (!isValidWeekCode(weekCode)) return null;

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
  return CC_READER_GET;
}

// Есть ли у запроса аутентификация (writer/owner): Bearer-токен ИЛИ
// валидная HttpOnly-cookie owner_code. Для таких ответов isPrivate=true:
// Vary:Authorization + private, чтобы CDN не смешивал их с reader-кешем.
async function isAuthRequest(request, env) {
  return (request.headers.get('Authorization') || '').startsWith('Bearer ') ||
    await ownerFromCookie(request, env);
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
async function cachedGet(request, env, corsHeaders, builder) {
  const hasBearer = (request.headers.get('Authorization') || '').startsWith('Bearer ');
  const isOwnerCookie = await ownerFromCookie(request, env);
  if (hasBearer || isOwnerCookie) {
    // Writer/owner — без кеша.
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
        return new Response(hit.body, { status: hit.status, headers: h });
      }
    } catch (_) {
      /* кеш недоступен — идём в builder */
    }
  }

  const resp = await builder();

  // Кешируем только успешные JSON-ответы.
  if (cache && resp.ok && resp.headers.get('Content-Type') === 'application/json') {
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
      if (typeof currentCtx !== 'undefined' && currentCtx && currentCtx.waitUntil) {
        currentCtx.waitUntil(cache.put(cacheKey, toStore).catch(() => {}));
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
      await store.put(`tg:subs:${group}`, JSON.stringify(list));
      await store.delete(`tg:chat:${group}`);
      return list;
    }
    return [];
  }
  if (!Array.isArray(raw)) return [];
  // Миграция: массив строк → массив объектов.
  if (raw.length && typeof raw[0] === 'string') {
    const migrated = raw.map(id => ({ chatId: String(id), subgroup: 'any' }));
    await store.put(`tg:subs:${group}`, JSON.stringify(migrated));
    return migrated;
  }
  return raw;
}

async function addGroupSubscriber(env, group, chatId, subgroup) {
  const store = createStore(env);
  const list = await getGroupSubscribers(env, group);
  const existing = list.find(s => String(s.chatId) === String(chatId));
  if (existing) {
    if (subgroup) existing.subgroup = subgroup;
  } else {
    list.push({ chatId: String(chatId), subgroup: subgroup || 'any' });
  }
  await store.put(`tg:subs:${group}`, JSON.stringify(list));
}

async function removeGroupSubscriber(env, group, chatId) {
  const store = createStore(env);
  const list = await getGroupSubscribers(env, group);
  const filtered = list.filter(s => String(s.chatId) !== String(chatId));
  if (filtered.length) await store.put(`tg:subs:${group}`, JSON.stringify(filtered));
  else await store.delete(`tg:subs:${group}`);
}

// Фоновая отправка уведомления: не блокирует ответ клиенту (через
// context.waitUntil), но гарантирует, что fetch к Telegram дойдёт до конца
// после отправки ответа — иначе при неблокирующем вызове Worker убивает
// висящий fetch при завершении handler'а и уведомления теряются.
function notifyGroupBg(env, group, text, opts = {}) {
  console.log('[tg] notifyGroupBg called for', group, 'ctx.waitUntil=', !!(currentCtx && typeof currentCtx.waitUntil === 'function'));
  const p = notifyGroup(env, group, text, opts).catch((e) =>
    console.log('[tg] notify skipped:', e && e.message)
  );
  if (currentCtx && typeof currentCtx.waitUntil === 'function') {
    currentCtx.waitUntil(p);
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
      await sendTgRichMessage(env, sub.chatId, c, { parseMode: opts.parseMode || 'HTML' });
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

function splitForTg(text, maxLen) {
  if (!text) return [];
  if (text.length <= maxLen) return [text];
  const out = [];
  const paragraphs = text.split('\n\n');
  let buf = '';
  for (const p of paragraphs) {
    if (p.length > maxLen) {
      if (buf) { out.push(buf); buf = ''; }
      for (let i = 0; i < p.length; i += maxLen) out.push(p.slice(i, i + maxLen));
      continue;
    }
    if ((buf + '\n\n' + p).length > maxLen) { out.push(buf); buf = p; }
    else { buf = buf ? buf + '\n\n' + p : p; }
  }
  if (buf) out.push(buf);
  return out;
}

// Экранирование пользовательского текста для Rich Markdown (GFM).
// `*` и `_` НЕ экранируем — это markdown-разметка (жирный/курсив),
// которую пользователь может вводить в тексте ДЗ. Непарные разделители
// GFM оставляет как есть, поэтому одиночные звёздочки не ломают текст.
function escMarkdown(s) {
  return String(s).replace(/[\\`~\[\]]/g, (ch) => '\\' + ch);
}

// Конвертация нашей HTML-разметки (escTg + <b>/<i>/<code>) в Rich Markdown —
// новый формат sendRichMessage (Bot API 10.1+). Rich Markdown совместим с
// GitHub Flavored Markdown и дополнительно принимает HTML-теги, но для
// красоты и читаемости переводим базовые теги в md-синтаксис.
function htmlToMarkdown(html) {
  const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
  const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => entities[m] || m);
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { out += escMarkdown(decode(html.slice(i))); break; }
    out += escMarkdown(decode(html.slice(i, lt)));
    const gt = html.indexOf('>', lt);
    if (gt === -1) { out += html.slice(lt); break; }
    const tag = html.slice(lt + 1, gt);
    if (tag === 'b' || tag === '/b') out += '**';
    else if (tag === 'i' || tag === '/i') out += '*';
    else if (tag === 'code' || tag === '/code') out += '`';
    else out += html.slice(lt, gt + 1); // незнакомый тег оставляем как есть
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
      await sendTgRichMessage(env, sub.chatId, c, { parseMode: 'HTML' });
    }
  }
}

function notifyGroupFilteredBg(env, group, buildText) {
  const p = notifyGroupFiltered(env, group, buildText).catch((e) =>
    console.log('[tg] notifyFiltered skipped:', e && e.message)
  );
  if (currentCtx && typeof currentCtx.waitUntil === 'function') {
    currentCtx.waitUntil(p);
  }
  return p;
}

// Генератор текста для diff расписания, фильтрованный по подгруппе.
function buildScheduleDiffText(group, diffs) {
  return async function (chatId, pref) {
    const filteredWeeks = [];
    for (const w of diffs) {
      const filteredLines = [];
      for (const line of w.lines) {
        const pairMatch = line.match(/^  [➕➖] (.+)$/);
        if (pairMatch) {
          const pairText = pairMatch[1];
          const subMatch = pairText.match(/ · подгруппа (\d)/);
          const pairSubgroup = subMatch ? subMatch[1] : '';
          if (!matchesSubgroup(pref, pairSubgroup)) continue;
        }
        filteredLines.push(line);
      }
      const hasPairs = filteredLines.some(l => l.startsWith('  '));
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

async function handleTgWebhook(request, env) {
  const store = createStore(env);
  if (!env.DB) return new Response('ok', { status: 200 });

  // Защита от подделки updates: Telegram при setWebhook с secret_token
  // шлёт заголовок X-Telegram-Bot-Api-Secret-Token на каждый запрос.
  // Секрет обязателен — без него webhook отключён (503), подделки не принимаются.
  if (!env.TG_WEBHOOK_SECRET) {
    console.error('[tg] FATAL: TG_WEBHOOK_SECRET not set — webhook disabled');
    return new Response('Webhook misconfigured: TG_WEBHOOK_SECRET is required', { status: 503 });
  }
  const provided = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!timingSafeEqualStr(provided, env.TG_WEBHOOK_SECRET)) {
    console.log('[tg] webhook rejected: bad secret_token');
    return new Response('Unauthorized', { status: 401 });
  }

  let update;
  const wb = await readJsonBody(request);
  if (!wb.ok) return new Response('ok', { status: 200 });
  update = wb.json;

  // ── Callback query (инлайн-кнопки выбора подгруппы) ──
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = String(cq.message && cq.message.chat && cq.message.chat.id);
    const data = cq.data || '';
    // data = "sub_any:GROUP" | "sub_1:GROUP" | "sub_2:GROUP"
    const cbMatch = data.match(/^sub_(any|\d):(.+)$/);
    if (cbMatch && chatId) {
      const subgroup = cbMatch[1] === 'any' ? 'any' : cbMatch[1];
      const group = normalizeGroup(cbMatch[2]);
      if (group && isValidGroup(group)) {
        // Сохраняем подписку + subgroup в tg:subs:{group}
        await addGroupSubscriber(env, group, chatId, subgroup);
        // Обновляем обратный индекс tg:groups:{chatId}
        const groupsRaw = await store.get(`tg:groups:${chatId}`, { type: 'json' }) || [];
        if (!groupsRaw.includes(group)) {
          groupsRaw.push(group);
          await store.put(`tg:groups:${chatId}`, JSON.stringify(groupsRaw));
        }

        const subLabel = subgroup === 'any' ? 'обе подгруппы' : `подгруппа ${subgroup}`;
        await tgApi(env, 'sendMessage', {
          chat_id: chatId,
          text: `✅ Подписка на группу <b>${escTg(group)}</b> (<i>${escTg(subLabel)}</i>) оформлена!\n\nУведомления придут при изменениях расписания и новых ДЗ.\n\nКоманды:\n/status — статус подписки\n/stop — отписаться`,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
        // Отвечаем на callback, чтобы убрать "часики" на кнопке.
        await tgApi(env, 'answerCallbackQuery', { callback_query_id: cq.id });
        return new Response('ok', { status: 200 });
      }
    }
    // Неизвестный callback — просто отвечаем.
    await tgApi(env, 'answerCallbackQuery', { callback_query_id: cq.id });
    return new Response('ok', { status: 200 });
  }

  // ── Обычные сообщения ──
  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat) return new Response('ok', { status: 200 });

  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

  // В групповых чатах игнорируем.
  if (isGroup) return new Response('ok', { status: 200 });

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
        return new Response('ok', { status: 200 });
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
        return new Response('ok', { status: 200 });
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
        text: '❌ Ты отписан от всех уведомлений.\n\nЧтобы снова подписаться: <code>/sub</code> <group>',
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
  return new Response('ok', { status: 200 });
}

async function unbindChat(env, chatId) {
  const store = createStore(env);
  const groupsRaw = await store.get(`tg:groups:${chatId}`, { type: 'json' }) || [];
  for (const g of groupsRaw) {
    const cur = await store.get(`tg:chat:${g}`);
    if (String(cur) === String(chatId)) await store.delete(`tg:chat:${g}`);
    await removeGroupSubscriber(env, g, chatId);
  }
  await store.delete(`tg:groups:${chatId}`);
}

// ── GET /api/tg/status?group=...&chatId=... ─────────────────────
// Возвращает { subscribed, botUsername } — подписан ли ПЕРЕДАННЫЙ chatId
// к этой группе (изоляция: каждый пользователь видит только свой статус).
// Отписка — только командой /stop в боте (webhook), где chatId берётся
// из самого апдейта Telegram (подписанного secret_token).

async function handleTgStatus(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  const url = new URL(request.url);
  const group = normalizeGroup(url.searchParams.get('group'));
  const chatId = url.searchParams.get('chatId') || '';
  if (!isValidGroup(group)) {
    return jsonResponse({ error: 'Invalid group' }, corsHeaders, 400);
  }
  const subs = await getGroupSubscribers(env, group);
  const existing = chatId ? subs.find(s => String(s.chatId) === String(chatId)) : null;
  return jsonResponse({
    subscribed: !!existing,
    botUsername: env.TG_BOT_USERNAME || '',
  }, corsHeaders);
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

// Сравнивает старую и новую неделю, возвращает массив строк-изменений по дням.
// Возвращает null, если изменений нет, либо структуру { weekLabel, lines: [...] }.
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

    const dayLines = [];
    dayLines.push(`<b>${dayHeader}</b>:`);
    for (const p of removed) dayLines.push(`  ➖ ${pairBrief(p)}`);
    for (const p of added) dayLines.push(`  ➕ ${pairBrief(p)}`);

    // Если day целиком «новая» — весь блок пойдёт в added.
    // Если day целиком «пропала» — весь блок в removed. Это уже покрыто выше.
    lines.push(dayLines.join('\n'));
  }

  if (lines.length === 0) return null;
  return { weekLabel, lines };
}

// Формирует итоговое сообщение об изменениях расписания.
function formatScheduleDiffBroadcast(group, changedWeeks) {
  // changedWeeks: [{ weekLabel, lines: [...] }, ...]
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
      parts.push(l);
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
//   global  — 120/мин по IP, на ВСЕ запросы. Легитимный writer-burst
//             ~5-8 запросов при sync => запас 15×. Читатель ~1-3.
//   verify  — 10/мин по IP, на публичные POST /api/invite/verify,
//             /api/invite/create (D1-read oracle / owner-код).
//   tg      — 60/мин по IP, на POST /api/tg/webhook.

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
  console.warn(`[ratelimit] no db (${kind}:${id}) — fail-open, лимиты отключены`);
}

// Атомарно инкрементирует счётчик и проверяет лимит.
// Возвращает { limited: false } или { limited: true, retryAfter: <сек> }.
// При ошибке D1 — fail-open (возвращает { limited: false }).
async function checkRateLimit(store, id, kind, limit, windowSec) {
  if (!store || !store._db || !id) {
    warnRlFailOpen(kind, id);
    return { limited: false };
  }
  const now = Date.now();
  const windowStart = Math.floor(now / (windowSec * 1000));
  const key = `rl:${kind}:${id}:${windowStart}`;
  const expiresAt = now + (windowSec + 60) * 1000; // +60 сек запас на TTL

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
    return { limited: true, retryAfter };
  }
  return { limited: false };
}

// Формирует 429-ответ с понятным сообщением и Retry-After.
// corsHeaders нужны, чтобы фронтенд (другой origin) мог прочитать тело.
function rateLimitResponse(corsHeaders, retryAfter) {
  const headers = {
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
async function applyRateLimits(store, request, path, method, corsHeaders) {
  const ip = getClientIp(request);
  if (!ip) return null; // без IP не лимитируем (не должно случаться за CF)

  // 1) Глобальный IP-лимит на ВСЕ запросы.
  const global = await checkRateLimit(store, ip, 'global', 120, 60);
  if (global.limited) return rateLimitResponse(corsHeaders, global.retryAfter);

  // 2) Точечные лимиты на публичные POST (поверх глобального).
  if (method === 'POST') {
    // Чувствительные: invite verify/create и owner login/logout — публичные,
    // D1-read oracle / оракул кода владельца.
    if (path === '/api/invite/verify' || path === '/api/invite/create' ||
        path === '/api/owner/login' || path === '/api/owner/logout') {
      const rl = await checkRateLimit(store, ip, 'verify', 10, 60);
      if (rl.limited) return rateLimitResponse(corsHeaders, rl.retryAfter);
    }
    // TG webhook — публичный, шлёт исходящие в Telegram.
    if (path === '/api/tg/webhook') {
      const rl = await checkRateLimit(store, ip, 'tg', 60, 60);
      if (rl.limited) return rateLimitResponse(corsHeaders, rl.retryAfter);
    }
  }

  return null;
}
