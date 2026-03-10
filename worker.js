const DEFAULT_CHECKO_API_URL = 'https://api.checko.ru/v2';
const PAGE_SIZE = 5;
const SESSION_TTL_SECONDS = 60 * 60 * 6;

const CMD = {
  FIN: 'fin',
  CRT: 'crt',
  GOV: 'gov',
  INS: 'ins',
  FSP: 'fsp',
  BNK: 'bnk',
  LOG: 'log',
  IP: 'ip',
  PRS: 'prs',
  BAK: 'bak',
  MAIN: 'main',
  NEW: 'new',
  NOOP: 'noop',
};

const SECTION_TITLES = {
  [CMD.FIN]: '📊 Финансы',
  [CMD.CRT]: '⚖️ Арбитраж',
  [CMD.GOV]: '🏛 Госзакупки',
  [CMD.INS]: '🚨 Проверки',
  [CMD.FSP]: '🛑 ФССП',
  [CMD.BNK]: '📉 Банкротство',
  [CMD.LOG]: '📜 История',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return json({ ok: true, service: 'apicheko-worker', runtime: 'cloudflare-worker' });
    }

    if (request.method === 'POST' && url.pathname === '/') {
      if (!isWebhookSecretValid(request, env)) {
        return new Response('Unauthorized', { status: 401 });
      }

      try {
        const update = await request.json();
        await processUpdate(update, env);
        return json({ ok: true });
      } catch (error) {
        return json({ ok: false, error: String(error.message || error) }, 400);
      }
    }

    return new Response('Not found', { status: 404 });
  },
};

async function processUpdate(update, env) {
  if (update.callback_query) {
    await handleCallback(update.callback_query, env);
    return;
  }

  const message = update.message;
  if (!message || typeof message.text !== 'string') {
    return;
  }

  const chatId = message.chat?.id;
  if (!chatId) {
    return;
  }

  const text = message.text.trim();
  if (text === '/start') {
    await sendMessage(env, {
      chat_id: chatId,
      text: '👋 Отправьте ИНН, ОГРН, ОГРНИП или БИК для проверки контрагента.',
    });
    return;
  }

  if (text === '/help') {
    await sendMessage(env, {
      chat_id: chatId,
      text: 'Поддерживаются: 10 цифр ИНН юрлица, 12 цифр ИНН ИП/физлица, 13 цифр ОГРН, 15 цифр ОГРНИП, 9 цифр БИК.',
    });
    return;
  }

  if (/^\d{12}$/.test(text)) {
    await sendMessage(env, {
      chat_id: chatId,
      text: 'Выберите режим проверки для 12-значного ИНН:',
      reply_markup: {
        inline_keyboard: [
          [kb('🧑 ИП', cb(CMD.IP, text, 1)), kb('👤 Физлицо', cb(CMD.PRS, text, 1))],
        ],
      },
    });
    return;
  }

  const parsed = parseIdentifier(text);
  if (!parsed) {
    await sendMessage(env, { chat_id: chatId, text: 'Введите ИНН, ОГРН, ОГРНИП или БИК.' });
    return;
  }

  const view = await buildEntryView(env, parsed, chatId);
  await sendMessage(env, {
    chat_id: chatId,
    text: view.text,
    parse_mode: 'HTML',
    reply_markup: view.reply_markup,
  });
}

function parseIdentifier(text) {
  if (/^\d{10}$/.test(text)) {
    return { type: 'company', id: text, params: { inn: text } };
  }
  if (/^\d{13}$/.test(text)) {
    return { type: 'company', id: text, params: { ogrn: text } };
  }
  if (/^\d{15}$/.test(text)) {
    return { type: 'entrepreneur', id: text, params: { ogrnip: text } };
  }
  if (/^\d{9}$/.test(text)) {
    return { type: 'bank', id: text, params: { bic: text } };
  }
  return null;
}

