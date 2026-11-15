import { CLAUDE_DISABLED_MESSAGE, claudeDisabled } from './runtimes-allowed.js';
import path from 'node:path';
import {
  addSyncProject,
  chatOnlyRefusal,
  policy,
  refusedInChatOnly,
  removeSyncProject,
  setSyncMode,
  syncsCwd,
} from './policy.js';
import type { SyncState } from '@cc-remote/shared';
import { listDiskCommands } from './slash-commands.js';
import { claudeSettingsPath } from './transcript-retention.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { renameSession, deleteSession, forkSession } from '@anthropic-ai/claude-agent-sdk';
import {
  RpcParams,
  RpcMethodSchema,
  RpcResultSchemas,
  DEFAULT_MODELS,
  FS_CHUNK_BYTES,
  type RpcMethod,
  type ModelInfoLite,
  type ModelsResult,
  type ProjectsResult,
  type ProjectInfo,
  type SessionSummary,
} from '@cc-remote/shared';
import { fsList, fsRead, fsWrite, fsDownload } from './fs-ops.js';
import { fsPeek } from './fs-peek.js';
import { fsMkdir, fsRename, fsTrash } from './fs-manage.js';
import { UploadStore } from './uploads.js';
import { assertRoot, rememberRoots } from './fs-roots.js';
import {
  gitStatus,
  gitStage,
  gitUnstage,
  gitCommit,
  gitBranches,
  gitCheckout,
} from './git-ops.js';
import { worktreeAdd, worktreeList, worktreeRemove, gitDiff, gitPush, gitPrCreate } from './worktree-ops.js';
import { loadHistory, loadImage, loadSubagentHistory } from './history.js';
import { loadCodexSubagentHistory } from './codex-subagents.js';
import { deleteCodexSession, findCodexTranscript, loadCodexHistory, loadCodexImage } from './codex.js';
import { listCodexModels } from './codex-run.js';
import { listGoModels } from './opencode-go.js';
import { stateDir } from './config.js';
import { dropSessionTitle, setSessionTitle } from './session-titles.js';
import { listProcesses, killProcess } from './machine-stats.js';
import { cancelLogin, jobStatus, loginInput, startInstall, startLogin } from './runtime-jobs.js';
import {
  adoptProject,
  createProject,
  forgetProject,
  listAdoptedProjects,
  listRootProjects,
  liveSessionCwds,
  removeProject,
  scanRoots,
} from './project-ops.js';

type Params = Record<string, unknown>;

/** Working directories of the runs this agent is driving right now. The
 *  liveness scan cannot see them (it skips our own children by design), and a
 *  Codex run leaves no liveness file at all — so the RunManager tells us. */
let liveRunCwds: () => string[] = () => [];

export function setLiveCwdProvider(provider: () => string[]): void {
  liveRunCwds = provider;
}

/** Stops a sub-agent of a live run; the RunManager owns the runs. */
let stopSubagent: (sessionId: string, id: string) => Promise<boolean> = async () => false;

export function setSubagentStopper(stopper: (sessionId: string, id: string) => Promise<boolean>): void {
  stopSubagent = stopper;
}

/**
 * The inventory the client last pushed to the hub.
 *
 * `projects.list` used to rebuild it from disk on every call, and on a box with
 * ~5k transcripts that is **12.5 seconds measured** for the session half alone —
 * past the browser's 30s RPC deadline once the agent happens to be mid-scan of
 * its own. The web then silently falls back to "what the snapshot knows", which
 * is session-derived projects only, so a freshly declared root looked like a
 * change that had not worked. The same list is already in memory, refreshed on
 * every watcher tick, and `fs-roots` has read it that way for a while.
 */
let latestInventory: () => SessionSummary[] = () => [];

export function setInventoryProvider(provider: () => SessionSummary[]): void {
  latestInventory = provider;
}

/** What `sync.list` / `sync.set` need from the client: the folders a person
 *  can pick (from EVERY session on disk, not the filtered inventory) and a way
 *  to re-send the inventory once the choice changed. */
