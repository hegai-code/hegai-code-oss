//! The task board («Доска», `/w/board`): storage, visibility and the two
//! queries behind `GET /api/board` and `POST /api/board/cards/{id}`.
//!
//! A CARD is a task as a non-technical reader sees it, assembled from session
//! transcripts by `deploy/board-assemble.py` on the hub box once an hour. The
//! script only ever INSERTs/UPDATEs rows; the hub owns the schema (created
//! here, idempotently, at start — a throwaway smoke hub answers `/api/board`
//! with an empty board and no cron), reads it for the web, and takes hand
//! edits. Anything a person changes by hand sets `manual_override` and the
//! assembler leaves status / attention / title of that card alone.
//!
//! Columns are the kanban stages of `shared/src/stages.ts`; `STAGE_IDS` here
//! is the one Rust copy, used by `set_stage` in the hub loop too.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::roadmap::RoadmapConfig;
use crate::workspace::{db_err, insert_audit, now_ms, path_is_within, WorkspaceStore};

/// Board columns, left to right. Mirrors `SessionStage` in `shared/src/stages.ts`.
pub(crate) const STAGE_IDS: &[&str] = &["backlog", "planning", "in_progress", "testing", "done"];
pub(crate) const ATTENTION_IDS: &[&str] = &["none", "question", "blocked"];
/// An open card nobody touched for this long reads as «застряло».
const STALE_AFTER_MS: i64 = 72 * 3_600_000;
const EVENTS_PER_CARD: usize = 5;

pub(crate) fn init_board_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        -- One TASK as a non-technical reader sees it.
        CREATE TABLE IF NOT EXISTS board_cards (
          card_id         TEXT PRIMARY KEY,
          title           TEXT NOT NULL,
          summary         TEXT NOT NULL DEFAULT '',
          status          TEXT NOT NULL CHECK(status IN ('backlog','planning','in_progress','testing','done')),
          attention       TEXT NOT NULL DEFAULT 'none' CHECK(attention IN ('none','question','blocked')),
          attention_note  TEXT NOT NULL DEFAULT '',
          project         TEXT NOT NULL DEFAULT '',
          owner_user_id   TEXT,
          owner_label     TEXT NOT NULL DEFAULT '',
          machines_json   TEXT NOT NULL DEFAULT '[]',
          first_seen      INTEGER NOT NULL,
          last_activity   INTEGER NOT NULL,
          done_at         INTEGER,
          done_when       TEXT NOT NULL DEFAULT '',
          evidence_json   TEXT NOT NULL DEFAULT '{}',
          confidence      REAL NOT NULL DEFAULT 0,
          manual_override INTEGER NOT NULL DEFAULT 0,
          privacy_scoped  INTEGER NOT NULL DEFAULT 0,
          archived        INTEGER NOT NULL DEFAULT 0,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS board_cards_activity ON board_cards(archived, last_activity DESC);
        CREATE INDEX IF NOT EXISTS board_cards_project  ON board_cards(project, status);
        CREATE INDEX IF NOT EXISTS board_cards_owner    ON board_cards(owner_user_id, status);

        -- card <-> session. A mixed session feeds several cards; a task that
        -- ran over a week spans several sessions. `title`/`last_modified` are
        -- the assembler's fresh copy of the session summary, so the hub never
        -- has to join the replica tables (which a test DB does not have).
        CREATE TABLE IF NOT EXISTS board_card_sessions (
          card_id       TEXT NOT NULL REFERENCES board_cards(card_id) ON DELETE CASCADE,
          machine_id    TEXT NOT NULL,
          source        TEXT NOT NULL,
          session_id    TEXT NOT NULL,
          cwd           TEXT NOT NULL DEFAULT '',
          owner_user_id TEXT,
          title         TEXT NOT NULL DEFAULT '',
          last_modified INTEGER NOT NULL DEFAULT 0,
          role          TEXT NOT NULL DEFAULT 'origin' CHECK(role IN ('origin','continuation')),
          linked_at     INTEGER NOT NULL,
          linked_by     TEXT NOT NULL DEFAULT 'assembler',
          PRIMARY KEY (card_id, machine_id, source, session_id)
        );
        CREATE INDEX IF NOT EXISTS board_card_sessions_by_session ON board_card_sessions(machine_id, session_id);

        -- Append-only history: every change and every assembler decision.
        CREATE TABLE IF NOT EXISTS board_events (
          event_id   TEXT PRIMARY KEY,
          card_id    TEXT NOT NULL REFERENCES board_cards(card_id) ON DELETE CASCADE,
          at         INTEGER NOT NULL,
          actor      TEXT NOT NULL,
          kind       TEXT NOT NULL CHECK(kind IN ('created','status','attention','title','summary','link','reopen','manual','archive')),
          from_value TEXT,
          to_value   TEXT,
          reason     TEXT NOT NULL DEFAULT '',
          run_id     TEXT
        );
        CREATE INDEX IF NOT EXISTS board_events_card ON board_events(card_id, at DESC);

        -- The assembler's memo per session: last digest seen, or why skipped.
        CREATE TABLE IF NOT EXISTS board_session_state (
          machine_id       TEXT NOT NULL,
          source           TEXT NOT NULL,
          session_id       TEXT NOT NULL,
          digest_sha256    TEXT NOT NULL DEFAULT '',
          catalog_modified INTEGER NOT NULL DEFAULT 0,
          human_turns      INTEGER NOT NULL DEFAULT 0,
          excluded_reason  TEXT,
          processed_at     INTEGER NOT NULL,
          PRIMARY KEY (machine_id, source, session_id)
        );

        -- One row per assembler run: watermark + cost telemetry.
        CREATE TABLE IF NOT EXISTS board_runs (
          run_id            TEXT PRIMARY KEY,
          mode              TEXT NOT NULL,
          started_at        INTEGER NOT NULL,
          finished_at       INTEGER,
          since_ms          INTEGER NOT NULL,
          sessions_seen     INTEGER NOT NULL DEFAULT 0,
          sessions_digested INTEGER NOT NULL DEFAULT 0,
          llm_calls         INTEGER NOT NULL DEFAULT 0,
          prompt_tokens     INTEGER NOT NULL DEFAULT 0,
          completion_tokens INTEGER NOT NULL DEFAULT 0,
          cards_created     INTEGER NOT NULL DEFAULT 0,
          cards_updated     INTEGER NOT NULL DEFAULT 0,
          error             TEXT
        );
        CREATE TABLE IF NOT EXISTS board_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        "#,
    )
    .map_err(db_err)?;
    // Old summaries may already contain unrelated offered context even when
    // their final links look homogeneous. Keep them quarantined until rebuilt.
    let _ = conn.execute(
        "ALTER TABLE board_cards ADD COLUMN privacy_scoped INTEGER NOT NULL DEFAULT 0",
        [],
    );
    // Idempotent migration for a DB from before the per-link owner: the
    // visibility rule needs to know whose session each link is, exactly like
    // `session_visible` does. "duplicate column" is the expected failure.
    let _ = conn.execute(
        "ALTER TABLE board_card_sessions ADD COLUMN owner_user_id TEXT",
        [],
    );
    Ok(())
}

