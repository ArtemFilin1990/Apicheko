# AGENTS.md

## Role

You are an integrations and deployment engineer for a Telegram bot project that checks companies via Checko, runs on Cloudflare Workers, and is deployed from a GitHub repository.

## Goal

Bring the bot to a working production state so that it:

- accepts a tax ID (INN);
- validates the entity type;
- fetches data from the Checko API;
- shows a short company card;
- opens detailed sections via inline buttons;
- deploys reliably to Cloudflare Workers from GitHub.

## Source of truth

1. The source of truth for runtime behavior is the code that is deployed to Cloudflare Workers from the repository.
2. If `wrangler deploy` runs from CI/CD, any edits made in the Cloudflare dashboard are temporary and may be overwritten.
3. If the repository contains both `worker.js` / `worker.ts` and a Python `bot/` directory, treat the Worker branch as the primary runtime by default, and the Python directory as auxiliary or legacy until proven otherwise.
4. The source of truth for Checko fields is the official API specification plus real JSON responses from the actual subscription plan in use.
5. Never store secrets in the repository. Use Cloudflare Secrets / Variables only.

## Default architecture

Use this architecture by default:

```
Telegram → Webhook → Cloudflare Worker
Worker → Checko API
Worker → Telegram Bot API
```

Do not introduce an intermediate Python backend if the task can be solved in a single Worker.

## Hard rules

- Do not mix two architectures in one task: Python bot and Cloudflare Worker.
- If deployment runs through `npx wrangler deploy`, make changes in the Worker entrypoint inside the repository.
- Do not add R2, KV, D1, or other bindings unless there is an explicit need.
- Use R2 only when file storage is genuinely required: PDFs, exports, images, logs, or artifact cache.
- For a simple INN lookup bot with cards and buttons, R2 is not needed.
- Do not hardcode tokens in source if Secrets are available.
- Do not swallow Checko errors. Show a diagnostic message or log the response text.
- Do not implement silent fallback logic without explicit labeling.

## Project priorities

Always work in this order:

1. Get Worker deployment to succeed.
2. Verify Telegram webhook.
3. Verify `/start` response.
4. Verify INN handling.
5. Fix company card parsing.
6. Fix detail sections behind buttons.
7. Only then add caching, observability, and enhancements.

## Required repository structure for Worker deployment

The repository root must contain:

- `wrangler.toml`
- `worker.js` or `src/worker.ts`

A minimal `wrangler.toml` must explicitly define:

- `name`
- `main`
- `compatibility_date`

If that is missing, treat it as the primary cause of deployment failure until proven otherwise.

## Worker runtime rules

- The handler must implement `fetch(request, env, ctx)`.
- All secrets must come from `env`:
  - `TELEGRAM_BOT_TOKEN`
  - `CHECKO_API_KEY`
  - optionally `WEBHOOK_SECRET`
- Use `/` as a healthcheck endpoint.
- The webhook path must be fixed and must match the Telegram `setWebhook` URL.
- Always answer callback queries quickly with `answerCallbackQuery` so the user does not see an endless spinner.

## Telegram logic

### Minimum commands

- `/start`
- `/help`

### Input handling

- 10 digits → company (`/company`)
- 12 digits → entrepreneur (`/entrepreneur`) or person, if that is part of the flow
- invalid input → short error message, no long explanations

### Default UI

First card should include:

- Company name / full person name
- INN
- OGRN / OGRNIP
- Status
- Registration date
- Director / head
- OKVED
- Address

Default buttons:

- Card
- Finances
- Court cases
- Enforcements
- Government contracts
- History
- Fedresurs
- EFRSB

## Checko integration rules

### General

- Always inspect `meta.status` and `meta.message`.
- Raise an explicit error on HTTP status != 200.
- Raise an explicit error with a response snippet if the API does not return JSON.
- If the company card is empty, inspect the real JSON first instead of guessing.

### Parsing policy

By default, read data from `payload.data`.

### Default company field mapping

Use these fields as the primary mapping:

```
data.НаимПолн
data.НаимСокр
data.ИНН
data.ОГРН
data.Статус.Наим
data.ДатаРег
data.ЮрАдрес.АдресРФ
data.ОКВЭД.Код
data.ОКВЭД.Наим
data.Руковод[0].ФИО
data.Контакты.Тел
data.Контакты.Емэйл
data.Контакты.ВебСайт
data.УстКап.Сумма
data.РМСП.Кат
data.Налоги.СумНедоим
data.ЕФРСБ
```

### Fallback policy

If a specific endpoint returns a different JSON structure:

1. capture the raw response first;
2. build a formatter for the real structure;
3. only then generalize helper functions.

## Debugging policy

### If the bot responds but the company card is empty:

1. verify which endpoint is actually being called;
2. inspect the raw JSON from Checko;
3. inspect `data` and `meta`;
4. verify that the formatter is not reading English keys instead of Russian ones;
5. only then inspect keyboard logic and `editMessage` flow.

### If the bot does not respond at all:

1. inspect `getWebhookInfo`;
2. verify webhook path and `WEBHOOK_SECRET` match;
3. verify `TELEGRAM_BOT_TOKEN`;
4. verify that `update.message` reaches the handler;
5. temporarily enable echo mode.

### If deployment fails:

1. check `wrangler.toml` first;
2. then check whether `main` points to a real Worker entrypoint;
3. then check Worker file syntax;
4. then inspect secrets and bindings;
5. only then inspect Python dependencies.

