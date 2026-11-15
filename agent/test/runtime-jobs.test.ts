import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { claudeLoginUrl, jobStatus } from '../src/runtime-jobs.js';

describe('claudeLoginUrl', () => {
  it('finds the OAuth page in what `claude auth login` prints, ANSI and all', () => {
    const out =
      '\x1b[1mOpening browser to sign in…\x1b[0m\n' +
      "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=abc\n" +
      'Paste code here if prompted > ';
    assert.equal(
      claudeLoginUrl(out),
      'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=abc',
    );
  });

  it('is undefined until the line has arrived', () => {
    assert.equal(claudeLoginUrl('Opening browser to sign in…\nIf the browser'), undefined);
  });
});

describe('jobStatus', () => {
  it('an unknown id is a failed job with a reason, not an exception', () => {
    const s = jobStatus('nope');
    assert.equal(s.state, 'failed');
    assert.match(s.tail ?? '', /не найдено/);
  });
});

describe('installArgs', () => {
  it('Claude installs into the user prefix (no sudo); Codex as before', async () => {
    const { installArgs } = await import('../src/runtime-jobs.js');
    assert.deepEqual(installArgs('claude', 'linux', '/home/u'), ['install', '-g', '--prefix', '/home/u/.local', '@anthropic-ai/claude-code']);
    assert.deepEqual(installArgs('codex', 'linux', '/home/u'), ['install', '-g', '@openai/codex']);
  });
});
