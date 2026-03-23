from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

import aiohttp

DADATA_AFFILIATED_URL = "https://suggestions.dadata.ru/suggestions/api/4_1/rs/findAffiliated/party"
DADATA_EMAIL_URL = "https://suggestions.dadata.ru/suggestions/api/4_1/rs/findByEmail/party"
_DADATA_TIMEOUT = aiohttp.ClientTimeout(total=10)


class DadataError(RuntimeError):
    """Raised when the DaData API is unavailable or misconfigured."""


@dataclass(frozen=True)
class CompanyData:
    inn: str
    name: str
    ogrn: str | None = None
    address: str | None = None
    status: str | None = None
    manager: str | None = None
    okved: str | None = None
    email: str | None = None
    website: str | None = None

    def to_checko_payload(self) -> dict[str, Any]:
        okved = self.okved or ""
        okved_code, _, okved_name = okved.partition(" ")
        return {
            "data": {
                "НаимПолн": self.name,
                "НаимСокр": self.name,
                "ИНН": self.inn,
                "ОГРН": self.ogrn,
                "Статус": {"Наим": self.status},
                "ЮрАдрес": {"АдресРФ": self.address},
                "ОКВЭД": {
                    "Код": okved_code or self.okved,
                    "Наим": okved_name.lstrip("— ").strip() or None,
                },
                "Руковод": [{"ФИО": self.manager}] if self.manager else [],
                "Контакты": {
                    "Емэйл": [self.email] if self.email else [],
                    "ВебСайт": self.website,
                },
            }
        }


@dataclass(frozen=True)
class AffiliatedData:
    inn: str
    name: str
    type: str


def _dadata_headers() -> dict[str, str]:
    token = (os.getenv("DADATA_API_KEY") or "").strip()
    secret = (os.getenv("DADATA_SECRET_KEY") or "").strip()
    if not token or not secret:
        raise DadataError("Не настроены DADATA_API_KEY / DADATA_SECRET_KEY.")
    return {
        "Authorization": f"Token {token}",
        "X-Secret": secret,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


async def _post_json(url: str, payload: dict[str, Any], session: aiohttp.ClientSession | None = None) -> dict[str, Any]:
    owns_session = session is None
    client = session or aiohttp.ClientSession(timeout=_DADATA_TIMEOUT)
    try:
        try:
            async with client.post(url, json=payload, headers=_dadata_headers()) as response:
                if response.status >= 400:
                    snippet = (await response.text())[:300]
                    raise DadataError(f"DaData HTTP {response.status}: {snippet}")
                data = await response.json(content_type=None)
                if not isinstance(data, dict):
                    raise DadataError("DaData вернул неожиданный формат ответа.")
                return data
        except aiohttp.ClientError as exc:
            raise DadataError(f"DaData недоступен: {exc}") from exc
    finally:
        if owns_session:
            await client.close()


def _pick_suggestion_data(payload: dict[str, Any]) -> dict[str, Any] | None:
    suggestions = payload.get("suggestions")
    if not isinstance(suggestions, list) or not suggestions:
        return None
    first = suggestions[0]
    if not isinstance(first, dict):
        return None
    data = first.get("data")
    return data if isinstance(data, dict) else None


def _company_from_suggestion(data: dict[str, Any]) -> CompanyData | None:
    inn = str(data.get("inn") or "").strip()
    name = (
        (data.get("name") or {}).get("short_with_opf")
        or (data.get("name") or {}).get("full_with_opf")
        or str(data.get("value") or "").strip()
    )
    if not inn or not name:
        return None

    okved_code = str(data.get("okved") or "").strip()
    okved_name = str((data.get("okved_type") or "").strip())
    okved = " — ".join(part for part in [okved_code, okved_name] if part)

    status_map = {
        "ACTIVE": "Действует",
        "LIQUIDATING": "Ликвидируется",
        "LIQUIDATED": "Ликвидирована",
        "BANKRUPT": "Банкротство",
        "REORGANIZING": "Реорганизация",
    }
    raw_status = str(((data.get("state") or {}).get("status")) or "").strip()
    status = status_map.get(raw_status, raw_status or None)

    return CompanyData(
        inn=inn,
        name=name,
        ogrn=str(data.get("ogrn") or "").strip() or None,
        address=((data.get("address") or {}).get("value") or None),
        status=status,
        manager=((data.get("management") or {}).get("name") or None),
        okved=okved or None,
        email=None,
        website=None,
    )


def _affiliated_type(data: dict[str, Any]) -> str:
    candidates = [
        data.get("relation_type"),
        data.get("affiliated_type"),
        data.get("branch_type"),
        data.get("scope"),
        (data.get("relation") or {}).get("type") if isinstance(data.get("relation"), dict) else None,
    ]
    normalized = " ".join(str(item).strip().lower() for item in candidates if item).strip()
    if "found" in normalized or "учред" in normalized:
        return "Учредитель"
    if "manager" in normalized or "director" in normalized or "руковод" in normalized:
        return "Руководитель"
    if "child" in normalized or "subsidi" in normalized or "доч" in normalized:
        return "Дочерняя компания"
    return "Связанная компания"


async def get_affiliated(inn: str, session: aiohttp.ClientSession | None = None) -> list[AffiliatedData]:
    normalized_inn = str(inn or "").strip()
    if not normalized_inn:
        return []

    payload = await _post_json(DADATA_AFFILIATED_URL, {"query": normalized_inn}, session=session)
    suggestions = payload.get("suggestions")
    if not isinstance(suggestions, list) or not suggestions:
        return []

    items: list[AffiliatedData] = []
    seen: set[tuple[str, str]] = set()
    for suggestion in suggestions:
        if not isinstance(suggestion, dict):
            continue
        data = suggestion.get("data")
        if not isinstance(data, dict):
            continue
        related_inn = str(data.get("inn") or "").strip()
        if not related_inn or related_inn == normalized_inn:
            continue
        name = (
            (data.get("name") or {}).get("short_with_opf")
            or (data.get("name") or {}).get("full_with_opf")
            or str(suggestion.get("value") or "").strip()
        )
        if not name:
            continue
        relation_type = _affiliated_type(data)
        dedupe_key = (related_inn, relation_type)
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        items.append(AffiliatedData(inn=related_inn, name=name, type=relation_type))
    return items


async def get_company_by_email(email: str, session: aiohttp.ClientSession | None = None) -> CompanyData | None:
    normalized_email = str(email or "").strip().lower()
    if not normalized_email:
        return None

    payload = await _post_json(DADATA_EMAIL_URL, {"query": normalized_email}, session=session)
    data = _pick_suggestion_data(payload)
    if not data:
        return None
    return _company_from_suggestion(data)
