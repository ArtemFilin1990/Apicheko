import os
import unittest
from contextlib import contextmanager
from typing import Dict

from bot.config import get_settings, load_settings


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


if __name__ == "__main__":
    unittest.main()
