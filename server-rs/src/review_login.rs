//! Store review sign-in: one email + password account for app-store reviewers.
//!
//! A Google Play reviewer cannot pass HegAI SSO (a platform account) or the
//! Telegram approval (a Telegram account), and the platform is not ours to
//! change. So the hub carries ONE extra way in, configured by ops and off by
//! default:
//!
//! - `CC_REMOTE_REVIEW_LOGIN=<email>:<sha256 hex>:<salt hex>`, where the hash
//!   is SHA-256 over the UTF-8 bytes of `<salt hex><password>`. Print a value
//!   with `cc-remote-server --review-login-hash <email> <password>`. Unset or
//!   malformed => `POST /api/auth/review-login` is 404.
//! - It only ever opens the synthetic account `review:<email>` — never an
//!   account someone signed into another way. If the address already belongs
//!   to a different account the login is refused (409), so a misconfigured
//!   value cannot hand out a real person's account.
//! - It does not open the product: the new account lands in `user_access`
//!   like any other (the waitlist by default) and ops activate it by hand.
//! - A salted SHA-256 is enough for a long random password that lives in one
//!   environment file; what it must never be is guessable online, and the
//!   per-address and global windows below keep it that way.

use rusqlite::{params, OptionalExtension};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::*;
use crate::provisioning_api::ct_eq;
use crate::rate_window::rate_ip;
use crate::workspace::{db_err, insert_audit, normalize_email};

/// `identities.provider` for this way in; the subject is the email.
const PROVIDER_REVIEW: &str = "review";
/// Attempts per address per ten minutes.
const PER_IP_LIMIT: usize = 10;
const PER_IP_WINDOW_MS: i64 = 10 * 60 * 1000;
/// Attempts from everyone together per hour: the address limit alone is no
/// limit against someone with many addresses.
const GLOBAL_LIMIT: usize = 30;
const GLOBAL_WINDOW_MS: i64 = 60 * 60 * 1000;
/// The shortest salt accepted, in hex characters (64 bits).
const SALT_MIN_HEX: usize = 16;

#[derive(Clone)]
pub(crate) struct ReviewLoginConfig {
    /// Normalized (trimmed, lower-case).
    pub email: String,
    /// Lower-case hex SHA-256 of `salt + password`.
    hash_hex: String,
    salt_hex: String,
}

impl ReviewLoginConfig {
    /// Both halves are always evaluated, so a right email with a wrong
    /// password costs the same as a wrong email.
    fn matches(&self, email: &str, password: &str) -> bool {
        let email_ok = ct_eq(normalize_email(email).as_bytes(), self.email.as_bytes());
        let hash_ok = ct_eq(
            hash_hex(&self.salt_hex, password).as_bytes(),
            self.hash_hex.as_bytes(),
        );
        email_ok & hash_ok
    }
}

fn is_hex(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit())
}

pub(crate) fn hash_hex(salt_hex: &str, password: &str) -> String {
    let mut h = Sha256::new();
    h.update(salt_hex.as_bytes());
    h.update(password.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// The env value for `email` + `password` with a fresh 128-bit salt.
pub(crate) fn env_value(email: &str, password: &str) -> String {
    let salt = Uuid::new_v4().simple().to_string();
    format!(
        "{}:{}:{salt}",
        normalize_email(email),
        hash_hex(&salt, password)
    )
}

/// `None` — the route is 404 — when unset or malformed. Split from the right:
/// the hash and the salt are hex, so only the email could ever hold a colon.
pub(crate) fn load_review_login_config(raw: Option<&str>) -> Option<ReviewLoginConfig> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }
    let mut parts = raw.rsplitn(3, ':');
    let (salt, hash, email) = (parts.next()?, parts.next(), parts.next());
    let (Some(hash), Some(email)) = (hash, email) else {
        eprintln!("[review-login] CC_REMOTE_REVIEW_LOGIN is not <email>:<sha256 hex>:<salt hex> — review sign-in stays off");
        return None;
    };
    let email = normalize_email(email);
    if !email.contains('@')
        || hash.len() != 64
        || !is_hex(hash)
        || salt.len() < SALT_MIN_HEX
        || !is_hex(salt)
    {
        eprintln!("[review-login] CC_REMOTE_REVIEW_LOGIN is malformed — review sign-in stays off");
        return None;
    }
    Some(ReviewLoginConfig {
        email,
        hash_hex: hash.to_ascii_lowercase(),
        salt_hex: salt.to_string(),
    })
}

