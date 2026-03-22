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
const HISTORY_MAX_ITEMS = 10;
const SECTION_DIVIDER = "──────────────────";
const PAGE_SIZE = 5;

const COMPANY_SECTION_TITLES = {
  main: "🏢 Карточка",
  risk: "🔎 Риски",
  fin: "📈 Финансы",
  arb: "⚖️ Арбитраж",
  debt: "💳 Долги",
  ctr: "📋 Контракты",
  his: "🗓 История",
  lnk: "🔗 Связи",
  succ: "🏢 Правопреемник",
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
  succ: buildSuccessorView,
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

  if (text === "/start" || text === "🔎 Новый поиск") {
    const view = buildMainMenuView();
    await sendHtmlMessage(env, chatId, view);
    return jsonResponse({ ok: true });
  }

  if (text === "/help" || text === "💬 Поддержка") {
    const view = buildHelpView();
    await sendHtmlMessage(env, chatId, view);
    return jsonResponse({ ok: true });
  }

  if (text === "📁 История" || text === "/history") {
    const view = await buildLookupHistoryView(env, chatId);
    await sendHtmlMessage(env, chatId, view);
    return jsonResponse({ ok: true });
  }

  try {
    const view = await buildViewForUserText(env, text);
    await sendHtmlMessage(env, chatId, view);
    await persistViewHistory(env, chatId, view);
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
    await persistViewHistory(env, chatId, view);
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
  if (data === "menu") return { ...buildMainMenuView(), reply_markup: undefined };
  if (data === "help") return { ...buildHelpView(), reply_markup: undefined };
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
    const parsed = parseCompanySectionCallback(data);
    if (!parsed || !COMPANY_SECTION_TITLES[parsed.section] || !parsed.id) return null;
    return buildCompanySectionView(env, parsed.section, parsed.id, parsed.page);
  }

  return null;
}

function buildMainMenuView() {
  return {
    text: [
      "👋 <b>Проверка контрагента</b>",
      SECTION_DIVIDER,
      "",
      "Помогу быстро понять, с кем вы имеете дело перед сделкой.",
      "",
      "Покажу главное:",
      "• статус компании",
      "• риски и долги",
      "• связи и аффилированность",
      "• финансовые сигналы",
      "",
      "👇 Отправьте ИНН одним сообщением",
      "• 10 цифр — компания",
      "• 12 цифр — ИП или физлицо"
    ].join("\n"),
    reply_markup: buildGlobalReplyKeyboard()
  };
}

function buildHelpView() {
  return {
    text: [
      "💬 <b>Как пользоваться</b>",
      SECTION_DIVIDER,
      "",
      "Отправьте ИНН, а бот соберёт короткую сводку по компании:",
      "• статус",
      "• риски",
      "• связи",
      "• финансы",
      "",
      "Дальше можно открыть детали по кнопкам внутри карточки.",
      "",
      "Если какой-то источник временно недоступен, бот покажет это отдельно и предложит следующий шаг."
    ].join("\n"),
    reply_markup: buildGlobalReplyKeyboard()
  };
}


async function buildLookupHistoryView(env, chatId) {
  const history = await readLookupHistory(env, chatId);
  if (history.state === "unavailable") {
    return {
      text: [
        "📁 <b>История</b>",
        SECTION_DIVIDER,
        "",
        "История временно недоступна.",
        "Для сохранения истории подключите KV и повторите позже."
      ].join("\n"),
      reply_markup: buildGlobalReplyKeyboard()
    };
  }

  const items = history.items;
  if (items.length === 0) {
    return {
      text: [
        "📁 <b>История</b>",
        SECTION_DIVIDER,
        "",
        "Пока нет сохранённых проверок.",
        "Отправьте ИНН/ОГРН, и он появится в истории."
      ].join("\n"),
      reply_markup: buildGlobalReplyKeyboard()
    };
  }

  const buttons = items.slice(0, HISTORY_MAX_ITEMS).map((item) => {
    const callback = item.type === "entrepreneur" ? `select:entrepreneur:${item.id}` : `select:company:${item.id}`;
    const label = `${item.type === "entrepreneur" ? "👔" : "🏢"} ${truncate(item.title || item.id, 24)} · ${item.id}`;
    return [kb(label, callback)];
  });

  return {
    text: [
      "📁 <b>История</b>",
      SECTION_DIVIDER,
      "",
      `Последние проверки: <b>${items.length}</b>`,
      "Выберите запись, чтобы открыть карточку."
    ].join("\n"),
    reply_markup: { inline_keyboard: buttons }
  };
}

function buildSearchInnView() {
  return {
    text: [
      "🔎 <b>Поиск по ИНН / ОГРН</b>",
      SECTION_DIVIDER,
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
      SECTION_DIVIDER,
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
      SECTION_DIVIDER,
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
      SECTION_DIVIDER,
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
      SECTION_DIVIDER,
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
        SECTION_DIVIDER,
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
      SECTION_DIVIDER,
      "",
      `Запрос: <i>${escapeHtml(query)}</i>`,
      "",
      "Выберите организацию из списка:"
    ].join("\n"),
    reply_markup: { inline_keyboard: buttons }
  };
}

async function buildCompanyMainView(env, id) {
  if (!isDadataConfigured(env)) {
    return {
      text: [
        "🏢 <b>Карточка компании</b>",
        SECTION_DIVIDER,
        "",
        "DaData не настроен.",
        "Попросите администратора добавить ключи, чтобы открыть главную карточку."
      ].join("\n"),
      reply_markup: buildCompanyKeyboard(id, env)
    };
  }

  let dadataParty;
  try {
    dadataParty = await findPartyByInnOrOgrn(env, id);
  } catch (error) {
    if (error instanceof DadataServiceError) {
      return {
        text: [
          "🏢 <b>Карточка компании</b>",
          SECTION_DIVIDER,
          "",
          "DaData временно недоступен.",
          "Попробуйте открыть карточку чуть позже."
        ].join("\n"),
        reply_markup: buildCompanyKeyboard(id, env)
      };
    }
    throw error;
  }

  if (!dadataParty) {
    return {
      text: [
        "🏢 <b>Карточка компании</b>",
        SECTION_DIVIDER,
        "",
        "Компания не найдена в DaData.",
        "Проверьте ИНН/ОГРН и повторите запрос."
      ].join("\n"),
      reply_markup: buildCompanyKeyboard(id, env)
    };
  }

  const title = dadataParty.name?.short_with_opf || dadataParty.name?.full_with_opf || "Компания";
  const statusCode = dadataParty.state?.status;
  const statusLine = `${statusIcon(statusCode)} <b>Статус:</b> ${escapeHtml(statusLabel(statusCode))}`;
  const registrationDate = formatDateFromMsOrIso(dadataParty.state?.registration_date);
  const directorName = firstNonEmpty([
    dadataParty.management?.name,
    dadataParty.managers?.[0]?.name,
    "нет данных"
  ]);
  const addressShort = truncateAddress(firstNonEmpty([
    dadataParty.address?.value,
    dadataParty.address?.unrestricted_value,
    "нет данных"
  ]));
  const capital = parseNullableNumber(dadataParty.capital?.value);
  const employees = parseNullableNumber(dadataParty.employee_count);
  const primaryOkved = hasText(dadataParty.okved) ? dadataParty.okved : "нет данных";
  const successorName = getSuccessorNameFromDadata(dadataParty);
  const lines = [
    `🏢 <b>${escapeHtml(title)}</b>`,
    SECTION_DIVIDER,
    "",
    statusLine,
    registrationDate !== "—" ? `📅 <b>Дата регистрации:</b> ${escapeHtml(registrationDate)}` : null,
    `👤 <b>Руководитель:</b> ${escapeHtml(directorName)}`,
    `🪪 <b>ИНН:</b> <code>${escapeHtml(String(dadataParty.inn || id))}</code>`,
    `📍 <b>Адрес:</b> ${escapeHtml(addressShort)}`,
    "",
    "<b>Вывод</b>",
    escapeHtml(buildStatusVerdict(dadataParty)),
    "",
    "<b>Ключевые факты</b>",
    capital !== null ? `• Уставный капитал: <b>${escapeHtml(formatMoney(capital))}</b>` : "• Уставный капитал: <b>нет данных</b>",
    employees !== null ? `• Штат: <b>${escapeHtml(String(employees))} сотрудников</b>` : "• Штат: <b>нет данных</b>",
    `• Основной ОКВЭД: <b>${escapeHtml(String(primaryOkved))}</b>`,
    `• Правопреемник: <b>${escapeHtml(successorName)}</b>`,
    "",
    "<b>Что проверить дальше</b>",
    "• риски и долги перед сделкой",
    "• судебную нагрузку компании",
    "• сеть связанных организаций",
    "• историю изменений и контрактов"
  ].filter(Boolean);

  return {
    text: lines.join("\n"),
    reply_markup: buildCompanyKeyboard(id, env),
    historyEntry: { id: String(dadataParty.inn || dadataParty.ogrn || id), type: "company", title }
  };
}

