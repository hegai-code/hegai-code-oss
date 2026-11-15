/**
 * The cloud browser's VNC socket for `screens.tsx` — a stand-in that never
 * opens («Запускаю браузер…») or, on `?screen=browserLost`, drops at once
 * («Переподключить»). There is no hub behind the harness, so no real screen.
 *
 * A module of its own, imported FIRST by `screens.tsx`, because noVNC binds
 * `console.error` when it is evaluated: the dropped connection it reports
 * there is this fixture, not a fault, and must not fail the shot run — so the
 * filter has to be in place before noVNC is imported. Dev-only, like the
 * harness.
 */
const which = new URLSearchParams(location.search).get('screen') ?? '';

if (which.startsWith('browser')) {
  const lost = which === 'browserLost';
  class StandInSocket {
    binaryType = 'arraybuffer';
    protocol = '';
    readyState = 0;
    onopen: ((e: Event) => void) | null = null;
    onclose: ((e: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    constructor() {
      if (lost) setTimeout(() => this.close(), 30);
    }
    send() {}
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.onclose?.({ code: 1006, reason: '', wasClean: false });
    }
  }
  (window as unknown as { WebSocket: unknown }).WebSocket = StandInSocket;
  const err = console.error.bind(console);
  console.error = (...a: unknown[]) => {
    if (lost && a.some((x) => typeof x === 'string' && /Failed when connecting/.test(x))) return;
    err(...a);
  };
}
export {};
