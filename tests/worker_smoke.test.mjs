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

test("/start sends INN-first screen without buttons", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ ok: true });
  };

  await worker.fetch(makeWebhookRequest({ message: { text: "/start", chat: { id: 1 } } }), makeEnv());
  const body = JSON.parse(calls[0].options.body);
  assert.match(body.text, /Проверка контрагента/);
  assert.match(body.text, /Отправьте ИНН/);
  assert.match(body.text, /10 цифр — компания/);
  assert.match(body.text, /12 цифр — ИП или физлицо/);
  assert.equal(body.reply_markup.keyboard[0][0].text, "🔎 Новый поиск");
  assert.equal(body.reply_markup.keyboard[1][0].text, "📁 История");
});

test("10-digit INN opens main card from DaData only", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findById/party")) {
      return jsonResponse({
        suggestions: [{
          data: {
            inn: "7707083893",
            ogrn: "1027700132195",
            kpp: "770701001",
            name: { short_with_opf: "ООО Тест", full_with_opf: "Общество с ограниченной ответственностью Тест" },
            state: { status: "ACTIVE", registration_date: 1262304000000, actuality_date: 1704067200000 },
            okved: "62.01",
            opf: { full: "Общество с ограниченной ответственностью" },
            branch_count: 1,
            employee_count: 15,
            finance: { income: 1000000, expense: 800000 },
            management: { name: "Иванов И.И.", post: "Генеральный директор" },
            founders: [{ name: "ООО Учредитель" }],
            address: { value: "г Москва, ул Тверская" },
            phones: [{ value: "+7 495 111-22-33" }],
            emails: [{ value: "info@test.ru" }],
            invalid: false
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
  const send = calls.find((c) => c.url.includes("/sendMessage"));
  const body = JSON.parse(send.options.body);
  assert.match(body.text, /ООО Тест/);
  assert.match(body.text, /Дата регистрации/);
  assert.match(body.text, /Руководитель/);
  assert.match(body.text, /Вывод/);
  assert.ok(!calls.some((c) => c.url.includes("api.checko.ru") && c.url.includes("/company")));
  assert.ok(!calls.some((c) => c.url.includes("api.checko.ru") && c.url.includes("/finances")));
  const callbacks = body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(callbacks.includes("co:risk:7707083893"));
  assert.ok(callbacks.includes("co:arb:7707083893"));
  assert.ok(callbacks.includes("co:debt:7707083893"));
  assert.ok(callbacks.includes("co:lnk:7707083893"));
  assert.ok(callbacks.includes("co:fin:7707083893"));
  assert.ok(callbacks.includes("co:succ:7707083893"));
});

test("10-digit INN hides Checko buttons when CHECKO_API_KEY is missing", async () => {
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
            state: { status: "ACTIVE", registration_date: 1262304000000 }
          }
        }]
      });
    }
    return jsonResponse({ ok: true });
  };

  await worker.fetch(
    makeWebhookRequest({ message: { text: "7707083893", chat: { id: 1 } } }),
    makeEnv({ CHECKO_API_KEY: "", DADATA_API_KEY: "dadata-key", DADATA_SECRET_KEY: "dadata-secret", DADATA_API_URL: "https://suggestions.dadata.ru/suggestions/api/4_1/rs" })
  );

  const send = calls.find((c) => c.url.includes("/sendMessage"));
  const body = JSON.parse(send.options.body);
  const callbacks = body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);

  assert.ok(callbacks.includes("co:lnk:7707083893"));
  assert.ok(!callbacks.includes("co:risk:7707083893"));
  assert.ok(!callbacks.includes("co:tax:7707083893"));
  assert.ok(!callbacks.includes("co:fin:7707083893"));
});

test("co:main keeps old callback contract and renders full card without pager", async () => {
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
            name: { short_with_opf: "ООО Тест" },
            state: { status: "ACTIVE", registration_date: 1262304000000 },
            management: { name: "Иванов И.И." },
            address: { value: "Россия, 125009, г Москва, ул Тверская, д 1" },
            capital: { value: 10000 },
            employee_count: 7,
            okved: "62.01"
          }
        }]
      });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-main-page", data: "co:main:7707083893", message: { message_id: 15, chat: { id: 7 } } } }),
    makeEnv({ DADATA_API_KEY: "dadata-key", DADATA_SECRET_KEY: "dadata-secret", DADATA_API_URL: "https://suggestions.dadata.ru/suggestions/api/4_1/rs" })
  );

  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /Вывод/);
  assert.match(body.text, /Ключевые факты/);
  assert.match(body.text, /Что проверить дальше/);
  const callbacks = body.reply_markup.inline_keyboard.flat().map((button) => button.callback_data);
  assert.ok(!callbacks.some((callback) => callback.includes(":p:")));
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
    if (u.pathname.endsWith("/company")) return jsonResponse({ meta: { status: "ok" }, data: {} });
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
  assert.match(body.text, /отч[её]тность не найдена/i);
  assert.ok(calls.some((c) => c.url.includes("/finances")));
});

