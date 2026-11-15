import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileInput, ImageInput, MachineSnapshot, ProjectCreateResult, ViewerContext } from '@cc-remote/shared';
import type { CentralState, StartSettings } from '../useCentral.js';
import {
  AttachButton,
  AttachPreview,
  DictationStrip,
  DictationSwitch,
  DraftStore,
  VoiceButton,
  enterShouldSend,
  useAutoGrowTextarea,
  useImageAttachment,
} from '../composer.js';
import { useDictationComposer } from '../useDictationComposer.js';
import { polishContext } from '../polish.js';
import { projectTargets, recentProjects, relTimeRu, sessionKey, type ExtraTarget, type RunIndex } from '../lib.js';
import { linkProps } from '../router.js';
import { ArrowUpIcon, CaretDown, Check, Folder, FolderPlus } from '../icons.js';
import { AgentMark } from '../components/AgentMark.js';
import { describeCreateError } from '../components/NewProjectPanel.js';
import { offeredModes } from '../components/PermissionModePicker.js';
import { fullHref } from './origin.js';
import { canCreateOn, hasUsableRuntime, pickEngine, pickMachine, pinnedToCodex, startBlock, type Engine } from './pick.js';
import { projectSlug, uniqueSlug } from './slug.js';
import { deriveTasks, type Seen, type Task } from './tasks.js';
import { storageGet, storageSet } from '../storage.js';

/**
 * The light shell's home: one question and what became of the earlier ones.
 *
 * «Что сделать?» is the whole screen. Where the work goes is a chip inside the
 * box — the project used last, or «Новый проект», which needs no name: the
 * first message names it (`slug.ts`). Machine, runtime, model and effort are
 * not on the screen at all (`pick.ts`; model and effort are left to the
 * machine's own defaults by sending neither).
 *
 * Under the box, the person's tasks in three piles — waiting for them, in
 * progress, done — read off the frames the socket already carries
 * (`tasks.ts`).
 */

/** Per person: a browser two people sign into must not hand the second one
 *  what the first was in the middle of typing. */
const DRAFT_PREFIX = 'lite-new:';
/** `machine::cwd` of the project picked last, or `new[:machineId]`. */
const PROJECT_KEY = 'lite-project';
const AGENT_KEY = 'lite-agent';
const NEW = 'new';

type Start = (
  machineId: string,
  cwd: string,
  message: string,
  images: ImageInput[] | undefined,
  files: FileInput[] | undefined,
  project: string | undefined,
  source: 'claude' | 'codex' | undefined,
  startup: StartSettings,
) => boolean;

function read(key: string): string {
  return storageGet(key) ?? '';
}
function write(key: string, value: string): void {
  // No storage: the choice lasts until reload.
  storageSet(key, value);
}

