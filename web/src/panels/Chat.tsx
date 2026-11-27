import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSlashMenu } from '../components/SlashMenu.js';
import { StickyAsk } from '../components/StickyAsk.js';
import type {
  EffortLevel,
  Enrichment,
  PermissionMode,
  HistoryMessage,
  SessionSummary,
  SessionMessagesResult,
  Subagent,
} from '@cc-remote/shared';
import type { useCentral } from '../useCentral.js';
import { ContextRing } from './ContextRing.js';
import { foldHistoryRecaps, turnRecaps } from '../render/turnRecaps.js';
import type { Step } from '../stepText.js';
import { BlockView, MessageView, ToolRunRow, LiveLine, LiveRunRow, groupHistory, groupLive, stripCitations, stripHarnessNoise } from '../render/Blocks.js';
import { buildTurnDigest, heuristicEnrichment, mergeEnrichment, textKey } from '../render/enrich.js';
import { EnrichStrip } from '../render/EnrichStrip.js';
import { RateLimitBanner } from '../components/RateLimitBanner.js';
import { PlanStrip } from '../components/PlanStrip.js';
import { RuntimeGate } from '../components/RuntimeGate.js';
import { runtimeGate } from '../components/runtimeChips.js';
import { currentPlan } from '../planProgress.js';
import { AttachmentContext, type FetchAttachment, scopedFetch } from '../render/Attachment.js';
import { FilePeekContext, makeFilePeek } from '../render/FilePreviews.js';
import { hasAssistantReplyAfterLastUser, historyHoldsLiveAnswer } from '../render/imageGen.js';
import { SquareIcon, ArrowDownIcon, ArrowUpIcon } from '../icons.js';
import { requestPairDialog, usePrivacy } from '../e2ee/ring.js';
import { useDictationComposer } from '../useDictationComposer.js';
import { RunPicker } from '../components/RunPicker.js';
import { EFFORT_LABEL, MODEL_PLACEHOLDER, deriveRunPick, isGoModel, modelsForSide, useModelList } from '../components/run-settings.js';
import { offeredModes } from '../components/PermissionModePicker.js';
import { LocalCache, transcriptKey } from '../localCache.js';
import { chatUploader, withUploadedFiles } from '../chatUpload.js';
import { useUploadRoot } from '../uploadRoot.js';
import { showNotice } from '../dialogs.js';
import { useImageAttachment, useAutoGrowTextarea, AttachPreview, AttachButton, VoiceButton, DictationStrip, DictationSwitch, DraftStore, enterShouldSend, useComposerHeight } from '../composer.js';
import { polishContext, transcribeHints } from '../polish.js';
import { agentName, viewerName } from '../lib.js';
import { dropCliImageNotes, dropEchoedUserLine, dropGeneratedShownInHistory, dropReplayedTurnFromHistory, lastUserText } from '../central-reducers.js';
import { backgroundTaskLabel, backgroundTaskRepeatKey, collapseRepeats } from '../sessionChannel.js';
import { SessionWorkCard, TurnRecap, SubagentCards, SubagentPanel, SubagentTranscript, SubagentsContext, agentCallsFromBlocks, agentCallsFromLines, agentNotices, stepOf, toolStep, type OpenTarget, type PanelRow, type SubagentsApi } from '../render/Subagents.js';
import { THINKING, workActivity } from '../workActivity.js';

type Central = ReturnType<typeof useCentral>;

/**
 * How much of a tool call's payload this pane asks for. Measured across real
 * sessions on this fleet, `tool_use` inputs and `tool_result` bodies are 95-99%
 * of a transcript's weight and their sizes are wildly long-tailed: median ~130
 * characters, p90 ~1.2k, and single blocks up to half a megabyte. So a 1000
 * character cap leaves nine blocks in ten completely untouched while cutting
 * 70-90% of the bytes — an open used to cost a phone 1-4 MB to render maybe
 * twenty kilobytes of readable dialogue.
 *
 * Nothing on screen changes for those nine: `BlockView` already clips a result
 * at 4000 characters, and both kinds render folded behind a disclosure. The
 * agent appends a "truncated · N KB more" marker so an expanded monster says
 * what it is holding back instead of pretending to be complete.
 */
const TOOL_CHARS = 1000;
/**
 * Messages fetched when a session opens. The agent's own default is 1000, and
 * asking for it meant every open — and every reconnect — pulled a thousand
 * messages to render the handful on screen. A page plus an explicit "earlier"
 * control keeps the whole transcript reachable without paying for it up front.
 */
const HIST_PAGE = 300;
/**
 * The convergence poll below only asks a yes/no question ("has the file caught
 * up?"), which the tail answers. It used to re-read the FULL history up to
 * seven times to do it.
 */
const HIST_PROBE = 24;