test("co:fin renders bo.nalog.ru report links without object dump", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.pathname.endsWith("/company")) return jsonResponse({ meta: { status: "ok" }, data: {} });
    if (u.pathname.endsWith("/finances")) {
      return jsonResponse({
        meta: { status: "ok" },
        data: { "2023": { 2110: 100000, 2400: 5000, 1600: 90000, 1300: 45000 } },
        "bo.nalog.ru": { Отчет: { "2023": "https://bo.nalog.ru/2023.pdf", "2022": "https://bo.nalog.ru/2022.pdf" } }
      });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-fin-reports", data: "co:fin:7707083893", message: { message_id: 40, chat: { id: 6 } } } }),
    makeEnv()
  );

  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /Источник отчётности: <b>есть ссылки ФНС<\/b>/);
  assert.match(body.text, /2023: выручка/);
  assert.doesNotMatch(body.text, /\[object Object\]/);
});

test("Checko non-JSON response shows section unavailable for co:risk", async () => {
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

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-risk-checko", data: "co:risk:7707083893", message: { message_id: 4, chat: { id: 2 } } } }),
    makeEnv()
  );
  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /Раздел временно недоступен/);
  assert.match(body.text, /Источник данных сейчас не отвечает/);
  assert.doesNotMatch(body.text, /^⚠️ Ошибка сервиса Checko$/);
});

test("Checko payload without meta.status shows section unavailable for co:risk", async () => {
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

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-risk-checko-meta", data: "co:risk:7707083893", message: { message_id: 5, chat: { id: 2 } } } }),
    makeEnv()
  );
  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /Раздел временно недоступен/);
  assert.match(body.text, /Источник данных сейчас не отвечает/);
  assert.doesNotMatch(body.text, /^⚠️ Ошибка сервиса Checko$/);
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

test("main card stays DaData-only while co:risk still uses Checko", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findById/party")) {
      return jsonResponse({ suggestions: [{ data: { inn: "3525405517", name: { short_with_opf: "ООО Риск" }, state: { status: "ACTIVE" }, management: { name: "Директор" } } }] });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ message: { text: "3525405517", chat: { id: 5 } } }),
    makeEnv({ DADATA_API_KEY: "dadata-key", DADATA_SECRET_KEY: "dadata-secret", DADATA_API_URL: "https://suggestions.dadata.ru/suggestions/api/4_1/rs" })
  );

  const send = calls.find((c) => c.url.includes("/sendMessage"));
  const body = JSON.parse(send.options.body);
  assert.match(body.text, /ООО Риск/);
  assert.ok(!calls.some((c) => c.url.includes("api.checko.ru") && c.url.includes("/company")));
  assert.ok(!calls.some((c) => c.url.includes("api.checko.ru") && c.url.includes("/finances")));
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
    if (u.pathname.endsWith("/legal-cases") || u.pathname.endsWith("/enforcements") || u.pathname.endsWith("/contracts") || u.pathname.endsWith("/finances") || u.pathname.endsWith("/history")) {
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
  assert.match(body.text, /Есть критический стоп-фактор/);
  assert.match(body.text, /Что это значит/);
  assert.match(body.text, /Что делать/);
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
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/finances")) {
      return jsonResponse({ meta: { status: "ok" }, data: { "2023": { 2110: 5000000, 2400: 400000 } } });
    }
    if (u.pathname.endsWith("/bankruptcy-messages") || u.pathname.endsWith("/fedresurs") || u.pathname.endsWith("/legal-cases") || u.pathname.endsWith("/enforcements") || u.pathname.endsWith("/contracts") || u.pathname.endsWith("/history")) {
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
  assert.match(body.text, /Критичных факторов не обнаружено|Есть отдельные сигналы, которые стоит учесть/);

  assert.match(body.text, /Что это значит/);
  assert.match(body.text, /Что делать/);
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

  assert.match(body.text, /Данных для уверенного вывода не хватает/);
});



test("risk scoring is deterministic for the same input", async () => {
  const riskModule = await import(`${pathToFileURL(riskSourcePath).href}?v=${Date.now()}`);
  const payload = {
    companyData: {
      Статус: { Наим: "Действующее" },
      ДатаРег: "2014-01-01",
      Налоги: { СумНедоим: 0 },
      Контакты: { Тел: ["+7 000 000 00 00"], Емэйл: ["a@b.ru"] }
    },
    financesData: { "2023": { 2110: 4000000, 2400: 500000 } },
    legalData: [],
    fsspData: [],
    contractsData: [],
    bankruptcyData: [],
    fedresursData: [],
    historyData: [],
    dadataParty: { employee_count: 15, invalid: false, phones: [{ value: "+7" }] }
  };

  const one = riskModule.calculateCompanyRiskScore(payload);
  const two = riskModule.calculateCompanyRiskScore(payload);
  assert.deepEqual(one, two);
});

