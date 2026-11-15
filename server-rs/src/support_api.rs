//! HTTP side of support access (`support_access.rs` holds the rules).
//!
//! Owner endpoints: open / list / revoke a grant and read what support did.
//! The sign-in the link leads to, and the middleware that writes every
//! mutation of a support account to the audit log.

use super::*;
use crate::support_access::{is_support_user, support_forbidden};

const LOGIN_ATTEMPTS_PER_HOUR: usize = 30;

fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn status_for(error: &str) -> StatusCode {
    if error.contains("not found") {
        StatusCode::NOT_FOUND
    } else if error.contains("access denied") || error.contains("insufficient") {
        StatusCode::FORBIDDEN
    } else {
        StatusCode::BAD_REQUEST
    }
}

/// `POST /api/workspaces/{id}/support-grants` `{hours, role, note?}`.
/// The link is in this answer and nowhere else.
pub(crate) async fn api_support_grant_create(
    AxumPath(workspace_id): AxumPath<String>,
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let actor = gate!(mutation_user(&headers, &st));
    gate!(require_active(&st, &actor));
    let Some(hours) = body.get("hours").and_then(Value::as_i64) else {
        return api_error(StatusCode::BAD_REQUEST, "hours is required");
    };
    let role = body.get("role").and_then(Value::as_str).unwrap_or("member");
    let note = body.get("note").and_then(Value::as_str);
    match st
        .workspaces
        .create_support_grant(&actor, &workspace_id, hours, role, note)
    {
        Ok((grant, token)) => {
            st.hub.send(HubCmd::RefreshWorkspaceState);
            let link = format!(
                "{}/support-login#token={token}",
                st.public_url.trim_end_matches('/')
            );
            no_store(
                (
                    StatusCode::CREATED,
                    Json(json!({"grant": grant, "link": link})),
                )
                    .into_response(),
            )
        }
        Err(error) => refusal(status_for(&error), error),
    }
}

/// `GET /api/workspaces/{id}/support-grants`.
pub(crate) async fn api_support_grants(
    AxumPath(workspace_id): AxumPath<String>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let actor = gate!(authenticated_user(&headers, &st));
    match st.workspaces.list_support_grants(&actor, &workspace_id) {
        Ok(grants) => no_store(Json(json!({"grants": grants})).into_response()),
        Err(error) => refusal(status_for(&error), error),
    }
}

/// `POST /api/workspaces/{id}/support-grants/{grant}/revoke`.
pub(crate) async fn api_support_grant_revoke(
    AxumPath((workspace_id, grant_id)): AxumPath<(String, String)>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let actor = gate!(mutation_user(&headers, &st));
    gate!(require_active(&st, &actor));
    match st
        .workspaces
        .revoke_support_grant(&actor, &workspace_id, &grant_id)
    {
        Ok(grant) => {
            // The sessions are gone; the hub closes the sockets they held now,
            // not at the next tick, and the team list loses the account.
            st.hub.send(HubCmd::SweepUiPasses);
            st.hub.send(HubCmd::RefreshWorkspaceState);
            Json(json!({"grant": grant})).into_response()
        }
        Err(error) => refusal(status_for(&error), error),
    }
}

/// `GET /api/workspaces/{id}/support-grants/{grant}/log[?before=<createdAt>]`:
/// newest first, at most 1000 per call; `total` counts them all.
pub(crate) async fn api_support_grant_log(
    AxumPath((workspace_id, grant_id)): AxumPath<(String, String)>,
    Query(params): Query<HashMap<String, String>>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let actor = gate!(authenticated_user(&headers, &st));
    let before = params.get("before").and_then(|b| b.parse::<i64>().ok());
    match st
        .workspaces
        .support_grant_log(&actor, &workspace_id, &grant_id, before)
    {
        Ok((events, total)) => {
            no_store(Json(json!({"events": events, "total": total})).into_response())
        }
        Err(error) => refusal(status_for(&error), error),
    }
}

