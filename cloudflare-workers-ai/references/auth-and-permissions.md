# Cloudflare Workers AI Auth And Permissions

Use this reference when the request is about Cloudflare Workers AI token setup, `/tokens/verify`, account-owned tokens, or repeated 401/403 failures.

## Current Cloudflare Guidance

### Token verification endpoints

- User token verify:
  - `GET https://api.cloudflare.com/client/v4/user/tokens/verify`
- Account-owned token verify:
  - `GET https://api.cloudflare.com/client/v4/accounts/{account_id}/tokens/verify`

Use the endpoint that matches the token type. Do not mix them.

### Account-owned token compatibility

Cloudflare's account-owned token compatibility matrix currently lists:

- `Workers AI` -> supported

That means an account-owned token can be valid for Workers AI even if other Cloudflare services still require user tokens.

### Workers AI REST API token scopes

Cloudflare's Workers AI REST API quickstart says:

- If you create a custom token instead of using the Workers AI template, grant both:
  - `Workers AI Read`
  - `Workers AI Edit`

Treat this as the default baseline for custom REST API tokens.

## Practical Troubleshooting Order

1. Confirm token type.
2. Verify token with the matching verify endpoint.
3. Confirm `CLOUDFLARE_ACCOUNT_ID` matches the owning account.
4. Confirm `Workers AI Read` and `Workers AI Edit`.
5. Check `Client IP Address Filtering`.
6. Run one minimal `/ai/run/{model}` request.

## PowerShell Notes

Prefer one of these on Windows:

- `curl.exe`
- `Invoke-RestMethod`

Do not use shell-style trailing `\` line continuations in PowerShell. Use backticks instead.

Example:

```powershell
curl.exe "https://api.cloudflare.com/client/v4/accounts/$env:CLOUDFLARE_ACCOUNT_ID/tokens/verify" `
  -H "Authorization: Bearer $env:CLOUDFLARE_API_TOKEN"
```

## Typical Failure Patterns

### 401

- Token revoked or malformed
- Missing bearer header
- Wrong environment variable loaded

### 403

- Missing `Workers AI` scope
- Wrong token type for the endpoint
- Account mismatch
- IP allowlist mismatch caused by `Client IP Address Filtering`

### 404

- Wrong account ID
- Wrong model name
- Wrong route

## Official Sources

- Account-owned tokens compatibility matrix:
  - https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/
- Workers AI REST API quickstart:
  - https://developers.cloudflare.com/workers-ai/get-started/rest-api/
- Account token verify endpoint:
  - https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/get/
- User token verify troubleshooting reference:
  - https://developers.cloudflare.com/fundamentals/api/troubleshooting/
