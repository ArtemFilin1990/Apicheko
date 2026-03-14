var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
// worker.js
var DEFAULT_CHECKO_API_URL = "https://api.checko.ru/v2";
var DEFAULT_WEBHOOK_PATH = "/webhook";
var COMPANY_NOT_FOUND_MESSAGE = "❌ Компания не найдена";
var CHECKO_SERVICE_ERROR_MESSAGE = "⚠️ Ошибка сервиса Checko";
var START_MESSAGE_TEXT = "👋 <b>Здравствуйте! Это сервис оперативной проверки контрагентов и банков.</b>\n\nВыберите тип поиска ниже или отправьте реквизит сообщением.\n\nПоддерживаются:\n• <b>ИНН</b>\n• <b>ОГРН / ОГРНИП</b>\n• <b>БИК</b>\n\nПосле поиска откроется карточка с основными сведениями и доступом к расширенной проверке.";
var PAGE_SIZE = 10;
var SECTION_PAGE_SIZE = 5;
var lookupStatus = /* @__PURE__ */ __name(() => null, "lookupStatus");
var lookupBankruptcyMessageType = /* @__PURE__ */ __name(() => null, "lookupBankruptcyMessageType");
var lookupAccountCode = /* @__PURE__ */ __name(() => null, "lookupAccountCode");
var referenceLookupsReady = import("../utils/reference/index.js").then((module) => {
  if (typeof module.lookupStatus === "function") {
    lookupStatus = module.lookupStatus;
  }
  if (typeof module.lookupBankruptcyMessageType === "function") {
    lookupBankruptcyMessageType = module.lookupBankruptcyMessageType;
  }
  if (typeof module.lookupAccountCode === "function") {
    lookupAccountCode = module.lookupAccountCode;
  }
}).catch(() => {
});
var SECTION_CONFIG = {
  arbitration: {
    title: "⚖️ Арбитраж",
    endpoint: "legal-cases",
    listKeys: ["Дела", "cases"],
    countLabel: "Количество дел"
  },
  bankruptcy: {
    title: "📉 Банкротство",
    endpoint: "bankruptcy-messages",
    listKeys: ["Сообщения", "messages"],
    countLabel: "Записей о банкротстве"
  },
  contracts: {
    title: "🏛 Госзакупки",
    endpoint: "contracts",
    listKeys: ["Контракты", "items"],
    countLabel: "Всего контрактов"
  },
  inspections: {
    title: "🚨 Проверки",
    endpoint: "inspections",
    listKeys: ["Проверки", "Inspection", "Docs", "items", "data"],
    countLabel: "Всего проверок"
  },
  financial: {
    title: "📊 Финансы",
    endpoint: "finance",
    listKeys: ["Отчеты", "reports", "items", "data"],
    countLabel: "Лет в отчётности"
  },
  enforcements: {
    title: "🛑 ФССП",
    endpoint: "enforcements",
    listKeys: ["ИП", "ИспПр", "Производства", "Docs", "items", "data"],
    countLabel: "Всего"
  },
  history: {
    title: "📜 История",
    endpoint: "history",
    listKeys: ["События", "events"],
    countLabel: "Всего записей"
  },
  fedresurs: {
    title: "📋 Федресурс",
    endpoint: "fedresurs-messages",
    listKeys: ["Сообщения", "messages"],
    countLabel: "Всего сообщений"
  }
};
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const webhookPaths = resolveWebhookPaths(env);
    if (request.method === "GET" && url.pathname === "/") {
      return jsonResponse({ ok: true, service: "telegram-checko-bot", webhookPaths });
    }
    const isWebhookRequest = request.method === "POST" && webhookPaths.includes(url.pathname);
    if (isWebhookRequest) {
      try {
        verifyTelegramWebhookSecret(request, env);
        return await handleTelegramUpdate(request, env);
      } catch (error) {
        const message = String(error.message || error);
        const status = message === "Unauthorized: invalid webhook secret token." ? 401 : 400;
        return jsonResponse({ ok: false, error: message }, status);
      }
    }
    return new Response("Not Found", { status: 404 });
  }
};
async function handleTelegramUpdate(request, env) {
  ensureTelegramSecret(env);
  const update = await parseJsonOrThrow(request);
  const callbackQuery = update.callback_query;
  if (callbackQuery) {
    await handleCallbackQuery(callbackQuery, env);
    return jsonResponse({ ok: true });
  }
  const message = update.message;
  if (!message || typeof message.text !== "string") {
    return jsonResponse({ ok: true, skipped: "Unsupported update type." });
  }
  const chatId = message.chat?.id;
  const text = message.text.trim();
  if (!chatId) {
    return jsonResponse({ ok: true, skipped: "No chat id in message." });
  }
  if (text === "/start" || text === "/help") {
    const view = buildStartView();
    await sendMessage(env, {
      chat_id: chatId,
      text: view.text,
      parse_mode: "HTML",
      reply_markup: view.reply_markup
    });
    return jsonResponse({ ok: true });
  }
  const innClean = text.replace(/\s+/g, "");
  if (/^\d{10}$/.test(innClean) || /^\d{12}$/.test(innClean) || /^\d{13}$/.test(innClean) || /^\d{15}$/.test(innClean) || /^\d{9}$/.test(innClean)) {
    try {
      let view;
      if (innClean.length === 9) {
        view = await buildBicView(env, innClean);
      } else if (innClean.length === 12) {
        view = buildPersonTypeChoiceView(innClean);
      } else if (innClean.length === 15) {
        view = await buildMainCardView(env, innClean, "entrepreneur");
      } else {
        view = await buildMainCardView(env, innClean, "company");
      }
      await sendMessage(env, {
        chat_id: chatId,
        text: view.text,
        parse_mode: "HTML",
        reply_markup: view.reply_markup
      });
    } catch (error) {
      await sendMessage(env, {
        chat_id: chatId,
        text: isCheckoNotFoundError(error) ? COMPANY_NOT_FOUND_MESSAGE : CHECKO_SERVICE_ERROR_MESSAGE
      });
    }
    return jsonResponse({ ok: true });
  }
  await sendMessage(env, {
    chat_id: chatId,
    text: "ℹ️ Отправьте ИНН компании (10 цифр), ИП/физлица (12 цифр), ОГРН (13 цифр), ОГРНИП (15 цифр) или БИК банка (9 цифр).",
    parse_mode: "HTML"
  });
  return jsonResponse({ ok: true });
}
__name(handleTelegramUpdate, "handleTelegramUpdate");
async function handleCallbackQuery(callbackQuery, env) {
  const callbackId = callbackQuery.id;
  const message = callbackQuery.message;
  const messageId = message?.message_id;
  const chatId = message?.chat?.id;
  const data = String(callbackQuery.data || "");
  await telegramRequest(env, "answerCallbackQuery", { callback_query_id: callbackId });
  if (!chatId || !messageId) {
    return;
  }
  try {
    if (data.startsWith("noop")) {
      return;
    }
    if (data === "help") {
      const view = buildStartInfoView();
      await editMessage(env, chatId, messageId, view.text, view.reply_markup);
      return;
    }
    if (data === "search:inn") {
      const view = buildCompanyInputView();
      await editMessage(env, chatId, messageId, view.text, view.reply_markup);
      return;
    }
    if (data === "search:name") {
      const view = {
        text: "🧾 <b>Поиск по названию</b>\n\nОтправьте название компании или ФИО ИП сообщением.",
        reply_markup: { inline_keyboard: [[kb("🏠 В меню", "menu")]] }
      };
      await editMessage(env, chatId, messageId, view.text, view.reply_markup);
      return;
    }
    if (data === "search:bic") {
      const view = buildBankInputView();
      await editMessage(env, chatId, messageId, view.text, view.reply_markup);
      return;
    }
    if (data === "menu" || data === "back:start" || data === "reset:start") {
      const view = buildStartView();
      await editMessage(env, chatId, messageId, view.text, view.reply_markup);
      return;
    }
    if (data === "start:company") {
      const view = buildCompanyInputView();
      await editMessage(env, chatId, messageId, view.text, view.reply_markup);
      return;
    }
    if (data === "start:person") {
      const view = buildPersonInputView();
      await editMessage(env, chatId, messageId, view.text, view.reply_markup);
      return;
    }
    if (data === "start:bank") {
      const view = buildBankInputView();
      await editMessage(env, chatId, messageId, view.text, view.reply_markup);
      return;
    }
    if (data === "start:info") {
      const view = buildStartInfoView();
      await editMessage(env, chatId, messageId, view.text, view.reply_markup);
      return;
    }
    if (data.startsWith("choose:person:")) {
      const inn2 = data.split(":")[2] || "";
      if (/^\d{12}$/.test(inn2)) {
        const view = await buildPersonView(env, inn2);
        await editMessage(env, chatId, messageId, view.text, view.reply_markup);
      }
      return;
    }
    if (data.startsWith("choose:ip:")) {
      const inn2 = data.split(":")[2] || "";
      if (/^\d{12}$/.test(inn2)) {
        const view = await buildMainCardView(env, inn2, "entrepreneur");
        await editMessage(env, chatId, messageId, view.text, view.reply_markup);
      }
      return;
    }
    if (data.startsWith("co:")) {
      const [, section, ident] = data.split(":", 3);
      if (!section || !ident || !(/^\d{10}$/.test(ident) || /^\d{12}$/.test(ident) || /^\d{13}$/.test(ident) || /^\d{15}$/.test(ident))) {
        return;
      }
      if (section === "main") {
        const view = await buildMainCardView(env, ident);
        await editMessage(env, chatId, messageId, view.text, view.reply_markup);
        return;
      }
      const map = { risk: "checks", fin: "financial", arb: "arbitration", fsp: "enforcements", ctr: "contracts", his: "history", lnk: "links", own: "founders", fil: "branches", okv: "okved", tax: "taxes" };
      const mapped = map[section];
      if (!mapped) {
        return;
      }
      const synthetic = `${mapped}:${ident}`;
      const [mappedAction, mappedInn] = synthetic.split(":");
      if (mappedAction === "checks") {
        const view = await buildChecksView(env, mappedInn);
        await editMessage(env, chatId, messageId, view.text, view.reply_markup);
        return;
      }
      if (mappedAction === "links") {
        const view = await buildLinksView(env, mappedInn);
        await editMessage(env, chatId, messageId, view.text, view.reply_markup);
        return;
      }
      if (mappedAction === "founders") {
        const view = await buildFoundersView(env, mappedInn);
        await editMessage(env, chatId, messageId, view.text, view.reply_markup);
        return;
      }
      if (mappedAction === "branches") {
        const view = await buildBranchesView(env, mappedInn);
        await editMessage(env, chatId, messageId, view.text, view.reply_markup);
        return;
      }
      if (mappedAction === "okved") {
        const view = await buildOkvedView(env, mappedInn);
        await editMessage(env, chatId, messageId, view.text, view.reply_markup);
        return;
      }
      if (mappedAction === "taxes") {
        const view = await buildTaxesView(env, mappedInn);
        await editMessage(env, chatId, messageId, view.text, view.reply_markup);
        return;
      }
      if (SECTION_CONFIG[mappedAction]) {
        const view = await buildSectionView(env, mappedAction, mappedInn, 1);
        await editMessage(env, chatId, messageId, view.text, view.reply_markup);
      }
      return;
    }
    const [action, inn, rawPage] = data.split(":");
    if (!inn || !(/^\d{10}$/.test(inn) || /^\d{12}$/.test(inn) || /^\d{13}$/.test(inn) || /^\d{15}$/.test(inn))) {
      return;
    }
    if (action === "main") {
      const view = await buildMainCardView(env, inn);
      await editMessage(env, chatId, messageId, view.text, view.reply_markup);
      return;
    }
    if (action === "card") {
      const view = await buildCardDetailsView(env, inn);
      await editMessage(env, chatId, messageId, view.text, view.reply_markup);
      return;
    }
    if (action === "checks") {
      const view = await buildChecksView(env, inn);
      await editMessage(env, chatId, messageId, view.text, view.reply_markup);
      return;
    }
    if (action === "links") {
      const view = await buildLinksView(env, inn);
      await editMessage(env, chatId, messageId, view.text, view.reply_markup);
      return;
    }
    if (action === "founders") {
      const view = await buildFoundersView(env, inn);
      await editMessage(env, chatId, messageId, view.text, view.reply_markup);
      return;
    }
    if (action === "branches") {
      const view = await buildBranchesView(env, inn);
      await editMessage(env, chatId, messageId, view.text, view.reply_markup);
      return;
    }
    if (action === "okved") {
      const view = await buildOkvedView(env, inn);
      await editMessage(env, chatId, messageId, view.text, view.reply_markup);
      return;
    }
    if (action === "taxes") {
      const view = await buildTaxesView(env, inn);
      await editMessage(env, chatId, messageId, view.text, view.reply_markup);
      return;
    }
    if (action === "affiliates") {
      const page = Number.parseInt(rawPage || "1", 10);
      const view = await buildAffiliatesView(env, inn, Number.isNaN(page) ? 1 : page);
      await editMessage(env, chatId, messageId, view.text, view.reply_markup);
      return;
    }
    if (action === "bank") {
      const view = await buildBankView(env, inn);
      await editMessage(env, chatId, messageId, view.text, view.reply_markup);
      return;
    }
    if (action === "person") {
      const view = await buildPersonView(env, inn);
      await editMessage(env, chatId, messageId, view.text, view.reply_markup);
      return;
    }
    if (action === "arbitration") {
      const view = buildArbitrationMenuView(inn);
      await editMessage(env, chatId, messageId, view.text, view.reply_markup);
      return;
    }
    if (action === "arb") {
      const page = Number.parseInt(rawPage || "1", 10);
      const view = await buildSectionView(env, "arbitration", inn, Number.isNaN(page) ? 1 : page, "arb");
      await editMessage(env, chatId, messageId, view.text, view.reply_markup);
      return;
    }
    if (action === "contracts") {
      const view = buildContractsMenuView(inn);
      await editMessage(env, chatId, messageId, view.text, view.reply_markup);
      return;
    }
    if (action === "con") {
      const law = rawPage || "44";
      const view = await buildContractsByLawView(env, inn, law);
      await editMessage(env, chatId, messageId, view.text, view.reply_markup);
      return;
    }
    if (SECTION_CONFIG[action]) {
      const page = Number.parseInt(rawPage || "1", 10);
      const view = await buildSectionView(env, action, inn, Number.isNaN(page) ? 1 : page);
      await editMessage(env, chatId, messageId, view.text, view.reply_markup);
    }
  } catch (error) {
    await editMessage(
      env,
      chatId,
      messageId,
      isCheckoNotFoundError(error) ? COMPANY_NOT_FOUND_MESSAGE : CHECKO_SERVICE_ERROR_MESSAGE,
    );
  }
}
__name(handleCallbackQuery, "handleCallbackQuery");
function buildStartView() {
  return {
    text: START_MESSAGE_TEXT,
    reply_markup: {
      inline_keyboard: [
        [kb("🔎 Поиск по ИНН / ОГРН", "search:inn")],
        [kb("🧾 Поиск по названию", "search:name")],
        [kb("🏦 Поиск по БИК", "search:bic")],
        [kb("ℹ️ Помощь", "help")]
      ]
    }
  };
}
__name(buildStartView, "buildStartView");
function buildCompanyInputView() {
  return {
    text: "<b>Поиск компании</b>\n\nОтправьте:\n• <b>ИНН</b> компании\n• или <b>ОГРН</b>",
    reply_markup: { inline_keyboard: [[kb("⬅️ Назад", "back:start")]] }
  };
}
__name(buildCompanyInputView, "buildCompanyInputView");
function buildPersonInputView() {
  return {
    text: "<b>Поиск ИП или физлица</b>\n\nОтправьте:\n• <b>ИНН</b>\n• или <b>ОГРНИП</b>",
    reply_markup: { inline_keyboard: [[kb("⬅️ Назад", "back:start")]] }
  };
}
__name(buildPersonInputView, "buildPersonInputView");
function buildBankInputView() {
  return {
    text: "<b>Поиск банка</b>\n\nОтправьте <b>БИК</b> банка.",
    reply_markup: { inline_keyboard: [[kb("⬅️ Назад", "back:start")]] }
  };
}
__name(buildBankInputView, "buildBankInputView");
function buildStartInfoView() {
  return {
    text: "<b>Что входит в проверку</b>\n\nПосле поиска доступны:\n• основные реквизиты\n• статус и регистрационные данные\n• сведения о руководителе\n• финансовая отчётность\n• арбитражные дела\n• госзакупки\n• проверки контролирующих органов\n• исполнительные производства ФССП\n• сообщения о банкротстве\n• история изменений",
    reply_markup: { inline_keyboard: [[kb("⬅️ Назад", "back:start")]] }
  };
}
__name(buildStartInfoView, "buildStartInfoView");
function buildPersonTypeChoiceView(inn) {
  return {
    text: "<b>Найден ИНН из 12 цифр</b>\n\nВыберите тип поиска:",
    reply_markup: {
      inline_keyboard: [
        [kb("👤 Физлицо", `choose:person:${inn}`)],
        [kb("🧑 ИП", `choose:ip:${inn}`)],
        [kb("⬅️ Назад", "back:start")]
      ]
    }
  };
}
__name(buildPersonTypeChoiceView, "buildPersonTypeChoiceView");
function buildArbitrationMenuView(inn) {
  return {
    text: "<b>⚖️ Арбитраж</b>\n\nВыберите роль компании в делах:",
    reply_markup: {
      inline_keyboard: [
        [kb("🟢 Истец", `arb:${inn}:plaintiff`)],
        [kb("🔴 Ответчик", `arb:${inn}:defendant`)],
        [kb("🏠 В карточку", `main:${inn}`)]
      ]
    }
  };
}
__name(buildArbitrationMenuView, "buildArbitrationMenuView");
function buildContractsMenuView(inn) {
  return {
    text: "<b>🏛 Госзакупки</b>\n\nВыберите категорию:",
    reply_markup: {
      inline_keyboard: [
        [kb("🛒 44-ФЗ Заказчик", `con:${inn}:44c`)],
        [kb("💼 44-ФЗ Поставщик", `con:${inn}:44s`)],
        [kb("🏢 223-ФЗ Заказчик", `con:${inn}:223c`)],
        [kb("🏠 В карточку", `main:${inn}`)]
      ]
    }
  };
}
__name(buildContractsMenuView, "buildContractsMenuView");
async function buildContractsByLawView(env, inn, lawCode) {
  const cfg = SECTION_CONFIG.contracts;
  const lawMap = { "44c": "44", "44s": "44", "223c": "223" };
  const labelMap = { "44c": "44-ФЗ Заказчик", "44s": "44-ФЗ Поставщик", "223c": "223-ФЗ Заказчик" };
  const law = lawMap[lawCode] || "44";
  const label = labelMap[lawCode] || "Госзакупки";
  const payload = await checkoRequest(env, cfg.endpoint, { ...identifierParams(inn), law });
  const rows = takeItems(payload, cfg.listKeys);
  const totalAmount = sumByKeys(rows, ["СуммаКонтракта", "Цена", "Сумма", "amount"]);
  const text = [
    `<b>🏛 ${escapeHtml(label)}</b>`,
    "",
    `📊 Всего контрактов: <b>${rows.length}</b>`,
    `💰 Сумма контрактов: <b>${formatMoney(totalAmount)}</b>`,
    "",
    rows.length > 0 ? "Последние контракты:" : "Контракты не найдены.",
    rows.length > 0 ? previewRows(rows, ["ДатаЗакл", "Дата", "date"], ["НомерКонтракта", "Номер", "number"], ["СуммаКонтракта", "Цена", "amount"]) : ""
  ].join("\n");
  return {
    text,
    reply_markup: {
      inline_keyboard: [
        [kb("⬅️ Назад", `contracts:${inn}`)],
        [kb("🏠 В карточку", `main:${inn}`)]
      ]
    }
  };
}
__name(buildContractsByLawView, "buildContractsByLawView");
async function buildMainCardView(env, inn, entityType) {
  // 10-digit INN or 13-digit OGRN → company; 12-digit INN or 15-digit OGRNIP → entrepreneur
  const endpoint = entityType || (inn.length === 10 || inn.length === 13 ? "company" : "entrepreneur");
  const payload = await checkoRequest(env, endpoint, identifierParams(inn));
  const data = takeEntity(payload);
  if (!data || typeof data !== "object" || !hasCompanyIdentity(data)) {
    throw createCheckoNotFoundError();
  }
  const counts = await collectCounts(env, inn, data);
  const titleFull = pick(data, ["НаимПолн"]);
  const titleShort = pick(data, ["НаимСокр"]);
  const fioTitle = pick(data, ["ФИО"]);
  const title = titleFull || titleShort || fioTitle || "Без названия";
  const innValue = pick(data, ["ИНН"]) || inn;
  const ogrn = pick(data, ["ОГРН", "ОГРНИП"]) || "—";
  const address = pickNested(data, [["ЮрАдрес", "АдресРФ"], ["АдрМЖ", "АдресРФ"], ["Адрес"]]) || "—";
  const region = pickNested(
    data,
    [["ЮрАдрес", "Регион", "Наим"], ["ЮрАдрес", "Регион"], ["Регион", "Наим"], ["Регион"], ["АдрМЖ", "Регион", "Наим"], ["АдрМЖ", "Регион"]]
  ) || deriveRegionFromAddress(address) || "—";
  const statusCode = pickNested(data, [["Статус", "Код"], ["Статус", "Code"], ["СтатусКод"], ["КодСтатуса"]]);
  const statusLookup = lookupStatus(statusCode);
  const status = pickNested(data, [["Статус", "Наим"], ["Статус", "Текст"], ["Статус"]]) || statusLookup?.name || "—";
  const risk = assessOverallRisk(counts, status);
  const director = pickNested(data, [["Руковод", 0, "ФИО"]]) || "—";
  const okvedObj = (typeof data.ОКВЭД === "object" && data.ОКВЭД !== null) ? data.ОКВЭД : {};
  const okvedCode = okvedObj.Код || null;
  const okvedName = okvedObj.Наим || null;
  const okved = okvedCode && okvedName ? `${okvedCode} — ${okvedName}` : (okvedCode || okvedName || null);
  const capital = pickNested(data, [["УстКап", "Сумма"]]);
  const smeCat = pickNested(data, [["РМСП", "Кат"]]);
  const taxDebt = pickNested(data, [["Налоги", "СумНедоим"]]);
  const contacts = (typeof data.Контакты === "object" && data.Контакты !== null) ? data.Контакты : {};
  const phoneRaw = contacts.Тел;
  const emailRaw = contacts.Емэйл;
  const phone = Array.isArray(phoneRaw) ? phoneRaw.join(", ") : (phoneRaw || null);
  const email = Array.isArray(emailRaw) ? emailRaw.join(", ") : (emailRaw || null);
  const websiteRaw = contacts.ВебСайт || null;
  let websiteUrl = null;
  if (websiteRaw) {
    try {
      const urlStr = (/^https?:\/\//i).test(websiteRaw) ? websiteRaw : `https://${websiteRaw}`;
      const parsed = new URL(urlStr);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        websiteUrl = parsed.toString();
      }
    } catch (_) {
      // Invalid URL — omit the link
    }
  }
  const branchCount = countBranches(data);
  const founder = Array.isArray(data.Учред) && data.Учред[0] ? data.Учред[0] : null;
  const founderName = founder ? founder.ФИО || founder.Наим || "—" : "—";
  const founderShare = founder?.Доля?.Проц || founder?.ДоляПроц || founder?.Доля || null;
  const lines = [
    `🏢 <b>${escapeHtml(title)}</b>`,
    `🆔 ОГРН: <code>${escapeHtml(String(ogrn))}</code> · ИНН: <code>${escapeHtml(String(innValue))}</code>`,
    `📌 Статус: <b>${escapeHtml(String(status))}</b>`,
    `📅 Дата регистрации: ${escapeHtml(formatDateValue(data.ДатаРег))}`,
    `🧾 КПП: ${escapeHtml(String(pick(data, ["КПП"]) || "—"))}`,
    okved ? `🏭 ОКВЭД: ${escapeHtml(okved)}` : null,
    `📍 Адрес: ${escapeHtml(String(address))}`,
    `👤 Руководитель: ${escapeHtml(String(director))}`,
    phone ? `📞 Телефон: ${escapeHtml(phone)}` : null,
    email ? `✉️ Email: ${escapeHtml(email)}` : null,
    capital ? `💼 Уставный капитал: ${escapeHtml(formatMoney(capital))}` : null,
    founder ? `👥 Учредитель: ${escapeHtml(String(founderName))}${founderShare ? `, ${escapeHtml(String(founderShare))}%` : ""}` : null,
    `🏬 Филиалы: ${branchCount > 0 ? branchCount : 0}`,
    "",
    "⚠️ <b>Краткая оценка</b>",
    `${risk.icon} Риск: <b>${risk.level}</b>`,
    "",
    "Что важно сразу:",
    Number(taxDebt) > 1000 ? `💸 Налоговая задолженность — ${escapeHtml(formatMoney(taxDebt))}` : "✅ Значимой налоговой задолженности не выявлено",
    `⚖️ Арбитражных дел — ${escapeHtml(String(counts.arbitration ?? "?"))}`,
    `🛡️ ФССП — ${escapeHtml(String(counts.enforcements ?? "?"))}`,
    "📑 Госконтракты — см. раздел Контракты",
    smeCat ? `🏷️ МСП — ${escapeHtml(String(smeCat).toLowerCase())}` : "🏷️ МСП — нет данных"
  ].filter(Boolean);
  const text = lines.join("\n");
  return { text, reply_markup: buildMainKeyboard(inn, counts, endpoint) };
}
__name(buildMainCardView, "buildMainCardView");
async function collectCounts(env, inn, cardData) {
  const result = {};
  const jobs = [
    ["arbitration", () => fetchSectionCount(env, "arbitration", inn)],
    ["bankruptcy", () => fetchSectionCount(env, "bankruptcy", inn)],
    ["financial", () => fetchSectionCount(env, "financial", inn)],
    ["enforcements", () => fetchSectionCount(env, "enforcements", inn)]
  ];
  const settled = await Promise.allSettled(jobs.map(([, fn]) => fn()));
  jobs.forEach(([name], idx) => {
    result[name] = settled[idx].status === "fulfilled" ? settled[idx].value : "?";
  });
  return result;
}
__name(collectCounts, "collectCounts");
function countAffiliates(cardData) {
  const founders = Array.isArray(cardData?.Учред) ? cardData.Учред.length : 0;
  const managers = Array.isArray(cardData?.Руковод) ? cardData.Руковод.length : 0;
  return founders + managers;
}
__name(countAffiliates, "countAffiliates");
async function fetchSectionCount(env, section, inn) {
  if (section === "contracts") {
    const laws = ["44", "94", "223"];
    let total = 0;
    for (const law of laws) {
      const payload2 = await checkoRequest(env, SECTION_CONFIG.contracts.endpoint, { ...identifierParams(inn), law });
      total += takeItems(payload2, SECTION_CONFIG.contracts.listKeys).length;
    }
    return total;
  }
  const cfg = SECTION_CONFIG[section];
  const payload = await checkoRequest(env, cfg.endpoint, identifierParams(inn));
  return takeItems(payload, cfg.listKeys).length;
}
__name(fetchSectionCount, "fetchSectionCount");
function buildMainKeyboard(inn, counts, entityType) {
  return {
    inline_keyboard: [

    ]
  };
}
__name(buildMainKeyboard, "buildMainKeyboard");
async function buildCardDetailsView(env, inn) {
  const payload = await checkoRequest(env, "company", identifierParams(inn));
  const data = takeEntity(payload) || {};
  const director = pickNested(data, [["Руковод", 0, "ФИО"]]) || "—";
  const address = pickNested(data, [["ЮрАдрес", "АдресРФ"], ["Адрес"]]) || "—";
  const text = [
    "🏢 <b>Карточка компании</b>",
    `Полное наименование: ${escapeHtml(String(pick(data, ["НаимПолн"]) || "—"))}`,
    `Краткое наименование: ${escapeHtml(String(pick(data, ["НаимСокр"]) || "—"))}`,
    `ОГРН: ${escapeHtml(String(pick(data, ["ОГРН"]) || "—"))}`,
    `ИНН: ${escapeHtml(String(pick(data, ["ИНН"]) || inn))}`,
    `КПП: ${escapeHtml(String(pick(data, ["КПП"]) || "—"))}`,
    `Дата регистрации: ${escapeHtml(formatDateValue(data.ДатаРег))}`,
    `Адрес: ${escapeHtml(String(address))}`,
    `Руководитель: ${escapeHtml(String(director))}`,
    `Телефон: ${escapeHtml(String(pickNested(data, [["Контакты", "Тел"]]) || "—"))}`
  ].join("\n");
  return { text, reply_markup: backKeyboard(inn) };
}
__name(buildCardDetailsView, "buildCardDetailsView");
async function buildChecksView(env, inn) {
  const payload = await checkoRequest(env, "company", identifierParams(inn));
  const data = takeEntity(payload) || {};
  const counts = await collectCounts(env, inn, data);
  const taxDebt = toNumber(pickNested(data, [["Налоги", "СумНедоим"]]));
  const text = [
    "⚠️ <b>Проверки и факторы риска</b>",
    "Позитивные факторы:",
    `• ${countBranches(data) > 0 ? `есть филиалы — ${countBranches(data)} шт.` : "филиалы не найдены"}`,
    `• категория МСП: ${escapeHtml(String(pickNested(data, [["РМСП", "Кат"]]) || "нет данных"))}`,
    "",
    "Факторы риска:",
    `• задолженность по налогам: ${escapeHtml(formatMoney(taxDebt))}`,
    `• арбитражных дел: ${escapeHtml(String(counts.arbitration ?? "?"))}`,
    `• исполнительные производства ФССП: ${escapeHtml(String(counts.enforcements ?? "?"))}`
  ].join("\n");
  return { text, reply_markup: backKeyboard(inn) };
}
__name(buildChecksView, "buildChecksView");
async function buildLinksView(env, inn) {
  const payload = await checkoRequest(env, "company", identifierParams(inn));
  const data = takeEntity(payload) || {};
  const director = pickNested(data, [["Руковод", 0, "ФИО"]]) || "—";
  const founders = Array.isArray(data.Учред) ? data.Учред : [];
  const founderNames = founders.slice(0, 5).map((f) => f?.ФИО || f?.Наим).filter(Boolean);
  const text = [
    "🔗 <b>Связи компании</b>",
    "По текущему руководителю / учредителю:",
    `• ${escapeHtml(String(director))}`,
    ...founderNames.length ? founderNames.map((name) => `• ${escapeHtml(String(name))}`) : ["• Нет данных"],
    "",
    "По адресу:",
    `• ${escapeHtml(String(pickNested(data, [["ЮрАдрес", "АдресРФ"], ["Адрес"]]) || "нет данных"))}`,
    "",
    "По телефону:",
    `• ${escapeHtml(String(pickNested(data, [["Контакты", "Тел"]]) || "нет данных"))}`,
    "",
    "По email:",
    `• ${escapeHtml(String(pickNested(data, [["Контакты", "Емэйл"]]) || "нет данных"))}`
  ].join("\n");
  return { text, reply_markup: backKeyboard(inn) };
}
__name(buildLinksView, "buildLinksView");
async function buildFoundersView(env, inn) {
  const payload = await checkoRequest(env, "company", identifierParams(inn));
  const data = takeEntity(payload) || {};
  const founders = Array.isArray(data.Учред) ? data.Учред : [];
  const rows = founders.map((f, idx) => {
    const name = f?.ФИО || f?.Наим || "—";
    const share = f?.Доля?.Проц || f?.ДоляПроц || f?.Доля || "—";
    return `${idx + 1}. ${escapeHtml(String(name))} — доля: ${escapeHtml(String(share))}%`;
  });
  const text = ["👥 <b>Учредители</b>", rows.length ? rows.join("\n") : "Нет данных"].join("\n");
  return { text, reply_markup: backKeyboard(inn) };
}
__name(buildFoundersView, "buildFoundersView");
async function buildBranchesView(env, inn) {
  const payload = await checkoRequest(env, "company", identifierParams(inn));
  const data = takeEntity(payload) || {};
  const branches = getBranches(data);
  const rows = branches.map((b, idx) => `${idx + 1}. КПП: ${escapeHtml(String(b?.КПП || "—"))} — ${escapeHtml(String(b?.Адрес || b?.АдресРФ || "—"))}`);
  const text = ["🏢 <b>Филиалы</b>", rows.length ? rows.join("\n") : "Ничего не найдено."].join("\n");
  return { text, reply_markup: backKeyboard(inn) };
}
__name(buildBranchesView, "buildBranchesView");
async function buildOkvedView(env, inn) {
  const payload = await checkoRequest(env, "company", identifierParams(inn));
  const data = takeEntity(payload) || {};
  const primary = data?.ОКВЭД || {};
  const extra = Array.isArray(data?.ОКВЭДДоп) ? data.ОКВЭДДоп : [];
  const text = [
    "🏭 <b>Виды деятельности</b>",
    "Основной:",
    `• ${escapeHtml(String(primary?.Код || "—"))} — ${escapeHtml(String(primary?.Наим || "—"))}`,
    "",
    "Дополнительные:",
    ...(extra.length ? extra.slice(0, 15).map((o) => `• ${escapeHtml(String(o?.Код || "—"))} — ${escapeHtml(String(o?.Наим || "—"))}`) : ["• Нет данных"])
  ].join("\n");
  return { text, reply_markup: backKeyboard(inn) };
}
__name(buildOkvedView, "buildOkvedView");
async function buildTaxesView(env, inn) {
  const payload = await checkoRequest(env, "company", identifierParams(inn));
  const data = takeEntity(payload) || {};
  const tax = data?.Налоги || {};
  const text = [
    "🧾 <b>Налоги</b>",
    `Общая сумма: ${escapeHtml(formatMoney(tax?.Сум || tax?.Сумма || 0))}`,
    `Недоимка: ${escapeHtml(formatMoney(tax?.СумНедоим || 0))}`,
    `Пени/штрафы: ${escapeHtml(formatMoney(tax?.СумПениШтр || 0))}`
  ].join("\n");
  return { text, reply_markup: backKeyboard(inn) };
}
__name(buildTaxesView, "buildTaxesView");
async function buildSectionView(env, section, inn, page, callbackPrefix) {
  const cfg = SECTION_CONFIG[section];
  if (!cfg) {
    throw new Error("Неизвестный раздел");
  }
  const currentPage = page || 1;
  const cbPrefix = callbackPrefix || section;
  let rows = [];
  if (section === "contracts") {
    for (const law of ["44", "94", "223"]) {
      const payload = await checkoRequest(env, cfg.endpoint, { ...identifierParams(inn), law });
      rows.push(...takeItems(payload, cfg.listKeys));
    }
  } else {
    const payload = await checkoRequest(env, cfg.endpoint, identifierParams(inn));
    rows = takeItems(payload, cfg.listKeys);
  }
  const totalPages = Math.max(1, Math.ceil(rows.length / SECTION_PAGE_SIZE));
  const safePage = Math.min(Math.max(currentPage, 1), totalPages);
  const pageRows = rows.slice((safePage - 1) * SECTION_PAGE_SIZE, safePage * SECTION_PAGE_SIZE);
  const text = formatSectionByType(section, rows, pageRows, safePage, totalPages);
  const navRow = [];
  if (safePage > 1) {
    navRow.push(kb("⬅️ Назад", `${cbPrefix}:${inn}:${safePage - 1}`));
  }
  if (totalPages > 1) {
    navRow.push(kb(`📄 ${safePage} / ${totalPages}`, "noop:0"));
  }
  if (safePage < totalPages) {
    navRow.push(kb("➡️ Дальше", `${cbPrefix}:${inn}:${safePage + 1}`));
  }
  const keyboard = {
    inline_keyboard: [
      ...navRow.length ? [navRow] : [],
      [kb("🏠 В карточку", `main:${inn}`)]
    ]
  };
  return { text, reply_markup: keyboard };
}
__name(buildSectionView, "buildSectionView");
function formatSectionByType(section, rows, pageRows, page, totalPages) {
  const displayRows = pageRows || rows.slice(0, SECTION_PAGE_SIZE);
  if (section === "arbitration") {
    if (rows.length === 0) {
      return [
        "⚖️ <b>Арбитражные дела</b>",
        "",
        "✅ Арбитражные дела по компании не найдены."
      ].join("\n");
    }
    const totalAmount = sumByKeys(rows, ["СуммаТреб", "Сумма", "amount"]);
    return [
      "⚖️ <b>Арбитражные дела</b>",
      "",
      `📊 Всего дел: <b>${rows.length}</b>`,
      `💰 Общая сумма: <b>${formatMoney(totalAmount)}</b>`,
      `${rows.length > 0 ? "🔴" : "✅"} Статус риска: <b>${rows.length > 5 ? "Высокий" : rows.length > 0 ? "Средний" : "Низкий"}</b>`,
      "",
      "Последние дела:",
      previewRows(displayRows, ["Дата", "ДатаРег", "date"], ["НомерДела", "Номер", "number"], ["СуммаТреб", "Сумма", "amount"])
    ].join("\n");
  }
  if (section === "bankruptcy") {
    const decodedDisplayRows = decodeBankruptcyRows(displayRows);
    return [
      "<b>📉 Банкротство</b>",
      "",
      `📊 Записей: <b>${rows.length}</b>`,
      rows.length === 0 ? "✅ Статус риска: <b>Отлично</b>" : "⚠️ Статус риска: <b>Требует проверки</b>",
      "",
      rows.length === 0 ? "Нет сведений о процедурах банкротства за всё время." : previewRows(decodedDisplayRows, ["Дата", "ДатаПубл", "date"], ["ТипСообщ", "Тип", "type"], ["Сумма", "amount"])
    ].join("\n");
  }
  if (section === "contracts") {
    const totalAmount = sumByKeys(rows, ["СуммаКонтракта", "Цена", "Сумма", "amount"]);
    return [
      "📑 <b>Госконтракты и закупки</b>",
      "",
      `📊 Всего контрактов: <b>${rows.length}</b>`,
      `💰 Сумма контрактов: <b>${formatMoney(totalAmount)}</b>`,
      rows.length > 0 ? "✅ Статус риска: <b>Низкий</b>" : "⚠️ Статус риска: <b>Нет данных</b>",
      "",
      "Последние контракты:",
      previewRows(displayRows, ["ДатаЗакл", "Дата", "date"], ["НомерКонтракта", "Номер", "number"], ["СуммаКонтракта", "Цена", "amount"])
    ].join("\n");
  }
  if (section === "inspections") {
    return [
      "⚠️ <b>Проверки и факторы риска</b>",
      "",
      `📊 Всего проверок: <b>${rows.length}</b>`,
      rows.length <= 3 ? "✅ Статус риска: <b>Низкий</b>" : "⚠️ Статус риска: <b>Средний</b>",
      "",
      "Последние проверки:",
      previewRows(displayRows, ["ДатаНач", "Дата", "date"], ["Орган", "ВидПроверки", "type"], [])
    ].join("\n");
  }
  if (section === "financial") {
    if (rows.length === 0) {
      return [
        "💰 <b>Финансы</b>",
        "",
        "⚠️ Финансовая отчётность по компании не найдена."
      ].join("\n");
    }
    const last = rows[0] || {};
    const revenue = pick(last, ["2110", "Выручка", "revenue"]);
    const profit = pick(last, ["2400", "ЧистПриб", "netProfit"]);
    const assets = pick(last, ["1600", "Активы", "assets"]);
    const revenueLabel = lookupAccountCode("2110")?.name || "Выручка";
    const profitLabel = lookupAccountCode("2400")?.name || "Чистая прибыль";
    const assetsLabel = lookupAccountCode("1600")?.name || "Активы";
    return [
      "💰 <b>Финансы</b>",
      "",
      `📊 Периодов в отчётности: <b>${rows.length}</b>`,
      `• ${escapeHtml(revenueLabel)}: <b>${formatMoney(revenue)}</b>`,
      `• ${escapeHtml(profitLabel)}: <b>${formatMoney(profit)}</b>`,
      `• ${escapeHtml(assetsLabel)}: <b>${formatMoney(assets)}</b>`,
      Number(profit || 0) > 0 ? "✅ Статус риска: <b>Отлично</b>" : "⚠️ Статус риска: <b>Требует проверки</b>"
    ].join("\n");
  }
  if (section === "enforcements") {
    const totalAmount = sumByKeys(rows, ["СуммаДолга", "Сумма", "amount"]);
    return [
      "🛡️ <b>Исполнительные производства</b>",
      "",
      `📊 Всего: <b>${rows.length}</b>`,
      `💰 Сумма к взысканию: <b>${formatMoney(totalAmount)}</b>`,
      rows.length === 0 ? "✅ Статус риска: <b>Низкий</b>" : "⚠️ Статус риска: <b>Средний</b>",
      "",
      "Последние:",
      previewRows(displayRows, ["ДатаВозб", "Дата", "date"], ["НомерИП", "Номер", "number"], ["СуммаДолга", "Сумма", "amount"])
    ].join("\n");
  }
  if (section === "history") {
    return [
      "🕓 <b>История изменений</b>",
      "",
      `📊 Всего записей: <b>${rows.length}</b>`,
      "",
      "Последние изменения:",
      previewRows(displayRows, ["Дата", "ДатаИзм", "date"], ["Событие", "ВидИзм", "type"], [])
    ].join("\n");
  }
  if (section === "fedresurs") {
    const decodedDisplayRows = decodeBankruptcyRows(displayRows);
    return [
      "<b>📋 Сообщения на Федресурсе</b>",
      "",
      `📊 Всего сообщений: <b>${rows.length}</b>`,
      "",
      "Последние:",
      previewRows(decodedDisplayRows, ["Дата", "ДатаПубл", "date"], ["ТипСообщ", "Тип", "type"], [])
    ].join("\n");
  }
  return "<b>Данные отсутствуют</b>";
}
__name(formatSectionByType, "formatSectionByType");
async function buildPersonView(env, inn) {
  const payload = await checkoRequest(env, "person", identifierParams(inn));
  const data = takeEntity(payload);
  const text = [
    "<b>👤 Физическое лицо</b>",
    "",
    `ФИО: <b>${escapeHtml(String(pick(data || {}, ["ФИО"]) || "—"))}</b>`,
    `ИНН: <b>${escapeHtml(String(pick(data || {}, ["ИНН"]) || inn))}</b>`,
    `Связанные компании: <b>${escapeHtml(String(pick(data || {}, ["Связи", "КолСвязей"]) || "—"))}</b>`
  ].join("\n");
}
__name(buildPersonView, "buildPersonView");
async function buildBankView(env, inn) {
  const companyPayload = await checkoRequest(env, "company", identifierParams(inn));
  const company = takeEntity(companyPayload);
  const bik = pickNested(company || {}, [["Банк", "БИК"], ["БИК"]]);
  if (!bik) {
    return {
      text: "<b>🏦 Реквизиты банка</b>\n\nБИК не найден в карточке компании.",
      reply_markup: backKeyboard(inn)
    };
  }
  const bankPayload = await checkoRequest(env, "bank", { bic: bik });
  const bank = takeEntity(bankPayload);
  const corr = pickNested(bank || {}, [["КорСчет", "Номер"]]) || "—";
  const text = [
    "<b>🏦 Реквизиты банка</b>",
    "",
    `БИК: <b>${escapeHtml(String(pick(bank || {}, ["БИК"]) || "—"))}</b>`,
    `Название: <b>${escapeHtml(String(pick(bank || {}, ["Наим"]) || "—"))}</b>`,
    `Корр. счёт: <b>${escapeHtml(String(corr))}</b>`
  ].join("\n");
  return { text, reply_markup: backKeyboard(inn) };
}
__name(buildBankView, "buildBankView");
async function buildBicView(env, bic) {
  const bankPayload = await checkoRequest(env, "bank", { bic });
  const bank = takeEntity(bankPayload);
  const corr = pickNested(bank || {}, [["КорСчет", "Номер"]]) || "—";
  const text = [
    "<b>🏦 Банк / Кредитная организация</b>",
    "",
    `БИК: <b>${escapeHtml(String(bic))}</b>`,
    `Название: <b>${escapeHtml(String(pick(bank || {}, ["Наим"]) || "—"))}</b>`,
    `Адрес: <b>${escapeHtml(String(pick(bank || {}, ["Адрес"]) || "—"))}</b>`,
    `Тип: <b>${escapeHtml(String(pick(bank || {}, ["Тип"]) || "—"))}</b>`,
    `Корр. счёт: <b>${escapeHtml(String(corr))}</b>`
  ].join("\n");
}
__name(buildBicView, "buildBicView");
async function buildAffiliatesView(env, inn, page) {
  const payload = await checkoRequest(env, "company", identifierParams(inn));
  const company = takeEntity(payload) || {};
  const leaders = (Array.isArray(company.Руковод) ? company.Руковод : []).map((item) => ({
    type: "Руководитель",
    name: item?.ФИО || "—",
    inn: item?.ИНН || null,
    share: null
  }));
  const founders = (Array.isArray(company.Учред) ? company.Учред : []).map((item) => ({
    type: "Учредитель",
    name: item?.Наим || item?.ФИО || "—",
    inn: item?.ИНН || null,
    share: item?.Доля?.Проц || item?.Доля || item?.ДоляПроц || null
  }));
  const all = [...leaders, ...founders];
  const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const start = (safePage - 1) * PAGE_SIZE;
  const chunk = all.slice(start, start + PAGE_SIZE);
  const rows = chunk.length ? chunk.map((item, idx) => {
    const num = start + idx + 1;
    const innPart = item.inn ? ` (ИНН ${item.inn})` : "";
    const sharePart = item.share ? ` — ${item.share}%` : "";
    return `${num}. ${escapeHtml(item.name)}${innPart}${sharePart} [${item.type}]`;
  }) : ["Данные отсутствуют."];
  const navRow = [];
  if (safePage > 1) {
    navRow.push(kb("⬅️ Назад", `affiliates:${inn}:${safePage - 1}`));
  }
  if (safePage < totalPages) {
    navRow.push(kb("➡️ Дальше", `affiliates:${inn}:${safePage + 1}`));
  }
  const keyboard = {
    inline_keyboard: [
      ...navRow.length ? [navRow] : [],
      [kb("⬅️ Назад к главной", `main:${inn}`)]
    ]
  };
  const text = [
    `<b>👥 Аффилированные лица (${all.length})</b>`,
    "",
    `Страница ${safePage}/${totalPages}`,
    "",
    rows.join("\n")
  ].join("\n");
  return { text, reply_markup: keyboard };
}
__name(buildAffiliatesView, "buildAffiliatesView");
function sectionExtraButton(section, count, inn) {
  return null;
}
__name(sectionExtraButton, "sectionExtraButton");
function decodeBankruptcyRows(rows) {
  return rows.map((row) => {
    const typeCode = pick(row, ["ТипСообщ", "Тип", "type", "messageType"]);
    const decoded = lookupBankruptcyMessageType(typeCode);
    if (!decoded?.name || decoded.name === typeCode) {
      return row;
    }
    return {
      ...row,
      ТипСообщ: `${decoded.name} (${typeCode})`
    };
  });
}
__name(decodeBankruptcyRows, "decodeBankruptcyRows");
function previewRows(rows, dateKeys, nameKeys, amountKeys) {
  if (!rows.length) {
    return "Данные отсутствуют.";
  }
  return rows.map((row) => {
    const date = pick(row, dateKeys) || "—";
    const name = pick(row, nameKeys) || "Запись";
    const amount = amountKeys.length ? pick(row, amountKeys) : null;
    const suffix = amount ? ` — <b>${escapeHtml(formatMoney(amount))}</b>` : "";
    return `• ${escapeHtml(String(date))} — ${escapeHtml(String(name))}${suffix}`;
  }).join("\n");
}
__name(previewRows, "previewRows");
function sumByKeys(rows, keys) {
  return rows.reduce((acc, row) => acc + toNumber(pick(row, keys)), 0);
}
__name(sumByKeys, "sumByKeys");
function toNumber(value) {
  if (value === null || value === void 0 || value === "") {
    return 0;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  const normalized = String(value).replace(/\s+/g, "").replace(",", ".").replace(/[^\d.-]/g, "");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}
__name(toNumber, "toNumber");
function formatMoney(value) {
  const num = toNumber(value);
  if (!num) {
    return "0 ₽";
  }
  return `${Math.round(num).toLocaleString("ru-RU")} ₽`;
}
__name(formatMoney, "formatMoney");
const INACTIVE_STATUS_PATTERNS = [
  "не действует", "ликвидирован", "ликвидирована", "ликвидировано",
  "прекратил", "прекратила", "прекратило", "исключен", "исключена"
];
function isInactiveStatus(status) {
  if (!status || status === "—") return false;
  const lower = String(status).toLowerCase();
  return INACTIVE_STATUS_PATTERNS.some((p) => lower.includes(p));
}
__name(isInactiveStatus, "isInactiveStatus");
function assessOverallRisk(counts, statusText) {
  const score = Number(counts.arbitration || 0) * 4 + Number(counts.bankruptcy || 0) * 10 + Number(counts.enforcements || 0) * 6;
  const inactive = isInactiveStatus(statusText);
  if (score >= 40) {
    return { icon: "🔴", level: "Высокий", note: "(рекомендуется проверить Арбитраж и Финансы)" };
  }
  if (score > 0) {
    return { icon: "🟡", level: "Средний", note: "(есть сигналы для дополнительной проверки)" };
  }
  if (inactive) {
    return { icon: "🟡", level: "Средний", note: "(компания не действует — повышенный риск контрагента)" };
  }
  return { icon: "🟢", level: "Низкий", note: "(критичных сигналов риска не выявлено)" };
}
__name(assessOverallRisk, "assessOverallRisk");
function backKeyboard(inn) {
  return { inline_keyboard: [[kb("🏠 В карточку", `main:${inn}`)]] };
}
__name(backKeyboard, "backKeyboard");
function kb(text, callback_data) {
  return { text, callback_data };
}
__name(kb, "kb");
async function editMessage(env, chatId, messageId, text, replyMarkup) {
  await telegramRequest(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    reply_markup: replyMarkup
  });
}
__name(editMessage, "editMessage");
async function sendMessage(env, body) {
  await telegramRequest(env, "sendMessage", body);
}
__name(sendMessage, "sendMessage");
function ensureTelegramSecret(env) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("Missing required secret TELEGRAM_BOT_TOKEN.");
  }
}
__name(ensureTelegramSecret, "ensureTelegramSecret");
function verifyTelegramWebhookSecret(request, env) {
  if (!env.WEBHOOK_SECRET)
    return;
  const token = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (token !== env.WEBHOOK_SECRET) {
    throw new Error("Unauthorized: invalid webhook secret token.");
  }
}
__name(verifyTelegramWebhookSecret, "verifyTelegramWebhookSecret");
async function checkoRequest(env, endpoint, params = {}) {
  if (!env.CHECKO_API_KEY) {
    throw createCheckoServiceError("Missing required secret CHECKO_API_KEY.");
  }
  const baseUrl = (env.CHECKO_API_URL || DEFAULT_CHECKO_API_URL).replace(/\/$/, "");
  const url = new URL(`${baseUrl}/${endpoint}`);
  url.searchParams.set("key", env.CHECKO_API_KEY);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== void 0 && value !== null) {
      url.searchParams.set(key, String(value));
    }
  });
  let response;
  try {
    response = await fetchWithTimeout(url.toString(), { method: "GET" }, 15e3);
  } catch (error) {
    throw createCheckoServiceError(`Checko request failed: ${String(error.message || error)}`);
  }
  const raw = await response.text();
  if (response.status !== 200) {
    throw createCheckoServiceError(`Checko HTTP ${response.status}: ${raw.slice(0, 300)}`);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw createCheckoServiceError(`Checko non-JSON response: ${raw.slice(0, 300)}`);
  }
  const metaStatus = payload?.meta?.status;
  const metaMessage = payload?.meta?.message;
  if (metaStatus && !["ok", "success"].includes(String(metaStatus).toLowerCase())) {
    throw createCheckoServiceError(`Checko meta ${String(metaStatus)}: ${String(metaMessage || "unknown")}`);
  }
  return payload;
}
__name(checkoRequest, "checkoRequest");
function takeEntity(payload) {
  const data = payload?.payload?.data ?? payload?.data ?? payload;
  return Array.isArray(data) ? data[0] || null : data;
}
__name(takeEntity, "takeEntity");
function takeItems(payload, keys) {
  // Try known nesting paths in priority order
  const candidates = [
    payload?.payload?.data,
    payload?.data,
    payload?.payload,
    payload
  ];
  for (const data of candidates) {
    if (Array.isArray(data)) {
      return data;
    }
    if (data && typeof data === "object") {
      for (const key of keys) {
        if (Array.isArray(data[key])) {
          return data[key];
        }
      }
    }
  }
  return [];
}
__name(takeItems, "takeItems");
function pick(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== void 0 && value !== null && value !== "") {
      return value;
    }
  }
  return null;
}
__name(pick, "pick");
function pickNested(obj, paths) {
  for (const path of paths) {
    let cur = obj;
    for (const key of path) {
      if (cur === null || cur === void 0) {
        cur = null;
        break;
      }
      cur = cur[key];
    }
    if (cur !== void 0 && cur !== null && cur !== "") {
      return cur;
    }
  }
  return null;
}
__name(pickNested, "pickNested");
function hasCompanyIdentity(data) {
  return Boolean(pick(data, ["НаимПолн", "НаимСокр", "ФИО", "ИНН", "ОГРН", "ОГРНИП"]));
}
__name(hasCompanyIdentity, "hasCompanyIdentity");
function formatDateValue(value) {
  if (!value) return "—";
  if (value instanceof Date) return formatDate(value);
  if (typeof value === "string") {
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}.${m[2]}.${m[1]}`;
  }
  return String(value);
}
__name(formatDateValue, "formatDateValue");
function getBranches(data) {
  const candidates = [data?.Филиалы, data?.Филиал, data?.ОбособПодр, data?.Фил]
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}
__name(getBranches, "getBranches");
function countBranches(data) {
  return getBranches(data).length;
}
__name(countBranches, "countBranches");
function deriveRegionFromAddress(address) {
  if (!address || address === "—") {
    return null;
  }
  const parts = String(address).split(",").map((part) => part.trim()).filter(Boolean);
  return parts[0] || null;
}
__name(deriveRegionFromAddress, "deriveRegionFromAddress");
function formatDate(date) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}
__name(formatDate, "formatDate");
function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
}
__name(escapeHtml, "escapeHtml");
function createCheckoNotFoundError(message = COMPANY_NOT_FOUND_MESSAGE) {
  const error = new Error(message);
  error.name = "CheckoNotFoundError";
  return error;
}
__name(createCheckoNotFoundError, "createCheckoNotFoundError");
function createCheckoServiceError(message = CHECKO_SERVICE_ERROR_MESSAGE) {
  const error = new Error(message);
  error.name = "CheckoServiceError";
  return error;
}
__name(createCheckoServiceError, "createCheckoServiceError");
function isCheckoNotFoundError(error) {
  return error instanceof Error && error.name === "CheckoNotFoundError";
}
__name(isCheckoNotFoundError, "isCheckoNotFoundError");
function identifierParams(id) {
  if (id.length === 9) return { bic: id };
  if (id.length === 13) return { ogrn: id };
  if (id.length === 15) return { ogrnip: id };
  return { inn: id };
}
__name(identifierParams, "identifierParams");
async function telegramRequest(env, method, body) {
  const endpoint = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body)
    },
    1e4
  );
  if (response.status !== 200) {
    const raw = await response.text();
    throw new Error(`Telegram API ${method} failed (${response.status}): ${raw.slice(0, 300)}`);
  }
}
__name(telegramRequest, "telegramRequest");
async function parseJsonOrThrow(request) {
  try {
    return await request.json();
  } catch {
    throw new Error("Invalid JSON in webhook request.");
  }
}
__name(parseJsonOrThrow, "parseJsonOrThrow");
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
__name(fetchWithTimeout, "fetchWithTimeout");
function resolveWebhookPaths(env) {
  const configuredPath = normalizeWebhookPath(env.WEBHOOK_PATH);
  const paths = [configuredPath];
  if (configuredPath !== "/") {
    paths.push("/");
  }
  return paths;
}
__name(resolveWebhookPaths, "resolveWebhookPaths");
function normalizeWebhookPath(input) {
  if (!input) {
    return DEFAULT_WEBHOOK_PATH;
  }
  return input.startsWith("/") ? input : `/${input}`;
}
__name(normalizeWebhookPath, "normalizeWebhookPath");
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
__name(jsonResponse, "jsonResponse");
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
