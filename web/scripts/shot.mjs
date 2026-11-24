/**
 * Look at a screen. `npm run shot --workspace web`
 *
 * Every screen in this app sits behind an SSO session and a live hub socket, so
 * "does it actually look right" used to be unanswerable without signing in and
 * hunting for the state by hand. The honest end of a UI change was "typecheck
 * and tests pass, I did not look" — and what that missed was ordinary: an
 * <a class="btn"> rendering underlined, a borrowed control stretching to a
 * thousand pixels, prose running 150 characters to the line.
 *
 * So: `screens.tsx` mounts one panel against stubbed data with the real
 * stylesheet, this drives the browser already on the machine, and the PNGs land
 * in `web/.shots/` (gitignored).
 *
 * It uses `puppeteer-core`, which is the driver WITHOUT a bundled Chromium —
 * nothing is downloaded at install time. `--window-size` alone would not do:
 * headless Chrome clamps the window at 500px, so a phone screenshot comes back
 * cropped rather than narrow, which reads as a layout bug that is not there.
 * Real device metrics need the protocol.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { measureLayout } from './layout-probe.mjs';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const OUT = `${WEB}.shots`;
// `SHOT_PORT` for a box where 5199 is already taken. On 26.09.2026 a Vite from
// a run six days earlier was still holding it: `--strictPort` failed, the run
// silently photographed THAT server's checkout, and a screen that did not exist
// there fell back to «Настройки» — seven green ticks for the wrong page.
const PORT = Number(process.env.SHOT_PORT) || 5199;

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36',
};

/** Chrome or Edge, wherever this machine keeps it. */
function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`No Chrome or Edge found. Set CHROME_PATH.\nLooked in:\n  ${candidates.join('\n  ')}`);
  return found;
}

