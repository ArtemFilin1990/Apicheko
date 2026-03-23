import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workerSourcePath = path.resolve("worker/worker.js");

async function loadWorkerModule() {
  const source = await fs.readFile(workerSourcePath, "utf8");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apicheko-worker-"));
  const tempWorkerPath = path.join(tempRoot, "worker.mjs");
  await fs.writeFile(tempWorkerPath, source, "utf8");
  return import(`${pathToFileURL(tempWorkerPath).href}?v=${Date.now()}`);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function makeEnv(overrides = {}) {
  return {
    TELEGRAM_BOT_TOKEN: "telegram-token",
    DADATA_API_KEY: "dadata-key",
    DADATA_SECRET_KEY: "dadata-secret",
    WEBHOOK_SECRET: "secret-token",
    DADATA_API_URL: "https://suggestions.dadata.ru/suggestions/api/4_1/rs",
    WEBHOOK_PATH: "/webhook",
    ...overrides
  };
}

function makeKvNamespace(initial = []) {
  const store = new Map(initial);
  return {
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      store.set(key, String(value));
    }
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

function collectTelegramBodies(calls, method) {
  return calls.filter((call) => call.url.includes(`/${method}`)).map((call) => JSON.parse(call.options.body));
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
  assert.equal(body.service, "telegram-dadata-bot");
  assert.deepEqual(body.webhookPaths, ["/webhook"]);
});

test("/start shows DaData-only menu and removes legacy search buttons", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ ok: true });
  };

  await worker.fetch(makeWebhookRequest({ message: { text: "/start", chat: { id: 1 } } }), makeEnv());

  const [body] = collectTelegramBodies(calls, "sendMessage");
  const callbacks = body.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
  assert.match(body.text, /DaData/);
  assert.ok(callbacks.includes("search:inn"));
  assert.ok(callbacks.includes("search:email"));
  assert.ok(callbacks.includes("help"));
  assert.ok(!callbacks.includes("search:name"));
  assert.ok(!callbacks.includes("search:bic"));
});

test("10-digit INN opens DaData-only card and supported section buttons", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findById/party")) {
      return jsonResponse({
        suggestions: [{
          data: {
            inn: "7707083893",
            ogrn: "1027700132195",
            name: { short_with_opf: "ООО Тест" },
            state: { status: "ACTIVE" },
            management: { name: "Иванов И.И." },
            address: { value: "г Москва, ул Тверская, д 1" },
            capital: { value: 10000 },
            employee_count: 12,
            okved: "62.01"
          }
        }]
      });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(makeWebhookRequest({ message: { text: "7707083893", chat: { id: 1 } } }), makeEnv());

  const [body] = collectTelegramBodies(calls, "sendMessage");
  const callbacks = body.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
  assert.match(body.text, /ООО Тест/);
  assert.ok(callbacks.includes("co:main:7707083893"));
  assert.ok(callbacks.includes("co:lnk:7707083893"));
  assert.ok(callbacks.includes("co:own:7707083893"));
  assert.ok(callbacks.includes("co:fin:7707083893"));
  assert.ok(callbacks.includes("co:okv:7707083893"));
  assert.ok(callbacks.includes("co:succ:7707083893"));
  assert.ok(!callbacks.includes("co:arb:7707083893"));
  assert.ok(!callbacks.includes("co:debt:7707083893"));
  assert.ok(!callbacks.includes("co:ctr:7707083893"));
  assert.ok(!callbacks.includes("co:his:7707083893"));
  assert.ok(!callbacks.includes("co:tax:7707083893"));
});

test("email lookup uses findByEmail/company and then opens the standard main card", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findByEmail/company")) {
      return jsonResponse({
        suggestions: [{
          data: {
            company: {
              inn: "7721581040"
            }
          }
        }]
      });
    }
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findById/party")) {
      return jsonResponse({
        suggestions: [{
          data: {
            inn: "7721581040",
            ogrn: "5077746329876",
            name: { short_with_opf: 'ООО "ДЕЙТА КЬЮ"' },
            state: { status: "ACTIVE" },
            management: { name: "Петров П.П." },
            address: { value: "г Москва" },
            okved: "63.11"
          }
        }]
      });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(makeWebhookRequest({ message: { text: "info@dadata.ru", chat: { id: 2 } } }), makeEnv());

  assert.ok(calls.some((call) => call.url.includes("/findByEmail/company")));
  assert.ok(calls.some((call) => call.url.includes("/findById/party")));
  const [body] = collectTelegramBodies(calls, "sendMessage");
  assert.match(body.text, /ДЕЙТА КЬЮ/);
});

