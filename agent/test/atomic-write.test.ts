import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { tmpPathFor, writeFileAtomic, writeFileAtomicSync } from '../src/atomic-write.js';

function scratch(t: test.TestContext): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccr-atomic-'));
  t.after(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('tmpPathFor names a fresh scratch file beside the target', () => {
  const target = path.join('/a/b', 'note.md');
  const plain = tmpPathFor(target);
  assert.match(plain, /^\/a\/b\/note\.md\.[0-9a-f]{8}\.tmp$/);
  assert.match(tmpPathFor(target, { hidden: true }), /^\/a\/b\/\.note\.md\.[0-9a-f]{8}\.part$/);
  assert.notEqual(plain, tmpPathFor(target));
});

for (const [name, write] of [
  ['async', async (...a: Parameters<typeof writeFileAtomic>) => writeFileAtomic(...a)],
  ['sync', async (...a: Parameters<typeof writeFileAtomic>) => writeFileAtomicSync(...a)],
] as const) {
  test(`${name}: replaces the file and leaves no scratch behind`, async (t) => {
    const dir = scratch(t);
    const file = path.join(dir, 'state.json');
    writeFileSync(file, 'old');
    await write(file, '{"a":1}', { fsync: true });
    assert.equal(readFileSync(file, 'utf8'), '{"a":1}');
    assert.deepEqual(readdirSync(dir), ['state.json']);
  });

  test(`${name}: mode and mkdir are honoured`, async (t) => {
    const dir = scratch(t);
    const file = path.join(dir, 'deep', 'er', 'secret.json');
    await write(file, 'x', { mode: 0o600, mkdir: 0o700 });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
  });

  test(`${name}: a failed write rethrows and removes its scratch file`, async (t) => {
    const dir = scratch(t);
    const target = path.join(dir, 'target');
    mkdirSync(target); // rename of a file onto a directory fails
    await assert.rejects(Promise.resolve().then(() => write(target, 'x')));
    assert.deepEqual(readdirSync(dir), ['target']);
  });

  test(`${name}: without mkdir a missing parent is an error, not a created tree`, async (t) => {
    const dir = scratch(t);
    await assert.rejects(Promise.resolve().then(() => write(path.join(dir, 'nope', 'f'), 'x')));
    assert.deepEqual(readdirSync(dir), []);
  });
}
