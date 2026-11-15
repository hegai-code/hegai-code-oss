import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GitDiffFile, GitDiffLine, GitWorktree } from '@cc-remote/shared';
import { childEnv } from './child-env.js';
import { git, isSecretLike } from './git-ops.js';
import { maskSecrets } from './secret-mask.js';

/**
 * Parallel agents in git worktrees + the diff they leave behind.
 *
 * A managed worktree lives OUTSIDE the repository — `<repoParent>/.hegai-worktrees/<repo>/<branch>` —
 * unlike Claude Code's own `.claude/worktrees/*` (inside the tree, hidden from
 * the project shelf as agent scaffolding). Outside means a `git status` or a
 * search in the main checkout never sees the other agents' files.
 */

const execFileAsync = promisify(execFile);

export const WORKTREES_DIR = '.hegai-worktrees';

/** Worktrees being removed right now: RunManager.launch refuses to start a run
 *  in (or under) one of these, so a removal and a new session cannot race. */
const removing = new Set<string>();
/** Compared by REAL path, so a symlink alias of a locked folder is locked too. */
const real = (p: string): string => {
  try {
    return realpathSync(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
};
export function isBeingRemoved(cwd: string): boolean {
  if (removing.size === 0) return false;
  const abs = real(cwd);
  for (const r of removing) if (abs === r || abs.startsWith(r + path.sep)) return true;
  return false;
}

/** A private key block in a diff hides the whole file (line-by-line masking
 *  cannot see a BEGIN…END pair). */
const PEM_HEADER = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const KEY_SCAN_FILES = 300;

/** The working-tree file itself carries a private key block somewhere (a
 *  changed body line may sit beyond the diff context from its BEGIN line). */
async function holdsPrivateKey(cwd: string, rel: string): Promise<boolean> {
  // The working tree, the index and HEAD can each hold a different version
  // (a staged review shows the index): any of them with a key withholds it.
  const MAX = 4 * 1024 * 1024;
  try {
    const abs = path.join(cwd, rel);
    const st = await lstat(abs).catch(() => undefined);
    if (st?.isFile()) {
      if (st.size > MAX) return true; // too big to scan: not shown
      if (PEM_HEADER.test(await readFile(abs, 'latin1'))) return true;
    }
  } catch {
    return true;
  }
  // `:0:<path>` is explicitly stage 0, so a name like `0:key.txt` is not misread.
  for (const spec of [`:0:${rel}`, `HEAD:${rel}`]) {
    const blob = await git(cwd, ['cat-file', '-s', spec]).then((x) => Number(x.trim()), () => -1);
    if (blob < 0) continue;
    if (blob > MAX) return true;
    const text = await git(cwd, ['cat-file', '-p', spec]).catch(() => '');
    if (PEM_HEADER.test(text)) return true;
  }
  return false;
}

/** A URL safe to hand to a browser: no userinfo, no query/fragment. */
export function cleanUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:' && x.protocol !== 'http:') return undefined;
    x.username = '';
    x.password = '';
    x.search = '';
    x.hash = '';
    return x.toString();
  } catch {
    return undefined;
  }
}
/** Review diffs beyond this are cut (and say so) — a lockfile rewrite must not
 *  freeze the socket or the browser. */
export const DIFF_MAX_BYTES = 2 * 1024 * 1024;
/** The parsed result is what crosses the wire (each line becomes a JSON object,
 *  ~20x the raw bytes), so it is capped too: by lines and by untracked files. */
export const DIFF_MAX_LINES = 20_000;
export const DIFF_MAX_UNTRACKED = 500;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

interface Deps {
  /** Working directories of live runs on this machine (project-ops.ts). */
  liveCwds?: () => Promise<string[]>;
}

function errText(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  return (e.stderr || e.stdout || e.message || 'git failed').toString().trim();
}

