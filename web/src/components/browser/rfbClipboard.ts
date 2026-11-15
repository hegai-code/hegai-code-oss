import type RFB from '@novnc/novnc';

/**
 * Clipboard and Mac shortcuts for the cloud browser's noVNC screen.
 *
 * The server side already bridges X selections to VNC (`vncconfig` in the
 * runner), but noVNC never touches the OS clipboard by itself:
 *  - remote → local: the `clipboard` event carries the text, somebody has to
 *    write it with the Clipboard API;
 *  - local → remote: noVNC sends Ctrl+V as a bare key press, so the remote
 *    pastes BEFORE its clipboard knows the local text. The paste has to be
 *    held back until the text has been handed over with clipboardPasteFrom.
 *
 * Keys are matched by `code` (physical key), so Ctrl+C/V work on a Russian
 * layout too. On a Mac the browser sends Cmd; the remote is Linux and wants
 * Ctrl, so Cmd+letter is sent as Ctrl+letter.
 */

const XK_CONTROL_L = 0xffe3;
const XK_V = 0x76;
/** Latin letter or digit keysym for a physical key, whatever the layout. */
function plainKeysym(code: string): number | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3) + 32;
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  return undefined;
}
/**
 * WebKit (Safari, every iOS browser) raises no paste event on the screen's
 * non-editable canvas, so there the local text is asked for with readText —
 * which shows Safari's «Вставить» bubble, hence the long wait. Chromium and
 * Firefox get the paste event and never see a permission prompt.
 */
const WEBKIT =
  typeof navigator !== 'undefined' &&
  /AppleWebKit/.test(navigator.userAgent) &&
  !/Chrome|Chromium|Edg|OPR/.test(navigator.userAgent);
/** How long to wait for the local text before pasting what the remote has. */
const PASTE_WAIT_MS = WEBKIT ? 10_000 : 200;
/**
 * TigerVNC speaks the extended clipboard: noVNC only announces the text
 * (Notify), the server asks for it (Request) and only then gets it (Provide)
 * — a full round trip to the hub box. Ctrl+V goes out right after Provide (the
 * same socket keeps the order); this is the ceiling if Provide never comes.
 */
const PROVIDE_WAIT_MS = 1500;

/** Every extendedClipboardProvide noVNC sends, by socket. */
const provideListeners = new Set<(sock: unknown) => void>();
let provideHooked = false;
function hookProvide(rfb: RFB) {
  if (provideHooked) return;
  const messages = (rfb.constructor as { messages?: Record<string, unknown> }).messages;
  const original = messages?.extendedClipboardProvide;
  if (!messages || typeof original !== 'function') return;
  provideHooked = true;
  messages.extendedClipboardProvide = function (this: unknown, sock: unknown, ...rest: unknown[]) {
    const out = original.call(this, sock, ...rest);
    for (const l of provideListeners) l(sock);
    return out;
  };
}

