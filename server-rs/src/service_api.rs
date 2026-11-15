//! Service integrations: another product of ours (legal.acme.test) keeps the
//! list of people allowed into a project folder, and signs its users into the
//! right place in Hegai Code.
//!
//! Its own credential class, apart from the fleet token, device tokens and
//! fleet API keys. A key is issued by hand to ONE integration and lives in a
//! 0600 JSON file named by `CC_REMOTE_SERVICE_KEYS_FILE`, as a sha256 digest:
//!
//! ```json
//! [{"name":"legal","workspaceId":"…","machineIds":["…"],
//!   "rootPrefix":"/srv/legal/projects","keySha256":"<hex>","signinSecret":"<≥32 bytes>",
//!   "uiOrigins":["https://legal.acme.test"]}]
//! ```
//!
//! `uiOrigins` is optional; absent or empty = the key mints no UI passes.
//!
//! Unset or empty => every endpoint here is 404. A key acts ONLY in its own
//! workspace, on its own machines, and only on folders strictly inside its
//! `rootPrefix`; it can never touch another share, and it cannot read a file.
//!
//! - `PUT/DELETE/GET /api/service/shares` — upsert / remove / list project
//!   shares with their member list (`project_share_members`);
//! - `GET /api/auth/service-signin?t=<JWT>` — a browser session for a user the
//!   integration vouches for (HS256 with the entry's `signinSecret`);
//! - `POST /api/service/ui-tokens` — a 12-hour pass that opens `/ui` (the
//!   WebSocket) from the integration's own page, confined by the hub to the
//!   shares under `rootPrefix` the person is listed on, and refused on every
//!   HTTP endpoint (`WorkspaceStore::authenticate` skips it).

use super::*;
use axum::body::Bytes;
use jsonwebtoken::Validation;
use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::workspace::{
    db_err, insert_audit, normalize_root, path_is_within, share_members_json, UiScope,
    WorkspaceStore, UI_SCOPE_SERVICE,
};

const SERVICE_SIGNIN_AUDIENCE: &str = "cc-remote-service-signin";
/// A token older than this is refused even if its `exp` is later: the
/// integration mints them per click.
const SIGNIN_MAX_TTL_SECS: u64 = 120;
const SERVICE_BODY_MAX: usize = 64 * 1024;
const SERVICE_MEMBERS_MAX: usize = 50;
/// Writes (PUT/DELETE) per key per hour. A ten-minute sync of a hundred
/// matters is ~600 an hour in the worst case, so this leaves room but stops a
/// loop.
const SERVICE_WRITES_PER_HOUR: usize = 4000;
const SERVICE_READS_PER_MINUTE: usize = 300;
/// The browser session of a service sign-in: a normal browser login.
const SERVICE_SESSION_DAYS: i64 = 7;
/// A UI pass lives this long and is never extended: the page asks for a new one
/// (and reconnects) before it runs out.
const UI_PASS_TTL_MS: i64 = 12 * 60 * 60 * 1000;
/// Live UI passes one person may hold from one key; minting past it ends the
/// oldest. The integration mints one per page load.
const UI_PASSES_PER_USER: i64 = 20;
const SERVICE_UI_PASSES_PER_MINUTE: usize = 120;
/// How long the HTTP caller waits for the agent's answer to the mkdir.
const MKDIR_WAIT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServiceKey {
    pub(crate) name: String,
    pub(crate) workspace_id: String,
    pub(crate) machine_ids: Vec<String>,
    pub(crate) root_prefix: String,
    pub(crate) key_sha256: String,
    pub(crate) signin_secret: String,
    /// Browser origins allowed to open `/ui` with a UI pass of this key
    /// (`["https://legal.acme.test"]`). Absent or empty = this key mints no UI
    /// passes at all. Exact origins, no wildcards.
    #[serde(default)]
    pub(crate) ui_origins: Vec<String>,
}

impl ServiceKey {
    /// The fence a UI pass of this key puts around a `/ui` connection.
    pub(crate) fn ui_scope(&self) -> UiScope {
        UiScope {
            issuer: self.name.clone(),
            workspace_id: self.workspace_id.clone(),
            machine_ids: self.machine_ids.clone(),
            root_prefix: self.root_prefix.clone(),
        }
    }

    /// Whether the handshake's `Origin` is one this key admits for UI passes.
    /// No `Origin` is refused: a pass is for a browser page, and a native
    /// client has no business with it.
    pub(crate) fn ui_origin_allowed(&self, origin: Option<&str>) -> bool {
        origin
            .and_then(normalize_ui_origin)
            .is_some_and(|origin| self.ui_origins.contains(&origin))
    }
}

/// `scheme://host[:port]`, lowercase, nothing else — the only shape an
/// `Origin` header takes and the only shape `uiOrigins` accepts.
fn normalize_ui_origin(raw: &str) -> Option<String> {
    let origin = raw.trim().trim_end_matches('/').to_ascii_lowercase();
    let rest = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))?;
    let ok = !rest.is_empty()
        && !rest.contains(['/', '?', '#', '@', '*', '\\'])
        && !rest.chars().any(|c| c.is_whitespace() || c.is_control());
    ok.then_some(origin)
}

