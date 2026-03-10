# Apicheko Bot

Telegram-бот для поиска информации о российских компаниях и предпринимателях с помощью [Checko API](https://checko.ru/).

## Возможности

- 🔍 Поиск по идентификатору: ИНН (10/12), ОГРН (13), ОГРНИП (15)
- 🔀 Для ИНН 12: явный выбор режима «ИП» или «физлицо»
- 🔎 Поиск по названию компании или ИП
- 💼 Просмотр основных данных (ОГРН, адрес, руководитель, статус)
- 📊 Финансовая отчётность
- ⚖️ Арбитражные дела
- 🏛️ Исполнительные производства
- 📑 Государственные контракты
- 🔍 Проверки
- 📰 Записи ЕФРСБ (банкротство)
- 📜 История изменений
- 📋 История запросов пользователя

## Структура проекта

```
bot/
  main.py          # Точка входа
  config.py        # Настройки из .env
  checko_api.py    # Клиент Checko API
  keyboards.py     # Inline-клавиатуры
  formatters.py    # Форматирование данных
  middlewares.py   # Антиспам и инъекция БД
  handlers/
    start.py       # /start
    search.py      # Обработка ввода ИНН / названия
    callbacks.py   # Обработка нажатий кнопок
  database/
    db.py          # SQLite (пользователи, история)
requirements.txt
.env
```

## Установка

```bash
pip install -r requirements.txt
```

## Конфигурация

Скопируйте шаблон и заполните значения:

```bash
cp .env.example .env
```

```env
BOT_TOKEN=your_bot_token_here
CHECKO_API_KEY=your_checko_api_key_here
CHECKO_API_URL=https://api.checko.ru/v2
DATABASE_PATH=bot.db
DATABASE_SOURCE_URL=https://f10dfe6833ed9c07519e4f0b5be647e5.r2.cloudflarestorage.com/yourist
```

- `BOT_TOKEN` — токен бота от [@BotFather](https://t.me/BotFather)
- `CHECKO_API_KEY` — ключ API от [checko.ru](https://checko.ru/)
- `CHECKO_API_URL` — базовый URL Checko API (опционально)
- `DATABASE_PATH` — путь к SQLite-файлу (по умолчанию `bot.db`)
- `DATABASE_SOURCE_URL` — HTTP(S) URL для начальной SQLite-базы (например, Cloudflare R2). Если `DATABASE_PATH` уже существует, скачивание не выполняется.

## Запуск

### 1) Локально / polling (по умолчанию)

```bash
python -m bot.main
```

## Деплой Cloudflare Worker (из корня репозитория)

Worker-рантайм вынесен в корневой `worker.js`, а `wrangler.toml` указывает на него через `main = "worker.js"`.

### Обязательные secrets

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put CHECKO_API_KEY
```

### Опциональные variables

- `CHECKO_API_URL` (по умолчанию `https://api.checko.ru/v2`)
- `WEBHOOK_PATH` (по умолчанию `/webhook`)

### Поведение Worker

- `GET /` — healthcheck JSON.
- `POST ${WEBHOOK_PATH}` — обработка Telegram webhook update.
- Поддержаны команды `/start`, `/help`, а также поиск по ИНН: `10` цифр (компания) и `12` цифр (ИП).

### Деплой

```bash
npx wrangler deploy
```

Если бот запускается в среде с ограниченным исходящим доступом в интернет, можно задать `POLLING_MAX_RETRIES=1`, чтобы процесс завершался после первой неудачной попытки подключения к Telegram API.

### 2) Webhook-режим (для деплоя за Cloudflare)

Если задан `WEBHOOK_BASE_URL`, бот автоматически переключается с polling на webhook.

```env
WEBHOOK_BASE_URL=https://bot.example.com
WEBHOOK_PATH=/webhook
WEBHOOK_SECRET_TOKEN=change_me
WEBHOOK_HOST=0.0.0.0
WEBHOOK_PORT=8080
```

```bash
python -m bot.main
```

## Технологии

- [aiogram 3.x](https://docs.aiogram.dev/) — Telegram Bot framework
- [aiohttp](https://docs.aiohttp.org/) — HTTP-клиент для Checko API
- [aiosqlite](https://aiosqlite.omnilib.dev/) — асинхронная работа с SQLite
- [pydantic-settings](https://docs.pydantic.dev/latest/concepts/pydantic_settings/) — конфигурация через переменные окружения

## TDLib vs Bot API

[TDLib (Telegram Database Library)](https://github.com/tdlib/td) — официальная C++-библиотека Telegram для построения полноценных Telegram-клиентов. Она используется на уровне MTProto напрямую и поддерживает как аккаунты пользователей, так и ботов.

| Характеристика | TDLib (pytdbot / aiotdlib) | aiogram (Bot API) |
|---|---|---|
| Тип аккаунта | Бот **и** пользователь | Только бот |
| Протокол | MTProto (нативный) | HTTPS / REST |
| Доступные функции | Весь Telegram API | Только Bot API |
| Зависимости | C++ TDLib + `tdjson` бинарник | Чистый Python |
| Сложность настройки | Высокая | Низкая |
| Подходит для | Кастомные клиенты, юзерботы | Стандартные боты |

**Почему в этом проекте используется aiogram, а не TDLib:**

Данный бот выполняет простые функции: пользователь вводит ИНН или название компании, бот запрашивает Checko API и отображает результат через inline-клавиатуры. Для этого сценария Telegram Bot API полностью достаточен. TDLib добавил бы необходимость в компиляции нативной C++-библиотеки (`tdjson`), управлении MTProto-сессией и усложнил бы деплой без каких-либо выгод для данного use-case.

TDLib стоит рассматривать при необходимости:
- работать под пользовательским аккаунтом (юзербот),
- использовать функции, не доступные в Bot API (например, вступление в группы, чтение каналов без прав администратора),
- строить кастомный Telegram-клиент.

Для Python-проектов на TDLib рекомендуются: [pytdbot](https://github.com/pytdbot/client), [aiotdlib](https://github.com/pylakey/aiotdlib).

Справочно: каталог [Telegram Methods](https://core.telegram.org/methods) описывает MTProto-методы клиентского API (например, `messages.*`, `channels.*`) и не используется напрямую в данном боте на Bot API/aiogram.
