import type { MachineSnapshot, SessionSummary } from '@cc-remote/shared';
import { DraftStore } from '../../composer.js';
import { navigate } from '../../router.js';
import { isAutomatedSession, sessionKey } from '../../lib.js';
import { absPath, quoteIfSpaces } from './paths.js';
import { storageSet } from '../../storage.js';

/**
 * Hand file paths to an agent.
 *
 * This is the hinge of the whole section. A file manager inside a tool whose
 * thesis is "the agent does the work" earns its place by being a drop-off point,
 * not by renaming things: material goes in, the agent picks it up. Everything
 * else here is navigation around this one action.
 *
 * It deliberately does NOT send the turn. The point is that the person's next
 * sentence («посмотри этот файл и…») follows the path; firing a bare path as a
 * message would start a run nobody asked for.
 */

/** Sessions worth offering, best first. */
export function offerableSessions(
  machine: MachineSnapshot | undefined,
  root: string,
): { near: SessionSummary[]; far: SessionSummary[] } {
  const all = (machine?.sessions ?? []).filter((s) => !isAutomatedSession(s));
  const near: SessionSummary[] = [];
  const far: SessionSummary[] = [];
  for (const s of all) {
    // A session whose cwd contains this root is working on the same thing — its
    // agent can open the path without being told where it is.
    const covers = s.cwd && (root === s.cwd || root.startsWith(`${s.cwd}/`) || s.cwd.startsWith(`${root}/`));
    (covers ? near : far).push(s);
  }
  const byRecency = (a: SessionSummary, b: SessionSummary): number => b.lastModified - a.lastModified;
  return { near: near.sort(byRecency).slice(0, 6), far: far.sort(byRecency).slice(0, 6) };
}

/** Append the paths to a session's draft and go there. */
export function handToSession(
  machineId: string,
  sessionId: string,
  root: string,
  rels: string[],
): void {
  const key = sessionKey(machineId, sessionId);
  const prev = DraftStore.load(key);
  const lines = rels.map((r) => quoteIfSpaces(absPath(root, r))).join('\n');
  DraftStore.save(key, prev ? `${prev}\n${lines}` : lines);
  // Chat seeds its draft in a useState initializer from this same store, and it
  // is unmounted while Files is on screen — so a fresh mount picks this up with
  // no prop drilling and no new plumbing, and it survives a reload.
  navigate({ kind: 'session', machineId, sessionId });
}

/** Carry the paths into a brand-new session in this project. */
export function handToNewSession(machineId: string, root: string, rels: string[]): void {
  const key = `new::${sessionKey(machineId, root)}`;
  const prev = DraftStore.load(key);
  const lines = rels.map((r) => quoteIfSpaces(absPath(root, r))).join('\n');
  DraftStore.save(key, prev ? `${prev}\n${lines}` : lines);
  // The key the start screen's project picker already reads. (Private mode:
  // the picker just opens on its default.)
  storageSet('cc-project', sessionKey(machineId, root));
  navigate({ kind: 'new' });
}

export function SendToSession({
  machine,
  machineId,
  root,
  rels,
  label = '→ в сессию',
}: {
  machine: MachineSnapshot | undefined;
  machineId: string;
  root: string;
  rels: string[];
  label?: string;
}) {
  const { near, far } = offerableSessions(machine, root);
  const disabled = !rels.length;

  return (
    // Deliberately NOT `.fl-more`: that class hides its summary until the table
    // row it lives in is hovered, which outside a row means "never visible".
    <details className="sts" onClick={(e) => e.stopPropagation()}>
      <summary className={`ghost sts-summary${disabled ? ' is-disabled' : ''}`} aria-label={label}>
        {label}
        {rels.length > 1 ? ` (${rels.length})` : ''}
      </summary>
      <div className="ws-more-pop sts-pop">
        {near.map((s) => (
          <button
            key={s.sessionId}
            type="button"
            className="ws-more-item"
            onClick={(e) => {
              (e.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
              handToSession(machineId, s.sessionId, root, rels);
            }}
          >
            {s.title || s.sessionId.slice(0, 8)}
          </button>
        ))}
        {far.length ? (
          <>
            <div className="sts-sep">другие сессии на этой машине</div>
            {far.map((s) => (
              <button
                key={s.sessionId}
                type="button"
                className="ws-more-item"
                onClick={(e) => {
                  (e.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
                  handToSession(machineId, s.sessionId, root, rels);
                }}
              >
                {s.title || s.sessionId.slice(0, 8)}
              </button>
            ))}
          </>
        ) : null}
        {/* Always last, and the only entry when nothing is open — which is an
            honest menu rather than an empty one. */}
        <button
          type="button"
          className="ws-more-item sts-new"
          onClick={(e) => {
            (e.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
            handToNewSession(machineId, root, rels);
          }}
        >
          Новая сессия здесь
        </button>
      </div>
    </details>
  );
}
