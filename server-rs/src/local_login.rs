//! Local accounts of the external edition: an email, a password and an
//! authenticator code. No third party is involved, so a customer's hub can
//! start with nobody but its owner and nothing configured.
//!
//! - **Owner.** The owner is the bootstrap user (`CC_REMOTE_BOOTSTRAP_USER_ID`
//!   / `CC_REMOTE_BOOTSTRAP_EMAIL`, a platform admin). While the owner has no
//!   sign-in the hub prints a one-hour setup link to its log at every start, and
//!   `cc-remote-server setup-link --email <e>` prints another at any time.
//! - **Setup.** The link carries a 256-bit token (`/setup#token=…`, in the
//!   fragment so it is never sent anywhere). `setup/begin` starts the
//!   authenticator enrolment and returns the QR code; `setup/finish` takes the
//!   password and a code from the app, burns the token, hands out the recovery
//!   codes once and opens a session.
//! - **Sign-in.** Password (argon2id) then `user_totp::verify` — the only place
//!   a user's code is checked. Every failure is the same sentence; an unknown
//!   address costs a dummy hash so the response time does not tell it apart.
//! - **Employees.** A platform admin creates them (`/api/admin/local-users`)
//!   and sends the 24-hour setup link; `…/reset` is the lost-phone path.
//!
//! Only the token's SHA-256 is stored; a token is single use and expires. The
//! whole module answers 404 unless the hub is the external edition or
//! `CC_REMOTE_LOCAL_LOGIN=1` (a dev hub).

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Algorithm, Argon2, Params, Version,
};
use axum::extract::ConnectInfo;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use qrcode::{render::svg, QrCode};
use ring::rand::{SecureRandom, SystemRandom};
use rusqlite::{params, Connection, OptionalExtension};
use std::net::SocketAddr;
use std::sync::OnceLock;

use super::*;
use crate::rate_window::rate_ip;
use crate::workspace::{db_err, hash_token, insert_audit, normalize_email};

/// `identities.provider` of a local account; the subject is the lower-cased email.
pub(crate) const PROVIDER_LOCAL: &str = "local";

const MIN_PASSWORD_CHARS: usize = 12;
const MAX_PASSWORD_CHARS: usize = 256;
const OWNER_LINK_HOURS: i64 = 1;
const EMPLOYEE_LINK_HOURS: i64 = 24;
/// A setup link made by a workspace invitation (the invitation lives as long).
const INVITE_LINK_HOURS: i64 = 7 * 24;
const SESSION_DAYS: i64 = 7;
/// What every failed sign-in says, whatever failed.
const GENERIC_ERROR: &str = "Неверная почта, пароль или код";
const LOGIN_LIMIT: usize = 10;
const LOGIN_WINDOW_MS: i64 = 15 * 60 * 1000;
const SETUP_LIMIT: usize = 20;
/// Failures against one account, from ALL addresses, after which every attempt
/// on it is delayed by `ACCOUNT_SLOWDOWN` (never refused).
const ACCOUNT_SLOWDOWN_AFTER: usize = 100;
const ACCOUNT_SLOWDOWN: Duration = Duration::from_secs(1);

/// Local accounts are the external edition's way in; a dev hub opts in.
pub(crate) fn enabled() -> bool {
    enabled_from(
        crate::edition::is_external(),
        std::env::var("CC_REMOTE_LOCAL_LOGIN").ok().as_deref(),
    )
}

fn enabled_from(external: bool, flag: Option<&str>) -> bool {
    external || flag.map(str::trim) == Some("1")
}

pub(crate) fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS local_credentials (
            user_id       TEXT PRIMARY KEY,
            email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            created_at    INTEGER NOT NULL,
            updated_at    INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS local_setup_tokens (
            token_hash TEXT PRIMARY KEY,
            user_id    TEXT NOT NULL,
            email      TEXT NOT NULL,
            purpose    TEXT NOT NULL CHECK(purpose IN ('setup','reset')),
            expires_at INTEGER NOT NULL,
            used_at    INTEGER
        );",
    )
    .map_err(db_err)?;
    // A setup link made by a workspace invitation carries the invitation: the
    // link is good only while the invitation is, and finishing it accepts it.
    let has: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('local_setup_tokens') WHERE name='invitation_id')",
            [],
            |r| r.get(0),
        )
        .map_err(db_err)?;
    if !has {
        conn.execute(
            "ALTER TABLE local_setup_tokens ADD COLUMN invitation_id TEXT",
            [],
        )
        .map_err(db_err)?;
    }
    Ok(())
}

// ------------------------------------------------------------------ crypto

fn argon2() -> Argon2<'static> {
    // OWASP's argon2id minimum: 19 MiB, 2 passes, 1 lane. Tests use a toy cost.
    let params = if cfg!(test) {
        Params::new(64, 1, 1, None)
    } else {
        Params::new(19_456, 2, 1, None)
    };
    Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        params.expect("valid argon2 parameters"),
    )
}

pub(crate) fn hash_password(password: &str) -> Result<String, String> {
    let mut salt = [0u8; 16];
    SystemRandom::new()
        .fill(&mut salt)
        .map_err(|_| "randomness unavailable".to_string())?;
    let salt = SaltString::encode_b64(&salt).map_err(|e| e.to_string())?;
    argon2()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

/// False for a wrong password and for a stored value that is not a PHC string.
pub(crate) fn verify_password(password: &str, phc: &str) -> bool {
    PasswordHash::new(phc)
        .map(|h| argon2().verify_password(password.as_bytes(), &h).is_ok())
        .unwrap_or(false)
}

/// At most this many hashes at once: each takes 19 MiB.
static HASH_PERMITS: Semaphore = Semaphore::const_new(4);

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let _permit = HASH_PERMITS
        .acquire()
        .await
        .map_err(|_| "hashing unavailable".to_string())?;
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| "hashing failed".to_string())
}

/// A valid hash of nothing anyone knows, verified when the address is unknown.
fn dummy_hash() -> &'static str {
    static DUMMY: OnceLock<String> = OnceLock::new();
    DUMMY.get_or_init(|| hash_password("no-such-account-dummy-password").unwrap_or_default())
}

/// 32 random bytes, base64url.
fn new_token() -> String {
    let mut raw = [0u8; 32];
    SystemRandom::new()
        .fill(&mut raw)
        .expect("system randomness is available");
    URL_SAFE_NO_PAD.encode(raw)
}

fn qr_svg(data: &str) -> Option<String> {
    let code = QrCode::new(data.as_bytes()).ok()?;
    Some(
        code.render::<svg::Color>()
            .min_dimensions(224, 224)
            .quiet_zone(true)
            .dark_color(svg::Color("#000000"))
            .light_color(svg::Color("#ffffff"))
            .build(),
    )
}

/// What the authenticator app shows as the issuer.
pub(crate) fn brand_name() -> String {
    std::env::var("CC_REMOTE_BRAND_NAME")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "Hegai Code".to_string())
}

pub(crate) fn valid_email(email: &str) -> bool {
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    email.len() <= 254
        && !email.to_ascii_lowercase().ends_with("@users.invalid")
        && !local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && email.matches('@').count() == 1
        && !email.chars().any(|c| c.is_whitespace() || c.is_control())
}

