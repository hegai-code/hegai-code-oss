import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReportList, ReportMeta } from '@cc-remote/shared';
import { linkProps, navigate, type Route } from '../../router.js';
import { fileSizeLabel, pluralRu, relTimeRu } from '../../lib.js';
import { ArrowLeft, Check, CopyIcon, FileText, Folder, Plus, RefreshCw, Trash2 } from '../../icons.js';
import { ApiError, apiJson } from '../../api.js';
import { askConfirm, askText, showNotice } from '../../dialogs.js';

export type ReportsRoute = Extract<Route, { kind: 'reports' }>;

/**
 * «Отчёты» — pages a session published to the hub so they open by link: an
 * infrastructure audit, a review, a research write-up. `/w/reports` lists them,
 * `/w/reports/<id>` shows one full-size.
 *
 * The page runs in an iframe whose document the hub serves under a CSP
 * `sandbox` without `allow-same-origin` (`reports.rs`), so its scripts never
 * act as code.acme.test — the iframe's own `sandbox` attribute repeats that.
 * There is deliberately no «open alone»: the hub sends a top-level visit to
 * `/content` back here, so a report is always seen under the app's own head,
 * never as a bare page on the hub's URL that could imitate a sign-in. Who sees which report is the hub's
 * decision (author + platform admins); a 404 here is «not yours or gone».
 */
const ROOT_NAME = 'Hegai Code';
const FOLDER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FOLDER_KEY = 'reports.folder';
const folderName = (f: string) => (f === '' ? ROOT_NAME : f);

/** Folders with counts: Hegai Code first, then by report count desc. */
function folderCounts(reports: ReportMeta[]): { folder: string; count: number; latest: number }[] {
  const m = new Map<string, { folder: string; count: number; latest: number }>();
  for (const r of reports) {
    const e = m.get(r.folder) ?? { folder: r.folder, count: 0, latest: 0 };
    e.count += 1;
    e.latest = Math.max(e.latest, r.updatedAt);
    m.set(r.folder, e);
  }
  return [...m.values()];
}

export function Reports({ route }: { route: ReportsRoute }) {
  return route.id ? <ReportView id={route.id} /> : <ReportIndex />;
}

