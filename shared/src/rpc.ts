/**
 * RPC method names, their param schemas, and result shapes. Params travel as
 * generic JSON on the wire; the agent validates them against the per-method zod
 * schemas below before dispatching. `RpcParams` is the single source of truth —
 * the set of valid method names, and the shape of each one's params.
 */
import { z } from 'zod';
import { E2eField } from './e2e.js';

/**
 * One upload/download window, in RAW bytes. base64 inflates by 4/3, so a frame
 * carries ~700KB.
 *
 * Sized against three ceilings at once, the lowest of which decides it:
 * the hub's outbound queue counts MESSAGES, not bytes (`OUT_CHANNEL_CAP`), and
 * drops a peer that cannot drain — so windows must stay small enough that one
 * in flight is cheap; the hub is a single tokio task that clones and
 * re-serialises every frame it relays, so a fat frame stalls the whole fleet;
 * and the browser rejects any RPC after 30s (`web/src/pending-registry.ts`), so
 * one window has to land over a bad phone link.
 */
export const FS_CHUNK_BYTES = 512 * 1024;
/** base64 length of one full window, for the schema bound. */
export const FS_CHUNK_B64_MAX = Math.ceil(FS_CHUNK_BYTES / 3) * 4 + 4;
/**
 * Hard ceiling on one uploaded file. Past this the honest answer is git or scp:
 * every byte is base64 inside JSON, relayed through the hub's memory and parsed
 * on both sides. 100MB is a folder of photos — the actual scenario — not a disk
 * image.
 */
export const FS_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/**
 * Entries one `fs.list` returns. Past this it reports `truncated` with the real
 * `total` — a file manager that silently shows a slice of a directory is lying,
 * and `node_modules` with 200k children would otherwise be a multi-MB frame
 * parsed twice (once by the agent, once by the browser).
 */
export const FS_MAX_ENTRIES = 2000;
/**
 * Cap on `fs.write` content. There is no browser text editor yet; this exists so
 * a bug or a hostile client cannot stream half a gigabyte into one JSON string.
 */
export const FS_MAX_WRITE_BYTES = 1024 * 1024;
/** What `fs.peek` previews. Lower-case, without the dot. Clients detect the
 *  same list in answer text; the agent refuses anything else. */
export const FS_PEEK_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'md', 'markdown'] as const;
/** Largest file `fs.peek` serves — a screenshot, not a photo library. */
export const FS_PEEK_MAX_BYTES = 16 * 1024 * 1024;

