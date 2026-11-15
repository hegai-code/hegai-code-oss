import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StartWorktree, defaultBranchName, useIsRepo, type WorktreeChoice } from './StartWorktree.js';
import { useSlashMenu } from './SlashMenu.js';
import type { ImageInput, FileInput, SessionCategory, ViewerContext } from '@cc-remote/shared';
import { SESSION_CATEGORIES, categoryRunnable } from '@cc-remote/shared';
import type { CentralState, StartSettings } from '../useCentral.js';
import {
  indexRuns,
  projectTargets,
  recentProjects,
  sessionIsActive,
  sessionIsMine,
  sessionIsWorking,
  sessionKey,
  type ExtraTarget,
  type ProjectTarget,
} from '../lib.js';
import { useDictationComposer } from '../useDictationComposer.js';
import { ArrowUpIcon, CaretDown, Cpu, Folder, FolderOpen, FolderPlus, Lightning, MoreIcon } from '../icons.js';
import { AgentMark } from './AgentMark.js';
import { useImageAttachment, useAutoGrowTextarea, AttachPreview, AttachButton, VoiceButton, DictationStrip, DictationSwitch, DraftStore, enterShouldSend } from '../composer.js';
import { polishContext } from '../polish.js';
import { linkProps, navigate } from '../router.js';
import { FIRST_PROMPT, NewProjectPanel, type CreatedProject } from './NewProjectPanel.js';
import { NewFolderPanel, shareRootFor } from './NewFolderPanel.js';
import { TakeYourCode } from './TakeYourCode.js';
import { StartRunPicker } from './StartRunPicker.js';
import { goModelOrDefault, modelsForSide, useModelList } from './run-settings.js';
import { shouldWelcome, Welcome } from './Welcome.js';
import { claudeOff, codexOnGateway, pickRuntime, runtimeGate } from './runtimeChips.js';
import { RuntimeGate } from './RuntimeGate.js';
import { useHiddenMachines, useHiddenProjects } from '../appHooks.js';
import { storageGet, storageRemove, storageSet } from '../storage.js';
import { askConfirm } from '../dialogs.js';

/** Draft key prefix for the start screen, keyed by project. `SendToSession`
 *  writes here when it hands paths to a not-yet-existing session. */
const NEW_DRAFT_PREFIX = 'new::';

/** Rows in «Сейчас в работе» before the tail becomes an expand control. See the note at
 *  the render site: a `livePid` is any editor window left open, so this list is
 *  bounded by how many folders someone happens to have in VS Code, not by how
 *  much work is going on. */
const LIVE_ROWS = 5;

/**
 * Enough of the path to tell same-named projects apart — the SHORTEST suffix
 * that is actually different across the group.
 *
 * `claudehegai` exists twice on buildbox-pc. The first attempt printed the
 * parent folder, and on the real fleet that turned out to be `Hegai_VScode`
 * for BOTH copies: two rows, same name, same qualifier, still nothing to
 * choose between them. So the fragment cannot be a fixed depth — it has to be
 * however deep the paths stop agreeing.
 *
 * Returns a key→fragment map for the whole group, because «shortest suffix
 * that differs» is a property of the SET, not of one path.
 */
function disambiguate(group: ProjectTarget[]): Map<string, string> {
  const out = new Map<string, string>();
  if (group.length < 2) return out;
  const split = group.map((p) => ({ p, parts: p.cwd.split(/[\\/]+/).filter(Boolean) }));
  const deepest = Math.max(...split.map((x) => x.parts.length));
  for (let take = 2; take <= deepest; take += 1) {
    const seen = new Set(split.map((x) => x.parts.slice(-take).join('/')));
    if (seen.size === split.length) {
      // Drop the leaf: it is the label already printed beside this fragment.
      for (const x of split) out.set(sessionKey(x.p.machineId, x.p.cwd), x.parts.slice(-take, -1).join('/'));
      return out;
    }
  }
  // Paths that agree all the way down cannot happen (cwd is the key), but a
  // fallback beats an empty qualifier on a row that needs one.
  for (const x of split) out.set(sessionKey(x.p.machineId, x.p.cwd), x.p.cwd);
  return out;
}

const OPENCODE_LOADING_NOTE = 'Модели OpenCode ещё загружаются. Отправьте через пару секунд или выберите другого агента.';

/** What the start screen offers. OpenCode runs as Codex on the wire. */
type AgentChoice = 'claude' | 'codex' | 'opencode';

/** Where the last model/effort/mode pick for a machine+engine is remembered.
 *  Client-local on purpose: `run_settings` is per-RUN and dies with it, and the
 *  hub has no per-user preference store — the same shelf `cc-agent` sits on. */
const STARTRUN_PREFIX = 'cc-start-run::';

/** Read a remembered pick, tolerating anything that is not one. The value is
 *  free-form localStorage that a previous build (or a person with devtools) may
 *  have written, and a start screen that throws on it is worse than one that
 *  forgets.
 *
 *  The permission mode is deliberately NOT restored — model and effort only.
 *  A mode picked once is a mode pinned forever: it rides on every later
 *  `new_session` and outranks the machine's own default, which is how a box
 *  configured to never ask spent 24.09.2026 asking. Model and effort are
 *  preferences; the mode is a posture, and the machine is the one that knows
 *  which posture it is in. Picking one for THIS start still works — it just
 *  does not outlive the visit. Stale entries written by an older build are
 *  dropped on read, so nobody has to clear their browser to be rid of one. */
function loadStartRun(key: string): StartSettings {
  if (!key) return {};
  try {
    const raw = JSON.parse(storageGet(key) ?? '{}') as StartSettings;
    if (!raw || typeof raw !== 'object') return {};
    const { permissionMode: _pinned, ...rest } = raw;
    return rest;
  } catch {
    return {};
  }
}

/** What the popover slot is showing: the server or the project dropdown of
 *  the bar above the composer, the «Новый проект» form, or «Забрать своё». */
type Pop = 'machine' | 'project' | 'new' | 'folder' | 'take' | null;

/** The agent's `projects.remove` refusals, in the person's language. */
function describeRemoveError(message: string): string {
  if (/session is live/i.test(message)) return 'В проекте идёт сессия — закрой её, потом убирай.';
  if (/projects root/i.test(message)) return 'Убрать можно только проект из папки проектов на машине.';
  if (/not found/i.test(message)) return 'Папки уже нет на машине.';
  return message;
}

/**
 * The composer, and the one decision it needs: WHERE (the project shelf). Typing a task and sending starts a brand-new
 * session in the selected project (`onNewSession`).
 *
 * It is deliberately only that. It used to also greet you by name and carry
 * «Активная работа», five shortcut rows and «Недавние сессии» underneath — a
 * second rendering of the session list that sits in the column beside this very
 * screen on a desktop, and is the whole screen on a phone. Adding a list here
 * does not help anyone find a session; it just makes the composer the thing you
 * scroll past.
 */
