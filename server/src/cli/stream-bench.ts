/**
 * How much main-thread work ONE streamed token costs, with a sidebar the size
 * of a real fleet.
 *
 * Written to settle an argument with a number. A review claimed the transcript
 * re-rendered the whole app tree per frame; it was right, and this is what it
 * cost: the session pane took the entire `central` object, which is a fresh
 * literal on every render, so a token that changed one line re-rendered all 150
 * session rows. Measured 21.09.2026 — 9.36 ms of scripting per token, ~80% of
 * the main thread busy for the length of a turn.
 *
 * The two knobs are the experiment, not configuration:
 *   BENCH_SESSIONS  how many sessions sit in the sidebar (fleet size)
 *   BENCH_TOKENS    how many deltas the answer arrives in (answer length)
 * A cost that rises with the first means the shell is in the streaming path; a
 * cost that rises with the second means the transcript is re-parsing what it
 * already rendered. After the memoization both are flat — 5.8 ms at 10 sessions
 * and 5.7 at 150 — and what is left is the flat per-frame cost of the rest of
 * the tree.
 *
 *   node --import tsx server/src/cli/stream-bench.ts ws://127.0.0.1:4319 <token>
 *
 * Needs a throwaway hub with a FRESH database: fake agents from earlier runs
 * linger in the sidebar and quietly ruin the fleet-size experiment, and
 * enrollment is rate-limited to five an hour. Full recipe in
 * deploy/SMOKE-TESTS.md.
 */
import type { Protocol } from 'puppeteer-core';
import {
  adminLogin,
  enrollFakeAgent,
  fakeSession,
  nextAgentFrame,
  smokeTarget,
  sleep,
  launchBrowser,
  evalJs,
} from './_harness.js';

const SECRET = process.env['CC_REMOTE_SSO_SECRET'] ?? 'smoke-secret';
const SESSIONS = Number(process.env['BENCH_SESSIONS'] ?? 150);
const TOKENS = Number(process.env['BENCH_TOKENS'] ?? 250);

const target = smokeTarget(process.argv);
const admin = await adminLogin(target.http, SECRET);

const sessions = Array.from({ length: SESSIONS }, (_, i) =>
  fakeSession(`/srv/proj-${i % 12}/sub-${i}`, `сессия ${i}`));
const agent = await enrollFakeAgent(target, admin, { name: 'bench', sessions });
const live = sessions[0]!;

const b = await launchBrowser();
const p = await b.newPage();
await p.setViewport({ width: 1440, height: 900 });
const cookie = admin.cookie.split(';')[0]!.split('=');
await b.setCookie({ name: cookie[0]!, value: cookie[1]!, domain: 'localhost', path: '/' });
const cdp = await p.target().createCDPSession();
await cdp.send('Performance.enable');
await p.goto(`${target.http}/w/s/${agent.machineId}/${live.sessionId}`, { waitUntil: 'networkidle2', timeout: 60000 });
await sleep(2500);

const metric = async (name: string) => {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return (metrics.find((m: { name: string }) => m.name === name)?.value ?? 0) as number;
};
const rows = await p.evaluate(`document.querySelectorAll('.srow, .sess-row, [class*="session"]').length`);

// The browser says `open`; the AGENT is asked to `resume`. Only a run the hub
// actually minted gets its stream frames routed to the viewer.
const openFrame = nextAgentFrame(agent.ws, 'resume');
await p.type('.composer textarea', 'привет');
await p.click('button.send-round:not(.stop), button.send-btn.resume');
const opened = await openFrame;
await sleep(600);

await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await cdp.send('Profiler.start');
const script0 = await metric('ScriptDuration'), task0 = await metric('TaskDuration');
const t0 = Date.now();
for (let i = 0; i < TOKENS; i++) {
  agent.ws.send(JSON.stringify({
    type: 'stream', runId: opened.runId, sessionId: opened.sessionId,
    event: { kind: 'assistant', text: `фрагмент ${i} `, delta: true },
  }));
  await sleep(12);
}
await sleep(1200);
const script1 = await metric('ScriptDuration'), task1 = await metric('TaskDuration');
const { profile } = await cdp.send('Profiler.stop');
const self = new Map<string, number>();
const byId = new Map<number, Protocol.Profiler.ProfileNode>();
for (const n of profile.nodes) byId.set(n.id, n);
const counts = new Map<number, number>();
for (const id of profile.samples ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
const totalSamples = (profile.samples ?? []).length || 1;
for (const [id, c] of counts) {
  const n = byId.get(id); if (!n) continue;
  const f = n.callFrame;
  const name = `${f.functionName || '(anonymous)'} ${String(f.url).split('/').pop() ?? ''}`;
  self.set(name, (self.get(name) ?? 0) + c);
}
const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 12)
  .map(([n, c]) => `${String(Math.round((c / totalSamples) * 100)).padStart(3)}%  ${n}`);
console.log('--- где главный поток проводит время ---\n' + top.join('\n') + '\n');

// Proof the frames actually landed: without this the benchmark happily
// measures an idle page and reports a wonderful number.
const chars = await evalJs<number>(p, `(document.querySelector('.log-inner')||{}).innerText?.length||0`);
if (chars < 500) { console.error(`FAIL: transcript holds only ${chars} chars — the stream never arrived`); process.exit(1); }

console.log(JSON.stringify({
  transcript_chars: chars,
  sessions_in_sidebar: SESSIONS,
  rows_rendered: rows,
  tokens: TOKENS,
  wall_ms: Date.now() - t0,
  script_ms: Math.round((script1 - script0) * 1000),
  task_ms: Math.round((task1 - task0) * 1000),
  script_ms_per_token: +(((script1 - script0) * 1000) / TOKENS).toFixed(2),
}, null, 2));
await b.close();
process.exit(0);
