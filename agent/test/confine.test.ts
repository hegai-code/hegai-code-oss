import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
const require_fs = () => nodeFs;
import os from 'node:os';
import path from 'node:path';
import {
  ConfineError,
  assertRolloutInUnit,
  buildBwrapArgs,
  codexSessionRoots,
  confinePrefix,
  confinedCommand,
  prepareConfinement,
  resolveUnit,
  unitCodexHome,
  unitKey,
  unitScratchDir,
} from '../src/confine.js';

function metaLine(id: string, cwd: string): string {
  return `${JSON.stringify({ timestamp: '2026-10-21T00:00:00Z', type: 'session_meta', payload: { id, cwd } })}\n`;
}

function tree() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ccr-confine-')));
  const prefix = path.join(root, 'projects');
  const home = path.join(root, 'home');
  for (const d of ['delo-a/sub', 'delo-b', '_personal/u1/x', 'outside']) mkdirSync(path.join(prefix, d), { recursive: true });
  mkdirSync(path.join(home, '.codex'), { recursive: true });
  return { root, prefix, home };
}

test('confinePrefix: off when unset, absolute required, root refused', () => {
  assert.equal(confinePrefix({}), undefined);
  assert.equal(confinePrefix({ CC_REMOTE_CONFINE_RUNS: '  ' }), undefined);
  assert.equal(confinePrefix({ CC_REMOTE_CONFINE_RUNS: '/srv/legal/projects/' }), '/srv/legal/projects');
  assert.throws(() => confinePrefix({ CC_REMOTE_CONFINE_RUNS: 'rel' }), ConfineError);
  assert.throws(() => confinePrefix({ CC_REMOTE_CONFINE_RUNS: '/' }), ConfineError);
});

test('resolveUnit: matter, nested cwd, personal', () => {
  const { prefix } = tree();
  assert.equal(resolveUnit(path.join(prefix, 'delo-a'), prefix).rel, 'delo-a');
  const nested = resolveUnit(path.join(prefix, 'delo-a/sub'), prefix);
  assert.equal(nested.rel, 'delo-a');
  assert.equal(nested.unitDir, path.join(prefix, 'delo-a'));
  assert.equal(nested.cwd, path.join(prefix, 'delo-a/sub'));
  const personal = resolveUnit(path.join(prefix, '_personal/u1/x'), prefix);
  assert.equal(personal.rel, '_personal/u1');
  assert.equal(personal.unitDir, path.join(prefix, '_personal/u1'));
});

test('resolveUnit: prefix itself, _personal itself, outside and missing are refused', () => {
  const { root, prefix } = tree();
  assert.throws(() => resolveUnit(prefix, prefix), ConfineError);
  assert.throws(() => resolveUnit(path.join(prefix, '_personal'), prefix), ConfineError);
  assert.throws(() => resolveUnit(root, prefix), ConfineError);
  assert.throws(() => resolveUnit('/etc', prefix), ConfineError);
  assert.throws(() => resolveUnit(path.join(prefix, 'nope'), prefix), ConfineError);
  assert.throws(() => resolveUnit(path.join(prefix, 'delo-a', '..', '..'), prefix), ConfineError);
});

test('resolveUnit: symlinks that leave the unit are refused', () => {
  const { root, prefix } = tree();
  symlinkSync(path.join(prefix, 'delo-b'), path.join(prefix, 'delo-link'));
  symlinkSync(path.join(prefix, 'delo-b'), path.join(prefix, 'delo-a/inner'));
  symlinkSync(root, path.join(prefix, 'delo-a/toroot'));
  assert.throws(() => resolveUnit(path.join(prefix, 'delo-link'), prefix), /symlink/);
  assert.throws(() => resolveUnit(path.join(prefix, 'delo-a/inner'), prefix), /symlink/);
  assert.throws(() => resolveUnit(path.join(prefix, 'delo-a/toroot'), prefix), ConfineError);
});

test('resolveUnit: a symlinked prefix itself is fine', () => {
  const { root, prefix } = tree();
  const alias = path.join(root, 'alias');
  symlinkSync(prefix, alias);
  const unit = resolveUnit(path.join(alias, 'delo-a'), alias);
  assert.equal(unit.unitDir, path.join(prefix, 'delo-a'));
});

