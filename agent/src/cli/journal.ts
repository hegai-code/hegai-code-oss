/**
 * Run one night's consolidation by hand — read a day out of this machine's
 * transcripts, write the journal entry and the state of mind.
 *
 * Transcript text is reduced on-box and the bounded brief is sent to the
 * Hegai gateway (LLM_JOURNAL_KEY required); no agent session is launched. `--dry-run` prints what it would
 * write and touches nothing, which is how this should be looked at first.
 *
 * Usage: npm run journal --workspace agent -- [--day 2026-08-23] [--dry-run]
 *                                             [--brief-only] [--force] [--model <id>]
 */
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { consolidate, harvestDay, renderBrief, resolveMemoryHome, todayStamp } from '../journal.js';

const { values } = parseArgs({
  options: {
    day: { type: 'string' }, // YYYY-MM-DD, default today (local)
    'dry-run': { type: 'boolean', default: false },
    'brief-only': { type: 'boolean', default: false }, // harvest only, no model call
    force: { type: 'boolean', default: false }, // rewrite a day already journalled
    model: { type: 'string' },
    home: { type: 'string' }, // repo whose memory dir holds the corpus
    out: { type: 'string' }, // also dump the brief here
  },
});

const day = values.day ?? todayStamp();
const home = values.home ?? (await resolveMemoryHome());

if (values['brief-only']) {
  const harvest = await harvestDay(day);
  const brief = renderBrief(harvest);
  console.log(brief);
  if (values.out) await writeFile(values.out, brief, 'utf8');
  console.log(`\n— ${harvest.sessions.length} сессий, ${harvest.transcriptsScanned} транскриптов, ${brief.length} символов брифа`);
  process.exit(0);
}

console.log(`Консолидация за ${day} · корпус: ${home}${values['dry-run'] ? ' · СУХОЙ ПРОГОН' : ''}`);
const t0 = Date.now();
const res = await consolidate({
  day,
  home,
  dryRun: values['dry-run'],
  force: values.force,
  ...(values.model ? { model: values.model } : {}),
});
const secs = ((Date.now() - t0) / 1000).toFixed(1);

if (res.skipped === 'already-written') {
  console.log(`День ${day} уже записан. --force чтобы дописать ещё раз.`);
  process.exit(0);
}
if (res.skipped === 'no-activity') {
  console.log(`За ${day} на этой машине нет сессий — писать нечего.`);
  process.exit(0);
}

console.log(
  `Прочитано: ${res.harvest.transcriptsScanned} транскриптов · ${res.harvest.sessions.length} сессий · бриф ${res.brief.length} символов · ${secs}s\n`,
);
console.log('═══ ЗАПИСЬ ДНЯ ═══\n');
console.log(res.journal);
console.log('\n═══ СОСТОЯНИЕ УМА ═══\n');
console.log(res.state);

if (values.out) await writeFile(values.out, res.brief, 'utf8');

if (res.written) {
  console.log(`\nЗаписано:\n  ${res.written.journalPath}\n  ${res.written.statePath}`);
  if (res.warning) console.log(`\n⚠ ${res.warning}`);
} else {
  console.log('\n(сухой прогон — на диск ничего не легло)');
}
