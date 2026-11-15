/**
 * The controller: Telegram updates in, hub messages out, and back.
 *
 * The product decision that shapes this file: a chat shows the agent's SPEECH
 * and nothing else. Tool calls, SDK init lines, stderr and reasoning summaries
 * are machinery — they exist in the stream (`kind` of `tool_use`/`system`/
 * `status`) and are dropped unless the chat turned verbose on. While a turn
 * runs the only signal is Telegram's own "typing…", and when it ends the
 * controls appear ON the last message rather than as a new one. That is what
 * "не показывать лишнюю инфу" means concretely.
 */
import { SessionCategory, type ActiveRunInfo, type ImageInput } from '@cc-remote/shared';

import type { Config } from './config.js';
import {
  HubClient,
  type EnrichFrame,
  type OpenedFrame,
  type RunStatusFrame,
  type SessionStartedFrame,
  type StreamFrame,
  type ToolRequestFrame,
  type HubHandlers,
} from './hub.js';
import {
  attentionScreen,
  categoriesScreen,
  composeScreen,
  firstPrompt,
  machinesScreen,
  mainMenu,
  projectsScreen,
  sessionsScreen,
  settingsScreen,
  turnControls,
  type Screen,
} from './nav.js';
import { answerKey, normalizeQuestions, type AskQuestion } from './questions.js';
import {
  ago,
  escapeHtml,
  historyDocument,
  historyTurns,
  notifyBody,
  oneLine,
  plural,
  projectLabel,
  speech,
  toolLine,
} from './render.js';
import type { Store } from './state.js';
import { WAITLIST_CALLBACK, WaitlistWatcher } from './waitlist.js';
import { LoginFlow, parseLoginCallback, parseLoginStart, STRANGER_HINT } from './login.js';
import { Telegram, type InlineKeyboard, type TgCallbackQuery, type TgMessage, type TgUpdate } from './telegram.js';

/** Live state of one turn. Purely in-memory: a restart mid-turn loses the
 *  formatting continuity, never the session itself. */
interface Turn {
  chatId: number;
  typing?: NodeJS.Timeout;
  /** Last message the bot sent for this turn — where the controls land. */
  lastMessageId?: number;
  /** Concatenated agent speech, for the optional enrichment call. */
  said: string;
  /** Whether anything at all was shown this turn. */
  spoke: boolean;
}

interface PendingTool {
  runId: string;
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
  messageId: number;
  questions: AskQuestion[];
  qi: number;
  picked: Set<string>;
  answers: Record<string, string | string[]>;
  awaitingOther: boolean;
}

const OTHER = 'cc-other';
const TYPING_MS = 5_000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** Quiet window per run between activity notifications. */
const NOTIFY_COOLDOWN_MS = 10 * 60_000;

/** How often the bot asks the hub for sign-ins to announce. */
const LOGIN_NOTICE_MS = 5_000;

export class Bot implements HubHandlers {
  private readonly hub: HubClient;
  private readonly waitlist: WaitlistWatcher;
  /** «Войти через Telegram»: the one path open to strangers (login.ts). */
  private readonly login: LoginFlow | undefined;
  private readonly turns = new Map<string, Turn>();
  private readonly runOwner = new Map<string, number>();
  private readonly pendingTools = new Map<number, PendingTool>();
  private readonly pendingOpens: Array<{ chatId: number }> = [];
  /** Per `${chatId}:${messageId}`: each keyboard answers for its OWN buttons —
   *  keyed by chat, a tap on an older turn's keyboard sent the newer turn's text. */
  private readonly quickReplies = new Map<string, { runId: string | undefined; replies: Array<{ label: string; send: string }> }>();
  private readonly enrichWaiters = new Map<string, { chatId: number; messageId: number; runId: string | undefined }>();
  private readonly prevRunState = new Map<string, string>();
  /** runId -> when this bot last announced it, so a replayed pending request
   *  does not arrive as a fresh notification. */
  private readonly lastNotifiedAt = new Map<string, number>();
  private readonly queues = new Map<number, Promise<unknown>>();
  private activitySeeded = false;
  private lastActingChat: number | undefined;
  private enrichOffered = true;
  private enrichSeq = 0;
  private reauth: (() => void) | undefined;
  private readyResolve: (() => void) | undefined;
  /** Resolves on the hub's first snapshot. Only the smoke waits on it; the bot
   *  itself is happy to answer before the fleet has arrived. */
  readonly ready: Promise<void> = new Promise<void>((resolve) => {
    this.readyResolve = resolve;
  });

  constructor(
    private readonly cfg: Config,
    private readonly tg: Telegram,
    private readonly store: Store,
    session: string,
  ) {
    this.hub = new HubClient(cfg.ws, session, this);
    this.login = cfg.loginSecret ? new LoginFlow(tg, cfg.http, cfg.loginSecret) : undefined;
    this.waitlist = new WaitlistWatcher({
      http: cfg.http,
      tg,
      store,
      // A private chat's id is the user's id, so every whitelisted account is
      // reachable even if it never wrote to the bot since the state was reset.
      chatIds: () => [...cfg.allow],
      onUnauthorized: () => this.reauth?.(),
    });
  }

  start(): void {
    this.hub.connect();
    this.waitlist.start();
    // «Новый вход в Hegai Code»: the hub never calls the bot, so ask it.
    if (this.login) {
      const login = this.login;
      setInterval(() => void login.announceNewSignIns(), LOGIN_NOTICE_MS).unref();
    }
  }

  setSession(session: string): void {
    this.hub.setSession(session);
  }

  // ------------------------------------------------------------ hub handlers

  onReady(): void {
    // The hub re-sends a full snapshot on fleet-level changes, not only on
    // connect, so only the first one is news.
    if (this.readyResolve) {
      const name = this.hub.viewer?.fullName ?? this.hub.viewer?.email ?? 'неизвестно кто';
      console.log(`[bot] hub ready as ${name}, ${this.hub.machines.size} machine(s)`);
      this.readyResolve();
      this.readyResolve = undefined;
    }
  }

  /** Machines the viewer may start work on — the smoke picks a target here. */
  machinesForSmoke(): Array<{ id: string; name: string }> {
    return this.hub.startableMachines().map((m) => ({ id: m.machine.machineId, name: m.machine.name }));
  }

