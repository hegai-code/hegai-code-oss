import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { APP_INSTALL_COMMAND, guessDesktopOs } from '../src/lib.js';

const HUB = readFileSync(fileURLToPath(new URL('../../server-rs/src/main.rs', import.meta.url)), 'utf8');

/**
 * The commands the two screens hand out are pasted into a terminal by someone
 * who has nothing installed yet, so a wrong path is not a broken link — it is a
 * 404 saved to disk and run. The routes live in another language in another
 * workspace, which is exactly the kind of pair that drifts silently.
 */
test('the install commands point at routes the hub actually serves', () => {
  const origin = 'https://code.acme.test';
  for (const [os, route] of [['mac', '/install/app-mac-shell.sh'], ['win', '/install/app-win.ps1']] as const) {
    const command = APP_INSTALL_COMMAND[os](origin);
    assert.ok(command.includes(origin + route), `${os} command does not fetch ${route}: ${command}`);

    // Not just "the string appears somewhere". A commented-out route matches
    // that, and so does one pointing at a handler nobody wrote. Drop the
    // comment lines, collapse whitespace (rustfmt wraps a long `.route(` over
    // three lines — since 24.09.2026 the crate is formatted), then find the
    // live call, read the handler it names, and check that handler exists.
    const live = HUB.split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join(' ')
      .replace(/\s+/g, ' ');
    const escaped = route.replace(/[.\/]/g, '\\$&');
    // rustfmt leaves `.route( "…", get(h), )` — a space after the paren and a
    // trailing comma — so both are optional here.
    const line = new RegExp(`\\.route\\(\\s*"${escaped}",\\s*get\\(\\s*\\w+\\s*\\),?\\s*\\)`).exec(live)?.[0];
    assert.ok(line, `server-rs has no active .route("${route}", …) call`);

    const handler = /get\(\s*(\w+)\s*\)/.exec(line)!;
    assert.ok(handler, `${route} is routed, but not with a GET handler: ${line}`);
    assert.match(
      HUB,
      new RegExp(`fn\\s+${handler[1]}\\s*\\(`),
      `${route} is routed to ${handler[1]}, which main.rs does not define`,
    );
  }
});

/**
 * A route the hub serves is not the same as a route that installs the CURRENT
 * app, and for eight months it was not: `/install/app-mac.sh` answered 200 the
 * whole time while fetching `/dl/HegaiCode.zip` — the native SwiftUI client
 * retired on 21.09.2026, frozen at a build from 28.08 and no longer producible
 * from this repo. The check above would have passed happily. So pin the thing
 * that actually matters: the script the Mac command runs must pull the Tauri
 * shell, which is the only Mac client anything still builds.
 */
test('the Mac command installs the shell, not the retired native app', () => {
  const script = readFileSync(fileURLToPath(new URL('../../deploy/install-app-mac-shell.sh', import.meta.url)), 'utf8');
  assert.match(script, /\$DL\/HegaiCode-mac\.zip/, 'the Mac installer no longer fetches the shell build');
  // The build always comes from the vendor, never from the hub serving the
  // script: a customer's hub has no /dl and would answer with its index.html.
  assert.match(script, /^DL="\$\{CC_APP_DL:-https:\/\/code\.acme\.test\/dl\}" # vendor-literal$/m);
  assert.ok(!/\$BASE\/dl/.test(script), 'the Mac installer downloads from the hub');
  assert.match(script, /hub-url/, 'the Mac installer does not remember the hub');
  assert.ok(
    !APP_INSTALL_COMMAND.mac('https://code.acme.test').includes('/install/app-mac.sh'),
    'the Mac command points back at the retired native app',
  );
});

test('the Windows installer downloads from the vendor and remembers the hub', () => {
  const script = readFileSync(fileURLToPath(new URL('../../deploy/install-app-win.ps1', import.meta.url)), 'utf8');
  assert.match(script, /\$dl\/\$setupName/);
  assert.match(script, /'https:\/\/code\.acme\.test\/dl' } # vendor-literal/);
  assert.ok(!/\$base\/dl/.test(script), 'the Windows installer downloads from the hub');
  assert.match(script, /net\.hegai\.ccremote\.windows/);
});

/** Both are one line: they are pasted into a chat window before a terminal, and
 *  a wrapped multi-line block loses everything after the first newline. */
test('each install command survives being pasted as one line', () => {
  for (const build of Object.values(APP_INSTALL_COMMAND)) {
    assert.ok(!build('https://code.acme.test').includes('\n'));
  }
});

test('the OS guess reads the user agent, and everything that is not Windows is Mac', () => {
  assert.equal(guessDesktopOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131'), 'win');
  assert.equal(guessDesktopOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605'), 'mac');
  // No Linux client exists, so the switcher offers two choices and the copy at
  // the render site says so. Guessing 'mac' there is a starting position, not a
  // claim about the machine.
  assert.equal(guessDesktopOs('Mozilla/5.0 (X11; Linux x86_64) Firefox/133'), 'mac');
});

test('the /go one-liners, the Linux guess and the store links', async () => {
  const { GO_COMMAND, guessGoOs, isAndroidUa, isIosUa, PLAY_URL, APP_STORE_URL, isCustomHub, appConnectLink } = await import('../src/lib.js');
  assert.equal(GO_COMMAND.unix('https://code.acme.test'), 'curl -fsSL https://code.acme.test/go | bash');
  assert.equal(GO_COMMAND.win('https://code.acme.test'), 'irm https://code.acme.test/go.ps1 | iex');
  // macOS and Linux share one command; only Windows differs.
  assert.equal(guessGoOs('Mozilla/5.0 (X11; Linux x86_64) Firefox/133'), 'unix');
  assert.equal(guessGoOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605'), 'unix');
  assert.equal(guessGoOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131'), 'win');
  // Both routes the hub must serve exist (the UI hands them out).
  assert.ok(/"\/go"/.test(HUB) && /"\/go\.ps1"/.test(HUB), 'hub serves /go and /go.ps1');
  assert.equal(isIosUa('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604'), true);
  assert.equal(isAndroidUa('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/131 Mobile'), true);
  assert.match(PLAY_URL, /^https:\/\/play\.google\.com\/store\/apps\/details\?id=net\.hegai\.code$/);
  assert.match(APP_STORE_URL, /^https:\/\/apps\.apple\.com\//);
  assert.equal(isCustomHub('code.acme.test'), false);
  assert.equal(isCustomHub('hub.example.com'), true);
  // The phone apps parse exactly this shape (ios HubLink, android HubLink).
  assert.equal(appConnectLink('https://code.example.com'), 'ccremote://connect?hub=https%3A%2F%2Fcode.example.com');
  assert.equal(appConnectLink('https://hub.example.com:8443'), 'ccremote://connect?hub=https%3A%2F%2Fhub.example.com%3A8443');
});