/** Which screen, at which size, in which theme. Add rows, not one-off runs. */
const VIEWS = [
  // «Доска». Five columns of raised plates on a sunken well is the pairing
  // that has to hold in both themes; the 390 rows are where five columns
  // become a tab strip and the drawer becomes a sheet.
  { screen: 'board', width: 1440, height: 1000, theme: 'light' },
  { screen: 'board', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'boardDrawer', width: 1440, height: 1000, theme: 'light' },
  { screen: 'boardDrawer', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'boardPhone', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'boardPhone', width: 390, height: 844, theme: 'dark', dsf: 2 },
  { screen: 'boardDrawer', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'hardware', width: 1440, height: 1000, theme: 'light' },
  { screen: 'hardware', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'hardware', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'settings', width: 1440, height: 1000, theme: 'light' },
  { screen: 'settings', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'settings', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'settings', width: 390, height: 844, theme: 'dark', dsf: 2 },
  // First run (/w/start) and the four Настройки tabs (14.11.2026): three steps
  // of a full-screen flow, the public /app page, and every tab inside the real
  // strip. 390 is where the strip must not wrap, a <pre> must not push the page
  // sideways and the machine card's meters must stack.
  { screen: 'onboardMachine', width: 1440, height: 1000, theme: 'light' },
  { screen: 'onboardMachine', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'onboardMachine', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'onboardRuntimes', width: 1440, height: 1000, theme: 'light' },
  { screen: 'onboardRuntimes', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'onboardRuntimes', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'onboardPhone', width: 1440, height: 1000, theme: 'light' },
  { screen: 'onboardPhone', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'onboardPhone', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'appPage', width: 1440, height: 1000, theme: 'light' },
  { screen: 'appPage', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'appPage', width: 390, height: 844, theme: 'light', dsf: 2 },
  // A phone on a customer's hub: the QR lands here, not in the store.
  { screen: 'appPagePhoneExt', width: 390, height: 844, theme: 'light', dsf: 2, ua: 'iphone' },
  { screen: 'appPagePhoneExt', width: 390, height: 844, theme: 'dark', dsf: 2, ua: 'android' },
  { screen: 'appPageExt', width: 1440, height: 1000, theme: 'light' },
  { screen: 'setupDonePhone', width: 390, height: 844, theme: 'light', dsf: 2, ua: 'iphone' },
  { screen: 'settingsMachines', width: 1440, height: 1000, theme: 'light' },
  { screen: 'settingsMachines', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'settingsMachines', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'settingsApps', width: 1440, height: 1000, theme: 'light' },
  { screen: 'settingsApps', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'settingsApps', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'settingsAccount', width: 1440, height: 1000, theme: 'light' },
  { screen: 'settingsAccount', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'settingsAccount', width: 390, height: 844, theme: 'light', dsf: 2 },
  // A customer's own hub (self-host audit, 14.11.2026): account without the
  // org form and with a quiet delete, the people tab, the phone lines per app,
  // the empty home and the new-project dialog that says where it will create.
  { screen: 'settingsAccountExt', width: 1440, height: 1000, theme: 'light' },
  { screen: 'settingsAccountExt', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'teamPeopleExt', width: 1440, height: 1000, theme: 'light' },
  { screen: 'teamPeopleExt', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'settingsAppsExt', width: 1440, height: 1000, theme: 'light' },
  { screen: 'onboardMachineOnlineExt', width: 1440, height: 1000, theme: 'light' },
  { screen: 'onboardPhoneExt', width: 1440, height: 1000, theme: 'light' },
  { screen: 'onboardPhoneExt', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'newProject', width: 1440, height: 1000, theme: 'light' },
  { screen: 'newProject', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'startEmpty', width: 1440, height: 1000, theme: 'light' },
  { screen: 'startEmpty', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'settingsLook', width: 1440, height: 1000, theme: 'light' },
  { screen: 'settingsLook', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'settingsLook', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'hardwareTeam', width: 1440, height: 1000, theme: 'light' },
  { screen: 'hardwareTeam', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'hardwareTeam', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'hardwareFull', width: 1440, height: 1000, theme: 'light' },
  { screen: 'hardwareFull', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'hardwareFull', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'landing', width: 1440, height: 1000, theme: 'light' },
  { screen: 'landing', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'landing', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'landing', width: 390, height: 844, theme: 'dark', dsf: 2 },
  // «Доступ»: the ember «приостановлено» tile and the seat/sandbox chips are
  // the pair that has to hold ≥4.5:1 in both themes, and the narrow frame is
  // where five tabs and a four-chip row either wrap or push the page sideways.
  // «Расходы» — the team tab and the personal card; phone width because the
  // metrics grid has to wrap rather than push the page sideways.
  { screen: 'spend', width: 1440, height: 1000, theme: 'light' },
  { screen: 'spend', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'spend', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'spendMine', width: 390, height: 844, theme: 'dark', dsf: 2 },
  { screen: 'access', width: 1440, height: 1000, theme: 'light' },
  { screen: 'access', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'access', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'accessExt', width: 1440, height: 1000, theme: 'light' },
  { screen: 'accessExt', width: 390, height: 844, theme: 'light', dsf: 2 },
  // The transcript, at both widths it actually gets: a pane in the Колонки
  // lens and the full-width session view. The reading layout is the same CSS
  // in both, and a gutter that is right at 1440 can still be wrong at 380.
  { screen: 'columns', width: 1440, height: 1000, theme: 'light' },
  { screen: 'columnsStacked', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'columnsStacked', width: 390, height: 844, theme: 'dark', dsf: 2 },
  { screen: 'columns', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'transcript', width: 1440, height: 1000, theme: 'light' },
  { screen: 'liveTail', width: 520, height: 600, theme: 'light' },
  { screen: 'liveTail', width: 520, height: 600, theme: 'dark' },
  { screen: 'transcript', width: 390, height: 844, theme: 'light', dsf: 2 },
  // Dictation. The 390 rows are the ones that matter: `dsf > 1` is what turns
  // on hasTouch here, and with it the folded composer where the wave takes the
  // text field's slot — 28 bars added to a 390px row is exactly the shape of
  // change that pushes a page sideways, which this run already asserts against.
  { screen: 'dictation', width: 1440, height: 1000, theme: 'light' },
  { screen: 'dictation', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'dictation', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'dictationBusy', width: 1440, height: 1000, theme: 'light' },
  { screen: 'dictationBusy', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'dictationBusy', width: 390, height: 844, theme: 'dark', dsf: 2 },
  { screen: 'dictationIdle', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'dictationIdle', width: 390, height: 844, theme: 'dark', dsf: 2 },
  // The drawer under a phone's clock. This is the ONLY view with a non-zero
  // inset, and it exists because a grey band across the top of the PWA was
  // invisible to every other row in this file: with `sat` at 0 the strip that
  // breaks has no height.
  { screen: 'drawerInset', width: 390, height: 844, theme: 'light', dsf: 2, sat: 54, sab: 34 },
  { screen: 'drawerInset', width: 390, height: 844, theme: 'dark', dsf: 2, sat: 54, sab: 34 },
  // The session and the list under the same clock. `black-translucent` is what
  // makes iOS honour the inset rules at all, and these are the two screens
  // where "does the content clear the clock" is actually asked — the session's
  // own `.ws-head`, and the floating `.topbar` over a scroller.
  // 54/34 are an iPhone's real insets. The BOTTOM one is why these rows carry
  // both: it was 0 for as long as iOS reserved the home indicator itself, so
  // every `env(safe-area-inset-bottom)` in the stylesheet started applying on
  // the same day the app took the strips over, and a gap appeared under the
  // composer that no desk viewport can show.
  { screen: 'sessionInset', width: 390, height: 844, theme: 'light', dsf: 2, sat: 54, sab: 34 },
  { screen: 'sessionInset', width: 390, height: 844, theme: 'dark', dsf: 2, sat: 54, sab: 34 },
  { screen: 'sessionBusyInset', width: 390, height: 844, theme: 'light', dsf: 2, sat: 54, sab: 34 },
  { screen: 'sessionBusyInset', width: 390, height: 844, theme: 'dark', dsf: 2, sat: 54, sab: 34 },
  { screen: 'sessionHelpers', width: 1100, height: 900, theme: 'light' },
  { screen: 'sessionHelpers', width: 1100, height: 900, theme: 'dark' },
  { screen: 'sessionHelpers', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'fullInset', width: 390, height: 844, theme: 'light', dsf: 2, sat: 54, sab: 34 },
  // Dark too, and the phone especially: the turn's clock lives INSIDE the plate
  // now, and --text-faint on --chip is the one pairing where "is the time still
  // legible" has a different answer per theme.
  { screen: 'transcript', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'transcript', width: 390, height: 844, theme: 'dark', dsf: 2 },
  // The whole shell, which is the only fixture that shows the COMPOSER in
  // place. It existed and was never wired in here — judged by hand from
  // `.shots/full3-*`, `full4-*`, which is how the composer's control row got to
  // a phone without anyone seeing it at a phone's width.
  { screen: 'full', width: 1440, height: 1000, theme: 'light' },
  // The VS Code theme (Solarized Light): its own type, radii and palette, so
  // the shell, the transcript, the split and the phone each get a row.
  { screen: 'full', width: 1440, height: 1000, theme: 'vscode' },
  { screen: 'tabs', width: 1440, height: 1000, theme: 'vscode' },
  { screen: 'tabs', width: 1440, height: 1000, theme: 'light' },
  { screen: 'tabs', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'columns', width: 1440, height: 1000, theme: 'vscode' },
  { screen: 'transcript', width: 390, height: 844, theme: 'vscode', dsf: 2 },
  { screen: 'settings', width: 1440, height: 1000, theme: 'vscode' },
  { screen: 'full', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'full', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'full', width: 390, height: 844, theme: 'dark', dsf: 2 },
  // A session on a PHONE, and the drawer that is now its only chrome. This is
  // the screen the product is used on and the last one to get a fixture: the
  // top bar, the limits pill and the session title were all removed from it
  // without a single picture of what was being removed.
  { screen: 'session', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'session', width: 390, height: 844, theme: 'dark', dsf: 2 },
  // The panel behind the session TITLE, at the width where it is a SHEET. It
  // had no fixture, and that is how it came to answer a tap with nine
  // label/value rows and a scroll bar in front of its three buttons.
  { screen: 'sessionInfo', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'sessionInfo', width: 390, height: 844, theme: 'dark', dsf: 2 },
  { screen: 'modelpick', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'modelpick', width: 1440, height: 1000, theme: 'dark' },
  // The same menu with the level UNKNOWN. The only difference from the shot
  // above is whether the effort track draws a thumb — which is precisely why it
  // needs a picture: every assertion about the underlying value passed while the
  // control displayed `low` for a session running at `medium`.
  { screen: 'modelpickunset', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'modelpickunset', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'drawer', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'drawer', width: 390, height: 844, theme: 'dark', dsf: 2 },
  { screen: 'drawerTeam', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'drawerTeam', width: 390, height: 844, theme: 'dark', dsf: 2 },
  // ГЛАВНАЯ on a phone — the screen the product opens on, and until now the
  // only one with no picture at all. Three things are only checkable here: the
  // limits pill folded to one provider (it was deleted from the phone for being
  // too wide), «Сейчас в работе» against twelve live editor sessions, and the
  // shelf's «ещё N» now that it lengthens the card instead of opening a popover.
  { screen: 'start', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'start', width: 390, height: 844, theme: 'dark', dsf: 2 },
  { screen: 'start', width: 1440, height: 1000, theme: 'light' },
  // A desktop viewport with a 300px «Новый чат» pane. This must adapt to the
  // pane, not the viewport: otherwise model / mic / send overlap the agents.
  { screen: 'startColumn', width: 1440, height: 1000, theme: 'light' },
  { screen: 'startColumn', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'startColumnPick', width: 1440, height: 1000, theme: 'light', click: '.run-pick' },
  // «Ещё N» expands in place; it is not a dead trip to the already-open list.
  { screen: 'startExpanded', width: 1440, height: 1000, theme: 'light', click: '.sl-rest .sl-more' },
  // …and the model menu open ON it. `modelpick` shows this popover in a
  // session. Both now sit on the bottom edge, but the start dock also carries
  // the category shelf and changes height under a phone keyboard. Placement is
  // JS (RunPicker), so only a picture in BOTH contexts says it stayed visible.
  // «В отдельной ветке» on the start screen, and the diff review sheet with a
  // note left on a line (desk, dark desk, phone).
  { screen: 'startWorktree', width: 1440, height: 1000, theme: 'light', click: '.wt-check input' },
  { screen: 'startWorktree', width: 1440, height: 1000, theme: 'dark', click: '.wt-check input' },
  { screen: 'changes', width: 1440, height: 1000, theme: 'light', wait: '.rv-line', steps: [{ click: '.rv-line.ka' }, { type: ['.rv-draft textarea', 'Вынеси в константу и покрой тестом'] }, { click: '.rv-draft button[type=submit]' }] },
  { screen: 'changes', width: 1440, height: 1000, theme: 'dark', wait: '.rv-line', steps: [{ click: '.rv-line.ka' }, { type: ['.rv-draft textarea', 'Вынеси в константу и покрой тестом'] }, { click: '.rv-draft button[type=submit]' }] },
  { screen: 'changes', width: 390, height: 844, theme: 'light', dsf: 2, wait: '.rv-line', steps: [{ click: '.rv-line.ka' }, { type: ['.rv-draft textarea', 'Вынеси в константу'] }, { click: '.rv-draft button[type=submit]' }] },
  { screen: 'startpick', width: 1440, height: 1000, theme: 'light', click: '.run-pick' },
  { screen: 'startpick', width: 1280, height: 720, theme: 'dark', click: '.run-pick' },
  // And at a laptop width, where NONE of that applies — the title is back, the
  // ☰ is gone, and the drawer must not be reachable at all.
  { screen: 'session', width: 1440, height: 1000, theme: 'light' },
  // The enrichment strip (decisions + one-tap answers) under the tail turn.
  // The limits popup, OPEN — see `click`. One window sits in the 75–89% band on
  // purpose: that is the range whose class name used to collide with the
  // transcript's warning banner, and a fixture below the threshold proved
  // nothing about it.
  { screen: 'usage', width: 900, height: 760, theme: 'light', click: '.usage-pill' },
  { screen: 'usage', width: 900, height: 760, theme: 'dark', click: '.usage-pill' },
  // Generated pictures (24.10.2026): a finished one in the history, the live
  // placeholder with its bar, a live one that just finished, a failed one —
  // and the lightbox with its two actions, both widths.
  { screen: 'imageGen', width: 1440, height: 1800, theme: 'light' },
  { screen: 'imageGen', width: 1440, height: 1800, theme: 'dark' },
  { screen: 'imageGen', width: 390, height: 2000, theme: 'light', dsf: 2 },
  // Files an answer names (screenshot, markdown plan, a vanished file, a guessed
  // path): the strip, then the plan's sheet and the picture's lightbox open.
  { screen: 'filePreview', width: 1440, height: 700, theme: 'light', wait: '.fp-thumb img' },
  { screen: 'filePreview', width: 390, height: 844, theme: 'light', dsf: 2, wait: '.fp-thumb img' },
  { screen: 'filePreview', width: 390, height: 844, theme: 'dark', dsf: 2, wait: '.fp-thumb img' },
  { screen: 'filePreview', width: 390, height: 844, theme: 'light', dsf: 2, click: '.fp-chip:not(.missing):not(.pending)', settle: 500, tag: 'sheet', wait: '.fp-thumb img' },
  { screen: 'filePreview', width: 1440, height: 700, theme: 'dark', click: '.fp-chip:not(.missing):not(.pending)', settle: 500, tag: 'sheet', wait: '.fp-thumb img' },
  { screen: 'filePreview', width: 390, height: 844, theme: 'light', dsf: 2, click: '.fp-thumb', settle: 300, tag: 'lightbox', wait: '.fp-thumb img' },
  // Download states (Files panel) and the chat's file chips: progress, ready
  // (the second tap iOS needs), error; chips, then a tap on each kind.
  { screen: 'filesDownloading', width: 1440, height: 800, theme: 'light' },
  { screen: 'filesDownloading', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'filesReady', width: 1440, height: 800, theme: 'light' },
  { screen: 'filesReady', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'filesReady', width: 390, height: 844, theme: 'dark', dsf: 2 },
  { screen: 'filesError', width: 1440, height: 800, theme: 'light' },
  { screen: 'filesError', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'fileChips', width: 1440, height: 700, theme: 'light', wait: '.fp-file .fp-chip' },
  { screen: 'fileChips', width: 390, height: 844, theme: 'light', dsf: 2, wait: '.fp-file .fp-chip' },
  { screen: 'fileChips', width: 390, height: 844, theme: 'dark', dsf: 2, wait: '.fp-file .fp-chip' },
  { screen: 'fileChips', width: 390, height: 844, theme: 'light', dsf: 2, wait: '.fp-file .fp-chip', click: '.fp-file .fp-chip', settle: 600, tag: 'ready' },
  { screen: 'fileChips', width: 390, height: 844, theme: 'light', dsf: 2, wait: '.fp-file .fp-chip', click: '.fp-file:nth-child(3) .fp-chip', settle: 600, tag: 'error' },
  { screen: 'imageGenBox', width: 1440, height: 1000, theme: 'light', click: '.gen-open' },
  { screen: 'imageGenBox', width: 390, height: 844, theme: 'dark', dsf: 2, click: '.gen-open' },
  { screen: 'enrich', width: 1440, height: 1000, theme: 'light' },
  { screen: 'enrich', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'enrich', width: 390, height: 844, theme: 'light', dsf: 2 },
  // «Файлы»: the listing and the upload tray, then the shelf. Both themes,
  // because the ≥4.5:1 rule is unfalsifiable from one; and the phone width,
  // where the tree is gone and the tray must not cover the last row.
  { screen: 'files', width: 1440, height: 1000, theme: 'light' },
  { screen: 'files', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'files', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'files-grid', width: 1440, height: 1000, theme: 'light' },
  { screen: 'files-grid', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'files-grid', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'files-shelf', width: 1440, height: 1000, theme: 'light' },
  { screen: 'files-shelf', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'files-shelf', width: 390, height: 844, theme: 'dark', dsf: 2 },
  // The context column. Both themes because live rows, the source label and
  // the folded «Команда» header are four text tones stacked in a 300px
  // gutter, and ≥4.5:1 is unfalsifiable from one of them; the phone width
  // because the column becomes the whole screen there.
  { screen: 'sessions', width: 1440, height: 1000, theme: 'light' },
  { screen: 'sessions', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'sessions', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'sessions', width: 390, height: 844, theme: 'dark', dsf: 2 },
  { screen: 'sessionsNoisy', width: 1440, height: 1400, theme: 'light' },
  { screen: 'sessionsNoisy', width: 1440, height: 1400, theme: 'dark' },
  // «Мои · Команда · Все» (29.09.2026): the person cards, the author on rows,
  // and the switch itself quiet and lit.
  { screen: 'sessionsTeam', width: 1440, height: 1000, theme: 'light' },
  { screen: 'sessionsTeam', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'sessionsTeam', width: 1440, height: 1000, theme: 'light', panel: 260 },
  { screen: 'sessionsTeam', width: 1440, height: 1000, theme: 'dark', panel: 260 },
  { screen: 'sessionsAll', width: 1440, height: 1000, theme: 'light' },
  { screen: 'sessionsAll', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'sessionsAll', width: 1440, height: 1000, theme: 'light', panel: 260 },
  { screen: 'sessionsAll', width: 1440, height: 1000, theme: 'dark', panel: 260 },
  { screen: 'winTitleBar', width: 1440, height: 420, theme: 'light' },
  { screen: 'winTitleBar', width: 1440, height: 420, theme: 'dark' },
  // «Мои · Команда · Все» lives in the side panel since 13.10.2026; the
  // desktop bar no longer draws it, so its 1000px shots are gone.
  { screen: 'accountMenu', width: 1440, height: 900, theme: 'light' },
  { screen: 'accountMenu', width: 1440, height: 900, theme: 'dark' },
  { screen: 'sideScope', width: 1440, height: 900, theme: 'light' },
  { screen: 'sideScope', width: 1440, height: 900, theme: 'dark' },
  { screen: 'sideScopeTeam', width: 1440, height: 900, theme: 'light' },
  { screen: 'sideScopeTeam', width: 1440, height: 900, theme: 'dark' },
  { screen: 'scopeBarTeam', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'scopeBarTeam', width: 390, height: 844, theme: 'dark', dsf: 2 },
  { screen: 'scopeBarAll', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'scopeBarAll', width: 390, height: 844, theme: 'dark', dsf: 2 },
  { screen: 'sessionOther', width: 1000, height: 844, theme: 'light' },
  { screen: 'sessionOther', width: 1000, height: 844, theme: 'dark' },
  { screen: 'sessionOther', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'sessionOther', width: 390, height: 844, theme: 'dark', dsf: 2 },
  // The cloud browser's sheet (10.10.2026): the wide sheet over the shell,
  // while the screen connects, after the line dropped, with no exit to the
  // internet, and before there is a browser at all; then Настройки → Браузер.
  { screen: 'browser', width: 1440, height: 1000, theme: 'light' },
  { screen: 'browser', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'browser', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'browser', width: 390, height: 844, theme: 'dark', dsf: 2 },
  { screen: 'browserLost', width: 1440, height: 1000, theme: 'light' },
  { screen: 'browserLost', width: 390, height: 844, theme: 'dark', dsf: 2 },
  { screen: 'browserNoEgress', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'browserNoEgress', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'browserEmpty', width: 1440, height: 1000, theme: 'light' },
  { screen: 'browserEmpty', width: 390, height: 844, theme: 'dark', dsf: 2 },
  { screen: 'browserSettings', width: 1440, height: 1000, theme: 'light' },
  { screen: 'browserSettings', width: 1440, height: 1000, theme: 'dark' },
  { screen: 'browserSettings', width: 390, height: 844, theme: 'light', dsf: 2 },
  { screen: 'drawerMenu', width: 390, height: 844, theme: 'light', dsf: 2, click: '.sdrawer-cog' },
  { screen: 'drawerMenu', width: 390, height: 844, theme: 'dark', dsf: 2, click: '.sdrawer-cog' },
];