test("risk scoring rejects inactive company with bankruptcy", async () => {
  const riskModule = await import(`${pathToFileURL(riskSourcePath).href}?v=${Date.now()}`);
  const result = riskModule.calculateCompanyRiskScore({
    companyData: {
      Статус: { Наим: "Не действует" },
      Налоги: { СумНедоим: 0 }
    },
    bankruptcyData: [{ id: 1 }],
    fedresursData: []
  });

  assert.equal(result.decision, "reject_or_legal_review");
  assert.equal(result.level, "critical");
});

test("risk scoring keeps normal company at low or medium risk", async () => {
  const riskModule = await import(`${pathToFileURL(riskSourcePath).href}?v=${Date.now()}`);
  const result = riskModule.calculateCompanyRiskScore({
    companyData: {
      Статус: { Наим: "Действующее" },
      ДатаРег: "2012-01-01",
      Налоги: { СумНедоим: 0 },
      Контакты: { Тел: ["+7 495 123-45-67"], Емэйл: ["info@test.ru"] }
    },
    financesData: { "2023": { 2110: 7000000, 2400: 900000 } },
    legalData: [],
    fsspData: [],
    contractsData: [{ id: 1 }],
    historyData: [],
    bankruptcyData: [],
    fedresursData: [],
    dadataParty: { employee_count: 20, invalid: false, phones: [{ value: "+7 495 123-45-67" }] }
  });

  assert.match(result.level, /^(low|medium)$/);
  assert.match(result.decision, /^(approve_standard|approve_caution)$/);
});

test("single defendant case with zero claim stays low-penalty", async () => {
  const riskModule = await import(`${pathToFileURL(riskSourcePath).href}?v=${Date.now()}`);
  const result = riskModule.calculateCompanyRiskScore({
    companyData: { Статус: { Наим: "Действующее" }, ДатаРег: "2016-01-01" },
    legalData: [{ Дата: "2025-06-01", Роль: "Ответчик", СуммаИска: 0, Истец: "ООО Истец" }]
  });

  assert.ok(!result.factors.some((factor) => factor.code === "DEFENDANT_CASES_24M_MEDIUM" || factor.code === "DEFENDANT_CASES_24M_HIGH"));
  assert.ok(!result.factors.some((factor) => factor.code === "DEFENDANT_CASES_24M_LOW"));
});

test("ambiguous role does not trigger strong defendant penalty", async () => {
  const riskModule = await import(`${pathToFileURL(riskSourcePath).href}?v=${Date.now()}`);
  const result = riskModule.calculateCompanyRiskScore({
    companyData: { Статус: { Наим: "Действующее" }, ДатаРег: "2018-01-01" },
    legalData: [{ Дата: "2025-05-01", Описание: "Стороны спора не указаны", СуммаИска: 450000 }]
  });

  assert.ok(!result.factors.some((factor) => factor.code.startsWith("DEFENDANT_CASES_24M")));
});

test("three confirmed defendant cases create material litigation pressure", async () => {
  const riskModule = await import(`${pathToFileURL(riskSourcePath).href}?v=${Date.now()}`);
  const result = riskModule.calculateCompanyRiskScore({
    companyData: { Статус: { Наим: "Действующее" }, ДатаРег: "2015-01-01" },
    legalData: [
      { Дата: "2025-01-10", Роль: "Ответчик", СуммаИска: 250000, Истец: "ООО Истец 1", Предмет: "Долг" },
      { Дата: "2025-02-14", Роль: "Ответчик", СуммаИска: 150000, Истец: "ООО Истец 2", Предмет: "Поставка" },
      { Дата: "2025-03-20", Роль: "Ответчик", СуммаИска: 120000, Истец: "ООО Истец 3", Предмет: "Услуги" }
    ]
  });

  assert.ok(result.factors.some((factor) => factor.code === "DEFENDANT_CASES_24M_MEDIUM" || factor.code === "DEFENDANT_CASES_24M_HIGH"));
});

