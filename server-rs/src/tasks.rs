//! The fleet task registry: what a person (through `hegai-fleet task …`) wants
//! done, and which sessions work for it. Storage and the pure parts; the hub half
//! is `hub/fleet_tasks.rs` (the calls) and `hub/tasks.rs` (the in-memory
//! lookups), the HTTP half is `fleet_api.rs`.
//!
//! Two tables, `tape_tasks` and `tape_task_links`. The `tape_` prefix is
//! history (the registry began inside the tape, «Лента»); the names are kept so
//! no migration has to rename live data. A task is `(user_id, id)`; a link ties
//! a session — or a run that will get its session — to a task, as its `child`
//! (the work) or its `origin` (the session the task was filed from). A session
//! works for ONE task: the unique index on `(user, machine, session)` for
//! children refuses a second.
//!
//! `status_by` / `status_at` say who set the status last (`narrator`, `teo`;
//! rows of the removed task watcher hold `watcher`; a task filed through the
//! fleet API says `teo`), so a status set by one writer is not overwritten by a
//! slower one.
//!
//! Account erasure takes both tables with the user (`ON DELETE CASCADE`).

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::workspace::{db_err, now_ms, WorkspaceStore};

/// Longest title a task may have.
pub(crate) const TITLE_MAX_CHARS: usize = 80;

pub(crate) const TASK_STATUSES: &[&str] = &["open", "in_progress", "waiting", "done", "dropped"];

/// Who set a task's status last (`narrator` is what rows of the removed tape
/// hold, and the column's default).
pub(crate) const STATUS_BY_NARRATOR: &str = "narrator";
pub(crate) const STATUS_BY_TEO: &str = "teo";
/// A child link waits seconds for its session. The agent holds a run at most
/// 30 min without the hub (single-writer lease), so a link still pending a day
/// later at start belongs to a run that is long gone.
const PENDING_LINK_TTL_MS: i64 = 24 * 60 * 60 * 1000;

/// The wire status a model or a person meant by `raw`, or `None` when it means
/// none of the five. The wire list is a closed enum on every client, so the
/// tolerance lives here and never grows the list.
pub(crate) fn normalize_status(raw: &str) -> Option<&'static str> {
    let key: String = raw
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c == '-' || c == ' ' { '_' } else { c })
        .collect();
    if let Some(wire) = TASK_STATUSES.iter().find(|s| **s == key) {
        return Some(wire);
    }
    Some(match key.as_str() {
        "new" | "todo" | "to_do" | "backlog" | "planned" => "open",
        "inprogress" | "progress" | "working" | "active" | "started" | "running" | "doing" => {
            "in_progress"
        }
        "waiting_owner" | "waiting_for_owner" | "waiting_for_user" | "blocked" | "on_hold"
        | "paused" | "pending" => "waiting",
        "complete" | "completed" | "finished" | "closed" | "resolved" => "done",
        "cancelled" | "canceled" | "abandoned" | "rejected" | "wontfix" => "dropped",
        _ => return None,
    })
}

