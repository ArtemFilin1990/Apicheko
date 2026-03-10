---
name: telegram-bot-aiogram-implementer
description: "Implement Telegram bots on aiogram 3 end-to-end: bootstrap, Dispatcher and Router wiring, handlers, filters, FSM, reply and inline keyboards, typed callback_data, /start flow, menu navigation, admin paths, and production-oriented module layout. Use when Codex needs to build, scaffold, refactor, debug, or review a Telegram bot specifically in aiogram 3, especially for /start, callback queries, menus, stateful forms, deep links, polling or webhook setup, or converting a Telegram bot spec into runnable Python code."
---

# Telegram Bot Aiogram Implementer

## Quick Start

- Assume `aiogram 3.x` unless the repository pins another version.
- Verify version-sensitive API details against the current official `aiogram` docs before writing framework-specific code.
- Read `references/project-layout.md` when creating or restructuring a bot project.
- Read `references/start-and-menu-templates.md` when implementing `/start`, deep links, home menu, or top-level navigation.
- Read `references/callback-schema.md` when implementing inline keyboards, `callback_data`, or edit-in-place navigation.
- Read `references/fsm-and-handlers.md` when implementing multistep forms, `StatesGroup`, validation loops, or router boundaries.
- If the user is still inventing bot concept, UX, or flows, use `$telegram-bot-designer` first and return to this skill after the behavior is fixed.

## Workflow

1. Lock the runtime contract.
   - Confirm `aiogram 3`, transport mode (`polling` or `webhook`), storage choice, and config source.
   - Confirm whether the bot works in private chats only or also in groups and channels.
2. Shape the project before writing handlers.
   - Split `routers`, `keyboards`, `callbacks`, `states`, `services`, and `config` early if the bot has more than one flow.
   - Keep business logic outside Telegram handlers.
3. Implement entrypoints first.
   - Cover `/start`, optional deep link payload, returning-user branch, and one stable home action.
   - Add `/help`, `/cancel`, and admin entrypoints when relevant.
4. Implement menu mechanics.
   - Use inline keyboards for local step actions and edit-in-place flows.
   - Use reply keyboards only for persistent top-level navigation or constrained answer sets.
5. Implement callback and state contracts.
   - Prefer typed `CallbackData` classes for callbacks that branch by entity or action.
   - Use `FSM` only when data must survive across multiple turns.
6. Wire the dispatcher deliberately.
   - Register domain routers explicitly.
   - Keep admin or moderation routers separate from user routers.
7. Add failure and recovery paths.
   - Handle stale callbacks, repeated taps, unexpected text, `/cancel`, restart from `/start`, and missing permissions.
8. Deliver code with operational notes.
   - Include file map, environment variables, transport assumptions, and the exact place for storage, middleware, and service injection.

## Implementation Rules

- Prefer one `Router` per domain or flow instead of one giant `handlers.py`.
- Use explicit filters such as `CommandStart()`, `Command("help")`, and `F.data`.
- Prefer typed `CallbackData` over raw callback strings when callbacks need parsing or filtering.
- Keep callback payloads compact and stable. Telegram limits `callback_data` to `1-64 bytes`.
- Use keyboard builders for dynamic layouts. For static two or three button menus, explicit markup is acceptable.
- Keep `message.answer()` and `callback.message.edit_text()` decisions explicit. Do not mix send-vs-edit behavior randomly.
- Use `FSM` for cross-message state, not as a substitute for ordinary branching.
- Keep validation close to the handler that collects the field, but move storage and side effects into services.
- Define one canonical home screen and one canonical recovery command.
- Treat `/start` as a real entry contract, not as a placeholder greeting.
- When patching an existing repo, preserve its router structure and naming unless the current layout is blocking correctness.

## Output Modes

- For scaffolding: return file tree, bootstrap files, routers, keyboards, callbacks, and run command.
- For incremental implementation: patch only the requested flow and keep the diff narrow.
- For review: list correctness, callback contract, FSM misuse, and router-boundary issues first.
- For migration: map old patterns to `aiogram 3` primitives and show the minimum safe rewrite.

## Default Deliverable

Use this structure unless the user asks for another format:

1. Runtime assumptions
2. File layout
3. `/start` and home menu
4. Callback schema
5. Routers and handlers
6. FSM or form flow
7. Config and bootstrap
8. Validation and recovery paths
9. Exact run or test command
