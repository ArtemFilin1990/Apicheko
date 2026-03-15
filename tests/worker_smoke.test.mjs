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
  await fs.writeFile(tempWorkerPath, source, "utf8");
  await fs.writeFile(path.join(tempServicesDir, "risk-score.js"), riskSource, "utf8");

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


function makeKvNamespace() {
  const store = new Map();
  return {
    stats: { get: 0, put: 0 },
    async get(key, type) {
      this.stats.get += 1;
      const raw = store.get(key);
      if (raw === undefined) return null;
      if (type === "json") return JSON.parse(raw);
      return raw;
    },
    async put(key, value) {
      this.stats.put += 1;
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
  assert.match(body.text, /Проверка контрагента/);
  assert.equal(body.reply_markup.inline_keyboard[0][0].callback_data, "search:inn");
  assert.equal(body.reply_markup.inline_keyboard[0][1].callback_data, "search:name");
  assert.equal(body.reply_markup.inline_keyboard[1][0].callback_data, "search:bic");
  assert.equal(body.reply_markup.inline_keyboard[1][1].callback_data, "search:email");
});

test("10-digit INN opens main card with compact section keyboard", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.checko.ru") {
      const endpoint = u.pathname.split("/").pop();
      if (endpoint === "company") {
        return jsonResponse({ meta: { status: "ok" }, data: { ИНН: "7707083893", ОГРН: "1027700132195", НаимСокр: "ООО Тест", Статус: { Наим: "Действующее" }, ОКВЭД: { Код: "62.01", Наим: "Разработка ПО" }, ЮрАдрес: { АдресРФ: "Москва" }, Руковод: [{ ФИО: "Иванов И.И." }], Налоги: { СумНедоим: 0 }, Учред: [{ Наим: "ООО Учредитель" }] } });
      }
      if (["finance", "legal-cases", "enforcements", "contracts"].includes(endpoint)) {
        return jsonResponse({ meta: { status: "ok" }, data: {} });
      }
    }
    return jsonResponse({ ok: true });
  };

  await worker.fetch(makeWebhookRequest({ message: { text: "7707083893", chat: { id: 1 } } }), makeEnv());
  const send = calls.find((c) => c.url.includes("/sendMessage"));
  const body = JSON.parse(send.options.body);
  assert.match(body.text, /ООО Тест/);
  assert.doesNotMatch(body.text, /КРИТИЧЕСКИЙ РИСК/);
  assert.equal(body.reply_markup.inline_keyboard[0][0].callback_data, "co:risk:7707083893");
  assert.equal(body.reply_markup.inline_keyboard[1][1].callback_data, "co:debt:7707083893");
  assert.equal(body.reply_markup.inline_keyboard[3][1].callback_data, "co:tax:7707083893");
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

test("co:fin uses /finance and shows empty-state without service error", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.pathname.endsWith("/finance")) return jsonResponse({ meta: { status: "ok" }, data: {} });
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

test("Checko non-JSON response returns service error instead of crashing", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/company")) {
      return new Response("<html>bad gateway</html>", { status: 200 });
    }
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(makeWebhookRequest({ message: { text: "7707083893", chat: { id: 1 } } }), makeEnv());
  const send = calls.find((c) => c.url.includes("/sendMessage"));
  const body = JSON.parse(send.options.body);
  assert.equal(body.text, "⚠️ Ошибка сервиса Checko");
});

test("Checko payload without meta.status is treated as service error", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/company")) {
      return jsonResponse({ meta: { message: "ok" }, data: { ИНН: "7707083893" } });
    }
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(makeWebhookRequest({ message: { text: "7707083893", chat: { id: 1 } } }), makeEnv());
  const send = calls.find((c) => c.url.includes("/sendMessage"));
  const body = JSON.parse(send.options.body);
  assert.equal(body.text, "⚠️ Ошибка сервиса Checko");
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

