import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { IconContext } from '@phosphor-icons/react';
import { App } from './App.js';
import { installMacChrome } from './shell/WindowChrome.js';
import { installChunkRecovery, warmMarkdownWhenIdle } from './bootstrap.js';
import { loadPublicConfig } from './publicConfig.js';
import './styles.css';

// Before the first paint, so the bar is never drawn under the traffic lights.
installMacChrome();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Regular, not fill: a.test's Icon is an outline at 1.5px, and filled
        glyphs at the 12–16px this UI uses read as solid blobs. */}
    <IconContext.Provider value={{ weight: 'regular' }}>
      <App />
    </IconContext.Provider>
  </StrictMode>,
);

/**
 * `?layout=1` — print the layout's own measurements over the app.
 *
 * The strip of empty space under the composer in the installed iOS app does
 * not reproduce in Chrome at any viewport, with either safe-area inset forced
 * to a phone's value. So the numbers that would explain it exist only on the
 * phone, and the phone has no devtools. This puts them on the screen, where
 * they can be photographed. Off unless the flag is present; tap to dismiss.
 */
if (new URLSearchParams(location.search).get('layout') === '1') {
  void import('./layoutProbe.js').then((m) => m.mountLayoutProbe());
}

warmMarkdownWhenIdle();
// Which edition this hub is and which ways in it offers: asked once, now, so the
// sign-in screen already knows by the time `/api/me` says «signed out».
// The tab is named after this hub's product (index.html says «Hegai Code») —
// on every route, the sign-in and setup pages included.
void loadPublicConfig().then((config) => {
  if (config?.brandName) document.title = config.brandName;
});

/**
 * How much screen lies BELOW the viewport — normally nothing.
 *
 * In an iOS standalone window with `black-translucent`, WebKit puts the page
 * origin at the physical top of the screen and then sizes the viewport as
 * though the status bar were still reserved. Measured on a 430×932 iPhone:
 * `innerHeight` is 873, every container correctly fills it, and 59pt of screen
 * sit below anything a page can address. That strip is the one taken from the
 * top: it did not disappear, it moved.
 *
 * Measured rather than guessed. Four attempts to fix this by reasoning about
 * safe-area arithmetic all changed a layout that was already correct, and a
 * media query that has to be right about which browser it is in would be a
 * fifth guess. Here, if the two heights agree — every other browser — the
 * value is 0 and nothing moves.
 *
 * Bounded at 120: a difference larger than that is not a status bar, it is a
 * window that is genuinely not full-screen (split view, a resized iPad), and
 * stretching into it would push the composer off the bottom.
 */
function measureShortViewport(): void {
  // `navigator.standalone` is iOS's own flag for "launched from the home
  // screen", and it exists NOWHERE else — not in Android Chrome, not in a
  // desktop PWA. That makes it the exact gate this needs, and a far better one
  // than `screen.height - innerHeight`: the previous attempt used that
  // subtraction and did not move the layout at all, which means iOS does not
  // report the two the way the arithmetic assumed. What it DOES report
  // correctly is the inset itself — the probe read `sat 59px` on the device,
  // and 59 is exactly the strip that went missing.
  const ios = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const apply = () => {
    document.documentElement.dataset.iosStandalone = ios ? '1' : '';
    // Kept for the probe: seeing both numbers on the device is what turns the
    // next «не помогло» into an answer instead of another round.
    document.documentElement.style.setProperty(
      '--vp-measured',
      `${Math.round(window.screen.height - window.innerHeight)}px`,
    );
  };
  apply();
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', () => setTimeout(apply, 200));
}
measureShortViewport();

installChunkRecovery();

/**
 * The offline shell. Registered only for a real build: under `vite dev` the
 * worker would sit in front of the dev server's own module graph and serve
 * yesterday's chunks to a hot reload.
 *
 * Registration is deferred to `load` on purpose — it competes with the first
 * render for exactly the bandwidth this split was meant to free.
 */
// Guarded exactly like `META_ENV` in router.ts: outside Vite there is no
// `import.meta.env` at all, and a bare read throws at module load.
const PROD = (import.meta as unknown as { env?: { PROD?: boolean } }).env?.PROD === true;
if (PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // A blocked or unsupported worker costs the offline start, nothing else.
    });
  });
}