function ReportIndex() {
  const [data, setData] = useState<ReportList | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(FOLDER_KEY);
    } catch {
      return null;
    }
  });
  const pick = (f: string | null) => {
    setPicked(f);
    try {
      if (f === null) window.localStorage.removeItem(FOLDER_KEY);
      else window.localStorage.setItem(FOLDER_KEY, f);
    } catch {
      /* private mode: the choice just doesn't stick */
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(ReportList.parse(await apiJson<unknown>('/api/reports')));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const reports = data?.reports ?? [];
  const folders = useMemo(
    () => folderCounts(reports).sort((a, b) => (a.folder === '' ? -1 : b.folder === '' ? 1 : b.count - a.count || a.folder.localeCompare(b.folder))),
    [reports],
  );
  // A remembered folder that no longer has reports falls back to «Все».
  const active = picked !== null && folders.some((f) => f.folder === picked) ? picked : null;
  const shown = active === null ? reports : reports.filter((r) => r.folder === active);
  const groups = active === null ? [...folders].sort((a, b) => (a.folder === '' ? -1 : b.folder === '' ? 1 : b.latest - a.latest)) : [];
  const row = (r: ReportMeta) => (
    <li key={r.id}>
      <a className="rep-row" {...linkProps({ kind: 'reports', id: r.id })}>
        <span className="rep-title">{r.title}</span>
        {r.description && <span className="rep-desc">{r.description}</span>}
        <span className="rep-meta">
          {r.ownerName || r.ownerEmail} · {relTimeRu(r.updatedAt)} · {fileSizeLabel(r.sizeBytes)}
        </span>
      </a>
    </li>
  );
  return (
    <div className="board rep">
      <div className="board-head">
        <FileText size={20} />
        <h2>Отчёты</h2>
        <span className="sub">{data ? `${reports.length} ${pluralRu(reports.length, ['отчёт', 'отчёта', 'отчётов'])}` : ''}</span>
        <button type="button" className="icon-btn" onClick={() => void load()} aria-label="Обновить" title="Обновить" disabled={loading}>
          <RefreshCw size={16} className={loading ? 'spin' : ''} />
        </button>
      </div>
      {error && <ErrorNote error={error} retry={() => void load()} />}
      {!error && data && reports.length === 0 && (
        <div className="placeholder">
          <div>Отчётов пока нет.</div>
          <div className="ph-sub">
            Сессия публикует отчёт командой <code>hegai-fleet report publish файл.html --title «…»</code> и
            получает ссылку сюда. Отчёт видят автор и администраторы.
          </div>
        </div>
      )}
      {reports.length > 0 && (
        <div className="rep-chips" role="tablist" aria-label="Папки">
          <button type="button" role="tab" aria-selected={active === null} className={`rep-chip${active === null ? ' on' : ''}`} onClick={() => pick(null)}>
            Все <span className="rep-chip-n">{reports.length}</span>
          </button>
          {folders.map((f) => (
            <button key={f.folder} type="button" role="tab" aria-selected={active === f.folder} className={`rep-chip${active === f.folder ? ' on' : ''}`} onClick={() => pick(f.folder)}>
              {folderName(f.folder)} <span className="rep-chip-n">{f.count}</span>
            </button>
          ))}
        </div>
      )}
      {reports.length > 0 && active !== null && <ul className="rep-list">{shown.map(row)}</ul>}
      {reports.length > 0 && active === null &&
        groups.map((g) => (
          <section key={g.folder} className="rep-group">
            <h3 className="rep-group-title">{folderName(g.folder)}</h3>
            <ul className="rep-list">{reports.filter((r) => r.folder === g.folder).map(row)}</ul>
          </section>
        ))}
    </div>
  );
}

function ReportView({ id }: { id: string }) {
  const [meta, setMeta] = useState<ReportMeta | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [copied, setCopied] = useState(false);

  // `alive` drops a late answer for the report we already left: its title in
  // the head would otherwise sit over another report's frame, and «Удалить»
  // would name one report and delete the other.
  const load = useCallback(
    async (alive: () => boolean = () => true) => {
      try {
        const m = ReportMeta.parse(await apiJson<unknown>(`/api/reports/${id}`));
        if (!alive()) return;
        setMeta(m);
        setError(null);
      } catch (e) {
        if (alive()) setError(e instanceof Error ? e : new Error(String(e)));
      }
    },
    [id],
  );

  useEffect(() => {
    let live = true;
    setMeta(null);
    setError(null);
    void load(() => live);
    return () => {
      live = false;
    };
  }, [load]);

  const link = `${window.location.origin}/w/reports/${id}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      void askText('Ссылка на отчёт', link);
    }
  };
  const remove = async () => {
    if (!meta || meta.id !== id || !(await askConfirm(`Удалить отчёт «${meta.title}»? Ссылка перестанет открываться.`, { confirmLabel: 'Удалить', danger: true }))) return;
    const raw = await fetch(`/api/reports/${id}`, { method: 'DELETE', credentials: 'same-origin' });
    if (raw.ok) {
      navigate({ kind: 'reports' });
    } else {
      const body = (await raw.json().catch(() => ({}))) as { error?: string };
      void showNotice(`Не удалось удалить: ${body.error ?? raw.status}`);
    }
  };

  return (
    <div className="rep-view">
      <div className="board-head rep-head">
        <a className="icon-btn" {...linkProps({ kind: 'reports' })} aria-label="Все отчёты" title="Все отчёты">
          <ArrowLeft size={16} />
        </a>
        <h2 className="rep-view-title">{meta?.title ?? 'Отчёт'}</h2>
        {meta && <span className="sub">{relTimeRu(meta.updatedAt)}</span>}
        <span className="rep-spacer" />
        <button type="button" className="icon-btn" onClick={() => void copy()} aria-label="Скопировать ссылку" title={copied ? 'Скопировано' : 'Скопировать ссылку'}>
          <CopyIcon size={16} />
        </button>
        {meta && <FolderMenu meta={meta} onMoved={setMeta} />}
        {meta && (
          <button type="button" className="icon-btn" onClick={() => void remove()} aria-label="Удалить отчёт" title="Удалить отчёт">
            <Trash2 size={16} />
          </button>
        )}
      </div>
      {copied && <div className="rep-toast" role="status">Ссылка скопирована</div>}
      {error ? (
        <ErrorNote error={error} retry={() => void load()} />
      ) : (
        <iframe
          className="rep-frame"
          title={meta?.title ?? 'Отчёт'}
          src={`/api/reports/${id}/content`}
          sandbox="allow-scripts allow-popups"
          referrerPolicy="no-referrer"
        />
      )}
    </div>
  );
}

/** The head's folder button: pick an existing folder or make a new one. */
function FolderMenu({ meta, onMoved }: { meta: ReportMeta; onMoved: (m: ReportMeta) => void }) {
  const [open, setOpen] = useState(false);
  const [names, setNames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void apiJson<unknown>('/api/reports')
      .then((raw) => {
        if (!live) return;
        const counts = folderCounts(ReportList.parse(raw).reports).sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder));
        setNames(counts.map((c) => c.folder).filter((f) => f !== ''));
      })
      .catch(() => {});
    const away = (e: Event) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      live = false;
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const move = async (folder: string) => {
    setOpen(false);
    if (folder === meta.folder || busy) return;
    setBusy(true);
    try {
      const m = ReportMeta.parse(
        await apiJson<unknown>(`/api/reports/${meta.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder }) }),
      );
      onMoved(m);
    } catch (e) {
      void showNotice(`Не удалось переместить: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    const raw = await askText('Название новой папки (латиница, цифры, . _ -)', '');
    if (raw === null) return;
    const name = raw.trim();
    if (!FOLDER_RE.test(name)) {
      void showNotice('Папка: строчные латинские буквы и цифры, затем ещё . _ -, до 64 знаков; начинается с буквы или цифры.');
      return;
    }
    void move(name);
  };
  const all = names.includes(meta.folder) || meta.folder === '' ? names : [...names, meta.folder];

  return (
    <div className="rep-folder" ref={box}>
      <button type="button" className="icon-btn" onClick={() => setOpen((o) => !o)} aria-label="Папка отчёта" aria-haspopup="menu" aria-expanded={open} title={`Папка: ${folderName(meta.folder)}`} disabled={busy}>
        <Folder size={16} />
      </button>
      {open && (
        <div className="rep-menu" role="menu">
          {[ '', ...all ].map((f) => (
            <button key={f || '·root'} type="button" role="menuitemradio" aria-checked={f === meta.folder} className="rep-menu-item" onClick={() => void move(f)}>
              <span className="rep-menu-name">{folderName(f)}</span>
              {f === meta.folder && <Check size={14} />}
            </button>
          ))}
          <button type="button" role="menuitem" className="rep-menu-item new" onClick={create}>
            <Plus size={14} />
            <span className="rep-menu-name">Новая папка…</span>
          </button>
        </div>
      )}
    </div>
  );
}

function ErrorNote({ error, retry }: { error: Error; retry: () => void }) {
  const status = error instanceof ApiError ? error.status : 0;
  const text =
    status === 404
      ? 'Отчёт не найден: его удалили, или он не ваш.'
      : status === 403
        ? 'Отчёты вам пока не показываются.'
        : `Не удалось загрузить: ${error.message}`;
  return (
    <div className="pj-error">
      {text}
      {status !== 403 && status !== 404 && (
        <button type="button" className="btn sm" onClick={retry}>Повторить</button>
      )}
    </div>
  );
}
