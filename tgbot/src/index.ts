/**
 * Entry point. Order matters: resolve a hub credential BEFORE touching
 * Telegram, so a bot that cannot work never answers a message promising it can.
 */
import { loadConfig } from './config.js';
import { resolveSession } from './auth.js';
import { Bot } from './bot.js';
import { Store } from './state.js';
import { Telegram } from './telegram.js';

const COMMANDS = [
  { command: 'menu', description: 'Главное меню' },
  { command: 'new', description: 'Новая сессия в текущем проекте' },
  { command: 'projects', description: 'Выбрать проект' },
  { command: 'sessions', description: 'Сессии проекта' },
  { command: 'stop', description: 'Остановить текущий ход' },
  { command: 'end', description: 'Завершить сессию' },
  { command: 'settings', description: 'Настройки' },
  { command: 'whoami', description: 'Кто я и куда подключён' },
  { command: 'cancel', description: 'Отменить ожидание ввода' },
];

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = new Store(cfg.statePath);

  const identity = await resolveSession(cfg, store.session);
  store.setSession(identity.session);
  console.log(`[bot] hub credential ok: ${identity.email ?? identity.userId ?? 'unknown user'}`);

  const tg = new Telegram(cfg.botToken);
  const me = await tg.getMe();
  console.log(`[bot] telegram @${me.username ?? me.id}, ${cfg.allow.size} allowed account(s)`);
  await tg.setCommands(COMMANDS).catch((err: unknown) => console.warn('[bot] setMyCommands failed', err));
  await tg.skipBacklog();

  const bot = new Bot(cfg, tg, store, identity.session);
  bot.onNeedsAuth(() => {
    void resolveSession(cfg, undefined)
      .then((fresh) => {
        store.setSession(fresh.session);
        bot.setSession(fresh.session);
        console.log('[bot] re-authenticated');
      })
      .catch((err: unknown) => console.error('[bot] re-auth failed', err));
  });
  bot.start();

  const shutdown = (signal: string) => {
    console.log(`[bot] ${signal} — flushing state`);
    tg.stop();
    store.flush();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await tg.run((update) => bot.handleUpdate(update));
}

main().catch((err: unknown) => {
  console.error('[bot] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