/// `POST /api/auth/support-login` `{token}`: spend the link's token and sign
/// the support account in until the grant ends. The token travels in the URL
/// FRAGMENT (never sent to a server, a proxy or a log) and the page posts it
/// here, so a link preview bot cannot spend it by fetching the URL.
pub(crate) async fn api_support_login(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !same_origin(&headers) {
        return api_error(StatusCode::FORBIDDEN, "cross-site request rejected");
    }
    let quota_key = match check_window_quota(
        &st,
        &format!(
            "support-login:{}",
            crate::rate_window::rate_ip(client_ip(&headers).as_deref())
                .as_deref()
                .unwrap_or("?")
        ),
        LOGIN_ATTEMPTS_PER_HOUR,
        60 * 60 * 1000,
        "too many attempts from this address",
    ) {
        Ok(key) => key,
        Err(response) => return response,
    };
    let token = body.get("token").and_then(Value::as_str).unwrap_or("");
    // Counted whether or not it works: guessing is what the window is for.
    record_window_hit(&st, &quota_key, 60 * 60 * 1000);
    if token.is_empty() || token.len() > 256 {
        return api_error(StatusCode::UNAUTHORIZED, "invalid, used or expired link");
    }
    let login = match st.workspaces.consume_support_login(token) {
        Ok(login) => login,
        Err(error) if error == "invalid_link" => {
            return api_error(StatusCode::UNAUTHORIZED, "invalid, used or expired link")
        }
        Err(error) => return store_failure(error),
    };
    let max_age = ((login.expires_at - now_ms()) / 1000).max(1);
    let mut response =
        no_store(Json(json!({"ok": true, "expiresAt": login.expires_at})).into_response());
    response.headers_mut().append(
        header::SET_COOKIE,
        set_cookie_header(
            AUTH_COOKIE,
            &login.session,
            max_age,
            st.public_url.starts_with("https://"),
        ),
    );
    response
}

/// What the middleware does with a request after `trace_support_request`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SupportHttp {
    /// Not a support account (or not a mutation): carry on untouched.
    Pass,
    /// A support account asked for something it may not: answer 403.
    Refuse,
    /// The trace could not be written, so nothing may run: answer 503.
    Unlogged,
    /// A support account's mutation, now in the log: carry on.
    Logged,
}

/// The decision behind the middleware, apart from axum so it can be tested.
/// For everybody else: a method compare and, while no grant is open at all,
/// one read lock — no SQLite, no token hashing.
///
/// Written BEFORE the handler runs, so the trace exists even if the handler
/// ends the session, panics or hangs. The query string is never recorded (it
/// may carry a token); bodies never are. Routes that would leave something
/// behind after the grant ends are refused (`support_forbidden`) — the refusal
/// is logged too.
pub(crate) fn trace_support_request(
    store: &WorkspaceStore,
    headers: &HeaderMap,
    method: &Method,
    path: &str,
) -> SupportHttp {
    if matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) || !store.support_any() {
        return SupportHttp::Pass;
    }
    let user = [auth_cookie_token(headers), bearer_token(headers)]
        .into_iter()
        .flatten()
        .find_map(|token| store.support_user_of_token(&token))
        .filter(|u| is_support_user(u));
    let Some(user) = user else {
        return SupportHttp::Pass;
    };
    let path: String = path.chars().take(500).collect();
    let forbidden = support_forbidden(&path);
    if store
        .audit_support(
            &user,
            "support.http",
            "http",
            &path,
            &json!({"method": method.as_str(), "path": path, "refused": forbidden}),
        )
        .is_err()
    {
        return SupportHttp::Unlogged;
    }
    if forbidden {
        SupportHttp::Refuse
    } else {
        SupportHttp::Logged
    }
}

