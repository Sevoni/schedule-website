export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // ── Public endpoints ──────────────────────────────────
      if (path === '/api/status' && method === 'GET') {
        return await handleStatus(env, corsHeaders);
      }
      if (path === '/api/schedule' && method === 'GET') {
        return await handleGetSchedule(request, env, corsHeaders);
      }
      if (path === '/api/weeks' && method === 'GET') {
        return await handleGetWeeks(request, env, corsHeaders);
      }
      if (path === '/api/upload' && method === 'POST') {
        return await handleUpload(request, env, corsHeaders);
      }
      if (path === '/api/subjects' && method === 'GET') {
        return await handleGetSubjects(request, env, corsHeaders);
      }
      if (path === '/api/subjects' && method === 'POST') {
        return await handlePutSubjects(request, env, corsHeaders);
      }
      if (path === '/api/hw' && method === 'GET') {
        return await handleGetHw(request, env, corsHeaders);
      }
      if (path === '/api/hw' && method === 'POST') {
        return await handleAddHw(request, env, corsHeaders);
      }
      if (path === '/api/hw' && method === 'DELETE') {
        return await handleDeleteHw(request, env, corsHeaders);
      }
      if (path === '/api/hw/recalc' && method === 'POST') {
        return await handleRecalcHw(request, env, corsHeaders);
      }

      // ── Auth endpoints ───────────────────────────────────
      if (path === '/api/auth' && method === 'POST') {
        return await handleAuth(request, env, corsHeaders);
      }
      if (path === '/api/group/register' && method === 'POST') {
        return await handleGroupRegister(request, env, corsHeaders);
      }

      return jsonResponse({ error: 'Not Found' }, corsHeaders, 404);
    } catch (e) {
      return jsonResponse({ error: e.message }, corsHeaders, 500);
    }
  },
};

// ── Auth: verify token ─────────────────────────────────────────
// Token format: base64(JSON.stringify({group, ts})).sha256hex
// We store passwords in KV as group-pwd:{group}

async function verifyAuth(request, env) {
  if (!env.SCHEDULE) return 'KV not configured';

  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return 'Authorization required';
  }

  const token = authHeader.slice(7);
  try {
    const decoded = JSON.parse(atob(token));
    const { group, ts } = decoded;

    if (!group) return 'Invalid token';

    // Token expires after 30 days
    const age = Date.now() - ts;
    if (age > 30 * 24 * 60 * 60 * 1000) {
      return 'Token expired';
    }

    // Verify the group exists (has a password set)
    const pwd = await env.SCHEDULE.get(`group-pwd:${group}`);
    if (!pwd) return 'Group not registered';

    return null; // OK
  } catch {
    return 'Invalid token';
  }
}

// ── POST /api/auth ─────────────────────────────────────────────
// Body: { group, password }
// Returns: { token, group }

async function handleAuth(request, env, corsHeaders) {
  if (!env.SCHEDULE) {
    return jsonResponse({ error: 'KV not configured' }, corsHeaders, 500);
  }

  const { group, password } = await request.json();

  if (!group || !password) {
    return jsonResponse({ error: 'Missing group or password' }, corsHeaders, 400);
  }

  const stored = await env.SCHEDULE.get(`group-pwd:${group}`);
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
  if (!env.SCHEDULE) {
    return jsonResponse({ error: 'KV not configured' }, corsHeaders, 500);
  }

  const { group, password } = await request.json();

  if (!group || !password) {
    return jsonResponse({ error: 'Missing group or password' }, corsHeaders, 400);
  }

  if (password.length < 4) {
    return jsonResponse({ error: 'Password must be at least 4 characters' }, corsHeaders, 400);
  }

  const existing = await env.SCHEDULE.get(`group-pwd:${group}`);
  if (existing) {
    return jsonResponse({ error: 'Group already registered' }, corsHeaders, 409);
  }

  const hash = await sha256(password);
  await env.SCHEDULE.put(`group-pwd:${group}`, hash);

  // Auto-login: return token
  const token = btoa(JSON.stringify({ group, ts: Date.now() }));
  return jsonResponse({ ok: true, token, group }, corsHeaders);
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
  const group = url.searchParams.get('group') || env.DEFAULT_GROUP || '131-ИБо';
  const weekCode = url.searchParams.get('week');

  if (!env.SCHEDULE) {
    return jsonResponse({ error: 'KV not configured' }, corsHeaders, 500);
  }

  if (weekCode) {
    const data = await env.SCHEDULE.get(`schedule:${group}:${weekCode}`, { type: 'json' });
    if (data) return jsonResponse(data, corsHeaders);
    return jsonResponse({ error: 'Week not found' }, corsHeaders, 404);
  }

  return jsonResponse({ error: 'Missing week parameter' }, corsHeaders, 400);
}

