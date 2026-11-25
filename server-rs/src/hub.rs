//! In-memory routing hub — a port of server/src/hub.ts.
//!
//! A single tokio task owns all state (no locks). Connections talk to it via an
//! mpsc channel of `HubCmd`; the hub routes by sending JSON text frames to each
//! connection's own mpsc sender. Most payloads are forwarded as
//! `serde_json::Value` verbatim — only the few fields used for routing /
//! single-writer locking are inspected, which keeps this compact and resistant
//! to protocol drift with the TypeScript `shared` package.

mod agent_run;
mod attachments;
mod enrich;
mod fleet;
mod fleet_tasks;
mod inventory;
mod retention;
mod watch;
pub(crate) use fleet::{sandbox_sign, FleetError, FleetTarget};
pub(crate) use fleet_tasks::{FleetTaskOp, TaskTag};
mod reads;
mod rpc;
mod tasks;
#[cfg(test)]
mod tests;
mod titles;
mod wire;

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tokio::sync::mpsc::error::TrySendError;
use tokio::sync::mpsc::{unbounded_channel, Sender, UnboundedReceiver, UnboundedSender};
use uuid::Uuid;

use crate::replica::{state_json, ReplicaStore};
use crate::roadmap::RoadmapConfig;
use crate::workspace::{
    normalize_root, session_visible, MemoryRecord, UiAccess, UiScope, WorkspaceStore,
};
use attachments::*;
use inventory::*;
use wire::{message, ValueFields};

pub type ConnId = u64;
type Tx = Sender<String>;

/// Per-connection outbound queue depth. A peer whose link stalls fills this and
/// is then dropped (clean reconnect + resync) instead of growing the queue
/// without bound. Generous so legitimate bursts (chunked mirror reloads, rapid
/// token streaming) never trip it.
pub const OUT_CHANNEL_CAP: usize = 16_384;

/// Per-UI-connection outbound BYTE budget, next to the frame count above. A
/// slow link used to hold up to 16 384 frames of whatever size — superseded
/// snapshots and activity boards included — and replay them all, stale first,
/// when it recovered. Past this many bytes queued the peer is dropped by the
/// same path as a full frame queue (clean reconnect + fresh snapshot). A frame
/// that arrives at an EMPTY queue is always accepted, however large, and no
/// single frame is charged more than an eighth of the budget (`OutGate::charge`),
/// so one legitimately big answer can never get a peer dropped on its own. Agents are
/// exempt: their frames carry attachments and chunked replication.
pub const OUT_BYTES_CAP: usize = 8 * 1024 * 1024;
/// The REAL bytes a UI socket may have queued, whatever `charge` counted. The
/// per-frame charge ceiling exists so one big frame cannot get the small ones
/// behind it refused; without this second, honest ceiling eight 32 MiB frames
/// would be "8 MiB" and sit in memory as 256 MiB (review 24.10.2026).
pub const OUT_REAL_BYTES_CAP: usize = 64 * 1024 * 1024;

/// State a socket's write loop (`ws_api.rs`) and the hub command loop share
/// without a message round trip: how many bytes the hub has queued for the
/// peer, and whether the peer asked for silence (`pause`) — which the write
/// loop uses to ping a backgrounded socket far less often.
#[derive(Default)]
pub struct OutGate {
    queued_bytes: AtomicUsize,
    /// Uncapped size of the same backlog (`OUT_REAL_BYTES_CAP`).
    queued_real: AtomicUsize,
    paused: AtomicBool,
    /// The hub gave up on this peer as too slow: hang up now instead of
    /// draining a stale backlog first.
    dropped: AtomicBool,
}

impl OutGate {
    /// What one frame is charged against the budget: at most an eighth of it,
    /// whatever its size, on BOTH sides (`reserve` / `drained`). One huge frame
    /// (a whole-fleet snapshot, a history page with images) must not make the
    /// small frames queued behind it — the session reads that follow a
    /// snapshot — look like an overrun and get a healthy peer dropped.
    fn charge(bytes: usize) -> usize {
        bytes.min(OUT_BYTES_CAP / 8)
    }

    /// The write loop took a frame off the queue.
    pub fn drained(&self, bytes: usize) {
        saturating_sub(&self.queued_real, bytes);
        saturating_sub(&self.queued_bytes, Self::charge(bytes));
    }

    /// The peer is backgrounded (`pause` without a `resume`).
    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::Relaxed)
    }

    /// The hub gave up on this peer as too slow.
    pub fn mark_dropped(&self) {
        self.dropped.store(true, Ordering::Relaxed);
    }

    /// The hub dropped this peer as slow: the backlog is stale, do not send it.
    pub fn is_dropped(&self) -> bool {
        self.dropped.load(Ordering::Relaxed)
    }

    /// Reserve `bytes` of the budget. `false` = over budget; nothing reserved.
    fn reserve(&self, bytes: usize) -> bool {
        let real = self.queued_real.load(Ordering::Relaxed);
        let charged = Self::charge(bytes);
        let queued = self.queued_bytes.load(Ordering::Relaxed);
        if queued > 0 && (queued + charged > OUT_BYTES_CAP || real + bytes > OUT_REAL_BYTES_CAP) {
            return false;
        }
        self.queued_bytes.fetch_add(charged, Ordering::Relaxed);
        self.queued_real.fetch_add(bytes, Ordering::Relaxed);
        true
    }
}

/// `counter -= n`, floored at zero. A CAS loop rather than `fetch_update`:
/// that is deprecated in favour of `try_update` on the CI toolchain (1.99),
/// which older toolchains do not have — this compiles on both.
fn saturating_sub(counter: &AtomicUsize, n: usize) {
    let mut cur = counter.load(Ordering::Relaxed);
    loop {
        match counter.compare_exchange_weak(
            cur,
            cur.saturating_sub(n),
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => return,
            Err(actual) => cur = actual,
        }
    }
}

/// How often the hub's coalescing tick fires (`HubCmd::CoalesceTick`). It
/// carries activity heartbeats and repeated snapshot requests: both may wait
/// up to this long, nothing urgent rides on it.
const COALESCE_WINDOW_MS: i64 = 500;

pub use watch::{LiveOp, PushActionReq, TokenUse};

pub enum HubCmd {
    Connected {
        conn: ConnId,
        tx: Tx,
        is_agent: bool,
        user_id: String,
        workspace_id: Option<String>,
        viewer: Option<Value>,
        authorized_machine_id: Option<String>,
        /// The sign-in session (token hash) a `/ui` socket was opened with.
        auth_session: Option<String>,
        /// Set when the socket was opened with a service UI pass: the fence
        /// every right of this connection is judged inside (`UiScope`).
        ui_scope: Option<UiScope>,
        /// Shared with the socket's write loop: queued bytes and pause state.
        gate: Arc<OutGate>,
    },
    AgentMsg {
        conn: ConnId,
        text: String,
    },
    UiMsg {
        conn: ConnId,
        text: String,
    },
    Disconnected {
        conn: ConnId,
    },
    /// Carry the snapshot changes that were too small to interrupt anyone for —
    /// see `snapshot_pending`.
    FlushSnapshot,
    /// See if a session's title is due (`hub/titles.rs`).
    TitleTick,
    /// A title pass came back from the gateway. `Err` is a failed call, not a
    /// verdict; `Ok(None)` is the model finding nothing worth naming yet.
    TitleGenerated {
        machine_id: String,
        source: String,
        session_id: String,
        basis_count: i64,
        outcome: Result<Option<String>, String>,
    },
    /// The 500 ms coalescing tick: pays what `broadcast_snapshot` and the
    /// activity heartbeat deferred. A no-op when nothing is owed.
    CoalesceTick,
    /// Fired after the grace window: drop an agent only if it never reconnected.
    RemoveStaleAgent {
        conn: ConnId,
        machine_id: String,
    },
    /// Fired after the run grace window: release the runs of a dropped agent
    /// socket that were never re-adopted by a reconnecting agent.
    ReleaseOrphanedRuns {
        conn: ConnId,
        machine_id: String,
    },
    /// An enrichment task finished — store its annotation. State mutates only
    /// in the command loop; the network task posts this instead of touching
    /// the cache itself.
    EnrichCompleted {
        conn: ConnId,
        machine_id: String,
        session_id: String,
        key: String,
        frame: Value,
    },
    /// Start a session on the machine owner's behalf, from outside the socket
    /// world — the backend-spec intake, where an employee files work the owner
    /// will approve later. Unlike every other command here this one answers, so
    /// the HTTP caller can hand a link back to whoever filed the spec.
    SpawnForOwner {
        machine_id: String,
        cwd: String,
        message: String,
        category: Option<String>,
        permission_mode: Option<String>,
        owner_user_id: String,
        owner_name: Option<String>,
        reply: tokio::sync::oneshot::Sender<Result<String, String>>,
    },
    /// Fleet API (`fleet_api.rs`, `hub/fleet.rs`): act for `owner_user_id` on
    /// machines they own, with nobody attached. Authentication and the sandbox
    /// refusal happen in the HTTP layer; ownership of every machine touched is
    /// re-checked here.
    FleetSpawn {
        owner_user_id: String,
        machine: String,
        cwd: String,
        message: String,
        /// `model` / `effort` / `source`, validated like a `new_session` frame.
        settings: Value,
        /// `--task`: the registry task the new session works for.
        task: Option<TaskTag>,
        reply: tokio::sync::oneshot::Sender<Result<Value, FleetError>>,
    },
    FleetSend {
        owner_user_id: String,
        target: FleetTarget,
        message: String,
        settings: Value,
        task: Option<TaskTag>,
        reply: tokio::sync::oneshot::Sender<Result<Value, FleetError>>,
    },
    /// The task registry (`hub/fleet_tasks.rs`). Any fleet key may use it:
    /// `fleet_api::fleet_caller` has already refused the sandboxes.
    FleetTask {
        owner_user_id: String,
        op: FleetTaskOp,
        reply: tokio::sync::oneshot::Sender<Result<Value, FleetError>>,
    },
    FleetStatus {
        owner_user_id: String,
        target: FleetTarget,
        reply: tokio::sync::oneshot::Sender<Result<Value, FleetError>>,
    },
    FleetMachines {
        owner_user_id: String,
        reply: tokio::sync::oneshot::Sender<Value>,
    },
    /// Machine ids whose agent is connected right now (the external edition's
    /// agent-update page, `agent_release.rs`).
    OnlineAgents {
        reply: tokio::sync::oneshot::Sender<HashSet<String>>,
    },
    /// The service API (`service_api.rs`) asks the machine's agent to make a
    /// folder, as the device owner would. The answer is `None` when the agent
    /// is offline, else the receiver of its answer (dropped sender = no answer).
    ServiceMkdir {
        machine_id: String,
        cwd: String,
        path: String,
        reply: tokio::sync::oneshot::Sender<Option<tokio::sync::oneshot::Receiver<bool>>>,
    },
    /// APNs rejected a device token. For `Unregistered`, keep a token that was
    /// registered again after Apple's invalidation timestamp.
    PrunePushToken {
        token: String,
        invalidated_at_ms: Option<i64>,
    },
    /// How a Live Activity push went, per token (`notify::send_live`).
    LiveSent {
        user_id: String,
        kind: crate::live_activity::LiveKind,
        results: Vec<(String, crate::live_activity::LiveOutcome)>,
    },
    /// Answer a run from a push action or the watch app (`POST
    /// /api/push-action`, docs/WATCH.md §3). The HTTP layer verified the
    /// credential; the access gate runs here, in the hub loop.
    PushAction {
        req: Box<PushActionReq>,
        reply: tokio::sync::oneshot::Sender<Result<(), crate::push_action::ActionError>>,
    },
    /// The watch app's list of the caller's runs (`GET /api/watch/inbox`).
    WatchInbox {
        user_id: String,
        reply: tokio::sync::oneshot::Sender<Value>,
    },
    /// The watch reads the tail of a session (`GET /api/watch/history`).
    WatchHistory {
        user_id: String,
        machine_id: String,
        session_id: String,
        source: Option<String>,
        limit: usize,
        reply: tokio::sync::oneshot::Sender<Result<Value, (u16, &'static str)>>,
    },
    /// The watch answers a session that has no live run (docs/WATCH.md §4c).
    WatchSessionReply {
        user_id: String,
        machine_id: String,
        session_id: String,
        source: Option<String>,
        text: Option<String>,
        reply: tokio::sync::oneshot::Sender<Result<(), crate::push_action::ActionError>>,
    },
    /// An admin's phone registers or drops a Live Activity token.
    LiveActivity {
        user_id: String,
        op: LiveOp,
        reply: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
    /// An admin's finished-turn push got (or failed to get) its LLM summary.
    /// Sent only if the run is still in the idle transition it was taken in.
    PushSummary {
        event: Box<crate::notify::PushEvent>,
        /// `ActiveRun::since` when the push was taken.
        since: i64,
        summary: Option<String>,
        replies: Vec<crate::push_payload::Reply>,
    },
    RequestAccountDeletion {
        user_id: String,
        transfers: Value,
        receipt: String,
        reply: tokio::sync::oneshot::Sender<Result<String, String>>,
    },
    EraseAccount {
        user_id: String,
        reply: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
    RefreshWorkspaceState,
    /// The Telegram «Это был не я» undo: drop what the intruder registered for
    /// notifications since `since_ms` — push device tokens (in memory only) and
    /// the Live Activity tokens the store just deleted.
    UndoSignIn {
        user_id: String,
        since_ms: i64,
        live_tokens: Vec<String>,
    },
    /// Close the connections whose service UI pass has ended (expired, evicted,
    /// revoked, its person gone). Sent on a short tick and whenever a pass is
    /// minted (the per-person cap evicts the oldest then).
    SweepUiPasses,
    /// End the support grants whose time is up (a short tick; free while no
    /// grant is open).
    SweepSupport,
    /// Periodic sweep: close runs that have been idle with nobody watching.
    ReapIdleRuns,
    /// A history read forwarded to an agent has waited its deadline. If it is
    /// still unanswered and the replica holds the session, the replica answers
    /// (`history_deadline` in hub/rpc.rs) — a slightly stale transcript beats
    /// a pane that stays blank until the browser's 30 s timeout.
    HistoryDeadline {
        request_id: String,
    },
}

/// Keep a dropped agent "online" this long before removing it, so a flaky link
/// (e.g. a multi-hop tunnel that resets every ~second) doesn't make the machine
/// flicker in/out of the UI. Presentation only — see RUN_GRACE_SECS for the
/// window that actually governs writers.
const AGENT_GRACE_SECS: u64 = 15;

/// How much of the current turn a late subscriber is shown. A turn's stream is
/// small (text chunks and tool lines); these bounds exist so a runaway loop
/// cannot grow the buffer without limit, not to ration the reader.
const REPLAY_MAX_FRAMES: usize = 400;
const REPLAY_MAX_BYTES: usize = 256 * 1024;

/// Stream codes that are a latest-value reading, never a transcript line: the
/// replay window keeps only the newest of each (`remember_stream_frame`).
/// Not `session_state`, although web's `HEARTBEAT_CODES` lists it: web reads
/// its `running` as an event (busy, turn phase working) that a later
/// `requires_action` does not undo, and it changes rarely enough not to
/// crowd the window.
const REPLAY_HEARTBEAT_CODES: [&str; 2] = ["requesting", "turn_usage"];

fn is_stream_kind(frame: &Value, kind: &str) -> bool {
    frame["type"] == message::STREAM && frame["event"]["kind"] == kind
}

fn heartbeat_code(frame: &Value) -> Option<&'static str> {
    if !is_stream_kind(frame, "status") {
        return None;
    }
    let code = frame["event"]["code"].as_str()?;
    REPLAY_HEARTBEAT_CODES.into_iter().find(|c| *c == code)
}

/// Evict from the front until the window is inside both bounds.
fn trim_replay(run: &mut ActiveRun) {
    while run.replay.len() > REPLAY_MAX_FRAMES || run.replay_bytes > REPLAY_MAX_BYTES {
        let Some(dropped) = run.replay.pop_front() else {
            break;
        };
        run.replay_bytes = run.replay_bytes.saturating_sub(json_len(&dropped));
    }
}

/// An idle run with nobody watching is scaffolding, not work — and it holds its
/// session's single-writer lock, so reopening that session answers "Session
/// already has an active run" until a human presses Close run. Runs used to sit
/// like that for days (observed: four days, three of them mislabelled "New
/// session"). Close them once they have been idle AND unwatched this long;
/// picking the session up again costs one message.
const IDLE_RUN_TTL_MS: i64 = 6 * 60 * 60 * 1000;
/// How long after start the Live Activity waits before its first evaluation.
const LIVE_START_GRACE_MS: i64 = 60_000;
/// A session's failure is pushed once in this long — see `error_push_due`.
/// Same window as the desktop tray's `ERROR_REPEAT`.
const ERROR_PUSH_REPEAT_MS: i64 = 15 * 60 * 1000;

/// How often the sweep above runs. Coarse on purpose: the TTL is hours.
const REAP_INTERVAL_SECS: u64 = 10 * 60;

/// How often connections on a service UI pass are checked against their pass.
const UI_PASS_SWEEP_SECS: u64 = 30;
/// How often the end of a support grant is looked for.
const SUPPORT_SWEEP_SECS: u64 = 5;

/// How long a run we hold may be missing from its agent's `run_inventory`
/// before we accept that nothing is driving it.
///
/// This is a START RACE guard and nothing else. The agent answers on a 30s
/// heartbeat and reports only LAUNCHED runs, so a run we just opened is
/// legitimately absent while the agent does its pre-launch liveness and
/// transcript-size checks — checks that were observed taking minutes on a box
/// whose cgroup was in memory reclaim, which is the very incident this guards.
/// Four heartbeats is slack enough to never race a healthy slow start, and it
/// turns "stuck until someone redeploys the hub" (four hours, 21.09.2026) into
/// two minutes.
///
/// It is deliberately NOT a silence threshold. A run that goes quiet for an
/// hour inside one long tool call is perfectly alive, and judging runs by their
/// own quietness would kill real work — the agent's answer is the only evidence
/// that counts here.
const RUN_RECONCILE_GRACE_MS: i64 = 120_000;

/// How long a session stays guarded after its agent reported the run over with
/// `closing: true` and no `writer_released` has followed. The runtime process
/// behind a Codex run outlives the close by up to the agent's kill grace (5 s
/// before SIGKILL, plus the second it allows for the kill to land) and leaves no
/// pid file, so the terminal `run_status` alone does not say nothing can still
/// be writing the transcript. It also covers the agent that exits before the
/// process does (the update path) or whose socket is down when it goes: no
/// `writer_released` ever arrives, and the session must not stay refused.
/// Mirrors `RUN_CLOSING_MAX_MS` in shared/src/limits.ts
/// (`run_closing_limit_matches_shared` keeps them equal).
const RUN_CLOSING_MAX_MS: i64 = 8_000;

/// Why an `open` is refused while a closing writer's guard is up.
const WRITER_CLOSING_REFUSAL: &str =
    "предыдущий процесс сессии ещё завершается — повторите через несколько секунд";

/// The agent auto-denies an approval it has held for five minutes
/// (`TOOL_APPROVAL_TIMEOUT_MS` in `agent/src/run-manager.ts`) and has no way to
/// tell us. Replaying a request older than that would put a live-looking prompt
/// in front of a returning user whose "Allow" then lands nowhere — the classic
/// "I approved it and nothing happened". Treat anything past the timeout as gone.
const TOOL_APPROVAL_TTL_MS_DEFAULT: i64 = 60 * 60 * 1000;

// Some approvals are deliberately asynchronous: a backend spec filed by an
// employee is approved by the owner whenever they get to it, which is not
// within five minutes. That machine raises its own
// `CC_REMOTE_APPROVAL_TIMEOUT_MS` and declares the value at register.
//
// Asking per machine rather than holding one number here is not fussiness. The
// two ends describe the same deadline and the failure is asymmetric: if the
// agent gives up first we show a card that cannot be answered, and if we forget
// first we drop a prompt the agent is still waiting on. A single hub-wide value
// across a fleet where one machine waits hours and the rest wait five minutes
// is guaranteed to be wrong for one of them.
//
// An agent too old to declare it, or one that has since disconnected, gets the
// default — the deadline it is in fact using.
//
// (Implemented as `Hub::tool_approval_ttl_ms`.)

/// How long a dropped agent's runs keep their single-writer locks before we give
/// up on them. Deliberately much longer than AGENT_GRACE_SECS, and it is a
/// safety bound rather than a UX choice: releasing a run frees its session lock,
/// so this MUST outlast the worst case in which the agent is still writing.
///
/// The agent fences itself within KEEPALIVE_MS * KEEPALIVE_MAX_MISSES +
/// RUN_GRACE_MS = 40s of its last contact with us (`agent/src/client.ts`), and
/// its last contact necessarily predates our seeing the link die — so 60s clears
/// it with margin. The pessimistic case (a half-open link, where the agent never
/// sees a close and only its keepalive can fence it) is what sets the floor.
///
/// Cost of being wrong in the safe direction: a session whose machine really
/// died stays locked for a minute, and the UI offers force takeover, which kills
/// the writer by pid and confirms death before resuming. Cost of being wrong in
/// the other direction is a corrupted transcript.
const RUN_GRACE_SECS: u64 = 60;

#[derive(Clone)]
pub struct HubHandle {
    tx: UnboundedSender<HubCmd>,
    counter: Arc<AtomicU64>,
}

impl HubHandle {
    pub fn next_conn_id(&self) -> ConnId {
        self.counter.fetch_add(1, Ordering::Relaxed)
    }
    pub fn send(&self, cmd: HubCmd) {
        let _ = self.tx.send(cmd);
    }
}

pub fn spawn_hub(
    db_path: &Path,
    workspaces: WorkspaceStore,
    bootstrap_user_id: String,
    roadmap_config: RoadmapConfig,
) -> HubHandle {
    let (tx, rx) = unbounded_channel::<HubCmd>();
    let notify = crate::notify::spawn_notifier(tx.clone(), workspaces.clone());
    let store = ReplicaStore::open(db_path).unwrap_or_else(|e| {
        panic!(
            "failed to initialize session database {}: {e}",
            db_path.display()
        )
    });
    tokio::spawn(run_hub(
        rx,
        tx.clone(),
        notify,
        store,
        workspaces,
        bootstrap_user_id,
        roadmap_config,
    ));
    HubHandle {
        tx,
        counter: Arc::new(AtomicU64::new(1)),
    }
}

async fn run_hub(
    mut rx: UnboundedReceiver<HubCmd>,
    self_tx: UnboundedSender<HubCmd>,
    notify: Option<UnboundedSender<crate::notify::Outbound>>,
    store: ReplicaStore,
    workspaces: WorkspaceStore,
    bootstrap_user_id: String,
    roadmap_config: RoadmapConfig,
) {
    let mut state = Hub::new(
        self_tx.clone(),
        notify,
        store,
        workspaces,
        bootstrap_user_id,
        roadmap_config,
    );
    // The hub is a single command loop, so the sweep arrives as a command like
    // everything else rather than touching state from another task.
    let flush_tx = self_tx.clone();
    let title_tx = self_tx.clone();
    let self_tx_for_coalesce = self_tx.clone();
    // Service UI passes end on the clock (12 h, never extended): a socket that
    // only listens is judged here, within half a minute of its pass going.
    let pass_tx = self_tx.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(UI_PASS_SWEEP_SECS));
        tick.tick().await;
        loop {
            tick.tick().await;
            if pass_tx.send(HubCmd::SweepUiPasses).is_err() {
                return;
            }
        }
    });
    // A support grant ends on the clock too: a socket that only listens sends no
    // frame to be judged on, so its end is noticed here, within seconds.
    let support_tx = self_tx.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(SUPPORT_SWEEP_SECS));
        tick.tick().await;
        loop {
            tick.tick().await;
            if support_tx.send(HubCmd::SweepSupport).is_err() {
                return;
            }
        }
    });
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(REAP_INTERVAL_SECS));
        tick.tick().await; // the first tick fires immediately — skip it
        loop {
            tick.tick().await;
            if self_tx.send(HubCmd::ReapIdleRuns).is_err() {
                return;
            }
        }
    });
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(titles::TICK_SECS));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await;
        loop {
            tick.tick().await;
            if title_tx.send(HubCmd::TitleTick).is_err() {
                return;
            }
        }
    });
    // Its own tick, two orders of magnitude faster than the reap: this one only
    // carries deferred snapshot changes, and a snapshot that waits ten minutes
    // is a stale session list rather than a saved byte.
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(SNAPSHOT_FLUSH_SECS));
        tick.tick().await;
        loop {
            tick.tick().await;
            if flush_tx.send(HubCmd::FlushSnapshot).is_err() {
                return;
            }
        }
    });
    // The coalescing tick (`COALESCE_WINDOW_MS`): pays activity heartbeats and
    // trailing snapshots. Every tick is a no-op command when nothing is owed.
    let coalesce_tx = self_tx_for_coalesce;
    tokio::spawn(async move {
        let mut tick =
            tokio::time::interval(std::time::Duration::from_millis(COALESCE_WINDOW_MS as u64));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        tick.tick().await;
        loop {
            tick.tick().await;
            if coalesce_tx.send(HubCmd::CoalesceTick).is_err() {
                return;
            }
        }
    });
    while let Some(cmd) = rx.recv().await {
        state.handle(cmd);
    }
}

