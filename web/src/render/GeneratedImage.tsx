import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ImageGenEventData } from '@cc-remote/shared';
import { AttachmentContext, ImageLightbox, imageCacheKey, peekImage, resolveImage } from './Attachment.js';
import { genClock, genFileName, genProgress } from './imageGen.js';

/** An empty `session.image` answer is «not resolvable yet» for a ref that has
 *  just arrived live — the transcript line may land a moment after the event.
 *  Three asks, two seconds apart, then «картинка недоступна». */
const TRIES = 3;
const TRY_GAP_MS = 2_000;

/**
 * A picture the runtime MADE (an `image` block with `generated`, or the live
 * card's `done`): large and inline, the prompt under it, a click opens the
 * lightbox. Not `Attachment`'s small thumbnail — here the picture is the
 * agent's answer, not a reference inside the person's message.
 *
 * Bytes come through the same loader and cache as attachments. Not lazily by
 * scroll for live cards, though: a picture that just finished should be on
 * screen, so the ask goes out on mount; history ones wait for the viewport.
 */
export function GeneratedImage({ blockRef, prompt, eager = false }: { blockRef?: string; prompt?: string; eager?: boolean }) {
  const fetchImage = useContext(AttachmentContext);
  // The loaded picture remembers whose it is: a row React reuses for another
  // ref or another session must not keep showing the previous bytes.
  const key = blockRef ? imageCacheKey(fetchImage, blockRef) : '';
  const [loaded, setLoaded] = useState<{ key: string; url: string } | null>(null);
  const url = loaded && loaded.key === key ? loaded.url : peekImage(fetchImage, blockRef);
  const [state, setState] = useState<'loading' | 'missing'>('loading');
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  // Bumped by «повторить» to run the whole bounded loop again.
  const [round, setRound] = useState(0);
  const holder = useRef<HTMLDivElement | null>(null);

  const run = useCallback(
    (alive: () => boolean) => {
      if (!blockRef || !fetchImage) {
        setState('missing');
        return;
      }
      void (async () => {
        for (let i = 0; i < TRIES; i++) {
          const got = await resolveImage(fetchImage, blockRef);
          if (!alive()) return;
          if (got) {
            setLoaded({ key: imageCacheKey(fetchImage, blockRef), url: got });
            return;
          }
          if (i < TRIES - 1) await new Promise((r) => setTimeout(r, TRY_GAP_MS));
          if (!alive()) return;
        }
        setState('missing');
      })();
    },
    [blockRef, fetchImage],
  );

  useEffect(() => {
    if (url) return;
    setState('loading');
    let live = true;
    const alive = () => live;
    const el = holder.current;
    if (eager || !el || typeof IntersectionObserver === 'undefined') {
      run(alive);
      return () => {
        live = false;
      };
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          run(alive);
        }
      },
      { rootMargin: '600px' },
    );
    io.observe(el);
    return () => {
      live = false;
      io.disconnect();
    };
  }, [url, run, eager, round]);

  return (
    <figure className="gen-img" ref={holder}>
      {url ? (
        <button type="button" className="gen-open" onClick={() => setOpen(true)} title="Открыть изображение">
          <img src={url} alt={prompt ? `Картинка: ${prompt}` : 'Сгенерированная картинка'} />
        </button>
      ) : state === 'missing' ? (
        <button
          type="button"
          className="gen-missing"
          onClick={() => setRound((n) => n + 1)}
          title="Нажмите, чтобы запросить ещё раз"
        >
          картинка недоступна
        </button>
      ) : (
        <span className="gen-wait gen-wait-load" aria-label="Загружается изображение" />
      )}
      {prompt && (
        <figcaption>
          <button
            type="button"
            className={more ? 'gen-prompt open' : 'gen-prompt'}
            onClick={() => setMore((v) => !v)}
            aria-expanded={more}
            title={prompt}
          >
            {prompt}
          </button>
        </figcaption>
      )}
      {open && url && <ImageLightbox url={url} name={genFileName(prompt)} onClose={() => setOpen(false)} />}
    </figure>
  );
}

function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** The live card of one generation (`image_gen`): placeholder with a bar while
 *  it draws, the picture in the same place when it is done, a short error row
 *  when it failed. The line is the same object through all three (see
 *  `foldImageGen`), so React keeps the node and nothing jumps. */
export function ImageGenCard({ data }: { data: ImageGenEventData }) {
  const started = data.state === 'started';
  const now = useNow(started);
  if (data.state === 'done') return <GeneratedImage blockRef={data.ref} prompt={data.prompt} eager />;
  if (data.state === 'failed') {
    return (
      <div className="gen-failed" title={data.error}>
        Не удалось нарисовать картинку{data.error ? ` · ${data.error}` : ''}
      </div>
    );
  }
  const elapsed = Math.max(0, now - (data.startedAt ?? now));
  const p = genProgress(elapsed);
  return (
    <div className="gen-card">
      <div className="gen-wait">
        <div className="gen-wait-body">
          {data.prompt && <div className="gen-prompt-clip">{data.prompt}</div>}
          <div className="gen-label">
            <span>Рисую картинку</span>
            <span className="gen-clock">{genClock(elapsed)}</span>
          </div>
          <div
            className="gen-bar"
            role="progressbar"
            aria-label="Рисую картинку"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(p * 100)}
          >
            <span style={{ width: `${(p * 100).toFixed(1)}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}
