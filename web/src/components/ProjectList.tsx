import { endTabDrag, startTabDrag } from './TabStrip.js';
import { useEffect, useMemo, useState } from 'react';
import { CaretDown, CaretRight, Clock, Eye, EyeSlash, Folder, FolderOpen, FolderPlus, ListViewIcon, MoreIcon, NotePencil, Plus, PushPin, PushPinSlash } from '../icons.js';
import { AgentMark } from './AgentMark.js';
import { Avatar } from './Avatar.js';
import type { ActiveRunInfo, MachineSnapshot, SessionSummary } from '@cc-remote/shared';
import { arrangeProjects, authorOf, compareByAttention, compareProjects, groupByPerson, NO_AUTHOR, NO_PROJECT, panelProjectKey, pluralRu, relTime, shortName, sessionCreated, sessionIsActive, sessionIsMine, sessionIsWorking, sessionKey, sessionOwner, sessionUrgency } from '../lib.js';
import { useFoldedProjects, useHiddenProjects, usePinnedProjects } from '../appHooks.js';
import { PinnedSection } from './PinnedNav.js';
import { useScopeAvailable, useSessionScope } from './MineOnly.js';
import { ContextMenu, longPressProps, type MenuAction, type MenuAt } from './ContextMenu.js';
import { linkProps, navigate, useRoute } from '../router.js';
import { storageGet, storageSet } from '../storage.js';

type Row = { machineId: string; machineName: string; machineOnline: boolean; session: SessionSummary };
/** A side-panel project: its key (`panelProjectKey`), its rows in panel order,
 *  and what `arrangeProjects` sorts it by (`created` orders, `lastModified` is
 *  freshness and the «Раньше» time). */
type Project = { key: string; rows: Row[]; urgency: number; lastModified: number; created: number };

const projectTitle = (key: string) => (key === NO_PROJECT ? 'Без проекта' : key);

/** How many CALM sessions a project block previews. Was three; two since
 *  30.09.2026, when the panel had grown into «a long canvas» — with up to
 *  eight cards before «Раньше», a third row per card is eight more lines of
 *  scrolling. Urgent sessions are not subject to it — see CARD_ACTIVE. */
const CARD_SESSIONS = 2;

/** Ceiling on the live rows one card lists. There is no ceiling in spirit —
 *  a card is now the ONLY place live work is visible, so hiding some of it is
 *  the bug this rewrite fixes — but one machine can hold ~18 sessions open in
 *  VS Code at once (see INVENTORY_DEBOUNCE_MS in agent/src/client.ts), and a
 *  single project eating the column is its own failure. The overflow gets a
 *  line of its own rather than vanishing. */
const CARD_ACTIVE = 10;

/** Projects a person's card lists under «Команда» before «ещё N» reveals the
 *  rest in place. A card per PERSON holds every project they
 *  touched, and one prolific colleague must not push everyone else below the
 *  fold — the question the mode answers is «кто чем занят», for all of them. */
const PERSON_PROJECTS = 4;

/** Rows a project reveals IN PLACE per click (10.10.2026, by request: «нажатие
 *  на папку раскрывает сессии внутри бокового меню, а не открывает окно»).
 *  A project can hold hundreds of sessions, so the list grows by a page at a
 *  time under «ещё N», never all at once. */
const EXPAND_STEP = 10;


/**
 * Project-first context column. The TOP LEVEL lists projects as blocks: a
 * heading (name, live square, needs-attention badge, total) over the machine,
 * then EVERY live session of that project followed by the newest dormant ones.
 * Opening the heading goes to /w/p/:project — the project's full session list,
 * in the main column (ProjectSessions); the card it came from is marked.
 *
 * Two shapes here exist because of what the hub can and cannot know:
 *
 * - **Newest first, urgent above it** (30.09.2026). Projects and rows sort by
 *   the last change; only a run that waits for you outranks
 *   that (`sessionUrgency`). «Live» used to outrank it, and «live» included a
 *   VS Code window left open for a week — the order followed open editors and
 *   read as random.
 *   Since 11.11.2026 the secondary key is CREATION time (`createdAt`, falling
 *   back to `lastModified`), not the last change: the list jumped on every
 *   message. Waiting/failed rows, then working ones, stay on top — of the
 *   project and of the list; quiet projects sink below active ones. Fresh projects are cards (`arrangeProjects`); the rest,
 *   and sessions with no project (`/`, `/root`, a home dir), fold into
 *   «Раньше» one line each. A project can be hidden from its heading's menu.
 * - **Whose work is one switch, three layouts** (`useSessionScope`, set from
 *   the top bar — see `MineOnly.tsx`). Split per SESSION, not per project, via
 *   `sessionIsMine`:
 *   - «Мои» — your sessions as project cards. Nobody else's, not even as a
 *     collapsed section: that would still say «there is other work here».
 *   - «Команда» — other people's sessions WITHOUT yours, one card per PERSON
 *     (who is doing what), their projects inside it.
 *   - «Все» — everything as project cards, the author named on every row that
 *     is not yours.
 *   Search always looks through everything, and names the author on a row
 *   that is not yours.
 */
