import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  manifestText,
  parseManifest,
  parseSha,
  parseSig,
  compareVersions,
  selfUpdateAllowedFor,
  selfUpdateEnabled,
  sha256,
  SelfUpdater,
  signedByTrustedKey,
  updateBase,
  type ReleasePolicy,
} from '../src/self-update.js';
import { RELEASE_KEYS } from '../src/release-keys.js';

/** The internal edition: no manifest, no signature — behaviour unchanged. */
const INTERNAL: ReleasePolicy = { external: false, keys: [] };

/**
 * Self-update, end to end against a throwaway HTTP "hub": what is published,
 * what gets verified, and — the part that decides whether anyone loses work —
 * WHEN it swaps.
 */

test('only a deployed agent.mjs updates itself, and the env can pin it', () => {
  assert.equal(selfUpdateEnabled('/home/cc-remote-agent/agent.mjs', {}), true);
  assert.equal(selfUpdateEnabled('C:\\Users\\x\\cc-remote-agent\\agent.mjs'.replace(/\\/g, '/'), {}), true);
  assert.equal(selfUpdateEnabled('/srv/main-source/agent/src/main.ts', {}), false, 'a source run is a dev tree');
  assert.equal(selfUpdateEnabled('/home/cc-remote-agent/agent.mjs', { CC_REMOTE_AUTO_UPDATE: '0' }), false);
});

test('the download base follows the hub the agent already talks to', () => {
  assert.equal(updateBase('wss://code.acme.test', {}), 'https://code.acme.test/install');
  // The Mac mini: an ssh tunnel straight to the hub, no nginx on the path.
  assert.equal(updateBase('ws://127.0.0.1:4319/', {}), 'http://127.0.0.1:4319/install');
  assert.equal(updateBase('wss://code.acme.test', { CC_REMOTE_UPDATE_URL: 'https://relay/x/' }), 'https://relay/x');
});

test('parseSha reads a bare hash and a sha256sum line', () => {
  const h = 'a'.repeat(64);
  assert.equal(parseSha(`${h}\n`), h);
  assert.equal(parseSha(`${h.toUpperCase()}  deploy/agent.mjs\n`), h);
  assert.equal(parseSha('<html>not found</html>'), undefined);
});

