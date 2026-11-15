/**
 * Files smoke: the file-manager RPCs end to end through the hub to a REAL agent
 * on this machine, then the hub-side boundary for a control-share member.
 *
 * Part 1 (owner, fleet token; needs a local agent):
 *   fs.list                     -> entries carry size and mtime; nothing hidden
 *   fs.mkdir                    -> created:true, then created:false (idempotent)
 *   fs.upload.begin/chunk/commit-> round-trips a multi-window binary file, sha256 equal
 *   fs.upload.chunk (bad offset)-> ok:false (sequential, never silently misplaced)
 *   fs.upload.abort             -> no `.part` left behind
 *   upload '../escape.bin'      -> refused; nothing appears outside the directory
 *   upload '.gitignore'         -> STAYS '.gitignore' (the divergence from safeName)
 *   fs.rename onto a taken name -> ok:false (no silent clobber)
 *   fs.trash                    -> movedTo under the agent's trash, gone from the list
 *   fs.list {cwd:'/'}           -> ok:false (the roots guard)
 *   symlink out of the project  -> ok:false on read
 *   fs.peek                     -> an image in 2 windows; the session scratchpad;
 *                                  refused: a link into temp, a non-preview, /etc
 *
 * Part 2 (member, SSO; SKIPped without CC_REMOTE_SSO_SECRET):
 *   A shares a root with access:'control' to a team B belongs to. B may
 *   fs.list INSIDE the shared root, may not outside it, and may not write
 *   anywhere — and the agent never sees the refused calls. This is the
 *   regression test for the whole access block: widen the allowlist in
 *   `hub/rpc.rs` and this fails.
 *
 * Start a LOCAL hub (SSO optional, needed for part 2) and a LOCAL agent with a
 * scratch projects root, both on the dev token:
 *
 *   PORT=4399 CC_REMOTE_TOKEN=dev-token \
 *   CC_REMOTE_DB_PATH=/tmp/cc-remote-files-smoke.sqlite3 \
 *   cargo run --manifest-path server-rs/Cargo.toml
 *
 *   CC_REMOTE_PROJECTS_ROOT=/tmp/files-smoke-root \
 *   CENTRAL_URL=ws://127.0.0.1:4399 CC_REMOTE_TOKEN=dev-token \
 *   npm run dev --workspace agent
 *
 *   CC_REMOTE_PROJECTS_ROOT=/tmp/files-smoke-root \
 *     tsx server/src/cli/files-smoke.ts [ws://127.0.0.1:4399] [dev-token] [machineFilter]
 *
 * `CC_REMOTE_PROJECTS_ROOT` must match the agent's: the agent writes under it,
 * this smoke checks the bytes on disk.
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WebSocket } from 'ws';
import type {
  FsListResult,
  FsMkdirResult,
  FsTrashResult,
  FsUploadBeginResult,
  FsUploadCommitResult,
  MachineSnapshot,
  RpcMethod,
} from '@cc-remote/shared';
import { FS_CHUNK_BYTES } from '@cc-remote/shared';
import {
  adminActivate,
  adminLogin,
  api,
  connectUiAs,
  enrollFakeAgent,
  expectStatus,
  fail,
  machineFilterArg,
  mustOk,
  nextAgentFrame,
  nextBrowserFrame,
  openSocket,
  randomSmokeUser,
  rpc,
  sendUi,
  smokeTarget,
  ssoLogin,
  step,
} from './_harness.js';

const target = smokeTarget(process.argv);
const machineFilter = machineFilterArg(process.argv, os.hostname());
const projectsRoot = path.resolve(
  process.env['CC_REMOTE_PROJECTS_ROOT']?.trim() || path.join(os.homedir(), 'work'),
);
const TRASH_RE = /[\\/]\.cc-remote[\\/]trash[\\/]|[\\/]trash[\\/]/;

const timer = setTimeout(() => fail('timed out (180s)'), 180_000);

/** Push a buffer through the windowed upload protocol. */
async function upload(
  ui: WebSocket,
  machineId: string,
  cwd: string,
  dir: string,
  name: string,
  bytes: Buffer,
): Promise<FsUploadCommitResult & { name: string }> {
  const begun = mustOk<FsUploadBeginResult>(
    'fs.upload.begin',
    await rpc(ui, machineId, 'fs.upload.begin', { cwd, dir, name, size: bytes.length }),
  );
  for (let offset = 0; offset < bytes.length; offset += FS_CHUNK_BYTES) {
    const slice = bytes.subarray(offset, Math.min(offset + FS_CHUNK_BYTES, bytes.length));
    mustOk(
      'fs.upload.chunk',
      await rpc(ui, machineId, 'fs.upload.chunk', {
        uploadId: begun.uploadId,
        offset,
        data: slice.toString('base64'),
      }),
    );
  }
  const done = mustOk<FsUploadCommitResult>(
    'fs.upload.commit',
    await rpc(ui, machineId, 'fs.upload.commit', { uploadId: begun.uploadId }),
  );
  return { ...done, name: begun.name };
}

