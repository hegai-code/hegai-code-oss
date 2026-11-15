import { useEffect } from 'react';
import { Command } from 'cmdk';
import { Search, RefreshCw, MessageSquare, Cpu, Circle } from './icons.js';
import type { CentralState } from './useCentral.js';
import { attentionLabel, scopeKeeps, sessionIsMine } from './lib.js';
import { runIsMine, useSessionScope } from './components/MineOnly.js';

interface Props {
  central: CentralState;
  open: boolean;
  onClose: () => void;
  onJump: (machineId: string, sessionId: string) => void;
}

/**
 * ⌘K palette: fuzzy jump to any session across every connected machine, plus a
 * few global actions. cmdk does the matching; we feed each item a rich `value`.
 *
 * The session scope («Мои · Команда · Все», MineOnly.tsx) applies here too. The palette is a jump list, not an overview:
 * offering a teammate's thread to someone who has said they do not want to see
 * other people's work is the same leak the lenses fixed, one keystroke closer.
 * Both halves obey it — the runs group as well as the per-machine lists —
 * because a run IS a session, seen from the other side.
 */
export function CommandPalette({ central, open, onClose, onJump }: Props) {
  const [scope] = useSessionScope();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const viewerId = central.viewer?.userId;
  const machineById = new Map(central.machines.map((m) => [m.machine.machineId, m]));
  const machineName = (id: string) => machineById.get(id)?.machine.name ?? id;

  const runs = central.activeRuns.filter((r) => scopeKeeps(scope, runIsMine(r, machineById, viewerId)));

  return (
    <div className="cmdk-backdrop" onMouseDown={onClose}>
      <div onMouseDown={(e) => e.stopPropagation()}>
        <Command className="cmdk" label="Меню команд" loop>
          <div className="cmdk-input-row">
            <Search size={18} />
            <Command.Input autoFocus placeholder="Перейти к сессии или выполнить команду…" />
          </div>
          <Command.List>
            <Command.Empty>Ничего не нашлось.</Command.Empty>

            <Command.Group heading="Действия">
              {/* «Открыть доску» used to lead this group. The board is gone —
                  it was the active sessions grouped by where they run, which
                  the context column already shows — and the runs group further
                  down this same palette is the faster way to that question. */}
              <Command.Item
                value="rescan refresh all machines inventory обновить пересканировать машины"
                onSelect={() => {
                  central.machines.forEach((m) => central.rescan(m.machine.machineId));
                  onClose();
                }}
              >
                <RefreshCw size={16} />
                <div className="cmdk-item-main">
                  <div className="cmdk-item-title">Пересканировать все машины</div>
                </div>
              </Command.Item>
            </Command.Group>

            {runs.length > 0 && (
              <Command.Group heading="Идут сейчас">
                {runs.map((r) => (
                  <Command.Item
                    key={r.runId}
                    value={`run ${r.title ?? ''} ${r.project ?? ''} ${r.machineName ?? ''} ${r.sessionId}`}
                    onSelect={() => {
                      onJump(r.machineId, r.sessionId);
                      onClose();
                    }}
                  >
                    <Circle size={9} className={`attn-${r.state}`} fill="currentColor" />
                    <div className="cmdk-item-main">
                      <div className="cmdk-item-title">{r.title ?? r.sessionId.slice(0, 8)}</div>
                      <div className="cmdk-item-sub">
                        {r.machineName ?? machineName(r.machineId)}
                        {r.project ? ` · ${r.project}` : ''} · {r.state === 'working' ? 'работает' : r.state === 'needs_attention' ? attentionLabel(r) : r.state === 'error' ? 'ошибка' : 'ждёт'}
                      </div>
                    </div>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {central.machines.map((m) => {
              const sessions = m.sessions.filter((s) => scopeKeeps(scope, sessionIsMine(s, m, viewerId)));
              // A machine whose every session belongs to someone else drops out
              // entirely: an empty heading under a filter reads as "loading".
              if (sessions.length === 0) return null;
              return (
                <Command.Group key={m.machine.machineId} heading={m.machine.name}>
                  {sessions.slice(0, 60).map((s) => (
                    <Command.Item
                      key={s.sessionId}
                      value={`${s.title} ${s.project ?? ''} ${m.machine.name} ${s.sessionId}`}
                      onSelect={() => {
                        onJump(m.machine.machineId, s.sessionId);
                        onClose();
                      }}
                    >
                      {s.livePid ? <Cpu size={16} /> : <MessageSquare size={16} />}
                      <div className="cmdk-item-main">
                        <div className="cmdk-item-title">{s.title}</div>
                        <div className="cmdk-item-sub">
                          {m.machine.name}
                          {s.project ? ` · ${s.project}` : ''}
                          {s.livePid ? ' · запущена' : ''}
                        </div>
                      </div>
                    </Command.Item>
                  ))}
                </Command.Group>
              );
            })}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
