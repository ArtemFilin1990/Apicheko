import html
import re

from aiogram import Router
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
    person_or_entrepreneur_keyboard,
    search_results_keyboard,
)

router = Router(name="search")

IDENTIFIER_RE = re.compile(r"^\d{10}$|^\d{12}$|^\d{13}$|^\d{15}$")


class SearchState(StatesGroup):
    waiting_for_inn = State()
    waiting_for_name = State()


@router.message(SearchState.waiting_for_inn)
async def handle_inn_input(
    message: Message, state: FSMContext, db: Database, checko_api: CheckoAPI
) -> None:
    """Process INN/OGRN/OGRNIP entered by the user."""
    identifier = (message.text or "").strip()

    if not IDENTIFIER_RE.match(identifier):
        await message.answer(
            "❌ Неверный формат идентификатора.\n"
            "Поддерживаются: ИНН 10/12, ОГРН 13, ОГРНИП 15 цифр.\n"
            "Попробуйте ещё раз или нажмите «Отмена».",
            reply_markup=cancel_keyboard(),
        )
        return

    await state.clear()
    user = message.from_user
    if user:
        await db.add_search(user_id=user.id, query=identifier, inn=identifier)

    await message.answer("🔄 Ищу информацию…")

    try:
        if len(identifier) == 10:
            data = await checko_api.get_company(inn=identifier)
            text = format_company(data)
            await message.answer(text, reply_markup=company_detail_keyboard(identifier))
            return

        if len(identifier) == 13:
            data = await checko_api.get_company(ogrn=identifier)
            text = format_company(data)
            await message.answer(text, reply_markup=company_detail_keyboard(identifier))
            return

        if len(identifier) == 15:
            data = await checko_api.get_entrepreneur(ogrnip=identifier)
            text = format_entrepreneur(data)
            await message.answer(text, reply_markup=company_detail_keyboard(identifier))
            return

        await message.answer(
            "Выберите режим проверки для 12-значного ИНН:",
            reply_markup=person_or_entrepreneur_keyboard(identifier),
        )
    except CheckoAPIError as exc:
        await message.answer(
            f"⚠️ Ошибка при получении данных:\n<i>{html.escape(str(exc))}</i>\n\n"
            "Проверьте правильность идентификатора и попробуйте снова.",
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