test('unitKey: distinct units never share a key; the real prefix is part of it', () => {
  const { prefix, root } = tree();
  const elsewhere = path.join(root, 'other-projects');
  mkdirSync(elsewhere);
  assert.notEqual(unitKey('delo-a', prefix), unitKey('delo-a', elsewhere));
  const alias = path.join(root, 'alias');
  symlinkSync(prefix, alias);
  assert.equal(unitKey('delo-a', alias), unitKey('delo-a', prefix)); // the REAL prefix counts
  assert.notEqual(unitKey('_personal/u1', prefix), unitKey('_personal__u1', prefix));
  assert.match(unitKey('delo-a', prefix), /^delo-a-[0-9a-f]{32}$/);
  assert.match(unitKey('_personal/u1', prefix), /^_personal__u1-[0-9a-f]{32}$/);
});

test('buildBwrapArgs: hides prefix and home, binds only the unit and its codex home', () => {
  const args = buildBwrapArgs({
    unitDir: '/srv/legal/projects/delo-a',
    prefix: '/srv/legal/projects',
    cwd: '/srv/legal/projects/delo-a/sub',
    home: '/home/legal-ai',
    codexHome: '/home/legal-ai/.codex-units/delo-a-1',
    scratch: '/home/legal-ai/.codex-scratch/delo-a-1',
    roHome: ['/home/legal-ai/.npm'],
    hide: ['/etc/cc-remote'],
  });
  const line = args.join(' ');
  assert.ok(line.startsWith('--ro-bind / / --dev /dev --proc /proc --tmpfs /tmp --tmpfs /run '));
  const at = (needle: string) => line.indexOf(needle);
  // order: binds of prefix/unit/codexHome, THEN the hide masks, THEN the read-only exceptions
  assert.ok(at('--tmpfs /home/legal-ai') < at('--bind /home/legal-ai/.codex-units/delo-a-1'));
  assert.ok(at('--bind /home/legal-ai/.codex-units/delo-a-1') < at('--tmpfs /etc/cc-remote'));
  assert.ok(at('--tmpfs /etc/cc-remote') < at('--ro-bind /home/legal-ai/.codex-scratch/delo-a-1'));
  assert.ok(at('--tmpfs /etc/cc-remote') < at('--ro-bind /home/legal-ai/.npm'));
  assert.ok(line.includes('--ro-bind /home/legal-ai/.npm /home/legal-ai/.npm'));
  assert.ok(line.includes('--tmpfs /etc/cc-remote'));
  // order: prefix is blanked BEFORE the unit is bound back
  assert.ok(line.indexOf('--tmpfs /srv/legal/projects') < line.indexOf('--bind /srv/legal/projects/delo-a /srv/legal/projects/delo-a'));
  assert.ok(line.includes('--bind /home/legal-ai/.codex-units/delo-a-1 /home/legal-ai/.codex-units/delo-a-1'));
  assert.ok(line.includes('--chdir /srv/legal/projects/delo-a/sub --die-with-parent --unshare-pid --new-session'));
  // exactly two read-write binds, nothing of delo-b
  assert.equal(args.filter((a) => a === '--bind').length, 2);
  assert.ok(!line.includes('delo-b'));
});

