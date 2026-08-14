# Реестр аудита безопасности (регрессия)

Цель файла — разорвать цикл «аудит → фиксы → снова аудит → снова находки».
Каждый следующий аудит обязан начинаться с проверки **осталось vs исправлено** по этой таблице,
а не «с чистого листа». Находки, помеченные как «повторная/недоделанная», — это не новые
уязвимости, а незакрытые хвосты прошлых итераций.

- Дата создания: 2026-08-14
- Аудит: совет двух экспертов (план A + план B + взаимная рецензия)
- Режим: read-only (код, git-история, прод-проверки curl)

---

## 1. Как пользоваться реестром

1. При старте нового аудита прочитать этот файл и пройтись по колонке «Статус».
2. Для каждой находки со статусом `осталось`/`частично` — проверить, закрыта ли она в текущем коде.
3. Новые категории добавлять в конец, не переписывая историю.
4. При закрытии находки — обновить строку: статус → `исправлено`, указать коммит и дату.
5. В отчёте разделять:
   - **уязвимость** — реально эксплуатируемый сценарий через публичный API (с доказательством);
   - **рекомендация/гигиена** — теория, закрытая rate limit / CORS / валидацией;
   - **принятый риск** — осознанный компромисс (см. раздел 4).

---

## 2. Регрессионная таблица находок

Легенда статусов: `исправлено` · `частично` · `осталось` · `опровергнуто` · `принятый риск` · `инфо`