#[derive(Debug)]
pub(crate) enum ReviewAccountError {
    /// The address belongs to an account that is not the review account.
    Collision,
    Db(String),
}

impl From<String> for ReviewAccountError {
    fn from(e: String) -> Self {
        ReviewAccountError::Db(e)
    }
}

impl WorkspaceStore {
    /// Find or make `review:<email>` — the same shape a Telegram-only account
    /// gets (personal workspace, owner membership, the default access state),
    /// with the address on it. `Ok((user_id, created))`.
    pub(crate) fn ensure_review_account(
        &self,
        email: &str,
    ) -> Result<(String, bool), ReviewAccountError> {
        let email = normalize_email(email);
        let user_id = format!("review:{email}");
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let holder: Option<String> = tx
            .query_row(
                "SELECT user_id FROM users WHERE lower(trim(email))=?1 AND user_id<>?2",
                params![email, user_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        if holder.is_some() {
            return Err(ReviewAccountError::Collision);
        }
        match crate::identity::resolve(&tx, PROVIDER_REVIEW, &email)? {
            Some(owner) if owner != user_id => return Err(ReviewAccountError::Collision),
            _ => {}
        }
        let created = tx
            .execute(
                // email stays NULL: the address lives only in the ('review', email)
                // identity, so it never receives invitations or blocks a real
                // person from signing in with it later (security review, 26.09).
                "INSERT OR IGNORE INTO users(user_id,email,full_name,created_at) VALUES(?1,NULL,'Google Play review',?2)",
                params![user_id, now],
            )
            .map_err(db_err)?
            > 0;
        let personal = format!("personal:{user_id}");
        tx.execute(
            "INSERT OR IGNORE INTO workspaces(workspace_id,name,kind,owner_user_id,created_at) VALUES(?1,'Моя работа','personal',?2,?3)",
            params![personal, user_id, now],
        )
        .map_err(db_err)?;
        tx.execute(
            "INSERT OR IGNORE INTO memberships(workspace_id,user_id,role,created_at) VALUES(?1,?2,'owner',?3)",
            params![personal, user_id, now],
        )
        .map_err(db_err)?;
        tx.execute(
            "INSERT OR IGNORE INTO user_access(user_id,state,plan,requested_at,updated_at) VALUES(?1,?2,'community',?3,?3)",
            params![user_id, crate::access::new_account_state(false), now],
        )
        .map_err(db_err)?;
        crate::identity::link(&tx, PROVIDER_REVIEW, &email, &user_id, now)?;
        tx.commit().map_err(db_err)?;
        Ok((user_id, created))
    }

    fn audit_review_login(&self, user_id: &str, ip: Option<&str>, created: bool) {
        let Ok(conn) = self.conn.lock() else { return };
        if let Ok(Some(ws)) = crate::access::audit_workspace_in(&conn, user_id) {
            let _ = insert_audit(
                &conn,
                &ws,
                user_id,
                "auth.review_login",
                "user",
                user_id,
                &json!({"ip": ip, "created": created}),
            );
        }
    }
}

/// `POST /api/auth/review-login` `{email, password}` -> `{session}`: a native
/// session (the same 90 days the Telegram and Android sign-ins mint), no
/// cookie.
pub(crate) async fn api_review_login(
    State(st): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(cfg) = st.review_login.clone() else {
        return api_error(
            StatusCode::NOT_FOUND,
            "review sign-in is not configured on this hub",
        );
    };
    let ip = client_ip(&headers);
    let rate = rate_ip(ip.as_deref());
    let ip_key = match check_window_quota(
        &st,
        &format!("review-login:{}", rate.as_deref().unwrap_or("?")),
        PER_IP_LIMIT,
        PER_IP_WINDOW_MS,
        "too many sign-in attempts, wait a few minutes",
    ) {
        Ok(key) => key,
        Err(r) => return r,
    };
    // The per-address window counts every attempt; the global window only
    // FAILURES, and is checked only for them: correct credentials must never be
    // locked out by strangers burning a shared budget (security review, 26.09).
    record_window_hit(&st, &ip_key, PER_IP_WINDOW_MS);
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let email = body.get("email").and_then(Value::as_str).unwrap_or("");
    let password = body.get("password").and_then(Value::as_str).unwrap_or("");
    if email.is_empty() || password.is_empty() || !cfg.matches(email, password) {
        match check_window_quota(
            &st,
            "review-login-all:all",
            GLOBAL_LIMIT,
            GLOBAL_WINDOW_MS,
            "too many sign-in attempts, wait a few minutes",
        ) {
            Ok(k) => record_window_hit(&st, &k, GLOBAL_WINDOW_MS),
            Err(r) => return r,
        }
        println!(
            "[review-login] refused attempt from {}",
            ip.as_deref().unwrap_or("?")
        );
        return api_error(StatusCode::UNAUTHORIZED, "invalid credentials");
    }
    let (user_id, created) = match st.workspaces.ensure_review_account(&cfg.email) {
        Ok(v) => v,
        Err(ReviewAccountError::Collision) => {
            eprintln!(
                "[review-login] {} belongs to another account — refusing to sign in as it",
                cfg.email
            );
            return api_error(
                StatusCode::CONFLICT,
                "this address belongs to another account",
            );
        }
        Err(ReviewAccountError::Db(e)) => return store_failure(e),
    };
    let session = match st
        .workspaces
        .create_auth_session(&user_id, crate::telegram_login::session_days("native"))
    {
        Ok(token) => token,
        Err(e) => return store_failure(e),
    };
    st.workspaces
        .audit_review_login(&user_id, ip.as_deref(), created);
    println!("[review-login] signed in {user_id} (created={created})");
    let mut response = Json(json!({"session": session})).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::Semaphore;

    const OWNER: &str = "owner";
    const EMAIL: &str = "demo-review@acme.test";
    const PASSWORD: &str = "correct horse battery staple 42";

    fn app_state(workspaces: WorkspaceStore, db: &std::path::Path, raw: Option<&str>) -> AppState {
        AppState {
            hub: spawn_hub(db, workspaces.clone(), OWNER.into(), Default::default()),
            // Not the dev token: `authenticated_user` must not fall back to
            // the owner, so an accepted session proves itself.
            token: "fleet-token-for-tests".into(),
            fleet_ui: false,
            native_sso_states: Default::default(),
            sso_jti: Default::default(),
            android_auth: Default::default(),
            stt_url: None,
            stt_token: None,
            azure_url: None,
            azure_key: None,
            azure_model: String::new(),
            transcribe_glossary: Arc::from(""),
            transcribe_prompt_on: false,
            transcribe_primary_azure: false,
            stt_health: Default::default(),
            transcribe_limit: Arc::new(Semaphore::new(1)),
            azure_http: reqwest::Client::new(),
            polisher: None,
            avatar_bot_token: None,
            llmgw: None,
            llm_public_url: String::new(),
            provisioner_token: None,
            provision_hosts: Default::default(),
            seat_inflight: Default::default(),
            llm_quota_file: None,
            access_link_secret: None,
            signin_link_secret: None,
            tg_login: None,
            review_login: load_review_login_config(raw),
            apple_auth: None,
            google_auth: None,
            github_auth: None,
            github_grant: None,
            oidc_auth: None,
            sandbox_erasure_only: false,
            workspaces,
            bootstrap_user_id: OWNER.into(),
            platform_admins: HashSet::from([OWNER.to_string()]),
            roadmap: crate::roadmap::RoadmapConfig::default(),
            sso_authorize_url: String::new(),
            sso_secret: None,
            public_url: "http://127.0.0.1:4319".into(),
            ui_origins: Arc::new(Vec::new()),
            public_alt_ports: vec![],
            lite_hosts: Arc::new(vec![]),
            backend_requests: None,
            backend_request_log: Default::default(),
            fleet_api_keys: None,
            service_keys: None,
            browser: None,
            window_log: Default::default(),
        }
    }

    struct Fixture {
        st: AppState,
        db: std::path::PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", self.db.display()));
            }
        }
    }