/// Roadmap group for a project alias, or None for «Без проекта».
pub(crate) fn area_for(project: &str, roadmap: &RoadmapConfig) -> Option<String> {
    let needle = project.trim().to_lowercase();
    if needle.is_empty() {
        return None;
    }
    roadmap
        .groups
        .iter()
        .find(|g| g.projects.contains(&needle))
        .map(|g| g.id.clone())
}

fn areas_json(roadmap: &RoadmapConfig) -> Vec<Value> {
    let mut out: Vec<Value> = roadmap
        .groups
        .iter()
        .map(|g| json!({"id": g.id, "name": g.name, "blurb": g.blurb, "projects": g.projects}))
        .collect();
    out.push(json!({
        "id": "unassigned",
        "name": roadmap.unassigned.name,
        "blurb": roadmap.unassigned.blurb,
        "projects": [],
    }));
    out
}

/// A project shared into a workspace the viewer belongs to, with what
/// `session_visible` needs to apply the same rule the session list applies.
#[derive(Clone, Debug)]
pub(crate) struct SharedRoot {
    pub machine_id: String,
    pub root: String,
    /// `visibility='everyone'`: the device owner's own sessions are open too.
    pub everyone: bool,
    pub device_owner: Option<String>,
}

/// What one viewer may see. Mirrors `machine_access` + `session_visible`: a
/// platform admin sees the fleet; everyone else sees cards they own, cards on
/// machines they own, and — through a `control` share of a project into a
/// workspace they belong to — cards whose sessions ran inside that project
/// and belong to someone other than the device owner (or to anyone, when the
/// share is `everyone`). Unowned sessions outside an `everyone` root are
/// hidden, as they are in the list. Deliberately no wider than the list for
/// any role: a manager's per-assignment scope is not modelled here yet, so a
/// manager gets the member rule, never more.
#[derive(Clone, Debug)]
pub(crate) struct BoardScope {
    pub all: bool,
    pub user_id: String,
    pub owned_machines: HashSet<String>,
    pub shared_roots: Vec<SharedRoot>,
    /// Restricted shares (machine, root) the viewer is shut out of / is listed
    /// on — the same pair `MachineAccess` carries. Nothing inside a denied
    /// root is shown, not even the viewer's own sessions.
    pub denied_roots: Vec<(String, String)>,
    pub reopen_roots: Vec<(String, String)>,
}