test('prepareConfinement + confinedCommand: seeds a private CODEX_HOME and composes the argv', async () => {
  const { prefix, home } = tree();
  const base = path.join(home, '.codex');
  writeFileSync(path.join(base, 'config.toml'), 'model = "x"\n');
  writeFileSync(path.join(base, 'auth.json'), '{"k":1}');
  mkdirSync(path.join(base, 'skills', 's'), { recursive: true });
  writeFileSync(path.join(base, 'skills', 's', 'SKILL.md'), 'hi');
  writeFileSync(path.join(base, 'config.secret-other'), 'no');
  const c = await prepareConfinement(path.join(prefix, 'delo-a/sub'), {
    prefix,
    home,
    baseCodexHome: base,
    env: { CC_REMOTE_BWRAP: '/usr/bin/bwrap' },
  });
  assert.ok(c);
  assert.equal(c.codexHome, unitCodexHome('delo-a', home, prefix));
  const { readFileSync, existsSync, statSync } = await import('node:fs');
  assert.equal(readFileSync(path.join(c.codexHome, 'config.toml'), 'utf8'), 'model = "x"\n');
  assert.equal(readFileSync(path.join(c.codexHome, 'auth.json'), 'utf8'), '{"k":1}');
  assert.ok(existsSync(path.join(c.codexHome, 'skills', 's', 'SKILL.md')));
  assert.ok(!existsSync(path.join(c.codexHome, 'config.secret-other')));
  assert.equal(statSync(c.codexHome).mode & 0o777, 0o700);
  const [file, args] = confinedCommand(c, '/usr/bin/codex', ['app-server']);
  assert.equal(file, '/usr/bin/bwrap');
  assert.deepEqual(args.slice(-3), ['--', '/usr/bin/codex', 'app-server']);
  assert.ok(args.includes('--chdir'));
  // another matter gets another home
  const other = await prepareConfinement(path.join(prefix, 'delo-b'), { prefix, home, baseCodexHome: base, env: {} });
  assert.notEqual(other!.codexHome, c.codexHome);
});

test('prepareConfinement: off without the env, refuses outside the prefix when on', async () => {
  const { prefix, home } = tree();
  assert.equal(await prepareConfinement(prefix, { env: {}, home }), undefined);
  await assert.rejects(prepareConfinement('/etc', { prefix, home, env: {} }), ConfineError);
});

test('rollout discovery includes unit homes only when confinement is on', async () => {
  const { home } = tree();
  const base = path.join(home, '.codex');
  mkdirSync(path.join(home, '.codex-units', 'delo-a-1', 'sessions'), { recursive: true });
  mkdirSync(path.join(home, '.codex-units', 'delo-b-2', 'sessions'), { recursive: true });
  assert.deepEqual(codexSessionRoots(base, false, home), [path.join(base, 'sessions')]);
  assert.deepEqual(codexSessionRoots(base, true, home).sort(), [
    path.join(base, 'sessions'),
    path.join(home, '.codex-units', 'delo-a-1', 'sessions'),
    path.join(home, '.codex-units', 'delo-b-2', 'sessions'),
  ].sort());
});

test('listRollouts finds unit rollouts (CC_REMOTE_CONFINE_RUNS on) and nothing extra when off', async () => {
  const { home, prefix } = tree();
  const savedHome = process.env['HOME'];
  const saved = { c: process.env['CODEX_HOME'], r: process.env['CC_REMOTE_CONFINE_RUNS'] };
  process.env['HOME'] = home;
  process.env['CODEX_HOME'] = path.join(home, '.codex');
  const uuid = '11111111-2222-3333-4444-555555555555';
  const day = path.join(home, '.codex-units', unitKey('delo-a', prefix), 'sessions', '2026', '10', '21');
  mkdirSync(day, { recursive: true });
  writeFileSync(path.join(day, `rollout-2026-10-21T00-00-00-${uuid}.jsonl`), metaLine(uuid, path.join(prefix, 'delo-a')));
  try {
    const { findCodexTranscript } = await import('../src/codex.js');
    delete process.env['CC_REMOTE_CONFINE_RUNS'];
    // os.homedir() reads HOME on posix
    assert.equal(await findCodexTranscript(uuid), null);
    process.env['CC_REMOTE_CONFINE_RUNS'] = prefix;
    assert.equal(path.basename((await findCodexTranscript(uuid))!), `rollout-2026-10-21T00-00-00-${uuid}.jsonl`);
  } finally {
    if (savedHome === undefined) delete process.env['HOME']; else process.env['HOME'] = savedHome;
    if (saved.c === undefined) delete process.env['CODEX_HOME']; else process.env['CODEX_HOME'] = saved.c;
    if (saved.r === undefined) delete process.env['CC_REMOTE_CONFINE_RUNS']; else process.env['CC_REMOTE_CONFINE_RUNS'] = saved.r;
  }
});

