import { useCallback, useEffect, useState } from 'react';
import { Globe, Plus } from '../../icons.js';
import { relTimeRu } from '../../lib.js';
import { Panel } from '../../TeamViews.js';
import {
  type BrowserProfile,
  browserApi,
  browserError,
  openBrowser,
  useBrowserInfo,
  useBrowserSheet,
} from './browserApi.js';
import { askConfirm } from '../../dialogs.js';

/** browserd's cap (`MAX_PER_OWNER`); the hub answers 409 past it anyway. */
const MAX_PROFILES = 3;

const day = (sec: number) => {
  const d = new Date(sec * 1000);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('ru-RU', sameYear ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' });
};

/**
 * Настройки → Браузер: the person's cloud browsers — create, open in the
 * sheet, delete. Deleting erases the profile on the hub box, and with it
 * every login made in it; the confirm says exactly that.
 */
export function BrowserSettings() {
  const info = useBrowserInfo();
  const sheet = useBrowserSheet();
  const [profiles, setProfiles] = useState<BrowserProfile[] | null>(null);
  const [name, setName] = useState('Браузер');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(() => {
    browserApi
      .profiles()
      .then((list) => {
        setProfiles(list);
        setNote('');
      })
      .catch((e) => setNote(browserError(e)));
  }, []);

  // Again whenever the sheet closes: «последний раз» and «работает» moved.
  const sheetOpen = sheet !== null;
  useEffect(() => {
    if (info && !sheetOpen) load();
  }, [info, sheetOpen, load]);

  if (!info) {
    return (
      <Panel title="Браузер">
        <div className="team-empty">Облачный браузер вам пока недоступен.</div>
      </Panel>
    );
  }

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setNote('');
    browserApi
      .create(name.trim() || 'Браузер')
      .then((p) => {
        setProfiles((list) => [...(list ?? []), p]);
        setName('Браузер');
      })
      .catch((err) => setNote(browserError(err)))
      .finally(() => setBusy(false));
  };

  const remove = async (p: BrowserProfile) => {
    if (
      !(await askConfirm(
        `Удалить браузер «${p.name}»?\n\nСотрутся все входы, сделанные в нём: почта, кабинеты, соцсети. Сессии платформы больше не смогут в них работать, пока вы не войдёте заново в новом браузере.`,
        { confirmLabel: 'Удалить', danger: true },
      ))
    )
      return;
    browserApi
      .remove(p.id)
      .then(load)
      .catch((err) => setNote(browserError(err)));
  };

  const count = profiles?.length ?? 0;
  return (
    <Panel title="Браузер" subtitle="Свой браузер на сервере: войдите в сервисы один раз — дальше сессии платформы смогут работать в них от вашего имени.">
      {info.down ? (
        <div className="bs-attn" role="status">Сервис браузера недоступен</div>
      ) : !info.egress ? (
        <div className="bs-attn" role="status">Нет выхода в интернет (WARP) — страницы не откроются</div>
      ) : null}
      <section className="team-card">
        <h3>
          Мои браузеры
          {profiles && <span className="devices-count"> {count} / {MAX_PROFILES}</span>}
        </h3>
        {profiles === null ? (
          <div className="team-row static"><span><small>{note || 'Загружаю…'}</small></span></div>
        ) : profiles.length === 0 ? (
          <div className="team-row static"><span><small>Браузеров пока нет.</small></span></div>
        ) : (
          profiles.map((p) => (
            <div className="team-row static bs-prof" key={p.id}>
              <Globe size={17} />
              <span>
                <b>{p.name}</b>
                <small>
                  создан {day(p.created_at)} · открывали {relTimeRu(p.last_used_at * 1000)}
                  {p.running ? ' · запущен' : ''}
                </small>
              </span>
              <div className="bs-prof-actions">
                <button type="button" className="btn" onClick={() => openBrowser(p.id)}>
                  Открыть
                </button>
                <button type="button" className="btn danger" onClick={() => remove(p)}>
                  Удалить
                </button>
              </div>
            </div>
          ))
        )}
        {profiles && count < MAX_PROFILES && (
          <form className="team-form compact" onSubmit={create}>
            <input
              className="bs-field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              aria-label="Название браузера"
              placeholder="Название"
            />
            <button className="btn primary" disabled={busy}>
              <Plus size={14} /> Создать
            </button>
          </form>
        )}
      </section>
      {note && profiles && <div className="team-note">{note}</div>}
    </Panel>
  );
}
