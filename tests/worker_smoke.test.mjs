import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workerSourcePath = path.resolve("worker/worker.js");

async function loadWorkerModule() {
  const source = await fs.readFile(workerSourcePath, "utf8");
  const tempPath = path.join(
    os.tmpdir(),
    `apicheko-worker-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`
  );
  await fs.writeFile(tempPath, source, "utf8");
  return import(`${pathToFileURL(tempPath).href}?v=${Date.now()}`);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function makeEnv(overrides = {}) {
  return {
    TELEGRAM_BOT_TOKEN: "telegram-token",
    CHECKO_API_KEY: "checko-key",
    WEBHOOK_SECRET: "secret-token",
    CHECKO_API_URL: "https://api.checko.ru/v2",
    WEBHOOK_PATH: "/webhook",
    ...overrides
  };
}

function makeWebhookRequest(payload, secret = "secret-token") {
  return new Request("https://example.com/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": secret
    },
    body: JSON.stringify(payload)
  });
}

let originalFetch;
let worker;

test.before(async () => {
  originalFetch = globalThis.fetch;
  ({ default: worker } = await loadWorkerModule());
});

test.after(() => {
  globalThis.fetch = originalFetch;
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("GET / returns healthcheck with webhookPaths", async () => {
  const response = await worker.fetch(new Request("https://example.com/"), makeEnv());
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload, {
    ok: true,
    service: "telegram-checko-bot",
    webhookPaths: ["/webhook", "/"]
  });
});

test("POST /webhook with invalid secret returns 401", async () => {
  const response = await worker.fetch(makeWebhookRequest({}, "wrong-secret"), makeEnv());
  assert.equal(response.status, 401);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.match(payload.error, /Unauthorized/);
});

test("POST /webhook with /start sends greeting", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ ok: true });
  };

  const request = makeWebhookRequest({
    message: {
      text: "/start",
      chat: { id: 123 }
    }
  });

  const response = await worker.fetch(request, makeEnv());
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /sendMessage$/);

  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.chat_id, 123);
  assert.match(body.text, /Отправьте ИНН/);
});

test("POST /webhook with 10-digit INN sends non-empty company card", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    calls.push({ url: requestUrl.toString(), options });

    if (requestUrl.hostname === "api.checko.ru") {
      const endpoint = requestUrl.pathname.split("/").pop();
      if (endpoint === "company") {
        return jsonResponse({
          meta: { status: "ok" },
          data: {
            ИНН: "7707083893",
            ОГРН: "1027700132195",
            НаимПолн: "ПАО Сбербанк",
            Статус: { Наим: "Действующее" },
            ДатаРег: "1991-01-01",
            ЮрАдрес: { АдресРФ: "г. Москва, ул. Тверская, д. 1", Регион: { Наим: "г. Москва" } },
            Руковод: [{ ФИО: "Иванов И.И." }],
            Учред: [{ Наим: "Учредитель 1" }]
          }
        });
      }

      if (endpoint === "legal-cases") {
        return jsonResponse({
          meta: { status: "ok" },
          data: {
            cases: [{ НомерДела: "А40-1/2026", СуммаТреб: 1500 }]
          }
        });
      }

      if (endpoint === "bankruptcy-messages") {
        return jsonResponse({
          meta: { status: "ok" },
          data: {
            messages: []
          }
        });
      }

      if (endpoint === "finances") {
        return jsonResponse({
          meta: { status: "ok" },
          data: {
            reports: [{ 2110: 1000, 2400: 250, 1600: 5000 }]
          }
        });
      }
    }

    if (requestUrl.hostname === "api.telegram.org") {
      return jsonResponse({ ok: true });
    }

    throw new Error(`Unexpected URL ${requestUrl}`);
  };

  const request = makeWebhookRequest({
    message: {
      text: "7707083893",
      chat: { id: 321 }
    }
  });

  const response = await worker.fetch(request, makeEnv());
  assert.equal(response.status, 200);

  const telegramCall = calls.find((call) => call.url.includes("/sendMessage"));
  assert.ok(telegramCall, "sendMessage must be called");

  const body = JSON.parse(telegramCall.options.body);
  assert.match(body.text, /ПАО Сбербанк/);
  assert.match(body.text, /ИНН: <b>7707083893<\/b>/);
  assert.match(body.text, /ОГРН: <b>1027700132195<\/b>/);
  assert.match(body.text, /Статус: <b>Действующее<\/b>/);
  assert.match(body.text, /Регистрация: <b>1991-01-01<\/b>/);
  assert.match(body.text, /Директор: <b>Иванов И\.И\.<\/b>/);
  assert.match(body.text, /Регион: <b>г\. Москва<\/b>/);
  assert.equal(body.parse_mode, "HTML");
  assert.equal(body.reply_markup.inline_keyboard.length, 2);
  assert.equal(body.reply_markup.inline_keyboard[0][0].callback_data, "arbitration:7707083893");
  assert.equal(body.reply_markup.inline_keyboard[0][1].callback_data, "financial:7707083893");
  assert.equal(body.reply_markup.inline_keyboard[1][0].callback_data, "bankruptcy:7707083893");
  assert.equal(body.reply_markup.inline_keyboard[1][1].callback_data, "main:7707083893");
});

