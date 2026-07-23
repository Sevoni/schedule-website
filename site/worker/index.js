import { createStore, setRequestLogger } from './store.js';

// Нормализация названия группы: trim + toLowerCase.
// Campus.syktsu.ru принимает любой регистр, но в БД храним всегда нижний,
// чтобы "131-Ибо" и "131-ИБо" не создавали разные записи.
function normalizeGroup(g) {
  return (g || '').trim().toLowerCase();
}

// Текущий request context (для ctx.waitUntil фоновых уведомлений).
// Устанавливается в начале fetch и используется в notifyGroupBg.
let currentCtx = null;

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Логирование производительности D1: привязываем общий logger к запросу.
    const store = createStore(env);
    setRequestLogger(store._logger);

    // context.waitUntil позволяет дать фоновым задачам (Telegram-уведомления)
    // дойти до конца ПОСЛЕ отправки ответа клиенту — не блокируя его, но и не
    // убивая висящий fetch при завершении handler'а.
    currentCtx = context;

    try {
      // ── Public endpoints ──────────────────────────────────
      if (path === '/api/status' && method === 'GET') {
        return await cachedGet(request, corsHeaders, () => handleStatus(request, env, corsHeaders));
      }
      if (path === '/api/schedule' && method === 'GET') {
        return await cachedGet(request, corsHeaders, () => handleGetSchedule(request, env, corsHeaders));
      }
      if (path === '/api/weeks' && method === 'GET') {
        return await cachedGet(request, corsHeaders, () => handleGetWeeks(request, env, corsHeaders));
      }
      if (path === '/api/schedules' && method === 'GET') {
        return await cachedGet(request, corsHeaders, () => handleGetSchedules(request, env, corsHeaders));
      }
      if (path === '/api/bootstrap' && method === 'GET') {
        return await cachedGet(request, corsHeaders, () => handleBootstrap(request, env, corsHeaders));
      }
      if (path === '/api/upload' && method === 'POST') {
        const guard = await requireWriter(request, env, corsHeaders);
        if (guard) return guard;
        return await handleUpload(request, env, corsHeaders);
      }
      if (path === '/api/subjects' && method === 'GET') {
        return await cachedGet(request, corsHeaders, () => handleGetSubjects(request, env, corsHeaders));
      }
      if (path === '/api/subjects' && method === 'POST') {
        const guard = await requireWriter(request, env, corsHeaders);
        if (guard) return guard;
        return await handlePutSubjects(request, env, corsHeaders);
      }
      if (path === '/api/hw' && method === 'GET') {
        return await cachedGet(request, corsHeaders, () => handleGetHw(request, env, corsHeaders));
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
        return await handleCheckCampusUpdate(request, env, corsHeaders);
      }
      if (path === '/api/sync-from-campus' && method === 'POST') {
        const guard = await requireWriter(request, env, corsHeaders);
        if (guard) return guard;
        return await handleSyncFromCampus(request, env, corsHeaders);
      }

      // ── Auth endpoints ───────────────────────────────────
      if (path === '/api/auth' && method === 'POST') {
        return await handleAuth(request, env, corsHeaders);
      }
      if (path === '/api/group/register' && method === 'POST') {
        return await handleGroupRegister(request, env, corsHeaders);
      }

      // ── Invite endpoints (writer/owner only) ────────────
      if (path === '/api/invite/create' && method === 'POST') {
        const guard = await requireWriter(request, env, corsHeaders);
        if (guard) return guard;
        return await handleInviteCreate(request, env, corsHeaders);
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
      if (path === '/api/tg/set-webhook' && method === 'POST') {
        return await handleTgSetWebhook(request, env, corsHeaders);
      }
      if (path === '/api/tg/subscribe' && method === 'POST') {
        return await handleTgSubscribe(request, env, corsHeaders);
      }
      if (path === '/api/tg/unsubscribe' && method === 'POST') {
        return await handleTgUnsubscribe(request, env, corsHeaders);
      }
      if (path === '/api/tg/status' && method === 'GET') {
        return await handleTgStatus(request, env, corsHeaders);
      }

      store._logger.flush(`${method} ${path}`);
      return jsonResponse({ error: 'Not Found' }, corsHeaders, 404);
    } catch (e) {
      store._logger.flush(`${method} ${path} (error)`);
      return jsonResponse({ error: e.message }, corsHeaders, 500);
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
//   owner   — token === env.OWNER_CODE. writer + управление приглашениями.
//
// Token'ы приглашений — случайные 32-символьные строки (crypto.randomUUID
// без дефисов). Хранятся в KV: inv:{token} -> { group, createdAt, label? }.
// Код владельца — секрет env.OWNER_CODE (через `wrangler secret put`).

const INVITE_TTL = 365 * 24 * 60 * 60; // 365 дней

// Возвращает { group, role: 'owner'|'writer' } или null.
//   - Authorization: Bearer <token>:
//     * token === env.OWNER_CODE → owner (group из query/body)
//     * inv:{token} в KV → writer (group из записи)
//     * иначе null
//   - без заголовка → null (аноним = reader)
async function resolveAuth(request, env) {
  const store = createStore(env);
  if (!env.DB) return null;

  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7).trim();
  if (!token) return null;

  // Owner: секретный код из env. Группу берём из query/body — за это
  // отвечает вызывающий код.
  if (env.OWNER_CODE && token === env.OWNER_CODE) {
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

  return null;
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
    // clone, чтобы обработчик ниже тоже мог звать .json()
    const clone = request.clone();
    const body = await clone.json().catch(() => ({}));
    return normalizeGroup(body.group) || null;
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
  return null; // ок
}

// ── POST /api/auth ─────────────────────────────────────────────
// Body: { group, password }
// Returns: { token, group }

async function handleAuth(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const { group: _group, password } = await request.json();
  const group = normalizeGroup(_group);

  if (!group || !password) {
    return jsonResponse({ error: 'Missing group or password' }, corsHeaders, 400);
  }

  const stored = await store.get(`group-pwd:${group}`);
  if (!stored) {
    return jsonResponse({ error: 'Group not registered' }, corsHeaders, 404);
  }

  // Compare passwords
  const hash = await sha256(password);
  if (hash !== stored) {
    return jsonResponse({ error: 'Wrong password' }, corsHeaders, 401);
  }

  // Create token
  const token = btoa(JSON.stringify({ group, ts: Date.now() }));
  return jsonResponse({ token, group }, corsHeaders);
}

// ── POST /api/group/register ───────────────────────────────────
// Body: { group, password }
// Creates a new group with a password. First-time only.
// If group already exists, requires the old password to change it.

async function handleGroupRegister(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const { group: _group, password } = await request.json();
  const group = normalizeGroup(_group);

  if (!group || !password) {
    return jsonResponse({ error: 'Missing group or password' }, corsHeaders, 400);
  }

  if (password.length < 4) {
    return jsonResponse({ error: 'Password must be at least 4 characters' }, corsHeaders, 400);
  }

  const existing = await store.get(`group-pwd:${group}`);
  if (existing) {
    return jsonResponse({ error: 'Group already registered' }, corsHeaders, 409);
  }

  const hash = await sha256(password);
  await store.put(`group-pwd:${group}`, hash);

  // Auto-login: return token
  const token = btoa(JSON.stringify({ group, ts: Date.now() }));
  return jsonResponse({ ok: true, token, group }, corsHeaders);
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
// Body: { group, label?, dryRun? }. Требует owner. Для owner — group из body.
// При dryRun=true — только проверяет права owner, НЕ создаёт ссылку
// (используется для авто-claim'а владельца по ссылке ?owner=<code>).
// Возвращает { link, id, token } (без dryRun) или { ok: true } (с dryRun).
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

  const body = await request.json().catch(() => ({}));
  const dryRun = body.dryRun === true || body.dryRun === 'true';

  if (dryRun) {
    // Только подтверждаем права owner, не создавая ссылку.
    return jsonResponse({ ok: true }, corsHeaders);
  }

  let group = normalizeGroup(body.group);

  // owner может создавать приглашения для любой группы.
  if (!group) {
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
  const origin = env.INVITE_ORIGIN || new URL(request.url).origin;
  const link = `${origin}/?token=${token}`;

  return jsonResponse({ ok: true, link, id, token }, corsHeaders);
}

// POST /api/invite/verify
// Body: { token }. Публичный (без auth). Возвращает { ok, group, token } либо 404.
async function handleInviteVerify(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const body = await request.json().catch(() => ({}));
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
  if (!group) {
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
  if (!id || !group) {
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

  const body = await request.json().catch(() => ({}));
  const id = (body.id || '').toString().trim();
  const group = normalizeGroup(body.group);
  if (!id || !group) {
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

// ── SHA-256 hash helper ────────────────────────────────────────

async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── GET /api/schedule?group=...&week=... ────────────────────────

async function handleGetSchedule(request, env, corsHeaders) {
  const url = new URL(request.url);
  const group = normalizeGroup(url.searchParams.get('group') || env.DEFAULT_GROUP || '131-ИБо');
  const weekCode = url.searchParams.get('week');

  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  if (weekCode) {
    const data = await store.get(`schedule:${group}:${weekCode}`, { type: 'json' });
    if (data) return jsonResponse(data, corsHeaders, 200, { cacheControl: cacheControlForGet(request), isPrivate: !!(request.headers.get('Authorization') || '').startsWith('Bearer ') });
    return jsonResponse({ error: 'Week not found' }, corsHeaders, 404);
  }

  return jsonResponse({ error: 'Missing week parameter' }, corsHeaders, 400);
}

// ── GET /api/weeks?group=... ───────────────────────────────────

async function handleGetWeeks(request, env, corsHeaders) {
  const url = new URL(request.url);
  const group = normalizeGroup(url.searchParams.get('group') || env.DEFAULT_GROUP || '131-ИБо');

  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const data = await store.get(`weeks:${group}`, { type: 'json' });
  if (data) return jsonResponse(data, corsHeaders, 200, { cacheControl: cacheControlForGet(request), isPrivate: !!(request.headers.get('Authorization') || '').startsWith('Bearer ') });
  return jsonResponse({ error: 'No weeks data' }, corsHeaders, 404);
}

// ── GET /api/schedules?group=...&weeks=w1,w2,w3 ───────────────
// Агрегатор: возвращает сразу несколько недель одним SELECT ... IN (...).
// Возвращает { [weekCode]: data }. Заменяет N параллельных /api/schedule
// (каждый со своим HTTP-RTT) одним запросом — критично для открытия без VPN.

async function handleGetSchedules(request, env, corsHeaders) {
  const url = new URL(request.url);
  const group = normalizeGroup(url.searchParams.get('group') || env.DEFAULT_GROUP || '131-ИБо');
  const weeksParam = url.searchParams.get('weeks') || '';
  const weeks = weeksParam.split(',').map((s) => s.trim()).filter(Boolean);

  if (weeks.length === 0) {
    return jsonResponse({ error: 'Missing weeks parameter' }, corsHeaders, 400);
  }

  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const keys = weeks.map((w) => `schedule:${group}:${w}`);
  const { entries } = await store.getMany(keys, { type: 'json' });

  const result = {};
  for (const e of entries) {
    if (e.value == null) continue;
    // e.key === `schedule:{group}:{week}` → вырезаем weekCode
    const weekCode = e.key.slice(`schedule:${group}:`.length);
    result[weekCode] = e.value;
  }

  return jsonResponse(result, corsHeaders, 200, { cacheControl: cacheControlForGet(request), isPrivate: !!(request.headers.get('Authorization') || '').startsWith('Bearer ') });
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
  const group = normalizeGroup(url.searchParams.get('group') || env.DEFAULT_GROUP || '131-ИБо');
  const weeksParam = url.searchParams.get('weeks') || '';
  const weeks = weeksParam.split(',').map((s) => s.trim()).filter(Boolean);

  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  // Параллельно читаем weeks, hw, subjects, campusUpdatedAt и расписания.
  const semester = currentSemesterKey();
  const parallel = [
    store.get(`weeks:${group}`, { type: 'json' }),
    store.get(`hw:${group}`, { type: 'json' }),
    store.get(`subjects:${group}:${semester}`, { type: 'json' }),
    store.get(`campus-updated:${group}`),
  ];
  if (weeks.length > 0) {
    const schedKeys = weeks.map((w) => `schedule:${group}:${w}`);
    parallel.push(store.getMany(schedKeys, { type: 'json' }));
  } else {
    parallel.push(Promise.resolve(null));
  }

  const [weeksData, hwData, subjectsData, campusUpdatedAt, schedResult] = await Promise.all(parallel);

  let weeksDb = weeksData || [];
  const schedules = {};
  if (schedResult && Array.isArray(schedResult.entries)) {
    const prefix = `schedule:${group}:`;
    for (const e of schedResult.entries) {
      if (e.value == null) continue;
      const weekCode = e.key.slice(prefix.length);
      schedules[weekCode] = e.value;
    }
  }

  // Если weeks в БД пусты, но есть расписания — восстанавливаем список недель
  // из данных расписаний (weekStart/weekEnd). Это покрывает случай, когда
  // syncWeeksFromCampus был недоступен, но расписания были загружены.
  if (weeksDb.length === 0) {
    // Если schedResult пуст (не передали weekCodes в запросе), сканируем
    // D1 по префиксу schedule:{group}: чтобы найти все расписания.
    if (Object.keys(schedules).length === 0) {
      try {
        const { entries } = await store.listValues({ prefix: `schedule:${group}:`, type: 'json' });
        if (entries && entries.length > 0) {
          const prefix = `schedule:${group}:`;
          for (const e of entries) {
            if (e.value == null) continue;
            const weekCode = e.key.slice(prefix.length);
            if (weekCode && weekCode !== 'current') schedules[weekCode] = e.value;
          }
        }
      } catch (e) {
        console.log('schedule scan for weeks recovery failed:', e.message);
      }
    }

    if (Object.keys(schedules).length > 0) {
      weeksDb = Object.entries(schedules).map(([weekCode, data]) => {
        const weekNum = weekCode.split('_')[0];
        const weekStart = data?.weekStart || '';
        const weekEnd = data?.weekEnd || '';
        const dates = [weekStart, weekEnd].filter(Boolean);
        const text = `${weekNum} неделя${dates.length ? ' (' + dates.join(' - ') + ')' : ''}`;
        return { value: weekCode, text, weekNum, dates };
      });
      weeksDb.sort((a, b) => (a.weekNum || '').localeCompare(b.weekNum || '', undefined, { numeric: true }));
      // Сохраняем восстановленный список для будущих запросов
      try {
        await store.put(`weeks:${group}`, JSON.stringify(weeksDb), { expirationTtl: 604800 });
      } catch (e) {
        console.log('weeks recovery save skipped:', e.message);
      }
    }
  }

  // subjects может прийти в трёх видах:
  //   - null/[]  → в БД пусто
  //   - старый формат (без поля subgroups) → фронт сам триггерит recomput
  //   - актуальный формат
  // Здесь ничего не нормализуем — отдаём как есть, фронтенд сам решает.
  return jsonResponse({
    weeks: weeksDb,
    schedules,
    hw: hwData || [],
    subjects: subjectsData || [],
    campusUpdatedAt: campusUpdatedAt || '',
  }, corsHeaders, 200, { cacheControl: cacheControlForGet(request), isPrivate: !!(request.headers.get('Authorization') || '').startsWith('Bearer ') });
}
// Frontend парсит campus.syktsu.ru в браузере и отправляет сюда на сохранение

async function handleUpload(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const body = await request.json();
  const { type } = body;

  if (type === 'weeks') {
    const { group: _group, weeks } = body;
    const group = normalizeGroup(_group);
    if (!group || !weeks) {
      return jsonResponse({ error: 'Missing group or weeks' }, corsHeaders, 400);
    }
    await store.put(`weeks:${group}`, JSON.stringify(weeks), { expirationTtl: 604800 });
    await purgeGroupCdnCache(env, group);
    return jsonResponse({ ok: true, type: 'weeks', count: weeks.length }, corsHeaders);
  }

  if (type === 'schedule') {
    const { group: _group, weekCode, data } = body;
    const group = normalizeGroup(_group);
    if (!group || !data) {
      return jsonResponse({ error: 'Missing group or data' }, corsHeaders, 400);
    }

    const key = weekCode ? `schedule:${group}:${weekCode}` : `schedule:${group}:current`;
    await store.put(key, JSON.stringify(data), { expirationTtl: 604800 });

    await store.put('sync:meta', JSON.stringify({
      lastSync: new Date().toISOString(),
      lastWeek: weekCode || 'current',
    }), { expirationTtl: 604800 });

    try {
      await updateSubjectsForCurrentSemester(env, group);
    } catch (e) {
      console.log('subjects update skipped:', e.message);
    }

    return jsonResponse({ ok: true, type: 'schedule', group, weekCode }, corsHeaders);
  }

  if (type === 'schedule-batch') {
    const { group: _group, schedules } = body;
    const group = normalizeGroup(_group);
    if (!group || !Array.isArray(schedules)) {
      return jsonResponse({ error: 'Missing group or schedules' }, corsHeaders, 400);
    }

    const updated = [];
    const validWeekCodes = [];
    const subjectStmts = [];

    for (const { weekCode, data } of schedules) {
      if (!weekCode || !data) continue;
      validWeekCodes.push(weekCode);

      const existing = await store.get(`schedule:${group}:${weekCode}`, { type: 'json' });
      const existingStr = existing ? JSON.stringify(stripComparable(existing)) : '';
      const newStr = JSON.stringify(stripComparable(data));

      if (existingStr !== newStr) {
        await store.put(`schedule:${group}:${weekCode}`, JSON.stringify(data), { expirationTtl: 604800 });
        updated.push(weekCode);

          // Инкрементально обновим список предметов этой недели (собираем stmt
          // для пакетной записи после цикла, вместо N последовательных put).
          try {
            const stmt = addSubjectsFromWeekStmt(env, group, weekCode, data);
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

    await store.put('sync:meta', JSON.stringify({
      lastSync: new Date().toISOString(),
      lastWeek: 'batch',
    }), { expirationTtl: 604800 });

    await purgeGroupCdnCache(env, group);

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

  const body = await request.json().catch(() => ({}));
  const { group: _group, campusUpdatedAt } = body;
  const group = normalizeGroup(_group);

  if (!group) {
    return jsonResponse({ error: 'Missing group' }, corsHeaders, 400);
  }

  const stored = await store.get(`campus-updated:${group}`);
  const needUpdate = !stored || stored !== (campusUpdatedAt || '');

  // Обновляем lastSync при каждом вызове 🔄, даже если изменений нет
  const meta = await store.get('sync:meta', { type: 'json' });
  await store.put('sync:meta', JSON.stringify({
    lastSync: new Date().toISOString(),
    lastWeek: meta?.lastWeek || 'check',
    campusUpdatedAt: meta?.campusUpdatedAt || null,
  }), { expirationTtl: 604800 });

  return jsonResponse({ needUpdate, stored: stored || null }, corsHeaders);
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

  const body = await request.json().catch(() => ({}));
  const { group: _group, campusUpdatedAt, schedules } = body;
  const group = normalizeGroup(_group);

  if (!group || !Array.isArray(schedules)) {
    return jsonResponse({ error: 'Missing group or schedules' }, corsHeaders, 400);
  }

  const updated = [];
  const diffs = []; // накопленные diff расписания для уведомления
  const subjectStmts = [];

  for (const { weekCode, data } of schedules) {
    if (!weekCode || !data) continue;

    const existing = await store.get(`schedule:${group}:${weekCode}`, { type: 'json' });
    const existingStr = existing ? JSON.stringify(stripComparable(existing)) : '';
    const newStr = JSON.stringify(stripComparable(data));

    if (existingStr !== newStr) {
      const isNewWeek = !existing;

      // Diff и уведомление собираем ТОЛЬКО для уже существовавших недель.
      // Появление новой недели в расписании (её раньше не было в KV) не
      // считаем «изменением» и не шлём про неё уведомление.
      if (!isNewWeek) {
        try {
          const d = diffScheduleWeek(stripComparable(existing), stripComparable(data));
          if (d) diffs.push(d);
        } catch (e) {
          console.log('diffScheduleWeek skipped:', e.message);
        }
      }

      await store.put(`schedule:${group}:${weekCode}`, JSON.stringify(data), { expirationTtl: 604800 });
      updated.push(weekCode);

      // Инкрементально обновляем список предметов этой недели (собираем stmt
      // для пакетной записи после цикла, вместо N последовательных put).
      try {
        const stmt = addSubjectsFromWeekStmt(env, group, weekCode, data);
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

    // Записываем дату обновления кампуса (если прислали)
  if (campusUpdatedAt) {
    await store.put(`campus-updated:${group}`, campusUpdatedAt, { expirationTtl: 604800 });
  }

  // Пересчёт ДЗ с dueMode='nextPair' — расписание могло измениться
  let hwResult = null;
  try {
    hwResult = await recalcHomeworkForGroup(env, group);
  } catch (e) {
    console.log('recalcHomeworkForGroup skipped:', e.message);
  }

  // Обновляем список недель из полученных расписаний, чтобы bootstrap мог
  // найти недели даже если syncWeeksFromCampus (campus) был недоступен.
  // Формируем week-объекты из weekCode + weekStart/weekEnd в данных.
  if (updated.length > 0) {
    try {
      const existingWeeks = await store.get(`weeks:${group}`, { type: 'json' }) || [];
      const existingMap = new Map(existingWeeks.map(w => [w.value, w]));
      for (const { weekCode, data } of schedules) {
        if (!weekCode || !data || existingMap.has(weekCode)) continue;
        const weekNum = weekCode.split('_')[0];
        const weekStart = data.weekStart || '';
        const weekEnd = data.weekEnd || '';
        const dates = [weekStart, weekEnd].filter(Boolean);
        const text = `${weekNum} неделя${dates.length ? ' (' + dates.join(' - ') + ')' : ''}`;
        existingMap.set(weekCode, { value: weekCode, text, weekNum, dates });
      }
      if (existingMap.size > existingWeeks.length) {
        const merged = Array.from(existingMap.values());
        merged.sort((a, b) => (a.weekNum || '').localeCompare(b.weekNum || '', undefined, { numeric: true }));
        await store.put(`weeks:${group}`, JSON.stringify(merged), { expirationTtl: 604800 });
      }
    } catch (e) {
      console.log('weeks update skipped:', e.message);
    }
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

  await store.put('sync:meta', JSON.stringify({
    lastSync: new Date().toISOString(),
    lastWeek: 'batch',
    campusUpdatedAt: campusUpdatedAt || null,
  }), { expirationTtl: 604800 });

  // Уведомляем подписчиков группы об изменениях в расписании (если есть diff).
  if (diffs.length > 0) {
    try {
      const text = formatScheduleDiffBroadcast(group, diffs);
      // Не блокируем ответ клиенту ожиданием Telegram (он может висеть 10-30с
  // из-за недоступности api.telegram.org из-под CF в РФ). Шлём в фоне.
  notifyGroupBg(env, group, text);
    } catch (e) {
      console.log('schedule notify skipped:', e.message);
    }
  }

  await purgeGroupCdnCache(env, group);

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
  const group = normalizeGroup(url.searchParams.get('group') || env.DEFAULT_GROUP || '131-ИБо');

  const data = await store.get(`hw:${group}`, { type: 'json' });
  // hw содержит данные всех студентов группы — кешируем для reader'ов на 30с.
  // Writer'ы (Authorization) видят актуальное состояние (no-store), чтобы при
  // только что добавленном ДЗ и сразу же загруженном списке не получить
  // устаревший кеш из CDN.
  return jsonResponse(data || [], corsHeaders, 200, { cacheControl: cacheControlForGet(request), isPrivate: !!(request.headers.get('Authorization') || '').startsWith('Bearer ') });
}

// ── POST /api/hw ───────────────────────────────────────────────

async function handleAddHw(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const body = await request.json();
  const { group: _group, subject, task, dueDate, dueMode, pairType, author, subgroup } = body;
  const group = normalizeGroup(_group);

  if (!group || !subject) {
    return jsonResponse({ error: 'Missing group or subject' }, corsHeaders, 400);
  }

  if (!dueMode || !['nextPair', 'date'].includes(dueMode)) {
    return jsonResponse({ error: 'Invalid dueMode' }, corsHeaders, 400);
  }

  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    subject,
    pairType: pairType || 'any',
    subgroup: subgroup || 'any',
    task: task || '',
    dueMode,
    dueDate: dueDate || '',
    author: author || '',
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
  await store.put(key, JSON.stringify(existing), { expirationTtl: 2592000 });

  notifyGroupBg(env, group, formatHwMessage('add', group, item, null));
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

  const body = await request.json();
  const { id, group: _group } = body;
  const group = normalizeGroup(_group);

  if (!id || !group) {
    return jsonResponse({ error: 'Missing id or group' }, corsHeaders, 400);
  }

  const key = `hw:${group}`;
  const existing = await store.get(key, { type: 'json' }) || [];
  const idx = existing.findIndex(h => h.id === id);
  if (idx === -1) {
    return jsonResponse({ error: 'Homework not found' }, corsHeaders, 404);
  }

  const prev = existing[idx];
  const item = {
    ...prev,
    subject: body.subject != null ? body.subject : prev.subject,
    pairType: body.pairType != null ? body.pairType : prev.pairType,
    subgroup: body.subgroup != null ? body.subgroup : prev.subgroup,
    task: body.task != null ? body.task : prev.task,
    dueMode: body.dueMode != null ? body.dueMode : prev.dueMode,
    author: body.author != null ? body.author : prev.author,
  };

  if (item.dueMode === 'nextPair') {
    item.dueDate = await computeNextPairDate(env, group, item.subject, item.pairType, new Date(prev.createdAt), item.subgroup);
  } else {
    item.dueDate = body.dueDate || '';
  }

  existing[idx] = item;
  await store.put(key, JSON.stringify(existing), { expirationTtl: 2592000 });

  notifyGroupBg(env, group, formatHwMessage('update', group, item, prev));
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

  const body = await request.json();
  const { group: _group, updates } = body;
  const group = normalizeGroup(_group);

  if (!group || !Array.isArray(updates) || updates.length === 0) {
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
    const newDate = upd.dueDate === undefined ? prev.dueDate : upd.dueDate;
    if (newDate !== prev.dueDate) {
      existing[idx] = { ...prev, dueDate: newDate };
      updated.push(existing[idx]);
      changed = true;
    } else {
      // Не изменилось — не пишем в updated, но и в notFound тоже не относим.
    }
  }

  if (changed) {
    await store.put(key, JSON.stringify(existing), { expirationTtl: 2592000 });
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
  const group = normalizeGroup(url.searchParams.get('group') || env.DEFAULT_GROUP || '131-ИБо');

  if (!id) {
    return jsonResponse({ error: 'Missing id' }, corsHeaders, 400);
  }

  const key = `hw:${group}`;
  const existing = await store.get(key, { type: 'json' }) || [];
  const removed = existing.find(h => h.id === id);
  const filtered = existing.filter(h => h.id !== id);

  await store.put(key, JSON.stringify(filtered), { expirationTtl: 2592000 });

  if (removed) {
    notifyGroupBg(env, group, formatHwMessage('delete', group, removed, null));
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
  const group = normalizeGroup(url.searchParams.get('group') || env.DEFAULT_GROUP || '131-ИБо');
  const semester = currentSemesterKey();

  const key = `subjects:${group}:${semester}`;
  let data = await store.get(key, { type: 'json' });

  if (!data || data.length === 0 || (data[0] && !('subgroups' in data[0]))) {
    try {
      await updateSubjectsForCurrentSemester(env, group);
      data = await store.get(key, { type: 'json' });
    } catch (e) {
      console.log('subjects auto-recompute failed:', e.message);
    }
  }

  return jsonResponse({ semester, subjects: data || [] }, corsHeaders, 200, { cacheControl: cacheControlForGet(request), isPrivate: !!(request.headers.get('Authorization') || '').startsWith('Bearer ') });
}

// ── POST /api/subjects ─────────────────────────────────────────
// Body: { group, semester?, subjects } — пересохраняет список предметов.

async function handlePutSubjects(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) {
    return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  }

  const body = await request.json();
  const { group: _group, subjects, semester } = body;
  const group = normalizeGroup(_group);
  if (!group || !Array.isArray(subjects)) {
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

  const body = await request.json().catch(() => ({}));
  const group = normalizeGroup(body.group) || env.DEFAULT_GROUP || '131-ИБо';

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
// Используется в редких случаях (одиночный schedule-upload, миграция старых
// данных при GET). Пересчитывает недельные вклады всех расписаний семестра
// и пересобирает агрегат. Горячий путь синхронизации им не пользуется.

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
    await store.put(key, JSON.stringify(updatedItems), { expirationTtl: 2592000 });
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

  const meta = await store.get('sync:meta', { type: 'json' });

  let campusUpdatedAt = meta?.campusUpdatedAt || null;
  if (group && !campusUpdatedAt) {
    campusUpdatedAt = await store.get(`campus-updated:${group}`);
  }

  return jsonResponse({
    db: true,
    lastSync: meta?.lastSync || null,
    lastWeek: meta?.lastWeek || null,
    campusUpdatedAt: campusUpdatedAt || null,
  }, corsHeaders, 200, { cacheControl: cacheControlForGet(request), isPrivate: !!(request.headers.get('Authorization') || '').startsWith('Bearer ') });
}

// ── Helper ─────────────────────────────────────────────────────

// Кеширование на стороне Cloudflare CDN (Custom Domain — kampussgu.dpdns.org).
// workers.dev CDN не кеширует, но кастомный домен через Workers Route — да.
// Стратегия:
//   - reader (нет Authorization):  public,  s-maxage=300, max-age=60  (CDN 5 мин, браузер 1 мин)
//   - writer (есть Authorization): private, no-store                  (приватность)
// Варьируем по Authorization, чтобы CDN не смешивал кеши reader/writer.
const CC_READER_GET  = 'public, max-age=60, s-maxage=300';
const CC_WRITER_GET  = 'private, no-store';
const CC_NO_STORE    = 'no-store';

function cacheControlForGet(request) {
  const auth = request.headers.get('Authorization');
  return auth && auth.startsWith('Bearer ') ? CC_WRITER_GET : CC_READER_GET;
}

// Инвалидация CDN-кеша для группы после записи. Удаляем кешированные GET-
// ответы для этой группы, чтобы следующий reader сразу увидел свежие данные.
// Cache API на кастомном домене работает; на workers.dev — нет (игнорируем
// ошибку). Это НЕ считает дополнительным вызовом воркера — вызывается внутри
// текущего запроса после успешной записи.
// Очищаем только ключи без Authorization (reader-кеш); writer-ответы и так
// private, no-store, не кешируются CDN'ом.
async function purgeGroupCdnCache(env, group) {
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
// Для writer/owner (с токеном) кеш НЕ используется (private, no-store) — ответ
// всегда свежий. Для reader (без токена) проверяем кеш, при промахе — бьём
// воркер, кешируем ответ на TTL из Cache-Control (s-maxage).
//
// Возвращает Response. Если caches API недоступен — просто вызывает builder().
async function cachedGet(request, corsHeaders, builder) {
  const auth = (request.headers.get('Authorization') || '').startsWith('Bearer ');
  if (auth) {
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
      const toStore = new Response(resp.body, { status: resp.status, headers: h });
      // Клонируем для ответа клиенту и для записи в кеш (тело можно прочесть 1 раз).
      const forClient = toStore.clone();
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
  const headers = { ...corsHeaders, 'Content-Type': 'application/json' };
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
//   tg:chat:{group}            -> chatId (строка) — текущая привязка группы
//   tg:groups:{chatId}         -> JSON [group,...] — индекс для рассылки по chat
//   tg:pending:{chatId}        -> timestamp последней выданной команды /start
//                                (используется только лог-вспомогательно)
//
// Лимиты Telegram: text до 4096 символов, messages не чаще ~30/сек.
// Используем sendMessage с disable_web_page_preview=true.

const TG_API_BASE = 'https://api.telegram.org';

async function tgApi(env, method, payload) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log('[tg] tgApi skipped: no TELEGRAM_BOT_TOKEN');
    return { ok: false, skipped: true, reason: 'no-token' };
  }
  try {
    console.log('[tg] tgApi ->', method, 'chat_id=', payload && payload.chat_id, 'textLen=', payload && payload.text ? payload.text.length : 0);
      // Таймаут 8с: Telegram API из-под CF в РФ часто недоступен/тормозит,
      // не держим запрос вечно (особенно в фоновом режиме через waitUntil).
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
    console.log('[tg] tgApi', method, 'ok: chat_id=', payload && payload.chat_id);
    return { ok: true, result: data.result };
  } catch (e) {
    console.log('[tg] tgApi', method, 'exception:', e.name, e.message);
    return { ok: false, error: e.message };
  }
}

// Отправка текста всем подписчикам группы (обычно один chat_id).
// Читает список подписчиков группы (много chat_id на одну группу).
// Поддерживает миграцию старого ключа tg:chat:{group} (один chat_id) →
// превращаем в список из одного элемента.
async function getGroupSubscribers(env, group) {
  const store = createStore(env);
  const raw = await store.get(`tg:subs:${group}`, { type: 'json' });
  console.log('[tg] getGroupSubscribers', group, '=> raw=', JSON.stringify(raw));
  if (Array.isArray(raw)) return raw;

  // Миграция: старый одиночный ключ.
  const old = await store.get(`tg:chat:${group}`);
  if (old) {
    const list = [old];
    await store.put(`tg:subs:${group}`, JSON.stringify(list));
    await store.delete(`tg:chat:${group}`);
    console.log('[tg] migrated old tg:chat for', group, '=>', JSON.stringify(list));
    return list;
  }
  console.log('[tg] getGroupSubscribers', group, '=> EMPTY (no subs)');
  return [];
}

async function addGroupSubscriber(env, group, chatId) {
  const store = createStore(env);
  const list = await getGroupSubscribers(env, group);
  if (!list.includes(chatId)) {
    list.push(chatId);
    await store.put(`tg:subs:${group}`, JSON.stringify(list));
  }
}

async function removeGroupSubscriber(env, group, chatId) {
  const store = createStore(env);
  const list = await getGroupSubscribers(env, group);
  const filtered = list.filter(c => String(c) !== String(chatId));
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
  const store = createStore(env);
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

  // Длинные сообщения (> 4096) дробим по переводам.
  const chunks = splitForTg(text, 4000);
  for (const chatId of subs) {
    for (const c of chunks) {
      const res = await tgApi(env, 'sendMessage', {
        chat_id: chatId,
        text: c,
        parse_mode: opts.parseMode || 'HTML',
        disable_web_page_preview: true,
      });
      console.log('[tg] notifyGroup: sendMessage to', chatId, '=>', JSON.stringify(res).slice(0, 150));
    }
  }
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

// ── POST /api/tg/webhook ────────────────────────────────────────
// Telegram шлёт обновления бота на этот путь (setWebhook).
// Поддерживаемые команды:
//   /start            — приветствие + выдаёт chat_id
//   /chat_id          — повторно выдаёт chat_id
//   /stop             — отвязывает chat_id от всех групп

// ── POST /api/tg/set-webhook ──────────────────────────────────
// Ставит webhook Telegram на этот же Worker, вызывая Telegram API
// ИЗНУТРИ Cloudflare (там api.telegram.org доступен, в отличие от
// локальной машины в РФ). Токен берётся из секрета env.TELEGRAM_BOT_TOKEN.
// Можно защитить переменной окружения TG_WEBHOOK_KEY (передаётся в body.key
// или заголовке x-webhook-key); если не задана — эндпоинт открыт (webhook
// URL публичен по природе, вреда от вызова нет — просто переставит на тот же путь).

async function handleTgSetWebhook(request, env, corsHeaders) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return jsonResponse({ error: 'TELEGRAM_BOT_TOKEN not set' }, corsHeaders, 500);
  }

  const key = env.TG_WEBHOOK_KEY;
  if (key) {
    const body = await request.json().catch(() => ({}));
    const provided = body.key || request.headers.get('x-webhook-key') || '';
    if (provided !== key) {
      return jsonResponse({ error: 'Forbidden' }, corsHeaders, 403);
    }
  }

  // Строим URL webhook на основе origin текущего запроса.
  const origin = new URL(request.url).origin;
  const webhookUrl = `${origin}/api/tg/webhook`;

  const res = await tgApi(env, 'setWebhook', {
    url: webhookUrl,
    drop_pending_updates: true,
  });

  let info = null;
  if (res.ok) {
    const infoResp = await tgApi(env, 'getWebhookInfo', {});
    info = infoResp.result || null;
  }

  return jsonResponse({
    ok: res.ok,
    setWebhook: res.result || res.error || null,
    webhookUrl,
    info,
  }, corsHeaders);
}

async function handleTgWebhook(request, env) {
  const store = createStore(env);
  if (!env.DB) return new Response('ok', { status: 200 });
  let update;
  try { update = await request.json(); } catch { return new Response('ok', { status: 200 }); }

  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat) return new Response('ok', { status: 200 });

  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

  // В групповых чатах отвечаем ТОЛЬКО на команды, чтобы не засорять чат.
  const isCommand = /^\/(start|chat_id|stop)(@\w+)?$/i.test(text);
  if (isGroup && !isCommand) return new Response('ok', { status: 200 });

  try {
    if (/^\/start(@\w+)?$/i.test(text) || /^\/chat_id(@\w+)?$/i.test(text)) {
      const scopeNote = isGroup
        ? 'Это <b>групповой чат</b>. Все участники этого чата получат уведомления, если привязать этот chat_id к группе расписания.'
        : 'Это личный чат. Уведомления будут приходить только тебе.';
      const lines = [
        '👋 Привет! Это бот расписания СыктГУ.',
        '',
        scopeNote,
        '',
        'Чтобы получать уведомления об изменениях расписания и новых ДЗ:',
        '',
        '<b>1.</b> Скопируй этот chat_id:',
        '',
        `<code>${chatId}</code>`,
        '',
        '<b>2.</b> Открой сайт расписания → ⚙️ Настройки → раздел Telegram, вставь chat_id и нажми «Привязать».',
        '',
        'После этого сюда будут приходить уведомления о новых и изменённых ДЗ, а также об изменениях в расписании твоей группы.',
      ];
      await tgApi(env, 'sendMessage', {
        chat_id: chatId,
        text: lines.join('\n'),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } else if (/^\/stop(@\w+)?$/i.test(text)) {
      await unbindChat(env, chatId);
      await tgApi(env, 'sendMessage', {
        chat_id: chatId,
        text: '❌ Этот чат отписан от всех уведомлений. Чтобы снова получать — нажми /start.',
      });
    } else if (text && !isGroup) {
      // В личке подсказываем команды на любой прочий текст.
      await tgApi(env, 'sendMessage', {
        chat_id: chatId,
        text: 'Доступные команды: /start (получить chat_id), /stop (отписаться).',
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
    // Чистим старый одиночный ключ, если он указывал на этот chat.
    const cur = await store.get(`tg:chat:${g}`);
    if (String(cur) === String(chatId)) await store.delete(`tg:chat:${g}`);
    // И удаляем chat из списка подписчиков группы.
    await removeGroupSubscriber(env, g, chatId);
  }
  await store.delete(`tg:groups:${chatId}`);
}

// ── POST /api/tg/subscribe ─────────────────────────────────────
// Body: { group, chatId }  — привязывает chat_id к группе текущего пользователя.

async function handleTgSubscribe(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  const body = await request.json().catch(() => ({}));
  const { group: _group, chatId } = body;
  const group = normalizeGroup(_group);
  if (!group || !chatId) return jsonResponse({ error: 'Missing group or chatId' }, corsHeaders, 400);
  const chatIdStr = String(chatId).replace(/[^\d-]/g, '');
  if (!chatIdStr) return jsonResponse({ error: 'Invalid chatId' }, corsHeaders, 400);

  // Проверим, что chat_id реально существует у бота: отправим тихий probe.
  // Если токена нет — пропускаем проверку (dev-режим).
  if (env.TELEGRAM_BOT_TOKEN) {
    const probe = await tgApi(env, 'sendMessage', {
      chat_id: chatIdStr,
      text: '✅chat_id привязан к группе ' + group + '. Теперь тут будут уведомления!',
      disable_web_page_preview: true,
    });
    if (!probe.ok) {
      return jsonResponse({
        error: 'Не удалось отправить сообщение в этот chat_id. Убедись, что ты написал боту /start.',
      }, corsHeaders, 400);
    }
  }

  await addGroupSubscriber(env, group, chatIdStr);
  const groupsRaw = await store.get(`tg:groups:${chatIdStr}`, { type: 'json' }) || [];
  if (!groupsRaw.includes(group)) {
    groupsRaw.push(group);
    await store.put(`tg:groups:${chatIdStr}`, JSON.stringify(groupsRaw));
  }
  return jsonResponse({ ok: true, group, chatId: chatIdStr }, corsHeaders);
}

// ── POST /api/tg/unsubscribe ───────────────────────────────────
// Body: { group } | { chatId } | { group, chatId }

async function handleTgUnsubscribe(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  const body = await request.json().catch(() => ({}));
  const { group: _group, chatId } = body;
  const group = normalizeGroup(_group);

  if (group && chatId) {
    await removeGroupSubscriber(env, group, chatId);
    const groupsRaw = await store.get(`tg:groups:${String(chatId)}`, { type: 'json' }) || [];
    const filtered = groupsRaw.filter(g => g !== group);
    if (filtered.length) await store.put(`tg:groups:${String(chatId)}`, JSON.stringify(filtered));
    else await store.delete(`tg:groups:${String(chatId)}`);
  } else if (group) {
    // Отвязываем все чаты от группы (удаляем весь список подписчиков).
    const subs = await getGroupSubscribers(env, group);
    await store.delete(`tg:subs:${group}`);
    await store.delete(`tg:chat:${group}`); // на случай старого ключа
    for (const c of subs) {
      const groupsRaw = await store.get(`tg:groups:${String(c)}`, { type: 'json' }) || [];
      const filtered = groupsRaw.filter(g => g !== group);
      if (filtered.length) await store.put(`tg:groups:${String(c)}`, JSON.stringify(filtered));
      else await store.delete(`tg:groups:${String(c)}`);
    }
  } else if (chatId) {
    await unbindChat(env, String(chatId));
  } else {
    return jsonResponse({ error: 'Missing group or chatId' }, corsHeaders, 400);
  }
  return jsonResponse({ ok: true }, corsHeaders);
}

// ── GET /api/tg/status?group=...&chatId=... ─────────────────────
// Возвращает { subscribed, chatId } — подписан ли ПЕРЕДАННЫЙ chatId
// к этой группе (изоляция: каждый пользователь видит только свой статус).

async function handleTgStatus(request, env, corsHeaders) {
  const store = createStore(env);
  if (!env.DB) return jsonResponse({ error: 'DB not configured' }, corsHeaders, 500);
  const url = new URL(request.url);
  const group = normalizeGroup(url.searchParams.get('group') || env.DEFAULT_GROUP || '131-ИБо');
  const chatId = url.searchParams.get('chatId') || '';
  const subs = await getGroupSubscribers(env, group);
  const isSub = chatId ? subs.some(c => String(c) === String(chatId)) : false;
  return jsonResponse({
    subscribed: isSub,
    chatId: isSub ? chatId : null,
    subscribersCount: subs.length,
    botUsername: env.TG_BOT_USERNAME || '',
  }, corsHeaders);
}

// ════════════════════════════════════════════════════════════════
// ── Форматирование ДЗ и расписания для Telegram ─────────────────
// ════════════════════════════════════════════════════════════════

function escTg(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>');
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
