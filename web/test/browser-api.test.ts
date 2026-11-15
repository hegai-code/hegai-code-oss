import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserError, lastUsed, normalizeAddress, screenFor, type BrowserProfile } from '../src/components/browser/browserApi.js';
import { ApiError } from '../src/teamApi.js';

/**
 * The cloud browser's address field and the words its failures reach a person
 * in. The address rules decide whether «gmail.com» opens Gmail or searches for
 * it, and whether a sentence is sent to `https://привет мир`.
 */

test('a bare host is https, a sentence is a search', () => {
  assert.equal(normalizeAddress('gmail.com'), 'https://gmail.com');
  assert.equal(normalizeAddress(' mail.yandex.ru/inbox?x=1 '), 'https://mail.yandex.ru/inbox?x=1');
  assert.equal(normalizeAddress('example.com:8080/a'), 'https://example.com:8080/a');
  assert.equal(normalizeAddress('https://a.test'), 'https://a.test');
  assert.equal(normalizeAddress('http://10.0.0.1'), 'http://10.0.0.1');
  assert.equal(normalizeAddress('about:blank'), 'about:blank');
  assert.equal(normalizeAddress('localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeAddress('как войти в госуслуги'), `https://duckduckgo.com/?q=${encodeURIComponent('как войти в госуслуги')}`);
  assert.equal(normalizeAddress('привет'), `https://duckduckgo.com/?q=${encodeURIComponent('привет')}`);
  assert.equal(normalizeAddress('   '), '');
  for (const other of ['data:text/html,<b>x</b>', 'view-source:https://a.test', 'ftp://x.org/f', 'file:///etc/passwd']) {
    assert.ok(normalizeAddress(other).startsWith('https://duckduckgo.com/?q='), other);
  }
});

test('the sheet opens on the browser used last', () => {
  const p = (id: string, last: number): BrowserProfile => ({ id, name: id, created_at: 1, last_used_at: last, running: false });
  assert.equal(lastUsed([]), undefined);
  assert.equal(lastUsed([p('a', 10), p('b', 30), p('c', 20)])?.id, 'b');
});

test('failures a person can act on are in Russian', () => {
  assert.match(browserError(new ApiError('at most 3 browser profiles per person', 409)), /трёх/);
  assert.match(browserError(new ApiError('all 4 cloud browsers are in use; try again', 503)), /заняты/);
  assert.match(browserError(new ApiError('cloud browser service is down', 503)), /недоступен/);
  assert.equal(browserError(new Error('net::ERR_NAME_NOT_RESOLVED')), 'net::ERR_NAME_NOT_RESOLVED');
});

test('screenFor: phone gets a phone-wide screen, desk a 1440 one in the sheet\'s shape', async () => {
  assert.deepEqual(screenFor(390, 700), { width: 500, height: 897 });
  assert.deepEqual(screenFor(1240, 760), { width: 1440, height: 883 });
  assert.equal(screenFor(0, 0), null);
});