  onOpened(frame: OpenedFrame): void {
    const waiting = this.pendingOpens.shift();
    const chatId = waiting?.chatId ?? this.lastActingChat;
    if (!chatId) return;
    const chat = this.store.chat(chatId);
    chat.runId = frame.runId;
    chat.machineId = frame.machineId;
    if (frame.sessionId) chat.sessionId = frame.sessionId;
    this.store.save();
    this.runOwner.set(frame.runId, chatId);
    this.startTyping(frame.runId, chatId);
  }

  onSessionStarted(frame: SessionStartedFrame): void {
    const chatId = this.runOwner.get(frame.runId);
    if (!chatId) return;
    const chat = this.store.chat(chatId);
    chat.sessionId = frame.sessionId;
    this.store.save();
  }

  onStream(frame: StreamFrame): void {
    const chatId = this.runOwner.get(frame.runId);
    if (chatId === undefined) return;
    const chat = this.store.chat(chatId);
    const turn = this.ensureTurn(frame.runId, chatId);

    switch (frame.event.kind) {
      case 'assistant': {
        const text = speech(frame.event.text ?? '');
        if (!text) break;
        turn.said = turn.said ? `${turn.said}\n\n${frame.event.text ?? ''}` : (frame.event.text ?? '');
        turn.spoke = true;
        this.say(chatId, text).then((sent) => {
          const last = sent.at(-1);
          if (!last) return;
          turn.lastMessageId = last.message_id;
          if (chat.machineId && chat.sessionId) {
            this.store.route(chatId, {
              messageId: last.message_id,
              machineId: chat.machineId,
              sessionId: chat.sessionId,
            });
          }
        });
        break;
      }
      case 'partial':
        // Deltas concatenate into exactly the `assistant` block that follows;
        // a messenger renders whole messages, so the block is the unit.
        break;
      case 'tool_use':
        if (chat.settings.verbose) {
          const line = toolLine(frame.event.text ?? '');
          if (line) void this.say(chatId, `<i>${escapeHtml(line)}</i>`);
        }
        break;
      case 'system':
      case 'status':
        if (chat.settings.verbose) {
          const line = oneLine(frame.event.text ?? '', 200);
          if (line) void this.say(chatId, `<i>${escapeHtml(line)}</i>`);
        }
        break;
      case 'error':
        turn.spoke = true;
        void this.say(chatId, `⚠️ ${escapeHtml(oneLine(frame.event.text ?? 'ошибка', 500))}`);
        break;
      case 'result':
        this.finishTurn(frame.runId);
        break;
      default:
        break;
    }
  }

  onRunStatus(frame: RunStatusFrame): void {
    const chatId = this.runOwner.get(frame.runId);
    if (chatId === undefined) return;
    switch (frame.state) {
      case 'started':
        this.startTyping(frame.runId, chatId);
        break;
      case 'idle':
        this.finishTurn(frame.runId);
        break;
      case 'ended':
      case 'yielded':
      case 'error': {
        this.finishTurn(frame.runId);
        this.runOwner.delete(frame.runId);
        const chat = this.store.chat(chatId);
        if (chat.runId === frame.runId) {
          chat.runId = undefined;
          this.store.save();
        }
        // `resume_refused`: the agent never started the run, so the message
        // (and its photo) that rode on the open was not delivered — say so,
        // or the person waits for an answer that is not coming.
        const refused = frame.code === 'resume_refused';
        const why =
          refused
            ? `⚠️ Сессию не удалось продолжить: ${escapeHtml(oneLine(frame.error ?? 'отказ', 200))}\nСообщение не доставлено — отправьте его ещё раз.`
            : frame.state === 'error'
              ? `⚠️ Сессия остановлена: ${escapeHtml(oneLine(frame.error ?? 'ошибка', 200))}`
              : frame.state === 'yielded'
                ? '🔒 Сессию забрал редактор на машине — здесь она отпущена.'
                : '✅ Сессия закрыта.';
        void this.say(chatId, why, { keyboard: [[{ text: '☰ Меню', callback_data: 'menu' }]] });
        break;
      }
      default:
        break;
    }
  }

  onToolRequest(frame: ToolRequestFrame): void {
    const chatId = this.runOwner.get(frame.runId);
    if (chatId === undefined) return;
    // The SAME request, delivered again, is not a second question.
    //
    // `requestId` is stable and the frame is re-sent on purpose from two
    // places: the agent replays a pending request on every `register_ack`
    // (run-manager.ts `announceState`) and the hub replays it on every
    // `subscribe` (hub.rs). This bot resubscribes to every run it drives each
    // time its socket reconnects (hub.ts), so a question that nobody has
    // answered yet gets re-delivered on each reconnect — and `presentTool`
    // posts a NEW Telegram message every time, leaving the earlier one on
    // screen with live buttons. That is the «два повтора вместо одного»: not
    // two questions, one question posted twice, with the older copy orphaned.
    //
    // `pendingTools` is one slot per chat, so the state was already correct —
    // only the message was duplicated. Checking the id here is the whole fix.
    if (this.pendingTools.get(chatId)?.requestId === frame.requestId) return;
    this.stopTyping(frame.runId);
    void this.presentTool(chatId, frame);
  }

  onActivity(runs: ActiveRunInfo[]): void {
    // Runs this bot drives already show their own stream; only work started
    // elsewhere (web, the app, a CLI on the machine) is worth a notification.
    const next = new Map(runs.map((r) => [r.runId, r.state]));
    if (!this.activitySeeded) {
      this.activitySeeded = true;
      for (const [runId, state] of next) this.prevRunState.set(runId, state);
      return;
    }
    for (const run of runs) {
      const before = this.prevRunState.get(run.runId);
      this.prevRunState.set(run.runId, run.state);
      if (before === run.state) continue;
      if (run.state !== 'needs_attention' && run.state !== 'error') continue;
      if (this.runOwner.has(run.runId)) continue;
      if (!this.isMine(run)) continue;
      // One pending approval can announce itself many times: the hub flips the
      // run back to `working` without clearing `pending_request_id`, so every
      // status frame and every agent reconnect replays the same request as a
      // fresh state change. Observed: twelve messages in four minutes for a
      // single prompt. The state machine belongs to the hub; what the bot can
      // do is refuse to say the same thing twice in a row.
      const now = Date.now();
      const last = this.lastNotifiedAt.get(run.runId);
      if (last !== undefined && now - last < NOTIFY_COOLDOWN_MS) continue;
      this.lastNotifiedAt.set(run.runId, now);
      this.notify(run);
    }
    for (const runId of [...this.prevRunState.keys()]) {
      if (!next.has(runId)) {
        this.prevRunState.delete(runId);
        this.lastNotifiedAt.delete(runId);
      }
    }
  }

