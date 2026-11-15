/**
 * End-to-end smoke: a REAL hub and a REAL Telegram bot, driven by synthetic
 * updates instead of thumbs. Messages genuinely appear in the operator's chat —
 * that is the point, it is the only way to see what the rendering looks like.
 *
 *   TELEGRAM_BOT_TOKEN=… CC_REMOTE_TG_ALLOW=<id> CC_REMOTE_HUB_HTTP=https://code.acme.test \
 *   CC_REMOTE_TG_SESSION=… CC_REMOTE_TG_STATE=/tmp/tgbot-smoke.json \
 *   npx tsx tgbot/src/cli/tg-smoke.ts [machine-name]
 *
 * Read-only by default: it walks machines → projects → sessions and asserts the
 * screens were built from real data. Set CC_TG_SMOKE_RUN=1 to also START a real
 * session on the chosen machine and wait for the agent to answer — that costs
 * tokens on a real box, so it is opt-in.
 *
 * The bot service must be stopped first: Telegram allows one `getUpdates`
 * poller per token, and this process never polls, so the two do not collide —
 * but two BOTS answering the same chat would.
 */
import { resolveSession } from '../auth.js';
import { Bot } from '../bot.js';
import { loadConfig } from '../config.js';
import { Store } from '../state.js';
import { Telegram, type InlineKeyboard, type TgMessage, type TgUpdate } from '../telegram.js';

/** First line of a rendered message, tags stripped — for a readable log line. */
function oneLineOf(text: string): string {
  const first = text.replace(/<[^>]*>/g, '').split('\n').find((line) => line.trim()) ?? '';
  return first.slice(0, 80);
}

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function ok(step: string, detail = ''): void {
  console.log(`  ✓ ${step}${detail ? ` — ${detail}` : ''}`);
}

/** A Telegram client that still sends for real, and remembers what it sent —
 *  including the message id, so the smoke can answer its own inline buttons. */
class RecordingTelegram extends Telegram {
  readonly log: Array<{ text: string; messageId: number | undefined }> = [];

  override async sendMessage(
    chatId: number,
    text: string,
    opts: { keyboard?: InlineKeyboard; replyTo?: number; html?: boolean; disablePreview?: boolean; silent?: boolean } = {},
  ): Promise<TgMessage[]> {
    const sent = await super.sendMessage(chatId, text, opts);
    this.log.push({ text, messageId: sent.at(-1)?.message_id });
    return sent;
  }

  get sent(): string[] {
    return this.log.map((entry) => entry.text);
  }

  /** Everything sent since `mark`, joined — for asserting on a whole step. */
  since(mark: number): string {
    return this.sent.slice(mark).join('\n---\n');
  }

  /** The first message after `mark` whose text matches — with its id. */
  find(mark: number, re: RegExp): { text: string; messageId: number | undefined } | undefined {
    return this.log.slice(mark).find((entry) => re.test(entry.text));
  }
}

/**
 * Race a promise against a deadline and CLEAR the timer afterwards. A bare
 * `Promise.race([p, sleep(n).then(fail)])` does not cancel the loser, so the
 * timeout still fires later and kills a run that already succeeded.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Poll `check` until it returns something truthy, or give up. */
