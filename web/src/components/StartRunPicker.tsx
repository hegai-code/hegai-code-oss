import type { EffortLevel } from '@cc-remote/shared';
import type { CentralState, StartSettings } from '../useCentral.js';
import { RunPicker } from './RunPicker.js';
import { offeredModes } from './PermissionModePicker.js';
import { EFFORT_LABEL, deriveRunPick, goModelOrDefault, modelsForSide, useModelList } from './run-settings.js';

/**
 * Model, effort and permission mode for a session that does not exist yet.
 *
 * The composer's `RunPicker` sets the first two ON a run; this one sets all
 * three BEFORE one, which is the whole difference. Everything downstream is
 * shared on purpose — same control, same labels, same derivation
 * (`run-settings.ts`) — so the start screen cannot end up naming a model the
 * session then isn't on.
 *
 * Two deliberate narrowings versus the live control:
 *
 *  - no `ultracode`. It is an escalation you reach for mid-task once you have
 *    seen the model struggle, and `new_session` carries no flag for it; the
 *    session can be raised to it a turn later, where the control already is.
 *  - the model list may be the BUILT-IN one. `models.list` answers from the
 *    runtime only once a run on that machine has reported, so on an idle
 *    machine this offers the curated Claude trio rather than the CLI's own
 *    list. That is why an unrecognised model must not fail the start — see the
 *    note on `NewSession` in shared/src/web-protocol.ts.
 */
export function StartRunPicker({
  central,
  machineId,
  isCodex,
  isOpenCode = false,
  value,
  onChange,
}: {
  central: CentralState;
  machineId: string;
  isCodex: boolean;
  /** Codex on the wire, with its own list of models. */
  isOpenCode?: boolean;
  value: StartSettings;
  onChange: (next: StartSettings) => void;
}) {
  const { models: listed, fromRuntime } = useModelList({
    central,
    machineId,
    isCodex,
    enabled: !!machineId,
  });
  const models = isCodex ? modelsForSide(listed, isOpenCode) : listed;

  const model = (isOpenCode ? goModelOrDefault(listed, value.model) : value.model) ?? '';
  const effort = value.effort ?? '';
  const { picks, defaultName, activeLabel, efforts, effortOff } = deriveRunPick({
    models,
    fromRuntime,
    model,
    effort,
  });

  // Plan mode, the one mode this control still offers (see RunPicker `plan`),
  // and only where the machine offers it.
  const machine = central.machines.find((m) => m.machine.machineId === machineId)?.machine;
  const canPlan = offeredModes(machine, isCodex).includes('plan');

  return (
    <RunPicker
      modelLabel={activeLabel}
      models={picks}
      model={model}
      accountLabel={defaultName ?? 'Как в аккаунте'}
      noAccountRow={isOpenCode}
      effort={effort}
      efforts={efforts}
      effortLabel={EFFORT_LABEL}
      effortOff={effortOff}
      allowUltracode={false}
      /* Empty = hand the choice back to the machine, which the wire expresses
         by OMITTING the field — so the empty pick has to delete it rather than
         send `''`, otherwise "unpinned" becomes a state you cannot return to. */
      onModel={(v) => onChange({ ...value, model: v || undefined })}
      onEffort={(v) => onChange({ ...value, effort: (v || undefined) as EffortLevel | undefined })}
      plan={
        canPlan
          ? {
              on: value.permissionMode === 'plan',
              // Off = no pick at all, so the machine's own default applies.
              onToggle: (on) => onChange({ ...value, permissionMode: on ? 'plan' : undefined }),
            }
          : undefined
      }
    />
  );
}
