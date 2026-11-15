//! The sandbox provisioning queue (`provision_jobs`).
//!
//! Activation enqueues `sandbox_create`; the provisioner daemon on the sandbox
//! host dials out and claims the oldest job it can serve, heartbeats while it
//! works, posts the result. Everything here is store logic on the shared
//! SQLite connection; `provisioning_api.rs` is the HTTP surface.
//!
//! Two invariants the queue keeps:
//!
//! - **A claim is one statement.** `UPDATE … RETURNING` picks and marks the
//!   job atomically, so two hosts polling at once can never take the same
//!   one. `sandbox_create` is only handed out once the member's gateway seat
//!   is `ready` — the job carries the seat's key.
//! - **The enrollment code is minted at claim time**, never earlier: its
//!   15-minute window starts when the daemon actually holds it, and a retry
//!   gets a fresh one. Only its hash is stored, on the job.
//!
//! The unix user and machine name are `sb-<slug>`, where the slug is the
//! email's local part reduced to `[a-z0-9-]`, ≤24 chars, made unique with a
//! short hash of the user id on collision, and stored on `user_access` so it
//! never changes once assigned.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::access::{audit_workspace_in, sandbox_machine_name};
use crate::workspace::{db_err, hash_token, insert_audit, mint_enrollment, now_ms, WorkspaceStore};

pub(crate) const JOB_KINDS: [&str; 5] = [
    "sandbox_create",
    "sandbox_suspend",
    "sandbox_resume",
    "sandbox_delete",
    "sandbox_rotate_key",
];
/// Attempts before a job is left `failed` for an admin.
pub(crate) const MAX_ATTEMPTS: i64 = 3;
/// A running job whose daemon has been silent this long is presumed dead.
pub(crate) const STALE_HEARTBEAT_MS: i64 = 30 * 60 * 1000;
pub(crate) const STALE_ERR: &str = "no heartbeat from the provisioner for 30 minutes";
/// Actor recorded on audit rows the hub writes on its own behalf.
pub(crate) const SYSTEM_ACTOR: &str = "system";
/// The provisioner's `UNIX_USER_RE` is `sb-[a-z0-9-]{2,24}`.
const SLUG_MAX: usize = 24;
const ERROR_CAP: usize = 500;

pub(crate) fn is_job_kind(kind: &str) -> bool {
    JOB_KINDS.contains(&kind)
}

/// Kinds whose payload carries a freshly minted enrollment code.
fn kind_needs_enrollment(kind: &str) -> bool {
    matches!(kind, "sandbox_create" | "sandbox_resume")
}

/// The email's local part as a slug: lowercased, anything outside
/// `[a-z0-9]` becomes a dash, runs collapsed, ends trimmed, ≤24 chars.
/// `user` when nothing survives (a Cyrillic local part, say).
pub(crate) fn slug_base(email: &str) -> String {
    let local = email.split('@').next().unwrap_or("");
    let mut out = String::new();
    let mut dash = true;
    for ch in local.chars().flat_map(|c| c.to_lowercase()) {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            dash = false;
        } else if !dash {
            out.push('-');
            dash = true;
        }
    }
    let trimmed: String = out.trim_matches('-').chars().take(SLUG_MAX).collect();
    let trimmed = trimmed.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "user".to_string()
    } else {
        trimmed
    }
}

/// Candidate slugs in preference order: the bare local part, then the same
/// with 4 and 8 hex chars of `sha256(user_id)`. Deterministic per user, so a
/// retry lands on the same name.
pub(crate) fn slug_candidates(email: &str, user_id: &str) -> Vec<String> {
    let base = slug_base(email);
    let hex = hash_token(user_id);
    let suffixed = |n: usize| {
        let head: String = base.chars().take(SLUG_MAX - n - 1).collect();
        format!("{}-{}", head.trim_end_matches('-'), &hex[..n])
    };
    let mut out = Vec::with_capacity(4);
    // `user-<hex>` is reserved for the hashed names of accounts without an
    // address: an email whose local part is `user-ab12` must not take that
    // name bare and squat the one a Telegram-only account will need.
    if base.chars().count() >= 2 && !base.starts_with("user-") {
        out.push(base.clone());
    }
    out.push(suffixed(4));
    out.push(suffixed(8));
    out.push(suffixed(16));
    out
}

