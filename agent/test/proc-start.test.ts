import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HIT_TTL_MS,
  MISS_TTL_MS,
  cachedReader,
  parseStatStartTicks,
  processStartToken,
  sameStartToken,
} from '../src/proc-start.js';

/**
 * The fingerprint that tells a pid's owner from the pid's next owner. The CLI
 * writes it as an opaque string and compares it by equality, so what matters
 * here is that OUR reading of it is byte-for-byte the CLI's: a token that
 * differs from the CLI's for the SAME process would make every live editor look
 * like a stranger.
 */

/** A `/proc/<pid>/stat` line: fields 3..52 are zeros except field 22. */
function statLine(comm: string, startTicks: number): string {
  const fields: string[] = [];
  for (let n = 3; n <= 52; n += 1) fields.push(n === 3 ? 'S' : n === 22 ? String(startTicks) : '0');
  return `4242 (${comm}) ${fields.join(' ')}\n`;
}

test('field 22 of /proc/<pid>/stat, however odd the comm', () => {
  assert.equal(parseStatStartTicks(statLine('claude', 123456)), '123456');
  // `comm` may hold spaces and parentheses; only the LAST `)` closes it.
  assert.equal(parseStatStartTicks(statLine('my (odd) proc', 987654)), '987654');
  assert.equal(parseStatStartTicks(statLine('a) S 1 2 3 (b', 55)), '55');
  assert.equal(parseStatStartTicks(statLine('', 7)), '7');
});

test('a stat line that is not one is not a reading', () => {
  for (const raw of ['', 'garbage', '4242 (x) S 1 2', '4242 (x) ' + 'S '.repeat(30)]) {
    assert.equal(parseStatStartTicks(raw), undefined, JSON.stringify(raw));
  }
});

test('tokens compare by equality, whitespace aside', () => {
  assert.equal(sameStartToken('123456', '123456'), true);
  assert.equal(sameStartToken('123456', '123457'), false);
  // A raw `ps` token: a trailing newline or a padded day must not read as «different».
  assert.equal(sameStartToken('Thu Oct  1 00:00:05 2026\n', 'Thu Oct 1 00:00:05 2026'), true);
});

test('the per-pid cache keeps a hit 60 s and a miss 5 s, and `fresh` bypasses it', async () => {
  let clock = 0;
  const calls: number[] = [];
  const answers = new Map<number, string | undefined>([
    [1, 'A'],
    [2, undefined],
  ]);
  const read = cachedReader(async (pid) => {
    calls.push(pid);
    return answers.get(pid);
  }, () => clock);

  assert.equal(await read(1), 'A');
  assert.equal(await read(2), undefined);
  assert.deepEqual(calls, [1, 2]);

  clock = MISS_TTL_MS - 1;
  await read(1);
  await read(2);
  assert.deepEqual(calls, [1, 2], 'both still cached');

  clock = MISS_TTL_MS;
  answers.set(2, 'B');
  assert.equal(await read(2), 'B', 'a miss is retried after 5 s');
  assert.equal(await read(1), 'A');
  assert.deepEqual(calls, [1, 2, 2], 'a hit is not');

  clock = HIT_TTL_MS;
  answers.set(1, 'C');
  assert.equal(await read(1), 'C', 'a hit expires after 60 s');

  answers.set(1, 'D');
  assert.equal(await read(1), 'C', 'cached again');
  assert.equal(await read(1, true), 'D', 'fresh reads through and refreshes the cache');
  assert.equal(await read(1), 'D');
});

test('an invalid or dead pid has no token', async () => {
  for (const pid of [0, -1, 1.5, Number.NaN, 2_000_000_000]) {
    assert.equal(await processStartToken(pid), undefined, String(pid));
  }
});

test('on Linux this process has a numeric, stable token', { skip: process.platform !== 'linux' }, async () => {
  const first = await processStartToken(process.pid);
  assert.ok(first !== undefined && /^\d+$/.test(first), `token ${String(first)}`);
  assert.equal(await processStartToken(process.pid), first);
  assert.equal(await processStartToken(process.pid, { fresh: true }), first);
});

test('on an unsupported OS nothing is known', { skip: process.platform === 'linux' || process.platform === 'darwin' }, async () => {
  assert.equal(await processStartToken(process.pid), undefined);
});