export const RpcParams = {
  'fs.list': z.object({ cwd: z.string(), path: z.string().optional() }),
  /** Text preview: utf8, bounded, `truncated` when the file is longer. NOT the
   *  download path — bytes go through `fs.download`. */
  'fs.read': z.object({ cwd: z.string(), path: z.string() }),
  'fs.write': z.object({
    cwd: z.string(),
    path: z.string(),
    content: z.string().max(FS_MAX_WRITE_BYTES),
  }),
  /**
   * Byte-exact ranged read: the download path, and the only way to get the bytes
   * of a file that is not utf8.
   *
   * Windowed by the CALLER, one request per window, rather than pushed as a
   * stream of frames: request/response keeps exactly one window in flight per
   * download, so a stalled browser cannot make the hub queue gigabytes on a
   * machine that runs the whole fleet.
   */
  'fs.download': z.object({
    cwd: z.string(),
    path: z.string(),
    offset: z.number().int().nonnegative().optional(),
    length: z.number().int().min(1).max(FS_CHUNK_BYTES).optional(),
  }),
  /**
   * The chat's file preview: one window of an image or a markdown file an
   * answer NAMED ("Скриншот: /tmp/claude-<uid>/-srv-x/<id>/scratchpad/mail.png").
   *
   * Not `fs.download` with a wider door. It reads only what a preview needs —
   * the extensions in `FS_PEEK_EXTENSIONS`, at most `FS_PEEK_MAX_BYTES` — and
   * only from two places: inside `cwd` (a project root, as for every `fs.*`),
   * or inside the Claude Code scratch directory of that same folder
   * (`<tmp>/claude-<uid>/<slug of cwd>/`), where sessions are told to put
   * screenshots. `path` may be absolute or relative to `cwd`; the agent
   * resolves symlinks before it decides. Windowed exactly like `fs.download`
   * and answers with the same shape.
   */
  'fs.peek': z.object({
    cwd: z.string(),
    path: z.string().min(1).max(4096),
    offset: z.number().int().nonnegative().optional(),
    length: z.number().int().min(1).max(FS_CHUNK_BYTES).optional(),
  }),
  /**
   * Open an upload. The destination is resolved and the final name decided NOW,
   * so someone who dropped 80MB learns about a missing directory before the
   * bytes travel rather than after.
   */
  'fs.upload.begin': z.object({
    cwd: z.string(),
    /** Directory relative to cwd; '' = cwd root. */
    dir: z.string(),
    /** Filename as the browser reported it. Validated to a bare name by the
     *  agent and NEVER treated as a path. */
    name: z.string().min(1).max(255),
    /** Total size from the browser's File object; commit refuses unless exactly
     *  this many bytes arrived. */
    size: z.number().int().nonnegative().max(FS_MAX_UPLOAD_BYTES),
    /** Replace an existing file. Default: keep both, the new one is suffixed. */
    overwrite: z.boolean().optional(),
  }),
  'fs.upload.chunk': z.object({
    uploadId: z.string().min(1).max(64),
    /** Must equal the bytes already written: an upload is strictly sequential,
     *  so a reordered or replayed window is refused rather than silently
     *  corrupting the file at the wrong offset. */
    offset: z.number().int().nonnegative(),
    data: z.string().max(FS_CHUNK_B64_MAX),
  }),
  'fs.upload.commit': z.object({ uploadId: z.string().min(1).max(64) }),
  'fs.upload.abort': z.object({ uploadId: z.string().min(1).max(64) }),
  /** Create a directory and any missing parents under cwd. Idempotent, which is
   *  what makes a folder drop a plain loop over its distinct subdirectories. */
  'fs.mkdir': z.object({
    cwd: z.string(),
    path: z.string().min(1),
    /** Default true. `false` = one plain mkdir: no missing parents, and an
     *  existing entry is an error. The hub forces it for a non-controlling member. */
    recursive: z.boolean().optional(),
  }),
  /** Rename/move inside one cwd. `to` must not exist: a file manager that
   *  silently overwrites on rename is one that loses work. */
  'fs.rename': z.object({ cwd: z.string(), from: z.string().min(1), to: z.string().min(1) }),
  /** Move into the agent's trash — never unlink. Same trash, same naming and the
   *  same live-session refusal as `projects.remove`. */
  'fs.trash': z.object({ cwd: z.string(), path: z.string().min(1) }),
  'git.status': z.object({ cwd: z.string() }),
  'git.stage': z.object({ cwd: z.string(), paths: z.array(z.string()) }),
  'git.unstage': z.object({ cwd: z.string(), paths: z.array(z.string()) }),
  'git.commit': z.object({
    cwd: z.string(),
    message: z.string(),
    sessionId: z.string().optional(),
    /** Stage everything (tracked and untracked) first — `git add -A`. */
    all: z.boolean().optional(),
  }),
  'git.branches': z.object({ cwd: z.string() }),
  'git.checkout': z.object({ cwd: z.string(), branch: z.string() }),
  /** Cut a new branch into its own worktree OUTSIDE the repo
   *  (`<repoParent>/.hegai-worktrees/<repo>/<branch>`), so several agents can
   *  work on one repository at once without sharing a working tree. */
  'git.worktree.add': z.object({
    cwd: z.string(),
    branch: z.string().min(1).max(200),
    /** Start point; default HEAD. */
    base: z.string().min(1).max(200).optional(),
  }),
  'git.worktree.list': z.object({ cwd: z.string() }),
  'git.worktree.remove': z.object({
    cwd: z.string(),
    path: z.string().min(1),
    /** Remove although it has uncommitted changes. Never overrides a live run. */
    force: z.boolean().optional(),
  }),
  /** Review diff: the working tree against HEAD (untracked files as new), or
   *  `base...HEAD` when `base` is given. */
  'git.diff': z.object({
    cwd: z.string(),
    base: z.string().min(1).max(200).optional(),
    staged: z.boolean().optional(),
    path: z.string().min(1).optional(),
  }),
  'git.push': z.object({ cwd: z.string(), setUpstream: z.boolean().optional() }),
  'git.pr.create': z.object({
    cwd: z.string(),
    title: z.string().min(1).max(300),
    body: z.string().max(20_000).optional(),
    base: z.string().min(1).max(200).optional(),
  }),
  'session.messages': z.object({
    /** Read the opening from the hub replica for title context; never a tail. */
    head: z.boolean().optional(),
    cwd: z.string(),
    sessionId: z.string(),
    /** 'codex' reads the transcript from ~/.codex rollouts instead of the SDK. */
    source: z.enum(['claude', 'codex']).optional(),
    /** Recent messages to return. The agent defaults to a bounded tail. */
    limit: z.number().int().min(1).max(2000).optional(),
    /**
     * Cap, in characters, on each `tool_use` input string and `tool_result`
     * body. On a real session those two block kinds are 95-99% of the payload —
     * file dumps, greps and diffs nobody reads — while the text you actually
     * read is a couple of percent. Clients that only RENDER a transcript should
     * pass a small cap (the web already clips a result at 4000 chars on screen,
     * so nothing visible is lost); omit it to get the transcript verbatim.
     */
    toolChars: z.number().int().min(0).max(200_000).optional(),
  }),
  /**
   * Rename a session. A Claude title is written into the transcript itself (the
   * SDK's `renameSession`), so every other Claude client sees it. A Codex
   * rollout has no writable title — its own is re-derived from the first user
   * message on every parse — so the agent keeps that one in a local store and
   * overlays it onto the inventory.
   *
   * `source` is optional only for back-compat: a client one build behind sends
   * nothing and the agent detects the runtime from the id. New clients pass the
   * `source` their own `SessionSummary` already carries.
   */
  'session.rename': z.object({
    cwd: z.string(),
    sessionId: z.string(),
    title: z.string(),
    source: z.enum(['claude', 'codex']).optional(),
  }),
  'session.delete': z.object({
    cwd: z.string(),
    sessionId: z.string(),
    source: z.enum(['claude', 'codex']).optional(),
  }),
  'session.fork': z.object({ cwd: z.string(), sessionId: z.string() }),
  /** One sub-agent's own transcript, read-only (the card's «открыть»). Claude:
   *  `<session>/subagents/agent-*.jsonl`, found by the `Agent` call's
   *  `toolUseId`. Codex: the child thread's rollout, by its thread id (`id`). */
  'session.subagent': z.object({
    cwd: z.string(),
    sessionId: z.string(),
    source: z.enum(['claude', 'codex']).optional(),
    toolUseId: z.string().max(200).optional(),
    id: z.string().max(200).optional(),
    toolChars: z.number().int().min(0).max(200_000).optional(),
  }),
  /** Stop one sub-agent of the session's live run; the run and the others go
   *  on. `id` is `Subagent.id`. */
  'run.stopSubagent': z.object({ sessionId: z.string(), id: z.string().min(1).max(200) }),
  /** `source` names the RUNTIME whose models are wanted: a Codex session runs
   *  on the Codex app-server and its ids mean nothing to Claude, or the other
   *  way round. Absent = Claude, which is what every caller meant before Codex
   *  sessions could switch model at all. */
  'models.list': z.object({ source: z.enum(['claude', 'codex']).optional() }),
  /** The slash commands a composer can offer: the live run's own list when the
   *  session has one (`supportedCommands()`), otherwise the skills and commands
   *  on disk — `~/.claude` plus `<cwd>/.claude` — so a new chat has them too.
   *  Claude only; a Codex session answers empty. */
  'commands.list': z.object({
    sessionId: z.string().optional(),
    cwd: z.string().optional(),
    source: z.enum(['claude', 'codex']).optional(),
  }),
  /** Distinct recent working directories, for the "new session" project picker. */
  'projects.list': z.object({}),
  /**
   * Create a project directory under the machine's projects root (default
   * `~/work`, `CC_REMOTE_PROJECTS_ROOT`): either an empty git repo with a README
   * and an initial commit, or a clone of an https URL. Device owner only.
   */
  'projects.create': z.object({
    name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    /** Clone this instead of `git init`. https only — a sandbox has no SSH keys. */
    gitUrl: z.string().regex(/^https:\/\/[^\s]+$/).optional(),
    template: z.enum(['empty']).optional(),
    /** Parent directory; must resolve inside the projects root. Default = root. */
    parent: z.string().optional(),
  }),
  /** Move a project directory under the projects root into the agent's trash. */
  'projects.remove': z.object({ cwd: z.string() }),
  /**
   * Take an EXISTING directory on the machine into the project list.
   *
   * Nothing is created, moved or written: a checkout made by hand — or a folder
   * with no `.git` at all, which the root scan skips on purpose — becomes
   * something the platform will offer in a picker. The boundary is the file
   * RPCs' own allow-list (`assertRoot`), so this grants no reach the caller did
   * not already have; it is a listing, not a capability.
   */
  'projects.adopt': z.object({ cwd: z.string() }),
  /**
   * Drop an adopted directory from the list. The directory itself is NOT
   * touched — that is the whole point, and why this is a separate method from
   * `projects.remove` rather than a flag on it. `projects.remove` is confined to
   * the projects root precisely so the platform cannot trash a working
   * repository; an adopted `/srv/crm` must therefore be undoable some other way,
   * or a mis-click would be permanent.
   */
  'projects.forget': z.object({ cwd: z.string() }),
  /**
   * Which folders' sessions leave this machine (agent/src/policy.ts). `list`
   * is what the owner sees; `set` changes it — refused on a chat-only machine,
   * where only the owner, on the machine, edits `~/.cc-remote/policy.json`.
   * `mode: 'all'` goes back to syncing everything; `add`/`remove` edit the
   * folder list (and switch to `selected`).
   */
  'sync.list': z.object({}),
  'sync.set': z.object({
    mode: z.enum(['all', 'selected']).optional(),
    add: z.array(z.string().min(1)).max(200).optional(),
    remove: z.array(z.string().min(1)).max(200).optional(),
  }),
  /**
   * One attachment's bytes, fetched when a client is actually going to show it.
   *
   * `ref` is what the matching history block carried (`uuid#index`): the
   * message's own id in the transcript, and which content block of it. The
   * agent re-reads the same bounded tail `session.messages` reads, so anything
   * whose marker is on screen is by definition still reachable — and a
   * transcript too big to hold in memory never has to be.
   */
  'session.image': z.object({
    sessionId: z.string(),
    ref: z.string().max(200),
    /** Selects the transcript format whose ref is being resolved. Optional for
     * older web/iOS clients, which only knew Claude refs. */
    source: z.enum(['claude', 'codex']).optional(),
    /** The hub's own record of the session's folder (it overwrites whatever a
     * client sent): lets a machine that keeps the same id in two matters pick the
     * right copy. Absent from older hubs; older agents ignore it. */
    cwd: z.string().optional(),
  }),
  /** Full on-demand process listing for the hardware view (top by CPU). */
  'proc.list': z.object({}),
  /** Send TERM (default) or KILL to one process on the machine. */
  'proc.kill': z.object({ pid: z.number().int().min(2), signal: z.enum(['TERM', 'KILL']).optional() }),
  // ---- Runtimes: install and log into the coder on the machine -------------
  // The «Начало» screen's two buttons. Every call returns within seconds and
  // the work continues on the machine as a JOB the browser polls — an RPC
  // answer has 30 s, a login has 15 minutes. Device owner only (hub/rpc.rs):
  // a login is that person's subscription, not something a control-share
  // member may start on a colleague's box.
  /** `npm install -g @openai/codex` with the agent's own node. Claude never
   *  needs installing: sessions run the binary bundled with the agent. */
  'runtime.install': z.object({ runtime: z.enum(['claude', 'codex']) }),
  /** Codex: device code through its app-server (`account/login/start`) — a
   *  URL and a code to type there. Claude: `claude auth login` — a URL to open
   *  and a code to paste back through `runtime.login.input`. */
  'runtime.login.start': z.object({ runtime: z.enum(['claude', 'codex']) }),
  'runtime.login.input': z.object({ loginId: z.string(), code: z.string().max(4096) }),
  'runtime.login.cancel': z.object({ loginId: z.string() }),
  /** Where an install or login job stands. `id` is a `jobId` or a `loginId`. */
  'runtime.job.status': z.object({ id: z.string() }),
} as const;

