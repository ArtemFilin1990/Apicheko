import asyncio
import logging
import socket
import sys

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramNetworkError
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.utils.token import TokenValidationError

from bot.checko_api import CheckoAPI
from bot.config import load_settings
from bot.database.db import Database
from bot.handlers import callbacks, search, start
from bot.middlewares import DatabaseMiddleware, ThrottlingMiddleware

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)


async def run_polling(dp: Dispatcher, bot: Bot, max_retries: int | None = None) -> None:
    backoff_seconds = 3
    network_failures = 0

    while True:
        try:
            logger.info("Starting bot...")
            await dp.start_polling(bot)
        except asyncio.CancelledError:
            logger.info("Polling cancelled")
            raise
        except TelegramNetworkError as exc:
            network_failures += 1
            logger.error("Cannot reach Telegram API: %s", exc)
            if max_retries is not None and network_failures >= max_retries:
                raise RuntimeError(
                    f"Telegram API is unreachable after {network_failures} attempts."
                ) from exc
            logger.info("Restarting polling in %s sec...", backoff_seconds)
            await asyncio.sleep(backoff_seconds)
            backoff_seconds = min(backoff_seconds * 2, 60)
        except Exception as exc:  # pragma: no cover - defensive guard
            logger.exception("Polling crashed: %s", exc)
            logger.info("Restarting polling in %s sec...", backoff_seconds)
            await asyncio.sleep(backoff_seconds)
            backoff_seconds = min(backoff_seconds * 2, 60)
        else:
            logger.info("Polling stopped normally")
            break


async def main() -> None:
    try:
        settings = load_settings()
    except RuntimeError as exc:
        logger.error(str(exc))
        raise SystemExit(1) from exc

    checko_api = CheckoAPI(
        base_url=settings.CHECKO_API_URL,
        key=settings.CHECKO_API_KEY,
    )

    db = Database()
    await db.connect()
    bot: Bot | None = None

    try:
        session = AiohttpSession()
        session._connector_init["family"] = socket.AF_INET
        bot = Bot(
            token=settings.BOT_TOKEN,
            session=session,
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

        await run_polling(dp, bot, settings.POLLING_MAX_RETRIES)
    except TokenValidationError:
        logger.error("BOT_TOKEN is invalid. Update BOT_TOKEN in environment variables.")
        raise SystemExit(1)
    except RuntimeError as exc:
        logger.error(str(exc))
        raise SystemExit(1) from exc
    finally:
        await db.close()
        await checko_api.close()
        if bot is not None:
            await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
