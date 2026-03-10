---
name: telegram-bot-designer
description: "Design Telegram bots end-to-end: product framing, creative bot concepts, commands, dialog trees, inline and reply keyboards, callback payload schemes, state machines, onboarding, admin flows, moderation, engagement loops, bot personality, and implementation-ready specs. Use when Codex needs to invent, plan, review, or refine a Telegram bot, bot UX, message flow, command map, callback_data contract, deep-link entrypoint, menu structure, viral or gamified mechanic, or a build handoff spec before implementation in aiogram, python-telegram-bot, pyTelegramBotAPI, Node.js, Java, or another Telegram Bot API stack."
---

# Telegram Bot Designer

## Quick Start

- Start by fixing five inputs: `goal`, `primary user`, `chat context`, `core action`, and `operator involvement`.
- Read `references/design-checklist.md` when the request is vague, product-heavy, or needs discovery questions and acceptance checks.
- Read `references/flow-patterns.md` when designing message flows, keyboards, callback schemas, admin paths, or build handoff artifacts.
- Read `references/creative-patterns.md` when the bot should feel memorable, sticky, character-driven, content-led, or referral-friendly.
- Default to a framework-agnostic bot spec first. Bind the design to a specific Telegram library only after the interaction model is stable.

## Workflow

1. Define the operating context.
   - Clarify private chat vs group vs channel support.
   - Clarify whether the bot is fully automated, operator-assisted, or mostly a launcher for a Web App.
   - Clarify the critical success event: lead captured, booking made, payment completed, ticket routed, content delivered, or moderation action taken.
2. Choose the creative angle before designing screens.
   - Define the bot archetype: concierge, operator, coach, scout, curator, companion, seller, moderator, or game master.
   - Define the memorable mechanic: daily drop, streak, quest, collectible, referral unlock, progress map, adaptive persona, or expert shortcut.
   - Define the voice: sharp, premium, deadpan, playful, mentor-like, or operational.
   - If the task is exploratory, produce 3 distinct concepts before choosing one.
3. Choose the primary interaction model.
   - Use commands for explicit entrypoints and power-user shortcuts.
   - Use inline keyboards for guided, message-local actions.
   - Use reply keyboards only for persistent top-level navigation or tightly constrained answer sets.
   - Use free text only when the user gains clear value from typing.
4. Map the conversation.
   - List all entrypoints: `/start`, deep links, forwarded posts, inline mode, admin commands, and re-entry after interruption.
   - Define states, transitions, back/cancel behavior, timeout behavior, and what happens after success.
5. Specify each step.
   - For every state, define trigger, user goal, bot copy, variables, keyboard, validation rules, and success/failure behavior.
   - Decide whether the bot edits the current message or sends a new one.
6. Design the technical handoff.
   - Define command names, callback payload format, state IDs, storage requirements, analytics events, moderation hooks, and operator escalation points.
   - Keep callback payloads compact and stable. If payload growth is likely, encode short identifiers and resolve server-side.
7. Stress-test the design.
   - Check duplicate taps, invalid text, expired actions, missing permissions, blocked bot, restarted chat, partial completion, and operator takeover.
   - Also check whether the creative mechanic survives repetition and still feels useful after day 1.
8. Deliver the output in implementation-ready form.
   - Prefer a compact spec with a command map, state table, keyboard scheme, edge cases, and rollout notes.

## Design Rules

- Optimize for fast mobile interaction and obvious next actions.
- Add distinctiveness on purpose. The bot should have a recognizable point of view, not just correct buttons.
- Prefer shallow flows over long conversational trees unless the task truly needs branching.
- Make every button action-specific. Avoid vague labels such as `Next`, `More`, or `Continue` when a concrete verb fits.
- Separate user flows, admin flows, and support/operator flows.
- Define one canonical home state and one canonical recovery path.
- Design for idempotency: repeated taps, retries, and duplicate deliveries must not create confusing user outcomes.
- Prefer one strong signature mechanic over many weak gimmicks.
- If adding gamification, tie it to real value. Do not add streaks, points, or rewards that do not change user outcomes.
- If adding bot personality, keep it consistent across onboarding, errors, reminders, and operator handoff.
- If the bot sends notifications or reminders, define opt-in, opt-out, and quiet-hours behavior explicitly.
- If the bot handles payments, identity, or sensitive data, define verification boundaries, storage minimization, and human escalation before writing copy.
- If the request includes code generation, keep the design spec first and treat code as a second step.

## Output Modes

- For early discovery: return concept, assumptions, open questions, and one recommended flow.
- For creative exploration: return 3 differentiated bot concepts with archetype, mechanic, sample `/start`, and why one of them should be chosen.
- For product design: return user journeys, state map, message examples, and risk notes.
- For implementation handoff: return commands, state table, callback schema, keyboard map, storage notes, and failure handling.
- For reviews: list UX and logic problems first, then recommended changes.

## Default Deliverable

Use this structure unless the user asks for a different format:

1. Goal and success event
2. Users and chat contexts
3. Bot archetype and voice
4. Signature mechanic
5. Entry points
6. Command map
7. Main flows
8. State table
9. Keyboard and callback scheme
10. Validation and recovery paths
11. Admin and operator flows
12. Implementation notes