async function buildEntryView(env, parsed, chatId) {
  if (parsed.type === 'bank') {
    const bankPayload = await checkoRequest(env, 'bank', parsed.params);
    return { text: renderBankCard(bankPayload), reply_markup: searchAgainKeyboard() };
  }

  if (parsed.type === 'entrepreneur') {
    const payload = await checkoRequest(env, 'entrepreneur', parsed.params);
    return { text: renderEntrepreneurCard(payload), reply_markup: ipPersonBackKeyboard(parsed.id) };
  }

  const payload = await checkoRequest(env, 'company', parsed.params);
  const counts = await collectMainCounts(env, parsed.id, parsed.params);
  return {
    text: renderCompanyCard(payload),
    reply_markup: buildMainKeyboard(parsed.id, counts, chatId),
  };
}

async function handleCallback(callbackQuery, env) {
  const message = callbackQuery.message;
  const chatId = message?.chat?.id;
  const messageId = message?.message_id;
  if (!chatId || !messageId) {
    return;
  }

  await telegram(env, 'answerCallbackQuery', { callback_query_id: callbackQuery.id });

  const [cmd, id, pageRaw, extraRaw] = String(callbackQuery.data || '').split(':');
  if (cmd === CMD.NOOP) {
    return;
  }

  if (cmd === CMD.NEW) {
    await safeEditMessage(env, chatId, messageId, 'Введите новый ИНН, ОГРН, ОГРНИП или БИК.', searchAgainKeyboard());
    return;
  }

  const page = Number.parseInt(pageRaw || '1', 10);
  const safePage = Number.isFinite(page) && page > 0 ? page : 1;

  try {
    if (cmd === CMD.MAIN) {
      const parsed = parseIdentifier(id);
      if (!parsed || parsed.type !== 'company') {
        return;
      }
      const payload = await checkoRequest(env, 'company', parsed.params);
      const counts = await collectMainCounts(env, id, parsed.params);
      await safeEditMessage(env, chatId, messageId, renderCompanyCard(payload), buildMainKeyboard(id, counts, chatId));
      return;
    }

    if (cmd === CMD.IP) {
      const payload = await checkoRequest(env, 'entrepreneur', { inn: id });
      await safeEditMessage(env, chatId, messageId, renderEntrepreneurCard(payload), ipPersonBackKeyboard(id));
      return;
    }

    if (cmd === CMD.PRS) {
      const payload = await checkoRequest(env, 'person', { inn: id });
      await safeEditMessage(env, chatId, messageId, renderPersonCard(payload), ipPersonBackKeyboard(id));
      return;
    }

    if (cmd === CMD.BAK) {
      const payload = await checkoRequest(env, 'bank', { bic: id });
      await safeEditMessage(env, chatId, messageId, renderBankCard(payload), searchAgainKeyboard());
      return;
    }

    if (cmd === CMD.CRT && !extraRaw) {
      await safeEditMessage(env, chatId, messageId, '<b>⚖️ Арбитраж</b>\n\nВыберите роль:', arbitrationRoleKeyboard(id));
      return;
    }

    if (cmd === CMD.GOV && !extraRaw) {
      await safeEditMessage(env, chatId, messageId, '<b>🏛 Госзакупки</b>\n\nВыберите тип выборки:', govRoleKeyboard(id));
      return;
    }

    const view = await buildSectionPageView(env, { cmd, id, page: safePage, extra: extraRaw || '' }, chatId, messageId);
    await safeEditMessage(env, chatId, messageId, view.text, view.reply_markup);
  } catch (error) {
    await safeEditMessage(
      env,
      chatId,
      messageId,
      `⚠️ <b>Ошибка</b>\n\n${escapeHtml(String(error.message || error))}`,
      searchAgainKeyboard(),
    );
  }
}

async function buildSectionPageView(env, sectionRef, chatId, messageId) {
  const records = await ensureSectionRecords(env, sectionRef, chatId, messageId);
  const totalPages = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, sectionRef.page), totalPages);
  const chunk = records.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const text = renderSection(sectionRef.cmd, chunk, {
    total: records.length,
    page,
    totalPages,
    extra: sectionRef.extra,
  });

  return {
    text,
    reply_markup: paginationKeyboard(sectionRef, page, totalPages),
  };
}