/// Every mutation of a support account, in the owner's log. Placed over the
/// whole router.
pub(crate) async fn audit_support_http(
    State(st): State<AppState>,
    req: Request,
    next: Next,
) -> Response {
    if trace_support_request(
        &st.workspaces,
        req.headers(),
        req.method(),
        req.uri().path(),
    ) == SupportHttp::Refuse
    {
        return api_error(
            StatusCode::FORBIDDEN,
            "this action is not available to a support account",
        );
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn team() -> (WorkspaceStore, String) {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("boss", "boss@x", Some("Boss")).unwrap();
        let w = s.create_organization("boss", "Team", "boss").unwrap();
        (s, w["workspaceId"].as_str().unwrap().to_string())
    }

    fn cookie(session: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("{AUTH_COOKIE}={session}")).unwrap(),
        );
        h
    }

    fn rows(s: &WorkspaceStore, action: &str) -> i64 {
        s.with_conn_for_tests(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM audit_events WHERE action=?1",
                [action],
                |r| r.get(0),
            )
            .unwrap()
        })
    }

    #[test]
    fn a_support_mutation_is_logged_and_a_normal_one_is_not() {
        let (s, wid) = team();
        let boss_session = s.create_auth_session("boss", 7).unwrap();
        // No grant open: nothing is looked at.
        assert_eq!(
            trace_support_request(&s, &cookie(&boss_session), &Method::POST, "/api/x"),
            SupportHttp::Pass
        );
        let (grant, token) = s
            .create_support_grant("boss", &wid, 2, "manager", None)
            .unwrap();
        let login = s.consume_support_login(&token).unwrap();
        let support = cookie(&login.session);
        // A read is not logged; a mutation is, with method and path only.
        assert_eq!(
            trace_support_request(&s, &support, &Method::GET, "/api/me"),
            SupportHttp::Pass
        );
        assert_eq!(rows(&s, "support.http"), 0);
        assert_eq!(
            trace_support_request(&s, &support, &Method::POST, "/api/workspaces/w/projects"),
            SupportHttp::Logged
        );
        assert_eq!(rows(&s, "support.http"), 1);
        // The owner, with a grant open, still produces nothing.
        assert_eq!(
            trace_support_request(&s, &cookie(&boss_session), &Method::POST, "/api/x"),
            SupportHttp::Pass
        );
        assert_eq!(rows(&s, "support.http"), 1);
        let log = s
            .support_grant_log("boss", &wid, grant["grantId"].as_str().unwrap(), None)
            .unwrap()
            .0;
        let row = log.iter().find(|e| e["action"] == "support.http").unwrap();
        assert_eq!(row["metadata"]["method"], "POST");
        assert_eq!(row["metadata"]["path"], "/api/workspaces/w/projects");
        assert_eq!(row["actorName"], "Поддержка Hegai Code");
    }

    #[test]
    fn what_a_support_account_may_not_do_is_refused_and_still_logged() {
        let (s, wid) = team();
        let (_, token) = s
            .create_support_grant("boss", &wid, 2, "manager", None)
            .unwrap();
        let login = s.consume_support_login(&token).unwrap();
        for path in [
            "/api/enrollments",
            "/api/account/delete",
            "/api/me/identities/unlink",
            "/api/auth/google/link",
        ] {
            assert_eq!(
                trace_support_request(&s, &cookie(&login.session), &Method::POST, path),
                SupportHttp::Refuse,
                "{path}"
            );
        }
        assert_eq!(rows(&s, "support.http"), 4);
    }

    #[test]
    fn nothing_runs_when_the_trace_cannot_be_written() {
        let (s, wid) = team();
        let (_, token) = s
            .create_support_grant("boss", &wid, 2, "member", None)
            .unwrap();
        let login = s.consume_support_login(&token).unwrap();
        s.with_conn_for_tests(|c| {
            c.execute_batch("ALTER TABLE audit_events RENAME TO audit_gone")
                .unwrap();
        });
        assert_eq!(
            trace_support_request(&s, &cookie(&login.session), &Method::POST, "/api/x"),
            SupportHttp::Unlogged
        );
    }

    #[test]
    fn a_closed_grant_is_no_longer_traced() {
        let (s, wid) = team();
        let (grant, token) = s
            .create_support_grant("boss", &wid, 2, "member", None)
            .unwrap();
        let login = s.consume_support_login(&token).unwrap();
        s.revoke_support_grant("boss", &wid, grant["grantId"].as_str().unwrap())
            .unwrap();
        assert_eq!(
            trace_support_request(&s, &cookie(&login.session), &Method::POST, "/api/x"),
            SupportHttp::Pass
        );
        assert_eq!(rows(&s, "support.http"), 0);
    }
}