test("POST /webhook with empty company payload sends not-found message", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    calls.push({ url: requestUrl.toString(), options });

    if (requestUrl.hostname === "api.checko.ru") {
      return jsonResponse({
        meta: { status: "ok" },
        data: {}
      });
    }

    if (requestUrl.hostname === "api.telegram.org") {
      return jsonResponse({ ok: true });
    }

    throw new Error(`Unexpected URL ${requestUrl}`);
  };

  const response = await worker.fetch(
    makeWebhookRequest({
      message: {
        text: "7707083893",
        chat: { id: 321 }
      }
    }),
    makeEnv()
  );

  assert.equal(response.status, 200);
  const telegramCall = calls.find((call) => call.url.includes("/sendMessage"));
  assert.ok(telegramCall, "sendMessage must be called");
  const body = JSON.parse(telegramCall.options.body);
  assert.equal(body.text, "❌ Компания не найдена");
});

test("POST /webhook with Checko HTTP error sends safe service message", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    calls.push({ url: requestUrl.toString(), options });

    if (requestUrl.hostname === "api.checko.ru") {
      return new Response("upstream exploded", { status: 502 });
    }

    if (requestUrl.hostname === "api.telegram.org") {
      return jsonResponse({ ok: true });
    }

    throw new Error(`Unexpected URL ${requestUrl}`);
  };

  const response = await worker.fetch(
    makeWebhookRequest({
      message: {
        text: "7707083893",
        chat: { id: 321 }
      }
    }),
    makeEnv()
  );

  assert.equal(response.status, 200);
  const telegramCall = calls.find((call) => call.url.includes("/sendMessage"));
  assert.ok(telegramCall, "sendMessage must be called");
  const body = JSON.parse(telegramCall.options.body);
  assert.equal(body.text, "⚠️ Ошибка сервиса Checko");
});

test("POST /webhook with Checko non-JSON response sends safe service message", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    calls.push({ url: requestUrl.toString(), options });

    if (requestUrl.hostname === "api.checko.ru") {
      return new Response("<html>bad gateway</html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }

    if (requestUrl.hostname === "api.telegram.org") {
      return jsonResponse({ ok: true });
    }

    throw new Error(`Unexpected URL ${requestUrl}`);
  };

  const response = await worker.fetch(
    makeWebhookRequest({
      message: {
        text: "7707083893",
        chat: { id: 321 }
      }
    }),
    makeEnv()
  );

  assert.equal(response.status, 200);
  const telegramCall = calls.find((call) => call.url.includes("/sendMessage"));
  assert.ok(telegramCall, "sendMessage must be called");
  const body = JSON.parse(telegramCall.options.body);
  assert.equal(body.text, "⚠️ Ошибка сервиса Checko");
});

test("POST /webhook with Checko meta error sends safe service message", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    calls.push({ url: requestUrl.toString(), options });

    if (requestUrl.hostname === "api.checko.ru") {
      return jsonResponse({
        meta: { status: "error", message: "rate limit" },
        data: null
      });
    }

    if (requestUrl.hostname === "api.telegram.org") {
      return jsonResponse({ ok: true });
    }

    throw new Error(`Unexpected URL ${requestUrl}`);
  };

  const response = await worker.fetch(
    makeWebhookRequest({
      message: {
        text: "7707083893",
        chat: { id: 321 }
      }
    }),
    makeEnv()
  );

  assert.equal(response.status, 200);
  const telegramCall = calls.find((call) => call.url.includes("/sendMessage"));
  assert.ok(telegramCall, "sendMessage must be called");
  const body = JSON.parse(telegramCall.options.body);
  assert.equal(body.text, "⚠️ Ошибка сервиса Checko");
});

test("callback_query for arbitration answers callback and edits message", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    calls.push({ url: requestUrl.toString(), options });

    if (requestUrl.hostname === "api.telegram.org") {
      return jsonResponse({ ok: true });
    }

    if (requestUrl.hostname === "api.checko.ru") {
      return jsonResponse({
        meta: { status: "ok" },
        data: {
          cases: [{ НомерДела: "А40-1/2026", СуммаТреб: 1000, Дата: "2026-01-01" }]
        }
      });
    }

    throw new Error(`Unexpected URL ${requestUrl}`);
  };

  const request = makeWebhookRequest({
    callback_query: {
      id: "cb-1",
      data: "arbitration:7707083893",
      message: {
        message_id: 77,
        chat: { id: 99 }
      }
    }
  });

  const response = await worker.fetch(request, makeEnv());
  assert.equal(response.status, 200);

  assert.match(calls[0].url, /answerCallbackQuery$/);
  assert.match(calls[2].url, /editMessageText$/);

  const body = JSON.parse(calls[2].options.body);
  assert.equal(body.chat_id, 99);
  assert.equal(body.message_id, 77);
  assert.match(body.text, /Арбитражные дела/);
});