  /**
   * Only work this account started.
   *
   * The bot sees the WHOLE fleet's activity — that is what an activity feed is —
   * and notified on every run that stopped for a question, including other
   * people's and including scripted loops. One Telegram account then carries the
   * attention of every machine, which is noise wearing the shape of a signal.
   *
   * A run with no owner is legacy or agent-started and stays silent: silence is
   * the safer default for a push, and the board still shows it.
   */
  private isMine(run: ActiveRunInfo): boolean {
    const me = this.hub.viewer?.userId;
    if (!me) return false;
    return run.ownerUserId === me;
  }

  onEnrich(frame: EnrichFrame): void {
    const waiter = this.enrichWaiters.get(frame.requestId);
    this.enrichWaiters.delete(frame.requestId);
    if (!waiter) return;
    if (!frame.ok) {
      // "enrichment not configured" is terminal — stop asking for this process.
      if ((frame.error ?? '').includes('not configured')) this.enrichOffered = false;
      return;
    }
    // An idea is meant for the draft, and a chat has no draft to put it in —
    // a tap here would send it outright. Only answers and next steps ride.
    // The button shows what it sends, whatever hub filled `label` with — and
    // only a text the keyboard can show unchanged (one line, ≤60) rides at all:
    // a clipped or folded button that sends the original is the bug this is.
    const shown = (frame.enrichment?.quickReplies ?? [])
      .filter((r) => r.kind !== 'idea' && oneLine(r.send, 60) === r.send)
      .map((r) => ({ label: r.send, send: r.send }));
    if (!shown.length) return;
    this.quickReplies.set(`${waiter.chatId}:${waiter.messageId}`, { runId: waiter.runId, replies: shown });
    // Bounded: the oldest keyboards stop answering, they never answer wrong.
    while (this.quickReplies.size > 200) {
      const oldest = this.quickReplies.keys().next().value;
      if (oldest === undefined) break;
      this.quickReplies.delete(oldest);
    }
    void this.tg.setKeyboard(waiter.chatId, waiter.messageId, turnControls(false, shown));
  }

  onHubError(message: string): void {
    const chatId = this.lastActingChat;
    if (chatId === undefined) {
      console.warn('[hub] error with no chat to blame:', message);
      return;
    }
    // The one refusal with a sanctioned way forward: force takeover.
    if (/second writer|is live in/i.test(message)) {
      void this.say(
        chatId,
        `🔒 ${escapeHtml(message)}\n\nМожно перехватить — редактор будет остановлен.`,
        { keyboard: [[{ text: '⚡️ Перехватить сессию', callback_data: 'tko' }], [{ text: '‹ Меню', callback_data: 'menu' }]] },
      );
      return;
    }
    void this.say(chatId, `⚠️ ${escapeHtml(message)}`);
  }

  onUnauthorized(): void {
    console.error('[bot] hub rejected the session');
    this.reauth?.();
  }

  /** Called when the hub refuses the credential, so the owner can re-mint one
   *  instead of the bot spinning on a socket it will never be allowed to open. */
  onNeedsAuth(handler: () => void): void {
    this.reauth = handler;
  }

  // -------------------------------------------------------- telegram updates

  async handleUpdate(update: TgUpdate): Promise<void> {
    // «Войти через Telegram» comes FIRST and returns: it is open to anyone,
    // and nothing it handles may reach the owner's paths below.
    if (update.callback_query) {
      const press = this.login ? parseLoginCallback(update.callback_query.data) : null;
      if (press) return this.login!.onCallback(update.callback_query, press);
      return this.onCallback(update.callback_query);
    }
    const message = update.message;
    if (!message) return;
    const loginCode = this.login ? parseLoginStart(message.text) : null;
    if (loginCode) return this.login!.onStart(message, loginCode);
    const from = message.from?.id;
    if (from === undefined) return;
    if (!this.cfg.allow.has(from)) {
      await this.tg.sendMessage(
        message.chat.id,
        this.login ? STRANGER_HINT : `Этот бот приватный.\nВаш Telegram id: <code>${from}</code>`,
      );
      console.warn(`[bot] refused ${from} (${message.from?.username ?? 'no username'})`);
      return;
    }
    this.lastActingChat = message.chat.id;
    await this.onMessage(message);
  }

  private async onMessage(message: TgMessage): Promise<void> {
    const chatId = message.chat.id;
    const chat = this.store.chat(chatId);
    const text = (message.text ?? message.caption ?? '').trim();

    if (text.startsWith('/')) {
      const command = text.split(/[\s@]/)[0] ?? '';
      const rest = text.slice(command.length).trim();
      if (await this.onCommand(chatId, command, rest)) return;
    }

    // Voice / video note -> the hub's transcription proxy, then treated as text.
    const audio = message.voice ?? message.audio ?? message.video_note;
    let body = text;
    if (audio) {
      await this.tg.chatAction(chatId, 'typing');
      const transcript = await this.transcribe(audio.file_id, message.voice?.mime_type);
      if (!transcript) {
        await this.say(chatId, '⚠️ Не удалось расшифровать голосовое.');
        return;
      }
      await this.say(chatId, `🎙 <i>${escapeHtml(transcript)}</i>`);
      body = body ? `${body}\n${transcript}` : transcript;
    }

    const images = await this.collectImages(message);

    // A reply to any message the bot sent for a session targets that session,
    // whatever the chat is currently pointed at.
    const route = message.reply_to_message
      ? this.store.findRoute(chatId, message.reply_to_message.message_id)
      : undefined;
    if (route) {
      chat.machineId = route.machineId;
      chat.sessionId = route.sessionId;
      const run = this.hub.runForSession(route.sessionId);
      chat.runId = run?.runId;
      this.store.save();
      if (run) this.attach(chatId, run.runId);
    }

    const pending = this.pendingTools.get(chatId);
    if (pending?.awaitingOther && body) {
      await this.answerOther(chatId, pending, body);
      return;
    }

    if (chat.awaiting && body) {
      await this.consumeAwaited(chatId, body, images);
      return;
    }

    if (!body && !images.length) return;

    if (chat.runId) {
      this.hub.send({ type: 'input', runId: chat.runId, text: body, ...(images.length ? { images } : {}) });
      this.startTyping(chat.runId, chatId);
      return;
    }

    if (chat.sessionId && chat.machineId) {
      await this.openSession(chatId, chat.machineId, chat.sessionId, body, images);
      return;
    }

    await this.show(chatId, this.menu(chatId));
  }

