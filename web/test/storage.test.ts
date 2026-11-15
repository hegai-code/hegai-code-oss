import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { storageGet, storageRemove, storageSet } from '../src/storage.js';

/**
 * A browser that blocks site data throws on the first touch of
 * `localStorage`, and private modes throw on a write. The helpers are the one
 * place that is allowed to know that; everything else calls them bare from a
 * render or an error handler.
 */
const g = globalThis as { localStorage?: unknown };
const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(() => {
  if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
  else delete g.localStorage;
});

function blocked(): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
  });
}

test('a blocked store reads as a missing key and swallows writes', () => {
  blocked();
  assert.equal(storageGet('k'), null);
  assert.doesNotThrow(() => storageSet('k', 'v'));
  assert.doesNotThrow(() => storageRemove('k'));
});

test('a store that throws only on write (private mode, full quota) still reads', () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (k === 'seen' ? '1' : null),
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
      removeItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    },
  });
  assert.equal(storageGet('seen'), '1');
  assert.equal(storageGet('other'), null);
  assert.doesNotThrow(() => storageSet('k', 'v'));
  assert.doesNotThrow(() => storageRemove('k'));
});

test('a working store round-trips, and the store is looked up at call time', () => {
  const m = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    },
  });
  storageSet('cc-x', '1');
  assert.equal(storageGet('cc-x'), '1');
  storageRemove('cc-x');
  assert.equal(storageGet('cc-x'), null);
});

test('no store at all (node, a blocked embed) is the same as a blocked one', () => {
  delete g.localStorage;
  assert.equal(storageGet('k'), null);
  assert.doesNotThrow(() => storageSet('k', 'v'));
  assert.doesNotThrow(() => storageRemove('k'));
});
