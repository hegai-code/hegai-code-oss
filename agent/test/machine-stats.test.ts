import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMacSize, sampleMachineStats } from '../src/machine-stats.js';

test('parseMacSize reads sysctl vm.swapusage', () => {
  const out = 'total = 10240.00M  used = 8935.50M  free = 1304.50M  (encrypted)';
  assert.equal(parseMacSize(out, 'total'), 10240 * 1024 ** 2);
  assert.equal(parseMacSize(out, 'used'), Math.round(8935.5 * 1024 ** 2));
  assert.equal(parseMacSize('total = 0.00M  used = 0.00M', 'used'), 0);
  assert.equal(parseMacSize('garbage', 'total'), 0);
});

// The disk row used to measure `/` — on macOS the sealed system volume, on
// Windows nothing at all. Whatever the platform, a sample must now describe a
// real volume with the reserve counted as used.
test('disk sample describes the home volume', async () => {
  const s = await sampleMachineStats();
  assert.ok(s.diskTotal > 0, 'diskTotal is measured');
  assert.ok(s.diskUsed > 0 && s.diskUsed <= s.diskTotal, 'used within total');
});
