import { createContext, memo, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FS_PEEK_MAX_BYTES, type FsDownloadResult } from '@cc-remote/shared';
import { pullBytes, pullHead } from '../components/files/pullBytes.js';
import { SideSheet } from '../components/SideSheet.js';
import { FileImage, FileMd } from '../icons.js';
import type { useCentral } from '../useCentral.js';
import { ImageLightbox } from './Attachment.js';
import { Md } from './Blocks.js';
import { fileName, findPreviewPaths, isAbsolutePath, isMarkdownPath } from './filePaths.js';

/**
 * Previews of the files an answer names — a screenshot's path on its last line,
 * a plan in `docs/plan.md` — drawn under the answer's text.
 *
 * The bytes come from `fs.peek` (agent: images and markdown only, inside the
 * project or the session's scratch directory). Like `AttachmentContext`, this is
 * a context: only a panel that knows a machine and a folder can ask, and the
 * renderers that cannot (Memory, the question modal) provide nothing and show
 * nothing.
 */

/** A file's head as a Blob; `truncated` when `clip` cut it at `maxBytes`. */
export type PeekFile = ((
  path: string,
  maxBytes: number,
  clip: boolean,
) => Promise<{ blob: Blob; truncated: boolean }>) & {
  /** Whose files these are — machine and folder. A relative path means nothing
   *  without it, so the shared cache is keyed by it. */
  scope: string;
};

export const FilePeekContext = createContext<PeekFile | null>(null);

/** The reader for one machine + folder, over `fs.peek`. Quiet RPCs: a file that
 *  will not load is a muted chip, not a toast over the transcript. */
export function makeFilePeek(rpc: ReturnType<typeof useCentral>['rpc'], machineId: string, cwd: string): PeekFile {
  const read = (path: string) => (offset: number, length: number) =>
    rpc<FsDownloadResult>(machineId, 'fs.peek', { cwd, path, offset, length }, true);
  return Object.assign(
    (path: string, maxBytes: number, clip: boolean) =>
      clip
        ? pullHead(read(path), maxBytes)
        : pullBytes(read(path), maxBytes).then((blob) => ({ blob, truncated: false })),
    { scope: `${machineId}\u0000${cwd}` },
  );
}

/** Markdown read in the sheet: the head of the file, no more. */
const MD_CAP_BYTES = 512 * 1024;
/** Files kept for the life of the tab, by total size, least recently used first.
 *  A re-render per stream frame, a remount after scrolling away or a reopened
 *  sheet must not fetch again. Blobs, not object URLs: a URL is minted by the
 *  component that shows it and revoked when it goes, so nothing leaks and
 *  nothing on screen can be revoked from under it by an eviction. */
const CACHE_BYTES = 48 * 1024 * 1024;
/** A success is believed this long: the same path is often overwritten by the
 *  next screenshot, and a reopened view should not show the old one for ever. */
const CACHE_TTL_MS = 5 * 60_000;
/** Reads in flight at once, over all strips: one socket serves the whole app. */
const MAX_READS = 3;

interface Loaded {
  blob: Blob;
  truncated: boolean;
  at: number;
}

// Successes and requests in flight only — never a failure (see Attachment's
// cache: one dropped socket must not make a file «недоступен» until reload).
const cache = new Map<string, Loaded | Promise<Loaded>>();
let cachedBytes = 0;

let active = 0;
const waiting: Array<() => void> = [];
async function inSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_READS) await new Promise<void>((r) => waiting.push(r));
  else active += 1;
  try {
    return await fn();
  } finally {
    // The slot passes straight to the next waiter, so the cap holds.
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }
}

function settle(key: string, value: Loaded): void {
  const old = cache.get(key);
  if (old && !(old instanceof Promise)) cachedBytes -= old.blob.size;
  cache.delete(key);
  cache.set(key, value);
  cachedBytes += value.blob.size;
  for (const [k, v] of cache) {
    if (cachedBytes <= CACHE_BYTES) break;
    if (k !== key && !(v instanceof Promise)) {
      cache.delete(k);
      cachedBytes -= v.blob.size;
    }
  }
}

/** The file for `path`, from the cache or one windowed read. Rejects on failure. */
export function loadPreview(peek: PeekFile, path: string): Promise<Loaded> {
  const key = `${peek.scope}\u0000${path}`;
  const hit = cache.get(key);
  if (hit instanceof Promise) return hit;
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    settle(key, hit);
    return Promise.resolve(hit);
  }
  if (hit) {
    cache.delete(key);
    cachedBytes -= hit.blob.size;
  }
  const md = isMarkdownPath(path);
  const pending = inSlot(() => peek(path, md ? MD_CAP_BYTES : FS_PEEK_MAX_BYTES, md)).then((r) => ({
    ...r,
    at: Date.now(),
  }));
  cache.set(key, pending);
  pending.then(
    (v) => {
      if (cache.get(key) === pending) settle(key, v);
    },
    () => {
      if (cache.get(key) === pending) cache.delete(key);
    },
  );
  return pending;
}

/** A settled file already in the cache, without asking. */
function peekLoaded(peek: PeekFile, path: string): Loaded | null {
  const hit = cache.get(`${peek.scope}\u0000${path}`);
  return hit && !(hit instanceof Promise) && Date.now() - hit.at < CACHE_TTL_MS ? hit : null;
}

/** An object URL for a blob, revoked when the blob changes or the view goes. */
function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

