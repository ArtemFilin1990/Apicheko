---
name: apicheko-deploy-audit
description: Audit Apicheko for Cloudflare Worker deploy readiness and config safety.
---

## What this skill does

- Checks deploy readiness for Apicheko.
- Reviews `wrangler.toml`, worker entrypoint, smoke tests, and optional KV safety.
- Flags placeholder config and environment drift.

## Workflow

1. Read:
   - `wrangler.toml`
   - `worker/worker.js`
   - `tests/worker_smoke.test.mjs`
   - `README.md`
2. Run:
   - `node --check worker/worker.js`
   - `node --test tests/worker_smoke.test.mjs`
3. Check for:
   - fake KV IDs
   - broken entrypoint
   - missing graceful degradation
   - callback regressions
4. Return:
   - Verdict
   - Deploy blockers
   - Warnings
   - Exact fixes needed

## Constraints

- Do not invent deploy issues.
- Prefer factual findings over stylistic comments.
- Keep recommendations minimal and actionable.
