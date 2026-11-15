import { useMemo, useState, type MouseEvent } from 'react';
import { BOARD_SINCE_DAYS, BOARD_SINCE_DEFAULT, SESSION_STAGES, type BoardCard as Card, type BoardResponse, type BoardStatus } from '@cc-remote/shared';
import { linkProps, navigate } from '../../router.js';
import { pluralRu, relTimeRu } from '../../lib.js';
import { KanbanIcon, RefreshCw } from '../../icons.js';
import { ApiError } from '../../api.js';
import { usePhone } from '../../shell/usePhone.js';
import { Avatar } from '../Avatar.js';
import { ContextMenu, type MenuAction, type MenuAt } from '../ContextMenu.js';
import { DragScrollRow } from '../DragScrollRow.js';
import { BoardCard } from './BoardCard.js';
import { CardDrawer } from './CardDrawer.js';
import { groupCards, groupDone, STATUS_LABEL } from './boardModel.js';
import { useBoard, type BoardRoute } from './useBoard.js';

/**
 * «Доска» — the task board. Columns are the kanban stages; cards are TASKS the
 * hub assembled out of sessions, written for someone who does not read code.
 * Filters (person, area/project, period) live in the URL; a card's drawer is
 * `?card=`; on a phone the columns become a tab strip and one column at a time
 * (`?col=`), the pattern Команда already uses for five tabs on 390px.
 *
 * Nothing here decides who sees what — the hub's `/api/board` already applied
 * the viewer's scope. A 403 is a message, not a hidden nav row.
 */
export function Board({
  route,
  providerOf,
}: {
  route: BoardRoute;
  /** The live inventory's `provider` for a card's session (board rows do not carry it). */
  providerOf?: (machineId: string, sessionId: string) => string | undefined;
}) {
  const phone = usePhone();
  const { data, loading, refreshing, error, updatedAt, refresh, patch } = useBoard(route);
  const [menu, setMenu] = useState<MenuAt<Card> | null>(null);
  const since = route.since ?? BOARD_SINCE_DEFAULT;
  const cards = data?.cards ?? [];
  const byStatus = useMemo(() => groupCards(cards), [cards]);
  const open = route.card ? cards.find((c) => c.cardId === route.card) : undefined;
  const now = Date.now();

  const menuActions: MenuAction<Card>[] = [
    ...SESSION_STAGES.map<MenuAction<Card>>((s) => ({
      label: `→ ${s.label}`,
      when: (c) => c.status !== s.id,
      run: (c) => void patch(c.cardId, { status: s.id }),
    })),
    {
      label: 'Нужен ответ',
      when: (c) => c.attention !== 'question',
      run: (c) => void patch(c.cardId, { attention: 'question' }),
      separated: true,
    },
    {
      label: 'Заблокировано',
      when: (c) => c.attention !== 'blocked',
      run: (c) => void patch(c.cardId, { attention: 'blocked' }),
    },
    {
      label: 'Снять флаг',
      when: (c) => c.attention !== 'none',
      run: (c) => void patch(c.cardId, { attention: 'none' }),
    },
  ];
  const onMenu = (card: Card, e: MouseEvent) => setMenu({ target: card, x: e.clientX, y: e.clientY });
  const closeDrawer = () => {
    const { card: _card, ...rest } = route;
    navigate(rest);
  };

  const sub = loading
    ? 'собираю…'
    : error
      ? 'не удалось загрузить'
      : `${cards.length} ${pluralRu(cards.length, ['карточка', 'карточки', 'карточек'])} · ${since} ${pluralRu(since, ['день', 'дня', 'дней'])}` +
        (refreshing ? ' · обновляю…' : updatedAt ? ` · обновлено ${relTimeRu(updatedAt, now)}` : '');

  return (
    <div className={`board bd${open ? ' bd-has-drawer' : ''}`}>
      <div className="board-head">
        <KanbanIcon size={20} />
        <h2>Доска</h2>
        <span className="sub">{sub}</span>
        <button type="button" className="icon-btn bd-refresh" onClick={() => void refresh()} aria-label="Обновить" title="Обновить" disabled={refreshing}>
          <RefreshCw size={16} className={refreshing ? 'spin' : ''} />
        </button>
      </div>

      {data && <Filters data={data} route={route} phone={phone} />}

      <div className="bd-body">
        <div className="bd-main">
          {error && <ErrorNote error={error} retry={() => void refresh()} />}
          {!error && loading && <Skeleton />}
          {!error && !loading && cards.length === 0 && <Empty route={route} />}
          {!error && !loading && cards.length > 0 && (
            phone ? (
              <PhoneColumns route={route} byStatus={byStatus} since={since} now={now} onMenu={onMenu} />
            ) : (
              <div className="bd-cols">
                {SESSION_STAGES.map((s) => (
                  <Column key={s.id} status={s.id} cards={byStatus.get(s.id) ?? []} route={route} since={since} now={now} onMenu={onMenu} />
                ))}
              </div>
            )
          )}
        </div>
        {open && <CardDrawer card={open} onClose={closeDrawer} onPatch={(id, p) => void patch(id, p)} providerOf={providerOf} />}
      </div>

      <ContextMenu at={menu} actions={menuActions} onClose={() => setMenu(null)} label="Действия с карточкой" />
    </div>
  );
}