const only = process.argv[2];
/**
 * Одноразовая ширина — ТОЛЬКО для попарного сличения с телефоном.
 *
 * Строки выше остаются каноном («добавляй строки, а не запуски»): это не
 * замена им, а способ снять уже описанный экран на ширине ДРУГОГО клиента.
 * У `ios/scripts/shoot.sh` ширины прибиты к настоящим устройствам (375 / 393 /
 * 402 / 430), у веба — к 390, и кадры на 390 против 393 сравнивать можно, но
 * каждый раз приходится вслух оговариваться, что разница в три точки — не
 * расхождение клиентов. Дешевле снять на одной.
 */
const forceWidth = process.env.CC_WIDTH ? Number(process.env.CC_WIDTH) : null;
const picked = only ? VIEWS.filter((v) => v.screen === only) : VIEWS;
const views = forceWidth ? picked.map((v) => ({ ...v, width: forceWidth })) : picked;
if (!views.length) throw new Error(`No views for screen "${only}".`);

mkdirSync(OUT, { recursive: true });

// `--host localhost` overrides `host: true` from vite.config.ts. That setting
// exists so a phone on the same wifi can reach the dev server; a screenshot run
// only ever talks to itself, and publishing an unauthenticated build to the
// whole network for the duration is not part of taking a picture.
//
// `localhost` and not `127.0.0.1`: the page below is loaded by that same name,
// and Vite's HMR client dials whatever host served the page. Bind and URL
// disagreeing fails its WebSocket handshake with a 400 — harmless for a
// screenshot, but it lands as a console error, which this run counts as
// failure.
const vite = spawn('npx', ['vite', '--host', 'localhost', '--port', String(PORT), '--strictPort'], {
  cwd: WEB, stdio: 'ignore', shell: process.platform === 'win32',
});