// ------------------------------------------------------------------- store

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SetupToken {
    pub user_id: String,
    pub email: String,
    pub purpose: String,
    /// The workspace invitation this link accepts when it is finished.
    pub invitation_id: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum FinishOutcome {
    Done {
        user_id: String,
        email: String,
        /// Shown once; empty when the authenticator already existed.
        recovery_codes: Vec<String>,
        /// `(workspace, inviter)` of the invitation the link accepted.
        joined: Option<(String, String)>,
    },
    BadToken,
    /// The invitation behind the link was withdrawn, expired or is not for
    /// this address; nothing was changed.
    InviteGone,
    BadCode,
    Db(String),
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CreateError {
    /// The address already belongs to an account that is not a pending invitation.
    Exists,
    Db(String),
}

impl From<String> for CreateError {
    fn from(e: String) -> Self {
        CreateError::Db(e)
    }
}

/// A hub-owned account: a user row, its personal workspace and the default
/// access row. The id carries `prefix` so its origin is readable in a dump.
/// `vouched`: the owner/an admin created it, or the customer's domain list
/// vouches for the address (see `access::new_account_state`).
pub(crate) fn create_hub_account(
    conn: &Connection,
    prefix: &str,
    email: Option<&str>,
    name: Option<&str>,
    now: i64,
    vouched: bool,
) -> Result<String, String> {
    let user_id = format!("{prefix}-{}", Uuid::new_v4().simple());
    let personal = format!("personal:{user_id}");
    conn.execute(
        "INSERT INTO users(user_id,email,full_name,created_at) VALUES(?1,?2,?3,?4)",
        params![user_id, email, name, now],
    )
    .map_err(db_err)?;
    conn.execute(
        "INSERT OR IGNORE INTO workspaces(workspace_id,name,kind,owner_user_id,created_at) VALUES(?1,'Моя работа','personal',?2,?3)",
        params![personal, user_id, now],
    )
    .map_err(db_err)?;
    conn.execute(
        "INSERT OR IGNORE INTO memberships(workspace_id,user_id,role,created_at) VALUES(?1,?2,'owner',?3)",
        params![personal, user_id, now],
    )
    .map_err(db_err)?;
    conn.execute(
        "INSERT OR IGNORE INTO user_access(user_id,state,plan,requested_at,updated_at) VALUES(?1,?2,'community',?3,?3)",
        params![user_id, crate::access::new_account_state(vouched), now],
    )
    .map_err(db_err)?;
    Ok(user_id)
}

fn link_local_identity(
    conn: &Connection,
    user_id: &str,
    email: &str,
    now: i64,
) -> Result<(), String> {
    match crate::identity::resolve(conn, PROVIDER_LOCAL, email)? {
        Some(owner) if owner != user_id => {
            Err("this address already signs in to another account".into())
        }
        _ => crate::identity::link(conn, PROVIDER_LOCAL, email, user_id, now),
    }
}

impl WorkspaceStore {
    /// Make a setup/reset token for `user_id`; older unused ones of that user
    /// stop working. Returns the clear token (the only copy).
    pub(crate) fn local_mint_setup_token(
        &self,
        user_id: &str,
        email: &str,
        purpose: &str,
        ttl_ms: i64,
    ) -> Result<String, String> {
        self.local_mint_setup_token_for(user_id, email, purpose, ttl_ms, None)
    }

    pub(crate) fn local_mint_setup_token_for(
        &self,
        user_id: &str,
        email: &str,
        purpose: &str,
        ttl_ms: i64,
        invitation_id: Option<&str>,
    ) -> Result<String, String> {
        let token = new_token();
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.execute(
            "DELETE FROM local_setup_tokens WHERE expires_at<?1 OR used_at IS NOT NULL AND used_at<?1 OR (user_id=?2 AND used_at IS NULL)",
            params![now - 24 * 60 * 60 * 1000, user_id],
        )
        .map_err(db_err)?;
        conn.execute(
            "INSERT INTO local_setup_tokens(token_hash,user_id,email,purpose,expires_at,used_at,invitation_id) VALUES(?1,?2,?3,?4,?5,NULL,?6)",
            params![hash_token(&token), user_id, normalize_email(email), purpose, now + ttl_ms, invitation_id],
        )
        .map_err(db_err)?;
        Ok(token)
    }

    fn read_setup_token(
        conn: &Connection,
        token: &str,
        now: i64,
    ) -> Result<Option<SetupToken>, String> {
        conn.query_row(
            "SELECT user_id,email,purpose,invitation_id FROM local_setup_tokens t WHERE token_hash=?1 AND used_at IS NULL AND expires_at>?2
             AND (invitation_id IS NULL OR EXISTS(SELECT 1 FROM invitations i WHERE i.invitation_id=t.invitation_id AND i.accepted_at IS NULL AND i.expires_at>?2))",
            params![hash_token(token), now],
            |r| {
                Ok(SetupToken {
                    user_id: r.get(0)?,
                    email: r.get(1)?,
                    purpose: r.get(2)?,
                    invitation_id: r.get(3)?,
                })
            },
        )
        .optional()
        .map_err(db_err)
    }

    /// A live, unused token — not consumed.
    pub(crate) fn local_peek_setup_token(&self, token: &str) -> Result<Option<SetupToken>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        Self::read_setup_token(&conn, token, now_ms())
    }

    /// A link that is itself live but whose invitation is gone: the one case
    /// where the person is told to ask for a new invitation, not a new link.
    pub(crate) fn local_setup_invite_dead(&self, token: &str) -> bool {
        let Ok(conn) = self.conn.lock() else {
            return false;
        };
        let now = now_ms();
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM local_setup_tokens WHERE token_hash=?1 AND used_at IS NULL AND expires_at>?2 AND invitation_id IS NOT NULL)",
            params![hash_token(token), now],
            |r| r.get::<_, bool>(0),
        )
        .unwrap_or(false)
    }

    pub(crate) fn local_has_credential(&self, user_id: &str) -> Result<bool, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM local_credentials WHERE user_id=?1)",
            params![user_id],
            |r| r.get(0),
        )
        .map_err(db_err)
    }

    /// Make `(local, email)` open `user_id` — refused when another account holds it.
    pub(crate) fn local_ensure_identity(&self, user_id: &str, email: &str) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        link_local_identity(&conn, user_id, &normalize_email(email), now_ms())
    }

    /// Step one of setup: for a user without an authenticator, a fresh secret
    /// (unconfirmed). `Ok(None)` for a dead token; `Ok(Some((token, None)))`
    /// when the authenticator already exists and enrolment is skipped.
    pub(crate) fn local_begin_setup(
        &self,
        token: &str,
    ) -> Result<Option<(SetupToken, Option<String>)>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let Some(tok) = Self::read_setup_token(&conn, token, now_ms())? else {
            return Ok(None);
        };
        if crate::user_totp::is_enrolled(&conn, &tok.user_id).map_err(db_err)? {
            return Ok(Some((tok, None)));
        }
        match crate::user_totp::begin(&conn, &tok.user_id) {
            Ok(secret) => Ok(Some((tok, Some(secret)))),
            Err(crate::user_totp::BeginError::AlreadyEnrolled) => Ok(Some((tok, None))),
            Err(crate::user_totp::BeginError::Db(e)) => Err(e),
        }
    }

    /// Step two: all or nothing. The token is burned, the authenticator
    /// confirmed (unless it already was), the password and the `local`
    /// identity stored — or none of it, so a mistyped code costs nothing.
    pub(crate) fn local_finish_setup(
        &self,
        token: &str,
        password_hash: &str,
        code: &str,
        unix_secs: u64,
    ) -> FinishOutcome {
        let now = now_ms();
        let Ok(conn) = self.conn.lock() else {
            return FinishOutcome::Db("workspace database lock poisoned".into());
        };
        let run = || -> Result<FinishOutcome, String> {
            let tx = conn.unchecked_transaction().map_err(db_err)?;
            let Some(tok) = Self::read_setup_token(&tx, token, now)? else {
                return Ok(FinishOutcome::BadToken);
            };
            // The compare-and-set is what makes the token single use.
            let burned = tx
                .execute(
                    "UPDATE local_setup_tokens SET used_at=?2 WHERE token_hash=?1 AND used_at IS NULL AND expires_at>?2",
                    params![hash_token(token), now],
                )
                .map_err(db_err)?;
            if burned != 1 {
                return Ok(FinishOutcome::BadToken);
            }
            let recovery_codes = if crate::user_totp::is_enrolled(&tx, &tok.user_id)
                .map_err(db_err)?
            {
                // A link alone must never stand in for the second factor:
                // with an authenticator already there, the link sets a
                // password only together with a current code from it.
                if !crate::user_totp::verify(&tx, &tok.user_id, code, unix_secs).map_err(db_err)? {
                    return Ok(FinishOutcome::BadCode); // tx dropped: token not burned
                }
                Vec::new()
            } else {
                match crate::user_totp::confirm(&tx, &tok.user_id, code, unix_secs)
                    .map_err(db_err)?
                {
                    Some(codes) => codes,
                    None => return Ok(FinishOutcome::BadCode), // tx dropped: token not burned
                }
            };
            link_local_identity(&tx, &tok.user_id, &tok.email, now)?;
            tx.execute(
                "INSERT INTO local_credentials(user_id,email,password_hash,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)
                 ON CONFLICT(user_id) DO UPDATE SET email=excluded.email, password_hash=excluded.password_hash, updated_at=excluded.updated_at",
                params![tok.user_id, tok.email, password_hash, now],
            )
            .map_err(db_err)?;
            if let Some(ws) = crate::access::audit_workspace_in(&tx, &tok.user_id)? {
                insert_audit(
                    &tx,
                    &ws,
                    &tok.user_id,
                    "auth.local_setup",
                    "user",
                    &tok.user_id,
                    &json!({"purpose": tok.purpose, "enrolled": !recovery_codes.is_empty()}),
                )?;
            }
            // The invitation is accepted in the same transaction: either the
            // person has a password AND a seat in the team, or nothing changed.
            let joined = match &tok.invitation_id {
                Some(id) => match WorkspaceStore::accept_invitation_in(&tx, &tok.user_id, id, true)
                {
                    Ok(j) => Some(j),
                    Err(_) => return Ok(FinishOutcome::InviteGone), // tx dropped
                },
                None => None,
            };
            tx.commit().map_err(db_err)?;
            Ok(FinishOutcome::Done {
                user_id: tok.user_id,
                email: tok.email,
                recovery_codes,
                joined,
            })
        };
        run().unwrap_or_else(FinishOutcome::Db)
    }

    /// `(user_id, email, password hash)` of the credential for an address.
    pub(crate) fn local_credential(
        &self,
        email: &str,
    ) -> Result<Option<(String, String, String)>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.query_row(
            "SELECT user_id,email,password_hash FROM local_credentials WHERE email=?1",
            params![normalize_email(email)],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(db_err)
    }

    fn local_verify_code(&self, user_id: &str, code: &str, unix_secs: u64) -> bool {
        let Ok(conn) = self.conn.lock() else {
            return false;
        };
        crate::user_totp::verify(&conn, user_id, code, unix_secs).unwrap_or(false)
    }

    /// The account for a new employee (or an unfinished invitation re-issued).
    /// `Ok((user_id, created))`.
    pub(crate) fn local_create_account(
        &self,
        email: &str,
        name: Option<&str>,
        actor: &str,
    ) -> Result<(String, bool), CreateError> {
        let email = normalize_email(email);
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let holder: Option<String> = tx
            .query_row(
                "SELECT user_id FROM users WHERE lower(trim(email))=?1",
                params![email],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        let bound = crate::identity::resolve(&tx, PROVIDER_LOCAL, &email)?;
        let (user_id, created) = match (holder, bound) {
            // An invitation nobody has finished: hand out a fresh link.
            (Some(h), Some(b)) if h == b => {
                let done: bool = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM local_credentials WHERE user_id=?1)",
                        params![h],
                        |r| r.get(0),
                    )
                    .map_err(db_err)?;
                if done {
                    return Err(CreateError::Exists);
                }
                (h, false)
            }
            (Some(_), _) | (None, Some(_)) => return Err(CreateError::Exists),
            (None, None) => {
                let id = create_hub_account(&tx, "l", Some(&email), name, now, true)?;
                link_local_identity(&tx, &id, &email, now)?;
                (id, true)
            }
        };
        if let Some(ws) = crate::access::audit_workspace_in(&tx, actor)? {
            insert_audit(
                &tx,
                &ws,
                actor,
                "auth.local_user_invited",
                "user",
                &user_id,
                &json!({"email": email, "created": created}),
            )?;
        }
        tx.commit().map_err(db_err)?;
        Ok((user_id, created))
    }

    /// The account behind a workspace invitation to `email`, when the person
    /// has no local sign-in yet: created (vouched: the owner of a team on this
    /// hub invited them), or, for an invitation-made account nobody finished,
    /// kept so a fresh link can be issued. `Ok(Some(user_id))` means "mint a
    /// setup link"; `Ok(None)` means the address already belongs to someone
    /// (a password, another provider, or an account whose sign-in was reset) and
    /// the ordinary invitation link is all that may be handed out - an invite
    /// must never become a way into an existing account.
    pub(crate) fn local_invite_account(
        &self,
        workspace_id: &str,
        email: &str,
        actor: &str,
        protected: &[String],
    ) -> Result<Option<String>, String> {
        let email = normalize_email(email);
        if !valid_email(&email) {
            return Ok(None);
        }
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let holder: Option<String> = tx
            .query_row(
                "SELECT user_id FROM users WHERE lower(trim(email))=?1",
                params![email],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        let bound = crate::identity::resolve(&tx, PROVIDER_LOCAL, &email)?;
        let (user_id, created) = match (holder, bound) {
            (None, None) => {
                let id = create_hub_account(&tx, "l", Some(&email), None, now, true)?;
                link_local_identity(&tx, &id, &email, now)?;
                (id, true)
            }
            (Some(h), Some(b)) if h == b => {
                // Re-issue ONLY an account that was born from a workspace
                // invitation and has never been used. Anything else is a
                // real person's account (owner, admin-made employee, a
                // Google/GitHub/Telegram sign-in, a reset account).
                if protected.iter().any(|p| p == &h) {
                    return Ok(None);
                }
                let untouched: bool = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM audit_events WHERE action='auth.local_user_invited'
                                       AND target_kind='user' AND target_id=?1
                                       AND json_extract(metadata_json,'$.via')='workspace_invitation')
                         AND NOT EXISTS(SELECT 1 FROM local_credentials WHERE user_id=?1)
                         AND NOT EXISTS(SELECT 1 FROM audit_events WHERE target_kind='user' AND target_id=?1
                                        AND action IN ('auth.local_setup','auth.local_reset'))
                         AND NOT EXISTS(SELECT 1 FROM identities WHERE user_id=?1 AND provider<>'local')
                         AND NOT EXISTS(SELECT 1 FROM auth_sessions WHERE user_id=?1)
                         AND NOT EXISTS(SELECT 1 FROM memberships m JOIN workspaces w ON w.workspace_id=m.workspace_id
                                        WHERE m.user_id=?1 AND w.kind<>'personal')",
                        params![h],
                        |r| r.get(0),
                    )
                    .map_err(db_err)?;
                if !untouched {
                    return Ok(None);
                }
                (h, false)
            }
            _ => return Ok(None),
        };
        insert_audit(
            &tx,
            workspace_id,
            actor,
            "auth.local_user_invited",
            "user",
            &user_id,
            &json!({"email": email, "created": created, "via": "workspace_invitation"}),
        )?;
        tx.commit().map_err(db_err)?;
        Ok(Some(user_id))
    }

    /// A setup link for an invited person: single use, `INVITE_LINK_HOURS`.
    pub(crate) fn local_invite_setup_url(
        &self,
        user_id: &str,
        email: &str,
        invite_token: &str,
        invitation_id: &str,
        public_url: &str,
    ) -> Result<String, String> {
        let token = self.local_mint_setup_token_for(
            user_id,
            email,
            "setup",
            INVITE_LINK_HOURS * 60 * 60 * 1000,
            Some(invitation_id),
        )?;
        Ok(format!(
            "{}&invite={invite_token}",
            setup_url(public_url, &token)
        ))
    }

    /// The lost-phone / forgotten-password path: password and authenticator
    /// removed, every session of the user ended. `Ok(Some(email))`, or `None`
    /// when the user has no local sign-in.
    pub(crate) fn local_reset(&self, user_id: &str, actor: &str) -> Result<Option<String>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let email: Option<String> = tx
            .query_row(
                "SELECT subject FROM identities WHERE provider=?1 AND user_id=?2",
                params![PROVIDER_LOCAL, user_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        let Some(email) = email else {
            return Ok(None);
        };
        tx.execute(
            "DELETE FROM local_credentials WHERE user_id=?1",
            params![user_id],
        )
        .map_err(db_err)?;
        crate::user_totp::reset(&tx, user_id).map_err(db_err)?;
        tx.execute(
            "DELETE FROM auth_sessions WHERE user_id=?1",
            params![user_id],
        )
        .map_err(db_err)?;
        if let Some(ws) = crate::access::audit_workspace_in(&tx, actor)? {
            insert_audit(
                &tx,
                &ws,
                actor,
                "auth.local_reset",
                "user",
                user_id,
                &json!({"email": email}),
            )?;
        }
        tx.commit().map_err(db_err)?;
        Ok(Some(email))
    }

    fn audit_local_login(&self, user_id: &str, ip: Option<&str>) {
        let Ok(conn) = self.conn.lock() else { return };
        if let Ok(Some(ws)) = crate::access::audit_workspace_in(&conn, user_id) {
            let _ = insert_audit(
                &conn,
                &ws,
                user_id,
                "auth.local_login",
                "user",
                user_id,
                &json!({"ip": ip}),
            );
        }
    }
}