impl BoardScope {
    /// `None` = administrator; `Some(empty)` = at least one source is hidden.
    /// Aggregated text is visible only when every source is accessible.
    fn visible_sessions<'a>(
        &self,
        _owner: Option<&str>,
        _machines: &[String],
        sessions: &'a [SessionRow],
    ) -> Option<Vec<&'a SessionRow>> {
        if self.all {
            // An administrator sees the fleet, but not into a restricted share
            // they are not admitted to — unless the machine is theirs. One
            // closed source hides the whole card, as for everybody.
            let closed = sessions.iter().any(|s| {
                !self.owned_machines.contains(&s.machine_id) && self.denied(&s.machine_id, &s.cwd)
            });
            return if closed { Some(vec![]) } else { None };
        }
        let mine: Vec<_> = sessions
            .iter()
            .filter(|s| {
                self.owned_machines.contains(&s.machine_id)
                    || (!self.denied(&s.machine_id, &s.cwd)
                        && s.owner_user_id.as_deref() == Some(self.user_id.as_str()))
                    || (!s.cwd.is_empty()
                        && !self.denied(&s.machine_id, &s.cwd)
                        && self.shared_roots.iter().any(|share| {
                            share.machine_id == s.machine_id
                                && path_is_within(&s.cwd, &share.root)
                                && (share.everyone
                                    || matches!(
                                        (&s.owner_user_id, &share.device_owner),
                                        (Some(o), Some(d)) if o != d
                                    ))
                        }))
            })
            .collect();
        // Summary/title/events combine every source. Partial access must
        // hide the entire card, not expose an aggregate with fewer links.
        Some(if mine.len() == sessions.len() {
            mine
        } else {
            vec![]
        })
    }

    /// Is the session's folder inside a restricted share the viewer is shut out
    /// of (and not reopened by a nested one they are on)?
    fn denied(&self, machine_id: &str, cwd: &str) -> bool {
        let on_machine = |roots: &[(String, String)]| -> Vec<String> {
            roots
                .iter()
                .filter(|(m, _)| m == machine_id)
                .map(|(_, r)| r.clone())
                .collect()
        };
        let denied = on_machine(&self.denied_roots);
        // Inside a closed root, or a folder above one (it can read it).
        crate::workspace::restricted_path_denied(cwd, &denied, &on_machine(&self.reopen_roots))
            || (!cwd.is_empty() && denied.iter().any(|d| path_is_within(d, cwd)))
    }

    fn may_edit(&self, owner: Option<&str>, machines: &[String]) -> bool {
        self.all
            || owner == Some(self.user_id.as_str())
            || machines.iter().any(|m| self.owned_machines.contains(m))
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct BoardFilter {
    /// Cards whose last activity is at or after this instant (ms).
    pub since_ms: i64,
    pub owner: Option<String>,
    pub project: Option<String>,
    pub statuses: Option<Vec<String>>,
    pub archived: bool,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct BoardPatch {
    pub status: Option<String>,
    pub attention: Option<String>,
    pub title: Option<String>,
    pub archived: Option<bool>,
    pub note: String,
}

#[derive(Debug)]
pub(crate) enum BoardError {
    NotFound,
    Forbidden,
    Invalid(String),
    Db(String),
}

struct CardRow {
    card_id: String,
    title: String,
    summary: String,
    status: String,
    attention: String,
    attention_note: String,
    project: String,
    owner_user_id: Option<String>,
    owner_email: Option<String>,
    owner_full_name: Option<String>,
    machines: Vec<Value>,
    first_seen: i64,
    last_activity: i64,
    done_at: Option<i64>,
    done_when: String,
    evidence: Value,
    confidence: f64,
    manual_override: bool,
}

#[derive(Clone)]
struct SessionRow {
    machine_id: String,
    source: String,
    session_id: String,
    cwd: String,
    owner_user_id: Option<String>,
    title: String,
    last_modified: i64,
    role: String,
}

const CARD_SELECT: &str = "SELECT c.card_id,c.title,c.summary,c.status,c.attention,c.attention_note,c.project,\
 c.owner_user_id,u.email,u.full_name,c.machines_json,c.first_seen,c.last_activity,c.done_at,c.done_when,\
 c.evidence_json,c.confidence,c.manual_override FROM board_cards c LEFT JOIN users u ON u.user_id=c.owner_user_id";

fn map_card(r: &rusqlite::Row<'_>) -> rusqlite::Result<CardRow> {
    let machines_raw: String = r.get(10)?;
    let evidence_raw: String = r.get(15)?;
    let manual: i64 = r.get(17)?;
    Ok(CardRow {
        card_id: r.get(0)?,
        title: r.get(1)?,
        summary: r.get(2)?,
        status: r.get(3)?,
        attention: r.get(4)?,
        attention_note: r.get(5)?,
        project: r.get(6)?,
        owner_user_id: r.get(7)?,
        owner_email: r.get(8)?,
        owner_full_name: r.get(9)?,
        machines: serde_json::from_str::<Value>(&machines_raw)
            .ok()
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter(|m| m.get("machineId").and_then(Value::as_str).is_some())
            .collect(),
        first_seen: r.get(11)?,
        last_activity: r.get(12)?,
        done_at: r.get(13)?,
        done_when: r.get(14)?,
        evidence: serde_json::from_str(&evidence_raw).unwrap_or_else(|_| json!({})),
        confidence: r.get(16)?,
        manual_override: manual != 0,
    })
}

fn machine_ids(row: &CardRow) -> Vec<String> {
    row.machines
        .iter()
        .filter_map(|m| m.get("machineId").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

/// «Владелец» from «Владелец Орлов», else the local part of the email.
fn short_label(full_name: Option<&str>, email: Option<&str>, fallback: &str) -> String {
    if let Some(first) = full_name
        .and_then(|n| n.split_whitespace().next())
        .filter(|s| !s.is_empty())
    {
        return first.to_string();
    }
    if let Some(local) = email
        .and_then(|e| e.split('@').next())
        .filter(|s| !s.is_empty())
    {
        return local.to_string();
    }
    fallback.to_string()
}

fn owner_json(row: &CardRow) -> Option<Value> {
    let user_id = row.owner_user_id.as_deref()?;
    let mut v = json!({
        "userId": user_id,
        "label": short_label(row.owner_full_name.as_deref(), row.owner_email.as_deref(), user_id),
    });
    if let Some(email) = &row.owner_email {
        v["email"] = Value::String(email.clone());
    }
    if let Some(name) = &row.owner_full_name {
        v["fullName"] = Value::String(name.clone());
    }
    Some(v)
}

/// Evidence as the wire wants it — every counter present, `lastCommitAt`
/// absent rather than null. The assembler writes the same keys; this only
/// fills in what an older row may lack.
fn evidence_json(raw: &Value) -> Value {
    let int = |k: &str| raw.get(k).and_then(Value::as_i64).unwrap_or(0).max(0);
    let flag = |k: &str| raw.get(k).and_then(Value::as_bool).unwrap_or(false);
    let mut v = json!({
        "commits": int("commits"),
        "pushed": flag("pushed"),
        "deployed": flag("deployed"),
        "verified": flag("verified"),
        "editedFiles": int("editedFiles"),
        "humanTurns": int("humanTurns"),
    });
    if let Some(at) = raw.get("lastCommitAt").and_then(Value::as_i64) {
        v["lastCommitAt"] = json!(at);
    }
    v
}

fn load_sessions(conn: &Connection, card_id: &str) -> Result<Vec<SessionRow>, String> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT machine_id,source,session_id,cwd,title,last_modified,role,owner_user_id FROM board_card_sessions \
             WHERE card_id=?1 ORDER BY last_modified DESC",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![card_id], |r| {
            Ok(SessionRow {
                machine_id: r.get(0)?,
                source: r.get(1)?,
                session_id: r.get(2)?,
                cwd: r.get(3)?,
                title: r.get(4)?,
                last_modified: r.get(5)?,
                role: r.get(6)?,
                owner_user_id: r.get(7)?,
            })
        })
        .map_err(db_err)?;
    Ok(rows.filter_map(Result::ok).collect())
}

fn load_events(conn: &Connection, card_id: &str) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT at,actor,kind,from_value,to_value,reason FROM board_events \
             WHERE card_id=?1 ORDER BY at DESC LIMIT ?2",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![card_id, EVENTS_PER_CARD as i64], |r| {
            let from: Option<String> = r.get(3)?;
            let to: Option<String> = r.get(4)?;
            let mut v = json!({
                "at": r.get::<_, i64>(0)?,
                "actor": r.get::<_, String>(1)?,
                "kind": r.get::<_, String>(2)?,
                "reason": r.get::<_, String>(5)?,
            });
            if let Some(f) = from {
                v["from"] = Value::String(f);
            }
            if let Some(t) = to {
                v["to"] = Value::String(t);
            }
            Ok(v)
        })
        .map_err(db_err)?;
    Ok(rows.filter_map(Result::ok).collect())
}

