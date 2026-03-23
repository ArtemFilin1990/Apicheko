import { calculateCompanyRiskScore, formatRiskResultForTelegram } from "./services/risk-score.js";

const DEFAULT_CHECKO_API_URL = "https://api.checko.ru/v2";
const DEFAULT_WEBHOOK_PATH = "/webhook";
const COMPANY_NOT_FOUND_MESSAGE = "❌ Компания не найдена";
const CHECKO_SERVICE_ERROR_MESSAGE = "⚠️ Ошибка сервиса Checko";
const SEARCH_MIN_QUERY_LENGTH = 4;
const DEFAULT_DADATA_API_URL = "https://suggestions.dadata.ru/suggestions/api/4_1/rs";
const CACHE_TTL_COMPANY_SECONDS = 12 * 60 * 60;
const CACHE_TTL_DADATA_PARTY_SECONDS = 12 * 60 * 60;
const CACHE_TTL_AFFILIATED_SECONDS = 24 * 60 * 60;
const CACHE_TTL_EMAIL_SECONDS = 6 * 60 * 60;
const HISTORY_MAX_ITEMS = 10;
const SECTION_DIVIDER = "──────────────────";
const PAGE_SIZE = 5;
const EXTERNAL_FETCH_TIMEOUT_MS = 10000;

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

  if (data === "noop") return null;

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
      "• связи и аффилированность",
      "• финансовый контур",
      "• учредителей и ОКВЭД",
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
  const partyState = await loadDadataPartyState(env, id);
  if (partyState.state === "missing_config") {
    return buildDadataMissingConfigView("📊 <b>Финансы</b>", id);
  }
  if (partyState.state === "unavailable") {
    return buildDadataTemporaryUnavailableView("📊 <b>Финансы</b>", id);
  }

  const finance = partyState.party?.finance;
  if (!finance || typeof finance !== "object" || !hasVisibleFinanceData(finance, partyState.party?.employee_count)) {
    return {
      text: [
        "📊 <b>Финансы</b>",
        SECTION_DIVIDER,
        "",
        "Финансовый контур не найден.",
        "DaData не передал финансовые показатели по этой компании."
      ].join("\n"),
      reply_markup: compactSectionKeyboard(id, "fin")
    };
  }

  const lines = [
    "📊 <b>Финансы</b>",
    SECTION_DIVIDER,
    "",
    escapeHtml(buildFinanceBluf(finance)),
    "",
    `• Год: <b>${escapeHtml(formatOptionalYear(finance.year))}</b>`,
    `• Доход: <b>${escapeHtml(formatOptionalMoney(finance.income))}</b>`,
    `• Расход: <b>${escapeHtml(formatOptionalMoney(finance.expense))}</b>`,
    `• Выручка: <b>${escapeHtml(formatOptionalMoney(finance.revenue))}</b>`,
    `• Долг: <b>${escapeHtml(formatOptionalMoney(finance.debt))}</b>`,
    `• Пени: <b>${escapeHtml(formatOptionalMoney(finance.penalty))}</b>`,
    `• Штат: <b>${escapeHtml(formatOptionalNumber(partyState.party?.employee_count))}</b>`
  ];

  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id, "fin") };
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
        "Раздел временно недоступен.",
        "Источник данных не настроен.",
        "",
        "Можно вернуться в карточку."
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
        "Источник временно недоступен.",
        "Не удалось получить связи компании из DaData.",
        "",
        "Попробуйте позже или вернитесь в карточку."
      ].join("\n"),
      reply_markup: compactSectionKeyboard(id, "lnk")
    };
  }

  const managersCount = affiliated.managers.length;
  const foundersCount = affiliated.founders.length;
  const total = affiliated.total;
  if (total === 0) {
    return {
      text: [
        "🔗 <b>Связи</b>",
        SECTION_DIVIDER,
        "",
        "🟢 <b>Связи не найдены.</b>",
        "",
        "Компания, вероятно, самостоятельная:",
        "общих руководителей или учредителей по данным DaData не видно."
      ].join("\n"),
      reply_markup: compactSectionKeyboard(id, "lnk")
    };
  }

  const pagedItems = paginateItems(
    affiliated.deduped.map((item) => `• ${escapeHtml(formatAffiliatedListItem(item))}`),
    page
  );
  const lines = [
    "🔗 <b>Связи</b>",
    SECTION_DIVIDER,
    "",
    `${escapeHtml(buildLinksEmoji(total))} <b>${escapeHtml(buildLinksBluf(total, managersCount, foundersCount))}</b>`,
    "",
    "<b>Сводка</b>",
    `• Через руководителя: <b>${managersCount}</b>${formatAffiliatedSummaryNames(affiliated.managers)}`,
    `• Через учредителя: <b>${foundersCount}</b>${formatAffiliatedSummaryNames(affiliated.founders)}`,
    `• Общий объём сети: <b>${total}</b> (без дублей)${formatAffiliatedSummaryNames(affiliated.deduped)}`,
    "",
    `<b>Список компаний</b> (Стр. ${pagedItems.page}/${pagedItems.totalPages})`,
    ...pagedItems.items,
    "",
    "<b>Что это значит</b>",
    escapeHtml(buildLinksMeaning(total, managersCount, foundersCount))
  ];

  return {
    text: lines.join("\n"),
    reply_markup: compactSectionKeyboard(id, "lnk", pagedItems.page, pagedItems.totalPages)
  };
}