async function ensureSectionRecords(env, sectionRef, chatId, messageId) {
  const key = buildSessionKey(chatId, messageId, sectionRef.cmd, sectionRef.id, sectionRef.extra);
  const cached = await kvGetJson(env, key);
  if (cached && Array.isArray(cached.records)) {
    return cached.records;
  }

  const records = await fetchSectionRecords(env, sectionRef);
  await kvPutJson(env, key, { records, updated_at: Date.now() }, SESSION_TTL_SECONDS);
  return records;
}

async function fetchSectionRecords(env, sectionRef) {
  const idParams = inferIdParams(sectionRef.id);
  if (!idParams) {
    throw new Error('Неверный идентификатор.');
  }

  if (sectionRef.cmd === CMD.FIN) {
    const payload = await checkoRequest(env, 'finances', { ...idParams, limit: 100 });
    const data = takeData(payload);
    return Array.isArray(data) ? data : toArrayByKeys(data, ['Отчеты', 'reports', 'Записи']);
  }

  if (sectionRef.cmd === CMD.CRT) {
    const role = sectionRef.extra === 'd' ? 'defendant' : 'plaintiff';
    const payload = await checkoRequest(env, 'legal-cases', {
      ...idParams,
      role,
      actual: true,
      sort: '-date',
      limit: 100,
    });
    return toArrayByKeys(takeData(payload), ['Записи', 'Дела', 'cases']);
  }

  if (sectionRef.cmd === CMD.GOV) {
    const [law, role] = parseGovExtra(sectionRef.extra);
    const payload = await checkoRequest(env, 'contracts', { ...idParams, law, role, limit: 100 });
    return toArrayByKeys(takeData(payload), ['Записи', 'Контракты', 'items']);
  }

  if (sectionRef.cmd === CMD.INS) {
    const payload = await checkoRequest(env, 'inspections', { ...idParams, limit: 100 });
    return toArrayByKeys(takeData(payload), ['Записи', 'Проверки', 'items']);
  }

  if (sectionRef.cmd === CMD.FSP) {
    const payload = await checkoRequest(env, 'enforcements', { ...idParams, limit: 100 });
    return toArrayByKeys(takeData(payload), ['Записи', 'ИП', 'items']);
  }

  if (sectionRef.cmd === CMD.BNK) {
    const payload = await checkoRequest(env, 'bankruptcy-messages', { ...idParams, limit: 100 });
    return toArrayByKeys(takeData(payload), ['Записи', 'Сообщения', 'messages']);
  }

  if (sectionRef.cmd === CMD.LOG) {
    const payload = await checkoRequest(env, 'timeline', { ...idParams, limit: 100 });
    return toArrayByKeys(takeData(payload), ['Записи', 'События', 'events']);
  }

  return [];
}

function parseGovExtra(extra) {
  if (extra === '44c') return ['44', 'customer'];
  if (extra === '44s') return ['44', 'supplier'];
  if (extra === '223c') return ['223', 'customer'];
  throw new Error('Неверный тип закупок.');
}

function inferIdParams(id) {
  if (/^\d{10}$/.test(id)) return { inn: id };
  if (/^\d{13}$/.test(id)) return { ogrn: id };
  return null;
}

