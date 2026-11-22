import { useState } from 'react';
import type { ViewerContext } from '@cc-remote/shared';
import type { CentralState } from '../useCentral.js';
import { Check } from '../icons.js';
import { ConnectMachine } from './ConnectMachine.js';
import { PhoneApps, usePhonePromise } from './PhoneApps.js';
import { RuntimeRows } from './RuntimeRows.js';
import { machineHasLogin, useMachinePick } from './useMachinePick.js';

/**
 * The first screens after signing in: computer · Claude and Codex · phone.
 *
 * Full screen, outside the settings shell — an instruction read once does not
 * belong behind a tab. `ControlPlaneApp` returns it by itself while the person
 * has no machine of their own or no coder signed in on any of them, until they
 * finish or skip it; `/w/start` opens it by hand. Everything live is the real
 * thing (`RuntimeRows` logs in through the agent), and a step turns «done» by
 * itself when the machine appears or the login lands.
 */
const STEPS = ['Компьютер', 'Claude и Codex', 'Телефон'] as const;

export function Onboarding({ central, viewer, onFinish, initialStep = 0 }: {
  central: CentralState;
  viewer?: ViewerContext | null;
  onFinish: () => void;
  initialStep?: number;
}) {
  const [step, setStep] = useState(initialStep);
  const pick = useMachinePick(central);
  const { own, machine, machineId } = pick;
  const online = own.filter((m) => m.online);
  const hasMachine = online.length > 0;
  const signedIn = own.some((m) => machineHasLogin(central, m) && hasLoginReport(central, m));
  const done = [hasMachine, signedIn, false];
  const last = step === STEPS.length - 1;
  return (
    <div className="onb">
      <div className="onb-col">
        {/* Wide: three labelled steps, a check on the finished ones. Narrow: ONE
            line («Шаг 1 из 3 · Компьютер») and a three-segment bar — three
            labels do not fit 390px, and unlabelled marks say nothing. */}
        <ol className="onb-steps" aria-label="Шаги">
          {STEPS.map((label, i) => (
            <li key={label} className={`onb-step${i === step ? ' current' : ''}${done[i] ? ' done' : ''}`} aria-current={i === step ? 'step' : undefined}>
              <span className="onb-step-mark" aria-hidden="true">{done[i] ? <Check size={12} /> : i + 1}</span>
              <span className="onb-step-label">{label}</span>
            </li>
          ))}
        </ol>
        <div className="onb-progress" role="group" aria-label="Шаги">
          <p className="onb-progress-line">Шаг {step + 1} из {STEPS.length} · {STEPS[step]}</p>
          <div className="onb-progress-bar" aria-hidden="true">
            {STEPS.map((label, i) => <span key={label} className={i <= step || done[i] ? 'filled' : ''} />)}
          </div>
        </div>
        <section className="onb-card">
          {step === 0 && <StepMachine central={central} viewer={viewer} pick={pick} />}
          {step === 1 && <StepRuntimes central={central} machineId={machineId} machineName={machine?.machine.name} online={machine?.online === true} own={own.length} pick={pick} />}
          {step === 2 && <StepPhone />}
        </section>
        <div className="onb-nav">
          <button className="btn onb-skip" onClick={onFinish}>Пропустить</button>
          <span className="onb-nav-gap" />
          {step > 0 && <button className="btn" onClick={() => setStep(step - 1)}>Назад</button>}
          {last
            ? <button className="btn primary" onClick={onFinish}>Готово</button>
            : <button className="btn primary" onClick={() => setStep(step + 1)}>Дальше</button>}
        </div>
      </div>
    </div>
  );
}

/** «Signed in» for the step's tick needs a REAL report, not the benefit of the
 *  doubt `machineHasLogin` gives an old agent. */
function hasLoginReport(central: CentralState, m: CentralState['machines'][number]): boolean {
  const r = central.runtimes[m.machine.machineId] ?? m.runtimes;
  return !!r && (!!r.claude || !!r.codex);
}

type Pick = ReturnType<typeof useMachinePick>;