pub(crate) fn load_service_keys() -> Option<Arc<Vec<ServiceKey>>> {
    let path = std::env::var("CC_REMOTE_SERVICE_KEYS_FILE").ok()?;
    let path = path.trim();
    if path.is_empty() {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            if meta.permissions().mode() & 0o077 != 0 {
                eprintln!("[hub] WARNING: {path} is readable by others; it holds signing secrets, chmod 600");
            }
        }
    }
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) => {
            eprintln!("[hub] CC_REMOTE_SERVICE_KEYS_FILE {path}: {e}");
            return None;
        }
    };
    let keys = parse_service_keys(&raw);
    if keys.is_empty() {
        return None;
    }
    println!("[hub] service API open to {} integration(s)", keys.len());
    Some(Arc::new(keys))
}

pub(crate) fn parse_service_keys(raw: &str) -> Vec<ServiceKey> {
    let Ok(entries) = serde_json::from_str::<Vec<Value>>(raw) else {
        eprintln!("[hub] ignoring CC_REMOTE_SERVICE_KEYS_FILE: not a JSON list");
        return Vec::new();
    };
    entries
        .into_iter()
        .filter_map(|entry| {
            let mut key: ServiceKey = serde_json::from_value(entry).ok()?;
            key.key_sha256 = key.key_sha256.trim().to_ascii_lowercase();
            key.root_prefix = normalize_root(&key.root_prefix);
            // An origin that is not exactly `scheme://host[:port]` is dropped
            // (fewer origins is the safe direction), not guessed at.
            let declared = key.ui_origins.len();
            key.ui_origins = key
                .ui_origins
                .iter()
                .filter_map(|o| normalize_ui_origin(o))
                .collect();
            key.ui_origins.dedup();
            if key.ui_origins.len() != declared {
                eprintln!(
                    "[hub] service key {}: ignoring a malformed or repeated uiOrigins entry",
                    key.name
                );
            }
            let valid = key.key_sha256.len() == 64
                && key.key_sha256.chars().all(|c| c.is_ascii_hexdigit())
                && !key.name.trim().is_empty()
                && key.name.chars().count() <= 64
                && !key.name.chars().any(char::is_control)
                && !key.workspace_id.trim().is_empty()
                && !key.machine_ids.is_empty()
                // Absolute and not the whole disk.
                && key.root_prefix.starts_with('/')
                && key.root_prefix.len() > 1
                && key.signin_secret.len() >= 32;
            if !valid {
                eprintln!("[hub] ignoring a malformed service key entry");
                return None;
            }
            Some(key)
        })
        .fold(Vec::<ServiceKey>::new(), |mut keys, key| {
            // A name is the key's identity: it labels the sessions it mints
            // (`service_issuer`) and a UI pass is resolved back to its key by
            // it, so two entries can never share one. The first wins.
            if keys.iter().any(|k| k.name == key.name) {
                eprintln!(
                    "[hub] ignoring a second service key entry named {}",
                    key.name
                );
            } else {
                keys.push(key);
            }
            keys
        })
}

/// Equal-length byte strings compared without an early exit.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn service_caller(st: &AppState, headers: &HeaderMap) -> Result<ServiceKey, Response> {
    let Some(keys) = st.service_keys.as_ref() else {
        return Err(api_error(
            StatusCode::NOT_FOUND,
            "the service API is not configured on this hub",
        ));
    };
    let Some(token) = bearer_token(headers) else {
        return Err(api_error(StatusCode::UNAUTHORIZED, "unauthorized"));
    };
    let digest: String = Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    // Every entry is compared, whichever matches first.
    let mut found: Option<&ServiceKey> = None;
    for key in keys.iter() {
        if constant_time_eq(digest.as_bytes(), key.key_sha256.as_bytes()) {
            found = Some(key);
        }
    }
    found
        .cloned()
        .ok_or_else(|| api_error(StatusCode::UNAUTHORIZED, "invalid service key"))
}

fn reserve(
    st: &AppState,
    key: &str,
    limit: usize,
    window_ms: i64,
    why: &str,
) -> Result<(), Response> {
    let Ok(mut log) = st.window_log.lock() else {
        return Err(api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "rate limiter unavailable",
        ));
    };
    let now = crate::workspace_api::chrono_now_ms();
    log.check(key, limit, window_ms, now)
        .map_err(|()| refusal(StatusCode::TOO_MANY_REQUESTS, why))?;
    log.record(key, window_ms, now);
    Ok(())
}

/// The normalized root when it lies STRICTLY inside the key's prefix. The raw
/// string may not contain `..` at all: a path that only resolves into the
/// prefix after climbing is a path somebody built to get out of it.
fn root_under_prefix(root: &str, prefix: &str) -> Result<String, &'static str> {
    let raw = root.trim();
    if raw.is_empty() || !raw.starts_with('/') {
        return Err("root must be an absolute path");
    }
    if raw.contains('\\') || raw.chars().any(char::is_control) {
        return Err("root has forbidden characters");
    }
    if raw.split('/').any(|segment| segment == "..") {
        return Err("root must not contain ..");
    }
    let normalized = normalize_root(raw);
    if normalized == prefix || !path_is_within(&normalized, prefix) {
        return Err("root is outside this key's rootPrefix");
    }
    Ok(normalized)
}

/// `{userId, role}` pairs: the shape the service API speaks.
fn plain_members(members: Vec<Value>) -> Vec<Value> {
    members
        .into_iter()
        .map(|m| json!({"userId": m["userId"], "role": m["role"]}))
        .collect()
}

