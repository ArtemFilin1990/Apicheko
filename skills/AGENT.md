# Skills workspace conventions

This directory contains reusable skill/agent packs only.

## Expected minimum layout per skill
- `SKILL.md` (required)
- `agents/` (provider prompts/config)
- `references/` (task-specific docs)
- optional `scripts/`, `assets/`, `data/`, `tests/`

## Classification policy
- Keep production runtime code out of `skills/`.
- Use these packs as implementation guidance and tooling helpers.
- If a pack has unclear ownership or no practical use, move it to `review_needed/` instead of deleting.