/// What to call a run whose session does not exist yet. The transcript it will
/// be named after has not been written, so borrow the first line of the task —
/// "New session" told the reader nothing, and it used to stick for the life of
/// the run because nothing ever replaced it (`refresh_run_titles` does now).
fn provisional_title(task: Option<&str>) -> String {
    task.and_then(|t| t.lines().find(|l| !l.trim().is_empty()))
        .map(|line| {
            let line = line.trim();
            let short: String = line.chars().take(60).collect();
            if short.chars().count() < line.chars().count() {
                format!("{short}…")
            } else {
                short
            }
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "New session".to_string())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// There is no cap on how many sessions of a machine ride in a snapshot. There
// was one (400, newest first) to keep the opening frame small, and on 28.09.2026
// it turned out to hide nearly everything: on `stage` a cron loop and `/tmp`
// probes filled 356 of the 400 slots, and a project with 136 sessions showed 5.
// The whole fleet uncapped is ~2 MB once per connect; after that the browsers
// get `machine_sessions` deltas, not snapshots. See `ReplicaStore::snapshot_sessions`.

struct AgentConn {
    machine: Value,
    conn: ConnId,
    sessions: Vec<Value>,
    /// Liveness from this agent's last inventory. Survives a reconnect with
    /// `sessions`, so the UI doesn't blink take-over off until the next sync.
    liveness: Liveness,
    last_seen: i64,
    /// This machine's Claude account usage/limits (untyped `UsageInfo`), as last
    /// reported by the agent. `Null` until the first `usage` message arrives.
    usage: Value,
    /// This machine's Codex account limits, as last reported by app-server.
    codex_usage: Value,
    /// This machine's locally-computed builder profile (untyped `BuilderProfile`),
    /// as last reported by the agent. `Null` until the first `builder_profile`.
    profile: Value,
    /// Latest hardware/process telemetry sample (untyped `MachineStats`).
    /// `Null` until the first `machine_stats` message arrives.
    stats: Value,
    /// What the machine's Claude and Codex ARE (untyped `RuntimeStatus`):
    /// found, logged in as whom, own login or a gateway. `Null` until the agent
    /// says — an older agent never does, and that reads as unknown, not broken.
    /// Carried across a reconnect like `usage`.
    runtimes: Value,
    /// This agent's own tool-approval deadline, declared at register. `None` for
    /// an agent too old to send it — treated as the default.
    approval_timeout_ms: Option<i64>,
    /// What the browsers have actually been told about this machine's sessions:
    /// `sessionId -> fingerprint of the summary`, over the CAPPED list. The
    /// per-session patch is the diff against it, so it has to be refreshed by
    /// every path that publishes — including a whole snapshot.
    ///
    /// Deliberately global rather than per viewer: `scoped_machine` still filters
    /// each patch, and both merge rules are idempotent (an upsert of something
    /// the client already has, a removal of something it never had), so a viewer
    /// who joined on a different baseline cannot be made wrong by one.
    published_sessions: HashMap<String, u64>,
    /// Fingerprints of the last inventory this agent sent: exact, and ignoring
    /// `lastModified`. Agents re-push their whole inventory on a debounce
    /// whether or not anything moved, and each push used to fan a full snapshot
    /// at every browser — on this fleet that was 765 KB every ~7.5 seconds into
    /// an idle phone. An identical inventory earns no broadcast at all; one
    /// where only mtimes moved earns a deferred one. `None` until the first.
    inventory_sig: Option<(u64, u64)>,
    /// Fingerprint of the inventory as a UI sees it — everything but the
    /// replica cursor `fileMtime`. Equal across two inventories means the
    /// browsers have nothing to learn from the second one.
    inventory_ui_sig: Option<u64>,
}

/// A request to start a brand-new run, with authorization already decided.
///
/// Exists so `spawn_session` can serve both callers: a browser pressing "new
/// session", and the backend-spec intake starting one on the owner's behalf with
/// no connection at all. Fields the UI path reads off the connection (identity,
/// origin) are therefore explicit here rather than looked up from `attach`.
struct SpawnSpec {
    /// Private machine: the first turn arrives sealed (docs/E2EE.md).
    sealed: Option<SealedTurn>,
    machine_id: String,
    cwd: String,
    message: Option<String>,
    /// Raw images value from the wire; sanitized inside `spawn_session`.
    images: Option<Value>,
    /// Raw non-image attachments; sanitized inside `spawn_session` too.
    files: Option<Value>,
    /// Skill category; unknown values are dropped, not rejected.
    category: Option<String>,
    /// 'claude' | 'codex'. Absent lets the agent pick its default.
    source: Option<String>,
    /// Internal automation must not spend an implicit personal subscription.
    require_gateway: bool,
    /// Mode to open in. Absent lets the machine's own default stand.
    permission_mode: Option<String>,
    /// Model and reasoning effort to open under, already validated against the
    /// wire enums. Absent lets the machine's own configuration stand.
    model: Option<String>,
    effort: Option<String>,
    /// Who the run belongs to — decides where approvals and pushes are routed.
    owner_user_id: Option<String>,
    owner_name: Option<String>,
    origin: Option<String>,
    /// Browser to bind to the run. None = nobody is watching yet.
    attach: Option<ConnId>,
    /// The signed-in person who clicked (wire `runBy`); None for fleet/automation.
    run_by: Option<Value>,
}

/// What a person handed a PRIVATE machine, as the hub is allowed to know it:
/// two envelopes it cannot open. `e2e` goes to the agent, `turn` (text + counts
/// + names, no bytes) goes to the other screens as `user_turn`.
#[derive(Clone)]
struct SealedTurn {
    e2e: Value,
    turn: Option<Value>,
}

/// The envelope fields of a browser frame, when they are well-formed envelopes.
/// The hub never looks inside - it checks the outer shape and forwards.
fn sealed_turn(v: &Value) -> Option<SealedTurn> {
    let envelope = |key: &str| v.get(key).filter(|e| is_envelope(e)).cloned();
    envelope("e2e").map(|e2e| SealedTurn {
        e2e,
        turn: envelope("turnE2e"),
    })
}

/// An envelope the hub is willing to treat as sealed content: version 1, a key
/// id, a nonce and a ciphertext as strings of sane size. The hub still cannot
/// read it; this only keeps `{e2e:1,c:null}` from passing for one.
fn is_envelope(e: &Value) -> bool {
    let text = |k: &str, min: usize, max: usize| {
        e.get(k)
            .and_then(Value::as_str)
            .is_some_and(|s| (min..=max).contains(&s.len()))
    };
    e.get("e2e").and_then(Value::as_i64) == Some(1)
        && text("kid", 1, 64)
        && text("n", 1, 64)
        && text("c", 1, 200_000_000)
}

/// Said to a client that sent content in the clear to a private machine.
const PRIVATE_PLAINTEXT_REFUSAL: &str = "private_machine: this machine is end-to-end encrypted - pair this device (Ввести код пары) to work in it.";

/// A request to continue an existing session as a new run — `open` /
/// `takeover` from a browser, or a fleet API `send` with nobody watching.
/// Authorization to START on the machine is the caller's to decide; the
/// single-writer checks are not, and live in `resume_session` for both.
struct ResumeSpec {
    /// Private machine: the first turn arrives sealed (docs/E2EE.md).
    sealed: Option<SealedTurn>,
    machine_id: String,
    session_id: String,
    message: Option<String>,
    /// Already sanitized by the caller.
    images: Option<Value>,
    files: Option<Value>,
    /// `takeover`: kill the current writer first. Only the browser path sets it.
    force: bool,
    /// Model / effort to continue under; the mode is never taken here.
    picked: StartSettings,
    /// Browser to bind to the run. None = nobody is watching yet.
    attach: Option<ConnId>,
    /// Full control of the machine. Without it, `attach`'s viewer must be able
    /// to see the session (a control-share member's own or a teammate's).
    can_control: bool,
    origin: Option<String>,
    /// The signed-in person who clicked (not the device or session owner), for
    /// the agent's HEGAI_RUN_USER_* env. None for fleet/automation.
    run_by: Option<Value>,
}

/// The `error` frame a refused open answers with.
fn error_frame(message: &str) -> Value {
    json!({"type":"error","message":message})
}

/// A browser RPC in flight to an agent: who asked, which machine, and what —
/// the method decides whether the answer is also an audit event.
#[derive(Default)]
struct PendingRpc {
    conn: ConnId,
    machine_id: String,
    method: String,
    /// The session a transcript read names, and the folder a file read really
    /// touches (`cwd` + `path` as the agent resolves it): what the answer is
    /// checked against AGAIN when it arrives, because the asker's rights may
    /// have been withdrawn while the agent was working.
    session_id: String,
    touched: Option<String>,
    /// The hub had a record of where `session_id` lives when it was asked.
    placed: bool,
    /// `params.cwd` as the caller sent it (a `projects.remove` answer carries
    /// no path of its own).
    cwd: Option<String>,
    /// For a `session.messages` read the replica could also answer: what to
    /// read if the agent misses its deadline (`HubCmd::HistoryDeadline`).
    history: Option<HistoryFallback>,
    /// A `session.delete` already recorded in `user_deleted_sessions`, to be
    /// taken back if the agent refuses or drops.
    deleting: Option<String>,
    /// A member's `fs.upload.begin`: the answer's `uploadId` is remembered.
    member_upload: bool,
    /// The upload a member's chunk/commit/abort names, forgotten on its answer.
    upload_id: Option<String>,
}

/// Who began a member's chat-attachment upload, and where.
struct MemberUpload {
    conn: ConnId,
    user_id: String,
    cwd: String,
}

/// The replica read that stands in for an agent that is too slow to answer a
/// transcript request — the same session, limit and payload cap the browser
/// asked the agent for.
#[derive(Clone, Debug)]
struct HistoryFallback {
    session_id: String,
    source: String,
    limit: usize,
    tool_chars: Option<usize>,
    asked_at: std::time::Instant,
}

/// A session whose last run was reported over by its agent while the runtime
/// process behind it may still be exiting (`run_status` with `closing: true`).
/// The run is gone from `runs` and the session's `lock_by_key` entry is freed,
/// as for any terminal state, but an `open` is still refused until the agent
/// confirms the process gone (`writer_released`) or `until_ms` passes. Kept by
/// "machine::session" in `Hub::closing_writers`, in memory like the lock it
/// backs up.
struct ClosingWriter {
    /// The run that closed; only its own `writer_released` clears the guard.
    run_id: String,
    /// `now_ms()` after which the guard no longer holds.
    until_ms: i64,
}

struct ActiveRun {
    machine_id: String,
    machine_name: String,
    session_id: String,
    title: Option<String>,
    project: Option<String>,
    /// Which cc-remote client opened this run: "app" | "web" | None (=> web).
    origin: Option<String>,
    browsers: HashSet<ConnId>,
    /// "working" | "needs_attention" | "idle" | "error" — attention state the
    /// UI uses for badges, the notification center, and the board.
    state: String,
    /// Short preview of the last assistant output (board cards).
    preview: Option<String>,
    /// Accumulates streamed text for the current turn; becomes `preview` on idle.
    text_buf: String,
    /// The current turn's stream frames, verbatim, so a client that attaches
    /// mid-turn is shown what already happened instead of an empty pane. Bounded
    /// (see `REPLAY_*`) and cleared when the turn ends — once the turn lands, the
    /// transcript on disk is the record and the client reads that instead.
    replay: VecDeque<Value>,
    /// Bytes currently held in `replay`, to bound it by size and not just count.
    replay_bytes: usize,
    /// ms of the last state change.
    since: i64,
    /// Last user input accepted by the agent. Replayed after hub/agent reconnect.
    task_started_at: Option<i64>,
    /// ms this run was created here. Never rewritten, unlike `since` — the
    /// reconciliation grace has to measure age from the OPEN, and a field that
    /// any state change could reset would quietly extend the window a stuck run
    /// survives.
    opened_at: i64,
    /// The tool approval currently awaiting a decision, if any. Rides along in the
    /// push payload so a phone can answer it from the notification (needs the
    /// requestId), and cleared once the turn resumes.
    pending_request_id: Option<String>,
    pending_tool: Option<String>,
    /// Retained while approval is pending so a reconnecting browser can render
    /// the same decision after a mobile/background socket suspension.
    pending_tool_input: Option<Value>,
    pending_tool_title: Option<String>,
    /// The last thing a person typed into this run (≤ 2000 chars; empty for a
    /// private machine, whose content the hub never reads). Feeds the push
    /// summary of an admin's finished turn (docs/WATCH.md §1).
    last_user_text: String,
    /// Why the last turn failed, as the agent worded it (≤ 300 chars).
    last_error: Option<String>,
    /// Private machine: the sealed `input` + `title` of the pending approval,
    /// replayed to a late subscriber as the agent sent it.
    pending_tool_e2e: Option<Value>,
    /// Who started this run (from the opener's `UiAccess`). Drives the owner badge
    /// and the employee visibility filter. None for legacy/unowned sessions.
    owner_user_id: Option<String>,
    owner_name: Option<String>,
    /// Session category (see shared/categories.ts), if started with one.
    category: Option<String>,
    /// Working directory of this run, kept so run visibility can be evaluated
    /// against project-share roots even before the first inventory sync.
    cwd: Option<String>,
    /// Which runtime drives it ("codex" | "claude"); None = a legacy Claude
    /// run. A service UI pass drives Codex runs only (`ui_can_drive_run`).
    source: Option<String>,
    /// Last `run_mode` / `run_settings` the agent reported, replayed verbatim to
    /// a browser that subscribes later. The agent announces these once, when the
    /// runtime tells it; a client that reloads afterwards would otherwise show
    /// its composer defaults for a run that is on something else entirely.
    mode_frame: Option<Value>,
    settings_frame: Option<Value>,
    /// The agent's last `background_tasks` status while it was non-empty: what
    /// the CLI still runs for this session (a Bash with `run_in_background`, a
    /// backgrounded subagent) after the turn went quiet. The agent withholds
    /// the turn's `result` until that set empties, so the run reads `working`
    /// the whole time; this is what lets a viewer who opens it mid-task see
    /// «в фоне: …» instead of 25 minutes of a bare «работает…».
    background_frame: Option<Value>,
    /// The agent's last `subagents` status: the run's sub-agents as cards and
    /// panel rows (a LEVEL — each frame replaces the last). Kept out of the
    /// replay window, which a busy agent's progress ticks would flood, and
    /// re-stated on subscribe like `background_frame`.
    subagents_frame: Option<Value>,
    /// The session's plan, `(done, total)`, from the agent's `plan_progress`
    /// status (agent/src/plan-tool.ts) — only for the Live Activity row. The
    /// agent resets it to none on every human turn; a private machine seals
    /// the numbers and the hub never learns them.
    plan: Option<PlanState>,
    /// The run's last `context_usage` frame as forwarded. The agent re-reads
    /// it every 15 s even for an idle run; only a changed tuple is forwarded,
    /// and a viewer that attaches later is told this one (`subscribe`).
    context_frame: Option<Value>,
    /// ms of the last frame the agent sent about this run — any stream event,
    /// a tool request, a status. `since` dates the last STATE change; this
    /// dates the last sign of life, which is what a viewer needs to tell a
    /// turn that is thinking from one that is stuck: a run `working` since
    /// 14:02 with nothing heard since 14:02 is waiting on something.
    last_event_at: i64,
    /// ms of the last time `last_event_at` was actually PUSHED to viewers.
    /// The field above moves on every frame, but `activity` only goes out when
    /// a run's state CHANGES — so for a run that stays `working` the browser
    /// kept the value it got when the turn began and diffed it against its own
    /// clock. «Нет событий 2 мин» under a transcript that was visibly filling
    /// was that: the number was the age of the TURN, not of the silence.
    last_event_sent_at: i64,
    /// The last stream frame was a `tool_use`, so the runtime is inside a tool
    /// and its silence is expected rather than a symptom. See `handle_stream`.
    awaiting_tool: bool,
    /// A compaction was requested (`compact_started`) and no verdict
    /// (`compact_done` / `compact_failed`) has arrived. Replayed to a client
    /// that subscribes in between, so a reload does not show an idle «Сжать»
    /// button while the queued `/compact` is still pending — the double press
    /// that used to end in «Not enough messages to compact.»
    compacting: bool,
    /// The current turn failed (`run_error`) — kept past the agent settling the
    /// run back to idle, which it does within milliseconds, so a fleet `wait`
    /// polling every few seconds can tell a failed turn from a finished one.
    /// Cleared when the next turn starts.
    turn_failed: bool,
}

/// The session's checklist as the agent last reported it. `done`/`total` feed
/// the Live Activity; `active` and `steps` only the watch inbox, so a change in
/// them alone never wakes the Live Activity (it does not show them).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct PlanState {
    pub done: u32,
    pub total: u32,
    /// The step in progress, <= 160 chars.
    pub active: Option<String>,
    /// <= 12 rows of (text <= 80 chars, status: completed|in_progress|pending).
    pub steps: Vec<(String, String)>,
}

/// What the idle push's LLM digest said about a finished turn, remembered so
/// the watch inbox can show it (docs/WATCH.md §4). In memory only.
#[derive(Clone, Debug)]
pub(crate) struct WatchDigest {
    pub summary: String,
    pub replies: Vec<crate::push_payload::Reply>,
    /// The run's `since` of the idle transition it describes.
    pub since: i64,
    /// ms the digest was made.
    pub made_ms: i64,
}

/// Digests kept at most (oldest `made_ms` leaves first).
const WATCH_DIGESTS_MAX: usize = 200;

/// One entry of a registering agent's `liveRuns` — a run whose subprocess is
/// still driving a session on that machine right now.
struct DeclaredRun {
    run_id: String,
    session_id: String,
    /// Absent from an agent too old to send it; such a run can still be kept,
    /// only not rebuilt from scratch (see `settle_agent_runs`).
    cwd: Option<String>,
}

impl DeclaredRun {
    fn parse(v: &Value) -> Option<Self> {
        Some(Self {
            run_id: v.get("runId").and_then(Value::as_str)?.to_string(),
            session_id: v
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            cwd: v
                .get("cwd")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
        })
    }
}

/// Persisted session ownership + category, cached in memory so the per-connection
/// snapshot filter never touches the DB.
struct SessionMeta {
    owner_user_id: String,
    category: Option<String>,
    /** Mutable kanban stage (see stages.ts). None = off the Flow board. */
    stage: Option<String>,
    /// "fleet" for sessions started through the fleet API; those are stamped
    /// `automated` in session lists. Never set for anything else.
    origin: Option<String>,
}

struct PendingReplicaSync {
    conn: ConnId,
    machine_id: String,
    source: String,
    session_id: String,
    summary: Value,
    mode: String,
    base_revision: i64,
    generation: String,
    start_position: i64,
    next_position: i64,
}

/// Remove a presentation subscriber without changing run ownership or locks.
/// A browser socket can disappear whenever a mobile app is backgrounded.
fn detach_browser_from_runs(runs: &mut HashMap<String, ActiveRun>, conn: ConnId) {
    for run in runs.values_mut() {
        run.browsers.remove(&conn);
    }
}

fn truncate(s: &str, n: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= n {
        t.to_string()
    } else {
        let mut out: String = t.chars().take(n).collect();
        out.push('…');
        out
    }
}

/// What one broadcast works out once and hands to every viewer that shares an
/// answer (`Hub::access_key`): the unscoped fleet, each rights-class's scoped
/// view of it, and each class's activity board. Lives for one broadcast only.
#[derive(Default)]
struct ViewCache {
    base: Option<Vec<Value>>,
    scoped: HashMap<String, Vec<Value>>,
    runs: HashMap<String, Value>,
    team: HashMap<String, Vec<Value>>,
}

impl ViewCache {
    fn base(&mut self, hub: &Hub) -> &[Value] {
        self.base.get_or_insert_with(|| hub.all_machine_entries())
    }
}

struct Hub {
    self_tx: UnboundedSender<HubCmd>,
    conns: HashMap<ConnId, Tx>,
    agents: HashMap<String, AgentConn>,    // machineId -> agent
    conn_machine: HashMap<ConnId, String>, // agent conn -> machineId
    ui_clients: HashSet<ConnId>,
    ui_access: HashMap<ConnId, UiAccess>,
    /// Which sign-in session each `/ui` socket rides on, so ending a session
    /// («выйти везде») also ends the sockets it already opened.
    ui_sessions: HashMap<ConnId, String>,
    /// Support accounts only: when an identical `support.ui` row was last
    /// written (`DUPLICATE_EVERY_MS`), so keystrokes and the chunks of one
    /// upload are one row, not thousands. Empty on a hub with no grants.
    support_logged: HashMap<String, i64>,
    agent_users: HashMap<ConnId, (String, Option<String>)>,
    /// UI conn -> client kind ("app" | "web"), from the `hello` frame. Absent =>
    /// treated as "web". Tags each run's `origin` so the board can split App vs Web.
    ui_kind: HashMap<ConnId, String>,
    /// UI conns that told us they are backgrounded (`pause`). A paused conn
    /// receives NOTHING on the Text lane: a suspended app cannot drain its
    /// socket, so fanning multi-megabyte snapshots at it fills the bounded
    /// outbound queue and gets the peer dropped as slow — which is exactly the
    /// "hub reconnects on every app switch" the pause protocol exists to stop.
    /// The ws-level server ping (ws_api.rs) keeps NAT/nginx alive meanwhile.
    ui_paused: HashSet<ConnId>,
    /// Paused conns that asked to keep receiving the acks of their own
    /// requests (`pause` with `acks: true`) — see `passes_pause`.
    ui_paused_acks: HashSet<ConnId>,
    /// The pane of a browser window whose message is being handled right now,
    /// and the socket it came on. One window holds ONE /ui socket for every
    /// pane of its split, so a reply — a refusal, the ack of an open, the
    /// replay a `subscribe` gets — has to name the pane that asked, or the
    /// refusal hands the text back to the wrong composer and the replay is
    /// drawn twice in a pane that was already watching. `send_to` copies it
    /// onto every frame that socket gets until the message is handled.
    reply_ref: Option<(ConnId, String)>,
    /// When each SESSION (`machine::session`) last had its failure pushed —
    /// see `ERROR_PUSH_REPEAT_MS`.
    error_pushed: HashMap<String, i64>,
    /// Machines whose session list has moved in a way not worth interrupting
    /// anyone for on its own — today that means an inventory where only
    /// `lastModified` changed. Cleared by any broadcast, so a real change
    /// carries the deferred one with it and the flush tick is the backstop.
    pending_machines: HashSet<String>,
    /// Team viewers (owner / manager) owed a snapshot because a machine they
    /// list came online; paid by `coalesce_tick` inside the coalescing window.
    team_snapshot_owed: HashSet<ConnId>,
    /// Optional client capabilities from the `hello` frame, per UI conn. Absent
    /// (an older build, or one that sends no `hello`) means "assume nothing".
    ui_caps: HashMap<ConnId, HashSet<String>>,
    /// UI conns that announced `statsOnDemand` and whose last `stats_interest`
    /// said `on`. A conn WITH the cap and NOT in here gets no `machine_stats`;
    /// a conn without the cap is not consulted (it always gets them).
    ui_stats_interest: HashSet<ConnId>,
    /// Per-socket state shared with the write loop (queued bytes, pause).
    out_gates: HashMap<ConnId, Arc<OutGate>>,
    /// Hash of the last `activity` frame each UI conn was actually sent. An
    /// identical board is not sent again; dropped on every snapshot (which
    /// carries its own board) so a revert to an older board is never muted.
    /// Interior mutability: `broadcast_activity` is a `&self` method.
    activity_sent: RefCell<HashMap<ConnId, u64>>,
    /// A run's heartbeat is due and nobody has published it yet — paid by the
    /// next coalescing tick, in ONE broadcast for every run. Any `activity`
    /// broadcast clears it: it carries every run's current stamp anyway.
    activity_dirty: Cell<bool>,
    /// `broadcast_snapshot` was asked for inside the window of the previous
    /// one; the coalescing tick sends one trailing snapshot.
    snapshot_dirty: bool,
    /// The same for the whole snapshots owed to viewers that take no deltas.
    full_snapshot_dirty: bool,
    /// ms of the last whole-fleet snapshot broadcast.
    last_snapshot_at: i64,
    runs: HashMap<String, ActiveRun>, // runId -> run
    /// runId -> the agent socket that dropped while the run was live. These runs
    /// are held (locks included) through the grace window so a blip doesn't kill
    /// live work; the agent re-declares survivors on `register` and whatever is
    /// still listed here when the grace fires gets released for real.
    orphaned_runs: HashMap<String, ConnId>,
    /// machineId -> the agent's per-process id from its last `register`. A
    /// change means the daemon restarted, so any run it claims to still drive
    /// died with the old process and must not be re-adopted.
    agent_instance: HashMap<String, String>,
    lock_by_key: HashMap<String, String>, // "machine::session" -> runId
    /// "machine::session" -> a writer that may still be exiting after its run
    /// was released (`ClosingWriter`). Checked lazily by `resume_session`,
    /// swept on the housekeeping tick.
    closing_writers: HashMap<String, ClosingWriter>,
    /// "machine::session" -> owner + category. Loaded once from the DB at startup
    /// and updated on session_started; read on every snapshot (hot path, no SQL).
    session_meta: HashMap<String, SessionMeta>,
    erased_sessions: Option<HashSet<String>>,
    /// userId -> {userId,email,fullName?} for rendering owner badges without a DB
    /// hit per session. Filled from session owners at startup + on session_started.
    user_display: HashMap<String, Value>,
    pending_rpc: HashMap<String, PendingRpc>, // requestId -> who asked, where, what
    /// Chat-attachment uploads a control-share member has open on a machine:
    /// (machine, uploadId) -> who began it. `fs.upload.chunk|commit|abort` carry
    /// no cwd, so for a non-owner this record is the only proof the upload is
    /// theirs. Dropped on commit/abort, when the connection or machine goes.
    member_uploads: HashMap<(String, String), MemberUpload>,
    /// `fs.mkdir` asked for by the service API (`service_api.rs`): requestId ->
    /// (machine, answer). Not a browser request, so it has no `conn` to reply to.
    service_rpc: HashMap<String, (String, tokio::sync::oneshot::Sender<bool>)>,
    terminals: HashMap<String, (ConnId, String)>, // termId -> (ui conn, machineId)
    mirrors: HashMap<String, (ConnId, String)>,   // mirrorId -> (ui conn, machineId)
    /// What each open mirror watches (session, cwd), so a revoked share can
    /// close it (`revalidate_subscriptions`).
    mirror_sessions: HashMap<String, (String, Option<String>)>,
    store: ReplicaStore,
    workspaces: WorkspaceStore,
    bootstrap_user_id: String,
    pending_replica: HashMap<String, PendingReplicaSync>, // syncId -> transaction cursor
    /// Optional out-of-band notifier (Telegram + APNs). None unless a backend is
    /// configured; the transition fns fire genuine-transition events.
    notify: Option<UnboundedSender<crate::notify::Outbound>>,
    /// A machine's Claude/Codex login going bad -> the ops chat
    /// (`runtime_alert.rs`). Transition-based; the first reading is a baseline.
    runtime_alerts: crate::runtime_alert::RuntimeAlerts,
    /// Operational pause of Claude API checks and ops alerts, by device owner.
    claude_monitoring_paused_owners: HashSet<String>,
    /// Explicit machine exceptions for quota reads; owner ops alerts stay paused.
    claude_usage_enabled_machines: HashSet<String>,
    /// APNs device tokens registered by mobile clients (deviceToken -> reg ms).
    /// In-memory (Postgres later); clients re-register on every connect, so a hub
    /// restart heals within one app launch. Capped so a buggy client can't grow it.
    push_devices: HashMap<String, (i64, String)>,
    /// The watch feature's switches; None => the process-wide config
    /// (`push_action::config`). Tests set their own.
    watch_cfg: Option<crate::push_action::WatchConfig>,
    /// The last idle-push digest per session (`"machine::session"`), for the
    /// watch inbox. Bounded by `WATCH_DIGESTS_MAX`; lost on a restart.
    watch_digests: HashMap<String, WatchDigest>,
    /// Live Activity tokens and aggregation (`live_activity.rs`).
    live: crate::live_activity::LiveRegistry,
    /// Some run's state moved since the Live Activity snapshots were taken.
    live_dirty: Cell<bool>,
    /// No Live Activity evaluation before this (epoch ms): a restarted hub
    /// has no runs until the agents re-register.
    live_grace_until_ms: i64,
    roadmap_config: RoadmapConfig,
    /// LLM annotation of assistant turns (gateway config + cache). None unless
    /// LLM_ENRICH_* is configured; requests then answer "not configured" and
    /// the web falls back to its local heuristics.
    enrich: Option<enrich::EnrichState>,
    title_job: Option<titles::TitleJob>,
    /// What the task registry's child links look like in memory
    /// (`hub/tasks.rs`).
    task_links: tasks::TaskLinks,
    /// `CC_REMOTE_FLEET_MACHINE_IDS`: machines the shared fleet token may
    /// register as. None = unset = the legacy escape (any machine). Checked at
    /// `register`, the first moment a fleet-token socket names its machine.
    fleet_machine_ids: Option<HashSet<String>>,
    /// `CC_REMOTE_MEMORY_SYNC_MACHINES`: machines the hub replicates the
    /// owner's memory to and accepts memory from. None = unset = every
    /// non-sandbox device of the owner (the old behaviour). The agent's own
    /// `CC_REMOTE_MEMORY_SYNC` is a courtesy, not a boundary: a modified agent
    /// ignores it, so the decision has to live here.
    memory_sync_machines: Option<HashSet<String>>,
}

/// Global bound on APNs registrations; a per-user cap keeps one person from
/// filling it.
const MAX_PUSH_DEVICES: usize = 8192;
const MAX_PUSH_DEVICES_PER_USER: usize = 5;

/// Browser frames a not-yet-active viewer may still send: what keeps the
/// socket healthy, subscriptions (they see nothing anyway), push
/// registration, and the memory store (`memory_*`, matched by prefix).
const INACTIVE_ALLOWED: &[&str] = &[
    "hello",
    "ping",
    "pause",
    "resume",
    "stats_interest",
    "subscribe",
    "unsubscribe",
    "register_push",
    "unregister_push",
];

/// Browser frames a connection on a service UI pass (`UiAccess::ui_scope`) may
/// send. Everything else is answered `error {code:"scope_refused"}`.
const SCOPED_ALLOWED: &[&str] = &[
    "hello",
    "ping",
    "pause",
    "resume",
    "stats_interest",
    "subscribe",
    "unsubscribe",
    "open",
    "new_session",
    "input",
    "interrupt",
    "close",
    "tool_decision",
    "session_read",
    message::RPC_REQUEST,
];

/// The only `rpc_request` methods such a connection may call.
const SCOPED_RPC_METHODS: &[&str] = &[
    "session.messages",
    "session.image",
    "session.rename",
    "models.list",
];

/// Where a category puts a brand-new session on the Flow board, if anywhere.
///
/// Only `rambling` answers. Its output is a written-up task and nothing else —
/// no branch, no commit — so showing it as work in progress, or leaving it off
/// the board entirely, both misfile it the moment it is created. Every other
/// category starts unstaged: the board is for things a person chose to track.
pub(crate) fn category_stage_on_start(category: &str) -> Option<&'static str> {
    match category {
        "rambling" => Some("backlog"),
        _ => None,
    }
}

/// Session category id -> skill slash-command name. Mirror of the id↔skill pairs
/// in shared/categories.ts; unknown categories are dropped.
const CATEGORY_SKILLS: &[(&str, &str)] = &[
    // The one PICKABLE category (shared/src/categories.ts). It rides inside the
    // agent bundle, so it resolves on every machine whose agent has restarted
    // since it shipped.
    ("rambling", "rambling"),
    // Retired from the chip row, still carried by every session that already
    // has one. Mirrors LEGACY_CATEGORIES in shared/src/categories.ts. Since
    // 24.09.2026 these skills are not in the fleet bundle (they are the repo's
    // dev-process skills, .claude/skills/), so an old `?cat=bugs` link resolves
    // the prefix only on a machine that has /bugs installed by other means.
    ("sync", "sync"),
    ("ship", "raskatai"),
    ("verify", "verify"),
    ("bugs", "bugs"),
    ("mobile", "mobile"),
    ("feature", "feature"),
    ("codex", "codex-review"),
    ("backlog", "backlog"),
    ("research", "research"),
    // Not bundled: these two live only where the work can happen.
    ("webpage", "webpage"),
    ("text", "text"),
    // A backend change specced by someone who cannot make it themselves. The
    // session opens on the backend machine, in plan mode, for the owner to
    // approve — see `backend_request` and the `backend-tz` skill.
    ("tz", "backend-tz"),
];

/// Wire values for the three run settings a client may choose AT START.
/// Mirrors of `PermissionMode` and `EffortLevel` in shared/src/protocol.ts.
///
/// They exist here, and not only on the agent, because of an asymmetry between
/// the two ways these settings travel. Mid-session they ride in their own
/// messages (`set_model` / `set_effort` / `set_permission_mode`), so an agent
/// rejecting one costs only that message. At start they are FIELDS of
/// `new_session`, which the agent parses as a single zod object — a value it
/// refuses takes the whole start with it, and the browser sees a session that
/// never appears rather than an error. So an unrecognised value is dropped here
/// and the session opens under the machine's own default.
const PERMISSION_MODES: [&str; 6] = [
    "default",
    "plan",
    "acceptEdits",
    "bypassPermissions",
    "dontAsk",
    "auto",
];
const EFFORT_LEVELS: [&str; 4] = ["low", "medium", "high", "xhigh"];

/// A model id longer than this is not a model id. The wire type is a free
/// string (the runtime names its own), so the only honest bound is "long enough
/// for any real name, short enough that nothing interesting fits".
const MODEL_ID_MAX: usize = 120;

/// The three run settings a start screen may choose, once validated.
#[derive(Debug, Default, PartialEq, Eq)]
struct StartSettings {
    permission_mode: Option<String>,
    model: Option<String>,
    effort: Option<String>,
}

/// Read model / effort / mode off a `new_session` frame.
///
/// Every rejection here is a DROP, never an error back to the browser. The
/// agent parses `new_session` as one zod object, so a field it refuses takes
/// the whole start with it — and a session that silently never appears is a
/// much worse failure than one that opened under the machine's own default.
/// The client is not lied to either: the agent reports what the run is actually
/// on through `run_settings`, so a dropped pick shows up as a picker that
/// simply did not move.
fn start_settings(v: &Value, offers_bypass: bool) -> StartSettings {
    StartSettings {
        permission_mode: v
            .get("permissionMode")
            .and_then(Value::as_str)
            .filter(|m| PERMISSION_MODES.contains(m))
            // `bypassPermissions` is the one mode a machine may WITHHOLD — a box
            // declaring a sandbox posture keeps its approval checkpoint. The
            // agent re-checks on its own side, but honouring the machine's
            // advertisement here keeps the refusal at the layer that published
            // it, and out of the hands of a client with a stale picker.
            .filter(|m| *m != "bypassPermissions" || offers_bypass)
            .map(str::to_string),
        model: v
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|m| !m.is_empty() && m.len() <= MODEL_ID_MAX)
            .map(str::to_string),
        effort: v
            .get("effort")
            .and_then(Value::as_str)
            .filter(|e| EFFORT_LEVELS.contains(e))
            .map(str::to_string),
    }
}

/// Valid kanban stage ids. Mirror of the `SessionStage` enum in shared/stages.ts;
/// an unknown value clears the stage. One Rust copy, shared with the task
/// board (`board.rs`) so a column and a session stage never disagree.
use crate::board::STAGE_IDS;

impl Hub {
    fn new(
        self_tx: UnboundedSender<HubCmd>,
        notify: Option<UnboundedSender<crate::notify::Outbound>>,
        store: ReplicaStore,
        workspaces: WorkspaceStore,
        bootstrap_user_id: String,
        roadmap_config: RoadmapConfig,
    ) -> Self {
        // Warm the session-owner + owner-display caches from the DB once.
        let mut session_meta: HashMap<String, SessionMeta> = HashMap::new();
        let mut user_display: HashMap<String, Value> = HashMap::new();
        if let Ok(rows) = workspaces.all_session_meta() {
            for (machine_id, session_id, owner, category, stage, origin) in rows {
                if !user_display.contains_key(&owner) {
                    if let Ok(Some(u)) = workspaces.user_json(&owner) {
                        user_display.insert(owner.clone(), u);
                    }
                }
                session_meta.insert(
                    format!("{machine_id}::{session_id}"),
                    SessionMeta {
                        owner_user_id: owner,
                        category,
                        stage,
                        origin,
                    },
                );
            }
        }
        let task_links = tasks::TaskLinks::load(&workspaces);
        let live = crate::live_activity::LiveRegistry::from_store(&workspaces);
        let hub = Hub {
            self_tx,
            conns: HashMap::new(),
            agents: HashMap::new(),
            conn_machine: HashMap::new(),
            ui_clients: HashSet::new(),
            ui_access: HashMap::new(),
            ui_sessions: HashMap::new(),
            support_logged: HashMap::new(),
            agent_users: HashMap::new(),
            ui_kind: HashMap::new(),
            ui_paused: HashSet::new(),
            ui_paused_acks: HashSet::new(),
            reply_ref: None,
            error_pushed: HashMap::new(),
            pending_machines: HashSet::new(),
            team_snapshot_owed: HashSet::new(),
            ui_caps: HashMap::new(),
            ui_stats_interest: HashSet::new(),
            out_gates: HashMap::new(),
            activity_sent: RefCell::new(HashMap::new()),
            activity_dirty: Cell::new(false),
            snapshot_dirty: false,
            full_snapshot_dirty: false,
            last_snapshot_at: 0,
            runs: HashMap::new(),
            orphaned_runs: HashMap::new(),
            agent_instance: HashMap::new(),
            lock_by_key: HashMap::new(),
            closing_writers: HashMap::new(),
            session_meta,
            erased_sessions: workspaces.erased_session_keys().ok(),
            user_display,
            pending_rpc: HashMap::new(),
            member_uploads: HashMap::new(),
            service_rpc: HashMap::new(),
            terminals: HashMap::new(),
            mirrors: HashMap::new(),
            mirror_sessions: HashMap::new(),
            store,
            runtime_alerts: crate::runtime_alert::RuntimeAlerts::from_env(&bootstrap_user_id),
            claude_monitoring_paused_owners: std::env::var(
                "CC_REMOTE_CLAUDE_MONITORING_PAUSED_OWNERS",
            )
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
            claude_usage_enabled_machines: std::env::var("CC_REMOTE_CLAUDE_USAGE_ENABLED_MACHINES")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect(),
            workspaces,
            bootstrap_user_id,
            pending_replica: HashMap::new(),
            notify,
            push_devices: HashMap::new(),
            watch_cfg: None,
            watch_digests: HashMap::new(),
            live,
            live_dirty: Cell::new(true),
            live_grace_until_ms: now_ms() + LIVE_START_GRACE_MS,
            roadmap_config,
            enrich: enrich::EnrichState::from_env(),
            title_job: titles::TitleJob::from_env(),
            task_links,
            fleet_machine_ids: std::env::var("CC_REMOTE_FLEET_MACHINE_IDS")
                .ok()
                .map(|raw| {
                    raw.split(',')
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .collect::<HashSet<String>>()
                }),
            memory_sync_machines: std::env::var("CC_REMOTE_MEMORY_SYNC_MACHINES")
                .ok()
                .map(|raw| {
                    raw.split(',')
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .collect::<HashSet<String>>()
                }),
        };
        hub
    }

    /// Hand the machine's current `runtimes` to the alerter. Cheap: one
    /// indexed row read, and it runs on register and when a reading CHANGES
    /// (the agent sends `runtime_status` only then), not on every poll.
    fn observe_runtimes(&mut self, id: &str, baseline_only: bool) -> Vec<String> {
        let Some(a) = self.agents.get(id) else {
            return Vec::new();
        };
        if !a.runtimes.is_object() {
            return Vec::new();
        }
        let name = a
            .machine
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(id)
            .to_string();
        let mut runtimes = a.runtimes.clone();
        // A database error must not read as «no owner row» — that is the
        // legacy fleet, i.e. the owner's, and would leak a member's account
        // into the ops chat. Skip the reading instead.
        let owner = match self.workspaces.device_owner(id) {
            Ok(o) => o,
            Err(e) => {
                eprintln!("[runtime-alert] owner lookup for {id} failed: {e}");
                return Vec::new();
            }
        };
        if self
            .claude_monitoring_paused_owners
            .contains(owner.as_deref().unwrap_or(&self.bootstrap_user_id))
        {
            // Keep the UI's local runtime facts, but never announce a Claude
            // failure, reminder or recovery while this owner's checks are paused.
            runtimes.as_object_mut().unwrap().remove("claude");
        }
        self.runtime_alerts
            .observe(id, &name, owner.as_deref(), &runtimes, baseline_only)
    }

    fn claude_usage_enabled(&self, id: &str) -> bool {
        match self.workspaces.device_owner(id) {
            Ok(owner) => {
                !self
                    .claude_monitoring_paused_owners
                    .contains(owner.as_deref().unwrap_or(&self.bootstrap_user_id))
                    || self.claude_usage_enabled_machines.contains(id)
            }
            Err(e) => {
                eprintln!("[hub] Claude monitoring owner lookup for {id} failed: {e}");
                false
            }
        }
    }

    /// Snapshot a run into a PushEvent and hand it to the notifier (if any).
    /// Called from the transition fns only on a genuine change. The current APNs
    /// device tokens ride along so the notifier stays stateless about the map.
    /// Could `user` still open this run, in some workspace of theirs? Full
    /// control of the machine always counts; otherwise the run's folder must be
    /// one the share ACL leaves them (not inside or above a restricted root they
    /// are shut out of) — the same question `ui_can_view_session` asks of a socket.
    fn owner_may_see_run(&self, user: &str, run: &ActiveRun) -> bool {
        let Ok(workspaces) = self.workspaces.workspaces(user) else {
            return false;
        };
        workspaces.iter().any(|workspace| {
            let Some(id) = workspace.get("workspaceId").and_then(Value::as_str) else {
                return false;
            };
            let Ok(access) = self.workspaces.ui_access(user, Some(id), false) else {
                return false;
            };
            let Ok(machine) = self.workspaces.machine_access(&access, &run.machine_id) else {
                return false;
            };
            machine.can_control
                || (machine.can_view
                    && run
                        .cwd
                        .as_deref()
                        .is_some_and(|cwd| machine.allows_path(cwd)))
        })
    }

    /// A machine has just become private: drop what the hub holds in the clear
    /// for it. The replica and the speech archive go (the agent re-uploads
    /// sealed), the board only loses THIS machine's links (a card that also
    /// summarises other machines stays), the live runs forget the text they
    /// kept, and the project shares of the machine are revoked. Returns whether
    /// the stored copies were purged (the caller then drops its session list).
    fn purge_for_transition(
        &mut self,
        id: &str,
        _now: i64,
        to_private: bool,
    ) -> Result<(), String> {
        let all = self.store.sessions_idle_since(id, i64::MAX)?;
        let c = self.store.purge_sessions_for_private(id, &all)?;
        println!(
            "[hub] {id} {}: purged {} session(s), {} message(s), unlinked {} board card(s)",
            if to_private {
                "became private (plaintext dropped)"
            } else {
                "stopped being private (ciphertext dropped, the agent re-uploads in the clear)"
            },
            c.sessions,
            c.messages,
            c.board_cards
        );
        self.forget_enrichment(id, &all);
        // A live run's digest may describe a session the store does not hold yet.
        let prefix = format!("{id}::");
        self.watch_digests
            .retain(|key, _| !key.starts_with(&prefix));
        if !to_private {
            return Ok(());
        }
        for run in self.runs.values_mut().filter(|r| r.machine_id == id) {
            run.title = None;
            run.preview = None;
            run.text_buf.clear();
            run.replay.clear();
            run.replay_bytes = 0;
            run.pending_tool_input = None;
            run.pending_tool_title = None;
            // Replayed to late subscribers and shown in lists: all derived from
            // what the person did, so none of it survives the switch.
            run.background_frame = None;
            run.subagents_frame = None;
            run.plan = None;
            run.project = None;
            run.cwd = None;
        }
        match self.workspaces.revoke_project_shares_for_machine(id) {
            Ok(0) => {}
            Ok(n) => println!("[hub] {id} became private: revoked {n} project share(s)"),
            Err(e) => return Err(format!("could not revoke shares: {e}")),
        }
        Ok(())
    }

    /// Did this machine's owner mark it private (docs/E2EE.md)? The live
    /// registration is the truth; an offline machine answers from the row the
    /// last registration left.
    pub(crate) fn machine_private(&self, machine_id: &str) -> bool {
        match self.agents.get(machine_id) {
            Some(a) => a.machine.get("private").and_then(Value::as_bool) == Some(true),
            None => self.workspaces.machine_is_private(machine_id),
        }
    }

    fn emit_push(&self, run_id: &str, state: &str) {
        self.emit_push_for(run_id, state, false);
    }

    /// `releasing`: the run is about to be released (a terminal failure), so
    /// the push offers nothing to answer.
    fn emit_push_for(&self, run_id: &str, state: &str, releasing: bool) {
        let Some(tx) = &self.notify else { return };
        if let Some(r) = self.runs.get(run_id) {
            // A private machine's push says which machine, never what about:
            // the title is built from content the hub cannot read.
            let title = self.run_title(r);
            let owner_user_id = r
                .owner_user_id
                .clone()
                // A run the hub could not attribute — one the agent found
                // already running rather than one opened here — falls back
                // to whoever owns the BOX. That is only sound where the box
                // has one human on it: where several people share a machine
                // registered to one of them, the fallback mailed every
                // stranger's session to that person's phone.
                //
                // The test for "one human" is a project share, NOT
                // `devices.kind`. `kind` records how the machine was
                // ENROLLED: on the live hub the shared employee sandbox
                // reads `personal` while carrying nine `control` shares, so
                // a kind gate would keep pushing in exactly the place the
                // complaint comes from. A share is what actually puts a
                // second person there.
                //
                // The query belongs here and should STAY here: this branch
                // is cold — an unattributed run, on a genuine state
                // transition, and only after the free field missed. It is
                // not per frame and must not be "optimised" into one.
                .or_else(|| {
                    // A store that cannot answer is treated as shared: the
                    // failure that sends a stranger's session to somebody's
                    // phone is worse than the one that drops a push.
                    let shared = self
                        .workspaces
                        .device_has_shares(&r.machine_id)
                        .unwrap_or(true);
                    (!shared)
                        .then(|| self.workspaces.device_owner(&r.machine_id).ok().flatten())
                        .flatten()
                });
            if owner_user_id
                .as_deref()
                .is_some_and(|owner| !self.workspaces.is_active(owner))
            {
                return;
            }
            // Someone taken off a restricted share (or never on it) is not told
            // what happens in it, even if they started the session: a push
            // carries the title and the preview of what the run said. Fail
            // closed — a store that cannot answer sends nothing.
            if let Some(owner) = owner_user_id.as_deref() {
                if !self.owner_may_see_run(owner, r) {
                    return;
                }
            }
            // The workspace a tap on the push opens: among those where the
            // owner may drive this machine, the same pick a client lands on
            // (a team before «Моя работа») — otherwise the phone would be
            // switched back to the personal space the landing rule hides.
            let workspace_id = owner_user_id.as_deref().and_then(|owner| {
                let usable: Vec<Value> = self
                    .workspaces
                    .workspaces(owner)
                    .ok()?
                    .into_iter()
                    .filter(|workspace| {
                        let Some(id) = workspace.get("workspaceId").and_then(Value::as_str) else {
                            return false;
                        };
                        let Ok(access) = self.workspaces.ui_access(owner, Some(id), false) else {
                            return false;
                        };
                        // The run itself must be reachable there, not just the
                        // machine: two teams may share different roots of it.
                        self.workspaces
                            .machine_access(&access, &r.machine_id)
                            .is_ok_and(|machine| {
                                (machine.can_control || machine.can_start)
                                    && r.cwd.as_deref().is_none_or(|cwd| machine.allows_path(cwd))
                            })
                    })
                    .collect();
                crate::workspace::WorkspaceStore::default_workspace(&usable)?
                    .get("workspaceId")?
                    .as_str()
                    .map(str::to_string)
            });
            let private = self.machine_private(&r.machine_id);
            let content = self.push_content(
                run_id,
                r,
                state,
                owner_user_id.as_deref(),
                workspace_id.as_deref(),
                private,
                releasing,
            );
            let wants_summary = state == "idle"
                && !private
                && owner_user_id
                    .as_deref()
                    .is_some_and(|owner| self.watch_cfg().admins.contains(owner));
            let summarizer = if wants_summary {
                self.enrich.as_ref().map(|e| e.push_summarizer())
            } else {
                None
            };
            let event = crate::notify::PushEvent {
                workspace_id,
                run_id: run_id.to_string(),
                title,
                machine: r.machine_name.clone(),
                session_id: r.session_id.clone(),
                machine_id: r.machine_id.clone(),
                state: state.to_string(),
                request_id: r.pending_request_id.clone(),
                tool: r.pending_tool.clone(),
                owner_user_id: owner_user_id.clone(),
                device_tokens: owner_user_id
                    .map(|owner| {
                        self.push_devices
                            .iter()
                            .filter(|(_, (_, user))| user == &owner)
                            .map(|(token, _)| token.clone())
                            .collect()
                    })
                    .unwrap_or_default(),
                content,
            };
            match summarizer {
                // An admin's finished turn gets one line from the gateway. The
                // call runs in its own task with a hard timeout, so neither
                // this loop nor any other push waits for it. The answer comes
                // back through the hub (`push_summary_ready`), which sends the
                // push only if the run is still in this idle transition — a
                // question asked meanwhile must not be overwritten by it (same
                // collapse id). On any failure the push goes out plain.
                Some(summarizer) => {
                    let hub_tx = self.self_tx.clone();
                    let since = r.since;
                    let user_text = r.last_user_text.clone();
                    let assistant_text = event.content.assistant_text.clone();
                    tokio::spawn(async move {
                        let s = summarizer.summarize(&user_text, &assistant_text).await;
                        let (summary, replies) = match s {
                            Some(s) => (Some(s.summary), s.replies),
                            None => (None, Vec::new()),
                        };
                        let _ = hub_tx.send(HubCmd::PushSummary {
                            event: Box::new(event),
                            since,
                            summary,
                            replies,
                        });
                    });
                }
                None => {
                    let _ = tx.send(crate::notify::Outbound::Push(Box::new(event)));
                }
            }
        }
    }

    /// The summary of an idle push arrived: send the push if the run is still
    /// idle since the same moment, else drop it.
    fn push_summary_ready(
        &mut self,
        mut event: crate::notify::PushEvent,
        since: i64,
        summary: Option<String>,
        replies: Vec<crate::push_payload::Reply>,
    ) {
        let Some(r) = self
            .runs
            .get(&event.run_id)
            .filter(|r| r.state == "idle" && r.since == since)
        else {
            return;
        };
        // The summary arrived up to seconds after the decision to push; what
        // was true then (admin, active, the run's owner, the device list, a
        // non-private machine) is asked again now. Fail closed: the summary
        // carries the run's words, so any doubt drops it.
        let Some(owner) = event.owner_user_id.clone() else {
            return;
        };
        if r.owner_user_id.as_deref() != Some(owner.as_str())
            || !self.watch_cfg().admins.contains(&owner)
            || !self.workspaces.is_active(&owner)
            || self.machine_private(&r.machine_id)
            || !self.owner_may_see_run(&owner, r)
        {
            return;
        }
        event.device_tokens = self
            .push_devices
            .iter()
            .filter(|(_, (_, user))| user == &owner)
            .map(|(token, _)| token.clone())
            .collect();
        let digest_key = format!("{}::{}", r.machine_id, r.session_id);
        if let Some(summary) = summary {
            self.remember_digest(
                digest_key,
                WatchDigest {
                    summary: summary.clone(),
                    replies: replies.clone(),
                    since,
                    made_ms: now_ms(),
                },
            );
            event.content.summary = Some(summary);
            event.content.replies = replies;
        }
        if let Some(tx) = &self.notify {
            let _ = tx.send(crate::notify::Outbound::Push(Box::new(event)));
        }
    }

