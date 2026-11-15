import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ConfineError,
  cwdBelongsToUnitHome,
  cwdUnitKey,
  prepareConfinement,
  unitCodexHome,
  unitKey,
} from '../src/confine.js';

function metaLine(id: string, cwd: string): string {
  return `${JSON.stringify({ timestamp: '2026-10-21T00:00:00Z', type: 'session_meta', payload: { id, cwd } })}\n`;
}

function tree() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ccr-resolver-')));
  const prefix = path.join(root, 'projects');
  const home = path.join(root, 'home');
  for (const d of ['delo-a/sub', 'delo-b']) mkdirSync(path.join(prefix, d), { recursive: true });
  mkdirSync(path.join(home, '.codex'), { recursive: true });
  return { root, prefix, home };
}

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

test('one resolver: delete, size, mtime and read pick the same copy; a double with a future mtime loses', async () => {
  const { home, prefix } = tree();
  await withConfineEnv(home, prefix, async () => {
    const cx = await import('../src/codex.js');
    const id = '44444444-2222-3333-4444-555555555555';
    const cwdA = path.join(prefix, 'delo-a');
    const cwdB = path.join(prefix, 'delo-b');
    const real = plant(home, 'delo-b', id, cwdB);
    const fake = plant(home, 'delo-a', id, cwdA); // self-consistent double
    nodeFs.utimesSync(fake, new Date(), new Date(Date.now() + 3_600_000)); // far-future mtime
    // no canonical cwd: ambiguous is an ERROR everywhere, never null / -1 / empty
    await assert.rejects(cx.findCodexTranscript(id), ConfineError);
    await assert.rejects(cx.codexRolloutSize(id), ConfineError);
    await assert.rejects(cx.codexRolloutMtime(id), ConfineError);
    await assert.rejects(cx.readCodexTranscript(id), ConfineError);
    await assert.rejects(cx.deleteCodexSession(id, path.join(home, 'trash0')), ConfineError);
    assert.ok(nodeFs.existsSync(real) && nodeFs.existsSync(fake));
    // with B's canonical cwd every entry point picks B's copy
    assert.equal(await cx.findCodexTranscript(id, cwdB), real);
    assert.equal(await cx.codexRolloutSize(id, cwdB), nodeFs.statSync(real).size);
    const mtime = await cx.codexRolloutMtime(id, cwdB);
    assert.ok(mtime !== undefined && mtime < Date.now() + 60_000, 'future mtime of the double must not leak');
    assert.notEqual(await cx.readCodexTranscript(id, cwdB), undefined);
    const r = await cx.deleteCodexSession(id, path.join(home, 'trash'), cwdB);
    assert.equal(r.removed, 1);
    assert.ok(!nodeFs.existsSync(real));
    assert.ok(nodeFs.existsSync(fake));
  });
});

test('a legacy cwd (outside any unit) is answered by the legacy ~/.codex copy only', async () => {
  const { home, prefix, root } = tree();
  await withConfineEnv(home, prefix, async () => {
    const { findCodexTranscript } = await import('../src/codex.js');
    const id = '45555555-2222-3333-4444-555555555555';
    plant(home, 'delo-a', id, path.join(prefix, 'delo-a'));
    const legacyDir = path.join(home, '.codex', 'sessions', '2026', '10', '21');
    mkdirSync(legacyDir, { recursive: true });
    const legacy = path.join(legacyDir, `rollout-2026-10-21T00-00-00-${id}.jsonl`);
    writeFileSync(legacy, metaLine(id, path.join(root, 'old-work')));
    assert.equal(await findCodexTranscript(id, path.join(root, 'old-work')), legacy);
  });
});

test('a cwd that is a symlink into another matter belongs to neither by record', () => {
  const { prefix } = tree();
  symlinkSync(path.join(prefix, 'delo-b'), path.join(prefix, 'delo-a', 'to-b'));
  assert.equal(cwdUnitKey(path.join(prefix, 'delo-a/sub'), prefix), unitKey('delo-a', prefix));
  assert.equal(cwdUnitKey(path.join(prefix, 'delo-a/to-b'), prefix), undefined);
  assert.equal(cwdUnitKey(path.join(prefix, 'delo-a/gone'), prefix), unitKey('delo-a', prefix)); // not on disk: nothing to disagree with
  assert.equal(cwdBelongsToUnitHome(path.join(prefix, 'delo-a/to-b'), unitKey('delo-a', prefix), prefix), false);
  assert.equal(cwdBelongsToUnitHome(path.join(prefix, 'delo-a/to-b'), unitKey('delo-b', prefix), prefix), false);
});

