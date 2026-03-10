# Telegram MCP Setup Notes

Use this reference when the user wants to enable the underlying Telegram MCP server or when Telegram tools are missing.

## Prerequisites

- Python 3.10+
- `uv`
- Telegram account
- Telegram API credentials from `https://my.telegram.org`

## Upstream Flow

The upstream skill depends on [`telegram-mcp`](https://github.com/chigwell/telegram-mcp). Its repository documents this basic flow:

1. Clone the repository.
2. Install dependencies with `uv sync`.
3. Create a `.env` file with:
   - `TELEGRAM_API_ID`
   - `TELEGRAM_API_HASH`
   - `TELEGRAM_SESSION_NAME`
4. Generate a session string with `uv run python session_string_generator.py`.
5. Register the MCP server in the local agent environment so it runs the Telegram MCP entrypoint from that repository.

## Important Local Caution

The original upstream guide uses Claude Code specific registration commands. Do not assume the same CLI command exists in the current environment. Verify the local MCP registration mechanism before telling the user to run any agent-specific command.

## Session Handling

- Treat `TELEGRAM_SESSION_STRING` like a password.
- Never commit `.env` or session values.
- Prefer secure local secret storage when the platform supports it.

## Common Failures

### Entity not found

- Retry with the exact chat title.
- Retry with the username without `@`.
- For channels or supergroups, retry with the numeric ID if available.

### Session expired or auth errors

- Regenerate the session string.
- Confirm `api_id` and `api_hash` match the same Telegram application.

### Draft saved but not visible

- Open the target chat in Telegram.
- Refresh or reopen the chat.
- Confirm the draft was saved to the intended chat.

## What to Avoid

- Do not invent MCP registration commands for Codex if they are not confirmed.
- Do not expose credentials in terminal output, files, or commits.
