from aiogram.filters.callback_data import CallbackData
from aiogram.types import InlineKeyboardMarkup
from aiogram.utils.keyboard import InlineKeyboardBuilder
from types import SimpleNamespace


class CompanyNav(CallbackData, prefix="co"):
    sec: str
    ident: str


def main_menu_keyboard() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text="🔎 По ИНН / ОГРН", callback_data="search:inn")
    b.button(text="🧾 По названию", callback_data="search:name")
    b.button(text="🏦 По БИК", callback_data="search:bic")
    b.button(text="✉️ По Email", callback_data="search:email")
    b.button(text="ℹ️ Помощь", callback_data="help")
    b.adjust(2, 2, 1)
    return b.as_markup()


def buildCompanyKeyboard(company) -> InlineKeyboardMarkup:
    ident = str(getattr(company, "inn", "")).strip()
    finance = getattr(company, "finance", None) or {}
    revenue = finance.get("revenue") if isinstance(finance, dict) else getattr(finance, "revenue", None)
    authorized_capital = getattr(company, "authorized_capital", None)

    b = InlineKeyboardBuilder()
    b.button(text="⚖️ Скоринг", callback_data=CompanyNav(sec="main", ident=ident))
    b.button(text="🔗 Связи", callback_data=CompanyNav(sec="lnk", ident=ident))
    b.button(text="👥 Учредители", callback_data=CompanyNav(sec="own", ident=ident))
    b.button(text="🏷 ОКВЭД", callback_data=CompanyNav(sec="okv", ident=ident))
    b.button(text="🧾 Налоги", callback_data=CompanyNav(sec="tax", ident=ident))

    if revenue not in (None, "") or authorized_capital not in (None, ""):
        b.button(text="📊 Финансы", callback_data=CompanyNav(sec="fin", ident=ident))

    b.button(text="📜 История (ФНС)", url="https://egrul.nalog.ru/")
    b.button(text="🏠 В меню", callback_data="menu")
    b.adjust(2, 2, 1, 1, 1, 1)
    return b.as_markup()


def company_nav_keyboard(ident: str) -> InlineKeyboardMarkup:
    company = SimpleNamespace(inn=ident, finance=None, authorized_capital=None)
    return buildCompanyKeyboard(company)


def company_detail_keyboard(inn: str) -> InlineKeyboardMarkup:
    """Backward-compatible alias to the new company navigation keyboard."""
    return company_nav_keyboard(inn)


def person_or_entrepreneur_keyboard(inn: str) -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text="👔 Проверить как ИП", callback_data=f"resolve12:entrepreneur:{inn}")
    b.button(text="👤 Проверить связи физлица", callback_data=f"resolve12:person:{inn}")
    b.button(text="🏠 В меню", callback_data="menu")
    b.adjust(1)
    return b.as_markup()


def back_to_company_keyboard(inn: str) -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text="🔙 Назад к карточке", callback_data=CompanyNav(sec="main", ident=inn))
    b.button(text="🏠 В меню", callback_data="menu")
    b.adjust(1)
    return b.as_markup()


def search_results_keyboard(results: list[dict]) -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()

    for item in results[:10]:
        ident = str(
            item.get("ИНН")
            or item.get("ОГРН")
            or item.get("ОГРНИП")
            or item.get("inn")
            or item.get("ogrn")
            or item.get("ogrnip")
            or ""
        )

        name = (
            item.get("НаимПолн")
            or item.get("НаимСокр")
            or item.get("ФИО")
            or item.get("name")
            or item.get("shortName")
            or ident
        )

        short_name = f"{name[:40]}…" if len(name) > 40 else name
        b.button(text=f"{short_name}", callback_data=f"select:company:{ident}")

    b.button(text="🏠 В меню", callback_data="menu")
    b.adjust(1)
    return b.as_markup()


def cancel_keyboard() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text="❌ Отмена", callback_data="menu")
    return b.as_markup()


def cemetery_menu_keyboard() -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text="🔎 Ввести ИНН", callback_data="cem:search_inn")
    b.button(text="🧾 Ввести название/ФИО", callback_data="cem:search_name")
    b.button(text="🔙 В меню", callback_data="menu")
    b.adjust(1)
    return b.as_markup()


def cemetery_detail_keyboard(inn: str) -> InlineKeyboardMarkup:
    b = InlineKeyboardBuilder()
    b.button(text="💰 Финансы", callback_data=f"cem:financial:{inn}")
    b.button(text="⚖️ Арбитраж", callback_data=f"cem:arbitration:{inn}")
    b.button(text="🛡️ Исполн. производства", callback_data=f"cem:enforcements:{inn}")
    b.button(text="📑 Госконтракты", callback_data=f"cem:contracts:{inn}")
    b.button(text="🔍 Проверки", callback_data=f"cem:inspections:{inn}")
    b.button(text="📉 Банкротство", callback_data=f"cem:bankruptcy:{inn}")
    b.button(text="📝 История изменений", callback_data=f"cem:history:{inn}")
    b.button(text="📰 Федресурс", callback_data=f"cem:fedresurs:{inn}")
    b.button(text="📊 Риск", callback_data=f"cem:risk:{inn}")
    b.button(text="🔙 В карточку", callback_data=CompanyNav(sec="main", ident=inn))
    b.button(text="🏠 В меню", callback_data="menu")
    b.adjust(2, 2, 2, 2, 1, 1, 1)
    return b.as_markup()