export type RpcMethod = keyof typeof RpcParams;
export const RpcMethodSchema = z.enum(
  Object.keys(RpcParams) as [RpcMethod, ...RpcMethod[]],
);

// ---- Files ----------------------------------------------------------------
/**
 * Everything past `name`/`kind` is OPTIONAL, and must stay that way: iOS decodes
 * this struct in a shipped TestFlight build (`ios/CCRemoteKit/.../Rpc.swift`),
 * where unknown keys are ignored but a reshaped envelope is a decode failure.
 * Add optional siblings; never wrap or rename.
 */
export interface FsEntry {
  name: string;
  kind: 'dir' | 'file';
  /** Bytes, for files. Omitted for directories: a directory's own st_size is the
   *  inode's and means nothing to a person reading a file list. */
  size?: number;
  /** mtime, ms epoch. Absent when the entry could not be stat'd — a broken
   *  symlink, or a race with a delete. The row still appears. */
  mtime?: number;
  /** The entry is a symlink. `kind` describes what it points AT when the target
   *  resolves inside the project; a link that leaves is reported as a file here
   *  and refused by every other fs.* call. */
  link?: boolean;
}
export interface FsListResult {
  /** Path relative to cwd ('' = cwd root). */
  path: string;
  entries: FsEntry[];
  /** The directory holds more than FS_MAX_ENTRIES. */
  truncated?: boolean;
  /** How many entries it really has, when truncated. */
  total?: number;
}
export interface FsReadResult {
  path: string;
  content: string;
  truncated: boolean;
}
export interface FsWriteResult {
  path: string;
  bytes: number;
}
export interface FsDownloadResult {
  path: string;
  offset: number;
  /** base64 of this window's bytes. */
  data: string;
  /** Raw bytes in this window (`data.length` is the base64 length). */
  bytes: number;
  /** Total size of the file. Carried on EVERY window, not just the first, so a
   *  caller can size a progress bar and notice a file rewritten underneath it. */
  size: number;
  /** mtime, ms epoch. A change between windows means two generations, and the
   *  caller must restart rather than stitch them together. */
  mtime: number;
  eof: boolean;
}
export interface FsUploadBeginResult {
  uploadId: string;
  /** The name the file will ACTUALLY get: validated, and suffixed when it
   *  collided and `overwrite` was not set. Show it — someone who dropped
   *  `отчёт:final.pdf` deserves to see what landed. */
  name: string;
  /** Destination relative to cwd, with that name. */
  path: string;
}
export interface FsUploadChunkResult {
  /** Bytes written so far; the next window starts here. */
  received: number;
}
export interface FsUploadCommitResult {
  path: string;
  bytes: number;
}
export interface FsMkdirResult {
  path: string;
  /** False when it already existed — a folder drop re-creating a subdirectory is
   *  not an error. */
  created: boolean;
}
export interface FsRenameResult {
  /** The new path, relative to cwd. */
  path: string;
}
export interface FsTrashResult {
  ok: boolean;
  /** Where it went. Required, unlike `ProjectRemoveResult`'s: with no restore
   *  call yet, this string is the entire recovery story. */
  movedTo: string;
}

