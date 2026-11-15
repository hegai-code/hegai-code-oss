import os from 'node:os';
import { readFile, statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MachineStats, ProcessSample } from '@cc-remote/shared';
import { maskSecrets } from './secret-mask.js';

const execFileP = promisify(execFile);

/**
 * Lightweight hardware/process telemetry for the machine the agent runs on.
 * One sample = a handful of /proc reads (Linux) or one ps/df/vm_stat exec
 * (macOS); safe to run on a shared production box every ~30s.
 */

/** Top-N processes shipped with each periodic sample. */
const TOP_PROCESSES = 12;
/** Cap for the on-demand `proc.list` RPC. */
const LIST_PROCESSES = 60;
const CMD_MAX_CHARS = 120;

// CPU% is a delta between consecutive os.cpus() snapshots — the first call
// after startup has no baseline and reports 0.
let prevCpu: { idle: number; total: number } | null = null;
let prevAgentCpu: { usage: NodeJS.CpuUsage; at: number } | null = null;

function cpuSnapshot(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

function cpuPercent(): number {
  const now = cpuSnapshot();
  const prev = prevCpu;
  prevCpu = now;
  if (!prev || now.total <= prev.total) return 0;
  const busy = now.total - prev.total - (now.idle - prev.idle);
  return Math.max(0, Math.min(100, (busy / (now.total - prev.total)) * 100));
}

function agentCpuPercent(): number {
  const at = Date.now();
  const usage = process.cpuUsage();
  const prev = prevAgentCpu;
  prevAgentCpu = { usage, at };
  if (!prev || at <= prev.at) return 0;
  const usedUs = usage.user + usage.system - prev.usage.user - prev.usage.system;
  return Math.max(0, Math.min(100, usedUs / 1000 / (at - prev.at) * 100));
}

/** memUsed honoring reclaimable memory: MemAvailable on Linux, vm_stat on mac. */
async function memory(): Promise<{ total: number; used: number; swapTotal: number; swapUsed: number }> {
  const total = os.totalmem();
  if (process.platform === 'linux') {
    try {
      const text = await readFile('/proc/meminfo', 'utf8');
      const kb = (name: string): number => {
        const m = text.match(new RegExp(`^${name}:\\s+(\\d+) kB`, 'm'));
        return m ? Number(m[1]) * 1024 : 0;
      };
      const avail = kb('MemAvailable');
      const swapTotal = kb('SwapTotal');
      return {
        total: kb('MemTotal') || total,
        used: (kb('MemTotal') || total) - avail,
        swapTotal,
        swapUsed: swapTotal - kb('SwapFree'),
      };
    } catch {
      /* fall through to the os module */
    }
  }
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileP('vm_stat', [], { timeout: 5000 });
      const pageSize = Number(stdout.match(/page size of (\d+)/)?.[1] ?? 4096);
      const pages = (name: string): number =>
        Number(stdout.match(new RegExp(`${name}:\\s+(\\d+)\\.`))?.[1] ?? 0);
      const reclaimable =
        pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable');
      const swap = await macSwap();
      return { total, used: Math.max(0, total - reclaimable * pageSize), ...swap };
    } catch {
      /* fall through */
    }
  }
  return { total, used: total - os.freemem(), swapTotal: 0, swapUsed: 0 };
}

/**
 * macOS swap. It used to be hard-coded to zero, which hid the one number that
 * says a Mac is out of memory: 8.9 of 10 GB swapped on the mini (25.09.2026)
 * while the memory bar looked comfortable. `vm.swapusage` prints
 * `total = 10240.00M  used = 8935.50M  free = 1304.50M  (encrypted)`.
 */
async function macSwap(): Promise<{ swapTotal: number; swapUsed: number }> {
  try {
    const { stdout } = await execFileP('sysctl', ['-n', 'vm.swapusage'], { timeout: 5000 });
    return { swapTotal: parseMacSize(stdout, 'total'), swapUsed: parseMacSize(stdout, 'used') };
  } catch {
    return { swapTotal: 0, swapUsed: 0 };
  }
}