test("confirmed defendant pattern plus debt pressure escalates decision", async () => {
  const riskModule = await import(`${pathToFileURL(riskSourcePath).href}?v=${Date.now()}`);
  const result = riskModule.calculateCompanyRiskScore({
    companyData: {
      Статус: { Наим: "Действующее" },
      ДатаРег: "2014-01-01",
      Налоги: { СумНедоим: 250000 }
    },
    fsspData: [{ id: 1 }],
    legalData: [
      { Дата: "2025-01-10", Роль: "Ответчик", СуммаИска: 250000, Истец: "ООО Истец 1", Предмет: "Долг" },
      { Дата: "2025-02-14", Роль: "Ответчик", СуммаИска: 350000, Истец: "ООО Истец 2", Предмет: "Долг" },
      { Дата: "2025-03-20", Роль: "Ответчик", СуммаИска: 420000, Истец: "ООО Истец 3", Предмет: "Долг" },
      { Дата: "2025-04-20", Роль: "Ответчик", СуммаИска: 520000, Истец: "ООО Истец 4", Предмет: "Долг" },
      { Дата: "2025-05-20", Роль: "Ответчик", СуммаИска: 120000, Истец: "ООО Истец 5", Предмет: "Долг" },
      { Дата: "2025-06-20", Роль: "Ответчик", СуммаИска: 110000, Истец: "ООО Истец 6", Предмет: "Долг" }
    ]
  });

  assert.match(result.decision, /^(prepay_only|reject_or_legal_review)$/);
  assert.ok(result.factors.some((factor) => factor.code === "CMP_DEFENDANT_DEBT_PRESSURE"));
});

test("repeated defendant pattern adds extra penalty", async () => {
  const riskModule = await import(`${pathToFileURL(riskSourcePath).href}?v=${Date.now()}`);
  const result = riskModule.calculateCompanyRiskScore({
    companyData: { Статус: { Наим: "Действующее" }, ДатаРег: "2013-01-01" },
    legalData: [
      { Дата: "2025-01-10", Роль: "Ответчик", СуммаИска: 250000, Истец: "ООО Истец", Предмет: "Долг" },
      { Дата: "2025-02-14", Роль: "Ответчик", СуммаИска: 150000, Истец: "ООО Истец", Предмет: "Долг" },
      { Дата: "2025-03-20", Роль: "Ответчик", СуммаИска: 120000, Истец: "ООО Истец", Предмет: "Долг" }
    ]
  });

  assert.ok(result.factors.some((factor) => factor.code === "DEFENDANT_CASES_24M_PATTERN"));
});

test("general legal load is not double-counted when defendant pressure exists", async () => {
  const riskModule = await import(`${pathToFileURL(riskSourcePath).href}?v=${Date.now()}`);
  const result = riskModule.calculateCompanyRiskScore({
    companyData: { Статус: { Наим: "Действующее" }, ДатаРег: "2011-01-01" },
    legalData: [
      { Дата: "2025-01-10", Роль: "Ответчик", СуммаИска: 250000, Истец: "ООО Истец 1", Предмет: "Долг" },
      { Дата: "2025-02-14", Роль: "Ответчик", СуммаИска: 350000, Истец: "ООО Истец 2", Предмет: "Поставка" },
      { Дата: "2025-03-20", Роль: "Ответчик", СуммаИска: 420000, Истец: "ООО Истец 3", Предмет: "Услуги" },
      { Дата: "2025-04-20", Роль: "Истец", СуммаИска: 120000, Истец: "Компания", Предмет: "Взыскание" },
      { Дата: "2025-05-20", Роль: "Истец", СуммаИска: 80000, Истец: "Компания", Предмет: "Взыскание" }
    ]
  });

  assert.ok(result.factors.some((factor) => factor.code === "DEFENDANT_CASES_24M_MEDIUM" || factor.code === "DEFENDANT_CASES_24M_HIGH"));
  assert.ok(!result.factors.some((factor) => factor.code === "LEGAL_LOAD_GENERAL"));
});

test("missing finance for young company does not create false high risk", async () => {
  const riskModule = await import(`${pathToFileURL(riskSourcePath).href}?v=${Date.now()}`);
  const result = riskModule.calculateCompanyRiskScore({
    companyData: {
      Статус: { Наим: "Действующее" },
      ДатаРег: "2025-01-01",
      Налоги: { СумНедоим: 0 },
      Контакты: { Тел: ["+7 495 123-45-67"] }
    },
    legalData: [],
    fsspData: [],
    dadataParty: { invalid: false, phones: [{ value: "+7 495 123-45-67" }] }
  });

  assert.notEqual(result.level, "high");
  assert.notEqual(result.level, "critical");
  assert.ok(!result.factors.some((factor) => factor.code === "FINANCE_GAP"));
});

