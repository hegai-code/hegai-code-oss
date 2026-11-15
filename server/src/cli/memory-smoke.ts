/**
 * Wire test for memory replication. A fake agent registers, pushes a memory,
 * fetches it back, then a SECOND agent connection asserts the memory is in the
 * catalog it receives on register.
 *
 * The second connection is the point of the test. Memory is project-scoped and
 * keyed on a git remote, so the hub cannot know which machines hold a checkout
 * and must send project rows to all of them. An earlier version of the catalog
 * query filtered them out, which left every agent pushing forever and never
 * receiving — a gap that unit tests on either side could not see, because each
 * side was individually correct.
 *
 * Every hub->agent message is decoded through `decodeCentralToAgent`, so this
 * also proves the hub's `json!()` output satisfies the shared zod schema.
 *
 * Usage: tsx server/src/cli/memory-smoke.ts [ws://127.0.0.1:4319] [dev-token]
 */
import { createHash, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { decodeCentralToAgent } from '@cc-remote/shared';
import { fail } from './_harness.js';

const base = process.argv[2] ?? process.env['CC_SMOKE_URL'] ?? 'ws://127.0.0.1:4319';
const token = process.argv[3] ?? process.env['CC_REMOTE_TOKEN'] ?? 'dev-token';

const MID = 'memory-smoke-machine';
const NAME = 'memory-smoke';
const PROJECT = 'github.com/smoke/repo';
// Unique per run so a re-run never passes on the previous run's row.
const MEMORY_PATH = `smoke-${randomUUID().slice(0, 8)}.md`;
const CONTENT = `# smoke\nwritten at ${new Date().toISOString()}\n`;
const SHA = createHash('sha256').update(CONTENT, 'utf8').digest('hex');

const timer = setTimeout(() => fail('timed out waiting for the memory round trip'), 15_000);

const open = (): WebSocket => new WebSocket(`${base}/agent?token=${encodeURIComponent(token)}`);
const register = (ws: WebSocket): void => {
  ws.send(
    JSON.stringify({
      type: 'register',
      protocol: 1,
      machine: { machineId: MID, name: NAME, os: 'linux', agentVersion: '0.0.0' },
    }),
  );
};

let first: WebSocket | undefined;
let second: WebSocket | undefined;

function finish(): void {
  clearTimeout(timer);
  console.log('\nMEMORY WIRE OK ✓  (catalog on register + push + fetch + durable across reconnect)');
  first?.close();
  second?.close();
  process.exit(0);
}

/** Second connection: the catalog it gets on register must carry the memory. */
function verifyCatalogOnReconnect(): void {
  second = open();
  second.on('open', () => register(second!));
  second.on('message', (raw: Buffer) => {
    const msg = decodeCentralToAgent(raw.toString());
    if (msg.type !== 'memory_catalog') return;
    const entry = msg.memories.find((m) => m.path === MEMORY_PATH);
    if (!entry) {
      fail(
        `catalog on reconnect is missing ${MEMORY_PATH} — a project-scoped memory is not reaching machines (saw ${msg.memories.length} entries)`,
      );
    }
    if (entry!.sha256 !== SHA) fail(`catalog sha mismatch: ${entry!.sha256} != ${SHA}`);
    if (entry!.scopeKey !== PROJECT) fail(`catalog scopeKey mismatch: ${entry!.scopeKey}`);
    console.log(`catalog on reconnect carries ${MEMORY_PATH} (rev ${entry!.revision}, sha ok)`);
    finish();
  });
  second.on('error', (e) => fail(`second agent ws error: ${(e as Error).message}`));
}

first = open();
let sawCatalog = false;

first.on('open', () => register(first!));

first.on('message', (raw: Buffer) => {
  const msg = decodeCentralToAgent(raw.toString());

  if (msg.type === 'memory_catalog' && !sawCatalog) {
    // Arrives after register even when empty — that is the trigger the agent
    // reconciles on, so its absence is a failure regardless of contents.
    sawCatalog = true;
    console.log(`catalog on register: ${msg.memories.length} entries`);
    first!.send(
      JSON.stringify({
        type: 'memory_push',
        scope: 'project',
        scopeKey: PROJECT,
        path: MEMORY_PATH,
        content: CONTENT,
      }),
    );
    setTimeout(() => {
      first!.send(
        JSON.stringify({
          type: 'memory_fetch',
          want: [{ scope: 'project', scopeKey: PROJECT, path: MEMORY_PATH }],
        }),
      );
    }, 300);
    return;
  }

  if (msg.type === 'memory_deliver') {
    const got = msg.memories.find((m) => m.path === MEMORY_PATH);
    if (!got) fail(`memory_deliver did not include ${MEMORY_PATH}`);
    if (got!.content !== CONTENT) fail('memory_deliver returned different content than was pushed');
    if (got!.sha256 !== SHA) fail(`memory_deliver sha mismatch: ${got!.sha256} != ${SHA}`);
    console.log(`fetch round trip ok (${got!.content.length} bytes, sha matches)`);
    verifyCatalogOnReconnect();
  }
});

first.on('error', (e) => fail(`agent ws error: ${(e as Error).message}`));

if (!sawCatalog) {
  setTimeout(() => {
    if (!sawCatalog) fail('hub sent no memory_catalog after register');
  }, 5_000);
}