async function buildCompanySectionView(env, section, id, page = 1) {
  const builder = COMPANY_SECTION_BUILDERS[section];
  if (!builder) return null;
  if (section === "main") return builder(env, id);
  return builder(env, id, page);
}

async function buildRiskView(env, id) {
  if (!isCheckoConfigured(env)) {
    return buildCheckoMissingConfigView("🔎 <b>Риски</b>", id);
  }

  let company;
  try {
    company = await checkoRequest(env, "company", identifierParams(id));
  } catch (error) {
    if (error instanceof CheckoServiceError) {
      return buildCheckoTemporaryUnavailableView("🔎 <b>Риски</b>", id);
    }
    throw error;
  }
  const data = company.data || {};
  const baseParams = identifierParams(id);
  const [finances, legal, fssp, contracts, history, bankruptcy, fedresurs, dadataParty] = await Promise.all([
    safeSectionData(env, "finances", baseParams),
    safeSectionData(env, "legal-cases", { ...baseParams, sort: "-date", limit: 10 }),
    safeSectionData(env, "enforcements", { ...baseParams, sort: "-date", limit: 10 }),
    safeSectionData(env, "contracts", { ...baseParams, law: 44, role: "supplier", sort: "-date", limit: 10 }),
    safeSectionData(env, "history", { ...baseParams, sort: "-date", limit: 10 }),
    safeSectionData(env, "bankruptcy-messages", { ...baseParams, limit: 5 }),
    safeSectionData(env, "fedresurs", { ...baseParams, limit: 5 }),
    safeFindPartyByInnOrOgrn(env, String(data.ИНН || data.ОГРН || id))
  ]);

  const riskResult = calculateCompanyRiskScore({
    companyData: data,
    financesData: finances.data,
    legalData: legal,
    fsspData: fssp,
    contractsData: contracts,
    historyData: history,
    bankruptcyData: bankruptcy,
    fedresursData: fedresurs,
    dadataParty
  });

  const text = buildRiskDashboardText(riskResult, {
    companyData: data,
    legalCases: takeRecords(legal),
    taxes: data.Налоги || {},
    fsspCount: takeRecords(fssp).length
  });
  return { text, reply_markup: compactSectionKeyboard(id, "risk") };
}

async function buildFinancesView(env, id, page = 1) {
  if (!isCheckoConfigured(env)) {
    return buildCheckoMissingConfigView("📈 <b>Финансы</b>", id);
  }

  let payload;
  try {
    payload = await checkoRequest(env, "finances", identifierParams(id));
  } catch (error) {
    if (error instanceof CheckoServiceError) {
      return buildCheckoTemporaryUnavailableView("📈 <b>Финансы</b>", id);
    }
    throw error;
  }
  const rows = payload.data || {};
  const years = getYearsSorted(rows).slice(0, 4);
  if (years.length === 0) {
    return {
      text: [
        "📊 <b>Финансы</b>",
        SECTION_DIVIDER,
        "",
        "Отчётность не найдена.",
        "Источник не передал финансовые данные за последние годы."
      ].join("\n"),
      reply_markup: compactSectionKeyboard(id, "fin")
    };
  }

  const companyPayload = await safeSectionData(env, "company", identifierParams(id));
  const companyData = companyPayload.data || {};
  const dadataParty = await safeFindPartyByInnOrOgrn(env, String(companyData.ИНН || companyData.ОГРН || id));
  const reportLines = years.map((year) => {
    const item = rows[year] || {};
    return `• ${year}: выручка ${escapeHtml(formatMoney(item[2110]))}, прибыль ${escapeHtml(formatMoney(item[2400]))}`;
  });
  const pagedReports = paginateItems(reportLines, page);
  const financeSourceState = normalizeFinanceReportLinks(payload["bo.nalog.ru"]?.Отчет).length > 0 ? "есть ссылки ФНС" : "данные Checko";
  const lines = [
    "📊 <b>Финансы</b>",
    SECTION_DIVIDER,
    "",
    escapeHtml(summarizeFinanceBluf(rows)),
    "",
    `• Штат: <b>${escapeHtml(formatOptionalNumber(dadataParty?.employee_count || companyData.ЧислРаб || companyData.СЧР))}</b>`,
    `• Средняя зарплата: <b>${escapeHtml(formatOptionalMoney(companyData.СредЗП || companyData.СредняяЗП))}</b>`,
    `• Спецрежим: <b>${escapeHtml(firstNonEmpty([companyData.НалРежим?.Наим, companyData.НалогРежим?.Наим, "нет данных"]))}</b>`,
    `• МСП: <b>${escapeHtml(firstNonEmpty([companyData.РМСП?.Кат, "нет данных"]))}</b>`,
    `• Источник отчётности: <b>${escapeHtml(financeSourceState)}</b>`,
    "",
    `<b>Отчётность</b> (Стр. ${pagedReports.page}/${pagedReports.totalPages})`,
    ...pagedReports.items,
  ];

  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id, "fin", pagedReports.page, pagedReports.totalPages) };
}

async function buildArbitrationView(env, id, page = 1) {
  if (!isCheckoConfigured(env)) {
    return buildCheckoMissingConfigView("⚖️ <b>Арбитраж</b>", id);
  }

  let payload;
  try {
    payload = await checkoRequest(env, "legal-cases", { ...identifierParams(id), sort: "-date", limit: 10 });
  } catch (error) {
    if (error instanceof CheckoServiceError) {
      return buildCheckoTemporaryUnavailableView("⚖️ <b>Арбитраж</b>", id);
    }
    throw error;
  }
  const items = takeRecords(payload);
  if (items.length === 0) return {
    text: [
      "🏛 <b>Суды</b>",
      SECTION_DIVIDER,
      "",
      "Судебные дела не найдены.",
      "",
      "• Найдено дел: <b>0</b>",
      "• За 24 месяца: <b>0</b>",
      "• В роли ответчика: <b>0</b>",
      "• Последнее дело: <b>—</b>",
      "• Сумма требований: <b>0 ₽</b>",
      "",
      "<b>Что это значит</b>",
      "По текущим данным заметной судебной нагрузки не видно."
    ].join("\n"),
    reply_markup: compactSectionKeyboard(id, "arb")
  };

  const defendantCount = items.filter((it) => /ответчик/i.test(String(it.Роль || ""))).length;
  const recentCount = items.filter((it) => isWithinLastMonths(it.Дата, 24)).length;
  const lastCase = items[0];
  const claimAmount = items.reduce((sum, it) => sum + toNum(it.СуммаТреб || it.Сумма), 0);
  const caseLines = items.map((it) => `• ${escapeHtml(it.НомерДела || it.Номер || "б/н")} — ${escapeHtml(formatDate(it.Дата))} · ${escapeHtml(it.Роль || "роль не указана")}`);
  const pagedCases = paginateItems(caseLines, page);
  const lines = [
    "🏛 <b>Суды</b>",
    SECTION_DIVIDER,
    "",
    escapeHtml(buildCourtsBluf(items.length, defendantCount, claimAmount)),
    `• Найдено дел: <b>${items.length}</b>`,
    `• За 24 месяца: <b>${recentCount}</b>`,
    `• В роли ответчика: <b>${defendantCount}</b>`,
    `• Последнее дело: <b>${escapeHtml(lastCase?.НомерДела || lastCase?.Номер || "нет данных")}</b>`,
    `• Сумма требований: <b>${escapeHtml(formatMoney(claimAmount))}</b>`,
    "",
    `<b>Список дел</b> (Стр. ${pagedCases.page}/${pagedCases.totalPages})`,
    ...pagedCases.items,
    "",
    "<b>Что это значит</b>",
    escapeHtml(buildCourtsMeaning(defendantCount, claimAmount))
  ];
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id, "arb", pagedCases.page, pagedCases.totalPages) };
}