/** A fake hub serving /dl/agent.mjs and its hash. */
async function hub(files: Record<string, string>): Promise<{ base: string; server: Server; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    const body = files[req.url ?? ''];
    if (body === undefined) {
      res.statusCode = 404;
      return res.end();
    }
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}/dl`, server, hits };
}

function installDir(current: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cc-selfupdate-'));
  // Like a real install: a package.json that makes the directory ESM.
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  writeFileSync(path.join(dir, 'agent.mjs'), current);
  return path.join(dir, 'agent.mjs');
}

const GOOD = "if (process.argv.includes('--self-test')) { console.log('self-test ok v2'); process.exit(0); }\n";
const BROKEN = "import { nope } from 'node:fs';\nconsole.log('self-test ok');\n";

test('a newer bundle is verified, self-tested, waits for quiet, then swaps and restarts', async () => {
  const bundle = installDir('// v1\n');
  const { base, server } = await hub({ '/dl/agent.mjs': GOOD, '/dl/agent.mjs.sha256': `${sha256(GOOD)}  agent.mjs\n` });
  let quiet = false;
  let restarted = 0;
  const up = new SelfUpdater(base, { isQuiet: () => quiet, restartForUpdate: () => restarted++ }, bundle, INTERNAL);
  try {
    await up.start();
    await up.check();
    assert.equal(readFileSync(bundle, 'utf8'), '// v1\n', 'a busy agent must not swap');
    assert.equal(restarted, 0);
    assert.ok(existsSync(path.join(path.dirname(bundle), 'agent.update.mjs')), 'but the new bundle is staged');

    quiet = true;
    await up.check();
    // The swap and the restart land a tick after `check()` resolves. A fixed
    // 50 ms was enough on a laptop and not on the CI runner while `hub` builds
    // in the next container (29.09.2026, run 238: `restarted` 0 !== 1, and the
    // log line «installed … restarting» printed right after the assertion).
    // Wait for the state, with a ceiling, instead of guessing a delay.
    for (let t = Date.now(); restarted === 0 && Date.now() - t < 5000; ) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(readFileSync(bundle, 'utf8'), GOOD);
    assert.equal(readFileSync(`${bundle}.prev`, 'utf8'), '// v1\n', 'the previous bundle is kept');
    assert.equal(restarted, 1);
  } finally {
    up.stop();
    server.close();
  }
});

test('the same bundle is left alone', async () => {
  const bundle = installDir(GOOD);
  const { base, server, hits } = await hub({ '/dl/agent.mjs': GOOD, '/dl/agent.mjs.sha256': sha256(GOOD) });
  let restarted = 0;
  const up = new SelfUpdater(base, { isQuiet: () => true, restartForUpdate: () => restarted++ }, bundle, INTERNAL);
  try {
    await up.start();
    await up.check();
    assert.equal(restarted, 0);
    assert.deepEqual(hits, ['/dl/agent.mjs.sha256'], 'no download when the hash matches');
  } finally {
    up.stop();
    server.close();
  }
});

test('a download that does not match the advertised hash is refused', async () => {
  const bundle = installDir('// v1\n');
  const { base, server } = await hub({ '/dl/agent.mjs': GOOD, '/dl/agent.mjs.sha256': sha256('something else') });
  let restarted = 0;
  const up = new SelfUpdater(base, { isQuiet: () => true, restartForUpdate: () => restarted++ }, bundle, INTERNAL);
  try {
    await up.start();
    await up.check();
    assert.equal(readFileSync(bundle, 'utf8'), '// v1\n');
    assert.equal(restarted, 0);
  } finally {
    up.stop();
    server.close();
  }
});

test('a bundle that cannot start is never installed', async () => {
  const bundle = installDir('// v1\n');
  const { base, server } = await hub({ '/dl/agent.mjs': BROKEN, '/dl/agent.mjs.sha256': sha256(BROKEN) });
  let restarted = 0;
  const up = new SelfUpdater(base, { isQuiet: () => true, restartForUpdate: () => restarted++ }, bundle, INTERNAL);
  try {
    await up.start();
    await up.check();
    assert.equal(readFileSync(bundle, 'utf8'), '// v1\n');
    assert.equal(existsSync(path.join(path.dirname(bundle), 'agent.update.mjs')), false, 'the failed candidate is cleaned up');
    assert.equal(restarted, 0);
  } finally {
    up.stop();
    server.close();
  }
});

test('a connect that arrives before the running bundle is hashed still triggers a check', async () => {
  const bundle = installDir('// v1\n');
  const { base, server, hits } = await hub({ '/dl/agent.mjs': GOOD, '/dl/agent.mjs.sha256': sha256(GOOD) });
  const up = new SelfUpdater(base, { isQuiet: () => false, restartForUpdate: () => {} }, bundle, INTERNAL);
  try {
    up.onConnected(); // the register ack beat start()
    await up.start();
    const deadline = Date.now() + 40_000;
    while (!hits.includes('/dl/agent.mjs.sha256') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    assert.ok(hits.includes('/dl/agent.mjs.sha256'), 'the early connect was remembered');
  } finally {
    up.stop();
    server.close();
  }
});

test('a bundle in a directory it cannot write is left to its host, and never downloads', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root can write anywhere — the check is for managed installs');
  const bundle = installDir('// v1\n');
  chmodSync(path.dirname(bundle), 0o555);
  const { base, server, hits } = await hub({ '/dl/agent.mjs': GOOD, '/dl/agent.mjs.sha256': sha256(GOOD) });
  const up = new SelfUpdater(base, { isQuiet: () => true, restartForUpdate: () => {} }, bundle, INTERNAL);
  try {
    await up.start();
    await up.check();
    assert.deepEqual(hits, [], 'nothing fetched');
  } finally {
    chmodSync(path.dirname(bundle), 0o755);
    up.stop();
    server.close();
  }
});

// ---- external edition: release manifest + signature ---------------------------

const VERSION = '0.3.4';
/** An external build answers its self-test with the edition marker. */
const GOOD_EXT = "if (process.argv.includes('--self-test')) { console.log('self-test ok v2 HEGAI_AGENT_EDITION=external'); process.exit(0); }\n";
/** A signed INTERNAL build: it would trust no key and verify nothing. */
const GOOD_INT = "if (process.argv.includes('--self-test')) { console.log('self-test ok v2 HEGAI_AGENT_EDITION=internal'); process.exit(0); }\n";
const SIGNER = generateKeyPairSync('ed25519');
const spki = (k: typeof SIGNER): string => k.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const EXTERNAL: ReleasePolicy = { external: true, keys: [spki(SIGNER)] };
/** A key nobody trusts — what a compromised hub would have. */
const STRANGER = generateKeyPairSync('ed25519');
const sigOf = (manifest: string, key = SIGNER.privateKey): string => `${sign(null, Buffer.from(manifest), key).toString('base64')}\n`;

/** The three files the hub serves for a signed bundle. */
function released(body: string, key = SIGNER.privateKey): Record<string, string> {
  const manifest = manifestText(VERSION, sha256(body));
  return {
    '/dl/agent.mjs': body,
    '/dl/agent.mjs.sha256': `${sha256(body)}\n`,
    '/dl/agent.mjs.release': manifest,
    '/dl/agent.mjs.sig': sigOf(manifest, key),
  };
}

/** A bundle that leaves a mark if it ever executes, even as a self-test. */
const MARKS = "import { writeFileSync } from 'node:fs';\nwriteFileSync('RAN', '1');\nconsole.log('self-test ok');\n";

async function settle(cond: () => boolean): Promise<void> {
  for (let t = Date.now(); !cond() && Date.now() - t < 5000; ) await new Promise((r) => setTimeout(r, 25));
}

test('external: a signed bundle with a matching manifest is installed', async () => {
  const bundle = installDir('// v1\n');
  const { base, server } = await hub(released(GOOD_EXT));
  let restarted = 0;
  const up = new SelfUpdater(base, { isQuiet: () => true, restartForUpdate: () => restarted++ }, bundle, EXTERNAL);
  try {
    await up.start();
    await up.check();
    await settle(() => restarted > 0);
    assert.equal(readFileSync(bundle, 'utf8'), GOOD_EXT);
    assert.equal(restarted, 1);
  } finally {
    up.stop();
    server.close();
  }
});

test('external: no release files yet is a retry, not a verdict', async () => {
  const bundle = installDir('// v1\n');
  const files: Record<string, string> = { '/dl/agent.mjs': GOOD_EXT, '/dl/agent.mjs.sha256': sha256(GOOD_EXT) };
  const { base, server } = await hub(files);
  let restarted = 0;
  const up = new SelfUpdater(base, { isQuiet: () => true, restartForUpdate: () => restarted++ }, bundle, EXTERNAL);
  try {
    await up.start();
    await up.check();
    assert.equal(readFileSync(bundle, 'utf8'), '// v1\n');
    assert.equal(existsSync(path.join(path.dirname(bundle), 'agent.update.mjs')), false, 'nothing staged');
    Object.assign(files, released(GOOD_EXT)); // the hub publishes them a minute later
    await up.check();
    await settle(() => restarted > 0);
    assert.equal(readFileSync(bundle, 'utf8'), GOOD_EXT);
  } finally {
    up.stop();
    server.close();
  }
});

test('external: a bundle signed by another key never runs, not even its self-test, and is refused for good', async () => {
  const bundle = installDir('// v1\n');
  const dir = path.dirname(bundle);
  const { base, server, hits } = await hub(released(MARKS, STRANGER.privateKey));
  let restarted = 0;
  const up = new SelfUpdater(base, { isQuiet: () => true, restartForUpdate: () => restarted++ }, bundle, EXTERNAL);
  try {
    await up.start();
    await up.check();
    assert.equal(existsSync(path.join(dir, 'RAN')), false, 'hub-supplied code never executed');
    assert.equal(existsSync(path.join(dir, 'agent.update.mjs')), false, 'never written to disk');
    assert.equal(readFileSync(bundle, 'utf8'), '// v1\n');
    const before = hits.filter((h) => h === '/dl/agent.mjs').length;
    await up.check();
    assert.equal(hits.filter((h) => h === '/dl/agent.mjs').length, before, 'refused: not downloaded again');
    assert.equal(restarted, 0);
  } finally {
    up.stop();
    server.close();
  }
});

test('external: a genuine manifest for a DIFFERENT file does not carry over', async () => {
  const bundle = installDir('// v1\n');
  const other = released(GOOD_EXT);
  const files = { ...other, '/dl/agent.mjs': MARKS, '/dl/agent.mjs.sha256': sha256(MARKS) };
  const { base, server } = await hub(files);
  const up = new SelfUpdater(base, { isQuiet: () => true, restartForUpdate: () => {} }, bundle, EXTERNAL);
  try {
    await up.start();
    await up.check();
    assert.equal(existsSync(path.join(path.dirname(bundle), 'RAN')), false);
    assert.equal(existsSync(path.join(path.dirname(bundle), 'agent.update.mjs')), false);
    assert.equal(readFileSync(bundle, 'utf8'), '// v1\n');
  } finally {
    up.stop();
    server.close();
  }
});

test('external: a release landing between the bundle and the sidecars is a retry, not a refusal', async () => {
  const bundle = installDir('// v1\n');
  const next = "if (process.argv.includes('--self-test')) { console.log('self-test ok v3 HEGAI_AGENT_EDITION=external'); process.exit(0); }\n";
  // The bundle fetched is GOOD_EXT; by the time the sidecars and the hash are read, the hub moved to `next`.
  const files: Record<string, string> = { ...released(next), '/dl/agent.mjs': GOOD_EXT };
  let first = true;
  const server = createServer((req, res) => {
    // The hash is read once before the bundle (still the old release), then the hub moves.
    let body = files[req.url ?? ''];
    if (req.url === '/dl/agent.mjs.sha256' && first) {
      first = false;
      body = `${sha256(GOOD_EXT)}\n`;
    }
    if (body === undefined) {
      res.statusCode = 404;
      return res.end();
    }
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/dl`;
  let restarted = 0;
  const up = new SelfUpdater(base, { isQuiet: () => true, restartForUpdate: () => restarted++ }, bundle, EXTERNAL);
  try {
    await up.start();
    await up.check(); // bundle = GOOD_EXT, manifest/sig/sha = next
    assert.equal(readFileSync(bundle, 'utf8'), '// v1\n');
    files['/dl/agent.mjs'] = next; // the deploy finished writing
    await up.check();
    await settle(() => restarted > 0);
    assert.equal(restarted, 1, 'the moved release is installed, the first hash was not refused for good');
    assert.equal(readFileSync(bundle, 'utf8'), next);
  } finally {
    up.stop();
    server.close();
  }
});

