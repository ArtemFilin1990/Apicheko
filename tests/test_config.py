import os
import unittest
from contextlib import contextmanager
from typing import Dict

from config.settings import get_settings, load_settings


@contextmanager
def temp_env(overrides: Dict[str, str]):
    original = os.environ.copy()
    try:
        os.environ.clear()
        os.environ.update(overrides)
        get_settings.cache_clear()
        yield
    finally:
        os.environ.clear()
        os.environ.update(original)
        get_settings.cache_clear()


class ConfigSettingsTests(unittest.TestCase):
    def test_fallback_to_telegram_token_when_bot_token_is_placeholder(self) -> None:
        with temp_env(
            {
                "BOT_TOKEN": "your_bot_token_here",
                "TELEGRAM_TOKEN": "12345:abc",
                "CHECKO_API_KEY": "real_key",
            }
        ):
            settings = load_settings()

        self.assertEqual(settings.BOT_TOKEN, "12345:abc")

    def test_reports_both_placeholder_credentials(self) -> None:
        with temp_env(
            {
                "BOT_TOKEN": "your_bot_token_here",
                "TELEGRAM_TOKEN": "your_bot_token",
                "CHECKO_API_KEY": "your_checko_api_key_here",
            }
        ):
            with self.assertRaises(RuntimeError) as exc:
                load_settings()

        self.assertIn("BOT_TOKEN (or TELEGRAM_TOKEN)", str(exc.exception))
        self.assertIn("CHECKO_API_KEY", str(exc.exception))

    def test_reads_polling_max_retries_when_set(self) -> None:
        with temp_env(
            {
                "BOT_TOKEN": "12345:abc",
                "CHECKO_API_KEY": "real_key",
                "POLLING_MAX_RETRIES": "2",
            }
        ):
            settings = load_settings()

        self.assertEqual(settings.POLLING_MAX_RETRIES, 2)

    def test_rejects_non_positive_polling_max_retries(self) -> None:
        with temp_env(
            {
                "BOT_TOKEN": "12345:abc",
                "CHECKO_API_KEY": "real_key",
                "POLLING_MAX_RETRIES": "0",
            }
        ):
            with self.assertRaises(RuntimeError) as exc:
                load_settings()

        self.assertIn("POLLING_MAX_RETRIES must be greater than 0", str(exc.exception))

    def test_rejects_webhook_path_without_leading_slash(self) -> None:
        with temp_env(
            {
                "BOT_TOKEN": "12345:abc",
                "CHECKO_API_KEY": "real_key",
                "WEBHOOK_BASE_URL": "https://example.com",
                "WEBHOOK_PATH": "webhook",
            }
        ):
            with self.assertRaises(RuntimeError) as exc:
                load_settings()

        self.assertIn("WEBHOOK_PATH must start with '/'", str(exc.exception))

    def test_reads_webhook_settings(self) -> None:
        with temp_env(
            {
                "BOT_TOKEN": "12345:abc",
                "CHECKO_API_KEY": "real_key",
                "WEBHOOK_BASE_URL": "https://example.com",
                "WEBHOOK_PATH": "/telegram",
                "WEBHOOK_SECRET_TOKEN": "secret",
                "WEBHOOK_HOST": "127.0.0.1",
                "WEBHOOK_PORT": "9000",
            }
        ):
            settings = load_settings()

        self.assertEqual(settings.WEBHOOK_BASE_URL, "https://example.com")
        self.assertEqual(settings.WEBHOOK_PATH, "/telegram")
        self.assertEqual(settings.WEBHOOK_SECRET_TOKEN, "secret")
        self.assertEqual(settings.WEBHOOK_HOST, "127.0.0.1")
        self.assertEqual(settings.WEBHOOK_PORT, 9000)

    def test_reads_database_source_url(self) -> None:
        with temp_env(
            {
                "BOT_TOKEN": "12345:abc",
                "CHECKO_API_KEY": "real_key",
                "DATABASE_SOURCE_URL": "https://example.com/base.sqlite3",
            }
        ):
            settings = load_settings()

        self.assertEqual(settings.DATABASE_SOURCE_URL, "https://example.com/base.sqlite3")

    def test_rejects_invalid_database_source_url(self) -> None:
        with temp_env(
            {
                "BOT_TOKEN": "12345:abc",
                "CHECKO_API_KEY": "real_key",
                "DATABASE_SOURCE_URL": "ftp://example.com/base.sqlite3",
            }
        ):
            with self.assertRaises(RuntimeError) as exc:
                load_settings()

        self.assertIn("DATABASE_SOURCE_URL must be a valid HTTP/HTTPS URL", str(exc.exception))



if __name__ == "__main__":
    unittest.main()