fn share_json(
    conn: &rusqlite::Connection,
    share_id: &str,
    machine_id: &str,
    root: &str,
    name: &str,
) -> Result<Value, String> {
    Ok(json!({
        "shareId": share_id, "machineId": machine_id, "root": root, "name": name,
        "members": plain_members(share_members_json(conn, share_id, false)?),
    }))
}

// ------------------------------------------------------------------ store

/// What an upsert did, for the HTTP answer.
pub(crate) struct Upserted {
    pub(crate) share_id: String,
    pub(crate) members: Vec<Value>,
    pub(crate) missing: Vec<String>,
}

impl WorkspaceStore {
    /// Make the share at (workspace, machine, root) exist with `access=control`,
    /// `restricted=1` and exactly `members` as its list. Only people already in
    /// the workspace can be listed — the key never adds anyone to the team; any
    /// other id is reported in `missing`. All or nothing.
    ///
    /// A list that ends up EMPTY is refused, so an integration that lost its
    /// user mapping cannot wipe a share's list by accident. (A restricted share
    /// whose people were later erased stays closed: the flag, not the rows,
    /// makes it restricted.)
    pub(crate) fn service_upsert_share(
        &self,
        actor: &str,
        workspace_id: &str,
        machine_id: &str,
        root: &str,
        name: &str,
        members: &[(String, String)],
    ) -> Result<Upserted, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let owner: Option<String> = tx
            .query_row(
                "SELECT owner_user_id FROM devices WHERE machine_id=?1 AND revoked_at IS NULL",
                params![machine_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        let Some(owner) = owner else {
            return Err("no_device".into());
        };
        let owner_in_workspace: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM memberships WHERE workspace_id=?1 AND user_id=?2)",
                params![workspace_id, owner],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if !owner_in_workspace {
            return Err("owner_not_member".into());
        }
        let mut resolved: Vec<(&str, &str)> = Vec::new();
        let mut missing: Vec<String> = Vec::new();
        for (user_id, role) in members {
            if resolved.iter().any(|(u, _)| u == user_id) || missing.contains(user_id) {
                continue;
            }
            // Only people who are ALREADY in the workspace can be listed: a
            // service key decides who works on a share, never who joins the
            // team (and so never mints a member out of a bare user id).
            let exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM memberships WHERE workspace_id=?1 AND user_id=?2)",
                    params![workspace_id, user_id],
                    |r| r.get(0),
                )
                .map_err(db_err)?;
            if exists {
                resolved.push((user_id, role));
            } else {
                missing.push(user_id.clone());
            }
        }
        if resolved.is_empty() {
            return Err("no_members".into());
        }
        let now = crate::workspace::now_ms();
        let existing: Option<String> = tx
            .query_row(
                "SELECT project_share_id FROM project_shares WHERE workspace_id=?1 AND machine_id=?2 AND root=?3",
                params![workspace_id, machine_id, root],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        let share_id = match existing {
            Some(id) => {
                tx.execute(
                    "UPDATE project_shares SET name=?2,access='control',owner_user_id=?3,restricted=1 WHERE project_share_id=?1",
                    params![id, name, owner],
                )
                .map_err(db_err)?;
                id
            }
            None => {
                let id = Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO project_shares(project_share_id,workspace_id,machine_id,owner_user_id,root,name,created_at,access,visibility,restricted) VALUES(?1,?2,?3,?4,?5,?6,?7,'control','team',1)",
                    params![id, workspace_id, machine_id, owner, root, name, now],
                )
                .map_err(db_err)?;
                id
            }
        };
        tx.execute(
            "DELETE FROM project_share_members WHERE project_share_id=?1",
            params![share_id],
        )
        .map_err(db_err)?;
        for (user_id, role) in &resolved {
            tx.execute(
                "INSERT INTO project_share_members(project_share_id,user_id,role,added_at) VALUES(?1,?2,?3,?4)",
                params![share_id, user_id, role, now],
            )
            .map_err(db_err)?;
        }
        let members_json = plain_members(share_members_json(&tx, &share_id, false)?);
        insert_audit(
            &tx,
            workspace_id,
            actor,
            "project.service_shared",
            "project",
            &share_id,
            &json!({"machineId":machine_id,"root":root,"members":members_json,"missing":missing}),
        )?;
        tx.commit().map_err(db_err)?;
        Ok(Upserted {
            share_id,
            members: members_json,
            missing,
        })
    }

    /// Take the share away (its folder is not touched). A restricted share
    /// becomes a tombstone (see below). True when there was something to take
    /// away.
    pub(crate) fn service_remove_share(
        &self,
        actor: &str,
        workspace_id: &str,
        machine_id: &str,
        root: &str,
    ) -> Result<bool, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let id: Option<String> = tx
            .query_row(
                "SELECT project_share_id FROM project_shares WHERE workspace_id=?1 AND machine_id=?2 AND root=?3",
                params![workspace_id, machine_id, root],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        let Some(id) = id else {
            return Ok(false);
        };
        let restricted: bool = tx
            .query_row(
                "SELECT restricted FROM project_shares WHERE project_share_id=?1",
                params![id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        let had_people: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM project_share_members WHERE project_share_id=?1)",
                params![id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        tx.execute(
            "DELETE FROM project_share_members WHERE project_share_id=?1",
            params![id],
        )
        .map_err(db_err)?;
        if restricted {
            // A TOMBSTONE, not a deletion: the row stays restricted with
            // nobody on it, so a broader share cannot swallow the folder. A
            // later PUT on the same root revives it. Deleting an already empty
            // tombstone changes nothing (`removed:false`).
            tx.execute(
                "UPDATE project_shares SET access='view' WHERE project_share_id=?1",
                params![id],
            )
            .map_err(db_err)?;
        } else {
            tx.execute(
                "DELETE FROM project_shares WHERE project_share_id=?1",
                params![id],
            )
            .map_err(db_err)?;
        }
        let removed = !restricted || had_people;
        insert_audit(
            &tx,
            workspace_id,
            actor,
            "project.service_revoked",
            "project",
            &id,
            &json!({"machineId":machine_id,"root":root,"tombstone":restricted}),
        )?;
        tx.commit().map_err(db_err)?;
        Ok(removed)
    }

    /// The workspace's shares on one machine that lie under `prefix`.
    pub(crate) fn service_list_shares(
        &self,
        workspace_id: &str,
        machine_id: &str,
        prefix: &str,
    ) -> Result<Vec<Value>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare("SELECT project_share_id,root,name FROM project_shares WHERE workspace_id=?1 AND machine_id=?2 ORDER BY created_at,root")
            .map_err(db_err)?;
        let rows: Vec<(String, String, String)> = stmt
            .query_map(params![workspace_id, machine_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(db_err)?
            .filter_map(Result::ok)
            .filter(|(_, root, _)| path_is_within(root, prefix) && normalize_root(root) != prefix)
            .collect();
        rows.iter()
            .map(|(id, root, name)| share_json(&conn, id, machine_id, root, name))
            .collect()
    }

    /// Is `user_id` a member of the key's workspace, and is it the plain kind
    /// of member a service key may sign in? Plain = role `member`, owns no
    /// live device, and belongs to no other team (a personal workspace is
    /// theirs alone and does not count). Anyone else — an owner, a manager, a
    /// person who runs a machine, someone with a seat in another team — could
    /// reach further than this workspace, so the key may not mint a session
    /// for them.
    pub(crate) fn service_signin_profile(
        &self,
        user_id: &str,
        workspace_id: &str,
    ) -> Result<(bool, bool), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let role: Option<String> = conn
            .query_row(
                "SELECT role FROM memberships WHERE workspace_id=?1 AND user_id=?2",
                params![workspace_id, user_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        let Some(role) = role else {
            return Ok((false, false));
        };
        let devices: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM devices WHERE owner_user_id=?1 AND revoked_at IS NULL)",
                params![user_id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        let other_teams: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM memberships m JOIN workspaces w ON w.workspace_id=m.workspace_id WHERE m.user_id=?1 AND m.workspace_id<>?2 AND w.kind<>'personal')",
                params![user_id, workspace_id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        Ok((true, role == "member" && !devices && !other_teams))
    }

    /// Spend a service sign-in token: write its one-shot row and the audit row
    /// and, when `issue`, mint the browser session it opens (labelled
    /// `service:<issuer>`, so rotating the key can revoke exactly these).
    ///
    /// The `signin_links` row is the one-shot (same table as the operator
    /// sign-in links, keyed on a hash that includes the issuer so two
    /// integrations cannot spend each other's ids; it carries an `expires_at`
    /// so it is swept a day after the token could have been used). The audit
    /// row names the outcome — `issued`, `existing_session` or
    /// `login_required` — and is part of entering, in the same transaction.
    pub(crate) fn consume_service_signin(
        &self,
        issuer: &str,
        jti: &str,
        user_id: &str,
        workspace_id: &str,
        outcome: &str,
        issue: bool,
    ) -> Result<Option<String>, String> {
        let token = crate::workspace::opaque_token();
        let now = crate::workspace::now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let member: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM memberships WHERE workspace_id=?1 AND user_id=?2)",
                params![workspace_id, user_id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if !member {
            return Err("not_member".into());
        }
        // The caller's "plain member" verdict was reached a moment ago, outside
        // this transaction. A session is issued only if it STILL holds here —
        // otherwise the change (a promotion, a machine, another team) would have
        // fired its revoking trigger before the session existed.
        let still_plain: bool = tx
            .query_row(
                "SELECT COALESCE((SELECT role FROM memberships WHERE workspace_id=?1 AND user_id=?2),'')='member' \
                 AND NOT EXISTS(SELECT 1 FROM devices WHERE owner_user_id=?2 AND revoked_at IS NULL) \
                 AND NOT EXISTS(SELECT 1 FROM memberships m JOIN workspaces w ON w.workspace_id=m.workspace_id WHERE m.user_id=?2 AND m.workspace_id<>?1 AND w.kind<>'personal')",
                params![workspace_id, user_id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        let outcome = if issue && !still_plain {
            "login_required"
        } else {
            outcome
        };
        let issue = issue && still_plain;
        tx.execute(
            "DELETE FROM signin_links WHERE expires_at IS NOT NULL AND expires_at<?1",
            params![now - 24 * 60 * 60 * 1000],
        )
        .map_err(db_err)?;
        let inserted = tx
            .execute(
                "INSERT OR IGNORE INTO signin_links(jti_hash,user_id,used_at,expires_at) VALUES(?1,?2,?3,?4)",
                params![
                    crate::workspace::hash_token(&format!("service:{issuer}:{jti}")),
                    user_id,
                    now,
                    now + (SIGNIN_MAX_TTL_SECS as i64 + 60) * 1000
                ],
            )
            .map_err(db_err)?;
        if inserted == 0 {
            return Err("already_used".into());
        }
        if issue {
            // MFA: a service key vouches for a plain member, not for a second
            // factor — a member who turned an authenticator on still owes it
            // (the session is pending until `/api/auth/mfa/verify`). Admins
            // never get here (`service_session_holds`).
            let pending = self.mfa_pending_in(&tx, user_id, crate::mfa::Factor::Unproven);
            tx.execute(
                "INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at,label,service_issuer,service_workspace_id,mfa_pending) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                params![
                    crate::workspace::hash_token(&token),
                    user_id,
                    now + SERVICE_SESSION_DAYS * 24 * 60 * 60 * 1000,
                    now,
                    format!("service:{issuer}"),
                    issuer,
                    workspace_id,
                    pending
                ],
            )
            .map_err(db_err)?;
        }
        insert_audit(
            &tx,
            workspace_id,
            &format!("service:{issuer}"),
            "auth.service_signin",
            "user",
            user_id,
            &json!({"by": issuer, "outcome": outcome}),
        )?;
        tx.commit().map_err(db_err)?;
        Ok(issue.then_some(token))
    }

    /// Is `user_id` a member (any role) of `workspace_id`? False for an id
    /// nobody has.
    pub(crate) fn service_is_member(
        &self,
        user_id: &str,
        workspace_id: &str,
    ) -> Result<bool, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM memberships WHERE workspace_id=?1 AND user_id=?2)",
            params![workspace_id, user_id],
            |r| r.get(0),
        )
        .map_err(db_err)
    }

    /// Mint a UI pass: an `auth_sessions` row marked `ui_scope='service-ui'`
    /// with the issuer and workspace of the key, valid for `UI_PASS_TTL` and
    /// never extended. Only a member of the key's workspace gets one; the
    /// caller has already refused platform administrators and inactive
    /// accounts. A person keeps at most `UI_PASSES_PER_USER` live passes from
    /// one key (the oldest go), and expired ones are swept here.
    ///
    /// Returns the opaque token (shown once, only its hash is stored) and its
    /// `expires_at`.
    pub(crate) fn mint_service_ui_pass(
        &self,
        issuer: &str,
        user_id: &str,
        workspace_id: &str,
    ) -> Result<(String, i64), String> {
        if self.deletion_pending(user_id)? {
            return Err("deletion_pending".into());
        }
        let token = crate::workspace::opaque_token();
        let now = crate::workspace::now_ms();
        let expires_at = now + UI_PASS_TTL_MS;
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let member: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM memberships WHERE workspace_id=?1 AND user_id=?2)",
                params![workspace_id, user_id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if !member {
            return Err("not_member".into());
        }
        tx.execute(
            "DELETE FROM auth_sessions WHERE ui_scope=?1 AND expires_at<=?2",
            params![UI_SCOPE_SERVICE, now],
        )
        .map_err(db_err)?;
        tx.execute(
            "DELETE FROM auth_sessions WHERE ui_scope=?1 AND user_id=?2 AND service_issuer=?3 AND token_hash NOT IN \
             (SELECT token_hash FROM auth_sessions WHERE ui_scope=?1 AND user_id=?2 AND service_issuer=?3 ORDER BY created_at DESC, rowid DESC LIMIT ?4)",
            params![UI_SCOPE_SERVICE, user_id, issuer, UI_PASSES_PER_USER - 1],
        )
        .map_err(db_err)?;
        // MFA: a pass is confined to the service's own scope, so it is exempt for
        // an ordinary member; a platform admin held to a second factor gets a
        // pending pass, which `authenticate_ui_pass` never accepts.
        let pending =
            i64::from(self.admin_mfa_applies(user_id) && self.mfa_required_in(&tx, user_id));
        tx.execute(
            "INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at,label,service_issuer,service_workspace_id,ui_scope,mfa_pending) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                crate::workspace::hash_ui_pass(&token),
                user_id,
                expires_at,
                now,
                format!("service:{issuer}"),
                issuer,
                workspace_id,
                UI_SCOPE_SERVICE,
                pending
            ],
        )
        .map_err(db_err)?;
        insert_audit(
            &tx,
            workspace_id,
            &format!("service:{issuer}"),
            "auth.service_ui_token",
            "user",
            user_id,
            &json!({"by": issuer}),
        )?;
        tx.commit().map_err(db_err)?;
        Ok((token, expires_at))
    }
}

