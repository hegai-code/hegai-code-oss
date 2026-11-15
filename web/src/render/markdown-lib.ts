import { useEffect, useReducer } from 'react';
import type { ComponentType } from 'react';

/**
 * react-markdown and its micromark/mdast stack are ~400 KB of source — the
 * single heaviest thing in the bundle, and the session LIST renders none of it.
 * So it travels in its own chunk.
 *
 * The catch with a plain `lazy()` here is that `Md` renders inside a streaming
 * transcript: a Suspense fallback would blink on the first block of every
 * session. Instead the module is fetched once, imperatively, and the components
 * that need it re-render when it lands — showing the text as plain prose in the
 * meantime, which is what markdown mostly looks like anyway.
 *
 * And it is PREFETCHED at idle right after first paint (see `warmMarkdown` in
 * main.tsx), so by the time a transcript is on screen it is normally already
 * here. The split buys a smaller critical path, not a slower transcript.
 */
type Lib = { Markdown: ComponentType<Record<string, unknown>>; gfm: unknown };

let lib: Lib | null = null;
let inflight: Promise<void> | null = null;

export function loadMarkdown(): Promise<void> {
  if (lib) return Promise.resolve();
  inflight ??= Promise.all([import('react-markdown'), import('remark-gfm')])
    .then(([md, gfm]) => {
      lib = { Markdown: md.default as ComponentType<Record<string, unknown>>, gfm: gfm.default };
    })
    .catch(() => {
      inflight = null; // a dropped chunk must not wedge every transcript forever
    });
  return inflight;
}

/** The loaded library, or null while it is still on the way. */
export function useMarkdownLib(): Lib | null {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (lib) return;
    let alive = true;
    void loadMarkdown().then(() => alive && bump());
    return () => { alive = false; };
  }, []);
  return lib;
}
