from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton
from aiogram.utils.keyboard import InlineKeyboardBuilder


def main_menu_keyboard() -> InlineKeyboardMarkup:
    """Main menu keyboard."""
    builder = InlineKeyboardBuilder()
    builder.button(text="🔍 Поиск по ИНН", callback_data="search:inn")
    builder.button(text="🔎 Поиск по названию", callback_data="search:name")
    builder.button(text="📋 История запросов", callback_data="history")
    builder.button(text="ℹ️ Помощь", callback_data="help")
    builder.adjust(2, 2)
    return builder.as_markup()


def company_detail_keyboard(inn: str) -> InlineKeyboardMarkup:
    """Keyboard with detail sections for a company."""
    builder = InlineKeyboardBuilder()
    builder.button(text="💼 Основные данные", callback_data=f"detail:{inn}:company")
    builder.button(text="💰 Финансы", callback_data=f"detail:{inn}:financial")
    builder.button(text="⚖️ Арбитраж", callback_data=f"detail:{inn}:arbitration")
    builder.button(text="🏛️ Исполн. производства", callback_data=f"detail:{inn}:enforcements")
    builder.button(text="📑 Госконтракты", callback_data=f"detail:{inn}:contracts")
    builder.button(text="🔍 Проверки", callback_data=f"detail:{inn}:inspections")
    builder.button(text="🏦 Банки", callback_data=f"detail:{inn}:bank")
    builder.button(text="📰 Банкротство", callback_data=f"detail:{inn}:bankruptcy")
    builder.button(text="📜 История изменений", callback_data=f"detail:{inn}:history")
    builder.button(text="🔙 В меню", callback_data="menu")
    builder.adjust(2, 2, 2, 2, 1, 1)
    return builder.as_markup()


def back_to_company_keyboard(inn: str) -> InlineKeyboardMarkup:
    """Keyboard to go back to the company details."""
    builder = InlineKeyboardBuilder()
    builder.button(text="🔙 Назад к компании", callback_data=f"detail:{inn}:company")
    builder.button(text="🏠 В меню", callback_data="menu")
    builder.adjust(1)
    return builder.as_markup()


def search_results_keyboard(results: list[dict]) -> InlineKeyboardMarkup:
    """Keyboard with search results list."""
    builder = InlineKeyboardBuilder()
    for item in results[:10]:
        inn = item.get("inn", "")
        name = item.get("name", item.get("shortName", inn))
        short_name = name[:40] + "…" if len(name) > 40 else name
        # 12-digit INN belongs to an individual entrepreneur (ИП) or a person;
        # 10-digit INN belongs to a legal entity (ЮЛ).
        entity_type = "entrepreneur" if len(inn) == 12 else "company"
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
