import asyncio
import logging

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.fsm.storage.memory import MemoryStorage

from bot.checko_api import checko_api
from bot.config import settings
from bot.database.db import Database
from bot.handlers import callbacks, search, start
from bot.middlewares import DatabaseMiddleware, ThrottlingMiddleware

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


async def main() -> None:
    db = Database()
    await db.connect()

    bot = Bot(
        token=settings.BOT_TOKEN,
        default=DefaultBotProperties(parse_mode=ParseMode.HTML),
    )
    dp = Dispatcher(storage=MemoryStorage())

    # Middlewares
    dp.message.middleware(ThrottlingMiddleware())
    dp.message.middleware(DatabaseMiddleware(db))
    dp.callback_query.middleware(DatabaseMiddleware(db))

    # Inject checko_api into handler data
    dp["checko_api"] = checko_api

    # Routers
    dp.include_router(start.router)
    dp.include_router(search.router)
    dp.include_router(callbacks.router)

    logger.info("Starting bot…")
    try:
        await dp.start_polling(bot)
    finally:
        await db.close()
        await checko_api.close()
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