async function collectMainCounts(env, id, idParams) {
  const tasks = [
    [CMD.FIN, () => fetchSectionRecords(env, { cmd: CMD.FIN, id, page: 1, extra: '' })],
    [CMD.CRT, () => fetchSectionRecords(env, { cmd: CMD.CRT, id, page: 1, extra: 'p' })],
    [CMD.GOV, () => fetchSectionRecords(env, { cmd: CMD.GOV, id, page: 1, extra: '44s' })],
    [CMD.INS, () => fetchSectionRecords(env, { cmd: CMD.INS, id, page: 1, extra: '' })],
    [CMD.FSP, () => fetchSectionRecords(env, { cmd: CMD.FSP, id, page: 1, extra: '' })],
    [CMD.BNK, () => fetchSectionRecords(env, { cmd: CMD.BNK, id, page: 1, extra: '' })],
  ];

  const settled = await Promise.allSettled(tasks.map(([, fn]) => fn()));
  const result = {};
  settled.forEach((entry, idx) => {
    const key = tasks[idx][0];
    result[key] = entry.status === 'fulfilled' ? entry.value.length : 0;
  });

  const timeline = await checkoRequest(env, 'timeline', { ...idParams, limit: 1 }).catch(() => null);
  result[CMD.LOG] = Array.isArray(takeData(timeline)) ? takeData(timeline).length : toArrayByKeys(takeData(timeline), ['Записи']).length;
  return result;
}

function renderCompanyCard(payload) {
  const data = takeData(payload);
  if (!data || typeof data !== 'object') {
    throw new Error('Карточка компании пуста: data отсутствует.');
  }

  const statusName = pickNested(data, [['Статус', 'Наим'], ['Статус']]) || '—';
  const text = [
    '🏢 <b>Основная информация</b>',
    '',
    `<b>Наименование:</b> ${escapeHtml(String(pick(data, ['НаимПолн', 'НаимСокр']) || '—'))}`,
    `<b>ИНН:</b> <code>${escapeHtml(String(pick(data, ['ИНН']) || '—'))}</code>`,
    `<b>ОГРН:</b> <code>${escapeHtml(String(pick(data, ['ОГРН']) || '—'))}</code>`,
    `<b>КПП:</b> <code>${escapeHtml(String(pick(data, ['КПП']) || '—'))}</code>`,
    `<b>Статус:</b> ${escapeHtml(String(statusName))}`,
    `<b>Дата регистрации:</b> ${escapeHtml(String(pick(data, ['ДатаРег']) || '—'))}`,
    '',
    `📍 <b>Адрес:</b> ${escapeHtml(String(pickNested(data, [['ЮрАдрес', 'АдресРФ']]) || '—'))}`,
    `👤 <b>Руководитель:</b> ${escapeHtml(String(pickNested(data, [['Руковод', 0, 'ФИО']]) || '—'))}`,
    `🏛️ <b>Уставный капитал:</b> ${escapeHtml(formatMoney(pickNested(data, [['УстКап', 'Сумма']])))}`,
    `📋 <b>Основной ОКВЭД:</b> ${escapeHtml(String(pickNested(data, [['ОКВЭД', 'Код']]) || '—'))}`,
    '',
    `📞 <b>Телефон:</b> ${escapeHtml(String(pickNested(data, [['Контакты', 'Тел']]) || '—'))}`,
    `📧 <b>Email:</b> ${escapeHtml(String(pickNested(data, [['Контакты', 'Емэйл']]) || '—'))}`,
    `🌐 <b>Сайт:</b> ${escapeHtml(String(pickNested(data, [['Контакты', 'ВебСайт']]) || '—'))}`,
  ].join('\n');
  return text;
}

function renderEntrepreneurCard(payload) {
  const data = takeData(payload);
  return [
    '🧑 <b>Карточка ИП</b>',
    '',
    `<b>ФИО:</b> ${escapeHtml(String(pick(data, ['ФИО', 'НаимПолн']) || '—'))}`,
    `<b>ИНН:</b> <code>${escapeHtml(String(pick(data, ['ИНН']) || '—'))}</code>`,
    `<b>ОГРНИП:</b> <code>${escapeHtml(String(pick(data, ['ОГРНИП']) || '—'))}</code>`,
    `<b>Статус:</b> ${escapeHtml(String(pickNested(data, [['Статус', 'Наим'], ['Статус']]) || '—'))}`,
    `<b>Дата регистрации:</b> ${escapeHtml(String(pick(data, ['ДатаРег']) || '—'))}`,
    `<b>ОКВЭД:</b> ${escapeHtml(String(pickNested(data, [['ОКВЭД', 'Код']]) || '—'))}`,
  ].join('\n');
}

