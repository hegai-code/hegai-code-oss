import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ConfineError,
  buildBwrapArgs,
  confinedCommand,
  prepareConfinement,
  unitCodexHome,
  unitsRoot,
  listUnitCodexHomes,
  unitsWatchIgnored,
} from '../src/confine.js';

function metaLine(id: string, cwd: string): string {
  return `${JSON.stringify({ timestamp: '2026-10-21T00:00:00Z', type: 'session_meta', payload: { id, cwd } })}\n`;
}

function tree() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ccr-hard-')));
  const prefix = path.join(root, 'projects');
  const home = path.join(root, 'home');
  for (const d of ['delo-a/sub', 'delo-b']) mkdirSync(path.join(prefix, d), { recursive: true });
  mkdirSync(path.join(home, '.codex'), { recursive: true });
  return { root, prefix, home };
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

function plant(home: string, unit: string, id: string, cwd: string): string {
  const dir = path.join(unitCodexHome(unit, home), 'sessions', '2026', '10', '21');
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `rollout-2026-10-21T00-00-00-${id}.jsonl`);
  writeFileSync(f, metaLine(id, cwd));
  return f;
}

// ---- 1. layouts where agent secrets sit inside the prefix are refused; mount order

test('agent state dir or base CODEX_HOME under (or around) the prefix is refused', async () => {
  const { prefix, home } = tree();
  const base = path.join(home, '.codex');
  const state = path.join(prefix, 'delo-a', '.agent-state');
  mkdirSync(state, { recursive: true });
  await withEnv({ CC_REMOTE_STATE_DIR: state }, async () => {
    await assert.rejects(prepareConfinement(path.join(prefix, 'delo-a'), { prefix, home, baseCodexHome: base, env: {} }), /state dir/);
  });
  await withEnv({ CC_REMOTE_STATE_DIR: path.join(home, '.cc-state') }, async () => {
    const inside = path.join(prefix, 'codex-base');
    mkdirSync(inside);
    await assert.rejects(prepareConfinement(path.join(prefix, 'delo-a'), { prefix, home, baseCodexHome: inside, env: {} }), /base CODEX_HOME/);
    // state that CONTAINS the prefix would hide it entirely
    await withEnv({ CC_REMOTE_STATE_DIR: path.dirname(prefix) }, async () => {
      await assert.rejects(prepareConfinement(path.join(prefix, 'delo-a'), { prefix, home, baseCodexHome: base, env: {} }), ConfineError);
    });
    // HOME under the prefix
    await assert.rejects(prepareConfinement(path.join(prefix, 'delo-a'), { prefix, home: path.join(prefix, 'h'), baseCodexHome: base, env: {} }), /HOME/);
  });
});

test('a mask that would cover a bound path is refused by the builder; masks come after the binds', () => {
  const plan = {
    unitDir: '/srv/legal/projects/delo-a', prefix: '/srv/legal/projects', cwd: '/srv/legal/projects/delo-a',
    home: '/home/u', codexHome: '/home/u/.codex-units/k', scratch: '/home/u/.codex-scratch/k', roHome: [] as string[], hide: ['/srv'],
  };
  assert.throws(() => buildBwrapArgs(plan), ConfineError);
  assert.throws(() => buildBwrapArgs({ ...plan, hide: ['/home/u/.codex-units'] }), ConfineError);
  const ok = buildBwrapArgs({ ...plan, hide: ['/var/lib/codex', '/etc/cc-remote'] });
  const line = ok.join(' ');
  assert.ok(line.indexOf('--bind /home/u/.codex-units/k') < line.indexOf('--tmpfs /var/lib/codex'));
});

// ---- 2. staging lives outside every sandbox; modes via descriptor

