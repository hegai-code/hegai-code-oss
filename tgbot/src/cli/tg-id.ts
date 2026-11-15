/**
 * Chicken-and-egg helper: the bot refuses everyone who is not on the whitelist,
 * and a Telegram user id is not something a person can read off their own
 * profile. This prints the id of whoever writes to the bot next.
 *
 *   TELEGRAM_BOT_TOKEN=… tsx tgbot/src/cli/tg-id.ts
 *
 * Read-only — it confirms the updates it reads so the bot does not replay them
 * later, and never answers. Stop the bot service first: Telegram allows one
 * `getUpdates` poller per token and the second gets 409.
 */
const token = process.env['TELEGRAM_BOT_TOKEN'];
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

const seconds = Number(process.argv[2] ?? 120);
const deadline = Date.now() + seconds * 1000;
let offset = 0;

console.log(`Слушаю ${seconds}с. Напиши боту любое сообщение (например /start).`);

while (Date.now() < deadline) {
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ offset, timeout: 20, allowed_updates: ['message'] }),
  });
  const body = (await res.json()) as {
    ok?: boolean;
    description?: string;
    result?: Array<{
      update_id: number;
      message?: { from?: { id: number; username?: string; first_name?: string }; text?: string };
    }>;
  };
  if (!body.ok) {
    console.error(`Telegram: ${body.description ?? 'unknown error'}`);
    if ((body.description ?? '').includes('Conflict')) {
      console.error('Похоже, бот уже запущен и держит опрос — останови сервис и повтори.');
    }
    process.exit(1);
  }
  for (const update of body.result ?? []) {
    offset = Math.max(offset, update.update_id + 1);
    const from = update.message?.from;
    if (!from) continue;
    console.log(
      `\nid: ${from.id}   @${from.username ?? '—'}   ${from.first_name ?? ''}   ` +
        `текст: ${JSON.stringify(update.message?.text ?? '')}`,
    );
    console.log(`\nCC_REMOTE_TG_ALLOW=${from.id}`);
    // Confirm what we consumed so the bot does not replay it, then stop.
    await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offset, timeout: 0 }),
    });
    process.exit(0);
  }
}
console.log('Никто не написал за отведённое время.');