test('resume stays in the same unit: the same cwd maps to the same home; foreign rollouts are refused', async () => {
  const { prefix, home } = tree();
  const one = resolveUnit(path.join(prefix, 'delo-a'), prefix);
  const two = resolveUnit(path.join(prefix, 'delo-a/sub'), prefix);
  assert.equal(unitCodexHome(one.rel, home, prefix), unitCodexHome(two.rel, home, prefix));
  const mine = unitCodexHome('delo-a', home, prefix);
  assert.doesNotThrow(() => assertRolloutInUnit(path.join(mine, 'sessions/2026/10/21/rollout-x.jsonl'), mine));
  assert.doesNotThrow(() => assertRolloutInUnit(null, mine));
  assert.throws(() => assertRolloutInUnit(path.join(unitCodexHome('delo-b', home, prefix), 'sessions/r.jsonl'), mine), ConfineError);
  assert.throws(() => assertRolloutInUnit(path.join(home, '.codex/sessions/r.jsonl'), mine), ConfineError);
});

const bwrapOk = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', 'true']).status === 0;
test('real bwrap: sibling matter and home are invisible (skipped without bwrap)', { skip: !bwrapOk }, async () => {
  const { prefix, home } = tree();
  writeFileSync(path.join(prefix, 'delo-b', 'secret.txt'), 'S');
  writeFileSync(path.join(prefix, 'delo-a', 'mine.txt'), 'M');
  const c = await prepareConfinement(path.join(prefix, 'delo-a'), { prefix, home, baseCodexHome: path.join(home, '.codex'), env: {} });
  const [file, args] = confinedCommand(c!, '/bin/sh', ['-c', 'cat mine.txt; ls ' + path.join(prefix, 'delo-b') + ' 2>&1; ls ' + home + '/.codex 2>&1; ls /run 2>&1']);
  const r = spawnSync(file, args, { encoding: 'utf8' });
  assert.match(r.stdout, /^M/);
  assert.ok(!r.stdout.includes('secret.txt'));
  // host sockets under /run (user bus, docker.sock) are not reachable
  assert.ok(!/\b(user|dbus|docker.sock|containerd)\b/.test(r.stdout), r.stdout);
});

test('a codex binary under $HOME is refused unless CC_REMOTE_CONFINE_RO_HOME names it', async () => {
  const { prefix, home } = tree();
  const bin = path.join(home, '.local', 'bin', 'codex');
  mkdirSync(path.dirname(bin), { recursive: true });
  writeFileSync(bin, '#!/bin/sh\n');
  const base = path.join(home, '.codex');
  const bare = await prepareConfinement(path.join(prefix, 'delo-a'), { prefix, home, baseCodexHome: base, env: {} });
  assert.throws(() => confinedCommand(bare!, bin, []), /CC_REMOTE_CONFINE_RO_HOME/);
  const named = await prepareConfinement(path.join(prefix, 'delo-a'), {
    prefix, home, baseCodexHome: base, env: { CC_REMOTE_CONFINE_RO_HOME: path.dirname(bin) },
  });
  const [, args] = confinedCommand(named!, bin, []);
  assert.ok(args.join(' ').includes(`--ro-bind ${path.dirname(bin)} ${path.dirname(bin)}`));
  assert.ok(!args.join(' ').includes(path.join(home, '.local', 'share')));
});

test('CC_REMOTE_CONFINE_RO_HOME cannot re-expose the base CODEX_HOME or other units', async () => {
  const { prefix, home } = tree();
  const base = path.join(home, '.codex');
  mkdirSync(base, { recursive: true });
  // seed one unit first so ~/.codex-units exists
  await prepareConfinement(path.join(prefix, 'delo-b'), { prefix, home, baseCodexHome: base, env: {} });
  for (const ro of [base, path.join(home, '.codex-units')]) {
    await assert.rejects(
      prepareConfinement(path.join(prefix, 'delo-a'), {
        prefix, home, baseCodexHome: base, env: { CC_REMOTE_CONFINE_RO_HOME: ro },
      }),
      /overlaps/,
      ro,
    );
  }
});

