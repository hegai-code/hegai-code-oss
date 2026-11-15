import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyModelError } from '../src/model-error.js';

test('a quota refusal is recognised in the forms gateways actually use', () => {
  const refusals = [
    'HTTP 429 Too Many Requests',
    'exceeded retry limit, last status: 429',
    'Rate limit reached for gpt-5 in organization org-x',
    'rate_limit_exceeded',
    'You exceeded your current quota, please check your plan and billing details',
    'budget_exceeded',
    'budget exhausted for virtual key hegai:owner@x.test',
    'insufficient_quota',
    "You've hit your usage limit",
  ];
  for (const text of refusals) {
    assert.equal(classifyModelError(text), 'budget_exhausted', text);
  }
});

test('anything else stays a plain error', () => {
  const plain = [
    undefined,
    '',
    'codex app-server exited 1',
    'spawn codex ENOENT',
    'turn/start timed out',
    'HTTP 500 Internal Server Error',
    'error_max_turns',
    'sha a429b7 is not a commit',
    'port 4293 already in use',
    'ENOSPC: disk quota exceeded',
  ];
  for (const text of plain) {
    assert.equal(classifyModelError(text), undefined, text ?? '(undefined)');
  }
});