async function buildDebtsView(env, id, page = 1) {
  if (!isCheckoConfigured(env)) {
    return buildCheckoMissingConfigView("💳 <b>Долги</b>", id);
  }

  let company;
  let payload;
  try {
    company = await checkoRequest(env, "company", identifierParams(id));
    payload = await checkoRequest(env, "enforcements", { ...identifierParams(id), sort: "-date", limit: 10 });
  } catch (error) {
    if (error instanceof CheckoServiceError) {
      return buildCheckoTemporaryUnavailableView("💳 <b>Долги</b>", id);
    }
    throw error;
  }

  const taxes = company.data?.Налоги;
  const items = takeRecords(payload);

  const taxDebt = toNum(firstExistingTaxValue(taxes, ["СумНедоим"]));
  const taxPenalties = toNum(firstExistingTaxValue(taxes, ["СумПениШтр", "СумШтр"]));
  const debtLoad = getDebtLoadLabel(items.length, taxDebt, taxPenalties);
  const nextStep = getDebtNextStep(debtLoad);
  const enforcementLines = items.map((it) => `• ${escapeHtml(it.ИспПрНомер || it.НомерИП || it.Номер || "—")} — ${escapeHtml(formatMoney(it.СумДолг || it.СуммаДолга || it.Сумма))}`);
  const pagedEnforcements = paginateItems(enforcementLines, page);
  const lines = [
    "🏦 <b>Долги</b>",
    SECTION_DIVIDER,
    "",
    escapeHtml(buildDebtBluf(items.length, taxDebt, taxPenalties)),
    "",
    `• ФССП: <b>${items.length}</b>`,
    `• Недоимка: <b>${escapeHtml(formatTaxMoneyState(taxes, ["СумНедоим"]))}</b>`,
    `• Пени и штрафы: <b>${escapeHtml(formatTaxMoneyState(taxes, ["СумПениШтр", "СумШтр"]))}</b>`,
    `• Долговая нагрузка: <b>${escapeHtml(debtLoad)}</b>`,
    `• Что делать: <b>${escapeHtml(nextStep)}</b>`
  ];
  if (pagedEnforcements.totalPages > 1 || pagedEnforcements.items.length > 0) {
    lines.push("", `<b>ФССП</b> (Стр. ${pagedEnforcements.page}/${pagedEnforcements.totalPages})`, ...pagedEnforcements.items);
  }
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id, "debt", pagedEnforcements.page, pagedEnforcements.totalPages) };
}

async function buildContractsView(env, id, page = 1) {
  const baseParams = { ...identifierParams(id), role: "supplier", sort: "-date", limit: 10 };
  const settled = await Promise.allSettled([
    checkoRequest(env, "contracts", { ...baseParams, law: 44 }),
    checkoRequest(env, "contracts", { ...baseParams, law: 94 }),
    checkoRequest(env, "contracts", { ...baseParams, law: 223 }),
  ]);

  const failedCount = settled.filter((entry) => entry.status === "rejected").length;
  if (failedCount === settled.length) {
    throw new CheckoServiceError("contracts: all law requests failed");
  }

  const items = settled
    .filter((entry) => entry.status === "fulfilled")
    .flatMap((entry) => takeRecords(entry.value))
    .sort((a, b) => String(b.Дата || b.ДатаЗакл || "").localeCompare(String(a.Дата || a.ДатаЗакл || "")));

  if (items.length === 0) return {
    text: [
      "📋 <b>Контракты</b>",
      SECTION_DIVIDER,
      "",
      "Контракты не найдены.",
      "",
      "• Найдено контрактов: <b>0</b>",
      "• Последняя активность: <b>—</b>",
      "• Крупнейший контракт: <b>—</b>",
      "• Заказчики: <b>нет данных</b>",
      "• Что это значит: <b>госконтракты не зафиксированы</b>"
    ].join("\n"),
    reply_markup: compactSectionKeyboard(id, "ctr")
  };

  const largest = items.reduce((best, current) => toNum(current.Цена || current.СуммаКонтракта) > toNum(best?.Цена || best?.СуммаКонтракта) ? current : best, items[0]);
  const topCustomers = [...new Set(items.map((it) => firstNonEmpty([it.Заказчик, it.НаимЗаказчика])).filter(Boolean))].slice(0, 3).join(", ") || "нет данных";
  const contractLines = items.map((it) => {
    const contractNumber = firstNonEmpty([it.НомерКонтракта, it.Номер, it.Ид, it.Идентификатор, it.НомерРеестра]) || "б/н";
    return `• № ${escapeHtml(contractNumber)} — ${escapeHtml(formatMoney(it.Цена || it.СуммаКонтракта))}`;
  });
  const pagedContracts = paginateItems(contractLines, page);
  const lines = [
    "📋 <b>Контракты</b>",
    SECTION_DIVIDER,
    "",
    escapeHtml(buildContractsBluf(items.length, failedCount)),
    "",
    `• Найдено контрактов: <b>${items.length}</b>`,
    `• Последняя активность: <b>${escapeHtml(formatDate(items[0]?.Дата || items[0]?.ДатаЗакл))}</b>`,
    `• Крупнейший контракт: <b>${escapeHtml(formatMoney(largest?.Цена || largest?.СуммаКонтракта))}</b>`,
    `• Заказчики: <b>${escapeHtml(topCustomers)}</b>`,
    `• Что это значит: <b>${escapeHtml(getContractsMeaning(items.length))}</b>`,
    "",
    `<b>Список</b> (Стр. ${pagedContracts.page}/${pagedContracts.totalPages})`,
    ...pagedContracts.items
  ];
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id, "ctr", pagedContracts.page, pagedContracts.totalPages) };
}

async function buildHistoryView(env, id, page = 1) {
  if (!isCheckoConfigured(env)) {
    return buildCheckoMissingConfigView("🗓 <b>История</b>", id);
  }

  let payload;
  try {
    payload = await checkoRequest(env, "history", { ...identifierParams(id), limit: 15 });
  } catch (error) {
    if (error instanceof CheckoServiceError) {
      return buildCheckoTemporaryUnavailableView("🗓 <b>История</b>", id);
    }
    throw error;
  }
  const items = ensureArray(payload.data).slice(0, 15);
  if (items.length === 0) return {
    text: [
      "🗓 <b>История</b>",
      SECTION_DIVIDER,
      "",
      "Существенных изменений не обнаружено.",
      "",
      "<b>Что это значит</b>",
      "По данным источника заметных событий в истории не видно."
    ].join("\n"),
    reply_markup: compactSectionKeyboard(id, "his")
  };

  const timeline = items
    .map((it) => ({
      date: it.Дата || it.date,
      summary: formatHistoryEventSummary(it),
      importance: scoreHistoryEventImportance(it)
    }))
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 10)
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  const timelineLines = timeline.map((it) => `• <b>${formatDate(it.date)}</b> — ${escapeHtml(it.summary)}`);
  const pagedTimeline = paginateItems(timelineLines, page);
  const lines = [
    "🗓 <b>История</b>",
    SECTION_DIVIDER,
    "",
    escapeHtml(buildHistoryBluf(timeline)),
    "",
    ...pagedTimeline.items
  ];
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id, "his", pagedTimeline.page, pagedTimeline.totalPages) };
}

