import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workerSourcePath = path.resolve("worker/worker.js");
const riskSourcePath = path.resolve("worker/services/risk-score.js");

async function loadWorkerModule() {
  const source = await fs.readFile(workerSourcePath, "utf8");
  const riskSource = await fs.readFile(riskSourcePath, "utf8");

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "apicheko-worker-"));
  const tempWorkerPath = path.join(tempRoot, "worker.mjs");
  const tempServicesDir = path.join(tempRoot, "services");
  await fs.mkdir(tempServicesDir, { recursive: true });
  await fs.writeFile(tempWorkerPath, source.replace('./services/risk-score.js', './services/risk-score.mjs'), "utf8");
  await fs.writeFile(path.join(tempServicesDir, "risk-score.mjs"), riskSource, "utf8");

  return import(`${pathToFileURL(tempWorkerPath).href}?v=${Date.now()}`);
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
  return calls
    .filter((call) => call.url.includes(`/${method}`))
    .map((call) => JSON.parse(call.options.body));
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

test("/start shows friendly INN-first screen with persistent reply keyboard", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ ok: true });
  };

  await worker.fetch(makeWebhookRequest({ message: { text: "/start", chat: { id: 1 } } }), makeEnv());

  const [body] = collectTelegramBodies(calls, "sendMessage");
  assert.match(body.text, /Проверка контрагента/);
  assert.match(body.text, /риски и долги/);
  assert.match(body.text, /финансовые сигналы/);
  assert.equal(body.reply_markup.keyboard[0][0].text, "🔎 Новый поиск");
  assert.equal(body.reply_markup.keyboard[1][0].text, "📁 История");
  assert.equal(body.reply_markup.keyboard[1][1].text, "💬 Поддержка");
  assert.equal(body.reply_markup.is_persistent, true);
});

test("/help and support button show friendly help screen", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ ok: true });
  };

  await worker.fetch(makeWebhookRequest({ message: { text: "💬 Поддержка", chat: { id: 1 } } }), makeEnv());

  const [body] = collectTelegramBodies(calls, "sendMessage");
  assert.match(body.text, /Как пользоваться/);
  assert.match(body.text, /Отправьте ИНН/);
  assert.match(body.text, /Если какой-то источник временно недоступен/);
});

test("history reply action degrades gracefully without KV", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ ok: true });
  };

  await worker.fetch(makeWebhookRequest({ message: { text: "📁 История", chat: { id: 1 } } }), makeEnv());

  const [body] = collectTelegramBodies(calls, "sendMessage");
  assert.match(body.text, /История пока недоступна без хранилища/);
  assert.match(body.text, /Можно продолжить через новый поиск/);
});

test("history reply action opens stored successful checks through legacy callbacks", async () => {
  const calls = [];
  const kv = makeKvNamespace([
    ["history:chat:77", JSON.stringify([
      { type: "company", id: "7707083893", title: "ООО Тест", timestamp: "2026-03-23T00:00:00.000Z" },
      { type: "entrepreneur", id: "500100732259", title: "ИП Тест", timestamp: "2026-03-22T00:00:00.000Z" }
    ])]
  ]);
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ ok: true });
  };

  await worker.fetch(makeWebhookRequest({ message: { text: "/history", chat: { id: 77 } } }), makeEnv({ COMPANY_CACHE: kv }));

  const [body] = collectTelegramBodies(calls, "sendMessage");
  const callbacks = body.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
  assert.ok(callbacks.includes("select:company:7707083893"));
  assert.ok(callbacks.includes("select:entrepreneur:500100732259"));
});

