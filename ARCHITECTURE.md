# Architecture

cc-remote lets you view, control, and resume Claude Code and Codex sessions that live on
other machines, from one browser. This document explains how the pieces fit and
why the shape is the way it is.

> New here? Read the [README](README.md) first for the 60-second pitch and how to
> run it. This file is the deeper map. For the UI look-and-feel, see
> [DESIGN.md](DESIGN.md). To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

## The core constraint

A Claude Code session can only be resumed **on the machine where its files live,
in its original working directory**. Local files, local MCP servers, and the
`~/.claude` config are all machine-local. So a cloud UI can only ever be a
*viewport*. The runtime has to stay local.

That single fact drives the whole design: each machine runs a small **agent
daemon**, a **central service** federates those agents, and the **browser** talks
only to the central service.

```
 Browser ──ws/https──▶ Central service (VPS, behind nginx)
                          │  WS hub + durable SQLite session replicas
                          ▼
        Mac Mini / Windows / Cloud  ── agent daemon ──▶ Claude SDK / Codex app-server
```

## Two hard rules the system enforces

1. **One writer per session.** Two processes appending to one transcript
   `.jsonl` corrupt it. Enforcement is three-layered:
   - the **hub** refuses `open` when the inventoried session has a `livePid`,
     and holds a per-session lock so two browsers cannot open the same run
     (`open_run` in [server-rs/src/hub.rs](server-rs/src/hub.rs));
   - the **agent re-checks liveness at the moment of resume** — hub inventory
     can be ~6s stale — and refuses with a `yielded` status instead of spawning
     a second writer (`resume` in [agent/src/run-manager.ts](agent/src/run-manager.ts));
   - mid-run, the agent's **yield watcher** hands the session back if an editor
     takes it (`checkYields` in the same manager).

   - after the launch the agent runs a short **burst** of the same check (0,
     0.3, 1 and 3 s): an editor that opened the session between the pre-check
     and the SDK spawn is yielded within seconds. The window itself cannot be
     closed without the CLI's cooperation — this narrows it;
   - a liveness record whose **pid was reused** by another process is ignored
     (`sameProcess` in [agent/src/sessions.ts](agent/src/sessions.ts): the
     CLI's `procStart` token, else the OS start time against `startedAt`), and
     a kill re-reads the token before every signal (`kill-pid.ts`);
   - a run's **process is not its stream**: a Codex app-server lives on after
     `run_status: ended` for up to the kill grace and leaves no pid file. The
     agent waits for its confirmed exit before reopening the same session
     (`SessionRun.exited`, `RunManager.dying`) and refuses when the bound
     passes; the hub keeps a **closing guard** (`closing_writers`) from a
     terminal status that says `closing: true` until the agent's
     `writer_released` or `RUN_CLOSING_MAX_MS`, so an agent restart in that
     window cannot hand the session to a second writer.

   **Force takeover** is the one sanctioned path to open a live session: the
   agent SIGTERM→SIGKILLs every live writer pid, **confirms death**, then
   resumes as the sole writer (`takeover`). It clears the closing guard.
2. **Agents dial out only.** No inbound ports are opened on your machines. In
   production the agent connects out to `wss://code.example.com` through nginx
   (see [Production deployment](#production-deployment)). The central service is
   the only thing that listens.

## The five workspaces

This is an npm workspaces monorepo. Build order matters: `shared` first, then the
rest depend on it.

| Workspace | Language | Role |
|-----------|----------|------|
| [`shared/`](shared/src) | TypeScript + zod | The wire protocol. One source of truth for every message that crosses the wire, validated at runtime. |
| [`agent/`](agent/src) | TypeScript | The per-machine daemon. Discovers sessions, resumes them, streams output, applies input, gates tools, serves files/git/terminal. |
| [`server/`](server/src) | TypeScript | Dev/test CLIs (WS clients) that drive the hub headlessly — one file per smoke in [`server/src/cli/`](server/src/cli), indexed in deploy/SMOKE-TESTS.md, over a shared `_harness.ts`. Not a hub. |
| [`web/`](web/src) | TypeScript (React + Vite) | The browser SPA: a side panel with the session list, a top bar whose account popover leads to the destinations (Сессии, Доска, Отчёты, Проекты, Файлы, Команда, Настройки — [`shell/navModel.ts`](web/src/shell/navModel.ts)), the live session view, command palette, tool approval. A second, light entry lives in `web/lite`. |
| [`tgbot/`](tgbot/src) | TypeScript | The Telegram client — a third `/ui` consumer beside `web/` and `ios/`, speaking the same protocol. A chat shows only the agent's speech; tool calls sit behind a setting. Access is a Telegram-id whitelist over one shared hub identity. |

The hub and the rest of the repository are not npm workspaces:

- [`server-rs/`](server-rs/src) — **the central hub** (Rust/axum): the WS
  endpoints `/agent` and `/ui`, routing, the single-writer lock, attention/board
  state, mirror routing, a durable SQLite session catalog, and static-file
  serving. It also owns the HTTP surface — `/api/*` (sign-in and OAuth callbacks,
  workspaces, board, reports, the fleet API…), `/install/*` (installers and the
  agent bundle) and `GET /health`; the router in
  [`server-rs/src/main.rs`](server-rs/src/main.rs) is the list. Built as a tiny
  single binary (release profile is `opt-level = "z"`, `lto`, `strip`). The
  original Node/Fastify hub (`server/src/hub.ts`) was retired once this reached
  parity and went live.
- [`deploy/`](deploy) — everything that builds, installs and operates the fleet:
  the self-contained agent bundle (`agent.mjs`), the hub and agent deploy and
  install scripts, sandbox/browser/phone tooling and the runbooks (see «The
  deploy/ inventory» under Production deployment).
- [`ios/`](ios), [`android/`](android) and [`windows/`](windows) — the native
  clients and the desktop shell; [`skills/`](skills) — the workflows the fleet
  bundle carries; [`docs/`](docs) — internal audit and automation notes;
  [`.github/`](.github) — CI. See «The surfaces, as they are» below.

## The wire protocol (`shared/`)

Every message is a zod schema, so both ends validate at runtime instead of
trusting types that vanish at compile time. There are two channels.

### Browser ↔ Central ([web-protocol.ts](shared/src/web-protocol.ts))

The `BrowserToCentral` and `CentralToBrowser` unions in that file are the
authoritative list of frames; what follows names the groups, not every frame.

Browser to central:
- Session control: `open`, `takeover` (force), `input`, `interrupt`, `close`,
  `tool_decision`, `compact`, `end_session`
- Run tuning: `set_model`, `set_permission_mode`, `set_effort` — and the same
  three as optional fields on `new_session`, for a session that does not exist
  yet to be tuned before its first turn
- Discovery: `rescan`, `subscribe`, `unsubscribe`
- RPC: `rpc_request` (files, git, session management, models)
- Terminal: `term_open`, `term_input`, `term_resize`, `term_close`
- Mirror: `mirror_open`, `mirror_close`
- Connection state: `hello` (the client names itself, so the hub can tag a run's
  `origin`), `ping` (every 25s; the hub ignores it, NAT/LB idle timeouts don't),
  `pause` / `resume` (a backgrounded client silences its socket; `resume` is
  answered with a fresh snapshot; `pause` with `acks: true` — the web — still
  receives `opened` / `session_started` / `error` / `run_status`, so a session
  started just before the window hid learns its run; iOS sends a plain `pause`
  and resubscribes on resume instead), `register_push` / `unregister_push` (native
  push tokens)
- Hardware telemetry: `stats_interest {on}` — a client that sends
  `statsOnDemand` in `hello.caps` is sent `machine_stats` only while its last
  `stats_interest` said `on` (and gets each controlled machine's last stored
  sample at once on the transition to `on`); a client without the cap keeps the
  always-on stream. Per socket, forgotten with it: re-send after a reconnect.
- Hub-held state: `session_read` (below), `set_stage`, `enrich_request`
  (titles and quick replies), `memory_list` / `memory_read` / `memory_delete`

Central to browser:
- `snapshot` (full machine/session inventory), `activity` (live run-state board
  feed), `opened`, `stream` (assistant/tool/thinking events), `user_turn` (hub-identified human turns), `tool_request`
  (approval needed), `run_status`, `error`, `rpc_response`, terminal
  (`term_opened` / `term_data` / `term_exit`), and mirror (`mirror_opened` /
  `mirror_data` / `mirror_exit` — the agent behind a mirror went away).

The rest of that union follows the same pattern — per-machine session lists and
deltas (`machine_sessions`, `session_updates`), run state (`run_mode`,
`run_settings`, `context_usage`), usage and runtime readouts, `session_reads`,
`enrich_result`, `memory_*_result` — and is read from the union,
not from this list. Closed enums matter on this channel: `ActiveRunInfo.origin`
is `app | web | fleet` on every client, and an unknown value fails the whole
snapshot, so a new origin is a coordinated wire change.

What the hub does NOT send, so a phone can sleep: a paused socket is skipped
before any broadcast is built for it (and pinged every 100 s instead of 25 s);
`usage` / `codex_usage` only when the limits changed (not `updatedAt`);
`activity` only when that viewer's board changed, with run heartbeats merged
into one broadcast on a 500 ms tick; a `snapshot` requested again inside 500 ms
is one trailing snapshot, and an agent's `register` / a `session_started` tell
delta-capable viewers about one machine (`machine_sessions`) instead of the
fleet; an inventory whose only change is the replica cursor `fileMtime`;
`context_usage` repeating the last tuple (a subscriber is replayed the current
one); an identical `subagents` collection. A UI socket whose outbound queue
exceeds 8 MiB is dropped like one whose frame queue is full.

A `subscribe` to a working run is answered with the current turn's replay
window (`remember_stream_frame`, server-rs/src/hub.rs: at most 400 frames or
256 KB, cleared when the turn ends), sent as separate frames. The window is
compacted as it fills so a long turn replays cheaply: adjacent `partial`
deltas are one frame, an `assistant` block takes the place of the deltas it
repeats, and
only the newest heartbeat (`requesting`, `turn_usage`) of each
code is kept. iOS assembles the window off screen and publishes it in one write;
frames that never touch the transcript (`rpc_response`, session-list patches,
an `activity` that keeps the run attached and working) do not end the staging.

`user_turn` is a separate hub frame, also sent to the sender and replayed on
subscribe. iOS confirms local echoes by `turnId`/text and preserves their full
text and attachment bytes; other devices see the capped text and attachment
counts/names. Replay is staged in wire order, with pending local echoes merged
at commit and repositioned if their frame arrives after a replay gap. History
remains intact; only a proven overlapping spoken prefix is removed from the
live view. Hub-identified turns allow up to 30 seconds of delayed runtime
persistence. An older file timestamp or ambiguous truncated prefix is retained
rather than guessed to be the same turn.
The web keeps user lines across a reconnect as `carried`; its own replay of
that `turnId` moves the line to its place in the turn (a replay addressed to
another view on the socket does not), and a sub-agent's `<task-notification>`
on an Agent result is never read as the person's speech when aligning history
with the stream.

`snapshot.roadmap` carries the server-owned editorial product grouping used by
the native Roadmap/Map boards. The hub validates either its built-in default or
the `CC_REMOTE_ROADMAP_CONFIG` JSON override. An older server that omits the
field makes iOS fall back to neutral one-lane-per-project grouping.

### Agent ↔ Central ([protocol.ts](shared/src/protocol.ts))

The agent registers (`register` with machine identity), then relays the same
session and terminal traffic the browser asks for. The central service is a
router in the middle: it never runs Claude itself. `AgentToCentral` and
`CentralToAgent` in that file are the authoritative lists. Beyond the traffic
above they carry the handshake — `register_ack` names the runs the hub adopted,
and `agent_superseded` tells a second daemon on the same machine id to exit
instead of reconnecting — the session `inventory` and the live `run_inventory`,
and the `memory_*` frames of the memory sync.

Transcript replication uses `session_sync_catalog` followed by transactional
`session_sync_begin` → one or more `session_sync_chunk` frames →
`session_sync_commit` → `session_sync_ack`. Appends become visible only through
the committed message count. A rewrite builds a separate hidden generation and
atomically swaps it on commit, so a dropped socket can never expose half a
transcript.

A session summary carries two times. `lastModified` is the sort key: for a
Claude session it is the last record history renders, so CLI bookkeeping
written after the conversation (`cost-state` at every process exit,
`last-prompt`, `ai-title`) does not move it ([agent/src/claude-activity.ts](agent/src/claude-activity.ts)).
`fileMtime`, present when it differs, is the file's own mtime and the
replication cursor: the agent's `syncedMtime` skip/commit and the hub's
`replica_is_current` compare it, never the sort key.

### RPC surface ([rpc.ts](shared/src/rpc.ts), dispatched in [agent/src/rpc-dispatch.ts](agent/src/rpc-dispatch.ts))

Request/response calls the browser makes against a specific machine.
`RpcParams` in [shared/src/rpc.ts](shared/src/rpc.ts) is the list of methods
(each with its result schema beside it); the groups below carry the design
notes:

- `session.messages` / `session.rename` / `session.delete` / `session.fork`, and
  the read-only `session.image` (one attachment's bytes) and `session.subagent`
- **Files** — the «Файлы» destination:
  `fs.list` (size/mtime/link, capped at `FS_MAX_ENTRIES` with `truncated`) /
  `fs.read` (utf8 preview, 512KB, cut on a character boundary) /
  `fs.write` / `fs.download` (ranged, binary-safe) /
  `fs.mkdir` / `fs.rename` / `fs.trash` /
  `fs.upload.begin|chunk|commit|abort`, plus `fs.peek` — the chat's preview of
  an image or `.md` an answer names: same windows and answer as `fs.download`,
  but only `FS_PEEK_EXTENSIONS`, at most `FS_PEEK_MAX_BYTES`, and from inside
  `cwd` or the system temp tree (`/tmp`, `os.tmpdir()`) when the request names
  a temp path OUTSIDE `cwd` itself and it resolves there too; a path named
  inside `cwd` must resolve inside it (also for a project under /tmp) ([agent/src/fs-peek.ts](agent/src/fs-peek.ts)). Clients find the paths in
  answer text themselves.
  Bytes move in 512KB windows ([shared/src/rpc.ts](shared/src/rpc.ts)
  `FS_CHUNK_BYTES`) because the hub's outbound queue counts FRAMES, relays each
  one through its single task, and a browser rejects any RPC after 30s. An HTTP
  download route on the hub is the obvious v2 and would be a CONSUMER of this
  same windowed protocol — agents dial out only, so the bytes cross the socket
  either way.
  **Which directories** is decided by the agent
  ([agent/src/fs-roots.ts](agent/src/fs-roots.ts)): the projects root,
  `CC_REMOTE_FILES_ROOTS`, and the cwds of known sessions, persisted so a root
  cannot fall out of reach when the inventory window moves, and with rootish
  paths (`/`, a bare home) filtered — a real fleet has sessions recorded in `/`,
  and admitting one opens the whole disk. This is a guard-rail, not a sandbox:
  the unix user the agent runs as is the only real boundary.
  Writes additionally refuse agent/credential state and anything inside `.git`,
  and refuse when a live session owns the path
  ([agent/src/fs-manage.ts](agent/src/fs-manage.ts)) — deleting
  `~/.claude/sessions/<pid>.json` would otherwise hide a live editor from the
  single-writer check. Deletes move to the shared trash
  ([agent/src/trash.ts](agent/src/trash.ts)), swept by age.
  The hub requires `can_control` for everything except `fs.list`/`fs.read`/
  `fs.download`/`fs.peek`, which a control-share member may call **inside the share's
  roots** (`path_is_within`, mirroring the control-share start check). A member
  who can start sessions (`can_start`, no control) additionally gets exactly two
  more things: `session.rename` on any session the hub shows them, and
  `fs.mkdir` of **one new folder directly in a shared root** (`cwd` must equal
  the root after normalisation, not merely lie inside it; the hub forces
  `recursive:false`, so no parents are made and an existing entry is an error; a single
  name: ≤64 chars, no `/` `\` `:`, no leading dot; `single_folder_name` in
  [server-rs/src/hub/rpc.rs](server-rs/src/hub/rpc.rs)) — the start screen's
  «Новая папка». The same member may also upload a chat attachment over the
  inline limit: `fs.mkdir` of `.hegai-uploads` at the root, then `fs.upload.begin`
  (cwd = the root, `dir` exactly `.hegai-uploads`, no `overwrite`) and
  chunk/commit/abort only for an upload this connection began on this machine
  (`member_uploads`, at most 16 per connection, dropped on disconnect). The web
  puts a `.gitignore` (`*`) in that folder first
  ([web/src/chatUpload.ts](web/src/chatUpload.ts)). Deleting a session stays with its owner. It writes
  `file.uploaded|renamed|trashed` and `dir.created` to the audit log, and bounds
  in-flight RPCs per connection so a 700KB window cannot be queued without limit.
- `git.status` / `git.branches` / `git.checkout` / `git.commit` / `git.stage` / `git.unstage`
- **Parallel agents and review** ([agent/src/worktree-ops.ts](agent/src/worktree-ops.ts)):
  `git.worktree.add` cuts a branch into `<repoParent>/.hegai-worktrees/<repo>/<branch>`
  (outside the repo, unlike Claude's own `.claude/worktrees`, which the web hides),
  `git.worktree.list` (dirty / ahead-behind / `busy`) and `git.worktree.remove`
  (refuses the main tree, a dirty one without `force`, and any folder a live run
  uses). `git.diff` answers parsed files/hunks with line numbers, capped at 2 MB
  with `truncated`; `git.commit` takes `all`. `git.push` and `git.pr.create` (a
  compare-page URL, or `gh pr create` on GitHub — no token of ours) are
  **owner-of-machine only** in the hub gate, like `runtime.*`; chat-only machines
  refuse every write here. The web's «Изменения» sheet and the start screen's
  «В отдельной ветке» use them.
- `models.list` (the run-time model picker; the runtime's own list wins over
  `CC_REMOTE_MODELS`) and `commands.list` (the slash commands a composer offers)
- **Run confinement** (`CC_REMOTE_CONFINE_RUNS=<prefix>`, off by default,
  [agent/src/confine.ts](agent/src/confine.ts)): the hub gate says who may open
  a matter, but a Codex process under the agent's unix user could still read the
  neighbouring matter on disk and its rollout in `~/.codex/sessions`. With the
  env set, every Codex run is spawned inside bubblewrap (`spawnCodex` →
  `confinedCommand`): the machine read-only, `$HOME` and `/etc/cc-remote` blank,
  `<prefix>` blank except the run's **unit** (first segment, `delo-x`; or
  `_personal/<id>`) read-write, and a private `CODEX_HOME`
  (`~/.codex-units/<unit>-<hash>`, config/auth/skills copied from `~/.codex`).
  The unit is a pure function of the cwd (realpath; lexical and real unit must
  agree, so symlink escapes refuse), hence a resume spawns into the same unit; a
  rollout from another unit or from the pre-confinement `~/.codex` is refused.
  A cwd outside the prefix, a missing `bwrap`, and any Claude run fail closed.
  `listRollouts` (inventory, history, title, mirror, resume lookup, delete) and
  the inventory watcher read the base sessions dir plus every
  `~/.codex-units/*/sessions`. Setup and verification: deploy/FLEET.md
  «Confining coder runs per matter».
- `projects.list` / `projects.create` / `projects.remove` — the «Создать проект»
  button ([agent/src/project-ops.ts](agent/src/project-ops.ts)): everything
  stays under `CC_REMOTE_PROJECTS_ROOT` (default `~/work`, capped by
  `CC_REMOTE_MAX_PROJECTS`), git runs via `execFile` with no shell, and
  `remove` renames into `~/.cc-remote/trash/` rather than deleting. The hub
  requires `can_control` for both and writes `project.created|removed` to the
  audit log (`audit_project_rpc` in [server-rs/src/hub.rs](server-rs/src/hub.rs)).
  `projects.adopt` / `projects.forget` list an existing directory without
  creating or deleting anything.
- Machine policy and processes: `sync.list` / `sync.set` (which folders'
  sessions leave the machine, [agent/src/policy.ts](agent/src/policy.ts)),
  `proc.list` / `proc.kill` (the hardware view).
- Runtimes on the machine: `runtime.install`, `runtime.login.start|input|cancel`
  and `runtime.job.status` — long work runs as a job the browser polls, and the
  hub allows these to the device owner only (`hub/rpc.rs`).

## Data flow: opening a session

1. Browser sends `open { machineId, sessionId, message? }`.
2. Central checks the single-writer lock and the live-in-editor flag. If the
   session is busy, it refuses.
3. Central routes the open to the right agent.
4. Agent re-checks liveness (the hub's inventory can be stale), then selects the
   source runtime: Claude Agent SDK `query({ options: { resume, cwd,
   canUseTool } })` or a persistent `codex app-server` thread.
5. SDK output streams back: assistant text, tool calls, thinking, status. The
   agent forwards each event to central, which fans it out to subscribed browsers
   as `stream` messages.
6. In a mode that asks, a tool that needs approval pauses the run and emits
   `tool_request`; the browser shows the approval modal, and the user's
   `tool_decision` unblocks the active runtime approval flow. That is not where
   a session starts by default. Where the machine allows it, a session without a
   named mode runs in `bypassPermissions` (`defaultPermissionMode` and
   `bypassAllowed` in [agent/src/claude-session.ts](agent/src/claude-session.ts);
   `CC_REMOTE_ALLOW_BYPASS=0` or a chat-only machine turns it off), and under
   bypass the SDK never calls `canUseTool`. What still guards the run is the
   `PreToolUse` hook `protectedPathHook`, which runs in every mode. A machine's
   own default is `CC_REMOTE_DEFAULT_PERMISSION_MODE`, parsed once for both
   runtimes in [agent/src/permission-mode.ts](agent/src/permission-mode.ts)
   (an unknown value is ignored); a client may still name a mode per session.

For a brand-new session, `new_session.source` selects the same runtime; without
one the agent's `CC_REMOTE_DEFAULT_SOURCE` decides (Claude when unset). The hub
pins `codex` only for a workspace member who does not control the machine —
Claude there would spend the device owner's login (`new_session` in
[server-rs/src/hub.rs](server-rs/src/hub.rs)). Owners and managers, and a member
on a machine they own themselves, follow the picker. A pinned Codex session
starts a fresh thread using the machine's configured Codex provider. This
product selection does not itself enforce a gateway. Internal automation
separately requires gateway enforcement; see
Internal automation.

## Live mirror and takeover

A session that is currently open in an editor cannot be resumed (rule 1). But you
can still watch it. The agent tails the transcript `.jsonl` and streams it to the
browser as a read-only **mirror** ([web/src/panels/Mirror.tsx](web/src/panels/Mirror.tsx),
opened via `openMirror`). There is no second writer, so it is always safe to watch
even while the editor is actively driving the session.

The Mirror has no separate takeover buttons. Sending from its composer emits the
`takeover` message: the hub takes the same per-session lock but skips the live
refusal, and the agent terminates the editor's writer (SIGTERM→SIGKILL), confirms
the pid is gone, then resumes. The first message rides in the takeover payload,
so it is sent only once the agent owns the session.

## Attention state: the board feed

Every active run carries an **attention state**: `working`, `needs_attention`,
`idle`, or `error` ([web-protocol.ts](shared/src/web-protocol.ts)). The central
service broadcasts an `activity` feed of all runs across all machines. The
session list, the notification bell, the colored status pills and the split
panes render that feed, so you can watch many parallel agents at a glance
without subscribing to each one. (The «Доска» destination is a different thing:
it reads `GET /api/board`, see `web/` below.)

A successful Claude CLI `result` may finish a foreground turn while child
agents keep running. The adapter holds that result until SDK idle, an empty
background-task set, and the settlement grace agree. Only then does the hub
receive completion; APNs, unread badges and all clients share that decision.
The `taskStartedAt` timestamp is recorded at user input delivery by the agent
(including steer), re-announced on reconnect and carried in activity/snapshots.
Timers use it; `since` remains the attention-state timestamp for unread markers.

### Read marks across devices

A session finished on one device used to stay "unread" on the others. A client
that has a session on screen sends `session_read {machineId, sessionId}`; the
hub (`hub/reads.rs`, table `session_reads` in `session_reads.rs`) stamps its own
clock, keeps the latest mark per person and session, and pushes `session_reads`
to all of that person's sockets. It checks the same view access as
`session.messages`, ignores what the person cannot see or the hub does not
know, keeps the newest 2000 marks per person, and does not rebroadcast a repeat
within 2 s (stored, not sent: a duplicate from two tabs or a reconnect). A new
socket of an active person gets the last 14 days of marks that pass the same
view check, right after the snapshot. Clients compare `at` with the finished run's `since`
(or a bell entry's time): read at or after it means the completion was seen.
Account erasure takes the table with the user (`ON DELETE CASCADE`).

Finished turns are stored beside the marks (`session_completions`, same file):
on a genuine `working -> idle` of a run with a recorded owner, the hub keeps
`{machineId, sessionId, at = run.since}` per owner and session (newest 2000) —
no answer text, since the table outlives transcript purges, private mode and
session deletion. A run re-adopted after a hub restart takes the stored finish
as its `since`, not the restart time, so an answer read before the restart
does not come back unread. A run does not survive an agent restart (self-update after every hub
deploy) or the six-hour idle reaper, so a phone asleep through both saw neither
the finish nor the run — on 31.10.2026 four overnight answers came back with
no dots. A new socket gets the last three days of finishes right after the
marks; iOS turns one into an unread dot unless the phase it saved is as new or
newer, or a mark covers it. The web ignores the frame (its «готово» is the
bell, raised live).

"On screen" is strict, because a wrong mark loses an answer on the person's
other devices: iOS counts only the foreground chat with the drawer closed; the
web counts only the focused pane of a split, only while the window is visible
AND focused (`document.hasFocus()` — a window behind others still reports
`visible`), and only after 3 s there since the last change of what is on screen
(`READ_DWELL_MS` in `useCentral.ts`; every change starts the count over).
Before 20.10.2026 the web marked every column of a visible tab at once, so a
desktop window waking with four columns restored cleared the phone's green dots.

Known limit: the web keeps incremental marks (`reads`, `readSentAt`) for the
life of the tab; the hub prunes its table to 2000 rows per person but does not
tell clients what it dropped. A reload resets both.

## Tape («Лента», the «Личное» mode) — removed 16.10.2026

One endless conversation with an assistant (Teo) over a chain of ordinary
sessions, each finished turn rewritten by a small model; a dispatcher, a «front»
model and a task watcher sat beside it. It was switched off in production on
14.10.2026 and deleted in two commits; `git log -- server-rs/src/tape.rs` is the
archive. The fleet **task registry** that grew inside it stayed
(`server-rs/src/tasks.rs`, `hub/tasks.rs`, `hub/fleet_tasks.rs`;
`/api/fleet/tasks*`, `hegai-fleet task`, `spawn/send --task`) with its two tables
`tape_tasks` and `tape_task_links` — the old names are kept so existing rows
stay. The hub drops the tape's other tables at schema init (`tape_replies`,
`tape_segments`, `tape_cards`, `tape_dispatch`, `tape_dispatch_projects`,
`tape_front`). On the hub box the leftover systemd drop-in `95-tape.conf`
(`CC_REMOTE_TAPE_*`, `LLM_TAPE_*`, `LLM_FRONT_*`, `LLM_DISPATCH_*`) is read by
nothing and can be deleted.

## State model (today)

The durable portion lives in SQLite ([server-rs/src/replica.rs](server-rs/src/replica.rs)):
machine identities, the complete session catalog, replication cursors, and
canonical render-ready Claude/Codex messages. A browser's `session.messages` RPC
is served from this replica when available, including while the source machine
is offline. Agents reconcile the full manifest on connect, then use filesystem
watchers and the server cursor to send only appended messages; a later full scan
repairs missed watcher events. Original JSONL files remain authoritative and are
never written by the hub.

`session.messages` is deliberately a recent-history API: it defaults to the
newest 1000 messages (caller maximum 2000). The limit is messages, never raw
bytes: one huge tool result or image must not hide earlier speech (a single
record over `MAX_LINE_BYTES` is skipped unparsed). Tool payloads are clipped when
the caller asks, and the offline SQLite path applies the limit in SQL.

How the agent reads a Claude transcript depends on its size
([agent/src/history.ts](agent/src/history.ts), the constants carry the numbers):

- up to `STREAM_HISTORY_THRESHOLD`: the SDK reconstructs the conversation on each
  read, which is cheap at that size;
- above it, up to `CLAUDE_TRANSCRIPT_MAX_BYTES`: parsed once and kept, then only
  extended from the last byte offset ([jsonl-incremental.ts](agent/src/jsonl-incremental.ts));
  a file rewritten in place is noticed and parsed again. Re-parsing a large file
  on every read once missed the hub's deadline and froze the session's replica;
- above `CLAUDE_TRANSCRIPT_MAX_BYTES`: the history RPC keeps one bounded pass
  that holds only the requested window, and the replica skips the file.

A Codex rollout is read by the same incremental machinery under its own cap,
`CODEX_TRANSCRIPT_MAX_BYTES` ([agent/src/codex.ts](agent/src/codex.ts)). Before
replicating a session the agent applies both caps (`transcript-replicator.ts`), so an
oversized one stays readable through the window but never reaches the replica.

An explicit `head: true` on `session.messages` reads the first at most 40
messages from the committed hub replica, under the same session visibility
check. It never forwards to an agent or substitutes a recent tail. iOS uses
this bounded opening alongside recent speech to generate navigation titles via
`enrich_request` with `purpose: "session_title"`. That purpose has a separate
prompt, response field (`sessionTitle`) and cache key from quick replies.
Titles are cached per account on the client; the CLI-owned name and transcript
are unchanged, and manual renames take precedence.

The hub also names sessions itself, from the work rather than the opening line
([server-rs/src/hub/titles.rs](server-rs/src/hub/titles.rs)). What a list shows
otherwise is the Claude CLI's `ai-title`, one guess from the first message, and
the SDK's `customTitle` is `customTitle || aiTitle`, so it looks like a rename.
The agent therefore reads the transcript for a real `custom-title` record and
sends `titleDerived: true` when nobody chose the name
([agent/src/claude-title.ts](agent/src/claude-title.ts)). A slow scan on the
replica picks settled sessions from the last 7 days (machines listed in
`LLM_TITLE_MACHINES`; unset = off; `sdk-cli` cron runs are skipped), sends a digest
of user messages, tool names and answers to the title model, and stores the result
in `session_titles` and on the catalog row. Every later write of that summary wears
it (`wear_generated_title`), so clients receive it as the plain `title` and need no
change. A session is named once and the name never changes, because a name that
moves loses the session in the list; only a pass that produced nothing is retried
as the session grows. A rename clears `titleDerived` and ends all of this;
transcripts are never touched.

Ephemeral control state remains **in memory**: live agent sockets, active runs,
the per-session writer lock, terminals, mirrors, approvals, and pending RPCs.
Those objects correctly die on restart; the catalog and read-only history do not.

## Agent internals (`agent/`)

- [`sessions.ts`](agent/src/sessions.ts) — discovery via the SDK `listSessions()`
  plus a liveness overlay (which sessions are live in an editor right now). It
  passes `includeProgrammatic: true` so programmatic **`sdk-ts`** sessions (runs
  created from the phone or web, not just an interactive CLI) appear in the
  inventory, and merges in a scan of **OpenAI Codex** transcripts
  (`~/.codex/sessions/**`, tagged `source: 'codex'`).
- [`codex.ts`](agent/src/codex.ts) — the single owner of Codex rollout
  discovery, exact-UUID lookup, inventory metadata/title parsing, history
  normalization, and live-mirror parsing. [`codex-run.ts`](agent/src/codex-run.ts) resumes a thread
  through a persistent `codex app-server`, including plan/default collaboration
  mode and interactive `request_user_input` choices. Busy input goes straight to
  `turn/steer` with the current `expectedTurnId`; idle input uses `turn/start`.
  Dispatch is serialized, including the start-id and completion/steer races.
  Explicit rejections retain input for the next turn, while ambiguous timeouts
  report unconfirmed delivery without replay. Manual compaction holds input
  until it completes. Temporary image files survive all steers of their turn.
  Codex sub-agents are separate threads narrated on the same pipe: a
  notification whose `threadId` is not this run's thread is ignored, or a child's
  `turn/completed` would end the parent turn and flip the session to idle.
  [`mirror.ts`](agent/src/mirror.ts)
  tails either a Claude or a Codex `.jsonl` with the matching parser.
- [`claude-session.ts`](agent/src/claude-session.ts) — the resume loop, streaming,
  input/interrupt/close, the permission posture (`defaultPermissionMode`,
  `bypassAllowed`), the `canUseTool` gate for modes that ask, and the
  `PreToolUse` `protectedPathHook` that guards in every mode, bypass included.
- [`harness.ts`](agent/src/harness.ts) — the default division of labour in a
  Claude session: `Explore` (replaces the built-in, which inherits the parent
  model) and `implementer` run on Sonnet, `reviewer` on Opus, `codex-reviewer`
  wraps `codex review`; a `systemPrompt` string tells an Opus/Fable session to
  orchestrate. It is a plain string on purpose: sessions never passed one, the
  SDK turns «none» into an empty custom prompt, and the `claude_code` preset
  would swap every session's base prompt. `CC_REMOTE_HARNESS=off` disables it.
- [`plan-tool.ts`](agent/src/plan-tool.ts) — `mcp__hegai__plan`, the session's
  checklist, served in-process (`createSdkMcpServer`, `alwaysLoad`, pre-allowed).
  Claude Code's own `TodoWrite`/`TaskCreate` are switched off per model by a
  remote flag (Opus 5.5 has neither on CLI 2.1.319), so the agent supplies one
  tool with TodoWrite's input for every model and disallows the native ones; a
  rule appended to the system prompt makes the model use it (the description
  alone did not). Clients count «done/total» off the latest call after the last
  human turn (shared/src/plan.ts); a sub-agent's calls never reach clients, so
  `SubagentTracker` folds them into `Subagent.plan`. `CC_REMOTE_PLAN_TOOL=off`
  disables it.
- [`run-manager.ts`](agent/src/run-manager.ts) — the single owner of writable
  run lifecycle: liveness settlement, resume/takeover input queues, runtime
  controls, tool-approval timeouts, yield, and disconnect cleanup. This is where
  the agent half of the single-writer invariant lives.
- [`history.ts`](agent/src/history.ts) — normalizes Claude transcript records;
  interactive history reads a bounded message window (three size tiers, see
  «State model») while full replication remains guarded by the replica size cap.
- [`mirror.ts`](agent/src/mirror.ts) — read-only `.jsonl` tail for the Mirror;
  holds partial trailing records and serializes drains.
- [`fs-ops.ts`](agent/src/fs-ops.ts) / [`git-ops.ts`](agent/src/git-ops.ts) /
  [`terminal.ts`](agent/src/terminal.ts) — what a machine offers a browser
  directly. The file tree and git actions (`fs-ops.ts`, `fs-manage.ts`,
  `git-ops.ts`) are request/response calls over RPC; the terminal
  (`terminal.ts`, a `node-pty` shell) is the one that is a stream, with its own
  `term_*` frames.
- [`rpc-dispatch.ts`](agent/src/rpc-dispatch.ts) — validates RPC params against
  the [shared/src/rpc.ts](shared/src/rpc.ts) schemas, then dispatches the
  fs/git/session/models handlers.
- [`profile.ts`](agent/src/profile.ts) / [`usage.ts`](agent/src/usage.ts) — the
  per-machine **builder profile**, streamed line-by-line across local JSONL files
  (fanned out as `builder_profile`, covered by
  `profile-smoke`) and the token-usage figures behind the web usage meter.
  The hub can pause the Claude half of that polling per device owner: see
  «Claude monitoring» below.
- [`client.ts`](agent/src/client.ts) — the dial-out WS connection to central,
  with auto-reconnect (a `handshakeTimeout` guards against wedging when the hub
  restarts and every agent reconnects at once), Claude + Codex filesystem
  watchers, and incremental transcript reconciliation.

### Claude monitoring

The hub can pause Claude background monitoring by device owner with
`CC_REMOTE_CLAUDE_MONITORING_PAUSED_OWNERS` (apply/reverse on hub restart).
`register_ack.claudeUsageEnabled` tells the agent whether to call Claude's
usage/profile APIs; polling waits for that acknowledgement. The hub suppresses
Claude ops alerts and quota readings for paused owners even from older agents,
which still need to self-update before their own HTTP checks stop. Sessions,
Codex monitoring and runtime updates remain available.

### Who started the run: `HEGAI_RUN_USER_ID` / `HEGAI_RUN_USER_EMAIL`

A script inside a coder session can learn which Hegai Code user started (or
resumed) the run from two env vars of the coder process. The hub puts
`runBy: {userId, email?}` into `new_session` / `resume` / `takeover`, taken from
the authenticated UI connection of the person who clicked (not the device or
session owner); fleet and automation starts carry none. The agent
(`runUserEnv` in [`agent/src/child-env.ts`](agent/src/child-env.ts)) validates
both against `[A-Za-z0-9._@+-]{1,320}` (a failing field is dropped), and sets
them for the Claude CLI and the `codex app-server` process. Without `runBy` the
vars are absent, and `childEnv` never forwards a `HEGAI_RUN_USER_*` inherited
from the agent's own environment.

Trust level: an identity hint for cooperative scripts, **not a security
boundary**. The values come from the hub's authenticated user, but the coder
process (often root) can change its own env. `HEGAI_RUN_USER_*` are fixed per
process, and colleagues may type into a live run, so the starter is not always
the author of the current turn.

`HEGAI_RUN_STATE_FILE` closes that gap. It is the path of a per-run JSON file in
the agent's private dir (`~/.cc-remote/run-state/<runId>.json`, dir 0700, file
0600, replaced atomically; [`agent/src/run-state.ts`](agent/src/run-state.ts)):
`{"startedBy": RunBy|null, "lastInputBy": RunBy|null, "updatedAt": iso}`. The hub
adds `by` (the typing user of that UI connection) to every `input` frame; the
agent rewrites `lastInputBy` BEFORE handing the turn to the coder (the first turn
is the starter's own; an input without `by` — Telegram bot, fleet — sets null),
and removes the file when the run ends. A turn is written when it is queued, so
while a turn is running only the SAME author keeps the name; anyone else (or an
unattributed input) makes it null («mixed») until a turn starts with no turn in flight
(the agent counts handed-over turns and results; if a runtime merges queued inputs
into one turn the count stays up and the run stays mixed until it ends — fail closed). If the
file cannot be written it is deleted rather than left stale. The agent also sweeps
the directory once at daemon start, and `childEnv` strips any inherited `HEGAI_RUN_*` in any letter case.
Tool approvals, AskUserQuestion answers and plan acceptance count too: the UI
`tool_decision` frame carries `by`, and an answer from anyone other than the
recorded author (or with no `by`) makes `lastInputBy` null; the same person
changes nothing. An accepted Codex plan, which makes the runtime send «Implement
the plan.» itself, is also counted as a turn in flight.

Known limitation: the Telegram bot (`tgbot`) talks to the hub as its one
configured hub user (today the owner; its allow-list is the owner only), so its
starts and inputs are attributed to that user. If the bot's allow-list ever
grows, its traffic must stop carrying that identity (or carry the mapped
person), otherwise a script would treat a stranger's message as the owner's.

Rule for a cooperative script: act on a person's behalf (read their archive,
use their credentials) only if `lastInputBy.userId == HEGAI_RUN_USER_ID`;
otherwise refuse or ask. Still a hint, not a boundary.

## Memory: notes that follow the repository

Claude Code keeps per-project notes in `~/.claude/projects/<slug>/memory/` and
loads `MEMORY.md` into context at the start of every session. cc-remote does not
invent a memory system — it **replicates that one across machines**, so what you
learned on one box is there on the next.

Four properties carry the design:

- **Identity is the git remote**, not the path
  ([`memory.ts`](agent/src/memory.ts)). The same repository at
  `/Users/me/repo` and `/root/repo` produces two unrelated on-disk slugs, so a
  path-derived key would never let the notes meet. A directory with no remote is
  skipped: it has no identity that survives the trip.
- **Content sync is asymmetric.** The harness writes these files, so the hub is
  a courier and never an author. A note only ever comes DOWN into a gap, or as
  an update the machine provably has not touched since it last agreed with the
  hub (the agent keeps that last-agreed sha in `~/.cc-remote/memory-state.json`).
  When both sides moved, local wins and the agent logs a conflict — losing a
  human's edit is worse than a stale hub row.
- **Deletion travels as a tombstone.** The row survives with `deleted=1` and
  stays in the agent catalog. Without that marker a machine still holding the
  file would push it back on the next reconcile and the delete would never
  stick. The agent retires its copy into `~/.cc-remote/deleted-memories/`
  instead of destroying it.
- **Opt-in per machine** (`CC_REMOTE_MEMORY_SYNC`). Notes arrive as trusted
  context, so a shared or employee sandbox must not feed the owner's machines by
  default.
- **The index is NOT replicated.** `MEMORY.md` is a local view of what this
  machine holds, not shared knowledge, and last-writer-wins destroys it: a box
  with two notes overwrites the index of a box with twenty-five, and the
  surviving index lists none of the files that are actually on disk — they stay
  there and nothing points at them, which is gone in every way that matters.
  Each machine keeps its own, and an arriving note gets a pointer line appended
  with `O_APPEND`. Append rather than rewrite is the safety property: the
  harness writes this same file, and a read-modify-write would silently drop
  whatever it added in between, so the worst case here is a duplicate line
  instead of a lost entry.

Scopes are declared by the file name, because there is no global memory
directory — Claude Code only loads `projects/<slug>/memory`, so a fleet note kept
anywhere else would replicate perfectly and never be read:

| name | scope | lands in |
|------|-------|----------|
| `anything.md` | project | that repository's memory dir |
| `fleet--anything.md` | fleet | every project dir, on every opted-in machine |
| `machine--anything.md` | machine | every project dir, on that host only |

The browser sees the store through `memory_list` / `memory_read` /
`memory_delete` — user-scoped, unlike the agent's machine-scoped
`memory_catalog`. Covered by `memory-smoke` (agent path) and `memory-ui-smoke`
(browser path, including that a tombstone reaches the agent).

## Client and hub state boundaries

- The web client keeps request correlation in `pending-registry.ts` and moves
  transcript/activity transitions through pure `central-reducers.ts`; reconnect
  behavior is tested without mounting React or opening a socket.
- iOS uses `PendingRegistry.swift` for RPC, terminal-open, and mirror-open
  continuations. Timeouts, socket loss, and partial-resource cleanup share one
  path instead of three continuation dictionaries.
- iOS hamburger and drawer share one prepared owned-session corpus. The
  account-scoped completion read store also remembers viewed decision IDs;
  `pendingRequestId` identifies replayed requests independently of refreshed
  activity timestamps. Opening the drawer does not acknowledge either kind
  of badge; a foreground chat does. Decision acknowledgement is local display
  state and never sends a tool decision to the agent.
- iOS home reuses the owned drawer corpus, grouped into decisions, working tasks
  and completed results. Settled activity previews and completion timestamps live
  in the account-scoped read cache, without per-row transcript reads. Reading
  clears the dot while retaining a bounded recent history; new work supersedes
  the old result. Logo navigation preserves the new-chat project/draft and does
  not request the keyboard. Native settings use a root list and focused pages.
- iOS history preserves opaque image refs and resolves them through the existing
  `session.image` RPC for Claude, Codex and mirror views. ImageIO downsamples off
  the main actor; a bounded memory cache keys account/workspace scope, machine,
  session, runtime and ref. Scope changes cancel pending loads and reject stale
  results; image bytes are not added to the persistent transcript cache.
- iOS remembers observed model settings per account/machine/session for display
  only. Opening a chat never reapplies the new-session defaults. An explicit
  model pick in a dormant chat sends an input-free `open`, waits for
  `run_settings`, then sends `set_model` and waits for the changed settings
  before enabling input. Unchanged picks complete immediately because the
  agent only emits settings on change. Disconnect, focus changes and control
  failures cancel the pending operation without submitting a draft.
- The Rust hub remains one single-owner task, but routing concerns are separated:
  `hub/agent_run.rs` handles run stream/status/tool frames, `hub/rpc.rs` handles
  access-controlled RPC and durable-history fallback, `hub/wire.rs` owns typed
  field readers/message constants, and `workspace_api.rs` owns workspace HTTP
  handlers. The single-writer maps still have one owner in `hub.rs`.

## Production deployment

### The fleet (agents dial in)

Every agent dials out to `wss://code.example.com`; there are no inbound ports.
Supervision differs per OS, so there is no single "restart the agent" command —
see deploy/FLEET.md for the machine inventory and per-host
update steps:

- **macOS** (e.g. the Mac mini) — a per-user **launchd** LaunchAgent
  (`ai.heg.ccremote.agent`), installed by `install-mac.sh` into `~/cc-remote-agent`.
- **Linux** (cloud, the hub box itself, the hegai box) — the **systemd** unit
  `cc-remote-agent` under `/home/cc-remote-agent`, installed by `deploy-server.sh`.
- **Windows** (buildbox-pc) — the `install-win.ps1` layout: a per-user
  **Scheduled Task** `cc-remote-agent` (at logon plus a 5-minute keepalive
  trigger) running `%USERPROFILE%\cc-remote-agent\agent.mjs`, additionally
  supervised by the Hegai Code Windows app when it is open. (It used to be a
  repo checkout autostarted by AutoHotkey; migrated, checked 2026-08-29.)
- **Community sandboxes** (stage) — one `cc-remote-sandbox@sb-<slug>` systemd
  unit per member, running as that unix user under `sandboxes.slice`, from a
  shared read-only release in `/opt/cc-remote-agent`; created by the
  provisioner daemon, not by hand ([deploy/sandbox/](deploy/sandbox)).

### Self-update

Agents update themselves (bundle 0.3.2, 24.09.2026), so a hub deploy is also the
fleet rollout. On every connect and every 30 minutes an agent
([`agent/src/self-update.ts`](agent/src/self-update.ts)) compares the hash of
its own bundle with the one the hub advertises. The hub serves the bundle it was built with at
`/install/agent.mjs` and the hash at `/install/agent.mjs.sha256` (both from the
binary, so they cannot disagree; `deploy-hub.sh` still publishes the same pair
under nginx's `/dl/` for the first self-updating bundles). The agent checks the
download against the hash, loads it with `--self-test` against its own
`node_modules`, and swaps it in only when no run is mid-turn or waiting on a
person, keeping the old file as `agent.mjs.prev`; its supervisor (systemd,
launchd, the Scheduled Task, the desktop app) then starts the new one. A source
run never updates itself, `CC_REMOTE_AUTO_UPDATE=0` pins a machine, and
`CC_REMOTE_UPDATE_URL` points the agent somewhere else. The installers
(`install-linux.sh`, `install-mac.sh`) verify the same `.sha256` before they
install (16.10.2026). Agents dial out only, so a machine still on a bundle from
before self-update has to be updated **on the box**: on Windows with
[`update-win.ps1`](deploy/update-win.ps1), on mac/linux with a `curl` of the
bundle plus a service restart (see the runbook).

## Authentication

The WS endpoints are gated per identity, not by a shared device secret:

- **A device credential** — what an enrolled agent presents on `/agent`
  (`agent_credential` in [`server-rs/src/main.rs`](server-rs/src/main.rs)): minted
  from a one-time enrollment code, bound to one machine and one owner, and
  revocable. Authentication and workspace authorization are done by the hub
  itself, not by an nginx SSO gate:
  `deploy/nginx-code.example.com.conf` proxies
  `/agent` and `/ui` straight through.
- **`CC_REMOTE_TOKEN`** — the fleet token, kept as a legacy escape for machines
  that predate enrollment: `/agent` still accepts it (`CC_REMOTE_FLEET_MACHINE_IDS`
  can limit which machine ids it admits at `register`). It opens `/ui` only on a
  dev hub (token left at `dev-token`) or where `CC_REMOTE_FLEET_UI=1` is set
  explicitly — see `ui_user` in `main.rs`. Against production the smoke CLIs must
  carry a real workspace session; the fleet token gets 401 there.
- **A workspace session** — what browsers and the iOS app both carry. The browser
  keeps it in the `__Host-cc-remote-auth` cookie (host-only, `Secure`; only a plain-http
  dev hub uses the bare `cc-remote-auth` — an https hub rejects it and merely
  expires a stale one, so cookies from before the prefix mean one more sign-in); the app receives it from
  `GET /api/auth/google/start?native=1` (the HegAI `sso/start` is kept for service logins and old builds), which ends in a redirect to
  `ccremote://auth?session=…` (captured by `ASWebAuthenticationSession`), stores
  it in the Keychain, and presents it as `?token=` on the socket and
  `Authorization: Bearer` on the REST API. Native sessions last 90 days and slide
  forward on use; browser sessions keep their week; neither outlives an absolute
  ceiling of 180 days from sign-in (`SESSION_MAX_MS` in
  [`server-rs/src/workspace.rs`](server-rs/src/workspace.rs)), however much it is
  used.
  `location = /mobile/ui` still exists as the app's rate-limited entry point, but
  it now proxies a *user* session — a phone is a person, with their own
  workspaces and access, not a second key to the owner's fleet.
- **A second factor on the hub's own sign-in**
  ([`server-rs/src/mfa.rs`](server-rs/src/mfa.rs)). The hub controls every fleet
  machine, so a forged first factor (a Google/Telegram account, a sign-in link, an
  SSO token minted with `CC_REMOTE_SSO_SECRET`) must not be a working session for a
  person who owes a second one: whoever has a confirmed authenticator
  (`user_totp`), and every platform admin once the hub runs with
  `CC_REMOTE_ADMIN_MFA=required`. Every path that mints a session decides it in one
  place (`mfa_pending_in`): a person who owes the factor and whose path did not
  check a code gets `auth_sessions.mfa_pending=1`. `WorkspaceStore::authenticate`
  — the choke point of every HTTP gate and of `/ui`, `/mobile/ui` and the bearer
  paths — treats a pending row as an unknown token. Only `GET /api/auth/mfa/state`,
  `POST /api/auth/mfa/verify`, the enrolment endpoints and logout look at one
  (`authenticate_pending`); `/verify` flips THIS session (TOTP or a recovery code,
  5 attempts per account and 10 per address in 15 minutes, audit
  `auth.mfa.verified` / `auth.mfa.failed`). A pending session may never
  enrol (state `blocked` for an admin with none; a forged first factor must not
  attach a phone): enrolment (`/api/auth/totp/begin|confirm`) is for a satisfied
  session younger than ten minutes — for a platform admin only the `tool:enrol`
  session a root-minted one-time link (`mfa-enroll-link`) opens; enrolling demotes
  the person's other ordinary sessions; a pending session lives ten minutes and
  failed codes are counted in SQLite (`mfa_attempts`); `POST /api/auth/totp/disable` and
  `/recovery` need a current code, and the admin cannot disable while the flag is
  on. Rows that existed when it shipped keep `mfa_pending=0`: nobody is signed
  out by the rollout. A native browser sign-in (iOS `ccremote://`, Android
  `hegai-code://` code) does not emit its hand-off until the code is verified: the
  hub holds the target on the session (`mfa_next`, built by `finish_login`, never
  taken from the client; the Android code is bound to that session and
  `android_exchange` refuses it while pending) and `/verify` returns it as `next`.
  Paths with no browser (the native Telegram poll, Apple's exchange) answer
  `403 {error:"mfa_browser_required"}`. Exempt on purpose: support login (grant-
  bound account), the Apple Watch session (derived from a satisfied one) and the
  service UI pass (scope-confined; pending only for a held admin). Internal tools
  that signed in as an admin through the SSO secret use a root-minted session
  instead (`cc-remote-server mint-tool-session`, audited `auth.tool_session`;
  `mfa-reset --email` clears a lost authenticator, audited `auth.mfa.reset` —
  deploy/FLEET.md). The external edition keeps its own rule
  (the owner's code is checked in the password sign-in), so none of this applies.
- **Who the session belongs to** is a hub account (`users.user_id`), reached
  through a way of signing in: `identities (provider, subject) → user_id`
  ([`server-rs/src/identity.rs`](server-rs/src/identity.rs)). Providers: `hegai`
  (SSO), `google`, `telegram`, `apple`; every account that predates the table has
  `('hegai', its own id)`, so an SSO login opens exactly the account it always did.
  `users.email` is optional since that migration (a Telegram-only person has no
  address); an SSO login whose address another account already holds is refused
  with 409 instead of a UNIQUE-violation 500 — accounts are merged by a person.
  A signed-in person attaches more ways in to the SAME account («Способы входа»,
  `GET /api/me/identities`, `POST /api/me/identities/unlink`): Google by
  `/api/auth/google/start?link=1` (session cookie) or `link=<ticket>` (a one-use
  ticket from `POST /api/auth/google/link`, bound to the app's bearer session;
  the callback only stages the result, which that same session confirms with
  `POST /api/auth/google/link/confirm`, so a forwarded start URL links nothing;
  every link callback also needs the state cookie of the browser that began it), Apple by
  `/api/auth/apple/exchange` with a bearer session, Telegram by its link flow.
  The account is always bound on the hub at the start of the hop, never taken
  from the callback. A login never re-points an identity; a link may
  (`identity::attach`): an identity that opened an EMPTY account of its own is
  moved, that account is suspended («merged into …»), its sessions end and its
  address is released; one whose account holds machines, sessions, teams,
  memory, reports, a sandbox or a seat is refused (`identity_owner_has_data`).
  The last way into an account cannot be unlinked; an unlinked identity is
  remembered (`identity_unlinks`) so a Google login cannot re-adopt the account
  by its address; unlinking Apple revokes its token at Apple first. Every account, admins and the owner included, may use
  every provider (09.10.2026).

**Push / notifications** run server-side from the hub
([`server-rs/src/notify.rs`](server-rs/src/notify.rs)): **APNs** delivers approval
prompts to the iOS app (a push can briefly wake the app to answer), configured via
the `APNS_*` drop-in env — spoken directly over HTTP/2 with `reqwest` and an
ES256 provider token from `jsonwebtoken` (no `a2`; one TLS stack); a Telegram
notifier is also wired in. APNs
`BadDeviceToken`/`Unregistered` responses feed back into the hub to prune stale
registrations, while preserving a token re-registered after the invalidation.

Per-user identity, workspaces and roles (owner / manager / member), project
shares, device enrollment (one-time codes → revocable device credentials, the
fleet token kept as a legacy escape) and the `audit_events` log all exist today
([server-rs/src/workspace.rs](server-rs/src/workspace.rs),
[workspace_api.rs](server-rs/src/workspace_api.rs)). The community rollout
added on top of them: `user_access` behind a single gate, self-serve teams,
hub-managed gateway seats and a sandbox provisioning queue (next section). MFA
is not there; Postgres is still open. Claude itself authenticates with your
existing login (`~/.claude/.credentials.json`); on a headless server you run
`claude setup-token` once.

### Service integrations and the list on a share

A fourth credential class: a **service key** (`CC_REMOTE_SERVICE_KEYS_FILE`,
[`server-rs/src/service_api.rs`](server-rs/src/service_api.rs)) lets another
product of ours, inside one workspace, on named machines and under one folder
prefix, publish shares **with a list of people** and sign those people in
(`/api/service/shares`, `/api/auth/service-signin`). A **restricted** share
(`project_shares.restricted` + `project_share_members`) is open only to the
people on its list, the workspace owner and the device owner — the flag, not the
row count, so erasing the last listed person cannot reopen it. It is enforced in
`WorkspaceStore::machine_access` as per-viewer `denied_roots` (a broader share
never reopens a nested restricted one; the deepest wins) and `start_roots`, and
consumed by every door: start, file RPCs, transcript reads, session lists,
mirrors/open, the board, and live subscriptions (re-validated on
`RefreshWorkspaceState`). Inside a restricted share the sessions of everyone
listed, the device owner's included, are visible, and session ownership never
overrides the ACL. The key adds nobody to a workspace, and service sign-in
mints a session only for plain members (anyone else falls back to the normal
sign-in page). The same key (`uiOrigins`) can also mint a 12-hour **UI pass**
(`POST /api/service/ui-tokens`, `auth_sessions.ui_scope='service-ui'`) that the
integration's page uses for a direct `/ui` WebSocket: it is accepted on `/ui`
only (HTTP treats it as no session), from the key's own `Origin` only, and the
connection it opens carries a `UiScope` (`UiAccess::ui_scope`) that narrows
every answer — `WorkspaceStore::scoped_machine_access` grants only the
restricted shares under the key's prefix the person is listed on (no
workspace-owner/device-owner exemption), `on_ui_msg` and `route_rpc_request`
admit a short list of frames and RPC methods, and the pass is re-derived inside
its fence on every `RefreshWorkspaceState`. Platform administrators and the
bootstrap user may hold a pass too: the connection is derived with no
administrator flag, and the scope wins over administrator status (the sign-in,
which mints a full session, still refuses them). Operations and the config format:
deploy/FLEET.md «Service integrations».

### Community rollout

Opening the product to the example.org community (SSO already admits everyone)
without opening it all at once. Four moving parts, all in `server-rs/`:

1. **`user_access` + the gate** ([access.rs](server-rs/src/access.rs),
   [access_api.rs](server-rs/src/access_api.rs)). Every user has a row
   `waitlist → active ⇄ suspended`, plan `employee | community`. New SSO users
   land on the waitlist (`CC_REMOTE_ACCESS_DEFAULT`); everyone who existed
   before is backfilled `active/employee` once (`schema_meta.access_backfill`);
   the bootstrap owner and platform admins are always active. Refusal lives in
   **one place per transport**: `require_active` for HTTP (403
   `access_not_active` + the state) and `UiAccess::is_active` in the hub loop
   for `/ui` frames — before activation the snapshot is **empty** and only
   `hello`, `ping`, `pause`/`resume`, `subscribe`/`unsubscribe`, push
   registration and `memory_*` pass (`INACTIVE_ALLOWED`). `viewer.access`
   rides in `/api/me`, the `/ui` handshake and every `RefreshWorkspaceState`,
   so an open tab flips off the waiting screen without a reload. Admin surface:
   `/w/team/access` → `GET/POST /api/admin/access*` (`grant` one address —
   activating it now, or remembering it until that person's first SSO login —
   plus `revoke`, activate by id, suspend, reactivate, verify-seat,
   retry-seat).
2. **Gateway seats** ([llmgw.rs](server-rs/src/llmgw.rs)) — the Bifrost
   governance client, now an **ops path for seats that already exist**
   (employees, members activated before 22.09.2026, hand-made ones): since
   `168fc5a` activation of a community member does NOT mint a seat — a new
   member brings their own Codex or Claude login, and the agent reports what
   each machine's runtime is (`runtimes` on `register` / `runtime_status`:
   found, logged in as whom, own login or gateway) so the UI can say «Codex ·
   Plus · ilya@…» or «Codex не найден» rather than nothing. For a seat,
   `ensure_seat` still does the work:
   clone `CC_REMOTE_LLM_COMMUNITY_TEMPLATE_KEY` into `hegai:<email>` with
   `key_ids` (never `keys`), repair or reactivate in place, verify with
   `/v1/models`. **A seat is never recreated** — a new secret would break the
   `config.toml` already installed in the member's sandbox. Retries with
   backoff, a minute reconciler, `seat_status` on the row, no secret ever on
   the hub or in a log.
3. **`provision_jobs` + the dial-out provisioner**
   ([provisioning.rs](server-rs/src/provisioning.rs),
   [provisioning_api.rs](server-rs/src/provisioning_api.rs),
   [deploy/sandbox/provisioner.mjs](deploy/sandbox/provisioner.mjs)). The daemon
   on the sandbox host follows rule 2 — it only dials out:
   `POST /api/provisioning/jobs/claim` (an atomic `UPDATE … RETURNING`), then
   heartbeat, then result. `sandbox_create` no longer waits for a seat (there
   is none for a new member; the payload carries a key only when one exists);
   the **enrollment code is minted at claim time** so its 15-minute window
   starts when the daemon holds
   it and a retry gets a fresh one. The sandbox agent then registers exactly
   like any enrolled device (`enrollments.purpose='sandbox'` →
   `devices.kind='sandbox'`, exempt from the personal device cap) and is
   **owned by the member**. The daemon authenticates with
   `CC_REMOTE_PROVISIONER_TOKEN`, a **separate credential class** from the
   fleet token: the hub refuses to enable the routes if the two are equal.
4. **Project visibility `team | everyone`** on `project_shares`. `team` (the
   default, the employee model) keeps the device owner's own sessions under a
   control-shared root private; `everyone` shows them — the shape of a
   community team working on one sandbox. `machine_access.open_roots` /
   `session_visible` apply it per cwd.

Cross-cutting: a `kind: sandbox` machine is **not** pinned to Codex any more
(24.09.2026): its owner logs into Claude or Codex from «Начало» like on any
machine and the picker follows what is logged in; only a member driving someone
else's machine is pinned (see «Data flow»). A sandbox agent still carries
`CC_REMOTE_DEFAULT_SOURCE=codex`, so a `new_session` that names no source starts
on Codex; self-serve teams (`workspaces.self_serve`, a `slug`)
hide the manager machinery; caps come from env (`CC_REMOTE_ORG_CAP_PER_USER`,
`CC_REMOTE_ORG_MEMBER_CAP`, `CC_REMOTE_DEVICE_CAP_*`). Covered by `cargo test`
in those modules and by `access-smoke`, `team-smoke`, `projects-smoke`,
`files-smoke` in
`server/src/cli/`.

## The surfaces, as they are

### `web/` — the shell
React + Vite SPA. A **top bar spanning the window**
(`shell/TopBar.tsx`) above a **side panel** (`shell/SidePanel.tsx`) that carries
search, «Новый чат» and the session list. The destinations
(`DESTINATIONS` in `shell/navModel.ts`: Сессии — the list itself —, Доска,
Отчёты, Проекты, Файлы, Команда) and Настройки are reached from the account
popover in the bar, and from the drawer on a phone. Collapsed the panel is
simply GONE — there is no icon rail; its toggle, the two history arrows
(`shell/WindowChrome.tsx`), notifications and the account all live in the bar,
which renders on every screen. The bar is above the panel, not beside it, so
the toggle does not move when the panel does. `usePersistentSidebar` (`cc-sidebar-collapsed`,
`cc-sidebar-width`) owns the state.
In the **desktop shell** that bar IS the window's title bar. macOS has no
title strip at all (`TitleBarStyle::Overlay`, since 0.1.22 — like Claude's
app): the system's traffic lights float over the bar's left end, the bar pads
itself by `--mac-lights` to clear them, and the page drags and zooms the
window over a two-command bridge (`capabilities/window-drag-mac.json`,
`installMacChrome`). Windows has no frame either (`decorations(false)`) and
the page draws minimise/maximise/close itself over a bridge the shell injects
— five commands (drag, minimise, toggle-maximise, close and an is-maximised
read) granted to the hub's origin by
`windows/src-tauri/capabilities/window-chrome.json`, and to nothing else. The
same bar carries a menu bar there, «Файл · Правка · Вид · Перейти · Справка»
(`shell/MenuBar.tsx`, Windows shell 0.1.27+): almost every row is the page's
own doing, and the two that are not — quit and the update row — go over three
more commands (`capabilities/app-menu.json`, `src-tauri/src/appmenu.rs`), the
ones that change the process confirmed in a dialog the shell draws. **The bar
renders on every screen**, not only inside Сессии — that is the point of folding the old permanent rail
and the Сессии-only context column into one container. There is no Главная:
`/` and the brand mark both land on the session list.
**There are no lenses.** Список, Flow, Доска and Таблица were four readings of
the list the panel now shows permanently; `?view=…` parses to the list so old
links still open. **«Доска» is back (26.09.2026) as a destination with its own
data, not a lens:** `/w/board` reads `GET /api/board` — TASK cards the hub box
assembles from session replicas once an hour (`deploy/board-assemble.py` →
`board_cards` / `board_card_sessions` / `board_events`, DDL in
`server-rs/src/board.rs`), one card per thing a person wanted done, whether it
took three sessions or a third of one. Columns are the kanban stages; a hand
edit is `POST /api/board/cards/{id}` (sets `manual_override`, audited as
`board.card`). Visibility mirrors `machine_access`: a platform admin sees the
fleet, everyone else their own cards, cards on their devices, and cards whose
sessions ran inside a project shared into their workspace.
**«Отчёты» (04.10.2026)** is a destination of the same kind: `/w/reports` lists
HTML pages published to the hub (`server-rs/src/reports.rs`, table `reports`,
HTML in the row, ≤100 MB each, no cap on count, total size or write rate,
`ON DELETE CASCADE` with the user; the caller is checked before the body
is read).
`GET/POST /api/reports`, `GET/PUT/DELETE /api/reports/{id}`,
`GET /api/reports/{id}/content`. Visible to the author and platform admins only
(anyone else gets 404); only the author edits. Writers are a same-origin
signed-in user or a fleet key (`fleet_caller`, sandboxes refused, never admin) —
the latter is `hegai-fleet report publish`. A top-level visit to `/content`
redirects to `/w/reports/<id>`, so a report is only ever shown framed. `/content` is served under a CSP `sandbox`
without `allow-same-origin` or popup escape, `connect-src 'none'`, so a
report's scripts run in an opaque origin and cannot use the viewer's session. The **split** is a DIVISION OF THE SCREEN (24.09.2026): 2–4
panes, each ANY screen but another split — a session, Файлы, Проекты,
Команда, Настройки, the composer. One pane has focus (the last one pressed,
its head tinted `--here`), and everything chosen outside the panes — a session
row, a destination, «Новый чат» — opens IN it: `navigate` routes it there
(`intoPane` in `web/src/router.ts`; `whole: true` is for edits to the split
itself). A session already in some pane only takes focus — never a second pane
of it. The window holds ONE /ui socket however many panes it shows (since
24.09.2026): a session pane is a session VIEW on the shell's socket
(`useSessionChannel(central.link)`, `web/src/sessionChannel.ts`), and the hub
echoes each view's `ref` onto its replies (`reply_ref`) so a refusal reaches
the composer that sent it; the rest render through App's `renderPage`. What a
session and the fleet looked like is drawn from this device's cache first
(`web/src/localCache.ts`, IndexedDB, display-only). A pane's title RENAMES its session;
the way out to one screen is closing panes (a split of one dissolves). Built
by right-click a row → «Добавить в колонку» (`shell/useSessionMenu.ts`, drawn
by `components/ContextMenu.tsx`). Address `/w/sessions/columns?s=…` — a
session pane is still `m:s`, any other pane its own path percent-encoded;
capped at `COL_MAX = 4`; below 861px a `columns` link lands on the focused
pane's screen. «Наборы» — saved splits — are gone with the picker that made
them necessary.
The Team screens are tabs — five of them, the last («Доступ»,
`/w/team/access`) shown only to a platform admin — and **Настройки** is a
tabbed screen too (`SETTINGS_TABS` in `shell/navModel.ts`: Аккаунт, Железо,
Память, Профиль, Вид, Браузер — only for people the hub has a cloud browser
for — and Начало), reached from the account button in the TOP BAR (it replaced the gear on 23.09.2026 — one
account control, and its popover leads to the full screen); `/w/hardware`,
`/w/memory` and `/w/profile` still open their tab and correct the address.
**History arrows.** The bar carries back and forward beside the panel toggle
(`NavArrows` in `shell/WindowChrome.tsx`, over `canGoBack`/`goBack`/`goForward`
in `web/src/router.ts`), disabled rather than hidden at either end so the
controls next to them do not move; the desktop shell adds a reload button.
The brand mark lives in the panel header (a link to a new chat), not in the bar.
On a phone it is ONE page and ONE drawer: `/w/sessions` is the composer (the
panel is not mounted at all below 861px), the ☰ in the top bar and a swipe
right open the drawer, and the drawer carries the session list, every
destination and «Новый чат». No bottom tab bar, no second session list. Live
session view plus a read-only **Mirror** whose composer force-takes over on
send. The session workspace stays CHAT-ONLY (the Files/Git/Terminal tabs and
Fork are gone and are not coming back); files live on their own destination
«Файлы» (`components/files/`), keyed by machine rather than by session.
`web/src` is `shell/` (side panel, top bar and window chrome, the desktop menu
bar, session drawer/pane/workspace, modal host, nav model, swipe hooks),
`components/`, `panels/`, `render/`, `lite/` (the light shell, below), plus
`lib.ts` helpers and `router.ts`. Icons are Phosphor **regular** via the shim in `web/src/icons.ts`.
**Routing lives under `/w/`** — the hub owns `/agent`, `/ui`, `/api/*` and
`/install/*` as real routes, so a GET on those never reaches the SPA; the
prefix keeps every browser route out of the hub's namespace.

### `web/lite` — the light shell (remote.example.com)
A second way into the SAME hub, account, machines and sessions, behind one
question — «Что сделать?» (06.10.2026). It is a second **entry** into the `web`
workspace, not a second application and not a new package: `web/vite.lite.config.ts`
builds `web/lite/index.html` → `web/lite/dist`, and everything it runs lives in
`web/src/lite/` beside the code it imports. `npm run build --workspace web`
writes both bundles.

What it shares, unchanged: `useCentral` and `sessionChannel` (the one `/ui`
socket), `central-reducers`, `localCache`, `teamApi`, `router.ts` — so an
address means the same thing on both hosts and «Полная версия» is a change of
origin and nothing else (`lite/origin.ts`, `VITE_FULL_ORIGIN`) — and the
transcript: a task is `panels/Chat.tsx` with `variant="lite"`, which drops the
«/» menu, the model/effort picker and the context ring and keeps one switch,
«План». Questions and approvals are the full client's `ModalHost`, raised only
while their task is on screen; elsewhere a pending question is a row.
Known limit: «План» exists at the start of a task and while its run is
attached, not on a DETACHED task — `open` carries a model and an effort but no
permission mode, so continuing an old task runs on the machine's default until
the switch appears with the run. Closing that is a wire change (`open.permissionMode`),
deliberately not made here.

What is its own (`web/src/lite/`): the home — a prompt box and the person's
tasks in three piles, «Ждут вас · В работе · Готово», derived from frames the
socket already carries (`tasks.ts`, the rule iOS's home uses; the «new result»
dot is this browser's, `lite-seen:<userId>`) — and the choices the full client
asks for, made here: the machine and runtime (`pick.ts`; `runtimeUsable` in
`components/runtimeChips.ts` is shared with the start screen), no model, effort
or mode sent at all (the machine's defaults run), and a project's folder named
from the first message (`slug.ts` → `projects.create`). A project picked before
is remembered; «Новый проект» is the default only for someone with none.

The boundary runs one way and is tested (`web/test/shell-invariants.test.ts`):
`src/lite` never imports the full shell (`App`, side panel, top bar, split,
start screen), and nothing outside imports `src/lite`.

**Serving.** The hub picks the bundle by `Host` (`StaticSites` in
`server-rs/src/main.rs`): names in `CC_REMOTE_LITE_HOSTS` get `WEB_LITE_DIST`,
every other name gets `WEB_DIST`. A listed name with no light build answers 503,
never the full client — the full client registers a service worker on whatever
origin it loads on, and one registered on the light origin would outlive the
deploy that fixed it. The light shell registers no worker; its `/sw.js` only
retires one. The session cookie is host-only, so the light host signs in on its
own: a Google sign-in begun there returns there (`callback_origin`, the same
list), which needs that name's redirect URI registered with the Google client
(deploy/TZ-remote-hegai-net.md). No wire change:
it says `hello { client: 'web' }` like the full client.

### `ios/` — the iPhone client
the **iPhone client**, one app in an XcodeGen project (`project.yml`
is the source of truth; `CCRemote.xcodeproj` is generated and gitignored):
`CCRemote` (iPhone, TestFlight), portrait-only. `ios/CCRemoteKit/` is a local
SwiftPM package with the hub client, wire protocol and disk caches — **no
SwiftUI/UIKit/AppKit in it**; platform differences arrive by injection.
The three bundled typefaces live in `CCRemote/Resources/Fonts/` and are
regenerated by `ios/scripts/fetch-fonts.sh`; `ios/scripts/shoot.sh` is the
screenshot harness every UI change is reviewed on.
**There is no native Mac target any more.** `CCRemoteMac` was removed from
`project.yml` on 21.09.2026 — the Mac app is now the Tauri shell in
`windows/` (see `deploy/FLEET.md`). `ios/CCRemoteMac/` still sits on disk as
the last trace of it; deleting those files is a separate, human decision.
Do not resurrect the target to "share a view": its `sources:` listed files
by name, which is precisely what made every deletion in `ios/` abort
XcodeGen for the iPhone app too.
When no Mac is reachable — CI's iOS gate lives on a macOS runner — the WIRE
half is still checkable without one: `ios/scripts/check-protocol-linux.sh`
compiles `CCRemoteKit/.../Protocol/*.swift` (Foundation-only by rule) with
its golden-frame tests on a Linux Swift toolchain. A floor, not a substitute:
it says nothing about `Net/`, `Persistence/` or any view.

### `android/` — the Android client

Kotlin/Compose with pure JVM `core/` and Android `app/` adapters. One hub socket,
read-only browsing/mirror, explicit writer creation/takeover, structured chat,
images/dictation, run controls, projects/team/settings and an account-scoped inbox.
Encrypted AtomicFile caches bind account/workspace through AES-GCM AAD. A durable
checkpoint precedes sending; reconnect never automatically retries mutations.

Browser Custom Tabs starts `/api/auth/sso/start?android=1` with S256 challenge and
client state. The exported `hegai-code://auth` URI carries only a one-use code;
`POST /api/auth/android/exchange` requires its private verifier for a 90-day session.
`android_auth.rs` bounds handshakes globally and per trusted client address.

Android push uses optional FCM HTTPv1 alongside APNs. Shared `register_push`
accepts `platform: android`; registrations remain user-bound. Data-only payloads
carry session/workspace identifiers and a short title, never transcript/tool input.
Receiver actions require an unlocked phone and reauthenticate against the live
request. Token rotation retries through WorkManager. Firebase setup and release
procedure: `deploy/ANDROID.md`; actual readiness: `android/PARITY.md`.

### `tgbot/` — the Telegram client
**Telegram client**, a third `/ui` consumer beside `web/` and
`ios/`. Changes no protocol: it speaks the same `hello`/`open`/`new_session`/
`input`/`tool_decision` the browser does. A chat shows only the agent's
SPEECH (`stream.event.kind === 'assistant'`); tool calls and system lines are
machinery behind a setting. Access is a Telegram-id whitelist and every
allowed account shares ONE hub identity — opening it to the community needs a
bot credential class the hub does not have yet (see `tgbot/README.md`).
Deployed on the hub box as `cc-remote-tgbot`, running from the checkout.

### `windows/` — the desktop shell (Windows and macOS)
the **desktop shell**, a Tauri 2 app that renders the hosted SPA
rather than a UI of its own. Named for the platform it was built for; it now
targets **macOS too**, which is the point — the interface ships with every web
deploy and only the Rust around it needs an installer. What that Rust adds is
what a browser cannot: a tray/menu-bar item with the count of sessions waiting
on an answer, native toasts, and (on Windows only) a supervisor for the
machine's agent — macOS has launchd and Linux has systemd, so `mod agent` is
`#[cfg(windows)]`. It has its OWN small socket to the hub
(`src-tauri/src/hub/`) because a hidden webview is frozen, which is exactly
when notifications are wanted; it reads the session cookie out of the
webview's jar to open it. Two policies live here and nowhere else: what
deserves a toast (`hub/notify.rs`) and what a link may do (`decide` /
`popup_outcome` in `main.rs`) — both pure, both tested, and both now shared by
two platforms, which is the argument against a second native client.
`cargo check`/`cargo test` DO run on a Linux host (all but the Windows-only
`agent/` tests) once the GTK/WebKit dev packages are there,
and `cargo xwin check --target x86_64-pc-windows-msvc` proves the Windows half.
**Nothing here ships itself**: CI does not build it and `deploy-hub.sh` does
not touch it, so a fix reaches nobody until an installer is built and
published by hand — runbooks in deploy/FLEET.md
(«Shipping a Windows app update», «Shipping a Mac app update» — the Mac one
is now the only way a Mac app gets built at all). The Windows one also covers
why handing someone the `/dl/` link gives them a file that will not run; the
Mac one is notarized, so there that link is fine.

### `skills/` — session categories and the fleet bundle
the workflow bodies a session CATEGORY invokes, one
`skills/<name>/SKILL.md` each. `skills/` holds only `rambling` now — dictate a
ramble, get a written-up task rather than finished work — and it is the one
category a start screen offers. The rest are `LEGACY_CATEGORIES` in
`shared/src/categories.ts`: still named and chipped wherever an existing
session carries one, never offered, and since 24.09.2026 their skills no longer
ride in the fleet bundle (they are this repository's own dev-process skills in
`.claude/skills/`, present on a machine only where installed). Skills are NOT
loose files on machines any more:
`agent/scripts/gen-skills-bundle.mjs` compiles them into
`agent/src/skills-bundle.ts` (committed, regenerated by
`deploy/build-agent.sh`), the agent writes them to `~/.claude/skills/` on
start and reports what it can run as `machine.skills`. Adding a skill means
the file here **plus** the id↔skill pair in `shared/src/categories.ts`,
`server-rs/src/hub.rs` (`CATEGORY_SKILLS`) and `ios/.../Models.swift` —
`shared/test/categories.test.ts` fails if the four disagree.

## Private machines (end-to-end encrypted sessions)

A machine whose owner sets `"private": true` in `policy.json` sends session
content as AES-256-GCM envelopes (`{e2e:1,kid,n,c}`) under a key that never
leaves the machine and the owner's paired devices; the hub routes, stores and
replays them and cannot read them. Spec, as-built notes and the honest threat
model: [docs/E2EE.md](docs/E2EE.md). The field table is code:
`shared/src/e2e.ts` (one traversal for the agent, the web and the tests); the
agent seals at `sendRaw` and opens at `onMessage` (`agent/src/e2ee.ts`), the web
in `useCentral` (`web/src/e2ee/`), and the hub (`machine_private()` in
`server-rs/src/hub.rs`) forwards the envelopes and builds nothing from content
for such a machine. Smoke: `private-machine-smoke` (deploy/SMOKE-TESTS.md).

## Account privacy and erasure

Native AI consent is versioned per verified account/workspace. New AI actions,
automatic titles/enrichment and queued sends wait for it; acceptance never
autosends a draft. Withdrawal does not terminate remote work. Deletion enters
one durable hub queue (native preview/receipt API plus the legacy web/Android
wrapper), revokes credentials immediately and finalizes after hosted cleanup,
gateway/Apple revocation and account-scoped erasure. Local receipt recovery
survives a lost HTTP response and never clears a newly switched account.

New-session ownership is recorded before dispatch and reconciled through the
agent's durable `session_origin`/`session_origin_ack` journal. Explicit failed
creation is different from an ambiguous timeout. Tombstones prevent transcript
and conversation-archive reimport. Board aggregates require access to every
source; generation checks prevent stale summaries returning after erasure.
Old unscoped cards are quarantined and rebuilt. Technical and operational
limits, including historical database backups: release runbook.
