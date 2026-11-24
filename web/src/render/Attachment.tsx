import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowSquareOut, DownloadIcon, ImageIcon } from '../icons.js';
import { anchorDownload, saveBlob } from '../saveFile.js';
import { dataUrlToBlob } from './imageGen.js';

/** Fetch one attachment's bytes by the `ref` its history block carried.
 *  `null` = the ref no longer resolves (a compaction moved the message out of
 *  the transcript tail), which is ordinary rather than an error. */
export type FetchAttachment = ((ref: string) => Promise<{ mediaType: string; dataB64: string } | null>) & {
  /** Whose bytes these are — machine/session/source. The shared picture cache is
   *  keyed by it, so two sessions that happen to share a ref never share a picture. */
  scope?: string;
};

/** Stamp a fetcher with the identity of the session it answers for. */
export function scopedFetch(
  fn: (ref: string) => Promise<{ mediaType: string; dataB64: string } | null>,
  scope: string,
): FetchAttachment {
  return Object.assign(fn, { scope });
}

const anonScopes = new WeakMap<object, number>();
let anonSeq = 0;
/** Cache key of `ref` for this fetcher: its scope, else a private id per function. */
export function imageCacheKey(fetchAttachment: FetchAttachment | null | undefined, ref: string): string {
  let scope = fetchAttachment?.scope;
  if (scope === undefined && fetchAttachment) {
    let id = anonScopes.get(fetchAttachment);
    if (id === undefined) anonScopes.set(fetchAttachment, (id = ++anonSeq));
    scope = `anon${id}`;
  }
  return `${scope ?? ''}\u0000${ref}`;
}

/**
 * How an image block reaches the session it belongs to.
 *
 * A context rather than a prop, because `BlockView` is reached from four
 * renderers (history, live, mirror, the screenshot fixture) and only two of
 * them know a machine and a session at all. Threading an argument through every
 * call site would have made the ones that CANNOT fetch carry the parameter
 * anyway; with a context, they simply do not provide one and the block keeps
 * drawing the placeholder it has always drawn.
 */
export const AttachmentContext = createContext<FetchAttachment | null>(null);

/** One decoded attachment, shared by every block that names the same ref.
 *
 * Module-level on purpose: the same picture is re-rendered constantly (a
 * transcript re-renders on every stream frame) and it must not be re-fetched
 * each time.
 *
 * Only a picture or a request in flight is kept — never a failure. Until
 * 10.10.2026 a `null` here meant «asked, and there is nothing» for the life of
 * the tab, and a failure was any of: the socket dropping (every pending RPC is
 * rejected), the 30 s RPC timeout, a pane without its session id yet. One such
 * blip and the screenshot a person had just sent stayed a grey «картинка» chip
 * until a full reload, while a fresh tab drew it fine. A dead ref costs a few
 * bounded retries per mount (`RETRY_MS`) instead. */
const cache = new Map<string, string | Promise<string | null>>();

/** Decoded pictures kept at most — a generated one is 1–3 MB of base64, and a
 *  long image-heavy transcript must not pin hundreds of MB for the tab's life.
 *  Least recently used goes first; requests in flight are never evicted. */
const CACHE_PICTURES = 48;

function remember(key: string, url: string): void {
  cache.delete(key);
  cache.set(key, url);
  let pictures = 0;
  for (const v of cache.values()) if (typeof v === 'string') pictures++;
  for (const [k, v] of cache) {
    if (pictures <= CACHE_PICTURES) break;
    if (typeof v === 'string') {
      cache.delete(k);
      pictures--;
    }
  }
}

/** Back-off for a picture that did not arrive; after the last one the chip
 *  stays, and a click on it asks again. */
const RETRY_MS = [2_000, 8_000, 30_000];

/** The picture for `ref` as a data URL, from the shared cache or one RPC;
 *  `null` when it does not resolve (and nothing is remembered about that, see
 *  `cache`). Every renderer of a picture goes through here, so the same ref in
 *  the history and in a live replay settles from one request. */
export async function resolveImage(fetchAttachment: FetchAttachment, ref: string): Promise<string | null> {
  const key = imageCacheKey(fetchAttachment, ref);
  const cached = cache.get(key);
  if (typeof cached === 'string') {
    remember(key, cached);
    return cached;
  }
  // Cache the in-flight promise too: the same image can be present in the
  // history and a live replay at once, and both should settle from one RPC.
  const pending =
    cached ??
    fetchAttachment(ref).then(
      (got) => (got?.dataB64 ? `data:${got.mediaType || 'image/png'};base64,${got.dataB64}` : null),
      () => null,
    );
  if (!cached) cache.set(key, pending);
  const next = await pending;
  if (next) {
    remember(key, next);
    return next;
  }
  // Forget the failure so the next ask is a real one (see `cache`).
  if (cache.get(key) === pending) cache.delete(key);
  return null;
}

/** A picture already in the cache, without asking. */
export function peekImage(fetchAttachment: FetchAttachment | null | undefined, ref: string | undefined): string | null {
  const cached = ref ? cache.get(imageCacheKey(fetchAttachment, ref)) : undefined;
  return typeof cached === 'string' ? cached : null;
}

