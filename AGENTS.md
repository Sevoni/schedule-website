# AGENTS.md

## Project overview

Campus schedule viewer for Syktyvkar State University (campus.syktsu.ru). No build system, no tests, no linting — pure vanilla JS frontend + Cloudflare Worker backend.

## Project structure

```
site/
├── worker/
│   ├── index.js              — Cloudflare Worker entry (~2900 lines)
│   └── store.js              — D1 storage adapter, KV-compatible API (~250 lines)
├── frontend/
│   ├── index.html            — SPA shell (has ONE inline <script> — see CSP note)
│   ├── app.js                — main logic (~4600 lines)
│   ├── schedule-utils.js     — DEAD CODE (unused ES module, not imported)
│   ├── style.css             — dark theme
│   ├── _headers              — Pages security headers incl. CSP hash for inline script
│   └── icons/                — SVG icons (door-open.svg)
├── migrations/
│   └── 0001_init.sql         — D1 schema (kv table + expires index)
├── scripts/
│   └── set-webhook.js        — Telegram webhook setup script
├── generate_owner_code.py    — OWNER_CODE generator (Python)
├── package.json              — only devDep: wrangler
├── wrangler.toml             — Worker + D1 + KV (legacy) + cron + routes
└── .dev.vars                 — local secrets (OWNER_CODE, TELEGRAM_BOT_TOKEN)
```

Reference HTML dumps for the campus parser live at the **repo root**, not in `site/`: `schedule4.html` and `Расписание аудитории.html`.

## Dev commands

```bash
cd site
npm run dev          # wrangler dev — local Worker + Pages
npm run deploy       # wrangler deploy + pages deploy — push to Cloudflare
npm run tail         # wrangler tail — live logs
npm run set-webhook  # set Telegram webhook on deployed Worker
```

No install step needed — only `wrangler` is a devDependency.

> ⚠️ **Локальный тест НЕ РАБОТАЕТ — не запускать!** `npm run dev` (wrangler dev) и
> `npx wrangler d1 execute schedule-db --local` на этой машине не поднимают валидный
> смоук-тест (процесс зависает / тест не проходит). Единственный рабочий путь
> проверки изменений — `npm run deploy` и проверка на проде через публичные
> GET-эндпоинты (`curl https://kampussgu.dpdns.org/api/status?group=131-ибo`,
> `/api/bootstrap`, `/api/schedule`, `/api/weeks`). Запись (writer-эндпоинты)
> на проде без продового writer-токена не проверить — только read-проверка.

## Storage: D1 (primary), KV (legacy)

Primary storage is **Cloudflare D1** (SQLite). KV binding `SCHEDULE` is kept for rollback but **not used after migration**.

`worker/store.js` wraps D1 with a KV-compatible API (`get`, `put`, `delete`, `list`, `listValues`, `getMany`, `batch`, `cleanupExpired`). All `key` values are strings; all `value` values stored as JSON strings. TTL implemented via `expires_at` column (unix ms).

### D1 setup (one-time)

```bash
npx wrangler d1 create schedule-db
npx wrangler d1 execute schedule-db --remote --file=./migrations/0001_init.sql
npx wrangler d1 execute schedule-db --local  --file=./migrations/0001_init.sql
```

Then paste `database_id` from output into `wrangler.toml` `[[d1_databases]]`.

### D1 cleanup

Expired rows deleted by cron trigger daily at 04:23 UTC (`wrangler.toml [triggers]`). KV had automatic TTL; D1 requires manual cleanup.

## Secrets

Set via `npx wrangler secret put <NAME>`:

| Secret | Purpose |
|---|---|
| `OWNER_CODE` | Owner role auth. Any string. Without it, no first invite link can be created. |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather. Enables TG notifications. |
| `TG_WEBHOOK_SECRET` | **Required.** Random string (1–256 chars) that Telegram sends back in the `X-Telegram-Bot-Api-Secret-Token` header on every webhook update. Without it the worker returns 503 on `/api/tg/webhook` and `set-webhook.js` refuses to run — Telegram rejects updates only if this header doesn't match. Set the **same** value here and pass it to `npm run set-webhook` via `TG_WEBHOOK_SECRET` env var so the script includes `secret_token` in the `setWebhook` call. |

