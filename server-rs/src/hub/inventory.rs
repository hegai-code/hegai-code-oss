//! The liveness overlay and the inventory fingerprints: how the hub tells a
//! process that is running from a session that merely exists, and how it
//! decides whether an agent's inventory changed enough to broadcast. Pure
//! functions over `serde_json::Value`; nothing here touches hub state.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use super::*;

/// The process-liveness half of one session summary: `livePid`, `active` and
/// `liveStatus`. All three describe a PROCESS, not the session, so none is ever
/// persisted — they come only from a connected agent's latest inventory.
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct Live {
    pub(super) pid: Option<i64>,
    pub(super) active: Option<bool>,
    /// `busy` / `waiting` / `idle`, from the holding process's own pid file. Meaningless
    /// without a pid, so it is only kept alongside one — a status outliving its
    /// process would light the «идёт работа» bolt on a session nobody holds.
    pub(super) status: Option<String>,
}

/// `sessionId -> Live` — kept apart from the durable catalog.
pub(super) type Liveness = HashMap<String, Live>;

/// Pull the liveness bits out of an agent's freshly-reported inventory.
///
/// Every session in the frame gets an entry, including dormant ones as
/// `(None, None)`. That is what lets a capped inventory clear a pid that just
/// died: the entry says "this session was reported, and it has no writer".
pub(super) fn collect_liveness(sessions: &[Value]) -> Liveness {
    let mut out = Liveness::new();
    for s in sessions {
        let Some(id) = s.get("sessionId").and_then(Value::as_str) else {
            continue;
        };
        let pid = s.get("livePid").and_then(Value::as_i64);
        let status = pid
            .and(s.get("liveStatus").and_then(Value::as_str))
            .filter(|v| matches!(*v, "busy" | "waiting" | "idle"))
            .map(str::to_string);
        out.insert(
            id.to_string(),
            Live {
                pid,
                active: s.get("active").and_then(Value::as_bool),
                status,
            },
        );
    }
    out
}

/// Put the liveness bits back onto summaries read from the durable catalog.
///
/// `upsert_summary` strips `livePid`/`active`/`liveStatus` before persisting, on purpose: a
/// stored pid outlives the process it names. But the UI's snapshot is served
/// FROM that catalog, so without this overlay the live value never reaches a
/// browser — every session looks dormant, the web offers a plain resume for a
/// session an editor still holds, and the Mirror / take-over path (gated on
/// `livePid` in the web) becomes unreachable. Only a connected agent's
/// inventory feeds this; nothing here is ever persisted.
pub(super) fn overlay_liveness(sessions: &mut [Value], live: &Liveness) {
    if live.is_empty() {
        return;
    }
    for s in sessions.iter_mut() {
        let Some(id) = s
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            continue;
        };
        let Some(Live {
            pid,
            active,
            status,
        }) = live.get(&id)
        else {
            continue;
        };
        let Some(obj) = s.as_object_mut() else {
            continue;
        };
        match pid {
            Some(pid) => {
                obj.insert("livePid".into(), json!(pid));
            }
            // zod `optional` means absent, never null.
            None => {
                obj.remove("livePid");
            }
        }
        match active {
            Some(active) => {
                obj.insert("active".into(), json!(active));
            }
            None => {
                obj.remove("active");
            }
        }
        match status {
            Some(status) => {
                obj.insert("liveStatus".into(), json!(status));
            }
            None => {
                obj.remove("liveStatus");
            }
        }
    }
}

