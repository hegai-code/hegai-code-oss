//! Session and login-state cookies (pentest 11.11.2026, findings 2 and 3):
//! the `__Host-` names, no bare-name fallback on https, duplicate
//! cookies, and the browser binding of the native / Android login hops.

use super::*;
use crate::account::tests::{app_state, cleanup, temp_db};

fn headers_with(cookie: &str) -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert(header::COOKIE, HeaderValue::from_str(cookie).unwrap());
    h
}

fn set_cookies(res: &Response) -> Vec<String> {
    res.headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap().to_string())
        .collect()
}

#[test]
fn cookies_carry_the_host_prefix_only_where_the_browser_can_keep_them() {
    let secure = set_cookie_header(AUTH_COOKIE, "tok", 60, true);
    let secure = secure.to_str().unwrap();
    assert!(secure.starts_with("__Host-cc-remote-auth=tok;"), "{secure}");
    assert!(secure.contains("; Secure") && secure.contains("Path=/"));
    assert!(!secure.contains("Domain"), "a __Host- cookie has no Domain");
    let state = set_cookie_header(SSO_STATE_COOKIE, "s", 600, true);
    assert!(state
        .to_str()
        .unwrap()
        .starts_with("__Host-cc-remote-sso-state=s;"));
    // A plain-http hub (dev, LAN self-host) cannot store a __Host- cookie.
    let plain = set_cookie_header(AUTH_COOKIE, "tok", 60, false);
    assert!(plain.to_str().unwrap().starts_with("cc-remote-auth=tok;"));
}

#[test]
fn an_https_hub_reads_only_the_host_cookie() {
    // https: the bare name is never a session, planted or not.
    let both = headers_with("cc-remote-auth=planted; __Host-cc-remote-auth=real");
    assert_eq!(session_cookie_with(&both, false).as_deref(), Some("real"));
    assert!(session_cookie_with(&headers_with("cc-remote-auth=old"), false).is_none());
    // A present-but-empty or duplicated __Host- cookie yields nothing, and does
    // not fall through to a bare one on a plain-http hub either.
    for raw in [
        "__Host-cc-remote-auth=; cc-remote-auth=planted",
        "__Host-cc-remote-auth=a; __Host-cc-remote-auth=b; cc-remote-auth=planted",
    ] {
        assert!(session_cookie_with(&headers_with(raw), false).is_none());
        assert!(session_cookie_with(&headers_with(raw), true).is_none());
    }
    // Plain-http hub (dev, smokes): the bare name works; two of them do not.
    assert_eq!(
        session_cookie_with(&headers_with("cc-remote-auth=old"), true).as_deref(),
        Some("old")
    );
    assert!(
        session_cookie_with(&headers_with("cc-remote-auth=a; cc-remote-auth=b"), true).is_none()
    );
    // Cookies split across several Cookie headers are all seen.
    let mut split = HeaderMap::new();
    split.append(header::COOKIE, HeaderValue::from_static("x=1"));
    split.append(
        header::COOKIE,
        HeaderValue::from_static("__Host-cc-remote-auth=real"),
    );
    assert_eq!(session_cookie_with(&split, false).as_deref(), Some("real"));
    assert!(session_cookie_with(&HeaderMap::new(), true).is_none());
}

#[tokio::test]
async fn an_old_bare_cookie_stops_working_on_https_and_is_swept() {
    use axum::body::Body;
    use axum::routing::get;
    use tower::ServiceExt;
    let db = temp_db();
    let ws = WorkspaceStore::open(&db).unwrap();
    ws.ensure_user("u1", "u1@x.test", None).unwrap();
    let token = ws.create_auth_session("u1", 7).unwrap();
    let mut st = app_state(ws, &db);
    st.public_url = "https://code.test".into();
    let app = Router::new().route("/probe", get(|| async { "ok" })).layer(
        axum::middleware::from_fn_with_state(st.clone(), refresh_auth_cookie),
    );
    let ask = |cookie: String| {
        let app = app.clone();
        async move {
            let req = axum::http::Request::builder()
                .uri("/probe")
                .header(header::COOKIE, cookie)
                .body(Body::empty())
                .unwrap();
            set_cookies(&app.oneshot(req).await.unwrap())
        }
    };
    // The old session cookie is NOT re-issued as __Host-: no migration.
    let cookies = ask(format!("cc-remote-auth={token}")).await;
    assert!(
        !cookies.iter().any(|c| c.starts_with("__Host-")),
        "{cookies:?}"
    );
    assert!(cookies
        .iter()
        .any(|c| c.starts_with("cc-remote-auth=;") && c.contains("Max-Age=0")));
    // The host cookie is refreshed; a stale bare one beside it is swept.
    let cookies = ask(format!(
        "__Host-cc-remote-auth={token}; cc-remote-auth=stale"
    ))
    .await;
    assert!(cookies
        .iter()
        .any(|c| c.starts_with(&format!("__Host-cc-remote-auth={token};"))));
    assert!(cookies.iter().any(|c| c.starts_with("cc-remote-auth=;")));
    cleanup(&db);
}