  /** Returns true when the command was handled and the message is spent. */
  private async onCommand(chatId: number, command: string, rest: string): Promise<boolean> {
    const chat = this.store.chat(chatId);
    switch (command) {
      case '/start':
      case '/menu':
        chat.awaiting = undefined;
        this.store.save();
        await this.show(chatId, this.menu(chatId));
        return true;
      case '/new':
        await this.startNew(chatId);
        return true;
      case '/projects':
        await this.showProjects(chatId, 0);
        return true;
      case '/sessions':
        await this.showSessions(chatId, 0);
        return true;
      case '/settings':
        await this.show(chatId, settingsScreen(chat));
        return true;
      case '/stop':
        if (chat.runId) this.hub.send({ type: 'interrupt', runId: chat.runId });
        await this.say(chatId, chat.runId ? '⏹ Останавливаю.' : 'Нечего останавливать.');
        return true;
      case '/end':
        if (chat.runId) this.hub.send({ type: 'close', runId: chat.runId });
        return true;
      case '/cancel':
        chat.awaiting = undefined;
        this.store.save();
        await this.say(chatId, 'Отменено.');
        return true;
      case '/whoami': {
        const viewer = this.hub.viewer;
        await this.say(
          chatId,
          `Хаб: <b>${escapeHtml(viewer?.email ?? 'нет соединения')}</b>\n` +
            `Машин онлайн: ${this.hub.startableMachines().length}\n` +
            `Проект: ${chat.cwd ? escapeHtml(projectLabel(chat.cwd)) : '—'}`,
        );
        return true;
      }
      default:
        // Anything else starting with `/` is a slash command FOR THE AGENT
        // (e.g. `/verify`), so it falls through to the normal input path.
        return false;
    }
  }

  private async onCallback(cb: TgCallbackQuery): Promise<void> {
    const chatId = cb.message?.chat.id;
    if (chatId === undefined || !this.cfg.allow.has(cb.from.id)) {
      await this.tg.answerCallback(cb.id, 'Недоступно');
      return;
    }
    this.lastActingChat = chatId;
    const chat = this.store.chat(chatId);
    const data = cb.data ?? '';
    const [head = '', arg = ''] = splitOnce(data, ':');
    await this.tg.answerCallback(cb.id);

    switch (head) {
      case 'noop':
        return;
      case WAITLIST_CALLBACK: {
        const problem = await this.waitlist.activate(arg);
        if (problem) await this.say(chatId, `⚠️ ${escapeHtml(problem)}`);
        return;
      }
      case 'menu':
        return this.show(chatId, this.menu(chatId));
      case 'mach': {
        const machines = this.hub.startableMachines();
        chat.lastMachines = machines.map((m) => m.machine.machineId);
        this.store.save();
        return this.show(chatId, machinesScreen(machines, chat.machineId));
      }
      case 'm': {
        const machineId = chat.lastMachines?.[Number(arg)];
        if (!machineId) return this.show(chatId, this.menu(chatId));
        chat.machineId = machineId;
        chat.cwd = undefined;
        chat.sessionId = undefined;
        chat.runId = undefined;
        this.store.save();
        return this.showProjects(chatId, 0);
      }
      case 'proj':
        return this.showProjects(chatId, Number(arg) || 0);
      case 'p': {
        const cwd = chat.lastProjects?.[Number(arg)];
        if (!cwd) return this.showProjects(chatId, 0);
        chat.cwd = cwd;
        chat.sessionId = undefined;
        chat.runId = undefined;
        this.store.save();
        return this.showSessions(chatId, 0);
      }
      case 'pnew':
        chat.awaiting = { kind: 'project_name', machineId: this.machineFor(chat.machineId) ?? '' };
        this.store.save();
        return this.tell(
          chatId,
          'Имя нового проекта — строчными буквами, можно дефис.\n' +
            'Чтобы склонировать репозиторий, пришли имя и https-ссылку через пробел.',
        );
      case 'sess':
        return this.showSessions(chatId, Number(arg) || 0);
      case 's': {
        const sessionId = chat.lastSessions?.[Number(arg)];
        const machineId = this.machineFor(chat.machineId);
        if (!sessionId || !machineId) return this.showSessions(chatId, 0);
        return this.openSession(chatId, machineId, sessionId);
      }
      case 'new':
        return this.startNew(chatId);
      case 'catall':
      case 'cat': {
        const machineId = this.machineFor(chat.machineId);
        const cwd = chat.cwd;
        if (!machineId || !cwd) return this.show(chatId, this.menu(chatId));
        if (head === 'catall') {
          return this.show(chatId, categoriesScreen(this.hub.machines.get(machineId), cwd, true));
        }
        const parsed = SessionCategory.safeParse(arg);
        chat.awaiting = {
          kind: 'new_session',
          machineId,
          cwd,
          ...(parsed.success ? { category: parsed.data } : {}),
        };
        this.store.save();
        return this.show(chatId, composeScreen(cwd, parsed.success ? parsed.data : undefined, false));
      }
      case 'hints': {
        const awaiting = chat.awaiting;
        if (awaiting?.kind !== 'new_session') return;
        return this.show(chatId, composeScreen(awaiting.cwd, awaiting.category, true));
      }
      case 'fp': {
        const awaiting = chat.awaiting;
        if (awaiting?.kind !== 'new_session') return;
        const prompt = firstPrompt(awaiting.category, Number(arg));
        if (!prompt) return;
        return this.consumeAwaited(chatId, prompt, []);
      }
      case 'go': {
        const awaiting = chat.awaiting;
        if (awaiting?.kind !== 'new_session') return;
        return this.consumeAwaited(chatId, '', []);
      }
      case 'att':
        return this.show(chatId, attentionScreen([...this.hub.runs.values()]));
      case 'r': {
        const run = this.hub.runs.get(arg);
        if (!run) return this.tell(chatId, 'Этот запуск уже закрыт.');
        chat.machineId = run.machineId;
        chat.sessionId = run.sessionId;
        chat.runId = run.runId;
        this.store.save();
        this.attach(chatId, run.runId);
        return this.tell(
          chatId,
          `Подключился к <b>${escapeHtml(oneLine(run.title ?? 'сессии', 60))}</b>. Пиши сюда.`,
          { keyboard: turnControls(run.state === 'working') },
        );
      }
      case 'stop':
        if (chat.runId) this.hub.send({ type: 'interrupt', runId: chat.runId });
        return;
      case 'end':
        if (chat.runId) this.hub.send({ type: 'close', runId: chat.runId });
        return;
      case 'hist':
        return this.showHistory(chatId);
      case 'tko': {
        const machineId = this.machineFor(chat.machineId);
        if (!machineId || !chat.sessionId) return;
        this.pendingOpens.push({ chatId });
        this.hub.send({ type: 'takeover', machineId, sessionId: chat.sessionId });
        return this.tell(chatId, '⚡️ Перехватываю сессию…');
      }
      case 'set':
        if (arg === 'v') chat.settings.verbose = !chat.settings.verbose;
        if (arg === 's') chat.settings.suggest = !chat.settings.suggest;
        if (arg === 'n') chat.settings.notify = !chat.settings.notify;
        this.store.save();
        return this.show(chatId, settingsScreen(chat));
      case 'qr': {
        const entry = this.quickReplies.get(`${chatId}:${cb.message?.message_id}`);
        const reply = entry?.replies[Number(arg)];
        // An old keyboard answers only the session it was made for.
        if (!reply || !chat.runId || entry?.runId !== chat.runId) return;
        await this.say(chatId, `💬 <i>${escapeHtml(reply.label)}</i>`);
        this.hub.send({ type: 'input', runId: chat.runId, text: reply.send });
        this.startTyping(chat.runId, chatId);
        return;
      }
      case 'ta':
      case 'td':
      case 'tw':
        return this.decideSimple(chatId, cb, head);
      case 'pl':
        return this.decidePlan(chatId, cb, arg);
      case 'q':
        return this.pickOption(chatId, cb, arg);
      case 'qd':
        return this.nextQuestion(chatId, cb);
      case 'qo': {
        const pending = this.pendingTools.get(chatId);
        if (!pending) return;
        pending.awaitingOther = true;
        return this.tell(chatId, '✍️ Напиши свой ответ одним сообщением.');
      }
      default:
        return;
    }
  }