async function ownerPart(): Promise<void> {
  step(`Part 1 — owner RPCs against a local agent (machine "${machineFilter}", root ${projectsRoot})`);
  const ui = await openSocket(`${target.ws}/ui?token=${encodeURIComponent(target.token)}`);
  const snap = await nextBrowserFrame(ui, 'snapshot', () => true, 15_000);
  const machine: MachineSnapshot | undefined = snap.machines.find(
    (m) => m.online && m.machine.name.toLowerCase().includes(machineFilter.toLowerCase()),
  );
  if (!machine) fail(`no ONLINE machine matching "${machineFilter}" — start the agent (see the usage comment)`);
  if (machine.canControl !== true) fail(`the fleet-token viewer does not control ${machine.machine.name}`);
  const machineId = machine.machine.machineId;
  console.log(`  ✓ machine ${machine.machine.name} (${machineId}) online, canControl`);

  // A scratch project under the root, so every assertion below is on disk.
  const projectName = `files-smoke-${randomUUID().slice(0, 8)}`;
  const cwd = path.join(projectsRoot, projectName);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(path.join(cwd, 'README.md'), '# smoke\n');
  // `projects.list` is the admission point for the roots allow-list; without it
  // a directory created behind the agent's back is legitimately unknown.
  mustOk('projects.list', await rpc(ui, machineId, 'projects.list', {}));

  const listed = mustOk<FsListResult>('fs.list', await rpc(ui, machineId, 'fs.list', { cwd, path: '' }));
  const readme = listed.entries.find((e) => e.name === 'README.md');
  assert.ok(readme, 'README.md is listed');
  assert.equal(readme.kind, 'file');
  assert.ok((readme.size ?? 0) > 0, 'a listing carries size');
  assert.ok(typeof readme.mtime === 'number' && readme.mtime > 0, 'a listing carries mtime');
  console.log(`  ✓ fs.list: ${listed.entries.length} entr(ies), size+mtime present`);

  const made = mustOk<FsMkdirResult>('fs.mkdir', await rpc(ui, machineId, 'fs.mkdir', { cwd, path: 'docs/deep' }));
  assert.equal(made.created, true);
  const again = mustOk<FsMkdirResult>('fs.mkdir again', await rpc(ui, machineId, 'fs.mkdir', { cwd, path: 'docs/deep' }));
  assert.equal(again.created, false, 'mkdir is idempotent — a re-dropped folder is not an error');
  console.log('  ✓ fs.mkdir: recursive, idempotent');

  // Multi-window round trip. Pseudo-random so a truncated or misordered window
  // cannot pass by accident.
  const blob = Buffer.from(
    Array.from({ length: Math.floor(FS_CHUNK_BYTES * 2.5) }, (_, i) => (i * 31 + (i >> 8)) % 256),
  );
  const up = await upload(ui, machineId, cwd, 'docs', 'blob.bin', blob);
  assert.equal(up.bytes, blob.length);
  const landedPath = path.join(cwd, 'docs', 'blob.bin');
  assert.ok(existsSync(landedPath), 'the uploaded file is on disk');
  assert.equal(
    createHash('sha256').update(readFileSync(landedPath)).digest('hex'),
    createHash('sha256').update(blob).digest('hex'),
    'the file round-trips byte for byte',
  );
  console.log(`  ✓ upload ${blob.length} B in ${Math.ceil(blob.length / FS_CHUNK_BYTES)} windows -> sha256 equal`);

  // Windows are strictly sequential; a retry that lost its place is refused
  // rather than written at the wrong offset.
  const seq = mustOk<FsUploadBeginResult>(
    'fs.upload.begin (seq)',
    await rpc(ui, machineId, 'fs.upload.begin', { cwd, dir: 'docs', name: 'seq.bin', size: 32 }),
  );
  const badOffset = await rpc(ui, machineId, 'fs.upload.chunk', {
    uploadId: seq.uploadId,
    offset: 16,
    data: Buffer.from('0123456789abcdef').toString('base64'),
  });
  assert.equal(badOffset.ok, false, 'an out-of-order window is refused');
  mustOk('fs.upload.abort', await rpc(ui, machineId, 'fs.upload.abort', { uploadId: seq.uploadId }));
  const parts = readdirSync(path.join(cwd, 'docs')).filter((n) => n.endsWith('.part'));
  assert.deepEqual(parts, [], 'abort leaves no .part behind');
  console.log('  ✓ out-of-order window refused; abort cleans up');

  // A path in the NAME field is a bad name, not a path.
  const escape = await rpc(ui, machineId, 'fs.upload.begin', {
    cwd,
    dir: 'docs',
    name: '../../escape.bin',
    size: 4,
  });
  assert.equal(escape.ok, false, 'a traversal name is refused');
  assert.ok(!existsSync(path.join(projectsRoot, 'escape.bin')), 'nothing appeared outside the project');
  console.log(`  ✓ upload '../../escape.bin' -> ok:false "${escape.error}"`);

  // The deliberate divergence from attachments' `safeName`, which would have
  // turned this into `gitignore`.
  const dotfile = await upload(ui, machineId, cwd, '', '.gitignore', Buffer.from('node_modules\n'));
  assert.equal(dotfile.name, '.gitignore', 'a dotfile stays a dotfile');
  assert.ok(existsSync(path.join(cwd, '.gitignore')));
  console.log("  ✓ upload '.gitignore' -> stays '.gitignore'");

  // A collision keeps both and reports the name actually used.
  const second = await upload(ui, machineId, cwd, '', '.gitignore', Buffer.from('dist\n'));
  assert.notEqual(second.name, '.gitignore', 'a collision is suffixed, not overwritten');
  assert.equal(readFileSync(path.join(cwd, '.gitignore'), 'utf8'), 'node_modules\n', 'the original is intact');
  console.log(`  ✓ collision -> '${second.name}', original untouched`);

  const clobber = await rpc(ui, machineId, 'fs.rename', { cwd, from: '.gitignore', to: second.name });
  assert.equal(clobber.ok, false, 'rename never silently overwrites');
  console.log(`  ✓ fs.rename onto a taken name -> ok:false "${clobber.error}"`);

  const trashed = mustOk<FsTrashResult>(
    'fs.trash',
    await rpc(ui, machineId, 'fs.trash', { cwd, path: 'docs/blob.bin' }),
  );
  assert.equal(trashed.ok, true);
  assert.ok(TRASH_RE.test(trashed.movedTo), `movedTo is in the agent's trash: ${trashed.movedTo}`);
  assert.ok(!existsSync(landedPath), 'the file is gone from the project');
  assert.ok(existsSync(trashed.movedTo), 'the bytes are still recoverable');
  console.log(`  ✓ fs.trash -> ${trashed.movedTo}`);

  // The roots guard: the agent decides what a cwd may be, not the caller.
  const wholeDisk = await rpc(ui, machineId, 'fs.list', { cwd: '/', path: '' });
  assert.equal(wholeDisk.ok, false, "cwd:'/' is refused");
  console.log(`  ✓ fs.list {cwd:'/'} -> ok:false "${wholeDisk.error}"`);

  // A symlink leading out of the project is refused, not followed.
  const outside = path.join(os.tmpdir(), `files-smoke-outside-${randomUUID().slice(0, 8)}`);
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, 'secret.txt'), 'private');
  symlinkSync(outside, path.join(cwd, 'escape-link'));
  const followed = await rpc(ui, machineId, 'fs.read', { cwd, path: 'escape-link/secret.txt' });
  assert.equal(followed.ok, false, 'a symlink out of the project is refused');
  console.log(`  ✓ read through an escaping symlink -> ok:false "${followed.error}"`);

  // fs.peek — the chat's preview. The scratch tree is where Claude Code puts a
  // session's screenshots; run the agent and this smoke with the SAME TMPDIR.
  const png = Buffer.from(Array.from({ length: Math.floor(FS_CHUNK_BYTES * 1.5) }, (_, i) => i % 251));
  writeFileSync(path.join(cwd, 'shot.png'), png);
  const peekAll = async (p: string): Promise<Buffer> => {
    const parts: Buffer[] = [];
    for (let offset = 0; ; ) {
      const w = mustOk<{ data: string; bytes: number; eof: boolean }>(
        `fs.peek ${p}@${offset}`,
        await rpc(ui, machineId, 'fs.peek', { cwd, path: p, offset }),
      );
      parts.push(Buffer.from(w.data, 'base64'));
      offset += w.bytes;
      if (w.eof) return Buffer.concat(parts);
    }
  };
  assert.ok((await peekAll('shot.png')).equals(png), 'fs.peek returns the image byte for byte');
  console.log(`  ✓ fs.peek shot.png: ${png.length} B in 2 windows, equal`);
  const uid = process.getuid?.();
  if (uid !== undefined) {
    const owner = path.join(os.tmpdir(), `claude-${uid}`);
    const pad = path.join(owner, cwd.replace(/[^a-zA-Z0-9]/g, '-'), randomUUID(), 'scratchpad');
    mkdirSync(pad, { recursive: true });
    chmodSync(owner, 0o700);
    writeFileSync(path.join(pad, 'mail.png'), 'scratch-bytes');
    assert.equal((await peekAll(path.join(pad, 'mail.png'))).toString(), 'scratch-bytes');
    console.log(`  ✓ fs.peek ${path.join(pad, 'mail.png')} (session scratchpad) served`);
    // A link from the project into temp must not count, wherever the project lives.
    symlinkSync(pad, path.join(cwd, 'pad-link'));
    const viaLink = await rpc(ui, machineId, 'fs.peek', { cwd, path: 'pad-link/mail.png' });
    assert.equal(viaLink.ok, false, 'a link from the project into temp is refused');
    console.log(`  ✓ fs.peek through a link into temp -> ok:false "${viaLink.error}"`);
    rmSync(path.dirname(pad), { recursive: true, force: true });
  }
  const notImage = await rpc(ui, machineId, 'fs.peek', { cwd, path: 'README.md.bak' });
  assert.equal(notImage.ok, false);
  const env = await rpc(ui, machineId, 'fs.peek', { cwd, path: '.gitignore' });
  assert.equal(env.ok, false, 'fs.peek serves only previews');
  const far = await rpc(ui, machineId, 'fs.peek', { cwd, path: '/etc/hostname.png' });
  assert.equal(far.ok, false, 'fs.peek refuses an arbitrary absolute path');
  console.log(`  ✓ fs.peek .gitignore / /etc/… -> ok:false "${env.error}" / "${far.error}"`);

  // Tidy: the agent never deletes, so this run cleans up after itself.
  rmSync(cwd, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  if (TRASH_RE.test(trashed.movedTo)) rmSync(trashed.movedTo, { recursive: true, force: true });
  ui.close();
}

