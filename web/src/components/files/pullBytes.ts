import type { FsDownloadResult } from '@cc-remote/shared';
import { FS_CHUNK_BYTES } from '@cc-remote/shared';

/** One ranged read — the `fs.download` / `fs.peek` call with its offset filled in. */
export type ReadWindow = (offset: number, length: number) => Promise<FsDownloadResult>;

/**
 * Pull a file window by window.
 *
 * One implementation for every reader of the `fs.download` result shape: the
 * file manager's download and image preview, and the chat's `fs.peek`
 * previews. A second loop would quietly lose the size ceiling or the mtime
 * check — a file that grew after it was listed could blow the tab's memory, and
 * one rewritten mid-transfer would produce a picture that never existed.
 *
 * `size` and `mtime` ride every window; a change between them means two
 * generations, and stitching those together is worse than failing.
 *
 * `clip`: a file longer than `maxBytes` is read up to `maxBytes` and reported
 * `truncated` instead of refused — for text previews, where the head is useful.
 */
async function pull(
  read: ReadWindow,
  maxBytes: number,
  clip: boolean,
  onProgress?: (loaded: number, total: number) => void,
): Promise<{ blob: Blob; truncated: boolean }> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  let first: { mtime: number; size: number } | undefined;
  let truncated = false;
  for (;;) {
    const w = await read(offset, Math.min(FS_CHUNK_BYTES, clip ? maxBytes - offset : FS_CHUNK_BYTES));
    if (w.size > maxBytes && !clip) {
      throw new Error('файл слишком большой для браузера — скопируйте путь');
    }
    // mtime is rounded to the millisecond, so size is compared too: a rewrite
    // inside one millisecond still changes one of the two.
    if (first === undefined) first = { mtime: w.mtime, size: w.size };
    else if (w.mtime !== first.mtime || w.size !== first.size) throw new Error('файл изменился во время чтения');
    const bin = atob(w.data);
    if (w.offset !== offset || bin.length !== w.bytes) throw new Error('чтение сбилось');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    parts.push(bytes);
    offset += w.bytes;
    onProgress?.(offset, w.size);
    if (w.eof) break;
    if (clip && offset >= maxBytes) {
      truncated = true;
      break;
    }
    if (w.bytes === 0) throw new Error('чтение остановилось');
  }
  return { blob: new Blob(parts as BlobPart[]), truncated };
}

/** The whole file as a Blob; refuses one over `maxBytes`. */
export async function pullBytes(
  read: ReadWindow,
  maxBytes: number,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Blob> {
  return (await pull(read, maxBytes, false, onProgress)).blob;
}

/** The first `maxBytes` of the file, and whether there was more. */
export function pullHead(read: ReadWindow, maxBytes: number): Promise<{ blob: Blob; truncated: boolean }> {
  return pull(read, maxBytes, true);
}
