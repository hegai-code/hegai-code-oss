import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentToCentral, HistoryMessage } from '@cc-remote/shared';
import { redactMessages, redactOutgoing, redactValue, redactionEnabled } from '../src/redact.js';

const ENV_FILE = 'DATABASE_URL=postgres://app:Pg5ecret99@db:5432/x\nSTRIPE_SECRET_KEY=sk_live_51HxYzAbCdEf1234567890\nDEBUG=true';

test('replica messages leave with tool output masked, structure intact', () => {
  const messages: HistoryMessage[] = [
    { type: 'user', uuid: 'u-1', blocks: [{ kind: 'text', text: 'посмотри .env' }] },
    {
      type: 'assistant',
      uuid: 'a-1',
      model: 'claude-opus-5-5',
      blocks: [
        { kind: 'thinking', text: 'Прочитаю файл .env' },
        { kind: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'cat .env' } },
      ],
    },
    { type: 'user', uuid: 'u-2', blocks: [{ kind: 'tool_result', toolUseId: 'toolu_1', text: ENV_FILE }] },
  ];
  const out = redactMessages(messages);
  const result = out[2]!.blocks[0] as { kind: 'tool_result'; text: string };
  assert.equal(
    result.text,
    'DATABASE_URL=postgres://app:‹masked›@db:5432/x\nSTRIPE_SECRET_KEY=‹masked›\nDEBUG=true',
  );
  // everything without a secret is the SAME object — nothing copied for nothing
  assert.equal(out[0], messages[0]);
  assert.equal(out[1], messages[1]);
  assert.equal(out[2]!.uuid, 'u-2');
  // the original is untouched: the local transcript is not ours to change
  assert.equal((messages[2]!.blocks[0] as { text: string }).text, ENV_FILE);
});

test('a stream event masks text, data and the raw SDK message, but not image bytes', () => {
  // a base64 payload that happens to contain an AWS-key shape must survive
  const bytes = 'iVBORw0KGgo/AKIAABCDEFGHIJKLMNOP/' + 'A'.repeat(64);
  const msg: AgentToCentral = {
    type: 'stream',
    sessionId: 's',
    runId: 'r',
    event: {
      kind: 'assistant',
      text: 'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123',
      raw: {
        message: {
          content: [
            { type: 'text', text: 'Authorization: Bearer abc.DEF123.ghi' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes } },
          ],
        },
      },
    },
  };
  const out = redactOutgoing(msg) as Extract<AgentToCentral, { type: 'stream' }>;
  assert.equal(out.event.text, 'export GITHUB_TOKEN=‹masked›');
  const content = (out.event.raw as { message: { content: Array<Record<string, unknown>> } }).message.content;
  assert.equal(content[0]!['text'], 'Authorization: Bearer ‹masked›');
  assert.equal((content[1]!['source'] as { data: string }).data, bytes);
});

test('frames that must stay verbatim are not touched', () => {
  const request = {
    type: 'tool_request',
    runId: 'r',
    requestId: 'q',
    toolName: 'Bash',
    input: { command: 'curl -H "Authorization: Bearer abc.DEF123.ghi" x' },
  } as unknown as AgentToCentral;
  assert.equal(redactOutgoing(request), request, 'an approval echoes its input back as updatedInput');
  const term = { type: 'term_data', termId: 't', data: 'GITHUB_TOKEN=a1b2c3d4e5f6\n' } as AgentToCentral;
  assert.equal(redactOutgoing(term), term, 'the owner asked for the terminal bytes');
});

test('ids are never rewritten, and the owner can switch it off', () => {
  const v = { id: 'token=Abc123Def456', uuid: 'x', text: 'token=Abc123Def456' };
  const out = redactValue(v);
  assert.equal(out.id, v.id);
  assert.equal(out.text, 'token=‹masked›');
  assert.equal(redactionEnabled({ CC_REMOTE_REDACT: '0' }), false);
  assert.equal(redactionEnabled({}), true);
});

