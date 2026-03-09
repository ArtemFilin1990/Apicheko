import asyncio
from typing import Any

import aiohttp


class CheckoAPIError(Exception):
    """Raised when Checko API returns an error."""

    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


class CheckoAPI:
    """Async client for the Checko API."""

    METHOD_ENDPOINTS: dict[str, str] = {
        "company": "company",
        "company_short": "company/short",
        "entrepreneur": "entrepreneur",
        "person": "person",
        "bank": "bank",
        "bankruptcy": "bankruptcy-messages",
        "enforcements": "enforcements",
        "arbitration": "legal-cases",
        "inspections": "inspections",
        "financial": "finances",
        "history": "timeline",
        "search": "search",
    }

    def __init__(
        self,
        base_url: str,
        key: str,
        timeout_seconds: int = 20,
        max_retries: int = 3,
        retry_delay_seconds: float = 1.5,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._key = key
        self._session: aiohttp.ClientSession | None = None
        self._timeout = aiohttp.ClientTimeout(total=timeout_seconds)
        self._max_retries = max_retries
        self._retry_delay_seconds = retry_delay_seconds

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=self._timeout)
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def _get(self, endpoint: str, **params: Any) -> dict:
        session = await self._get_session()
        params["key"] = self._key
        url = f"{self._base_url}/{endpoint.lstrip('/')}"

        last_error: Exception | None = None

        for attempt in range(1, self._max_retries + 1):
            try:
                async with session.get(url, params=params) as resp:
                    if 500 <= resp.status < 600:
                        raise CheckoAPIError(
                            f"Checko server error: {resp.status}", status_code=resp.status
                        )
                    if resp.status != 200:
                        raise CheckoAPIError(
                            f"API request failed: {resp.status}", status_code=resp.status
                        )

                    data = await resp.json()
                    if not isinstance(data, dict):
                        return data

                    if data.get("error"):
                        raise CheckoAPIError(str(data["error"]))

                    meta = data.get("meta")
                    if isinstance(meta, dict) and meta.get("status") == "error":
                        raise CheckoAPIError(str(meta.get("message") or "Checko returned error status."))

                    return data
            except CheckoAPIError as exc:
                if exc.status_code and 500 <= exc.status_code < 600:
                    last_error = exc
                else:
                    raise
            except (
                aiohttp.ClientConnectionError,
                aiohttp.ClientOSError,
                aiohttp.ServerTimeoutError,
                asyncio.TimeoutError,
                aiohttp.ClientPayloadError,
            ) as exc:
                last_error = exc

            if attempt >= self._max_retries:
                break
            await asyncio.sleep(self._retry_delay_seconds * attempt)

        raise CheckoAPIError(f"Checko request failed after retries: {last_error}")

    async def call_method(self, method: str, **params: Any) -> dict:
        endpoint = self.METHOD_ENDPOINTS.get(method)
        if endpoint is None:
            available = ", ".join(sorted(self.METHOD_ENDPOINTS))
            raise ValueError(f"Unknown Checko method '{method}'. Available methods: {available}.")
        return await self._get(endpoint, **params)

    async def get_company(self, **params: Any) -> dict:
        return await self.call_method("company", **params)

    async def get_company_short(self, **params: Any) -> dict:
        return await self.call_method("company_short", **params)

    async def get_entrepreneur(self, **params: Any) -> dict:
        return await self.call_method("entrepreneur", **params)

    async def get_person(self, **params: Any) -> dict:
        return await self.call_method("person", **params)

    async def get_bank(self, bic: str) -> dict:
        return await self.call_method("bank", bic=bic)

    async def get_bankruptcy(self, **params: Any) -> dict:
        return await self.call_method("bankruptcy", **params)

    async def get_enforcements(self, **params: Any) -> dict:
        return await self.call_method("enforcements", **params)

    async def get_arbitration(self, **params: Any) -> dict:
        return await self.call_method("arbitration", **params)

    async def get_contracts(self, **params: Any) -> dict:
        all_items: list[dict[str, Any]] = []

        for law in ("44", "94", "223"):
            response = await self._get("contracts", law=law, **params)
            data = response.get("data", response)
            items = data if isinstance(data, list) else data.get("items", [])
            if isinstance(items, list):
                all_items.extend(items)

        return {"data": {"items": all_items}}

    async def get_inspections(self, **params: Any) -> dict:
        return await self.call_method("inspections", **params)

    async def get_financial(self, **params: Any) -> dict:
        return await self.call_method("financial", **params)



    async def search(self, query: str) -> dict:
        return await self.call_method("search", query=query)
