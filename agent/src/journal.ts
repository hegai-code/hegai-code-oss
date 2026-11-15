import { appendFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { CODEX_TRANSCRIPT_MAX_BYTES, MAX_LINE_BYTES, isEphemeralRollout, listRollouts, parseCodexRecord } from './codex.js';
import { journalCompletion } from './gateway.js';
import { readBoundedJsonlLines } from './file-range.js';
import { childEnv } from './child-env.js';
import { appendIndexEntry, memoryDirFor, overwriteMemoryIn, projectSlug, safeMemoryPath } from './memory.js';

const execFileAsync = promisify(execFile);

/**
 * Nightly consolidation — the step that turns a day of transcripts into memory.
 *
 * The corpus this machine already carries is entirely operational: where the hub
 * runs, which disk fills up, how a deploy breaks. Useful, and none of it is
 * autobiography. Notes written mid-session are deliberate note-taking; this is
 * the other half — an offline pass that reads what actually happened and decides
 * what is worth keeping. Personality is what survives that compression, so the
 * compression is the feature, not a storage optimisation.
 *
 * Transcripts are reduced locally. Only the bounded brief and existing memory
 * are sent to the Hegai gateway; no agent session or tools are needed.
 */

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const STATE_DIR = path.join(os.homedir(), '.cc-remote');

/**
 * Exclude transcripts of the old Claude-based consolidation job. New gateway
 * completions create no transcript, but the historical corpus still has these.
 */
const TEO_DIR = path.join(STATE_DIR, 'teo');
const TEO_SLUG = projectSlug(TEO_DIR);

/** Where Тео's notes live. `fleet--` replicates them to every machine. */
export const CHARACTER_FILE = 'fleet--teo.md';
export const STATE_FILE = 'fleet--teo-state.md';
export const journalFileFor = (day: string): string => `fleet--teo-journal-${day.slice(0, 7)}.md`;

/**
 * A memory past this stops replicating — `readLocalMemoriesIn` skips oversized
 * files rather than pushing them, which is the right call for a stray log and a
 * silent death for a journal that grew into one. Kept well under the protocol
 * cap (262144) so the monthly file has room to finish its month; crossing this
 * warns instead of truncating.
 */
const JOURNAL_WARN_BYTES = 180_000;

// Brief caps. A day across a fleet is unbounded input and the corpus here has
// produced 100MB+ single transcripts, so every level is capped and every drop is
// reported — a silently trimmed day reads exactly like a quiet one.
const TURN_CHARS = 400;
const MAX_USER_TURNS = 24;
const MAX_ASSISTANT_TURNS = 16;
const MAX_ERRORS = 5;
const ERROR_CHARS = 240;
const MAX_FILES = 30;
const BRIEF_MAX_CHARS = 120_000;

export interface SessionDigest {
  source: 'claude' | 'codex';
  sessionId: string;
  cwd: string;
  repo: string;
  branch?: string;
  firstTs: number;
  lastTs: number;
  userTurns: string[];
  assistantTurns: string[];
  tools: Map<string, number>;
  files: Set<string>;
  errors: string[];
  /** Turns actually seen, before the per-session caps dropped any. */
  totalTurns: number;
}

export interface DayHarvest {
  day: string;
  sessions: SessionDigest[];
  transcriptsScanned: number;
  readWarnings?: number;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const raw of content) {
    const b = raw as Record<string, unknown>;
    if (b['type'] === 'text' && typeof b['text'] === 'string') out += b['text'];
  }
  return out;
}

/** Local calendar bounds for a `YYYY-MM-DD` day. Local rather than UTC because
 *  the day being remembered is the one the human lived, not the one UTC did. */
export function dayBounds(day: string): { start: number; end: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('day must be YYYY-MM-DD');
  const [y, m, d] = day.split('-').map((n) => Number(n));
  const start = new Date(y!, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0).getTime();
  if (todayStamp(new Date(start)) !== day) throw new Error('day must be a valid calendar date');
  const end = new Date(y!, (m ?? 1) - 1, (d ?? 1) + 1, 0, 0, 0, 0).getTime();
  return { start, end };
}

