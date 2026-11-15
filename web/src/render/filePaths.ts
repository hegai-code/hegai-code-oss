import { FS_PEEK_EXTENSIONS } from '@cc-remote/shared';

/** Previews drawn under one answer at most — a list of twenty screenshots is a
 *  report to open, not a strip to scroll. */
export const MAX_PREVIEW_PATHS = 6;

/** A URL, with its scheme: removed before matching so `https://x.com/a/b.png`
 *  never becomes a path on this machine. */
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`)\]]*/gi;

// One path segment. Unicode letters on purpose: `отчёт/итог.md` is an ordinary
// path. Spaces are handled by the two rules in `findPreviewPaths`, not here.
const SEG = String.raw`[\p{L}\p{N}_.@+~%=#-]+`;
const EXT = FS_PEEK_EXTENSIONS.join('|');

// [drive or root] segment (separator segment)* .ext — and not the middle of a
// longer word or path (the lookbehind), nor a longer extension (the lookahead:
// `a.png.bak`, `a.pngx`, `a.png/b`).
const PATH_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}_.~@%=#+/\\-])((?:[A-Za-z]:[\\/]|/)?${SEG}(?:[\\/]${SEG})*\.(?:${EXT}))(?![\p{L}\p{N}_/\\-]|\.[\p{L}\p{N}])`,
  'giu',
);

/**
 * Delimited spans whose WHOLE content may be a path with spaces: a code span
 * (`` `/srv/my dir/a.png` ``), an angle-bracket link target
 * (`[x](</srv/my dir/a.png>)`) and a quoted string ("…", «…»). The delimiters
 * say where the path ends, so a space inside is part of it.
 */
const DELIMITED_RE = /`([^`\n]+)`|\]\(<([^>\n]+)>\)|"([^"\n]+)"|«([^»\n]+)»/g;

/** A whole string that is one path to a preview file (spaces allowed). */
const WHOLE_RE = new RegExp(
  String.raw`^(?:[A-Za-z]:[\\/]|/|\.{0,2}/)?[^\s<>"'\x60|*?](?:[^<>"\x60|*?\n]*[^\s<>"'\x60|*?])?\.(?:${EXT})$`,
  'iu',
);

/**
 * Paths of images and markdown files an answer names, in order of appearance,
 * for `fs.peek`: absolute POSIX (`/tmp/x/mail.png`), Windows (`C:\x\a.png`) and
 * relative ones with at least one slash (`docs/plan.md`). A bare `README.md` is
 * a word, not a path, and is left alone. Trailing punctuation never belongs to
 * the path.
 *
 * Spaces: inside a code span, an angle-bracket link or quotes the whole span is
 * the path. In plain text one space is bridged when a relative match follows a
 * rooted fragment directly (`/srv/my dir/a.png` → the whole path, not
 * `dir/a.png`); longer runs of words are ambiguous with prose and stay unparsed.
 */
export function findPreviewPaths(text: string): string[] {
  const found: { at: number; path: string }[] = [];
  const plain = text.replace(URL_RE, (u) => ' '.repeat(u.length));
  // 1. Delimited spans, blanked out afterwards so pass 2 cannot re-read a piece.
  const rest = plain.replace(DELIMITED_RE, (whole, ...groups: unknown[]) => {
    const at = groups[groups.length - 2] as number;
    const inner = (groups.slice(0, 4).find((g) => typeof g === 'string') as string).trim();
    // A relative span must reach a separator before its first space, or it is
    // a sentence that ends in a path («смотри /tmp/x.png»), not one path.
    const relativeSentence = !isAbsolutePath(inner) && inner.indexOf(' ') < inner.search(/[\\/]/);
    if (inner.includes(' ') && !relativeSentence && accept(inner)) {
      found.push({ at, path: inner });
      return ' '.repeat(whole.length);
    }
    return whole; // no space inside: pass 2 reads it like any other text
  });
  // 2. Plain text.
  for (const m of rest.matchAll(PATH_RE)) {
    let p = m[1]!;
    let at = m.index!;
    if (!isAbsolutePath(p)) {
      // A WORD that starts rooted (`web/dist` is not one), then exactly one
      // space — the same test as `bridges` in PreviewPaths.swift / .kt.
      const bridged = /(?<![^\s\x60()[\]{}<>"'«»“”„,;|*!?=#])((?:[A-Za-z]:[\\/]|\/)[^\s]*[^\s.,;:!?)»"']) $/u.exec(
        rest.slice(0, at),
      );
      if (bridged && !/\.[A-Za-z0-9]{1,8}$/.test(bridged[1]!)) {
        p = `${bridged[1]} ${p}`;
        at = bridged.index;
      }
    }
    if (accept(p)) found.push({ at, path: p });
  }
  found.sort((a, b) => a.at - b.at);
  const out: string[] = [];
  for (const { path } of found) {
    if (out.includes(path)) continue;
    out.push(path);
    if (out.length >= MAX_PREVIEW_PATHS) break;
  }
  return out;
}

function accept(p: string): boolean {
  if (!WHOLE_RE.test(p)) return false;
  const rooted = isAbsolutePath(p);
  if (p.startsWith('//')) return false; // a network share, not this machine
  // A bare name has no separator at all.
  if (!rooted && !/[\\/]/.test(p)) return false;
  // `www.example.com/a/b.png` without its scheme is a site, not a file.
  if (!rooted && /^www\./i.test(p)) return false;
  return true;
}

/** Whether the path is a markdown file (otherwise it is a picture). */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

/** Whether the path is absolute — a stated fact rather than a guess. */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}

/** The last path segment. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}
