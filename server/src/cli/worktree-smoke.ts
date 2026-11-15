/**
 * Worktrees + diff review over the real chain browser -> hub -> agent: create
 * a worktree, change a file in it, read the diff (secret files withheld),
 * commit all, list, remove. Needs a REAL agent whose files roots include the
 * repo (see deploy/SMOKE-TESTS.md, «worktree-smoke»).
 *
 * Usage: tsx server/src/cli/worktree-smoke.ts <ws://hub> <token> <machine-name> <repo-dir>
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodeCentralToBrowser, type GitDiffFile, type MachineSnapshot } from '@cc-remote/shared';
import { connectUi, fail, mustOk, rpc } from './_harness.js';

const machineName = process.argv[4] ?? fail('machine name is required');
const repo = process.argv[5] ?? fail('repo dir is required');
const { ws } = connectUi(process.argv);

let started = false;
ws.on('message', (data: Buffer) => {
  const msg = decodeCentralToBrowser(data.toString());
  if (msg.type === 'snapshot' && !started) {
    const m = msg.machines.find((x: MachineSnapshot) => x.machine.name === machineName && x.online);
    if (m) {
      started = true;
      void run(m.machine.machineId);
    }
  }
});

async function run(machineId: string) {
  const add = mustOk<{ path: string; branch: string }>(
    'git.worktree.add',
    await rpc(ws, machineId, 'git.worktree.add', { cwd: repo, branch: 'agent/smoke' }),
  );
  console.log(`worktree: ${add.path} (${add.branch})`);
  writeFileSync(path.join(add.path, 'a.txt'), 'one\nTWO\nthree\n');
  writeFileSync(path.join(add.path, 'new.txt'), 'hello\n');
  writeFileSync(path.join(add.path, '.env'), 'TOKEN=SMOKESECRET\n');
  const diff = mustOk<{ files: GitDiffFile[]; truncated: boolean }>(
    'git.diff',
    await rpc(ws, machineId, 'git.diff', { cwd: add.path }),
  );
  const names = diff.files.map((f) => `${f.path}${f.withheld ? ' (withheld)' : ''} +${f.additions} -${f.deletions}`);
  console.log(`diff: ${names.join(', ')}`);
  if (JSON.stringify(diff).includes('SMOKESECRET')) fail('secret file content left the machine');
  if (!diff.files.some((f) => f.path === 'a.txt' && f.hunks.length > 0)) fail('a.txt diff missing');
  const refused = mustOk<{ ok: boolean; output: string }>(
    'git.commit refused',
    await rpc(ws, machineId, 'git.commit', { cwd: add.path, message: 'smoke', all: true }),
  );
  if (refused.ok) fail('commit all swept .env');
  console.log(`commit with .env: refused — ${refused.output}`);
  writeFileSync(path.join(add.path, '.gitignore'), '.env\n');
  const ok = mustOk<{ ok: boolean; output: string }>(
    'git.commit',
    await rpc(ws, machineId, 'git.commit', { cwd: add.path, message: 'smoke', all: true }),
  );
  if (!ok.ok) fail(`commit failed: ${ok.output}`);
  console.log('commit: ok');
  const list = mustOk<{ worktrees: { path: string; branch?: string; ahead?: number }[] }>(
    'git.worktree.list',
    await rpc(ws, machineId, 'git.worktree.list', { cwd: repo }),
  );
  console.log(`list: ${list.worktrees.map((w) => `${w.branch ?? '?'}${w.ahead ? ` +${w.ahead}` : ''}`).join(', ')}`);
  const rm = mustOk<{ ok: boolean; output: string }>(
    'git.worktree.remove',
    await rpc(ws, machineId, 'git.worktree.remove', { cwd: repo, path: add.path, force: true }),
  );
  if (!rm.ok) fail(`remove failed: ${rm.output}`);
  console.log('remove: ok');
  console.log('PASS worktree-smoke');
  process.exit(0);
}

setTimeout(() => fail('no online machine named ' + machineName), 60_000);