function Column({
  status,
  cards,
  route,
  since,
  now,
  onMenu,
}: {
  status: BoardStatus;
  cards: Card[];
  route: BoardRoute;
  since: number;
  now: number;
  onMenu: (card: Card, e: MouseEvent) => void;
}) {
  const groups = status === 'done' ? groupDone(cards, now, since) : null;
  return (
    <section className={`bd-col ${status}`} aria-label={STATUS_LABEL[status]}>
      <header className="bd-col-head">
        <span className="eyebrow eyebrow--mark">{STATUS_LABEL[status]}</span>
        <span className="bd-count">{cards.length}</span>
      </header>
      {cards.length === 0 && <div className="bd-empty-col">—</div>}
      {groups
        ? groups.map((g) => (
            <div key={g.label} className="bd-group">
              <div className="bd-group-l">{g.label}</div>
              {g.cards.map((c) => <BoardCard key={c.cardId} card={c} route={route} open={route.card === c.cardId} onMenu={onMenu} />)}
            </div>
          ))
        : cards.map((c) => <BoardCard key={c.cardId} card={c} route={route} open={route.card === c.cardId} onMenu={onMenu} />)}
    </section>
  );
}

/** One column at a time, chosen by a tab strip that scrolls inside itself. */
function PhoneColumns({
  route,
  byStatus,
  since,
  now,
  onMenu,
}: {
  route: BoardRoute;
  byStatus: Map<BoardStatus, Card[]>;
  since: number;
  now: number;
  onMenu: (card: Card, e: MouseEvent) => void;
}) {
  const col: BoardStatus = route.col ?? 'in_progress';
  return (
    <>
      <div className="tabs bd-seg" role="tablist" aria-label="Колонки">
        {SESSION_STAGES.map((s) => (
          <a
            key={s.id}
            role="tab"
            aria-selected={col === s.id}
            className={`tab${col === s.id ? ' active' : ''}`}
            {...linkProps({ ...route, col: s.id }, { replace: true })}
          >
            {s.label} <span className="bd-count">{byStatus.get(s.id)?.length ?? 0}</span>
          </a>
        ))}
      </div>
      <Column status={col} cards={byStatus.get(col) ?? []} route={route} since={since} now={now} onMenu={onMenu} />
    </>
  );
}

