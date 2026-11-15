/**
 * The pid file is how a supervisor answers «is an agent already running?»
 * across a Windows session boundary, where reading a command line is refused.
 * Both halves are load-bearing in opposite directions:
 *
 *   - publish too little and the supervisor starts a SECOND agent for one
 *     machineId — two writers to one transcript;
 *   - clean up too eagerly and it does the same thing, because the file it
 *     deleted belonged to the daemon that had just replaced it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = mkdtempSync(join(tmpdir(), 'ccr-pid-'));
process.env['CC_REMOTE_STATE_DIR'] = state;

const { pidFile, writePidFile, releasePidFile } = await import('../src/config.js');

test('the agent publishes its own pid where a supervisor can read it', () => {
  writePidFile(4242);
  assert.equal(readFileSync(pidFile(), 'utf8'), '4242');
});

test('leaving releases the claim', () => {
  writePidFile(4242);
  releasePidFile(4242);
  assert.equal(existsSync(pidFile()), false);
});

test('a superseded daemon must not delete its replacement’s claim', () => {
  // The real sequence: the newcomer writes its pid while the old process is
  // still shutting down. Shipped without this guard on 20.09.2026, and the
  // supervisor promptly started a third agent.
  writePidFile(100); // the old daemon
  writePidFile(200); // its replacement, already up
  releasePidFile(100); // the old one finally exits
  assert.equal(readFileSync(pidFile(), 'utf8'), '200');
});

test('releasing when the file is already gone is not an error', () => {
  releasePidFile(999);
  releasePidFile(999);
});

test('a file written by something else is left alone', () => {
  writeFileSync(pidFile(), 'not a pid', 'utf8');
  releasePidFile(4242);
  assert.equal(readFileSync(pidFile(), 'utf8'), 'not a pid');
});
