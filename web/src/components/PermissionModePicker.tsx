import { useEffect, useMemo, useState } from 'react';
import type { PermissionMode, SessionSummary } from '@cc-remote/shared';
import type { CentralState } from '../useCentral.js';

/**
 * The permission mode of a live run, as a control.
 *
 * `bypassPermissions` is deliberately absent from the base list: it is the one
 * mode whose availability is the MACHINE's call, and it arrives on
 * `machine.permissionModes`. An agent too old to report the field gets exactly
 * this trio — the field's absence means "no answer", and the safe reading of no
 * answer is not "yes".
 */
export const BASE_PERMISSION_MODES: PermissionMode[] = ['default', 'plan', 'acceptEdits'];

/**
 * What an agent too old to answer for Codex is assumed to offer.
 *
 * Codex used to be hardcoded to this pair in three separate files, because
 * nothing else mapped onto anything the runtime would honour. It does now — but
 * an agent that has not shipped the mapping still honours only these two, and
 * offering the others would be a control that silently does nothing.
 */
export const CODEX_FALLBACK_MODES: PermissionMode[] = ['default', 'plan'];

/**
 * The modes to offer, from the machine's own answer.
 *
 * One function because there were three copies of this paragraph — the
 * composer, the start screen and the session panel — and three copies of a rule
 * is three chances to update two of them.
 *
 * Narrowed to modes this picker can LABEL: an agent naming something the web
 * has no word for would otherwise render a raw wire name.
 */
export function offeredModes(
  machine: { permissionModes?: PermissionMode[]; codexPermissionModes?: PermissionMode[] } | undefined,
  isCodex: boolean,
): readonly PermissionMode[] {
  const fallback = isCodex ? CODEX_FALLBACK_MODES : BASE_PERMISSION_MODES;
  const offered = isCodex ? machine?.codexPermissionModes : machine?.permissionModes;
  const known = offered?.filter((m) => m in MODE_LABEL) ?? [];
  return known.length ? known : fallback;
}

/**
 * What each mode DOES, because the wire name says nothing to the person holding
 * the control. `'default'` is the worst of them: it is the wire's word for "ask
 * me before every write", and printed as-is it made the composer read
 * "default · default · default" whatever the session was actually doing. The
 * enum values are the contract and do not change — only what the row is called.
 */
export const MODE_LABEL: Record<string, string> = {
  // In Russian like the rest of the web UI (the iOS client still says
  // `PermissionMode.label` in English — CCRemoteKit/Protocol/Models.swift).
  default: 'Сначала спросить',
  plan: 'План',
  acceptEdits: 'Правки без вопросов',
  bypassPermissions: 'Без вопросов',
  dontAsk: 'Без вопросов',
  auto: 'Авто',
};

/**
 * Lives in the session info panel, not in the composer.
 *
 * It sat in the composer between the model and the effort, and it is not that
 * kind of control. Model and effort are dialled per message — «этот вопрос
 * подумай подольше» — and belong next to the text you are about to send. The
 * permission mode is a property OF THE SESSION: you set it once when you decide
 * how much rope this run gets, and then you forget it. On a phone that
 * distinction was expensive, because all three competed for the one row a thumb
 * has to reach, and the mode is the one you touch least.
 *
 * Rendered only while a run is attached, for the same reason the composer's
 * controls are: without `active.runId` there is nothing to set the mode ON, and
 * a select that silently does nothing is worse than an absent one.
 */
export function PermissionModePicker({
  central,
  session,
  machineId,
}: {
  central: CentralState;
  session: SessionSummary;
  machineId: string;
}) {
  const [mode, setMode] = useState<PermissionMode>('default');

  // Track the mode the agent actually reports — it flips back to default on its
  // own after a plan is accepted, and a control showing the stale pick would be
  // lying about what the next tool call will do.
  useEffect(() => {
    if (central.permissionMode) setMode(central.permissionMode);
  }, [central.permissionMode]);

  const machineEntry = central.machines.find((m) => m.machine.machineId === machineId);
  const isCodex = session.source === 'codex';
  const offered = useMemo(
    () => offeredModes(machineEntry?.machine, isCodex),
    [machineEntry?.machine, isCodex],
  );

  const isActive = central.active?.sessionId === session.sessionId && !!central.active?.runId;
  if (!isActive) return null;

  return (
    <div className="si-row">
      <span className="si-label">Режим</span>
      <span className="si-value">
        <select
          className="ctool si-ctool"
          value={mode}
          title={session.source === 'codex' ? 'Режим совместной работы Codex' : 'Что агенту разрешено делать без вопроса'}
          onChange={(e) => {
            const m = e.target.value as PermissionMode;
            setMode(m);
            if (central.active?.runId) central.setPermissionMode(central.active.runId, m, central.active.machineId);
          }}
        >
          {offered.map((m) => (
            <option key={m} value={m}>
              {MODE_LABEL[m] ?? m}
            </option>
          ))}
        </select>
      </span>
    </div>
  );
}