// ---- Git ------------------------------------------------------------------
export interface GitFileStatus {
  path: string;
  /** Porcelain XY code, e.g. ' M', 'A ', '??'. */
  code: string;
  staged: boolean;
}
export interface GitStatusResult {
  isRepo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
}
export interface GitBranchesResult {
  current: string;
  all: string[];
}
export interface GitCommitResult {
  ok: boolean;
  output: string;
}

// ---- Session history ------------------------------------------------------
export const RenderBlockSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('thinking'), text: z.string() }),
  z.object({ kind: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({
    kind: z.literal('tool_result'),
    toolUseId: z.string(),
    text: z.string(),
    isError: z.boolean().optional(),
  }),
  // A user turn's image attachment. The bytes stay OUT of the history payload —
  // a session with several screenshots would bloat every reload, and that is
  // still true — but the marker now carries a `ref` the client can trade for
  // the picture when it actually wants to show it (`session.image`).
  //
  // Optional, and it has to stay optional: every transcript written before this
  // existed has markers without one, and an agent older than the hub keeps
  // sending them. No ref = the old placeholder, which is what those clients
  // already draw.
  //
  // `generated` marks a picture the runtime MADE (Codex `image_generation_call`,
  // Claude `hegai-image`), carried on an assistant message of its own; `prompt`
  // is the prompt as the generator rewrote it, when known. Its ref starts with
  // `gen:` and resolves through the same `session.image`. Old clients ignore
  // both fields and draw the picture as an attachment, which is still right.
  z.object({
    kind: z.literal('image'),
    ref: z.string().max(200).optional(),
    generated: z.boolean().optional(),
    prompt: z.string().max(4000).optional(),
  }),
  // The runtime compacted the context here. Carried on a `system` message so a
  // reload shows the same seam the live stream showed (`compact_done`), instead
  // of a history that silently skips from a long conversation to a short one.
  z.object({
    kind: z.literal('compact_boundary'),
    trigger: z.enum(['manual', 'auto']),
    preTokens: z.number().optional(),
    postTokens: z.number().optional(),
  }),
  // The summary the runtime wrote in place of the compacted turns. On disk it
  // is a `user` record flagged `isCompactSummary`; rendered as a person's own
  // words it was a multi-kilobyte turn nobody typed. Carried on a `system`
  // message, folded by clients.
  z.object({ kind: z.literal('compact_summary'), text: z.string() }),
]);
export type RenderBlock = z.infer<typeof RenderBlockSchema>;

