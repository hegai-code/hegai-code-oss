/**
 * Which machines the hub sees, and what each one can actually RUN.
 *
 * `snapshot.ts` cannot answer this against production: it dials `/ui` with the
 * fleet token, and that is refused there by design (`CC_REMOTE_FLEET_UI` is
 * off, with a test asserting it). This signs in the same way `term-run.ts`
 * does — the loopback SSO handshake, as a real user — so it works against the
 * live hub.
 *
 * `skills` is what makes a session CATEGORY offerable on a box: the web gates
 * its chips on `machine.skills` (StartScreen.tsx), the agent reads that list
 * off disk ONCE at start, and the register frame carries it. So a machine that
 * has the new bundle but has not restarted reports the old list, and the chip
 * stays hidden — which is the honest answer, not a bug.
 *
 *   CC_REMOTE_SSO_SECRET=<hub's> CC_SMOKE_ADMIN_ID=<id> CC_SMOKE_ADMIN_EMAIL=<email> \
 *     tsx server/src/cli/fleet-skills.ts wss://code.acme.test
 */
import { connectUiAs, nextBrowserFrame, sendUi, smokeTarget, ssoLogin } from './_harness.js';
const target = smokeTarget(process.argv);
const s = await ssoLogin(target.http, process.env['CC_REMOTE_SSO_SECRET']!, {
  userId: process.env['CC_SMOKE_ADMIN_ID']!, email: process.env['CC_SMOKE_ADMIN_EMAIL']!,
} as never);
const ws = await connectUiAs(target.ws, s);
const snap = nextBrowserFrame(ws, 'snapshot');
sendUi(ws, { type: 'hello', protocol: 1, client: 'web' } as never);
const got = await snap as { machines: { machine: { name: string; skills?: string[]; agentVersion?: string }; online?: boolean; lastSeen?: number; sessions?: unknown[] }[] };
const now = Date.now();
for (const m of got.machines) {
  const sk = m.machine.skills;
  const seen = m.lastSeen ? `${Math.round((now - m.lastSeen) / 60000)} мин назад` : '—';
  console.log(`${m.machine.name.padEnd(18)} ${((m.machine as { machineId?: string }).machineId ?? '?').slice(0, 12).padEnd(13)} ${m.online ? 'онлайн ' : 'ОФЛАЙН '} ${seen.padEnd(15)} rambling: ${sk ? (sk.includes('rambling') ? 'ДА' : 'нет') : '—'}`);
}
process.exit(0);
