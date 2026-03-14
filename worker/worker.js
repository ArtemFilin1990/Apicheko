const DEFAULT_CHECKO_API_URL = "https://api.checko.ru/v2";
const DEFAULT_WEBHOOK_PATH = "/webhook";
const COMPANY_NOT_FOUND_MESSAGE = "❌ Компания не найдена";
const CHECKO_SERVICE_ERROR_MESSAGE = "⚠️ Ошибка сервиса Checko";
const SEARCH_MIN_QUERY_LENGTH = 4;

const COMPANY_SECTION_TITLES = {
  main: "🏢 Карточка",
  risk: "⚠️ Проверки / Риски",
  fin: "💰 Финансы",
  arb: "⚖️ Арбитраж",
  fsp: "🛡️ ФССП",
  ctr: "📑 Контракты",
  his: "🕓 История",
  lnk: "🔗 Связи",
  own: "👥 Учредители",
  fil: "🏬 Филиалы",
  okv: "🏭 ОКВЭД",
  tax: "🧾 Налоги"
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
    await sendMessage(env, { chat_id: chatId, text: view.text, parse_mode: "HTML", reply_markup: view.reply_markup });
    return jsonResponse({ ok: true });
  }

  try {
    const view = await buildViewForUserText(env, text);
    await sendMessage(env, { chat_id: chatId, text: view.text, parse_mode: "HTML", reply_markup: view.reply_markup });
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

  if (text.length >= SEARCH_MIN_QUERY_LENGTH) {
    return buildSearchResultsView(env, text);
  }

  return {
    text: "ℹ️ Отправьте ИНН, ОГРН / ОГРНИП, БИК или название компании для поиска.",
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
    text: "👋 Здравствуйте! Это сервис проверки контрагентов и банков.\n\nВыберите тип поиска ниже или отправьте реквизит сообщением.\n\nПоддерживаются:\n• ИНН\n• ОГРН / ОГРНИП\n• БИК",
    reply_markup: {
      inline_keyboard: [
        [kb("🔎 Поиск по ИНН / ОГРН", "search:inn"), kb("🧾 Поиск по названию", "search:name")],
        [kb("🏦 Поиск по БИК", "search:bic")],
        [kb("ℹ️ Помощь", "help")]
      ]
    }
  };
}

function buildHelpView() {
  return {
    text: "ℹ️ <b>Как использовать</b>\n\n1) Отправьте реквизит или название.\n2) Откройте карточку и 12 тематических экранов.\n3) Проверяйте риски, финансы, суды, ФССП, контракты, историю и связи.",
    reply_markup: { inline_keyboard: [[kb("🏠 В меню", "menu")]] }
  };
}

function buildSearchInnView() {
  return {
    text: "🔎 <b>Поиск компании</b>\n\nОтправьте:\n• ИНН компании\n• ОГРН\n• ОГРНИП",
    reply_markup: backMenuKeyboard("menu")
  };
}

function buildSearchNameView() {
  return {
    text: "🧾 <b>Поиск по названию</b>\n\nОтправьте:\n• название компании\n• или ФИО ИП",
    reply_markup: backMenuKeyboard("menu")
  };
}

function buildSearchBicView() {
  return {
    text: "🏦 <b>Поиск банка</b>\n\nОтправьте:\n• БИК банка (9 цифр)",
    reply_markup: backMenuKeyboard("menu")
  };
}

function buildResolve12View(inn) {
  return {
    text: "ИНН из 12 цифр может относиться к:\n\n• ИП\n• физическому лицу\n\nВыберите режим проверки.",
    reply_markup: {
      inline_keyboard: [
        [kb("👔 Проверить как ИП", `resolve12:entrepreneur:${inn}`), kb("👤 Проверить как физлицо", `resolve12:person:${inn}`)],
        [kb("⬅️ Назад", "search:inn")],
        [kb("🏠 В меню", "menu")]
      ]
    }
  };
}