test('seeding stages in unitsRoot, leaves nothing behind, and staging dirs are not unit homes', async () => {
  const { prefix, home } = tree();
  const base = path.join(home, '.codex');
  writeFileSync(path.join(base, 'auth.json'), '{"k":1}');
  writeFileSync(path.join(base, 'config.toml'), 'a=1\n');
  mkdirSync(path.join(base, 'skills', 's'), { recursive: true });
  writeFileSync(path.join(base, 'skills', 's', 'SKILL.md'), 'v1');
  const c = await prepareConfinement(path.join(prefix, 'delo-a'), { prefix, home, baseCodexHome: base, env: {} });
  // nothing staged inside the home, nothing left in unitsRoot except the homes
  assert.deepEqual(nodeFs.readdirSync(c!.codexHome).filter((n) => /\.(tmp|new|old)$/.test(n)), []);
  assert.deepEqual(nodeFs.readdirSync(unitsRoot(home)).filter((n) => n.startsWith('.')), []);
  assert.equal(nodeFs.statSync(path.join(c!.codexHome, 'auth.json')).mode & 0o777, 0o600);
  // a leftover staging dir is never mistaken for a unit home
  mkdirSync(path.join(unitsRoot(home), '.stage-leftover'));
  assert.ok(!listUnitCodexHomes(home).some((h) => path.basename(h).startsWith('.')));
  // a swapped skills symlink is replaced, its target untouched
  const victim = path.join(home, 'victim');
  mkdirSync(victim);
  nodeFs.rmSync(path.join(c!.codexHome, 'skills'), { recursive: true });
  symlinkSync(victim, path.join(c!.codexHome, 'skills'));
  await prepareConfinement(path.join(prefix, 'delo-a'), { prefix, home, baseCodexHome: base, env: {} });
  assert.deepEqual(nodeFs.readdirSync(victim), []);
  assert.ok(nodeFs.lstatSync(path.join(c!.codexHome, 'skills')).isDirectory());
});

// ---- 3. delete only when the unit has no live run; the sandbox leaves no writers behind

test('delete is refused while a run is live in the same unit, allowed for another unit', async () => {
  const { home, prefix } = tree();
  await withEnv({ HOME: home, CODEX_HOME: path.join(home, '.codex'), CC_REMOTE_CONFINE_RUNS: prefix }, async () => {
    const { deleteCodexSession } = await import('../src/codex.js');
    const id = 'd1111111-2222-3333-4444-555555555555';
    const cwdA = path.join(prefix, 'delo-a');
    const file = plant(home, 'delo-a', id, cwdA);
    const trash = path.join(home, 'trash');
    await assert.rejects(deleteCodexSession(id, trash, cwdA, [path.join(prefix, 'delo-a', 'sub')]), /сейчас работают/);
    assert.ok(nodeFs.existsSync(file));
    // a live run in ANOTHER matter does not block it
    const r = await deleteCodexSession(id, trash, cwdA, [path.join(prefix, 'delo-b')]);
    assert.equal(r.removed, 1);
    assert.ok(!nodeFs.existsSync(file));
  });
});

