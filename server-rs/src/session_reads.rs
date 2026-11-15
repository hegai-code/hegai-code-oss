//! «Прочитано» между устройствами: одна отметка на человека и сессию. Хаб
//! ставит своё время (часы устройств расходятся), хранит максимум и рассылает
//! остальным сокетам человека — см. `hub/reads.rs` и `session_read` /
//! `session_reads` в shared/src/web-protocol.ts. Стирание аккаунта забирает
//! таблицу вместе с пользователем (`ON DELETE CASCADE`).
//!
//! Рядом — `session_completions`: когда прогон владельца закончил ход. Живой
//! прогон не переживает перезапуск агента (самообновление после выкатки хаба)
//! и снимается хабом после шести часов простоя, а телефон, проспавший ночь,
//! узнаёт о «готово» только по прогону. 31.10.2026 так за ночь погасли четыре
//! зелёные точки: агент перезапустился в 06:54 мск и унёс все прогоны.
//! Таблица переживает и это; клиент сравнивает её с отметками прочтения.

use rusqlite::{params, Connection, OptionalExtension};

use crate::workspace::{db_err, WorkspaceStore};

pub(crate) fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS session_reads (
          user_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
          machine_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          read_at    INTEGER NOT NULL,
          PRIMARY KEY (user_id, machine_id, session_id)
        );
        CREATE INDEX IF NOT EXISTS idx_session_reads_recent
          ON session_reads(user_id, read_at);
        CREATE TABLE IF NOT EXISTS session_completions (
          user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
          machine_id  TEXT NOT NULL,
          session_id  TEXT NOT NULL,
          finished_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, machine_id, session_id)
        );
        CREATE INDEX IF NOT EXISTS idx_session_completions_recent
          ON session_completions(user_id, finished_at);
        "#,
    )
    .map_err(db_err)
}

impl WorkspaceStore {
    /// Keep the later of the stored and the new stamp. Returns
    /// `(previous, stored)`: the stamp before this call (if any) and the one
    /// now in the table.
    pub(crate) fn session_read_upsert(
        &self,
        user_id: &str,
        machine_id: &str,
        session_id: &str,
        at: i64,
        max_rows: i64,
    ) -> Result<(Option<i64>, i64), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let previous: Option<i64> = conn
            .query_row(
                "SELECT read_at FROM session_reads WHERE user_id=?1 AND machine_id=?2 AND session_id=?3",
                params![user_id, machine_id, session_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        let stored = previous.map_or(at, |p| p.max(at));
        conn.execute(
            "INSERT INTO session_reads(user_id,machine_id,session_id,read_at) VALUES(?1,?2,?3,?4)
             ON CONFLICT(user_id,machine_id,session_id) DO UPDATE SET read_at=MAX(read_at,excluded.read_at)",
            params![user_id, machine_id, session_id, at],
        )
        .map_err(db_err)?;
        // A person's marks are bounded: the newest `MAX_ROWS_PER_USER` stay.
        conn.execute(
            "DELETE FROM session_reads WHERE user_id=?1 AND rowid NOT IN (
               SELECT rowid FROM session_reads WHERE user_id=?1
               ORDER BY read_at DESC, rowid DESC LIMIT ?2)",
            params![user_id, max_rows],
        )
        .map_err(db_err)?;
        Ok((previous, stored))
    }

    /// The person's marks stamped at or after `since_ms`, newest first.
    pub(crate) fn session_reads_recent(
        &self,
        user_id: &str,
        since_ms: i64,
        limit: i64,
    ) -> Result<Vec<(String, String, i64)>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT machine_id,session_id,read_at FROM session_reads
                 WHERE user_id=?1 AND read_at>=?2 ORDER BY read_at DESC LIMIT ?3",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![user_id, since_ms, limit], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .map_err(db_err)?;
        Ok(rows.filter_map(Result::ok).collect())
    }
}

/// One finished turn of a person's run, as `session_completions` sends it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionCompletion {
    pub machine_id: String,
    pub session_id: String,
    pub finished_at: i64,
}