  // ------------------------------------------------------------------ screens

  private menu(chatId: number): Screen {
    const chat = this.store.chat(chatId);
    const machineId = this.machineFor(chat.machineId);
    const machine = machineId ? this.hub.machines.get(machineId) : undefined;
    const attention = [...this.hub.runs.values()].filter(
      (r) => r.state === 'needs_attention' || r.state === 'error',
    ).length;
    return mainMenu(chat, machine?.machine.name, attention);
  }

  private async showProjects(chatId: number, page: number): Promise<void> {
    const chat = this.store.chat(chatId);
    const machineId = this.machineFor(chat.machineId);
    if (!machineId) {
      const machines = this.hub.startableMachines();
      chat.lastMachines = machines.map((m) => m.machine.machineId);
      this.store.save();
      await this.show(chatId, machinesScreen(machines, undefined));
      return;
    }
    chat.machineId = machineId;
    let projects: Array<{ cwd: string; label: string; count: number; lastModified: number }> = [];
    try {
      const result = await this.hub.rpc(machineId, 'projects.list', {});
      projects = result.projects;
    } catch (err) {
      await this.say(chatId, `⚠️ Не удалось получить проекты: ${escapeHtml(String(err))}`);
      return;
    }
    projects.sort((a, b) => b.lastModified - a.lastModified);
    chat.lastProjects = projects.map((p) => p.cwd);
    this.store.save();
    await this.show(chatId, projectsScreen(projects, page, chat.cwd));
  }

  private async showSessions(chatId: number, page: number): Promise<void> {
    const chat = this.store.chat(chatId);
    const machineId = this.machineFor(chat.machineId);
    if (!machineId) return this.showProjects(chatId, 0);
    const sessions = this.hub.sessionsFor(machineId, chat.cwd);
    chat.lastSessions = sessions.map((s) => s.sessionId);
    this.store.save();
    await this.show(chatId, sessionsScreen(sessions, this.hub.runs, page, chat.cwd));
  }

  private async startNew(chatId: number): Promise<void> {
    const chat = this.store.chat(chatId);
    const machineId = this.machineFor(chat.machineId);
    if (!machineId) return this.showProjects(chatId, 0);
    if (!chat.cwd) return this.showProjects(chatId, 0);
    await this.show(chatId, categoriesScreen(this.hub.machines.get(machineId), chat.cwd, false));
  }

  private async showHistory(chatId: number): Promise<void> {
    const chat = this.store.chat(chatId);
    const machineId = this.machineFor(chat.machineId);
    if (!machineId || !chat.sessionId || !chat.cwd) {
      await this.say(chatId, 'Сначала выбери сессию.');
      return;
    }
    try {
      const result = await this.hub.rpc(machineId, 'session.messages', {
        cwd: chat.cwd,
        sessionId: chat.sessionId,
        // Most messages in a real transcript are tool calls and their results,
        // so a tail of 40 yields about three readable turns. Ask for many more
        // and let the renderer's budget decide what fits.
        limit: 400,
        // Tool payloads are 95-99% of a transcript and nothing here renders
        // them; a zero cap keeps structure without shipping file dumps.
        toolChars: 0,
      });
      const turns = historyTurns(result.messages);
      if (!turns.length) {
        await this.say(chatId, 'В этой сессии пока нечего показать.', { keyboard: turnControls(false) });
        return;
      }
      const summary = this.hub.session_(machineId, chat.sessionId);
      const doc = historyDocument(turns);
      const header =
        `<b>${escapeHtml(oneLine(summary?.title ?? 'Сессия', 70))}</b>\n` +
        `<code>${escapeHtml(projectLabel(chat.cwd))} · ${plural(turns.length, ['ход', 'хода', 'ходов'])}` +
        `${doc.omitted ? `, показаны последние ${doc.shown}` : ''}</code>`;
      await this.say(chatId, `${header}\n\n${doc.text}`, { keyboard: turnControls(false) });
    } catch (err) {
      await this.say(chatId, `⚠️ История недоступна: ${escapeHtml(String(err))}`);
    }
  }

