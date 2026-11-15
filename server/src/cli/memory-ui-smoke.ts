/**
 * Wire test for the BROWSER side of memory: a fake agent pushes a note, then a
 * browser connection lists it and reads its body.
 *
 * The agent-side round trip is covered by `memory-smoke.ts`; this one exists
 * because the browser path is scoped differently. `memory_catalog` answers
 * "what should THIS machine hold" and hides other hosts' pinned notes, while
 * the browser asks "what does the hub remember for ME" and must get the whole
 * store for the viewer — two different queries that a test on either side alone
 * would not catch.
 *
 * Every hub->browser message is decoded through `decodeCentralToBrowser`, so a
 * hub `json!()` that drifts from the shared zod schema fails here rather than
 * silently in the UI. It also pins the `optional means absent` rule: a failed
 * read must OMIT `content`, not send null.
 *
 * Usage: tsx server/src/cli/memory-ui-smoke.ts [ws://127.0.0.1:4319] [dev-token]
 */
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { decodeCentralToAgent, decodeCentralToBrowser } from '@cc-remote/shared';
import { fail, sleep } from './_harness.js';

const base = process.argv[2] ?? process.env['CC_SMOKE_URL'] ?? 'ws://127.0.0.1:4319';
const token = process.argv[3] ?? process.env['CC_REMOTE_TOKEN'] ?? 'dev-token';

const MID = 'memory-ui-smoke-machine';
const PROJECT = 'github.com/smoke/ui-repo';
// Unique per run so a re-run never passes on the previous run's row.
const MEMORY_PATH = `ui-smoke-${randomUUID().slice(0, 8)}.md`;
const CONTENT = `# ui smoke\nwritten at ${new Date().toISOString()}\n`;

const timer = setTimeout(() => fail('timed out waiting for the memory UI round trip'), 20_000);

const connect = (path: string): Promise<WebSocket> => {
  const ws = new WebSocket(`${base}${path}?token=${encodeURIComponent(token)}`);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
};

/** Next browser frame of `type`, decoded through the real schema. */
const nextOfType = (ws: WebSocket, type: string): Promise<Record<string, unknown>> =>
  new Promise((resolve) => {
    const onMsg = (raw: Buffer) => {
      let msg: { type?: string };
      try {
        msg = decodeCentralToBrowser(raw.toString()) as { type?: string };
      } catch {
        return; // frames this test does not model; the UI ignores them too
      }
      if (msg.type !== type) return;
      ws.off('message', onMsg);
      resolve(msg as Record<string, unknown>);
    };
    ws.on('message', onMsg);
  });

/** Next hub->agent frame of `type`, decoded through the agent's own schema. */
const nextAgentFrame = (ws: WebSocket, type: string): Promise<Record<string, unknown>> =>
  new Promise((resolve) => {
    const onMsg = (raw: Buffer) => {
      let msg: { type?: string };
      try {
        msg = decodeCentralToAgent(raw.toString()) as { type?: string };
      } catch {
        return;
      }
      if (msg.type !== type) return;
      ws.off('message', onMsg);
      resolve(msg as Record<string, unknown>);
    };
    ws.on('message', onMsg);
  });

