/**
 * Dictation actually shows itself working.
 *
 * Pressing the microphone used to change one 40×40 button, and releasing it
 * changed nothing at all — through a GPU queue whose ceiling is 90 seconds.
 * The fix is a live waveform plus a «Распознаю…» state, and the failure mode
 * of that fix is specific and invisible in a screenshot: perfect markup over a
 * meter that never moves. A suspended AudioContext, an analyser nobody pulls,
 * a rAF that never started — all three render exactly the same picture as the
 * bug being fixed. So the assertion that matters is not «bars exist», it is
 * «a bar's transform is DIFFERENT 400ms later».
 *
 * What this drives: Chrome's synthetic microphone against the REAL
 * `useRecorder` and the REAL `DictationStrip`, through the `dictationLive`
 * fixture. The hub is deliberately absent — nothing between getUserMedia and
 * the DOM goes near it, and `/transcribe` is stubbed in the fixture so both
 * the success and the refusal path can be driven on demand.
 *
 * What it does NOT cover: the hub's `/transcribe` route and the GPU/Azure
 * backends behind it. Those have their own failure modes and their own logs.
 *
 *   CHROME_PATH=... tsx server/src/cli/dictation-smoke.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser, sleep, step } from './_harness.js';

const WEB = fileURLToPath(new URL('../../../web/', import.meta.url));
const SHOTS = '/tmp/dictation-smoke';
const PORT = 5201;
const BASE = `http://localhost:${PORT}/screens.html`;

/** Every bar's transform, as one string — the cheapest thing to compare. */
const WAVE_JS = `Array.from(document.querySelectorAll('.vwave i')).map((b) => b.style.transform).join('|')`;