interface SyncHost {
  candidates(): { cwd: string; sessions: number }[];
  /** Judged by the session's real folder (client.ts `sessionSynced`). */
  sessionSynced(sessionId: string, source: string | undefined, claimedCwd: string | undefined): boolean;
  changed(): void;
}
let syncHost: SyncHost | undefined;
export function setSyncHost(host: SyncHost): void {
  syncHost = host;
}

function syncState(): SyncState {
  const p = policy();
  return {
    mode: p.sync === 'all' ? 'all' : 'selected',
    projects: p.sync === 'all' ? [] : [...p.sync.projects],
    candidates: syncHost?.candidates() ?? [],
    chatOnly: p.chatOnly,
  };
}

/** Every directory with a live writer: our own runs plus the editor sessions the
 *  liveness scan can see. One definition, so `projects.remove` and the file
 *  manager cannot disagree about what "busy" means. */
const liveCwds = async (): Promise<string[]> => [...liveRunCwds(), ...(await liveSessionCwds())];

/** Uploads in flight on this machine. One store, because an upload is identified
 *  by an id that has to outlive the call that created it. */
const uploads = new UploadStore();

/** Called when the agent shuts down: close handles, drop the `.part` files. */
export async function closeUploads(): Promise<void> {
  await uploads.closeAll();
}

/**
 * Which runtime owns this session's transcript — the fork in the road for
 * rename/delete, which used to run every session through the Claude Agent SDK
 * and fail on Codex ids with the SDK's own "not found in project directory".
 *
 * The client normally tells us: its `SessionSummary` already carries `source`.
 * The fallback exists for clients that do not yet send it — an iOS build one
 * TestFlight behind, an old Mac app — and costs one rollout scan on a rename,
 * which is rare enough not to matter.
 */
async function isCodexSession(
  sessionId: string,
  source?: 'claude' | 'codex',
  cwd?: string,
): Promise<boolean> {
  if (source) return source === 'codex';
  return (await findCodexTranscript(sessionId, cwd)) !== null;
}

/**
 * Delete a Claude transcript, treating "it is already gone" as done.
 *
 * The SDK looks only under the project directory `cwd` maps to and throws when
 * the file is not there. That is two different situations: the session lives
 * under ANOTHER project directory (it was relocated, or the client's cwd is
 * stale) — then look everywhere, the id is a UUID; or the file is gone
 * altogether — then the person's request is already fulfilled. Answering the
 * second with an error made the hub take back its "deleted on purpose" mark
 * (`undo_pending_delete`), so a session whose file had just been removed came
 * back as archived.
 */
export async function deleteClaudeSession(
  sessionId: string,
  cwd: string,
  remove: typeof deleteSession = deleteSession,
): Promise<void> {
  try {
    await remove(sessionId, { dir: cwd });
    return;
  } catch (error) {
    if (!/not found in project directory/.test((error as Error).message)) throw error;
  }
  try {
    await remove(sessionId);
  } catch (error) {
    if (!/not found in any project directory/.test((error as Error).message)) throw error;
  }
}

/**
 * Model list for the run-time switcher. Curated default, overridable per-machine
 * via the `CC_REMOTE_MODELS` env (JSON array of `{ id, name? }`) so the list can
 * be refreshed without a code change as new models ship.
 *
 * Precedence: whatever the running CLI reports > `CC_REMOTE_MODELS` > the
 * built-in list. The runtime's own answer wins because it cannot go stale — the
 * built-in list quietly fell a whole generation behind before anyone noticed.
 * It is only available while a session is up (`supportedModels()` lives on a
 * live `Query`), so the agent caches the first answer and passes it in here.
 */
function loadModels(): ModelsResult {
  const raw = process.env['CC_REMOTE_MODELS'];
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const models = parsed
          .filter((m): m is { id: string; name?: unknown } => !!m && typeof m.id === 'string')
          .map((m): ModelInfoLite => ({ id: m.id, name: typeof m.name === 'string' ? m.name : undefined }));
        if (models.length) return { models };
      }
    } catch {
      /* malformed override — fall back to the curated default */
    }
  }
  return { models: DEFAULT_MODELS };
}
const MODELS = loadModels();