async function buildSearchResultsView(env, query) {
  const payload = await checkoRequest(env, "search", { by: "name", obj: "org", query });
  const items = ensureArray(payload.data).slice(0, 10);
  const lines = ["🧾 <b>Результаты поиска</b>"];
  if (items.length === 0) {
    lines.push("Ничего не найдено.");
    return { text: lines.join("\n"), reply_markup: backMenuKeyboard("search:name") };
  }

  const buttons = items.map((item) => {
    const name = item.НаимСокр || item.НаимПолн || "Без названия";
    const id = String(item.ИНН || item.ОГРН || item.ОГРНИП || "");
    const marker = item.ОГРНИП ? "👔" : "🏢";
    const label = `${marker} ${truncate(name, 30)}${id ? ` · ${id}` : ""}`;
    const callback = item.ОГРНИП ? `select:entrepreneur:${id}` : `select:company:${id}`;
    return [kb(label, callback)];
  });
  buttons.push([kb("⬅️ Назад", "search:name")]);
  buttons.push([kb("🏠 В меню", "menu")]);
  lines.push(`Запрос: ${escapeHtml(query)}`);
  lines.push(`Найдено: ${items.length}`);
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: buttons } };
}

async function buildCompanyMainView(env, id) {
  const payload = await checkoRequest(env, "company", identifierParams(id));
  const data = payload.data || {};
  if (!hasIdentity(data)) throw new CheckoNotFoundError();
  const criticalRisk = await detectCriticalRisk(env, id, data);

  const title = data.НаимСокр || data.НаимПолн || "Компания";
  const okved = data.ОКВЭД ? `${data.ОКВЭД.Код || "—"} ${data.ОКВЭД.Наим || ""}`.trim() : "—";
  const contacts = data.Контакты || {};
  const director = data.Руковод?.[0]?.ФИО || "—";
  const founder = data.Учред?.[0]?.ФИО || data.Учред?.[0]?.Наим || "—";
  const branchCount = ensureArray(data.Филиалы || data.ОбособПодр || data.Фил).length;
  const taxes = data.Налоги || {};

  const risk = buildRiskLevel({ taxDebt: toNum(taxes.СумНедоим), legalCount: 0, fsspCount: 0 });

  const lines = [
    `🏢 <b>${escapeHtml(title)}</b>`,
    criticalRisk ? `\n🔴 <b>КРИТИЧЕСКИЙ РИСК</b>\n${escapeHtml(criticalRisk)}` : null,
    data.НаимПолн && data.НаимПолн !== title ? `Полное: ${escapeHtml(data.НаимПолн)}` : null,
    `ОГРН: <code>${escapeHtml(String(data.ОГРН || "—"))}</code>`,
    `ИНН: <code>${escapeHtml(String(data.ИНН || id))}</code>`,
    `КПП: ${escapeHtml(String(data.КПП || "—"))}`,
    `Статус: <b>${escapeHtml(String(data.Статус?.Наим || "—"))}</b>`,
    `Дата регистрации: ${escapeHtml(formatDate(data.ДатаРег))}`,
    `ОКВЭД: ${escapeHtml(okved)}`,
    `Адрес: ${escapeHtml(String(data.ЮрАдрес?.АдресРФ || "—"))}`,
    `Руководитель: ${escapeHtml(director)}`,
    contacts.Тел ? `Телефон: ${escapeHtml(valueAsText(contacts.Тел))}` : null,
    contacts.Емэйл ? `Email: ${escapeHtml(valueAsText(contacts.Емэйл))}` : null,
    data.УстКап?.Сумма ? `Уставный капитал: ${escapeHtml(formatMoney(data.УстКап.Сумма))}` : null,
    data.РМСП?.Кат ? `Категория МСП: ${escapeHtml(String(data.РМСП.Кат))}` : null,
    `Учредитель (текущий): ${escapeHtml(founder)}`,
    `Филиалы: ${branchCount}`,
    "",
    "⚠️ <b>Краткая оценка</b>",
    `${risk.icon} Уровень риска: <b>${risk.label}</b>`,
    `Налоговая задолженность: ${escapeHtml(formatMoney(taxes.СумНедоим))}`,
    `Пени/штрафы: ${escapeHtml(formatMoney(taxes.СумПениШтр || taxes.СумШтр || 0))}`
  ].filter(Boolean);

  return { text: lines.join("\n"), reply_markup: buildCompanyKeyboard(id) };
}

