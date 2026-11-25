import type { FsListResult, FsReadResult, RpcMethod } from '@cc-remote/shared';
import { CHAT_UPLOAD_DIR, FS_MAX_UPLOAD_BYTES } from '@cc-remote/shared';
import { uploadBlob, type UploadCall } from './uploadBlob.js';

/**
 * Chat attachments over the inline limit: written to the machine, and the
 * message names their path (`withUploadedFiles`).
 *
 * They land in `.hegai-uploads/` at the project's root. A repo may auto-deploy
 * from its working tree, and people's files must never reach git: the folder
 * carries its own `.gitignore` (`*`), and a file is not uploaded if that
 * cannot be made sure of.
 */
export { CHAT_UPLOAD_DIR };

const GITIGNORE = '.gitignore';

/** Hub refusal for anyone who is not the machine's owner outside a shared root. */
const OWNER_ONLY =
  'Большие файлы здесь может загрузить только владелец машины; до 8 МБ — обычным вложением.';

/** One RPC to the machine, `cwd` NOT yet bound. */
export type MachineCall = UploadCall;

export interface ChatUploadOptions {
  /** RPC to the machine. `cwd` is added here. */
  rpc: MachineCall;
  /** Machine + folder identity, to share one `.gitignore` check between files. */
  scope: string;
  /** Project root (or the session folder) the uploads folder sits in. */
  cwd: string;
  file: Blob & { name: string };
  signal?: AbortSignal;
  onProgress?: (sent: number) => void;
}

/** `.gitignore` checks in flight, so files dropped together make it once. */
const guarding = new Map<string, Promise<void>>();

/** The agent's «already there» answer to a plain mkdir. */
const EXISTS = /уже есть|already exists|EEXIST/i;

export function describeUploadError(message: string): string {
  if (/Read-only workspace/i.test(message)) return OWNER_ONLY;
  return message;
}

/** The folder exists and holds a `.gitignore`; made when missing. */
async function ensureUploadFolder(call: MachineCall, scope: string): Promise<void> {
  const inFlight = guarding.get(scope);
  if (inFlight) return inFlight;
  const run = (async () => {
    try {
      await call('fs.mkdir', { path: CHAT_UPLOAD_DIR, recursive: false });
    } catch (err) {
      if (!EXISTS.test((err as Error).message)) throw err;
    }
    const listed = await call<FsListResult>('fs.list', { path: CHAT_UPLOAD_DIR });
    if (listed.truncated) throw new Error('В папке загрузок слишком много файлов');
    const present = listed.entries.some((e) => e.name === GITIGNORE && e.kind === 'file');
    if (present) {
      // A name proves nothing: an empty or negating file guards nothing.
      const guard = await call<FsReadResult>('fs.read', { path: `${CHAT_UPLOAD_DIR}/${GITIGNORE}` });
      if (guard.truncated || guard.content.trim() !== '*') {
        throw new Error('В .hegai-uploads чужой .gitignore — файл мог бы попасть в git');
      }
      return;
    }
    // Anything but a plain commit means the guard is not in place.
    const done = await uploadBlob(call, {
      dir: CHAT_UPLOAD_DIR,
      name: GITIGNORE,
      blob: new Blob(['*\n']),
    });
    if (!done.path.endsWith(GITIGNORE)) throw new Error('Не удалось защитить папку загрузок от git');
  })().finally(() => guarding.delete(scope));
  guarding.set(scope, run);
  return run;
}

/** Where one composer's big files go: `target` names machine + folder. */
export interface LargeUploader {
  target: string;
  upload: (file: File, hooks: { signal: AbortSignal; onProgress: (sent: number) => void }) => Promise<string>;
}

/** An uploader for a machine and folder, over the app's RPC. */
export function chatUploader(
  rpc: (machineId: string, method: RpcMethod, params: Record<string, unknown>) => Promise<unknown>,
  machineId: string,
  cwd: string,
): LargeUploader {
  const target = `${machineId}|${cwd}`;
  return {
    target,
    upload: (file, hooks) =>
      uploadChatFile({
        rpc: ((method, params) => rpc(machineId, method, params)) as MachineCall,
        scope: target,
        cwd,
        file,
        ...hooks,
      }),
  };
}

/** `cwd` + a `/`-relative path, in the separator `cwd` itself uses (Windows). */
export function joinMachinePath(cwd: string, rel: string): string {
  const windows = cwd.includes('\\') && !cwd.includes('/');
  const base = cwd.replace(/[\\/]+$/, '');
  return `${base}${windows ? '\\' : '/'}${windows ? rel.replace(/\//g, '\\') : rel}`;
}

/**
 * Upload one file into `.hegai-uploads` and return its absolute path on the
 * machine. Failures carry a message fit for the chip.
 */
export async function uploadChatFile(o: ChatUploadOptions): Promise<string> {
  if (o.file.size > FS_MAX_UPLOAD_BYTES) throw new Error('Слишком большой файл (предел 100 МБ)');
  const call: MachineCall = (method, params) => o.rpc(method, { cwd: o.cwd, ...params });
  let begun = false;
  try {
    await ensureUploadFolder(call, o.scope);
    begun = true;
    const done = await uploadBlob(call, {
      dir: CHAT_UPLOAD_DIR,
      name: o.file.name || 'attachment',
      blob: o.file,
      onProgress: o.onProgress,
      signal: o.signal,
    });
    return joinMachinePath(o.cwd, done.path);
  } catch (err) {
    const message = (err as Error).message;
    // The door was open a moment ago: the connection that began the upload is
    // gone, and the hub ties an upload to it.
    if (begun && /Read-only workspace/i.test(message)) throw new Error('Связь прервалась — повторите загрузку');
    throw new Error(describeUploadError(message));
  }
}

/** The files' paths, appended to the END of the message: the session title is
 *  taken from its start. No text — just the block. */
export function withUploadedFiles(text: string, paths: readonly string[]): string {
  if (!paths.length) return text;
  const block = `[Файлы на этой машине, читать с диска:\n${paths.map((p) => `- ${p}`).join('\n')}\n]`;
  const head = text.trimEnd();
  return head ? `${head}\n\n${block}` : block;
}
