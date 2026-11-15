import { PhoneIcon } from '../icons.js';
import { DesktopApps } from '../TeamViews.js';
import { PhoneApps } from './PhoneApps.js';
import { desktopAppsOffered, usePublicConfig } from '../publicConfig.js';

/** Настройки → Приложения: the desktop client and the phone ones, side by side
 *  in one place (the same blocks the first-run screens use). */
export function AppsTab() {
  // A self-hosted hub serves no desktop builds (see ConnectMachine).
  const config = usePublicConfig();
  const external = !desktopAppsOffered(config);
  return (
    <div className="board apps-board">
      <div className="board-head">
        <PhoneIcon size={20} />
        <h2>Приложения</h2>
      </div>
      <div className="apps-stack">
        {!external && <DesktopApps />}
        {external && config && (
          <p className="team-help">Приложение для Mac и Windows этот сервер не раздаёт — компьютер подключается командой /go на вкладке «Машины».</p>
        )}
        <section className="team-card settings-section">
          <h3>Телефон</h3>
          <PhoneApps />
        </section>
      </div>
    </div>
  );
}
