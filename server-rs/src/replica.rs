use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};

use crate::workspace::now_ms;

#[derive(Clone, Debug)]
pub struct ReplicaState {
    pub session_id: String,
    pub source: String,
    pub revision: i64,
    pub message_count: i64,
    pub tail_hash: Option<String>,
    pub synced_mtime: f64,
    pub active_generation: String,
}

/// What one retention purge removed — counts only, which is all the hub logs.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PurgeCounts {
    pub sessions: i64,
    pub messages: i64,
    pub archived_turns: i64,
    pub board_cards: i64,
}

#[derive(Clone, Debug)]
pub struct PreparedSync {
    pub generation: String,
    pub start_position: i64,
}

/// A session whose title the hub may write (`hub/titles.rs`).
pub struct TitleCandidate {
    pub machine_id: String,
    pub source: String,
    pub session_id: String,
    pub message_count: i64,
    pub modified: f64,
    pub title: Option<String>,
}

/// The replica's tables. They live in the SAME file as the workspace store
/// (`CC_REMOTE_DB_PATH`), which is why account deletion can clear them in its
/// one transaction; a test builds them on the workspace connection from here.
pub(crate) const SCHEMA: &str = r#"
            CREATE TABLE IF NOT EXISTS machines (
                machine_id   TEXT PRIMARY KEY,
                machine_json TEXT NOT NULL,
                last_seen    INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                machine_id       TEXT NOT NULL,
                source           TEXT NOT NULL,
                session_id       TEXT NOT NULL,
                summary_json     TEXT NOT NULL,
                catalog_modified REAL NOT NULL DEFAULT 0,
                synced_mtime     REAL NOT NULL DEFAULT -1,
                revision         INTEGER NOT NULL DEFAULT 0,
                message_count    INTEGER NOT NULL DEFAULT 0,
                tail_hash        TEXT,
                active_generation TEXT NOT NULL DEFAULT '',
                deleted          INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (machine_id, source, session_id),
                FOREIGN KEY (machine_id) REFERENCES machines(machine_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS session_messages (
                machine_id TEXT NOT NULL,
                source     TEXT NOT NULL,
                session_id TEXT NOT NULL,
                generation TEXT NOT NULL,
                position   INTEGER NOT NULL,
                message_json TEXT NOT NULL,
                PRIMARY KEY (machine_id, source, session_id, generation, position),
                FOREIGN KEY (machine_id, source, session_id)
                    REFERENCES sessions(machine_id, source, session_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS erased_sessions (
                machine_id TEXT NOT NULL, session_id TEXT NOT NULL,
                PRIMARY KEY(machine_id,session_id)
            );
            CREATE TRIGGER IF NOT EXISTS no_erased_session_reimport
            BEFORE INSERT ON sessions WHEN EXISTS
                (SELECT 1 FROM erased_sessions WHERE machine_id=NEW.machine_id AND session_id=NEW.session_id)
            BEGIN SELECT RAISE(IGNORE); END;
            CREATE INDEX IF NOT EXISTS sessions_recent
                ON sessions(machine_id, deleted, catalog_modified DESC);
            CREATE TABLE IF NOT EXISTS session_titles (
                machine_id  TEXT NOT NULL,
                source      TEXT NOT NULL,
                session_id  TEXT NOT NULL,
                title       TEXT,
                basis_count INTEGER NOT NULL,
                generated_at INTEGER NOT NULL,
                PRIMARY KEY (machine_id, source, session_id),
                FOREIGN KEY (machine_id, source, session_id)
                    REFERENCES sessions(machine_id, source, session_id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS sessions_recent_all
                ON sessions(deleted, catalog_modified DESC);
            "#;

/// Sessions a person deleted on purpose (`session.delete`). A session whose
/// file vanished for any OTHER reason — Claude Code's 30-day
/// `cleanupPeriodDays`, a wiped home — stays in the snapshot as `archived`
/// and reads from the replica; one listed here does not come back.
const USER_DELETED_SCHEMA: &str = r#"
            CREATE TABLE user_deleted_sessions (
                machine_id TEXT NOT NULL, session_id TEXT NOT NULL,
                deleted_at INTEGER NOT NULL,
                PRIMARY KEY(machine_id, session_id)
            );
            "#;

/// Claude Code's default `cleanupPeriodDays`. Only a transcript older than
/// this can have been removed by it.
const CLEANUP_WINDOW_MS: i64 = 30 * 86_400_000;

/// SQLite-backed durable catalog. The hub is single-owner/single-threaded, so
/// synchronous rusqlite calls stay short and avoid another locking layer.
pub struct ReplicaStore {
    conn: Connection,
}

/// How many candidate rows one `recent_sessions` call may read, per row it may return.
const RECENT_SCAN_FACTOR: usize = 50;

/// Newest first off the `sessions_recent_all` index; the reader stops at its cap.
const RECENT_SESSIONS_SQL: &str = r#"SELECT s.machine_id, m.machine_json, s.summary_json
                   FROM sessions s JOIN machines m ON m.machine_id=s.machine_id
                   WHERE s.deleted=0 AND s.catalog_modified > ?1
                   ORDER BY s.catalog_modified DESC"#;

impl ReplicaStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create database directory {}: {e}", parent.display()))?;
        }
        let conn = Connection::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
        // Same file as the workspace store; see `WorkspaceStore::open` for why
        // a writer waits instead of failing on the other connection's lock.
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| format!("busy_timeout {}: {e}", path.display()))?;
        Self::init(conn)
    }

    #[cfg(test)]
    pub(crate) fn open_memory() -> Self {
        Self::init(Connection::open_in_memory().expect("memory sqlite")).expect("schema")
    }

    /// Every stored message row of a machine, raw - what a stolen database
    /// file would show.
    #[cfg(test)]
    pub(crate) fn raw_messages_for_test(&self, machine_id: &str) -> Vec<String> {
        let mut stmt = self
            .conn
            .prepare("SELECT message_json FROM session_messages WHERE machine_id=?1")
            .expect("prepare");
        stmt.query_map([machine_id], |r| r.get::<_, String>(0))
            .expect("query")
            .map(|r| r.expect("row"))
            .collect()
    }

    /// Put messages in the replica without replaying a sync, so a test can tell
    /// a replica answer apart from a forwarded one by its text.
    #[cfg(test)]
    pub(crate) fn put_messages_for_test(
        &self,
        machine_id: &str,
        source: &str,
        session_id: &str,
        messages: &[Value],
    ) {
        for (i, message) in messages.iter().enumerate() {
            self.conn
                .execute(
                    r#"INSERT OR REPLACE INTO session_messages
                         (machine_id, source, session_id, generation, position, message_json)
                       VALUES (?1, ?2, ?3, 'g1', ?4, ?5)"#,
                    params![
                        machine_id,
                        source,
                        session_id,
                        i as i64,
                        message.to_string()
                    ],
                )
                .expect("message row");
        }
        self.conn
            .execute(
                "UPDATE sessions SET message_count=?4
                 WHERE machine_id=?1 AND source=?2 AND session_id=?3",
                params![machine_id, source, session_id, messages.len() as i64],
            )
            .expect("count");
    }

    /// Plant a committed revision without replaying a sync, so a test can say
    /// "the replica stopped here" in one line.
    #[cfg(test)]
    pub(crate) fn set_state_for_test(
        &self,
        machine_id: &str,
        source: &str,
        session_id: &str,
        revision: i64,
        synced_mtime: f64,
    ) {
        self.conn
            .execute(
                "INSERT OR REPLACE INTO machines (machine_id, machine_json, last_seen)
                 VALUES (?1, '{}', 0)",
                params![machine_id],
            )
            .expect("machine row");
        self.conn
            .execute(
                r#"INSERT INTO sessions
                     (machine_id, source, session_id, summary_json, catalog_modified,
                      synced_mtime, revision, message_count, active_generation)
                   VALUES (?1, ?2, ?3, '{}', ?6, ?6, ?4, 1, 'g1')
                   ON CONFLICT(machine_id, source, session_id) DO UPDATE SET
                     revision=?4, synced_mtime=?6"#,
                params![machine_id, source, session_id, revision, 1i64, synced_mtime],
            )
            .expect("session row");
    }

    fn init(conn: Connection) -> Result<Self, String> {
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(err)?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(err)?;
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(err)?;
        conn.execute_batch(SCHEMA).map_err(err)?;
        Self::ensure_user_deleted(&conn)?;
        Ok(Self { conn })
    }

    /// Create `user_deleted_sessions` once. Deletions made before it existed
    /// were never recorded, so on creation the rows cleanup could NOT have
    /// removed — tombstoned while younger than its window — are taken as
    /// deleted by hand (28.09.2026: 11 of 1810). The older ones are assumed to
    /// be cleanup and come back as archived.
    fn ensure_user_deleted(conn: &Connection) -> Result<(), String> {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_deleted_sessions')",
                [],
                |row| row.get(0),
            )
            .map_err(err)?;
        if exists {
            return Ok(());
        }
        let now = now_ms();
        let tx = conn.unchecked_transaction().map_err(err)?;
        tx.execute_batch(USER_DELETED_SCHEMA).map_err(err)?;
        tx.execute(
            r#"INSERT OR IGNORE INTO user_deleted_sessions(machine_id, session_id, deleted_at)
               SELECT machine_id, session_id, ?1 FROM sessions
               WHERE deleted=1
                 AND COALESCE(json_extract(summary_json, '$.lastModified'), 0) > ?1 - ?2"#,
            params![now, CLEANUP_WINDOW_MS],
        )
        .map_err(err)?;
        tx.commit().map_err(err)
    }

    /// Drop everything the hub holds of these sessions — the catalog row and,
    /// by cascade, every replicated message. The machine's owner took their
    /// folder off the synced list (`sync_forget`, agent/src/policy.ts): not an
    /// «archived» session, not a tombstone — gone, so it can sync afresh if the
    /// folder is picked again. Returns how many rows went.
    pub fn forget_sessions(
        &mut self,
        machine_id: &str,
        sessions: &[(String, String)],
    ) -> Result<usize, String> {
        let tx = self.conn.transaction().map_err(err)?;
        let mut gone = 0;
        for (source, session_id) in sessions {
            gone += tx
                .execute(
                    "DELETE FROM sessions WHERE machine_id=?1 AND source=?2 AND session_id=?3",
                    params![machine_id, source, session_id],
                )
                .map_err(err)?;
        }
        tx.commit().map_err(err)?;
        Ok(gone)
    }

    /// Machines whose owner limited how long the hub may keep their
    /// transcripts: `policy.transcriptRetentionDays` in the machine info the
    /// agent registered with (agent/src/policy.ts). Read from the persisted row,
    /// so a machine that is offline today is still purged. Never below one day:
    /// the hub only ever reads this number, and reading it can only shorten.
    pub fn retention_machines(&self) -> Result<Vec<(String, i64)>, String> {
        let mut stmt = self
            .conn
            .prepare(
                r#"SELECT machine_id,
                          CAST(json_extract(machine_json, '$.policy.transcriptRetentionDays') AS REAL)
                   FROM machines
                   WHERE json_valid(machine_json)
                     AND json_type(machine_json, '$.policy.transcriptRetentionDays') IN ('integer', 'real')"#,
            )
            .map_err(err)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
            })
            .map_err(err)?;
        let mut out = Vec::new();
        for row in rows {
            let (machine_id, days) = row.map_err(err)?;
            if days.is_finite() {
                out.push((machine_id, (days.floor() as i64).max(1)));
            }
        }
        Ok(out)
    }

    /// Sessions of this machine whose transcript was last written before
    /// `cutoff_ms` — judged on the transcript's own clock (`catalog_modified`
    /// is the summary's `lastModified`), archived rows included.
    pub fn sessions_idle_since(
        &self,
        machine_id: &str,
        cutoff_ms: i64,
    ) -> Result<Vec<(String, String)>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT source, session_id FROM sessions WHERE machine_id=?1 AND catalog_modified < ?2",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map(params![machine_id, cutoff_ms as f64], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(err)?;
        rows.map(|r| r.map_err(err)).collect()
    }

    /// Drop every copy of these sessions' content the hub's database holds,
    /// for a machine whose owner set a retention period (`retention_machines`).
    ///
    /// The same tables account erasure clears (`account_deletion.rs`
    /// `erase_account`), minus the tombstone: the catalog row and by cascade
    /// every replicated message, the speech archive `conversation_turns`
    /// (`deploy/archive-conversations.py`), and the board's derivatives —
    /// cards summarised from these sessions and the assembler's memos. No
    /// `erased_sessions` row: a session the owner picks up again on the machine
    /// syncs afresh and expires again, it is not banned. One transaction.
    pub fn purge_sessions(
        &mut self,
        machine_id: &str,
        sessions: &[(String, String)],
    ) -> Result<PurgeCounts, String> {
        self.purge_sessions_with(machine_id, sessions, false)
    }

    /// `purge_sessions` for a machine that has JUST become private. The board is
    /// shared with other machines, so it is touched narrowly: only THIS
    /// machine's links to cards go (and a card left with no session at all),
    /// a card that also summarises other machines' sessions stays, and the
    /// global digest watermark is not reset.
    pub fn purge_sessions_for_private(
        &mut self,
        machine_id: &str,
        sessions: &[(String, String)],
    ) -> Result<PurgeCounts, String> {
        self.purge_sessions_with(machine_id, sessions, true)
    }

    fn purge_sessions_with(
        &mut self,
        machine_id: &str,
        sessions: &[(String, String)],
        narrow_board: bool,
    ) -> Result<PurgeCounts, String> {
        let mut counts = PurgeCounts::default();
        if sessions.is_empty() {
            return Ok(counts);
        }
        let tx = self.conn.transaction().map_err(err)?;
        tx.execute_batch(
            "CREATE TEMP TABLE IF NOT EXISTS retention_purge(source TEXT, session_id TEXT, PRIMARY KEY(source, session_id));
             DELETE FROM retention_purge;",
        )
        .map_err(err)?;
        for (source, session_id) in sessions {
            tx.execute(
                "INSERT OR IGNORE INTO retention_purge(source, session_id) VALUES (?1, ?2)",
                params![source, session_id],
            )
            .map_err(err)?;
        }
        let has_table = |name: &str| -> Result<bool, String> {
            tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [name],
                |r| r.get(0),
            )
            .map_err(err)
        };
        counts.messages = tx
            .query_row(
                "SELECT count(*) FROM session_messages m JOIN retention_purge p
                   ON p.source=m.source AND p.session_id=m.session_id WHERE m.machine_id=?1",
                [machine_id],
                |r| r.get(0),
            )
            .map_err(err)?;
        counts.sessions = tx
            .execute(
                "DELETE FROM sessions WHERE machine_id=?1 AND EXISTS(SELECT 1 FROM retention_purge p
                   WHERE p.source=sessions.source AND p.session_id=sessions.session_id)",
                [machine_id],
            )
            .map_err(err)? as i64;
        if has_table("conversation_turns")? {
            counts.archived_turns = tx
                .execute(
                    "DELETE FROM conversation_turns WHERE machine_id=?1 AND EXISTS(SELECT 1 FROM retention_purge p
                       WHERE p.source=conversation_turns.source AND p.session_id=conversation_turns.session_id)",
                    [machine_id],
                )
                .map_err(err)? as i64;
        }
        if narrow_board && has_table("board_card_sessions")? {
            tx.execute_batch(
                "CREATE TEMP TABLE IF NOT EXISTS retention_cards(card_id TEXT PRIMARY KEY); DELETE FROM retention_cards;",
            )
            .map_err(err)?;
            tx.execute(
                "INSERT OR IGNORE INTO retention_cards SELECT card_id FROM board_card_sessions l
                   WHERE l.machine_id=?1 AND EXISTS(SELECT 1 FROM retention_purge p
                     WHERE p.source=l.source AND p.session_id=l.session_id)",
                [machine_id],
            )
            .map_err(err)?;
            tx.execute(
                "DELETE FROM board_session_state WHERE machine_id=?1 AND EXISTS(SELECT 1 FROM retention_purge p
                   WHERE p.source=board_session_state.source AND p.session_id=board_session_state.session_id)",
                [machine_id],
            )
            .map_err(err)?;
            tx.execute(
                "DELETE FROM board_card_sessions WHERE machine_id=?1 AND EXISTS(SELECT 1 FROM retention_purge p
                   WHERE p.source=board_card_sessions.source AND p.session_id=board_card_sessions.session_id)",
                [machine_id],
            )
            .map_err(err)?;
            counts.board_cards = tx
                .execute(
                    "DELETE FROM board_cards WHERE card_id IN (SELECT card_id FROM retention_cards)
                       AND NOT EXISTS(SELECT 1 FROM board_card_sessions l WHERE l.card_id=board_cards.card_id)",
                    [],
                )
                .map_err(err)? as i64;
            tx.execute_batch("DROP TABLE retention_cards;")
                .map_err(err)?;
        } else if has_table("board_card_sessions")? {
            // As in erasure: a card summarised from a purged session cannot be
            // redacted, so it goes whole, and every session that fed it is
            // re-digested from what is still here (watermark back to zero).
            tx.execute_batch(
                "CREATE TEMP TABLE IF NOT EXISTS retention_cards(card_id TEXT PRIMARY KEY); DELETE FROM retention_cards;",
            )
            .map_err(err)?;
            tx.execute(
                "INSERT OR IGNORE INTO retention_cards SELECT card_id FROM board_card_sessions l
                   WHERE l.machine_id=?1 AND EXISTS(SELECT 1 FROM retention_purge p
                     WHERE p.source=l.source AND p.session_id=l.session_id)",
                [machine_id],
            )
            .map_err(err)?;
            tx.execute(
                "DELETE FROM board_session_state WHERE (machine_id=?1 AND EXISTS(SELECT 1 FROM retention_purge p
                     WHERE p.source=board_session_state.source AND p.session_id=board_session_state.session_id))
                   OR (machine_id, source, session_id) IN (SELECT machine_id, source, session_id FROM board_card_sessions
                     WHERE card_id IN (SELECT card_id FROM retention_cards))",
                [machine_id],
            )
            .map_err(err)?;
            counts.board_cards = tx
                .execute(
                    "DELETE FROM board_cards WHERE card_id IN (SELECT card_id FROM retention_cards)",
                    [],
                )
                .map_err(err)? as i64;
            if counts.board_cards > 0 {
                tx.execute(
                    "INSERT INTO board_state(key,value) VALUES('watermark_ms','0')
                       ON CONFLICT(key) DO UPDATE SET value='0'",
                    [],
                )
                .map_err(err)?;
            }
            tx.execute_batch("DROP TABLE retention_cards;")
                .map_err(err)?;
        } else if has_table("board_session_state")? {
            tx.execute(
                "DELETE FROM board_session_state WHERE machine_id=?1 AND EXISTS(SELECT 1 FROM retention_purge p
                   WHERE p.source=board_session_state.source AND p.session_id=board_session_state.session_id)",
                [machine_id],
            )
            .map_err(err)?;
        }
        tx.execute_batch("DROP TABLE retention_purge;")
            .map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(counts)
    }

    /// Remember that a person deleted this session, so it is not offered back
    /// as archived once its file is gone.
    pub fn mark_user_deleted(&self, machine_id: &str, session_id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT OR IGNORE INTO user_deleted_sessions(machine_id, session_id, deleted_at) VALUES (?1, ?2, ?3)",
                params![machine_id, session_id, now_ms()],
            )
            .map(|_| ())
            .map_err(err)
    }

    /// Take a deletion back: the agent refused or dropped, the file is still
    /// there, and when it does vanish the session should archive normally.
    pub fn unmark_user_deleted(&self, machine_id: &str, session_id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "DELETE FROM user_deleted_sessions WHERE machine_id=?1 AND session_id=?2",
                params![machine_id, session_id],
            )
            .map(|_| ())
            .map_err(err)
    }

    fn exists(&self, sql: &str, machine_id: &str, session_id: &str) -> bool {
        self.conn
            .query_row(sql, params![machine_id, session_id], |row| {
                row.get::<_, bool>(0)
            })
            .unwrap_or(false)
    }

    /// Any catalog row for this session, gone from disk or not.
    pub fn has_session(&self, machine_id: &str, session_id: &str) -> bool {
        self.exists(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE machine_id=?1 AND session_id=?2)",
            machine_id,
            session_id,
        )
    }

    /// A session whose file is gone from the machine but whose replica is
    /// still here, and which nobody deleted on purpose: readable, never
    /// resumable.
    pub fn is_archived(&self, machine_id: &str, session_id: &str) -> bool {
        self.exists(
            r#"SELECT EXISTS(SELECT 1 FROM sessions s WHERE machine_id=?1 AND session_id=?2 AND deleted=1
                 AND NOT EXISTS (SELECT 1 FROM user_deleted_sessions u
                   WHERE u.machine_id=s.machine_id AND u.session_id=s.session_id))"#,
            machine_id,
            session_id,
        )
    }

    /// Deleted by a person AND tombstoned in the catalog (the file is gone):
    /// nobody reads it any more. (A deletion still in flight is the hub's
    /// in-memory `PendingRpc.deleting`; the durable marker alone is not final —
    /// it survives a restart between the mark and the agent's answer.)
    pub fn is_deleted_by_user(&self, machine_id: &str, session_id: &str) -> bool {
        self.exists(
            r#"SELECT EXISTS(SELECT 1 FROM sessions s JOIN user_deleted_sessions u
                 ON u.machine_id=s.machine_id AND u.session_id=s.session_id
                 WHERE s.machine_id=?1 AND s.session_id=?2 AND s.deleted=1)"#,
            machine_id,
            session_id,
        )
    }

    /// The agent confirmed the deletion of a session a person asked to delete:
    /// tombstone it in the catalog NOW, so it is final from this instant and not
    /// only when the next inventory notices the file is gone.
    pub fn confirm_user_deleted(&self, machine_id: &str, session_id: &str) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE sessions SET deleted=1 WHERE machine_id=?1 AND session_id=?2 AND EXISTS(SELECT 1 FROM user_deleted_sessions u WHERE u.machine_id=?1 AND u.session_id=?2)",
                params![machine_id, session_id],
            )
            .map(|_| ())
            .map_err(err)
    }

    /// Where a session lives, by the hub's own record — including a session
    /// whose file is gone. Access checks must never fall back to a cwd the
    /// CLIENT names for a session the hub has on file.
    pub fn session_cwd(&self, machine_id: &str, session_id: &str) -> Option<String> {
        self.conn
            .query_row(
                "SELECT json_extract(summary_json, '$.cwd') FROM sessions WHERE machine_id=?1 AND session_id=?2 LIMIT 1",
                params![machine_id, session_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten()
    }

    /// Every session of a machine the UI is shown, newest first, with NO cap:
    /// the ones on disk, then — marked `archived: true` — the ones whose file
    /// is gone but whose history the replica holds, unless a person deleted
    /// them (`user_deleted_sessions`).
    pub fn snapshot_sessions(&self, machine_id: &str) -> Result<Vec<Value>, String> {
        let mut stmt = self
            .conn
            .prepare(
                r#"SELECT summary_json, deleted FROM sessions s
                   WHERE machine_id=?1
                     AND (deleted=0 OR (revision>0 AND NOT EXISTS
                       (SELECT 1 FROM user_deleted_sessions u
                        WHERE u.machine_id=s.machine_id AND u.session_id=s.session_id)))
                   ORDER BY catalog_modified DESC"#,
            )
            .map_err(err)?;
        let rows = stmt
            .query_map(params![machine_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(err)?;
        let mut out = Vec::new();
        for row in rows {
            let (raw, deleted) = row.map_err(err)?;
            let Ok(mut value) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            if deleted != 0 {
                if let Some(obj) = value.as_object_mut() {
                    obj.insert("archived".into(), Value::Bool(true));
                }
            }
            out.push(value);
        }
        Ok(out)
    }

    /// Live (not deleted) sessions of machines NOT in `exclude` whose last
    /// message is newer than `since_ms`: `(machine_id, machine, summary)`.
    /// The watch inbox's recent list for machines that are away.
    pub fn recent_sessions(
        &self,
        since_ms: f64,
        exclude: &HashSet<String>,
        keep: &mut dyn FnMut(&str) -> bool,
        limit: usize,
    ) -> Result<Vec<(String, Value, Value)>, String> {
        let mut stmt = self.conn.prepare(RECENT_SESSIONS_SQL).map_err(err)?;
        let rows = stmt
            .query_map(params![since_ms], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(err)?;
        // Each machine's JSON is parsed once, however many rows it has.
        let mut machines: HashMap<String, Option<Value>> = HashMap::new();
        let mut kept: HashMap<String, bool> = HashMap::new();
        let mut out = Vec::new();
        // Runs on the hub loop for any active user: rows `keep` rejects must not
        // make one request walk the whole fleet's 48 hours.
        for row in rows.take(limit.saturating_mul(RECENT_SCAN_FACTOR)) {
            if out.len() >= limit {
                break;
            }
            let (machine_id, machine, summary) = row.map_err(err)?;
            if exclude.contains(&machine_id)
                || !*kept
                    .entry(machine_id.clone())
                    .or_insert_with(|| keep(&machine_id))
            {
                continue;
            }
            let Some(machine) = machines
                .entry(machine_id.clone())
                .or_insert_with(|| serde_json::from_str::<Value>(&machine).ok())
                .clone()
            else {
                continue;
            };
            let Ok(summary) = serde_json::from_str::<Value>(&summary) else {
                continue;
            };
            out.push((machine_id, machine, summary));
        }
        Ok(out)
    }

    /// The stored `private` reading of a machine: `None` = no row yet,
    /// `Some(false)` = a row that is not private, `Some(true)` = private.
    /// A purge on becoming private fires only on `Some(false)` -> private.
    pub fn machine_private_state(&self, machine_id: &str) -> Option<bool> {
        self.conn
            .query_row(
                "SELECT json_extract(machine_json,'$.private') FROM machines WHERE machine_id=?1",
                [machine_id],
                |r| r.get::<_, Option<i64>>(0),
            )
            .ok()
            .map(|v| v == Some(1))
    }

    pub fn record_machine(&mut self, machine: &Value, last_seen: i64) -> Result<(), String> {
        let machine_id = machine
            .get("machineId")
            .and_then(Value::as_str)
            .ok_or_else(|| "machineId missing".to_string())?;
        self.conn
            .execute(
                r#"INSERT INTO machines(machine_id, machine_json, last_seen)
                   VALUES (?1, ?2, ?3)
                   ON CONFLICT(machine_id) DO UPDATE SET
                     machine_json=excluded.machine_json, last_seen=excluded.last_seen"#,
                params![machine_id, machine.to_string(), last_seen],
            )
            .map_err(err)?;
        Ok(())
    }

    /// Persist an inventory. Only an explicitly complete inventory may
    /// tombstone absent rows; capped agents must never hide older sessions.
    pub fn record_inventory(
        &mut self,
        machine_id: &str,
        sessions: &[Value],
        complete: bool,
        last_seen: i64,
    ) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(err)?;
        tx.execute(
            "UPDATE machines SET last_seen=?2 WHERE machine_id=?1",
            params![machine_id, last_seen],
        )
        .map_err(err)?;
        // What the catalog already holds for this machine, so a row that would
        // be rewritten byte for byte is not rewritten. An inventory arrives
        // every few seconds from a busy agent and is, almost always, the same
        // thousand sessions: re-upserting each one (and, for a complete
        // inventory, first tombstoning ALL of them) was a transaction of
        // thousands of writes on the hub's single command loop. Read from the
        // table, not remembered: replication commits rewrite `summary_json`
        // too, and a stale memory would skip a write that was owed.
        let mut known: HashMap<(String, String), (String, i64)> = HashMap::new();
        {
            let mut stmt = tx
                .prepare(
                    "SELECT source, session_id, summary_json, deleted FROM sessions WHERE machine_id=?1",
                )
                .map_err(err)?;
            let rows = stmt
                .query_map(params![machine_id], |row| {
                    Ok((
                        (row.get::<_, String>(0)?, row.get::<_, String>(1)?),
                        (row.get::<_, String>(2)?, row.get::<_, i64>(3)?),
                    ))
                })
                .map_err(err)?;
            for row in rows {
                let (key, value) = row.map_err(err)?;
                known.insert(key, value);
            }
        }
        // Before the comparison: an agent keeps sending its own guess, and the
        // row holds the generated title, which must not read as a change.
        let mut generated: HashMap<(String, String), String> = HashMap::new();
        {
            let mut stmt = tx
                .prepare(
                    "SELECT source, session_id, title FROM session_titles
                     WHERE machine_id=?1 AND title IS NOT NULL",
                )
                .map_err(err)?;
            let rows = stmt
                .query_map(params![machine_id], |row| {
                    Ok((
                        (row.get::<_, String>(0)?, row.get::<_, String>(1)?),
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(err)?;
            for row in rows {
                let (key, title) = row.map_err(err)?;
                generated.insert(key, title);
            }
        }
        let mut reported: HashSet<(String, String)> = HashSet::new();
        for summary in sessions {
            let (key, summary) = prepare_summary(summary)?;
            let summary = wear_generated_title(summary, generated.get(&key).map(String::as_str));
            let raw = summary.to_string();
            let unchanged = known
                .get(&key)
                .is_some_and(|(stored, deleted)| *deleted == 0 && *stored == raw);
            if !unchanged {
                write_summary(&tx, machine_id, &key, &summary, &raw)?;
                // A key repeated in one inventory must compare with what was
                // just written, so the LAST occurrence wins as it did before.
                known.insert(key.clone(), (raw, 0));
            }
            reported.insert(key);
        }
        // Only an explicitly complete inventory may tombstone absent rows;
        // capped agents must never hide older sessions. Same end state as
        // "tombstone everything, then un-delete what was reported", written
        // only for the rows that actually flip.
        if complete {
            for ((source, session_id), (_, deleted)) in &known {
                if *deleted == 0 && !reported.contains(&(source.clone(), session_id.clone())) {
                    tx.execute(
                        "UPDATE sessions SET deleted=1 WHERE machine_id=?1 AND source=?2 AND session_id=?3",
                        params![machine_id, source, session_id],
                    )
                    .map_err(err)?;
                }
            }
        }
        tx.commit().map_err(err)
    }

    /// Sessions of a machine whose title is due, newest first: nobody named
    /// them, the replica holds them, and they have no generated title yet. A pass
    /// that produced none is retried once the session has grown.
    /// The cron runs (`sdk-cli`, 500+ a week on stage) nobody reads are left out.
    pub fn title_candidates(
        &self,
        machine_id: &str,
        since: i64,
        quiet_before: i64,
        limit: usize,
    ) -> Result<Vec<TitleCandidate>, String> {
        let mut stmt = self
            .conn
            .prepare_cached(
                r#"SELECT s.source, s.session_id, s.message_count, s.catalog_modified,
                          json_extract(s.summary_json, '$.title')
                   FROM sessions s
                   LEFT JOIN session_titles t ON t.machine_id=s.machine_id
                        AND t.source=s.source AND t.session_id=s.session_id
                   WHERE s.machine_id=?1 AND s.deleted=0
                     AND s.catalog_modified>=?2 AND s.catalog_modified<=?3
                     AND s.revision>0 AND s.message_count>=2
                     AND json_extract(s.summary_json, '$.titleDerived')=1
                     AND json_extract(s.summary_json, '$.automated') IS NOT 1
                     AND json_extract(s.summary_json, '$.entrypoint') IS NOT 'sdk-cli'
                     AND (t.basis_count IS NULL
                          OR (t.title IS NULL AND s.message_count>t.basis_count))
                   ORDER BY s.catalog_modified DESC LIMIT ?4"#,
            )
            .map_err(err)?;
        let rows = stmt
            .query_map(
                params![machine_id, since, quiet_before, limit as i64],
                |r| {
                    Ok(TitleCandidate {
                        machine_id: machine_id.to_string(),
                        source: r.get(0)?,
                        session_id: r.get(1)?,
                        message_count: r.get(2)?,
                        modified: r.get(3)?,
                        title: r.get(4)?,
                    })
                },
            )
            .map_err(err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(err)
    }

    /// Remember a pass over `basis_count` messages and, when it produced a
    /// title, put it on the session. True when the session's title moved. A
    /// rename that landed while the model was working has already cleared
    /// `titleDerived`, so it wins; a session deleted meanwhile records nothing.
    pub fn record_generated_title(
        &mut self,
        machine_id: &str,
        source: &str,
        session_id: &str,
        title: Option<&str>,
        basis_count: i64,
        now: i64,
    ) -> Result<bool, String> {
        let tx = self.conn.transaction().map_err(err)?;
        tx.execute(
            r#"INSERT INTO session_titles
                 (machine_id, source, session_id, title, basis_count, generated_at)
               SELECT machine_id, source, session_id, ?4, ?5, ?6 FROM sessions
               WHERE machine_id=?1 AND source=?2 AND session_id=?3
               ON CONFLICT(machine_id, source, session_id) DO UPDATE SET
                 title=COALESCE(excluded.title, session_titles.title),
                 basis_count=excluded.basis_count,
                 generated_at=excluded.generated_at"#,
            params![machine_id, source, session_id, title, basis_count, now],
        )
        .map_err(err)?;
        let moved = match title {
            Some(title) => {
                tx.execute(
                    r#"UPDATE sessions SET summary_json=json_set(summary_json, '$.title', ?4)
                       WHERE machine_id=?1 AND source=?2 AND session_id=?3
                         AND json_extract(summary_json, '$.titleDerived')=1
                         AND json_extract(summary_json, '$.title') IS NOT ?4"#,
                    params![machine_id, source, session_id, title],
                )
                .map_err(err)?
                    > 0
            }
            None => false,
        };
        tx.commit().map_err(err)?;
        Ok(moved)
    }

    pub fn sessions_for_machine(&self, machine_id: &str) -> Result<Vec<Value>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT summary_json FROM sessions WHERE machine_id=?1 AND deleted=0 ORDER BY catalog_modified DESC",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map(params![machine_id], |row| row.get::<_, String>(0))
            .map_err(err)?;
        let mut out = Vec::new();
        for row in rows {
            let raw = row.map_err(err)?;
            if let Ok(value) = serde_json::from_str(&raw) {
                out.push(value);
            }
        }
        Ok(out)
    }

    /// Offline machines as the UI shows them, every session included (see
    /// `snapshot_sessions`).
    pub fn machine_snapshots(&self, online_ids: &HashSet<String>) -> Result<Vec<Value>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT machine_id, machine_json, last_seen FROM machines ORDER BY last_seen DESC",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(err)?;
        let mut out = Vec::new();
        for row in rows {
            let (machine_id, raw, last_seen) = row.map_err(err)?;
            if online_ids.contains(&machine_id) {
                continue;
            }
            let Ok(machine) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            let mut sessions = self.snapshot_sessions(&machine_id)?;
            // Process liveness is ephemeral. Keeping a stale PID/active flag on
            // an offline machine would make the UI offer a misleading takeover.
            for session in &mut sessions {
                if let Some(obj) = session.as_object_mut() {
                    obj.remove("livePid");
                    obj.remove("active");
                    obj.remove("liveStatus");
                }
            }
            out.push(json!({
                "machine": machine,
                "online": false,
                "lastSeen": last_seen,
                "sessions": sessions,
            }));
        }
        Ok(out)
    }

    pub fn catalog(&self, machine_id: &str) -> Result<Vec<Value>, String> {
        let mut stmt = self
            .conn
            .prepare(
                r#"SELECT session_id, source, revision, message_count, tail_hash, synced_mtime
                   FROM sessions WHERE machine_id=?1 AND deleted=0"#,
            )
            .map_err(err)?;
        let rows = stmt
            .query_map(params![machine_id], |row| {
                Ok(ReplicaState {
                    session_id: row.get(0)?,
                    source: row.get(1)?,
                    revision: row.get(2)?,
                    message_count: row.get(3)?,
                    tail_hash: row.get(4)?,
                    synced_mtime: row.get(5)?,
                    active_generation: String::new(),
                })
            })
            .map_err(err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(state_json(&row.map_err(err)?));
        }
        Ok(out)
    }

    pub fn state(
        &self,
        machine_id: &str,
        source: &str,
        session_id: &str,
    ) -> Result<ReplicaState, String> {
        self.conn
            .query_row(
                r#"SELECT revision, message_count, tail_hash, synced_mtime, active_generation
                   FROM sessions WHERE machine_id=?1 AND source=?2 AND session_id=?3"#,
                params![machine_id, source, session_id],
                |row| {
                    Ok(ReplicaState {
                        session_id: session_id.to_string(),
                        source: source.to_string(),
                        revision: row.get(0)?,
                        message_count: row.get(1)?,
                        tail_hash: row.get(2)?,
                        synced_mtime: row.get(3)?,
                        active_generation: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(err)?
            .ok_or_else(|| "session is not in the catalog".to_string())
    }

    pub fn prepare_sync(
        &mut self,
        machine_id: &str,
        source: &str,
        session_id: &str,
        summary: &Value,
        mode: &str,
        base_revision: i64,
        sync_id: &str,
    ) -> Result<PreparedSync, String> {
        let tx = self.conn.transaction().map_err(err)?;
        upsert_summary(&tx, machine_id, summary)?;
        let state = state_in(&tx, machine_id, source, session_id)?;
        if state.revision != base_revision {
            return Err(format!(
                "revision conflict: server={}, agent={base_revision}",
                state.revision
            ));
        }
        let (generation, start_position) = match mode {
            "replace" => (sync_id.to_string(), 0),
            "append" if !state.active_generation.is_empty() => {
                (state.active_generation.clone(), state.message_count)
            }
            "append" => return Err("cannot append before the first committed replica".to_string()),
            _ => return Err("invalid sync mode".to_string()),
        };
        // Remove debris from an interrupted attempt. For append, positions at or
        // past the committed count are invisible and safe to discard.
        tx.execute(
            r#"DELETE FROM session_messages
               WHERE machine_id=?1 AND source=?2 AND session_id=?3 AND generation=?4 AND position>=?5"#,
            params![machine_id, source, session_id, generation, start_position],
        )
        .map_err(err)?;
        tx.commit().map_err(err)?;
        Ok(PreparedSync {
            generation,
            start_position,
        })
    }

    pub fn write_chunk(
        &mut self,
        machine_id: &str,
        source: &str,
        session_id: &str,
        generation: &str,
        start: i64,
        messages: &[Value],
    ) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(err)?;
        {
            let mut stmt = tx
                .prepare(
                    r#"INSERT OR REPLACE INTO session_messages
                       (machine_id, source, session_id, generation, position, message_json)
                       VALUES (?1, ?2, ?3, ?4, ?5, ?6)"#,
                )
                .map_err(err)?;
            for (i, message) in messages.iter().enumerate() {
                stmt.execute(params![
                    machine_id,
                    source,
                    session_id,
                    generation,
                    start + i as i64,
                    message.to_string(),
                ])
                .map_err(err)?;
            }
        }
        tx.commit().map_err(err)
    }

    pub fn commit_sync(
        &mut self,
        machine_id: &str,
        source: &str,
        session_id: &str,
        summary: &Value,
        mode: &str,
        base_revision: i64,
        generation: &str,
        message_count: i64,
        tail_hash: Option<&str>,
        synced_mtime: f64,
    ) -> Result<ReplicaState, String> {
        let tx = self.conn.transaction().map_err(err)?;
        let current = state_in(&tx, machine_id, source, session_id)?;
        if current.revision != base_revision {
            return Err(format!(
                "revision conflict at commit: server={}, agent={base_revision}",
                current.revision
            ));
        }
        let generated = generated_title(&tx, machine_id, source, session_id)?;
        let worn = wear_generated_title(Cow::Borrowed(summary), generated.as_deref());
        let summary: &Value = &worn;
        let changed = tx
            .execute(
                r#"UPDATE sessions SET summary_json=?4, catalog_modified=?5,
                       synced_mtime=?6, revision=revision+1, message_count=?7,
                       tail_hash=?8, active_generation=?9, deleted=0
                   WHERE machine_id=?1 AND source=?2 AND session_id=?3 AND revision=?10"#,
                params![
                    machine_id,
                    source,
                    session_id,
                    summary.to_string(),
                    summary_mtime(summary),
                    synced_mtime,
                    message_count,
                    tail_hash,
                    generation,
                    base_revision,
                ],
            )
            .map_err(err)?;
        if changed != 1 {
            return Err("session changed while committing".to_string());
        }
        if mode == "replace" {
            tx.execute(
                r#"DELETE FROM session_messages
                   WHERE machine_id=?1 AND source=?2 AND session_id=?3 AND generation<>?4"#,
                params![machine_id, source, session_id, generation],
            )
            .map_err(err)?;
        }
        tx.commit().map_err(err)?;
        self.state(machine_id, source, session_id)
    }

    pub fn abort_sync(
        &mut self,
        machine_id: &str,
        source: &str,
        session_id: &str,
        generation: &str,
        start_position: i64,
    ) {
        let _ = self.conn.execute(
            r#"DELETE FROM session_messages
               WHERE machine_id=?1 AND source=?2 AND session_id=?3 AND generation=?4 AND position>=?5"#,
            params![machine_id, source, session_id, generation, start_position],
        );
    }

    /// None means the session has never committed a replica; Some(empty) is a
    /// valid, committed empty transcript.
    #[cfg(test)]
    pub fn read_history(
        &self,
        machine_id: &str,
        source: &str,
        session_id: &str,
    ) -> Result<Option<Vec<Value>>, String> {
        self.read_history_tail(machine_id, source, session_id, None)
    }

    /// Read the committed transcript, optionally keeping only its newest rows.
    /// The descending SQL query avoids materializing an unbounded offline
    /// history only to truncate it at the WebSocket boundary.
    pub fn read_history_tail(
        &self,
        machine_id: &str,
        source: &str,
        session_id: &str,
        limit: Option<usize>,
    ) -> Result<Option<Vec<Value>>, String> {
        self.read_history_slice(machine_id, source, session_id, limit, false)
    }

    pub fn read_history_head(
        &self,
        machine_id: &str,
        source: &str,
        session_id: &str,
        limit: usize,
    ) -> Result<Option<Vec<Value>>, String> {
        self.read_history_slice(machine_id, source, session_id, Some(limit), true)
    }

    fn read_history_slice(
        &self,
        machine_id: &str,
        source: &str,
        session_id: &str,
        limit: Option<usize>,
        head: bool,
    ) -> Result<Option<Vec<Value>>, String> {
        let state = match self.state(machine_id, source, session_id) {
            Ok(s) if s.revision > 0 => s,
            Ok(_) => return Ok(None),
            Err(e) if e == "session is not in the catalog" => return Ok(None),
            Err(e) => return Err(e),
        };
        let (sql, descending) = if limit.is_some() && !head {
            (
                r#"SELECT message_json FROM session_messages
                   WHERE machine_id=?1 AND source=?2 AND session_id=?3
                     AND generation=?4 AND position<?5
                   ORDER BY position DESC LIMIT ?6"#,
                true,
            )
        } else {
            (
                r#"SELECT message_json FROM session_messages
                   WHERE machine_id=?1 AND source=?2 AND session_id=?3
                     AND generation=?4 AND position<?5 ORDER BY position LIMIT ?6"#,
                false,
            )
        };
        let mut stmt = self.conn.prepare(sql).map_err(err)?;
        let max_rows = limit
            .map(|value| value as i64)
            .unwrap_or(state.message_count);
        let rows = stmt
            .query_map(
                params![
                    machine_id,
                    source,
                    session_id,
                    state.active_generation,
                    state.message_count,
                    max_rows,
                ],
                |row| row.get::<_, String>(0),
            )
            .map_err(err)?;
        let mut out = Vec::new();
        for row in rows {
            let raw = row.map_err(err)?;
            if let Ok(value) = serde_json::from_str(&raw) {
                out.push(value);
            }
        }
        if descending {
            out.reverse();
        }
        Ok(Some(out))
    }
}

pub fn state_json(state: &ReplicaState) -> Value {
    json!({
        "sessionId": state.session_id,
        "source": state.source,
        "revision": state.revision,
        "messageCount": state.message_count,
        "tailHash": state.tail_hash,
        "syncedMtime": state.synced_mtime,
    })
}

/// The title the hub wrote for this session, if it wrote one.
fn generated_title(
    tx: &Transaction<'_>,
    machine_id: &str,
    source: &str,
    session_id: &str,
) -> Result<Option<String>, String> {
    Ok(tx
        .query_row(
            "SELECT title FROM session_titles WHERE machine_id=?1 AND source=?2 AND session_id=?3",
            params![machine_id, source, session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(err)?
        .flatten())
}

/// The agent's summary wearing the title the hub wrote. Every write of a summary
/// passes here, so an agent re-sending its own guess cannot undo a generated
/// title — and a person's rename, which clears `titleDerived`, takes the session
/// back the moment it arrives.
fn wear_generated_title<'a>(summary: Cow<'a, Value>, title: Option<&str>) -> Cow<'a, Value> {
    match title {
        Some(title) if summary.get("titleDerived").and_then(Value::as_bool) == Some(true) => {
            let mut worn = summary.into_owned();
            worn["title"] = Value::String(title.to_string());
            Cow::Owned(worn)
        }
        _ => summary,
    }
}

fn upsert_summary(tx: &Transaction<'_>, machine_id: &str, summary: &Value) -> Result<(), String> {
    let (key, summary) = prepare_summary(summary)?;
    let generated = generated_title(tx, machine_id, &key.0, &key.1)?;
    let summary = wear_generated_title(summary, generated.as_deref());
    let raw = summary.to_string();
    write_summary(tx, machine_id, &key, &summary, &raw)
}

/// The `(source, sessionId)` key of a reported summary and the summary exactly
/// as it is persisted.
fn prepare_summary(summary: &Value) -> Result<((String, String), Cow<'_, Value>), String> {
    let session_id = summary
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| "session summary has no sessionId".to_string())?;
    // Process liveness must NEVER be persisted. A stored `livePid` outlives the
    // process, the hub re-seeds it into its inventory after a restart, and every
    // `open` is then refused ("live in <editor>") for a pid that died days ago —
    // with the phone showing a read-only Mirror and no composer. The live value
    // only ever comes from a connected agent's inventory.
    let live = summary.as_object().is_some_and(|obj| {
        obj.contains_key("livePid") || obj.contains_key("active") || obj.contains_key("liveStatus")
    });
    let summary = if live {
        let mut cleaned = summary.clone();
        if let Some(obj) = cleaned.as_object_mut() {
            obj.remove("livePid");
            obj.remove("active");
            obj.remove("liveStatus");
        }
        Cow::Owned(cleaned)
    } else {
        Cow::Borrowed(summary)
    };
    let source = summary
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("claude");
    if source != "claude" && source != "codex" {
        return Err("invalid session source".to_string());
    }
    let key = (source.to_string(), session_id.to_string());
    Ok((key, summary))
}

fn write_summary(
    tx: &Transaction<'_>,
    machine_id: &str,
    (source, session_id): &(String, String),
    summary: &Value,
    raw: &str,
) -> Result<(), String> {
    tx.execute(
        r#"INSERT INTO sessions
             (machine_id, source, session_id, summary_json, catalog_modified, deleted)
           VALUES (?1, ?2, ?3, ?4, ?5, 0)
           ON CONFLICT(machine_id, source, session_id) DO UPDATE SET
             summary_json=excluded.summary_json,
             catalog_modified=excluded.catalog_modified,
             deleted=0"#,
        params![machine_id, source, session_id, raw, summary_mtime(summary)],
    )
    .map_err(err)?;
    Ok(())
}

fn state_in(
    tx: &Transaction<'_>,
    machine_id: &str,
    source: &str,
    session_id: &str,
) -> Result<ReplicaState, String> {
    tx.query_row(
        r#"SELECT revision, message_count, tail_hash, synced_mtime, active_generation
           FROM sessions WHERE machine_id=?1 AND source=?2 AND session_id=?3"#,
        params![machine_id, source, session_id],
        |row| {
            Ok(ReplicaState {
                session_id: session_id.to_string(),
                source: source.to_string(),
                revision: row.get(0)?,
                message_count: row.get(1)?,
                tail_hash: row.get(2)?,
                synced_mtime: row.get(3)?,
                active_generation: row.get(4)?,
            })
        },
    )
    .map_err(err)
}

fn summary_mtime(summary: &Value) -> f64 {
    summary
        .get("lastModified")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
}

fn err(e: rusqlite::Error) -> String {
    crate::workspace::db_err(e)
}

#[cfg(test)]
mod tests {
    /// What a client reads when the replica database fails under an RPC:
    /// `rpc_error` wraps the store's text («Could not delete: …») and sends it.
    #[test]
    fn a_replica_database_failure_is_hidden_from_the_client() {
        let conn = Connection::open_in_memory().expect("sqlite");
        let failure = conn
            .execute("DELETE FROM secret_replica_table", [])
            .expect_err("the table does not exist");
        let wrapped = format!("Could not delete: {}", super::err(failure));
        assert!(wrapped.contains("secret_replica_table"), "{wrapped}");
        assert_eq!(crate::client_safe_error(&wrapped), "internal error");
    }

    #[test]
    fn recent_sessions_uses_the_index_without_machine_id() {
        let store = ReplicaStore::open_memory();
        let plan: Vec<String> = store
            .conn
            .prepare(&format!("EXPLAIN QUERY PLAN {RECENT_SESSIONS_SQL}"))
            .unwrap()
            .query_map([0.0f64], |r| r.get::<_, String>(3))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert!(
            plan.iter().any(|d| d.contains("sessions_recent_all")),
            "{plan:?}"
        );
    }

    #[test]
    fn recent_sessions_cap_counts_only_machines_the_caller_keeps() {
        let mut store = ReplicaStore::open_memory();
        for (id, at) in [("other", 900.0), ("mine", 100.0)] {
            let machine = json!({"machineId": id, "name": id, "os": "linux", "agentVersion": "1"});
            store.record_machine(&machine, 10).unwrap();
            let summary = json!({"sessionId": format!("s-{id}"), "source": "claude", "cwd": "/r", "lastModified": at});
            store
                .record_inventory(id, std::slice::from_ref(&summary), true, 11)
                .unwrap();
        }
        let none = HashSet::new();
        // The other tenant's newer row would fill a cap of one on its own.
        let rows = store
            .recent_sessions(0.0, &none, &mut |m| m == "mine", 1)
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "mine");
    }

    #[test]
    fn recent_sessions_stops_reading_after_a_bounded_number_of_rejected_rows() {
        let mut store = ReplicaStore::open_memory();
        let machine = json!({"machineId": "m", "name": "m", "os": "linux", "agentVersion": "1"});
        store.record_machine(&machine, 10).unwrap();
        let rows: Vec<Value> = (0..RECENT_SCAN_FACTOR + 5)
            .map(|i| json!({"sessionId": format!("s{i}"), "source": "claude", "cwd": "/r", "lastModified": 100.0 + i as f64}))
            .collect();
        store.record_inventory("m", &rows, true, 11).unwrap();
        let mut seen = 0;
        let got = store
            .recent_sessions(
                0.0,
                &HashSet::new(),
                &mut |_| {
                    seen += 1;
                    true
                },
                1,
            )
            .unwrap();
        assert_eq!((got.len(), seen), (1, 1));
        let got = store
            .recent_sessions(0.0, &HashSet::new(), &mut |_| false, 1)
            .unwrap();
        assert!(got.is_empty());
    }

    use super::*;

    fn seed_one(store: &mut ReplicaStore) {
        let machine = json!({
            "machineId":"m1", "name":"Laptop", "os":"linux", "agentVersion":"1"
        });
        store.record_machine(&machine, 10).unwrap();
        let summary = json!({
            "sessionId":"s1", "source":"claude", "title":"One", "cwd":"/repo", "lastModified":100.0
        });
        store
            .record_inventory("m1", std::slice::from_ref(&summary), true, 11)
            .unwrap();
        let prep = store
            .prepare_sync("m1", "claude", "s1", &summary, "replace", 0, "g1")
            .unwrap();
        store
            .write_chunk(
                "m1",
                "claude",
                "s1",
                &prep.generation,
                0,
                &[json!({"type":"user","uuid":"u1","blocks":[]})],
            )
            .unwrap();
        store
            .commit_sync(
                "m1",
                "claude",
                "s1",
                &summary,
                "replace",
                0,
                &prep.generation,
                1,
                Some("h1"),
                100.0,
            )
            .unwrap();
    }

    /// A persisted `livePid` outlives the process it names: after a hub restart
    /// it is re-seeded into the inventory and every `open` is refused for an
    /// editor that closed days ago, with the phone stuck on a read-only Mirror.
    #[test]
    fn liveness_is_never_persisted_with_a_session_summary() {
        let mut store = ReplicaStore::open_memory();
        let machine = json!({"machineId":"m1","name":"Laptop","os":"linux","agentVersion":"1"});
        store.record_machine(&machine, 10).unwrap();
        let summary = json!({
            "sessionId":"s1", "source":"claude", "title":"One", "cwd":"/repo",
            "lastModified":100.0, "livePid": 4242, "active": true, "entrypoint": "vscode"
        });
        store.record_inventory("m1", &[summary], true, 11).unwrap();

        let stored = store.sessions_for_machine("m1").unwrap();
        assert_eq!(stored.len(), 1);
        assert!(
            stored[0].get("livePid").is_none(),
            "livePid must not survive a restart"
        );
        assert!(
            stored[0].get("active").is_none(),
            "the active flag is ephemeral too"
        );
        // The editor hint is not liveness and stays useful on an offline machine.
        assert_eq!(
            stored[0].get("entrypoint").and_then(Value::as_str),
            Some("vscode")
        );
        assert_eq!(stored[0].get("title").and_then(Value::as_str), Some("One"));
    }

    #[test]
    fn replace_then_append_is_atomic_and_survives_offline() {
        let mut store = ReplicaStore::open_memory();
        seed_one(&mut store);
        let summary = json!({
            "sessionId":"s1", "source":"claude", "title":"One", "cwd":"/repo", "lastModified":100.0
        });

        let prep = store
            .prepare_sync("m1", "claude", "s1", &summary, "append", 1, "g2")
            .unwrap();
        assert_eq!(prep.start_position, 1);
        store
            .write_chunk(
                "m1",
                "claude",
                "s1",
                &prep.generation,
                1,
                &[json!({"type":"assistant","uuid":"a1","blocks":[]})],
            )
            .unwrap();
        assert_eq!(
            store
                .read_history("m1", "claude", "s1")
                .unwrap()
                .unwrap()
                .len(),
            1
        );
        store
            .commit_sync(
                "m1",
                "claude",
                "s1",
                &summary,
                "append",
                1,
                &prep.generation,
                2,
                Some("h2"),
                101.0,
            )
            .unwrap();
        assert_eq!(
            store
                .read_history("m1", "claude", "s1")
                .unwrap()
                .unwrap()
                .len(),
            2
        );
        let tail = store
            .read_history_tail("m1", "claude", "s1", Some(1))
            .unwrap()
            .unwrap();
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0]["uuid"], "a1");
        let head = store
            .read_history_head("m1", "claude", "s1", 1)
            .unwrap()
            .unwrap();
        assert_eq!(head.len(), 1);
        assert_eq!(head[0]["uuid"], "u1");

        let snapshots = store.machine_snapshots(&HashSet::new()).unwrap();
        assert_eq!(snapshots[0]["online"], false);
        assert_eq!(snapshots[0]["sessions"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn catalog_and_history_survive_database_reopen() {
        let path = std::env::temp_dir().join(format!(
            "cc-remote-replica-{}-{}.sqlite3",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        {
            let mut store = ReplicaStore::open(&path).unwrap();
            seed_one(&mut store);
        }
        {
            let store = ReplicaStore::open(&path).unwrap();
            assert_eq!(
                store
                    .read_history("m1", "claude", "s1")
                    .unwrap()
                    .unwrap()
                    .len(),
                1
            );
            assert_eq!(store.machine_snapshots(&HashSet::new()).unwrap().len(), 1);
        }
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    /// A session whose file vanished (cleanup, wiped home) stays listed as
    /// `archived` while the replica holds it; one without a replica, or one a
    /// person deleted, does not.
    #[test]
    fn vanished_sessions_come_back_archived_unless_deleted_by_hand() {
        let mut store = ReplicaStore::open_memory();
        seed_one(&mut store);
        let s2 = json!({"sessionId":"s2","source":"claude","title":"Two","cwd":"/repo","lastModified":200.0});
        store.record_inventory("m1", &[s2], false, 12).unwrap();
        // Both files are gone: a complete, empty inventory.
        store.record_inventory("m1", &[], true, 13).unwrap();

        let listed = store.snapshot_sessions("m1").unwrap();
        assert_eq!(listed.len(), 1, "only the replicated one: {listed:?}");
        assert_eq!(listed[0]["sessionId"], "s1");
        assert_eq!(listed[0]["archived"], true);
        assert!(store.is_archived("m1", "s1"));
        assert!(store.sessions_for_machine("m1").unwrap().is_empty());

        store.mark_user_deleted("m1", "s1").unwrap();
        assert!(store.snapshot_sessions("m1").unwrap().is_empty());
    }

    #[test]
    fn a_session_on_disk_is_never_marked_archived_and_nothing_is_capped() {
        let mut store = ReplicaStore::open_memory();
        seed_one(&mut store);
        let many: Vec<Value> = (0..1500)
            .map(|i| json!({"sessionId":format!("x{i}"),"source":"claude","cwd":"/repo","lastModified":i as f64}))
            .collect();
        store.record_inventory("m1", &many, false, 12).unwrap();
        let listed = store.snapshot_sessions("m1").unwrap();
        assert_eq!(listed.len(), 1501);
        assert!(listed.iter().all(|s| s.get("archived").is_none()));
        let offline = store.machine_snapshots(&HashSet::new()).unwrap();
        assert_eq!(offline[0]["sessions"].as_array().unwrap().len(), 1501);
    }

    /// Deletions from before the table existed: a tombstone younger than
    /// Claude Code's 30-day window cannot be cleanup, so it is taken as a
    /// deliberate delete; an older one comes back archived.
    #[test]
    fn first_creation_counts_young_tombstones_as_deliberate() {
        let mut store = ReplicaStore::open_memory();
        seed_one(&mut store);
        let fresh = now_ms() as f64 - 86_400_000.0;
        let young =
            json!({"sessionId":"young","source":"claude","cwd":"/repo","lastModified":fresh});
        let old = json!({"sessionId":"old","source":"claude","cwd":"/repo","lastModified":1000.0});
        store
            .record_inventory("m1", &[young, old], false, 12)
            .unwrap();
        store.record_inventory("m1", &[], true, 13).unwrap();
        store
            .conn
            .execute_batch("UPDATE sessions SET revision=1; DROP TABLE user_deleted_sessions;")
            .unwrap();
        ReplicaStore::ensure_user_deleted(&store.conn).unwrap();
        let mut ids: Vec<String> = store
            .snapshot_sessions("m1")
            .unwrap()
            .iter()
            .map(|s| s["sessionId"].as_str().unwrap().to_string())
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["old", "s1"]);
        // Idempotent: a second start neither re-seeds nor fails.
        ReplicaStore::ensure_user_deleted(&store.conn).unwrap();
    }

    /// Becoming private unlinks only THIS machine's sessions from the board: a
    /// card that also summarises another machine stays, a card left with no
    /// session goes, and the global digest watermark is not reset.
    #[test]
    fn private_purge_unlinks_the_machine_without_touching_other_machines_cards() {
        let mut store = ReplicaStore::open_memory();
        crate::board::init_board_schema(&store.conn).unwrap();
        store
            .record_machine(&json!({"machineId":"priv","name":"P"}), 1)
            .unwrap();
        assert_eq!(store.machine_private_state("priv"), Some(false));
        assert_eq!(store.machine_private_state("nobody"), None);
        store
            .conn
            .execute_batch(
                "INSERT INTO board_state VALUES('watermark_ms','999999');
                 INSERT INTO board_cards(card_id,title,summary,status,first_seen,last_activity,created_at,updated_at)
                   VALUES('mixed','m','s','planning',0,0,0,0),('only','o','s','planning',0,0,0,0),('other','x','s','planning',0,0,0,0);
                 INSERT INTO board_card_sessions(card_id,machine_id,source,session_id,linked_at)
                   VALUES('mixed','priv','claude','a',0),('mixed','elsewhere','claude','b',0),
                         ('only','priv','claude','a',0),('other','elsewhere','claude','b',0);",
            )
            .unwrap();
        let counts = store
            .purge_sessions_for_private("priv", &[("claude".into(), "a".into())])
            .unwrap();
        let count = |sql: &str| -> i64 { store.conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert_eq!(counts.board_cards, 1);
        assert_eq!(
            count("SELECT count(*) FROM board_cards WHERE card_id='mixed'"),
            1
        );
        assert_eq!(
            count("SELECT count(*) FROM board_cards WHERE card_id='only'"),
            0
        );
        assert_eq!(
            count("SELECT count(*) FROM board_cards WHERE card_id='other'"),
            1
        );
        assert_eq!(
            count("SELECT count(*) FROM board_card_sessions WHERE machine_id='priv'"),
            0
        );
        assert_eq!(
            count("SELECT count(*) FROM board_card_sessions WHERE machine_id='elsewhere'"),
            2
        );
        let mark: String = store
            .conn
            .query_row(
                "SELECT value FROM board_state WHERE key='watermark_ms'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(mark, "999999");
    }

    /// Retention selects by the transcript's own clock and by machine, and the
    /// purge clears every table that holds the content — replica, speech
    /// archive, board — without touching another machine or a fresh session.
    #[test]
    fn retention_purge_takes_only_old_sessions_of_the_declaring_machine() {
        let mut store = ReplicaStore::open_memory();
        crate::board::init_board_schema(&store.conn).unwrap();
        store
            .conn
            .execute_batch(
                "CREATE TABLE conversation_turns(machine_id TEXT, source TEXT, session_id TEXT, text TEXT);",
            )
            .unwrap();
        let day = 86_400_000.0;
        let now = 100.0 * day;
        let bureau = json!({"machineId":"bureau","name":"Бюро","os":"linux","agentVersion":"1",
                            "policy":{"chatOnly":false,"sync":"all","transcriptRetentionDays":7}});
        let other = json!({"machineId":"other","name":"Laptop","os":"linux","agentVersion":"1"});
        store.record_machine(&bureau, 1).unwrap();
        store.record_machine(&other, 1).unwrap();
        let s = |id: &str, age_days: f64| {
            json!({"sessionId":id,"source":"codex","title":"t","cwd":"/srv/legal/projects/a",
                   "lastModified": now - age_days * day})
        };
        store
            .record_inventory("bureau", &[s("old", 8.0), s("fresh", 2.0)], true, 2)
            .unwrap();
        store
            .record_inventory("other", &[s("old", 30.0)], true, 2)
            .unwrap();
        for (m, id) in [("bureau", "old"), ("bureau", "fresh"), ("other", "old")] {
            store.put_messages_for_test(
                m,
                "codex",
                id,
                &[
                    json!({"type":"user","uuid":"u","blocks":[]}),
                    json!({"type":"assistant","uuid":"a","blocks":[]}),
                ],
            );
            store
                .conn
                .execute(
                    "INSERT INTO conversation_turns VALUES(?1,'codex',?2,'фабула дела')",
                    params![m, id],
                )
                .unwrap();
        }
        store
            .conn
            .execute_batch(
                r#"INSERT INTO board_cards(card_id,title,status,first_seen,last_activity,created_at,updated_at)
                     VALUES('c-bureau','Иск','in_progress',0,0,0,0),('c-other','Other','done',0,0,0,0);
                   INSERT INTO board_card_sessions(card_id,machine_id,source,session_id,linked_at)
                     VALUES('c-bureau','bureau','codex','old',0),('c-other','other','codex','old',0);
                   INSERT INTO board_session_state(machine_id,source,session_id,processed_at)
                     VALUES('bureau','codex','old',0),('other','codex','old',0);
                   INSERT INTO board_state(key,value) VALUES('watermark_ms','12345');"#,
            )
            .unwrap();

        assert_eq!(
            store.retention_machines().unwrap(),
            vec![("bureau".to_string(), 7)]
        );
        let idle = store
            .sessions_idle_since("bureau", (now - 7.0 * day) as i64)
            .unwrap();
        assert_eq!(idle, vec![("codex".to_string(), "old".to_string())]);

        let counts = store.purge_sessions("bureau", &idle).unwrap();
        assert_eq!(
            counts,
            PurgeCounts {
                sessions: 1,
                messages: 2,
                archived_turns: 1,
                board_cards: 1
            }
        );
        let count = |sql: &str| -> i64 { store.conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert!(!store.has_session("bureau", "old"));
        assert!(store.has_session("bureau", "fresh"));
        assert!(
            store.has_session("other", "old"),
            "another machine is not ours to purge"
        );
        assert_eq!(count("SELECT count(*) FROM session_messages WHERE machine_id='bureau' AND session_id='old'"), 0);
        assert_eq!(
            count("SELECT count(*) FROM session_messages WHERE session_id='fresh'"),
            2
        );
        assert_eq!(
            count("SELECT count(*) FROM session_messages WHERE machine_id='other'"),
            2
        );
        assert_eq!(count("SELECT count(*) FROM conversation_turns WHERE machine_id='bureau' AND session_id='old'"), 0);
        assert_eq!(count("SELECT count(*) FROM conversation_turns"), 2);
        assert_eq!(count("SELECT count(*) FROM board_cards"), 1);
        assert_eq!(
            count("SELECT count(*) FROM board_card_sessions WHERE machine_id='bureau'"),
            0
        );
        assert_eq!(
            count("SELECT count(*) FROM board_session_state WHERE machine_id='bureau'"),
            0
        );
        assert_eq!(
            count("SELECT count(*) FROM board_session_state WHERE machine_id='other'"),
            1
        );
        assert_eq!(
            count("SELECT CAST(value AS INTEGER) FROM board_state WHERE key='watermark_ms'"),
            0
        );
        // No tombstone: picked up again on the machine, it syncs afresh.
        store
            .record_inventory("bureau", &[s("old", 0.0), s("fresh", 2.0)], true, 3)
            .unwrap();
        assert!(store.has_session("bureau", "old"));
        // Nothing left to purge is a no-op, not an error.
        assert_eq!(
            store.purge_sessions("bureau", &[]).unwrap(),
            PurgeCounts::default()
        );
    }

    /// A malformed or zero retention never reads as «keep for ever»; a machine
    /// that never declared one is not listed at all.
    #[test]
    fn retention_days_are_read_from_the_machine_and_never_below_one() {
        let mut store = ReplicaStore::open_memory();
        for (id, policy) in [
            ("zero", json!({"transcriptRetentionDays":0})),
            ("frac", json!({"transcriptRetentionDays":2.7})),
            ("text", json!({"transcriptRetentionDays":"7"})),
            ("none", json!({"chatOnly":true})),
        ] {
            store
                .record_machine(
                    &json!({"machineId":id,"name":id,"os":"linux","policy":policy}),
                    1,
                )
                .unwrap();
        }
        let mut got = store.retention_machines().unwrap();
        got.sort();
        assert_eq!(got, vec![("frac".to_string(), 2), ("zero".to_string(), 1)]);
    }

    /// An inventory that repeats what the catalog holds rewrites nothing — it
    /// used to upsert every session and, when complete, tombstone them all
    /// first, on the hub's single command loop — yet a complete inventory still
    /// tombstones what it omits and brings a tombstoned session back.
    #[test]
    fn an_unchanged_inventory_rewrites_nothing_but_keeps_completeness() {
        let mut store = ReplicaStore::open_memory();
        let machine = json!({"machineId":"m1","name":"Laptop","os":"linux","agentVersion":"1"});
        store.record_machine(&machine, 10).unwrap();
        let a =
            json!({"sessionId":"a","source":"claude","title":"A","cwd":"/r","lastModified":1.0});
        let b = json!({"sessionId":"b","source":"codex","title":"B","cwd":"/r","lastModified":2.0});
        store
            .record_inventory("m1", &[a.clone(), b.clone()], true, 11)
            .unwrap();
        let ids = |store: &ReplicaStore| {
            let mut ids: Vec<String> = store
                .sessions_for_machine("m1")
                .unwrap()
                .iter()
                .map(|s| s["sessionId"].as_str().unwrap().to_string())
                .collect();
            ids.sort();
            ids
        };
        assert_eq!(ids(&store), ["a", "b"]);

        // The same inventory again: only the machine's `last_seen` is written.
        let before = store.conn.total_changes();
        store
            .record_inventory("m1", &[a.clone(), b.clone()], true, 12)
            .unwrap();
        assert_eq!(store.conn.total_changes() - before, 1, "liveness only");

        // Liveness fields are never persisted, so they do not make a row differ.
        let mut live = a.clone();
        live["livePid"] = json!(42);
        let before = store.conn.total_changes();
        store
            .record_inventory("m1", &[live, b.clone()], true, 13)
            .unwrap();
        assert_eq!(store.conn.total_changes() - before, 1);

        // A changed session is rewritten (one row), the rest are left alone.
        let mut retitled = a.clone();
        retitled["title"] = json!("A2");
        let before = store.conn.total_changes();
        store
            .record_inventory("m1", &[retitled.clone(), b.clone()], true, 14)
            .unwrap();
        assert_eq!(store.conn.total_changes() - before, 2);
        assert_eq!(
            store
                .sessions_for_machine("m1")
                .unwrap()
                .iter()
                .find(|s| s["sessionId"] == "a")
                .unwrap()["title"],
            "A2"
        );

        // A complete inventory without `b` tombstones it…
        store
            .record_inventory("m1", std::slice::from_ref(&retitled), true, 15)
            .unwrap();
        assert_eq!(ids(&store), ["a"]);
        // …a capped one never does…
        store.record_inventory("m1", &[], false, 16).unwrap();
        assert_eq!(ids(&store), ["a"]);
        // …and a complete one that lists it again brings it back.
        store
            .record_inventory("m1", &[retitled, b], true, 17)
            .unwrap();
        assert_eq!(ids(&store), ["a", "b"]);
    }

    fn derived(session_id: &str, title: &str, modified: i64) -> Value {
        json!({"sessionId":session_id,"title":title,"source":"claude",
               "lastModified":modified,"titleDerived":true})
    }

    fn with_messages(store: &ReplicaStore, session_id: &str, count: i64) {
        store
            .conn
            .execute(
                "UPDATE sessions SET revision=1, message_count=?2 WHERE session_id=?1",
                params![session_id, count],
            )
            .unwrap();
    }

    fn title_of(store: &ReplicaStore, session_id: &str) -> String {
        store
            .sessions_for_machine("m1")
            .unwrap()
            .into_iter()
            .find(|s| s["sessionId"] == session_id)
            .unwrap()["title"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn store_with_machine() -> ReplicaStore {
        let mut store = ReplicaStore::open_memory();
        store.record_machine(&json!({"machineId":"m1"}), 1).unwrap();
        store
    }

    #[test]
    fn a_generated_title_survives_the_agent_resending_its_guess() {
        let mut store = store_with_machine();
        let guess = derived("s1", "Вопрос о новости", 1000);
        store
            .record_inventory("m1", std::slice::from_ref(&guess), true, 2)
            .unwrap();
        assert!(store
            .record_generated_title("m1", "claude", "s1", Some("Новость об Images 2.6"), 4, 3)
            .unwrap());
        assert_eq!(title_of(&store, "s1"), "Новость об Images 2.6");
        let stored_before: String = store
            .conn
            .query_row("SELECT summary_json FROM sessions", [], |r| r.get(0))
            .unwrap();
        store.record_inventory("m1", &[guess], true, 4).unwrap();
        assert_eq!(title_of(&store, "s1"), "Новость об Images 2.6");
        let stored_after: String = store
            .conn
            .query_row("SELECT summary_json FROM sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            stored_before, stored_after,
            "no rewrite on a same inventory"
        );
    }

    #[test]
    fn a_rename_takes_the_session_back_from_generated_titles() {
        let mut store = store_with_machine();
        store
            .record_inventory("m1", &[derived("s1", "Вопрос", 1000)], true, 2)
            .unwrap();
        store
            .record_generated_title("m1", "claude", "s1", Some("Сгенерированное"), 4, 3)
            .unwrap();
        let renamed =
            json!({"sessionId":"s1","title":"Моё имя","source":"claude","lastModified":1000});
        store.record_inventory("m1", &[renamed], true, 4).unwrap();
        assert_eq!(title_of(&store, "s1"), "Моё имя");
        // A model that was still working when the rename landed loses the race.
        assert!(!store
            .record_generated_title("m1", "claude", "s1", Some("Опоздавшее"), 8, 5)
            .unwrap());
        assert_eq!(title_of(&store, "s1"), "Моё имя");
        with_messages(&store, "s1", 100);
        assert!(store
            .title_candidates("m1", 0, i64::MAX, 8)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn a_session_is_named_once_and_cron_runs_never() {
        let mut store = store_with_machine();
        let mut cron = derived("cron", "Крон", 1000);
        cron["entrypoint"] = json!("sdk-cli");
        store
            .record_inventory("m1", &[derived("s1", "Вопрос", 1000), cron], true, 2)
            .unwrap();
        with_messages(&store, "cron", 50);
        let due = |store: &ReplicaStore| store.title_candidates("m1", 0, i64::MAX, 8).unwrap();
        assert!(due(&store).is_empty(), "no replica yet");
        with_messages(&store, "s1", 4);
        assert_eq!(due(&store)[0].session_id, "s1");
        // No title yet: the next message may be the answer it was waiting for.
        store
            .record_generated_title("m1", "claude", "s1", None, 4, 3)
            .unwrap();
        assert!(due(&store).is_empty(), "nothing new to read");
        with_messages(&store, "s1", 5);
        assert_eq!(due(&store).len(), 1);
        store
            .record_generated_title("m1", "claude", "s1", Some("Имя"), 4, 3)
            .unwrap();
        // Named: it stays the address the person knows, however much it grows.
        with_messages(&store, "s1", 10_000);
        assert!(due(&store).is_empty());
        with_messages(&store, "s1", 5);
        store
            .conn
            .execute("DELETE FROM session_titles", [])
            .unwrap();
        // Outside the window nothing is due, however much it grew.
        assert!(store
            .title_candidates("m1", 2000, i64::MAX, 8)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn deleting_a_session_takes_its_title_with_it() {
        let mut store = store_with_machine();
        store
            .record_inventory("m1", &[derived("s1", "Вопрос", 1000)], true, 2)
            .unwrap();
        store
            .record_generated_title("m1", "claude", "s1", Some("Имя"), 4, 3)
            .unwrap();
        store
            .conn
            .execute("DELETE FROM sessions WHERE session_id='s1'", [])
            .unwrap();
        let left: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM session_titles", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }
}