    fn remember_digest(&mut self, key: String, digest: WatchDigest) {
        self.watch_digests.insert(key, digest);
        while self.watch_digests.len() > WATCH_DIGESTS_MAX {
            let Some(oldest) = self
                .watch_digests
                .iter()
                .min_by_key(|(_, d)| d.made_ms)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            self.watch_digests.remove(&oldest);
        }
    }

    fn handle(&mut self, cmd: HubCmd) {
        match cmd {
            HubCmd::Connected {
                conn,
                tx,
                is_agent,
                user_id,
                workspace_id,
                viewer,
                authorized_machine_id,
                auth_session,
                ui_scope,
                gate,
            } => {
                // The pass was good when the handshake checked it; a command
                // queued behind a revocation must not resurrect the socket (and
                // send it a snapshot). Dropping `tx` closes it.
                if !is_agent
                    && ui_scope.is_some()
                    && !auth_session
                        .as_deref()
                        .is_some_and(|s| matches!(self.workspaces.session_alive(s), Ok(true)))
                {
                    return;
                }
                self.conns.insert(conn, tx);
                self.out_gates.insert(conn, gate);
                if let Some(session) = auth_session {
                    self.ui_sessions.insert(conn, session);
                }
                if is_agent {
                    self.agent_users
                        .insert(conn, (user_id, authorized_machine_id));
                } else {
                    self.ui_clients.insert(conn);
                    let workspace_id =
                        workspace_id.unwrap_or_else(|| format!("personal:{user_id}"));
                    // A real viewer carries the state `ui_access()` found. No
                    // viewer is the dev fallback (nobody authenticated through
                    // the store), which has always been treated as the owner.
                    let access_state = match &viewer {
                        Some(v) => v["access"]["state"]
                            .as_str()
                            .unwrap_or("waitlist")
                            .to_string(),
                        None => "active".to_string(),
                    };
                    let viewer=viewer.unwrap_or_else(||json!({
                        "userId":user_id,"email":"owner@localhost","platformAdmin":false,
                        "workspace":{"workspaceId":workspace_id,"name":"Моя работа","kind":"personal","role":"owner"},
                        "workspaces":[]
                    }));
                    let workspace = viewer
                        .get("workspace")
                        .cloned()
                        .unwrap_or_else(|| json!({}));
                    let access = UiAccess {
                        user_id,
                        workspace_id,
                        role: workspace
                            .get("role")
                            .and_then(Value::as_str)
                            .unwrap_or("member")
                            .to_string(),
                        kind: workspace
                            .get("kind")
                            .and_then(Value::as_str)
                            .unwrap_or("personal")
                            .to_string(),
                        access_state,
                        viewer,
                        ui_scope: None,
                    };
                    let access = match ui_scope {
                        Some(scope) => access.with_scope(scope),
                        None => access,
                    };
                    self.ui_access.insert(conn, access);
                    let snap = self.snapshot_for(conn);
                    self.send_to(conn, &snap);
                    self.send_session_reads(conn);
                }
            }
            HubCmd::AgentMsg { conn, text } => {
                if !self.conns.contains_key(&conn) {
                    return;
                }
                match serde_json::from_str::<Value>(&text) {
                    Ok(v) => self.on_agent_msg(conn, v),
                    // Said out loud: a frame the hub cannot parse used to vanish
                    // without a trace. One lone UTF-16 surrogate in a session
                    // title is enough (serde_json refuses it), and since the
                    // inventory is ONE frame, a whole machine's session list
                    // would silently stop updating (27.09.2026 review).
                    Err(e) => eprintln!(
                        "[hub] dropped an unparseable agent frame ({} bytes) from conn {conn}: {e}",
                        text.len()
                    ),
                }
            }
            HubCmd::UiMsg { conn, text } => {
                if !self.conns.contains_key(&conn) {
                    return;
                }
                if let Ok(v) = serde_json::from_str::<Value>(&text) {
                    self.on_ui_msg(conn, v);
                }
                // A reply is what is sent WHILE handling the message; anything
                // later is news for every pane on that socket.
                self.reply_ref = None;
            }
            HubCmd::Disconnected { conn } => self.on_disconnect(conn),
            HubCmd::RemoveStaleAgent { conn, machine_id } => {
                self.remove_stale_agent(conn, machine_id)
            }
            HubCmd::ReleaseOrphanedRuns { conn, machine_id } => {
                self.release_orphaned_runs(conn, &machine_id)
            }
            HubCmd::EnrichCompleted {
                conn,
                machine_id,
                session_id,
                key,
                frame,
            } => {
                if self.ui_can_view_session(conn, &machine_id, &session_id, None) {
                    if frame["ok"] == true {
                        self.enrich_cache_store(key, frame["enrichment"].clone());
                    }
                    self.send_to(conn, &frame);
                }
            }
            HubCmd::PrunePushToken {
                token,
                invalidated_at_ms,
            } => {
                let should_remove = self
                    .push_devices
                    .get(&token)
                    .is_some_and(|(registered, _)| {
                        invalidated_at_ms.is_none_or(|cutoff| *registered <= cutoff)
                    });
                if should_remove {
                    self.push_devices.remove(&token);
                    println!("[notify] pruned rejected mobile device token");
                }
            }
            HubCmd::LiveSent {
                user_id,
                kind,
                results,
            } => self.live_sent(&user_id, kind, &results),
            HubCmd::PushSummary {
                event,
                since,
                summary,
                replies,
            } => self.push_summary_ready(*event, since, summary, replies),
            HubCmd::PushAction { req, reply } => {
                let _ = reply.send(self.handle_push_action(*req));
            }
            HubCmd::WatchInbox { user_id, reply } => {
                let _ = reply.send(self.handle_watch_inbox(&user_id));
            }
            HubCmd::WatchHistory {
                user_id,
                machine_id,
                session_id,
                source,
                limit,
                reply,
            } => {
                let _ = reply.send(self.handle_watch_history(
                    &user_id,
                    &machine_id,
                    &session_id,
                    source.as_deref(),
                    limit,
                ));
            }
            HubCmd::WatchSessionReply {
                user_id,
                machine_id,
                session_id,
                source,
                text,
                reply,
            } => {
                let _ = reply.send(self.handle_watch_session_reply(
                    &user_id,
                    &machine_id,
                    &session_id,
                    source.as_deref(),
                    text.as_deref(),
                ));
            }
            HubCmd::LiveActivity { user_id, op, reply } => {
                let _ = reply.send(self.handle_live_activity(&user_id, op));
            }
            HubCmd::SpawnForOwner {
                machine_id,
                cwd,
                message,
                category,
                permission_mode,
                owner_user_id,
                owner_name,
                reply,
            } => {
                let result = self.spawn_session(SpawnSpec {
                    sealed: None,
                    machine_id,
                    cwd,
                    message: Some(message),
                    images: None,
                    files: None,
                    category,
                    source: Some("codex".into()),
                    require_gateway: true,
                    permission_mode,
                    // The intake cares about the MODE (plan), not about which
                    // model spends the owner's quota on a spec they filed.
                    model: None,
                    effort: None,
                    owner_user_id: Some(owner_user_id),
                    owner_name,
                    origin: Some("backend-request".into()),
                    attach: None,
                    run_by: None,
                });
                let _ = reply.send(result);
            }
            HubCmd::RequestAccountDeletion {
                user_id,
                transfers,
                receipt,
                reply,
            } => {
                let result = self
                    .workspaces
                    .request_account_deletion_with_receipt(&user_id, &transfers, &receipt);
                if result.is_ok() {
                    self.clear_enrichment_cache();
                    self.erased_sessions = self.workspaces.erased_session_keys().ok();
                    let owned: Vec<_> = self
                        .runs
                        .iter()
                        .filter(|(_, r)| {
                            !r.session_id.is_empty()
                                && (r.owner_user_id.as_deref() == Some(&user_id)
                                    || self.session_erased(&r.machine_id, &r.session_id))
                        })
                        .map(|(id, r)| (id.clone(), r.machine_id.clone()))
                        .collect();
                    for (id, machine) in owned {
                        self.send_to_agent(&machine, &json!({"type":"close","runId":id}));
                        self.end_run(&id, "account deletion");
                    }
                    self.refresh_workspace_state();
                }
                let _ = reply.send(result);
            }
            HubCmd::EraseAccount { user_id, reply } => {
                let result = self.workspaces.erase_account(&user_id);
                if result.is_ok() {
                    self.clear_enrichment_cache();
                    self.erased_sessions = self.workspaces.erased_session_keys().ok();
                    self.session_meta.retain(|_, m| m.owner_user_id != user_id);
                    self.user_display.remove(&user_id);
                    self.live.forget_user(&user_id);
                    let runs: Vec<_> = self
                        .runs
                        .iter()
                        .filter(|(_, r)| {
                            r.owner_user_id.as_deref() == Some(&user_id)
                                || self.session_erased(&r.machine_id, &r.session_id)
                        })
                        .map(|(id, r)| (id.clone(), r.machine_id.clone()))
                        .collect();
                    for (id, machine) in runs {
                        self.send_to_agent(&machine, &json!({"type":"close","runId":id}));
                        self.end_run(&id, "account erased");
                    }
                    // Outstanding reads/mirrors may still carry old text from
                    // a shared machine. End these streams before publishing.
                    let affected: Vec<_> = self
                        .agents
                        .keys()
                        .filter(|m| {
                            self.erased_sessions.as_ref().is_none_or(|keys| {
                                keys.iter().any(|key| key.starts_with(&format!("{m}::")))
                            })
                        })
                        .cloned()
                        .collect();
                    for machine in affected {
                        self.drop_machine_streams(&machine);
                    }
                    let syncs: Vec<_> = self
                        .pending_replica
                        .iter()
                        .filter(|(_, p)| self.session_erased(&p.machine_id, &p.session_id))
                        .map(|(id, _)| id.clone())
                        .collect();
                    for id in syncs {
                        self.abort_pending_sync(&id, "account erased");
                    }
                    self.refresh_workspace_state();
                }
                let _ = reply.send(result);
            }
            HubCmd::RefreshWorkspaceState => self.refresh_workspace_state(),
            HubCmd::FleetSpawn {
                owner_user_id,
                machine,
                cwd,
                message,
                settings,
                task,
                reply,
            } => {
                let _ = reply.send(self.fleet_spawn(
                    &owner_user_id,
                    &machine,
                    &cwd,
                    &message,
                    &settings,
                    task.as_ref(),
                ));
            }
            HubCmd::FleetSend {
                owner_user_id,
                target,
                message,
                settings,
                task,
                reply,
            } => {
                let _ = reply.send(self.fleet_send(
                    &owner_user_id,
                    &target,
                    &message,
                    &settings,
                    task.as_ref(),
                ));
            }
            HubCmd::FleetTask {
                owner_user_id,
                op,
                reply,
            } => {
                let _ = reply.send(self.fleet_task(&owner_user_id, op));
            }
            HubCmd::FleetStatus {
                owner_user_id,
                target,
                reply,
            } => {
                let _ = reply.send(self.fleet_status(&owner_user_id, &target));
            }
            HubCmd::FleetMachines {
                owner_user_id,
                reply,
            } => {
                let _ = reply.send(self.fleet_machines(&owner_user_id));
            }
            HubCmd::OnlineAgents { reply } => {
                let online = self
                    .agents
                    .keys()
                    .filter(|id| self.agent_online(id))
                    .cloned()
                    .collect();
                let _ = reply.send(online);
            }
            HubCmd::ServiceMkdir {
                machine_id,
                cwd,
                path,
                reply,
            } => self.service_mkdir(machine_id, cwd, path, reply),
            HubCmd::ReapIdleRuns => {
                self.expire_closing_writers();
                self.reap_idle_runs();
                self.purge_expired_transcripts();
            }
            HubCmd::UndoSignIn {
                user_id,
                since_ms,
                live_tokens,
            } => {
                self.push_devices.retain(|_, (registered, owner)| {
                    !(*owner == user_id && *registered >= since_ms)
                });
                for token in &live_tokens {
                    self.live.forget_token(token);
                }
            }
            HubCmd::SweepUiPasses => {
                self.sweep_support_grants();
                self.drop_dead_passes();
            }
            HubCmd::SweepSupport => {
                if self.workspaces.support_any() {
                    self.sweep_support_grants();
                }
            }
            HubCmd::HistoryDeadline { request_id } => self.history_deadline(&request_id),
            HubCmd::FlushSnapshot => self.flush_snapshot(),
            HubCmd::TitleTick => self.title_tick(),
            HubCmd::TitleGenerated {
                machine_id,
                source,
                session_id,
                basis_count,
                outcome,
            } => self.title_generated(&machine_id, &source, &session_id, basis_count, outcome),
            HubCmd::CoalesceTick => self.coalesce_tick(),
        }
    }

    /// Close every run that has been idle past `IDLE_RUN_TTL_MS` with no client
    /// attached. The agent is told to close so its CLI process ends too, and
    /// `release_run` frees the session's single-writer lock.
    fn reap_idle_runs(&mut self) {
        let now = now_ms();
        let stale: Vec<(String, String)> = self
            .runs
            .iter()
            .filter(|(_, r)| {
                r.state == "idle" && r.browsers.is_empty() && now - r.since >= IDLE_RUN_TTL_MS
            })
            .map(|(run_id, r)| (run_id.clone(), r.machine_id.clone()))
            .collect();
        if stale.is_empty() {
            return;
        }
        println!(
            "[hub] reaping {} idle run(s) nobody is watching",
            stale.len()
        );
        for (run_id, machine_id) in stale {
            self.send_to_agent(&machine_id, &json!({"type":"close","runId":run_id}));
            // The filter above already requires `browsers.is_empty()`, so this
            // tells nobody today. It goes through `end_run` anyway so that the
            // reaper cannot become the next silent killer if that condition is
            // ever loosened — the bug this whole change is about was exactly a
            // close path that forgot to speak.
            self.end_run(&run_id, "closed after six idle hours with nobody watching");
        }
        self.broadcast_activity();
    }

    fn refresh_workspace_state(&mut self) {
        self.push_devices
            .retain(|_, (_, user)| self.workspaces.is_active(user));
        let revoked: Vec<String> = self
            .agents
            .keys()
            .filter(|machine| {
                self.workspaces
                    .device_owner(machine)
                    .ok()
                    .flatten()
                    .is_none()
            })
            .cloned()
            .collect();
        for machine in revoked {
            if let Some(conn) = self.agents.get(&machine).map(|a| a.conn) {
                self.on_disconnect(conn);
                self.agents.remove(&machine);
            }
            self.release_machine_runs(&machine, "device revoked");
            self.drop_machine_streams(&machine);
        }
        let current: Vec<(ConnId, String, String, bool, Option<UiScope>)> = self
            .ui_access
            .iter()
            .map(|(conn, a)| {
                (
                    *conn,
                    a.user_id.clone(),
                    a.workspace_id.clone(),
                    a.viewer
                        .get("platformAdmin")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    a.ui_scope.clone(),
                )
            })
            .collect();
        // A socket whose sign-in was ended (a revoked device, «выйти везде»)
        // goes now, not at its next reconnect — ending a stolen session has to
        // end what the thief already has open.
        // A lookup that fails counts as alive (a transient database fault must
        // not sign everyone out) but is reported once per sweep, not per socket.
        let mut alive_error: Option<String> = None;
        let ended: Vec<ConnId> = self
            .ui_sessions
            .iter()
            .filter(
                |(_, session)| match self.workspaces.session_alive(session) {
                    Ok(alive) => !alive,
                    Err(e) => {
                        alive_error.get_or_insert(e);
                        false
                    }
                },
            )
            .map(|(conn, _)| *conn)
            .collect();
        if let Some(e) = alive_error {
            eprintln!("[hub] session_alive failed: {e}");
        }
        for conn in &ended {
            println!("[hub] closing /ui conn {conn}: its sign-in session was ended");
            self.on_disconnect(*conn);
        }
        for (conn, user, workspace, admin, scope) in current {
            if ended.contains(&conn) {
                continue;
            }
            // A connection on a service UI pass is re-derived INSIDE its fence:
            // still in the key's workspace and active —
            // otherwise the socket goes, like a revoked sign-in.
            match self
                .workspaces
                .ui_access(&user, Some(&workspace), admin)
                .map(|fresh| self.keep_scope(scope.as_ref(), fresh))
            {
                Ok(Some(access)) => {
                    self.ui_access.insert(conn, access);
                }
                Ok(None) | Err(_) => {
                    self.on_disconnect(conn);
                }
            }
        }
        self.revalidate_subscriptions();
        // Rights moved: NOT coalesced. A viewer that just lost a machine or a
        // session must not keep seeing it for a window.
        self.broadcast_snapshot_now();
    }

    /// Rights are checked when a socket subscribes to a run or opens a mirror,
    /// and the stream then flows without asking again. When the ACL changes — a
    /// person taken off a restricted share, a share withdrawn, a role changed —
    /// whatever they already hold open is closed here, so revoking access
    /// takes effect on live connections and not only at the next reconnect.
    fn revalidate_subscriptions(&mut self) {
        let mut detach: Vec<(String, ConnId)> = Vec::new();
        for (run_id, run) in &self.runs {
            for b in &run.browsers {
                if !self.ui_can_see_run(*b, run) {
                    detach.push((run_id.clone(), *b));
                }
            }
        }
        for (run_id, conn) in detach {
            if let Some(run) = self.runs.get_mut(&run_id) {
                run.browsers.remove(&conn);
            }
            self.send_to(
                conn,
                &json!({"type":"error","code":"access_revoked","message":"Session access denied."}),
            );
        }
        let closed: Vec<String> = self
            .mirrors
            .iter()
            .filter(|(id, (conn, machine))| {
                self.mirror_sessions
                    .get(*id)
                    .is_some_and(|(session_id, cwd)| {
                        !self.ui_can_view_session(*conn, machine, session_id, cwd.as_deref())
                    })
            })
            .map(|(id, _)| id.clone())
            .collect();
        for mirror_id in closed {
            self.mirror_sessions.remove(&mirror_id);
            if let Some((browser, machine_id)) = self.mirrors.remove(&mirror_id) {
                self.send_to_agent(
                    &machine_id,
                    &json!({"type":"mirror_close","mirrorId":mirror_id}),
                );
                self.send_to(browser, &json!({"type":"mirror_exit","mirrorId":mirror_id}));
            }
        }
        let live = &self.mirrors;
        self.mirror_sessions.retain(|id, _| live.contains_key(id));
    }

    fn send_to(&self, conn: ConnId, v: &Value) {
        if let Some((to, r)) = &self.reply_ref {
            if *to == conn && v.is_object() && v.get("ref").is_none() {
                let mut tagged = v.clone();
                tagged["ref"] = json!(r);
                return self.send_to_untagged(conn, &tagged);
            }
        }
        self.send_to_untagged(conn, v);
    }

    fn send_to_untagged(&self, conn: ConnId, v: &Value) {
        if self.conns.contains_key(&conn) {
            // A paused (backgrounded) UI conn asked for silence, and `resume`
            // re-syncs it from a fresh snapshot — but one that asked for them
            // (`acks`) still gets the few small frames that ANSWER what it
            // asked for. `resume` re-syncs
            // lists, not acks: a window hidden right after «Начать сессию» lost
            // `opened` and `session_started`, and its pane never learned its
            // run or its session — the answer went to nobody and the next send
            // bounced with `run_active` (20.10.2026).
            let ty = v.get("type").and_then(Value::as_str);
            if self.pause_gate_blocks(conn, ty.unwrap_or("")) {
                return;
            }
            // A snapshot carries its own activity board, so what this conn was
            // last sent as `activity` is no longer what it holds.
            if ty == Some("snapshot") {
                self.activity_sent.borrow_mut().remove(&conn);
            }
            // Strip null envelope/display fields: the web zod schemas treat
            // optional fields as `T | absent`, not `T | null`. Data payloads
            // (input/params/result/raw) are preserved verbatim.
            self.send_raw(conn, clean(v).to_string());
        }
    }

    /// Would a frame of this type be swallowed by the conn's `pause`? Asked
    /// BEFORE building an expensive broadcast payload, not only at the send.
    fn pause_gate_blocks(&self, conn: ConnId, ty: &str) -> bool {
        self.ui_paused.contains(&conn) && !(self.ui_paused_acks.contains(&conn) && passes_pause(ty))
    }

