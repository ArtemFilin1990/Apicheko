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

test("POST /webhook with /start sends greeting with start buttons", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ ok: true });
  };

  const response = await worker.fetch(
    makeWebhookRequest({ message: { text: "/start", chat: { id: 123 } } }),
    makeEnv()
  );
  assert.equal(response.status, 200);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.chat_id, 123);
  assert.equal(body.parse_mode, "HTML");
  assert.match(body.text, /Здравствуйте! Это сервис оперативной проверки контрагентов и банков/);
  assert.equal(body.reply_markup.inline_keyboard.length, 4);
  assert.equal(body.reply_markup.inline_keyboard[0][0].callback_data, "search:inn");
  assert.equal(body.reply_markup.inline_keyboard[1][0].callback_data, "search:name");
  assert.equal(body.reply_markup.inline_keyboard[2][0].callback_data, "search:bic");
  assert.equal(body.reply_markup.inline_keyboard[3][0].callback_data, "help");
});

test("callback start screens and back/start reset", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ ok: true });
  };

  await worker.fetch(
    makeWebhookRequest({
      callback_query: { id: "cb-company", data: "search:inn", message: { message_id: 44, chat: { id: 55 } } }
    }),
    makeEnv()
  );
  const companyScreen = JSON.parse(calls[1].options.body);
  assert.match(companyScreen.text, /Поиск компании/);
  assert.equal(companyScreen.reply_markup.inline_keyboard[0][0].callback_data, "back:start");

  calls.length = 0;
  await worker.fetch(
    makeWebhookRequest({
      callback_query: { id: "cb-person", data: "search:name", message: { message_id: 44, chat: { id: 55 } } }
    }),
    makeEnv()
  );
  const personScreen = JSON.parse(calls[1].options.body);
  assert.match(personScreen.text, /Поиск по названию/);

  calls.length = 0;
  await worker.fetch(
    makeWebhookRequest({
      callback_query: { id: "cb-bank", data: "search:bic", message: { message_id: 44, chat: { id: 55 } } }
    }),
    makeEnv()
  );
  const bankScreen = JSON.parse(calls[1].options.body);
  assert.match(bankScreen.text, /Поиск банка/);

  calls.length = 0;
  await worker.fetch(
    makeWebhookRequest({
      callback_query: { id: "cb-info", data: "help", message: { message_id: 44, chat: { id: 55 } } }
    }),
    makeEnv()
  );
  const infoScreen = JSON.parse(calls[1].options.body);
  assert.match(infoScreen.text, /Что входит в проверку/);

  calls.length = 0;
  await worker.fetch(
    makeWebhookRequest({
      callback_query: { id: "cb-back", data: "back:start", message: { message_id: 44, chat: { id: 55 } } }
    }),
    makeEnv()
  );
  const backStart = JSON.parse(calls[1].options.body);
  assert.equal(backStart.reply_markup.inline_keyboard[0][0].callback_data, "search:inn");

  calls.length = 0;
  await worker.fetch(
    makeWebhookRequest({
      callback_query: { id: "cb-reset", data: "menu", message: { message_id: 44, chat: { id: 55 } } }
    }),
    makeEnv()
  );
  const resetStart = JSON.parse(calls[1].options.body);
  assert.match(resetStart.text, /Выберите тип поиска ниже/);
});

test("POST /webhook with 10-digit INN sends company card with expanded menu", async () => {
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
        return jsonResponse({ meta: { status: "ok" }, data: { cases: [{ НомерДела: "А40-1/2026", СуммаТреб: 1500 }] } });
      }
      if (endpoint === "bankruptcy-messages") {
        return jsonResponse({ meta: { status: "ok" }, data: { messages: [] } });
      }
      if (endpoint === "finance") {
        return jsonResponse({ meta: { status: "ok" }, data: { reports: [{ 2110: 1000, 2400: 250, 1600: 5000 }] } });
      }
    }

    if (requestUrl.hostname === "api.telegram.org") {
      return jsonResponse({ ok: true });
    }

    if (requestUrl.hostname === "api.checko.ru") {
      return jsonResponse({
        meta: { status: "ok" },
        data: { cases: [{ НомерДела: "А40-1/2026", Дата: "2026-01-01" }] }
      });
    }

    throw new Error(`Unexpected URL ${requestUrl}`);
  };

  const response = await worker.fetch(
    makeWebhookRequest({ message: { text: "7707083893", chat: { id: 321 } } }),
    makeEnv()
  );
  assert.equal(response.status, 200);

  const telegramCall = calls.find((call) => call.url.includes("/sendMessage"));
  const body = JSON.parse(telegramCall.options.body);
  assert.match(body.text, /ПАО Сбербанк/);
  assert.equal(body.reply_markup.inline_keyboard.length, 7);

});