fn card_json(
    row: &CardRow,
    sessions: &[SessionRow],
    events: Vec<Value>,
    roadmap: &RoadmapConfig,
    now: i64,
) -> Value {
    let stale = matches!(row.status.as_str(), "in_progress" | "testing")
        && now - row.last_activity > STALE_AFTER_MS;
    let mut v = json!({
        "cardId": row.card_id,
        "title": row.title,
        "summary": row.summary,
        "status": row.status,
        "attention": row.attention,
        "project": row.project,
        "machines": row.machines,
        "firstSeen": row.first_seen,
        "lastActivity": row.last_activity,
        "stale": stale,
        "evidence": evidence_json(&row.evidence),
        "confidence": row.confidence.clamp(0.0, 1.0),
        "manualOverride": row.manual_override,
        "sessions": sessions.iter().map(|s| {
            let mut sv = json!({
                "machineId": s.machine_id,
                "sessionId": s.session_id,
                "title": s.title,
                "lastModified": s.last_modified,
                "role": if s.role == "continuation" { "continuation" } else { "origin" },
            });
            if matches!(s.source.as_str(), "claude" | "codex") {
                sv["source"] = Value::String(s.source.clone());
            }
            sv
        }).collect::<Vec<_>>(),
        "events": events,
    });
    if !row.attention_note.trim().is_empty() {
        v["attentionNote"] = Value::String(row.attention_note.clone());
    }
    if let Some(area) = area_for(&row.project, roadmap) {
        v["area"] = Value::String(area);
    }
    if let Some(owner) = owner_json(row) {
        v["owner"] = owner;
    }
    if let Some(done) = row.done_at {
        v["doneAt"] = json!(done);
    }
    if !row.done_when.trim().is_empty() && row.status != "done" {
        v["doneWhen"] = Value::String(row.done_when.clone());
    }
    v
}