async function buildConnectionsView(env, id, page = 1) {
  const affiliated = await collectAffiliatedCompanies(env, String(id));
  if (affiliated.state === "missing_config") {
    return {
      text: [
        "🔗 <b>Связи</b>",
        SECTION_DIVIDER,
        "",
        "Связи недоступны: DaData не настроен.",
        "Добавьте ключи DaData, чтобы открыть экран аффилированности."
      ].join("\n"),
      reply_markup: compactSectionKeyboard(id, "lnk")
    };
  }
  if (affiliated.state === "unavailable") {
    return {
      text: [
        "🔗 <b>Связи</b>",
        SECTION_DIVIDER,
        "",
        "Сервис аффилированности временно недоступен.",
        "Попробуйте позже."
      ].join("\n"),
      reply_markup: compactSectionKeyboard(id, "lnk")
    };
  }

  const managersCount = affiliated.managers.length;
  const foundersCount = affiliated.founders.length;
  const total = affiliated.total;
  const listItems = [
    ...affiliated.managers.map((item) => `• ${escapeHtml(item.name)} — через руководителя`),
    ...affiliated.founders.map((item) => `• ${escapeHtml(item.name)} — через учредителя`)
  ];
  const pagedLinks = paginateItems(listItems, page);
  const lines = [
    "🔗 <b>Связи</b>",
    SECTION_DIVIDER,
    "",
    `${getAffiliatedStatusEmoji(total)} <b>${escapeHtml(getAffiliatedDecisionSignal(total, managersCount, foundersCount))}</b>`,
    "",
    "<b>Сводка</b>",
    `• Через руководителя: <b>${managersCount}</b>`,
    `• Через учредителя: <b>${foundersCount}</b>`,
    `• Общий объём сети: <b>${total}</b>`
  ];

  if (total === 0) {
    lines.push("", "<b>Что это значит</b>", "По данным DaData плотной сети связанных компаний не видно.");
    return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id, "lnk") };
  }

  lines.push("", `<b>Список</b> (Стр. ${pagedLinks.page}/${pagedLinks.totalPages})`, ...pagedLinks.items, "", "<b>Что это значит</b>", escapeHtml(getAffiliatedNetworkLabel(total)));
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id, "lnk", pagedLinks.page, pagedLinks.totalPages) };
}

async function buildSuccessorView(env, id) {
  if (!isCheckoConfigured(env)) {
    return buildCheckoMissingConfigView("🏢 <b>Правопреемник</b>", id);
  }

  let payload;
  try {
    payload = await checkoRequest(env, "company", identifierParams(id));
  } catch (error) {
    if (error instanceof CheckoServiceError) {
      return buildCheckoTemporaryUnavailableView("🏢 <b>Правопреемник</b>", id);
    }
    throw error;
  }

  const successor = getSuccessorEntity(payload.data || {});
  if (!successor) {
    return {
      text: [
        "🏢 <b>Правопреемник</b>",
        SECTION_DIVIDER,
        "",
        "Информация о правопреемнике не найдена."
      ].join("\n"),
      reply_markup: compactSectionKeyboard(id, "succ")
    };
  }

  const successorId = String(successor.ИНН || successor.inn || "").trim();
  const lines = [
    "🏢 <b>Правопреемник</b>",
    SECTION_DIVIDER,
    "",
    `<b>${escapeHtml(firstNonEmpty([successor.Наим, successor.НаимСокр, successor.name, "Без названия"]))}</b>`,
    "",
    `• Статус: <b>${escapeHtml(firstNonEmpty([successor.Статус?.Наим, successor.status, "нет данных"]))}</b>`,
    `• ИНН: <code>${escapeHtml(successorId || "нет данных")}</code>`,
    `• Руководитель: <b>${escapeHtml(firstNonEmpty([successor.Руковод?.[0]?.ФИО, successor.Руководитель, successor.director, "нет данных"]))}</b>`,
    "• Связь: <b>правопреемник ликвидированной компании</b>",
    "• Что проверить: <b>долги, суды, действующий статус</b>"
  ];

  const keyboard = compactSectionKeyboard(id, "succ");
  if (successorId) {
    keyboard.inline_keyboard.unshift([kb("Открыть компанию", `select:company:${successorId}`)]);
  }
  return { text: lines.join("\n"), reply_markup: keyboard };
}

async function buildFoundersView(env, id, page = 1) {
  if (!isCheckoConfigured(env)) {
    return buildCheckoMissingConfigView("👥 <b>Учредители</b>", id);
  }

  let payload;
  try {
    payload = await checkoRequest(env, "company", identifierParams(id));
  } catch (error) {
    if (error instanceof CheckoServiceError) {
      return buildCheckoTemporaryUnavailableView("👥 <b>Учредители</b>", id);
    }
    throw error;
  }
  const founders = getCompanyFounders(payload.data || {});
  if (founders.length === 0) return { text: `👥 <b>Учредители</b>
${SECTION_DIVIDER}

Учредители не найдены.
Это не всегда негативный фактор: часть структур не раскрывает состав в источнике.
Можно вернуться в карточку и проверить связи или реквизиты.`, reply_markup: compactSectionKeyboard(id, "lnk") };

  const founderLines = founders.map((f) => `• ${escapeHtml(f.ФИО || f.Наим || "—")} — ${escapeHtml(String(f.Доля?.Процент || f.Доля?.Проц || f.ДоляПроц || "—"))}%`);
  const pagedFounders = paginateItems(founderLines, page);
  const lines = ["👥 <b>Учредители</b>", SECTION_DIVIDER, "", ...pagedFounders.items];
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id, "own", pagedFounders.page, pagedFounders.totalPages) };
}

async function buildBranchesView(env, id, page = 1) {
  if (!isCheckoConfigured(env)) {
    return buildCheckoMissingConfigView("🏬 <b>Филиалы</b>", id);
  }

  let payload;
  try {
    payload = await checkoRequest(env, "company", identifierParams(id));
  } catch (error) {
    if (error instanceof CheckoServiceError) {
      return buildCheckoTemporaryUnavailableView("🏬 <b>Филиалы</b>", id);
    }
    throw error;
  }
  const branches = ensureArray(payload.data?.Филиалы || payload.data?.Подразделения || payload.data?.ОбособПодр || payload.data?.Фил);
  if (branches.length === 0) return { text: `🏬 <b>Филиалы</b>
${SECTION_DIVIDER}

Филиальная сеть не обнаружена или источник не передал данные.
Это нормальная ситуация для компаний без обособленных подразделений.`, reply_markup: compactSectionKeyboard(id, "lnk") };

  const branchLines = branches.map((b) => `• КПП ${escapeHtml(b.КПП || "—")} — ${escapeHtml(truncate(String(b.Адрес || b.АдресРФ || "—"), 48))}`);
  const pagedBranches = paginateItems(branchLines, page);
  const lines = ["🏬 <b>Филиалы</b>", SECTION_DIVIDER, "", `Всего: <b>${branches.length}</b>`, ...pagedBranches.items];
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id, "fil", pagedBranches.page, pagedBranches.totalPages) };
}

async function buildOkvedView(env, id, page = 1) {
  if (!isCheckoConfigured(env)) {
    return buildCheckoMissingConfigView("🔖 <b>ОКВЭД</b>", id);
  }

  let payload;
  try {
    payload = await checkoRequest(env, "company", identifierParams(id));
  } catch (error) {
    if (error instanceof CheckoServiceError) {
      return buildCheckoTemporaryUnavailableView("🔖 <b>ОКВЭД</b>", id);
    }
    throw error;
  }
  const data = payload.data || {};
  const primary = data.ОКВЭД;
  const additional = ensureArray(data.ОКВЭДДоп || data.ДопОКВЭД);
  const additionalLines = additional.map((o) => `• ${escapeHtml(formatOkved(o))}`);
  const pagedOkved = paginateItems(additionalLines, page);
  const lines = [
    "🔖 <b>ОКВЭД</b>",
    SECTION_DIVIDER,
    "",
    `<b>Основной</b> ${escapeHtml(formatOkved(primary))}`,
  ];
  if (additional.length === 0) lines.push("Дополнительные: нет данных");
  else lines.push("", `<b>Дополнительные</b> (Стр. ${pagedOkved.page}/${pagedOkved.totalPages})`, ...pagedOkved.items);
  if (!primary && additional.length === 0) return { text: `🔖 <b>ОКВЭД</b>
${SECTION_DIVIDER}

Данные по ОКВЭД не найдены`, reply_markup: compactSectionKeyboard(id, "okv") };
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id, "okv", pagedOkved.page, pagedOkved.totalPages) };
}

