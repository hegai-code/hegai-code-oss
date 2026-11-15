import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The mirror keeps its image ledger across drains: a Bash call and its result
 *  appended in different chunks still make the picture. */

const HOME = await mkdtemp(join(tmpdir(), 'mirror-gen-home-'));
process.env['HOME'] = HOME;
const { MirrorManager } = await import('../src/mirror.js');
type Sink = (replace: boolean, messages: Array<{ uuid: string; blocks: unknown[] }>) => void;

const SESSION = '00000000-0000-4000-8000-0000000000bb';
const row = (r: Record<string, unknown>) => `${JSON.stringify({ isSidechain: false, sessionId: 's', cwd: '/w', timestamp: '2026-10-24T12:00:01.000Z', ...r })}\n`;
const call = (id: string, command: string) =>
  row({ type: 'assistant', uuid: `a-${id}`, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const result = (id: string, text: string) =>
  row({ type: 'user', uuid: `u-${id}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });

type Priv = { drain(id: string, sink: Sink): Promise<void> };

async function setup(initial: string) {
  const dir = join(HOME, '.claude', 'projects', '-w');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${SESSION}.jsonl`);
  await writeFile(file, initial);
  const got: Array<{ replace: boolean; uuids: string[]; msgs: Array<{ uuid: string; blocks: unknown[] }> }> = [];
  const sink: Sink = (replace, msgs) => got.push({ replace, uuids: msgs.map((m) => m.uuid), msgs });
  const mgr = new MirrorManager();
  await mgr.open('m1', SESSION, '/w', sink);
  return { file, got, sink, mgr, drain: () => (mgr as unknown as Priv).drain('m1', sink) };
}

test('mirror: tool_use in one drain, result in the next -> the picture message is emitted', async () => {
  const s = await setup(call('toolu_M1', 'hegai-image "cat" o.png'));
  try {
    await appendFile(s.file, call('toolu_M2', 'ls'));
    await s.drain();
    await appendFile(s.file, result('toolu_M1', 'o.png 10x10 5 KB 2s\n'));
    await s.drain();
    const all = s.got.flatMap((g) => g.uuids);
    assert.ok(all.includes('u-toolu_M1:gen:toolu_M1'), `got ${JSON.stringify(all)}`);
    const pic = s.got.flatMap((g) => g.msgs).find((m) => m.uuid === 'u-toolu_M1:gen:toolu_M1')!;
    assert.deepEqual(pic.blocks, [{ kind: 'image', ref: 'gen:toolu_M1#0', generated: true, prompt: 'cat' }]);
  } finally {
    s.mgr.closeAll();
  }
});

test('mirror: a truncated/replaced file resets the ledger', async () => {
  const s = await setup(call('toolu_T1', 'hegai-image "cat" o.png'));
  try {
    // shorter file => the mirror reloads its tail with a fresh ledger
    await writeFile(s.file, row({ type: 'user', uuid: 'tiny', message: { role: 'user', content: 'x' } }));
    await s.drain();
    const before = s.got.length;
    await appendFile(s.file, result('toolu_T1', 'o.png 10x10 5 KB 2s\n'));
    await s.drain();
    const fresh = s.got.slice(before).flatMap((g) => g.uuids);
    assert.equal(fresh.includes('u-toolu_T1:gen:toolu_T1'), false, 'the call was forgotten with the old file');
  } finally {
    s.mgr.closeAll();
    await rm(HOME, { recursive: true, force: true });
  }
});