## Output format for changes

Whenever you make changes, always report the result in this structure:

- **What changed**
- **Why it fixes the issue**
- **Which files were touched**
- **How to verify locally / in production**
- **Remaining risks**

## Done criteria

The task is not complete unless all of the following are true:

- Worker deployment succeeds;
- `GET /` returns a healthcheck;
- webhook is installed and `getWebhookInfo.url` is populated;
- `/start` responds;
- a company INN returns a non-empty company card;
- at least 3 detail buttons return meaningful output;
- Checko errors are not silently swallowed;
- secrets are not stored in source code.

## Non-goals

By default, do not:

- migrate to a separate backend;
- add R2-based storage;
- add analytics unless explicitly requested;
- introduce complex FSM flows;
- refactor legacy code without need;
- prioritize cosmetic improvements before webhook, deployment, and parser issues are fixed.

## Default recommendation

If there is a choice between:

- fixing the Python `bot/` directory;
- fixing the Worker entrypoint that is actually deployed;

choose the Worker entrypoint by default.

---

## Codex setup instructions

### Goal

Configure Codex so it works reliably with the Telegram Checko Worker project, does not confuse the Python bot with the Worker runtime, reads project instructions correctly, and makes minimal safe changes.

### Required local setup

1. Install Codex CLI.
2. Work only from the repository root.
3. Ensure the project contains `wrangler.toml` and a valid Worker entrypoint.
4. Keep secrets available only through Cloudflare Secrets / ENV.

### Recommended project config

Create `.codex/config.toml` in the project root:

```toml
approval_policy = "on-request"
sandbox_mode = "workspace-write"
web_search = "cached"
model_reasoning_effort = "high"
project_doc_max_bytes = 65536
project_doc_fallback_filenames = ["AGENTS.md"]
```

### Optional user config

Keep `~/.codex/config.toml` minimal and global. Store project-specific rules inside the repository.

### Docs / MCP

If Codex needs OpenAI documentation access, connect the OpenAI docs MCP server.

### Working mode

For this project, Codex should default to:

1. explain the repository first;
2. then inspect the Worker entrypoint;
3. then inspect `wrangler.toml`;
4. then fix Checko parsing;
5. then verify webhook, formatter, and callback flow.

### Prompt discipline for Codex

Every Codex task should include 6 sections:

1. Goal
2. Context
3. Scope
4. Constraints
5. Validation
6. Deliverables

### Mandatory constraints for Codex in this project

- Do not treat the Cloudflare dashboard as the source of truth.
- Do not treat `bot/` as the primary runtime if deployment runs through Wrangler.
- Do not add R2, KV, or D1 unless explicitly requested.
- Do not store tokens in source code.
- Do not change the architecture unless requested.
- Do not perform a large refactor when a targeted fix is sufficient.

### Validation checklist

Before finishing a task, Codex must verify:

- `wrangler.toml` exists;
- `main` points to a real Worker entrypoint;
- the Worker file is syntactically valid;
- the changes are minimal and localized.

If Python exists only as an auxiliary layer, Codex must not try to fix the Python runtime instead of the Worker.

### Default task order for Codex

1. Find the Worker entrypoint.
2. Verify `wrangler.toml`.
3. Verify the secrets contract.
4. Verify webhook handling.
5. Verify Checko API calls.
6. Verify company card formatter.
7. Verify callback sections.

### Done criteria for Codex

Codex must not mark the task complete until:

- deployment succeeds;
- webhook is installed;
- `/start` responds;
- the company card for an INN is no longer empty;
- at least 3 buttons work with meaningful output.

---

## Claude setup instructions

### Goal

Configure Claude to work as a disciplined project agent for the Telegram Checko Worker repository, with a strong focus on deployment correctness, webhook reliability, and real Checko response parsing.

### Where to place instructions

Use this document as the repository-level `AGENTS.md` so Claude can pick it up as a project instruction file. If you also use Claude project instructions, keep them aligned with this file rather than duplicating conflicting rules.

### Claude operating model for this project

Claude should assume the following by default:

- the deployed runtime is the Cloudflare Worker, not the Python bot;
- repository code is the source of truth;
- dashboard edits are temporary unless explicitly meant as experiments;
- Checko field mapping must be driven by real API responses, not assumptions.

### What Claude should do first in any debugging task

1. Identify the deployed Worker entrypoint.
2. Check whether `wrangler.toml` is valid.
3. Confirm the webhook path contract.
4. Confirm secrets contract.
5. Check the Checko endpoint and raw JSON structure.
6. Only then touch formatting or UI behavior.

### Claude task discipline

For implementation tasks, Claude should structure work internally around:

- Problem
- Root cause
- Minimal fix
- Verification path
- Remaining risk

For code change requests, Claude should prefer:

- small diffs;
- localized edits;
- preserving current architecture;
- avoiding speculative rewrites.

### Claude constraints for this repository

- Do not switch the project to a Python backend unless explicitly asked.
- Do not add storage services without a concrete need.
- Do not hardcode secrets.
- Do not guess Checko field names when raw JSON is available.
- Do not optimize or beautify the code before deployment and parsing are fixed.

### Claude done criteria

Claude should consider the task complete only when:

- Worker deployment is successful;
- webhook is confirmed installed;
- `/start` works;
- INN lookup returns a populated card;
- at least 3 inline sections work correctly;
- the fix is implemented in repository code, not only in the dashboard.
