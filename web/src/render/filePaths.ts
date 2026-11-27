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

/** Files a chat chip offers to open or save (never previewed inline except
 *  video, on demand). Disjoint from `FS_PEEK_EXTENSIONS`. */
export const FILE_LINK_EXTENSIONS = [
  'mp4', 'mov', 'webm', 'm4v', 'mkv', 'mp3', 'wav', 'm4a', 'ogg', 'flac',
  'pdf', 'zip', 'tar', 'gz', 'tgz', '7z', 'csv', 'tsv', 'json', 'txt', 'log',
  'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'html', 'svg', 'psd', 'key',
] as const;
export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm', 'm4v'] as const;

// [drive or root] segment (separator segment)* .ext — and not the middle of a
// longer word or path (the lookbehind), nor a longer extension (the lookahead:
// `a.png.bak`, `a.pngx`, `a.png/b`).
const pathRe = (ext: string) =>
  new RegExp(
    String.raw`(?<![\p{L}\p{N}_.~@%=#+/\\-])((?:[A-Za-z]:[\\/]|/)?${SEG}(?:[\\/]${SEG})*\.(?:${ext}))(?![\p{L}\p{N}_/\\-]|\.[\p{L}\p{N}])`,
    'giu',
  );

/**
 * Delimited spans whose WHOLE content may be a path with spaces: a code span
 * (`` `/srv/my dir/a.png` ``), an angle-bracket link target
 * (`[x](</srv/my dir/a.png>)`) and a quoted string ("…", «…»). The delimiters
 * say where the path ends, so a space inside is part of it.
 */
const DELIMITED_RE = /`([^`\n]+)`|\]\(<([^>\n]+)>\)|"([^"\n]+)"|«([^»\n]+)»/g;

/** A whole string that is one path to a file with one of the extensions (spaces allowed). */
const wholeRe = (ext: string) =>
  new RegExp(
    String.raw`^(?:[A-Za-z]:[\\/]|/|\.{0,2}/)?[^\s<>"'\x60|*?](?:[^<>"\x60|*?\n]*[^\s<>"'\x60|*?])?\.(?:${ext})$`,
    'iu',
  );

interface Matcher {
  path: RegExp;
  whole: RegExp;
}
const PEEK: Matcher = { path: pathRe(FS_PEEK_EXTENSIONS.join('|')), whole: wholeRe(FS_PEEK_EXTENSIONS.join('|')) };
const LINK: Matcher = { path: pathRe(FILE_LINK_EXTENSIONS.join('|')), whole: wholeRe(FILE_LINK_EXTENSIONS.join('|')) };

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
  return findPaths(text, PEEK);
}

/** Paths of other workspace files an answer names (video, pdf, archives…), for
 *  a chip that opens or saves them. Same rules as `findPreviewPaths`. */
export function findFilePaths(text: string): string[] {
  return findPaths(text, LINK);
}

/** Whether the path is a video the browser can play. */
export function isVideoPath(path: string): boolean {
  return new RegExp(String.raw`\.(?:${VIDEO_EXTENSIONS.join('|')})$`, 'i').test(path);
}

