/**
 * Does the model picker give the message field back — and does it open where
 * it can be seen?
 *
 * Two properties, one control, neither photographable: focus is state, and a
 * popover's placement is only wrong in the window sizes nobody took a picture
 * of. The second half was added the day «при выборе модели модалка уезжает
 * наверх и не видна» came back from a laptop: on the start screen the composer
 * is near the TOP of its own scroller, the menu opened upward into 150px of
 * room it needed 230 for, and the model row was clipped off the edge — not
 * merely invisible but untappable, which is the part a screenshot understates.
 *
 * ---- 1. focus ---------------------------------------------------------
 *
 * On a phone this control opens out of a half-typed message with the keyboard
 * up. A `<button>` takes focus when tapped, the textarea loses it, and iOS
 * closes the keyboard — so choosing an effort level used to throw away both the
 * keyboard and the caret. RunPicker answers that twice over (`holdFocus` on
 * mousedown, `close()` restoring on the way out), and neither half is visible
 * in a screenshot: focus is state, not pixels, which is why this is a separate
 * run and not another row in shot.mjs.
 *
 * WHAT THIS CAN AND CANNOT PROVE. Headless Chrome has no software keyboard, so
 * nothing here asserts that iOS reopens one. What it does assert is the thing
 * the keyboard follows: that the textarea holds focus across opening the
 * picker, across drilling into the model list, and across every way of closing
 * it. If focus is wrong, the keyboard is certainly wrong; if focus is right,
 * the remaining risk is iOS's gesture rule — which is why `close()` is called
 * straight from the click handlers and never from an effect.
 *
 * Run: CHROME_PATH=… node scripts/picker-focus-check.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const WEB = fileURLToPath(new URL('..', import.meta.url));
// Not shot.mjs's 5199: the two are run back to back often enough that sharing a
// port means one `--strictPort` failure for no visible reason.
const PORT = 5201;

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error('No Chrome found. Set CHROME_PATH.');
  return found;
}

const vite = spawn('npx', ['vite', '--host', 'localhost', '--port', String(PORT), '--strictPort'], {
  cwd: WEB, stdio: 'ignore', shell: process.platform === 'win32',
});
function stopVite() {
  if (vite.exitCode !== null || vite.signalCode !== null) return;
  try {
    if (process.platform === 'win32' && vite.pid) {
      spawnSync('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' });
    } else vite.kill();
  } catch { /* already gone */ }
}
process.on('exit', stopVite);

