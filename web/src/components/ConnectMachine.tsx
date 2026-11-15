import { useState } from 'react';
import { DownloadIcon } from '../icons.js';
import { APP_INSTALL_COMMAND, GO_COMMAND, guessHostOs, hubAddress, type HostOs } from '../lib.js';
import { CopyButton } from './CopyButton.js';
import { desktopAppsOffered, usePublicConfig } from '../publicConfig.js';

/**
 * «Подключить машину»: ONE switch (macOS · Windows · Linux, by user agent) and
 * one answer per OS.
 *
 * macOS / Windows: the desktop app command — the app installs the agent itself
 * — and, folded under it, «Только агент, без приложения»: the `/go` one-liner
 * (`go.ps1` on Windows). Linux has no app, so it gets `/go` straight away.
 * `/go` prints a short code that the person confirms on `/link`; it needs no
 * code minted in advance. The enrollment-code flow is still served by the hub
 * (the public landing uses it) but nothing signed-in needs it.
 *
 * A self-hosted hub (external edition) gets `/go` on every OS: it does not
 * serve the desktop builds (`/dl/HegaiCode-*`), and the packaged app points at
 * code.acme.test, so offering it there connects people to the wrong hub.
 */
function Command({ command, label }: { command: string; label: string }) {
  return (
    <>
      <pre className="install-command">{command}</pre>
      <div className="go-foot">
        <CopyButton className="btn" text={command} label={label}><DownloadIcon size={15} /></CopyButton>
      </div>
    </>
  );
}

export function ConnectMachine() {
  const [os, setOs] = useState<HostOs>(guessHostOs);
  const hub = hubAddress();
  const go = GO_COMMAND[os === 'win' ? 'win' : 'unix'](hub.origin);
  // Only our own hub serves the desktop builds; unknown (config not loaded or
  // failed) counts as «not ours», since offering the app there is the worse error.
  const agentOnly = !desktopAppsOffered(usePublicConfig());
  const agentNote = <p className="team-help">Агент покажет код — подтвердите его на <a href="/link">{hub.host}/link</a>.</p>;
  return (
    <div className="go-block">
      <div className="install-os-tabs" role="group" aria-label="Операционная система">
        <button className={os === 'mac' ? 'active' : ''} aria-pressed={os === 'mac'} onClick={() => setOs('mac')}>macOS</button>
        <button className={os === 'win' ? 'active' : ''} aria-pressed={os === 'win'} onClick={() => setOs('win')}>Windows</button>
        <button className={os === 'linux' ? 'active' : ''} aria-pressed={os === 'linux'} onClick={() => setOs('linux')}>Linux</button>
      </div>
      {os === 'linux' || agentOnly ? (
        <>
          <p className="team-help">{os === 'linux'
            ? 'Для Linux приложения нет — агент и эта вкладка.'
            : 'Одна команда в терминале этой машины — агент встанет в ваш профиль, без прав администратора.'}</p>
          <Command command={go} label="Скопировать" />
          {agentNote}
        </>
      ) : (
        <>
          <p className="team-help">Приложение само поставит агента и подключит этот компьютер.</p>
          <Command command={APP_INSTALL_COMMAND[os](hub.origin)} label="Скопировать команду" />
          <details className="onb-more">
            <summary>Только агент, без приложения (сервер)</summary>
            <div className="go-block">
              <Command command={go} label="Скопировать" />
              {agentNote}
            </div>
          </details>
        </>
      )}
    </div>
  );
}
