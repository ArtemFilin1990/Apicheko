# Apicheko

Telegram-бот для проверки компаний в модели **DaData-only**.

Production runtime: **Cloudflare Worker** (`worker/worker.js`).

## Agent/skill scaffold

Минимальный комплект для локальных ассистентов и аудита изменений:

- `AGENTS.md`
- `.opencode/agents/review.md`
- `.opencode/agents/deploy-check.md`
- `.claude/skills/apicheko-section-fix/SKILL.md`
- `.claude/skills/apicheko-deploy-audit/SKILL.md`

## Что поддерживает Worker

- `GET /` — healthcheck.
- `POST /webhook` (или путь из `WEBHOOK_PATH`) — Telegram webhook.
- Главный экран `/start` в формате «1 сообщение = 1 экран» и только с inline-навигацией.
- Поиск компании по ИНН, ОГРН, ИНН/КПП и корпоративному email.
- В клавиатуре карточки доступны `co:main`, `co:lnk`, `co:own`, `co:okv` и динамический `co:fin`, а история изменений вынесена во внешнюю ссылку ФНС `https://egrul.nalog.ru/`.
- Экран связей `co:lnk` строится по `findById/party` → INN руководителей/учредителей → максимум 5 вызовов `findAffiliated/party` → dedupe по ИНН → pager по 5 элементов.
- Навигация по `editMessageText`, обработка callback через `answerCallbackQuery`.
- История последних карточек через optional `COMPANY_CACHE`.

## Callback contract

```text
menu
help
search:inn
search:email
select:company:<id>
co:main:<id>
co:lnk:<id>
co:own:<id>
co:fin:<id>
co:okv:<id>
co:<section>:<id>:p:<page>   # pager для co:lnk
```

## Endpoint mapping

- `co:main` → DaData `findById/party`
- `co:lnk` → DaData `findById/party` + `findAffiliated/party`
- `co:own` → DaData `findById/party` (`founders`)
- `co:fin` → DaData `findById/party` (`finance`)
- `co:okv` → DaData `findById/party` (`okved`, `okveds`)
- company by email → DaData `findByEmail/company`

## Error-handling contract

Worker возвращает сервисную ошибку DaData, если:

1. HTTP статус DaData не `200`;
2. ответ DaData не JSON;
3. DaData недоступна или ответ имеет неожиданный формат.

Если данные пустые, показывается empty-state на уровне конкретного экрана.

## Secrets / vars

Cloudflare Secrets:

- `TELEGRAM_BOT_TOKEN`
- `WEBHOOK_SECRET`
- `DADATA_API_KEY`
- `DADATA_SECRET_KEY`

Vars (`wrangler.toml`):

- `WEBHOOK_PATH=/webhook`
- `DADATA_API_URL=https://suggestions.dadata.ru/suggestions/api/4_1/rs`
- `CACHE_BYPASS=0`

KV binding (optional):

- `COMPANY_CACHE` (Cloudflare KV namespace)

## KV cache

Кешируются внешние ответы (не Telegram payload):

- DaData `findById/party` по `dadata:party:{inn_or_ogrn}` — TTL 12 часов
- DaData `findAffiliated/party` по `affiliated:{inn}` — TTL 24 часа
- DaData `findByEmail/company` по `email:{normalized_email}` — TTL 6 часов

KV работает в optional-режиме: без namespace deploy проходит, а кеш и `/history` деградируют безопасно.

## DaData integration

- Поиск по email использует `POST /findByEmail/company`.
- Главная карточка `co:main` использует `POST /findById/party`.
- Экраны `co:own`, `co:fin`, `co:okv` используют только блоки из `findById/party`.
- Экран `co:lnk` использует только affiliations flow и не показывает выручку, телефоны, email или сайты для связей.
- `/start` и карточка компании не используют ReplyKeyboardMarkup: навигация собрана на inline-кнопках.

## DaData MCP server

В репозиторий добавлен минимальный MCP-сервер для DaData enrichment:

- entrypoint: `dadata_server.py`
- package metadata: `pyproject.toml`
- запуск: `dadata-enrichment` или `python dadata_server.py`
- transport: `stdio`
- tools: `enrich_company`, `enrich_company_for_bitrix`

Поведение сервера:

- использует только существующие секреты `DADATA_API_KEY` и `DADATA_SECRET_KEY`;
- читает `DADATA_API_URL` из окружения, иначе использует DaData `findById/party`;
- валидирует только 10-значный ИНН и 13-значный ОГРН для company enrichment;
- возвращает статусы `synced`, `not_found`, `error`;
- добавляет `raw_hash` для дедупликации апдейтов в Bitrix24.

Пример локального запуска после установки зависимостей из `pyproject.toml`:

```bash
python -m pip install -e .
dadata-enrichment
```

## Локальная проверка

```bash
node --check worker/worker.js
node --test tests/worker_smoke.test.mjs
python -m unittest discover -s tests -p "test_*.py"
```
