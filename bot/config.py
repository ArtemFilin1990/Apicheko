from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    # Telegram
    BOT_TOKEN: str

    # Checko API
    CHECKO_API_KEY: str
    CHECKO_API_URL: str = "https://api.checko.ru/v2"

    # Database
    DATABASE_PATH: str = "bot.db"

    # Rate limiting (requests per second per user)
    THROTTLE_RATE: float = 0.5


settings = Settings()
