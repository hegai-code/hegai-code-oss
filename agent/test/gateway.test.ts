import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewayProvider, gatewayUrl, isTrustedGateway, journalCompletion } from '../src/gateway.js';

const GATEWAY_URL = 'https://llm.acme.test/v1';

const env = { LLM_JOURNAL_KEY: 'sentinel-secret' };
const completion = (content = 'complete') => ({ choices: [{ finish_reason: 'stop', message: { content } }] });
const request = (body: unknown, status = 200): typeof fetch => async () => new Response(JSON.stringify(body), { status });

test('internal provider accepts only the Hegai Responses gateway', () => {
  const valid = { base_url: GATEWAY_URL, wire_api: 'responses' };
  assert.equal(gatewayProvider({ model_provider: 'hegai', model_providers: { hegai: valid } }), 'hegai');
  assert.ok(isTrustedGateway(`${GATEWAY_URL}/`, GATEWAY_URL));
  for (const url of ['http://llm.acme.test/v1', 'https://llm.acme.test.evil/v1', `${GATEWAY_URL}?key=secret`,
    'https://secret@llm.acme.test/v1', 'https://llm.acme.test:8443/v1', `${GATEWAY_URL}/other`, 'garbage']) {
    assert.equal(isTrustedGateway(url, GATEWAY_URL), false);
    assert.throws(() => gatewayProvider({ model_provider: 'hegai', model_providers: { hegai: { ...valid, base_url: url } } }));
  }
  for (const config of [undefined, {}, { model_provider: 'openai' },
    { model_provider: 'hegai', model_providers: { hegai: { ...valid, requires_openai_auth: true } } },
    { model_provider: 'hegai', model_providers: { hegai: { ...valid, wire_api: 'chat' } } }]) {
    assert.throws(() => gatewayProvider(config));
  }
});

test('journal sends a bounded tool-free request with dedicated service authentication', async () => {
  const mock: typeof fetch = async (url, init) => {
    assert.equal(url, `${GATEWAY_URL}/chat/completions`);
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer sentinel-secret');
    assert.deepEqual(JSON.parse(String(init?.body)), { model: 'selected', messages: [{ role: 'user', content: 'brief' }],
      max_completion_tokens: 6000, stream: false });
    return request(completion())(url, init);
  };
  assert.equal(await journalCompletion('brief', 'selected', env, mock), 'complete');
  let called = false;
  const never: typeof fetch = async () => { called = true; throw new Error('should not call'); };
  await assert.rejects(journalCompletion('brief', undefined, {}, never), /LLM_JOURNAL_KEY/);
  await assert.rejects(journalCompletion('brief', undefined, { ...env, LLM_JOURNAL_URL: 'https://other/v1' }, never), /configured gateway/);
  assert.equal(called, false);
});

test('gateway errors and incomplete output cannot leak upstream content', async () => {
  const bad: Array<typeof fetch> = [
    request({ error: 'sentinel-secret' }, 401),
    async () => { throw new Error('sentinel-secret'); },
    async () => new Response('sentinel-secret'),
    request({ choices: [{ finish_reason: 'length', message: { content: 'sentinel-secret' } }] }),
    request({ choices: [{ finish_reason: 'stop', message: { content: 'sentinel-secret', refusal: 'refused' } }] }),
    request({ choices: [{ finish_reason: 'stop', message: { content: 'sentinel-secret', tool_calls: [{}] } }] }),
    request(completion('x'.repeat(128001))), request(completion('  ')), request({}),
    async () => new Response(new ReadableStream({ start(c) { c.error(new Error('sentinel-secret')); } })),
  ];
  for (const mock of bad) {
    await assert.rejects(journalCompletion('brief', undefined, env, mock), (e: Error) => {
      assert.ok(!e.message.includes('sentinel-secret'));
      return true;
    });
  }
});

