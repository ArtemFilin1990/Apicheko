import html

from aiogram import F, Router
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery

from bot.cards import DETAIL_FETCHERS, build_detail_card
from bot.formatters import format_company, format_entrepreneur, format_person
from bot.handlers.search import SearchState
from bot.keyboards import cancel_keyboard, cemetery_detail_keyboard, cemetery_menu_keyboard, company_detail_keyboard, main_menu_keyboard
from services.checko_api import CheckoAPI, CheckoAPIError
from utils.checko_payload import extract_items
from storage.database import Database

router = Router(name="callbacks")

# Keep compatibility for tests importing internals from this module.
_DETAIL_FETCHERS = DETAIL_FETCHERS


@router.callback_query(F.data == "scenario:cemetery")
async def cb_open_cemetery(call: CallbackQuery, state: FSMContext) -> None:
    await state.clear()
    await call.message.edit_text(
        "Введите ИНН или выберите раздел проверки:",
        reply_markup=cemetery_menu_keyboard(),
    )
    await call.answer()


@router.callback_query(F.data.startswith("scenario:cemetery:"))
async def cb_open_cemetery_for_identifier(call: CallbackQuery, state: FSMContext) -> None:
    parts = call.data.split(":", 2)
    if len(parts) != 3:
        await call.answer("Неверный запрос", show_alert=True)
        return

    _, _, identifier = parts
    await state.clear()
    await call.message.edit_text(
        f"🪦 Сценарий проверки для <code>{html.escape(identifier)}</code>. Выберите раздел:",
        reply_markup=cemetery_detail_keyboard(identifier),
    )
    await call.answer()


async def calculate_risk_score(api: CheckoAPI, inn: str) -> tuple[int, str]:
    arbs = await api.get_arbitration(inn=inn)
    enfs = await api.get_enforcements(inn=inn)
    bnks = await api.get_bankruptcy(inn=inn)

    arbitration_count = len(extract_items(arbs, "Дела", "Записи", "cases", "items"))
    enforcements_count = len(extract_items(enfs, "ИП", "Записи", "items"))
    bankruptcy_count = len(extract_items(bnks, "Сообщения", "Записи", "messages", "items"))

    score = arbitration_count * 4 + bankruptcy_count * 10 + enforcements_count * 6
    if score >= 40:
        label = "🔴 Высокий риск"
    elif score > 0:
        label = "🟡 Средний риск"
    else:
        label = "🟢 Низкий риск"
    return score, label


@router.callback_query(F.data.startswith("cem:"))
async def cb_cemetery_detail(call: CallbackQuery, checko_api: CheckoAPI) -> None:
    parts = call.data.split(":", 2)
    if len(parts) < 2:
        await call.answer("Неверный запрос", show_alert=True)
        return

    _, section, *rest = parts
    if section in {"search_inn", "search_name"}:
        return

    if len(parts) != 3:
        await call.answer("Неверный запрос", show_alert=True)
        return

    identifier = rest[0]
    await call.message.edit_text("🔄 Загружаю…")

    try:
        if section == "risk":
            score, label = await calculate_risk_score(checko_api, identifier)
            text = (
                f"📊 <b>Итоговая оценка риска</b>\n"
                f"ИНН: <code>{html.escape(identifier)}</code>\n"
                f"Счёт: <b>{score}</b>\n"
                f"Статус: <b>{label}</b>"
            )
            markup = cemetery_detail_keyboard(identifier)
        else:
            if section not in _DETAIL_FETCHERS:
                await call.answer("Неизвестный раздел", show_alert=True)
                return
            text, _ = await build_detail_card(checko_api, identifier, section)
            markup = cemetery_detail_keyboard(identifier)

        await call.message.edit_text(text, reply_markup=markup)
    except CheckoAPIError as exc:
        await call.message.edit_text(
            f"⚠️ Ошибка при загрузке раздела «{html.escape(section)}»\n<i>{html.escape(str(exc))}</i>",
            reply_markup=cemetery_detail_keyboard(identifier),
        )
    await call.answer()


@router.callback_query(F.data == "menu")
async def cb_menu(call: CallbackQuery, state: FSMContext) -> None:
    await state.clear()
    await call.message.edit_text(
        "🏠 Главное меню. Выберите действие:",
        reply_markup=main_menu_keyboard(),
    )
    await call.answer()