async function buildSuccessorView(env, id, page = 1) {
  const partyState = await loadDadataPartyState(env, id);
  if (partyState.state === "missing_config") {
    return buildDadataMissingConfigView("🏢 <b>Правопреемник</b>", id);
  }
  if (partyState.state === "unavailable") {
    return buildDadataTemporaryUnavailableView("🏢 <b>Правопреемник</b>", id);
  }

  const successor = ensureArray(partyState.party?.successors)[0] || null;
  if (!successor) {
    return {
      text: [
        "🏢 <b>Правопреемник</b>",
        SECTION_DIVIDER,
        "",
        "Правопреемник не найден.",
        "",
        "В источнике нет данных о компании-правопреемнике.",
        "Можно вернуться в карточку."
      ].join("\n"),
      reply_markup: compactSectionKeyboard(id, "succ")
    };
  }

  const successorId = String(successor.ИНН || successor.inn || "").trim();
  const lines = [
    "🏢 <b>Правопреемник</b>",
    SECTION_DIVIDER,
    "",
    `<b>${escapeHtml(firstNonEmpty([successor.Наим, successor.name?.short_with_opf, successor.name?.full_with_opf, "Правопреемник"]))}</b>`,
    "",
    `• Статус: ${escapeHtml(firstNonEmpty([successor.Статус?.Наим, statusLabel(successor.state?.status), "нет данных"]))}`,
    `• ИНН: ${escapeHtml(successorId || "нет данных")}`,
    `• Руководитель: ${escapeHtml(firstNonEmpty([successor.Руковод?.[0]?.ФИО, successor.management?.name, successor.managers?.[0]?.name, "нет данных"]))}`,
    "• Связь: правопреемник ликвидированной компании",
    "• Что проверить: действующий статус и связи"
  ];

  const keyboard = compactSectionKeyboard(id, "succ");
  if (successorId) {
    keyboard.inline_keyboard.unshift([kb("Открыть компанию", `select:company:${successorId}`)]);
  }
  return { text: lines.join("\n"), reply_markup: keyboard };
}