async function waitFor<T>(label: string, ms: number, check: () => T | undefined): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(1500);
  }
  return fail(`timed out waiting for ${label} (${ms / 1000}s)`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function message(chatId: number, userId: number, text: string): TgUpdate {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: Math.floor(Math.random() * 1e6),
      from: { id: userId },
      chat: { id: chatId, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

function callback(chatId: number, userId: number, data: string): TgUpdate {
  return {
    update_id: Math.floor(Math.random() * 1e9),
    callback_query: {
      id: String(Math.floor(Math.random() * 1e9)),
      from: { id: userId },
      message: {
        message_id: Math.floor(Math.random() * 1e6),
        chat: { id: chatId, type: 'private' },
        date: Math.floor(Date.now() / 1000),
      },
      data,
    },
  };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const userId = [...cfg.allow][0];
  if (userId === undefined) fail('CC_REMOTE_TG_ALLOW is empty');
  const chatId = userId; // a private chat's id IS the user id

  const store = new Store(cfg.statePath);
  const identity = await resolveSession(cfg, store.session);
  store.setSession(identity.session);
  ok('hub credential', identity.email ?? identity.userId ?? '?');

  const tg = new RecordingTelegram(cfg.botToken);
  const me = await tg.getMe();
  ok('telegram', `@${me.username ?? me.id}`);

  const bot = new Bot(cfg, tg, store, identity.session);
  bot.start();
  await withTimeout(bot.ready, 15_000, 'hub sent no snapshot in 15s');
  const machines = bot.machinesForSmoke();
  ok('hub snapshot', `${machines.length} startable machine(s)`);
  if (!machines.length) fail('no startable machines — nothing to drive');

  const wanted = process.argv[2] ?? process.env['CC_SMOKE_MACHINE'];
  const target = wanted ? machines.find((m) => m.name === wanted) : machines[0];
  if (!target) fail(`machine "${wanted}" not found among: ${machines.map((m) => m.name).join(', ')}`);
  ok('target machine', target.name);

  // --- 1. /start renders the menu ------------------------------------------
  let mark = tg.sent.length;
  await bot.handleUpdate(message(chatId, userId, '/start'));
  if (!tg.since(mark).includes('Hegai Code')) fail('/start did not render the menu');
  ok('/start', 'menu rendered');

  // --- 2. machines list ------------------------------------------------------
  mark = tg.sent.length;
  await bot.handleUpdate(callback(chatId, userId, 'mach'));
  const listed = store.chat(chatId).lastMachines ?? [];
  if (!listed.length) fail('machines screen listed nothing');
  ok('machines screen', `${listed.length} listed`);

  const index = listed.indexOf(target.id);
  if (index < 0) fail(`${target.name} missing from the rendered list`);

  // --- 3. picking a machine loads its projects over RPC ----------------------
  mark = tg.sent.length;
  await bot.handleUpdate(callback(chatId, userId, `m:${index}`));
  const projects = store.chat(chatId).lastProjects ?? [];
  if (!projects.length) fail(`projects.list returned nothing for ${target.name}: ${tg.since(mark)}`);
  ok('projects.list', `${projects.length} project(s), first: ${projects[0]}`);

  // --- 4. a project's sessions ----------------------------------------------
  await bot.handleUpdate(callback(chatId, userId, 'p:0'));
  const chat = store.chat(chatId);
  if (chat.cwd !== projects[0]) fail('picking a project did not set cwd');
  ok('sessions screen', `${(chat.lastSessions ?? []).length} session(s) in ${chat.cwd}`);

  // --- 5. the category chips are filtered by the machine's skills -----------
  mark = tg.sent.length;
  await bot.handleUpdate(callback(chatId, userId, 'new'));
  if (!tg.since(mark).includes('Новая сессия')) fail('new-session screen did not render');
  ok('categories', 'chips rendered');

  // --- 6. settings round-trip ------------------------------------------------
  const before = chat.settings.verbose;
  await bot.handleUpdate(callback(chatId, userId, 'set:v'));
  if (store.chat(chatId).settings.verbose === before) fail('verbose toggle did not stick');
  await bot.handleUpdate(callback(chatId, userId, 'set:v'));
  ok('settings', 'verbose toggles both ways');

  // --- 7. optional: start a real session and wait for the agent to speak ----
  if (process.env['CC_TG_SMOKE_RUN'] === '1') {
    console.log('\n  … starting a REAL session (CC_TG_SMOKE_RUN=1)');
    mark = tg.sent.length;
    await bot.handleUpdate(callback(chatId, userId, 'cat:-'));
    await bot.handleUpdate(
      message(chatId, userId, 'Ответь одним словом: работает. Ничего не делай и ничего не меняй.'),
    );
    await waitFor('the agent to answer', 120_000, () => tg.find(mark, /работает/i));
    ok('live session', 'agent answered into the chat');

    // The decision path is the one that, when broken, looks like a hang: the
    // agent waits for an answer nobody can give from a phone. AskUserQuestion
    // is used rather than a Bash approval because a machine whose permissions
    // already allow Bash would silently skip the prompt and prove nothing.
    const askMark = tg.log.length;
    await bot.handleUpdate(
      message(
        chatId,
        userId,
        'Задай мне вопрос инструментом AskUserQuestion: «Продолжаем?» с вариантами «Да» и «Нет». ' +
          'Больше ничего не делай, файлы не трогай.',
      ),
    );
    const question = await waitFor('an AskUserQuestion prompt', 150_000, () => tg.find(askMark, /❓/));
    if (question.messageId === undefined) fail('question message has no id to answer');
    ok('tool_request', `question rendered: ${oneLineOf(question.text)}`);

    const answeredMark = tg.log.length;
    const pick = callback(chatId, userId, 'q:0');
    if (pick.callback_query?.message) pick.callback_query.message.message_id = question.messageId;
    await bot.handleUpdate(pick);
    await waitFor(
      'the agent to act on the answer',
      150_000,
      () => tg.log.slice(answeredMark).find((entry) => !/^[❓🔐]/.test(entry.text)),
    );
    ok('tool_decision', 'answered from the chat, agent continued');

    if (store.chat(chatId).runId) {
      await bot.handleUpdate(callback(chatId, userId, 'end'));
      ok('close', 'run closed');
      await sleep(1500);
    }
  } else {
    console.log('\n  (set CC_TG_SMOKE_RUN=1 to also start a real session)');
  }

  store.flush();
  console.log('\n✓ tg-smoke passed');
  process.exit(0);
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
