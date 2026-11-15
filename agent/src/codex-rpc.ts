import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { AGENT_VERSION } from './config.js';
import { spawnCodex } from './runtime-locate.js';

/**
 * A one-shot JSON-RPC conversation with a throwaway `codex app-server`: spawn
 * it, do the `initialize` / `initialized` handshake, run `fn`, kill it.
 *
 * For the questions that need an answer and nothing else — «which models does
 * Codex offer». It is NOT for a live session (those keep their app-server and
 * handle server-initiated requests) nor for a login (which outlives any one
 * call and waits on a server notification).
 */

export interface CodexRpc {
  /**
   * Resolves with the raw response frame, `result` or `error` alike — what an
   * error frame means is the caller's call (an older app-server answering
   * `config/read` with one is not a failure). Rejects when the deadline passes
   * or the process goes away first.
   */
  request(
    method: string,
    params: Record<string, unknown>,
    /** This call's own deadline; the client's `timeoutMs` otherwise. */
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
}

export interface CodexAppServerOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Deadline of EACH request, the handshake included. */
  timeoutMs: number;
}

/** `spawnCodex` failed — Codex is missing or would not start. The original error is `cause`. */
export class CodexSpawnError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'CodexSpawnError';
  }
}

export async function withCodexAppServer<T>(
  opts: CodexAppServerOptions,
  fn: (rpc: CodexRpc) => Promise<T>,
): Promise<T> {
  let child: ChildProcessWithoutNullStreams;
  try {
    ({ child } = await spawnCodex(['app-server'], {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
    }));
  } catch (error) {
    throw new CodexSpawnError(error);
  }

  interface Pending {
    resolve: (frame: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let gone: Error | undefined;
  const failAll = (error: Error) => {
    gone ??= error;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  };
  child.on('error', (error) => failAll(error));
  child.on('close', (code) => failAll(new Error(`codex app-server exited (${code ?? '?'})`)));
  // A write into a dead process surfaces as EPIPE here; `close` above is what reports it.
  child.stdin.on('error', () => {});
  child.stderr.resume();

  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = frame['id'];
    if (typeof id !== 'number') return;
    const waiting = pending.get(id);
    if (!waiting) return;
    pending.delete(id);
    clearTimeout(waiting.timer);
    waiting.resolve(frame);
  });

  const send = (frame: unknown) => {
    if (child.stdin.writable) child.stdin.write(`${JSON.stringify(frame)}\n`);
  };
  const request: CodexRpc['request'] = (method, params, timeoutMs) =>
    new Promise((resolve, reject) => {
      if (gone) {
        reject(gone);
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`codex ${method} timed out`));
      }, timeoutMs ?? opts.timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      send({ jsonrpc: '2.0', id, method, params });
    });

  try {
    await request('initialize', {
      clientInfo: { name: 'cc-remote', title: 'cc-remote', version: AGENT_VERSION },
      capabilities: { experimentalApi: true },
    });
    send({ jsonrpc: '2.0', method: 'initialized' });
    return await fn({ request });
  } finally {
    lines.close();
    child.kill('SIGTERM');
  }
}
