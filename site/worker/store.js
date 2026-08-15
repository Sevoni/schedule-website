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

// putMetaMerge(key, metaObj, { expirationTtl }) — атомарный upsert мета-записи
// `campus-updated:{group}` с merge по максимуму.
// Устраняет гонку при параллельных сохранениях расписания (несколько вкладок /
// повторный клик «синхронизировать»): обычный put() перезаписывал бы мету
// «последним записавшим» целиком и мог затереть более актуальные
// campusUpdatedAt/lastSync значением из более «старого» запроса. Одиночный
// SQL-запрос D1 выполняется атомарно (в т.ч. при параллельных запросах из
// разных изолятов Worker), поэтому конфликт разрешает сама БД:
//   - campusUpdatedAt = max(текущее, новое) — дата обновления кампуса;
//   - lastSync        = max(текущее, новое) — время синхронизации;
//   - lastWeek        = значение записи с максимальным lastSync.
// Строковое сравнение корректно для ISO-меток времени одного формата
// (campusUpdatedAt санитизируется sanitizeCampusUpdatedAt, lastSync всегда
// new Date().toISOString()). Легаси-значение (голая строка даты, не JSON)
// при конфликте просто перезаписывается новым JSON (миграция формата), а при
// отсутствии ключа выполняется обычный INSERT.
async function putMetaMerge(db, logger, key, metaObj, opts = {}) {
  return logger.wrap('put', key, async () => {
    const str = typeof metaObj === 'string' ? metaObj : JSON.stringify(metaObj);
    const expiresAt = opts.expirationTtl
      ? nowMs() + opts.expirationTtl * 1000
      : null;
    await db
      .prepare(
        `INSERT INTO kv (key, value, expires_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = CASE
             WHEN json_valid(value) = 1 AND json_valid(excluded.value) = 1
               THEN json_object(
                 'campusUpdatedAt', CASE
                   WHEN json_extract(value, '$.campusUpdatedAt') IS NULL THEN json_extract(excluded.value, '$.campusUpdatedAt')
                   WHEN json_extract(excluded.value, '$.campusUpdatedAt') IS NULL THEN json_extract(value, '$.campusUpdatedAt')
                   WHEN json_extract(excluded.value, '$.campusUpdatedAt') >= json_extract(value, '$.campusUpdatedAt') THEN json_extract(excluded.value, '$.campusUpdatedAt')
                   ELSE json_extract(value, '$.campusUpdatedAt')
                 END,
                 'lastSync', CASE
                   WHEN json_extract(value, '$.lastSync') IS NULL THEN json_extract(excluded.value, '$.lastSync')
                   WHEN json_extract(excluded.value, '$.lastSync') IS NULL THEN json_extract(value, '$.lastSync')
                   WHEN json_extract(excluded.value, '$.lastSync') >= json_extract(value, '$.lastSync') THEN json_extract(excluded.value, '$.lastSync')
                   ELSE json_extract(value, '$.lastSync')
                 END,
                 'lastWeek', CASE
                   WHEN json_extract(value, '$.lastSync') IS NULL THEN json_extract(excluded.value, '$.lastWeek')
                   WHEN json_extract(excluded.value, '$.lastSync') IS NULL THEN json_extract(value, '$.lastWeek')
                   WHEN json_extract(excluded.value, '$.lastSync') >= json_extract(value, '$.lastSync') THEN json_extract(excluded.value, '$.lastWeek')
                   ELSE json_extract(value, '$.lastWeek')
                 END
               )
             ELSE excluded.value
           END,
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

// batchGet(items) — пакетное чтение N ключей одним вызовом db.batch().
// items: массив { key, type?: 'json' }. Возвращает массив значений
// в том же порядке (null для отсутствующих/протухших ключей).
// Все SELECT выполняются одним round-trip к D1 — критично для
// холодного старта при медленном соединении.
async function batchGet(db, logger, items) {
  if (!items || items.length === 0) return [];
  return logger.wrap('get', `batchGet(${items.length})`, async () => {
    const now = nowMs();
    const stmts = items.map(({ key }) =>
      db.prepare('SELECT value, expires_at FROM kv WHERE key = ?').bind(key)
    );
    const results = await db.batch(stmts);
    return results.map((r, i) => {
      const row = r.results?.[0];
      if (!row) return null;
      if (row.expires_at != null && row.expires_at <= now) return null;
      if (items[i].type === 'json') {
        try { return JSON.parse(row.value); } catch { return null; }
      }
      return row.value;
    });
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
    putMetaMerge: (key, value, opts) => putMetaMerge(db, logger, key, value, opts),
    delete: (key) => del(db, logger, key),
    list: (opts) => list(db, logger, opts),
    listValues: (opts) => listValues(db, logger, opts),
    getMany: (keys, opts) => getMany(db, logger, keys, opts),
    batchGet: (items) => batchGet(db, logger, items),
    batch: (operations) => batch(db, logger, operations),
    cleanupExpired: () => cleanupExpired(db, logger),
  };
}

export { createStore };
