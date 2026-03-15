import { calculateCompanyRiskScore, formatRiskResultForTelegram } from "./services/risk-score.js";

const DEFAULT_CHECKO_API_URL = "https://api.checko.ru/v2";
const DEFAULT_WEBHOOK_PATH = "/webhook";
const COMPANY_NOT_FOUND_MESSAGE = "❌ Компания не найдена";
const CHECKO_SERVICE_ERROR_MESSAGE = "⚠️ Ошибка сервиса Checko";
const SEARCH_MIN_QUERY_LENGTH = 4;
const DEFAULT_DADATA_API_URL = "https://suggestions.dadata.ru/suggestions/api/4_1/rs";
const AFFILIATED_LIMIT = 8;
const CACHE_TTL_COMPANY_SECONDS = 12 * 60 * 60;
const CACHE_TTL_DADATA_PARTY_SECONDS = 12 * 60 * 60;
const CACHE_TTL_AFFILIATED_SECONDS = 24 * 60 * 60;
const CACHE_TTL_EMAIL_SECONDS = 6 * 60 * 60;

const COMPANY_SECTION_TITLES = {
  main: "🏢 Карточка",
  risk: "🔎 Риски",
  fin: "📈 Финансы",
  arb: "⚖️ Арбитраж",
  debt: "💳 Долги",
  ctr: "📋 Контракты",
  his: "🗓 История",
  lnk: "🔗 Связи",
  tax: "🧾 Налоги",
  own: "👥 Учредители",
  fil: "🏬 Филиалы",
  okv: "🔖 ОКВЭД"
};

const COMPANY_SECTION_BUILDERS = {
  main: buildCompanyMainView,
  risk: buildRiskView,
  fin: buildFinancesView,
  arb: buildArbitrationView,
  debt: buildDebtsView,
  ctr: buildContractsView,
  his: buildHistoryView,
  lnk: buildConnectionsView,
  tax: buildTaxesView,
  own: buildFoundersView,
  fil: buildBranchesView,
  okv: buildOkvedView
};

class CheckoServiceError extends Error {
  constructor(message) {
    super(message);
    this.name = "CheckoServiceError";
  }
}

class CheckoNotFoundError extends Error {
  constructor(message = COMPANY_NOT_FOUND_MESSAGE) {
    super(message);
    this.name = "CheckoNotFoundError";
  }
}

