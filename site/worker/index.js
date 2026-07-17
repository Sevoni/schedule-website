export default {
  async fetch(request, env) {
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

    try {
      // ── Public endpoints ──────────────────────────────────
      if (path === '/api/status' && method === 'GET') {
        return await handleStatus(request, env, corsHeaders);
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
      if (path === '/api/hw' && method === 'PUT') {
        return await handleUpdateHw(request, env, corsHeaders);
      }
      if (path === '/api/hw' && method === 'DELETE') {
        return await handleDeleteHw(request, env, corsHeaders);
      }
      if (path === '/api/hw/recalc' && method === 'POST') {
        return await handleRecalcHw(request, env, corsHeaders);
      }

      // ── Campus sync (frontend-parse flow) ───────────────
      if (path === '/api/check-campus-update' && method === 'POST') {
        return await handleCheckCampusUpdate(request, env, corsHeaders);
      }
      if (path === '/api/sync-from-campus' && method === 'POST') {
        return await handleSyncFromCampus(request, env, corsHeaders);
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

          // Инкрементально обновим список предметов этой недели
          try {
            await addSubjectsFromWeek(env, group, weekCode, data);
          } catch (e) {
            console.log('addSubjectsFromWeek skipped:', e.message);
          }
      }
    }

    // Пересоберём агрегат предметов один раз, а не на каждую изменённую неделю
    try {
      await reaggregateSubjects(env, group, currentSemesterKey());
    } catch (e) {
      console.log('reaggregateSubjects skipped:', e.message);
    }

    await env.SCHEDULE.put('sync:meta', JSON.stringify({
      lastSync: new Date().toISOString(),
      lastGroup: group,
      lastWeek: 'batch',
    }), { expirationTtl: 604800 });

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
  if (!env.SCHEDULE) {
    return jsonResponse({ error: 'KV not configured' }, corsHeaders, 500);
  }

  const body = await request.json().catch(() => ({}));
  const { group, campusUpdatedAt } = body;

  if (!group) {
    return jsonResponse({ error: 'Missing group' }, corsHeaders, 400);
  }

  const stored = await env.SCHEDULE.get(`campus-updated:${group}`);
  const needUpdate = !stored || stored !== (campusUpdatedAt || '');

  // Обновляем lastSync при каждом вызове 🔄, даже если изменений нет
  const meta = await env.SCHEDULE.get('sync:meta', { type: 'json' });
  await env.SCHEDULE.put('sync:meta', JSON.stringify({
    lastSync: new Date().toISOString(),
    lastGroup: group,
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
  if (!env.SCHEDULE) {
    return jsonResponse({ error: 'KV not configured' }, corsHeaders, 500);
  }

  const body = await request.json().catch(() => ({}));
  const { group, campusUpdatedAt, schedules } = body;

  if (!group || !Array.isArray(schedules)) {
    return jsonResponse({ error: 'Missing group or schedules' }, corsHeaders, 400);
  }

  const updated = [];

  for (const { weekCode, data } of schedules) {
    if (!weekCode || !data) continue;

    const existing = await env.SCHEDULE.get(`schedule:${group}:${weekCode}`, { type: 'json' });
    const existingStr = existing ? JSON.stringify(stripComparable(existing)) : '';
    const newStr = JSON.stringify(stripComparable(data));

    if (existingStr !== newStr) {
      await env.SCHEDULE.put(`schedule:${group}:${weekCode}`, JSON.stringify(data), { expirationTtl: 604800 });
      updated.push(weekCode);

      // Инкрементально обновляем список предметов этой недели
      try {
        await addSubjectsFromWeek(env, group, weekCode, data);
      } catch (e) {
        console.log('addSubjectsFromWeek skipped:', e.message);
      }
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
    await env.SCHEDULE.put(`campus-updated:${group}`, campusUpdatedAt, { expirationTtl: 604800 });
  }

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
    subjects = (await env.SCHEDULE.get(`subjects:${group}:${semester}`, { type: 'json' })) || [];
  } catch (e) {
    console.log('subjects read skipped:', e.message);
  }

  await env.SCHEDULE.put('sync:meta', JSON.stringify({
    lastSync: new Date().toISOString(),
    lastGroup: group,
    lastWeek: 'batch',
    campusUpdatedAt: campusUpdatedAt || null,
  }), { expirationTtl: 604800 });

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
  const { group, subject, task, dueDate, dueMode, pairType, author, subgroup } = body;

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
  const existing = await env.SCHEDULE.get(key, { type: 'json' }) || [];
  existing.push(item);
  await env.SCHEDULE.put(key, JSON.stringify(existing), { expirationTtl: 2592000 });

  return jsonResponse({ ok: true, item }, corsHeaders);
}

// ── PUT /api/hw ────────────────────────────────────────────────
// Body: { id, group, subject, pairType, subgroup, task, dueMode, dueDate, author }
// — обновляет все поля конкретного ДЗ.

async function handleUpdateHw(request, env, corsHeaders) {
  if (!env.SCHEDULE) {
    return jsonResponse({ error: 'KV not configured' }, corsHeaders, 500);
  }

  const body = await request.json();
  const { id, group } = body;

  if (!id || !group) {
    return jsonResponse({ error: 'Missing id or group' }, corsHeaders, 400);
  }

  const key = `hw:${group}`;
  const existing = await env.SCHEDULE.get(key, { type: 'json' }) || [];
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
  await env.SCHEDULE.put(key, JSON.stringify(existing), { expirationTtl: 2592000 });

  return jsonResponse({ ok: true, item: existing[idx] }, corsHeaders);
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

  if (!data || data.length === 0 || (data[0] && !('subgroups' in data[0]))) {
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
  const list = await env.SCHEDULE.list({ prefix: `subjects-week:${group}:${semester}:` });
  const map = new Map();
  for (const k of (list && list.keys) || []) {
    let snap;
    try {
      snap = await env.SCHEDULE.get(k.name, { type: 'json' });
    } catch (e) {
      continue;
    }
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
  await env.SCHEDULE.put(`subjects:${group}:${semester}`, JSON.stringify(merged), {
    expirationTtl: 365 * 24 * 60 * 60,
  });
}

// Записывает вклад одной недели (subjects-week:*). Пересборку агрегата
// вызывающий код делает один раз после цикла (см. reaggregateSubjects),
// чтобы не делать лишних KV-запросов на каждую изменённую неделю.
async function addSubjectsFromWeek(env, group, weekCode, weekData) {
  if (!weekCode || !weekData || !weekData.days) return false;

  const semester = semesterFromWeekDates(weekData.weekStart, weekData.weekEnd)
    || currentSemesterKey();

  const snapshot = computeWeekSubjects(weekData);
  await env.SCHEDULE.put(`subjects-week:${group}:${semester}:${weekCode}`, JSON.stringify(snapshot), {
    expirationTtl: 365 * 24 * 60 * 60,
  });
  return true;
}

// ── Полная пересборка предметов текущего семестра ──
// Используется в редких случаях (одиночный schedule-upload, миграция старых
// данных при GET). Пересчитывает недельные вклады всех расписаний семестра
// и пересобирает агрегат. Горячий путь синхронизации им не пользуется.

async function updateSubjectsForCurrentSemester(env, group) {
  const semester = currentSemesterKey();
  const list = await env.SCHEDULE.list({ prefix: `schedule:${group}:` });
  if (!list || list.keys.length === 0) return false;

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

    const snapshot = computeWeekSubjects(data);
    await env.SCHEDULE.put(`subjects-week:${group}:${semester}:${weekValue}`, JSON.stringify(snapshot), {
      expirationTtl: 365 * 24 * 60 * 60,
    });
  }

  await reaggregateSubjects(env, group, semester);
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
    await env.SCHEDULE.put(key, JSON.stringify(updatedItems), { expirationTtl: 2592000 });
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
  return findNextPairDate(weekData, subject, pairType, fromDate, subgroup);
}

// ── Разделить название предмета на базу и тип пары ──────────────────
// "Математика (л)" -> { base: "Математика", type: "л" }


async function handleStatus(request, env, corsHeaders) {
  if (!env.SCHEDULE) {
    return jsonResponse({ kv: false }, corsHeaders);
  }

  const url = new URL(request.url);
  const group = url.searchParams.get('group');

  const meta = await env.SCHEDULE.get('sync:meta', { type: 'json' });

  let campusUpdatedAt = meta?.campusUpdatedAt || null;
  if (group && !campusUpdatedAt) {
    campusUpdatedAt = await env.SCHEDULE.get(`campus-updated:${group}`);
  }

  return jsonResponse({
    kv: true,
    lastSync: meta?.lastSync || null,
    lastGroup: meta?.lastGroup || null,
    lastWeek: meta?.lastWeek || null,
    campusUpdatedAt: campusUpdatedAt || null,
  }, corsHeaders);
}

// ── Helper ─────────────────────────────────────────────────────

function jsonResponse(data, corsHeaders, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