pub(crate) fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS tape_tasks (
          user_id        TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
          id             TEXT NOT NULL,
          title          TEXT NOT NULL,
          status         TEXT NOT NULL,
          anchor_turn_id TEXT NOT NULL,
          last_turn_id   TEXT NOT NULL,
          created_at     INTEGER NOT NULL,
          updated_at     INTEGER NOT NULL,
          intent         TEXT,
          lane           TEXT,
          status_by      TEXT NOT NULL DEFAULT 'narrator',
          status_at      INTEGER,
          PRIMARY KEY (user_id, id)
        );
        CREATE INDEX IF NOT EXISTS tape_tasks_updated ON tape_tasks(user_id, updated_at);
        CREATE TABLE IF NOT EXISTS tape_task_links (
          user_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
          link_id    TEXT PRIMARY KEY,
          task_id    TEXT NOT NULL,
          role       TEXT NOT NULL CHECK (role IN ('origin','child')),
          machine_id TEXT NOT NULL,
          session_id TEXT NOT NULL DEFAULT '',
          run_id     TEXT,
          cwd        TEXT,
          linked_at  INTEGER NOT NULL,
          linked_by  TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS tape_task_links_task ON tape_task_links(user_id, task_id);
        CREATE INDEX IF NOT EXISTS tape_task_links_run ON tape_task_links(run_id)
          WHERE session_id = '';
        -- A session works for ONE task. Only children: Teo's own session is the
        -- origin of every task it files.
        CREATE UNIQUE INDEX IF NOT EXISTS tape_task_links_session
          ON tape_task_links(user_id, machine_id, session_id)
          WHERE session_id <> '' AND role = 'child';
        "#,
    )
    .map_err(|e| e.to_string())?;
    // A database from before the registry had these columns: they are added in
    // place. «duplicate column name» is the expected answer on every start but
    // the first; anything else is a real failure.
    for alter in [
        "ALTER TABLE tape_tasks ADD COLUMN intent TEXT",
        "ALTER TABLE tape_tasks ADD COLUMN lane TEXT",
        "ALTER TABLE tape_tasks ADD COLUMN status_by TEXT NOT NULL DEFAULT 'narrator'",
        "ALTER TABLE tape_tasks ADD COLUMN status_at INTEGER",
    ] {
        if let Err(e) = conn.execute(alter, []) {
            let text = e.to_string();
            if !text.contains("duplicate column") {
                return Err(format!("{alter}: {text}"));
            }
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct StoredTask {
    pub id: String,
    pub title: String,
    pub status: String,
    /// Empty for a task filed through the fleet API; kept for rows the removed
    /// tape's narrator anchored.
    pub anchor_turn_id: String,
    pub last_turn_id: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub intent: Option<String>,
    pub lane: Option<String>,
    /// `teo` for the fleet API; `narrator` / `watcher` on rows the removed tape wrote.
    pub status_by: String,
    pub status_at: Option<i64>,
}

/// One session (or a run that will get its session) tied to a task.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct TaskLink {
    pub link_id: String,
    pub task_id: String,
    /// `origin` (the Teo session the task was filed from) | `child` (work).
    pub role: String,
    pub machine_id: String,
    /// Empty between the spawn and the agent's `session_started`.
    pub session_id: String,
    pub run_id: Option<String>,
    pub cwd: Option<String>,
    pub linked_at: i64,
    pub linked_by: String,
}

impl TaskLink {
    pub(crate) fn json(&self) -> Value {
        let mut out = json!({
            "linkId": self.link_id,
            "taskId": self.task_id,
            "role": self.role,
            "machineId": self.machine_id,
            "linkedAt": self.linked_at,
            "linkedBy": self.linked_by,
        });
        if !self.session_id.is_empty() {
            out["sessionId"] = json!(self.session_id);
        }
        if let Some(run) = &self.run_id {
            out["runId"] = json!(run);
        }
        if let Some(cwd) = &self.cwd {
            out["cwd"] = json!(cwd);
        }
        out
    }
}

impl StoredTask {
    pub(crate) fn json(&self) -> Value {
        json!({
            "id": self.id,
            "title": self.title,
            "status": self.status,
            "anchorTurnId": self.anchor_turn_id,
            "lastTurnId": self.last_turn_id,
            "updatedAt": self.updated_at,
        })
    }

    /// The fleet API's shape (`GET /api/fleet/tasks`): the tape's plus who set
    /// the status, the intent, the lane and the children. Optional keys are
    /// absent, never null.
    pub(crate) fn api_json(&self, children: &[TaskLink]) -> Value {
        let mut out = self.json();
        out["statusBy"] = json!(self.status_by);
        if let Some(intent) = &self.intent {
            out["intent"] = json!(intent);
        }
        if let Some(lane) = &self.lane {
            out["lane"] = json!(lane);
        }
        out["children"] = Value::Array(
            children
                .iter()
                .filter(|l| l.role == "child")
                .map(|l| {
                    let mut c = json!({"machineId": l.machine_id, "role": l.role});
                    c["sessionId"] = json!(l.session_id);
                    if let Some(run) = &l.run_id {
                        c["runId"] = json!(run);
                    }
                    c
                })
                .collect(),
        );
        out
    }
}

fn task_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<StoredTask> {
    Ok(StoredTask {
        id: r.get(0)?,
        title: r.get(1)?,
        status: r.get(2)?,
        anchor_turn_id: r.get(3)?,
        last_turn_id: r.get(4)?,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
        intent: r.get(7)?,
        lane: r.get(8)?,
        status_by: r.get(9)?,
        status_at: r.get(10)?,
    })
}

const TASK_COLS: &str =
    "id,title,status,anchor_turn_id,last_turn_id,created_at,updated_at,intent,lane,status_by,status_at";

fn link_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<TaskLink> {
    Ok(TaskLink {
        link_id: r.get(0)?,
        task_id: r.get(1)?,
        role: r.get(2)?,
        machine_id: r.get(3)?,
        session_id: r.get(4)?,
        run_id: r.get(5)?,
        cwd: r.get(6)?,
        linked_at: r.get(7)?,
        linked_by: r.get(8)?,
    })
}

const LINK_COLS: &str = "link_id,task_id,role,machine_id,session_id,run_id,cwd,linked_at,linked_by";

impl WorkspaceStore {
    fn task_conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())
    }

    /// Newest-updated first.
    pub(crate) fn task_list(&self, user_id: &str, limit: usize) -> Result<Vec<StoredTask>, String> {
        let conn = self.task_conn()?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {TASK_COLS} FROM tape_tasks WHERE user_id=?1 \
                 ORDER BY updated_at DESC, id LIMIT ?2"
            ))
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![user_id, limit as i64], task_row)
            .map_err(db_err)?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    /// Tasks still alive (not done / dropped).
    pub(crate) fn task_list_open(
        &self,
        user_id: &str,
        limit: usize,
    ) -> Result<Vec<StoredTask>, String> {
        let conn = self.task_conn()?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {TASK_COLS} FROM tape_tasks WHERE user_id=?1 \
                 AND status NOT IN ('done','dropped') ORDER BY updated_at DESC, id LIMIT ?2"
            ))
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![user_id, limit as i64], task_row)
            .map_err(db_err)?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub(crate) fn task_get(&self, user_id: &str, id: &str) -> Result<Option<StoredTask>, String> {
        let conn = self.task_conn()?;
        conn.query_row(
            &format!("SELECT {TASK_COLS} FROM tape_tasks WHERE user_id=?1 AND id=?2"),
            params![user_id, id],
            task_row,
        )
        .optional()
        .map_err(db_err)
    }

    /// Insert a task, or move an existing one. The ANCHOR is filled only while
    /// it is empty (a task filed through the API starts without one, and an
    /// anchor, once set, never moves again).
    pub(crate) fn task_upsert(&self, user_id: &str, t: &StoredTask) -> Result<(), String> {
        let conn = self.task_conn()?;
        conn.execute(
            "INSERT INTO tape_tasks \
             (user_id,id,title,status,anchor_turn_id,last_turn_id,created_at,updated_at,\
              intent,lane,status_by,status_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) \
             ON CONFLICT(user_id,id) DO UPDATE SET \
               title=excluded.title, status=excluded.status, \
               anchor_turn_id=CASE WHEN tape_tasks.anchor_turn_id='' \
                 THEN excluded.anchor_turn_id ELSE tape_tasks.anchor_turn_id END, \
               last_turn_id=excluded.last_turn_id, updated_at=excluded.updated_at, \
               intent=excluded.intent, lane=excluded.lane, \
               status_by=excluded.status_by, status_at=excluded.status_at",
            params![
                user_id,
                t.id,
                t.title,
                t.status,
                t.anchor_turn_id,
                t.last_turn_id,
                t.created_at,
                t.updated_at,
                t.intent,
                t.lane,
                if t.status_by.is_empty() {
                    STATUS_BY_NARRATOR
                } else {
                    &t.status_by
                },
                t.status_at
            ],
        )
        .map_err(db_err)?;
        Ok(())
    }

    // ── task links ─────────────────────────────────────────────────────────

    pub(crate) fn task_link_insert(&self, user_id: &str, l: &TaskLink) -> Result<(), String> {
        let conn = self.task_conn()?;
        conn.execute(
            "INSERT INTO tape_task_links \
             (user_id,link_id,task_id,role,machine_id,session_id,run_id,cwd,linked_at,linked_by) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                user_id,
                l.link_id,
                l.task_id,
                l.role,
                l.machine_id,
                l.session_id,
                l.run_id,
                l.cwd,
                l.linked_at,
                l.linked_by
            ],
        )
        .map_err(db_err)?;
        Ok(())
    }

    /// Every link of one task, oldest first.
    pub(crate) fn task_links_of(
        &self,
        user_id: &str,
        task_id: &str,
    ) -> Result<Vec<TaskLink>, String> {
        let conn = self.task_conn()?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {LINK_COLS} FROM tape_task_links WHERE user_id=?1 AND task_id=?2 \
                 ORDER BY linked_at, link_id"
            ))
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![user_id, task_id], link_row)
            .map_err(db_err)?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    /// The user's child links grouped by task — what a task list shows next to
    /// each task.
    pub(crate) fn task_children(
        &self,
        user_id: &str,
    ) -> Result<HashMap<String, Vec<TaskLink>>, String> {
        let conn = self.task_conn()?;
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {LINK_COLS} FROM tape_task_links WHERE user_id=?1 AND role='child' \
                 ORDER BY linked_at, link_id"
            ))
            .map_err(db_err)?;
        let rows = stmt.query_map(params![user_id], link_row).map_err(db_err)?;
        let mut out: HashMap<String, Vec<TaskLink>> = HashMap::new();
        for link in rows.filter_map(Result::ok) {
            out.entry(link.task_id.clone()).or_default().push(link);
        }
        Ok(out)
    }

    /// The child link a session already has, if any.
    pub(crate) fn task_link_by_session(
        &self,
        user_id: &str,
        machine_id: &str,
        session_id: &str,
    ) -> Result<Option<TaskLink>, String> {
        let conn = self.task_conn()?;
        conn.query_row(
            &format!(
                "SELECT {LINK_COLS} FROM tape_task_links WHERE user_id=?1 AND machine_id=?2 \
                 AND session_id=?3 AND role='child'"
            ),
            params![user_id, machine_id, session_id],
            link_row,
        )
        .optional()
        .map_err(db_err)
    }

    /// The child link a run holds while its session is still unknown.
    pub(crate) fn task_link_by_run(
        &self,
        user_id: &str,
        run_id: &str,
    ) -> Result<Option<TaskLink>, String> {
        let conn = self.task_conn()?;
        conn.query_row(
            &format!(
                "SELECT {LINK_COLS} FROM tape_task_links WHERE user_id=?1 AND run_id=?2 \
                 AND role='child' ORDER BY linked_at LIMIT 1"
            ),
            params![user_id, run_id],
            link_row,
        )
        .optional()
        .map_err(db_err)
    }

    /// The agent reported the session of `run_id`: fill it into every link
    /// that was waiting for it (children AND origin). `Err` when the session
    /// already is another task's child (the unique index) — the links then
    /// stay pending.
    pub(crate) fn task_links_set_session(
        &self,
        run_id: &str,
        session_id: &str,
    ) -> Result<(), String> {
        let conn = self.task_conn()?;
        conn.execute(
            "UPDATE tape_task_links SET session_id=?2 WHERE run_id=?1 AND session_id=''",
            params![run_id, session_id],
        )
        .map_err(db_err)?;
        Ok(())
    }

    /// Drop the child links of a run that ended before its session was known:
    /// the run never produced a session, so the task has no such child.
    pub(crate) fn task_links_drop_pending(&self, run_id: &str) -> Result<usize, String> {
        let conn = self.task_conn()?;
        conn.execute(
            "DELETE FROM tape_task_links WHERE run_id=?1 AND session_id='' AND role='child'",
            params![run_id],
        )
        .map_err(db_err)
    }

    /// `(run, user, task)` of every child link still waiting for its session —
    /// loaded once at start. A session is
    /// reported seconds after spawn; a link pending longer than
    /// `PENDING_LINK_TTL_MS` belongs to a run that died while the hub was down
    /// and is dropped here instead of haunting the task forever.
    pub(crate) fn task_link_pending(&self) -> Result<Vec<(String, String, String)>, String> {
        let conn = self.task_conn()?;
        conn.execute(
            "DELETE FROM tape_task_links WHERE session_id='' AND role='child' AND linked_at<?1",
            params![now_ms() - PENDING_LINK_TTL_MS],
        )
        .map_err(db_err)?;
        let mut stmt = conn
            .prepare(
                "SELECT run_id,user_id,task_id FROM tape_task_links \
                 WHERE session_id='' AND run_id IS NOT NULL AND role='child'",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(db_err)?;
        Ok(rows.filter_map(Result::ok).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> WorkspaceStore {
        let store = WorkspaceStore::open_memory();
        store.ensure_user("owner", "p@example.com", None).unwrap();
        store
    }

    #[test]
    fn a_task_round_trips_and_its_anchor_never_moves() {
        let store = store();
        let task = StoredTask {
            id: "t1".into(),
            title: "Договор".into(),
            status: "open".into(),
            anchor_turn_id: "sess-1:u1".into(),
            last_turn_id: "sess-1:u1".into(),
            created_at: 10,
            updated_at: 10,
            ..StoredTask::default()
        };
        store.task_upsert("owner", &task).unwrap();
        let done = StoredTask {
            status: "done".into(),
            last_turn_id: "sess-1:u2".into(),
            updated_at: 20,
            // The anchor never moves once a task exists.
            anchor_turn_id: "elsewhere".into(),
            ..task.clone()
        };
        store.task_upsert("owner", &done).unwrap();
        let got = store.task_get("owner", "t1").unwrap().unwrap();
        assert_eq!(got.anchor_turn_id, "sess-1:u1");
        assert_eq!(got.status, "done");
        assert!(store.task_list_open("owner", 30).unwrap().is_empty());
        assert_eq!(store.task_list("owner", 100).unwrap().len(), 1);
        assert_eq!(got.json()["anchorTurnId"], "sess-1:u1");
        // The fleet API's shape adds who set the status, and says nothing of
        // an absent intent or lane.
        let api = got.api_json(&[]);
        assert_eq!(api["statusBy"], "narrator");
        assert!(api.get("intent").is_none() && api.get("lane").is_none());
        assert_eq!(api["children"], json!([]));
    }

    #[test]
    fn status_words_map_onto_the_five_wire_statuses_and_nothing_else() {
        for (raw, want) in [
            ("open", "open"),
            ("in_progress", "in_progress"),
            ("in-progress", "in_progress"),
            (" In Progress ", "in_progress"),
            ("waiting", "waiting"),
            ("waiting-owner", "waiting"),
            ("blocked", "waiting"),
            ("done", "done"),
            ("completed", "done"),
            ("dropped", "dropped"),
            ("cancelled", "dropped"),
        ] {
            assert_eq!(normalize_status(raw), Some(want), "{raw}");
        }
        for junk in ["", "  ", "в процессе", "urgent", "in progress now"] {
            assert_eq!(normalize_status(junk), None, "{junk}");
        }
        // The wire list is closed: whatever comes out is on it.
        for raw in ["new", "doing", "pending", "closed", "wontfix"] {
            assert!(TASK_STATUSES.contains(&normalize_status(raw).unwrap()));
        }
    }

    #[test]
    fn an_old_database_gains_the_registry_columns_and_a_second_start_changes_nothing() {
        let conn = Connection::open_in_memory().unwrap();
        // The schema as it was before the registry.
        conn.execute_batch(
            r#"
            CREATE TABLE tape_tasks (
              user_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL,
              status TEXT NOT NULL, anchor_turn_id TEXT NOT NULL, last_turn_id TEXT NOT NULL,
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
              PRIMARY KEY (user_id, id)
            );
            CREATE TABLE users (user_id TEXT PRIMARY KEY);
            INSERT INTO users VALUES ('p');
            INSERT INTO tape_tasks VALUES ('p','t1','Старая','waiting','s:u1','s:u1',1,2);
            "#,
        )
        .unwrap();
        init_schema(&conn).unwrap();
        init_schema(&conn).unwrap();
        let (by, at, intent): (String, Option<i64>, Option<String>) = conn
            .query_row(
                "SELECT status_by,status_at,intent FROM tape_tasks WHERE id='t1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((by.as_str(), at, intent), ("narrator", None, None));
        conn.execute(
            "INSERT INTO tape_task_links (link_id,task_id,user_id,role,machine_id,linked_at) \
             VALUES ('l1','t1','p','child','m',1)",
            [],
        )
        .unwrap();
        // The role is checked by the table itself.
        assert!(conn
            .execute(
                "INSERT INTO tape_task_links (link_id,task_id,user_id,role,machine_id,linked_at) \
                 VALUES ('l2','t1','p','boss','m',1)",
                [],
            )
            .is_err());
    }

    #[test]
    fn the_anchor_is_filled_once_and_only_while_it_is_empty() {
        let store = store();
        let api_made = StoredTask {
            id: "t1".into(),
            title: "Из API".into(),
            status: "open".into(),
            created_at: 10,
            updated_at: 10,
            status_by: STATUS_BY_TEO.into(),
            status_at: Some(10),
            ..StoredTask::default()
        };
        store.task_upsert("owner", &api_made).unwrap();
        let got = store.task_get("owner", "t1").unwrap().unwrap();
        assert_eq!(
            (got.anchor_turn_id.as_str(), got.status_by.as_str()),
            ("", "teo")
        );
        // The first filed turn sets it...
        let filed = StoredTask {
            anchor_turn_id: "s:u1".into(),
            last_turn_id: "s:u1".into(),
            updated_at: 20,
            ..got
        };
        store.task_upsert("owner", &filed).unwrap();
        // ...and a later one cannot move it.
        let later = StoredTask {
            anchor_turn_id: "s:u9".into(),
            last_turn_id: "s:u9".into(),
            ..filed
        };
        store.task_upsert("owner", &later).unwrap();
        let got = store.task_get("owner", "t1").unwrap().unwrap();
        assert_eq!(
            (got.anchor_turn_id.as_str(), got.last_turn_id.as_str()),
            ("s:u1", "s:u9")
        );
    }

    #[test]
    fn a_child_link_pending_for_an_hour_is_dropped_at_load() {
        let store = store();
        let mut stale = link("c1", "t1", "child", "", Some("run-old"));
        stale.linked_at = now_ms() - PENDING_LINK_TTL_MS - 1;
        store.task_link_insert("owner", &stale).unwrap();
        store
            .task_link_insert("owner", &link("c2", "t1", "child", "", Some("run-new")))
            .unwrap();
        let pending = store.task_link_pending().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].0, "run-new");
        assert_eq!(store.task_links_of("owner", "t1").unwrap().len(), 1);
    }

    fn link(id: &str, task: &str, role: &str, session: &str, run: Option<&str>) -> TaskLink {
        TaskLink {
            link_id: id.into(),
            task_id: task.into(),
            role: role.into(),
            machine_id: "stage".into(),
            session_id: session.into(),
            run_id: run.map(str::to_string),
            linked_at: now_ms(),
            linked_by: "teo".into(),
            ..TaskLink::default()
        }
    }

    #[test]
    fn a_session_works_for_one_task_but_teos_own_session_originates_many() {
        let store = store();
        // Teo's session is the origin of every task it files.
        store
            .task_link_insert("owner", &link("o1", "t1", "origin", "teo-1", None))
            .unwrap();
        store
            .task_link_insert("owner", &link("o2", "t2", "origin", "teo-1", None))
            .unwrap();
        // A child session belongs to one task.
        store
            .task_link_insert("owner", &link("c1", "t1", "child", "work-1", None))
            .unwrap();
        assert!(store
            .task_link_insert("owner", &link("c2", "t2", "child", "work-1", None))
            .is_err());
        // Spawned and not yet started: any number may wait.
        store
            .task_link_insert("owner", &link("c3", "t1", "child", "", Some("run-1")))
            .unwrap();
        store
            .task_link_insert("owner", &link("c4", "t2", "child", "", Some("run-2")))
            .unwrap();
        assert_eq!(store.task_link_pending().unwrap().len(), 2);
        store.task_links_set_session("run-1", "work-2").unwrap();
        let by = store
            .task_link_by_session("owner", "stage", "work-2")
            .unwrap()
            .unwrap();
        assert_eq!(by.task_id, "t1");
        let kids = store.task_children("owner").unwrap();
        assert_eq!(kids["t1"].len(), 2);
        assert_eq!(kids["t1"][0].session_id, "work-1");
        assert_eq!(store.task_links_of("owner", "t1").unwrap().len(), 3);
        // The links go with the user.
        assert_eq!(
            store
                .task_link_by_run("owner", "run-2")
                .unwrap()
                .unwrap()
                .task_id,
            "t2"
        );
    }
}
