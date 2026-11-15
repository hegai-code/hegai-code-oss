import { chmodSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RunBy } from '@cc-remote/shared';
import { stateDir } from './config.js';

/**
 * Per-run identity file, exported to the coder as HEGAI_RUN_STATE_FILE.
 *
 * HEGAI_RUN_USER_* is fixed for the life of the coder process, but a colleague
 * can type into a live run. This file says who authored the latest turn:
 * `{startedBy, lastInputBy, updatedAt}`. A cooperative script should act for a
 * person only when `lastInputBy.userId` equals HEGAI_RUN_USER_ID. Hint, not a
 * boundary: the coder (often root) can read and write anything the agent can.
 *
 * Private dir (0700), file 0600, replaced atomically (tmp + rename).
 */
export function runStateDir(): string {
  return path.join(stateDir(), 'run-state');
}

// `.` and `..` are legal characters but path components: with a per-run dir they
// would name the run-state root or the state dir itself.
const SAFE_ID = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,200}$/;

/** Confined runs (CC_REMOTE_CONFINE_RUNS) get a directory of their own, so the
 *  sandbox can see exactly this run's file and the agent's atomic rename inside
 *  it. Unset: the flat `<runId>.json`, as always. */
function perRunDir(): boolean {
  return !!process.env['CC_REMOTE_CONFINE_RUNS']?.trim();
}

export function runStatePath(runId: string): string | undefined {
  if (!SAFE_ID.test(runId)) return undefined;
  return perRunDir() ? path.join(runStateDir(), runId, 'state.json') : path.join(runStateDir(), `${runId}.json`);
}

function write(runId: string, startedBy: RunBy | null, lastInputBy: RunBy | null): string | undefined {
  const file = runStatePath(runId);
  if (!file) return undefined;
  try {
    const dir = path.dirname(file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ startedBy, lastInputBy, updatedAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
    renameSync(tmp, file);
    return file;
  } catch (err) {
    console.warn(`[agent] run-state for ${runId} not written: ${(err as Error).message}`);
    // Fail closed: a stale file would keep naming a previous author.
    for (const stale of [file, `${file}.${process.pid}.tmp`]) {
      try {
        rmSync(stale, { force: true });
      } catch {
        // nothing more to do
      }
    }
    return undefined;
  }
}

/** Create the file for a run about to start; returns its path (undefined if it could not be written). */
export function createRunState(runId: string, startedBy: RunBy | undefined): string | undefined {
  return write(runId, startedBy ?? null, startedBy ?? null);
}

/** Record who authored the turn about to be handed to the coder (null = unknown/non-UI). */
export function recordRunInput(runId: string, startedBy: RunBy | undefined, by: RunBy | null): void {
  write(runId, startedBy ?? null, by);
}

export function removeRunState(runId: string): void {
  const file = runStatePath(runId);
  if (!file) return;
  try {
    rmSync(perRunDir() ? path.dirname(file) : file, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/** Files of runs from a previous agent process are meaningless. */
export function sweepRunState(): void {
  try {
    // A symlink planted as the root is unlinked, never listed: readdir would
    // follow it and the sweep would delete the children of its target.
    if (lstatSync(runStateDir()).isSymbolicLink()) {
      rmSync(runStateDir(), { force: true });
      return;
    }
    for (const name of readdirSync(runStateDir())) rmSync(path.join(runStateDir(), name), { recursive: true, force: true });
  } catch {
    // no dir yet
  }
}
