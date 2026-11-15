import { memo, type MouseEvent } from 'react';
import type { BoardCard as Card } from '@cc-remote/shared';
import { linkProps } from '../../router.js';
import { relTimeRu } from '../../lib.js';
import { Avatar } from '../Avatar.js';
import { attentionText, evidenceMarks } from './boardModel.js';
import type { BoardRoute } from './useBoard.js';

/**
 * One task, as a non-technical reader sees it: what it is, how it is going,
 * whose it is, when it last moved, and three facts — committed, deployed,
 * checked — that no summary can talk its way past.
 *
 * A link, not a button: the drawer is an address (`?card=`), so ⌘-click and
 * «open in new tab» work, and Back closes it.
 */
export const BoardCard = memo(function BoardCard({
  card,
  route,
  open,
  onMenu,
}: {
  card: Card;
  route: BoardRoute;
  open: boolean;
  onMenu?: (card: Card, e: MouseEvent) => void;
}) {
  const att = attentionText(card.attention);
  const cls = ['bd-card', open ? 'here' : '', card.confidence < 0.5 ? 'faint' : '', card.stale ? 'stale' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <a
      className={cls}
      {...linkProps({ ...route, card: card.cardId })}
      onContextMenu={onMenu ? (e) => { e.preventDefault(); onMenu(card, e); } : undefined}
      aria-current={open ? 'true' : undefined}
    >
      <div className="bd-top">
        <span className="bd-title">{card.title}</span>
        {att && (
          <span className={`status-pill sm ${card.attention === 'blocked' ? 'error' : 'needs_attention'}`} title={card.attentionNote}>
            {att}
          </span>
        )}
      </div>
      {card.summary && <p className="bd-sum">{card.summary}</p>}
      <div className="bd-meta">
        {card.project && <span className="chip">{card.project}</span>}
        {card.owner && (
          <span className="bd-who" title={card.owner.fullName ?? card.owner.email ?? card.owner.label}>
            <Avatar tone={card.owner.userId} label={card.owner.label} size="xs" userId={card.owner.userId} />
            {card.owner.label}
          </span>
        )}
        <span className="bd-when" title={new Date(card.lastActivity).toLocaleString('ru-RU')}>
          {card.stale ? 'застряло · ' : ''}
          {relTimeRu(card.lastActivity)}
        </span>
      </div>
      <div className="bd-ev" aria-label="улики">
        {evidenceMarks(card).map((m) => (
          <span key={m.key} className={`bd-mark${m.on ? ' on' : ''}`} title={m.title}>
            <i />
            <span className="bd-mark-l">{m.label}</span>
          </span>
        ))}
        {card.manualOverride && <span className="bd-tag" title="статус поставлен рукой; сборщик его не трогает">вручную</span>}
        {card.confidence < 0.5 && <span className="bd-tag" title={`уверенность сборщика ${Math.round(card.confidence * 100)}%`}>предположительно</span>}
      </div>
    </a>
  );
});
