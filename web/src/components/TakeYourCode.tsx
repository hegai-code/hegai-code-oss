import { useState } from 'react';
import { ArrowSquareOut, X } from '../icons.js';
import { linkProps } from '../router.js';

/** The project the panel talks about. */
export interface TakeTarget {
  machineId: string;
  machineName: string;
  cwd: string;
  label: string;
}

/** The first turn «Отправить в свой репозиторий» starts with. No new RPC:
 *  the agent already knows git, and asking for a token is the session's job,
 *  not a form's. */
export function pushPrompt(url: string): string {
  return `Добавь remote origin ${url} и запушь ветку main. Если понадобится токен — спроси меня, не подставляй ничего сам.`;
}

/**
 * «Забрать своё» — the exit, kept in view.
 *
 * A project on a hosted machine is still the person's; this panel is where
 * that stops being a sentence and becomes four doors: push it to their own
 * remote (a session does it, in the open), connect their own machine, read
 * what the product remembers about them, and — when the sandbox itself is
 * no longer wanted — a person to write to. It is reachable from Home, from a
 * project card's menu and from the budget card, because the moment someone
 * looks for the exit is not the moment to make them hunt for it.
 */
export function TakeYourCode({
  target,
  onPush,
  onClose,
}: {
  target: TakeTarget;
  /** Starts a new session in the project with the push prompt as its first turn. */
  onPush: (machineId: string, cwd: string, prompt: string) => void;
  onClose?: () => void;
}) {
  const [url, setUrl] = useState('');
  const ok = /^(https:\/\/|git@)\S+$/.test(url.trim());
  const push = () => {
    if (!ok) return;
    onPush(target.machineId, target.cwd, pushPrompt(url.trim()));
    setUrl('');
    onClose?.();
  };
  return (
    <div className="take" role="region" aria-label="Забрать своё">
      <div className="take-head">
        <span className="take-title">Забрать своё</span>
        {onClose && (
          <button className="icon-btn take-close" onClick={onClose} title="Закрыть" aria-label="Закрыть">
            <X size={15} />
          </button>
        )}
      </div>
      <p className="take-lead">
        Проект живёт в <code>{target.cwd}</code> на <code>{target.machineName || target.machineId}</code>.
        Он ваш; способы забрать:
      </p>
      <ol className="take-list">
        <li>
          <b>Отправить в свой репозиторий.</b>
          <div className="take-push">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  push();
                }
              }}
              placeholder="https://github.com/you/project.git"
              spellCheck={false}
              aria-label="Адрес репозитория"
            />
            <button className="btn primary" disabled={!ok} onClick={push} title="Откроет сессию с просьбой запушить">
              Начать сессию
            </button>
          </div>
          <small>Сессия добавит remote и запушит main; токен спросит у тебя, сама ничего не подставит.</small>
        </li>
        <li>
          <b>
            <a {...linkProps({ kind: 'settings', tab: 'hardware' })}>
              Подключить свою машину и клонировать оттуда <ArrowSquareOut size={13} />
            </a>
          </b>
          <small>Настройки → Машины → «Подключить ещё машину». Дальше обычный <code>git clone</code>.</small>
        </li>
        <li>
          <b>
            <a {...linkProps({ kind: 'settings', tab: 'overview' })}>
              Что Hegai Code помнит о тебе (Аккаунт → «Что помнит хаб») <ArrowSquareOut size={13} />
            </a>
          </b>
          <small>Прочитать, поправить, стереть.</small>
        </li>
        <li>
          <b>Песочницу можно удалить</b>
          <small>— напишите Владельцу; код к тому моменту уже у вас.</small>
        </li>
      </ol>
    </div>
  );
}