Generate OWNER_CODE: `python generate_owner_code.py` (or `--write-dev` to write to `.dev.vars`).

Local secrets go in `site/.dev.vars` (gitignored).

## Architecture

- **Worker** (`site/worker/`): two-file Cloudflare Worker. `index.js` handles routing, auth, all API handlers, Telegram integration. `store.js` is the D1 adapter with KV-compatible interface.
- **Frontend** (`site/frontend/`): vanilla JS SPA, no framework. Fetches from Worker API, falls back to parsing campus.syktsu.ru directly in the browser.
- **Cron** (`[triggers]` in wrangler.toml): daily cleanup of expired D1 rows.
- **Route**: `kampussgu.dpdns.org/api/*` → Worker (custom domain). Static Pages on same domain.
- **CORS**: strict allowlist, NOT `*`. Worker returns `Access-Control-Allow-Origin: <origin>` only for allowed origins: preview domains `*.schedule-worker.pages.dev` **only when var `ALLOW_PREVIEW_CORS === "true"`** (default `"false"` on prod; local override in `.dev.vars`) + list from env var `ALLOWED_ORIGINS` (comma-separated, in `wrangler.toml` `[vars]`). Preview builds (`{hash}.schedule-worker.pages.dev`) deliberately do NOT work against the prod API — frontend testing happens via deploy to the main domain. Same-origin requests and curl (no `Origin` header) get no CORS headers at all. Preflight `OPTIONS` returns 204 for allowed origins, no CORS headers otherwise. CORS headers are stripped from cached responses and re-applied per request in `cachedGet` (cache poisoning protection). `Access-Control-Allow-Credentials` is intentionally NOT set (auth is Bearer-header based). On top of CORS, ALL `/api/*` responses (incl. 429 `rateLimitResponse`, TG webhook `tgWebhookResponse`, preflight `OPTIONS`) get a uniform defensive base via the single `securityHeaders` object in `worker/index.js`: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Strict-Transport-Security: max-age=31536000; includeSubDomains` (no `preload` — requires hstspreload.org registration), `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, `Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=()` (identical to static `frontend/_headers`). COOP/CORP are NOT CORS headers — `cachedGet` strips/re-applies only `CORS_HEADER_NAMES`, so they stay on cached responses harmlessly.
- **CDN caching**: public GETs are manually cached via Cache API (`cachedGet` in `worker/index.js`): readers get `public, max-age=60, s-maxage=300` (CDN 5 min), writers `private, no-store`. After every write the worker purges that group's cached URLs (`purgeGroupCdnCache`). If you test with curl and see stale data, pass an `Authorization: Bearer` header (bypasses cache) or wait for purge.

### Auth (role-based access)

`resolveAuth(request, env)` reads `Authorization: Bearer <token>` and, if absent, the **HttpOnly cookie `__Host-owner_code`**:

- no header + no cookie → **reader** (anonymous; group from query/body). GET only.
- token ∈ D1 `inv:{token}` → **writer** (group from the invite record). POST/PUT/DELETE.
- token === `env.OWNER_CODE` OR valid `__Host-owner_code` cookie (constant-time compare of SHA-256 hash via `ownerFromCookie`, **no D1 hit**) → **owner** (writer + invite management for any group).

All write endpoints are wrapped with `requireWriter()` → 403 for reader.