// --------------------------------------------------------- owner bootstrap

fn setup_url(public_url: &str, token: &str) -> String {
    format!("{}/setup#token={token}", public_url.trim_end_matches('/'))
}

/// A setup link for the account that owns `email`'s local sign-in: links the
/// `local` identity (once) and mints the token.
pub(crate) fn mint_setup_url(
    store: &WorkspaceStore,
    user_id: &str,
    email: &str,
    purpose: &str,
    hours: i64,
    public_url: &str,
) -> Result<String, String> {
    store.local_ensure_identity(user_id, email)?;
    let token = store.local_mint_setup_token(user_id, email, purpose, hours * 60 * 60 * 1000)?;
    Ok(setup_url(public_url, &token))
}

/// External hub start: print the owner's setup link until the owner has BOTH a
/// password and a confirmed authenticator (regardless of OIDC: approving agent
/// releases needs the authenticator, and an OIDC sign-in never gives one).
pub(crate) fn announce_owner_setup(
    store: &WorkspaceStore,
    user_id: &str,
    email: &str,
    public_url: &str,
) {
    let enrolled = store
        .with_conn(|c| crate::user_totp::is_enrolled(c, user_id))
        .unwrap_or(false);
    match store.local_has_credential(user_id) {
        Ok(true) if enrolled => return,
        Ok(_) => {}
        Err(e) => {
            eprintln!("[setup] cannot read the owner's sign-in: {e}");
            return;
        }
    }
    match mint_setup_url(store, user_id, email, "setup", OWNER_LINK_HOURS, public_url) {
        Ok(url) => {
            println!(
                "[setup] The owner ({email}) has no password and authenticator yet. Open this link within {OWNER_LINK_HOURS} hour to set both (the authenticator approves agent updates):"
            );
            println!("[setup] {url}");
            if email == "owner@localhost" {
                println!("[setup] CC_REMOTE_BOOTSTRAP_EMAIL is unset: set it to the owner's real address");
            }
        }
        Err(e) => eprintln!("[setup] cannot make the owner's setup link: {e}"),
    }
}

/// `cc-remote-server setup-link --email <e> [--hours N]`: exit code.
pub(crate) fn run_setup_link_cli(
    args: &[String],
    db_path: &std::path::Path,
    public_url: &str,
) -> i32 {
    let mut email = None;
    let mut hours = OWNER_LINK_HOURS;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--email" => email = it.next().cloned(),
            "--hours" => match it.next().and_then(|v| v.parse::<i64>().ok()) {
                Some(h) if (1..=168).contains(&h) => hours = h,
                _ => {
                    eprintln!("--hours must be 1..168");
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
        .map(|e| normalize_email(&e))
        .filter(|e| e.contains('@'))
    else {
        eprintln!("usage: cc-remote-server setup-link --email <address> [--hours 1]");
        return 2;
    };
    if !db_path.is_file() {
        eprintln!(
            "database {} not found (CC_REMOTE_DB_PATH)",
            db_path.display()
        );
        return 1;
    }
    let store = match WorkspaceStore::open(db_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("cannot open the database: {e}");
            return 1;
        }
    };
    let user_id = store.with_conn(|c| {
        c.query_row(
            "SELECT user_id FROM users WHERE lower(trim(email))=?1",
            params![email],
            |r| r.get::<_, String>(0),
        )
        .optional()
    });
    let user_id = match user_id {
        Ok(Some(u)) => u,
        Ok(None) => {
            eprintln!(
                "no account with the address {email} (the owner's is CC_REMOTE_BOOTSTRAP_EMAIL)"
            );
            return 1;
        }
        Err(e) => {
            eprintln!("database error: {e}");
            return 1;
        }
    };
    match mint_setup_url(&store, &user_id, &email, "setup", hours, public_url) {
        Ok(url) => {
            if !enabled() {
                eprintln!("note: local sign-in is off on this hub (CC_REMOTE_EDITION=external or CC_REMOTE_LOCAL_LOGIN=1)");
            }
            println!("{url}");
            0
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

impl WorkspaceStore {
    fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> T) -> T {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        f(&conn)
    }
}

// -------------------------------------------------------------------- HTTP

fn off() -> Response {
    api_error(
        StatusCode::NOT_FOUND,
        "local sign-in is not enabled on this hub",
    )
}

fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn parse(body: &Bytes) -> Value {
    serde_json::from_slice(body).unwrap_or(Value::Null)
}

fn text<'a>(body: &'a Value, key: &str) -> &'a str {
    body.get(key).and_then(Value::as_str).unwrap_or("")
}

/// A session for `user_id`: the browser cookie, or — for a native client that
/// asked with `native: true` — the token itself in the body (90 days).
fn session_response(
    st: &AppState,
    user_id: &str,
    email: &str,
    native: bool,
    mut body: Value,
) -> Response {
    let ttl_days = if native { 90 } else { SESSION_DAYS };
    // Born satisfied: `check_credentials` has already verified the code (the
    // external edition's own second factor), so there is no second prompt.
    let session = match st.workspaces.create_auth_session_for_as(
        Some((PROVIDER_LOCAL, email)),
        user_id,
        ttl_days,
        crate::mfa::Factor::Proven,
    ) {
        Ok((s, _)) => s,
        Err(e) => return store_failure(e),
    };
    if native {
        body["session"] = Value::String(session);
        return no_store(Json(body).into_response());
    }
    let mut response = Json(body).into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        set_cookie_header(
            AUTH_COOKIE,
            &session,
            ttl_days * 24 * 60 * 60,
            st.public_url.starts_with("https://"),
        ),
    );
    no_store(response)
}

/// The client's address under the hub's one trust rule: `X-Real-IP` counts only
/// from loopback or a proxy named in `CC_REMOTE_TRUSTED_PROXIES`; any other peer
/// is its own address, so a direct caller cannot pick the rate-limit key.
fn peer_address(peer: SocketAddr, headers: &HeaderMap) -> String {
    crate::client_address(peer, headers)
}

/// Count one attempt against the address's window; `Err` is the 429.
fn setup_quota(st: &AppState, peer: SocketAddr, headers: &HeaderMap) -> Result<(), Response> {
    let ip = rate_ip(Some(&peer_address(peer, headers)));
    let key = check_window_quota(
        st,
        &format!("local-setup:{}", ip.as_deref().unwrap_or("?")),
        SETUP_LIMIT,
        LOGIN_WINDOW_MS,
        "слишком много попыток, подождите несколько минут",
    )?;
    record_window_hit(st, &key, LOGIN_WINDOW_MS);
    Ok(())
}

const INVITE_GONE: &str = "Приглашение отозвано или истекло — попросите новое.";

/// 410 for a link that does not work: the invitation behind it, or the link itself.
fn gone(st: &AppState, token: &str) -> Response {
    if st.workspaces.local_setup_invite_dead(token) {
        return api_error(StatusCode::GONE, INVITE_GONE);
    }
    api_error(
        StatusCode::GONE,
        "Ссылка недействительна или уже использована. Попросите новую.",
    )
}

/// `POST /api/auth/local/setup/begin` `{token}` -> `{email, enrolled, secret?, otpauthUri?, qrSvg?}`.
pub(crate) async fn api_setup_begin(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !enabled() {
        return off();
    }
    if !same_origin(&headers) {
        return api_error(StatusCode::FORBIDDEN, "cross-site request rejected");
    }
    if let Err(r) = setup_quota(&st, peer, &headers) {
        return r;
    }
    let body = parse(&body);
    let token_text = text(&body, "token").to_string();
    let (tok, secret) = match st.workspaces.local_begin_setup(&token_text) {
        Ok(Some(v)) => v,
        Ok(None) => {
            return gone(&st, &token_text);
        }
        Err(e) => return store_failure(e),
    };
    let mut out = json!({"email": tok.email, "enrolled": secret.is_none()});
    if let Some(secret) = secret {
        let uri = crate::totp::otpauth_uri(&brand_name(), &tok.email, &secret);
        out["secret"] = Value::String(secret);
        if let Some(svg) = qr_svg(&uri) {
            out["qrSvg"] = Value::String(svg);
        }
        out["otpauthUri"] = Value::String(uri);
    }
    no_store(Json(out).into_response())
}

/// `POST /api/auth/local/setup/finish` `{token, password, code, native?}`
/// -> `{recoveryCodes}` and a session.
pub(crate) async fn api_setup_finish(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !enabled() {
        return off();
    }
    if !same_origin(&headers) {
        return api_error(StatusCode::FORBIDDEN, "cross-site request rejected");
    }
    if let Err(r) = setup_quota(&st, peer, &headers) {
        return r;
    }
    let body = parse(&body);
    let password = text(&body, "password").to_string();
    let chars = password.chars().count();
    if chars < MIN_PASSWORD_CHARS {
        return api_error(
            StatusCode::BAD_REQUEST,
            format!("Пароль короче {MIN_PASSWORD_CHARS} символов."),
        );
    }
    if chars > MAX_PASSWORD_CHARS {
        return api_error(StatusCode::BAD_REQUEST, "Пароль слишком длинный.");
    }
    let token = text(&body, "token").to_string();
    let token_text = token.clone();
    // A dead token is refused before the (costly) hash.
    match st.workspaces.local_peek_setup_token(&token) {
        Ok(Some(_)) => {}
        Ok(None) => {
            return gone(&st, &token_text);
        }
        Err(e) => return store_failure(e),
    }
    let hash = match blocking(move || hash_password(&password)).await {
        Ok(Ok(h)) => h,
        Ok(Err(e)) | Err(e) => return store_failure(e),
    };
    let native = body.get("native").and_then(Value::as_bool).unwrap_or(false);
    match st.workspaces.local_finish_setup(
        &token,
        &hash,
        text(&body, "code"),
        crate::totp::now_secs(),
    ) {
        FinishOutcome::Done {
            user_id,
            email,
            recovery_codes,
            joined,
        } => {
            println!("[local-login] {user_id} finished sign-in setup");
            let mut out = json!({"recoveryCodes": recovery_codes});
            if let Some((workspace_id, inviter)) = joined {
                // What accepting an invitation does for a waitlisted person.
                crate::access_api::activate_user_by_invitation(&st, &inviter, &user_id);
                out["workspaceId"] = Value::String(workspace_id);
            }
            session_response(&st, &user_id, &email, native, out)
        }
        FinishOutcome::BadToken => gone(&st, &token),
        FinishOutcome::InviteGone => api_error(StatusCode::GONE, INVITE_GONE),
        FinishOutcome::BadCode => api_error(
            StatusCode::BAD_REQUEST,
            "Код из приложения не подошёл. Проверьте время на телефоне и введите новый.",
        ),
        FinishOutcome::Db(e) => store_failure(e),
    }
}

/// A request whose email, password and code were all right.
struct Verified {
    user_id: String,
    email: String,
    ip: Option<String>,
    body: Value,
}

