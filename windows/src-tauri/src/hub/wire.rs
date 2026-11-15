//! The slice of the hub protocol the tray actually needs.
//!
//! This is deliberately NOT a fourth full mirror of `shared/src/web-protocol.ts`
//! alongside the TS, Rust and Swift ones. The window renders the real SPA and
//! speaks the whole protocol already; this connection exists only to answer two
//! questions while the window is closed — how many sessions are waiting on an
//! answer, and did one just start waiting.
//!
//! Everything else on the socket is ignored by construction: unknown frames
//! decode to `Frame::Other` rather than failing, the same forward-compatibility
//! rule `HubMessage.swift` follows.

use serde::Deserialize;

/// `ActiveRunInfo` from `shared/src/web-protocol.ts:121-141`, minus the fields
/// only a full client needs (preview, project, origin, ownerName, category).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub run_id: String,
    pub machine_id: String,
    pub session_id: String,
    #[serde(default)]
    pub machine_name: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    /// Whose run this is. It decides whether the run is worth a toast at all —
    /// `activity` carries every run the viewer may SEE, which on a shared
    /// sandbox or for a platform admin is most of the fleet. See `Watcher`.
    ///
    /// Absent on a run the hub could not attribute: one the agent found already
    /// running rather than one opened through the hub (`adopt_declared_run`,
    /// `server-rs/src/hub.rs:3878-3893`) has no `session_meta` row to name.
    #[serde(default)]
    pub owner_user_id: Option<String>,
    pub state: State,
    /// What `needs_attention` means here — "question" (the agent asked) or
    /// "permission" (a tool wants to run). One state covers both, and naming
    /// the wrong one sends people looking for a question nobody asked. Absent
    /// from a hub too old to send it.
    #[serde(default)]
    pub pending_kind: Option<String>,
    /// Which prompt the run is stopped on. The agent re-issues the SAME id
    /// after every reconnect, so this is what tells «asked again because a
    /// socket blipped» from «asked something new» (`Watcher::asked`). Absent
    /// when nothing is pending, or from a hub too old to send it.
    #[serde(default)]
    pub pending_request_id: Option<String>,
}

impl Run {
    /// What a toast calls this session. The hub sends the first transcript line
    /// as the title, which can be absent on a fresh session.
    pub fn label(&self) -> String {
        match self.title.as_deref().map(str::trim) {
            Some(t) if !t.is_empty() => t.to_string(),
            _ => self.session_id.chars().take(8).collect(),
        }
    }
}

/// `AttentionState`, `shared/src/web-protocol.ts:117`.
///
/// `Unknown` is the forward-compatible floor: a state this build has never
/// heard of must not drop the whole frame, and it must not notify either.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    Working,
    NeedsAttention,
    Idle,
    Error,
    #[serde(other)]
    Unknown,
}

impl State {
    /// The states worth interrupting someone for — the same three the web
    /// notifies on (`NOTIFY` in `web/src/central-reducers.ts:74`). `working` is
    /// excluded there and here: a run going busy is not news.
    pub fn is_notable(self) -> bool {
        matches!(self, State::NeedsAttention | State::Idle | State::Error)
    }

    /// Only `needs_attention` is a person being BLOCKED on you. The tray badge
    /// counts these and nothing else, so it means "this many things want you"
    /// rather than "this much is happening".
    pub fn is_waiting(self) -> bool {
        matches!(self, State::NeedsAttention)
    }

    pub fn verb(self) -> &'static str {
        self.verb_for(None)
    }

    /// The verb, told apart by what is actually pending. See `Run::pending_kind`.
    pub fn verb_for(self, pending_kind: Option<&str>) -> &'static str {
        match self {
            State::NeedsAttention => match pending_kind {
                Some("question") => "ждёт ответа",
                Some("permission") => "ждёт подтверждения",
                _ => "ждёт решения",
            },
            State::Error => "завершилась ошибкой",
            State::Idle => "готова",
            State::Working => "в работе",
            State::Unknown => "изменилась",
        }
    }
}

/// The one field of `ViewerContext` (`web-protocol.ts:53-62`) the tray needs:
/// who is looking. Everything else in there describes a workspace nobody on
/// this socket renders.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewer {
    pub user_id: String,
}