  // ------------------------------------------------------------- session ops

  private async openSession(
    chatId: number,
    machineId: string,
    sessionId: string,
    message = '',
    images: ImageInput[] = [],
  ): Promise<void> {
    const chat = this.store.chat(chatId);
    chat.machineId = machineId;
    chat.sessionId = sessionId;
    const summary = this.hub.session_(machineId, sessionId);
    if (summary?.cwd) chat.cwd = summary.cwd;
    this.store.save();

    const existing = this.hub.runForSession(sessionId);
    if (existing) {
      chat.runId = existing.runId;
      this.store.save();
      this.attach(chatId, existing.runId);
      if (message || images.length) {
        this.hub.send({
          type: 'input',
          runId: existing.runId,
          text: message,
          ...(images.length ? { images } : {}),
        });
        this.startTyping(existing.runId, chatId);
      } else {
        await this.say(chatId, `Подключился. Пиши сюда.`, { keyboard: turnControls(existing.state === 'working') });
      }
      return;
    }

    this.pendingOpens.push({ chatId });
    this.hub.send({
      type: 'open',
      machineId,
      sessionId,
      ...(message ? { message } : {}),
      ...(images.length ? { images } : {}),
    });
    if (!message && !images.length) {
      await this.say(
        chatId,
        `<b>${escapeHtml(oneLine(summary?.title ?? 'Сессия', 60))}</b>\n` +
          `${summary?.lastModified ? escapeHtml(ago(summary.lastModified)) : ''} · пиши сюда, чтобы продолжить.`,
        { keyboard: turnControls(false) },
      );
    }
  }

  /** Consume whatever the chat was waiting for. */
  private async consumeAwaited(chatId: number, body: string, images: ImageInput[]): Promise<void> {
    const chat = this.store.chat(chatId);
    const awaiting = chat.awaiting;
    if (!awaiting) return;

    if (awaiting.kind === 'new_session') {
      chat.awaiting = undefined;
      chat.sessionId = undefined;
      chat.runId = undefined;
      this.store.save();
      this.pendingOpens.push({ chatId });
      this.hub.send({
        type: 'new_session',
        machineId: awaiting.machineId,
        cwd: awaiting.cwd,
        ...(body ? { message: body } : {}),
        ...(images.length ? { images } : {}),
        ...(awaiting.category ? { category: SessionCategory.parse(awaiting.category) } : {}),
      });
      await this.say(chatId, '▶️ Запускаю…');
      return;
    }

    if (awaiting.kind === 'project_name') {
      chat.awaiting = undefined;
      this.store.save();
      const [name = '', url = ''] = body.split(/\s+/);
      const machineId = this.machineFor(chat.machineId);
      if (!machineId) return;
      try {
        const result = await this.hub.rpc(machineId, 'projects.create', {
          name,
          ...(url.startsWith('https://') ? { gitUrl: url } : {}),
        });
        chat.cwd = result.cwd;
        this.store.save();
        await this.say(
          chatId,
          `📁 Проект <b>${escapeHtml(result.label)}</b> готов (${result.git === 'clone' ? 'клон' : 'новый репозиторий'}).`,
        );
        await this.startNew(chatId);
      } catch (err) {
        await this.say(chatId, `⚠️ Не получилось создать проект: ${escapeHtml(String(err))}`);
      }
      return;
    }
  }

  private attach(chatId: number, runId: string): void {
    this.runOwner.set(runId, chatId);
    this.hub.subscribe(runId);
  }

  private machineFor(preferred: string | undefined): string | undefined {
    if (preferred && this.hub.machines.has(preferred)) return preferred;
    const machines = this.hub.startableMachines();
    return machines.length === 1 ? machines[0]?.machine.machineId : undefined;
  }

  // ----------------------------------------------------------------- approvals

  private async presentTool(chatId: number, frame: ToolRequestFrame): Promise<void> {
    const input = (frame.input ?? {}) as Record<string, unknown>;
    const base: Omit<PendingTool, 'messageId'> = {
      runId: frame.runId,
      requestId: frame.requestId,
      tool: frame.tool,
      input,
      questions: [],
      qi: 0,
      picked: new Set<string>(),
      answers: {},
      awaitingOther: false,
    };

    if (frame.tool === 'AskUserQuestion') {
      const questions = normalizeQuestions(input['questions']);
      if (questions.length) {
        const first = questions[0];
        if (!first) return;
        const sent = await this.say(chatId, questionText(first), { keyboard: questionKeyboard(first, new Set()) });
        const messageId = sent.at(-1)?.message_id;
        if (messageId === undefined) return;
        this.pendingTools.set(chatId, { ...base, questions, messageId });
        return;
      }
    }

    if (frame.tool === 'ExitPlanMode') {
      const plan = typeof input['plan'] === 'string' ? (input['plan'] as string) : '';
      const sent = await this.say(
        chatId,
        `📋 <b>План готов</b>\n\n${speech(plan) || 'Продолжаем по плану?'}`,
        {
          keyboard: [
            [{ text: '✅ Принять, правки показывать', callback_data: 'pl:review' }],
            [{ text: '⚡️ Принять и не спрашивать про правки', callback_data: 'pl:auto' }],
            [{ text: '✍️ Ещё планируем', callback_data: 'pl:keep' }],
          ],
        },
      );
      const messageId = sent.at(-1)?.message_id;
      if (messageId === undefined) return;
      this.pendingTools.set(chatId, { ...base, messageId });
      return;
    }

    const title = frame.title ?? `${frame.tool}?`;
    const detail = describeInput(input);
    const sent = await this.say(
      chatId,
      `🔐 <b>${escapeHtml(frame.tool)}</b>\n${escapeHtml(oneLine(title, 200))}` +
        (detail ? `\n<pre>${escapeHtml(detail)}</pre>` : ''),
      {
        keyboard: [
          [
            { text: '✅ Разрешить', callback_data: 'ta' },
            { text: '🚫 Отклонить', callback_data: 'td' },
          ],
          [{ text: '⚡️ Принимать правки без вопросов', callback_data: 'tw' }],
        ],
      },
    );
    const messageId = sent.at(-1)?.message_id;
    if (messageId === undefined) return;
    this.pendingTools.set(chatId, { ...base, messageId });
  }