test("POST /webhook with 13-digit OGRN routes to company", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    calls.push({ url: requestUrl.toString(), options });
    if (requestUrl.hostname === "api.checko.ru") {
      const endpoint = requestUrl.pathname.split("/").pop();
      if (endpoint === "company") {
        return jsonResponse({ meta: { status: "ok" }, data: { ИНН: "7707083893", ОГРН: "1027700132195", НаимПолн: "ООО Тест" } });
      }
      if (["legal-cases", "bankruptcy-messages", "finance"].includes(endpoint)) {
        return jsonResponse({ meta: { status: "ok" }, data: {} });
      }
    }
    return jsonResponse({ ok: true });
  };

  await worker.fetch(makeWebhookRequest({ message: { text: "1027700132195", chat: { id: 500 } } }), makeEnv());
  assert.ok(calls.some((call) => call.url.includes("/company?")));
});

test("POST /webhook with 12-digit INN sends person/ip chooser", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return jsonResponse({ ok: true });
  };

  const response = await worker.fetch(
    makeWebhookRequest({ message: { text: "500100732259", chat: { id: 333 } } }),
    makeEnv()
  );
  assert.equal(response.status, 200);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.reply_markup.inline_keyboard[0][0].callback_data, "choose:person:500100732259");
  assert.equal(body.reply_markup.inline_keyboard[1][0].callback_data, "choose:ip:500100732259");
  assert.equal(body.reply_markup.inline_keyboard[2][0].callback_data, "back:start");
});

test("POST /webhook with 15-digit OGRNIP routes to entrepreneur menu", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    calls.push({ url: requestUrl.toString(), options });
    if (requestUrl.hostname === "api.checko.ru") {
      const endpoint = requestUrl.pathname.split("/").pop();
      if (endpoint === "entrepreneur") {
        return jsonResponse({
          meta: { status: "ok" },
          data: { ИНН: "500100732259", ОГРНИП: "304500116000157", ФИО: "ИП Иванов И.И.", Статус: { Наим: "Действующее" } }
        });
      }
      if (endpoint === "legal-cases") return jsonResponse({ meta: { status: "ok" }, data: { cases: [] } });
      if (endpoint === "bankruptcy-messages") return jsonResponse({ meta: { status: "ok" }, data: { messages: [] } });
      if (endpoint === "finance") return jsonResponse({ meta: { status: "ok" }, data: { reports: [] } });
    }
    return jsonResponse({ ok: true });
  };

  const response = await worker.fetch(
    makeWebhookRequest({ message: { text: "304500116000157", chat: { id: 445 } } }),
    makeEnv()
  );
  assert.equal(response.status, 200);
  const telegramCall = calls.find((call) => call.url.includes("/sendMessage"));
  const body = JSON.parse(telegramCall.options.body);
});

test("POST /webhook with 9-digit BIK sends bank card and reset", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    calls.push({ url: requestUrl.toString(), options });

    if (requestUrl.hostname === "api.checko.ru") {
      return jsonResponse({ meta: { status: "ok" }, data: { БИК: "044525225", Наим: "ПАО Сбербанк", Адрес: "Москва", Тип: "Банк" } });
    }

    if (requestUrl.hostname === "api.telegram.org") {
      return jsonResponse({ ok: true });
    }

    if (requestUrl.hostname === "api.checko.ru") {
      return jsonResponse({
        meta: { status: "ok" },
        data: { items: [{ НомерКонтракта: "1", СуммаКонтракта: 1000 }] }
      });
    }

    throw new Error(`Unexpected URL ${requestUrl}`);
  };

  const response = await worker.fetch(
    makeWebhookRequest({ message: { text: "044525225", chat: { id: 444 } } }),
    makeEnv()
  );
  assert.equal(response.status, 200);
  const telegramCall = calls.find((call) => call.url.includes("/sendMessage"));
  const body = JSON.parse(telegramCall.options.body);
  assert.match(body.text, /Банк \/ Кредитная организация/);
  assert.equal(body.reply_markup.inline_keyboard[0][0].callback_data, "menu");
});

test("POST /webhook with empty company payload sends not-found message", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    calls.push({ url: requestUrl.toString(), options });

    if (requestUrl.hostname === "api.checko.ru") {
      return jsonResponse({ meta: { status: "ok" }, data: {} });
    }

    if (requestUrl.hostname === "api.telegram.org") {
      return jsonResponse({ ok: true });
    }

    throw new Error(`Unexpected URL ${requestUrl}`);
  };

  const response = await worker.fetch(
    makeWebhookRequest({ message: { text: "7707083893", chat: { id: 321 } } }),
    makeEnv()
  );

  assert.equal(response.status, 200);
  const telegramCall = calls.find((call) => call.url.includes("/sendMessage"));
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
    makeWebhookRequest({ message: { text: "7707083893", chat: { id: 321 } } }),
    makeEnv()
  );

  assert.equal(response.status, 200);
  const telegramCall = calls.find((call) => call.url.includes("/sendMessage"));
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
    makeWebhookRequest({ message: { text: "7707083893", chat: { id: 321 } } }),
    makeEnv()
  );

  assert.equal(response.status, 200);
  const telegramCall = calls.find((call) => call.url.includes("/sendMessage"));
  const body = JSON.parse(telegramCall.options.body);
  assert.equal(body.text, "⚠️ Ошибка сервиса Checko");
});

