import asyncio
from typing import Any, Awaitable, Callable

from aiogram import BaseMiddleware
from aiogram.types import Message, TelegramObject

from bot.config import settings
from bot.database.db import Database


class ThrottlingMiddleware(BaseMiddleware):
    """Rate-limit middleware: limits each user to THROTTLE_RATE messages/sec."""

    def __init__(self, rate: float | None = None) -> None:
        self._rate = rate if rate is not None else settings.THROTTLE_RATE
        self._locks: dict[int, asyncio.Lock] = {}
        self._last_call: dict[int, float] = {}

    async def __call__(
        self,
        handler: Callable[[TelegramObject, dict[str, Any]], Awaitable[Any]],
        event: TelegramObject,
        data: dict[str, Any],
    ) -> Any:
        if not isinstance(event, Message):
            return await handler(event, data)

        user_id = event.from_user.id if event.from_user else None
        if user_id is None:
            return await handler(event, data)

        loop = asyncio.get_running_loop()
        now = loop.time()

        last = self._last_call.get(user_id, 0.0)
        delta = now - last
        min_interval = 1.0 / self._rate

        if delta < min_interval:
            await event.answer(
                "⏳ Слишком много запросов. Пожалуйста, подождите немного."
            )
            return None

        self._last_call[user_id] = now
        return await handler(event, data)


class DatabaseMiddleware(BaseMiddleware):
    """Inject Database instance into handler data."""

    def __init__(self, db: "Database") -> None:
        self._db = db

    async def __call__(
        self,
        handler: Callable[[TelegramObject, dict[str, Any]], Awaitable[Any]],
        event: TelegramObject,
        data: dict[str, Any],
    ) -> Any:
        data["db"] = self._db
        return await handler(event, data)
