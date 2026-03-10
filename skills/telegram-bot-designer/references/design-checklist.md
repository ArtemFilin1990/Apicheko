# Telegram Bot Design Checklist

## Discovery Inputs

Capture these before locking the flow:

- Bot objective: acquisition, support, booking, moderation, content delivery, CRM updates, or commerce
- Primary users: end users, admins, moderators, operators, partners
- Chat context: private chat, group, channel, inline mode, or Web App companion
- Main success event: what the user should finish in one session
- Frequency: one-off task, recurring utility, or always-on assistant
- Human role: no human, human fallback, approval gate, or full operator takeover
- Data sensitivity: public data, contact data, payments, internal operations, or regulated information
- Localization: single language or multilingual
- Distinctive angle: what makes this bot recognizable instead of interchangeable
- Return trigger: why the user reopens the bot tomorrow or next week
- Share trigger: what outcome, artifact, or mechanic is forwardable to another user

## Telegram-Specific Checks

- Define `/start` behavior for both first-time and returning users.
- Decide whether deep links are needed for campaign attribution, referral routing, or direct entry into a flow.
- Decide whether reply keyboards are truly necessary. Inline keyboards are usually easier to control and revoke.
- Keep the home screen stable. Do not make users guess how to restart the flow.
- Define what happens when a user types arbitrary text while the bot expects a button tap.
- Define behavior in groups separately from private chats; group bots usually need stricter command-driven behavior.
- Define permissions for admin actions, moderation actions, and content publishing.
- Define whether message editing is allowed or whether auditability requires new messages.
- Define media strategy: text only, photos, files, voice notes, or video notes.
- Define notification rules, throttling, and unsubscribe paths.

## Acceptance Checklist

Approve the design only if all answers are clear:

- Can a new user understand the bot's value from the first message?
- Does each flow have an obvious next action?
- Is there a clear cancel, back, or restart path?
- Are error messages actionable instead of generic?
- Are admin flows separated from end-user flows?
- Can the bot recover from stale callbacks, repeated taps, or interrupted sessions?
- Are storage and analytics requirements explicit?
- Is the handoff specific enough that an engineer can implement it without inventing missing behavior?
- Is there one memorable mechanic or tone choice that makes the bot feel intentional?
- Does the creative layer improve the utility instead of distracting from it?

## Review Heuristics

Flag the design if any of these appear:

- Too many top-level buttons on one screen
- Hidden core actions that require memorizing commands
- Long free-text branches without validation rules
- No operator path for high-risk or low-confidence cases
- No re-entry path after the user disappears and returns later
- Callback payloads that depend on verbose JSON or unstable labels
- Group-chat behavior copied blindly from private-chat behavior