async function buildCompanySectionView(env, section, id) {
  if (section === "main") return buildCompanyMainView(env, id);
  if (section === "risk") return buildRiskView(env, id);
  if (section === "fin") return buildFinancesView(env, id);
  if (section === "arb") return buildArbitrationView(env, id);
  if (section === "fsp") return buildFsspView(env, id);
  if (section === "ctr") return buildContractsView(env, id);
  if (section === "his") return buildHistoryView(env, id);
  if (section === "lnk") return buildConnectionsView(env, id);
  if (section === "own") return buildFoundersView(env, id);
  if (section === "fil") return buildBranchesView(env, id);
  if (section === "okv") return buildOkvedView(env, id);
  if (section === "tax") return buildTaxesView(env, id);
  return null;
}

async function buildRiskView(env, id) {
  const company = await checkoRequest(env, "company", identifierParams(id));
  const data = company.data || {};
  const legal = await safeSectionData(env, "legal-cases", { ...identifierParams(id), sort: "-date", limit: 10 });
  const fssp = await safeSectionData(env, "enforcements", { ...identifierParams(id), sort: "-date", limit: 10 });

  const taxes = data.Налоги || {};
  const branchCount = ensureArray(data.Филиалы || data.ОбособПодр || data.Фил).length;
  const risk = buildRiskLevel({ taxDebt: toNum(taxes.СумНедоим), legalCount: takeRecords(legal).length, fsspCount: takeRecords(fssp).length });
  const criticalRisk = await detectCriticalRisk(env, id, data);

  const positives = [];
  if (data.РМСП?.Кат) positives.push(`• Статус МСП: ${data.РМСП.Кат}`);
  if (!toNum(taxes.СумНедоим)) positives.push("• Налоговая недоимка не выявлена");

  const risks = [
    `• Налоговая задолженность: ${formatMoney(taxes.СумНедоим)}`,
    `• Пени / штрафы: ${formatMoney(taxes.СумПениШтр || taxes.СумШтр || 0)}`,
    `• ФССП: ${takeRecords(fssp).length}`,
    `• Арбитраж: ${takeRecords(legal).length}`,
    `• Массовый адрес: ${data.ЮрАдрес?.Массовый ? "да" : "нет данных"}`
  ];

  const hasRiskSignals = Boolean(criticalRisk) || toNum(taxes.СумНедоим) > 0 || takeRecords(fssp).length > 0 || takeRecords(legal).length > 0 || Boolean(data.ЮрАдрес?.Массовый);
  if (!hasRiskSignals) {
    return {
      text: "⚠️ <b>Проверки и факторы риска</b>\n\n✅ Критических факторов риска не найдено",
      reply_markup: compactSectionKeyboard(id)
    };
  }

  const text = [
    "⚠️ <b>Проверки и факторы риска</b>",
    criticalRisk ? `\n🔴 <b>КРИТИЧЕСКИЙ РИСК</b>\n${escapeHtml(criticalRisk)}` : null,
    `${risk.icon} Общий риск: <b>${risk.label}</b>`,
    "",
    "Позитивные факторы:",
    ...(positives.length ? positives : ["• Не выявлены"]),
    "",
    "Факторы риска:",
    ...risks,
    `• Филиалы: ${branchCount}`,
    `• Сотрудники: ${escapeHtml(String(data.ЧислСотр || "нет данных"))}`
  ].filter(Boolean).join("\n");
  return { text, reply_markup: compactSectionKeyboard(id) };
}

