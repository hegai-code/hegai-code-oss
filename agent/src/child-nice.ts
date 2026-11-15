import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';

/**
 * Keep the agent ahead of the work it starts.
 *
 * The agent shares the box with everything its sessions run: the runtime CLIs
 * and whatever they spawn (eslint, tsc, vite, test suites, ffmpeg, browsers).
 * 16.10.2026 on stage: fifteen live sessions held the load average at 70–100
 * on 8 cores. The agent's main thread was runnable but got roughly a tenth of
 * a core — a `setTimeout(0)` waited 0.2–1.7 s, a `stat` took a second — so a
 * phone asking for history waited past the hub's 6 s deadline every time, and
 * the replica pass needed 35 minutes for one transcript. Brand-new sessions
 * have no replica to fall back to: they opened blank on the phone.
 *
 * Nothing in Node sets the priority of a child at spawn, and the Claude SDK
 * spawns its own. So a periodic pass walks every process below the agent and
 * raises its niceness to `childNice()` — every thread, because Linux keeps
 * niceness per thread and a runtime has its threads up within milliseconds.
 * Once a runtime is niced, what it spawns afterwards inherits that. The pass
 * only ever RAISES niceness: a process someone made nicer still is left alone,
 * and the agent itself is never touched.
 *
 * Linux only — it reads `/proc`. `CC_REMOTE_CHILD_NICE=0` turns it off.
 */

export const CHILD_NICE_DEFAULT = 10;
const PASS_MS = 5_000;

/** `CC_REMOTE_CHILD_NICE`: 1–19, `0` turns it off. */
export function childNice(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['CC_REMOTE_CHILD_NICE'];
  if (raw === undefined || raw.trim() === '') return CHILD_NICE_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return CHILD_NICE_DEFAULT;
  return Math.min(n, 19);
}

export interface ProcFs {
  /** Thread ids of `pid`. */
  tasks(pid: number): number[];
  /** Direct children of thread `tid` of `pid`. */
  children(pid: number, tid: number): number[];
  getPriority(tid: number): number;
  setPriority(tid: number, nice: number): void;
}

const ints = (text: string): number[] =>
  text
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);

export const linuxProcFs: ProcFs = {
  tasks: (pid) => ints(readdirSync(`/proc/${pid}/task`).join(' ')),
  children: (pid, tid) => ints(readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8')),
  getPriority: (tid) => os.getPriority(tid),
  setPriority: (tid, nice) => os.setPriority(tid, nice),
};

/** One pass: every descendant of `root` gets at least `nice`. Returns how many
 *  threads it changed. A process that exits mid-walk is simply skipped; a
 *  refusal (EPERM/EACCES — a child that changed uid) goes to `onDenied`.
 *
 *  What it cannot see: a grandchild orphaned (reparented to init) before the
 *  pass reached its parent. That window is only the first seconds of a run —
 *  once the runtime itself is niced, everything it forks inherits the value. */
export function deprioritizeDescendants(
  root: number,
  nice: number,
  fs: ProcFs = linuxProcFs,
  onDenied: (err: Error) => void = () => {},
): number {
  let changed = 0;
  const seen = new Set<number>([root]);
  const queue: number[] = [];
  const childrenOf = (pid: number): number[] => {
    const out: number[] = [];
    let tids: number[] = [];
    try {
      tids = fs.tasks(pid);
    } catch {
      return out;
    }
    for (const tid of tids) {
      try {
        out.push(...fs.children(pid, tid));
      } catch {
        /* thread gone */
      }
    }
    return out;
  };
  for (const c of childrenOf(root)) if (!seen.has(c)) (seen.add(c), queue.push(c));
  for (let i = 0; i < queue.length; i++) {
    const pid = queue[i]!;
    let tids: number[] = [];
    try {
      tids = fs.tasks(pid);
    } catch {
      continue; // exited
    }
    for (const tid of tids) {
      try {
        if (fs.getPriority(tid) < nice) {
          fs.setPriority(tid, nice);
          changed++;
        }
      } catch (err) {
        // os.setPriority throws ERR_SYSTEM_ERROR with the errno in `info.code`.
        const codes = [(err as NodeJS.ErrnoException).code, (err as { info?: { code?: string } }).info?.code];
        if (codes.includes('EPERM') || codes.includes('EACCES')) onDenied(err as Error);
        // anything else: the thread is gone
      }
    }
    for (const c of childrenOf(pid)) if (!seen.has(c)) (seen.add(c), queue.push(c));
  }
  return changed;
}

/** Start the periodic pass. No-op off Linux or when turned off. */
export function startChildNice(nice: number = childNice()): void {
  if (process.platform !== 'linux' || nice <= 0) return;
  let warned = false;
  const warn = (err: Error) => {
    if (warned) return;
    warned = true;
    console.warn('[agent] child priority pass failed:', err.message);
  };
  const pass = () => {
    try {
      deprioritizeDescendants(process.pid, nice, linuxProcFs, warn);
    } catch (err) {
      warn(err as Error);
    }
  };
  pass();
  setInterval(pass, PASS_MS).unref();
}
