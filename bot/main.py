import asyncio
import logging
import socket
import sys

from aiohttp import web
from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.enums import ParseMode
from aiogram.exceptions import TelegramNetworkError
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.utils.token import TokenValidationError
from aiogram.webhook.aiohttp_server import SimpleRequestHandler, setup_application

from bot.checko_api import CheckoAPI
from bot.config import Settings, load_settings
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
            logger.info("Starting bot in polling mode...")
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


async def run_webhook(dp: Dispatcher, bot: Bot, settings: Settings) -> None:
    if not settings.WEBHOOK_BASE_URL:
        raise RuntimeError(
            "WEBHOOK_BASE_URL is required for webhook mode. "
            "Provide a public HTTPS URL, e.g. through Cloudflare Tunnel."
        )

    webhook_url = settings.WEBHOOK_BASE_URL.rstrip("/") + settings.WEBHOOK_PATH
    await bot.set_webhook(
        url=webhook_url,
        secret_token=settings.WEBHOOK_SECRET_TOKEN,
        drop_pending_updates=False,
    )

    app = web.Application()
    SimpleRequestHandler(
        dispatcher=dp,
        bot=bot,
        secret_token=settings.WEBHOOK_SECRET_TOKEN,
    ).register(app, path=settings.WEBHOOK_PATH)
    setup_application(app, dp, bot=bot)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, host=settings.WEBHOOK_HOST, port=settings.WEBHOOK_PORT)

    logger.info(
        "Starting bot in webhook mode on %s:%s, webhook URL: %s",
        settings.WEBHOOK_HOST,
        settings.WEBHOOK_PORT,
        webhook_url,
    )

    await site.start()

    try:
        stop_event = asyncio.Event()
        await stop_event.wait()
    except asyncio.CancelledError:
        logger.info("Webhook server cancelled")
        raise
    finally:
        await runner.cleanup()


def build_dispatcher(db: Database, checko_api: CheckoAPI) -> Dispatcher:
    dp = Dispatcher(storage=MemoryStorage())

    dp.message.middleware(ThrottlingMiddleware())
    dp.message.middleware(DatabaseMiddleware(db))
    dp.callback_query.middleware(DatabaseMiddleware(db))

    dp["checko_api"] = checko_api

    dp.include_router(start.router)
    dp.include_router(search.router)
    dp.include_router(callbacks.router)

    return dp


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
        dp = build_dispatcher(db, checko_api)

        if settings.WEBHOOK_BASE_URL:
            await run_webhook(dp, bot, settings)
        else:
            await run_polling(dp, bot, settings.POLLING_MAX_RETRIES)
    except TokenValidationError:
        logger.error("BOT_TOKEN is invalid. Update BOT_TOKEN in environment variables.")
        raise SystemExit(1)
    except TelegramNetworkError as exc:
        logger.error("Cannot reach Telegram API: %s", exc)
        raise SystemExit(1) from exc
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