test('inventory drops a rollout whose recorded cwd is a symlink into another matter', async () => {
  const { home, prefix } = tree();
  symlinkSync(path.join(prefix, 'delo-b'), path.join(prefix, 'delo-a', 'to-b'));
  await withConfineEnv(home, prefix, async () => {
    const { scanCodexSessions } = await import('../src/codex.js');
    plant(home, 'delo-a', 'b1111111-2222-3333-4444-555555555555', path.join(prefix, 'delo-a', 'to-b'));
    plant(home, 'delo-a', 'b2222222-2222-3333-4444-555555555555', path.join(prefix, 'delo-a', 'sub'));
    assert.deepEqual((await scanCodexSessions()).map((x) => x.sessionId), ['b2222222-2222-3333-4444-555555555555']);
  });
});

test('subagent history: ambiguity is an error, a canonical cwd resolves; read goes through one descriptor', async () => {
  const { home, prefix } = tree();
  await withConfineEnv(home, prefix, async () => {
    const { loadCodexSubagentHistory } = await import('../src/codex-subagents.js');
    const id = '91111111-2222-3333-4444-555555555555';
    plant(home, 'delo-b', id, path.join(prefix, 'delo-b'));
    plant(home, 'delo-a', id, path.join(prefix, 'delo-a'));
    await assert.rejects(loadCodexSubagentHistory(id, 10), ConfineError);
    assert.deepEqual(await loadCodexSubagentHistory(id, 10, undefined, undefined, path.join(prefix, 'delo-b')), []);
  });
});

test('run state: confined runs get a per-run dir and only that dir enters the sandbox', async () => {
  const { home, prefix } = tree();
  const stateRoot = path.join(home, '.cc-remote-test');
  const saved = process.env['CC_REMOTE_STATE_DIR'];
  process.env['CC_REMOTE_STATE_DIR'] = stateRoot;
  try {
    const rs = await import('../src/run-state.js');
    delete process.env['CC_REMOTE_CONFINE_RUNS'];
    assert.equal(rs.runStatePath('r1'), path.join(stateRoot, 'run-state', 'r1.json')); // unset: unchanged
    process.env['CC_REMOTE_CONFINE_RUNS'] = prefix;
    const file = rs.createRunState('r1', { userId: 'u1' } as never);
    const other = rs.createRunState('r2', { userId: 'u2' } as never);
    assert.equal(file, path.join(stateRoot, 'run-state', 'r1', 'state.json'));
    assert.ok(file && other);
    const c = await prepareConfinement(path.join(prefix, 'delo-a'), {
      prefix, home, baseCodexHome: path.join(home, '.codex'), env: { CC_REMOTE_CONFINE_RUNS: prefix }, runStateFile: file,
    });
    assert.ok(c!.plan.roHome.includes(path.dirname(file)));
    assert.ok(!c!.plan.roHome.includes(path.join(stateRoot, 'run-state')));
    assert.ok(!c!.plan.roHome.includes(path.dirname(other)));
    rs.removeRunState('r1');
    assert.ok(!nodeFs.existsSync(path.dirname(file)));
  } finally {
    delete process.env['CC_REMOTE_CONFINE_RUNS'];
    if (saved === undefined) delete process.env['CC_REMOTE_STATE_DIR']; else process.env['CC_REMOTE_STATE_DIR'] = saved;
  }
});