async function main(): Promise<void> {
  const ui = await connect('/ui');
  const agent = await connect('/agent');

  agent.send(
    JSON.stringify({
      type: 'register',
      protocol: 1,
      machine: { machineId: MID, name: MID, os: 'linux', agentVersion: '0.0.0' },
      agentInstanceId: randomUUID(),
    }),
  );
  await sleep(500);
  agent.send(
    JSON.stringify({
      type: 'memory_push',
      scope: 'project',
      scopeKey: PROJECT,
      path: MEMORY_PATH,
      content: CONTENT,
    }),
  );
  await sleep(800);

  ui.send(JSON.stringify({ type: 'memory_list', requestId: 'list-1' }));
  const listed = await nextOfType(ui, 'memory_list_result');
  if (listed['ok'] !== true) fail(`memory_list not ok: ${String(listed['error'])}`);
  const memories = (listed['memories'] ?? []) as Array<Record<string, unknown>>;
  const entry = memories.find((m) => m['path'] === MEMORY_PATH);
  if (!entry) fail(`pushed memory ${MEMORY_PATH} missing from the browser list`);
  if (entry['scopeKey'] !== PROJECT) fail(`scopeKey drifted: ${String(entry['scopeKey'])}`);
  if ('content' in entry) fail('memory_list leaked a body — it must be metadata only');

  ui.send(
    JSON.stringify({
      type: 'memory_read',
      requestId: 'read-1',
      scope: 'project',
      scopeKey: PROJECT,
      path: MEMORY_PATH,
    }),
  );
  const read = await nextOfType(ui, 'memory_read_result');
  if (read['ok'] !== true) fail(`memory_read not ok: ${String(read['error'])}`);
  if (read['content'] !== CONTENT) fail('memory_read returned a different body than was pushed');

  ui.send(
    JSON.stringify({
      type: 'memory_read',
      requestId: 'read-2',
      scope: 'project',
      scopeKey: PROJECT,
      path: 'definitely-absent.md',
    }),
  );
  const missing = await nextOfType(ui, 'memory_read_result');
  if (missing['ok'] !== false) fail('reading an absent memory should not report ok');
  if (typeof missing['error'] !== 'string') fail('a failed read must carry an error string');
  if ('content' in missing) fail('a failed read must OMIT content, never send null');

  // Size travels with the list, so a client can show what a corpus costs
  // without fetching every body.
  if (typeof entry['bytes'] !== 'number' || (entry['bytes'] as number) <= 0) {
    fail(`list entry carries no byte size: ${String(entry['bytes'])}`);
  }

  // A machine-scoped note is pinned to the pushing machine, and the hub
  // re-derives that key rather than trusting the agent's claim.
  const MACHINE_NOTE = `machine--${randomUUID().slice(0, 8)}.md`;
  agent.send(
    JSON.stringify({
      type: 'memory_push',
      scope: 'machine',
      scopeKey: 'some-other-box', // deliberately wrong; the hub must ignore it
      path: MACHINE_NOTE,
      content: '# pinned here\n',
    }),
  );
  await sleep(800);
  ui.send(JSON.stringify({ type: 'memory_list', requestId: 'list-2' }));
  const withMachine = await nextOfType(ui, 'memory_list_result');
  const pinned = ((withMachine['memories'] ?? []) as Array<Record<string, unknown>>).find(
    (m) => m['path'] === MACHINE_NOTE,
  );
  if (!pinned) fail('machine-scoped note missing from the list');
  if (pinned['scope'] !== 'machine') fail(`scope drifted: ${String(pinned['scope'])}`);
  if (pinned['scopeKey'] !== MID) {
    fail(`hub trusted a client-supplied machine key: ${String(pinned['scopeKey'])}`);
  }

  // Deletion. The row must disappear from the people-facing list AND appear in
  // the agent catalog marked deleted — without that marker the machine still
  // holding the file pushes it back and the delete never sticks.
  const catalogAfterDelete = nextAgentFrame(agent, 'memory_catalog');
  ui.send(
    JSON.stringify({
      type: 'memory_delete',
      requestId: 'del-1',
      scope: 'project',
      scopeKey: PROJECT,
      path: MEMORY_PATH,
    }),
  );
  const deleted = await nextOfType(ui, 'memory_delete_result');
  if (deleted['ok'] !== true) fail(`memory_delete not ok: ${String(deleted['error'])}`);

  ui.send(JSON.stringify({ type: 'memory_list', requestId: 'list-3' }));
  const afterDelete = await nextOfType(ui, 'memory_list_result');
  const stillListed = ((afterDelete['memories'] ?? []) as Array<Record<string, unknown>>).find(
    (m) => m['path'] === MEMORY_PATH,
  );
  if (stillListed) fail('a deleted note is still shown in the browser list');

  const catalog = await catalogAfterDelete;
  const tomb = ((catalog['memories'] ?? []) as Array<Record<string, unknown>>).find(
    (m) => m['path'] === MEMORY_PATH,
  );
  if (!tomb) fail('the tombstone never reached the agent catalog — the delete would be undone');
  if (tomb['deleted'] !== true) fail('catalog row is present but not marked deleted');

  // And the body is gone for readers.
  ui.send(
    JSON.stringify({
      type: 'memory_read',
      requestId: 'read-3',
      scope: 'project',
      scopeKey: PROJECT,
      path: MEMORY_PATH,
    }),
  );
  const readDeleted = await nextOfType(ui, 'memory_read_result');
  if (readDeleted['ok'] !== false) fail('a deleted note can still be read');

  clearTimeout(timer);
  ui.close();
  agent.close();
  console.log(
    `PASS: ${MEMORY_PATH} listed, read, sized, machine-pinned, deleted, and tombstoned to the agent`,
  );
  process.exit(0);
}

main().catch((e) => fail(String(e)));
