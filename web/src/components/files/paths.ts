/** Path helpers for the file manager. Relative paths use `/` on the wire
 *  regardless of the machine's separator; only display joins the native one. */

/** Join a relative path with one more segment. */
export function joinRel(rel: string, name: string): string {
  return rel ? `${rel}/${name}` : name;
}

/** The parent of a relative path, or '' at the root. */
export function parentRel(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

/** Breadcrumb segments for a relative path. */
export function segments(rel: string): { name: string; rel: string }[] {
  if (!rel) return [];
  const parts = rel.split('/').filter(Boolean);
  const out: { name: string; rel: string }[] = [];
  let acc = '';
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    out.push({ name: p, rel: acc });
  }
  return out;
}

/**
 * Absolute path on the machine, for display and for handing to an agent.
 *
 * The separator is taken from the ROOT, not from this browser: a Windows agent
 * reports `C:\Users\...`, and a path stitched together with the browser's idea
 * of a separator is a path that machine cannot open.
 */
export function absPath(root: string, rel: string): string {
  if (!rel) return root;
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const trimmed = root.endsWith(sep) ? root.slice(0, -sep.length) : root;
  return `${trimmed}${sep}${sep === '\\' ? rel.replace(/\//g, '\\') : rel}`;
}

/** Quote a path for a shell-ish context when it contains spaces. Used when a
 *  path is dropped into a composer, where the next words are a human sentence. */
export function quoteIfSpaces(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

const TEXT_EXT = new Set([
  'txt', 'md', 'mdx', 'markdown', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sql',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'env', 'gitignore', 'dockerfile', 'lock', 'log',
  'csv', 'tsv', 'diff', 'patch', 'gradle', 'properties', 'plist', 'rst', 'tex',
]);

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico']);

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  // A leading dot is the whole name of a dotfile (`.gitignore`), not an
  // extension separator — so `.env` reads as `env`, which is in the text list.
  if (i <= 0) return name.startsWith('.') ? name.slice(1).toLowerCase() : '';
  return name.slice(i + 1).toLowerCase();
}

export function isImage(name: string): boolean {
  return IMAGE_EXT.has(extOf(name));
}

/** Whether to try reading this as text. A file with no extension is given the
 *  benefit of the doubt only when it is small enough that being wrong is cheap. */
export function isTextual(name: string, size?: number): boolean {
  const ext = extOf(name);
  if (TEXT_EXT.has(ext)) return true;
  if (!ext && (size ?? 0) < 256 * 1024) return true;
  // Common extensionless project files that are always text.
  return /^(makefile|dockerfile|readme|license|changelog|codeowners)$/i.test(name);
}