/** The Claude families the picker offers. Haiku is left out on purpose. */
const CURRENT_FAMILIES = ['opus', 'sonnet', 'fable'] as const;

/** `claude-opus-4-8` → ['opus', [4, 8]]; `claude-haiku-4-5-20251001` → ['haiku', [4, 5]]. */
function modelFamily(id: string): { family: string; version: number[] } | undefined {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (!m) return undefined;
  return { family: m[1]!, version: m[3] ? [Number(m[2]), Number(m[3])] : [Number(m[2])] };
}

function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/**
 * Cut the runtime's list down to what is worth picking: the `default` row plus
 * ONE row per current family. The CLI answers with its aliases (`opus`,
 * `sonnet`, `fable`, `haiku`) AND every pinned version it still knows —
 * `claude-opus-4-6` … `claude-opus-5` — and the iOS picker drew all twelve
 * (06.10.2026). The alias is the row to keep: it resolves to whatever is newest
 * in the CLI that runs, so the list follows a model bump with no change here.
 * A CLI without the alias keeps that family's newest pinned id instead.
 *
 * A session already running a pinned older model loses only its row: the
 * pickers name the running model from the wire id the run reports.
 */
export function currentModelsOnly(models: ModelInfoLite[]): ModelInfoLite[] {
  const best = new Map<string, { row: ModelInfoLite; version: number[] | 'alias' }>();
  for (const row of models) {
    const alias = (CURRENT_FAMILIES as readonly string[]).includes(row.id) ? row.id : undefined;
    const parsed = alias ? undefined : modelFamily(row.id);
    const family = alias ?? parsed?.family;
    if (!family || !(CURRENT_FAMILIES as readonly string[]).includes(family)) continue;
    const held = best.get(family);
    if (alias) best.set(family, { row, version: 'alias' });
    else if (!held || (held.version !== 'alias' && newer(parsed!.version, held.version)))
      best.set(family, { row, version: parsed!.version });
  }
  // Nothing recognisable (a runtime naming its models some new way): the
  // untouched list beats a picker with nothing in it.
  if (!best.size) return models;
  const keep = new Set([...best.values()].map((b) => b.row));
  return models.filter((m) => m.id === 'default' || keep.has(m));
}

/**
 * The model this machine's Claude Code runs when a session pins none, in the
 * CLI's own order: the `ANTHROPIC_MODEL` the runs inherit, then the one
 * settings.json injects through `env`, then its `model`.
 * Read per call — editing settings.json must not need an agent restart.
 */
export function pinnedDefaultModel(settingsFile: string = claudeSettingsPath()): string | undefined {
  const env = process.env['ANTHROPIC_MODEL']?.trim();
  if (env) return env;
  try {
    const parsed = JSON.parse(readFileSync(settingsFile, 'utf8')) as { model?: unknown; env?: unknown };
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    const injected =
      parsed.env && typeof parsed.env === 'object'
        ? text((parsed.env as Record<string, unknown>)['ANTHROPIC_MODEL'])
        : undefined;
    return injected ?? text(parsed.model);
  } catch {
    return undefined; // no settings file, or not JSON — the CLI's own default stands
  }
}

/**
 * Point the runtime's `default` row at what an unpinned session REALLY runs.
 *
 * The CLI builds that row from its built-in choice for the account and ignores
 * the user's `model` setting: on a dev box it said `claude-sonnet-5-5` while
 * settings.json held `opus[1m]` and every unpinned session ran Opus. The web
 * names the account default from this row — in the «Как в аккаунте» line and
 * in the composer until a run reports — so it read «Sonnet» for a session on
 * Opus (07.10.2026). Matched by alias (`opus[1m]` → the `opus` row) or by wire
 * id; an unknown value still names itself rather than keeping a wrong answer.
 */
