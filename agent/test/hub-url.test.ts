import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultAltPorts, hubCandidates, httpBaseOf } from '../src/hub-url.js';

describe('hubCandidates', () => {
  it('the configured door first, then the spare ones on the same name', () => {
    assert.deepEqual(hubCandidates('wss://code.acme.test', {}), [
      'wss://code.acme.test',
      'wss://code.acme.test:8443',
      'wss://code.acme.test:2096',
    ]);
  });

  it('an explicit port is replaced, not appended to', () => {
    assert.deepEqual(hubCandidates('wss://code.acme.test:443/', { CC_REMOTE_ALT_PORTS: '8443' }), [
      'wss://code.acme.test:443',
      'wss://code.acme.test:8443',
    ]);
  });

  it('a dev hub on loopback has no spare doors unless told so', () => {
    assert.deepEqual(hubCandidates('ws://127.0.0.1:4319', {}), ['ws://127.0.0.1:4319']);
    assert.deepEqual(hubCandidates('ws://127.0.0.1:4318', { CC_REMOTE_ALT_PORTS: '4319' }), [
      'ws://127.0.0.1:4318',
      'ws://127.0.0.1:4319',
    ]);
  });

  it('an empty list disables the fallback; junk ports are ignored', () => {
    assert.deepEqual(hubCandidates('wss://hub.example', { CC_REMOTE_ALT_PORTS: '' }), ['wss://hub.example']);
    assert.deepEqual(hubCandidates('wss://hub.example', { CC_REMOTE_ALT_PORTS: 'abc,70000,2096' }), [
      'wss://hub.example',
      'wss://hub.example:2096',
    ]);
  });

  it('the spare relay doors are HegAI-only: internal default, none for the external edition', () => {
    assert.equal(defaultAltPorts(false), '8443,2096');
    assert.equal(defaultAltPorts(true), '');
  });

  it('httpBaseOf maps the scheme and drops the trailing slash', () => {
    assert.equal(httpBaseOf('wss://code.acme.test:8443/'), 'https://code.acme.test:8443');
    assert.equal(httpBaseOf('ws://127.0.0.1:4319'), 'http://127.0.0.1:4319');
  });
});
