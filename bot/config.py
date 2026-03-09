from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from typing import Iterable, List
from urllib.parse import urlparse

from dotenv import load_dotenv

TOKEN_PLACEHOLDERS = {
    "your_bot_token_here",
    "your_bot_token",
    "changeme",
}
CHECKO_PLACEHOLDERS = {
    "your_checko_api_key_here",
    "your_checko_api_key",
    "your_checko_key_here",
    "changeme",
}


@dataclass(frozen=True)
class Settings:
    BOT_TOKEN: str
    CHECKO_API_KEY: str
    CHECKO_API_URL: str = "https://api.checko.ru/v2"
    DATABASE_PATH: str = "bot.db"
    DATABASE_SOURCE_URL: str | None = None
    THROTTLE_RATE: float = 0.5
    POLLING_MAX_RETRIES: int | None = None
    WEBHOOK_BASE_URL: str | None = None
    WEBHOOK_PATH: str = "/webhook"
    WEBHOOK_SECRET_TOKEN: str | None = None
    WEBHOOK_HOST: str = "0.0.0.0"
    WEBHOOK_PORT: int = 8080


def _is_placeholder(value: str, placeholders: Iterable[str]) -> bool:
    return value.lower() in placeholders


def _validate_http_url(value: str, field_name: str) -> None:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise RuntimeError(f"{field_name} must be a valid HTTP/HTTPS URL.")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    load_dotenv()

    bot_token_raw = (os.getenv("BOT_TOKEN") or "").strip()
    telegram_token_raw = (os.getenv("TELEGRAM_TOKEN") or "").strip()

    bot_token = bot_token_raw
    if (
        (not bot_token or _is_placeholder(bot_token, TOKEN_PLACEHOLDERS))
        and telegram_token_raw
    ):
        bot_token = telegram_token_raw

    checko_api_key = (os.getenv("CHECKO_API_KEY") or "").strip()
    checko_api_url = (os.getenv("CHECKO_API_URL") or "https://api.checko.ru/v2").strip()
    database_path = (os.getenv("DATABASE_PATH") or "bot.db").strip()
    database_source_url_raw = (os.getenv("DATABASE_SOURCE_URL") or "").strip()
    throttle_rate_raw = (os.getenv("THROTTLE_RATE") or "0.5").strip()
    polling_max_retries_raw = (os.getenv("POLLING_MAX_RETRIES") or "").strip()
    webhook_base_url_raw = (os.getenv("WEBHOOK_BASE_URL") or "").strip()
    webhook_path_raw = (os.getenv("WEBHOOK_PATH") or "/webhook").strip()
    webhook_secret_token_raw = (os.getenv("WEBHOOK_SECRET_TOKEN") or "").strip()
    webhook_host = (os.getenv("WEBHOOK_HOST") or "0.0.0.0").strip()
    webhook_port_raw = (os.getenv("WEBHOOK_PORT") or "8080").strip()

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

    polling_max_retries: int | None = None
    if polling_max_retries_raw:
        try:
            polling_max_retries = int(polling_max_retries_raw)
        except ValueError as exc:
            raise RuntimeError("POLLING_MAX_RETRIES must be a valid integer.") from exc

        if polling_max_retries <= 0:
            raise RuntimeError("POLLING_MAX_RETRIES must be greater than 0.")

    database_source_url: str | None = database_source_url_raw or None
    if database_source_url is not None:
        _validate_http_url(database_source_url, "DATABASE_SOURCE_URL")

    webhook_base_url: str | None = webhook_base_url_raw or None
    if webhook_base_url is not None:
        _validate_http_url(webhook_base_url, "WEBHOOK_BASE_URL")

    webhook_path = webhook_path_raw or "/webhook"
    webhook_secret_token: str | None = webhook_secret_token_raw or None

    if not webhook_path.startswith("/"):
        raise RuntimeError("WEBHOOK_PATH must start with '/'.")

    try:
        webhook_port = int(webhook_port_raw)
    except ValueError as exc:
        raise RuntimeError("WEBHOOK_PORT must be a valid integer.") from exc

    if webhook_port <= 0:
        raise RuntimeError("WEBHOOK_PORT must be greater than 0.")

    return Settings(
        BOT_TOKEN=bot_token,
        CHECKO_API_KEY=checko_api_key,
        CHECKO_API_URL=checko_api_url,
        DATABASE_PATH=database_path,
        DATABASE_SOURCE_URL=database_source_url,
        THROTTLE_RATE=throttle_rate,
        POLLING_MAX_RETRIES=polling_max_retries,
        WEBHOOK_BASE_URL=webhook_base_url,
        WEBHOOK_PATH=webhook_path,
        WEBHOOK_SECRET_TOKEN=webhook_secret_token,
        WEBHOOK_HOST=webhook_host,
        WEBHOOK_PORT=webhook_port,
    )


def load_settings() -> Settings:
    settings = get_settings()

    invalid_fields: List[str] = []
    if _is_placeholder(settings.BOT_TOKEN, TOKEN_PLACEHOLDERS):
        invalid_fields.append("BOT_TOKEN (or TELEGRAM_TOKEN)")
    if _is_placeholder(settings.CHECKO_API_KEY, CHECKO_PLACEHOLDERS):
        invalid_fields.append("CHECKO_API_KEY")

    if invalid_fields:
        raise RuntimeError(
            "Environment contains placeholder credentials for: "
            + ", ".join(invalid_fields)
            + ". Replace placeholder values in .env before starting the bot."
        )

    return settings
