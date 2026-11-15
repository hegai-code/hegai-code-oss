/**
 * «Кто-то зарегался» → a message to the owner with an «Активировать» button.
 *
 * The bot already acts as the owner (the whitelist model, see config.ts), and
 * the owner is a platform admin, so nothing new is needed on the hub: this
 * polls the same `GET /api/admin/access?state=waitlist` the web's «Доступ» tab
 * reads, and the button calls the same `POST /api/admin/access/activate`. The
 * audit row therefore names the owner — who is exactly the person who tapped.
 *
 * Polling, not a push: a waitlist changes a few times a week, a minute of lag
 * is invisible, and it keeps the protocol untouched (no new `/ui` frame to
 * teach four clients about).
 *
 * The hub identity may not be an admin (a dev bot, a future community bot):
 * a 403 turns the watcher off for the life of the process, quietly.
 */
import { createHash } from 'node:crypto';

import { ago, escapeHtml, oneLine } from './render.js';
import type { Store, WaitlistMemory } from './state.js';
import type { InlineKeyboard, Telegram } from './telegram.js';

export const WAITLIST_POLL_MS = 60_000;
const WAITLIST_PAGE = 500;
/** callback_data prefix: `wla:<ref>`. */
export const WAITLIST_CALLBACK = 'wla';

export interface WaitlistRow {
  userId: string;
  /** Absent for an account without an address (Telegram-only sign-in). */
  email?: string;
  fullName?: string;
  note?: string;
  requestedAt?: number;
  invitedTo?: string[];
}

export interface WaitlistPlan {
  /** New people to announce. */
  announce: WaitlistRow[];
  /** Announced people whose note (or name) changed — re-render the message. */
  update: WaitlistRow[];
  /** Refs that left the waitlist without the button (activated in the web,
   *  suspended, deleted) — their buttons must stop being tappable. */
  gone: string[];
  /** First run: everything present is recorded as known, nothing is sent,
   *  so a bot restart on a fresh state file does not replay the whole list. */
  seed: boolean;
}

/** Short, stable id for callback_data (Telegram caps it at 64 bytes; user
 *  ids are SSO uuids today, but a synthetic `local-…` id has no length cap). */
export function waitlistRef(userId: string): string {
  return createHash('sha256').update(userId).digest('base64url').slice(0, 16);
}

/** What changed since the last poll. Pure — the watcher does the I/O. */
export function planWaitlist(rows: WaitlistRow[], memory: WaitlistMemory | undefined): WaitlistPlan {
  if (!memory) return { announce: [], update: [], gone: [], seed: true };
  const present = new Set<string>();
  const announce: WaitlistRow[] = [];
  const update: WaitlistRow[] = [];
  for (const row of rows) {
    const ref = waitlistRef(row.userId);
    present.add(ref);
    const known = memory.known[ref];
    if (!known) announce.push(row);
    else if (known.messages.length && fingerprint(row) !== known.fingerprint) update.push(row);
  }
  const gone = Object.keys(memory.known).filter((ref) => !present.has(ref));
  return { announce, update, gone, seed: false };
}

function fingerprint(row: WaitlistRow): string {
  return JSON.stringify([row.fullName ?? '', row.note ?? '', row.invitedTo ?? []]);
}

export function waitlistText(row: WaitlistRow, waiting: number): string {
  const name = row.fullName?.trim();
  const email = row.email?.trim();
  // The address is the one part of the card a person cannot choose; the
  // name is whatever they typed into Telegram. So an account WITHOUT an
  // address always carries a marker a name cannot fake — otherwise someone
  // called «Владелец Орлов» or «owner@x.test» is one tap from being let in.
  const label = name ? escapeHtml(oneLine(name, 80)) : escapeHtml(email || 'Без имени');
  const who = email
    ? (name ? `<b>${label}</b> · ${escapeHtml(email)}` : `<b>${label}</b>`)
    : `<b>${label}</b> · <i>без почты, id ${escapeHtml(row.userId.slice(0, 8))}</i>`;
  const note = row.note?.trim()
    ? `«${escapeHtml(oneLine(row.note, 600))}»`
    : '<i>о себе пока ничего не написал</i>';
  const invited = row.invitedTo?.length
    ? `\nЗовут в команду: ${escapeHtml(row.invitedTo.join(', '))}`
    : '';
  const when = row.requestedAt ? ` · ${escapeHtml(ago(row.requestedAt))}` : '';
  const queue = waiting > 1 ? `\nВ листе ожидания: ${waiting}` : '';
  return `🆕 <b>Hegai Code — новая заявка</b>${when}\n${who}\n${note}${invited}${queue}`;
}