// ── GET /api/weeks?group=... ───────────────────────────────────

async function handleGetWeeks(request, env, corsHeaders) {
  const url = new URL(request.url);
  const group = url.searchParams.get('group') || env.DEFAULT_GROUP || '131-ИБо';

  if (!env.SCHEDULE) {
    return jsonResponse({ error: 'KV not configured' }, corsHeaders, 500);
  }

  const data = await env.SCHEDULE.get(`weeks:${group}`, { type: 'json' });
  if (data) return jsonResponse(data, corsHeaders);
  return jsonResponse({ error: 'No weeks data' }, corsHeaders, 404);
}

// ── POST /api/sync ─────────────────────────────────────────────
// Frontend парсит campus.syktsu.ru в браузере и отправляет сюда на сохранение

async function handleUpload(request, env, corsHeaders) {
  if (!env.SCHEDULE) {
    return jsonResponse({ error: 'KV not configured' }, corsHeaders, 500);
  }

  const body = await request.json();
  const { type } = body;

  if (type === 'weeks') {
    const { group, weeks } = body;
    if (!group || !weeks) {
      return jsonResponse({ error: 'Missing group or weeks' }, corsHeaders, 400);
    }
    await env.SCHEDULE.put(`weeks:${group}`, JSON.stringify(weeks), { expirationTtl: 604800 });
    return jsonResponse({ ok: true, type: 'weeks', count: weeks.length }, corsHeaders);
  }

  if (type === 'schedule') {
    const { group, weekCode, data } = body;
    if (!group || !data) {
      return jsonResponse({ error: 'Missing group or data' }, corsHeaders, 400);
    }

    const key = weekCode ? `schedule:${group}:${weekCode}` : `schedule:${group}:current`;
    await env.SCHEDULE.put(key, JSON.stringify(data), { expirationTtl: 604800 });

    await env.SCHEDULE.put('sync:meta', JSON.stringify({
      lastSync: new Date().toISOString(),
      lastGroup: group,
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
    const { group, schedules } = body;
    if (!group || !Array.isArray(schedules)) {
      return jsonResponse({ error: 'Missing group or schedules' }, corsHeaders, 400);
    }

    const updated = [];
    const validWeekCodes = [];

    for (const { weekCode, data } of schedules) {
      if (!weekCode || !data) continue;
      validWeekCodes.push(weekCode);

      const existing = await env.SCHEDULE.get(`schedule:${group}:${weekCode}`, { type: 'json' });
      const existingStr = existing ? JSON.stringify(stripComparable(existing)) : '';
      const newStr = JSON.stringify(stripComparable(data));

      if (existingStr !== newStr) {
        await env.SCHEDULE.put(`schedule:${group}:${weekCode}`, JSON.stringify(data), { expirationTtl: 604800 });
        updated.push(weekCode);
      }
    }

    await env.SCHEDULE.put('sync:meta', JSON.stringify({
      lastSync: new Date().toISOString(),
      lastGroup: group,
      lastWeek: 'batch',
    }), { expirationTtl: 604800 });

    // Обновим список предметов для текущего семестра по всем неделям в БД
    let subjectsUpdated = false;
    try {
      subjectsUpdated = await updateSubjectsForCurrentSemester(env, group);
    } catch (e) {
      console.log('subjects update skipped:', e.message);
    }

    // Если записано изменённое расписание — пересчитаем dueDate для ДЗ с nextPair
    let recalcResult = null;
    if (updated.length > 0) {
      try {
        recalcResult = await recalcHomeworkForGroup(env, group);
      } catch (e) {
        console.log('hw recalc skipped:', e.message);
      }
    }

    return jsonResponse({
      ok: true,
      type: 'schedule-batch',
      updated: updated.length,
      total: schedules.length,
      subjectsUpdated,
      recalc: recalcResult,
    }, corsHeaders);
  }

  return jsonResponse({ error: 'Invalid type' }, corsHeaders, 400);
}

function stripComparable(data) {
  if (!data || typeof data !== 'object') return data;
  const { parsedAt, ...rest } = data;
  return rest;
}

// ── GET /api/hw?group=... ──────────────────────────────────────

async function handleGetHw(request, env, corsHeaders) {
  if (!env.SCHEDULE) {
    return jsonResponse({ error: 'KV not configured' }, corsHeaders, 500);
  }

  const url = new URL(request.url);
  const group = url.searchParams.get('group') || env.DEFAULT_GROUP || '131-ИБо';

  const data = await env.SCHEDULE.get(`hw:${group}`, { type: 'json' });
  return jsonResponse(data || [], corsHeaders);
}

// ── POST /api/hw ───────────────────────────────────────────────

async function handleAddHw(request, env, corsHeaders) {
  if (!env.SCHEDULE) {
    return jsonResponse({ error: 'KV not configured' }, corsHeaders, 500);
  }

  const body = await request.json();
  const { group, subject, task, dueDate, dueMode, pairType, author } = body;

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
    task: task || '',
    dueMode,
    dueDate: dueDate || '',
    author: author || '',
    createdAt: new Date().toISOString(),
  };

  // Если nextPair — посчитаем dueDate сразу на основе расписаний в БД
  if (dueMode === 'nextPair') {
    item.dueDate = await computeNextPairDate(env, group, item.subject, item.pairType);
  }

  const key = `hw:${group}`;
  const existing = await env.SCHEDULE.get(key, { type: 'json' }) || [];
  existing.push(item);
  await env.SCHEDULE.put(key, JSON.stringify(existing), { expirationTtl: 2592000 });

  return jsonResponse({ ok: true, item }, corsHeaders);
}

// ── DELETE /api/hw?id=...&group=... ────────────────────────────

async function handleDeleteHw(request, env, corsHeaders) {
  if (!env.SCHEDULE) {
    return jsonResponse({ error: 'KV not configured' }, corsHeaders, 500);
  }

  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  const group = url.searchParams.get('group') || env.DEFAULT_GROUP || '131-ИБо';

  if (!id) {
    return jsonResponse({ error: 'Missing id' }, corsHeaders, 400);
  }

  const key = `hw:${group}`;
  const existing = await env.SCHEDULE.get(key, { type: 'json' }) || [];
  const filtered = existing.filter(h => h.id !== id);

  await env.SCHEDULE.put(key, JSON.stringify(filtered), { expirationTtl: 2592000 });

  return jsonResponse({ ok: true, count: filtered.length }, corsHeaders);
}

// ── GET /api/subjects?group=... ─────────────────────────────────
// Возвращает { semester, subjects: [{subject, pairTypes: ['л','пр',...]}] }

async function handleGetSubjects(request, env, corsHeaders) {
  if (!env.SCHEDULE) {
    return jsonResponse({ error: 'KV not configured' }, corsHeaders, 500);
  }

  const url = new URL(request.url);
  const group = url.searchParams.get('group') || env.DEFAULT_GROUP || '131-ИБо';
  const semester = currentSemesterKey();

  const key = `subjects:${group}:${semester}`;
  let data = await env.SCHEDULE.get(key, { type: 'json' });

  if (!data || data.length === 0) {
    try {
      await updateSubjectsForCurrentSemester(env, group);
      data = await env.SCHEDULE.get(key, { type: 'json' });
    } catch (e) {
      console.log('subjects auto-recompute failed:', e.message);
    }
  }

  return jsonResponse({ semester, subjects: data || [] }, corsHeaders);
}

// ── POST /api/subjects ─────────────────────────────────────────
// Body: { group, semester?, subjects } — пересохраняет список предметов.

async function handlePutSubjects(request, env, corsHeaders) {
  if (!env.SCHEDULE) {
    return jsonResponse({ error: 'KV not configured' }, corsHeaders, 500);
  }

  const body = await request.json();
  const { group, subjects, semester } = body;
  if (!group || !Array.isArray(subjects)) {
    return jsonResponse({ error: 'Missing group or subjects' }, corsHeaders, 400);
  }

  const sem = semester || currentSemesterKey();
  await env.SCHEDULE.put(`subjects:${group}:${sem}`, JSON.stringify(subjects), {
    expirationTtl: 365 * 24 * 60 * 60,
  });
  return jsonResponse({ ok: true, semester: sem, count: subjects.length }, corsHeaders);
}

// ── POST /api/hw/recalc ─────────────────────────────────────────
// Тело: { group } — пересчитывает dueDate для всех ДЗ с dueMode='nextPair'
// на основе всех расписаний в БД. Возвращает обновлённые items.

async function handleRecalcHw(request, env, corsHeaders) {
  if (!env.SCHEDULE) {
    return jsonResponse({ error: 'KV not configured' }, corsHeaders, 500);
  }

  const body = await request.json().catch(() => ({}));
  const group = body.group || env.DEFAULT_GROUP || '131-ИБо';

  const result = await recalcHomeworkForGroup(env, group);
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

// ── Обновление предметов в текущем семестре по всем расписаниям в БД ──

async function updateSubjectsForCurrentSemester(env, group) {
  const semester = currentSemesterKey();
  const list = await env.SCHEDULE.list({ prefix: `schedule:${group}:` });
  if (!list || list.keys.length === 0) return false;

  const subjectsMap = new Map(); // subject -> Set(pairType)

  for (const k of list.keys) {
    const weekValue = k.name.split(`schedule:${group}:`)[1];
    if (!weekValue || weekValue === 'current') continue;
    let data;
    try {
      data = await env.SCHEDULE.get(k.name, { type: 'json' });
    } catch (e) {
      continue;
    }
    if (!data || !data.days) continue;

    if (semesterFromWeekDates(data.weekStart, data.weekEnd) !== semester) continue;

    for (const day of Object.values(data.days)) {
      for (const p of (day.pairs || [])) {
        if (!p.subject) continue;
        if (!subjectsMap.has(p.subject)) subjectsMap.set(p.subject, new Set());
        if (p.type) subjectsMap.get(p.subject).add(p.type);
      }
    }
  }

  const subjects = [...subjectsMap.entries()]
    .map(([subject, types]) => ({ subject, pairTypes: [...types].sort() }))
    .sort((a, b) => a.subject.localeCompare(b.subject, 'ru'));

  await env.SCHEDULE.put(`subjects:${group}:${semester}`, JSON.stringify(subjects), {
    expirationTtl: 365 * 24 * 60 * 60,
  });
  return true;
}

// ── Пересчёт dueDate для ДЗ с dueMode='nextPair' ────────────────────

async function recalcHomeworkForGroup(env, group) {
  const key = `hw:${group}`;
  const homework = await env.SCHEDULE.get(key, { type: 'json' }) || [];
  if (homework.length === 0) return { updated: 0, items: [] };

  // Загружаем все расписания группы
  const list = await env.SCHEDULE.list({ prefix: `schedule:${group}:` });
  const weekData = [];
  for (const k of list.keys) {
    const weekValue = k.name.split(`schedule:${group}:`)[1];
    if (!weekValue || weekValue === 'current') continue;
    const data = await env.SCHEDULE.get(k.name, { type: 'json' });
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
    const newDate = findNextPairDate(weekData, hw.subject, hw.pairType, new Date());
    if (!newDate || newDate === hw.dueDate) {
      updatedItems.push(hw);
      continue;
    }
    changed = true;
    const upd = { ...hw, dueDate: newDate };
    updatedItems.push(upd);
  }

  if (changed) {
    await env.SCHEDULE.put(key, JSON.stringify(updatedItems), { expirationTtl: 2592000 });
  }
  return { updated: changed ? updatedItems.length : 0, items: updatedItems, changed };
}

// ── Найти следующую дату пары для предмета с учётом типа ──────────
// Возвращает дату в формате yyyy-MM-dd (локальная) или null.

function findNextPairDate(weekData, subject, pairType, fromDate) {
  if (!subject || weekData.length === 0) return null;
  const baseLower = subject.trim().toLowerCase();
  const t = pairType || 'any';

  const fmt = (dt) => {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };
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
        if (t === 'any') return true;
        return p.type === t;
      });
      if (has) return dayStr;
    }
  }
  return null;
}