async function buildTaxesView(env, id, page = 1) {
  if (!isCheckoConfigured(env)) {
    return buildCheckoMissingConfigView("🧾 <b>Налоги</b>", id);
  }

  let payload;
  try {
    payload = await checkoRequest(env, "company", identifierParams(id));
  } catch (error) {
    if (error instanceof CheckoServiceError) {
      return buildCheckoTemporaryUnavailableView("🧾 <b>Налоги</b>", id);
    }
    throw error;
  }
  const taxes = payload.data?.Налоги;
  if (!taxes || typeof taxes !== "object") return { text: `🧾 <b>Налоги</b>
${SECTION_DIVIDER}

Налоговые данные не найдены`, reply_markup: compactSectionKeyboard(id, "risk") };

  const yearlyLines = Object.keys(taxes.ПоГодам || {}).sort().reverse().map((year) => `• ${year}: ${formatMoney(taxes.ПоГодам[year])}`);
  const pagedYears = paginateItems(yearlyLines, page);
  const lines = [
    "🧾 <b>Налоги</b>",
    SECTION_DIVIDER,
    "",
    `Итого уплачено: ${formatTaxMoneyState(taxes, ["СумУпл", "СумНалогов"])}`,
    `Недоимка: ${formatTaxMoneyState(taxes, ["СумНедоим"])}`,
    `Пени и штрафы: ${formatTaxMoneyState(taxes, ["СумПениШтр", "СумШтр"])}`
  ];
  if (taxes.ПоГодам && typeof taxes.ПоГодам === "object") {
    lines.push("", `<b>По годам</b> (Стр. ${pagedYears.page}/${pagedYears.totalPages})`, ...pagedYears.items);
  }
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id, "tax", pagedYears.page, pagedYears.totalPages) };
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

function buildCompanyKeyboard(id, env = {}, opts = {}) {
  const rows = [];
  if (isCheckoConfigured(env)) {
    rows.push(
      [kb("⚖️ Риски", `co:risk:${id}`), kb("🏛 Суды", `co:arb:${id}`)],
      [kb("🏦 Долги", `co:debt:${id}`), kb("🔗 Связи", `co:lnk:${id}`)],
      [kb("📊 Финансы", `co:fin:${id}`), kb("📋 Контракты", `co:ctr:${id}`)],
      [kb("🏢 Правопреемник", `co:succ:${id}`), kb("🗓 История", `co:his:${id}`)]
    );
  } else {
    rows.push([kb("🔗 Связи", `co:lnk:${id}`)]);
  }
  rows.push([kb("🏠 Меню", "menu")]);
  return withPagerRow(rows, "main", id, opts.page, opts.totalPages);
}

function buildCheckoMissingConfigView(title, id) {
  return {
    text: `${title}
${SECTION_DIVIDER}

Раздел временно недоступен.
Источник данных не настроен.

Что можно сделать:
• добавить CHECKO_API_KEY
• вернуться в карточку
• открыть другой раздел`,
    reply_markup: compactSectionKeyboard(id)
  };
}

function buildCheckoTemporaryUnavailableView(title, id) {
  return {
    text: `${title}
${SECTION_DIVIDER}

Раздел временно недоступен.
Источник данных сейчас не отвечает.

Что делать:
• попробуйте позже
• вернуться в карточку
• перейдите в другой раздел`,
    reply_markup: compactSectionKeyboard(id)
  };
}

function compactSectionKeyboard(id, section = "main", page = 1, totalPages = 1) {
  let rows;
  if (section === "risk") {
    rows = [
      [kb("🏛 Суды", `co:arb:${id}`), kb("🏦 Долги", `co:debt:${id}`)],
      [kb("🗓 История", `co:his:${id}`), kb("🏢 Правопреемник", `co:succ:${id}`)],
      [kb("🔙 В карточку", `co:main:${id}`)]
    ];
    return withPagerRow(rows, section, id, page, totalPages);
  }
  if (section === "arb") {
    rows = [
      [kb("⚖️ Риски", `co:risk:${id}`), kb("🏦 Долги", `co:debt:${id}`)],
      [kb("🔙 В карточку", `co:main:${id}`)]
    ];
    return withPagerRow(rows, section, id, page, totalPages);
  }
  if (section === "debt") {
    rows = [
      [kb("⚖️ Риски", `co:risk:${id}`), kb("🏛 Суды", `co:arb:${id}`)],
      [kb("🔙 В карточку", `co:main:${id}`)]
    ];
    return withPagerRow(rows, section, id, page, totalPages);
  }
  if (section === "lnk") {
    rows = [
      [kb("🏢 Правопреемник", `co:succ:${id}`)],
      [kb("🔙 В карточку", `co:main:${id}`)]
    ];
    return withPagerRow(rows, section, id, page, totalPages);
  }
  if (section === "fin") {
    rows = [
      [kb("🏦 Долги", `co:debt:${id}`), kb("📋 Контракты", `co:ctr:${id}`)],
      [kb("🔙 В карточку", `co:main:${id}`)]
    ];
    return withPagerRow(rows, section, id, page, totalPages);
  }
  if (section === "ctr") {
    rows = [
      [kb("📊 Финансы", `co:fin:${id}`)],
      [kb("🔙 В карточку", `co:main:${id}`)]
    ];
    return withPagerRow(rows, section, id, page, totalPages);
  }
  if (section === "his") {
    rows = [
      [kb("⚖️ Риски", `co:risk:${id}`)],
      [kb("🔙 В карточку", `co:main:${id}`)]
    ];
    return withPagerRow(rows, section, id, page, totalPages);
  }
  if (section === "succ") {
    rows = [
      [kb("⚖️ Риски", `co:risk:${id}`), kb("🔗 Связи", `co:lnk:${id}`)],
      [kb("🔙 В карточку", `co:main:${id}`)]
    ];
    return { inline_keyboard: rows };
  }
  rows = [
      [kb("⚖️ Риски", `co:risk:${id}`), kb("🏛 Суды", `co:arb:${id}`)],
      [kb("🏦 Долги", `co:debt:${id}`), kb("🔗 Связи", `co:lnk:${id}`)],
      [kb("📊 Финансы", `co:fin:${id}`), kb("📋 Контракты", `co:ctr:${id}`)],
      [kb("🏢 Правопреемник", `co:succ:${id}`), kb("🗓 История", `co:his:${id}`)],
      [kb("🔙 В карточку", `co:main:${id}`), kb("🏠 Меню", "menu")]
    ];
  return withPagerRow(rows, section, id, page, totalPages);
}

function buildGlobalReplyKeyboard() {
  return {
    keyboard: [[{ text: "🔎 Новый поиск" }], [{ text: "📁 История" }, { text: "💬 Поддержка" }]],
    resize_keyboard: true,
    is_persistent: true
  };
}

async function persistViewHistory(env, chatId, view) {
  if (!view?.historyEntry) return;
  await appendLookupHistory(env, chatId, view.historyEntry);
}

function getHistoryCacheKey(chatId) {
  return `history:chat:${chatId}`;
}

async function readLookupHistory(env, chatId) {
  if (!env.COMPANY_CACHE || !chatId) return { state: "unavailable", items: [] };
  try {
    const data = await env.COMPANY_CACHE.get(getHistoryCacheKey(chatId), "json");
    return { state: "ok", items: ensureArray(data) };
  } catch {
    return { state: "unavailable", items: [] };
  }
}