/** The repository's main working tree, whichever linked worktree `cwd` is in. */
async function mainRoot(cwd: string): Promise<string> {
  const common = (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  // `<main>/.git` for a normal repo; a bare repo's common dir is the repo itself.
  return path.basename(common) === '.git' ? path.dirname(common) : common;
}

/** The ref work is compared against: origin's default branch, else main/master. */
async function defaultBase(cwd: string): Promise<string | undefined> {
  try {
    const ref = (await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
    if (ref) return ref;
  } catch {
    /* no origin/HEAD */
  }
  for (const b of ['main', 'master']) {
    try {
      await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]);
      return b;
    } catch {
      /* try the next */
    }
  }
  return undefined;
}

export async function validateBranchName(cwd: string, branch: string): Promise<string | null> {
  // `-x` is an option to every git subcommand below, `@{` is a reflog lookup
  // that check-ref-format --branch would happily "expand".
  if (!branch || branch.startsWith('-') || branch.includes('@{')) return `недопустимое имя ветки: ${branch}`;
  try {
    await git(cwd, ['check-ref-format', '--branch', branch]);
  } catch {
    return `недопустимое имя ветки: ${branch}`;
  }
  return null;
}

export function worktreePathFor(root: string, branch: string): string {
  // `agent/foo` must be ONE directory name, not a nested pair that a second
  // branch `agent` could never coexist with.
  const dir = branch.replace(/[\\/]+/g, '-');
  return path.join(path.dirname(root), WORKTREES_DIR, path.basename(root), dir);
}

export async function worktreeAdd(
  cwd: string,
  branch: string,
  base?: string,
): Promise<{ path: string; branch: string }> {
  const bad = await validateBranchName(cwd, branch);
  if (bad) throw new Error(bad);
  if (base !== undefined) {
    if (base.startsWith('-')) throw new Error(`недопустимая база: ${base}`);
    try {
      await git(cwd, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
    } catch {
      throw new Error(`база не найдена: ${base}`);
    }
  }
  const root = await mainRoot(cwd);
  // Without a base the new branch starts where the CALLER is (it may be a
  // linked worktree ahead of the main checkout), not at the main HEAD.
  const from = base ?? (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  const target = worktreePathFor(root, branch);
  if (await stat(target).then(() => true, () => false)) throw new Error(`папка уже существует: ${target}`);
  try {
    await git(root, ['worktree', 'add', '-b', branch, target, from]);
  } catch (err) {
    throw new Error(errText(err));
  }
  return { path: target, branch };
}

interface RawWorktree {
  path: string;
  head: string;
  branch?: string;
  prunable: boolean;
}

function parseWorktreeList(out: string): RawWorktree[] {
  const list: RawWorktree[] = [];
  for (const block of out.split(/\n\n+/)) {
    let cur: RawWorktree | undefined;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) cur = { path: line.slice(9), head: '', prunable: false };
      else if (!cur) continue;
      else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
      else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
      else if (line.startsWith('prunable')) cur.prunable = true;
    }
    if (cur) list.push(cur);
  }
  return list;
}

async function insideAny(dir: string, roots: string[]): Promise<boolean> {
  const real = await realpath(dir).catch(() => dir);
  for (const r of roots) {
    const rr = await realpath(r).catch(() => r);
    const rel = path.relative(real, rr);
    // The live cwd is the worktree or somewhere under it.
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
  }
  return false;
}

export async function worktreeList(cwd: string, deps: Deps = {}): Promise<{ worktrees: GitWorktree[] }> {
  const raw = parseWorktreeList(await git(cwd, ['worktree', 'list', '--porcelain']));
  const base = await defaultBase(cwd);
  const live = deps.liveCwds ? await deps.liveCwds().catch(() => []) : [];
  const worktrees: GitWorktree[] = [];
  for (const [i, w] of raw.entries()) {
    const entry: GitWorktree = { path: w.path, head: w.head.slice(0, 12), main: i === 0, dirty: 0 };
    if (w.branch) entry.branch = w.branch;
    if (!w.prunable) {
      try {
        const st = await git(w.path, ['status', '--porcelain', '--untracked-files=all']);
        entry.dirty = st.split('\n').filter(Boolean).length;
      } catch {
        /* folder gone */
      }
      if (i > 0 && w.branch && base && w.branch !== base) {
        try {
          const lr = (await git(cwd, ['rev-list', '--left-right', '--count', `${base}...${w.branch}`])).trim().split(/\s+/);
          entry.behind = Number(lr[0] ?? 0);
          entry.ahead = Number(lr[1] ?? 0);
        } catch {
          /* unrelated histories */
        }
      }
      if (live.length && (await insideAny(w.path, live))) entry.busy = true;
    }
    worktrees.push(entry);
  }
  return { worktrees };
}

