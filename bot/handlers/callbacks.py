import html

from aiogram import F, Router
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery

from bot.checko_api import CheckoAPI, CheckoAPIError
from bot.database.db import Database
from bot.formatters import (
    format_arbitration,
    format_bankruptcy,
    format_company,
    format_contracts,
    format_enforcements,
    format_entrepreneur,
    format_financial,
    format_history,
    format_inspections,
)
from bot.handlers.search import SearchState
from bot.keyboards import (
    back_to_company_keyboard,
    cancel_keyboard,
    company_detail_keyboard,
    main_menu_keyboard,
)

router = Router(name="callbacks")

_DETAIL_FORMATTERS = {
    "company": format_company,
    "financial": format_financial,
    "arbitration": format_arbitration,
    "enforcements": format_enforcements,
    "contracts": format_contracts,
    "inspections": format_inspections,
    "bankruptcy": format_bankruptcy,
    "history": format_history,
}

_DETAIL_FETCHERS = {
    "company": "get_company",
    "financial": "get_financial",
    "arbitration": "get_arbitration",
    "enforcements": "get_enforcements",
    "contracts": "get_contracts",
    "inspections": "get_inspections",
    "bankruptcy": "get_bankruptcy",
    "history": "get_history",
}


@router.callback_query(F.data == "menu")
async def cb_menu(call: CallbackQuery, state: FSMContext) -> None:
    """Return to main menu."""
    await state.clear()
    await call.message.edit_text(
        "🏠 Главное меню. Выберите действие:",
        reply_markup=main_menu_keyboard(),
    )
    await call.answer()


@router.callback_query(F.data == "help")
async def cb_help(call: CallbackQuery) -> None:
    """Show help text."""
    help_text = (
        "ℹ️ <b>Как пользоваться ботом</b>\n\n"
        "• <b>Поиск по ИНН</b> — введите 10-значный ИНН компании "
        "или 12-значный ИНН ИП / физлица.\n"
        "• <b>Поиск по названию</b> — введите название компании или ИП.\n"
        "• <b>История запросов</b> — последние 10 ваших запросов.\n\n"
        "После получения карточки вы можете изучить разделы:\n"
        "финансы, арбитраж, госконтракты, проверки, банкротство и др."
    )
    await call.message.edit_text(help_text, reply_markup=main_menu_keyboard())
    await call.answer()


@router.callback_query(F.data == "history")
async def cb_history(call: CallbackQuery, db: Database) -> None:
    """Show user search history."""
    user_id = call.from_user.id
    rows = await db.get_user_history(user_id)
    if not rows:
        text = "📋 <b>История запросов</b>\n\nВы ещё ничего не искали."
    else:
        lines = ["📋 <b>История запросов</b>\n"]
        for row in rows:
            inn_part = f" (ИНН: {html.escape(row['inn'])})" if row["inn"] else ""
            lines.append(
                f"• {html.escape(row['query'])}{inn_part} — <i>{html.escape(str(row['searched_at']))}</i>"
            )
        text = "\n".join(lines)
    await call.message.edit_text(text, reply_markup=main_menu_keyboard())
    await call.answer()


@router.callback_query(F.data == "search:inn")
async def cb_search_inn(call: CallbackQuery, state: FSMContext) -> None:
    """Prompt user to enter INN."""
    await state.set_state(SearchState.waiting_for_inn)
    await call.message.edit_text(
        "🔍 Введите ИНН:\n"
        "• 10 цифр — для юридического лица\n"
        "• 12 цифр — для ИП или физического лица",
        reply_markup=cancel_keyboard(),
    )
    await call.answer()


@router.callback_query(F.data == "search:name")
async def cb_search_name(call: CallbackQuery, state: FSMContext) -> None:
    """Prompt user to enter a company name."""
    await state.set_state(SearchState.waiting_for_name)
    await call.message.edit_text(
        "🔎 Введите название компании или ИП для поиска:",
        reply_markup=cancel_keyboard(),
    )
    await call.answer()


@router.callback_query(F.data.startswith("select:"))
async def cb_select_entity(
    call: CallbackQuery, db: Database, checko_api: CheckoAPI
) -> None:
    """Handle selection of a search result."""
    _, entity_type, inn = call.data.split(":", 2)
    user_id = call.from_user.id
    await db.add_search(user_id=user_id, query=inn, inn=inn, entity_type=entity_type)

    await call.message.edit_text("🔄 Загружаю данные…")

    try:
        if entity_type == "entrepreneur":
            data = await checko_api.get_entrepreneur(inn)
            text = format_entrepreneur(data)
        else:
            data = await checko_api.get_company(inn)
            text = format_company(data)
        await call.message.edit_text(text, reply_markup=company_detail_keyboard(inn))
    except CheckoAPIError as exc:
        await call.message.edit_text(
            f"⚠️ Ошибка:\n<i>{html.escape(str(exc))}</i>",
            reply_markup=cancel_keyboard(),
        )
    await call.answer()


@router.callback_query(F.data.startswith("detail:"))
async def cb_detail(call: CallbackQuery, checko_api: CheckoAPI) -> None:
    """Fetch and display a detail section for a company / IP."""
    parts = call.data.split(":", 2)
    if len(parts) != 3:
        await call.answer("Неверный запрос.", show_alert=True)
        return

    _, inn, section = parts

    fetcher_name = _DETAIL_FETCHERS.get(section)
    formatter = _DETAIL_FORMATTERS.get(section)

    # For the "company" base section, use the entrepreneur fetcher when INN
    # has 12 digits (individual entrepreneur rather than a legal entity).
    if section == "company" and len(inn) == 12:
        fetcher_name = "get_entrepreneur"
        formatter = format_entrepreneur

    if not fetcher_name or not formatter:
        await call.answer("Неизвестный раздел.", show_alert=True)
        return

    await call.message.edit_text("🔄 Загружаю…")

    try:
        fetcher = getattr(checko_api, fetcher_name)
        data = await fetcher(inn)
        text = formatter(data)
        await call.message.edit_text(
            text, reply_markup=back_to_company_keyboard(inn)
        )
    except CheckoAPIError as exc:
        await call.message.edit_text(
            f"⚠️ Ошибка при загрузке раздела «{html.escape(section)}»:\n<i>{html.escape(str(exc))}</i>",
            reply_markup=back_to_company_keyboard(inn),
        )
    await call.answer()
