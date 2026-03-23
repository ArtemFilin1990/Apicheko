from __future__ import annotations

import hashlib
import json
import os
from typing import Any


DEFAULT_DADATA_API_URL = "https://suggestions.dadata.ru/suggestions/api/4_1/rs"
PARTY_ENDPOINT = "/findById/party"
ALLOWED_QUERY_LENGTHS = {10, 13}
BITRIX_FIELD_MAP = {
    "full_name": "UF_CRM_DD_FULLNM",
    "short_name": "UF_CRM_DD_SHORTNM",
    "inn": "UF_CRM_DD_INN",
    "kpp": "UF_CRM_DD_KPP",
    "ogrn": "UF_CRM_DD_OGRN",
    "okved": "UF_CRM_DD_OKVED",
    "ceo_name": "UF_CRM_DD_CEO_NAME",
    "ceo_post": "UF_CRM_DD_CEO_POST",
    "status": "UF_CRM_DD_STATUS",
    "address_full": "UF_CRM_DD_ADDRESS",
}


class DaDataConfigError(RuntimeError):
    """Raised when the DaData MCP server is not configured correctly."""


class DaDataRequestError(RuntimeError):
    """Raised when a DaData request fails after retries."""


class DaDataValidationError(ValueError):
    """Raised when an identifier is invalid for DaData enrichment."""


async def dadata_request(query: str, *, retries: int = 2, timeout: float = 30.0) -> dict[str, Any]:
    """Perform a DaData findById/party request with minimal retry logic."""
    token = (os.getenv("DADATA_API_KEY") or "").strip()
    secret = (os.getenv("DADATA_SECRET_KEY") or "").strip()
    base_url = (os.getenv("DADATA_API_URL") or DEFAULT_DADATA_API_URL).rstrip("/")

    if not token or not secret:
        raise DaDataConfigError("DADATA_API_KEY or DADATA_SECRET_KEY is not set")

    url = f"{base_url}{PARTY_ENDPOINT}"
    headers = {
        "Authorization": f"Token {token}",
        "X-Secret": secret,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    payload = {"query": query}

    last_error: Exception | None = None
    import httpx

    async with httpx.AsyncClient(timeout=timeout) as client:
        for attempt in range(1, retries + 2):
            try:
                response = await client.post(url, headers=headers, json=payload)
                response.raise_for_status()
                data = response.json()
                if not isinstance(data, dict):
                    raise DaDataRequestError("DaData returned unexpected JSON shape")
                return data
            except (httpx.HTTPError, ValueError) as exc:
                last_error = exc
                if attempt >= retries + 1:
                    break

    raise DaDataRequestError(f"DaData request failed: {last_error}")


def validate_company_query(query: str) -> str:
    normalized = (query or "").strip()
    if not normalized:
        raise DaDataValidationError("empty query")
    if not normalized.isdigit():
        raise DaDataValidationError("query must contain digits only")
    if len(normalized) not in ALLOWED_QUERY_LENGTHS:
        raise DaDataValidationError("query must be a 10-digit INN or 13-digit OGRN")
    return normalized


def normalize_party(item: dict[str, Any]) -> dict[str, Any]:
    data = item.get("data", {})
    name = data.get("name", {})
    opf = data.get("opf", {})
    management = data.get("management", {})
    address = data.get("address", {}).get("data", {})
    state = data.get("state", {})

    return {
        "full_name": name.get("full_with_opf"),
        "short_name": name.get("short_with_opf"),
        "inn": data.get("inn"),
        "kpp": data.get("kpp"),
        "ogrn": data.get("ogrn"),
        "okved": data.get("okved"),
        "opf_code": opf.get("code"),
        "opf_full": opf.get("full"),
        "opf_short": opf.get("short"),
        "ceo_name": management.get("name"),
        "ceo_post": management.get("post"),
        "status": state.get("status"),
        "registration_date": state.get("registration_date"),
        "actuality_date": state.get("actuality_date"),
        "address_full": data.get("address", {}).get("value"),
        "postal_code": address.get("postal_code"),
        "region": address.get("region_with_type"),
        "city": address.get("city_with_type"),
    }


def build_raw_hash(payload: dict[str, Any]) -> str:
    serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def build_bitrix_fields(normalized: dict[str, Any]) -> dict[str, Any]:
    return {
        bitrix_key: normalized.get(source_key)
        for source_key, bitrix_key in BITRIX_FIELD_MAP.items()
        if normalized.get(source_key) is not None
    }


async def enrich_company_payload(query: str) -> dict[str, Any]:
    try:
        normalized_query = validate_company_query(query)
    except DaDataValidationError as exc:
        return {"status": "error", "message": str(exc), "query": (query or "").strip()}

    try:
        result = await dadata_request(normalized_query)
    except (DaDataConfigError, DaDataRequestError) as exc:
        return {"status": "error", "message": str(exc), "query": normalized_query}

    suggestions = result.get("suggestions", [])
    if not suggestions:
        return {
            "status": "not_found",
            "message": "organization not found",
            "query": normalized_query,
            "source": "DaData/findById/party",
        }

    raw = suggestions[0]
    normalized = normalize_party(raw)

    return {
        "status": "synced",
        "query": normalized_query,
        "source": "DaData/findById/party",
        "fields": normalized,
        "raw_hash": build_raw_hash(raw),
        "raw": raw,
    }


async def enrich_company_for_bitrix_payload(query: str) -> dict[str, Any]:
    payload = await enrich_company_payload(query)
    if payload.get("status") != "synced":
        return payload

    fields = payload.get("fields", {})
    return {
        "status": "synced",
        "query": payload["query"],
        "source": payload["source"],
        "raw_hash": payload["raw_hash"],
        "bitrix_fields": build_bitrix_fields(fields),
        "raw": payload["raw"],
    }


def create_mcp() -> Any:
    from mcp.server.fastmcp import FastMCP

    mcp = FastMCP("dadata-enrichment")

    @mcp.tool()
    async def enrich_company(query: str) -> dict[str, Any]:
        """
        Обогатить компанию по ИНН или ОГРН через DaData findById/party.

        Args:
            query: 10-значный ИНН или 13-значный ОГРН организации.
        """

        return await enrich_company_payload(query)

    @mcp.tool()
    async def enrich_company_for_bitrix(query: str) -> dict[str, Any]:
        """
        Обогатить компанию и вернуть Bitrix24-совместимый набор полей.

        Args:
            query: 10-значный ИНН или 13-значный ОГРН организации.
        """

        return await enrich_company_for_bitrix_payload(query)

    return mcp


def main() -> None:
    create_mcp().run(transport="stdio")


if __name__ == "__main__":
    main()
