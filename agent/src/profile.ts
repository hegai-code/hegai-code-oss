import os from 'node:os';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { BuilderProfile, NamedCount } from '@cc-remote/shared';

/**
 * Local builder-profile computation. Scans this machine's Claude Code
 * transcripts under ~/.claude/projects and reduces them into a
 * BuilderProfile — a "how you build with AI" report. Everything happens on-box:
 * no excerpt, prompt, or file content ever leaves the machine, only the reduced
 * numbers in the returned object (which the agent then sends to the hub).
 *
 * Deliberately NOT reusing history.ts#parseRecord: that normalizer throws away
 * the fields a profile is built from (timestamp, cwd, gitBranch, message.model,
 * per-record sessionId). We do our own field-preserving pass over the raw lines.
 *
 * Sidechain records (Task sub-agent transcripts, `isSidechain: true`) are
 * excluded so the profile reflects how *you* drive, not how spawned agents do.
 */

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

const TEST_RE = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|vitest|jest|pytest|cargo\s+test|go\s+test|rspec|mocha|phpunit|tsc\b.*--noemit)\b/i;
const GIT_RE = /^\s*git\b/;

const EXT_LANG: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', rs: 'Rust', go: 'Go', java: 'Java', rb: 'Ruby', php: 'PHP',
  c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++', cs: 'C#', swift: 'Swift',
  kt: 'Kotlin', scala: 'Scala', css: 'CSS', scss: 'CSS', less: 'CSS',
  html: 'HTML', md: 'Markdown', mdx: 'Markdown', json: 'JSON', yml: 'YAML',
  yaml: 'YAML', sh: 'Shell', bash: 'Shell', ps1: 'PowerShell', sql: 'SQL',
  toml: 'TOML', vue: 'Vue', svelte: 'Svelte', dart: 'Dart', ex: 'Elixir',
};

// Extensions/files that hint at product/UI/docs surface — the (weak) product proxy.
const PRODUCT_EXT = new Set(['tsx', 'jsx', 'vue', 'svelte', 'css', 'scss', 'less', 'html', 'md', 'mdx', 'svg']);

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Update']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);
// Shell-command tools: Bash on unix, PowerShell on Windows — both carry `command`.
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

interface SessionAgg {
  firstTs: number;
  lastTs: number;
  messages: number;
  models: Set<string>;
  usedPlan: boolean;
  usedTodo: boolean;
}

interface Acc {
  transcripts: number;
  userPrompts: number;
  assistant: number;
  promptChars: number[];
  hour: number[]; // 24
  weekday: number[]; // 7
  nightMsgs: number;
  timedMsgs: number;
  days: Set<string>;
  firstTs: number;
  lastTs: number;
  toolCounts: Map<string, number>;
  shellTotal: number;
  shellTests: number;
  shellGit: number;
  editWrite: number;
  readGrep: number;
  files: Set<string>;
  langs: Map<string, number>;
  productFiles: number;
  repos: Set<string>;
  branches: Set<string>;
  skills: Map<string, number>;
  models: Map<string, number>;
  sessions: Map<string, SessionAgg>;
}

function newAcc(): Acc {
  return {
    transcripts: 0, userPrompts: 0, assistant: 0, promptChars: [],
    hour: new Array(24).fill(0), weekday: new Array(7).fill(0),
    nightMsgs: 0, timedMsgs: 0, days: new Set(), firstTs: Infinity, lastTs: 0,
    toolCounts: new Map(), shellTotal: 0, shellTests: 0, shellGit: 0,
    editWrite: 0, readGrep: 0, files: new Set(), langs: new Map(),
    productFiles: 0, repos: new Set(), branches: new Set(),
    skills: new Map(), models: new Map(), sessions: new Map(),
  };
}

function bump(m: Map<string, number>, key: string, by = 1): void {
  m.set(key, (m.get(key) ?? 0) + by);
}

function sessionOf(acc: Acc, id: string): SessionAgg {
  let s = acc.sessions.get(id);
  if (!s) {
    s = { firstTs: Infinity, lastTs: 0, messages: 0, models: new Set(), usedPlan: false, usedTodo: false };
    acc.sessions.set(id, s);
  }
  return s;
}

