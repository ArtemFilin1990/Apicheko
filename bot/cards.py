from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from aiogram.types import InlineKeyboardMarkup

from bot.formatters import (
    format_arbitration,
    format_bankruptcy,
    format_company,
    format_contracts,
    format_enforcements,
    format_entrepreneur,
    format_fedresurs,
    format_financial,
    format_history,
    format_inspections,
)
from bot.keyboards import back_to_company_keyboard
from services.checko_api import CheckoAPI
from utils.checko_payload import extract_data, extract_items

CardFormatter = Callable[[dict], str]


@dataclass(frozen=True)
class DetailCardSpec:
    fetcher: str
    formatter: CardFormatter


DETAIL_CARDS: dict[str, DetailCardSpec] = {
    "company": DetailCardSpec(fetcher="get_company", formatter=format_company),
    "financial": DetailCardSpec(fetcher="get_financial", formatter=format_financial),
    "arbitration": DetailCardSpec(fetcher="get_arbitration", formatter=format_arbitration),
    "enforcements": DetailCardSpec(fetcher="get_enforcements", formatter=format_enforcements),
    "contracts": DetailCardSpec(fetcher="get_contracts", formatter=format_contracts),
    "inspections": DetailCardSpec(fetcher="get_inspections", formatter=format_inspections),
    "bankruptcy": DetailCardSpec(fetcher="get_bankruptcy", formatter=format_bankruptcy),
    "history": DetailCardSpec(fetcher="get_history", formatter=format_history),
    "fedresurs": DetailCardSpec(fetcher="get_fedresurs", formatter=format_fedresurs),
}

DETAIL_FETCHERS: dict[str, str] = {
    section: spec.fetcher
    for section, spec in DETAIL_CARDS.items()
}

SECTION_LIST_KEYS: dict[str, tuple[str, ...]] = {
    "arbitration": ("Р”РµР»Р°", "Р—Р°РїРёСЃРё", "cases", "items"),
    "enforcements": ("РРџ", "Р—Р°РїРёСЃРё", "items"),
    "contracts": ("РљРѕРЅС‚СЂР°РєС‚С‹", "Р—Р°РїРёСЃРё", "items"),
    "inspections": ("РџСЂРѕРІРµСЂРєРё", "Р—Р°РїРёСЃРё", "items"),
    "bankruptcy": ("РЎРѕРѕР±С‰РµРЅРёСЏ", "Р—Р°РїРёСЃРё", "messages", "items"),
    "history": ("РЎРѕР±С‹С‚РёСЏ", "events"),
    "fedresurs": ("РЎРѕРѕР±С‰РµРЅРёСЏ", "Р—Р°РїРёСЃРё", "messages", "items"),
}


def _identifier_params(identifier: str) -> dict[str, str]:
    if len(identifier) == 13:
        return {"ogrn": identifier}
    if len(identifier) == 15:
        return {"ogrnip": identifier}
    return {"inn": identifier}


def _normalize_financial_payload(payload: dict) -> dict:
    reports = extract_items(payload, "РћС‚С‡РµС‚С‹", "reports")
    if reports:
        return {"data": reports}

    data = extract_data(payload)
    if isinstance(data, dict):
        normalized = [
            {"year": year, **metrics}
            for year, metrics in data.items()
            if isinstance(year, str) and year.isdigit() and isinstance(metrics, dict)
        ]
        if normalized:
            normalized.sort(key=lambda item: item.get("year", ""), reverse=True)
            return {"data": normalized}

    return payload


def _normalize_detail_payload(section: str, payload: dict) -> dict:
    if section == "financial":
        return _normalize_financial_payload(payload)

    keys = SECTION_LIST_KEYS.get(section)
    if not keys:
        return payload

    items = extract_items(payload, *keys)
    if not items:
        return payload
    return {"data": items}


async def build_detail_card(
    checko_api: CheckoAPI,
    identifier: str,
    section: str,
) -> tuple[str, InlineKeyboardMarkup]:
    spec = DETAIL_CARDS.get(section)

    if section == "company" and len(identifier) == 12:
        spec = DetailCardSpec(fetcher="get_entrepreneur", formatter=format_entrepreneur)

    if not spec:
        raise ValueError(f"Unknown section: {section}")

    fetcher = getattr(checko_api, spec.fetcher)
    params = _identifier_params(identifier)
    payload = await fetcher(**params)
    normalized_payload = _normalize_detail_payload(section, payload)

    return spec.formatter(normalized_payload), back_to_company_keyboard(identifier)