impl WorkspaceStore {
    pub(crate) fn board_scope(&self, user_id: &str, admin: bool) -> Result<BoardScope, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let mut owned = HashSet::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT machine_id FROM devices WHERE owner_user_id=?1 AND revoked_at IS NULL",
                )
                .map_err(db_err)?;
            let rows = stmt
                .query_map(params![user_id], |r| r.get::<_, String>(0))
                .map_err(db_err)?;
            owned.extend(rows.filter_map(Result::ok));
        }
        let mut shared = Vec::new();
        {
            // `control` shares only, for every role — the same gate that lets a
            // member START work there. A view-only share opens the transcript
            // list, not a board of what the owner is up to.
            //
            // A share with a list (`project_share_members`) is open only to the
            // people on it and the workspace owner, and for them it is an
            // `everyone` room — the same rule `machine_access` applies.
            let mut stmt = conn
                .prepare(
                    "SELECT ps.machine_id,ps.root,\
                            CASE WHEN ps.restricted=1 \
                                 THEN 'everyone' ELSE COALESCE(ps.visibility,'team') END,\
                            d.owner_user_id \
                     FROM project_shares ps \
                     JOIN memberships m ON m.workspace_id=ps.workspace_id \
                     LEFT JOIN devices d ON d.machine_id=ps.machine_id \
                     WHERE m.user_id=?1 AND ps.access='control' \
                       AND (m.role='owner' \
                            OR ps.restricted=0 \
                            OR EXISTS(SELECT 1 FROM project_share_members l WHERE l.project_share_id=ps.project_share_id AND l.user_id=?1))",
                )
                .map_err(db_err)?;
            let rows = stmt
                .query_map(params![user_id], |r| {
                    Ok(SharedRoot {
                        machine_id: r.get(0)?,
                        root: r.get(1)?,
                        everyone: r.get::<_, String>(2)? == "everyone",
                        device_owner: r.get(3)?,
                    })
                })
                .map_err(db_err)?;
            shared.extend(rows.filter_map(Result::ok));
        }
        // Every restricted share, in any workspace, on a machine the viewer
        // does not own: the ones they are not admitted to are closed to them.
        let mut denied_roots = Vec::new();
        let mut reopen_roots = Vec::new();
        {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT ps.machine_id,ps.root,\
                            {},\
                            EXISTS(SELECT 1 FROM memberships o WHERE o.workspace_id=ps.workspace_id AND o.user_id=?1 AND o.role='owner') \
                     FROM project_shares ps WHERE ps.restricted=1",
                    crate::workspace::share_listed_sql("ps", "?1")
                ))
                .map_err(db_err)?;
            let rows = stmt
                .query_map(params![user_id], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, bool>(2)?,
                        r.get::<_, bool>(3)?,
                    ))
                })
                .map_err(db_err)?;
            for (machine, root, listed, workspace_owner) in rows.filter_map(Result::ok) {
                if owned.contains(&machine) {
                    continue;
                }
                if listed {
                    reopen_roots.push((machine, root));
                } else if !workspace_owner {
                    denied_roots.push((machine, root));
                }
            }
        }
        Ok(BoardScope {
            all: admin,
            user_id: user_id.to_string(),
            owned_machines: owned,
            shared_roots: shared,
            denied_roots,
            reopen_roots,
        })
    }

    /// The whole `GET /api/board` body. Owner counts are taken BEFORE the owner
    /// filter so the person chips keep showing who else has cards.
    pub(crate) fn board(
        &self,
        scope: &BoardScope,
        filter: &BoardFilter,
        roadmap: &RoadmapConfig,
    ) -> Result<Value, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let now = now_ms();
        let sql = format!(
            "{CARD_SELECT} WHERE c.privacy_scoped=1 AND c.archived=?1 AND c.last_activity>=?2 ORDER BY c.last_activity DESC LIMIT 2000"
        );
        let mut stmt = conn.prepare(&sql).map_err(db_err)?;
        let rows: Vec<CardRow> = stmt
            .query_map(params![filter.archived as i64, filter.since_ms], map_card)
            .map_err(db_err)?
            .filter_map(Result::ok)
            .collect();
        drop(stmt);

        let project_needle = filter.project.as_deref().map(|p| p.trim().to_lowercase());
        let mut owners: HashMap<String, (Value, i64)> = HashMap::new();
        let mut cards = Vec::new();
        for row in rows {
            let all_sessions = load_sessions(&conn, &row.card_id)?;
            // A viewer who reaches a card only through a share sees only the
            // sessions that share opens — never the owner's other machines.
            let sessions: Vec<SessionRow> = match scope.visible_sessions(
                row.owner_user_id.as_deref(),
                &machine_ids(&row),
                &all_sessions,
            ) {
                None => all_sessions,
                Some(mine) if mine.is_empty() => continue,
                Some(mine) => mine.into_iter().cloned().collect(),
            };
            if let Some(needle) = &project_needle {
                let matches_project = row.project.to_lowercase() == *needle
                    || area_for(&row.project, roadmap).as_deref() == Some(needle.as_str());
                if !matches_project {
                    continue;
                }
            }
            if let Some(statuses) = &filter.statuses {
                if !statuses.contains(&row.status) {
                    continue;
                }
            }
            if let (Some(uid), Some(owner)) = (&row.owner_user_id, owner_json(&row)) {
                owners.entry(uid.clone()).or_insert_with(|| (owner, 0)).1 += 1;
            }
            if let Some(owner) = &filter.owner {
                if row.owner_user_id.as_deref() != Some(owner.as_str()) {
                    continue;
                }
            }
            let events = load_events(&conn, &row.card_id)?;
            cards.push(card_json(&row, &sessions, events, roadmap, now));
        }
        let mut owners: Vec<Value> = owners
            .into_values()
            .map(|(mut v, n)| {
                v["cards"] = json!(n);
                v
            })
            .collect();
        owners.sort_by(|a, b| {
            b["cards"]
                .as_i64()
                .cmp(&a["cards"].as_i64())
                .then_with(|| a["label"].as_str().cmp(&b["label"].as_str()))
        });

        let mut body = json!({
            "generatedAt": now,
            "areas": areas_json(roadmap),
            "owners": owners,
            "cards": cards,
        });
        if let Some(run) = last_run(&conn)? {
            body["lastRun"] = run;
        }
        Ok(body)
    }

    /// A hand edit. Any change to status / attention / title pins the card
    /// (`manual_override`), lands in `board_events` under the person's id and
    /// in `audit_events` next to `session.stage`, so «who moved what» has one
    /// answer. Returns the card as the board would serve it.
    pub(crate) fn board_patch_card(
        &self,
        scope: &BoardScope,
        workspace_id: &str,
        card_id: &str,
        patch: &BoardPatch,
        roadmap: &RoadmapConfig,
    ) -> Result<Value, BoardError> {
        if let Some(s) = &patch.status {
            if !STAGE_IDS.contains(&s.as_str()) {
                return Err(BoardError::Invalid("unknown status".into()));
            }
        }
        if let Some(a) = &patch.attention {
            if !ATTENTION_IDS.contains(&a.as_str()) {
                return Err(BoardError::Invalid("unknown attention".into()));
            }
        }
        let title = match &patch.title {
            Some(t) => {
                let t = t.trim();
                if t.is_empty() || t.chars().count() > 120 {
                    return Err(BoardError::Invalid("title must be 1–120 characters".into()));
                }
                Some(t.to_string())
            }
            None => None,
        };
        let note = patch.note.trim().chars().take(500).collect::<String>();

        let mut conn = self
            .conn
            .lock()
            .map_err(|_| BoardError::Db("workspace database lock poisoned".to_string()))?;
        let sql = format!("{CARD_SELECT} WHERE c.card_id=?1 AND c.privacy_scoped=1");
        let row = conn
            .query_row(&sql, params![card_id], map_card)
            .optional()
            .map_err(|e| BoardError::Db(db_err(e)))?
            .ok_or(BoardError::NotFound)?;
        let links = load_sessions(&conn, card_id).map_err(BoardError::Db)?;
        let hidden = scope
            .visible_sessions(row.owner_user_id.as_deref(), &machine_ids(&row), &links)
            .is_some_and(|visible| visible.is_empty());
        if hidden || !scope.may_edit(row.owner_user_id.as_deref(), &machine_ids(&row)) {
            return Err(BoardError::Forbidden);
        }
        let archived_now: bool = conn
            .query_row(
                "SELECT archived FROM board_cards WHERE card_id=?1",
                params![card_id],
                |r| r.get::<_, i64>(0),
            )
            .map(|n| n != 0)
            .map_err(|e| BoardError::Db(db_err(e)))?;

        let now = now_ms();
        let actor = scope.user_id.clone();
        let mut changes: Vec<(&str, String, String)> = Vec::new();
        if let Some(s) = &patch.status {
            if *s != row.status {
                changes.push(("status", row.status.clone(), s.clone()));
            }
        }
        if let Some(a) = &patch.attention {
            if *a != row.attention {
                changes.push(("attention", row.attention.clone(), a.clone()));
            }
        }
        if let Some(t) = &title {
            if *t != row.title {
                changes.push(("title", row.title.clone(), t.clone()));
            }
        }
        if let Some(arch) = patch.archived {
            if arch != archived_now {
                changes.push(("archive", archived_now.to_string(), arch.to_string()));
            }
        }

        let tx = conn.transaction().map_err(|e| BoardError::Db(db_err(e)))?;
        let mut pinned = false;
        for (field, from, to) in &changes {
            match *field {
                "status" => {
                    let done_at: Option<i64> = if to == "done" {
                        row.done_at.or(Some(now))
                    } else {
                        None
                    };
                    tx.execute(
                        "UPDATE board_cards SET status=?2,done_at=?3 WHERE card_id=?1",
                        params![card_id, to, done_at],
                    )
                    .map_err(|e| BoardError::Db(db_err(e)))?;
                    pinned = true;
                }
                "attention" => {
                    tx.execute(
                        "UPDATE board_cards SET attention=?2,attention_note=CASE WHEN ?2='none' THEN '' ELSE attention_note END WHERE card_id=?1",
                        params![card_id, to],
                    )
                    .map_err(|e| BoardError::Db(db_err(e)))?;
                    pinned = true;
                }
                "title" => {
                    tx.execute(
                        "UPDATE board_cards SET title=?2 WHERE card_id=?1",
                        params![card_id, to],
                    )
                    .map_err(|e| BoardError::Db(db_err(e)))?;
                    pinned = true;
                }
                "archive" => {
                    tx.execute(
                        "UPDATE board_cards SET archived=?2 WHERE card_id=?1",
                        params![card_id, (to == "true") as i64],
                    )
                    .map_err(|e| BoardError::Db(db_err(e)))?;
                }
                _ => {}
            }
            tx.execute(
                "INSERT INTO board_events(event_id,card_id,at,actor,kind,from_value,to_value,reason) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                params![Uuid::new_v4().to_string(), card_id, now, actor, field, from, to, note],
            )
            .map_err(|e| BoardError::Db(db_err(e)))?;
            insert_audit(
                &tx,
                workspace_id,
                &actor,
                "board.card",
                "card",
                card_id,
                &json!({"cardId": card_id, "field": field, "from": from, "to": to}),
            )
            .map_err(BoardError::Db)?;
        }
        if changes.is_empty() && !note.is_empty() {
            tx.execute(
                "INSERT INTO board_events(event_id,card_id,at,actor,kind,reason) VALUES(?1,?2,?3,?4,'manual',?5)",
                params![Uuid::new_v4().to_string(), card_id, now, actor, note],
            )
            .map_err(|e| BoardError::Db(db_err(e)))?;
        }
        if pinned {
            tx.execute(
                "UPDATE board_cards SET manual_override=1 WHERE card_id=?1",
                params![card_id],
            )
            .map_err(|e| BoardError::Db(db_err(e)))?;
        }
        tx.execute(
            "UPDATE board_cards SET updated_at=?2 WHERE card_id=?1",
            params![card_id, now],
        )
        .map_err(|e| BoardError::Db(db_err(e)))?;
        tx.commit().map_err(|e| BoardError::Db(db_err(e)))?;

        let row = conn
            .query_row(&sql, params![card_id], map_card)
            .map_err(|e| BoardError::Db(db_err(e)))?;
        let sessions = load_sessions(&conn, card_id).map_err(BoardError::Db)?;
        let events = load_events(&conn, card_id).map_err(BoardError::Db)?;
        Ok(card_json(&row, &sessions, events, roadmap, now))
    }
}

