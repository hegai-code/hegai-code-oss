/**
 * What the layout ACTUALLY measures, on the device that is misbehaving.
 *
 * The bottom strip under the composer does not reproduce in Chrome at any
 * viewport, with either safe-area inset forced — so the numbers that matter
 * only exist on the phone, and the phone has no devtools. `?layout=1` prints
 * them ON the page, where they can be photographed.
 *
 * Deliberately harmless to ship: nothing runs unless the flag is in the URL,
 * and what it reads is viewport metrics and computed styles — no transcript,
 * no account, no network. Delete it once the strip is understood.
 */
export function measureLayout() {
  const selectors = [
    'html', 'body', '#root', '.app', '.app > .body', '.main-col', '.topbar',
    '.main', '.workspace', '.ws-main', '.ws-head', '.panel', '.chat', '.log',
    '.log-inner', '.composer', '.composer-box', '.composer-foot', '.sdrawer',
  ];
  const boxes = Object.fromEntries(selectors.map((selector) => {
    const el = document.querySelector(selector);
    if (!el) return [selector, null];
    const r = el.getBoundingClientRect();
    const css = getComputedStyle(el);
    return [selector, {
      top: r.top, bottom: r.bottom, left: r.left, width: r.width, height: r.height,
      clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop,
      display: css.display, heightCSS: css.height, minHeight: css.minHeight,
      paddingTop: css.paddingTop, paddingBottom: css.paddingBottom,
      marginTop: css.marginTop, marginBottom: css.marginBottom,
      flex: css.flex, boxSizing: css.boxSizing, position: css.position,
      overflow: css.overflow, transform: css.transform, borderRadius: css.borderRadius,
      clipPath: css.clipPath, boxShadow: css.boxShadow,
      backdropFilter: css.backdropFilter || css.getPropertyValue('-webkit-backdrop-filter'),
      composerHeight: css.getPropertyValue('--composer-h').trim(),
    }];
  }));
  const vv = window.visualViewport;
  const root = getComputedStyle(document.documentElement);
  return {
    viewport: {
      innerWidth, innerHeight, scrollY, clientHeight: document.documentElement.clientHeight,
      visual: vv && { height: vv.height, width: vv.width, offsetTop: vv.offsetTop, pageTop: vv.pageTop, scale: vv.scale },
      // `navigator.standalone` is Safari-only and absent from lib.dom — and it
      // is the one that answers for an iOS home-screen app, so it cannot just
      // be dropped in favour of the media query.
      standalone:
        matchMedia('(display-mode: standalone)').matches ||
        (navigator as Navigator & { standalone?: boolean }).standalone === true,
      coarse: matchMedia('(pointer: coarse)').matches,
      sat: root.getPropertyValue('--sat').trim(), sab: root.getPropertyValue('--sab').trim(),
    },
    composerGap: boxes['.composer-box'] ? innerHeight - boxes['.composer-box'].bottom : null,
    boxes,
  };
}

/**
 * The short version, big enough to read off a photograph of a phone.
 *
 * A full JSON dump is the right thing in a console and the wrong thing in a
 * screenshot — 400 lines at 6px tell nobody anything. This prints the dozen
 * numbers that decide where the strip comes from: whether the viewport is the
 * screen, whether each container reaches the bottom, and what the insets
 * actually report.
 */
export function mountLayoutProbe(): void {
  const render = () => {
    const m = measureLayout();
    const line = (k: string) => {
      const b = m.boxes[k];
      return b ? `${k.padEnd(14)} ${Math.round(b.top)}→${Math.round(b.bottom)} h${Math.round(b.height)} pb${b.paddingBottom}` : `${k.padEnd(14)} —`;
    };
    const v = m.viewport;
    // The card, only while the drawer is actually open — the second question
    // this has to answer, and the one that needs the app still usable
    // underneath: the corner is only ever drawn in that state.
    const card = m.boxes['.app > .body'];
    const drawer = m.boxes['.sdrawer'];
    // WHICH BUILD. Without it, «не обновилось» and «не помогло» look identical
    // from here, and both were said about the same afternoon — once truthfully
    // (a service worker pinned an old shell) and once not. The entry chunk's
    // hash IS the version; it is in the document that is running.
    const entry =
      document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')?.src ?? '';
    const root = getComputedStyle(document.documentElement);
    const text = [
      `BUILD ${entry.split('/').pop() || '—'}`,
      `ios-standalone "${document.documentElement.dataset.iosStandalone ?? ''}"  ` +
        `screen ${window.screen.width}×${window.screen.height}  ` +
        `measured ${root.getPropertyValue('--vp-measured').trim() || '—'}`,
      `inner ${v.innerWidth}×${v.innerHeight}  client ${v.clientHeight}`,
      `visual ${v.visual ? `${Math.round(v.visual.width)}×${Math.round(v.visual.height)} off${Math.round(v.visual.offsetTop)} sc${v.visual.scale}` : '—'}`,
      `sat ${v.sat || '?'}  sab ${v.sab || '?'}  standalone ${v.standalone}  coarse ${v.coarse}`,
      `GAP under box: ${m.composerGap}`,
      ...['html', 'body', '#root', '.app', '.app > .body', '.main-col', '.main', '.workspace', '.ws-main', '.panel', '.chat', '.log', '.composer', '.composer-box', '.composer-foot'].map(line),
      drawer ? `DRAWER OPEN  w${Math.round(drawer.width)}` : 'drawer closed',
      card ? `card radius ${card.borderRadius}  ovf ${card.overflow}` : '',
      card ? `card tf ${card.transform}` : '',
      card ? `card clip ${card.clipPath}` : '',
      m.boxes['.main-col'] ? `col clip ${m.boxes['.main-col']!.clipPath} radius ${m.boxes['.main-col']!.borderRadius}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    let el = document.getElementById('layout-probe');
    if (!el) {
      el = document.createElement('pre');
      el.id = 'layout-probe';
      // `pointer-events: none` is the whole point of the redesign: the first
      // version covered the screen and swallowed every tap, so the app could
      // not be DRIVEN while being measured — and half the questions here are
      // about a state you have to reach by tapping (the drawer open, a
      // recording running). It floats over the top instead and lets taps
      // through, and it re-measures on a timer so whatever you reach is what
      // it prints. No flag in the URL, no probe.
      el.setAttribute(
        'style',
        'position:fixed;left:0;right:0;top:0;z-index:99999;margin:0;padding:4px 6px;' +
          'pointer-events:none;max-height:58vh;overflow:hidden;' +
          'background:rgba(255,255,255,0.93);color:#000;' +
          'font:10px/1.3 ui-monospace,monospace;white-space:pre;',
      );
      document.body.appendChild(el);
    }
    el.textContent = text;
  };
  // After the shell has settled: measured at mount, every container is still
  // its initial size and the numbers describe a layout that lasted one frame.
  setTimeout(render, 900);
  setInterval(render, 1000);
  window.visualViewport?.addEventListener('resize', () => setTimeout(render, 200));
}
