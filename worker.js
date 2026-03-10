export default {
  async fetch(_request, env) {
    const hasBotToken = Boolean(env.TELEGRAM_BOT_TOKEN);
    const hasCheckoApiKey = Boolean(env.CHECKO_API_KEY);

    return new Response(
      JSON.stringify({
        ok: true,
        service: "telegram-checko-bot",
        secretsConfigured: hasBotToken && hasCheckoApiKey,
      }),
      {
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  },
};