test('external: a bad signature is refused for good only while the hub still advertises that hash', async () => {
  const bundle = installDir('// v1\n');
  const files = released(MARKS, STRANGER.privateKey);
  // First check: hash MARKS, then (re-read after the bad signature) the hub has moved. Later reads: MARKS again.
  const shaReads = [`${sha256(MARKS)}\n`, `${sha256(GOOD_EXT)}\n`];
  const bundleHits: string[] = [];
  const server = createServer((req, res) => {
    let body = files[req.url ?? ''];
    if (req.url === '/dl/agent.mjs') bundleHits.push(req.url);
    if (req.url === '/dl/agent.mjs.sha256' && shaReads.length) body = shaReads.shift();
    if (body === undefined) {
      res.statusCode = 404;
      return res.end();
    }
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/dl`;
  const up = new SelfUpdater(base, { isQuiet: () => true, restartForUpdate: () => {} }, bundle, EXTERNAL);
  try {
    await up.start();
    await up.check();
    assert.equal(bundleHits.length, 1);
    await up.check(); // the hub settled on MARKS and it is still unsigned: now a verdict
    assert.equal(bundleHits.length, 2, 'the moved hash was not refused, so it was fetched again');
    await up.check();
    assert.equal(bundleHits.length, 2, 'refused for good: not downloaded again');
    assert.equal(existsSync(path.join(path.dirname(bundle), 'RAN')), false);
    assert.equal(readFileSync(bundle, 'utf8'), '// v1\n');
  } finally {
    up.stop();
    server.close();
  }
});

test('external: a manifest edited after signing fails the signature', async () => {
  const bundle = installDir('// v1\n');
  const files = released(MARKS);
  files['/dl/agent.mjs.release'] = manifestText('9.9.9', sha256(MARKS)); // same hash, other version
  const { base, server } = await hub(files);
  const up = new SelfUpdater(base, { isQuiet: () => true, restartForUpdate: () => {} }, bundle, EXTERNAL);
  try {
    await up.start();
    await up.check();
    assert.equal(existsSync(path.join(path.dirname(bundle), 'RAN')), false);
    assert.equal(readFileSync(bundle, 'utf8'), '// v1\n');
  } finally {
    up.stop();
    server.close();
  }
});

test('external: a hub answering 200 with a web page for the release files is a retry', async () => {
  const bundle = installDir('// v1\n');
  const files: Record<string, string> = {
    '/dl/agent.mjs': GOOD_EXT,
    '/dl/agent.mjs.sha256': sha256(GOOD_EXT),
    '/dl/agent.mjs.release': '<html>app</html>',
    '/dl/agent.mjs.sig': '<html>app</html>',
  };
  const { base, server } = await hub(files);
  let restarted = 0;
  const up = new SelfUpdater(base, { isQuiet: () => true, restartForUpdate: () => restarted++ }, bundle, EXTERNAL);
  try {
    await up.start();
    await up.check();
    assert.equal(readFileSync(bundle, 'utf8'), '// v1\n');
    Object.assign(files, released(GOOD_EXT));
    await up.check();
    await settle(() => restarted > 0);
    assert.equal(restarted, 1, 'not refused for good');
  } finally {
    up.stop();
    server.close();
  }
});

test('external: a manifest that attests another edition is refused for good, and never runs', async () => {
  const bundle = installDir('// v1\n');
  const dir = path.dirname(bundle);
  const manifest = manifestText(VERSION, sha256(MARKS), 'internal');
  const files = { ...released(MARKS), '/dl/agent.mjs.release': manifest, '/dl/agent.mjs.sig': sigOf(manifest) };
  const { base, server, hits } = await hub(files);
  const up = new SelfUpdater(base, { isQuiet: () => true, restartForUpdate: () => {} }, bundle, EXTERNAL);
  try {
    await up.start();
    await up.check();
    assert.equal(existsSync(path.join(dir, 'RAN')), false);
    assert.equal(existsSync(path.join(dir, 'agent.update.mjs')), false);
    const before = hits.filter((h) => h === '/dl/agent.mjs').length;
    await up.check();
    assert.equal(hits.filter((h) => h === '/dl/agent.mjs').length, before, 'refused: not downloaded again');
    assert.equal(readFileSync(bundle, 'utf8'), '// v1\n');
  } finally {
    up.stop();
    server.close();
  }
});

test('external: a signed bundle that does not report an external build fails staging and is not installed', async () => {
  const bundle = installDir('// v1\n');
  const { base, server } = await hub(released(GOOD_INT)); // mis-signed internal bundle
  let restarted = 0;
  const up = new SelfUpdater(base, { isQuiet: () => true, restartForUpdate: () => restarted++ }, bundle, EXTERNAL);
  try {
    await up.start();
    await up.check();
    assert.equal(readFileSync(bundle, 'utf8'), '// v1\n');
    assert.equal(existsSync(path.join(path.dirname(bundle), 'agent.update.mjs')), false, 'staged file removed');
    assert.equal(restarted, 0);
    // and an old-style self-test with no marker is no better
    const old = await hub(released("if (process.argv.includes('--self-test')) { console.log('self-test ok v2'); process.exit(0); }\n"));
    const up2 = new SelfUpdater(old.base, { isQuiet: () => true, restartForUpdate: () => restarted++ }, bundle, EXTERNAL);
    await up2.start();
    await up2.check();
    assert.equal(restarted, 0);
    up2.stop();
    old.server.close();
  } finally {
    up.stop();
    server.close();
  }
});

test('external: with no key compiled in the agent never self-updates', async () => {
  const bundle = installDir('// v1\n');
  const { base, server, hits } = await hub(released(GOOD_EXT));
  const up = new SelfUpdater(base, { isQuiet: () => true, restartForUpdate: () => {} }, bundle, { external: true, keys: [] });
  try {
    await up.start();
    await up.check();
    assert.deepEqual(hits, [], 'nothing fetched');
  } finally {
    up.stop();
    server.close();
  }
});

test('manifest and signature parsing is strict, and the compiled-in list is empty in a source run', () => {
  const sha = 'a'.repeat(64);
  assert.deepEqual(parseManifest(manifestText('1.2.3', sha)), { edition: 'external', version: '1.2.3', sha256: sha });
  assert.equal(parseManifest(`hegai-code-agent-release/1\nversion=1.2.3\nsha256=${sha}\n`), undefined, 'the edition line is part of the format');
  assert.equal(parseManifest(manifestText('1.2.3', sha).replace(/\n/g, '\r\n')), undefined, 'CRLF is a different text');
  assert.equal(parseManifest(manifestText('1.2.3', sha).trimEnd()), undefined, 'trailing LF required');
  assert.equal(parseManifest(`${manifestText('1.2.3', sha)}extra=1\n`), undefined);
  assert.equal(parseManifest(manifestText('1.2.3', sha.toUpperCase())), undefined);
  const s = sign(null, Buffer.from('x'), SIGNER.privateKey);
  assert.deepEqual(parseSig(`${s.toString('base64')}\n`), s);
  assert.equal(parseSig('<html>404</html>'), undefined);
  assert.ok(signedByTrustedKey(Buffer.from('x'), s, ['not a key', ...EXTERNAL.keys]), 'a bad entry is skipped');
  assert.equal(signedByTrustedKey(Buffer.from('x'), s, [spki(STRANGER)]), false);
  assert.equal(signedByTrustedKey(Buffer.from('y'), s, EXTERNAL.keys), false);
  assert.deepEqual([...RELEASE_KEYS], [], 'no define in a source run: nothing is trusted');
});

test('a private machine self-updates only on the signed external edition', () => {
  assert.equal(selfUpdateAllowedFor(false, false), true);
  assert.equal(selfUpdateAllowedFor(true, false), false);
  assert.equal(selfUpdateAllowedFor(true, true), true);
});

test('versions compare numerically, part by part', () => {
  assert.equal(compareVersions('1.2.10', '1.2.9'), 1);
  assert.equal(compareVersions('1.2.9', '1.2.10'), -1);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
});
