/**
 * The suggestion strip, judged against what people actually did next.
 *
 * Takes real turn endings from local Claude transcripts and asks the gateway,
 * with the hub's own prompt (read out of `server-rs/src/hub/enrich.rs`) and
 * the web's own digest (`buildTurnDigest`), what it would put under each. Two
 * kinds of endings, labelled by the transcript itself rather than by opinion:
 *
 * - INTERMEDIATE: the next thing in the file is a `<task-notification>` — the
 *   CLI woke ITSELF on a background task, so the stop was mid-work and any
 *   button there was noise. The score is how often the strip stays empty.
 * - HANDOFF: the next thing is the person typing. The score is whether a strip
 *   appears and — read by eye, it is printed alongside — whether any chip is
 *   close to what they really sent.
 *
 *   LLM_ENRICH_KEY=sk-bf-… EVAL_MODELS=pool-a/gpt-5.6-luna,pool-a/gpt-6-astra \
 *   EVAL_REASONING=medium node --import tsx web/scripts/enrich-eval.ts [dir] [cases]
 *
 * `dir` defaults to this project's transcripts under ~/.claude/projects. The
 * key is the hub's service key (`hegai:service-enrich`) or any key allowed on
 * the pool; `LLM_ENRICH_URL` defaults to the public gateway.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HistoryMessage } from '@cc-remote/shared';
import { parseRecord, stripHarnessNoise } from '../../agent/src/history.js';
import { buildTurnDigest } from '../src/render/enrich.js';

const URL_BASE = (process.env['LLM_ENRICH_URL'] ?? 'https://llm.acme.test/v1').replace(/\/$/, '');
const KEY = process.env['LLM_ENRICH_KEY'];
const MODELS = (process.env['EVAL_MODELS'] ?? 'pool-a/gpt-5.6-luna').split(',').map((s) => s.trim()).filter(Boolean);
const REASONING = process.env['EVAL_REASONING'];
const dir = process.argv[2] ?? path.join(os.homedir(), '.claude/projects/-srv-remotehegai');
const CASES = Number(process.argv[3] ?? 30);

// Split mode, for when the transcripts and the key live on different boxes:
// EVAL_DUMP=cases.json builds the cases here and writes them out (no key
// needed); EVAL_CASES=cases.json runs them where the key is.
const DUMP = process.env['EVAL_DUMP'];
const FROM = process.env['EVAL_CASES'];
if (!KEY && !DUMP) {
  console.error('LLM_ENRICH_KEY is required');
  process.exit(2);
}

const rs = readFileSync(new URL('../../server-rs/src/hub/enrich.rs', import.meta.url), 'utf8');
const SYSTEM_PROMPT = rs.match(/const SYSTEM_PROMPT: &str = r#"([\s\S]*?)"#;/)?.[1];
if (!SYSTEM_PROMPT) throw new Error('SYSTEM_PROMPT not found in enrich.rs');

type Case = { label: 'intermediate' | 'handoff'; history: HistoryMessage[]; text: string; next?: string; file: string; digest?: string };

const textOf = (m: HistoryMessage) =>
  m.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('\n');

/**
 * Every turn ending in one transcript, labelled by what the file says came
 * next. The raw records are walked (not the parsed history) because the one
 * field that says «the CLI woke itself» — `origin.kind` — is not in it.
 */
type Entry = { msg: HistoryMessage } | { wake: true };

async function readEntries(file: string): Promise<Entry[]> {
  const out: Entry[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    // After a turn has ended, the CLI wakes itself with a USER record whose
    // `origin.kind` is `task-notification` — that is the label. (Mid-turn,
    // the same notification is folded in as an attachment instead; those
    // follow a tool result, never a closing message, and change nothing.)
    const origin = rec['origin'] as { kind?: string } | undefined;
    if (origin?.kind === 'task-notification') {
      out.push({ wake: true });
      continue;
    }
    const msg = parseRecord(rec);
    if (msg) out.push({ msg });
  }
  return out;
}

function endings(entries: Entry[], file: string): Case[] {
  const out: Case[] = [];
  const history: HistoryMessage[] = [];
  for (let i = 0; i < entries.length - 1; i++) {
    const e = entries[i]!;
    if (!('msg' in e)) continue;
    const m = e.msg;
    history.push(m);
    // A turn ends on an assistant message that calls nothing more.
    if (m.type !== 'assistant' || m.blocks.some((b) => b.kind === 'tool_use')) continue;
    const text = stripHarnessNoise(textOf(m)).trim();
    if (!text) continue;
    const n = entries[i + 1]!;
    const before = history.slice(0, -1);
    if ('wake' in n) {
      out.push({ label: 'intermediate', history: before, text, file });
    } else if (n.msg.type === 'user') {
      const human = stripHarnessNoise(textOf(n.msg)).trim();
      if (human) out.push({ label: 'handoff', history: before, text, next: human, file });
    }
  }
  return out;
}

