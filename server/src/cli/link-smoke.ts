/**
 * The reverse enrollment («connect this computer»), end to end with a real
 * browser on the deciding side and a fake machine on the asking side.
 *
 * What it proves, in order:
 *   1. a machine with no credential can ask the hub for a code
 *      (`POST /api/enrollments/request`, unauthenticated) and gets a code,
 *      a poll token and the page to open;
 *   2. polling before anyone decided says `pending`;
 *   3. a signed-in person opening `/link?c=…` sees the machine's own name and
 *      OS and presses «Подключить этот компьютер» — the machine is enrolled as
 *      theirs and the page says so;
 *   4. the machine's next poll carries the device token EXACTLY once (the
 *      one after says `used`), and that token opens the agent socket:
 *      register → register_ack;
 *   5. a denied request polls as `denied`; a code nobody minted is 404 on
 *      the page's lookup; the per-address request cap answers 429.
 *
 * Run it the same way as compact-smoke.ts (deploy/SMOKE-TESTS.md);
 * screenshots land in /tmp/link-smoke/.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { adminLogin, api, connectAgentWs, expectStatus, fail, nextAgentFrame, smokeTarget, chromePath, launchBrowser, step, evalJs } from './_harness.js';


const SHOTS = '/tmp/link-smoke';
const target = smokeTarget(process.argv);
const timer = setTimeout(() => fail('timed out (120s)'), 120_000);

async function request(name: string): Promise<{ userCode: string; pollToken: string; verifyUrl: string; machineId: string }> {
  const machineId = `link-smoke-${randomUUID().slice(0, 8)}`;
  const res = expectStatus('POST /api/enrollments/request', await api(target.http, undefined, 'POST', '/api/enrollments/request', { machine: { machineId, name, os: 'linux', agentVersion: 'smoke' } }), 201);
  const userCode = String(res.body['userCode'] ?? '');
  const pollToken = String(res.body['pollToken'] ?? '');
  const verifyUrl = String(res.body['verifyUrl'] ?? '');
  assert.match(userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/, `user code shape: ${userCode}`);
  assert.ok(pollToken.length > 20, 'poll token');
  assert.ok(verifyUrl.endsWith(`/link?c=${userCode}`), `verify url: ${verifyUrl}`);
  return { userCode, pollToken, verifyUrl, machineId };
}

async function poll(pollToken: string): Promise<Record<string, unknown>> {
  const res = await api(target.http, undefined, 'POST', '/api/enrollments/poll', { pollToken });
  assert.ok(res.status === 200, `poll -> ${res.status} ${res.text}`);
  return res.body;
}

async function main(): Promise<void> {
  if (!target.ssoSecret) fail('CC_REMOTE_SSO_SECRET is not set in this shell (must match the hub)');
  const secret = target.ssoSecret;
  mkdirSync(SHOTS, { recursive: true });
  console.log(`[link-smoke] hub ${target.http}  chrome ${chromePath()}`);

  step('1. A machine with no credential asks for a code');
  const req = await request('prod-eu-1');
  console.log(`  ✓ code ${req.userCode}, page ${req.verifyUrl}`);

  step('2. Nobody decided yet: pending');
  assert.equal((await poll(req.pollToken))['status'], 'pending');
  console.log('  ✓ poll -> pending');

  step('3. The person opens /link, sees the machine, presses «Подключить»');
  const owner = await adminLogin(target.http, secret);
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 800 });
  page.on('console', (m: { type: () => string; text: () => string }) => {
    if (m.type() === 'error') console.log(`  [browser error] ${m.text()}`);
  });
  const cookie = owner.cookie.split(';')[0] ?? '';
  const [cookieName, ...cookieRest] = cookie.split('=');
  await browser.setCookie({ name: (cookieName ?? '').trim(), value: cookieRest.join('='), domain: '127.0.0.1', path: '/' });
  await page.goto(`${target.http}/link?c=${req.userCode.toLowerCase()}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.link-card', { timeout: 20_000 });
  const facts = await evalJs<string>(page, `document.querySelector('.link-facts').textContent`);
  assert.match(facts, /prod-eu-1/, `the machine's name is shown (${facts})`);
  assert.match(facts, /Linux/, 'and its OS');
  await page.screenshot({ path: `${SHOTS}/1-request.png` });
  await page.evaluate(`Array.from(document.querySelectorAll('.link-actions .btn')).find((b) => /Подключить/.test(b.textContent)).click()`);
  await page.waitForFunction(`/Готово/.test(document.querySelector('.link-card h2')?.textContent || '')`, { timeout: 20_000 });
  await page.screenshot({ path: `${SHOTS}/2-approved.png` });
  console.log('  ✓ approved in the browser; the page says «Готово»');

  step('4. The machine polls: token once, then used; the token opens the socket');
  const approved = await poll(req.pollToken);
  assert.equal(approved['status'], 'approved', JSON.stringify(approved));
  const deviceToken = String(approved['deviceToken'] ?? '');
  assert.ok(deviceToken.length > 20, 'device token');
  assert.equal(approved['ownerUserId'], owner.userId, 'enrolled as the person who pressed');
  assert.equal((await poll(req.pollToken))['status'], 'used', 'the token is handed out once');
  const ws = await connectAgentWs(target.ws, deviceToken);
  const ack = nextAgentFrame(ws, 'register_ack');
  ws.send(JSON.stringify({ type: 'register', protocol: 1, machine: { machineId: req.machineId, name: 'prod-eu-1', os: 'linux', agentVersion: 'smoke' }, agentInstanceId: randomUUID() }));
  await ack;
  ws.close();
  console.log('  ✓ register_ack with the token the poll handed out');
  const devices = expectStatus('GET /api/devices', await api(target.http, owner.cookie, 'GET', '/api/devices'), 200);
  assert.ok(((devices.body['devices'] as Array<Record<string, unknown>>) ?? []).some((d) => d['machineId'] === req.machineId), 'the machine is on the owner’s device list');
  console.log('  ✓ listed among «Мои устройства»');

  step('5. Denied, unknown and the address cap are words, not silence');
  const req2 = await request('laptop');
  await page.goto(`${target.http}/link?c=${req2.userCode}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.link-card', { timeout: 20_000 });
  await page.evaluate(`Array.from(document.querySelectorAll('.link-actions .btn')).find((b) => /Не моя/.test(b.textContent)).click()`);
  await page.waitForFunction(`/Отклонено/.test(document.querySelector('.link-card h2')?.textContent || '')`, { timeout: 20_000 });
  assert.equal((await poll(req2.pollToken))['status'], 'denied');
  console.log('  ✓ «Не моя» -> poll says denied');
  expectStatus('GET /api/enrollments/request/ZZZZ-ZZZZ', await api(target.http, owner.cookie, 'GET', '/api/enrollments/request/ZZZZ-ZZZZ'), 404);
  // A dev hub (fleet token `dev-token`, loopback) answers an unauthenticated
  // request as the bootstrap owner — that is `fleet_token_opens_ui`, the
  // smoke CLIs' own door — so the 401 is asserted only where it can be.
  const anon = await api(target.http, undefined, 'GET', `/api/enrollments/request/${req2.userCode}`);
  if (/127\.0\.0\.1|localhost/.test(target.http)) console.log(`  · signed-out lookup on a dev hub -> ${anon.status} (bootstrap owner; a real hub answers 401)`);
  else assert.equal(anon.status, 401, 'a signed-out lookup is refused');
  console.log('  ✓ unknown code 404');
  // The stand has no nginx in front, so the hub's own per-address bucket is
  // what answers here: the address is unknown (no X-Real-IP) and shared by
  // every request of this run — 12 per hour, and we have spent 2.
  let last = 0;
  for (let i = 0; i < 12; i += 1) {
    last = (await api(target.http, undefined, 'POST', '/api/enrollments/request', { machine: { machineId: `cap-${i}`, name: 'cap', os: 'linux' } })).status;
    if (last === 429) break;
  }
  assert.equal(last, 429, 'the per-address request cap answers 429');
  console.log('  ✓ request cap -> 429');

  await browser.close();
  clearTimeout(timer);
  console.log(`\n[link-smoke] PASS — screenshots in ${SHOTS}/`);
}

main().catch((e) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e)));
