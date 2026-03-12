# Apicheko

Telegram-бот для проверки российских компаний и ИП через Checko API.

Основной целевой runtime: **Cloudflare Worker + webhook Telegram**.
Python-бот в `bot/` сохранён как отдельный runtime, но Worker является приоритетным для деплоя.

## Структура репозитория

- `worker/` — production runtime Cloudflare Worker.
- `bot/` — secondary Python runtime (fallback).
- `skills/` — skill/agent packs (Cloudflare, Telegram, Terraform, reference helpers).
- `docs/` — документация и справочные материалы (в т.ч. Checko reference).
- `review_needed/` — спорные/неразобранные файлы для ручной ревизии.
- `archive/` — место для устаревших материалов (если потребуется безопасно убрать из active tree).


## Архитектура Worker runtime

- `worker/worker.js` — entrypoint Worker.
- `wrangler.toml` — конфигурация Worker.

### Что делает Worker

- `GET /` → healthcheck JSON.
- `POST /webhook` → Telegram webhook по умолчанию.
- Проверяет заголовок `X-Telegram-Bot-Api-Secret-Token` против `WEBHOOK_SECRET`.
- Разбирает `message` и `callback_query`.
- Ходит в Checko API v2.
- Показывает карточку и 3 detail-раздела через inline-кнопки.
- В первом стабильном релизе UI ограничен разделами `Арбитраж`, `Финансы`, `ЕФРСБ / Банкротство`.

## Входные форматы

Первый стабильный релиз поддерживает только один формат:

- `10` цифр → ИНН юрлица (`/v2/company`)

Остальные идентификаторы и дополнительные секции вынесены в следующий этап. Сейчас бот отвечает явным сообщением, что поддержан только ИНН юрлица из 10 цифр.

## Формат callback_data

Короткий формат:

```text
<cmd>:<id>:<page>:<extra>
```

Примеры:

- `arbitration:7707083893`
- `financial:7707083893`
- `bankruptcy:7707083893`
- `main:7707083893`

## Секреты и переменные

### Cloudflare Secrets

- `TELEGRAM_BOT_TOKEN`
- `CHECKO_API_KEY`
- `WEBHOOK_SECRET`

### Публичные vars

- `NODE_ENV=production`
- `CHECKO_API_URL=https://api.checko.ru/v2`
- `WEBHOOK_PATH=/webhook`

## Настройка webhook

Установка webhook:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=<WORKER_URL>/webhook&secret_token=<WEBHOOK_SECRET>&drop_pending_updates=true"
```

Проверка:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

Ожидаемый `url` в ответе `getWebhookInfo`:

```text
https://<worker-domain>/webhook
```

## Деплой Worker

Wrangler в non-interactive окружении требует Cloudflare API token:

```bash
export CLOUDFLARE_API_TOKEN=<cloudflare_api_token>
```

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put CHECKO_API_KEY
npx wrangler secret put WEBHOOK_SECRET

npx wrangler deploy
```

После деплоя:

- проверьте `GET /` как healthcheck;
- установите webhook на `POST /webhook` или на путь из `WEBHOOK_PATH`;
- проверьте `/start`;
- отправьте тестовый 10-значный ИНН юрлица;
- откройте 3 detail-кнопки: `Арбитраж`, `Финансы`, `ЕФРСБ / Банкротство`.

## Основной сценарий v1

1. Telegram отправляет `POST` update в Worker на `/webhook`.
2. Worker принимает `update.message.text`.
3. Если сообщение содержит `10` цифр, бот запрашивает `Checko /v2/company`.
4. В основной карточке бот гарантированно показывает:
   - название компании;
   - ИНН;
   - ОГРН;
   - статус;
   - дату регистрации;
   - директора;
   - регион.
5. Если компания не найдена, бот отвечает: `❌ Компания не найдена`.
6. Если Checko вернул HTTP != 200, non-JSON или `meta.status != ok/success`, бот отвечает: `⚠️ Ошибка сервиса Checko`.

## Локальные проверки

Python-тесты (регрессия существующего runtime):

```bash
python -m unittest discover -s tests -p "test_*.py"
```

Проверка синтаксиса Worker:

```bash
node --check worker/worker.js
```

Smoke-тест Worker без внешних зависимостей:

```bash
node --test tests/worker_smoke.test.mjs
```

## Безопасность

- Не храните секреты в исходниках.
- Проверяйте `meta.status` и `meta.message` ответа Checko.
- При HTTP != 200, non-JSON и `meta.status != ok/success` бот должен отдавать безопасное сообщение `⚠️ Ошибка сервиса Checko`.
