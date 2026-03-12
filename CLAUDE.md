# CLAUDE.md

Guidance for AI assistants working in this repository.

## Project Overview

**Apicheko** is a Telegram bot that queries Russian company and entrepreneur data via the [Checko API v2](https://api.checko.ru/v2). Users send an INN, OGRN, OGRNIP, or BIC; the bot returns a structured card with inline buttons for financial reports, arbitration cases, enforcement proceedings, and other sections.

**Primary deployment target**: Cloudflare Worker (`worker/worker.js`) + Telegram webhook.
**Secondary runtime**: Python/aiogram (`bot/`) — kept for regression testing and fallback, not the production path.

---

## Repository Structure

```
Apicheko/
├── worker/worker.js          # PRIMARY: Cloudflare Worker entrypoint (production)
├── wrangler.toml             # Worker deployment config
├── bot/                      # Secondary Python runtime (aiogram)
│   ├── main.py               # Bot entrypoint (polling + webhook modes)
│   ├── formatters.py         # Section-specific message formatters
│   ├── keyboards.py          # Inline keyboard builders
│   ├── cards.py              # DetailCardSpec + DETAIL_CARDS map
│   └── handlers/
│       ├── start.py          # /start, /cancel
│       ├── search.py         # Text INN/OGRN lookup
│       └── callbacks.py      # Inline button routing
├── services/checko_api.py    # Async Checko API client with retry
├── config/settings.py        # Pydantic-based settings with validation
├── storage/database.py       # Async SQLite wrapper (aiosqlite)
├── utils/checko_payload.py   # Payload/data extraction helpers
├── tests/                    # Python unit tests
├── skills/                   # Reusable agent/skill packs (reference only)
├── docs/                     # Supplementary documentation
├── archive/                  # Deprecated materials
├── review_needed/            # Files awaiting manual review
├── requirements.txt          # Python dependencies
├── .env.example              # Environment variable template
└── .dev.vars.example         # Wrangler dev vars template
```

---

## Two Runtimes

### 1. Cloudflare Worker (PRIMARY — fix this first)

- **File**: `worker/worker.js` (single bundled JS file, ~30 KB)
- **Config**: `wrangler.toml`
- **Deploy**: `npx wrangler deploy`
- Handles `GET /` (healthcheck) and `POST /` (Telegram webhook)
- Validates `X-Telegram-Bot-Api-Secret-Token` header against `WEBHOOK_SECRET`
- All Checko API calls use `fetch()` with a 15 s timeout
- Telegram API calls use `fetch()` with a 10 s timeout
- **When there is a conflict between Worker and Python bot behaviour, fix the Worker**

### 2. Python Bot (SECONDARY — fallback/regression)

- **Entrypoint**: `bot/main.py`
- **Framework**: aiogram 3.26 + aiohttp
- Dual-mode: polling and webhook
- Middleware: `ThrottlingMiddleware`, `DatabaseMiddleware`
- Run tests: `python -m unittest discover -s tests -p "test_*.py"`

---

## Identifier Routing

| Input length | Identifier | API endpoint |
|---|---|---|
| 10 digits | Company INN | `/v2/company` |
| 13 digits | OGRN | `/v2/company` |
| 12 digits | Entrepreneur INN | User chooses: `/v2/entrepreneur` or `/v2/person` |
| 15 digits | OGRNIP | `/v2/entrepreneur` |
| 9 digits | Bank BIC | `/v2/bank` |
| Anything else | — | Prompt user to re-enter |

---

## Callback Data Format

```
<cmd>:<id>:<page>:<extra>
```

| cmd | Meaning |
|---|---|
| `main` | Company main card |
| `fin` | Financial reports |
| `crt` | Arbitration cases |
| `gov` | Government contracts (extra: `44s`, `94s`, `223s`) |
| `ins` | Inspections |
| `fsp` | Enforcement proceedings |
| `bnk` | Bankruptcy (EFRSB) |
| `log` | History / timeline |
| `fed` | Fedresurs |
| `ip` | Entrepreneur card |
| `prs` | Person card |
| `bak` | Bank card |
| `noop` | No-op (disabled button) |

---

## Environment Variables & Secrets

### Cloudflare Worker secrets (set via `wrangler secret put`)

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API token |
| `CHECKO_API_KEY` | Checko API authentication key |
| `WEBHOOK_SECRET` | HMAC secret for Telegram webhook validation |

### Cloudflare Worker public vars (in `wrangler.toml`)

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `CHECKO_API_URL` | `https://api.checko.ru/v2` |

### Python runtime (`.env` / `.dev.vars`)

- `BOT_TOKEN` or `TELEGRAM_BOT_TOKEN`
- `CHECKO_API_KEY`, `CHECKO_API_URL`
- `DATABASE_PATH` (default: `bot.db`)
- `DATABASE_SOURCE_URL` (optional HTTP(S) URL to seed DB, max 50 MB)
- Webhook: `WEBHOOK_BASE_URL`, `WEBHOOK_PATH`, `WEBHOOK_SECRET_TOKEN`, `WEBHOOK_HOST`, `WEBHOOK_PORT`

**Both runtimes refuse to start if credentials contain placeholder values.**

---

## Checko API Integration Rules

1. Always check `meta.status` — valid values are `"ok"` and `"success"`.
2. Raise an explicit error on HTTP status ≠ 200.
3. Raise an explicit error if the response is not JSON.
4. Read data from `payload.data` by default; fall back to top-level `data` field.
5. If a company card is empty, inspect the raw JSON before touching formatter logic.

### Primary Russian field names

```
data.НаимПолн          Full company name
data.НаимСокр          Short name
data.ИНН               INN
data.ОГРН              OGRN
data.Статус.Наим       Legal status
data.ДатаРег           Registration date
data.ЮрАдрес.АдресРФ   Legal address
data.ОКВЭД.Код         Primary activity code
data.ОКВЭД.Наим        Primary activity name
data.Руковод[0].ФИО    Director name
data.Контакты.Тел      Phone
data.Контакты.Емэйл    Email
data.Контакты.ВебСайт  Website
data.УстКап.Сумма      Authorized capital
data.РМСП.Кат          SME category
data.Налоги.СумНедоим  Tax arrears
data.ЕФРСБ             Bankruptcy flag
```

### Fallback policy

If a specific endpoint returns a different JSON structure:
1. Capture raw response first.
2. Build a formatter for the real structure.
3. Only then generalize helper functions.

---

## Risk Assessment (Worker)

Risk score formula:

```
score = arbitration * 4 + bankruptcy * 10 + enforcements * 6
```

| Score | Label |
|---|---|
| ≥ 40 | 🔴 High risk |
| > 0 | 🟡 Medium risk |
| 0 | 🟢 Low risk |

---

## Development Workflows

### Deploy the Worker

```bash
# Set secrets (one-time or when rotating)
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put CHECKO_API_KEY
npx wrangler secret put WEBHOOK_SECRET

# Deploy
npx wrangler deploy

# Verify healthcheck
curl https://<worker-domain>/
```

### Install Telegram webhook

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook\
?url=<WORKER_URL>&secret_token=<WEBHOOK_SECRET>&drop_pending_updates=true"

# Verify
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

### Syntax-check the Worker without deploying

```bash
node --check worker/worker.js
```

### Run Python tests

```bash
python -m unittest discover -s tests -p "test_*.py"
```

### Python local setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in real values
python bot/main.py
```

---

## Debugging Checklist

### Bot responds but company card is empty

1. Verify which endpoint is being called.
2. Inspect raw JSON from Checko.
3. Check `data` and `meta` fields.
4. Confirm the formatter reads Russian keys, not English ones.
5. Only then check keyboard logic and `editMessage` flow.

### Bot does not respond at all

1. Inspect `getWebhookInfo`.
2. Verify webhook path and `WEBHOOK_SECRET` match.
3. Verify `TELEGRAM_BOT_TOKEN`.
4. Confirm `update.message` reaches the handler.
5. Temporarily enable echo mode.

### Deployment fails

1. Check `wrangler.toml` first.
2. Confirm `main` points to a real Worker entrypoint.
3. Check `worker/worker.js` syntax.
4. Inspect secrets and bindings.
5. Only then inspect Python dependencies.

---

## Done Criteria

A task is **not complete** unless all of the following are true:

- [ ] Worker deployment succeeds
- [ ] `GET /` returns a healthcheck JSON
- [ ] Webhook is installed and `getWebhookInfo.url` is populated
- [ ] `/start` responds
- [ ] A company INN returns a non-empty company card
- [ ] At least 3 detail buttons return meaningful output
- [ ] Checko errors are not silently swallowed
- [ ] No secrets stored in source code

---

## Output Format for Changes

When reporting completed work, always include:

- **What changed** — files and functions modified
- **Why it fixes the issue** — root cause and fix rationale
- **Which files were touched** — explicit list
- **How to verify** — local and/or production steps
- **Remaining risks** — any known caveats

---

## Non-Goals (Default — Do Not Do Unless Explicitly Asked)

- Migrate to a separate backend.
- Add R2-based storage.
- Add analytics.
- Introduce complex FSM flows.
- Refactor legacy code without a functional reason.
- Prioritize cosmetic improvements before webhook, deployment, and parser issues are resolved.

---

## Code Conventions

### JavaScript (Worker)

- Single bundled file; no build step required.
- Use `fetch()` for all HTTP — no Node.js APIs.
- Escape all user-sourced strings with `htmlEscape()` before sending to Telegram.
- Use `pick(obj, [...keys])` for Russian field lookup with fallbacks.
- Use `pickNested(obj, [[...path], ...])` for nested fields.
- Pagination: 10 items per page in `buildAffiliatesView`; 5 items per page for sections.

### Python (bot/)

- Async/await throughout — no blocking I/O.
- Use `html.escape()` on all user data before formatting messages.
- `_pick(source, *keys)` for Russian field lookup with fallbacks.
- `_nested(d, *keys)` for nested field access.
- `extract_items(payload, *fallback_keys)` for list extraction.
- Settings are validated at startup; the bot exits if credentials are placeholders.
- Use `ParseMode.HTML` for all Telegram messages.

### General

- No secrets in source code — ever.
- Validate `meta.status` on every Checko response.
- All Telegram message content must be HTML-escaped.
- Both runtimes must agree on business logic; when they diverge, the Worker is authoritative.