/// Kill the SERVER, not the shell in front of it. On Windows `shell: true` means
/// the child is cmd.exe and `vite.kill()` leaves node running behind it, holding
/// the port — the next run then dies on `--strictPort` for no visible reason.
function stopVite() {
  if (vite.exitCode !== null || vite.signalCode !== null) return;
  try {
    if (process.platform === 'win32' && vite.pid) {
      spawnSync('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      vite.kill();
    }
  } catch { /* already gone */ }
}
process.on('exit', stopVite);

// Must match the `--host` above; see the note there.
const base = `http://localhost:${PORT}/screens.html`;
for (let i = 0; i < 60 && !(await fetch(base).then((r) => r.ok).catch(() => false)); i++) {
  await new Promise((r) => setTimeout(r, 250));
}

// Everything from here runs under `finally`: a `goto` that times out or a
// screenshot that throws must not leave a browser and a dev server running.
// Before this, one bad view leaked both and the port stayed held.
const browser = await puppeteer.launch({ executablePath: findBrowser(), headless: 'new', args: ['--no-sandbox'] });
let failed = 0;

try {
  for (const v of views) {
    const page = await browser.newPage();
    const problems = [];
    page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
    page.on('pageerror', (e) => problems.push(e.message));
    // A phone row is `dsf: 2`, and without `hasTouch` `@media (pointer: coarse)`
    // never matches — so the folded composer, the bottom sheets and every other
    // touch-only rule were being PHOTOGRAPHED IN THE WRONG STATE and the shot
    // quietly agreed with whatever the desk layout did.
    const touch = (v.dsf ?? 1) > 1;
    // Pages that branch on the phone's OS (`/app`, `/setup`) need its user agent.
    if (v.ua) await page.setUserAgent(UA[v.ua]);
    await page.setViewport({
      width: v.width, height: v.height, deviceScaleFactor: v.dsf ?? 1,
      hasTouch: touch, isMobile: touch,
    });
    // `sat` forces the safe-area top inset — the strip under a phone's clock,
    // which a desktop reports as 0. Without it the top bar, the drawer and the
    // scroller padding are all photographed in a layout no phone ever has.
    const sat = v.sat ? `&sat=${v.sat}` : '';
    const sab = v.sab ? `&sab=${v.sab}` : '';
    const panel = v.panel ? `&panel=${v.panel}` : '';
    await page.goto(`${base}?screen=${v.screen}&theme=${v.theme}${sat}${sab}${panel}`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);
    // Some panels only exist once something is pressed — the limits popup is
    // the case that taught us: its rows had never been photographed, so a row
    // over 75% wearing another component's styles shipped unseen.
    // Content that arrives after mount (a file preview is read lazily).
    if (v.wait) await page.waitForSelector(v.wait, { timeout: 8000 });
    if (v.click) {
      await page.waitForSelector(v.click, { timeout: 8000 });
      await page.click(v.click);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      // A sheet slides in; photograph (and measure) it where it stops.
      if (v.settle) await new Promise((r) => setTimeout(r, v.settle));
    }
    // Further presses and typing, in order: `{ click: sel }` or `{ type: [sel, text] }`.
    for (const step of v.steps ?? []) {
      if (step.click) {
        await page.waitForSelector(step.click, { timeout: 8000 });
        await page.click(step.click);
      } else if (step.type) {
        await page.waitForSelector(step.type[0], { timeout: 8000 });
        await page.type(step.type[0], step.type[1]);
      }
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    }

    // Anything reaching past the viewport. `body { overflow: hidden }` means such
    // content is not merely off-screen, it is unreachable — and a screenshot
    // cannot show it, being clipped at the same edge.
    const overflow = await page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      const named = (el) => {
        // SVG className is an SVGAnimatedString, which stringifies to
        // "[object SVGAnimatedString]" and names nothing. Use the attribute.
        const cls = el.getAttribute('class') || '';
        return `${el.tagName.toLowerCase()}${cls ? `.${cls.split(' ')[0]}` : ''}`;
      };
      return (
        [...document.querySelectorAll('body *')]
          // Geometry inside an <svg> is not a layout box: the outermost <svg>
          // clips to its own viewport by default, so a path whose bbox runs past
          // the page cannot be the unreachable-content bug this looks for. Icon
          // sets produce these constantly and they drowned the real findings.
          .filter((el) => !el.closest('svg'))
          // The app card while the phone's drawer is open is pushed off the
          // right edge ON PURPOSE (`.app:has(> .sdrawer) > .body`) — that IS
          // the drawer. What contains it is `html, body { overflow-x: hidden }`
          // on a phone, and the ancestor walk below stops before <body>
          // deliberately: exempting the body's own clip would exempt every
          // phone row and gut this check. So this one case says so by name.
          .filter((el) => !el.closest('.app:has(> .sdrawer) > .body'))
          // Content an ancestor CONTAINS is not unreachable, and this check only
          // wants the unreachable kind. Two ways to contain it, both false
          // alarms here before:
          //   - a horizontal SCROLLER (`overflow-x: auto/scroll`) — the Колонки
          //     strip, where panes are pages on a phone, and every tab row that
          //     scrolls instead of shoving the page sideways;
          //   - a CLIP (`overflow: hidden`) — `.team-row small` is ellipsised,
          //     yet `getBoundingClientRect()` reports geometry BEFORE clipping,
          //     so a long email read as 452px of overflow that no one can see
          //     and nothing can scroll to.
          // Three permanent false failures came from these, and a check that
          // always fails is a check nobody reads — which is how the real
          // overflow in the folded tool rows sat in this report unnoticed.
          .filter((el) => {
            for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
              const ox = getComputedStyle(p).overflowX;
              if (ox === 'hidden' || ox === 'clip') return false;
              // A scroller counts as "meant to page sideways" only if sideways is
              // the ONLY way it scrolls. That distinction is load-bearing: CSS
              // promotes `overflow-x` to `auto` on its own whenever the other
              // axis is not `visible`, so `.log` — a vertical transcript — reads
              // as a horizontal scroller too, and exempting it hid the very bug
              // this run was added to catch (the folded tool rows ran ~25px past
              // a 390px pane and the transcript scrolled sideways). The Колонки
              // strip is the real case: `overflow-y: hidden`, panes as pages.
              // The 2px slack is not a fudge: a tab row measured 39 against a
              // client height of 38 — one pixel of the active tab's underline —
              // and a strict `<=` read that as "this thing scrolls vertically
              // too", so a row that pages perfectly well sideways was reported
              // as broken. Anything genuinely scrolling down overshoots by far
              // more than a hairline.
              const pagesSideways =
                (ox === 'auto' || ox === 'scroll') &&
                p.scrollWidth > p.clientWidth &&
                p.scrollHeight <= p.clientHeight + 2;
              if (pagesSideways) return false;
            }
            return true;
          })
          .filter((el) => el.getBoundingClientRect().right > w + 1)
          // Report the OUTERMOST offender only: a row that overhangs drags every
          // span and icon inside it into the list, and forty names for one bug
          // is a report nobody reads.
          .filter((el) => !el.parentElement || el.parentElement.getBoundingClientRect().right <= w + 1)
          .map((el) => `${named(el)} → ${Math.round(el.getBoundingClientRect().right)}px (vw ${w})`)
      );
    });

    const name = `${v.screen}-${v.width}-${v.theme}${v.panel ? `-panel${v.panel}` : ''}${v.tag ? `-${v.tag}` : ''}`;
    // A PNG shows the gap, but cannot distinguish a short root viewport from
    // padding or an unexpectedly visible composer footer. Keep the geometry
    // beside it so a phone's layout can be compared to the same fixture.
    const layout = await page.evaluate(measureLayout);
    writeFileSync(`${OUT}/${name}.json`, JSON.stringify(layout, null, 2));
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
    const bad = [...overflow.map((o) => `overflows: ${o}`), ...problems];
    if (bad.length) failed += 1;
    console.log(`${bad.length ? '✗' : '✓'} ${name}${bad.length ? `  ${bad.join(' ; ')}` : ''}`);
    await page.close();
  }
} finally {
  await browser.close().catch(() => {});
  stopVite();
}

console.log(`
${views.length - failed}/${views.length} clean — ${OUT}`);
process.exit(failed ? 1 : 0);
