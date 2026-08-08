// Скрипт установки Telegram webhook на задеплоенный Worker.
// Токен берётся из env TELEGRAM_BOT_TOKEN (или из секрета wrangler через
// wrangler secret list — но проще задать переменную окружения перед запуском).
//
// Пример:
//   $env:TELEGRAM_BOT_TOKEN = "123456:ABC..."
//   $env:TG_WEBHOOK_SECRET  = "длинная случайная строка (1-256 символов)"
//   npm run set-webhook
//
// Worker URL подставьте в WORKER_URL (должен совпадать с адресом деплоя).
//
// TG_WEBHOOK_SECRET — опционально, но рекомендуется: Telegram будет слать
// его в заголовке X-Telegram-Bot-Api-Secret-Token на каждый update, и Worker
// отвергнёт подделанные запросы без совпадающего секрета. Должен совпадать с
// секретом wrangler TG_WEBHOOK_SECRET на воркере.

const WORKER_URL = process.env.WORKER_URL ||
  'https://schedule-worker.campus-schedule-syktyvkar.workers.dev';
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET = process.env.TG_WEBHOOK_SECRET || '';

if (!TOKEN) {
  console.error('❌ Не задан TELEGRAM_BOT_TOKEN. Задайте переменную окружения и повторите.');
  process.exit(1);
}

if (!SECRET) {
  console.error('❌ TG_WEBHOOK_SECRET обязателен. Сгенерируйте секрет и задайте его:');
  console.error('   1) npx wrangler secret put TG_WEBHOOK_SECRET');
  console.error('   2) $env:TG_WEBHOOK_SECRET = "<тот же секрет>"');
  console.error('   3) npm run set-webhook');
  process.exit(1);
}

const webhookUrl = `${WORKER_URL}/api/tg/webhook`;

(async () => {
  try {
    const payload = { url: webhookUrl, drop_pending_updates: true };
    if (SECRET) payload.secret_token = SECRET;
    const setResp = await fetch(`https://api.telegram.org/bot${TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const setData = await setResp.json();
    console.log('setWebhook:', JSON.stringify(setData));

    const infoResp = await fetch(`https://api.telegram.org/bot${TOKEN}/getWebhookInfo`);
    const info = await infoResp.json();
    console.log('webhook info:', JSON.stringify(info.result, null, 2));
  } catch (e) {
    console.error('Ошибка:', e.message);
    process.exit(1);
  }
})();