function Filters({ data, route, phone }: { data: BoardResponse; route: BoardRoute; phone: boolean }) {
  const since = route.since ?? BOARD_SINCE_DEFAULT;
  const areaIds = new Set(data.cards.map((c) => c.area ?? 'unassigned'));
  const areas = data.areas.filter((a) => areaIds.has(a.id) || route.project === a.id);
  const projects = route.project ? Array.from(new Set(data.cards.map((c) => c.project).filter(Boolean))) : [];
  const chip = (on: boolean, extra = '') => `chip${on ? ' on' : ''}${extra}`;
  const Row = phone ? DragScrollRow : ({ children, className }: { children: React.ReactNode; className: string; label: string }) => <div className={className}>{children}</div>;
  return (
    <div className="bd-filters">
      {data.owners.length > 1 && (
        <Row className="bd-frow" label="Кто">
          <span className="si-label">Кто</span>
          <a className={chip(!route.owner)} {...linkProps({ ...route, owner: undefined, card: undefined })}>Все</a>
          {data.owners.map((o) => (
            <a key={o.userId} className={chip(route.owner === o.userId)} {...linkProps({ ...route, owner: o.userId, card: undefined })} title={o.email}>
              <Avatar tone={o.userId} label={o.label} size="xs" userId={o.userId} />
              {o.label}
              <span className="chip-n">{o.cards}</span>
            </a>
          ))}
        </Row>
      )}
      <Row className="bd-frow" label="Область">
        <span className="si-label">Что</span>
        <a className={chip(!route.project)} {...linkProps({ ...route, project: undefined, card: undefined })}>Всё</a>
        {areas.map((a) => (
          <a key={a.id} className={chip(route.project === a.id)} {...linkProps({ ...route, project: a.id, card: undefined })} title={a.blurb}>
            {a.name}
          </a>
        ))}
        {projects.length > 1 && projects.map((p) => (
          <a key={p} className={chip(route.project === p, ' bd-chip-proj')} {...linkProps({ ...route, project: p, card: undefined })}>
            {p}
          </a>
        ))}
      </Row>
      <Row className="bd-frow" label="Период">
        <span className="si-label">За</span>
        {BOARD_SINCE_DAYS.map((d) => (
          <a key={d} className={chip(since === d)} {...linkProps({ ...route, since: d === BOARD_SINCE_DEFAULT ? undefined : d, card: undefined })}>
            {d} {pluralRu(d, ['день', 'дня', 'дней'])}
          </a>
        ))}
      </Row>
    </div>
  );
}

function ErrorNote({ error, retry }: { error: Error; retry: () => void }) {
  const status = error instanceof ApiError ? error.status : 0;
  const text =
    status === 404
      ? 'Хаб ещё не собирает доску — нужен хаб новее.'
      : status === 403
        ? 'Доска этой команды вам не показывается.'
        : `Не удалось загрузить доску: ${error.message}`;
  return (
    <div className="pj-error bd-error">
      {text}
      {status !== 403 && status !== 404 && (
        <button type="button" className="btn sm" onClick={retry}>Повторить</button>
      )}
    </div>
  );
}

function Empty({ route }: { route: BoardRoute }) {
  const filtered = Boolean(route.owner || route.project || route.since);
  return (
    <div className="placeholder bd-placeholder">
      <div>За {route.since ?? BOARD_SINCE_DEFAULT} {pluralRu(route.since ?? BOARD_SINCE_DEFAULT, ['день', 'дня', 'дней'])} карточек нет.</div>
      <div className="ph-sub">
        {(route.since ?? BOARD_SINCE_DEFAULT) < 30 && <a className="chip" {...linkProps({ ...route, since: 30, card: undefined })}>Показать 30 дней</a>}
        {filtered && <a className="chip" {...linkProps({ kind: 'board' })}>Снять фильтры</a>}
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="bd-cols bd-skel" aria-hidden="true">
      {SESSION_STAGES.map((s) => (
        <div key={s.id} className="bd-col">
          <div className="bd-col-head"><span className="eyebrow eyebrow--mark">{s.label}</span></div>
          <div className="bd-skel-card" />
          <div className="bd-skel-card" />
          <div className="bd-skel-card" />
        </div>
      ))}
    </div>
  );
}
