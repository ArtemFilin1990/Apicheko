# Callback Schema For Aiogram

## When To Read This File

- Read this file when implementing inline keyboards or callback-query handlers.
- Read this file when the bot needs stable routing between button taps and backend actions.

## Preferred Pattern

Prefer typed `CallbackData` classes over ad hoc string concatenation when callbacks have structure:

```python
from aiogram.filters.callback_data import CallbackData


class MenuAction(CallbackData, prefix="menu"):
    section: str
    page: int = 1
```

Then use it in markup and filters:

```python
from aiogram import F, Router
from aiogram.types import CallbackQuery, InlineKeyboardButton

router = Router(name="menu_callbacks")


@router.callback_query(MenuAction.filter(F.section == "catalog"))
async def open_catalog(callback: CallbackQuery, callback_data: MenuAction) -> None:
    await callback.answer()
    await callback.message.edit_text(f"Catalog page {callback_data.page}")


def catalog_button() -> InlineKeyboardButton:
    return InlineKeyboardButton(
        text="Catalog",
        callback_data=MenuAction(section="catalog", page=1).pack(),
    )
```

## Schema Rules

- Use one callback class per flow or bounded context.
- Keep prefixes short and distinct, for example `menu`, `ord`, `adm`.
- Keep fields compact. Telegram allows `callback_data` only in the `1-64 bytes` range.
- Put large identifiers or composite payloads in storage and pass only a short key in the callback.
- Never depend on visible button text for routing.

## Raw String Fallback

If the callback is truly static and never parsed, a raw string is acceptable:

```python
InlineKeyboardButton(text="Back", callback_data="menu:back")
```

Use raw strings only when:

- the callback has no payload
- the handler count is tiny
- typed filtering would add more noise than value

## Naming Pattern

Use a predictable action contract:

- `menu:<section>`
- `menu:<section>:<page>`
- `ord:<action>:<id>`
- `adm:<action>:<entity>`

If callback volume grows, migrate the flow to `CallbackData` rather than inventing longer string parsing.

## Callback Handler Rules

- Always call `await callback.answer()` unless the repository already centralizes it safely.
- Validate entity ownership or permissions before editing or mutating data.
- Treat stale callbacks as a normal case and return a recovery message or rebuilt menu.
- Keep edit-vs-send behavior consistent inside one flow.