async function main() {
  mkdirSync(SHOTS, { recursive: true });

  step('1. Vite on the fixture');
  const vite = spawn('npx', ['vite', '--host', 'localhost', '--port', String(PORT), '--strictPort'], {
    cwd: WEB,
    stdio: 'ignore',
  });
  const stopVite = () => {
    try {
      vite.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  };
  process.on('exit', stopVite);

  const browser = await launchBrowser({
    args: [
      // Chrome's synthetic beeping tone in place of a microphone, and the
      // permission prompt auto-granted. Without the second flag the page
      // simply never leaves `idle` and every assertion below reads as a
      // product bug.
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 700 });
    const errors: string[] = [];
    page.on('console', (m: { type: () => string; text: () => string }) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    // Vite's first cold transform of this graph is slow; retry rather than
    // guess a sleep.
    for (let i = 0; ; i++) {
      try {
        await page.goto(`${BASE}?screen=dictationLive`, { waitUntil: 'networkidle2', timeout: 20_000 });
        break;
      } catch (err) {
        if (i >= 5) throw err;
        await sleep(1500);
      }
    }
    await page.waitForSelector('.round-btn.mic', { timeout: 20_000 });
    console.log('  ✓ fixture up');

    step('2. Press the mic — the strip appears and the bars MOVE');
    await page.click('.round-btn.mic');
    await page.waitForSelector('.dict-strip', { timeout: 10_000 });
    await page.waitForSelector('.vwave i', { timeout: 10_000 });
    const bars = await page.$$eval('.vwave i', (els: Element[]) => els.length);
    assert.equal(bars, 28, 'the meter draws 28 bars');

    // The heart of it. Two samples 400ms apart: a dead analyser, a suspended
    // context or a loop that never started all leave these identical.
    await page.waitForFunction(`(${WAVE_JS}).length > 0`, { timeout: 5_000 });
    const a = await page.evaluate(WAVE_JS);
    await sleep(400);
    const b = await page.evaluate(WAVE_JS);
    await page.screenshot({ path: `${SHOTS}/1-recording.png` });
    assert.notEqual(a, b, 'the waveform is driven by the microphone, not standing still');
    console.log('  ✓ 28 bars, and the transforms changed within 400ms');

    const label = await page.$eval('.dict-label', (e: Element) => e.textContent);
    assert.equal(label, 'Запись');
    const hidden = await page.$eval('.composer-box textarea', (e: Element) =>
      getComputedStyle(e).display,
    );
    assert.equal(hidden, 'none', 'the wave takes the text field’s place while dictating');
    console.log('  ✓ «Запись», and the field has given up its slot');

    step('3. ✕ throws the clip away — no transcription, no text');
    await page.click('.dict-x');
    await page.waitForFunction('document.querySelector(".dict-strip") === null', { timeout: 10_000 });
    await sleep(1400); // longer than the fixture's 900ms transcribe stub
    const afterCancel = await page.$eval('[data-testid="text"]', (e: Element) => e.textContent);
    assert.equal(afterCancel, '', 'a cancelled recording produces nothing');
    const errAfterCancel = await page.$eval('[data-testid="err"]', (e: Element) => e.textContent);
    assert.equal(errAfterCancel, '', 'and it is not an error either');
    console.log('  ✓ cancelled cleanly');

    step('4. Record and stop — «Распознаю…», then the text');
    await page.click('.round-btn.mic');
    await page.waitForSelector('.vwave i', { timeout: 10_000 });
    await sleep(600); // some actual audio
    await page.click('.round-btn.mic');
    await page.waitForFunction(
      'document.querySelector(".dict-label")?.textContent === "Распознаю…"',
      { timeout: 10_000 },
    );
    const busy = await page.$eval('.vwave', (e: Element) => e.className);
    assert.match(busy, /busy/, 'the bars switch to the CSS march while recognising');
    const noCancel = await page.$('.dict-x');
    assert.equal(noCancel, null, 'there is nothing left to cancel once it is being read');
    await page.screenshot({ path: `${SHOTS}/2-transcribing.png` });
    console.log('  ✓ «Распознаю…» with the marching wave');

    await page.waitForFunction(
      'document.querySelector(\'[data-testid="text"]\')?.textContent?.startsWith("распознано")',
      { timeout: 15_000 },
    );
    await page.waitForFunction('document.querySelector(".dict-strip") === null', { timeout: 10_000 });
    console.log('  ✓ text delivered and the strip cleared');

    step('5. Send DURING the recording delivers, without going through the box');
    // What the draft holds right now — step 4 put a transcript there by the
    // microphone route, on purpose. The claim being tested is that THIS
    // recording does not touch it, so the baseline is "unchanged", not "empty".
    const draftBefore = await page.$eval('[data-testid="text"]', (e: Element) => e.textContent);
    await page.click('.round-btn.mic');
    await page.waitForSelector('.vwave i', { timeout: 10_000 });
    await sleep(600);
    // The send button, not the microphone. The microphone stops into the
    // composer; this one is supposed to stop AND deliver, and the failure worth
    // catching is it quietly taking the draft route instead.
    await page.click('.send-round');
    await page.waitForFunction(
      'document.querySelector(\'[data-testid="sent"]\')?.textContent?.startsWith("распознано")',
      { timeout: 15_000 },
    );
    const strayDraft = await page.$eval('[data-testid="text"]', (e: Element) => e.textContent);
    assert.equal(
      strayDraft,
      draftBefore,
      'a dictation sent with the send button must not ALSO land in the draft',
    );
    await page.waitForFunction('document.querySelector(".dict-strip") === null', { timeout: 10_000 });
    console.log('  ✓ delivered straight out, nothing left in the composer');

    step('6. A refused transcription clears the strip too — it must not hang');
    await page.goto(`${BASE}?screen=dictationLive&fail=1`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.round-btn.mic', { timeout: 10_000 });
    await page.click('.round-btn.mic');
    await page.waitForSelector('.vwave i', { timeout: 10_000 });
    await sleep(600);
    await page.click('.round-btn.mic');
    await page.waitForFunction(
      'document.querySelector(\'[data-testid="err"]\')?.textContent?.includes("недоступно")',
      { timeout: 15_000 },
    );
    await page.waitForFunction('document.querySelector(".dict-strip") === null', { timeout: 10_000 });
    await page.screenshot({ path: `${SHOTS}/3-refused.png` });
    console.log('  ✓ refusal named, strip gone');

    // The recorder's own warnings are expected on the refusal path; anything
    // else in the console is this smoke's problem.
    const unexpected = errors.filter((e) => !/\[recorder]/.test(e));
    assert.deepEqual(unexpected, [], 'no unexpected console errors');

    console.log(`\n✅ dictation-smoke passed — shots in ${SHOTS}`);
  } finally {
    await browser.close();
    stopVite();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`\n❌ dictation-smoke failed:\n${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  },
);
