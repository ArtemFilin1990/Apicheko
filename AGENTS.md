# AGENTS.md

## Role
<<
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

## Codex setup instructi