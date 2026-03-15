# Apicheko

Telegram-бот для оперативной проверки компаний, ИП, физлиц и банков через **Checko API v2.4**.

Production runtime: **Cloudflare Worker** (`worker/worker.js`).

## Что поддерживает Worker

- `GET /` — healthcheck.
- `POST /webhook` (или путь из `WEBHOOK_PATH`) — Telegram webhook.
- Главный экран `/start` в формате «1 сообщение = 1 экран».
- Поиск по ИНН/ОГРН/ОГРНИП, БИК, названию и корпоративному email (DaData).
- Разрешение 12-значного ИНН через выбор: ИП или физлицо.
- Главная карточка компании + 8 экранов разделов с мягким DaData enrichment в карточке и связях.
- Навигация по `editMessageText`, обработка callback через `answerCallbackQuery`.
- Строгое разделение сервисных ошибок и валидных пустых результатов.

## Callback contract

```text
menu
help
search:inn
search:name
search:bic
search:email

resolve12:entrepreneur:<id>
resolve12:person:<id>

select:company:<id>
select:entrepreneur:<id>

ep:risk:<id>
ep:his:<id>
ep:lnk:<id>

co:main:<id>
co:risk:<id>
co:fin:<id>
co:arb:<id>
co:debt:<id>
co:ctr:<id>
co:his:<id>
co:lnk:<id>
co:tax:<id>
```

## Endpoint mapping

- `co:main` → `/company`
- `co:risk` → `/company`
- `co:fin` → `/finances`
- `co:arb` → `/legal-cases`
- `co:debt` → `/company` + `/enforcements`
- `co:ctr` → `/contracts`
- `co:his` → `/timeline`
- `co:lnk` → `/company` (+ `/person` при необходимости)
- `co:tax` → `/company`

Дополнительно:

- `search:name` → `/search?by=name&obj=org&query=...`
- `resolve12:entrepreneur` → `/entrepreneur`
- `resolve12:person` → `/person`
- `search:bic` → `/bank`

## Error-handling contract

Worker возвращает `⚠️ Ошибка сервиса Checko` только если:

1. HTTP статус Checko != 200;
2. ответ Checko не JSON;
3. `meta.status == error`.

Если `meta.status == ok`, но данные пустые, показываются экранные empty-state сообщения:

- `📊 Финансовая отчетность не найдена`
- `🛡️ Исполнительные производства не найдены`
- `📑 Контракты не найдены`
- `🕓 История изменений не найдена`

## Secrets / vars

Cloudflare Secrets:

- `TELEGRAM_BOT_TOKEN`
- `CHECKO_API_KEY`
- `WEBHOOK_SECRET`

Vars (`wrangler.toml`):

- `CHECKO_API_URL=https://api.checko.ru/v2`
- `WEBHOOK_PATH=/webhook`
- `DADATA_API_URL=https://suggestions.dadata.ru/suggestions/api/4_1/rs`

DaData Secrets (optional, for email search / enrichment / affiliations):

- `DADATA_API_KEY`
- `DADATA_SECRET_KEY`

## DaData integration

- Поиск по email использует `POST /findByEmail/company`.
- Обогащение карточки `co:main` использует `POST /findById/party`.
- Экран связей `co:lnk` дополнительно использует `POST /findAffiliated/party` по ИНН учредителей/руководителей.
- При отсутствии DaData ключей или временной ошибке DaData бот продолжает работать через Checko без падения.

## Локальная проверка

```bash
node --check worker/worker.js
node --test tests/worker_smoke.test.mjs
python -m unittest discover -s tests -p "test_*.py"
```
