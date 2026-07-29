# AGENTS.md

## Project overview

Campus schedule viewer for Syktyvkar State University (campus.syktsu.ru). No build system, no tests, no linting — pure vanilla JS frontend + Cloudflare Worker backend.

## Project structure

```
site/
├── worker/
│   ├── index.js              — Cloudflare Worker entry (~2400 lines)
│   └── store.js              — D1 storage adapter, KV-compatible API (~230 lines)
├── frontend/
│   ├── index.html            — SPA shell
│   ├── app.js                — main logic (~4150 lines)
│   ├── schedule-utils.js     — DEAD CODE (unused ES module, not imported)
│   ├── style.css             — dark theme
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

## Dev commands

```bash
cd site
npm run dev          # wrangler dev — local Worker + Pages
npm run deploy       # wrangler deploy + pages deploy — push to Cloudflare
npm run tail         # wrangler tail — live logs
npm run set-webhook  # set Telegram webhook on deployed Worker
```

No install step needed — only `wrangler` is a devDependency.

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
| `TG_WEBHOOK_SECRET` | Optional but recommended. Random string (1–256 chars) that Telegram sends back in the `X-Telegram-Bot-Api-Secret-Token` header on every webhook update. Without it, `/api/tg/webhook` accepts forged POSTs. Set the **same** value here and pass it to `npm run set-webhook` via `TG_WEBHOOK_SECRET` env var so the script includes `secret_token` in the `setWebhook` call. |

Generate OWNER_CODE: `python generate_owner_code.py` (or `--write-dev` to write to `.dev.vars`).

Local secrets go in `site/.dev.vars` (gitignored).

## Architecture

- **Worker** (`site/worker/`): two-file Cloudflare Worker. `index.js` handles routing, auth, all API handlers, Telegram integration. `store.js` is the D1 adapter with KV-compatible interface.
- **Frontend** (`site/frontend/`): vanilla JS SPA, no framework. Fetches from Worker API, falls back to parsing campus.syktsu.ru directly in the browser.
- **Cron** (`[triggers]` in wrangler.toml): daily cleanup of expired D1 rows.
- **Route**: `kampussgu.dpdns.org/api/*` → Worker (custom domain). Static Pages on same domain.
- **CORS**: Worker returns `Access-Control-Allow-Origin: *`.

### Auth (role-based access)

`resolveAuth(request, env)` reads `Authorization: Bearer <token>`:

- no header → **reader** (anonymous; group from query/body). GET only.
- token ∈ D1 `inv:{token}` → **writer** (group from the invite record). POST/PUT/DELETE.
- token === `env.OWNER_CODE` → **owner** (writer + invite management for any group).

All write endpoints are wrapped with `requireWriter()` → 403 for reader.

- **Owner login via link**: frontend reads `?owner=<OWNER_CODE>` on load → `becomeOwner()`.
- **Invite link**: frontend reads `?token=<invToken>` on load, validates via `/api/invite/verify`, saves as writer token.
- `INVITE_ORIGIN` (var) — canonical origin for invite links (`https://kampussgu.dpdns.org`).

### D1 key patterns

Same logical keys as old KV, now stored in D1 `kv` table with `expires_at`:

| Key pattern | TTL | Description |
|---|---|---|
| `schedule:{group}:{weekCode}` | 7d | Weekly schedule data |
| `weeks:{group}` | 7d | Weeks list |
| `hw:{group}` | 30d | Homework array |
| `group-pwd:{group}` | none | SHA-256 password hash |
| `sync:meta` | 7d | Last sync metadata |
| `subjects:{group}:{semester}` | 365d | Aggregated subjects for semester |
| `subjects-week:{group}:{semester}:{weekCode}` | 365d | Per-week subject snapshots |
| `campus-updated:{group}` | 7d | Campus update timestamp string |
| `inv:{token}` | 365d | Invite record `{ group, createdAt, label? }` |
| `inv-by-group:{group}` | 365d | Array of `{ id, token, createdAt, label? }[]` |
| `tg:sub:{group}:{chatId}` | none | TG subscriber `{ chatId, group, createdAt }` |

## API endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/status` | reader | KV health + last sync info |
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
| POST | `/api/auth` | — | Login (group + password → token) |
| POST | `/api/group/register` | — | Register new group with password |
| POST | `/api/invite/create` | writer | Create invite link |
| POST | `/api/invite/verify` | — | Verify invite token → group (public) |
| GET | `/api/invite?group=` | writer | List group invites |
| PUT | `/api/invite` | writer | Rename invite label |
| DELETE | `/api/invite?id=&group=` | writer | Revoke invite |
| POST | `/api/tg/webhook` | — | Telegram webhook receiver |
| POST | `/api/tg/set-webhook` | writer | Set webhook URL on Telegram |
| POST | `/api/tg/subscribe` | writer | Subscribe group chat to TG notifications |
| POST | `/api/tg/unsubscribe` | writer | Unsubscribe chat |
| GET | `/api/tg/status?group=&chatId=` | reader | Get subscription status |

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
