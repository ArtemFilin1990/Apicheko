const DEFAULT_DADATA_API_URL = "https://suggestions.dadata.ru/suggestions/api/4_1/rs";
const DEFAULT_WEBHOOK_PATH = "/webhook";
const COMPANY_NOT_FOUND_MESSAGE = "❌ Компания не найдена";
const SECTION_DIVIDER = "\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015\u2015";
const BLOCK_DIVIDER = "\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7";
const PAGE_SIZE = 5;
const MAX_AFFILIATION_SOURCE_INNS = 5;
const CACHE_TTL_DADATA_PARTY_SECONDS = 12 * 60 * 60;
const CACHE_TTL_AFFILIATED_SECONDS = 24 * 60 * 60;
const CACHE_TTL_EMAIL_SECONDS = 6 * 60 * 60;
const EXTERNAL_FETCH_TIMEOUT_MS = 10000;

const COMPANY_SECTION_TITLES = {
  main: "🏢 Карточка",
  lnk: "🔗 Связи",
  own: "👥 Учредители",
  fin: "📊 Финансы",
  okv: "🏷 ОКВЭД"
};

class DadataServiceError extends Error {
  constructor(message) {
    super(message);
    this.name = "DadataServiceError";
  }
}

class DadataNotFoundError extends Error {
  constructor(message = COMPANY_NOT_FOUND_MESSAGE) {
    super(message);
    this.name = "DadataNotFoundError";
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const webhookPaths = resolveWebhookPaths(env);

    if (request.method === "GET" && url.pathname === "/") {
      return jsonResponse({ ok: true, service: "telegram-dadata-bot", webhookPaths });
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

  if (text === "/start") {
    const view = buildMainMenuView();
    await sendHtmlMessage(env, chatId, view);
    return jsonResponse({ ok: true });
  }

  if (text === "/help") {
    const view = buildHelpView();
    await sendHtmlMessage(env, chatId, view);
    return jsonResponse({ ok: true });
  }

  if (text === "/history") {
    const view = await buildLookupHistoryView(env, chatId);
    await sendHtmlMessage(env, chatId, view);
    return jsonResponse({ ok: true });
  }

  try {
    const view = await buildViewForUserText(env, text);
    await sendHtmlMessage(env, chatId, view);
    await persistViewHistory(env, chatId, view);
  } catch (error) {
    if (error instanceof DadataNotFoundError) {
      await sendMessage(env, { chat_id: chatId, text: COMPANY_NOT_FOUND_MESSAGE });
    } else if (error instanceof DadataServiceError) {
      await sendMessage(env, { chat_id: chatId, text: "⚠️ DaData временно недоступен" });
    } else {
      throw error;
    }
  }

  return jsonResponse({ ok: true });
}

async function handleCallbackQuery(callbackQuery, env) {
  await telegramRequest(env, "answerCallbackQuery", { callback_query_id: callbackQuery.id });

  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  if (!chatId || !messageId) return;

  try {
    env.__cbChatId__ = chatId;
    const view = await buildViewForCallback(env, String(callbackQuery.data || ""));
    if (!view) return;
    await editMessage(env, chatId, messageId, view.text, view.reply_markup);
    await persistViewHistory(env, chatId, view);
  } catch (error) {
    if (error instanceof DadataNotFoundError) {
      await editMessage(env, chatId, messageId, COMPANY_NOT_FOUND_MESSAGE, { inline_keyboard: [[kb("🏠 В меню", "menu")]] });
      return;
    }
    if (error instanceof DadataServiceError) {
      await editMessage(env, chatId, messageId, "⚠️ DaData временно недоступен", { inline_keyboard: [[kb("🏠 В меню", "menu")]] });
      return;
    }
    throw error;
  }
}

async function buildViewForUserText(env, text) {
  const compact = text.replace(/\s+/g, "");
  if (isValidEmail(text)) {
    return buildCompanyByEmailView(env, text);
  }
  if (/^\d{10}$/.test(compact) || /^\d{13}$/.test(compact) || /^\d{10}\/\d{9}$/.test(compact)) {
    return buildCompanyMainView(env, compact);
  }
  return buildUnsupportedLookupView();
}

async function buildViewForCallback(env, data) {
  if (data === "menu") return buildMainMenuView();
  if (data === "help") return buildHelpView();
  if (data === "search:inn") return buildSearchInnView();
  if (data === "search:email") return buildSearchEmailView();
  if (data === "history") return buildLookupHistoryView(env, env.__cbChatId__ || null);

  if (data.startsWith("select:company:")) {
    return buildCompanyMainView(env, data.split(":").pop());
  }

  if (!data.startsWith("co:")) return null;
  const parsed = parseCompanySectionCallback(data);
  if (!parsed || !COMPANY_SECTION_TITLES[parsed.section] || !parsed.id) return null;
  return buildCompanySectionView(env, parsed.section, parsed.id, parsed.page);
}

async function buildCompanySectionView(env, section, id, page = 1) {
  switch (section) {
    case "main":
      return buildCompanyMainView(env, id);
    case "lnk":
      return buildConnectionsView(env, id, page);
    case "own":
      return buildFoundersView(env, id);
    case "fin":
      return buildFinancesView(env, id);
    case "okv":
      return buildOkvedView(env, id);
    default:
      return null;
  }
}

function buildMainMenuView() {
  return {
    text: [
      "🔍 <b>Проверка контрагентов</b>",
      SECTION_DIVIDER,
      "",
      "Отправь в чат один из форматов:",
      "• <code>7707083893</code> — ИНН (10 цифр)",
      "• <code>1027700132195</code> — ОГРН (13 цифр)",
      "• <code>7707083893/773601001</code> — ИНН/КПП",
      "• <code>info@company.ru</code> — корп. email",
      "",
      "📊 Данные ЕГРЮЛ/ЕГРИП через DaData · учредители · финансы · связи · ОКВЭД"
    ].join("\n"),
    reply_markup: buildMainMenuKeyboard()
  };
}

function buildHelpView() {
  return {
    text: [
      "ℹ️ <b>Как пользоваться</b>",
      SECTION_DIVIDER,
      "",
      "<b>Что вводить:</b>",
      "• ИНН (10 цифр) — юрлицо",
      "• ОГРН (13 цифр) — любая организация",
      "• ИНН/КПП — конкретный филиал",
      "• Корпоративный email — найти компанию по почте",
      "",
      "<b>Что возвращает карточка:</b>",
      "🏢 Название · статус · реквизиты",
      "👤 Руководитель · адрес · капитал",
      "👥 Учредители с долями (тариф Максимальный)",
      "📊 Финансы: выручка, доход, расход, долги, штрафы",
      "🔗 Связи: все аффилированные компании · с ролями",
      "🏷 ОКВЭД: основной · дополнительные с названиями",
      "",
      "<b>Команды:</b> /start · /help · /history"
    ].join("\n"),
    reply_markup: buildMainMenuKeyboard()
  };
}

function buildSearchInnView() {
  return {
    text: [
      "🔎 <b>Поиск по ИНН / ОГРН</b>",
      SECTION_DIVIDER,
      "",
      "Отправьте один из форматов:",
      "• 🧾 ИНН компании — 10 цифр",
      "• 🏛 ОГРН — 13 цифр",
      "• 🧩 ИНН/КПП — через слеш",
      "",
      "⚡ После ответа сразу откроется карточка и разделы проверки."
    ].join("\n"),
    reply_markup: { inline_keyboard: [[kb("🏠 В меню", "menu")]] }
  };
}

function buildSearchEmailView() {
  return {
    text: [
      "✉️ <b>Поиск по email</b>",
      SECTION_DIVIDER,
      "",
      "Отправьте корпоративный email, например:",
      "<code>info@company.ru</code>",
      "",
      "📨 Бот найдёт компанию и откроет основную карточку."
    ].join("\n"),
    reply_markup: { inline_keyboard: [[kb("🏠 В меню", "menu")]] }
  };
}

function buildUnsupportedLookupView() {
  return {
    text: [
      "🆔 <b>Поддерживаемые форматы</b>",
      SECTION_DIVIDER,
      "",
      "• ИНН компании (10 цифр)",
      "• ОГРН (13 цифр)",
      "• ИНН/КПП",
      "• корпоративный email"
    ].join("\n"),
    reply_markup: buildMainMenuKeyboard()
  };
}

async function buildCompanyByEmailView(env, email) {
  const company = await findCompanyByEmail(env, email);
  if (!company?.inn) throw new DadataNotFoundError();
  return buildCompanyMainView(env, company.inn);
}

async function buildCompanyMainView(env, query) {
  const party = await findPartyByInnOrOgrn(env, query);
  if (!party) throw new DadataNotFoundError();

  const shortName = firstNonEmpty([party?.name?.short_with_opf, party?.name?.full_with_opf, "Компания"]);
  const fullName = party?.name?.full_with_opf;
  const statusBadge = companyStatusBadge(party?.state?.status);
  const regDate = formatTimestamp(party?.state?.registration_date);
  const revenue = party?.finance?.revenue;
  const invalidNote = party?.invalid ? "  ⚠️ <i>Недостоверные сведения ФНС</i>" : "";

  const lines = [
    `🏢 <b>${escapeHtml(shortName)}</b>${invalidNote}`,
  ];
  if (fullName && fullName !== shortName) {
    lines.push(`<i>${escapeHtml(fullName)}</i>`);
  }
  lines.push(
    SECTION_DIVIDER,
    "",
    `${statusBadge}` + (regDate ? `  ·  зарег. <b>${escapeHtml(regDate)}</b>` : ""),
    "",
    `🪪 <b>ИНН:</b> <code>${escapeHtml(firstNonEmpty([party?.inn, "—"]))}</code>   🏛 <b>ОГРН:</b> <code>${escapeHtml(firstNonEmpty([party?.ogrn, "—"]))}</code>`,
  );
  if (party?.kpp) {
    lines.push(`🧩 <b>КПП:</b> <code>${escapeHtml(party.kpp)}</code>`);
  }
  lines.push(
    "",
    `👤 <b>Руководитель:</b> ${escapeHtml(firstNonEmpty([party?.management?.name, "—"]))}` +
      (party?.management?.post ? `  <i>${escapeHtml(party.management.post)}</i>` : ""),
    `📍 <b>Адрес:</b> ${escapeHtml(firstNonEmpty([party?.address?.value, "—"]))}`,
    "",
    BLOCK_DIVIDER,
    `💼 <b>Капитал:</b> <b>${escapeHtml(formatMoney(party?.capital?.value))}</b>   👥 <b>Сотрудники:</b> <b>${escapeHtml(firstNonEmpty([party?.employee_count != null ? String(party.employee_count) : null, "—"]))}</b>`,
  );
  if (revenue != null) {
    lines.push(`💰 <b>Выручка:</b> <b>${escapeHtml(formatMoney(revenue))}</b>` + (party?.finance?.year ? `  <i>(${party.finance.year})</i>` : ""));
  }
  const okveds = ensureArray(party?.okveds);
  const mainOkved = okveds.find(o => o?.main);
  lines.push(`🏷 <b>ОКВЭД:</b> ${escapeHtml(firstNonEmpty([party?.okved, "—"]))}` + (mainOkved?.name ? `  <i>${escapeHtml(mainOkved.name)}</i>` : ""));
  lines.push("");

  return {
    text: lines.join("\n"),
    reply_markup: buildCompanyKeyboard(buildCompanyContext(party, query))
  };
}

async function buildFoundersView(env, query) {
  const party = await findPartyByInnOrOgrn(env, query);
  if (!party) throw new DadataNotFoundError();
  const id = normalizedCompanyId(party, query);
  const founders = ensureArray(party?.founders);
  const lines = ["👥 <b>Учредители</b>", SECTION_DIVIDER, ""];

  if (!founders.length) {
    lines.push("Учредители не найдены.");
  } else {
    for (const [i, founder] of founders.slice(0, 10).entries()) {
      const fname = escapeHtml(firstNonEmpty([founder?.name, founder?.fio, "—"]));
      const finn = escapeHtml(firstNonEmpty([founder?.inn, "—"]));
      const fshare = escapeHtml(formatShare(founder?.share));
      const ftype = founder?.type === "PHYSICAL" ? "👤" : "🏢";
      lines.push(`${ftype} <b>${fname}</b>`);
      lines.push(`   ИНН: <code>${finn}</code>   Доля: <b>${fshare}</b>`);
      if (i < founders.slice(0, 10).length - 1) lines.push("");
    }
    if (founders.length > 10) lines.push(`<i>…и ещё ${founders.length - 10}</i>`);
  }

  return { text: lines.join("\n"), reply_markup: buildCompanyKeyboard(buildCompanyContext(party, query), "own") };
}

async function buildFinancesView(env, query) {
  const party = await findPartyByInnOrOgrn(env, query);
  if (!party) throw new DadataNotFoundError();
  const id = normalizedCompanyId(party, query);
  const finance = party?.finance || {};
  const tax = party?.finance?.tax_system || party?.tax_system;
  const income = party?.finance?.income || party?.income;
  const expense = party?.finance?.expense || party?.expense;
  const debt = party?.finance?.debt || party?.finance?.tax_debt;
  const penalty = party?.finance?.penalty || party?.finance?.tax_penalty;
  const year = party?.finance?.year || party?.finance?.period;

  const profitVal = (income != null && expense != null) ? (Number(income) - Number(expense)) : null;
  const profitPct = (income && expense && Number(income) > 0)
    ? Math.round((Number(income) - Number(expense)) / Number(income) * 100)
    : null;
  const profitTrend = profitPct != null ? (profitPct >= 0 ? "▲" : "▼") : "";
  const finLines = [
    "📊 <b>Финансы</b>",
    SECTION_DIVIDER,
    "",
    `<b>Период:</b> <b>${escapeHtml(firstNonEmpty([year, "—"]))}</b>`,
    "",
    `📈 <b>Доходы:</b>  <b>${escapeHtml(formatMoney(income))}</b>`,
    `📉 <b>Расходы:</b> <b>${escapeHtml(formatMoney(expense))}</b>`,
  ];
  if (profitVal != null) {
    finLines.push(`${profitPct >= 0 ? "✅" : "🔴"} <b>Прибыль:</b>  <b>${escapeHtml(formatMoney(profitVal))}</b>` + (profitPct != null ? `  <i>${profitTrend} ${Math.abs(profitPct)}%</i>` : ""));
  }
  finLines.push(
    "",
    BLOCK_DIVIDER,
    `🧾 <b>Налог. режим:</b> ${escapeHtml(firstNonEmpty([tax, "—"]))}`,
    `⚠️ <b>Задолженность:</b> <b>${escapeHtml(formatMoney(debt))}</b>`,
    `🔴 <b>Пени и штрафы:</b> <b>${escapeHtml(formatMoney(penalty))}</b>`,
  );
  return {
    text: finLines.join("\n"),
    reply_markup: buildCompanyKeyboard(buildCompanyContext(party, query), "fin")
  };
}

async function buildOkvedView(env, query) {
  const party = await findPartyByInnOrOgrn(env, query);
  if (!party) throw new DadataNotFoundError();
  const id = normalizedCompanyId(party, query);
  const okveds = ensureArray(party?.okveds);
  const mainOkved = okveds.find(o => o?.main);
  const extraOkveds = okveds.filter(o => !o?.main);
  const lines = ["🏷 <b>ОКВЭД</b>", SECTION_DIVIDER, ""];

  lines.push("<b>Основной:</b>");
  if (mainOkved) {
    lines.push(`• <b>${escapeHtml(mainOkved.code || party?.okved || "—")}</b>  <i>${escapeHtml(mainOkved.name || "")}</i>`);
  } else {
    lines.push(`• <b>${escapeHtml(firstNonEmpty([party?.okved, "—"]))}</b>`);
  }

  if (extraOkveds.length) {
    lines.push("", `<b>Дополнительные</b> (${extraOkveds.length}):`);
    for (const item of extraOkveds.slice(0, 15)) {
      const code = escapeHtml(item?.code || "—");
      const name = item?.name ? `  <i>${escapeHtml(item.name)}</i>` : "";
      lines.push(`• ${code}${name}`);
    }
    if (extraOkveds.length > 15) lines.push(`<i>…и ещё ${extraOkveds.length - 15}</i>`);
  }

  return { text: lines.join("\n"), reply_markup: buildCompanyKeyboard(buildCompanyContext(party, query), "okv") };
}

async function buildConnectionsView(env, query, page = 1) {
  const party = await findPartyByInnOrOgrn(env, query);
  if (!party) throw new DadataNotFoundError();
  const id = normalizedCompanyId(party, query);
  const sourceInns = collectAffiliationSourceInns(party).slice(0, MAX_AFFILIATION_SOURCE_INNS);

  if (!sourceInns.length) {
    return {
      text: ["🔗 <b>Связи</b>", SECTION_DIVIDER, "", "У руководителей и учредителей нет ИНН для поиска аффилированности."].join("\n"),
      reply_markup: buildCompanyKeyboard(buildCompanyContext(party, query), "lnk")
    };
  }

  const batches = await Promise.all(sourceInns.map((inn) => findAffiliatedByInn(env, inn)));
  const deduped = dedupeAffiliatedCompanies(batches.flat(), id);
  const totalPages = Math.max(1, Math.ceil(deduped.length / PAGE_SIZE));
  const currentPage = clampPage(page, totalPages);
  const slice = deduped.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const lines = [`🔗 <b>Связи</b>  <i>(${deduped.length})</i>`, SECTION_DIVIDER, ""];
  if (!slice.length) {
    lines.push("Связанные компании не найдены.");
  } else {
    for (const [i, item] of slice.entries()) {
      const roleIcon = item.relations.some(r => r.includes("учредитель")) ? "👥" :
                       item.relations.some(r => r.includes("руковод")) ? "👤" : "🔗";
      const statusIcon = item.status === "Действует" ? "🟢" :
                         item.status === "Ликвидирована" ? "🔴" :
                         item.status === "Банкротство" ? "🔴" : "🟡";
      lines.push(`• <b>${escapeHtml(item.name)}</b>  ${roleIcon}`);
      lines.push(`  <code>${escapeHtml(item.inn)}</code>  ${statusIcon} ${escapeHtml(item.status)}  · <i>${escapeHtml(item.relations.join(", "))}</i>`);
      if (i < slice.length - 1) lines.push("");
    }
  }

  return {
    text: lines.join("\n"),
    reply_markup: buildConnectionsKeyboard(buildCompanyContext(party, query), currentPage, totalPages)
  };
}

async function buildLookupHistoryView(env, chatId) {
  if (!env.COMPANY_CACHE) {
    return {
      text: "🕘 <b>История</b>\n\nИстория пока недоступна без хранилища.\nМожно продолжить через новый поиск.",
      reply_markup: buildMainMenuKeyboard()
    };
  }

  const raw = await env.COMPANY_CACHE.get(`history:chat:${chatId}`, "json");
  const items = ensureArray(raw);
  if (!items.length) {
    return { text: "🕘 <b>История</b>\n\nИстория запросов пока пуста.", reply_markup: buildMainMenuKeyboard() };
  }

  return {
    text: "🕘 <b>История</b>\n\nВыберите последнюю карточку:",
    reply_markup: {
      inline_keyboard: [
        ...items.slice(0, 10).map((item) => [kb(item.title || item.id, `select:company:${item.id}`)]),
        [kb("🏠 В меню", "menu")]
      ]
    }
  };
}

function buildMainMenuKeyboard() {
  return {
    inline_keyboard: [
      [kb("🔎 По ИНН / ОГРН", "search:inn"), kb("✉️ По email", "search:email")],
      [kb("📜 История", "history"), kb("ℹ️ Справка", "help")]
    ]
  };
}

function buildCompanyKeyboard(company, active = "main") {
  const id = normalizedCompanyId(company);
  const rows = [
    [kb(active === "main" ? "✨ Карточка" : "🏢 Карточка", `co:main:${id}`), kb(active === "lnk" ? "✨ Связи" : "🔗 Связи", `co:lnk:${id}`)],
    [kb(active === "own" ? "✨ Учредители" : "👥 Учредители", `co:own:${id}`), kb(active === "okv" ? "✨ ОКВЭД" : "🏷 ОКВЭД", `co:okv:${id}`)]
  ];

  if (companyHasFinance(company)) {
    rows.push([kb(active === "fin" ? "✨ Финансы" : "📊 Финансы", `co:fin:${id}`)]);
  }

  rows.push([{ text: "📜 История в ФНС ↗", url: "https://egrul.nalog.ru/" }]);
  return { inline_keyboard: rows };
}

function buildConnectionsKeyboard(company, page, totalPages) {
  const id = normalizedCompanyId(company);
  const keyboard = [...buildCompanyKeyboard(company, "lnk").inline_keyboard];
  if (totalPages > 1) {
    const pager = [];
    if (page > 1) pager.push(kb("⬅️ Назад", `co:lnk:${id}:p:${page - 1}`));
    pager.push(kb(`${page}/${totalPages}`, "noop"));
    if (page < totalPages) pager.push(kb("➡️ Далее", `co:lnk:${id}:p:${page + 1}`));
    keyboard.splice(companyHasFinance(company) ? 2 : 2, 0, pager);
  }
  return { inline_keyboard: keyboard };
}

async function findCompanyByEmail(env, email) {
  const normalizedEmail = normalizeEmail(email);
  const payload = await withCache(env, `email:${normalizedEmail}`, CACHE_TTL_EMAIL_SECONDS, () =>
    dadataPost(env, "findByEmail/company", { query: normalizedEmail })
  );
  return payload?.suggestions?.[0]?.data?.company || null;
}

async function findPartyByInnOrOgrn(env, query) {
  const normalizedQuery = String(query || "").trim();
  const payload = await withCache(env, `dadata:party:${normalizedQuery}`, CACHE_TTL_DADATA_PARTY_SECONDS, () =>
    dadataPost(env, "findById/party", { query: normalizedQuery })
  );
  return payload?.suggestions?.[0]?.data || null;
}

async function findAffiliatedByInn(env, inn) {
  const payload = await withCache(env, `affiliated:${inn}`, CACHE_TTL_AFFILIATED_SECONDS, () =>
    dadataPost(env, "findAffiliated/party", { query: inn })
  );
  return ensureArray(payload?.suggestions).map((item) => item?.data).filter(Boolean);
}

function collectAffiliationSourceInns(party) {
  const managerInns = ensureArray([party?.management, ...(party?.managers || [])])
    .map((item) => String(item?.inn || "").trim())
    .filter((inn) => /^\d{10,12}$/.test(inn));
  const founderInns = ensureArray(party?.founders)
    .map((item) => String(item?.inn || "").trim())
    .filter((inn) => /^\d{10,12}$/.test(inn));
  return Array.from(new Set([...managerInns, ...founderInns]));
}

function dedupeAffiliatedCompanies(items, companyId) {
  const map = new Map();
  for (const item of items) {
    const inn = String(item?.inn || "").trim();
    if (!inn || inn === String(companyId || "")) continue;
    const existing = map.get(inn);
    const normalized = {
      inn,
      name: firstNonEmpty([item?.name?.short_with_opf, item?.name?.full_with_opf, "Без названия"]),
      status: readablePartyStatus(item?.state?.status),
      relations: inferAffiliationRelations(item)
    };
    if (existing) {
      existing.relations = Array.from(new Set([...existing.relations, ...normalized.relations]));
    } else {
      map.set(inn, normalized);
    }
  }
  return Array.from(map.values()).sort((left, right) => left.name.localeCompare(right.name, "ru"));
}

function inferAffiliationRelations(item) {
  const markers = [
    item?.relation_type,
    item?.scope,
    item?.affiliated_type,
    item?.branch_type,
    item?.type
  ].filter(Boolean).map((value) => String(value).toLowerCase());
  const labels = [];
  if (markers.some((value) => value.includes("found"))) labels.push("учредитель");
  if (markers.some((value) => value.includes("manager") || value.includes("employee"))) labels.push("руководитель");
  if (!labels.length) labels.push("аффилированность");
  return labels;
}

async function dadataPost(env, method, payload) {
  if (!env.DADATA_API_KEY) throw new DadataServiceError("Missing DADATA_API_KEY");
  const baseUrl = (env.DADATA_API_URL || DEFAULT_DADATA_API_URL).replace(/\/$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXTERNAL_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Token ${env.DADATA_API_KEY}`,
        ...(env.DADATA_SECRET_KEY ? { "X-Secret": env.DADATA_SECRET_KEY } : {})
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const raw = await response.text();
    if (!response.ok) throw new DadataServiceError(`HTTP ${response.status}; snippet=${raw.slice(0, 200)}`);

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new DadataServiceError(`Non-JSON response; snippet=${raw.slice(0, 200)}`);
    }

    if (!data || typeof data !== "object") {
      throw new DadataServiceError("Unexpected DaData response shape");
    }
    return data;
  } catch (error) {
    if (error instanceof DadataServiceError) throw error;
    throw new DadataServiceError(String(error?.message || error));
  } finally {
    clearTimeout(timeout);
  }
}

function parseCompanySectionCallback(data) {
  const parts = String(data || "").split(":");
  if (parts.length < 3 || parts[0] !== "co") return null;
  const section = parts[1];
  const id = parts[2];
  let page = 1;
  if (parts[3] === "p" && parts[4]) page = Number(parts[4]) || 1;
  return { section, id, page };
}

async function persistViewHistory(env, chatId, view) {
  if (!env.COMPANY_CACHE?.put) return;
  const firstCallback = view?.reply_markup?.inline_keyboard?.flat()?.find((button) => String(button?.callback_data || "").startsWith("co:main:"));
  if (!firstCallback) return;
  const id = String(firstCallback.callback_data).split(":").pop();
  const title = stripHtml(view.text).split("\n")[0]?.slice(0, 80) || id;
  const key = `history:chat:${chatId}`;
  const current = ensureArray(await env.COMPANY_CACHE.get(key, "json"));
  const next = [{ id, title, timestamp: new Date().toISOString() }, ...current.filter((item) => item?.id !== id)].slice(0, 10);
  await env.COMPANY_CACHE.put(key, JSON.stringify(next));
}

async function withCache(env, key, ttlSeconds, loader) {
  if (!env.COMPANY_CACHE?.get || !env.COMPANY_CACHE?.put) return loader();
  const cached = await env.COMPANY_CACHE.get(key, "json");
  if (cached) return cached;
  const value = await loader();
  await env.COMPANY_CACHE.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds });
  return value;
}

function resolveWebhookPaths(env) {
  return [String(env.WEBHOOK_PATH || DEFAULT_WEBHOOK_PATH).trim() || DEFAULT_WEBHOOK_PATH];
}

function verifyTelegramWebhookSecret(request, env) {
  ensureTelegramSecret(env);
  const actual = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (actual !== env.WEBHOOK_SECRET) {
    throw new Error("Unauthorized: invalid Telegram webhook secret");
  }
}

function ensureTelegramSecret(env) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
  if (!env.WEBHOOK_SECRET) throw new Error("Missing WEBHOOK_SECRET");
}

async function sendHtmlMessage(env, chatId, view) {
  return sendMessage(env, {
    chat_id: chatId,
    text: view.text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: view.reply_markup
  });
}

async function sendMessage(env, body) {
  return telegramRequest(env, "sendMessage", body);
}

async function editMessage(env, chatId, messageId, text, replyMarkup) {
  return telegramRequest(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: replyMarkup
  });
}

async function telegramRequest(env, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return response.json();
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function kb(text, callbackData) {
  return { text, callback_data: callbackData };
}

function firstNonEmpty(values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return String(value);
  }
  return "—";
}

function ensureArray(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function companyStatusBadge(status) {
  const s = String(status || "").toUpperCase();
  if (s === "ACTIVE")       return "🟢 <b>Действует</b>";
  if (s === "LIQUIDATING")  return "🟡 <b>Ликвидируется</b>";
  if (s === "LIQUIDATED")   return "🔴 <b>Ликвидирована</b>";
  if (s === "BANKRUPT")     return "🔴 <b>Банкротство</b>";
  if (s === "REORGANIZING") return "🔄 <b>Реорганизация</b>";
  return "⚪ <b>Неизвестно</b>";
}

function formatTimestamp(ts) {
  if (!ts) return null;
  try {
    const d = new Date(Number(ts));
    if (isNaN(d.getTime())) return null;
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${dd}.${mm}.${yyyy}`;
  } catch {
    return null;
  }
}

function readablePartyStatus(status) {
  const map = {
    ACTIVE: "Действует",
    LIQUIDATING: "Ликвидируется",
    LIQUIDATED: "Ликвидирована",
    BANKRUPT: "Банкротство",
    REORGANIZING: "Реорганизация"
  };
  return map[String(status || "").toUpperCase()] || "—";
}

function formatMoney(value) {
  if (value === undefined || value === null || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return `${new Intl.NumberFormat("ru-RU").format(number)} ₽`;
}

function formatShare(share) {
  if (!share) return "—";
  if (share.value !== undefined && share.type) return `${share.value} ${share.type}`;
  if (share.value !== undefined) return String(share.value);
  return "—";
}

function buildCompanyContext(party, fallback) {
  return {
    inn: normalizedCompanyId(party, fallback),
    finance: party?.finance || null,
    authorized_capital: party?.authorized_capital ?? party?.capital?.value ?? null
  };
}

function companyHasFinance(company) {
  const revenue = company?.finance?.revenue ?? company?.finance?.income ?? null;
  return revenue !== null && revenue !== undefined && revenue !== "" || Boolean(company?.authorized_capital);
}

function normalizedCompanyId(party, fallback) {
  return String(party?.inn || fallback || "").trim();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value || "").trim());
}

function escapeHtml(value) {
  return String(value || "—")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function stripHtml(value) {
  return String(value || "").replace(/<[^>]+>/g, "").trim();
}

function clampPage(page, totalPages) {
  const numeric = Number(page) || 1;
  return Math.min(Math.max(numeric, 1), totalPages);
}
