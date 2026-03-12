import html
import re

from aiogram import Router
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import Message

from bot.formatters import format_bank, format_company, format_entrepreneur, format_person, format_search_results
from bot.keyboards import (
    cancel_keyboard,
    company_detail_keyboard,
    person_or_entrepreneur_keyboard,
    search_results_keyboard,
)
from services.checko_api import CheckoAPI, CheckoAPIError
from storage.database import Database
from utils.checko_payload import extract_search_results

router = Router(name="search")

IDENTIFIER_RE = re.compile(r"^\d{9}$|^\d{10}$|^\d{12}$|^\d{13}$|^\d{15}$")


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
            "Поддерживаются: ИНН 10/12, ОГРН 13, ОГРНИП 15, БИК 9 цифр.\n"
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
        if len(identifier) == 9:
            data = await checko_api.get_bank(bic=identifier)
            text = format_bank(data)
            await message.answer(text, reply_markup=cancel_keyboard())
        elif len(identifier) == 10:
            data = await checko_api.get_company(inn=identifier)
            text = format_company(data)
            await message.answer(text, reply_markup=company_detail_keyboard(identifier))
        elif len(identifier) == 12:
            await message.answer(
                "ИНН из 12 цифр может принадлежать ИП или физическому лицу.\nВыберите тип проверки:",
                reply_markup=person_or_entrepreneur_keyboard(identifier),
            )
        elif len(identifier) == 13:
            data = await checko_api.get_company(ogrn=identifier)
            text = format_company(data)
            inn = (data.get("data") or data).get("ИНН", identifier)
            await message.answer(text, reply_markup=company_detail_keyboard(inn))
        elif len(identifier) == 15:
            data = await checko_api.get_entrepreneur(ogrnip=identifier)
            text = format_entrepreneur(data)
            inn = (data.get("data") or data).get("ИНН", identifier)
            await message.answer(text, reply_markup=company_detail_keyboard(inn))
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
        items = extract_search_results(data)
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
