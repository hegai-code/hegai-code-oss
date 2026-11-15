import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SlashCommandInfo } from '@cc-remote/shared';
import { assertRoot } from './fs-roots.js';
import { syncsCwd } from './policy.js';

/**
 * The composer's «/» menu when no run is live to ask (a new chat, a dormant
 * session): the skills and commands on disk, the way Claude Code finds them.
 *
 *   <cwd>/.claude/skills/<name>/SKILL.md     project skills
 *   <cwd>/.claude/commands/**\/<name>.md      project commands (`a/b.md` → `a:b`)
 *   ~/.claude/skills, ~/.claude/commands      the same, for the user
 *
 * A live run answers from the runtime itself (`supportedCommands()`, see
 * client.ts) — that list also has the built-ins and plugin skills, and it is
 * the one to trust when there is one. This is the fallback, so it stays cheap
 * and bounded: frontmatter only (the first 4 KB of each file), a fixed depth,
 * a cap on the count. The project directory is read only when it is one of the
 * machine's project roots — the same proof every file method gives.
 */

const MAX_COMMANDS = 300;
const HEAD_BYTES = 4096;
const MAX_DEPTH = 3;
/** Entries looked at per call, found or not: a `skills/` of 100k empty folders
 *  or a stray `node_modules` under `commands/` must not make every «/» cost a
 *  full walk. */
const MAX_VISITED = 2000;

/** One call's budget and the folder its files must stay inside. */
type Walk = { visited: number; base: string | null };

/** What every Claude run understands whatever is on disk. */
const BUILTINS: SlashCommandInfo[] = [
  { name: 'compact', description: 'Сжать контекст сессии' },
];

function configDir(): string {
  return process.env['CLAUDE_CONFIG_DIR'] || path.join(os.homedir(), '.claude');
}

/** `key: value` pairs of a leading `---` block. Quotes trimmed; nothing else. */
export function frontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return out;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '---') break;
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    // A folded block (`description: >`) — take the next indented lines.
    if (v === '>' || v === '|' || v === '>-' || v === '|-') {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim());
      v = parts.join(' ');
    }
    out[m[1]!.toLowerCase()] = v;
  }
  return out;
}

/**
 * The first bytes of a REGULAR file, or null. A skill folder is somebody's
 * checkout: `SKILL.md` can be a symlink to a FIFO (an open that never returns,
 * holding one of libuv's four fs threads) or to a file outside the project.
 * So: follow the link only to a regular file, only inside `walk.base` when
 * there is one, and open non-blocking regardless.
 */
async function head(file: string, walk: Walk): Promise<string | null> {
  const st = await stat(file).catch(() => null);
  if (!st?.isFile()) return null;
  if (walk.base) {
    const real = await realpath(file).catch(() => null);
    if (!real || !(real === walk.base || real.startsWith(walk.base + path.sep))) return null;
  }
  const fh = await open(file, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => null);
  if (!fh) return null;
  try {
    if (!(await fh.stat()).isFile()) return null;
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

function entry(name: string, fm: Record<string, string>): SlashCommandInfo {
  const description = fm['description']?.slice(0, 300);
  const argumentHint = fm['argument-hint']?.slice(0, 100);
  return {
    name,
    ...(description ? { description } : {}),
    ...(argumentHint ? { argumentHint } : {}),
  };
}

async function skillsIn(dir: string, out: SlashCommandInfo[], walk: Walk): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const n of names.sort()) {
    if (out.length >= MAX_COMMANDS || ++walk.visited > MAX_VISITED) return;
    if (n.startsWith('.')) continue;
    const text = await head(path.join(dir, n, 'SKILL.md'), walk);
    if (text === null) continue;
    // The folder is the name Claude Code invokes it by; `name:` is a label.
    out.push(entry(n, frontmatter(text)));
  }
}

async function commandsIn(dir: string, out: SlashCommandInfo[], walk: Walk, prefix = '', depth = 0): Promise<void> {
  if (depth > MAX_DEPTH) return;
  const ents = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= MAX_COMMANDS || ++walk.visited > MAX_VISITED) return;
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    // Real directories only: a symlinked folder could loop or lead anywhere.
    if (e.isDirectory()) {
      await commandsIn(full, out, walk, `${prefix}${e.name}:`, depth + 1);
    } else if ((e.isFile() || e.isSymbolicLink()) && e.name.endsWith('.md')) {
      const text = await head(full, walk);
      if (text !== null) out.push(entry(prefix + e.name.slice(0, -3), frontmatter(text)));
    }
  }
}

/** Skills and commands on disk for a session in `cwd` (project first, then the
 *  user's), plus the built-ins. Deduped by name — the first one found wins, as
 *  a project skill shadows a user skill of the same name in Claude Code. */
export async function listDiskCommands(cwd?: string): Promise<SlashCommandInfo[]> {
  const found: SlashCommandInfo[] = [];
  // The project's own `.claude` is read only inside the project (its files
  // are whoever committed them); the user's config is the machine owner's
  // own, where a symlinked skill is the normal way to install one. A folder
  // this machine does not sync to the hub (policy `sync`) keeps its skills to
  // itself: only the user's own list goes out then.
  const bases: { dir: string; base: string | null }[] = [];
  if (cwd && syncsCwd(cwd)) {
    const root = await assertRoot(cwd).catch(() => null);
    if (root) bases.push({ dir: path.join(root, '.claude'), base: root });
  }
  bases.push({ dir: configDir(), base: null });
  const walk: Walk = { visited: 0, base: null };
  for (const b of bases) {
    walk.base = b.base;
    await skillsIn(path.join(b.dir, 'skills'), found, walk);
    await commandsIn(path.join(b.dir, 'commands'), found, walk);
  }
  const seen = new Set<string>();
  const out: SlashCommandInfo[] = [];
  for (const c of [...found, ...BUILTINS]) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(c);
  }
  return out.slice(0, MAX_COMMANDS);
}
