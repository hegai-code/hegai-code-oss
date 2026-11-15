import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  GitBranchesResult,
  GitCommitResult,
  GitFileStatus,
  GitStatusResult,
} from '@cc-remote/shared';
import { childEnv } from './child-env.js';

const execFileAsync = promisify(execFile);

/** Run a git command in `cwd`. Never prompts (this is an RPC, nobody is at the
 *  keyboard) and never hangs the dispatcher — a stuck command dies at 30s. */
export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
    env: childEnv({ GIT_TERMINAL_PROMPT: '0' }),
  });
  return stdout;
}

export async function gitStatus(cwd: string): Promise<GitStatusResult> {
  let out: string;
  try {
    // -z: NUL-separated, no quoting — non-ASCII paths come through verbatim
    // (quoted paths broke the stage/unstage round-trip) and rename entries are
    // unambiguous ("to" NUL "from" instead of "to -> from").
    out = await git(cwd, ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=all']);
  } catch {
    return { isRepo: false, branch: '', ahead: 0, behind: 0, files: [] };
  }
  const tokens = out.split('\0');
  let branch = '';
  let ahead = 0;
  let behind = 0;
  const files: GitFileStatus[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const e = tokens[i];
    if (!e) continue;
    if (e.startsWith('## ')) {
      const head = e.slice(3);
      branch = head.split('...')[0]?.split(' ')[0] ?? head;
      const ah = head.match(/ahead (\d+)/);
      const be = head.match(/behind (\d+)/);
      if (ah?.[1]) ahead = Number(ah[1]);
      if (be?.[1]) behind = Number(be[1]);
      continue;
    }
    const code = e.slice(0, 2);
    const file = e.slice(3);
    // Rename/copy in EITHER column emits a second, NUL-separated "from" path
    // (worktree-side renames put the R/C in column 2) — consume it.
    if (code.includes('R') || code.includes('C')) i++;
    files.push({ path: file, code, staged: code[0] !== ' ' && code[0] !== '?' });
  }
  return { isRepo: true, branch, ahead, behind, files };
}

export async function gitStage(cwd: string, paths: string[]): Promise<{ ok: boolean }> {
  await git(cwd, ['add', '--', ...paths]);
  return { ok: true };
}

export async function gitUnstage(cwd: string, paths: string[]): Promise<{ ok: boolean }> {
  await git(cwd, ['restore', '--staged', '--', ...paths]);
  return { ok: true };
}

/** Untracked file names that look like credentials: never swept in by «commit all». */
const SECRET_LIKE = /^(\.env(\.(?!example$|sample$|template$)[^/]+)?|[^/]+\.env|.*\.(pem|key|p12|pfx|p8)|id_(rsa|ed25519|ecdsa|dsa)|.*credentials.*|.*secret.*|\.npmrc|\.netrc|_netrc|\.pypirc|\.pgpass|pgpass\.conf|\.my\.cnf|\.s3cfg|\.htpasswd|\.git-credentials|\.dockercfg|.*\.(tfvars|kdbx))$/i;
const DOCKER_CONFIG = /(^|\/)\.docker\/config\.json$/i;
export const isSecretLike = (f: string): boolean => SECRET_LIKE.test(f.split('/').pop() ?? f) || DOCKER_CONFIG.test(f);

export async function gitCommit(cwd: string, message: string, all = false): Promise<GitCommitResult> {
  try {
    // «Commit» on the review panel means everything the agent did, new files
    // included; the per-file stage/unstage pair stays for the file view.
    if (all) {
      // Never sweep secrets into a commit that is one tap away from a push:
      // snapshot EVERY changed path (staged, modified, deleted, untracked),
      // refuse if any looks like a credential, and stage exactly that snapshot.
      const raw = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
      const parts = raw.split('\0');
      const paths: string[] = [];
      for (let i = 0; i < parts.length; i++) {
        const entry = parts[i];
        if (!entry || entry.length < 4) continue;
        paths.push(entry.slice(3));
        // A rename/copy carries its source as the next NUL field.
        const code = entry.slice(0, 2);
        if (code.includes('R') || code.includes('C')) paths.push(parts[++i] ?? '');
      }
      const risky = paths.filter((f) => f && isSecretLike(f));
      if (risky.length) {
        return {
          ok: false,
          output: `Не закоммичено: похоже на секреты — ${risky.slice(0, 10).join(', ')}. Добавьте их в .gitignore или закоммитьте вручную.`,
        };
      }
      const approved = paths.filter(Boolean);
      if (approved.length) await git(cwd, ['add', '-A', '--', ...approved]);
    }
    const out = await git(cwd, ['commit', '-m', message]);
    return { ok: true, output: out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: e.stdout || e.stderr || e.message || 'commit failed' };
  }
}

export async function gitBranches(cwd: string): Promise<GitBranchesResult> {
  const out = await git(cwd, ['branch', '--format=%(refname:short)']);
  const all = out.split('\n').map((s) => s.trim()).filter(Boolean);
  let current = '';
  try {
    current = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch {
    /* detached or no repo */
  }
  return { current, all };
}

export async function gitCheckout(cwd: string, branch: string): Promise<{ ok: boolean; output: string }> {
  // A "branch" that starts with `-` is an option (`-f` throws away every local
  // change), and `checkout <x>` with no `--` falls back to treating x as a PATH
  // and restoring that file. The trailing `--` pins x to a revision.
  if (!branch || branch.startsWith('-')) return { ok: false, output: `not a branch name: ${branch}` };
  try {
    const out = await git(cwd, ['checkout', branch, '--']);
    return { ok: true, output: out };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { ok: false, output: e.stderr || e.message || 'checkout failed' };
  }
}
