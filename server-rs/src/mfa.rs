//! The second factor on the hub's own sign-in.
//!
//! The first factor (a Google/Telegram/OIDC account, a sign-in link, a token the
//! acme.test platform minted with the shared SSO secret) says WHO. For a person
//! who turned TOTP on — and for every platform admin once `CC_REMOTE_ADMIN_MFA=required`
//! is set on the hub — it is not enough to open the product: the hub controls
//! every fleet machine, so a forged first factor must not be an admin session.
//!
//! How it works, in three sentences. Every path that mints a session goes through
//! one decision (`mfa_pending_in`): when the person needs a second factor and the
//! path did not check one itself, the `auth_sessions` row is born with
//! `mfa_pending=1`. `WorkspaceStore::authenticate` — the one choke point every
//! HTTP gate, the `/ui` and `/mobile/ui` sockets and the bearer paths pass
//! through — refuses a pending row like an unknown token. Only the handlers in
//! this file (`/api/auth/mfa/state`, `/verify`, the enrolment endpoints) and
//! logout look at a pending session, through `authenticate_pending`, and
//! `/verify` flips THIS session (and no other) to satisfied.
//!
//! Rows that existed when this shipped keep `mfa_pending=0` (the column's
//! default): nobody is signed out by the rollout.
//!
//! The external edition keeps its own rule (the owner's TOTP is checked in the
//! password sign-in itself), so `mfa_required` is false there.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::RwLock;

use axum::extract::ConnectInfo;
use rusqlite::{params, Connection, OptionalExtension};

use super::*;
use crate::workspace::{db_err, hash_token, insert_audit, now_ms, opaque_token, WorkspaceStore};

/// Did the path that minted a session check a second factor itself?
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Factor {
    /// No: the session is pending when the person needs one.
    Unproven,
    /// Yes (a local sign-in with its code, a hand-off whose browser session
    /// already passed `/verify`, a root-minted tool session).
    Proven,
}

/// Who must prove a second factor, besides everyone with a confirmed TOTP.
#[derive(Default)]
pub struct MfaPolicy {
    admins: RwLock<HashSet<String>>,
    admin_required: AtomicBool,
}

/// What `authenticate_pending` knows about a live session.
#[derive(Debug, Clone)]
pub struct SessionMfa {
    pub user_id: String,
    pub pending: bool,
    pub created_at: i64,
    /// Minted by root (`fixed_expiry`): a tool session or an enrolment link's.
    pub tool: bool,
    /// Opened by an enrolment link (`mfa_enrol`): the only session that may
    /// enrol an admin's authenticator. Never derived from the label.
    pub enrol: bool,
    /// The native hand-off kept for a retry (see `HAND_OFF_RETRY_MS`).
    pub next: Option<String>,
    /// When it became pending / satisfied (`mfa_pending_at`, else `created_at`).
    pub since: i64,
}

/// What a committed enrolment hands back.
pub(crate) struct EnrolDone {
    pub codes: Vec<String>,
    pub held: Option<String>,
    pub demoted: usize,
}

/// After a verify the hand-off stays retrievable from the SAME browser session
/// for this long (a lost response must not strand the app); then it is gone.
pub(crate) const HAND_OFF_RETRY_MS: i64 = 2 * 60 * 1000;

/// A pending session lives this long from the moment it became pending; past
/// it the person signs in again.
pub(crate) const PENDING_TTL_MS: i64 = 10 * 60 * 1000;

