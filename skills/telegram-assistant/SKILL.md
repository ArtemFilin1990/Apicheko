---
name: telegram-assistant
description: "Telegram workflow assistant for telegram-mcp. Use when Codex needs to inspect unread Telegram chats, summarize missed messages, analyze a channel's writing style, draft or save Telegram replies/posts as drafts, or search messages across chats. Trigger on requests like 'telegram digest', 'непрочитанные сообщения в Telegram', 'draft telegram post', 'написать пост в канал', 'analyze channel style', or 'ответь в Telegram черновиком'."
---

# Telegram Assistant

## Overview

Use this skill for Telegram workflows backed by a configured `telegram-mcp` server. Prefer draft-first behavior: collect context, prepare summaries or drafts, and save drafts for review instead of sending important messages directly.

## Preconditions

- Confirm that Telegram MCP tools are available before starting work.
- If the MCP server is missing or the user asks how to configure it, read [references/setup.md](references/setup.md).
- When extracting style, use [references/style-guide-template.md](references/style-guide-template.md) as the structure for a new guide in the current task workspace. Do not overwrite files inside the installed skill.

## Workflow Selector

- Need a summary of missed activity: use the Digest workflow.
- Need to match the user's voice for a channel post: use Style Extraction, then Post to Channel.
- Need to find a thread and answer safely: use Search and Reply.

## Digest Workflow

1. Use `list_chats` to find chats with unread activity.
2. For each relevant chat, use `get_messages` or `list_messages` to fetch recent context.
3. Produce a digest grouped by:
   - Priority items: direct questions, mentions, decisions, or blockers
   - Updates: announcements or news
   - Low priority: chatter and FYI items
4. If replies are needed, draft them and save with `save_draft` for user review.

## Style Extraction Workflow

1. Fetch the last 15-20 text posts from the target channel with `list_messages`.
2. Skip media-only posts unless the user explicitly wants them analyzed.
3. Extract concrete style signals:
   - language mix
   - tone and formality
   - typical structure and list usage
   - average length
   - emoji frequency
   - closing or call-to-action patterns
4. Create a reusable style guide in the task workspace, for example `telegram-style-guide.md`, using the template in [references/style-guide-template.md](references/style-guide-template.md).
5. Reuse that workspace file for later post drafting in the same task.

## Post to Channel Workflow

1. Read the workspace style guide first. If none exists, run Style Extraction.
2. Clarify the topic, key points, target audience, and desired call to action.
3. Draft the post to match the captured style.
4. Show the draft to the user, revise if needed, then save it with `save_draft`.
5. Do not use `send_message` for channel publishing unless the user explicitly asks for direct sending and the risk is acceptable.

## Search and Reply Workflow

1. Use `search_messages` or recent-message listing to find the target conversation.
2. Use `get_message_context` to inspect surrounding messages before replying.
3. Draft a reply that matches the conversation and save it with `save_draft`, including `reply_to_msg_id` when supported.

## Safety Rules

- Prefer `save_draft` over `send_message` for important or user-facing communications.
- Double-check chat or channel identity before saving a draft.
- Avoid bursty API usage across many chats.
- Treat Telegram session secrets as credentials and never expose them in logs or committed files.
- Be careful with private chats and sensitive messages when summarizing content.

## Troubleshooting

- If the tool cannot find the target entity, retry with the exact chat title, username without `@`, or the numeric ID.
- If drafts do not appear, tell the user to open the target chat in Telegram and refresh it.
- If the MCP server is unavailable or authentication fails, read [references/setup.md](references/setup.md) before suggesting changes.

## Resources

- [references/setup.md](references/setup.md): upstream-oriented setup notes for `telegram-mcp` plus local cautions.
- [references/style-guide-template.md](references/style-guide-template.md): template for creating per-channel style guides in the task workspace.