/** `data` of a live `status` event with `code: 'image_gen'` (see protocol.ts).
 *  One `id` per picture: `started` arrives first, then exactly one of `done`
 *  (with `ref`, the same kind the history's `image` block carries) or `failed`.
 *  The image bytes never ride the stream — they are 1–2 MB; clients fetch them
 *  by `ref` through `session.image`, retrying an empty answer briefly because
 *  the transcript line may land a moment after the event. */
export const ImageGenEventDataSchema = z.object({
  id: z.string(),
  state: z.enum(['started', 'done', 'failed']),
  /** Epoch ms when generation began — the client's progress clock. */
  startedAt: z.number().optional(),
  prompt: z.string().max(4000).optional(),
  ref: z.string().max(200).optional(),
  error: z.string().max(500).optional(),
});
export type ImageGenEventData = z.infer<typeof ImageGenEventDataSchema>;

/** Canonical, source-independent transcript record. It is also the durable
 * replication payload, so Claude and Codex histories remain identical in the
 * online RPC, the live mirror, and the hub's offline copy. */
export const HistoryMessageSchema = z.object({
  type: z.enum(['user', 'assistant', 'system']),
  uuid: z.string(),
  blocks: z.array(RenderBlockSchema),
  /** When the turn happened, ms since epoch — read from the transcript record.
   *  Drives the per-bubble time and the day separators. Absent for older agents
   *  and for transcript lines with no usable timestamp; the UI then shows no
   *  time rather than inventing one. */
  ts: z.number().optional(),
  /** The model that wrote this ASSISTANT turn (Claude's `message.model`, a wire
   *  id like `claude-opus-5-5`). Lets a detached composer name the model the
   *  session will continue on instead of the placeholder «модель» (27.09.2026).
   *  Absent for user/system records, Codex rollouts and older agents. */
  model: z.string().optional(),
  /** Private machine: `blocks` (then []), `ts` and `model` sealed in one envelope. */
  e2e: E2eField,
});
export type HistoryMessage = z.infer<typeof HistoryMessageSchema>;
export interface SessionMessagesResult {
  messages: HistoryMessage[];
  /** The hub answered from its replica because the agent missed its deadline:
   *  the transcript may lack the last minute or so. Absent when the agent
   *  (or a current replica) answered. */
  stale?: boolean;
}

// ---- Session ops ----------------------------------------------------------
export interface SessionForkResult {
  sessionId: string;
}

