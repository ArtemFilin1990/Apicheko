from aiogram.types import InlineKeyboardMarkup
from aiogram.utils.keyboard import InlineKeyboardBuilder


def main_menu_keyboard() -> InlineKeyboardMarkup:
    """Main menu keyboard."""
    builder = InlineKeyboardBuilder()
    builder.button(text="🔎 Поиск по ИНН / ОГРН", callback_data="search:inn")
    builder.button(text="🧾 Поиск по названию", callback_data="search:name")
    builder.button(text="📋 История запросов", callback_data="history")
    builder.button(text="ℹ️ Помощь", callback_data="help")
    builder.adjust(2, 2)
    return builder.as_markup()


def company_nav_keyboard(ident: str) -> InlineKeyboardMarkup:
    """Navigation keyboard for company screens (co:* callbacks)."""
    builder = InlineKeyboardBuilder()

    builder.button(text="🏢 Карточка", callback_data=f"co:main:{ident}")
    builder.button(text="⚠️ Проверки", callback_data=f"co:risk:{ident}")

    builder.button(text="💰 Финансы", callback_data=f"co:fin:{ident}")
    builder.button(text="⚖️ Арбитраж", callback_data=f"co:arb:{ident}")

    builder.button(text="🛡️ ФССП", callback_data=f"co:fsp:{ident}")
    builder.button(text="📑 Контракты", callback_data=f"co:ctr:{ident}")

    builder.button(text="🕓 История", callback_data=f"co:his:{ident}")
    builder.button(text="🔗 Связи", callback_data=f"co:lnk:{ident}")

    builder.button(text="👥 Учредители", callback_data=f"co:own:{ident}")
    builder.button(text="🏬 Филиалы", callback_data=f"co:fil:{ident}")

    builder.button(text="🏭 ОКВЭД", callback_data=f"co:okv:{ident}")
    builder.button(text="🧾 Налоги", callback_data=f"co:tax:{ident}")

    builder.button(text="🏠 В меню", callback_data="menu")
    builder.adjust(2, 2, 2, 2, 2, 2, 1)
    return builder.as_markup()


def company_detail_keyboard(inn: str) -> InlineKeyboardMarkup:
    """Backward-compatible alias to the new company navigation keyboard."""
    return company_nav_keyboard(inn)


def person_or_entrepreneur_keyboard(inn: str) -> InlineKeyboardMarkup:
    """Ask user to choose how to resolve 12-digit INN."""
    builder = InlineKeyboardBuilder()
    builder.button(text="👔 Проверить как ИП", callback_data=f"resolve12:entrepreneur:{inn}")
    builder.button(text="👤 Проверить связи физлица", callback_data=f"resolve12:person:{inn}")
    builder.button(text="🔙 В меню", callback_data="menu")
    builder.adjust(1)
    return builder.as_markup()


def back_to_company_keyboard(inn: str) -> InlineKeyboardMarkup:
    """Keyboard to go back to the company details."""
    builder = InlineKeyboardBuilder()
    builder.button(text="🔙 Назад к карточке", callback_data=f"co:main:{inn}")
    builder.button(text="🏠 В меню", callback_data="menu")
    builder.adjust(1)
    return builder.as_markup()


def search_results_keyboard(results: list[dict]) -> InlineKeyboardMarkup:
    """Keyboard with search results list."""
    builder = InlineKeyboardBuilder()
    for item in results[:10]:
        inn = str(item.get("ИНН") or item.get("inn") or "")
        name = (
            item.get("НаимПолн")
            or item.get("НаимСокр")
            or item.get("ФИО")
            or item.get("name")
            or item.get("shortName")
            or inn
        )
        short_name = name[:40] + "…" if len(name) > 40 else name
        entity_type = "entrepreneur" if item.get("ОГРНИП") or len(inn) == 12 else "company"
        builder.button(
            text=f"{short_name} ({inn})",
            callback_data=f"select:{entity_type}:{inn}",
        )
    builder.button(text="🔙 В меню", callback_data="menu")
    builder.adjust(1)
    return builder.as_markup()


def cancel_keyboard() -> InlineKeyboardMarkup:
    """Simple cancel / back to menu keyboard."""
    builder = InlineKeyboardBuilder()
    builder.button(text="❌ Отмена", callback_data="menu")
    return builder.as_markup()



def cemetery_menu_keyboard() -> InlineKeyboardMarkup:
    """Scenario menu for deep due-diligence flow."""
    builder = InlineKeyboardBuilder()
    builder.button(text="🔎 Ввести ИНН", callback_data="cem:search_inn")
    builder.button(text="🧾 Ввести название/ФИО", callback_data="cem:search_name")
    builder.button(text="🔙 В меню", callback_data="menu")
    builder.adjust(1)
    return builder.as_markup()


def cemetery_detail_keyboard(inn: str) -> InlineKeyboardMarkup:
    """Detail sections keyboard for cemetery scenario."""
    builder = InlineKeyboardBuilder()
    builder.button(text="💰 Финансы", callback_data=f"cem:financial:{inn}")
    builder.button(text="⚖️ Арбитраж", callback_data=f"cem:arbitration:{inn}")
    builder.button(text="🛡️ Исполн. производства", callback_data=f"cem:enforcements:{inn}")
    builder.button(text="📑 Госконтракты", callback_data=f"cem:contracts:{inn}")
    builder.button(text="🔍 Проверки", callback_data=f"cem:inspections:{inn}")
    builder.button(text="📉 Банкротство", callback_data=f"cem:bankruptcy:{inn}")
    builder.button(text="📝 История изменений", callback_data=f"cem:history:{inn}")
    builder.button(text="📰 Федресурс", callback_data=f"cem:fedresurs:{inn}")
    builder.button(text="📊 Риск", callback_data=f"cem:risk:{inn}")
    builder.button(text="🔙 В карточку", callback_data=f"co:main:{inn}")
    builder.button(text="🏠 В меню", callback_data="menu")
    builder.adjust(2, 2, 2, 2, 1, 1, 1)
    return builder.as_markup()
