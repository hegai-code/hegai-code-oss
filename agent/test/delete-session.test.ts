import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deleteClaudeSession } from '../src/rpc-dispatch.js';

type Remove = Parameters<typeof deleteClaudeSession>[2];

test('a transcript already gone everywhere is a finished delete, not an error', async () => {
  const calls: Array<string | undefined> = [];
  const remove = (async (id: string, opts?: { dir?: string }) => {
    calls.push(opts?.dir);
    throw new Error(
      opts?.dir
        ? `Session ${id} not found in project directory for ${opts.dir}`
        : `Session ${id} not found in any project directory`,
    );
  }) as Remove;
  await deleteClaudeSession('s1', '/srv/x', remove);
  assert.deepEqual(calls, ['/srv/x', undefined]);
});

test('a transcript under another project directory is still found and deleted', async () => {
  const deleted: string[] = [];
  const remove = (async (id: string, opts?: { dir?: string }) => {
    if (opts?.dir) throw new Error(`Session ${id} not found in project directory for ${opts.dir}`);
    deleted.push(id);
  }) as Remove;
  await deleteClaudeSession('s2', '/srv/moved', remove);
  assert.deepEqual(deleted, ['s2']);
});

test('any other failure still reaches the person', async () => {
  const remove = (async () => {
    throw new Error('EACCES: permission denied');
  }) as Remove;
  await assert.rejects(deleteClaudeSession('s3', '/srv/x', remove), /EACCES/);
});
