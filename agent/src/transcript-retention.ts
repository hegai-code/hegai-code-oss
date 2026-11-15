/**
 * Keep Claude Code from deleting this machine's transcripts.
 *
 * Claude Code deletes every transcript older than `cleanupPeriodDays` at
 * startup, and the default is 30. On this fleet that quietly took whole months
 * of work out of the session list: on `stage` the oldest `.jsonl` left on disk
 * was exactly thirty days old, and the hub had already flagged 1810 sessions
 * fleet-wide as deleted because their files were gone (28.09.2026). A session
 * whose file is gone can still be read from the hub's replica, but it can never
 * be resumed again. So the agent puts a very large value into
 * `~/.claude/settings.json` on every start.
 *
 * Rules that keep this from being destructive:
 *   - Only `cleanupPeriodDays` is changed. The rest of the file is written back
 *     key for key. (The apiKeyHelper incident on 24.09.2026 is why no other
 *     key is ever added here.)
 *   - A file that does not parse as a JSON object is left alone. Rewriting it
 *     would drop whatever the person has put there.
 *   - `0` is NOT "keep forever". To Claude Code it means "delete every
 *     transcript at startup and stop saving new ones", so it is overridden
 *     like any other small value.
 *   - The write is atomic (temp file + rename) and keeps the file's mode AND
 *     owner (an agent running as root must not hand a person's settings to
 *     root), a symlinked settings file is written through to its target, and
 *     a symlink pointing nowhere (a dotfiles checkout not mounted yet) is left
 *     alone rather than replaced with a stub.
 *   - The file is read again just before the rename; if a running Claude
 *     session changed it in between, nothing is written this time.
 *   - It never throws: a read-only home must not keep the agent from
 *     connecting.
 */
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A hundred years. Claude Code treats the value as days. */
export const RETENTION_DAYS = 36500;

export type RetentionResult = 'unchanged' | 'written' | 'created' | 'skipped';

/** Where Claude Code reads user settings from (`CLAUDE_CONFIG_DIR` moves it). */
export function claudeSettingsPath(): string {
  const dir = process.env['CLAUDE_CONFIG_DIR'] || path.join(os.homedir(), '.claude');
  return path.join(dir, 'settings.json');
}

/** The new file content, or `null` when the file must not be touched. Kept
 *  apart from the I/O so the rules above can be tested directly. */
export function retainedSettings(raw: string | undefined): { text: string; changed: boolean } | null {
  if (raw === undefined || raw.trim() === '') {
    return { text: `${JSON.stringify({ cleanupPeriodDays: RETENTION_DAYS }, null, 2)}\n`, changed: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const current = obj['cleanupPeriodDays'];
  if (typeof current === 'number' && current >= RETENTION_DAYS) return { text: raw, changed: false };
  obj['cleanupPeriodDays'] = RETENTION_DAYS;
  return { text: `${JSON.stringify(obj, null, 2)}\n`, changed: true };
}

export function ensureTranscriptRetention(file: string = claudeSettingsPath()): RetentionResult {
  try {
    const isLink = (() => {
      try {
        return lstatSync(file).isSymbolicLink();
      } catch {
        return false;
      }
    })();
    const exists = existsSync(file);
    if (isLink && !exists) {
      console.warn(`[agent] ${file} is a symlink to nowhere; transcript retention left as it is`);
      return 'skipped';
    }
    const target = exists ? realpathSync(file) : file;
    const raw = exists ? readFileSync(target, 'utf8') : undefined;
    const next = retainedSettings(raw);
    if (!next) {
      console.warn(`[agent] ${file} is not a JSON object; transcript retention left as it is`);
      return 'skipped';
    }
    if (!next.changed) return 'unchanged';
    const st = exists ? statSync(target) : undefined;
    const mode = st ? st.mode & 0o777 : 0o600;
    mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.cc-remote-${process.pid}.tmp`;
    writeFileSync(tmp, next.text, { mode });
    try {
      chmodSync(tmp, mode);
      // Only root can hand a file to someone else; for anyone else the new
      // file is already theirs, which is what the old one was.
      if (st && process.geteuid?.() === 0 && (st.uid !== 0 || st.gid !== 0)) chownSync(tmp, st.uid, st.gid);
      const now = exists ? readFileSync(target, 'utf8') : undefined;
      if (now !== raw) {
        rmSync(tmp, { force: true });
        console.warn(`[agent] ${target} changed while being updated; transcript retention will be set next start`);
        return 'skipped';
      }
      renameSync(tmp, target);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    console.log(`[agent] cleanupPeriodDays=${RETENTION_DAYS} set in ${target} (Claude Code will not delete transcripts)`);
    return exists ? 'written' : 'created';
  } catch (e) {
    console.warn(`[agent] could not set transcript retention in ${file}: ${(e as Error).message}`);
    return 'skipped';
  }
}
