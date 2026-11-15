import type { HistoryMessage, MachineSnapshot } from '@cc-remote/shared';
import { storageGet, storageRemove, storageSet } from './storage.js';

/**
 * What this device remembers between visits, so a session opens the way it
 * does in ChatGPT: drawn at once from the last visit, then quietly refreshed.
 *
 * Two things, both in IndexedDB (localStorage is synchronous and capped at a
 * few MB, and a fleet snapshot alone is hundreds of KB):
 *
 * - **the fleet snapshot** per person and workspace — the session list, the
 *   panes' sessions and their titles exist before the socket does;
 * - **the last page of each session's history**, whole — not just the speech
 *   the old `cc-tx2:` preview kept, because a preview that looks different from
 *   the real thing is itself a flash.
 *
 * Both are DISPLAY-ONLY. Nothing here is evidence about the hub or the
 * transcript file: the snapshot never sets `hydrated` (a cached «online» is
 * not the machine saying so), and cached history is never handed to the
 * echo-dedup or convergence logic in `Chat` — those decide whether the file has
 * caught up with the live stream, and a copy from disk cannot answer that.
 *
 * Every call is best-effort. A browser without IndexedDB, a private window, a
 * full disk: the app simply waits for the network, as it always did.
 *
 * Whose data it is matters, because the hub's per-read access check does not
 * apply to a copy already on this disk: `claimFor` wipes everything the moment
 * a different person signs in on this browser, and the shell calls `clear`
 * when it sees the sign-in screen.
 */

const DB_NAME = 'hegai-cache';
const DB_VERSION = 1;
/** One snapshot per `${userId}:${workspaceId}`. */
const SNAP = 'snap';
/** One history page per `${machineId}::${sessionId}`. */
const TX = 'tx';
/** How many sessions keep their last page, evicted least-recently-written. */
const MAX_TRANSCRIPTS = 40;
/** A page bigger than this is not kept: one runaway transcript must not push
 *  every other session out. Measured in JSON characters, near enough bytes. */
const MAX_TRANSCRIPT_CHARS = 3_000_000;
const OWNER_KEY = 'cc-cache-owner';
/** The speech-only preview this replaces lived here; swept on first use. */
const LEGACY_PREFIX = 'cc-tx2:';

export interface CachedSnapshot {
  at: number;
  machines: MachineSnapshot[];
}

interface TxEntry {
  at: number;
  messages: HistoryMessage[];
}

let opened: Promise<IDBDatabase | null> | null = null;

/** The same pages, held in memory for this tab: a session seen once in this
 *  tab opens in its first frame — IndexedDB answers in milliseconds, but a
 *  millisecond is still a skeleton blinking in a pane that had the text. */
const hot = new Map<string, HistoryMessage[]>();
const HOT_MAX = 24;
function remember(key: string, messages: HistoryMessage[]): void {
  hot.delete(key);
  hot.set(key, messages);
  while (hot.size > HOT_MAX) hot.delete(hot.keys().next().value as string);
}

function db(): Promise<IDBDatabase | null> {
  if (opened) return opened;
  opened = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(SNAP)) d.createObjectStore(SNAP);
        if (!d.objectStoreNames.contains(TX)) d.createObjectStore(TX);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  sweepLegacy();
  return opened;
}

function request<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return db().then(
    (d) =>
      new Promise<T | undefined>((resolve) => {
        if (!d) return resolve(undefined);
        try {
          const req = run(d.transaction(store, mode).objectStore(store));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      }),
  );
}

function sweepLegacy(): void {
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(LEGACY_PREFIX)) stale.push(k);
    }
    for (const k of stale) localStorage.removeItem(k);
  } catch {
    /* no storage */
  }
}

export const transcriptKey = (machineId: string, sessionId: string) => `${machineId}::${sessionId}`;

export const LocalCache = {
  async snapshot(userId: string, workspaceId: string): Promise<CachedSnapshot | undefined> {
    const v = await request<CachedSnapshot>(SNAP, 'readonly', (s) => s.get(`${userId}:${workspaceId}`));
    return v && Array.isArray(v.machines) ? v : undefined;
  },

  saveSnapshot(userId: string, workspaceId: string, machines: MachineSnapshot[]): void {
    void request(SNAP, 'readwrite', (s) => s.put({ at: Date.now(), machines } satisfies CachedSnapshot, `${userId}:${workspaceId}`));
  },

  /** What this tab already holds for the session — synchronous, for the
   *  first render. Empty when it has not been seen here yet. */
  peekTranscript(key: string): HistoryMessage[] {
    return hot.get(key) ?? [];
  },

  async transcript(key: string): Promise<HistoryMessage[]> {
    const warm = hot.get(key);
    if (warm) return warm;
    const v = await request<TxEntry>(TX, 'readonly', (s) => s.get(key));
    const messages = v && Array.isArray(v.messages) ? v.messages : [];
    if (messages.length) remember(key, messages);
    return messages;
  },

  saveTranscript(key: string, messages: HistoryMessage[]): void {
    let size = 0;
    try {
      size = JSON.stringify(messages).length;
    } catch {
      return;
    }
    if (!messages.length || size > MAX_TRANSCRIPT_CHARS) {
      hot.delete(key);
      void request(TX, 'readwrite', (s) => s.delete(key));
      return;
    }
    remember(key, messages);
    void request(TX, 'readwrite', (s) => s.put({ at: Date.now(), messages } satisfies TxEntry, key)).then(evict);
  },

  /** Everything, for a sign-out or a different person on this browser. */
  clear(): void {
    hot.clear();
    void request(SNAP, 'readwrite', (s) => s.clear());
    void request(TX, 'readwrite', (s) => s.clear());
    sweepLegacy();
  },

  /**
   * Make the cache this person's. A different user than the one who filled it
   * gets an empty cache, never theirs: the wipe is queued on the same database
   * before any read this user can issue, so no read can see the old data.
   */
  claimFor(userId: string): void {
    // No storage: nothing persisted to protect either.
    const prev = storageGet(OWNER_KEY);
    if (prev && prev !== userId) LocalCache.clear();
    storageSet(OWNER_KEY, userId);
  },

  /** Signed out: forget whose it was, and what it held. */
  release(): void {
    LocalCache.clear();
    storageRemove(OWNER_KEY);
  },
};

/** Drop the least recently written histories past the cap. */
async function evict(): Promise<void> {
  const d = await db();
  if (!d) return;
  try {
    const store = d.transaction(TX, 'readwrite').objectStore(TX);
    const all: { key: IDBValidKey; at: number }[] = [];
    const cur = store.openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) {
        all.push({ key: c.key, at: (c.value as TxEntry).at ?? 0 });
        c.continue();
        return;
      }
      if (all.length <= MAX_TRANSCRIPTS) return;
      all.sort((a, b) => a.at - b.at);
      for (const e of all.slice(0, all.length - MAX_TRANSCRIPTS)) store.delete(e.key);
    };
  } catch {
    /* best effort */
  }
}
