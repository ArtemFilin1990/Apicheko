import aiohttp
from typing import Any

from bot.config import settings


class CheckoAPIError(Exception):
    """Raised when Checko API returns an error."""

    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


class CheckoAPI:
    """Async client for the Checko API."""

    def __init__(self) -> None:
        self._base_url = settings.CHECKO_API_URL.rstrip("/")
        self._key = settings.CHECKO_API_KEY
        self._session: aiohttp.ClientSession | None = None

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def _get(self, endpoint: str, **params: Any) -> dict:
        session = await self._get_session()
        params["key"] = self._key
        url = f"{self._base_url}/{endpoint.lstrip('/')}"
        async with session.get(url, params=params) as resp:
            if resp.status != 200:
                raise CheckoAPIError(
                    f"API request failed: {resp.status}", status_code=resp.status
                )
            data = await resp.json()
            if isinstance(data, dict) and data.get("error"):
                raise CheckoAPIError(data["error"])
            return data

    # --- Company (ЮЛ) ---

    async def get_company(self, inn: str) -> dict:
        """Get company info by INN."""
        return await self._get("company", inn=inn)

    async def get_company_short(self, inn: str) -> dict:
        """Get short company info by INN."""
        return await self._get("company/short", inn=inn)

    # --- Individual Entrepreneur (ИП / ЕГРИП) ---

    async def get_entrepreneur(self, inn: str) -> dict:
        """Get individual entrepreneur info by INN."""
        return await self._get("entrepreneur", inn=inn)

    # --- Individual (Физическое лицо) ---

    async def get_person(self, inn: str) -> dict:
        """Get individual info by INN."""
        return await self._get("person", inn=inn)

    # --- Bankruptcy (ЕФРСБ) ---

    async def get_bankruptcy(self, inn: str) -> dict:
        """Get bankruptcy records by INN."""
        return await self._get("bankruptcy", inn=inn)

    # --- Enforcement proceedings (Исполнительные производства) ---

    async def get_enforcements(self, inn: str) -> dict:
        """Get enforcement proceedings by INN."""
        return await self._get("enforcements", inn=inn)

    # --- Arbitration cases (Арбитражные дела) ---

    async def get_arbitration(self, inn: str) -> dict:
        """Get arbitration cases by INN."""
        return await self._get("arbitration", inn=inn)

    # --- Government contracts (Госзакупки) ---

    async def get_contracts(self, inn: str) -> dict:
        """Get government contracts by INN."""
        return await self._get("contracts", inn=inn)

    # --- Inspections (Проверки) ---

    async def get_inspections(self, inn: str) -> dict:
        """Get inspections by INN."""
        return await self._get("inspections", inn=inn)

    # --- Financial reports (Финансовая отчётность) ---

    async def get_financial(self, inn: str) -> dict:
        """Get financial reports by INN."""
        return await self._get("financial", inn=inn)

    # --- Bank accounts (Банк) ---

    async def get_bank(self, inn: str) -> dict:
        """Get bank account info by INN."""
        return await self._get("bank", inn=inn)

    # --- Change history (История изменений) ---

    async def get_history(self, inn: str) -> dict:
        """Get change history by INN."""
        return await self._get("history", inn=inn)

    # --- Search ---

    async def search(self, query: str) -> dict:
        """Search companies and entrepreneurs by name or INN."""
        return await self._get("search", query=query)


checko_api = CheckoAPI()
