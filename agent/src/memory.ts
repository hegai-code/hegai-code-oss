import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { writeFileAtomic } from './atomic-write.js';

const execFileAsync = promisify(execFile);

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
/** The agent's own area — bookkeeping and quarantine live here, never in the
 *  harness's memory directory, which holds notes and nothing else. */
const STATE_DIR = path.join(os.homedir(), '.cc-remote');
const SYNC_STATE_PATH = path.join(STATE_DIR, 'memory-state.json');
const QUARANTINE_DIR = path.join(STATE_DIR, 'deleted-memories');

/**
 * Notes that are not about the repository they sit in. There is no global
 * memory directory — Claude Code only loads `projects/<slug>/memory`, so a
 * fleet note kept anywhere else would replicate correctly and never be read by
 * anyone. They therefore live IN the project directories (so the harness loads
 * them) under a reserved prefix that marks their real scope, and the
 * project-scope pass skips them so they never come back up mislabelled.
 */
const SCOPE_PREFIX: Record<'fleet' | 'machine', string> = {
  fleet: 'fleet--',
  machine: 'machine--',
};

/** The scope a file name declares, or `project` when it claims none. */
export function scopeOfFileName(name: string): 'fleet' | 'machine' | 'project' {
  if (name.startsWith(SCOPE_PREFIX.fleet)) return 'fleet';
  if (name.startsWith(SCOPE_PREFIX.machine)) return 'machine';
  return 'project';
}

/**
 * The per-project index Claude Code loads into context on every session.
 *
 * It is NOT replicated, and that is a correctness rule rather than an
 * optimization. The index describes what THIS machine holds; the notes describe
 * knowledge. Replicating it last-writer-wins means a box with two notes
 * overwrites the index of a box with twenty-five, and the surviving index lists
 * files it does not mention — the notes are still on disk and nothing points at
 * them, so they are gone in every way that matters. Each machine keeps its own,
 * and arriving notes are appended to it (see `appendIndexEntry`).
 */
export const INDEX_FILE = 'MEMORY.md';

/** Pull `name` / `description` out of a memory's frontmatter. Best-effort: a
 *  note without them still gets an index line, just a plainer one. */
export function frontmatter(content: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.+?)\s*$/.exec(line);
    // YAML quoting is optional and both spellings are in the corpus; the quotes
    // are syntax, and carrying them through would put them in the index line
    // that loads into context on every session.
    if (kv) out[kv[1] as 'name' | 'description'] = kv[2]!.replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  return out;
}

/** The one-line pointer an index entry is made of, in the shape the harness
 *  already writes: `- [Title](file.md) — hook`. */
export function indexPointerLine(relPath: string, content: string): string {
  const { name, description } = frontmatter(content);
  const heading = /^#\s+(.+?)\s*$/m.exec(content)?.[1];
  const title = heading ?? name ?? relPath.replace(/\.md$/, '');
  return description ? `- [${title}](${relPath}) — ${description}` : `- [${title}](${relPath})`;
}

/**
 * Point the local index at a note that just arrived from another machine.
 *
 * Appended with O_APPEND and never rewritten. That distinction is the whole
 * safety argument: the harness writes this same file, and a read-modify-write
 * would silently drop whatever it added in between. An append can only ever add
 * a line, so the worst case is a duplicate, not a lost entry.
 *
 * Returns false when the path is already mentioned — replication runs on a
 * timer, so this has to be idempotent.
 */
