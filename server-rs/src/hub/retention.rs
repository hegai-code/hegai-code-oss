//! Transcript retention a machine's OWNER sets: `transcriptRetentionDays` in
//! `~/.cc-remote/policy.json` there (agent/src/policy.ts), reported in the
//! machine info at register and persisted in `machines.machine_json`.
//!
//! The hub keeps every synced transcript indefinitely by default. A machine
//! that declares N days gets every session idle for longer than N days removed
//! from the hub — catalog row, replicated messages, the speech archive, board
//! derivatives and cached annotations (`ReplicaStore::purge_sessions`). The
//! number only ever comes from the machine; the hub has no setting that could
//! lengthen it. Runs on the reaper's tick; logs counts, never titles or ids.
//!
//! What it does not touch: the transcript on the machine itself (that is the
//! owner's own disk), a session with a run or a live process right now, and
//! database backups taken before the purge.

use super::*;

const DAY_MS: i64 = 86_400_000;

impl Hub {
    pub(super) fn purge_expired_transcripts(&mut self) {
        self.purge_expired_transcripts_at(now_ms());
    }

    pub(super) fn purge_expired_transcripts_at(&mut self, now: i64) {
        let machines = match self.store.retention_machines() {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[hub] retention: machine list failed: {e}");
                return;
            }
        };
        let mut offline_changed = false;
        for (machine_id, days) in machines {
            let cutoff = now - days.saturating_mul(DAY_MS);
            let idle = match self.store.sessions_idle_since(&machine_id, cutoff) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[hub] retention: {machine_id}: session scan failed: {e}");
                    continue;
                }
            };
            let expired: Vec<(String, String)> = idle
                .into_iter()
                .filter(|(_, sid)| !self.session_in_use(&machine_id, sid))
                .collect();
            if expired.is_empty() {
                continue;
            }
            let counts = match self.store.purge_sessions(&machine_id, &expired) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[hub] retention: {machine_id}: purge failed: {e}");
                    continue;
                }
            };
            self.forget_enrichment(&machine_id, &expired);
            println!(
                "[hub] retention {days}d: {machine_id}: purged {} session(s), {} message(s), {} archived turn(s), {} board card(s)",
                counts.sessions, counts.messages, counts.archived_turns, counts.board_cards
            );
            if let Some(conn) = self.agents.get(&machine_id).map(|a| a.conn) {
                if let Ok(fresh) = self.store.sessions_for_machine(&machine_id) {
                    if let Some(a) = self.agents.get_mut(&machine_id) {
                        a.sessions = fresh;
                        overlay_liveness(&mut a.sessions, &a.liveness);
                    }
                }
                // The agent believes the hub still holds these; a fresh catalog
                // makes a session that is picked up again sync from scratch
                // instead of appending to a replica that no longer exists.
                match self.store.catalog(&machine_id) {
                    Ok(sessions) => self.send_to(
                        conn,
                        &json!({"type":"session_sync_catalog","sessions":sessions}),
                    ),
                    Err(e) => eprintln!("[hub] retention: {machine_id}: catalog read failed: {e}"),
                }
                self.broadcast_machine_sessions(std::slice::from_ref(&machine_id));
            } else {
                offline_changed = true;
            }
        }
        if offline_changed {
            self.broadcast_snapshot();
        }
    }

    /// A session somebody is in right now: a run the hub holds, a process the
    /// agent sees writing it, or a replica sync mid-flight.
    fn session_in_use(&self, machine_id: &str, session_id: &str) -> bool {
        self.runs
            .values()
            .any(|r| r.machine_id == machine_id && r.session_id == session_id)
            || self
                .agents
                .get(machine_id)
                .is_some_and(|a| a.liveness.contains_key(session_id))
            || self
                .pending_replica
                .values()
                .any(|p| p.machine_id == machine_id && p.session_id == session_id)
    }
}