  /** Guard against a tap on an approval that was already decided. */
  private takePending(chatId: number, cb: TgCallbackQuery): PendingTool | undefined {
    const pending = this.pendingTools.get(chatId);
    if (!pending) return undefined;
    if (cb.message && cb.message.message_id !== pending.messageId) return undefined;
    return pending;
  }

  private async decideSimple(chatId: number, cb: TgCallbackQuery, head: string): Promise<void> {
    const pending = this.takePending(chatId, cb);
    if (!pending) return;
    this.pendingTools.delete(chatId);
    await this.tg.clearKeyboard(chatId, pending.messageId);
    const allow = head !== 'td';
    this.hub.send({
      type: 'tool_decision',
      runId: pending.runId,
      requestId: pending.requestId,
      allow,
      ...(allow ? { updatedInput: { ...pending.input } } : {}),
      ...(head === 'tw' ? { permissionMode: 'acceptEdits' as const } : {}),
    });
    if (allow) this.startTyping(pending.runId, chatId);
  }

  private async decidePlan(chatId: number, cb: TgCallbackQuery, choice: string): Promise<void> {
    const pending = this.takePending(chatId, cb);
    if (!pending) return;
    this.pendingTools.delete(chatId);
    await this.tg.clearKeyboard(chatId, pending.messageId);
    if (choice === 'keep') {
      this.hub.send({ type: 'tool_decision', runId: pending.runId, requestId: pending.requestId, allow: false });
      return;
    }
    this.hub.send({
      type: 'tool_decision',
      runId: pending.runId,
      requestId: pending.requestId,
      allow: true,
      updatedInput: { ...pending.input },
      permissionMode: choice === 'auto' ? 'acceptEdits' : 'default',
    });
    this.startTyping(pending.runId, chatId);
  }

  private async pickOption(chatId: number, cb: TgCallbackQuery, arg: string): Promise<void> {
    const pending = this.takePending(chatId, cb);
    if (!pending) return;
    const question = pending.questions[pending.qi];
    if (!question) return;
    const index = Number(arg);
    const label = index === -1 ? OTHER : question.options[index]?.label;
    if (!label) return;

    if (question.multiSelect) {
      if (pending.picked.has(label)) pending.picked.delete(label);
      else pending.picked.add(label);
      await this.tg.setKeyboard(chatId, pending.messageId, questionKeyboard(question, pending.picked));
      return;
    }
    pending.picked = new Set([label]);
    await this.nextQuestion(chatId, cb);
  }

  private async answerOther(chatId: number, pending: PendingTool, text: string): Promise<void> {
    pending.awaitingOther = false;
    const question = pending.questions[pending.qi];
    if (!question) return;
    pending.picked = new Set([text]);
    await this.commitQuestion(chatId, pending);
  }

  private async nextQuestion(chatId: number, cb: TgCallbackQuery): Promise<void> {
    const pending = this.takePending(chatId, cb);
    if (!pending) return;
    await this.commitQuestion(chatId, pending);
  }

  private async commitQuestion(chatId: number, pending: PendingTool): Promise<void> {
    const question = pending.questions[pending.qi];
    if (!question) return;
    const labels = [...pending.picked].filter(Boolean);
    if (!labels.length) return;
    pending.answers[answerKey(question)] = question.multiSelect ? labels : (labels[0] as string);
    pending.picked = new Set();
    pending.qi += 1;

    const next = pending.questions[pending.qi];
    if (next) {
      const sent = await this.say(chatId, questionText(next), { keyboard: questionKeyboard(next, new Set()) });
      const messageId = sent.at(-1)?.message_id;
      if (messageId !== undefined) pending.messageId = messageId;
      return;
    }

    this.pendingTools.delete(chatId);
    await this.tg.clearKeyboard(chatId, pending.messageId);
    this.hub.send({
      type: 'tool_decision',
      runId: pending.runId,
      requestId: pending.requestId,
      allow: true,
      updatedInput: { ...pending.input, answers: pending.answers },
    });
    this.startTyping(pending.runId, chatId);
  }

  // -------------------------------------------------------------- turn plumbing

  private ensureTurn(runId: string, chatId: number): Turn {
    const existing = this.turns.get(runId);
    if (existing) return existing;
    const turn: Turn = { chatId, said: '', spoke: false };
    this.turns.set(runId, turn);
    return turn;
  }

  private startTyping(runId: string, chatId: number): void {
    const turn = this.ensureTurn(runId, chatId);
    if (turn.typing) return;
    void this.tg.chatAction(chatId);
    turn.typing = setInterval(() => void this.tg.chatAction(chatId), TYPING_MS);
    turn.typing.unref?.();
  }

  private stopTyping(runId: string): void {
    const turn = this.turns.get(runId);
    if (turn?.typing) {
      clearInterval(turn.typing);
      turn.typing = undefined;
    }
  }

  /**
   * A turn ended. The controls go ON the last thing the agent said — a quiet
   * chat should not grow a "done" message every time.
   */
  private finishTurn(runId: string): void {
    const turn = this.turns.get(runId);
    if (!turn) return;
    this.stopTyping(runId);
    this.turns.delete(runId);
    const chatId = turn.chatId;
    const chat = this.store.chat(chatId);
    const working = false;

    void this.enqueue(chatId, async () => {
      if (turn.lastMessageId !== undefined) {
        await this.tg.setKeyboard(chatId, turn.lastMessageId, turnControls(working));
      } else if (!turn.spoke) {
        const sent = await this.tg.sendMessage(chatId, '✓ Готово.', { keyboard: turnControls(working) });
        turn.lastMessageId = sent.at(-1)?.message_id;
      }
      if (chat.settings.suggest && this.enrichOffered && turn.said && turn.lastMessageId !== undefined) {
        this.requestEnrichment(chatId, turn, turn.lastMessageId);
      }
    });
  }