// ---- Projects (new-session picker) ----------------------------------------
export interface ProjectInfo {
  /** Absolute working directory. */
  cwd: string;
  /** Display label (last path segment). */
  label: string;
  /** ms epoch of the most recent session in this cwd. */
  lastModified: number;
  /** How many sessions live in this cwd. */
  count: number;
  /** 'root' = found by scanning the projects root (a git repo with no sessions
   *  yet — e.g. one just created); 'adopted' = a directory someone took into the
   *  list by hand (`projects.adopt`), which is the only origin that survives
   *  having neither `.git` nor a session; 'sessions' or absent = derived from
   *  sessions. */
  origin?: 'sessions' | 'root' | 'adopted';
}
export interface ProjectsResult {
  projects: ProjectInfo[];
  /**
   * The directories this agent SCANS for projects — its projects root plus
   * whatever `CC_REMOTE_FILES_ROOTS` declares.
   *
   * Reported so a client can offer "add a project from a folder on this
   * machine" without guessing where that machine keeps work: `/srv` on one box,
   * `~/work` on another, `C:\work` on a third. Optional, because an agent older
   * than this field answers without it and the caller must degrade to browsing
   * from the projects it already knows rather than showing an empty picker.
   */
  roots?: string[];
}
export interface ProjectCreateResult {
  cwd: string;
  label: string;
  /** False when the directory already existed and was reused (empty dir). */
  created: boolean;
  git: 'init' | 'clone';
}
export interface ProjectRemoveResult {
  ok: boolean;
  /** Where the directory went (the agent's trash), so nothing is lost silently. */
  movedTo?: string;
}
export interface ProjectAdoptResult {
  cwd: string;
  label: string;
  /** The directory was already a project — by adoption, by a session, or because
   *  the root scan finds it. Adoption is idempotent, so this is what tells the UI
   *  to say "уже в списке" instead of claiming it added something. */
  alreadyKnown: boolean;
}
export interface ProjectForgetResult {
  ok: boolean;
  /** False when the cwd was not on the adopted list — e.g. it is a git repo the
   *  root scan finds anyway, which forgetting cannot hide. Saying so is the
   *  difference between "removed" and a button that appears to do nothing. */
  forgot: boolean;
}

// ---- Processes / hardware -------------------------------------------------
export const ProcessSampleSchema = z.object({
  pid: z.number(),
  /** CPU percent as reported by ps (may exceed 100 on multicore). */
  cpu: z.number(),
  /** Resident set size, bytes. */
  rss: z.number(),
  command: z.string(),
});
export type ProcessSample = z.infer<typeof ProcessSampleSchema>;

/** One periodic hardware sample from an agent. All byte fields are bytes. */
export const MachineStatsSchema = z.object({
  ts: z.number(),
  platform: z.string(),
  cpuCount: z.number(),
  load1: z.number(),
  load5: z.number(),
  load15: z.number(),
  /** Whole-machine CPU busy %, 0–100 (delta between samples; 0 on the first). */
  cpuPercent: z.number(),
  memTotal: z.number(),
  memUsed: z.number(),
  swapTotal: z.number(),
  swapUsed: z.number(),
  diskTotal: z.number(),
  diskUsed: z.number(),
  uptimeSec: z.number(),
  /** The agent's own footprint, so its cost stays visible in the UI. */
  agentRss: z.number(),
  agentCpuPercent: z.number(),
  top: z.array(ProcessSampleSchema),
});
export type MachineStats = z.infer<typeof MachineStatsSchema>;

export interface ProcListResult {
  processes: ProcessSample[];
}
export interface ProcKillResult {
  ok: boolean;
  error?: string;
}

// ---- Models ---------------------------------------------------------------
export interface ModelInfoLite {
  id: string;
  name?: string;
  /** Wire model id this row's `id` resolves to ('opus' -> 'claude-opus-5-5'), when
   *  the row is an alias. The runtime reports the RESOLVED id as the live model,
   *  so without this the picker cannot tell which of its own rows is running. */
  resolved?: string;
  /** Reasoning efforts this model accepts, as the runtime names them. Kept as
   *  plain strings on purpose: the CLI also reports 'max', which `EffortLevel`
   *  deliberately excludes because it is not live-settable — a strict enum here
   *  would make the whole model list fail validation. Consumers intersect it
   *  with what they can actually set. Absent = unknown, offer them all. */
  efforts?: string[];
  /** Explicitly false = the effort control does nothing on this model. */
  supportsEffort?: boolean;
}
export interface ModelsResult {
  models: ModelInfoLite[];
}
/** One entry of the composer's «/» menu. */
export interface SlashCommandInfo {
  name: string;
  description?: string;
  argumentHint?: string;
}
export interface CommandsResult {
  commands: SlashCommandInfo[];
}
/**
 * Curated model list — the agent's `models.list` answer when `CC_REMOTE_MODELS`
 * is unset, and the web's fallback when that RPC is unreachable. One list, so a
 * model bump can't land on one side only.
 *
 * Current generation only — a selector of retired models is worse than a short
 * one. Ordered most to least capable, so the top entry is the one to reach for
 * on hard work. An older model pinned for a specific project goes through
 * `CC_REMOTE_MODELS` on the machine that needs it, which overrides this list
 * wholesale.
 */