/// `auth_sessions` columns: `mfa_pending` (0 for every row that exists),
/// `mfa_next` (a native hand-off held back until verified), `mfa_pending_at`
/// (when it became pending: the 10-minute life of a pending session) and
/// `fixed_expiry` (a tool session does not slide); plus the failed-attempt log
/// and the enrolment links. Additive and idempotent.
pub(crate) fn migrate_session_columns(conn: &Connection) -> Result<(), String> {
    for (column, ddl) in [
        (
            "mfa_pending",
            "ALTER TABLE auth_sessions ADD COLUMN mfa_pending INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "mfa_next",
            "ALTER TABLE auth_sessions ADD COLUMN mfa_next TEXT",
        ),
        (
            "fixed_expiry",
            "ALTER TABLE auth_sessions ADD COLUMN fixed_expiry INTEGER NOT NULL DEFAULT 0",
        ),
    ] {
        let present: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('auth_sessions') WHERE name=?1",
                params![column],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if present == 0 {
            conn.execute(ddl, []).map_err(db_err)?;
        }
    }
    if conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('auth_sessions') WHERE name='mfa_enrol'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .map_err(db_err)?
        == 0
    {
        conn.execute(
            "ALTER TABLE auth_sessions ADD COLUMN mfa_enrol INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(db_err)?;
    }
    if conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('auth_sessions') WHERE name='mfa_pending_at'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .map_err(db_err)?
        == 0
    {
        conn.execute(
            "ALTER TABLE auth_sessions ADD COLUMN mfa_pending_at INTEGER",
            [],
        )
        .map_err(db_err)?;
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS mfa_attempts (key TEXT NOT NULL, at INTEGER NOT NULL);
         CREATE INDEX IF NOT EXISTS mfa_attempts_key ON mfa_attempts(key, at);
         CREATE TABLE IF NOT EXISTS mfa_enroll_links (
           token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL,
           expires_at INTEGER NOT NULL, used_at INTEGER
         );",
    )
    .map_err(db_err)?;
    Ok(())
}

/// `CC_REMOTE_ADMIN_MFA=required` (anything else is off).
pub(crate) fn admin_mfa_from_env() -> bool {
    std::env::var("CC_REMOTE_ADMIN_MFA")
        .map(|v| v.trim().eq_ignore_ascii_case("required"))
        .unwrap_or(false)
}

impl WorkspaceStore {
    /// Called once at startup: the platform admins and whether they must hold
    /// a second factor.
    pub fn set_admin_mfa(&self, admins: impl IntoIterator<Item = String>, required: bool) {
        if let Ok(mut set) = self.mfa.admins.write() {
            *set = admins.into_iter().collect();
        }
        self.mfa.admin_required.store(required, Ordering::SeqCst);
    }

    /// Is `user_id` a platform admin on whom `CC_REMOTE_ADMIN_MFA` bites?
    pub(crate) fn admin_mfa_applies(&self, user_id: &str) -> bool {
        self.mfa.admin_required.load(Ordering::SeqCst)
            && self
                .mfa
                .admins
                .read()
                .map(|set| set.contains(user_id))
                .unwrap_or(true)
    }

    /// `mfa_required` on an open connection. Fails CLOSED: a database error
    /// reads as "required".
    pub(crate) fn mfa_required_in(&self, conn: &Connection, user_id: &str) -> bool {
        if crate::edition::is_external() {
            return false;
        }
        match crate::user_totp::is_enrolled(conn, user_id) {
            Ok(true) => true,
            Ok(false) => self.admin_mfa_applies(user_id),
            Err(_) => true,
        }
    }

    /// Must `user_id` prove a second factor to sign in? True with a CONFIRMED
    /// authenticator, or for a platform admin while `CC_REMOTE_ADMIN_MFA=required`.
    pub fn mfa_required(&self, user_id: &str) -> bool {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        self.mfa_required_in(&conn, user_id)
    }

    /// The ONE decision every insert into `auth_sessions` takes: the value of
    /// `mfa_pending` for a session of `user_id` minted by a path that did
    /// (`Proven`) or did not (`Unproven`) check a second factor itself.
    pub(crate) fn mfa_pending_in(&self, conn: &Connection, user_id: &str, factor: Factor) -> i64 {
        match factor {
            Factor::Proven => 0,
            Factor::Unproven => i64::from(self.mfa_required_in(conn, user_id)),
        }
    }

    /// The live session behind `token` — pending or not — for the handlers
    /// that may serve a pending one. Never slides, never used for access.
    pub fn authenticate_pending(&self, token: &str) -> Result<Option<SessionMfa>, String> {
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.query_row(
            "SELECT user_id,mfa_pending,created_at,fixed_expiry,label,mfa_enrol,mfa_next,COALESCE(mfa_pending_at,created_at) FROM auth_sessions \
             WHERE token_hash=?1 AND expires_at>?2 AND created_at>?3 AND ui_scope IS NULL \
             AND (mfa_pending=0 OR COALESCE(mfa_pending_at,created_at)>?4)",
            params![
                hash_token(token),
                now,
                now - crate::workspace::SESSION_MAX_MS,
                now - PENDING_TTL_MS
            ],
            |r| {
                Ok(SessionMfa {
                    user_id: r.get(0)?,
                    pending: r.get::<_, i64>(1)? != 0,
                    created_at: r.get(2)?,
                    tool: r.get::<_, i64>(3)? != 0,
                    enrol: r.get::<_, i64>(5)? != 0,
                    next: r.get(6)?,
                    since: r.get(7)?,
                })
            },
        )
        .optional()
        .map_err(db_err)
    }

    /// Hold a native hand-off on the pending session until it is verified.
    pub(crate) fn set_mfa_next(&self, token: &str, next: &str) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.execute(
            "UPDATE auth_sessions SET mfa_next=?2 WHERE token_hash=?1 AND mfa_pending=1",
            params![hash_token(token), next],
        )
        .map(|_| ())
        .map_err(db_err)
    }

    /// Flip THIS session to satisfied. `Some(next)` when it was pending (with
    /// the hand-off it held), `None` when it was not (or is gone).
    #[cfg(test)]
    pub(crate) fn satisfy_session(&self, token: &str) -> Result<Option<Option<String>>, String> {
        let hash = hash_token(token);
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let next: Option<Option<String>> = conn
            .query_row(
                "SELECT mfa_next FROM auth_sessions WHERE token_hash=?1 AND mfa_pending=1 AND ui_scope IS NULL \
                 AND COALESCE(mfa_pending_at,created_at)>?2",
                params![hash, now_ms() - PENDING_TTL_MS],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        let Some(next) = next else { return Ok(None) };
        let changed = conn
            .execute(
                "UPDATE auth_sessions SET mfa_pending=0, mfa_pending_at=?2 WHERE token_hash=?1 AND mfa_pending=1",
                params![hash, now_ms()],
            )
            .map_err(db_err)?;
        Ok((changed == 1).then_some(next))
    }

    /// Is the session with this token HASH live, `user_id`'s and satisfied?
    /// The Android hand-off code is released only against such a session.
    pub(crate) fn session_satisfied_for(&self, hash: &str, user_id: &str) -> bool {
        let now = now_ms();
        let Ok(conn) = self.conn.lock() else {
            return false;
        };
        conn.query_row(
            "SELECT 1 FROM auth_sessions WHERE token_hash=?1 AND user_id=?2 AND mfa_pending=0 \
             AND expires_at>?3 AND created_at>?4 AND ui_scope IS NULL",
            params![hash, user_id, now, now - crate::workspace::SESSION_MAX_MS],
            |_| Ok(()),
        )
        .optional()
        .map(|v| v.is_some())
        .unwrap_or(false)
    }

    /// End a session by token (a minted session that must not be handed out).
    pub(crate) fn drop_session(&self, token: &str) {
        if let Ok(conn) = self.conn.lock() {
            let _ = conn.execute(
                "DELETE FROM auth_sessions WHERE token_hash=?1",
                params![hash_token(token)],
            );
        }
    }

    /// The iOS hand-off was released: the browser session now lives only for
    /// the retry window and is marked so a retry gets a fresh app session.
    pub(crate) fn keep_for_retry(&self, token: &str, marker: &str) {
        if let Ok(conn) = self.conn.lock() {
            let now = now_ms();
            let _ = conn.execute(
                "UPDATE auth_sessions SET mfa_next=?2, mfa_pending_at=?3, fixed_expiry=1, \
                 expires_at=MIN(expires_at, ?4) WHERE token_hash=?1",
                params![hash_token(token), marker, now, now + HAND_OFF_RETRY_MS],
            );
        }
    }

    /// Take the one re-delivery of an iOS hand-off: true for exactly one caller.
    pub(crate) fn claim_retry(&self, token: &str) -> bool {
        let Ok(conn) = self.conn.lock() else {
            return false;
        };
        conn.execute(
            "UPDATE auth_sessions SET mfa_next=?3 WHERE token_hash=?1 AND mfa_next=?2",
            params![hash_token(token), NATIVE_RETRY, NATIVE_SPENT],
        )
        .map(|n| n == 1)
        .unwrap_or(false)
    }

    /// Verify the code AND satisfy this session in ONE immediate transaction:
    /// the session must be this user's live pending one, the code is checked
    /// and burned, and only then the session flips — a concurrent `mfa-reset`
    /// (another process) can neither be undone by it nor see a half-done state.
    /// `Ok(Some(held))` on success (the hand-off the session held), `Ok(None)`
    /// for a wrong code or a session that is not pending any more.
    pub(crate) fn verify_and_satisfy_session(
        &self,
        token: &str,
        user_id: &str,
        code: &str,
        unix_secs: u64,
    ) -> Result<Option<Option<String>>, String> {
        let hash = hash_token(token);
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx =
            rusqlite::Transaction::new_unchecked(&conn, rusqlite::TransactionBehavior::Immediate)
                .map_err(db_err)?;
        let held: Option<Option<String>> = tx
            .query_row(
                "SELECT mfa_next FROM auth_sessions WHERE token_hash=?1 AND user_id=?2 AND mfa_pending=1 \
                 AND ui_scope IS NULL AND expires_at>?3 AND COALESCE(mfa_pending_at,created_at)>?4",
                params![hash, user_id, now_ms(), now_ms() - PENDING_TTL_MS],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        let Some(held) = held else { return Ok(None) };
        if !crate::user_totp::verify(&tx, user_id, code, unix_secs).map_err(db_err)? {
            // The burn of a failed check changes nothing; commit keeps it simple.
            tx.commit().map_err(db_err)?;
            return Ok(None);
        }
        let changed = tx
            .execute(
                "UPDATE auth_sessions SET mfa_pending=0, mfa_pending_at=?2 WHERE token_hash=?1 AND mfa_pending=1",
                params![hash, now_ms()],
            )
            .map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok((changed == 1).then_some(held))
    }

    /// Confirm an enrolment and everything that follows from it in ONE
    /// immediate transaction: the code, the person's unused enrolment links,
    /// this session (satisfied), every OTHER ordinary session (demoted) and the
    /// audit row. The recovery codes exist outside it only after the commit.
    pub(crate) fn confirm_enrolment(
        &self,
        token: &str,
        user_id: &str,
        code: &str,
        unix_secs: u64,
        device: &str,
    ) -> Result<Option<EnrolDone>, String> {
        let hash = hash_token(token);
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx =
            rusqlite::Transaction::new_unchecked(&conn, rusqlite::TransactionBehavior::Immediate)
                .map_err(db_err)?;
        let Some(codes) =
            crate::user_totp::confirm(&tx, user_id, code, unix_secs).map_err(db_err)?
        else {
            return Ok(None);
        };
        tx.execute(
            "DELETE FROM mfa_enroll_links WHERE user_id=?1 AND used_at IS NULL",
            params![user_id],
        )
        .map_err(db_err)?;
        let held: Option<Option<String>> = tx
            .query_row(
                "SELECT mfa_next FROM auth_sessions WHERE token_hash=?1 AND mfa_pending=1 AND ui_scope IS NULL",
                params![hash],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        tx.execute(
            "UPDATE auth_sessions SET mfa_pending=0, mfa_pending_at=?2 WHERE token_hash=?1 AND mfa_pending=1",
            params![hash, now_ms()],
        )
        .map_err(db_err)?;
        let demoted = tx
            .execute(
                "UPDATE auth_sessions SET mfa_pending=1, mfa_next=NULL, mfa_pending_at=?3 \
                 WHERE user_id=?1 AND token_hash<>?2 AND ui_scope IS NULL AND fixed_expiry=0 AND mfa_pending=0",
                params![user_id, hash, now_ms()],
            )
            .map_err(db_err)?;
        if let Some(workspace) = crate::access::audit_workspace_in(&tx, user_id)? {
            insert_audit(
                &tx,
                &workspace,
                user_id,
                "auth.mfa.enrolled",
                "user",
                user_id,
                &json!({"device": device, "demotedSessions": demoted}),
            )?;
        }
        tx.commit().map_err(db_err)?;
        Ok(Some(EnrolDone {
            codes,
            held: held.flatten(),
            demoted,
        }))
    }

    /// Verify a code and replace the recovery codes in ONE immediate
    /// transaction (a reset in between cannot leave fresh codes behind).
    pub(crate) fn verify_and_regenerate(
        &self,
        user_id: &str,
        code: &str,
        unix_secs: u64,
    ) -> Result<Option<Vec<String>>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx =
            rusqlite::Transaction::new_unchecked(&conn, rusqlite::TransactionBehavior::Immediate)
                .map_err(db_err)?;
        if !crate::user_totp::verify(&tx, user_id, code, unix_secs).map_err(db_err)? {
            tx.commit().map_err(db_err)?;
            return Ok(None);
        }
        let codes = crate::user_totp::regenerate_recovery(&tx, user_id).map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(codes)
    }

    /// End a session by token HASH.
    pub(crate) fn drop_session_hash(&self, hash: &str) {
        if let Ok(conn) = self.conn.lock() {
            let _ = conn.execute(
                "DELETE FROM auth_sessions WHERE token_hash=?1",
                params![hash],
            );
        }
    }

    /// At start with `CC_REMOTE_ADMIN_MFA=required`: an admin's ordinary session
    /// older than their authenticator predates the factor (it may be a forged
    /// one) and is demoted; an admin with NO authenticator has every ordinary
    /// session demoted (they use `mfa-enroll-link`). Idempotent.
    pub fn demote_stale_admin_sessions(&self) -> usize {
        if !self.mfa.admin_required.load(Ordering::SeqCst) {
            return 0;
        }
        let admins: Vec<String> = self
            .mfa
            .admins
            .read()
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default();
        let Ok(conn) = self.conn.lock() else { return 0 };
        admins
            .iter()
            .map(|admin| {
                conn.execute(
                    "UPDATE auth_sessions SET mfa_pending=1, mfa_next=NULL, mfa_pending_at=?2 \
                     WHERE user_id=?1 AND ui_scope IS NULL AND fixed_expiry=0 AND mfa_pending=0 \
                     AND created_at < COALESCE((SELECT confirmed_at FROM user_totp WHERE user_id=?1), 9223372036854775807)",
                    params![admin, now_ms()],
                )
                .unwrap_or(0)
            })
            .sum()
    }

    /// Count this attempt against the person and the session, or refuse it —
    /// check and record in ONE transaction, persisted across restarts.
    /// Per account AND session: `SESSION_ATTEMPTS` in the window (a typo on one
    /// device does not cost another). Across all of the account's sessions: a
    /// growing delay (1 s doubling to 30 s after the third attempt), never a
    /// lock — an attacker must not be able to shut the real admin out.
    /// `Err(seconds)` is the wait.
    pub(crate) fn mfa_attempt(&self, user_id: &str, session_hash: &str) -> Result<(), i64> {
        let now = now_ms();
        let Ok(conn) = self.conn.lock() else {
            return Err(30);
        };
        let Ok(tx) =
            rusqlite::Transaction::new_unchecked(&conn, rusqlite::TransactionBehavior::Immediate)
        else {
            return Err(30);
        };
        let skey = format!("s:{user_id}:{session_hash}");
        let dkey = format!("d:{user_id}");
        let run = || -> rusqlite::Result<Result<(), i64>> {
            // Session counts live 15 minutes; the account's day counter 24 hours.
            tx.execute(
                "DELETE FROM mfa_attempts WHERE (key LIKE 's:%' AND at<?1) OR at<?2",
                params![now - ATTEMPT_WINDOW_MS, now - DAY_MS],
            )?;
            let count = |key: &str| -> rusqlite::Result<(i64, i64)> {
                tx.query_row(
                    "SELECT COUNT(*), COALESCE(MAX(at),0) FROM mfa_attempts WHERE key=?1",
                    params![key],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
            };
            let (session_n, session_last) = count(&skey)?;
            if session_n >= SESSION_ATTEMPTS {
                let wait = (session_last + ATTEMPT_WINDOW_MS - now) / 1000 + 1;
                return Ok(Err(wait.max(1)));
            }
            let (user_n, user_last) = count(&dkey)?;
            if user_n >= 3 {
                let delay_ms = (1000_i64 << (user_n - 3).min(20)).min(MAX_DELAY_MS);
                if now - user_last < delay_ms {
                    return Ok(Err((delay_ms - (now - user_last)) / 1000 + 1));
                }
            }
            for key in [&skey, &dkey] {
                tx.execute(
                    "INSERT INTO mfa_attempts(key,at) VALUES(?1,?2)",
                    params![key, now],
                )?;
            }
            Ok(Ok(()))
        };
        match run() {
            Ok(Ok(())) => tx.commit().map(|_| ()).map_err(|_| 30),
            Ok(Err(wait)) => {
                let _ = tx.commit();
                Err(wait)
            }
            Err(_) => Err(30),
        }
    }

    /// A right code clears the SESSION's count and takes back the one account
    /// attempt it just spent; the account's 24 h failure count stays, so a
    /// guesser who finally lands a code does not reset the slowdown.
    pub(crate) fn mfa_attempts_clear(&self, user_id: &str, session_hash: &str) {
        if let Ok(conn) = self.conn.lock() {
            let _ = conn.execute(
                "DELETE FROM mfa_attempts WHERE key=?1",
                params![format!("s:{user_id}:{session_hash}")],
            );
            let _ = conn.execute(
                "DELETE FROM mfa_attempts WHERE rowid=(SELECT MAX(rowid) FROM mfa_attempts WHERE key=?1)",
                params![format!("d:{user_id}")],
            );
        }
    }

    /// Attempts on this account in the last 24 hours (the slowdown's input).
    pub(crate) fn mfa_failures_24h(&self, user_id: &str) -> i64 {
        let Ok(conn) = self.conn.lock() else { return 0 };
        conn.query_row(
            "SELECT COUNT(*) FROM mfa_attempts WHERE key=?1 AND at>?2",
            params![format!("d:{user_id}"), now_ms() - DAY_MS],
            |r| r.get(0),
        )
        .unwrap_or(0)
    }

    /// Mint the one-time link `mfa-enroll-link` prints: only its hash is kept.
    pub(crate) fn mint_enroll_link(&self, user_id: &str, ttl_ms: i64) -> Result<String, String> {
        let token = opaque_token();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        tx.execute(
            "INSERT INTO mfa_enroll_links(token_hash,user_id,expires_at) VALUES(?1,?2,?3)",
            params![hash_token(&token), user_id, now_ms() + ttl_ms],
        )
        .map_err(db_err)?;
        if let Some(workspace) = crate::access::audit_workspace_in(&tx, user_id)? {
            insert_audit(
                &tx,
                &workspace,
                user_id,
                "auth.mfa.enroll_link_minted",
                "user",
                user_id,
                &json!({"ttlSeconds": ttl_ms / 1000}),
            )?;
        }
        tx.commit().map_err(db_err)?;
        Ok(token)
    }

    /// Spend an enrolment link: its person gets a fixed-expiry (10 min),
    /// satisfied session labelled `tool:enrol`. Single use.
    /// Whose live, unused enrolment link `token` is — read-only, so the handler
    /// can refuse an inactive account BEFORE the link is spent or a session is
    /// minted. `open_enroll_link` checks the link again in its transaction.
    pub(crate) fn peek_enroll_link_user(&self, token: &str) -> Result<Option<String>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.query_row(
            "SELECT user_id FROM mfa_enroll_links WHERE token_hash=?1 AND used_at IS NULL AND expires_at>?2",
            params![hash_token(token), now_ms()],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_err)
    }

    pub(crate) fn open_enroll_link(&self, token: &str) -> Result<(String, String), String> {
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        // Checking the person, spending the link, minting the session and its
        // audit row are ONE transaction: a failure in the middle leaves the
        // link whole.
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let hash = hash_token(token);
        let user: Option<String> = tx
            .query_row(
                "SELECT user_id FROM mfa_enroll_links WHERE token_hash=?1 AND used_at IS NULL AND expires_at>?2",
                params![hash, now],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        let Some(user) = user else {
            return Err("invalid_link".into());
        };
        // Someone who has an authenticator by now (the link outlived the
        // need) must not get an enrolment session from it.
        if crate::user_totp::is_enrolled(&tx, &user).map_err(db_err)? {
            return Err("invalid_link".into());
        }
        let spent = tx
            .execute(
                "UPDATE mfa_enroll_links SET used_at=?2 WHERE token_hash=?1 AND used_at IS NULL",
                params![hash, now],
            )
            .map_err(db_err)?;
        if spent != 1 {
            return Err("invalid_link".into());
        }
        let session = Self::mint_tool_session_in(&tx, &user, ENROL_TTL_MS, "enrol", true)?;
        tx.commit().map_err(db_err)?;
        Ok((user, session))
    }

    /// Unused enrolment links of a person stop being good once they enrol (or
    /// are reset): they would open a session for a phone that is not theirs.
    #[cfg(test)]
    pub(crate) fn drop_enroll_links(&self, user_id: &str) {
        if let Ok(conn) = self.conn.lock() {
            let _ = conn.execute(
                "DELETE FROM mfa_enroll_links WHERE user_id=?1 AND used_at IS NULL",
                params![user_id],
            );
        }
    }

    /// A satisfied session minted by root on the hub box for an internal tool
    /// (tgbot, `deploy/term.sh`, the smokes): it never slides, ends at `ttl_ms`
    /// and is audited as `auth.tool_session` in the person's own trail.
    pub(crate) fn mint_tool_session(
        &self,
        user_id: &str,
        ttl_ms: i64,
        note: &str,
    ) -> Result<String, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let token = Self::mint_tool_session_in(&tx, user_id, ttl_ms, note, false)?;
        tx.commit().map_err(db_err)?;
        Ok(token)
    }

    /// The insert and its audit row, inside the caller's transaction.
    fn mint_tool_session_in(
        tx: &Connection,
        user_id: &str,
        ttl_ms: i64,
        note: &str,
        enrol: bool,
    ) -> Result<String, String> {
        let token = opaque_token();
        let now = now_ms();
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM users WHERE user_id=?1)",
                params![user_id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if !exists {
            return Err("no such user".into());
        }
        let Some(workspace) = crate::access::audit_workspace_in(tx, user_id)? else {
            return Err("no_audit_trail".into());
        };
        tx.execute(
            "INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at,label,mfa_pending,fixed_expiry,mfa_enrol) VALUES(?1,?2,?3,?4,?5,0,1,?6)",
            params![hash_token(&token), user_id, now + ttl_ms, now, format!("tool:{note}"), i64::from(enrol)],
        )
        .map_err(db_err)?;
        insert_audit(
            tx,
            &workspace,
            user_id,
            "auth.tool_session",
            "user",
            user_id,
            &json!({"note": note, "ttlSeconds": ttl_ms / 1000}),
        )?;
        Ok(token)
    }

    pub(crate) fn mfa_required_enrolled(&self, user_id: &str) -> bool {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        crate::user_totp::is_enrolled(&conn, user_id).unwrap_or(true)
    }

    /// Delete the user's authenticator (lost phone). Audited as `auth.mfa.reset`.
    pub(crate) fn mfa_reset(&self, user_id: &str) -> Result<bool, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let removed = crate::user_totp::reset(&tx, user_id).map_err(db_err)?;
        tx.execute(
            "DELETE FROM mfa_enroll_links WHERE user_id=?1 AND used_at IS NULL",
            params![user_id],
        )
        .map_err(db_err)?;
        // A lost phone: every ordinary session of the person is untrusted now.
        // (The CLI cannot know the hub's flag, so this is not conditional.)
        tx.execute(
            "UPDATE auth_sessions SET mfa_pending=1, mfa_next=NULL, mfa_pending_at=?2 \
             WHERE user_id=?1 AND ui_scope IS NULL AND fixed_expiry=0 AND mfa_pending=0",
            params![user_id, now_ms()],
        )
        .map_err(db_err)?;
        if let Some(workspace) = crate::access::audit_workspace_in(&tx, user_id)? {
            insert_audit(
                &tx,
                &workspace,
                user_id,
                "auth.mfa.reset",
                "user",
                user_id,
                &json!({"removed": removed}),
            )?;
        }
        tx.commit().map_err(db_err)?;
        Ok(removed)
    }
}

// --------------------------------------------------------------------- CLI

/// `10s`, `30m`, `2h`, `7d` in milliseconds; a bare number is seconds.
fn parse_duration_ms(raw: &str) -> Option<i64> {
    let raw = raw.trim();
    let (digits, unit) = match raw.char_indices().last()? {
        (i, c) if c.is_ascii_alphabetic() => (&raw[..i], c.to_ascii_lowercase()),
        _ => (raw, 's'),
    };
    let n: i64 = digits.parse().ok().filter(|n| *n > 0)?;
    let mult = match unit {
        's' => 1_000,
        'm' => 60_000,
        'h' => 3_600_000,
        'd' => 86_400_000,
        _ => return None,
    };
    n.checked_mul(mult)
}

fn open_for_cli(db_path: &std::path::Path) -> Result<WorkspaceStore, i32> {
    if !db_path.is_file() {
        eprintln!(
            "database {} not found (CC_REMOTE_DB_PATH)",
            db_path.display()
        );
        return Err(1);
    }
    WorkspaceStore::open(db_path).map_err(|e| {
        eprintln!("cannot open the database: {e}");
        1
    })
}

/// `cc-remote-server mint-tool-session --user <id> --ttl <dur> --note <name>`:
/// print one satisfied session token. Runs on the hub box as root.
pub(crate) fn run_tool_session_cli(args: &[String], db_path: &std::path::Path) -> i32 {
    let (mut user, mut ttl, mut note) = (None, None, None);
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--user" => user = it.next().cloned(),
            "--ttl" => ttl = it.next().and_then(|v| parse_duration_ms(v)),
            "--note" => note = it.next().cloned(),
            other => {
                eprintln!("unknown argument {other}");
                return 2;
            }
        }
    }
    let (Some(user), Some(ttl), Some(note)) = (user, ttl, note) else {
        eprintln!(
            "usage: cc-remote-server mint-tool-session --user <user_id> --ttl <10m|2h|30d> --note <name>"
        );
        return 2;
    };
    if note.is_empty()
        || note.len() > 40
        || !note
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    {
        eprintln!("--note: 1..40 characters of [A-Za-z0-9._-]");
        return 2;
    }
    if ttl > crate::workspace::SESSION_MAX_MS {
        eprintln!("--ttl: at most 180d");
        return 2;
    }
    let store = match open_for_cli(db_path) {
        Ok(s) => s,
        Err(code) => return code,
    };
    match store.mint_tool_session(&user, ttl, &note) {
        Ok(token) => {
            println!("{token}");
            0
        }
        Err(e) => {
            eprintln!("cannot mint: {}", client_safe_error(&e));
            1
        }
    }
}