/// The one place a local sign-in is judged — password, then authenticator
/// code — with its rate limits and its single generic refusal. Both the
/// web/`native` login and the native hand-off go through it.
async fn check_credentials(
    st: &AppState,
    peer: SocketAddr,
    headers: &HeaderMap,
    raw: &Bytes,
) -> Result<Verified, Response> {
    let ip = Some(peer_address(peer, headers));
    let rate = rate_ip(ip.as_deref());
    let too_many = "слишком много попыток, подождите несколько минут";
    let ip_key = check_window_quota(
        st,
        &format!("local-login:{}", rate.as_deref().unwrap_or("?")),
        LOGIN_LIMIT,
        LOGIN_WINDOW_MS,
        too_many,
    )?;
    // Every attempt counts against the address…
    record_window_hit(st, &ip_key, LOGIN_WINDOW_MS);
    let body = parse(raw);
    let email = normalize_email(text(&body, "email"));
    let email_key: String = email.chars().take(254).collect();
    // …and every failure against the (account, address) pair, known or not.
    // Keyed by the pair, a stranger's failures cannot lock the owner out of
    // their own account from another address.
    let account_key = check_window_quota(
        st,
        &format!(
            "local-login-email:{email_key}|{}",
            rate.as_deref().unwrap_or("?")
        ),
        LOGIN_LIMIT,
        LOGIN_WINDOW_MS,
        too_many,
    )?;
    // Across all addresses a guessing campaign against one account only gets
    // slower — it never refuses, so it cannot become a denial of service.
    let global_key = format!("local-login-email-any:{email_key}");
    if check_window_quota(st, &global_key, ACCOUNT_SLOWDOWN_AFTER, LOGIN_WINDOW_MS, "").is_err() {
        tokio::time::sleep(ACCOUNT_SLOWDOWN).await;
    }
    let fail = |st: &AppState| {
        record_window_hit(st, &account_key, LOGIN_WINDOW_MS);
        record_window_hit(st, &global_key, LOGIN_WINDOW_MS);
        println!(
            "[local-login] refused attempt from {}",
            ip.as_deref().unwrap_or("?")
        );
        api_error(StatusCode::UNAUTHORIZED, GENERIC_ERROR)
    };
    let password = text(&body, "password").to_string();
    if password.chars().count() > MAX_PASSWORD_CHARS {
        return Err(fail(st));
    }
    let credential = st
        .workspaces
        .local_credential(&email)
        .map_err(|e| store_failure(e))?;
    let known = credential.is_some();
    let (user_id, cred_email, phc) =
        credential.unwrap_or_else(|| (String::new(), String::new(), dummy_hash().to_string()));
    let password_ok = match blocking(move || verify_password(&password, &phc)).await {
        Ok(ok) => ok && known,
        Err(e) => return Err(store_failure(e)),
    };
    // The code is looked at only for a right password, so a guess at the
    // password never burns the owner's code window.
    if !password_ok
        || !st
            .workspaces
            .local_verify_code(&user_id, text(&body, "code"), crate::totp::now_secs())
    {
        return Err(fail(st));
    }
    st.workspaces.audit_local_login(&user_id, ip.as_deref());
    println!("[local-login] signed in {user_id}");
    Ok(Verified {
        user_id,
        email: cred_email,
        ip,
        body,
    })
}

/// `POST /api/auth/local/login` `{email, password, code, native?}` -> a session.
pub(crate) async fn api_login(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !enabled() {
        return off();
    }
    if !same_origin(&headers) {
        return api_error(StatusCode::FORBIDDEN, "cross-site request rejected");
    }
    let v = match check_credentials(&st, peer, &headers, &body).await {
        Ok(v) => v,
        Err(response) => return response,
    };
    let native = v
        .body
        .get("native")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    session_response(&st, &v.user_id, &v.email, native, json!({"ok": true}))
}

/// `POST /api/auth/local/native-handoff`
/// `{email, password, code, native: true}` or
/// `{…, android: true, code_challenge, client_state}` -> `{redirect}`.
///
/// What the system browser of a mobile app (`/native-signin`, opened in
/// `ASWebAuthenticationSession` / a Custom Tab) does after a local sign-in:
/// the page cannot receive a 302 from a `fetch`, so the hub answers with the
/// address the provider-based logins redirect to, and the page navigates
/// there. It is `begin_login` + `finish_login` — the same two functions the
/// Google and OIDC hops use — so an iOS app gets `ccremote://auth?session=…`
/// and an Android app a one-use `hegai-code://auth?code=…` bound to its PKCE
/// challenge; no session token appears in any other URL.
pub(crate) async fn api_native_handoff(
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    State(st): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !enabled() {
        return off();
    }
    if !same_origin(&headers) {
        return api_error(StatusCode::FORBIDDEN, "cross-site request rejected");
    }
    // The hand-off parameters are checked BEFORE the credentials: a malformed
    // one must not cost the person a one-use authenticator code.
    let asked = parse(&body);
    let flag = |key: &str| asked.get(key).and_then(Value::as_bool).unwrap_or(false);
    let mut params: HashMap<String, String> = HashMap::new();
    if flag("native") {
        params.insert("native".into(), "1".into());
    }
    if flag("android") {
        params.insert("android".into(), "1".into());
        params.insert(
            "code_challenge".into(),
            text(&asked, "code_challenge").into(),
        );
        params.insert("client_state".into(), text(&asked, "client_state").into());
    }
    if params.is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "native or android is required");
    }
    let state = match begin_login(&st, peer, &params, &headers) {
        Ok(state) => state,
        Err(response) => return response,
    };
    let verified = match check_credentials(&st, peer, &headers, &body).await {
        Ok(v) => v,
        Err(response) => {
            // A refused attempt must not leave a pending hand-off behind.
            take_native_state(&st, &state);
            st.android_auth.take(&state);
            return response;
        }
    };
    let native = take_native_state(&st, &state);
    let android = st.android_auth.take(&state);
    let landed = finish_login(
        &st,
        &state,
        native,
        android,
        &verified.user_id,
        Some((PROVIDER_LOCAL, verified.email.as_str())),
        &headers,
        // `check_credentials` has just verified the authenticator code.
        crate::mfa::Factor::Proven,
    );
    let redirect = landed
        .headers()
        .get(header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .filter(|v| v.starts_with("ccremote://") || v.starts_with("hegai-code://"))
        .map(str::to_string);
    let Some(redirect) = redirect else {
        // `finish_login` refused (the account moved, too many pending codes):
        // its own answer says so.
        return landed;
    };
    println!(
        "[local-login] native hand-off for {} from {}",
        verified.user_id,
        verified.ip.as_deref().unwrap_or("?")
    );
    let mut response = Json(json!({"redirect": redirect})).into_response();
    response
        .headers_mut()
        .insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    no_store(response)
}

/// Who may enrol an authenticator, and on which session.
///
/// External edition: the signed-in platform admin on a fresh session (it is
/// what approves agent updates) — unchanged. Internal edition (`mfa.rs`): the
/// pending session of a person who owes a second factor and has none yet, or
/// any satisfied session signed in within `FRESH_SIGNIN_MS`.
fn totp_actor(st: &AppState, headers: &HeaderMap) -> Result<(String, Option<String>), Response> {
    if !crate::edition::is_external() {
        return crate::mfa::enroll_actor(st, headers, FRESH_SIGNIN_MS)
            .map(|(actor, token)| (actor, Some(token)));
    }
    let actor = mutation_user(headers, st)?;
    if !st.platform_admins.contains(&actor) {
        return Err(api_error(StatusCode::FORBIDDEN, "platform admin required"));
    }
    require_active(st, &actor)?;
    // The factor enrolled here approves agent rollouts, so a stolen or
    // long-lived session must not be enough to attach an attacker's phone:
    // only a session signed in within the last few minutes may do it.
    if !fresh_session(st, headers, &actor) {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "fresh_signin_required: выйдите и войдите заново, затем подключите аутентификатор в течение 10 минут",
        ));
    }
    Ok((actor, None))
}

/// How recent a sign-in must be to enrol an authenticator from a session.
const FRESH_SIGNIN_MS: i64 = 10 * 60 * 1000;

/// True when the request carries a session of `actor` created within
/// `FRESH_SIGNIN_MS`.
fn fresh_session(st: &AppState, headers: &HeaderMap, actor: &str) -> bool {
    let now = now_ms();
    [auth_cookie_token(headers), bearer_token(headers)]
        .into_iter()
        .flatten()
        .any(|token| {
            let hash = hash_token(&token);
            st.workspaces.with_conn(|c| {
                c.query_row(
                    "SELECT created_at FROM auth_sessions WHERE token_hash=?1 AND user_id=?2 AND expires_at>?3",
                    params![hash, actor, now],
                    |r| r.get::<_, i64>(0),
                )
                .map(|created| created <= now && now - created <= FRESH_SIGNIN_MS)
                .unwrap_or(false)
            })
        })
}

/// `POST /api/auth/totp/begin` -> `{otpauthUri, qrSvg?, secret}` for the signed-in
/// admin who has no authenticator yet; 409 `already_enrolled` when they do.
pub(crate) async fn api_totp_begin(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let (actor, _) = match totp_actor(&st, &headers) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let label = st
        .workspaces
        .user_email(&actor)
        .unwrap_or_else(|| actor.clone());
    let begun = st
        .workspaces
        .with_conn(|c| crate::user_totp::begin(c, &actor));
    match begun {
        Ok(secret) => {
            let uri = crate::totp::otpauth_uri(&brand_name(), &label, &secret);
            let mut out = json!({"secret": secret, "otpauthUri": uri});
            if let Some(svg) = qr_svg(&uri) {
                out["qrSvg"] = Value::String(svg);
            }
            no_store(Json(out).into_response())
        }
        Err(crate::user_totp::BeginError::AlreadyEnrolled) => {
            api_error(StatusCode::CONFLICT, "already_enrolled")
        }
        Err(crate::user_totp::BeginError::Db(e)) => store_failure(e),
    }
}

/// `POST /api/auth/totp/confirm {code}` -> `{recoveryCodes}` (shown once).
pub(crate) async fn api_totp_confirm(
    State(st): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (actor, session) = match totp_actor(&st, &headers) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let key = match check_window_quota(
        &st,
        &format!("totp-confirm:{actor}"),
        LOGIN_LIMIT,
        LOGIN_WINDOW_MS,
        "слишком много попыток, подождите несколько минут",
    ) {
        Ok(k) => k,
        Err(r) => return r,
    };
    record_window_hit(&st, &key, LOGIN_WINDOW_MS);
    let body = parse(&body);
    let code = text(&body, "code").to_string();
    // Internal edition: the confirmation and everything that follows from it
    // (links, this session, the demotion of the others, the audit row) are ONE
    // transaction; the codes leave only after it commits.
    if let Some(token) = session {
        let device = device_label(&headers);
        return match st.workspaces.confirm_enrolment(
            &token,
            &actor,
            &code,
            crate::totp::now_secs(),
            &device,
        ) {
            Ok(Some(done)) => crate::mfa::enrolment_response(&st, &actor, &token, done),
            Ok(None) => api_error(
                StatusCode::BAD_REQUEST,
                "Код из приложения не подошёл. Проверьте время на телефоне и введите новый.",
            ),
            Err(e) => store_failure(e),
        };
    }
    let confirmed = st.workspaces.with_conn(|c| {
        let codes = crate::user_totp::confirm(c, &actor, &code, crate::totp::now_secs())?;
        if codes.is_some() {
            if let Ok(Some(ws)) = crate::access::audit_workspace_in(c, &actor) {
                let _ = insert_audit(
                    c,
                    &ws,
                    &actor,
                    "auth.totp_enrolled",
                    "user",
                    &actor,
                    &json!({}),
                );
            }
        }
        Ok::<_, rusqlite::Error>(codes)
    });
    match confirmed {
        Ok(Some(codes)) => no_store(Json(json!({"recoveryCodes": codes})).into_response()),
        Ok(None) => api_error(
            StatusCode::BAD_REQUEST,
            "Код из приложения не подошёл. Проверьте время на телефоне и введите новый.",
        ),
        Err(e) => internal_error(e),
    }
}

fn admin(st: &AppState, headers: &HeaderMap) -> Result<String, Response> {
    if !enabled() {
        return Err(off());
    }
    let actor = mutation_user(headers, st)?;
    if !st.platform_admins.contains(&actor) {
        return Err(api_error(StatusCode::FORBIDDEN, "platform admin required"));
    }
    require_active(st, &actor)?;
    Ok(actor)
}