test("telegram formatter remains compact and valid", async () => {
  const riskModule = await import(`${pathToFileURL(riskSourcePath).href}?v=${Date.now()}`);
  const result = riskModule.calculateCompanyRiskScore({
    companyData: {
      Статус: { Наим: "Действующее" },
      ДатаРег: "2010-01-01",
      Налоги: { СумНедоим: 120000 },
      Контакты: { Тел: ["+7 495 123-45-67"] }
    },
    financesData: { "2023": { 2110: 4000000, 2400: 500000 } },
    legalData: [{ Дата: "2025-02-01", Роль: "Ответчик", СуммаИска: 350000, Истец: "ООО Истец" }]
  });

  const text = riskModule.formatRiskResultForTelegram(result);
  assert.match(text, /Риск: <b>/);
  assert.match(text, /Score: <b>\d+\/100<\/b>/);
  assert.match(text, /Решение: <b>/);
  assert.match(text, /Почему:/);
  assert.match(text, /Что делать:/);
  assert.match(text, /Итог:/);
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
  assert.match(body.text, /Недоимка: <b>5[\s ]000 ₽<\/b>/);
  assert.match(body.text, /ФССП: <b>1<\/b>/);
});

test("co:own shows missing Checko config message without generic crash", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.checko.ru") throw new Error("Should not call Checko without key");
    return jsonResponse({ ok: true });
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-own-no-key", data: "co:own:7707083893", message: { message_id: 21, chat: { id: 6 } } } }),
    makeEnv({ CHECKO_API_KEY: "" })
  );

  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /Источник данных не настроен/);
  assert.match(body.text, /Раздел временно недоступен/);
});

test("co:tax shows missing Checko config message without generic crash", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.checko.ru") throw new Error("Should not call Checko without key");
    return jsonResponse({ ok: true });
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-tax-no-key", data: "co:tax:7707083893", message: { message_id: 22, chat: { id: 6 } } } }),
    makeEnv({ CHECKO_API_KEY: "" })
  );

  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /Источник данных не настроен/);
  assert.match(body.text, /Раздел временно недоступен/);
});

test("co:debt shows section-level temporary unavailable message on Checko failure", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.pathname.endsWith("/company")) {
      return new Response("<html>bad gateway</html>", { status: 200 });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-debt-unavailable", data: "co:debt:7707083893", message: { message_id: 23, chat: { id: 6 } } } }),
    makeEnv()
  );

  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /Раздел временно недоступен/);
  assert.match(body.text, /Источник данных сейчас не отвечает/);
  assert.doesNotMatch(body.text, /^⚠️ Ошибка сервиса Checko$/);
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
  assert.match(body.text, /№ б\/н/);
  assert.doesNotMatch(body.text, /• —/);
});

test("co:lnk shows missing-config state without Checko dependency", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.checko.ru") {
      throw new Error("co:lnk must not call Checko");
    }
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-lnk", data: "co:lnk:7707083893", message: { message_id: 9, chat: { id: 3 } } } }),
    makeEnv()
  );

  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /Источник данных не настроен/);
  assert.ok(!calls.some((c) => c.url.includes("api.checko.ru")));
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
      return jsonResponse({ suggestions: [{ data: { inn: "7707083893", name: { short_with_opf: "ООО Email Тест" }, state: { status: "ACTIVE" }, employee_count: 15, invalid: false, phones: [{ value: "+7 495 111-22-33" }] } }] });
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
  assert.match(body.text, /Вывод/);
  assert.ok(!calls.some((c) => c.url.includes("api.checko.ru") && c.url.includes("/company")));
  assert.ok(!calls.some((c) => c.url.includes("api.checko.ru") && c.url.includes("/finances")));
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
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findById/party")) {
      const payload = JSON.parse(options.body);
      assert.equal(payload.query, "7707083893");

    }
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findAffiliated/party")) {
      const payload = JSON.parse(options.body);
      if (Array.isArray(payload.scope) && payload.scope.includes("MANAGERS")) {

        return jsonResponse({ suggestions: [{ data: { inn: "2222222222", name: { short_with_opf: "ООО Бета" }, state: { status: "ACTIVE" }, okved: "62.01" } }] });
      }
      return jsonResponse({ suggestions: [] });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-lnk-aff", data: "co:lnk:7707083893", message: { message_id: 9, chat: { id: 3 } } } }),
    makeEnv({ DADATA_API_KEY: "dadata-key", DADATA_SECRET_KEY: "dadata-secret", DADATA_API_URL: "https://suggestions.dadata.ru/suggestions/api/4_1/rs" })
  );

  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /Сводка/);
  assert.match(body.text, /Что это значит/);
  assert.match(body.text, /Через руководителя/);
  assert.match(body.text, /Через учредителя/);
  assert.match(body.text, /ООО Альфа/);
  assert.match(body.text, /ООО Бета/);
  assert.match(body.text, /Список компаний/);
  assert.match(body.text, /1111111111/);
  assert.match(body.text, /2222222222/);
  assert.ok(!calls.some((c) => c.url.includes("api.checko.ru") && c.url.includes("/company")));
  const affiliatedCalls = calls.filter((c) => c.url.includes("/findAffiliated/party"));
  assert.equal(affiliatedCalls.length, 2);
});

