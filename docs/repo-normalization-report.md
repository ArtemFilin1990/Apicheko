# Repository normalization report (Cloudflare-first)

## 1) Repo audit

### Production zones (active runtime)
- `worker/worker.js` — primary Cloudflare Worker webhook runtime (`GET /` healthcheck, `POST /` Telegram updates, Checko integration).
- `wrangler.toml` — Worker deployment config and public vars.
- `.dev.vars.example` — local Worker secrets/vars template.

### Secondary runtime zones (must remain compatible)
- `bot/` — Python Telegram runtime and handlers.
- `services/`, `utils/`, `storage/`, `config/` — Python support modules used by tests and fallback runtime.
- `requirements.txt` — Python dependency set.

### Skills / agent / reference zones
- `skills/cloudflare-docs` — reusable Cloudflare docs-oriented skill pack.
- `skills/cloudflare-workers-ai` — Workers AI setup + smoke helpers.
- `skills/telegram-assistant` — Telegram assistant scaffolding guidance.
- `skills/telegram-bot-aiogram-implementer` — aiogram implementation patterns.
- `skills/telegram-bot-designer` — bot design patterns.
- `skills/telegram-desktop` — Telegram desktop references (reference-only for this repo).
- `skills/terraform-engineer` — Terraform best-practice references.

### Docs / reference-only
- `docs/reference/checko/` — Checko API reference files and datasets.

### Review/quarantine
- `review_needed/unclassified/` — files with unclear role or encoding issues; kept isolated for manual review.

### Risks spotted
- Worker entrypoint lived in repo root and mixed with runtime-agnostic folders; harder to operate predictably.
- Skill packs were top-level siblings of production code, creating deployment/review noise.
- `.gitignore` previously ignored `skills/`, which could silently hide future skill updates.

## 2) Target tree

```text
.
├── archive/
├── bot/
├── config/
├── docs/
│   └── reference/
├── review_needed/
├── scripts/
├── services/
├── skills/
│   ├── cloudflare-docs/
│   ├── cloudflare-workers-ai/
│   ├── telegram-assistant/
│   ├── telegram-bot-aiogram-implementer/
│   ├── telegram-bot-designer/
│   ├── telegram-desktop/
│   └── terraform-engineer/
├── storage/
├── tests/
├── utils/
├── worker/
│   └── worker.js
├── wrangler.toml
├── .dev.vars.example
└── .env.example
```

## 3) Action plan (applied)

- Leave unchanged: Python runtime (`bot/`, `services/`, `storage/`, `utils/`, `config/`, `tests`).
- Move primary Worker entrypoint into `worker/` and update Wrangler `main` accordingly.
- Consolidate all skill/agent packs under `skills/` with existing `SKILL.md`, `agents/`, `references/`, and optional `scripts/` kept intact.
- Keep docs and Checko references in `docs/` as source-of-truth references.
- Keep uncertain files in `review_needed/` (no destructive cleanup).
- Create `archive/` and `scripts/` placeholders for controlled future cleanup/automation.
- Remove `skills/` ignore rule from `.gitignore` to avoid losing tracked skill updates.

## 4) Change report

### Added
- `docs/repo-normalization-report.md`
- `worker/` directory (new production runtime root)
- `skills/` directory (skills consolidation root)
- `archive/` directory (safe deprecation bucket)
- `scripts/` directory (service scripts bucket)

### Moved
- `worker.js` → `worker/worker.js`
- `cloudflare-docs/` → `skills/cloudflare-docs/`
- `cloudflare-workers-ai/` → `skills/cloudflare-workers-ai/`
- `telegram-assistant/` → `skills/telegram-assistant/`
- `telegram-bot-aiogram-implementer/` → `skills/telegram-bot-aiogram-implementer/`
- `telegram-bot-designer/` → `skills/telegram-bot-designer/`
- `telegram-desktop/` → `skills/telegram-desktop/`
- `terraform-engineer/` → `skills/terraform-engineer/`

### Renamed
- None (path-only relocation, no semantic rename).

### Deleted
- None.

### Archived
- None yet (directory prepared for safe future use).

### Left for review
- `review_needed/unclassified/*` remains untouched due to unclear provenance/encoding.

### Risks
- Any external tooling that hardcoded old root paths must be updated to new locations.

### Validation
- Worker syntax check and Python unit tests executed after relocation.
- Wrangler entrypoint points to new `worker/worker.js`.

## 5) Deploy readiness

- **Worker entrypoint**: `worker/worker.js` configured in `wrangler.toml`.
- **Wrangler config**: single `main`, stable `compatibility_date`, explicit vars.
- **Secrets/vars scheme**:
  - Secrets: `TELEGRAM_BOT_TOKEN`, `CHECKO_API_KEY`, `WEBHOOK_SECRET`.
  - Vars: `CHECKO_API_URL`, `NODE_ENV`.
  - Local template: `.dev.vars.example`.
- **Webhook flow**:
  - Telegram -> `POST /` (or normalized `WEBHOOK_PATH`) with header secret token.
  - Worker validates secret and handles updates.
- **Checks**:
  - `node --check worker/worker.js`
  - `python -m unittest discover -s tests -p "test_*.py"`
- **Manual smoke**:
  1. `npx wrangler deploy`
  2. `curl https://<worker-domain>/` -> expect `{ ok: true, ... }`
  3. set webhook via Telegram API with `secret_token`
  4. send `/start`
  5. send test INN and verify non-empty card + detail buttons.
