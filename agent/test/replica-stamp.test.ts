import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { HistoryMessage } from '@cc-remote/shared';
import { attachTaskNotices, replicaStamp } from '../src/history.js';

const msg = (uuid: string, blocks: HistoryMessage['blocks']): HistoryMessage => ({ uuid, type: 'user', blocks }) as HistoryMessage;

test('a prefix without notices keeps the bare hash the fleet already stores', () => {
  const m = [msg('a', [{ kind: 'text', text: 'привет' }]), msg('b', [{ kind: 'text', text: 'ок' }])];
  assert.equal(replicaStamp(m, 2), createHash('sha256').update(JSON.stringify(m[1])).digest('hex'));
});

test('a notice attached to an OLD message changes the stamp of the prefix', () => {
  const m = [
    msg('a', [{ kind: 'tool_result', toolUseId: 'toolu_A', text: 'Async agent launched successfully.' } as never]),
    msg('b', [{ kind: 'text', text: 'дальше' }]),
  ];
  const before = replicaStamp(m, 2);
  attachTaskNotices(m, [{ toolUseId: 'toolu_A', status: 'completed', summary: 'итог' }]);
  // The tail message is untouched — the old check would have appended.
  assert.equal(JSON.stringify(m[1]), JSON.stringify(msg('b', [{ kind: 'text', text: 'дальше' }])));
  assert.notEqual(replicaStamp(m, 2), before);
});
