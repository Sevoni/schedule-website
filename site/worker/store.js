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

// Глобальный logger текущего запроса. Поскольку каждый handler создаёт
// свой store через createStore(env), мы перенаправляем их на ОДИН общий
// logger запроса, чтобы в конце fetch можно было вывести сводку по всем
// запросам к БД за действие. ВНИМАНИЕ: при параллельной обработке нескольких
// запросов в одном изоляте статистики могут смешаться — для анализа
// производительности это приемлемо, для точной per-request метрики — нет.
let requestLogger = null;
export function setRequestLogger(l) {
  requestLogger = l;
}
export function getRequestLogger() {
  return requestLogger;
}

// ── Логирование производительности D1 ───────────────────────────────
// Включается при env.LOG_DB != '0' (по умолчанию вкл). Считает количество
// и суммарное время всех запросов за один вызов Worker, чтобы в wrangler tail
// было видно, сколько запросов и сколько мс заняла БД на действие.
function makeDbLogger(env) {
  const enabled = env.LOG_DB !== '0';
  const stats = { get: 0, put: 0, del: 0, list: 0, ms: 0 };
  return {
    enabled,
    stats,
    async wrap(op, key, fn) {
      if (!enabled) return fn();
      const t0 = nowMs();
      try {
        return await fn();
      } finally {
        const dt = nowMs() - t0;
        stats[op] = (stats[op] || 0) + 1;
        stats.ms += dt;
        // Детальная строка по каждому запросу (шумно, но полезно для анализа).
        if (env.LOG_DB_VERBOSE === '1') {
          console.log(`[db] ${op} ${key} ${dt}ms`);
        }
      }
    },
    flush(label) {
      if (!enabled) return;
      const total = stats.get + stats.put + stats.del + stats.list;
      if (total > 0) {
        console.log(
          `[db-summary] ${label || ''} queries=${total} ` +
          `get=${stats.get} put=${stats.put} del=${stats.del} list=${stats.list} ` +
          `totalMs=${stats.ms}`
        );
      }
    },
  };
}

// get(key, { type: 'json' | undefined })
// Возвращает строку (или распарсенный JSON при type:'json'), либо null,
// если ключа нет или он протух.
async function get(db, logger, key, opts = {}) {
  return logger.wrap('get', key, async () => {
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
  });
}

// put(key, value, { expirationTtl }) — value может быть строкой или объектом.
async function put(db, logger, key, value, opts = {}) {
  return logger.wrap('put', key, async () => {
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
  });
}

async function del(db, logger, key) {
  return logger.wrap('del', key, async () => {
    await db.prepare('DELETE FROM kv WHERE key = ?').bind(key).run();
  });
}

// list({ prefix }) — возвращает { keys: [{ name }] } как KV.
// value не возвращаем (как у KV list), вызывающие делают отдельный get.
async function list(db, logger, opts = {}) {
  const prefix = opts.prefix || '';
  return logger.wrap('list', prefix || '*', async () => {
    const escaped = prefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const rows = await db
      .prepare(`SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\' AND (expires_at IS NULL OR expires_at > ?) ORDER BY key`)
      .bind(escaped + '%', nowMs())
      .all();
    const keys = (rows.results || []).map((r) => ({ name: r.key }));
    return { keys };
  });
}

// listValues({ prefix }) — возвращает { entries: [{ key, value }] } сразу
// с данными. Заменяет паттерн list()+N*get() (N+1 запросов) одним SELECT.
// value парсится как JSON при opts.type === 'json', иначе строка.
async function listValues(db, logger, opts = {}) {
  const prefix = opts.prefix || '';
  return logger.wrap('list', prefix || '*', async () => {
    const escaped = prefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const rows = await db
      .prepare(`SELECT key, value FROM kv WHERE key LIKE ? ESCAPE '\\' AND (expires_at IS NULL OR expires_at > ?) ORDER BY key`)
      .bind(escaped + '%', nowMs())
      .all();
    const entries = (rows.results || []).map((r) => {
      let value = r.value;
      if (opts.type === 'json') {
        try { value = JSON.parse(r.value); } catch { value = null; }
      }
      return { key: r.key, value };
    });
    return { entries };
  });
}

// getMany(keys, { type }) — читает сразу несколько ключей одним
// SELECT ... WHERE key IN (...) запросом. Возвращает { entries: [{ key, value }] }.
// Используется агрегатором /api/schedules, чтобы убрать N параллельных get().
async function getMany(db, logger, keys, opts = {}) {
  if (!keys || keys.length === 0) return { entries: [] };
  return logger.wrap('get', `many(${keys.length})`, async () => {
    const placeholders = keys.map(() => '?').join(',');
    const rows = await db
      .prepare(`SELECT key, value FROM kv WHERE key IN (${placeholders}) AND (expires_at IS NULL OR expires_at > ?)`)
      .bind(...keys, nowMs())
      .all();
    const entries = (rows.results || []).map((r) => {
      let value = r.value;
      if (opts.type === 'json') {
        try { value = JSON.parse(r.value); } catch { value = null; }
      }
      return { key: r.key, value };
    });
    return { entries };
  });
}

// batch(operations) — пакетная запись/чтение через D1 db.batch().
// operations: массив подготовленных stmt (db.prepare(...).bind(...)).
// Возвращает результаты. Используется для замены цикла из N put().
async function batch(db, logger, operations) {
  if (!operations || operations.length === 0) return [];
  return logger.wrap('put', `batch(${operations.length})`, async () => {
    return await db.batch(operations);
  });
}

// Удаляет все протухшие записи. Вызывается по cron (см. handleCleanupExpired).
async function cleanupExpired(db, logger) {
  return logger.wrap('del', 'expired', async () => {
    const res = await db
      .prepare('DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?')
      .bind(nowMs())
      .run();
    return res;
  });
}

// Создаёт объект-«биндинг», совместимый с API KV, поверх D1.
// Использование в index.js:
//   const store = createStore(env);
//   await store.get('foo', { type: 'json' });
//   await store.put('foo', {...}, { expirationTtl: 604800 });
function createStore(env) {
  const db = env.DB;
  // Используем общий logger текущего запроса (если установлен через
  // setRequestLogger в fetch), иначе создаём локальный.
  const logger = getRequestLogger() || makeDbLogger(env);
  return {
    _logger: logger,
    _db: db,
    get: (key, opts) => get(db, logger, key, opts),
    put: (key, value, opts) => put(db, logger, key, value, opts),
    delete: (key) => del(db, logger, key),
    list: (opts) => list(db, logger, opts),
    listValues: (opts) => listValues(db, logger, opts),
    getMany: (keys, opts) => getMany(db, logger, keys, opts),
    batch: (operations) => batch(db, logger, operations),
    cleanupExpired: () => cleanupExpired(db, logger),
  };
}

export { createStore };