export function ProjectList({
  machines,
  selected,
  runIndex,
  activeRuns,
  favorites,
  onSelect,
  onToggleFav,
  onDrillChange,
  onSessionMenu,
  viewerId,
  onAddColumn,
  onNewChatIn,
  query = '',
}: {
  /** Search from the side panel: only sessions whose title, project or
   *  machine contains it — and then EVERY match, not the card's preview. */
  query?: string;
  machines: MachineSnapshot[];
  /** Every session ON SCREEN, by `sessionKey`. A set rather than one pair
   *  because the split puts two to four of them there at once, and a list that
   *  can only mark one leaves the other panes unaccounted for — "you are here"
   *  has to be true of all of them or it is furniture. */
  selected: Set<string>;
  runIndex: Map<string, ActiveRunInfo>;
  /** The run list itself, not just the index: a run whose session the agent
   *  has not reported yet needs a row of its own — see `rows` below. */
  activeRuns: ActiveRunInfo[];
  favorites: Set<string>;
  onSelect: (machineId: string, sessionId: string) => void;
  onToggleFav: (key: string) => void;
  /** Lets the App hide the pinned region while inside a project. */
  onDrillChange?: (open: boolean) => void;
  /** A row was right-clicked, in viewport coordinates. Both row renderings
   *  below report to the same handler — one menu, two shapes of row. */
  onSessionMenu: (machineId: string, sessionId: string, x: number, y: number) => void;
  /** Current user id — splits «моё» from «Команда», and badges other owners. */
  viewerId?: string;
  /** «+» beside a row that is not on screen: open it as one more column.
   *  `null` = the split is full; absent = no split here (the phone drawer). */
  onAddColumn?: ((machineId: string, sessionId: string) => void) | null;
  /** The pencil on a project: a new chat aimed at it, opened BESIDE what is on
   *  screen like «Новый чат» (`newChatRoute`). Absent = a plain link. */
  onNewChatIn?: (aim: { machineId: string; cwd: string }) => void;
}) {
  const [scope, setScope] = useSessionScope();
  const canSwitch = useScopeAvailable();
  const [expandedPeople, setExpandedPeople] = useState<Set<string>>(() => new Set());
  /** Projects opened in place, and how many of their rows are on screen.
   *  Absent = the card's short preview. Per mount, like `expandedPeople`: an
   *  expanded list is a look, not a setting worth remembering. */
  const [expandedProjects, setExpandedProjects] = useState<Map<string, number>>(() => new Map());
  const expandProject = (key: string, limit: number | null) =>
    setExpandedProjects((prev) => {
      const next = new Map(prev);
      if (limit === null) next.delete(key);
      else next.set(key, limit);
      return next;
    });
  /** The «+» itself — a SIBLING of the row's link (a button inside an <a> is
   *  not valid HTML), laid over its right edge by `.has-col`. Only on rows
   *  that are not already on screen: for those it would be a no-op. */
  const colBtn = (machineId: string, sessionId: string, isSel: boolean) =>
    onAddColumn !== undefined && !isSel && sessionId ? (
      <button
        type="button"
        className="pc-col"
        disabled={!onAddColumn}
        title={onAddColumn ? 'Открыть рядом — ещё одной колонкой' : 'Колонок уже максимум'}
        aria-label="Открыть колонкой"
        onClick={(e) => {
          e.stopPropagation();
          onAddColumn?.(machineId, sessionId);
        }}
      >
        <Plus size={12} />
      </button>
    ) : null;
  // Every session of every visible machine, plus one synthetic row per run the
  // inventory has not caught up with.
  //
  // That second half is not a nicety. The agent's inventory is debounced 5s and
  // waits 800ms for the transcript to settle (INVENTORY_DEBOUNCE_MS,
  // awaitWriteFinish in agent/src/client.ts), so a session started from this
  // browser does not exist in `m.sessions` for several seconds. The pinned
  // «Сейчас в работе» block used to cover that gap by listing runs directly;
  // with it gone, the session you just started would blink out of the column
  // until the agent got around to mentioning it.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const seen = new Set<string>();
    for (const m of machines) {
      for (const s of m.sessions) {
        seen.add(sessionKey(m.machine.machineId, s.sessionId));
        out.push({
          machineId: m.machine.machineId,
          machineName: m.machine.name,
          machineOnline: m.online,
          session: { ...s, owner: sessionOwner(s, runIndex.get(sessionKey(m.machine.machineId, s.sessionId))) },
        });
      }
    }
    // Runs are NOT filtered by the machine chip upstream (App passes the whole
    // list), so restrict them to the machines actually on screen.
    const visible = new Map(machines.map((m) => [m.machine.machineId, m]));
    for (const r of activeRuns) {
      const m = visible.get(r.machineId);
      if (!m || seen.has(sessionKey(r.machineId, r.sessionId))) continue;
      out.push({
        machineId: r.machineId,
        machineName: r.machineName ?? m.machine.name,
        machineOnline: m.online,
        session: {
          sessionId: r.sessionId,
          title: r.title ?? '',
          project: r.project,
          lastModified: r.since,
          category: r.category,
          owner: sessionOwner({}, r),
        },
      });
    }
    const q = query.trim().toLowerCase();
    if (!q) return out;
    return out.filter((r) =>
      `${r.session.title ?? ''} ${r.session.project ?? ''} ${r.machineName}`.toLowerCase().includes(q),
    );
  }, [machines, activeRuns, query, runIndex]);
  const searching = query.trim() !== '';

  // The whole snapshot, not just its owner: «моё» reads the machine's KIND too
  // — an ownerless session on a shared sandbox belongs to nobody in particular
  // and must not be credited to the box's owner (see `sessionIsMine`).
  const machineById = useMemo(
    () => new Map(machines.map((m) => [m.machine.machineId, m])),
    [machines],
  );

  const urgency = useMemo(
    () => (r: Row) => sessionUrgency(runIndex.get(sessionKey(r.machineId, r.session.sessionId))),
    [runIndex],
  );

  /** Something waiting for you (or failed), then working, then the newest
   *  CREATED — 11.11.2026: a fresh message alone no longer moves a row.
   *  An open editor or an idle run does not outrank anything either — see
   *  `sessionUrgency`; the row itself still wears its marks. */
  const order = useMemo(
    () => (a: Row, b: Row) =>
      compareByAttention(
        { urgency: urgency(a), created: sessionCreated(a.session), id: a.session.sessionId },
        { urgency: urgency(b), created: sessionCreated(b.session), id: b.session.sessionId },
      ),
    [urgency],
  );

  const { hidden: hiddenProjects, setProjectHidden } = useHiddenProjects();
  const [pinnedProjects, setProjectPinned] = usePinnedProjects();
  const [foldedProjects, setProjectFolded] = useFoldedProjects();
  // The whole list folds under its «Проекты» heading, ChatGPT-style.
  const [listFolded, setListFolded] = useState(() => storageGet('cc-projects-folded') === '1');
  const toggleList = () =>
    setListFolded((v) => {
      storageSet('cc-projects-folded', v ? '0' : '1');
      return !v;
    });
  const [menu, setMenu] = useState<MenuAt<string> | null>(null);
  /** Where a project's «новый чат» and «файлы» go: the freshest row that names
   *  a folder — a label alone cannot say WHICH `crm`. Filled while rendering. */
  const aims = new Map<string, Row>();
  // Rows sit by CREATION now (11.11.2026); the folder to act in is still the
  // one worked in last, as on the project page.
  const freshestWithCwd = (rs: Row[]) =>
    rs.reduce<Row | undefined>((best, r) => (r.session.cwd && (!best || r.session.lastModified > best.session.lastModified) ? r : best), undefined);
  const aimOf = (key: string) => aims.get(key);
  const newChatIn = (key: string) => {
    const aim = aimOf(key);
    if (!aim?.session.cwd) return;
    const target = { machineId: aim.machineId, cwd: aim.session.cwd };
    if (onNewChatIn) onNewChatIn(target);
    else navigate({ kind: 'new', ...target });
  };
  const menuActions: MenuAction<string>[] = [
    { label: 'Закрепить', icon: <PushPin size={16} />, run: (key) => setProjectPinned(key, true), when: (key) => !pinnedProjects.has(key) },
    { label: 'Открепить', icon: <PushPinSlash size={16} />, run: (key) => setProjectPinned(key, false), when: (key) => pinnedProjects.has(key) },
    { label: 'Новый чат в проекте', icon: <NotePencil size={16} />, run: newChatIn, when: (key) => key !== NO_PROJECT && Boolean(aimOf(key)?.session.cwd) },
    { label: 'Все чаты проекта', icon: <ListViewIcon size={16} />, run: (key) => navigate({ kind: 'project', project: key }) },
    {
      label: 'Открыть в Файлах',
      icon: <FolderOpen size={16} />,
      separated: true,
      run: (key) => {
        const aim = aimOf(key);
        if (aim?.session.cwd) navigate({ kind: 'files', machineId: aim.machineId, root: aim.session.cwd });
      },
      when: (key) => key !== NO_PROJECT && Boolean(aimOf(key)?.session.cwd),
    },
    { label: 'Скрыть проект', icon: <EyeSlash size={16} />, separated: true, run: (key) => setProjectHidden(key, true), when: (key) => !hiddenProjects.has(key) },
    { label: 'Вернуть в список', icon: <Eye size={16} />, separated: true, run: (key) => setProjectHidden(key, false), when: (key) => hiddenProjects.has(key) },
  ];
  const openMenu = (key: string) => ({
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      setMenu({ target: key, x: e.clientX, y: e.clientY });
    },
    ...longPressProps((x, y) => setMenu({ target: key, x, y })),
  });
  /** The «…» button: the same menu, dropped under the button. */
  const menuButton = (key: string, label: string) => (
    <button
      type="button"
      className="pc-dots"
      title="Действия с проектом"
      aria-label={`Действия с проектом ${label}`}
      aria-haspopup="menu"
      onClick={(e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        setMenu((m) => (m?.target === key ? null : { target: key, x: r.left, y: r.bottom + 4 }));
      }}
    >
      <MoreIcon size={16} weight="bold" />
    </button>
  );

  const group = useMemo(() => {
    const build = (input: Row[]): Project[] => {
      const map = new Map<string, Row[]>();
      for (const r of input) {
        const key = panelProjectKey(r.session);
        (map.get(key) ?? map.set(key, []).get(key)!).push(r);
      }
      return [...map.entries()]
        .map(([key, rs]) => {
          rs.sort(order);
          // A project's urgency is its loudest row (2 = waits, 1 = working);
          // only 2 orders, 1 just keeps the card on the shelf. Order is by the
          // newest CREATED row, freshness (`lastModified`) stays separate.
          return {
            key,
            rows: rs,
            urgency: Math.max(...rs.map(urgency)),
            lastModified: Math.max(...rs.map((r) => r.session.lastModified)),
            created: Math.max(...rs.map((r) => sessionCreated(r.session))),
          };
        })
        .sort(compareProjects);
    };
    const mine: Row[] = [];
    const team: Row[] = [];
    for (const r of rows) {
      (sessionIsMine(r.session, machineById.get(r.machineId), viewerId) ? mine : team).push(r);
    }
    const keyOf = (r: Row) => authorOf(r.session, machineById.get(r.machineId), viewerId).key;
    const working = (r: Row) => sessionIsWorking(r.session, runIndex.get(sessionKey(r.machineId, r.session.sessionId)));
    const personOrder = (a: Row, b: Row) => Number(working(b)) - Number(working(a)) || order(a, b);
    const people = groupByPerson(
      team.filter((r) => urgency(r) === 2 || !hiddenProjects.has(panelProjectKey(r.session))),
      personOrder,
      keyOf,
    );
    return { mine: build(mine), team: build(team), all: build(rows), people };
  }, [rows, machineById, viewerId, order, urgency, runIndex, hiddenProjects]);

  // From the list on screen, not every list: under «Мои» a colleague's `crm`
  // must not lend its folder to yours. A card re-sets its own below.
  for (const p of searching || scope === 'all' ? group.all : scope === 'team' ? group.team : group.mine) {
    const aim = freshestWithCwd(p.rows);
    if (aim) aims.set(p.key, aim);
  }

  /** Name the author on a row that is not yours — everywhere except under
   *  «Команда», where the card itself is the person. */
  const authorOnRows = searching || scope === 'all';

  // Which project is on screen comes from the URL. Pressing a card's heading
  // opens `/w/p/:project`, and since 27.09.2026 that page — ProjectSessions, in
  // the MAIN column — is the full list of the project's sessions. The panel
  // used to drill in as well, which put the same list in two places and took
  // the other projects away; now it stays put and marks the card instead.
  const route = useRoute();
  const openProject = route.kind === 'project' ? route.project : null;
  useEffect(() => { onDrillChange?.(false); }, [onDrillChange]);

  if (machines.length === 0) return null;
  if (group.all.length === 0) return <div className="empty">{searching ? 'Ничего не нашлось' : 'Проектов нет'}</div>;

  // ---- top level: one block per project. The block is a HEADING plus every
  // live session and a few recent dormant ones, because that is the question
  // the screen answers — what is going on in this project — and a single
  // latest-session line answered it three times worse for the same height. The
  // letter avatar went with it: a tinted "C" beside the word "crm" is
  // decoration, and in a 130px column it was spending a third of the width to
  // repeat the first character of the name. ----
  /** One compact row inside a project card. Live rows additionally say WHERE
   *  they are being driven from — the question a card full of green squares
   *  raises immediately. */
  const cardRow = ({ machineId, session: s }: Row) => {
    const isSel = selected.has(sessionKey(machineId, s.sessionId));
    const run = runIndex.get(sessionKey(machineId, s.sessionId));
    const live = sessionIsActive(s, run);
    const col = colBtn(machineId, s.sessionId, isSel);
    const machine = machineById.get(machineId);
    const who = authorOnRows && !sessionIsMine(s, machine, viewerId) ? authorOf(s, machine, viewerId).name : null;
    return (
      <li key={sessionKey(machineId, s.sessionId)} className="has-acts">
        <a
          className={`pc-sess ${isSel ? 'sel' : ''}`}
          {...linkProps({ kind: 'session', machineId, sessionId: s.sessionId })}
          // A modified click stays the browser's — open in a new tab — so
          // only the plain one switches this view.
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
            e.preventDefault();
            onSelect(machineId, s.sessionId);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            onSessionMenu(machineId, s.sessionId, e.clientX, e.clientY);
          }}
          // Dragged onto the split: into a pane's tab strip, or to a pane's
          // edge for a column of its own (TabStrip.tsx).
          draggable
          onDragStart={(e) => startTabDrag(e, { kind: 'session', machineId, sessionId: s.sessionId }, s.title || s.sessionId)}
          onDragEnd={endTabDrag}
          {...longPressProps((x, y) => onSessionMenu(machineId, s.sessionId, x, y))}
          title={`${s.title || s.sessionId.slice(0, 8)}${who ? ` · ${who}` : ''}${live ? ` · ${whereLive(s, run)}` : ''} · ${relTime(s.lastModified)}`}
        >
          {/* `live` here is `sessionIsActive` — open OR holding a run, which is
              NOT the same question. The bolt marks work actually happening, so
              it reads the run's own state. */}
          {sessionIsWorking(s, run) && (
            <AgentMark source={s.source} provider={s.provider} size={12} className="srun" />
          )}
          {/* WHICH session wants you (27.09.2026, Astra's review): the ember
              count on the project said «someone here needs an answer» and
              left you to find them. A still 8×8 square on the row itself —
              ember for a decision, red for an error. */}
          {run?.state === 'needs_attention' && <span className="pcs-mark attn" title="Нужно решение" />}
          {run?.state === 'error' && <span className="pcs-mark err" title="Ошибка" />}
          <span className="pcs-title">{s.title || s.sessionId.slice(0, 8)}</span>
          {/* Whose it is, by first name — the full name is in the tooltip. A
              row is one line in a 260px card, and «Анна Смирнова» beside a
              title would take the title's room. */}
          {who && <span className="pcs-who" title={`Автор: ${who}`}>{shortName(who)}</span>}
          {/* «web» / «vscode» moved to the tooltip (27.09.2026): a column of
              source words beside every live row was the loudest noise in the
              panel, and where a run is driven from is a hover question. */}
          <span className="pcs-time">{relTime(s.lastModified)}</span>
        </a>
        {/* «…» = the row's right-click menu, for a mouse that does not know
            about right-click and for touch (08.10.2026, by request). */}
        <span className="pcs-acts">
          <button
            type="button"
            className="pcs-dots"
            title="Действия с сессией"
            aria-label="Действия с сессией"
            aria-haspopup="menu"
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              onSessionMenu(machineId, s.sessionId, r.left, r.bottom + 4);
            }}
          >
            <MoreIcon size={16} weight="bold" />
          </button>
          {col}
        </span>
      </li>
    );
  };

  /** What a card previews, in panel order: every row with urgency > 0 (up to
   *  CARD_ACTIVE) plus the first CARD_SESSIONS calm ones. Nothing is hoisted. */
  const cardPreview = (rows: Row[]) => {
    let live = 0;
    let calm = 0;
    return rows.filter((r) => {
      if (urgency(r) > 0) return live++ < CARD_ACTIVE;
      return calm++ < CARD_SESSIONS;
    });
  };

  /** A card's rows: every urgent one up to the ceiling, the overflow named,
   *  then the first calm ones, all in `order`. */
  const cardRows = (rows: Row[], moreHref: ReturnType<typeof linkProps>, expand?: { key: string; limit: number | undefined }) => {
    if (expand?.limit !== undefined && !searching) {
      // Opened in place: the first `limit` rows in panel order plus every
      // urgent one wherever it sits (they are no longer hoisted, 11.11.2026),
      // then «ещё N» for the next page and «Свернуть».
      const { key, limit } = expand;
      const visible = rows.filter((r, i) => i < limit || urgency(r) > 0);
      const rest = rows.length - visible.length;
      const next = Math.min(rest, EXPAND_STEP);
      // The next page is the next `next` HIDDEN rows: urgent ones past
      // `limit` are on screen already and must not eat the page.
      const hiddenAt = rows.flatMap((r, i) => (i >= limit && urgency(r) === 0 ? [i] : []));
      const nextLimit = next > 0 ? hiddenAt[next - 1]! + 1 : limit;
      return (
        <ul className="pc-sessions">
          {visible.map(cardRow)}
          <li className="pc-more-row">
            {rest > 0 && (
              <button
                type="button"
                className="pc-more pc-more-btn"
                onClick={() => expandProject(key, nextLimit)}
                title={`Осталось ${rest}`}
              >
                ещё {next}
                {rest > next && <span className="pc-more-of"> из {rest}</span>}
              </button>
            )}
            <button type="button" className="pc-more pc-more-btn" onClick={() => expandProject(key, null)}>
              Свернуть
            </button>
          </li>
        </ul>
      );
    }
    // Searching shows every match: the card preview exists to keep an
    // unfiltered column short, and a filtered one is short already.
    const preview = searching ? rows : cardPreview(rows);
    const liveCount = rows.filter((r) => urgency(r) > 0).length;
    const hiddenLive = searching ? 0 : Math.max(0, liveCount - CARD_ACTIVE);
    const hiddenTotal = rows.length - preview.length;
    // Where «ещё» leads: open the project right here when the card can be
    // expanded (the side panel), the project page otherwise (person cards).
    const more = (label: string, limit?: number) =>
      expand ? (
        <button type="button" className="pc-more pc-more-btn" onClick={() => expandProject(expand.key, Math.max(EXPAND_STEP, limit ?? preview.length + EXPAND_STEP))}>
          {label}
        </button>
      ) : (
        <a className="pc-more" {...moreHref}>
          {label}
        </a>
      );
    return (
      <ul className="pc-sessions">
        {/* Panel order, no hoisting: live and calm rows interleave by creation. */}
        {preview.map(cardRow)}
        {/* Live rows past the ceiling: opening reveals the whole list, as they
            can sit anywhere in it. */}
        {hiddenLive > 0 && <li>{more(`ещё ${hiddenLive} в работе`, rows.length)}</li>}
        {/* The quiet rest of the project, opened in place (10.10.2026). */}
        {expand && hiddenLive === 0 && hiddenTotal > 0 && <li>{more(`ещё ${hiddenTotal}`)}</li>}
      </ul>
    );
  };

  const card = ({ key: name, rows }: Project) => {
    const attn = rows.filter(
      (r) => runIndex.get(sessionKey(r.machineId, r.session.sessionId))?.state === 'needs_attention',
    ).length;
    const label = projectTitle(name);
    const machinesIn = [...new Set(rows.map((r) => r.machineName))];
    // A search unfolds everything: a match inside a folded project is still
    // the match you were looking for.
    const folded = !searching && foldedProjects.has(name);
    const pinned = pinnedProjects.has(name);
    const aim = freshestWithCwd(rows);
    if (aim) aims.set(name, aim);
    const moreHref = linkProps({ kind: 'project', project: name });
    // Folded still shows what waits for you or is running: folding tidies the
    // quiet history away, it must not hide a question needing an answer.
    const shownRows = folded ? rows.filter((r) => urgency(r) > 0) : rows;
    const limit = folded || searching ? undefined : expandedProjects.get(name);
    const isOpen = limit !== undefined;
    // ChatGPT's project list as the reference (08.10.2026, by request): a
    // folder glyph and the name in the rows' own type, the chats indented
    // under it, «…» and the pencil waiting for the pointer.
    return (
      <article
        className={`proj-card pg${openProject === name ? ' here' : ''}${folded ? ' folded' : ''}${pinned ? ' pinned' : ''}${menu?.target === name ? ' menu-open' : ''}`}
        key={name}
      >
        <div className="pc-headrow" {...openMenu(name)}>
          <button
            type="button"
            className="pc-fold"
            onClick={() => setProjectFolded(name, !folded)}
            aria-expanded={!folded}
            title={folded ? 'Развернуть' : 'Свернуть'}
            aria-label={`${folded ? 'Развернуть' : 'Свернуть'} ${label}`}
          >
            {folded ? <Folder size={18} /> : <FolderOpen size={18} />}
          </button>
          {/* The name opens the project's chats IN the panel (10.10.2026, by
              request) instead of sending the main column to /w/p/:project —
              that page stays one modified click (new tab) or the menu's «Все
              чаты проекта» away. A folded project unfolds on the way. */}
          <a
            className="pc-head"
            {...moreHref}
            onClick={(e) => {
              // Search already lists every match: nothing to open, so the name
              // keeps its old job there and goes to the project page.
              if (searching) return moreHref.onClick(e);
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
              e.preventDefault();
              if (folded) setProjectFolded(name, false);
              // One page MORE than the preview shows — a busy project's
              // preview can already hold ten live rows plus two quiet ones.
              expandProject(name, isOpen && !folded ? null : cardPreview(rows).length + EXPAND_STEP);
            }}
            aria-expanded={isOpen}
            aria-current={openProject === name ? 'page' : undefined}
            title={`${isOpen ? 'Свернуть' : 'Показать чаты'}: ${label}${machinesIn.length ? ` · ${machinesIn.join(', ')}` : ''}`}
          >
            <span className="pc-name">
              {label}
              {machinesIn[0] && <span className="pc-mach"> {machinesIn[0]}</span>}
            </span>
            {pinned && <PushPin size={12} className="pc-pin" aria-label="Закреплён" />}
            {attn > 0 && <span className="unread" title="Нужно внимание">{attn}</span>}
          </a>
          {menuButton(name, label)}
          {/* A new chat right here — opened BESIDE what is on screen, the way
              «Новый чат» at the top does (08.10.2026, by request), not in
              place of it. A sibling of the heading: no link inside a link. */}
          {aim?.session.cwd && name !== NO_PROJECT && (
            <a
              className="pc-new"
              {...linkProps({ kind: 'new', machineId: aim.machineId, cwd: aim.session.cwd })}
              onClick={(e) => {
                if (!onNewChatIn || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                e.preventDefault();
                newChatIn(name);
              }}
              title={`Новый чат в ${label} · ${aim.machineName}`}
              aria-label={`Новый чат в ${label}`}
            >
              <NotePencil size={16} />
            </a>
          )}
        </div>
        {shownRows.length > 0 && cardRows(shownRows, moreHref, folded ? undefined : { key: name, limit })}
      </article>
    );
  };

  /** «Команда»: one card per person, with projects revealed in place. The
   *  members page has no destination for an unknown author or a former member. */
  const personCard = ({ key, rows, projects }: (typeof group.people)[number]) => {
    const first = rows[0];
    const machine = machineById.get(first.machineId);
    const nobody = key === NO_AUTHOR;
    const { name } = authorOf(first.session, machine, viewerId);
    const workingCount = rows.filter((r) => sessionIsWorking(r.session, runIndex.get(sessionKey(r.machineId, r.session.sessionId)))).length;
    const attn = rows.filter(
      (r) => runIndex.get(sessionKey(r.machineId, r.session.sessionId))?.state === 'needs_attention',
    ).length;
    const expanded = expandedPeople.has(key);
    const shown = expanded ? projects : projects.slice(0, PERSON_PROJECTS);
    return (
      <article className="proj-card person-card" key={key}>
        <div className="pc-headrow">
          <div
            className="pc-head pp-head"
            title={nobody ? 'Автор этих сессий не записан — они могли быть открыты в терминале или редакторе' : name}
          >
            {!nobody && <Avatar tone={name} label={name} userId={key} className="pp-av" />}
            <span className="pp-identity">
              <h3 className="pp-name">{name}</h3>
              {nobody && <span className="pp-note">из терминала или редактора</span>}
            </span>
            {attn > 0 && <span className="unread" title="Нужно внимание">{attn}</span>}
            <span className={`pc-count${workingCount ? ' working' : ''}`}>
              {workingCount ? `${workingCount} в работе` : attn ? 'ждёт ответа' : 'тихо'}
            </span>
          </div>
        </div>
        {shown.map(([project, prow]) => {
          const machinesIn = [...new Set(prow.map((r) => r.machineName))];
          return (
            <div className="pp-proj" key={project}>
              <a
                className="pp-proj-head"
                {...linkProps({ kind: 'project', project })}
                title={`Все сессии: ${projectTitle(project)}`}
                {...openMenu(project)}
              >
                {projectTitle(project)}
                {machinesIn[0] && <span className="pc-mach" title={machinesIn.join(', ')}> {machinesIn[0]}</span>}
              </a>
              {cardRows(prow, linkProps({ kind: 'project', project }))}
            </div>
          );
        })}
        {projects.length > PERSON_PROJECTS && (
          <button
            type="button"
            className="pc-more pp-more"
            aria-expanded={expanded}
            onClick={() => setExpandedPeople((prev) => {
              const next = new Set(prev);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            })}
          >
            {expanded ? 'Свернуть проекты' : `ещё ${projects.length - PERSON_PROJECTS} ${pluralRu(projects.length - PERSON_PROJECTS, ['проект', 'проекта', 'проектов'])}`}
          </button>
        )}
      </article>
    );
  };

  /** One line of the folded tail: name · machine · when. The whole line opens
   *  the project page, like a card's heading; its menu hides or returns it. */
  const olderRow = ({ key, rows: prow, lastModified }: Project) => {
    const machinesIn = [...new Set(prow.map((r) => r.machineName))];
    return (
      <li key={key}>
        <a
          className={`pc-sess pc-older${openProject === key ? ' sel' : ''}`}
          {...linkProps({ kind: 'project', project: key })}
          aria-current={openProject === key ? 'page' : undefined}
          title={`Все сессии: ${projectTitle(key)}${machinesIn.length ? ` · ${machinesIn.join(', ')}` : ''}`}
          {...openMenu(key)}
        >
          <span className="pcs-title">
            {projectTitle(key)}
            {machinesIn[0] && <span className="pc-mach"> {machinesIn[0]}</span>}
          </span>
          <span className="pcs-time">{relTime(lastModified)}</span>
        </a>
      </li>
    );
  };

  const menuEl = (
    <ContextMenu at={menu} actions={menuActions} onClose={() => setMenu(null)} label="Действия с проектом" />
  );

  if (searching) {
    return (
      <div className="projects-tree">
        <div className="proj-grid">{group.all.map(card)}</div>
        {menuEl}
      </div>
    );
  }

  if (scope === 'team') {
    return (
      <div className="projects-tree">
        {group.people.length === 0 ? (
          <div className="empty">У команды сейчас нет сессий, которые тебе видны.</div>
        ) : (
          <div className="proj-grid">{group.people.map(personCard)}</div>
        )}
        {menuEl}
      </div>
    );
  }

  const list = scope === 'all' ? group.all : group.mine;
  // A hidden project that WAITS for you comes back as a card while it waits:
  // a card is the only place the panel shows a question needing an answer.
  const isHidden = (p: Project) => p.urgency < 2 && hiddenProjects.has(p.key);
  // Pinned projects lead, newest created first, whatever their age — and a pin
  // outranks a hide: pinning is the louder of the two wishes.
  const pinnedList = list.filter((p) => pinnedProjects.has(p.key)).sort((a, b) => b.created - a.created || a.key.localeCompare(b.key));
  const rest = list.filter((p) => !pinnedProjects.has(p.key));
  const shown = rest.filter((p) => !isHidden(p));
  const hidden = rest.filter(isHidden);
  const arranged = arrangeProjects(shown);
  const recent = [...pinnedList, ...arranged.recent];
  const older = arranged.older;
  return (
    <div className="projects-tree">
      <div className="pl-head">
        <button type="button" className="pl-title" onClick={toggleList} aria-expanded={!listFolded}>
          Проекты
          {listFolded ? <CaretRight size={12} weight="bold" /> : <CaretDown size={12} weight="bold" />}
        </button>
        <a className="pl-add" {...linkProps({ kind: 'new', create: true })} title="Новый проект" aria-label="Новый проект">
          <FolderPlus size={16} />
        </a>
      </div>
      {/* Folded, the list still shows a project that waits for an answer. */}
      {(listFolded ? recent.filter((p) => p.urgency === 2) : recent).length > 0 && (
        <div className="proj-grid">{(listFolded ? recent.filter((p) => p.urgency === 2) : recent).map(card)}</div>
      )}
      {/* The folded tail (30.09.2026): everything not touched for a week, past
          the eighth card, or with no project at all. Closed by default — the
          panel's job is «where is work happening», and forty quiet projects
          stacked under the live ones was the «long canvas» it had become. */}
      {!listFolded && older.length > 0 && (
        <PinnedSection title="Раньше" icon={<Clock size={13} />} count={older.length} defaultOpen={false}>
          <ul className="pc-sessions pc-older-list">{older.map(olderRow)}</ul>
        </PinnedSection>
      )}
      {!listFolded && hidden.length > 0 && (
        <PinnedSection title="Скрытые" icon={<Eye size={13} />} count={hidden.length} defaultOpen={false}>
          <ul className="pc-sessions pc-older-list">{hidden.map(olderRow)}</ul>
        </PinnedSection>
      )}
      {menuEl}
      {/* Not "no projects" — the column would otherwise go blank on a shared
          box where every session belongs to somebody else, and a blank column
          is read as a broken one. The sentence says where the other work is.
          The way there is the top bar's switch when the viewer has one
          (owners and managers); a member finds colleagues under «Команда». */}
      {list.length === 0 && group.team.length > 0 && (
        <div className="empty">
          Своих сессий здесь нет.{' '}
          {canSwitch ? (
            <button type="button" className="pjd-link" onClick={() => setScope('team')}>
              Показать команду
            </button>
          ) : (
            <a className="pjd-link" {...linkProps({ kind: 'team', tab: 'overview' })}>
              Работа коллег — в «Команде»
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/** Where a live session is being driven from. `entrypoint` is the only
 *  editor evidence the fleet has (`claude-vscode`, `cli`, …); a hub-driven run
 *  has no pid file of its own, so it reports the client that opened it. */
function whereLive(s: SessionSummary, run: ActiveRunInfo | undefined): string {
  if (s.livePid) return s.entrypoint === 'claude-vscode' ? 'vscode' : (s.entrypoint ?? 'editor');
  return run?.origin === 'app' ? 'app' : 'web';
}