/** A stopwatch for a row that is working. Its own component so one tick a
 *  second re-renders a few characters, not the list. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.round((now - since) / 1000));
  const m = Math.floor(secs / 60);
  return <span className="lt-row-time">{m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m}:${String(secs % 60).padStart(2, '0')}`}</span>;
}

function TaskRow({ task }: { task: Task }) {
  const second =
    task.group === 'attention'
      ? task.label
      : task.group === 'working'
        ? task.preview || 'работает'
        : task.preview || undefined;
  return (
    <a
      className={`lt-row ${task.group}${task.unread ? ' unread' : ''}`}
      {...linkProps({ kind: 'session', machineId: task.machineId, sessionId: task.sessionId })}
    >
      <span className="lt-row-mark" aria-hidden>
        {task.group === 'working' ? <AgentMark source={task.source} provider={task.provider} size={14} className="srun" /> : <i />}
      </span>
      <span className="lt-row-text">
        <span className="lt-row-title">{task.title}</span>
        <span className="lt-row-sub">
          {task.project && <span className="lt-row-proj">{task.project}</span>}
          {second && <span className="lt-row-what">{second}</span>}
        </span>
      </span>
      {task.group === 'working' ? (
        <Elapsed since={task.at} />
      ) : (
        <span className="lt-row-time">{relTimeRu(task.at)}</span>
      )}
      {task.unread && <span className="sr-only">новый результат</span>}
    </a>
  );
}

function Pile({ title, tasks, id }: { title: string; tasks: Task[]; id: string }) {
  if (!tasks.length) return null;
  return (
    <section className="lt-pile" aria-labelledby={id}>
      <h2 className="eyebrow eyebrow--mark" id={id}>
        {title} <span className="lt-pile-n">{tasks.length}</span>
      </h2>
      <div className="lt-rows">
        {tasks.map((t) => (
          <TaskRow key={t.key} task={t} />
        ))}
      </div>
    </section>
  );
}

export function Home({
  central,
  viewer,
  runIndex,
  seen,
  extraTargets,
  onStart,
  onProjectsChanged,
}: {
  central: CentralState;
  viewer: ViewerContext | null;
  runIndex: RunIndex;
  seen: Seen | null;
  extraTargets: ExtraTarget[];
  onStart: Start;
  onProjectsChanged: () => void;
}) {
  const viewerId = viewer?.userId;
  const isMember = central.viewer?.workspace.role === 'member';
  const runtimesOf = useCallback(
    (m: MachineSnapshot) => central.runtimes[m.machine.machineId] ?? m.runtimes,
    [central.runtimes],
  );

  const draftKey = DRAFT_PREFIX + (viewerId ?? '');
  const [draft, setDraft] = useState(() => DraftStore.load(draftKey));
  useEffect(() => DraftStore.save(draftKey, draft), [draftKey, draft]);
  const picker = useImageAttachment();
  const taRef = useAutoGrowTextarea(draft, 0.4);
  // The recorder's callback is built once and fires long after: it reads the
  // draft, the submitter and the project through refs (as StartScreen does).
  const polishProjectRef = useRef<string | undefined>(undefined);
  // Private target machine: dictation is off (docs/E2EE.md).
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
  const { recorder, dictSwitch, draftRef, submitRef } = useDictationComposer({
    draft,
    setDraft,
    transcribe: transcribeDictation,
    polish: polishDictation,
    notifyError: central.notifyError,
  });

  // Projects made here ahead of the agents' next `projects.list`.
  const [created, setCreated] = useState<ExtraTarget[]>([]);
  const projects = useMemo(() => {
    // Only where a task can start NOW. The full client lists a project on a
    // machine that is off, marked «нет соединения», because there the person
    // picks the machine; here the shell picks, and it must not pick a place
    // the message cannot reach.
    const online = new Set(central.machines.filter((m) => m.online).map((m) => m.machine.machineId));
    return projectTargets(central.machines, viewerId, runIndex, [...extraTargets, ...created]).filter((p) => online.has(p.machineId));
  }, [central.machines, viewerId, runIndex, extraTargets, created]);
  const shelf = useMemo(() => recentProjects(projects), [projects]);
  const createMachines = useMemo(() => central.machines.filter(canCreateOn), [central.machines]);

  const [choice, setChoice] = useState(() => read(PROJECT_KEY));
  const choose = (next: string) => {
    setChoice(next);
    write(PROJECT_KEY, next);
  };
  const wantsNew = choice === NEW || choice.startsWith(`${NEW}:`);
  const chosen = wantsNew ? undefined : projects.find((p) => sessionKey(p.machineId, p.cwd) === choice);
  // Nothing remembered (or a project that is gone): the one worked in last —
  // most of a person's requests are about something that already exists. With
  // no project at all, the first message makes one.
  const project = wantsNew ? undefined : (chosen ?? shelf[0] ?? projects[0]);
  // A machine the person POINTED at («Новый проект · mac») is that machine,
  // not a preference to be outranked: `pickMachine` puts «can it run» and
  // «is it mine» first, so a remembered pick that loses on either would
  // silently make the folder somewhere else. The ranking is for when nobody
  // chose — or when the chosen machine is no longer one a project can be made
  // on (offline, access withdrawn).
  const newMachine = useMemo(() => {
    const picked = choice.startsWith(`${NEW}:`) ? choice.slice(NEW.length + 1) : undefined;
    return (
      (picked ? createMachines.find((m) => m.machine.machineId === picked) : undefined) ??
      pickMachine(central.machines, { viewerId, remembered: picked, runtimesOf })
    );
  }, [central.machines, createMachines, viewerId, choice, runtimesOf]);
  const makeNew = !project && !!newMachine;
  const targetMachine = project
    ? central.machines.find((m) => m.machine.machineId === project.machineId)
    : makeNew
      ? newMachine
      : undefined;
  polishProjectRef.current = project?.label;
  privateTargetRef.current = targetMachine?.machine.private === true;

  // With nothing remembered the target is whatever was worked in last — a live
  // expression: another machine answering `projects.list`, or anybody's session
  // moving, re-points it. That is fine for an empty box and wrong the moment
  // there is something in it: the chip a person looked at when they began to
  // type must still be where the message goes. So the first keystroke (or the
  // first attachment) turns the default into a choice.
  const composing = draft.trim() !== '' || picker.hasAttachments;
  const defaultKey = project
    ? sessionKey(project.machineId, project.cwd)
    : makeNew && newMachine
      ? `${NEW}:${newMachine.machine.machineId}`
      : '';
  useEffect(() => {
    if (composing && defaultKey && choice !== defaultKey && !chosen && !wantsNew) choose(defaultKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pins once per composing/default pair
  }, [composing, defaultKey]);

  const runtimes = targetMachine ? runtimesOf(targetMachine) : undefined;
  const preferred: Engine = read(AGENT_KEY) === 'codex' ? 'codex' : 'claude';
  const engine = pickEngine(runtimes, { preferred, pinned: pinnedToCodex(targetMachine, isMember) });
  const planOffered = !!targetMachine && offeredModes(targetMachine.machine, engine === 'codex').includes('plan');
  // The machine has SAID neither runtime can start (unknown reads as usable).
  // Sending anyway would make a folder for a run that is known to fail.
  const runtimeReady = !targetMachine || hasUsableRuntime(runtimes);
  const [plan, setPlan] = useState(false);

  const [pop, setPop] = useState(false);
  const [query, setQuery] = useState('');
  /** «на другой машине…» was pressed: list every machine a project can be made
   *  on. Closed by default — an owner with eleven machines opened this sheet
   *  onto eleven rows of «Новый проект» before the first real project. */
  const [allMachines, setAllMachines] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pop) return;
    const onDown = (e: PointerEvent) => {
      if (!popRef.current?.contains(e.target as Node)) setPop(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPop(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pop]);
  const listed = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = q ? projects.filter((p) => p.label.toLowerCase().includes(q) || p.machineName.toLowerCase().includes(q)) : shelf;
    return all.slice(0, 40);
  }, [projects, shelf, query]);
  /** Same label on two machines (`crm` on two boxes): the row has to say which. */
  const ambiguous = useMemo(() => {
    const n = new Map<string, number>();
    for (const p of projects) n.set(p.label, (n.get(p.label) ?? 0) + 1);
    return n;
  }, [projects]);

  const [sending, setSending] = useState(false);
  const [note, setNote] = useState('');
  /** A submit is in hand. A ref for the reason `startingAt` in LiteApp is one:
   *  a second press must be refused even when this screen has not rendered
   *  since the first — otherwise it makes the folder twice. */
  const submitting = useRef(false);

  /** Make the folder the first message asked for. Returns where the task
   *  starts, or `null` with `note` saying why not. */
  const createProject = async (text: string, machine: MachineSnapshot): Promise<{ cwd: string; label: string } | null> => {
    const machineId = machine.machine.machineId;
    const taken = projects.filter((p) => p.machineId === machineId).map((p) => p.label);
    const base = projectSlug(text);
    let name = uniqueSlug(base, taken);
    // The list is a moment old and another window may have made the same
    // folder: on «already exists» take the next name, a bounded number of times.
    for (let attempt = 0; attempt < 4 && name; attempt++) {
      try {
        const r = await central.rpc<ProjectCreateResult>(machineId, 'projects.create', { name, template: 'empty' });
        return { cwd: r.cwd, label: r.label };
      } catch (err) {
        const message = (err as Error).message;
        if (!/already exists/i.test(message)) {
          setNote(describeCreateError(message));
          return null;
        }
        taken.push(name);
        name = uniqueSlug(base, taken);
      }
    }
    setNote(`Папок с именем «${base}» на машине уже слишком много — выберите проект в списке.`);
    return null;
  };

  const submitText = async (text: string) => {
    if (submitting.current) return;
    submitting.current = true;
    try {
      await submitOnce(text);
    } finally {
      submitting.current = false;
    }
  };
  const submitOnce = async (text: string) => {
    const message = text.trim();
    if (sending || !runtimeReady || (!message && !picker.hasAttachments)) return;
    setNote('');
    let target: { machineId: string; cwd: string; label: string } | undefined = project;
    if (!target) {
      if (!newMachine) return;
      setSending(true);
      const made = await createProject(message, newMachine).finally(() => setSending(false));
      if (!made) return;
      target = { machineId: newMachine.machine.machineId, cwd: made.cwd, label: made.label };
      // It exists now, whatever happens to the send: point the chip at it, so a
      // retry starts in this folder instead of making `-2`.
      setCreated((list) => [...list, { machineId: target!.machineId, cwd: made.cwd, label: made.label, origin: 'root' }]);
      choose(sessionKey(target.machineId, target.cwd));
      onProjectsChanged();
    }
    const started = onStart(
      target.machineId,
      target.cwd,
      message,
      picker.toImages(),
      picker.toFiles(),
      target.label,
      engine,
      plan && planOffered ? { permissionMode: 'plan' } : {},
    );
    // Only once it is on its way: a failed send already asks for a retry, and
    // an emptied box would leave nothing to retry with.
    if (!started) return;
    DraftStore.save(draftKey, '');
    setDraft('');
    picker.clearAll();
  };
  submitRef.current = (text) => void submitText(text);
  draftRef.current = draft;

  const tasks = useMemo(
    () => (seen ? deriveTasks(central.machines, runIndex, viewerId, seen) : { attention: [], working: [], done: [] }),
    [central.machines, runIndex, viewerId, seen],
  );
  const nothing = !tasks.attention.length && !tasks.working.length && !tasks.done.length;

  // Before the first snapshot nothing is known — not «no machine».
  const block = central.hydrated ? startBlock(central.machines, runtimesOf) : null;
  const canTarget = (!!project || makeNew) && runtimeReady;
  const canSend = (!!draft.trim() || picker.hasAttachments) && canTarget && !sending;
  const chipLabel = project ? project.label : 'Новый проект';
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

  return (
    <div className="lt-home">
      <div className="lt-home-inner">
        <h1 className="lt-ask">Что сделать?</h1>

        {block && (
          <div className="lt-block" role="status">
            <b>{block === 'no-machine' ? 'Нет машины на связи' : 'На машине нет входа в Claude или Codex'}</b>
            <p>
              {block === 'no-machine'
                ? 'Агенту нужен компьютер, на котором он работает. Подключите свой — это одна команда — или включите уже подключённый.'
                : 'Машина на связи, но запускать на ней нечем: войдите в Claude или Codex — это одна кнопка в «Начале».'}
            </p>
            <a className="btn" href={fullHref('/w/start')}>
              Открыть «Начало» в полной версии
            </a>
          </div>
        )}

        <div className="composer start-composer lt-composer">
          <div
            className={`composer-box cg ${recorder.state !== 'idle' ? 'dict' : ''} ${picker.dragging ? 'dropping' : ''}`}
            onPaste={picker.onPaste}
            onDragOver={picker.onDragOver}
            onDragLeave={picker.onDragLeave}
            onDrop={picker.onDrop}
          >
            <AttachPreview picker={picker} />
            <DictationStrip recorder={recorder} />
            {recorder.state === 'idle' && <DictationSwitch sw={dictSwitch} />}
            <textarea
              ref={taRef}
              autoFocus={!coarse}
              value={draft}
              rows={2}
              placeholder={
                project
                  ? `Задача в ${project.label}…`
                  : makeNew
                    ? 'Опишите, что нужно, — проект создастся сам…'
                    : 'Опишите задачу…'
              }
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (!enterShouldSend(e)) return;
                e.preventDefault();
                void submitText(draft);
              }}
            />
            <div className="composer-actions">
              <div className="composer-left lt-where" ref={popRef}>
                <AttachButton picker={picker} />
                {(projects.length > 0 || createMachines.length > 0) && (
                  <button
                    type="button"
                    className={`tgt-chip ${pop ? 'open' : ''}`}
                    onClick={() => {
                      setPop((v) => !v);
                      setQuery('');
                      setAllMachines(false);
                    }}
                    aria-haspopup="listbox"
                    aria-expanded={pop}
                    title={project ? project.cwd : 'Папка создастся из первого сообщения'}
                  >
                    {project ? <Folder size={15} /> : <FolderPlus size={15} />}
                    <span className="tgt-label">{chipLabel}</span>
                    <CaretDown size={11} className="tgt-caret" />
                  </button>
                )}
                {planOffered && (
                  <button
                    type="button"
                    className={`plan-toggle${plan ? ' on' : ''}`}
                    aria-pressed={plan}
                    onClick={() => setPlan((v) => !v)}
                    title={plan ? 'Сначала план: агент ничего не меняет, пока вы его не утвердите' : 'Сначала показать план, потом делать'}
                  >
                    План
                  </button>
                )}
                {pop && (
                  <div className="lt-pop" role="listbox" aria-label="Проект">
                    {projects.length > 6 && (
                      <input
                        className="proj-pop-search"
                        autoFocus
                        placeholder="Найти проект…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    )}
                    <div className="lt-pop-list">
                      {!query.trim() &&
                        // One row: the machine the shell would pick (or the one
                        // picked before). The rest appear on request.
                        (allMachines ? createMachines : createMachines.filter((m) => m.machine.machineId === newMachine?.machine.machineId)).map((m) => {
                          const active = makeNew && newMachine?.machine.machineId === m.machine.machineId;
                          return (
                            <button
                              key={`new:${m.machine.machineId}`}
                              type="button"
                              role="option"
                              aria-selected={active}
                              className={`lt-opt${active ? ' sel' : ''}`}
                              onClick={() => {
                                choose(`${NEW}:${m.machine.machineId}`);
                                setPop(false);
                                taRef.current?.focus();
                              }}
                            >
                              <FolderPlus size={15} />
                              <span className="lt-opt-name">Новый проект</span>
                              <span className="lt-opt-where">{m.machine.name}</span>
                              {active && <Check size={14} />}
                            </button>
                          );
                        })}
                      {!query.trim() && !allMachines && createMachines.length > 1 && (
                        <button type="button" className="lt-opt lt-opt-more" onClick={() => setAllMachines(true)}>
                          <span className="lt-opt-name">Новый проект на другой машине…</span>
                          <span className="lt-opt-where">{createMachines.length - 1}</span>
                        </button>
                      )}
                      {listed.map((p) => {
                        const k = sessionKey(p.machineId, p.cwd);
                        const active = !!project && sessionKey(project.machineId, project.cwd) === k;
                        return (
                          <button
                            key={k}
                            type="button"
                            role="option"
                            aria-selected={active}
                            className={`lt-opt${active ? ' sel' : ''}`}
                            title={p.cwd}
                            onClick={() => {
                              choose(k);
                              setPop(false);
                              taRef.current?.focus();
                            }}
                          >
                            <Folder size={15} />
                            <span className="lt-opt-name">{p.label}</span>
                            {(query.trim() || (ambiguous.get(p.label) ?? 0) > 1) && <span className="lt-opt-where">{p.machineName}</span>}
                            {active && <Check size={14} />}
                          </button>
                        );
                      })}
                      {listed.length === 0 && query.trim() && <div className="proj-pop-empty">Ничего не нашлось</div>}
                    </div>
                  </div>
                )}
              </div>
              <div className="composer-right">
                {!privateTargetRef.current && <VoiceButton recorder={recorder} />}
                {recorder.state === 'recording' ? (
                  <button
                    className="send-round"
                    disabled={!canTarget}
                    onClick={recorder.sendNow}
                    title="Закончить запись и отправить"
                    aria-label="Закончить запись и отправить"
                  >
                    <ArrowUpIcon size={17} weight="bold" />
                  </button>
                ) : (
                  <button
                    className="send-round"
                    disabled={!canSend || recorder.state === 'transcribing'}
                    onClick={() => void submitText(draft)}
                    title={sending ? 'Создаю проект…' : recorder.state === 'transcribing' ? 'Распознаю запись…' : 'Отправить'}
                    aria-label="Отправить"
                  >
                    <ArrowUpIcon size={17} weight="bold" />
                  </button>
                )}
              </div>
            </div>
          </div>
          {(note || sending) && (
            <div className={`lt-note${note ? ' err' : ''}`} role="status">
              {note || 'Создаю проект…'}
            </div>
          )}
          {!note && !sending && !runtimeReady && !block && (
            <div className="lt-note err" role="status">
              На «{targetMachine?.machine.name}» нет входа ни в Claude, ни в Codex — выберите другой проект или{' '}
              <a href={fullHref('/w/start')}>войдите в «Начале»</a>.
            </div>
          )}
          {!note && !sending && runtimeReady && makeNew && (
            <div className="lt-note">
              Новый проект — папка появится на «{newMachine?.machine.name}» и назовётся по первому сообщению.
            </div>
          )}
        </div>

        <Pile id="lt-attn" title="Ждут вас" tasks={tasks.attention} />
        <Pile id="lt-work" title="В работе" tasks={tasks.working} />
        <Pile id="lt-done" title="Готово" tasks={tasks.done} />
        {nothing && central.hydrated && !block && (
          <p className="lt-empty">Здесь появятся ваши задачи: что ждёт ответа, что в работе и что готово.</p>
        )}
      </div>
    </div>
  );
}