test('the gateway URL comes from CC_REMOTE_GATEWAY_URL; the default is internal-only', async () => {
  assert.equal(gatewayUrl({}, false), 'https://llm.acme.test/v1');
  assert.equal(gatewayUrl({}, true), '');
  assert.equal(gatewayUrl({ CC_REMOTE_GATEWAY_URL: ' ' }, true), '');
  assert.equal(gatewayUrl({ CC_REMOTE_GATEWAY_URL: 'https://gw.example.com/v1/' }, true), 'https://gw.example.com/v1');
  assert.equal(gatewayUrl({ CC_REMOTE_GATEWAY_URL: 'https://gw.example.com/v1' }, false), 'https://gw.example.com/v1');

  assert.ok(isTrustedGateway('https://gw.example.com/v1/', 'https://gw.example.com/v1'));
  assert.ok(isTrustedGateway('https://gw.example.com:443/v1', 'https://gw.example.com/v1'));
  assert.equal(isTrustedGateway('https://llm.acme.test/v1', 'https://gw.example.com/v1'), false);
  assert.equal(isTrustedGateway('https://gw.example.com/v2', 'https://gw.example.com/v1'), false);
  assert.equal(isTrustedGateway('http://gw.example.com/v1', 'https://gw.example.com/v1'), false);
  // No gateway configured: nothing matches, and the journal refuses before any request.
  assert.equal(isTrustedGateway('https://llm.acme.test/v1', ''), false);
});

test('a custom gateway is honoured by the journal and rejects other hosts', async () => {
  const custom = { LLM_JOURNAL_KEY: 'k', CC_REMOTE_GATEWAY_URL: 'https://gw.example.com/v1' };
  const mock: typeof fetch = async (url) => {
    assert.equal(url, 'https://gw.example.com/v1/chat/completions');
    return request(completion())(url, undefined);
  };
  assert.equal(await journalCompletion('brief', 'm', custom, mock), 'complete');
  const never: typeof fetch = async () => { throw new Error('should not call'); };
  await assert.rejects(journalCompletion('brief', 'm', { ...custom, LLM_JOURNAL_URL: 'https://llm.acme.test/v1' }, never), /configured gateway/);
});

test('invalid CC_REMOTE_GATEWAY_URL is off, not the default', () => {
  assert.equal(gatewayUrl({}, true), '');
  for (const bad of ['http://gw.example.com/v1', 'https://u:p@gw.example.com/v1', 'https://gw.example.com/v1?k=1', 'nonsense']) {
    assert.equal(gatewayUrl({ CC_REMOTE_GATEWAY_URL: bad }, false), '');
  }
});

test('http is allowed only on loopback', () => {
  assert.equal(gatewayUrl({ CC_REMOTE_GATEWAY_URL: 'http://127.0.0.1:8080/v1' }, true), 'http://127.0.0.1:8080/v1');
  assert.equal(gatewayUrl({ CC_REMOTE_GATEWAY_URL: 'http://localhost:8080/v1' }, true), 'http://localhost:8080/v1');
  assert.equal(gatewayUrl({ CC_REMOTE_GATEWAY_URL: 'http://[::1]:8080/v1' }, true), 'http://[::1]:8080/v1');
  assert.equal(gatewayUrl({ CC_REMOTE_GATEWAY_URL: 'http://10.0.0.5/v1' }, true), '');
});

test('a custom gateway is the only one gatewayProvider accepts; none configured refuses', () => {
  const custom = 'https://gw.example.com/v1';
  const cfg = (base_url: string) => ({ model_provider: 'gw', model_providers: { gw: { base_url, wire_api: 'responses' } } });
  assert.equal(gatewayProvider(cfg(`${custom}/`), custom), 'gw');
  assert.throws(() => gatewayProvider(cfg(GATEWAY_URL), custom));
  assert.throws(() => gatewayProvider(cfg(custom), ''), /No gateway is configured/);
  assert.equal(gatewayProvider(cfg('http://127.0.0.1:9/v1'), 'http://127.0.0.1:9/v1'), 'gw');
});

test('a set but empty CC_REMOTE_GATEWAY_URL turns the gateway off, not the default', () => {
  assert.equal(gatewayUrl({ CC_REMOTE_GATEWAY_URL: '' }, false), '');
  assert.equal(gatewayUrl({ CC_REMOTE_GATEWAY_URL: '  ' }, false), '');
});
