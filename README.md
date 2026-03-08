# Apicheko Bot

Telegram-бот для поиска информации о российских компаниях и предпринимателях с помощью [Checko API](https://checko.ru/).

## Возможности

- 🔍 Поиск по ИНН (10 цифр — ЮЛ, 12 цифр — ИП / физлицо)
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
```

- `BOT_TOKEN` — токен бота от [@BotFather](https://t.me/BotFather)
- `CHECKO_API_KEY` — ключ API от [checko.ru](https://checko.ru/)
- `CHECKO_API_URL` — базовый URL Checko API (опционально)
- `DATABASE_PATH` — путь к SQLite-файлу (по умолчанию `bot.db`)

## Запуск

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