test("co:fin uses only findById/party finance block", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findById/party")) {
      return jsonResponse({
        suggestions: [{
          data: {
            inn: "7707083893",
            finance: {
              year: "2024",
              income: 1000000,
              expense: 750000,
              tax_system: "ОСНО"
            }
          }
        }]
      });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(makeWebhookRequest({ callback_query: { id: "cb-fin", data: "co:fin:7707083893", message: { message_id: 11, chat: { id: 3 } } } }), makeEnv());

  const [body] = collectTelegramBodies(calls, "editMessageText");
  assert.match(body.text, /Финансы/);
  assert.match(body.text, /2024/);
  assert.equal(calls.filter((call) => call.url.includes("/findById/party")).length, 1);
  assert.ok(!calls.some((call) => call.url.includes("api.checko.ru")));
});

test("co:lnk deduplicates affiliations, paginates by 5 items, and caps source INNs at 5", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findById/party")) {
      return jsonResponse({
        suggestions: [{
          data: {
            inn: "7707083893",
            management: { inn: "111111111111" },
            managers: [{ inn: "222222222222" }, { inn: "333333333333" }],
            founders: [{ inn: "444444444444" }, { inn: "555555555555" }, { inn: "666666666666" }]
          }
        }]
      });
    }
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findAffiliated/party")) {
      const requestBody = JSON.parse(options.body);
      const sourceInn = requestBody.query;
      const index = Number(sourceInn[0]);
      return jsonResponse({
        suggestions: [
          {
            data: {
              inn: `770000000${index}`,
              name: { short_with_opf: `ООО Связь ${index}` },
              state: { status: index % 2 === 0 ? "ACTIVE" : "LIQUIDATING" },
              relation_type: index % 2 === 0 ? "FOUNDER" : "MANAGER"
            }
          },
          {
            data: {
              inn: "7700000009",
              name: { short_with_opf: "ООО Дубль" },
              state: { status: "ACTIVE" },
              relation_type: "FOUNDER"
            }
          }
        ]
      });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(makeWebhookRequest({ callback_query: { id: "cb-lnk-1", data: "co:lnk:7707083893", message: { message_id: 12, chat: { id: 4 } } } }), makeEnv());
  await worker.fetch(makeWebhookRequest({ callback_query: { id: "cb-lnk-2", data: "co:lnk:7707083893:p:2", message: { message_id: 12, chat: { id: 4 } } } }), makeEnv());

  const affiliationCalls = calls.filter((call) => call.url.includes("/findAffiliated/party"));
  assert.equal(affiliationCalls.length, 10);
  assert.equal(affiliationCalls.slice(0, 5).length, 5);

  const [page1, page2] = collectTelegramBodies(calls, "editMessageText");
  assert.match(page1.text, /Связи/);
  assert.equal((page1.text.match(/• <b>/g) || []).length, 5);
  assert.equal((page2.text.match(/• <b>/g) || []).length, 1);
  assert.ok(page1.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === "co:lnk:7707083893:p:2"));
  assert.ok(!page1.text.includes("api.checko.ru"));
});

test("history degrades gracefully without KV", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ ok: true });
  };

  await worker.fetch(makeWebhookRequest({ message: { text: "/history", chat: { id: 7 } } }), makeEnv());

  const [body] = collectTelegramBodies(calls, "sendMessage");
  assert.match(body.text, /История пока недоступна без хранилища/);
});

test("history lists recent company cards from KV", async () => {
  const calls = [];
  const kv = makeKvNamespace([["history:chat:77", JSON.stringify([{ id: "7707083893", title: "ООО Тест" }])]]);
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ ok: true });
  };

  await worker.fetch(makeWebhookRequest({ message: { text: "/history", chat: { id: 77 } } }), makeEnv({ COMPANY_CACHE: kv }));

  const [body] = collectTelegramBodies(calls, "sendMessage");
  assert.ok(body.reply_markup.inline_keyboard.flat().some((button) => button.callback_data === "select:company:7707083893"));
});