test("10-digit INN opens compact main card from DaData only with contextual buttons", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findById/party")) {
      return jsonResponse({
        suggestions: [{
          data: {
            inn: "7707083893",
            name: { short_with_opf: "ООО Тест" },
            state: { status: "ACTIVE", registration_date: 1262304000000 },
            management: { name: "Иванов И.И." },
            address: { value: "Россия, 125009, г Москва, ул Тверская, д 1" },
            capital: { value: 10000 },
            employee_count: 15,
            okved: "62.01",
            successor: { name: "—" }
          }
        }]
      });
    }
    return jsonResponse({ ok: true });
  };

  await worker.fetch(
    makeWebhookRequest({ message: { text: "7707083893", chat: { id: 1 } } }),
    makeEnv({ DADATA_API_KEY: "dadata-key", DADATA_SECRET_KEY: "dadata-secret", DADATA_API_URL: "https://suggestions.dadata.ru/suggestions/api/4_1/rs" })
  );

  const [body] = collectTelegramBodies(calls, "sendMessage");
  const callbacks = body.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
  assert.match(body.text, /Вывод/);
  assert.match(body.text, /Ключевые факты/);
  assert.doesNotMatch(body.text, /Что проверить дальше/);
  assert.ok(callbacks.includes("co:risk:7707083893"));
  assert.ok(callbacks.includes("co:arb:7707083893"));
  assert.ok(callbacks.includes("co:debt:7707083893"));
  assert.ok(callbacks.includes("co:lnk:7707083893"));
  assert.ok(callbacks.includes("co:fin:7707083893"));
  assert.ok(callbacks.includes("co:ctr:7707083893"));
  assert.ok(callbacks.includes("co:succ:7707083893"));
  assert.ok(callbacks.includes("co:his:7707083893"));
  assert.ok(!calls.some((call) => call.url.includes("api.checko.ru") && call.url.includes("/company")));
});

test("old co:main callback remains backward-compatible and has no pager", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findById/party")) {
      return jsonResponse({ suggestions: [{ data: { inn: "7707083893", name: { short_with_opf: "ООО Тест" }, state: { status: "ACTIVE", registration_date: 1262304000000 }, management: { name: "Иванов И.И." }, address: { value: "г Москва, ул Тверская" }, capital: { value: 10000 }, employee_count: 7, okved: "62.01" } }] });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-main", data: "co:main:7707083893", message: { message_id: 5, chat: { id: 1 } } } }),
    makeEnv({ DADATA_API_KEY: "dadata-key", DADATA_SECRET_KEY: "dadata-secret", DADATA_API_URL: "https://suggestions.dadata.ru/suggestions/api/4_1/rs" })
  );

  const [body] = collectTelegramBodies(calls, "editMessageText");
  const callbacks = body.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
  assert.ok(!callbacks.some((callback) => callback.includes(":p:")));
});

test("co:lnk stays on DaData affiliations and paginates by 5 items", async () => {
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
            management: { inn: "111111111111", name: "Руководитель" },
            founders: [{ inn: "222222222222", name: "Учредитель" }]
          }
        }]
      });
    }
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findAffiliated/party")) {
      const scope = JSON.parse(options.body).scope[0];
      const suggestions = Array.from({ length: 6 }, (_, index) => ({
        data: {
          inn: `${scope === "MANAGERS" ? "31" : "41"}${index}`.padEnd(10, String(index)),
          name: { short_with_opf: `${scope === "MANAGERS" ? "ООО Менеджер" : "ООО Учредитель"} ${index + 1}` },
          okved: `62.0${index}`,
          state: { status: index % 2 === 0 ? "ACTIVE" : "LIQUIDATING" }
        }
      }));
      return jsonResponse({ suggestions });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-lnk", data: "co:lnk:7707083893", message: { message_id: 10, chat: { id: 2 } } } }),
    makeEnv({ DADATA_API_KEY: "dadata-key", DADATA_SECRET_KEY: "dadata-secret", DADATA_API_URL: "https://suggestions.dadata.ru/suggestions/api/4_1/rs" })
  );

  const [body] = collectTelegramBodies(calls, "editMessageText");
  assert.match(body.text, /Связи/);
  assert.match(body.text, /Через руководителя: <b>6<\/b>/);
  assert.match(body.text, /Через учредителя: <b>6<\/b>/);
  assert.match(body.text, /Стр\. 1\/3/);
  assert.equal((body.text.match(/^• .*$/gm) || []).length, 8);
  assert.ok(calls.some((call) => call.url.includes("/findAffiliated/party")));
  assert.ok(!calls.some((call) => call.url.includes("api.checko.ru")));
  assert.equal(body.reply_markup.inline_keyboard[0][1].callback_data, "co:lnk:7707083893:p:2");
});

