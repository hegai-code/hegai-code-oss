import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  codexCandidateDirs,
  describeSearch,
  invalidateCodexBin,
  isResolved,
  resolveCodexBin,
  sortVersionsDesc,
  versionRoots,
} from '../src/runtime-locate.js';

/**
 * The failure this module exists for: a Codex installed where a person's
 * shell finds it and the agent's LaunchAgent does not. The list of places is
 * the contract — it is what «Codex не найден» prints, and a Mac user with
 * nvm has to be on it.
 */
describe('codexCandidateDirs', () => {
  it('lists the package managers a Mac actually uses, Homebrew first', () => {
    const dirs = codexCandidateDirs('darwin', '/Users/ilya', {});
    assert.equal(dirs[0], '/opt/homebrew/bin');
    assert.ok(dirs.includes('/usr/local/bin'), 'Intel Homebrew and the Node pkg installer');
    assert.ok(dirs.includes('/Users/ilya/.npm-global/bin'));
    assert.ok(dirs.includes('/Users/ilya/.volta/bin'));
  });

  it('honours a custom npm prefix ahead of everything', () => {
    const dirs = codexCandidateDirs('linux', '/home/a', { NPM_CONFIG_PREFIX: '/opt/npm' });
    assert.equal(dirs[0], '/opt/npm/bin');
  });

  it('on Windows looks in the npm shim dir under APPDATA', () => {
    const dirs = codexCandidateDirs('win32', 'C:\\Users\\Anna', { APPDATA: 'C:\\Users\\Anna\\AppData\\Roaming' });
    assert.equal(dirs[0], path.join('C:\\Users\\Anna\\AppData\\Roaming', 'npm'));
  });
});

describe('versionRoots / sortVersionsDesc', () => {
  it('knows nvm and fnm roots and respects NVM_DIR', () => {
    const roots = versionRoots('darwin', '/Users/ilya', { NVM_DIR: '/opt/nvm' });
    assert.equal(roots[0], '/opt/nvm/versions/node');
    assert.ok(roots.some((r) => r.includes('fnm')));
  });

  it('puts the newest Node first so the codex that was installed last wins', () => {
    assert.deepEqual(sortVersionsDesc(['v18.20.4', 'v22.11.0', 'v20.19.0', 'junk']), [
      'v22.11.0',
      'v20.19.0',
      'v18.20.4',
      'junk',
    ]);
  });
});

describe('resolveCodexBin', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ccr-locate-'));
  afterEach(() => invalidateCodexBin());

  const fakeBin = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'codex');
    writeFileSync(p, '#!/bin/sh\necho codex-cli 0.154.0\n');
    chmodSync(p, 0o755);
    return p;
  };

  it('finds codex in an nvm version dir that is NOT on PATH', async () => {
    const home = path.join(tmp, 'home-nvm');
    const bin = fakeBin(path.join(home, '.nvm', 'versions', 'node', 'v22.11.0', 'bin'));
    fakeBin(path.join(home, '.nvm', 'versions', 'node', 'v18.20.4', 'bin'));
    // A PATH with no codex on it — this box has a real /usr/bin/codex, so the
    // usual `/usr/bin:/bin` would find that one and prove nothing.
    const r = await resolveCodexBin({ refresh: true, platform: 'linux', home, env: { PATH: path.join(tmp, 'nowhere') } });
    assert.ok(isResolved(r), 'must be found');
    assert.equal(r.path, bin, 'newest version wins');
    assert.equal(r.source, 'well-known');
  });

  it('a CODEX_BIN that is set but not runnable falls through and is named in the miss', async () => {
    const home = path.join(tmp, 'home-empty');
    mkdirSync(home, { recursive: true });
    const r = await resolveCodexBin({
      refresh: true,
      platform: 'linux',
      home,
      env: { PATH: path.join(tmp, 'nowhere'), CODEX_BIN: path.join(tmp, 'gone', 'codex') },
    });
    assert.ok(!isResolved(r));
    assert.match(r.envHint ?? '', /CODEX_BIN=.*not runnable/);
    assert.ok(r.searched.includes(path.join(tmp, 'nowhere')));
    assert.match(describeSearch(r), /CODEX_BIN=.*; искал: /);
  });

  it('a runnable CODEX_BIN is honoured every time, even after a different hit was cached', async () => {
    const home = path.join(tmp, 'home-env');
    const onPath = fakeBin(path.join(home, 'bin'));
    const first = await resolveCodexBin({ refresh: true, platform: 'linux', home, env: { PATH: path.join(home, 'bin') } });
    assert.ok(isResolved(first) && first.path === onPath);
    const explicit = fakeBin(path.join(home, 'explicit'));
    const second = await resolveCodexBin({ platform: 'linux', home, env: { PATH: path.join(home, 'bin'), CODEX_BIN: explicit } });
    assert.ok(isResolved(second));
    assert.equal(second.path, explicit);
    assert.equal(second.source, 'env');
  });

  it('a cached hit whose file disappeared is not returned', async () => {
    const home = path.join(tmp, 'home-gone');
    const p = fakeBin(path.join(home, 'bin'));
    const env = { PATH: path.join(home, 'bin') };
    assert.ok(isResolved(await resolveCodexBin({ refresh: true, platform: 'linux', home, env })));
    rmSync(p);
    const r = await resolveCodexBin({ platform: 'linux', home, env });
    assert.ok(!isResolved(r));
  });
});

describe('resolveClaudeBin', () => {
  it('finds a user-local claude (~/.local/bin) that is not on PATH, (searched before the system dirs)', async () => {
    const { resolveClaudeBin } = await import('../src/runtime-locate.js');
    const home = mkdtempSync(path.join(tmpdir(), 'ccr-claude-'));
    const env = { PATH: path.join(home, 'nowhere') };
    mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    const p = path.join(home, '.local', 'bin', 'claude');
    writeFileSync(p, '#!/bin/sh\n');
    chmodSync(p, 0o755);
    assert.equal(await resolveClaudeBin({ platform: 'linux', home, env, bundled: null }), p);
    rmSync(home, { recursive: true, force: true });
  });
});