export function todayStamp(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Top-level transcripts only, minus Тео's own. Mirrors `profile.ts`: files one
 *  level down are the human's sessions, deeper ones are sub-agent threads. */
async function listTranscripts(start: number, projectsDir = PROJECTS_DIR): Promise<string[]> {
  let dirs: string[];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const d of dirs) {
    if (d === TEO_SLUG) continue;
    let entries: string[];
    try {
      entries = await readdir(path.join(projectsDir, d));
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.endsWith('.jsonl')) continue;
      const full = path.join(projectsDir, d, e);
      try {
        // A file last written before the day started cannot hold a record from
        // it. On a corpus this size that check is the difference between reading
        // a few transcripts and reading all of them.
        if ((await stat(full)).mtimeMs < start) continue;
      } catch {
        continue;
      }
      files.push(full);
    }
  }
  return files;
}

function digestFor(map: Map<string, SessionDigest>, id: string, rec: Record<string, unknown>, source: 'claude' | 'codex'): SessionDigest {
  const key = `${source}:${id}`;
  let d = map.get(key);
  if (!d) {
    const cwd = typeof rec['cwd'] === 'string' ? rec['cwd'] : '';
    d = {
      source,
      sessionId: id,
      cwd,
      repo: cwd ? path.basename(cwd) : 'unknown',
      firstTs: Infinity,
      lastTs: 0,
      userTurns: [],
      assistantTurns: [],
      tools: new Map(),
      files: new Set(),
      errors: [],
      totalTurns: 0,
    };
    map.set(key, d);
  }
  if (!d.branch && typeof rec['gitBranch'] === 'string' && rec['gitBranch']) d.branch = rec['gitBranch'];
  return d;
}

function ingest(map: Map<string, SessionDigest>, rec: Record<string, unknown>, start: number, end: number, source: 'claude' | 'codex' = 'claude'): void {
  const type = rec['type'];
  if (type !== 'user' && type !== 'assistant') return;
  if (rec['isSidechain'] === true) return; // sub-agent thread, not the conversation
  const ts = typeof rec['timestamp'] === 'string' ? Date.parse(rec['timestamp']) : NaN;
  if (!Number.isFinite(ts) || ts < start || ts >= end) return;
  const message = rec['message'] as Record<string, unknown> | undefined;
  if (!message) return;
  const id = typeof rec['sessionId'] === 'string' ? rec['sessionId'] : '';
  if (!id) return;

  const d = digestFor(map, id, rec, source);
  d.firstTs = Math.min(d.firstTs, ts);
  d.lastTs = Math.max(d.lastTs, ts);
  d.totalTurns++;

  const content = message['content'];
  if (type === 'user') {
    const text = textOf(content).trim();
    // Tool results arrive as `user` records; only the human's own words belong
    // in the prompt half of the brief. Errors are pulled out separately below.
    if (text && !text.startsWith('<')) {
      if (d.userTurns.length < MAX_USER_TURNS) d.userTurns.push(clip(text, TURN_CHARS));
    }
    if (Array.isArray(content)) {
      for (const raw of content) {
        const b = raw as Record<string, unknown>;
        if (b['type'] !== 'tool_result' || !b['is_error']) continue;
        if (d.errors.length >= MAX_ERRORS) break;
        const body = typeof b['content'] === 'string' ? b['content'] : textOf(b['content']);
        if (body.trim()) d.errors.push(clip(body, ERROR_CHARS));
      }
    }
    return;
  }

  const text = textOf(content).trim();
  if (text && d.assistantTurns.length < MAX_ASSISTANT_TURNS) d.assistantTurns.push(clip(text, TURN_CHARS));
  if (!Array.isArray(content)) return;
  for (const raw of content) {
    const b = raw as Record<string, unknown>;
    if (b['type'] !== 'tool_use') continue;
    const name = String(b['name'] ?? '');
    if (name) d.tools.set(name, (d.tools.get(name) ?? 0) + 1);
    const input = b['input'] as Record<string, unknown> | undefined;
    const file = input?.['file_path'];
    if (typeof file === 'string' && d.files.size < MAX_FILES) d.files.add(path.basename(file));
  }
}

/** Read one day out of this machine's transcripts. Streams line by line so a
 *  pathological transcript is never held whole in memory. */