export function StartScreen({
  central,
  onNewSession,
  extraTargets = [],
  initialTarget,
  initialCategory,
  initialCreate,
  instance,
  viewer,
  onProjectsChanged,
}: {
  central: CentralState;
  onNewSession: (
    machineId: string,
    cwd: string,
    message?: string,
    images?: ImageInput[],
    project?: string,
    category?: SessionCategory,
    source?: 'claude' | 'codex',
    files?: FileInput[],
    startup?: StartSettings,
    /** Whether the start actually LEFT the browser. A composer must not clear
     *  itself for a message that never went. */
  ) => boolean;
  /** Startable roots not yet backed by a discovered session: control-shares,
   *  and projects the agent found by scanning its root (`useOwnedProjects`). */
  extraTargets?: ExtraTarget[];
  /**
   * The ONE project to aim at, as the pair that actually identifies one.
   *
   * A label cannot be it: this fleet has `crm` on two boxes and `hegai` on
   * three, so «новая сессия здесь» aimed by name could land on the right name
   * on the wrong machine.
   */
  initialTarget?: { machineId: string; cwd: string };
  /** Work type preselected by the address (`/w/new?cat=sync`) — what the Home
   *  shortcuts point at. */
  initialCategory?: SessionCategory;
  /** `/w/new?create=1` — arrive with the «Новый проект» panel open. */
  initialCreate?: boolean;
  /** Which composer this is, when there are several (`/w/new?n=…` — the tab
   *  strip's «+» opens a new one each press). Its draft is its own: two tabs on
   *  one project must not type into one box. Absent = THE composer, whose
   *  per-project draft other screens («Файлы» → «Новая сессия здесь») seed. */
  instance?: string;
  /** The REST identity, for the moments before the socket's hello lands. */
  viewer?: ViewerContext | null;
  /** A project was created or removed here — re-ask the agents. */
  onProjectsChanged?: () => void;
}) {
  // Seeded from the per-project draft store, so paths handed over by «Файлы» →
  // «Новая сессия здесь» are actually here. They were being written under this
  // key and read by nobody, which made that menu item silently lose them.
  const seedKey = useState(() => storageGet('cc-project') ?? '')[0];
  const draftPrefix = instance ? `${NEW_DRAFT_PREFIX}${instance}::` : NEW_DRAFT_PREFIX;
  const [draft, setDraft] = useState(() => DraftStore.load(draftPrefix + seedKey));
  /** Which project the text currently in the box belongs to. Kept as state, not
   *  derived, because the swap below has to happen in the SAME render that
   *  replaces the text — see the note there. */
  const [draftKey, setDraftKey] = useState(seedKey);
  const who = viewer ?? central.viewer;
  const viewerId = who?.userId;
  // Which agent starts. A team member on someone else's machine does not
  // choose — the hub pins them to that machine's Codex so they never spend the
  // owner's Claude login — so they keep a badge instead of a dead control.
  const isMember = central.viewer?.workspace.role === 'member';
  const [agent, setAgent] = useState<AgentChoice>(() => {
    const kept = storageGet('cc-agent');
    return kept === 'codex' || kept === 'opencode' ? kept : 'claude';
  });
  const pickAgent = (next: AgentChoice) => {
    setAgent(next);
    storageSet('cc-agent', next);
  };
  // The shelf's popover slot: the custom picker (the native <select> looked
  // alien here), the create form, or «Забрать своё».
  const [pop, setPop] = useState<Pop>(() => (initialCreate ? 'new' : null));
  const [showAllLive, setShowAllLive] = useState(false);
  useEffect(() => {
    if (initialCreate) setPop('new');
  }, [initialCreate]);
  const [pickQ, setPickQ] = useState('');
  // `#take` opens «Забрать своё» — the address Настройки points at. It lived on
  // Главная, which is gone. Eaten on arrival so a reload does not reopen it.
  useEffect(() => {
    if (location.hash !== '#take') return;
    setPop('take');
    history.replaceState(null, '', location.pathname + location.search);
  }, []);
  const picker = useImageAttachment();
  const taRef = useAutoGrowTextarea(draft, 0.3);
  /** The selected project's label, for `/polish` — the selection is computed
   *  further down, and the recorder reads its cleaner through a ref anyway. */
  const polishProjectRef = useRef<string | undefined>(undefined);
  // The target is a private machine: dictation would send the recording to the
  // hub's speech service (docs/E2EE.md), so it is off - the microphone is hidden.
  const privateTargetRef = useRef(false);
  const polishDictation = useCallback(
    (raw: string) => central.polish({ text: raw, ...polishContext({ project: polishProjectRef.current }) }),
    [central.polish],
  );
  const transcribeDictation = useCallback(
    (blob: Blob, durSec?: number) =>
      privateTargetRef.current
        ? Promise.reject(new Error('Для зашифрованной машины диктовка выключена: запись ушла бы на сервер.'))
        : central.transcribe(blob, polishProjectRef.current, { durSec }),
    [central.transcribe],
  );
  // `draftRef` and `submitRef`: the draft and the starter for the dictation
  // callback, which fires long after it was made (see `useDictationComposer`).
  const { recorder, dictSwitch, draftRef, submitRef } = useDictationComposer({
    draft,
    setDraft,
    transcribe: transcribeDictation,
    polish: polishDictation,
    notifyError: central.notifyError,
  });
  // A line under the shelf: created / reused / could not share / could not remove.
  const [note, setNote] = useState('');
  // «В отдельной ветке»: a worktree per agent (components/StartWorktree.tsx).
  const [wt, setWt] = useState<WorktreeChoice>({ on: false, branch: '' });
  const wtBusy = useRef(false);

  // Projects made or removed on THIS screen, ahead of the agents' next
  // `projects.list`: a created one is on the shelf before the round trip, a
  // removed one is off it before the inventory forgets it.
  const [created, setCreated] = useState<ExtraTarget[]>([]);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  // The project just created here and untouched since (see ProjectTarget.fresh).
  const [fresh, setFresh] = useState<{ key: string; kind: 'empty' | 'clone' } | null>(null);

  // Every place this viewer may start a session — startable machines only, no
  // filesystem roots, "mine" resolved. See lib.ts:projectTargets.
  const runIndex = useMemo(() => indexRuns(central.activeRuns), [central.activeRuns]);
  const projects = useMemo(() => {
    const list = projectTargets(central.machines, viewerId, runIndex, [...extraTargets, ...created]).filter(
      (p) => !removed.has(sessionKey(p.machineId, p.cwd)),
    );
    if (!fresh) return list;
    return list.map((p) =>
      p.origin === 'root' && sessionKey(p.machineId, p.cwd) === fresh.key ? { ...p, fresh: fresh.kind } : p,
    );
  }, [central.machines, viewerId, runIndex, extraTargets, created, removed, fresh]);
  // Fresh ends the moment the snapshot knows a session there: the target then
  // comes from sessions, not from the root scan, and the suggested first
  // prompt has done its job.
  useEffect(() => {
    if (!fresh) return;
    const t = projects.find((p) => sessionKey(p.machineId, p.cwd) === fresh.key);
    if (t && t.origin !== 'root') setFresh(null);
  }, [projects, fresh]);
  // The shelf: yours, recent, a handful. The rest live behind the picker.
  const shelf = useMemo(() => recentProjects(projects), [projects]);

  /**
   * The chosen project, keyed by `machine::cwd` — NEVER by index.
   *
   * It used to be an index into this list, which is sorted by `lastModified`:
   * anyone in the fleet touching a session reordered it and silently re-pointed
   * the selection at a different project, with nothing on screen to say so.
   */
  const [projectKey, setProjectKey] = useState(() => storageGet('cc-project') ?? '');
  // An address that names the exact pair (`/w/new?m=…&cwd=…`) wins over what
  // this browser remembers: that is where the person asked to start.
  //
  // It wins on ARRIVAL, not for the life of the screen. It used to win every
  // render, so on an aimed composer — the tab strip's «+», a project's pencil
  // in the side panel — the picker listed every project and choosing one did
  // nothing: `pick` moved `projectKey`, and `routed` covered it again in the
  // same render (30.09.2026). Now a pick on an aimed composer REWRITES the
  // address (below), so the address and the choice never disagree, and the
  // next pencil or «+» for any project — the old one included — aims again.
  const targetKey = initialTarget ? sessionKey(initialTarget.machineId, initialTarget.cwd) : '';
  const pick = (p: ProjectTarget) => {
    const k = sessionKey(p.machineId, p.cwd);
    setProjectKey(k);
    storageSet('cc-project', k);
    // An aimed composer, or one of several: the choice goes into ITS address.
    // A background tab is not mounted, so coming back to it re-reads the
    // address — which still named the old project, and the draft typed for
    // the new one came back empty. `replace`: picking a project is not travel;
    // in a split it lands in this pane, which the click just focused.
    if ((initialTarget || instance) && k !== targetKey) {
      navigate(
        {
          kind: 'new',
          ...(initialCategory ? { cat: initialCategory } : {}),
          machineId: p.machineId,
          cwd: p.cwd,
          ...(instance ? { n: instance } : {}),
        },
        { replace: true },
      );
    }
  };
  const routed = useMemo(() => {
    if (!initialTarget) return undefined;
    return projects.find((p) => p.machineId === initialTarget.machineId && p.cwd === initialTarget.cwd);
  }, [initialTarget, projects]);
  const project =
    routed ?? projects.find((p) => sessionKey(p.machineId, p.cwd) === projectKey) ?? shelf[0] ?? projects[0];
  const selectedKey = project ? sessionKey(project.machineId, project.cwd) : '';
  const projectIsRepo = useIsRepo(central, project?.machineId, project?.cwd);
  polishProjectRef.current = project?.label;

  // A URL that re-aims the composer (`/w/new?m=…&cwd=…`) moves
  // the selection without going through `pick`, so `projectKey` stayed on
  // whatever this browser last chose. That split the draft store in two: the
  // text was READ under the remembered key and WRITTEN under it as well, while
  // the composer was pointing somewhere else entirely — one project's draft on
  // screen, saved into another project's slot. The selection is the key.
  useEffect(() => {
    if (!selectedKey || selectedKey === projectKey) return;
    setProjectKey(selectedKey);
    storageSet('cc-project', selectedKey);
  }, [selectedKey, projectKey]);

  /**
   * Switching project swaps the draft, in the same render as the key.
   *
   * This was a per-project store that behaved like a single shared box: `draft`
   * was seeded ONCE at mount and never reloaded, while the save effect below
   * fired on the selection change and wrote whatever was on screen under the
   * NEW key. So typing for project A and then tapping project B copied A's text
   * into B's slot, destroying B's own draft — silently, and for every project
   * you passed through. The same path ran for `/w/new?m=&cwd=` arrivals, which is how you could land on a project already
   * holding someone else's sentence.
   *
   * Done during render rather than in an effect on purpose. An effect would
   * leave one commit where `draftKey` is B and `draft` is still A's text, and
   * the save effect runs in that commit — writing A into B, which is the bug
   * itself. React re-runs the body before committing, so setting both here
   * means the pair is never observed apart.
   *
   * `carry`: before the inventory resolves there is no selection, and anything
   * typed in that window belongs to whatever project we are about to land on —
   * it must not be thrown away by the first resolution.
   */
  if (selectedKey && selectedKey !== draftKey) {
    const carry = draftKey === '' && draft !== '';
    setDraftKey(selectedKey);
    if (!carry) setDraft(DraftStore.load(draftPrefix + selectedKey));
  }

  // Keep what is typed, per project, the way the session composer already does.
  // Keyed on `draftKey` — the project the text actually belongs to — and not on
  // `selectedKey`, so it cannot save into a project the text was never typed for.
  useEffect(() => {
    if (!draftKey) return;
    DraftStore.save(draftPrefix + draftKey, draft);
  }, [draft, draftKey]);

  /**
   * Drop the stored draft for the project just submitted — synchronously, here.
   *
   * `setDraft('')` alone is not enough and never was: `onNewSession`/`onOpen`
   * navigate, React batches that `setRoute` with this `setDraft`, and this
   * screen unmounts in the SAME commit — so the persistence effect above never
   * re-runs with an empty string and the key survives with the full text of the
   * message that was just sent. The next «Новая сессия» then opens seeded from
   * it, which reads as the previous session's text following you into the new
   * one.
   */
  /**
   * Put a card's «···» menu under its own button, in viewport coordinates.
   *
   * The menu is `position: fixed` (see `.pcp-menu`) because the shelf clips
   * anything absolutely positioned inside it, and a fixed box has no anchor of
   * its own — so it gets one here, measured at the moment it opens.
   *
   * Written straight to the DOM node instead of through state: this is one
   * `<details>` inside a `.map()`, and holding "which card is open, and where"
   * in React would re-render the whole shelf on a menu toggle. `onToggle`
   * fires after the box exists, so the node is there to measure against.
   *
   * Clamped to the viewport: the shelf scrolls sideways, so the card that was
   * tapped can sit hard against either edge.
   */
  const anchorMenu = (e: { currentTarget: HTMLDetailsElement }) => {
    const d = e.currentTarget;
    if (!d.open) return;
    const menu = d.querySelector<HTMLElement>('.pcp-menu');
    const trigger = d.querySelector('summary');
    if (!menu || !trigger) return;
    const r = trigger.getBoundingClientRect();
    const w = menu.offsetWidth || 168;
    menu.style.left = `${Math.round(Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)))}px`;
    menu.style.top = `${Math.round(r.bottom + 6)}px`;
  };

  const forgetDraft = () => {
    // `draftKey`, the same slot the save effect writes — clearing by
    // `selectedKey` would be a second place that could disagree with it.
    if (draftKey) DraftStore.save(draftPrefix + draftKey, '');
  };

  /**
   * Projects the shelf hides, per person, in this browser.
   *
   * The fleet is nine machines and well over a hundred directories, and most of
   * them are not places this person starts work. Until now the only filter was
   * `HIDDEN_MACHINES` in App.tsx — a hard-coded regexp over three names — which
   * is a fine answer for noise the product knows about and no answer at all for
   * noise only the owner can see. Hiding is a FILTER, never a delete: the
   * header says how many are hidden and brings them back in one press.
   */
  const { hidden: hiddenProjects, setProjectHidden } = useHiddenProjects();
  const [hiddenMachines, setMachineHidden] = useHiddenMachines();
  const [showHidden, setShowHidden] = useState(false);
  const toggleHiddenProject = (key: string) => setProjectHidden(key, !hiddenProjects.has(key));
  const toggleHiddenMachine = (machineId: string) => setMachineHidden(machineId, !hiddenMachines.has(machineId));
  /** One `<details>` open at a time: two menus overlapping is what the card
   *  shelf did, and it read as broken layout rather than as two menus. */
  const closeMenu = (e: { currentTarget: Element }) =>
    e.currentTarget.closest('details')?.removeAttribute('open');


  /**
   * The two dropdowns of the bar above the composer — «сервер» and «проект».
   *
   * They replace a shelf of machine cards under the composer (27.09.2026, by
   * request: «как в мобайле или ChatGPT — над чатом две кнопки»). The cards
   * answered «where will this run» with a wall: nine machines, five projects
   * each, a table's worth of height between the composer and anything below
   * it. Two buttons say the same thing in one line, the way Codex and the
   * phone app do, and the choice they hide is one press away — with search.
   *
   * Hiding stays, as a filter on both lists: a hidden server or project is
   * left out until «показать скрытые», and search finds everything.
   */
  const machineList = useMemo(() => {
    const byMachine = new Map<string, { machineId: string; name: string; count: number; live: number; recent: number }>();
    for (const p of projects) {
      const e = byMachine.get(p.machineId);
      if (e) {
        e.count += 1;
        e.live += p.live;
        e.recent = Math.max(e.recent, p.lastModified);
      } else {
        byMachine.set(p.machineId, { machineId: p.machineId, name: p.machineName, count: 1, live: p.live, recent: p.lastModified });
      }
    }
    return [...byMachine.values()]
      .map((e) => {
        const m = central.machines.find((x) => x.machine.machineId === e.machineId);
        return {
          ...e,
          name: m?.machine.name ?? e.name,
          online: m?.online ?? false,
          owner: m?.owner && m.owner.userId !== viewerId ? m.owner : undefined,
          hidden: hiddenMachines.has(e.machineId),
        };
      })
      // A box with work on it beats a box that is merely online.
      .sort((a, b) => Number(b.online) - Number(a.online) || b.recent - a.recent);
  }, [projects, central.machines, viewerId, hiddenMachines]);

  /** The project dropdown's rows: this server's projects, or — while
   *  searching — every project anywhere whose name or server matches. */
  const projectRows = useMemo(() => {
    const q = pickQ.trim().toLowerCase();
    const list = q
      ? projects.filter((p) => `${p.label} ${p.machineName}`.toLowerCase().includes(q))
      : projects.filter(
          (p) =>
            p.machineId === project?.machineId &&
            (showHidden || !hiddenProjects.has(sessionKey(p.machineId, p.cwd)) || sessionKey(p.machineId, p.cwd) === selectedKey),
        );
    // Labels that repeat need the path — `claudehegai` lives twice on
    // buildbox-pc — and «shortest suffix that differs» is a property of the
    // set on screen, so it is computed here, per label.
    const byLabel = new Map<string, ProjectTarget[]>();
    for (const p of list) {
      const k = `${p.machineId}::${p.label}`;
      const g = byLabel.get(k);
      if (g) g.push(p);
      else byLabel.set(k, [p]);
    }
    const where = new Map<string, string>();
    for (const g of byLabel.values()) for (const [k, v] of disambiguate(g)) where.set(k, v);
    return { list, where, searching: !!q };
  }, [projects, pickQ, project?.machineId, showHidden, hiddenProjects, selectedKey]);

  /** The chosen project's own fragment, for the chip — same rule, over its
   *  server's whole list, so the chip never reads as the other `claudehegai`. */
  const chipWhere = useMemo(() => {
    if (!project) return '';
    const same = projects.filter((p) => p.machineId === project.machineId && p.label === project.label);
    return disambiguate(same).get(selectedKey) ?? '';
  }, [projects, project, selectedKey]);

  /** Switch server: its most recent project that is not hidden, else any. */
  const pickMachine = (machineId: string) => {
    const on = projects.filter((p) => p.machineId === machineId);
    const next = on.find((p) => !hiddenProjects.has(sessionKey(p.machineId, p.cwd))) ?? on[0];
    if (next) pick(next);
    setPop(null);
    taRef.current?.focus();
  };

  /**
   * What is running RIGHT NOW, above the shelf.
   *
   * This screen deliberately carried no session list — «Активная работа»,
   * «Недавние сессии» and five shortcut rows were removed because they were a
   * second rendering of the column that sits beside this screen on a desktop.
   * That reasoning holds for the LIST and not for this: below 861px the context
   * column is not mounted at all, so there is no second rendering to be; and
   * this is not the list, it is the handful of sessions with a writer attached
   * — usually none, occasionally three. It is also the only thing on the screen
   * you cannot get from the composer, which is why it goes above it rather than
   * under.
   *
   * The source is `sessionIsActive`, i.e. `livePid || run`, and NOT
   * `central.activeRuns`. The old «Сейчас в работе» read `activeRuns` alone and
   * so listed only the runs THIS hub started, while almost all real work here
   * starts in VS Code or a terminal and arrives as a session-level `livePid`
   * with no run at all (see PinnedNav). A panel that answers "what is running"
   * with two of twelve is worse than no panel.
   */
  const live = useMemo(() => {
    const out: {
      machineId: string;
      machineName: string;
      sessionId: string;
      title: string;
      project: string;
      source: 'claude' | 'codex';
      provider?: string;
      working: boolean;
      rank: number;
      at: number;
    }[] = [];
    if (!viewerId) return out;
    for (const m of central.machines) {
      for (const s of m.sessions) {
        const run = runIndex.get(sessionKey(m.machine.machineId, s.sessionId));
        if (!sessionIsActive(s, run)) continue;
        // This is the viewer's glance, not the team's session list. Colleagues'
        // live work remains available in the side panel under «Команда». A
        // fresh run knows its owner before the debounced session inventory does.
        const owner = s.owner ?? (run?.ownerUserId ? { userId: run.ownerUserId } : undefined);
        if (!sessionIsMine({ owner }, m, viewerId)) continue;
        // No id yet means no address — the row would be a link to nowhere.
        if (!s.sessionId) continue;
        const working = sessionIsWorking(s, run);
        out.push({
          machineId: m.machine.machineId,
          machineName: m.machine.name,
          sessionId: s.sessionId,
          title: s.title || s.sessionId.slice(0, 8),
          // `project` first, basename second — the same precedence
          // `projectTargets` uses for a project's label (lib.ts). Deriving it
          // from the path alone disagrees with every other place a project is
          // named in this app, and on Windows the separator is the other one.
          project: s.project || (s.cwd ? s.cwd.split(/[/\\]/).filter(Boolean).pop() ?? '' : ''),
          source: s.source === 'codex' ? 'codex' : 'claude',
          ...(s.provider ? { provider: s.provider } : {}),
          working,
          // Held open is not the same as busy, and the difference decides the
          // order. Working — a run mid-turn, or an editor whose pid file says
          // `busy` — comes first; any other run means the hub holds the writer;
          // a bare `livePid` is most often an editor window somebody left open
          // on a folder days ago. All three are "active" and all three belong
          // here — but not in the same rank.
          rank: working ? 0 : run ? 1 : 2,
          at: run?.lastEventAt ?? s.lastModified ?? 0,
        });
      }
    }
    return out.sort((a, b) => a.rank - b.rank || b.at - a.at);
  }, [central.machines, runIndex, viewerId]);

  const hiddenMachineCount = machineList.filter((m) => m.hidden).length;
  const hiddenProjectCount = useMemo(
    () => projects.filter((p) => p.machineId === project?.machineId && hiddenProjects.has(sessionKey(p.machineId, p.cwd))).length,
    [projects, project?.machineId, hiddenProjects],
  );

  // Close the picker on any outside press; Escape closes whatever is open.
  // The create form and «Забрать своё» survive a stray click — half-typed
  // input is worth more than a tidy dismissal.
  useEffect(() => {
    if (!pop) return;
    const onDown = (e: PointerEvent) => {
      if (pop !== 'machine' && pop !== 'project') return;
      if ((e.target as Element | null)?.closest('.start-target')) return;
      setPop(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPop(null);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pop]);

  const machineOf = (id: string) => central.machines.find((m) => m.machine.machineId === id);
  const selectedMachine = project ? machineOf(project.machineId) : undefined;
  privateTargetRef.current = selectedMachine?.machine.private === true;
  // A hosted sandbox used to be pinned to Codex. Since 24.09.2026 its owner
  // logs into Claude or Codex from «Начало» like on any machine, so the picker
  // is live there too — only a member on someone else's box stays pinned.
  const isSandbox = selectedMachine?.kind === 'sandbox';
  const selectedRuntimes = selectedMachine
    ? central.runtimes[selectedMachine.machine.machineId] ?? selectedMachine.runtimes
    : undefined;
  // Whether that Codex is the person's own login or a gateway is the
  // machine's own report (`runtimes`), not a property of being a sandbox or a
  // member: new sandboxes run on the owner's login, older ones on a seat.
  const viaGateway = selectedMachine
    ? codexOnGateway(central.runtimes[selectedMachine.machine.machineId] ?? selectedMachine.runtimes)
    : false;
  // Machines an agent will create a project on: the viewer's own, online.
  const ownMachines = useMemo(
    () => central.machines.filter((m) => m.online && m.canControl === true),
    [central.machines],
  );
  const canCreate = ownMachines.length > 0;
  // A member on a shared machine (start, no control) may add ONE folder inside
  // the chosen shared folder; the hub allows nothing wider.
  const folderMachine = project ? central.machines.find((m) => m.machine.machineId === project.machineId) : undefined;
  // The hub allows it only AT a shared root, so the folder goes in the root
  // that contains the chosen project; with no known root the button is hidden.
  const folderRoot =
    project && folderMachine?.online === true && folderMachine.canStart === true && folderMachine.canControl !== true
      ? shareRootFor(
          project.cwd,
          extraTargets.filter((t) => t.machineId === project.machineId && !t.origin).map((t) => t.cwd),
        )
      : undefined;
  const canMakeFolder = !!project && !!folderRoot;
  // Anywhere at all to start — the same test as App's `canStartAnywhere`.
  const startable = central.machines.some((m) => m.canControl === true || m.canStart === true);
  const sandbox = who?.access?.sandbox;
  const sandboxPending = !!sandbox && (sandbox.status === 'queued' || sandbox.status === 'running');

  /**
   * The work type, which now arrives only by address (`/w/new?cat=…`). The
   * chip row that used to sit above the composer offered exactly one type,
   * «Рамблинг», and it went on 28.09.2026 by request — dictation is the
   * microphone in the composer. A type from the address is still honoured, but
   * only where its skill runs: a category rewrites the first turn to
   * `/<skill> …`, and on a machine without that skill it leaves a stray
   * slash-command in the transcript that looks like it worked.
   * `machine.skills` is absent on agents older than the skill bundle, and
   * `categoryRunnable` reads that as "unknown" rather than "none".
   */
  const machineSkills = selectedMachine?.machine.skills;
  const category = useMemo(() => {
    const cat = SESSION_CATEGORIES.find((c) => c.id === initialCategory);
    return cat && categoryRunnable(cat, machineSkills) ? cat.id : undefined;
  }, [initialCategory, machineSkills]);

  // A machine with Claude switched off (CC_REMOTE_DISABLE_CLAUDE) runs Codex,
  // whatever was remembered: the effect below fixes `agent` a render later,
  // and a send in between must not ask for a Claude the machine refuses.
  // OpenCode is offered only where the machine lists its models. A remembered
  // pick stays remembered, so another machine in the list can still honour it.
  const { models: codexModels, fromRuntime: codexListKnown } = useModelList({
    central,
    machineId: project?.machineId ?? '',
    isCodex: true,
    enabled: !!project && !isMember,
  });
  // Until the machine answers, a remembered OpenCode stays selected and holds the
  // send: falling back here would start the session on Codex without saying so.
  const openCodeWaiting = !isMember && agent === 'opencode' && !codexListKnown;
  const openCodeOffered = openCodeWaiting || (!isMember && modelsForSide(codexModels, true).length > 0);
  const pickedAgent: AgentChoice =
    agent === 'opencode'
      ? openCodeOffered ? 'opencode' : pickRuntime(selectedRuntimes, 'codex')
      : agent === 'claude' && claudeOff(selectedRuntimes) ? 'codex' : agent;
  const isOpenCode = pickedAgent === 'opencode';
  const wireAgent: 'claude' | 'codex' = pickedAgent === 'claude' ? 'claude' : 'codex';
  // The chosen coder is not installed / not signed in on this machine (as far
  // as it has said): don't start a run that can only answer «Not logged in».
  // A member's session runs on the machine's Codex via the hub; skip them.
  const gated = !isMember && !isOpenCode && selectedMachine && project ? runtimeGate(selectedRuntimes, wireAgent) : undefined;
  const source: 'claude' | 'codex' | undefined = isMember ? undefined : wireAgent;
  // The «/» menu for the folder the chat will start in: skills and commands on
  // disk, since there is no run to ask yet (SlashMenu.tsx). Claude only.
  const slash = useSlashMenu({
    central,
    machineId: project?.machineId ?? '',
    cwd: project?.cwd,
    enabled: !!project && source === 'claude',
    draft,
    setDraft,
    taRef,
  });
  // What the session will actually RUN on, after the one override the hub
  // applies regardless of the picker: a member's new sessions on a shared
  // machine go to its Codex. Both the model list and the mode list differ per
  // engine, so this — not `agent` — is what keys them.
  const engine: 'claude' | 'codex' = isMember ? 'codex' : wireAgent;

  // Follow the machine's logins: a runtime with no login on this machine is
  // not offered as the default, because the session would fail at start.
  // The person can still pick it — the row on «Начало» then says what to do.
  // Only when the machine has SAID (older agents say nothing → keep the pick).
  useEffect(() => {
    if (!selectedRuntimes || isMember) return;
    // One rule with the light shell, which has no picker to correct it with
    // (`runtimeUsable`): a login the CLI has blanked counts as no login.
    if (agent === 'opencode') return; // Not a login of its own: it needs no such check.
    const next = pickRuntime(selectedRuntimes, agent);
    if (next !== agent) setAgent(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRuntimes, isMember]);

  // Model / effort / mode for the session about to start, remembered per
  // machine AND engine. Per pair because neither list is portable: a Codex
  // model id means nothing to Claude, and `bypassPermissions` offered on one box
  // is withheld on the next. Carrying one global pick across them would silently
  // ask for something the target cannot honour — which the hub then drops, so
  // the picker would claim a setting the session never had.
  const runKey = project ? `${STARTRUN_PREFIX}${project.machineId}::${isOpenCode ? 'opencode' : engine}` : '';
  const [startRun, setStartRun] = useState<StartSettings>({});
  useEffect(() => {
    setStartRun(loadStartRun(runKey));
  }, [runKey]);
  const changeStartRun = (next: StartSettings) => {
    setStartRun(next);
    if (!runKey) return;
    // An empty object is the default, and storing it would only make the next
    // read parse something to learn nothing. The mode is dropped before writing
    // for the reason `loadStartRun` gives — it is not a preference to remember.
    const { permissionMode: _mode, ...keep } = next;
    if (Object.values(keep).every((v) => v === undefined)) storageRemove(runKey);
    else storageSet(runKey, JSON.stringify(keep));
  };

  // Start a new session in the selected project with the typed task.
  /** Start with a specific string, which is not always the draft: a dictation
   *  ended with the send button arrives long after that button was pressed. */
  const submitText = (text: string) => {
    if ((!text.trim() && !picker.hasAttachments) || !project) return;
    if (openCodeWaiting) {
      setNote(OPENCODE_LOADING_NOTE);
      return;
    }
    if (gated) return; // the notice above the composer says what to do
    if (wt.on && projectIsRepo) {
      void startInWorktree(text);
      return;
    }
    start(text, project.cwd);
  };
  /** Cut `agent/…` into its own worktree, then start the session THERE. Run it
   *  again and a second agent gets a second worktree. */
  const startInWorktree = async (text: string) => {
    if (!project || wtBusy.current) return;
    wtBusy.current = true;
    const typed = wt.branch.trim();
    const first = typed || defaultBranchName(text);
    try {
      let made: { path: string } | undefined;
      for (const name of typed ? [first] : [first, `${first}-${Math.random().toString(36).slice(2, 5)}`]) {
        try {
          made = await central.rpc<{ path: string; branch: string }>(project.machineId, 'git.worktree.add', {
            cwd: project.cwd,
            branch: name,
          }, true);
          break;
        } catch (err) {
          // A taken default name gets one more try with a suffix; anything else is the answer.
          if (typed || !/already exists|уже существует/i.test((err as Error).message)) throw err;
        }
      }
      if (made && !start(text, made.path)) {
        // The session never left: do not leave an orphan worktree behind.
        await central
          .rpc(project.machineId, 'git.worktree.remove', { cwd: project.cwd, path: made.path, force: false }, true)
          .catch(() => {});
      }
    } catch (err) {
      setNote(`Не удалось создать worktree: ${(err as Error).message}`);
    } finally {
      wtBusy.current = false;
    }
  };
  const start = (text: string, cwd: string): boolean => {
    if (!project) return false;
    const started = onNewSession(
      project.machineId,
      cwd,
      text.trim(),
      picker.toImages(),
      project.label,
      category,
      source,
      picker.toFiles(),
      isOpenCode ? { ...startRun, model: goModelOrDefault(codexModels, startRun.model) } : startRun,
    );
    // Only once it is on its way. A failed send already tells the person to
    // retry; emptying the box here left them nothing to retry with.
    if (!started) return false;
    forgetDraft();
    setDraft('');
    picker.clearAll();
    return true;
  };
  const submitNew = () => submitText(draft);
  // The recorder's callback is built once, before this exists, and must call
  // the CURRENT one — see the refs above.
  // Gated: a dictation sent with the send button must not be dropped — it
  // lands in the box like an ordinary dictation, to be sent once signed in.
  submitRef.current = gated ? (t: string) => setDraft(t) : submitText;
  draftRef.current = draft;
  // A project was just made on a machine: it is the selection, it is fresh,
  // and we stay on
  // this screen — `/w/p/:name` bounces while the project has no sessions.
  const onCreated = (p: CreatedProject) => {
    const key = sessionKey(p.machineId, p.cwd);
    setCreated((list) =>
      list.some((x) => sessionKey(x.machineId, x.cwd) === key)
        ? list
        : [...list, { machineId: p.machineId, cwd: p.cwd, label: p.label, origin: 'root' }],
    );
    setRemoved((s) => {
      if (!s.has(key)) return s;
      const n = new Set(s);
      n.delete(key);
      return n;
    });
    setFresh({ key, kind: p.kind });
    setProjectKey(key);
    storageSet('cc-project', key);
    setPop(null);
    setNote(
      p.shareError
        ? `Проект создан, но поделиться с командой не вышло: ${p.shareError}`
        : p.reused
          ? 'Папка уже была — используем её.'
          : '',
    );
    onProjectsChanged?.();
    // Drop `?create=1` (a reload would reopen the form) and an aimed address
    // (`?m=…&cwd=…`), which would otherwise keep aiming the composer at the old one.
    // One of several composers keeps its `n` (its own draft and tab) and is
    // aimed at the project just made.
    if (instance) navigate({ kind: 'new', machineId: p.machineId, cwd: p.cwd, n: instance }, { replace: true });
    else if (initialCreate || initialTarget) navigate({ kind: 'new' }, { replace: true });
    taRef.current?.focus();
  };

  // «Удалить» on a root-scanned card: the agent renames the folder into its
  // trash — nothing is deleted silently — and refuses while a session is live.
  const removeProject = async (p: ProjectTarget) => {
    if (
      !(await askConfirm(
        `Убрать «${p.label}» с машины ${p.machineName}?\n\nПапка переедет в корзину агента (~/.cc-remote/trash) — ничего не удаляется насовсем.`,
        { confirmLabel: 'Убрать', danger: true },
      ))
    )
      return;
    try {
      const r = await central.rpc<{ ok: boolean; movedTo?: string }>(p.machineId, 'projects.remove', { cwd: p.cwd });
      const key = sessionKey(p.machineId, p.cwd);
      setRemoved((s) => new Set(s).add(key));
      setCreated((list) => list.filter((x) => sessionKey(x.machineId, x.cwd) !== key));
      if (projectKey === key) {
        setProjectKey('');
        storageRemove('cc-project');
      }
      if (fresh?.key === key) setFresh(null);
      setNote(r.movedTo ? `«${p.label}» — в корзине агента: ${r.movedTo}` : `«${p.label}» убран.`);
      onProjectsChanged?.();
    } catch (err) {
      setNote(describeRemoveError((err as Error).message));
    }
  };

  const canSend = !!draft.trim() || picker.hasAttachments;
  const suggested = project?.fresh ? FIRST_PROMPT[project.fresh] : undefined;
  const placeholder =
    suggested ??
    (project ? `Задача в ${project.label}…` : canCreate ? 'Сначала создайте проект' : 'Опиши задачу…');

  return (
    <div className="startscreen">
      <div className="start-scroll">
        <div className="start-inner">
          {/* [community] The one card a new seat reads once. It greeted people on
              Главная; with that screen gone it belongs here, which is where they
              land and where the thing it explains is about to happen. */}
          {who && shouldWelcome(who) && <Welcome viewer={who} />}

        {/* The sandbox is being built and there is nothing else to start on:
            say so where the shelf would be, instead of an empty composer. */}
        {!startable && sandboxPending && (
          <div className="start-empty start-pending" role="status">
            <span className="sb-dot busy" aria-hidden />
            Песочница готовится, первую сессию можно будет начать через несколько минут
          </div>
        )}

        {/* Nothing to start on yet but a machine that can make a project: say what
            the first step is, where the shelf would be. */}
        {canCreate && projects.length === 0 && pop !== 'new' && (
          <div className="start-blank" role="status">
            <h2>Начните с проекта</h2>
            <p>Проект — папка на вашей машине с git внутри. В ней агент будет работать, а сессии появятся в боковой панели.</p>
            <button type="button" className="btn primary" onClick={() => setPop('new')}>Новый проект</button>
          </div>
        )}

        {/* The forms the dropdowns lead to — «Новый проект», «Забрать своё» —
            and the line that reports on them, in the scroller above the dock. */}
        {(pop === 'new' || pop === 'folder' || pop === 'take' || note) && (
          <div className="start-project">
            {pop === 'new' && canCreate && (
              <NewProjectPanel
                machines={ownMachines}
                viewer={who}
                workspace={central.viewer?.workspace}
                rpc={central.rpc}
                onCreated={onCreated}
                onClose={() => {
                  setPop(null);
                  if (initialCreate) navigate({ kind: 'new' }, { replace: true });
                }}
              />
            )}
            {pop === 'folder' && canMakeFolder && project && (
              <NewFolderPanel
                machineId={project.machineId}
                root={folderRoot ?? project.cwd}
                rpc={central.rpc}
                onCreated={(cwd, label) =>
                  onCreated({ machineId: project.machineId, cwd, label, kind: 'empty', reused: false })
                }
                onClose={() => setPop(null)}
              />
            )}
            {pop === 'take' && project && (
              <div className="proj-pop take-pop">
                <TakeYourCode
                  target={project}
                  onPush={(machineId, cwd, prompt) => {
                    if (openCodeWaiting) {
                      setNote(OPENCODE_LOADING_NOTE);
                      return false;
                    }
                    if (gated) return false;
                    return onNewSession(machineId, cwd, prompt, undefined, project.label, undefined, source, undefined,
                      isOpenCode ? { model: goModelOrDefault(codexModels, startRun.model) } : undefined);
                  }}
                  onClose={() => setPop(null)}
                />
              </div>
            )}
            {note && (
              <div className="start-note" role="status">
                {note}
                <button className="start-note-x" onClick={() => setNote('')} aria-label="Скрыть">
                  ×
                </button>
              </div>
            )}
          </div>
        )}

        {/* «Сейчас в работе» owns the flexible region above the composer. */}
        {live.length > 0 && (
          <div className="start-live">
            <div className="sl-head">
              <span className="sl-head-title">Сейчас в работе</span>
              <span className="sl-count">{live.length}</span>
            </div>
            {/* Initially capped, which is why this is allowed to exist
                here. Anyone with a few editor windows open has a dozen sessions
                carrying a `livePid` — measured: twelve on one machine of this
                fleet — and twelve rows above the composer is precisely the
                second session list that was removed from this screen. Five is a
                glance; «ещё N» expands only when the person asks for the tail. */}
            <ul className="sl-list">
              {live.slice(0, showAllLive ? live.length : LIVE_ROWS).map((s) => (
                <li key={sessionKey(s.machineId, s.sessionId)}>
                  <a
                    className="sl-row"
                    {...linkProps({ kind: 'session', machineId: s.machineId, sessionId: s.sessionId })}
                  >
                    {/* The bolt is «идёт работа» everywhere in this product. A
                        session held open in an editor but not mid-turn gets the
                        row without it — it is live, it is not busy. */}
                    {s.working && (
                      <AgentMark source={s.source} provider={s.provider} size={13} className="sl-bolt" />
                    )}
                    <span className="sl-title" title={s.title}>{s.title}</span>
                    <span className="sl-where" title={s.project ? `${s.project} · ${s.machineName}` : s.machineName}>
                      {s.project && <span className="sl-project">{s.project}</span>}
                      {s.project && <span className="sl-sep"> · </span>}
                      <span className="sl-machine">{s.machineName}</span>
                    </span>
                  </a>
                </li>
              ))}
              {live.length > LIVE_ROWS && (
                <li className="sl-rest">
                  <button className="sl-more" type="button" onClick={() => setShowAllLive((v) => !v)}>
                    {showAllLive ? 'свернуть' : `ещё ${live.length - LIVE_ROWS} в работе`}
                  </button>
                </li>
              )}
            </ul>
          </div>
        )}
        {/* This screen used to carry three more blocks: «Активная
            работа», a row of five shortcuts («Продолжить последнюю», «Открыть
            доску», «Открыть колонки», «Поиск сессий», «Прикрепить картинку»)
            and «Недавние сессии».
            Every one of them was a second drawing of something already on this
            screen or beside it. The context column to the left lists the same
            sessions by project, with the same live marks, owners and times, and
            reaches them in one click; the shortcuts pointed at two lenses that
            no longer exist, at the palette (⌘K, and a button in the column's
            own header), and at the picker the «+» in the composer opens.
            This screen asks one question — where, what kind, and what shall we
            do — and it should stop answering questions nobody asked here. */}
        </div>
      </div>
      <div className="start-dock">
        <div className="start-dock-inner">
          {gated && project && <RuntimeGate central={central} machineId={project.machineId} runtime={wireAgent} />}
          <div className="composer start-composer">
            {/* WHERE, as two buttons on a tray above the field — the server and
                the project, the way Codex and the phone app say it. Each opens
                its own dropdown; the choice is remembered (`cc-project`). */}
            {(project || canCreate) && (
              <div className="start-target">
                {project && (
                  <button
                    type="button"
                    className={`tgt-chip ${pop === 'machine' ? 'open' : ''} ${selectedMachine?.online === false ? 'off' : ''}`}
                    onClick={() => setPop((v) => (v === 'machine' ? null : 'machine'))}
                    aria-haspopup="listbox"
                    aria-expanded={pop === 'machine'}
                    title={selectedMachine?.online === false ? `${project.machineName} — нет соединения` : 'Сервер'}
                  >
                    <Cpu size={15} />
                    <span className="tgt-label">{selectedMachine?.machine.name ?? project.machineName}</span>
                    {selectedMachine?.online === false && <span className="tgt-off" aria-hidden />}
                    <CaretDown size={11} className="tgt-caret" />
                  </button>
                )}
                <button
                  type="button"
                  className={`tgt-chip ${pop === 'project' ? 'open' : ''}`}
                  onClick={() => {
                    setPop((v) => (v === 'project' ? null : 'project'));
                    setPickQ('');
                  }}
                  aria-haspopup="listbox"
                  aria-expanded={pop === 'project'}
                  title={project ? project.cwd : 'Проект'}
                >
                  <Folder size={15} />
                  <span className="tgt-label">{project ? project.label : 'Выбрать проект'}</span>
                  {chipWhere && <span className="tgt-where">{chipWhere}</span>}
                  {project && project.live > 0 && <Lightning size={11} weight="fill" className="pcp-run" aria-label="идёт работа" />}
                  <CaretDown size={11} className="tgt-caret" />
                </button>

                {pop === 'machine' && (
                  <div className="proj-pop tgt-pop" role="listbox" aria-label="Сервер">
                    <div className="proj-pop-list">
                      {machineList
                        .filter((m) => showHidden || !m.hidden || m.machineId === project?.machineId)
                        .map((m) => {
                          const active = m.machineId === project?.machineId;
                          return (
                            <div className={`pc-item tgt-item ${active ? 'sel' : ''}`} key={m.machineId}>
                              <button className="pc-pick" role="option" aria-selected={active} onClick={() => pickMachine(m.machineId)}>
                                <span className="pc-fold" aria-hidden><Cpu size={15} /></span>
                                <span className="pc-name">{m.name}</span>
                                <span className={`tgt-state ${m.online ? '' : 'off'}`}>
                                  {m.online ? 'онлайн' : 'нет соединения'}
                                  {m.owner ? ` · ${m.owner.fullName || m.owner.email || 'коллега'}` : ''}
                                </span>
                                {m.live > 0 && <Lightning size={12} weight="fill" className="pcp-run" aria-label="идёт работа" />}
                              </button>
                              <details className="pcp-more pc-row-menu" onToggle={anchorMenu}>
                                <summary title={`Действия: ${m.name}`} aria-label={`Действия: ${m.name}`}>
                                  <MoreIcon size={13} />
                                </summary>
                                <div className="pcp-menu">
                                  <button className="ws-more-item" onClick={(e) => { closeMenu(e); toggleHiddenMachine(m.machineId); }}>
                                    {m.hidden ? 'Вернуть сервер' : 'Скрыть сервер'}
                                  </button>
                                </div>
                              </details>
                            </div>
                          );
                        })}
                    </div>
                    {hiddenMachineCount > 0 && (
                      <div className="tgt-foot">
                        <button className="pt-link" onClick={() => setShowHidden((v) => !v)}>
                          {showHidden ? 'спрятать скрытые' : `скрыто: ${hiddenMachineCount}`}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {pop === 'project' && (
                  <div className="proj-pop tgt-pop" role="listbox" aria-label="Проект">
                    <input
                      className="proj-pop-search"
                      autoFocus
                      placeholder="Найти проект на любом сервере…"
                      value={pickQ}
                      onChange={(e) => setPickQ(e.target.value)}
                      onKeyDown={(e) => {
                        const first = projectRows.list[0];
                        if (e.key === 'Enter' && first) {
                          pick(first);
                          setPop(null);
                          taRef.current?.focus();
                        }
                      }}
                    />
                    <div className="proj-pop-list">
                      {projectRows.list.map((p) => {
                        const k = sessionKey(p.machineId, p.cwd);
                        const active = k === selectedKey;
                        const where = projectRows.where.get(k);
                        return (
                          <div className={`pc-item tgt-item ${active ? 'sel' : ''}`} key={k}>
                            <button
                              className="pc-pick"
                              role="option"
                              aria-selected={active}
                              title={p.cwd}
                              onClick={() => {
                                pick(p);
                                setPop(null);
                                taRef.current?.focus();
                              }}
                            >
                              <span className="pc-fold" aria-hidden>
                                {active ? <FolderOpen size={15} /> : <Folder size={15} />}
                              </span>
                              <span className="pc-name">{p.label}</span>
                              {where && <span className="pcp-where">{where}</span>}
                              {projectRows.searching && <span className="po-machine">{p.machineName}</span>}
                              {p.live > 0 && <Lightning size={12} weight="fill" className="pcp-run" aria-label="идёт работа" />}
                            </button>
                            {/* «Удалить с машины» has no other home in the
                                product — the Проекты screen lists and adopts, it
                                does not remove — so it moves with the list. */}
                            <details className="pcp-more pc-row-menu" onToggle={anchorMenu}>
                              <summary title="Действия" aria-label={`Действия: ${p.label}`}>
                                <MoreIcon size={13} />
                              </summary>
                              <div className="pcp-menu">
                                <button className="ws-more-item" onClick={(e) => { closeMenu(e); toggleHiddenProject(k); }}>
                                  {hiddenProjects.has(k) ? 'Вернуть проект' : 'Скрыть проект'}
                                </button>
                                {machineOf(p.machineId)?.canControl === true && p.origin === 'root' && p.live === 0 && (
                                  <button className="ws-more-item danger" onClick={(e) => { closeMenu(e); setPop(null); void removeProject(p); }}>
                                    Удалить с машины
                                  </button>
                                )}
                              </div>
                            </details>
                          </div>
                        );
                      })}
                      {projectRows.list.length === 0 && <div className="proj-pop-empty">{projectRows.searching ? 'Ничего не нашлось' : 'Проектов пока нет'}</div>}
                    </div>
                    {(canCreate || canMakeFolder || (!projectRows.searching && hiddenProjectCount > 0)) && (
                      <div className="tgt-foot">
                        {canCreate && (
                          <button className="pt-btn" onClick={() => setPop('new')} title="Новый проект на вашей машине">
                            <FolderPlus size={15} /> Новый проект
                          </button>
                        )}
                        {canMakeFolder && (
                          <button className="pt-btn" onClick={() => setPop('folder')} title="Новая папка внутри выбранной общей папки">
                            <FolderPlus size={15} /> Новая папка
                          </button>
                        )}
                        <span className="pt-spacer" />
                        {!projectRows.searching && hiddenProjectCount > 0 && (
                          <button
                            className="pt-link"
                            onClick={() => setShowHidden((v) => !v)}
                            title="Скрытые остаются доступны — это фильтр, а не удаление"
                          >
                            {showHidden ? 'спрятать скрытые' : `скрыто: ${hiddenProjectCount}`}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            <div
              className={`composer-box cg ${recorder.state !== 'idle' ? 'dict' : ''} ${picker.dragging ? 'dropping' : ''}`}
              onPaste={picker.onPaste}
              onDragOver={picker.onDragOver}
              onDragLeave={picker.onDragLeave}
              onDrop={picker.onDrop}
            >
              <AttachPreview picker={picker} />
              {/* The recorder's live state, shown where you are about to type. */}
              <DictationStrip recorder={recorder} />
              {recorder.state === 'idle' && <DictationSwitch sw={dictSwitch} />}
              <textarea
                ref={taRef}
                autoFocus
                value={draft}
                rows={1}
                placeholder={placeholder}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (slash.onKeyDown(e)) return;
                  if (!enterShouldSend(e)) return;
                  e.preventDefault();
                  submitNew();
                }}
              />
              {slash.menu}
              <div className="composer-actions">
                <div className="composer-left">
                  <AttachButton picker={picker} />
                  {slash.button}
                  {!isMember && (
                    <div className="agent-pick" role="group" aria-label="Агент">
                      {(['claude', 'codex', 'opencode'] as const).filter((id) => (id === 'opencode' ? openCodeOffered : id !== 'claude' || !claudeOff(selectedRuntimes))).map((id) => (
                        <button
                          key={id}
                          className={`agent-opt ${pickedAgent === id ? 'active' : ''}`}
                          onClick={() => pickAgent(id)}
                          aria-pressed={pickedAgent === id}
                          title={
                            id === 'claude'
                              ? 'Claude Code — вход на этой машине'
                              : id === 'opencode'
                                ? 'OpenCode — модели подписки Go'
                                : viaGateway
                                  ? 'Codex — на этой машине через шлюз a.test'
                                  : 'Codex — вход на этой машине (codex login)'
                          }
                        >
                          {id === 'claude' ? 'Claude' : id === 'codex' ? 'Codex' : 'OpenCode'}
                        </button>
                      ))}
                    </div>
                  )}
                  {isMember && (
                    <span className="badge codex" title="На чужой машине новые сессии идут через её Codex, чтобы не тратить Claude владельца.">
                      {viaGateway ? 'Codex · шлюз' : 'Codex'}
                    </span>
                  )}
                  {isSandbox && viaGateway && !isMember && (
                    <span className="role-chip gateway" title="Codex этой песочницы ходит через шлюз моделей a.test.">
                      шлюз
                    </span>
                  )}
                </div>
                <div className="composer-right">
                  {/* Model and effort for the session about to start — on the RIGHT,
                      beside the microphone, where ChatGPT keeps it (27.09.2026). Needs a
                      machine to ask what it can run, so it appears with the
                      project rather than before it. */}
                  {project && (
                    <StartRunPicker
                      central={central}
                      machineId={project.machineId}
                      isCodex={engine === 'codex'}
                      isOpenCode={isOpenCode}
                      value={startRun}
                      onChange={changeStartRun}
                    />
                  )}
                  {!privateTargetRef.current && <VoiceButton recorder={recorder} />}
                  {recorder.state === 'recording' ? (
                    /* Send during a recording means «наговорил — отправил»: finish
                       the clip, recognise it, start the session. The microphone
                       still stops into the composer for when you want to read it
                       first. Not gated on `canSend` — there is nothing typed yet
                       BY DEFINITION, and that is the whole point of the button. */
                    <button
                      className="send-round"
                      disabled={!project}
                      onClick={recorder.sendNow}
                      title="Закончить запись и начать сессию"
                      aria-label="Закончить запись и начать сессию"
                    >
                      <ArrowUpIcon size={17} weight="bold" />
                    </button>
                  ) : canSend ? (
                    <button
                      className="send-round"
                      disabled={!project || !!gated || recorder.state === 'transcribing'}
                      onClick={submitNew}
                      title={recorder.state === 'transcribing' ? 'Распознаю запись…' : 'Начать сессию'}
                      aria-label="Начать сессию"
                    >
                      <ArrowUpIcon size={17} weight="bold" />
                    </button>
                  ) : (
                    <button className="send-round" disabled title="Опиши задачу, чтобы начать" aria-label="Начать сессию">
                      <ArrowUpIcon size={17} weight="bold" />
                    </button>
                  )}
                </div>
              </div>
            </div>
            {project && projectIsRepo && (
              <StartWorktree
                central={central}
                machineId={project.machineId}
                cwd={project.cwd}
                draft={draft}
                value={wt}
                onChange={setWt}
                onNote={setNote}
              />
            )}
            {/* The placeholder is a suggestion, and a suggestion you can take in
                one press is the difference between advice and help. */}
            {suggested && !draft && (
              <button className="start-suggest" onClick={() => setDraft(suggested)}>
                Взять подсказку как первый ход →
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