const bwrapOk = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', 'true']).status === 0;
test('once the confined command exits, nothing of the run survives (--unshare-pid)', { skip: !bwrapOk }, async () => {
  const { prefix, home } = tree();
  const c = await prepareConfinement(path.join(prefix, 'delo-a'), { prefix, home, baseCodexHome: path.join(home, '.codex'), env: {} });
  const marker = String(300000 + (process.pid % 90000)); // a unique sleep duration
  const [file, args] = confinedCommand(c!, '/bin/sh', ['-c', `sleep ${marker} & sleep ${marker} & exit 0`]);
  const child = spawn(file, args, { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const left = spawnSync('pgrep', ['-f', `sleep ${marker}`], { encoding: 'utf8' });
  assert.equal(left.stdout.trim(), '', 'background processes of an exited run must be gone');
});

test('a refused layout has no side effects: nothing is seeded, no unit home is created', async () => {
  const { prefix, home } = tree();
  const base = path.join(prefix, 'codex-base');
  mkdirSync(base);
  writeFileSync(path.join(base, 'auth.json'), '{"secret":1}');
  await assert.rejects(prepareConfinement(path.join(prefix, 'delo-a'), { prefix, home, baseCodexHome: base, env: {} }), ConfineError);
  assert.equal(nodeFs.existsSync(unitsRoot(home)), false);
  assert.equal(nodeFs.existsSync(path.join(home, '.codex-scratch')), false);
});

test('removing config, AGENTS.md, skills or auth at the base removes the unit copies', async () => {
  const { prefix, home } = tree();
  const base = path.join(home, '.codex');
  for (const n of ['config.toml', 'AGENTS.md', 'auth.json']) writeFileSync(path.join(base, n), 'x');
  mkdirSync(path.join(base, 'skills', 's'), { recursive: true });
  writeFileSync(path.join(base, 'skills', 's', 'SKILL.md'), 'x');
  const run = () => prepareConfinement(path.join(prefix, 'delo-a'), { prefix, home, baseCodexHome: base, env: {} });
  const c = await run();
  for (const n of ['config.toml', 'AGENTS.md', 'auth.json', 'skills']) assert.ok(nodeFs.existsSync(path.join(c!.codexHome, n)), n);
  for (const n of ['config.toml', 'AGENTS.md', 'auth.json']) nodeFs.rmSync(path.join(base, n));
  nodeFs.rmSync(path.join(base, 'skills'), { recursive: true });
  await run();
  for (const n of ['config.toml', 'AGENTS.md', 'auth.json', 'skills']) assert.ok(!nodeFs.existsSync(path.join(c!.codexHome, n)), `${n} must be gone`);
});

test('RunManager: no run starts in a unit whose session is being deleted; other units and release are fine', async () => {
  const { RunManager } = await import('../src/run-manager.js');
  const { prefix } = tree();
  await withEnv({ CC_REMOTE_CONFINE_RUNS: prefix }, async () => {
    const sent: Array<Record<string, unknown>> = [];
    let created = 0;
    const fake = {
      completed: new Promise<void>(() => {}),
      sendInput() {}, async interrupt() {}, async setModel() {}, async setPermissionMode() {}, async setEffort() {}, close() {},
    };
    const manager = new RunManager({
      send: (m: Record<string, unknown>) => { sent.push(m); return true; },
      refreshInventory: () => {},
      scheduleInventory: () => {},
      claudeDisabled: true,
      createRun: () => { created += 1; return fake as never; },
    } as never);
    const release = manager.lockUnitForDelete(path.join(prefix, 'delo-a'));
    manager.startNew('r-a', path.join(prefix, 'delo-a', 'sub'));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(created, 0);
    assert.ok(sent.some((m) => m['state'] === 'error' && String(m['error']).includes('удаляется')));
    manager.startNew('r-b', path.join(prefix, 'delo-b'));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(created, 1);
    release();
    release(); // idempotent
    manager.startNew('r-a2', path.join(prefix, 'delo-a'));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(created, 2);
  });
});

test('a state dir symlinked from under $HOME is masked at its real location', async () => {
  const { prefix, home, root } = tree();
  const external = path.join(root, 'external-state');
  mkdirSync(external);
  const link = path.join(home, '.cc-remote');
  symlinkSync(external, link);
  await withEnv({ CC_REMOTE_STATE_DIR: link }, async () => {
    const c = await prepareConfinement(path.join(prefix, 'delo-a'), { prefix, home, baseCodexHome: path.join(home, '.codex'), env: {} });
    assert.ok(c!.plan.hide.includes(external), 'the symlink target must be masked');
  });
});

test('skills refresh sweeps its staging dir, first and second time', async () => {
  const { prefix, home } = tree();
  const base = path.join(home, '.codex');
  mkdirSync(path.join(base, 'skills', 's'), { recursive: true });
  writeFileSync(path.join(base, 'skills', 's', 'SKILL.md'), 'v1');
  const run = () => prepareConfinement(path.join(prefix, 'delo-a'), { prefix, home, baseCodexHome: base, env: {} });
  const c = await run();
  // staging is swept in the normal path - also on the SECOND refresh, when skills/ already exists
  assert.deepEqual(nodeFs.readdirSync(unitsRoot(home)).filter((n) => n.startsWith('.')), []);
  writeFileSync(path.join(base, 'skills', 's', 'SKILL.md'), 'v2');
  await run();
  assert.deepEqual(nodeFs.readdirSync(unitsRoot(home)).filter((n) => n.startsWith('.')), []);
  assert.equal(nodeFs.readFileSync(path.join(c!.codexHome, 'skills', 's', 'SKILL.md'), 'utf8'), 'v2');
});

test('a state dir outside $HOME with a per-run state file still yields a valid mount plan', async () => {
  const { prefix, home, root } = tree();
  const external = path.join(root, 'var-lib-ccr');
  await withEnv({ CC_REMOTE_STATE_DIR: external, CC_REMOTE_CONFINE_RUNS: prefix }, async () => {
    const rs = await import('../src/run-state.js');
    const file = rs.createRunState('rz', { userId: 'u' } as never);
    const c = await prepareConfinement(path.join(prefix, 'delo-a'), {
      prefix, home, baseCodexHome: path.join(home, '.codex'), env: { CC_REMOTE_CONFINE_RUNS: prefix }, runStateFile: file,
    });
    assert.ok(c!.plan.hide.includes(external));
    assert.ok(c!.plan.roHome.includes(path.dirname(file!)));
    const [, args] = confinedCommand(c!, '/bin/true', []); // must not throw
    const line = args.join(' ');
    assert.ok(line.indexOf(`--tmpfs ${external}`) < line.indexOf(`--ro-bind ${path.dirname(file!)}`));
  });
});

test('RunManager: a closed run whose process has not exited keeps its cwd active', async () => {
  const { RunManager } = await import('../src/run-manager.js');
  let exit!: () => void;
  const exited = new Promise<void>((r) => { exit = r; });
  const fake = {
    completed: new Promise<void>(() => {}), exited,
    sendInput() {}, async interrupt() {}, async setModel() {}, async setPermissionMode() {}, async setEffort() {}, close() {},
  };
  const manager = new RunManager({
    send: () => true, refreshInventory: () => {}, scheduleInventory: () => {}, claudeDisabled: true,
    createRun: () => fake as never,
  } as never);
  manager.startNew('r-dying', '/work/delo-x');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(manager.activeCwds(), ['/work/delo-x']);
  manager.end('r-dying', 'ended');
  assert.deepEqual(manager.activeCwds(), ['/work/delo-x'], 'process still alive: cwd stays active');
  exit();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(manager.activeCwds(), []);
});

test('owner marker: a home with a foreign or missing marker is quarantined, not reused', async () => {
  const { prefix, home, root } = tree();
  const base = path.join(home, '.codex');
  const run = (p = prefix) => prepareConfinement(path.join(p, 'delo-a'), { prefix: p, home, baseCodexHome: base, env: {} });
  const c = await run();
  const marker = `${c!.codexHome}.owner`;
  assert.ok(nodeFs.existsSync(marker), 'the marker sits NEXT TO the home, out of every sandbox');
  assert.deepEqual(JSON.parse(nodeFs.readFileSync(marker, 'utf8')), { prefix, rel: 'delo-a' });
  // a rollout the previous owner left behind
  const old = path.join(c!.codexHome, 'sessions', 'old.txt');
  writeFileSync(old, 'x');
  await run(); // same owner again: reused, content kept
  assert.ok(nodeFs.existsSync(old));
  // marker rewritten to someone else (e.g. the same key reached through another tree)
  writeFileSync(marker, JSON.stringify({ prefix: path.join(root, 'elsewhere'), rel: 'delo-a' }));
  const c2 = await run();
  assert.equal(c2!.codexHome, c!.codexHome);
  assert.ok(!nodeFs.existsSync(old), 'the foreign home was moved away');
  const quarantined = nodeFs.readdirSync(unitsRoot(home)).filter((n) => n.startsWith('.quarantine-'));
  assert.equal(quarantined.length, 1);
  assert.ok(nodeFs.existsSync(path.join(unitsRoot(home), quarantined[0]!, 'sessions', 'old.txt')));
  assert.deepEqual(JSON.parse(nodeFs.readFileSync(marker, 'utf8')), { prefix, rel: 'delo-a' });
  // a populated home with NO marker (unknown provenance) is quarantined too
  nodeFs.rmSync(marker);
  writeFileSync(path.join(c!.codexHome, 'sessions', 'mystery.txt'), 'x');
  await run();
  assert.ok(!nodeFs.existsSync(path.join(c!.codexHome, 'sessions', 'mystery.txt')));
  assert.equal(nodeFs.readdirSync(unitsRoot(home)).filter((n) => n.startsWith('.quarantine-')).length, 2);
  // and quarantine dirs are never mistaken for unit homes
  assert.ok(!listUnitCodexHomes(home).some((h) => path.basename(h).startsWith('.')));
});

test('resolver: a failed metadata read is an error, not "no such session"', async () => {
  const { home, prefix } = tree();
  await withEnv({ HOME: home, CODEX_HOME: path.join(home, '.codex'), CC_REMOTE_CONFINE_RUNS: prefix }, async () => {
    const cx = await import('../src/codex.js');
    const id = 'f1111111-2222-3333-4444-555555555555';
    const file = plant(home, 'delo-a', id, path.join(prefix, 'delo-a'));
    assert.equal(await cx.findCodexTranscript(id, path.join(prefix, 'delo-a')), file);
    nodeFs.chmodSync(file, 0); // listed fine (lstat), unreadable
    if (process.getuid?.() !== 0) {
      await assert.rejects(cx.findCodexTranscript(id, path.join(prefix, 'delo-a')), /EACCES/);
      await assert.rejects(cx.codexRolloutSize(id, path.join(prefix, 'delo-a')), /EACCES/);
    }
    nodeFs.chmodSync(file, 0o600);
    // a garbled but readable head is "not a session" (null), not an error
    writeFileSync(file, 'not json at all\n');
    assert.equal(await cx.findCodexTranscript(id, path.join(prefix, 'delo-a')), null);
  });
});

test('auth refresh does not trust the copy\'s own mtime', async () => {
  const { prefix, home } = tree();
  const base = path.join(home, '.codex');
  writeFileSync(path.join(base, 'auth.json'), '{"v":1}');
  const run = () => prepareConfinement(path.join(prefix, 'delo-a'), { prefix, home, baseCodexHome: base, env: {} });
  const c = await run();
  const copy = path.join(c!.codexHome, 'auth.json');
  writeFileSync(copy, '{"forged":true}');
  nodeFs.utimesSync(copy, new Date(Date.now() + 3_600_000), new Date(Date.now() + 3_600_000));
  writeFileSync(path.join(base, 'auth.json'), '{"v":2}');
  await run();
  assert.equal(nodeFs.readFileSync(copy, 'utf8'), '{"v":2}');
});

test('watcher filter: only <unit>/sessions/YYYY/MM/DD is entered', () => {
  const { home } = tree();
  const ign = unitsWatchIgnored(home);
  const u = unitsRoot(home);
  assert.equal(ign(u), false);
  assert.equal(ign(path.join(u, 'delo-a-1')), false);
  assert.equal(ign(path.join(u, 'delo-a-1', 'sessions')), false);
  assert.equal(ign(path.join(u, 'delo-a-1', 'sessions', '2026', '10', '21')), false);
  assert.equal(ign(path.join(u, 'delo-a-1', 'sessions', '2026', '10', '21', 'rollout-x.jsonl')), false);
  assert.equal(ign(path.join(u, 'delo-a-1', 'sessions', '2026', '10', '21', 'x', 'y')), true); // too deep
  for (const name of ['skills', 'scratch', 'auth.json', 'huge-link']) assert.equal(ign(path.join(u, 'delo-a-1', name)), true, name);
  assert.equal(ign(path.join(u, '.stage-abc')), true);
  assert.equal(ign(path.join(u, '.quarantine-x', 'sessions')), true);
  assert.equal(ign(path.join(u, 'delo-a-1.owner')), true);
  // the other watched roots (legacy sessions, projects) are not this filter's business
  assert.equal(ign(path.join(home, '.codex', 'sessions', '2026', '10', '21', 'rollout-x.jsonl')), false);
  assert.equal(ign(path.join(home, '.claude', 'projects')), false);
});

// ---- 4. discovery walks by hand

test('unit sessions: a symlinked sessions root is not traversed; symlinked dirs are not entered; depth is bounded', async () => {
  const { home, prefix, root } = tree();
  await withEnv({ HOME: home, CODEX_HOME: path.join(home, '.codex'), CC_REMOTE_CONFINE_RUNS: prefix }, async () => {
    const { listRollouts } = await import('../src/codex.js');
    const big = path.join(root, 'big-host-tree');
    const idBig = 'e1111111-2222-3333-4444-555555555555';
    mkdirSync(path.join(big, '2026', '10', '21'), { recursive: true });
    writeFileSync(path.join(big, '2026', '10', '21', `rollout-2026-10-21T00-00-00-${idBig}.jsonl`), metaLine(idBig, path.join(prefix, 'delo-a')));
    // unit delo-a: sessions IS a symlink to the host tree
    const homeA = unitCodexHome('delo-a', home, prefix);
    mkdirSync(homeA, { recursive: true });
    symlinkSync(big, path.join(homeA, 'sessions'));
    // unit delo-b: honest, plus a symlinked month dir and a too-deep file
    const idOk = 'e2222222-2222-3333-4444-555555555555';
    plant(home, 'delo-b', idOk, path.join(prefix, 'delo-b'));
    const sessB = path.join(unitCodexHome('delo-b', home, prefix), 'sessions');
    symlinkSync(big, path.join(sessB, '2027'));
    const deep = path.join(sessB, '2026', '10', '21', 'x', 'y');
    mkdirSync(deep, { recursive: true });
    const idDeep = 'e3333333-2222-3333-4444-555555555555';
    writeFileSync(path.join(deep, `rollout-2026-10-21T00-00-00-${idDeep}.jsonl`), metaLine(idDeep, path.join(prefix, 'delo-b')));
    const names = (await listRollouts()).map((f) => path.basename(f.filePath));
    assert.ok(names.some((n) => n.includes(idOk)));
    assert.ok(!names.some((n) => n.includes(idBig)), 'must not walk through a symlink');
    assert.ok(!names.some((n) => n.includes(idDeep)), 'depth is YYYY/MM/DD');
  });
});
