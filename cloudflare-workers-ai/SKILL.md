---
name: cloudflare-workers-ai
description: "Work with Cloudflare Workers AI REST API authentication and smoke tests. Use when Codex needs to validate a Cloudflare Workers AI token, distinguish account-owned tokens from user tokens, confirm `Workers AI` permissions, debug `/accounts/{account_id}/tokens/verify` or `/user/tokens/verify`, run a test request against `/accounts/{account_id}/ai/run/{model}`, or troubleshoot PowerShell, curl, IP filtering, 401, and 403 errors for Workers AI."
---

# Cloudflare Workers AI

## Overview

This skill standardizes Cloudflare Workers AI auth checks on Windows and cross-platform shells. Use it to pick the correct token verification endpoint, confirm practical permission requirements for Workers AI REST API calls, and run a small inference smoke test without exposing secrets in chat, files, or commits.

## Quick Start

1. Keep secrets out of prompts and files.
   - Never paste a live Cloudflare token into chat, `SKILL.md`, scripts, or repo config.
   - Prefer environment variables:
     - `CLOUDFLARE_API_TOKEN`
     - `CLOUDFLARE_ACCOUNT_ID`
2. Determine token type before debugging permissions.
   - Account-owned token -> verify with `/accounts/{account_id}/tokens/verify`
   - User token -> verify with `/user/tokens/verify`
3. Use the bundled script for deterministic checks.
   - `python scripts/workers_ai_smoke.py verify-account --account-id <ACCOUNT_ID>`
   - `python scripts/workers_ai_smoke.py verify-user`
   - `python scripts/workers_ai_smoke.py run --account-id <ACCOUNT_ID> --model "@cf/meta/llama-3.1-8b-instruct" --prompt "ping"`

## Workflow

### 1. Classify the token

Start here when a request includes Cloudflare auth, token scopes, or a failing `curl`.

- If the URL already contains `/accounts/{account_id}/tokens/verify`, assume the caller intends to use an account-owned token.
- If the caller only has a generic API token and no account verification path, check whether it is a user token and use `/user/tokens/verify`.
- If a request targets Workers AI itself, account-owned tokens are supported for Workers AI. Do not assume the same token will work for every other Cloudflare product.

When unclear, read [references/auth-and-permissions.md](references/auth-and-permissions.md).

### 2. Confirm permissions before deeper debugging

Use the current Cloudflare guidance as the default:

- For a custom Workers AI REST API token, require both `Workers AI Read` and `Workers AI Edit`.
- If the user created a token from a Cloudflare Workers AI dashboard template, still verify what scopes were actually granted.
- If `Client IP Address Filtering` is enabled, treat source IP mismatch as a first-class cause of 403 failures.

Avoid overfitting to one endpoint. Some read-style endpoints may succeed with read-only scopes, but for a general Workers AI REST API token check, start from `Read + Edit`.

### 3. Verify the token with the correct endpoint

Use the bundled script instead of hand-writing requests when possible:

```powershell
python scripts/workers_ai_smoke.py verify-account --account-id $env:CLOUDFLARE_ACCOUNT_ID
python scripts/workers_ai_smoke.py verify-user
```

Manual equivalents:

```powershell
curl.exe "https://api.cloudflare.com/client/v4/accounts/$env:CLOUDFLARE_ACCOUNT_ID/tokens/verify" `
  -H "Authorization: Bearer $env:CLOUDFLARE_API_TOKEN"
```

```powershell
curl.exe "https://api.cloudflare.com/client/v4/user/tokens/verify" `
  -H "Authorization: Bearer $env:CLOUDFLARE_API_TOKEN"
```

On Windows PowerShell, use backticks for continuation. Do not use shell-style trailing `\`.

### 4. Run a Workers AI smoke test

After verification succeeds, run a narrow inference request against a known text model:

```powershell
python scripts/workers_ai_smoke.py run `
  --account-id $env:CLOUDFLARE_ACCOUNT_ID `
  --model "@cf/meta/llama-3.1-8b-instruct" `
  --prompt "Reply with the word ok."
```

Use `--input-json` instead of `--prompt` when the model expects a non-prompt payload.

Default to the REST API route:

`/accounts/{account_id}/ai/run/{model}`

Only switch to OpenAI-compatible Workers AI endpoints when the user explicitly needs that interface.

### 5. Diagnose common failures

- `401 Unauthorized`
  - Missing `Authorization: Bearer ...` header
  - Expired, revoked, or malformed token
- `403 Forbidden`
  - Wrong token type for the endpoint
  - Missing `Workers AI` scope
  - `Client IP Address Filtering` blocked the request
  - Account mismatch between token and path
- `404 Not Found`
  - Wrong account ID
  - Mistyped model identifier
  - Wrong API path
- `success: false` with Cloudflare error payload
  - Prefer the Cloudflare JSON error body over generic HTTP assumptions

## Safety Rules

- Never echo the token value back to the user.
- Never store the token in committed files, terminal history snippets, or documentation examples.
- If the user pastes a live token into chat, treat it as compromised and instruct them to rotate it before production use.

## Bundled Resources

- `scripts/workers_ai_smoke.py`
  - Verifies account-owned or user tokens
  - Runs a minimal Workers AI REST API smoke test
  - Uses environment variables by default and never prints the token
- `references/auth-and-permissions.md`
  - Current Cloudflare guidance for token type, compatibility, permissions, and Windows examples
