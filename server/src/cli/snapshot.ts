/**
 * Print the current cross-machine snapshot (machines + session counts).
 * Usage: tsx server/src/cli/snapshot.ts [ws://127.0.0.1:4319] [token]
 */
import { decodeCentralToBrowser } from '@cc-remote/shared';
import { connectUi } from './_harness.js';

const { ws } = connectUi(process.argv);

ws.on('message', (d: Buffer) => {
  const m = decodeCentralToBrowser(d.toString());
  if (m.type !== 'snapshot') return;
  const online = m.machines.filter((machine) => machine.online).length;
  console.log(`Known machines: ${m.machines.length} (${online} online)\n`);
  let total = 0;
  for (const mc of m.machines) {
    const live = mc.sessions.filter((s) => s.livePid).length;
    total += mc.sessions.length;
    const recent = mc.sessions
      .slice(0, 2)
      .map((s) => s.title.replace(/\s+/g, ' ').slice(0, 40))
      .join(' | ');
    console.log(
      `  ${mc.machine.name.padEnd(18)} [${mc.machine.os.padEnd(7)}] online=${mc.online} version=${mc.machine.agentVersion.padEnd(7)} sessions=${String(mc.sessions.length).padStart(4)} live=${live}`,
    );
    if (recent) console.log(`       e.g. ${recent}`);
  }
  console.log(`\nTotal sessions across all machines: ${total}`);
  ws.close();
  process.exit(0);
});

ws.on('error', (e) => {
  console.error('ws error', (e as Error).message);
  process.exit(1);
});
setTimeout(() => {
  console.error('timeout (no snapshot)');
  process.exit(1);
}, 12_000).unref();
