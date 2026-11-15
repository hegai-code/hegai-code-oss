import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HARNESS_AGENTS, HARNESS_PROMPT, harnessEnabled, harnessOptions } from '../src/harness.js';

test('the harness is on unless the agent environment turns it off', () => {
  assert.equal(harnessEnabled({}), true);
  assert.equal(harnessEnabled({ CC_REMOTE_HARNESS: '' }), true);
  for (const off of ['off', 'OFF', '0', 'false', 'no']) {
    assert.equal(harnessEnabled({ CC_REMOTE_HARNESS: off }), false, off);
    assert.deepEqual(harnessOptions({ CC_REMOTE_HARNESS: off }), {}, off);
  }
});

test('Explore and the implementer run on Sonnet, the reviewer on Opus', () => {
  // `Explore` must keep the built-in's exact name: that is what replaces the
  // built-in, which otherwise inherits the (Opus) parent model.
  assert.equal(HARNESS_AGENTS['Explore']?.model, 'sonnet');
  assert.equal(HARNESS_AGENTS['implementer']?.model, 'sonnet');
  assert.equal(HARNESS_AGENTS['reviewer']?.model, 'opus');
  assert.ok(HARNESS_AGENTS['codex-reviewer']);
});

test('read-only agents get no edit tools (an instruction, not a sandbox)', () => {
  for (const name of ['Explore', 'reviewer', 'codex-reviewer']) {
    const tools = HARNESS_AGENTS[name]?.tools ?? [];
    assert.ok(tools.length > 0, `${name} must name its tools, not inherit Edit/Write`);
    for (const t of ['Edit', 'Write', 'NotebookEdit', 'Agent']) assert.ok(!tools.includes(t), `${name} has ${t}`);
  }
});

test('the instruction travels as a plain string, never the claude_code preset', () => {
  // A preset would swap every session's base prompt for the full CLI one.
  const opts = harnessOptions({});
  assert.equal(typeof opts.systemPrompt, 'string');
  assert.equal(opts.systemPrompt, HARNESS_PROMPT);
  for (const name of ['Explore', 'implementer', 'reviewer', 'codex-reviewer']) {
    assert.ok(HARNESS_PROMPT.includes(name), `prompt never mentions ${name}`);
  }
});
