# Telegram Bot Flow Patterns

## Interaction Model Selection

Choose one primary model and keep secondary models minimal.

- Command-first
  - Use for admin bots, group bots, and expert workflows.
  - Strength: explicit and predictable.
  - Risk: discoverability is poor for casual users.
- Inline-menu
  - Use for most guided bots in private chat.
  - Strength: strong control over branching and validation.
  - Risk: over-editing messages can hide history if done carelessly.
- Reply-keyboard home
  - Use when the bot behaves like a persistent control panel.
  - Strength: fast top-level navigation.
  - Risk: clutter and reduced context if overused.
- Web App assisted
  - Use when the user must browse catalogs, fill forms, or manipulate structured data.
  - Strength: richer UI and input fidelity.
  - Risk: more implementation surface and more transition points.

## State Naming

Prefer stable, readable state IDs:

- `home`
- `lead.capture_contact`
- `booking.pick_date`
- `support.await_message`
- `admin.review_queue`

Use dotted namespaces when the flow has multiple branches.

## Callback Schema

Use short, versioned, parseable payloads.

Recommended pattern:

`<version>:<flow>:<action>:<entity>`

Examples:

- `v1:home:open:pricing`
- `v1:booking:pick:slot42`
- `v1:ticket:close:9012`

Rules:

- Keep payloads short.
- Never depend on visible button text for server-side routing.
- Do not encode sensitive data directly in callbacks.
- If the entity is large or composite, store it server-side and pass a short token.

## Step Template

Use this template when handing off a flow:

- State ID
- Entry trigger
- Bot objective
- Expected user action
- Bot text or media
- Keyboard layout
- Validation rules
- Success transition
- Failure or retry behavior
- Edit-vs-send decision

## Common Flow Shapes

### Guided Funnel

Use for onboarding, lead capture, booking, or surveys.

- Start with value proposition
- Show one dominant CTA
- Collect one field per step unless fields are tightly coupled
- Confirm the captured result before final submission

### Support Triage

Use for FAQ and operator escalation.

- Triage intent with 3-6 clear categories
- Resolve obvious cases with self-service content
- Escalate ambiguous or urgent cases to human review
- Preserve transcript or summary for the operator

### Admin Queue

Use for moderation, approvals, or CRM follow-up.

- Present compact record summary
- Offer explicit actions: approve, reject, assign, snooze, open details
- Require confirmation for destructive actions
- Log actor, time, and target entity

### Content Bot

Use for digest, alerts, and subscription products.

- Separate browse flow from subscription settings
- Let users tune frequency and categories
- Make mute and unsubscribe easy to find
- Avoid mixing broadcast controls into the main user menu

### Companion Loop

Use for recurring, personality-driven bots.

- Give the bot a stable role, not random mood swings
- Make the first screen immediately legible even if the tone is playful
- Tie every recurring interaction to a concrete user payoff
- Keep fallbacks blunt and clear when the bot stops joking and starts helping

### Quest Loop

Use for engagement, onboarding, learning, or communities.

- Break the journey into short missions
- Show visible progress after each step
- Offer one next mission, not a huge mission list
- Add streaks or rewards only if they unlock real capability or access

## Handoff Format

When the user asks for a full spec, return:

1. Bot goal
2. Personas
3. Entry points
4. Flow-by-flow state table
5. Keyboard layouts
6. Callback schema
7. Validation rules
8. Admin and operator actions
9. Failure handling
10. Telemetry and rollout notes