async function buildFinancesView(env, id) {
  const payload = await checkoRequest(env, "finances", identifierParams(id));
  const rows = payload.data || {};
  const years = Object.keys(rows).filter((y) => /^\d{4}$/.test(y)).sort((a, b) => Number(b) - Number(a)).slice(0, 4);
  if (years.length === 0) {
    return { text: "💰 <b>Финансы</b>\n\n📊 Финансовая отчетность не найдена", reply_markup: buildCompanyKeyboard(id) };
  }

  const lines = ["💰 <b>Финансы</b>"];
  for (const year of years) {
    const item = rows[year] || {};
    lines.push(`📅 ${year}`);
    lines.push(`• 💰 Выручка: ${formatMoney(item[2110])}`);
    lines.push(`• 📈 Чистая прибыль: ${formatMoney(item[2400])}`);
    lines.push(`• 🧱 Активы: ${formatMoney(item[1600])}`);
    lines.push(`• 🏦 Капитал: ${formatMoney(item[1300])}`);
    lines.push("");
  }
  const pdfUrl = payload["bo.nalog.ru"]?.Отчет;
  if (pdfUrl) lines.push(`Отчетность: ${escapeHtml(String(pdfUrl))}`);

  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
}

async function buildArbitrationView(env, id) {
  const payload = await checkoRequest(env, "legal-cases", { ...identifierParams(id), sort: "-date", limit: 10 });
  const items = takeRecords(payload);
  if (items.length === 0) return { text: "⚖️ Арбитражные дела не найдены", reply_markup: compactSectionKeyboard(id) };

  const lines = ["⚖️ <b>Арбитражные дела</b>", `\nНайдено: ${items.length}`];
  items.slice(0, 10).forEach((it, idx) => {
    lines.push(`\n• ${it.НомерДела || it.Номер || "Без номера"} — ${formatDate(it.Дата)}`);
    lines.push(`  Суд: ${it.Суд || "—"}`);
    lines.push(`  Роль: ${it.Роль || "—"}`);
    lines.push(`  Сумма: ${formatMoney(it.СуммаТреб || it.Сумма)}`);
  });
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
}

async function buildFsspView(env, id) {
  const payload = await checkoRequest(env, "enforcements", { ...identifierParams(id), sort: "-date", limit: 10 });
  const items = takeRecords(payload);
  if (items.length === 0) return { text: "🛡️ Исполнительные производства не найдены", reply_markup: compactSectionKeyboard(id) };

  const lines = ["🛡️ <b>Исполнительные производства</b>", `\nНайдено: ${items.length}`];
  items.slice(0, 10).forEach((it, idx) => {
    lines.push(`\n• ${it.ИспПрНомер || it.НомерИП || it.Номер || "—"}`);
    lines.push(`  Дата: ${formatDate(it.ИспПрДата || it.ДатаНачала || it.Дата)}`);
    lines.push(`  Долг: ${formatMoney(it.СумДолг || it.СуммаДолга || it.Сумма)}`);
    lines.push(`  Остаток: ${formatMoney(it.ОстЗадолж || it.ОстатокДолга || 0)}`);
    lines.push(`  Предмет: ${it.ПредмИсп || it.Предмет || "без предмета"}`);
  });
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
}

async function buildContractsView(env, id) {
  const payload = await checkoRequest(env, "contracts", { ...identifierParams(id), law: 44, role: "supplier", sort: "-date", limit: 10 });
  const items = takeRecords(payload);
  if (items.length === 0) return { text: "📑 Контракты не найдены", reply_markup: compactSectionKeyboard(id) };

  const lines = ["📑 <b>Госконтракты и закупки</b>", `\nНайдено: ${items.length}`];
  items.slice(0, 10).forEach((it, idx) => {
    lines.push(`\n• ${it.НомерКонтракта || it.Номер || "—"}`);
    lines.push(`  Дата: ${formatDate(it.Дата || it.ДатаЗакл)}`);
    lines.push(`  Предмет: ${it.Предмет || "без предмета"}`);
    lines.push(`  Сумма: ${formatMoney(it.Цена || it.СуммаКонтракта)}`);
  });
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
}