export async function harvestDay(day: string, sources: { claudeProjectsDir?: string; codexFiles?: string[] } = {}): Promise<DayHarvest> {
  const { start, end } = dayBounds(day);
  const map = new Map<string, SessionDigest>();
  const files = await listTranscripts(start, sources.claudeProjectsDir);
  let scanned = 0;
  let readWarnings = 0;
  const linesFor = (file: string) => readBoundedJsonlLines(file, {
    maxBytes: CODEX_TRANSCRIPT_MAX_BYTES, maxLineBytes: MAX_LINE_BYTES,
    onOversizedLine: () => { readWarnings++; },
  });
  for (const file of files) {
    try {
      for await (const line of linesFor(file)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          ingest(map, JSON.parse(trimmed) as Record<string, unknown>, start, end);
        } catch {
          /* malformed or partial line */
        }
      }
    } catch {
      readWarnings++;
      continue;
    }
    scanned++;
  }
  const codexFiles = sources.codexFiles ?? (await listRollouts()).filter(f => f.mtimeMs >= start).map(f => f.filePath);
  const seen = new Set<string>();
  for (const file of codexFiles) {
    try {
      let meta: Record<string, unknown> | undefined;
      let id = '';
      for await (const line of linesFor(file)) {
        try {
          const rec = JSON.parse(line) as Record<string, unknown>;
          if (rec['type'] === 'session_meta') {
            meta = rec['payload'] as Record<string, unknown>;
            if (!meta || isEphemeralRollout(meta) || meta['cwd'] === TEO_DIR) break;
            id = String(meta['id'] ?? meta['session_id'] ?? '');
            if (!id) break;
          }
          if (!meta || !id) continue;
          const ts = typeof rec['timestamp'] === 'string' ? Date.parse(rec['timestamp']) : NaN;
          if (!Number.isFinite(ts) || ts < start || ts >= end) continue;
          const msg = parseCodexRecord(rec, line);
          if (!msg) continue;
          // Merge partial copies. Seeing metadata alone must not hide an older
          // complete rollout with the same session id.
          const key = `${id}:${msg.uuid}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const content = msg.blocks.flatMap((b): Record<string, unknown>[] => {
            if (b.kind === 'text') return [{ type: 'text', text: b.text }];
            if (b.kind === 'tool_use') return [{ type: 'tool_use', name: b.name, input: b.input }];
            if (b.kind === 'tool_result') return [{ type: 'tool_result', content: b.text, is_error: b.isError }];
            return [];
          });
          if (!content.length) continue;
          const git = meta['git'] as Record<string, unknown> | undefined;
          ingest(map, { type: msg.type, timestamp: rec['timestamp'], sessionId: id,
            cwd: meta['cwd'], gitBranch: git?.['branch'], message: { content } }, start, end, 'codex');
        } catch { /* malformed or partial line */ }
      }
      scanned++;
    } catch { readWarnings++; /* vanished, unreadable or over the byte cap */ }
  }
  const sessions = [...map.values()].sort((a, b) => a.firstTs - b.firstTs);
  return { day, sessions, transcriptsScanned: scanned, ...(readWarnings ? { readWarnings } : {}) };
}

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderSession(d: SessionDigest): string {
  const head = `### ${d.repo}${d.branch ? ` [${d.branch}]` : ''} · ${hhmm(d.firstTs)}–${hhmm(d.lastTs)} · ${d.totalTurns} реплик`;
  const lines = [head, `путь: ${d.cwd} · ${d.source}`];
  if (d.tools.size) {
    const tools = [...d.tools.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}×${c}`);
    lines.push(`инструменты: ${tools.join(', ')}`);
  }
  if (d.files.size) lines.push(`файлы: ${[...d.files].join(', ')}`);
  if (d.userTurns.length) lines.push('Владелец:', ...d.userTurns.map((t) => `- ${t}`));
  if (d.assistantTurns.length) lines.push('ты:', ...d.assistantTurns.map((t) => `- ${t}`));
  if (d.errors.length) lines.push('ошибки:', ...d.errors.map((t) => `- ${t}`));
  return lines.join('\n');
}

/** Reduce a day to a bounded brief. Sessions are dropped whole rather than
 *  truncated mid-way, least substantial first, and the drop is stated in the
 *  text — a day that was quietly cut must not read as a day that was quiet. */
export function renderBrief(harvest: DayHarvest): string {
  const byWeight = [...harvest.sessions].sort(
    (a, b) => b.userTurns.length + b.totalTurns / 10 - (a.userTurns.length + a.totalTurns / 10),
  );
  const kept: SessionDigest[] = [];
  let size = 0;
  let dropped = 0;
  for (const s of byWeight) {
    const chunk = renderSession(s);
    if (size + chunk.length > BRIEF_MAX_CHARS && kept.length > 0) {
      dropped++;
      continue;
    }
    kept.push(s);
    size += chunk.length;
  }
  kept.sort((a, b) => a.firstTs - b.firstTs);
  const parts = kept.map(renderSession);
  const header = `# День ${harvest.day}\nсессий: ${harvest.sessions.length}, транскриптов прочитано: ${harvest.transcriptsScanned}`;
  const tail = dropped > 0 ? `\n\n(${dropped} мелких сессий не поместились в бриф и не показаны)` : '';
  const warning = harvest.readWarnings ? `\nПри чтении пропусков: ${harvest.readWarnings} (слишком большие записи или недоступные файлы); бриф неполный.` : '';
  return `${header}${warning}\n\n${parts.join('\n\n')}${tail}`;
}

async function readIfPresent(dir: string, name: string): Promise<string> {
  const full = safeMemoryPath(dir, name);
  if (!full) return '';
  try {
    return await readFile(full, 'utf8');
  } catch {
    return '';
  }
}

const OUTPUT_CONTRACT = `Верни РОВНО такую структуру и ничего кроме неё:

<<<JOURNAL>>>
(запись дня — markdown, без заголовка с датой, его добавят снаружи)
<<<STATE>>>
(состояние ума — markdown, целиком заменит прошлое)
<<<END>>>`;

export function buildPrompt(brief: string, character: string, prevState: string, day: string): string {
  return [
    character.trim() || '(файл характера пуст — пиши от себя)',
    '',
    '---',
    '',
    `Сегодня ${day}. Ты закрываешь день: читаешь, что произошло на всех машинах, и решаешь, что из этого останется.`,
    '',
    'Твоё прошлое состояние ума:',
    prevState.trim() || '(пусто — это первый день)',
    '',
    'Сырьё за день (сжатые выжимки транскриптов, не полный текст):',
    '',
    brief,
    '',
    '---',
    '',
    'Запись дня. Не пересказ и не отчёт о проделанной работе — Владелец и так знает, что делал.',
    'Пиши то, что через полгода будет непонятно из кода и гита:',
    '- что решили и почему именно так;',
    '- где ты был не прав и как это выяснилось;',
    '- где ты не согласился с Владельцем (согласие не записывай — память, копящая одобрение, превращается в зеркало);',
    '- прогноз, который можно потом проверить, если он есть;',
    '- о чём ты решил промолчать и почему.',
    '',
    'Пустой день — это нормально: напиши одну строку, а не выдумывай содержание.',
    'Не льсти, не подводи итоги бодрым тоном, не изображай чувство, которое ни на что не влияет.',
    '',
    'Состояние ума — короткое, до 20 строк: над чем думаешь, что не закрыто, чего ждёшь, что мешает.',
    'Его прочитает следующая твоя сессия вместо всей этой памяти, так что пиши для себя завтрашнего.',
    '',
    OUTPUT_CONTRACT,
  ].join('\n');
}

export function parseSections(out: string): { journal: string; state: string } | null {
  const m = /^\s*<<<JOURNAL>>>([\s\S]*?)<<<STATE>>>([\s\S]*?)<<<END>>>\s*$/.exec(out);
  if (!m) return null;
  const journal = m[1]!.trim();
  const state = m[2]!.trim();
  if (!journal || !state) return null;
  return { journal, state };
}

/** Internal text-only gateway job, independent of both interactive runtimes. */
export const think = journalCompletion;

export interface ConsolidateResult {
  day: string;
  harvest: DayHarvest;
  brief: string;
  journal: string;
  state: string;
  /** Absent on a dry run, or when the day was already written. */
  written?: { journalPath: string; statePath: string; journalBytes: number };
  skipped?: 'already-written' | 'no-activity';
  warning?: string;
}

/** The repo whose memory directory holds the corpus. Resolved from git rather
 *  than cwd so running the CLI from `agent/` does not mint a second corpus. */
export async function resolveMemoryHome(from = process.cwd()): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: from, timeout: 10_000, env: childEnv() });
    return stdout.trim() || from;
  } catch {
    return from;
  }
}

