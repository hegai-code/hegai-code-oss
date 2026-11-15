/**
 * Print (and optionally save) this machine's local builder profile — a
 * "how you build with AI" report reduced from ~/.claude transcripts. 100% local:
 * nothing leaves the machine. This is the same computeProfile() the agent daemon
 * pushes to the hub, exposed as a standalone command.
 *
 * Usage: npm run profile --workspace agent [-- --json --out <path> --name <machine>]
 */
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { computeProfile } from '../profile.js';

const { values } = parseArgs({
  options: {
    json: { type: 'boolean', default: false }, // also write the full JSON
    out: { type: 'string' }, // where to write it (default profile.json)
    name: { type: 'string' }, // override machine display name
  },
});

const cfg = loadConfig();
const machine = values.name ?? cfg.name;

console.log(`Scanning ~/.claude transcripts for "${machine}" (local only, no network)…`);
const t0 = Date.now();
const p = await computeProfile({ machine, machineId: cfg.machineId });
const secs = ((Date.now() - t0) / 1000).toFixed(1);

const bar = (v: number, max = 10, w = 20): string => {
  const n = Math.round((Math.max(0, Math.min(max, v)) / max) * w);
  return '█'.repeat(n) + '·'.repeat(w - n);
};
const pct = (v: number): string => `${Math.round(v * 100)}%`;
const day = (ts: number): string => (ts ? new Date(ts).toISOString().slice(0, 10) : '—');

console.log(`\n  ═══ Builder Profile · ${machine} ═══\n`);
console.log(`  Archetype:  ${p.archetype.primary}${p.archetype.badges.length ? `  (+ ${p.archetype.badges.join(', ')})` : ''}`);
console.log(`  Scanned:    ${p.transcriptsScanned} transcripts · ${p.sessions} sessions · ${secs}s`);
console.log(`  Span:       ${day(p.span.firstTs)} → ${day(p.span.lastTs)} · ${p.span.activeDays} active days · longest streak ${p.span.longestStreakDays}d`);
console.log(`  Messages:   ${p.messages.user} prompts · ${p.messages.assistant} assistant msgs\n`);

console.log('  Dimension scores (0–10)');
for (const [k, v] of Object.entries(p.scores)) {
  console.log(`    ${k.padEnd(12)} ${bar(v)} ${v}`);
}

console.log('\n  Cadence');
console.log(`    night-owl share   ${pct(p.cadence.nightOwlShare)}`);
console.log(`    avg session       ${p.cadence.avgSessionMessages} msgs · ${p.cadence.avgSessionMinutes} min`);

console.log('\n  Tools');
console.log(`    build vs explore  ${pct(p.tools.buildVsExplore)} building`);
console.log(`    test-run share    ${pct(p.tools.testRunShare)} of Bash · git ${pct(p.tools.gitOpShare)}`);
console.log(`    calls/session     ${p.tools.toolCallsPerSession}`);
const tops = Object.entries(p.tools.counts).slice(0, 6).map(([n, c]) => `${n} ${c}`).join(' · ');
console.log(`    top               ${tops}`);

console.log('\n  Engineering');
console.log(`    files touched     ${p.engineering.filesTouched} · repos ${p.engineering.repos} · branches ${p.engineering.branches}`);
console.log(`    languages         ${p.engineering.topLanguages.map((l) => `${l.name} ${l.count}`).join(' · ') || '—'}`);

console.log('\n  Planning');
console.log(`    plan-mode share   ${pct(p.planning.planModeShare)} · TodoWrite ${pct(p.planning.todoShare)}`);
console.log(`    top skills        ${p.planning.topSkills.map((s) => `${s.name} ${s.count}`).join(' · ') || '—'}`);

console.log('\n  Models');
console.log(`    ${Object.entries(p.models.histogram).map(([m, c]) => `${m} ${c}`).join(' · ') || '—'}`);
console.log(`    avg models/session ${p.models.avgModelsPerSession}\n`);

if (values.json || values.out) {
  const out = values.out || 'profile.json';
  await writeFile(out, JSON.stringify(p, null, 2), 'utf8');
  console.log(`  Wrote ${out}\n`);
}