test("main card keeps risk details in risks screen", async () => {
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
    if (u.pathname.endsWith("/finance")) {
      return jsonResponse({ meta: { status: "ok" }, data: { "2023": { 2110: 1000000 } } });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(makeWebhookRequest({ message: { text: "3525405517", chat: { id: 5 } } }), makeEnv());

  const send = calls.find((c) => c.url.includes("/sendMessage"));
  const body = JSON.parse(send.options.body);
  assert.doesNotMatch(body.text, /КРИТИЧЕСКИЙ РИСК/);
  assert.match(body.text, /Выручка \(последний год\): 1\s000\s000 ₽ \(2023\)/);
  assert.match(body.text, /Учредитель \(текущий\): Учредитель Тест/);
});

test("co:risk renders deterministic score and reasons for inactive company", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.pathname.endsWith("/company")) {
      return jsonResponse({ meta: { status: "ok" }, data: { ИНН: "3525405517", Статус: { Наим: "Не действует" }, Налоги: { СумНедоим: 1200000 } } });
    }
    if (u.pathname.endsWith("/bankruptcy-messages") || u.pathname.endsWith("/fedresurs")) {
      return jsonResponse({ meta: { status: "ok" }, data: [{ id: 1 }] });
    }
    if (u.pathname.endsWith("/legal-cases") || u.pathname.endsWith("/enforcements") || u.pathname.endsWith("/contracts") || u.pathname.endsWith("/finance")) {
      return jsonResponse({ meta: { status: "ok" }, data: [] });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-risk", data: "co:risk:3525405517", message: { message_id: 7, chat: { id: 2 } } } }),
    makeEnv()
  );

  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /Риск: <b>Критический<\/b>/);
  assert.match(body.text, /Score: <b>\d+\/100<\/b>/);
  assert.match(body.text, /Компания недействующая/);
  assert.match(body.text, /Что делать:/);
});

test("co:risk shows low or medium profile for normal company", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/company")) {
      return jsonResponse({
        meta: { status: "ok" },
        data: {
          ИНН: "7707083893",
          Статус: { Наим: "Действующее" },
          ДатаРег: "2010-01-01",
          Налоги: { СумНедоим: 0 },
          Контакты: { Тел: ["+7 495 123-45-67"], Емэйл: ["info@test.ru"] },
          ЮрАдрес: { Массовый: false }
        }
      });
    }
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/finance")) {
      return jsonResponse({ meta: { status: "ok" }, data: { "2023": { 2110: 5000000, 2400: 400000 } } });
    }
    if (u.pathname.endsWith("/bankruptcy-messages") || u.pathname.endsWith("/fedresurs") || u.pathname.endsWith("/legal-cases") || u.pathname.endsWith("/enforcements") || u.pathname.endsWith("/contracts")) {
      return jsonResponse({ meta: { status: "ok" }, data: [] });
    }
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findById/party")) {
      return jsonResponse({ suggestions: [{ data: { employee_count: 24, invalid: false } }] });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-risk-ok", data: "co:risk:7707083893", message: { message_id: 17, chat: { id: 2 } } } }),
    makeEnv({ DADATA_API_KEY: "dadata-key", DADATA_SECRET_KEY: "dadata-secret", DADATA_API_URL: "https://suggestions.dadata.ru/suggestions/api/4_1/rs" })
  );

  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /Риск: <b>(Низкий|Средний)<\/b>/);
  assert.match(body.text, /Плюсы:/);
  assert.match(body.text, /Что делать:/);
});

test("co:risk handles partial data without crash", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.hostname === "api.checko.ru") {
      return jsonResponse({ meta: { status: "ok" }, data: {} });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-risk-empty", data: "co:risk:7707083893", message: { message_id: 19, chat: { id: 2 } } } }),
    makeEnv()
  );

  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /Неизвестно:/);
  assert.match(body.text, /Score: <b>\d+\/100<\/b>/);
});

