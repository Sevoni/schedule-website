# AGENTS.md

## Project overview

Campus schedule viewer for Syktyvkar State University (campus.syktsu.ru). No build system, no tests, no linting — pure vanilla JS frontend + Cloudflare Worker backend.

## Project structure

```
site/
├── worker/index.js          — Cloudflare Worker (~930 lines)
├── frontend/
│   ├── index.html           — SPA shell
│   ├── app.js               — main logic (~2150 lines)
│   ├── schedule-utils.js    — DEAD CODE (unused ES module, not imported)
│   └── style.css            — dark theme
├── package.json             — only devDep: wrangler
└── wrangler.toml            — KV binding SCHEDULE, env vars CAMPUS_URL, DEFAULT_GROUP
```

## Dev commands

```bash
cd site
npm run dev     # wrangler dev — local Worker + Pages
npm run deploy  # wrangler deploy + pages deploy — push to Cloudflare
npm run tail    # wrangler tail — live logs
```

No install step needed — only `wrangler` is a devDependency.

## Architecture

- **Worker** (`site/worker/index.js`): single-file Cloudflare Worker, ~930 lines. Handles schedule CRUD, homework CRUD, subjects aggregation, KV storage.
- **KV namespace** `SCHEDULE`: stores schedule data, weeks, homework, subjects, group passwords.
- **Frontend** (`site/frontend/`): vanilla JS SPA, no framework. Fetches from Worker API, falls back to parsing campus.syktsu.ru directly in the browser.
- **Auth**: token scheme defined (`btoa(JSON.stringify({group, ts}))`, SHA-256 passwords) but **NOT enforced** — `verifyAuth()` exists but is never called. All endpoints are public.
- **CORS**: Worker returns `Access-Control-Allow-Origin: *`.

## KV key patterns

| Key | TTL | Description |
|---|---|---|
| `schedule:{group}:{weekCode}` | 7d | Weekly schedule data |
| `weeks:{group}` | 7d | Weeks list |
| `hw:{group}` | 30d | Homework array |
| `group-pwd:{group}` | none | SHA-256 password hash |
| `sync:meta` | 7d | Last sync metadata |
| `subjects:{group}:{semester}` | 365d | Aggregated subjects for semester |
| `subjects-week:{group}:{semester}:{weekCode}` | 365d | Per-week subject snapshots |
| `campus-updated:{group}` | 7d | Campus update timestamp string |
| `schedule:{group}:current` | — | Legacy key, deleted during cleanup (not written) |

## API endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/status` | KV health + last sync info |
| GET | `/api/schedule?group=&week=` | Get one week's schedule from KV |
| GET | `/api/weeks?group=` | Get weeks list |
| POST | `/api/upload` | Upload weeks/schedule/schedule-batch |
| GET | `/api/subjects?group=` | Get semester subjects |
| POST | `/api/subjects` | Override subjects list |
| GET | `/api/hw?group=` | Get all homework |
| POST | `/api/hw` | Create homework |
| PUT | `/api/hw` | Update homework |
| DELETE | `/api/hw` | Delete homework |
| POST | `/api/hw/recalc` | Recalc all nextPair dueDates |
| POST | `/api/check-campus-update` | Check if campus data changed |
| POST | `/api/sync-from-campus` | Full sync: save + update subjects + recalc HW |
| POST | `/api/auth` | Login (group + password → token) |
| POST | `/api/group/register` | Register new group with password |

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

The frontend fetches HTML from `campus.syktsu.ru` directly in the browser (CORS works from browser). The Worker acts as a KV cache/database — the frontend reads from KV first, only falls back to parsing campus directly if cache is empty.

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

The homework modal encodes `subject + type + subgroup` into `<select>` option values using `\u0001` as separator via `encodePairValue()`/`decodePairValue()`. This allows multiple types/subgroups of the same subject to appear as distinct options in the "Сегодня" list.

## Conventions

- All UI text is in Russian
- Default group: `131-ИБо`
- No package manager lockfile — `node_modules` not tracked
- No TypeScript, no bundler, no transpiler — plain JS
- `schedule-utils.js` is dead code (ES module, not imported) — all its functions are duplicated inline in `app.js`
- `test.html` is legacy (can be ignored)
- Отвечать пользователю только на русском языке

## Deploy

```bash
cd site
npm run deploy
```

Это команда `wrangler deploy && wrangler pages deploy frontend --project-name=schedule-worker`. Она:
1. Деплоит Worker (`site/worker/index.js`) на `schedule-worker.campus-schedule-syktyvkar.workers.dev`
2. Деплоит Pages фронтенд (`site/frontend/`) на `{hash}.schedule-worker.pages.dev`

Деплой занимает ~20-30 секунд. После деплоя URL-ы меняются — проверяй вывод команды.