| ID | Приоритет | Находка | Место в коде | Статус | Коммит-фикс / дата | Проверка |
|---|---|---|---|---|---|---|
| F1 | Критично | Слабый словарный OWNER_CODE `supersecret-owner-code-123` в `site/.dev.vars` | `.dev.vars:1` | **опровергнуто** (прод вернул 403 — код другой; `.dev.vars` не в git) | — | curl 2026-08-14: 403 |
| F2 | High | `/api/invite/verify` не валидирует длину/формат токена (мусор `"aaaa"` → 200 OK; до 1 МБ → гигантский ключ D1) | `worker/index.js:1164` | **исправлено** | `f92c6bf` (2026-08-14) | node --check + grep формат 32-hex |
| F3 | Medium | TOCTOU: `withKeyLock` только в invite `create`, а `delete`/`rename` — RMW без блокировки | `index.js:955` vs `1283`, `1332` | **исправлено** | `f92c6bf` (2026-08-14) | node --check + grep withKeyLock (3 точки) |
| F4 | Medium | `withKeyLock` per-isolate: меж-изолятные RMW `hw:` → last-write-wins (потеря ДЗ) | `index.js:84-108`, `2024`, `2072`, `2169`, `2247` | **принятый риск** | `eb676ce` добавил per-key mutex (в рамках изолята) | статически |
| F5 | Medium | `cachedGet` кеширует без проверки Cache-Control; рассинхрон учёта writer-куки в `cachedGet`/`isAuthRequest` vs `cacheControlForGet` | `index.js:2838`, `2790-2792`, `2735-2738` vs `2702` | **исправлено** | `f92c6bf` (2026-08-14) | node --check + grep parseWriterCookie |
| F6 | Medium/Low | Нет `Vary: Origin` на reader-ответах (перетекание ACAO через CDN-кеш) | `index.js:2874` | **опровергнуто** (Cloudflare сам добавляет `Vary: Origin` при ACAO; перетекания не выявлено) | — | curl 2026-08-14: Vary: Origin присутствует |
| F7 | Low | verify-200 возвращает токен в теле без `Cache-Control: no-store` | `index.js:1198` | **исправлено** | `f92c6bf` (2026-08-14) | node --check + grep no-store |
| F8 | Low | TG webhook без дедупликации `update_id` (replay) | `index.js:3362-3553` | **принятый риск** (операции идемпотентны; подделать нельзя — secret_token) | — | статически |
| F9 | Low | `/api/writer/status`: до 20 записей в куке → до 20 D1-get на запрос | `index.js:1088-1099`, `792` | **принятый риск** (лёгкий D1-DoS; ранний выход `g !== group`) | — | статически |
| F10 | Инфо | weekCode не привязан к группе в GET-путях (данные публичны — не утечка) | `index.js:1447`, `1507` | **инфо** | — | наблюдение |
| F11 | Инфо | verify timing-оракул «ключ существует/нет» (32-hex + rate limit 10/мин) | `index.js:1169` | **инфо** | — | наблюдение |
| F12 | Инфо | `mdInline` вставляет URL в `href` без escHtml (entity-breakout) | `app.js:3055-3061` | **опровергнуто** (esc-first + вырез кавычек + whitelist протоколов) | `c8a4440` | анализ |
| F13 | Инфо | Path traversal / коллизии ключей D1 | `index.js:35`, `43`, `2374`; `store.js:129,145` | **исправлено** | `734bca2`, `eb676ce` | статически |
| F14 | Инфо | Rate limiting: fixed-window burst 2×, mem-fallback per-isolate | `index.js:3822-3847`, `3894-3919` | **принятый риск** | `d97f77d`, `eb676ce`, `42ffd91` | curl 2026-08-14: 429 срабатывает |
| F15 | Инфо | CSRF-цепочка корректна (JSON-only + X-Requested-With + CORS allowlist) | `index.js:356-389`, `874-880` | **исправлено** | `74bac49`, `47dbf3b` | статически |
| F16 | Инфо | Секреты не захардкожены; `.dev.vars`/`.wrangler` в `.gitignore`; CI без secrets | `.gitignore:1,3` | **исправлено** | `7164dd6`, `24eb64c` | git-проверка |
| F17 | Инфо | `securityHeaders` (worker) и `_headers` (Pages) идентичны | `index.js:396-409` vs `_headers:20-27` | **исправлено** | `d97f77d`, `eb676ce` | curl 2026-08-14 |
| F18 | Инфо | CSP sha256 inline-скрипта актуален | `_headers:28`, `index.html:21` | **исправлено** | — | пересчёт 2026-08-14: MATCH |
| A1 | Low | label в invite create/rename без `sanitizeString` (управляющие символы; рендер через escHtml) | `index.js:940`, `1338` | **исправлено** | `f92c6bf` (2026-08-14) | node --check + grep sanitizeString |
| A2 | Low | `body.code` в owner/login без лимита длины (CPU на SHA-256; закрыто rate limit 10/мин) | `index.js:992` | **исправлено** | `f92c6bf` (2026-08-14) | node --check + grep code.length |
| A3 | Low | `handleDeleteHw` id из query без проверки формата (not-found; инъекций нет) | `index.js:2239` | **исправлено** | `f92c6bf` (2026-08-14) | node --check + grep randomUUID (32-hex) |
| A4 | Инфо | KV-binding `SCHEDULE` не читается кодом (legacy) | `wrangler.toml:49-51` | **исправлено** (подтверждено grep — не используется) | — | grep 2026-08-14 |
| A5 | Инфо | `eval`/`new Function`/`document.write` отсутствуют | `app.js` | **исправлено** (grep пуст) | `9824199`, `74bac49` | grep 2026-08-14 |
| A6 | Инфо | `wrangler ^3.0.0` — CVE-проверка не выполнена (внешние API недоступны); devDependency, в проде не исполняется | `package.json:12` | **инфо** | — | — |
| A7 | Инфо | `ALLOWED_ORIGINS = translated.turbopages.org` (Яндекс.Перевод) | `wrangler.toml:33` | **принятый риск** | — | curl 2026-08-14 |
| A8 | Medium | Регрессия после A3: валидация строгого 32-hex в `handleDeleteHw` блокировала удаление legacy ДЗ с base36-id (`Date.now().toString(36) + Math.random().toString(36).slice(2,6)`, ~12 символов, напр. `mryzo5pd1pv9`) — найдено на проде (удаление ДЗ не работало) | `index.js:2309-2316` | **исправлено** | `f92c6bf` (2026-08-14) | прод: DELETE legacy-id → 403 (проходит валидацию), мусорный → 400 |

---

## 3. Ключевые фиксы по коммитам (история безопасности)

