//! In-app erasure: revoke access immediately, then erase only this account.
//! Hosted sandboxes must be erased by their provisioner before finalization.
use crate::workspace::{db_err, hash_token, now_ms, opaque_token, WorkspaceStore};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub(crate) fn init_schema(c: &Connection) -> Result<(), String> {
    c.execute_batch(
        r#"
      CREATE TABLE IF NOT EXISTS privacy_generation (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO privacy_generation VALUES(1,0);
      CREATE TABLE IF NOT EXISTS account_deletions (
        user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
        receipt_hash TEXT NOT NULL, requested_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deletion_receipts (
        receipt_hash TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sandbox_hosts (host TEXT PRIMARY KEY);
      INSERT OR IGNORE INTO sandbox_hosts SELECT DISTINCT host FROM provision_jobs WHERE host IS NOT NULL;
      INSERT OR IGNORE INTO sandbox_hosts SELECT DISTINCT sandbox_host FROM user_access WHERE sandbox_host IS NOT NULL;
      INSERT OR IGNORE INTO sandbox_hosts SELECT DISTINCT json_extract(metadata_json,'$.host') FROM audit_events
        WHERE action LIKE 'sandbox.%' AND json_valid(metadata_json) AND json_type(metadata_json,'$.host')='text';
      CREATE TABLE IF NOT EXISTS sandbox_erasures (
        user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        host TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES provision_jobs(job_id),
        PRIMARY KEY(user_id,host)
      );
      CREATE TRIGGER IF NOT EXISTS pin_account_erasure_host
      BEFORE UPDATE OF host ON provision_jobs WHEN EXISTS
        (SELECT 1 FROM sandbox_erasures e WHERE e.job_id=NEW.job_id AND e.host IS NOT NEW.host)
      BEGIN SELECT RAISE(ABORT, 'account erasure host cannot change'); END;
      CREATE TABLE IF NOT EXISTS erased_sessions (
        machine_id TEXT NOT NULL, session_id TEXT NOT NULL,
        PRIMARY KEY(machine_id,session_id)
      );
      CREATE TRIGGER IF NOT EXISTS no_erased_board_card_sessions_insert
      BEFORE INSERT ON board_card_sessions WHEN EXISTS
        (SELECT 1 FROM erased_sessions e WHERE e.machine_id=NEW.machine_id AND e.session_id=NEW.session_id)
      BEGIN SELECT RAISE(ABORT, 'erased session cannot feed board'); END;
      CREATE TRIGGER IF NOT EXISTS no_erased_board_card_sessions_update
      BEFORE UPDATE ON board_card_sessions WHEN EXISTS
        (SELECT 1 FROM erased_sessions e WHERE e.machine_id=NEW.machine_id AND e.session_id=NEW.session_id)
      BEGIN SELECT RAISE(ABORT, 'erased session cannot feed board'); END;
      CREATE TRIGGER IF NOT EXISTS no_erased_board_session_state_insert
      BEFORE INSERT ON board_session_state WHEN EXISTS
        (SELECT 1 FROM erased_sessions e WHERE e.machine_id=NEW.machine_id AND e.session_id=NEW.session_id)
      BEGIN SELECT RAISE(ABORT, 'erased session cannot feed board'); END;
      CREATE TRIGGER IF NOT EXISTS no_erased_board_session_state_update
      BEFORE UPDATE ON board_session_state WHEN EXISTS
        (SELECT 1 FROM erased_sessions e WHERE e.machine_id=NEW.machine_id AND e.session_id=NEW.session_id)
      BEGIN SELECT RAISE(ABORT, 'erased session cannot feed board'); END;
      CREATE TABLE IF NOT EXISTS pending_session_runs (
        run_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL, category TEXT
      );
      CREATE TRIGGER IF NOT EXISTS no_session_for_deleting_account
      BEFORE INSERT ON auth_sessions WHEN EXISTS
        (SELECT 1 FROM account_deletions WHERE user_id=NEW.user_id)
      BEGIN SELECT RAISE(ABORT, 'account deletion in progress'); END;
    "#,
    )
    .map_err(db_err)?;
    migrate_origin_columns(c)?;
    crate::privacy_guard::init_schema(c)
}

/// Idempotent migration (31.10.2026): `origin` marks sessions started by the
/// fleet API, which the hub stamps `automated` so lists hide them. Older DBs
/// lack the column; a second run hits "duplicate column", which is ignored.
///
/// The pending run's origin lives in its OWN table, not a fifth column of
/// `pending_session_runs`: the previous binary inserts there positionally
/// (`VALUES(?1,?2,?3,?4)`), and rolling back by artifact (DEPLOY-RULES §8)
/// would then fail every session start (found in review). `session_owners`
/// is only ever written with a column list, so a column is safe there.
pub(crate) fn migrate_origin_columns(c: &Connection) -> Result<(), String> {
    if let Err(e) = c.execute("ALTER TABLE session_owners ADD COLUMN origin TEXT", []) {
        if !e.to_string().contains("duplicate column") {
            return Err(db_err(e));
        }
    }
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS pending_session_origin (run_id TEXT PRIMARY KEY, origin TEXT NOT NULL)",
    )
    .map_err(db_err)
}

impl WorkspaceStore {
    pub fn forget_failed_session_start(&self, run: &str, machine: &str) -> Result<(), String> {
        let c = self.conn.lock().map_err(|_| "database lock poisoned")?;
        c.execute(
            "DELETE FROM pending_session_runs WHERE run_id=?1 AND machine_id=?2",
            params![run, machine],
        )
        .map_err(db_err)?;
        c.execute(
            "DELETE FROM pending_session_origin WHERE run_id NOT IN (SELECT run_id FROM pending_session_runs)",
            [],
        )
        .map_err(db_err)?;
        Ok(())
    }

    pub fn session_owner_metadata(
        &self,
        machine: &str,
        session: &str,
    ) -> Result<Option<Value>, String> {
        let c = self.conn.lock().map_err(|_| "database lock poisoned")?;
        c.query_row("SELECT owner_user_id,category,stage,origin FROM session_owners WHERE machine_id=?1 AND session_id=?2", params![machine,session], |r| Ok(json!({"owner":r.get::<_,String>(0)?,"category":r.get::<_,Option<String>>(1)?,"stage":r.get::<_,Option<String>>(2)?,"origin":r.get::<_,Option<String>>(3)?}))).optional().map_err(db_err)
    }
    pub fn erased_session_keys(&self) -> Result<std::collections::HashSet<String>, String> {
        let c = self.conn.lock().map_err(|_| "database lock poisoned")?;
        let mut stmt = c
            .prepare("SELECT machine_id || '::' || session_id FROM erased_sessions UNION SELECT o.machine_id || '::' || o.session_id FROM session_owners o JOIN account_deletions d ON d.user_id=o.owner_user_id UNION SELECT p.machine_id || '::*' FROM pending_session_runs p JOIN account_deletions d ON d.user_id=p.owner_user_id")
            .map_err(db_err)?;
        let rows = stmt.query_map([], |r| r.get(0)).map_err(db_err)?;
        rows.collect::<Result<_, _>>().map_err(db_err)
    }

    /// Persist ownership before a new-session command leaves the hub. A late
    /// session_started or reconnect can then resolve it after a hub restart.
    pub fn remember_pending_session(
        &self,
        run: &str,
        machine: &str,
        owner: &str,
        category: Option<&str>,
        origin: Option<&str>,
    ) -> Result<(), String> {
        let c = self.conn.lock().map_err(|_| "database lock poisoned")?;
        // Owner and origin land together or not at all.
        let tx = c.unchecked_transaction().map_err(db_err)?;
        tx.execute(
            "INSERT INTO pending_session_runs(run_id,machine_id,owner_user_id,category) VALUES(?1,?2,?3,?4)",
            params![run, machine, owner, category],
        )
        .map_err(db_err)?;
        if let Some(origin) = origin {
            tx.execute(
                "INSERT OR REPLACE INTO pending_session_origin(run_id,origin) VALUES(?1,?2)",
                params![run, origin],
            )
            .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        Ok(())
    }

    /// Returns true for a deleted owner's run. Never trust a run id volunteered
    /// by a different machine. Removing the pending association and recording
    /// its permanent session identity are one transaction.
    pub fn resolve_pending_session(
        &self,
        run: &str,
        machine: &str,
        session: &str,
    ) -> Result<bool, String> {
        let c = self.conn.lock().map_err(|_| "database lock poisoned")?;
        let tx = c.unchecked_transaction().map_err(db_err)?;
        let pending: Option<(String, Option<String>)> = tx.query_row("SELECT owner_user_id,category FROM pending_session_runs WHERE run_id=?1 AND machine_id=?2", params![run,machine], |r| Ok((r.get(0)?,r.get(1)?))).optional().map_err(db_err)?;
        let Some((owner, category)) = pending else {
            return Ok(false);
        };
        let origin: Option<String> = tx
            .query_row(
                "SELECT origin FROM pending_session_origin WHERE run_id=?1",
                [run],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        tx.execute("INSERT OR IGNORE INTO session_owners(machine_id,session_id,owner_user_id,category,created_at,origin) VALUES(?1,?2,?3,?4,?5,?6)", params![machine,session,owner,category,now_ms(),origin]).map_err(db_err)?;
        let deleting: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM account_deletions WHERE user_id=?1)",
                [&owner],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if deleting {
            tx.execute(
                "INSERT OR IGNORE INTO erased_sessions VALUES(?1,?2)",
                params![machine, session],
            )
            .map_err(db_err)?;
        }
        tx.execute("DELETE FROM pending_session_runs WHERE run_id=?1", [run])
            .map_err(db_err)?;
        tx.execute("DELETE FROM pending_session_origin WHERE run_id=?1", [run])
            .map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(deleting)
    }

    pub fn deletion_pending(&self, user: &str) -> Result<bool, String> {
        let c = self.conn.lock().map_err(|_| "database lock poisoned")?;
        c.query_row(
            "SELECT EXISTS(SELECT 1 FROM account_deletions WHERE user_id=?1)",
            [user],
            |r| r.get(0),
        )
        .map_err(db_err)
    }

    pub fn deletion_status(&self, receipt: &str) -> Result<Option<String>, String> {
        let c = self.conn.lock().map_err(|_| "database lock poisoned")?;
        c.query_row(
            "SELECT status FROM deletion_receipts WHERE receipt_hash=?1",
            [hash_token(receipt)],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_err)
    }

    /// Preview transfers before confirmation. The same selection is checked
    /// inside the deletion transaction; ownership never silently changes.
    pub fn deletion_preview(&self, user: &str) -> Result<Value, String> {
        let c = self.conn.lock().map_err(|_| "database lock poisoned")?;
        Ok(json!({"userId": user, "transfers": transfers(&c, user)?}))
    }

    #[cfg(test)]
    pub fn request_account_deletion(
        &self,
        user: &str,
        expected_transfers: &Value,
    ) -> Result<String, String> {
        self.request_account_deletion_with_receipt(user, expected_transfers, &opaque_token())
    }

    pub fn request_account_deletion_with_receipt(
        &self,
        user: &str,
        expected_transfers: &Value,
        receipt: &str,
    ) -> Result<String, String> {
        if receipt.len() != 64 || !receipt.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("invalid deletion receipt".into());
        }
        // Erasing an account erases the audit rows it acted in. A support
        // account's rows are the owner's record of what support did: they go
        // only with the team, never at the support account's own request.
        if crate::support_access::is_support_user(user) {
            return Err("not available to a support account".into());
        }
        if self
            .always_active
            .read()
            .map_err(|_| "admin lock poisoned")?
            .contains(user)
        {
            return Err(
                "Сначала передайте административные полномочия другому администратору хаба.".into(),
            );
        }
        let c = self.conn.lock().map_err(|_| "database lock poisoned")?;
        let tx = c.unchecked_transaction().map_err(db_err)?;
        let actual = transfers(&tx, user)?;
        if &actual != expected_transfers {
            return Err("Состав команд изменился. Откройте подтверждение удаления заново.".into());
        }
        let now = now_ms();
        tx.execute("UPDATE privacy_generation SET revision=revision+1", [])
            .map_err(db_err)?;
        tx.execute(
            "INSERT INTO account_deletions VALUES(?1,?2,?3)",
            params![user, hash_token(receipt), now],
        )
        .map_err(db_err)?;
        tx.execute(
            "INSERT INTO deletion_receipts VALUES(?1,'pending',?2)",
            params![hash_token(receipt), now],
        )
        .map_err(db_err)?;
        // Transfer only organizations with other members, never devices.
        for item in actual.as_array().into_iter().flatten() {
            let workspace = item["workspaceId"].as_str().ok_or("workspace missing")?;
            let next = item["newOwnerUserId"].as_str().ok_or("owner missing")?;
            tx.execute(
                "UPDATE workspaces SET owner_user_id=?2 WHERE workspace_id=?1",
                params![workspace, next],
            )
            .map_err(db_err)?;
            tx.execute(
                "UPDATE memberships SET role='owner' WHERE workspace_id=?1 AND user_id=?2",
                params![workspace, next],
            )
            .map_err(db_err)?;
            tx.execute(
                "UPDATE memberships SET role='member' WHERE workspace_id=?1 AND user_id=?2",
                params![workspace, user],
            )
            .map_err(db_err)?;
        }
        tx.execute("DELETE FROM auth_sessions WHERE user_id=?1", [user])
            .map_err(db_err)?;
        tx.execute("DELETE FROM enrollments WHERE user_id=?1", [user])
            .map_err(db_err)?;
        tx.execute(
            "DELETE FROM enrollment_requests WHERE approved_by=?1 OR machine_id IN (SELECT machine_id FROM devices WHERE owner_user_id=?1)",
            [user],
        )
        .map_err(db_err)?;
        tx.execute("UPDATE user_access SET state='suspended',suspend_reason='account deletion',updated_at=?2 WHERE user_id=?1", params![user,now]).map_err(db_err)?;
        // Suspended without the hooks of an admin's suspension: the repository
        // access is marked for revocation in THIS transaction, so it is taken
        // back while the erasure waits for the hosted data.
        tx.execute(crate::github_grant::MARK_REVOKING_SQL, params![user, now])
            .map_err(db_err)?;
        tx.execute(
            "UPDATE devices SET revoked_at=?2 WHERE owner_user_id=?1",
            params![user, now],
        )
        .map_err(db_err)?;
        tx.execute("UPDATE device_credentials SET revoked_at=?2 WHERE machine_id IN (SELECT machine_id FROM devices WHERE owner_user_id=?1)", params![user,now]).map_err(db_err)?;
        // Owned machines are revoked entirely and their unowned replicas are
        // erased at finalization. Only shared machines require late run identity.
        tx.execute("DELETE FROM pending_session_runs WHERE owner_user_id=?1 AND machine_id IN (SELECT machine_id FROM devices WHERE owner_user_id=?1)", [user]).map_err(db_err)?;
        tx.execute("DELETE FROM pending_session_origin WHERE run_id NOT IN (SELECT run_id FROM pending_session_runs)", []).map_err(db_err)?;
        // Queued provisioning must not create a fresh sandbox after erasure.
        tx.execute("UPDATE provision_jobs SET status='failed',error='account deletion',finished_at=?2 WHERE user_id=?1 AND status='queued'", params![user,now]).map_err(db_err)?;
        erase_board_derivatives(&tx, user)?;
        self.advance_privacy_guard(&tx)?;
        tx.commit().map_err(db_err)?;
        Ok(receipt.into())
    }

    pub fn pending_deletions(&self) -> Result<Vec<String>, String> {
        let c = self.conn.lock().map_err(|_| "database lock poisoned")?;
        // This sweep runs even when no further account is deleted.
        c.execute(
            "DELETE FROM deletion_receipts WHERE status='deleted' AND updated_at<?1",
            [now_ms() - 30 * 86400 * 1000],
        )
        .map_err(db_err)?;
        let mut stmt = c
            .prepare("SELECT user_id FROM account_deletions ORDER BY requested_at LIMIT 100")
            .map_err(db_err)?;
        let rows = stmt.query_map([], |r| r.get(0)).map_err(db_err)?;
        rows.collect::<Result<_, _>>().map_err(db_err)
    }

    /// A slug may have data after a failed create or an ordinary archived
    /// delete. Sweep every known sandbox host, including historical hosts.
    /// Each target has one durable job; exhausted retries require repair,
    /// never an unbounded new job every reconciler tick.
    pub fn ensure_sandbox_erasure(&self, user: &str) -> Result<bool, String> {
        let c = self.conn.lock().map_err(|_| "database lock poisoned")?;
        let tx = c.unchecked_transaction().map_err(db_err)?;
        let slug: Option<String> = tx
            .query_row(
                "SELECT sandbox_slug FROM user_access WHERE user_id=?1",
                [user],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if slug.is_none() {
            return Ok(true);
        }
        let hosts: Vec<String> = {
            let mut stmt = tx
                .prepare("SELECT host FROM sandbox_hosts")
                .map_err(db_err)?;
            let rows = stmt.query_map([], |r| r.get(0)).map_err(db_err)?;
            rows.collect::<Result<_, _>>().map_err(db_err)?
        };
        if hosts.is_empty() {
            return Err("sandbox host inventory required".into());
        }
        for host in hosts {
            let exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sandbox_erasures WHERE user_id=?1 AND host=?2)",
                    params![user, host],
                    |r| r.get(0),
                )
                .map_err(db_err)?;
            if !exists {
                let job = uuid::Uuid::new_v4().to_string();
                tx.execute("INSERT INTO provision_jobs(job_id,user_id,kind,status,host,attempts,max_attempts,created_at) VALUES(?1,?2,'sandbox_delete','queued',?3,0,3,?4)", params![job,user,host,now_ms()]).map_err(db_err)?;
                tx.execute(
                    "INSERT INTO sandbox_erasures VALUES(?1,?2,?3)",
                    params![user, host, job],
                )
                .map_err(db_err)?;
            }
        }
        let pending: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sandbox_erasures e JOIN provision_jobs j ON j.job_id=e.job_id WHERE e.user_id=?1 AND j.status<>'done')", [user], |r| r.get(0)).map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(!pending)
    }

    pub fn job_requires_erasure(&self, job: &str) -> Result<bool, String> {
        let c = self.conn.lock().map_err(|_| "database lock poisoned")?;
        c.query_row("SELECT EXISTS(SELECT 1 FROM provision_jobs j JOIN account_deletions d ON d.user_id=j.user_id WHERE j.job_id=?1 AND j.kind='sandbox_delete')", [job], |r|r.get(0)).map_err(db_err)
    }

    pub fn has_provisioning_in_flight(&self, user: &str) -> Result<bool, String> {
        let c = self.conn.lock().map_err(|_| "database lock poisoned")?;
        // A pre-deletion running job can be requeued by stale-job recovery.
        // Replace it with a durable erasure job; erasure-only workers cannot
        // claim an ordinary queued job and would otherwise wait forever.
        c.execute("UPDATE provision_jobs SET status='failed',error='account deletion',finished_at=?2 WHERE user_id=?1 AND status='queued' AND EXISTS(SELECT 1 FROM account_deletions WHERE user_id=?1) AND NOT EXISTS(SELECT 1 FROM sandbox_erasures e WHERE e.job_id=provision_jobs.job_id)", params![user,now_ms()]).map_err(db_err)?;
        c.query_row("SELECT EXISTS(SELECT 1 FROM provision_jobs WHERE user_id=?1 AND status IN ('queued','running'))", [user], |r| r.get(0)).map_err(db_err)
    }

    /// Called by the hub's single-owner loop after external cleanup succeeds.
    /// The replica and workspace tables share this database on every real hub.
    pub fn erase_account(&self, user: &str) -> Result<(), String> {
        let c = self.conn.lock().map_err(|_| "database lock poisoned")?;
        let tx = c.unchecked_transaction().map_err(db_err)?;
        let unresolved: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pending_session_runs WHERE owner_user_id=?1)",
                [user],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if unresolved {
            return Err("new session identity reconciliation is still pending".into());
        }
        let receipt: String = tx
            .query_row(
                "SELECT receipt_hash FROM account_deletions WHERE user_id=?1",
                [user],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        let hosted: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM user_access WHERE user_id=?1 AND (sandbox_machine_id IS NOT NULL OR sandbox_status IN ('ready','running'))) OR EXISTS(SELECT 1 FROM provision_jobs WHERE user_id=?1 AND status IN ('queued','running'))", [user], |r| r.get(0)).map_err(db_err)?;
        let unconfirmed: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM user_access a WHERE a.user_id=?1 AND a.sandbox_slug IS NOT NULL AND (NOT EXISTS(SELECT 1 FROM sandbox_hosts) OR EXISTS(SELECT 1 FROM sandbox_hosts h WHERE NOT EXISTS(SELECT 1 FROM sandbox_erasures e JOIN provision_jobs j ON j.job_id=e.job_id WHERE e.user_id=?1 AND e.host=h.host AND j.status='done'))))", [user], |r| r.get(0)).map_err(db_err)?;
        if hosted || unconfirmed {
            return Err("hosted data cleanup is still pending".into());
        }
        // A revoked-device tombstone cannot point back at a recreated SSO id.
        // It contains no identity, credentials, profile or transcript.
        let tombstone = format!("erased:{}", opaque_token());
        tx.execute(
            "INSERT INTO users(user_id,created_at) VALUES(?1,0)",
            [&tombstone],
        )
        .map_err(db_err)?;
        tx.execute("INSERT OR IGNORE INTO erased_sessions SELECT machine_id,session_id FROM session_owners WHERE owner_user_id=?1", [user]).map_err(db_err)?;
        let replica: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='sessions' AND type='table')",
                [],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if replica {
            tx.execute("INSERT OR IGNORE INTO erased_sessions SELECT s.machine_id,s.session_id FROM sessions s JOIN devices d ON d.machine_id=s.machine_id LEFT JOIN session_owners o ON o.machine_id=s.machine_id AND o.session_id=s.session_id WHERE d.owner_user_id=?1 AND (o.owner_user_id IS NULL OR o.owner_user_id=?1)", [user]).map_err(db_err)?;
            tx.execute("DELETE FROM sessions WHERE EXISTS(SELECT 1 FROM erased_sessions e WHERE e.machine_id=sessions.machine_id AND e.session_id=sessions.session_id)", []).map_err(db_err)?;
            tx.execute("UPDATE machines SET machine_json=json_object('machineId',machine_id,'name','Disconnected device','os','unknown','version',''),last_seen=0 WHERE machine_id IN (SELECT machine_id FROM devices WHERE owner_user_id=?1)", [user]).map_err(db_err)?;
        }
        let archive: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_turns')", [], |r|r.get(0)).map_err(db_err)?;
        if archive {
            tx.execute("INSERT OR IGNORE INTO erased_sessions SELECT s.machine_id,s.session_id FROM conversation_turns s JOIN devices d ON d.machine_id=s.machine_id LEFT JOIN session_owners o ON o.machine_id=s.machine_id AND o.session_id=s.session_id WHERE d.owner_user_id=?1 AND (o.owner_user_id IS NULL OR o.owner_user_id=?1)", [user]).map_err(db_err)?;
            tx.execute_batch("CREATE TRIGGER IF NOT EXISTS no_archiving_erased_session BEFORE INSERT ON conversation_turns WHEN EXISTS(SELECT 1 FROM erased_sessions e WHERE e.machine_id=NEW.machine_id AND e.session_id=NEW.session_id) BEGIN SELECT RAISE(IGNORE); END;").map_err(db_err)?;
            tx.execute("DELETE FROM conversation_turns WHERE EXISTS(SELECT 1 FROM erased_sessions e WHERE e.machine_id=conversation_turns.machine_id AND e.session_id=conversation_turns.session_id)", []).map_err(db_err)?;
        }
        erase_board_derivatives(&tx, user)?;
        tx.execute("UPDATE privacy_generation SET revision=revision+1", [])
            .map_err(db_err)?;
        tx.execute("INSERT OR IGNORE INTO retired_sandbox_slugs(slug,host,machine_id,retired_at) SELECT sandbox_slug,sandbox_host,sandbox_machine_id,?2 FROM user_access WHERE user_id=?1 AND sandbox_slug IS NOT NULL", params![user,now_ms()]).map_err(db_err)?;
        tx.execute(
            "DELETE FROM live_activity_pending_start WHERE user_id=?1",
            [user],
        )
        .map_err(db_err)?;
        tx.execute("DELETE FROM live_activity_tokens WHERE user_id=?1", [user])
            .map_err(db_err)?;
        tx.execute("DELETE FROM avatars WHERE user_id=?1", [user])
            .map_err(db_err)?;
        tx.execute("DELETE FROM telegram_logins WHERE user_id=?1 OR link_user_id=?1 OR telegram_id IN (SELECT subject FROM identities WHERE provider='telegram' AND user_id=?1)", [user]).map_err(db_err)?;
        tx.execute("DELETE FROM access_preauth WHERE claimed_by=?1 OR lower(email)=(SELECT lower(email) FROM users WHERE user_id=?1)", [user]).map_err(db_err)?;
        // The person's Telegram handles (labels `@name`): invitations addressed
        // to them go, and so does the handle in audit metadata.
        let handles: Vec<String> = {
            let mut stmt = tx
                .prepare("SELECT lower(ltrim(label,'@')) FROM identities WHERE provider='telegram' AND user_id=?1 AND label LIKE '@%'")
                .map_err(db_err)?;
            let rows = stmt
                .query_map([user], |r| r.get::<_, String>(0))
                .map_err(db_err)?;
            rows.filter_map(Result::ok).collect()
        };
        // Invitations the person accepted (before those rows are deleted).
        tx.execute("UPDATE audit_events SET metadata_json=json_remove(metadata_json,'$.telegram') WHERE json_valid(metadata_json) AND target_kind='invitation' AND target_id IN (SELECT invitation_id FROM invitations WHERE accepted_by=?1)", [user]).map_err(db_err)?;
        for handle in &handles {
            tx.execute(
                "DELETE FROM invitations WHERE telegram_username=?1",
                [handle],
            )
            .map_err(db_err)?;
            tx.execute("UPDATE audit_events SET metadata_json=json_remove(metadata_json,'$.telegram') WHERE json_valid(metadata_json) AND lower(json_extract(metadata_json,'$.telegram'))=?1", [handle]).map_err(db_err)?;
        }
        tx.execute("DELETE FROM invitations WHERE created_by=?1 OR accepted_by=?1 OR (email<>'' AND lower(email)=(SELECT lower(email) FROM users WHERE user_id=?1))", [user]).map_err(db_err)?;
        tx.execute("UPDATE audit_events SET metadata_json=json_remove(metadata_json,'$.email') WHERE json_valid(metadata_json) AND lower(json_extract(metadata_json,'$.email'))=(SELECT lower(email) FROM users WHERE user_id=?1)", [user]).map_err(db_err)?;
        tx.execute(
            "DELETE FROM manager_assignments WHERE manager_user_id=?1 OR target_id=?1",
            [user],
        )
        .map_err(db_err)?;
        tx.execute(
            "DELETE FROM audit_events WHERE actor_user_id=?1 OR target_id=?1",
            [user],
        )
        .map_err(db_err)?;
        tx.execute("DELETE FROM project_shares WHERE owner_user_id=?1 OR machine_id IN (SELECT machine_id FROM devices WHERE owner_user_id=?1)", [user]).map_err(db_err)?;
        tx.execute("DELETE FROM device_credentials WHERE machine_id IN (SELECT machine_id FROM devices WHERE owner_user_id=?1)", [user]).map_err(db_err)?;
        tx.execute("UPDATE devices SET owner_user_id=?2,name='Disconnected device',os='',agent_version='',last_seen=0 WHERE owner_user_id=?1", params![user,tombstone]).map_err(db_err)?;
        tx.execute("UPDATE session_owners SET owner_user_id=?2,category=NULL,stage=NULL WHERE owner_user_id=?1", params![user,tombstone]).map_err(db_err)?;
        tx.execute("DELETE FROM workspaces WHERE owner_user_id=?1", [user])
            .map_err(db_err)?;
        tx.execute("DELETE FROM sandbox_erasures WHERE user_id=?1", [user])
            .map_err(db_err)?;
        tx.execute("DELETE FROM identity_unlinks WHERE user_id=?1", [user])
            .map_err(db_err)?;
        // The private repository: never erase a grant before the access is
        // taken back. The row stays as a tombstone (GitHub id, login,
        // repository, status; no profile) the revoker works off, then drops.
        tx.execute(
            crate::github_grant::MARK_REVOKING_SQL,
            params![user, now_ms()],
        )
        .map_err(db_err)?;
        tx.execute(
            "DELETE FROM github_grants WHERE user_id=?1 AND status='revoked'",
            [user],
        )
        .map_err(db_err)?;
        for table in [
            "local_credentials",
            "local_setup_tokens",
            "user_totp",
            "github_profiles",
            "access_registration",
        ] {
            tx.execute(&format!("DELETE FROM {table} WHERE user_id=?1"), [user])
                .map_err(db_err)?;
        }
        // «Расходы»: per-day gateway counts keyed by the person's email and key
        // name, and the subscription-limit samples keyed by user id.
        let email: Option<String> = tx
            .query_row("SELECT email FROM users WHERE user_id=?1", [user], |r| {
                r.get::<_, Option<String>>(0)
            })
            .optional()
            .map_err(db_err)?
            .flatten();
        // An account without an e-mail is keyed by its synthetic seat key.
        let email = email
            .filter(|e| !e.is_empty())
            .unwrap_or_else(|| crate::access::synthetic_seat_key(user));
        {
            let email = email.to_lowercase();
            tx.execute(
                "INSERT INTO llm_usage_erased(email_sha256,erased_at) VALUES(?1,?2)
                 ON CONFLICT(email_sha256) DO UPDATE SET erased_at=excluded.erased_at",
                params![
                    crate::llm_usage::erased_key(&email),
                    crate::workspace::now_ms()
                ],
            )
            .map_err(db_err)?;
            tx.execute(
                "DELETE FROM llm_usage_daily WHERE lower(email)=?1 OR lower(virtual_key_name)=?2 OR user_id=?3",
                params![email, format!("hegai:{email}"), user],
            )
            .map_err(db_err)?;
        }
        tx.execute("DELETE FROM llm_usage_daily WHERE user_id=?1", [user])
            .map_err(db_err)?;
        tx.execute("DELETE FROM sub_limit_samples WHERE user_id=?1", [user])
            .map_err(db_err)?;
        tx.execute("DELETE FROM users WHERE user_id=?1", [user])
            .map_err(db_err)?;
        tx.execute(
            "UPDATE deletion_receipts SET status='deleted',updated_at=?2 WHERE receipt_hash=?1",
            params![receipt, now_ms()],
        )
        .map_err(db_err)?;
        tx.execute(
            "DELETE FROM deletion_receipts WHERE status='deleted' AND updated_at<?1",
            [now_ms() - 30 * 86400 * 1000],
        )
        .map_err(db_err)?;
        self.advance_privacy_guard(&tx)?;
        tx.commit().map_err(db_err)
    }
}

