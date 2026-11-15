/**
 * A hand-rolled Telegram Bot API client.
 *
 * The surface this bot needs is small — long-poll updates, send/edit a message,
 * answer a callback, pull a voice file — and anything added here ships to the
 * hub box, so it stays dependency-free on top of `fetch`.
 *
 * Two behaviours are load-bearing and easy to get wrong:
 *  - On start the backlog is DROPPED (`skipBacklog`). Telegram redelivers every
 *    unconfirmed update, so without this a restart replays yesterday's taps —
 *    which here means re-running buttons against real machines.
 *  - `sendMessage` retries once without `parse_mode` when Telegram rejects the
 *    entities. Model output contains stray `<` and unbalanced `*` constantly;
 *    losing the whole message to a formatting error is worse than losing bold.
 */

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TgPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string };
  date: number;
  text?: string;
  caption?: string;
  reply_to_message?: TgMessage;
  voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
  audio?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
  video_note?: { file_id: string; duration: number; file_size?: number };
  photo?: TgPhotoSize[];
  document?: { file_id: string; mime_type?: string; file_name?: string; file_size?: number };
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export type InlineKeyboard = InlineButton[][];

export interface SendOptions {
  keyboard?: InlineKeyboard;
  replyTo?: number;
  /** Default true. Set false only for text that is already plain. */
  html?: boolean;
  disablePreview?: boolean;
  silent?: boolean;
}

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(`${method}: ${code} ${description}`);
    this.name = 'TelegramError';
  }
}

/** Telegram's hard cap is 4096 UTF-16 code units; leave room for our own suffixes. */
export const MAX_TEXT = 3800;

const CALLBACK_MAX_BYTES = 64;

export class Telegram {
  private offset = 0;
  private stopped = false;

  constructor(private readonly token: string) {}

  private api(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  async call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.api(method), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (!body.ok) {
      throw new TelegramError(
        method,
        body.error_code ?? res.status,
        body.description ?? 'unknown error',
        body.parameters?.retry_after,
      );
    }
    return body.result as T;
  }

  async getMe(): Promise<TgUser> {
    return this.call<TgUser>('getMe');
  }