class DadataServiceError extends Error {
  constructor(message) {
    super(message);
    this.name = "DadataServiceError";
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const webhookPaths = resolveWebhookPaths(env);

    if (request.method === "GET" && url.pathname === "/") {
      return jsonResponse({ ok: true, service: "telegram-checko-bot", webhookPaths });
    }

    if (request.method === "POST" && webhookPaths.includes(url.pathname)) {
      try {
        verifyTelegramWebhookSecret(request, env);
        return await handleTelegramUpdate(request, env);
      } catch (error) {
        const status = String(error.message || "").includes("Unauthorized") ? 401 : 400;
        return jsonResponse({ ok: false, error: String(error.message || error) }, status);
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};

async function handleTelegramUpdate(request, env) {
  ensureTelegramSecret(env);
  const update = await request.json();

  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
    return jsonResponse({ ok: true });
  }

  const msg = update.message;
  if (!msg || typeof msg.text !== "string" || !msg.chat?.id) {
    return jsonResponse({ ok: true, skipped: true });
  }

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === "/start" || text === "/help") {
    const view = buildMainMenuView();
    await sendHtmlMessage(env, chatId, view);
    return jsonResponse({ ok: true });
  }

  try {
    const view = await buildViewForUserText(env, text);
    await sendHtmlMessage(env, chatId, view);
  } catch (error) {
    if (error instanceof CheckoNotFoundError) {
      await sendMessage(env, { chat_id: chatId, text: COMPANY_NOT_FOUND_MESSAGE });
    } else if (error instanceof CheckoServiceError) {
      await sendMessage(env, { chat_id: chatId, text: CHECKO_SERVICE_ERROR_MESSAGE });
    } else {
      throw error;
    }
  }

  return jsonResponse({ ok: true });
}

async function buildViewForUserText(env, text) {
  const token = text.replace(/\s+/g, "");

  if (/^\d{10}$/.test(token) || /^\d{13}$/.test(token)) {
    return buildCompanyMainView(env, token);
  }
  if (/^\d{15}$/.test(token)) {
    return buildEntrepreneurView(env, token);
  }
  if (/^\d{12}$/.test(token)) {
    return buildResolve12View(token);
  }
  if (/^\d{9}$/.test(token)) {
    return buildBankView(env, token);
  }
  if (isValidEmail(text)) {
    return buildCompanyByEmailView(env, text);
  }

  if (text.length >= SEARCH_MIN_QUERY_LENGTH) {
    return buildSearchResultsView(env, text);
  }

  return {
    text: "🆔 Неверный формат. Отправьте ИНН (10/12), ОГРН (13), ОГРНИП (15), БИК (9), email или название.",
    reply_markup: { inline_keyboard: [[kb("🏠 В меню", "menu")]] }
  };
}

async function handleCallbackQuery(callbackQuery, env) {
  await telegramRequest(env, "answerCallbackQuery", { callback_query_id: callbackQuery.id });

  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  if (!chatId || !messageId) return;

  const data = String(callbackQuery.data || "");
  try {
    const view = await buildViewForCallback(env, data);
    if (!view) return;
    await editMessage(env, chatId, messageId, view.text, view.reply_markup);
  } catch (error) {
    if (error instanceof CheckoNotFoundError) {
      await editMessage(env, chatId, messageId, COMPANY_NOT_FOUND_MESSAGE, { inline_keyboard: [[kb("🏠 В меню", "menu")]] });
      return;
    }
    if (error instanceof CheckoServiceError) {
      await editMessage(env, chatId, messageId, CHECKO_SERVICE_ERROR_MESSAGE, { inline_keyboard: [[kb("🏠 В меню", "menu")]] });
      return;
    }
    throw error;
  }
}

async function buildViewForCallback(env, data) {
  if (data === "menu") return buildMainMenuView();
  if (data === "help") return buildHelpView();
  if (data === "search:inn") return buildSearchInnView();
  if (data === "search:name") return buildSearchNameView();
  if (data === "search:bic") return buildSearchBicView();
  if (data === "search:email") return buildSearchEmailView();

  if (data.startsWith("resolve12:entrepreneur:")) {
    return buildEntrepreneurView(env, data.split(":").pop());
  }
  if (data.startsWith("resolve12:person:")) {
    return buildPersonView(env, data.split(":").pop());
  }

  if (data.startsWith("select:company:")) {
    return buildCompanyMainView(env, data.split(":").pop());
  }
  if (data.startsWith("select:entrepreneur:")) {
    return buildEntrepreneurView(env, data.split(":").pop());
  }

  if (data.startsWith("ep:")) {
    const [, section, id] = data.split(":", 3);
    if (!["risk", "his", "lnk"].includes(section) || !id) return null;
    return buildEntrepreneurSectionView(env, section, id);
  }

  if (data.startsWith("co:")) {
    const [, section, id] = data.split(":", 3);
    if (!COMPANY_SECTION_TITLES[section] || !id) return null;
    return buildCompanySectionView(env, section, id);
  }

  return null;
}

function buildMainMenuView() {
  return {
    text: [
      "🔍 <b>Проверка контрагента</b>",
      "──────────────────",
      "",
      "Отправьте реквизит или выберите формат поиска.",
      "",
      "<b>Форматы:</b>",
      "› ИНН — 10 или 12 цифр",
      "› ОГРН / ОГРНИП — 13 / 15 цифр",
      "› БИК банка — 9 цифр",
      "› Email или название компании"
    ].join("\n"),
    reply_markup: {
      inline_keyboard: [
        [kb("🔎 По ИНН / ОГРН", "search:inn"), kb("🔤 По названию", "search:name")],
        [kb("🏦 По БИК", "search:bic"), kb("✉️ По Email", "search:email")],
        [kb("ℹ️ Помощь", "help")]
      ]
    }
  };
}

function buildHelpView() {
  return {
    text: [
      "ℹ️ <b>Как пользоваться</b>",
      "──────────────────",
      "",
      "Отправьте реквизит → откройте карточку → выберите раздел.",
      "",
      "<b>Разделы карточки:</b>",
      "🔎 Риски — комплексная оценка",
      "📈 Финансы — отчётность за 4 года",
      "⚖️ Арбитраж — судебные дела",
      "💳 Долги — ФССП и задолженности",
      "📋 Контракты — госзакупки",
      "🗓 История — изменения в реестре",
      "🔗 Связи — аффилированные лица",
      "🧾 Налоги — данные ФНС",
      "👥 Учредители · 🏬 Филиалы · 🔖 ОКВЭД"
    ].join("\n"),
    reply_markup: { inline_keyboard: [[kb("🏠 На главную", "menu")]] }
  };
}

function buildSearchInnView() {
  return {
    text: [
      "🔎 <b>Поиск по ИНН / ОГРН</b>",
      "──────────────────",
      "",
      "Введите один из реквизитов:",
      "▸ ИНН компании (10 цифр)",
      "▸ ИНН предпринимателя (12 цифр)",
      "▸ ОГРН (13 цифр)",
      "▸ ОГРНИП (15 цифр)"
    ].join("\n"),
    reply_markup: backMenuKeyboard("menu")
  };
}

function buildSearchNameView() {
  return {
    text: [
      "🧾 <b>Поиск по названию</b>",
      "──────────────────",
      "",
      "Введите название компании или ФИО ИП.",
      "Минимальная длина запроса — 4 символа."
    ].join("\n"),
    reply_markup: backMenuKeyboard("menu")
  };
}

function buildSearchBicView() {
  return {
    text: [
      "🏦 <b>Поиск по БИК</b>",
      "──────────────────",
      "",
      "Введите БИК банка (9 цифр)."
    ].join("\n"),
    reply_markup: backMenuKeyboard("menu")
  };
}

function buildSearchEmailView() {
  return {
    text: [
      "✉️ <b>Поиск по email</b>",
      "──────────────────",
      "",
      "Введите корпоративный email компании.",
      "Например: <code>info@company.ru</code>"
    ].join("\n"),
    reply_markup: backMenuKeyboard("menu")
  };
}

function buildResolve12View(inn) {
  return {
    text: [
      "🆔 <b>ИНН из 12 цифр</b>",
      "──────────────────",
      "",
      "Выберите тип проверки:"
    ].join("\n"),
    reply_markup: {
      inline_keyboard: [
        [kb("👔 Проверить как ИП", `resolve12:entrepreneur:${inn}`)],
        [kb("👤 Проверить как физлицо", `resolve12:person:${inn}`)],
        [kb("⬅️ Назад", "search:inn"), kb("🏠 В меню", "menu")]
      ]
    }
  };
}

async function buildCompanyByEmailView(env, email) {
  if (!isDadataConfigured(env)) {
    return {
      text: "ℹ️ Поиск по email не настроен. Попросите администратора добавить ключи DaData.",
      reply_markup: backMenuKeyboard("search:email")
    };
  }

  const suggestion = await safeFindCompanyByEmail(env, email);
  if (suggestion.error === "unavailable") {
    return {
      text: "⚠️ Поиск по email временно недоступен. Попробуйте позже.",
      reply_markup: backMenuKeyboard("search:email")
    };
  }
  if (!suggestion.inn) {
    return {
      text: "📭 Компания по email не найдена. Проверьте адрес или используйте ИНН/ОГРН.",
      reply_markup: backMenuKeyboard("search:email")
    };
  }

  return buildCompanyMainView(env, suggestion.inn);
}

async function buildSearchResultsView(env, query) {
  const payload = await checkoRequest(env, "search", { by: "name", obj: "org", query });
  const items = ensureArray(payload.data).slice(0, 10);
  if (items.length === 0) {
    return {
      text: [
        "🧾 <b>Результаты поиска</b>",
        "──────────────────",
        "",
        `Запрос: <i>${escapeHtml(query)}</i>`,
        "",
        "Ничего не найдено. Попробуйте другой запрос."
      ].join("\n"),
      reply_markup: backMenuKeyboard("search:name")
    };
  }

  const buttons = items.map((item) => {
    const name = item.НаимСокр || item.НаимПолн || "Без названия";
    const id = String(item.ИНН || item.ОГРН || item.ОГРНИП || "");
    const marker = item.ОГРНИП ? "👔" : "🏢";
    const label = `${marker} ${truncate(name, 30)}${id ? ` · ${id}` : ""}`;
    const callback = item.ОГРНИП ? `select:entrepreneur:${id}` : `select:company:${id}`;
    return [kb(label, callback)];
  });
  buttons.push([kb("⬅️ Назад", "search:name"), kb("🏠 В меню", "menu")]);
  return {
    text: [
      "🧾 <b>Результаты поиска</b>",
      "──────────────────",
      "",
      `Запрос: <i>${escapeHtml(query)}</i>`,
      "",
      "Выберите организацию из списка:"
    ].join("\n"),
    reply_markup: { inline_keyboard: buttons }
  };
}

async function buildCompanyMainView(env, id) {
  const payload = await checkoRequest(env, "company", identifierParams(id));
  const data = payload.data || {};
  if (!hasIdentity(data)) throw new CheckoNotFoundError();
  const [finances, dadataParty] = await Promise.all([
    safeSectionData(env, "finance", identifierParams(id)),
    safeFindPartyByInnOrOgrn(env, String(data.ИНН || data.ОГРН || id))
  ]);

  const title = data.НаимСокр || data.НаимПолн || "Компания";
  const okved = formatOkved(data.ОКВЭД);
  const contacts = data.Контакты || {};
  const director = data.Руковод?.[0]?.ФИО || data.Руководители?.[0]?.ФИО || "—";
  const founders = getCompanyFounders(data);
  const founder = founders[0]?.ФИО || founders[0]?.Наим || "—";
  const latestRevenue = extractLatestRevenue(finances.data);

  const lines = [
    `🏢 <b>${escapeHtml(title)}</b>`,
    "──────────────────",
    "",
    "🪪 <b>Реквизиты</b>",
    `ИНН  <code>${escapeHtml(String(data.ИНН || id))}</code>`,
    `ОГРН  <code>${escapeHtml(String(data.ОГРН || "—"))}</code>`,
    `КПП  ${escapeHtml(String(data.КПП || "—"))}`,
    "",
    "📋 <b>Статус</b>",
    `<b>${escapeHtml(String(data.Статус?.Наим || "—"))}</b>  ·  ${escapeHtml(formatDate(data.ДатаРег))}`,
    data.НаимПолн && data.НаимПолн !== title ? `<i>${escapeHtml(data.НаимПолн)}</i>` : null,
    "",
    "⚙️ <b>Деятельность</b>",
    `${escapeHtml(okved)}`,
    `📊 Выручка (последний год): ${escapeHtml(latestRevenue)}`,
    data.УстКап?.Сумма ? `🏦 Уставный капитал: ${escapeHtml(formatMoney(data.УстКап.Сумма))}` : null,
    "",
    "📍 <b>Контакты</b>",
    `${escapeHtml(String(data.ЮрАдрес?.АдресРФ || "—"))}`,
    `👤 Руководитель  ${escapeHtml(director)}`,
    `Учредитель (текущий): ${escapeHtml(founder)}`,
    contacts.Тел ? `📞 ${escapeHtml(valueAsText(contacts.Тел))}` : null,
    contacts.Емэйл ? `✉️ ${escapeHtml(valueAsText(contacts.Емэйл))}` : null,
    contacts.ВебСайт ? `🌐 ${escapeHtml(valueAsText(contacts.ВебСайт))}` : null,
    ...buildDadataMainLines(dadataParty)
  ].filter(Boolean);

  return { text: lines.join("\n"), reply_markup: buildCompanyKeyboard(id) };
}

async function buildCompanySectionView(env, section, id) {
  const builder = COMPANY_SECTION_BUILDERS[section];
  return builder ? builder(env, id) : null;
}

async function buildRiskView(env, id) {
  const company = await checkoRequest(env, "company", identifierParams(id));
  const data = company.data || {};
  const baseParams = identifierParams(id);
  const [finances, legal, fssp, contracts, bankruptcy, fedresurs, dadataParty] = await Promise.all([
    safeSectionData(env, "finance", baseParams),
    safeSectionData(env, "legal-cases", { ...baseParams, sort: "-date", limit: 10 }),
    safeSectionData(env, "enforcements", { ...baseParams, sort: "-date", limit: 10 }),
    safeSectionData(env, "contracts", { ...baseParams, law: 44, role: "supplier", sort: "-date", limit: 10 }),
    safeSectionData(env, "bankruptcy-messages", { ...baseParams, limit: 5 }),
    safeSectionData(env, "fedresurs-messages", { ...baseParams, limit: 5 }),
    safeFindPartyByInnOrOgrn(env, String(data.ИНН || data.ОГРН || id))
  ]);

  const riskResult = calculateCompanyRiskScore({
    companyData: data,
    financesData: finances.data,
    legalData: legal,
    fsspData: fssp,
    contractsData: contracts,
    bankruptcyData: bankruptcy,
    fedresursData: fedresurs,
    dadataParty
  });

  const text = formatRiskResultForTelegram(riskResult);
  return { text, reply_markup: compactSectionKeyboard(id) };
}

async function buildFinancesView(env, id) {
  const payload = await checkoRequest(env, "finance", identifierParams(id));
  const rows = payload.data || {};
  const years = Object.keys(rows).filter((y) => /^\d{4}$/.test(y)).sort((a, b) => Number(b) - Number(a)).slice(0, 4);
  if (years.length === 0) {
    return { text: "📈 <b>Финансы</b>\n──────────────────\n\n📊 Финансовая отчётность не найдена", reply_markup: buildCompanyKeyboard(id) };
  }

  const lines = startSection("📈 <b>Финансы</b>");
  for (const year of years) {
    const item = rows[year] || {};
    lines.push(`\n📆 <b>${year}</b>`);
    lines.push(`› 💰 Выручка  ${formatMoney(item[2110])}`);
    lines.push(`› 📊 Прибыль  ${formatMoney(item[2400])}`);
    lines.push(`› 📦 Активы  ${formatMoney(item[1600])}`);
    lines.push(`› 🏦 Капитал  ${formatMoney(item[1300])}`);
  }
  const pdfUrl = payload["bo.nalog.ru"]?.Отчет;
  if (pdfUrl) lines.push(`\nОтчётность: ${escapeHtml(String(pdfUrl))}`);

  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
}

async function buildArbitrationView(env, id) {
  const payload = await checkoRequest(env, "legal-cases", { ...identifierParams(id), sort: "-date", limit: 10 });
  const items = takeRecords(payload);
  if (items.length === 0) return { text: "⚖️ <b>Арбитраж</b>\n──────────────────\n\nАрбитражные дела не найдены", reply_markup: compactSectionKeyboard(id) };

  const lines = [...startSection("⚖️ <b>Арбитражные дела</b>"), `\nВсего: <b>${items.length}</b>`];
  items.slice(0, 10).forEach((it) => {
    lines.push(`\n› ${escapeHtml(it.НомерДела || it.Номер || "б/н")}  ${formatDate(it.Дата)}`);
    lines.push(`  🏛 ${escapeHtml(it.Суд || "—")}`);
    lines.push(`  👤 ${escapeHtml(it.Роль || "—")}  ·  💰 ${formatMoney(it.СуммаТреб || it.Сумма)}`);
  });
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
}

async function buildDebtsView(env, id) {
  const company = await checkoRequest(env, "company", identifierParams(id));
  const taxes = company.data?.Налоги;
  const payload = await checkoRequest(env, "enforcements", { ...identifierParams(id), sort: "-date", limit: 10 });
  const items = takeRecords(payload);

  const lines = [...startSection("💳 <b>Долги</b>"), ""];
  if (taxes && typeof taxes === "object") {
    lines.push("🧾 <b>Налоги</b>");
    lines.push(`› Налоговая задолженность: ${formatTaxMoney(taxes, ["СумНедоим"])}`);
    lines.push(`› Пени / штрафы: ${formatTaxMoney(taxes, ["СумПениШтр", "СумШтр"])}`);
    lines.push(`› Недоимка и доначисления: ${formatTaxMoney(taxes, ["СумДоначисл", "СумДолг"])}`);
  } else {
    lines.push("🧾 Налоговые данные: нет данных");
  }

  if (items.length === 0) {
    lines.push("\nИсполнительные производства не найдены");
    return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
  }

  lines.push(`\n📋 <b>Исполнительные производства: ${items.length}</b>`);
  items.slice(0, 10).forEach((it) => {
    lines.push(`\n› ${escapeHtml(it.ИспПрНомер || it.НомерИП || it.Номер || "—")}  ${formatDate(it.ИспПрДата || it.ДатаНачала || it.Дата)}`);
    lines.push(`  💳 ${formatMoney(it.СумДолг || it.СуммаДолга || it.Сумма)}`);
    lines.push(`  📄 ${escapeHtml(it.ПредмИсп || it.Предмет || "без предмета")}`);
  });
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
}

async function buildContractsView(env, id) {
  const baseParams = { ...identifierParams(id), role: "supplier", sort: "-date", limit: 10 };
  const [p44, p94, p223] = await Promise.all([
    safeSectionData(env, "contracts", { ...baseParams, law: 44 }),
    safeSectionData(env, "contracts", { ...baseParams, law: 94 }),
    safeSectionData(env, "contracts", { ...baseParams, law: 223 }),
  ]);
  const items = [...takeRecords(p44), ...takeRecords(p94), ...takeRecords(p223)];
  if (items.length === 0) return { text: "📋 <b>Контракты</b>\n──────────────────\n\nКонтракты не найдены", reply_markup: compactSectionKeyboard(id) };

  const lines = [...startSection("📋 <b>Госконтракты</b>"), `\nВсего: <b>${items.length}</b>`];
  items.slice(0, 10).forEach((it) => {
    const contractNumber = firstNonEmpty([it.НомерКонтракта, it.Номер, it.Ид, it.Идентификатор, it.НомерРеестра]);
    lines.push(`\n› Номер: ${escapeHtml(contractNumber || "нет данных")}`);
    lines.push(`  📆 ${formatDate(it.Дата || it.ДатаЗакл)}`);
    lines.push(`  📄 ${escapeHtml(String(it.Предмет || "без предмета"))}`);
    lines.push(`  💰 ${formatMoney(it.Цена || it.СуммаКонтракта)}`);
  });
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
}

async function buildHistoryView(env, id) {
  const payload = await checkoRequest(env, "history", { ...identifierParams(id), limit: 15 });
  const items = ensureArray(payload.data).slice(0, 15);
  if (items.length === 0) return { text: "🗓 <b>История</b>\n──────────────────\n\nИстория изменений не найдена", reply_markup: compactSectionKeyboard(id) };

  const lines = startSection("🗓 <b>История изменений</b>");
  items.forEach((it, idx) => lines.push(`${idx + 1}.  ${formatDate(it.Дата || it.date)}  —  ${escapeHtml(it.Описание || it.Наим || it.event || "Событие")}`));
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
}

async function buildConnectionsView(env, id) {
  const [company, dadataParty] = await Promise.all([
    checkoRequest(env, "company", identifierParams(id)),
    safeFindPartyByInnOrOgrn(env, id)
  ]);
  const data = company.data || {};
  const founderNames = getCompanyFounders(data).map((f) => f.ФИО || f.Наим).filter(Boolean).slice(0, 5);
  const contactPhone = asDisplayText(data.Контакты?.Тел);
  const contactEmail = asDisplayText(data.Контакты?.Емэйл);
  const groups = [
    { label: "Связи по руководителю", value: data.Руковод?.[0]?.ФИО },
    { label: "Связи по учредителям", value: founderNames.join(", ") },
    { label: "Связи по адресу", value: data.ЮрАдрес?.АдресРФ },
    { label: "Связи по телефону", value: contactPhone },
    { label: "Связи по email", value: contactEmail }
  ];

  const affiliated = await collectAffiliatedCompanies(env, dadataParty, String(data.ИНН || id));

  const nonEmptyGroups = groups.filter((g) => hasText(g.value));
  const lines = startSection("🔗 <b>Связи</b>");
  if (nonEmptyGroups.length === 0 && affiliated.total === 0) {
    return { text: "🔗 <b>Связи</b>\n──────────────────\n\nСвязи не найдены", reply_markup: compactSectionKeyboard(id) };
  }

  if (nonEmptyGroups.length > 0) {
    lines.push("");
    lines.push(...nonEmptyGroups.map((g) => `${g.label}: ${escapeHtml(String(g.value))}`));
  }
  const emptyLabels = groups.filter((g) => !hasText(g.value)).map((g) => g.label.replace("Связи по ", ""));
  if (emptyLabels.length > 0) {
    lines.push(`Нет данных по: ${escapeHtml(emptyLabels.join(", "))}`);
  }

  if (affiliated.total > 0) {
    lines.push("", "🤝 <b>Аффилированные компании</b>");
    for (const item of affiliated.items.slice(0, AFFILIATED_LIMIT)) {
      const statusBadge = item.status === "ACTIVE" ? "✅" : item.status ? `[${escapeHtml(item.status)}]` : "";
      const postfix = [statusBadge, item.okvedOrCity ? escapeHtml(item.okvedOrCity) : ""].filter(Boolean).join("  ");
      lines.push(`\n› <b>${escapeHtml(item.name)}</b>`);
      lines.push(`  ИНН ${escapeHtml(item.inn)}  ·  ${escapeHtml(item.linkType)}`);
      if (postfix) lines.push(`  ${postfix}`);
    }
    if (affiliated.total > AFFILIATED_LIMIT) {
      lines.push(`\n…  и ещё ${affiliated.total - AFFILIATED_LIMIT}`);
    }
  } else if (isDadataConfigured(env)) {
    lines.push("", "🤝 Аффилированные компании не найдены");
  }

  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
}

async function buildFoundersView(env, id) {
  const payload = await checkoRequest(env, "company", identifierParams(id));
  const founders = getCompanyFounders(payload.data || {});
  if (founders.length === 0) return { text: "👥 <b>Учредители</b>\n──────────────────\n\nУчредители не найдены", reply_markup: compactSectionKeyboard(id) };

  const lines = startSection("👥 <b>Учредители</b>");
  founders.forEach((f, idx) => {
    lines.push(`\n${idx + 1}.  <b>${escapeHtml(f.ФИО || f.Наим || "—")}</b>`);
    lines.push(`   Доля  ${f.Доля?.Процент || f.Доля?.Проц || f.ДоляПроц || "—"}%  ·  ${formatFounderAmount(f.Доля?.Сумма, f.ДоляСумма)}`);
  });
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
}

async function buildBranchesView(env, id) {
  const payload = await checkoRequest(env, "company", identifierParams(id));
  const branches = ensureArray(payload.data?.Филиалы || payload.data?.Подразделения || payload.data?.ОбособПодр || payload.data?.Фил);
  if (branches.length === 0) return { text: "🏬 <b>Филиалы</b>\n──────────────────\n\nФилиалы не найдены", reply_markup: compactSectionKeyboard(id) };

  const lines = [...startSection("🏬 <b>Филиалы</b>"), `\nВсего: <b>${branches.length}</b>`];
  branches.slice(0, 20).forEach((b, idx) => lines.push(`\n${idx + 1}.  КПП ${escapeHtml(b.КПП || "—")}\n   ${escapeHtml(b.Адрес || b.АдресРФ || "—")}`));
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
}

async function buildOkvedView(env, id) {
  const payload = await checkoRequest(env, "company", identifierParams(id));
  const data = payload.data || {};
  const primary = data.ОКВЭД;
  const additional = ensureArray(data.ОКВЭДДоп || data.ДопОКВЭД);
  const lines = startSection("🔖 <b>ОКВЭД</b>");
  lines.push(`\n<b>Основной</b>  ${escapeHtml(formatOkved(primary))}`);
  if (additional.length === 0) lines.push("\nДополнительные: нет данных");
  else {
    lines.push("\n<b>Дополнительные</b>");
    additional.slice(0, 20).forEach((o) => lines.push(`› ${escapeHtml(formatOkved(o))}`));
  }
  if (!primary && additional.length === 0) return { text: "🔖 <b>ОКВЭД</b>\n──────────────────\n\nДанные по ОКВЭД не найдены", reply_markup: compactSectionKeyboard(id) };
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
}

async function buildTaxesView(env, id) {
  const payload = await checkoRequest(env, "company", identifierParams(id));
  const taxes = payload.data?.Налоги;
  if (!taxes || typeof taxes !== "object") return { text: "🧾 <b>Налоги</b>\n──────────────────\n\nНалоговые данные не найдены", reply_markup: compactSectionKeyboard(id) };

  const lines = [
    ...startSection("🧾 <b>Налоги</b>"),
    "",
    `Итого уплачено  ${formatTaxMoney(taxes, ["СумУпл", "СумНалогов"])}`,
    `Недоимка  ${formatTaxMoney(taxes, ["СумНедоим"])}`,
    `Пени и штрафы  ${formatTaxMoney(taxes, ["СумПениШтр", "СумШтр"])}`
  ];
  if (taxes.ПоГодам && typeof taxes.ПоГодам === "object") {
    lines.push("");
    Object.keys(taxes.ПоГодам).sort().reverse().forEach((year) => lines.push(`📆 ${year}  ${formatMoney(taxes.ПоГодам[year])}`));
  }
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
}

async function buildEntrepreneurView(env, id) {
  const payload = await checkoRequest(env, "entrepreneur", identifierParams(id));
  const data = payload.data || {};
  if (!hasIdentity(data)) throw new CheckoNotFoundError("👔 ИП не найден");

  const lines = [
    ...startSection("👔 <b>Предприниматель</b>"),
    "",
    `<b>${escapeHtml(String(data.ФИО || "—"))}</b>`,
    "",
    `🪪 ИНН  <code>${escapeHtml(String(data.ИНН || id))}</code>`,
    `ОГРНИП  <code>${escapeHtml(String(data.ОГРНИП || "—"))}</code>`,
    "",
    `📋 <b>${escapeHtml(String(data.Статус?.Наим || "—"))}</b>  ·  ${escapeHtml(formatDate(data.ДатаРег))}`,
    `⚙️ ${escapeHtml(formatOkved(data.ОКВЭД))}`,
    `МСП  ${escapeHtml(String(data.РМСП?.Кат || "—"))}`,
    `Риск-маркеры  ${escapeHtml(String(data.Риски?.Уровень || "нет данных"))}`
  ];
  return {
    text: lines.join("\n"),
    reply_markup: {
      inline_keyboard: [
        [kb("⚠️ Проверки", `ep:risk:${id}`), kb("🕓 История", `ep:his:${id}`)],
        [kb("🔗 Связи", `ep:lnk:${id}`)],
        [kb("🏠 В меню", "menu")]
      ]
    }
  };
}

async function buildPersonView(env, id) {
  const payload = await checkoRequest(env, "person", { inn: id });
  const data = payload.data || {};
  if (!hasIdentity(data)) throw new CheckoNotFoundError("👤 Физлицо не найдено");

  const directors = ensureArray(data.Руковод);
  const founders = ensureArray(data.Учред);
  const ents = ensureArray(data.ИП);
  const lines = [
    ...startSection("👤 <b>Физлицо</b>"),
    "",
    `<b>${escapeHtml(String(data.ФИО || "—"))}</b>`,
    `🪪 ИНН  <code>${escapeHtml(String(data.ИНН || id))}</code>`,
    "",
    `Руководитель в ${directors.length || 0} орг.`,
    `Учредитель в ${founders.length || 0} орг.`,
    `Записей ИП: ${ents.length || 0}`
  ];
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: [[kb("🏠 В меню", "menu")]] } };
}