    fn fixture(raw: Option<&str>) -> Fixture {
        let db = std::env::temp_dir().join(format!("cc-remote-review-{}.sqlite3", Uuid::new_v4()));
        let workspaces = WorkspaceStore::open(&db).unwrap();
        Fixture {
            st: app_state(workspaces, &db, raw),
            db,
        }
    }

    async fn call(st: &AppState, ip: &str, body: Value) -> (StatusCode, Value) {
        let mut headers = HeaderMap::new();
        headers.insert("x-real-ip", HeaderValue::from_str(ip).unwrap());
        let res = api_review_login(State(st.clone()), headers, Bytes::from(body.to_string())).await;
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 16)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    fn configured() -> String {
        env_value(EMAIL, PASSWORD)
    }

    #[test]
    fn the_env_value_round_trips_and_malformed_ones_are_off() {
        let raw = env_value(" Demo-review@Acme.test ", PASSWORD);
        let cfg = load_review_login_config(Some(&raw)).unwrap();
        assert_eq!(cfg.email, EMAIL);
        assert!(cfg.matches("Demo-review@acme.test", PASSWORD));
        assert!(!cfg.matches(EMAIL, "wrong"));
        assert!(!cfg.matches("other@acme.test", PASSWORD));
        assert!(load_review_login_config(None).is_none());
        assert!(load_review_login_config(Some("")).is_none());
        assert!(load_review_login_config(Some("a@b:zz:0011223344556677")).is_none());
        let short_salt = format!("{EMAIL}:{}:abcd", hash_hex("abcd", PASSWORD));
        assert!(load_review_login_config(Some(&short_salt)).is_none());
        assert!(load_review_login_config(Some("no-at-sign:x:y")).is_none());
        // What `printf '%s%s' "$salt" "$pw" | shasum -a 256` gives by hand.
        let salt = "00112233445566778899aabbccddeeff";
        let by_hand = format!("{EMAIL}:{}:{salt}", hash_hex(salt, PASSWORD));
        assert!(load_review_login_config(Some(&by_hand))
            .unwrap()
            .matches(EMAIL, PASSWORD));
    }