  /**
   * Send text, splitting at `MAX_TEXT`. Returns the messages actually sent, in
   * order — callers that need an id (to edit, or to route a reply back into a
   * session) want the LAST one, which is where the keyboard lands.
   */
  async sendMessage(chatId: number, text: string, opts: SendOptions = {}): Promise<TgMessage[]> {
    const parts = splitText(text, MAX_TEXT);
    const sent: TgMessage[] = [];
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      const params: Record<string, unknown> = {
        chat_id: chatId,
        text: parts[i],
        link_preview_options: { is_disabled: opts.disablePreview !== false },
      };
      if (opts.html !== false) params['parse_mode'] = 'HTML';
      if (last && opts.keyboard) params['reply_markup'] = { inline_keyboard: opts.keyboard };
      if (i === 0 && opts.replyTo) {
        params['reply_parameters'] = { message_id: opts.replyTo, allow_sending_without_reply: true };
      }
      if (opts.silent) params['disable_notification'] = true;
      sent.push(await this.sendGuarded(params));
    }
    return sent;
  }

  /** One send with the entity-error fallback. */
  private async sendGuarded(params: Record<string, unknown>): Promise<TgMessage> {
    try {
      return await this.call<TgMessage>('sendMessage', params);
    } catch (err) {
      if (err instanceof TelegramError && isEntityError(err)) {
        const plain = { ...params };
        delete plain['parse_mode'];
        plain['text'] = stripTags(String(params['text'] ?? ''));
        return this.call<TgMessage>('sendMessage', plain);
      }
      throw err;
    }
  }

  /** Edit in place. Returns false when Telegram refuses (message gone, or the
   *  text is byte-identical — both are normal, neither is worth an exception). */
  async editMessage(
    chatId: number,
    messageId: number,
    text: string,
    opts: SendOptions = {},
  ): Promise<boolean> {
    const params: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text: text.slice(0, MAX_TEXT),
      link_preview_options: { is_disabled: opts.disablePreview !== false },
    };
    if (opts.html !== false) params['parse_mode'] = 'HTML';
    if (opts.keyboard) params['reply_markup'] = { inline_keyboard: opts.keyboard };
    try {
      await this.call('editMessageText', params);
      return true;
    } catch (err) {
      if (err instanceof TelegramError && isEntityError(err)) {
        try {
          const plain = { ...params };
          delete plain['parse_mode'];
          plain['text'] = stripTags(String(params['text'] ?? ''));
          await this.call('editMessageText', plain);
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
  }

  /** Put buttons on an already-sent message. This is how a finished turn grows
   *  its controls without the bot adding a second message nobody asked for. */
  async setKeyboard(chatId: number, messageId: number, keyboard: InlineKeyboard): Promise<boolean> {
    try {
      await this.call('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: keyboard },
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Drop a message's buttons without touching its text — how a decided
   *  approval stops being tappable a second time. */
  async clearKeyboard(chatId: number, messageId: number): Promise<void> {
    try {
      await this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId });
    } catch {
      /* the message may be gone; nothing to clean up */
    }
  }

  async answerCallback(id: string, text?: string, alert = false): Promise<void> {
    try {
      await this.call('answerCallbackQuery', {
        callback_query_id: id,
        ...(text ? { text: text.slice(0, 200), show_alert: alert } : {}),
      });
    } catch {
      /* a callback answered late is not an error worth surfacing */
    }
  }

  async chatAction(chatId: number, action = 'typing'): Promise<void> {
    try {
      await this.call('sendChatAction', { chat_id: chatId, action });
    } catch {
      /* best-effort */
    }
  }

  async setCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
    await this.call('setMyCommands', { commands });
  }

  /** Download a file by id. Telegram caps bot downloads at 20 MB. */
  async download(fileId: string): Promise<{ bytes: Buffer; path: string }> {
    const file = await this.call<{ file_path?: string }>('getFile', { file_id: fileId });
    const filePath = file.file_path;
    if (!filePath) throw new Error('getFile returned no file_path');
    const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${filePath}`);
    if (!res.ok) throw new Error(`file download failed: ${res.status}`);
    return { bytes: Buffer.from(await res.arrayBuffer()), path: filePath };
  }

  /**
   * Confirm every pending update without acting on it, so a restart starts from
   * "now". Without this, systemd restarting the bot replays every button tap
   * Telegram still holds — against live machines.
   */
  async skipBacklog(): Promise<void> {
    const updates = await this.call<TgUpdate[]>('getUpdates', { offset: -1, timeout: 0 });
    const last = updates.at(-1);
    if (last) this.offset = last.update_id + 1;
  }

  stop(): void {
    this.stopped = true;
  }

  /** Long-poll forever. `onUpdate` failures are logged, never fatal: one bad
   *  update must not take the loop down and strand every chat. */
  async run(onUpdate: (update: TgUpdate) => Promise<void>): Promise<void> {
    let backoff = 1000;
    while (!this.stopped) {
      try {
        const updates = await this.call<TgUpdate[]>(
          'getUpdates',
          {
            offset: this.offset,
            timeout: 25,
            allowed_updates: ['message', 'callback_query'],
          },
          40_000,
        );
        backoff = 1000;
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          try {
            await onUpdate(update);
          } catch (err) {
            console.error('[tg] update handler failed', err);
          }
        }
      } catch (err) {
        if (this.stopped) return;
        const wait =
          err instanceof TelegramError && err.retryAfter ? err.retryAfter * 1000 : backoff;
        console.error(`[tg] poll failed, retrying in ${Math.round(wait / 1000)}s:`, String(err));
        await sleep(wait);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }
}

function isEntityError(err: TelegramError): boolean {
  return err.code === 400 && /parse entities|unsupported start tag|tag .* is unsupported/i.test(err.description);
}

function stripTags(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/**
 * Split on the largest safe boundary — paragraph, then line, then hard cut —
 * and keep fenced code blocks whole where they fit, because a `<pre>` cut in
 * half is an unbalanced tag and Telegram rejects the whole message.
 */
export function splitText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.4) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.4) cut = max;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Telegram measures callback_data in BYTES and silently refuses buttons over
 *  64. Everything the bot puts there is index-based for this reason; this guard
 *  turns a future mistake into a crash in dev rather than a dead button. */
export function assertCallbackData(data: string): string {
  if (Buffer.byteLength(data, 'utf8') > CALLBACK_MAX_BYTES) {
    throw new Error(`callback_data too long (${data.length} chars): ${data}`);
  }
  return data;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