test("co:lnk keeps cross-channel affiliation visible in both groups", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findById/party")) {

    }
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findAffiliated/party")) {
      const payload = JSON.parse(options.body);
      if (Array.isArray(payload.scope) && payload.scope.includes("MANAGERS")) {
        return jsonResponse({ suggestions: [{ data: { inn: "1111111111", name: { short_with_opf: "ООО Перекрёст" }, state: { status: "ACTIVE" } } }] });
      }
      return jsonResponse({ suggestions: [] });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-lnk-cross", data: "co:lnk:7707083893", message: { message_id: 9, chat: { id: 3 } } } }),
    makeEnv({ DADATA_API_KEY: "dadata-key", DADATA_SECRET_KEY: "dadata-secret", DADATA_API_URL: "https://suggestions.dadata.ru/suggestions/api/4_1/rs" })
  );

  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /Через руководителя: <b>1<\/b>/);
  assert.match(body.text, /Через учредителя: <b>1<\/b>/);
  assert.match(body.text, /Общий объём сети: <b>1<\/b>/);
  assert.equal((body.text.match(/ООО Перекрёст/g) || []).length, 3);
});

test("co:lnk renders no-affiliations complete screen", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findById/party")) {
    }
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findAffiliated/party")) {
      return jsonResponse({ suggestions: [] });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-lnk-empty", data: "co:lnk:7707083893", message: { message_id: 9, chat: { id: 3 } } } }),
    makeEnv({ DADATA_API_KEY: "dadata-key", DADATA_SECRET_KEY: "dadata-secret", DADATA_API_URL: "https://suggestions.dadata.ru/suggestions/api/4_1/rs" })
  );

  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
});

test("co:lnk renders service-state when DaData affiliated is unavailable", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findById/party")) {
    }
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findAffiliated/party")) {
      return new Response("upstream failed", { status: 502 });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-lnk-unavailable", data: "co:lnk:7707083893", message: { message_id: 9, chat: { id: 3 } } } }),
    makeEnv({ DADATA_API_KEY: "dadata-key", DADATA_SECRET_KEY: "dadata-secret", DADATA_API_URL: "https://suggestions.dadata.ru/suggestions/api/4_1/rs" })
  );

  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /Источник временно недоступен/);
  assert.match(body.text, /Не удалось получить связи компании из DaData/);
});

test("co:lnk skips affiliations lookup when party lacks manager and founder INNs", async () => {
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
            managers: [{ name: "Без ИНН" }],
            founders: [{ name: "Тоже без ИНН" }]
          }
        }]
      });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-lnk-no-inn", data: "co:lnk:7707083893", message: { message_id: 9, chat: { id: 3 } } } }),
    makeEnv({ DADATA_API_KEY: "dadata-key", DADATA_SECRET_KEY: "dadata-secret", DADATA_API_URL: "https://suggestions.dadata.ru/suggestions/api/4_1/rs" })
  );

  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /Связи не найдены/);
  assert.equal(calls.filter((c) => c.url.includes("/findAffiliated/party")).length, 0);
});

test("DaData outage renders graceful service-state in main card", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findById/party")) {
      return new Response("upstream failed", { status: 502 });
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
  assert.match(body.text, /DaData временно недоступен/);
  assert.ok(!calls.some((c) => c.url.includes("api.checko.ru") && c.url.includes("/company")));
  assert.ok(!calls.some((c) => c.url.includes("api.checko.ru") && c.url.includes("/finances")));
});

test("main card renders DaData missing-credentials state", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ ok: true });
  };

  await worker.fetch(makeWebhookRequest({ message: { text: "7707083893", chat: { id: 1 } } }), makeEnv());

  const send = calls.find((c) => c.url.includes("/sendMessage"));
  const body = JSON.parse(send.options.body);
  assert.match(body.text, /DaData не настроен/);
});

test("main card renders DaData not-found state", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findById/party")) {
      return jsonResponse({ suggestions: [] });
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
  assert.match(body.text, /Компания не найдена в DaData/);
});


test("repeated main card lookup uses DaData KV cache", async () => {
  const kv = makeKvNamespace();
  let partyCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    if (u.hostname === "suggestions.dadata.ru" && u.pathname.endsWith("/findById/party")) {
      partyCalls += 1;
      return jsonResponse({ suggestions: [{ data: { inn: "7707083893", name: { short_with_opf: "ООО Кеш" }, state: { status: "ACTIVE" } } }] });
    }
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    throw new Error(`Unexpected URL ${u}`);
  };

  const env = makeEnv({ COMPANY_CACHE: kv, DADATA_API_KEY: "dadata-key", DADATA_SECRET_KEY: "dadata-secret", DADATA_API_URL: "https://suggestions.dadata.ru/suggestions/api/4_1/rs" });
  await worker.fetch(makeWebhookRequest({ message: { text: "7707083893", chat: { id: 1 } } }), env);
  await worker.fetch(makeWebhookRequest({ message: { text: "7707083893", chat: { id: 1 } } }), env);

  assert.equal(partyCalls, 1);
  assert.ok(kv.stats.get >= 2);
  assert.ok(kv.stats.put >= 1);
});

