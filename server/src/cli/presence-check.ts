/**
 * Watches snapshots for ~22s and reports whether a machine stays continuously
 * present (online) — used to confirm the reconnect grace period hides agent flap.
 * Usage: tsx server/src/cli/presence-check.ts ws://127.0.0.1:4319 dev-token [nameFilter]
 */
import { decodeCentralToBrowser } from '@cc-remote/shared';
import { connectUi, machineFilterArg } from './_harness.js';

const { ws } = connectUi(process.argv);
const filter = machineFilterArg(process.argv, 'mac-mini').toLowerCase();

let snaps = 0;
let online = 0;
let minSessions = Infinity;
let offlineStreak = 0;
let maxOfflineStreak = 0;

ws.on('message', (data: Buffer) => {
  const msg = decodeCentralToBrowser(data.toString());
  if (msg.type !== 'snapshot') return;
  snaps++;
  const m = msg.machines.find(
    (x) => x.online && x.machine.name.toLowerCase().includes(filter),
  );
  if (m) {
    online++;
    offlineStreak = 0;
    minSessions = Math.min(minSessions, m.sessions.length);
  } else {
    offlineStreak++;
    maxOfflineStreak = Math.max(maxOfflineStreak, offlineStreak);
  }
});

ws.on('open', () => console.log(`[presence] watching "${filter}" for 22s…`));
setTimeout(() => {
  console.log(`\nsnapshots seen: ${snaps}`);
  console.log(`${filter} online in: ${online}/${snaps} snapshots`);
  console.log(`min sessions while online: ${minSessions === Infinity ? 'n/a' : minSessions}`);
  console.log(`longest offline streak: ${maxOfflineStreak} snapshots`);
  const ok = snaps > 0 && online === snaps;
  console.log(ok ? '\nONLINE STABLE ✓ (grace period working)' : '\nOFFLINE/FLICKERING — machine was not online in every snapshot');
  process.exit(ok ? 0 : 1);
}, 22000);

ws.on('error', (e) => {
  console.log('ws error', e.message);
  process.exit(1);
});
