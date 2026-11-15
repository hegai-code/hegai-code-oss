import { readFileHead, readFileTail } from './file-range.js';

/**
 * Did a person name this Claude session, or is its title the CLI's guess?
 *
 * `listSessions()` cannot say: its `customTitle` is `customTitle || aiTitle`,
 * so «Вопрос о новости» — what the CLI wrote from the first message alone,
 * before any work — arrives looking exactly like a rename. The transcript does
 * know, a rename being a `custom-title` record and the guess an `ai-title` one.
 * The window is the SDK's own (64 KiB at each end, the CLI re-appends to stay in
 * it): a record outside it is a title the SDK would not have shown either.
 */
const WINDOW_BYTES = 64 * 1024;
const RENAME_MARK = '"type":"custom-title"';

const cache = new Map<string, { mtimeMs: number; renamed: boolean }>();

/** True only when the title is provably nobody's choice; unsure means false. */
export async function claudeTitleIsDerived(
  customTitle: string | undefined,
  filePath: string | undefined,
  mtimeMs: number,
): Promise<boolean> {
  if (!customTitle) return true;
  if (!filePath) return false;
  const hit = cache.get(filePath);
  if (hit && hit.mtimeMs === mtimeMs) return !hit.renamed;
  try {
    const renamed =
      (await readFileTail(filePath, WINDOW_BYTES)).includes(RENAME_MARK) ||
      (await readFileHead(filePath, WINDOW_BYTES)).includes(RENAME_MARK);
    cache.set(filePath, { mtimeMs, renamed });
    return !renamed;
  } catch {
    return false; // vanished or unreadable: do not cache a guess
  }
}