/// Only the frames that carry run state. `snapshot` is the full picture on
/// connect; `activity` is the hub's cheaper delta, re-sent whenever any run's
/// attention changes (`web-protocol.ts:417-421`).
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Frame {
    /// `machines` rides along on this frame too and is what the offline screen
    /// will need, but nothing reads it yet. It gets a field when the cache that
    /// consumes it exists, not before.
    Snapshot {
        /// The snapshot is the ONLY frame that names the viewer, and the hub
        /// sends one the moment a UI connection is accepted (`snapshot_for`
        /// under `HubCmd::Connected`, `server-rs/src/hub.rs:1074`) — so it
        /// lands before any `activity` delta can. `null` on a hub old enough
        /// not to send it at all; see `Watcher::is_mine` for what that means.
        #[serde(default)]
        viewer: Option<Viewer>,
        #[serde(default)]
        active_runs: Vec<Run>,
    },
    Activity {
        #[serde(default)]
        runs: Vec<Run>,
    },
    #[serde(other)]
    Other,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Golden frames in the exact shape the Rust hub emits. Mirrors the intent
    /// of `CCRemoteTests/ProtocolDecodingTests.swift`.
    #[test]
    fn an_activity_frame_decodes() {
        let raw = r#"{"type":"activity","runs":[
            {"runId":"r1","machineId":"m1","sessionId":"s1","machineName":"mac-mini",
             "title":"починить логин","state":"needs_attention","since":1}
        ]}"#;
        let Frame::Activity { runs } = serde_json::from_str(raw).unwrap() else {
            panic!("expected activity");
        };
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].state, State::NeedsAttention);
        assert_eq!(runs[0].label(), "починить логин");
    }

    #[test]
    fn a_snapshot_without_active_runs_is_still_a_snapshot() {
        // `activeRuns` is optional on the wire; absent must mean "none", not
        // a decode failure that would leave the tray blank forever.
        let raw = r#"{"type":"snapshot","machines":[]}"#;
        let Frame::Snapshot { active_runs, viewer } = serde_json::from_str(raw).unwrap() else {
            panic!("expected snapshot");
        };
        assert!(active_runs.is_empty());
        assert!(viewer.is_none(), "an absent viewer is not a decode failure");
    }

    #[test]
    fn the_snapshot_names_who_is_looking() {
        // The rest of `ViewerContext` is along for the ride and must not make
        // the frame undecodable — including the explicit null the hub sends a
        // connection it has no access row for.
        let raw = r#"{"type":"snapshot","machines":[],"viewer":{
            "userId":"u1","email":"owner@x.test","platformAdmin":true,
            "workspace":{"workspaceId":"w1","name":"Моя работа","kind":"personal","role":"owner"},
            "workspaces":[]}}"#;
        let Frame::Snapshot { viewer, .. } = serde_json::from_str(raw).unwrap() else {
            panic!("expected snapshot");
        };
        assert_eq!(viewer.unwrap().user_id, "u1");

        let Frame::Snapshot { viewer, .. } =
            serde_json::from_str(r#"{"type":"snapshot","viewer":null}"#).unwrap()
        else {
            panic!("expected snapshot");
        };
        assert!(viewer.is_none());
    }

    #[test]
    fn a_run_carries_its_owner_when_the_hub_knows_one() {
        // `ownerUserId` is zod-optional, which on this wire means OMITTED, not
        // null — a run nobody owns simply has no field (`run_json`,
        // `server-rs/src/hub.rs:3699`).
        let raw = r#"{"type":"activity","runs":[
            {"runId":"r1","machineId":"m1","sessionId":"s1","state":"idle","since":1,
             "ownerUserId":"u2","ownerName":"Варя"},
            {"runId":"r2","machineId":"m1","sessionId":"s2","state":"idle","since":1}
        ]}"#;
        let Frame::Activity { runs } = serde_json::from_str(raw).unwrap() else {
            panic!("expected activity");
        };
        assert_eq!(runs[0].owner_user_id.as_deref(), Some("u2"));
        assert!(runs[1].owner_user_id.is_none());
    }

    #[test]
    fn an_unknown_frame_is_ignored_rather_than_fatal() {
        // The hub sends a dozen frame types this build does not care about, and
        // will grow more. None of them may kill the connection.
        for raw in [
            r#"{"type":"usage","machineId":"m1","usage":{}}"#,
            r#"{"type":"session_stage","machineId":"m1","sessionId":"s1"}"#,
            r#"{"type":"something_invented_next_year"}"#,
        ] {
            assert!(matches!(
                serde_json::from_str::<Frame>(raw).unwrap(),
                Frame::Other
            ));
        }
    }

    #[test]
    fn an_unknown_attention_state_never_notifies() {
        let raw = r#"{"type":"activity","runs":[
            {"runId":"r1","machineId":"m1","sessionId":"s1","state":"contemplating","since":1}
        ]}"#;
        let Frame::Activity { runs } = serde_json::from_str(raw).unwrap() else {
            panic!("expected activity");
        };
        assert_eq!(runs[0].state, State::Unknown);
        assert!(!runs[0].state.is_notable());
        assert!(!runs[0].state.is_waiting());
    }

    #[test]
    fn a_titleless_run_falls_back_to_a_short_session_id() {
        let raw = r#"{"type":"activity","runs":[
            {"runId":"r1","machineId":"m1","sessionId":"abcdef1234567890","state":"idle","since":1}
        ]}"#;
        let Frame::Activity { runs } = serde_json::from_str(raw).unwrap() else {
            panic!("expected activity");
        };
        assert_eq!(runs[0].label(), "abcdef12");
    }

    #[test]
    fn only_needs_attention_counts_as_waiting() {
        assert!(State::NeedsAttention.is_waiting());
        for s in [State::Idle, State::Error, State::Working, State::Unknown] {
            assert!(!s.is_waiting(), "{s:?} must not inflate the tray badge");
        }
        // But idle and error are still worth one toast.
        assert!(State::Idle.is_notable());
        assert!(State::Error.is_notable());
        assert!(!State::Working.is_notable());
    }
}
