/**
 * A hub socket that died without closing is noticed, replaced, and gives back
 * what was written into it.
 *
 * A laptop that slept or switched networks keeps a WebSocket that is OPEN on its
 * side and gone on the other. The page stayed on «Думаю 1041:32» overnight
 * (25.11.2026), took messages nobody received and never loaded history. No
 * structural check sees it: the socket never closes and `send()` never fails.
 *
 * A TCP proxy stands between a real Chrome and a real hub. Freezing it swallows
 * both directions of the live `/ui` connection WITHOUT closing it; new
 * connections pass. The page must reconnect by itself.
 *
 * The hub's PUBLIC_URL must be the proxy's address (the socket's Origin):
 *
 *   CC_REMOTE_PUBLIC_URL=http://127.0.0.1:4320 PORT=4319 … cc-remote-server
 *   CC_REMOTE_SSO_SECRET=<hub's> tsx server/src/cli/dead-socket-smoke.ts
 *
 * Takes about four minutes: the healthy minute and the two silent windows are
 * the point.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import {
  adminLogin,
  chromePath,
  enrollFakeAgent,
  evalJs,
  fail,
  fakeSession,
  launchBrowser,
  nextAgentFrame,
  smokeTarget,
  sleep,
  step,
} from './_harness.js';

const SHOTS = '/tmp/dead-socket-smoke';
const PROXY_PORT = Number(process.env.SMOKE_PROXY_PORT ?? 4320);
const HEALTHY_MS = Number(process.env.SMOKE_HEALTHY_MS ?? 90_000);
/** `SMOKE_BUSY=1`: the run is mid-turn when the link dies and keeps talking on
 *  the new socket. Its frames must not pass for «it heard us». */
const BUSY = process.env.SMOKE_BUSY === '1';
/** Keepalive (25 s) + two silent windows (2×30 s) + slack. */
const NOTICE_MS = 110_000;

const target = smokeTarget(process.argv);
const timer = setTimeout(() => fail('timed out (6m)'), 360_000);

interface Pair {
  client: net.Socket;
  frozen: boolean;
}
const ui: Pair[] = [];

function startProxy(hub: URL): Promise<void> {
  const server = net.createServer((client) => {
    const up = net.connect(Number(hub.port), hub.hostname);
    const pair: Pair = { client, frozen: false };
    let first = true;
    client.on('data', (d) => {
      if (first) {
        first = false;
        if (d.toString('latin1', 0, 8).startsWith('GET /ui')) ui.push(pair);
      }
      if (!pair.frozen) up.write(d);
    });
    up.on('data', (d) => {
      if (!pair.frozen) client.write(d);
    });
    const end = () => {
      if (pair.frozen) return;
      client.destroy();
      up.destroy();
    };
    client.on('close', end).on('error', end);
    up.on('close', end).on('error', end);
  });
  return new Promise((resolve) => server.listen(PROXY_PORT, '127.0.0.1', resolve));
}

const COMPOSER_JS = `(() => {
  const ta = document.querySelector('.composer textarea');
  return { text: ta ? ta.value : null, echoes: document.querySelectorAll('.log .msg.user').length };
})()`;
interface Composer {
  text: string | null;
  echoes: number;
}
const SEND = `document.querySelector('.composer button.send-round').click()`;