export function withPinnedDefault(
  models: ModelInfoLite[],
  pinned: string | undefined,
  /** Where to look the value up — the FULL runtime list, so a pinned older
   *  version (`claude-opus-4-8`) still resolves after `currentModelsOnly`. */
  catalog: ModelInfoLite[] = models,
): ModelInfoLite[] {
  if (!pinned) return models;
  const bare = pinned.replace(/\[\w+\]$/, '');
  if (bare === 'default') return models;
  const row = catalog.find((m) => m.id !== 'default' && (m.id === pinned || m.id === bare || m.resolved === bare));
  return models.map((m) => {
    if (m.id !== 'default') return m;
    // The efforts belong to the model, not to the row: a default now on Opus
    // takes Opus's levels, and one on a model nobody listed claims none rather
    // than keeping the CLI's old default's.
    const next: ModelInfoLite = { ...m, resolved: row ? (row.resolved ?? row.id) : bare };
    delete next.efforts;
    delete next.supportsEffort;
    if (row?.efforts) next.efforts = row.efforts;
    if (typeof row?.supportsEffort === 'boolean') next.supportsEffort = row.supportsEffort;
    return next;
  });
}

/** Distinct working directories across recent sessions, most-recent first —
 *  the candidate projects for a new session — plus the git repositories under
 *  the projects root that have no session yet (one just created). A directory
 *  known both ways keeps its session-derived row: it carries the real count
 *  and recency. */
async function listProjects(): Promise<ProjectsResult> {
  // The cached inventory, and NOTHING slower (see `setInventoryProvider`).
  //
  // The old fallback — rebuild it from disk — is exactly what this call must not
  // do: a cold agent is also a BUSY agent (first inventory, replication, profile
  // scan), and the 12.5s scan landed on a saturated event loop, so the browser's
  // 30s deadline passed and the shelf fell back to session-derived projects with
  // no error anyone could see. An empty cache now means the session half is
  // simply missing for a few seconds — the repositories still answer, and the
  // first inventory push fills the rest in.
  const sessions = latestInventory();
  const rootProjects = await listRootProjects().catch((): ProjectInfo[] => []);
  const adopted = await listAdoptedProjects().catch((): ProjectInfo[] => []);
  const byCwd = new Map<string, ProjectInfo>();
  for (const s of sessions) {
    if (!s.cwd) continue;
    const key = path.resolve(s.cwd);
    const prev = byCwd.get(key);
    if (prev) {
      prev.count += 1;
      if (s.lastModified > prev.lastModified) prev.lastModified = s.lastModified;
    } else {
      byCwd.set(key, {
        cwd: s.cwd,
        label: s.project ?? path.basename(s.cwd),
        lastModified: s.lastModified,
        count: 1,
        origin: 'sessions',
      });
    }
  }
  for (const p of rootProjects) {
    const key = path.resolve(p.cwd);
    const prev = byCwd.get(key);
    if (!prev) {
      byCwd.set(key, p);
      continue;
    }
    // Known BOTH ways: keep the session row's count and recency — they are the
    // real ones — but let the origin say `root`, because a git repository on
    // disk is the stronger fact about this directory.
    //
    // It also decides visibility. The web hides projects whose every session is
    // a cron loop (`isAutomatedSession`), and separately admits agent-reported
    // rows only when they are `root`. A repository whose only sessions are
    // scripted satisfied neither test and disappeared from the picker entirely —
    // which is how a checkout everyone could see on disk was, to the platform,
    // not a project. The hiding rule still holds for what it was written for: a
    // cwd that is NOT a repository (a scratch dir a loop happened to run in)
    // never reaches this branch.
    prev.origin = 'root';
  }
  // Adopted last, and it wins the origin for the same reason `root` does: a
  // person naming a directory by hand is the strongest statement there is that
  // it is a project, and the web admits agent-reported rows only by origin.
  // `adoptProject` refuses to store what the scan already finds, so this can
  // only add rows the two loops above could not produce.
  for (const p of adopted) {
    const key = path.resolve(p.cwd);
    const prev = byCwd.get(key);
    if (!prev) byCwd.set(key, p);
    else prev.origin = 'adopted';
  }
  const projects = [...byCwd.values()].sort((a, b) => b.lastModified - a.lastModified);
  // Admission point for the file RPCs' allow-list. A directory the picker is
  // willing to offer is a directory the file manager must be able to open, and
  // remembering it here means that stays true even after the session that
  // introduced it ages out of the inventory window.
  await rememberRoots(projects.map((p) => p.cwd)).catch(() => {});
  return { projects, roots: scanRoots() };
}