@router.callback_query(F.data == "help")
async def cb_help(call: CallbackQuery) -> None:
    help_text = (
        "ℹ️ <b>Как пользоваться ботом</b>\n\n"
        "• <b>Поиск по идентификатору</b> — ИНН 10/12, ОГРН 13, ОГРНИП 15.\n"
        "• Для ИНН 12 бот предложит выбрать: <b>ИП</b> или <b>физлицо</b>.\n"
        "• Поиск по названию показывает список найденных компаний.\n"
        "• Для юрлиц доступны детальные разделы: финансы, арбитраж, ФССП и др.\n\n"
        "Если что-то не работает — попробуйте /start."
    )
    await call.message.edit_text(help_text, reply_markup=main_menu_keyboard())
    await call.answer()


@router.callback_query(F.data == "search:inn")
async def cb_search_inn(call: CallbackQuery, state: FSMContext) -> None:
    await state.set_state(SearchState.waiting_for_inn)
    await call.message.edit_text(
        "Введите ИНН (10/12), ОГРН (13) или ОГРНИП (15):",
        reply_markup=cancel_keyboard(),
    )
    await call.answer()


@router.callback_query(F.data == "search:name")
async def cb_search_name(call: CallbackQuery, state: FSMContext) -> None:
    await state.set_state(SearchState.waiting_for_name)
    await call.message.edit_text(
        "Введите название компании или ФИО ИП:",
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
            "📭 История запросов пуста.", reply_markup=main_menu_keyboard()
        )
        await call.answer()
        return

    lines = ["📋 <b>Последние запросы:</b>", ""]
    for row in rows:
        query = html.escape(str(row["query"]))
        created = html.escape(str(row["searched_at"]))
        lines.append(f"• {query} <i>({created})</i>")

    await call.message.edit_text("\n".join(lines), reply_markup=main_menu_keyboard())
    await call.answer()


@router.callback_query(F.data.startswith("resolve12:"))
async def cb_resolve_12digit(call: CallbackQuery, checko_api: CheckoAPI) -> None:
    parts = call.data.split(":", 2)
    if len(parts) != 3:
        await call.answer("Неверный запрос", show_alert=True)
        return

    _, mode, inn = parts

    await call.message.edit_text("🔄 Загружаю…")
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
            await call.answer("Неизвестный режим", show_alert=True)
            return

        await call.message.edit_text(text, reply_markup=markup)
    except CheckoAPIError as exc:
        await call.message.edit_text(
            f"⚠️ Ошибка при загрузке данных:\n<i>{html.escape(str(exc))}</i>",
            reply_markup=main_menu_keyboard(),
        )
    await call.answer()


@router.callback_query(F.data.startswith("select:"))
async def cb_select_search_result(call: CallbackQuery, checko_api: CheckoAPI) -> None:
    parts = call.data.split(":", 2)
    if len(parts) != 3:
        await call.answer("Неверный запрос", show_alert=True)
        return

    _, entity_type, identifier = parts

    await call.message.edit_text("🔄 Загружаю…")
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
            f"⚠️ Ошибка при загрузке карточки:\n<i>{html.escape(str(exc))}</i>",
            reply_markup=main_menu_keyboard(),
        )
    await call.answer()


@router.callback_query(F.data.startswith("detail:"))
async def cb_detail(call: CallbackQuery, checko_api: CheckoAPI) -> None:
    parts = call.data.split(":", 2)
    if len(parts) != 3:
        await call.answer("Неверный запрос.", show_alert=True)
        return

    _, identifier, section = parts

    if section not in _DETAIL_FETCHERS:
        if not (section == "company" and len(identifier) == 12):
            await call.answer("Неизвестный раздел.", show_alert=True)
            return

    await call.message.edit_text("🔄 Загружаю…")

    try:
        text, markup = await build_detail_card(checko_api, identifier, section)
        await call.message.edit_text(text, reply_markup=markup)
    except CheckoAPIError as exc:
        await call.message.edit_text(
            f"⚠️ Ошибка при загрузке раздела «{html.escape(section)}»:\n<i>{html.escape(str(exc))}</i>",
            reply_markup=cancel_keyboard(),
        )
    await call.answer()