/// `cc-remote-server mfa-reset --email <e>`: delete the user's authenticator.
pub(crate) fn run_mfa_reset_cli(args: &[String], db_path: &std::path::Path) -> i32 {
    let mut email = None;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--email" => email = it.next().cloned(),
            other => {
                eprintln!("unknown argument {other}");
                return 2;
            }
        }
    }
    let Some(email) = email
        .map(|e| crate::workspace::normalize_email(&e))
        .filter(|e| e.contains('@'))
    else {
        eprintln!("usage: cc-remote-server mfa-reset --email <address>");
        return 2;
    };
    let store = match open_for_cli(db_path) {
        Ok(s) => s,
        Err(code) => return code,
    };
    let found = match store.user_ids_by_email(std::slice::from_ref(&email)) {
        Ok(rows) => rows.into_iter().next(),
        Err(e) => {
            eprintln!("database error: {}", client_safe_error(&e));
            return 1;
        }
    };
    let Some((user_id, _)) = found else {
        eprintln!("no account with the address {email}");
        return 1;
    };
    match store.mfa_reset(&user_id) {
        Ok(true) => {
            println!(
                "authenticator of {email} ({user_id}) removed. Next step: for a platform admin run \
                 `mfa-enroll-link --email {email}` and give them the one-time URL (a pending session \
                 may not enrol); anyone else signs in and enrols from Настройки within ten minutes."
            );
            0
        }
        Ok(false) => {
            println!("{email} had no authenticator; nothing to remove");
            0
        }
        Err(e) => {
            eprintln!("cannot reset: {}", client_safe_error(&e));
            1
        }
    }
}