async function buildBankView(env, bic) {
  const payload = await checkoRequest(env, "bank", { bic });
  const data = payload.data || {};
  if (!Object.keys(data).length) throw new CheckoNotFoundError("🏦 Банк не найден");

  const lines = [
    ...startSection("🏦 <b>Банк</b>"),
    "",
    `<b>${escapeHtml(String(data.Наим || data.Наименование || "—"))}</b>`,
    data.НаимАнгл ? `<i>${escapeHtml(String(data.НаимАнгл))}</i>` : null,
    "",
    `🪪 БИК  <code>${escapeHtml(String(data.БИК || bic))}</code>`,
    `Корр. счёт  <code>${escapeHtml(String(data.КорСчет || data.КоррСчет || "—"))}</code>`,
    "",
    `📍 ${escapeHtml(String(data.Адрес || "—"))}`,
    `Тип  ${escapeHtml(String(data.Тип || "—"))}`
  ].filter(Boolean);
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: [[kb("🏠 В меню", "menu")]] } };
}

async function safeSectionData(env, endpoint, params) {
  try {
    return await checkoRequest(env, endpoint, params);
  } catch {
    return { data: [] };
  }
}

async function sendHtmlMessage(env, chatId, view) {
  await sendMessage(env, {
    chat_id: chatId,
    text: view.text,
    parse_mode: "HTML",
    reply_markup: view.reply_markup
  });
}

