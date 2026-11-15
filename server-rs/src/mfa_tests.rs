//! The second factor at sign-in (mfa.rs): pending sessions fail closed at the
//! one choke point, `/verify` flips only its own session, the native hand-off
//! waits for it, and the flag off changes nothing.

use super::*;
use crate::account::tests::{app_state, cleanup, temp_db};
use crate::mfa::Factor;

const ADMIN: &str = "owner";
const USER: &str = "member";

struct Fx {
    st: AppState,
    db: std::path::PathBuf,
}
impl Drop for Fx {
    fn drop(&mut self) {
        cleanup(&self.db);
    }
}

fn fixture(admin_mfa: bool) -> Fx {
    let db = temp_db();
    let ws = WorkspaceStore::open(&db).unwrap();
    ws.ensure_user(ADMIN, "owner@acme.test", None).unwrap();
    ws.ensure_user(USER, "member@acme.test", None).unwrap();
    ws.set_always_active([ADMIN.to_string(), USER.to_string()]);
    ws.set_admin_mfa([ADMIN.to_string()], admin_mfa);
    Fx {
        st: app_state(ws, &db),
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

/// Enrol `user` as a confirmed authenticator holder; the confirming step is in
/// the past so a code for NOW is not a replay. Returns the secret.
fn enrol(ws: &WorkspaceStore, user: &str) -> String {
    ws.with_conn_mfa(|c| {
        let secret = crate::user_totp::begin(c, user).unwrap();
        let t = crate::totp::now_secs() - 90;
        crate::user_totp::confirm(c, user, &code_for(&secret, t), t)
            .unwrap()
            .expect("confirmed");
        secret
    })
}

fn cookie(token: &str) -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert(
        header::COOKIE,
        HeaderValue::from_str(&format!("{AUTH_COOKIE}={token}")).unwrap(),
    );
    h
}

fn peer() -> std::net::SocketAddr {
    "127.0.0.1:9".parse().unwrap()
}

async fn body_of(res: Response) -> (StatusCode, Value) {
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn verify(st: &AppState, token: &str, code: &str) -> (StatusCode, Value) {
    body_of(
        crate::mfa::api_mfa_verify(
            State(st.clone()),
            axum::extract::ConnectInfo(peer()),
            cookie(token),
            Bytes::from(json!({ "code": code }).to_string()),
        )
        .await,
    )
    .await
}

fn pending_of(ws: &WorkspaceStore, token: &str) -> bool {
    ws.authenticate_pending(token).unwrap().unwrap().pending
}

#[tokio::test]
async fn rows_that_existed_before_are_grandfathered() {
    // A hub from before this change: no mfa columns on the table.
    let c = rusqlite::Connection::open_in_memory().unwrap();
    c.execute_batch(
        "CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
         INSERT INTO auth_sessions VALUES('old','u',9999999999999,1);",
    )
    .unwrap();
    crate::mfa::migrate_session_columns(&c).unwrap();
    crate::mfa::migrate_session_columns(&c).unwrap(); // idempotent
    let (pending, next, fixed): (i64, Option<String>, i64) = c
        .query_row(
            "SELECT mfa_pending,mfa_next,fixed_expiry FROM auth_sessions",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!((pending, next, fixed), (0, None, 0));

    // And through the store: an enrolled person's EXISTING session still opens.
    let fx = fixture(true);
    let ws = &fx.st.workspaces;
    let old = ws
        .create_auth_session_as(ADMIN, 7, Factor::Proven)
        .unwrap()
        .0;
    enrol(ws, ADMIN);
    assert!(ws.authenticate(&old).unwrap().is_some());
}

#[tokio::test]
async fn who_owes_a_second_factor() {
    let fx = fixture(true);
    let ws = &fx.st.workspaces;
    // Flag on: the admin owes it even with no authenticator; a member does not.
    assert!(ws.mfa_required(ADMIN));
    assert!(!ws.mfa_required(USER));
    // A confirmed authenticator makes anyone owe it.
    enrol(ws, USER);
    assert!(ws.mfa_required(USER));
    // An unconfirmed enrolment does not.
    let other = fixture(false);
    other
        .st
        .workspaces
        .with_conn_mfa(|c| crate::user_totp::begin(c, USER).unwrap());
    assert!(!other.st.workspaces.mfa_required(USER));
    // Flag off: the admin is not asked (old behaviour) …
    assert!(!other.st.workspaces.mfa_required(ADMIN));
    let s = other.st.workspaces.create_auth_session(ADMIN, 7).unwrap();
    assert!(other.st.workspaces.authenticate(&s).unwrap().is_some());
    // … but an admin with an authenticator is, flag or not.
    enrol(&other.st.workspaces, ADMIN);
    assert!(other.st.workspaces.mfa_required(ADMIN));
}

#[tokio::test]
async fn the_external_edition_is_not_asked() {
    let fx = fixture(true);
    enrol(&fx.st.workspaces, USER);
    crate::edition::with_edition(crate::edition::Edition::External, || {
        assert!(!fx.st.workspaces.mfa_required(USER));
        assert!(!fx.st.workspaces.mfa_required(ADMIN));
        let s = fx.st.workspaces.create_auth_session(USER, 7).unwrap();
        assert!(fx.st.workspaces.authenticate(&s).unwrap().is_some());
    });
}

#[tokio::test]
async fn a_pending_session_opens_nothing() {
    let fx = fixture(true);
    let st = &fx.st;
    enrol(&st.workspaces, USER);
    let token = st.workspaces.create_auth_session(USER, 7).unwrap();
    assert!(pending_of(&st.workspaces, &token));
    // The choke point.
    assert!(st.workspaces.authenticate(&token).unwrap().is_none());
    // HTTP, cookie and bearer.
    assert!(authenticated_user(&cookie(&token), st).is_err());
    let mut bearer = HeaderMap::new();
    bearer.insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
    );
    assert!(authenticated_user(&bearer, st).is_err());
    assert!(mutation_user(&cookie(&token), st).is_err());
    // /ui and /mobile/ui (header, cookie and the native `?token=`).
    let mut params = HashMap::new();
    assert!(ui_user(&params, &cookie(&token), st).is_err());
    params.insert("token".to_string(), token.clone());
    assert!(ui_user(&params, &HeaderMap::new(), st).is_err());
    // A representative set of handlers.
    for res in [
        api_me(State(st.clone()), cookie(&token)).await,
        api_sessions(State(st.clone()), cookie(&token)).await,
        api_devices(State(st.clone()), cookie(&token)).await,
        api_revoke_device(AxumPath("m".into()), State(st.clone()), cookie(&token)).await,
    ] {
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }
    // The cookie is not re-stamped, and the session is no "presented" one.
    assert!(presented_session(&params, &cookie(&token), st).is_none());
    // The state endpoint, though, sees it.
    let (s, body) =
        body_of(crate::mfa::api_mfa_state(State(st.clone()), cookie(&token)).await).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body["mfa"], "verify");
    // A stranger's token gets nothing, not even the state.
    let (s, _) = body_of(crate::mfa::api_mfa_state(State(st.clone()), cookie("nope")).await).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn verify_flips_only_this_session() {
    let fx = fixture(true);
    let st = &fx.st;
    let secret = enrol(&st.workspaces, USER);
    let a = st.workspaces.create_auth_session(USER, 7).unwrap();
    let b = st.workspaces.create_auth_session(USER, 7).unwrap();
    // A wrong code changes nothing.
    let (s, _) = verify(st, &a, "000000").await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(pending_of(&st.workspaces, &a));
    let (s, body) = verify(st, &a, &code_for(&secret, crate::totp::now_secs())).await;
    assert_eq!(s, StatusCode::OK, "{body}");
    assert_eq!(body["ok"], true);
    assert!(body.get("next").is_none());
    assert!(st.workspaces.authenticate(&a).unwrap().is_some());
    assert!(
        st.workspaces.authenticate(&b).unwrap().is_none(),
        "the other session of the same person stays pending"
    );
    // A satisfied session asked again: fine, nothing changes.
    let (s, _) = verify(st, &a, "000000").await;
    assert_eq!(s, StatusCode::OK);
    // The audit trail has both outcomes and no code.
    let audit: Vec<(String, String)> = st.workspaces.with_conn_mfa(|c| {
        let mut q = c
            .prepare("SELECT action,metadata_json FROM audit_events WHERE action LIKE 'auth.mfa.%' ORDER BY created_at")
            .unwrap();
        q.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .flatten()
            .collect()
    });
    let actions: Vec<&str> = audit.iter().map(|(a, _)| a.as_str()).collect();
    assert_eq!(actions, ["auth.mfa.failed", "auth.mfa.verified"]);
    assert!(audit.iter().all(|(_, m)| !m.contains("000000")));
}

#[tokio::test]
async fn verify_is_rate_limited_per_account_even_for_the_right_code() {
    let fx = fixture(true);
    let st = &fx.st;
    let secret = enrol(&st.workspaces, USER);
    let t = st.workspaces.create_auth_session(USER, 7).unwrap();
    for _ in 0..5 {
        let (s, _) = verify(st, &t, "000000").await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
        // keep the account-wide slowdown out of this assertion
        st.workspaces.with_conn_mfa(|c| {
            c.execute(
                "UPDATE mfa_attempts SET at=at-60000 WHERE key LIKE 'd:%'",
                [],
            )
            .unwrap()
        });
    }
    let (s, _) = verify(st, &t, &code_for(&secret, crate::totp::now_secs())).await;
    assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);
    assert!(pending_of(&st.workspaces, &t));
}

#[tokio::test]
async fn verify_is_rate_limited_per_address() {
    let fx = fixture(true);
    let st = &fx.st;
    // Many different accounts from one address: the 11th is refused.
    st.workspaces.set_always_active(
        (0..11)
            .map(|i| format!("u{i}"))
            .chain([ADMIN.to_string(), USER.to_string()]),
    );
    let mut last = StatusCode::OK;
    for i in 0..11 {
        let id = format!("u{i}");
        st.workspaces
            .ensure_user(&id, &format!("{id}@acme.test"), None)
            .unwrap();
        enrol(&st.workspaces, &id);
        let t = st.workspaces.create_auth_session(&id, 7).unwrap();
        last = verify(st, &t, "000000").await.0;
    }
    assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn a_pending_unenrolled_admin_is_blocked_and_enrols_only_from_a_satisfied_session() {
    let fx = fixture(true);
    let st = &fx.st;
    // A session from before the flag (satisfied), minted fresh.
    let link = st.workspaces.mint_enroll_link(ADMIN, 600_000).unwrap();
    let (_, ok) = st.workspaces.open_enroll_link(&link).unwrap();
    let t = st.workspaces.create_auth_session(ADMIN, 7).unwrap();
    assert!(pending_of(&st.workspaces, &t));
    let (_, state) = body_of(crate::mfa::api_mfa_state(State(st.clone()), cookie(&t)).await).await;
    assert_eq!(state["mfa"], "blocked");
    // Nothing opens, and enrolment is refused on the pending session.
    assert!(authenticated_user(&cookie(&t), st).is_err());
    assert!(ui_user(&HashMap::new(), &cookie(&t), st).is_err());
    let res = local_login::api_totp_begin(State(st.clone()), cookie(&t)).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    let res = local_login::api_totp_confirm(
        State(st.clone()),
        cookie(&t),
        Bytes::from(json!({ "code": "123456" }).to_string()),
    )
    .await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    let (s, _) = verify(st, &t, "123456").await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(st.workspaces.authenticate(&t).unwrap().is_none());
    // The satisfied session enrols.
    let begun = body_of(local_login::api_totp_begin(State(st.clone()), cookie(&ok)).await).await;
    assert_eq!(begun.0, StatusCode::OK, "{}", begun.1);
    let secret = begun.1["secret"].as_str().unwrap().to_string();
    let (s, done) = body_of(
        local_login::api_totp_confirm(
            State(st.clone()),
            cookie(&ok),
            Bytes::from(json!({ "code": code_for(&secret, crate::totp::now_secs()) }).to_string()),
        )
        .await,
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{done}");
    assert_eq!(done["recoveryCodes"].as_array().unwrap().len(), 10);
    // A later sign-in now owes a code.
    let t2 = st.workspaces.create_auth_session(ADMIN, 7).unwrap();
    let (_, state) = body_of(crate::mfa::api_mfa_state(State(st.clone()), cookie(&t2)).await).await;
    assert_eq!(state["mfa"], "verify");
}

#[tokio::test]
async fn a_satisfied_session_enrols_only_while_fresh() {
    let fx = fixture(false);
    let st = &fx.st;
    let t = st.workspaces.create_auth_session(USER, 7).unwrap();
    let res = local_login::api_totp_begin(State(st.clone()), cookie(&t)).await;
    assert_eq!(res.status(), StatusCode::OK);
    st.workspaces.with_conn_mfa(|c| {
        c.execute(
            "UPDATE auth_sessions SET created_at = created_at - ?1",
            [11 * 60 * 1000],
        )
        .unwrap()
    });
    let res = local_login::api_totp_begin(State(st.clone()), cookie(&t)).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    // Anonymous: nothing.
    let res = local_login::api_totp_begin(State(st.clone()), HeaderMap::new()).await;
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn disable_needs_a_code_and_is_refused_for_a_required_admin() {
    let fx = fixture(true);
    let st = &fx.st;
    let disable = |t: &str, code: String| {
        crate::mfa::api_totp_disable(
            State(st.clone()),
            axum::extract::ConnectInfo(peer()),
            cookie(t),
            Bytes::from(json!({ "code": code }).to_string()),
        )
    };
    // The admin (flag on) cannot turn it off, right code or not.
    let secret = enrol(&st.workspaces, ADMIN);
    let a = st
        .workspaces
        .create_auth_session_as(ADMIN, 7, Factor::Proven)
        .unwrap()
        .0;
    let res = disable(&a, code_for(&secret, crate::totp::now_secs())).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert!(st.workspaces.mfa_required(ADMIN));
    // A member can, with a current code only.
    let secret = enrol(&st.workspaces, USER);
    let m = st
        .workspaces
        .create_auth_session_as(USER, 7, Factor::Proven)
        .unwrap()
        .0;
    assert_eq!(
        disable(&m, "000000".into()).await.status(),
        StatusCode::BAD_REQUEST
    );
    assert!(st.workspaces.mfa_required(USER));
    let res = disable(&m, code_for(&secret, crate::totp::now_secs())).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert!(!st.workspaces.mfa_required(USER));
    // Flag off: an admin may.
    let off = fixture(false);
    let secret = enrol(&off.st.workspaces, ADMIN);
    let a = off
        .st
        .workspaces
        .create_auth_session_as(ADMIN, 7, Factor::Proven)
        .unwrap()
        .0;
    let res = crate::mfa::api_totp_disable(
        State(off.st.clone()),
        axum::extract::ConnectInfo(peer()),
        cookie(&a),
        Bytes::from(json!({ "code": code_for(&secret, crate::totp::now_secs()) }).to_string()),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn recovery_codes_regenerate_against_a_code() {
    let fx = fixture(false);
    let st = &fx.st;
    let secret = enrol(&st.workspaces, USER);
    let m = st
        .workspaces
        .create_auth_session_as(USER, 7, Factor::Proven)
        .unwrap()
        .0;
    let res = crate::mfa::api_totp_recovery(
        State(st.clone()),
        axum::extract::ConnectInfo(peer()),
        cookie(&m),
        Bytes::from(json!({ "code": code_for(&secret, crate::totp::now_secs()) }).to_string()),
    )
    .await;
    let (s, body) = body_of(res).await;
    assert_eq!(s, StatusCode::OK, "{body}");
    assert_eq!(body["recoveryCodes"].as_array().unwrap().len(), 10);
}

fn pkce() -> (String, String, String) {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let verifier = "v".repeat(43);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge, "s".repeat(40))
}

fn location(res: &Response) -> String {
    res.headers()
        .get(header::LOCATION)
        .map(|v| v.to_str().unwrap().to_string())
        .unwrap_or_default()
}

fn set_cookie_token(res: &Response) -> String {
    // The fixture hub is plain http, where the session cookie has no prefix.
    let raw = res
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find(|v| v.starts_with(BARE_AUTH_COOKIE) && !v.contains("Max-Age=0"))
        .expect("auth cookie")
        .to_string();
    raw[BARE_AUTH_COOKIE.len() + 1..]
        .split(';')
        .next()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn the_ios_hand_off_waits_for_the_second_factor() {
    let fx = fixture(true);
    let st = &fx.st;
    let secret = enrol(&st.workspaces, USER);
    let res = finish_login(
        st,
        "state",
        true,
        None,
        USER,
        None,
        &HeaderMap::new(),
        Factor::Unproven,
    );
    // No ccremote:// yet: the cookie opens the code screen and nothing else.
    assert_eq!(location(&res), "/");
    let token = set_cookie_token(&res);
    assert!(pending_of(&st.workspaces, &token));
    assert!(st.workspaces.authenticate(&token).unwrap().is_none());
    // The hand-off URL was built by the hub and is released with the verify.
    let (s, body) = verify(st, &token, &code_for(&secret, crate::totp::now_secs())).await;
    assert_eq!(s, StatusCode::OK, "{body}");
    // The app gets a session of its own, never the browser cookie's token; the
    // browser session is gone.
    let next = body["next"].as_str().unwrap();
    let app = next
        .strip_prefix("ccremote://auth?session=")
        .expect("app url");
    assert_ne!(app, token);
    assert!(st.workspaces.authenticate(app).unwrap().is_some());
    // A lost response is recoverable: the same browser session asks again
    // inside the retry window (no new code) and gets a fresh app session; the
    // browser session itself is short-lived from here on.
    let (s2, again) = verify(st, &token, "").await;
    assert_eq!(s2, StatusCode::OK, "{again}");
    let app2 = again["next"]
        .as_str()
        .unwrap()
        .strip_prefix("ccremote://auth?session=")
        .unwrap()
        .to_string();
    assert_ne!(app2, app);
    assert!(st.workspaces.authenticate(&app2).unwrap().is_some());
    let left: i64 = st.workspaces.with_conn_mfa(|c| {
        c.query_row(
            "SELECT expires_at FROM auth_sessions WHERE token_hash=?1",
            [crate::workspace::hash_token(&token)],
            |r| r.get(0),
        )
        .unwrap()
    });
    assert!(left - crate::workspace::now_ms() <= crate::mfa::HAND_OFF_RETRY_MS);
    // past the window the retry yields nothing
    st.workspaces.with_conn_mfa(|c| {
        c.execute(
            "UPDATE auth_sessions SET mfa_pending_at=mfa_pending_at-200000 WHERE token_hash=?1",
            [crate::workspace::hash_token(&token)],
        )
        .unwrap()
    });
    let (_, late) = verify(st, &token, "").await;
    assert!(late.get("next").is_none());
    // A login that already checked a factor itself goes straight to the app.
    let proven = finish_login(
        st,
        "state",
        true,
        None,
        USER,
        None,
        &HeaderMap::new(),
        Factor::Proven,
    );
    assert!(location(&proven).starts_with("ccremote://auth?session="));
}

#[tokio::test]
async fn the_android_code_is_not_released_until_the_second_factor_is() {
    let fx = fixture(true);
    let st = &fx.st;
    let secret = enrol(&st.workspaces, USER);
    let (verifier, challenge, client_state) = pkce();
    st.android_auth
        .begin("st1".into(), &challenge, &client_state, "src")
        .unwrap();
    let handshake = st.android_auth.take("st1").unwrap();
    let res = finish_login(
        st,
        "st1",
        false,
        Some(handshake),
        USER,
        None,
        &HeaderMap::new(),
        Factor::Unproven,
    );
    // Held back: a plain redirect to the SPA, no hegai-code:// yet.
    assert_eq!(location(&res), "/");
    let token = set_cookie_token(&res);
    let held: String = st
        .workspaces
        .with_conn_mfa(|c| c.query_row("SELECT mfa_next FROM auth_sessions", [], |r| r.get(0)))
        .unwrap();
    assert!(held.starts_with("hegai-code://auth?code="));
    let code = held
        .split("code=")
        .nth(1)
        .unwrap()
        .split('&')
        .next()
        .unwrap()
        .to_string();
    let exchange = |code: String, v: String| {
        android_exchange(
            State(st.clone()),
            Json(AndroidExchange {
                code,
                code_verifier: v,
            }),
        )
    };
    // The browser has not verified: the code exchanges for nothing …
    let (s, _) = body_of(exchange(code.clone(), verifier.clone()).await).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    // … and is not burned by the attempt.
    let (s, _) = verify(st, &token, &code_for(&secret, crate::totp::now_secs())).await;
    assert_eq!(s, StatusCode::OK);
    let (s, body) = body_of(exchange(code, verifier).await).await;
    assert_eq!(s, StatusCode::OK, "{body}");
    let issued = body["session"].as_str().unwrap();
    assert!(st.workspaces.authenticate(issued).unwrap().is_some());
}

#[tokio::test]
async fn an_ungated_android_code_for_a_person_who_enrolled_since_is_refused() {
    let fx = fixture(true);
    let st = &fx.st;
    let (verifier, challenge, client_state) = pkce();
    st.android_auth
        .begin("st2".into(), &challenge, &client_state, "src")
        .unwrap();
    let handshake = st.android_auth.take("st2").unwrap();
    // Issued while USER owed nothing …
    let code = st.android_auth.issue_bound(handshake, USER, None).unwrap();
    // … then they enrol before the app exchanges it.
    enrol(&st.workspaces, USER);
    let res = android_exchange(
        State(st.clone()),
        Json(AndroidExchange {
            code,
            code_verifier: verifier,
        }),
    )
    .await;
    let (s, body) = body_of(res).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "mfa_browser_required");
    let sessions: i64 = st
        .workspaces
        .with_conn_mfa(|c| c.query_row("SELECT COUNT(*) FROM auth_sessions", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(sessions, 0, "no pending token was left behind");
}

#[tokio::test]
async fn paths_without_a_browser_share_one_refusal_in_words() {
    let fx = fixture(true);
    let st = &fx.st;
    enrol(&st.workspaces, USER);
    // The web path gets a pending session through the store …
    let (t, pending) = st
        .workspaces
        .create_auth_session_as(USER, 7, Factor::Unproven)
        .unwrap();
    assert!(pending && st.workspaces.authenticate(&t).unwrap().is_none());
    // … and the refusal both native paths share says why.
    let (s, body) = body_of(crate::mfa_browser_required()).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "mfa_browser_required");
    assert!(body["message"].as_str().unwrap().contains("через браузер"));
}

#[tokio::test]
async fn a_sign_in_link_for_an_enrolled_member_is_pending() {
    let fx = fixture(true);
    let ws = &fx.st.workspaces;
    enrol(ws, USER);
    let t = ws.consume_signin_link("jti-a", USER, "ops", 12).unwrap();
    assert!(ws.authenticate(&t).unwrap().is_none());
    let plain = ws.consume_signin_link("jti-b", "nobody-enrolled", "ops", 12);
    assert!(plain.is_err(), "unknown account: refused as before");
}

#[tokio::test]
async fn a_service_ui_pass_is_pending_only_for_an_admin_held_to_the_factor() {
    let fx = fixture(true);
    let ws = &fx.st.workspaces;
    let wid = ws.audit_workspace_for(USER).unwrap();
    let (pass, _) = ws.mint_service_ui_pass("legal", USER, &wid).unwrap();
    assert!(ws.authenticate_ui_pass(&pass).unwrap().is_some());
    // The admin's pass (flag on) is pending: never accepted.
    ws.with_conn_mfa(|c| {
        c.execute(
            "INSERT OR IGNORE INTO memberships(workspace_id,user_id,role,created_at) VALUES(?1,?2,'member',1)",
            rusqlite::params![wid, ADMIN],
        )
        .unwrap()
    });
    let (pass, _) = ws.mint_service_ui_pass("legal", ADMIN, &wid).unwrap();
    assert!(ws.authenticate_ui_pass(&pass).unwrap().is_none());
}

#[tokio::test]
async fn a_tool_session_is_satisfied_fixed_and_audited() {
    let fx = fixture(true);
    let ws = &fx.st.workspaces;
    enrol(ws, ADMIN);
    let t = ws
        .mint_tool_session(ADMIN, 2 * 3600 * 1000, "term-sh")
        .unwrap();
    let (user, expires) = ws.authenticate(&t).unwrap().expect("satisfied");
    assert_eq!(user, ADMIN);
    // It never slides: used again, the end is where it was.
    ws.with_conn_mfa(|c| {
        c.execute(
            "UPDATE auth_sessions SET expires_at = expires_at - 3600000 WHERE token_hash = ?1",
            [crate::workspace::hash_token(&t)],
        )
        .unwrap()
    });
    let (_, later) = ws.authenticate(&t).unwrap().unwrap();
    assert_eq!(later, expires - 3_600_000);
    let actions: i64 = ws.with_conn_mfa(|c| {
        c.query_row(
            "SELECT COUNT(*) FROM audit_events WHERE action='auth.tool_session' AND actor_user_id=?1",
            [ADMIN],
            |r| r.get(0),
        )
        .unwrap()
    });
    assert_eq!(actions, 1);
    assert!(ws.mint_tool_session("ghost", 1000, "x").is_err());
}

#[tokio::test]
async fn mfa_reset_removes_the_authenticator_and_says_so_in_the_audit() {
    let fx = fixture(true);
    let ws = &fx.st.workspaces;
    enrol(ws, USER);
    assert!(ws.mfa_required(USER));
    assert!(ws.mfa_reset(USER).unwrap());
    assert!(!ws.mfa_required(USER));
    assert!(!ws.mfa_reset(USER).unwrap());
    let n: i64 = ws.with_conn_mfa(|c| {
        c.query_row(
            "SELECT COUNT(*) FROM audit_events WHERE action='auth.mfa.reset'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    });
    assert_eq!(n, 2);
}

#[tokio::test]
async fn logout_and_a_reset_tell_the_hub_to_close_the_sockets() {
    let fx = fixture(false);
    let st = &fx.st;
    let t = st.workspaces.create_auth_session(USER, 7).unwrap();
    let res = api_logout(State(st.clone()), cookie(&t)).await;
    assert_eq!(res.status(), StatusCode::NO_CONTENT);
    assert!(st.workspaces.authenticate(&t).unwrap().is_none());
    // The hub command channel has no observable here beyond not failing; the
    // sockets themselves are covered by session_alive's own tests.
}

#[tokio::test]
async fn enrolment_demotes_the_other_sessions_but_not_tool_sessions() {
    let fx = fixture(false);
    let st = &fx.st;
    let ws = &st.workspaces;
    let a = ws.create_auth_session(USER, 7).unwrap();
    let b = ws.create_auth_session(USER, 7).unwrap();
    let tool = ws.mint_tool_session(USER, 600_000, "enrol").unwrap();
    let begun = body_of(local_login::api_totp_begin(State(st.clone()), cookie(&a)).await).await;
    let secret = begun.1["secret"].as_str().unwrap().to_string();
    let res = local_login::api_totp_confirm(
        State(st.clone()),
        cookie(&a),
        Bytes::from(json!({ "code": code_for(&secret, crate::totp::now_secs()) }).to_string()),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    assert!(ws.authenticate(&a).unwrap().is_some());
    assert!(
        ws.authenticate(&b).unwrap().is_none(),
        "other session now owes the code"
    );
    assert!(ws.authenticate(&tool).unwrap().is_some());
    // an open socket of the demoted session is dead
    assert!(!ws.session_alive(&crate::workspace::hash_token(&b)).unwrap());
    assert!(ws.session_alive(&crate::workspace::hash_token(&a)).unwrap());
}

#[tokio::test]
async fn admin_sessions_older_than_their_authenticator_are_demoted_at_start() {
    let fx = fixture(true);
    let ws = &fx.st.workspaces;
    let old = ws
        .create_auth_session_as(ADMIN, 7, Factor::Proven)
        .unwrap()
        .0;
    let tool = ws.mint_tool_session(ADMIN, 600_000, "term-sh").unwrap();
    ws.with_conn_mfa(|c| {
        c.execute("UPDATE auth_sessions SET created_at=created_at-5000", [])
            .unwrap()
    });
    enrol(ws, ADMIN);
    let fresh = ws
        .create_auth_session_as(ADMIN, 7, Factor::Proven)
        .unwrap()
        .0;
    assert_eq!(ws.demote_stale_admin_sessions(), 1);
    assert!(ws.authenticate(&old).unwrap().is_none());
    assert!(ws.authenticate(&tool).unwrap().is_some());
    assert!(ws.authenticate(&fresh).unwrap().is_some());
    assert_eq!(ws.demote_stale_admin_sessions(), 0);
}

#[tokio::test]
async fn a_pending_session_dies_after_ten_minutes() {
    let fx = fixture(true);
    let ws = &fx.st.workspaces;
    enrol(ws, USER);
    let t = ws.create_auth_session(USER, 7).unwrap();
    assert!(ws.authenticate_pending(&t).unwrap().is_some());
    ws.with_conn_mfa(|c| {
        c.execute("UPDATE auth_sessions SET created_at=created_at-700000", [])
            .unwrap()
    });
    assert!(ws.authenticate_pending(&t).unwrap().is_none());
    assert!(ws.satisfy_session(&t).unwrap().is_none());
}

#[tokio::test]
async fn attempts_are_persisted_per_session_and_slow_the_account_down() {
    let fx = fixture(true);
    let st = &fx.st;
    enrol(&st.workspaces, USER);
    // Per session: 5 then refused — and the count is in SQLite.
    let t = st.workspaces.create_auth_session(USER, 7).unwrap();
    for _ in 0..5 {
        assert_eq!(verify(st, &t, "000000").await.0, StatusCode::BAD_REQUEST);
        // keep the account slowdown out of this assertion
        st.workspaces.with_conn_mfa(|c| {
            c.execute(
                "UPDATE mfa_attempts SET at=at-60000 WHERE key LIKE 'd:%'",
                [],
            )
            .unwrap()
        });
    }
    assert_eq!(
        verify(st, &t, "000000").await.0,
        StatusCode::TOO_MANY_REQUESTS
    );
    let rows: i64 = st.workspaces.with_conn_mfa(|c| {
        c.query_row("SELECT COUNT(*) FROM mfa_attempts", [], |r| r.get(0))
            .unwrap()
    });
    assert!(rows >= 5);
    // Across sessions: a growing delay, not a lock.
    let fx2 = fixture(true);
    let st2 = &fx2.st;
    enrol(&st2.workspaces, USER);
    let mut last = StatusCode::OK;
    for _ in 0..4 {
        let t = st2.workspaces.create_auth_session(USER, 7).unwrap();
        last = verify(st2, &t, "000000").await.0;
    }
    assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
    // a right code on a fresh session works once the delay passes, and clears
    st2.workspaces.with_conn_mfa(|c| {
        c.execute("UPDATE mfa_attempts SET at=at-60000", [])
            .unwrap()
    });
}

#[tokio::test]
async fn a_right_code_does_not_use_the_budget_up() {
    let fx = fixture(true);
    let st = &fx.st;
    let secret = enrol(&st.workspaces, USER);
    let t = st.workspaces.create_auth_session(USER, 7).unwrap();
    assert_eq!(verify(st, &t, "000000").await.0, StatusCode::BAD_REQUEST);
    assert_eq!(
        verify(st, &t, &code_for(&secret, crate::totp::now_secs()))
            .await
            .0,
        StatusCode::OK
    );
    let n: i64 = st.workspaces.with_conn_mfa(|c| {
        c.query_row(
            "SELECT COUNT(*) FROM mfa_attempts WHERE key LIKE 's:%'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    });
    assert_eq!(n, 0, "the session's count is cleared");
    // the success took back its own account attempt; the typo stays counted
    assert_eq!(st.workspaces.mfa_failures_24h(USER), 1);
}

#[tokio::test]
async fn an_admin_enrols_only_from_an_enrolment_link_session() {
    let fx = fixture(false);
    let st = &fx.st;
    let ws = &st.workspaces;
    // A fresh ordinary session of an admin: refused.
    let ordinary = ws.create_auth_session(ADMIN, 7).unwrap();
    let res = local_login::api_totp_begin(State(st.clone()), cookie(&ordinary)).await;
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    // A tool session that is not the enrolment one: refused, for anyone.
    for user in [ADMIN, USER] {
        let tool = ws.mint_tool_session(user, 600_000, "term-sh").unwrap();
        let res = local_login::api_totp_begin(State(st.clone()), cookie(&tool)).await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN, "{user}");
    }
    // The link: single use, then a tool:enrol session that may enrol.
    let link = ws.mint_enroll_link(ADMIN, 600_000).unwrap();
    let (user, session) = ws.open_enroll_link(&link).unwrap();
    assert_eq!(user, ADMIN);
    assert!(ws.open_enroll_link(&link).is_err());
    assert!(ws.open_enroll_link("nope").is_err());
    let res = local_login::api_totp_begin(State(st.clone()), cookie(&session)).await;
    assert_eq!(res.status(), StatusCode::OK);
    // An expired link is dead.
    let old = ws.mint_enroll_link(ADMIN, 600_000).unwrap();
    ws.with_conn_mfa(|c| {
        c.execute("UPDATE mfa_enroll_links SET expires_at=1", [])
            .unwrap()
    });
    assert!(ws.open_enroll_link(&old).is_err());
}

#[tokio::test]
async fn the_android_browser_session_is_deleted_after_the_exchange() {
    let fx = fixture(true);
    let st = &fx.st;
    let secret = enrol(&st.workspaces, USER);
    let (verifier, challenge, client_state) = pkce();
    st.android_auth
        .begin("st9".into(), &challenge, &client_state, "src")
        .unwrap();
    let handshake = st.android_auth.take("st9").unwrap();
    let res = finish_login(
        st,
        "st9",
        false,
        Some(handshake),
        USER,
        None,
        &HeaderMap::new(),
        Factor::Unproven,
    );
    let token = set_cookie_token(&res);
    let held: String = st.workspaces.with_conn_mfa(|c| {
        c.query_row("SELECT mfa_next FROM auth_sessions", [], |r| r.get(0))
            .unwrap()
    });
    let code = held
        .split("code=")
        .nth(1)
        .unwrap()
        .split('&')
        .next()
        .unwrap()
        .to_string();
    assert_eq!(
        verify(st, &token, &code_for(&secret, crate::totp::now_secs()))
            .await
            .0,
        StatusCode::OK
    );
    let res = android_exchange(
        State(st.clone()),
        Json(AndroidExchange {
            code,
            code_verifier: verifier,
        }),
    )
    .await;
    assert_eq!(res.status(), StatusCode::OK);
    assert!(
        st.workspaces
            .authenticate_pending(&token)
            .unwrap()
            .is_none(),
        "browser session ended"
    );
}

#[tokio::test]
async fn enrol_link_is_dead_once_enrolled_or_reset_and_the_label_does_not_matter() {
    let fx = fixture(false);
    let ws = &fx.st.workspaces;
    // enrolled before the link is opened: refused, and enrolling drops the rest
    let l1 = ws.mint_enroll_link(USER, 600_000).unwrap();
    let l2 = ws.mint_enroll_link(USER, 600_000).unwrap();
    enrol(ws, USER);
    assert!(ws.open_enroll_link(&l1).is_err());
    ws.drop_enroll_links(USER);
    assert!(ws.open_enroll_link(&l2).is_err());
    // a reset also drops unused links and demotes ordinary sessions
    let l3 = ws.mint_enroll_link(USER, 600_000).unwrap();
    let s = ws
        .create_auth_session_as(USER, 7, Factor::Proven)
        .unwrap()
        .0;
    assert!(ws.mfa_reset(USER).unwrap());
    assert!(ws.open_enroll_link(&l3).is_err());
    assert!(ws.authenticate(&s).unwrap().is_none());
    // the enrol right is the flag, not the label
    let l4 = ws.mint_enroll_link(USER, 600_000).unwrap();
    let (_, t) = ws.open_enroll_link(&l4).unwrap();
    ws.note_session(&t, "Chrome");
    let label: String = ws.with_conn_mfa(|c| {
        c.query_row(
            "SELECT label FROM auth_sessions WHERE token_hash=?1",
            [crate::workspace::hash_token(&t)],
            |r| r.get(0),
        )
        .unwrap()
    });
    assert_eq!(label, "tool:enrol", "tool sessions keep their label");
    let plain = ws.mint_tool_session(USER, 600_000, "enrol").unwrap();
    assert!(!ws.authenticate_pending(&plain).unwrap().unwrap().enrol);
    assert!(ws.authenticate_pending(&t).unwrap().unwrap().enrol);
}

#[tokio::test]
async fn an_unenrolled_admin_loses_every_ordinary_session_under_the_flag() {
    let fx = fixture(true);
    let ws = &fx.st.workspaces;
    let old = ws
        .create_auth_session_as(ADMIN, 7, Factor::Proven)
        .unwrap()
        .0;
    assert_eq!(ws.demote_stale_admin_sessions(), 1);
    assert!(ws.authenticate(&old).unwrap().is_none());
}

#[tokio::test]
async fn the_account_slowdown_grows_past_30s_and_a_right_code_does_not_reset_it() {
    let fx = fixture(true);
    let ws = &fx.st.workspaces;
    let now = crate::workspace::now_ms();
    ws.with_conn_mfa(|c| {
        for i in 0..8 {
            c.execute(
                "INSERT INTO mfa_attempts(key,at) VALUES(?1,?2)",
                rusqlite::params![format!("d:{USER}"), now - 1000 - i],
            )
            .unwrap();
        }
    });
    // 8 attempts in a day: 1 s * 2^5 = 32 s, and the last one was 1 s ago
    let wait = ws.mfa_attempt(USER, "sess").unwrap_err();
    assert!(wait > 30, "{wait}");
    // a right code clears the session key but keeps the account's failures
    ws.mfa_attempts_clear(USER, "sess");
    assert!(ws.mfa_failures_24h(USER) >= 7);
}