async function appendLookupHistory(env, chatId, entry) {
  if (!env.COMPANY_CACHE || !chatId || !entry?.id) return;
  try {
    const current = await env.COMPANY_CACHE.get(getHistoryCacheKey(chatId), "json");
    const rows = ensureArray(current).filter((item) => String(item.id) !== String(entry.id));
    rows.unshift({ ...entry, id: String(entry.id), timestamp: new Date().toISOString() });
    await env.COMPANY_CACHE.put(getHistoryCacheKey(chatId), JSON.stringify(rows.slice(0, HISTORY_MAX_ITEMS)));
  } catch {
    // optional KV: history should degrade silently
  }
}

async function buildEntrepreneurSectionView(env, section, id) {
  if (section === "risk") {
    const payload = await checkoRequest(env, "entrepreneur", identifierParams(id));
    const data = payload.data || {};
    const lines = [
      "⚠️ <b>Проверки ИП</b>",
      SECTION_DIVIDER,
      "",
      `🎯 <b>${escapeHtml(String(data.Риски?.Уровень || "Риск-маркеры не найдены"))}</b>`,
      `📋 Статус: ${escapeHtml(String(data.Статус?.Наим || "—"))}`,
      `🏷 МСП: ${escapeHtml(String(data.РМСП?.Кат || "нет данных"))}`
    ];
    return { text: lines.join("\n"), reply_markup: { inline_keyboard: [[kb("👔 ИП", `resolve12:entrepreneur:${id}`)], [kb("🏠 В меню", "menu")]] } };
  }

  if (section === "his") {
    const payload = await checkoRequest(env, "history", { ...identifierParams(id), limit: 15 });
    const items = ensureArray(payload.data).slice(0, 15);
    const lines = ["🕓 <b>История ИП</b>", SECTION_DIVIDER];
    if (items.length === 0) lines.push("", "События не найдены");
    else items.slice(0, 10).forEach((it) => lines.push(`• <b>${formatDate(it.Дата || it.date)}</b> — ${escapeHtml(formatHistoryEventSummary(it))}`));
    return { text: lines.join("\n"), reply_markup: { inline_keyboard: [[kb("👔 ИП", `resolve12:entrepreneur:${id}`)], [kb("🏠 В меню", "menu")]] } };
  }

  if (section === "lnk") {
    const payload = await checkoRequest(env, "entrepreneur", identifierParams(id));
    const data = payload.data || {};
    const lines = [
      "🔗 <b>Связи ИП</b>",
      SECTION_DIVIDER,
      "",
      `🎯 Найдено ролей: <b>${(ensureArray(data.Руковод).length > 0 ? 1 : 0) + (ensureArray(data.Учред).length > 0 ? 1 : 0)}</b>`,
      `• Руководитель в организациях: ${ensureArray(data.Руковод).length || 0}`,
      `• Учредитель в организациях: ${ensureArray(data.Учред).length || 0}`,
      `• Адресная связь: ${escapeHtml(String(data.Адрес || data.АдресРег || "нет данных"))}`
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
  const fedresurs = await safeSectionData(env, "fedresurs", { ...identifierParams(id), limit: 1 });
  if (takeRecords(bankruptcy).length > 0 || takeRecords(fedresurs).length > 0) {
    return "Есть сообщения о банкротстве / ЕФРСБ";
  }

  return null;
}



function getDadataDecisionSignal(partyData) {
  const status = String(partyData?.state?.status || "").toLowerCase();
  if (partyData?.state?.liquidation_date || /liquidat|ликвид/.test(status)) return "Есть признаки прекращения деятельности";
  if (partyData?.invalid) return "Требует проверки адреса";
  if (status === "active" || /active|действ/.test(status)) return "Статус стабильный";
  if (!status) return "Нужна дополнительная проверка";
  return "Проверьте актуальность статуса";
}

function statusIcon(status) {
  const normalized = String(status || "").trim().toUpperCase();
  if (normalized === "ACTIVE") return "🟢";
  if (normalized === "LIQUIDATING") return "🟠";
  if (normalized.includes("BANKRUPT") || normalized === "LIQUIDATED") return "🔴";
  return "🟡";
}

function statusLabel(status) {
  const normalized = String(status || "").trim().toUpperCase();
  if (normalized === "ACTIVE") return "действующая организация";
  if (normalized === "LIQUIDATING") return "организация в процессе ликвидации";
  if (normalized === "LIQUIDATED") return "организация ликвидирована";
  if (normalized.includes("BANKRUPT")) return "организация в банкротстве";
  if (!normalized) return "статус требует уточнения";
  return normalized.toLowerCase();
}

function buildStatusVerdict(dadataParty) {
  const status = String(dadataParty?.state?.status || "").trim().toUpperCase();
  if (status === "LIQUIDATED" || dadataParty?.state?.liquidation_date) {
    return "Компания ликвидирована. Рассматривать как действующего контрагента нельзя.";
  }
  if (status === "LIQUIDATING") {
    return "Компания в процессе ликвидации. Новые обязательства рискованны.";
  }
  if (status.includes("BANKRUPT")) {
    return "Компания в банкротстве. Работа возможна только через арбитражного управляющего.";
  }
  if (status === "ACTIVE") {
    return "Компания действующая. Проверьте риски и долги перед сделкой.";
  }
  return "Статус требует уточнения. Рекомендуется ручная проверка.";
}

function truncateAddress(address) {
  const cleaned = String(address || "")
    .replace(/^\d{6},?\s*/u, "")
    .replace(/^Россия,?\s*/iu, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? truncate(cleaned, 60) : "нет данных";
}

function getSuccessorNameFromDadata(partyData) {
  return firstNonEmpty([
    partyData?.successor?.name,
    partyData?.правопреемник?.name,
    "—"
  ]);
}

function getSuccessorEntity(data) {
  return firstTruthy([
    ensureArray(data?.Правопреемник)[0],
    ensureArray(data?.Правопреемники)[0],
    data?.Правопреемник,
    data?.Правопреемники
  ]);
}

function getDadataSubtitle(partyData) {
  const status = String(partyData?.state?.status || "").trim();
  const actualityDate = formatDateFromMsOrIso(partyData?.state?.actuality_date);
  const parts = [status ? `Статус: ${status}` : "", actualityDate !== "—" ? `Актуальность: ${actualityDate}` : ""]
    .filter(Boolean);
  return parts.join(" · ");
}

function formatCompanyStatusLabel(status) {
  const normalized = String(status || "").trim().toUpperCase();
  if (normalized === "ACTIVE") return "🟢 Действующее";
  if (!normalized) return "🟡 Нужна проверка статуса";
  return `🟡 ${normalized}`;
}

function getReadableCompanyStatus(status) {
  const normalized = String(status || "").trim().toUpperCase();
  if (normalized === "ACTIVE") return "действует";
  if (!normalized) return "нужна проверка";
  return normalized.toLowerCase();
}

function buildRiskDashboardText(result, context = {}) {
  const decisionMeta = getRiskDecisionMeta(result.decision);
  const unknowns = ensureArray(result.unknowns);
  const legalCases = ensureArray(context.legalCases);
  const taxes = context.taxes || {};
  const arbitrationSummary = legalCases.length === 0 ? "критичных сигналов не видно" : legalCases.length >= 5 ? "нагрузка заметная" : "есть отдельные дела";
  const defendantSummary = legalCases.filter((item) => /ответчик/i.test(String(item.Роль || ""))).length || "нет явных сигналов";
  const debtSummary = buildRiskDebtSummary(ensureArray(result.negatives));
  const taxSummary = buildRiskTaxSummary(ensureArray(result.negatives));
  const meaningText = unknowns.length >= 3 ? `${decisionMeta.meaning} Данных для уверенного вывода не хватает, поэтому решение лучше считать осторожным.` : decisionMeta.meaning;

  const lines = [
    "⚖️ <b>Риски</b>",
    SECTION_DIVIDER,
    "",
    `${decisionMeta.emoji} <b>${escapeHtml(decisionMeta.bluf)}</b>`,
    "",
    "<b>Сводка</b>",
    `• Арбитраж: ${escapeHtml(arbitrationSummary)}`,
    `• Долги / ФССП: ${escapeHtml(debtSummary)}`,
    `• Налоги: ${escapeHtml(taxSummary || formatTaxMoneyState(taxes, ["СумНедоим"]))}`,
    `• Суды в роли ответчика: ${escapeHtml(String(defendantSummary))}`,
    "",
    "<b>Что это значит</b>",
    escapeHtml(meaningText)
  ];

  if (unknowns.length > 0) {
    lines.push("", "Неизвестно:");
    for (const item of unknowns.slice(0, 3)) lines.push(`• ${escapeHtml(item)}`);
  }

  return lines.join("\n");
}

function getRiskDecisionMeta(decision) {
  if (decision === "approve_standard") {
    return {
      emoji: "🟢",
      bluf: "Критичных факторов не обнаружено",
      label: "стандартные условия",
      meaning: "Компания выглядит устойчиво. Существенных блокеров по текущим данным не видно.",
      recommendation: "Можно работать на стандартных условиях."
    };
  }
  if (decision === "approve_caution") {
    return {
      emoji: "🟡",
      bluf: "Есть отдельные сигналы, которые стоит учесть",
      label: "работать с осторожностью",
      meaning: "Риск не выглядит критичным, но условия сделки лучше сделать аккуратнее.",
      recommendation: "Сократите отсрочку, проверьте документы и лимит."
    };
  }
  if (decision === "manual_review") {
    return {
      emoji: "🟠",
      bluf: "Нужна ручная проверка",
      label: "ручная проверка перед сделкой",
      meaning: "Есть сочетание факторов, которое требует отдельного анализа до согласования условий.",
      recommendation: "Проверьте юрблок, долги, роль в судах и структуру связей."
    };
  }
  if (decision === "prepay_only") {
    return {
      emoji: "🔴",
      bluf: "Риск высокий",
      label: "только предоплата",
      meaning: "Для отсрочки платежа профиль компании выглядит слишком рискованным.",
      recommendation: "Работать только по полной или поэтапной предоплате."
    };
  }
  return {
    emoji: "⛔",
    bluf: "Есть критический стоп-фактор",
    label: "отказ / обязательная правовая проверка",
    meaning: "Новую сделку без отдельной правовой оценки рассматривать нельзя.",
    recommendation: "Остановить сделку или перевести в юридический разбор."
  };
}

function buildRiskCourtSummary(negatives) {
  if (negatives.some((item) => /ответчик|судебный паттерн|судам: компания регулярно выступает ответчиком/i.test(item))) {
    return "есть существенные сигналы";
  }
  if (negatives.some((item) => /судебный фон/i.test(item))) {
    return "есть общий судебный фон";
  }
  return "критичных сигналов не видно";
}

function buildRiskDebtSummary(negatives) {
  if (negatives.some((item) => /фссп|исполнительные производства|долговая нагрузка/i.test(item))) {
    return "есть давление";
  }
  return "критичного давления не видно";
}

function buildRiskTaxSummary(negatives) {
  if (negatives.some((item) => /налог|недоим|пени|штраф/i.test(item))) {
    return "есть налоговые сигналы";
  }
  return "существенных сигналов не видно";
}

function buildCourtsBluf(total, defendantCount, claimAmount) {
  if (defendantCount >= 3 || claimAmount >= 1000000) return "Судебная нагрузка заметная — стоит проверить причины и исходы дел.";
  if (total > 0) return "Судебные дела есть, но объём пока умеренный.";
  return "Судебные дела не найдены.";
}

function buildCourtsMeaning(defendantCount, claimAmount) {
  if (defendantCount >= 3 || claimAmount >= 1000000) return "Перед сделкой стоит проверить исходы дел, роль компании и сумму требований.";
  if (defendantCount > 0) return "Есть дела с участием компании — проверьте свежие споры и текущий статус.";
  return "По текущим данным критичной судебной нагрузки не видно.";
}

function buildDebtBluf(fsspCount, taxDebt, taxPenalties) {
  if (fsspCount > 0 || taxDebt > 0 || taxPenalties > 0) return "Есть долговые сигналы — их стоит проверить до сделки.";
  return "Критичной долговой нагрузки по доступным данным не видно.";
}

function getDebtLoadLabel(fsspCount, taxDebt, taxPenalties) {
  if (fsspCount >= 3 || taxDebt >= 100000) return "высокая";
  if (fsspCount > 0 || taxDebt > 0 || taxPenalties > 0) return "умеренная";
  return "отсутствует";
}

function getDebtNextStep(load) {
  if (load === "высокая") return "проверить долги и условия оплаты";
  if (load === "умеренная") return "проверить свежесть и предмет требований";
  return "можно переходить к другим разделам";
}

function buildContractsBluf(count, failedCount) {
  if (failedCount > 0) return "Часть источников временно недоступна, но контрактная активность видна.";
  if (count >= 5) return "Контрактная активность заметна — полезно проверить крупных заказчиков.";
  return "Контрактная активность ограниченная.";
}

function getContractsMeaning(count) {
  if (count >= 5) return "есть заметная история работы по контрактам";
  if (count > 0) return "есть отдельные контрактные записи";
  return "контрактная активность не видна";
}

function buildHistoryBluf(items) {
  if (!items.length) return "Существенных изменений не обнаружено.";
  const top = items[0];
  return `Последнее заметное событие: ${formatDate(top.date)} — ${top.summary}`;
}

function summarizeFinanceBluf(rows) {
  const summary = summarizeFinanceSignals(rows);
  if (summary === "нет данных") return "Финансовая активность требует ручной проверки.";
  return `Есть признаки живой финансовой активности: ${summary}.`;
}

function isWithinLastMonths(dateValue, months) {
  if (!dateValue) return false;
  const timestamp = new Date(dateValue).getTime();
  if (!Number.isFinite(timestamp)) return false;
  const diffMonths = months * 30 * 24 * 60 * 60 * 1000;
  return Date.now() - timestamp <= diffMonths;
}

function getAffiliatedStatusEmoji(total) {
  if (total === 0) return "🟢";
  if (total <= 3) return "🟡";
  return "🟠";
}

function firstExistingTaxValue(taxes, keys) {
  if (!taxes || typeof taxes !== "object") return null;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(taxes, key) && taxes[key] !== null && taxes[key] !== "") {
      return taxes[key];
    }
  }
  return null;
}

function formatTaxMoneyState(taxes, keys) {
  const value = firstExistingTaxValue(taxes, keys);
  if (value === null || value === undefined || value === "") return "нет данных";
  const amount = toNum(value);
  if (amount === 0) return "0 ₽";
  return formatMoney(amount);
}

function formatHistoryEventSummary(event) {
  return firstNonEmpty([
    event?.Описание,
    event?.Событие,
    event?.Наим,
    event?.Тип,
    event?.event,
    "Существенное изменение в карточке"
  ]);
}

function scoreHistoryEventImportance(event) {
  const text = `${event?.Описание || ""} ${event?.Событие || ""} ${event?.Наим || ""}`.toLowerCase();
  if (/ликвид|банкрот|реорганиз|исключ/.test(text)) return 5;
  if (/руковод|учред|адрес|капитал/.test(text)) return 4;
  if (/оквэд|вид деятель|контакт/.test(text)) return 3;
  return 1;
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

function firstTruthy(values) {
  for (const value of values) {
    if (value) return value;
  }
  return null;
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
  const years = getYearsSorted(financeRows);
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
  const years = getYearsSorted(financeRows);
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

async function collectAffiliatedCompanies(env, sourceInn) {
  if (!isDadataConfigured(env) || !sourceInn) return { managers: [], founders: [], total: 0, state: "missing_config" };

  let party;
  try {
    party = await findPartyByInnOrOgrn(env, sourceInn);
  } catch (error) {
    if (error instanceof DadataServiceError) {
      return { managers: [], founders: [], total: 0, state: "unavailable" };
    }
    throw error;
  }

  const managerInns = extractAffiliationSourceInns(party?.managers || party?.management);
  const founderInns = extractAffiliationSourceInns(party?.founders);
  const scopeConfigs = [
    { scope: ["MANAGERS"], group: "managers", inns: managerInns },
    { scope: ["FOUNDERS"], group: "founders", inns: founderInns }
  ];
  const results = await Promise.allSettled(
    scopeConfigs.map(({ scope, inns }) => findAffiliatedForPersons(env, inns, scope))
  );

  const sourceInnNormalized = String(sourceInn || "").trim();
  const seenManagers = new Set([sourceInnNormalized]);
  const seenFounders = new Set([sourceInnNormalized]);
  const seenTotal = new Set();
  const managers = [];
  const founders = [];
  let unavailableCount = 0;
  let attemptedCount = 0;

  for (let i = 0; i < scopeConfigs.length; i++) {
    const result = results[i];
    if (scopeConfigs[i].inns.length > 0) attemptedCount += 1;
    if (result.status === "rejected") {
      if (result.reason instanceof DadataServiceError) {
        unavailableCount += 1;
        continue;
      }
      throw result.reason;
    }
    const { group } = scopeConfigs[i];
    for (const item of result.value) {
      const inn = String(item?.inn || "").trim();
      if (!inn) continue;
      const normalized = {
        name: item?.name?.short_with_opf || item?.name?.full_with_opf || "Без названия",
        inn,
        status: item?.state?.status || "",
        context: item?.okved || item?.address?.data?.city || ""
      };
      if (group === "managers") {
        if (seenManagers.has(inn)) continue;
        seenManagers.add(inn);
        managers.push(normalized);
      } else {
        if (seenFounders.has(inn)) continue;
        seenFounders.add(inn);
        founders.push(normalized);
      }
      seenTotal.add(inn);
    }
  }

  if (unavailableCount > 0 && managers.length === 0 && founders.length === 0 && attemptedCount > 0) {
    return { managers: [], founders: [], total: 0, state: "unavailable" };
  }

  return { managers, founders, total: seenTotal.size, state: "ok" };
}

async function findAffiliatedForPersons(env, inns, scope) {
  const ids = [...new Set(ensureArray(inns).map((item) => String(item || "").trim()).filter(Boolean))];
  if (ids.length === 0) return [];

  const settled = await Promise.allSettled(ids.map((inn) => findAffiliatedByInn(env, inn, scope)));
  const items = [];

  for (const result of settled) {
    if (result.status === "rejected") {
      if (result.reason instanceof DadataServiceError) {
        throw result.reason;
      }
      throw result.reason;
    }
    items.push(...result.value);
  }

  return items;
}

function extractAffiliationSourceInns(value) {
  return ensureArray(value)
    .flatMap((item) => [item?.inn, item?.data?.inn, item?.share?.inn])
    .map((inn) => String(inn || "").trim())
    .filter((inn) => /^\d{10,12}$/.test(inn));
}

function buildAffiliatedGroupLines(title, items, limit) {
  if (!items.length) return [];
  const relationLabel = /руковод/i.test(title) ? "через руководителя" : "через учредителя";
  const lines = ["", `<b>${escapeHtml(title)}</b>`];
  for (const item of items.slice(0, limit)) {
    const statusText = item.status ? ` · ${escapeHtml(String(item.status))}` : "";
    const contextText = item.context ? ` · ${escapeHtml(String(item.context))}` : "";
    lines.push(`• <b>${escapeHtml(item.name)}</b>  ·  ИНН <code>${escapeHtml(item.inn)}</code> · ${escapeHtml(relationLabel)}${statusText}${contextText}`);
  }
  if (items.length > limit) {
    lines.push(`… и ещё ${items.length - limit}`);
  }
  return lines;
}

function getAffiliatedNetworkLabel(total) {
  if (total === 0) return "Аффилированность не обнаружена";
  if (total <= 3) return "Слабая сеть связей";
  if (total <= 8) return "Умеренная сеть связей";
  return "Плотная сеть связей";
}

function getAffiliatedDecisionSignal(total, managersCount, foundersCount) {
  if (total === 0) return "Критичных признаков аффилированности не найдено";
  if (managersCount > 0 && foundersCount > 0 && total >= 4) return "Требует ручного анализа структуры";
  return "Сеть связей ограниченная";
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

function normalizeFinanceReportLinks(reportPayload) {
  if (!reportPayload) return [];
  if (typeof reportPayload === "string") {
    return [{ label: "Источник", url: reportPayload }];
  }
  if (typeof reportPayload !== "object") return [];

  const entries = Object.entries(reportPayload)
    .filter(([, url]) => typeof url === "string" && url.trim())
    .map(([year, url]) => ({ label: year, url: url.trim() }))
    .sort((a, b) => String(b.label).localeCompare(String(a.label)));

  return entries.slice(0, 4);
}

function buildDadataMainLines(partyData) {
  if (!partyData) return [];
  const lines = ["", "🔍 <b>Доп. данные</b>"];
  if (partyData.employee_count) lines.push(`👥 Сотрудников  ${escapeHtml(String(partyData.employee_count))}`);
  if (partyData.finance?.income) lines.push(`📊 Доход  ${escapeHtml(formatMoney(partyData.finance.income))}`);
  if (partyData.finance?.expense) lines.push(`📉 Расход  ${escapeHtml(formatMoney(partyData.finance.expense))}`);
  if (partyData.invalid) lines.push(`⚠️ Адрес недостоверен`);
  const phones = formatContactList(partyData.phones);
  const emails = formatContactList(partyData.emails);
  if (phones) lines.push(`📞 ${escapeHtml(phones)}`);
  if (emails) lines.push(`✉️ ${escapeHtml(emails)}`);
  return lines.length > 2 ? lines : [];
}

function isDadataConfigured(env) {
  return Boolean(env.DADATA_API_KEY && env.DADATA_SECRET_KEY);
}

function isCheckoConfigured(env) {
  return Boolean(env.CHECKO_API_KEY);
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

function parseCompanySectionCallback(data) {
  const match = String(data || "").match(/^co:([^:]+):([^:]+)(?::p:(\d+))?$/);
  if (!match) return null;
  return {
    section: match[1],
    id: match[2],
    page: parsePageFromCallback(match[3])
  };
}

function parsePageFromCallback(value) {
  const page = Number.parseInt(String(value || "1"), 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

function paginateItems(items, page, pageSize = PAGE_SIZE) {
  const normalizedItems = Array.isArray(items) ? items : [];
  const totalPages = Math.max(1, Math.ceil(normalizedItems.length / pageSize));
  const safePage = Math.min(Math.max(1, page || 1), totalPages);
  const start = (safePage - 1) * pageSize;
  return {
    items: normalizedItems.slice(start, start + pageSize),
    page: safePage,
    totalPages,
    hasPrev: safePage > 1,
    hasNext: safePage < totalPages
  };
}

function buildPagerRow(section, id, page, totalPages) {
  if (!totalPages || totalPages <= 1) return null;
  const row = [];
  if (page > 1) row.push(kb("⬅️", `co:${section}:${id}:p:${page - 1}`));
  row.push(kb(`${page}/${totalPages}`, `co:${section}:${id}:p:${page}`));
  if (page < totalPages) row.push(kb("➡️", `co:${section}:${id}:p:${page + 1}`));
  return row;
}

function withPagerRow(rows, section, id, page = 1, totalPages = 1) {
  const pagerRow = buildPagerRow(section, id, page, totalPages);
  return {
    inline_keyboard: pagerRow ? [pagerRow, ...rows] : rows
  };
}

function startSection(title) {
  return [title, SECTION_DIVIDER];
}

function getYearsSorted(rows) {
  if (!rows || typeof rows !== "object") return [];
  return Object.keys(rows).filter((y) => /^\d{4}$/.test(y)).sort((a, b) => Number(b) - Number(a));
}

function formatContactList(items, limit = 2) {
  return items?.slice(0, limit).map((c) => c.value).filter(Boolean).join("  ·  ") || "";
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

function formatDateFromMsOrIso(value) {
  if (!value && value !== 0) return "—";
  if (typeof value === "number") return formatDate(new Date(value).toISOString());
  return formatDate(value);
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

function parseNullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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