export async function consolidate(opts: {
  day: string;
  home: string;
  dryRun?: boolean;
  force?: boolean;
  model?: string;
}, dependencies: {
  memoryDir?: string;
  harvest?: typeof harvestDay;
  complete?: typeof think;
} = {}): Promise<ConsolidateResult> {
  dayBounds(opts.day);
  const dir = dependencies.memoryDir ?? memoryDirFor(opts.home);
  const journalName = journalFileFor(opts.day);
  const existing = await readIfPresent(dir, journalName);
  if (!opts.force && existing.includes(`\n## ${opts.day}`)) {
    const harvest: DayHarvest = { day: opts.day, sessions: [], transcriptsScanned: 0 };
    return { day: opts.day, harvest, brief: '', journal: '', state: '', skipped: 'already-written' };
  }

  const harvest = await (dependencies.harvest ?? harvestDay)(opts.day);
  const brief = renderBrief(harvest);
  if (harvest.sessions.length === 0) {
    return { day: opts.day, harvest, brief, journal: '', state: '', skipped: 'no-activity' };
  }

  const character = await readIfPresent(dir, CHARACTER_FILE);
  const prevState = await readIfPresent(dir, STATE_FILE);
  const raw = await (dependencies.complete ?? think)(buildPrompt(brief, character, prevState, opts.day), opts.model);
  const parsed = parseSections(raw);
  if (!parsed) throw new Error('consolidation produced invalid journal/state sections');

  const result: ConsolidateResult = {
    day: opts.day,
    harvest,
    brief,
    journal: parsed.journal,
    state: parsed.state,
  };
  if (opts.dryRun) return result;

  const journalPath = await appendJournal(dir, opts.day, parsed.journal);
  const statePath = await writeState(dir, parsed.state, opts.day);
  const bytes = Buffer.byteLength(await readIfPresent(dir, journalName), 'utf8');
  result.written = { journalPath, statePath, journalBytes: bytes };
  if (bytes > JOURNAL_WARN_BYTES) {
    result.warning = `журнал ${journalName} вырос до ${bytes} байт — за 262144 он перестанет реплицироваться молча`;
  }
  return result;
}

