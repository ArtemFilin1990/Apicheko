var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var DEFAULT_CHECKO_API_URL = "https://api.checko.ru/v2";
var DEFAULT_WEBHOOK_PATH = "/";
var PAGE_SIZE = 10;
var SECTION_CONFIG = {
  arbitration: {
    title: "⚖️ Арбитражные дела",
    endpoint: "legal-cases",
    listKeys: ["Дела", "cases"],
    countLabel: "Количество дел"
  },
  bankruptcy: {
    title: "🏦 Банкротство (ЕФРСБ)",
    endpoint: "bankruptcy-messages",
    listKeys: ["Сообщения", "messages"],
    countLabel: "Записей о банкротстве"
  },
  contracts: {
    title: "💼 Госзакупки (44-ФЗ / 223-ФЗ)",
    endpoint: "contracts",
    listKeys: ["Контракты", "items"],
    countLabel: "Всего контрактов"
  },
  inspections: {
    title: "🔍 Проверки и КНМ",
    endpoint: "inspections",
    listKeys: ["Проверки", "items"],
    countLabel: "Всего проверок"
  },
  financial: {
    title: "📊 Финансовая отчётность",
    endpoint: "finances",
    listKeys: ["Отчеты", "reports"],
    countLabel: "Лет в отчётности"
  },
  enforcements: {
    title: "🏛️ Исполнительные производства",
    endpoint: "enforcements",
    listKeys: ["ИП", "items"],
    countLabel: "Всего"
  },
  history: {
    title: "📜 История изменений",
    endpoint: "timeline",
    listKeys: ["События", "events"],
    countLabel: "Всего записей"
  },
  fedresurs: {
    title: "📋 Федресурс",
    endpoint: "fedresurs",
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
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
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
    await sendMessage(env, {
      chat_id: chatId,
      text: "👋 Бот работает. Отправьте ИНН, и я проверю компанию."
    });
    return jsonResponse({ ok: true });
  }
  const innClean = text.replace(/\s+/g, "");
  if (/^\d{10}$/.test(innClean) || /^\d{12}$/.test(innClean) || /^\d{13}$/.test(innClean) || /^\d{15}$/.test(innClean) || /^\d{9}$/.test(innClean)) {
    try {
      let view;
      if (innClean.length === 9) {
        view = await buildBicView(env, innClean);
      } else {
        view = await buildMainCardView(env, innClean);
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
        text: `⚠️ <b>Ошибка получения данных</b>\n\n<code>${escapeHtml(String(error.message || error))}</code>`,
        parse_mode: "HTML"
      });
    }
    return jsonResponse({ ok: true });
  }
  await sendMessage(env, {
    chat_id: chatId,
    text: "ℹ️ Отправьте ИНН компании (10 цифр), ИП (12 цифр), ОГРН (13 цифр), ОГРНИП (15 цифр) или БИК банка (9 цифр) для проверки.\n\nНапример: <code>7707083893</code>",
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
  const [action, inn, rawPage] = data.split(":");
  if (!inn || !(/^\d{10}$/.test(inn) || /^\d{12}$/.test(inn) || /^\d{13}$/.test(inn) || /^\d{15}$/.test(inn))) {
    return;
  }
  try {
    if (action === "main") {
      const view = await buildMainCardView(env, inn);
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
    if (SECTION_CONFIG[action]) {
      const view = await buildSectionView(env, action, inn);
      await editMessage(env, chatId, messageId, view.text, view.reply_markup);
    }
  } catch (error) {
    await editMessage(
      env,
      chatId,
      messageId,
      `⚠️ <b>Ошибка загрузки раздела</b>\n\n<code>${escapeHtml(String(error.message || error))}</code>`,
      backKeyboard(inn)
    );
  }
}
__name(handleCallbackQuery, "handleCallbackQuery");
async function buildMainCardView(env, inn) {
  // 10-digit INN or 13-digit OGRN → company; 12-digit INN or 15-digit OGRNIP → entrepreneur
  const endpoint = (inn.length === 10 || inn.length === 13) ? "company" : "entrepreneur";
  const payload = await checkoRequest(env, endpoint, identifierParams(inn));
  const data = takeEntity(payload);
  if (!data || typeof data !== "object") {
    throw new Error("Карточка компании пуста: data отсутствует.");
  }
  const counts = await collectCounts(env, inn, data);
  const title = pick(data, ["НаимПолн", "НаимСокр", "ФИО"]) || "Без названия";
  const ogrn = pick(data, ["ОГРН", "ОГРНИП"]) || "—";
  const address = pickNested(data, [["ЮрАдрес", "АдресРФ"], ["АдрМЖ", "АдресРФ"], ["Адрес"]]) || "—";
  const director = pickNested(data, [["Руковод", 0, "ФИО"]]) || "—";
  const capital = pickNested(data, [["УстКап", "Сумма"]]) || "—";
  const okvedCode = pickNested(data, [["ОКВЭД", "Код"]]) || "—";
  const okvedName = pickNested(data, [["ОКВЭД", "Наим"]]) || "—";
  const staff = pick(data, ["СрСпЧисл", "ЧислСотр"]) || "—";
  const founders = Array.isArray(data.Учред) ? data.Учред : [];
  const founderNote = founders.length ? `${founders.length}` : "0";
  const risk = assessOverallRisk(counts);
  const text = [
    `🏦 <b>${escapeHtml(title)}</b>`,
    `<code>ИНН ${escapeHtml(String(data.ИНН || inn))} | ОГРН ${escapeHtml(String(ogrn))}</code>`,
    "",
    `📍 ${escapeHtml(String(address))}`,
    `📅 Дата регистрации: <b>${escapeHtml(String(data.ДатаРег || "—"))}</b>`,
    `💰 Уставный капитал: <b>${escapeHtml(String(capital))} ₽</b>`,
    `👤 Руководитель: ${escapeHtml(String(director))}`,
    `👥 Учредители: <b>${escapeHtml(founderNote)}</b>`,
    `📊 Основной ОКВЭД: <b>${escapeHtml(okvedCode)} (${escapeHtml(okvedName)})</b>`,
    `👤 Численность: <b>${escapeHtml(String(staff))} человек</b>`,
    "",
    `${risk.icon} Общий риск компании: <b>${risk.level}</b>`,
    `${risk.note}`,
    `🔄 Обновлено: ${formatDate(/* @__PURE__ */ new Date())}`
  ].join("\n");
  return { text, reply_markup: buildMainKeyboard(inn, counts) };
}
__name(buildMainCardView, "buildMainCardView");
async function collectCounts(env, inn, cardData) {
  const result = {};
  const jobs = [
    ["arbitration", () => fetchSectionCount(env, "arbitration", inn)],
    ["bankruptcy", () => fetchSectionCount(env, "bankruptcy", inn)],
    ["contracts", () => fetchSectionCount(env, "contracts", inn)],
    ["inspections", () => fetchSectionCount(env, "inspections", inn)],
    ["financial", () => fetchSectionCount(env, "financial", inn)],
    ["enforcements", () => fetchSectionCount(env, "enforcements", inn)],
    ["history", () => fetchSectionCount(env, "history", inn)],
    ["fedresurs", () => fetchSectionCount(env, "fedresurs", inn)],
    ["person", async () => Number(pick(cardData, ["КолСвязейФЛ"]) || 0)],
    ["affiliates", async () => countAffiliates(cardData)]
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
function buildMainKeyboard(inn, counts) {
  const c = /* @__PURE__ */ __name((key) => counts[key] ?? "?", "c");
  return {
    inline_keyboard: [
      [
        kb(`⚖️ Суды и арбитраж (${c("arbitration")})`, `arbitration:${inn}`),
        kb(`🏦 ЕФРСБ / Банкротство (${c("bankruptcy")})`, `bankruptcy:${inn}`)
      ],
      [
        kb(`💼 Госзакупки (${c("contracts")})`, `contracts:${inn}`),
        kb(`🔍 Проверки и КНМ (${c("inspections")})`, `inspections:${inn}`)
      ],
      [
        kb(`📊 Финансовая отчётность (${c("financial")})`, `financial:${inn}`),
        kb(`🏛️ ФССП (${c("enforcements")})`, `enforcements:${inn}`)
      ],
      [
        kb(`📜 История изменений (${c("history")})`, `history:${inn}`),
        kb(`📋 Федресурс (${c("fedresurs")})`, `fedresurs:${inn}`)
      ],
      [
        kb(`👥 Аффилированные лица (${c("affiliates")})`, `affiliates:${inn}:1`),
        kb(`👤 Проверка физлица (${c("person")})`, `person:${inn}`)
      ],
      [
        kb("🏦 Проверка банка", `bank:${inn}`),
        kb("🔄 Обновить карточку", `main:${inn}`)
      ]
    ]
  };
}
__name(buildMainKeyboard, "buildMainKeyboard");
async function buildSectionView(env, section, inn) {
  const cfg = SECTION_CONFIG[section];
  if (!cfg) {
    throw new Error("Неизвестный раздел");
  }
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
  const text = formatSectionByType(section, rows);
  const extra = sectionExtraButton(section, rows.length, inn);
  return {
    text,
    reply_markup: extra ? { inline_keyboard: [[extra], [kb("⬅️ Назад к главной", `main:${inn}`)]] } : backKeyboard(inn)
  };
}
__name(buildSectionView, "buildSectionView");
function formatSectionByType(section, rows) {
  if (section === "arbitration") {
    const totalAmount = sumByKeys(rows, ["СуммаТреб", "Сумма", "amount"]);
    return [
      "<b>⚖️ Арбитражные дела</b>",
      "",
      `📊 Всего дел: <b>${rows.length}</b>`,
      `💰 Общая сумма: <b>${formatMoney(totalAmount)}</b>`,
      `${rows.length > 0 ? "🔴" : "✅"} Статус риска: <b>${rows.length > 5 ? "Высокий" : rows.length > 0 ? "Средний" : "Низкий"}</b>`,
      "",
      "Последние дела:",
      previewRows(rows, ["Дата", "ДатаРег", "date"], ["НомерДела", "Номер", "number"], ["СуммаТреб", "Сумма", "amount"])
    ].join("\n");
  }
  if (section === "bankruptcy") {
    return [
      "<b>🏦 Банкротство (ЕФРСБ)</b>",
      "",
      `📊 Записей: <b>${rows.length}</b>`,
      rows.length === 0 ? "✅ Статус риска: <b>Отлично</b>" : "⚠️ Статус риска: <b>Требует проверки</b>",
      "",
      rows.length === 0 ? "Нет сведений о процедурах банкротства за всё время." : previewRows(rows, ["Дата", "ДатаПубл", "date"], ["ТипСообщ", "Тип", "type"], ["Сумма", "amount"])
    ].join("\n");
  }
  if (section === "contracts") {
    const totalAmount = sumByKeys(rows, ["СуммаКонтракта", "Цена", "Сумма", "amount"]);
    return [
      "<b>💼 Госзакупки 44-ФЗ / 223-ФЗ</b>",
      "",
      `📊 Всего контрактов: <b>${rows.length}</b>`,
      `💰 Сумма контрактов: <b>${formatMoney(totalAmount)}</b>`,
      rows.length > 0 ? "✅ Статус риска: <b>Низкий</b>" : "⚠️ Статус риска: <b>Нет данных</b>",
      "",
      "Последние контракты:",
      previewRows(rows, ["ДатаЗакл", "Дата", "date"], ["НомерКонтракта", "Номер", "number"], ["СуммаКонтракта", "Цена", "amount"])
    ].join("\n");
  }
  if (section === "inspections") {
    return [
      "<b>🔍 Проверки и КНМ</b>",
      "",
      `📊 Всего проверок: <b>${rows.length}</b>`,
      rows.length <= 3 ? "✅ Статус риска: <b>Низкий</b>" : "⚠️ Статус риска: <b>Средний</b>",
      "",
      "Последние проверки:",
      previewRows(rows, ["ДатаНач", "Дата", "date"], ["Орган", "ВидПроверки", "type"], [])
    ].join("\n");
  }
  if (section === "financial") {
    const last = rows[0] || {};
    const revenue = pick(last, ["2110", "Выручка", "revenue"]);
    const profit = pick(last, ["2400", "ЧистПриб", "netProfit"]);
    const assets = pick(last, ["1600", "Активы", "assets"]);
    return [
      "<b>📊 Финансовая отчётность</b>",
      "",
      `📊 Периодов в отчётности: <b>${rows.length}</b>`,
      `• Выручка: <b>${formatMoney(revenue)}</b>`,
      `• Чистая прибыль: <b>${formatMoney(profit)}</b>`,
      `• Активы: <b>${formatMoney(assets)}</b>`,
      Number(profit || 0) > 0 ? "✅ Статус риска: <b>Отлично</b>" : "⚠️ Статус риска: <b>Требует проверки</b>"
    ].join("\n");
  }
  if (section === "enforcements") {
    const totalAmount = sumByKeys(rows, ["СуммаДолга", "Сумма", "amount"]);
    return [
      "<b>🏛️ Исполнительные производства</b>",
      "",
      `📊 Всего: <b>${rows.length}</b>`,
      `💰 Сумма к взысканию: <b>${formatMoney(totalAmount)}</b>`,
      rows.length === 0 ? "✅ Статус риска: <b>Низкий</b>" : "⚠️ Статус риска: <b>Средний</b>",
      "",
      "Последние:",
      previewRows(rows, ["ДатаВозб", "Дата", "date"], ["НомерИП", "Номер", "number"], ["СуммаДолга", "Сумма", "amount"])
    ].join("\n");
  }
  if (section === "history") {
    return [
      "<b>📜 История изменений</b>",
      "",
      `📊 Всего записей: <b>${rows.length}</b>`,
      "",
      "Последние изменения:",
      previewRows(rows, ["Дата", "ДатаИзм", "date"], ["Событие", "ВидИзм", "type"], [])
    ].join("\n");
  }
  if (section === "fedresurs") {
    return [
      "<b>📋 Сообщения на Федресурсе</b>",
      "",
      `📊 Всего сообщений: <b>${rows.length}</b>`,
      "",
      "Последние:",
      previewRows(rows, ["Дата", "ДатаПубл", "date"], ["ТипСообщ", "Тип", "type"], [])
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
  return { text, reply_markup: backKeyboard(inn) };
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
    `БИК: <b>${escapeHtml(String(pick(bank || {}, ["БИК"]) || bic))}</b>`,
    `Название: <b>${escapeHtml(String(pick(bank || {}, ["Наим"]) || "—"))}</b>`,
    `Адрес: <b>${escapeHtml(String(pick(bank || {}, ["Адрес"]) || "—"))}</b>`,
    `Тип: <b>${escapeHtml(String(pick(bank || {}, ["Тип"]) || "—"))}</b>`,
    `Корр. счёт: <b>${escapeHtml(String(corr))}</b>`
  ].join("\n");
  return { text, reply_markup: { inline_keyboard: [] } };
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
  if (section === "arbitration") {
    return kb(`📋 Все ${count} дел`, `arbitration:${inn}`);
  }
  if (section === "financial") {
    return kb("📈 Полная отчётность", `financial:${inn}`);
  }
  if (section === "enforcements") {
    return kb("📋 Все производства", `enforcements:${inn}`);
  }
  return null;
}
__name(sectionExtraButton, "sectionExtraButton");
function previewRows(rows, dateKeys, nameKeys, amountKeys) {
  if (!rows.length) {
    return "Данные отсутствуют.";
  }
  return rows.slice(0, 5).map((row) => {
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
function assessOverallRisk(counts) {
  const score = Number(counts.arbitration || 0) * 4 + Number(counts.bankruptcy || 0) * 10 + Number(counts.enforcements || 0) * 6;
  if (score >= 40) {
    return { icon: "🔴", level: "Высокий", note: "(рекомендуется проверить Арбитраж и Финансы)" };
  }
  if (score > 0) {
    return { icon: "🟡", level: "Средний", note: "(есть сигналы для дополнительной проверки)" };
  }
  return { icon: "🟢", level: "Низкий", note: "(критичных сигналов риска не выявлено)" };
}
__name(assessOverallRisk, "assessOverallRisk");
function backKeyboard(inn) {
  return { inline_keyboard: [[kb("⬅️ В карточку компании", `main:${inn}`)]] };
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
  const baseUrl = (env.CHECKO_API_URL || DEFAULT_CHECKO_API_URL).replace(/\/$/, "");
  const url = new URL(`${baseUrl}/${endpoint}`);
  url.searchParams.set("key", env.CHECKO_API_KEY);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== void 0 && value !== null) {
      url.searchParams.set(key, String(value));
    }
  });
  const response = await fetchWithTimeout(url.toString(), { method: "GET" }, 15e3);
  const raw = await response.text();
  if (response.status !== 200) {
    throw new Error(`Checko HTTP ${response.status}: ${raw.slice(0, 300)}`);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`Checko non-JSON response: ${raw.slice(0, 300)}`);
  }
  const metaStatus = payload?.meta?.status;
  const metaMessage = payload?.meta?.message;
  if (metaStatus && !["ok", "success"].includes(String(metaStatus).toLowerCase())) {
    throw new Error(`Checko meta ${String(metaStatus)}: ${String(metaMessage || "unknown")}`);
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
  const data = payload?.payload?.data ?? payload?.data ?? payload;
  if (Array.isArray(data)) {
    return data;
  }
  if (!data || typeof data !== "object") {
    return [];
  }
  for (const key of keys) {
    if (Array.isArray(data[key])) {
      return data[key];
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
function identifierParams(id) {
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
