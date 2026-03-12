from __future__ import annotations

from pathlib import Path

import aiohttp
import aiosqlite

from config.settings import load_settings

MAX_DATABASE_SIZE_BYTES = 50 * 1024 * 1024


class Database:
    """Async SQLite database wrapper."""

    def __init__(self, path: str | None = None) -> None:
        settings = load_settings()
        self._path = path or settings.DATABASE_PATH
        self._source_url = settings.DATABASE_SOURCE_URL
        self._conn: aiosqlite.Connection | None = None

    async def connect(self) -> None:
        await self._ensure_database_file()
        self._conn = await aiosqlite.connect(self._path)
        self._conn.row_factory = aiosqlite.Row
        await self._conn.execute("PRAGMA foreign_keys = ON")
        await self._create_tables()

    async def _ensure_database_file(self) -> None:
        if not self._source_url:
            return

        destination = Path(self._path)
        if destination.exists():
            return

        destination.parent.mkdir(parents=True, exist_ok=True)

        timeout = aiohttp.ClientTimeout(total=30)
        downloaded = 0

        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(self._source_url) as response:
                    if response.status != 200:
                        raise RuntimeError(
                            f"Failed to download database from DATABASE_SOURCE_URL: HTTP {response.status}."
                        )

                    with destination.open("wb") as file:
                        async for chunk in response.content.iter_chunked(64 * 1024):
                            downloaded += len(chunk)
                            if downloaded > MAX_DATABASE_SIZE_BYTES:
                                raise RuntimeError(
                                    "Downloaded database exceeds MAX_DATABASE_SIZE_BYTES limit."
                                )
                            file.write(chunk)
        except (aiohttp.ClientError, TimeoutError) as exc:
            if destination.exists():
                destination.unlink(missing_ok=True)
            raise RuntimeError(
                f"Failed to download database from DATABASE_SOURCE_URL: {exc}."
            ) from exc

    async def close(self) -> None:
        if self._conn:
            await self._conn.close()
            self._conn = None

    async def _create_tables(self) -> None:
        assert self._conn
        await self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id          INTEGER PRIMARY KEY,
                username    TEXT,
                first_name  TEXT,
                last_name   TEXT,
                created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS search_history (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id     INTEGER NOT NULL REFERENCES users(id),
                query       TEXT NOT NULL,
                inn         TEXT,
                entity_type TEXT,
                searched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            """
        )
        await self._conn.commit()

    # --- Users ---

    async def upsert_user(
        self,
        user_id: int,
        username: str | None,
        first_name: str | None,
        last_name: str | None,
    ) -> None:
        assert self._conn
        await self._conn.execute(
            """
            INSERT INTO users (id, username, first_name, last_name)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                username   = excluded.username,
                first_name = excluded.first_name,
                last_name  = excluded.last_name
            """,
            (user_id, username, first_name, last_name),
        )
        await self._conn.commit()

    # --- Search history ---

    async def add_search(
        self,
        user_id: int,
        query: str,
        inn: str | None = None,
        entity_type: str | None = None,
    ) -> None:
        assert self._conn
        await self._conn.execute(
            """
            INSERT INTO search_history (user_id, query, inn, entity_type)
            VALUES (?, ?, ?, ?)
            """,
            (user_id, query, inn, entity_type),
        )
        await self._conn.commit()

    async def get_user_history(
        self, user_id: int, limit: int = 10
    ) -> list[aiosqlite.Row]:
        assert self._conn
        async with self._conn.execute(
            """
            SELECT query, inn, entity_type, searched_at
            FROM search_history
            WHERE user_id = ?
            ORDER BY searched_at DESC
            LIMIT ?
            """,
            (user_id, limit),
        ) as cursor:
            return await cursor.fetchall()
