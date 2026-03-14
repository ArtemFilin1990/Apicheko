import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workerSourcePath = path.resolve("worker/worker.js");

async function loadWorkerModule() {
  const source = await fs.readFile(workerSourcePath, "utf8");
  const tempPath = path.join(os.tmpdir(), `apicheko-worker-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  await fs.writeFile(tempPath, source, "utf8");
  return import(`${pathToFileURL(tempPath).href}?v=${Date.now()}`);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
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

let worker;
let originalFetch;

test.before(async () => {
  originalFetch = globalThis.fetch;
  ({ default: worker } = await loadWorkerModule());
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("GET / healthcheck", async () => {
  const response = await worker.fetch(new Request("https://example.com/"), makeEnv());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.webhookPaths, ["/webhook"]);
});

test("/start sends new main menu", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ ok: true });
  };

  await worker.fetch(makeWebhookRequest({ message: { text: "/start", chat: { id: 1 } } }), makeEnv());
  const body = JSON.parse(calls[0].options.body);
  assert.match(body.text, /оперативная проверка контрагентов/);
  assert.equal(body.reply_markup.inline_keyboard[0][0].callback_data, "search:inn");
  assert.equal(body.reply_markup.inline_keyboard[1][0].callback_data, "search:name");
  assert.equal(body.reply_markup.inline_keyboard[2][0].callback_data, "search:bic");
});

test("10-digit INN opens main card with 12-section keyboard", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.checko.ru") {
      const endpoint = u.pathname.split("/").pop();
      if (endpoint === "company") {
        return jsonResponse({ meta: { status: "ok" }, data: { ИНН: "7707083893", ОГРН: "1027700132195", НаимСокр: "ООО Тест", Статус: { Наим: "Действующее" }, ОКВЭД: { Код: "62.01", Наим: "Разработка ПО" }, ЮрАдрес: { АдресРФ: "Москва" }, Руковод: [{ ФИО: "Иванов И.И." }], Налоги: { СумНедоим: 0 } } });
      }
      if (["finances", "legal-cases", "enforcements", "contracts"].includes(endpoint)) {
        return jsonResponse({ meta: { status: "ok" }, data: {} });
      }
    }
    return jsonResponse({ ok: true });
  };

  await worker.fetch(makeWebhookRequest({ message: { text: "7707083893", chat: { id: 1 } } }), makeEnv());
  const send = calls.find((c) => c.url.includes("/sendMessage"));
  const body = JSON.parse(send.options.body);
  assert.match(body.text, /ООО Тест/);
  assert.equal(body.reply_markup.inline_keyboard[0][0].callback_data, "co:main:7707083893");
  assert.equal(body.reply_markup.inline_keyboard[5][1].callback_data, "co:tax:7707083893");
});

test("12-digit INN forces user choice", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ ok: true });
  };

  await worker.fetch(makeWebhookRequest({ message: { text: "500100732259", chat: { id: 1 } } }), makeEnv());
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.reply_markup.inline_keyboard[0][0].callback_data, "resolve12:entrepreneur:500100732259");
  assert.equal(body.reply_markup.inline_keyboard[1][0].callback_data, "resolve12:person:500100732259");
});

test("co:fin uses /finances and shows empty-state without service error", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.pathname.endsWith("/finances")) return jsonResponse({ meta: { status: "ok" }, data: {} });
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb", data: "co:fin:7707083893", message: { message_id: 4, chat: { id: 2 } } } }),
    makeEnv()
  );

  assert.ok(calls.some((c) => c.url.includes("/answerCallbackQuery")));
  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /Financial statements not found/);
});

test("search by name calls /search", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/search")) {
      assert.equal(u.searchParams.get("by"), "name");
      assert.equal(u.searchParams.get("obj"), "org");
      assert.equal(u.searchParams.get("query"), "Ромашка");
      return jsonResponse({ meta: { status: "ok" }, data: [{ НаимСокр: "ООО Ромашка", ИНН: "1234567890" }] });
    }
    return jsonResponse({ ok: true });
  };

  await worker.fetch(makeWebhookRequest({ message: { text: "Ромашка", chat: { id: 1 } } }), makeEnv());
  const send = calls.find((c) => c.url.includes("/sendMessage"));
  const body = JSON.parse(send.options.body);
  assert.equal(body.reply_markup.inline_keyboard[0][0].callback_data, "select:company:1234567890");
});

test("BIC lookup uses /bank", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/bank")) {
      assert.equal(u.searchParams.get("bic"), "044525225");
      return jsonResponse({ meta: { status: "ok" }, data: { БИК: "044525225", Наим: "ПАО Сбербанк" } });
    }
    return jsonResponse({ ok: true });
  };

  await worker.fetch(makeWebhookRequest({ message: { text: "044525225", chat: { id: 1 } } }), makeEnv());
  assert.ok(calls.some((c) => c.url.includes("/bank?")));
});
