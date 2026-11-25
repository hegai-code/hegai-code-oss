/**
 * A file too big to ride a message reaches the machine from a CONTROL-SHARE
 * member's composer, and the turn names where it landed.
 *
 * Until 25.11.2026 such a member saw «Слишком большой файл (предел 8 МБ)»: the
 * inline cap is the agent's, and the hub kept `fs.upload.*` for the machine's
 * owner. A real hub and a real Chrome signed in as the member; the machine is a
 * fake agent that serves the file RPCs with the agent's own code, on a scratch
 * directory:
 *
 *   CC_REMOTE_SSO_SECRET=<hub's> tsx server/src/cli/big-attachment-smoke.ts
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  adminActivate,
  adminLogin,
  api,
  enrollFakeAgent,
  expectStatus,
  fail,
  fakeSession,
  launchBrowser,
  nextAgentFrame,
  randomSmokeUser,
  smokeTarget,
  sleep,
  ssoLogin,
  step,
} from './_harness.js';

// The agent's own file code, loaded by path: this workspace does not build it.
const agentSrc = (f: string): Promise<Record<string, unknown>> => import(new URL(`../../../agent/src/${f}`, import.meta.url).href) as Promise<Record<string, unknown>>;
interface Uploads {
  begin: (cwd: string, dir: string, name: string, size: number, overwrite?: boolean) => Promise<unknown>;
  chunk: (id: string, offset: number, data: string) => Promise<unknown>;
  commit: (id: string) => Promise<unknown>;
  abort: (id: string) => Promise<unknown>;
}
const fsList = (await agentSrc('fs-ops.ts'))['fsList'] as (cwd: string, rel: string) => Promise<unknown>;
const fsMkdir = (await agentSrc('fs-manage.ts'))['fsMkdir'] as (cwd: string, rel: string, o: { recursive?: boolean }) => Promise<unknown>;
const UploadStore = (await agentSrc('uploads.ts'))['UploadStore'] as new () => Uploads;

const SHOTS = '/tmp/big-attachment-smoke';
const SIZE = 11 * 1024 * 1024 + 12345;
const NAME = 'Кто заблокировал бота 21.11.xlsx';
const target = smokeTarget(process.argv);
const timer = setTimeout(() => fail('timed out (150s)'), 150_000);
type Params = Record<string, never> & { cwd: string; path: string; dir: string; name: string; size: number; uploadId: string; offset: number; data: string; recursive?: boolean; overwrite?: boolean };

async function main(): Promise<void> {
  if (!target.ssoSecret) fail('CC_REMOTE_SSO_SECRET is not set in this shell (must match the hub)');
  const secret = target.ssoSecret;
  mkdirSync(SHOTS, { recursive: true });
  // Not /tmp: the web hides sessions whose cwd is there.
  const root = mkdtempSync(path.join(process.env.SMOKE_ROOT ?? process.cwd(), '.big-attachment-'));

  step('1. Owner A shares a root for control; member B signs in');
  const admin = await adminLogin(target.http, secret);
  const a = await ssoLogin(target.http, secret, randomSmokeUser('big-a', 'Владелец'));
  const b = await ssoLogin(target.http, secret, randomSmokeUser('big-b', 'Участник'));
  await adminActivate(target.http, admin, [a.email, b.email]);
  const org = String(
    (expectStatus('team', await api(target.http, a.cookie, 'POST', '/api/workspaces', { name: 'Big' }), 201).body['workspaceId']) ?? '',
  );
  const invite = expectStatus(
    'invite B',
    await api(target.http, a.cookie, 'POST', `/api/workspaces/${org}/invitations`, { email: b.email, role: 'member' }),
    201,
  );
  expectStatus('B accepts', await api(target.http, b.cookie, 'POST', '/api/invitations/accept', { token: invite.body['token'] }), 200);
  const session = fakeSession(root, 'Проект с большим файлом');
  const agent = await enrollFakeAgent(target, a, { name: 'big-box', sessions: [session] });
  expectStatus(
    'A shares (control)',
    await api(target.http, a.cookie, 'POST', `/api/workspaces/${org}/projects`, { machineId: agent.machineId, root, name: 'Big', access: 'control', visibility: 'everyone' }),
    201,
  );

  const uploads = new UploadStore();
  const seen: string[] = [];
  agent.ws.on('message', (raw: unknown) => {
    const m = JSON.parse(String(raw)) as { type: string; requestId: string; method: string; params: Params };
    if (m.type !== 'rpc_request') return;
    seen.push(m.method);
    const p = m.params;
    const run = async (): Promise<unknown> => {
      switch (m.method) {
        case 'fs.list':
          return fsList(p.cwd, p.path ?? '');
        case 'fs.mkdir':
          return fsMkdir(p.cwd, p.path, { recursive: p.recursive });
        case 'fs.upload.begin':
          return uploads.begin(p.cwd, p.dir, p.name, p.size, p.overwrite ?? false);
        case 'fs.upload.chunk':
          return uploads.chunk(p.uploadId, p.offset, p.data);
        case 'fs.upload.commit':
          return uploads.commit(p.uploadId);
        case 'fs.upload.abort':
          return uploads.abort(p.uploadId);
        default:
          throw new Error(`not in this smoke: ${m.method}`);
      }
    };
    run().then(
      (result) => agent.ws.send(JSON.stringify({ type: 'rpc_response', requestId: m.requestId, ok: true, result })),
      (e: Error) => agent.ws.send(JSON.stringify({ type: 'rpc_response', requestId: m.requestId, ok: false, error: e.message })),
    );
  });

  step('2. B, in a real Chrome, drops an 11 MB file on the composer');
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const [name, ...rest] = (b.cookie.split(';')[0] ?? '').split('=');
  await browser.setCookie({ name: (name ?? '').trim(), value: rest.join('='), domain: '127.0.0.1', path: '/' });
  await page.goto(`${target.http}/w/s/${agent.machineId}/${session.sessionId}`, { waitUntil: 'networkidle2' });
  // A first visit opens on the onboarding: step past it, into the team.
  await page.waitForSelector('button', { timeout: 20_000 });
  await page.evaluate(`[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Пропустить')?.click()`);
  await sleep(1_000);
  await page.evaluate(`localStorage.setItem('cc-workspace', ${JSON.stringify(org)})`);
  await page.goto(`${target.http}/w/s/${agent.machineId}/${session.sessionId}`, { waitUntil: 'networkidle2' });
  await page.screenshot({ path: `${SHOTS}/0-opened.png` });
  await page.waitForSelector('.composer textarea', { timeout: 20_000 });
  const bytes = randomBytes(SIZE);
  const local = path.join(SHOTS, NAME);
  writeFileSync(local, bytes);
  const input = await page.$('.composer input[type=file]');
  assert.ok(input, 'the composer has a file input');
  await (input as unknown as { uploadFile: (p: string) => Promise<void> }).uploadFile(local);
  await page.waitForFunction(`document.querySelector('.composer')?.innerText.includes('%')`, { timeout: 10_000, polling: 30 }).catch(() => {});
  await page.screenshot({ path: `${SHOTS}/1-uploading.png` });
  const deadline = Date.now() + 40_000;
  while (!seen.includes('fs.upload.commit') || seen.filter((x) => x === 'fs.upload.commit').length < 2) {
    if (Date.now() > deadline) fail(`no second commit; the agent saw ${JSON.stringify([...new Set(seen)])}`);
    await sleep(200);
  }
  await sleep(600);
  await page.screenshot({ path: `${SHOTS}/2-uploaded.png` });
  const dir = path.join(root, '.hegai-uploads');
  const landed = path.join(dir, NAME);
  assert.ok(existsSync(landed), `landed: ${readdirSync(dir).join(', ')}`);
  const sha = (x: Buffer) => createHash('sha256').update(x).digest('hex');
  assert.equal(sha(readFileSync(landed)), sha(bytes), 'same bytes');
  assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), '*\n', 'kept out of git');
  console.log('  ✓ landed byte for byte, next to a .gitignore');

  step('3. The turn names the file');
  await page.type('.composer textarea', 'посмотри файл');
  const turn = nextAgentFrame(agent.ws, 'input', 15_000);
  await page.evaluate(`document.querySelector('.composer button.send-round').click()`);
  const sent = await turn;
  assert.ok(sent.text.startsWith('посмотри файл'), sent.text);
  assert.ok(sent.text.includes(landed), sent.text);
  assert.equal(sent.files?.length ?? 0, 0, 'nothing inline');
  await sleep(500);
  await page.screenshot({ path: `${SHOTS}/3-sent.png` });
  console.log(`  ✓ ${JSON.stringify(sent.text)}`);

  step('4. The door is exactly that wide');
  const ask = (method: string, params: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> =>
    page.evaluate(
      `(() => new Promise((res) => {
        const ws = new WebSocket('ws://' + location.host + '/ui?workspaceId=${org}');
        ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === 'rpc_response') { ws.close(); res({ ok: m.ok, error: m.error }); } };
        ws.onopen = () => setTimeout(() => ws.send(JSON.stringify({ type: 'rpc_request', requestId: 'r' + Math.random(), machineId: ${JSON.stringify(agent.machineId)}, method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} })), 300);
      }))()`,
    ) as Promise<{ ok: boolean; error?: string }>;
  const before = seen.length;
  const base = { cwd: root, dir: '.hegai-uploads', name: 'x.bin', size: 1 };
  for (const [why, params] of [
    ['root itself', { ...base, dir: '' }],
    ['parent', { ...base, dir: '../' }],
    ['nested', { ...base, dir: '.hegai-uploads/a' }],
    ['another cwd', { ...base, cwd: path.dirname(root) }],
    ['path in name', { ...base, name: '../evil' }],
    ['overwrite', { ...base, overwrite: true }],
  ] as const) {
    const r = await ask('fs.upload.begin', params);
    assert.equal(r.ok, false, why);
  }
  for (const m of ['fs.write', 'fs.trash', 'fs.rename']) assert.equal((await ask(m, { cwd: root, path: 'x', content: 'x', from: 'a', to: 'b' })).ok, false, m);
  assert.equal((await ask('fs.upload.chunk', { uploadId: 'not-mine', offset: 0, data: 'AA==' })).ok, false, 'foreign upload');
  assert.equal(seen.length, before, 'none of it reached the agent');
  // A link out of the share in place of the folder: the agent's own check.
  const root2 = path.join(root, 'sub');
  mkdirSync(root2);
  symlinkSync('/tmp', path.join(root2, '.hegai-uploads'));
  await assert.rejects(() => uploads.begin(root2, '.hegai-uploads', 'x.bin', 1), 'a link out is refused by the agent');
  console.log('  ✓ everything else is refused');

  clearTimeout(timer);
  await browser.close();
  agent.ws.close();
  console.log(`\nPASS\n      screenshots: ${SHOTS}/`);
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e)));
