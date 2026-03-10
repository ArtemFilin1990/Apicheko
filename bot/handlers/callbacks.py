import html

from aiogram import F, Router
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery

from bot.cards import DETAIL_FETCHERS, build_detail_card
from bot.formatters import format_company, format_entrepreneur, format_person
from bot.handlers.search import SearchState
from bot.keyboards import cancel_keyboard, company_detail_keyboard, main_menu_keyboard
from services.checko_api import CheckoAPI, CheckoAPIError
from storage.database import Database

router = Router(name="callbacks")

# Keep compatibility for tests importing internals from this module.
_DETAIL_FETCHERS = DETAIL_FETCHERS


@router.callback_query(F.data == "menu")
async def cb_menu(call: CallbackQuery, state: FSMContext) -> None:
    await state.clear()
    await call.message.edit_text(
        "рџЏ  Р“Р»Р°РІРЅРѕРµ РјРµРЅСЋ. Р’С‹Р±РµСЂРёС‚Рµ РґРµР№СЃС‚РІРёРµ:",
        reply_markup=main_menu_keyboard(),
    )
    await call.answer()


@router.callback_query(F.data == "help")
async def cb_help(call: CallbackQuery) -> None:
    help_text = (
        "в„№пёЏ <b>РљР°Рє РїРѕР»СЊР·РѕРІР°С‚СЊСЃСЏ Р±РѕС‚РѕРј</b>\n\n"
        "вЂў <b>РџРѕРёСЃРє РїРѕ РёРґРµРЅС‚РёС„РёРєР°С‚РѕСЂСѓ</b> вЂ” РРќРќ 10/12, РћР“Р Рќ 13, РћР“Р РќРРџ 15.\n"
        "вЂў Р”Р»СЏ РРќРќ 12 Р±РѕС‚ РїСЂРµРґР»РѕР¶РёС‚ РІС‹Р±СЂР°С‚СЊ: <b>РРџ</b> РёР»Рё <b>С„РёР·Р»РёС†Рѕ</b>.\n"
        "вЂў РџРѕРёСЃРє РїРѕ РЅР°Р·РІР°РЅРёСЋ РїРѕРєР°Р·С‹РІР°РµС‚ СЃРїРёСЃРѕРє РЅР°Р№РґРµРЅРЅС‹С… РєРѕРјРїР°РЅРёР№.\n"
        "вЂў Р”Р»СЏ СЋСЂР»РёС† РґРѕСЃС‚СѓРїРЅС‹ РґРµС‚Р°Р»СЊРЅС‹Рµ СЂР°Р·РґРµР»С‹: С„РёРЅР°РЅСЃС‹, Р°СЂР±РёС‚СЂР°Р¶, Р¤РЎРЎРџ Рё РґСЂ.\n\n"
        "Р•СЃР»Рё С‡С‚Рѕ-С‚Рѕ РЅРµ СЂР°Р±РѕС‚Р°РµС‚ вЂ” РїРѕРїСЂРѕР±СѓР№С‚Рµ /start."
    )
    await call.message.edit_text(help_text, reply_markup=main_menu_keyboard())
    await call.answer()


@router.callback_query(F.data == "search:inn")
async def cb_search_inn(call: CallbackQuery, state: FSMContext) -> None:
    await state.set_state(SearchState.waiting_for_inn)
    await call.message.edit_text(
        "Р’РІРµРґРёС‚Рµ РРќРќ (10/12), РћР“Р Рќ (13) РёР»Рё РћР“Р РќРРџ (15):",
        reply_markup=cancel_keyboard(),
    )
    await call.answer()


@router.callback_query(F.data == "search:name")
async def cb_search_name(call: CallbackQuery, state: FSMContext) -> None:
    await state.set_state(SearchState.waiting_for_name)
    await call.message.edit_text(
        "Р’РІРµРґРёС‚Рµ РЅР°Р·РІР°РЅРёРµ РєРѕРјРїР°РЅРёРё РёР»Рё Р¤РРћ РРџ:",
        reply_markup=cancel_keyboard(),
    )
    await call.answer()


