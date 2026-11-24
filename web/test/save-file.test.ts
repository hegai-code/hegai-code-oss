import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REVOKE_AFTER_MS, mimeForName, needsSaveTap, saveBlob, withMime, type SaveEnv } from '../src/saveFile.js';

function env(over: { coarse?: boolean; share?: SaveEnv['navigator']['share']; canShare?: boolean } = {}) {
  const log: string[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const anchor = {
    href: '',
    download: '',
    click: () => log.push(`click:${anchor.href}:${anchor.download}`),
    remove: () => log.push('remove'),
  };
  const e: SaveEnv = {
    navigator: {
      canShare: over.canShare === false ? undefined : () => true,
      share: over.share,
    },
    coarsePointer: over.coarse ?? false,
    createObjectURL: () => 'blob:x',
    revokeObjectURL: (u) => log.push(`revoke:${u}`),
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    createAnchor: () => anchor,
    append: () => log.push('append'),
  };
  return { e, log, timers };
}

const blob = new Blob(['hi'], { type: 'video/mp4' });

test('desktop: anchor in the DOM, revoke only after the delay', async () => {
  const { e, log, timers } = env({ share: async () => assert.fail('no share on desktop') });
  assert.equal(await saveBlob(blob, 'a.mp4', e), 'downloaded');
  assert.deepEqual(log, ['append', 'click:blob:x:a.mp4', 'remove']);
  assert.equal(timers.length, 1);
  assert.equal(timers[0]!.ms, REVOKE_AFTER_MS);
  assert.ok(REVOKE_AFTER_MS >= 60_000);
  timers[0]!.fn();
  assert.equal(log.at(-1), 'revoke:blob:x');
});

test('touch device that can share files needs a fresh tap, then shares', async () => {
  let shared: unknown;
  const { e, log } = env({ coarse: true, share: async (d) => void (shared = d) });
  assert.equal(needsSaveTap(e), true);
  assert.equal(await saveBlob(blob, 'a.mp4', e), 'shared');
  assert.equal((shared as { files: File[] }).files[0]!.name, 'a.mp4');
  assert.deepEqual(log, []); // no anchor
});

test('share is called synchronously, before any await', () => {
  let called = false;
  const { e } = env({ coarse: true, share: async () => void (called = true) });
  void saveBlob(blob, 'a.mp4', e);
  assert.equal(called, true);
});

test('dismissing the share sheet is not an error and does not download', async () => {
  const { e, log } = env({
    coarse: true,
    share: async () => {
      throw Object.assign(new Error('x'), { name: 'AbortError' });
    },
  });
  assert.equal(await saveBlob(blob, 'a.mp4', e), 'cancelled');
  assert.deepEqual(log, []);
});

test('a share that fails otherwise falls back to the anchor', async () => {
  const { e, log } = env({
    coarse: true,
    share: async () => {
      throw new Error('NotAllowedError');
    },
  });
  assert.equal(await saveBlob(blob, 'a.mp4', e), 'downloaded');
  assert.ok(log.includes('click:blob:x:a.mp4'));
});

test('touch without file sharing: second tap, then anchor', async () => {
  const { e } = env({ coarse: true, canShare: false });
  // The second tap is required on every touch device, share support or not.
  assert.equal(needsSaveTap(e), true);
  assert.equal(await saveBlob(blob, 'a.mp4', e), 'downloaded');
});

test('desktop never needs a second tap', () => {
  assert.equal(needsSaveTap(env({ coarse: false }).e), false);
});

test('fetched blobs get a type by extension', () => {
  assert.equal(mimeForName('a.MP4'), 'video/mp4');
  assert.equal(mimeForName('a.m4v'), 'video/mp4');
  assert.equal(mimeForName('a.mov'), 'video/quicktime');
  assert.equal(mimeForName('a.webm'), 'video/webm');
  assert.equal(mimeForName('a.mp3'), 'audio/mpeg');
  assert.equal(mimeForName('a.csv'), 'text/csv');
  assert.match(mimeForName('a.docx'), /wordprocessingml/);
  assert.equal(mimeForName('a.unknown'), 'application/octet-stream');
  assert.equal(mimeForName('noext'), 'application/octet-stream');
  assert.equal(withMime(new Blob(['x']), 'a.pdf').type, 'application/pdf');
  assert.equal(withMime(new Blob(['x'], { type: 'image/png' }), 'a.pdf').type, 'image/png');
});

test('share gets a typed File', async () => {
  let shared: { files: File[] } | undefined;
  const { e } = env({ coarse: true, share: async (d) => void (shared = d) });
  await saveBlob(new Blob(['x']), 'a.mp4', e);
  assert.equal(shared!.files[0]!.type, 'video/mp4');
});