// ------------------------------------------------------------------- HTTP

#[track_caller]
fn store_error(e: String) -> Response {
    match e.as_str() {
        "no_device" => api_error(StatusCode::NOT_FOUND, "no such machine"),
        "owner_not_member" => api_error(
            StatusCode::CONFLICT,
            "the machine's owner is not a member of the workspace",
        ),
        "no_members" => api_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "none of the members exists; refusing to leave the share without a list",
        ),
        _ => store_failure(e),
    }
}

fn machine_of<'a>(key: &ServiceKey, id: &'a str) -> Result<&'a str, Response> {
    let id = id.trim();
    if id.is_empty() || !key.machine_ids.iter().any(|m| m == id) {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "that machine is not available to this key",
        ));
    }
    Ok(id)
}

fn root_of(key: &ServiceKey, root: &str) -> Result<String, Response> {
    root_under_prefix(root, &key.root_prefix)
        .map_err(|why| refusal(StatusCode::FORBIDDEN, why.to_string()))
}

fn actor_of(key: &ServiceKey) -> String {
    format!("service:{}", key.name)
}

/// `PUT /api/service/shares`
pub(crate) async fn api_service_put_share(
    State(st): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let key = match service_caller(&st, &headers) {
        Ok(k) => k,
        Err(r) => return r,
    };
    if body.len() > SERVICE_BODY_MAX {
        return api_error(StatusCode::PAYLOAD_TOO_LARGE, "body is larger than 64 KB");
    }
    let Ok(body) = serde_json::from_slice::<Value>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "body is not JSON");
    };
    let field = |name: &str| body.get(name).and_then(Value::as_str).map(str::trim);
    let machine_id = match machine_of(&key, field("machineId").unwrap_or("")) {
        Ok(m) => m.to_string(),
        Err(r) => return r,
    };
    let root = match root_of(&key, field("root").unwrap_or("")) {
        Ok(r) => r,
        Err(r) => return r,
    };
    let name = field("name").unwrap_or("");
    if name.is_empty() || name.chars().count() > 200 || name.chars().any(char::is_control) {
        return api_error(StatusCode::BAD_REQUEST, "name is required (max 200 chars)");
    }
    let Some(list) = body.get("members").and_then(Value::as_array) else {
        return api_error(StatusCode::BAD_REQUEST, "members must be a list");
    };
    if list.is_empty() || list.len() > SERVICE_MEMBERS_MAX {
        return api_error(
            StatusCode::BAD_REQUEST,
            format!("members must have 1..{SERVICE_MEMBERS_MAX} entries"),
        );
    }
    let mut members: Vec<(String, String)> = Vec::new();
    for entry in list {
        let user_id = entry
            .get("userId")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        let role = entry.get("role").and_then(Value::as_str).unwrap_or("");
        if user_id.is_empty() || user_id.len() > 64 || user_id.chars().any(char::is_control) {
            return api_error(StatusCode::BAD_REQUEST, "every member needs a userId");
        }
        if !matches!(role, "lead" | "member" | "partner") {
            return api_error(
                StatusCode::BAD_REQUEST,
                "role must be lead, member or partner",
            );
        }
        members.push((user_id.to_string(), role.to_string()));
    }
    if let Err(r) = reserve(
        &st,
        &format!("service-w:{}", key.name),
        SERVICE_WRITES_PER_HOUR,
        60 * 60 * 1000,
        "service write limit reached for this hour",
    ) {
        return r;
    }
    let outcome = match st.workspaces.service_upsert_share(
        &actor_of(&key),
        &key.workspace_id,
        &machine_id,
        &root,
        name,
        &members,
    ) {
        Ok(o) => o,
        Err(e) => return store_error(e),
    };
    // The list changed: close what people taken off it still hold open NOW —
    // enforcement must not wait for the agent's answer below, nor depend on
    // this request's future being polled to the end.
    st.hub.send(HubCmd::RefreshWorkspaceState);
    // The folder itself: made by the machine's agent, as its owner. Offline,
    // slow or refused is not an error of the share — the caller sees it in
    // `dirCreated` and can ask again.
    let relative = root
        .strip_prefix(&format!("{}/", key.root_prefix))
        .unwrap_or("")
        .to_string();
    let dir_created = make_dir(&st, &machine_id, &key.root_prefix, &relative).await;
    let _ = st.workspaces.audit(
        &key.workspace_id,
        &actor_of(&key),
        "project.service_mkdir",
        "project",
        &outcome.share_id,
        &json!({"machineId": machine_id, "root": root, "result": dir_created}),
    );
    Json(json!({
        "shareId": outcome.share_id,
        "members": outcome.members,
        "missingUsers": outcome.missing,
        "dirCreated": dir_created,
    }))
    .into_response()
}

