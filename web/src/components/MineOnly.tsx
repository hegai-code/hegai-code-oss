import { useCallback, useSyncExternalStore } from 'react';
import type { ActiveRunInfo, MachineSnapshot } from '@cc-remote/shared';
import { sessionIsMine, type SessionScope } from '../lib.js';

/**
 * Whose sessions the lists show — ONE store, read by every surface that lists
 * sessions (the side panel, the phone drawer, ⌘K, «Проекты» and a project's
 * page). A filter that one screen obeys and the next ignores is read as broken,
 * not as scoped, so there is no per-screen copy.
 *
 * **History, because it decides the shape.** This began as a «Только мои» chip,
 * on by default and remembered in localStorage. It was flipped once out of
 * curiosity and then silently kept showing a colleague's work for weeks — the
 * exact complaint it was built to answer — so on 2026-09 it became a rule with
 * no switch at all (7448655). On 29.09.2026 the switch came back, by request,
 * as «Мои · Команда · Все» in the top bar, and it is built so that trap cannot
 * recur:
 *
 * - **It is not remembered.** The value lives in this module and nowhere else:
 *   no localStorage, no sessionStorage. A reload, a new tab or a new window
 *   starts at «Мои». Looking at the team is something you do, not a state the
 *   app is left in.
 * - **It is visible while it is on.** The segment is lit in the top bar; on a
 *   phone a «Команда ✕» chip stays in the bar until you press it.
 * - **Only the people who run a team get it** (`canSwitchScope`, shell/workspace.ts).
 *   For everyone else the store never leaves «Мои».
 *
 * «Команда» (`TeamViews.tsx`) never consults this: those screens exist to show
 * other people's work.
 */
let value: SessionScope = 'mine';
/** Whether this viewer has the switch at all — App sets it from
 *  `canSwitchScope` (role only). While it is false the scope is pinned to
 *  «Мои», so a role change cannot leave the lists on a mode whose control has
 *  disappeared. */
let available = false;
const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(): void {
  for (const fn of listeners) fn();
}

function setScope(next: SessionScope): void {
  if (!available) next = 'mine';
  if (next === value) return;
  value = next;
  emit();
}

/** Called by App whenever `canSwitchScope` changes. */
export function setScopeAvailable(v: boolean): void {
  if (v === available) return;
  available = v;
  if (!v) value = 'mine';
  emit();
}

/** Does this viewer have the switch? */
export function useScopeAvailable(): boolean {
  return useSyncExternalStore(subscribe, () => available);
}

/** The shared scope and its setter. */
export function useSessionScope(): [SessionScope, (v: SessionScope) => void] {
  const scope = useSyncExternalStore(subscribe, () => value);
  const set = useCallback((next: SessionScope) => setScope(next), []);
  return [scope, set];
}

/** The old boolean, for call sites that only ask «is it just mine?». */
export function useMineOnly(): [boolean] {
  const [scope] = useSessionScope();
  return [scope === 'mine'];
}

/**
 * The same question as `sessionIsMine`, asked of an ACTIVE RUN.
 *
 * A run and its session are two views of one thing, and each carries half the
 * evidence: the run has `ownerUserId` the instant the hub opens it, the
 * session has the richer `owner` once the agent's debounced inventory mentions
 * it. Preferring the session and falling back to the run is what keeps a
 * session you just started from flickering out of your own list for the five
 * seconds before the agent reports it (`Board.tsx` does exactly this).
 *
 * The machine goes in whole because `sessionIsMine` needs both `owner` and
 * `shared` to read an ABSENT owner correctly — on a shared box it means
 * "nobody in particular", on a laptop it means "the person at the keyboard".
 */
export function runIsMine(
  run: Pick<ActiveRunInfo, 'machineId' | 'sessionId' | 'ownerUserId'>,
  machineById: Map<string, MachineSnapshot>,
  viewerId: string | undefined,
): boolean {
  const machine = machineById.get(run.machineId);
  const session = machine?.sessions.find((s) => s.sessionId === run.sessionId);
  const owner = session?.owner ?? (run.ownerUserId ? { userId: run.ownerUserId } : undefined);
  return sessionIsMine({ owner }, machine, viewerId);
}