export const DEFAULT_MODELS: ModelInfoLite[] = [
  { id: 'claude-fable-5-1', name: 'Fable 5.1' },
  { id: 'claude-opus-5-5', name: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' },
];

// ---- Result validation ----------------------------------------------------

const OkResultSchema = z.object({ ok: z.boolean() });
const OutputResultSchema = z.object({ ok: z.boolean(), output: z.string() });
/**
 * One install or login job on a machine, as the «Начало» screen draws it.
 * `running` with a `userCode` is «введите код на странице»; `running` with
 * `needsInput` is «вставьте код из браузера»; `done` means the login file is
 * written and the agent has re-read its runtimes; `failed` carries the last
 * lines the tool printed, so the screen can say why.
 */
const RuntimeJobSchema = z.object({
  id: z.string(),
  kind: z.enum(['install', 'login']),
  runtime: z.enum(['claude', 'codex']),
  state: z.enum(['running', 'done', 'failed']),
  /** Page to open (Codex: the device-code page; Claude: the OAuth page). */
  url: z.string().optional(),
  /** Code to type on that page (Codex device code). */
  userCode: z.string().optional(),
  /** The tool is waiting for a code pasted back (`runtime.login.input`). */
  needsInput: z.boolean().optional(),
  expiresAt: z.number().optional(),
  /** Last lines from the tool, ≤600 chars — the reason when `failed`. */
  tail: z.string().max(600).optional(),
});
const FsEntrySchema = z.object({
  name: z.string(),
  kind: z.enum(['dir', 'file']),
  size: z.number().optional(),
  mtime: z.number().optional(),
  link: z.boolean().optional(),
});
const GitFileStatusSchema = z.object({
  path: z.string(),
  code: z.string(),
  staged: z.boolean(),
});
const GitWorktreeSchema = z.object({
  path: z.string(),
  /** Short branch name; absent for a detached HEAD. */
  branch: z.string().optional(),
  head: z.string(),
  /** This is the repository's main working tree, not a linked one. */
  main: z.boolean(),
  /** Uncommitted entries (porcelain lines). */
  dirty: z.number().int().nonnegative(),
  /** Commits against the repository's default branch, when one is known. */
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional(),
  /** A live run uses this directory right now. */
  busy: z.boolean().optional(),
});
const GitDiffLineSchema = z.object({
  kind: z.enum(['+', '-', ' ']),
  old: z.number().int().optional(),
  new: z.number().int().optional(),
  text: z.string(),
});
const GitDiffFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  status: z.enum(['added', 'deleted', 'modified', 'renamed']),
  binary: z.boolean().optional(),
  /** Looks like a credential file (.env, keys, .npmrc…): contents are not sent. */
  withheld: z.boolean().optional(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  hunks: z.array(
    z.object({
      header: z.string(),
      lines: z.array(GitDiffLineSchema),
    }),
  ),
});
export type GitWorktree = z.infer<typeof GitWorktreeSchema>;
export type GitDiffFile = z.infer<typeof GitDiffFileSchema>;
export type GitDiffLine = z.infer<typeof GitDiffLineSchema>;
const ProjectInfoSchema = z.object({
  cwd: z.string(),
  label: z.string(),
  lastModified: z.number(),
  count: z.number().int().nonnegative(),
  origin: z.enum(['sessions', 'root', 'adopted']).optional(),
});
const ModelInfoLiteSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  resolved: z.string().optional(),
  efforts: z.array(z.string()).optional(),
  supportsEffort: z.boolean().optional(),
});

/**
 * Runtime result contract keyed by the request method. The WebSocket envelope
 * cannot select a result schema without its request id, so callers keep the
 * method in their pending registry and validate when the response arrives.
 */
/** What `sync.list` / `sync.set` answer. `candidates` are the folders this
 *  machine has sessions in — paths and counts only, no titles — so a person
 *  can pick without the sessions themselves having left the machine. */
export const SyncStateSchema = z.object({
  mode: z.enum(['all', 'selected']),
  projects: z.array(z.string()),
  candidates: z.array(z.object({ cwd: z.string(), sessions: z.number().int().nonnegative() })),
  chatOnly: z.boolean(),
});
export type SyncState = z.infer<typeof SyncStateSchema>;