/// `true` = the agent made (or already had) the folder, `false` = it refused
/// or failed, `null` = it is offline or did not answer within the wait.
async fn make_dir(st: &AppState, machine_id: &str, cwd: &str, path: &str) -> Value {
    if path.is_empty() {
        return Value::Null;
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    st.hub.send(HubCmd::ServiceMkdir {
        machine_id: machine_id.to_string(),
        cwd: cwd.to_string(),
        path: path.to_string(),
        reply: tx,
    });
    let answer = async {
        let pending = rx.await.ok().flatten()?;
        pending.await.ok()
    };
    match tokio::time::timeout(MKDIR_WAIT, answer).await {
        Ok(Some(ok)) => Value::Bool(ok),
        _ => Value::Null,
    }
}

/// `DELETE /api/service/shares?machineId=…&root=…`
pub(crate) async fn api_service_delete_share(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let key = match service_caller(&st, &headers) {
        Ok(k) => k,
        Err(r) => return r,
    };
    let machine_id = match machine_of(&key, params.get("machineId").map_or("", String::as_str)) {
        Ok(m) => m.to_string(),
        Err(r) => return r,
    };
    let root = match root_of(&key, params.get("root").map_or("", String::as_str)) {
        Ok(r) => r,
        Err(r) => return r,
    };
    if let Err(r) = reserve(
        &st,
        &format!("service-w:{}", key.name),
        SERVICE_WRITES_PER_HOUR,
        60 * 60 * 1000,
        "service write limit reached for this hour",
    ) {
        return r;
    }
    match st
        .workspaces
        .service_remove_share(&actor_of(&key), &key.workspace_id, &machine_id, &root)
    {
        Ok(removed) => {
            st.hub.send(HubCmd::RefreshWorkspaceState);
            Json(json!({"removed": removed})).into_response()
        }
        Err(e) => store_error(e),
    }
}

/// `GET /api/service/shares?machineId=…`
pub(crate) async fn api_service_list_shares(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let key = match service_caller(&st, &headers) {
        Ok(k) => k,
        Err(r) => return r,
    };
    let machine_id = match machine_of(&key, params.get("machineId").map_or("", String::as_str)) {
        Ok(m) => m.to_string(),
        Err(r) => return r,
    };
    if let Err(r) = reserve(
        &st,
        &format!("service-r:{}", key.name),
        SERVICE_READS_PER_MINUTE,
        60 * 1000,
        "service read limit reached for this minute",
    ) {
        return r;
    }
    match st
        .workspaces
        .service_list_shares(&key.workspace_id, &machine_id, &key.root_prefix)
    {
        Ok(shares) => Json(json!({"shares": shares})).into_response(),
        Err(e) => store_error(e),
    }
}

// ---------------------------------------------------------------- UI pass

/// `wss://host/ui` for the hub's public URL.
fn ui_ws_url(public_url: &str) -> String {
    let base = public_url.trim_end_matches('/');
    let base = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        base.to_string()
    };
    format!("{base}/ui")
}