test("co:debt aggregates company taxes with enforcements", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.pathname.endsWith("/company")) {
      return jsonResponse({ meta: { status: "ok" }, data: { Налоги: { СумНедоим: 5000, СумПениШтр: 120 } } });
    }
    if (u.pathname.endsWith("/enforcements")) {
      return jsonResponse({ meta: { status: "ok" }, data: [{ НомерИП: "123", Дата: "2020-01-02", Сумма: 7000, Предмет: "Штраф" }] });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-debt", data: "co:debt:7707083893", message: { message_id: 12, chat: { id: 2 } } } }),
    makeEnv()
  );

  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /Налоговая задолженность: 5\s000 ₽/);
  assert.match(body.text, /Исполнительные производства: 1/);
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

test("search:email callback opens email hint screen", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ ok: true });
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-email", data: "search:email", message: { message_id: 5, chat: { id: 4 } } } }),
    makeEnv()
  );

  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /Поиск по email/);
});

test("email lookup opens company card by INN via DaData", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findByEmail/company")) {
      return jsonResponse({ suggestions: [{ data: { company: { inn: "7707083893" } } }] });
    }
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findById/party")) {
      return jsonResponse({ suggestions: [{ data: { employee_count: 15, invalid: false, phones: [{ value: "+7 495 111-22-33" }] } }] });
    }
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/company")) {
      return jsonResponse({ meta: { status: "ok" }, data: { ИНН: "7707083893", НаимСокр: "ООО Email Тест", Статус: { Наим: "Действующее" }, ОКВЭД: { Код: "62.01", Наим: "Разработка ПО" }, ЮрАдрес: { АдресРФ: "Москва" }, Руковод: [{ ФИО: "Иванов И.И." }] } });
    }
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/finance")) {
      return jsonResponse({ meta: { status: "ok" }, data: {} });
    }
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ message: { text: "info@example.ru", chat: { id: 1 } } }),
    makeEnv({ DADATA_API_KEY: "dadata-key", DADATA_SECRET_KEY: "dadata-secret", DADATA_API_URL: "https://suggestions.dadata.ru/suggestions/api/4_1/rs" })
  );

  const send = calls.find((c) => c.url.includes("/sendMessage"));
  const body = JSON.parse(send.options.body);
  assert.match(body.text, /ООО Email Тест/);
  assert.match(body.text, /DaData/);
  assert.ok(calls.some((c) => c.url.includes("/findByEmail/company")));
});

test("email lookup empty-state when company is not found", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findByEmail/company")) {
      return jsonResponse({ suggestions: [] });
    }
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ message: { text: "unknown@example.ru", chat: { id: 1 } } }),
    makeEnv({ DADATA_API_KEY: "dadata-key", DADATA_SECRET_KEY: "dadata-secret", DADATA_API_URL: "https://suggestions.dadata.ru/suggestions/api/4_1/rs" })
  );

  const send = calls.find((c) => c.url.includes("/sendMessage"));
  const body = JSON.parse(send.options.body);
  assert.match(body.text, /Компания по email не найдена/);
});

test("co:lnk renders DaData affiliated companies", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/company")) {
      return jsonResponse({ meta: { status: "ok" }, data: { ИНН: "7707083893", Руковод: [{ ФИО: "Иванов И.И." }] } });
    }
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findById/party")) {
      return jsonResponse({ suggestions: [{ data: { founders: [{ inn: "500000000000" }], managers: [{ inn: "600000000000" }] } }] });
    }
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findAffiliated/party")) {
      const payload = JSON.parse(options.body);
      if (payload.query === "500000000000") {
        return jsonResponse({ suggestions: [{ data: { inn: "1111111111", name: { short_with_opf: "ООО Альфа" }, state: { status: "ACTIVE" }, address: { data: { city: "Казань" } } } }] });
      }
      return jsonResponse({ suggestions: [{ data: { inn: "2222222222", name: { short_with_opf: "ООО Бета" }, state: { status: "ACTIVE" }, okved: "62.01" } }] });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-lnk-aff", data: "co:lnk:7707083893", message: { message_id: 9, chat: { id: 3 } } } }),
    makeEnv({ DADATA_API_KEY: "dadata-key", DADATA_SECRET_KEY: "dadata-secret", DADATA_API_URL: "https://suggestions.dadata.ru/suggestions/api/4_1/rs" })
  );

  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /Аффилированные компании/);
  assert.match(body.text, /ООО Альфа/);
  assert.match(body.text, /через учредителя/);
  assert.match(body.text, /ООО Бета/);
});

