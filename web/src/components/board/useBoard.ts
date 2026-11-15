import { useCallback, useEffect, useRef, useState } from 'react';
import { BOARD_SINCE_DEFAULT, BoardCard, BoardResponse, type BoardCardPatch } from '@cc-remote/shared';
import { apiJson } from '../../api.js';
import { teamApi } from '../../teamApi.js';
import type { Route } from '../../router.js';
import { applyPatch } from './boardModel.js';

export type BoardRoute = Extract<Route, { kind: 'board' }>;

/** Cards change once an hour; a person leaving the tab open still wants the
 *  board to be true when they look back at it. */
const POLL_MS = 3 * 60_000;

/**
 * The board's data: one HTTP fetch per filter set, kept fresh while the tab is
 * visible, with hand edits applied optimistically and reverted on refusal.
 *
 * HTTP, not the `/ui` socket, on purpose: the snapshot is the hot path every
 * pane pays for on every fleet delta, and the board is read by one screen once
 * an hour's worth of data changes. A slow answer (the hub scans SQLite) must
 * never overwrite a newer one, hence the request counter; a superseded fetch
 * is aborted rather than merely ignored.
 */
export function useBoard(route: BoardRoute) {
  const [data, setData] = useState<BoardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const seq = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const inflight = useRef(new Set<string>());

  const query = boardQuery(route);

  const load = useCallback(async () => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    const mine = ++seq.current;
    setRefreshing(true);
    try {
      const parsed = BoardResponse.parse(await apiJson<unknown>(`/api/board${query}`, { signal: ctrl.signal }));
      if (mine !== seq.current) return;
      setData(parsed);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (e) {
      if (ctrl.signal.aborted || mine !== seq.current) return;
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      if (mine === seq.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [query]);

  // Fetch on mount and whenever the filters change; keep the previous cards on
  // screen meanwhile so a filter click never flashes an empty board.
  useEffect(() => {
    void load();
    return () => abort.current?.abort();
  }, [load]);

  // Refetch on return to the tab and every few minutes while it is visible.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    let timer: number | null = null;
    const start = () => {
      if (timer !== null) return;
      timer = window.setInterval(() => void load(), POLL_MS);
    };
    const stop = () => {
      if (timer === null) return;
      window.clearInterval(timer);
      timer = null;
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void load();
        start();
      } else stop();
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [load]);

  const patch = useCallback(
    async (cardId: string, p: BoardCardPatch) => {
      if (inflight.current.has(cardId)) return; // one edit per card at a time
      inflight.current.add(cardId);
      let before: BoardResponse | null = null;
      setData((d) => {
        before = d;
        return d ? { ...d, cards: applyPatch(d.cards, cardId, p) } : d;
      });
      try {
        const returned = BoardCard.safeParse(await teamApi.patchBoardCard(cardId, p));
        if (returned.success) {
          setData((d) => (d ? { ...d, cards: d.cards.map((c) => (c.cardId === cardId ? returned.data : c)) } : d));
        }
      } catch (e) {
        setData(before);
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        inflight.current.delete(cardId);
      }
    },
    [],
  );

  return { data, loading, refreshing, error, updatedAt, refresh: load, patch };
}

/** The query string for a route — what the hub filters on. `since` is sent
 *  only when it is not the default; `project` covers a project label AND a
 *  roadmap area id (the hub matches both). */
export function boardQuery(route: BoardRoute): string {
  const parts: string[] = [];
  if (route.owner) parts.push(`owner=${encodeURIComponent(route.owner)}`);
  if (route.project) parts.push(`project=${encodeURIComponent(route.project)}`);
  if (route.since && route.since !== BOARD_SINCE_DEFAULT) parts.push(`since=${route.since}d`);
  return parts.length ? `?${parts.join('&')}` : '';
}