async function buildHistoryView(env, id) {
  const payload = await checkoRequest(env, "timeline", { ...identifierParams(id), limit: 15 });
  const items = ensureArray(payload.data).slice(0, 15);
  if (items.length === 0) return { text: "🕓 История изменений не найдена", reply_markup: compactSectionKeyboard(id) };

  const lines = ["🕓 <b>История изменений</b>"];
  items.forEach((it, idx) => lines.push(`${idx + 1}. ${formatDate(it.Дата || it.date)} — ${it.Описание || it.Наим || it.event || "Событие"}`));
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
}

async function buildConnectionsView(env, id) {
  const company = await checkoRequest(env, "company", identifierParams(id));
  const data = company.data || {};
  const hasConnections = Boolean(data.Руковод?.[0]?.ФИО) || ensureArray(data.Учред).length > 0 || Boolean(data.ЮрАдрес?.АдресРФ) || Boolean(data.Контакты?.Тел) || Boolean(data.Контакты?.Емэйл);
  if (!hasConnections) return { text: "🔗 Связи не найдены", reply_markup: compactSectionKeyboard(id) };
  const lines = [
    "🔗 <b>Связи</b>",
    `Связи по руководителю: ${escapeHtml(String(data.Руковод?.[0]?.ФИО || "нет данных"))}`,
    `Связи по учредителям: ${ensureArray(data.Учред).map((f) => f.ФИО || f.Наим).filter(Boolean).slice(0, 5).join(", ") || "нет данных"}`,
    `Связи по адресу: ${escapeHtml(String(data.ЮрАдрес?.АдресРФ || "нет данных"))}`,
    `Связи по телефону: ${escapeHtml(valueAsText(data.Контакты?.Тел || "нет данных"))}`,
    `Связи по email: ${escapeHtml(valueAsText(data.Контакты?.Емэйл || "нет данных"))}`
  ];
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
}

async function buildFoundersView(env, id) {
  const payload = await checkoRequest(env, "company", identifierParams(id));
  const founders = ensureArray(payload.data?.Учред);
  if (founders.length === 0) return { text: "👥 Учредители не найдены", reply_markup: compactSectionKeyboard(id) };

  const lines = ["👥 <b>Учредители</b>"];
  founders.forEach((f, idx) => lines.push(`${idx + 1}. ${f.ФИО || f.Наим || "—"} · доля ${f.Доля?.Проц || f.ДоляПроц || "—"}% · сумма ${formatMoney(f.Доля?.Сумма || f.ДоляСумма || 0)}`));
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
}

async function buildBranchesView(env, id) {
  const payload = await checkoRequest(env, "company", identifierParams(id));
  const branches = ensureArray(payload.data?.Филиалы || payload.data?.ОбособПодр || payload.data?.Фил);
  if (branches.length === 0) return { text: "🏬 Филиалы не найдены", reply_markup: compactSectionKeyboard(id) };

  const lines = ["🏬 <b>Филиалы</b>", `Количество филиалов: ${branches.length}`];
  branches.slice(0, 20).forEach((b, idx) => lines.push(`${idx + 1}. КПП ${b.КПП || "—"} · ${b.Адрес || b.АдресРФ || "—"}`));
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
}

async function buildOkvedView(env, id) {
  const payload = await checkoRequest(env, "company", identifierParams(id));
  const data = payload.data || {};
  const primary = data.ОКВЭД;
  const additional = ensureArray(data.ОКВЭДДоп || data.ДопОКВЭД);
  const lines = ["🏭 <b>ОКВЭД</b>"];
  lines.push(`Основной: ${primary?.Код || "—"} ${primary?.Наим || ""}`.trim());
  if (additional.length === 0) lines.push("Дополнительные: нет данных");
  else additional.slice(0, 20).forEach((o) => lines.push(`• ${o.Код || "—"} ${o.Наим || ""}`.trim()));
  if (!primary && additional.length === 0) return { text: "🏭 Данные по ОКВЭД не найдены", reply_markup: compactSectionKeyboard(id) };
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
}