| Коммит | Содержимое |
|---|---|
| `baf12c8` (2026-08-14) | no-store для `__Host-writer_tokens` (кеш-отравление), валидация chatId в TG-callback, withKeyLock для inv-by-group RMW (**только create**), валидация длины/формата Bearer (32-hex/64), no-store на 4xx/5xx (VULN-006) |
| `f92c6bf` (2026-08-14) | пакет фиксов по реестру (задачи 1–7) + регрессия A8: валидация токена `invite/verify` (32-hex ≤64 → 400), `withKeyLock` для `invite` delete/rename, `cachedGet` не кеширует `private`/`no-store` + учёт writer-куки в `cachedGet`/`isAuthRequest`, `no-store` на 200-ответах verify, `sanitizeString` для `label`, лимит ≤128 для `owner/login` code, валидация `id` в `handleDeleteHw` (**оба формата**: новый 32-hex + legacy base36) |
| `eb676ce` | per-key mutex для ДЗ, привязка weekCode к группе при записи, санитизация subjects/campusUpdatedAt/weeks/dueDate, токены инвайтов не в DOM, in-memory fallback rate-limit, COOP/CORP |
| `47dbf3b` | экранирование HTML в TG, валидация chatId/enums/semester, CSRF-guard на owner/logout, Cache-Control перезаписывается при HIT, CSP: убран api.telegram.org |
| `d97f77d` | `__Host-owner_code`, timing-safe SHA-256, securityHeaders на все ответы, COOP/CORP/Permissions-Policy, rate-limit 600/мин |
| `c8a4440` | защита от prototype pollution в парсере, блок протокол-относительных ссылок в markdown |
| `74bac49` | CSRF: Content-Type JSON check + X-Requested-With guard, #owner/#invite hash-ссылки, sanitize ссылок в markdown |
| `734bca2` | CORS-allowlist, валидация group/weekCode, лимит тела запроса, зачистка токенов из URL, #invite вместо ?token, обязательный TG_WEBHOOK_SECRET |
| `9824199` | санитизация данных, escHtml, хэш OWNER_CODE в cookie, фикс IDOR, обязательный TG_WEBHOOK_SECRET |
| `392e485`, `8141d05` | ранние фиксы безопасности доступа |
| `42ffd91` | D1-based rate limiting |

---

## 4. Принятые риски (осознанные компромиссы — НЕ «исправлять»)

- `style-src 'unsafe-inline'` в CSP (38 мест `style.setProperty`).
- HSTS без `preload` (требует регистрации в hstspreload.org).
- Fixed-window rate limit: burst 2× на границе окна.
- `ALLOWED_ORIGINS = https://translated.turbopages.org` (Яндекс.Перевод).
- KV-binding `SCHEDULE` — legacy, не используется (для отката).
- Legacy-парсинг `?token=` / `?owner=` (для уже розданных ссылок).
- VULN-005: таймаут `withKeyLock` (zombie lock); не «чинить» AbortController-ом.
- F8 (replay update_id), F9 (20 D1-get в writer/status), F4 (меж-изолятные гонки).

---

## 5. Остаточные задачи (кандидаты на закрытие в следующей итерации)

1. **A6**: CVE-проверка `wrangler` при доступности внешних API.

---

## 6. Как проверять на проде (read-only, безопасно)

```bash
# owner/login оракул — РОВНО ОДНА попытка, куку НЕ фиксировать (при 200 — тревога)
curl -s -o NUL -w "%{http_code}" -X POST https://kampussgu.dpdns.org/api/owner/login \
  -H "Content-Type: application/json" -d '{"code":"<проверяемый код>"}'

# verify: невалидный токен (после F2 ожидается 400 {error: 'Invalid token'})
curl -s -X POST https://kampussgu.dpdns.org/api/invite/verify \
  -H "Content-Type: application/json" -d '{"token":"aaaa"}'

# CORS: чужой origin без ACAO; разрешённый — с ACAO + Vary: Origin
curl -s -D- -o NUL -H "Origin: https://evil.example" -G https://kampussgu.dpdns.org/api/status \
  --data-urlencode "group=131-ИБо"

# rate limit verify (≤11 запросов, мусорные токены) — ожидается 429 + Retry-After
```

> ⚠️ Не выполнять write-эндпоинты на проде (upload, sync, hw, subjects, invite create/delete/rename, logout).
> Не «чинить» принятые риски (раздел 4). Не воспроизводить гонки на проде.