/**
 * Saving a file the browser already holds as a Blob.
 *
 * Two rules decide everything here, both learned on iOS Safari / PWA:
 *  - `click()` on an anchor and `navigator.share()` only work inside a user
 *    gesture. A download that first awaits bytes over the socket has lost the
 *    gesture by the time it has them, and WebKit drops the click silently.
 *  - The blob URL must outlive the click: WebKit reads it after the handler
 *    returns, so revoking immediately cancels the save.
 *
 * So on a touch device that can share files, the caller fetches the bytes,
 * then shows «Файл готов — Сохранить» and calls `saveBlob` from THAT tap.
 * Desktop keeps the direct download.
 */

/** How long a blob URL lives after the anchor was clicked. */
export const REVOKE_AFTER_MS = 60_000;

/** The slice of `navigator`/`document`/`URL` this module touches, for tests. */
export interface SaveEnv {
  navigator: {
    canShare?: (data: { files: File[] }) => boolean;
    share?: (data: { files: File[]; title?: string }) => Promise<void>;
  };
  coarsePointer: boolean;
  createObjectURL: (b: Blob) => string;
  revokeObjectURL: (u: string) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  createAnchor: () => {
    href: string;
    download: string;
    rel?: string;
    style?: { display: string };
    click: () => void;
    remove: () => void;
  };
  append: (a: unknown) => void;
}

export function browserEnv(): SaveEnv {
  return {
    navigator: navigator as SaveEnv['navigator'],
    coarsePointer: typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches,
    createObjectURL: (b) => URL.createObjectURL(b),
    revokeObjectURL: (u) => URL.revokeObjectURL(u),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    createAnchor: () => document.createElement('a'),
    append: (a) => document.body.appendChild(a as Node),
  };
}

function toFile(blob: Blob, name: string): File {
  return blob instanceof File && blob.name === name ? blob : new File([blob], name, { type: withMime(blob, name).type });
}

const MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip',
  tar: 'application/x-tar', '7z': 'application/x-7z-compressed',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain', log: 'text/plain', json: 'application/json',
  html: 'text/html', md: 'text/markdown',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
};

/** The MIME type for a file name; `application/octet-stream` when unknown. */
export function mimeForName(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return MIME[ext] ?? 'application/octet-stream';
}

/** The same bytes with a type by extension (fetched blobs have none, and the
 *  share sheet and Safari's save choose their action by type). */
export function withMime(blob: Blob, name: string): Blob {
  return blob.type ? blob : new Blob([blob], { type: mimeForName(name) });
}

/** Whether the share sheet can take this file. */
export function canShareFile(blob: Blob, name: string, env: SaveEnv = browserEnv()): boolean {
  try {
    return typeof env.navigator.share === 'function' && !!env.navigator.canShare?.({ files: [toFile(blob, name)] });
  } catch {
    return false;
  }
}

/**
 * Whether saving needs a fresh tap after the bytes arrived: any touch device,
 * share support or not — the fetch outlived the gesture, and WebKit drops an
 * anchor click made without one just as it drops a share. Desktop (fine
 * pointer) never does.
 */
export function needsSaveTap(env: SaveEnv = browserEnv()): boolean {
  return env.coarsePointer;
}

/** Anchor download: in the DOM, blob URL revoked late. */
export function anchorDownload(url: string, name: string, env: SaveEnv = browserEnv(), revoke = false): void {
  const a = env.createAnchor();
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  if (a.style) a.style.display = 'none';
  env.append(a);
  a.click();
  a.remove();
  if (revoke) env.setTimeout(() => env.revokeObjectURL(url), REVOKE_AFTER_MS);
}

/**
 * Save now. Must run synchronously inside a user gesture. Prefers the share
 * sheet on touch devices that can share the file (Save to Files / Save Video), else an anchor.
 * Resolves `'shared'`, `'downloaded'` or `'cancelled'` (the user dismissed the
 * sheet); a share that fails for another reason falls back to the anchor.
 */
export async function saveBlob(
  blob: Blob,
  name: string,
  env: SaveEnv = browserEnv(),
): Promise<'shared' | 'downloaded' | 'cancelled'> {
  blob = withMime(blob, name);
  if (canShareFile(blob, name, env) && env.coarsePointer) {
    try {
      // Called first, synchronously: nothing is awaited before share().
      await env.navigator.share!({ files: [toFile(blob, name)], title: name });
      return 'shared';
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return 'cancelled';
      // fall through to the anchor
    }
  }
  anchorDownload(env.createObjectURL(blob), name, env, true);
  return 'downloaded';
}
