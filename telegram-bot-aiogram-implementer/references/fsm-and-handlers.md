# FSM And Handler Patterns

## When To Read This File

- Read this file when implementing multistep forms, wizards, or stateful data capture.
- Read this file when the user mentions `FSM`, `StatesGroup`, step forms, validation, or back and cancel logic.

## State Declaration

Declare states in a dedicated module:

```python
from aiogram.fsm.state import State, StatesGroup


class LeadForm(StatesGroup):
    name = State()
    phone = State()
    note = State()
```

## Form Router Template

Keep one router per stateful flow:

```python
from aiogram import F, Router
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.types import Message

from bot.states.lead import LeadForm

router = Router(name="lead_form")


@router.message(Command("lead"))
async def start_lead(message: Message, state: FSMContext) -> None:
    await state.set_state(LeadForm.name)
    await message.answer("Enter your name.")


@router.message(LeadForm.name)
async def collect_name(message: Message, state: FSMContext) -> None:
    await state.update_data(name=message.text.strip())
    await state.set_state(LeadForm.phone)
    await message.answer("Enter your phone number.")
```

## Validation Rule

Validate at each step before advancing:

```python
@router.message(LeadForm.phone)
async def collect_phone(message: Message, state: FSMContext) -> None:
    phone = (message.text or "").strip()
    if not phone.startswith("+"):
        await message.answer("Send the phone in international format, for example +79990000000.")
        return

    await state.update_data(phone=phone)
    await state.set_state(LeadForm.note)
    await message.answer("Add a note or send '-' to skip.")
```

## Finish And Clear

Always clear terminal states explicitly:

```python
@router.message(LeadForm.note)
async def collect_note(message: Message, state: FSMContext, lead_service: LeadService) -> None:
    data = await state.get_data()
    note = None if message.text == "-" else message.text

    await lead_service.create_lead(
        name=data["name"],
        phone=data["phone"],
        note=note,
    )

    await state.clear()
    await message.answer("Lead saved.")
```

## Cancel Pattern

Provide a universal cancel path:

```python
@router.message(Command("cancel"))
async def cancel_flow(message: Message, state: FSMContext) -> None:
    await state.clear()
    await message.answer("Current action canceled.")
```

If the bot uses reply keyboards, make the cancel action visible there too.

## Handler Boundary Rules

- Keep handlers thin. Read input, validate it, call service, respond.
- Do not put persistence code directly into state handlers if the same action may be reused elsewhere.
- Keep admin FSM flows separate from user flows.
- Avoid one router that handles every state in the project.

## When Not To Use FSM

Do not introduce FSM if:

- the entire action is one message and one response
- callback query payload already contains enough context
- the repository already uses plain service calls and the new flow is stateless

Prefer ordinary handlers for single-step commands, confirmations, and read-only menus.
