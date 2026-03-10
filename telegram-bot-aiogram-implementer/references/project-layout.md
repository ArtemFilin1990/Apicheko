# Aiogram Project Layout

## When To Read This File

- Read this file when creating a new `aiogram 3` bot from scratch.
- Read this file when an existing Telegram bot has all handlers in one file and needs a maintainable split.
- Skip it when the repository already has a stable router and service structure and only needs a small patch.

## Baseline Layout

Use this layout for most bots that have more than one meaningful flow:

```text
bot/
  __init__.py
  main.py
  config.py
  handlers/
    __init__.py
    start.py
    menu.py
    admin.py
    forms.py
  keyboards/
    __init__.py
    reply.py
    inline.py
  callbacks/
    __init__.py
    menu.py
  states/
    __init__.py
    lead.py
  services/
    __init__.py
    users.py
    leads.py
```

Collapse files only when the bot is truly tiny.

## Bootstrap Template

Prefer a small `main.py` that wires config, bot, dispatcher, and routers:

```python
import asyncio
import logging
from os import getenv

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode

from bot.handlers import admin_router, forms_router, menu_router, start_router


async def main() -> None:
    token = getenv("BOT_TOKEN")
    if not token:
        raise RuntimeError("BOT_TOKEN is required")

    dp = Dispatcher()
    dp.include_routers(start_router, menu_router, forms_router, admin_router)

    bot = Bot(
        token=token,
        default=DefaultBotProperties(parse_mode=ParseMode.HTML),
    )

    await dp.start_polling(bot)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
```

## Router Registration

- Export routers from `handlers/__init__.py`.
- Group routers by domain, not by Telegram event type.
- Keep `admin_router` separate even if it currently has one handler.
- Register routers explicitly in `main.py`; avoid magic auto-discovery unless the repository already uses it.

Example:

```python
from .admin import router as admin_router
from .forms import router as forms_router
from .menu import router as menu_router
from .start import router as start_router
```

## Config Rule

- Resolve secrets and required settings once in `config.py` or equivalent.
- Fail fast if `BOT_TOKEN` or transport settings are missing.
- Do not read environment variables ad hoc inside every handler.

## Service Boundary

Put Telegram-specific code in handlers and keyboards. Put business actions elsewhere:

- `handlers/`: routing, validation, reply strategy
- `keyboards/`: markup construction
- `callbacks/`: typed callback contracts
- `states/`: `StatesGroup` declarations
- `services/`: persistence, API calls, business workflows

## Polling Vs Webhook

- Use `polling` for local development and small bots without external ingress.
- Use `webhook` only when the deployment already has stable HTTPS ingress and the repository expects it.
- Do not scaffold webhook complexity by default if the user only asked for a bot feature.