function textOf(content: unknown): { text: string; hasText: boolean } {
  if (typeof content === 'string') return { text: content, hasText: content.trim().length > 0 };
  if (!Array.isArray(content)) return { text: '', hasText: false };
  let text = '';
  for (const raw of content) {
    const b = raw as Record<string, unknown>;
    if (b['type'] === 'text' && typeof b['text'] === 'string') text += b['text'];
  }
  return { text, hasText: text.trim().length > 0 };
}

/** Fold one parsed transcript record into the accumulator. */
function ingest(acc: Acc, rec: Record<string, unknown>): void {
  const type = rec['type'];
  if (type !== 'user' && type !== 'assistant') return;
  if (rec['isSidechain'] === true) return; // sub-agent thread, not the human's driving
  const message = rec['message'] as Record<string, unknown> | undefined;
  if (!message) return;

  const sessionId = typeof rec['sessionId'] === 'string' ? rec['sessionId'] : undefined;
  const sess = sessionId ? sessionOf(acc, sessionId) : undefined;

  // Timestamp → cadence.
  const ts = typeof rec['timestamp'] === 'string' ? Date.parse(rec['timestamp']) : NaN;
  if (!Number.isNaN(ts)) {
    const d = new Date(ts);
    const h = d.getHours();
    const wd = d.getDay();
    acc.hour[h] = (acc.hour[h] ?? 0) + 1;
    acc.weekday[wd] = (acc.weekday[wd] ?? 0) + 1;
    acc.timedMsgs++;
    if (h >= 22 || h < 5) acc.nightMsgs++;
    acc.days.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
    if (ts < acc.firstTs) acc.firstTs = ts;
    if (ts > acc.lastTs) acc.lastTs = ts;
    if (sess) {
      if (ts < sess.firstTs) sess.firstTs = ts;
      if (ts > sess.lastTs) sess.lastTs = ts;
    }
  }

  // Repo / branch surface.
  const cwd = rec['cwd'];
  if (typeof cwd === 'string' && cwd) {
    const seg = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    if (seg) acc.repos.add(seg);
  }
  const branch = rec['gitBranch'];
  if (typeof branch === 'string' && branch) acc.branches.add(branch);

  if (sess) sess.messages++;

  if (type === 'user') {
    const { text, hasText } = textOf(message['content']);
    // Skip local-command echoes and pure tool_result turns — count real prompts.
    if (hasText && !text.includes('<command-name>') && !text.includes('<local-command')) {
      acc.userPrompts++;
      acc.promptChars.push(text.trim().length);
    }
    return;
  }

  // assistant
  acc.assistant++;
  const model = message['model'];
  if (typeof model === 'string' && model) {
    bump(acc.models, model);
    sess?.models.add(model);
  }
  const content = message['content'];
  if (!Array.isArray(content)) return;
  for (const raw of content) {
    const b = raw as Record<string, unknown>;
    if (b['type'] !== 'tool_use') continue;
    const name = String(b['name'] ?? '');
    if (!name) continue;
    bump(acc.toolCounts, name);
    if (EDIT_TOOLS.has(name)) acc.editWrite++;
    if (READ_TOOLS.has(name)) acc.readGrep++;
    const input = (b['input'] ?? {}) as Record<string, unknown>;

    if (SHELL_TOOLS.has(name)) {
      const cmd = String(input['command'] ?? '');
      acc.shellTotal++;
      if (TEST_RE.test(cmd)) acc.shellTests++;
      if (GIT_RE.test(cmd)) acc.shellGit++;
    } else if (EDIT_TOOLS.has(name)) {
      const fp = String(input['file_path'] ?? input['notebook_path'] ?? '');
      if (fp) {
        acc.files.add(fp);
        const ext = fp.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase() ?? '';
        const base = fp.split(/[\\/]/).pop()?.toLowerCase() ?? '';
        if (ext) bump(acc.langs, EXT_LANG[ext] ?? ext.toUpperCase());
        if (PRODUCT_EXT.has(ext) || base.startsWith('readme')) acc.productFiles++;
      }
    } else if (name === 'Skill') {
      const skill = String(input['skill'] ?? input['command'] ?? input['name'] ?? '');
      if (skill) bump(acc.skills, skill);
    } else if (name === 'TodoWrite') {
      if (sess) sess.usedTodo = true;
    } else if (name === 'ExitPlanMode') {
      if (sess) sess.usedPlan = true;
    }
  }
}