- **Owner login**: `POST /api/owner/login` `{ code }` → on success sets HttpOnly `__Host-owner_code` cookie (30 days, `Secure; SameSite=Lax; Path=/`, no Domain — `__Host-` prefix locks these attributes). The code is **never stored in localStorage or JS state** — JS can't read it (`document.cookie` won't see HttpOnly). The frontend restores `ownerRole` on every load via a lightweight `GET /api/owner/status` (computed from the cookie server-side, no D1) — this runs at the start of `loadData()` because the cache-only fast path (warm localStorage caches) skips `/api/bootstrap` entirely. `isOwner` is also returned in `/api/bootstrap`. Requests from an owner with cookie bypass CDN cache (`cachedGet`/`cacheControlForGet` treat cookie like Bearer).
- **Owner logout**: `POST /api/owner/logout` → clears the cookie (button in settings «Ваша роль»).
- **Owner login via link**: frontend reads `#owner=<OWNER_CODE>` (new links, hash not logged) or `?owner=<OWNER_CODE>` (LEGACY, still parsed for already-distributed links — logs `console.warn('[deprecated] legacy ?owner= link used; please migrate to #-format')`) on load → `becomeOwner()` → `POST /api/owner/login`. New owner links are only referenced in `#owner=` form (`index.html` shows `…/#owner=<код>`).
- **Invite link**: **all new links are generated ONLY in hash form** `#invite=<token>` (avoids server logs/history/caches) — both in the worker (`handleInviteCreate`) and on the frontend (`copyInviteLink`). The legacy `?token=<invToken>` format is still **parsed** for already-distributed links (logs `console.warn('[deprecated] legacy ?token= link used; please migrate to #-format')`), but never generated. Frontend reads the link on load, validates via `/api/invite/verify`, saves as writer token; legacy `?token=` is accepted for already-distributed links only.
- `INVITE_ORIGIN` (var) — canonical origin for invite links (`https://kampussgu.dpdns.org`).

### CSRF protection (не ломать!)

Two layers on top of cookie-based owner auth (cookie `__Host-owner_code` is auto-attached by the browser, incl. same-site form-POST from any `*.dpdns.org` subdomain):

