//! Support access on request (external edition, harmless in the internal one).
//!
//! A customer's hub is theirs; HegAI has no account on it. When they need help
//! the workspace OWNER opens a grant: the hub creates a dedicated account
//! (`support:<grant_id>`), puts it in the workspace with a role and hands the
//! owner a single-use sign-in link to pass on. The grant ends by itself at its
//! `expires_at` or when the owner revokes it, and everything the account does
//! is written to `audit_events` where the owner reads it («Что делала
//! поддержка»).
//!
//! Three rules hold the design together:
//!
//! * **The clock is checked at the gate, not only in the sweep.** A support
//!   account is refused by `authenticate`, `require_member`, `ui_access` and
//!   `session_alive` the moment its grant stops being active; the periodic
//!   sweep only tidies up (membership, sessions, the `support.expired` row,
//!   open sockets). A sweep that is late or never runs cannot extend access.
//! * **The session never outlives the grant.** The sign-in mints a session whose
//!   expiry IS the grant's, and a support session does not slide
//!   (`authenticate_row`).
//! * **Normal users pay nothing.** The "is this a support account" test is a
//!   prefix compare on the user id, and the registry that answers "is its grant
//!   still active, which session belongs to it" lives in memory, so no request
//!   of an ordinary user touches SQLite for this feature.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::workspace::{db_err, hash_token, insert_audit, now_ms, opaque_token, WorkspaceStore};

/// Every support account id starts with this; nothing else may.
pub(crate) const SUPPORT_PREFIX: &str = "support:";
/// What the owner and the team see as the account's name.
pub(crate) const SUPPORT_NAME: &str = "Поддержка Hegai Code";
pub(crate) const MIN_HOURS: i64 = 1;
pub(crate) const MAX_HOURS: i64 = 72;
/// The one-time link is good this long at most (and never past the grant).
const LOGIN_LINK_MAX_MS: i64 = 2 * 60 * 60 * 1000;
/// Open grants per workspace. A forgotten pile of links is the failure this
/// prevents, not a quota anyone is expected to meet.
const MAX_ACTIVE_GRANTS: i64 = 5;
const NOTE_MAX_CHARS: usize = 500;
/// Cap on one metadata value an audit row keeps.
const META_VALUE_CHARS: usize = 500;
pub(crate) const LOG_LIMIT: i64 = 1000;

/// `true` for an id minted by a grant. A plain string test: this runs for every
/// user on the gate paths.
pub(crate) fn is_support_user(user_id: &str) -> bool {
    user_id.starts_with(SUPPORT_PREFIX)
}

/// One open grant as the gate sees it.
#[derive(Clone, Debug)]
pub(crate) struct SupportEntry {
    pub grant_id: String,
    pub workspace_id: String,
    pub expires_at: i64,
}

/// The in-memory half of the feature: which support accounts have a grant that
/// is not closed yet (with its deadline) and which session hashes belong to
/// them. Rebuilt from SQLite at start, kept in step by grant / login / revoke /
/// expiry. Empty on a hub that never opened a grant.
#[derive(Default)]
pub(crate) struct SupportRegistry {
    users: HashMap<String, SupportEntry>,
    sessions: HashMap<String, String>,
}

pub(crate) type SharedSupport = Arc<RwLock<SupportRegistry>>;

pub(crate) fn new_registry() -> SharedSupport {
    Arc::new(RwLock::new(SupportRegistry::default()))
}

pub(crate) fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS support_grants (
          grant_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          support_user_id TEXT NOT NULL UNIQUE,
          granted_by TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('member','manager')),
          note TEXT,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          revoked_at INTEGER,
          -- Set when the membership and the sessions have been removed: by a
          -- revoke at once, by the sweep after expires_at.
          closed_at INTEGER,
          login_token_hash TEXT NOT NULL UNIQUE,
          login_expires_at INTEGER NOT NULL,
          login_used_at INTEGER,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS support_grants_workspace ON support_grants(workspace_id, created_at DESC);
        "#,
    )
    .map_err(db_err)
}

struct GrantRow {
    grant_id: String,
    workspace_id: String,
    support_user_id: String,
    granted_by: String,
    role: String,
    note: Option<String>,
    created_at: i64,
    expires_at: i64,
    revoked_at: Option<i64>,
    closed_at: Option<i64>,
    login_expires_at: i64,
    login_used_at: Option<i64>,
}

const GRANT_COLUMNS: &str = "grant_id,workspace_id,support_user_id,granted_by,role,note,created_at,expires_at,revoked_at,closed_at,login_expires_at,login_used_at";

fn read_grant(r: &rusqlite::Row<'_>) -> rusqlite::Result<GrantRow> {
    Ok(GrantRow {
        grant_id: r.get(0)?,
        workspace_id: r.get(1)?,
        support_user_id: r.get(2)?,
        granted_by: r.get(3)?,
        role: r.get(4)?,
        note: r.get(5)?,
        created_at: r.get(6)?,
        expires_at: r.get(7)?,
        revoked_at: r.get(8)?,
        closed_at: r.get(9)?,
        login_expires_at: r.get(10)?,
        login_used_at: r.get(11)?,
    })
}

fn grant_status(row: &GrantRow, now: i64) -> &'static str {
    if row.revoked_at.is_some() {
        "revoked"
    } else if row.expires_at <= now {
        "expired"
    } else {
        "active"
    }
}

/// The wire shape. Optional fields are absent, never null.
fn grant_json(row: &GrantRow, now: i64) -> Value {
    let mut v = json!({
        "grantId": row.grant_id,
        "workspaceId": row.workspace_id,
        "supportUserId": row.support_user_id,
        "grantedBy": row.granted_by,
        "role": row.role,
        "createdAt": row.created_at,
        "expiresAt": row.expires_at,
        "status": grant_status(row, now),
        "linkUsed": row.login_used_at.is_some(),
        "linkExpiresAt": row.login_expires_at,
    });
    if let Some(note) = &row.note {
        v["note"] = Value::String(note.clone());
    }
    if let Some(at) = row.revoked_at {
        v["revokedAt"] = json!(at);
    }
    if let Some(at) = row.closed_at {
        v["closedAt"] = json!(at);
    }
    v
}