/// `POST /api/service/ui-tokens` `{"userId":"…"}`
///
/// A 12-hour pass that opens the `/ui` WebSocket — and nothing else — from the
/// integration's own page (`uiOrigins`), for a member of the key's workspace.
/// The hub confines the connection it opens to the restricted shares under the
/// key's `rootPrefix` the person is listed on (`UiScope`). Platform
/// administrators get one like anybody else (the scope wins over their status);
/// inactive accounts get none.
pub(crate) async fn api_service_ui_token(
    State(st): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    // Every error of THIS endpoint is a machine code (`[a-z0-9_]{1,40}`) in
    // `error`, which is what the integration switches on.
    let key = match service_caller(&st, &headers) {
        Ok(k) => k,
        Err(r) => {
            return match r.status() {
                StatusCode::UNAUTHORIZED => api_error(StatusCode::UNAUTHORIZED, "unauthorized"),
                StatusCode::NOT_FOUND => api_error(StatusCode::NOT_FOUND, "not_configured"),
                _ => r,
            }
        }
    };
    if key.ui_origins.is_empty() {
        return api_error(StatusCode::FORBIDDEN, "ui_tokens_disabled");
    }
    if body.len() > SERVICE_BODY_MAX {
        return api_error(StatusCode::PAYLOAD_TOO_LARGE, "payload_too_large");
    }
    let Ok(body) = serde_json::from_slice::<Value>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "bad_request");
    };
    let user_id = body
        .get("userId")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if user_id.is_empty() || user_id.len() > 64 || user_id.chars().any(char::is_control) {
        return api_error(StatusCode::BAD_REQUEST, "bad_request");
    }
    if reserve(
        &st,
        &format!("service-ui:{}", key.name),
        SERVICE_UI_PASSES_PER_MINUTE,
        60 * 1000,
        "rate_limited",
    )
    .is_err()
    {
        return api_error(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
    }
    // A platform administrator MAY hold a pass (unlike the sign-in, which
    // issues a full session): the connection is confined to the key's fence
    // and no administrator privilege widens it.
    // Not in the key's workspace — or not a person we know at all.
    match st.workspaces.service_is_member(user_id, &key.workspace_id) {
        Ok(true) => {}
        Ok(false) => return api_error(StatusCode::BAD_REQUEST, "not_member"),
        Err(_) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, "internal"),
    }
    if require_active(&st, user_id).is_err() {
        return api_error(StatusCode::FORBIDDEN, "inactive");
    }
    let (token, expires_at) =
        match st
            .workspaces
            .mint_service_ui_pass(&key.name, user_id, &key.workspace_id)
        {
            Ok(t) => t,
            Err(e) if e == "not_member" => return api_error(StatusCode::BAD_REQUEST, "not_member"),
            Err(e) if e == "deletion_pending" => {
                return api_error(StatusCode::FORBIDDEN, "inactive")
            }
            Err(_) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        };
    // Minting may have evicted this person's oldest pass (the per-person cap):
    // the connection riding it is closed now, not at the next tick.
    st.hub.send(HubCmd::SweepUiPasses);
    println!("[auth] service UI token by {} for {user_id}", key.name);
    let mut response = Json(json!({
        "token": token,
        "expiresAt": expires_at,
        "wsUrl": ui_ws_url(&st.public_url),
        "workspaceId": key.workspace_id,
        "machineIds": key.machine_ids,
    }))
    .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

