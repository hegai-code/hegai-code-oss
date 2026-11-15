import { useEffect, useState } from 'react';
import { DEFAULT_MODELS, EffortLevel as EffortLevelEnum } from '@cc-remote/shared';
import type { EffortLevel, ModelInfoLite, ModelsResult } from '@cc-remote/shared';
import type { CentralState } from '../useCentral.js';
import { storageGet, storageSet } from '../storage.js';

/**
 * The model/effort list and everything derived from it, in one place.
 *
 * It lived inside `Chat.tsx` while the composer was the only thing that could
 * set these. The start screen sets the same two BEFORE a run exists, and the
 * derivations here are the subtle part — which row the runtime is actually on,
 * what "default" resolves to, which efforts a model takes, when a list may be
 * cached. Two copies of that would drift, and the drift would read as "the
 * start screen offers a model the session then isn't on".
 */

/**
 * Reasoning effort, in Russian like the rest of the web UI. Model names
 * (`Opus 4.6`) and the `ultracode` mode stay as they are: those are proper
 * nouns, not levels.
 *
 * The enum values are the contract and are what we send; only the label
 * changes.
 */
/** The model button's word while no model is known yet. A label for the
 *  control, not a name: anything that NAMES the model shows nothing instead. */
export const MODEL_PLACEHOLDER = 'модель';

export const EFFORT_LABEL: Record<string, string> = {
  low: 'Низкое',
  medium: 'Среднее',
  high: 'Высокое',
  // NOT «Максимальное». The runtime has a separate `max` ABOVE this one, so
  // calling xhigh the maximum claims a ceiling it does not hold — and it reads
  // as a lie to anyone who knows the levels: «it says max, but I'm on high».
  xhigh: 'Очень высокое',
  // Reportable, not settable (see ActiveEffortLevel in shared/src/protocol.ts).
  max: 'Максимальное',
  // Codex's ends of the ladder — also reportable only.
  none: 'Выключено',
  ultra: 'Ультра',
};

/** The same levels where the row is one line and `Очень высокое` alone would
 *  take a third of it. Short enough to sit beside the placeholder, long enough
 *  to still be a word rather than a code. */
export const EFFORT_SHORT: Record<string, string> = {
  low: 'низкое',
  medium: 'среднее',
  high: 'высокое',
  xhigh: 'оч. выс.',
  max: 'макс.',
  ultracode: 'ultra',
  // Codex's own ends of the ladder. `ultra` is a LEVEL and `ultracode` is a
  // mode that happens to abbreviate the same way — they are two different keys
  // on purpose.
  none: 'выкл.',
  ultra: 'ультра',
};

/** Efforts that can actually be applied to a live run (the CLI also reports
 *  'max', which is not live-settable — see EffortLevel in shared/protocol.ts). */
export const EFFORTS: readonly EffortLevel[] = EffortLevelEnum.options;

// The list is per-machine (agents can override it via CC_REMOTE_MODELS), so
// cache it by machineId to survive session switches and tab remounts.
/** Keyed by machine AND runtime: one box runs both, and Codex's ids are not
 *  Claude's — a single key served a Codex session the Claude list. */
const modelsCache = new Map<string, ModelInfoLite[]>();

/**
 * The same cache, kept across visits in this browser.
 *
 * The agent learns the runtime's list only from a live run, and forgets it on
 * every restart (a hub deploy restarts the fleet). Until a run spoke, a fresh
 * chat got the built-in list, which has no `default` row — nothing to name the
 * account's model by, so the composer said «модель» (28.09.2026). The agent now
 * keeps its list on disk too; this covers the machine it has not reached yet.
 * Only a runtime answer (it carries `resolved`) is ever stored. A display
 * convenience — storage that throws or is empty just means the old behaviour.
 */