test('CC_REMOTE_CONFINE_RO_HOME cannot remount the prefix or a sibling matter, even through a HOME alias', async () => {
  const { root } = tree();
  const realHome = path.join(root, 'realhome');
  const home = path.join(root, 'homelink');
  mkdirSync(realHome, { recursive: true });
  symlinkSync(realHome, home);
  const prefix = path.join(home, 'projects');
  mkdirSync(path.join(prefix, 'delo-a'), { recursive: true });
  mkdirSync(path.join(prefix, 'delo-b'), { recursive: true });
  const base = path.join(home, '.codex');
  mkdirSync(base, { recursive: true });
  await prepareConfinement(path.join(prefix, 'delo-b'), { prefix, home, baseCodexHome: base, env: {} });
  const alias = path.join(home, 'tools');
  symlinkSync(path.join(realHome, '.codex-units'), alias);
  for (const ro of [prefix, path.join(prefix, 'delo-b'), alias]) {
    await assert.rejects(
      prepareConfinement(path.join(prefix, 'delo-a'), { prefix, home, baseCodexHome: base, env: { CC_REMOTE_CONFINE_RO_HOME: ro } }),
      /overlaps/,
      ro,
    );
  }
});

test('seeding never writes through symlinks planted in the unit home', async () => {
  const { prefix, home, root } = tree();
  const base = path.join(home, '.codex');
  writeFileSync(path.join(base, 'auth.json'), '{"k":1}');
  writeFileSync(path.join(base, 'config.toml'), 'a=1\n');
  mkdirSync(path.join(base, 'skills'), { recursive: true });
  const victim = path.join(root, 'victim');
  mkdirSync(victim);
  const unitHome = unitCodexHome('delo-a', home, prefix);
  mkdirSync(unitHome, { recursive: true });
  symlinkSync(path.join(victim, 'stolen-auth'), path.join(unitHome, 'auth.json'));
  symlinkSync(path.join(victim, 'cfg'), path.join(unitHome, 'config.toml'));
  symlinkSync(victim, path.join(unitHome, 'skills'));
  symlinkSync(victim, path.join(unitHome, 'sessions'));
  await prepareConfinement(path.join(prefix, 'delo-a'), { prefix, home, baseCodexHome: base, env: {} });
  const { readdirSync, lstatSync, readFileSync } = await import('node:fs');
  assert.deepEqual(readdirSync(victim), []);
  assert.ok(lstatSync(path.join(unitHome, 'auth.json')).isFile());
  assert.equal(readFileSync(path.join(unitHome, 'auth.json'), 'utf8'), '{"k":1}');
  assert.ok(lstatSync(path.join(unitHome, 'sessions')).isDirectory());
});

test('a pre-planted symlink as unit home or units root is refused; auth follows the base', async () => {
  const { prefix, home, root } = tree();
  const base = path.join(home, '.codex');
  writeFileSync(path.join(base, 'auth.json'), '{"k":1}');
  const other = path.join(root, 'other-home');
  mkdirSync(other);
  mkdirSync(path.join(home, '.codex-units'), { recursive: true });
  symlinkSync(other, unitCodexHome('delo-a', home, prefix));
  const fs = await import('node:fs');
  // a home that is a planted symlink has no valid owner marker: it is quarantined,
  // never followed, and a fresh real home takes its place
  const first = await prepareConfinement(path.join(prefix, 'delo-a'), { prefix, home, baseCodexHome: base, env: {} });
  assert.ok(fs.lstatSync(first!.codexHome).isDirectory());
  assert.deepEqual(fs.readdirSync(other), []);
  fs.rmSync(first!.codexHome, { recursive: true });
  symlinkSync(other, first!.codexHome); // swapped again after the marker exists
  const again = await prepareConfinement(path.join(prefix, 'delo-a'), { prefix, home, baseCodexHome: base, env: {} }).catch((e) => e);
  assert.ok(again instanceof ConfineError, 'a symlinked home with a valid marker is refused');
  fs.rmSync(first!.codexHome);
  const c = await prepareConfinement(path.join(prefix, 'delo-a'), { prefix, home, baseCodexHome: base, env: {} });
  assert.ok(fs.existsSync(path.join(c!.codexHome, 'auth.json')));
  assert.ok(c!.scratch.startsWith(path.join(home, '.codex-scratch')));
  assert.ok(!c!.scratch.startsWith(c!.codexHome));
  // base logged out: the unit's copy goes too
  fs.rmSync(path.join(base, 'auth.json'));
  await prepareConfinement(path.join(prefix, 'delo-a'), { prefix, home, baseCodexHome: base, env: {} });
  assert.ok(!fs.existsSync(path.join(c!.codexHome, 'auth.json')));
});

