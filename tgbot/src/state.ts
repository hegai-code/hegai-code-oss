/**
 * What survives a restart: the hub session, and per-chat "where am I".
 *
 * A JSON file, not SQLite — the whitelist model means a handful of chats, and
 * an operator being able to read and hand-edit the state on the box is worth
 * more here than query power. Writes are atomic (tmp + rename) and debounced,
 * so a crash mid-run leaves the previous state rather than a truncated file.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface ChatSettings {
  /** Show tool calls and machinery. Off = only the agent's speech (the default). */
  verbose: boolean;
  /** Offer LLM quick replies after a turn ends (`enrich_request`). */
  suggest: boolean;
  /** Push a message when a run wants attention or finishes. */
  notify: boolean;
}

/** What the bot is waiting for the NEXT plain message in this chat to be. */
export type Awaiting =
  | { kind: 'new_session'; machineId: string; cwd: string; category?: string }
  | { kind: 'project_name'; machineId: string }
  | { kind: 'clone_url'; machineId: string; name: string };

/** A bot message that a reply should route back into a session. Bounded. */
export interface ReplyRoute {
  messageId: number;
  machineId: string;
  sessionId: string;
}

export interface ChatState {
  machineId?: string;
  cwd?: string;
  sessionId?: string;
  runId?: string;
  source?: 'claude' | 'codex';
  awaiting?: Awaiting;
  settings: ChatSettings;
  /** Last rendered lists, so index-based callback_data stays resolvable across
   *  a restart (Telegram keeps old buttons tappable forever). */
  lastMachines?: string[];
  lastProjects?: string[];
  lastSessions?: string[];
  routes?: ReplyRoute[];
}

/** Waitlist announcements (see waitlist.ts), keyed by the short ref that
 *  rides in callback_data. An entry lives while the person waits; absent
 *  memory means «never polled» and seeds silently. */
export interface WaitlistMemory {
  known: Record<
    string,
    {
      userId: string;
      fingerprint: string;
      row: { userId: string; email?: string; fullName?: string; note?: string; requestedAt?: number; invitedTo?: string[] };
      messages: Array<{ chatId: number; messageId: number }>;
    }
  >;
}

interface Persisted {
  session?: string;
  chats: Record<string, ChatState>;
  waitlist?: WaitlistMemory;
}

const ROUTE_LIMIT = 200;

export const DEFAULT_SETTINGS: ChatSettings = { verbose: false, suggest: false, notify: true };

export class Store {
  private data: Persisted = { chats: {} };
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly file: string) {
    try {
      const raw = readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<Persisted>;
      this.data = { session: parsed.session, chats: parsed.chats ?? {}, waitlist: parsed.waitlist };
    } catch {
      /* first run, or a file we cannot read — start clean rather than crash */
    }
  }

  get session(): string | undefined {
    return this.data.session;
  }

  setSession(session: string): void {
    this.data.session = session;
    this.save();
  }

  get waitlist(): WaitlistMemory | undefined {
    return this.data.waitlist;
  }

  setWaitlist(memory: WaitlistMemory): void {
    this.data.waitlist = memory;
    this.save();
  }

  chat(chatId: number): ChatState {
    const key = String(chatId);
    const existing = this.data.chats[key];
    if (existing) {
      existing.settings = { ...DEFAULT_SETTINGS, ...existing.settings };
      return existing;
    }
    const fresh: ChatState = { settings: { ...DEFAULT_SETTINGS } };
    this.data.chats[key] = fresh;
    return fresh;
  }

  chatIds(): number[] {
    return Object.keys(this.data.chats).map(Number).filter(Number.isFinite);
  }

  /** Remember that a reply to `messageId` belongs to a session. */
  route(chatId: number, route: ReplyRoute): void {
    const chat = this.chat(chatId);
    const routes = chat.routes ?? [];
    routes.push(route);
    chat.routes = routes.slice(-ROUTE_LIMIT);
    this.save();
  }

  findRoute(chatId: number, messageId: number): ReplyRoute | undefined {
    return this.chat(chatId).routes?.find((r) => r.messageId === messageId);
  }

  /** Debounced atomic write. Every mutator calls this; bursts collapse. */
  save(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, 400);
    this.timer.unref?.();
  }

  flush(): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      console.error('[state] save failed', err);
    }
  }
}
