// The invitation preview the sign-in and setup pages show before anyone is
// signed in: one POST carrying the token in the body (never in a URL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { teamApi } from '../src/teamApi.js';

test('invitePreview posts the token in the body and returns the team and inviter', async () => {
  const seen: { url: string; body: string }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), body: String(init?.body) });
    return new Response(JSON.stringify({ workspaceName: 'Acme', inviterName: 'Анна', email: 'p@acme.test' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const p = await teamApi.invitePreview('secret-token');
    assert.equal(p.workspaceName, 'Acme');
    assert.equal(p.inviterName, 'Анна');
    assert.equal(seen[0]!.url.includes('secret-token'), false);
    assert.match(seen[0]!.url, /\/api\/invitations\/preview$/);
    assert.equal(JSON.parse(seen[0]!.body).token, 'secret-token');
  } finally {
    globalThis.fetch = real;
  }
});