async function main(): Promise<void> {
  if (!target.ssoSecret) fail('CC_REMOTE_SSO_SECRET is not set in this shell (must match the hub)');
  mkdirSync(SHOTS, { recursive: true });
  await startProxy(new URL(target.http));
  const base = `http://127.0.0.1:${PROXY_PORT}`;
  console.log(`[dead-socket-smoke] hub ${target.http} behind ${base}  chrome ${chromePath()}`);

  step('1. Owner, a fake agent with one session, a real Chrome behind the proxy');
  const owner = await adminLogin(target.http, target.ssoSecret);
  const session = fakeSession('/home/smoke/proj', 'Сессия за прокси');
  const agent = await enrollFakeAgent(target, owner, { name: 'dead-socket-box', sessions: [session] });
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const [name, ...rest] = (owner.cookie.split(';')[0] ?? '').split('=');
  await browser.setCookie({ name: (name ?? '').trim(), value: rest.join('='), domain: '127.0.0.1', path: '/' });
  await page.goto(`${base}/w/s/${agent.machineId}/${session.sessionId}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.composer textarea', { timeout: 20_000 });

  step('2. First message: the run starts and goes idle');
  const resumed = nextAgentFrame(agent.ws, 'resume');
  const firstInput = nextAgentFrame(agent.ws, 'input');
  await page.type('.composer textarea', 'первое');
  await page.evaluate(SEND);
  const run = await resumed;
  await firstInput;
  const status = (state: string, extra: Record<string, unknown> = {}) =>
    agent.ws.send(JSON.stringify({ type: 'run_status', sessionId: run.sessionId, runId: run.runId, state, ...extra }));
  status('started', { taskStartedAt: Date.now() });
  agent.ws.send(
    JSON.stringify({
      type: 'stream',
      sessionId: run.sessionId,
      runId: run.runId,
      event: { kind: 'assistant', text: 'Готово.' },
    }),
  );
  if (!BUSY) status('idle');
  await page.waitForFunction(`document.body.innerText.includes('Готово.')`, { timeout: 10_000 });
  await page.screenshot({ path: `${SHOTS}/1-idle.png` });

  step(`3. ${HEALTHY_MS / 1000} quiet seconds on a healthy socket: no reconnect`);
  const before = ui.length;
  await sleep(HEALTHY_MS);
  assert.equal(ui.length, before, 'a quiet but living socket must not be replaced');
  console.log(`  ✓ still ${before} /ui connection(s)`);

  step('4. The link dies without closing; a message is written into it');
  for (const p of ui) p.frozen = true;
  let leaked = false;
  const onFrame = (raw: unknown) => {
    if (String(raw).includes('второе')) leaked = true;
  };
  agent.ws.on('message', onFrame);
  const frozenAt = Date.now();
  await page.type('.composer textarea', 'второе');
  if (BUSY) await page.keyboard.press('Enter');
  else await page.evaluate(SEND);
  await sleep(1_000);
  assert.equal((await evalJs<Composer>(page, COMPOSER_JS)).text, '', 'the page believes it was sent');
  await page.screenshot({ path: `${SHOTS}/2-sent-into-the-void.png` });

  step('5. The page notices by itself and reconnects');
  while (ui.length === before && Date.now() - frozenAt < NOTICE_MS) await sleep(500);
  assert.ok(ui.length > before, `no new /ui connection within ${NOTICE_MS / 1000}s`);
  console.log(`  ✓ a new socket after ${Math.round((Date.now() - frozenAt) / 1000)} s`);

  if (BUSY) {
    await sleep(1_500);
    agent.ws.send(
      JSON.stringify({ type: 'stream', sessionId: run.sessionId, runId: run.runId, event: { kind: 'assistant', text: 'Ещё работаю.' } }),
    );
  }

  step('6. The message comes back into the composer, and sending it again arrives');
  await page.waitForFunction(`(${COMPOSER_JS}).text === 'второе'`, { timeout: 20_000 });
  assert.equal(leaked, false, 'the frozen socket delivered nothing');
  await page.screenshot({ path: `${SHOTS}/3-text-is-back.png` });
  const second = nextAgentFrame(agent.ws, 'input', 15_000);
  // A busy run's button is «stop» until there is text; Enter sends either way.
  await page.focus('.composer textarea');
  if (BUSY) await page.keyboard.press('Enter');
  else await page.evaluate(SEND);
  assert.equal((await second).text, 'второе');
  const after = await evalJs<Composer>(page, COMPOSER_JS);
  assert.equal(after.text, '');
  await page.screenshot({ path: `${SHOTS}/4-delivered.png` });
  console.log('  ✓ delivered on the new socket');

  clearTimeout(timer);
  await browser.close();
  agent.ws.close();
  console.log(`\nPASS: dead link noticed, replaced, text returned and delivered\n      screenshots: ${SHOTS}/`);
  process.exit(0);
}

main().catch((e) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e)));