/**
 * Dispatch a generic RPC method to its handler. Params are validated against the
 * per-method zod schema in `shared/rpc.ts` first, so a handler never sees a
 * missing/mistyped field, and an unknown method is rejected outright.
 */
/** Models the live runtime reported, if any run has answered yet. */
let runtimeModels: ModelInfoLite[] | undefined;
let runtimeModelsLoaded = false;

/**
 * Where the last runtime answer is kept across restarts.
 *
 * The list is only ever learned from a LIVE run, so after every agent restart —
 * and since 24.09.2026 every hub deploy restarts the fleet (self-update) — a
 * machine answered with the built-in list until someone ran a turn on it. That
 * list has no `default` row, so the new-chat composer had nothing to name the
 * account's default by and showed the placeholder «модель» (28.09.2026, a fresh
 * chat on buildbox-pc). The kept copy is a better guess than the built-in one;
 * the first live run replaces it.
 */
export function runtimeModelsFile(): string {
  return path.join(stateDir(), 'runtime-models.json');
}

export function loadKeptRuntimeModels(): ModelInfoLite[] | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(runtimeModelsFile(), 'utf8'));
    const ok = RpcResultSchemas['models.list'].safeParse({ models: parsed });
    return ok.success && ok.data.models.length ? ok.data.models : undefined;
  } catch {
    return undefined; // none kept yet, or unreadable — the built-in list answers
  }
}

/** Called by the agent once a run reports what this CLI actually offers. */
export function setRuntimeModels(models: ModelInfoLite[]): void {
  if (!models.length) return;
  runtimeModels = models;
  runtimeModelsLoaded = true;
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(runtimeModelsFile(), JSON.stringify(models));
  } catch (err) {
    console.error('[agent] could not keep the runtime model list:', (err as Error).message);
  }
}

function currentRuntimeModels(): ModelInfoLite[] | undefined {
  if (!runtimeModelsLoaded) {
    runtimeModelsLoaded = true;
    runtimeModels ??= loadKeptRuntimeModels();
  }
  return runtimeModels;
}

export async function dispatchRpc(method: string, params: Params): Promise<unknown> {
  const rpcMethod = RpcMethodSchema.parse(method);
  const result = await dispatchRpcUnchecked(rpcMethod, params);
  return RpcResultSchemas[rpcMethod].parse(result);
}

