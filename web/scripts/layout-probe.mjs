/** Run in the page (or paste this function into Safari's console). No transcript,
 * account data or network requests: only viewport, styles and box geometry. */
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
      standalone: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
      coarse: matchMedia('(pointer: coarse)').matches,
      sat: root.getPropertyValue('--sat').trim(), sab: root.getPropertyValue('--sab').trim(),
    },
    composerGap: boxes['.composer-box'] ? innerHeight - boxes['.composer-box'].bottom : null,
    boxes,
  };
}