export async function appendIndexEntry(
  dir: string,
  relPath: string,
  content: string,
): Promise<boolean> {
  if (relPath === INDEX_FILE) return false;
  // Validate the NOTE path as well as the index path. Nothing outside the
  // directory gets written either way, but an unchecked name would still put a
  // link to `../../somewhere` into the index the harness reads.
  if (!safeMemoryPath(dir, relPath)) return false;
  const indexPath = safeMemoryPath(dir, INDEX_FILE);
  if (!indexPath) return false;
  let existing = '';
  try {
    existing = await readFile(indexPath, 'utf8');
  } catch {
    // No index yet — the append below creates it.
  }
  if (existing.includes(`(${relPath})`)) return false;
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  try {
    await mkdir(dir, { recursive: true });
    await appendFile(indexPath, `${prefix}${indexPointerLine(relPath, content)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Memory files are small notes. A file past this is not a memory, it is a log
 *  someone redirected into the wrong place — skip it rather than replicate it.
 *  Must stay at or under the protocol's own cap in `shared/src/protocol.ts`. */
const MAX_MEMORY_BYTES = 262_144;

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Claude Code's on-disk name for a working directory: every `/` and `.` becomes
 * `-`, so `/Users/x/.claude/skills` lands in `-Users-x--claude-skills`. Derived
 * rather than discovered because a fresh checkout on another machine has no
 * directory yet — creating it is the whole point of syncing.
 */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

/** Where this project's memory lives on this machine. */
export function memoryDirFor(cwd: string): string {
  return path.join(PROJECTS_DIR, projectSlug(cwd), 'memory');
}

/**
 * A project identity that survives the trip between machines. The on-disk slug
 * cannot: it is derived from an absolute path, so the same repository checked
 * out at `/Users/me/repo` and `/root/repo` produces two unrelated slugs and the
 * memory would never meet itself. The git remote is the same string everywhere
 * the repo exists, which is exactly the property needed.
 *
 * Returns `''` when there is no remote — a scratch directory has no identity to
 * share, and syncing it under a path-derived key would leak one machine's notes
 * into an unrelated directory on another.
 */
export async function projectKeyFor(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      timeout: 10_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return normalizeRemote(stdout.trim());
  } catch {
    return '';
  }
}

/**
 * Collapse the ways one remote can be spelled so SSH and HTTPS checkouts of the
 * same repository share a key: drop the scheme, any credentials, a trailing
 * `.git`, and case in the host. `git@github.com:me/repo.git` and
 * `https://github.com/ME/repo` both become `github.com/me/repo`.
 */
export function normalizeRemote(raw: string): string {
  let out = raw.trim();
  if (!out) return '';
  out = out.replace(/^[a-z+]+:\/\//i, '');
  out = out.replace(/^[^@/]*@/, '');
  out = out.replace(/:(?=[^/])/, '/');
  out = out.replace(/\.git$/i, '');
  out = out.replace(/\/+$/, '');
  const slash = out.indexOf('/');
  if (slash === -1) return out.toLowerCase();
  return out.slice(0, slash).toLowerCase() + out.slice(slash);
}

/**
 * Resolve a hub-supplied file name inside the memory directory, or `null` if it
 * tries to leave. The name crosses the network, so it is untrusted input even
 * though it came from our own hub: `../../CLAUDE.md` would otherwise let a
 * memory sync rewrite the operator's instructions.
 */
export function safeMemoryPath(dir: string, relPath: string): string | null {
  if (!relPath || relPath.includes('\0')) return null;
  if (path.isAbsolute(relPath)) return null;
  const resolved = path.resolve(dir, relPath);
  const root = path.resolve(dir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

export type LocalMemory = {
  /** Name relative to the memory directory. */
  path: string;
  content: string;
  sha256: string;
  /** Declared by the file name's prefix — see `SCOPE_PREFIX`. */
  scope: 'fleet' | 'machine' | 'project';
};

/** Every `.md` memory this machine holds for a project. Missing directory is a
 *  normal state (project never used here), not an error. */
export function readLocalMemories(cwd: string): Promise<LocalMemory[]> {
  return readLocalMemoriesIn(memoryDirFor(cwd));
}

/** Directory-addressed form, so the reconciliation rules can be tested against
 *  a scratch directory instead of the operator's real `~/.claude`. */
export async function readLocalMemoriesIn(dir: string): Promise<LocalMemory[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: LocalMemory[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    // The index is a local view, not shared knowledge — see INDEX_FILE. Keeping
    // it out here is what keeps it out of every sync path at once: it is never
    // offered up, never requested down, and never retired by a tombstone.
    if (name === INDEX_FILE) continue;
    const full = safeMemoryPath(dir, name);
    if (!full) continue;
    try {
      const content = await readFile(full, 'utf8');
      if (Buffer.byteLength(content, 'utf8') > MAX_MEMORY_BYTES) continue;
      out.push({ path: name, content, sha256: sha256Hex(content), scope: scopeOfFileName(name) });
    } catch {
      // A directory or an unreadable entry among the .md names — skip it.
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/**
 * Write a memory the hub had and this machine did not. Returns false without
 * touching anything if the file already exists.
 *
 * The refusal to overwrite is the whole safety property, not an optimization.
 * Claude Code's own harness writes these same files, so a hub that overwrote
 * them would be a second writer racing the first — the exact failure this
 * project already refuses to allow for transcripts. Local always wins;
 * content only ever flows downward into a gap.
 */
export function writeMemoryIfAbsent(
  cwd: string,
  relPath: string,
  content: string,
): Promise<boolean> {
  return writeMemoryIfAbsentIn(memoryDirFor(cwd), relPath, content);
}

/** Directory-addressed form — see `readLocalMemoriesIn`. */
export async function writeMemoryIfAbsentIn(
  dir: string,
  relPath: string,
  content: string,
): Promise<boolean> {
  const full = safeMemoryPath(dir, relPath);
  if (!full) return false;
  if (Buffer.byteLength(content, 'utf8') > MAX_MEMORY_BYTES) return false;
  await mkdir(path.dirname(full), { recursive: true });
  try {
    // wx: create-or-fail. Checking existence first would leave a window in
    // which the harness creates the file between the check and the write.
    await writeFile(full, content, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace a memory whose newer version came from another machine.
 *
 * This is the ONE place the hub is allowed to overwrite, and the caller must
 * have proved the machine did not touch the file since it last agreed with the
 * hub (see `MemorySyncState`). Without that proof this would be the second
 * writer the whole design refuses.
 *
 * Written to a temporary name and renamed, because the harness may read this
 * file at any moment and a partial write would be read as a truncated note.
 */
export async function overwriteMemoryIn(
  dir: string,
  relPath: string,
  content: string,
): Promise<boolean> {
  const full = safeMemoryPath(dir, relPath);
  if (!full) return false;
  if (Buffer.byteLength(content, 'utf8') > MAX_MEMORY_BYTES) return false;
  await mkdir(path.dirname(full), { recursive: true });
  try {
    await writeFileAtomic(full, content);
    return true;
  } catch {
    return false;
  }
}

/**
 * Retire a note the hub says was deleted.
 *
 * Moved out of the memory directory rather than removed: the agent deleting a
 * human's file outright is not a tidiness win worth the risk, and a note that
 * simply stayed put would keep loading into that machine's context forever —
 * which is the whole reason someone deleted it. Moving satisfies both, and
 * recovery is one `mv`.
 */
export async function quarantineMemoryIn(
  dir: string,
  relPath: string,
  label: string,
): Promise<boolean> {
  const full = safeMemoryPath(dir, relPath);
  if (!full) return false;
  const dest = path.join(QUARANTINE_DIR, label.replace(/[/\\:]/g, '-'), relPath);
  try {
    await mkdir(path.dirname(dest), { recursive: true });
    await rename(full, dest);
    return true;
  } catch {
    return false; // already gone, or never existed — both are the desired end state
  }
}

/** Project-addressed forms, so `client.ts` speaks in cwds throughout. */
export function overwriteMemory(cwd: string, relPath: string, content: string): Promise<boolean> {
  return overwriteMemoryIn(memoryDirFor(cwd), relPath, content);
}
export function quarantineMemory(cwd: string, relPath: string, label: string): Promise<boolean> {
  return quarantineMemoryIn(memoryDirFor(cwd), relPath, label);
}

/** What this machine last agreed with the hub for one note. The sha is the
 *  point: it distinguishes "the hub has something newer" from "I edited this
 *  locally", which is otherwise indistinguishable from a bare mismatch. */
export type MemorySyncRecord = { sha: string; revision: number };
export type MemorySyncState = Record<string, MemorySyncRecord>;

export function syncStateKey(scope: string, scopeKey: string, notePath: string): string {
  return `${scope} ${scopeKey} ${notePath}`;
}

export async function readSyncState(): Promise<MemorySyncState> {
  try {
    const raw = await readFile(SYNC_STATE_PATH, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    // Hand-validated rather than schema'd: this file never crosses the wire, and
    // a corrupt one must degrade to "no history" instead of killing the agent.
    const out: MemorySyncState = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const { sha, revision } = v as { sha?: unknown; revision?: unknown };
      if (typeof sha === 'string' && typeof revision === 'number') out[k] = { sha, revision };
    }
    return out;
  } catch {
    return {};
  }
}

/** Atomic replace. Rethrows after removing the tmp file: a failed save means
 *  the next reconcile re-derives from stale history, which the caller has to be
 *  able to report rather than learn about from a note that vanished. */
export async function writeSyncState(state: MemorySyncState): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFileAtomic(SYNC_STATE_PATH, JSON.stringify(state));
}

/**
 * Runs jobs one at a time, in arrival order. The sync state is a
 * read-modify-write file: two jobs that each `readSyncState()`, await, and
 * `writeSyncState()` interleave, and the later rename silently drops what the
 * earlier one recorded. Every state mutation goes through one runner.
 *
 * A job that rejects does not stall the queue, and the returned promise
 * carries that job's own outcome (an unobserved rejection is the caller's, not
 * the queue's).
 */
export function serialJobRunner(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (job) => {
    const run = tail.then(job, job);
    tail = run.catch(() => undefined);
    return run;
  };
}