1. **`readJsonBody()` rejects any non-`application/json` Content-Type** (`parseError` → 400). HTML forms can't send JSON, so text/plain JSON-smuggling is dead. All body-reading handlers get this via `readJsonBody` — don't bypass it.
2. **`csrfGuardForCookieAuth(auth, request, corsHeaders)`** — requires header `X-Requested-With: fetch` when owner role came from cookie (`auth.viaCookie`). Used in `requireWriter` + invite handlers (create/delete/rename — NOT list: it's a read-only GET, no side effects, no CSRF value). Frontend sends this header in `apiPost`/`apiPut`/`apiDelete` (app.js) — keep it there. Bearer-auth (writer/owner via `Authorization`) doesn't need the header. `apiFetch` (GETs) doesn't send it on purpose — keeps preview-domain GETs preflight-free.

Rule: **every new write/owner-powerful endpoint** that can be reached with cookie auth must call `csrfGuardForCookieAuth` after `resolveAuth`, and the frontend call must go through one of the `api*` helpers (they add the header). Public endpoints (`/api/owner/login|logout|status`, `/api/invite/verify`) don't use the guard.

### D1 key patterns

Same logical keys as old KV, now stored in D1 `kv` table with `expires_at`. TTLs are passed as `expirationTtl` **in seconds** (see `store.js:put`). Note: schedule/weeks/hw/campus-updated all use `21600000` sec (≈250 days), NOT 7d as in the old KV era:

| Key pattern | TTL | Description |
|---|---|---|
| `schedule:{group}:{weekCode}` | 250d | Weekly schedule data |
| `weeks:{group}` | 250d | Weeks list |
| `hw:{group}` | 250d | Homework array |
| `subjects:{group}:{semester}` | 365d | Aggregated subjects for semester |
| `subjects-week:{group}:{semester}:{weekCode}` | 365d | Per-week subject snapshots |
| `campus-updated:{group}` | 250d | Per-group meta JSON `{ campusUpdatedAt, lastSync, lastWeek }` (legacy string migrates on read via `parseCampusMeta`) |
| `inv:{token}` | 365d | Invite record `{ group, createdAt, label? }` |
| `inv-by-group:{group}` | 365d | Array of `{ id, token, createdAt, label? }[]` |
| `tg:subs:{group}` | none | TG subscribers `[{ chatId, subgroup: 'any'\|'1'\|'2' }, ...]` |
| `tg:groups:{chatId}` | none | Reverse index `[group, ...]` per chat |
| `rl:{kind}:{ip}:{windowStart}` | ~120s | Rate-limit counters (see Rate limiting) |

Legacy keys auto-migrated on read: `tg:chat:{group}` (single chatId string) → `tg:subs:{group}`. `group-pwd:{group}` is DEAD — the old password login (`/api/auth`) was removed; writer access is invite-token only.

D1 access is logged per request as `[db-summary]` (count + total ms) — see `wrangler.toml` `LOG_DB` / `LOG_DB_VERBOSE` vars.

## API endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/status` | reader | D1 health + last sync info |
| GET | `/api/bootstrap` | reader | Combined: weeks + current schedule + subjects |
| GET | `/api/schedule?group=&week=` | reader | Get one week's schedule |
| GET | `/api/schedules?group=&weeks=` | reader | Get multiple weeks (batch) |
| GET | `/api/weeks?group=` | reader | Get weeks list |
| POST | `/api/upload` | writer | Upload weeks/schedule/schedule-batch |
| GET | `/api/subjects?group=` | reader | Get semester subjects |
| POST | `/api/subjects` | writer | Override subjects list |
| GET | `/api/hw?group=` | reader | Get all homework |
| POST | `/api/hw` | writer | Create homework |
| PUT | `/api/hw` | writer | Update homework |
| PUT | `/api/hw/batch` | writer | Batch update homework |
| DELETE | `/api/hw` | writer | Delete homework |
| POST | `/api/hw/recalc` | writer | Recalc all nextPair dueDates |
| POST | `/api/check-campus-update` | writer | Check if campus data changed |
| POST | `/api/sync-from-campus` | writer | Full sync: save + update subjects + recalc HW |
| POST | `/api/invite/create` | writer | Create invite link |
| POST | `/api/invite/verify` | — | Verify invite token → group (public) |
| POST | `/api/owner/login` | — | Owner login: sets HttpOnly `__Host-owner_code` cookie (public, rate-limited) |
| POST | `/api/owner/logout` | — | Owner logout: clears `__Host-owner_code` cookie (public, rate-limited) |
| GET | `/api/owner/status` | — | Owner role check: `{ isOwner }` from HttpOnly cookie / Bearer (public, no D1, always `private, no-store`) |
| GET | `/api/invite?group=` | writer | List group invites |
| PUT | `/api/invite` | writer | Rename invite label |
| DELETE | `/api/invite?id=&group=` | writer | Revoke invite |
| POST | `/api/tg/webhook` | — | Telegram webhook receiver (bot commands + callbacks) |
| POST | `/api/tg/status` | reader | Get subscription status: body `{ group, chatId }` → `{ subscribed, botUsername }`. **POST, не GET** — chatId (личный ID чата) не должен попадать в URL/логи. Ответ `no-store`, rate limit `tgstatus` 30/мин |

No `/api/auth`, `/api/group/register`, `/api/tg/subscribe`, `/api/tg/unsubscribe` or `/api/tg/set-webhook` endpoints exist anymore — writer access is invite-token only, and TG subscriptions are managed **inside the bot itself** (webhook): `/sub <группа>` → inline keyboard to pick subgroup, `/status`. Unsubscribe is only via `/stop` in the bot (chatId comes from the signed webhook update, not from the client).

## Rate limiting

D1-based fixed-window counters stored in the same `kv` table (`rl:{kind}:{ip}:{windowStart}`, TTL ≈120s). Applied to every request before routing (see `applyRateLimits` in `worker/index.js`). Per-IP, 60s window: **global 600** (all requests — щадящий лимит из-за CGNAT/NAT: за одним cf-connecting-ip сидят сотни людей, 120 давало ложные 429), **verify 10** (`/api/invite/verify`, `/api/invite/create`, `/api/owner/login`, `/api/owner/logout`), **tg 60** (`/api/tg/webhook`), **tgstatus 30** (`/api/tg/status`). Over limit → `429` + `Retry-After` header; the frontend shows a toast on 429. Each 429 logs `[rate-limited] kind=… ip=… windowStart=… count=… limit=…` (see `rateLimitResponse`) — track the 429 share via `wrangler tail`. If D1 errors, limits fail **open** (bounded): `verify` is fail-closed (429 `degraded`), while `global`/`tg`/`tgstatus` fall back to an in-memory per-isolate counter (`memRateLimitCheck`) so an outage doesn't become «unlimited» while preserving availability. Don't hammer endpoints in loops while testing — bursty scripts hit 429 quickly.

## Data model

- **Schedule pair** `{ subject, teacher, room, type, subgroup, time }`:
  - `subject`: clean name, no type suffix (e.g. `"Математика"`)
  - `type`: pair type code (`"л"`, `"пр"`, `"пз"`, `"лаб"`, `"с"`, `"зчО"`, `"зач"`, `""`)
  - `subgroup`: `"подгруппа 1"`, `"подгруппа 2"`, or `""`
  - Display name via `PAIR_TYPE_NAMES[type]` (e.g. `"лекция"`)
- **Homework** `{ id, subject, pairType, subgroup, task, dueMode, dueDate, author, createdAt }`:
  - `pairType`: code (`"л"`, `"пр"`, etc.) or `"any"` for all types
  - `dueMode`: `"nextPair"` or `"date"`
  - `subgroup`: `"1"`, `"2"`, or `"any"`
- **Subjects** `{ subject, pairTypes: [...], subgroups: { [pairType]: [code, ...] } }`

## Campus sync

The frontend fetches HTML from `campus.syktsu.ru` directly in the browser (CORS works from browser). The Worker acts as a D1 cache/database — the frontend reads from D1 first, only falls back to parsing campus directly if cache is empty.

### `syncAll()` (refresh button)

1. Checks campus update time via `/api/check-campus-update`.
2. Fetches current week + 4 ahead from campus in parallel.
3. Sends to Worker via `/api/sync-from-campus` — Worker saves data, updates subjects, recalcs HW due dates.
4. Frontend preserves user's current week selection.

### `backgroundSync()` (first page load)

1. Fetches weeks list from campus.
2. Fetches current week + 2 ahead from campus in parallel.
3. Sends to Worker — only changed data is overwritten.
4. If campus is unavailable, silently keeps the cache.

## HTML parser

The frontend parses `campus.syktsu.ru` HTML with regex (not DOM). The parser extracts: week options (`<select name="weeks">`), schedule table (`<table class="schedule">`), day headers, pair cells. If the university changes their HTML structure, these regexes break. `schedule4.html` is a reference HTML dump for testing.

## Subject option encoding

The homework modal encodes `subject + type + subgroup` into `<select>` option values using `\u0001` as separator via `encodePairValue()`/`decodePairValue()`. This allows multiple types/subgroups of the same subject to appear as distinct options.

## Conventions

- All UI text is in Russian
- Default group: `131-ИБо`
- No package manager lockfile — `node_modules` not tracked
- No TypeScript, no bundler, no transpiler — plain JS
- `schedule-utils.js` is dead code (ES module, not imported) — all its functions are duplicated inline in `app.js`
- Hotkeys (`setupKeyboardShortcuts` in app.js): `←`/`→` switch weeks, `1`–`6` select day, `Esc` closes the HW view modal; ignored while typing in inputs/selects
- CSP gotcha: `frontend/_headers` whitelists the ONE inline `<script>` in `index.html` (no-group class hack) by sha256 hash — if you change that inline script, recompute and update the hash in `_headers`, otherwise the site breaks
- Отвечать пользователю только на русском языке

## Deploy

```bash
cd site
npm run deploy
```

Команда: `wrangler deploy && wrangler pages deploy frontend --project-name=schedule-worker`. Она:
1. Деплоит Worker (`site/worker/`) на `schedule-worker.campus-schedule-syktyvkar.workers.dev`
2. Деплоит Pages фронтенд (`site/frontend/`) на `{hash}.schedule-worker.pages.dev`

Деплой занимает ~20-30 секунд. После деплоя URL-ы меняются — проверяй вывод команды.