function buildCompanyKeyboard(id) {
  return {
    inline_keyboard: [
      [kb("🔎 Риски", `co:risk:${id}`), kb("📈 Финансы", `co:fin:${id}`)],
      [kb("⚖️ Арбитраж", `co:arb:${id}`), kb("💳 Долги", `co:debt:${id}`)],
      [kb("📋 Контракты", `co:ctr:${id}`), kb("🗓 История", `co:his:${id}`)],
      [kb("🔗 Связи", `co:lnk:${id}`), kb("🧾 Налоги", `co:tax:${id}`)],
      [kb("👥 Учредители", `co:own:${id}`), kb("🏬 Филиалы", `co:fil:${id}`), kb("🔖 ОКВЭД", `co:okv:${id}`)],
      [kb("🏢 Карточка", `co:main:${id}`), kb("🏠 Меню", "menu")]
    ]
  };
}

function compactSectionKeyboard(id) {
  return {
    inline_keyboard: [
      [kb("🔎 Риски", `co:risk:${id}`), kb("📈 Финансы", `co:fin:${id}`)],
      [kb("🏢 Карточка", `co:main:${id}`), kb("🏠 Меню", "menu")]
    ]
  };
}

async function buildEntrepreneurSectionView(env, section, id) {
  if (section === "risk") {
    const payload = await checkoRequest(env, "entrepreneur", identifierParams(id));
    const data = payload.data || {};
    const lines = [
      "⚠️ <b>Проверки и факторы риска</b>",
      `Статус: ${escapeHtml(String(data.Статус?.Наим || "—"))}`,
      `Риск-маркеры: ${escapeHtml(String(data.Риски?.Уровень || "нет данных"))}`,
      `Категория МСП: ${escapeHtml(String(data.РМСП?.Кат || "нет данных"))}`
    ];
    return { text: lines.join("\n"), reply_markup: { inline_keyboard: [[kb("👔 ИП", `resolve12:entrepreneur:${id}`)], [kb("🏠 В меню", "menu")]] } };
  }

  if (section === "his") {
    const payload = await checkoRequest(env, "history", { ...identifierParams(id), limit: 15 });
    const items = ensureArray(payload.data).slice(0, 15);
    const lines = ["🕓 <b>История изменений</b>"];
    if (items.length === 0) lines.push("\nСобытия не найдены.");
    else items.forEach((it) => lines.push(`• ${formatDate(it.Дата || it.date)} — ${it.Событие || it.Описание || it.Наим || "Событие"}`));
    return { text: lines.join("\n"), reply_markup: { inline_keyboard: [[kb("👔 ИП", `resolve12:entrepreneur:${id}`)], [kb("🏠 В меню", "menu")]] } };
  }

  if (section === "lnk") {
    const payload = await checkoRequest(env, "entrepreneur", identifierParams(id));
    const data = payload.data || {};
    const lines = [
      "🔗 <b>Связи</b>",
      `Руководитель в: ${ensureArray(data.Руковод).length || 0}`,
      `Учредитель в: ${ensureArray(data.Учред).length || 0}`,
      `Связи по адресу: ${escapeHtml(String(data.Адрес || data.АдресРег || "нет данных"))}`
    ];
    return { text: lines.join("\n"), reply_markup: { inline_keyboard: [[kb("👔 ИП", `resolve12:entrepreneur:${id}`)], [kb("🏠 В меню", "menu")]] } };
  }

  return null;
}