export async function worktreeRemove(
  cwd: string,
  target: string,
  force: boolean,
  deps: Deps = {},
): Promise<{ ok: boolean; output: string }> {
  // An unknown set of live runs is not an empty one: refuse, even with force.
  let live: string[] = [];
  if (deps.liveCwds) {
    try {
      live = await deps.liveCwds();
    } catch (err) {
      return { ok: false, output: `не удалось определить, работают ли в папке сессии: ${errText(err)}` };
    }
  }
  const { worktrees } = await worktreeList(cwd, deps.liveCwds ? { liveCwds: async () => live } : deps);
  const want = await realpath(path.resolve(cwd, target)).catch(() => path.resolve(cwd, target));
  let hit: GitWorktree | undefined;
  for (const w of worktrees) {
    const real = await realpath(w.path).catch(() => w.path);
    if (real === want) hit = w;
  }
  if (!hit) return { ok: false, output: 'такого worktree нет в этом репозитории' };
  if (hit.main) return { ok: false, output: 'основную рабочую папку удалять нельзя' };
  // A live run in there would lose its cwd mid-turn — never overridable.
  if (hit.busy) return { ok: false, output: 'в этой папке работает сессия — сначала останови её' };
  if (hit.dirty > 0 && !force) {
    return { ok: false, output: `есть незакоммиченные изменения (${hit.dirty}) — нужно подтверждение` };
  }
  // From here no new run may start in this folder (RunManager.launch checks
  // isBeingRemoved); then re-check the runs that started before the lock.
  const locked = [real(want), real(hit.path)];
  for (const l of locked) removing.add(l);
  try {
    return await removeLocked(cwd, hit, want, force, deps);
  } finally {
    for (const l of locked) removing.delete(l);
  }
}

async function removeLocked(
  cwd: string,
  hit: GitWorktree,
  want: string,
  force: boolean,
  deps: Deps,
): Promise<{ ok: boolean; output: string }> {
  if (deps.liveCwds) {
    let again: string[];
    try {
      again = await deps.liveCwds();
    } catch (err) {
      return { ok: false, output: `не удалось определить, работают ли в папке сессии: ${errText(err)}` };
    }
    for (const c of again) {
      const real = await realpath(c).catch(() => c);
      if (real === want || real.startsWith(want + path.sep)) {
        return { ok: false, output: 'в этой папке работает сессия — сначала останови её' };
      }
    }
  }
  try {
    const out = await git(cwd, ['worktree', 'remove', ...(force ? ['--force'] : []), '--', hit.path]);
    return { ok: true, output: out };
  } catch (err) {
    return { ok: false, output: errText(err) };
  }
}

// ---- diff ------------------------------------------------------------------