    fn send_raw(&self, conn: ConnId, s: String) {
        if let Some(tx) = self.conns.get(&conn) {
            // The byte budget (UI sockets only — see `OUT_BYTES_CAP`). Checked
            // first so an over-budget frame is not queued behind a backlog the
            // peer is already failing to drain.
            let over_budget = self.ui_clients.contains(&conn)
                && self
                    .out_gates
                    .get(&conn)
                    .is_some_and(|gate| !gate.reserve(s.len()));
            if over_budget {
                println!(
                    "[hub] conn {conn} outbound over {OUT_BYTES_CAP} bytes — dropping slow peer"
                );
                if let Some(gate) = self.out_gates.get(&conn) {
                    gate.mark_dropped();
                }
                let _ = self.self_tx.send(HubCmd::Disconnected { conn });
                return;
            }
            let len = s.len();
            match tx.try_send(s) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) => {
                    // The peer can't keep up (a stalled link). Drop the frame and
                    // schedule a clean disconnect — it reconnects and re-syncs
                    // from a fresh snapshot. Beats buffering without bound, which
                    // is what unbounded channels did here before.
                    if let Some(gate) = self.out_gates.get(&conn) {
                        gate.drained(len);
                        gate.mark_dropped();
                    }
                    println!(
                        "[hub] conn {conn} outbound full ({OUT_CHANNEL_CAP}) — dropping slow peer"
                    );
                    let _ = self.self_tx.send(HubCmd::Disconnected { conn });
                }
                Err(TrySendError::Closed(_)) => {
                    if let Some(gate) = self.out_gates.get(&conn) {
                        gate.drained(len);
                    }
                }
            }
        }
    }

    /// Keep a compact sample of the machine owner's subscription limits for
    /// the «Расходы» view. Best effort: a failure here never touches the
    /// live meter.
    fn sample_subscription(&self, machine_id: &str, provider: &str, usage: &Value) {
        let Ok(Some(owner)) = self.workspaces.device_owner(machine_id) else {
            return;
        };
        // A connected device of a suspended or erased person keeps no data.
        if !self.workspaces.is_active(&owner) {
            return;
        }
        if let Err(e) = crate::llm_usage::record_subscription_sample(
            &self.workspaces,
            &owner,
            machine_id,
            provider,
            usage,
            crate::workspace::now_ms(),
        ) {
            println!("[hub] subscription sample not kept: {e}");
        }
    }

    fn broadcast_machine_private(&self, machine_id: &str, v: &Value) {
        self.broadcast_machine_private_to(machine_id, v, |_| true);
    }

    /// `broadcast_machine_private`, to the controlling viewers `wanted` names.
    /// `wanted` is asked first and is cheap; the rights lookup follows.
    fn broadcast_machine_private_to(
        &self,
        machine_id: &str,
        v: &Value,
        wanted: impl Fn(ConnId) -> bool,
    ) {
        for conn in &self.ui_clients {
            if !wanted(*conn) {
                continue;
            }
            let allowed = self
                .ui_access
                .get(conn)
                .and_then(|access| self.workspaces.machine_access(access, machine_id).ok())
                .is_some_and(|a| a.can_control);
            if allowed {
                self.send_to(*conn, v);
            }
        }
    }

    /// Does this viewer get `machine_stats` right now? A client that did not
    /// announce `statsOnDemand` always does (the old behaviour); one that did
    /// only while its last `stats_interest` said `on`.
    fn wants_machine_stats(&self, conn: ConnId) -> bool {
        match self.ui_caps.get(&conn) {
            Some(caps) if caps.contains(CAP_STATS_ON_DEMAND) => {
                self.ui_stats_interest.contains(&conn)
            }
            _ => true,
        }
    }

    /// `stats_interest {on}`. On a transition to `on` the viewer is told the
    /// last stored sample of every machine it controls at once, so the screen
    /// does not wait up to 30 s for the next agent sample.
    fn ui_stats_interest_msg(&mut self, conn: ConnId, v: &Value) {
        let announced = self
            .ui_caps
            .get(&conn)
            .is_some_and(|caps| caps.contains(CAP_STATS_ON_DEMAND));
        let Some(on) = v.get("on").and_then(Value::as_bool) else {
            return;
        };
        // Without the cap the stream was never gated, so there is nothing to
        // switch — and nothing to replay (the viewer already has every sample).
        if !announced {
            return;
        }
        if !on {
            self.ui_stats_interest.remove(&conn);
            return;
        }
        if !self.ui_stats_interest.insert(conn) {
            return;
        }
        let samples: Vec<(String, Value)> = self
            .agents
            .iter()
            .filter(|(_, a)| a.stats.is_object())
            .map(|(id, a)| (id.clone(), a.stats.clone()))
            .collect();
        // Worked out once for this socket, not per machine.
        let team_ids: HashSet<String> = self
            .ui_access
            .get(&conn)
            .filter(|a| a.kind == "organization" && a.role != "member")
            .and_then(|a| self.workspaces.team_hardware_machine_ids(a).ok())
            .unwrap_or_default()
            .into_iter()
            .collect();
        for (machine_id, stats) in samples {
            if self.ui_can_control_machine(conn, &machine_id) {
                self.send_to(
                    conn,
                    &json!({ "type": "machine_stats", "machineId": machine_id, "stats": stats }),
                );
            } else if let Some(team) = team_stats(&stats) {
                if team_ids.contains(&machine_id) {
                    self.send_to(
                        conn,
                        &json!({ "type": "machine_stats", "machineId": machine_id, "stats": team }),
                    );
                }
            }
        }
    }

    /// Re-derive one connection's cached rights from the database NOW. A change
    /// of membership, role or access commits before the hub's refresh is
    /// processed; an agent's late answer must be judged by what is true, not by
    /// what was true when the socket opened. A person who is gone, or whose
    /// selected workspace is no longer theirs, loses the entry (and with it
    /// every answer owed to them).
    ///
    /// `false` = the answer must not go out: the person is gone, or the lookup
    /// itself failed (the cached entry is then KEPT, so a later refresh can
    /// recover the socket; only this delivery is denied).
    fn refresh_ui_access_now(&mut self, conn: ConnId) -> bool {
        if !self.ui_access.contains_key(&conn) {
            return false;
        }
        // The sign-in behind the socket first: a session ended meanwhile (a
        // service-minted one outgrown, «выйти везде») ends the delivery too.
        let alive = self
            .ui_sessions
            .get(&conn)
            .map(|session| self.workspaces.session_alive(session));
        match alive {
            None | Some(Ok(true)) => {}
            Some(Ok(false)) => {
                self.revoke_ui_access(conn);
                return false;
            }
            Some(Err(_)) => return false,
        }
        let Some(old) = self.ui_access.get(&conn) else {
            return false;
        };
        let admin = old
            .viewer
            .get("platformAdmin")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let workspace = old.workspace_id.clone();
        let scope = old.ui_scope.clone();
        match self
            .workspaces
            .ui_access(&old.user_id, Some(&workspace), admin)
        {
            Ok(fresh) if fresh.workspace_id == workspace => {
                let Some(fresh) = self.keep_scope(scope.as_ref(), fresh) else {
                    self.revoke_ui_access(conn);
                    return false;
                };
                self.ui_access.insert(conn, fresh);
                true
            }
            // Definitively not theirs any more (the workspace they were in is
            // gone, or they left it).
            Ok(_) => {
                self.revoke_ui_access(conn);
                false
            }
            // Could not tell.
            Err(_) => false,
        }
    }

    /// A connection that definitively lost its rights. An ordinary one just
    /// loses its cached access (every answer owed to it is then denied). A
    /// connection on a service UI pass is CLOSED: leaving the socket open
    /// without an entry would take it out of every pass check and whitelist
    /// (`is_scoped` reads the entry) while it kept its run subscriptions.
    fn revoke_ui_access(&mut self, conn: ConnId) {
        if self.is_scoped(conn) {
            println!("[hub] closing /ui conn {conn}: its UI pass no longer holds");
            self.on_disconnect(conn);
        } else {
            self.ui_access.remove(&conn);
        }
    }

    /// A freshly derived `UiAccess`, put back inside the fence of the
    /// connection it replaces. Without a scope it passes untouched. With one it
    /// must still be the key's workspace, active, and its person still hold the
    /// pass (a member of that workspace —
    /// `ui_scope_holds`); a failed lookup counts as not holding, so the socket
    /// is dropped and reconnects rather than keep rights nobody could confirm.
    fn keep_scope(&self, scope: Option<&UiScope>, fresh: UiAccess) -> Option<UiAccess> {
        let Some(scope) = scope else {
            return Some(fresh);
        };
        let holds = fresh.workspace_id == scope.workspace_id
            && fresh.is_active()
            && self
                .workspaces
                .ui_scope_holds(&fresh.user_id, &scope.workspace_id)
                .unwrap_or(false);
        holds.then(|| fresh.with_scope(scope.clone()))
    }

    /// A person's deletion of this session has finished (tombstoned in the
    /// catalog) or is under way right now (an agent call this hub is waiting
    /// on). A transcript is not served in either case.
    fn session_deletion_in_flight_or_done(&self, machine_id: &str, session_id: &str) -> bool {
        self.store.is_deleted_by_user(machine_id, session_id)
            || self
                .pending_rpc
                .values()
                .any(|p| p.machine_id == machine_id && p.deleting.as_deref() == Some(session_id))
    }

    /// Is the asker of a transcript or file read still entitled to the answer?
    /// Active, and — unless they control the machine — the session still
    /// viewable / the folder still readable by their CURRENT rights. Calls that
    /// mutate carry no payload worth withholding and are not judged here.
    fn pending_still_authorized(&self, p: &PendingRpc) -> bool {
        // Nothing at all goes to a person who is no longer active (suspended,
        // erased) — acknowledgements included.
        let Some(access) = self.ui_access.get(&p.conn) else {
            return false;
        };
        if !access.is_active() {
            return false;
        }
        // Past that, answers of two kinds. What a member of a share may call
        // and that changes something (mkdir, rename, delete…) is reported as it
        // happened: turning its success into a refusal would invite a retry.
        // Everything else the viewer asked for needs its right NOW: file and
        // transcript reads by the checks below, every other call (project and
        // process lists, git, sync, runtime…) by still controlling the machine.
        let payload = matches!(
            p.method.as_str(),
            "session.messages"
                | "session.image"
                | "session.subagent"
                | "fs.list"
                | "fs.read"
                | "fs.download"
                | "fs.peek"
                | "commands.list"
                | "models.list"
        );
        if !payload
            && matches!(
                p.method.as_str(),
                "session.rename"
                    | "run.stopSubagent"
                    | "session.delete"
                    | "fs.mkdir"
                    | "fs.upload.begin"
                    | "fs.upload.chunk"
                    | "fs.upload.commit"
                    | "fs.upload.abort"
            )
        {
            return true;
        }
        let Ok(machine) = self.workspaces.machine_access(access, &p.machine_id) else {
            return false;
        };
        if !payload {
            return machine.can_control;
        }
        // A transcript of a session that was deleted or erased while the agent
        // was reading it goes to nobody — controllers of the machine included.
        // So does one the hub knew when it was asked for and has since let go of
        // (a sync policy or the retention purge removed its record).
        if matches!(
            p.method.as_str(),
            "session.messages" | "session.image" | "session.subagent"
        ) && (self.session_erased(&p.machine_id, &p.session_id)
            || self.session_deletion_in_flight_or_done(&p.machine_id, &p.session_id)
            || (p.placed && self.session_cwd(&p.machine_id, &p.session_id).is_none()))
        {
            return false;
        }
        if machine.can_control {
            return true;
        }
        match p.method.as_str() {
            "session.messages" | "session.image" | "session.subagent" => {
                self.ui_can_view_session(p.conn, &p.machine_id, &p.session_id, p.cwd.as_deref())
            }
            // Command and skill names of a folder, or of a live run's session.
            // What models the machine offers: for whoever may still start there.
            "models.list" => machine.can_start,
            // (Both authorities when both are named: the agent prefers the
            // live run's session over the folder.)
            "commands.list" => {
                p.cwd
                    .as_deref()
                    .is_none_or(|cwd| machine.allows_read_path(cwd))
                    && (!(p.cwd.is_none() || !p.session_id.is_empty())
                        || self.ui_can_work_in(p.conn, &p.machine_id, &p.session_id, None))
            }
            "fs.list" | "fs.read" | "fs.download" | "fs.peek" => {
                p.cwd
                    .as_deref()
                    .is_some_and(|cwd| machine.allows_read_path(cwd))
                    && p.touched
                        .as_deref()
                        .is_some_and(|touched| machine.allows_read_path(touched))
            }
            _ => true,
        }
    }

    /// `HubCmd::ServiceMkdir`: one recursive `fs.mkdir` under `cwd`, sent to the
    /// agent as the device owner's own request (the folder is made with the
    /// owner's rights, like every other file RPC).
    fn service_mkdir(
        &mut self,
        machine_id: String,
        cwd: String,
        path: String,
        reply: tokio::sync::oneshot::Sender<Option<tokio::sync::oneshot::Receiver<bool>>>,
    ) {
        if !self.agent_online(&machine_id) {
            let _ = reply.send(None);
            return;
        }
        // Callers that timed out dropped their receiver; do not keep those.
        self.service_rpc.retain(|_, (_, tx)| !tx.is_closed());
        let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
        let request_id = format!("svc-{}", uuid::Uuid::new_v4());
        self.service_rpc
            .insert(request_id.clone(), (machine_id.clone(), tx));
        let _ = reply.send(Some(rx));
        self.send_to_agent(
            &machine_id,
            &json!({
                "type":message::RPC_REQUEST,
                "requestId":request_id,
                "method":"fs.mkdir",
                "params":{"cwd":cwd,"path":path,"recursive":true},
            }),
        );
    }

    /// A machine is usable only while its agent entry has a live socket. During
    /// the reconnect grace window the entry survives without one — commands sent
    /// then would silently vanish, so callers must refuse instead.
    fn agent_online(&self, machine_id: &str) -> bool {
        self.agents
            .get(machine_id)
            .map(|a| self.conns.contains_key(&a.conn))
            .unwrap_or(false)
    }

    /// Does this machine offer `bypassPermissions` — a session that never stops
    /// to ask — to a client picking a mode at start?
    ///
    /// The answer is the agent's own `MachineInfo.permissionModes`, and the
    /// default when the field is ABSENT is `false`. That asymmetry is
    /// deliberate and matches the field's own doc: an agent too old to publish
    /// the list has also never said it withholds anything, and reading silence
    /// as consent would run a machine without approvals on the strength of a
    /// message it never sent.
    ///
    /// Asked PER RUNTIME. One box runs both, and the two gates answer to
    /// different things — the Claude list is decided by a PreToolUse hook that
    /// does not exist on the Codex path. A single list let a client start a
    /// Codex session in `bypassPermissions` on a machine that had only ever
    /// offered it for Claude, which is the Codex door opening where the Claude
    /// door is shut.
    fn machine_offers_bypass(&self, machine_id: &str, source: Option<&str>) -> bool {
        let field = if source == Some("codex") {
            "codexPermissionModes"
        } else {
            "permissionModes"
        };
        self.agents
            .get(machine_id)
            .and_then(|a| a.machine.get(field))
            .and_then(Value::as_array)
            .is_some_and(|modes| {
                modes
                    .iter()
                    .any(|m| m.as_str() == Some("bypassPermissions"))
            })
    }

    /// Whether this socket is the one currently representing its machine. A
    /// reconnect supersedes the old socket, and only the winner may drive runs.
    fn is_current_agent_conn(&self, conn: ConnId) -> bool {
        self.conn_machine
            .get(&conn)
            .and_then(|machine_id| self.agents.get(machine_id))
            .is_some_and(|a| a.conn == conn)
    }

    fn send_to_agent(&self, machine_id: &str, v: &Value) {
        if let Some(a) = self.agents.get(machine_id) {
            self.send_to(a.conn, v);
        }
    }

    // ------------------------------------------------------------- agent in
    /// Whether `conn` (an agent socket) is the machine a pending exchange was
    /// addressed to. `None` — nothing is pending under that id — is `true`,
    /// so the caller's own "unknown id" path stays as it was.
    fn reply_from_target(&self, conn: ConnId, target: Option<&str>) -> bool {
        match target {
            None => true,
            Some(machine) => self.conn_machine.get(&conn).map(String::as_str) == Some(machine),
        }
    }

    fn on_agent_msg(&mut self, conn: ConnId, v: Value) {
        // Nothing an agent says is a reply to a pane (see `reply_ref`).
        self.reply_ref = None;
        let Some(ty) = v.field_str("type") else {
            return;
        };
        if self.route_agent_run_message(conn, ty, &v) {
            return;
        }
        match ty {
            "register" => {
                let machine = v.get("machine").cloned().unwrap_or(Value::Null);
                let id = machine
                    .get("machineId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if id.is_empty() {
                    return;
                }
                let (owner_user_id, authorized_machine) = self
                    .agent_users
                    .get(&conn)
                    .cloned()
                    .unwrap_or_else(|| (self.bootstrap_user_id.clone(), None));
                if authorized_machine
                    .as_deref()
                    .is_some_and(|expected| !expected.is_empty() && expected != id)
                {
                    self.send_to(conn,&json!({"type":"error","message":"device credential does not match machineId"}));
                    self.conns.remove(&conn);
                    return;
                }
                // The shared fleet token (an empty authorized machine = "any")
                // may be pinned to a list of machine ids. A box outside the list
                // is turned away here, where its id is first known.
                let on_fleet_token = authorized_machine.as_deref() == Some("");
                if on_fleet_token
                    && self
                        .fleet_machine_ids
                        .as_ref()
                        .is_some_and(|allowed| !allowed.contains(&id))
                {
                    println!(
                        "[hub] refusing fleet-token registration from {id}: not in CC_REMOTE_FLEET_MACHINE_IDS"
                    );
                    self.send_to(
                        conn,
                        &json!({"type":"error","message":"This machine may not use the fleet token. Enroll it with a device code."}),
                    );
                    self.conns.remove(&conn);
                    return;
                }
                // The fleet token may only speak for the bootstrap owner's own,
                // non-enrolled boxes (workspace.rs `fleet_token_may_register`).
                // Fails CLOSED: a database error is not a reason to let a shared
                // secret take over somebody's machine.
                if on_fleet_token {
                    let allowed = match self
                        .workspaces
                        .fleet_token_may_register(&id, &self.bootstrap_user_id)
                    {
                        Ok(v) => v,
                        Err(e) => {
                            eprintln!("[hub] fleet-token ownership check failed for {id}: {e}");
                            self.send_to(
                                conn,
                                &json!({"type":"error","message":"The hub could not check this machine's ownership; retrying."}),
                            );
                            self.conns.remove(&conn);
                            return;
                        }
                    };
                    if !allowed {
                        println!(
                            "[hub] refusing fleet-token registration from {id}: the machine is enrolled or owned by another account"
                        );
                        self.send_to(
                            conn,
                            &json!({"type":"error","message":"This machine has its own device credential or owner; the fleet token cannot register it."}),
                        );
                        self.conns.remove(&conn);
                        return;
                    }
                }
                // A revoked device is turned away here, not merely hidden. The
                // fleet token carries no device identity, so this is the first
                // point where we know WHICH machine is calling — and until this
                // check existed a revoked agent reconnected for hours, logged as
                // registered, and only vanished from the UI.
                match self.workspaces.device_revoked(&id) {
                    Ok(true) => {
                        println!("[hub] refusing revoked device: {id}");
                        self.send_to(
                            conn,
                            &json!({"type":"error","message":"This device has been revoked. Re-enroll it to reconnect."}),
                        );
                        self.conns.remove(&conn);
                        return;
                    }
                    Ok(false) => {}
                    Err(e) => eprintln!("[hub] device revocation check failed for {id}: {e}"),
                }
                if let Err(e) = self.workspaces.touch_device(&machine, &owner_user_id) {
                    eprintln!("[hub] device ownership upsert failed for {id}: {e}");
                    self.conns.remove(&conn);
                    return;
                }
                let name = machine
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                println!("[hub] agent registered: {name} ({id})");
                // Runs the agent carried across the blip. Settle them BEFORE the
                // agent entry is replaced below, so a run this agent no longer
                // has is failed while its viewers can still be told.
                let declared: Vec<DeclaredRun> = v
                    .get("liveRuns")
                    .and_then(Value::as_array)
                    .map(|runs| runs.iter().filter_map(DeclaredRun::parse).collect())
                    .unwrap_or_default();
                // A different process id means the daemon RESTARTED (or a second
                // one shares this machineId). Its predecessor's subprocesses died
                // with it, so nothing may be carried over — ignore the claim.
                let instance = v
                    .get("agentInstanceId")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                // `agentInstanceId` doubles as the capability flag for run
                // carrying: only an agent new enough to send it can understand
                // `register_ack`. Older ones across the fleet would log it as a
                // bad command on every reconnect, so stay quiet for them.
                let carries_runs = instance.is_some();
                let same_process = match (self.agent_instance.get(&id), instance.as_ref()) {
                    (Some(previous), Some(current)) => previous == current,
                    // A legacy agent sends no instance id; fall back to trusting
                    // the declaration, which is what it did before this existed.
                    _ => true,
                };
                if let Some(current) = instance {
                    self.agent_instance.insert(id.clone(), current);
                }
                let declared: Vec<DeclaredRun> = if same_process {
                    declared
                } else {
                    if !declared.is_empty() {
                        println!(
                            "[hub] {id} registered as a new process — ignoring {} carried run(s)",
                            declared.len()
                        );
                    }
                    Vec::new()
                };
                let registered_at = now_ms();
                // A machine that has JUST been marked private still has the
                // plaintext it replicated before: drop every copy now (the
                // same purge retention uses), so it re-uploads sealed.
                // Only a REAL transition of a stored row.
                let now_private = machine.get("private").and_then(Value::as_bool) == Some(true);
                // The other way (private -> off) is a transition too: the replica
                // holds ciphertext the agent would never replace (its cursor
                // matches), so it is purged and the agent's catalog comes back
                // empty - it uploads the transcripts in the clear.
                let was_private = self.store.machine_private_state(&id);
                let purged_for_private = (now_private && was_private == Some(false)
                    || !now_private && was_private == Some(true))
                    // Every real transition purges, no rate limit: the machine is
                    // the owner's own and nobody else's data is touched (a quick
                    // off -> on would otherwise keep what was uploaded while off).
                    && match self.purge_for_transition(&id, registered_at, now_private) {
                        Ok(()) => true,
                        Err(e) => {
                            // Fail closed: registering would let the old plaintext
                            // stay and the agent upload sealed rows beside it. The
                            // agent retries; nothing was changed for this machine.
                            eprintln!("[hub] {id}: refusing the register - could not purge plaintext on becoming private: {e}");
                            self.send_to(
                                conn,
                                &json!({"type":"error","message":"The hub could not clear this machine's stored plaintext yet; retrying."}),
                            );
                            self.conns.remove(&conn);
                            return;
                        }
                    };
                // A private agent declares no folder for its runs (a path is content):
                // adopt them with an empty one rather than closing them.
                let declared: Vec<DeclaredRun> = declared
                    .into_iter()
                    .map(|mut d| {
                        if now_private && d.cwd.is_none() {
                            d.cwd = Some(String::new());
                        }
                        d
                    })
                    .collect();
                self.settle_agent_runs(conn, &id, &name, &declared);
                // Name what survived — declared runs we still hold, which is what
                // `settle_agent_runs` just decided. The agent closes anything it
                // kept that is missing here, and holds its runs on a self-fencing
                // lease until this arrives, so a hub that never answers is safe.
                if carries_runs {
                    let adopted: Vec<&String> = declared
                        .iter()
                        .map(|d| &d.run_id)
                        .filter(|run_id| self.runs.contains_key(*run_id))
                        .collect();
                    self.send_to(
                        conn,
                        &json!({"type":"register_ack","adoptedRunIds": adopted,
                            wire::field::CLAUDE_USAGE_ENABLED: self.claude_usage_enabled(&id)}),
                    );
                }
                if let Err(e) = self.store.record_machine(&machine, registered_at) {
                    eprintln!("[hub] database machine upsert failed for {id}: {e}");
                }
                // Preserve the prior session list across a reconnect so a flaky
                // agent doesn't blink its sessions to 0 until its next inventory.
                let prev_sessions = if purged_for_private {
                    Vec::new()
                } else {
                    self.agents
                        .get(&id)
                        .map(|a| a.sessions.clone())
                        .or_else(|| self.store.sessions_for_machine(&id).ok())
                        .unwrap_or_default()
                };
                let prev_liveness = self
                    .agents
                    .get(&id)
                    .map(|a| a.liveness.clone())
                    .unwrap_or_default();
                // Preserve last-known usage across a reconnect too, so the meter
                // doesn't blank until the next 180s poll.
                let prev_usage = if self.claude_usage_enabled(&id) {
                    self.agents
                        .get(&id)
                        .map(|a| a.usage.clone())
                        .unwrap_or(Value::Null)
                } else {
                    Value::Null
                };
                let prev_codex_usage = self
                    .agents
                    .get(&id)
                    .map(|a| a.codex_usage.clone())
                    .unwrap_or(Value::Null);
                // Likewise the builder profile: the agent only recomputes it every
                // few hours, so keep the last one across a reconnect.
                // A private machine's profile and process list (command lines)
                // are content: whatever the hub still holds is dropped.
                let prev_profile = self
                    .agents
                    .get(&id)
                    .map(|a| a.profile.clone())
                    .filter(|_| !now_private)
                    .unwrap_or(Value::Null);
                let prev_stats = self
                    .agents
                    .get(&id)
                    .map(|a| a.stats.clone())
                    .filter(|_| !now_private)
                    .unwrap_or(Value::Null);
                // Runtimes: the register carries a fresh reading when the agent
                // is new enough; otherwise keep what this machine last said.
                let runtimes = v
                    .get(wire::field::RUNTIMES)
                    .cloned()
                    .filter(Value::is_object)
                    .or_else(|| self.agents.get(&id).map(|a| a.runtimes.clone()))
                    .unwrap_or(Value::Null);
                // A re-register on a new socket supersedes the old one. Runs were
                // already settled above against the agent's own `liveRuns`, so
                // this branch must NOT release them: an agent now keeps driving
                // its sessions across a blip, and blanket-releasing here is what
                // killed live work on every reconnect. Ptys have no such
                // continuity — each belongs to a browser subscriber that is gone.
                if let Some(prev) = self.agents.get(&id) {
                    if prev.conn != conn {
                        let old_conn = prev.conn;
                        println!(
                            "[hub] agent re-register supersedes conn {old_conn}: {name} ({id})"
                        );
                        // A DIFFERENT process now holds this machineId while the
                        // old socket is still live: two daemons, not one daemon
                        // reconnecting. Forgetting the old one is not enough — it
                        // would reconnect, supersede the newcomer in turn, and the
                        // pair would trade the machine back and forth while BOTH
                        // watched and appended the same transcripts. Name it, and
                        // tell the loser to exit. Queued before the Tx is dropped
                        // below, which is what gets it onto the wire.
                        if !same_process {
                            println!(
                                "[hub] two agent processes share {id} — telling the superseded one to stand down"
                            );
                            self.send_to(
                                old_conn,
                                &json!({"type":"agent_superseded","machineId": id}),
                            );
                        }
                        self.drop_machine_streams(&id);
                        self.conn_machine.remove(&old_conn);
                        self.conns.remove(&old_conn); // drops the Tx -> socket task closes
                    }
                }
                let approval_timeout_ms = v
                    .get("approvalTimeoutMs")
                    .and_then(Value::as_i64)
                    .filter(|ms| *ms > 0);
                self.conn_machine.insert(conn, id.clone());
                self.agents.insert(
                    id.clone(),
                    AgentConn {
                        machine,
                        conn,
                        sessions: prev_sessions,
                        liveness: prev_liveness,
                        last_seen: registered_at,
                        usage: prev_usage,
                        codex_usage: prev_codex_usage,
                        profile: prev_profile,
                        stats: prev_stats,
                        runtimes,
                        approval_timeout_ms,
                        // A reconnect must not inherit a fingerprint: this
                        // socket has shown us nothing yet, and its first
                        // inventory has to reach the browsers.
                        inventory_sig: None,
                        inventory_ui_sig: None,
                        published_sessions: HashMap::new(),
                    },
                );
                self.observe_runtimes(&id, true);
                match self.store.catalog(&id) {
                    Ok(sessions) => self.send_to(
                        conn,
                        &json!({"type":"session_sync_catalog","sessions":sessions}),
                    ),
                    Err(e) => eprintln!("[hub] database catalog read failed for {id}: {e}"),
                }
                self.send_memory_catalog(conn, &id);
                // One machine changed (it is online, and what it brought with
                // it) — tell viewers about THAT machine, not the whole fleet.
                // Viewers that take no deltas still get a snapshot, coalesced.
                self.broadcast_machine_entry(std::slice::from_ref(&id));
                self.owe_team_snapshot(&id);
                self.broadcast_activity();
            }
            "inventory" => {
                if let Some(id) = self.conn_machine.get(&conn).cloned() {
                    let mut sessions = v
                        .get("sessions")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    // The hub forwards inventory untyped; a session without a
                    // sessionId would fail the web's zod decode and take the
                    // WHOLE snapshot down for every UI. Drop bad entries here.
                    sessions.retain(|s| s.get("sessionId").and_then(Value::as_str).is_some());
                    sessions.retain(|s| {
                        !self.session_erased(&id, s["sessionId"].as_str().unwrap_or_default())
                    });
                    // Did this inventory actually say anything? Everything a
                    // browser reads out of a snapshot — titles, cwd, stage,
                    // lastModified, livePid — lives in these entries, so an
                    // identical array means an identical snapshot. Taken before
                    // the store write, which is bookkeeping either way.
                    let sig = inventory_fingerprints(&sessions);
                    let ui_sig = inventory_ui_fingerprint(&sessions);
                    let previous = self.agents.get(&id).and_then(|a| a.inventory_sig);
                    // Only the replica cursor (`fileMtime`) differs: replication
                    // and freshness bookkeeping keep it (below), but no viewer
                    // has anything to learn, so nothing is owed to anyone.
                    let cursor_only = !previous.is_some_and(|prev| prev == sig)
                        && self
                            .agents
                            .get(&id)
                            .and_then(|a| a.inventory_ui_sig)
                            .is_some_and(|prev| prev == ui_sig);
                    // Nothing at all moved / only mtimes moved / something a
                    // reader would notice moved.
                    let silent = previous.is_some_and(|prev| prev == sig);
                    let mtime_only = !silent && previous.is_some_and(|prev| prev.1 == sig.1);
                    let seen_at = now_ms();
                    let complete = v.field_bool("complete").unwrap_or(false);
                    if let Err(e) = self
                        .store
                        .record_inventory(&id, &sessions, complete, seen_at)
                    {
                        eprintln!("[hub] database inventory upsert failed for {id}: {e}");
                    }
                    // Liveness comes ONLY from this frame — the catalog below has
                    // it stripped — so capture it before the merge discards it.
                    let liveness = collect_liveness(&sessions);
                    if let Some(a) = self.agents.get_mut(&id) {
                        // Use the durable merged catalog here too. With a capped
                        // inventory the UI can still select an older persisted
                        // session, and open_run must be able to resolve its cwd.
                        a.sessions = self.store.sessions_for_machine(&id).unwrap_or(sessions);
                        if complete {
                            // Authoritative: the frame lists every session, so one
                            // that is missing from it really has no writer.
                            a.liveness = liveness;
                        } else {
                            // Capped frame — only the newest N sessions. Absence is
                            // not evidence of death (an editor can hold a session
                            // that hasn't been touched in days), so merge instead of
                            // replacing and let each session's own entry speak.
                            a.liveness.extend(liveness);
                        }
                        overlay_liveness(&mut a.sessions, &a.liveness);
                        a.last_seen = seen_at;
                        a.inventory_sig = Some(sig);
                        a.inventory_ui_sig = Some(ui_sig);
                    }
                    // The inventory is the first place a brand-new session's real
                    // title appears — adopt it for any run still wearing the
                    // placeholder from `new_session`. Cheap, and it broadcasts
                    // only when a title really moved, so it stays outside the
                    // guard below.
                    self.refresh_run_titles(&id);
                    self.backfill_run_sources(&id);
                    // `last_seen` did move, and it is the one snapshot field
                    // that changes on a silent inventory. Nothing reads it for
                    // an ONLINE machine (the UI shows "online"), and an offline
                    // machine's copy is served from the store — so letting it
                    // go unsent is what buys the silence.
                    if cursor_only {
                        // Nothing a viewer reads moved.
                    } else if mtime_only {
                        self.pending_machines.insert(id.clone());
                    } else if !silent {
                        // One machine moved, so only one machine's list is news.
                        self.broadcast_machine_sessions(std::slice::from_ref(&id));
                    }
                }
            }
            "sync_forget" => self.sync_forget(conn, &v),
            "session_sync_begin" => self.begin_session_sync(conn, &v),
            "session_sync_chunk" => self.session_sync_chunk(conn, &v),
            "session_sync_commit" => self.commit_session_sync(conn, &v),
            "memory_push" => self.memory_push(conn, &v),
            "memory_fetch" => self.memory_fetch(conn, &v),
            "usage" => {
                // Store on the machine and fan a lightweight delta to UIs — no
                // need to rebroadcast the whole session snapshot every 180s.
                if let Some(id) = self.conn_machine.get(&conn).cloned() {
                    // Older agents and a poll already in flight may still send
                    // readings. A pause must not restore a stale quota meter.
                    if !self.claude_usage_enabled(&id) {
                        return;
                    }
                    let usage = v.get("usage").cloned().unwrap_or(Value::Null);
                    if usage.is_object() {
                        // Stored always (snapshots carry the freshest reading);
                        // broadcast only when it says something new.
                        let changed = self
                            .agents
                            .get(&id)
                            .is_some_and(|a| !same_reading(&a.usage, &usage));
                        if let Some(a) = self.agents.get_mut(&id) {
                            a.usage = usage.clone();
                        }
                        self.sample_subscription(&id, "claude", &usage);
                        if changed {
                            self.broadcast_machine_private(
                                &id,
                                &json!({ "type": "usage", "machineId": id, "usage": usage }),
                            );
                        }
                    }
                }
            }
            "codex_usage" => {
                if let Some(id) = self.conn_machine.get(&conn).cloned() {
                    let usage = v.get("usage").cloned().unwrap_or(Value::Null);
                    if usage.is_object() {
                        let changed = self
                            .agents
                            .get(&id)
                            .is_some_and(|a| !same_reading(&a.codex_usage, &usage));
                        if let Some(a) = self.agents.get_mut(&id) {
                            a.codex_usage = usage.clone();
                        }
                        self.sample_subscription(&id, "codex", &usage);
                        if changed {
                            self.broadcast_machine_private(
                                &id,
                                &json!({ "type": "codex_usage", "machineId": id, "usage": usage }),
                            );
                        }
                    }
                }
            }
            "machine_stats" => {
                // Same pattern as usage: store the latest hardware sample on the
                // machine and fan a lightweight delta to controlling UIs.
                if let Some(id) = self.conn_machine.get(&conn).cloned() {
                    let stats = v.get("stats").cloned().unwrap_or(Value::Null);
                    if stats.is_object() {
                        if let Some(a) = self.agents.get_mut(&id) {
                            a.stats = stats.clone();
                        }
                        // Only to viewers showing hardware (`statsOnDemand`);
                        // everyone else keeps the always-on stream.
                        self.broadcast_machine_private_to(
                            &id,
                            &json!({ "type": "machine_stats", "machineId": id, "stats": stats }),
                            |conn| self.wants_machine_stats(conn),
                        );
                        // Team viewers get the same sample without its process list.
                        if let Some(team) = team_stats(&stats) {
                            let msg =
                                json!({ "type": "machine_stats", "machineId": id, "stats": team });
                            for viewer in
                                self.team_viewers_of(&id, |conn| self.wants_machine_stats(conn))
                            {
                                self.send_to(viewer, &msg);
                            }
                        }
                    }
                }
            }
            wire::message::RUNTIME_STATUS => {
                // Same shape as stats: keep the latest reading on the machine
                // and fan a small delta to the UIs that control it. Private for
                // the same reason `usage` is — it names an account.
                if let Some(id) = self.conn_machine.get(&conn).cloned() {
                    let runtimes = v.get(wire::field::RUNTIMES).cloned().unwrap_or(Value::Null);
                    if runtimes.is_object() {
                        if let Some(a) = self.agents.get_mut(&id) {
                            a.runtimes = runtimes.clone();
                        }
                        self.observe_runtimes(&id, false);
                        self.broadcast_machine_private(
                            &id,
                            &json!({ "type": wire::message::RUNTIME_STATUS, "machineId": id, wire::field::RUNTIMES: runtimes }),
                        );
                        if let Some(team) = team_runtimes(&runtimes) {
                            let msg = json!({ "type": wire::message::RUNTIME_STATUS, "machineId": id, wire::field::RUNTIMES: team });
                            for viewer in self.team_viewers_of(&id, |_| true) {
                                self.send_to(viewer, &msg);
                            }
                        }
                    }
                }
            }
            "session_committed" => {
                // A real commit landed in this session (on-machine hook or git.commit
                // RPC). Relay a transient "ready to close" nudge to controlling UIs —
                // not persisted; the Flow card holds it until Done or dismiss.
                if let Some(id) = self.conn_machine.get(&conn).cloned() {
                    let session_id = v.get("sessionId").and_then(Value::as_str).unwrap_or("");
                    if !session_id.is_empty() {
                        self.broadcast_machine_private(
                            &id,
                            &json!({ "type": "session_committed", "machineId": id, "sessionId": session_id }),
                        );
                    }
                }
            }
            "builder_profile" => {
                // Same pattern as usage: store the locally-computed profile on the
                // machine and fan a lightweight delta to UIs.
                if let Some(id) = self.conn_machine.get(&conn).cloned() {
                    let profile = v.get("profile").cloned().unwrap_or(Value::Null);
                    if profile.is_object() {
                        if let Some(a) = self.agents.get_mut(&id) {
                            a.profile = profile.clone();
                        }
                        self.broadcast_machine_private(&id,&json!({ "type": "builder_profile", "machineId": id, "profile": profile }));
                    }
                }
            }
            message::PROJECT_PUSHED => {
                // The project reached its own remote — "took their code home",
                // the signal the community metrics care about most. Owner is
                // whoever started the session, else the device owner; with no
                // owner there is nowhere to file it, so nothing is written.
                let Some(machine_id) = self.conn_machine.get(&conn).cloned() else {
                    return;
                };
                let cwd = v.field_string("cwd").unwrap_or_default();
                let remote_host = v.field_string("remoteHost").unwrap_or_default();
                if cwd.is_empty() {
                    return;
                }
                let owner = v
                    .field_str("sessionId")
                    .and_then(|sid| self.session_owner(&machine_id, sid).map(str::to_string))
                    .or_else(|| self.workspaces.device_owner(&machine_id).ok().flatten());
                let Some(owner) = owner else { return };
                let Some(workspace_id) = self.workspaces.audit_workspace_for(&owner) else {
                    return;
                };
                if let Err(e) = self.workspaces.audit(
                    &workspace_id,
                    &owner,
                    "project.pushed",
                    "project",
                    &cwd,
                    &json!({"cwd": cwd, "remoteHost": remote_host, "machineId": machine_id}),
                ) {
                    eprintln!("[hub] audit project.pushed failed: {e}");
                }
            }
            "rpc_response" => {
                if let Some(req_id) = v.get("requestId").and_then(Value::as_str) {
                    // A folder the service API asked for: answered to its HTTP
                    // caller, and only by the machine it was sent to.
                    if self.service_rpc.contains_key(req_id) {
                        if self.reply_from_target(
                            conn,
                            self.service_rpc.get(req_id).map(|(m, _)| m.as_str()),
                        ) {
                            if let Some((_, reply)) = self.service_rpc.remove(req_id) {
                                let _ =
                                    reply.send(v.get("ok").and_then(Value::as_bool) == Some(true));
                            }
                        }
                        return;
                    }
                    // Only the machine the request went to may answer it. The
                    // id alone is not proof: another agent that learns it (an
                    // audit row, a log) must not be able to answer in its place.
                    if !self.reply_from_target(
                        conn,
                        self.pending_rpc.get(req_id).map(|p| p.machine_id.as_str()),
                    ) {
                        return;
                    }
                    if let Some(pending) = self.pending_rpc.remove(req_id) {
                        self.track_member_upload(&pending, &v);
                        self.audit_project_rpc(&pending, &v);
                        if v.get("ok").and_then(Value::as_bool) != Some(true) {
                            self.undo_pending_delete(&pending);
                        } else if let Some(session_id) = pending.deleting.as_deref() {
                            // Final from this instant: a read that comes next
                            // (or one still in flight) must not find it.
                            if let Err(e) = self
                                .store
                                .confirm_user_deleted(&pending.machine_id, session_id)
                            {
                                eprintln!("[hub] could not tombstone {session_id}: {e}");
                            }
                        }
                        // Rights were checked when the request went out. A read
                        // that has been in flight while the person was taken off
                        // the share does not get its payload.
                        let refreshed = self.refresh_ui_access_now(pending.conn);
                        if !refreshed || !self.pending_still_authorized(&pending) {
                            self.send_to(
                                pending.conn,
                                &json!({"type":"rpc_response","requestId":req_id,"ok":false,"error":"Session access denied."}),
                            );
                            return;
                        }
                        // An attachment is shrunk HERE, on its way past, using
                        // the same ceiling an upload gets. The bytes in a
                        // transcript are whatever the person's screenshot tool
                        // produced — several megabytes is ordinary — and every
                        // client would otherwise pay that to draw a thumbnail.
                        //
                        // The hub is the right place for it and the only cheap
                        // one: the resizer already lives here for the upload
                        // path, the agent is Node with no image library, and
                        // doing it once on the way through serves every client
                        // rather than each of them separately.
                        let mut v = v;
                        if pending.method == "session.image" {
                            if let Some(result) = v.get_mut("result") {
                                let media = result.get("mediaType").and_then(Value::as_str);
                                let data = result.get("dataB64").and_then(Value::as_str);
                                if let (Some(media), Some(data)) = (media, data) {
                                    if let Some((media, data)) = crate::images::shrink(media, data)
                                    {
                                        result["mediaType"] = Value::String(media);
                                        result["dataB64"] = Value::String(data);
                                    }
                                }
                            }
                        }
                        self.send_to(pending.conn, &v);
                    }
                }
            }
            "term_opened" => {
                if let Some(term_id) = v.get("termId").and_then(Value::as_str) {
                    if let Some((browser, machine_id)) = self
                        .terminals
                        .get(term_id)
                        .filter(|(_, m)| self.conn_machine.get(&conn) == Some(m))
                        .cloned()
                    {
                        self.send_to(
                            browser,
                            &json!({"type":"term_opened","termId":term_id,"machineId":machine_id}),
                        );
                    }
                }
            }
            "term_data" => {
                if let Some(term_id) = v.get("termId").and_then(Value::as_str) {
                    if let Some((browser, _)) = self
                        .terminals
                        .get(term_id)
                        .filter(|(_, m)| self.conn_machine.get(&conn) == Some(m))
                        .cloned()
                    {
                        let mut frame = json!({"type":"term_data","termId":term_id,"data":v.get("data").cloned().unwrap_or(Value::Null)});
                        if let Some(e) = v.get("e2e") {
                            frame["e2e"] = e.clone();
                        }
                        self.send_to(browser, &frame);
                    }
                }
            }
            "term_exit" => {
                if let Some(term_id) = v.get("termId").and_then(Value::as_str).map(str::to_string) {
                    let from_target = self
                        .terminals
                        .get(&term_id)
                        .is_some_and(|(_, m)| self.conn_machine.get(&conn) == Some(m));
                    if !from_target {
                        return;
                    }
                    if let Some((browser, _)) = self.terminals.remove(&term_id) {
                        self.send_to(browser, &json!({"type":"term_exit","termId":term_id,"code":v.get("code").cloned().unwrap_or(Value::Null)}));
                    }
                }
            }
            "mirror_data" => {
                if let Some(mirror_id) = v.get("mirrorId").and_then(Value::as_str) {
                    if let Some((browser, _)) = self
                        .mirrors
                        .get(mirror_id)
                        .filter(|(_, m)| self.conn_machine.get(&conn) == Some(m))
                        .cloned()
                    {
                        self.send_to(
                            browser,
                            &json!({
                                "type":"mirror_data","mirrorId":mirror_id,
                                "replace": v.get("replace").cloned().unwrap_or(Value::Bool(false)),
                                "messages": v.get("messages").cloned().unwrap_or(json!([])),
                            }),
                        );
                    }
                }
            }
            _ => {}
        }
    }

    // ------------------------------------------------ durable transcript sync
    /// Wire shape of `MemoryEntry` in `shared/src/protocol.ts` — keep the two
    /// in step or the agent's zod decode drops the whole message.
    fn memory_entry_json(m: &MemoryRecord) -> Value {
        json!({
            "scope": m.scope,
            "scopeKey": m.scope_key,
            "path": m.path,
            "sha256": m.content_sha256,
            "revision": m.revision,
            "updatedAt": m.updated_at,
            "bytes": m.bytes,
            "deleted": m.deleted,
        })
    }

    /// Memory is keyed on a user, so an unowned machine has nowhere to put it.
    /// A missing owner is the normal state for a legacy/unadopted device, not
    /// an error — only a failed lookup is worth logging.
    fn memory_owner(&self, machine_id: &str) -> Option<String> {
        match self.workspaces.device_owner(machine_id) {
            Ok(owner) => owner,
            Err(e) => {
                eprintln!("[hub] device owner lookup failed for {machine_id}: {e}");
                None
            }
        }
    }

    /// The owner whose memory this machine may sync, or None when it may not.
    /// A sandbox never does — it runs a member's code, and the owner's notes
    /// are both private and an injection path into the owner's next session.
    /// With `CC_REMOTE_MEMORY_SYNC_MACHINES` set, only the listed machines do.
    fn memory_sync_owner(&self, machine_id: &str) -> Option<String> {
        if let Some(allowed) = &self.memory_sync_machines {
            if !allowed.contains(machine_id) {
                return None;
            }
        }
        match self.workspaces.device_kind(machine_id) {
            Ok(Some(kind)) if kind == "sandbox" => return None,
            Ok(_) => {}
            Err(e) => {
                eprintln!("[hub] device kind lookup failed for {machine_id}: {e}");
                return None;
            }
        }
        self.memory_owner(machine_id)
    }

    /// Sent after register, next to the transcript catalog. Metadata only: the
    /// agent compares `sha256` against what is on its disk and asks for the
    /// bodies it is missing.
    fn send_memory_catalog(&mut self, conn: ConnId, machine_id: &str) {
        let Some(owner) = self.memory_sync_owner(machine_id) else {
            return;
        };
        match self.workspaces.memory_catalog(&owner, machine_id) {
            Ok(rows) => {
                let memories: Vec<Value> = rows.iter().map(Self::memory_entry_json).collect();
                self.send_to(conn, &json!({"type":"memory_catalog","memories":memories}));
            }
            Err(e) => eprintln!("[hub] memory catalog read failed for {machine_id}: {e}"),
        }
    }

    /// The viewer's own memory store, for the browser's Memory view. Scoped to
    /// the connection's user rather than to any machine — a person is looking
    /// at what the hub remembers for THEM, and the store is keyed on the owner.
    fn ui_memory_list(&mut self, conn: ConnId, v: &Value) {
        let request_id = v.field_str("requestId").unwrap_or("").to_string();
        let Some(owner) = self.ui_access.get(&conn).map(|a| a.user_id.clone()) else {
            self.send_to(
                conn,
                &json!({"type":"memory_list_result","requestId":request_id,
                        "ok":false,"error":"not authenticated"}),
            );
            return;
        };
        match self.workspaces.memory_list(&owner) {
            Ok(rows) => {
                let memories: Vec<Value> = rows.iter().map(Self::memory_entry_json).collect();
                self.send_to(
                    conn,
                    &json!({"type":"memory_list_result","requestId":request_id,
                            "ok":true,"memories":memories}),
                );
            }
            Err(e) => {
                eprintln!("[hub] memory list failed for {owner}: {e}");
                self.send_to(
                    conn,
                    &json!({"type":"memory_list_result","requestId":request_id,
                            "ok":false,"error":crate::client_safe_error(&e)}),
                );
            }
        }
    }

    /// One memory's body for the browser. The identity comes from the client,
    /// but the owner never does — it is taken from the connection, so a viewer
    /// cannot read another user's notes by naming them.
    fn ui_memory_read(&mut self, conn: ConnId, v: &Value) {
        let request_id = v.field_str("requestId").unwrap_or("").to_string();
        let fail = |hub: &mut Self, msg: &str| {
            hub.send_to(
                conn,
                &json!({"type":"memory_read_result","requestId":request_id,
                        "ok":false,"error":msg}),
            );
        };
        let Some(owner) = self.ui_access.get(&conn).map(|a| a.user_id.clone()) else {
            fail(self, "not authenticated");
            return;
        };
        let (Some(scope), Some(path)) = (v.field_str("scope"), v.field_str("path")) else {
            fail(self, "malformed memory_read");
            return;
        };
        let (scope, path) = (scope.to_string(), path.to_string());
        let scope_key = v.field_str("scopeKey").unwrap_or("").to_string();
        match self
            .workspaces
            .read_memory(&owner, &scope, &scope_key, &path)
        {
            Ok(Some(m)) => {
                let content = m.content.unwrap_or_default();
                self.send_to(
                    conn,
                    &json!({"type":"memory_read_result","requestId":request_id,
                            "ok":true,"content":content}),
                );
            }
            Ok(None) => fail(self, "memory not found"),
            Err(e) => fail(self, &e),
        }
    }

    /// Tombstone a memory on the viewer's behalf. The row survives with
    /// `deleted=1`; agents learn about it through the catalog and stop offering
    /// their local copy back, which is what makes the deletion stick. Their
    /// local file is retired by the agent, not removed here.
    fn ui_memory_delete(&mut self, conn: ConnId, v: &Value) {
        let request_id = v.field_str("requestId").unwrap_or("").to_string();
        let reply = |hub: &mut Self, ok: bool, error: Option<&str>| {
            let mut body = json!({"type":"memory_delete_result","requestId":request_id,"ok":ok});
            if let Some(e) = error {
                body["error"] = json!(e);
            }
            hub.send_to(conn, &body);
        };
        let Some(owner) = self.ui_access.get(&conn).map(|a| a.user_id.clone()) else {
            reply(self, false, Some("not authenticated"));
            return;
        };
        let (Some(scope), Some(path)) = (v.field_str("scope"), v.field_str("path")) else {
            reply(self, false, Some("malformed memory_delete"));
            return;
        };
        let (scope, path) = (scope.to_string(), path.to_string());
        let scope_key = v.field_str("scopeKey").unwrap_or("").to_string();
        match self
            .workspaces
            .delete_memory(&owner, &scope, &scope_key, &path)
        {
            // `false` means there was nothing live to tombstone. The end state
            // the caller asked for already holds, so this is not an error.
            Ok(_) => {
                reply(self, true, None);
                self.push_memory_catalogs_for(&owner);
            }
            Err(e) => reply(self, false, Some(&e)),
        }
    }

    /// Re-send the catalog to every connected agent this user owns, so a
    /// tombstone reaches them now instead of on their next reconnect — the
    /// window between the two is exactly when a machine would push the note
    /// back and undo the deletion.
    fn push_memory_catalogs_for(&mut self, owner: &str) {
        let targets: Vec<(ConnId, String)> = self
            .agents
            .iter()
            .filter(|(id, _)| self.memory_owner(id).as_deref() == Some(owner))
            .map(|(id, a)| (a.conn, id.clone()))
            .collect();
        for (conn, machine_id) in targets {
            self.send_memory_catalog(conn, &machine_id);
        }
    }

    /// An agent uploading one of its local memory files — the only way a
    /// memory enters the store, because the hub is never allowed to overwrite
    /// a file the machine already has (the Claude Code harness writes those
    /// same paths; two writers on one file is the failure this project already
    /// refuses for transcripts).
    ///
    /// `scopeKey` is re-derived from the connection rather than trusted: a
    /// machine may pin a note to itself and nowhere else, or one box could
    /// plant memory on another.
    fn memory_push(&mut self, conn: ConnId, v: &Value) {
        let Some(machine_id) = self.conn_machine.get(&conn).cloned() else {
            return;
        };
        let Some(owner) = self.memory_sync_owner(&machine_id) else {
            return;
        };
        let (Some(scope), Some(path), Some(content)) = (
            v.field_str("scope"),
            v.field_str("path"),
            v.field_str("content"),
        ) else {
            return;
        };
        let scope_key = if scope == "machine" {
            machine_id.as_str()
        } else {
            v.field_str("scopeKey").unwrap_or("")
        };
        if let Err(e) = self
            .workspaces
            .upsert_memory(&owner, scope, scope_key, path, content)
        {
            eprintln!("[hub] memory push rejected for {machine_id} {path}: {e}");
        }
    }

    /// Bodies for catalog entries the agent does not have on disk. Silently
    /// skips paths that vanished between catalog and fetch — a tombstoned
    /// memory simply does not come down, which is the intended outcome.
    fn memory_fetch(&mut self, conn: ConnId, v: &Value) {
        let Some(machine_id) = self.conn_machine.get(&conn).cloned() else {
            return;
        };
        let Some(owner) = self.memory_sync_owner(&machine_id) else {
            return;
        };
        let want = v
            .get("want")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut memories: Vec<Value> = Vec::new();
        for entry in want.iter().take(100) {
            let (Some(scope), Some(path)) = (entry.field_str("scope"), entry.field_str("path"))
            else {
                continue;
            };
            let scope_key = if scope == "machine" {
                machine_id.as_str()
            } else {
                entry.field_str("scopeKey").unwrap_or("")
            };
            match self.workspaces.read_memory(&owner, scope, scope_key, path) {
                Ok(Some(m)) => {
                    let content = m.content.clone().unwrap_or_default();
                    let mut json_entry = Self::memory_entry_json(&m);
                    json_entry["content"] = Value::String(content);
                    memories.push(json_entry);
                }
                Ok(None) => {}
                Err(e) => eprintln!("[hub] memory read failed for {machine_id} {path}: {e}"),
            }
        }
        if !memories.is_empty() {
            self.send_to(conn, &json!({"type":"memory_deliver","memories":memories}));
        }
    }

    /// The machine's owner narrowed what leaves it; drop our copy of these
    /// sessions, history included (`ReplicaStore::forget_sessions`). Only ever
    /// for the machine on THIS socket — the agent speaks for itself alone.
    fn sync_forget(&mut self, conn: ConnId, v: &Value) {
        let Some(machine_id) = self.conn_machine.get(&conn).cloned() else {
            return;
        };
        let sessions: Vec<(String, String)> = v
            .get("sessions")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|s| {
                        let id = s.get("sessionId").and_then(Value::as_str)?;
                        let source = s.get("source").and_then(Value::as_str).unwrap_or("claude");
                        Some((source.to_string(), id.to_string()))
                    })
                    .take(5000)
                    .collect()
            })
            .unwrap_or_default();
        if sessions.is_empty() {
            return;
        }
        for (_, id) in &sessions {
            self.watch_digests.remove(&format!("{machine_id}::{id}"));
        }
        match self.store.forget_sessions(&machine_id, &sessions) {
            Ok(gone) => {
                eprintln!("[hub] {machine_id}: forgot {gone} session(s) its owner stopped syncing")
            }
            Err(e) => {
                eprintln!("[hub] {machine_id}: sync_forget failed: {e}");
                return;
            }
        }
        if let Some(a) = self.agents.get_mut(&machine_id) {
            if let Ok(fresh) = self.store.sessions_for_machine(&machine_id) {
                a.sessions = fresh;
                overlay_liveness(&mut a.sessions, &a.liveness);
            }
        }
        self.broadcast_machine_sessions(std::slice::from_ref(&machine_id));
    }

    fn begin_session_sync(&mut self, conn: ConnId, v: &Value) {
        let Some(machine_id) = self.conn_machine.get(&conn).cloned() else {
            return;
        };
        let sync_id = v
            .get("syncId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let session_id = v
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let source = v
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let mode = v
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let base_revision = v.get("baseRevision").and_then(Value::as_i64).unwrap_or(-1);
        let summary = v.get("summary").cloned().unwrap_or(Value::Null);
        let summary_id = summary
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let summary_source = summary
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("claude");

        if sync_id.is_empty()
            || sync_id.len() > 128
            || session_id.is_empty()
            || session_id.len() > 512
            || (source != "claude" && source != "codex")
            || (mode != "append" && mode != "replace")
            || base_revision < 0
            || summary_id != session_id
            || summary_source != source
            || self.session_erased(&machine_id, &session_id)
        {
            self.send_sync_ack(
                conn,
                &sync_id,
                &session_id,
                &source,
                false,
                Some("invalid session sync begin"),
                None,
            );
            return;
        }

        // A duplicate id supersedes only work from this same socket. Random UUIDs
        // make this defensive; never let one agent abort another agent's staging.
        if self
            .pending_replica
            .get(&sync_id)
            .map(|p| p.conn == conn)
            .unwrap_or(false)
        {
            self.abort_pending_sync(&sync_id, "duplicate sync id");
        } else if self.pending_replica.contains_key(&sync_id) {
            self.send_sync_ack(
                conn,
                &sync_id,
                &session_id,
                &source,
                false,
                Some("sync id already in use"),
                None,
            );
            return;
        }

        match self.store.prepare_sync(
            &machine_id,
            &source,
            &session_id,
            &summary,
            &mode,
            base_revision,
            &sync_id,
        ) {
            Ok(prepared) => {
                self.pending_replica.insert(
                    sync_id,
                    PendingReplicaSync {
                        conn,
                        machine_id,
                        source,
                        session_id,
                        summary,
                        mode,
                        base_revision,
                        generation: prepared.generation,
                        start_position: prepared.start_position,
                        next_position: prepared.start_position,
                    },
                );
            }
            Err(e) => {
                let state = self.store.state(&machine_id, &source, &session_id).ok();
                self.send_sync_ack(
                    conn,
                    &sync_id,
                    &session_id,
                    &source,
                    false,
                    Some(&e),
                    state.as_ref(),
                );
            }
        }
    }

    fn session_sync_chunk(&mut self, conn: ConnId, v: &Value) {
        let sync_id = v
            .get("syncId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let start = v.get("start").and_then(Value::as_i64).unwrap_or(-1);
        let messages = v
            .get("messages")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let Some(p) = self.pending_replica.get(&sync_id) else {
            return;
        };
        if p.conn != conn {
            return;
        }
        if start != p.next_position || messages.len() > 200 {
            self.abort_pending_sync(&sync_id, "non-contiguous or oversized sync chunk");
            return;
        }
        let machine_id = p.machine_id.clone();
        let source = p.source.clone();
        let session_id = p.session_id.clone();
        let generation = p.generation.clone();
        match self.store.write_chunk(
            &machine_id,
            &source,
            &session_id,
            &generation,
            start,
            &messages,
        ) {
            Ok(()) => {
                if let Some(p) = self.pending_replica.get_mut(&sync_id) {
                    p.next_position += messages.len() as i64;
                }
            }
            Err(e) => self.abort_pending_sync(&sync_id, &e),
        }
    }

    fn commit_session_sync(&mut self, conn: ConnId, v: &Value) {
        let sync_id = v
            .get("syncId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let message_count = v.get("messageCount").and_then(Value::as_i64).unwrap_or(-1);
        let synced_mtime = v.get("syncedMtime").and_then(Value::as_f64).unwrap_or(-1.0);
        let tail_hash = v
            .get("tailHash")
            .and_then(Value::as_str)
            .map(str::to_string);
        let Some(p) = self.pending_replica.remove(&sync_id) else {
            return;
        };
        if p.conn != conn {
            self.pending_replica.insert(sync_id, p);
            return;
        }
        if message_count != p.next_position
            || self.session_erased(&p.machine_id, &p.session_id)
            || message_count < 0
            || !synced_mtime.is_finite()
            || (message_count > 0 && tail_hash.is_none())
        {
            self.store.abort_sync(
                &p.machine_id,
                &p.source,
                &p.session_id,
                &p.generation,
                p.start_position,
            );
            let state = self
                .store
                .state(&p.machine_id, &p.source, &p.session_id)
                .ok();
            self.send_sync_ack(
                conn,
                &sync_id,
                &p.session_id,
                &p.source,
                false,
                Some("invalid session sync commit"),
                state.as_ref(),
            );
            return;
        }

        match self.store.commit_sync(
            &p.machine_id,
            &p.source,
            &p.session_id,
            &p.summary,
            &p.mode,
            p.base_revision,
            &p.generation,
            message_count,
            tail_hash.as_deref(),
            synced_mtime,
        ) {
            Ok(state) => self.send_sync_ack(
                conn,
                &sync_id,
                &p.session_id,
                &p.source,
                true,
                None,
                Some(&state),
            ),
            Err(e) => {
                self.store.abort_sync(
                    &p.machine_id,
                    &p.source,
                    &p.session_id,
                    &p.generation,
                    p.start_position,
                );
                let state = self
                    .store
                    .state(&p.machine_id, &p.source, &p.session_id)
                    .ok();
                self.send_sync_ack(
                    conn,
                    &sync_id,
                    &p.session_id,
                    &p.source,
                    false,
                    Some(&e),
                    state.as_ref(),
                );
            }
        }
    }

    fn abort_pending_sync(&mut self, sync_id: &str, error: &str) {
        let Some(p) = self.pending_replica.remove(sync_id) else {
            return;
        };
        self.store.abort_sync(
            &p.machine_id,
            &p.source,
            &p.session_id,
            &p.generation,
            p.start_position,
        );
        let state = self
            .store
            .state(&p.machine_id, &p.source, &p.session_id)
            .ok();
        self.send_sync_ack(
            p.conn,
            sync_id,
            &p.session_id,
            &p.source,
            false,
            Some(error),
            state.as_ref(),
        );
    }

    fn send_sync_ack(
        &self,
        conn: ConnId,
        sync_id: &str,
        session_id: &str,
        source: &str,
        ok: bool,
        error: Option<&str>,
        state: Option<&crate::replica::ReplicaState>,
    ) {
        let mut out = json!({
            "type":"session_sync_ack", "syncId":sync_id, "sessionId":session_id,
            "source":source, "ok":ok, "error":error,
        });
        if let Some(s) = state {
            let cursor = state_json(s);
            for key in ["revision", "messageCount", "tailHash", "syncedMtime"] {
                out[key] = cursor.get(key).cloned().unwrap_or(Value::Null);
            }
        }
        self.send_to(conn, &out);
    }

    /// A successful project-shaped RPC becomes an audit row in the caller's
    /// workspace — the "made a project" signal the community metrics count.
    /// Silent when the caller is gone or unknown.
    fn audit_project_rpc(&self, pending: &PendingRpc, response: &Value) {
        let action = match pending.method.as_str() {
            "projects.create" => "project.created",
            "projects.remove" => "project.removed",
            // Adoption creates nothing on disk, which is exactly why it needs a
            // row: in a shared sandbox a directory starts appearing in everyone's
            // picker and nothing else in the product can say who put it there.
            // `projects.forget` is the undo and leaves the disk alone — the trail
            // is the only place the pair is visible at all.
            "projects.adopt" => "project.adopted",
            "projects.forget" => "project.forgotten",
            // A coder installed or a login started on a machine, from the
            // «Начало» screen. The login's outcome lives on the machine; the
            // row records who pressed the button and when.
            "runtime.install" => "runtime.installed",
            "runtime.login.start" => "runtime.login",
            // Destructive file operations leave the same trail, for the same
            // reason: in a shared sandbox a directory vanishes and nothing else
            // in the product can say who did it. The plumbing was already here —
            // `PendingRpc` carries the method and the cwd precisely for this.
            "fs.trash" => "file.trashed",
            "fs.rename" => "file.renamed",
            "fs.mkdir" => "dir.created",
            "fs.upload.commit" => "file.uploaded",
            _ => return,
        };
        if response.field_bool("ok") != Some(true) {
            return;
        }
        let Some(user_id) = self.ui_access.get(&pending.conn).map(|a| a.user_id.clone()) else {
            return;
        };
        let Some(workspace_id) = self.workspaces.audit_workspace_for(&user_id) else {
            return;
        };
        let cwd = response
            .get("result")
            .and_then(|r| r.get("cwd"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| pending.cwd.clone());
        let mut metadata = json!({"machineId": pending.machine_id});
        if let Some(cwd) = &cwd {
            metadata["cwd"] = Value::String(cwd.clone());
        }
        // A file row is worthless without the file. `path` is relative to the
        // cwd already in the metadata, and `movedTo` is the entire recovery
        // story for a delete — there is no restore call.
        for key in ["path", "movedTo"] {
            if let Some(v) = response
                .get("result")
                .and_then(|r| r.get(key))
                .and_then(Value::as_str)
            {
                metadata[key] = Value::String(v.to_string());
            }
        }
        let entity = if action.starts_with("project.") {
            "project"
        } else {
            "file"
        };
        if let Err(e) = self.workspaces.audit(
            &workspace_id,
            &user_id,
            action,
            entity,
            cwd.as_deref().unwrap_or(""),
            &metadata,
        ) {
            eprintln!("[hub] audit {action} failed: {e}");
        }
    }

    // ----------------------------------------------------------- browser in
    /// Whether this connection's viewer is past the waitlist. Every machine
    /// right below is conditioned on it: before activation the product is
    /// the waiting screen and no machine exists.
    fn ui_is_active(&self, conn: ConnId) -> bool {
        self.ui_access.get(&conn).is_some_and(UiAccess::is_active)
    }
    /// Is this connection confined to a service UI pass's fence?
    fn is_scoped(&self, conn: ConnId) -> bool {
        self.ui_access
            .get(&conn)
            .is_some_and(|a| a.ui_scope.is_some())
    }

    /// Is the pass behind a scoped connection still good? It ends at its
    /// `expires_at` (never extended), when the per-person cap evicts it, when
    /// its row is revoked, or when its person stops holding it
    /// (`session_alive`). A connection with no pass on record, or a lookup
    /// that fails, is NOT alive: a scoped socket never outlives what it can
    /// not confirm.
    fn scoped_pass_alive(&self, conn: ConnId) -> bool {
        self.ui_sessions
            .get(&conn)
            .is_some_and(|session| matches!(self.workspaces.session_alive(session), Ok(true)))
    }

    /// Close the scoped connections whose pass is no longer good. Runs on its
    /// own 30-second tick and after every mint (a socket that only listens
    /// sends no frame to be judged on) and, per connection, before every frame
    /// it does send.
    fn drop_dead_passes(&mut self) {
        let dead: Vec<ConnId> = self
            .ui_access
            .iter()
            .filter(|(conn, a)| a.ui_scope.is_some() && !self.scoped_pass_alive(**conn))
            .map(|(conn, _)| *conn)
            .collect();
        for conn in dead {
            println!("[hub] closing /ui conn {conn}: its UI pass is no longer good");
            self.on_disconnect(conn);
        }
    }
    fn ui_can_control_machine(&self, conn: ConnId, machine_id: &str) -> bool {
        self.ui_access
            .get(&conn)
            .filter(|a| a.is_active())
            .and_then(|a| self.workspaces.machine_access(a, machine_id).ok())
            .is_some_and(|a| a.can_control)
    }
    /// May the connection START / drive sessions here — full control OR a
    /// control-share member.
    fn ui_can_start_machine(&self, conn: ConnId, machine_id: &str) -> bool {
        self.ui_access
            .get(&conn)
            .filter(|a| a.is_active())
            .and_then(|a| self.workspaces.machine_access(a, machine_id).ok())
            .is_some_and(|a| a.can_control || a.can_start)
    }
    /// The refusal for a browser frame from a viewer who is not active yet,
    /// or None when the frame (or the viewer) passes.
    fn inactive_refusal(&self, conn: ConnId, ty: &str) -> Option<&'static str> {
        let access = self.ui_access.get(&conn)?;
        if access.is_active() || INACTIVE_ALLOWED.contains(&ty) || ty.starts_with("memory_") {
            return None;
        }
        Some(if access.access_state == "suspended" {
            "Доступ приостановлен."
        } else {
            "Доступ ещё не открыт — вы в списке ожидания."
        })
    }
    /// The connected user id + display name (fullName, else email), for owner
    /// attribution when starting a run.
    fn ui_owner(&self, conn: ConnId) -> (Option<String>, Option<String>) {
        match self.ui_access.get(&conn) {
            Some(a) => {
                let name = a
                    .viewer
                    .get("fullName")
                    .and_then(Value::as_str)
                    .or_else(|| a.viewer.get("email").and_then(Value::as_str))
                    .map(str::to_string);
                (Some(a.user_id.clone()), name)
            }
            None => (None, None),
        }
    }
    /// The ACTING person on a UI connection as the wire `runBy` object — the
    /// one clicking, never the device owner.
    fn ui_run_by(&self, conn: ConnId) -> Option<Value> {
        watch::run_by_of(self.ui_access.get(&conn)?)
    }
    /// Recorded owner of a session, from the in-memory cache (no DB hit).
    fn session_owner(&self, machine_id: &str, session_id: &str) -> Option<&str> {
        self.session_meta
            .get(&format!("{machine_id}::{session_id}"))
            .map(|m| m.owner_user_id.as_str())
    }
    /// May the connection see this run? Owning a run does not override the
    /// share ACL for an ESTABLISHED session — the owner of a session under a
    /// restricted share they were taken off sees nothing of it. The one
    /// exception is a brand-new run that has no id yet (the owner row has not
    /// landed), and even that one is refused inside a root the viewer is shut
    /// out of.
    fn ui_can_see_run(&self, conn: ConnId, run: &ActiveRun) -> bool {
        let owned = run.owner_user_id.is_some()
            && self.ui_access.get(&conn).map(|a| a.user_id.as_str())
                == run.owner_user_id.as_deref();
        if owned && run.session_id.is_empty() {
            // Fail-closed on every refresh too: the viewer must be active, the
            // machine visible, and the run's folder under a root they hold
            // right now and not closed to them (full control needs no root).
            return self.ui_access.get(&conn).is_some_and(|a| {
                a.is_active()
                    && self
                        .workspaces
                        .machine_access(a, &run.machine_id)
                        .is_ok_and(|ma| {
                            ma.can_control
                                || (ma.can_view
                                    && run.cwd.as_deref().is_some_and(|cwd| ma.allows_path(cwd)))
                        })
            });
        }
        self.ui_can_view_session(conn, &run.machine_id, &run.session_id, run.cwd.as_deref())
    }

    /// Whether the connection may drive an existing run: full control, or a
    /// control-share member acting on their own run or a viewable teammate run.
    fn ui_can_drive_run(&self, conn: ConnId, run: &ActiveRun) -> bool {
        if self.session_erased(&run.machine_id, &run.session_id) {
            return false;
        }
        if self.ui_can_control_machine(conn, &run.machine_id) {
            return true;
        }
        if !self.ui_can_start_machine(conn, &run.machine_id) {
            return false;
        }
        // A service UI pass drives Codex only (it starts and resumes on Codex
        // only): a Claude run in the matter — one somebody else started —
        // would spend the device owner's Claude login. No source = Claude.
        if self.is_scoped(conn) && run.source.as_deref() != Some("codex") {
            return false;
        }
        self.ui_can_see_run(conn, run)
            && self.ui_can_work_in(conn, &run.machine_id, &run.session_id, run.cwd.as_deref())
    }

    /// May the connection WORK in this session's folder — start, resume, type
    /// into it, rename or close it? Seeing a share is not the same as working in
    /// it: a workspace owner sees every share of the team, but may work only
    /// where they hold start rights (`start_roots`: the shares they are listed
    /// on). Judged on the hub's own record of the session's folder. `known_cwd`
    /// is a folder the HUB knows (a live run's, the inventory's) for a session
    /// that has no record yet — NEVER a client's claim: a session the hub cannot
    /// place is not worked in. Full control of the machine is never narrowed.
    fn ui_can_work_in(
        &self,
        conn: ConnId,
        machine_id: &str,
        session_id: &str,
        known_cwd: Option<&str>,
    ) -> bool {
        let Some(access) = self.ui_access.get(&conn).filter(|a| a.is_active()) else {
            return false;
        };
        let Ok(machine) = self.workspaces.machine_access(access, machine_id) else {
            return false;
        };
        if machine.can_control {
            return true;
        }
        let cwd = if session_id.is_empty() {
            known_cwd.map(str::to_string)
        } else {
            self.session_cwd(machine_id, session_id)
                .or_else(|| known_cwd.map(str::to_string))
        };
        cwd.is_some_and(|cwd| machine.allows_start_path(&cwd))
    }
    fn deny(&self, conn: ConnId, message: &str) {
        self.send_to(conn, &json!({"type":"error","message":message}));
    }

    /// Tell the sender which attachments `sanitize_attachments` left out, if any.
    fn report_attachment_loss(
        &self,
        conn: ConnId,
        images_in: Option<&Value>,
        files_in: Option<&Value>,
        images_out: Option<&Value>,
        files_out: Option<&Value>,
    ) {
        if let Some(message) = attachment_loss(images_in, files_in, images_out, files_out) {
            println!("[hub] conn {conn}: {message}");
            self.send_to(
                conn,
                &json!({"type":"error","code":"attachments_dropped","message":message}),
            );
        }
    }

    /// How long the agent on `machine_id` waits on a human before auto-denying.
    /// See `TOOL_APPROVAL_TTL_MS_DEFAULT` for why this is per machine.
    fn tool_approval_ttl_ms(&self, machine_id: &str) -> i64 {
        self.agents
            .get(machine_id)
            .and_then(|a| a.approval_timeout_ms)
            .unwrap_or(TOOL_APPROVAL_TTL_MS_DEFAULT)
    }

    /// Whether this connection's user is the recorded owner of the session.
    ///
    /// Housekeeping on your own work — filing it on the board, closing it when
    /// it's finished — is not machine control, and gating it on `can_control`
    /// left members unable to tidy up after themselves on a machine they were
    /// invited to work on. Ownership is recorded per session (`session_owners`),
    /// so it answers exactly this question and nothing wider.
    fn ui_owns_session(&self, conn: ConnId, machine_id: &str, session_id: &str) -> bool {
        let Some(user_id) = self.ui_access.get(&conn).map(|a| a.user_id.as_str()) else {
            return false;
        };
        // Ownership is housekeeping on work you can still SEE; it never
        // outlives the share ACL (a session under a restricted share you were
        // taken off cannot be closed or filed by its former owner).
        self.session_owner(machine_id, session_id) == Some(user_id)
            && self.ui_can_view_session(conn, machine_id, session_id, None)
            && self.ui_can_work_in(conn, machine_id, session_id, None)
    }

    fn on_ui_msg(&mut self, conn: ConnId, v: Value) {
        self.reply_ref = v
            .get("ref")
            .and_then(Value::as_str)
            .filter(|r| !r.is_empty() && r.len() <= 64)
            .map(|r| (conn, r.to_string()));
        let Some(ty) = v.field_str("type") else {
            return;
        };
        // A support account (a grant the workspace owner opened): its grant is
        // judged on every frame, and every frame is written to the owner's log.
        if self.support_gate(conn, ty, &v) {
            return;
        }
        // A connection on a service UI pass speaks a short list of frames: the
        // session surface of an ordinary chat client, nothing that reaches a
        // terminal, a mirror, a file, a project, a policy or a runtime. Judged
        // before anything else so a frame outside the list can never be
        // answered by a handler that forgot the pass exists.
        if self.is_scoped(conn) {
            // The pass first: one that has ended (expiry, eviction, revocation)
            // gets no answer to anything, not even a refusal.
            if !self.scoped_pass_alive(conn) {
                println!("[hub] closing /ui conn {conn}: its UI pass is no longer good");
                self.on_disconnect(conn);
                return;
            }
            if !SCOPED_ALLOWED.contains(&ty) {
                self.send_to(
                    conn,
                    &json!({"type":"error","code":"scope_refused","message":"This connection may not do that."}),
                );
                return;
            }
        }
        // Before activation only the waiting screen exists. Everything that
        // would touch a machine is refused with the reason, so a stale tab
        // fails loudly rather than silently.
        if let Some(refusal) = self.inactive_refusal(conn, ty) {
            self.deny(conn, refusal);
            return;
        }
        match ty {
            "enrich_request" => self.ui_enrich(conn, &v),
            "session_read" => self.ui_session_read(conn, &v),
            "memory_list" => self.ui_memory_list(conn, &v),
            "memory_read" => self.ui_memory_read(conn, &v),
            "memory_delete" => self.ui_memory_delete(conn, &v),
            "open" => self.open_run(conn, &v, false),
            "new_session" => self.new_session(conn, &v),
            // Force takeover: same as open, but skip the live-writer refusal — the
            // agent terminates the editor's writer (and confirms it's gone) before
            // resuming, so the single-writer invariant still holds.
            "takeover" => self.open_run(conn, &v, true),
            "subscribe" => {
                let run_id = v
                    .get("runId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if let Some(run) = self.runs.get(&run_id) {
                    // Only a brand-new, id-less run of yours skips the session
                    // filter; an established one answers to the share ACL.
                    if !self.ui_can_see_run(conn, run) {
                        self.deny(conn, "Session access denied.");
                        return;
                    }
                }
                // Viewer identity captured before the mutable run borrow — used to
                // decide whether this subscriber should inherit a pending prompt.
                let conn_uid = self.ui_access.get(&conn).map(|a| a.user_id.clone());
                // Whether this client may drive the run decides if it inherits a
                // question the run is stopped on. Computed before the mutable
                // borrow below.
                let can_decide = self
                    .runs
                    .get(&run_id)
                    .map(|run| self.ui_can_drive_run(conn, run))
                    .unwrap_or(false);
                // This run's own machine sets the deadline, so a box that waits
                // hours for an asynchronous approval and one that waits five
                // minutes are both served correctly. Read before the mutable
                // borrow below.
                let approval_ttl = self
                    .runs
                    .get(&run_id)
                    .map(|run| self.tool_approval_ttl_ms(&run.machine_id))
                    .unwrap_or(TOOL_APPROVAL_TTL_MS_DEFAULT);
                // A paused conn's gate drops the backlog (`send_to`), so the ack
                // must not announce frames that will never come.
                let backlog_gated = self.pause_gate_blocks(conn, "stream");
                if let Some(run) = self.runs.get_mut(&run_id) {
                    run.browsers.insert(conn);
                    // An approval the agent has already timed out is not a prompt
                    // any more — forget it rather than replay a dead requestId.
                    if run.pending_request_id.is_some() && now_ms() - run.since >= approval_ttl {
                        run.pending_request_id = None;
                        run.pending_tool = None;
                        run.pending_tool_input = None;
                        run.pending_tool_title = None;
                        run.pending_tool_e2e = None;
                    }
                    let (m, s) = (run.machine_id.clone(), run.session_id.clone());
                    // Whoever can drive the run inherits the question it is stopped
                    // on — its owner, or the colleague who just picked the session
                    // up. Without this, continuing someone else's paused session
                    // showed no prompt and there was no way to answer it.
                    let owns = can_decide
                        || run
                            .owner_user_id
                            .as_deref()
                            .is_none_or(|o| conn_uid.as_deref() == Some(o));
                    let pending_e2e = run.pending_tool_e2e.clone();
                    let pending = match (
                        run.pending_request_id.clone(),
                        run.pending_tool.clone(),
                        run.pending_tool_input.clone(),
                    ) {
                        (Some(request_id), Some(tool), Some(input)) if owns => {
                            let mut frame = json!({
                                "type": "tool_request",
                                "runId": run_id,
                                "sessionId": s,
                                "requestId": request_id,
                                "tool": tool,
                                "input": input,
                                "title": run.pending_tool_title,
                            });
                            if let Some(e) = pending_e2e {
                                frame["e2e"] = e;
                            }
                            Some(frame)
                        }
                        _ => None,
                    };
                    // Everything the turn has streamed so far, so the pane opens
                    // showing work in progress rather than nothing. Empty once the
                    // turn ends — from then on the transcript on disk is the record.
                    let backlog: Vec<Value> = run.replay.iter().cloned().collect();
                    let backlog_len = if backlog_gated { 0 } else { backlog.len() };
                    // What the run is actually set to. The agent announces these
                    // once, when the runtime tells it, so without the replay a
                    // client that joins later shows its own composer defaults for
                    // a run that may be on another model, mode or effort entirely.
                    let settings: Vec<Value> = [run.mode_frame.clone(), run.settings_frame.clone()]
                        .into_iter()
                        .flatten()
                        .collect();
                    // A compaction still pending is a fact about the run, not
                    // about the turn — it survives `run_idle` clearing the
                    // replay window, so it is re-stated on its own.
                    let background = run.background_frame.clone();
                    let subagents = run.subagents_frame.clone();
                    // The context budget is forwarded only when it changes, so
                    // a late subscriber is told the current one here.
                    let context = run.context_frame.clone();
                    let compacting = run.compacting.then(|| {
                        json!({
                            "type": "stream",
                            "runId": run_id,
                            "sessionId": s,
                            "event": {"kind": "status", "code": "compact_started", "text": "compacting context… (queued behind the current turn)"},
                        })
                    });
                    // `backlog` = how many replay frames (`stream` and
                    // `user_turn`) follow the settings, back to back on this
                    // socket; none for a paused conn, whose gate drops them. A phone stages the
                    // replay off screen and publishes it in one write; knowing the
                    // count it no longer has to guess the end from a timer, which a
                    // 256 KB backlog over a radio outran — the rest of the turn then
                    // landed frame by frame, "retyped" and froze the screen
                    // (23.11.2026). Optional: older clients ignore it.
                    self.send_to(
                        conn,
                        &json!({"type":"opened","runId":run_id,"machineId":m,"sessionId":s,"backlog":backlog_len}),
                    );
                    for frame in settings {
                        self.send_to(conn, &frame);
                    }
                    for frame in backlog {
                        self.send_to(conn, &frame);
                    }
                    if let Some(frame) = compacting {
                        self.send_to(conn, &frame);
                    }
                    // Also a fact about the run rather than the turn: the
                    // turn that started the task may be long over.
                    if let Some(frame) = background {
                        self.send_to(conn, &frame);
                    }
                    if let Some(frame) = subagents {
                        self.send_to(conn, &frame);
                    }
                    if let Some(frame) = context {
                        self.send_to(conn, &frame);
                    }
                    if let Some(request) = pending {
                        self.send_to(conn, &request);
                    }
                } else {
                    self.send_to(
                        conn,
                        &json!({"type":"error","message":"Run not found (already closed?)."}),
                    );
                }
            }
            "unsubscribe" => {
                let run_id = v
                    .get("runId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if let Some(run) = self.runs.get_mut(&run_id) {
                    run.browsers.remove(&conn);
                }
            }
            // Client self-identification (sent once on connect). Records the kind so
            // runs this conn opens are tagged app/web. Anything but "app" => "web".
            "hello" => {
                let kind = v.get("client").and_then(Value::as_str).unwrap_or("web");
                let kind = if kind == "app" { "app" } else { "web" };
                self.ui_kind.insert(conn, kind.to_string());
                // Opt-in only. A build that names nothing keeps receiving whole
                // snapshots, which is what makes shipping this before the app
                // builds safe — see `MachineSessions` in shared/.
                let caps: HashSet<String> = v
                    .get("caps")
                    .and_then(Value::as_array)
                    .map(|list| {
                        list.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                // A build that no longer names the cap (a re-`hello`) is back to
                // the always-on stream.
                if !caps.contains(CAP_STATS_ON_DEMAND) {
                    self.ui_stats_interest.remove(&conn);
                }
                self.ui_caps.insert(conn, caps);
            }
            // «Am I showing hardware telemetry?» — only meaningful from a
            // client that announced `statsOnDemand`; see `CAP_STATS_ON_DEMAND`.
            "stats_interest" => self.ui_stats_interest_msg(conn, &v),
            // Backgrounded client: stop all outbound traffic to this conn (see
            // `ui_paused`). `resume` lifts the gate and answers with a fresh
            // snapshot so the client re-syncs without reconnecting.
            // Keepalive: NAT and load balancers see traffic. A client that asked
            // for it (`pong` in `hello.caps`) is answered, because a browser page
            // has no other way to tell a quiet socket from one that died without
            // closing (a laptop that slept or switched networks).
            "ping" => {
                if self
                    .ui_caps
                    .get(&conn)
                    .is_some_and(|caps| caps.contains(CAP_PONG))
                {
                    self.send_to(conn, &json!({"type":"pong"}));
                }
            }
            "pause" => {
                if self.ui_clients.contains(&conn) {
                    self.ui_paused.insert(conn);
                    if let Some(gate) = self.out_gates.get(&conn) {
                        gate.paused.store(true, Ordering::Relaxed);
                    }
                    // A client that can take its own acks while quiet says so
                    // (the web). iOS does not: it treats `opened` as «attached»
                    // and would then skip the resubscribe that replays what the
                    // pause dropped.
                    if v.get("acks").and_then(Value::as_bool) == Some(true) {
                        self.ui_paused_acks.insert(conn);
                    }
                }
            }
            "resume" => {
                self.ui_paused_acks.remove(&conn);
                if let Some(gate) = self.out_gates.get(&conn) {
                    gate.paused.store(false, Ordering::Relaxed);
                }
                if self.ui_paused.remove(&conn) {
                    let snap = self.snapshot_for(conn);
                    self.send_to(conn, &snap);
                    // Read marks broadcast while paused were dropped with the rest.
                    self.send_session_reads(conn);
                }
            }
            "register_push" => {
                // A support account gets no notifications about the customer's
                // sessions, now or after its grant.
                if self
                    .ui_access
                    .get(&conn)
                    .is_some_and(|a| crate::support_access::is_support_user(&a.user_id))
                {
                    return;
                }
                let token = v
                    .get("deviceToken")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if token.len() > 4096 || token.starts_with("fcm:") {
                    return;
                }
                let platform = v.get("platform").and_then(Value::as_str).unwrap_or("ios");
                if !matches!(platform, "ios" | "android") {
                    return;
                }
                let token = if platform == "android" {
                    format!("fcm:{token}")
                } else {
                    token
                };
                if !token.is_empty() && token != "fcm:" {
                    let Some(user_id) = self.ui_access.get(&conn).map(|a| a.user_id.clone()) else {
                        return;
                    };
                    if !self.push_devices.contains_key(&token) {
                        // Per-user cap first: a phone re-registering after every
                        // reinstall must not own the table. Evict THAT user's
                        // oldest, then keep the global bound.
                        let mine: Vec<(String, i64)> = self
                            .push_devices
                            .iter()
                            .filter(|(_, (_, u))| *u == user_id)
                            .map(|(k, (t, _))| (k.clone(), *t))
                            .collect();
                        if mine.len() >= MAX_PUSH_DEVICES_PER_USER {
                            if let Some((oldest, _)) = mine.iter().min_by_key(|(_, t)| *t) {
                                self.push_devices.remove(oldest);
                            }
                        }
                        if self.push_devices.len() >= MAX_PUSH_DEVICES {
                            if let Some(oldest) = self
                                .push_devices
                                .iter()
                                .min_by_key(|(_, (t, _))| *t)
                                .map(|(k, _)| k.clone())
                            {
                                self.push_devices.remove(&oldest);
                            }
                        }
                    }
                    self.push_devices.insert(token, (now_ms(), user_id));
                }
            }
            "unregister_push" => {
                let token = v.get("deviceToken").and_then(Value::as_str).unwrap_or("");
                let key = if v.get("platform").and_then(Value::as_str) == Some("android") {
                    format!("fcm:{token}")
                } else {
                    token.to_string()
                };
                if self.push_devices.get(&key).is_some_and(|(_, owner)| {
                    self.ui_access
                        .get(&conn)
                        .is_some_and(|access| &access.user_id == owner)
                }) {
                    self.push_devices.remove(&key);
                }
            }
            // `compact` belongs here and was missing since the feature landed
            // (30f4882). `route_to_agent` has had a working "compact" arm all
            // along, but nothing ever reached it: this list is the only caller,
            // so the message fell through to the `_ => {}` at the bottom of
            // `on_ui_msg` and was dropped without a log or a refusal. Every
            // client was affected — the web «Сжать» button and iOS's
            // ClientMessage.compact alike — and the symptom was a button that
            // did nothing at all rather than one that failed.
            "input" | "interrupt" | "compact" | "close" | "tool_decision" | "rescan" => {
                self.route_to_agent(conn, ty, &v)
            }
            message::RPC_REQUEST => self.route_rpc_request(conn, &v),
            "term_open" => {
                let machine_id = v
                    .get("machineId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if !self.ui_can_control_machine(conn, &machine_id) {
                    self.deny(conn, "Terminal access denied.");
                    return;
                }
                if !self.agent_online(&machine_id) {
                    self.send_to(
                        conn,
                        &json!({"type":"error","message":"Machine is offline."}),
                    );
                    return;
                }
                // The browser allocates the id so it can correlate the ack; fall
                // back to a fresh one only for older clients that omit it.
                // Client-supplied, and it becomes a map key and an audit row:
                // anything that is not a short id is replaced.
                let term_id = v
                    .get("termId")
                    .and_then(Value::as_str)
                    .filter(|t| !t.is_empty() && t.len() <= 64)
                    .map(str::to_string)
                    .unwrap_or_else(|| Uuid::new_v4().to_string());
                // The id is the client's choice, so it must not let one browser
                // take over another's stream: re-using an id that a DIFFERENT
                // connection holds is refused rather than overwriting the entry.
                if self
                    .terminals
                    .get(&term_id)
                    .is_some_and(|(owner, _)| *owner != conn)
                {
                    self.deny(conn, "Terminal id is already in use.");
                    return;
                }
                self.terminals
                    .insert(term_id.clone(), (conn, machine_id.clone()));
                // A live shell is the widest thing the product hands out and it
                // left no trace but a socket. The owner's own audit trail now
                // shows every one, including those opened by `deploy/term.sh`.
                // `machineId` in the metadata is what lets the machine's owner
                // (not only the workspace owner) see the row (`audit_events`).
                let cwd: String = v
                    .field_str("cwd")
                    .map(|c| c.chars().take(512).collect())
                    .unwrap_or_default();
                self.audit_ui(
                    conn,
                    "terminal.opened",
                    "machine",
                    &machine_id,
                    json!({"machineId": machine_id, "termId": term_id, "cwd": cwd}),
                );
                self.send_to_agent(&machine_id, &json!({"type":"term_open","termId":term_id,"cwd":v.get("cwd").cloned().unwrap_or(Value::Null)}));
            }
            "term_input" | "term_resize" | "term_close" => {
                let term_id = v
                    .get("termId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if let Some((owner_conn, machine_id)) = self.terminals.get(&term_id).cloned() {
                    if owner_conn != conn {
                        return;
                    }
                    self.send_to_agent(&machine_id, &v);
                    if ty == "term_close" {
                        self.terminals.remove(&term_id);
                    }
                }
            }
            "mirror_open" => {
                let machine_id = v
                    .get("machineId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let session_id = v.get("sessionId").and_then(Value::as_str).unwrap_or("");
                let cwd = v.get("cwd").and_then(Value::as_str);
                if !self.ui_can_view_session(conn, &machine_id, session_id, cwd) {
                    self.deny(conn, "Session access denied.");
                    return;
                }
                // The agent resolves the transcript by this folder; tell it the
                // hub's own record, not the client's claim (see route_rpc_request).
                let known_cwd = if session_id.is_empty() {
                    None
                } else {
                    self.known_session_cwd(&machine_id, session_id)
                };
                let cwd = known_cwd.as_deref().or(cwd);
                if !self.ui_can_control_machine(conn, &machine_id) {
                    self.audit_ui(
                        conn,
                        "session.mirrored",
                        "session",
                        session_id,
                        json!({"machineId":machine_id}),
                    );
                }
                if !self.agent_online(&machine_id) {
                    self.send_to(
                        conn,
                        &json!({"type":"error","message":"Machine is offline."}),
                    );
                    return;
                }
                let mirror_id = v
                    .get("mirrorId")
                    .and_then(Value::as_str)
                    .filter(|t| !t.is_empty() && t.len() <= 64)
                    .map(str::to_string)
                    .unwrap_or_else(|| Uuid::new_v4().to_string());
                // Same rule as `term_open`: an id held by another connection is
                // not taken over.
                if self
                    .mirrors
                    .get(&mirror_id)
                    .is_some_and(|(owner, _)| *owner != conn)
                {
                    self.deny(conn, "Mirror id is already in use.");
                    return;
                }
                self.mirrors
                    .insert(mirror_id.clone(), (conn, machine_id.clone()));
                self.mirror_sessions.insert(
                    mirror_id.clone(),
                    (session_id.to_string(), cwd.map(str::to_string)),
                );
                self.send_to_agent(
                    &machine_id,
                    &json!({
                        "type":"mirror_open","mirrorId":mirror_id,
                        "sessionId": v.get("sessionId").cloned().unwrap_or(Value::Null),
                        "cwd": cwd.map_or(Value::Null, |c| json!(c)),
                    }),
                );
                self.send_to(
                    conn,
                    &json!({"type":"mirror_opened","mirrorId":mirror_id,"machineId":machine_id}),
                );
            }
            "mirror_close" => {
                let mirror_id = v
                    .get("mirrorId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if self
                    .mirrors
                    .get(&mirror_id)
                    .is_some_and(|(owner, _)| *owner != conn)
                {
                    return;
                }
                self.mirror_sessions.remove(&mirror_id);
                if let Some((_, machine_id)) = self.mirrors.remove(&mirror_id) {
                    self.send_to_agent(
                        &machine_id,
                        &json!({"type":"mirror_close","mirrorId":mirror_id}),
                    );
                }
            }
            "set_model" | "set_permission_mode" | "set_effort" => {
                let run_id = v
                    .get("runId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if let Some(run) = self.runs.get(&run_id) {
                    let machine_id = run.machine_id.clone();
                    if !self.ui_can_drive_run(conn, run) {
                        self.deny(conn, "Run control denied.");
                        return;
                    }
                    self.send_to_agent(&machine_id, &v);
                }
            }
            "set_stage" => {
                let machine_id = v
                    .get("machineId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let session_id = v
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if machine_id.is_empty() || session_id.is_empty() {
                    return;
                }
                if !self.ui_can_control_machine(conn, &machine_id)
                    && !self.ui_owns_session(conn, &machine_id, &session_id)
                {
                    self.deny(conn, "Machine control denied.");
                    return;
                }
                let Some(actor) = self.ui_access.get(&conn).map(|a| a.user_id.clone()) else {
                    return;
                };
                // Validate against the known stages; an unknown/absent value clears it.
                let stage = v
                    .get("stage")
                    .and_then(Value::as_str)
                    .filter(|s| STAGE_IDS.contains(s));
                if let Err(e) =
                    self.workspaces
                        .set_session_stage(&machine_id, &session_id, &actor, stage)
                {
                    eprintln!("[hub] set_session_stage failed: {e}");
                    return;
                }
                // Assigning a stage to a previously-unowned session makes the actor
                // its owner (owner_user_id is NOT NULL) — matches the DB upsert.
                let entry = self
                    .session_meta
                    .entry(format!("{machine_id}::{session_id}"))
                    .or_insert_with(|| SessionMeta {
                        owner_user_id: actor.clone(),
                        category: None,
                        stage: None,
                        origin: None,
                    });
                let was = entry.stage.clone();
                entry.stage = stage.map(str::to_string);
                // A stage lives in `session_owners` as the CURRENT value and
                // nothing else — no history, no actor, no clock. So «who closed
                // what, and when» is unanswerable from that row however much UI
                // is built over it, and every day without this line is a day
                // missing from any future report. The audit table already keys on
                // (workspace, created_at) for exactly this shape of question.
                if was.as_deref() != stage {
                    self.audit_ui(conn, "session.stage", "session", &session_id, {
                        // Absent, not null: a stage the session never had
                        // is a field that is not there. Same rule the wire
                        // schemas keep (zod `optional` is `T | absent`),
                        // and this metadata is read back through one.
                        let mut meta = json!({"machineId": machine_id});
                        if let Some(from) = &was {
                            meta["from"] = Value::String(from.clone());
                        }
                        if let Some(to) = stage {
                            meta["to"] = Value::String(to.to_string());
                        }
                        meta
                    });
                }
                let mut delta =
                    json!({"type":"session_stage","machineId":machine_id,"sessionId":session_id});
                if let Some(st) = stage {
                    delta["stage"] = Value::String(st.to_string());
                }
                self.broadcast_machine_private(&machine_id, &delta);
            }
            "end_session" => {
                let machine_id = v
                    .get("machineId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let session_id = v
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if machine_id.is_empty() || session_id.is_empty() {
                    return;
                }
                if !self.ui_can_control_machine(conn, &machine_id)
                    && !self.ui_owns_session(conn, &machine_id, &session_id)
                {
                    self.deny(conn, "Machine control denied.");
                    return;
                }
                // A cc-remote-driven run → clean close; an editor-held (external)
                // session → ask the agent to SIGTERM its writer.
                let run_id = self
                    .runs
                    .iter()
                    .find(|(_, r)| r.machine_id == machine_id && r.session_id == session_id)
                    .map(|(id, _)| id.clone());
                if let Some(run_id) = run_id {
                    self.send_to_agent(&machine_id, &json!({"type":"close","runId":run_id}));
                    self.end_run(&run_id, "session marked finished");
                    self.broadcast_activity();
                } else {
                    self.send_to_agent(
                        &machine_id,
                        &json!({"type":"end_external_session","sessionId":session_id}),
                    );
                }
            }
            _ => {}
        }
    }

    fn open_run(&mut self, conn: ConnId, v: &Value, force: bool) {
        let machine_id = v
            .get("machineId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let can_control = self.ui_can_control_machine(conn, &machine_id);
        if !self.ui_can_start_machine(conn, &machine_id) {
            self.deny(conn, "This machine is read-only in the selected workspace.");
            return;
        }
        let session_id = v
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if self.session_erased(&machine_id, &session_id) {
            self.deny(conn, "Session access denied.");
            return;
        }
        let message = v.get("message").and_then(Value::as_str).map(str::to_string);
        // Optional base64 image attachments for the first turn — validated and
        // bounded (drops junk/oversized entries; a bare `[]` becomes None).
        let (images, files) = sanitize_attachments(v.get("images"), v.get("files"));
        self.report_attachment_loss(
            conn,
            v.get("images"),
            v.get("files"),
            images.as_ref(),
            files.as_ref(),
        );

        let spec = ResumeSpec {
            sealed: sealed_turn(v),
            machine_id: machine_id.clone(),
            session_id: session_id.clone(),
            message,
            images,
            files,
            force,
            picked: start_settings(v, false),
            attach: Some(conn),
            can_control,
            origin: self.ui_kind.get(&conn).cloned(),
            run_by: self.ui_run_by(conn),
        };
        let run_id = match self.resume_session(spec) {
            Ok(run_id) => run_id,
            Err(frame) => {
                self.send_to(conn, &frame);
                return;
            }
        };
        // A takeover kills whoever was writing the session — often the person
        // at the keyboard. It is the one control action that destroys someone
        // else's work, so it leaves a row the machine's owner can see.
        if force {
            self.audit_ui(
                conn,
                "session.takeover",
                "session",
                &session_id,
                json!({"machineId": machine_id, "runId": run_id}),
            );
        }
    }

    /// Resume an existing session as a new run, with the viewer's own
    /// authorization already settled by the caller. Split out of `open_run` so
    /// a session can also be continued with nobody watching (the fleet API,
    /// `fleet_api.rs`) through the SAME single-writer checks: the livePid
    /// refusal, the per-session lock, the archived-transcript refusal. Returns
    /// the run id, or the `error` frame to show the requester.
    fn resume_session(&mut self, spec: ResumeSpec) -> Result<String, Value> {
        let ResumeSpec {
            sealed,
            machine_id,
            session_id,
            message,
            images,
            files,
            force,
            picked,
            attach,
            can_control,
            origin,
            run_by,
        } = spec;
        // A private machine takes content only sealed: plaintext here would sit
        // in this hub's memory and replay buffer, which is what privacy forbids.
        let private = self.machine_private(&machine_id);
        if private
            && sealed.is_none()
            && (message.as_deref().is_some_and(|m| !m.trim().is_empty())
                || images.is_some()
                || files.is_some())
        {
            return Err(
                json!({"type":"error","code":"private_machine","message":PRIVATE_PLAINTEXT_REFUSAL}),
            );
        }
        let Some(agent) = self.agents.get(&machine_id) else {
            return Err(error_frame("Machine is offline."));
        };
        // During the 15s reconnect grace the agent entry survives without a
        // socket. Opening then would take the single-writer lock and send the
        // resume into the void — refuse up front instead.
        if !self.agent_online(&machine_id) {
            return Err(error_frame(
                "Machine is reconnecting; try again in a moment.",
            ));
        }
        let session = agent
            .sessions
            .iter()
            .find(|s| s.get("sessionId").and_then(Value::as_str) == Some(session_id.as_str()));
        let Some(session) = session else {
            // Gone from disk, still in the replica: it is listed (as archived)
            // and can be read, but the SDK has no transcript to resume from.
            let message = if self.store.is_archived(&machine_id, &session_id) {
                "Сессия в архиве: файл переписки удалён с машины, её можно читать, но не продолжить."
            } else {
                "Session not found or has no cwd."
            };
            return Err(error_frame(message));
        };
        // A private machine's summary carries no cwd (it is in `cwdE2e`); the
        // agent finds the folder of a session id on its own disk.
        let Some(cwd) = session
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| private.then(String::new))
        else {
            return Err(error_frame("Session not found or has no cwd."));
        };
        // Control-share members may only resume sessions they can see (their own
        // or a teammate's — never the device owner's / unowned). Full control skips.
        // A caller with no viewer at all and no full control is refused too,
        // so a future unattended caller cannot skip this rule by accident.
        if !can_control {
            let Some(conn) = attach else {
                return Err(error_frame("Session access denied."));
            };
            if !self.ui_can_view_session(conn, &machine_id, &session_id, Some(&cwd))
                || !self.ui_can_work_in(conn, &machine_id, &session_id, Some(&cwd))
            {
                return Err(error_frame("Session access denied."));
            }
        }
        // The run reflects the session's RECORDED owner/category (not the resumer),
        // so a teammate resuming still shows the original owner's badge.
        let (owner_user_id, owner_name, category) = match self
            .session_meta
            .get(&format!("{machine_id}::{session_id}"))
        {
            Some(meta) => {
                let name = self
                    .user_display
                    .get(&meta.owner_user_id)
                    .and_then(|u| {
                        u.get("fullName")
                            .or_else(|| u.get("email"))
                            .and_then(Value::as_str)
                    })
                    .map(str::to_string);
                (
                    Some(meta.owner_user_id.clone()),
                    name,
                    meta.category.clone(),
                )
            }
            None => (None, None, None),
        };
        // Nothing the hub shows or pushes is built from a private session's
        // placeholder title; clients read the sealed one.
        let title = session
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|_| !private);
        let project = session
            .get("project")
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|_| !private);
        // 'codex' routes the agent to the Codex `exec` runtime; the hub itself
        // stays source-agnostic and just forwards the discriminator.
        let source = session
            .get("source")
            .and_then(Value::as_str)
            .map(str::to_string);
        // A service UI pass starts on Codex only (`new_session`), and resumes on
        // it only: a Claude session sitting in the matter would run on the
        // device owner's Claude login. (No `source` = a legacy Claude session.)
        if attach.is_some_and(|c| self.is_scoped(c)) && source.as_deref() != Some("codex") {
            return Err(error_frame(
                "Only Codex sessions can be continued from this connection.",
            ));
        }
        let machine_name = agent
            .machine
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if !force {
            if let Some(pid) = session.get("livePid").and_then(Value::as_i64) {
                let ep = session
                    .get("entrypoint")
                    .and_then(Value::as_str)
                    .unwrap_or("an editor");
                return Err(error_frame(&format!(
                    "Session is live in {ep} (pid {pid}); refusing to open a second writer."
                )));
            }
        }
        let key = format!("{machine_id}::{session_id}");
        if let Some(run_id) = self.lock_by_key.get(&key) {
            // The refusal names the run it lost to, so the client can WATCH it
            // instead of fighting the lock (the CLI has done this since b0503f9;
            // the web relies on it when the run hasn't reached its `activeRuns`
            // yet). `takeover` shares this path and gets the same recovery.
            return Err(json!({
                "type": "error",
                "code": "run_active",
                "runId": run_id,
                "message": "Session already has an active run.",
            }));
        }

        // The previous run is over but its process may still be exiting: the
        // lock is free, the writer is not. A takeover waits too: it can kill
        // what a pid file names, and a Codex app-server names itself nowhere —
        // after an agent restart the new process has no `dying` entry to wait
        // on, and the hub's guard is the only thing between it and a second
        // writer. Eight seconds at most; the refusal says to retry.
        if self.writer_closing(&key) {
            return Err(error_frame(WRITER_CLOSING_REFUSAL));
        }

        let run_id = Uuid::new_v4().to_string();
        self.lock_by_key.insert(key, run_id.clone());
        let turn = match &sealed {
            Some(s) => s
                .turn
                .as_ref()
                .map(|t| user_turn_frame_sealed(&run_id, &session_id, t)),
            None => user_turn_frame(
                &run_id,
                &session_id,
                message.as_deref(),
                images.as_ref(),
                files.as_ref(),
            ),
        };
        let mut browsers = HashSet::new();
        if let Some(conn) = attach {
            browsers.insert(conn);
        }
        let has_msg = message
            .as_deref()
            .map(|m| !m.trim().is_empty())
            .unwrap_or(false)
            || images.is_some()
            // A first turn made of files alone is still a turn — the block
            // below sends it, so the card must open as working like it does.
            || files.is_some()
            || sealed.is_some();
        // A resumed session with a turn opens straight as working, past
        // `run_working`: the last turn's «что дальше» is spent here.
        if has_msg {
            self.watch_digests
                .remove(&format!("{machine_id}::{session_id}"));
        }
        self.runs.insert(
            run_id.clone(),
            ActiveRun {
                machine_id: machine_id.clone(),
                machine_name,
                session_id: session_id.clone(),
                title,
                project,
                origin,
                browsers,
                state: if has_msg {
                    "working".into()
                } else {
                    "idle".into()
                },
                preview: None,
                text_buf: String::new(),
                replay: VecDeque::new(),
                mode_frame: None,
                settings_frame: None,
                background_frame: None,
                subagents_frame: None,
                plan: None,
                context_frame: None,
                replay_bytes: 0,
                since: now_ms(),
                task_started_at: None,
                opened_at: now_ms(),
                pending_request_id: None,
                pending_tool: None,
                pending_tool_input: None,
                pending_tool_title: None,
                last_user_text: if sealed.is_none() {
                    message
                        .as_deref()
                        .map(|m| truncate(m.trim(), 2000))
                        .unwrap_or_default()
                } else {
                    String::new()
                },
                last_error: None,
                pending_tool_e2e: None,
                last_event_at: now_ms(),
                last_event_sent_at: now_ms(),
                awaiting_tool: false,
                compacting: false,
                turn_failed: false,
                owner_user_id,
                owner_name,
                category,
                cwd: Some(cwd.clone()).filter(|c| !c.is_empty()),
                source: source.clone(),
            },
        );

        // takeover carries the optional first message inline so the agent sends it
        // only AFTER it holds the session (post-kill); resume takes a separate input.
        let action = if force { "takeover" } else { "resume" };
        let mut cmd = json!({"type":action,"sessionId":session_id,"cwd":cwd,"runId":run_id});
        if let Some(src) = source.as_ref() {
            cmd["source"] = Value::String(src.clone());
        }
        // Model / effort picked in the composer before continuing — validated
        // like `new_session`'s, a bad value dropped rather than failing the
        // open. The mode is NOT taken here: a resumed session keeps its own.
        if let Some(model) = picked.model {
            cmd["model"] = Value::String(model);
        }
        if let Some(effort) = picked.effort {
            cmd["effort"] = Value::String(effort);
        }
        let run_by_for_input = run_by.clone();
        if let Some(by) = run_by {
            cmd["runBy"] = by;
        }
        if force {
            if let Some(s) = &sealed {
                cmd["e2e"] = s.e2e.clone();
            }
            if let Some(msg) = message.as_ref().filter(|m| !m.trim().is_empty()) {
                cmd["message"] = Value::String(msg.clone());
            }
            if let Some(imgs) = images.clone() {
                cmd["images"] = imgs;
            }
            if let Some(fs) = files.clone() {
                cmd["files"] = fs;
            }
        }
        self.send_to_agent(&machine_id, &cmd);
        if !force {
            let has_text = message
                .as_deref()
                .map(|m| !m.trim().is_empty())
                .unwrap_or(false);
            if has_text || images.is_some() || files.is_some() || sealed.is_some() {
                let mut inp =
                    json!({"type":"input","runId":run_id,"text":message.unwrap_or_default()});
                if let Some(s) = &sealed {
                    inp["e2e"] = s.e2e.clone();
                }
                if let Some(imgs) = images {
                    inp["images"] = imgs;
                }
                if let Some(fs) = files {
                    inp["files"] = fs;
                }
                if let Some(by) = run_by_for_input {
                    inp["by"] = by;
                }
                self.send_to_agent(&machine_id, &inp);
            }
        }
        if let Some(conn) = attach {
            self.send_to(
                conn,
                &json!({"type":"opened","runId":run_id,"machineId":machine_id,"sessionId":session_id}),
            );
        }
        self.announce_user_turn(&run_id, turn);
        self.broadcast_activity();
        println!(
            "[hub] run {run_id} {} on {machine_id} for session {session_id}",
            if force { "takeover" } else { "opened" }
        );
        Ok(run_id)
    }

    /// An audit row for something a `/ui` connection did, attributed to its
    /// viewer in its workspace. Best effort: an audit failure never blocks the
    /// action, the hub log still has the `println!` beside every call.
    /// A stop is the one act a person later asks «who did that?» about: the
    /// journal line names the device, the audit row keeps it. Written when the
    /// request leaves for the agent: the press is the fact asked about, even if
    /// the agent then finds the helper already gone.
    fn audit_stop(&self, conn: ConnId, action: &str, machine_id: &str, session_id: &str, id: &str) {
        let sign_in = self.ui_sessions.get(&conn);
        let device = sign_in
            .and_then(|s| self.workspaces.session_label(s))
            .unwrap_or_else(|| "?".to_string());
        // Two «Chrome · macOS» are told apart by the sign-in: the token HASH,
        // the same id «Где я вошёл» lists — it names a session, it cannot open one.
        let sign_in: String = sign_in
            .map(|s| s.chars().take(12).collect())
            .unwrap_or_default();
        let user = self
            .ui_access
            .get(&conn)
            .map(|a| a.user_id.as_str())
            .unwrap_or("?");
        println!(
            "[hub] {action}: session {session_id} id {id} by {user} via «{device}» sign-in {sign_in}"
        );
        self.audit_ui(
            conn,
            action,
            "session",
            session_id,
            json!({"machineId": machine_id, "id": id, "device": device, "signIn": sign_in}),
        );
    }

    /// Support accounts' gate and trace for one `/ui` frame; `true` = the
    /// connection was dropped because the grant is over. For every other user
    /// this is one prefix compare. The trace is the frame's TYPE and the ids it
    /// points at (`ui_audit_shape`), written before the handler runs and also
    /// for a frame the handler then refuses; the sweep tick is not the only
    /// thing that ends a grant, the clock is checked here too.
    fn support_gate(&mut self, conn: ConnId, ty: &str, v: &Value) -> bool {
        let Some(user) = self
            .ui_access
            .get(&conn)
            .map(|a| a.user_id.as_str())
            .filter(|u| crate::support_access::is_support_user(u))
            .map(str::to_string)
        else {
            return false;
        };
        if !self.workspaces.support_gate(&user) {
            println!("[hub] closing /ui conn {conn}: the support grant is over");
            self.on_disconnect(conn);
            return true;
        }
        if crate::support_access::UI_UNLOGGED.contains(&ty) {
            return false;
        }
        let (meta, kind, target) = crate::support_access::ui_audit_shape(v);
        // The same row again within the window is the same act: keystrokes,
        // the chunks of one upload, a poll. The key is the row itself.
        let key = format!("{conn}|{kind}|{target}|{meta}");
        let now = now_ms();
        if self
            .support_logged
            .get(&key)
            .is_some_and(|at| now - at < crate::support_access::DUPLICATE_EVERY_MS)
        {
            return false;
        }
        // Fail closed: a frame whose trace cannot be written does not run.
        if self
            .workspaces
            .audit_support(&user, "support.ui", kind, &target, &meta)
            .is_err()
        {
            self.send_to(
                conn,
                &json!({"type":"error","message":"The action log is unavailable, so nothing was done."}),
            );
            return true;
        }
        if self.support_logged.len() > 512 {
            self.support_logged.clear();
        }
        self.support_logged.insert(key, now);
        false
    }

    /// Close what an ended support grant leaves open: the grants past their
    /// deadline are tidied (`sweep_support_expired`), then every socket of a
    /// support account whose grant is no longer good goes.
    fn sweep_support_grants(&mut self) {
        if let Err(e) = self.workspaces.sweep_support_expired() {
            eprintln!("[hub] support sweep failed: {e}");
        }
        let dead: Vec<ConnId> = self
            .ui_access
            .iter()
            .filter(|(_, a)| {
                crate::support_access::is_support_user(&a.user_id)
                    && !self.workspaces.support_gate(&a.user_id)
            })
            .map(|(conn, _)| *conn)
            .collect();
        for conn in dead {
            println!("[hub] closing /ui conn {conn}: the support grant is over");
            self.on_disconnect(conn);
        }
        // Nothing of a client's may keep reaching a support account's phone.
        let workspaces = &self.workspaces;
        self.push_devices
            .retain(|_, (_, user)| workspaces.support_gate(user));
    }

    fn audit_ui(&self, conn: ConnId, action: &str, kind: &str, target: &str, meta: Value) {
        if let Some(access) = self.ui_access.get(&conn) {
            // What someone does on their OWN machine goes to their personal
            // log, whichever workspace the socket landed in. A team owner
            // reads the team log in full (`audit_events`), not root by root,
            // so routing by "is the machine shared here" would leak a private
            // cwd or session id from outside the shared root. This is where
            // these rows always went for anyone who landed in «Моя работа»;
            // teammates' actions on a shared machine still go to the team.
            let own_machine = meta
                .get("machineId")
                .and_then(Value::as_str)
                .and_then(|m| self.workspaces.device_owner(m).ok().flatten())
                .is_some_and(|owner| owner == access.user_id);
            let workspace = own_machine
                .then(|| self.workspaces.personal_workspace_of(&access.user_id))
                .flatten()
                .unwrap_or_else(|| access.workspace_id.clone());
            if let Err(e) =
                self.workspaces
                    .audit(&workspace, &access.user_id, action, kind, target, &meta)
            {
                eprintln!("[hub] audit {action} failed: {e}");
            }
        }
    }

    /// Start a brand-new session in `cwd` (no sessionId yet). No live-writer check
    /// applies — the session doesn't exist. The agent mints the real id and reports
    /// it via `session_started`, at which point we re-key the single-writer lock.
    fn new_session(&mut self, conn: ConnId, v: &Value) {
        let machine_id = v
            .get("machineId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let can_control = self.ui_can_control_machine(conn, &machine_id);
        if !self.ui_can_start_machine(conn, &machine_id) {
            self.deny(conn, "This machine is read-only in the selected workspace.");
            return;
        }
        let cwd = v
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let message = v.get("message").and_then(Value::as_str).map(str::to_string);
        if cwd.trim().is_empty() {
            self.send_to(
                conn,
                &json!({"type":"error","message":"A working directory is required."}),
            );
            return;
        }
        // Control-share members can only start inside a shared root.
        if !can_control {
            let within = self
                .ui_access
                .get(&conn)
                .and_then(|a| self.workspaces.machine_access(a, &machine_id).ok())
                .map(|ma| ma.allows_start_path(&cwd))
                .unwrap_or(false);
            if !within {
                self.deny(conn, "That directory isn't shared with you.");
                return;
            }
        }
        // Employees (workspace `member`s) default new coding sessions to Codex on
        // the shared HegAI gateway (ChatGPT/Bifrost) rather than the host machine's
        // Claude login, which belongs to the owner. Owners/managers keep Claude.
        // Soft default: this only steers brand-new sessions — members can still
        // resume or take over existing sessions of either kind.
        // Owners and managers now say which agent they want (the picker on the
        // start screen). Pinned to Codex on the gateway regardless when: the
        // machine is a hosted sandbox (no Claude login exists there), or the
        // viewer is a member driving someone else's machine (Claude there
        // would spend the device owner's login). A member on a machine they
        // own themselves keeps the picker — the login being spent is theirs.
        let sandbox = self
            .workspaces
            .device_kind(&machine_id)
            .ok()
            .flatten()
            .as_deref()
            == Some("sandbox");
        let requested = v
            .get("source")
            .and_then(Value::as_str)
            .filter(|s| *s == "claude" || *s == "codex")
            .map(str::to_string);
        // A sandbox is no longer pinned to Codex (24.09.2026): its owner logs
        // into Claude or Codex from «Начало» like on any machine, and the
        // picker follows what is logged in. `sandbox` still matters below —
        // it is the machine whose own login is being spent, so a member on it
        // stays pinned exactly like on any other shared box.
        let _ = sandbox;
        // Anyone who does not control the machine spends the device owner's
        // login on Claude, whatever their role (a workspace owner listed on a
        // restricted share is not a member and still must not).
        let source = if !can_control {
            Some("codex".to_string())
        } else {
            requested
        };
        let StartSettings {
            permission_mode,
            model,
            effort,
        } = start_settings(
            v,
            self.machine_offers_bypass(&machine_id, source.as_deref()),
        );
        let (owner_user_id, owner_name) = self.ui_owner(conn);
        let spec = SpawnSpec {
            sealed: sealed_turn(v),
            machine_id,
            cwd,
            message,
            images: v.get("images").cloned(),
            files: v.get("files").cloned(),
            category: v
                .get("category")
                .and_then(Value::as_str)
                .map(str::to_string),
            source,
            require_gateway: false,
            permission_mode,
            model,
            effort,
            owner_user_id,
            owner_name,
            origin: self.ui_kind.get(&conn).cloned(),
            attach: Some(conn),
            run_by: self.ui_run_by(conn),
        };
        if let Err(message) = self.spawn_session(spec) {
            self.send_to(conn, &json!({"type":"error","message":message}));
        }
    }

    /// Birth of a run, with every authorization question already settled.
    ///
    /// Split out of `new_session` so a session can also be started with nobody
    /// watching: the backend-spec intake opens one on the owner's behalf, hours
    /// before they look at it. That caller has no connection to read an identity
    /// or a target from, so both arrive explicitly in the spec.
    ///
    /// Returns the run id, or a message fit to show the requester.
    fn spawn_session(&mut self, spec: SpawnSpec) -> Result<String, String> {
        let SpawnSpec {
            sealed,
            machine_id,
            cwd,
            message,
            images,
            files,
            category,
            source,
            require_gateway,
            permission_mode,
            model,
            effort,
            owner_user_id,
            owner_name,
            origin,
            attach,
            run_by,
        } = spec;
        // Validate the optional category against the skill registry (drop unknown).
        let category = category.and_then(|c| {
            CATEGORY_SKILLS
                .iter()
                .find(|(id, _)| *id == c)
                .map(|(id, _)| id.to_string())
        });
        let skill = category
            .as_deref()
            .filter(|_| !require_gateway)
            .and_then(|c| {
                CATEGORY_SKILLS
                    .iter()
                    .find(|(id, _)| *id == c)
                    .map(|(_, s)| *s)
            });
        // A private machine takes content only sealed (see `resume_session`).
        // Also stops the hub's own intakes (backend specs) from typing a
        // plaintext prompt into one.
        let private = self.machine_private(&machine_id);
        if private
            && sealed.is_none()
            && (message.as_deref().is_some_and(|m| !m.trim().is_empty())
                || images.is_some()
                || files.is_some())
        {
            return Err(PRIVATE_PLAINTEXT_REFUSAL.into());
        }
        let Some(agent) = self.agents.get(&machine_id) else {
            return Err("Machine is offline.".into());
        };
        if !self.agent_online(&machine_id) {
            return Err("Machine is reconnecting; try again in a moment.".into());
        }
        if require_gateway {
            if source.as_deref() != Some("codex") {
                return Err("Internal gateway jobs require Codex.".into());
            }
            if agent
                .machine
                .get("gatewaySessions")
                .and_then(Value::as_bool)
                != Some(true)
            {
                return Err("Agent must be updated to enforce internal gateway jobs.".into());
            }
        }
        let machine_name = agent
            .machine
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let run_id = Uuid::new_v4().to_string();
        // Temp lock keyed on the run (no session id yet); re-keyed on session_started.
        if let Some(owner) = &owner_user_id {
            self.workspaces.remember_pending_session(
                &run_id,
                &machine_id,
                owner,
                category.as_deref(),
                origin.as_deref().filter(|o| *o == "fleet"),
            )?;
        }
        self.lock_by_key
            .insert(format!("{machine_id}::__new__::{run_id}"), run_id.clone());
        let project = cwd
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .filter(|s| !s.is_empty() && !private)
            .map(str::to_string);
        // Bound images the same way open/takeover/input do — new_session is the
        // one path that used to forward them raw (screenshot -> new session).
        let (images_in, files_in) = (images, files);
        let (images, files) = sanitize_attachments(images_in.as_ref(), files_in.as_ref());
        if let Some(conn) = attach {
            self.report_attachment_loss(
                conn,
                images_in.as_ref(),
                files_in.as_ref(),
                images.as_ref(),
                files.as_ref(),
            );
        }
        // A category rewrites the first turn to invoke its skill (`/<skill> text`),
        // so a categorized session opens already in that workflow.
        let user_text = message.as_deref().map(str::trim).filter(|m| !m.is_empty());
        let outgoing: Option<String> = match (skill, user_text) {
            (Some(sk), Some(text)) => Some(format!("/{sk} {text}")),
            (Some(sk), None) => Some(format!("/{sk}")),
            (None, Some(text)) => Some(text.to_string()),
            (None, None) => None,
        };
        let has_msg = outgoing.is_some() || images.is_some() || files.is_some() || sealed.is_some();
        // What the person typed, not the skill-prefixed `outgoing`: the screen
        // shows their words, the same text the sending composer echoed.
        let turn = match &sealed {
            Some(s) => s
                .turn
                .as_ref()
                .map(|t| user_turn_frame_sealed(&run_id, "", t)),
            None => user_turn_frame(&run_id, "", user_text, images.as_ref(), files.as_ref()),
        };
        let mut browsers = HashSet::new();
        if let Some(conn) = attach {
            browsers.insert(conn);
        }
        self.runs.insert(
            run_id.clone(),
            ActiveRun {
                machine_id: machine_id.clone(),
                machine_name,
                session_id: String::new(),
                // Built from the first prompt - which a private machine never
                // shows the hub - so there is none.
                title: (!private).then(|| provisional_title(user_text)),
                project,
                origin,
                browsers,
                state: if has_msg {
                    "working".into()
                } else {
                    "idle".into()
                },
                preview: None,
                text_buf: String::new(),
                replay: VecDeque::new(),
                mode_frame: None,
                settings_frame: None,
                background_frame: None,
                subagents_frame: None,
                plan: None,
                context_frame: None,
                replay_bytes: 0,
                since: now_ms(),
                task_started_at: None,
                opened_at: now_ms(),
                pending_request_id: None,
                pending_tool: None,
                pending_tool_input: None,
                pending_tool_title: None,
                last_user_text: user_text.map(|t| truncate(t, 2000)).unwrap_or_default(),
                last_error: None,
                pending_tool_e2e: None,
                last_event_at: now_ms(),
                last_event_sent_at: now_ms(),
                awaiting_tool: false,
                compacting: false,
                turn_failed: false,
                owner_user_id,
                owner_name,
                category,
                cwd: Some(cwd.clone()),
                source: source.clone(),
            },
        );
        let mut cmd = json!({"type":"new_session","runId":run_id,"cwd":cwd});
        if require_gateway {
            cmd["requireGateway"] = json!(true);
        }
        if let Some(by) = run_by {
            cmd["runBy"] = by;
        }
        if let Some(source) = source {
            cmd["source"] = Value::String(source);
        }
        if let Some(mode) = permission_mode {
            cmd["permissionMode"] = Value::String(mode);
        }
        if let Some(model) = model {
            cmd["model"] = Value::String(model);
        }
        if let Some(effort) = effort {
            cmd["effort"] = Value::String(effort);
        }
        if let Some(s) = &sealed {
            cmd["e2e"] = s.e2e.clone();
        }
        if let Some(text) = &outgoing {
            cmd["message"] = Value::String(text.clone());
        }
        if let Some(imgs) = images {
            cmd["images"] = imgs;
        }
        if let Some(fs) = files {
            cmd["files"] = fs;
        }
        self.send_to_agent(&machine_id, &cmd);
        // Attach the browser to the run immediately via the empty-id `opened`.
        if let Some(conn) = attach {
            self.send_to(
                conn,
                &json!({"type":"opened","runId":run_id,"machineId":machine_id,"sessionId":""}),
            );
        }
        self.announce_user_turn(&run_id, turn);
        self.broadcast_activity();
        println!("[hub] new session run {run_id} on {machine_id} in {cwd}");
        Ok(run_id)
    }

    fn route_to_agent(&mut self, conn: ConnId, ty: &str, v: &Value) {
        if ty == "rescan" {
            if let Some(machine_id) = v.get("machineId").and_then(Value::as_str) {
                // A rescan is a background nudge, not an action the person took:
                // iOS sends one on every return to the app and the web after a
                // rename. A share member who may not control the machine used to
                // get «Machine control denied.» shown as an error for it. Drop it
                // quietly instead — the agent is still never asked.
                if !self.ui_can_control_machine(conn, machine_id) {
                    return;
                }
                self.send_to_agent(machine_id, &json!({"type":"rescan"}));
            }
            return;
        }
        let run_id = v
            .get("runId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let Some(run) = self.runs.get(&run_id) else {
            // `code` so the client can give a typed message its text back rather
            // than drop it. Everything routed here is addressed to a specific
            // run; if the run is gone, nothing was delivered.
            self.send_to(
                conn,
                &json!({
                    "type":"error",
                    "code":"run_gone",
                    "message":"That session is no longer running — it was closed or it ended. Your message was not sent."
                }),
            );
            return;
        };
        let machine_id = run.machine_id.clone();
        let can_drive = self.ui_can_drive_run(conn, run);
        if !can_drive {
            self.deny(conn, "Run control denied.");
            return;
        }
        // The run is alive but its agent has no socket right now (reconnecting,
        // held under the run lease). `send_to_agent` would drop the frame on the
        // floor — for up to the whole lease, a message typed into a healthy-
        // looking session went nowhere and nothing said so. Only `close`
        // checked this; every other command must too. `code` lets the client
        // give the text back rather than flash a sentence and lose it.
        if !self.agent_online(&machine_id) {
            self.send_to(
                conn,
                &json!({
                    "type":"error",
                    "code":"machine_offline",
                    "message":"Machine is reconnecting — nothing was sent. Try again in a moment."
                }),
            );
            return;
        }
        // Driving a run means watching it. Said here because `run.browsers` does
        // not survive a hub RESTART, while the run itself does: the agent
        // reconnects and reclaims its runs under their original ids, so a client
        // that was already attached sees an unchanged runId in the next snapshot
        // and never thinks to re-subscribe. The result is a session that looks
        // live and never updates again — typing works, nothing comes back, and
        // nothing on either side reports a fault, because both sides are fine.
        //
        // A newer client re-subscribes on every socket open, which fixes it
        // going forward. This fixes it for the client already open, on the very
        // next thing it sends — including the message someone types to ask why
        // it is quiet. Idempotent: `browsers` is a set.
        let mut reattached: Vec<Value> = Vec::new();
        if let Some(run) = self.runs.get_mut(&run_id) {
            if run.browsers.insert(conn) {
                println!("[hub] re-attached a driving viewer to run {run_id}");
                reattached.extend(run.background_frame.clone());
                reattached.extend(run.subagents_frame.clone());
                reattached.extend(run.context_frame.clone());
            }
        }
        // A viewer attached this way missed the levels the hub now forwards only
        // when they change (context budget, sub-agents) and the background tasks:
        // state them, as `subscribe` does.
        for frame in reattached {
            self.send_to(conn, &frame);
        }
        match ty {
            "input" if sealed_turn(v).is_some() => {
                // Private machine: both envelopes are opaque here. The agent
                // gets the first, the other screens the second; the hub builds
                // no text, no preview, no attachment count.
                let sealed = sealed_turn(v).expect("checked by the guard");
                let session_id = self
                    .runs
                    .get(&run_id)
                    .map(|r| r.session_id.clone())
                    .unwrap_or_default();
                let turn = sealed
                    .turn
                    .as_ref()
                    .map(|t| user_turn_frame_sealed(&run_id, &session_id, t));
                let mut input = json!({"type":"input","runId":run_id,"text":"","e2e":sealed.e2e});
                if let Some(by) = self.ui_run_by(conn) {
                    input["by"] = by;
                }
                self.send_to_agent(&machine_id, &input);
                self.announce_user_turn(&run_id, turn);
            }
            "input" if self.machine_private(&machine_id) => {
                if v.get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|t| !t.trim().is_empty())
                    || v.get("images").is_some_and(|i| !i.is_null())
                    || v.get("files").is_some_and(|i| !i.is_null())
                {
                    self.send_to(
                        conn,
                        &json!({"type":"error","code":"private_machine","message":PRIVATE_PLAINTEXT_REFUSAL}),
                    );
                }
            }
            "input" => {
                let (images, files) = sanitize_attachments(v.get("images"), v.get("files"));
                self.report_attachment_loss(
                    conn,
                    v.get("images"),
                    v.get("files"),
                    images.as_ref(),
                    files.as_ref(),
                );
                let images = images.unwrap_or(Value::Null);
                let files = files.unwrap_or(Value::Null);
                let session_id = self
                    .runs
                    .get(&run_id)
                    .map(|r| r.session_id.clone())
                    .unwrap_or_default();
                let turn = user_turn_frame(
                    &run_id,
                    &session_id,
                    v.get("text").and_then(Value::as_str),
                    Some(&images),
                    Some(&files),
                );
                let mut input = json!({"type":"input","runId":run_id,"text":v.get("text").cloned().unwrap_or(Value::Null),"images":images,"files":files});
                // Who typed it — the starter's identity is fixed per coder
                // process, a colleague's turn must stay distinguishable.
                if let Some(by) = self.ui_run_by(conn) {
                    input["by"] = by;
                }
                self.send_to_agent(&machine_id, &input);
                self.announce_user_turn(&run_id, turn);
                if let Some(text) = v.get("text").and_then(Value::as_str) {
                    self.note_user_text(&run_id, text);
                }
            }
            "interrupt" => {
                // An interrupt also ends every background helper the run holds.
                let session_id = self
                    .runs
                    .get(&run_id)
                    .map(|r| r.session_id.clone())
                    .unwrap_or_default();
                self.audit_stop(conn, "run.interrupted", &machine_id, &session_id, &run_id);
                self.send_to_agent(&machine_id, &json!({"type":"interrupt","runId":run_id}))
            }
            "compact" => self.send_to_agent(&machine_id, &json!({"type":"compact","runId":run_id})),
            "close" => {
                // Releasing frees the session's single-writer lock, so it is only
                // safe once the agent has actually been told to stop (the
                // offline check above guarantees the frame will be delivered).
                self.send_to_agent(&machine_id, &json!({"type":"close","runId":run_id}));
                self.end_run(&run_id, "closed from a Hegai Code client");
            }
            "tool_decision" => {
                // A private machine takes an answer's content only sealed. Refused
                // BEFORE anything is cleared: the approval stays pending for the
                // person to answer properly.
                if self.machine_private(&machine_id) && sealed_turn(v).is_none() {
                    self.send_to(
                        conn,
                        &json!({"type":"error","code":"private_machine","message":PRIVATE_PLAINTEXT_REFUSAL}),
                    );
                    return;
                }
                let mut decision = json!({
                        "type":"tool_decision",
                        "requestId": v.get("requestId").cloned().unwrap_or(Value::Null),
                        "allow": v.get("allow").cloned().unwrap_or(Value::Bool(false)),
                        // Carries an AskUserQuestion answer / approved-plan selection back
                        // to the SDK. clean() strips it when null so zod's optional (T |
                        // absent, never null) stays satisfied.
                        "updatedInput": v.get("updatedInput").cloned().unwrap_or(Value::Null),
                        // ExitPlanMode can atomically select default/review-edits or
                        // acceptEdits, matching Claude Code's native plan dialog.
                        "permissionMode": v.get("permissionMode").cloned().unwrap_or(Value::Null),
                        "message": v.get("message").cloned().unwrap_or(Value::Null),
                });
                // Private machine: the answer travels sealed; the hub only
                // forwards the envelope.
                if let Some(env) = sealed_turn(v) {
                    decision["e2e"] = env.e2e;
                    decision["updatedInput"] = Value::Null;
                    decision["message"] = Value::Null;
                }
                // Who answered: accepting a plan launches a turn, so the answer
                // counts for authorship like an input.
                if let Some(by) = self.ui_run_by(conn) {
                    decision["by"] = by;
                }
                self.send_to_agent(&machine_id, &decision);
                // Forget the pending approval and tell the other viewers.
                self.settle_tool_request(&run_id, v.field_string("requestId"));
            }
            _ => {}
        }
    }

    /// Adopt the session's real title (and project) for runs on this machine.
    /// A run started by `new_session` is named before its transcript exists, so
    /// without this it keeps the provisional name for its whole life — days, and
    /// in every push notification too.
    fn refresh_run_titles(&mut self, machine_id: &str) {
        let Some(agent) = self.agents.get(machine_id) else {
            return;
        };
        let known: HashMap<String, (Option<String>, Option<String>)> = agent
            .sessions
            .iter()
            .filter_map(|s| {
                let sid = s.get("sessionId").and_then(Value::as_str)?.to_string();
                let title = s
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .map(str::to_string);
                let project = s.get("project").and_then(Value::as_str).map(str::to_string);
                Some((sid, (title, project)))
            })
            .collect();
        let mut changed = false;
        for run in self.runs.values_mut() {
            if run.machine_id != machine_id || run.session_id.is_empty() {
                continue;
            }
            let Some((title, project)) = known.get(&run.session_id) else {
                continue;
            };
            if let Some(title) = title {
                if run.title.as_deref() != Some(title.as_str()) {
                    run.title = Some(title.clone());
                    changed = true;
                }
            }
            if project.is_some() && &run.project != project {
                run.project = project.clone();
                changed = true;
            }
        }
        if changed {
            self.broadcast_activity();
        }
    }

    // ---------------------------------------------------------------- runs
    /// True while `key` ("machine::session") is guarded by a writer that may
    /// still be exiting. An expired guard counts as free and is dropped here, so
    /// a session never stays refused on the strength of a map nobody swept.
    fn writer_closing(&mut self, key: &str) -> bool {
        match self.closing_writers.get(key) {
            Some(closing) if closing.until_ms > now_ms() => true,
            Some(_) => {
                self.closing_writers.remove(key);
                false
            }
            None => false,
        }
    }

    /// Housekeeping: forget the guards whose deadline has passed, so the map
    /// does not grow with every close whose `writer_released` never came.
    fn expire_closing_writers(&mut self) {
        let now = now_ms();
        self.closing_writers
            .retain(|_, closing| closing.until_ms > now);
    }

    fn release_run(&mut self, run_id: &str) {
        // Whatever the reason for the release, this run is no longer a candidate
        // for re-adoption — drop it from the orphan list so the map can't leak.
        self.orphaned_runs.remove(run_id);
        if let Some(run) = self.runs.remove(run_id) {
            self.lock_by_key
                .remove(&format!("{}::{}", run.machine_id, run.session_id));
            // A new_session run that died before session_started still holds its
            // temp lock keyed on the run id (session_id is still ""); clear it too
            // so lock_by_key doesn't grow forever.
            if run.session_id.is_empty() {
                self.lock_by_key
                    .remove(&format!("{}::__new__::{}", run.machine_id, run_id));
                self.task_links_on_run_released(run_id);
            }
            println!("[hub] run {run_id} released");
        }
    }

    /// Show a person's turn on every screen attached to the run, and keep it in
    /// the replay window so a screen that attaches later — a reconnect, the
    /// desktop opened after the phone sent — gets the question with its answer.
    /// The sender's own pane receives it as well and folds it into its echo
    /// (`foldUserTurn` in web/src/central-reducers.ts).
    fn announce_user_turn(&mut self, run_id: &str, frame: Option<Value>) {
        let Some(frame) = frame else {
            return;
        };
        // A new task: the last one's plan count is not this turn's progress.
        // The agent says `0/0` too, but that frame can be lost to a socket
        // that drops right after the input; the hub sees the turn itself.
        if let Some(run) = self.runs.get_mut(run_id) {
            if run.plan.take().is_some() {
                self.live_dirty.set(true);
            }
            // Any human turn (text or attachments alone) spends the last
            // turn's «что дальше» (WATCH.md §4).
            let key = format!("{}::{}", run.machine_id, run.session_id);
            self.watch_digests.remove(&key);
        }
        // Rights are checked at `subscribe` and never again for the model's
        // stream; a person's own words are the most private thing in a
        // session, and this fires once per turn, so ask again here — a share
        // revoked or an account suspended since that socket subscribed stops
        // receiving them. The run's owner is theirs by definition.
        if let Some(run) = self.runs.get(run_id) {
            if !self.session_erased(&run.machine_id, &run.session_id) {
                for b in &run.browsers {
                    if self.ui_can_see_run(*b, run) {
                        self.send_to(*b, &frame);
                    }
                }
            }
        }
        self.remember_stream_frame(run_id, &frame);
    }

    fn to_run_browsers(&self, run_id: &str, v: &Value) {
        if let Some(run) = self.runs.get(run_id) {
            if self.session_erased(&run.machine_id, &run.session_id) {
                return;
            }
            self.send_to_many(run.browsers.iter().copied(), v);
        }
    }

    /// `send_to` for several viewers of one frame: cleaned and serialized ONCE
    /// instead of once per viewer. Falls back to `send_to` per viewer while a
    /// reply is being tagged for a pane (`reply_ref`): then each copy may differ.
    fn send_to_many(&self, conns: impl Iterator<Item = ConnId>, v: &Value) {
        if self.reply_ref.is_some() {
            for conn in conns {
                self.send_to(conn, v);
            }
            return;
        }
        let ty = v.get("type").and_then(Value::as_str).unwrap_or("");
        let mut wire: Option<String> = None;
        for conn in conns {
            if !self.conns.contains_key(&conn) || self.pause_gate_blocks(conn, ty) {
                continue;
            }
            let text = wire.get_or_insert_with(|| clean(v).to_string()).clone();
            self.send_raw(conn, text);
        }
    }

    /// Route a tool-approval prompt to everyone who can actually answer it: the
    /// attached clients that may drive this run. That is its owner AND a
    /// colleague who picked the session up — the case this used to break, where
    /// a session paused on a question (an approval, a plan to confirm) and the
    /// person now looking at it never saw the prompt, because it went only to
    /// the recorded owner. A read-only viewer is not in `browsers` at all — a
    /// mirror is its own channel — so nobody is dragged into a decision they
    /// cannot make. Two deciders is not a problem: the agent settles the request
    /// once and a second answer lands on a requestId it no longer knows.
    fn to_run_deciders(&self, run_id: &str, v: &Value) {
        let Some(run) = self.runs.get(run_id) else {
            return;
        };
        let deciders: Vec<ConnId> = run
            .browsers
            .iter()
            .copied()
            .filter(|c| self.ui_can_drive_run(*c, run))
            .collect();
        if !deciders.is_empty() {
            for b in deciders {
                self.send_to(b, v);
            }
            return;
        }
        // Nobody attached may drive it — better a prompt in front of someone than
        // a session stuck forever on an unanswered question.
        for b in &run.browsers {
            self.send_to(*b, v);
        }
    }

    // ------------------------------------------------------- attention state
    /// Transition a run into "working". Only broadcasts on an actual change and
    /// clears the turn buffer so a fresh preview accumulates — this keeps token
    /// streaming from spamming an activity broadcast per chunk.
    /// Append one browser-bound stream frame to the run's replay window, evicting
    /// from the front so neither the frame count nor the byte total can run away.
    ///
    /// The window is compacted as it fills, because every subscribe sends it
    /// whole, frame by frame, and a client folds each one into its transcript.
    /// A 40-minute turn kept ~400 frames — one per token delta — and every
    /// open of the session replayed them: the steps "played back" from the
    /// start and the phone lagged through it (24.10.2026). Three rules, each
    /// leaving what a client ends up showing unchanged:
    /// - adjacent `partial` deltas are one frame: clients append a delta to
    ///   the open streaming line, so the concatenation folds identically;
    /// - `assistant` repeats the whole block the deltas spelled, and replaces
    ///   the open streaming line with it, so it takes the deltas' frame in
    ///   place (statuses in between do not close a sentence on any client);
    /// - a heartbeat (`requesting`, `turn_usage`) is a latest-value reading
    ///   no client draws as a line: only the newest of each code is kept.
    pub(crate) fn remember_stream_frame(&mut self, run_id: &str, frame: &Value) {
        let Some(run) = self.runs.get_mut(run_id) else {
            return;
        };
        // Private machine: a sealed frame cannot be merged or replaced - its
        // text is an envelope the hub cannot concatenate. Kept as it came (the
        // window is still bounded by `trim_replay`); clients fold them.
        if frame["event"].get("e2e").is_some() {
            let size = json_len(frame);
            run.replay.push_back(frame.clone());
            run.replay_bytes += size;
            trim_replay(run);
            return;
        }
        if is_stream_kind(frame, "partial") {
            if let Some(last) = run
                .replay
                .back_mut()
                .filter(|f| is_stream_kind(f, "partial"))
            {
                let piece = frame["event"]["text"].as_str().unwrap_or_default();
                // Once per token, inside the loop that serves the whole fleet:
                // never re-serialise the growing frame. JSON escapes per
                // character, so the frame grows by exactly the escaped piece.
                if let Some(old) = last["event"]["text"].as_str() {
                    let joined = format!("{old}{piece}");
                    let grow = Value::String(piece.to_owned()).to_string().len() - 2;
                    last["event"]["text"] = Value::String(joined);
                    run.replay_bytes += grow;
                } else {
                    let before = json_len(last);
                    last["event"]["text"] = Value::String(piece.to_owned());
                    let after = json_len(last);
                    run.replay_bytes = run.replay_bytes.saturating_sub(before) + after;
                }
                trim_replay(run);
                return;
            }
        }
        if is_stream_kind(frame, "assistant") {
            let open = run
                .replay
                .iter()
                .rposition(|f| !is_stream_kind(f, "status"))
                .filter(|&i| is_stream_kind(&run.replay[i], "partial"));
            if let Some(i) = open {
                // In the deltas' place, not at the tail: a status shown between
                // (stderr, an API retry) stays after the sentence it followed,
                // exactly as the live fold left it.
                let size = json_len(frame);
                let dropped = std::mem::replace(&mut run.replay[i], frame.clone());
                run.replay_bytes = run.replay_bytes.saturating_sub(json_len(&dropped)) + size;
                trim_replay(run);
                return;
            }
        }
        if let Some(code) = heartbeat_code(frame) {
            if let Some(i) = run
                .replay
                .iter()
                .rposition(|f| heartbeat_code(f) == Some(code))
            {
                if let Some(dropped) = run.replay.remove(i) {
                    run.replay_bytes = run.replay_bytes.saturating_sub(json_len(&dropped));
                }
            }
        }
        let size = json_len(frame);
        run.replay.push_back(frame.clone());
        run.replay_bytes += size;
        trim_replay(run);
    }

    /// The run is doing something. Does NOT forget a pending approval: a
    /// status line arriving while the CLI waits on a question (stderr, a
    /// queued compaction, an API retry) is not the question being answered.
    ///
    /// And while that approval is still pending the run STAYS
    /// `needs_attention`. It used to flip to `working` and back, and the
    /// commonest trigger was not a status line at all: every agent reconnect
    /// re-announces its runs (`announceState`, `agent/src/run-manager.ts`) as
    /// `run_status: started` followed by the same `tool_request`. So a machine
    /// whose socket blipped turned every question waiting on it into
    /// needs_attention → working → needs_attention — a fresh transition that
    /// every notifier (the desktop tray, the web, the phone, APNs via
    /// `emit_push`) announced again as if it had just been asked. Only
    /// something that ANSWERS the question — a model token (`turn_moved_on`),
    /// a decision, the turn ending — clears the prompt, and only then may the
    /// state move on.
    fn run_working(&mut self, run_id: &str) {
        let changed = match self.runs.get_mut(run_id) {
            Some(r) if r.state == "needs_attention" && r.pending_request_id.is_some() => false,
            Some(r) if r.state != "working" => {
                r.state = "working".into();
                r.since = now_ms();
                r.text_buf.clear();
                r.turn_failed = false;
                // A new turn: the last one's «что дальше» is spent. Judged here,
                // on the hub's clock, not by the agent's `lastModified` alone.
                let key = format!("{}::{}", r.machine_id, r.session_id);
                self.watch_digests.remove(&key);
                true
            }
            _ => false,
        };
        if changed {
            self.broadcast_activity();
        }
    }

    /// The model produced something — a token, a tool call — so whatever
    /// approval it was stopped on has been decided (or timed out). This is the
    /// only stream evidence that may forget a pending prompt; `run_working`
    /// alone used to, and a stderr line mid-question left the run showing
    /// «working» while the CLI sat on a question nobody could see any more.
    fn turn_moved_on(&mut self, run_id: &str) {
        if let Some(r) = self.runs.get_mut(run_id) {
            r.pending_request_id = None;
            r.pending_tool = None;
            r.pending_tool_input = None;
            r.pending_tool_title = None;
            r.pending_tool_e2e = None;
        }
        self.run_working(run_id);
    }

    fn run_idle(&mut self, run_id: &str) {
        // Re-announcement is not another completion/read receipt.
        if self.runs.get(run_id).is_some_and(|r| r.state == "idle") {
            return;
        }
        // Every genuine working -> idle transition is a completed turn. The
        // notifier de-dupes repeats, while this state check prevents a later
        // run_status(idle) from sending a second completion after stream(result).
        let mut notify_idle = false;
        let found = match self.runs.get_mut(run_id) {
            Some(r) => {
                notify_idle = r.state == "working";
                r.state = "idle".into();
                r.since = now_ms();
                // The turn landed: drop its replay window so a later subscriber
                // reads the transcript instead of seeing the turn twice.
                r.replay.clear();
                r.replay_bytes = 0;
                r.pending_request_id = None;
                r.pending_tool = None;
                r.pending_tool_input = None;
                r.pending_tool_title = None;
                r.pending_tool_e2e = None;
                let p = truncate(&r.text_buf, 240);
                if !p.is_empty() {
                    r.preview = Some(p);
                }
                true
            }
            None => false,
        };
        if found {
            if notify_idle {
                self.record_completion(run_id);
                self.emit_push(run_id, "idle");
            }
            self.broadcast_activity();
        }
    }

    /// `announce: false` is a prompt the agent re-issued after re-registering
    /// (`replay` on the wire): shown to viewers, never pushed again. A restarted
    /// hub has no memory of what it already announced, and walking the adopted
    /// run idle → working → needs_attention made every deploy re-announce every
    /// question already waiting — Telegram and phones included.
    fn run_needs(&mut self, run_id: &str, announce: bool) {
        // These fns set state unconditionally, so diff here to avoid re-pushing
        // on repeated tool_request frames for the same run.
        let mut changed = false;
        let found = match self.runs.get_mut(run_id) {
            Some(r) => {
                changed = r.state != "needs_attention";
                r.state = "needs_attention".into();
                r.since = now_ms();
                true
            }
            None => false,
        };
        if found {
            if changed && announce {
                self.emit_push(run_id, "needs_attention");
            }
            self.broadcast_activity();
        }
    }

    fn run_error(&mut self, run_id: &str) {
        self.run_error_for(run_id, false);
    }

    /// `releasing`: the caller releases the run right after (a terminal
    /// `run_status: error`), so its push must not offer to reply.
    fn run_error_for(&mut self, run_id: &str, releasing: bool) {
        let mut changed = false;
        let found = match self.runs.get_mut(run_id) {
            Some(r) => {
                changed = r.state != "error";
                r.state = "error".into();
                r.turn_failed = true;
                r.since = now_ms();
                r.replay.clear();
                r.replay_bytes = 0;
                true
            }
            None => false,
        };
        if found {
            if changed && self.error_push_due(run_id) {
                self.emit_push_for(run_id, "error", releasing);
            }
            self.broadcast_activity();
        }
    }

    /// Should this failure reach phones and Telegram, or was it already said?
    ///
    /// Keyed by SESSION, not run: a retry is a fresh run of the same session.
    /// 24.09.2026 a broken login on one machine failed every turn of three
    /// sessions for half an hour, and each retry pushed «сессия упала» again —
    /// the same news per attempt. The first says it; the in-app list still
    /// shows every run's state.
    fn error_push_due(&mut self, run_id: &str) -> bool {
        let Some(r) = self.runs.get(run_id) else {
            return false;
        };
        let key = format!("{}::{}", r.machine_id, r.session_id);
        let now = now_ms();
        self.error_pushed
            .retain(|_, at| now - *at < ERROR_PUSH_REPEAT_MS);
        if self.error_pushed.contains_key(&key) {
            return false;
        }
        self.error_pushed.insert(key, now);
        true
    }

    fn run_json(&self, run_id: &str, r: &ActiveRun) -> Value {
        let pending_kind = r.pending_tool.as_deref().map(pending_kind_of);
        json!({
            "runId": run_id,
            "machineId": r.machine_id,
            "machineName": r.machine_name,
            "sessionId": r.session_id,
            "title": r.title,
            "project": r.project,
            "state": r.state,
            "preview": r.preview,
            "since": r.since,
            "taskStartedAt": r.task_started_at,
            "lastEventAt": r.last_event_at,
            "awaitingTool": r.awaiting_tool,
            "origin": r.origin,
            // clean() strips these when None, keeping zod's optional (T | absent).
            "ownerUserId": r.owner_user_id,
            "ownerName": r.owner_name,
            "category": r.category,
            // What `needs_attention` means here — see `pending_kind_of`.
            "pendingKind": pending_kind,
            "pendingTool": r.pending_tool,
            // Stable across an agent's re-announce, so a notifier can tell a
            // re-issued prompt from a new one (see `run_working`).
            "pendingRequestId": r.pending_request_id,
        })
    }

    /// Tell every listening viewer the board — unless it is exactly the board
    /// that viewer was last sent. A heartbeat of an unrelated run, a run the
    /// viewer cannot see, a re-announce after an agent blip: none changes what
    /// THIS viewer's board says, and each used to cost it a frame to decode and
    /// reconcile. Paused viewers are skipped before the board is built, and
    /// viewers with the same rights share one build.
    fn broadcast_activity(&self) {
        // Whatever a heartbeat owed is carried by this frame.
        self.activity_dirty.set(false);
        // A run moved: the Live Activity looks at the fleet again next tick.
        self.live_dirty.set(true);
        let mut cache = ViewCache::default();
        for conn in &self.ui_clients {
            if self.pause_gate_blocks(*conn, "activity") {
                continue;
            }
            let payload =
                json!({"type":"activity","runs":self.active_runs_cached(*conn, &mut cache)});
            let sig = payload_sig(&payload);
            if self.activity_sent.borrow().get(conn) == Some(&sig) {
                continue;
            }
            self.activity_sent.borrow_mut().insert(*conn, sig);
            self.send_to(*conn, &payload);
        }
    }

    // --------------------------------------------------------- disconnect
    fn on_disconnect(&mut self, conn: ConnId) {
        self.cancel_enrichment(conn);
        self.ui_sessions.remove(&conn);
        self.conns.remove(&conn);
        self.out_gates.remove(&conn);
        self.agent_users.remove(&conn);
        let abandoned: Vec<String> = self
            .pending_replica
            .iter()
            .filter(|(_, p)| p.conn == conn)
            .map(|(id, _)| id.clone())
            .collect();
        for sync_id in abandoned {
            self.abort_pending_sync(&sync_id, "agent disconnected during sync");
        }
        // Agent?
        if let Some(machine_id) = self.conn_machine.remove(&conn) {
            // If a newer socket already took over this machineId, this is a
            // superseded connection (the agent reconnected before we processed
            // its old socket's close) — the register handler already cleaned up
            // after the old socket; leave the live agent untouched.
            let is_current = self
                .agents
                .get(&machine_id)
                .map(|a| a.conn == conn)
                .unwrap_or(false);
            if !is_current {
                return;
            }
            // The agent keeps its runs alive across a socket blip (it reconnects
            // in ~1s and re-declares them on `register`), so releasing here would
            // destroy live work that never actually stopped. Hold them — locks
            // included — and let ReleaseOrphanedRuns clean up whatever the agent
            // does not reclaim. Ptys and pending RPCs have no such continuity:
            // each belongs to a browser subscriber that is already gone.
            self.orphan_machine_runs(&machine_id, conn);
            self.drop_machine_streams(&machine_id);
            // Keep the machine visible (online) through the grace window; only a
            // RemoveStaleAgent that still matches this socket will drop it.
            println!("[hub] agent socket dropped: {machine_id} (machine grace {AGENT_GRACE_SECS}s, run lease {RUN_GRACE_SECS}s)");
            // Two independent clocks: the machine disappears from the UI after
            // the short presentation grace, while its runs keep their locks for
            // the much longer writer lease. Collapsing them would either flicker
            // the board or free a lock while the agent is still writing.
            let tx = self.self_tx.clone();
            let mid = machine_id.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(AGENT_GRACE_SECS)).await;
                let _ = tx.send(HubCmd::RemoveStaleAgent {
                    conn,
                    machine_id: mid,
                });
            });
            let tx = self.self_tx.clone();
            let mid = machine_id.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(RUN_GRACE_SECS)).await;
                let _ = tx.send(HubCmd::ReleaseOrphanedRuns {
                    conn,
                    machine_id: mid,
                });
            });
            return;
        }
        // Browser
        if self.ui_clients.remove(&conn) {
            self.ui_access.remove(&conn);
            self.ui_kind.remove(&conn);
            self.ui_caps.remove(&conn);
            self.ui_stats_interest.remove(&conn);
            self.activity_sent.borrow_mut().remove(&conn);
            self.ui_paused.remove(&conn);
            self.ui_paused_acks.remove(&conn);
            // A UI socket is only a subscriber, never the owner of a run's
            // lifetime. Mobile OSes routinely suspend sockets while the app is
            // backgrounded; stopping here used to kill otherwise healthy work.
            // The agent remains the single writer until an explicit `close`, a
            // terminal run_status, a yield, or an agent disconnect.
            detach_browser_from_runs(&mut self.runs, conn);
            self.pending_rpc.retain(|_, p| p.conn != conn);
            // Nobody else can finish these: free the agent's upload slots now
            // rather than at its ten-minute sweep. The answers match no request
            // and are dropped.
            let orphaned: Vec<(String, String)> = self
                .member_uploads
                .iter()
                .filter(|(_, u)| u.conn == conn)
                .map(|(key, _)| key.clone())
                .collect();
            for key in orphaned {
                self.member_uploads.remove(&key);
                let (machine_id, upload_id) = key;
                self.send_to_agent(
                    &machine_id,
                    &json!({
                        "type": "rpc_request",
                        "requestId": format!("orphan-{upload_id}"),
                        "method": "fs.upload.abort",
                        "params": {"uploadId": upload_id},
                    }),
                );
            }
            let owned_terms: Vec<String> = self
                .terminals
                .iter()
                .filter(|(_, (b, _))| *b == conn)
                .map(|(t, _)| t.clone())
                .collect();
            for term_id in owned_terms {
                if let Some((_, machine_id)) = self.terminals.remove(&term_id) {
                    self.send_to_agent(&machine_id, &json!({"type":"term_close","termId":term_id}));
                }
            }
            let owned_mirrors: Vec<String> = self
                .mirrors
                .iter()
                .filter(|(_, (b, _))| *b == conn)
                .map(|(m, _)| m.clone())
                .collect();
            for mirror_id in owned_mirrors {
                self.mirror_sessions.remove(&mirror_id);
                if let Some((_, machine_id)) = self.mirrors.remove(&mirror_id) {
                    self.send_to_agent(
                        &machine_id,
                        &json!({"type":"mirror_close","mirrorId":mirror_id}),
                    );
                }
            }
        }
    }

    /// Mark every run on a machine as awaiting re-adoption after its agent's
    /// socket dropped. Nothing is released and no viewer is notified: from the
    /// UI's point of view the run simply keeps going, which is the truth as long
    /// as the agent reconnects inside the grace window.
    fn orphan_machine_runs(&mut self, machine_id: &str, conn: ConnId) {
        let live: Vec<String> = self
            .runs
            .iter()
            .filter(|(_, r)| r.machine_id == machine_id)
            .map(|(id, _)| id.clone())
            .collect();
        if live.is_empty() {
            return;
        }
        // An agent that never sent an instance id is running an older bundle
        // that still force-kills its runs the moment its socket drops. There is
        // nothing to re-adopt, so holding its locks would only strand sessions
        // for the lease — give it the immediate release it was built for.
        if !self.agent_instance.contains_key(machine_id) {
            self.release_machine_runs(machine_id, "agent disconnected");
            return;
        }
        println!(
            "[hub] holding {} run(s) on {machine_id} for re-adoption (machine grace {AGENT_GRACE_SECS}s, run lease {RUN_GRACE_SECS}s)",
            live.len()
        );
        for run_id in live {
            self.orphaned_runs.insert(run_id, conn);
        }
    }

    /// Settle a machine's runs against what a (re)registering agent says it is
    /// still driving. A declared run is kept — its writer never stopped, so
    /// re-adoption resurrects nothing and the single-writer invariant is
    /// untouched — and anything else is released now rather than left to leak a
    /// session lock until the grace fires.
    ///
    /// This is the ONLY place a register settles runs, and it must stay that
    /// way: it runs before the supersede branch below, which used to release
    /// every run on the machine on the premise that the agent had already killed
    /// them. That premise is no longer true.
    /// Rebuild a run the hub has no record of, and take its single-writer lock.
    ///
    /// Ownership is NOT invented: it comes from `session_meta`, which is loaded
    /// from the database at boot, so a re-adopted run carries the same owner
    /// badge and the same visibility it had before the restart. A session the
    /// hub has never recorded yields `None`, which the access checks already
    /// treat as "fall back to the project-share filter" (`ui_can_drive_run`) —
    /// the same path an unowned legacy run takes.
    ///
    /// Title and preview are deliberately left empty rather than guessed; the
    /// inventory push that follows every register fills the session list in, and
    /// a wrong title is worse than none.
    fn adopt_declared_run(
        &mut self,
        machine_id: &str,
        machine_name: &str,
        run_id: &str,
        session_id: &str,
        cwd: String,
    ) {
        match self
            .workspaces
            .resolve_pending_session(run_id, machine_id, session_id)
        {
            Ok(_) => self.erased_sessions = self.workspaces.erased_session_keys().ok(),
            Err(_) => return,
        }
        self.refresh_session_owner(machine_id, session_id);
        if self.session_erased(machine_id, session_id) {
            self.send_to_agent(machine_id, &json!({"type":"close","runId":run_id}));
            return;
        }
        let (owner_user_id, owner_name, category) = match self
            .session_meta
            .get(&format!("{machine_id}::{session_id}"))
        {
            Some(meta) => {
                let name = self
                    .user_display
                    .get(&meta.owner_user_id)
                    .and_then(|u| {
                        u.get("fullName")
                            .or_else(|| u.get("email"))
                            .and_then(Value::as_str)
                    })
                    .map(str::to_string);
                (
                    Some(meta.owner_user_id.clone()),
                    name,
                    meta.category.clone(),
                )
            }
            None => (None, None, None),
        };
        let project = cwd
            .trim_end_matches(['/', '\\'])
            .rsplit(['/', '\\'])
            .next()
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        // Its runtime, from the agent's own inventory of the session.
        // An adopted run is idle, and its `since` is when it finished — the
        // stored finish when there is one. Stamping the restart instead made
        // an answer already read elsewhere look new to a device that last saw
        // the run working: its dot came back with a time no read mark covers.
        // Only a restarted hub adopts (a merely reconnecting agent finds its
        // runs still held), so the one turn this can misdate is one that
        // finished inside the restart's few seconds: the hub never stored it,
        // and the older finish hides it. Rarer than the false dot it replaces.
        let adopted_since = owner_user_id
            .as_deref()
            .and_then(|owner| {
                self.workspaces
                    .session_completion_at(owner, machine_id, session_id)
                    .ok()
                    .flatten()
            })
            .unwrap_or_else(now_ms);
        let adopted_source = self
            .agents
            .get(machine_id)
            .and_then(|a| {
                a.sessions
                    .iter()
                    .find(|s| s.get("sessionId").and_then(Value::as_str) == Some(session_id))
            })
            .and_then(|s| s.get("source").and_then(Value::as_str))
            .map(str::to_string);
        self.lock_by_key
            .insert(format!("{machine_id}::{session_id}"), run_id.to_string());
        // A run the agent is genuinely driving is the writer; a guard left by
        // an earlier closing run has nothing more to say.
        self.closing_writers
            .remove(&format!("{machine_id}::{session_id}"));
        self.runs.insert(
            run_id.to_string(),
            ActiveRun {
                machine_id: machine_id.to_string(),
                machine_name: machine_name.to_string(),
                session_id: session_id.to_string(),
                title: None,
                project,
                // Nobody "opened" this from a client — it predates our knowledge
                // of it. The board shows an unknown origin as Web, which is the
                // same thing it does for every legacy run.
                origin: None,
                // Empty: every browser's socket died with ours. They re-attach
                // through `subscribe` once the run shows up in their snapshot.
                browsers: HashSet::new(),
                state: "idle".into(),
                preview: None,
                text_buf: String::new(),
                replay: VecDeque::new(),
                mode_frame: None,
                settings_frame: None,
                background_frame: None,
                subagents_frame: None,
                plan: None,
                context_frame: None,
                replay_bytes: 0,
                since: adopted_since,
                task_started_at: None,
                opened_at: now_ms(),
                pending_request_id: None,
                pending_tool: None,
                pending_tool_input: None,
                pending_tool_title: None,
                last_user_text: String::new(),
                last_error: None,
                pending_tool_e2e: None,
                last_event_at: now_ms(),
                last_event_sent_at: now_ms(),
                awaiting_tool: false,
                compacting: false,
                turn_failed: false,
                owner_user_id,
                owner_name,
                category,
                cwd: Some(cwd),
                source: adopted_source,
            },
        );
        // A run spawned just before a hub restart (a fleet run for a task)
        // learns its session here: the agent's `session_started` died with the
        // old socket.
        self.task_links_on_session_started(run_id, session_id);
        println!("[hub] adopted carried run {run_id} (session {session_id}) from {machine_id}");
    }

    fn settle_agent_runs(
        &mut self,
        conn: ConnId,
        machine_id: &str,
        machine_name: &str,
        declared: &[DeclaredRun],
    ) {
        // A run the agent claims but we have no record of is the HUB-RESTART
        // case: our maps start empty and a deploy restarts the hub, so on the
        // first register every live run in the fleet looks unknown.
        //
        // This used to order each of them closed. The reasoning was sound as far
        // as it went — such a run holds no `lock_by_key` entry, so simply
        // inserting it would manufacture a writer nothing guards, and a second
        // `open_run` on the same session would then be allowed. But the remedy
        // was worse than the disease: every hub deploy silently killed every
        // live run on every machine, and because `release_run` drops the run
        // before the agent's `ended` arrives, `to_run_browsers` had nobody to
        // deliver it to. Work in flight vanished with no message at all.
        //
        // The lock is the whole problem, so take the lock. Adoption rebuilds the
        // run AND claims `lock_by_key` in the same step, which restores exactly
        // the invariant an `open_run` would have established. It is also strictly
        // safer than what came before: the subprocess kept writing either way,
        // but now it is guarded from the moment we hear about it rather than
        // from whenever the close lands.
        //
        // Two shapes still get closed, and both are genuine:
        //   - a run whose session the hub already locked for someone else — the
        //     one case where adopting really would make a second writer;
        //   - a run with no session id (a `new_session` that never got one) or
        //     no cwd (an agent too old to declare it), which cannot be rebuilt
        //     well enough to be locked or made visible.
        //
        // Addressed to the registering socket, not `send_to_agent` — the machine
        // entry still points at the old, dead connection at this point.
        let unknown: Vec<usize> = (0..declared.len())
            .filter(|i| !self.runs.contains_key(&declared[*i].run_id))
            .collect();
        for i in unknown {
            let d = &declared[i];
            let (run_id, session_id, cwd) = (d.run_id.clone(), d.session_id.clone(), d.cwd.clone());
            let refuse = |hub: &mut Self, why: &str| {
                println!("[hub] closing unadoptable run {run_id} from {machine_id}: {why}");
                hub.send_to(conn, &json!({"type":"close","runId":run_id}));
            };
            if session_id.is_empty() {
                refuse(self, "no session id");
                continue;
            }
            let Some(cwd) = cwd else {
                refuse(self, "agent declared no cwd");
                continue;
            };
            let key = format!("{machine_id}::{session_id}");
            if let Some(holder) = self.lock_by_key.get(&key) {
                let why = format!("session already driven by run {holder}");
                refuse(self, &why);
                continue;
            }
            self.adopt_declared_run(machine_id, machine_name, &run_id, &session_id, cwd);
        }

        let owned: Vec<String> = self
            .runs
            .iter()
            .filter(|(_, r)| r.machine_id == machine_id)
            .map(|(id, _)| id.clone())
            .collect();
        if owned.is_empty() {
            return;
        }
        let (mut kept, mut lost) = (0usize, Vec::new());
        for run_id in owned {
            if declared.iter().any(|d| d.run_id == run_id) {
                self.orphaned_runs.remove(&run_id);
                kept += 1;
            } else {
                lost.push(run_id);
            }
        }
        if kept > 0 {
            println!("[hub] re-adopted {kept} run(s) on {machine_id} after reconnect");
        }
        if !lost.is_empty() {
            println!(
                "[hub] releasing {} run(s) on {machine_id} the agent did not reclaim",
                lost.len()
            );
        }
        for run_id in lost {
            self.fail_run(&run_id, "agent reconnected without this run");
        }
        self.broadcast_activity();
    }

    /// The grace window expired. Release every run still waiting on the agent
    /// socket `conn` — a newer socket's runs are keyed to a different ConnId, so
    /// a reconnect that happened meanwhile is never disturbed.
    fn release_orphaned_runs(&mut self, conn: ConnId, machine_id: &str) {
        let stale: Vec<String> = self
            .orphaned_runs
            .iter()
            .filter(|(_, c)| **c == conn)
            .map(|(run_id, _)| run_id.clone())
            .collect();
        if stale.is_empty() {
            return;
        }
        println!(
            "[hub] grace expired on {machine_id}: releasing {} unreclaimed run(s)",
            stale.len()
        );
        for run_id in stale {
            self.orphaned_runs.remove(&run_id);
            self.fail_run(&run_id, "agent disconnected");
        }
        self.broadcast_activity();
    }

    /// Tell a run's viewers it died, then free it and its single-writer lock.
    /// End a run deliberately and SAY SO to everyone watching it.
    ///
    /// The sibling of `fail_run`, for the paths where nothing went wrong —
    /// somebody closed the run, or filed it as done. Those paths used to call
    /// `release_run` straight, which drops the run from `self.runs` before the
    /// agent's own `run_status: ended` comes back; `to_run_browsers` then looks
    /// the run up, finds nothing, and delivers the frame to no one. The person
    /// who clicked knows what happened. Every OTHER viewer of that session just
    /// watched the composer go quiet for no stated reason.
    ///
    /// `reason` rides in the `error` field because that is what the clients
    /// already render for a terminal state (`run ended: …`) — it is the message
    /// slot, not a claim that this was a failure.
    fn end_run(&mut self, run_id: &str, reason: &str) {
        if let Some(run) = self.runs.get(run_id) {
            let sid = run.session_id.clone();
            let browsers: Vec<ConnId> = run.browsers.iter().copied().collect();
            for b in browsers {
                self.send_to(b, &json!({"type":"run_status","runId":run_id,"sessionId":sid,"state":"ended","error":reason}));
            }
        }
        self.release_run(run_id);
        // `run_status` reaches only the clients attached to THIS run. Everyone
        // else — another tab, the board, the desktop shell's tray socket, which
        // attaches to no run at all — would keep the dead run in its list at
        // whatever state it died in. A run that died `needs_attention` then sat
        // in the tray badge as «1 ждёт ответа» with nothing to answer.
        self.broadcast_activity();
    }

    fn fail_run(&mut self, run_id: &str, reason: &str) {
        if let Some(run) = self.runs.get(run_id) {
            let sid = run.session_id.clone();
            let browsers: Vec<ConnId> = run.browsers.iter().copied().collect();
            for b in browsers {
                self.send_to(b, &json!({"type":"run_status","runId":run_id,"sessionId":sid,"state":"error","error":reason}));
            }
        }
        self.release_run(run_id);
        // Same reason as `end_run`: a failure is even likelier to strand a
        // `needs_attention` run, since the thing that failed is often the agent
        // that was holding the question.
        self.broadcast_activity();
    }

    /// Release every run on a machine: notify each run's viewers with an error
    /// run_status, free the single-writer locks, and refresh the board so dead
    /// cards don't linger on other UIs. Used where the machine's work is
    /// genuinely over (device revoked) — NOT on a socket drop, where the runs
    /// keep going and are settled by `settle_agent_runs` on the next register.
    fn release_machine_runs(&mut self, machine_id: &str, reason: &str) {
        let dead: Vec<String> = self
            .runs
            .iter()
            .filter(|(_, r)| r.machine_id == machine_id)
            .map(|(id, _)| id.clone())
            .collect();
        if dead.is_empty() {
            return;
        }
        for run_id in dead {
            if let Some(run) = self.runs.get(&run_id) {
                let sid = run.session_id.clone();
                let browsers: Vec<ConnId> = run.browsers.iter().copied().collect();
                for b in browsers {
                    self.send_to(b, &json!({"type":"run_status","runId":run_id,"sessionId":sid,"state":"error","error":reason}));
                }
            }
            self.release_run(&run_id);
        }
        self.broadcast_activity();
    }

    /// Drop every terminal/mirror/pending-RPC keyed to a machine whose agent
    /// process went away, notifying the owning browsers — otherwise the panes
    /// freeze silently and the map entries leak until the browser disconnects.
    fn drop_machine_streams(&mut self, machine_id: &str) {
        let terms: Vec<String> = self
            .terminals
            .iter()
            .filter(|(_, (_, m))| m == machine_id)
            .map(|(t, _)| t.clone())
            .collect();
        for term_id in terms {
            if let Some((browser, _)) = self.terminals.remove(&term_id) {
                self.send_to(browser, &json!({"type":"term_exit","termId":term_id}));
            }
        }
        let dead_mirrors: Vec<String> = self
            .mirrors
            .iter()
            .filter(|(_, (_, m))| m == machine_id)
            .map(|(id, _)| id.clone())
            .collect();
        for mirror_id in dead_mirrors {
            self.mirror_sessions.remove(&mirror_id);
            if let Some((browser, _)) = self.mirrors.remove(&mirror_id) {
                self.send_to(browser, &json!({"type":"mirror_exit","mirrorId":mirror_id}));
            }
        }
        // A restarted agent has no open uploads left to continue.
        self.member_uploads.retain(|(m, _), _| m != machine_id);
        // Dropping the sender tells the HTTP caller there will be no answer.
        self.service_rpc.retain(|_, (m, _)| m != machine_id);
        let dead_rpcs: Vec<String> = self
            .pending_rpc
            .iter()
            .filter(|(_, p)| p.machine_id == machine_id)
            .map(|(id, _)| id.clone())
            .collect();
        for req_id in dead_rpcs {
            if let Some(pending) = self.pending_rpc.remove(&req_id) {
                self.undo_pending_delete(&pending);
                self.send_to(pending.conn, &json!({"type":"rpc_response","requestId":req_id,"ok":false,"error":"agent disconnected"}));
            }
        }
    }

    /// Grace-window expiry: drop the agent only if its socket was never replaced
    /// by a reconnect. A flapping agent reconnects within the window, so its
    /// machineId now points at a newer socket and this is a no-op.
    fn remove_stale_agent(&mut self, conn: ConnId, machine_id: String) {
        if self
            .agents
            .get(&machine_id)
            .map(|a| a.conn == conn)
            .unwrap_or(false)
        {
            self.agents.remove(&machine_id);
            // Belt and braces: the disconnect path already dropped this
            // machine's streams; anything opened against the entry during the
            // grace window can never answer either.
            self.drop_machine_streams(&machine_id);
            println!("[hub] agent removed after grace: {machine_id}");
            self.broadcast_snapshot();
        }
    }

    // ------------------------------------------------------------ snapshot
    fn session_cwd(&self, machine_id: &str, session_id: &str) -> Option<String> {
        if let Some(cwd) = self
            .agents
            .get(machine_id)
            .and_then(|a| {
                a.sessions
                    .iter()
                    .find(|s| s.get("sessionId").and_then(Value::as_str) == Some(session_id))
            })
            .and_then(|s| s.get("cwd").and_then(Value::as_str))
        {
            return Some(cwd.to_string());
        }
        // Every row, archived ones included: an archived session is readable,
        // and without its recorded cwd the roots check would fall back to the
        // cwd the client named (`ui_can_view_session`).
        self.store.session_cwd(machine_id, session_id)
    }

    /// A run adopted after a hub restart does not say which runtime drives it;
    /// the machine's inventory does, once it arrives. Fills in what is missing.
    fn backfill_run_sources(&mut self, machine_id: &str) {
        let Some(agent) = self.agents.get(machine_id) else {
            return;
        };
        let found: Vec<(String, String)> = self
            .runs
            .iter()
            .filter(|(_, r)| {
                r.machine_id == machine_id && r.source.is_none() && !r.session_id.is_empty()
            })
            .filter_map(|(run_id, r)| {
                agent
                    .sessions
                    .iter()
                    .find(|s| s.get("sessionId").and_then(Value::as_str) == Some(&r.session_id))
                    .and_then(|s| s.get("source").and_then(Value::as_str))
                    .map(|source| (run_id.clone(), source.to_string()))
            })
            .collect();
        for (run_id, source) in found {
            if let Some(run) = self.runs.get_mut(&run_id) {
                run.source = Some(source);
            }
        }
    }

    /// Where the HUB places a session: its inventory/catalog record, else the
    /// folder of a live run of it (a session just started, not yet in the
    /// inventory). Never a client's claim.
    fn known_session_cwd(&self, machine_id: &str, session_id: &str) -> Option<String> {
        self.session_cwd(machine_id, session_id).or_else(|| {
            self.runs
                .values()
                .find(|r| r.machine_id == machine_id && r.session_id == session_id)
                .and_then(|r| r.cwd.clone())
        })
    }

    fn session_erased(&self, machine_id: &str, session_id: &str) -> bool {
        self.erased_sessions.as_ref().is_none_or(|keys| {
            keys.contains(&format!("{machine_id}::{session_id}"))
                || (keys.contains(&format!("{machine_id}::*"))
                    && !self
                        .session_meta
                        .contains_key(&format!("{machine_id}::{session_id}")))
        })
    }

    fn refresh_session_owner(&mut self, machine: &str, session: &str) {
        if let Ok(Some(meta)) = self.workspaces.session_owner_metadata(machine, session) {
            let owner = meta["owner"].as_str().unwrap_or_default().to_string();
            if let Ok(Some(user)) = self.workspaces.user_json(&owner) {
                self.user_display.insert(owner.clone(), user);
            }
            self.session_meta.insert(
                format!("{machine}::{session}"),
                SessionMeta {
                    owner_user_id: owner,
                    category: meta["category"].as_str().map(str::to_string),
                    stage: meta["stage"].as_str().map(str::to_string),
                    origin: meta["origin"].as_str().map(str::to_string),
                },
            );
        }
    }

    fn ui_can_view_session(
        &self,
        conn: ConnId,
        machine_id: &str,
        session_id: &str,
        cwd: Option<&str>,
    ) -> bool {
        if self.session_erased(machine_id, session_id) {
            return false;
        }
        let Some(access) = self.ui_access.get(&conn) else {
            return false;
        };
        if !access.is_active() {
            return false;
        }
        let Ok(machine_access) = self.workspaces.machine_access(access, machine_id) else {
            return false;
        };
        if !machine_access.can_view {
            return false;
        }
        // The hub's own record of where the session lives WINS over the cwd
        // the caller passed in. `session.messages` takes both a sessionId
        // and a cwd from the client, and the replica read is keyed on
        // machine+session alone — so trusting the supplied cwd let a
        // control-share member name any session on the machine, pass their
        // own shared root as the cwd, and clear the roots check for a
        // transcript outside their share. The same path decides whether an
        // `everyone` share opens the session below.
        //
        // A session id the hub does not know is NOT placed by the caller's
        // word: the agent resolves a transcript by id and ignores `cwd`, so
        // "an unknown id plus my own shared root" used to read anything. Where
        // the hub knows the session is its catalog or a live run of it
        // (`known_session_cwd`); the supplied `cwd` is taken only for the
        // id-less brand-new run, whose folder the hub itself passes in.
        let path = if machine_access.roots.is_some() || machine_access.owner_scoped {
            if session_id.is_empty() {
                cwd.map(str::to_string)
            } else {
                self.known_session_cwd(machine_id, session_id)
            }
        } else {
            None
        };
        // Inside a share, and not inside a restricted one this viewer is shut
        // out of — a broader share never reopens a nested restricted one.
        if machine_access.roots.is_some() || !machine_access.denied_roots.is_empty() {
            let allowed = path
                .as_deref()
                .is_some_and(|path| machine_access.allows_path(path));
            if !allowed {
                return false;
            }
        }
        // Control-share members additionally see only member-owned sessions
        // (or everything under an `everyone` root).
        if machine_access.owner_scoped {
            let device_owner = self.workspaces.device_owner(machine_id).ok().flatten();
            if !session_visible(
                &machine_access,
                self.session_owner(machine_id, session_id),
                device_owner.as_deref(),
                path.as_deref(),
            ) {
                return false;
            }
        }
        true
    }

    fn scoped_machine(&self, conn: ConnId, mut machine: Value) -> Option<Value> {
        let machine_id = machine
            .get("machine")?
            .get("machineId")?
            .as_str()?
            .to_string();
        let access = self.ui_access.get(&conn)?;
        // Before activation there are no machines — not even control-shares.
        // The product decision is "only the waiting screen until then".
        if !access.is_active() {
            return None;
        }
        let machine_access = self.workspaces.machine_access(access, &machine_id).ok()?;
        if !machine_access.can_view {
            return None;
        }
        // Device owner is only needed to hide the owner's own sessions from
        // control-share members — fetch it once (not per session).
        let device_owner = if machine_access.owner_scoped {
            self.workspaces.device_owner(&machine_id).ok().flatten()
        } else {
            None
        };
        if let Some(arr) = machine.get_mut("sessions").and_then(Value::as_array_mut) {
            let roots = machine_access.roots.as_ref();
            arr.retain(|s| {
                let sid = s.get("sessionId").and_then(Value::as_str).unwrap_or("");
                if self.session_erased(&machine_id, sid) {
                    return false;
                }
                let cwd = s.get("cwd").and_then(Value::as_str);
                if roots.is_some() || !machine_access.denied_roots.is_empty() {
                    let allowed = cwd.is_some_and(|cwd| machine_access.allows_path(cwd));
                    if !allowed {
                        return false;
                    }
                }
                if machine_access.owner_scoped {
                    let sid = s.get("sessionId").and_then(Value::as_str).unwrap_or("");
                    if !session_visible(
                        &machine_access,
                        self.session_owner(&machine_id, sid),
                        device_owner.as_deref(),
                        cwd,
                    ) {
                        return false;
                    }
                }
                true
            });
            // Annotate surviving sessions with owner + category for badges/chips
            // (all viewers — Owner sees owners on everything, employees on teammates).
            for s in arr.iter_mut() {
                let sid = s
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if let Some(meta) = self.session_meta.get(&format!("{machine_id}::{sid}")) {
                    // A service UI pass is not told who the device owner is,
                    // even through the sessions they own (listed colleagues
                    // stay named).
                    let is_device_owner = access.ui_scope.is_some()
                        && device_owner.as_deref() == Some(meta.owner_user_id.as_str());
                    if is_device_owner {
                        if let Some(obj) = s.as_object_mut() {
                            obj.remove("owner");
                        }
                    } else if let Some(u) = self.user_display.get(&meta.owner_user_id) {
                        s["owner"] = u.clone();
                    }
                    if let Some(cat) = &meta.category {
                        s["category"] = Value::String(cat.clone());
                    }
                    if let Some(stage) = &meta.stage {
                        s["stage"] = Value::String(stage.clone());
                    }
                    // Fleet-spawned sessions are agent jobs: hide like cron.
                    if meta.origin.as_deref() == Some("fleet") {
                        s["automated"] = Value::Bool(true);
                    }
                }
            }
        }
        machine["canControl"] = Value::Bool(machine_access.can_control);
        machine["canStart"] = Value::Bool(machine_access.can_control || machine_access.can_start);
        if !machine_access.can_control {
            if let Some(obj) = machine.as_object_mut() {
                obj.remove("usage");
                obj.remove("codexUsage");
                obj.remove("profile");
                obj.remove("stats");
                obj.remove(wire::field::RUNTIMES);
            }
        }
        // (The device owner's identity is not for a service UI pass.)
        if access.ui_scope.is_none() {
            if let Ok(Some(owner)) = self.workspaces.owner_json(&machine_id) {
                machine["owner"] = owner;
            }
        }
        // A hosted sandbox is marked so the UI can hide the Claude/Codex
        // picker and show the chip; a personal device omits the field.
        if self
            .workspaces
            .device_kind(&machine_id)
            .ok()
            .flatten()
            .as_deref()
            == Some(wire::field::MACHINE_KIND_SANDBOX)
        {
            machine[wire::field::MACHINE_KIND] =
                Value::String(wire::field::MACHINE_KIND_SANDBOX.into());
        }
        // Does anybody but the owner work here? `kind` cannot answer that (see
        // `device_has_shares`), and the web has no other way to tell a shared
        // box from a personal one.
        //
        // Set in the per-viewer funnel rather than in `machine_entry_from` on
        // purpose. This is a fact about the workspace DB, not about the agent
        // or the cached replica row, and EVERY machine passes through here —
        // online ones out of `agents`, offline ones out of
        // `store.machine_snapshots` — on the way to both the snapshot and the
        // `machine_sessions` delta. So the field survives a machine being
        // offline with no replica column to keep in sync, and a share added or
        // revoked while the box was down is right on the next frame instead of
        // waiting for the agent to come back and re-publish itself.
        //
        // Costs one indexed EXISTS per machine per viewer, alongside the
        // `device_kind` lookup already standing here. Unknown reads as "not
        // shared": this one only labels, and a wrong label that claims a
        // personal box is shared is the more misleading of the two.
        if self
            .workspaces
            .device_has_shares(&machine_id)
            .unwrap_or(false)
        {
            machine[wire::field::MACHINE_SHARED] = Value::Bool(true);
        }
        Some(machine)
    }

    fn active_runs_json_for(&self, conn: ConnId) -> Value {
        if !self.ui_is_active(conn) {
            return Value::Array(Vec::new());
        }
        Value::Array(
            self.runs
                .iter()
                // A brand-new, id-less run of yours is visible before its owner
                // row lands; an established one answers to the share ACL.
                .filter(|(_, r)| self.ui_can_see_run(conn, r))
                .map(|(run_id, r)| {
                    let mut json = self.run_json(run_id, r);
                    // Not the device owner's identity, for a service UI pass.
                    if self.is_scoped(conn)
                        && r.owner_user_id.is_some()
                        && r.owner_user_id
                            == self.workspaces.device_owner(&r.machine_id).ok().flatten()
                    {
                        if let Some(obj) = json.as_object_mut() {
                            obj.remove("ownerUserId");
                            obj.remove("ownerName");
                        }
                    }
                    json
                })
                .collect(),
        )
    }

    /// One ONLINE machine's snapshot entry, before per-viewer scoping. The
    /// snapshot and the `machine_sessions` delta must agree down to the field,
    /// so they are built here rather than twice.
    fn online_machine_entry(&self, machine_id: &str) -> Option<Value> {
        let a = self.agents.get(machine_id)?;
        Some(self.machine_entry_from(machine_id, a))
    }

    fn snapshot_for(&self, conn: ConnId) -> Value {
        self.snapshot_with(conn, &mut ViewCache::default())
    }

    /// What every viewer with the same rights is told, so a broadcast works it
    /// out once instead of once per socket. `None` for a connection on a service
    /// UI pass (its answers are fenced per pass) or one with no access record:
    /// those are always worked out on their own.
    ///
    /// Exactly the fields `workspaces.machine_access` and `ui_can_see_run` read
    /// off a `UiAccess`; a new one read there must be added here, or two
    /// viewers would share an answer that is only right for one of them.
    fn access_key(&self, conn: ConnId) -> Option<String> {
        let a = self.ui_access.get(&conn)?;
        if a.ui_scope.is_some() {
            return None;
        }
        Some(format!(
            "{}\u{1}{}\u{1}{}\u{1}{}\u{1}{}",
            a.user_id, a.workspace_id, a.role, a.kind, a.access_state
        ))
    }

    /// The machines of the snapshot as one viewer sees them. `cache` holds the
    /// unscoped list (agents plus the offline rows read from the store — the
    /// expensive part) and the scoped result per access key.
    fn scoped_machines_for(&self, conn: ConnId, cache: &mut ViewCache) -> Vec<Value> {
        let key = self.access_key(conn);
        if let Some(hit) = key.as_ref().and_then(|k| cache.scoped.get(k)) {
            return hit.clone();
        }
        let scoped: Vec<Value> = cache
            .base(self)
            .iter()
            .cloned()
            .filter_map(|m| self.scoped_machine(conn, m))
            .collect();
        if let Some(key) = key {
            cache.scoped.insert(key, scoped.clone());
        }
        scoped
    }

    /// The team machines of one viewer (see `team_hardware_machine_ids`) as the
    /// `teamMachines` snapshot field: hardware and runtime health, stripped
    /// (`team_machine_view`), read-only. Machines already in `machines` (the
    /// viewer can open them for real) are not repeated. Shared between viewers
    /// with the same rights, like the other per-viewer lists.
    fn team_machines_for(
        &self,
        conn: ConnId,
        machines: &[Value],
        cache: &mut ViewCache,
    ) -> Vec<Value> {
        let key = self.access_key(conn);
        if let Some(hit) = key.as_ref().and_then(|k| cache.team.get(k)) {
            return hit.clone();
        }
        let Some(access) = self.ui_access.get(&conn) else {
            return Vec::new();
        };
        let ids = self
            .workspaces
            .team_hardware_machine_ids(access)
            .unwrap_or_default();
        let mut out: Vec<Value> = Vec::new();
        if !ids.is_empty() {
            // Only the viewer's own machines (full control) are left out: a
            // view-only share has its stats stripped in `machines`, so the
            // team entry is where its hardware shows.
            let held: HashSet<&str> = machines
                .iter()
                .filter(|m| m.get("canControl").and_then(Value::as_bool) == Some(true))
                .filter_map(|m| m.get("machine")?.get("machineId")?.as_str())
                .collect();
            let wanted: HashSet<&str> = ids
                .iter()
                .map(String::as_str)
                .filter(|id| !held.contains(id))
                .collect();
            let entries: Vec<Value> = cache.base(self).to_vec();
            for entry in entries {
                let Some(id) = entry
                    .get("machine")
                    .and_then(|m| m.get("machineId"))
                    .and_then(Value::as_str)
                else {
                    continue;
                };
                if wanted.contains(id) {
                    if let Some(team) = self.team_machine_view(id, &entry) {
                        out.push(team);
                    }
                }
            }
        }
        if let Some(key) = key {
            cache.team.insert(key, out.clone());
        }
        out
    }

    /// One `TeamMachine`: the machine card, its owner, liveness, and the two
    /// readings a manager needs to tell «who is offline / out of disk / logged
    /// out» — nothing about sessions, usage, profile or paths.
    fn team_machine_view(&self, machine_id: &str, entry: &Value) -> Option<Value> {
        let owner = self.workspaces.owner_json(machine_id).ok().flatten()?;
        let mut v = json!({
            "machine": team_machine_info(entry.get("machine")?)?,
            "owner": owner,
            "online": entry.get("online").and_then(Value::as_bool).unwrap_or(false),
            "lastSeen": entry.get("lastSeen").cloned().unwrap_or(json!(0)),
        });
        if let Some(stats) = entry.get("stats").and_then(team_stats) {
            v["stats"] = stats;
        }
        if let Some(runtimes) = entry.get(wire::field::RUNTIMES).and_then(team_runtimes) {
            v[wire::field::RUNTIMES] = runtimes;
        }
        Some(v)
    }

    /// A machine came online: the owners / managers who list it are owed a
    /// snapshot (the contract has no per-machine delta for «online»). Paid
    /// coalesced by `coalesce_tick`; viewers that get whole snapshots anyway
    /// are covered by the broadcast of `broadcast_machine_entry`.
    fn owe_team_snapshot(&mut self, machine_id: &str) {
        let owed: Vec<ConnId> = self
            .team_viewers_of(machine_id, |_| true)
            .into_iter()
            .filter(|conn| self.takes_session_deltas(*conn))
            .collect();
        self.team_snapshot_owed.extend(owed);
    }

    /// The connections that list `machine_id` as a team machine (read-only
    /// hardware, see `team_hardware_machine_ids`) and that `wanted` admits.
    /// The cheap tests (`wanted`, role in memory) run before the database one.
    fn team_viewers_of(&self, machine_id: &str, wanted: impl Fn(ConnId) -> bool) -> Vec<ConnId> {
        self.ui_clients
            .iter()
            .copied()
            .filter(|conn| wanted(*conn))
            // A viewer who CONTROLS this machine already gets the full frame;
            // a stripped second copy would overwrite it on the client.
            .filter(|conn| !self.ui_can_control_machine(*conn, machine_id))
            .filter(|conn| {
                self.ui_access.get(conn).is_some_and(|access| {
                    access.kind == "organization"
                        && access.role != "member"
                        && self
                            .workspaces
                            .team_hardware_machine_ids(access)
                            .is_ok_and(|ids| ids.iter().any(|id| id == machine_id))
                })
            })
            .collect()
    }

    /// The activity board as one viewer sees it, shared between viewers with
    /// the same rights (`access_key`).
    fn active_runs_cached(&self, conn: ConnId, cache: &mut ViewCache) -> Value {
        let key = self.access_key(conn);
        if let Some(hit) = key.as_ref().and_then(|k| cache.runs.get(k)) {
            return hit.clone();
        }
        let runs = self.active_runs_json_for(conn);
        if let Some(key) = key {
            cache.runs.insert(key, runs.clone());
        }
        runs
    }

    fn snapshot_with(&self, conn: ConnId, cache: &mut ViewCache) -> Value {
        let machines = self.scoped_machines_for(conn, cache);
        let viewer = self.ui_access.get(&conn).map(|a| a.viewer.clone());
        let team = self.team_machines_for(conn, &machines, cache);
        let mut snapshot = json!({
            "type":"snapshot",
            "viewer":viewer,
            "machines": machines,
            "activeRuns": self.active_runs_cached(conn, cache),
            "roadmap": self.roadmap_config,
        });
        // Optional on the wire: absent, never an empty list, for everyone who
        // has no team to look at.
        if !team.is_empty() {
            snapshot["teamMachines"] = Value::Array(team);
        }
        // The roadmap names the company's other projects: not for a pass.
        if self.is_scoped(conn) {
            if let Some(obj) = snapshot.as_object_mut() {
                obj.remove("roadmap");
            }
        }
        snapshot
    }

    /// Every machine, unscoped: the online ones from their agents, the rest
    /// from the store.
    fn all_machine_entries(&self) -> Vec<Value> {
        let online_ids: HashSet<String> = self.agents.keys().cloned().collect();
        let mut machines: Vec<Value> = self
            .agents
            .iter()
            .map(|(machine_id, a)| self.machine_entry_from(machine_id, a))
            .collect();
        match self.store.machine_snapshots(&online_ids) {
            Ok(mut offline) => machines.append(&mut offline),
            Err(e) => eprintln!("[hub] database snapshot read failed: {e}"),
        }
        machines
    }

    fn machine_entry_from(&self, machine_id: &str, a: &AgentConn) -> Value {
        let mut sessions = self
            .store
            .snapshot_sessions(machine_id)
            .unwrap_or_else(|_| a.sessions.clone());
        // The catalog is stripped of process liveness; put it back from
        // the connected agent's inventory or the UI sees only dormant
        // sessions and loses Mirror / take-over on editor-held ones.
        overlay_liveness(&mut sessions, &a.liveness);
        let mut m = json!({"machine": a.machine, "online": true, "lastSeen": a.last_seen, "sessions": sessions});
        // `usage` is optional on the wire (zod optional = omit, never
        // null) — only attach it once the agent has reported it.
        if a.usage.is_object() {
            m["usage"] = a.usage.clone();
        }
        if a.codex_usage.is_object() {
            m["codexUsage"] = a.codex_usage.clone();
        }
        // Same for the builder profile.
        if a.profile.is_object() {
            m["profile"] = a.profile.clone();
        }
        if a.stats.is_object() {
            m["stats"] = a.stats.clone();
        }
        if a.runtimes.is_object() {
            m[wire::field::RUNTIMES] = a.runtimes.clone();
        }
        m
    }

    /// Tell everyone the whole fleet, unless a snapshot already went out inside
    /// the coalescing window — then ONE trailing snapshot goes out when the
    /// window ends (`coalesce_tick`). A burst of reasons to re-send (a fleet of
    /// agents re-registering after a hub restart, a session starting while a
    /// machine drops) used to cost every viewer one multi-megabyte frame each.
    fn broadcast_snapshot(&mut self) {
        if now_ms() - self.last_snapshot_at >= COALESCE_WINDOW_MS {
            self.broadcast_snapshot_now();
        } else {
            self.snapshot_dirty = true;
        }
    }

    /// The snapshot, now, to every viewer that is listening. Paused sockets are
    /// skipped BEFORE anything is built for them: `resume` answers with a fresh
    /// snapshot of its own, so nothing is owed to them.
    fn broadcast_snapshot_now(&mut self) {
        // Whatever was owed is being paid now, by this frame.
        self.pending_machines.clear();
        self.snapshot_dirty = false;
        self.full_snapshot_dirty = false;
        self.team_snapshot_owed.clear();
        self.last_snapshot_at = now_ms();
        let conns: Vec<ConnId> = self.ui_clients.iter().copied().collect();
        let mut cache = ViewCache::default();
        self.send_snapshots(&conns, &mut cache);
        self.remember_all_published(&mut cache);
    }

    /// Send the snapshot to each of `conns` that is not paused.
    fn send_snapshots(&self, conns: &[ConnId], cache: &mut ViewCache) {
        for conn in conns {
            if self.pause_gate_blocks(*conn, "snapshot") {
                continue;
            }
            let snapshot = self.snapshot_with(*conn, cache);
            self.send_to(*conn, &snapshot);
        }
    }

    /// A snapshot IS a publication, so it moves the baseline the per-session
    /// patch diffs against. Skipping this would not corrupt anything — the
    /// merge rules are idempotent — but the next patch would re-send the
    /// machine's whole list, which is the cost this exists to avoid.
    fn remember_all_published(&mut self, cache: &mut ViewCache) {
        let online: Vec<Value> = cache
            .base(self)
            .iter()
            .filter(|m| m.get("online").and_then(Value::as_bool) == Some(true))
            .cloned()
            .collect();
        for entry in online {
            if let Some(machine_id) = entry
                .get("machine")
                .and_then(|m| m.get("machineId"))
                .and_then(Value::as_str)
                .map(str::to_string)
            {
                self.remember_published(&machine_id, &entry);
            }
        }
    }

    /// Whole snapshots to the viewers that cannot take a delta — a build that
    /// asked for neither `sessionDelta` nor `sessionPatch`, or a service pass.
    /// Same coalescing as `broadcast_snapshot`, for the same reason: such a
    /// viewer is sent one of these per machine inventory that moved.
    fn broadcast_full_snapshots(&mut self) {
        if now_ms() - self.last_snapshot_at >= COALESCE_WINDOW_MS {
            self.send_full_snapshots_now();
        } else {
            self.full_snapshot_dirty = true;
        }
    }

    fn send_full_snapshots_now(&mut self) {
        // A fleet snapshot is already owed (agent removal inside the window):
        // pay it now. It serves the legacy viewers too, and resetting the
        // shared deadline without paying it could postpone it indefinitely.
        if self.snapshot_dirty {
            self.broadcast_snapshot_now();
            return;
        }
        self.full_snapshot_dirty = false;
        self.last_snapshot_at = now_ms();
        let conns: Vec<ConnId> = self
            .ui_clients
            .iter()
            .copied()
            .filter(|conn| !self.takes_session_deltas(*conn))
            .collect();
        self.send_snapshots(&conns, &mut ViewCache::default());
    }

    /// Does this viewer get per-machine session deltas instead of snapshots?
    fn takes_session_deltas(&self, conn: ConnId) -> bool {
        !self.is_scoped(conn)
            && self.ui_caps.get(&conn).is_some_and(|caps| {
                caps.contains(CAP_SESSION_PATCH) || caps.contains(CAP_SESSION_DELTA)
            })
    }

    /// Pay what the broadcasts above and the activity heartbeat deferred.
    /// Fired by the 500 ms tick; a no-op when nothing is owed.
    fn coalesce_tick(&mut self) {
        let now = now_ms();
        if now - self.last_snapshot_at >= COALESCE_WINDOW_MS {
            if self.snapshot_dirty {
                self.broadcast_snapshot_now();
            } else if self.full_snapshot_dirty {
                self.send_full_snapshots_now();
            }
            if !self.team_snapshot_owed.is_empty() {
                let owed: Vec<ConnId> = self.team_snapshot_owed.drain().collect();
                self.last_snapshot_at = now;
                self.send_snapshots(&owed, &mut ViewCache::default());
            }
        }
        if self.activity_dirty.get() {
            // The one broadcast below carries EVERY run's current stamp, so
            // every run's heartbeat is paid by it — they do not each fire one
            // 30 s later at their own phase.
            for run in self.runs.values_mut() {
                run.last_event_sent_at = now;
            }
            self.broadcast_activity();
        }
        self.live_tick();
    }

    /// Publish new session lists for exactly the machines that moved, at the
    /// finest granularity each client agreed to understand.
    ///
    /// Three classes, cheapest first: `sessionPatch` gets only the sessions that
    /// differ, `sessionDelta` gets that machine's whole list, and a client that
    /// asked for neither gets the entire snapshot exactly as before — which is
    /// what lets this ship ahead of the app builds in the field.
    /// A `session.delete` the agent did not carry out: the file is still there,
    /// so the deliberate-delete record goes, and when the file does vanish the
    /// session archives like any other.
    fn undo_pending_delete(&self, pending: &PendingRpc) {
        if let Some(session_id) = pending.deleting.as_deref() {
            if let Err(e) = self
                .store
                .unmark_user_deleted(&pending.machine_id, session_id)
            {
                eprintln!(
                    "[hub] could not take back deletion of {}/{session_id}: {e}",
                    pending.machine_id
                );
            }
        }
    }

    fn broadcast_machine_sessions(&mut self, machine_ids: &[String]) {
        self.publish_machines(machine_ids, false);
    }

    /// `broadcast_machine_sessions` for a change to the MACHINE itself — it came
    /// online, its stats, usage and runtimes came with it — not only its
    /// sessions. A `session_updates` patch carries no machine fields, so a
    /// viewer that takes patches is sent the whole `machine_sessions` entry of
    /// that one machine here (one machine's list, not the fleet's snapshot).
    fn broadcast_machine_entry(&mut self, machine_ids: &[String]) {
        self.publish_machines(machine_ids, true);
    }

    fn publish_machines(&mut self, machine_ids: &[String], whole_entry: bool) {
        for id in machine_ids {
            self.pending_machines.remove(id);
        }
        let mut patch_conns: Vec<ConnId> = Vec::new();
        let mut whole_conns: Vec<ConnId> = Vec::new();
        let mut owes_full_snapshot = false;
        for conn in self.ui_clients.iter().copied() {
            // A paused viewer is told nothing now; its `resume` brings a fresh
            // snapshot. Skipped before anything is built for it.
            if self.pause_gate_blocks(conn, "machine_sessions") {
                continue;
            }
            // A pass is told its whole (scoped) list every time: the global
            // `removed` list of a patch names sessions it may not know exist.
            if self.is_scoped(conn) {
                owes_full_snapshot = true;
                continue;
            }
            match self.ui_caps.get(&conn) {
                Some(caps) if caps.contains(CAP_SESSION_PATCH) && !whole_entry => {
                    patch_conns.push(conn)
                }
                Some(caps)
                    if caps.contains(CAP_SESSION_DELTA) || caps.contains(CAP_SESSION_PATCH) =>
                {
                    whole_conns.push(conn)
                }
                _ => owes_full_snapshot = true,
            }
        }
        for id in machine_ids {
            // Built once per machine, then scoped per viewer — `scoped_machine`
            // hides sessions outside a control-share's roots, so what a teammate
            // is told is not what the owner is told. Viewers with the same
            // rights share one answer.
            let Some(entry) = self.online_machine_entry(id) else {
                continue;
            };
            let (changed, removed) = self.diff_published_sessions(id, &entry);
            let mut patches: HashMap<String, Option<Value>> = HashMap::new();
            for conn in &patch_conns {
                let msg = match self.access_key(*conn).and_then(|k| patches.get(&k)) {
                    Some(hit) => hit.clone(),
                    None => {
                        let msg = self.session_patch_for(*conn, id, &entry, &changed, &removed);
                        if let Some(key) = self.access_key(*conn) {
                            patches.insert(key, msg.clone());
                        }
                        msg
                    }
                };
                if let Some(msg) = msg {
                    self.send_to(*conn, &msg);
                }
            }
            let mut wholes: HashMap<String, Option<Value>> = HashMap::new();
            for conn in &whole_conns {
                let msg = match self.access_key(*conn).and_then(|k| wholes.get(&k)) {
                    Some(hit) => hit.clone(),
                    None => {
                        let msg = self
                            .scoped_machine(*conn, entry.clone())
                            .map(|machine| json!({"type":"machine_sessions","machine":machine}));
                        if let Some(key) = self.access_key(*conn) {
                            wholes.insert(key, msg.clone());
                        }
                        msg
                    }
                };
                if let Some(msg) = msg {
                    self.send_to(*conn, &msg);
                }
            }
            self.remember_published(id, &entry);
        }
        if owes_full_snapshot {
            self.broadcast_full_snapshots();
        }
    }

    /// Which of this machine's sessions the browsers have not been told about,
    /// and which they were told about and should now drop. `removed` covers
    /// a session a person deleted; one whose file merely vanished stays, now
    /// marked `archived`, and arrives here as a change.
    fn diff_published_sessions(
        &self,
        machine_id: &str,
        entry: &Value,
    ) -> (Vec<Value>, Vec<String>) {
        let published = self.agents.get(machine_id).map(|a| &a.published_sessions);
        let sessions = entry.get("sessions").and_then(Value::as_array);
        let mut changed = Vec::new();
        let mut present: HashSet<&str> = HashSet::new();
        for session in sessions.into_iter().flatten() {
            let Some(id) = session_id_of(session) else {
                continue;
            };
            present.insert(id);
            let known = published.and_then(|p| p.get(id)).copied();
            if known != Some(self.published_fingerprint(machine_id, session)) {
                changed.push(session.clone());
            }
        }
        let removed = published
            .map(|p| {
                p.keys()
                    .filter(|id| !present.contains(id.as_str()))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        (changed, removed)
    }

    /// What the per-session diff compares: the summary as viewers see it plus the
    /// hub-held annotations `scoped_machine` lays over it (owner, category,
    /// stage). Without those a session whose ownership changed — `session_started`
    /// on a resumed session — would diff as unchanged and never reach a viewer
    /// that takes patches.
    fn published_fingerprint(&self, machine_id: &str, session: &Value) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        session_fingerprint(session).hash(&mut hasher);
        if let Some(meta) = session_id_of(session)
            .and_then(|id| self.session_meta.get(&format!("{machine_id}::{id}")))
        {
            meta.owner_user_id.hash(&mut hasher);
            meta.category.hash(&mut hasher);
            meta.stage.hash(&mut hasher);
        }
        hasher.finish()
    }

    /// One viewer's share of a diff, ready to send. The changed sessions ride
    /// through `scoped_machine` on a stand-in entry so they pass exactly the
    /// filter a snapshot would have applied; removals need no filter, because
    /// dropping an id a client never held is a no-op. `None` = nothing for this
    /// viewer.
    fn session_patch_for(
        &self,
        conn: ConnId,
        machine_id: &str,
        entry: &Value,
        changed: &[Value],
        removed: &[String],
    ) -> Option<Value> {
        if changed.is_empty() && removed.is_empty() {
            return None;
        }
        // The stand-in carries the machine's own fields and ONLY the changed
        // sessions — never a copy of the machine's whole session list.
        let mut probe = serde_json::Map::new();
        if let Some(fields) = entry.as_object() {
            for (key, value) in fields {
                if key != "sessions" {
                    probe.insert(key.clone(), value.clone());
                }
            }
        }
        probe.insert("sessions".into(), Value::Array(changed.to_vec()));
        // None => the viewer cannot see this machine at all.
        let scoped = self.scoped_machine(conn, Value::Object(probe))?;
        let visible = scoped
            .get("sessions")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()));
        if visible.as_array().is_some_and(|a| a.is_empty()) && removed.is_empty() {
            return None;
        }
        let mut msg = json!({
            "type":"session_updates",
            "machineId": machine_id,
            "sessions": visible,
        });
        if !removed.is_empty() {
            msg["removed"] = json!(removed);
        }
        Some(msg)
    }

    fn remember_published(&mut self, machine_id: &str, entry: &Value) {
        let next: HashMap<String, u64> = entry
            .get("sessions")
            .and_then(Value::as_array)
            .map(|sessions| {
                sessions
                    .iter()
                    .filter_map(|s| {
                        session_id_of(s)
                            .map(|id| (id.to_string(), self.published_fingerprint(machine_id, s)))
                    })
                    .collect()
            })
            .unwrap_or_default();
        if let Some(a) = self.agents.get_mut(machine_id) {
            a.published_sessions = next;
        }
    }

    /// The backstop for changes no broadcast was called for. Sends nothing when
    /// nothing is owed, which on a quiet fleet is every tick.
    fn flush_snapshot(&mut self) {
        if self.pending_machines.is_empty() {
            return;
        }
        let owed: Vec<String> = self.pending_machines.iter().cloned().collect();
        self.broadcast_machine_sessions(&owed);
    }
}