/// `cc-remote-server mfa-enroll-link --email <e> [--ttl 10m]`: print a one-time
/// URL (`<public>/mfa-enroll#token=…`, the token in the fragment) that opens a
/// 10-minute enrolment session. The only way a platform admin enrols.
pub(crate) fn run_enroll_link_cli(
    args: &[String],
    db_path: &std::path::Path,
    public_url: &str,
) -> i32 {
    let (mut email, mut ttl) = (None, 10 * 60 * 1000);
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--email" => email = it.next().cloned(),
            "--ttl" => match it.next().and_then(|v| parse_duration_ms(v)) {
                Some(t) if t <= 3_600_000 => ttl = t,
                _ => {
                    eprintln!("--ttl: up to 1h");
                    return 2;
                }
            },
            other => {
                eprintln!("unknown argument {other}");
                return 2;
            }
        }
    }
    let Some(email) = email
        .map(|e| crate::workspace::normalize_email(&e))
        .filter(|e| e.contains('@'))
    else {
        eprintln!("usage: cc-remote-server mfa-enroll-link --email <address> [--ttl 10m]");
        return 2;
    };
    let store = match open_for_cli(db_path) {
        Ok(s) => s,
        Err(code) => return code,
    };
    let Some((user_id, _)) = store
        .user_ids_by_email(std::slice::from_ref(&email))
        .ok()
        .and_then(|rows| rows.into_iter().next())
    else {
        eprintln!("no account with the address {email}");
        return 1;
    };
    if store.mfa_required_enrolled(&user_id) {
        eprintln!("{email} already has an authenticator; `mfa-reset --email {email}` first if the phone is lost");
        return 1;
    }
    match store.mint_enroll_link(&user_id, ttl) {
        Ok(token) => {
            println!(
                "{}/mfa-enroll#token={token}",
                public_url.trim_end_matches('/')
            );
            0
        }
        Err(e) => {
            eprintln!("cannot mint: {}", client_safe_error(&e));
            1
        }
    }
}