/** Parse unified diff text (`git diff` output, possibly several files). */
export function parseUnifiedDiff(text: string): GitDiffFile[] {
  const files: GitDiffFile[] = [];
  let file: GitDiffFile | undefined;
  let hunk: GitDiffFile['hunks'][number] | undefined;
  let oldNo = 0;
  let newNo = 0;
  const push = (l: GitDiffLine) => hunk?.lines.push(l);
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const rest = line.slice(11);
      // No rename: both halves are the same path, so the middle space is exact
      // even when the name itself contains spaces.
      const n = (rest.length - 1) / 2;
      const name = Number.isInteger(n) && rest.slice(0, n).startsWith('a/') ? rest.slice(2, n) : rest.split(' b/').pop() ?? rest;
      file = { path: name, status: 'modified', additions: 0, deletions: 0, hunks: [] };
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith('new file mode')) file.status = 'added';
      else if (line.startsWith('deleted file mode')) file.status = 'deleted';
      else if (line.startsWith('rename from ')) {
        file.status = 'renamed';
        file.oldPath = line.slice(12);
      } else if (line.startsWith('rename to ')) file.path = line.slice(10);
      else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) file.binary = true;
    }
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) {
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      continue;
    }
    if (!hunk) continue;
    const c = line[0];
    if (c === '+') {
      push({ kind: '+', new: newNo++, text: line.slice(1) });
      file.additions++;
    } else if (c === '-') {
      push({ kind: '-', old: oldNo++, text: line.slice(1) });
      file.deletions++;
    } else if (c === ' ') {
      push({ kind: ' ', old: oldNo++, new: newNo++, text: line.slice(1) });
    }
    // `\ No newline at end of file` and the trailing blank are not content.
  }
  return files;
}

/** Run git, keep stdout even on exit 1 (`--no-index` exits 1 when files differ)
 *  and when the buffer cap trips. */
async function gitCapture(cwd: string, args: string[], cap: number): Promise<{ out: string; cut: boolean }> {
  try {
    const { stdout } = await execFileAsync('git', ['-c', 'core.quotePath=false', ...args], {
      cwd,
      maxBuffer: cap,
      timeout: 30_000,
      env: childEnv({ GIT_TERMINAL_PROMPT: '0' }),
    });
    return { out: stdout, cut: false };
  } catch (err) {
    const e = err as { stdout?: string; code?: string | number };
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      const s = e.stdout ?? '';
      return { out: s.slice(0, s.lastIndexOf('\n') + 1), cut: true };
    }
    if (e.code === 1 && typeof e.stdout === 'string') return { out: e.stdout, cut: false };
    throw err;
  }
}