test("pager callback works and old callbacks without page default to first page", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/history")) {
      return jsonResponse({ meta: { status: "ok" }, data: Array.from({ length: 7 }, (_, index) => ({ Дата: `2026-03-${String(20 - index).padStart(2, "0")}`, Описание: `Событие ${index + 1}` })) });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(makeWebhookRequest({ callback_query: { id: "cb-his-1", data: "co:his:7707083893", message: { message_id: 3, chat: { id: 9 } } } }), makeEnv());
  await worker.fetch(makeWebhookRequest({ callback_query: { id: "cb-his-2", data: "co:his:7707083893:p:2", message: { message_id: 3, chat: { id: 9 } } } }), makeEnv());

  const edits = collectTelegramBodies(calls, "editMessageText");
  assert.match(edits[0].text, /Событие 1/);
  assert.doesNotMatch(edits[0].text, /Событие 6/);
  assert.match(edits[1].text, /Событие 6/);
  assert.match(edits[1].text, /Событие 7/);
});

test("co:fin uses Checko finances endpoint and corrected finance UX", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/company")) {
      return jsonResponse({ meta: { status: "ok" }, data: { ЧислСотр: 18, ЗПСреднемес: 120000, НалРежим: { Наим: "УСН" }, РМСП: { Кат: "малое предприятие" } } });
    }
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/finances")) {
      return jsonResponse({ meta: { status: "ok" }, data: { "2024": { 2110: 1200000 } } });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(makeWebhookRequest({ callback_query: { id: "cb-fin", data: "co:fin:7707083893", message: { message_id: 11, chat: { id: 3 } } } }), makeEnv());

  const [body] = collectTelegramBodies(calls, "editMessageText");
  assert.match(body.text, /Средняя зарплата/);
  assert.match(body.text, /Источник отчётности: <b>отчётность за 2024<\/b>/);
  assert.ok(calls.some((call) => call.url.includes("/finances?")));
  assert.ok(!calls.some((call) => call.url.includes("/finance?")));
});

test("co:risk uses corrected fedresurs endpoint and section fallback wording", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/company")) {
      return jsonResponse({ meta: { status: "ok" }, data: { ИНН: "7707083893", Статус: { Наим: "Действующее" }, Налоги: { СумНедоим: 0 } } });
    }
    if (u.hostname === "api.checko.ru" && (u.pathname.endsWith("/finances") || u.pathname.endsWith("/legal-cases") || u.pathname.endsWith("/enforcements") || u.pathname.endsWith("/contracts") || u.pathname.endsWith("/history") || u.pathname.endsWith("/bankruptcy-messages") || u.pathname.endsWith("/fedresurs"))) {
      return jsonResponse({ meta: { status: "ok" }, data: [] });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(makeWebhookRequest({ callback_query: { id: "cb-risk", data: "co:risk:7707083893", message: { message_id: 12, chat: { id: 4 } } } }), makeEnv());

  assert.ok(calls.some((call) => call.url.includes("/fedresurs?")));
  assert.ok(!calls.some((call) => call.url.includes("fedresurs-messages")));
});

test("history screen uses unified history endpoint name, not timeline", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/history")) {
      return jsonResponse({ meta: { status: "ok" }, data: [{ Дата: "2026-03-20", Описание: "Смена руководителя" }] });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(makeWebhookRequest({ callback_query: { id: "cb-his", data: "co:his:7707083893", message: { message_id: 13, chat: { id: 5 } } } }), makeEnv());

  assert.ok(calls.some((call) => call.url.includes("/history?")));
  assert.ok(!calls.some((call) => call.url.includes("/timeline?")));
});

test("section-level fallback screen works for unavailable co:fin", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/finances")) {
      return jsonResponse({ meta: { status: "ok" }, data: {} });
    }
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/company")) {
      return new Response("<html>upstream error</html>", { status: 200 });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(makeWebhookRequest({ callback_query: { id: "cb-fin-fallback", data: "co:fin:7707083893", message: { message_id: 14, chat: { id: 6 } } } }), makeEnv());

  const [body] = collectTelegramBodies(calls, "editMessageText");
  assert.match(body.text, /Раздел временно недоступен/);
  assert.match(body.text, /Источник данных сейчас не отвечает/);
});

test("company context remains one editable message for callbacks", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/legal-cases")) {
      return jsonResponse({ meta: { status: "ok" }, data: [] });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(makeWebhookRequest({ callback_query: { id: "cb-arb", data: "co:arb:7707083893", message: { message_id: 88, chat: { id: 9 } } } }), makeEnv());

  assert.equal(collectTelegramBodies(calls, "sendMessage").length, 0);
  const [edit] = collectTelegramBodies(calls, "editMessageText");
  assert.equal(edit.message_id, 88);
});
