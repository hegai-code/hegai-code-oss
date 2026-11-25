import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FS_CHUNK_BYTES } from '@cc-remote/shared';
import {
  CHAT_UPLOAD_DIR,
  joinMachinePath,
  uploadChatFile,
  withUploadedFiles,
  type MachineCall,
} from '../src/chatUpload.js';

/** A machine in memory: the few fs.* calls the uploader makes, with the agent's answers. */
function fakeMachine(opts: { folder?: boolean; gitignore?: boolean; guard?: string; failOn?: (call: Call) => Error | null } = {}) {
  const calls: Call[] = [];
  const files = new Map<string, number>();
  const open = new Map<string, { name: string; size: number; got: number }>();
  let folder = opts.folder ?? false;
  if (opts.gitignore) files.set('.gitignore', 2);
  const guard = opts.guard ?? '*\n';
  let n = 0;
  const rpc: MachineCall = (async (method: string, params: Record<string, unknown>) => {
    const call = { method, params };
    calls.push(call);
    const fail = opts.failOn?.(call);
    if (fail) throw fail;
    switch (method) {
      case 'fs.mkdir':
        if (folder) throw new Error('Папка с таким именем уже есть');
        folder = true;
        return { path: params.path, created: true };
      case 'fs.list':
        return { path: params.path, entries: [...files].map(([name, size]) => ({ name, kind: 'file', size })) };
      case 'fs.read':
        return { path: params.path, content: guard, truncated: false };
      case 'fs.upload.begin': {
        const id = `up-${++n}`;
        open.set(id, { name: String(params.name), size: Number(params.size), got: 0 });
        return { uploadId: id, name: params.name, path: `${params.dir}/${params.name}` };
      }
      case 'fs.upload.chunk': {
        const up = open.get(String(params.uploadId))!;
        up.got += Buffer.from(String(params.data), 'base64').length;
        return { received: up.got };
      }
      case 'fs.upload.commit': {
        const up = open.get(String(params.uploadId))!;
        open.delete(String(params.uploadId));
        files.set(up.name, up.got);
        return { path: `${CHAT_UPLOAD_DIR}/${up.name}`, bytes: up.got };
      }
      case 'fs.upload.abort':
        open.delete(String(params.uploadId));
        return { ok: true };
      default:
        throw new Error(`unexpected ${method}`);
    }
  }) as MachineCall;
  return { rpc, calls, files, open };
}
interface Call {
  method: string;
  params: Record<string, unknown>;
}
const file = (name: string, size: number) => new File([new Uint8Array(size)], name);
const names = (calls: Call[]) => calls.map((c) => c.method);

test('a big file lands in .hegai-uploads behind a git-ignoring .gitignore and comes back as an absolute path', async () => {
  const m = fakeMachine();
  const path = await uploadChatFile({ rpc: m.rpc, scope: 'a', cwd: '/srv/p/', file: file('отчёт.xlsx', 11) });
  assert.equal(path, '/srv/p/.hegai-uploads/отчёт.xlsx');
  assert.equal(m.files.get('.gitignore'), 2, '`*\\n` written first');
  assert.equal(m.files.get('отчёт.xlsx'), 11);
  assert.deepEqual(m.calls[0], {
    method: 'fs.mkdir',
    params: { cwd: '/srv/p/', path: '.hegai-uploads', recursive: false },
  });
  const gi = m.calls.findIndex((c) => c.method === 'fs.upload.begin' && c.params.name === '.gitignore');
  const big = m.calls.findIndex((c) => c.method === 'fs.upload.begin' && c.params.name === 'отчёт.xlsx');
  assert.ok(gi > 0 && big > gi, 'the guard goes up before the file');
  assert.ok(m.calls.every((c) => c.params.cwd === '/srv/p/'));
  assert.equal(m.open.size, 0);
});

test('an existing folder with a .gitignore is used as it is', async () => {
  const m = fakeMachine({ folder: true, gitignore: true });
  await uploadChatFile({ rpc: m.rpc, scope: 'b', cwd: '/p', file: file('a.bin', 3) });
  assert.deepEqual(names(m.calls), [
    'fs.mkdir',
    'fs.list',
    'fs.read',
    'fs.upload.begin',
    'fs.upload.chunk',
    'fs.upload.commit',
  ]);
});

test('no .gitignore and none can be made: the file is not uploaded at all', async () => {
  const m = fakeMachine({
    failOn: (c) => (c.method === 'fs.upload.begin' && c.params.name === '.gitignore' ? new Error('нельзя') : null),
  });
  await assert.rejects(uploadChatFile({ rpc: m.rpc, scope: 'c', cwd: '/p', file: file('a.bin', 3) }), /нельзя/);
  assert.ok(!m.calls.some((c) => c.method === 'fs.upload.begin' && c.params.name === 'a.bin'));
  assert.equal(m.files.size, 0);
});