/** Shared full-size viewer for both freshly attached and historical images.
 * Portalling to body is essential: `.chat` is a CSS containment root, which
 * otherwise clips a `position: fixed` backdrop to the transcript panel.
 *
 * The picture is the dialog, with two actions beside it: open it in a tab of
 * its own (where the browser's own zoom works) and save it. Esc and a click
 * outside still close it. */
export function ImageLightbox({
  url,
  name,
  blob,
  onClose,
}: {
  url: string;
  name?: string;
  /** The picture's bytes when the caller has them: saving then shares or
   *  downloads a real Blob instead of re-deriving one from the URL. */
  blob?: Blob;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // A `data:` URL cannot be opened as a top-level page, so both actions go
  // through a blob URL, revoked a minute later (the tab has long since loaded).
  const blobUrl = (): string | null => {
    const blob = url.startsWith('data:') ? dataUrlToBlob(url) : null;
    if (!blob) return url.startsWith('data:') ? null : url;
    const u = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(u), 60_000);
    return u;
  };
  const openInTab = () => {
    const u = blobUrl();
    if (u) window.open(u, '_blank', 'noopener');
  };
  const save = () => {
    const b = blob ?? (url.startsWith('data:') ? dataUrlToBlob(url) : null);
    if (b) {
      void saveBlob(b, name || 'image.png');
      return;
    }
    const u = blobUrl();
    if (!u) return;
    // Synchronous inside the tap, so a share sheet is allowed; `blobUrl`
    // already revokes late.
    anchorDownload(u, name || 'image.png');
  };

  return createPortal(
    <div className="modal-backdrop att-viewer" onClick={onClose} role="presentation">
      <div className="att-viewer-bar" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="att-viewer-btn" onClick={openInTab}>
          <ArrowSquareOut size={16} aria-hidden /> Открыть в новой вкладке
        </button>
        <button type="button" className="att-viewer-btn" onClick={save}>
          <DownloadIcon size={16} aria-hidden /> Скачать
        </button>
      </div>
      <img src={url} alt="Вложение" onClick={(e) => e.stopPropagation()} />
    </div>,
    document.body,
  );
}

/**
 * A transcript attachment: the picture, lazily.
 *
 * The bytes are deliberately absent from history (see `RenderBlockSchema`), so
 * this used to be a grey chip reading «image» — a thing you could see and not
 * open, next to a message that plainly had a screenshot in it. The block now
 * carries a ref, and this trades it for the picture at the moment the picture
 * is about to be on screen.
 *
 * Not on mount: a session full of screenshots would pull all of them the
 * instant it opened, which is the cost the data-less marker exists to avoid.
 * `IntersectionObserver` with a generous margin means the fetch happens just
 * before the picture is scrolled to, and never for the ones nobody reaches.
 */
export function Attachment({ blockRef }: { blockRef?: string }) {
  const fetchAttachment = useContext(AttachmentContext);
  const [url, setUrl] = useState<string | null>(() => {
    return peekImage(fetchAttachment, blockRef);
  });
  const [failed, setFailed] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [open, setOpen] = useState(false);
  const holder = useRef<HTMLSpanElement | null>(null);

  const load = useCallback(async () => {
    if (!blockRef || !fetchAttachment) return;
    const next = await resolveImage(fetchAttachment, blockRef);
    if (next) {
      setUrl(next);
      setFailed(false);
    } else {
      setFailed(true);
    }
  }, [blockRef, fetchAttachment]);

  // A picture that did not arrive is asked for again, a few times, spaced out.
  useEffect(() => {
    if (!failed || attempts >= RETRY_MS.length) return;
    const t = setTimeout(() => {
      setAttempts((n) => n + 1);
      void load();
    }, RETRY_MS[attempts]);
    return () => clearTimeout(t);
  }, [failed, attempts, load]);

  useEffect(() => {
    if (!blockRef || !fetchAttachment) return;
    const cached = cache.get(imageCacheKey(fetchAttachment, blockRef));
    if (typeof cached === 'string') {
      setUrl(cached);
      return;
    }
    const el = holder.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          void load();
        }
      },
      { rootMargin: '600px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [blockRef, fetchAttachment, load]);

  // No ref (a transcript written before this existed) or nobody to ask — the
  // chip, exactly as before.
  if (!blockRef || !fetchAttachment) {
    return (
      <span className="att-chip" title="Вложенная картинка">
        <ImageIcon size={12} /> картинка
      </span>
    );
  }
  // Asked and not (yet) answered: the same chip, but a click asks again.
  if (failed) {
    return (
      <button
        type="button"
        className="att-chip"
        title="Картинка не загрузилась — нажмите, чтобы повторить"
        onClick={() => void load()}
      >
        <ImageIcon size={12} /> картинка
      </button>
    );
  }

  return (
    <>
      <span className="att-shot" ref={holder}>
        {url ? (
          <button className="att-open" onClick={() => setOpen(true)} title="Открыть изображение">
            <img src={url} alt="Вложение" loading="lazy" />
          </button>
        ) : (
          // Holds the row's height while the bytes are on their way, so the
          // transcript does not jump when each one lands.
          <span className="att-pending" aria-label="Загружается изображение" />
        )}
      </span>
      {open && url && <ImageLightbox url={url} onClose={() => setOpen(false)} />}
    </>
  );
}
