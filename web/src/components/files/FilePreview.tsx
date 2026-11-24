import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { FsEntry } from '@cc-remote/shared';
import { Md, CodeBlock } from '../../render/Blocks.js';
import { FileIcon, X, DownloadIcon, ArrowLeft } from '../../icons.js';
import { fileSizeLabel } from '../../lib.js';
import { CopyButton } from '../CopyButton.js';
import { absPath, extOf, isImage, isTextual } from './paths.js';

/**
 * The payoff pane.
 *
 * No CodeMirror. A `<pre>` in the mono voice IS the data layer of this design
 * system; syntax colour would be a fourth palette the system does not have, and
 * the editor it came with is 200KB for a feature this version does not ship.
 *
 * Nothing is fetched for a file that cannot be shown. A card naming the file is
 * the honest answer for a zip, and it costs no round trip.
 */

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** Above this a "text" file is treated as binary until the person insists —
 *  a 40MB log should not be pulled onto a phone by a single click. */
const BIG_TEXT_BYTES = 2 * 1024 * 1024;

type Body =
  | { kind: 'loading' }
  | { kind: 'text'; content: string; truncated: boolean }
  | { kind: 'image'; url: string }
  | { kind: 'binary'; reason: string }
  | { kind: 'error'; message: string };

export function FilePreview({
  entry,
  rel,
  root,
  read,
  readImage,
  onClose,
  onDownload,
  downloading,
  sendSlot,
  compact,
  ready,
}: {
  entry: FsEntry;
  rel: string;
  root: string;
  /** Socket is up. Reading before it is rejects with "not connected". */
  ready: boolean;
  read: (rel: string) => Promise<{ content: string; truncated: boolean }>;
  readImage: (rel: string) => Promise<string>;
  onClose: () => void;
  onDownload: () => void;
  /** A download is already running — the button waits, the status line says why. */
  downloading?: boolean;
  /** The «в сессию» control. Passed in rather than built here so the preview
   *  stays a viewer and does not need to know about machines or sessions. */
  sendSlot?: ReactNode;
  compact: boolean;
}) {
  const [body, setBody] = useState<Body>({ kind: 'loading' });
  const [force, setForce] = useState(false);
  // One generation per open: a slow read of the previous file must not paint
  // over the one now on screen — and it would do it silently.
  const gen = useRef(0);
  const objectUrl = useRef<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    const mine = ++gen.current;
    const size = entry.size ?? 0;

    const settle = (b: Body): void => {
      if (gen.current === mine) setBody(b);
    };

    if (isImage(entry.name)) {
      if (size > MAX_IMAGE_BYTES) {
        settle({ kind: 'binary', reason: 'изображение слишком большое для предпросмотра' });
        return;
      }
      setBody({ kind: 'loading' });
      void readImage(rel)
        .then((url) => {
          if (gen.current !== mine) {
            URL.revokeObjectURL(url);
            return;
          }
          if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
          objectUrl.current = url;
          settle({ kind: 'image', url });
        })
        .catch((err: Error) => settle({ kind: 'error', message: err.message }));
      return;
    }

    if (!isTextual(entry.name, entry.size)) {
      settle({ kind: 'binary', reason: 'предпросмотр недоступен' });
      return;
    }
    if (size > BIG_TEXT_BYTES && !force) {
      settle({ kind: 'binary', reason: 'большой файл — открыть целиком?' });
      return;
    }

    setBody({ kind: 'loading' });
    void read(rel)
      .then((r) => settle({ kind: 'text', content: r.content, truncated: r.truncated }))
      .catch((err: Error) => settle({ kind: 'error', message: err.message }));
  }, [rel, entry.name, entry.size, read, readImage, force, ready]);

  // Opening a different file clears the "show it anyway" override, which must
  // not live in the effect above: setting it there would re-run the effect that
  // set it.
  useEffect(() => setForce(false), [rel]);

  useEffect(
    () => () => {
      // Invalidate the generation FIRST. Revoking only what has already resolved
      // let an in-flight read finish after unmount: it set state on a dead
      // component and its object URL was never revoked, so opening and closing
      // previews leaked a blob each time.
      gen.current += 1;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );

  const full = absPath(root, rel);

  return (
    <section className="files-prev" aria-label="Просмотр файла">
      <header className="files-prev-head">
        {compact ? (
          <button type="button" className="ghost files-prev-back" onClick={onClose}>
            <ArrowLeft size={14} /> Назад
          </button>
        ) : null}
        <div className="files-prev-title">
          <div className="files-prev-name" title={entry.name}>
            {entry.name}
          </div>
          <div className="files-prev-meta">
            {entry.size !== undefined ? fileSizeLabel(entry.size) : ''}
            <CopyButton text={full} label="Скопировать путь" className="ghost files-prev-copy" />
          </div>
        </div>
        {compact ? null : (
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Закрыть">
            <X size={14} />
          </button>
        )}
      </header>

      <div className="files-prev-actions">
        <button type="button" className="ghost" disabled={downloading} onClick={onDownload}>
          <DownloadIcon size={14} /> Скачать
        </button>
        {sendSlot}
      </div>

      <div className="files-prev-body">
        {body.kind === 'loading' ? <div className="files-prev-loading">Читаю…</div> : null}
        {body.kind === 'error' ? <div className="files-err">{body.message}</div> : null}
        {body.kind === 'image' ? <img className="files-prev-img" src={body.url} alt={entry.name} /> : null}
        {body.kind === 'binary' ? (
          <div className="placeholder">
            <FileIcon size={22} />
            <div className="ph-sub">{body.reason}</div>
            {/* The honest next step for something the browser cannot show is the
                file itself — or, for a big text file, an explicit "yes really". */}
            {(entry.size ?? 0) > BIG_TEXT_BYTES && isTextual(entry.name, entry.size) ? (
              <button type="button" className="ghost" onClick={() => setForce(true)}>
                Показать всё равно
              </button>
            ) : null}
          </div>
        ) : null}
        {body.kind === 'text' ? (
          <>
            {body.truncated ? (
              <div className="files-trunc">
                Показаны первые 512 КБ
                <button type="button" className="ghost" disabled={downloading} onClick={onDownload}>
                  Скачать целиком
                </button>
              </div>
            ) : null}
            {/^(md|mdx|markdown)$/.test(extOf(entry.name)) ? (
              <Md text={body.content} />
            ) : (
              <CodeBlock className={`language-${extOf(entry.name)}`}>{body.content}</CodeBlock>
            )}
          </>
        ) : null}
      </div>
    </section>
  );
}
