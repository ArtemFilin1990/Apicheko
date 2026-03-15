# AGENTS.md

## Project overview

This repository is a Telegram bot running as a Cloudflare Worker.

Primary runtime:
- `worker/worker.js`

Primary scoring module:
- `worker/services/risk-score.js`

Primary validation:
- `tests/worker_smoke.test.mjs`

Deploy config:
- `wrangler.toml`

## Core product model

The bot follows a strict Telegram UX model:
- one message = one screen
- section navigation via inline keyboard
- callback-based routing
- worker-first runtime, not a traditional backend app

Do not rewrite this model.

## Source-of-truth rules

Treat these files as the highest-value source of truth:
1. `worker/worker.js`
2. `tests/worker_smoke.test.mjs`
3. `wrangler.toml`
4. `README.md`

If README conflicts with runtime behavior or tests, prefer the actual code and tests.

## Current architecture rules

### DaData-owned flows
These flows must remain DaData-first:
- `co:main` -> `findById/party`
- `co:lnk` -> `findAffiliated/party`
- email lookup flow -> `findByEmail/company`

Do not reintroduce Checko into these screens unless explicitly requested.

### Checko-owned flows
These sections still depend on Checko:
- `co:risk`
- `co:fin`
- `co:arb`
- `co:debt`
- `co:ctr`
- `co:his`
- `co:tax`
- `co:own`
- `co:fil`
- `co:okv`
- entrepreneur and person flows
- bank lookup

If Checko is missing or unstable, prefer graceful degradation over hard failure.

## Working rules

- Make the smallest safe diff possible.
- Do not add dependencies unless absolutely necessary.
- Do not rewrite `worker/worker.js` into a framework.
- Preserve callback names.
- Preserve `buildViewForCallback` routing behavior.
- Preserve existing user-visible flows unless the task explicitly changes UX.
- Prefer small helpers over big abstractions.
- Keep Telegram screens compact, structured, and decision-oriented.

## Secrets and config

Never hardcode credentials.

Use only secrets/vars:
- `TELEGRAM_BOT_TOKEN`
- `CHECKO_API_KEY`
- `WEBHOOK_SECRET`
- `DADATA_API_KEY`
- `DADATA_SECRET_KEY`

Vars from `wrangler.toml`:
- `CHECKO_API_URL`
- `WEBHOOK_PATH`
- `DADATA_API_URL`
- `CACHE_BYPASS`

## Cloudflare KV rules

`COMPANY_CACHE` is optional.

Rules:
- Worker must continue to function without KV.
- Do not leave fake KV IDs in active deploy config.
- If KV is absent or failing, degrade gracefully.
- Do not make KV mandatory for user-facing functionality.

## Telegram UX rules

- Keep `/start` simple and action-oriented.
- Prefer INN-first flows.
- Avoid noisy button grids unless explicitly requested.
- Every screen should answer one question clearly.
- Avoid raw dumps, null-like values, object remnants, or technical wording in user-facing text.

## Error-handling rules

Differentiate:
- service unavailable
- missing configuration
- valid empty-state
- not found

Do not collapse everything into one generic error if a cleaner section-level fallback is possible.

## Code change rules

Before changing any screen:
1. find the builder function
2. check the data source
3. check tests that cover the flow
4. preserve existing callbacks
5. validate after change

When fixing a bug:
- isolate whether it is DaData, Checko, webhook, deploy, cache, or formatter related
- fix the narrowest layer that solves the issue

## Testing rules

Always run after meaningful changes:

```bash
node --check worker/worker.js
node --test tests/worker_smoke.test.mjs
```

If you change scoring logic, review:

- `worker/services/risk-score.js`
- related `co:risk` smoke coverage

If you change routing or keyboard layout, verify:

- `/start`
- `co:main`
- `co:lnk`
- one Checko-dependent section

## Deploy rules

Deploy with:

```bash
npx wrangler deploy
```

Inspect logs with:

```bash
npx wrangler tail
```

Basic healthcheck:

```bash
curl "<WORKER_URL>/"
```

If production behavior looks inconsistent, verify:

1. deployed worker version
2. Telegram webhook target
3. secrets in current environment
4. live logs during the failing user action

## Handoff format

Return changes in this structure:

- Added
- Changed
- Removed
- Validation
- Risks
- Next steps

## Definition of done

A task is done only if:

- routing still works
- callbacks are preserved
- no secrets are exposed
- validation passes
- user-visible text is clean
- deploy path remains sane