/// The stored slug, or the first free candidate — assigned and returned.
/// `email` is only the source of a readable name (its local part). An
/// account without one (Telegram-only) gets `user-<hash>` — the candidates
/// already fall back to a hash of the user id when the base is too short.
fn ensure_slug_in(conn: &Connection, user_id: &str, email: Option<&str>) -> Result<String, String> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT sandbox_slug FROM user_access WHERE user_id=?1",
            params![user_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_err)?
        .flatten();
    if let Some(slug) = existing {
        return Ok(slug);
    }
    let candidates = match email {
        Some(email) => slug_candidates(email, user_id),
        // No address to name it after: never the bare word, always
        // `user-<hash>`, so the first such account does not own `sb-user`.
        None => slug_candidates("user", user_id)
            .into_iter()
            .skip(1)
            .collect(),
    };
    for candidate in candidates {
        let taken: bool = conn
            .query_row(
                // Retired: a deleted account's home may still sit on the host
                // under this name, and the provisioner would adopt it.
                "SELECT EXISTS(SELECT 1 FROM user_access WHERE sandbox_slug=?1 AND user_id<>?2) \
                 OR EXISTS(SELECT 1 FROM retired_sandbox_slugs WHERE slug=?1)",
                params![candidate, user_id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if taken {
            continue;
        }
        let changed = conn
            .execute(
                "UPDATE user_access SET sandbox_slug=?2,updated_at=?3 WHERE user_id=?1",
                params![user_id, candidate, now_ms()],
            )
            .map_err(db_err)?;
        if changed == 0 {
            return Err("not_found".into());
        }
        return Ok(candidate);
    }
    Err(format!(
        "no free sandbox slug for {}",
        email.unwrap_or(user_id)
    ))
}

/// Where a job may run: `sandbox_create` anywhere (`NULL`), everything else
/// on the host that holds the sandbox.
fn host_pin(conn: &Connection, user_id: &str, kind: &str) -> Result<Option<String>, String> {
    if kind == "sandbox_create" {
        return Ok(None);
    }
    conn.query_row(
        "SELECT sandbox_host FROM user_access WHERE user_id=?1",
        params![user_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(db_err)
    .map(Option::flatten)
}

fn cap_error(stage: &str, error: &str) -> String {
    let text = if stage.is_empty() || stage == "unknown" {
        error.to_string()
    } else {
        format!("{stage}: {error}")
    };
    text.chars()
        .filter(|c| !c.is_control())
        .take(ERROR_CAP)
        .collect()
}

/// A job handed to the provisioner, with everything the claim minted.
#[derive(Clone, Debug)]
pub struct ClaimedJob {
    pub job_id: String,
    pub user_id: String,
    pub kind: String,
    pub attempts: i64,
    /// Absent for an account without an address (Telegram-only).
    pub email: Option<String>,
    pub full_name: Option<String>,
    pub slug: String,
    /// A machine id the hub already knows for this sandbox (a retry after a
    /// partial run), so the provisioner can pin it instead of registering a
    /// second device.
    pub machine_id: Option<String>,
    /// `(code, expires_at_ms)` for `sandbox_create` / `sandbox_resume`.
    pub enrollment: Option<(String, i64)>,
}

/// What the provisioner reported.
#[derive(Clone, Debug)]
pub enum JobResult {
    Ok {
        machine_id: Option<String>,
        archive: Option<String>,
    },
    Failed {
        stage: String,
        error: String,
        retryable: bool,
    },
}

/// The job after a result was applied, for logs and the HTTP answer.
#[derive(Clone, Debug)]
pub struct JobOutcome {
    pub job_id: String,
    pub user_id: String,
    pub email: Option<String>,
    pub kind: String,
    /// `done` | `failed` | `queued` (requeued for another attempt).
    pub status: String,
    pub host: Option<String>,
    pub attempts: i64,
    pub machine_id: Option<String>,
    pub error: Option<String>,
}

impl WorkspaceStore {
    /// Queue a job for a user. Deduplicated: an existing `queued`/`running`
    /// job of the same kind is returned instead (`created == false`).
    /// `sandbox_create` also assigns the slug and marks the sandbox `queued`.
    pub fn enqueue_job(&self, user_id: &str, kind: &str) -> Result<(String, bool), String> {
        if !is_job_kind(kind) {
            return Err(format!("unknown job kind {kind}"));
        }
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let deleting: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM account_deletions WHERE user_id=?1)",
                [user_id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if deleting {
            return Err("account deletion in progress".into());
        }
        let email: Option<String> = tx
            .query_row(
                "SELECT u.email FROM users u JOIN user_access a ON a.user_id=u.user_id WHERE u.user_id=?1",
                params![user_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?
            .ok_or("not_found")?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT job_id FROM provision_jobs WHERE user_id=?1 AND kind=?2 AND status IN ('queued','running') ORDER BY created_at ASC LIMIT 1",
                params![user_id, kind],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        if let Some(job_id) = existing {
            return Ok((job_id, false));
        }
        let job_id = Uuid::new_v4().to_string();
        let host = host_pin(&tx, user_id, kind)?;
        tx.execute(
            "INSERT INTO provision_jobs(job_id,user_id,kind,status,host,attempts,max_attempts,created_at) VALUES(?1,?2,?3,'queued',?4,0,?5,?6)",
            params![job_id, user_id, kind, host, MAX_ATTEMPTS, now],
        )
        .map_err(db_err)?;
        if kind == "sandbox_create" {
            ensure_slug_in(&tx, user_id, email.as_deref())?;
            tx.execute(
                "UPDATE user_access SET sandbox_status='queued',sandbox_error=NULL,updated_at=?2 WHERE user_id=?1",
                params![user_id, now],
            )
            .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        Ok((job_id, true))
    }

    /// The oldest job this host may run, marked running in the same
    /// statement. `sandbox_create` waits for an ACTIVE user; pinned jobs wait
    /// for their host. Mints the enrollment code where the kind needs one.
    /// `None` when there is nothing to do.
    ///
    /// It used to wait for `seat_status='ready'` as well, because the job
    /// carried the member's gateway key. Activation no longer mints a seat
    /// (see `after_activate_hooks`), so that condition would hold every new
    /// member's sandbox in the queue for ever. A sandbox now arrives without a
    /// model provider configured and the member signs into their own Codex
    /// inside it.
    pub fn claim_job(&self, host: &str) -> Result<Option<ClaimedJob>, String> {
        self.claim_job_filtered(host, false)
    }

    pub fn claim_erasure_job(&self, host: &str) -> Result<Option<ClaimedJob>, String> {
        self.claim_job_filtered(host, true)
    }

    fn claim_job_filtered(
        &self,
        host: &str,
        erasure_only: bool,
    ) -> Result<Option<ClaimedJob>, String> {
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.execute(
            "INSERT OR IGNORE INTO sandbox_hosts(host) VALUES(?1)",
            [host],
        )
        .map_err(db_err)?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let picked: Option<(String, String, String, i64)> = tx
            .query_row(
                "UPDATE provision_jobs SET status='running',host=?1,claimed_at=?2,heartbeat_at=?2,attempts=attempts+1 \
                 WHERE job_id=(SELECT j.job_id FROM provision_jobs j JOIN user_access a ON a.user_id=j.user_id \
                   WHERE j.status='queued' AND (j.host IS NULL OR j.host=?1) AND (?3=0 OR EXISTS(SELECT 1 FROM sandbox_erasures e WHERE e.job_id=j.job_id)) \
                   AND (j.kind<>'sandbox_create' OR a.state='active') \
                   ORDER BY j.created_at ASC LIMIT 1) \
                 RETURNING job_id,user_id,kind,attempts",
                params![host, now, erasure_only],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(db_err)?;
        let Some((job_id, user_id, kind, attempts)) = picked else {
            return Ok(None);
        };
        let (email, full_name): (Option<String>, Option<String>) = tx
            .query_row(
                "SELECT email,full_name FROM users WHERE user_id=?1",
                params![user_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(db_err)?;
        let slug = ensure_slug_in(&tx, &user_id, email.as_deref())?;
        let machine_id: Option<String> = tx
            .query_row(
                "SELECT COALESCE(a.sandbox_machine_id, j.machine_id, \
                   (SELECT d.machine_id FROM devices d WHERE d.owner_user_id=a.user_id AND d.kind='sandbox' AND d.name=?2 AND d.revoked_at IS NULL LIMIT 1)) \
                 FROM user_access a JOIN provision_jobs j ON j.user_id=a.user_id WHERE a.user_id=?1 AND j.job_id=?3",
                params![user_id, sandbox_machine_name(&slug), job_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?
            .flatten();
        let enrollment = if kind_needs_enrollment(&kind) {
            let minted = mint_enrollment(&tx, &user_id, "sandbox")?;
            let code = minted["code"].as_str().unwrap_or_default().to_string();
            let expires_at = minted["expiresAt"].as_i64().unwrap_or(now + 15 * 60 * 1000);
            tx.execute(
                "UPDATE provision_jobs SET enrollment_code_hash=?2 WHERE job_id=?1",
                params![job_id, hash_token(&code)],
            )
            .map_err(db_err)?;
            Some((code, expires_at))
        } else {
            None
        };
        tx.commit().map_err(db_err)?;
        Ok(Some(ClaimedJob {
            job_id,
            user_id,
            kind,
            attempts,
            email,
            full_name,
            slug,
            machine_id,
            enrollment,
        }))
    }

    /// Hand a just-claimed job back untouched — the HTTP layer could not
    /// complete the payload (the gateway did not answer for the seat). The
    /// attempt is not charged.
    pub fn unclaim_job(&self, job_id: &str) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.execute(
            "UPDATE provision_jobs SET status='queued',attempts=MAX(attempts-1,0),claimed_at=NULL,heartbeat_at=NULL,enrollment_code_hash=NULL, \
             host=CASE WHEN EXISTS(SELECT 1 FROM account_deletions WHERE user_id=provision_jobs.user_id) THEN host WHEN kind='sandbox_create' THEN NULL ELSE (SELECT sandbox_host FROM user_access WHERE user_id=provision_jobs.user_id) END \
             WHERE job_id=?1 AND status='running'",
            params![job_id],
        )
        .map_err(db_err)?;
        Ok(())
    }

    /// `true` when the job is running and its heartbeat was refreshed.
    pub fn heartbeat_job(&self, job_id: &str) -> Result<bool, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let changed = conn
            .execute(
                "UPDATE provision_jobs SET heartbeat_at=?2 WHERE job_id=?1 AND status='running'",
                params![job_id, now_ms()],
            )
            .map_err(db_err)?;
        Ok(changed > 0)
    }

    /// Apply the provisioner's result: the job's final (or next) state, the
    /// user's `sandbox_*` columns, the audit row, and for a delete the device
    /// revocation — one transaction. A failure goes back to `queued` while
    /// `retryable` and attempts remain, else `failed`.
    pub fn apply_job_result(&self, job_id: &str, result: &JobResult) -> Result<JobOutcome, String> {
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        type Row = (
            String,
            String,
            String,
            Option<String>,
            i64,
            i64,
            Option<String>,
            Option<String>,
        );
        let (user_id, kind, status, host, attempts, max_attempts, job_machine, email): Row = tx
            .query_row(
                "SELECT j.user_id,j.kind,j.status,j.host,j.attempts,j.max_attempts,j.machine_id,u.email \
                 FROM provision_jobs j JOIN users u ON u.user_id=j.user_id WHERE j.job_id=?1",
                params![job_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                    ))
                },
            )
            .optional()
            .map_err(db_err)?
            .ok_or("not_found")?;
        if !matches!(status.as_str(), "running" | "queued") {
            return Err("job is not running".into());
        }
        let audit_ws = audit_workspace_in(&tx, &user_id)?;
        let audit = |action: &str, meta: &Value| -> Result<(), String> {
            match &audit_ws {
                Some(ws) => insert_audit(&tx, ws, SYSTEM_ACTOR, action, "user", &user_id, meta),
                None => Ok(()),
            }
        };
        let current_machine: Option<String> = tx
            .query_row(
                "SELECT sandbox_machine_id FROM user_access WHERE user_id=?1",
                params![user_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?
            .flatten();

        let outcome = match result {
            JobResult::Ok {
                machine_id,
                archive,
            } => {
                let machine_id = machine_id
                    .clone()
                    .or(current_machine.clone())
                    .or(job_machine.clone());
                tx.execute(
                    "UPDATE provision_jobs SET status='done',finished_at=?2,machine_id=COALESCE(?3,machine_id),error=NULL WHERE job_id=?1",
                    params![job_id, now, machine_id],
                )
                .map_err(db_err)?;
                match kind.as_str() {
                    "sandbox_create" => {
                        tx.execute(
                            "UPDATE user_access SET sandbox_status='ready',sandbox_machine_id=COALESCE(?2,sandbox_machine_id),sandbox_host=?3,sandbox_error=NULL,updated_at=?4 WHERE user_id=?1",
                            params![user_id, machine_id, host, now],
                        )
                        .map_err(db_err)?;
                        audit(
                            "sandbox.ready",
                            &json!({"machineId": machine_id, "host": host}),
                        )?;
                    }
                    "sandbox_suspend" => {
                        tx.execute(
                            "UPDATE user_access SET sandbox_status='suspended',sandbox_error=NULL,updated_at=?2 WHERE user_id=?1",
                            params![user_id, now],
                        )
                        .map_err(db_err)?;
                        audit(
                            "sandbox.suspended",
                            &json!({"machineId": machine_id, "host": host}),
                        )?;
                    }
                    "sandbox_resume" => {
                        tx.execute(
                            "UPDATE user_access SET sandbox_status='ready',sandbox_error=NULL,updated_at=?2 WHERE user_id=?1",
                            params![user_id, now],
                        )
                        .map_err(db_err)?;
                        audit(
                            "sandbox.resumed",
                            &json!({"machineId": machine_id, "host": host}),
                        )?;
                    }
                    "sandbox_delete" => {
                        tx.execute(
                            "UPDATE user_access SET sandbox_status='none',sandbox_machine_id=NULL,sandbox_host=NULL,sandbox_error=NULL,updated_at=?2 WHERE user_id=?1",
                            params![user_id, now],
                        )
                        .map_err(db_err)?;
                        if let Some(machine) = &machine_id {
                            // The same two writes `revoke_device` does, minus
                            // its lock: the device is gone with the home dir.
                            tx.execute(
                                "UPDATE devices SET revoked_at=?2 WHERE machine_id=?1 AND revoked_at IS NULL",
                                params![machine, now],
                            )
                            .map_err(db_err)?;
                            tx.execute(
                                "UPDATE device_credentials SET revoked_at=?2 WHERE machine_id=?1 AND revoked_at IS NULL",
                                params![machine, now],
                            )
                            .map_err(db_err)?;
                        }
                        audit(
                            "sandbox.deleted",
                            &json!({"machineId": machine_id, "host": host, "archive": archive}),
                        )?;
                    }
                    _ => {
                        audit(
                            "sandbox.key_rotated",
                            &json!({"machineId": machine_id, "host": host}),
                        )?;
                    }
                }
                JobOutcome {
                    job_id: job_id.to_string(),
                    user_id: user_id.clone(),
                    email,
                    kind,
                    status: "done".into(),
                    host,
                    attempts,
                    machine_id,
                    error: None,
                }
            }
            JobResult::Failed {
                stage,
                error,
                retryable,
            } => {
                let message = cap_error(stage, error);
                let deleting: bool = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM account_deletions WHERE user_id=?1)",
                        [&user_id],
                        |r| r.get(0),
                    )
                    .map_err(db_err)?;
                let requeue = *retryable
                    && attempts < max_attempts
                    && (!deleting || kind == "sandbox_delete");
                if requeue {
                    let pin = if deleting {
                        host.clone()
                    } else {
                        host_pin(&tx, &user_id, &kind)?
                    };
                    tx.execute(
                        "UPDATE provision_jobs SET status='queued',host=?2,claimed_at=NULL,heartbeat_at=NULL,enrollment_code_hash=NULL,error=?3 WHERE job_id=?1",
                        params![job_id, pin, message],
                    )
                    .map_err(db_err)?;
                    JobOutcome {
                        job_id: job_id.to_string(),
                        user_id: user_id.clone(),
                        email,
                        kind,
                        status: "queued".into(),
                        host: pin,
                        attempts,
                        machine_id: current_machine,
                        error: Some(message),
                    }
                } else {
                    tx.execute(
                        "UPDATE provision_jobs SET status='failed',finished_at=?2,error=?3 WHERE job_id=?1",
                        params![job_id, now, message],
                    )
                    .map_err(db_err)?;
                    tx.execute(
                        "UPDATE user_access SET sandbox_status='failed',sandbox_error=?2,updated_at=?3 WHERE user_id=?1",
                        params![user_id, message, now],
                    )
                    .map_err(db_err)?;
                    audit(
                        "sandbox.failed",
                        &json!({"kind": kind, "stage": stage, "error": message, "attempts": attempts, "host": host}),
                    )?;
                    JobOutcome {
                        job_id: job_id.to_string(),
                        user_id: user_id.clone(),
                        email,
                        kind,
                        status: "failed".into(),
                        host,
                        attempts,
                        machine_id: current_machine,
                        error: Some(message),
                    }
                }
            }
        };
        tx.commit().map_err(db_err)?;
        Ok(outcome)
    }

    /// Running jobs whose daemon went silent: requeued or failed by the same
    /// rule as a reported failure. The reconciler calls this every minute.
    pub fn requeue_stale_jobs(&self) -> Result<Vec<JobOutcome>, String> {
        let stale: Vec<String> = {
            let conn = self
                .conn
                .lock()
                .map_err(|_| "workspace database lock poisoned".to_string())?;
            let mut stmt = conn
                .prepare(
                    "SELECT job_id FROM provision_jobs WHERE status='running' AND COALESCE(heartbeat_at,claimed_at,0)<?1",
                )
                .map_err(db_err)?;
            let rows = stmt
                .query_map(params![now_ms() - STALE_HEARTBEAT_MS], |r| {
                    r.get::<_, String>(0)
                })
                .map_err(db_err)?
                .filter_map(Result::ok)
                .collect();
            rows
        };
        let mut out = Vec::with_capacity(stale.len());
        for job_id in stale {
            let result = JobResult::Failed {
                stage: "heartbeat".into(),
                error: STALE_ERR.into(),
                retryable: true,
            };
            out.push(self.apply_job_result(&job_id, &result)?);
        }
        Ok(out)
    }

    /// Admin retry: a failed job goes back to the queue with a full set of
    /// attempts. `false` when the job is not in `failed`.
    pub fn retry_job(&self, job_id: &str) -> Result<bool, String> {
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let row: Option<(String, String)> = tx
            .query_row(
                "SELECT user_id,kind FROM provision_jobs WHERE job_id=?1 AND status='failed'",
                params![job_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(db_err)?;
        let Some((user_id, kind)) = row else {
            return Ok(false);
        };
        let deleting: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM account_deletions WHERE user_id=?1)",
                [&user_id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if deleting && kind != "sandbox_delete" {
            return Err("account deletion in progress".into());
        }
        let erased_host: Option<String> = tx
            .query_row(
                "SELECT host FROM sandbox_erasures WHERE job_id=?1",
                [job_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        let pin = if erased_host.is_some() {
            erased_host
        } else {
            host_pin(&tx, &user_id, &kind)?
        };
        tx.execute(
            "UPDATE provision_jobs SET status='queued',attempts=0,host=?2,claimed_at=NULL,heartbeat_at=NULL,finished_at=NULL,enrollment_code_hash=NULL WHERE job_id=?1",
            params![job_id, pin],
        )
        .map_err(db_err)?;
        if kind == "sandbox_create" {
            tx.execute(
                "UPDATE user_access SET sandbox_status='queued',sandbox_error=NULL,updated_at=?2 WHERE user_id=?1",
                params![user_id, now],
            )
            .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        Ok(true)
    }

    /// Jobs in `ProvisionJob` shape, newest first. `status=None` lists all.
    pub fn provision_jobs(&self, status: Option<&str>, limit: usize) -> Result<Vec<Value>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT j.job_id,j.user_id,u.email,j.kind,j.status,j.host,j.attempts,j.machine_id,j.error,j.created_at,j.claimed_at,j.finished_at \
                 FROM provision_jobs j LEFT JOIN users u ON u.user_id=j.user_id \
                 WHERE (?1 IS NULL OR j.status=?1) ORDER BY j.created_at DESC LIMIT ?2",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![status, limit as i64], |r| {
                let mut v = json!({
                    "jobId": r.get::<_, String>(0)?,
                    "userId": r.get::<_, String>(1)?,
                    "kind": r.get::<_, String>(3)?,
                    "status": r.get::<_, String>(4)?,
                    "attempts": r.get::<_, i64>(6)?,
                    "createdAt": r.get::<_, i64>(9)?,
                });
                if let Some(email) = r.get::<_, Option<String>>(2)? {
                    v["email"] = Value::String(email);
                }
                if let Some(host) = r.get::<_, Option<String>>(5)? {
                    v["host"] = Value::String(host);
                }
                if let Some(machine) = r.get::<_, Option<String>>(7)? {
                    v["machineId"] = Value::String(machine);
                }
                if let Some(error) = r.get::<_, Option<String>>(8)? {
                    v["error"] = Value::String(error);
                }
                if let Some(at) = r.get::<_, Option<i64>>(10)? {
                    v["claimedAt"] = json!(at);
                }
                if let Some(at) = r.get::<_, Option<i64>>(11)? {
                    v["finishedAt"] = json!(at);
                }
                Ok(v)
            })
            .map_err(db_err)?
            .filter_map(Result::ok)
            .collect();
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::WorkspaceStore;

    fn job_status(s: &WorkspaceStore, job_id: &str) -> (String, i64, Option<String>) {
        s.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT status,attempts,host FROM provision_jobs WHERE job_id=?1",
                params![job_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap()
    }

    fn audit_rows(s: &WorkspaceStore, action: &str, target: &str) -> Vec<Value> {
        let conn = s.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT metadata_json FROM audit_events WHERE action=?1 AND target_id=?2")
            .unwrap();
        stmt.query_map(params![action, target], |r| r.get::<_, String>(0))
            .unwrap()
            .filter_map(Result::ok)
            .map(|m| serde_json::from_str(&m).unwrap())
            .collect()
    }

    /// An activated community member with a ready seat.
    fn ready_user(s: &WorkspaceStore, id: &str, email: &str) {
        s.ensure_user(id, email, Some("Anna")).unwrap();
        s.activate_access(id, "admin").unwrap();
        s.set_seat_status(id, "ready", None).unwrap();
    }

    #[test]
    fn slug_is_stable_and_collision_safe() {
        assert_eq!(slug_base("Anna.Ivanova@example.com"), "anna-ivanova");
        assert_eq!(slug_base("anna_ivanova+cc@x"), "anna-ivanova-cc");
        assert_eq!(slug_base("--weird..name--@x"), "weird-name");
        assert_eq!(slug_base("иван@x"), "user");
        assert!(slug_base(&format!("{}@x", "a".repeat(40))).len() <= 24);
        let cands = slug_candidates("a@x", "u1");
        assert_eq!(
            cands.len(),
            3,
            "a one-char local part needs a suffix to reach 2 chars"
        );
        assert!(cands[0].starts_with("a-") && cands[0].len() == 6);
        for c in slug_candidates(&format!("{}@x", "b".repeat(40)), "u1") {
            assert!(c.len() <= 24, "{c}");
            assert!(c
                .chars()
                .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-'));
        }

        // The slug is assigned when the first create is queued and kept from
        // then on; the second holder of a local part gets the hashed suffix.
        let s = WorkspaceStore::open_memory();
        s.ensure_user("u1", "Anna.Ivanova@example.com", None)
            .unwrap();
        s.ensure_user("u2", "anna_ivanova@other.io", None).unwrap();
        let slug_of = |s: &WorkspaceStore, u: &str| s.access_state(u).unwrap().sandbox_slug;
        s.enqueue_job("u1", "sandbox_create").unwrap();
        assert_eq!(slug_of(&s, "u1").as_deref(), Some("anna-ivanova"));
        s.enqueue_job("u2", "sandbox_create").unwrap();
        let second = slug_of(&s, "u2").unwrap();
        assert!(
            second.starts_with("anna-ivanova-") && second.len() == "anna-ivanova-".len() + 4,
            "{second}"
        );
        assert_eq!(
            second,
            slug_candidates("anna_ivanova@other.io", "u2")[1],
            "deterministic suffix"
        );
        // Stable: a later claim (and a changed email) keeps the stored slug.
        s.ensure_user("u1", "anna.ivanova@example.com", Some("Renamed"))
            .unwrap();
        s.set_seat_status("u1", "ready", None).unwrap();
        s.activate_access("u1", "admin").unwrap();
        assert_eq!(s.claim_job("stage").unwrap().unwrap().slug, "anna-ivanova");
        assert_eq!(slug_of(&s, "u2").unwrap(), second);
        // The viewer names the machine from the slug before it exists.
        let access = s.access_state("u2").unwrap();
        let v = s.viewer_access_json(&access).unwrap();
        assert_eq!(v["sandbox"]["machineName"], format!("sb-{second}"));
        assert_eq!(v["sandbox"]["status"], "queued");
        assert!(v["sandbox"].get("machineId").is_none());
    }

    #[test]
    fn claim_is_atomic_and_mints_a_fresh_code() {
        let s = WorkspaceStore::open_memory();
        ready_user(&s, "u", "anna@x");
        let (job_id, created) = s.enqueue_job("u", "sandbox_create").unwrap();
        assert!(created);
        assert_eq!(
            s.enqueue_job("u", "sandbox_create").unwrap(),
            (job_id.clone(), false),
            "deduplicated while queued"
        );
        assert_eq!(s.access_state("u").unwrap().sandbox_status, "queued");
        assert_eq!(
            s.access_state("u").unwrap().sandbox_slug.as_deref(),
            Some("anna")
        );

        let claimed = s.claim_job("stage").unwrap().expect("a job");
        assert_eq!(claimed.job_id, job_id);
        assert_eq!(claimed.kind, "sandbox_create");
        assert_eq!(claimed.attempts, 1);
        assert_eq!(claimed.slug, "anna");
        assert_eq!(claimed.email.as_deref(), Some("anna@x"));
        assert_eq!(claimed.full_name.as_deref(), Some("Anna"));
        assert!(claimed.machine_id.is_none());
        let (code, expires) = claimed.enrollment.clone().expect("a code");
        assert!(expires > now_ms());
        // The same job cannot be claimed twice, from this host or another.
        assert!(s.claim_job("stage").unwrap().is_none());
        assert!(s.claim_job("other-host").unwrap().is_none());
        assert_eq!(
            job_status(&s, &job_id),
            ("running".into(), 1, Some("stage".into()))
        );
        assert!(
            !s.enqueue_job("u", "sandbox_create").unwrap().1,
            "deduplicated while running"
        );
        // The code is a real sandbox enrollment: the agent exchanges it and
        // the device comes out marked `sandbox`, owned by the member.
        let device = s
            .exchange_enrollment(
                &code,
                &json!({"machineId":"m-1","name":"sb-anna","os":"linux","agentVersion":"1"}),
            )
            .unwrap();
        assert_eq!(device["kind"], "sandbox");
        assert_eq!(device["ownerUserId"], "u");
        // Only the hash is on the job.
        let stored: Option<String> = s
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT enrollment_code_hash FROM provision_jobs WHERE job_id=?1",
                params![job_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored.as_deref(), Some(hash_token(&code).as_str()));
        // A retry claims with a NEW code and now knows the machine id.
        s.apply_job_result(
            &job_id,
            &JobResult::Failed {
                stage: "enroll".into(),
                error: "timeout".into(),
                retryable: true,
            },
        )
        .unwrap();
        let again = s.claim_job("stage").unwrap().expect("requeued job");
        assert_eq!(again.job_id, job_id);
        assert_eq!(again.attempts, 2);
        assert_ne!(
            again.enrollment.unwrap().0,
            code,
            "a retry never reuses a code"
        );
        assert_eq!(
            again.machine_id.as_deref(),
            Some("m-1"),
            "the enrolled device is pinned on the retry"
        );
    }

    #[test]
    fn an_email_cannot_take_a_reserved_hashed_name_bare() {
        let squatter = slug_candidates("user-ab12@x", "someone");
        assert!(!squatter.contains(&"user-ab12".to_string()), "{squatter:?}");
        // None of an email's candidates may look like a reserved hashed
        // name, `user-` followed by hex only.
        let reserved = |c: &String| {
            c.strip_prefix("user-").is_some_and(|rest| {
                !rest.is_empty() && rest.chars().all(|ch| ch.is_ascii_hexdigit())
            })
        };
        assert!(!squatter.iter().any(reserved), "{squatter:?}");
        assert_eq!(
            slug_candidates("anna@x", "u").len(),
            4,
            "base + three hashed"
        );
    }

    #[test]
    fn an_account_without_email_gets_a_hashed_sandbox_and_no_address_in_the_job() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("tg-9", "tg-9@placeholder", Some("Telegram Person"))
            .unwrap();
        s.with_conn_for_tests(|c| {
            c.execute("UPDATE users SET email=NULL WHERE user_id='tg-9'", [])
                .unwrap();
        });
        s.activate_access("tg-9", "admin").unwrap();
        s.enqueue_job("tg-9", "sandbox_create").unwrap();
        let claimed = s.claim_job("stage").unwrap().expect("claimed");
        assert_eq!(claimed.email, None);
        assert_eq!(claimed.full_name.as_deref(), Some("Telegram Person"));
        assert!(claimed.slug.starts_with("user-"), "slug {}", claimed.slug);
        let listed = s.provision_jobs(None, 10).unwrap();
        assert!(listed[0].get("email").is_none());
    }

    /// A sandbox no longer waits on a gateway seat — activation stopped minting
    /// one, so waiting would hold every new member's machine in the queue for
    /// ever. It still waits on the ACCOUNT being active, which is the part that
    /// was always about permission rather than about carrying a key.
    #[test]
    fn claim_waits_for_an_active_account_not_for_a_seat() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("u", "u@x", None).unwrap();
        s.activate_access("u", "admin").unwrap();
        // No seat at all: the normal state for someone activated from now on.
        s.enqueue_job("u", "sandbox_create").unwrap();
        let claimed = s
            .claim_job("stage")
            .unwrap()
            .expect("a sandbox without a seat is still built");
        assert_eq!(
            (claimed.user_id.as_str(), claimed.kind.as_str()),
            ("u", "sandbox_create")
        );
        // A failed seat left over from the old flow does not block it either.
        s.ensure_user("v", "v@x", None).unwrap();
        s.activate_access("v", "admin").unwrap();
        s.set_seat_status("v", "failed", Some("boom")).unwrap();
        s.enqueue_job("v", "sandbox_create").unwrap();
        let claimed = s.claim_job("stage").unwrap().unwrap();
        assert_eq!(claimed.user_id.as_str(), "v");
        // A suspended user's create waits even with a ready seat.
        s.ensure_user("w", "w@x", None).unwrap();
        s.activate_access("w", "admin").unwrap();
        s.set_seat_status("w", "ready", None).unwrap();
        s.enqueue_job("w", "sandbox_create").unwrap();
        s.suspend_access("w", "admin", None).unwrap();
        assert!(s.claim_job("stage").unwrap().is_none());
        // Pinned jobs wait for their host.
        s.conn
            .lock()
            .unwrap()
            .execute("UPDATE user_access SET sandbox_host='stage',sandbox_status='ready' WHERE user_id='v'", [])
            .unwrap();
        s.enqueue_job("v", "sandbox_rotate_key").unwrap();
        assert!(
            s.claim_job("sb1").unwrap().is_none(),
            "another host cannot take a pinned job"
        );
        assert_eq!(
            s.claim_job("stage").unwrap().unwrap().kind,
            "sandbox_rotate_key"
        );
    }

    #[test]
    fn result_ok_marks_the_sandbox_ready_and_audits() {
        let s = WorkspaceStore::open_memory();
        ready_user(&s, "u", "anna@x");
        let (job_id, _) = s.enqueue_job("u", "sandbox_create").unwrap();
        let claimed = s.claim_job("stage").unwrap().unwrap();
        assert!(s.heartbeat_job(&job_id).unwrap());
        let outcome = s
            .apply_job_result(
                &job_id,
                &JobResult::Ok {
                    machine_id: Some("m-1".into()),
                    archive: None,
                },
            )
            .unwrap();
        assert_eq!(outcome.status, "done");
        assert_eq!(outcome.machine_id.as_deref(), Some("m-1"));
        assert_eq!(outcome.host.as_deref(), Some("stage"));
        assert_eq!(job_status(&s, &job_id).0, "done");
        let access = s.access_state("u").unwrap();
        assert_eq!(access.sandbox_status, "ready");
        assert_eq!(access.sandbox_machine_id.as_deref(), Some("m-1"));
        assert_eq!(access.sandbox_host.as_deref(), Some("stage"));
        assert!(access.sandbox_error.is_none());
        let rows = audit_rows(&s, "sandbox.ready", "u");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["machineId"], "m-1");
        assert_eq!(rows[0]["host"], "stage");
        let viewer = s.viewer_access_json(&access).unwrap();
        assert_eq!(viewer["sandbox"]["status"], "ready");
        assert_eq!(viewer["sandbox"]["machineId"], "m-1");
        assert_eq!(
            viewer["sandbox"]["machineName"],
            format!("sb-{}", claimed.slug)
        );
        // A finished job neither heartbeats nor takes a second result.
        assert!(!s.heartbeat_job(&job_id).unwrap());
        assert_eq!(
            s.apply_job_result(
                &job_id,
                &JobResult::Ok {
                    machine_id: None,
                    archive: None
                }
            )
            .unwrap_err(),
            "job is not running"
        );
        // Suspend / resume flip the status; the follow-up jobs are pinned to the host.
        let (suspend, _) = s.enqueue_job("u", "sandbox_suspend").unwrap();
        assert_eq!(job_status(&s, &suspend).2.as_deref(), Some("stage"));
        s.claim_job("stage").unwrap().unwrap();
        s.apply_job_result(
            &suspend,
            &JobResult::Ok {
                machine_id: None,
                archive: None,
            },
        )
        .unwrap();
        assert_eq!(s.access_state("u").unwrap().sandbox_status, "suspended");
        let (resume, _) = s.enqueue_job("u", "sandbox_resume").unwrap();
        assert!(s.claim_job("stage").unwrap().unwrap().enrollment.is_some());
        s.apply_job_result(
            &resume,
            &JobResult::Ok {
                machine_id: None,
                archive: None,
            },
        )
        .unwrap();
        assert_eq!(s.access_state("u").unwrap().sandbox_status, "ready");
        // Delete clears the machine and revokes its device.
        s.exchange_enrollment(
            s.create_enrollment_for("u", "sandbox").unwrap()["code"]
                .as_str()
                .unwrap(),
            &json!({"machineId":"m-1","name":"sb-anna","os":"linux","agentVersion":"1"}),
        )
        .unwrap();
        let (delete, _) = s.enqueue_job("u", "sandbox_delete").unwrap();
        s.claim_job("stage").unwrap().unwrap();
        let out = s
            .apply_job_result(
                &delete,
                &JobResult::Ok {
                    machine_id: None,
                    archive: Some("/var/backups/sandboxes/sb-anna.tgz".into()),
                },
            )
            .unwrap();
        assert_eq!(out.machine_id.as_deref(), Some("m-1"));
        let after = s.access_state("u").unwrap();
        assert_eq!(after.sandbox_status, "none");
        assert!(after.sandbox_machine_id.is_none() && after.sandbox_host.is_none());
        assert!(s.device_revoked("m-1").unwrap());
        assert_eq!(
            audit_rows(&s, "sandbox.deleted", "u")[0]["archive"],
            "/var/backups/sandboxes/sb-anna.tgz"
        );
        let listed = s.provision_jobs(Some("done"), 50).unwrap();
        assert_eq!(listed.len(), 4);
        assert_eq!(listed[0]["email"], "anna@x");
        assert!(listed.iter().all(|j| j.get("error").is_none()));
    }

    #[test]
    fn a_failed_job_requeues_until_max_attempts() {
        let s = WorkspaceStore::open_memory();
        ready_user(&s, "u", "anna@x");
        let (job_id, _) = s.enqueue_job("u", "sandbox_create").unwrap();
        let fail = |s: &WorkspaceStore, retryable: bool| {
            s.apply_job_result(
                &job_id,
                &JobResult::Failed {
                    stage: "unit".into(),
                    error: "systemctl said no".into(),
                    retryable,
                },
            )
            .unwrap()
        };
        for attempt in 1..MAX_ATTEMPTS {
            let claimed = s.claim_job("stage").unwrap().expect("claimable");
            assert_eq!(claimed.attempts, attempt);
            let out = fail(&s, true);
            assert_eq!(
                out.status, "queued",
                "attempt {attempt} goes back to the queue"
            );
            assert_eq!(
                job_status(&s, &job_id),
                ("queued".into(), attempt, None),
                "host cleared for a create"
            );
            assert_eq!(
                s.access_state("u").unwrap().sandbox_status,
                "queued",
                "still on its way from the member's side"
            );
        }
        s.claim_job("stage").unwrap().unwrap();
        let out = fail(&s, true);
        assert_eq!(out.status, "failed");
        assert_eq!(out.error.as_deref(), Some("unit: systemctl said no"));
        assert_eq!(job_status(&s, &job_id).0, "failed");
        let access = s.access_state("u").unwrap();
        assert_eq!(access.sandbox_status, "failed");
        assert_eq!(
            access.sandbox_error.as_deref(),
            Some("unit: systemctl said no")
        );
        let rows = audit_rows(&s, "sandbox.failed", "u");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["attempts"], MAX_ATTEMPTS);
        assert_eq!(rows[0]["stage"], "unit");
        assert!(
            s.claim_job("stage").unwrap().is_none(),
            "a failed job is not offered again"
        );
        // Admin retry: back to the queue with a fresh allowance.
        assert!(s.retry_job(&job_id).unwrap());
        assert!(!s.retry_job(&job_id).unwrap(), "only a failed job retries");
        assert_eq!(job_status(&s, &job_id), ("queued".into(), 0, None));
        assert_eq!(s.access_state("u").unwrap().sandbox_status, "queued");
        // A non-retryable failure fails at once, attempts notwithstanding.
        s.claim_job("stage").unwrap().unwrap();
        assert_eq!(fail(&s, false).status, "failed");
        assert_eq!(
            s.provision_jobs(Some("failed"), 50).unwrap()[0]["attempts"],
            1
        );
        // A daemon that stops heartbeating is treated as a retryable failure.
        s.retry_job(&job_id).unwrap();
        s.claim_job("stage").unwrap().unwrap();
        assert!(
            s.requeue_stale_jobs().unwrap().is_empty(),
            "a fresh claim is not stale"
        );
        s.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE provision_jobs SET heartbeat_at=heartbeat_at-?1 WHERE job_id=?2",
                params![STALE_HEARTBEAT_MS + 1000, job_id],
            )
            .unwrap();
        let stale = s.requeue_stale_jobs().unwrap();
        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].status, "queued");
        assert_eq!(
            stale[0].error.as_deref(),
            Some(format!("heartbeat: {STALE_ERR}").as_str())
        );
        // Unclaim returns the job untouched: the attempt is not charged.
        let claimed = s.claim_job("stage").unwrap().unwrap();
        assert_eq!(claimed.attempts, 2);
        s.unclaim_job(&job_id).unwrap();
        assert_eq!(job_status(&s, &job_id), ("queued".into(), 1, None));
        assert!(s.enqueue_job("u", "sandbox_teleport").is_err());
        assert_eq!(
            s.enqueue_job("ghost", "sandbox_create").unwrap_err(),
            "not_found"
        );
    }
}