    #[tokio::test]
    async fn disabled_is_404() {
        let f = fixture(None);
        let (status, _) = call(
            &f.st,
            "203.0.113.1",
            json!({"email": EMAIL, "password": PASSWORD}),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn a_wrong_password_is_401_and_creates_nothing() {
        let f = fixture(Some(&configured()));
        let (status, body) = call(
            &f.st,
            "203.0.113.1",
            json!({"email": EMAIL, "password": "nope"}),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "invalid credentials");
        let (status, _) = call(
            &f.st,
            "203.0.113.1",
            json!({"email": "x@y.z", "password": PASSWORD}),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _) = call(&f.st, "203.0.113.1", json!({})).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let users: i64 =
            f.st.workspaces
                .conn
                .lock()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM users WHERE user_id LIKE 'review:%'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
        assert_eq!(users, 0);
    }

    #[tokio::test]
    async fn the_right_password_mints_a_native_session_for_the_review_account_only() {
        let f = fixture(Some(&configured()));
        let (status, body) = call(
            &f.st,
            "203.0.113.1",
            json!({"email": EMAIL, "password": PASSWORD}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let session = body["session"].as_str().unwrap().to_string();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {session}")).unwrap(),
        );
        let user = authenticated_user(&headers, &f.st).map_err(|_| ()).unwrap();
        assert_eq!(user, format!("review:{EMAIL}"));
        // Not opened by this path: the access gate still says waitlist.
        assert!(require_active(&f.st, &user).is_err());
        {
            let conn = f.st.workspaces.conn.lock().unwrap();
            let expiry: i64 = conn
                .query_row(
                    "SELECT expires_at-created_at FROM auth_sessions WHERE user_id=?1",
                    params![user],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(expiry, 90 * 24 * 60 * 60 * 1000);
            let audits: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM audit_events WHERE action='auth.review_login' AND actor_user_id=?1 AND metadata_json NOT LIKE '%password%'",
                params![user],
                |r| r.get(0),
            )
            .unwrap();
            assert_eq!(audits, 1);
            let personal: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memberships WHERE workspace_id=?1 AND user_id=?2 AND role='owner'",
                params![format!("personal:{user}"), user],
                |r| r.get(0),
            )
            .unwrap();
            assert_eq!(personal, 1);
        }
        // The second sign-in opens the same account.
        let (status, _) = call(
            &f.st,
            "203.0.113.1",
            json!({"email": EMAIL, "password": PASSWORD}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            f.st.workspaces
                .ensure_review_account(EMAIL)
                .map_err(|_| ())
                .unwrap(),
            (user, false)
        );
    }

    #[tokio::test]
    async fn an_address_held_by_a_real_account_is_409() {
        let f = fixture(Some(&configured()));
        f.st.workspaces
            .ensure_user("real-uuid", EMAIL, Some("Real Person"))
            .unwrap();
        let (status, _) = call(
            &f.st,
            "203.0.113.1",
            json!({"email": EMAIL, "password": PASSWORD}),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        let sessions: i64 =
            f.st.workspaces
                .conn
                .lock()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM auth_sessions", [], |r| r.get(0))
                .unwrap();
        assert_eq!(sessions, 0);
    }

    #[tokio::test]
    async fn attempts_are_limited_per_address_and_globally() {
        let f = fixture(Some(&configured()));
        let wrong = json!({"email": EMAIL, "password": "nope"});
        for _ in 0..PER_IP_LIMIT {
            assert_eq!(
                call(&f.st, "203.0.113.1", wrong.clone()).await.0,
                StatusCode::UNAUTHORIZED
            );
        }
        // Locked out even with the right password.
        let right = json!({"email": EMAIL, "password": PASSWORD});
        assert_eq!(
            call(&f.st, "203.0.113.1", right.clone()).await.0,
            StatusCode::TOO_MANY_REQUESTS
        );
        // Another address still gets in — until the global budget is spent.
        assert_eq!(
            call(&f.st, "198.51.100.1", right.clone()).await.0,
            StatusCode::OK
        );
        // The global budget counts only failures...
        for i in 0..(GLOBAL_LIMIT - PER_IP_LIMIT) {
            let ip = format!("198.51.100.{}", 10 + i);
            assert_eq!(
                call(&f.st, &ip, wrong.clone()).await.0,
                StatusCode::UNAUTHORIZED
            );
        }
        assert_eq!(
            call(&f.st, "192.0.2.76", wrong).await.0,
            StatusCode::TOO_MANY_REQUESTS
        );
        // ...so strangers spending it cannot lock the reviewer out.
        assert_eq!(call(&f.st, "192.0.2.77", right).await.0, StatusCode::OK);
    }
}