// ---------------------------------------------------------------- sign-in

#[derive(Debug, Deserialize)]
struct ServiceSigninClaims {
    sub: String,
    jti: String,
    #[allow(dead_code)]
    exp: u64,
    #[serde(default)]
    next: Option<String>,
}

/// The claims when `token` is signed by one of the entries with its own secret,
/// for its own issuer name and the service audience, and is still inside its
/// (short) window. The matching entry comes with it.
fn verify_service_signin<'a>(
    keys: &'a [ServiceKey],
    token: &str,
    now_secs: u64,
) -> Option<(&'a ServiceKey, ServiceSigninClaims)> {
    for key in keys {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.set_audience(&[SERVICE_SIGNIN_AUDIENCE]);
        validation.set_issuer(&[key.name.as_str()]);
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
        validation.leeway = 0;
        let Ok(data) = decode::<ServiceSigninClaims>(
            token,
            &DecodingKey::from_secret(key.signin_secret.as_bytes()),
            &validation,
        ) else {
            continue;
        };
        let claims = data.claims;
        if claims.exp > now_secs + SIGNIN_MAX_TTL_SECS
            || claims.sub.trim().is_empty()
            || claims.jti.trim().is_empty()
            || claims.jti.len() > 128
        {
            return None;
        }
        return Some((key, claims));
    }
    None
}

