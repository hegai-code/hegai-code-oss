/**
 * Install the skills that travel inside the agent bundle into
 * `~/.claude/skills/<name>/SKILL.md`, and report what this machine can run.
 *
 * Why the agent does this at all: a session category rewrites the first turn to
 * `/<skill> <text>` (server-rs/src/hub.rs, CATEGORY_SKILLS). The skill bodies
 * used to exist only where somebody had placed them by hand — on `stage` — so
 * on every other machine the category quietly left an unhandled `/backlog` in
 * the transcript. Carrying them in the bundle makes the category mean the same
 * thing everywhere the agent runs.
 *
 * Two rules keep this from being destructive:
 *   1. Only names present in BUNDLED_SKILLS are ever written. Everything else in
 *      ~/.claude/skills (gstack, the user's own) is read, never touched — an
 *      agent update must not wipe a machine's toolbox.
 *   2. A write happens only when the content actually differs, so a restart is
 *      a no-op and the mtimes stay meaningful.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUNDLED_SKILLS } from './skills-bundle.js';

const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

/**
 * Write the bundled skills to disk. Returns the names that were created or
 * updated — an empty array means everything was already current.
 *
 * Never throws: a machine with a read-only home or an odd permission setup
 * still has to connect and serve sessions. A failed install degrades the
 * category chips (see `installedSkills`), it does not stop the daemon.
 */
export function syncBundledSkills(): string[] {
  const written: string[] = [];
  for (const [name, body] of BUNDLED_SKILLS) {
    try {
      const dir = path.join(SKILLS_DIR, name);
      const file = path.join(dir, 'SKILL.md');
      if (existsSync(file) && readFileSync(file, 'utf8') === body) continue;
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, body);
      written.push(name);
    } catch (error) {
      console.error(`[agent] skill "${name}" not installed:`, (error as Error).message);
    }
  }
  if (written.length) {
    console.log(`[agent] skills installed/updated: ${written.join(', ')}`);
  }
  return written;
}

/**
 * Every skill this machine can actually run — read from disk, not assumed.
 *
 * Deliberately NOT "bundled ∪ on-disk": if `syncBundledSkills` could not write
 * (read-only home, permissions), the skill is not invokable here, and claiming
 * it would put a chip in the UI that starts a session with an unhandled
 * `/sync` — worse than no chip, because it looks like it worked.
 */
export function installedSkills(): string[] {
  const found = new Set<string>();
  try {
    for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (existsSync(path.join(SKILLS_DIR, entry.name, 'SKILL.md'))) found.add(entry.name);
    }
  } catch {
    // No ~/.claude/skills at all. Nothing is runnable; say so rather than guess.
  }
  return [...found].sort();
}