async function dispatchRpcUnchecked(method: RpcMethod, params: Params): Promise<unknown> {
  // The machine's own switch, before anything else: a hub that ignores its
  // role checks still meets this one (policy.ts).
  if (refusedInChatOnly(method)) throw new Error(chatOnlyRefusal(`«${method}»`));
  // A session in a folder the owner does not sync has not left this machine,
  // and a read by id must not be the side door it leaves through.
  if (method.startsWith('session.') && policy().sync !== 'all') {
    const cwd = typeof params['cwd'] === 'string' ? params['cwd'] : undefined;
    const id = typeof params['sessionId'] === 'string' ? params['sessionId'] : '';
    const source = typeof params['source'] === 'string' ? params['source'] : undefined;
    const ok = syncHost ? syncHost.sessionSynced(id, source, cwd) : syncsCwd(cwd);
    if (!ok) throw new Error('This session is in a folder this machine does not sync (~/.cc-remote/policy.json).');
  }
  // Every file method proves its working directory is one of this machine's
  // project roots before anything touches a disk. It lives here, not inside
  // fs-ops, so that adding a file method cannot quietly skip it — and so the
  // check exists in exactly one place. Methods keyed by `uploadId` instead of a
  // cwd inherit the check their `fs.upload.begin` already passed.
  // Git goes through the same gate: a commit runs the repo's own hooks and a
  // checkout rewrites the tree, so "any directory the hub names" was a wider
  // door than the file methods beside it.
  if ((method.startsWith('fs.') || method.startsWith('git.')) && typeof params['cwd'] === 'string') {
    await assertRoot(params['cwd']);
  }
  switch (method) {
    case 'fs.list': {
      const a = RpcParams['fs.list'].parse(params);
      return fsList(a.cwd, a.path ?? '');
    }
    case 'fs.read': {
      const a = RpcParams['fs.read'].parse(params);
      return fsRead(a.cwd, a.path);
    }
    case 'fs.write': {
      const a = RpcParams['fs.write'].parse(params);
      return fsWrite(a.cwd, a.path, a.content);
    }
    case 'fs.download': {
      const a = RpcParams['fs.download'].parse(params);
      return fsDownload(a.cwd, a.path, a.offset ?? 0, a.length ?? FS_CHUNK_BYTES);
    }
    case 'fs.peek': {
      const a = RpcParams['fs.peek'].parse(params);
      return fsPeek(a.cwd, a.path, a.offset ?? 0, a.length ?? FS_CHUNK_BYTES);
    }
    case 'fs.mkdir': {
      const a = RpcParams['fs.mkdir'].parse(params);
      return fsMkdir(a.cwd, a.path, { recursive: a.recursive });
    }
    case 'fs.rename': {
      const a = RpcParams['fs.rename'].parse(params);
      return fsRename(a.cwd, a.from, a.to, { liveCwds });
    }
    case 'fs.trash': {
      const a = RpcParams['fs.trash'].parse(params);
      return fsTrash(a.cwd, a.path, { liveCwds });
    }
    case 'fs.upload.begin': {
      const a = RpcParams['fs.upload.begin'].parse(params);
      return uploads.begin(a.cwd, a.dir, a.name, a.size, a.overwrite ?? false);
    }
    case 'fs.upload.chunk': {
      const a = RpcParams['fs.upload.chunk'].parse(params);
      return uploads.chunk(a.uploadId, a.offset, a.data);
    }
    case 'fs.upload.commit': {
      const a = RpcParams['fs.upload.commit'].parse(params);
      return uploads.commit(a.uploadId);
    }
    case 'fs.upload.abort': {
      const a = RpcParams['fs.upload.abort'].parse(params);
      return uploads.abort(a.uploadId);
    }

    case 'git.status': {
      const a = RpcParams['git.status'].parse(params);
      return gitStatus(a.cwd);
    }
    case 'git.stage': {
      const a = RpcParams['git.stage'].parse(params);
      return gitStage(a.cwd, a.paths);
    }
    case 'git.unstage': {
      const a = RpcParams['git.unstage'].parse(params);
      return gitUnstage(a.cwd, a.paths);
    }
    case 'git.commit': {
      const a = RpcParams['git.commit'].parse(params);
      return gitCommit(a.cwd, a.message, a.all ?? false);
    }
    case 'git.branches': {
      const a = RpcParams['git.branches'].parse(params);
      return gitBranches(a.cwd);
    }
    case 'git.checkout': {
      const a = RpcParams['git.checkout'].parse(params);
      return gitCheckout(a.cwd, a.branch);
    }
    case 'git.worktree.add': {
      const a = RpcParams['git.worktree.add'].parse(params);
      return worktreeAdd(a.cwd, a.branch, a.base);
    }
    case 'git.worktree.list': {
      const a = RpcParams['git.worktree.list'].parse(params);
      return worktreeList(a.cwd, { liveCwds });
    }
    case 'git.worktree.remove': {
      const a = RpcParams['git.worktree.remove'].parse(params);
      return worktreeRemove(a.cwd, a.path, a.force ?? false, { liveCwds });
    }
    case 'git.diff': {
      const a = RpcParams['git.diff'].parse(params);
      return gitDiff(a.cwd, { base: a.base, staged: a.staged, path: a.path });
    }
    case 'git.push': {
      const a = RpcParams['git.push'].parse(params);
      return gitPush(a.cwd, a.setUpstream ?? true);
    }
    case 'git.pr.create': {
      const a = RpcParams['git.pr.create'].parse(params);
      return gitPrCreate(a.cwd, a.title, a.body, a.base);
    }

    case 'session.messages': {
      const a = RpcParams['session.messages'].parse(params);
      if (a.head) throw new Error('Opening history must be read from the hub replica');
      const limit = a.limit ?? 1000;
      const messages =
        a.source === 'codex'
          ? await loadCodexHistory(a.sessionId, limit, a.toolChars, a.cwd)
          : await loadHistory(a.sessionId, a.cwd, limit, a.toolChars);
      return { messages };
    }
    case 'session.subagent': {
      const a = RpcParams['session.subagent'].parse(params);
      const messages =
        a.source === 'codex'
          ? a.id
            ? await loadCodexSubagentHistory(a.id, 1000, a.toolChars, a.sessionId, a.cwd)
            : []
          : a.toolUseId || a.id
            ? await loadSubagentHistory(a.sessionId, a.toolUseId, 1000, a.toolChars, a.id)
            : [];
      return { messages };
    }
    case 'run.stopSubagent': {
      const a = RpcParams['run.stopSubagent'].parse(params);
      if (!(await stopSubagent(a.sessionId, a.id))) throw new Error('Этого помощника уже нет — он завершился или запуск закрыт.');
      return { ok: true };
    }
    case 'session.image': {
      const a = RpcParams['session.image'].parse(params);
      const found =
        (await isCodexSession(a.sessionId, a.source, a.cwd))
          ? await loadCodexImage(a.sessionId, a.ref, a.cwd)
          : await loadImage(a.sessionId, a.ref);
      // A ref that no longer resolves is ordinary — a compaction moved the
      // message out of the tail — so answer with an empty picture rather than
      // an error the UI would have to render as a failure.
      return found ?? { mediaType: '', dataB64: '' };
    }
    case 'session.rename': {
      const a = RpcParams['session.rename'].parse(params);
      if (await isCodexSession(a.sessionId, a.source)) {
        // No transcript write: a rollout belongs to Codex, and its title is
        // recomputed from the first user message every parse. The agent keeps
        // this one and `buildInventory` overlays it.
        setSessionTitle(a.sessionId, a.title);
      } else {
        await renameSession(a.sessionId, a.title, { dir: a.cwd });
        // The transcript record can scroll out of the window `claudeTitleIsDerived`
        // reads; a person's choice must still keep generated titles off this one.
        setSessionTitle(a.sessionId, a.title);
      }
      return { ok: true };
    }
    case 'session.delete': {
      const a = RpcParams['session.delete'].parse(params);
      if (await isCodexSession(a.sessionId, a.source, a.cwd)) {
        await deleteCodexSession(a.sessionId, undefined, a.cwd, liveRunCwds());
        dropSessionTitle(a.sessionId);
      } else {
        await deleteClaudeSession(a.sessionId, a.cwd);
        dropSessionTitle(a.sessionId);
      }
      return { ok: true };
    }
    case 'session.fork': {
      const a = RpcParams['session.fork'].parse(params);
      // Forking is an Agent SDK operation on a Claude transcript. Letting a
      // Codex id through produced the SDK's own "not found in project
      // directory" — an error about the wrong thing entirely.
      if (await isCodexSession(a.sessionId)) {
        throw new Error('Codex sessions cannot be forked');
      }
      return forkSession(a.sessionId, { dir: a.cwd });
    }

    case 'commands.list': {
      const a = RpcParams['commands.list'].parse(params);
      // Codex has no slash commands we can drive; say so with an empty list
      // rather than offering Claude's.
      if (a.source === 'codex') return { commands: [] };
      return { commands: await listDiskCommands(a.cwd) };
    }
    case 'models.list': {
      const a = RpcParams['models.list'].parse(params);
      // Codex answers for itself: its ids are not Claude's, and the list is
      // most wanted on a session nobody has spoken to yet — so it cannot come
      // from a live run the way the Claude one does.
      //
      // An empty answer (no Codex here, one too old for `model/list`, or an
      // app-server that missed the 20s deadline) stays EMPTY. Falling through
      // to the Claude list used to answer a Codex question with Claude ids,
      // which the web cannot tell from a real list: it renders them, caches
      // them under the machine's `::codex` key for the life of the tab, and
      // any pick then poisons the session — Codex accepts the id at
      // `setModel` and fails every turn afterwards. A picker naming only the
      // model that is running is the honest failure.
      if (a.source === 'codex') {
        // Side by side: a cold Codex takes most of the client's 30 s, and a slow Go
        // endpoint waited for after it would time out the native rows too.
        const [models, goModels] = await Promise.all([listCodexModels(), listGoModels()]);
        // Go runs inside Codex, so with no Codex here its rows would be unusable.
        return { models: models.length ? [...models, ...goModels] : models };
      }
      const known = currentRuntimeModels();
      // Filtered on the way out, not when kept: a kept file written by an
      // older agent carries the full tail too.
      return known ? { models: withPinnedDefault(currentModelsOnly(known), pinnedDefaultModel(), known) } : MODELS;
    }

    case 'projects.list': {
      RpcParams['projects.list'].parse(params);
      return listProjects();
    }
    case 'projects.create': {
      const a = RpcParams['projects.create'].parse(params);
      return createProject(a);
    }
    case 'projects.remove': {
      const a = RpcParams['projects.remove'].parse(params);
      return removeProject(a, { liveCwds });
    }
    case 'projects.adopt': {
      const a = RpcParams['projects.adopt'].parse(params);
      // The SAME boundary the file methods get, and for the same reason: the
      // hub cannot resolve a path on a machine it does not have, so this is the
      // only place the question can be answered. Adoption therefore reaches
      // nothing a caller could not already list — it decides what is CALLED a
      // project, not what may be opened.
      await assertRoot(a.cwd);
      const adopted = await adoptProject(a);
      // A newly named directory must be openable immediately; the allow-list
      // caches for 30s and would otherwise refuse the first browse into it.
      await rememberRoots([adopted.cwd]).catch(() => {});
      return adopted;
    }
    case 'projects.forget': {
      const a = RpcParams['projects.forget'].parse(params);
      // No `assertRoot`: forgetting is how you undo an adoption, and a root that
      // has since been undeclared would otherwise trap its own rows on screen
      // forever. Nothing on disk is touched either way.
      return forgetProject(a);
    }

    case 'sync.list': {
      RpcParams['sync.list'].parse(params);
      return syncState();
    }
    case 'sync.set': {
      const a = RpcParams['sync.set'].parse(params);
      // On a chat-only machine the owner decides this on the machine, in the
      // file — the hub does not get to widen what leaves it.
      if (policy().chatOnly) throw new Error(chatOnlyRefusal('Changing what this machine syncs'));
      if (a.mode === 'all') setSyncMode('all');
      else if (a.mode === 'selected' || a.add?.length || a.remove?.length) setSyncMode('selected');
      for (const dir of a.add ?? []) addSyncProject(dir);
      for (const dir of a.remove ?? []) removeSyncProject(dir);
      syncHost?.changed();
      return syncState();
    }

    case 'proc.list': {
      RpcParams['proc.list'].parse(params);
      return listProcesses();
    }
    case 'proc.kill': {
      const a = RpcParams['proc.kill'].parse(params);
      return killProcess(a.pid, a.signal ?? 'TERM');
    }
    case 'runtime.install': {
      const a = RpcParams['runtime.install'].parse(params);
      if (a.runtime === 'claude' && claudeDisabled()) throw new Error(CLAUDE_DISABLED_MESSAGE);
      return startInstall(a.runtime);
    }
    case 'runtime.login.start': {
      const a = RpcParams['runtime.login.start'].parse(params);
      if (a.runtime === 'claude' && claudeDisabled()) throw new Error(CLAUDE_DISABLED_MESSAGE);
      return startLogin(a.runtime);
    }
    case 'runtime.login.input': {
      const a = RpcParams['runtime.login.input'].parse(params);
      return loginInput(a.loginId, a.code);
    }
    case 'runtime.login.cancel': {
      const a = RpcParams['runtime.login.cancel'].parse(params);
      return cancelLogin(a.loginId);
    }
    case 'runtime.job.status': {
      const a = RpcParams['runtime.job.status'].parse(params);
      return jobStatus(a.id);
    }

    default:
      throw new Error(`unknown rpc method: ${method}`);
  }
}
