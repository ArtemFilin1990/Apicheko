const DEFAULT_CHECKO_API_URL = 'https://api.checko.ru/v2';
const DEFAULT_WEBHOOK_PATH = '/webhook';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const webhookPath = normalizeWebhookPath(env.WEBHOOK_PATH);

    if (request.method === 'GET' && url.pathname === '/') {
      return jsonResponse({
        ok: true,
        service: 'telegram-checko-bot',
        webhookPath,
      });
    }

    if (request.method === 'POST' && url.pathname === webhookPath) {
      try {
        return await handleTelegramUpdate(request, env);
      } catch (error) {
        return jsonResponse({ ok: false, error: String(error.message || error) }, 400);
      }
    }

    return new Response('Not Found', { status: 404 });
  },
};

async function handleTelegramUpdate(request, env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.CHECKO_API_KEY) {
    return jsonResponse(
      { ok: false, error: 'Missing required secrets TELEGRAM_BOT_TOKEN/CHECKO_API_KEY.' },
      500,
    );
  }

  const update = await parseJsonOrThrow(request);

  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
    return jsonResponse({ ok: true });
  }

  if (!update.message || typeof update.message.text !== 'string') {
    return jsonResponse({ ok: true, skipped: 'Unsupported update type.' });
  }

  const chatId = update.message.chat?.id;
  const text = update.message.text.trim();

  if (!chatId) {
    return jsonResponse({ ok: true, skipped: 'No chat id in message.' });
  }

  if (text === '/start' || text === '/help') {
    await telegramRequest(env, 'sendMessage', {
      chat_id: chatId,
      text:
        'Отправьте ИНН: 10 цифр для компании, 12 цифр для ИП.\n' +
        'Я верну краткую карточку и кнопки по разделам.',
    });
    return jsonResponse({ ok: true });
  }

  if (!/^(?:\d{10}|\d{12})$/.test(text)) {
    await telegramRequest(env, 'sendMessage', {
      chat_id: chatId,
      text: 'Введите корректный ИНН: 10 или 12 цифр.',
    });
    return jsonResponse({ ok: true });
  }

  const entityType = text.length === 10 ? 'company' : 'entrepreneur';

  try {
    const checkoData = await getCheckoEntity({ env, inn: text, entityType });
    const card = formatCard(checkoData, text);

    await telegramRequest(env, 'sendMessage', {
      chat_id: chatId,
      text: card,
      reply_markup: {
        inline_keyboard: [
          [
            sectionButton('Карточка', 'card', text),
            sectionButton('Финансы', 'finances', text),
          ],
          [sectionButton('Суды', 'courts', text), sectionButton('Исп. пр-ва', 'enforcements', text)],
          [
            sectionButton('Госзакупки', 'contracts', text),
            sectionButton('История', 'history', text),
          ],
          [sectionButton('Федресурс', 'fedresurs', text), sectionButton('ЕФРСБ', 'efrsb', text)],
        ],
      },
    });
  } catch (error) {
    await telegramRequest(env, 'sendMessage', {
      chat_id: chatId,
      text: `Ошибка Checko: ${error.message}`,
    });
  }

  return jsonResponse({ ok: true });
}

async function handleCallbackQuery(callbackQuery, env) {
  const callbackData = String(callbackQuery.data || '');
  const [kind, section, inn] = callbackData.split(':');
  const callbackId = callbackQuery.id;
  const chatId = callbackQuery.message?.chat?.id;

  await telegramRequest(env, 'answerCallbackQuery', {
    callback_query_id: callbackId,
    text: 'Готово',
  });

  if (kind !== 'sec' || !chatId) {
    return;
  }

  const sectionMessages = {
    card: `Карточка по ИНН ${inn}: базовые регистрационные данные уже показаны выше.`,
    finances: `Финансы по ИНН ${inn}: для детализации откройте раздел финансовой отчетности в Checko API.`,
    courts: `Суды по ИНН ${inn}: используйте endpoint legal-cases для получения списка дел.`,
    enforcements: `Исполнительные производства по ИНН ${inn}: доступны через endpoint enforcements.`,
    contracts: `Госзакупки по ИНН ${inn}: формируются через endpoint contracts (44/94/223).`,
    history: `История изменений по ИНН ${inn}: доступна в endpoint timeline.`,
    fedresurs: `Федресурс по ИНН ${inn}: проверяйте публикации в соответствующем разделе Checko.`,
    efrsb: `ЕФРСБ по ИНН ${inn}: используйте endpoint bankruptcy-messages.`,
  };

  const text = sectionMessages[section] ?? `Раздел "${section}" для ИНН ${inn}.`;

  await telegramRequest(env, 'sendMessage', {
    chat_id: chatId,
    text,
  });
}

function sectionButton(label, section, inn) {
  return {
    text: label,
    callback_data: `sec:${section}:${inn}`,
  };
}

async function getCheckoEntity({ env, inn, entityType }) {
  const endpoint = entityType === 'company' ? 'company' : 'entrepreneur';
  const baseUrl = (env.CHECKO_API_URL || DEFAULT_CHECKO_API_URL).replace(/\/$/, '');
  const url = new URL(`${baseUrl}/${endpoint}`);
  url.searchParams.set('key', env.CHECKO_API_KEY);
  url.searchParams.set('inn', inn);

  const response = await fetchWithTimeout(url.toString(), { method: 'GET' }, 15000);
  const text = await response.text();

  if (response.status !== 200) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON Checko response: ${text.slice(0, 300)}`);
  }

  const meta = payload?.meta;
  if (meta?.status === 'error') {
    throw new Error(String(meta?.message || 'Unknown Checko meta.status=error'));
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid Checko payload format.');
  }

  return payload?.data || payload;
}

function formatCard(data, inn) {
  const entity = Array.isArray(data) ? data[0] : data;
  if (!entity || typeof entity !== 'object') {
    return `По ИНН ${inn} данные не найдены.`;
  }

  const title = entity.НаимПолн || entity.НаимСокр || entity.ФИО || 'Без названия';
  const ogrn = entity.ОГРН || entity.ОГРНИП || '—';
  const status = entity.Статус?.Наим || entity.Статус || '—';
  const registrationDate = entity.ДатаРег || '—';
  const director = entity.Руковод?.[0]?.ФИО || '—';
  const okvedCode = entity.ОКВЭД?.Код || '—';
  const okvedName = entity.ОКВЭД?.Наим || '—';
  const address = entity.ЮрАдрес?.АдресРФ || entity.Адрес || '—';

  return [
    `🏢 ${title}`,
    `ИНН: ${entity.ИНН || inn}`,
    `ОГРН/ОГРНИП: ${ogrn}`,
    `Статус: ${status}`,
    `Дата регистрации: ${registrationDate}`,
    `Руководитель: ${director}`,
    `ОКВЭД: ${okvedCode} ${okvedName}`,
    `Адрес: ${address}`,
  ].join('\n');
}

async function telegramRequest(env, method, body) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const endpoint = `https://api.telegram.org/bot${token}/${method}`;

  const response = await fetchWithTimeout(
    endpoint,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    },
    10000,
  );

  if (response.status !== 200) {
    const raw = await response.text();
    throw new Error(`Telegram API ${method} failed (${response.status}): ${raw.slice(0, 300)}`);
  }
}

async function parseJsonOrThrow(request) {
  try {
    return await request.json();
  } catch {
    throw new Error('Invalid JSON in webhook request.');
  }
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

function normalizeWebhookPath(input) {
  if (!input) {
    return DEFAULT_WEBHOOK_PATH;
  }
  return input.startsWith('/') ? input : `/${input}`;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