/// Two content fingerprints of a session inventory: the exact one, and one that
/// ignores `lastModified` and `fileMtime` (the replica cursor, which moves on
/// every bookkeeping write the sort key ignores).
///
/// The second is what makes the snapshot cheap. Measured on the live fleet, the
/// difference between one snapshot and the next is almost always a single
/// session's `lastModified` ticking as somebody types — and that used to cost
/// EVERY browser a frame carrying all eight machines and ~1000 sessions. A
/// moved mtime only ever moves a relative timestamp and a sort position, so it
/// can ride along with the next real change or a periodic flush; anything else
/// (a new session, a title, a stage, an editor taking the file) still goes out
/// at once.
///
/// Neither is a security hash — they only answer "is this the same list", and a
/// collision costs one late redraw that the next change repairs. Both are
/// order-INDEPENDENT sums: agents order the inventory by mtime, so two sessions
/// swapping places would otherwise read as a structural change every time.
pub(super) fn inventory_fingerprints(sessions: &[Value]) -> (u64, u64) {
    let mut exact = sessions.len() as u64;
    let mut shape = sessions.len() as u64;
    for session in sessions {
        let raw = session.to_string();
        let mut hasher = DefaultHasher::new();
        raw.hash(&mut hasher);
        exact = exact.wrapping_add(hasher.finish());

        let mut hasher = DefaultHasher::new();
        match session.as_object() {
            Some(fields) => {
                for (key, value) in fields {
                    if key == "lastModified" || key == "fileMtime" {
                        continue;
                    }
                    key.hash(&mut hasher);
                    value.to_string().hash(&mut hasher);
                }
            }
            None => raw.hash(&mut hasher),
        }
        shape = shape.wrapping_add(hasher.finish());
    }
    (exact, shape)
}

/// How long a mtime-only change may wait for company. Long enough to collapse
/// the churn of an active fleet, short enough that "2 minutes ago" is never
/// visibly wrong.
pub(super) const SNAPSHOT_FLUSH_SECS: u64 = 20;

/// The `hello.caps` entry a client sends to be given `machine_sessions` deltas
/// instead of whole snapshots. Opt-in, because a build that does not know the
/// message would ignore it and sit on a session list that never updates again.
pub(super) const CAP_SESSION_DELTA: &str = "sessionDelta";

/// The `hello.caps` entry a client sends to receive `machine_stats` only while
/// it says it is showing them (`stats_interest`). Mirror of `CAP_STATS_ON_DEMAND`
/// in shared/src/web-protocol.ts.
pub(super) const CAP_STATS_ON_DEMAND: &str = "statsOnDemand";

/// The `hello.caps` entry a client sends to have its `ping` answered with
/// `pong`. Mirror of `CAP_PONG` in shared/src/web-protocol.ts.
pub(super) const CAP_PONG: &str = "pong";

/// The finer of the two: `session_updates`, carrying only the sessions that
/// changed rather than the machine's whole list. Separate from
/// `CAP_SESSION_DELTA` because clients already in the field understand the
/// machine-level message and not this one.
pub(super) const CAP_SESSION_PATCH: &str = "sessionPatch";

/// Fingerprint of one session summary as a VIEWER sees it, for the per-session
/// diff. `fileMtime` is left out: it is the replica's cursor (the hub reads it
/// off its own copy of the inventory to judge freshness), no client draws it,
/// and it moves on every bookkeeping write — which used to make each of those a
/// `session_updates` entry that changed nothing on any screen.
pub(super) fn session_fingerprint(session: &Value) -> u64 {
    let mut hasher = DefaultHasher::new();
    match session.as_object() {
        Some(fields) => {
            for (key, value) in fields {
                if key == "fileMtime" {
                    continue;
                }
                key.hash(&mut hasher);
                value.to_string().hash(&mut hasher);
            }
        }
        None => session.to_string().hash(&mut hasher),
    }
    hasher.finish()
}

/// Fingerprint of a whole inventory as the viewers see it: the exact one of
/// `inventory_fingerprints` minus `fileMtime`. Equal to the previous one means
/// no browser has anything to learn from this inventory, whatever the replica
/// cursor did. Order-independent, like its siblings.
pub(super) fn inventory_ui_fingerprint(sessions: &[Value]) -> u64 {
    sessions.iter().fold(sessions.len() as u64, |acc, s| {
        acc.wrapping_add(session_fingerprint(s))
    })
}

pub(super) fn session_id_of(session: &Value) -> Option<&str> {
    session.get("sessionId").and_then(Value::as_str)
}

/// Tools whose pending request is the agent ASKING something, not asking to be
/// allowed to act. Everything else is a permission prompt.
///
/// The hub raises `needs_attention` for any pending tool request, which is
/// correct — a person is needed either way — but the two read very differently.
/// "Ждёт ответа" on a `Write` prompt sends the owner looking for a question
/// that was never asked; it happened on this fleet and cost a real debugging
/// session. The state stays one; what it MEANS now rides alongside it.
pub(super) fn pending_kind_of(tool: &str) -> &'static str {
    match tool {
        "AskUserQuestion" | "ExitPlanMode" => "question",
        _ => "permission",
    }
}
