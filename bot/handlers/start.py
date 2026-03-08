import html

from aiogram import Router
from aiogram.filters import Command, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.types import Message

from bot.database.db import Database
from bot.keyboards import main_menu_keyboard

router = Router(name="start")


@router.message(CommandStart())
async def cmd_start(message: Message, db: Database) -> None:
    """Handle /start command: register user and show main menu."""
    user = message.from_user
    if user:
        await db.upsert_user(
            user_id=user.id,
            username=user.username,
            first_name=user.first_name,
            last_name=user.last_name,
        )

    name = html.escape(user.first_name) if user else "пользователь"
    await message.answer(
        f"👋 Привет, <b>{name}</b>!\n\n"
        "Я помогу вам найти информацию о компаниях и предпринимателях "
        "из открытых реестров (ФНС, ЕГРЮЛ, ЕГРИП, ЕФРСБ и др.).\n\n"
        "Выберите действие:",
        reply_markup=main_menu_keyboard(),
    )


@router.message(Command("cancel"))
async def cmd_cancel(message: Message, state: FSMContext) -> None:
    """Handle /cancel command: clear any active state and return to main menu."""
    await state.clear()
    await message.answer(
        "❌ Действие отменено. Вы в главном меню.",
        reply_markup=main_menu_keyboard(),
    )