// -------------------------------------------------------------------- HTTP

/// Failed-attempt budget of `/verify` (and `/disable`, `/recovery`): per
/// account and per address, in a 15-minute window. Every ATTEMPT is counted
/// before the code is looked at — counting only failures would let a burst of
/// parallel guesses all pass the check before any of them was recorded.
const IP_ATTEMPTS: usize = 10;
const ATTEMPT_WINDOW_MS: i64 = 15 * 60 * 1000;
/// Attempts one session of one account may make in the window.
const SESSION_ATTEMPTS: i64 = 5;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// The account-wide slowdown grows from 1 s to this; never a lock.
const MAX_DELAY_MS: i64 = 15 * 60 * 1000;
pub(crate) const ENROL_TTL_MS: i64 = 10 * 60 * 1000;
const SLOW_DOWN: &str = "слишком много попыток, подождите несколько минут";

/// Every session token the request carries, cookie first.
fn presented_tokens(headers: &HeaderMap) -> Vec<String> {
    [auth_cookie_token(headers), bearer_token(headers)]
        .into_iter()
        .flatten()
        .collect()
}

/// The first presented token that is a live session — pending or not.
pub(crate) fn live_session(
    st: &AppState,
    headers: &HeaderMap,
) -> Result<(String, SessionMfa), Response> {
    for token in presented_tokens(headers) {
        match st.workspaces.authenticate_pending(&token) {
            Ok(Some(session)) => return Ok((token, session)),
            Ok(None) => {}
            Err(e) => return Err(store_failure(e)),
        }
    }
    Err(api_error(
        StatusCode::UNAUTHORIZED,
        "authentication required",
    ))
}