async function detectCriticalRisk(env, id, companyData) {
  const statusText = String(companyData.Статус?.Наим || "").toLowerCase();
  if (/не\s*действ/.test(statusText)) {
    return "Компания не действует";
  }
  if (/в\s*ликвидац|ликвидац/.test(statusText)) {
    return "Компания находится в процессе ликвидации";
  }
  if (companyData.Ликвид?.Дата || /ликвидирован/.test(statusText)) {
    return "Компания ликвидирована";
  }
  if (/банкрот/.test(statusText)) {
    return "Компания находится в статусе банкротства";
  }
  if (/реорганиз/.test(statusText) || companyData.Реорг?.Дата || companyData.Реорганизация?.Дата) {
    return "Компания находится в процессе реорганизации";
  }

  const bankruptcy = await safeSectionData(env, "bankruptcy-messages", { ...identifierParams(id), limit: 1 });
  const fedresurs = await safeSectionData(env, "fedresurs-messages", { ...identifierParams(id), limit: 1 });
  if (takeRecords(bankruptcy).length > 0 || takeRecords(fedresurs).length > 0) {
    return "Есть сообщения о банкротстве / ЕФРСБ";
  }

  return null;
}


function getCompanyFounders(data) {
  return [
    ...ensureArray(data?.Учред),
    ...ensureArray(data?.Учредители)
  ];
}

