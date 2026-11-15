import path from 'node:path';
import { readFileSync } from 'node:fs';
import { writeFileAtomicSync } from './atomic-write.js';
import { stateDir } from './config.js';

/**
 * Titles for sessions whose transcript has nowhere to keep one.
 *
 * A Claude session stores its custom title INSIDE its own .jsonl — the SDK's
 * `renameSession` writes it there, and the CLI's `/resume` picker reads it
 * back — so renaming one is a transcript edit and this store stays out of it.
 *
 * A Codex rollout has no such field. Its title is DERIVED from the first user
 * message every single time the file is parsed (`parseCodexDocument` in
 * codex.ts), which means there is literally nothing on disk to rename: the
 * append-only rollout is Codex's format, not ours, and rewriting its head to
 * smuggle a title in would be us corrupting another tool's file.
 *
 * So this module is that missing field, kept beside the agent's own state and
 * overlaid onto the inventory in `buildInventory`. A Claude title is NOT read
 * from here: it belongs in the transcript, where every other Claude client can
 * see it. For a Claude session an entry only records that a person named it, which
 * keeps the hub's generated titles off it (`titleDerived` in sessions.ts).
 */

/** Same cap `parseCodexRolloutHead` applies to a derived title. */
export const MAX_TITLE_LENGTH = 120;

/**
 * Entries are tiny (an id and a string) but nothing prunes them: a renamed
 * session that is later deleted OUTSIDE cc-remote leaves its title behind
 * forever. Rather than guess which ids are dead — the inventory is filtered and
 * limited, so "absent from it" does not mean "gone" — the store simply keeps
 * the most recently written ones and drops the rest.
 */
const MAX_ENTRIES = 2000;

interface TitleEntry {
  title: string;
  /** Write time, ms. Only used to decide what to evict at the cap. */
  at: number;
}

interface TitleStore {
  version: 1;
  titles: Record<string, TitleEntry>;
}

function storeFile(): string {
  return path.join(stateDir(), 'session-titles.json');
}

/**
 * In-memory copy, keyed by the file it was read from. `buildInventory` consults
 * this store for every Codex row on every inventory push (seconds apart on a
 * busy machine) — that must not become a disk read per session.
 */
let cache: { file: string; titles: Map<string, TitleEntry> } | null = null;

function load(): Map<string, TitleEntry> {
  const file = storeFile();
  if (cache && cache.file === file) return cache.titles;
  const titles = new Map<string, TitleEntry>();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<TitleStore>;
    for (const [id, entry] of Object.entries(parsed.titles ?? {})) {
      if (typeof entry?.title !== 'string' || !entry.title) continue;
      titles.set(id, { title: entry.title, at: typeof entry.at === 'number' ? entry.at : 0 });
    }
  } catch {
    // Absent on a fresh machine, and a corrupt file must never stop the
    // inventory — an empty store just means "no custom titles".
  }
  cache = { file, titles };
  return titles;
}

/** Persist atomically: a half-written store would silently lose every title. */
function save(titles: Map<string, TitleEntry>): void {
  const file = storeFile();
  if (titles.size > MAX_ENTRIES) {
    const newest = [...titles.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ENTRIES);
    titles.clear();
    for (const [id, entry] of newest) titles.set(id, entry);
  }
  const store: TitleStore = { version: 1, titles: Object.fromEntries(titles) };
  writeFileAtomicSync(file, JSON.stringify(store, null, 2), { mode: 0o600, mkdir: true });
  cache = { file, titles };
}

/** The stored title for this session, or undefined when it was never renamed. */
export function sessionTitle(sessionId: string): string | undefined {
  return load().get(sessionId)?.title;
}

/**
 * Store a title. Returns what was actually stored — trimmed and capped, so the
 * caller reports the same string the inventory will show.
 */
export function setSessionTitle(sessionId: string, title: string, now = Date.now()): string {
  const clean = title.trim().slice(0, MAX_TITLE_LENGTH);
  if (!clean) throw new Error('title cannot be empty');
  const titles = load();
  titles.set(sessionId, { title: clean, at: now });
  save(titles);
  return clean;
}

/** Forget a title — the session it named is gone. */
export function dropSessionTitle(sessionId: string): void {
  const titles = load();
  if (!titles.delete(sessionId)) return;
  save(titles);
}

/** Drop the in-memory copy. Tests only — the store is per-process otherwise. */
export function resetSessionTitleCache(): void {
  cache = null;
}