test("co:fin shows missing-config state without generic crash when CHECKO_API_KEY is absent", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.checko.ru") throw new Error("Should not call Checko without key");
    return jsonResponse({ ok: true });
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-fin-no-key", data: "co:fin:7707083893", message: { message_id: 30, chat: { id: 6 } } } }),
    makeEnv({ CHECKO_API_KEY: "" })
  );

  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /Источник данных не настроен/);
  assert.match(body.text, /Раздел временно недоступен/);
  assert.ok(!calls.some((c) => c.url.includes("api.checko.ru")));
});

test("co:fin shows section unavailable on Checko service failure", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.pathname.endsWith("/finances")) return new Response("<html>bad gateway</html>", { status: 200 });
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-fin-fail", data: "co:fin:7707083893", message: { message_id: 31, chat: { id: 6 } } } }),
    makeEnv()
  );

  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /Раздел временно недоступен/);
  assert.match(body.text, /Источник данных сейчас не отвечает/);
  assert.doesNotMatch(body.text, /^⚠️ Ошибка сервиса Checko$/);
});

test("co:arb shows missing-config state without generic crash when CHECKO_API_KEY is absent", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.checko.ru") throw new Error("Should not call Checko without key");
    return jsonResponse({ ok: true });
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-arb-no-key", data: "co:arb:7707083893", message: { message_id: 32, chat: { id: 6 } } } }),
    makeEnv({ CHECKO_API_KEY: "" })
  );

  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /Источник данных не настроен/);
  assert.match(body.text, /Раздел временно недоступен/);
  assert.ok(!calls.some((c) => c.url.includes("api.checko.ru")));
});

test("co:his shows missing-config state without generic crash when CHECKO_API_KEY is absent", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.checko.ru") throw new Error("Should not call Checko without key");
    return jsonResponse({ ok: true });
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-his-no-key", data: "co:his:7707083893", message: { message_id: 33, chat: { id: 6 } } } }),
    makeEnv({ CHECKO_API_KEY: "" })
  );

  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /Источник данных не настроен/);
  assert.match(body.text, /Раздел временно недоступен/);
  assert.ok(!calls.some((c) => c.url.includes("api.checko.ru")));
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
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/finances")) {
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

test("/help shows readable support screen", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ ok: true });
  };

  await worker.fetch(makeWebhookRequest({ message: { text: "/help", chat: { id: 1 } } }), makeEnv());
  const body = JSON.parse(calls[0].options.body);
  assert.match(body.text, /Как пользоваться/);
  assert.match(body.text, /Отправьте ИНН/);
  assert.equal(body.reply_markup.keyboard[1][1].text, "💬 Поддержка");
});

test("📁 История shows clean fallback when KV is unavailable", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ ok: true });
  };

  await worker.fetch(makeWebhookRequest({ message: { text: "📁 История", chat: { id: 99 } } }), makeEnv());
  const body = JSON.parse(calls[0].options.body);
  assert.match(body.text, /История временно недоступна/);
  assert.doesNotMatch(body.text, /Ошибка/);
});

test("co:risk uses corrected /finances, /timeline and /fedresu endpoints", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.pathname.endsWith("/company")) return jsonResponse({ meta: { status: "ok" }, data: { ИНН: "7707083893", Статус: { Наим: "Действующее" } } });
    if (u.pathname.endsWith("/bankruptcy-messages") || u.pathname.endsWith("/fedresurs") || u.pathname.endsWith("/legal-cases") || u.pathname.endsWith("/enforcements") || u.pathname.endsWith("/contracts") || u.pathname.endsWith("/finances") || u.pathname.endsWith("/history")) {
      return jsonResponse({ meta: { status: "ok" }, data: [] });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-risk-endpoint", data: "co:risk:7707083893", message: { message_id: 70, chat: { id: 2 } } } }),
    makeEnv()
  );

  assert.ok(calls.some((c) => c.url.includes("/finances?")));
  assert.ok(calls.some((c) => c.url.includes("/history?")));
  assert.ok(calls.some((c) => c.url.includes("/fedresurs?")));
  assert.ok(!calls.some((c) => c.url.includes("/financeses?")));
  assert.ok(!calls.some((c) => c.url.includes("/timeline?")));
  assert.ok(!calls.some((c) => c.url.includes("/fedresu?")));
});