test('inventory: forged cwd and cross-unit duplicate ids are dropped, own sessions kept', async () => {
  const { home, prefix } = tree();
  const saved = { h: process.env['HOME'], c: process.env['CODEX_HOME'], r: process.env['CC_REMOTE_CONFINE_RUNS'] };
  process.env['HOME'] = home;
  process.env['CODEX_HOME'] = path.join(home, '.codex');
  process.env['CC_REMOTE_CONFINE_RUNS'] = prefix;
  const write = (unit: string, id: string, cwd: string) => {
    const dir = path.join(unitCodexHome(unit, home), 'sessions', '2026', '10', '21');
    mkdirSync(dir, { recursive: true });
    const meta = JSON.stringify({ timestamp: '2026-10-21T00:00:00Z', type: 'session_meta', payload: { id, cwd } });
    const user = JSON.stringify({ timestamp: '2026-10-21T00:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } });
    writeFileSync(path.join(dir, `rollout-2026-10-21T00-00-00-${id}.jsonl`), `${meta}\n${user}\n`);
  };
  const own = '51111111-2222-3333-4444-555555555555';
  const forged = '52222222-2222-3333-4444-555555555555';
  const dup = '53333333-2222-3333-4444-555555555555';
  write('delo-a', own, path.join(prefix, 'delo-a/sub'));
  write('delo-a', forged, path.join(prefix, 'delo-b')); // A's sandbox claims B's cwd
  write('delo-a', dup, path.join(prefix, 'delo-a'));
  write('delo-b', dup, path.join(prefix, 'delo-b'));
  try {
    const { scanCodexSessions, findCodexTranscript } = await import('../src/codex.js');
    const ids = (await scanCodexSessions()).map((x) => x.sessionId);
    assert.deepEqual(ids, [own]);
    await assert.rejects(findCodexTranscript(dup), ConfineError); // ambiguous = error, never "empty"
    assert.ok(await findCodexTranscript(own));
  } finally {
    for (const [k, v] of [['HOME', saved.h], ['CODEX_HOME', saved.c], ['CC_REMOTE_CONFINE_RUNS', saved.r]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('a CODEX_HOME outside $HOME is blanked in the sandbox', async () => {
  const { prefix, home, root } = tree();
  const external = path.join(root, 'var-lib-codex');
  mkdirSync(external);
  writeFileSync(path.join(external, 'auth.json'), '{}');
  const c = await prepareConfinement(path.join(prefix, 'delo-a'), { prefix, home, baseCodexHome: external, env: {} });
  assert.ok(c!.plan.hide.includes(external));
  const inside = await prepareConfinement(path.join(prefix, 'delo-a'), { prefix, home, baseCodexHome: path.join(home, '.codex'), env: {} });
  assert.ok(!inside!.plan.hide.includes(path.join(home, '.codex')));
});

async function withConfineEnv<T>(home: string, prefix: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = { h: process.env['HOME'], c: process.env['CODEX_HOME'], r: process.env['CC_REMOTE_CONFINE_RUNS'] };
  process.env['HOME'] = home;
  process.env['CODEX_HOME'] = path.join(home, '.codex');
  if (prefix) process.env['CC_REMOTE_CONFINE_RUNS'] = prefix; else delete process.env['CC_REMOTE_CONFINE_RUNS'];
  try {
    return await fn();
  } finally {
    for (const [k, v] of [['HOME', saved.h], ['CODEX_HOME', saved.c], ['CC_REMOTE_CONFINE_RUNS', saved.r]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

function plant(home: string, unit: string, id: string, cwd: string): string {
  const dir = path.join(unitCodexHome(unit, home), 'sessions', '2026', '10', '21');
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `rollout-2026-10-21T00-00-00-${id}.jsonl`);
  writeFileSync(f, metaLine(id, cwd));
  return f;
}

test('openRollout refuses a file swapped for a symlink, or a dir component swapped, after discovery', async () => {
  const { home, prefix, root } = tree();
  await withConfineEnv(home, prefix, async () => {
    const { openRollout } = await import('../src/confine.js');
    const idA = '61111111-2222-3333-4444-555555555555';
    const idB = '62222222-2222-3333-4444-555555555555';
    const a = plant(home, 'delo-a', idA, path.join(prefix, 'delo-a'));
    const b = plant(home, 'delo-b', idB, path.join(prefix, 'delo-b'));
    const fs = await import('node:fs');
    await (await openRollout(a)).close(); // honest file opens
    // 1. the file itself becomes a symlink to B's rollout
    fs.rmSync(a);
    symlinkSync(b, a);
    await assert.rejects(openRollout(a), ConfineError);
    // 2. a date directory becomes a symlink to B's day dir
    fs.rmSync(a);
    const dayA = path.dirname(a);
    fs.rmSync(dayA, { recursive: true });
    symlinkSync(path.dirname(b), dayA);
    writeFileSync(path.join(root, 'noop'), '');
    await assert.rejects(openRollout(path.join(dayA, path.basename(b))), ConfineError);
    // 3. the whole sessions dir becomes a symlink
    const sessionsA = path.join(unitCodexHome('delo-a', home, prefix), 'sessions');
    fs.rmSync(sessionsA, { recursive: true });
    symlinkSync(path.join(unitCodexHome('delo-b', home, prefix), 'sessions'), sessionsA);
    await assert.rejects(openRollout(path.join(sessionsA, '2026', '10', '21', path.basename(b))), ConfineError);
  });
});

test('duplicate ids: a fake in unit A cannot hide unit B\'s session', async () => {
  const { home, prefix } = tree();
  await withConfineEnv(home, prefix, async () => {
    const { findCodexTranscript, scanCodexSessions } = await import('../src/codex.js');
    const id = '71111111-2222-3333-4444-555555555555';
    const real = plant(home, 'delo-b', id, path.join(prefix, 'delo-b'));
    plant(home, 'delo-a', id, path.join(prefix, 'delo-b')); // fake claims B's cwd: mismatched home
    assert.equal(await findCodexTranscript(id), real);
    assert.deepEqual((await scanCodexSessions()).map((x) => x.sessionId), [id]);
    const id2 = '72222222-2222-3333-4444-555555555555';
    const real2 = plant(home, 'delo-b', id2, path.join(prefix, 'delo-b'));
    plant(home, 'delo-a', id2, path.join(prefix, 'delo-a')); // fake claims its own unit
    await assert.rejects(findCodexTranscript(id2), ConfineError); // ambiguous without a canonical cwd
    assert.equal(await findCodexTranscript(id2, path.join(prefix, 'delo-b', 'x')), real2); // canonical cwd decides
    assert.equal(await findCodexTranscript(id2, path.join(prefix, 'delo-a')) !== real2, true);
  });
});

test('confinement unset: nothing changes (plain open, base home only, no unit homes scanned)', async () => {
  const { home, prefix } = tree();
  await withConfineEnv(home, undefined, async () => {
    const { openRollout, codexSessionRoots: roots, assertRolloutPath } = await import('../src/confine.js');
    const { findCodexTranscript, listRollouts } = await import('../src/codex.js');
    const id = '81111111-2222-3333-4444-555555555555';
    const f = plant(home, 'delo-a', id, path.join(prefix, 'delo-a'));
    assert.deepEqual(roots(path.join(home, '.codex')), [path.join(home, '.codex', 'sessions')]);
    assert.deepEqual(await listRollouts(), []);
    assert.equal(await findCodexTranscript(id), null);
    // a symlinked file still opens exactly as plain open(path,'r') would
    const link = path.join(path.dirname(f), 'rollout-link.jsonl');
    symlinkSync(f, link);
    await (await openRollout(link)).close();
    await assertRolloutPath(link);
    // and a duplicate in the base home is returned first-hit, as before
    const baseDir = path.join(home, '.codex', 'sessions', '2026', '10', '21');
    mkdirSync(baseDir, { recursive: true });
    const base = path.join(baseDir, `rollout-2026-10-21T00-00-00-${id}.jsonl`);
    writeFileSync(base, '{}\n');
    assert.equal(await findCodexTranscript(id), base);
  });
});

test('unitScratchDir validates before any write and refuses a planted symlink', () => {
  const { prefix, home, root } = tree();
  const env = { CC_REMOTE_CONFINE_RUNS: prefix };
  assert.equal(unitScratchDir(path.join(prefix, 'delo-a'), {}, home), undefined);
  const ok = unitScratchDir(path.join(prefix, 'delo-a'), env, home);
  assert.ok(ok?.startsWith(path.join(home, '.codex-scratch')));
  const fs = require_fs();
  fs.rmSync(ok!, { recursive: true });
  const victim = path.join(root, 'victim2');
  mkdirSync(victim);
  symlinkSync(victim, ok!);
  assert.equal(unitScratchDir(path.join(prefix, 'delo-a'), env, home), undefined);
  assert.deepEqual(fs.readdirSync(victim), []);
});

test('deleting a session id removes rollouts of ONE unit only', async () => {
  const { home, prefix } = tree();
  const saved = { h: process.env['HOME'], c: process.env['CODEX_HOME'], r: process.env['CC_REMOTE_CONFINE_RUNS'] };
  process.env['HOME'] = home;
  process.env['CODEX_HOME'] = path.join(home, '.codex');
  process.env['CC_REMOTE_CONFINE_RUNS'] = prefix;
  const id = '44444444-2222-3333-4444-555555555555';
  const mk = (unit: string, stamp: string) => {
    const dir = path.join(unitCodexHome(unit, home), 'sessions', '2026', '10', '21');
    mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `rollout-2026-10-21T00-00-0${stamp}-${id}.jsonl`);
    writeFileSync(f, metaLine(id, path.join(prefix, unit)));
    return f;
  };
  const a = mk('delo-a', '1');
  const b = mk('delo-b', '2');
  const { utimesSync, existsSync } = await import('node:fs');
  utimesSync(b, new Date(), new Date(Date.now() + 5000)); // b is newest
  try {
    const { deleteCodexSession } = await import('../src/codex.js');
    const trash = path.join(home, 'trash');
    await assert.rejects(deleteCodexSession(id, trash), ConfineError); // ambiguous without the canonical cwd
    const r = await deleteCodexSession(id, trash, path.join(prefix, 'delo-b'));
    assert.equal(r.removed, 1);
    assert.ok(!existsSync(b));
    assert.ok(existsSync(a));
  } finally {
    for (const [k, v] of [['HOME', saved.h], ['CODEX_HOME', saved.c], ['CC_REMOTE_CONFINE_RUNS', saved.r]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('a symlinked rollout in a unit home is not discovered', async () => {
  const { home, prefix } = tree();
  const saved = { h: process.env['HOME'], c: process.env['CODEX_HOME'], r: process.env['CC_REMOTE_CONFINE_RUNS'] };
  process.env['HOME'] = home;
  process.env['CODEX_HOME'] = path.join(home, '.codex');
  process.env['CC_REMOTE_CONFINE_RUNS'] = prefix;
  const uuidB = '22222222-2222-3333-4444-555555555555';
  const uuidA = '33333333-2222-3333-4444-555555555555';
  const dayB = path.join(unitCodexHome('delo-b', home, prefix), 'sessions', '2026', '10', '21');
  const dayA = path.join(unitCodexHome('delo-a', home, prefix), 'sessions', '2026', '10', '21');
  mkdirSync(dayB, { recursive: true });
  mkdirSync(dayA, { recursive: true });
  const foreign = path.join(dayB, `rollout-2026-10-21T00-00-00-${uuidB}.jsonl`);
  writeFileSync(foreign, metaLine(uuidB, path.join(prefix, 'delo-b')));
  symlinkSync(foreign, path.join(dayA, `rollout-2026-10-21T00-00-00-${uuidA}.jsonl`));
  try {
    const { findCodexTranscript } = await import('../src/codex.js');
    assert.equal(await findCodexTranscript(uuidA), null);
    assert.ok(await findCodexTranscript(uuidB));
  } finally {
    for (const [k, v] of [['HOME', saved.h], ['CODEX_HOME', saved.c], ['CC_REMOTE_CONFINE_RUNS', saved.r]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