function firstNonEmpty(values) {
  for (const value of values) {
    if (hasText(value)) return String(value);
  }
  return "";
}

function hasText(value) {
  return String(value ?? "").trim().length > 0;
}

function asDisplayText(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean).join(", ");
  }
  return String(value ?? "").trim();
}

function hasTaxField(taxes, key) {
  return Boolean(taxes && typeof taxes === "object" && Object.prototype.hasOwnProperty.call(taxes, key) && taxes[key] !== null && taxes[key] !== "");
}

function formatOptionalMoney(value) {
  if (!hasText(value)) return "нет данных";
  return formatMoney(value);
}

function formatOptionalNumber(value) {
  if (!hasText(value)) return "нет данных";
  return String(value);
}

function formatTaxMoney(taxes, keys) {
  if (!taxes || typeof taxes !== "object") return "нет данных";
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(taxes, key) && taxes[key] !== null && taxes[key] !== "") {
      return formatMoney(taxes[key]);
    }
  }
  return "нет данных";
}

function formatFounderAmount(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "") return formatMoney(value);
  }
  return "нет данных";
}

function extractLatestRevenue(financeRows) {
  if (!financeRows || typeof financeRows !== "object") return "нет данных";
  const years = Object.keys(financeRows).filter((y) => /^\d{4}$/.test(y)).sort((a, b) => Number(b) - Number(a));
  for (const year of years) {
    const row = financeRows[year] || {};
    if (row[2110] !== null && row[2110] !== undefined && row[2110] !== "") {
      return `${formatMoney(row[2110])} (${year})`;
    }
  }
  return "нет данных";
}