/// One attempt at a code, from `session_hash` of `user`: the persisted
/// per-session budget and per-account slowdown (`mfa_attempt`), then the
/// all-accounts address cap. A right code clears the person's count
/// (`mfa_attempts_clear`), so successes never use the budget up.
fn attempt_gate(
    st: &AppState,
    user: &str,
    session_hash: &str,
    peer: std::net::SocketAddr,
    headers: &HeaderMap,
) -> Result<(), Response> {
    let ip = crate::rate_window::rate_ip(Some(&client_address(peer, headers)));
    let ip_key = check_window_quota(
        st,
        &format!("mfa-ip:{}", ip.as_deref().unwrap_or("?")),
        IP_ATTEMPTS,
        ATTEMPT_WINDOW_MS,
        SLOW_DOWN,
    )?;
    if let Err(wait) = st.workspaces.mfa_attempt(user, session_hash) {
        let mut res = refusal(
            StatusCode::TOO_MANY_REQUESTS,
            format!("слишком много попыток, подождите {wait} с"),
        );
        if let Ok(v) = HeaderValue::from_str(&wait.to_string()) {
            res.headers_mut().insert(header::RETRY_AFTER, v);
        }
        return Err(res);
    }
    record_window_hit(st, &ip_key, ATTEMPT_WINDOW_MS);
    Ok(())
}

/// An audit row in the person's own trail; never carries a code.
fn audit(st: &AppState, user: &str, action: &str, meta: Value) {
    let conn = st.workspaces.conn.lock().unwrap_or_else(|e| e.into_inner());
    if let Ok(Some(workspace)) = crate::access::audit_workspace_in(&conn, user) {
        let _ = insert_audit(&conn, &workspace, user, action, "user", user, &meta);
    }
}

fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn code_of(body: &Bytes) -> String {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v.get("code").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default()
        .chars()
        .take(64)
        .collect()
}

/// The URL a native app waits for, from what the pending session held. The
/// iOS app never gets the BROWSER session's token: it is handed a session of
/// its own (satisfied, 90 days) and the browser session is deleted — the cookie
/// that stays in the system browser must not be the app's credential. Returns
/// the URL and whether the browser's cookie is gone.
fn release_hand_off(st: &AppState, user: &str, token: &str, held: &str) -> Option<(String, bool)> {
    if held == "native" || held == NATIVE_RETRY {
        // Exactly one re-delivery: the retry flips `native-retry` to
        // `native-spent` (one changed row wins), and the window is not reset.
        let retry = held == NATIVE_RETRY;
        if retry && !st.workspaces.claim_retry(token) {
            return None;
        }
        let (app, _) = st
            .workspaces
            .create_auth_session_as(user, 90, Factor::Proven)
            .ok()?;
        if !retry {
            st.workspaces.keep_for_retry(token, NATIVE_RETRY);
        }
        audit(
            st,
            user,
            "auth.mfa.handoff",
            json!({"kind": if retry { "retry" } else { "first" }}),
        );
        return Some((
            format!("{NATIVE_CALLBACK}?session={}", urlencoding::encode(&app)),
            true,
        ));
    }
    held.starts_with("hegai-code://")
        .then(|| (held.to_string(), false))
}

