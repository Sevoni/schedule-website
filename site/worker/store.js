// Адаптер хранилища поверх Cloudflare D1.
// Повторяет минимально необходимый API KV (get/put/delete/list),
// чтобы остальной код worker/index.js менялся минимально.
//
// Схема D1 (см. migrations/0001_init.sql):
//   CREATE TABLE kv (
//     key        TEXT PRIMARY KEY,
//     value      TEXT NOT NULL,
//     expires_at INTEGER,        -- unix ms, NULL = без срока
//     updated_at INTEGER NOT NULL
//   );
//
// Все данные хранятся как JSON-строки (как раньше в KV). TTL из KV
// (expirationTtl в секундах) преобразуется в expires_at = now + ttl*1000.

function nowMs() {
  return Date.now();
}

// get(key, { type: 'json' | undefined })
// Возвращает строку (или распарсенный JSON при type:'json'), либо null,
// если ключа нет или он протух.
async function get(db, key, opts = {}) {
  const row = await db
    .prepare('SELECT value, expires_at FROM kv WHERE key = ?')
    .bind(key)
    .first();
  if (!row) return null;
  if (row.expires_at != null && row.expires_at <= nowMs()) {
    // Протухшую запись можно сразу подчистить, но не блокируем чтение.
    return null;
  }
  if (opts.type === 'json') {
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }
  return row.value;
}

// put(key, value, { expirationTtl }) — value может быть строкой или объектом.
async function put(db, key, value, opts = {}) {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  const expiresAt = opts.expirationTtl
    ? nowMs() + opts.expirationTtl * 1000
    : null;
  await db
    .prepare(
      `INSERT INTO kv (key, value, expires_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`
    )
    .bind(key, str, expiresAt, nowMs())
    .run();
}

async function del(db, key) {
  await db.prepare('DELETE FROM kv WHERE key = ?').bind(key).run();
}

// list({ prefix }) — возвращает { keys: [{ name, value? }] } как KV.
// value не возвращаем (как у KV list), вызывающие делают отдельный get.
// KV list не поддерживает pagination-токены в этом проекте, поэтому
// возвращаем все ключи разом.
async function list(db, opts = {}) {
  const prefix = opts.prefix || '';
  // Экранируем спецсимволы LIKE: % и _ и \.
  const escaped = prefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  const rows = await db
    .prepare(`SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\' AND (expires_at IS NULL OR expires_at > ?) ORDER BY key`)
    .bind(escaped + '%', nowMs())
    .all();
  const keys = (rows.results || []).map((r) => ({ name: r.key }));
  return { keys };
}

// Удаляет все протухшие записи. Вызывается по cron (см. handleCleanupExpired).
async function cleanupExpired(db) {
  const res = await db
    .prepare('DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?')
    .bind(nowMs())
    .run();
  return res;
}

// Создаёт объект-«биндинг», совместимый с API KV, поверх D1.
// Использование в index.js:
//   const store = createStore(env);
//   await store.get('foo', { type: 'json' });
//   await store.put('foo', {...}, { expirationTtl: 604800 });
function createStore(env) {
  const db = env.DB;
  return {
    get: (key, opts) => get(db, key, opts),
    put: (key, value, opts) => put(db, key, value, opts),
    delete: (key) => del(db, key),
    list: (opts) => list(db, opts),
    cleanupExpired: () => cleanupExpired(db),
    _db: db,
  };
}

export { createStore };