function topN(m: Map<string, number>, n: number): NamedCount[] {
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}

function mapToRecord(m: Map<string, number>, n: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { name, count } of topN(m, n)) out[name] = count;
  return out;
}

function longestStreak(days: Set<string>): number {
  // days keyed "Y-M-D" (local). Convert to sorted epoch-day integers.
  const ints = [...days]
    .map((k) => {
      const parts = k.split('-').map(Number);
      const [y, mo, d] = [parts[0] ?? 1970, parts[1] ?? 0, parts[2] ?? 1];
      return Math.floor(new Date(y, mo, d).getTime() / 86_400_000);
    })
    .sort((a, b) => a - b);
  let best = ints.length ? 1 : 0;
  let run = best;
  for (let i = 1; i < ints.length; i++) {
    const cur = ints[i] ?? 0;
    const prev = ints[i - 1] ?? 0;
    run = cur === prev + 1 ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

const clamp = (x: number, lo = 0, hi = 10): number => Math.max(lo, Math.min(hi, x));
const norm = (x: number, anchor: number): number => clamp((x / anchor) * 10); // value→0..10 at anchor
const round1 = (x: number): number => Math.round(x * 10) / 10;
// 0..1 shares need finer resolution — round1 would flatten anything under 5% to 0.
const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Assemble the derived BuilderProfile from the accumulator. */
function finalize(acc: Acc, machine: string, machineId?: string): BuilderProfile {
  const sessions = acc.sessions.size || 1;
  const totalMsgs = acc.timedMsgs || 1;
  const nightOwlShare = round3(acc.nightMsgs / totalMsgs);

  let sessMinutes = 0;
  let modelSum = 0;
  let planCount = 0;
  let todoCount = 0;
  for (const s of acc.sessions.values()) {
    if (s.lastTs > s.firstTs) sessMinutes += (s.lastTs - s.firstTs) / 60_000;
    modelSum += s.models.size;
    if (s.usedPlan) planCount++;
    if (s.usedTodo) todoCount++;
  }

  const promptChars = acc.promptChars;
  const avgPromptChars = promptChars.length
    ? Math.round(promptChars.reduce((a, b) => a + b, 0) / promptChars.length)
    : 0;
  const shortPromptShare = promptChars.length
    ? round3(promptChars.filter((c) => c < 80).length / promptChars.length)
    : 0;
  const longPromptShare = promptChars.length
    ? round3(promptChars.filter((c) => c > 600).length / promptChars.length)
    : 0;

  const buildVsExplore = acc.editWrite + acc.readGrep > 0
    ? round3(acc.editWrite / (acc.editWrite + acc.readGrep))
    : 0;
  const testRunShare = acc.shellTotal ? round3(acc.shellTests / acc.shellTotal) : 0;
  const gitOpShare = acc.shellTotal ? round3(acc.shellGit / acc.shellTotal) : 0;
  const totalTools = [...acc.toolCounts.values()].reduce((a, b) => a + b, 0);
  const toolCallsPerSession = round1(totalTools / sessions);
  const planModeShare = round3(planCount / sessions);
  const todoShare = round3(todoCount / sessions);
  const followUpsPerSession = round1(acc.userPrompts / sessions);
  const avgSessionMinutes = round1(sessMinutes / sessions);
  const avgSessionMessages = round1((acc.userPrompts + acc.assistant) / sessions);
  const readShare = totalTools ? acc.readGrep / totalTools : 0;

  // Five 0..10 dimension scores — documented weighted blends of the metrics above.
  const scores = {
    steering: round1(clamp(0.5 * norm(avgPromptChars, 400) + 3 * longPromptShare + 0.2 * norm(followUpsPerSession, 12))),
    execution: round1(clamp(0.5 * norm(toolCallsPerSession, 60) + 4 * buildVsExplore + 0.1 * norm(acc.editWrite / sessions, 20))),
    engineering: round1(clamp(40 * testRunShare + 30 * gitOpShare + 12 * readShare)),
    planning: round1(clamp(14 * planModeShare + 12 * todoShare + norm(acc.skills.size, 8))),
    product: round1(clamp(norm(acc.productFiles / (acc.files.size || 1), 0.5) )),
  };

  const langCount = acc.langs.size;
  const candidates: Array<{ name: string; pass: boolean; strength: number }> = [
    { name: 'Night Owl', pass: nightOwlShare >= 0.35, strength: nightOwlShare },
    { name: 'Quality Guardian', pass: testRunShare >= 0.12, strength: testRunShare + readShare },
    { name: 'Velocity Machine', pass: toolCallsPerSession >= 40 && testRunShare < 0.08 && buildVsExplore >= 0.6, strength: buildVsExplore * (toolCallsPerSession / 60) },
    { name: 'Architect', pass: (planModeShare + todoShare) >= 0.3 && longPromptShare >= 0.1 && acc.repos.size >= 3, strength: planModeShare + todoShare + longPromptShare },
    { name: 'Scholar', pass: buildVsExplore <= 0.35 && totalTools > 20, strength: 1 - buildVsExplore },
    { name: 'Debugger', pass: (gitOpShare + testRunShare) >= 0.25 && acc.shellTotal > 20, strength: gitOpShare + testRunShare },
    { name: 'Polyglot', pass: langCount >= 4, strength: langCount / 10 },
    { name: 'Marathoner', pass: avgSessionMinutes >= 25, strength: avgSessionMinutes / 60 },
  ];
  const passed = candidates.filter((c) => c.pass).sort((a, b) => b.strength - a.strength);
  const primary = passed[0]?.name ?? 'All-Rounder';
  const badges = passed.slice(1, 5).map((c) => c.name);

  return {
    machine,
    ...(machineId ? { machineId } : {}),
    generatedAt: Date.now(),
    transcriptsScanned: acc.transcripts,
    sessions: acc.sessions.size,
    messages: { user: acc.userPrompts, assistant: acc.assistant },
    span: {
      firstTs: acc.firstTs === Infinity ? 0 : acc.firstTs,
      lastTs: acc.lastTs,
      activeDays: acc.days.size,
      longestStreakDays: longestStreak(acc.days),
    },
    cadence: {
      hourHistogram: acc.hour,
      weekdayHistogram: acc.weekday,
      nightOwlShare,
      avgSessionMessages,
      avgSessionMinutes,
    },
    tools: {
      counts: mapToRecord(acc.toolCounts, 16),
      buildVsExplore,
      testRunShare,
      gitOpShare,
      toolCallsPerSession,
    },
    steering: { avgPromptChars, shortPromptShare, longPromptShare, followUpsPerSession },
    engineering: {
      filesTouched: acc.files.size,
      topLanguages: topN(acc.langs, 8),
      repos: acc.repos.size,
      branches: acc.branches.size,
    },
    planning: { planModeShare, todoShare, topSkills: topN(acc.skills, 8) },
    models: { histogram: mapToRecord(acc.models, 8), avgModelsPerSession: round1(modelSum / sessions) },
    scores,
    archetype: { primary, badges },
  };
}

async function listTranscripts(): Promise<string[]> {
  let dirs: string[];
  try {
    dirs = await readdir(PROJECTS_DIR);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const d of dirs) {
    try {
      // Only the top-level session transcripts (one level down). Deeper files
      // like <session>/subagents/*.jsonl are Task sub-agent threads — excluded
      // on purpose so the profile reflects the human's own sessions.
      const entries = await readdir(path.join(PROJECTS_DIR, d));
      for (const e of entries) if (e.endsWith('.jsonl')) files.push(path.join(PROJECTS_DIR, d, e));
    } catch {
      /* not a dir / unreadable */
    }
  }
  return files;
}

/**
 * Scan all local transcripts and reduce them into a BuilderProfile. Pure and
 * standalone-callable (used by both the agent's periodic push and the
 * `npm run profile` CLI). Streams every file line-by-line so neither one huge
 * transcript nor a 400MB+ corpus is ever retained in memory.
 */
export async function computeProfile(opts: { machine: string; machineId?: string }): Promise<BuilderProfile> {
  const acc = newAcc();
  const files = await listTranscripts();
  for (const file of files) {
    try {
      const lines = createInterface({
        input: createReadStream(file, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          ingest(acc, JSON.parse(trimmed) as Record<string, unknown>);
        } catch {
          /* skip malformed / partial line */
        }
      }
    } catch {
      continue;
    }
    acc.transcripts++;
  }
  return finalize(acc, opts.machine, opts.machineId);
}