function renderPersonCard(payload) {
  const data = takeData(payload);
  return [
    '👤 <b>Карточка физлица</b>',
    '',
    `<b>ФИО:</b> ${escapeHtml(String(pick(data, ['ФИО']) || '—'))}`,
    `<b>ИНН:</b> <code>${escapeHtml(String(pick(data, ['ИНН']) || '—'))}</code>`,
    `<b>Компаний как руководитель:</b> ${escapeHtml(String(pick(data, ['КолРуковод']) || '0'))}`,
    `<b>Компаний как учредитель:</b> ${escapeHtml(String(pick(data, ['КолУчред']) || '0'))}`,
    `<b>Статус ИП:</b> ${escapeHtml(String(pick(data, ['СтатусИП']) || '—'))}`,
  ].join('\n');
}

function renderBankCard(payload) {
  const data = takeData(payload);
  return [
    '🏦 <b>Карточка банка</b>',
    '',
    `<b>БИК:</b> <code>${escapeHtml(String(pick(data, ['БИК']) || '—'))}</code>`,
    `<b>Название:</b> ${escapeHtml(String(pick(data, ['Наим']) || '—'))}`,
    `<b>Тип:</b> ${escapeHtml(String(pick(data, ['Тип']) || '—'))}`,
    `<b>Адрес:</b> ${escapeHtml(String(pick(data, ['Адрес']) || '—'))}`,
    `<b>Корр. счёт:</b> ${escapeHtml(String(pickNested(data, [['КорСчет', 'Номер']]) || '—'))}`,
  ].join('\n');
}

function renderSection(cmd, rows, meta) {
  const lines = [
    `<b>${SECTION_TITLES[cmd] || 'Раздел'}</b>`,
    '',
    `Записей: <b>${rows.length ? meta.total : 0}</b>`,
    '',
  ];

  if (!rows.length) {
    lines.push('Данные отсутствуют.');
  } else {
    lines.push(...rows.map((item, index) => `• ${formatSectionRow(cmd, item, (meta.page - 1) * PAGE_SIZE + index + 1, meta.extra)}`));
  }

  if (cmd === CMD.FSP) {
    lines.push('', '⚠️ Возможны ложные совпадения по ФССП.');
  }

  return lines.join('\n');
}

function formatSectionRow(cmd, row, index, extra) {
  if (cmd === CMD.FIN) {
    return `${escapeHtml(String(pick(row, ['Год', 'year']) || '—'))}: выручка ${escapeHtml(formatMoney(pick(row, ['2110'])))}, прибыль ${escapeHtml(formatMoney(pick(row, ['2400'])))}.`;
  }
  if (cmd === CMD.CRT) {
    return `${index}) дело ${escapeHtml(String(pick(row, ['НомерДела', 'Номер']) || '—'))}, ${escapeHtml(String(pick(row, ['Дата', 'date']) || '—'))}, сумма ${escapeHtml(formatMoney(pick(row, ['СуммаТреб', 'Сумма'])))}.`;
  }
  if (cmd === CMD.GOV) {
    return `${index}) ${extra || ''} контракт ${escapeHtml(String(pick(row, ['НомерКонтракта', 'Номер']) || '—'))}, цена ${escapeHtml(formatMoney(pick(row, ['СуммаКонтракта', 'Цена'])))}.`;
  }
  if (cmd === CMD.INS) {
    return `${index}) проверка ${escapeHtml(String(pick(row, ['Номер', 'НомерПроверки']) || '—'))}, статус ${escapeHtml(String(pick(row, ['Статус']) || '—'))}.`;
  }
  if (cmd === CMD.FSP) {
    return `${index}) ИП ${escapeHtml(String(pick(row, ['НомерИП', 'Номер']) || '—'))}, долг ${escapeHtml(formatMoney(pick(row, ['СуммаДолга', 'Сумма'])))}.`;
  }
  if (cmd === CMD.BNK) {
    return `${index}) ${escapeHtml(String(pick(row, ['ТипСообщ', 'Тип']) || '—'))}, ${escapeHtml(String(pick(row, ['Дата', 'ДатаПубл']) || '—'))}.`;
  }
  if (cmd === CMD.LOG) {
    return `${index}) ${escapeHtml(String(pick(row, ['Дата', 'date']) || '—'))}: ${escapeHtml(String(pick(row, ['Событие', 'event']) || '—'))}.`;
  }
  return `${index}) ${escapeHtml(String(row?.toString?.() || 'Запись'))}`;
}