function summarizeFinanceSignals(financeRows) {
  if (!financeRows || typeof financeRows !== "object") return "нет данных";
  const years = Object.keys(financeRows).filter((y) => /^\d{4}$/.test(y)).sort((a, b) => Number(b) - Number(a));
  if (!years.length) return "нет данных";
  const latest = financeRows[years[0]] || {};
  const parts = [];
  const profit = toNum(latest[2400]);
  if (latest[2400] !== undefined && latest[2400] !== null && latest[2400] !== "") {
    parts.push(profit < 0 ? "убыток" : "прибыль");
  }
  if (latest[2110] !== undefined && latest[2110] !== null && latest[2110] !== "") {
    parts.push(`выручка ${formatMoney(latest[2110])}`);
  }
  return parts.join(", ") || "нет данных";
}

function backMenuKeyboard(backCallback) {
  return {
    inline_keyboard: [[kb("⬅️ Назад", backCallback), kb("🏠 В меню", "menu")]]
  };
}

async function checkoRequest(env, endpoint, params = {}) {
  if (!env.CHECKO_API_KEY) throw new CheckoServiceError("Missing CHECKO_API_KEY");

  const cacheKey = getCheckoCacheKey(endpoint, params);
  if (cacheKey) {
    return withCache(env, cacheKey, CACHE_TTL_COMPANY_SECONDS, () => loadCheckoRequest(env, endpoint, params));
  }
  return loadCheckoRequest(env, endpoint, params);
}