async function memberPart(): Promise<boolean> {
  step('Part 2 — control-share member: reads inside the shared root, nothing else');
  if (!target.ssoSecret) {
    console.log('  SKIP: CC_REMOTE_SSO_SECRET not set in this shell — cannot mint the two SSO members');
    return false;
  }
  const secret = target.ssoSecret;
  const a = await ssoLogin(target.http, secret, randomSmokeUser('files-a', 'Files Owner'));
  const b = await ssoLogin(target.http, secret, randomSmokeUser('files-b', 'Files Member'));
  const admin = await adminLogin(target.http, secret);
  await adminActivate(target.http, admin, [a.email, b.email]);
  const team = expectStatus(
    'POST /api/workspaces (A)',
    await api(target.http, a.cookie, 'POST', '/api/workspaces', { name: 'Файлы' }),
    201,
  );
  const org = String(team.body['workspaceId']);
  const invite = expectStatus(
    'invite B',
    await api(target.http, a.cookie, 'POST', `/api/workspaces/${org}/invitations`, { email: b.email, role: 'member' }),
    201,
  );
  expectStatus('B accepts', await api(target.http, b.cookie, 'POST', '/api/invitations/accept', { token: invite.body['token'] }), 200);
  const shared = await enrollFakeAgent(target, a, { name: 'files-box' });
  const root = '/home/a/shared';
  expectStatus(
    'A shares a root (control)',
    await api(target.http, a.cookie, 'POST', `/api/workspaces/${org}/projects`, {
      machineId: shared.machineId,
      root,
      name: 'shared',
      access: 'control',
    }),
    201,
  );

  const uiB = await connectUiAs(target.ws, b, org);
  // Every refused call must die at the hub: the agent seeing it at all would
  // mean the boundary is only a message, not a gate.
  const leaked: unknown[] = [];
  shared.ws.on('message', (raw: Buffer) => {
    const msg: unknown = JSON.parse(raw.toString());
    if ((msg as { type?: string }).type === 'rpc_request') leaked.push(msg);
  });

  const outside = await rpc(uiB, shared.machineId, 'fs.list', { cwd: '/home/a/not-shared', path: '' });
  assert.equal(outside.ok, false, 'a cwd outside the share is refused');
  assert.equal(outside.error, 'Read-only workspace access.');

  for (const [method, params] of [
    ['fs.trash', { cwd: root, path: 'x' }],
    ['fs.mkdir', { cwd: root, path: 'x' }],
    ['fs.upload.begin', { cwd: root, dir: '', name: 'x', size: 1 }],
    ['fs.write', { cwd: root, path: 'x', content: 'y' }],
  ] as [RpcMethod, Record<string, unknown>][]) {
    const denied = await rpc(uiB, shared.machineId, method, params);
    assert.equal(denied.ok, false, `${method} must be refused for a control-share member`);
    assert.equal(denied.error, 'Read-only workspace access.', `${method} refusal text`);
  }
  assert.equal(leaked.length, 0, 'no refused file RPC reached the agent');
  console.log('  ✓ B: reads outside the share and ALL writes refused at the hub, agent saw nothing');

  // Inside the share, a read IS forwarded. The fake agent never answers, so
  // only the forwarding is asserted — which is the part the hub decides.
  const forwarded = nextAgentFrame(shared.ws, 'rpc_request');
  const allowedId = randomUUID();
  sendUi(uiB, {
    type: 'rpc_request',
    requestId: allowedId,
    machineId: shared.machineId,
    method: 'fs.list',
    params: { cwd: `${root}/app`, path: '' },
  });
  const seen = await forwarded;
  assert.equal(seen.requestId, allowedId);
  assert.equal(seen.method, 'fs.list');
  console.log('  ✓ B fs.list inside the shared root -> forwarded to the agent');

  uiB.close();
  shared.ws.close();
  return true;
}

async function main(): Promise<void> {
  console.log(`[files-smoke] hub ${target.http}`);
  await ownerPart();
  const memberRan = await memberPart();
  clearTimeout(timer);
  console.log(
    `\nPASS: list/mkdir/upload/rename/trash + roots and symlink refusals OK${memberRan ? ', member boundary OK' : ' (member part skipped)'}`,
  );
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