async function buildFoundersView(env, id, page = 1) {
  const partyState = await loadDadataPartyState(env, id);
  if (partyState.state === "missing_config") {
    return buildDadataMissingConfigView("👥 <b>Учредители</b>", id);
  }
  if (partyState.state === "unavailable") {
    return buildDadataTemporaryUnavailableView("👥 <b>Учредители</b>", id);
  }

  const founders = ensureArray(partyState.party?.founders);
  if (founders.length === 0) return { text: `👥 <b>Учредители</b>
${SECTION_DIVIDER}

Учредители не найдены.
DaData не передал состав учредителей по этой компании.`, reply_markup: compactSectionKeyboard(id, "own") };

  const founderLines = founders.map((founder) => formatFounderLine(founder));
  const pagedFounders = paginateItems(founderLines, page);
  const lines = ["👥 <b>Учредители</b>", SECTION_DIVIDER, "", `<b>Список</b> (Стр. ${pagedFounders.page}/${pagedFounders.totalPages})`, ...pagedFounders.items];
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
  const partyState = await loadDadataPartyState(env, id);
  if (partyState.state === "missing_config") {
    return buildDadataMissingConfigView("🏷 <b>ОКВЭД</b>", id);
  }
  if (partyState.state === "unavailable") {
    return buildDadataTemporaryUnavailableView("🏷 <b>ОКВЭД</b>", id);
  }

  const primary = partyState.party?.okved;
  const additional = ensureArray(partyState.party?.okveds).filter((item) => String(item?.code || item?.name || "").trim());
  const additionalLines = additional.map((item) => `• ${escapeHtml(formatDadataOkved(item))}`);
  const pagedOkved = paginateItems(additionalLines, page);
  const lines = [
    "🏷 <b>ОКВЭД</b>",
    SECTION_DIVIDER,
    "",
    `<b>Основной ОКВЭД</b> ${escapeHtml(primary || "нет данных")}`,
  ];
  if (additional.length === 0) lines.push("Дополнительные: нет данных");
  else lines.push("", `<b>Дополнительные</b> (Стр. ${pagedOkved.page}/${pagedOkved.totalPages})`, ...pagedOkved.items);
  if (!primary && additional.length === 0) return { text: `🏷 <b>ОКВЭД</b>
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
  const rows = [
    [kb("🔗 Связи", `co:lnk:${id}`), kb("👥 Учредители", `co:own:${id}`)],
    [kb("📊 Финансы", `co:fin:${id}`), kb("🏷 ОКВЭД", `co:okv:${id}`)],
    [kb("🏢 Правопреемник", `co:succ:${id}`), kb("🏢 Карточка", `co:main:${id}`)],
    [kb("🏠 Меню", "menu")]
  ];
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
      [kb("🏷 ОКВЭД", `co:okv:${id}`), kb("👥 Учредители", `co:own:${id}`)],
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
      [kb("🔗 Связи", `co:lnk:${id}`), kb("👥 Учредители", `co:own:${id}`)],
      [kb("🔙 В карточку", `co:main:${id}`)]
    ];
    return { inline_keyboard: rows };
  }
  if (section === "own") {
    rows = [
      [kb("🏷 ОКВЭД", `co:okv:${id}`), kb("🔗 Связи", `co:lnk:${id}`)],
      [kb("🔙 В карточку", `co:main:${id}`)]
    ];
    return withPagerRow(rows, section, id, page, totalPages);
  }
  if (section === "okv") {
    rows = [
      [kb("👥 Учредители", `co:own:${id}`), kb("📊 Финансы", `co:fin:${id}`)],
      [kb("🔙 В карточку", `co:main:${id}`)]
    ];
    return withPagerRow(rows, section, id, page, totalPages);
  }
  rows = [
    [kb("🔗 Связи", `co:lnk:${id}`), kb("👥 Учредители", `co:own:${id}`)],
    [kb("📊 Финансы", `co:fin:${id}`), kb("🏷 ОКВЭД", `co:okv:${id}`)],
    [kb("🏢 Правопреемник", `co:succ:${id}`), kb("🏢 Карточка", `co:main:${id}`)],
    [kb("🏠 Меню", "menu")]
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

function buildRiskDashboardText(riskResult, context = {}) {
  const decisionMeta = getRiskDecisionMeta(riskResult?.decision);
  const unknowns = ensureArray(riskResult?.unknowns);
  const topFactors = ensureArray(riskResult?.topFactors);
  const bluf = unknowns.length >= 3 && !["reject_or_legal_review", "prepay_only"].includes(riskResult?.decision) ? "Данных для уверенного вывода не хватает" : decisionMeta.bluf;
  const lines = [
    "⚖️ <b>Риски</b>",
    SECTION_DIVIDER,
    "",
    `${decisionMeta.emoji} <b>${escapeHtml(bluf)}</b>`,
    "",
    "<b>Сводка</b>",
    `• Уровень риска: <b>${escapeHtml(levelToRussian(riskResult?.level || "medium"))}</b>`,
    `• Балл: <b>${escapeHtml(String(riskResult?.score ?? "—"))}/100</b>`,
    `• Суды: <b>${escapeHtml(buildRiskCourtSummary(ensureArray(riskResult?.negatives)))}</b>`,
    `• Долги: <b>${escapeHtml(buildRiskDebtSummary(ensureArray(riskResult?.negatives)))}</b>`,
    `• Налоги: <b>${escapeHtml(buildRiskTaxSummary(ensureArray(riskResult?.negatives)))}</b>`,
    "",
    "<b>Почему</b>",
    ...(topFactors.length > 0 ? topFactors.map((item) => `• ${escapeHtml(item.title)}`) : ["• Данных для уверенного вывода не хватает"]),
    "",
    "<b>Что это значит</b>",
    escapeHtml(decisionMeta.meaning),
    "",
    "<b>Что делать</b>",
    escapeHtml(decisionMeta.recommendation),
    "",
    `<b>Итог</b> ${escapeHtml(riskResult?.summary || "Данных для уверенного вывода не хватает")}`
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

  const response = await fetchWithTimeout(url.toString(), { method: "GET" });
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
  if (!isDadataConfigured(env) || !sourceInn) return { managers: [], founders: [], deduped: [], total: 0, state: "missing_config" };

  let party = null;
  let degradedByParty = false;
  try {
    party = await findPartyByInnOrOgrn(env, sourceInn);
  } catch (error) {
    if (error instanceof DadataServiceError) {
      degradedByParty = true;
    } else {
      throw error;
    }
  }

  let managerInns = extractAffiliationSourceInns([party?.management, ...(party?.managers || [])]);
  let founderInns = extractAffiliationSourceInns(party?.founders || []);
  if ((managerInns.length === 0 && founderInns.length === 0) && degradedByParty) {
    managerInns = [String(sourceInn)];
    founderInns = [String(sourceInn)];
  }
  const scopeConfigs = [
    { scope: ["MANAGERS"], group: "managers", inns: managerInns },
    { scope: ["FOUNDERS"], group: "founders", inns: founderInns }
  ];

  const results = await Promise.allSettled(
    scopeConfigs.map(async ({ inns, scope }) => {
      if (inns.length === 0) return [];
      const batches = await Promise.all(inns.map((inn) => findAffiliatedByInn(env, inn, scope)));
      return batches.flat();
    })
  );

  const sourceInnNormalized = String(sourceInn || "").trim();
  const seenManagers = new Set([sourceInnNormalized]);
  const seenFounders = new Set([sourceInnNormalized]);
  const managers = [];
  const founders = [];
  const dedupedMap = new Map();
  let attemptedCount = 0;
  let unavailableGroups = 0;

  for (let i = 0; i < scopeConfigs.length; i++) {
    const { group, inns } = scopeConfigs[i];
    const result = results[i];
    if (inns.length > 0) attemptedCount += 1;
    if (result.status === "rejected") {
      if (result.reason instanceof DadataServiceError) {
        unavailableGroups += 1;
        continue;
      }
      throw result.reason;
    }

    for (const item of result.value) {
      const normalized = normalizeAffiliatedCompany(item);
      if (!normalized || normalized.inn === sourceInnNormalized) continue;

      if (group === "managers") {
        if (!seenManagers.has(normalized.inn)) {
          seenManagers.add(normalized.inn);
          managers.push(normalized);
        }
      } else if (!seenFounders.has(normalized.inn)) {
        seenFounders.add(normalized.inn);
        founders.push(normalized);
      }

      const existing = dedupedMap.get(normalized.inn);
      if (existing) {
        existing.relations.add(group);
        if (existing.status === "нет данных" && normalized.status !== "нет данных") existing.status = normalized.status;
        if (existing.okved === "нет данных" && normalized.okved !== "нет данных") existing.okved = normalized.okved;
      } else {
        dedupedMap.set(normalized.inn, { ...normalized, relations: new Set([group]) });
      }
    }
  }

  if (attemptedCount > 0 && unavailableGroups === attemptedCount) {
    return { managers: [], founders: [], deduped: [], total: 0, state: "unavailable" };
  }

  if (degradedByParty) {
    if (managers.length > 0 && founders.length === 0) {
      founders.push(...managers);
      for (const item of managers) {
        const existing = dedupedMap.get(item.inn);
        if (existing) existing.relations.add("founders");
      }
    } else if (founders.length > 0 && managers.length === 0) {
      managers.push(...founders);
      for (const item of founders) {
        const existing = dedupedMap.get(item.inn);
        if (existing) existing.relations.add("managers");
      }
    }
  }

  const deduped = Array.from(dedupedMap.values())
    .map((item) => ({
      ...item,
      relations: Array.from(item.relations).sort()
    }))
    .sort(compareAffiliatedCompanies);

  return {
    managers,
    founders,
    deduped,
    total: deduped.length,
    state: "ok"
  };
}

async function loadDadataPartyState(env, id) {
  if (!isDadataConfigured(env)) return { state: "missing_config", party: null };
  try {
    return { state: "ok", party: await findPartyByInnOrOgrn(env, id) };
  } catch (error) {
    if (error instanceof DadataServiceError) return { state: "unavailable", party: null };
    throw error;
  }
}

function extractAffiliationSourceInns(value) {
  return ensureArray(value)
    .flatMap((item) => [item?.inn, item?.data?.inn, item?.share?.inn])
    .map((inn) => String(inn || "").trim())
    .filter((inn) => /^\d{10,12}$/.test(inn));
}

function normalizeAffiliatedCompany(item) {
  const inn = String(item?.inn || "").trim();
  if (!inn) return null;
  return {
    name: item?.name?.short_with_opf || item?.name?.full_with_opf || "Без названия",
    inn,
    status: getReadableAffiliatedStatus(item?.state?.status),
    okved: firstNonEmpty([item?.okved, item?.okved_type, "нет данных"])
  };
}

function compareAffiliatedCompanies(left, right) {
  const statusDelta = getAffiliatedStatusRank(left?.status) - getAffiliatedStatusRank(right?.status);
  if (statusDelta !== 0) return statusDelta;
  return String(left?.name || "").localeCompare(String(right?.name || ""), "ru");
}

function getAffiliatedStatusRank(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "действует") return 0;
  if (normalized === "ликвидация") return 1;
  if (normalized === "ликвидирована") return 2;
  return 3;
}

function getReadableAffiliatedStatus(status) {
  const normalized = String(status || "").trim().toUpperCase();
  if (normalized === "ACTIVE") return "действует";
  if (normalized === "LIQUIDATING") return "ликвидация";
  if (normalized === "LIQUIDATED") return "ликвидирована";
  return normalized ? normalized.toLowerCase() : "нет данных";
}

function formatAffiliatedListItem(item) {
  return `${item.name} (${item.inn}) — ${item.status} — ${item.okved}`;
}

function buildLinksEmoji(total) {
  if (total === 0) return "🟢";
  if (total <= 5) return "🟡";
  return "🟠";
}

function buildLinksBluf(total, managersCount, foundersCount) {
  if (total === 0) return "Связи не найдены.";
  if (managersCount > 0 && foundersCount > 0) return "У компании есть сеть связанных организаций.";
  if (managersCount > 0) return "Связи видны через руководителя.";
  if (foundersCount > 0) return "Связи видны через учредителя.";
  return "Связи требуют дополнительной проверки.";
}

function buildLinksMeaning(total, managersCount, foundersCount) {
  if (total === 0) return "По данным DaData компания выглядит самостоятельной.";
  if (managersCount > 0 && foundersCount > 0) return "Есть пересечения по руководителям и учредителям: сеть нужно проверить на долговую и судебную нагрузку.";
  if (managersCount > 0) return "Связи через руководителя могут показывать управленческий контур группы.";
  if (foundersCount > 0) return "Связи через учредителя помогают увидеть общую структуру владения.";
  return "Связи стоит проверить вручную.";
}

function formatFounderLine(founder) {
  const name = firstNonEmpty([founder?.name, founder?.fio, founder?.ФИО, founder?.Наим, "без названия"]);
  const inn = firstNonEmpty([founder?.inn, founder?.INN, "нет данных"]);
  const share = firstNonEmpty([
    founder?.share?.value,
    founder?.share?.percentage,
    founder?.share?.ratio,
    founder?.Доля?.Процент,
    founder?.Доля?.Проц,
    founder?.ДоляПроц
  ]);
  const invalid = founder?.invalid === true || founder?.invalidity === true || founder?.Недостоверность === true;
  const details = [
    `ИНН: <code>${escapeHtml(String(inn))}</code>`,
    share ? `доля: ${escapeHtml(String(share))}${String(share).includes("%") ? "" : "%"}` : null,
    invalid ? "недостоверность: есть" : null
  ].filter(Boolean);
  return `• ${escapeHtml(String(name))}${details.length ? ` — ${details.join(" · ")}` : ""}`;
}

function formatDadataOkved(item) {
  return [item?.code, item?.name].filter(Boolean).join(" — ") || "нет данных";
}

function hasVisibleFinanceData(finance, employeeCount) {
  return [finance?.year, finance?.income, finance?.expense, finance?.revenue, finance?.debt, finance?.penalty, employeeCount]
    .some((value) => value !== undefined && value !== null && value !== "");
}

function buildFinanceBluf(finance) {
  const year = formatOptionalYear(finance?.year);
  const revenue = formatOptionalMoney(finance?.revenue);
  if (year !== "нет данных" && revenue !== "нет данных") {
    return `Последний доступный финансовый срез — ${year} год, выручка ${revenue}.`;
  }
  if (year !== "нет данных") {
    return `Последний доступный финансовый срез — ${year} год.`;
  }
  return "Финансовые показатели доступны частично: проверьте ключевые суммы ниже.";
}

function formatOptionalYear(value) {
  const year = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(year) && year > 0 ? String(year) : "нет данных";
}

function buildDadataMissingConfigView(title, id) {
  return {
    text: `${title}
${SECTION_DIVIDER}

DaData не настроен.
Попросите администратора добавить ключи и откройте раздел снова.`,
    reply_markup: compactSectionKeyboard(id)
  };
}

function buildDadataTemporaryUnavailableView(title, id) {
  return {
    text: `${title}
${SECTION_DIVIDER}

DaData временно недоступен.
Попробуйте открыть раздел чуть позже.`,
    reply_markup: compactSectionKeyboard(id)
  };
}

function formatAffiliatedSummaryNames(items) {
  const names = ensureArray(items).map((item) => item?.name).filter(Boolean).slice(0, 2);
  return names.length > 0 ? ` (${escapeHtml(names.join(", "))})` : "";
}

function formatAffiliatedCompanyLine(item) {
  return `• ${escapeHtml(item.name)} (${escapeHtml(item.inn)}) — ${escapeHtml(item.status)} — ${escapeHtml(item.okved || "нет данных")}`;
}

function extractAffiliationPersonInns(items, fallbackInn) {
  const seen = new Set();
  const result = [];
  const pushInn = (value) => {
    const normalized = String(value || "").replace(/\D+/g, "");
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    result.push(normalized);
  };

  ensureArray(items).forEach((item) => pushInn(item?.inn || item?.INN || item?.person?.inn || item?.ФЛ?.ИНН || item?.ЮЛ?.ИНН));
  pushInn(fallbackInn);
  return result;
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
  if (total === 0) return "Критичных признаков аффилированности не найдено.";
  if (managersCount > 0 && foundersCount > 0 && total >= 4) return "Сеть связанных организаций плотная — нужен ручной анализ.";
  if (total >= 3) return "Есть заметная сеть связанных организаций.";
  return "Есть ограниченная сеть связанных организаций.";
}

function getAffiliatedMeaning(total, managersCount, foundersCount) {
  if (total === 0) return "По данным DaData плотной сети связанных компаний не видно.";
  if (managersCount > 0 && foundersCount > 0) {
    return "Связи видны и через руководителей, и через учредителей. Перед сделкой стоит проверить ключевые компании сети.";
  }
  if (managersCount > 0) {
    return "Связи проходят через руководителей. Это может указывать на управленческий контур группы компаний.";
  }
  if (foundersCount > 0) {
    return "Связи проходят через учредителей. Это помогает понять контур владения и зависимые организации.";
  }
  return "Связанные организации не обнаружены в доступном наборе DaData.";
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

function summarizeFinanceBluf(rows) {
  const years = getYearsSorted(rows);
  if (!years.length) return "Финансовые данные за последние годы не найдены.";
  const latest = rows[years[0]] || {};
  const revenue = latest[2110];
  const profit = latest[2400];
  if (revenue !== undefined || profit !== undefined) {
    return `Последний доступный год: ${years[0]}, выручка ${formatMoney(revenue)}, прибыль ${formatMoney(profit)}.`;
  }
  return `Последний доступный год: ${years[0]}.`;
}

function buildCourtsBluf(total, defendantCount, claimAmount) {
  if (!total) return "Существенной судебной нагрузки не видно.";
  if (defendantCount >= 3 || claimAmount >= 1000000) return "Судебная нагрузка заметная: нужен контроль рисков.";
  if (defendantCount > 0) return "Есть судебные дела, где компанию стоит проверить внимательнее.";
  return "Судебные дела есть, но критичной нагрузки не видно.";
}

function buildCourtsMeaning(defendantCount, claimAmount) {
  if (defendantCount >= 3 || claimAmount >= 1000000) return "Перед сделкой проверьте активные споры, суммы требований и роль компании в делах.";
  if (defendantCount > 0) return "Компания участвует в судах как ответчик: лучше уточнить статус споров.";
  return "По текущим данным судебный фон выглядит управляемым.";
}

function buildDebtBluf(fsspCount, taxDebt, taxPenalties) {
  const totalTax = Number(taxDebt || 0) + Number(taxPenalties || 0);
  if (fsspCount === 0 && totalTax === 0) return "Критичных долговых сигналов не видно.";
  if (fsspCount > 0 && totalTax > 0) return "Есть и налоговые долги, и исполнительные производства.";
  if (fsspCount > 0) return "Есть исполнительные производства: проверьте основания и суммы.";
  return "Есть налоговая задолженность: лучше уточнить её актуальность перед сделкой.";
}

function getDebtLoadLabel(fsspCount, taxDebt, taxPenalties) {
  const totalTax = Number(taxDebt || 0) + Number(taxPenalties || 0);
  if (fsspCount >= 3 || totalTax >= 1000000) return "высокая";
  if (fsspCount > 0 || totalTax > 0) return "умеренная";
  return "низкая";
}

function getDebtNextStep(load) {
  if (load === "высокая") return "запросить пояснения и ограничить отсрочку";
  if (load === "умеренная") return "сверить долги перед сделкой";
  return "достаточно плановой проверки";
}

function buildContractsBluf(total, failedCount) {
  if (!total) return "Госконтракты не найдены.";
  if (failedCount > 0) return "Часть источников не ответила, но контракты в данных есть.";
  return "У компании есть подтверждённые госконтракты.";
}

function getContractsMeaning(total) {
  if (!total) return "госконтракты не зафиксированы";
  if (total >= 5) return "есть заметный опыт работы по контрактам";
  return "контрактная активность подтверждена";
}

function buildHistoryBluf(timeline) {
  if (!timeline.length) return "Заметных событий в истории не видно.";
  return `Показаны ${timeline.length} наиболее важных события из истории компании.`;
}

function levelToRussian(level) {
  if (level === "critical") return "критический";
  if (level === "high") return "высокий";
  if (level === "medium") return "средний";
  if (level === "low") return "низкий";
  return "не определён";
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
  let response;
  let raw;
  try {
    response = await fetchWithTimeout(`${baseUrl}/${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Token ${env.DADATA_API_KEY}`,
        "X-Secret": env.DADATA_SECRET_KEY
      },
      body: JSON.stringify(payload)
    });
    raw = await response.text();
  } catch (error) {
    throw new DadataServiceError(`DaData request failed: ${error instanceof Error ? error.message : String(error)}`);
  }

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
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (response.status !== 200) {
    throw new Error(`Telegram API HTTP ${response.status}`);
  }
}

async function fetchWithTimeout(resource, options = {}, timeoutMs = EXTERNAL_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error("Request timeout")), timeoutMs);
  try {
    return await fetch(resource, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
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
    page: parsePageFromCallback(data)
  };
}

function parsePageFromCallback(data) {
  const callbackMatch = String(data || "").match(/:p:(\d+)$/);
  const rawPage = callbackMatch?.[1] || data;
  const page = Number.parseInt(String(rawPage || "1"), 10);
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
  row.push(kb(`${page}/${totalPages}`, "noop"));
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
