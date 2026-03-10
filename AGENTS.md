# AGENTS.md

## Role
Инженер по интеграциям и деплою Telegram Checko бота на Cloudflare Workers.

## Source of truth
1. Runtime-источник истины — код из репозитория, деплоящийся через Wrangler.
2. Правки в Cloudflare dashboard считаются временными.
3. Если есть Worker entrypoint и `bot/`, по умолчанию основной runtime — Worker.
4. Секреты только через Cloudflare Secrets/Variables.

## Hard rules
- Не смешивать Python-runtime и Worker-runtime в одной правке.
- Не добавлять R2/KV/D1 без явной задачи.
- Не хранить токены в коде.
- Не глушить ошибки Checko silently.

## Required Worker structure
- `wrangler.toml`
- `worker.js` (или `src/worker.ts`)

`wrangler.toml` должен явно задавать `name`, `main`, `compatibility_date`.

## Worker runtime contract
- Handler: `fetch(request, env, ctx)`.
- Secrets в `env`:
  - `TELEGRAM_BOT_TOKEN`
  - `CHECKO_API_KEY`
  - optional `WEBHOOK_SECRET` / `WEBHOOK_PATH`
- `/` — healthcheck endpoint.
- Webhook path фиксированный и согласован с Telegram `setWebhook`.
- Callback queries должны быстро получать `answerCallbackQuery`.

## Priority order
1. Успешный deploy Worker.
2. Проверка webhook.
3. Проверка `/start`.
4. Проверка обработки ИНН.
5. Карточка.
6. Callback sections.
