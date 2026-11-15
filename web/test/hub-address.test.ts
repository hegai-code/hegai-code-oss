import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hubAddress } from '../src/lib.js';
import { resolveFullOrigin } from '../src/lite/full-origin.js';

const loc = (host: string, scheme = 'https') => ({
  origin: `${scheme}://${host}`,
  host,
  hostname: host.replace(/:\d+$/, ''),
});

test('instructions name the hub the page is served from', () => {
  assert.deepEqual(hubAddress(loc('code.acme.test')), {
    origin: 'https://code.acme.test',
    host: 'code.acme.test',
    spareDoor: 'https://code.acme.test:8443',
  });
  // A customer's hub: its own name, and no HegAI relay door.
  assert.deepEqual(hubAddress(loc('code.acme.example')), {
    origin: 'https://code.acme.example',
    host: 'code.acme.example',
    spareDoor: null,
  });
  assert.equal(hubAddress(loc('127.0.0.1:4319', 'http')).spareDoor, null);
  assert.equal(hubAddress(loc('notacme.test.evil.example')).spareDoor, null);
});

test('the light shell finds its full client: configured, HegAI production, or itself', () => {
  assert.equal(resolveFullOrigin('https://full.example/', loc('lite.example')), 'https://full.example');
  assert.equal(resolveFullOrigin(undefined, loc('remote.acme.test')), 'https://code.acme.test');
  assert.equal(resolveFullOrigin('', loc('remote.acme.test')), 'https://code.acme.test');
  assert.equal(resolveFullOrigin(undefined, loc('code.acme.example')), 'https://code.acme.example');
  assert.equal(resolveFullOrigin(undefined, loc('localhost:5173', 'http')), 'http://localhost:5173');
});