@router.callback_query(F.data == "history")
async def cb_history(call: CallbackQuery, db: Database) -> None:
    user = call.from_user
    if not user:
        await call.answer()
        return

    rows = await db.get_user_history(user.id, limit=10)
    if not rows:
        await call.message.edit_text(
            "рџ“­ РСЃС‚РѕСЂРёСЏ Р·Р°РїСЂРѕСЃРѕРІ РїСѓСЃС‚Р°.", reply_markup=main_menu_keyboard()
        )
        await call.answer()
        return

    lines = ["рџ“‹ <b>РџРѕСЃР»РµРґРЅРёРµ Р·Р°РїСЂРѕСЃС‹:</b>", ""]
    for row in rows:
        query = html.escape(str(row["query"]))
        created = html.escape(str(row["searched_at"]))
        lines.append(f"вЂў {query} <i>({created})</i>")

    await call.message.edit_text("\n".join(lines), reply_markup=main_menu_keyboard())
    await call.answer()


@router.callback_query(F.data.startswith("resolve12:"))
async def cb_resolve_12digit(call: CallbackQuery, checko_api: CheckoAPI) -> None:
    parts = call.data.split(":", 2)
    if len(parts) != 3:
        await call.answer("РќРµРІРµСЂРЅС‹Р№ Р·Р°РїСЂРѕСЃ", show_alert=True)
        return

    _, mode, inn = parts

    await call.message.edit_text("рџ”„ Р—Р°РіСЂСѓР¶Р°СЋвЂ¦")
    try:
        if mode == "entrepreneur":
            data = await checko_api.get_entrepreneur(inn=inn)
            text = format_entrepreneur(data)
            markup = company_detail_keyboard(inn)
        elif mode == "person":
            data = await checko_api.get_person(inn=inn)
            text = format_person(data)
            markup = cancel_keyboard()
        else:
            await call.answer("РќРµРёР·РІРµСЃС‚РЅС‹Р№ СЂРµР¶РёРј", show_alert=True)
            return

        await call.message.edit_text(text, reply_markup=markup)
    except CheckoAPIError as exc:
        await call.message.edit_text(
            f"вљ пёЏ РћС€РёР±РєР° РїСЂРё Р·Р°РіСЂСѓР·РєРµ РґР°РЅРЅС‹С…:\n<i>{html.escape(str(exc))}</i>",
            reply_markup=main_menu_keyboard(),
        )
    await call.answer()


@router.callback_query(F.data.startswith("select:"))
async def cb_select_search_result(call: CallbackQuery, checko_api: CheckoAPI) -> None:
    parts = call.data.split(":", 2)
    if len(parts) != 3:
        await call.answer("РќРµРІРµСЂРЅС‹Р№ Р·Р°РїСЂРѕСЃ", show_alert=True)
        return

    _, entity_type, identifier = parts

    await call.message.edit_text("рџ”„ Р—Р°РіСЂСѓР¶Р°СЋвЂ¦")
    try:
        if entity_type == "entrepreneur":
            data = await checko_api.get_entrepreneur(inn=identifier)
            text = format_entrepreneur(data)
        else:
            data = await checko_api.get_company(inn=identifier)
            text = format_company(data)

        await call.message.edit_text(
            text,
            reply_markup=company_detail_keyboard(identifier),
        )
    except CheckoAPIError as exc:
        await call.message.edit_text(
            f"вљ пёЏ РћС€РёР±РєР° РїСЂРё Р·Р°РіСЂСѓР·РєРµ РєР°СЂС‚РѕС‡РєРё:\n<i>{html.escape(str(exc))}</i>",
            reply_markup=main_menu_keyboard(),
        )
    await call.answer()


@router.callback_query(F.data.startswith("detail:"))
async def cb_detail(call: CallbackQuery, checko_api: CheckoAPI) -> None:
    parts = call.data.split(":", 2)
    if len(parts) != 3:
        await call.answer("РќРµРІРµСЂРЅС‹Р№ Р·Р°РїСЂРѕСЃ.", show_alert=True)
        return

    _, identifier, section = parts

    if section not in _DETAIL_FETCHERS:
        if not (section == "company" and len(identifier) == 12):
            await call.answer("РќРµРёР·РІРµСЃС‚РЅС‹Р№ СЂР°Р·РґРµР».", show_alert=True)
            return

    await call.message.edit_text("рџ”„ Р—Р°РіСЂСѓР¶Р°СЋвЂ¦")

    try:
        text, markup = await build_detail_card(checko_api, identifier, section)
        await call.message.edit_text(text, reply_markup=markup)
    except CheckoAPIError as exc:
        await call.message.edit_text(
            f"вљ пёЏ РћС€РёР±РєР° РїСЂРё Р·Р°РіСЂСѓР·РєРµ СЂР°Р·РґРµР»Р° В«{html.escape(section)}В»:\n<i>{html.escape(str(exc))}</i>",
            reply_markup=cancel_keyboard(),
        )
    await call.answer()
