import { useCallback, useEffect, useRef, useState } from 'react';
import type { RuntimeJob, RuntimeStatus } from '@cc-remote/shared';
import type { CentralState } from '../useCentral.js';
import { claudeChip, claudeOff, codexChip, type RuntimeChip } from './runtimeChips.js';

/**
 * One machine's two runtimes, each a row that is either a fact («Claude · Max
 * 20x · owner@…») or ONE button that makes it one. The same rows sit on the
 * «Начало» screen and on the «Железо» card, so a person meets the same thing
 * in both places.
 *
 * A button starts a JOB on the machine (`runtime.install`,
 * `runtime.login.start`) and the row polls `runtime.job.status` every two
 * seconds while it runs: an RPC answer has 30 s, a login has as long as the
 * person takes. Codex logs in with a device code — the row shows the code and
 * a link to the page that takes it; Claude logs in through a page that hands
 * back a code, so the row grows a field to paste it into. When the job is
 * done the agent re-reads its runtimes and the chip turns green on its own;
 * the row shows «готово» until then.
 */

type Runtime = 'claude' | 'codex';
const RUNTIMES: Runtime[] = ['claude', 'codex'];
const NAMES: Record<Runtime, string> = { claude: 'Claude Code', codex: 'Codex' };
const POLL_MS = 2_000;
/** A «done» job that no newer runtime_status has cleared goes after this. */
export const DONE_FALLBACK_MS = 20_000;

function checkedAtOf(r: RuntimeStatus | undefined, runtime: Runtime): number {
  return (runtime === 'claude' ? r?.claude?.checkedAt : r?.codex?.checkedAt) ?? 0;
}

/** Is a finished job done with? The chip reads ok, or the agent's reading is
 *  newer than the one the job started against. */
export function clearsDoneJob(tone: RuntimeChip['tone'] | undefined, checkedAt: number, baselineAt: number | undefined): boolean {
  return tone === 'ok' || (baselineAt !== undefined && checkedAt > baselineAt);
}

function chipFor(runtime: Runtime, r: RuntimeStatus | undefined): RuntimeChip | undefined {
  if (runtime === 'claude') return r?.claude ? claudeChip(r.claude) : undefined;
  return r?.codex ? codexChip(r.codex) : undefined;
}