export async function gitDiff(
  cwd: string,
  opts: { base?: string; staged?: boolean; path?: string },
): Promise<{ files: GitDiffFile[]; truncated: boolean }> {
  if (opts.base?.startsWith('-')) throw new Error(`недопустимая база: ${opts.base}`);
  const spec = opts.path ? ['--', opts.path] : [];
  const flags = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M'];
  let truncated = false;
  let budget = DIFF_MAX_BYTES;
  let text = '';
  if (opts.base) {
    const r = await gitCapture(cwd, [...flags, `${opts.base}...HEAD`, ...spec], budget);
    text = r.out;
    truncated = r.cut;
  } else if (opts.staged) {
    const r = await gitCapture(cwd, [...flags, '--cached', ...spec], budget);
    text = r.out;
    truncated = r.cut;
  } else {
    const head = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(
      (s) => s.trim(),
      () => git(cwd, ['hash-object', '-t', 'tree', '/dev/null']).then((x) => x.trim(), () => EMPTY_TREE),
    );
    const r = await gitCapture(cwd, [...flags, head, ...spec], budget);
    text = r.out;
    truncated = r.cut;
    budget -= Buffer.byteLength(text);
    if (!truncated) {
      const all = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', ...spec]))
        .split('\0')
        .filter(Boolean);
      if (all.length > DIFF_MAX_UNTRACKED) truncated = true;
      const names: string[] = [];
      for (const name of all.slice(0, DIFF_MAX_UNTRACKED)) {
        // Regular files only: a FIFO would block `git diff --no-index`, a socket
        // or device is nothing to review.
        const st = await lstat(path.join(cwd, name)).catch(() => undefined);
        if (st && (st.isFile() || st.isSymbolicLink())) names.push(name);
      }
      for (const name of names) {
        if (budget <= 0) {
          truncated = true;
          break;
        }
        const u = await gitCapture(
          cwd,
          [...flags.slice(0, 4), '--no-index', '--', '/dev/null', name],
          budget,
        ).catch(() => ({ out: '', cut: true }));
        text += u.out;
        budget -= Buffer.byteLength(u.out);
        if (u.cut) truncated = true;
      }
    }
  }
  // Credential files never leave the machine through a review: listed as
  // changed, contents withheld.
  // Everything else goes through the same masking as the transcript: an RPC
  // response is not covered by the outgoing frame redaction.
  const parsed = parseUnifiedDiff(text);
  const files: GitDiffFile[] = [];
  let scanned = 0;
  for (const f of parsed) {
    // A C-quoted name (tab/newline/escape in it) cannot be judged by name:
    // withhold rather than guess.
    const quoted = /["\\]/.test(f.path) || (f.oldPath !== undefined && /["\\]/.test(f.oldPath));
    const hold =
      quoted ||
      isSecretLike(f.path) ||
      (f.oldPath !== undefined && isSecretLike(f.oldPath)) ||
      f.hunks.some((h) => PEM_HEADER.test(h.header) || h.lines.some((l) => PEM_HEADER.test(l.text))) ||
      // Deep scan (working tree, index, HEAD; old and new name) for the first
      // KEY_SCAN_FILES files; past that, contents are withheld rather than
      // spawning thousands of processes.
      (++scanned > KEY_SCAN_FILES ||
        (await holdsPrivateKey(cwd, f.path)) ||
        (f.oldPath !== undefined && (await holdsPrivateKey(cwd, f.oldPath))));
    files.push(
      hold
        ? { ...f, hunks: [], withheld: true }
        : {
            ...f,
            hunks: f.hunks.map((h) => ({
              ...h,
              header: maskSecrets(h.header),
              lines: h.lines.map((l) => ({ ...l, text: maskSecrets(l.text) })),
            })),
          },
    );
  }
  // Cap what is SENT: lines across all files.
  let lines = 0;
  const kept: GitDiffFile[] = [];
  for (const f of files) {
    const room = DIFF_MAX_LINES - lines;
    if (room <= 0) {
      truncated = true;
      break;
    }
    const n = f.hunks.reduce((a, h) => a + h.lines.length, 0);
    if (n <= room) {
      lines += n;
      kept.push(f);
      continue;
    }
    // The first file that does not fit is shown up to the cap, not dropped.
    let left = room;
    const hunks = [];
    for (const h of f.hunks) {
      if (left <= 0) break;
      hunks.push(h.lines.length <= left ? h : { ...h, lines: h.lines.slice(0, left) });
      left -= h.lines.length;
    }
    kept.push({ ...f, hunks });
    lines = DIFF_MAX_LINES;
    truncated = true;
    break;
  }
  return { files: kept, truncated };
}

// ---- push / pull request ---------------------------------------------------

async function gitBoth(cwd: string, args: string[], timeout: number): Promise<{ ok: boolean; text: string }> {
  const env = childEnv({ GIT_TERMINAL_PROMPT: '0' });
  // Nobody is at the keyboard to accept a host key or type a passphrase.
  if (!env['GIT_SSH_COMMAND']) env['GIT_SSH_COMMAND'] = 'ssh -o BatchMode=yes';
  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024, env });
    return { ok: true, text: `${stdout}${stderr}`.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, text: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message || 'git failed' };
  }
}

/** The first URL a remote printed on a `remote:` line — Forgejo and GitHub both
 *  put the «create a pull request» link there. */
export function remoteUrlFromOutput(text: string): string | undefined {
  for (const line of text.split('\n')) {
    if (!line.startsWith('remote:')) continue;
    const m = line.match(/https?:\/\/\S+/);
    if (m) return m[0];
  }
  return undefined;
}

export async function gitPush(cwd: string, setUpstream: boolean): Promise<{ ok: boolean; output: string; url?: string }> {
  const r = await gitBoth(cwd, ['push', ...(setUpstream ? ['-u'] : []), 'origin', 'HEAD'], 120_000);
  const url = cleanUrl(remoteUrlFromOutput(r.text));
  return { ok: r.ok, output: maskSecrets(r.text), ...(url ? { url } : {}) };
}