async function loadCheckoRequest(env, endpoint, params = {}) {
  const baseUrl = (env.CHECKO_API_URL || DEFAULT_CHECKO_API_URL).replace(/\/$/, "");
  const url = new URL(`${baseUrl}/${endpoint}`);
  url.searchParams.set("key", env.CHECKO_API_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const response = await fetch(url.toString(), { method: "GET" });
  const raw = await response.text();
  const snippet = buildSnippet(raw);
  if (response.status !== 200) {
    logCheckoFailure(endpoint, response.status, raw, null);
    throw new CheckoServiceError(`HTTP ${response.status}; snippet=${snippet}`);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    logCheckoFailure(endpoint, response.status, raw, null);
    throw new CheckoServiceError(`Non-JSON response; snippet=${snippet}`);
  }

  const meta = payload.meta || null;
  const status = String(meta?.status || "").toLowerCase();
  if (status !== "ok" && status !== "success") {
    logCheckoFailure(endpoint, response.status, raw, meta);
    const message = String(meta?.message || "").trim() || "no message";
    throw new CheckoServiceError(`meta.status=${status || "missing"}; meta.message=${message}; snippet=${snippet}`);
  }

  return payload;
}


async function safeFindCompanyByEmail(env, email) {
  try {
    return await findCompanyByEmail(env, email);
  } catch (error) {
    if (error instanceof DadataServiceError) {
      return { error: "unavailable" };
    }
    throw error;
  }
}

async function safeFindPartyByInnOrOgrn(env, query) {
  if (!isDadataConfigured(env) || !query) return null;
  try {
    return await findPartyByInnOrOgrn(env, query);
  } catch (error) {
    if (error instanceof DadataServiceError) return null;
    throw error;
  }
}

async function findCompanyByEmail(env, email) {
  const normalizedEmail = normalizeEmail(email);
  const payload = await withCache(env, `email:${normalizedEmail}`, CACHE_TTL_EMAIL_SECONDS, () =>
    dadataPost(env, "findByEmail/company", { query: normalizedEmail })
  );
  return normalizeEmailSuggestion(payload);
}

async function findPartyByInnOrOgrn(env, query) {
  const normalizedQuery = String(query || "").trim();
  const payload = await withCache(env, `dadata:party:${normalizedQuery}`, CACHE_TTL_DADATA_PARTY_SECONDS, () =>
    dadataPost(env, "findById/party", { query: normalizedQuery })
  );
  const suggestions = ensureArray(payload.suggestions);
  return suggestions[0]?.data || null;
}

async function findAffiliatedByInn(env, inn, scope) {
  const normalizedScope = ensureArray(scope).join(",") || "all";
  const payload = await withCache(env, `affiliated:${inn}:${normalizedScope}`, CACHE_TTL_AFFILIATED_SECONDS, () =>
    dadataPost(env, "findAffiliated/party", { query: inn, scope })
  );
  return ensureArray(payload.suggestions).map((item) => item?.data).filter(Boolean);
}

async function collectAffiliatedCompanies(env, partyData, sourceInn) {
  if (!isDadataConfigured(env) || !sourceInn) return { items: [], total: 0 };

  const scopeConfigs = [
    { scope: ["MANAGERS"], linkType: "общий руководитель" },
    { scope: ["FOUNDERS"], linkType: "общий учредитель" }
  ];
  const results = await Promise.allSettled(
    scopeConfigs.map(({ scope }) => findAffiliatedByInn(env, sourceInn, scope))
  );

  const seen = new Set([sourceInn]);
  const items = [];
  for (let i = 0; i < scopeConfigs.length; i++) {
    const result = results[i];
    if (result.status === "rejected") {
      if (result.reason instanceof DadataServiceError) continue;
      throw result.reason;
    }
    const { linkType } = scopeConfigs[i];
    for (const item of result.value) {
      const inn = String(item?.inn || "").trim();
      if (!inn || seen.has(inn)) continue;
      seen.add(inn);
      items.push({
        name: item?.name?.short_with_opf || item?.name?.full_with_opf || "Без названия",
        inn,
        status: item?.state?.status || "",
        okvedOrCity: item?.okved || item?.address?.data?.city || "",
        linkType
      });
    }
  }

  return { items, total: items.length };
}

function normalizeEmailSuggestion(payload) {
  const suggestions = ensureArray(payload.suggestions);
  const data = suggestions[0]?.data || {};
  const company = data.company || {};
  return {
    inn: String(company.inn || "").trim(),
    ogrn: String(company.ogrn || "").trim(),
    name: company.name || ""
  };
}

function buildDadataMainLines(partyData) {
  if (!partyData) return [];
  const lines = ["", "🔍 <b>Доп. данные</b>"];
  if (partyData.employee_count) lines.push(`👥 Сотрудников  ${escapeHtml(String(partyData.employee_count))}`);
  if (partyData.finance?.income) lines.push(`📊 Доход  ${escapeHtml(formatMoney(partyData.finance.income))}`);
  if (partyData.finance?.expense) lines.push(`📉 Расход  ${escapeHtml(formatMoney(partyData.finance.expense))}`);
  if (partyData.invalid) lines.push(`⚠️ Адрес недостоверен`);
  if (partyData.phones?.length) lines.push(`📞 ${escapeHtml(partyData.phones.slice(0, 2).map((p) => p.value).filter(Boolean).join("  ·  "))}`);
  if (partyData.emails?.length) lines.push(`✉️ ${escapeHtml(partyData.emails.slice(0, 2).map((e) => e.value).filter(Boolean).join("  ·  "))}`);
  return lines.length > 2 ? lines : [];
}

function isDadataConfigured(env) {
  return Boolean(env.DADATA_API_KEY && env.DADATA_SECRET_KEY);
}

async function dadataPost(env, endpoint, payload) {
  if (!isDadataConfigured(env)) {
    throw new DadataServiceError("Missing DADATA credentials");
  }

  const baseUrl = (env.DADATA_API_URL || DEFAULT_DADATA_API_URL).replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/${endpoint}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Token ${env.DADATA_API_KEY}`,
      "X-Secret": env.DADATA_SECRET_KEY
    },
    body: JSON.stringify(payload)
  });

  const raw = await response.text();
  const snippet = buildSnippet(raw);
  if (response.status !== 200) {
    throw new DadataServiceError(`DaData HTTP ${response.status}; snippet=${snippet}`);
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new DadataServiceError(`DaData non-JSON; snippet=${snippet}`);
  }
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function getCheckoCacheKey(endpoint, params) {
  if (endpoint !== "company") return null;
  if (params?.inn) return `company:inn:${params.inn}`;
  if (params?.ogrn) return `company:ogrn:${params.ogrn}`;
  return null;
}

async function getCache(env, key) {
  if (!env.COMPANY_CACHE || isCacheBypass(env)) return null;
  try {
    const cached = await env.COMPANY_CACHE.get(key, "json");
    if (cached !== null) console.log("cache_hit", { key: summarizeCacheKey(key) });
    return cached;
  } catch {
    console.warn("cache_bypass_on_error", { key: summarizeCacheKey(key), op: "get" });
    return null;
  }
}

async function setCache(env, key, value, ttl) {
  if (!env.COMPANY_CACHE || isCacheBypass(env)) return;
  try {
    const options = ttl ? { expirationTtl: ttl } : undefined;
    await env.COMPANY_CACHE.put(key, JSON.stringify(value), options);
  } catch {
    console.warn("cache_bypass_on_error", { key: summarizeCacheKey(key), op: "put" });
  }
}

async function withCache(env, key, ttl, loader) {
  const cached = await getCache(env, key);
  if (cached !== null) return cached;
  console.log("cache_miss", { key: summarizeCacheKey(key) });
  const fresh = await loader();
  await setCache(env, key, fresh, ttl);
  return fresh;
}

function isCacheBypass(env) {
  return String(env.CACHE_BYPASS || "") === "1";
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function summarizeCacheKey(key) {
  if (key.startsWith("email:")) return "email:<masked>";
  return key;
}

function buildSnippet(value) {
  return String(value || "").replace(/\s+/g, " ").slice(0, 180);
}

function logCheckoFailure(endpoint, status, raw, meta) {
  console.error("checko_fail", {
    endpoint,
    httpStatus: status,
    snippet: String(raw || "").slice(0, 250),
    meta
  });
}

function takeRecords(payload) {
  const data = payload?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.Записи)) return data.Записи;
  if (Array.isArray(data?.cases)) return data.cases;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

function hasIdentity(data) {
  return Boolean(data && (data.ИНН || data.ОГРН || data.ОГРНИП || data.НаимПолн || data.НаимСокр || data.ФИО));
}

function identifierParams(id) {
  if (/^\d{10}$/.test(id)) return { inn: id };
  if (/^\d{12}$/.test(id)) return { inn: id };
  if (/^\d{13}$/.test(id)) return { ogrn: id };
  if (/^\d{15}$/.test(id)) return { ogrnip: id };
  return { inn: id };
}

function resolveWebhookPaths(env) {
  const primary = normalizePath(env.WEBHOOK_PATH || DEFAULT_WEBHOOK_PATH);
  const all = [primary, "/webhook"];
  return [...new Set(all)];
}

function normalizePath(path) {
  if (!path) return DEFAULT_WEBHOOK_PATH;
  return path.startsWith("/") ? path : `/${path}`;
}

function ensureTelegramSecret(env) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("Missing required secret TELEGRAM_BOT_TOKEN.");
}

function verifyTelegramWebhookSecret(request, env) {
  if (!env.WEBHOOK_SECRET) return;
  const token = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (token !== env.WEBHOOK_SECRET) throw new Error("Unauthorized: invalid webhook secret token.");
}

async function telegramRequest(env, method, body) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (response.status !== 200) {
    throw new Error(`Telegram API HTTP ${response.status}`);
  }
}

async function sendMessage(env, body) {
  await telegramRequest(env, "sendMessage", body);
}

async function editMessage(env, chatId, messageId, text, replyMarkup) {
  await telegramRequest(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    reply_markup: replyMarkup
  });
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function buildRiskLevel({ taxDebt = 0, legalCount = 0, fsspCount = 0 }) {
  const score = Number(taxDebt) > 0 ? 2 : 0 + Number(legalCount) + Number(fsspCount);
  if (score >= 8) return { icon: "🔴", label: "Высокий" };
  if (score >= 2) return { icon: "🟡", label: "Средний" };
  return { icon: "🟢", label: "Низкий" };
}

function startSection(title) {
  return [title, "──────────────────"];
}

function formatOkved(okved) {
  if (!okved) return "—";
  return `${okved.Код || "—"}  ${okved.Наим || ""}`.trim();
}

function formatDate(value) {
  if (!value) return "—";
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}.${m[2]}.${m[1]}`;
  return String(value);
}

function formatMoney(value) {
  const n = toNum(value);
  if (!Number.isFinite(n)) return "—";
  return `${n.toLocaleString("ru-RU")} ₽`;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function valueAsText(value) {
  if (Array.isArray(value)) return value.join(", ");
  return String(value || "—");
}

function truncate(text, size) {
  if (text.length <= size) return text;
  return `${text.slice(0, size - 1)}…`;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function kb(text, callback_data) {
  return { text, callback_data };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
