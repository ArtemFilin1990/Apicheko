from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from aiogram.types import InlineKeyboardMarkup

from bot.checko_api import CheckoAPI
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


def _identifier_params(identifier: str) -> dict[str, str]:
    if len(identifier) == 13:
        return {"ogrn": identifier}
    if len(identifier) == 15:
        return {"ogrnip": identifier}
    return {"inn": identifier}


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

    if "inn" in params:
        data = await fetcher(params["inn"])
    else:
        data = await fetcher(**params)

    return spec.formatter(data), back_to_company_keyboard(identifier)
