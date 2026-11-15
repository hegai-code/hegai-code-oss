import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, apiJson, apiJsonOrNull, apiRequest } from '../src/api.js';
import { newId, pluralRu, toMillis } from '../src/lib.js';

/**
 * The one way the SPA asks the hub's same-origin REST API: the cookie always
 * rides along, a refusal is an `ApiError` carrying the hub's own words (or the
 * caller's fallback), and a body is JSON unless the caller says otherwise.
 */

type Seen = { path: string; init: RequestInit };

function stubFetch(answer: Response): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (path: string, init: RequestInit = {}) => {
    seen.push({ path, init });
    return answer;
  }) as typeof fetch;
  return seen;
}

test('a request carries the cookie, and JSON only when it has a body', async () => {
  const seen = stubFetch(new Response('{"ok":true}', { status: 200 }));
  await apiRequest('/api/me');
  await apiRequest('/api/x', { method: 'POST', body: '{}' });
  await apiRequest('/api/y', { method: 'POST', body: 'a', headers: { 'content-type': 'text/plain' } });
  assert.equal(seen[0]!.init.credentials, 'same-origin');
  assert.equal(new Headers(seen[0]!.init.headers).get('content-type'), null);
  assert.equal(new Headers(seen[1]!.init.headers).get('content-type'), 'application/json');
  assert.equal(new Headers(seen[2]!.init.headers).get('content-type'), 'text/plain');
});

test('a refusal is an ApiError with the hub\'s words, else the fallback', async () => {
  stubFetch(new Response('{"error":"access_not_active"}', { status: 403 }));
  await assert.rejects(apiRequest('/api/x'), (e: unknown) => e instanceof ApiError && e.status === 403 && e.message === 'access_not_active');

  stubFetch(new Response('<html>', { status: 502 }));
  await assert.rejects(apiRequest('/api/x'), (e: unknown) => e instanceof ApiError && e.status === 502 && e.message === 'Запрос не удался (502)');
  await assert.rejects(
    apiRequest('/api/x', { fallback: (s) => `HTTP ${s}` }),
    (e: unknown) => e instanceof ApiError && e.message === 'HTTP 502',
  );
});

test('apiJson reads the body, and a 204 is undefined', async () => {
  stubFetch(new Response('{"a":1}', { status: 200 }));
  assert.deepEqual(await apiJson<{ a: number }>('/api/x'), { a: 1 });
  stubFetch(new Response(null, { status: 204 }));
  assert.equal(await apiJson<void>('/api/x'), undefined);
});

test('apiJsonOrNull is null for any refusal and still rejects with no hub', async () => {
  stubFetch(new Response('{"gatewayQuota":null}', { status: 200 }));
  assert.deepEqual(await apiJsonOrNull('/api/q'), { gatewayQuota: null });
  stubFetch(new Response('{"error":"x"}', { status: 500 }));
  assert.equal(await apiJsonOrNull('/api/q'), null);
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  await assert.rejects(apiJsonOrNull('/api/q'), TypeError);
});

test('small shared helpers: plural forms, seconds-or-ms, short ids', () => {
  const forms = ['проект', 'проекта', 'проектов'] as const;
  assert.deepEqual([1, 2, 5, 11, 12, 21, 22, 25, 111, 0].map((n) => pluralRu(n, forms)), [
    'проект', 'проекта', 'проектов', 'проектов', 'проектов', 'проект', 'проекта', 'проектов', 'проектов', 'проектов',
  ]);
  assert.equal(toMillis(1_700_000_000), 1_700_000_000_000);
  assert.equal(toMillis(1_700_000_000_000), 1_700_000_000_000);
  assert.match(newId(), /^[a-z0-9]{1,6}$/);
  assert.match(newId('v', 8), /^v[a-z0-9]{1,8}$/);
});
