import { useEffect, useState } from 'react';
import { SESSION_STAGES, type BoardCard, type BoardCardPatch } from '@cc-remote/shared';
import { linkProps } from '../../router.js';
import { pluralRu, relTimeRu } from '../../lib.js';
import { Check, EditIcon, X } from '../../icons.js';
import { AgentMark } from '../AgentMark.js';
import { Avatar } from '../Avatar.js';
import { evidenceMarks, STATUS_LABEL } from './boardModel.js';

/**
 * One card, opened. The summary at reading size, the facts, the sessions it
 * came from (each a link into the transcript), and the hand controls: move to
 * a column, flag it as waiting on someone, rename the CARD (not the session —
 * the label says so, because the two are different things).
 *
 * A right column on a wide screen, a bottom sheet under 1200px — the same
 * split `.si-sheet` makes for the session info. Escape and the scrim close it.
 */
export function CardDrawer({
  card,
  onClose,
  onPatch,
  providerOf,
}: {
  card: BoardCard;
  onClose: () => void;
  onPatch: (cardId: string, patch: BoardCardPatch) => void;
  providerOf?: (machineId: string, sessionId: string) => string | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(card.title);
  useEffect(() => {
    setTitle(card.title);
    setEditing(false);
  }, [card.cardId, card.title]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const saveTitle = () => {
    const t = title.trim();
    if (t && t !== card.title) onPatch(card.cardId, { title: t });
    setEditing(false);
  };
  const latest = card.sessions[0];
  const e = card.evidence;

  return (
    <>
      <div className="bd-scrim" onClick={onClose} />
      <aside className="bd-drawer" aria-label="карточка">
        <div className="bd-dr-head">
          <span className="eyebrow eyebrow--mark">Карточка</span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <X size={16} />
          </button>
        </div>

        {editing ? (
          <div className="bd-dr-edit">
            <label className="si-label" htmlFor="bd-title">Название карточки</label>
            <input
              id="bd-title"
              className="token"
              value={title}
              maxLength={120}
              autoFocus
              onChange={(ev) => setTitle(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') saveTitle();
                if (ev.key === 'Escape') { ev.stopPropagation(); setEditing(false); setTitle(card.title); }
              }}
            />
            <button type="button" className="btn sm primary" onClick={saveTitle}><Check size={14} /> Сохранить</button>
          </div>
        ) : (
          <h3 className="bd-dr-title">
            {card.title}
            <button type="button" className="icon-btn" onClick={() => setEditing(true)} aria-label="Переименовать карточку" title="Название карточки">
              <EditIcon size={14} />
            </button>
          </h3>
        )}

        <p className="bd-dr-sum">{card.summary || 'Сборщик ещё не описал эту задачу.'}</p>
        {card.attention !== 'none' && card.attentionNote && (
          <p className={`bd-dr-note ${card.attention}`}>{card.attentionNote}</p>
        )}
        {card.doneWhen && card.status !== 'done' && (
          <p className="bd-dr-when"><span className="si-label">Готово, когда</span> {card.doneWhen}</p>
        )}

        <div className="si-rows">
          <div className="si-row"><span className="si-label">Проект</span><span className="si-value">{card.project || '—'}</span></div>
          {card.owner && (
            <div className="si-row">
              <span className="si-label">Кто</span>
              <span className="si-value"><Avatar tone={card.owner.userId} label={card.owner.label} size="xs" userId={card.owner.userId} />{card.owner.fullName ?? card.owner.label}</span>
            </div>
          )}
          <div className="si-row"><span className="si-label">Машины</span><span className="si-value">{card.machines.map((m) => m.name).join(', ') || '—'}</span></div>
          <div className="si-row"><span className="si-label">Первый след</span><span className="si-value">{relTimeRu(card.firstSeen)}</span></div>
          <div className="si-row"><span className="si-label">Последняя активность</span><span className="si-value">{relTimeRu(card.lastActivity)}</span></div>
          {card.doneAt && <div className="si-row"><span className="si-label">Закрыто</span><span className="si-value">{relTimeRu(card.doneAt)}</span></div>}
          <div className="si-row">
            <span className="si-label">Улики</span>
            <span className="si-value bd-dr-ev">
              {evidenceMarks(card).map((m) => (
                <span key={m.key} className={`bd-mark${m.on ? ' on' : ''}`} title={m.title}><i /><span className="bd-mark-l">{m.label}</span></span>
              ))}
              <span className="bd-tag">{e.editedFiles} {pluralRu(e.editedFiles, ['правка', 'правки', 'правок'])} · {e.humanTurns} {pluralRu(e.humanTurns, ['реплика', 'реплики', 'реплик'])}</span>
            </span>
          </div>
        </div>

        <div className="bd-dr-sec">
          <span className="si-label">Перенести в</span>
          <div className="bd-dr-stages">
            {SESSION_STAGES.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`ghost${card.status === s.id ? ' on' : ''}`}
                disabled={card.status === s.id}
                onClick={() => onPatch(card.cardId, { status: s.id })}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="bd-dr-flags">
            <button
              type="button"
              className={`ghost${card.attention === 'question' ? ' attn' : ''}`}
              onClick={() => onPatch(card.cardId, { attention: card.attention === 'question' ? 'none' : 'question' })}
            >
              Нужен ответ
            </button>
            <button
              type="button"
              className={`ghost${card.attention === 'blocked' ? ' stop' : ''}`}
              onClick={() => onPatch(card.cardId, { attention: card.attention === 'blocked' ? 'none' : 'blocked' })}
            >
              Заблокировано
            </button>
          </div>
          {card.manualOverride && <p className="bd-dr-hint">Статус поставлен рукой — сборщик его больше не меняет.</p>}
        </div>

        <div className="bd-dr-sec">
          <span className="si-label">Сессии · {card.sessions.length}</span>
          <ul className="bd-dr-sess">
            {card.sessions.map((s) => (
              <li key={`${s.machineId}:${s.sessionId}`}>
                <a {...linkProps({ kind: 'session', machineId: s.machineId, sessionId: s.sessionId })}>
                  <AgentMark source={s.source} provider={providerOf?.(s.machineId, s.sessionId)} size={13} />
                  <span className="bd-dr-sess-t">{s.title || s.sessionId.slice(0, 8)}</span>
                  <span className="bd-when">{relTimeRu(s.lastModified)}</span>
                </a>
              </li>
            ))}
          </ul>
          {latest && (
            <a className="btn primary bd-dr-open" {...linkProps({ kind: 'session', machineId: latest.machineId, sessionId: latest.sessionId })}>
              Открыть последнюю сессию
            </a>
          )}
        </div>

        {card.events.length > 0 && (
          <div className="bd-dr-sec">
            <span className="si-label">История</span>
            <ul className="bd-dr-hist">
              {card.events.map((ev, i) => (
                <li key={i}>
                  <span className="bd-when">{relTimeRu(ev.at)}</span>
                  <span>
                    {ev.actor === 'assembler' ? 'сборщик' : 'рукой'}: {eventText(ev.kind, ev.from, ev.to)}
                    {ev.reason ? ` — ${ev.reason}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>
    </>
  );
}

function eventText(kind: string, from?: string, to?: string): string {
  const st = (v?: string) => (v && v in STATUS_LABEL ? STATUS_LABEL[v as keyof typeof STATUS_LABEL] : v ?? '');
  switch (kind) {
    case 'created': return `карточка создана${to ? ` в «${st(to)}»` : ''}`;
    case 'status': return `${st(from)} → ${st(to)}`;
    case 'reopen': return `открыта заново → ${st(to)}`;
    case 'attention': return `внимание: ${from ?? '—'} → ${to ?? '—'}`;
    case 'title': return 'переименована';
    case 'link': return 'добавлена сессия';
    case 'archive': return to === 'true' ? 'убрана с доски' : 'возвращена на доску';
    default: return kind;
  }
}
