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

- **Worker** (`site/worker/index.js`): single-file Cloudflare Worker, ~343 lines. Handles auth, schedule CRUD, homework CRUD, KV storage.
- **KV namespace** `SCHEDULE`: stores schedule data, weeks, homework, group passwords. Keys: `schedule:{group}:{weekCode}`, `weeks:{group}`, `hw:{group}`, `group-pwd:{group}`.
- **Frontend** (`site/frontend/`): vanilla JS SPA, no framework. Fetches from Worker API, falls back to parsing campus.syktsu.ru directly in the browser.
- **Auth**: simple token scheme — `btoa(JSON.stringify({group, ts}))` as Bearer token, 30-day expiry. Passwords stored as SHA-256 hashes in KV.
- **CORS**: Worker returns `Access-Control-Allow-Origin: *`.

## HTML parser

Both frontends parse `campus.syktsu.ru` HTML with regex (not DOM). The parser extracts: week options (`<select name="weeks">`), schedule table (`<table class="schedule">`), day headers, pair cells. If the university changes their HTML structure, these regexes break.

## Conventions

- All UI text is in Russian
- Default group: `131-ИБо`
- No package manager lockfile — `node_modules` not tracked
- `test.html` is a legacy standalone test page (can be ignored)
- No TypeScript, no bundler, no transpiler — plain ES modules
