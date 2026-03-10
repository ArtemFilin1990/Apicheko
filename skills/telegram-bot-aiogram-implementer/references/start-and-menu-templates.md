# /start And Menu Templates

## When To Read This File

- Read this file when implementing `/start`, deep links, first-run onboarding, or home menu behavior.
- Read this file when the user asks for "template `/start`", "main menu", "home screen", or "reply keyboard".

## `/start` Template

Use `CommandStart()` for the first entrypoint:

```python
from aiogram import Router
from aiogram.filters import CommandStart
from aiogram.types import Message

from bot.keyboards.reply import home_keyboard

router = Router(name="start")


@router.message(CommandStart())
async def command_start(message: Message) -> None:
    await message.answer(
        "Choose an action from the main menu.",
        reply_markup=home_keyboard(),
    )
```

## Returning User Branch

Branch `/start` if the bot has onboarding or role-specific home states:

```python
@router.message(CommandStart())
async def command_start(message: Message, user_service: UserService) -> None:
    user = await user_service.get_or_create(message.from_user.id)

    if user.is_new:
        await message.answer("Welcome. Let me set you up.")
        return

    await message.answer("Welcome back.", reply_markup=home_keyboard())
```

## Deep Link Branch

If campaigns, referrals, or direct flow entry matter, parse the deep link payload inside `/start` and route early. Keep the payload short and versionable.

Recommended branches:

- `ref_<code>` for referrals
- `flow_<slug>` for direct entry into a feature
- `admin_<token>` only if short-lived and verified server-side

Do not encode sensitive information directly into the deep link.

## Reply Keyboard Home Template

Use reply keyboards only for persistent top-level navigation:

```python
from aiogram.types import KeyboardButton, ReplyKeyboardMarkup


def home_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="Catalog"), KeyboardButton(text="My orders")],
            [KeyboardButton(text="Support")],
        ],
        resize_keyboard=True,
        input_field_placeholder="Choose an action",
    )
```

Use this pattern when:

- the bot acts like a control panel
- the user repeatedly returns to the same three to five top-level actions

Avoid it when:

- the flow is mostly inline and step-local
- the keyboard would be noisy in a group chat

## Inline Home Menu Template

Prefer inline keyboards for guided in-message navigation:

```python
from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup


def home_inline() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="Catalog", callback_data="menu:catalog")],
            [InlineKeyboardButton(text="Support", callback_data="menu:support")],
        ]
    )
```

## Menu Handler Pattern

For reply keyboard text, normalize the entrypoint and redirect to one flow owner:

```python
from aiogram import F, Router
from aiogram.types import Message

router = Router(name="menu")


@router.message(F.text == "Catalog")
async def open_catalog(message: Message) -> None:
    await message.answer("Catalog opened.")
```

Do not scatter the same button label across multiple handlers.

## Send Vs Edit Rule

- Use `message.answer()` for new flow steps, confirmations, and history-preserving actions.
- Use `callback.message.edit_text()` for inline menus where the user is clearly staying in the same context.
- After handling a callback, answer it explicitly to stop the Telegram loading state.