/** `total = 10240.00M` → bytes. Exported for the test. */
export function parseMacSize(text: string, name: string): number {
  const m = text.match(new RegExp(`${name}\\s*=\\s*([\\d.]+)([KMGT])?`));
  if (!m) return 0;
  const mult = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2] as 'K' | 'M' | 'G' | 'T'] ?? 1;
  return Math.round(Number(m[1]) * mult);
}

/**
 * The volume the machine's work lives on — the home directory's, not `/`.
 *
 * It was `df -k /`, which was wrong on every platform in a different way:
 * on macOS `/` is the sealed read-only system volume (12 GB "used" of 239 on a
 * disk that was 91% full — the data sits on /System/Volumes/Data); on Windows
 * there is no `df`, so the card had no disk row at all; on Linux `df`'s Used
 * leaves out the root-reserved blocks, so the bar ran out later than the disk.
 * `statfs` exists on all three, and `used = total − available` counts the
 * reserve as gone — it is, for anything this agent runs.
 */
async function disk(): Promise<{ total: number; used: number }> {
  try {
    const s = await statfs(os.homedir());
    const total = s.blocks * s.bsize;
    const used = total - s.bavail * s.bsize;
    if (Number.isFinite(total) && total > 0 && Number.isFinite(used)) return { total, used: Math.max(0, used) };
  } catch {
    /* statfs unsupported / home unreadable */
  }
  return { total: 0, used: 0 };
}

async function psSample(limit: number): Promise<ProcessSample[]> {
  // `axo` with `=` headers works on both Linux and macOS; sort in JS because
  // --sort is GNU-only. args (not comm) so .vscode-server / claude are visible.
  const { stdout } = await execFileP('ps', ['axo', 'pid=,pcpu=,rss=,args='], {
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const out: ProcessSample[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    out.push({
      pid,
      cpu: Number(m[2]),
      rss: Number(m[3]) * 1024,
      command: m[4]!.slice(0, CMD_MAX_CHARS + 256),
    });
  }
  out.sort((a, b) => b.cpu - a.cpu || b.rss - a.rss);
  // Only the rows that leave the machine are masked, and masked BEFORE the
  // final cut so a secret straddling the limit is not half-shown.
  return out
    .slice(0, limit)
    .map((p) => ({ ...p, command: maskSecrets(p.command, { strict: true }).slice(0, CMD_MAX_CHARS) }));
}

export async function sampleMachineStats(): Promise<MachineStats> {
  const [mem, dsk, top] = await Promise.all([memory(), disk(), psSample(TOP_PROCESSES).catch(() => [])]);
  const [l1, l5, l15] = os.loadavg();
  return {
    ts: Date.now(),
    platform: process.platform,
    cpuCount: os.cpus().length,
    load1: l1 ?? 0,
    load5: l5 ?? 0,
    load15: l15 ?? 0,
    cpuPercent: cpuPercent(),
    memTotal: mem.total,
    memUsed: mem.used,
    swapTotal: mem.swapTotal,
    swapUsed: mem.swapUsed,
    diskTotal: dsk.total,
    diskUsed: dsk.used,
    uptimeSec: Math.round(os.uptime()),
    agentRss: process.memoryUsage().rss,
    agentCpuPercent: agentCpuPercent(),
    top,
  };
}

export async function listProcesses(): Promise<{ processes: ProcessSample[] }> {
  return { processes: await psSample(LIST_PROCESSES) };
}

export function killProcess(pid: number, signal: 'TERM' | 'KILL'): { ok: boolean; error?: string } {
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, error: 'invalid pid' };
  if (pid === process.pid) return { ok: false, error: 'refusing to kill the agent itself' };
  try {
    process.kill(pid, signal === 'KILL' ? 'SIGKILL' : 'SIGTERM');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
