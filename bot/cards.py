from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from aiogram.types import InlineKeyboardMarkup

from bot.formatters import (
    format_arbitration,
    format_arbitration_screen,
    format_bankruptcy,
    format_company,
    format_company_main_screen,
    format_company_risk_screen,
    format_connections_screen,
    format_contracts,
    format_contracts_screen,
    format_enforcements,
    format_entrepreneur,
    format_fedresurs,
    format_financial,
    format_financial_screen,
    format_founders_screen,
    format_branches_screen,
    format_history,
    format_history_screen,
    format_inspections,
    format_okved_screen,
    format_taxes_screen,
    format_fssp_screen,
)
from bot.keyboards import back_to_company_keyboard, company_nav_keyboard
from services.checko_api import CheckoAPI
from utils.checko_payload import extract_data, extract_items

CardFormatter = Callable[[dict], str]


@dataclass(frozen=True)
class DetailCardSpec:
    fetcher: str
    formatter: CardFormatter


@dataclass(frozen=True)
class ScreenSpec:
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

SCREEN_SPECS: dict[str, ScreenSpec] = {
    "main": ScreenSpec(fetcher="get_company", formatter=format_company_main_screen),
    "risk": ScreenSpec(fetcher="get_company", formatter=format_company_risk_screen),
    "fin": ScreenSpec(fetcher="get_financial", formatter=format_financial_screen),
    "arb": ScreenSpec(fetcher="get_arbitration", formatter=format_arbitration_screen),
    "fsp": ScreenSpec(fetcher="get_enforcements", formatter=format_fssp_screen),
    "ctr": ScreenSpec(fetcher="get_contracts", formatter=format_contracts_screen),
    "his": ScreenSpec(fetcher="get_history", formatter=format_history_screen),
    "lnk": ScreenSpec(fetcher="get_company", formatter=format_connections_screen),
    "own": ScreenSpec(fetcher="get_company", formatter=format_founders_screen),
    "fil": ScreenSpec(fetcher="get_company", formatter=format_branches_screen),
    "okv": ScreenSpec(fetcher="get_company", formatter=format_okved_screen),
    "tax": ScreenSpec(fetcher="get_company", formatter=format_taxes_screen),
}

DETAIL_FETCHERS: dict[str, str] = {section: spec.fetcher for section, spec in DETAIL_CARDS.items()}

SECTION_LIST_KEYS: dict[str, tuple[str, ...]] = {
    "arbitration": ("Дела", "Записи", "cases", "items"),
    "enforcements": ("ИП", "Записи", "items"),
    "contracts": ("Контракты", "Записи", "items"),
    "inspections": ("Проверки", "Записи", "items"),
    "bankruptcy": ("Сообщения", "Записи", "messages", "items"),
    "history": ("События", "events"),
    "fedresurs": ("Сообщения", "Записи", "messages", "items"),
}


def _identifier_params(identifier: str) -> dict[str, str]:
    if len(identifier) == 13:
        return {"ogrn": identifier}
    if len(identifier) == 15:
        return {"ogrnip": identifier}
    return {"inn": identifier}


def _normalize_financial_payload(payload: dict) -> dict:
    reports = extract_items(payload, "Отчеты", "reports")
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
    if section in {"financial", "fin"}:
        return _normalize_financial_payload(payload)

    map_section = {
        "arb": "arbitration",
        "fsp": "enforcements",
        "ctr": "contracts",
        "his": "history",
    }.get(section, section)

    keys = SECTION_LIST_KEYS.get(map_section)
    if not keys:
        return payload

    items = extract_items(payload, *keys)
    if not items:
        return payload
    return {"data": items}


async def build_company_screen(
    checko_api: CheckoAPI,
    identifier: str,
    section: str,
) -> tuple[str, InlineKeyboardMarkup]:
    spec = SCREEN_SPECS.get(section)
    if not spec:
        raise ValueError(f"Unknown section: {section}")

    fetcher_name = spec.fetcher
    if fetcher_name == "get_company" and len(identifier) in (12, 15):
        fetcher_name = "get_entrepreneur"

    fetcher = getattr(checko_api, fetcher_name)
    payload = await fetcher(**_identifier_params(identifier))
    normalized_payload = _normalize_detail_payload(section, payload)
    return spec.formatter(normalized_payload), company_nav_keyboard(identifier)


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