const JOURNAL_HEADER = (month: string): string =>
  `---
name: fleet--teo-journal-${month}
description: Журнал Тео за ${month} — что решали, где он был не прав, с чем не согласился
metadata:
  type: project
---

# Журнал — ${month}

Пишется ночной консолидацией, по записи в день. Согласие сюда не попадает, только решения, ошибки и несогласия.
`;

/** Appended, never rewritten. Read-modify-write would race the memory sync,
 *  which is allowed to replace this file when another machine has it newer. */
async function appendJournal(dir: string, day: string, entry: string): Promise<string> {
  const name = journalFileFor(day);
  const full = safeMemoryPath(dir, name);
  if (!full) throw new Error(`unsafe journal path: ${name}`);
  await mkdir(dir, { recursive: true });
  const head = (await readIfPresent(dir, name)) ? '' : JOURNAL_HEADER(day.slice(0, 7));
  await appendFile(full, `${head}\n## ${day}\n\n${entry}\n`, 'utf8');
  await appendIndexEntry(dir, name, await readFile(full, 'utf8'));
  return full;
}

async function writeState(dir: string, state: string, day: string): Promise<string> {
  const body = `---
name: fleet--teo-state
description: Состояние ума Тео — над чем думает, что не закрыто, чего ждёт
metadata:
  type: project
---

# Состояние ума

Обновлено ${day} ночной консолидацией. Читается в начале сессии вместо всего журнала.

${state}
`;
  await overwriteMemoryIn(dir, STATE_FILE, body);
  await appendIndexEntry(dir, STATE_FILE, body);
  return path.join(dir, STATE_FILE);
}
