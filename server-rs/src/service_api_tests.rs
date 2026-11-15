//! HTTP-level tests of the service API (`service_api.rs`): the key, its
//! fences, the share upsert and the sign-in token.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::account::tests::{app_state, cleanup, temp_db};
use crate::service_api::*;
use crate::workspace::WorkspaceStore;
use crate::AppState;

const KEY: &str = "legal-key-0123456789abcdef";
const SECRET: &str = "signin-secret-0123456789-0123456789-xyz";
const PREFIX: &str = "/srv/legal/projects";

fn sha(s: &str) -> String {
    Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn entry(name: &str, ws: &str, machine: &str, key: &str, secret: &str) -> Value {
    json!({"name":name,"workspaceId":ws,"machineIds":[machine],"rootPrefix":PREFIX,
           "keySha256":sha(key),"signinSecret":secret})
}

struct Fixture {
    st: AppState,
    wid: String,
    db: std::path::PathBuf,
}

/// Workspace `Team` (owner boss, who owns machine `legal-box`), members ann
/// (active) and bob (a manager), dan (member, waitlisted), cat (a user in no
/// workspace but her own), and a second workspace with its own machine and key.
fn fixture() -> Fixture {
    let s = WorkspaceStore::open_memory();
    s.with_conn_for_tests(|c| c.execute_batch(crate::replica::SCHEMA).unwrap());
    for (id, mail) in [
        ("boss", "boss@x"),
        ("ann", "ann@x"),
        ("bob", "bob@x"),
        ("cat", "cat@x"),
        ("dan", "dan@x"),
        ("eve", "eve@x"),
    ] {
        s.ensure_user(id, mail, Some(id)).unwrap();
    }
    for id in ["boss", "ann", "bob", "cat", "eve"] {
        s.activate_access(id, "tests").unwrap();
    }
    let w = s.create_organization("boss", "Team", "boss").unwrap();
    let wid = w["workspaceId"].as_str().unwrap().to_string();
    for (id, role) in [("ann", "member"), ("bob", "member"), ("dan", "member")] {
        let invite = s.invite("boss", &wid, &format!("{id}@x"), role).unwrap();
        s.accept_invitation(id, invite["token"].as_str().unwrap())
            .unwrap();
    }
    s.set_member_role("boss", &wid, "bob", "manager").unwrap();
    s.register_legacy_device(
        "boss",
        &json!({"machineId":"legal-box","name":"Legal","os":"linux","agentVersion":"1"}),
    )
    .unwrap();
    // A second workspace, machine and key: must see nothing of the first.
    let w2 = s.create_organization("eve", "Other", "eve").unwrap();
    let wid2 = w2["workspaceId"].as_str().unwrap().to_string();
    s.register_legacy_device(
        "eve",
        &json!({"machineId":"other-box","name":"Other","os":"linux","agentVersion":"1"}),
    )
    .unwrap();
    let db = temp_db();
    let mut st = app_state(s, &db);
    let keys = parse_service_keys(
        &json!([
            entry("legal", &wid, "legal-box", KEY, SECRET),
            entry(
                "other",
                &wid2,
                "other-box",
                "other-key-0123456789abcdef",
                "other-secret-0123456789-0123456789-x"
            ),
        ])
        .to_string(),
    );
    assert_eq!(keys.len(), 2);
    st.service_keys = Some(Arc::new(keys));
    Fixture { st, wid, db }
}

async fn read(res: Response) -> (StatusCode, Value, HeaderMap) {
    let status = res.status();
    let headers = res.headers().clone();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        headers,
    )
}

fn bearer(token: Option<&str>) -> HeaderMap {
    let mut h = HeaderMap::new();
    if let Some(t) = token {
        h.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {t}")).unwrap(),
        );
    }
    h
}

async fn put(st: &AppState, token: Option<&str>, body: Value) -> (StatusCode, Value) {
    let res = api_service_put_share(
        State(st.clone()),
        bearer(token),
        Bytes::from(body.to_string()),
    )
    .await;
    let (s, v, _) = read(res).await;
    (s, v)
}

async fn put_raw(st: &AppState, token: Option<&str>, body: Vec<u8>) -> StatusCode {
    api_service_put_share(State(st.clone()), bearer(token), Bytes::from(body))
        .await
        .status()
}

fn query(pairs: &[(&str, &str)]) -> Query<std::collections::HashMap<String, String>> {
    Query(
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
    )
}

async fn list(st: &AppState, token: Option<&str>, machine: &str) -> (StatusCode, Value) {
    let res = api_service_list_shares(
        State(st.clone()),
        bearer(token),
        query(&[("machineId", machine)]),
    )
    .await;
    let (s, v, _) = read(res).await;
    (s, v)
}

async fn delete(
    st: &AppState,
    token: Option<&str>,
    machine: &str,
    root: &str,
) -> (StatusCode, Value) {
    let res = api_service_delete_share(
        State(st.clone()),
        bearer(token),
        query(&[("machineId", machine), ("root", root)]),
    )
    .await;
    let (s, v, _) = read(res).await;
    (s, v)
}

fn body(root: &str, members: Value) -> Value {
    json!({"machineId":"legal-box","root":root,"name":"Дело 1","members":members})
}

