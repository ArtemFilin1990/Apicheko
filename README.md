# Apicheko

Telegram-бот для проверки российских компаний и ИП через Checko API.

Основной runtime в этом репозитории: Python-бот на `aiogram`.
Дополнительно сохранён Cloudflare Worker runtime для webhook-сценария.

## Структура проекта

```text
bot/
  handlers/
    callbacks.py
    search.py
    start.py
  cards.py
  formatters.py
  keyboards.py
  main.py
  middlewares.py

config/
  settings.py

services/
  checko_api.py

storage/
  database.py

utils/
  checko_payload.py

docs/
  reference/
    checko/

review_needed/
  unclassified/

tests/
  test_checko_api.py
  test_config.py
  test_handlers.py

worker.js
wrangler.toml
requirements.txt
.env.example
```

## Что относится к runtime

- `bot/` — Telegram-логика и форматирование ответов.
- `services/` — клиент Checko API.
- `config/` — загрузка и валидация конфигурации.
- `storage/` — SQLite и история запросов.
- `utils/` — вспомогательная нормализация payload.
- `worker.js`, `wrangler.toml` — альтернативный Cloudflare Worker runtime.

## Что не относится к runtime

- `docs/reference/checko/` — локальные справочные материалы и выгрузки Checko.
- `review_needed/unclassified/` — артефакты, которые не удалось уверенно классифицировать как runtime или документацию.

## Требования

- Python 3.11+
- Telegram Bot Token
- Checko API Key

## Быстрый старт

### 1. Создать виртуальное окружение

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

### 2. Подготовить `.env`

```powershell
Copy-Item .env.example .env
```

Минимальная конфигурация:

```env
BOT_TOKEN=...
CHECKO_API_KEY=...
CHECKO_API_URL=https://api.checko.ru/v2
DATABASE_PATH=bot.db
```

## Локальный запуск бота

```powershell
.\.venv\Scripts\python.exe -m bot.main
```

## Запуск тестов

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py"
```

## Cloudflare Worker

Worker остаётся в репозитории как отдельный runtime:

- entrypoint: `worker.js`
- config: `wrangler.toml`

Минимальные секреты:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put CHECKO_API_KEY
```

Deploy:

```bash
npx wrangler deploy
```

## Безопасность

- `.env` не должен попадать в git.
- Секреты для Worker должны храниться только в `wrangler secret`.
- Если Checko вернул HTTP != 200, не-JSON или `meta.status=error`, бот должен явно показать ошибку, а не молча скрыть её.
