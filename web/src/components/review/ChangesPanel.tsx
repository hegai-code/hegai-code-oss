import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GitDiffFile, GitStatusResult } from '@cc-remote/shared';
import type { CentralState } from '../../useCentral.js';
import { GitBranch, RefreshCw } from '../../icons.js';
import { buildReviewMessage, type ReviewComment } from './reviewText.js';

type Diff = { files: GitDiffFile[]; truncated: boolean };
type Mode = 'head' | 'base';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * «Изменения»: what the agent left in this session's folder, read like a pull
 * request. File list with +/-, a unified diff per file, a click on any line
 * leaves a note there, and the notes go back to the agent as ONE message.
 * The commit / push / pull-request row under the heading is the way out.
 */
export function ChangesPanel({
  central,
  machineId,
  cwd,
  settledKey,
  onSendReview,
  canDrive,
  canPublish,
  sessionId,
}: {
  central: CentralState;
  machineId: string;
  cwd: string;
  /** Changes when the agent finishes a turn — a re-read is due. */
  settledKey: string;
  /** Hand the review to the session; false = the socket did not take it. */
  onSendReview: (text: string) => boolean;
  canDrive: boolean;
  /** Push / PR go out under the device owner's git credentials (hub: owner only). */
  canPublish: boolean;
  /** The session being reviewed: a commit from here is reported as its commit. */
  sessionId?: string;
}) {
  const rpc = central.rpc;
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [mode, setMode] = useState<Mode>('head');
  const [bases, setBases] = useState<string[]>([]);
  const [base, setBase] = useState('');
  const [diff, setDiff] = useState<Diff | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [comments, setComments] = useState<ReviewComment[]>([]);
  // The line a note is being typed on: `path|line|removed`.
  const [draftAt, setDraftAt] = useState<string | null>(null);
  const [draftText, setDraftText] = useState('');
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState<{ text: string; url?: string; bad?: boolean } | null>(null);

  const branch = status?.branch;

  // Only the latest request may land: switching mode/base quickly must not let
  // an older diff overwrite the one the controls show.
  const generation = useRef(0);
  const load = useCallback(() => {
    const gen = ++generation.current;
    setLoading(true);
    setError('');
    const diffParams: Record<string, unknown> = { cwd };
    if (mode === 'base' && base) diffParams['base'] = base;
    // Status first: a folder that is not a repository gets its own answer,
    // not a failed diff call.
    rpc<GitStatusResult>(machineId, 'git.status', { cwd }, true)
      .then(async (st) => {
        const empty: Diff = { files: [], truncated: false };
        return [st, st.isRepo ? await rpc<Diff>(machineId, 'git.diff', diffParams, true) : empty] as const;
      })
      .then(([st, d]) => {
        if (gen !== generation.current) return;
        setStatus(st);
        setDiff(d);
        // Small diffs open; a long list starts folded so the page is a list.
        setOpen((prev) => (Object.keys(prev).length ? prev : Object.fromEntries(d.files.slice(0, d.files.length > 6 ? 0 : 6).map((f) => [f.path, true]))));
      })
      .catch((e) => {
        if (gen === generation.current) setError(errMsg(e));
      })
      .finally(() => {
        if (gen === generation.current) setLoading(false);
      });
  }, [rpc, machineId, cwd, mode, base]);

  useEffect(() => {
    rpc<{ current: string; all: string[] }>(machineId, 'git.branches', { cwd }, true)
      .then((b) => {
        setBases(b.all.filter((x) => x !== b.current));
        setBase((cur) => cur || (['main', 'master'].find((x) => b.all.includes(x) && x !== b.current) ?? b.all.find((x) => x !== b.current) ?? ''));
      })
      .catch(() => {});
  }, [rpc, machineId, cwd]);

  useEffect(load, [load, settledKey]);

  const totals = useMemo(
    () => (diff?.files ?? []).reduce((a, f) => ({ add: a.add + f.additions, del: a.del + f.deletions }), { add: 0, del: 0 }),
    [diff],
  );

  const keyOf = (path: string, line: number, removed: boolean) => `${path}|${line}|${removed ? 1 : 0}`;
  const startNote = (path: string, line: number, removed: boolean) => {
    if (!canDrive) return;
    setDraftAt(keyOf(path, line, removed));
    setDraftText('');
    setSent(false);
  };
  const saveNote = (path: string, line: number, removed: boolean, code: string) => {
    const text = draftText.trim();
    if (text) {
      setComments((cs) => [...cs, { id: `${Date.now()}-${cs.length}`, path, line, removed, code, text }]);
    }
    setDraftAt(null);
    setDraftText('');
  };

  const sendReview = () => {
    if (!comments.length) return;
    if (!onSendReview(buildReviewMessage(branch, comments))) {
      setResult({ text: 'Не отправилось — нет связи с сессией. Заметки сохранены.', bad: true });
      return;
    }
    // Sent is not accepted: the notes stay until the session starts working on
    // them (settledKey changes), so a refused frame never loses the review.
    setSent(true);
    setResult(null);
  };
  const sentAt = useRef<string | null>(null);
  useEffect(() => {
    if (!sent) {
      sentAt.current = null;
      return;
    }
    if (sentAt.current === null) {
      sentAt.current = settledKey;
      return;
    }
    if (sentAt.current !== settledKey) {
      setComments([]);
      setSent(false);
    }
  }, [sent, settledKey]);

  const act = async (name: string, run: () => Promise<{ ok: boolean; text: string; url?: string }>) => {
    setBusy(name);
    setResult(null);
    try {
      const r = await run();
      setResult({ text: r.text, ...(r.url ? { url: r.url } : {}), bad: !r.ok });
    } catch (e) {
      setResult({ text: errMsg(e), bad: true });
    } finally {
      setBusy('');
      load();
    }
  };
  const commit = () =>
    act('commit', async () => {
      const r = await rpc<{ ok: boolean; output: string }>(machineId, 'git.commit', { cwd, message: message.trim(), all: true, ...(sessionId ? { sessionId } : {}) }, true);
      if (r.ok) setMessage('');
      return { ok: r.ok, text: r.output.split('\n')[0] || (r.ok ? 'Закоммичено' : 'Не вышло') };
    });
  const push = () =>
    act('push', async () => {
      const r = await rpc<{ ok: boolean; output: string; url?: string }>(machineId, 'git.push', { cwd, setUpstream: true }, true);
      return { ok: r.ok, text: r.ok ? 'Ветка отправлена' : r.output.split('\n').slice(-3).join('\n'), ...(r.url ? { url: r.url } : {}) };
    });
  const pr = () =>
    act('pr', async () => {
      const r = await rpc<{ ok: boolean; url?: string; output: string }>(
        machineId,
        'git.pr.create',
        { cwd, title: message.trim() || branch || 'Изменения агента', ...(mode === 'base' && base ? { base } : {}) },
        true,
      );
      if (r.url) window.open(r.url, '_blank', 'noopener');
      return { ok: r.ok, text: r.output, ...(r.url ? { url: r.url } : {}) };
    });

  const changed = status?.files.length ?? 0;

  return (
    <div className="rv">
      <div className="rv-top">
        <div className="rv-branch" title={cwd}>
          <GitBranch size={14} /> <span className="mono">{branch || '…'}</span>
          {status && status.ahead > 0 && <span className="rv-dim"> · впереди на {status.ahead}</span>}
        </div>
        <div className="rv-seg" role="group" aria-label="С чем сравнивать">
          <button type="button" className={mode === 'head' ? 'on' : ''} aria-pressed={mode === 'head'} onClick={() => setMode('head')}>
            vs HEAD
          </button>
          <button type="button" className={mode === 'base' ? 'on' : ''} aria-pressed={mode === 'base'} onClick={() => setMode('base')} disabled={!bases.length}>
            vs ветка
          </button>
        </div>
        {mode === 'base' && (
          <select className="rv-select" value={base} onChange={(e) => setBase(e.target.value)} aria-label="Базовая ветка">
            {bases.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="ghost rv-reload" onClick={load} disabled={loading} aria-label="Обновить" title="Обновить">
          <RefreshCw size={14} />
        </button>
      </div>

      {canDrive && (
        <div className="rv-ship">
          <input
            className="rv-input"
            value={message}
            placeholder="Сообщение коммита / заголовок PR"
            onChange={(e) => setMessage(e.target.value)}
            aria-label="Сообщение коммита"
          />
          <button type="button" className="ghost" disabled={!!busy || !message.trim() || !changed} onClick={commit} title="git add -A && git commit">
            Закоммитить{changed ? ` (${changed})` : ''}
          </button>
          {canPublish && (
            <>
              <button type="button" className="ghost" disabled={!!busy} onClick={push} title="git push -u origin HEAD">
                Push
              </button>
              <button type="button" className="ghost" disabled={!!busy} onClick={pr} title="Откроет страницу создания pull request">
                Создать PR
              </button>
            </>
          )}
        </div>
      )}
      {result && (
        <div className={`rv-result${result.bad ? ' bad' : ''}`} role="status">
          {result.text}
          {result.url && (
            <>
              {' '}
              <a href={result.url} target="_blank" rel="noopener noreferrer">
                открыть
              </a>
            </>
          )}
        </div>
      )}

      {error && <div className="rv-result bad">{error}</div>}
      {status && !status.isRepo && <div className="rv-note">Эта папка — не git-репозиторий: изменений для ревью нет.</div>}
      {diff && (
        <div className="rv-sum">
          {diff.files.length ? (
            <>
              {diff.files.length} файл(ов) · <span className="rv-add">+{totals.add}</span> <span className="rv-del">−{totals.del}</span>
            </>
          ) : (
            'Изменений нет'
          )}
          {diff.truncated && <span className="rv-dim"> · diff обрезан по размеру</span>}
        </div>
      )}

      <div className="rv-files">
        {diff?.files.map((f) => {
          const isOpen = !!open[f.path];
          const n = comments.filter((c) => c.path === f.path).length;
          return (
            <section key={f.path} className="rv-file">
              <button
                type="button"
                className="rv-file-head"
                aria-expanded={isOpen}
                onClick={() => setOpen((o) => ({ ...o, [f.path]: !isOpen }))}
              >
                <span className={`rv-st ${f.status}`} aria-hidden />
                <span className="rv-path mono">
                  {f.oldPath ? `${f.oldPath} → ` : ''}
                  {f.path}
                </span>
                {n > 0 && <span className="rv-n">{n}</span>}
                <span className="rv-add">+{f.additions}</span>
                <span className="rv-del">−{f.deletions}</span>
              </button>
              {isOpen && (
                <div className="rv-scroll">
                  {f.withheld && <div className="rv-note">Похоже на файл с секретами — содержимое не показывается</div>}
                  {f.binary && <div className="rv-note">Бинарный файл</div>}
                  {!f.binary && !f.withheld && f.hunks.length === 0 && <div className="rv-note">Только права или переименование</div>}
                  <div className="rv-lines">
                    {f.hunks.map((h, hi) => (
                      <div key={hi}>
                        <div className="rv-hunk mono">{h.header}</div>
                        {h.lines.map((l, li) => {
                          const removed = l.kind === '-';
                          const no = removed ? (l.old ?? 0) : (l.new ?? 0);
                          const at = keyOf(f.path, no, removed);
                          const mine = comments.filter((c) => c.path === f.path && c.line === no && !!c.removed === removed);
                          return (
                            <div key={li}>
                              <div
                                className={`rv-line k${l.kind === ' ' ? 'c' : l.kind === '+' ? 'a' : 'd'}`}
                                role={canDrive ? 'button' : undefined}
                                tabIndex={canDrive ? 0 : undefined}
                                aria-label={canDrive ? `Комментарий к строке ${no}` : undefined}
                                onClick={() => startNote(f.path, no, removed)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    startNote(f.path, no, removed);
                                  }
                                }}
                              >
                                <span className="rv-no">{l.old ?? ''}</span>
                                <span className="rv-no">{l.new ?? ''}</span>
                                <span className="rv-sign">{l.kind === ' ' ? '' : l.kind}</span>
                                <span className="rv-code">{l.text || ' '}</span>
                              </div>
                              {mine.map((c) => (
                                <div key={c.id} className="rv-comment">
                                  <span>{c.text}</span>
                                  <button
                                    type="button"
                                    className="pt-btn"
                                    onClick={() => setComments((cs) => cs.filter((x) => x.id !== c.id))}
                                  >
                                    убрать
                                  </button>
                                </div>
                              ))}
                              {draftAt === at && (
                                <form
                                  className="rv-draft"
                                  onSubmit={(e) => {
                                    e.preventDefault();
                                    saveNote(f.path, no, removed, l.text);
                                  }}
                                >
                                  <textarea
                                    autoFocus
                                    rows={2}
                                    value={draftText}
                                    placeholder="Что здесь не так?"
                                    onChange={(e) => setDraftText(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                        e.preventDefault();
                                        saveNote(f.path, no, removed, l.text);
                                      }
                                      if (e.key === 'Escape') {
                                        e.stopPropagation();
                                        setDraftAt(null);
                                      }
                                    }}
                                  />
                                  <div className="rv-draft-row">
                                    <button type="submit" className="ghost" disabled={!draftText.trim()}>
                                      Добавить в ревью
                                    </button>
                                    <button type="button" className="pt-btn" onClick={() => setDraftAt(null)}>
                                      отмена
                                    </button>
                                  </div>
                                </form>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>

      {(comments.length > 0 || sent) && (
        <div className="rv-bar">
          {sent ? (
            <>
              <span>Отправлено агенту — заметки сохранятся, пока он не возьмётся за них</span>
              <button type="button" className="ghost" onClick={() => { setComments([]); setSent(false); }}>
                Очистить
              </button>
            </>
          ) : comments.length > 0 ? (
            <>
              <span>Заметок: {comments.length}</span>
              <button type="button" className="rv-send" onClick={sendReview}>
                Отправить агенту
              </button>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