export function RuntimeRows({
  central,
  machineId,
  compact = false,
  only,
}: {
  central: CentralState;
  machineId: string;
  /** On the hardware card: chips and buttons only, no explanatory line. */
  compact?: boolean;
  /** Draw just this runtime's row (the composer's «войдите» notice). */
  only?: Runtime;
}) {
  const machine = central.machines.find((m) => m.machine.machineId === machineId);
  const runtimes = central.runtimes[machineId] ?? machine?.runtimes;
  const online = machine?.online === true;
  // Chat-only machines refuse runtime install/login (agent/src/policy.ts).
  const canAct = online && machine?.canControl !== false && machine?.machine.policy?.chatOnly !== true;
  const [jobs, setJobs] = useState<Partial<Record<Runtime, RuntimeJob>>>({});
  const [busy, setBusy] = useState<Partial<Record<Runtime, boolean>>>({});
  const [errors, setErrors] = useState<Partial<Record<Runtime, string>>>({});
  const [codes, setCodes] = useState<Partial<Record<Runtime, string>>>({});
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  /** The reading each running job started against. */
  const baseline = useRef<Partial<Record<Runtime, number>>>({});

  const setJob = useCallback((runtime: Runtime, job: RuntimeJob | undefined) => {
    setJobs((prev) => ({ ...prev, [runtime]: job }));
  }, []);

  // Poll every running job. One interval for both rows; a finished job stays
  // on screen until the chip catches up, then clears itself.
  useEffect(() => {
    const running = RUNTIMES.filter((r) => jobs[r]?.state === 'running');
    if (!running.length) return;
    const t = setInterval(() => {
      for (const r of running) {
        const j = jobsRef.current[r];
        if (!j || j.state !== 'running') continue;
        central
          .rpc<RuntimeJob>(machineId, 'runtime.job.status', { id: j.id }, true)
          .then((next) => setJob(r, next))
          .catch(() => {
            /* a missed poll is not a failed job */
          });
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [jobs, central, machineId, setJob]);

  // The chip is the truth: once it reads ok, the job that got it there is done
  // with. Also clears a stale «done» when the person opens the screen later.
  // And a finished job goes when the agent has said ANYTHING new about that
  // runtime since the job started: after «Установить» Codex reads «нет входа»,
  // not ok, so waiting for green left «Готово — обновляем…» up for good and
  // «Войти» only appeared after a reload (14.11.2026).
  useEffect(() => {
    for (const r of RUNTIMES) {
      const j = jobs[r];
      if (!j || j.state !== 'done') continue;
      if (clearsDoneJob(chipFor(r, runtimes)?.tone, checkedAtOf(runtimes, r), baseline.current[r])) setJob(r, undefined);
    }
  }, [runtimes, jobs, setJob]);

  // Fallback: no newer reading ever came (an old hub, a dropped frame). The
  // note must not outlive the job by more than a moment.
  const doneKey = RUNTIMES.map((r) => `${r}:${jobs[r]?.state === 'done' ? jobs[r]!.id : ''}`).join('|');
  useEffect(() => {
    const timers = RUNTIMES.filter((r) => jobs[r]?.state === 'done').map((r) => setTimeout(() => setJob(r, undefined), DONE_FALLBACK_MS));
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-armed only when a job turns done
  }, [doneKey, setJob]);

  const start = async (runtime: Runtime, action: 'install' | 'login') => {
    baseline.current[runtime] = checkedAtOf(runtimes, runtime);
    setBusy((b) => ({ ...b, [runtime]: true }));
    setErrors((e) => ({ ...e, [runtime]: undefined }));
    try {
      if (action === 'install') {
        const { jobId } = await central.rpc<{ jobId: string }>(machineId, 'runtime.install', { runtime });
        setJob(runtime, { id: jobId, kind: 'install', runtime, state: 'running' });
      } else {
        const job = await central.rpc<RuntimeJob>(machineId, 'runtime.login.start', { runtime });
        setJob(runtime, job);
      }
    } catch (err) {
      setErrors((e) => ({ ...e, [runtime]: (err as Error).message }));
    } finally {
      setBusy((b) => ({ ...b, [runtime]: false }));
    }
  };

  const sendCode = async (runtime: Runtime) => {
    const j = jobs[runtime];
    const code = (codes[runtime] ?? '').trim();
    if (!j || !code) return;
    setBusy((b) => ({ ...b, [runtime]: true }));
    try {
      await central.rpc<{ ok: boolean }>(machineId, 'runtime.login.input', { loginId: j.id, code });
      setCodes((c) => ({ ...c, [runtime]: '' }));
    } catch (err) {
      setErrors((e) => ({ ...e, [runtime]: (err as Error).message }));
    } finally {
      setBusy((b) => ({ ...b, [runtime]: false }));
    }
  };

  const cancel = async (runtime: Runtime) => {
    const j = jobs[runtime];
    if (!j) return;
    if (j.kind === 'login' && j.state === 'running') {
      try {
        await central.rpc<{ ok: boolean }>(machineId, 'runtime.login.cancel', { loginId: j.id }, true);
      } catch {
        /* the job times out on its own */
      }
    }
    setJob(runtime, undefined);
  };

  const copy = (text: string) => {
    try {
      void navigator.clipboard?.writeText(text);
    } catch {
      /* selection still works */
    }
  };

  if (!runtimes) {
    return (
      <div className={`rt-rows${compact ? ' compact' : ''}`}>
        <div className="rt-row">
          <span className="rt-name">Claude Code</span>
          <span className="rt-state"><span className="rt-status muted">нет данных — агент старой версии, обновится сам</span></span>
        </div>
        <div className="rt-row">
          <span className="rt-name">Codex</span>
          <span className="rt-state"><span className="rt-status muted">нет данных</span></span>
        </div>
      </div>
    );
  }

  return (
    <div className={`rt-rows${compact ? ' compact' : ''}`}>
      {RUNTIMES.filter((runtime) => (!only || runtime === only) && (runtime !== 'claude' || !claudeOff(runtimes))).map((runtime) => {
        const chip = chipFor(runtime, runtimes);
        const job = jobs[runtime];
        const err = errors[runtime];
        return (
          <div className={`rt-row${job?.state === 'running' ? ' running' : ''}`} key={runtime} data-runtime={runtime}>
            <span className="rt-name">{NAMES[runtime]}</span>
            <div className="rt-state">
              {chip ? <span className={`rt-status ${chip.tone}`} title={chip.detail ?? chip.hint}>{chip.tone === 'attn' && <span className="rt-mark" />}{statusText(chip)}</span> : <span className="rt-status muted">нет данных</span>}
            </div>
            <div className="rt-actions">
              {!canAct ? null : job?.state === 'running' ? (
                <>
                  {job.url && /^https:\/\//i.test(job.url) && (
                    <a className="btn primary" href={job.url} target="_blank" rel="noreferrer noopener">
                      Открыть страницу
                    </a>
                  )}
                  {job.userCode && (
                    <button className="btn" type="button" onClick={() => copy(job.userCode!)}>
                      Скопировать код
                    </button>
                  )}
                  {job.needsInput && (
                    <span className="rt-input">
                      <input
                        id={`rt-code-${machineId}-${runtime}`}
                        value={codes[runtime] ?? ''}
                        onChange={(e) => setCodes((c) => ({ ...c, [runtime]: e.target.value }))}
                        placeholder="код со страницы"
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <button className="btn primary" type="button" disabled={busy[runtime] || !(codes[runtime] ?? '').trim()} onClick={() => void sendCode(runtime)}>
                        Отправить
                      </button>
                    </span>
                  )}
                  <button className="btn" type="button" onClick={() => void cancel(runtime)}>
                    Отмена
                  </button>
                </>
              ) : job?.state === 'failed' || (chip?.action && !job) ? (
                <button
                  className={compact ? 'btn' : 'btn primary'}
                  type="button"
                  disabled={busy[runtime]}
                  onClick={() => void start(runtime, job?.kind === 'install' ? 'install' : (chip?.action ?? 'login'))}
                >
                  {busy[runtime] ? '…' : job?.state === 'failed' ? 'Повторить' : chip?.action === 'install' ? 'Установить' : 'Войти'}
                </button>
              ) : null}
            </div>
            {(job || err || (!compact && chip?.tone === 'attn' && chip.hint)) && (
              <div className="rt-job">
                {job?.state === 'running' && job.kind === 'install' && (
                <span className="rt-note">Устанавливаем {NAMES[runtime]} на машине… {job.tail ? <span className="rt-tail">{lastLine(job.tail)}</span> : null}</span>
              )}
                {job?.state === 'running' && job.kind === 'login' && job.userCode && (
                <span className="rt-note">
                  Введите код <b className="rt-code">{job.userCode}</b> на странице входа ChatGPT
                  {job.expiresAt ? ` — действует до ${new Date(job.expiresAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}` : ''}.
                </span>
              )}
                {job?.state === 'running' && job.kind === 'login' && job.needsInput && (
                <span className="rt-note">
                  {runtime === 'claude' ? 'Откроется браузер (или откройте ссылку), войдите подпиской Claude — в конце страница покажет код, вставьте его сюда.' : 'Откройте ссылку, войдите — и вставьте код сюда.'}
                </span>
              )}
                {job?.state === 'done' && <span className="rt-note">Готово — обновляем карточку…</span>}
                {job?.state === 'failed' && <span className="rt-note attn-text">Не получилось: {job.tail ? lastLine(job.tail) : 'без объяснения'}</span>}
                {err && <span className="rt-note attn-text">{err}</span>}
                {!compact && !job && chip?.tone === 'attn' && chip.hint && <span className="rt-hint">{chip.hint}</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The row already names the coder, so the status drops the prefix:
 *  «Claude · нет входа» → «нет входа», «Codex · Plus · me@x» → «Plus · me@x». */
function statusText(chip: RuntimeChip): string {
  return chip.label.replace(/^(Claude|Codex)\s*(·\s*)?/, '') || chip.label;
}

function lastLine(tail: string): string {
  const lines = tail.trim().split('\n').filter((l) => l.trim());
  return (lines[lines.length - 1] ?? '').slice(0, 200);
}