fn erase_board_derivatives(c: &Connection, user: &str) -> Result<(), String> {
    c.execute_batch("CREATE TEMP TABLE IF NOT EXISTS erasure_board_cards(card_id TEXT PRIMARY KEY); DELETE FROM erasure_board_cards;").map_err(db_err)?;
    // A mixed summary cannot be reliably redacted. Unscoped legacy cards may
    // also contain other users' offered context even without their final links.
    // Discard these derivatives, never peers' original sessions; reset their
    // memos so the assembler rebuilds only from preserved, authorized sources.
    c.execute("INSERT INTO erasure_board_cards SELECT card_id FROM board_cards WHERE privacy_scoped=0 OR owner_user_id=?1 OR card_id IN (SELECT card_id FROM board_card_sessions l WHERE l.owner_user_id=?1 OR EXISTS(SELECT 1 FROM erased_sessions e WHERE e.machine_id=l.machine_id AND e.session_id=l.session_id) UNION SELECT card_id FROM board_events WHERE actor=?1)", [user]).map_err(db_err)?;
    c.execute("DELETE FROM board_session_state WHERE EXISTS(SELECT 1 FROM erased_sessions e WHERE e.machine_id=board_session_state.machine_id AND e.session_id=board_session_state.session_id) OR (machine_id,session_id) IN (SELECT machine_id,session_id FROM board_card_sessions WHERE card_id IN (SELECT card_id FROM erasure_board_cards))", []).map_err(db_err)?;
    c.execute(
        "DELETE FROM board_cards WHERE card_id IN (SELECT card_id FROM erasure_board_cards)",
        [],
    )
    .map_err(db_err)?;
    // A peer's source may be older than the incremental scan window. Persist
    // its eligibility for rebuilding in the same transaction as memo removal.
    c.execute("INSERT INTO board_state(key,value) SELECT 'watermark_ms','0' WHERE EXISTS(SELECT 1 FROM erasure_board_cards) ON CONFLICT(key) DO UPDATE SET value='0'", []).map_err(db_err)?;
    c.execute_batch("DROP TABLE erasure_board_cards;")
        .map_err(db_err)
}