const MODELS_KEY = (key: string) => `cc-models:${key}`;
function keptModels(key: string): ModelInfoLite[] | undefined {
  try {
    const raw = storageGet(MODELS_KEY(key));
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const list = parsed.filter(
      (m): m is ModelInfoLite => !!m && typeof (m as ModelInfoLite).id === 'string',
    );
    return list.some((m) => m.resolved) ? list : undefined;
  } catch {
    return undefined;
  }
}
function keepModels(key: string, models: ModelInfoLite[]): void {
  // Private mode, quota — the in-memory cache still has it.
  storageSet(MODELS_KEY(key), JSON.stringify(models));
}

/**
 * OpenCode is a choice of models, not a runtime: on the wire it is `source:
 * 'codex'` with a `pool-go/` model (agent/src/opencode-go.ts). A thread cannot
 * move between the two, so the Codex and OpenCode lists never mix.
 */
const GO_MODEL_PREFIX = 'pool-go/';
const GO_DEFAULT_MODEL = `${GO_MODEL_PREFIX}glm-5.3`;

export function isGoModel(id: string | undefined): boolean {
  return !!id && id.startsWith(GO_MODEL_PREFIX);
}

/** The rows of one side. Codex keeps its `default` row, which names the account's model. */
export function modelsForSide(models: ModelInfoLite[], go: boolean): ModelInfoLite[] {
  return models.filter((m) => isGoModel(m.id) === go);
}

/** An OpenCode start must name a model: unpinned, it would run the machine's Codex default. */
export function goModelOrDefault(models: ModelInfoLite[], picked: string | undefined): string | undefined {
  const rows = modelsForSide(models, true);
  if (rows.some((m) => m.id === picked)) return picked;
  return rows.find((m) => m.id === GO_DEFAULT_MODEL)?.id ?? rows[0]?.id;
}

/**
 * Ask a machine what it can run, with the fallbacks that make the answer safe
 * before any run has reported.
 *
 * `fromRuntime` is not cosmetic: the built-in fallback carries no effort data,
 * so "this model named no efforts" may only be read as "it takes none" when the
 * list came from the runtime itself.
 */
export function useModelList({
  central,
  machineId,
  isCodex,
  enabled,
  liveModel,
}: {
  central: Pick<CentralState, 'rpc' | 'status'>;
  machineId: string;
  isCodex: boolean;
  /** Don't ask until there is something to ask about (a selected machine, an
   *  attached run). A disabled hook keeps the cache but drops the fetch. */
  enabled: boolean;
  /** Re-ask when the run first names its model: that is the moment the agent's
   *  context poll has run, which is also how it learns the runtime's model
   *  list. Ask before then and the answer can still be the built-in fallback. */
  liveModel?: string;
}): { models: ModelInfoLite[]; fromRuntime: boolean } {
  // `fetched` holds only RPC data — callers derive cache/fallback themselves.
  const [fetched, setFetched] = useState<ModelInfoLite[] | null>(null);
  const modelsKey = `${machineId}::${isCodex ? 'codex' : 'claude'}`;
  useEffect(() => {
    // The cache paints at once, but no longer ends the question: the agent
    // resolves the `default` row from settings.json per call (07.10.2026), so
    // a list kept for the life of the tab would freeze an edited default.
    const cached = modelsCache.get(modelsKey);
    setFetched(cached ?? null);
    // Asked again once the socket opens. On a page load the picker mounts first,
    // and a question sent then fails quietly with nobody left to repeat it.
    if (!enabled || !machineId || central.status !== 'open') return;
    let cancelled = false;
    central
      .rpc<ModelsResult>(machineId, 'models.list', isCodex ? { source: 'codex' } : {}, true)
      .then((r) => {
        if (!r.models?.length) return;
        // Only the runtime's own answer is worth caching, and only it carries
        // `resolved`. Caching the fallback would pin a stale list to this
        // machine for the life of the tab.
        if (r.models.some((m) => m.resolved)) {
          modelsCache.set(modelsKey, r.models);
          keepModels(modelsKey, r.models);
        }
        if (!cancelled) setFetched(r.models);
      })
      .catch(() => {}); // agent offline or too old — keep the fallback trio
    return () => {
      cancelled = true;
    };
  }, [enabled, isCodex, machineId, modelsKey, central.rpc, central.status, liveModel]);

  // The built-in fallback is a CLAUDE list. Offering it on a Codex session would
  // hand the app-server ids it has never heard of, so Codex falls back to
  // nothing and the control names only what the run reports.
  // A list the agent answered with its built-in fallback (no `resolved`) is
  // worse than one this browser kept from the runtime earlier.
  const answered = fetched?.some((m) => m.resolved) ? fetched : undefined;
  const kept = modelsCache.get(modelsKey) ?? keptModels(modelsKey);
  const models = answered ?? kept ?? fetched ?? (isCodex ? [] : DEFAULT_MODELS);
  return { models, fromRuntime: !!(answered ?? kept ?? fetched) };
}

