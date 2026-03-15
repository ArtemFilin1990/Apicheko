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
const SECTION_DIVIDER = "──────────────────";

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
      "👋 <b>Проверка контрагента</b>",
      SECTION_DIVIDER,
      "",
      "Отправьте ИНН одним сообщением.",
      "",
      "10 цифр — компания",
      "12 цифр — ИП или физлицо"
    ].join("\n")
  };
}

function buildHelpView() {
  return {
    text: [
      "ℹ️ <b>Как пользоваться</b>",
      SECTION_DIVIDER,
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
    ].join("\n")
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
      reply_markup: buildCompanyKeyboard(id)
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
        reply_markup: buildCompanyKeyboard(id)
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
      reply_markup: buildCompanyKeyboard(id)
    };
  }

  const title = dadataParty.name?.short_with_opf || dadataParty.name?.full_with_opf || "Компания";
  const decisionSignal = getDadataDecisionSignal(dadataParty);
  const subtitle = getDadataSubtitle(dadataParty);
  const founders = ensureArray(dadataParty.founders);
  const founderPreview = founders
    .slice(0, 2)
    .map((item) => item?.name || "")
    .filter(Boolean);
  const phones = formatContactList(dadataParty.phones, 2);
  const emails = formatContactList(dadataParty.emails, 2);

  const lines = [
    `🏢 <b>${escapeHtml(title)}</b>`,
    SECTION_DIVIDER,
    "",
    `🎯 <b>${escapeHtml(decisionSignal)}</b>`,
    subtitle ? `🧭 ${escapeHtml(subtitle)}` : null,
    dadataParty.name?.full_with_opf && dadataParty.name?.full_with_opf !== title ? `<i>${escapeHtml(dadataParty.name.full_with_opf)}</i>` : null,
    "",
    "🪪 <b>Ключевые реквизиты</b>",
    `ИНН  <code>${escapeHtml(String(dadataParty.inn || id))}</code>`,
    `ОГРН  <code>${escapeHtml(String(dadataParty.ogrn || "—"))}</code>`,
    dadataParty.kpp ? `КПП  <code>${escapeHtml(String(dadataParty.kpp))}</code>` : null,
    `Регистрация  ${escapeHtml(formatDateFromMsOrIso(dadataParty.state?.registration_date))}`,
    "",
    "🧩 <b>Профиль</b>",
    dadataParty.okved ? `ОКВЭД  ${escapeHtml(String(dadataParty.okved))}` : null,
    dadataParty.opf?.full ? `Форма  ${escapeHtml(String(dadataParty.opf.full))}` : null,
    dadataParty.branch_count !== undefined ? `Филиалы  ${escapeHtml(String(dadataParty.branch_count))}` : null,
    dadataParty.employee_count !== undefined ? `Сотрудники  ${escapeHtml(String(dadataParty.employee_count))}` : null,
    "",
    "💹 <b>Финансовый контур</b>",
    dadataParty.finance?.income ? `Доход  ${escapeHtml(formatMoney(dadataParty.finance.income))}` : null,
    dadataParty.finance?.expense ? `Расход  ${escapeHtml(formatMoney(dadataParty.finance.expense))}` : null,
    "",
    "👤 <b>Управление</b>",
    dadataParty.management?.name ? `Руководитель  ${escapeHtml(String(dadataParty.management.name))}` : null,
    dadataParty.management?.post ? `Должность  ${escapeHtml(String(dadataParty.management.post))}` : null,
    founderPreview.length > 0 ? `Учредители  ${escapeHtml(founderPreview.join("; "))}` : null,
    founders.length > 2 ? `Ещё учредителей: ${escapeHtml(String(founders.length - 2))}` : null,
    "",
    "📍 <b>Контакты и адрес</b>",
    dadataParty.address?.value ? `${escapeHtml(String(dadataParty.address.value))}` : null,
    phones ? `📞 ${escapeHtml(phones)}` : null,
    emails ? `✉️ ${escapeHtml(emails)}` : null,
    dadataParty.invalid ? "⚠️ Адрес требует проверки" : null
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
  const [finances, legal, fssp, contracts, history, bankruptcy, fedresurs, dadataParty] = await Promise.all([
    safeSectionData(env, "finance", baseParams),
    safeSectionData(env, "legal-cases", { ...baseParams, sort: "-date", limit: 10 }),
    safeSectionData(env, "enforcements", { ...baseParams, sort: "-date", limit: 10 }),
    safeSectionData(env, "contracts", { ...baseParams, law: 44, role: "supplier", sort: "-date", limit: 10 }),
    safeSectionData(env, "timeline", { ...baseParams, sort: "-date", limit: 10 }),
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
    historyData: history,
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
  const years = getYearsSorted(rows).slice(0, 4);
  if (years.length === 0) {
    return { text: `📈 <b>Финансы</b>
${SECTION_DIVIDER}

📊 Финансовая отчётность не найдена`, reply_markup: buildCompanyKeyboard(id) };
  }

  const lines = startSection("📈 <b>Финансы</b>");
  for (const year of years) {
    const item = rows[year] || {};
    lines.push(`\n📆 <b>${year}</b>`);
    lines.push(`💰 Выручка: ${formatMoney(item[2110])}`);
    lines.push(`📊 Чистая прибыль: ${formatMoney(item[2400])}`);
    lines.push(`📦 Активы: ${formatMoney(item[1600])}`);
    lines.push(`🏦 Капитал: ${formatMoney(item[1300])}`);
  }
  const pdfUrl = payload["bo.nalog.ru"]?.Отчет;
  if (pdfUrl) lines.push(`\nОтчётность: ${escapeHtml(String(pdfUrl))}`);

  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
}

async function buildArbitrationView(env, id) {
  const payload = await checkoRequest(env, "legal-cases", { ...identifierParams(id), sort: "-date", limit: 10 });
  const items = takeRecords(payload);
  if (items.length === 0) return { text: `⚖️ <b>Арбитраж</b>
${SECTION_DIVIDER}

Арбитражные дела не найдены`, reply_markup: compactSectionKeyboard(id) };

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

  const taxDebt = toNum(firstExistingTaxValue(taxes, ["СумНедоим"]));
  const taxPenalties = toNum(firstExistingTaxValue(taxes, ["СумПениШтр", "СумШтр"]));
  const debtCharges = toNum(firstExistingTaxValue(taxes, ["СумДоначисл", "СумДолг"]));
  const hasCriticalSignals = items.length > 0 || taxDebt > 0 || taxPenalties > 0 || debtCharges > 0;

  const lines = [...startSection("💳 <b>Долги и взыскания</b>"), ""];
  lines.push(`🎯 <b>${hasCriticalSignals ? "Есть сигналы долговой нагрузки" : "Критичных долговых сигналов не найдено"}</b>`);
  lines.push(`📌 Исполнительных производств: <b>${items.length}</b>`);
  lines.push("");
  if (taxes && typeof taxes === "object") {
    lines.push("🧾 <b>Налоговые риски</b>");
    lines.push(`• Недоимка: ${formatTaxMoneyState(taxes, ["СумНедоим"])}`);
    lines.push(`• Пени и штрафы: ${formatTaxMoneyState(taxes, ["СумПениШтр", "СумШтр"])}`);
    lines.push(`• Доначисления / долг: ${formatTaxMoneyState(taxes, ["СумДоначисл", "СумДолг"])}`);
  } else {
    lines.push("🧾 <b>Налоговые риски</b>");
    lines.push("• Нет данных от ФНС");
  }

  lines.push("");
  lines.push("📋 <b>Исполнительные производства</b>");
  if (items.length === 0) {
    lines.push("• Не найдены");
    return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
  }

  lines.push(`• Всего найдено: <b>${items.length}</b>`);
  items.slice(0, 10).forEach((it) => {
    lines.push(`\n› ${escapeHtml(it.ИспПрНомер || it.НомерИП || it.Номер || "—")}  ${formatDate(it.ИспПрДата || it.ДатаНачала || it.Дата)}`);
    lines.push(`  💳 Сумма: ${formatMoney(it.СумДолг || it.СуммаДолга || it.Сумма)}`);
    lines.push(`  📄 ${escapeHtml(it.ПредмИсп || it.Предмет || "Предмет не указан")}`);
  });
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
}

async function buildContractsView(env, id) {
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

  if (items.length === 0) return { text: `📋 <b>Контракты</b>
${SECTION_DIVIDER}

Контракты не найдены`, reply_markup: compactSectionKeyboard(id) };

  const lines = [...startSection("📋 <b>Госконтракты</b>"), `\nПолучено записей: <b>${items.length}</b>`];
  if (failedCount > 0) {
    lines.push(`⚠️ ${failedCount} из 3 источников временно недоступны`);
  }
  items.slice(0, 10).forEach((it) => {
    const contractNumber = firstNonEmpty([it.НомерКонтракта, it.Номер, it.Ид, it.Идентификатор, it.НомерРеестра]);
    lines.push(`\n› № ${escapeHtml(contractNumber || "б/н")}`);
    lines.push(`  📆 Дата: ${formatDate(it.Дата || it.ДатаЗакл)}`);
    lines.push(`  📄 ${escapeHtml(String(it.Предмет || "Предмет не указан"))}`);
    lines.push(`  💰 Сумма: ${formatMoney(it.Цена || it.СуммаКонтракта)}`);
  });
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
}

async function buildHistoryView(env, id) {
  const payload = await checkoRequest(env, "history", { ...identifierParams(id), limit: 15 });
  const items = ensureArray(payload.data).slice(0, 15);
  if (items.length === 0) return { text: `🗓 <b>История</b>
${SECTION_DIVIDER}

История изменений не найдена`, reply_markup: compactSectionKeyboard(id) };

  const lines = startSection("🗓 <b>Ключевые изменения</b>");
  lines.push("", `🎯 Показано событий: <b>${items.length}</b>`);
  const timeline = items
    .map((it) => ({
      date: it.Дата || it.date,
      summary: formatHistoryEventSummary(it),
      importance: scoreHistoryEventImportance(it)
    }))
    .sort((a, b) => b.importance - a.importance)
    .slice(0, 10)
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  timeline.forEach((it) => lines.push(`• <b>${formatDate(it.date)}</b> — ${escapeHtml(it.summary)}`));
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
}

async function buildConnectionsView(env, id) {
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
      reply_markup: compactSectionKeyboard(id)
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
      reply_markup: compactSectionKeyboard(id)
    };
  }

  const managersCount = affiliated.managers.length;
  const foundersCount = affiliated.founders.length;
  const total = affiliated.total;
  const lines = startSection("🔗 <b>Связи</b>");

  lines.push("", `🎯 <b>${escapeHtml(getAffiliatedDecisionSignal(total, managersCount, foundersCount))}</b>`);
  lines.push(`Сеть: ${escapeHtml(getAffiliatedNetworkLabel(total))}`);
  lines.push("", "🧭 <b>Сводка</b>");
  lines.push(`Через руководителя: <b>${managersCount}</b>`);
  lines.push(`Через учредителя: <b>${foundersCount}</b>`);
  lines.push(`Общий объём сети: <b>${total}</b>`);

  if (total === 0) {
    lines.push("", "Аффилированные компании не найдены");
    return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
  }

  lines.push(...buildAffiliatedGroupLines("Через руководителя", affiliated.managers, AFFILIATED_LIMIT));
  lines.push(...buildAffiliatedGroupLines("Через учредителя", affiliated.founders, AFFILIATED_LIMIT));
  lines.push("", `Итог: ${escapeHtml(getAffiliatedNetworkLabel(total))}`);

  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
}