/// `POST /api/admin/local-users` `{email, fullName?}` -> `{userId, email, setupUrl, expiresAt}`.
pub(crate) async fn api_admin_create(
    State(st): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let actor = match admin(&st, &headers) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let body = parse(&body);
    let email = normalize_email(text(&body, "email"));
    if !valid_email(&email) {
        return api_error(StatusCode::BAD_REQUEST, "Укажите корректный адрес почты.");
    }
    let name: Option<String> = Some(text(&body, "fullName").trim().to_string())
        .filter(|n| !n.is_empty())
        .map(|n| n.chars().take(120).collect());
    let (user_id, created) =
        match st
            .workspaces
            .local_create_account(&email, name.as_deref(), &actor)
        {
            Ok(v) => v,
            Err(CreateError::Exists) => {
                return api_error(
                    StatusCode::CONFLICT,
                    "Этот адрес уже занят учёткой. Чтобы выдать новую ссылку, сбросьте вход.",
                )
            }
            Err(CreateError::Db(e)) => return store_failure(e),
        };
    let ttl = EMPLOYEE_LINK_HOURS * 60 * 60 * 1000;
    match st
        .workspaces
        .local_mint_setup_token(&user_id, &email, "setup", ttl)
    {
        Ok(token) => no_store(
            (
                StatusCode::CREATED,
                Json(json!({
                    "userId": user_id,
                    "email": email,
                    "created": created,
                    "setupUrl": setup_url(&st.public_url, &token),
                    "expiresAt": now_ms() + ttl,
                })),
            )
                .into_response(),
        ),
        Err(e) => store_failure(e),
    }
}

