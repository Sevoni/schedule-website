# Campus Schedule

Веб-расписание занятий университета (парсинг campus.syktsu.ru) с домашними заданиями,
Telegram-уведомлениями и офлайн-режимом (PWA).

Стек: vanilla JS (без фреймворков и сборщиков) + Cloudflare Worker + D1.

## Структура

```
site/
├── worker/
│   ├── index.js              — Cloudflare Worker: роутинг, auth, API, Telegram
│   └── store.js              — D1-адаптер с KV-совместимым API
├── frontend/
│   ├── index.html            — SPA-оболочка
│   ├── app.js                — основная логика
│   ├── style.css             — тёмная тема
│   ├── sw.js                 — service worker (офлайн-шелл)
│   ├── manifest.webmanifest  — PWA-манифест
│   ├── _headers              — security headers для Pages (включая CSP-хэш инлайн-скрипта)
│   └── icons/                — иконки
├── migrations/
│   └── 0001_init.sql         — схема D1
├── scripts/
│   ├── set-webhook.js        — установка Telegram webhook
│   ├── make_icons.py         — генератор PNG-иконок из favicon.svg (нужен Pillow)
│   └── campus-sync/          — парсинг кампуса для GitHub Actions (см. .github/workflows)
├── generate_owner_code.py    — генератор OWNER_CODE
├── package.json              — единственная dev-зависимость: wrangler
└── wrangler.toml             — Worker + D1 + cron + routes
```


## Быстрый старт

```bash
cd site
npm install

# 1. База данных (один раз)
npx wrangler d1 create schedule-db
npx wrangler d1 execute schedule-db --remote --file=./migrations/0001_init.sql
# database_id из вывода вписать в wrangler.toml -> [[d1_databases]]

# 2. Секреты (один раз)
python generate_owner_code.py              # сгенерировать OWNER_CODE
npx wrangler secret put OWNER_CODE
npx wrangler secret put TELEGRAM_BOT_TOKEN # токен бота от @BotFather
npx wrangler secret put TG_WEBHOOK_SECRET  # случайная строка для проверки webhook

# 3. Деплой
npm run deploy
npm run set-webhook  # привязать Telegram webhook к задеплоенному Worker
```
сделай
Пример содержимого — по ключам `OWNER_CODE`, `TELEGRAM_BOT_TOKEN`, `TG_WEBHOOK_SECRET`.

Полезные команды:

```bash
npm run dev    # локальный Worker + Pages
npm run tail   # живые логи
```

## Конфигурация (`wrangler.toml`)

Перед деплоем под себя поменять: `TG_BOT_USERNAME`, `INVITE_ORIGIN` (канонический
origin для ссылок-приглашений), `ALLOWED_ORIGINS` (CORS-allowlist), `routes`
(кастомный домен для `/api/*`), `[[d1_databases]] database_id`.

## Роли доступа

- **reader** — аноним, только чтение расписания.
- **writer** — доступ по ссылке-приглашению (`#invite=<token>`), управление ДЗ и синхронизацией своей группы.
- **owner** — код из `OWNER_CODE`, создание/отзыв приглашений для любой группы.

## Важные нюансы

- При любом изменении `app.js` / `style.css` / иконок бампать **две константы синхронно**:
  `SW_VERSION` в `frontend/sw.js` и `'?v='` в `register('/sw.js?v=…')` в `app.js` —
  иначе клиенты останутся на старом кэше.
- В `index.html` ровно один инлайн-`<script>`, его sha256-хэш зашит в CSP в
  `frontend/_headers`. После изменения скрипта хэш нужно пересчитать и обновить.
- Хранилище — D1 (SQLite). Биндинг KV `SCHEDULE` оставлен как legacy и кодом не используется.
- Протухшие записи чистит cron ежедневно (`[triggers]` в `wrangler.toml`).