test('a large transcript is masked in reasonable time', () => {
  const big: HistoryMessage[] = Array.from({ length: 2000 }, (_, i) => ({
    type: 'user' as const,
    uuid: `u-${i}`,
    blocks: [{ kind: 'tool_result' as const, toolUseId: `t${i}`, text: 'line of ordinary output\n'.repeat(200) }],
  }));
  // Budget = order-of-magnitude guard against super-linear (backtracking) behavior, not a throughput
  // target: a loaded CI box legitimately runs 2-3x slower, while a bad regex would take minutes.
  const started = Date.now();
  redactMessages(big);
  assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms for ~10 MB`);
});

// Review of 4915f24: a password full of generator punctuation was taken for a
// reference and left open; only a value that is WHOLLY a reference is one.
test('passwords with punctuation are secrets, whole references are not', () => {
  for (const [input, want] of [
    ['DB_PASSWORD=Xk9$mQ2!vv', 'DB_PASSWORD=‹masked›'],
    ['POSTGRES_PASSWORD="hunter2(prod)"', 'POSTGRES_PASSWORD=‹masked›'],
    ['"password": "Zq<7>pp91"', '"password": ‹masked›'],
    ['api_key: Ab3{xx}yy99', 'api_key: ‹masked›'],
    ['SECRET=%Tr0ub4dor', 'SECRET=‹masked›'],
    ['PASSWORD=ab;cdef123', 'PASSWORD=‹masked›'],
  ] as const) {
    assert.equal(redactValue({ text: input }).text, want, input);
  }
  for (const ref of ['PASSWORD=$DB_PASSWORD', 'token=${TOKEN}', 'SECRET=%APP_SECRET%', 'api_key: <your key>']) {
    assert.equal(redactValue({ text: ref }).text, ref, ref);
  }
});

test('inventory titles, not partials, not paths', () => {
  const inv = {
    type: 'inventory',
    sessions: [{ sessionId: 's', title: 'задеплой с ключом sk-ant-api03-AAAAAAAAAAAAAAAAAAAA', cwd: '/x', lastModified: 1 }],
  } as unknown as AgentToCentral;
  const out = redactOutgoing(inv) as { sessions: Array<{ title: string }> };
  assert.equal(out.sessions[0]!.title, 'задеплой с ключом ‹masked›');
  const partial = { type: 'stream', sessionId: 's', runId: 'r', event: { kind: 'partial', text: 'token=Abc123Def456' } } as AgentToCentral;
  assert.equal(redactOutgoing(partial), partial);
  const edit = { file_path: '/srv/app/token=Abc123Def456/x.ts', text: 'token=Abc123Def456' };
  assert.equal(redactValue(edit).file_path, edit.file_path);
});

// Every rule now sees whole tool results, so a regex that is merely slow on
// a pathological megabyte freezes the agent. This is the budget CI holds.
test('hostile inputs stay within budget', () => {
  const hostile = [
    'a.'.repeat(100_000),
    '--x-token- '.repeat(100_000),
    '-----BEGIN PRIVATE KEY-----'.repeat(40_000),
    'http://'.repeat(100_000),
    'token='.repeat(100_000),
    'Authorization: Bearer '.repeat(40_000),
    'x'.repeat(1_000_000),
  ];
  for (const text of hostile) {
    // Budget = order-of-magnitude guard against super-linear (backtracking) behavior, not a throughput
    // target: a loaded CI box legitimately runs 2-3x slower, while a bad regex would take minutes.
    const started = Date.now();
    redactValue({ text });
    const ms = Date.now() - started;
    assert.ok(ms < 5_000, `${JSON.stringify(text.slice(0, 20))}… took ${ms} ms`);
  }
});

// LLM review of bdef799: a header value is the credential even without a digit.
test('header credentials are masked whatever they look like', () => {
  assert.equal(redactValue({ t: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' }).t, 'Authorization: Bearer ‹masked›');
  assert.equal(redactValue({ t: 'Cookie: session=abcdefghijklmnopqrstuv' }).t, 'Cookie: ‹masked›');
  assert.equal(redactValue({ t: 'Authorization: Bearer $TOKEN' }).t, 'Authorization: Bearer $TOKEN');
});