function buildMainKeyboard(id, counts) {
  const c = (key) => Number.isFinite(Number(counts?.[key])) ? Number(counts[key]) : 0;
  return {
    inline_keyboard: [
      [kb(`📊 Финансы (${c(CMD.FIN)})`, cb(CMD.FIN, id, 1)), kb(`⚖️ Арбитраж (${c(CMD.CRT)})`, cb(CMD.CRT, id, 1))],
      [kb(`🏛 Госзакупки (${c(CMD.GOV)})`, cb(CMD.GOV, id, 1)), kb(`🚨 Проверки (${c(CMD.INS)})`, cb(CMD.INS, id, 1))],
      [kb(`🛑 ФССП (${c(CMD.FSP)})`, cb(CMD.FSP, id, 1)), kb(`📉 Банкротство (${c(CMD.BNK)})`, cb(CMD.BNK, id, 1))],
      [kb('📜 История', cb(CMD.LOG, id, 1)), kb('🏦 Банк', cb(CMD.BAK, id, 1))],
      [kb('🔄 Новый поиск', cb(CMD.NEW, id, 1))],
    ],
  };
}

function arbitrationRoleKeyboard(id) {
  return {
    inline_keyboard: [
      [kb('🟢 Истец', cb(CMD.CRT, id, 1, 'p')), kb('🔴 Ответчик', cb(CMD.CRT, id, 1, 'd'))],
      [kb('⬅️ Назад', cb(CMD.MAIN, id, 1))],
    ],
  };
}

function govRoleKeyboard(id) {
  return {
    inline_keyboard: [
      [kb('🛒 44-ФЗ Заказчик', cb(CMD.GOV, id, 1, '44c')), kb('💼 44-ФЗ Поставщик', cb(CMD.GOV, id, 1, '44s'))],
      [kb('🏢 223-ФЗ Заказчик', cb(CMD.GOV, id, 1, '223c'))],
      [kb('⬅️ Назад', cb(CMD.MAIN, id, 1))],
    ],
  };
}

function paginationKeyboard(sectionRef, page, totalPages) {
  const nav = [
    kb('⬅️ Назад', cb(sectionRef.cmd, sectionRef.id, Math.max(1, page - 1), sectionRef.extra)),
    kb(`📄 Страница ${page} из ${totalPages}`, cb(CMD.NOOP, sectionRef.id, page)),
    kb('➡️ Дальше', cb(sectionRef.cmd, sectionRef.id, Math.min(totalPages, page + 1), sectionRef.extra)),
  ];

  return {
    inline_keyboard: [
      nav,
      [kb('🏠 В главное меню', cb(CMD.MAIN, sectionRef.id, 1))],
    ],
  };
}

function ipPersonBackKeyboard(id) {
  return {
    inline_keyboard: [[kb('🔄 Новый поиск', cb(CMD.NEW, id, 1))]],
  };
}

function searchAgainKeyboard() {
  return {
    inline_keyboard: [[kb('🔄 Новый поиск', cb(CMD.NEW, '0', 1))]],
  };
}