test('a failed window aborts the upload', async () => {
  let chunks = 0;
  const m = fakeMachine({
    folder: true,
    gitignore: true,
    failOn: (c) => (c.method === 'fs.upload.chunk' && ++chunks === 2 ? new Error('обрыв') : null),
  });
  await assert.rejects(
    uploadChatFile({ rpc: m.rpc, scope: 'd', cwd: '/p', file: file('big.bin', FS_CHUNK_BYTES * 2 + 5) }),
    /обрыв/,
  );
  const abort = m.calls.find((c) => c.method === 'fs.upload.abort');
  assert.ok(abort, 'abort sent');
  assert.equal(m.open.size, 0);
  assert.ok(!m.files.has('big.bin'));
});

test('progress climbs in windows and ends at the file size', async () => {
  const m = fakeMachine({ folder: true, gitignore: true });
  const seen: number[] = [];
  const size = FS_CHUNK_BYTES * 2 + 100;
  await uploadChatFile({ rpc: m.rpc, scope: 'e', cwd: '/p', file: file('x.bin', size), onProgress: (s) => seen.push(s) });
  assert.deepEqual(seen, [FS_CHUNK_BYTES, FS_CHUNK_BYTES * 2, size, size]);
  assert.equal(m.calls.filter((c) => c.method === 'fs.upload.chunk').length, 3);
});

test('an aborted signal stops between windows and aborts on the machine', async () => {
  const m = fakeMachine({ folder: true, gitignore: true });
  const ctl = new AbortController();
  await assert.rejects(
    uploadChatFile({
      rpc: m.rpc,
      scope: 'f',
      cwd: '/p',
      file: file('x.bin', FS_CHUNK_BYTES * 3),
      signal: ctl.signal,
      onProgress: () => ctl.abort(),
    }),
  );
  assert.ok(m.calls.some((c) => c.method === 'fs.upload.abort'));
  assert.equal(m.calls.filter((c) => c.method === 'fs.upload.chunk').length, 1);
});

test('files dropped together make the .gitignore once', async () => {
  const m = fakeMachine();
  await Promise.all([
    uploadChatFile({ rpc: m.rpc, scope: 'g', cwd: '/p', file: file('a.bin', 3) }),
    uploadChatFile({ rpc: m.rpc, scope: 'g', cwd: '/p', file: file('b.bin', 3) }),
  ]);
  const begins = m.calls.filter((c) => c.method === 'fs.upload.begin').map((c) => c.params.name);
  assert.equal(begins.filter((n) => n === '.gitignore').length, 1);
  assert.deepEqual(begins.filter((n) => n !== '.gitignore').sort(), ['a.bin', 'b.bin']);
});

test("the hub's read-only answer becomes the owner-only explanation", async () => {
  const m = fakeMachine({
    failOn: (c) => (c.method === 'fs.mkdir' ? new Error('Read-only workspace access.') : null),
  });
  await assert.rejects(
    uploadChatFile({ rpc: m.rpc, scope: 'h', cwd: '/p/sub', file: file('a.bin', 3) }),
    /только владелец машины; до 8 МБ/,
  );
});

test('more than the upload ceiling is refused before any call', async () => {
  const m = fakeMachine();
  const huge = { name: 'huge.iso', size: 100 * 1024 * 1024 + 1 } as unknown as File;
  await assert.rejects(uploadChatFile({ rpc: m.rpc, scope: 'i', cwd: '/p', file: huge }), /предел 100 МБ/);
  assert.equal(m.calls.length, 0);
});

test('paths follow the separator the machine uses', () => {
  assert.equal(joinMachinePath('/srv/p', '.hegai-uploads/a.xlsx'), '/srv/p/.hegai-uploads/a.xlsx');
  assert.equal(joinMachinePath('C:\\Work\\App\\', '.hegai-uploads/a.xlsx'), 'C:\\Work\\App\\.hegai-uploads\\a.xlsx');
});

test('uploaded paths close the message, and stand alone when there is no text', () => {
  assert.equal(
    withUploadedFiles('Посмотри таблицу\n', ['/p/.hegai-uploads/a.xlsx', '/p/.hegai-uploads/b.pdf']),
    'Посмотри таблицу\n\n[Файлы на этой машине, читать с диска:\n- /p/.hegai-uploads/a.xlsx\n- /p/.hegai-uploads/b.pdf\n]',
  );
  assert.equal(
    withUploadedFiles('  ', ['/p/.hegai-uploads/a.xlsx']),
    '[Файлы на этой машине, читать с диска:\n- /p/.hegai-uploads/a.xlsx\n]',
  );
  assert.equal(withUploadedFiles('hi', []), 'hi');
});

test('a .gitignore that guards nothing stops the upload', async () => {
  for (const guard of ['', '*.log\n', '*\n!keep\n']) {
    const m = fakeMachine({ folder: true, gitignore: true, guard });
    await assert.rejects(() => uploadChatFile({ rpc: m.rpc, scope: `g-${guard}`, cwd: '/srv/p', file: file('a.bin', 3) }), /gitignore/);
    assert.ok(!names(m.calls).includes('fs.upload.begin'));
  }
});
