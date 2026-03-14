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
  assert.match(body.text, /сервис проверки контрагентов и банков/);
  assert.equal(body.reply_markup.inline_keyboard[0][0].callback_data, "search:inn");
  assert.equal(body.reply_markup.inline_keyboard[0][1].callback_data, "search:name");
  assert.equal(body.reply_markup.inline_keyboard[1][0].callback_data, "search:bic");
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
  assert.equal(body.reply_markup.inline_keyboard[0][0].callback_data, "co:risk:7707083893");
  assert.equal(body.reply_markup.inline_keyboard[5][0].callback_data, "co:tax:7707083893");
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
  assert.equal(body.reply_markup.inline_keyboard[0][1].callback_data, "resolve12:person:500100732259");
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
  assert.match(body.text, /Финансовая отчетность не найдена/);
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
  assert.match(body.text, /Выберите организацию/);
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

test("main card applies critical risk override and founders fallback", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.pathname.endsWith("/company")) {
      return jsonResponse({
        meta: { status: "ok" },
        data: {
          ИНН: "3525405517",
          ОГРН: "1023500000000",
          НаимСокр: "ООО Риск",
          Статус: { Наим: "Не действует" },
          Учредители: [{ Наим: "Учредитель Тест" }],
          Налоги: { СумНедоим: 0 }
        }
      });
    }
    if (u.pathname.endsWith("/bankruptcy-messages") || u.pathname.endsWith("/fedresurs")) {
      return jsonResponse({ meta: { status: "ok" }, data: [] });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(makeWebhookRequest({ message: { text: "3525405517", chat: { id: 5 } } }), makeEnv());

  const send = calls.find((c) => c.url.includes("/sendMessage"));
  const body = JSON.parse(send.options.body);
  assert.match(body.text, /КРИТИЧЕСКИЙ РИСК/);
  assert.match(body.text, /Компания не действует/);
  assert.match(body.text, /Уровень риска: <b>Критический<\/b>/);
  assert.match(body.text, /Учредитель \(текущий\): Учредитель Тест/);
});

test("co:tax distinguishes missing data from zero values", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.pathname.endsWith("/company")) {
      return jsonResponse({ meta: { status: "ok" }, data: { ИНН: "7707083893" } });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-tax", data: "co:tax:7707083893", message: { message_id: 7, chat: { id: 2 } } } }),
    makeEnv()
  );

  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /Налоговые данные не найдены/);
  assert.doesNotMatch(body.text, /0 ₽/);
});

test("co:ctr renders explicit contract number fallback", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.pathname.endsWith("/contracts")) {
      return jsonResponse({
        meta: { status: "ok" },
        data: [{ Дата: "2019-12-30", Предмет: "", СуммаКонтракта: 320447 }]
      });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-ctr", data: "co:ctr:7707083893", message: { message_id: 8, chat: { id: 3 } } } }),
    makeEnv()
  );

  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /Номер: нет данных/);
  assert.doesNotMatch(body.text, /• —/);
});

test("co:lnk shows only non-empty sections and collapsed empty note", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.pathname.endsWith("/company")) {
      return jsonResponse({
        meta: { status: "ok" },
        data: {
          ИНН: "7707083893",
          Руковод: [{ ФИО: "Иванов И.И." }],
          ЮрАдрес: { АдресРФ: "Москва" }
        }
      });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-lnk", data: "co:lnk:7707083893", message: { message_id: 9, chat: { id: 3 } } } }),
    makeEnv()
  );

  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /Связи по руководителю: Иванов И\.И\./);
  assert.match(body.text, /Связи по адресу: Москва/);
  assert.match(body.text, /Нет данных по: учредителям, телефону, email/);
  assert.doesNotMatch(body.text, /Связи по телефону:/);
});