export function waitlistKeyboard(row: WaitlistRow): InlineKeyboard {
  return [[{ text: 'Активировать', callback_data: `${WAITLIST_CALLBACK}:${waitlistRef(row.userId)}` }]];
}

/** The line appended once the question is settled; the button goes away. */
export function settledLine(outcome: string): string {
  switch (outcome) {
    case 'activated':
      return '✅ Доступ открыт';
    case 'already_active':
      return '✅ Уже активен';
    case 'suspended':
      return '⛔ Заблокирован — снимается в вебе, в «Доступе»';
    case 'gone':
      return '☑️ Уже не в листе ожидания — решено в другом месте';
    default:
      return `⚠️ Не активирован: ${escapeHtml(outcome)}`;
  }
}

interface Deps {
  http: string;
  tg: Telegram;
  store: Store;
  /** Chats to notify — the whitelisted accounts' private chats. */
  chatIds: () => number[];
  onUnauthorized: () => void;
}

export class WaitlistWatcher {
  private timer: NodeJS.Timeout | undefined;
  private disabled = false;
  private running = false;

  constructor(private readonly deps: Deps) {}

  start(): void {
    const tick = () => void this.poll();
    setTimeout(tick, 5_000).unref?.();
    this.timer = setInterval(tick, WAITLIST_POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One poll. Public for the smoke/tests; overlapping calls collapse. */
  async poll(): Promise<void> {
    if (this.disabled || this.running) return;
    this.running = true;
    try {
      const rows = await this.fetchWaitlist();
      if (rows) await this.apply(rows);
    } catch (err) {
      console.warn('[waitlist] poll failed', err instanceof Error ? err.message : err);
    } finally {
      this.running = false;
    }
  }

  /** The whole waitlist, every page: the hub sorts it oldest first, so a
   *  single page would hide exactly the newcomers once it fills up. */
  private async fetchWaitlist(): Promise<WaitlistRow[] | undefined> {
    const all: WaitlistRow[] = [];
    for (let offset = 0; offset < 10 * WAITLIST_PAGE; offset += WAITLIST_PAGE) {
      const res = await fetch(
        `${this.deps.http}/api/admin/access?state=waitlist&limit=${WAITLIST_PAGE}&offset=${offset}`,
        { headers: this.headers() },
      );
      if (res.status === 401) {
        this.deps.onUnauthorized();
        return undefined;
      }
      if (res.status === 403) {
        this.disabled = true;
        console.log('[waitlist] hub identity is not a platform admin — waitlist notifications off');
        return undefined;
      }
      if (!res.ok) throw new Error(`GET /api/admin/access ${res.status}`);
      const body = (await res.json()) as { users?: WaitlistRow[] };
      const page = body.users ?? [];
      // `email` is NOT required: filtering on it silently hid every
      // Telegram-only waitlister from the admins.
      all.push(...page.filter((u) => typeof u.userId === 'string'));
      if (page.length < WAITLIST_PAGE) return all;
    }
    // Past the cap the list is incomplete: better no tick than a false «gone».
    throw new Error(`waitlist longer than ${10 * WAITLIST_PAGE} — not diffing a partial list`);
  }

  private async apply(rows: WaitlistRow[]): Promise<void> {
    const { store } = this.deps;
    const plan = planWaitlist(rows, store.waitlist);
    if (plan.seed) {
      const known: WaitlistMemory['known'] = {};
      for (const row of rows) {
        known[waitlistRef(row.userId)] = { userId: row.userId, fingerprint: fingerprint(row), row, messages: [] };
      }
      store.setWaitlist({ known });
      console.log(`[waitlist] seeded with ${rows.length} waiting account(s); new ones will be announced`);
      return;
    }
    const memory = store.waitlist!;
    for (const ref of plan.gone) {
      const entry = memory.known[ref];
      delete memory.known[ref];
      if (entry?.messages.length) await this.settle(entry, 'gone');
    }
    for (const row of plan.update) {
      const entry = memory.known[waitlistRef(row.userId)];
      if (!entry) continue; // settled by a tap while this poll was awaiting Telegram
      entry.fingerprint = fingerprint(row);
      entry.row = row;
      for (const m of entry.messages) {
        await this.deps.tg.editMessage(m.chatId, m.messageId, waitlistText(row, rows.length), {
          keyboard: waitlistKeyboard(row),
        });
      }
    }
    for (const row of plan.announce) {
      const ref = waitlistRef(row.userId);
      const entry = { userId: row.userId, fingerprint: fingerprint(row), row, messages: [] as Array<{ chatId: number; messageId: number }> };
      // Recorded before sending: a send that fails must not re-announce every
      // minute; the person is still in the web's «Доступ» tab.
      memory.known[ref] = entry;
      for (const chatId of this.deps.chatIds()) {
        try {
          const sent = await this.deps.tg.sendMessage(chatId, waitlistText(row, rows.length), {
            keyboard: waitlistKeyboard(row),
          });
          const last = sent.at(-1);
          if (last) entry.messages.push({ chatId, messageId: last.message_id });
        } catch (err) {
          console.warn(`[waitlist] could not notify ${chatId}`, err instanceof Error ? err.message : err);
        }
      }
      // Tapped in one chat while the send to another was in flight: that tap
      // settled only the messages it knew about — retire the rest.
      if (memory.known[ref] !== entry && entry.messages.length) await this.settle(entry, 'gone');
      console.log(`[waitlist] announced ${row.email ?? row.userId}`);
    }
    if (plan.gone.length || plan.update.length || plan.announce.length) store.save();
  }

  /** The «Активировать» tap. Returns what to tell the tapper if it failed. */
  async activate(ref: string): Promise<string | undefined> {
    const entry = this.deps.store.waitlist?.known[ref];
    if (!entry) return 'Эта заявка уже закрыта.';
    let outcome: string;
    try {
      const res = await fetch(`${this.deps.http}/api/admin/access/activate`, {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ userIds: [entry.userId] }),
      });
      if (res.status === 401) this.deps.onUnauthorized();
      if (!res.ok) return `Хаб ответил ${res.status} — попробуйте ещё раз через минуту.`;
      const body = (await res.json()) as {
        activated?: Array<{ userId: string }>;
        skipped?: Array<{ userId: string; reason?: string }>;
      };
      if (body.activated?.some((a) => a.userId === entry.userId)) outcome = 'activated';
      else outcome = body.skipped?.find((s) => s.userId === entry.userId)?.reason ?? 'unknown';
    } catch (err) {
      return `Хаб недоступен: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (outcome === 'activated') console.log(`[waitlist] activated ${entry.row.email ?? entry.row.userId} from Telegram`);
    delete this.deps.store.waitlist!.known[ref];
    this.deps.store.save();
    await this.settle(entry, outcome);
    return undefined;
  }

  private async settle(entry: WaitlistMemory['known'][string], outcome: string): Promise<void> {
    const text = `${waitlistText(entry.row, 0)}\n\n${settledLine(outcome)}`;
    for (const m of entry.messages) {
      // No keyboard option = Telegram drops the old one: the button is spent.
      await this.deps.tg.editMessage(m.chatId, m.messageId, text);
    }
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.deps.store.session ?? ''}`,
      'sec-fetch-site': 'same-origin',
    };
  }
}