export interface RemoteRepo {
  host: string;
  /** `owner/repo` (or deeper for GitLab groups), no `.git`. */
  repo: string;
}

export function parseRemoteUrl(remote: string): RemoteRepo | undefined {
  // A query or fragment (e.g. ?access_token=…) is never part of the repo path.
  const u = remote.trim().replace(/[?#].*$/, '');
  // scp-like: git@host:owner/repo.git
  let m = u.match(/^[\w.-]+@([^:/\s]+):(?!\/\/)(.+?)(?:\.git)?\/?$/);
  if (!m) m = u.match(/^(?:https?|ssh|git):\/\/(?:[^/\s]*@)?([^@:/\s]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/);
  if (!m?.[1] || !m[2]) return undefined;
  return { host: m[1].toLowerCase(), repo: m[2] };
}

const encodeRef = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');

/** The page where a pull request for `branch` is opened — no API, no token. */
export function prUrlFor(remote: string, base: string, branch: string, title?: string, body?: string): string | undefined {
  const r = parseRemoteUrl(remote);
  if (!r) return undefined;
  const root = `https://${r.host}/${r.repo}`;
  if (r.host === 'github.com') {
    const q = new URLSearchParams({ expand: '1' });
    if (title) q.set('title', title);
    if (body) q.set('body', body);
    return `${root}/compare/${encodeRef(base)}...${encodeRef(branch)}?${q.toString()}`;
  }
  if (r.host.includes('gitlab')) {
    const q = new URLSearchParams({
      'merge_request[source_branch]': branch,
      'merge_request[target_branch]': base,
    });
    return `${root}/-/merge_requests/new?${q.toString()}`;
  }
  // Forgejo / Gitea (git.corp.test)
  return `${root}/compare/${encodeRef(base)}...${encodeRef(branch)}`;
}

async function hasGh(): Promise<boolean> {
  try {
    await execFileAsync('gh', ['--version'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export async function gitPrCreate(
  cwd: string,
  title: string,
  body: string | undefined,
  base: string | undefined,
): Promise<{ ok: boolean; url?: string; output: string }> {
  if (base?.startsWith('-')) return { ok: false, output: `недопустимая база: ${base}` };
  let branch = '';
  let remote = '';
  try {
    branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    remote = (await git(cwd, ['remote', 'get-url', 'origin'])).trim();
  } catch (err) {
    return { ok: false, output: errText(err) };
  }
  if (!branch || branch === 'HEAD') return { ok: false, output: 'HEAD не на ветке' };
  // origin/main → main: the compare page wants the branch name.
  const baseBranch = (base ?? (await defaultBase(cwd)) ?? 'main').replace(/^origin\//, '');
  const parsed = parseRemoteUrl(remote);
  let ghNote = '';
  if (parsed?.host === 'github.com' && (await hasGh())) {
    try {
      const { stdout, stderr } = await execFileAsync(
        'gh',
        ['pr', 'create', '--title', title, '--body', body ?? '', '--base', baseBranch, '--head', branch],
        { cwd, timeout: 60_000, env: childEnv({ GH_PROMPT_DISABLED: '1' }) },
      );
      const text = `${stdout}${stderr}`.trim();
      const url = cleanUrl(text.match(/https?:\/\/\S+/g)?.pop());
      return { ok: true, ...(url ? { url } : {}), output: maskSecrets(text) };
    } catch (err) {
      // Not logged in, or the PR already exists — the compare page still works.
      ghNote = `gh: ${errText(err)}\n`;
    }
  }
  const url = prUrlFor(remote, baseBranch, branch, title, body);
  if (!url) return { ok: false, output: `${maskSecrets(ghNote)}не удалось разобрать адрес remote origin` };
  return { ok: true, url, output: `${maskSecrets(ghNote)}открой страницу, чтобы создать pull request` };
}