function findPaths(text: string, m: Matcher): string[] {
  const found: { at: number; path: string }[] = [];
  const plain = text.replace(URL_RE, (u) => ' '.repeat(u.length));
  // 1. Delimited spans, blanked out afterwards so pass 2 cannot re-read a piece.
  const rest = plain.replace(DELIMITED_RE, (whole, ...groups: unknown[]) => {
    const at = groups[groups.length - 2] as number;
    const inner = (groups.slice(0, 4).find((g) => typeof g === 'string') as string).trim();
    // A relative span must reach a separator before its first space, or it is
    // a sentence that ends in a path («смотри /tmp/x.png»), not one path.
    const relativeSentence = !isAbsolutePath(inner) && inner.indexOf(' ') < inner.search(/[\\/]/);
    if (inner.includes(' ') && !relativeSentence && accept(inner, m)) {
      found.push({ at, path: inner });
      return ' '.repeat(whole.length);
    }
    return whole; // no space inside: pass 2 reads it like any other text
  });
  // 2. Plain text.
  for (const hit of rest.matchAll(m.path)) {
    let p = hit[1]!;
    let at = hit.index!;
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
    if (accept(p, m)) found.push({ at, path: p });
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

function accept(p: string, m: Matcher): boolean {
  if (!m.whole.test(p)) return false;
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

/** An error that is final for this viewer — the file is not there, is not a
 *  file, or lies outside what they may read (the agent: outside the session's
 *  folder; the hub: outside a shared project's root, «Read-only workspace
 *  access.») — as opposed to a dropped socket: only the first hides the chip. */
export function isMissingFileError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /ENOENT|not found|no such file|is a directory|EISDIR|escapes working directory|outside this project|read-only workspace access/i.test(
    m,
  );
}

/** First segments of absolute paths that are a machine's file system. Anything
 *  else rooted (`/w/reports/…`, `/dl/…`) is a route of the hub. Same list in
 *  PreviewPaths.swift / .kt. */
const FS_ROOTS = new Set([
  'home', 'Users', 'srv', 'tmp', 'root', 'opt', 'var', 'mnt', 'Volumes', 'private', 'etc', 'usr',
  'workspace', 'workspaces', 'data', 'media', 'run', 'Library', 'Applications', 'nix',
]);

function decodeLoose(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Extensions that make a slash-less relative link (`report.md`,
 *  `m-glossary.mjs:28`) a file; `example.com` or `site.ru` stay links. */
const CODE_TEXT_EXTENSIONS = [
  'ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'py', 'rb', 'go', 'rs', 'swift', 'kt', 'kts', 'java', 'c', 'h', 'cpp',
  'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'ini', 'conf', 'env', 'sql', 'css', 'scss', 'xml', 'txt', 'log',
  'html', 'htm',
];
const KNOWN_EXT = new Set<string>([...FILE_LINK_EXTENSIONS, ...FS_PEEK_EXTENSIONS, ...CODE_TEXT_EXTENSIONS]);

/**
 * The path on the session's machine that a markdown link points at, or null
 * when the link is something else (a site, an anchor, a route of the hub).
 * An agent writes `[x](/home/me/out/a.pdf)`, `[x](content/README.md)` or
 * `[f.mjs:28](/srv/p/f.mjs:28)`; the browser would turn those into broken
 * addresses on the hub. Line suffixes (`:12`, `:12:3`, `#L12`, `#L12-L20`) and
 * a fragment after the extension (`README.md#install`) are cut.
 */
export function fileLinkTarget(href: string): string | null {
  const h = href.trim();
  if (!h) return null;
  let raw: string; // before decoding, so `%23` / `%3F` stay part of the name
  let relative = false;
  let fileUrl = false;
  if (/^file:\/\//i.test(h)) {
    raw = h.replace(/^file:\/\/(?:localhost)?/i, '');
    fileUrl = true;
  } else if (/^[A-Za-z]:(?:[\\/]|%5C|%2F)/i.test(h)) {
    raw = h;
  } else if (/^[^/\\:?#]+\.[A-Za-z0-9]{1,8}:\d+(?::\d+)?(?:[#?]|$)/.test(h)) {
    raw = h; // `report.md:28` — a name with a line, not a scheme
    relative = true;
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(h) || /^[#?]/.test(h) || h.startsWith('//')) {
    return null;
  } else if (h.startsWith('~')) {
    // The agent does not expand `~` (it would read `<cwd>/~/…`), so a button
    // that can only fail is worse than the plain text.
    return null;
  } else if (h.startsWith('/')) {
    if (!FS_ROOTS.has(h.split(/[/?#]/)[1] ?? '')) return null;
    raw = h;
  } else {
    if (/^www\./i.test(h)) return null;
    raw = h;
    relative = true;
  }
  // Fragment and query go before decoding: `a.pdf#page=2`, `a.pdf?x=1`, `#L12`.
  let path = decodeLoose(raw.replace(/[#?].*$/s, '')).replace(/(?<=[^:]):\d+(?::\d+)?$/, '');
  if (fileUrl) {
    if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
    else if (!path.startsWith('/')) return null;
  }
  if (!path || path === '/') return null;
  if (relative && !/[\\/]/.test(path)) {
    const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
    if (!ext || !KNOWN_EXT.has(ext)) return null;
  }
  return path;
}

/** A relative link inside an opened file, resolved from that file's folder
 *  (`docs/api` + `../a.md` → `docs/a.md`). Absolute, `~` and drive paths stay. */
export function resolveFromDir(dir: string | null, path: string): string {
  if (!dir || isAbsolutePath(path) || path.startsWith('~')) return path;
  const out: string[] = [];
  for (const seg of `${dir}/${path}`.split(/[\\/]/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop();
    else out.push(seg);
  }
  return (dir.startsWith('/') ? '/' : '') + out.join('/');
}

/** The folder of a path (empty for a bare name). */
export function dirName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i > 0 ? path.slice(0, i) : i === 0 ? '/' : '';
}

/** The size ceiling message of `pullBytes`, a refusal to read a huge file. */
const TOO_BIG_RE = /слишком большой|too large/i;

/** A person's sentence for a failed open of the file at `path` (see the
 *  «Ссылки агента на файлы» task: the same wording in iOS and Android). */
export function fileOpenErrorText(e: unknown, path: string): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/escapes working directory|outside this project|read-only workspace access|outside/i.test(m)) {
    return 'Файл вне папки проекта — из приложения его не открыть. Попросите агента выложить файл ссылкой.';
  }
  if (/ENOENT|not found|no such file/i.test(m)) return `Файла уже нет: ${fileName(path)}`;
  if (/EISDIR|is a directory/i.test(m)) return `Это папка, а не файл: ${path}`;
  if (TOO_BIG_RE.test(m)) {
    return 'Файл больше 64 МБ — откройте его на компьютере или попросите агента выложить ссылкой.';
  }
  return `Не удалось открыть файл: ${m}`;
}
