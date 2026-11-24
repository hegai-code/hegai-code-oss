import { useCallback, useEffect, useRef, useState } from 'react';
import { needsSaveTap, saveBlob } from './saveFile.js';

export type SaveState =
  | { phase: 'loading'; name: string; pct: number | null }
  | { phase: 'ready'; name: string; blob: Blob }
  | { phase: 'error'; name: string; message: string }
  | null;

/** A fetched file waiting for «Сохранить» is let go after this long: it is a
 *  whole file held in a phone tab's memory. */
export const READY_TTL_MS = 120_000;

/**
 * Fetch a file, then save it — the two-step flow iOS needs. `start` fetches
 * with progress; on a touch device the state becomes `ready` and the UI shows
 * «Сохранить», whose tap calls `save` (a fresh gesture). On desktop the file
 * is saved straight away.
 *
 * Every state change carries the generation of the call that made it: an older
 * download finishing late never overwrites a newer one, and `dismiss` (or the
 * `ready` timeout, or unmount) invalidates whatever is in flight.
 */
export function useFileSave() {
  const [state, setState] = useState<SaveState>(null);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const dismiss = useCallback(() => {
    seq.current += 1;
    clearTimer();
    setState(null);
  }, []);

  useEffect(
    () => () => {
      seq.current += 1;
      clearTimer();
    },
    [],
  );

  const start = useCallback(
    async (name: string, fetchBlob: (onProgress: (loaded: number, total: number) => void) => Promise<Blob>) => {
      const mine = ++seq.current;
      clearTimer();
      const put = (s: SaveState) => {
        if (seq.current === mine) setState(s);
      };
      put({ phase: 'loading', name, pct: null });
      try {
        const blob = await fetchBlob((loaded, total) =>
          put({ phase: 'loading', name, pct: total > 0 ? Math.min(100, Math.floor((loaded / total) * 100)) : null }),
        );
        if (seq.current !== mine) return;
        if (needsSaveTap()) {
          put({ phase: 'ready', name, blob });
          timer.current = setTimeout(() => {
            if (seq.current === mine) dismiss();
          }, READY_TTL_MS);
        } else {
          put(null);
          await saveBlob(blob, name);
        }
      } catch (err) {
        put({ phase: 'error', name, message: (err as Error).message || 'не удалось скачать' });
      }
    },
    [dismiss],
  );

  /** Must be called straight from the tap on «Сохранить». The blob is let go
   *  once the sheet is dismissed or the file saved. */
  const save = useCallback(
    (s: Extract<SaveState, { phase: 'ready' }>) => {
      void saveBlob(s.blob, s.name).then(() => dismiss());
    },
    [dismiss],
  );

  return { state, start, save, dismiss };
}

/** The status line for a save state, shared by the file panel and the chat chip. */
export function saveStatusText(s: NonNullable<SaveState>): string {
  if (s.phase === 'loading') return `Загружаю ${s.name}…${s.pct !== null ? ` ${s.pct}%` : ''}`;
  if (s.phase === 'ready') return `Файл готов: ${s.name}`;
  return `Не скачалось ${s.name}: ${s.message}`;
}