  private requestEnrichment(chatId: number, turn: Turn, messageId: number): void {
    const chat = this.store.chat(chatId);
    const machineId = this.machineFor(chat.machineId);
    if (!machineId || !chat.sessionId) return;
    const requestId = `tg-enrich-${++this.enrichSeq}`;
    // The run the buttons answer — captured now, so a later switch of the
    // chat to another session cannot route this turn's reply into it.
    this.enrichWaiters.set(requestId, { chatId, messageId, runId: chat.runId });
    this.hub.send({
      type: 'enrich_request',
      requestId,
      machineId,
      sessionId: chat.sessionId,
      uuid: `${chat.sessionId}:${messageId}`,
      text: turn.said.slice(-16_000),
    });
  }

  private notify(run: ActiveRunInfo): void {
    for (const chatId of this.store.chatIds()) {
      const chat = this.store.chat(chatId);
      if (!chat.settings.notify) continue;
      void this.enqueue(chatId, async () => {
        const sent = await this.tg.sendMessage(
          chatId,
          `${run.state === 'error' ? '🟥' : '🟧'} <b>${escapeHtml(oneLine(run.title ?? 'Сессия', 60))}</b>` +
            `${run.project ? ` · ${escapeHtml(run.project)}` : ''}\n` +
            `${escapeHtml(notifyBody(run))}`,
          { keyboard: [[{ text: 'Открыть', callback_data: `r:${run.runId}` }]] },
        );
        const last = sent.at(-1);
        if (last) {
          this.store.route(chatId, {
            messageId: last.message_id,
            machineId: run.machineId,
            sessionId: run.sessionId,
          });
        }
      });
    }
  }

  // ------------------------------------------------------------------- media

  private async collectImages(message: TgMessage): Promise<ImageInput[]> {
    const photo = message.photo?.at(-1);
    const doc = message.document;
    const fileId =
      photo?.file_id ??
      (doc && /^image\/(png|jpeg|gif|webp)$/.test(doc.mime_type ?? '') ? doc.file_id : undefined);
    if (!fileId) return [];
    try {
      const file = await this.tg.download(fileId);
      if (file.bytes.byteLength > MAX_IMAGE_BYTES) {
        await this.say(message.chat.id, '⚠️ Картинка слишком большая, пропускаю.');
        return [];
      }
      const mediaType = photo
        ? 'image/jpeg'
        : ((doc?.mime_type ?? 'image/png') as ImageInput['media_type']);
      return [{ media_type: mediaType, data: file.bytes.toString('base64') }];
    } catch (err) {
      console.warn('[bot] image download failed', err);
      return [];
    }
  }

  /** Telegram voice is OGG/opus; the hub proxies it to Azure and returns text. */
  private async transcribe(fileId: string, mime?: string): Promise<string | undefined> {
    try {
      const file = await this.tg.download(fileId);
      const res = await fetch(`${this.cfg.http}/transcribe`, {
        method: 'POST',
        headers: {
          'content-type': mime ?? 'audio/ogg',
          authorization: `Bearer ${this.store.session ?? ''}`,
          'sec-fetch-site': 'same-origin',
        },
        body: new Uint8Array(file.bytes),
      });
      if (!res.ok) {
        console.warn(`[bot] transcribe ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return undefined;
      }
      const body = (await res.json()) as { text?: string };
      return body.text?.trim() || undefined;
    } catch (err) {
      console.warn('[bot] transcribe failed', err);
      return undefined;
    }
  }

  // ------------------------------------------------------------------ sending

  /** `say` that discards the sent messages, for the many handlers whose whole
   *  job is "answer, then return". */
  private async tell(
    chatId: number,
    text: string,
    opts: { keyboard?: InlineKeyboard } = {},
  ): Promise<void> {
    await this.say(chatId, text, opts);
  }

  private async show(chatId: number, screen: Screen): Promise<void> {
    await this.say(chatId, screen.text, { keyboard: screen.keyboard });
  }

  private say(
    chatId: number,
    text: string,
    opts: { keyboard?: InlineKeyboard } = {},
  ): Promise<TgMessage[]> {
    return this.enqueue(chatId, () => this.tg.sendMessage(chatId, text, opts));
  }

  /** One outbound message at a time per chat: awaits inside handlers would
   *  otherwise interleave and print a turn out of order. */
  private enqueue<T>(chatId: number, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(chatId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.queues.set(
      chatId,
      next.catch((err: unknown) => console.error('[bot] send failed', err)),
    );
    return next;
  }
}

function splitOnce(value: string, sep: string): [string, string] {
  const at = value.indexOf(sep);
  return at < 0 ? [value, ''] : [value.slice(0, at), value.slice(at + 1)];
}

function questionText(question: AskQuestion): string {
  const header = question.header ? `<b>${escapeHtml(question.header)}</b>\n` : '';
  const hint = question.multiSelect ? '\n\n<i>Можно выбрать несколько, потом «Готово».</i>' : '';
  return `❓ ${header}${escapeHtml(question.question)}${hint}`;
}

function questionKeyboard(question: AskQuestion, picked: Set<string>): InlineKeyboard {
  const keyboard: InlineKeyboard = question.options.map((option, index) => [
    {
      text: `${picked.has(option.label) ? '✅ ' : ''}${oneLine(option.label, 50)}`,
      callback_data: `q:${index}`,
    },
  ]);
  keyboard.push([{ text: '✍️ Свой ответ', callback_data: 'qo' }]);
  if (question.multiSelect) keyboard.push([{ text: 'Готово', callback_data: 'qd' }]);
  return keyboard;
}

/** The one field of a tool's input worth showing above the buttons. */
function describeInput(input: Record<string, unknown>): string {
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'prompt']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return oneLine(value, 300);
  }
  return '';
}