export const RpcResultSchemas = {
  'fs.list': z.object({
    path: z.string(),
    // Bounded here too, not just in the agent: a misbehaving or older agent must
    // not be able to hand the browser a 200k-entry array to parse on the main
    // thread.
    entries: z.array(FsEntrySchema).max(FS_MAX_ENTRIES),
    truncated: z.boolean().optional(),
    total: z.number().int().nonnegative().optional(),
  }),
  'fs.read': z.object({ path: z.string(), content: z.string(), truncated: z.boolean() }),
  'fs.write': z.object({ path: z.string(), bytes: z.number().int().nonnegative() }),
  'fs.download': z.object({
    path: z.string(),
    offset: z.number().int().nonnegative(),
    data: z.string().max(FS_CHUNK_B64_MAX),
    bytes: z.number().int().nonnegative().max(FS_CHUNK_BYTES),
    size: z.number().int().nonnegative(),
    mtime: z.number(),
    eof: z.boolean(),
  }),
  'fs.peek': z.object({
    path: z.string(),
    offset: z.number().int().nonnegative(),
    data: z.string().max(FS_CHUNK_B64_MAX),
    bytes: z.number().int().nonnegative().max(FS_CHUNK_BYTES),
    size: z.number().int().nonnegative(),
    mtime: z.number(),
    eof: z.boolean(),
  }),
  'fs.upload.begin': z.object({ uploadId: z.string(), name: z.string(), path: z.string() }),
  'fs.upload.chunk': z.object({ received: z.number().int().nonnegative() }),
  'fs.upload.commit': z.object({ path: z.string(), bytes: z.number().int().nonnegative() }),
  'fs.upload.abort': OkResultSchema,
  'fs.mkdir': z.object({ path: z.string(), created: z.boolean() }),
  'fs.rename': z.object({ path: z.string() }),
  'fs.trash': z.object({ ok: z.boolean(), movedTo: z.string() }),
  'git.status': z.object({
    isRepo: z.boolean(),
    branch: z.string(),
    ahead: z.number().int().nonnegative(),
    behind: z.number().int().nonnegative(),
    files: z.array(GitFileStatusSchema),
  }),
  'git.stage': OkResultSchema,
  'git.unstage': OkResultSchema,
  'git.commit': OutputResultSchema,
  'git.branches': z.object({ current: z.string(), all: z.array(z.string()) }),
  'git.checkout': OutputResultSchema,
  'git.worktree.add': z.object({ path: z.string(), branch: z.string() }),
  'git.worktree.list': z.object({ worktrees: z.array(GitWorktreeSchema) }),
  'git.worktree.remove': z.object({ ok: z.boolean(), output: z.string() }),
  'git.diff': z.object({
    files: z.array(GitDiffFileSchema),
    /** The 2 MB cap cut the diff short; the files list is what fit. */
    truncated: z.boolean(),
  }),
  'git.push': z.object({ ok: z.boolean(), output: z.string(), url: z.string().optional() }),
  'git.pr.create': z.object({ ok: z.boolean(), url: z.string().optional(), output: z.string() }),
  'session.messages': z.object({
    messages: z.array(HistoryMessageSchema).max(2000),
    /** The hub answered from its replica after the agent missed its deadline
     *  (`SessionMessagesResult.stale`). Optional here or the web's parse strips it. */
    stale: z.boolean().optional(),
  }),
  'session.rename': OkResultSchema,
  'session.delete': OkResultSchema,
  'session.fork': z.object({ sessionId: z.string() }),
  'session.subagent': z.object({ messages: z.array(HistoryMessageSchema).max(2000) }),
  'run.stopSubagent': OkResultSchema,
  'models.list': z.object({ models: z.array(ModelInfoLiteSchema) }),
  'commands.list': z.object({
    commands: z.array(
      z.object({ name: z.string(), description: z.string().optional(), argumentHint: z.string().optional() }),
    ),
  }),
  'projects.list': z.object({
    projects: z.array(ProjectInfoSchema),
    roots: z.array(z.string()).optional(),
  }),
  'projects.create': z.object({
    cwd: z.string(),
    label: z.string(),
    created: z.boolean(),
    git: z.enum(['init', 'clone']),
  }),
  'projects.remove': z.object({ ok: z.boolean(), movedTo: z.string().optional() }),
  'projects.adopt': z.object({
    cwd: z.string(),
    label: z.string(),
    alreadyKnown: z.boolean(),
  }),
  'projects.forget': z.object({ ok: z.boolean(), forgot: z.boolean() }),
  'sync.list': SyncStateSchema,
  'sync.set': SyncStateSchema,
  /** `dataB64` is the raw base64 of the image, no data-URL prefix; the client
   *  builds the URL from `mediaType`. The HUB may shrink it on the way past —
   *  see `images::shrink` — so this is "the picture", not "the original file". */
  'session.image': z.object({ mediaType: z.string(), dataB64: z.string() }),
  'proc.list': z.object({ processes: z.array(ProcessSampleSchema) }),
  'proc.kill': z.object({ ok: z.boolean(), error: z.string().optional() }),
  'runtime.install': z.object({ jobId: z.string() }),
  'runtime.login.start': RuntimeJobSchema,
  'runtime.login.input': OkResultSchema,
  'runtime.login.cancel': OkResultSchema,
  'runtime.job.status': RuntimeJobSchema,
} satisfies Record<RpcMethod, z.ZodType>;

export type RuntimeJob = z.infer<typeof RuntimeJobSchema>;