/**
 * The strip under one answer's text: a thumbnail per picture, a chip per
 * markdown file. Nothing without a provider, nothing without a path.
 */
export const FilePreviews = memo(function FilePreviews({ text }: { text: string }) {
  const peek = useContext(FilePeekContext);
  const paths = useMemo(() => (peek ? findPreviewPaths(text) : []), [peek, text]);
  if (!peek || paths.length === 0) return null;
  return (
    <div className="fp-strip">
      {paths.map((p) => (
        <FilePreview key={`${peek.scope}\u0000${p}`} peek={peek} path={p} />
      ))}
    </div>
  );
});

type State = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; loaded: Loaded } | { kind: 'error'; reason: string };

function FilePreview({ peek, path }: { peek: PeekFile; path: string }) {
  const md = isMarkdownPath(path);
  const absolute = isAbsolutePath(path);
  const name = fileName(path);
  const [state, setState] = useState<State>(() => {
    const hit = peekLoaded(peek, path);
    return hit ? { kind: 'ready', loaded: hit } : { kind: 'idle' };
  });
  const [open, setOpen] = useState(false);
  const holder = useRef<HTMLDivElement | null>(null);
  // One generation per (folder, path) and per mount: a read started for the
  // previous folder, or finishing after unmount, must not paint this one.
  const gen = useRef(0);
  useEffect(() => () => void (gen.current += 1), []);

  const load = () => {
    const mine = ++gen.current;
    setState({ kind: 'loading' });
    loadPreview(peek, path).then(
      (loaded) => {
        if (gen.current === mine) setState({ kind: 'ready', loaded });
      },
      (e: unknown) => {
        if (gen.current === mine) setState({ kind: 'error', reason: e instanceof Error ? e.message : String(e) });
      },
    );
  };

  // Not on mount: a long session names dozens of files, and only the ones
  // scrolled to are worth a read. The same margin as an attachment.
  useEffect(() => {
    if (state.kind !== 'idle') return;
    const el = holder.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          load();
        }
      },
      { rootMargin: '600px' },
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load() closes over peek and path only
  }, [state.kind, peek, path]);

  // The same path under a different folder is a different file.
  useEffect(() => {
    gen.current += 1;
    const hit = peekLoaded(peek, path);
    setState(hit ? { kind: 'ready', loaded: hit } : { kind: 'idle' });
    setOpen(false);
  }, [peek, path]);

  const blob = !md && state.kind === 'ready' ? state.loaded.blob : null;
  const url = useObjectUrl(blob);

  let body: ReactNode = null;
  if (state.kind === 'error') {
    // A relative path is a guess ("see docs/plan.md" may not be a file at all);
    // an absolute one is a claim, and a muted chip says what was claimed.
    if (absolute) {
      body = (
        <button
          type="button"
          className="fp-chip missing"
          title={`${path}\nфайл недоступен: ${state.reason} — нажмите, чтобы повторить`}
          onClick={load}
        >
          {md ? <FileMd size={14} aria-hidden /> : <FileImage size={14} aria-hidden />}
          <span className="fp-name">{name}</span>
        </button>
      );
    }
  } else if (md) {
    if (state.kind === 'ready') {
      body = (
        <button type="button" className="fp-chip" title={path} onClick={() => setOpen(true)}>
          <FileMd size={14} aria-hidden />
          <span className="fp-name">{name}</span>
        </button>
      );
    } else if (absolute) {
      body = (
        <span className="fp-chip pending" title={path}>
          <FileMd size={14} aria-hidden />
          <span className="fp-name">{name}</span>
        </span>
      );
    }
  } else if (state.kind === 'ready') {
    body = (
      // The picture is held at its row's height by `.fp-pending` until the URL
      // exists, so the transcript does not jump.
      <button type="button" className="fp-thumb" title={path} onClick={() => url && setOpen(true)}>
        {url ? (
          <img
            src={url}
            alt={name}
            // Bytes arrived but are not a picture (a corrupt or misnamed file):
            // the unavailable chip, not a broken-image icon with no way out.
            onError={() => setState({ kind: 'error', reason: 'не удалось показать изображение' })}
          />
        ) : <span className="fp-pending" aria-label="Загружается изображение" />}
      </button>
    );
  } else if (absolute) {
    body = <span className="fp-pending" aria-label="Загружается изображение" />;
  }

  return (
    <div className={md ? 'fp-item' : 'fp-item img'} ref={holder}>
      {body}
      {open && !md && url && <ImageLightbox url={url} name={name} onClose={() => setOpen(false)} />}
      {open && md && state.kind === 'ready' && (
        <MdSheet path={path} name={name} loaded={state.loaded} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

/** The rendered file in a sheet. Portalled to body: `.chat` is a containment
 *  root, which would clip a fixed scrim to the transcript's own box. */
function MdSheet({ path, name, loaded, onClose }: { path: string; name: string; loaded: Loaded; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void loaded.blob.arrayBuffer().then((buf) => live && setText(new TextDecoder('utf-8').decode(buf)));
    return () => {
      live = false;
    };
  }, [loaded]);
  return createPortal(
    <SideSheet title={name} onClose={onClose}>
      <div className="fp-sheet-path" title={path}>
        {path}
      </div>
      {text === null ? <div className="line status">Загружаю…</div> : <Md text={text} />}
      {loaded.truncated && (
        <div className="line status">Показано начало файла (первые {MD_CAP_BYTES / 1024} КБ).</div>
      )}
    </SideSheet>,
    document.body,
  );
}