async function buildTaxesView(env, id) {
  const payload = await checkoRequest(env, "company", identifierParams(id));
  const taxes = payload.data?.Налоги;
  if (!taxes || typeof taxes !== "object") return { text: "🧾 Налоговые данные не найдены", reply_markup: compactSectionKeyboard(id) };

  const lines = [
    "🧾 <b>Налоги</b>",
    `Всего налогов: ${formatMoney(taxes.СумУпл || taxes.СумНалогов || 0)}`,
    `Недоимка: ${formatMoney(taxes.СумНедоим || 0)}`,
    `Пени/штрафы: ${formatMoney(taxes.СумПениШтр || taxes.СумШтр || 0)}`
  ];
  if (taxes.ПоГодам && typeof taxes.ПоГодам === "object") {
    Object.keys(taxes.ПоГодам).sort().forEach((year) => lines.push(`${year}: ${formatMoney(taxes.ПоГодам[year])}`));
  }
  return { text: lines.join("\n"), reply_markup: compactSectionKeyboard(id) };
}

async function buildEntrepreneurView(env, id) {
  const payload = await checkoRequest(env, "entrepreneur", identifierParams(id));
  const data = payload.data || {};
  if (!hasIdentity(data)) throw new CheckoNotFoundError("👔 ИП не найден");

  const lines = [
    "👔 <b>Карточка предпринимателя</b>",
    `ФИО: ${escapeHtml(String(data.ФИО || "—"))}`,
    `ИНН: <code>${escapeHtml(String(data.ИНН || id))}</code>`,
    `ОГРНИП: <code>${escapeHtml(String(data.ОГРНИП || "—"))}</code>`,
    `Статус: ${escapeHtml(String(data.Статус?.Наим || "—"))}`,
    `Дата регистрации: ${escapeHtml(formatDate(data.ДатаРег))}`,
    `ОКВЭД: ${escapeHtml(`${data.ОКВЭД?.Код || "—"} ${data.ОКВЭД?.Наим || ""}`.trim())}`,
    `Риск-маркеры: ${escapeHtml(String(data.Риски?.Уровень || "нет данных"))}`
  ];
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: [[kb("⚠️ Проверки", `ep:risk:${id}`), kb("🕓 История", `ep:his:${id}`)], [kb("🔗 Связи", `ep:lnk:${id}`)], [kb("🏠 В меню", "menu")]] } };
}

async function buildPersonView(env, id) {
  const payload = await checkoRequest(env, "person", { inn: id });
  const data = payload.data || {};
  if (!hasIdentity(data)) throw new CheckoNotFoundError("👤 Физлицо не найдено");

  const directors = ensureArray(data.Руковод);
  const founders = ensureArray(data.Учред);
  const ents = ensureArray(data.ИП);
  const lines = [
    "👤 <b>Карточка физлица</b>",
    `ФИО: ${escapeHtml(String(data.ФИО || "—"))}`,
    `ИНН: <code>${escapeHtml(String(data.ИНН || id))}</code>`,
    `Организации (руководитель): ${directors.length || 0}`,
    `Организации (учредитель): ${founders.length || 0}`,
    `Записи ИП: ${ents.length || 0}`
  ];
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: [[kb("🏠 В меню", "menu")]] } };
}

