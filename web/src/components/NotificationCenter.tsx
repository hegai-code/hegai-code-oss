import { Bell, Check, X } from '../icons.js';
import type { CentralState } from '../useCentral.js';
import { attentionLabel, relTime } from '../lib.js';
import type { NotifItem } from '../central-reducers.js';

export function NotificationCenter({
  central,
  onJump,
  onClose,
}: {
  central: CentralState;
  onJump: (machineId: string, sessionId: string) => void;
  onClose: () => void;
}) {
  const icon = (state: string) =>
    state === 'idle' ? <Check size={16} /> : state === 'error' ? <X size={16} /> : <Bell size={16} />;
  // The same words the rest of the app uses — «ждёт ответа» and «ждёт
  // подтверждения» are different things to go and do.
  const label = (n: NotifItem) =>
    n.state === 'needs_attention'
      ? attentionLabel(n) + (n.pendingKind === 'permission' && n.pendingTool ? `: ${n.pendingTool}` : '')
      : n.state === 'error'
        ? 'ход завершился ошибкой'
        : 'готова';

  return (
    <>
      <div className="notif-scrim" onClick={onClose} />
      <div className="notif-pop" onClick={(e) => e.stopPropagation()}>
        <div className="notif-head">
          <Bell size={15} />
          <h3>Уведомления</h3>
          {central.notifications.length > 0 && (
            <button className="link clear" onClick={() => central.clearNotifications()}>
              Очистить
            </button>
          )}
        </div>
        <div className="notif-list">
          {central.notifications.length === 0 && (
            <div className="notif-empty">Новых событий нет.</div>
          )}
          {central.notifications.map((n) => (
            <div
              key={n.id}
              className={`notif-item ${n.state}`}
              onClick={() => {
                onJump(n.machineId, n.sessionId);
                onClose();
              }}
            >
              <span className="ni-icon">{icon(n.state)}</span>
              <div>
                <div className="ni-title">{n.title}</div>
                <div className="ni-sub">
                  {n.machineName ? `${n.machineName} · ` : ''}{label(n)}
                </div>
              </div>
              <span className="ni-time">{relTime(n.ts)}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