// ── Вычислить дату следующей пары для одного ДЗ ─────────────────────

async function computeNextPairDate(env, group, subject, pairType) {
  const list = await env.SCHEDULE.list({ prefix: `schedule:${group}:` });
  const weekData = [];
  for (const k of list.keys) {
    const weekValue = k.name.split(`schedule:${group}:`)[1];
    if (!weekValue || weekValue === 'current') continue;
    const data = await env.SCHEDULE.get(k.name, { type: 'json' });
    if (data && data.days && data.weekStart) {
      const startDate = parseDateLocal(data.weekStart);
      if (startDate) weekData.push({ startDate, data });
    }
  }
  weekData.sort((a, b) => a.startDate - b.startDate);
  return findNextPairDate(weekData, subject, pairType, new Date());
}

// ── Разделить название предмета на базу и тип пары ──────────────────
// "Математика (л)" -> { base: "Математика", type: "л" }


async function handleStatus(env, corsHeaders) {
  if (!env.SCHEDULE) {
    return jsonResponse({ kv: false }, corsHeaders);
  }

  const meta = await env.SCHEDULE.get('sync:meta', { type: 'json' });
  return jsonResponse({
    kv: true,
    lastSync: meta?.lastSync || null,
    lastGroup: meta?.lastGroup || null,
    lastWeek: meta?.lastWeek || null,
  }, corsHeaders);
}

// ── Helper ─────────────────────────────────────────────────────

function jsonResponse(data, corsHeaders, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