async function buildBankView(env, bic) {
  const payload = await checkoRequest(env, "bank", { bic });
  const data = payload.data || {};
  if (!Object.keys(data).length) throw new CheckoNotFoundError("🏦 Банк не найден");

  const lines = [
    "🏦 <b>Банк</b>",
    `БИК: <code>${escapeHtml(String(data.БИК || bic))}</code>`,
    `Наименование: ${escapeHtml(String(data.Наим || data.Наименование || "—"))}`,
    `Наименование (англ.): ${escapeHtml(String(data.НаимАнгл || "—"))}`,
    `Адрес: ${escapeHtml(String(data.Адрес || "—"))}`,
    `Тип организации: ${escapeHtml(String(data.Тип || "—"))}`,
    `Корр. счет: ${escapeHtml(String(data.КорСчет || data.КоррСчет || "—"))}`
  ];
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: [[kb("🏠 В меню", "menu")]] } };
}

async function safeSectionData(env, endpoint, params) {
  try {
    return await checkoRequest(env, endpoint, params);
  } catch {
    return { data: [] };
  }
}

function buildCompanyKeyboard(id) {
  return {
    inline_keyboard: [
      [kb("⚠️ Проверки", `co:risk:${id}`), kb("💰 Финансы", `co:fin:${id}`)],
      [kb("⚖️ Арбитраж", `co:arb:${id}`), kb("🛡️ ФССП", `co:fsp:${id}`)],
      [kb("📑 Контракты", `co:ctr:${id}`), kb("🕓 История", `co:his:${id}`)],
      [kb("🔗 Связи", `co:lnk:${id}`), kb("👥 Учредители", `co:own:${id}`)],
      [kb("🏬 Филиалы", `co:fil:${id}`), kb("🏭 ОКВЭД", `co:okv:${id}`)],
      [kb("🧾 Налоги", `co:tax:${id}`)],
      [kb("🏢 Карточка", `co:main:${id}`)],
      [kb("🏠 В меню", "menu")]
    ]
  };
}

function compactSectionKeyboard(id) {
  return {
    inline_keyboard: [[kb("🏢 Карточка", `co:main:${id}`)], [kb("🏠 В меню", "menu")]]
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
    const payload = await checkoRequest(env, "timeline", { ...identifierParams(id), limit: 15 });
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
  if (/ликвидац/i.test(String(companyData.Статус?.Наим || ""))) {
    return "Компания находится в процессе ликвидации";
  }
  if (companyData.Ликвид?.Дата || /ликвидирован/i.test(String(companyData.Статус?.Наим || ""))) {
    return "Компания ликвидирована";
  }

  const bankruptcy = await safeSectionData(env, "bankruptcy-messages", { ...identifierParams(id), limit: 1 });
  const fedresurs = await safeSectionData(env, "fedresurs", { ...identifierParams(id), limit: 1 });
  if (takeRecords(bankruptcy).length > 0 || takeRecords(fedresurs).length > 0) {
    return "Есть сообщения о банкротстве / ЕФРСБ";
  }

  return null;
}

function backMenuKeyboard(backCallback) {
  return {
    inline_keyboard: [[kb("⬅️ Назад", backCallback)], [kb("🏠 В меню", "menu")]]
  };
}

async function checkoRequest(env, endpoint, params = {}) {
  if (!env.CHECKO_API_KEY) throw new CheckoServiceError("Missing CHECKO_API_KEY");

  const baseUrl = (env.CHECKO_API_URL || DEFAULT_CHECKO_API_URL).replace(/\/$/, "");
  const url = new URL(`${baseUrl}/${endpoint}`);
  url.searchParams.set("key", env.CHECKO_API_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const response = await fetch(url.toString(), { method: "GET" });
  const raw = await response.text();
  if (response.status !== 200) {
    logCheckoFailure(endpoint, response.status, raw, null);
    throw new CheckoServiceError(`HTTP ${response.status}`);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    logCheckoFailure(endpoint, response.status, raw, null);
    throw new CheckoServiceError("Non-JSON response");
  }

  const meta = payload.meta || null;
  const status = String(meta?.status || "ok").toLowerCase();
  if (status === "error") {
    logCheckoFailure(endpoint, response.status, raw, meta);
    throw new CheckoServiceError(`meta.status=error (${meta?.message || ""})`);
  }

  return payload;
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