/// Where to land: a path of ours under `/w/`, nothing else. Anything that
/// could leave the origin (`//`, `\`, a scheme) or split a header falls back.
pub(crate) fn safe_next(next: Option<&str>) -> String {
    const DEFAULT: &str = "/w/";
    let Some(next) = next.map(str::trim) else {
        return DEFAULT.into();
    };
    let ok = next.starts_with("/w/")
        && next.len() <= 512
        && !next.contains('\\')
        && !next.contains("//")
        && !next.chars().any(|c| c.is_control() || c.is_whitespace());
    if ok {
        next.into()
    } else {
        DEFAULT.into()
    }
}

fn redirect(location: &str) -> Response {
    let mut response = StatusCode::FOUND.into_response();
    if let Ok(value) = HeaderValue::from_str(location) {
        response.headers_mut().insert(header::LOCATION, value);
    }
    // The token is in the URL: the page we land on must not pass it onward.
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// `GET /api/auth/service-signin?t=<JWT>`
///
/// Mints a NEW browser session only for a plain member of the key's workspace
/// (`service_signin_profile`). Anyone else — an owner, a manager, a person with
/// a machine or another team, a platform admin — is never signed in by a
/// service: if this browser already holds a valid session of the SAME user the
/// request just goes on to `next`, otherwise it goes to the normal sign-in page
/// and comes back to `next` after the person has signed in themselves.
pub(crate) async fn api_service_signin(
    Query(params): Query<HashMap<String, String>>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let Some(keys) = st.service_keys.as_ref() else {
        return api_error(StatusCode::NOT_FOUND, "service sign-in is not configured");
    };
    let Some(token) = params.get("t") else {
        return api_error(StatusCode::BAD_REQUEST, "missing token");
    };
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let Some((key, claims)) = verify_service_signin(keys, token, now_secs) else {
        return api_error(StatusCode::UNAUTHORIZED, "invalid or expired token");
    };
    let user_id = claims.sub.trim().to_string();
    if require_active(&st, &user_id).is_err() {
        return api_error(StatusCode::FORBIDDEN, "this account has no active access");
    }
    let (member, plain) = match st
        .workspaces
        .service_signin_profile(&user_id, &key.workspace_id)
    {
        Ok(p) => p,
        Err(e) => return store_failure(e),
    };
    if !member {
        return api_error(
            StatusCode::FORBIDDEN,
            "this account is not in the integration's workspace",
        );
    }
    // A platform admin is never plain: this stands where a member stands and
    // never borrows an administrator's authority.
    let plain = plain && !st.platform_admins.contains(&user_id) && st.bootstrap_user_id != user_id;
    let location = safe_next(claims.next.as_deref());
    let held = auth_cookie_token(&headers)
        .and_then(|t| st.workspaces.authenticate(&t).ok().flatten())
        .map(|(u, _)| u);
    let outcome = if plain {
        "issued"
    } else if held.as_deref() == Some(user_id.as_str()) {
        "existing_session"
    } else {
        "login_required"
    };
    let session = match st.workspaces.consume_service_signin(
        &key.name,
        &claims.jti,
        &user_id,
        &key.workspace_id,
        outcome,
        plain,
    ) {
        Ok(s) => s,
        Err(e) if e == "already_used" => {
            println!(
                "[auth] service sign-in token of {} was already used, refused",
                key.name
            );
            return api_error(StatusCode::GONE, "this token has already been used");
        }
        Err(e) if e == "not_member" => {
            return api_error(
                StatusCode::FORBIDDEN,
                "this account is not in the integration's workspace",
            )
        }
        Err(e) => return store_failure(e),
    };
    println!(
        "[auth] service sign-in by {} for {user_id}: {outcome}",
        key.name
    );
    let secure = st.public_url.starts_with("https://");
    let mut response = redirect(&location);
    match session {
        Some(session) => {
            response.headers_mut().append(
                header::SET_COOKIE,
                set_cookie_header(
                    AUTH_COOKIE,
                    &session,
                    SERVICE_SESSION_DAYS * 24 * 60 * 60,
                    secure,
                ),
            );
        }
        None if held.as_deref() != Some(user_id.as_str()) => {
            // Nobody — or somebody ELSE — is signed in here. Never go on into
            // another account: this browser's cookie is dropped (the session
            // itself is untouched) so the normal sign-in page shows, and the
            // login flow brings the person back to `next` (`finish_login`).
            if held.is_some() {
                for cleared in crate::clear_auth_cookies(secure) {
                    response.headers_mut().append(header::SET_COOKIE, cleared);
                }
            }
            response.headers_mut().append(
                header::SET_COOKIE,
                set_cookie_header(
                    crate::RETURN_COOKIE,
                    &urlencoding::encode(&location),
                    600,
                    secure,
                ),
            );
        }
        None => {}
    }
    response
}