#[tokio::test]
async fn the_key_is_required_and_a_wrong_one_is_401() {
    let f = fixture();
    let ok = body(
        "/srv/legal/projects/delo-1",
        json!([{"userId":"ann","role":"lead"}]),
    );
    assert_eq!(
        put(&f.st, None, ok.clone()).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        put(&f.st, Some("not-the-key"), ok.clone()).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        list(&f.st, Some("nope"), "legal-box").await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        delete(
            &f.st,
            Some("nope"),
            "legal-box",
            "/srv/legal/projects/delo-1"
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(put(&f.st, Some(KEY), ok).await.0, StatusCode::OK);
    // Unconfigured hub: the whole API is not there.
    let mut st = f.st.clone();
    st.service_keys = None;
    assert_eq!(
        put(
            &st,
            Some(KEY),
            body(
                "/srv/legal/projects/x",
                json!([{"userId":"ann","role":"member"}])
            )
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    cleanup(&f.db);
}

#[tokio::test]
async fn a_key_stays_in_its_own_machine_and_prefix() {
    let f = fixture();
    let m = json!([{"userId":"ann","role":"member"}]);
    // Another workspace's machine.
    let mut other = body("/srv/legal/projects/d", m.clone());
    other["machineId"] = json!("other-box");
    assert_eq!(put(&f.st, Some(KEY), other).await.0, StatusCode::FORBIDDEN);
    // Roots outside, equal to, or climbing out of the prefix.
    for root in [
        "/etc",
        "/srv/legal/projects",
        "/srv/legal/projects/",
        "/srv/legal/projects-evil/x",
        "/srv/legal/projects/../x",
        "/srv/legal/projects/a/../../x",
        "/srv/legal/projects/./../x",
        "srv/legal/projects/relative",
        "/srv/legal/projects/back\\slash",
        "",
    ] {
        let (status, v) = put(&f.st, Some(KEY), body(root, m.clone())).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{root:?}: {v}");
        assert_eq!(
            delete(&f.st, Some(KEY), "legal-box", root).await.0,
            StatusCode::FORBIDDEN,
            "{root:?}"
        );
    }
    // Reading another key's machine, and the other key reading ours.
    assert_eq!(
        list(&f.st, Some(KEY), "other-box").await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        list(&f.st, Some("other-key-0123456789abcdef"), "legal-box")
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    // A share of this workspace outside the prefix is not the key's business.
    f.st.workspaces.with_conn_for_tests(|c| {
        c.execute(
            "INSERT INTO project_shares(project_share_id,workspace_id,machine_id,owner_user_id,root,name,created_at,access) VALUES('manual',?1,'legal-box','boss','/srv/other','O',1,'control')",
            [&f.wid],
        )
        .unwrap();
    });
    // Nor is a share AT the prefix itself: reads follow the same rule as writes.
    f.st.workspaces.with_conn_for_tests(|c| {
        c.execute(
            "INSERT INTO project_shares(project_share_id,workspace_id,machine_id,owner_user_id,root,name,created_at,access) VALUES('at-prefix',?1,'legal-box','boss',?2,'P',1,'control')",
            [&f.wid, PREFIX],
        )
        .unwrap();
    });
    let (_, v) = list(&f.st, Some(KEY), "legal-box").await;
    assert!(v["shares"].as_array().unwrap().is_empty(), "{v}");
    assert!(
        !delete(&f.st, Some(KEY), "legal-box", "/srv/legal/projects/nope")
            .await
            .1["removed"]
            .as_bool()
            .unwrap()
    );
    cleanup(&f.db);
}

#[tokio::test]
async fn an_upsert_is_idempotent_replaces_members_and_reports_the_unknown() {
    let f = fixture();
    let root = "/srv/legal/projects/delo-7";
    let first = json!([
        {"userId":"ann","role":"lead"},
        {"userId":"bob","role":"member"},
        {"userId":"cat","role":"partner"},
        {"userId":"ghost","role":"member"},
        {"userId":"ann","role":"member"}
    ]);
    let (status, v) = put(&f.st, Some(KEY), body(root, first.clone())).await;
    assert_eq!(status, StatusCode::OK, "{v}");
    let id = v["shareId"].as_str().unwrap().to_string();
    assert_eq!(
        v["missingUsers"],
        json!(["cat", "ghost"]),
        "cat exists but is not in the workspace: a key never adds people to the team"
    );
    assert_eq!(
        v["members"],
        json!([
            {"userId":"ann","role":"lead"},
            {"userId":"bob","role":"member"}
        ]),
        "the first mention of a user wins; non-members are not listed"
    );
    assert_eq!(
        v["dirCreated"],
        Value::Null,
        "no agent is online in this test"
    );

    // Nobody is added to the workspace; bob keeps the manager role.
    let role = |user: &str| -> Option<String> {
        f.st.workspaces.with_conn_for_tests(|c| {
            c.query_row(
                "SELECT role FROM memberships WHERE workspace_id=?1 AND user_id=?2",
                [&f.wid, user],
                |r| r.get(0),
            )
            .ok()
        })
    };
    assert_eq!(role("cat"), None, "not added to the workspace");
    assert_eq!(role("bob").as_deref(), Some("manager"), "not downgraded");
    assert_eq!(role("boss").as_deref(), Some("owner"));
    assert_eq!(role("ghost"), None);

    // The share is a control share owned by the device owner.
    let (owner, access, restricted): (String, String, i64) =
        f.st.workspaces.with_conn_for_tests(|c| {
            c.query_row(
                "SELECT owner_user_id,access,restricted FROM project_shares WHERE project_share_id=?1",
                [&id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap()
        });
    assert_eq!(
        (owner.as_str(), access.as_str(), restricted),
        ("boss", "control", 1),
        "and it is restricted: closed to everyone not on the list"
    );

    // Same call again: same share, nothing doubled.
    let (_, again) = put(&f.st, Some(KEY), body(root, first)).await;
    assert_eq!(again["shareId"], id);
    // Replaced EXACTLY: only ann remains, with the new role.
    let (_, third) = put(
        &f.st,
        Some(KEY),
        json!({"machineId":"legal-box","root":"/srv/legal/projects/./delo-7/","name":"Дело 7","members":[{"userId":"ann","role":"partner"}]}),
    )
    .await;
    assert_eq!(
        third["shareId"], id,
        "a normalizable spelling is the same root"
    );
    assert_eq!(third["members"], json!([{"userId":"ann","role":"partner"}]));
    let (_, listed) = list(&f.st, Some(KEY), "legal-box").await;
    let shares = listed["shares"].as_array().unwrap();
    assert_eq!(shares.len(), 1);
    assert_eq!(shares[0]["shareId"], id);
    assert_eq!(shares[0]["name"], "Дело 7");
    assert_eq!(
        shares[0]["members"],
        json!([{"userId":"ann","role":"partner"}])
    );

    // A list that resolves to nobody must not turn the share into «everyone».
    let (status, _) = put(
        &f.st,
        Some(KEY),
        body(root, json!([{"userId":"ghost","role":"member"}])),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (_, listed) = list(&f.st, Some(KEY), "legal-box").await;
    assert_eq!(listed["shares"][0]["members"].as_array().unwrap().len(), 1);

    // The trail records WHO was listed (not just how many) and each mkdir.
    let (listed_in_audit, mkdir_rows): (String, i64) = f.st.workspaces.with_conn_for_tests(|c| {
        (
            c.query_row(
                "SELECT json_extract(metadata_json,'$.members') FROM audit_events WHERE action='project.service_shared' ORDER BY created_at DESC,rowid DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap(),
            c.query_row(
                "SELECT COUNT(*) FROM audit_events WHERE action='project.service_mkdir' AND json_extract(metadata_json,'$.result') IS NULL AND actor_user_id='service:legal'",
                [],
                |r| r.get(0),
            )
            .unwrap(),
        )
    });
    assert!(
        listed_in_audit.contains("\"userId\":\"ann\"")
            && listed_in_audit.contains("\"role\":\"partner\"")
    );
    assert!(
        mkdir_rows >= 3,
        "one mkdir row per PUT, result null while offline"
    );

    // The trail names the integration.
    let actors: Vec<String> = f.st.workspaces.with_conn_for_tests(|c| {
        let mut stmt = c
            .prepare("SELECT actor_user_id FROM audit_events WHERE action='project.service_shared'")
            .unwrap();
        stmt.query_map([], |r| r.get(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect()
    });
    assert!(!actors.is_empty() && actors.iter().all(|a| a == "service:legal"));

    // Delete: the share and its list go; the folder is not our business.
    let (status, v) = delete(&f.st, Some(KEY), "legal-box", root).await;
    assert_eq!(
        (status, v["removed"].clone()),
        (StatusCode::OK, json!(true))
    );
    assert!(
        !delete(&f.st, Some(KEY), "legal-box", root).await.1["removed"]
            .as_bool()
            .unwrap()
    );
    let left: i64 = f.st.workspaces.with_conn_for_tests(|c| {
        c.query_row("SELECT COUNT(*) FROM project_share_members", [], |r| {
            r.get(0)
        })
        .unwrap()
    });
    assert_eq!(left, 0);
    cleanup(&f.db);
}

#[tokio::test]
async fn bad_bodies_are_refused() {
    let f = fixture();
    let root = "/srv/legal/projects/delo-2";
    let bad_role = body(root, json!([{"userId":"ann","role":"king"}]));
    assert_eq!(
        put(&f.st, Some(KEY), bad_role).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        put(&f.st, Some(KEY), body(root, json!([]))).await.0,
        StatusCode::BAD_REQUEST
    );
    let many: Vec<Value> = (0..51)
        .map(|i| json!({"userId":format!("u{i}"),"role":"member"}))
        .collect();
    assert_eq!(
        put(&f.st, Some(KEY), body(root, Value::Array(many)))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let mut nameless = body(root, json!([{"userId":"ann","role":"member"}]));
    nameless["name"] = json!("  ");
    assert_eq!(
        put(&f.st, Some(KEY), nameless).await.0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        put_raw(&f.st, Some(KEY), b"not json".to_vec()).await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        put_raw(&f.st, Some(KEY), vec![b' '; 64 * 1024 + 1]).await,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    cleanup(&f.db);
}

// ---------------------------------------------------------------- sign-in

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn token_with(secret: &str, claims: Value) -> String {
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .unwrap()
}

fn claims(sub: &str, jti: &str, next: Option<&str>) -> Value {
    let mut c =
        json!({"iss":"legal","aud":"cc-remote-service-signin","sub":sub,"jti":jti,"exp":now()+60});
    if let Some(next) = next {
        c["next"] = json!(next);
    }
    c
}

async fn signin(st: &AppState, token: &str) -> (StatusCode, HeaderMap) {
    signin_with(st, token, None).await
}

/// `session` = the value of the hub cookie this browser already holds.
async fn signin_with(st: &AppState, token: &str, session: Option<&str>) -> (StatusCode, HeaderMap) {
    let mut headers = HeaderMap::new();
    if let Some(session) = session {
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("cc-remote-auth={session}")).unwrap(),
        );
    }
    let res = api_service_signin(query(&[("t", token)]), State(st.clone()), headers).await;
    let (s, _, h) = read(res).await;
    (s, h)
}

fn set_cookies(h: &HeaderMap) -> Vec<String> {
    h.get_all(header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap().to_string())
        .collect()
}

fn audit_outcomes(f: &Fixture) -> Vec<String> {
    f.st.workspaces.with_conn_for_tests(|c| {
        let mut stmt = c
            .prepare("SELECT json_extract(metadata_json,'$.outcome') FROM audit_events WHERE action='auth.service_signin' ORDER BY created_at,rowid")
            .unwrap();
        stmt.query_map([], |r| r.get(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect()
    })
}

/// A service key mints a session only for a plain member of its workspace.
/// For anyone else it signs nobody in: a browser that already holds that very
/// user's session just goes on, everybody else is sent to sign in themselves
/// and comes back to `next`.
#[tokio::test]
async fn only_a_plain_member_gets_a_new_session() {
    let f = fixture();
    let admin = f.st.bootstrap_user_id.clone();
    f.st.workspaces
        .ensure_user(&admin, "admin@x", Some("Admin"))
        .unwrap();
    f.st.workspaces.activate_access(&admin, "tests").unwrap();
    // Everyone below is a member of the workspace; what differs is what ELSE
    // they are. frank owns a machine, gina sits in another team, hank is the
    // platform admin.
    for id in ["frank", "gina", "hank"] {
        f.st.workspaces
            .ensure_user(id, &format!("{id}@x"), Some(id))
            .unwrap();
        f.st.workspaces.activate_access(id, "tests").unwrap();
    }
    f.st.workspaces.with_conn_for_tests(|c| {
        for user in ["frank", "gina", &admin] {
            c.execute(
                "INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?1,?2,'member',1)",
                [&f.wid, user],
            )
            .unwrap();
        }
    });
    f.st.workspaces
        .register_legacy_device(
            "frank",
            &json!({"machineId":"franks-laptop","name":"F","os":"linux","agentVersion":"1"}),
        )
        .unwrap();
    f.st.workspaces
        .create_organization("eve", "Third", "eve")
        .unwrap();
    let third = f.st.workspaces.workspaces("eve").unwrap();
    let third = third
        .iter()
        .find(|w| w["name"] == "Third")
        .and_then(|w| w["workspaceId"].as_str())
        .unwrap()
        .to_string();
    f.st.workspaces.with_conn_for_tests(|c| {
        c.execute(
            "INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?1,'gina','member',1)",
            [&third],
        )
        .unwrap();
    });

    // bob is a manager here: not plain either.
    let sessions = |f: &Fixture| -> i64 {
        f.st.workspaces.with_conn_for_tests(|c| {
            c.query_row("SELECT COUNT(*) FROM auth_sessions", [], |r| r.get(0))
                .unwrap()
        })
    };
    for (i, who) in ["bob", "frank", "gina", admin.as_str()]
        .into_iter()
        .enumerate()
    {
        let t = token_with(SECRET, claims(who, &format!("p{i}"), Some("/w/?share=s1")));
        let (status, h) = signin(&f.st, &t).await;
        assert_eq!(status, StatusCode::FOUND, "{who}");
        assert_eq!(location(&h), "/w/?share=s1", "{who}");
        let cookies = set_cookies(&h);
        assert!(
            cookies.iter().all(|c| !c.starts_with("cc-remote-auth=")),
            "{who} must not get a session: {cookies:?}"
        );
        assert!(
            cookies
                .iter()
                .any(|c| c.starts_with("cc-remote-return=") && c.contains("%2Fw%2F%3Fshare%3Ds1")),
            "{who} is sent to sign in and back: {cookies:?}"
        );
    }
    assert_eq!(sessions(&f), 0);
    assert_eq!(audit_outcomes(&f), ["login_required"; 4]);

    // A browser that already holds the SAME user's session just goes on.
    let bobs = f.st.workspaces.create_auth_session("bob", 1).unwrap();
    let t = token_with(SECRET, claims("bob", "same", Some("/w/projects")));
    let (status, h) = signin_with(&f.st, &t, Some(&bobs)).await;
    assert_eq!(
        (status, location(&h).as_str()),
        (StatusCode::FOUND, "/w/projects")
    );
    assert!(
        set_cookies(&h).is_empty(),
        "no new session, no return cookie"
    );
    // Someone else's session is not the same user: never on into bob's
    // account. The browser's cookie is dropped (bob's session is untouched),
    // the sign-in page shows and the return path is left for after it.
    let t = token_with(SECRET, claims("frank", "other", Some("/w/?share=s2")));
    let (status, h) = signin_with(&f.st, &t, Some(&bobs)).await;
    assert_eq!(status, StatusCode::FOUND);
    let cookies = set_cookies(&h);
    assert!(
        cookies
            .iter()
            .any(|c| c.starts_with("cc-remote-auth=;") && c.contains("Max-Age=0")),
        "{cookies:?}"
    );
    assert!(cookies
        .iter()
        .any(|c| c.starts_with("cc-remote-return=") && c.contains("share%3Ds2")));
    assert!(f.st.workspaces.authenticate(&bobs).unwrap().is_some());
    assert_eq!(sessions(&f), 1, "only the one this test created");
    assert_eq!(audit_outcomes(&f)[4], "existing_session");

    // The plain member gets a session the integration can later revoke by label.
    let t = token_with(SECRET, claims("ann", "plain", None));
    let (_, h) = signin(&f.st, &t).await;
    assert!(set_cookies(&h)
        .iter()
        .any(|c| c.starts_with("cc-remote-auth=")));
    let label: String = f.st.workspaces.with_conn_for_tests(|c| {
        c.query_row(
            "SELECT label FROM auth_sessions WHERE user_id='ann'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    });
    assert_eq!(label, "service:legal");
    assert_eq!(
        audit_outcomes(&f).last().map(String::as_str),
        Some("issued")
    );
    cleanup(&f.db);
}

/// The one-shot rows of service tokens are swept a day after they could be used.
#[tokio::test]
async fn spent_service_tokens_are_forgotten_after_a_day() {
    let f = fixture();
    let t = token_with(SECRET, claims("ann", "old", None));
    assert_eq!(signin(&f.st, &t).await.0, StatusCode::FOUND);
    f.st.workspaces.with_conn_for_tests(|c| {
        c.execute("UPDATE signin_links SET expires_at=1", [])
            .unwrap();
        // An operator link row has no expiry and is never swept.
        c.execute(
            "INSERT INTO signin_links(jti_hash,user_id,used_at) VALUES('operator','ann',1)",
            [],
        )
        .unwrap();
    });
    let t = token_with(SECRET, claims("ann", "new", None));
    assert_eq!(signin(&f.st, &t).await.0, StatusCode::FOUND);
    let left: Vec<String> = f.st.workspaces.with_conn_for_tests(|c| {
        let mut stmt = c
            .prepare("SELECT jti_hash FROM signin_links ORDER BY rowid")
            .unwrap();
        stmt.query_map([], |r| r.get(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect()
    });
    assert_eq!(left.len(), 2, "the old service row is gone: {left:?}");
    assert!(left.contains(&"operator".to_string()));
    cleanup(&f.db);
}

fn location(h: &HeaderMap) -> String {
    h.get(header::LOCATION)
        .unwrap()
        .to_str()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn a_valid_token_sets_the_cookie_and_goes_to_next() {
    let f = fixture();
    let t = token_with(SECRET, claims("ann", "j1", Some("/w/?share=abc-123")));
    let (status, h) = signin(&f.st, &t).await;
    assert_eq!(status, StatusCode::FOUND);
    assert_eq!(location(&h), "/w/?share=abc-123");
    let cookie = h.get(header::SET_COOKIE).unwrap().to_str().unwrap();
    assert!(
        cookie.starts_with("cc-remote-auth=") && cookie.contains("HttpOnly"),
        "{cookie}"
    );
    let session = cookie.split(';').next().unwrap().split_once('=').unwrap().1;
    let (user, _) =
        f.st.workspaces
            .authenticate(session)
            .unwrap()
            .expect("a live session");
    assert_eq!(user, "ann");
    // The trail is in the workspace, with the integration as actor.
    let row: (String, String) = f.st.workspaces.with_conn_for_tests(|c| {
        c.query_row(
            "SELECT actor_user_id,target_id FROM audit_events WHERE action='auth.service_signin'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    });
    assert_eq!(row, ("service:legal".to_string(), "ann".to_string()));
    assert_eq!(audit_outcomes(&f), ["issued"]);
    // One use only.
    let (status, _) = signin(&f.st, &t).await;
    assert_eq!(status, StatusCode::GONE);
    cleanup(&f.db);
}

#[tokio::test]
async fn a_token_that_does_not_hold_is_refused() {
    let f = fixture();
    let ok = |jti: &str| claims("ann", jti, None);
    // Wrong secret, issuer, audience; expired; promising too long a life.
    assert_eq!(
        signin(
            &f.st,
            &token_with("another-secret-0123456789-0123456789", ok("a"))
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let mut wrong_iss = ok("b");
    wrong_iss["iss"] = json!("other");
    assert_eq!(
        signin(&f.st, &token_with(SECRET, wrong_iss)).await.0,
        StatusCode::UNAUTHORIZED
    );
    let mut wrong_aud = ok("c");
    wrong_aud["aud"] = json!("cc-remote-signin");
    assert_eq!(
        signin(&f.st, &token_with(SECRET, wrong_aud)).await.0,
        StatusCode::UNAUTHORIZED
    );
    let mut expired = ok("d");
    expired["exp"] = json!(now() - 5);
    assert_eq!(
        signin(&f.st, &token_with(SECRET, expired)).await.0,
        StatusCode::UNAUTHORIZED
    );
    let mut long = ok("e");
    long["exp"] = json!(now() + 3600);
    assert_eq!(
        signin(&f.st, &token_with(SECRET, long)).await.0,
        StatusCode::UNAUTHORIZED
    );
    let mut no_exp = ok("f");
    no_exp.as_object_mut().unwrap().remove("exp");
    assert_eq!(
        signin(&f.st, &token_with(SECRET, no_exp)).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(signin(&f.st, "garbage").await.0, StatusCode::UNAUTHORIZED);
    // Another integration's secret does not open this one's workspace.
    let other = token_with("other-secret-0123456789-0123456789-x", ok("g"));
    assert_eq!(signin(&f.st, &other).await.0, StatusCode::UNAUTHORIZED);

    // A platform admin, a user outside the workspace, one on the waitlist,
    // and one who does not exist.
    let admin = f.st.bootstrap_user_id.clone();
    f.st.workspaces
        .ensure_user(&admin, "admin@x", Some("Admin"))
        .unwrap();
    assert_eq!(
        signin(&f.st, &token_with(SECRET, claims(&admin, "h", None)))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        signin(&f.st, &token_with(SECRET, claims("cat", "i", None)))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        signin(&f.st, &token_with(SECRET, claims("dan", "j", None)))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        signin(&f.st, &token_with(SECRET, claims("nobody", "k", None)))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    // None of those spent a session.
    let sessions: i64 = f.st.workspaces.with_conn_for_tests(|c| {
        c.query_row("SELECT COUNT(*) FROM auth_sessions", [], |r| r.get(0))
            .unwrap()
    });
    assert_eq!(sessions, 0);
    cleanup(&f.db);
}

#[tokio::test]
async fn next_outside_w_falls_back_to_w() {
    let f = fixture();
    for (i, (next, want)) in [
        (Some("/admin"), "/w/"),
        (Some("https://evil.example/w/"), "/w/"),
        (Some("//evil.example/w/x"), "/w/"),
        (Some("/w//evil.example"), "/w/"),
        (Some("/w/\\evil"), "/w/"),
        (Some("/w/a\r\nSet-Cookie: x=1"), "/w/"),
        (Some("/w"), "/w/"),
        (None, "/w/"),
        (Some("/w/projects"), "/w/projects"),
    ]
    .into_iter()
    .enumerate()
    {
        let t = token_with(SECRET, claims("ann", &format!("n{i}"), next));
        let (status, h) = signin(&f.st, &t).await;
        assert_eq!(status, StatusCode::FOUND, "{next:?}");
        assert_eq!(location(&h), want, "{next:?}");
    }
    assert_eq!(safe_next(Some("/w/?share=1&x=2")), "/w/?share=1&x=2");
    cleanup(&f.db);
}

#[test]
fn the_config_file_drops_malformed_entries() {
    let good = entry("legal", "w", "m", KEY, SECRET);
    let mut short_secret = good.clone();
    short_secret["signinSecret"] = json!("short");
    let mut bad_hash = good.clone();
    bad_hash["keySha256"] = json!("zz");
    let mut root_slash = good.clone();
    root_slash["rootPrefix"] = json!("/");
    let mut no_machines = good.clone();
    no_machines["machineIds"] = json!([]);
    let parsed = parse_service_keys(
        &json!([good, short_secret, bad_hash, root_slash, no_machines, {"name":"x"}]).to_string(),
    );
    assert_eq!(parsed.len(), 1);
    assert!(parse_service_keys("not json").is_empty());
    assert_eq!(parsed[0].root_prefix, PREFIX);
}

/// Deleting a restricted share must not hand its folder to a broader share:
/// it becomes a tombstone nobody but the workspace owner and the device owner
/// reaches, the integration still sees it (empty), and a new PUT revives it.
#[tokio::test]
async fn deleting_a_restricted_share_leaves_a_tombstone_not_a_hole() {
    let f = fixture();
    let broad = "/srv/legal/projects/a";
    let secret = "/srv/legal/projects/a/b";
    // A team share over the whole of `a` (not the key's doing) and a restricted
    // one inside it that only bob is on.
    f.st.workspaces.with_conn_for_tests(|c| {
        c.execute(
            "INSERT INTO project_shares(project_share_id,workspace_id,machine_id,owner_user_id,root,name,created_at,access) VALUES('broad',?1,'legal-box','boss',?2,'A',1,'control')",
            [&f.wid, broad],
        )
        .unwrap();
    });
    let (status, v) = put(
        &f.st,
        Some(KEY),
        body(secret, json!([{"userId":"bob","role":"lead"}])),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{v}");
    let id = v["shareId"].as_str().unwrap().to_string();
    let ann_denied = |f: &Fixture| {
        let a =
            f.st.workspaces
                .ui_access("ann", Some(&f.wid), false)
                .unwrap();
        let m = f.st.workspaces.machine_access(&a, "legal-box").unwrap();
        (
            m.allows_path("/srv/legal/projects/a/b/x"),
            m.allows_path("/srv/legal/projects/a/x"),
        )
    };
    assert_eq!(ann_denied(&f), (false, true));

    let (status, v) = delete(&f.st, Some(KEY), "legal-box", secret).await;
    assert_eq!(
        (status, v["removed"].clone()),
        (StatusCode::OK, json!(true))
    );
    assert_eq!(
        ann_denied(&f),
        (false, true),
        "the broader share did not swallow it"
    );
    let (_, listed) = list(&f.st, Some(KEY), "legal-box").await;
    let tomb = listed["shares"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["root"] == secret)
        .expect("still listed, so the integration knows it is closed");
    assert_eq!(tomb["shareId"], id);
    assert_eq!(tomb["members"], json!([]));
    // Nobody else but the owners can reach it either.
    let bob =
        f.st.workspaces
            .ui_access("bob", Some(&f.wid), false)
            .unwrap();
    assert!(!f
        .st
        .workspaces
        .machine_access(&bob, "legal-box")
        .unwrap()
        .allows_path("/srv/legal/projects/a/b/x"));
    // A second delete changes nothing.
    assert_eq!(
        delete(&f.st, Some(KEY), "legal-box", secret).await.1["removed"],
        json!(false)
    );

    // A new PUT on the same root revives the very same share.
    let (_, again) = put(
        &f.st,
        Some(KEY),
        body(secret, json!([{"userId":"ann","role":"member"}])),
    )
    .await;
    assert_eq!(again["shareId"], id);
    assert_eq!(ann_denied(&f), (true, true), "ann is on it now");
    cleanup(&f.db);
}

/// Signs `who` in through the key and returns the session token it was given.
async fn minted_session(f: &Fixture, who: &str, jti: &str) -> String {
    let t = token_with(SECRET, claims(who, jti, None));
    let (status, h) = signin(&f.st, &t).await;
    assert_eq!(status, StatusCode::FOUND);
    let cookie = set_cookies(&h)
        .into_iter()
        .find(|c| c.starts_with("cc-remote-auth=") && !c.starts_with("cc-remote-auth=;"))
        .expect("a session was issued");
    cookie
        .split(';')
        .next()
        .unwrap()
        .split_once('=')
        .unwrap()
        .1
        .to_string()
}

/// The issuer and workspace of a service session are immutable (the device
/// label is not), so a rotation can revoke by issuer even after the person has
/// used the session from a browser.
#[tokio::test]
async fn a_service_session_keeps_its_issuer_when_the_device_is_named() {
    let f = fixture();
    let token = minted_session(&f, "ann", "n1").await;
    f.st.workspaces.note_session(&token, "Chrome on Mac");
    let (label, issuer, ws): (String, String, String) = f.st.workspaces.with_conn_for_tests(|c| {
        c.query_row(
            "SELECT label,service_issuer,service_workspace_id FROM auth_sessions WHERE user_id='ann'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap()
    });
    assert_eq!(label, "Chrome on Mac", "the device name replaced the label");
    assert_eq!((issuer.as_str(), ws.as_str()), ("legal", f.wid.as_str()));
    assert!(f.st.workspaces.authenticate(&token).unwrap().is_some());
    // Revoking by issuer takes it.
    f.st.workspaces.with_conn_for_tests(|c| {
        c.execute("DELETE FROM auth_sessions WHERE service_issuer='legal'", [])
            .unwrap();
    });
    assert!(f.st.workspaces.authenticate(&token).unwrap().is_none());
    cleanup(&f.db);
}

/// A session a service key minted is only as good as the person staying the
/// plain member the key may sign in: promotion, a machine, another team, being
/// removed, or becoming an administrator each void it (and delete it).
#[tokio::test]
async fn a_service_session_does_not_outgrow_its_plain_member() {
    type Change = fn(&Fixture);
    let changes: [(&str, Change); 5] = [
        ("promoted", |f| {
            f.st.workspaces
                .set_member_role("boss", &f.wid, "ann", "manager")
                .unwrap();
        }),
        ("registers a device", |f| {
            f.st.workspaces
                .register_legacy_device(
                    "ann",
                    &json!({"machineId":"anns-box","name":"A","os":"linux","agentVersion":"1"}),
                )
                .unwrap();
        }),
        ("joins another team", |f| {
            f.st.workspaces
                .create_organization("eve", "Third", "eve")
                .unwrap();
            let third = f.st.workspaces.workspaces("eve").unwrap();
            let third = third.iter().find(|w| w["name"] == "Third").unwrap()["workspaceId"]
                .as_str()
                .unwrap()
                .to_string();
            f.st.workspaces.with_conn_for_tests(|c| {
                c.execute(
                    "INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?1,'ann','member',1)",
                    [&third],
                )
                .unwrap();
            });
        }),
        ("removed from the workspace", |f| {
            f.st.workspaces
                .remove_member("boss", &f.wid, "ann")
                .unwrap();
        }),
        ("becomes an administrator", |f| {
            f.st.workspaces.set_always_active(["ann".to_string()]);
        }),
    ];
    for (what, change) in changes {
        let f = fixture();
        let token = minted_session(&f, "ann", "j").await;
        let hash = crate::workspace::hash_token(&token);
        assert!(
            f.st.workspaces.authenticate(&token).unwrap().is_some(),
            "{what}: valid at first"
        );
        assert!(f.st.workspaces.session_alive(&hash).unwrap());
        change(&f);
        assert!(
            f.st.workspaces.authenticate(&token).unwrap().is_none(),
            "{what}: void"
        );
        let left: i64 = f.st.workspaces.with_conn_for_tests(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM auth_sessions WHERE user_id='ann'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(left, 0, "{what}: and gone");
        cleanup(&f.db);
    }
    // The open socket goes the same way: `session_alive` is what the hub asks.
    let f = fixture();
    let token = minted_session(&f, "ann", "k").await;
    f.st.workspaces
        .set_member_role("boss", &f.wid, "ann", "manager")
        .unwrap();
    assert!(!f
        .st
        .workspaces
        .session_alive(&crate::workspace::hash_token(&token))
        .unwrap());
    cleanup(&f.db);
}

/// Voiding is permanent: undoing the change before anybody checks does not
/// bring the session back (the database voids it in the same statement).
#[tokio::test]
async fn a_voided_service_session_stays_void_when_the_change_is_undone() {
    let f = fixture();
    let c = |sql: &str| {
        f.st.workspaces.with_conn_for_tests(|c| {
            c.execute(sql, []).unwrap();
        })
    };
    // Promoted, then demoted again.
    let token = minted_session(&f, "ann", "a").await;
    c("UPDATE memberships SET role='manager' WHERE user_id='ann'");
    c("UPDATE memberships SET role='member' WHERE user_id='ann'");
    assert!(f.st.workspaces.authenticate(&token).unwrap().is_none());
    // Removed from the team, then put back.
    let token = minted_session(&f, "ann", "b").await;
    let wid = f.wid.clone();
    c(&format!(
        "DELETE FROM memberships WHERE user_id='ann' AND workspace_id='{wid}'"
    ));
    c(&format!("INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES('{wid}','ann','member',1)"));
    assert!(f.st.workspaces.authenticate(&token).unwrap().is_none());
    // Given a machine, which is then revoked.
    let token = minted_session(&f, "ann", "c").await;
    f.st.workspaces
        .register_legacy_device(
            "ann",
            &json!({"machineId":"anns-box","name":"A","os":"linux","agentVersion":"1"}),
        )
        .unwrap();
    c("UPDATE devices SET revoked_at=1 WHERE machine_id='anns-box'");
    assert!(f.st.workspaces.authenticate(&token).unwrap().is_none());
    // An ordinary session of the same person is not touched by any of it.
    let own = f.st.workspaces.create_auth_session("ann", 1).unwrap();
    c("UPDATE memberships SET role='manager' WHERE user_id='ann'");
    assert!(f.st.workspaces.authenticate(&own).unwrap().is_some());
    cleanup(&f.db);
}

/// The "plain member" verdict is re-taken inside the transaction that issues
/// the session: a change that lands between the preliminary lookup and the
/// issue yields no session (and the audit says so), not one that a later undo
/// of the change could bring back to life.
#[tokio::test]
async fn the_session_is_issued_only_if_the_member_is_still_plain_at_that_moment() {
    let f = fixture();
    // The caller believed ann plain; then she is promoted before the issue.
    f.st.workspaces
        .set_member_role("boss", &f.wid, "ann", "manager")
        .unwrap();
    let issued =
        f.st.workspaces
            .consume_service_signin("legal", "race", "ann", &f.wid, "issued", true)
            .unwrap();
    assert!(issued.is_none(), "no session for someone no longer plain");
    f.st.workspaces
        .set_member_role("boss", &f.wid, "ann", "member")
        .unwrap();
    let count: i64 = f.st.workspaces.with_conn_for_tests(|c| {
        c.query_row(
            "SELECT COUNT(*) FROM auth_sessions WHERE user_id='ann'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    });
    assert_eq!(count, 0, "and nothing to come back after an undo");
    assert_eq!(
        audit_outcomes(&f).last().map(String::as_str),
        Some("login_required")
    );
    // Still plain: issued as usual.
    let ok =
        f.st.workspaces
            .consume_service_signin("legal", "fine", "ann", &f.wid, "issued", true)
            .unwrap();
    assert!(ok.is_some());
    cleanup(&f.db);
}

/// The ACL change is enforced before the agent is asked for the folder.
#[test]
fn a_put_refreshes_the_hub_before_the_folder_is_made() {
    // Structural: the refresh is sent from the handler before `make_dir`.
    let src = include_str!("service_api.rs");
    let put = &src[src
        .find("pub(crate) async fn api_service_put_share")
        .unwrap()..];
    let refresh = put.find("HubCmd::RefreshWorkspaceState").unwrap();
    let mkdir = put.find("make_dir(&st").unwrap();
    assert!(refresh < mkdir, "refresh must precede the awaited mkdir");
}

// ----------------------------------------------------------- UI pass tokens

const LEGAL_ORIGIN: &str = "https://legal.acme.test";

/// The `legal` key admits UI passes for `LEGAL_ORIGIN` (absent by default).
fn enable_ui_passes(f: &mut Fixture) {
    let mut keys = (**f.st.service_keys.as_ref().unwrap()).clone();
    keys.iter_mut()
        .find(|k| k.name == "legal")
        .unwrap()
        .ui_origins = vec![LEGAL_ORIGIN.to_string()];
    f.st.service_keys = Some(Arc::new(keys));
}

async fn mint(st: &AppState, key: Option<&str>, body: Value) -> (StatusCode, Value, HeaderMap) {
    let res = api_service_ui_token(
        State(st.clone()),
        bearer(key),
        Bytes::from(body.to_string()),
    )
    .await;
    read(res).await
}

fn origin_headers(origin: Option<&str>) -> HeaderMap {
    let mut h = HeaderMap::new();
    if let Some(o) = origin {
        h.insert(header::ORIGIN, HeaderValue::from_str(o).unwrap());
    }
    h
}

fn pass_params(token: &str) -> std::collections::HashMap<String, String> {
    [("token".to_string(), token.to_string())].into()
}

/// What `ui_pass_access` answered, as a status for a refusal.
fn pass_verdict(
    f: &Fixture,
    token: &str,
    origin: Option<&str>,
) -> Result<Option<crate::workspace::UiAccess>, StatusCode> {
    match crate::ws_api::ui_pass_access(&pass_params(token), &origin_headers(origin), &f.st) {
        Ok(v) => Ok(v.map(|(access, _)| access)),
        Err(res) => Err(res.status()),
    }
}

#[tokio::test]
async fn a_ui_token_is_minted_for_workspace_members_only() {
    let mut f = fixture();
    let body = json!({"userId":"ann"});
    // The key carries no uiOrigins: no UI passes at all.
    let (status, v, _) = mint(&f.st, Some(KEY), body.clone()).await;
    assert_eq!(
        (status, v["error"].as_str()),
        (StatusCode::FORBIDDEN, Some("ui_tokens_disabled"))
    );
    enable_ui_passes(&mut f);
    assert_eq!(
        mint(&f.st, None, body.clone()).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        mint(&f.st, Some("wrong"), body.clone()).await.0,
        StatusCode::UNAUTHORIZED
    );
    // The other workspace's key has no origins either.
    assert_eq!(
        mint(&f.st, Some("other-key-0123456789abcdef"), body.clone())
            .await
            .0,
        StatusCode::FORBIDDEN
    );

    let (status, v, headers) = mint(&f.st, Some(KEY), body).await;
    assert_eq!(status, StatusCode::OK, "{v}");
    let token = v["token"].as_str().unwrap().to_string();
    assert!(token.len() >= 32);
    assert_eq!(v["wsUrl"], "ws://127.0.0.1:4319/ui");
    assert_eq!(v["workspaceId"], f.wid.as_str());
    assert_eq!(v["machineIds"], json!(["legal-box"]));
    let ttl = v["expiresAt"].as_i64().unwrap() - crate::workspace::now_ms();
    assert!(
        (11 * 3600 * 1000..=12 * 3600 * 1000).contains(&ttl),
        "{ttl}"
    );
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");

    // One row, marked, with the issuer and workspace; only the hash is stored.
    let (scope, issuer, ws, hash, created, expires): (String, String, String, String, i64, i64) =
        f.st.workspaces.with_conn_for_tests(|c| {
            c.query_row(
                "SELECT ui_scope,service_issuer,service_workspace_id,token_hash,created_at,expires_at FROM auth_sessions WHERE user_id='ann'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .unwrap()
        });
    assert_eq!(
        (scope.as_str(), issuer.as_str(), ws.as_str()),
        ("service-ui", "legal", f.wid.as_str())
    );
    assert_ne!(hash, token);
    assert_eq!(expires - created, 12 * 3600 * 1000);
    // Audited without the token.
    let (n, meta): (i64, String) = f.st.workspaces.with_conn_for_tests(|c| {
        c.query_row(
            "SELECT COUNT(*),COALESCE(MAX(metadata_json),'') FROM audit_events WHERE action='auth.service_ui_token' AND target_id='ann'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    });
    assert_eq!(n, 1);
    assert!(!meta.contains(&token));

    // The firm's owner (and device owner) is a member too.
    assert_eq!(
        mint(&f.st, Some(KEY), json!({"userId":"boss"})).await.0,
        StatusCode::OK
    );
    // Not in the workspace, waitlisted, unknown: refused.
    // Machine codes, as agreed with the integration.
    let code = |(status, v, _): (StatusCode, Value, HeaderMap)| {
        (status, v["error"].as_str().unwrap_or("").to_string())
    };
    for who in ["cat", "ghost"] {
        assert_eq!(
            code(mint(&f.st, Some(KEY), json!({"userId":who})).await),
            (StatusCode::BAD_REQUEST, "not_member".to_string()),
            "{who}"
        );
    }
    assert_eq!(
        code(mint(&f.st, Some(KEY), json!({"userId":"dan"})).await),
        (StatusCode::FORBIDDEN, "inactive".to_string())
    );
    f.st.workspaces
        .suspend_access("bob", "tests", None)
        .unwrap();
    assert_eq!(
        code(mint(&f.st, Some(KEY), json!({"userId":"bob"})).await),
        (StatusCode::FORBIDDEN, "inactive".to_string())
    );
    // A platform administrator is no longer refused (see
    // `a_platform_admin_and_the_bootstrap_user_get_a_scoped_ui_pass`): bob is
    // suspended, so he is still `inactive` — the administrator status changes
    // nothing either way.
    f.st.platform_admins = ["bob".to_string()].into();
    assert_eq!(
        code(mint(&f.st, Some(KEY), json!({"userId":"bob"})).await),
        (StatusCode::FORBIDDEN, "inactive".to_string())
    );
    assert_eq!(
        code(mint(&f.st, Some(KEY), json!({})).await),
        (StatusCode::BAD_REQUEST, "bad_request".to_string())
    );
    assert_eq!(
        code(mint(&f.st, Some("wrong"), json!({"userId":"ann"})).await),
        (StatusCode::UNAUTHORIZED, "unauthorized".to_string())
    );
    cleanup(&f.db);
}

#[tokio::test]
async fn a_person_keeps_at_most_twenty_live_ui_passes() {
    let mut f = fixture();
    enable_ui_passes(&mut f);
    let mut first = String::new();
    for i in 0..25 {
        let (status, v, _) = mint(&f.st, Some(KEY), json!({"userId":"ann"})).await;
        assert_eq!(status, StatusCode::OK);
        if i == 0 {
            first = v["token"].as_str().unwrap().to_string();
        }
    }
    let n: i64 = f.st.workspaces.with_conn_for_tests(|c| {
        c.query_row(
            "SELECT COUNT(*) FROM auth_sessions WHERE user_id='ann' AND ui_scope='service-ui'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    });
    assert_eq!(n, 20);
    assert!(f
        .st
        .workspaces
        .authenticate_ui_pass(&first)
        .unwrap()
        .is_none());
    cleanup(&f.db);
}

/// A pass is not a sign-in anywhere but `/ui`: not on the cookie, as a bearer,
/// or in `?token=` of anything that is not the pass check itself.
#[tokio::test]
async fn a_ui_pass_is_not_a_session_on_any_http_endpoint() {
    let mut f = fixture();
    enable_ui_passes(&mut f);
    let (_, v, _) = mint(&f.st, Some(KEY), json!({"userId":"ann"})).await;
    let token = v["token"].as_str().unwrap().to_string();
    assert!(f.st.workspaces.authenticate(&token).unwrap().is_none());
    assert!(f
        .st
        .workspaces
        .authenticate_ui_pass(&token)
        .unwrap()
        .is_some());

    let mut as_cookie = HeaderMap::new();
    as_cookie.insert(
        header::COOKIE,
        HeaderValue::from_str(&format!("cc-remote-auth={token}")).unwrap(),
    );
    let as_bearer = bearer(Some(&token));
    for headers in [&as_cookie, &as_bearer] {
        assert!(crate::authenticated_user(headers, &f.st).is_err());
        assert!(crate::mutation_user(headers, &f.st).is_err());
        let res = crate::workspace_api::api_me(State(f.st.clone()), headers.clone()).await;
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }
    // The ordinary `/ui` path does not take it either (`?token=`).
    assert!(crate::ui_user(&pass_params(&token), &HeaderMap::new(), &f.st).is_err());
    cleanup(&f.db);
}

#[tokio::test]
async fn a_ui_pass_opens_ui_only_from_the_keys_origin_and_inside_its_workspace() {
    let mut f = fixture();
    enable_ui_passes(&mut f);
    let (_, v, _) = mint(&f.st, Some(KEY), json!({"userId":"ann"})).await;
    let token = v["token"].as_str().unwrap().to_string();

    // Origin: the key's, exactly. None, another site, or the hub's own: 403.
    for origin in [
        None,
        Some("https://evil.example"),
        Some("https://legal.acme.test.evil.example"),
        Some("http://legal.acme.test"),
        Some("https://code.acme.test"),
        Some("http://127.0.0.1:4319"),
        Some("null"),
    ] {
        assert_eq!(
            pass_verdict(&f, &token, origin).err(),
            Some(StatusCode::FORBIDDEN),
            "{origin:?}"
        );
    }
    let access = pass_verdict(&f, &token, Some(LEGAL_ORIGIN))
        .ok()
        .flatten()
        .expect("the key's own origin is let in");
    let scope = access.ui_scope.clone().expect("scoped");
    assert_eq!(
        (scope.issuer.as_str(), scope.workspace_id.as_str()),
        ("legal", f.wid.as_str())
    );
    assert_eq!(scope.machine_ids, vec!["legal-box".to_string()]);
    assert_eq!(scope.root_prefix, PREFIX);
    assert_eq!(access.workspace_id, f.wid);
    assert_eq!(
        access.viewer["workspaces"].as_array().map(Vec::len),
        Some(1)
    );

    // A wrong token is not a pass; a workspaceId in the query changes nothing.
    assert!(matches!(
        pass_verdict(&f, "not-a-token", Some(LEGAL_ORIGIN)),
        Ok(None)
    ));
    let mut params = pass_params(&token);
    params.insert("workspaceId".into(), "someone-elses".into());
    let kept = crate::ws_api::ui_pass_access(&params, &origin_headers(Some(LEGAL_ORIGIN)), &f.st)
        .ok()
        .flatten()
        .unwrap()
        .0;
    assert_eq!(kept.workspace_id, f.wid);
    // The cookie is never a pass.
    let mut cookie = origin_headers(Some(LEGAL_ORIGIN));
    cookie.insert(
        header::COOKIE,
        HeaderValue::from_str(&format!("cc-remote-auth={token}")).unwrap(),
    );
    assert!(matches!(
        crate::ws_api::ui_pass_access(&Default::default(), &cookie, &f.st),
        Ok(None)
    ));
    // …but a bearer is (a native test client).
    let mut as_bearer = origin_headers(Some(LEGAL_ORIGIN));
    as_bearer.insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
    );
    assert!(matches!(
        crate::ws_api::ui_pass_access(&Default::default(), &as_bearer, &f.st),
        Ok(Some(_))
    ));

    // A key whose origins were withdrawn since: the pass is dead.
    let mut keys = (**f.st.service_keys.as_ref().unwrap()).clone();
    keys.iter_mut()
        .find(|k| k.name == "legal")
        .unwrap()
        .ui_origins
        .clear();
    let before = f.st.service_keys.clone();
    f.st.service_keys = Some(Arc::new(keys));
    assert_eq!(
        pass_verdict(&f, &token, Some(LEGAL_ORIGIN)).err(),
        Some(StatusCode::UNAUTHORIZED)
    );
    f.st.service_keys = before;

    // An administrator since the mint: the pass still holds, narrowed, with
    // no administrator flag on the viewer.
    let prior = f.st.platform_admins.clone();
    f.st.platform_admins = ["ann".to_string()].into();
    let access = pass_verdict(&f, &token, Some(LEGAL_ORIGIN))
        .unwrap()
        .expect("an administrator's pass holds");
    assert!(access.ui_scope.is_some());
    assert_eq!(access.viewer["platformAdmin"], false);
    f.st.platform_admins = prior;
    // Suspended since the mint: void, and the row goes.
    f.st.workspaces
        .suspend_access("ann", "tests", None)
        .unwrap();
    assert!(matches!(
        pass_verdict(&f, &token, Some(LEGAL_ORIGIN)),
        Ok(None)
    ));
    let left: i64 = f.st.workspaces.with_conn_for_tests(|c| {
        c.query_row(
            "SELECT COUNT(*) FROM auth_sessions WHERE user_id='ann'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    });
    assert_eq!(left, 0);
    cleanup(&f.db);
}

/// Owner decision: a platform administrator and the bootstrap user MAY hold a
/// scoped UI pass. The connection is narrowed all the same and carries no
/// administrator flag; the sign-in (a full session) still refuses them.
#[tokio::test]
async fn a_platform_admin_and_the_bootstrap_user_get_a_scoped_ui_pass() {
    let mut f = fixture();
    enable_ui_passes(&mut f);
    let boot = f.st.bootstrap_user_id.clone();
    f.st.workspaces
        .ensure_user(&boot, "admin@x", Some("Admin"))
        .unwrap();
    f.st.workspaces.activate_access(&boot, "tests").unwrap();
    let wid = f.wid.clone();
    f.st.workspaces.with_conn_for_tests(|c| {
        c.execute(
            "INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?1,?2,'member',0)",
            rusqlite::params![wid, boot],
        )
        .unwrap();
    });
    f.st.platform_admins = ["ann".to_string()].into();
    f.st.workspaces
        .set_always_active(["ann".to_string(), boot.clone()]);
    for who in ["ann", boot.as_str()] {
        let (status, v, _) = mint(&f.st, Some(KEY), json!({"userId":who})).await;
        assert_eq!(status, StatusCode::OK, "{who}: {v}");
        let token = v["token"].as_str().unwrap();
        let access = pass_verdict(&f, token, Some(LEGAL_ORIGIN))
            .unwrap()
            .unwrap_or_else(|| panic!("{who}: a pass"));
        assert!(access.ui_scope.is_some(), "{who}: scoped");
        assert_eq!(access.viewer["platformAdmin"], false, "{who}");
        assert_eq!(
            access.viewer["workspaces"].as_array().map(Vec::len),
            Some(1)
        );
    }
    // The sign-in issues a FULL session: administrators stay refused there.
    for (i, who) in ["ann", boot.as_str()].into_iter().enumerate() {
        let (status, _) = signin(
            &f.st,
            &token_with(SECRET, claims(who, &format!("adm{i}"), None)),
        )
        .await;
        assert!(
            status == StatusCode::FORBIDDEN || status == StatusCode::FOUND,
            "{who}: {status}"
        );
    }
    let full: i64 = f.st.workspaces.with_conn_for_tests(|c| {
        c.query_row(
            "SELECT COUNT(*) FROM auth_sessions WHERE ui_scope IS NULL AND service_workspace_id IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap()
    });
    assert_eq!(
        full, 0,
        "service-signin minted no full session for an admin"
    );
    cleanup(&f.db);
}

#[tokio::test]
async fn a_ui_pass_ends_with_its_expiry_and_with_the_membership() {
    let mut f = fixture();
    enable_ui_passes(&mut f);
    // Expired: not a pass (it does not slide either).
    let (_, v, _) = mint(&f.st, Some(KEY), json!({"userId":"ann"})).await;
    let expired = v["token"].as_str().unwrap().to_string();
    f.st.workspaces.with_conn_for_tests(|c| {
        c.execute(
            "UPDATE auth_sessions SET expires_at=?1 WHERE user_id='ann'",
            [crate::workspace::now_ms() - 1],
        )
        .unwrap();
    });
    assert!(matches!(
        pass_verdict(&f, &expired, Some(LEGAL_ORIGIN)),
        Ok(None)
    ));
    // Using a pass never extends it.
    let (_, v, _) = mint(&f.st, Some(KEY), json!({"userId":"bob"})).await;
    let token = v["token"].as_str().unwrap().to_string();
    let before: i64 = f.st.workspaces.with_conn_for_tests(|c| {
        c.query_row(
            "SELECT expires_at FROM auth_sessions WHERE user_id='bob'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    });
    let hash = crate::workspace::hash_ui_pass(&token);
    assert!(f.st.workspaces.session_alive(&hash).unwrap());
    assert!(pass_verdict(&f, &token, Some(LEGAL_ORIGIN))
        .unwrap()
        .is_some());
    let after: i64 = f.st.workspaces.with_conn_for_tests(|c| {
        c.query_row(
            "SELECT expires_at FROM auth_sessions WHERE user_id='bob'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    });
    assert_eq!(before, after);
    // Removed from the workspace: the pass is gone.
    f.st.workspaces
        .remove_member("boss", &f.wid, "bob")
        .unwrap();
    assert!(!f.st.workspaces.session_alive(&hash).unwrap());
    assert!(matches!(
        pass_verdict(&f, &token, Some(LEGAL_ORIGIN)),
        Ok(None)
    ));
    cleanup(&f.db);
}

/// The fence at the access layer: the workspace owner and the device owner see
/// only the restricted shares they are LISTED on, under the prefix, on the
/// key's machines — and a nested unlisted share stays closed.
#[tokio::test]
async fn a_scoped_access_is_the_listed_shares_under_the_prefix_and_nothing_else() {
    let mut f = fixture();
    enable_ui_passes(&mut f);
    let scope = f.st.service_keys.as_ref().unwrap()[0].ui_scope();
    for (root, who) in [
        ("/srv/legal/projects/a", "ann"),
        ("/srv/legal/projects/b", "bob"),
        ("/srv/legal/projects/a/inner", "bob"),
    ] {
        let (status, v) = put(
            &f.st,
            Some(KEY),
            body(root, json!([{"userId":who,"role":"lead"}])),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{v}");
    }
    // A restricted share OUTSIDE the prefix, ann on its list.
    f.st.workspaces.with_conn_for_tests(|c| {
        c.execute(
            "INSERT INTO project_shares(project_share_id,workspace_id,machine_id,owner_user_id,root,name,created_at,access,restricted) VALUES('outside',?1,'legal-box','boss','/srv/other/z','Z',1,'control',1)",
            [&f.wid],
        )
        .unwrap();
        c.execute(
            "INSERT INTO project_share_members VALUES('outside','ann','lead',1)",
            [],
        )
        .unwrap();
    });
    let access = |who: &str, scope: &crate::workspace::UiScope| {
        f.st.workspaces
            .ui_access(who, Some(&f.wid), false)
            .unwrap()
            .with_scope(scope.clone())
    };
    let ann =
        f.st.workspaces
            .machine_access(&access("ann", &scope), "legal-box")
            .unwrap();
    assert!(ann.can_view && ann.can_start && !ann.can_control);
    assert!(ann.allows_path("/srv/legal/projects/a/x"));
    assert!(ann.allows_start_path("/srv/legal/projects/a/x"));
    assert!(
        !ann.allows_path("/srv/legal/projects/a/inner/x"),
        "a nested list she is not on stays closed"
    );
    assert!(!ann.allows_path("/srv/legal/projects/b/x"));
    assert!(!ann.allows_path("/srv/other/z/x"), "outside the prefix");
    assert!(!ann.allows_path("/srv/legal/projects"));
    // The workspace owner AND device owner: only what the lists name — nothing.
    let boss =
        f.st.workspaces
            .machine_access(&access("boss", &scope), "legal-box")
            .unwrap();
    assert!(!boss.can_view && !boss.can_start && !boss.can_control);
    assert!(!boss.allows_path("/srv/legal/projects/a/x"));
    assert!(
        f.st.workspaces
            .machine_access(
                &f.st
                    .workspaces
                    .ui_access("boss", Some(&f.wid), false)
                    .unwrap(),
                "legal-box"
            )
            .unwrap()
            .can_control,
        "without the pass the device owner still controls the box"
    );
    // A machine the key does not name, and another workspace's scope.
    let mut elsewhere = scope.clone();
    elsewhere.machine_ids = vec!["other-box".into()];
    assert!(
        !f.st
            .workspaces
            .machine_access(&access("ann", &elsewhere), "legal-box")
            .unwrap()
            .can_view
    );
    let mut other_ws = scope.clone();
    other_ws.workspace_id = "another".into();
    assert!(
        !f.st
            .workspaces
            .machine_access(&access("ann", &other_ws), "legal-box")
            .unwrap()
            .can_view
    );
    cleanup(&f.db);
}

#[test]
fn ui_origins_are_exact_origins_or_dropped() {
    let mut e = entry("legal", "w", "m", KEY, SECRET);
    e["uiOrigins"] = json!([
        "https://legal.acme.test/",
        "HTTPS://Legal2.Acme.test",
        "https://*.acme.test",
        "https://legal.acme.test/path",
        "legal.acme.test",
        "ftp://x",
        "https://user@legal.acme.test",
        ""
    ]);
    let keys = parse_service_keys(&json!([e]).to_string());
    assert_eq!(
        keys[0].ui_origins,
        vec![
            "https://legal.acme.test".to_string(),
            "https://legal2.acme.test".to_string()
        ]
    );
    // Absent = none.
    let keys = parse_service_keys(&json!([entry("legal", "w", "m", KEY, SECRET)]).to_string());
    assert!(keys[0].ui_origins.is_empty());
    assert!(!keys[0].ui_origin_allowed(Some("https://legal.acme.test")));
}

/// Additive: an old `auth_sessions` gains `ui_scope`, every existing row keeps
/// NULL (an ordinary session), and a second start touches nothing.
#[test]
fn the_ui_scope_column_is_added_without_touching_existing_sessions() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT, label TEXT, created_at INTEGER);
         INSERT INTO auth_sessions VALUES('old','ann','Chrome',1);",
    )
    .unwrap();
    for _ in 0..2 {
        crate::workspace::migrate_ui_scope_column(&conn).unwrap();
    }
    let scope: Option<String> = conn
        .query_row(
            "SELECT ui_scope FROM auth_sessions WHERE token_hash='old'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(scope, None);
}

/// A key's name is its identity (it labels what it mints and a UI pass is
/// resolved back to its key by it): a second entry with the same name is
/// dropped, the first stays.
#[test]
fn a_second_key_with_the_same_name_is_dropped() {
    let mut narrow = entry("legal", "w", "m1", KEY, SECRET);
    narrow["rootPrefix"] = json!("/srv/legal/projects/narrow");
    let broad = entry(
        "legal",
        "w",
        "m2",
        "other-key-0123456789abcdef",
        "other-secret-0123456789-0123456789-x",
    );
    let keys = parse_service_keys(&json!([narrow, broad]).to_string());
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0].machine_ids, vec!["m1".to_string()]);
}

/// The triggers that void a service SIGN-IN when its person is promoted, gets a
/// machine or joins another team do not touch a UI pass (its rule is wider —
/// any role, any other team); only leaving the workspace ends it. Re-created on
/// every start, so a database that has the earlier unqualified triggers is
/// corrected by `init`.
#[tokio::test]
async fn a_ui_pass_survives_promotion_a_device_and_another_team_but_not_removal() {
    type Change = fn(&Fixture);
    let changes: [(&str, Change); 3] = [
        ("promoted", |f| {
            f.st.workspaces
                .set_member_role("boss", &f.wid, "ann", "manager")
                .unwrap();
        }),
        ("registers a device", |f| {
            f.st.workspaces
                .register_legacy_device(
                    "ann",
                    &json!({"machineId":"anns-box","name":"A","os":"linux","agentVersion":"1"}),
                )
                .unwrap();
        }),
        ("joins another team", |f| {
            f.st.workspaces
                .create_organization("eve", "Third", "eve")
                .unwrap();
            let third = f.st.workspaces.workspaces("eve").unwrap();
            let third = third.iter().find(|w| w["name"] == "Third").unwrap()["workspaceId"]
                .as_str()
                .unwrap()
                .to_string();
            f.st.workspaces.with_conn_for_tests(|c| {
                c.execute(
                    "INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?1,'ann','member',1)",
                    [&third],
                )
                .unwrap();
            });
        }),
    ];
    for (what, change) in changes {
        let mut f = fixture();
        enable_ui_passes(&mut f);
        let (_, v, _) = mint(&f.st, Some(KEY), json!({"userId":"ann"})).await;
        let token = v["token"].as_str().unwrap().to_string();
        // …and an ordinary service sign-in of the same person, which the same
        // change DOES void.
        let session = minted_session(&f, "ann", "j").await;
        change(&f);
        assert!(
            f.st.workspaces
                .authenticate_ui_pass(&token)
                .unwrap()
                .is_some(),
            "{what}: the pass holds"
        );
        assert!(
            f.st.workspaces.authenticate(&session).unwrap().is_none(),
            "{what}: the sign-in is void"
        );
        cleanup(&f.db);
    }
    let mut f = fixture();
    enable_ui_passes(&mut f);
    let (_, v, _) = mint(&f.st, Some(KEY), json!({"userId":"ann"})).await;
    let token = v["token"].as_str().unwrap().to_string();
    f.st.workspaces
        .remove_member("boss", &f.wid, "ann")
        .unwrap();
    assert!(f
        .st
        .workspaces
        .authenticate_ui_pass(&token)
        .unwrap()
        .is_none());
    cleanup(&f.db);
}

/// `/api/logout` does not authenticate — it ends the session whose token it is
/// handed — so a pass, which every other HTTP endpoint refuses, can still be
/// ended by whoever holds it (the page's «выйти»). Answers `revoked:true`.
#[tokio::test]
async fn a_ui_pass_can_end_itself_through_logout() {
    let mut f = fixture();
    enable_ui_passes(&mut f);
    let (_, v, _) = mint(&f.st, Some(KEY), json!({"userId":"ann"})).await;
    let token = v["token"].as_str().unwrap().to_string();
    assert!(f
        .st
        .workspaces
        .authenticate_ui_pass(&token)
        .unwrap()
        .is_some());

    let res = crate::workspace_api::api_logout(State(f.st.clone()), bearer(Some(&token))).await;
    let (status, body, _) = read(res).await;
    assert_eq!(
        (status, body["revoked"].clone()),
        (StatusCode::OK, json!(true))
    );
    assert!(f
        .st
        .workspaces
        .authenticate_ui_pass(&token)
        .unwrap()
        .is_none());
    // The second time there is nothing left to end.
    let res = crate::workspace_api::api_logout(State(f.st.clone()), bearer(Some(&token))).await;
    assert_eq!(read(res).await.1["revoked"], json!(false));
    cleanup(&f.db);
}