/// The machine card a team viewer gets: identity only — no hostname, skills,
/// permission modes, policy or other settings of the owner.
fn team_machine_info(machine: &Value) -> Option<Value> {
    let src = machine.as_object()?;
    let mut out = serde_json::Map::new();
    for key in ["machineId", "name", "os", "agentVersion"] {
        out.insert(key.into(), src.get(key)?.clone());
    }
    Some(Value::Object(out))
}

/// A machine's hardware sample as a team viewer may see it: the numbers, never
/// the process list (command lines name projects and customers).
fn team_stats(stats: &Value) -> Option<Value> {
    let mut v = stats.as_object()?.clone();
    v.insert("top".into(), json!([]));
    Some(Value::Object(v))
}

/// A machine's runtime health as a team viewer may see it: is it installed and
/// logged in, how (not as whom), the error CODE (a fixed word, no PII) and how
/// long a token lasts. No account, plan, path, detail text or provider name — those are the machine owner's.
fn team_runtimes(runtimes: &Value) -> Option<Value> {
    const CLAUDE: &[&str] = &[
        "present",
        "auth",
        "error",
        "version",
        "checkedAt",
        "expiresAt",
    ];
    const CODEX: &[&str] = &[
        "present",
        "auth",
        "error",
        "provider",
        "version",
        "checkedAt",
    ];
    // `error` is a free string on the wire; only the agent's fixed codes pass
    // (agent/src/runtime-status.ts, codex.ts), anything else reads «other».
    const ERROR_CODES: &[&str] = &[
        "disabled",
        "logged_out",
        "login_cli_missing",
        "not_found",
        "not_logged_in",
        "sdk_binary_missing",
        "token_expired",
        "token_expiring",
        "token_rejected",
        "authentication_failed",
        "timeout",
        "app_server_error",
    ];
    let pick = |v: &Value, keys: &[&str]| -> Option<Value> {
        let src = v.as_object()?;
        let mut out = serde_json::Map::new();
        for key in keys {
            if let Some(x) = src.get(*key).filter(|x| !x.is_null()) {
                let x = if *key == "error" {
                    let code = x.as_str().unwrap_or("");
                    Value::String(
                        if ERROR_CODES.contains(&code) {
                            code
                        } else {
                            "other"
                        }
                        .into(),
                    )
                } else {
                    x.clone()
                };
                out.insert((*key).into(), x);
            }
        }
        Some(Value::Object(out))
    };
    let src = runtimes.as_object()?;
    let mut out = serde_json::Map::new();
    if let Some(c) = src.get("claude").and_then(|v| pick(v, CLAUDE)) {
        out.insert("claude".into(), c);
    }
    if let Some(c) = src.get("codex").and_then(|v| pick(v, CODEX)) {
        out.insert("codex".into(), c);
    }
    Some(Value::Object(out))
}