async function ask(model: string, c: Case) {
  const digest = c.digest ?? buildTurnDigest(c.history, []);
  const tail = c.text.slice(-6000);
  const turn = digest
    ? `${digest}\n\nFINAL ASSISTANT MESSAGE (the agent stopped here):\n${tail}`
    : `FINAL ASSISTANT MESSAGE (the agent stopped here):\n${tail}`;
  const user = turn;
  const body: Record<string, unknown> = {
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: user },
    ],
  };
  if (REASONING) Object.assign(body, { reasoning_effort: REASONING, max_completion_tokens: 6000 });
  else Object.assign(body, { temperature: 0, max_tokens: 1200 });
  const t0 = Date.now();
  const res = await fetch(`${URL_BASE}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch((e: Error) => e);
  if (res instanceof Error) return { ms: Date.now() - t0, error: res.message };
  const ms = Date.now() - t0;
  if (!res.ok) return { ms, error: `HTTP ${res.status}` };
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = (j.choices?.[0]?.message?.content ?? '').replace(/^```(?:json)?|```$/g, '').trim();
  try {
    const v = JSON.parse(content) as { handoff?: string; quickReplies?: { label: string; kind?: string }[] };
    const chips = v.handoff === 'intermediate' ? [] : (v.quickReplies ?? []);
    return { ms, handoff: v.handoff, chips: chips.map((q) => `${q.kind ?? '?'}:${q.label}`) };
  } catch {
    return { ms, error: 'not JSON' };
  }
}

let cases: Case[];
if (FROM) {
  cases = JSON.parse(readFileSync(FROM, 'utf8')) as Case[];
} else {
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.jsonl'))
  .map((f) => path.join(dir, f))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  .slice(0, 80);

const pool: Case[] = [];
for (const f of files) {
  pool.push(...endings(await readEntries(f), f));
}
// Balanced and spread: newest first within each label, a few per file at most.
const pick = (label: Case['label'], n: number) => {
  const perFile = new Map<string, number>();
  return pool
    .filter((c) => c.label === label)
    .reverse()
    .filter((c) => {
      const k = perFile.get(c.file) ?? 0;
      perFile.set(c.file, k + 1);
      return k < 3;
    })
    .slice(0, n);
};
cases = [...pick('intermediate', Math.floor(CASES / 2)), ...pick('handoff', Math.ceil(CASES / 2))];
console.log(`${pool.filter((c) => c.label === 'intermediate').length} intermediate / ${pool.filter((c) => c.label === 'handoff').length} handoff; ${pool.length} endings in ${files.length} transcripts → ${cases.length} cases\n`);
}
if (DUMP) {
  writeFileSync(
    DUMP,
    JSON.stringify(cases.map((c) => ({ ...c, history: [], file: path.basename(c.file), digest: buildTurnDigest(c.history, []) ?? '' }))),
  );
  console.log(`wrote ${cases.length} cases to ${DUMP}`);
  process.exit(0);
}

for (const model of MODELS) {
  const lat: number[] = [];
  let quietOnIntermediate = 0, intermediates = 0, stripOnHandoff = 0, handoffs = 0, errors = 0;
  console.log(`=== ${model}${REASONING ? ` (reasoning ${REASONING})` : ''} ===`);
  for (const c of cases) {
    const r = await ask(model, c);
    lat.push(r.ms);
    if ('error' in r) {
      errors++;
      console.log(`  [${c.label}] ERROR ${r.error}`);
      continue;
    }
    if (c.label === 'intermediate') {
      intermediates++;
      if (!r.chips.length) quietOnIntermediate++;
    } else {
      handoffs++;
      if (r.chips.length) stripOnHandoff++;
    }
    console.log(`  [${c.label}] ${r.handoff} ${r.ms}ms :: ${c.text.replace(/\s+/g, ' ').slice(-140)}`);
    for (const chip of r.chips) console.log(`      ▸ ${chip}`);
    if (c.next) console.log(`      ↳ really sent: ${c.next.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  lat.sort((a, b) => a - b);
  const q = (p: number) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] ?? 0;
  console.log(
    `\n  quiet on intermediate: ${quietOnIntermediate}/${intermediates} · strip on handoff: ${stripOnHandoff}/${handoffs}` +
      ` · errors ${errors} · p50 ${q(0.5)}ms p90 ${q(0.9)}ms\n`,
  );
}
