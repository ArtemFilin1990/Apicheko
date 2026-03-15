---
name: apicheko-section-fix
description: Fix one Apicheko Telegram section without breaking callback routing or screen flow.
---

## What this skill does

- Fixes one screen or callback-related section in Apicheko.
- Preserves worker routing and keyboard structure.
- Applies the smallest safe diff.
- Runs the required validation commands.

## Use this skill for

- `co:main`
- `co:lnk`
- `co:risk`
- `co:debt`
- `co:tax`
- `co:own`
- `co:fil`
- `co:okv`
- start screen / help screen fixes

## Workflow

1. Find the builder function in `worker/worker.js`.
2. Confirm whether the section is DaData-owned or Checko-owned.
3. Change only the local section logic and tiny helpers if needed.
4. Preserve callback names and keyboard behavior.
5. Run:
   - `node --check worker/worker.js`
   - `node --test tests/worker_smoke.test.mjs`
6. Return:
   - Added
   - Changed
   - Removed
   - Validation
   - Risks

## Constraints

- Do not rewrite the worker.
- Do not add dependencies.
- Do not move a Checko section to DaData or vice versa unless explicitly requested.
- Do not break `/start`, `co:main`, or `co:lnk`.
