//! Cross-device «read» marks: `session_read` in, `session_reads` out. Storage
//! is `crate::session_reads`; the wire shape is in shared/src/web-protocol.ts.

use serde_json::{json, Value};

use super::*;

/// A repeat inside this window is stored but not rebroadcast: a duplicate from
/// two tabs or a reconnect. Clients announce only when what is on screen
/// changes — iOS at most once per 10 s, the web only after a session has been
/// in front for 3 s since its last change — so anything later is news. Keep it
/// below the web's 3 s, or the read of a result that finished right after an
/// earlier mark is stored but never reaches the phone.
const REBROADCAST_MIN_MS: i64 = 2_000;
/// Marks kept per person; the oldest go.
const MAX_ROWS_PER_USER: i64 = 2000;
/// What a fresh socket is told about on connect.
const SNAPSHOT_WINDOW_MS: i64 = 14 * 24 * 60 * 60 * 1000;
const SNAPSHOT_LIMIT: i64 = 1000;
/// Finished turns kept per person; the oldest go.
const MAX_COMPLETIONS_PER_USER: i64 = 2000;
/// Finished turns a fresh socket is told about: long enough for a night or a
/// weekend away, short enough that a new install does not light up a month.
const COMPLETIONS_WINDOW_MS: i64 = 3 * 24 * 60 * 60 * 1000;
const COMPLETIONS_LIMIT: i64 = 300;

impl Hub {
    pub(super) fn ui_session_read(&mut self, conn: ConnId, v: &Value) {
        let machine_id = v.get("machineId").and_then(Value::as_str).unwrap_or("");
        let session_id = v.get("sessionId").and_then(Value::as_str).unwrap_or("");
        if machine_id.is_empty()
            || session_id.is_empty()
            || machine_id.len() > 256
            || session_id.len() > 256
        {
            return;
        }
        let Some(user_id) = self.ui_access.get(&conn).map(|a| a.user_id.clone()) else {
            return;
        };
        // A brand-new session is known only through its live run until the
        // inventory or replica catches up; its cwd is what a root-scoped view
        // check needs.
        let live_cwd = self
            .runs
            .values()
            .find(|r| r.machine_id == machine_id && r.session_id == session_id)
            .map(|r| r.cwd.clone());
        if !self.ui_can_view_session(
            conn,
            machine_id,
            session_id,
            live_cwd.clone().flatten().as_deref(),
        ) {
            return;
        }
        // Only sessions the hub knows: the table is per person and unbounded
        // in key space otherwise.
        if live_cwd.is_none() && !self.session_known(machine_id, session_id) {
            return;
        }
        let at = now_ms();
        let Ok((previous, stored)) = self.workspaces.session_read_upsert(
            &user_id,
            machine_id,
            session_id,
            at,
            MAX_ROWS_PER_USER,
        ) else {
            return;
        };
        // Clients announce only when what is on screen changes, so a repeat
        // within a few seconds is a duplicate (two tabs, a reconnect); anything
        // else may be the read of a result that just finished and went away.
        if previous.is_some_and(|p| at - p < REBROADCAST_MIN_MS) {
            return;
        }
        // Per socket, not per user: one account can hold sockets in workspaces
        // with different views, and a paused or inactive one gets nothing.
        let frame = json!({
            "type": "session_reads",
            "reads": [{"machineId": machine_id, "sessionId": session_id, "at": stored}],
        });
        let targets: Vec<ConnId> = self
            .ui_clients
            .iter()
            .copied()
            .filter(|c| {
                self.ui_access
                    .get(c)
                    .is_some_and(|a| a.user_id == user_id && a.is_active())
                    && self.ui_can_view_session(*c, machine_id, session_id, None)
            })
            .collect();
        for c in targets {
            self.send_to(c, &frame);
        }
    }

    fn session_known(&self, machine_id: &str, session_id: &str) -> bool {
        self.agents.get(machine_id).is_some_and(|a| {
            a.sessions
                .iter()
                .any(|s| s.get("sessionId").and_then(Value::as_str) == Some(session_id))
        }) || self.store.has_session(machine_id, session_id)
    }

    /// The marks a socket that just connected starts from. Nothing is sent when
    /// the person has none.
    pub(super) fn send_session_reads(&self, conn: ConnId) {
        let Some(access) = self.ui_access.get(&conn) else {
            return;
        };
        if !access.is_active() {
            return;
        }
        let user_id = access.user_id.clone();
        let Ok(rows) = self.workspaces.session_reads_recent(
            &user_id,
            now_ms() - SNAPSHOT_WINDOW_MS,
            // Read wider than we send: the access filter below may drop many.
            SNAPSHOT_LIMIT * 5,
        ) else {
            return;
        };
        let reads: Vec<Value> = rows
            .into_iter()
            .filter(|(m, s, _)| self.ui_can_view_session(conn, m, s, None))
            .take(SNAPSHOT_LIMIT as usize)
            .map(|(m, s, at)| json!({"machineId": m, "sessionId": s, "at": at}))
            .collect();
        if !reads.is_empty() {
            self.send_to(conn, &json!({"type": "session_reads", "reads": reads}));
        }
        // After the marks: a client compares each finish with them.
        self.send_session_completions(conn);
    }

    /// A run's owner finished a turn (`working -> idle`). Stored so that a
    /// client which never saw the run go idle — asleep while the agent
    /// restarted or the reaper closed the run — still learns of the result.
    /// `at` is the run's new `since`, so the client can tell it is the same
    /// finish it may already have seen through `activity`.
    pub(super) fn record_completion(&self, run_id: &str) {
        let Some(r) = self.runs.get(run_id) else {
            return;
        };
        let Some(owner) = r.owner_user_id.as_deref() else {
            return;
        };
        if r.session_id.is_empty() || r.machine_id.is_empty() {
            return;
        }
        if let Err(e) = self.workspaces.session_completion_upsert(
            owner,
            &r.machine_id,
            &r.session_id,
            r.since,
            MAX_COMPLETIONS_PER_USER,
        ) {
            eprintln!("[hub] session completion not stored: {e}");
        }
    }

    fn send_session_completions(&self, conn: ConnId) {
        let Some(access) = self.ui_access.get(&conn) else {
            return;
        };
        if !access.is_active() {
            return;
        }
        let user_id = access.user_id.clone();
        let Ok(rows) = self.workspaces.session_completions_recent(
            &user_id,
            now_ms() - COMPLETIONS_WINDOW_MS,
            COMPLETIONS_LIMIT * 3,
        ) else {
            return;
        };
        let completions: Vec<Value> = rows
            .into_iter()
            // A deleted session keeps its row (ids only) but lights nothing.
            .filter(|c| {
                self.ui_can_view_session(conn, &c.machine_id, &c.session_id, None)
                    && self.session_known(&c.machine_id, &c.session_id)
            })
            .take(COMPLETIONS_LIMIT as usize)
            .map(|c| json!({"machineId": c.machine_id, "sessionId": c.session_id, "at": c.finished_at}))
            .collect();
        if completions.is_empty() {
            return;
        }
        self.send_to(
            conn,
            &json!({"type": "session_completions", "completions": completions}),
        );
    }
}