const base = `http://localhost:${PORT}/screens.html`;
for (let i = 0; i < 60 && !(await fetch(base).then((r) => r.ok).catch(() => false)); i++) {
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await puppeteer.launch({ executablePath: findBrowser(), headless: 'new', args: ['--no-sandbox'] });
let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `  — ${detail}`}`);
  if (!ok) failed += 1;
};
/** What has focus, named the way a failure message wants to read. */
const focus = (page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return 'body';
    const cls = el.getAttribute('class');
    return `${el.tagName.toLowerCase()}${cls ? `.${cls.split(' ')[0]}` : ''}`;
  });

try {
  const page = await browser.newPage();
  // `hasTouch`/`isMobile`, or `@media (pointer: coarse)` never matches and the
  // composer is photographed — and here, DRIVEN — in its desk state. The picker
  // reads `matchMedia('(max-width: 860px)')` for `phone`, so the width matters
  // to the component and the touch flags matter to the CSS around it.
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  // `composerOpen` — the EXPANDED composer, which is the state a phone is in
  // while the keyboard is up and the only one where the model trigger exists
  // (`.composer-tools` is `display: none` while folded). The three obvious
  // alternatives are each wrong in their own way, and each cost a run here:
  // `modelpick` opens the picker on mount, while this has to open it ITSELF
  // out of a focused field; `session` is FOLDED, so the trigger is not
  // clickable; `dictationIdle` is mid-dictation, where the textarea is
  // `display: none` because the waveform has taken its slot — focus lands on
  // the body and every assertion below quietly means nothing.
  await page.goto(`${base}?screen=composerOpen&theme=light`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);

  const hasField = await page.$('.composer textarea');
  if (!hasField) throw new Error('fixture has no composer textarea — wrong screen?');
  await page.focus('.composer textarea');
  check('the field starts focused', (await focus(page)) === 'textarea', await focus(page));

  // The trigger only exists once the composer is expanded, which focus did.
  await page.click('.run-pick');
  await page.waitForSelector('.rp-modal', { timeout: 3000 });
  check('opening the picker leaves focus in the field', (await focus(page)) === 'textarea', await focus(page));

  // Placed from `visualViewport`, not from CSS. Headless Chrome has no
  // keyboard, so this cannot reproduce the failure it guards — the box being
  // centred on a viewport the keyboard is overlaying, and clipped off the top
  // of the screen. What it CAN prove is that the placement effect ran at all
  // (inline `top` is its fingerprint; CSS alone leaves it empty) and that the
  // result fits the visible strip. If the effect ever stops running, the box
  // silently goes back to CSS `50%` and the bug returns whole.
  const placed = await page.evaluate(() => {
    const el = document.querySelector('.rp-modal');
    const vv = window.visualViewport;
    const r = el.getBoundingClientRect();
    const top = vv ? vv.offsetTop : 0;
    const bottom = top + (vv ? vv.height : window.innerHeight);
    return { inline: el.style.top, fits: r.top >= top - 1 && r.bottom <= bottom + 1, r: `${Math.round(r.top)}→${Math.round(r.bottom)}`, strip: `${Math.round(top)}→${Math.round(bottom)}` };
  });
  check('the modal is placed from the visual viewport', placed.inline !== '', 'no inline top — the effect did not run');
  check('the modal fits the visible strip', placed.fits, `box ${placed.r} against ${placed.strip}`);

  // Drilling into the model list and back: two more taps that each used to
  // move focus onto a button and, on iOS, take the keyboard down with it.
  await page.click('.rp-modal .rp-head');
  await page.waitForSelector('.rp-modal .rp-back', { timeout: 3000 });
  check('drilling into the model list keeps it', (await focus(page)) === 'textarea', await focus(page));
  // Naming a model ENDS the visit on a phone — there is nothing left to
  // confirm, and leaving the modal up would park it over the message. Both
  // halves are asserted: the box is gone AND the field is back, because
  // closing while dropping focus would be the same bug wearing a new shape.
  const rows = await page.$$('.rp-modal .rp-row');
  await rows[1].click();
  await page
    .waitForFunction(() => !document.querySelector('.rp-modal'), { timeout: 3000 })
    .catch(() => {});
  check('choosing a model closes the picker', (await page.$('.rp-modal')) === null, 'still open');
  check('choosing a model keeps the field', (await focus(page)) === 'textarea', await focus(page));

  // …and the way out that chooses NOTHING, which is the path with no selection
  // handler to hang a restore on.
  await page.click('.run-pick');
  await page.waitForSelector('.rp-modal', { timeout: 3000 });
  // A CORNER, not `page.click('.rp-modal-scrim')`. Puppeteer aims at an
  // element's centre, and the scrim's centre is exactly where the modal now
  // sits — so that call pressed the dialog it meant to dismiss and the run
  // timed out waiting for a close that was never asked for.
  await page.mouse.click(8, 8);
  await page.waitForFunction(() => !document.querySelector('.rp-modal'), { timeout: 3000 });
  check('closing by the scrim returns the field', (await focus(page)) === 'textarea', await focus(page));
  await page.close();

  // ---- 2. placement, on a DESK ------------------------------------------
  // Above 860px there is no modal: the panel is anchored to the trigger and
  // opens upward, which is right in a session and wrong on the start screen —
  // see the note at the top. The fixture is `start` because that is where the
  // composer sits high enough for "upward" to run out of room.
  const desk = await browser.newPage();
  await desk.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await desk.goto(`${base}?screen=start&theme=light`, { waitUntil: 'networkidle0' });
  await desk.evaluate(() => document.fonts.ready);
  await desk.click('.run-pick');
  await desk.waitForSelector('.run-pick-pop', { timeout: 3000 });

  /**
   * Fits the box it may be SEEN in, and the first row takes a pointer.
   *
   * The clip box is not the window: this control lives inside the start
   * screen's scroller, whose top edge is under the top bar, and that edge is
   * what cut the panel. The hit test is the other half — a clipped row still
   * has a rect, so geometry alone would call an untappable menu fine.
   */
  const deskPlaced = (sel) =>
    desk.evaluate((rowSel) => {
      const pop = document.querySelector('.run-pick-pop');
      const btn = document.querySelector('.run-pick');
      let top = 0;
      let bottom = window.innerHeight;
      for (let n = btn.parentElement; n; n = n.parentElement) {
        if (getComputedStyle(n).overflowY === 'visible') continue;
        const r = n.getBoundingClientRect();
        top = Math.max(top, r.top);
        bottom = Math.min(bottom, r.bottom);
      }
      const r = pop.getBoundingClientRect();
      const row = pop.querySelector(rowSel)?.getBoundingClientRect();
      const hit = row && document.elementFromPoint(row.left + row.width / 2, row.top + row.height / 2);
      return {
        fits: r.top >= top - 1 && r.bottom <= bottom + 1,
        where: `${Math.round(r.top)}→${Math.round(r.bottom)} in ${Math.round(top)}→${Math.round(bottom)}`,
        reachable: !!hit && pop.contains(hit),
        hit: hit ? `${hit.tagName.toLowerCase()}.${(hit.getAttribute('class') || '').split(' ')[0]}` : 'nothing',
      };
    }, sel);

  let p = await deskPlaced('.rp-head');
  check('the desk popover fits where it can be seen', p.fits, `box ${p.where}`);
  check('the model row can actually be pressed', p.reachable, `point lands on ${p.hit}`);

  // The model list is the TALLER face — a panel that fitted as the compact one
  // can still run off an edge as the list, and this is the drill the report
  // was about.
  await desk.click('.run-pick-pop .rp-head');
  await desk.waitForSelector('.run-pick-pop .rp-back', { timeout: 3000 });
  p = await deskPlaced('.rp-row');
  check('the model LIST fits too', p.fits, `box ${p.where}`);
  check('a model row can be pressed', p.reachable, `point lands on ${p.hit}`);
} finally {
  await browser.close().catch(() => {});
  stopVite();
}

console.log(failed ? `\n${failed} failed` : '\nall clear');
process.exit(failed ? 1 : 0);