/// What a released iOS hand-off leaves in `mfa_next`.
const NATIVE_RETRY: &str = "native-retry";
/// …and after the one re-delivery.
const NATIVE_SPENT: &str = "native-spent";

/// `body` as a no-store response; `gone` also clears the auth cookie.
fn with_hand_off(st: &AppState, mut out: Value, handed: Option<(String, bool)>) -> Response {
    let mut cleared = false;
    if let Some((next, gone)) = handed {
        out["next"] = Value::String(next);
        cleared = gone;
    }
    let mut response = no_store(Json(out).into_response());
    if cleared {
        response.headers_mut().append(
            header::SET_COOKIE,
            set_cookie_header(AUTH_COOKIE, "", 0, st.public_url.starts_with("https://")),
        );
    }
    response
}

/// `GET /api/auth/mfa/state` -> `{mfa: "none"|"verify"|"blocked", enrolled,
/// adminRequired, canDisable, recoveryLeft?}`. The one thing a pending session
/// may ask: what the sign-in still wants. 401 without a live session.
pub(crate) async fn api_mfa_state(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let (_, session) = gate!(live_session(&st, &headers));
    let user = session.user_id;
    let enrolled = st
        .workspaces
        .with_conn_mfa(|c| crate::user_totp::is_enrolled(c, &user))
        .unwrap_or(false);
    let mfa = match (session.pending, enrolled) {
        (false, _) => "none",
        (true, true) => "verify",
        // An admin held to `CC_REMOTE_ADMIN_MFA` who never enrolled: the first
        // factor alone (maybe a forged SSO token) must not attach a phone.
        (true, false) => "blocked",
    };
    let admin_required = st.workspaces.admin_mfa_applies(&user);
    let mut out = json!({
        "mfa": mfa,
        "enrolled": enrolled,
        "adminRequired": admin_required,
        "canDisable": enrolled && !admin_required && !crate::edition::is_external(),
        // This session came from an enrolment link and may attach a phone.
        "canEnrol": session.enrol && !session.pending,
    });
    if enrolled && !session.pending {
        if let Ok(left) = st
            .workspaces
            .with_conn_mfa(|c| crate::user_totp::recovery_left(c, &user))
        {
            out["recoveryLeft"] = json!(left);
        }
    }
    no_store(Json(out).into_response())
}

/// `POST /api/auth/mfa/verify {code}` -> `{ok, next?}`: a TOTP code or one
/// recovery code; flips THIS session to satisfied. `next` is the native
/// hand-off the sign-in was holding back.
pub(crate) async fn api_mfa_verify(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !same_origin(&headers) {
        return api_error(StatusCode::FORBIDDEN, "cross-site request rejected");
    }
    let (token, session) = gate!(live_session(&st, &headers));
    gate!(require_active(&st, &session.user_id));
    if !session.pending {
        // Idempotent for a lost response: the same browser session may ask for
        // its hand-off again inside the retry window, with no new code.
        if let Some(held) = session
            .next
            .as_deref()
            .filter(|_| now_ms() - session.since < HAND_OFF_RETRY_MS)
        {
            let handed = release_hand_off(&st, &session.user_id, &token, held);
            return with_hand_off(&st, json!({"ok": true}), handed);
        }
        return no_store(Json(json!({"ok": true})).into_response());
    }
    let user = session.user_id;
    gate!(attempt_gate(
        &st,
        &user,
        &hash_token(&token),
        peer,
        &headers
    ));
    let code = code_of(&body);
    let verified = match st.workspaces.verify_and_satisfy_session(
        &token,
        &user,
        &code,
        crate::totp::now_secs(),
    ) {
        Ok(v) => v,
        Err(e) => return store_failure(e),
    };
    let ip = crate::rate_window::rate_ip(Some(&client_address(peer, &headers)));
    let Some(held) = verified else {
        audit(
            &st,
            &user,
            "auth.mfa.failed",
            json!({"ip": ip, "device": device_label(&headers)}),
        );
        let n = st.workspaces.mfa_failures_24h(&user);
        if n >= 10 && n % 10 == 0 {
            audit(&st, &user, "auth.mfa.bruteforce", json!({"attempts24h": n}));
        }
        return api_error(
            StatusCode::BAD_REQUEST,
            "Код не подошёл. Проверьте время на телефоне и введите новый или резервный код.",
        );
    };
    st.workspaces.mfa_attempts_clear(&user, &hash_token(&token));
    audit(
        &st,
        &user,
        "auth.mfa.verified",
        json!({"ip": ip, "device": device_label(&headers)}),
    );
    let handed = held.and_then(|h| release_hand_off(&st, &user, &token, &h));
    with_hand_off(&st, json!({"ok": true}), handed)
}

/// Who may enrol an authenticator on the INTERNAL edition: never a pending
/// session; a platform admin only from an enrolment link's session
/// (`tool:enrol`); anyone else from a satisfied session signed in within
/// `fresh_ms`. Returns the actor and the session token.
pub(crate) fn enroll_actor(
    st: &AppState,
    headers: &HeaderMap,
    fresh_ms: i64,
) -> Result<(String, String), Response> {
    if !same_origin(headers) {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "cross-site request rejected",
        ));
    }
    let (token, session) = live_session(st, headers)?;
    let user = session.user_id;
    if session.pending {
        // Never enrol from a pending session: it proves only the first factor,
        // and whoever forged that (e.g. an SSO token minted with the shared
        // secret) would attach their own phone. An admin enrols from a
        // satisfied session BEFORE `CC_REMOTE_ADMIN_MFA=required` applies to
        // them (deploy/FLEET.md); a stuck one is fixed by the operator.
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "mfa_enroll_blocked: аутентификатор подключается только из уже открытой сессии. Обратитесь к администратору хаба.",
        ));
    } else {
        // A root-minted session enrols only when it IS an enrolment link's
        // (`tool:enrol`): the 2 h tool sessions of term.sh and the bot never do.
        if session.tool && !session.enrol {
            return Err(api_error(
                StatusCode::FORBIDDEN,
                "mfa_enroll_blocked: эта служебная сессия не может подключать аутентификатор",
            ));
        }
        // A platform admin enrols only from a session root minted for it.
        if st.platform_admins.contains(&user) && !session.enrol {
            return Err(api_error(
                StatusCode::FORBIDDEN,
                "mfa_enroll_link_required: администратор подключает аутентификатор по одноразовой ссылке от оператора хаба (mfa-enroll-link)",
            ));
        }
        let age = now_ms() - session.created_at;
        if !(0..=fresh_ms).contains(&age) {
            return Err(api_error(
                StatusCode::FORBIDDEN,
                "fresh_signin_required: выйдите и войдите заново, затем подключите аутентификатор в течение 10 минут",
            ));
        }
    }
    require_active(st, &user)?;
    Ok((user, token))
}

