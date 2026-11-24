import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  FsDownloadResult,
  FsListResult,
  FsUploadBeginResult,
} from '@cc-remote/shared';
import { FS_CHUNK_BYTES, FS_MAX_UPLOAD_BYTES } from '@cc-remote/shared';
import { newId } from '../../lib.js';
import { pullBytes } from './pullBytes.js';
import type { useCentral } from '../../useCentral.js';

type Central = ReturnType<typeof useCentral>;

/**
 * Data layer for the file manager: one listing, a cache, and the upload queue.
 *
 * Two guards here are not optional, and both protect against failures that are
 * silent rather than loud.
 *
 * A **request generation** per pane: click two folders quickly and the slower
 * answer arrives last, leaving the view showing a directory you are no longer
 * in — with no error anywhere. The deleted Files panel had this and it is the
 * one idea worth carrying over wholesale.
 *
 * An **in-flight cap**: nothing in this product rate-limits RPC. A tree that
 * re-fires a listing per node per render fills the agent's outbound queue, and
 * the hub drops a peer that cannot drain — so a careless component does not
 * render slowly, it takes the machine offline.
 */

/** Concurrent RPCs this screen will have outstanding. */
const MAX_INFLIGHT = 6;
/** Files uploaded at once. One socket, so parallel streams only fight. */
const MAX_PARALLEL_UPLOADS = 2;
/** Assembled in the tab's memory, so this is a memory budget, not a disk one. */
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = FS_MAX_UPLOAD_BYTES;

export interface UploadRow {
  id: string;
  name: string;
  size: number;
  sent: number;
  status: 'queued' | 'sending' | 'done' | 'failed';
  error?: string;
  /** Kept so «Повторить» does not make the person find the file again. */
  file: File;
  dir: string;
  /** Which machine and project this row belongs to. Without it a tray row
   *  survived a navigation and «Повторить» re-sent the file into whatever
   *  project was open now — silently, into the wrong place. */
  key: string;
}

/** Directories kept in the listing cache. Walking a big tree would otherwise
 *  retain every directory visited for the life of the page. */
const MAX_CACHED_DIRS = 60;

