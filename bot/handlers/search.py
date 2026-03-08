import html
import re

from aiogram import F, Router
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import Message

from bot.checko_api import CheckoAPI, CheckoAPIError
from bot.database.db import Database
from bot.formatters import format_company, format_entrepreneur, format_person, format_search_results
from bot.keyboards import (
    back_to_company_keyboard,
    cancel_keyboard,
    company_detail_keyboard,
    search_results_keyboard,
)

router = Router(name="search")

INN_RE = re.compile(r"^\d{10}$|^\d{12}$")


class SearchState(StatesGroup):
    waiting_for_inn = State()
    waiting_for_name = State()


@router.message(SearchState.waiting_for_inn)
async def handle_inn_input(
    message: Message, state: FSMContext, db: Database, checko_api: CheckoAPI
) -> None:
    """Process INN entered by the user."""
    inn = (message.text or "").strip()

    if not INN_RE.match(inn):
        await message.answer(
            "❌ Неверный формат ИНН.\n"
            "ИНН компании — 10 цифр, ИНН физлица / ИП — 12 цифр.\n"
            "Попробуйте ещё раз или нажмите «Отмена».",
            reply_markup=cancel_keyboard(),
        )
        return

    await state.clear()
    user = message.from_user
    if user:
        await db.add_search(user_id=user.id, query=inn, inn=inn)

    await message.answer("🔄 Ищу информацию…")

    try:
        if len(inn) == 10:
            data = await checko_api.get_company(inn)
            text = format_company(data)
            await message.answer(
                text,
                reply_markup=company_detail_keyboard(inn),
            )
        else:
            # 12-digit INN — could be an individual entrepreneur or a person
            try:
                data = await checko_api.get_entrepreneur(inn)
                text = format_entrepreneur(data)
                await message.answer(
                    text,
                    reply_markup=company_detail_keyboard(inn),
                )
            except CheckoAPIError:
                data = await checko_api.get_person(inn)
                text = format_person(data)
                await message.answer(text, reply_markup=back_to_company_keyboard(inn))
    except CheckoAPIError as exc:
        await message.answer(
            f"⚠️ Ошибка при получении данных:\n<i>{html.escape(str(exc))}</i>\n\n"
            "Проверьте правильность ИНН и попробуйте снова.",
            reply_markup=cancel_keyboard(),
        )


@router.message(SearchState.waiting_for_name)
async def handle_name_input(
    message: Message, state: FSMContext, db: Database, checko_api: CheckoAPI
) -> None:
    """Process company name entered by the user."""
    query = (message.text or "").strip()

    if len(query) < 3:
        await message.answer(
            "❌ Запрос слишком короткий (минимум 3 символа). Попробуйте ещё раз.",
            reply_markup=cancel_keyboard(),
        )
        return

    await state.clear()
    user = message.from_user
    if user:
        await db.add_search(user_id=user.id, query=query)

    await message.answer("🔄 Ищу…")

    try:
        data = await checko_api.search(query)
        items = data if isinstance(data, list) else data.get("data", [])
        text = format_search_results(items)
        if items:
            await message.answer(
                text,
                reply_markup=search_results_keyboard(items),
            )
        else:
            await message.answer(text, reply_markup=cancel_keyboard())
    except CheckoAPIError as exc:
        await message.answer(
            f"⚠️ Ошибка при поиске:\n<i>{html.escape(str(exc))}</i>",
            reply_markup=cancel_keyboard(),
        )
