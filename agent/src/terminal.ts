import os from 'node:os';
import { PtyInput, fdWriter, type RawWrite } from './pty-input.js';
import { childEnv } from './child-env.js';

/**
 * Manages interactive pty sessions on this machine, keyed by a central-allocated
 * termId. node-pty is a native module, so it is loaded lazily — a machine where
 * it fails to load still runs the agent (terminals just report unavailable).
 */

// Loose types: the native module is resolved at runtime.
export type IPty = { onData: (cb: (d: string) => void) => void; onExit: (cb: (e: { exitCode: number }) => void) => void; write: (d: string) => void; resize: (c: number, r: number) => void; kill: () => void; readonly fd?: number };
export type PtyModule = { spawn: (file: string, args: string[], opts: Record<string, unknown>) => IPty };

function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') return { file: 'powershell.exe', args: [] };
  const shell = process.env['SHELL'] || '/bin/bash';
  return { file: shell, args: [] };
}

/**
 * How input reaches the pty. NEVER `term.write()` on Unix: node-pty writes
 * through a libuv tty handle that spins on EAGAIN, and one long line froze the
 * whole agent for good (see pty-input.ts). The master fd is non-blocking, so
 * the async `fs.write` on it is safe. ConPTY on Windows writes into a pipe
 * socket that queues instead of spinning, and has no fd to write to.
 */
export function ptyWriter(term: IPty, platform: NodeJS.Platform = process.platform): RawWrite {
  if (platform !== 'win32' && typeof term.fd === 'number') return fdWriter(term.fd);
  return (buf, cb) => {
    try {
      term.write(buf.toString('utf8'));
      cb(null, buf.length);
    } catch (err) {
      cb(err as NodeJS.ErrnoException, 0);
    }
  };
}

export class TerminalManager {
  private readonly terms = new Map<string, IPty>();
  private readonly inputs = new Map<string, PtyInput>();

  /** `mod` is injectable so tests can drive `open` with a fake pty; production
   *  leaves it null and the native module is loaded lazily on first open. */
  constructor(private mod: PtyModule | null = null) {}

  /** Shells open right now — somebody typing in one must not be restarted out
   *  from under by a self-update. */
  get count(): number {
    return this.terms.size;
  }
  private modError: string | null = null;

  private async load(): Promise<void> {
    if (this.mod || this.modError) return;
    try {
      this.mod = (await import('@homebridge/node-pty-prebuilt-multiarch')) as unknown as PtyModule;
    } catch (err) {
      this.modError = (err as Error).message;
    }
  }

  async open(
    termId: string,
    cwd: string | undefined,
    onData: (data: string) => void,
    onExit: (code?: number) => void,
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.terms.has(termId)) return { ok: true };
    await this.load();
    if (!this.mod) return { ok: false, error: `pty unavailable: ${this.modError}` };

    const { file, args } = defaultShell();
    // node-pty's spawn throws synchronously (bad cwd, no pty device). That must
    // come back as a failed open, with nothing registered: a half-open term
    // would make the client believe it has a terminal that never produces
    // output or an exit.
    let term: IPty | undefined;
    try {
      term = this.mod.spawn(file, args, {
        name: 'xterm-color',
        cols: 80,
        rows: 24,
        cwd: cwd || os.homedir(),
        env: childEnv(),
      });
      const spawned = term;
      this.terms.set(termId, spawned);
      this.inputs.set(termId, new PtyInput({ write: ptyWriter(spawned), notice: onData }));
      spawned.onData(onData);
      spawned.onExit(({ exitCode }) => {
        if (this.terms.get(termId) === spawned) {
          this.terms.delete(termId);
          this.inputs.get(termId)?.dispose();
          this.inputs.delete(termId);
        }
        onExit(exitCode);
      });
    } catch (err) {
      this.terms.delete(termId);
      this.inputs.get(termId)?.dispose();
      this.inputs.delete(termId);
      try {
        term?.kill();
      } catch {
        /* never fully alive */
      }
      return { ok: false, error: (err as Error)?.message ?? String(err) };
    }
    return { ok: true };
  }

  input(termId: string, data: string): void {
    this.inputs.get(termId)?.push(data);
  }

  resize(termId: string, cols: number, rows: number): void {
    try {
      this.terms.get(termId)?.resize(Math.max(1, cols), Math.max(1, rows));
    } catch {
      /* ignore resize on dead pty */
    }
  }

  close(termId: string): void {
    const term = this.terms.get(termId);
    if (!term) return;
    this.terms.delete(termId);
    this.inputs.get(termId)?.dispose();
    this.inputs.delete(termId);
    try {
      term.kill();
    } catch {
      /* already gone */
    }
  }

  closeAll(): void {
    for (const id of [...this.terms.keys()]) this.close(id);
  }
}