function trimCache(cache: Map<string, FsListResult>): void {
  // Map preserves insertion order, so the oldest key is the first one.
  while (cache.size > MAX_CACHED_DIRS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** A tiny semaphore. Keeps the fan-out honest without a dependency. */
function makeLimiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

export interface FilesApi {
  /** The socket is up. Every caller that fires on mount must wait for this:
   *  a cold load of a deep URL otherwise rejects with "not connected" and the
   *  person sees an error on a page that was about to work. */
  ready: boolean;
  entries: FsListResult | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  list: (rel: string) => Promise<FsListResult>;
  read: (rel: string) => Promise<{ content: string; truncated: boolean }>;
  download: (rel: string, onProgress?: (loaded: number, total: number) => void) => Promise<Blob>;
  readObjectUrl: (rel: string, maxBytes: number) => Promise<string>;
  mkdir: (rel: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  trash: (rel: string) => Promise<string>;
  uploads: UploadRow[];
  addUploads: (files: { file: File; dir: string }[]) => void;
  retryUpload: (id: string) => void;
  dismissUpload: (id: string) => void;
}

export function useFiles(
  central: Central,
  machineId: string | undefined,
  root: string | undefined,
  rel: string,
): FilesApi {
  // Tagged with the directory it belongs to. Storing the bare listing let a
  // navigation render the PREVIOUS directory's rows while `rel` already pointed
  // at the new one — and the row actions compute their path from `rel`, so
  // deleting a visible row could delete a same-named file in the directory you
  // had just opened. Pairing the data with its key makes that structurally
  // impossible rather than a thing to remember.
  const [entriesState, setEntries] = useState<{ key: string; data: FsListResult } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [nonce, setNonce] = useState(0);

  const listGen = useRef(0);
  const cache = useRef(new Map<string, FsListResult>());
  const limit = useRef(makeLimiter(MAX_INFLIGHT));
  const uploadLimit = useRef(makeLimiter(MAX_PARALLEL_UPLOADS));

  const { rpc } = central;
  const key = machineId && root ? `${machineId}|${root}` : '';

  const call = useCallback(
    <T,>(method: Parameters<Central['rpc']>[1], params: Record<string, unknown>): Promise<T> =>
      limit.current(() => rpc<T>(machineId ?? '', method, { cwd: root, ...params })),
    [rpc, machineId, root],
  );

  const list = useCallback(
    (target: string): Promise<FsListResult> =>
      call<FsListResult>('fs.list', { path: target }),
    [call],
  );

  // Switching machine or root invalidates everything: a cached listing from
  // another machine is not stale, it is wrong.
  useEffect(() => {
    cache.current.clear();
  }, [key]);

  // `rpc` changes identity when the socket reopens (it is a useCallback over
  // `send`), so a reconnect refreshes the current directory for free. Debounced,
  // because a hub restart brings every machine back within a second.
  useEffect(() => {
    if (!machineId || !root) {
      setEntries(null);
      return;
    }
    // Wait for the socket. A cold load of a deep /w/files URL mounts this
    // before `hello` has been answered, and firing then rejects with "not
    // connected" — which surfaced as a scary red toast on a page that was about
    // to work perfectly. Chat guards the same way for the same reason, and
    // `status` in the deps is what re-runs this the moment the socket opens.
    if (central.status !== 'open') return;
    const gen = ++listGen.current;
    const cacheKey = `${key}|${rel}`;
    const cached = cache.current.get(cacheKey);
    if (cached) setEntries({ key: cacheKey, data: cached });
    else setLoading(true);
    setError(null);

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const r = await list(rel);
          if (gen !== listGen.current) return; // a later directory won the race
          cache.current.set(cacheKey, r);
          trimCache(cache.current);
          setEntries({ key: cacheKey, data: r });
          setError(null);
        } catch (err) {
          if (gen !== listGen.current) return;
          setError((err as Error).message);
          // The last good listing for THIS directory stays on screen: losing
          // your place because a link blipped is worse than a stale row. A
          // listing for a DIFFERENT directory never does — see `entries` below.
          if (!cached) setEntries(null);
        } finally {
          if (gen === listGen.current) setLoading(false);
        }
      })();
    }, cached ? 0 : 60);
    return () => clearTimeout(timer);
  }, [key, rel, list, machineId, root, nonce, central.status]);

  const cacheKey = `${key}|${rel}`;
  /** Never a listing from another directory. */
  const entries = entriesState && entriesState.key === cacheKey ? entriesState.data : null;

  const reload = useCallback(() => {
    cache.current.delete(`${key}|${rel}`);
    setNonce((n) => n + 1);
  }, [key, rel]);

  const read = useCallback(
    async (target: string) => {
      const r = await call<{ content: string; truncated: boolean }>('fs.read', { path: target });
      return { content: r.content, truncated: r.truncated };
    },
    [call],
  );

  /** One file as a Blob — the loop and its guards live in `pullBytes`. */
  const fetchBytes = useCallback(
    (target: string, maxBytes: number, onProgress?: (loaded: number, total: number) => void): Promise<Blob> =>
      pullBytes(
        (offset, length) => call<FsDownloadResult>('fs.download', { path: target, offset, length }),
        maxBytes,
        onProgress,
      ),
    [call],
  );

  /** The file's bytes, with progress. Saving is the caller's job: it happens
   *  from a user gesture (`saveFile.ts`), which this await has long outlived. */
  const download = useCallback(
    (target: string, onProgress?: (loaded: number, total: number) => void): Promise<Blob> =>
      fetchBytes(target, MAX_DOWNLOAD_BYTES, onProgress),
    [fetchBytes],
  );

  /** An object URL for a preview. The CALLER owns revoking it. */
  const readObjectUrl = useCallback(
    async (target: string, maxBytes: number): Promise<string> =>
      URL.createObjectURL(await fetchBytes(target, maxBytes)),
    [fetchBytes],
  );

  const mkdir = useCallback(
    async (target: string) => {
      await call('fs.mkdir', { path: target });
      reload();
    },
    [call, reload],
  );

  const rename = useCallback(
    async (from: string, to: string) => {
      await call('fs.rename', { from, to });
      reload();
    },
    [call, reload],
  );

  const trash = useCallback(
    async (target: string) => {
      const r = await call<{ movedTo: string }>('fs.trash', { path: target });
      reload();
      return r.movedTo;
    },
    [call, reload],
  );

  /** One file, in windows. Reads slices from disk so a big file never lands in
   *  the tab's memory whole. */
  const runUpload = useCallback(
    async (row: UploadRow) => {
      const set = (patch: Partial<UploadRow>): void =>
        setUploads((prev) => prev.map((u) => (u.id === row.id ? { ...u, ...patch } : u)));
      set({ status: 'sending', sent: 0, error: undefined });
      let uploadId: string | undefined;
      try {
        const begun = await call<FsUploadBeginResult>('fs.upload.begin', {
          dir: row.dir,
          name: row.name,
          size: row.size,
        });
        uploadId = begun.uploadId;
        let offset = 0;
        while (offset < row.size) {
          const slice = row.file.slice(offset, Math.min(offset + FS_CHUNK_BYTES, row.size));
          const buf = new Uint8Array(await slice.arrayBuffer());
          let binary = '';
          for (let i = 0; i < buf.length; i += 1) binary += String.fromCharCode(buf[i]!);
          await call('fs.upload.chunk', { uploadId, offset, data: btoa(binary) });
          offset += buf.length;
          set({ sent: offset });
        }
        await call('fs.upload.commit', { uploadId });
        set({ status: 'done', sent: row.size });
        reload();
      } catch (err) {
        // The File handle stays on the row, so «Повторить» does not make the
        // person find it again — the same idea as the composer putting a refused
        // attachment back.
        set({ status: 'failed', error: (err as Error).message });
        if (uploadId) await call('fs.upload.abort', { uploadId }).catch(() => {});
      }
    },
    [call, reload],
  );

  const addUploads = useCallback(
    (picked: { file: File; dir: string }[]) => {
      const rows: UploadRow[] = [];
      for (const { file, dir } of picked) {
        rows.push({
          id: newId(`${Date.now()}-`),
          name: file.name,
          size: file.size,
          sent: 0,
          status: file.size > MAX_UPLOAD_BYTES ? 'failed' : 'queued',
          error: file.size > MAX_UPLOAD_BYTES ? 'слишком большой — используйте git или scp' : undefined,
          file,
          dir,
          key,
        });
      }
      setUploads((prev) => [...prev, ...rows]);
      for (const row of rows) {
        if (row.status !== 'queued') continue;
        void uploadLimit.current(() => runUpload(row));
      }
    },
    [runUpload],
  );

  // `uploads` read through a ref, so this callback does not change identity on
  // every tray update — and so the work starts HERE rather than inside a state
  // updater, which React may invoke twice and would then upload twice.
  const uploadsRef = useRef<UploadRow[]>([]);
  useEffect(() => {
    uploadsRef.current = uploads;
  }, [uploads]);

  const retryUpload = useCallback(
    (id: string) => {
      const row = uploadsRef.current.find((u) => u.id === id);
      if (!row || row.key !== key) return;
      // Mark it queued first: without this a second click while the retry is
      // still waiting for a slot enqueues the same file again.
      if (row.status === 'queued' || row.status === 'sending') return;
      setUploads((prev) =>
        prev.map((u) => (u.id === id ? { ...u, status: 'queued', error: undefined } : u)),
      );
      void uploadLimit.current(() => runUpload(row));
    },
    [runUpload, key],
  );

  const dismissUpload = useCallback(
    (id: string) => setUploads((prev) => prev.filter((u) => u.id !== id)),
    [],
  );

  return {
    ready: central.status === 'open',
    entries,
    loading,
    error,
    reload,
    list,
    read,
    download,
    readObjectUrl,
    mkdir,
    rename,
    trash,
    uploads: uploads.filter((u) => u.key === key),
    addUploads,
    retryUpload,
    dismissUpload,
  };
}