test("DaData outage does not break Checko flow", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findById/party")) {
      return new Response("upstream failed", { status: 502 });
    }
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/company")) {
      return jsonResponse({ meta: { status: "ok" }, data: { ИНН: "7707083893", НаимСокр: "ООО Надежность", Статус: { Наим: "Действующее" }, ОКВЭД: { Код: "62.01", Наим: "Разработка ПО" }, ЮрАдрес: { АдресРФ: "Москва" }, Руковод: [{ ФИО: "Иванов И.И." }] } });
    }
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/finance")) {
      return jsonResponse({ meta: { status: "ok" }, data: {} });
    }
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ message: { text: "7707083893", chat: { id: 1 } } }),
    makeEnv({ DADATA_API_KEY: "dadata-key", DADATA_SECRET_KEY: "dadata-secret", DADATA_API_URL: "https://suggestions.dadata.ru/suggestions/api/4_1/rs" })
  );

  const send = calls.find((c) => c.url.includes("/sendMessage"));
  const body = JSON.parse(send.options.body);
  assert.match(body.text, /ООО Надежность/);
});


test("repeated company lookup uses KV cache", async () => {
  const kv = makeKvNamespace();
  let companyCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/company")) {
      companyCalls += 1;
      return jsonResponse({ meta: { status: "ok" }, data: { ИНН: "7707083893", НаимСокр: "ООО Кеш", Статус: { Наим: "Действующее" }, ОКВЭД: { Код: "62.01", Наим: "Разработка ПО" }, ЮрАдрес: { АдресРФ: "Москва" }, Руковод: [{ ФИО: "Иванов И.И." }] } });
    }
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/finance")) {
      return jsonResponse({ meta: { status: "ok" }, data: {} });
    }
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.hostname === "suggestions.dadata.ru") return jsonResponse({ suggestions: [] });
    throw new Error(`Unexpected URL ${u}`);
  };

  const env = makeEnv({ COMPANY_CACHE: kv });
  await worker.fetch(makeWebhookRequest({ message: { text: "7707083893", chat: { id: 1 } } }), env);
  await worker.fetch(makeWebhookRequest({ message: { text: "7707083893", chat: { id: 1 } } }), env);

  assert.equal(companyCalls, 1);
  assert.ok(kv.stats.get >= 2);
  assert.ok(kv.stats.put >= 1);
});

test("KV get failure does not break flow", async () => {
  const brokenKv = {
    async get() {
      throw new Error("KV unavailable");
    },
    async put() {
      throw new Error("KV unavailable");
    }
  };

  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/company")) {
      return jsonResponse({ meta: { status: "ok" }, data: { ИНН: "7707083893", НаимСокр: "ООО Без KV", Статус: { Наим: "Действующее" }, ОКВЭД: { Код: "62.01", Наим: "Разработка ПО" }, ЮрАдрес: { АдресРФ: "Москва" }, Руковод: [{ ФИО: "Иванов И.И." }] } });
    }
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/finance")) {
      return jsonResponse({ meta: { status: "ok" }, data: {} });
    }
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.hostname === "suggestions.dadata.ru") return jsonResponse({ suggestions: [] });
    throw new Error(`Unexpected URL ${u}`);
  };

  const response = await worker.fetch(
    makeWebhookRequest({ message: { text: "7707083893", chat: { id: 1 } } }),
    makeEnv({ COMPANY_CACHE: brokenKv })
  );
  assert.equal(response.status, 200);
});
