import { useEffect, useState } from 'react';
import { AlertTriangle, Check, RefreshCw, X } from '../icons.js';
import type { CentralState } from '../useCentral.js';
import { QuestionModal } from '../components/QuestionModal.js';
import { useBuildWatch } from '../buildWatch.js';
import { PairKeyDialog } from '../components/PairKeyDialog.js';

/**
 * How long the socket may be away before we say so.
 *
 * Every ordinary load starts at `connecting`, and a reconnect after a laptop
 * lid or a phone unlock is usually over in well under a second. A banner with
 * no delay would therefore fire on the boot of every session and blink on every
 * wake — which teaches people to ignore it, and the one time it matters they
 * will.
 */
const OFFLINE_GRACE_MS = 2500;

/** Whether the hub has been unreachable long enough to be worth a banner. */
function useHubOffline(status: CentralState['status']): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (status === 'open') {
      setLate(false);
      return;
    }
    const t = setTimeout(() => setLate(true), OFFLINE_GRACE_MS);
    return () => clearTimeout(t);
  }, [status]);
  return late && status !== 'open';
}

/**
 * Everything that floats above the shell: the error toast and the tool-approval
 * surface. Interactive plan-mode tools get real choice UI; anything else falls
 * back to showing the raw tool input, which is the honest thing to do when we
 * cannot model the decision.
 */
export function ModalHost({
  central: c,
  suppressToolReq = false,
}: {
  central: CentralState;
  /** Another surface on screen already owns this run's approval — today that
   *  is a pane of the split, which runs its own session view and modal. The
   *  request is not dropped, only left to the copy that has the transcript
   *  under it; the hub's `tool_resolved` then clears this hook's copy too. */
  suppressToolReq?: boolean;
}) {
  // A newer build is being served than the one running here. Only ever shown
  // to someone who is LOOKING at the app — a backgrounded window takes the
  // update by itself (see buildWatch), which is the desktop app's whole case.
  const build = useBuildWatch();
  // The socket to the hub is down. This is the app's most consequential state
  // and it had no surface at all: the only tell was a coloured dot inside the
  // settings popover, i.e. behind a control you have to already suspect
  // something to open — and on a phone that popover is not even mounted. So a
  // dead socket looked exactly like a quiet afternoon: nothing arriving,
  // everything apparently fine, sends going nowhere.
  //
  // «Машина оффлайн» (Chat) is a different claim — that machine is gone, the
  // hub told us so. This one is that we cannot hear the hub at all, so every
  // other thing on screen is a snapshot of an unknown age.
  const offline = useHubOffline(c.status);
  return (
    <>
      <PairKeyDialog />
      {/* One floating strip at a time, and «новая версия» now OUTRANKS the
          offline notice. It used to be the other way round, on the reasoning
          that an update you cannot be told the state of is not the headline —
          but `stale` is only ever set after a SUCCESSFUL fetch of /w/, so it is
          itself proof the network works. And a build that cannot reach the hub
          is more often an old build than a dead hub, which makes the reload the
          likelier cure rather than the noise. Suppressing it here was the last
          door out of a stale shell, held shut by the symptom it would fix. */}
      {build.stale ? (
        <button type="button" className="build-update" onClick={build.reload}>
          <RefreshCw size={14} /> Вышла новая версия — обновить
        </button>
      ) : offline ? (
        <div className="hub-offline" role="status">
          <AlertTriangle size={14} />
          Нет связи с хабом — переподключаюсь
        </div>
      ) : null}
      {c.error && <div className="toast error">{c.error}</div>}
      {c.toolReq &&
        !suppressToolReq &&
        (c.toolReq.tool === 'AskUserQuestion' ||
        c.toolReq.tool === 'EnterPlanMode' ||
        c.toolReq.tool === 'ExitPlanMode' ? (
          <QuestionModal req={c.toolReq} onDecide={c.decideTool} />
        ) : (
          <div className="modal-backdrop">
            <div className="modal">
              <h3>
                <AlertTriangle size={18} /> Разрешить действие?
              </h3>
              <div className="tool-name">{c.toolReq.title ?? c.toolReq.tool}</div>
              {/* Codex sends a `reason` — its own sentence about why it is
                  asking — and it is the one part of the payload written for a
                  person. Buried inside the JSON dump it was read by nobody,
                  which turns «approve this?» into a question with no stated
                  grounds. */}
              {typeof (c.toolReq.input as Record<string, unknown> | undefined)?.['reason'] === 'string' && (
                <p className="tool-reason">
                  {(c.toolReq.input as Record<string, string>)['reason']}
                </p>
              )}
              <pre className="tool-input">{JSON.stringify(c.toolReq.input, null, 2)}</pre>
              <div className="modal-actions">
                <button className="btn danger" onClick={() => c.decideTool(false)}>
                  <X size={15} /> Запретить
                </button>
                <button className="btn primary" onClick={() => c.decideTool(true)}>
                  <Check size={15} /> Разрешить
                </button>
              </div>
            </div>
          </div>
        ))}
    </>
  );
}
