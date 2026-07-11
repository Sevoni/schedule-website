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
      if (path === '/api/schedule' && method === 'GET') {
        return await handleGetSchedule(request, env, corsHeaders);
      }
      if (path === '/api/weeks' && method === 'GET') {
        return await handleGetWeeks(request, env, corsHeaders);
      }
      if (path === '/api/upload' && method === 'POST') {
        return await handleUpload(request, env, corsHeaders);
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
      if (path === '/api/status' && method === 'GET') {
        return await handleStatus(env, corsHeaders);
      }
      return jsonResponse({ error: 'Not Found' }, corsHeaders, 404);
    } catch (e) {
      return jsonResponse({ error: e.message }, corsHeaders, 500);
    }
  },
};

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

  const data = await env.SCHEDULE.get(`schedule:${group}:current`, { type: 'json' });
  if (data) return jsonResponse(data, corsHeaders);
  return jsonResponse({ error: 'No data. Run sync first.' }, corsHeaders, 404);
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
    await env.SCHEDULE.put(`schedule:${group}:current`, JSON.stringify(data), { expirationTtl: 604800 });

    await env.SCHEDULE.put('sync:meta', JSON.stringify({
      lastSync: new Date().toISOString(),
      lastGroup: group,
      lastWeek: weekCode || 'current',
    }), { expirationTtl: 604800 });

    return jsonResponse({ ok: true, type: 'schedule', group, weekCode }, corsHeaders);
  }

  return jsonResponse({ error: 'Invalid type' }, corsHeaders, 400);
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
  const { group, subject, task, dueDate, author } = body;

  if (!group || !subject) {
    return jsonResponse({ error: 'Missing group or subject' }, corsHeaders, 400);
  }

  const key = `hw:${group}`;
  const existing = await env.SCHEDULE.get(key, { type: 'json' }) || [];

  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    subject,
    task: task || '',
    dueDate: dueDate || '',
    author: author || '',
    createdAt: new Date().toISOString(),
  };

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

// ── GET /api/status ────────────────────────────────────────────

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