/// `POST /api/admin/local-users/{user_id}/reset` -> `{userId, email, setupUrl, expiresAt}`.
pub(crate) async fn api_admin_reset(
    AxumPath(user_id): AxumPath<String>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let actor = match admin(&st, &headers) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let email = match st.workspaces.local_reset(&user_id, &actor) {
        Ok(Some(e)) => e,
        Ok(None) => return api_error(StatusCode::NOT_FOUND, "у этой учётки нет локального входа"),
        Err(e) => return store_failure(e),
    };
    // The reset ended every session of that person: close the sockets they hold.
    st.hub.send(HubCmd::RefreshWorkspaceState);
    let ttl = EMPLOYEE_LINK_HOURS * 60 * 60 * 1000;
    match st
        .workspaces
        .local_mint_setup_token(&user_id, &email, "reset", ttl)
    {
        Ok(token) => no_store(
            Json(json!({
                "userId": user_id,
                "email": email,
                "setupUrl": setup_url(&st.public_url, &token),
                "expiresAt": now_ms() + ttl,
            }))
            .into_response(),
        ),
        Err(e) => store_failure(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::tests::{app_state, cleanup, temp_db};

    const OWNER: &str = "owner";
    const EMAIL: &str = "Owner@Acme.Test";
    const PASSWORD: &str = "correct horse battery";

    fn enable() {
        std::env::set_var("CC_REMOTE_LOCAL_LOGIN", "1");
    }

    struct Fx {
        st: AppState,
        db: std::path::PathBuf,
    }
    impl Drop for Fx {
        fn drop(&mut self) {
            cleanup(&self.db);
        }
    }

    fn fixture() -> Fx {
        enable();
        let db = temp_db();
        let workspaces = WorkspaceStore::open(&db).unwrap();
        workspaces.ensure_user(OWNER, EMAIL, None).unwrap();
        workspaces.set_always_active([OWNER.to_string()]);
        Fx {
            st: app_state(workspaces, &db),
            db,
        }
    }

    fn code_for(secret: &str, unix: u64) -> String {
        let raw = crate::totp::base32_decode(secret).unwrap();
        format!(
            "{:06}",
            crate::totp::code_at(&raw, crate::totp::step_of(unix))
        )
    }

    async fn post<F, Fut>(
        f: F,
        st: &AppState,
        ip: &str,
        body: Value,
    ) -> (StatusCode, Value, HeaderMap)
    where
        F: FnOnce(State<AppState>, ConnectInfo<SocketAddr>, HeaderMap, Bytes) -> Fut,
        Fut: std::future::Future<Output = Response>,
    {
        post_from(f, st, "127.0.0.1:9".parse().unwrap(), ip, body).await
    }

    /// Like `post`, from an arbitrary peer socket (loopback = our nginx, which
    /// is believed about `X-Real-IP`).
    async fn post_from<F, Fut>(
        f: F,
        st: &AppState,
        peer: SocketAddr,
        ip: &str,
        body: Value,
    ) -> (StatusCode, Value, HeaderMap)
    where
        F: FnOnce(State<AppState>, ConnectInfo<SocketAddr>, HeaderMap, Bytes) -> Fut,
        Fut: std::future::Future<Output = Response>,
    {
        let mut headers = HeaderMap::new();
        headers.insert("x-real-ip", HeaderValue::from_str(ip).unwrap());
        let res = f(
            State(st.clone()),
            ConnectInfo(peer),
            headers,
            Bytes::from(body.to_string()),
        )
        .await;
        let status = res.status();
        let out_headers = res.headers().clone();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            out_headers,
        )
    }

    /// Owner setup through the HTTP handlers; returns the authenticator secret
    /// and the recovery codes.
    async fn set_up_owner(st: &AppState) -> (String, Vec<String>) {
        let url =
            mint_setup_url(&st.workspaces, OWNER, EMAIL, "setup", 1, "http://x.test").unwrap();
        let token = url.split("#token=").nth(1).unwrap().to_string();
        let (s, begin, _) = post(api_setup_begin, st, "203.0.113.9", json!({"token": token})).await;
        assert_eq!(s, StatusCode::OK, "{begin}");
        assert_eq!(begin["email"], "owner@acme.test");
        assert!(begin["qrSvg"].as_str().unwrap().contains("<svg"));
        assert!(begin["otpauthUri"]
            .as_str()
            .unwrap()
            .starts_with("otpauth://totp/"));
        let secret = begin["secret"].as_str().unwrap().to_string();
        let (s, fin, headers) = post(
            api_setup_finish,
            st,
            "203.0.113.9",
            json!({"token": token, "password": PASSWORD, "code": code_for(&secret, crate::totp::now_secs())}),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{fin}");
        assert!(headers
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("cc-remote-auth="));
        let codes: Vec<String> = fin["recoveryCodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c.as_str().unwrap().to_string())
            .collect();
        assert_eq!(codes.len(), 10);
        (secret, codes)
    }

    /// A TOTP code in a step later than any already used, so a login is not
    /// refused as a replay of the setup code (the test clock cannot wait 30 s).
    fn later_code(secret: &str) -> String {
        code_for(secret, crate::totp::now_secs() + crate::totp::STEP_SECS)
    }

    #[test]
    fn on_only_for_the_external_edition_or_the_flag() {
        assert!(!enabled_from(false, None));
        assert!(!enabled_from(false, Some("0")));
        assert!(!enabled_from(false, Some("true")));
        assert!(enabled_from(false, Some("1")));
        assert!(enabled_from(true, None));
    }

    #[test]
    fn password_hashes_are_argon2id_and_verify() {
        let h = hash_password(PASSWORD).unwrap();
        assert!(h.starts_with("$argon2id$"));
        assert!(verify_password(PASSWORD, &h));
        assert!(!verify_password("another password", &h));
        assert!(!verify_password(PASSWORD, "not a hash"));
        assert_ne!(h, hash_password(PASSWORD).unwrap(), "salted");
    }

    #[test]
    fn email_shape() {
        assert!(valid_email("a@b.co"));
        assert!(!valid_email("a@b"));
        assert!(!valid_email("@b.co"));
        assert!(!valid_email("a b@c.co"));
        assert!(!valid_email("a@@b.co"));
    }

    #[tokio::test]
    async fn a_setup_token_is_single_use_and_expires_and_only_the_hash_is_stored() {
        let fx = fixture();
        let store = &fx.st.workspaces;
        let t = store
            .local_mint_setup_token(OWNER, EMAIL, "setup", 60_000)
            .unwrap();
        assert_eq!(URL_SAFE_NO_PAD.decode(&t).unwrap().len(), 32);
        let stored: String = store.with_conn(|c| {
            c.query_row("SELECT token_hash FROM local_setup_tokens", [], |r| {
                r.get(0)
            })
            .unwrap()
        });
        assert_ne!(stored, t);
        assert_eq!(stored, hash_token(&t));
        assert!(store.local_peek_setup_token(&t).unwrap().is_some());
        assert!(store.local_peek_setup_token("garbage").unwrap().is_none());
        // a newer token replaces the older one
        let t2 = store
            .local_mint_setup_token(OWNER, EMAIL, "setup", 60_000)
            .unwrap();
        assert!(store.local_peek_setup_token(&t).unwrap().is_none());
        assert!(store.local_peek_setup_token(&t2).unwrap().is_some());
        // expiry
        let t3 = store
            .local_mint_setup_token(OWNER, EMAIL, "setup", -1)
            .unwrap();
        assert!(store.local_peek_setup_token(&t3).unwrap().is_none());
        // single use: finish burns it
        let t4 = store
            .local_mint_setup_token(OWNER, EMAIL, "setup", 60_000)
            .unwrap();
        let (_, secret) = store.local_begin_setup(&t4).unwrap().unwrap();
        let now = crate::totp::now_secs();
        let hash = hash_password(PASSWORD).unwrap();
        let code = code_for(&secret.unwrap(), now);
        assert_eq!(
            store.local_finish_setup(&t4, &hash, "000000", now),
            FinishOutcome::BadCode,
            "a wrong code does not burn the token"
        );
        assert!(matches!(
            store.local_finish_setup(&t4, &hash, &code, now),
            FinishOutcome::Done { .. }
        ));
        assert_eq!(
            store.local_finish_setup(&t4, &hash, &code, now),
            FinishOutcome::BadToken
        );
        assert!(store.local_peek_setup_token(&t4).unwrap().is_none());
    }

    #[tokio::test]
    async fn only_a_fresh_session_may_enrol_an_authenticator() {
        let fx = fixture();
        let st = &fx.st;
        let token = st.workspaces.create_auth_session(OWNER, 1).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
        assert!(fresh_session(st, &headers, OWNER));
        assert!(!fresh_session(st, &headers, "someone-else"));
        st.workspaces.with_conn(|c| {
            c.execute(
                "UPDATE auth_sessions SET created_at = created_at - ?1",
                params![FRESH_SIGNIN_MS + 1],
            )
            .unwrap()
        });
        assert!(
            !fresh_session(st, &headers, OWNER),
            "an old session is not enough"
        );
        assert!(!fresh_session(st, &HeaderMap::new(), OWNER));
    }

    #[tokio::test]
    async fn a_setup_link_for_an_enrolled_account_still_needs_the_code() {
        let fx = fixture();
        let store = &fx.st.workspaces;
        let now = crate::totp::now_secs();
        let t = store
            .local_mint_setup_token(OWNER, EMAIL, "setup", 60_000)
            .unwrap();
        let (_, secret) = store.local_begin_setup(&t).unwrap().unwrap();
        let secret = secret.unwrap();
        let hash = hash_password(PASSWORD).unwrap();
        assert!(matches!(
            store.local_finish_setup(&t, &hash, &code_for(&secret, now), now),
            FinishOutcome::Done { .. }
        ));
        // A second link (e.g. printed again at start-up) must not set a new
        // password on the strength of the link alone.
        let t2 = store
            .local_mint_setup_token(OWNER, EMAIL, "setup", 60_000)
            .unwrap();
        let (_, again) = store.local_begin_setup(&t2).unwrap().unwrap();
        assert!(again.is_none(), "no new secret for an enrolled account");
        let later = now + crate::totp::STEP_SECS;
        assert_eq!(
            store.local_finish_setup(&t2, &hash, "", later),
            FinishOutcome::BadCode
        );
        assert!(
            store.local_peek_setup_token(&t2).unwrap().is_some(),
            "not burned"
        );
        assert!(matches!(
            store.local_finish_setup(&t2, &hash, &code_for(&secret, later), later),
            FinishOutcome::Done { .. }
        ));
    }

    #[tokio::test]
    async fn setup_then_login_with_a_code_and_with_a_recovery_code() {
        let fx = fixture();
        let st = &fx.st;
        let (secret, codes) = set_up_owner(st).await;
        // right everything (a later TOTP step: the setup code is spent)
        let (s, body, headers) = post(
            api_login,
            st,
            "198.51.100.1",
            json!({"email": " OWNER@acme.test ", "password": PASSWORD, "code": later_code(&secret)}),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{body}");
        let cookie = headers
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        let session = cookie
            .split(';')
            .next()
            .unwrap()
            .trim_start_matches("cc-remote-auth=")
            .to_string();
        assert_eq!(
            st.workspaces.authenticate(&session).unwrap().unwrap().0,
            OWNER
        );
        // the same code twice is a replay
        let (s, _, _) = post(
            api_login,
            st,
            "198.51.100.1",
            json!({"email": EMAIL, "password": PASSWORD, "code": later_code(&secret)}),
        )
        .await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        // a recovery code works once
        let body = json!({"email": EMAIL, "password": PASSWORD, "code": codes[0]});
        assert_eq!(
            post(api_login, st, "198.51.100.1", body.clone()).await.0,
            StatusCode::OK
        );
        assert_eq!(
            post(api_login, st, "198.51.100.1", body).await.0,
            StatusCode::UNAUTHORIZED
        );
        // native asks for the token in the body, no cookie
        let (s, body, headers) = post(
            api_login,
            st,
            "198.51.100.1",
            json!({"email": EMAIL, "password": PASSWORD, "code": codes[1], "native": true}),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert!(body["session"].as_str().is_some());
        assert!(headers.get(header::SET_COOKIE).is_none());
    }

    #[tokio::test]
    async fn every_failure_says_the_same_thing() {
        let fx = fixture();
        let st = &fx.st;
        let (secret, _) = set_up_owner(st).await;
        let good_code = later_code(&secret);
        let cases = [
            json!({"email": EMAIL, "password": "wrong password here", "code": good_code}),
            json!({"email": EMAIL, "password": PASSWORD, "code": "000000"}),
            json!({"email": "nobody@acme.test", "password": PASSWORD, "code": good_code}),
            json!({"email": EMAIL, "password": PASSWORD}),
            json!({}),
        ];
        for (i, case) in cases.iter().enumerate() {
            let (s, body, headers) =
                post(api_login, st, &format!("192.0.2.{i}"), case.clone()).await;
            assert_eq!(s, StatusCode::UNAUTHORIZED, "{case}");
            assert_eq!(body["error"], GENERIC_ERROR, "{case}");
            assert!(headers.get(header::SET_COOKIE).is_none());
        }
    }

    #[tokio::test]
    async fn a_wrong_password_does_not_spend_the_code() {
        let fx = fixture();
        let st = &fx.st;
        let (secret, _) = set_up_owner(st).await;
        let code = later_code(&secret);
        let (s, _, _) = post(
            api_login,
            st,
            "192.0.2.77",
            json!({"email": EMAIL, "password": "wrong password here", "code": code}),
        )
        .await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        let (s, _, _) = post(
            api_login,
            st,
            "192.0.2.77",
            json!({"email": EMAIL, "password": PASSWORD, "code": code}),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
    }

    #[tokio::test]
    async fn sign_in_is_rate_limited_per_address_and_per_account_address_pair() {
        let fx = fixture();
        let st = &fx.st;
        let bad = json!({"email": EMAIL, "password": "wrong password here", "code": "000000"});
        // per address: the 11th attempt from one IP is a 429, even for another account
        for _ in 0..LOGIN_LIMIT {
            let other = json!({"email": format!("x{}@acme.test", rand_suffix()), "password": "x"});
            assert_eq!(
                post(api_login, st, "203.0.113.50", other).await.0,
                StatusCode::UNAUTHORIZED
            );
        }
        let (s, _, _) = post(api_login, st, "203.0.113.50", bad.clone()).await;
        assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);
        // per (account, address): ten failures from one address lock only that
        // address's guesses…
        for i in 0..LOGIN_LIMIT {
            let (s, _, _) = post(api_login, st, "198.18.0.7", bad.clone()).await;
            assert_eq!(s, StatusCode::UNAUTHORIZED, "attempt {i}");
        }
        let (s, _, _) = post(api_login, st, "198.18.0.7", bad.clone()).await;
        assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);
        // …a stranger cannot lock the owner out from another address.
        let (s, _, _) = post(api_login, st, "198.18.1.1", bad).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn many_addresses_slow_an_account_down_but_never_lock_it() {
        let fx = fixture();
        let st = &fx.st;
        let bad = json!({"email": EMAIL, "password": "wrong password here", "code": "000000"});
        let key = format!("local-login-email-any:{}", normalize_email(EMAIL));
        for _ in 0..ACCOUNT_SLOWDOWN_AFTER {
            record_window_hit(st, &key, LOGIN_WINDOW_MS);
        }
        let started = std::time::Instant::now();
        let (s, _, _) = post(api_login, st, "198.18.2.2", bad).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED, "delayed, not refused");
        assert!(started.elapsed() >= ACCOUNT_SLOWDOWN);
        // and below the threshold there is no delay
        let fresh = fixture();
        let started = std::time::Instant::now();
        let ok = json!({"email": EMAIL, "password": "wrong password here", "code": "000000"});
        let (s, _, _) = post(api_login, &fresh.st, "198.18.2.3", ok).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
        assert!(started.elapsed() < ACCOUNT_SLOWDOWN);
    }

    #[tokio::test]
    async fn x_real_ip_is_believed_only_from_a_trusted_peer() {
        let fx = fixture();
        let st = &fx.st;
        let stranger: SocketAddr = "203.0.113.77:4000".parse().unwrap();
        // A direct caller rotating X-Real-IP is still one address.
        for i in 0..LOGIN_LIMIT {
            let other = json!({"email": format!("x{}@acme.test", rand_suffix()), "password": "x"});
            let (s, _, _) = post_from(api_login, st, stranger, &format!("10.9.0.{i}"), other).await;
            assert_eq!(s, StatusCode::UNAUTHORIZED);
        }
        let other = json!({"email": "late@acme.test", "password": "x"});
        let (s, _, _) = post_from(api_login, st, stranger, "10.9.9.9", other.clone()).await;
        assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);
        // Our loopback nginx is believed: the same header from loopback is a fresh address.
        let (s, _, _) = post(api_login, st, "10.9.9.9", other).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
    }

    async fn handoff(st: &AppState, ip: &str, body: Value) -> (StatusCode, Value, HeaderMap) {
        post(|s, c, h, b| api_native_handoff(c, s, h, b), st, ip, body).await
    }

    fn pkce() -> (String, String, String) {
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use sha2::{Digest, Sha256};
        let verifier = "v".repeat(43);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        (verifier, challenge, "s".repeat(40))
    }

    #[tokio::test]
    async fn the_android_hand_off_issues_a_one_use_code_bound_to_the_challenge() {
        let fx = fixture();
        let st = &fx.st;
        let (secret, _) = set_up_owner(st).await;
        let (verifier, challenge, client_state) = pkce();
        let (s, body, headers) = handoff(
            st,
            "198.51.100.20",
            json!({"email": EMAIL, "password": PASSWORD, "code": later_code(&secret),
                   "android": true, "code_challenge": challenge, "client_state": client_state}),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{body}");
        assert!(headers.get(header::SET_COOKIE).is_none());
        let redirect = body["redirect"].as_str().unwrap();
        let prefix = "hegai-code://auth?code=";
        assert!(redirect.starts_with(prefix), "{redirect}");
        assert!(redirect.ends_with(&format!("&state={client_state}")));
        // no session bearer anywhere in the URL
        assert!(!redirect.contains("session"));
        let code = redirect[prefix.len()..].split('&').next().unwrap();
        // the wrong verifier does not exchange (and does not burn the code)…
        assert!(st
            .android_auth
            .exchange_bound(code, &"w".repeat(43))
            .is_none());
        // …the right one does, once, and names the owner and the local identity
        let (user, identity) = st.android_auth.exchange_bound(code, &verifier).unwrap();
        assert_eq!(user, OWNER);
        assert_eq!(
            identity,
            Some((PROVIDER_LOCAL.to_string(), "owner@acme.test".to_string()))
        );
        assert!(st.android_auth.exchange_bound(code, &verifier).is_none());
    }

    #[tokio::test]
    async fn the_ios_hand_off_returns_the_native_scheme_with_a_working_session() {
        let fx = fixture();
        let st = &fx.st;
        let (secret, _) = set_up_owner(st).await;
        let (s, body, headers) = handoff(
            st,
            "198.51.100.21",
            json!({"email": EMAIL, "password": PASSWORD, "code": later_code(&secret), "native": true}),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{body}");
        assert!(headers.get(header::SET_COOKIE).is_none());
        let redirect = body["redirect"].as_str().unwrap();
        let session = redirect.strip_prefix("ccremote://auth?session=").unwrap();
        let session = urlencoding::decode(session).unwrap();
        assert_eq!(
            st.workspaces.authenticate(&session).unwrap().unwrap().0,
            OWNER
        );
    }

    #[tokio::test]
    async fn the_hand_off_refuses_in_the_same_words_and_leaves_nothing_pending() {
        let fx = fixture();
        let st = &fx.st;
        let (secret, _) = set_up_owner(st).await;
        let (_, challenge, client_state) = pkce();
        // wrong password: the generic sentence, and the one-use code is not spent
        let code = later_code(&secret);
        for (i, wrong) in [
            json!({"email": EMAIL, "password": "wrong password here", "code": code}),
            json!({"email": "nobody@acme.test", "password": PASSWORD, "code": code}),
        ]
        .into_iter()
        .enumerate()
        {
            let mut asked = wrong;
            asked["android"] = json!(true);
            asked["code_challenge"] = json!(challenge);
            asked["client_state"] = json!(client_state);
            let (s, body, _) = handoff(st, &format!("192.0.2.{}", 100 + i), asked).await;
            assert_eq!(s, StatusCode::UNAUTHORIZED);
            assert_eq!(body["error"], GENERIC_ERROR);
            assert!(body.get("redirect").is_none());
        }
        // twelve refused attempts did not fill the Android table (limit 12 per source)
        for i in 0..14 {
            let (s, _, _) = handoff(
                st,
                &format!("192.0.2.{}", 110 + i),
                json!({"email": format!("n{i}@acme.test"), "password": "wrong password here", "code": "000000",
                       "android": true, "code_challenge": challenge, "client_state": client_state}),
            )
            .await;
            assert_eq!(s, StatusCode::UNAUTHORIZED);
        }
        // the code was not spent by the refusals
        let (s, body, _) = handoff(
            st,
            "198.51.100.30",
            json!({"email": EMAIL, "password": PASSWORD, "code": code,
                   "android": true, "code_challenge": challenge, "client_state": client_state}),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{body}");
    }

    #[tokio::test]
    async fn a_malformed_hand_off_is_refused_before_the_credentials_are_looked_at() {
        let fx = fixture();
        let st = &fx.st;
        let (secret, _) = set_up_owner(st).await;
        let code = later_code(&secret);
        let good = json!({"email": EMAIL, "password": PASSWORD, "code": code});
        // neither mode
        let (s, _, _) = handoff(st, "198.51.100.40", good.clone()).await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
        // a bad PKCE challenge
        let mut bad = good.clone();
        bad["android"] = json!(true);
        bad["code_challenge"] = json!("short");
        bad["client_state"] = json!("s".repeat(40));
        assert_eq!(
            handoff(st, "198.51.100.40", bad).await.0,
            StatusCode::BAD_REQUEST
        );
        // both modes
        let (_, challenge, client_state) = pkce();
        let mut both = good.clone();
        both["android"] = json!(true);
        both["native"] = json!(true);
        both["code_challenge"] = json!(challenge);
        both["client_state"] = json!(client_state);
        assert_eq!(
            handoff(st, "198.51.100.40", both).await.0,
            StatusCode::BAD_REQUEST
        );
        // none of it spent the authenticator code
        let mut ok = good;
        ok["native"] = json!(true);
        assert_eq!(handoff(st, "198.51.100.41", ok).await.0, StatusCode::OK);
    }

    #[tokio::test]
    async fn the_hand_off_is_rate_limited_like_the_login() {
        let fx = fixture();
        let st = &fx.st;
        let bad = json!({"email": EMAIL, "password": "wrong password here", "code": "000000", "native": true});
        for _ in 0..LOGIN_LIMIT {
            assert_eq!(
                handoff(st, "203.0.113.60", bad.clone()).await.0,
                StatusCode::UNAUTHORIZED
            );
        }
        assert_eq!(
            handoff(st, "203.0.113.60", bad).await.0,
            StatusCode::TOO_MANY_REQUESTS
        );
    }

    fn rand_suffix() -> String {
        Uuid::new_v4().simple().to_string()
    }

    #[tokio::test]
    async fn a_dead_or_short_setup_is_refused() {
        let fx = fixture();
        let st = &fx.st;
        let (s, _, _) = post(api_setup_begin, st, "192.0.2.5", json!({"token": "nope"})).await;
        assert_eq!(s, StatusCode::GONE);
        let url =
            mint_setup_url(&st.workspaces, OWNER, EMAIL, "setup", 1, "http://x.test").unwrap();
        let token = url.split("#token=").nth(1).unwrap();
        let (s, body, _) = post(
            api_setup_finish,
            st,
            "192.0.2.5",
            json!({"token": token, "password": "short", "code": "123456"}),
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{body}");
        let (s, _, _) = post(
            api_setup_finish,
            st,
            "192.0.2.5",
            json!({"token": "nope", "password": PASSWORD, "code": "123456"}),
        )
        .await;
        assert_eq!(s, StatusCode::GONE);
    }

    fn bearer(st: &AppState, user: &str) -> HeaderMap {
        let (session, _) = st
            .workspaces
            .create_auth_session_for_as(None, user, 1, crate::mfa::Factor::Proven)
            .unwrap();
        let mut h = HeaderMap::new();
        h.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {session}")).unwrap(),
        );
        h
    }

    async fn invite(
        st: &AppState,
        h: HeaderMap,
        ws: &str,
        email: &str,
        role: &str,
    ) -> (StatusCode, Value) {
        let res = crate::workspace_api::api_invite(
            AxumPath(ws.to_string()),
            State(st.clone()),
            h,
            Json(json!({"email": email, "role": role})),
        )
        .await;
        let status = res.status();
        let body = serde_json::from_slice(
            &axum::body::to_bytes(res.into_body(), 1 << 16)
                .await
                .unwrap(),
        )
        .unwrap_or(Value::Null);
        (status, body)
    }

    fn team(st: &AppState) -> String {
        st.workspaces
            .create_organization(OWNER, "Acme", OWNER)
            .unwrap()["workspaceId"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[tokio::test]
    async fn inviting_a_new_address_hands_out_a_setup_link_that_lands_in_the_team() {
        let fx = fixture();
        let st = &fx.st;
        let ws = team(st);
        let (status, body) = invite(st, bearer(st, OWNER), &ws, "New@Acme.Test", "manager").await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        let url = body["setupUrl"].as_str().expect("a setup link").to_string();
        assert!(
            url.starts_with("http://127.0.0.1:4319/setup#token="),
            "{url}"
        );
        let invite_token = body["token"].as_str().unwrap();
        assert!(url.ends_with(&format!("&invite={invite_token}")));
        let setup = url
            .split("#token=")
            .nth(1)
            .unwrap()
            .split('&')
            .next()
            .unwrap()
            .to_string();
        // hashed at rest, a week long, audited
        let (stored, expires): (String, i64) = st.workspaces.with_conn(|c| {
            c.query_row(
                "SELECT token_hash,expires_at FROM local_setup_tokens",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap()
        });
        assert_ne!(stored, setup);
        let week = 7 * 24 * 3600 * 1000;
        assert!((expires - now_ms() - week).abs() < 60_000);
        let audited: i64 = st.workspaces.with_conn(|c| {
            c.query_row("SELECT COUNT(*) FROM audit_events WHERE action='auth.local_user_invited' AND actor_user_id=?1", [OWNER], |r| r.get(0)).unwrap()
        });
        assert_eq!(audited, 1);
        // the invited person finishes setup, then accepts: they are in the team
        let (_, secret) = st.workspaces.local_begin_setup(&setup).unwrap().unwrap();
        let hash = hash_password(PASSWORD).unwrap();
        let FinishOutcome::Done {
            user_id, joined, ..
        } = st.workspaces.local_finish_setup(
            &setup,
            &hash,
            &code_for(&secret.unwrap(), crate::totp::now_secs()),
            crate::totp::now_secs(),
        )
        else {
            panic!("setup did not finish")
        };
        // no separate accept: finishing the setup put them in the team
        assert_eq!(joined, Some((ws.clone(), OWNER.to_string())));
        assert!(st
            .workspaces
            .accept_invitation(&user_id, invite_token)
            .is_err());
        let role: String = st.workspaces.with_conn(|c| {
            c.query_row(
                "SELECT role FROM memberships WHERE workspace_id=?1 AND user_id=?2",
                params![ws, user_id],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(role, "manager");
        // the setup link is single use
        assert!(st
            .workspaces
            .local_peek_setup_token(&setup)
            .unwrap()
            .is_none());
        assert_eq!(
            st.workspaces
                .local_finish_setup(&setup, &hash, "000000", crate::totp::now_secs()),
            FinishOutcome::BadToken
        );
    }

    #[tokio::test]
    async fn inviting_an_address_with_a_password_never_hands_out_a_setup_link() {
        let fx = fixture();
        let st = &fx.st;
        let ws = team(st);
        set_up_owner(st).await;
        // the owner's own address, and another account that has a password
        st.workspaces
            .ensure_user("anna", "anna@acme.test", None)
            .unwrap();
        st.workspaces
            .local_ensure_identity("anna", "anna@acme.test")
            .unwrap();
        let hash = hash_password(PASSWORD).unwrap();
        st.workspaces.with_conn(|c| {
            c.execute("INSERT INTO local_credentials(user_id,email,password_hash,created_at,updated_at) VALUES('anna','anna@acme.test',?1,1,1)", [&hash]).unwrap()
        });
        // an account from another provider (no local identity)
        st.workspaces
            .ensure_user("ivan", "ivan@acme.test", None)
            .unwrap();
        for email in ["anna@acme.test", "ivan@acme.test"] {
            let (status, body) = invite(st, bearer(st, OWNER), &ws, email, "member").await;
            assert_eq!(status, StatusCode::CREATED, "{body}");
            assert!(body.get("setupUrl").is_none(), "{email}: {body}");
            assert!(body["token"].as_str().is_some());
        }
        let tokens: i64 = st.workspaces.with_conn(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM local_setup_tokens WHERE used_at IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(tokens, 0);
    }

    #[tokio::test]
    async fn existing_accounts_and_non_admins_never_get_a_setup_link() {
        let fx = fixture();
        let st = &fx.st;
        let ws = team(st);
        // a Google sign-in bound to local (like the hub owner at start), no password
        st.workspaces
            .ensure_user("gina", "gina@acme.test", None)
            .unwrap();
        st.workspaces
            .local_ensure_identity("gina", "gina@acme.test")
            .unwrap();
        st.workspaces
            .with_conn(|c| crate::identity::link(c, "google", "g-1", "gina", 1).unwrap());
        // an employee the admin made and who has not signed in yet
        let (emp, _) = st
            .workspaces
            .local_create_account("emp@acme.test", None, OWNER)
            .unwrap();
        for email in ["gina@acme.test", "emp@acme.test"] {
            let (status, body) = invite(st, bearer(st, OWNER), &ws, email, "member").await;
            assert_eq!(status, StatusCode::CREATED, "{body}");
            assert!(body.get("setupUrl").is_none(), "{email}: {body}");
        }
        assert!(st.workspaces.local_peek_setup_token("x").unwrap().is_none());
        let _ = emp;
        // a team owner who is not a platform admin cannot mint accounts
        st.workspaces
            .ensure_user("bob", "bob@acme.test", None)
            .unwrap();
        st.workspaces.set_always_active(["bob".to_string()]);
        let bws = st
            .workspaces
            .create_organization(OWNER, "Bobs", "bob")
            .unwrap()["workspaceId"]
            .as_str()
            .unwrap()
            .to_string();
        let (status, body) =
            invite(st, bearer(st, "bob"), &bws, "ceo@company.test", "member").await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        assert!(body.get("setupUrl").is_none(), "{body}");
        let made: i64 = st.workspaces.with_conn(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM users WHERE email='ceo@company.test'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(made, 0);
    }

    #[tokio::test]
    async fn a_withdrawn_invitation_kills_its_setup_link() {
        let fx = fixture();
        let st = &fx.st;
        let ws = team(st);
        let (_, body) = invite(st, bearer(st, OWNER), &ws, "gone@acme.test", "member").await;
        let url = body["setupUrl"].as_str().unwrap();
        let setup = url
            .split("#token=")
            .nth(1)
            .unwrap()
            .split('&')
            .next()
            .unwrap()
            .to_string();
        // the link is live; then the owner withdraws the invitation
        let (_, secret) = st.workspaces.local_begin_setup(&setup).unwrap().unwrap();
        st.workspaces
            .with_conn(|c| c.execute("DELETE FROM invitations", []).unwrap());
        assert!(st.workspaces.local_begin_setup(&setup).unwrap().is_none());
        assert!(st.workspaces.local_setup_invite_dead(&setup));
        let hash = hash_password(PASSWORD).unwrap();
        let outcome = st.workspaces.local_finish_setup(
            &setup,
            &hash,
            &code_for(&secret.unwrap(), crate::totp::now_secs()),
            crate::totp::now_secs(),
        );
        assert_eq!(outcome, FinishOutcome::BadToken);
        let uid = st.workspaces.local_credential("gone@acme.test").unwrap();
        assert!(uid.is_none(), "no password was set");
        let sessions: i64 = st.workspaces.with_conn(|c| {
            c.query_row("SELECT COUNT(*) FROM auth_sessions WHERE user_id IN (SELECT user_id FROM users WHERE email='gone@acme.test')", [], |r| r.get(0)).unwrap()
        });
        assert_eq!(sessions, 0);
    }

    #[tokio::test]
    async fn a_reset_account_is_not_re_opened_by_an_invitation() {
        let fx = fixture();
        let st = &fx.st;
        let ws = team(st);
        set_up_owner(st).await;
        st.workspaces.local_reset(OWNER, OWNER).unwrap();
        let (status, body) = invite(st, bearer(st, OWNER), &ws, EMAIL, "member").await;
        assert_eq!(status, StatusCode::CREATED);
        assert!(body.get("setupUrl").is_none(), "{body}");
        // an unfinished invitation account IS re-issued (the old link dies)
        let (_, first) = invite(st, bearer(st, OWNER), &ws, "new@acme.test", "member").await;
        let (_, second) = invite(st, bearer(st, OWNER), &ws, "new@acme.test", "member").await;
        let tok = |b: &Value| {
            b["setupUrl"]
                .as_str()
                .unwrap()
                .split("#token=")
                .nth(1)
                .unwrap()
                .split('&')
                .next()
                .unwrap()
                .to_string()
        };
        assert!(st
            .workspaces
            .local_peek_setup_token(&tok(&first))
            .unwrap()
            .is_none());
        assert!(st
            .workspaces
            .local_peek_setup_token(&tok(&second))
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn only_the_team_owner_invites_and_no_account_is_made_for_a_refusal() {
        let fx = fixture();
        let st = &fx.st;
        let ws = team(st);
        st.workspaces
            .ensure_user("bob", "bob@acme.test", None)
            .unwrap();
        let (status, _) = invite(st, bearer(st, "bob"), &ws, "x@acme.test", "member").await;
        assert!(status.is_client_error(), "{status}");
        let (status, _) = invite(st, bearer(st, OWNER), &ws, "x@acme.test", "owner").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let made: i64 = st.workspaces.with_conn(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM users WHERE email='x@acme.test'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(made, 0);
    }

    #[tokio::test]
    async fn an_expired_setup_link_is_dead() {
        let fx = fixture();
        let st = &fx.st;
        let ws = team(st);
        let (_, body) = invite(st, bearer(st, OWNER), &ws, "late@acme.test", "member").await;
        let setup = body["setupUrl"]
            .as_str()
            .unwrap()
            .split("#token=")
            .nth(1)
            .unwrap()
            .split('&')
            .next()
            .unwrap()
            .to_string();
        st.workspaces.with_conn(|c| {
            c.execute("UPDATE local_setup_tokens SET expires_at=1", [])
                .unwrap()
        });
        assert!(st.workspaces.local_begin_setup(&setup).unwrap().is_none());
    }

    #[tokio::test]
    async fn an_invitation_preview_names_the_team_and_dies_with_the_invitation() {
        let fx = fixture();
        let st = &fx.st;
        let ws = team(st);
        let (_, body) = invite(st, bearer(st, OWNER), &ws, "p@acme.test", "member").await;
        let token = body["token"].as_str().unwrap();
        let (team_name, inviter, email) = st.workspaces.invitation_preview(token).unwrap().unwrap();
        assert_eq!(
            (team_name.as_str(), email.as_str()),
            ("Acme", "p@acme.test")
        );
        assert!(!inviter.is_empty());
        assert!(st.workspaces.invitation_preview("nope").unwrap().is_none());
    }

    #[tokio::test]
    async fn an_admin_invites_an_employee_and_resets_a_lost_phone() {
        let fx = fixture();
        let st = &fx.st;
        let admin_session = st.workspaces.create_auth_session(OWNER, 1).unwrap();
        let mut h = HeaderMap::new();
        h.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {admin_session}")).unwrap(),
        );
        let res = api_admin_create(
            State(st.clone()),
            h.clone(),
            Bytes::from(json!({"email": "Anna@Acme.Test", "fullName": "Anna"}).to_string()),
        )
        .await;
        assert_eq!(res.status(), StatusCode::CREATED);
        let body: Value = serde_json::from_slice(
            &axum::body::to_bytes(res.into_body(), 1 << 16)
                .await
                .unwrap(),
        )
        .unwrap();
        let anna = body["userId"].as_str().unwrap().to_string();
        assert!(anna.starts_with("l-"));
        assert_eq!(body["email"], "anna@acme.test");
        let url = body["setupUrl"].as_str().unwrap();
        assert!(url.starts_with("http://127.0.0.1:4319/setup#token="));
        // a second invitation of a pending address re-issues; the old link dies
        let first = url.split("#token=").nth(1).unwrap().to_string();
        let res = api_admin_create(
            State(st.clone()),
            h.clone(),
            Bytes::from(json!({"email": "anna@acme.test"}).to_string()),
        )
        .await;
        assert_eq!(res.status(), StatusCode::CREATED);
        assert!(st
            .workspaces
            .local_peek_setup_token(&first)
            .unwrap()
            .is_none());
        // the audit trail names the admin
        let audited: i64 = st.workspaces.with_conn(|c| {
            c.query_row("SELECT COUNT(*) FROM audit_events WHERE action='auth.local_user_invited' AND actor_user_id=?1", [OWNER], |r| r.get(0)).unwrap()
        });
        assert_eq!(audited, 2);
        // Anna sets herself up
        let token = st
            .workspaces
            .local_mint_setup_token(&anna, "anna@acme.test", "setup", 60_000)
            .unwrap();
        let (_, secret) = st.workspaces.local_begin_setup(&token).unwrap().unwrap();
        let hash = hash_password(PASSWORD).unwrap();
        assert!(matches!(
            st.workspaces.local_finish_setup(
                &token,
                &hash,
                &code_for(&secret.unwrap(), crate::totp::now_secs()),
                crate::totp::now_secs()
            ),
            FinishOutcome::Done { .. }
        ));
        assert!(st.workspaces.local_has_credential(&anna).unwrap());
        // …and is now taken
        let res = api_admin_create(
            State(st.clone()),
            h.clone(),
            Bytes::from(json!({"email": "anna@acme.test"}).to_string()),
        )
        .await;
        assert_eq!(res.status(), StatusCode::CONFLICT);
        // lost phone
        let anna_session = st.workspaces.create_auth_session(&anna, 1).unwrap();
        let res = api_admin_reset(AxumPath(anna.clone()), State(st.clone()), h.clone()).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert!(!st.workspaces.local_has_credential(&anna).unwrap());
        assert!(
            st.workspaces.authenticate(&anna_session).unwrap().is_none(),
            "sessions ended"
        );
        let body: Value = serde_json::from_slice(
            &axum::body::to_bytes(res.into_body(), 1 << 16)
                .await
                .unwrap(),
        )
        .unwrap();
        let token = body["setupUrl"]
            .as_str()
            .unwrap()
            .split("#token=")
            .nth(1)
            .unwrap()
            .to_string();
        let tok = st
            .workspaces
            .local_peek_setup_token(&token)
            .unwrap()
            .unwrap();
        assert_eq!(tok.purpose, "reset");
        // enrolment starts over
        assert!(st
            .workspaces
            .local_begin_setup(&token)
            .unwrap()
            .unwrap()
            .1
            .is_some());
        // an unknown user has no local sign-in
        let res = api_admin_reset(AxumPath("ghost".into()), State(st.clone()), h).await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn only_a_platform_admin_may_invite() {
        let fx = fixture();
        let st = &fx.st;
        let (employee, _) = st
            .workspaces
            .local_create_account("e@acme.test", None, OWNER)
            .unwrap();
        let session = st.workspaces.create_auth_session(&employee, 1).unwrap();
        let mut h = HeaderMap::new();
        h.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {session}")).unwrap(),
        );
        let res = api_admin_create(
            State(st.clone()),
            h.clone(),
            Bytes::from(json!({"email": "z@acme.test"}).to_string()),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        let res = api_admin_reset(AxumPath(employee), State(st.clone()), h).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn the_owner_announcement_is_made_only_while_the_owner_has_no_password_and_authenticator()
    {
        let fx = fixture();
        let store = &fx.st.workspaces;
        announce_owner_setup(store, OWNER, EMAIL, "http://x.test");
        let n: i64 = store.with_conn(|c| {
            c.query_row("SELECT COUNT(*) FROM local_setup_tokens", [], |r| r.get(0))
                .unwrap()
        });
        assert_eq!(n, 1);
        let hash = hash_password(PASSWORD).unwrap();
        store.with_conn(|c| {
            c.execute(
                "INSERT INTO local_credentials VALUES(?1,'owner@acme.test',?2,1,1)",
                params![OWNER, hash],
            )
            .unwrap()
        });
        store.with_conn(|c| {
            let secret = crate::user_totp::begin(c, OWNER).unwrap();
            let t = crate::totp::now_secs();
            crate::user_totp::confirm(c, OWNER, &code_for(&secret, t), t)
                .unwrap()
                .unwrap();
            c.execute("DELETE FROM local_setup_tokens", []).unwrap()
        });
        announce_owner_setup(store, OWNER, EMAIL, "http://x.test");
        let n: i64 = store.with_conn(|c| {
            c.query_row("SELECT COUNT(*) FROM local_setup_tokens", [], |r| r.get(0))
                .unwrap()
        });
        assert_eq!(n, 0);
    }

    #[tokio::test]
    async fn the_cli_prints_a_link_for_a_known_address_only() {
        let fx = fixture();
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            run_setup_link_cli(
                &args(&["--email", "owner@acme.test", "--hours", "2"]),
                &fx.db,
                "http://x.test"
            ),
            0
        );
        assert_eq!(
            run_setup_link_cli(
                &args(&["--email", "nobody@acme.test"]),
                &fx.db,
                "http://x.test"
            ),
            1
        );
        assert_eq!(run_setup_link_cli(&args(&[]), &fx.db, "http://x.test"), 2);
        assert_eq!(
            run_setup_link_cli(
                &args(&["--email", "owner@acme.test", "--hours", "0"]),
                &fx.db,
                "http://x.test"
            ),
            2
        );
    }

    #[test]
    fn external_edition_owner_created_accounts_are_active() {
        use crate::edition::{with_edition, Edition};
        let s = WorkspaceStore::open_memory();
        with_edition(Edition::External, || {
            let (id, _) = s.local_create_account("e@acme.test", None, "o").unwrap();
            assert_eq!(s.access_state(&id).unwrap().state, "active");
        });
        with_edition(Edition::Internal, || {
            let (id, _) = s.local_create_account("f@acme.test", None, "o").unwrap();
            assert_eq!(s.access_state(&id).unwrap().state, "waitlist");
        });
    }

    async fn body_json(res: Response) -> Value {
        serde_json::from_slice(
            &axum::body::to_bytes(res.into_body(), 1 << 16)
                .await
                .unwrap(),
        )
        .unwrap_or(Value::Null)
    }

    #[test]
    fn a_signed_in_admin_can_enrol_an_authenticator_on_both_editions() {
        use crate::edition::{with_edition, Edition};
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let _enter = rt.enter();
        let fx = fixture();
        let st = &fx.st;
        let session = st.workspaces.create_auth_session(OWNER, 1).unwrap();
        let mut h = HeaderMap::new();
        h.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {session}")).unwrap(),
        );
        // internal hub (mfa.rs): a stranger may not enrol
        with_edition(Edition::Internal, || {
            let res = rt.block_on(api_totp_begin(State(st.clone()), HeaderMap::new()));
            assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
            // an admin's ordinary session may not: only an enrolment link's does
            let res = rt.block_on(api_totp_begin(State(st.clone()), h.clone()));
            assert_eq!(res.status(), StatusCode::FORBIDDEN);
            let link = st.workspaces.mint_enroll_link(OWNER, 600_000).unwrap();
            let (_, tool) = st.workspaces.open_enroll_link(&link).unwrap();
            let mut th = HeaderMap::new();
            th.insert(
                header::AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {tool}")).unwrap(),
            );
            let res = rt.block_on(api_totp_begin(State(st.clone()), th));
            assert_eq!(res.status(), StatusCode::OK);
        });
        with_edition(Edition::External, || {
            rt.block_on(async {
                // no session: refused
                let res = api_totp_begin(State(st.clone()), HeaderMap::new()).await;
                assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
                let res = api_totp_begin(State(st.clone()), h.clone()).await;
                assert_eq!(res.status(), StatusCode::OK);
                let begun = body_json(res).await;
                assert!(begun["qrSvg"].as_str().unwrap().contains("<svg"));
                assert!(begun["otpauthUri"]
                    .as_str()
                    .unwrap()
                    .starts_with("otpauth://totp/"));
                // a wrong code does not confirm
                let res = api_totp_confirm(
                    State(st.clone()),
                    h.clone(),
                    Bytes::from(json!({"code": "000000"}).to_string()),
                )
                .await;
                assert_eq!(res.status(), StatusCode::BAD_REQUEST);
                let secret = begun["secret"].as_str().unwrap();
                let code = code_for(secret, crate::totp::now_secs());
                let res = api_totp_confirm(
                    State(st.clone()),
                    h.clone(),
                    Bytes::from(json!({ "code": code }).to_string()),
                )
                .await;
                assert_eq!(res.status(), StatusCode::OK);
                assert_eq!(
                    body_json(res).await["recoveryCodes"]
                        .as_array()
                        .unwrap()
                        .len(),
                    10
                );
                // enrolled: a second begin cannot replace the authenticator
                let res = api_totp_begin(State(st.clone()), h.clone()).await;
                assert_eq!(res.status(), StatusCode::CONFLICT);
            });
        });
    }

    #[tokio::test]
    async fn the_owner_link_is_printed_until_password_and_authenticator_both_exist() {
        let fx = fixture();
        let store = &fx.st.workspaces;
        let count = || -> i64 {
            store.with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM local_setup_tokens", [], |r| r.get(0))
                    .unwrap()
            })
        };
        let hash = hash_password(PASSWORD).unwrap();
        // a password but no authenticator: still announced
        store.with_conn(|c| {
            c.execute(
                "INSERT INTO local_credentials VALUES(?1,'owner@acme.test',?2,1,1)",
                params![OWNER, hash],
            )
            .unwrap()
        });
        announce_owner_setup(store, OWNER, EMAIL, "http://x.test");
        assert_eq!(count(), 1);
        // both: silent
        store.with_conn(|c| {
            let secret = crate::user_totp::begin(c, OWNER).unwrap();
            let t = crate::totp::now_secs();
            crate::user_totp::confirm(c, OWNER, &code_for(&secret, t), t)
                .unwrap()
                .unwrap();
            c.execute("DELETE FROM local_setup_tokens", []).unwrap();
        });
        announce_owner_setup(store, OWNER, EMAIL, "http://x.test");
        assert_eq!(count(), 0);
    }
}
