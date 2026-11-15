/**
 * Wire test for the builder-profile path: a fake agent registers, sends a
 * `builder_profile`, and we assert the hub (1) fans a `builder_profile` delta to
 * connected UIs and (2) attaches the profile to the snapshot a freshly-connected
 * UI receives. Both are decoded through `decodeCentralToBrowser`, so this also
 * proves the hub's `json!()` output satisfies the zod browser schema.
 *
 * Usage: tsx server/src/cli/profile-smoke.ts [ws://127.0.0.1:4319] [dev-token]
 */
import { WebSocket } from 'ws';
import { BuilderProfile, decodeCentralToBrowser } from '@cc-remote/shared';
import { connectUi, fail } from './_harness.js';

const base = process.argv[2] ?? process.env['CC_SMOKE_URL'] ?? 'ws://127.0.0.1:4319';
const token = process.argv[3] ?? process.env['CC_REMOTE_TOKEN'] ?? 'dev-token';
const MID = 'profile-smoke-machine';
const NAME = 'profile-smoke';

// A synthetic but schema-valid profile. Parsing it here also fails fast if the
// shared schema and this shape ever drift.
const profile = BuilderProfile.parse({
  machine: NAME,
  machineId: MID,
  generatedAt: Date.now(),
  transcriptsScanned: 42,
  sessions: 12,
  messages: { user: 300, assistant: 4200 },
  span: { firstTs: Date.now() - 30 * 86_400_000, lastTs: Date.now(), activeDays: 20, longestStreakDays: 6 },
  cadence: {
    hourHistogram: Array.from({ length: 24 }, (_, h) => (h >= 22 || h < 5 ? 40 : 10)),
    weekdayHistogram: [5, 30, 28, 26, 24, 20, 8],
    nightOwlShare: 0.42,
    avgSessionMessages: 375,
    avgSessionMinutes: 90,
  },
  tools: {
    counts: { Bash: 400, Edit: 200, Read: 150, Write: 80 },
    buildVsExplore: 0.62,
    testRunShare: 0.03,
    gitOpShare: 0.01,
    toolCallsPerSession: 70,
  },
  steering: { avgPromptChars: 320, shortPromptShare: 0.2, longPromptShare: 0.15, followUpsPerSession: 25 },
  engineering: {
    filesTouched: 500,
    topLanguages: [{ name: 'TypeScript', count: 300 }, { name: 'Rust', count: 60 }],
    repos: 8,
    branches: 4,
  },
  planning: { planModeShare: 0.3, todoShare: 0.45, topSkills: [{ name: 'code-review', count: 5 }] },
  models: { histogram: { 'claude-opus-5-5': 3800, 'claude-fable-5-1': 400 }, avgModelsPerSession: 1.4 },
  scores: { steering: 7.4, execution: 8.5, engineering: 3.1, planning: 10, product: 6 },
  archetype: { primary: 'Night Owl', badges: ['Marathoner', 'Polyglot'] },
});

let gotDelta = false;
let agent: WebSocket | undefined;
let ui2: WebSocket | undefined;

const timer = setTimeout(() => fail('timed out waiting for delta + snapshot'), 10_000);

function done(): void {
  clearTimeout(timer);
  console.log('\nPROFILE WIRE OK ✓  (delta + snapshot both carry the profile)');
  agent?.close();
  ui2?.close();
  process.exit(0);
}

const { ws: ui1 } = connectUi(process.argv);

ui1.on('message', (d: Buffer) => {
  const msg = decodeCentralToBrowser(d.toString());
  if (msg.type === 'builder_profile' && msg.machineId === MID && !gotDelta) {
    gotDelta = true;
    console.log(`delta received: archetype="${msg.profile.archetype.primary}"`);
    // A freshly-connected UI should get the profile on its initial snapshot.
    ui2 = new WebSocket(`${base}/ui?token=${encodeURIComponent(token)}`);
    ui2.on('message', (d2: Buffer) => {
      const m2 = decodeCentralToBrowser(d2.toString());
      if (m2.type === 'snapshot') {
        const mach = m2.machines.find((x) => x.machine.machineId === MID);
        if (mach?.profile) {
          console.log(`snapshot carries profile: sessions=${mach.profile.sessions}`);
          done();
        }
      }
    });
  }
});

ui1.on('open', () => {
  agent = new WebSocket(`${base}/agent?token=${encodeURIComponent(token)}`);
  agent.on('open', () => {
    agent!.send(
      JSON.stringify({ type: 'register', protocol: 1, machine: { machineId: MID, name: NAME, os: 'linux', agentVersion: '0.0.0' } }),
    );
    setTimeout(() => agent!.send(JSON.stringify({ type: 'builder_profile', profile })), 300);
  });
  agent.on('error', (e) => fail(`agent ws error: ${(e as Error).message}`));
});

ui1.on('error', (e) => fail(`ui ws error: ${(e as Error).message}`));