/// The serialized length of `v` in bytes, counted without building the string.
/// The replay window's byte budget needs sizes, not text — and it asks once per
/// frame, inside the loop that serves the whole fleet.
fn json_len(v: &Value) -> usize {
    struct Counter(usize);
    impl std::io::Write for Counter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0 += buf.len();
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter(0);
    let _ = serde_json::to_writer(&mut counter, v);
    counter.0
}

/// A cheap identity for a payload, to tell a viewer the same thing twice.
fn payload_sig(v: &Value) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    v.to_string().hash(&mut hasher);
    hasher.finish()
}

/// Is `new` the same quota reading as `old`, apart from WHEN it was fetched?
/// `updatedAt` moves on every 180 s poll while the limits stay put; a viewer
/// has nothing to redraw for that. (A client that wants the stamp reads it
/// off the next snapshot, which always carries the freshest stored reading.)
fn same_reading(old: &Value, new: &Value) -> bool {
    let (Some(old), Some(new)) = (old.as_object(), new.as_object()) else {
        return false;
    };
    let live =
        |m: &serde_json::Map<String, Value>| m.iter().filter(|(k, _)| *k != "updatedAt").count();
    live(old) == live(new)
        && new
            .iter()
            .filter(|(k, _)| *k != "updatedAt")
            .all(|(k, v)| old.get(k) == Some(v))
}

/// Frames a paused UI conn still receives: small, rare, and each the answer to
/// something that conn itself sent or the run it holds. Bulk fan-out (snapshot,
/// activity, stream) stays gated — that is what filled a suspended app's queue.
fn passes_pause(ty: &str) -> bool {
    matches!(ty, "opened" | "session_started" | "error" | "run_status")
}