fn transfers(c: &Connection, user: &str) -> Result<Value, String> {
    let mut stmt = c.prepare(r#"SELECT w.workspace_id,w.name,m.user_id,COALESCE(u.full_name,u.email,'Участник')
      FROM workspaces w JOIN memberships m ON m.workspace_id=w.workspace_id JOIN users u ON u.user_id=m.user_id
      WHERE w.owner_user_id=?1 AND m.user_id<>?1 AND w.kind='organization'
        AND NOT EXISTS(SELECT 1 FROM account_deletions a WHERE a.user_id=m.user_id)
      ORDER BY w.workspace_id, CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END,m.created_at,m.user_id"#).map_err(db_err)?;
    let rows = stmt
        .query_map([user], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(db_err)?;
    let mut result = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in rows {
        let (workspace, name, next, owner) = row.map_err(db_err)?;
        if seen.insert(workspace.clone()) {
            result.push(json!({"workspaceId":workspace,"name":name,"newOwnerUserId":next,"newOwnerName":owner}));
        }
    }
    Ok(Value::Array(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::replica::ReplicaStore;

    #[test]
    fn erases_identity_and_own_transcripts_revokes_sessions_and_keeps_other_people() {
        let path = std::env::temp_dir().join(format!("account-erasure-{}.sqlite", opaque_token()));
        let s = WorkspaceStore::open(&path).unwrap();
        let replica = ReplicaStore::open(&path).unwrap();
        s.ensure_user("alice", "alice@example.test", Some("Alice"))
            .unwrap();
        s.ensure_user("bob", "bob@example.test", Some("Bob"))
            .unwrap();
        let token = s.create_auth_session("alice", 90).unwrap();
        let bob = s.create_auth_session("bob", 90).unwrap();
        s.with_conn_for_tests(|c| {
            c.execute("INSERT INTO devices VALUES('mac','alice','Alice Mac','mac','1',0,0,NULL,'personal')", []).unwrap();
            c.execute("INSERT INTO session_owners(machine_id,session_id,owner_user_id,created_at) VALUES('mac','mine','alice',0),('mac','theirs','bob',0)", []).unwrap();
            c.execute("INSERT INTO identities(provider,subject,user_id,created_at) VALUES('telegram','100','alice',0)", []).unwrap();
            c.execute("INSERT INTO github_profiles(user_id,github_id,login,updated_at) VALUES('alice','42','octo',0)", []).unwrap();
            c.execute("INSERT INTO github_grants(user_id,repo,github_id,login,status,created_at,updated_at) VALUES('alice','o/r','42','octo','granted',0,0)", []).unwrap();
            c.execute("INSERT INTO enrollment_requests(poll_hash,user_code_hash,machine_json,created_at,expires_at,machine_id) VALUES('rq','code','{}',0,9999999999999,'mac')", []).unwrap();
            c.execute("INSERT INTO audit_events(audit_event_id,workspace_id,actor_user_id,action,target_kind,target_id,metadata_json,created_at) VALUES('invited','personal:bob','bob','invitation.created','invitation','old-invite','{\"email\":\"ALICE@example.test\",\"role\":\"member\"}',0)", []).unwrap();

        });
        replica.set_state_for_test("mac", "codex", "mine", 1, 1.0);
        s.with_conn_for_tests(|c| { c.execute("INSERT INTO sessions(machine_id,source,session_id,summary_json,active_generation) VALUES('mac','codex','theirs','{}','g1')", []).unwrap(); });
        replica.put_messages_for_test("mac", "codex", "mine", &[json!({"text":"private"})]);
        replica.put_messages_for_test("mac", "codex", "theirs", &[json!({"text":"keep"})]);
        s.with_conn_for_tests(|c| {
            c.execute_batch("CREATE TABLE conversation_turns(machine_id TEXT,session_id TEXT,text TEXT); INSERT INTO conversation_turns VALUES('mac','archive-only','private'),('mac','theirs','keep');").unwrap();
        });
        s.with_conn_for_tests(|c| {
            c.execute_batch("INSERT INTO board_state VALUES('watermark_ms','999999'); INSERT INTO board_cards(card_id,title,summary,status,owner_user_id,first_seen,last_activity,created_at,updated_at) VALUES('mixed','private Alice + Bob','private','planning','bob',0,0,0,0),('clean','Bob','keep','planning','bob',0,0,0,0);
              UPDATE board_cards SET privacy_scoped=1;
              INSERT INTO board_card_sessions(card_id,machine_id,source,session_id,owner_user_id,linked_at) VALUES('mixed','mac','codex','mine','alice',0),('mixed','mac','codex','theirs','bob',0),('clean','mac','codex','theirs','bob',0);
              INSERT INTO board_events(event_id,card_id,at,actor,kind,to_value) VALUES('ev','mixed',0,'assembler','created','private');
              INSERT INTO board_session_state(machine_id,source,session_id,processed_at) VALUES('mac','codex','mine',0),('mac','codex','theirs',0);").unwrap();
        });
        s.live_token_put("alice", "aa11", None, 1).unwrap();
        s.live_token_put("bob", "bb22", None, 1).unwrap();
        s.live_pending_start_set("alice", Some(1)).unwrap();
        let receipt = s.request_account_deletion("alice", &json!([])).unwrap();
        assert!(s.authenticate(&token).unwrap().is_none());
        assert!(s.authenticate(&bob).unwrap().is_some());
        assert!(s.create_auth_session("alice", 90).is_err());
        assert!(s.ui_access("alice", None, false).is_err());
        assert!(s.device_revoked("mac").unwrap());
        s.erase_account("alice").unwrap();
        assert_eq!(
            s.deletion_status(&receipt).unwrap().as_deref(),
            Some("deleted")
        );
        assert!(s.user_json("alice").unwrap().is_none());
        let left = s.live_tokens_all().unwrap();
        assert!(left.iter().all(|t| t.user_id != "alice") && left.len() == 1);
        assert!(s.live_pending_starts_all().unwrap().is_empty());
        s.with_conn_for_tests(|c| {
            let count = |sql| c.query_row(sql, [], |r| r.get::<_,i64>(0)).unwrap();
            assert_eq!(count("SELECT count(*) FROM identities WHERE user_id='alice'"), 0);
            assert_eq!(count("SELECT count(*) FROM github_profiles WHERE user_id='alice'"), 0);
            // The repository access is taken back BEFORE the row goes: a tombstone stays.
            assert_eq!(count("SELECT count(*) FROM github_grants WHERE user_id='alice' AND status='revoking' AND github_id='42' AND repo='o/r'"), 1);
            assert_eq!(count("SELECT count(*) FROM enrollment_requests WHERE machine_id='mac'"), 0);
            assert_eq!(count("SELECT count(*) FROM audit_events WHERE audit_event_id='invited' AND json_extract(metadata_json,'$.email') IS NULL AND json_extract(metadata_json,'$.role')='member'"), 1);

            assert_eq!(count("SELECT count(*) FROM board_cards WHERE card_id='mixed'"), 0);
            assert_eq!(count("SELECT count(*) FROM board_events WHERE card_id='mixed'"), 0);
            assert_eq!(count("SELECT count(*) FROM board_cards WHERE card_id='clean'"), 1);
            assert_eq!(count("SELECT count(*) FROM board_state WHERE key='watermark_ms' AND value='0'"), 1);

            assert_eq!(count("SELECT count(*) FROM board_session_state"), 0, "peer source must be reprocessed without deleted text");
            assert!(c.execute("INSERT INTO board_session_state(machine_id,source,session_id,processed_at) VALUES('mac','codex','mine',0)", []).is_err());

            assert_eq!(count("SELECT count(*) FROM session_messages WHERE session_id='mine'"), 0);
            assert_eq!(count("SELECT count(*) FROM session_messages WHERE session_id='theirs'"), 1);
            assert_eq!(count("SELECT count(*) FROM pragma_foreign_key_check"), 0);
            assert_eq!(count("SELECT count(*) FROM conversation_turns WHERE session_id='archive-only'"), 0);
            assert_eq!(count("SELECT count(*) FROM conversation_turns WHERE session_id='theirs'"), 1);
            assert_eq!(c.execute("INSERT INTO conversation_turns VALUES('mac','archive-only','late archive writer')", []).unwrap(), 0);
            assert_eq!(c.execute("INSERT INTO sessions(machine_id,source,session_id,summary_json) VALUES('mac','codex','mine','{}')", []).unwrap(), 0);
        });
        // Signing up again must not recover the revoked old machine/identity.
        s.ensure_user("alice", "alice@example.test", None).unwrap();
        assert!(s.devices_for_user("alice").unwrap().is_empty());
        drop(replica);
        drop(s);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn transfer_is_previewed_and_concurrent_membership_changes_require_new_confirmation() {
        let s = WorkspaceStore::open_memory();
        for user in ["alice", "bob", "charlie"] {
            s.ensure_user(user, &format!("{user}@example.test"), None)
                .unwrap();
        }
        s.with_conn_for_tests(|c| {
            c.execute("INSERT INTO workspaces(workspace_id,name,kind,owner_user_id,created_at) VALUES('team','Team','organization','alice',0)", []).unwrap();
            c.execute("INSERT INTO memberships VALUES('team','alice','owner',0),('team','bob','member',1)", []).unwrap();
        });
        let preview = s.deletion_preview("alice").unwrap()["transfers"].clone();
        s.with_conn_for_tests(|c| {
            c.execute(
                "INSERT INTO memberships VALUES('team','charlie','manager',2)",
                [],
            )
            .unwrap();
        });
        assert!(s.request_account_deletion("alice", &preview).is_err());
        assert!(!s.deletion_pending("alice").unwrap());
        let preview = s.deletion_preview("alice").unwrap()["transfers"].clone();
        assert_eq!(preview[0]["newOwnerUserId"], "charlie");
        s.request_account_deletion("alice", &preview).unwrap();
        s.erase_account("alice").unwrap();
        let access = s.ui_access("charlie", Some("team"), false).unwrap();
        assert_eq!(access.role, "owner");
        assert!(s.ui_access("bob", Some("team"), false).is_ok());
    }

    #[test]
    fn erasure_removes_the_persons_gateway_usage_and_limit_samples() {
        let s = WorkspaceStore::open_memory();
        for user in ["alice", "bob"] {
            s.ensure_user(user, &format!("{user}@example.test"), None)
                .unwrap();
        }
        s.with_conn_for_tests(|c| {
            c.execute_batch(
                "INSERT INTO llm_usage_daily(day,virtual_key_name,email,model) VALUES
                   ('2026-10-01','hegai:alice@example.test','alice@example.test','m'),
                   ('2026-10-01','hegai:bob@example.test','bob@example.test','m');
                 INSERT INTO sub_limit_samples(user_id,provider,account,window_key,day,label,percent,resets_at,sampled_at,max_percent) VALUES
                   ('alice','claude','','5h','2026-10-01','',10,NULL,0,10),
                   ('bob','claude','','5h','2026-10-01','',10,NULL,0,10);",
            )
            .unwrap();
        });
        let receipt_ok = s.request_account_deletion("alice", &json!([]));
        assert!(receipt_ok.is_ok());
        s.erase_account("alice").unwrap();
        s.with_conn_for_tests(|c| {
            let n = |sql: &str| c.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
            assert_eq!(n("SELECT COUNT(*) FROM llm_usage_daily WHERE email LIKE 'alice%' OR virtual_key_name LIKE '%alice%'"), 0);
            assert_eq!(n("SELECT COUNT(*) FROM llm_usage_daily"), 1);
            assert_eq!(n("SELECT COUNT(*) FROM sub_limit_samples WHERE user_id='alice'"), 0);
            assert_eq!(n("SELECT COUNT(*) FROM sub_limit_samples"), 1);
        });
    }

    #[test]
    fn cannot_finalize_before_hosted_data_is_erased_or_without_a_request() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("u", "u@example.test", None).unwrap();
        assert!(s.erase_account("u").is_err());
        s.with_conn_for_tests(|c| { c.execute("UPDATE user_access SET sandbox_machine_id='sb',sandbox_status='ready' WHERE user_id='u'", []).unwrap(); });
        let receipt = s.request_account_deletion("u", &json!([])).unwrap();
        assert!(s.erase_account("u").is_err());
        assert_eq!(
            s.deletion_status(&receipt).unwrap().as_deref(),
            Some("pending")
        );
        assert!(s.user_json("u").unwrap().is_some());
    }

    #[test]
    fn erasure_only_replaces_old_queued_and_requeued_jobs() {
        let s = WorkspaceStore::open_memory();
        for user in ["alice", "bob"] {
            s.ensure_user(user, &format!("{user}@example.test"), None)
                .unwrap();
            s.activate_access(user, "admin").unwrap();
        }
        s.enqueue_job("bob", "sandbox_create").unwrap();
        assert!(
            s.claim_erasure_job("stage").unwrap().is_none(),
            "ordinary provisioning stays off"
        );
        let (old, _) = s.enqueue_job("alice", "sandbox_delete").unwrap();
        s.with_conn_for_tests(|c| {
            c.execute(
                "UPDATE user_access SET sandbox_slug='alice' WHERE user_id='alice'",
                [],
            )
            .unwrap();
        });
        s.request_account_deletion("alice", &json!([])).unwrap();
        // Simulate stale recovery after an old worker stopped responding.
        s.with_conn_for_tests(|c| {
            c.execute(
                "UPDATE provision_jobs SET status='queued' WHERE job_id=?1",
                [&old],
            )
            .unwrap();
        });
        assert!(!s.has_provisioning_in_flight("alice").unwrap());
        assert!(!s.ensure_sandbox_erasure("alice").unwrap());
        let job = s.claim_erasure_job("stage").unwrap().unwrap();
        assert_eq!(job.user_id, "alice");
        assert_eq!(job.kind, "sandbox_delete");
        assert_ne!(job.job_id, old);
        assert!(s.claim_erasure_job("stage").unwrap().is_none());
    }

    #[test]
    fn pending_session_identity_survives_deletion_until_late_binding() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("alice", "alice@example.test", None).unwrap();
        s.remember_pending_session("new-run", "shared-machine", "alice", None, None)
            .unwrap();
        let receipt = "c".repeat(64);
        assert_eq!(
            s.request_account_deletion_with_receipt("alice", &json!([]), &receipt)
                .unwrap(),
            receipt
        );
        assert_eq!(
            s.deletion_status(&receipt).unwrap().as_deref(),
            Some("pending")
        );
        assert!(s
            .erased_session_keys()
            .unwrap()
            .contains("shared-machine::*"));
        assert!(s.erase_account("alice").is_err());
        assert!(!s
            .resolve_pending_session("new-run", "wrong-machine", "late-session")
            .unwrap());
        assert!(s.erase_account("alice").is_err());
        assert!(s
            .resolve_pending_session("new-run", "shared-machine", "late-session")
            .unwrap());
        s.erase_account("alice").unwrap();
        let erased = s.erased_session_keys().unwrap();
        assert!(erased.contains("shared-machine::late-session"));
        assert!(!erased.contains("shared-machine::*"));
        assert_eq!(
            s.deletion_status(&receipt).unwrap().as_deref(),
            Some("deleted")
        );
    }
    #[test]
    fn fleet_origin_survives_pending_to_owner_binding() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("alice", "alice@example.test", None).unwrap();
        s.remember_pending_session("fleet-run", "m", "alice", None, Some("fleet"))
            .unwrap();
        s.remember_pending_session("human-run", "m", "alice", None, None)
            .unwrap();
        s.resolve_pending_session("fleet-run", "m", "fleet-session")
            .unwrap();
        s.resolve_pending_session("human-run", "m", "human-session")
            .unwrap();
        let origin = |sid: &str| {
            s.session_owner_metadata("m", sid).unwrap().unwrap()["origin"]
                .as_str()
                .map(str::to_string)
        };
        assert_eq!(origin("fleet-session").as_deref(), Some("fleet"));
        assert_eq!(origin("human-session"), None);
        // A later record_session_owner (resume) cannot rewrite the origin.
        s.record_session_owner("m", "human-session", "alice", None)
            .unwrap();
        assert_eq!(origin("human-session"), None);
    }

    #[test]
    fn origin_migration_upgrades_old_schema_and_is_idempotent() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE session_owners (machine_id TEXT, session_id TEXT, owner_user_id TEXT NOT NULL, category TEXT, created_at INTEGER, stage TEXT);
             CREATE TABLE pending_session_runs (run_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, category TEXT);
             INSERT INTO session_owners VALUES('m','s','alice',NULL,1,NULL);
             INSERT INTO pending_session_runs VALUES('r','m','alice',NULL);",
        )
        .unwrap();
        migrate_origin_columns(&c).unwrap();
        migrate_origin_columns(&c).unwrap();
        let o: Option<String> = c
            .query_row("SELECT origin FROM session_owners", [], |r| r.get(0))
            .unwrap();
        assert_eq!(o, None);
        // The previous binary's positional insert must keep working after the
        // migration: rolling back by artifact is the documented recovery.
        c.execute(
            "INSERT INTO pending_session_runs VALUES('r2','m','alice',NULL)",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO pending_session_origin(run_id,origin) VALUES('r2','fleet')",
            [],
        )
        .unwrap();
    }

    #[test]
    fn failed_or_previously_archived_sandbox_requires_confirmed_erasure_on_every_host() {
        use crate::provisioning::JobResult;
        let s = WorkspaceStore::open_memory();
        s.ensure_user("u", "u@example.test", None).unwrap();
        s.activate_access("u", "admin").unwrap();
        s.enqueue_job("u", "sandbox_create").unwrap();
        let create = s.claim_job("old-host").unwrap().unwrap();
        s.apply_job_result(
            &create.job_id,
            &JobResult::Failed {
                stage: "enroll".into(),
                error: "partial home".into(),
                retryable: false,
            },
        )
        .unwrap();
        // Register a second host, with no current work. Hosts are remembered
        // even if a failed create or a normal delete cleared user_access.host.
        assert!(s.claim_job("new-host").unwrap().is_none());
        s.request_account_deletion("u", &json!([])).unwrap();
        assert!(s.enqueue_job("u", "sandbox_create").is_err());
        assert!(s.retry_job(&create.job_id).is_err());
        assert!(!s.ensure_sandbox_erasure("u").unwrap());
        assert!(s.erase_account("u").is_err());
        let first = s.claim_job("old-host").unwrap().unwrap();
        assert!(s.job_requires_erasure(&first.job_id).unwrap());
        s.apply_job_result(
            &first.job_id,
            &JobResult::Failed {
                stage: "erase".into(),
                error: "retry".into(),
                retryable: true,
            },
        )
        .unwrap();
        // Retry retains the exact host even though user_access has none.
        let second = s.claim_job("new-host").unwrap().unwrap();
        assert_ne!(first.job_id, second.job_id);
        s.apply_job_result(
            &second.job_id,
            &JobResult::Ok {
                machine_id: None,
                archive: None,
            },
        )
        .unwrap();
        assert!(!s.ensure_sandbox_erasure("u").unwrap());
        let retry = s.claim_job("old-host").unwrap().unwrap();
        assert_eq!(retry.job_id, first.job_id);
        s.apply_job_result(
            &retry.job_id,
            &JobResult::Failed {
                stage: "erase".into(),
                error: "disk offline".into(),
                retryable: false,
            },
        )
        .unwrap();
        assert!(s.retry_job(&retry.job_id).unwrap());
        assert!(s.claim_job("new-host").unwrap().is_none());
        let retry = s.claim_job("old-host").unwrap().unwrap();
        s.with_conn_for_tests(|c| {
            assert!(c
                .execute(
                    "UPDATE provision_jobs SET host='wrong-host' WHERE job_id=?1",
                    [&retry.job_id]
                )
                .is_err());
        });
        s.apply_job_result(
            &retry.job_id,
            &JobResult::Ok {
                machine_id: None,
                archive: None,
            },
        )
        .unwrap();
        assert!(s.ensure_sandbox_erasure("u").unwrap());
        s.erase_account("u").unwrap();
    }

    /// An account without an e-mail (Telegram-only) is erased through its
    /// synthetic seat key and its Telegram handle leaves the audit metadata.
    #[test]
    fn erasure_covers_the_synthetic_seat_key_and_the_telegram_handle() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("boss", "boss@example.test", None).unwrap();
        s.with_conn_for_tests(|c| {
            c.execute("INSERT INTO users(user_id,email,created_at) VALUES('tg-abc',NULL,0)", []).unwrap();
            c.execute("INSERT INTO identities(provider,subject,user_id,created_at,label) VALUES('telegram','100','tg-abc',0,'@Dan_User')", []).unwrap();
            c.execute("INSERT INTO invitations(invitation_id,workspace_id,email,role,token_hash,created_by,created_at,expires_at,telegram_username) VALUES('i1','personal:boss','','member','h1','boss',0,9999999999999,'dan_user')", []).unwrap();
            // Another e-mail-less person's Telegram invitation must survive.
            c.execute("INSERT INTO invitations(invitation_id,workspace_id,email,role,token_hash,created_by,created_at,expires_at,telegram_username) VALUES('i2','personal:boss','','member','h2','boss',0,9999999999999,'other_person')", []).unwrap();
            c.execute("INSERT INTO audit_events(audit_event_id,workspace_id,actor_user_id,action,target_kind,target_id,metadata_json,created_at) VALUES('a1','personal:boss','boss','invitation.created','invitation','i1','{\"telegram\":\"dan_user\",\"role\":\"member\"}',0)", []).unwrap();
            c.execute_batch(
                "INSERT INTO llm_usage_daily(day,virtual_key_name,email,model,user_id) VALUES
                   ('2026-10-01','hegai:tg-abc@users.invalid','tg-abc@users.invalid','m','tg-abc');",
            )
            .unwrap();
            // Attribution resolves the synthetic key to the account.
            assert_eq!(
                crate::access::user_of_seat_key(c, "TG-ABC@users.invalid").as_deref(),
                Some("tg-abc")
            );
        });
        s.request_account_deletion("tg-abc", &json!([])).unwrap();
        s.erase_account("tg-abc").unwrap();
        s.with_conn_for_tests(|c| {
            let count = |sql: &str| c.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap();
            assert_eq!(count("SELECT count(*) FROM llm_usage_daily WHERE email LIKE 'tg-abc%'"), 0);
            assert_eq!(
                count(&format!(
                    "SELECT count(*) FROM llm_usage_erased WHERE email_sha256='{}'",
                    crate::llm_usage::erased_key("tg-abc@users.invalid")
                )),
                1
            );
            assert_eq!(count("SELECT count(*) FROM invitations WHERE telegram_username='dan_user'"), 0);
            assert_eq!(count("SELECT count(*) FROM invitations WHERE telegram_username='other_person'"), 1);
            assert_eq!(count("SELECT count(*) FROM audit_events WHERE audit_event_id='a1' AND json_extract(metadata_json,'$.telegram') IS NULL AND json_extract(metadata_json,'$.role')='member'"), 1);
        });
    }
}