function cb(cmd, id, page, extra = '') {
  return extra ? `${cmd}:${id}:${page}:${extra}` : `${cmd}:${id}:${page}`;
}

function kb(text, callback_data) {
  return { text, callback_data };
}

function buildSessionKey(chatId, messageId, cmd, id, extra) {
  return `session:${chatId}:${messageId}:${cmd}:${id}:${extra || '-'}`;
}

async function kvGetJson(env, key) {
  if (!env.SESSION_KV) {
    return null;
  }
  const raw = await env.SESSION_KV.get(key);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function kvPutJson(env, key, value, expirationTtl) {
  if (!env.SESSION_KV) {
    return;
  }
  await env.SESSION_KV.put(key, JSON.stringify(value), { expirationTtl });
}

function isWebhookSecretValid(request, env) {
  if (!env.WEBHOOK_SECRET) {
    throw new Error('Missing WEBHOOK_SECRET.');
  }
  const received = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  return received === env.WEBHOOK_SECRET;
}

function ensureSecrets(env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.CHECKO_API_KEY || !env.WEBHOOK_SECRET) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN/CHECKO_API_KEY/WEBHOOK_SECRET.');
  }
}

async function checkoRequest(env, endpoint, params = {}) {
  ensureSecrets(env);
  const base = String(env.CHECKO_API_URL || DEFAULT_CHECKO_API_URL).replace(/\/$/, '');
  const url = new URL(`${base}/${endpoint}`);
  url.searchParams.set('key', env.CHECKO_API_KEY);

  Object.entries(params).forEach(([k, v]) => {
    if (v !== null && v !== undefined && v !== '') {
      url.searchParams.set(k, String(v));
    }
  });

  const response = await fetchWithTimeout(url.toString(), { method: 'GET' }, 15000);
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

  const status = String(payload?.meta?.status || 'ok').toLowerCase();
  const message = String(payload?.meta?.message || '');
  if (!['ok', 'success'].includes(status)) {
    throw new Error(`Checko meta ${status}: ${message || 'unknown error'}`);
  }

  return payload;
}

function takeData(payload) {
  return payload?.data ?? payload;
}

function toArrayByKeys(data, keys) {
  if (Array.isArray(data)) {
    return data;
  }
  if (!data || typeof data !== 'object') {
    return [];
  }
  for (const key of keys) {
    if (Array.isArray(data[key])) {
      return data[key];
    }
  }
  return [];
}

function pick(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return null;
}

function pickNested(obj, paths) {
  for (const path of paths) {
    let cur = obj;
    for (const key of path) {
      cur = cur?.[key];
      if (cur === undefined || cur === null) {
        break;
      }
    }
    if (cur !== undefined && cur !== null && cur !== '') {
      return cur;
    }
  }
  return null;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') {
    return 0;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  const normalized = String(value).replace(/\s+/g, '').replace(',', '.').replace(/[^\d.-]/g, '');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatMoney(value) {
  const num = toNumber(value);
  if (!num) {
    return '0 ₽';
  }
  return `${Math.round(num).toLocaleString('ru-RU')} ₽`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function safeEditMessage(env, chatId, messageId, text, replyMarkup) {
  try {
    await telegram(env, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    });
  } catch {
    await sendMessage(env, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: replyMarkup,
    });
  }
}

async function sendMessage(env, body) {
  return telegram(env, 'sendMessage', body);
}

async function telegram(env, method, body) {
  ensureSecrets(env);
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    },
    10000,
  );

  const raw = await response.text();
  if (response.status !== 200) {
    if (response.status === 429) {
      throw new Error('Telegram rate limit (429). Повторите позже.');
    }
    throw new Error(`Telegram ${method} HTTP ${response.status}: ${raw.slice(0, 300)}`);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`Telegram ${method} non-JSON response: ${raw.slice(0, 300)}`);
  }

  if (payload?.ok !== true) {
    throw new Error(`Telegram ${method} API error: ${String(payload?.description || 'unknown')}`);
  }

  return payload.result;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
