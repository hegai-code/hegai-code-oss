import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionOrigins } from '../src/session-origins.js';

test('creation outcomes survive restart until the hub acknowledges exactly that run', t => {
  const root = mkdtempSync(join(tmpdir(), 'session-origins-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'origins.json');
  const first = new SessionOrigins(file);
  first.record('created', 'session-1'); first.record('rejected', null);
  const second = new SessionOrigins(file);
  assert.deepEqual(second.entries(), [['created', 'session-1'], ['rejected', null]]);
  second.acknowledge('created'); second.acknowledge('unrelated');
  assert.deepEqual(new SessionOrigins(file).entries(), [['rejected', null]]);
  writeFileSync(file, '{broken');
  assert.throws(() => new SessionOrigins(file), 'corruption must not silently forget ownership');
});
