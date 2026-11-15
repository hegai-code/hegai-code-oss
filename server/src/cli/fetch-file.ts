/**
 * Pull one file off a fleet machine, through the hub, onto this disk.
 *
 * Why this exists: screenshots and logs are produced BY the machine doing the
 * work, and looking at them is the only way to check a UI claim. Everything
 * else at hand carries them badly — a terminal is a PTY, and a PTY wraps,
 * echoes and re-flows, which is fatal to base64. The hub already has a clean
 * binary path (`fs.download`, windowed), and this is the smallest client for it.
 *
 *   npx tsx server/src/cli/fetch-file.ts --machine <name> \
 *     --cwd /tmp/shots --path run/01.png --out /tmp/local/01.png
 *   … --method fs.peek --cwd /srv/x --path /tmp/agents-0/-srv-x/<id>/scratchpad/a.png
 *
 * `--cwd` is the root the agent resolves against and `--path` is relative to
 * it; that split is the agent's roots guard, not decoration, so a path that
 * climbs out of `cwd` is refused on the far side rather than here.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  adminLogin,
  connectUiAs,
  fail,
  nextBrowserFrame,
  rpc,
  smokeTarget,
} from './_harness.js';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const machineWanted = flag('--machine') ?? fail('--machine <name|id> is required');
const cwd = flag('--cwd') ?? fail('--cwd <dir on that machine> is required');
const remotePath = flag('--path') ?? fail('--path <relative to --cwd> is required');
const out = flag('--out') ?? fail('--out <local path> is required');
/** `fs.peek` reads what the chat preview reads (images/.md, also the session
 *  scratchpad by absolute path); the default is the file manager's download. */
const method = flag('--method') ?? 'fs.download';
if (method !== 'fs.download' && method !== 'fs.peek') fail('--method is fs.download or fs.peek');

const target = smokeTarget([process.argv[0]!, process.argv[1]!]);

interface DownloadChunk {
  path: string;
  offset: number;
  data: string;
  bytes: number;
  size: number;
  eof: boolean;
}

const sso = await adminLogin(target.http, target.ssoSecret!);
const ui = await connectUiAs(target.ws, sso);
const snap = await nextBrowserFrame(ui, 'snapshot', () => true, 60_000);

// A snapshot entry wraps the machine rather than being it: `{ machine, online }`.
// Reading `m.name` straight off the entry yields undefined for every machine and
// an error that lists commas — which is what the first version of this did.
interface SnapMachine { machine: { machineId: string; name: string }; online: boolean }
const machines = (snap as { machines?: SnapMachine[] }).machines ?? [];
const found = machines.find(
  (m) => m.machine.machineId === machineWanted || m.machine.name === machineWanted,
);
if (!found) {
  fail(`no machine «${machineWanted}»; have: ${machines.map((m) => m.machine.name).join(', ')}`);
}
if (!found.online) fail(`${found.machine.name} is offline right now`);

const parts: Buffer[] = [];
let offset = 0;
// Windowed on purpose: the hub caps a single chunk, so a big file arrives as a
// sequence. Trust `eof` rather than a size comparison — a file being written
// while we read it would otherwise loop forever.
for (;;) {
  const answer = await rpc(ui, found.machine.machineId, method, {
    cwd,
    path: remotePath,
    offset,
  });
  if (!answer.ok) fail(`${method}: ${answer.error ?? 'unknown error'}`);
  const chunk = answer.result as DownloadChunk;
  parts.push(Buffer.from(chunk.data, 'base64'));
  offset += chunk.bytes;
  if (chunk.eof) break;
  if (chunk.bytes === 0) fail(`download stalled at ${offset} bytes`);
}

const body = Buffer.concat(parts);
mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
writeFileSync(out, body);
console.log(`[fetch-file] ${found.machine.name}:${cwd}/${remotePath} -> ${out} (${body.length} bytes)`);
ui.close();
process.exit(0);
