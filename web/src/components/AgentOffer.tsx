import { useState } from 'react';
import { connectShellAgent, declineShellAgent, type ShellAgent } from './useMachinePick.js';

/** «code.example.com» out of the hub origin the shell reports. */
function hubName(hub?: string): string {
  try { return hub ? new URL(hub).host : 'серверу'; } catch { return 'серверу'; }
}

/**
 * The desktop shell asks before it installs its agent on this computer. Shown
 * whenever the shell reports phase `offer` — on the first-run screen and on the
 * machines screen, whether or not other machines are online (a second computer
 * is asked exactly like the first). Nothing is installed without the click.
 */
export function AgentOffer({ shellAgent }: { shellAgent?: ShellAgent }) {
  const [noBridge, setNoBridge] = useState(false);
  if (shellAgent?.phase !== 'offer') return null;
  return (
    <div className="onb-offer team-card" role="group" aria-label="Подключить этот компьютер">
      <p className="onb-lead">
        Подключить этот компьютер к {hubName(shellAgent.hub)}? Приложение поставит на него агента — через него вы будете запускать Claude и Codex отсюда. Без вашего согласия ничего не ставится.
      </p>
      {noBridge && <p className="onb-lead attn-text">Подключите из меню в трее: «Подключить этот компьютер».</p>}
      <div className="onb-nav">
        <button className="btn primary" onClick={() => void connectShellAgent().then((ok) => setNoBridge(!ok))}>Подключить</button>
        <button className="btn" onClick={() => void declineShellAgent()}>Не подключать</button>
      </div>
    </div>
  );
}