function StepMachine({ central, viewer, pick }: { central: CentralState; viewer?: ViewerContext | null; pick: Pick }) {
  const online = pick.own.filter((m) => m.online);
  const sandbox = (viewer ?? central.viewer)?.access?.sandbox;
  const pendingSandbox = sandbox && (sandbox.status === 'queued' || sandbox.status === 'running');
  const { shellAgent } = pick;
  return (
    <>
      <h1 className="onb-title">{online.length > 0 ? 'Компьютер подключён' : 'Подключите компьютер'}</h1>
      {online.length > 0 ? (
        <>
          <p className="onb-lead">Агент на связи — сессии этой машины уже видны здесь.</p>
          <ul className="onb-machines">
            {online.map((m) => (
              <li key={m.machine.machineId} className="onb-machine">
                <span className="hw-dot on" />
                <span className="onb-machine-name" title={m.machine.name}>{m.machine.name}</span>
                <span className="onb-machine-meta">{(central.machineStats[m.machine.machineId] ?? m.stats)?.platform ?? m.machine.os}</span>
              </li>
            ))}
          </ul>
          <details className="onb-more">
            <summary>Подключить ещё</summary>
            <ConnectMachine />
          </details>
        </>
      ) : (
        <>
          {pendingSandbox && (
            <p className="onb-lead">Ваша песочница «{sandbox.machineName ?? 'Песочница'}» готовится — обычно две-пять минут. Она появится сама.</p>
          )}
          {shellAgent && (shellAgent.phase === 'installed' || shellAgent.phase === 'checking') ? (
            // «installed» can come before the machine is online (the shell counts
            // an agent without a device token as installed): never a blank step.
            <p className="onb-lead">Агент на этом компьютере стоит — ждём, пока он выйдет на связь. Обычно это секунды; если не появляется, подключите его командой ниже.</p>
          ) : shellAgent ? (
            <p className={`onb-lead${shellAgent.phase === 'failed' ? ' attn-text' : ''}`}>
              {shellAgent.phase === 'installing'
                ? 'Приложение подключает этот компьютер — ставит агента, обычно минута-две. Ничего делать не нужно.'
                : shellAgent.phase === 'signed_out'
                  ? 'Этот компьютер подключится сам, как только вы войдёте.'
                  : shellAgent.phase === 'waiting'
                    ? `Этот компьютер подключится позже: ${shellAgent.reason ?? 'ждём хаб'}.`
                    : shellAgent.phase === 'disconnected'
                      ? 'Этот компьютер отключён от сервера. Чтобы подключить снова — меню Hegai Code в трее/строке меню → «Подключить этот компьютер».'
                      : `Не удалось поставить агента на этот компьютер: ${shellAgent.reason ?? 'причина не передана'}. Подключите его командой ниже.`}
            </p>
          ) : null}
          {!shellAgent || shellAgent.phase === 'failed' || shellAgent.phase === 'waiting' ? (
            <ConnectMachine />
          ) : (
            <details className="onb-more">
              <summary>Подключить командой</summary>
              <ConnectMachine />
            </details>
          )}
        </>
      )}
    </>
  );
}

function StepRuntimes({ central, machineId, machineName, online, own, pick }: {
  central: CentralState;
  machineId?: string;
  machineName?: string;
  online: boolean;
  own: number;
  pick: Pick;
}) {
  return (
    <>
      <h1 className="onb-title">Войдите в Claude и Codex</h1>
      <p className="onb-lead">Подписка ваша, общего ключа нет: лимиты тратите только вы.</p>
      {machineId ? (
        <>
          {own > 1 ? (
            <label className="onb-pick">
              Машина
              <select value={machineId} onChange={(e) => pick.setPicked(e.target.value)}>
                {pick.own.map((m) => (
                  <option key={m.machine.machineId} value={m.machine.machineId}>
                    {m.machine.name}{m.online ? '' : ' · офлайн'}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="team-help">Машина: <b>{machineName}</b>{online ? '' : ' — сейчас не на связи, кнопки появятся, когда агент подключится'}.</p>
          )}
          <RuntimeRows central={central} machineId={machineId} />
        </>
      ) : (
        <p className="team-help">Сначала подключите компьютер на предыдущем шаге — здесь появятся строки Claude Code и Codex с кнопкой «Войти».</p>
      )}
    </>
  );
}

function StepPhone() {
  const { notifications } = usePhonePromise();
  return (
    <>
      <h1 className="onb-title">Телефон</h1>
      <p className="onb-lead">{notifications ? 'Нужен, только если хотите отвечать агенту и получать уведомления с телефона — шаг можно пропустить.' : 'Нужен, чтобы отвечать агенту с телефона — шаг можно пропустить.'}</p>
      <PhoneApps />
    </>
  );
}
