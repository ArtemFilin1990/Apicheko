import aiosqlite

from bot.config import settings


class Database:
    """Async SQLite database wrapper."""

    def __init__(self, path: str | None = None) -> None:
        self._path = path or settings.DATABASE_PATH
        self._conn: aiosqlite.Connection | None = None

    async def connect(self) -> None:
        self._conn = await aiosqlite.connect(self._path)
        self._conn.row_factory = aiosqlite.Row
        await self._create_tables()

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