const NO_SUBAGENTS: Subagent[] = [];
const NO_WORK = { steps: [] as Step[], activity: '', current: false, waitsOnHelper: false };
/** Helper calls — each has its own card, so they are not steps of the turn. */
const HELPER_TOOLS = new Set(['Agent', 'Task']);
const isHelperLine = (text: string) => HELPER_TOOLS.has(/^\s*([^\s{]+)/.exec(text)?.[1] ?? '');

export function Chat({
  central,
  session,
  machineId,
  takingOver,
  readOnly: sharedReadOnly = false,
  carriedDraft,
  variant = 'full',
}: {
  central: Central;
  session: SessionSummary;
  machineId: string;
  /** App owns the ownership derivation — a takeover is in flight for this session. */
  takingOver: boolean;
  readOnly?: boolean;
  /** Text the StartScreen already handed to an `open` before this pane mounted.
   *  Adopted as an unconfirmed resume so a refusal returns it to the composer
   *  here rather than losing it with the screen that sent it. */
  carriedDraft?: string;
  /**
   * `lite` is the light shell's task view (web/src/lite): the same transcript,
   * the same composer, the same history and stream handling — minus the three
   * controls that are choices about the MACHINERY (the «/» menu, the model and
   * effort picker, the context ring). What is left of them is the one switch a
   * person who is not thinking about models still wants: plan first, or do.
   *
   * A flag here rather than a second component, because what makes this file
   * long is not its controls — it is paging, cache-first reads, the hub-replica
   * fallback and echo dedupe, and a second copy of those is a second place for
   * «the web lost my message» to come back from.
   */
  variant?: 'full' | 'lite';
}) {
  const lite = variant === 'lite';
  // An archived session (its transcript is gone from the machine, the hub's
  // replica still has it) reads like any other and cannot be continued: the
  // hub refuses `open` for it. Same lock as a read-only share, its own banner.
  const archived = session.archived === true;
  const readOnly = sharedReadOnly || archived;
  const [history, setHistory] = useState<HistoryMessage[]>([]);
  /** Read by the convergence pass, which must not re-fire on every page. */
  const historyLenRef = useRef(0);
  historyLenRef.current = history.length;
  const [histLimit, setHistLimit] = useState(HIST_PAGE);
  /** The read came back full, so the file may hold more before it. */
  const [histMore, setHistMore] = useState(false);
  const [loadingHist, setLoadingHist] = useState(false);
  /** The real history for THIS session has landed at least once. Until then the
   *  pane is waiting for it — whether or not the socket is open yet, which is
   *  why this is not `loadingHist` (that one only starts once a read can go). */
  const [histReady, setHistReady] = useState(false);
  /** The first read of this session failed (timed out, refused, machine
   *  offline). It used to be swallowed, which left a blank pane that read as
   *  «виснет» — the failure is a state now, with one silent retry and then a
   *  button. `histRetry` re-arms the read effect. */
  const [histError, setHistError] = useState(false);
  const [histRetry, setHistRetry] = useState(0);
  /** Re-reads while the file has not caught up with a turn in flight — see the
   *  effect «The first record is not on disk yet». */
  const [histCatchUp, setHistCatchUp] = useState(0);
  /** The hub answered from its replica because the agent was slow. */
  const [histStale, setHistStale] = useState(false);
  // The last page of this session as this device last saw it — drawn at once,
  // exactly as the real one will look, and replaced the moment the real read
  // lands. Stale on purpose: a conversation that has moved on since is still
  // the right thing to show for the second it takes to refresh.
  //
  // DISPLAY-ONLY. It goes nowhere near the echo-dedup or convergence logic
  // below, which reason about `history` alone: those decide whether the file
  // has caught up with the live stream, and a copy from disk is not evidence
  // about the file (see localCache.ts).
  // Private machine (docs/E2EE.md): its decrypted transcript is never parked in
  // the local cache, and dictation / suggestions - which send text to the hub -
  // are off. `hasKey` false = the session shows a placeholder, not content.
  const privacy = usePrivacy(
    machineId,
    central.machines.find((m) => m.machine.machineId === machineId)?.machine.private,
  );
  const privateMachine = privacy.private;
  const [cachedHist, setCachedHist] = useState<HistoryMessage[]>(() =>
    session.sessionId && !privateMachine ? LocalCache.peekTranscript(transcriptKey(machineId, session.sessionId)) : [],
  );
  useEffect(() => {
    if (!session.sessionId || privateMachine) {
      setCachedHist([]);
      return;
    }
    const key = transcriptKey(machineId, session.sessionId);
    setCachedHist(LocalCache.peekTranscript(key));
    let alive = true;
    void LocalCache.transcript(key).then((m) => {
      if (alive && m.length) setCachedHist(m);
    });
    return () => {
      alive = false;
    };
  }, [machineId, session.sessionId, privateMachine]);
  // Keyed per session, so switching away and back returns what you were writing
  // instead of an empty field. `carriedDraft` still wins on the first render —
  // it is text the StartScreen already handed to an `open`.
  //
  // A session being STARTED has no id yet (App navigates to the `/w/s/:m/`
  // placeholder and the agent mints the id a moment later), and `machineId::`
  // is not a session — it is one bucket every new session on that machine
  // would share. Anything typed in that window used to be saved there, and the
  // NEXT new session on the box mounted pre-filled with it; the copy outlived
  // reloads because nothing ever owned the key well enough to clear it. While
  // there is no id there is nothing to remember.
  const draftKey = session.sessionId ? `${machineId}::${session.sessionId}` : '';
  const [draft, setDraft] = useState(() => carriedDraft ?? (draftKey ? DraftStore.load(draftKey) : ''));
  // Optimistic picks. They exist only to keep the select responsive between the
  // change event and the agent's `run_settings` echo — `model`/`effort` below
  // prefer what the run actually reports, so a reload or a session switch shows
  // the truth instead of resetting these to a default the session is not on.
  const [modelPick, setModelSel] = useState<string | null>(null);
  const [effortPick, setEffortSel] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const taRef = useAutoGrowTextarea(draft, 0.4);
  const composerRef = useComposerHeight();
  const [atBottom, setAtBottom] = useState(true);
  /**
   * Is the composer being USED — focused, or focused a moment ago.
   *
   * The fold used to read `:focus-within` straight from CSS, and that is what
   * broke the model menu on iOS. Order of events on a tap there: the field
   * blurs FIRST (iOS does not focus buttons), the row folds, `.composer-tools`
   * becomes `display: none` — and the click is then delivered to nothing,
   * because the button it was aimed at has left the page. On desktop the button
   * takes focus, `:focus-within` holds, and the bug is invisible; which is
   * exactly how it shipped.
   *
   * So the state outlives the blur by a beat. Long enough for the click that
   * caused the blur to land, short enough that tapping away still folds the box
   * while you are looking at it.
   */
  const [engaged, setEngaged] = useState(false);
  /** «Сжать контекст» is pending from the press until the run reports the
   *  boundary. See the button for why this is NOT a short timer. */
  const [compacting, setCompacting] = useState(false);
  /** Line ids present when compaction was asked for, so an OLD boundary line
   *  already in the transcript cannot clear the state the instant it is set. */
  const linesAtCompact = useRef<Set<number> | null>(null);
  const unengage = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Files past the inline limit go up to the session's folder (the hub lets a
  // control-share member do that only at the share's root).
  const uploadRoot = useUploadRoot(central, machineId, session.cwd);
  const picker = useImageAttachment(() => (uploadRoot ? chatUploader(central.rpc, machineId, uploadRoot) : undefined));
  // Dictation is cleaned up against THIS conversation: its project, its title
  // and the words its last turns used are what whisper most often mishears.
  const polishHistory = history.length ? history : cachedHist;
  const polishDictation = useCallback(
    (raw: string, safe: boolean) =>
      central.polish({
        text: raw,
        // `safe` (sent unseen from the recording): the project label only —
        // no title, no conversation tail. See polishDictationText.
        ...(safe
          ? polishContext({ project: session.project })
          : polishContext({ project: session.project, title: session.title, history: polishHistory })),
      }),
    [central.polish, session.project, session.title, polishHistory],
  );
  // Session vocabulary for the recognition prompt, computed when a clip is
  // sent (through a ref) rather than per render — the history moves on while
  // the person talks, and the transcribe callback stays stable.
  const polishHistoryRef = useRef(polishHistory);
  polishHistoryRef.current = polishHistory;
  const transcribeDictation = useCallback(
    (blob: Blob, durSec?: number) =>
      // The recording itself goes to the hub's speech service: not from a
      // private machine's session. (The microphone is hidden there too.)
      privateMachine
        ? Promise.reject(new Error('В зашифрованной сессии диктовка выключена: запись ушла бы на сервер.'))
        : central.transcribe(blob, session.project, { durSec, hints: transcribeHints(polishHistoryRef.current) }),
    [central.transcribe, session.project, privateMachine],
  );
  // `draftRef` and `submitRef` are for the dictation callback, which fires long
  // after it was made (see `useDictationComposer`). The sender it needs is
  // defined below, hence `submitRef` rather than `submit`.
  const { recorder, dictSwitch, draftRef, submitRef } = useDictationComposer({
    draft,
    setDraft,
    transcribe: transcribeDictation,
    polish: polishDictation,
    notifyError: central.notifyError,
  });
  /** What the last send took out of the composer. */
  const lastClearedRef = useRef<{ text: string; at: number; images: typeof picker.images; files: typeof picker.files; large: typeof picker.large } | null>(null);
  // A message the hub could not deliver comes back into the box rather than
  // being lost. Appended, not assigned: by the time the refusal lands the person
  // may already be typing the next thing, and overwriting that would be a second
  // way to lose text.
  useEffect(() => {
    const back = central.recoveredText;
    if (!back) return;
    // Only into the composer it was typed in. The refusal can arrive after the
    // person has walked away, and there is one slot for the whole app.
    if (back.machineId !== machineId || back.sessionId !== session.sessionId) return;
    const unsent = back.text;
    setDraft((d) => (d ? (d.includes(unsent) ? d : `${unsent}\n${d}`) : unsent));
    // …and what was attached to the last of them. The large ones are named in
    // the text itself (`withUploadedFiles`) and already on the machine.
    const last = lastClearedRef.current;
    lastClearedRef.current = null;
    if (last && unsent.includes(last.text.trim())) picker.restore(last.images, last.files, []);
    central.clearRecovered();
  }, [central.recoveredText, central.clearRecovered, machineId, session.sessionId]);

  // Save as you type. A successful send empties `draft`, and DraftStore.save
  // removes the key on empty, so sending is also what clears it.
  useEffect(() => {
    // Mirrored for the dictation callback, which cannot read state — see the
    // ref's declaration. Set here rather than in the setter so it tracks every
    // route into the draft, including the carried one and the refusal restore.
    draftRef.current = draft;
    if (!draftKey) return;
    DraftStore.save(draftKey, draft);
  }, [draftKey, draft]);

  const isActive = central.active?.sessionId === session.sessionId && !!central.active?.runId;
  const machineEntry = central.machines.find((m) => m.machine.machineId === machineId);
  // «Офлайн» is a claim about the MACHINE, and before the first live snapshot
  // there is nothing to base it on: the list is empty (a pane's fresh socket)
  // or read from this device's cache. Saying «Машина офлайн» then is the flash
  // everyone saw on every new column and every reload — a banner, a locked
  // composer, then both gone a second later. Until the hub has spoken the
  // machine is presumed reachable; a send that races the socket is refused by
  // `send` and the text stays in the box.
  const machineOnline = central.hydrated ? (machineEntry?.online ?? false) : true;
  // Codex sessions resume through the agent's app-server runtime. Plan/default
  // maps to Codex collaborationMode; model/effort remain Claude-only controls.
  const isCodex = session.source === 'codex';
  // Resuming needs the coder to be installed and signed in on that machine.
  // Refused here — with the «Войти» row — instead of starting a run that can
  // only answer the raw «Not logged in · Please run /login». A live run
  // already proved its login; a machine we cannot control, or an old agent
  // that says nothing, is never blocked.
  const gated =
    !isActive && machineEntry?.canControl === true
      ? runtimeGate(central.runtimes[machineId] ?? machineEntry.runtimes, isCodex ? 'codex' : 'claude')
      : undefined;
  // The «/» menu — Claude sessions only (SlashMenu.tsx).
  const slash = useSlashMenu({
    central,
    machineId,
    sessionId: session.sessionId || undefined,
    cwd: session.cwd,
    enabled: !isCodex && machineOnline && !lite,
    draft,
    setDraft,
    taRef,
  });

  /**
   * Plan mode, as the model menu's one switch (see RunPicker `plan`).
   *
   * The runtime's answer wins and it moves on its own — Claude leaves `plan`
   * once a plan is accepted — so the switch reads `central.permissionMode`,
   * with a local value only for the moment before the echo. Turning it OFF
   * returns to the mode the run had before it was turned on; with none known,
   * to the machine's no-approvals mode when it offers one (the fleet default
   * since 24.09.2026), else `default`.
   */
  const modes = useMemo(() => offeredModes(machineEntry?.machine, isCodex), [machineEntry?.machine, isCodex]);
  const [planLocal, setPlanLocal] = useState<boolean | null>(null);
  useEffect(() => setPlanLocal(null), [central.permissionMode]);
  const planOn = planLocal ?? central.permissionMode === 'plan';
  const beforePlan = useRef<PermissionMode | null>(null);
  const togglePlan = (on: boolean) => {
    const runId = central.active?.runId;
    if (!runId) return;
    let next: PermissionMode;
    if (on) {
      if (central.permissionMode && central.permissionMode !== 'plan') beforePlan.current = central.permissionMode;
      next = 'plan';
    } else {
      const fallback = (['bypassPermissions', 'dontAsk', 'acceptEdits', 'default'] as PermissionMode[]).find((m) => modes.includes(m)) ?? 'default';
      next = beforePlan.current ?? fallback;
    }
    if (central.setPermissionMode(runId, next, central.active?.machineId)) setPlanLocal(on);
  };
  // Your own name on your own turns. In a shared workspace "Вы" is also what a
  // colleague reading the same session sees, which names nobody.
  const me = viewerName(central.viewer);

  // Realtime voice call: refs mirror live central state so the send-to-session
  // control loop (spawned inside the call) reads fresh busy/lines/active values.
  // The catch-up check below reads liveness synchronously, so it needs the
  // latest `busy` without waiting for a re-render.
  const busyRef = useRef(central.busy);
  busyRef.current = central.busy;

  // The machine's model list, asked lazily the first time run-controls render.
  const liveModel = central.runSettings?.activeModel;
  const { models: listedModels, fromRuntime } = useModelList({
    central,
    machineId,
    isCodex,
    // Asked while detached too: the model can be chosen BEFORE continuing now
    // (27.09.2026), and the resume carries the pick (`open.model/effort`).
    // The light shell shows no picker, so it has nothing to ask the machine.
    enabled: !lite,
    liveModel,
  });

  // What the run reports it is on, with the pending local pick winning until the
  // echo lands. `''` = no explicit pick, i.e. the account default.
  const settings = central.runSettings;
  const lastModel = useMemo(() => {
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i]!.model;
      if (m) return m;
    }
    return undefined;
  }, [history]);
  const model = modelPick ?? settings?.model ?? '';
  // A thread stays on the side it started on, so the other side's rows would
  // only be refused. Read from what is running: an unpinned Go resume has no pick.
  const sessionOnGo = isCodex && isGoModel(model || settings?.activeModel || lastModel);
  const models = isCodex ? modelsForSide(listedModels, sessionOnGo) : listedModels;
  const effort = effortPick ?? (settings?.ultracode ? 'ultracode' : (settings?.effort ?? ''));
  const { picks, defaultName, activeLabel, efforts, effortOff } = deriveRunPick({
    models,
    fromRuntime,
    model,
    effort,
    // No run to report it and no account default known either: name the model
    // the session's last answer was written by, rather than the placeholder
    // «модель» (27.09.2026). Only then — a resume without a pick runs on the
    // ACCOUNT default, not on the last answer's model, so where that default
    // is known it is the truer label. A detached pick always wins.
    activeModel:
      settings?.activeModel ??
      (modelPick || models.some((m) => m.id === 'default') ? undefined : lastModel),
  });
  // Retire an optimistic pick only once the run reports that exact value. Held
  // otherwise, so an unrelated `run_settings` (the runtime naming its resolved
  // model, say) cannot snap the select back mid-change.
  useEffect(() => {
    if (!settings) return;
    setModelSel((p) => (p === (settings.model ?? '') ? null : p));
    const reported = settings.ultracode ? 'ultracode' : settings.effort ?? '';
    setEffortSel((p) => (p === reported ? null : p));
  }, [settings]);
  // A pick belongs to the run it was made on, or to the detached composer that
  // carries it into the next resume — never to the run AFTER it. An echo that
  // never matches (Codex falling back from a model it refused, a rejected
  // `set_model`) left the pick in state, and since the resume now SENDS the
  // detached pick, a model the runtime had already refused went out again on
  // every continue.
  const wasActive = useRef(isActive);
  useEffect(() => {
    if (wasActive.current && !isActive) {
      setModelSel(null);
      setEffortSel(null);
    }
    wasActive.current = isActive;
  }, [isActive]);

  // Load transcript history when the session changes — or once the socket opens.
  // A column pane mounts with its OWN hook still 'connecting', so the first-render
  // RPC would be dropped (send() no-ops while not open) and never retried; gating
  // on status re-runs this the moment the connection is live.
  //
  // gapRef: when this read happens while a turn is ALREADY in flight (fresh
  // open of a busy session, or a reconnect — the hub replays nothing), the
  // turn's already-streamed part is in neither the file nor `lines`. Flag it
  // and re-read the file once the turn lands, then drop the live buffer so
  // the re-read content isn't shown twice.
  const gapRef = useRef(false);
  // This effect also re-runs on every reconnect (`central.status`). Blanking the
  // transcript there was a bug in its own right: for the length of the refetch
  // the scroller had nothing to scroll, the browser clamped it to offset 0, and
  // `onLogScroll` recorded "not at bottom" — so when the messages came back the
  // auto-scroll below refused to follow and you were left at the top. Only a
  // genuinely different session invalidates what's on screen.
  const shownSessionRef = useRef('');
  useEffect(() => {
    let cancelled = false;
    const key = `${machineId}/${session.sessionId}`;
    if (shownSessionRef.current !== key) {
      shownSessionRef.current = key;
      setHistory([]);
      setHistLimit(HIST_PAGE); // a different session starts from one page again
      setHistMore(false);
      setHistReady(false);
      setHistError(false);
      setHistStale(false);
      setHistRetry(0);
      setHistCatchUp(0);
      setAtBottom(true); // a freshly opened session always starts at its newest turn
    }
    gapRef.current = false;
    if (!session.cwd || central.status !== 'open') return;
    setLoadingHist(true);
    const midTurn =
      central.busy || central.runFor(machineId, session.sessionId)?.state === 'working';
    central
      .rpc<SessionMessagesResult>(machineId, 'session.messages', {
        sessionId: session.sessionId,
        cwd: session.cwd,
        source: session.source,
        toolChars: TOOL_CHARS,
        limit: histLimit,
      }, true)
      .then((r) => {
        if (cancelled) return;
        // This effect re-runs on every reconnect without blanking the screen.
        // After a hub restart the agent is busy re-syncing and the hub answers
        // from its old copy — which must not swap out the transcript shown.
        if (r.stale === true && historyLenRef.current > 0) {
          setHistReady(true);
          setHistError(false);
          return;
        }
        setHistory(r.messages);
        setHistMore(r.messages.length >= histLimit);
        setHistReady(true);
        setHistError(false);
        setHistStale(r.stale === true);
        // A stale page is the hub's old copy, not the file. Storing it would
        // put an old transcript under this session's key as if it were current.
        if (r.stale !== true && !privateMachine) LocalCache.saveTranscript(transcriptKey(machineId, session.sessionId), r.messages);
        if (midTurn) gapRef.current = true;
      })
      .catch(() => {
        if (!cancelled) setHistError(true);
      })
      .finally(() => !cancelled && setLoadingHist(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- busy/runFor are read once at fetch time, not re-triggers
  }, [session.sessionId, session.cwd, machineId, central.rpc, central.status, central.resumeEpoch, histLimit, histRetry]);

  // The first record is not on disk yet. A session started from a composer
  // becomes this view the moment the agent names it (`session_started`), and
  // the read above goes out right then — before the runtime has flushed the
  // person's first message to the .jsonl. The answer is an empty history, and
  // it is a SUCCESS, so nothing retried it; the hub's replay brings the agent's
  // side of the turn, and the question it answers was simply not there until
  // the turn ended (27.09.2026, a five-minute turn with no question above it).
  // So while a turn of this session is in flight and the file holds nothing
  // the person sent, read it again — briefly, a bounded number of times.
  //
  // A QUIET read, not the load above: that one raises `loadingHist` (skeleton
  // over the stream, and the echo/replay dedup switched off while it is up) and
  // re-arms `gapRef`, which a turn ending mid-read would then miss. This one
  // only ever replaces the page once the file has a user record — any, since
  // a first message can be a picture with no words — and marks the turn for
  // the convergence re-read, because it is by definition in flight.
  const runLive = !!central.runFor(machineId, session.sessionId) || isActive;
  useEffect(() => {
    if (!histReady || loadingHist || histError || !runLive || !session.sessionId || !session.cwd) return;
    if (central.status !== 'open') return;
    // A FULL page with nothing of the person's in it is a long turn, not a
    // file that has not started — re-reading it would change nothing.
    if (history.some((m) => m.type === 'user') || history.length >= histLimit || histCatchUp >= 8) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      central
        .rpc<SessionMessagesResult>(machineId, 'session.messages', {
          sessionId: session.sessionId,
          cwd: session.cwd,
          source: session.source,
          toolChars: TOOL_CHARS,
          limit: histLimit,
        }, true)
        .then((r) => {
          if (cancelled || r.stale === true || !r.messages.some((m) => m.type === 'user')) return;
          setHistory(r.messages);
          setHistMore(r.messages.length >= histLimit);
          gapRef.current = true;
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setHistCatchUp((n) => n + 1);
        });
    }, 1500);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rpc identity and source are read at fetch time
  }, [histReady, loadingHist, histError, runLive, history, histLimit, histCatchUp, session.sessionId, session.cwd, machineId, central.status]);

  // One silent retry a few seconds after a failed first read — an agent that
  // is mid re-sync usually answers the second time — then the button.
  useEffect(() => {
    if (!histError || histRetry > 0 || history.length > 0) return;
    const t = window.setTimeout(() => setHistRetry(1), 4000);
    return () => window.clearTimeout(t);
  }, [histError, histRetry, history.length]);

  // Convergence pass: the flagged turn finished, so the file should now hold its
  // full text — re-read it and drop the streamed fragments it supersedes.
  //
  // "Should" is the whole problem. `busy` flips on the run's result event, but
  // the SDK writes the assistant turn to the .jsonl independently, so a read
  // fired the instant the turn ends often comes back with the user message and
  // nothing after it. Clearing the live lines against that read wiped the answer
  // off the screen — the text was safe on disk and reappeared on reload, which
  // is exactly the "message disappeared" report. So: only accept a read that has
  // actually caught up (an assistant turn after the last user one), poll briefly
  // while it hasn't, and if the file never catches up keep the streamed lines.
  // Showing streamed text is always better than showing nothing.
  // The last message sent from this composer, held until the transcript file is
  // seen to contain it. Convergence uses it to avoid dropping a live line that
  // disk has not caught up with yet.
  const lastSentRef = useRef<string | null>(null);
  const linesRef = useRef(central.lines);
  linesRef.current = central.lines;
  const busyWas = useRef(central.busy);
  useEffect(() => {
    const was = busyWas.current;
    busyWas.current = central.busy;
    if (!was || central.busy || !gapRef.current || !session.cwd) return;
    gapRef.current = false;
    let cancelled = false;
    // …and the answer streamed to this screen: a copy taken mid-turn has an
    // assistant message after the last user one too (historyHoldsLiveAnswer).
    const caughtUp = (messages: HistoryMessage[]): boolean =>
      hasAssistantReplyAfterLastUser(messages) && historyHoldsLiveAnswer(messages, linesRef.current);
    // `caughtUp` alone is satisfied by the PREVIOUS user/assistant pair. Send
    // into a working run and the file may not carry that new input yet — the old
    // pair still answers "caught up", and clearLines() then takes the line you
    // just typed with it. The message really did reach the agent; it simply
    // stopped being on screen until a reload. So also require that the file
    // actually contains the last thing sent from here.
    const hasLastSent = (messages: HistoryMessage[]): boolean => {
      const pending = lastSentRef.current;
      if (!pending) return true;
      return messages.some(
        (m) =>
          m.type === 'user' &&
          m.blocks.some((b) => b.kind === 'text' && b.text.trim() === pending),
      );
    };
    // Two reads, not one: the poll asks a question the TAIL answers, so it
    // pays for `HIST_PROBE` messages per attempt instead of the whole
    // transcript — and only the attempt that settles it pays for a full page.
    const probe = (attempt: number) => {
      central
        .rpc<SessionMessagesResult>(machineId, 'session.messages', {
          sessionId: session.sessionId,
          cwd: session.cwd,
          source: session.source,
          toolChars: TOOL_CHARS,
          limit: HIST_PROBE,
        }, true)
        .then((r) => {
          if (cancelled) return;
          // A stale page (the hub's old copy, served when the agent was slow)
          // says nothing about whether the file caught up: its last user/
          // assistant pair is an OLD one, and trusting it cleared the live
          // answer off the screen (26.09.2026). Keep polling instead.
          if ((r.stale === true || !caughtUp(r.messages) || !hasLastSent(r.messages)) && attempt < 6) {
            setTimeout(() => !cancelled && probe(attempt + 1), 400);
            return;
          }
          read();
        })
        .catch(() => {});
    };
    const read = () => {
      central
        .rpc<SessionMessagesResult>(machineId, 'session.messages', {
          sessionId: session.sessionId,
          cwd: session.cwd,
          source: session.source,
          toolChars: TOOL_CHARS,
          limit: histLimit,
        }, true)
        .then((r) => {
          if (cancelled) return;
          // A stale page never replaces one already on screen: what is shown
          // is at least as new, and the live lines stay (below).
          if (r.stale === true && historyLenRef.current > 0) return;
          setHistory(r.messages);
          setHistMore(r.messages.length >= histLimit);
          // The convergence read replaces the page, so it also decides whether
          // the «копия с хаба» note still applies.
          setHistStale(r.stale === true);
          // Only supersede the live buffer once the file demonstrably contains
          // the turn AND the last thing sent from here, and never while a NEW
          // turn is already streaming into it.
          if (r.stale !== true && caughtUp(r.messages) && hasLastSent(r.messages) && !busyRef.current) {
            lastSentRef.current = null;
            central.clearLines();
          }
        })
        .catch(() => {});
    };
    probe(0);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- histLimit is read at fetch time; changing it must not re-fire a convergence pass
  }, [central.busy, central.rpc, central.clearLines, machineId, session.sessionId, session.cwd, session.source]);

  // Auto-scroll to the newest line only when the user is already at the bottom,
  // so scrolling up to read isn't yanked back mid-stream.
  //
  // Layout, not paint: a post-paint effect shows one frame at the old offset,
  // which reads as a visible jump on a long transcript.
  const pinToBottom = useCallback(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  useLayoutEffect(() => {
    if (atBottom) pinToBottom();
  }, [central.lines, history, atBottom, pinToBottom]);

  // The transcript keeps growing after that runs: webfonts land and re-flow every
  // line, markdown images have no intrinsic size until they load, code blocks
  // and tool pills expand. Each of those moves the bottom out from under a
  // scroller we already positioned, and none of them re-render anything — so
  // watch the content box itself and re-pin while the reader is following.
  //
  // The SCROLLER has to be watched too, and for the opposite reason: its height
  // changes while the content's does not. The composer auto-grows to 200px as
  // you type, the offline and read-only banners appear above it, and the shell
  // shrinks when the keyboard opens — each steals height from `.log` and drops
  // the newest lines below the fold with nothing to re-render. On a phone the
  // composer is a big share of the screen, so this is most of the drift.
  const logInnerRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(atBottom);
  atBottomRef.current = atBottom;
  useLayoutEffect(() => {
    const inner = logInnerRef.current;
    const scroller = logRef.current;
    if (!inner || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) pinToBottom();
    });
    ro.observe(inner);
    if (scroller) ro.observe(scroller);
    return () => ro.disconnect();
  }, [pinToBottom]);

  const onLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  };
  const scrollToBottom = () =>
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });

  // Text handed to a resume (`open`) the hub has not confirmed yet. A frame
  // leaving the browser is not acceptance: the hub still refuses when the
  // session is live in an editor, the machine is reconnecting, or a run is
  // already attached. Unconditionally clearing the composer on submit is what
  // used to make those messages vanish, so hold a copy until the run attaches
  // and hand it back if the resume is refused.
  // Seeded from carriedDraft: App keys this pane by sessionId, so a mount with
  // one already in flight is exactly the StartScreen hand-off case.
  const pendingResume = useRef<string | null>(carriedDraft ?? null);
  // The attachments that went out with it. Restored alongside the text, so a
  // refused resume doesn't silently drop the user's images too.
  const pendingImages = useRef<typeof picker.images>([]);
  /** Same idea for non-image attachments: a refused resume must not quietly
   *  swallow the files someone dropped in with the message. */
  const pendingFiles = useRef<typeof picker.files>([]);
  const pendingLarge = useRef<typeof picker.large>([]);

  // One send path for the composer AND the quick-reply buttons — both are the
  // same act, answering the session. Live-attached run: an `input` frame is
  // delivery once the socket takes it. Otherwise a resume (`open`) with the
  // refusal safety net: the text is held until the agent demonstrably drives,
  // and a refused resume lands it (back) in the composer below.
  const sendText = (
    text: string,
    images: ReturnType<typeof picker.toImages>,
    staged: typeof picker.images = [],
    files?: ReturnType<typeof picker.toFiles>,
    stagedFiles: typeof picker.files = [],
    stagedLarge: typeof picker.large = [],
  ): boolean => {
    // Uploaded files are named at the END of what goes out; `text` stays what
    // the person typed, so a refused send can put exactly that back.
    const wire = withUploadedFiles(
      text,
      stagedLarge.flatMap((c) => (c.path ? [c.path] : [])),
    );
    if (isActive) {
      if (!central.sendInput(wire, images, files)) return false;
      // The transcript will hold what went out, the uploads' block included.
      lastSentRef.current = wire.trim() || null;
    } else {
      // The pick made while detached rides the resume: the agent opens the
      // session on it before the first turn, and `run_settings` then retires
      // the optimistic value like any other.
      const startup = {
        model: modelPick || undefined,
        effort: effortPick && effortPick !== 'ultracode' ? (effortPick as EffortLevel) : undefined,
      };
      if (!central.open(machineId, session.sessionId, wire, images, files, startup)) return false;
      pendingResume.current = text;
      pendingImages.current = staged;
      pendingFiles.current = stagedFiles;
      pendingLarge.current = stagedLarge;
    }
    return true;
  };

  /** Send a specific string, which is not always the draft: a dictation ended
   *  with the send button arrives long after that button was pressed, and what
   *  is in `draft` by then is whatever React last committed. */
  const submitText = (text: string) => {
    if (!machineOnline || takingOver || gated || (!text.trim() && !picker.hasAttachments)) return;
    const waiting = picker.largeBlock();
    if (waiting) {
      void showNotice(waiting);
      return;
    }
    if (!sendText(text, picker.toImages(), picker.images, picker.toFiles(), picker.files, picker.large)) return;
    lastClearedRef.current = { text, at: Date.now(), images: picker.images, files: picker.files, large: picker.large };
    setDraft('');
    picker.clearAll();
  };
  // A sealed send is asynchronous: `send` says true before the message is
  // encrypted and transmitted. When that later fails, the text goes back.
  useEffect(() => {
    const onFailed = () => {
      const last = lastClearedRef.current;
      lastClearedRef.current = null;
      if (last && Date.now() - last.at < 15_000) {
        setDraft((d) => d || last.text);
        picker.restore(last.images, last.files, last.large);
      }
    };
    window.addEventListener('cc-send-failed', onFailed);
    return () => window.removeEventListener('cc-send-failed', onFailed);
  }, []);
  const submit = () => submitText(draft);
  // The recorder's callback is built once, before `submitText` exists, and must
  // call the CURRENT one — see the note there.
  // Gated: keep a dictated message in the box instead of dropping it.
  submitRef.current = gated ? (t: string) => setDraft(t) : submitText;

  // Released only once the AGENT is demonstrably driving. Attaching is not
  // enough: the hub acks `opened` as soon as it queues the resume, and the agent
  // can still come back with `yielded` (session taken in an editor), which is
  // exactly the case where the text must survive.
  useEffect(() => {
    if (!central.runConfirmed) return;
    // A carried draft seeds BOTH the pending ref and the composer, so that a
    // refused hand-off has the text to give back. Once the agent is driving
    // there is nothing to give back, and leaving the delivered message sitting
    // in the box invites sending it twice — DraftStore persists it, so it also
    // came back on the next visit to that session.
    if (carriedDraft) setDraft((d) => (d === carriedDraft ? '' : d));
    pendingResume.current = null;
    pendingImages.current = [];
    pendingFiles.current = [];
    pendingLarge.current = [];
  }, [central.runConfirmed]);

  // The resume was refused. Put the text back so the user can retry instead of
  // retyping it; useCentral has already taken back its optimistic echo.
  //
  // Keyed on `refusal` — the hub actually saying no — and NOT on `error`, which
  // is every toast the app can raise. A failed dictation writes to `error` too,
  // so tapping the mic while a resume was in flight used to hand the message
  // back into the composer while it was still on its way: one copy travelling,
  // one in the box, and pressing send again delivered it twice. `refusal`
  // starts at 0, so this cannot fire on mount and steal a carried draft.
  useEffect(() => {
    const unsent = pendingResume.current;
    if (!central.refusal || unsent === null) return;
    const images = pendingImages.current;
    const files = pendingFiles.current;
    const large = pendingLarge.current;
    pendingResume.current = null;
    pendingImages.current = [];
    pendingFiles.current = [];
    pendingLarge.current = [];
    setDraft((d) => (d ? d : unsent));
    if (images.length) picker.restoreImages(images);
    if (files.length) picker.restoreFiles(files);
    if (large.length) picker.restore([], [], large);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- picker identity churns per render; the refusal edge is the trigger
  }, [central.refusal]);

  const busy = isActive && central.busy;
  const showBackground = isActive && central.background.length > 0 && central.turnPhase !== 'working';

  // The panel over the composer: what runs in the BACKGROUND (sub-agents and
  // other tasks), joined by task id — the background list names a sub-agent
  // the same way the `subagents` level does. A foreground sub-agent is not a
  // row: its card sits right above, and the turn waits on it anyway — unless
  // there is no card to sit there: a Codex child has no `Agent` call in the
  // transcript to anchor one (v2 announces children by activity only).
  const anchored = useMemo(() => {
    const ids = new Set<string>();
    for (const m of history) for (const c of agentCallsFromBlocks(m.blocks)) if (c.toolUseId) ids.add(c.toolUseId);
    for (const c of agentCallsFromLines(central.lines)) if (c.toolUseId) ids.add(c.toolUseId);
    return ids;
  }, [history, central.lines]);
  // When the person last spoke: the panel keeps this turn's finished helpers.
  const lastHumanAt = useMemo(() => {
    for (let i = central.lines.length - 1; i >= 0; i--) {
      const l = central.lines[i]!;
      if (l.kind === 'user' && l.ts) return l.ts;
    }
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i]!;
      // A person's turn: their text, not a tool result or the CLI's notices.
      if (m.type !== 'user' || !m.ts || m.blocks.some((b) => b.kind === 'tool_result')) continue;
      if (m.blocks.some((b) => b.kind === 'text' && stripHarnessNoise(b.text).trim())) return m.ts;
    }
    return 0;
  }, [central.lines, history]);
  // The turn so far, for the session's own card: its tool steps and what it
  // is doing now. The steps come from the live tail after the person's last
  // line. Only when the tail holds no work at all — a pane opened mid-turn
  // whose replay has not arrived — does the history's tail stand in; a tail
  // that already has work (the hub's replay, the CLI woken by a background
  // task after its last turn was folded into history) is the turn itself, and
  // reading the file too would count steps twice or count the last turn's.
  const histSteps = useMemo(() => {
    const out: Step[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i]!;
      const human =
        m.type === 'user' &&
        !m.blocks.some((b) => b.kind === 'tool_result') &&
        m.blocks.some((b) => b.kind === 'text' && stripHarnessNoise(b.text).trim());
      if (human) break;
      for (let j = m.blocks.length - 1; j >= 0; j--) {
        const b = m.blocks[j]!;
        if (b.kind === 'tool_use' && !HELPER_TOOLS.has(b.name)) out.push(stepOf(b.name, b.input));
      }
    }
    return out.reverse();
  }, [history]);
  // The plan of this task, shown over the composer while the session works.
  const plan = useMemo(() => (busy ? currentPlan(history, central.lines) : null), [busy, history, central.lines]);
  const turnWork = useMemo(() => {
    if (!busy) return NO_WORK;
    const lines = central.lines;
    let start = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i]!.kind === 'user') {
        start = i;
        break;
      }
    }
    const tail = lines.slice(start + 1);
    // A helper call is not a step of the turn: it has its own card in the
    // transcript. While the turn's last step IS one (the session waits on its
    // helpers), the work card is not drawn at all — it repeated them a third
    // time under their cards (24.10.2026, owner's request).
    const calls = tail.filter((l) => l.kind === 'tool_use');
    const steps = calls.filter((l) => !isHelperLine(l.text)).map((l) => toolStep(l.text));
    const working = calls.length > 0 || tail.some((l) => l.kind === 'assistant');
    const all = start < 0 && !working ? histSteps : steps;
    const activity = workActivity(lines);
    const last = [...tail].reverse().find((l) => l.kind !== 'status' && l.kind !== 'system');
    const onHelper = last?.kind === 'tool_use' && isHelperLine(last.text);
    return { steps: all, activity, current: !onHelper && last?.kind === 'tool_use' && activity !== THINKING, waitsOnHelper: onHelper && activity !== THINKING };
  }, [busy, central.lines, histSteps]);
  // Finished helpers outlive their run (14.10.2026). The `subagents` level
  // belongs to ONE run: it empties when the run ends and starts over with the
  // next one — so a card lost its mark, counters and report the moment the
  // run closed or the next one began («они исчезают»). Keep every finished
  // one this pane has seen, per session, and lay the live level over them.
  const doneAgents = useRef<{ sessionId: string; byId: Map<string, Subagent> }>({ sessionId: session.sessionId, byId: new Map() });
  // The channel's level may still be another session's for a render after a
  // column switches (no remount): only a run of THIS session feeds the cache.
  const ownLive = isActive ? central.subagents : NO_SUBAGENTS;
  const helperRuns = ownLive.some((a) => a.status === 'running' && !a.background);
  const subagents = useMemo<Subagent[]>(() => {
    const cache = doneAgents.current;
    if (cache.sessionId !== session.sessionId) {
      cache.sessionId = session.sessionId;
      cache.byId = new Map();
    }
    for (const a of ownLive) {
      if (a.status === 'running') continue;
      cache.byId.delete(a.id);
      cache.byId.set(a.id, a);
    }
    while (cache.byId.size > 200) cache.byId.delete(cache.byId.keys().next().value!);
    const liveIds = new Set(ownLive.map((a) => a.id));
    return [...ownLive, ...[...cache.byId.values()].filter((a) => !liveIds.has(a.id))];
  }, [ownLive, session.sessionId]);
  // Sub-agent cards scrolled out of view, by the `Agent` call id. A card in
  // view IS the row — the panel repeating it right under it was a double
  // («зачем дубль»). Not reported yet = in view, so no row flashes in on mount.
  const [cardsOff, setCardsOff] = useState<ReadonlySet<string>>(() => new Set());
  const onCardView = useCallback((toolUseId: string, visible: boolean | undefined) => {
    setCardsOff((prev) => {
      const off = visible === false;
      if (prev.has(toolUseId) === off) return prev;
      const next = new Set(prev);
      if (off) next.add(toolUseId);
      else next.delete(toolUseId);
      return next;
    });
  }, []);
  const panelRows = useMemo<PanelRow[]>(() => {
    const byId = new Map(subagents.map((a) => [a.id, a] as const));
    const rows: PanelRow[] = [];
    const seen = new Set<string>();
    // A background helper with a card in the transcript is a row only while
    // that card is scrolled away; one without a card (a background Bash, a
    // Codex child — v2 announces children by activity only) is always a row.
    // A FOREGROUND one with a card is never a row: the turn waits on it, and
    // «В фоне» would be a false word for it.
    const cardShown = (toolUseId: string | undefined) => !!toolUseId && anchored.has(toolUseId) && !cardsOff.has(toolUseId);
    const hasCard = (toolUseId: string | undefined) => !!toolUseId && anchored.has(toolUseId);
    if (isActive) {
      for (const t of central.background) {
        const a = byId.get(t.id);
        seen.add(t.id);
        if (cardShown(a?.toolUseId)) continue;
        rows.push({
          id: t.id,
          label: a?.description || backgroundTaskLabel(t),
          kind: a?.kind,
          lastAction: a?.lastAction,
          since: a?.startedAt ?? t.since,
          agent: a,
          toolUseId: a?.toolUseId,
          owner: t.owner,
          // A sub-agent is its own work with its own transcript, never a repeat.
          repeatKey: a ? undefined : backgroundTaskRepeatKey(t),
        });
      }
    }
    for (const a of subagents) {
      if (seen.has(a.id)) continue;
      if (!a.background && hasCard(a.toolUseId)) continue;
      if (cardShown(a.toolUseId)) continue;
      // A finished one stays until the person speaks again: a mark, how long
      // it took, its report a click away. Its card keeps all that for good.
      if (a.status !== 'running' && (a.endedAt ?? 0) < lastHumanAt) continue;
      rows.push({ id: a.id, label: a.description, kind: a.kind, lastAction: a.lastAction, since: a.startedAt, agent: a, toolUseId: a.toolUseId });
    }
    // Running first, then the finished, newest first.
    return collapseRepeats(rows).sort((x, y) => {
      const xr = (x.agent?.status ?? 'running') === 'running';
      const yr = (y.agent?.status ?? 'running') === 'running';
      if (xr !== yr) return xr ? -1 : 1;
      return xr ? 0 : (y.agent?.endedAt ?? 0) - (x.agent?.endedAt ?? 0);
    });
  }, [isActive, central.background, subagents, anchored, cardsOff, lastHumanAt]);
  const [openAgent, setOpenAgent] = useState<OpenTarget | null>(null);

  // The optimistic user echo and the same turn re-read from the .jsonl are the
  // same message. On a fresh session they collide: `newSession` echoes the text,
  // then `session_started` makes the history effect refetch and the file already
  // has that turn — so it rendered twice, at the history/live seam. Drop the
  // echo when history already ends with it.
  // «Сжимаю…» ends on the RUN's own word, not on a timer. The agent says
  // `compact_started` the moment it queues the command and `compact_done` /
  // `compact_failed` when the CLI reports the verdict. Keyed on the CODE, never
  // on the words: the first version matched an English regex against the
  // status text, so a reworded line on either side would have un-linked the
  // two in silence — and Codex, whose lines never matched, held «Сжимаю…»
  // until the 15-minute net on every session. Only a line that is NEW counts:
  // a boundary from an earlier compaction is already sitting in the
  // transcript and would clear the state in the same tick that set it.
  useEffect(() => {
    if (!compacting) return;
    const before = linesAtCompact.current;
    const landed = central.lines.some(
      (l) =>
        (l.kind === 'status' || l.kind === 'error') &&
        !before?.has(l.id) &&
        (l.code === 'compact_done' || l.code === 'compact_failed'),
    );
    if (landed) setCompacting(false);
  }, [compacting, central.lines]);

  // The other direction. A compaction started from another tab, from the
  // phone, or before this pane reloaded arrives as a `compact_started` line —
  // the hub re-states a pending one on subscribe — and this pane must show it
  // pending too, or the button here invites the second press that ends in
  // «Not enough messages to compact.».
  useEffect(() => {
    if (compacting) return;
    // Both kinds, to match the effect above. Every emitter sends the verdict as
    // `status` today, so this is not a live bug — but the asymmetry is a trap:
    // an `error`-kind `compact_failed` would be invisible HERE while clearing
    // the state THERE, so this effect would find the older `compact_started`,
    // re-arm with a baseline that already contains the failure, and «Сжимаю…»
    // could never be cleared again — not even by the fifteen-minute net, which
    // only hands the same stale line back to this scan.
    const latest = [...central.lines]
      .reverse()
      .find((l) => (l.kind === 'status' || l.kind === 'error') && l.code?.startsWith('compact_'));
    if (latest?.code === 'compact_started') {
      linesAtCompact.current = new Set(central.lines.map((l) => l.id));
      setCompacting(true);
    }
  }, [compacting, central.lines]);

  // The net. Every signal above can be missed — a reconnect clears the live
  // lines, the run can die while the command is still queued — and a button
  // disabled on a signal that never arrives is a dead button. Fifteen minutes
  // is far past the worst queue we have measured (1m52s) and far short of
  // "stuck until reload".
  useEffect(() => {
    if (!compacting) return;
    const t = setTimeout(() => setCompacting(false), 15 * 60_000);
    return () => clearTimeout(t);
  }, [compacting]);

  // Switching the pane to another session must not carry the previous one's
  // pending state onto a button that now means a different run.
  useEffect(() => {
    setCompacting(false);
  }, [session.sessionId]);

  // Waiting for the first real read of this session — from the very first
  // frame, not from the moment the socket opens. Gating the skeleton and the
  // cached preview on `loadingHist` left a blank pane for as long as the socket
  // took to connect, which on a fresh column or a reload is most of the wait.
  const awaitingHist = loadingHist || (!histReady && !!session.cwd && central.status !== 'open');
  const liveLines = dropEchoedUserLine(central.lines, history, loadingHist);
  // Standing in for the real history until its first read lands — see
  // `cachedHist`. Only ever RENDERED: every rule below that reasons about the
  // file still reads `history`.
  const fromCache = !histReady && history.length === 0 && cachedHist.length > 0;
  // And the same collision from the other side: open a session mid-turn and the
  // hub replays the whole current turn while the file already holds the part of
  // it the runtime has flushed. Trim the file's copy — see the function.
  const shownHistory = useMemo(
    () => (fromCache ? cachedHist : loadingHist ? history : dropReplayedTurnFromHistory(history, liveLines)),
    [fromCache, cachedHist, history, liveLines, loadingHist],
  );

  // Grouping mints fresh objects, so it must be memoized: without this every
  // streamed token would hand MessageView new props and re-parse the whole
  // transcript's markdown — the exact cost its `memo` exists to avoid.
  const historyItems = useMemo(() => groupHistory(dropCliImageNotes(shownHistory)), [shownHistory]);
  // A day used to announce itself with a rule across the measure ("13 SEP"), and
  // the seam between history and the live tail with another one ("CONTINUED").
  // Both are gone: every turn now carries its own date and time in the gutter
  // (`stamp`), which is the question those rules were badly answering.
  // A live picture the file already carries is the file's now, not shown twice.
  const liveShown = useMemo(() => dropGeneratedShownInHistory(liveLines, shownHistory), [liveLines, shownHistory]);
  const liveItems = useMemo(() => groupLive(liveShown), [liveShown]);
  // The history ending on a standalone run and the live stream opening with
  // machinery are ONE stretch of work that happens to straddle what is on disk
  // and what is streaming: fold the history's run into the live one rather
  // than draw «⚙ 5» over «⚙ 11» (29.09.2026, by request).
  const lastHist = historyItems[historyItems.length - 1];
  const firstLive = liveItems[0];
  const foldHistRun =
    lastHist?.kind === 'run' &&
    !!firstLive &&
    (firstLive.kind === 'run' || (firstLive.kind === 'line' && firstLive.line.kind === 'assistant' && !!firstLive.runBefore))
      ? lastHist.blocks
      : undefined;
  // «Что сделано» after every finished turn (19.10.2026, by request): the
  // working card does not just vanish — a line stays and opens into the steps.
  const histRecaps = useMemo(() => foldHistoryRecaps(historyItems), [historyItems]);
  // Scoped to THIS session: the hub's run list says `working` before the
  // channel subscribes, and a dropped socket clears `busy` while the phase
  // stays `working` — neither is a finished turn.
  const turnOpen =
    busy ||
    // `needs_attention` is a turn paused on a question or an approval.
    ['working', 'needs_attention'].includes(central.runFor(machineId, session.sessionId)?.state ?? '') ||
    (isActive && central.turnPhase === 'working' && !!central.active?.runId);
  const recaps = useMemo(() => turnRecaps(histRecaps, liveItems, turnOpen), [histRecaps, liveItems, turnOpen]);
  const recapAfter = (id: string) => {
    const r = recaps.get(id);
    return r ? <TurnRecap steps={r.steps} ms={r.ms} /> : null;
  };

  // ---- attachments: the picture behind an image marker ----------------------
  //
  // Handed down by context (see `AttachmentContext`) rather than threaded
  // through every renderer: only a panel that knows a machine AND a session can
  // answer this at all, and the ones that cannot simply do not provide it.
  const fetchAttachment = useMemo<FetchAttachment>(
    () =>
      scopedFetch(async (ref) => {
      if (!session.sessionId) return null;
      const got = await central.rpc<{ mediaType: string; dataB64: string }>(
        machineId,
        'session.image',
        { sessionId: session.sessionId, ref, source: session.source },
        // Quiet: a picture that will not load is the placeholder coming back,
        // not something to raise a toast over the transcript about.
        true,
      );
      return got?.dataB64 ? got : null;
      }, `${machineId}\u0000${session.sessionId ?? ''}\u0000${session.source ?? ''}`),
    [central.rpc, machineId, session.sessionId, session.source],
  );

  // The files an answer names (a screenshot, a plan), read through `fs.peek`
  // from the session's folder. No folder, nothing to peek into.
  const filePeek = useMemo(
    () => (session.cwd ? makeFilePeek(central.rpc, machineId, session.cwd, central.notifyError) : null),
    [central.rpc, central.notifyError, machineId, session.cwd],
  );

  // ---- enrichment: the strip under the tail assistant turn ------------------
  // Two layers over one shape: heuristics answer instantly, the hub's LLM pass
  // (an `enrich_request` away, cached hub-side) refines the strip in place.
  // Everything keys on the tail turn's uuid, so a new turn simply replaces the
  // strip and an answered one never comes back.
  // A turn that ENDED is not yet a turn that is OVER: «запустил агента, жду»
  // ends one, and the CLI wakes on the agent's result minutes later. Only the
  // agent's `turn_settled` (or a run we never watched — a reopened session)
  // hands the floor to the person; until then the strip keeps quiet.
  // …and a job with a task still in the background is not over whatever the
  // phase says (a viewer who just opened it reads `unknown`).
  const turnOver =
    (!isActive || central.turnPhase === 'settled' || central.turnPhase === 'unknown') &&
    central.background.length === 0;
  const tail = useMemo(() => {
    // Nothing on a page from the cache is an answer yet — the strip waits for
    // the real read, or it would offer replies to a turn that may be old.
    if (busy || fromCache || !turnOver) return null;
    // Freshest first: right after a run goes idle the live lines are ahead of
    // the refetched history. A user or error line as the tail means there is
    // nothing to answer.
    for (let i = liveLines.length - 1; i >= 0; i--) {
      const l = liveLines[i]!;
      if (l.kind === 'assistant') {
        const text = stripCitations(stripHarnessNoise(l.text)).trim();
        return text ? { uuid: `live-${l.id}`, text } : null;
      }
      if (l.kind === 'user' || l.kind === 'error') return null;
    }
    for (let i = historyItems.length - 1; i >= 0; i--) {
      const it = historyItems[i]!;
      if (it.kind !== 'msg') continue;
      if (it.msg.type !== 'assistant') return null;
      const text = it.msg.blocks
        .map((b) => (b.kind === 'text' ? stripCitations(stripHarnessNoise(b.text)) : ''))
        .join('\n')
        .trim();
      return text ? { uuid: it.msg.uuid, text } : null;
    }
    return null;
  }, [busy, fromCache, turnOver, liveLines, historyItems]);

  const heuristic = useMemo(() => (tail ? heuristicEnrichment(tail.text) : null), [tail]);
  // Keyed on the turn's TEXT, not its uuid: the live tail is `live-<n>` and
  // becomes the file's uuid once history is re-read, and keying on that paid
  // for the same turn twice — cheap on a fast model, not on the one that reads
  // the whole turn now. `failed` = the model could not answer (heuristics
  // stand in); an answer, even an empty one, is final.
  const tailKey = tail ? textKey(tail.text) : null;
  const [llmEnrich, setLlmEnrich] = useState<{ key: string; data: Enrichment | null; failed?: boolean } | null>(null);
  const [answeredKey, setAnsweredKey] = useState<string | null>(null);
  const enrichAsked = useRef<string | null>(null);
  // Ideas already put into the draft this turn (cleared when a turn starts).
  const draftedIdeas = useRef(new Set<string>());
  const enrichGen = useRef(0);

  useEffect(() => {
    if (!tail || !tailKey || readOnly || takingOver || !machineOnline) return;
    if (enrichAsked.current === tailKey) return;
    enrichAsked.current = tailKey;
    // Keep the END of a long turn — the question lives there. The digest says
    // what the turn DID (asked, ran, failed), so a suggestion is not a step the
    // agent already took; the user turn stays as the fallback for a digest-less
    // hub.
    const text = tail.text.slice(-ENRICH_MAX_INPUT);
    const userText = lastUserText(history)?.slice(0, 4000);
    const digest = buildTurnDigest(shownHistory, liveLines, { cwd: session.cwd });
    const key = tailKey;
    // An answer that lands after the next turn started belongs to no one: a
    // turn ending with the same words would otherwise show the old buttons.
    const gen = enrichGen.current;
    central
      .enrich(machineId, session.sessionId, session.source, tail.uuid, text, userText, digest)
      .then((data) => gen === enrichGen.current && setLlmEnrich({ key, data }))
      .catch(() => gen === enrichGen.current && setLlmEnrich({ key, data: null, failed: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the tail turn; the rest is read at fire time
  }, [tailKey, readOnly, takingOver, machineOnline]);

  const enrichment = useMemo(() => {
    if (!tail || tailKey === answeredKey) return null;
    // Nothing while the model thinks: a Да/Нет that the verdict then removes
    // is worse than a strip that appears once, right.
    if (llmEnrich?.key !== tailKey) return null;
    return mergeEnrichment(heuristic, llmEnrich.failed ? null : llmEnrich.data);
  }, [tail, tailKey, heuristic, llmEnrich, answeredKey]);

  const showStrip = !!enrichment && !busy && !takingOver && !readOnly && machineOnline;

  // A new turn starts → forget the last answer. Keyed on text alone, a turn
  // that ends with the same words as the previous one («Готово.») would
  // otherwise inherit its buttons.
  useEffect(() => {
    if (!busy) return;
    enrichAsked.current = null;
    enrichGen.current++;
    draftedIdeas.current.clear();
    setAnsweredKey(null);
    setLlmEnrich(null);
  }, [busy]);

  // The cards' and the panel's actions. Stop is for whoever may drive the run;
  // the agent refuses an id its run does not know.
  const agentNoticeMap = useMemo(() => agentNotices(shownHistory), [shownHistory]);
  const subagentApi = useMemo<SubagentsApi>(
    () => ({
      live: new Map(subagents.flatMap((a) => (a.toolUseId ? [[a.toolUseId, a] as const] : []))),
      notices: agentNoticeMap,
      open: setOpenAgent,
      stop: readOnly
        ? undefined
        : (id: string) => {
            central
              .rpc(machineId, 'run.stopSubagent', { sessionId: session.sessionId, id })
              .catch((e: unknown) => central.notifyError(e instanceof Error ? e.message : String(e)));
          },
      runAlive: isActive && !!central.active?.runId,
      onCardView,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rpc/notifyError are stable
    [subagents, agentNoticeMap, readOnly, machineId, session.sessionId, isActive, central.active?.runId, onCardView],
  );
  const openAgentLive = openAgent
    ? subagents.find((a) => (openAgent.toolUseId && a.toolUseId === openAgent.toolUseId) || (openAgent.id && a.id === openAgent.id))
    : undefined;
  const openAgentRunning = openAgentLive?.status === 'running';
  const loadOpenAgent = useCallback(
    () =>
      central
        .rpc<{ messages: HistoryMessage[] }>(machineId, 'session.subagent', {
          sessionId: session.sessionId,
          cwd: session.cwd,
          source: session.source,
          ...(openAgent?.toolUseId ? { toolUseId: openAgent.toolUseId } : {}),
          ...(openAgent?.id ?? openAgentLive?.id ? { id: openAgent?.id ?? openAgentLive?.id } : {}),
          toolChars: TOOL_CHARS,
        })
        .then((r) => r.messages),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per opened agent
    [openAgent, machineId, session.sessionId],
  );
  const renderAgentTranscript = useCallback(
    (messages: HistoryMessage[]) =>
      groupHistory(messages).map((it) =>
        it.kind === 'msg' ? (
          <MessageView key={it.id} msg={it.msg} agent={openAgent?.title.split(' · ')[0] ?? 'агент'} you="задача" cont={it.cont} showStamp={it.showStamp} runBefore={it.runBefore} runAfter={it.runAfter} />
        ) : it.kind === 'seam' ? (
          <div key={it.id} className="seam">
            {it.blocks.map((b, i) => (
              <BlockView key={i} block={b} />
            ))}
          </div>
        ) : (
          <ToolRunRow key={it.id} blocks={it.blocks} />
        ),
      ),
    [openAgent],
  );
  const closeAgent = useCallback(() => setOpenAgent(null), []);

  const quickReply = (text: string) => {
    if (!tail || !sendText(text, [])) return;
    // Hidden immediately; the optimistic user echo flips the tail anyway.
    setAnsweredKey(tailKey);
  };

  // An `idea` is not sent: it joins the draft (never replaces it) and the
  // composer takes focus, so the person reads it, edits it and sends it.
  const draftIdea = (text: string) => {
    // A second tap on the same idea must not paste it twice. Remembered per
    // turn by the tap itself, not inferred from the draft: a hand-written
    // sentence that happens to contain the idea's words is not the idea.
    const tapKey = `${tailKey}\n${text}`;
    if (!draftedIdeas.current.has(tapKey)) {
      draftedIdeas.current.add(tapKey);
      setDraft((d) => (d.trim() ? `${d.replace(/\s+$/, '')} ${text}` : text));
    }
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    requestAnimationFrame(() => ta.setSelectionRange(ta.value.length, ta.value.length));
  };

  return (
    <AttachmentContext.Provider value={fetchAttachment}>
    <FilePeekContext.Provider value={filePeek}>
    <SubagentsContext.Provider value={subagentApi}>
    <div className={lite ? 'chat lite' : 'chat'}>
      {takingOver && (
        <div className="warn-banner">
          Забираем сессию у {session.entrypoint ?? 'редактора'}: останавливаем его и продолжаем здесь…
        </div>
      )}
      {privateMachine && !privacy.hasKey && (
        <div className="warn-banner private-key-banner">
          Зашифровано на машине — нужен ключ. Содержимое сессий этой машины сервер видеть не может.{' '}
          <button
            type="button"
            className="btn"
            onClick={() => requestPairDialog({ machineId, machineName: machineEntry?.machine.name })}
          >
            Ввести код пары
          </button>
        </div>
      )}
      {!machineOnline && !archived && (
        <div className="warn-banner">
          Машина не в сети, показываем сохранённую историю. Продолжить можно, когда она подключится.
        </div>
      )}
      {archived ? (
        <div className="read-only-banner">
          Архив: файл переписки удалён с машины, история сохранена на сервере. Её можно читать, но не продолжить.
        </div>
      ) : (
        readOnly && <div className="read-only-banner">Общая сессия, только чтение. Просмотры записываются в журнал пространства.</div>
      )}

      <div className={`log ${isCodex ? 'codex' : ''}`} ref={logRef} onScroll={onLogScroll}>
        <StickyAsk logRef={logRef} />
        <div className="log-inner" ref={logInnerRef}>
        {/* The cached page stands in for the skeleton, never beside it: four
            grey bars say "wait", the conversation itself says the same and is
            worth reading. */}
        {awaitingHist && !fromCache && (
          <div className="skel-list" aria-label="Загружаем историю">
            <div className="skel skel-line w70" />
            <div className="skel skel-line w90" />
            <div className="skel skel-block" />
            <div className="skel skel-line w50" />
          </div>
        )}
        {histError && !loadingHist && history.length === 0 && (
          <div className="hist-fail" role="status">
            История не загрузилась — машина занята или недоступна.
            <button type="button" className="hist-more" onClick={() => setHistRetry((n) => n + 1)}>
              Повторить
            </button>
          </div>
        )}
        {histStale && !loadingHist && history.length > 0 && (
          <div className="hist-stale" role="status">
            Показана копия с хаба — машина не ответила вовремя; последние минуты могут отсутствовать.
          </div>
        )}
        {/* The open pays for one page. Everything before it is still there and
            still reachable — but on demand, not on every open and every
            reconnect. */}
        {histMore && !loadingHist && (
          <button
            type="button"
            className="hist-more"
            onClick={() => setHistLimit((n) => Math.min(2000, n + HIST_PAGE * 2))}
          >
            Показать более ранние
          </button>
        )}
        {(foldHistRun ? historyItems.slice(0, -1) : historyItems).map((it) => (
          <Fragment key={it.id}>
          {it.kind === 'msg' ? (
            <MessageView
              key={it.id}
              msg={it.msg}
              agent={agentName(session.source)}
              you={me}
              cont={it.cont}
              showStamp={it.showStamp}
              runBefore={it.runBefore}
              runAfter={it.runAfter}
            />
          ) : it.kind === 'seam' ? (
            <div key={it.id} className="seam">
              {it.blocks.map((b, i) => (
                <BlockView key={i} block={b} />
              ))}
            </div>
          ) : (
            <div key={it.id} className="run-row-wrap">
              <ToolRunRow blocks={it.blocks} />
              <SubagentCards calls={agentCallsFromBlocks(it.blocks)} />
            </div>
          )}
          {recapAfter(it.id)}
          </Fragment>
        ))}
        {liveItems.map((it, i) => (
          <Fragment key={it.id}>
          {it.kind === 'line' ? (
            <LiveLine
              key={it.id}
              line={it.line}
              agent={agentName(session.source)}
              you={me}
              cont={it.cont}
              showStamp={it.showStamp}
              runBefore={it.runBefore}
              runBeforeHistory={i === 0 ? foldHistRun : undefined}
              runAfter={it.runAfter?.lines}
              runCurrent={!!it.runAfter?.tail && central.busy}
            />
          ) : (
            <div key={it.id} className="run-row-wrap">
              <LiveRunRow
                lines={it.lines}
                current={it.tail && central.busy}
                before={i === 0 ? foldHistRun : undefined}
              />
              <SubagentCards calls={[...agentCallsFromBlocks(i === 0 ? foldHistRun : undefined), ...agentCallsFromLines(it.lines)]} />
            </div>
          )}
          {recapAfter(it.id)}
          </Fragment>
        ))}
        {/* The turn ended but the job did not: the agent withholds `result`
            while a background task lives, so the run stays `working` (busy) —
            and what works is the task. Say that, with its own clock, instead of
            25 minutes of a bare «работает…». The CLI waking on it
            (`session_state: running`) is a turn again. */}
        <SubagentPanel rows={panelRows} />
        {/* Waiting on a foreground helper: its card above is the work. One
            that ended or went to the background with no line since — the
            session is thinking, not «Работает помощник». */}
        {busy && !showBackground && !(turnWork.waitsOnHelper && helperRuns) && (
          <SessionWorkCard
            model={activeLabel === MODEL_PLACEHOLDER ? undefined : activeLabel.replace(/\s*\([^)]*\)\s*$/, '').trim() || undefined}
            activity={turnWork.waitsOnHelper ? THINKING : turnWork.activity}
            steps={turnWork.steps}
            current={turnWork.current}
            startedAt={central.runFor(machineId, session.sessionId)?.taskStartedAt ?? central.runFor(machineId, session.sessionId)?.since}
          />
        )}
        {showStrip && enrichment && <EnrichStrip enrichment={enrichment} onReply={quickReply} onDraft={draftIdea} />}
        </div>
      </div>

      {!atBottom && (
        <button className="scroll-bottom" onClick={scrollToBottom} aria-label="Вниз к последнему">
          <ArrowDownIcon size={16} />
        </button>
      )}

      {!readOnly && gated && <RuntimeGate central={central} machineId={machineId} runtime={isCodex ? 'codex' : 'claude'} />}
      {!readOnly && <div className="composer" ref={composerRef}>
        {/* The whole box is the drop target, not just the textarea: aiming a
            dragged file at a one-line field is fiddly, and the preview row and
            buttons are part of "the message area" as far as anyone is
            concerned. Paste is bound here too, so it works whether or not the
            caret happens to be in the textarea. */}
        {/* `idle` = nothing typed and nothing staged. On a narrow pane that
            collapses the whole thing to ONE row — `+`, the field, mic, send —
            and the CSS un-collapses it on `:focus-within`, so the state is
            "empty AND not being used" without a second piece of React state
            chasing focus. See the `.composer-box.cg.idle` block in styles.css
            for what it buys and what it costs. */}
        {/* The plan limit, on top of the field it is spent from — VS Code's
            «You've used 76% of your weekly limit · resets in 2d». */}
        {/* Claude's plan: a Codex session on the same machine is another account. */}
        <RateLimitBanner machineId={machineId} notice={isCodex ? null : central.rateLimit} />
        {plan && plan.total > 0 && <PlanStrip items={plan.items} progress={plan} />}
        <div
          className={`composer-box cg ${!engaged && !draft.trim() && !picker.hasAttachments ? 'idle' : ''} ${recorder.state !== 'idle' ? 'dict' : ''} ${picker.dragging ? 'dropping' : ''}`}
          onPaste={picker.onPaste}
          onDragOver={picker.onDragOver}
          onDragLeave={picker.onDragLeave}
          onDrop={picker.onDrop}
        >
          <AttachPreview picker={picker} />
          {/* Takes the field's place while dictating — the draft is untouched
              in state and comes back with the recognised text appended. Sits
              inside the box, like the attachment chips, so the composer's
              ResizeObserver already accounts for it in `--composer-h`. */}
          <DictationStrip recorder={recorder} />
          {recorder.state === 'idle' && <DictationSwitch sw={dictSwitch} />}
          <textarea
            ref={taRef}
            value={draft}
            rows={1}
            /* Russian, like every other string a person reads in this product.
               The composer was the one control still speaking English, and it
               is the control they use most. */
            placeholder={
              !machineOnline
                ? 'Машина офлайн — только чтение'
                : isActive
                  ? 'Напишите сообщение…'
                  : takingOver
                    ? 'Перехватываю…'
                    : 'Напишите, чтобы продолжить сессию…'
            }
            disabled={!machineOnline}
            onFocus={() => {
              if (unengage.current) clearTimeout(unengage.current);
              setEngaged(true);
            }}
            onBlur={() => {
              if (unengage.current) clearTimeout(unengage.current);
              unengage.current = setTimeout(() => setEngaged(false), 260);
            }}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (slash.onKeyDown(e)) return;
              if (!enterShouldSend(e)) return;
              e.preventDefault();
              submit();
            }}
          />
          {slash.menu}
          <div className="composer-actions">
            <AttachButton picker={picker} />
            {slash.button}
            <div className="composer-tools">
              {lite ? (
                isActive &&
                modes.includes('plan') && (
                  <button
                    type="button"
                    className={`plan-toggle${planOn ? ' on' : ''}`}
                    aria-pressed={planOn}
                    onClick={() => togglePlan(!planOn)}
                    title={planOn ? 'Сначала план: агент ничего не меняет, пока вы его не утвердите' : 'Включить режим планирования'}
                  >
                    План
                  </button>
                )
              ) : isActive ? (
                <>
                  {/* Model and effort used to be Claude-only. They are not:
                      `CodexSessionRun.setModel`/`setEffort` ride the next
                      `turn/start` collaboration mode, and the app-server names
                      its own models through `model/list`. What differs is the
                      LIST, which is why `models.list` is asked per runtime.

                      One control, not two selects — see RunPicker for why the
                      `<select>`s had to be 16px on a phone and a button does
                      not.

                      The MODE is back here too. It was moved out on the
                      argument that it is a property of the session rather than
                      of the message — true when you set it once at the start,
                      and false in the case people actually hit: the run is
                      editing and you want to stop it and think. Asking for that
                      meant opening ⓘ, which is a column at ≥1200px and a modal
                      sheet over the conversation below it. The wire has carried
                      it all along (`set_permission_mode` → agent →
                      `query.setPermissionMode`, echoed back as `run_mode`), so
                      this is a control that was missing, not a capability.
                      It stays in the info panel as well — same state, two
                      placements, like «О сессии» itself. */}
                  {central.contextUsage && (
                    <ContextRing
                      usage={central.contextUsage}
                      cost={central.sessionCost}
                      compacting={compacting}
                      onCompact={() => {
                        // Pending until the transcript reports the boundary or
                        // a failure (see the `compacting` effects): `/compact`
                        // is a QUEUED turn, measured at 1m52s behind a busy run,
                        // and a guess that expires early is not feedback. The
                        // baseline is what makes the second press impossible.
                        linesAtCompact.current = new Set(central.lines.map((l) => l.id));
                        setCompacting(true);
                        central.compact();
                      }}
                    />
                  )}
                  <RunPicker
                    plan={modes.includes('plan') ? { on: planOn, onToggle: togglePlan } : undefined}
                    modelLabel={activeLabel}
                    models={picks}
                    model={model}
                    /* What the ACCOUNT would pick, which is the whole point of
                       that row — not what this session pinned. Passing
                       `activeLabel` made the row echo the override: pin Haiku
                       and «по аккаунту» started claiming the account default
                       was Haiku. On an unpinned session it was quieter but no
                       better — the same name appeared twice, once highlighted
                       and once not. `defaultName` is the runtime's own
                       `default` row, resolved. */
                    accountLabel={defaultName ?? 'Как в аккаунте'}
                    noAccountRow={sessionOnGo}
                    effort={effort}
                    /* What the run is ACTUALLY at when nothing was pinned. The
                       picker used to have no way to tell «nobody chose» from
                       «we do not know» and had to print the provenance («по
                       аккаунту») in the place a level belongs. */
                    activeEffort={settings?.activeEffort}
                    efforts={efforts}
                    effortLabel={EFFORT_LABEL}
                    effortOff={effortOff}
                    /* Never on Codex. The row promises «xhigh + оркестрация»,
                       but only `ClaudeSessionRun` has the orchestration half
                       (`applyFlagSettings({ ultracode: true })`) —
                       `CodexSessionRun.setEffort` maps ultracode to plain
                       xhigh, so on a Codex session the row was a label for
                       something that does not happen. The pinned value still
                       wins: a session that somehow carries it keeps a row to
                       render. */
                    allowUltracode={(!isCodex && efforts.includes('xhigh')) || effort === 'ultracode'}
                    onModel={(v) => {
                      // Empty = hand the choice back to the account, which
                      // `set_model` expresses by omitting the field — so send
                      // it either way, otherwise the unpinned state is one you
                      // can never return to.
                      //
                      // The optimistic pick is recorded only if the frame
                      // actually LEFT. It used to be stored regardless, and it
                      // is retired only when the run reports that exact value —
                      // so a change made while the socket was down was held for
                      // the life of the pane, and the picker went on claiming a
                      // model the session had never been put on.
                      const runId = central.active?.runId;
                      if (runId && central.setModel(runId, v)) setModelSel(v);
                    }}
                    onEffort={(v) => {
                      const runId = central.active?.runId;
                      if (!runId) return;
                      const sent =
                        v === 'ultracode'
                          ? central.setEffort(runId, undefined, true)
                          : v === ''
                            ? central.setEffort(runId)
                            : central.setEffort(runId, v as EffortLevel, false);
                      if (sent) setEffortSel(v);
                    }}
                  />
                </>
              ) : (
                /* Detached: the same control, choosing what the session will be
                   CONTINUED on (27.09.2026, by request — «верни модели»). The
                   picks are local until the resume carries them; no ultracode
                   and no plan switch, which only a live run can take. */
                <RunPicker
                  modelLabel={activeLabel}
                  models={picks}
                  model={model}
                  accountLabel={defaultName ?? 'Как в аккаунте'}
                  noAccountRow={sessionOnGo}
                  effort={effort}
                  efforts={efforts}
                  effortLabel={EFFORT_LABEL}
                  effortOff={effortOff}
                  allowUltracode={false}
                  onModel={(v) => setModelSel(v)}
                  onEffort={(v) => setEffortSel(v)}
                />
              )}
            </div>
            {!privateMachine && <VoiceButton recorder={recorder} />}
            {/* A working run REPLACED Send with Stop, so there was no way to say
                anything to a session that was busy — you could only kill the
                turn and start again. But `submit` already handles this: an
                attached run takes `sendInput`, and the hub delivers it straight
                into the conversation. The iOS composer has always shown both
                (ComposerView.trailingButtons: the send circle whenever the run
                is attached, plus a stop circle whenever it is busy). Match it —
                Stop stays one tap away, Send stops disappearing. */}
            {isActive ? (
              /* ONE slot, two roles — the reference merges them and so do we,
                 but not by the reference's rule. ChatGPT can collapse Stop into
                 Send because it will not take a message mid-generation; this
                 product will, and `submit` delivers straight into the running
                 turn. Losing that to match a silhouette would be trading a
                 capability for a shape.

                 So the split is on what you are holding, which is the same
                 thing the reference actually does: nothing typed while the run
                 works — the only useful action is to stop it; something typed —
                 the only useful action is to send it. Stop never hides behind a
                 menu, and Send never disappears from under a drafted message. */
              /* While the microphone is live, send means SEND THIS — finish
                 the recording, recognise it, and deliver it. Dictating and then
                 having to find the text, read it and press a second button is
                 two steps for one intention, and on a phone the second button
                 is the one your thumb was already on. The microphone keeps the
                 other behaviour (stop INTO the composer), so looking before
                 sending is still one tap away — it just is not the only way. */
              recorder.state === 'recording' ? (
                <button
                  className="send-round"
                  disabled={!machineOnline}
                  onClick={recorder.sendNow}
                  title="Закончить запись и отправить"
                  aria-label="Закончить запись и отправить"
                >
                  <ArrowUpIcon size={16} weight="bold" />
                </button>
              ) : busy && !draft.trim() && !picker.hasAttachments ? (
                <button
                  className="send-round stop"
                  onClick={central.interrupt}
                  title="Остановить"
                  aria-label="Остановить"
                >
                  <SquareIcon size={13} weight="fill" />
                </button>
              ) : (
                <button
                  className="send-round"
                  disabled={
                    !machineOnline ||
                    !!gated ||
                    recorder.state === 'transcribing' ||
                    (!draft.trim() && !picker.hasAttachments)
                  }
                  onClick={submit}
                  title={
                    recorder.state === 'transcribing'
                      ? 'Распознаю запись…'
                      : busy
                        ? 'Отправить в идущий ход'
                        : 'Отправить'
                  }
                  aria-label="Отправить"
                >
                  <ArrowUpIcon size={16} weight="bold" />
                </button>
              )
            ) : (
              /* The same round send as a live session (27.09.2026, by request):
                 a labelled «Продолжить ↑» pill made a detached session look
                 like a different screen. Sending here IS continuing. */
              <button
                className="send-round"
                disabled={!machineOnline || takingOver || !!gated || (!draft.trim() && !picker.hasAttachments)}
                onClick={submit}
                title="Отправить и продолжить сессию"
                aria-label="Отправить"
              >
                <ArrowUpIcon size={16} weight="bold" />
              </button>
            )}
          </div>
        </div>
        {/* The line under the box — «Контекст N%» and «Сжать контекст» — is
            gone (27.09.2026, by request): the context is a ring beside the
            model now (`ContextRing`), and pressing it asks whether to compact. */}
      </div>}
      {openAgent && (
        <SubagentTranscript
          key={`${openAgent.toolUseId ?? ''}:${openAgent.id ?? ''}`}
          target={openAgent}
          running={openAgentRunning}
          load={loadOpenAgent}
          render={renderAgentTranscript}
          onClose={closeAgent}
        />
      )}
    </div>
    </SubagentsContext.Provider>
    </FilePeekContext.Provider>
    </AttachmentContext.Provider>
  );
}

/** How much of the tail turn the enrich pass reads (the hub's MAX_TEXT is
 *  16 000); the end is kept, where the question lives. */
const ENRICH_MAX_INPUT = 15_000;
