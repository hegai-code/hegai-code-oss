/**
 * Notices a hub socket that died without saying so.
 *
 * A laptop that slept, changed Wi-Fi or toggled a VPN can be left holding a
 * WebSocket that is OPEN on this side and gone on the other: no `close`, no
 * `error`, and `send()` keeps accepting text nobody receives. The page then
 * sits on «Думаю 1041:32», every message is a bubble without an answer and the
 * history never loads, until somebody reloads it (25.11.2026, the desktop app
 * on a Mac). A browser gives a page no WebSocket-level ping, so the page asks
 * for an answer itself: `ping` → `pong`.
 *
 * Slow is not dead. One frame can take a long time on a bad link and the page
 * hears nothing until all of it is in, so a socket is condemned only after TWO
 * silent windows in a row (more when the previous one was condemned young), never while it is still draining what we sent, and
 * never on a timer that fired late (a suspended page must ask again first). A
 * hub that has not answered a `pong` yet is never judged by the lack of one.
 */
export const PING_EVERY_MS = 25_000;
/** One silent window after a ping. */
export const PROBE_MS = 30_000;
/** Silent windows in a row that mean «dead». */
export const PROBE_MISSES = 2;
/** A handshake that neither opened nor failed. */
export const OPEN_MS = 30_000;
/** How late a timer may fire before its verdict says nothing about the hub. */
export const LATE_MS = 5_000;
/** A socket condemned this soon after opening doubles the patience for the next
 *  one: a frame that takes longer than the verdict to arrive would otherwise be
 *  asked for and cut off forever. */
export const YOUNG_MS = 10 * 60_000;
/** The most patience backing off can reach, in silent windows. */
export const MAX_MISSES = 8;

export interface SocketWatchDeps {
  /** Send a `ping`; false when there is no open socket to send it on. */
  ping: () => boolean;
  /** Bytes the socket has accepted and not yet put on the wire. */
  buffered: () => number;
  /** The socket is dead: abandon it and reconnect. Called at most once per socket. */
  dead: () => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export interface SocketWatch {
  connecting: () => void;
  opened: () => void;
  closed: () => void;
  /** Any frame from the hub; `pong` when it was the answer to a ping. */
  inbound: (pong: boolean) => void;
  /** Ask now. Does nothing while an earlier question is still open. */
  probe: () => void;
  /** Nothing has been heard since the last question. */
  asking: () => boolean;
  /** Stop expecting an answer (a hushed page asked the hub for silence). */
  hold: () => void;
}

export function createSocketWatch(deps: SocketWatchDeps): SocketWatch {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let timer: unknown;
  // This page has heard a `pong`: its hub answers, so silence means something.
  let answers = false;
  let misses = 0;
  let limit = PROBE_MISSES;
  let openedAt: number | null = null;
  let pendingBytes = 0;

  const stop = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    misses = 0;
  };
  const arm = (ms: number, verdict: () => void, again: () => void) => {
    const due = now() + ms;
    timer = setTimer(() => {
      timer = undefined;
      if (now() - due > LATE_MS) again();
      else verdict();
    }, ms);
  };
  const dead = () => {
    stop();
    if (openedAt !== null) limit = now() - openedAt < YOUNG_MS ? Math.min(limit * 2, MAX_MISSES) : PROBE_MISSES;
    openedAt = null;
    deps.dead();
  };
  const ask = () => {
    if (!deps.ping()) {
      stop();
      return;
    }
    pendingBytes = deps.buffered();
    arm(
      PROBE_MS,
      () => {
        const left = deps.buffered();
        if (!answers || (left > 0 && left < pendingBytes)) misses = 0;
        else misses += 1;
        if (misses >= limit) dead();
        // An old hub stays silent by design: the next keepalive asks again.
        else if (answers) ask();
      },
      () => {
        misses = 0;
        ask();
      },
    );
  };
  return {
    connecting() {
      stop();
      const wait = () => arm(OPEN_MS, dead, wait);
      wait();
    },
    opened() {
      stop();
      openedAt = now();
      ask();
    },
    closed: stop,
    inbound(pong) {
      if (pong) answers = true;
      stop();
    },
    probe() {
      if (timer === undefined) ask();
    },
    asking: () => timer !== undefined,
    hold: stop,
  };
}