/// The response of a COMMITTED enrolment (`WorkspaceStore::confirm_enrolment`):
/// the recovery codes, a released native hand-off, and the socket refresh for
/// the sessions that were demoted — all after the commit.
pub(crate) fn enrolment_response(
    st: &AppState,
    user: &str,
    token: &str,
    done: EnrolDone,
) -> Response {
    if done.demoted > 0 {
        st.hub.send(HubCmd::RefreshWorkspaceState);
    }
    let handed = done
        .held
        .and_then(|h| release_hand_off(st, user, token, &h));
    with_hand_off(st, json!({"recoveryCodes": done.codes}), handed)
}

/// `POST /api/auth/totp/disable {code}`: turn the authenticator off. Needs a
/// current code; refused for an admin while `CC_REMOTE_ADMIN_MFA=required`.
pub(crate) async fn api_totp_disable(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if crate::edition::is_external() {
        return api_error(StatusCode::NOT_FOUND, "not available on this edition");
    }
    let user = gate!(mutation_user(&headers, &st));
    gate!(require_active(&st, &user));
    if st.workspaces.admin_mfa_applies(&user) {
        return api_error(
            StatusCode::FORBIDDEN,
            "Для администратора двухфакторная защита обязательна, отключить её нельзя.",
        );
    }
    let (token, _) = gate!(live_session(&st, &headers));
    gate!(attempt_gate(
        &st,
        &user,
        &hash_token(&token),
        peer,
        &headers
    ));
    let code = code_of(&body);
    let ok = st
        .workspaces
        .with_conn_mfa(|c| crate::user_totp::verify(c, &user, &code, crate::totp::now_secs()))
        .unwrap_or(false);
    if !ok {
        audit(&st, &user, "auth.mfa.failed", json!({"on": "disable"}));
        return api_error(StatusCode::BAD_REQUEST, "Код не подошёл.");
    }
    if let Err(e) = st.workspaces.mfa_reset(&user) {
        return store_failure(e);
    }
    no_store(Json(json!({"ok": true})).into_response())
}

/// `POST /api/auth/totp/recovery {code}` -> `{recoveryCodes}`: ten new
/// recovery codes (the old ones stop working), against a current code.
pub(crate) async fn api_totp_recovery(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if crate::edition::is_external() {
        return api_error(StatusCode::NOT_FOUND, "not available on this edition");
    }
    let user = gate!(mutation_user(&headers, &st));
    gate!(require_active(&st, &user));
    let (token, _) = gate!(live_session(&st, &headers));
    gate!(attempt_gate(
        &st,
        &user,
        &hash_token(&token),
        peer,
        &headers
    ));
    let code = code_of(&body);
    match st
        .workspaces
        .verify_and_regenerate(&user, &code, crate::totp::now_secs())
    {
        Ok(Some(codes)) => {
            audit(&st, &user, "auth.mfa.recovery_regenerated", json!({}));
            no_store(Json(json!({"recoveryCodes": codes})).into_response())
        }
        Ok(None) => {
            audit(&st, &user, "auth.mfa.failed", json!({"on": "recovery"}));
            api_error(StatusCode::BAD_REQUEST, "Код не подошёл.")
        }
        Err(e) => store_failure(e),
    }
}

/// `POST /api/auth/mfa/enroll-link/open {token}`: spend the one-time link
/// `mfa-enroll-link` printed. Sets a 10-minute, satisfied, `tool:enrol` session
/// cookie — the only way a platform admin gets to enrol an authenticator.
pub(crate) async fn api_enroll_link_open(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !same_origin(&headers) {
        return api_error(StatusCode::FORBIDDEN, "cross-site request rejected");
    }
    let ip = crate::rate_window::rate_ip(Some(&client_address(peer, &headers)));
    let key = gate!(check_window_quota(
        &st,
        &format!("mfa-link:{}", ip.as_deref().unwrap_or("?")),
        10,
        ATTEMPT_WINDOW_MS,
        SLOW_DOWN,
    ));
    record_window_hit(&st, &key, ATTEMPT_WINDOW_MS);
    let token = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| v.get("token").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default();
    // An account that may not use the product gets nothing — and its link is
    // left unspent: the activity check runs before anything is written.
    match st.workspaces.peek_enroll_link_user(&token) {
        Ok(Some(user)) => {
            if let Err(response) = require_active(&st, &user) {
                return response;
            }
        }
        Ok(None) => return api_error(
            StatusCode::GONE,
            "Ссылка недействительна или уже использована. Попросите оператора хаба выдать новую.",
        ),
        Err(e) => return store_failure(e),
    }
    let (user, session) = match st.workspaces.open_enroll_link(&token) {
        Ok(v) => v,
        Err(e) if e == "invalid_link" => return api_error(
            StatusCode::GONE,
            "Ссылка недействительна или уже использована. Попросите оператора хаба выдать новую.",
        ),
        Err(e) => return store_failure(e),
    };
    // Re-checked after the transaction: a suspension that landed in between
    // still gets no session.
    if let Err(response) = require_active(&st, &user) {
        st.workspaces.drop_session(&session);
        return response;
    }
    audit(&st, &user, "auth.mfa.enroll_link_opened", json!({"ip": ip}));
    let mut response = no_store(Json(json!({"ok": true})).into_response());
    response.headers_mut().append(
        header::SET_COOKIE,
        set_cookie_header(
            AUTH_COOKIE,
            &session,
            ENROL_TTL_MS / 1000,
            st.public_url.starts_with("https://"),
        ),
    );
    response
}

impl WorkspaceStore {
    pub(crate) fn with_conn_mfa<T>(&self, f: impl FnOnce(&Connection) -> T) -> T {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        f(&conn)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_parse() {
        assert_eq!(parse_duration_ms("90"), Some(90_000));
        assert_eq!(parse_duration_ms("2h"), Some(7_200_000));
        assert_eq!(parse_duration_ms("30m"), Some(1_800_000));
        assert_eq!(parse_duration_ms("7d"), Some(604_800_000));
        assert_eq!(parse_duration_ms("0h"), None);
        assert_eq!(parse_duration_ms("x"), None);
        assert_eq!(parse_duration_ms(""), None);
        assert_eq!(parse_duration_ms("5w"), None);
    }
}
