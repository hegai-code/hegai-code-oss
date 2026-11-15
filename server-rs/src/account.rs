//! Compatibility endpoint for existing Android/web clients. All clients now
//! enter the same durable erasure queue; a 202 never claims external cleanup
//! has completed. Legacy clients cannot confirm an ownership transfer, so they
//! keep the existing team_has_members refusal and can transfer manually first.
use super::*;
use axum::body::Bytes;

pub(crate) async fn api_account_delete(
    State(st): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let user = gate!(mutation_user(&headers, &st));
    let body = serde_json::from_slice::<Value>(&body).unwrap_or(Value::Null);
    if body["confirm"] != "DELETE" {
        return api_error(StatusCode::BAD_REQUEST, "confirmation required");
    }
    if user == st.bootstrap_user_id || st.platform_admins.contains(&user) {
        return (StatusCode::CONFLICT, Json(json!({"code":"privileged_account","error":"Передайте полномочия администратора перед удалением аккаунта."}))).into_response();
    }
    let preview = match st.workspaces.deletion_preview(&user) {
        Ok(v) => v,
        Err(e) => return store_failure(e),
    };
    if preview["transfers"]
        .as_array()
        .is_some_and(|v| !v.is_empty())
    {
        let teams = preview["transfers"].as_array().unwrap();
        let names: Vec<&str> = teams.iter().filter_map(|v| v["name"].as_str()).collect();
        return (StatusCode::CONFLICT, Json(json!({"code":"team_has_members","teams":teams,"error":format!("Передайте владение командой ({}) перед удалением аккаунта.", names.join(", "))}))).into_response();
    }
    let receipt = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let cookie = auth_cookie_token(&headers).is_some();
    let secure = st.public_url.starts_with("https://");
    let mut response = crate::account_deletion_api::request(
        State(st),
        headers,
        Json(json!({"userId":user,"confirm":"DELETE","transfers":[],"receipt":receipt})),
    )
    .await;
    if cookie && response.status().is_success() {
        for cleared in clear_auth_cookies(secure) {
            response.headers_mut().append(header::SET_COOKIE, cleared);
        }
    }
    response
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    const OWNER: &str = "owner";
    const USER: &str = "u1";
    const MACHINE: &str = "m-u1";

    /// A store where `u1` has a row in every table that can name them, plus
    /// the platform owner and a teammate whose rows must survive.
    fn populated() -> WorkspaceStore {
        let store = WorkspaceStore::open_memory();
        store.with_conn_for_tests(|c| c.execute_batch(crate::replica::SCHEMA).unwrap());
        store.ensure_user(OWNER, "owner@example.com", None).unwrap();
        store.activate_access(OWNER, "tests").unwrap();
        store
            .ensure_user(USER, "U1@example.com", Some("U One"))
            .unwrap();
        store.activate_access(USER, "tests").unwrap();
        store.ensure_user("mate", "mate@example.com", None).unwrap();
        store.create_auth_session(USER, 30).unwrap();
        store.create_enrollment(USER).unwrap();
        store
            .register_legacy_device(
                USER,
                &json!({"machineId": MACHINE, "name": "Box", "os": "linux", "agentVersion": "t"}),
            )
            .unwrap();
        store.with_conn_for_tests(|c| {
            c.execute_batch(&format!(
                r#"
                INSERT INTO workspaces(workspace_id,name,kind,owner_user_id,created_at) VALUES('org-owner','Owner team','organization','{OWNER}',1);
                INSERT INTO memberships VALUES('org-owner','{OWNER}','owner',1);
                INSERT INTO memberships VALUES('org-owner','{USER}','manager',1);
                INSERT INTO workspaces(workspace_id,name,kind,owner_user_id,created_at) VALUES('org-solo','Solo','organization','{USER}',1);
                INSERT INTO memberships VALUES('org-solo','{USER}','owner',1);
                INSERT INTO invitations(invitation_id,workspace_id,email,role,token_hash,created_by,created_at,expires_at,accepted_by,accepted_at) VALUES('inv-1','org-owner','u1@example.com','member','th1','{OWNER}',1,9999999999999,'{USER}',2);
                INSERT INTO invitations(invitation_id,workspace_id,email,role,token_hash,created_by,created_at,expires_at,accepted_by,accepted_at) VALUES('inv-2','org-solo','x@example.com','member','th2','{USER}',1,9999999999999,NULL,NULL);
                INSERT INTO invitations(invitation_id,workspace_id,email,role,token_hash,created_by,created_at,expires_at,accepted_by,accepted_at) VALUES('inv-3','org-owner','mate@example.com','member','th3','{OWNER}',1,9999999999999,NULL,NULL);
                INSERT INTO manager_assignments VALUES('org-owner','{USER}','member','mate',1);
                INSERT INTO manager_assignments VALUES('org-owner','{OWNER}','member','{USER}',1);
                INSERT INTO audit_events VALUES('a1','org-owner','{OWNER}','invitation.created','invitation','inv-1','{{"email":"u1@example.com","role":"member"}}',1);
                INSERT INTO audit_events VALUES('a2','org-solo','{USER}','x','y','z','{{}}',1);
                INSERT INTO signin_links(jti_hash,user_id,used_at) VALUES('jti','{USER}',1);
                INSERT INTO identities(provider,subject,user_id,created_at) VALUES('telegram','777','{USER}',1);
                INSERT INTO telegram_logins(poll_hash,code_hash,match_code,choices,client,created_at,expires_at,telegram_id,user_id)
                  VALUES('p1','c1','12','[]','android',1,2,'777','{USER}');
                INSERT INTO telegram_logins(poll_hash,code_hash,match_code,choices,client,created_at,expires_at,link_user_id)
                  VALUES('p2','c2','12','[]','android',1,2,'{USER}');
                INSERT INTO telegram_logins(poll_hash,code_hash,match_code,choices,client,created_at,expires_at,telegram_id)
                  VALUES('p3','c3','12','[]','android',1,2,'777');
                INSERT INTO enrollment_requests(poll_hash,user_code_hash,machine_json,created_at,expires_at,approved_by)
                  VALUES('rq1','uc1','{{}}',1,2,'{USER}');
                INSERT INTO enrollment_requests(poll_hash,user_code_hash,machine_json,created_at,expires_at,machine_id)
                  VALUES('rq2','uc2','{{}}',1,2,'{MACHINE}');
                INSERT INTO provision_jobs(job_id,user_id,kind,status,created_at) VALUES('j1','{USER}','sandbox_create','done',1);
                INSERT INTO access_preauth(email,created_by,created_at,claimed_by) VALUES('u1@example.com','{OWNER}',1,'{USER}');
                INSERT INTO device_credentials VALUES('cred1','{MACHINE}','dth1',1,NULL);
                INSERT INTO project_shares(project_share_id,workspace_id,machine_id,owner_user_id,root,name,created_at)
                  VALUES('ps1','org-owner','{MACHINE}','{USER}','/r','r',1);
                INSERT INTO memories(memory_id,owner_user_id,scope,path,content,content_sha256,created_at,updated_at)
                  VALUES('mem1','{USER}','fleet','a.md','x','h',1,1);
                INSERT INTO session_owners(machine_id,session_id,owner_user_id,created_at) VALUES('{MACHINE}','s1','{USER}',1);
                INSERT INTO session_owners(machine_id,session_id,owner_user_id,created_at) VALUES('other-box','s2','{USER}',1);
                INSERT INTO session_owners(machine_id,session_id,owner_user_id,created_at) VALUES('other-box','s3','mate',1);
                INSERT INTO machines VALUES('{MACHINE}','{{}}',1);
                INSERT INTO sessions(machine_id,source,session_id,summary_json) VALUES('{MACHINE}','claude','s1','{{}}');
                INSERT INTO session_messages VALUES('{MACHINE}','claude','s1','g',0,'{{}}');
                INSERT INTO machines VALUES('other-box','{{}}',1);
                INSERT INTO sessions(machine_id,source,session_id,summary_json) VALUES('other-box','claude','s2','{{}}');
                UPDATE user_access SET sandbox_status='ready',sandbox_slug='u1',sandbox_host='h1',sandbox_machine_id='{MACHINE}' WHERE user_id='{USER}';
                "#
            ))
            .unwrap()
        });
        store
    }

    // ---------------------------------------------------------------- HTTP

    /// A full `AppState` over `workspaces` with a live hub on `db`; the HTTP
    /// tests of other handlers (`workspace_api`, `main`) reuse it.
    pub(crate) fn app_state(workspaces: WorkspaceStore, db: &std::path::Path) -> AppState {
        AppState {
            hub: spawn_hub(db, workspaces.clone(), OWNER.into(), Default::default()),
            token: "fleet-token-for-tests".into(),
            fleet_ui: false,
            native_sso_states: Default::default(),
            sso_jti: Default::default(),
            android_auth: Default::default(),
            apple_auth: None,
            google_auth: None,
            github_auth: None,
            github_grant: None,
            oidc_auth: None,
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
            sandbox_erasure_only: false,
            provision_hosts: Default::default(),
            seat_inflight: Default::default(),
            llm_quota_file: None,
            access_link_secret: None,
            signin_link_secret: None,
            tg_login: None,
            review_login: None,
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

    async fn call(st: &AppState, bearer: Option<&str>, body: &str) -> (StatusCode, Value) {
        let mut headers = HeaderMap::new();
        if let Some(token) = bearer {
            headers.insert(
                header::AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
            );
        }
        let res =
            api_account_delete(State(st.clone()), headers, Bytes::from(body.to_string())).await;
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 16)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    pub(crate) fn temp_db() -> std::path::PathBuf {
        std::env::temp_dir().join(format!("cc-remote-account-{}.sqlite3", Uuid::new_v4()))
    }

    pub(crate) fn cleanup(db: &std::path::Path) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", db.display()));
        }
    }

    #[tokio::test]
    async fn http_deletes_a_waitlisted_account_and_its_token_dies() {
        let store = WorkspaceStore::open_memory();
        store.ensure_user(OWNER, "owner@example.com", None).unwrap();
        store.ensure_user("w1", "w1@example.com", None).unwrap();
        let token = store.create_auth_session("w1", 30).unwrap();
        let db = temp_db();
        let st = app_state(store.clone(), &db);
        let (status, body) = call(&st, Some(&token), r#"{"confirm":"DELETE"}"#).await;
        assert_eq!(status, StatusCode::ACCEPTED, "{body}");
        assert_eq!(body["status"], "pending");
        assert_eq!(body["receipt"].as_str().unwrap().len(), 64);
        assert!(store.authenticate(&token).unwrap().is_none());
        let (status, _) = call(&st, Some(&token), r#"{"confirm":"DELETE"}"#).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        cleanup(&db);
    }

    #[tokio::test]
    async fn http_refuses_anonymous_unconfirmed_owner_and_team_owner() {
        let store = populated();
        store.with_conn_for_tests(|c| {
            c.execute_batch("INSERT INTO memberships VALUES('org-solo','mate','member',1);")
                .unwrap()
        });
        let user_token = store.create_auth_session(USER, 30).unwrap();
        let owner_token = store.create_auth_session(OWNER, 30).unwrap();
        let db = temp_db();
        let st = app_state(store.clone(), &db);

        let (status, _) = call(&st, None, r#"{"confirm":"DELETE"}"#).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _) = call(&st, Some("not-a-session"), r#"{"confirm":"DELETE"}"#).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        for body in ["", "{}", r#"{"confirm":"delete"}"#, "not json"] {
            let (status, _) = call(&st, Some(&user_token), body).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "body {body:?}");
        }

        let (status, body) = call(&st, Some(&owner_token), r#"{"confirm":"DELETE"}"#).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["code"], "privileged_account");

        let (status, body) = call(&st, Some(&user_token), r#"{"confirm":"DELETE"}"#).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["code"], "team_has_members");
        assert!(body["error"].as_str().unwrap().contains("Solo"));
        assert!(store.authenticate(&user_token).unwrap().is_some());
        cleanup(&db);
    }

    #[tokio::test]
    async fn http_refuses_a_cross_site_cookie_request() {
        let store = WorkspaceStore::open_memory();
        store.ensure_user(OWNER, "owner@example.com", None).unwrap();
        store.ensure_user("w1", "w1@example.com", None).unwrap();
        let token = store.create_auth_session("w1", 30).unwrap();
        let db = temp_db();
        let st = app_state(store.clone(), &db);
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("{AUTH_COOKIE}={token}")).unwrap(),
        );
        headers.insert("sec-fetch-site", HeaderValue::from_static("cross-site"));
        let res = api_account_delete(
            State(st.clone()),
            headers,
            Bytes::from(r#"{"confirm":"DELETE"}"#),
        )
        .await;
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
        assert!(store.authenticate(&token).unwrap().is_some());
        cleanup(&db);
    }
}