fn last_run(conn: &Connection) -> Result<Option<Value>, String> {
    conn.query_row(
        "SELECT run_id,mode,finished_at,llm_calls,error FROM board_runs ORDER BY started_at DESC LIMIT 1",
        [],
        |r| {
            let finished: Option<i64> = r.get(2)?;
            let error: Option<String> = r.get(4)?;
            let mut v = json!({
                "runId": r.get::<_, String>(0)?,
                "mode": r.get::<_, String>(1)?,
                "llmCalls": r.get::<_, i64>(3)?.max(0),
            });
            if let Some(f) = finished {
                v["finishedAt"] = json!(f);
            }
            if let Some(e) = error.filter(|e| !e.is_empty()) {
                v["error"] = Value::String(e);
            }
            Ok(v)
        },
    )
    .optional()
    .map_err(db_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed_card(s: &WorkspaceStore, id: &str, owner: Option<&str>, machine: &str, status: &str) {
        let conn = s.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO board_cards(card_id,title,summary,status,project,owner_user_id,machines_json,first_seen,last_activity,evidence_json,confidence,created_at,updated_at,privacy_scoped) \
             VALUES(?1,'Тест','Резюме',?2,'hegai',?3,?4,1000,2000,'{\"commits\":1}',0.7,1000,2000,1)",
            params![id, status, owner, json!([{"machineId": machine, "name": "box"}]).to_string()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO board_card_sessions(card_id,machine_id,source,session_id,cwd,owner_user_id,title,last_modified,linked_at) \
             VALUES(?1,?2,'claude',?3,'/srv/acme',?4,'Сессия',2000,1000)",
            params![id, machine, format!("s-{id}"), owner],
        )
        .unwrap();
    }

    fn admin(user: &str) -> BoardScope {
        BoardScope {
            all: true,
            user_id: user.into(),
            owned_machines: HashSet::new(),
            shared_roots: Vec::new(),
            denied_roots: Vec::new(),
            reopen_roots: Vec::new(),
        }
    }

    fn any_filter() -> BoardFilter {
        BoardFilter {
            since_ms: 0,
            ..BoardFilter::default()
        }
    }

    #[test]
    fn schema_exists_and_area_is_computed_from_the_roadmap() {
        let s = WorkspaceStore::open_memory();
        seed_card(&s, "crd_a", None, "m1", "in_progress");
        let body = s
            .board(&admin("u1"), &any_filter(), &RoadmapConfig::default())
            .unwrap();
        let cards = body["cards"].as_array().unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0]["area"], "platform");
        assert_eq!(cards[0]["evidence"]["commits"], 1);
        assert_eq!(cards[0]["evidence"]["pushed"], false);
        assert!(
            cards[0].get("owner").is_none(),
            "no owner => field absent, not null"
        );
        assert!(cards[0].get("doneAt").is_none());
        assert_eq!(cards[0]["sessions"][0]["source"], "claude");
        assert!(body["areas"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["id"] == "unassigned"));
    }

    #[test]
    fn a_mixed_card_never_exposes_aggregate_text_to_a_partial_viewer() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("alice", "alice@x", None).unwrap();
        s.ensure_user("bob", "bob@x", None).unwrap();
        seed_card(&s, "mixed", Some("alice"), "alice-box", "planning");
        s.with_conn_for_tests(|c| { c.execute("INSERT INTO board_card_sessions(card_id,machine_id,source,session_id,owner_user_id,linked_at) VALUES('mixed','bob-box','codex','private','bob',0)", []).unwrap(); });
        for user in ["alice", "bob"] {
            let scope = s.board_scope(user, false).unwrap();
            let board = s
                .board(&scope, &any_filter(), &RoadmapConfig::default())
                .unwrap();
            assert!(board["cards"].as_array().unwrap().is_empty());
        }
    }

    #[test]
    fn visibility_admin_owner_device_share_and_stranger() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("owner", "owner@x", Some("Оля Владелец"))
            .unwrap();
        s.ensure_user("dev", "dev@x", None).unwrap();
        s.ensure_user("member", "member@x", None).unwrap();
        s.ensure_user("stranger", "stranger@x", None).unwrap();
        {
            let conn = s.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO devices(machine_id,owner_user_id,name,os,agent_version,last_seen,created_at) VALUES('m1','dev','box','linux','0',1,1)",
                [],
            )
            .unwrap();
        }
        seed_card(&s, "crd_a", Some("owner"), "m1", "testing");

        let rm = RoadmapConfig::default();
        assert_eq!(
            s.board(&admin("x"), &any_filter(), &rm).unwrap()["cards"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let owner_scope = s.board_scope("owner", false).unwrap();
        let body = s.board(&owner_scope, &any_filter(), &rm).unwrap();
        assert_eq!(body["cards"].as_array().unwrap().len(), 1);
        assert_eq!(body["cards"][0]["owner"]["label"], "Оля");
        assert_eq!(body["owners"][0]["cards"], 1);
        let dev_scope = s.board_scope("dev", false).unwrap();
        assert_eq!(
            s.board(&dev_scope, &any_filter(), &rm).unwrap()["cards"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let stranger = s.board_scope("stranger", false).unwrap();
        assert_eq!(
            s.board(&stranger, &any_filter(), &rm).unwrap()["cards"]
                .as_array()
                .unwrap()
                .len(),
            0
        );

        // A control-share of the session's root into a workspace the member belongs to opens it.
        let ws = s.workspaces("dev").unwrap()[0]["workspaceId"]
            .as_str()
            .unwrap()
            .to_string();
        {
            let conn = s.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?1,'member','member',1)",
                params![ws],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO project_shares(project_share_id,workspace_id,machine_id,owner_user_id,root,name,created_at,access) \
                 VALUES('ps1',?1,'m1','dev','/srv/acme','hegai',1,'control')",
                params![ws],
            )
            .unwrap();
        }
        // The device owner's OWN card in the same root stays hidden from a member
        // (the list hides it too), and so does an unowned one.
        seed_card(&s, "crd_devown", Some("dev"), "m1", "in_progress");
        seed_card(&s, "crd_noone", None, "m1", "in_progress");
        let member = s.board_scope("member", false).unwrap();
        let seen = s.board(&member, &any_filter(), &rm).unwrap();
        assert_eq!(
            seen["cards"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| c["cardId"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["crd_a"]
        );
        // `everyone` opens the whole root — the owner's own work and the unowned
        // legacy alike, exactly as `session_visible` reads an open root.
        {
            let conn = s.conn.lock().unwrap();
            conn.execute(
                "UPDATE project_shares SET visibility='everyone' WHERE project_share_id='ps1'",
                [],
            )
            .unwrap();
        }
        let member = s.board_scope("member", false).unwrap();
        let mut ids: Vec<String> = s.board(&member, &any_filter(), &rm).unwrap()["cards"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["cardId"].as_str().unwrap().to_string())
            .collect();
        ids.sort();
        assert_eq!(ids, vec!["crd_a", "crd_devown", "crd_noone"]);
        {
            let conn = s.conn.lock().unwrap();
            conn.execute(
                "UPDATE project_shares SET visibility='team' WHERE project_share_id='ps1'",
                [],
            )
            .unwrap();
        }
        let member = s.board_scope("member", false).unwrap();
        // ...but the member may not edit it: not owner, not the device's owner.
        let err = s
            .board_patch_card(
                &member,
                &ws,
                "crd_a",
                &BoardPatch {
                    status: Some("done".into()),
                    ..Default::default()
                },
                &rm,
            )
            .unwrap_err();
        assert!(matches!(err, BoardError::Forbidden));
    }

    /// A restricted share the viewer is shut out of hides cards that touch it
    /// from everybody — an administrator and the session's own owner included —
    /// unless the machine is theirs; so does a session whose folder is ABOVE the
    /// closed root (it can read it).
    #[test]
    fn denied_roots_hide_cards_even_from_an_admin_and_the_owner() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("u1", "u1@x", None).unwrap();
        seed_card(&s, "crd_a", Some("u1"), "m1", "testing"); // session cwd /srv/acme
        let rm = RoadmapConfig::default();
        let cards = |scope: &BoardScope| {
            s.board(scope, &any_filter(), &rm).unwrap()["cards"]
                .as_array()
                .unwrap()
                .len()
        };
        let mut scope = admin("u1");
        assert_eq!(cards(&scope), 1);
        for closed in ["/srv/acme", "/srv/acme/secret", "/srv"] {
            // The session's folder itself, a root BELOW it, a root ABOVE it.
            scope.denied_roots = vec![("m1".into(), closed.into())];
            assert_eq!(cards(&scope), 0, "admin, closed root {closed}");
            let mut member = scope.clone();
            member.all = false;
            assert_eq!(cards(&member), 0, "the session's own owner, {closed}");
        }
        // A filesystem root is above everything: the session in /srv/acme is
        // under a closed root nested in `/`, and a session AT `/` would contain it.
        scope.denied_roots = vec![("m1".into(), "/srv/acme/secret".into())];
        assert!(scope.denied("m1", "/"), "a folder above the closed root");
        assert!(scope.denied("m1", "/srv"));
        assert!(!scope.denied("m1", "/home"));
        scope.denied_roots = vec![("m1".into(), r"D:\repo\secret".into())];
        assert!(scope.denied("m1", r"D:\"));
        assert!(!scope.denied("m1", r"E:\"));
        // Another machine's closed root says nothing about this one.
        scope.denied_roots = vec![("m2".into(), "/srv/acme".into())];
        assert_eq!(cards(&scope), 1);
        // Their own machine is theirs.
        scope.denied_roots = vec![("m1".into(), "/srv/acme".into())];
        scope.owned_machines.insert("m1".into());
        assert_eq!(cards(&scope), 1);
        // A nested restricted share they ARE on reopens a broader closed one.
        scope.owned_machines.clear();
        scope.denied_roots = vec![("m1".into(), "/srv".into())];
        scope.reopen_roots = vec![("m1".into(), "/srv/acme".into())];
        assert_eq!(cards(&scope), 1);
    }

    #[test]
    fn a_hand_edit_pins_the_card_and_leaves_a_trail() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("u1", "u1@x", Some("Владелец")).unwrap();
        let ws = s.workspaces("u1").unwrap()[0]["workspaceId"]
            .as_str()
            .unwrap()
            .to_string();
        seed_card(&s, "crd_a", Some("u1"), "m1", "testing");
        let scope = s.board_scope("u1", false).unwrap();
        let rm = RoadmapConfig::default();
        let card = s
            .board_patch_card(
                &scope,
                &ws,
                "crd_a",
                &BoardPatch {
                    status: Some("done".into()),
                    note: "проверил руками".into(),
                    ..Default::default()
                },
                &rm,
            )
            .unwrap();
        assert_eq!(card["status"], "done");
        assert_eq!(card["manualOverride"], true);
        assert!(card["doneAt"].is_i64());
        assert_eq!(card["events"][0]["kind"], "status");
        assert_eq!(card["events"][0]["actor"], "u1");
        assert_eq!(card["events"][0]["reason"], "проверил руками");
        let conn = s.conn.lock().unwrap();
        let (action, meta): (String, String) = conn
            .query_row(
                "SELECT action,metadata_json FROM audit_events WHERE target_id='crd_a'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(action, "board.card");
        assert!(meta.contains("\"to\":\"done\""));
    }

    #[test]
    fn unknown_status_is_refused_and_a_missing_card_is_not_found() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("u1", "u1@x", None).unwrap();
        seed_card(&s, "crd_a", Some("u1"), "m1", "backlog");
        let scope = admin("u1");
        let rm = RoadmapConfig::default();
        let bad = BoardPatch {
            status: Some("foo".into()),
            ..Default::default()
        };
        assert!(matches!(
            s.board_patch_card(&scope, "w", "crd_a", &bad, &rm),
            Err(BoardError::Invalid(_))
        ));
        let ok = BoardPatch {
            attention: Some("blocked".into()),
            ..Default::default()
        };
        assert!(matches!(
            s.board_patch_card(&scope, "w", "crd_nope", &ok, &rm),
            Err(BoardError::NotFound)
        ));
    }

    #[test]
    fn filters_by_owner_project_area_and_status() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("u1", "u1@x", None).unwrap();
        s.ensure_user("u2", "u2@x", None).unwrap();
        seed_card(&s, "crd_a", Some("u1"), "m1", "done");
        seed_card(&s, "crd_b", Some("u2"), "m1", "in_progress");
        let rm = RoadmapConfig::default();
        let by_owner = BoardFilter {
            since_ms: 0,
            owner: Some("u2".into()),
            ..Default::default()
        };
        let body = s.board(&admin("x"), &by_owner, &rm).unwrap();
        assert_eq!(body["cards"].as_array().unwrap().len(), 1);
        assert_eq!(
            body["owners"].as_array().unwrap().len(),
            2,
            "owner chips count everyone visible"
        );
        let by_area = BoardFilter {
            since_ms: 0,
            project: Some("platform".into()),
            ..Default::default()
        };
        assert_eq!(
            s.board(&admin("x"), &by_area, &rm).unwrap()["cards"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let by_status = BoardFilter {
            since_ms: 0,
            statuses: Some(vec!["done".into()]),
            ..Default::default()
        };
        assert_eq!(
            s.board(&admin("x"), &by_status, &rm).unwrap()["cards"][0]["cardId"],
            "crd_a"
        );
        let too_recent = BoardFilter {
            since_ms: 5000,
            ..Default::default()
        };
        assert_eq!(
            s.board(&admin("x"), &too_recent, &rm).unwrap()["cards"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }
}
