var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker/index.js
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };
    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    try {
      if (path === "/api/schedule" && method === "GET") {
        return await handleGetSchedule(request, env, corsHeaders);
      }
      if (path === "/api/weeks" && method === "GET") {
        return await handleGetWeeks(request, env, corsHeaders);
      }
      if (path === "/api/upload" && method === "POST") {
        return await handleUpload(request, env, corsHeaders);
      }
      if (path === "/api/changes" && method === "GET") {
        return await handleChanges(env, corsHeaders);
      }
      if (path === "/api/status" && method === "GET") {
        return await handleStatus(env, corsHeaders);
      }
      return jsonResponse({ error: "Not Found" }, corsHeaders, 404);
    } catch (e) {
      return jsonResponse({ error: e.message }, corsHeaders, 500);
    }
  }
};
async function handleGetSchedule(request, env, corsHeaders) {
  const url = new URL(request.url);
  const group = url.searchParams.get("group") || env.DEFAULT_GROUP || "131-\u0418\u0411\u043E";
  const weekCode = url.searchParams.get("week");
  if (!env.SCHEDULE) {
    return jsonResponse({ error: "KV not configured" }, corsHeaders, 500);
  }
  if (weekCode) {
    const data2 = await env.SCHEDULE.get(`schedule:${group}:${weekCode}`, { type: "json" });
    if (data2) return jsonResponse(data2, corsHeaders);
    return jsonResponse({ error: "Week not found. Run sync first." }, corsHeaders, 404);
  }
  const data = await env.SCHEDULE.get(`schedule:${group}:current`, { type: "json" });
  if (data) return jsonResponse(data, corsHeaders);
  return jsonResponse({ error: "No data. Run sync first." }, corsHeaders, 404);
}
__name(handleGetSchedule, "handleGetSchedule");
async function handleGetWeeks(request, env, corsHeaders) {
  const url = new URL(request.url);
  const group = url.searchParams.get("group") || env.DEFAULT_GROUP || "131-\u0418\u0411\u043E";
  if (!env.SCHEDULE) {
    return jsonResponse({ error: "KV not configured" }, corsHeaders, 500);
  }
  const data = await env.SCHEDULE.get(`weeks:${group}`, { type: "json" });
  if (data) return jsonResponse(data, corsHeaders);
  return jsonResponse({ error: "No weeks data. Run sync first." }, corsHeaders, 404);
}
__name(handleGetWeeks, "handleGetWeeks");
async function handleUpload(request, env, corsHeaders) {
  if (!env.SCHEDULE) {
    return jsonResponse({ error: "KV not configured" }, corsHeaders, 500);
  }
  const authHeader = request.headers.get("Authorization");
  const uploadToken = env.UPLOAD_TOKEN;
  if (uploadToken && authHeader !== `Bearer ${uploadToken}`) {
    return jsonResponse({ error: "Unauthorized" }, corsHeaders, 401);
  }
  const body = await request.json();
  const { type } = body;
  if (type === "weeks") {
    const { group, weeks } = body;
    if (!group || !weeks) {
      return jsonResponse({ error: "Missing group or weeks" }, corsHeaders, 400);
    }
    await env.SCHEDULE.put(`weeks:${group}`, JSON.stringify(weeks), { expirationTtl: 86400 });
    return jsonResponse({ ok: true, type: "weeks", count: weeks.length }, corsHeaders);
  }
  if (type === "schedule") {
    const { group, weekCode, data, previousWeekCode } = body;
    if (!group || !data) {
      return jsonResponse({ error: "Missing group or data" }, corsHeaders, 400);
    }
    const key = weekCode ? `schedule:${group}:${weekCode}` : `schedule:${group}:current`;
    await env.SCHEDULE.put(key, JSON.stringify(data), { expirationTtl: 604800 });
    if (weekCode) {
      await env.SCHEDULE.put(`schedule:${group}:current`, JSON.stringify(data), { expirationTtl: 604800 });
    }
    const current = await env.SCHEDULE.get("sync:meta", { type: "json" }) || {};
    const oldData = current.lastSchedule ? await env.SCHEDULE.get(`schedule:${group}:${current.lastSchedule}`, { type: "json" }) : null;
    let changes = [];
    if (oldData && data) {
      changes = diffSchedules(oldData, data);
      if (changes.length > 0 && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
        await sendTelegramNotification(env, group, changes);
      }
    }
    await env.SCHEDULE.put("sync:meta", JSON.stringify({
      lastSync: (/* @__PURE__ */ new Date()).toISOString(),
      lastGroup: group,
      lastWeek: weekCode || "current",
      changeCount: changes.length
    }), { expirationTtl: 604800 });
    return jsonResponse({
      ok: true,
      type: "schedule",
      group,
      weekCode,
      changesCount: changes.length,
      changes
    }, corsHeaders);
  }
  return jsonResponse({ error: 'Invalid type. Use "weeks" or "schedule".' }, corsHeaders, 400);
}
__name(handleUpload, "handleUpload");
async function handleChanges(env, corsHeaders) {
  if (!env.SCHEDULE) {
    return jsonResponse({ error: "KV not configured" }, corsHeaders, 500);
  }
  const current = await env.SCHEDULE.get("schedule:current", { type: "json" });
  const previous = await env.SCHEDULE.get("schedule:previous", { type: "json" });
  if (!current || !previous) {
    return jsonResponse({ changes: [], hasChanges: false }, corsHeaders);
  }
  const changes = diffSchedules(previous, current);
  return jsonResponse({ changes, hasChanges: changes.length > 0 }, corsHeaders);
}
__name(handleChanges, "handleChanges");
async function handleStatus(env, corsHeaders) {
  if (!env.SCHEDULE) {
    return jsonResponse({ kv: false }, corsHeaders);
  }
  const meta = await env.SCHEDULE.get("sync:meta", { type: "json" });
  return jsonResponse({
    kv: true,
    lastSync: meta?.lastSync || null,
    lastGroup: meta?.lastGroup || null,
    lastWeek: meta?.lastWeek || null,
    changeCount: meta?.changeCount || 0
  }, corsHeaders);
}
__name(handleStatus, "handleStatus");
async function sendTelegramNotification(env, group, changes) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const lines = changes.map((c) => {
    if (c.type === "added") return `\u2795 ${c.day} ${c.time} \u2014 ${c.subject}`;
    if (c.type === "removed") return `\u2796 ${c.day} ${c.time} \u2014 ${c.subject}`;
    return `\u{1F504} ${c.day} ${c.time}: ${c.field} \xAB${c.oldVal}\xBB \u2192 \xAB${c.newVal}\xBB`;
  });
  const text = `\u{1F4C5} *\u0418\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u044F \u0432 \u0440\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0438 ${group}*

${lines.join("\n")}`;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" })
    });
  } catch (e) {
    console.error("Telegram error:", e);
  }
}
__name(sendTelegramNotification, "sendTelegramNotification");
function diffSchedules(old, curr) {
  const changes = [];
  if (!old?.days || !curr?.days) return changes;
  for (const day of Object.keys(curr.days)) {
    const currDay = curr.days[day];
    const oldDay = old.days[day];
    if (!oldDay) {
      for (const p of currDay.pairs || []) {
        if (p.subject) changes.push({ type: "added", day, time: p.time, subject: p.subject });
      }
      continue;
    }
    const oldPairs = {};
    for (const p of oldDay.pairs || []) oldPairs[p.time] = p;
    for (const p of currDay.pairs || []) {
      if (!p.subject) continue;
      const op = oldPairs[p.time];
      if (!op || !op.subject) {
        changes.push({ type: "added", day, time: p.time, subject: p.subject });
        continue;
      }
      for (const field of ["subject", "teacher", "room", "type"]) {
        if (p[field] !== op[field]) {
          changes.push({ type: "changed", day, time: p.time, field, oldVal: op[field] || "", newVal: p[field] || "" });
        }
      }
    }
    for (const p of oldDay.pairs || []) {
      if (p.subject && !(currDay.pairs || []).find((cp) => cp.time === p.time && cp.subject)) {
        changes.push({ type: "removed", day, time: p.time, subject: p.subject });
      }
    }
  }
  return changes;
}
__name(diffSchedules, "diffSchedules");
function jsonResponse(data, corsHeaders, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}
__name(jsonResponse, "jsonResponse");
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
