# Apicheko

Telegram-бот для проверки российских компаний и ИП через Checko API.

Основной целевой runtime: **Cloudflare Worker + webhook Telegram**.
Python-бот в `bot/` сохранён как отдельный runtime, но Worker является приоритетным для деплоя.

## Архитектура Worker runtime

- `worker.js` — entrypoint Worker.
- `wrangler.toml` — конфигурация Worker.

### Что делает Worker

- `GET /` → healthcheck JSON.
- `POST /` → Telegram webhook.
- Проверяет заголовок `X-Telegram-Bot-Api-Secret-Token` против `WEBHOOK_SECRET`.
- Разбирает `message` и `callback_query`.
- Ходит в Checko API v2.
- Показывает карточку и разделы через inline-кнопки.
- Пагинация всех списков: 5 записей на страницу.

## Входные форматы

Поддерживаемые идентификаторы в сообщении:

- `10` цифр → ИНН юрлица (`/v2/company`)
- `13` цифр → ОГРН (`/v2/company`)
- `12` цифр → выбор `ИП` / `Физлицо`
- `15` цифр → ОГРНИП (`/v2/entrepreneur`)
- `9` цифр → БИК (`/v2/bank`)

Иначе бот отвечает: «Введите ИНН, ОГРН, ОГРНИП или БИК».

## Формат callback_data

Короткий формат:

```text
<cmd>:<id>:<page>:<extra>
```

Примеры:

- `fin:7707083893:1`
- `crt:7707083893:1:p`
- `gov:7707083893:1:44s`
- `ins:7707083893:1`
- `fsp:7707083893:1`
- `bnk:7707083893:1`
- `log:7707083893:1`
- `ip:123456789012:1`
- `prs:123456789012:1`
- `bak:044525225:1`
- `main:7707083893:1`
- `noop:7707083893:1`

## Секреты и переменные

### Cloudflare Secrets

- `TELEGRAM_BOT_TOKEN`
- `CHECKO_API_KEY`
- `WEBHOOK_SECRET`

### Публичные vars

- `NODE_ENV=production`
- `CHECKO_API_URL=https://api.checko.ru/v2`

## Настройка webhook

Установка webhook:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=<WORKER_URL>&secret_token=<WEBHOOK_SECRET>&drop_pending_updates=true"
```

Проверка:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

## Деплой Worker

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put CHECKO_API_KEY
npx wrangler secret put WEBHOOK_SECRET

npx wrangler deploy
```

После деплоя:

- проверьте `GET /`;
- установите webhook на URL Worker;
- проверьте `/start` и поиск по тестовому ИНН.

## Локальные проверки

Python-тесты (регрессия существующего runtime):

```bash
python -m unittest discover -s tests -p "test_*.py"
```

Проверка синтаксиса Worker:

```bash
node --check worker.js
```

## Безопасность

- Не храните секреты в исходниках.
- Проверяйте `meta.status` и `meta.message` ответа Checko.
- При HTTP != 200, non-JSON и `meta.status != ok/success` бот должен отдавать явную ошибку.
