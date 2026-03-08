from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache

from dotenv import load_dotenv


@dataclass(frozen=True)
class Settings:
    BOT_TOKEN: str
    CHECKO_API_KEY: str
    CHECKO_API_URL: str = "https://api.checko.ru/v2"
    DATABASE_PATH: str = "bot.db"
    THROTTLE_RATE: float = 0.5


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    load_dotenv()

    bot_token = (
        (os.getenv("BOT_TOKEN") or "").strip()
        or (os.getenv("TELEGRAM_TOKEN") or "").strip()
    )
    checko_api_key = (os.getenv("CHECKO_API_KEY") or "").strip()
    checko_api_url = (os.getenv("CHECKO_API_URL") or "https://api.checko.ru/v2").strip()
    database_path = (os.getenv("DATABASE_PATH") or "bot.db").strip()
    throttle_rate_raw = (os.getenv("THROTTLE_RATE") or "0.5").strip()

    if not bot_token or not checko_api_key:
        raise RuntimeError(
            "Environment is not configured. Set BOT_TOKEN (or TELEGRAM_TOKEN) and CHECKO_API_KEY in .env or environment variables."
        )

    try:
        throttle_rate = float(throttle_rate_raw)
    except ValueError as exc:
        raise RuntimeError("THROTTLE_RATE must be a valid float value.") from exc

    if throttle_rate <= 0:
        raise RuntimeError("THROTTLE_RATE must be greater than 0.")

    return Settings(
        BOT_TOKEN=bot_token,
        CHECKO_API_KEY=checko_api_key,
        CHECKO_API_URL=checko_api_url,
        DATABASE_PATH=database_path,
        THROTTLE_RATE=throttle_rate,
    )


def load_settings() -> Settings:
    settings = get_settings()

    token_placeholders = {
        "your_bot_token_here",
        "your_bot_token",
        "changeme",
    }
    checko_placeholders = {
        "your_checko_api_key_here",
        "your_checko_api_key",
        "your_checko_key_here",
        "changeme",
    }

    invalid_fields: list[str] = []
    if settings.BOT_TOKEN.lower() in token_placeholders:
        invalid_fields.append("BOT_TOKEN (or TELEGRAM_TOKEN)")
    if settings.CHECKO_API_KEY.lower() in checko_placeholders:
        invalid_fields.append("CHECKO_API_KEY")

    if invalid_fields:
        raise RuntimeError(
            "Environment contains placeholder credentials for: "
            + ", ".join(invalid_fields)
            + ". Replace placeholder values in .env before starting the bot."
        )

    return settings