test("POST /webhook with Checko meta error sends safe service message", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url));
    calls.push({ url: requestUrl.toString(), options });

    if (requestUrl.hostname === "api.checko.ru") {
      return jsonResponse({ meta: { status: "error", message: "rate limit" }, data: null });
    }

    if (requestUrl.hostname === "api.telegram.org") {
      return jsonResponse({ ok: true });
    }

    throw new Error(`Unexpected URL ${requestUrl}`);
  };

  const response = await worker.fetch(
    makeWebhookRequest({ message: { text: "7707083893", chat: { id: 321 } } }),
    makeEnv()
  );

  assert.equal(response.status, 200);
  const telegramCall = calls.find((call) => call.url.includes("/sendMessage"));
  const body = JSON.parse(telegramCall.options.body);
  assert.equal(body.text, "⚠️ Ошибка сервиса Checko");
});

test("callback_query for arbitration shows submenu with plaintiff/defendant", async () => {
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
        data: { cases: [{ НомерДела: "А40-1/2026", Дата: "2026-01-01" }] }
      });
    }

    throw new Error(`Unexpected URL ${requestUrl}`);
  };

  const request = makeWebhookRequest({
    callback_query: {
      id: "cb-1",
      data: "co:arb:7707083893",
      message: {
        message_id: 77,
        chat: { id: 99 }
      }
    }
  });

  const response = await worker.fetch(request, makeEnv());
  assert.equal(response.status, 200);

  assert.match(calls[0].url, /answerCallbackQuery$/);
  const editCall = calls.find((call) => call.url.includes("/editMessageText"));
  const body = JSON.parse(editCall.options.body);
  assert.equal(body.chat_id, 99);
  assert.equal(body.message_id, 77);
  assert.match(body.text, /Арбитраж/);
  assert.ok(body.reply_markup.inline_keyboard.some(row => row.some(btn => btn.callback_data === "main:7707083893")));
});

test("callback_query for arb:inn:plaintiff answers callback and edits message with cases", async () => {
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
      id: "cb-2",
      data: "arb:7707083893:plaintiff",
      message: {
        message_id: 77,
        chat: { id: 99 }
      }
    }
  });

  const response = await worker.fetch(request, makeEnv());
  assert.equal(response.status, 200);

  const editCall = calls.find((call) => call.url.includes("/editMessageText"));
  const body = JSON.parse(editCall.options.body);
  assert.match(body.text, /Арбитраж/);
});

test("callback_query for contracts shows submenu with law categories", async () => {
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
        data: { items: [{ НомерКонтракта: "1", СуммаКонтракта: 1000 }] }
      });
    }

    throw new Error(`Unexpected URL ${requestUrl}`);
  };

  const request = makeWebhookRequest({
    callback_query: {
      id: "cb-3",
      data: "co:ctr:7707083893",
      message: {
        message_id: 80,
        chat: { id: 99 }
      }
    }
  });

  const response = await worker.fetch(request, makeEnv());
  assert.equal(response.status, 200);

  const editCall = calls.find((call) => call.url.includes("/editMessageText"));
  const body = JSON.parse(editCall.options.body);
  assert.match(body.text, /Госконтракты/);
  assert.ok(body.reply_markup.inline_keyboard.some(row => row.some(btn => btn.callback_data === "main:7707083893")));
});

test("company card includes main summary, risk block and new menu", async () => {
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
            ЮрАдрес: { АдресРФ: "г. Москва", Регион: { Наим: "г. Москва" } },
            Руковод: [{ ФИО: "Иванов И.И." }],
            ОКВЭД: { Код: "64.19", Наим: "Прочее денежное посредничество" },
            УстКап: { Сумма: 67760844000 },
            РМСП: { Кат: "Крупное" },
            Налоги: { СумНедоим: 12345 },
            Контакты: {
              Тел: ["+7 495 500-00-00", "+7 495 500-00-01"],
              Емэйл: ["info@sberbank.ru"],
              ВебСайт: "www.sberbank.ru"
            }
          }
        });
      }
      if (["legal-cases", "bankruptcy-messages", "finance"].includes(endpoint)) {
        return jsonResponse({ meta: { status: "ok" }, data: {} });
      }
    }

    if (requestUrl.hostname === "api.telegram.org") {
      return jsonResponse({ ok: true });
    }

    throw new Error(`Unexpected URL ${requestUrl}`);
  };

  const response = await worker.fetch(
    makeWebhookRequest({ message: { text: "7707083893", chat: { id: 600 } } }),
    makeEnv()
  );
  assert.equal(response.status, 200);

  const telegramCall = calls.find((call) => call.url.includes("/sendMessage"));
  const body = JSON.parse(telegramCall.options.body);

  assert.match(body.text, /ПАО Сбербанк/);
  assert.match(body.text, /Краткая оценка/);
  assert.match(body.text, /Риск:\s*<b>Низкий<\/b>/);
  assert.match(body.text, /Что важно сразу/);
  assert.match(body.text, /64\.19 — Прочее денежное посредничество/);
});