/**
 * A wire id, made readable.
 *
 * When the runtime names a model the row list has never heard of, the control
 * falls back to the id — and an id is not a name: «claude-opus-4-8» took half
 * the composer on a 390px screen and told the reader nothing that «Opus 4.8»
 * does not. Only ids are touched; a real name is returned untouched.
 */
export function prettyModel(label: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:\[(\w+)\])?$/.exec(label.trim());
  if (!m) return label;
  const [, family, major, minor, tag] = m;
  const name = family!.charAt(0).toUpperCase() + family!.slice(1);
  const version = minor ? `${major}.${minor}` : major;
  return `${name} ${version}${tag ? ` (${tag})` : ''}`;
}

export interface RunPickView {
  /** Rows to offer, with the runtime's placeholder "default" row removed. */
  picks: ModelInfoLite[];
  /** What the account's own unpinned choice resolves to, named. */
  defaultName?: string;
  /** The model the control should NAME — never the word "default". */
  activeLabel: string;
  efforts: readonly string[];
  /** This model takes no reasoning effort at all. */
  effortOff: boolean;
}

/**
 * Turn a model list plus the current pick into everything the control renders.
 *
 * Pure, so the start screen (pick held in local state, no run yet) and the
 * composer (pick reported by the agent) reach the same labels from the same
 * rules.
 */
