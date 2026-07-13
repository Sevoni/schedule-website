# AGENTS.md

## Project overview

Campus schedule viewer for Syktyvkar State University (campus.syktsu.ru). No build system, no tests, no linting — pure vanilla JS frontend + Cloudflare Worker backend.

## Two codebases in one repo

| Directory | What it is | Runs where |
|---|---|---|
| `frontend/` | Standalone browser-only version. Parses campus HTML directly, stores HW in localStorage. No backend needed. | Open `index.html` in browser |
| `site/` | Cloudflare Worker (KV-backed API) + Pages frontend. Has sync, auth, multi-group support. | `wrangler dev` / `wrangler deploy` |

**Key difference:** `frontend/app.js` is the simpler, self-contained variant. `site/frontend/app.js` is the production version that talks to the Worker API. The HTML parsers in both are near-identical — changes to parsing logic usually need to be mirrored.

## Dev commands (site/ only)

```bash
cd site
npm run dev     # wrangler dev — local Worker + Pages
npm run deploy  # wrangler deploy — push to Cloudflare
npm run tail    # wrangler tail — live logs
```

No install step needed — only `wrangler` is a devDependency.

## Architecture

- **Worker** (`site/worker/index.js`): single-file Cloudflare Worker, ~390 lines. Handles auth, schedule CRUD, homework CRUD, KV storage.
- **KV namespace** `SCHEDULE`: stores schedule data, weeks, homework, group passwords. Keys: `schedule:{group}:{weekCode}`, `weeks:{group}`, `hw:{group}`, `group-pwd:{group}`.
  - `schedule:{group}:current` is deleted during batch sync (legacy key, no longer written).
  - `sync:meta` stores last sync metadata.
- **Frontend** (`site/frontend/`): vanilla JS SPA, no framework. Fetches from Worker API, falls back to parsing campus.syktsu.ru directly in the browser.
- **Auth**: simple token scheme — `btoa(JSON.stringify({group, ts}))` as Bearer token, 30-day expiry. Passwords stored as SHA-256 hashes in KV.
- **CORS**: Worker returns `Access-Control-Allow-Origin: *`.

## Data model

- **Schedule pair** `{ subject, teacher, room, type, subgroup }`:
  - `subject`: clean name, no type suffix (e.g. `"Математика"`)
  - `type`: pair type code (`"л"`, `"пр"`, `"пз"`, `"лаб"`, `"с"`, `"зчО"`, `"зач"`, `""`)
  - Display name via `PAIR_TYPE_NAMES[type]` (e.g. `"лекция"`)
- **Homework** `{ subject, pairType, dueMode, ... }`:
  - `pairType`: code (`"л"`, `"пр"`, etc.) or `"any"` for all types
  - `dueMode`: `"nextPair"` or `"date"`
- Subject matching in worker uses `p.subject` and `p.type` directly — no `splitSubjectType()` needed.

## Campus sync

Campus sync updates the **server-side KV cache** — it fetches HTML from `campus.syktsu.ru`, parses it, and stores schedule data in the Worker's KV storage. This is needed because the campus API is not available to the browser (CORS), so the Worker acts as a proxy/cache. The frontend always reads from KV first, and only falls back to parsing campus directly in the browser if the cache is empty.

## HTML parser

Both frontends parse `campus.syktsu.ru` HTML with regex (not DOM). The parser extracts: week options (`<select name="weeks">`), schedule table (`<table class="schedule">`), day headers, pair cells. If the university changes their HTML structure, these regexes break.

## Conventions

- All UI text is in Russian
- Default group: `131-ИБо`
- No package manager lockfile — `node_modules` not tracked
- `test.html` is a legacy standalone test page (can be ignored)
- No TypeScript, no bundler, no transpiler — plain ES modules

## Batch sync (`syncAll`)

When the user clicks the refresh button, `syncAll()` in `app.js`:

1. Fetches the weeks list from campus, preserving the user's current week selection.
2. Determines which weeks to fetch via `getWeeksToSync()`:
   - **Past week selected** → only that one week
   - **Current week selected** → current + 4 ahead
   - **Future week selected** → from current to (selected + 2)
3. Fetches the selected range from campus in parallel via `Promise.all`.
4. Sends everything to the Worker as a `schedule-batch` upload.
5. The Worker compares each week's JSON against what's already in KV (ignoring `parsedAt`) and only writes if changed.
6. Cleanup: `KV.list({ prefix: "schedule:{group}:" })` deletes `schedule:{group}:current` and any week keys not in the current weeks list.
7. The frontend preserves the user's current week selection (does not jump to the current week).

The old single-week `type: 'schedule'` upload is still used by `loadSchedule()` fallback (cache miss → parse campus → upload one week).

## Background sync (`backgroundSync`)

On first page load, `loadData()` shows cached data immediately, then calls `backgroundSync()`:

1. Fetches weeks list from campus in the background.
2. Fetches current week + 2 weeks ahead from campus in parallel.
3. Sends to Worker as `schedule-batch` — only changed data is overwritten in KV.
4. If campus is unavailable (CORS, network), silently keeps the cache as-is.
5. Updates the UI if the user's current week data changed.
