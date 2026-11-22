import type { CentralState } from '../useCentral.js';
import { RuntimeRows } from './RuntimeRows.js';
import { runtimeGate, runtimeHint } from './runtimeChips.js';

/**
 * The composer refuses to start a run on a machine whose chosen coder is not
 * installed or not signed in (as far as the machine has said): the CLI's own
 * answer was the raw «Not logged in · Please run /login» in the transcript and
 * a session stuck «в работе», neither of which can be acted on from the web.
 * Instead this notice sits above the composer with the same «Войти» /
 * «Установить» button the machine card has.
 */

const NAMES = { claude: 'Claude', codex: 'Codex' } as const;

export function gateText(runtime: 'claude' | 'codex', machineName: string, gate: 'install' | 'login'): string {
  return gate === 'install'
    ? `${NAMES[runtime]} на ${machineName} не найден — установите, и можно писать`
    : `${NAMES[runtime]} на ${machineName} не вошёл — войдите, и можно писать`;
}

/** The notice for a runtime that is probably unusable but does not block
 *  sending (`runtimeHint` without `runtimeGate`). */
export function hintText(runtime: 'claude' | 'codex', machineName: string, hint: 'install' | 'login'): string {
  return hint === 'install'
    ? `${NAMES[runtime]} на ${machineName} не установлен — установите или выберите другого агента`
    : `${NAMES[runtime]} на ${machineName} не вошёл в аккаунт — войдите или выберите другого агента`;
}

export function RuntimeGate({
  central,
  machineId,
  runtime,
  soft,
}: {
  central: CentralState;
  machineId: string;
  runtime: 'claude' | 'codex';
  /** Show the non-blocking variant (the person may still send). */
  soft?: boolean;
}) {
  const m = central.machines.find((x) => x.machine.machineId === machineId);
  const status = central.runtimes[machineId] ?? m?.runtimes;
  const gate = soft ? runtimeHint(status, runtime) : runtimeGate(status, runtime);
  if (!m || !gate) return null;
  const name = m.machine.name ?? machineId;
  return (
    <div className="rt-gate" role="status">
      <div className="rt-gate-text">{(soft ? hintText : gateText)(runtime, name, gate)}</div>
      <RuntimeRows central={central} machineId={machineId} compact only={runtime} />
    </div>
  );
}