export function deriveRunPick({
  models,
  fromRuntime,
  model,
  effort,
  activeModel,
}: {
  models: ModelInfoLite[];
  fromRuntime: boolean;
  /** `''` = nothing pinned; the account decides. */
  model: string;
  effort: string;
  /** Wire model id the runtime resolved to, when a run has reported one. */
  activeModel?: string;
}): RunPickView {
  // Drop the runtime's own "default" row: it is the placeholder, and listing it
  // twice is what made every control read "default" whatever was selected.
  const picks = models.filter((m) => m.id !== 'default');
  // The row actually in force — matched through `resolved` because the runtime
  // names the wire id ('claude-opus-5'), while the rows are aliases. Searched
  // over `picks`, never `models`: the runtime's "default" row resolves to the
  // same wire id and comes first, so it would win the match and name itself —
  // "default · Default (recommended)".
  const modelRow =
    (activeModel
      ? picks.find((m) => m.resolved === activeModel || m.id === activeModel)
      : undefined) ?? picks.find((m) => m.id === model);
  // What the runtime calls its own unpinned choice. The list carries a "default"
  // row precisely so the account default can be NAMED before any run has
  // reported one — dropping it from `picks` is about not offering it twice, not
  // about hiding what it resolves to.
  const defaultRow = models.find((m) => m.id === 'default');
  const defaultName = defaultRow
    ? (picks.find((p) => p.id === defaultRow.resolved || p.resolved === defaultRow.resolved)?.name ??
      // A default pinned to a model with no row of its own (an older version
      // in settings.json): its id, made readable where it can be, says more
      // than the CLI's «Default (recommended)».
      (defaultRow.resolved ? prettyModel(defaultRow.resolved) : undefined) ??
      defaultRow.name)
    : undefined;
  // The control names the MODEL THAT IS RUNNING, never the word "default":
  // "default" is an implementation detail of WHO chose the model (the account
  // rather than this session), not a thing you can be running, and as a label it
  // displaced the one fact the control exists to report.
  //
  // And it names a VERSION, not a family. The rows the CLI offers are aliases —
  // `opus` carries `displayName: "Opus"`, because the row means «whichever Opus
  // is current», and the catalogue keeps the version in a separate field. So a
  // session running `claude-opus-4-8` was labelled «Opus», which answers a
  // narrower question than the one being asked: you can see WHICH family and
  // not WHICH generation, on the one control that exists to say what is
  // running. The wire id the run reports does carry the generation, so when it
  // is a wire id (`prettyModel` changed it, i.e. it matched the shape) it wins
  // over the row's own word. A runtime whose ids are not Claude-shaped — Codex
  // — is untouched: `prettyModel` hands those back unchanged and the row name
  // stays.
  const activeVersioned = activeModel ? prettyModel(activeModel) : undefined;
  const activeLabel = prettyModel(
    (activeVersioned !== activeModel ? activeVersioned : undefined) ??
      modelRow?.name ??
      modelRow?.id ??
      activeModel ??
      defaultName ??
      MODEL_PLACEHOLDER,
  );
  // Only the efforts this model takes, intersected with what is live-settable
  // ('max' is reported by the CLI but cannot be applied mid-run). The current
  // value is kept whatever the list says — a control whose value has no row
  // renders blank, which is worse than offering one row too many.
  const efforts = EFFORTS.filter((e) => e === effort || (modelRow?.efforts ?? EFFORTS).includes(e));
  // The CLI omits `supportsEffort` rather than sending false, so on a runtime
  // list an effortless model is one that named no levels. Never inferred from
  // the built-in fallback list, which carries no effort data at all.
  const effortOff =
    modelRow?.supportsEffort === false || (!!modelRow && fromRuntime && !modelRow.efforts?.length);
  return { picks, defaultName, activeLabel, efforts, effortOff };
}

export interface EffortTrack {
  /** The level in force — pinned first, then what the run reports. */
  effective: string;
  /** In force but NOT on the ladder (`max`, `none`, `ultra`): nameable, not
   *  pinnable. */
  offScale: boolean;
  /** Neither pinned nor reported. */
  unset: boolean;
  /** A finger is on the track right now. */
  pending: boolean;
  /** The track must assert NO position: no thumb, no marked stop. */
  unknown: boolean;
  /** Stop index the thumb sits at when it is shown at all. */
  shown: number;
}

/**
 * Where the effort thumb goes — and whether it may be shown at all.
 *
 * Pure, and separate from the component, because the interesting case is the
 * one that cannot be photographed: `Math.max(0, idx)` collapsed «no answer» to
 * stop zero, and stop zero is `low`. A session running at `medium` therefore
 * displayed its thumb on `low`, distinguished from a real `low` only by
 * opacity — the composer stated, in the one place it exists to state it, a
 * level the session was not running at.
 *
 * Codex made that the normal case (a machine whose `~/.codex/config.toml` names
 * no `model_reasoning_effort` reported nothing at all), but a fresh Claude run
 * does the same until its first tool call.
 */
export function effortTrack({
  stops,
  effort,
  activeEffort,
  drag,
}: {
  stops: readonly string[];
  effort: string;
  activeEffort?: string;
  /** Stop index under the finger mid-drag, or null. */
  drag: number | null;
}): EffortTrack {
  const effective = effort || activeEffort || '';
  const idx = stops.indexOf(effective);
  const offScale = !!effective && idx < 0 && effective !== 'ultracode';
  const unset = !effective && effort !== 'ultracode';
  const pending = drag !== null;
  // A drag outranks both: the thumb under the finger is the reader's own, and
  // hiding it mid-gesture is the one thing worse than parking it.
  const unknown = (unset || offScale) && !pending;
  return { effective, offScale, unset, pending, unknown, shown: drag ?? Math.max(0, idx) };
}