async function buildFoundersView(env, id) {
  const payload = await checkoRequest(env, "company", identifierParams(id));
  const founders = getCompanyFounders(payload.data || {});
  if (founders.length === 0) return { text: `👥 <b>Учредители</b>
${SECTION_DIVIDER}

Учредители не найдены`, reply_markup: compactSectionKeyboard(id) };

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
  if (branches.length === 0) return { text: `🏬 <b>Филиалы</b>
${SECTION_DIVIDER}

Филиалы не найдены`, reply_markup: compactSectionKeyboard(id) };

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
  if (!primary && additional.length === 0) return { text: `🔖 <b>ОКВЭД</b>
${SECTION_DIVIDER}

Данные по ОКВЭД не найдены`, reply_markup: compactSectionKeyboard(id) };
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
}

async function buildTaxesView(env, id) {
  const payload = await checkoRequest(env, "company", identifierParams(id));
  const taxes = payload.data?.Налоги;
  if (!taxes || typeof taxes !== "object") return { text: `🧾 <b>Налоги</b>
${SECTION_DIVIDER}

Налоговые данные не найдены`, reply_markup: compactSectionKeyboard(id) };

  const lines = [
    ...startSection("🧾 <b>Налоги</b>"),
    "",
    `Итого уплачено: ${formatTaxMoneyState(taxes, ["СумУпл", "СумНалогов"])}`,
    `Недоимка: ${formatTaxMoneyState(taxes, ["СумНедоим"])}`,
    `Пени и штрафы: ${formatTaxMoneyState(taxes, ["СумПениШтр", "СумШтр"])}`
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
  const fedresurs = await safeSectionData(env, "fedresurs-messages", { ...identifierParams(id), limit: 1 });
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

function getDadataSubtitle(partyData) {
  const status = String(partyData?.state?.status || "").trim();
  const actualityDate = formatDateFromMsOrIso(partyData?.state?.actuality_date);
  const parts = [status ? `Статус: ${status}` : "", actualityDate !== "—" ? `Актуальность: ${actualityDate}` : ""]
    .filter(Boolean);
  return parts.join(" · ");
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

  const scopeConfigs = [
    { scope: ["MANAGERS"], group: "managers" },
    { scope: ["FOUNDERS"], group: "founders" }
  ];
  const results = await Promise.allSettled(
    scopeConfigs.map(({ scope }) => findAffiliatedByInn(env, sourceInn, scope))
  );

  const sourceInnNormalized = String(sourceInn || "").trim();
  const seenManagers = new Set([sourceInnNormalized]);
  const seenFounders = new Set([sourceInnNormalized]);
  const seenTotal = new Set();
  const managers = [];
  const founders = [];
  let unavailableCount = 0;

  for (let i = 0; i < scopeConfigs.length; i++) {
    const result = results[i];
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

  if (unavailableCount === scopeConfigs.length) {
    return { managers: [], founders: [], total: 0, state: "unavailable" };
  }

  return { managers, founders, total: seenTotal.size, state: "ok" };
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
