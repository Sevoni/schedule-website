// Скрипт установки Telegram webhook на задеплоенный Worker.
// Токен берётся из env TELEGRAM_BOT_TOKEN (или из секрета wrangler через
// wrangler secret list — но проще задать переменную окружения перед запуском).
//
// Пример:
//   $env:TELEGRAM_BOT_TOKEN = "123456:ABC..."
//   npm run set-webhook
//
// Worker URL подставьте в WORKER_URL (должен совпадать с адресом деплоя).

const WORKER_URL = process.env.WORKER_URL ||
  'https://schedule-worker.campus-schedule-syktyvkar.workers.dev';
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TOKEN) {
  console.error('❌ Не задан TELEGRAM_BOT_TOKEN. Задайте переменную окружения и повторите.');
  process.exit(1);
}

const webhookUrl = `${WORKER_URL}/api/tg/webhook`;

(async () => {
  try {
    const setResp = await fetch(`https://api.telegram.org/bot${TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, drop_pending_updates: true }),
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