export function attachClipboard(rfb: RFB, host: HTMLElement): () => void {
  let pendingWrite: string | null = null;
  let waitingPaste: { timer: ReturnType<typeof setTimeout> } | null = null;
  let ctrlHeld = false;
  hookProvide(rfb);
  // noVNC's private socket, pinned at 1.7.0; undefined → any Provide counts.
  const ownSock = (rfb as unknown as { _sock?: unknown })._sock;
  let provided: (() => void) | null = null;
  const onProvide = (sock: unknown) => {
    if (ownSock === undefined || sock === ownSock) provided?.();
  };
  provideListeners.add(onProvide);

  // Ctrl goes down first even when the person still holds it (noVNC on
  // Windows holds back a Ctrl press for 100 ms to spot AltGr — a repeated
  // press is harmless to X). It is released only if the person already let
  // go: releasing a held Ctrl turns their next Ctrl+A into a bare «a».
  const pressCombo = (keysym: number, code: string) => {
    const release = !ctrlHeld;
    rfb.sendKey(XK_CONTROL_L, 'ControlLeft', true);
    rfb.sendKey(keysym, code, true);
    rfb.sendKey(keysym, code, false);
    if (release) rfb.sendKey(XK_CONTROL_L, 'ControlLeft', false);
  };

  const writeLocal = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => {
        if (pendingWrite === text) pendingWrite = null;
      },
      // No user activation yet (Safari/Firefox): retry on the next key or click.
      () => {
        pendingWrite = text;
      },
    );
  };

  const onRemoteClipboard = (e: Event) => {
    const text = (e as CustomEvent<{ text?: string }>).detail?.text;
    if (typeof text === 'string') writeLocal(text);
  };

  const flushPending = () => {
    if (pendingWrite !== null) writeLocal(pendingWrite);
  };

  const finishPaste = (text: string | null) => {
    const w = waitingPaste;
    if (!w) return;
    waitingPaste = null;
    clearTimeout(w.timer);
    const press = () => pressCombo(XK_V, 'KeyV');
    // null = the local text is unknown: paste what the remote has. An empty
    // string is a real (empty) clipboard and is handed over like any other.
    if (text === null) return press();
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      provided = null;
      clearTimeout(t);
      press();
    };
    const t = setTimeout(go, PROVIDE_WAIT_MS);
    provided = go;
    rfb.clipboardPasteFrom(text);
  };

  const onPaste = (e: ClipboardEvent) => {
    if (!waitingPaste) return;
    e.preventDefault();
    finishPaste(e.clipboardData ? e.clipboardData.getData('text/plain') : null);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Control') ctrlHeld = true;
    const pasteKey = e.code === 'KeyV' && (e.ctrlKey || e.metaKey) && !e.altKey;
    // Not on a paste: a late remote write would race the text being pasted.
    if (!pasteKey) flushPending();
    if (e.isComposing) return;
    // Cmd itself never reaches the remote (noVNC would send it as Alt).
    if (e.key === 'Meta') {
      e.stopPropagation();
      return;
    }
    const cmd = e.metaKey && !e.ctrlKey;
    if (!cmd && !e.ctrlKey) return;
    if (pasteKey) {
      // Hold the paste until the local text has been handed over.
      e.stopPropagation();
      if (!e.repeat && !waitingPaste) {
        waitingPaste = { timer: setTimeout(() => finishPaste(null), PASTE_WAIT_MS) };
        if (WEBKIT) {
          navigator.clipboard?.readText?.().then(
            (t) => finishPaste(t),
            () => finishPaste(null),
          );
        }
      }
      return;
    }
    if (!cmd) return; // real Ctrl: noVNC passes it through as is
    // Cmd+letter → Ctrl+letter (Shift is already down on the remote, so
    // Cmd+Shift+Z arrives as Ctrl+Shift+Z). Other Cmd combos have no Linux
    // meaning and are dropped rather than typed as a bare key.
    e.preventDefault();
    e.stopPropagation();
    const keysym = e.altKey ? undefined : plainKeysym(e.code);
    if (keysym !== undefined) pressCombo(keysym, e.code);
  };

  // noVNC ignores the key-up of a key it never saw go down, so the swallowed
  // presses need nothing here except the Ctrl bookkeeping.
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === 'Control') ctrlHeld = false;
    if (e.key === 'Meta') e.stopPropagation();
  };

  // Back from another app: what the person copied there wins over a remote
  // copy that could not be written while the window was in the background.
  const onWindowFocus = () => {
    pendingWrite = null;
  };
  const onWindowBlur = () => {
    ctrlHeld = false;
  };

  rfb.addEventListener('clipboard', onRemoteClipboard);
  host.addEventListener('keydown', onKeyDown, true);
  host.addEventListener('keyup', onKeyUp, true);
  host.addEventListener('pointerdown', flushPending, true);
  document.addEventListener('paste', onPaste, true);
  window.addEventListener('focus', onWindowFocus);
  window.addEventListener('blur', onWindowBlur);
  return () => {
    rfb.removeEventListener('clipboard', onRemoteClipboard);
    host.removeEventListener('keydown', onKeyDown, true);
    host.removeEventListener('keyup', onKeyUp, true);
    host.removeEventListener('pointerdown', flushPending, true);
    document.removeEventListener('paste', onPaste, true);
    window.removeEventListener('focus', onWindowFocus);
    window.removeEventListener('blur', onWindowBlur);
    provideListeners.delete(onProvide);
    provided = null;
    if (waitingPaste) clearTimeout(waitingPaste.timer);
  };
}
