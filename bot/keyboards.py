from aiogram.types import InlineKeyboardMarkup
from aiogram.utils.keyboard import InlineKeyboardBuilder


def main_menu_keyboard() -> InlineKeyboardMarkup:
    """Main menu keyboard."""
    builder = InlineKeyboardBuilder()
    builder.button(text="рџ”Ќ РџРѕРёСЃРє РїРѕ РРќРќ", callback_data="search:inn")
    builder.button(text="рџ”Ћ РџРѕРёСЃРє РїРѕ РЅР°Р·РІР°РЅРёСЋ", callback_data="search:name")
    builder.button(text="рџ“‹ РСЃС‚РѕСЂРёСЏ Р·Р°РїСЂРѕСЃРѕРІ", callback_data="history")
    builder.button(text="в„№пёЏ РџРѕРјРѕС‰СЊ", callback_data="help")
    builder.adjust(2, 2)
    return builder.as_markup()


def company_detail_keyboard(inn: str) -> InlineKeyboardMarkup:
    """Keyboard with detail sections for a company."""
    builder = InlineKeyboardBuilder()
    builder.button(text="рџ’ј РћСЃРЅРѕРІРЅС‹Рµ РґР°РЅРЅС‹Рµ", callback_data=f"detail:{inn}:company")
    builder.button(text="рџ’° Р¤РёРЅР°РЅСЃС‹", callback_data=f"detail:{inn}:financial")
    builder.button(text="вљ–пёЏ РђСЂР±РёС‚СЂР°Р¶", callback_data=f"detail:{inn}:arbitration")
    builder.button(text="рџЏ›пёЏ РСЃРїРѕР»РЅ. РїСЂРѕРёР·РІРѕРґСЃС‚РІР°", callback_data=f"detail:{inn}:enforcements")
    builder.button(text="рџ“‘ Р“РѕСЃРєРѕРЅС‚СЂР°РєС‚С‹", callback_data=f"detail:{inn}:contracts")
    builder.button(text="рџ”Ќ РџСЂРѕРІРµСЂРєРё", callback_data=f"detail:{inn}:inspections")
    builder.button(text="рџ“° Р‘Р°РЅРєСЂРѕС‚СЃС‚РІРѕ", callback_data=f"detail:{inn}:bankruptcy")
    builder.button(text="рџ“њ РСЃС‚РѕСЂРёСЏ РёР·РјРµРЅРµРЅРёР№", callback_data=f"detail:{inn}:history")
    builder.button(text="рџ“„ Р¤РµРґСЂРµСЃСѓСЂСЃ", callback_data=f"detail:{inn}:fedresurs")
    builder.button(text="рџ”™ Р’ РјРµРЅСЋ", callback_data="menu")
    builder.adjust(2, 2, 2, 2, 1, 1)
    return builder.as_markup()


def person_or_entrepreneur_keyboard(inn: str) -> InlineKeyboardMarkup:
    """Ask user to choose how to resolve 12-digit INN."""
    builder = InlineKeyboardBuilder()
    builder.button(text="рџ‘” РџСЂРѕРІРµСЂРёС‚СЊ РєР°Рє РРџ", callback_data=f"resolve12:entrepreneur:{inn}")
    builder.button(text="рџ‘¤ РџСЂРѕРІРµСЂРёС‚СЊ СЃРІСЏР·Рё С„РёР·Р»РёС†Р°", callback_data=f"resolve12:person:{inn}")
    builder.button(text="рџ”™ Р’ РјРµРЅСЋ", callback_data="menu")
    builder.adjust(1)
    return builder.as_markup()


def back_to_company_keyboard(inn: str) -> InlineKeyboardMarkup:
    """Keyboard to go back to the company details."""
    builder = InlineKeyboardBuilder()
    builder.button(text="рџ”™ РќР°Р·Р°Рґ Рє РєРѕРјРїР°РЅРёРё", callback_data=f"detail:{inn}:company")
    builder.button(text="рџЏ  Р’ РјРµРЅСЋ", callback_data="menu")
    builder.adjust(1)
    return builder.as_markup()


def search_results_keyboard(results: list[dict]) -> InlineKeyboardMarkup:
    """Keyboard with search results list."""
    builder = InlineKeyboardBuilder()
    for item in results[:10]:
        inn = str(item.get("РРќРќ") or item.get("inn") or "")
        name = (
            item.get("РќР°РёРјРџРѕР»РЅ")
            or item.get("РќР°РёРјРЎРѕРєСЂ")
            or item.get("Р¤РРћ")
            or item.get("name")
            or item.get("shortName")
            or inn
        )
        short_name = name[:40] + "вЂ¦" if len(name) > 40 else name
        entity_type = "entrepreneur" if item.get("РћР“Р РќРРџ") or len(inn) == 12 else "company"
        builder.button(
            text=f"{short_name} ({inn})",
            callback_data=f"select:{entity_type}:{inn}",
        )
    builder.button(text="рџ”™ Р’ РјРµРЅСЋ", callback_data="menu")
    builder.adjust(1)
    return builder.as_markup()


def cancel_keyboard() -> InlineKeyboardMarkup:
    """Simple cancel / back to menu keyboard."""
    builder = InlineKeyboardBuilder()
    builder.button(text="вќЊ РћС‚РјРµРЅР°", callback_data="menu")
    return builder.as_markup()
