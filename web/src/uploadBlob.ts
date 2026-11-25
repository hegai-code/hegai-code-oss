import type { RpcMethod, FsUploadBeginResult, FsUploadCommitResult } from '@cc-remote/shared';
import { FS_CHUNK_BYTES } from '@cc-remote/shared';

/** An RPC to one machine with the folder already bound in. */
export type UploadCall = <T = unknown>(method: RpcMethod, params: Record<string, unknown>) => Promise<T>;

/** One window of `blob` as base64. Read from the slice, so a big file never sits
 *  in the tab's memory whole. */
export async function sliceB64(blob: Blob, offset: number): Promise<{ data: string; bytes: number }> {
  const slice = blob.slice(offset, Math.min(offset + FS_CHUNK_BYTES, blob.size));
  const buf = new Uint8Array(await slice.arrayBuffer());
  let binary = '';
  for (let i = 0; i < buf.length; i += 1) binary += String.fromCharCode(buf[i]!);
  return { data: btoa(binary), bytes: buf.length };
}

/**
 * One file, in windows: begin, chunks, commit; abort when anything fails or the
 * signal fires. Shared by the file manager and the composer's big attachments.
 * Resolves with what the agent committed (its final name may be suffixed).
 */
export async function uploadBlob(
  call: UploadCall,
  opts: {
    dir: string;
    name: string;
    blob: Blob;
    onProgress?: (sent: number) => void;
    signal?: AbortSignal;
  },
): Promise<FsUploadCommitResult> {
  const { blob, signal } = opts;
  const aborted = (): Error => new Error('Загрузка отменена');
  let uploadId: string | undefined;
  try {
    if (signal?.aborted) throw aborted();
    const begun = await call<FsUploadBeginResult>('fs.upload.begin', {
      dir: opts.dir,
      name: opts.name,
      size: blob.size,
    });
    uploadId = begun.uploadId;
    let offset = 0;
    while (offset < blob.size) {
      if (signal?.aborted) throw aborted();
      const { data, bytes } = await sliceB64(blob, offset);
      await call('fs.upload.chunk', { uploadId, offset, data });
      offset += bytes;
      opts.onProgress?.(offset);
    }
    if (signal?.aborted) throw aborted();
    const done = await call<FsUploadCommitResult>('fs.upload.commit', { uploadId });
    uploadId = undefined;
    opts.onProgress?.(blob.size);
    return done;
  } catch (err) {
    if (uploadId) await call('fs.upload.abort', { uploadId }).catch(() => {});
    throw err;
  }
}