test("co:okv renders compact additional codes with overflow marker", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/company")) {
      return jsonResponse({
        meta: { status: "ok" },
        data: {
          ОКВЭД: { Код: "62.01", Наим: "Разработка ПО" },
          ОКВЭДДоп: [
            { Код: "62.02", Наим: "Консультирование" },
            { Код: "62.03", Наим: "Управление оборудованием" },
            { Код: "62.09", Наим: "Прочая IT" },
            { Код: "63.11", Наим: "Обработка данных" },
            { Код: "63.12", Наим: "Порталы" },
            { Код: "63.99", Наим: "Инфосервисы" },
            { Код: "58.29", Наим: "Издание ПО" },
            { Код: "72.19", Наим: "НИОКР" },
            { Код: "95.11", Наим: "Ремонт компьютеров" }
          ]
        }
      });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-okv", data: "co:okv:7707083893", message: { message_id: 71, chat: { id: 2 } } } }),
    makeEnv()
  );

  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /Основной/);
  assert.match(body.text, /62\.01/);
  assert.match(body.text, /Стр\. 1\/2/);
});



test("page-less callback falls back to page 1 for co:okv", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/company")) {
      return jsonResponse({
        meta: { status: "ok" },
        data: {
          ОКВЭД: { Код: "62.01", Наим: "Разработка ПО" },
          ОКВЭДДоп: [
            { Код: "62.02", Наим: "Консультирование" },
            { Код: "62.03", Наим: "Управление оборудованием" },
            { Код: "62.09", Наим: "Прочая IT" },
            { Код: "63.11", Наим: "Обработка данных" },
            { Код: "63.12", Наим: "Порталы" },
            { Код: "63.99", Наим: "Инфосервисы" }
          ]
        }
      });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-okv-page-implicit", data: "co:okv:7707083893", message: { message_id: 73, chat: { id: 2 } } } }),
    makeEnv()
  );

  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /62\.02/);
  assert.match(body.text, /Стр\. 1\/2/);
});

test("co:succ callback renders successor screen and empty-state safely", async () => {
  const calls = [];
  let companyCall = 0;
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/company")) {
      companyCall += 1;
      if (companyCall === 1) {
        return jsonResponse({
          meta: { status: "ok" },
          data: {
            Правопреемник: {
              ИНН: "7712345678",
              Наим: "ООО Новый правопреемник",
              Статус: { Наим: "Действующее" },
              Руковод: [{ ФИО: "Петров П.П." }]
            }
          }
        });
      }
      return jsonResponse({ meta: { status: "ok" }, data: {} });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-succ", data: "co:succ:7707083893", message: { message_id: 74, chat: { id: 2 } } } }),
    makeEnv()
  );

  let edit = calls.find((c) => c.url.includes("/editMessageText"));
  let body = JSON.parse(edit.options.body);
  assert.match(body.text, /Правопреемник/);
  assert.match(body.text, /ООО Новый правопреемник/);
  assert.match(body.text, /Петров П\.П\./);
  assert.match(body.text, /долги, суды, действующий статус/);

  calls.length = 0;

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-succ-empty", data: "co:succ:7707083893", message: { message_id: 75, chat: { id: 2 } } } }),
    makeEnv()
  );

  edit = calls.find((c) => c.url.includes("/editMessageText"));
  body = JSON.parse(edit.options.body);
  assert.match(body.text, /Правопреемник не найден/);
});

test("pager callback opens second page for co:okv", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.toString(), options });
    if (u.hostname === "api.telegram.org") return jsonResponse({ ok: true });
    if (u.hostname === "api.checko.ru" && u.pathname.endsWith("/company")) {
      return jsonResponse({
        meta: { status: "ok" },
        data: {
          ОКВЭД: { Код: "62.01", Наим: "Разработка ПО" },
          ОКВЭДДоп: [
            { Код: "62.02", Наим: "Консультирование" },
            { Код: "62.03", Наим: "Управление оборудованием" },
            { Код: "62.09", Наим: "Прочая IT" },
            { Код: "63.11", Наим: "Обработка данных" },
            { Код: "63.12", Наим: "Порталы" },
            { Код: "63.99", Наим: "Инфосервисы" }
          ]
        }
      });
    }
    throw new Error(`Unexpected URL ${u}`);
  };

  await worker.fetch(
    makeWebhookRequest({ callback_query: { id: "cb-okv-page", data: "co:okv:7707083893:p:2", message: { message_id: 72, chat: { id: 2 } } } }),
    makeEnv()
  );

  const edit = calls.find((c) => c.url.includes("/editMessageText"));
  const body = JSON.parse(edit.options.body);
  assert.match(body.text, /63\.99/);
  assert.match(body.text, /Стр\. 2\/2/);
});