test('run state: "." and ".." are no run ids, and a symlinked root is unlinked, not swept through', async () => {
  const { home, root } = tree();
  const stateRoot = path.join(home, '.cc-remote-rs');
  const saved = { s: process.env['CC_REMOTE_STATE_DIR'], r: process.env['CC_REMOTE_CONFINE_RUNS'] };
  process.env['CC_REMOTE_STATE_DIR'] = stateRoot;
  try {
    const rs = await import('../src/run-state.js');
    for (const mode of [undefined, path.join(root, 'projects')]) {
      if (mode) process.env['CC_REMOTE_CONFINE_RUNS'] = mode; else delete process.env['CC_REMOTE_CONFINE_RUNS'];
      assert.equal(rs.runStatePath('.'), undefined);
      assert.equal(rs.runStatePath('..'), undefined);
      assert.equal(rs.createRunState('..', undefined), undefined);
      rs.removeRunState('..'); // must not touch the state dir
      assert.ok(rs.runStatePath('ok.1'));
    }
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(path.join(stateRoot, 'agent.json'), '{"deviceToken":"t"}');
    rs.removeRunState('..');
    assert.ok(nodeFs.existsSync(path.join(stateRoot, 'agent.json')));
    // the root is a symlink to an unrelated tree with nested files
    const victim = path.join(root, 'unrelated');
    mkdirSync(path.join(victim, 'deep'), { recursive: true });
    writeFileSync(path.join(victim, 'deep', 'precious.txt'), 'x');
    symlinkSync(victim, path.join(stateRoot, 'run-state'));
    rs.sweepRunState();
    assert.ok(nodeFs.existsSync(path.join(victim, 'deep', 'precious.txt')), 'the target tree survives');
    assert.equal(nodeFs.existsSync(path.join(stateRoot, 'run-state')), false, 'the link itself is gone');
  } finally {
    for (const [k, v] of [['CC_REMOTE_STATE_DIR', saved.s], ['CC_REMOTE_CONFINE_RUNS', saved.r]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('seeding: skills swap in by rename, auth is 0600 from the tmp, nothing left behind, repeatable', async () => {
  const { prefix, home } = tree();
  const base = path.join(home, '.codex');
  writeFileSync(path.join(base, 'auth.json'), '{"k":1}');
  mkdirSync(path.join(base, 'skills', 's'), { recursive: true });
  writeFileSync(path.join(base, 'skills', 's', 'SKILL.md'), 'v1');
  const run = () => prepareConfinement(path.join(prefix, 'delo-a'), { prefix, home, baseCodexHome: base, env: {} });
  const c = await run();
  writeFileSync(path.join(base, 'skills', 's', 'SKILL.md'), 'v2');
  await run(); // an existing real skills dir is replaced, not merged into
  assert.equal(nodeFs.readFileSync(path.join(c!.codexHome, 'skills', 's', 'SKILL.md'), 'utf8'), 'v2');
  assert.equal(nodeFs.statSync(path.join(c!.codexHome, 'auth.json')).mode & 0o777, 0o600);
  assert.deepEqual(nodeFs.readdirSync(c!.codexHome).filter((n) => /\.(tmp|new|old)$/.test(n)), []);
  // a planted symlink at skills/ is replaced by the real copy; its target stays untouched
  const victim = path.join(home, 'victim-skills');
  mkdirSync(victim);
  nodeFs.rmSync(path.join(c!.codexHome, 'skills'), { recursive: true });
  symlinkSync(victim, path.join(c!.codexHome, 'skills'));
  await run();
  assert.deepEqual(nodeFs.readdirSync(victim), []);
  assert.ok(nodeFs.lstatSync(path.join(c!.codexHome, 'skills')).isDirectory());
});

test('mtime cache is per canonical cwd: unit A\'s future double never answers for B', async () => {
  const { home, prefix } = tree();
  await withConfineEnv(home, prefix, async () => {
    const cx = await import('../src/codex.js');
    const id = 'c1111111-2222-3333-4444-555555555555';
    const cwdA = path.join(prefix, 'delo-a');
    const cwdB = path.join(prefix, 'delo-b');
    plant(home, 'delo-b', id, cwdB);
    const fake = plant(home, 'delo-a', id, cwdA);
    nodeFs.utimesSync(fake, new Date(), new Date(Date.now() + 3_600_000));
    const a = await cx.codexRolloutMtime(id, cwdA); // caches A's path
    const b = await cx.codexRolloutMtime(id, cwdB);
    assert.ok(a !== undefined && a > Date.now() + 60_000);
    assert.ok(b !== undefined && b < Date.now() + 60_000);
  });
});

test('concurrent seeding of one unit home never leaves skills missing or temp dirs behind', async () => {
  const { prefix, home } = tree();
  const base = path.join(home, '.codex');
  mkdirSync(path.join(base, 'skills', 's'), { recursive: true });
  writeFileSync(path.join(base, 'skills', 's', 'SKILL.md'), 'v1');
  const run = () => prepareConfinement(path.join(prefix, 'delo-a'), { prefix, home, baseCodexHome: base, env: {} });
  const results = await Promise.all([run(), run(), run(), run()]);
  const homeDir = results[0]!.codexHome;
  assert.ok(nodeFs.existsSync(path.join(homeDir, 'skills', 's', 'SKILL.md')));
  assert.deepEqual(nodeFs.readdirSync(homeDir).filter((n) => /\.(tmp|new|old)$/.test(n)), []);
});

test('discovery: lstat only for unit homes when confined; the base home keeps stat semantics', async () => {
  const { home, prefix, root } = tree();
  const id = 'a1111111-2222-3333-4444-555555555555';
  const idU = 'a2222222-2222-3333-4444-555555555555';
  const target = path.join(root, 'elsewhere.jsonl');
  writeFileSync(target, metaLine(id, path.join(prefix, 'delo-a')));
  const baseDir = path.join(home, '.codex', 'sessions', '2026', '10', '21');
  mkdirSync(baseDir, { recursive: true });
  symlinkSync(target, path.join(baseDir, `rollout-2026-10-21T00-00-00-${id}.jsonl`));
  const unitDay = path.join(unitCodexHome('delo-a', home, prefix), 'sessions', '2026', '10', '21');
  mkdirSync(unitDay, { recursive: true });
  symlinkSync(target, path.join(unitDay, `rollout-2026-10-21T00-00-00-${idU}.jsonl`));
  for (const pfx of [undefined, prefix]) {
    await withConfineEnv(home, pfx, async () => {
      const { listRollouts } = await import('../src/codex.js');
      const names = (await listRollouts()).map((f) => path.basename(f.filePath));
      assert.ok(names.some((n) => n.includes(id)), 'a symlinked base rollout stays visible (stat), confined or not');
      assert.equal(names.some((n) => n.includes(idU)), false); // unconfined: never scanned; confined: lstat drops it
    });
  }
});