impl WorkspaceStore {
    /// Record that the owner's run in this session finished a turn at `at`
    /// (hub time — the same stamp the run carries as `since`). The latest
    /// finish per session wins; the oldest rows beyond `max_rows` go. No text
    /// of the answer: this table outlives transcript purges, private mode and
    /// session deletion, and must not become a second copy of a conversation.
    pub(crate) fn session_completion_upsert(
        &self,
        user_id: &str,
        machine_id: &str,
        session_id: &str,
        at: i64,
        max_rows: i64,
    ) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.execute(
            "INSERT INTO session_completions(user_id,machine_id,session_id,finished_at)
             VALUES(?1,?2,?3,?4)
             ON CONFLICT(user_id,machine_id,session_id) DO UPDATE SET
               finished_at=MAX(finished_at,excluded.finished_at)",
            params![user_id, machine_id, session_id, at],
        )
        .map_err(db_err)?;
        conn.execute(
            "DELETE FROM session_completions WHERE user_id=?1 AND rowid NOT IN (
               SELECT rowid FROM session_completions WHERE user_id=?1
               ORDER BY finished_at DESC, rowid DESC LIMIT ?2)",
            params![user_id, max_rows],
        )
        .map_err(db_err)?;
        Ok(())
    }

    /// The latest stored finish of the person's turn in this session.
    pub(crate) fn session_completion_at(
        &self,
        user_id: &str,
        machine_id: &str,
        session_id: &str,
    ) -> Result<Option<i64>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.query_row(
            "SELECT finished_at FROM session_completions WHERE user_id=?1 AND machine_id=?2 AND session_id=?3",
            params![user_id, machine_id, session_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_err)
    }

    /// The person's finished turns at or after `since_ms`, newest first.
    pub(crate) fn session_completions_recent(
        &self,
        user_id: &str,
        since_ms: i64,
        limit: i64,
    ) -> Result<Vec<SessionCompletion>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT machine_id,session_id,finished_at FROM session_completions
                 WHERE user_id=?1 AND finished_at>=?2 ORDER BY finished_at DESC LIMIT ?3",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![user_id, since_ms, limit], |r| {
                Ok(SessionCompletion {
                    machine_id: r.get(0)?,
                    session_id: r.get(1)?,
                    finished_at: r.get(2)?,
                })
            })
            .map_err(db_err)?;
        Ok(rows.filter_map(Result::ok).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> WorkspaceStore {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("u1", "u1@example.com", Some("U1")).unwrap();
        s
    }

    #[test]
    fn upsert_keeps_the_later_stamp() {
        let s = store();
        assert_eq!(
            s.session_read_upsert("u1", "m", "s", 100, 10).unwrap(),
            (None, 100)
        );
        assert_eq!(
            s.session_read_upsert("u1", "m", "s", 50, 10).unwrap(),
            (Some(100), 100)
        );
        assert_eq!(
            s.session_read_upsert("u1", "m", "s", 200, 10).unwrap(),
            (Some(100), 200)
        );
        let rows = s.session_reads_recent("u1", 0, 10).unwrap();
        assert_eq!(rows, vec![("m".into(), "s".into(), 200)]);
    }

    #[test]
    fn recent_filters_by_time_and_limit() {
        let s = store();
        s.session_read_upsert("u1", "m", "old", 10, 10).unwrap();
        s.session_read_upsert("u1", "m", "a", 100, 10).unwrap();
        s.session_read_upsert("u1", "m", "b", 200, 10).unwrap();
        let rows = s.session_reads_recent("u1", 50, 10).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].1, "b");
        assert_eq!(s.session_reads_recent("u1", 50, 1).unwrap().len(), 1);
    }

    #[test]
    fn upsert_prunes_to_the_newest_rows() {
        let s = store();
        for i in 0..5 {
            s.session_read_upsert("u1", "m", &format!("s{i}"), 100 + i, 3)
                .unwrap();
        }
        let rows = s.session_reads_recent("u1", 0, 10).unwrap();
        let ids: Vec<&str> = rows.iter().map(|r| r.1.as_str()).collect();
        assert_eq!(ids, vec!["s4", "s3", "s2"]);
    }

    #[test]
    fn a_completion_keeps_the_latest_finish() {
        let s = store();
        s.session_completion_upsert("u1", "m", "s", 100, 10)
            .unwrap();
        s.session_completion_upsert("u1", "m", "s", 50, 10).unwrap();
        assert_eq!(s.session_completion_at("u1", "m", "s").unwrap(), Some(100));
        s.session_completion_upsert("u1", "m", "s", 200, 10)
            .unwrap();
        let rows = s.session_completions_recent("u1", 0, 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].finished_at, 200);
        assert!(s
            .session_completions_recent("u1", 201, 10)
            .unwrap()
            .is_empty());
        assert_eq!(s.session_completion_at("u1", "m", "other").unwrap(), None);
    }

    #[test]
    fn completions_prune_to_the_newest_rows() {
        let s = store();
        for i in 0..5 {
            s.session_completion_upsert("u1", "m", &format!("s{i}"), 100 + i, 3)
                .unwrap();
        }
        let ids: Vec<String> = s
            .session_completions_recent("u1", 0, 10)
            .unwrap()
            .into_iter()
            .map(|c| c.session_id)
            .collect();
        assert_eq!(ids, vec!["s4", "s3", "s2"]);
    }
}