#[tokio::test]
async fn native_and_android_callbacks_need_the_state_cookie_too() {
    let db = temp_db();
    let ws = WorkspaceStore::open(&db).unwrap();
    let mut st = app_state(ws, &db);
    st.public_url = "https://code.test".into();
    let params = |state: &str| HashMap::from([("state".to_string(), state.to_string())]);

    // iOS: state in the hub's native map, but the callback arrives in a
    // browser that never made the start request — no cookie.
    remember_native_state(&st, "native-1");
    assert!(check_login_state(&st, &params("native-1"), &HeaderMap::new()).is_err());
    // A cookie for some other login does not help either.
    let other = headers_with("__Host-cc-remote-sso-state=native-2");
    assert!(check_login_state(&st, &params("native-1"), &other).is_err());
    // The legacy / unprefixed name is not a state cookie on an https hub.
    let legacy = headers_with("cc-remote-sso-state=native-1");
    assert!(check_login_state(&st, &params("native-1"), &legacy).is_err());
    // The browser that started it carries the cookie: accepted, flagged native.
    let mine = headers_with("__Host-cc-remote-sso-state=native-1");
    let (state, native, android) = check_login_state(&st, &params("native-1"), &mine).unwrap();
    assert_eq!(
        (state.as_str(), native, android.is_some()),
        ("native-1", true, false)
    );
    // ... and spent: a replay with the cookie still fails.
    let replay = check_login_state(&st, &params("native-1"), &mine).unwrap();
    assert!(!replay.1, "the native state is single-use");

    // Android: same rule for the handshake.
    let challenge = "c".repeat(43);
    let client_state = "s".repeat(40);
    st.android_auth
        .begin("android-1".into(), &challenge, &client_state, "1.2.3.4")
        .unwrap();
    assert!(check_login_state(&st, &params("android-1"), &HeaderMap::new()).is_err());
    let mine = headers_with("__Host-cc-remote-sso-state=android-1");
    let (_, native, android) = check_login_state(&st, &params("android-1"), &mine).unwrap();
    assert!(!native && android.is_some());

    // Plain browser flow is unchanged: no cookie or empty state fails.
    assert!(check_login_state(&st, &params("b-1"), &HeaderMap::new()).is_err());
    assert!(check_login_state(
        &st,
        &params(""),
        &headers_with("__Host-cc-remote-sso-state=")
    )
    .is_err());
    cleanup(&db);
}

/// A browser Google link (`?link=1`) binds the hash of the live session that
/// began it; the callback accepts it while that session lives and refuses it
/// after (a signed-out or undone account).
#[tokio::test]
async fn a_browser_google_link_is_bound_to_the_hash_of_its_live_session() {
    let db = temp_db();
    let ws = WorkspaceStore::open(&db).unwrap();
    ws.ensure_user("u1", "u1@x.test", None).unwrap();
    let token = ws.create_auth_session("u1", 7).unwrap();
    let st = app_state(ws, &db);
    let headers = headers_with(&format!("{AUTH_COOKIE}={token}"));
    // What `link_account` stores for `link=1`, and what the callback checks.
    let bound = crate::workspace_api::current_session(&headers, &st).expect("a live session");
    assert_eq!(
        bound,
        crate::workspace::hash_token(&token),
        "the hash, never the raw token"
    );
    assert!(st.workspaces.session_alive_for(&bound, "u1"));
    assert!(!st.workspaces.session_alive_for(&bound, "someone-else"));
    st.workspaces.logout(&token);
    assert!(
        !st.workspaces.session_alive_for(&bound, "u1"),
        "a dead session fails the callback"
    );
    assert!(crate::workspace_api::current_session(&headers, &st).is_none());
    cleanup(&db);
}