/// Cut a string to `max` characters (not bytes: the note is Russian).
fn clip(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// What a login hands back.
#[cfg_attr(test, derive(Debug))]
pub(crate) struct SupportLogin {
    pub session: String,
    pub expires_at: i64,
}

/// Remove everything that lets the account act: the membership and every
/// session. Idempotent; the audit row and `closed_at` are the caller's, because
/// only a first close writes them.
fn strip_access(tx: &Connection, workspace_id: &str, user_id: &str) -> Result<(), String> {
    tx.execute(
        "DELETE FROM memberships WHERE workspace_id=?1 AND user_id=?2",
        params![workspace_id, user_id],
    )
    .map_err(db_err)?;
    tx.execute(
        "DELETE FROM auth_sessions WHERE user_id=?1",
        params![user_id],
    )
    .map_err(db_err)?;
    // Belt and braces: the routes that would give the account a machine are
    // refused (`support_forbidden`), but a device or code that exists anyway
    // must not outlive the grant.
    let now = now_ms();
    tx.execute(
        "UPDATE device_credentials SET revoked_at=?2 WHERE revoked_at IS NULL AND machine_id IN (SELECT machine_id FROM devices WHERE owner_user_id=?1)",
        params![user_id, now],
    )
    .map_err(db_err)?;
    tx.execute(
        "UPDATE devices SET revoked_at=?2 WHERE revoked_at IS NULL AND owner_user_id=?1",
        params![user_id, now],
    )
    .map_err(db_err)?;
    tx.execute("DELETE FROM enrollments WHERE user_id=?1", params![user_id])
        .map_err(db_err)?;
    Ok(())
}

impl WorkspaceStore {
    /// The grant behind a support account while it is open (not closed), with
    /// its deadline. `None` for every ordinary user and for a closed grant.
    pub(crate) fn support_entry(&self, user_id: &str) -> Option<SupportEntry> {
        if !is_support_user(user_id) {
            return None;
        }
        self.support.read().ok()?.users.get(user_id).cloned()
    }

    /// May this account act right now? Always `true` for an ordinary user; for
    /// a support account only while its grant is open AND before its deadline.
    /// Read straight from the clock, so it does not wait for the sweep.
    pub(crate) fn support_gate(&self, user_id: &str) -> bool {
        if !is_support_user(user_id) {
            return true;
        }
        self.support_entry(user_id)
            .is_some_and(|e| e.expires_at > now_ms())
    }

    /// The gate for one SESSION of an account: an ordinary user's passes; a
    /// support account's passes only while the grant is open and only for the
    /// session its login link minted (`token_hash` is the stored hash). A
    /// session made by any other flow for that id is refused.
    pub(crate) fn support_session_gate(&self, user_id: &str, token_hash: &str) -> bool {
        if !is_support_user(user_id) {
            return true;
        }
        self.support.read().is_ok_and(|reg| {
            reg.users
                .get(user_id)
                .is_some_and(|e| e.expires_at > now_ms())
                && reg.sessions.get(token_hash).is_some_and(|u| u == user_id)
        })
    }

    /// Whether any grant is open at all: the middleware's first, free test.
    pub(crate) fn support_any(&self) -> bool {
        self.support
            .read()
            .map(|r| !r.users.is_empty())
            .unwrap_or(false)
    }

    /// The support account a session token belongs to, when its grant is still
    /// good. Hashes the token (no database).
    pub(crate) fn support_user_of_token(&self, token: &str) -> Option<String> {
        let reg = self.support.read().ok()?;
        let user = reg.sessions.get(&hash_token(token))?.clone();
        reg.users
            .get(&user)
            .is_some_and(|e| e.expires_at > now_ms())
            .then_some(user)
    }

    /// Write one audit row for a support account, in the workspace of its grant.
    /// Unlike the ordinary best-effort `/ui` audit this FAILS CLOSED: the caller
    /// must not let the action through when the trace could not be written
    /// (`Err`). An account with no open grant writes nothing and is `Ok`.
    pub(crate) fn audit_support(
        &self,
        user_id: &str,
        action: &str,
        target_kind: &str,
        target_id: &str,
        meta: &Value,
    ) -> Result<(), String> {
        let Some(entry) = self.support_entry(user_id) else {
            return Ok(());
        };
        self.audit(
            &entry.workspace_id,
            user_id,
            action,
            target_kind,
            target_id,
            meta,
        )
        .inspect_err(|e| eprintln!("[support] audit {action} failed: {e}"))
    }

    fn support_forget(&self, user_id: &str) {
        if let Ok(mut reg) = self.support.write() {
            reg.users.remove(user_id);
            reg.sessions.retain(|_, user| user != user_id);
        }
    }

    /// Rebuild the registry from the database: every grant not closed yet, and
    /// the sessions of its account. Called at start.
    pub(crate) fn load_support_registry(&self) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let mut users = HashMap::new();
        let mut stmt = conn
            .prepare("SELECT support_user_id,grant_id,workspace_id,expires_at FROM support_grants WHERE closed_at IS NULL AND revoked_at IS NULL")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    SupportEntry {
                        grant_id: r.get(1)?,
                        workspace_id: r.get(2)?,
                        expires_at: r.get(3)?,
                    },
                ))
            })
            .map_err(db_err)?;
        for row in rows.flatten() {
            users.insert(row.0, row.1);
        }
        drop(stmt);
        let mut sessions = HashMap::new();
        let mut stmt = conn
            // Only the session the login link minted (same instant as the link's
            // use): a session made any other way is not support's to have.
            .prepare("SELECT s.token_hash FROM auth_sessions s JOIN support_grants g ON g.support_user_id=s.user_id WHERE s.user_id=?1 AND s.created_at=g.login_used_at")
            .map_err(db_err)?;
        for user in users.keys() {
            let hashes = stmt
                .query_map(params![user], |r| r.get::<_, String>(0))
                .map_err(db_err)?;
            for hash in hashes.flatten() {
                sessions.insert(hash, user.clone());
            }
        }
        drop(stmt);
        drop(conn);
        if let Ok(mut reg) = self.support.write() {
            reg.users = users;
            reg.sessions = sessions;
        }
        Ok(())
    }

    /// Open a grant. Owner of an organization only. Returns the grant and the
    /// one-time login token (the caller builds the link); the token is never
    /// stored in the clear and never returned again.
    pub fn create_support_grant(
        &self,
        actor: &str,
        workspace_id: &str,
        hours: i64,
        role: &str,
        note: Option<&str>,
    ) -> Result<(Value, String), String> {
        if !(MIN_HOURS..=MAX_HOURS).contains(&hours) {
            return Err(format!("hours must be {MIN_HOURS}..{MAX_HOURS}"));
        }
        if !matches!(role, "member" | "manager") {
            return Err("role must be member or manager".into());
        }
        let note = note
            .map(|n| clip(n.trim(), NOTE_MAX_CHARS))
            .filter(|n| !n.is_empty());
        let now = now_ms();
        let expires_at = now + hours * 60 * 60 * 1000;
        let login_expires_at = expires_at.min(now + LOGIN_LINK_MAX_MS);
        let grant_id = Uuid::new_v4().simple().to_string();
        let short = &grant_id[..8];
        let user_id = format!("{SUPPORT_PREFIX}{grant_id}");
        let email = format!("support+{short}@support.invalid");
        let token = opaque_token();

        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let (owner_role, kind): (String, String) = tx
            .query_row(
                "SELECT m.role,w.kind FROM memberships m JOIN workspaces w ON w.workspace_id=m.workspace_id WHERE m.workspace_id=?1 AND m.user_id=?2",
                params![workspace_id, actor],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(db_err)?
            .ok_or("workspace access denied")?;
        if owner_role != "owner" {
            return Err("insufficient workspace role".into());
        }
        if kind != "organization" {
            return Err(
                "Доступ поддержки открывается для команды, не для личного пространства.".into(),
            );
        }
        let open: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM support_grants WHERE workspace_id=?1 AND closed_at IS NULL AND revoked_at IS NULL AND expires_at>?2",
                params![workspace_id, now],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if open >= MAX_ACTIVE_GRANTS {
            return Err("Слишком много открытых доступов поддержки: закройте ненужные.".into());
        }
        tx.execute(
            "INSERT INTO users(user_id,email,full_name,created_at) VALUES(?1,?2,?3,?4)",
            params![user_id, email, SUPPORT_NAME, now],
        )
        .map_err(db_err)?;
        tx.execute(
            "INSERT INTO user_access(user_id,state,plan,requested_at,activated_at,activated_by,updated_at) VALUES(?1,'active','employee',?2,?2,?3,?2)",
            params![user_id, now, actor],
        )
        .map_err(db_err)?;
        tx.execute(
            "INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?1,?2,?3,?4)",
            params![workspace_id, user_id, role, now],
        )
        .map_err(db_err)?;
        tx.execute(
            "INSERT INTO support_grants(grant_id,workspace_id,support_user_id,granted_by,role,note,created_at,expires_at,login_token_hash,login_expires_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                grant_id,
                workspace_id,
                user_id,
                actor,
                role,
                note,
                now,
                expires_at,
                hash_token(&token),
                login_expires_at
            ],
        )
        .map_err(db_err)?;
        insert_audit(
            &tx,
            workspace_id,
            actor,
            "support.grant",
            "support_grant",
            &grant_id,
            &json!({"supportUserId": user_id, "role": role, "hours": hours, "expiresAt": expires_at, "note": note}),
        )?;
        let row = tx
            .query_row(
                &format!("SELECT {GRANT_COLUMNS} FROM support_grants WHERE grant_id=?1"),
                params![grant_id],
                read_grant,
            )
            .map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        drop(conn);
        if let Ok(mut reg) = self.support.write() {
            reg.users.insert(
                user_id,
                SupportEntry {
                    grant_id: grant_id.clone(),
                    workspace_id: workspace_id.to_string(),
                    expires_at,
                },
            );
        }
        Ok((grant_json(&row, now), token))
    }

    /// Owner's list of the workspace's grants, newest first.
    pub fn list_support_grants(
        &self,
        actor: &str,
        workspace_id: &str,
    ) -> Result<Vec<Value>, String> {
        self.require_owner(actor, workspace_id)?;
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(&format!("SELECT {GRANT_COLUMNS} FROM support_grants WHERE workspace_id=?1 ORDER BY created_at DESC, rowid DESC LIMIT 200"))
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![workspace_id], read_grant)
            .map_err(db_err)?;
        Ok(rows.flatten().map(|row| grant_json(&row, now)).collect())
    }

    fn require_owner(&self, actor: &str, workspace_id: &str) -> Result<(), String> {
        self.require_role(actor, workspace_id, &["owner"])
    }

    /// Close a grant now. Idempotent: a grant that is already closed comes back
    /// unchanged and writes nothing.
    pub fn revoke_support_grant(
        &self,
        actor: &str,
        workspace_id: &str,
        grant_id: &str,
    ) -> Result<Value, String> {
        self.require_owner(actor, workspace_id)?;
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let row = tx
            .query_row(
                &format!("SELECT {GRANT_COLUMNS} FROM support_grants WHERE grant_id=?1 AND workspace_id=?2"),
                params![grant_id, workspace_id],
                read_grant,
            )
            .optional()
            .map_err(db_err)?
            .ok_or("support grant not found")?;
        strip_access(&tx, workspace_id, &row.support_user_id)?;
        let first = row.closed_at.is_none() && row.revoked_at.is_none();
        if first {
            tx.execute(
                "UPDATE support_grants SET revoked_at=?2, closed_at=?2 WHERE grant_id=?1",
                params![grant_id, now],
            )
            .map_err(db_err)?;
            insert_audit(
                &tx,
                workspace_id,
                actor,
                "support.revoke",
                "support_grant",
                grant_id,
                &json!({"supportUserId": row.support_user_id}),
            )?;
        } else if row.revoked_at.is_none() {
            // Expired and swept already: the owner's «закрыть» still records
            // that it was closed by hand.
            tx.execute(
                "UPDATE support_grants SET revoked_at=?2 WHERE grant_id=?1",
                params![grant_id, now],
            )
            .map_err(db_err)?;
        }
        let fresh = tx
            .query_row(
                &format!("SELECT {GRANT_COLUMNS} FROM support_grants WHERE grant_id=?1"),
                params![grant_id],
                read_grant,
            )
            .map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        drop(conn);
        self.support_forget(&row.support_user_id);
        Ok(grant_json(&fresh, now))
    }

    /// «Что делала поддержка»: the audit rows of the grant's account, plus the
    /// lifecycle rows that name the grant (opened, closed by hand, expired),
    /// newest first, at most `LOG_LIMIT` per call. `before` (a `createdAt`,
    /// inclusive) pages back; the second value is the total, so a flood of
    /// noise cannot push an action out of what the owner can reach.
    pub fn support_grant_log(
        &self,
        actor: &str,
        workspace_id: &str,
        grant_id: &str,
        before: Option<i64>,
    ) -> Result<(Vec<Value>, i64), String> {
        self.require_owner(actor, workspace_id)?;
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let user_id: String = conn
            .query_row(
                "SELECT support_user_id FROM support_grants WHERE grant_id=?1 AND workspace_id=?2",
                params![grant_id, workspace_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?
            .ok_or("support grant not found")?;
        let mut stmt = conn
            .prepare(
                "SELECT a.audit_event_id,a.actor_user_id,u.full_name,u.email,a.action,a.target_kind,a.target_id,a.metadata_json,a.created_at \
                 FROM audit_events a LEFT JOIN users u ON u.user_id=a.actor_user_id \
                 WHERE a.workspace_id=?1 AND (a.actor_user_id=?2 OR (a.target_kind='support_grant' AND a.target_id=?3)) AND a.created_at<=?5 \
                 ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?4",
            )
            .map_err(db_err)?;
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM audit_events a WHERE a.workspace_id=?1 AND (a.actor_user_id=?2 OR (a.target_kind='support_grant' AND a.target_id=?3))",
                params![workspace_id, user_id, grant_id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![workspace_id, user_id, grant_id, LOG_LIMIT, before.unwrap_or(i64::MAX)], |r| {
                let full: Option<String> = r.get(2)?;
                let email: Option<String> = r.get(3)?;
                let raw: String = r.get(7)?;
                let mut v = json!({
                    "auditEventId": r.get::<_, String>(0)?,
                    "workspaceId": workspace_id,
                    "actorUserId": r.get::<_, String>(1)?,
                    "action": r.get::<_, String>(4)?,
                    "targetKind": r.get::<_, String>(5)?,
                    "targetId": r.get::<_, String>(6)?,
                    "createdAt": r.get::<_, i64>(8)?,
                    "metadata": serde_json::from_str::<Value>(&raw).unwrap_or_else(|_| json!({})),
                });
                if let Some(n) = full.or(email) {
                    v["actorName"] = Value::String(n);
                }
                Ok(v)
            })
            .map_err(db_err)?;
        Ok((rows.flatten().collect(), total))
    }

    /// Spend a login link. One use, inside both the link's and the grant's
    /// window, not after a revoke. The session it mints ends when the grant
    /// does. The audit row is part of the same transaction, as with the
    /// operator sign-in link: no session exists without its trace.
    pub(crate) fn consume_support_login(&self, token: &str) -> Result<SupportLogin, String> {
        let now = now_ms();
        let hash = hash_token(token);
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let spent = tx
            .execute(
                "UPDATE support_grants SET login_used_at=?2 WHERE login_token_hash=?1 AND login_used_at IS NULL AND revoked_at IS NULL AND closed_at IS NULL AND expires_at>?2 AND login_expires_at>?2",
                params![hash, now],
            )
            .map_err(db_err)?;
        if spent == 0 {
            return Err("invalid_link".into());
        }
        let row = tx
            .query_row(
                &format!("SELECT {GRANT_COLUMNS} FROM support_grants WHERE login_token_hash=?1"),
                params![hash],
                read_grant,
            )
            .map_err(db_err)?;
        let session = opaque_token();
        // MFA: exempt on purpose (`mfa_pending` stays 0). The support user is a
        // grant-bound account with no authenticator of its own; what vouches
        // for the entry is the owner's grant and this one-shot, audited link.
        tx.execute(
            "INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?1,?2,?3,?4)",
            params![hash_token(&session), row.support_user_id, row.expires_at, now],
        )
        .map_err(db_err)?;
        insert_audit(
            &tx,
            &row.workspace_id,
            &row.support_user_id,
            "support.login",
            "support_grant",
            &row.grant_id,
            &json!({"role": row.role}),
        )?;
        tx.commit().map_err(db_err)?;
        drop(conn);
        if let Ok(mut reg) = self.support.write() {
            reg.sessions
                .insert(hash_token(&session), row.support_user_id.clone());
        }
        Ok(SupportLogin {
            session,
            expires_at: row.expires_at,
        })
    }

    /// Close the grants whose time is up: remove the membership and the
    /// sessions, write `support.expired`. Cheap when nothing is due (an
    /// in-memory scan); the hub runs it on its sweep tick. Returns the closed
    /// support user ids so the caller can drop their sockets.
    pub(crate) fn sweep_support_expired(&self) -> Result<Vec<String>, String> {
        let now = now_ms();
        let due: Vec<(String, SupportEntry)> = match self.support.read() {
            Ok(reg) => reg
                .users
                .iter()
                .filter(|(_, e)| e.expires_at <= now)
                .map(|(u, e)| (u.clone(), e.clone()))
                .collect(),
            Err(_) => return Ok(Vec::new()),
        };
        let mut closed = Vec::new();
        for (user_id, entry) in due {
            {
                let conn = self
                    .conn
                    .lock()
                    .map_err(|_| "workspace database lock poisoned".to_string())?;
                let tx = conn.unchecked_transaction().map_err(db_err)?;
                strip_access(&tx, &entry.workspace_id, &user_id)?;
                let newly = tx
                    .execute(
                        "UPDATE support_grants SET closed_at=?2 WHERE grant_id=?1 AND closed_at IS NULL AND revoked_at IS NULL",
                        params![entry.grant_id, now],
                    )
                    .map_err(db_err)?;
                if newly > 0 {
                    insert_audit(
                        &tx,
                        &entry.workspace_id,
                        &user_id,
                        "support.expired",
                        "support_grant",
                        &entry.grant_id,
                        &json!({"expiresAt": entry.expires_at}),
                    )?;
                }
                tx.commit().map_err(db_err)?;
            }
            self.support_forget(&user_id);
            closed.push(user_id);
        }
        Ok(closed)
    }
}

/// UI frames that say nothing about what the account did: keep-alives and
/// window-size noise. Everything else is logged.
pub(crate) const UI_UNLOGGED: &[&str] = &["ping", "term_resize", "stats_interest", "hello"];
/// An identical `support.ui` row (same connection, type and target) is written
/// once per this long. Terminal keystrokes and the chunks of one upload are one
/// frame each; the bytes are never stored.
pub(crate) const DUPLICATE_EVERY_MS: i64 = 15_000;

const META_KEYS: &[&str] = &[
    "machineId",
    "sessionId",
    "runId",
    "termId",
    "cwd",
    "path",
    "from",
    "to",
    "name",
    "dir",
    "uploadId",
    "branch",
];

/// The audit shape of one UI frame: `(metadata, target_kind, target_id)`.
/// ONLY the type and the ids / paths it points at — never the body (prompt text,
/// file contents, terminal input, attachments). Each value is clipped.
pub(crate) fn ui_audit_shape(v: &Value) -> (Value, &'static str, String) {
    let ty = v.get("type").and_then(Value::as_str).unwrap_or("?");
    let mut meta = serde_json::Map::new();
    meta.insert("type".into(), Value::String(clip(ty, META_VALUE_CHARS)));
    let mut take = |source: &Value| {
        for key in META_KEYS {
            if let Some(s) = source.get(*key).and_then(Value::as_str) {
                meta.entry((*key).to_string())
                    .or_insert_with(|| Value::String(clip(s, META_VALUE_CHARS)));
            }
        }
    };
    take(v);
    if let Some(method) = v.get("method").and_then(Value::as_str) {
        take(v.get("params").unwrap_or(&Value::Null));
        meta.insert(
            "method".into(),
            Value::String(clip(method, META_VALUE_CHARS)),
        );
    }
    let id_of = |key: &str| meta.get(key).and_then(Value::as_str).map(|s| clip(s, 200));
    let (kind, target) = if let Some(s) = id_of("sessionId") {
        ("session", s)
    } else if let Some(m) = id_of("machineId") {
        ("machine", m)
    } else {
        ("ui", ty.chars().take(64).collect())
    };
    (Value::Object(meta), kind, target)
}

/// Hub paths a support account may not use, whatever its role: they would leave
/// something behind after the grant ends (a device credential, a linked
/// sign-in, an accepted seat) or touch the account itself.
pub(crate) fn support_forbidden(path: &str) -> bool {
    path.starts_with("/api/enrollments")
        || path.starts_with("/api/account/")
        || path == "/api/workspaces"
        || path == "/api/invitations/accept"
        || path.starts_with("/api/me/identities")
        || (path.starts_with("/api/auth/") && path.contains("link"))
        || path == "/api/auth/apple/exchange"
}

#[cfg(test)]
impl WorkspaceStore {
    /// Move a grant's deadline, in the database and in the gate's memory.
    pub(crate) fn set_support_expiry_for_tests(&self, grant_id: &str, at: i64) {
        self.with_conn_for_tests(|c| {
            c.execute(
                "UPDATE support_grants SET expires_at=?2 WHERE grant_id=?1",
                params![grant_id, at],
            )
            .unwrap();
        });
        let mut reg = self.support.write().unwrap();
        for entry in reg.users.values_mut() {
            if entry.grant_id == grant_id {
                entry.expires_at = at;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: i64 = 60 * 60 * 1000;

    /// Owner `boss` of an organization with member `ann`; returns the workspace.
    fn team() -> (WorkspaceStore, String) {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("boss", "boss@x", Some("Boss")).unwrap();
        let w = s.create_organization("boss", "Team", "boss").unwrap();
        let wid = w["workspaceId"].as_str().unwrap().to_string();
        s.ensure_user("ann", "ann@x", Some("Anna")).unwrap();
        let invite = s.invite("boss", &wid, "ann@x", "member").unwrap();
        s.accept_invitation("ann", invite["token"].as_str().unwrap())
            .unwrap();
        (s, wid)
    }

    fn actions(s: &WorkspaceStore, action: &str) -> i64 {
        s.with_conn_for_tests(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM audit_events WHERE action=?1",
                [action],
                |r| r.get(0),
            )
            .unwrap()
        })
    }

    fn sessions_of(s: &WorkspaceStore, user: &str) -> i64 {
        s.with_conn_for_tests(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM auth_sessions WHERE user_id=?1",
                [user],
                |r| r.get(0),
            )
            .unwrap()
        })
    }

    fn id_of(grant: &Value) -> String {
        grant["grantId"].as_str().unwrap().to_string()
    }

    #[test]
    fn a_grant_makes_a_dedicated_member_and_a_single_use_link() {
        let (s, wid) = team();
        let before = now_ms();
        let (grant, token) = s
            .create_support_grant("boss", &wid, 4, "manager", Some("  не стартует агент  "))
            .unwrap();
        let user = grant["supportUserId"].as_str().unwrap().to_string();
        assert_eq!(user, format!("support:{}", id_of(&grant)));
        assert_eq!(grant["status"], "active");
        assert_eq!(grant["role"], "manager");
        assert_eq!(grant["note"], "не стартует агент");
        assert_eq!(grant["linkUsed"], false);
        assert!(grant.get("revokedAt").is_none(), "absent, not null");
        assert!(grant["expiresAt"].as_i64().unwrap() >= before + 4 * HOUR);
        // The account: named, in the team with that role, active.
        assert_eq!(s.require_member(&user, &wid).unwrap(), "manager");
        assert!(s.is_active(&user));
        let ui = s.ui_access(&user, Some(&wid), false).unwrap();
        assert_eq!(ui.workspace_id, wid);
        assert_eq!(ui.viewer["fullName"], SUPPORT_NAME);
        assert!(ui.viewer["email"]
            .as_str()
            .unwrap()
            .ends_with("@support.invalid"));
        // The link: single use, and the session ends with the grant.
        let login = s.consume_support_login(&token).unwrap();
        assert_eq!(login.expires_at, grant["expiresAt"].as_i64().unwrap());
        let (who, until) = s.authenticate(&login.session).unwrap().unwrap();
        assert_eq!(who, user);
        assert_eq!(until, login.expires_at);
        assert_eq!(
            s.consume_support_login(&token).unwrap_err(),
            "invalid_link",
            "a spent link is spent"
        );
        // The token itself is not stored.
        let stored: i64 = s.with_conn_for_tests(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM support_grants WHERE login_token_hash=?1",
                [&token],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(stored, 0);
        assert_eq!(actions(&s, "support.grant"), 1);
        assert_eq!(actions(&s, "support.login"), 1);
        // The owner's list shows it, and so does the team list.
        let list = s.list_support_grants("boss", &wid).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["linkUsed"], true);
    }

    #[test]
    fn the_link_is_good_two_hours_at_most_and_never_past_the_grant() {
        let (s, wid) = team();
        let now = now_ms();
        let (long, _) = s
            .create_support_grant("boss", &wid, 72, "member", None)
            .unwrap();
        let link_end = long["linkExpiresAt"].as_i64().unwrap();
        assert!(link_end <= now + 2 * HOUR + 5_000 && link_end >= now + 2 * HOUR - 5_000);
        let (short, token) = s
            .create_support_grant("boss", &wid, 1, "member", None)
            .unwrap();
        assert_eq!(
            short["linkExpiresAt"].as_i64().unwrap(),
            short["expiresAt"].as_i64().unwrap()
        );
        // A link left lying past its own window is refused.
        s.with_conn_for_tests(|c| {
            c.execute(
                "UPDATE support_grants SET login_expires_at=?1 WHERE grant_id=?2",
                params![now_ms() - 1, id_of(&short)],
            )
            .unwrap();
        });
        assert_eq!(s.consume_support_login(&token).unwrap_err(), "invalid_link");
        assert_eq!(sessions_of(&s, short["supportUserId"].as_str().unwrap()), 0);
    }

    #[test]
    fn only_the_owner_of_an_organization_can_open_list_revoke_or_read() {
        let (s, wid) = team();
        let (grant, _) = s
            .create_support_grant("boss", &wid, 1, "member", None)
            .unwrap();
        let gid = id_of(&grant);
        for who in ["ann", "stranger"] {
            assert!(s
                .create_support_grant(who, &wid, 1, "member", None)
                .is_err());
            assert!(s.list_support_grants(who, &wid).is_err());
            assert!(s.revoke_support_grant(who, &wid, &gid).is_err());
            assert!(s.support_grant_log(who, &wid, &gid, None).is_err());
        }
        // Bad input is refused, and a personal space is not a team.
        for (hours, role) in [(0, "member"), (73, "member"), (1, "owner"), (1, "")] {
            assert!(s
                .create_support_grant("boss", &wid, hours, role, None)
                .is_err());
        }
        assert!(s
            .create_support_grant("boss", "personal:boss", 1, "member", None)
            .is_err());
        // A grant of another workspace cannot be reached through this one.
        let other = s.create_organization("boss", "Other", "boss").unwrap();
        let other_id = other["workspaceId"].as_str().unwrap();
        assert!(s.revoke_support_grant("boss", other_id, &gid).is_err());
        assert!(s.support_grant_log("boss", other_id, &gid, None).is_err());
    }

    #[test]
    fn the_number_of_open_grants_is_capped() {
        let (s, wid) = team();
        for _ in 0..MAX_ACTIVE_GRANTS {
            s.create_support_grant("boss", &wid, 1, "member", None)
                .unwrap();
        }
        assert!(s
            .create_support_grant("boss", &wid, 1, "member", None)
            .is_err());
    }

    #[test]
    fn revoking_kills_the_sessions_and_the_membership_at_once() {
        let (s, wid) = team();
        let (grant, token) = s
            .create_support_grant("boss", &wid, 24, "manager", None)
            .unwrap();
        let user = grant["supportUserId"].as_str().unwrap().to_string();
        let login = s.consume_support_login(&token).unwrap();
        let second = s.consume_support_login("nope");
        assert!(second.is_err());
        assert!(s.session_alive(&hash_token(&login.session)).unwrap());
        let revoked = s
            .revoke_support_grant("boss", &wid, &id_of(&grant))
            .unwrap();
        assert_eq!(revoked["status"], "revoked");
        assert!(s.authenticate(&login.session).unwrap().is_none());
        assert_eq!(sessions_of(&s, &user), 0);
        assert!(!s.session_alive(&hash_token(&login.session)).unwrap());
        assert!(s.require_member(&user, &wid).is_err());
        assert!(s.ui_access(&user, Some(&wid), false).is_err());
        assert!(!s.support_any());
        // Idempotent, and written once.
        s.revoke_support_grant("boss", &wid, &id_of(&grant))
            .unwrap();
        assert_eq!(actions(&s, "support.revoke"), 1);
        // A token that was never spent is dead too.
        let (second_grant, unused) = s
            .create_support_grant("boss", &wid, 24, "member", None)
            .unwrap();
        s.revoke_support_grant("boss", &wid, &id_of(&second_grant))
            .unwrap();
        assert_eq!(
            s.consume_support_login(&unused).unwrap_err(),
            "invalid_link"
        );
        // Even a session minted around the front door is refused by the gate.
        let rogue = s.create_auth_session(&user, 7).unwrap();
        assert!(s.authenticate(&rogue).unwrap().is_none());
    }

    #[test]
    fn an_expired_grant_is_refused_at_the_gate_before_the_sweep_runs() {
        let (s, wid) = team();
        let (grant, token) = s
            .create_support_grant("boss", &wid, 1, "member", None)
            .unwrap();
        let user = grant["supportUserId"].as_str().unwrap().to_string();
        let login = s.consume_support_login(&token).unwrap();
        assert!(s.authenticate(&login.session).unwrap().is_some());
        // The clock passes the deadline; nothing has swept yet.
        s.set_support_expiry_for_tests(&id_of(&grant), now_ms() - 1);
        assert!(s.authenticate(&login.session).unwrap().is_none());
        assert!(s.require_member(&user, &wid).is_err());
        assert!(s.ui_access(&user, Some(&wid), false).is_err());
        assert!(!s.session_alive(&hash_token(&login.session)).unwrap());
        assert!(s.support_user_of_token(&login.session).is_none());
        // The row is still there for the sweep to close.
        assert_eq!(sessions_of(&s, &user), 1);
        let closed = s.sweep_support_expired().unwrap();
        assert_eq!(closed, vec![user.clone()]);
        assert_eq!(sessions_of(&s, &user), 0);
        let members: i64 = s.with_conn_for_tests(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM memberships WHERE user_id=?1",
                [&user],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(members, 0);
        assert_eq!(actions(&s, "support.expired"), 1);
        // Once, and the owner's list says expired.
        assert!(s.sweep_support_expired().unwrap().is_empty());
        assert_eq!(actions(&s, "support.expired"), 1);
        assert_eq!(
            s.list_support_grants("boss", &wid).unwrap()[0]["status"],
            "expired"
        );
        // An unspent link of an expired grant is dead.
        let (g2, t2) = s
            .create_support_grant("boss", &wid, 1, "member", None)
            .unwrap();
        s.set_support_expiry_for_tests(&id_of(&g2), now_ms() - 1);
        assert_eq!(s.consume_support_login(&t2).unwrap_err(), "invalid_link");
    }

    #[test]
    fn a_support_session_never_slides_past_its_grant() {
        let (s, wid) = team();
        let (grant, token) = s
            .create_support_grant("boss", &wid, 2, "member", None)
            .unwrap();
        let login = s.consume_support_login(&token).unwrap();
        // Make the session look 90 minutes old: past half of its life, which
        // is exactly when an ordinary session would be extended.
        s.with_conn_for_tests(|c| {
            c.execute(
                "UPDATE auth_sessions SET created_at=created_at-?1 WHERE token_hash=?2",
                params![90 * 60 * 1000, hash_token(&login.session)],
            )
            .unwrap();
        });
        let (_, until) = s.authenticate(&login.session).unwrap().unwrap();
        assert_eq!(until, grant["expiresAt"].as_i64().unwrap());
        let (_, again) = s.authenticate(&login.session).unwrap().unwrap();
        assert_eq!(again, until);
    }

    #[test]
    fn the_log_is_the_account_s_audit_rows_newest_first() {
        let (s, wid) = team();
        let (grant, token) = s
            .create_support_grant("boss", &wid, 2, "member", None)
            .unwrap();
        let user = grant["supportUserId"].as_str().unwrap().to_string();
        let gid = id_of(&grant);
        s.consume_support_login(&token).unwrap();
        s.audit_support(
            &user,
            "support.ui",
            "session",
            "s1",
            &json!({"type":"open"}),
        )
        .unwrap();
        s.audit_support(
            &user,
            "support.http",
            "http",
            "/api/x",
            &json!({"method":"POST"}),
        )
        .unwrap();
        // Somebody else's row in the same workspace is not support's.
        s.audit(&wid, "ann", "session.started", "session", "s2", &json!({}))
            .unwrap();
        let log = s.support_grant_log("boss", &wid, &gid, None).unwrap().0;
        let kinds: Vec<&str> = log.iter().map(|e| e["action"].as_str().unwrap()).collect();
        assert_eq!(
            kinds,
            [
                "support.http",
                "support.ui",
                "support.login",
                "support.grant"
            ]
        );
        // The team's ordinary audit page is not drowned by them.
        let team_audit = s.audit_events("boss", &wid).unwrap();
        assert!(team_audit.iter().all(|e| {
            let a = e["action"].as_str().unwrap();
            a != "support.ui" && a != "support.http"
        }));
        assert!(team_audit.iter().any(|e| e["action"] == "support.grant"));
    }

    #[test]
    fn nothing_is_written_for_an_account_that_is_not_support() {
        let (s, wid) = team();
        assert!(!s.support_any());
        assert!(s.support_gate("boss"));
        s.audit_support("boss", "support.ui", "ui", "x", &json!({}))
            .unwrap();
        s.audit_support("ann", "support.http", "http", "/y", &json!({}))
            .unwrap();
        // A well-formed support id with no grant behind it writes nothing either.
        s.audit_support("support:forged", "support.ui", "ui", "x", &json!({}))
            .unwrap();
        assert_eq!(actions(&s, "support.ui") + actions(&s, "support.http"), 0);
        assert!(!s.support_gate("support:forged"));
        assert!(s.require_member("support:forged", &wid).is_err());
    }

    #[test]
    fn open_grants_survive_a_restart() {
        let dir = std::env::temp_dir().join(format!("support-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ws.db");
        let (user, session, wid) = {
            let s = WorkspaceStore::open(&path).unwrap();
            s.ensure_user("boss", "boss@x", Some("Boss")).unwrap();
            let w = s.create_organization("boss", "Team", "boss").unwrap();
            let wid = w["workspaceId"].as_str().unwrap().to_string();
            let (grant, token) = s
                .create_support_grant("boss", &wid, 2, "member", None)
                .unwrap();
            let login = s.consume_support_login(&token).unwrap();
            (
                grant["supportUserId"].as_str().unwrap().to_string(),
                login.session,
                wid,
            )
        };
        let again = WorkspaceStore::open(&path).unwrap();
        assert!(again.support_any());
        assert!(again.support_gate(&user));
        assert_eq!(
            again.support_user_of_token(&session).as_deref(),
            Some(user.as_str())
        );
        assert!(again.authenticate(&session).unwrap().is_some());
        assert_eq!(again.require_member(&user, &wid).unwrap(), "member");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_frame_is_logged_by_its_type_and_ids_never_its_body() {
        let (meta, kind, target) = ui_audit_shape(&json!({
            "type": "input", "sessionId": "s-1", "runId": "r-1", "machineId": "m-1",
            "text": "the customer's secret prompt", "images": [{"data": "AAAA"}],
        }));
        assert_eq!(kind, "session");
        assert_eq!(target, "s-1");
        assert_eq!(meta["type"], "input");
        assert_eq!(meta["sessionId"], "s-1");
        assert_eq!(meta["machineId"], "m-1");
        let flat = meta.to_string();
        assert!(!flat.contains("secret") && !flat.contains("AAAA"), "{flat}");
        // A file call keeps its method and path, not the content.
        let (meta, kind, target) = ui_audit_shape(&json!({
            "type": "rpc_request", "machineId": "m-1", "method": "files.write",
            "params": {"path": "/srv/app/.env", "content": "TOKEN=abc"},
        }));
        assert_eq!((kind, target.as_str()), ("machine", "m-1"));
        assert_eq!(meta["method"], "files.write");
        assert_eq!(meta["path"], "/srv/app/.env");
        assert!(!meta.to_string().contains("TOKEN"));
        // Long values are cut; a terminal and a bare frame still get a target.
        let long = "x".repeat(2000);
        let (meta, _, _) = ui_audit_shape(&json!({"type":"term_open","machineId":"m","cwd":long}));
        assert_eq!(
            meta["cwd"].as_str().unwrap().chars().count(),
            META_VALUE_CHARS
        );
        let (_, kind, target) = ui_audit_shape(&json!({"type":"rescan"}));
        assert_eq!((kind, target.as_str()), ("ui", "rescan"));
    }

    #[test]
    fn what_a_support_account_may_not_reach() {
        for path in [
            "/api/enrollments",
            "/api/account/delete",
            "/api/invitations/accept",
            "/api/me/identities/unlink",
            "/api/auth/google/link",
            "/api/auth/google/link/confirm",
            "/api/auth/apple/exchange",
            "/api/account/deletion",
            "/api/enrollments/approve",
            "/api/workspaces",
        ] {
            assert!(support_forbidden(path), "{path}");
        }
        for path in [
            "/api/workspaces/w/projects",
            "/api/logout",
            "/api/auth/sessions/revoke",
        ] {
            assert!(!support_forbidden(path), "{path}");
        }
    }

    #[test]
    fn a_session_made_any_other_way_for_a_support_account_is_refused() {
        let (s, wid) = team();
        let (grant, token) = s
            .create_support_grant("boss", &wid, 2, "member", None)
            .unwrap();
        let user = grant["supportUserId"].as_str().unwrap().to_string();
        let login = s.consume_support_login(&token).unwrap();
        // While the grant is open, only the session its link minted counts.
        std::thread::sleep(std::time::Duration::from_millis(3));
        let rogue = s.create_auth_session(&user, 7).unwrap();
        assert!(s.authenticate(&rogue).unwrap().is_none());
        assert!(!s.session_alive(&hash_token(&rogue)).unwrap());
        assert!(s.authenticate(&login.session).unwrap().is_some());
        // After a restart the registry still knows only the minted one.
        s.load_support_registry().unwrap();
        assert!(s.authenticate(&rogue).unwrap().is_none());
        assert!(s.authenticate(&login.session).unwrap().is_some());
    }

    #[test]
    fn a_support_account_cannot_ask_for_its_own_erasure() {
        let (s, wid) = team();
        let (grant, _) = s
            .create_support_grant("boss", &wid, 2, "member", None)
            .unwrap();
        let user = grant["supportUserId"].as_str().unwrap();
        let err = s
            .request_account_deletion_with_receipt(user, &json!([]), &"a".repeat(64))
            .unwrap_err();
        assert!(err.contains("support"), "{err}");
    }

    #[test]
    fn closing_a_grant_also_cuts_a_machine_the_account_somehow_got() {
        let (s, wid) = team();
        let (grant, _) = s
            .create_support_grant("boss", &wid, 2, "member", None)
            .unwrap();
        let user = grant["supportUserId"].as_str().unwrap().to_string();
        s.register_legacy_device(
            &user,
            &json!({"machineId":"m-support","name":"mine","os":"linux","agentVersion":"1"}),
        )
        .unwrap();
        s.create_enrollment(&user).unwrap();
        s.revoke_support_grant("boss", &wid, &id_of(&grant))
            .unwrap();
        let (revoked, codes): (Option<i64>, i64) = s.with_conn_for_tests(|c| {
            (
                c.query_row(
                    "SELECT revoked_at FROM devices WHERE machine_id='m-support'",
                    [],
                    |r| r.get(0),
                )
                .unwrap(),
                c.query_row(
                    "SELECT COUNT(*) FROM enrollments WHERE user_id=?1",
                    [&user],
                    |r| r.get(0),
                )
                .unwrap(),
            )
        });
        assert!(revoked.is_some());
        assert_eq!(codes, 0);
    }

    #[test]
    fn the_log_pages_back_and_says_how_many_there_are() {
        let (s, wid) = team();
        let (grant, token) = s
            .create_support_grant("boss", &wid, 2, "member", None)
            .unwrap();
        let user = grant["supportUserId"].as_str().unwrap().to_string();
        let gid = id_of(&grant);
        s.consume_support_login(&token).unwrap();
        for i in 0..5 {
            s.audit_support(
                &user,
                "support.ui",
                "ui",
                &format!("t{i}"),
                &json!({"type": "t"}),
            )
            .unwrap();
        }
        let (all, total) = s.support_grant_log("boss", &wid, &gid, None).unwrap();
        assert_eq!((all.len(), total), (7, 7));
        // `before` is inclusive of its own millisecond: the caller drops rows it has.
        let cut = all[3]["createdAt"].as_i64().unwrap();
        let (older, total) = s.support_grant_log("boss", &wid, &gid, Some(cut)).unwrap();
        assert_eq!(total, 7);
        assert!(older
            .iter()
            .all(|e| e["createdAt"].as_i64().unwrap() <= cut));
        assert!(older.len() <= 7);
    }

    #[test]
    fn a_trace_that_cannot_be_written_is_an_error_not_a_silence() {
        let (s, wid) = team();
        let (grant, _) = s
            .create_support_grant("boss", &wid, 2, "member", None)
            .unwrap();
        let user = grant["supportUserId"].as_str().unwrap();
        s.with_conn_for_tests(|c| {
            c.execute_batch("ALTER TABLE audit_events RENAME TO audit_gone")
                .unwrap();
        });
        assert!(s
            .audit_support(user, "support.ui", "ui", "x", &json!({}))
            .is_err());
        // An ordinary account is not a support concern and never errors here.
        assert!(s
            .audit_support("boss", "support.ui", "ui", "x", &json!({}))
            .is_ok());
        let _ = wid;
    }
}
