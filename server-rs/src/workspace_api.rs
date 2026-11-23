use super::*;

pub(crate) async fn api_me(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let user = gate!(authenticated_user(&headers, &st));
    let admin = st.platform_admins.contains(&user);
    match st.workspaces.ui_landing(&user, None, admin) {
        Ok(access) => Json(access.viewer).into_response(),
        Err(error) => store_failure(error),
    }
}

pub(crate) async fn api_logout(State(st): State<AppState>, headers: HeaderMap) -> Response {
    if !same_origin(&headers) {
        return api_error(StatusCode::FORBIDDEN, "cross-site request rejected");
    }
    // A browser signs out by its cookie. A native app holds its session as a
    // bearer token (`ccremote://auth?session=`, or a Telegram poll) and must
    // be able to end it here too: «Выйти» and «Это не я — выйти» on the phone
    // otherwise only forgot the token locally, leaving a 90-day session alive
    // on the hub.
    //
    // `logout` also ends a service UI pass presented as the bearer (a pass is
    // refused on every other HTTP endpoint, but holding the token is enough to
    // end it); the sockets riding it are closed now, not at the next tick.
    if let Some(token) = auth_cookie_token(&headers) {
        st.workspaces.logout(&token);
        st.hub.send(HubCmd::SweepUiPasses);
        // As revoke does: the sockets of the ended session close now.
        st.hub.send(HubCmd::RefreshWorkspaceState);
    } else if let Some(token) = bearer_token(&headers) {
        // The app needs to KNOW its session died — «Это не я — выйти» keeps
        // the way out on screen until it does — and a hub from before this
        // change answered a bearer logout with the same 204 while deleting
        // nothing. So a bearer gets an explicit answer the app requires.
        let revoked = st.workspaces.logout(&token);
        st.hub.send(HubCmd::SweepUiPasses);
        st.hub.send(HubCmd::RefreshWorkspaceState);
        return Json(json!({ "revoked": revoked })).into_response();
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    for cleared in clear_auth_cookies(st.public_url.starts_with("https://")) {
        response.headers_mut().append(header::SET_COOKIE, cleared);
    }
    response
}

/// The session the asking browser/app signed in with (its token hash), so the
/// list can mark «это устройство» and «выйти на остальных» can spare it.
/// The same token `authenticated_user` picked — the first LIVE one, not the
/// first present: a stale cookie beside a live bearer must not make
/// «выйти на остальных» end the caller's own session.
pub(crate) fn current_session(headers: &HeaderMap, st: &AppState) -> Option<String> {
    [auth_cookie_token(headers), bearer_token(headers)]
        .into_iter()
        .flatten()
        .find(|t| matches!(st.workspaces.authenticate(t), Ok(Some(_))))
        .map(|t| crate::workspace::hash_token(&t))
}

/// `GET /api/auth/sessions` — where I am signed in.
pub(crate) async fn api_sessions(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let user = gate!(authenticated_user(&headers, &st));
    let current = current_session(&headers, &st);
    match st.workspaces.list_sessions(&user) {
        Ok(mut sessions) => {
            for s in &mut sessions {
                let is_current = s["id"].as_str() == current.as_deref();
                s["current"] = json!(is_current);
            }
            Json(json!({ "sessions": sessions })).into_response()
        }
        Err(error) => store_failure(error),
    }
}

/// `POST /api/auth/sessions/revoke` `{id}` — end one sign-in (not
/// necessarily this one), and every socket it holds open.
///
/// Deliberately NOT behind `require_active`, like `api_logout`: ending your
/// own sessions only takes access away and starts no work (CLAUDE.md rule 5
/// is about what starts or drives work). A waitlisted or suspended person whose
/// token leaked must still be able to kill it.
pub(crate) async fn api_revoke_session(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let user = gate!(mutation_user(&headers, &st));
    let Some(id) = body
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| s.len() == 64)
    else {
        return api_error(StatusCode::BAD_REQUEST, "id required");
    };
    match st.workspaces.revoke_session(&user, id) {
        Ok(true) => {
            audit_self(&st, &user, "auth.session_revoked", id);
            st.hub.send(HubCmd::RefreshWorkspaceState);
            Json(json!({ "revoked": true })).into_response()
        }
        Ok(false) => api_error(StatusCode::NOT_FOUND, "no such session"),
        Err(error) => store_failure(error),
    }
}

/// `POST /api/auth/sessions/revoke-others` — «выйти на всех остальных
/// устройствах»: every sign-in but the one asking, sockets included.
///
/// Takes a JSON body on purpose: a request that needs `application/json` is
/// preflighted, so a plain `<form>` on a neighbouring `*.acme.test` page cannot
/// sign the person out everywhere with their cookie.
pub(crate) async fn api_revoke_other_sessions(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(_): Json<Value>,
) -> Response {
    let user = gate!(mutation_user(&headers, &st));
    let keep = current_session(&headers, &st);
    match st.workspaces.revoke_other_sessions(&user, keep.as_deref()) {
        Ok(n) => {
            audit_self(&st, &user, "auth.sessions_revoked", &n.to_string());
            st.hub.send(HubCmd::RefreshWorkspaceState);
            Json(json!({ "revoked": n })).into_response()
        }
        Err(error) => store_failure(error),
    }
}

/// An audit row about the person's own account, in their audit workspace.
fn audit_self(st: &AppState, user: &str, action: &str, target: &str) {
    if let Some(workspace_id) = st.workspaces.audit_workspace_for(user) {
        let _ = st
            .workspaces
            .audit(&workspace_id, user, action, "user", target, &json!({}));
    }
}

pub(crate) async fn api_create_workspace(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let actor = gate!(admin_mutation_user(&headers, &st));
    let name = body
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if name.is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "name required");
    }
    let owner = body
        .get("ownerUserId")
        .and_then(Value::as_str)
        .unwrap_or(&actor);
    match st.workspaces.create_organization(&actor, name, owner) {
        Ok(value) => (StatusCode::CREATED, Json(value)).into_response(),
        Err(error) => refusal(StatusCode::BAD_REQUEST, error),
    }
}

/// Self-serve team: any active user creates their own organization (capped,
/// slugged — see `create_organization_self`). The admin form above stays
/// for employees' teams.
pub(crate) async fn api_create_workspace_self(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let actor = gate!(mutation_user(&headers, &st));
    gate!(require_active(&st, &actor));
    let name = body.get("name").and_then(Value::as_str).unwrap_or("");
    match st.workspaces.create_organization_self(&actor, name) {
        Ok(value) => {
            st.hub.send(HubCmd::RefreshWorkspaceState);
            (StatusCode::CREATED, Json(value)).into_response()
        }
        Err(error) => refusal(StatusCode::BAD_REQUEST, error),
    }
}

pub(crate) async fn api_transfer_workspace(
    AxumPath(workspace_id): AxumPath<String>,
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let actor = gate!(mutation_user(&headers, &st));
    gate!(require_active(&st, &actor));
    let new_owner = body
        .get("newOwnerUserId")
        .and_then(Value::as_str)
        .unwrap_or("");
    if new_owner.is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "newOwnerUserId required");
    }
    match st
        .workspaces
        .transfer_ownership(&actor, &workspace_id, new_owner)
    {
        Ok(()) => {
            st.hub.send(HubCmd::RefreshWorkspaceState);
            StatusCode::NO_CONTENT.into_response()
        }
        Err(error) => refusal(StatusCode::BAD_REQUEST, error),
    }
}

/// Owner removes a member, or a member removes themselves (leave).
pub(crate) async fn api_remove_member(
    AxumPath((workspace_id, user_id)): AxumPath<(String, String)>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let actor = gate!(mutation_user(&headers, &st));
    // Leaving a team is allowed from the waiting screen too — a waitlisted
    // invitee who changes their mind should not be stuck in it.
    if actor != user_id {
        gate!(require_active(&st, &actor));
    }
    match st.workspaces.remove_member(&actor, &workspace_id, &user_id) {
        Ok(()) => {
            st.hub.send(HubCmd::RefreshWorkspaceState);
            StatusCode::NO_CONTENT.into_response()
        }
        Err(error) => refusal(StatusCode::BAD_REQUEST, error),
    }
}

/// `DELETE /api/workspaces/{id}` with an optional `{confirm: name}` body (or
/// `?confirm=` query) — required once other members are in the team. The body
/// is read by hand: a DELETE without one is normal and must not 415.
pub(crate) async fn api_delete_workspace(
    AxumPath(workspace_id): AxumPath<String>,
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
    body: axum::body::Bytes,
) -> Response {
    let actor = gate!(mutation_user(&headers, &st));
    gate!(require_active(&st, &actor));
    let from_body = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| v.get("confirm").and_then(Value::as_str).map(str::to_string));
    let confirm = from_body.or_else(|| params.get("confirm").cloned());
    match st
        .workspaces
        .delete_organization(&actor, &workspace_id, confirm.as_deref())
    {
        Ok(()) => {
            st.hub.send(HubCmd::RefreshWorkspaceState);
            StatusCode::NO_CONTENT.into_response()
        }
        Err(error) => refusal(StatusCode::BAD_REQUEST, error),
    }
}

pub(crate) async fn api_members(
    AxumPath(workspace_id): AxumPath<String>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let actor = gate!(authenticated_user(&headers, &st));
    match st.workspaces.members(&actor, &workspace_id) {
        Ok(value) => Json(json!({"members":value})).into_response(),
        Err(error) => refusal(StatusCode::FORBIDDEN, error),
    }
}

/// Where a Telegram-invited person signs in: the hub's login bot, or `None`
/// when Telegram sign-in is off on this hub.
fn telegram_invite_bot_url(bot: Option<&str>) -> Option<String> {
    bot.map(|b| format!("https://t.me/{b}"))
}

pub(crate) async fn api_invite(
    AxumPath(workspace_id): AxumPath<String>,
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let actor = gate!(mutation_user(&headers, &st));
    gate!(require_active(&st, &actor));
    // The session making the request, so the invitation is attributable to it.
    let session = current_session(&headers, &st);
    // A request that came with a session which is gone by now (ended between
    // the gate and here — e.g. by «Это был не я») must not leave an
    // unattributed invitation behind.
    if session.is_none()
        && (auth_cookie_token(&headers).is_some() || bearer_token(&headers).is_some())
    {
        return api_error(StatusCode::UNAUTHORIZED, "authentication required");
    }
    // An invitation by Telegram @username instead of an e-mail: no link, the
    // person signs in with the hub's Telegram bot and lands in the team.
    if let Some(username) = body.get("telegram").and_then(Value::as_str) {
        if !crate::edition::is_external() {
            return api_error(
                StatusCode::CONFLICT,
                "Приглашение по Telegram доступно только на своём сервере",
            );
        }
        let Some(bot_url) = telegram_invite_bot_url(st.tg_login.as_ref().map(|c| c.bot.as_str()))
        else {
            return api_error(
                StatusCode::CONFLICT,
                "На этом сервере не включён вход через Telegram",
            );
        };
        return match st.workspaces.invite_telegram_from(
            &actor,
            &workspace_id,
            username,
            body.get("role").and_then(Value::as_str).unwrap_or("member"),
            session.as_deref(),
        ) {
            Ok(mut value) => {
                value["botUrl"] = Value::String(bot_url);
                let mut response = (StatusCode::CREATED, Json(value)).into_response();
                response
                    .headers_mut()
                    .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
                response
            }
            Err(error) => refusal(StatusCode::BAD_REQUEST, error),
        };
    }
    let email = body.get("email").and_then(Value::as_str).unwrap_or("");
    if !crate::local_login::valid_email(&crate::workspace::normalize_email(email)) {
        return api_error(StatusCode::BAD_REQUEST, "invalid e-mail address");
    }
    match st.workspaces.invite_from(
        &actor,
        &workspace_id,
        email,
        body.get("role").and_then(Value::as_str).unwrap_or("member"),
        session.as_deref(),
    ) {
        Ok(mut value) => {
            // A hub whose people sign in locally (and has no OIDC to do it for
            // them): an invited address with no account gets one, and the link
            // to hand out is a setup link that carries the invitation. An
            // address that already has an account keeps the ordinary link.
            // Only a platform admin (on a self-hosted hub: its owner) may mint
            // accounts this way; anyone can make a team, so for them an
            // invitation stays an ordinary link.
            if crate::local_login::enabled()
                && st.oidc_auth.is_none()
                && st.platform_admins.contains(&actor)
            {
                let email = value["email"].as_str().unwrap_or("").to_string();
                let invitation = value["token"].as_str().unwrap_or("").to_string();
                let invitation_id = value["invitationId"].as_str().unwrap_or("").to_string();
                let protected: Vec<String> = st
                    .platform_admins
                    .iter()
                    .cloned()
                    .chain(std::iter::once(st.bootstrap_user_id.clone()))
                    .collect();
                match st
                    .workspaces
                    .local_invite_account(&workspace_id, &email, &actor, &protected)
                {
                    Ok(Some(user_id)) => {
                        match st.workspaces.local_invite_setup_url(
                            &user_id,
                            &email,
                            &invitation,
                            &invitation_id,
                            &st.public_url,
                        ) {
                            Ok(url) => value["setupUrl"] = Value::String(url),
                            Err(e) => return store_failure(e),
                        }
                    }
                    Ok(None) => {}
                    Err(e) => return store_failure(e),
                }
            }
            let mut response = (StatusCode::CREATED, Json(value)).into_response();
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        Err(error) => refusal(StatusCode::BAD_REQUEST, error),
    }
}

/// `POST /api/invitations/preview` `{token}` -> `{workspaceName, inviterName, email}`:
/// what the sign-in and setup pages say about an invitation before anyone is
/// signed in. The 256-bit token is the credential; every call counts against
/// the address.
pub(crate) async fn api_invitation_preview(
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ip = client_address(peer, &headers);
    let key = match check_window_quota(
        &st,
        &format!(
            "invite-preview:{}",
            crate::rate_window::rate_ip(Some(&ip))
                .as_deref()
                .unwrap_or("?")
        ),
        30,
        15 * 60 * 1000,
        "слишком много попыток, подождите несколько минут",
    ) {
        Ok(k) => k,
        Err(r) => return r,
    };
    record_window_hit(&st, &key, 15 * 60 * 1000);
    match st
        .workspaces
        .invitation_preview(body.get("token").and_then(Value::as_str).unwrap_or(""))
    {
        Ok(Some((workspace, inviter, email))) => {
            let mut response =
                Json(json!({"workspaceName":workspace,"inviterName":inviter,"email":email}))
                    .into_response();
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        Ok(None) => api_error(StatusCode::NOT_FOUND, "invalid or expired invitation"),
        Err(e) => store_failure(e),
    }
}

pub(crate) async fn api_accept_invitation(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let actor = gate!(mutation_user(&headers, &st));
    match st.workspaces.accept_invitation(
        &actor,
        body.get("token").and_then(Value::as_str).unwrap_or(""),
    ) {
        Ok((workspace_id, inviter)) => {
            // Accepting is what opens access for a waitlisted person — the
            // inviter vouched, the email matched. Nothing to do for someone
            // already active; the store says which.
            let activated = crate::access_api::activate_user_by_invitation(&st, &inviter, &actor);
            // A member who was already active (or whom the activation did not
            // reach) still gets a seat on a self-hosted hub with a gateway.
            crate::access_api::auto_seat_for_member(&st, &actor);
            Json(json!({"workspaceId":workspace_id, "activated": activated})).into_response()
        }
        Err(error) => refusal(StatusCode::BAD_REQUEST, error),
    }
}

pub(crate) async fn api_set_role(
    AxumPath((workspace_id, user_id)): AxumPath<(String, String)>,
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let actor = gate!(mutation_user(&headers, &st));
    gate!(require_active(&st, &actor));
    match st.workspaces.set_member_role(
        &actor,
        &workspace_id,
        &user_id,
        body.get("role").and_then(Value::as_str).unwrap_or(""),
    ) {
        Ok(()) => {
            st.hub.send(HubCmd::RefreshWorkspaceState);
            StatusCode::NO_CONTENT.into_response()
        }
        Err(error) => refusal(StatusCode::BAD_REQUEST, error),
    }
}

pub(crate) async fn api_assign_manager(
    AxumPath(workspace_id): AxumPath<String>,
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let actor = gate!(mutation_user(&headers, &st));
    gate!(require_active(&st, &actor));
    match st.workspaces.assign_manager(
        &actor,
        &workspace_id,
        body.get("managerUserId")
            .and_then(Value::as_str)
            .unwrap_or(""),
        body.get("targetKind").and_then(Value::as_str).unwrap_or(""),
        body.get("targetId").and_then(Value::as_str).unwrap_or(""),
    ) {
        Ok(()) => {
            st.hub.send(HubCmd::RefreshWorkspaceState);
            StatusCode::NO_CONTENT.into_response()
        }
        Err(error) => refusal(StatusCode::BAD_REQUEST, error),
    }
}

pub(crate) async fn api_projects(
    AxumPath(workspace_id): AxumPath<String>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let actor = gate!(authenticated_user(&headers, &st));
    match st.workspaces.projects(&actor, &workspace_id) {
        Ok(value) => Json(json!({"projects":value})).into_response(),
        Err(error) => refusal(StatusCode::FORBIDDEN, error),
    }
}

pub(crate) async fn api_share_project(
    AxumPath(workspace_id): AxumPath<String>,
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let actor = gate!(mutation_user(&headers, &st));
    gate!(require_active(&st, &actor));
    match st.workspaces.share_project(
        &actor,
        &workspace_id,
        body.get("machineId").and_then(Value::as_str).unwrap_or(""),
        body.get("root").and_then(Value::as_str).unwrap_or(""),
        body.get("name")
            .and_then(Value::as_str)
            .unwrap_or("Project"),
        body.get("access").and_then(Value::as_str).unwrap_or("view"),
        body.get("visibility")
            .and_then(Value::as_str)
            .unwrap_or("team"),
    ) {
        Ok(value) => {
            st.hub.send(HubCmd::RefreshWorkspaceState);
            (StatusCode::CREATED, Json(value)).into_response()
        }
        Err(error) if error == crate::workspace::PRIVATE_MACHINE_ERR => {
            refusal(StatusCode::CONFLICT, error)
        }
        Err(error) => refusal(StatusCode::BAD_REQUEST, error),
    }
}

pub(crate) async fn api_remove_project(
    AxumPath((workspace_id, share_id)): AxumPath<(String, String)>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let actor = gate!(mutation_user(&headers, &st));
    gate!(require_active(&st, &actor));
    match st
        .workspaces
        .remove_project(&actor, &workspace_id, &share_id)
    {
        Ok(()) => {
            st.hub.send(HubCmd::RefreshWorkspaceState);
            StatusCode::NO_CONTENT.into_response()
        }
        Err(error) => refusal(StatusCode::FORBIDDEN, error),
    }
}

pub(crate) async fn api_audit(
    AxumPath(workspace_id): AxumPath<String>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let actor = gate!(authenticated_user(&headers, &st));
    match st.workspaces.audit_events(&actor, &workspace_id) {
        Ok(value) => Json(json!({"events":value})).into_response(),
        Err(error) => refusal(StatusCode::FORBIDDEN, error),
    }
}

pub(crate) async fn api_create_enrollment(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let actor = gate!(mutation_user(&headers, &st));
    gate!(require_active(&st, &actor));
    match st.workspaces.create_enrollment(&actor) {
        Ok(value) => (StatusCode::CREATED, Json(value)).into_response(),
        Err(error) if error == crate::access::ENROLLMENT_RATE_ERR => {
            refusal(StatusCode::TOO_MANY_REQUESTS, error)
        }
        Err(error) => refusal(StatusCode::BAD_REQUEST, error),
    }
}

/// The machine's side of «connect this computer»: it has no credential, so
/// this is open — capped hub-wide in the store and per address here. The
/// answer is what the machine shows: a code, where to type it, a poll token.
pub(crate) async fn api_request_enrollment(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ip = client_ip(&headers);
    let quota_key = match check_window_quota(
        &st,
        &format!(
            "enroll-request:{}",
            crate::rate_window::rate_ip(ip.as_deref())
                .as_deref()
                .unwrap_or("?")
        ),
        ENROLL_REQUESTS_PER_HOUR,
        60 * 60 * 1000,
        "too many connection requests from this address",
    ) {
        Ok(key) => key,
        Err(r) => return r,
    };
    match st
        .workspaces
        .request_enrollment(body.get("machine").unwrap_or(&Value::Null), ip.as_deref())
    {
        Ok(v) => {
            record_window_hit(&st, &quota_key, 60 * 60 * 1000);
            let mut v = v;
            v["verifyUrl"] = json!(format!(
                "{}/link?c={}",
                st.public_url.trim_end_matches('/'),
                v["userCode"].as_str().unwrap_or("")
            ));
            (StatusCode::CREATED, Json(v)).into_response()
        }
        Err(e) => refusal(StatusCode::BAD_REQUEST, e),
    }
}

/// What `/link` shows before the person decides. Signed in and active, so a
/// code cannot be enumerated by strangers.
pub(crate) async fn api_enrollment_request_info(
    AxumPath(code): AxumPath<String>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let actor = gate!(authenticated_user(&headers, &st));
    gate!(require_active(&st, &actor));
    match st.workspaces.enrollment_request_info(&code) {
        Ok(Some(v)) => Json(v).into_response(),
        Ok(None) => api_error(StatusCode::NOT_FOUND, "код не найден"),
        Err(e) => store_failure(e),
    }
}

pub(crate) async fn api_approve_enrollment(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let actor = gate!(mutation_user(&headers, &st));
    gate!(require_active(&st, &actor));
    let code = body.get("userCode").and_then(Value::as_str).unwrap_or("");
    match st.workspaces.approve_enrollment_request(code, &actor) {
        Ok(v) => {
            st.hub.send(HubCmd::RefreshWorkspaceState);
            Json(v).into_response()
        }
        Err(e) => refusal(StatusCode::BAD_REQUEST, e),
    }
}

pub(crate) async fn api_deny_enrollment(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let actor = gate!(mutation_user(&headers, &st));
    gate!(require_active(&st, &actor));
    let code = body.get("userCode").and_then(Value::as_str).unwrap_or("");
    match st.workspaces.deny_enrollment_request(code, &actor) {
        Ok(denied) => Json(json!({"denied": denied})).into_response(),
        Err(e) => refusal(StatusCode::BAD_REQUEST, e),
    }
}

/// The machine asks. Open, like `request`, and rate-limited per address so a
/// tight loop cannot become load; the store hands the token out once.
pub(crate) async fn api_poll_enrollment(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ip = crate::rate_window::rate_ip(client_ip(&headers).as_deref());
    let quota_key = match check_window_quota(
        &st,
        &format!("enroll-poll:{}", ip.as_deref().unwrap_or("?")),
        ENROLL_POLLS_PER_MINUTE,
        60 * 1000,
        "slow_down",
    ) {
        Ok(key) => key,
        Err(r) => return r,
    };
    record_window_hit(&st, &quota_key, 60 * 1000);
    let token = body.get("pollToken").and_then(Value::as_str).unwrap_or("");
    match st.workspaces.poll_enrollment_request(token) {
        Ok(v) => Json(v).into_response(),
        Err(e) => store_failure(e),
    }
}

/// Requests to mint a code, per address per hour. A person installing on
/// three machines in a row fits; a scanner does not.
const ENROLL_REQUESTS_PER_HOUR: usize = 12;
/// Code exchanges per address per hour, failures included.
const ENROLL_EXCHANGES_PER_HOUR: usize = 60;
/// Polls per address per minute. One machine polls every 3 s = 20; a few
/// behind one NAT still fit, a loop with no sleep does not.
const ENROLL_POLLS_PER_MINUTE: usize = 90;

/// The client's address as nginx passes it (`X-Real-IP`, from the PROXY
/// protocol behind the relay). Absent on a bare dev hub.
pub(crate) fn client_ip(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-real-ip")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// A rolling window per client address for the open endpoints — see
/// `rate_window.rs` for why it is its own bounded map (and not the
/// backend-spec log it used to share). `Ok` carries the key to record under:
/// the caller counts the request with `record_window_hit` once it is real.
pub(crate) fn check_window_quota(
    st: &AppState,
    key: &str,
    limit: usize,
    window_ms: i64,
    why: &str,
) -> Result<String, Response> {
    let Ok(mut log) = st.window_log.lock() else {
        return Err(api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "rate limiter unavailable",
        ));
    };
    log.check(key, limit, window_ms, chrono_now_ms())
        .map_err(|()| refusal(StatusCode::TOO_MANY_REQUESTS, why))
}

pub(crate) fn record_window_hit(st: &AppState, key: &str, window_ms: i64) {
    if let Ok(mut log) = st.window_log.lock() {
        log.record(key, window_ms, chrono_now_ms());
    }
}

/// The quota key of a code exchange: the TRUSTED peer address (`client_address`:
/// the socket peer, or `X-Real-IP` only when the peer is our own proxy), never
/// a raw header a caller can vary to get a fresh bucket per try.
fn exchange_quota_key(peer: std::net::SocketAddr, headers: &HeaderMap) -> String {
    let ip = client_address(peer, headers);
    format!(
        "enroll-exchange:{}",
        crate::rate_window::rate_ip(Some(&ip))
            .as_deref()
            .unwrap_or("?")
    )
}

pub(crate) async fn api_exchange_enrollment(
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    // Open like `/request`, and a guessing surface for the 40-bit code: every
    // attempt, right or wrong, counts against the address.
    let quota_key = match check_window_quota(
        &st,
        &exchange_quota_key(peer, &headers),
        ENROLL_EXCHANGES_PER_HOUR,
        60 * 60 * 1000,
        "too many connection attempts from this address",
    ) {
        Ok(key) => key,
        Err(r) => return r,
    };
    record_window_hit(&st, &quota_key, 60 * 60 * 1000);
    match st.workspaces.exchange_enrollment(
        body.get("code").and_then(Value::as_str).unwrap_or(""),
        body.get("machine").unwrap_or(&Value::Null),
    ) {
        Ok(value) => {
            // A new machine changes what its owner may be (a service-minted
            // session is void the moment its person owns one): let the hub
            // re-derive every open socket now.
            st.hub.send(HubCmd::RefreshWorkspaceState);
            Json(value).into_response()
        }
        Err(error) => refusal(StatusCode::UNAUTHORIZED, error),
    }
}

/// File a backend change spec from a sandbox machine.
///
/// The people working in the sandbox can change their own project but not the
/// platform behind it. This is the other half of that arrangement: instead of
/// the boundary being a dead end, work that needs the backend is written up and
/// lands as a session on the backend machine, opened in plan mode and owned by
/// the machine's owner — who gets the push, reads the plan, and approves it with
/// the same button any plan is approved with.
///
/// Authenticated by the sandbox's own **device token**, not a user session: the
/// caller is an agent, not a person, and it already holds that credential. Note
/// that the token identifies the *machine* — on a shared sandbox every employee
/// files under the same device — so `filedBy` is context for a human reader, not
/// an authenticated identity, and is labelled as such in the audit row.
pub(crate) async fn api_backend_request(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let Some(cfg) = st.backend_requests.clone() else {
        return api_error(
            StatusCode::NOT_FOUND,
            "backend-spec intake is not configured on this hub",
        );
    };
    let Some(token) = bearer_token(&headers) else {
        return api_error(StatusCode::UNAUTHORIZED, "unauthorized");
    };
    let device = match st.workspaces.device_credential(&token) {
        Ok(Some(device)) => device,
        Ok(None) => return api_error(StatusCode::UNAUTHORIZED, "invalid device credential"),
        Err(error) => return store_failure(error),
    };
    if !cfg.source_machines.contains(&device.machine_id) {
        return api_error(
            StatusCode::FORBIDDEN,
            "this machine may not file backend specs",
        );
    }

    let title = body
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let spec = body
        .get("body")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if title.is_empty() || spec.is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "title and body are required");
    }
    // The whole spec becomes the session's first turn, so cap it at something a
    // first turn can carry. Anything longer is a document, not a request.
    if spec.len() > 32_000 {
        return api_error(
            StatusCode::BAD_REQUEST,
            "body is too long (max 32000 bytes)",
        );
    }
    let project = body
        .get("project")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let filed_by = body
        .get("filedBy")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    if let Err(error) = check_backend_request_quota(&st, &device.machine_id, cfg.daily_limit) {
        return error;
    }
    // Counted below, once a session actually exists. A spec that bounced off an
    // offline machine cost nothing and must not cost the filer their allowance
    // either — the cap is here to stop a loop opening a hundred sessions, and a
    // failed attempt opens none.

    // Everything the person approving needs to judge it, before the spec itself.
    let mut message = String::new();
    message.push_str(&format!("**{title}**\n\n"));
    if let Some(project) = project {
        message.push_str(&format!("Проект: `{project}`\n"));
    }
    if let Some(filed_by) = filed_by {
        message.push_str(&format!("Заявил: {filed_by} (со слов сессии)\n"));
    }
    message.push_str(&format!("Песочница: `{}`\n\n---\n\n", device.machine_id));
    message.push_str(spec);

    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    st.hub.send(HubCmd::SpawnForOwner {
        machine_id: cfg.target_machine.clone(),
        cwd: cfg.target_cwd.clone(),
        message,
        category: Some("tz".to_string()),
        // Proposed, never done unasked — the point of the whole exchange.
        permission_mode: Some("plan".to_string()),
        owner_user_id: device.user_id.clone(),
        owner_name: None,
        reply: reply_tx,
    });
    let run_id = match reply_rx.await {
        Ok(Ok(run_id)) => run_id,
        // The hub declines for reasons the filer can act on ("Machine is
        // offline"), so pass its words through rather than flattening them.
        Ok(Err(message)) => return refusal(StatusCode::SERVICE_UNAVAILABLE, message),
        Err(_) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, "hub is not responding"),
    };
    record_backend_request(&st, &device.machine_id);

    // Best-effort trail: the spec is already committed in the filer's repo, so a
    // failed audit write must not fail the request that already started a run.
    if let Some(workspace_id) = audit_workspace_for(&st, &device.user_id) {
        let _ = st.workspaces.audit(
            &workspace_id,
            &device.user_id,
            "backend_request.filed",
            "run",
            &run_id,
            &json!({
                "title": title,
                "project": project,
                "filedBySelfReported": filed_by,
                "machineId": device.machine_id,
                "targetMachineId": cfg.target_machine,
                "targetCwd": cfg.target_cwd,
            }),
        );
    }

    println!(
        "[hub] backend spec filed from {} -> run {run_id}: {title}",
        device.machine_id
    );
    Json(json!({
        "ok": true,
        "runId": run_id,
        "url": format!("{}/?run={run_id}", st.public_url.trim_end_matches('/')),
    }))
    .into_response()
}

/// Rolling 24h cap per source machine. Checked before the work, recorded after
/// it succeeds, so the two are separate calls.
fn check_backend_request_quota(
    st: &AppState,
    machine_id: &str,
    limit: usize,
) -> Result<(), Response> {
    let Ok(mut log) = st.backend_request_log.lock() else {
        // A poisoned lock must not become an open door.
        return Err(api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "rate limiter unavailable",
        ));
    };
    if backend_requests_in_window(&mut log, machine_id) >= limit {
        return Err(api_error(
            StatusCode::TOO_MANY_REQUESTS,
            format!("this machine has filed {limit} backend specs in the last 24h"),
        ));
    }
    Ok(())
}

fn record_backend_request(st: &AppState, machine_id: &str) {
    if let Ok(mut log) = st.backend_request_log.lock() {
        log.entry(machine_id.to_string())
            .or_default()
            .push(chrono_now_ms());
    }
}

/// Filings by this machine in the last 24h, dropping older entries as it counts
/// so the map does not grow without bound.
pub(crate) fn backend_requests_in_window(
    log: &mut HashMap<String, Vec<i64>>,
    machine_id: &str,
) -> usize {
    let cutoff = chrono_now_ms() - 24 * 60 * 60 * 1000;
    let entries = log.entry(machine_id.to_string()).or_default();
    entries.retain(|ts| *ts > cutoff);
    entries.len()
}

/// Workspace to record the audit row in: the organization the owner runs if
/// there is one (where teammates' work is visible), else their personal one.
/// The rule itself lives on the store so the hub and access_api share it.
pub(crate) fn audit_workspace_for(st: &AppState, user_id: &str) -> Option<String> {
    st.workspaces.audit_workspace_for(user_id)
}

pub(crate) fn chrono_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The per-account unlink lock. Entries are dropped once nobody holds them,
/// so the map stays as small as the number of unlinks in flight.
fn unlink_lock(user: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: std::sync::OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
        std::sync::OnceLock::new();
    let mut map = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    map.retain(|_, l| Arc::strong_count(l) > 1);
    map.entry(user.to_string()).or_default().clone()
}

/// Which ways in this hub can attach at all, so a client offers only those.
fn identity_providers(st: &AppState) -> Value {
    json!({
        "google": st.google_auth.is_some(),
        "apple": st.apple_auth.is_some(),
        "telegram": st.tg_login.is_some(),
    })
}

/// `GET /api/me/identities` — «Способы входа»: every way into the signed-in
/// account (`provider`, `subject`, `label`, `linkedAt`, `lastUsedAt`) and
/// which providers this hub can link.
pub(crate) async fn api_my_identities(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let user = gate!(authenticated_user(&headers, &st));
    match st.workspaces.identities(&user) {
        Ok(identities) => (
            [(header::CACHE_CONTROL, "no-store")],
            Json(json!({ "identities": identities, "available": identity_providers(&st) })),
        )
            .into_response(),
        Err(error) => store_failure(error),
    }
}

/// `POST /api/me/identities/unlink` `{provider, subject?}` — remove one way in
/// (or every identity of `provider` without `subject`). Never the last one:
/// an account nobody can open is lost, not protected. Apple's token is
/// revoked at Apple first; if Apple cannot confirm, nothing is unlinked.
///
/// Behind `require_active` like every other change to an account.
pub(crate) async fn api_unlink_identity(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let user = gate!(mutation_user(&headers, &st));
    gate!(require_active(&st, &user));
    let Some(provider) = body
        .get("provider")
        .and_then(Value::as_str)
        .filter(|p| matches!(*p, "hegai" | "google" | "apple" | "telegram"))
    else {
        return api_error(StatusCode::BAD_REQUEST, "provider required");
    };
    // Absent = every identity of the provider; anything present must be a
    // real subject — a `null` or "" must not widen the unlink.
    let subject = match body.get("subject") {
        None => None,
        Some(Value::String(s)) if !s.is_empty() => Some(s.as_str()),
        Some(_) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "subject must be a non-empty string",
            )
        }
    };
    // One Apple ID per request: one revocation, one row — a partial
    // revocation of several must not leave revoked ones listed as working.
    if provider == crate::identity::PROVIDER_APPLE && subject.is_none() {
        return api_error(StatusCode::BAD_REQUEST, "subject required for apple");
    }
    // The hub's owner is re-ensured through its HegAI identity at every
    // start (`ensure_user` for the bootstrap id); without it the hub would
    // not come up.
    if provider == crate::identity::PROVIDER_HEGAI && user == st.bootstrap_user_id {
        return api_error(StatusCode::CONFLICT, crate::identity::BOOTSTRAP_HEGAI);
    }
    #[track_caller]
    fn refused(code: String) -> Response {
        let status = match code.as_str() {
            crate::identity::NOT_LINKED => StatusCode::NOT_FOUND,
            crate::identity::LAST_IDENTITY | crate::identity::APPLE_TOKEN_CHANGED => {
                StatusCode::CONFLICT
            }
            _ => return store_failure(code),
        };
        refusal(status, code)
    }
    // One unlink at a time PER ACCOUNT: the last-identity check, Apple's
    // revocation and the delete must not interleave with another unlink of
    // the same account (two in parallel could each leave the other's as the
    // only way in, the Apple one already revoked). Other accounts never wait
    // on someone's call to Apple.
    let lock = unlink_lock(&user);
    let _serial = lock.lock().await;
    // Counted under the lock, so a burst cannot all read the old count.
    // A person removes ways in now and then; a script does not get to.
    let quota = match check_window_quota(
        &st,
        &format!("identity-unlink:{user}"),
        20,
        60 * 60 * 1000,
        "too many unlinks, try later",
    ) {
        Ok(key) => key,
        Err(response) => return response,
    };
    record_window_hit(&st, &quota, 60 * 60 * 1000);

    if let Err(code) = st.workspaces.check_unlink(&user, provider, subject) {
        return refused(code);
    }
    let mut revoked_apple = Vec::new();
    if provider == crate::identity::PROVIDER_APPLE {
        let tokens = match st.workspaces.apple_tokens_for(&user, subject) {
            Ok(v) => v,
            Err(e) => return store_failure(e),
        };
        if !tokens.is_empty() {
            let Some(apple) = st.apple_auth.as_ref() else {
                return api_error(StatusCode::SERVICE_UNAVAILABLE, "apple_revoke_unavailable");
            };
            if let Err(e) = apple.revoke_tokens(&tokens).await {
                eprintln!("[auth] Apple unlink for {user}: revocation failed: {e}");
                return api_error(StatusCode::BAD_GATEWAY, "apple_revoke_failed");
            }
        }
        revoked_apple = tokens;
    }
    match st
        .workspaces
        .unlink_identity(&user, provider, subject, &revoked_apple)
    {
        Ok(removed) => {
            println!(
                "[auth] {user} unlinked {} {provider} identit(y/ies)",
                removed.len()
            );
            st.hub.send(HubCmd::RefreshWorkspaceState);
            Json(json!({ "unlinked": removed.len() })).into_response()
        }
        Err(code) => refused(code),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::tests::{app_state, cleanup, temp_db};

    async fn set_role(
        st: &AppState,
        token: &str,
        workspace_id: &str,
        user_id: &str,
        role: &str,
    ) -> (StatusCode, Value) {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
        let res = api_set_role(
            AxumPath((workspace_id.to_string(), user_id.to_string())),
            State(st.clone()),
            headers,
            Json(json!({ "role": role })),
        )
        .await;
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 16)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    fn role_of(store: &WorkspaceStore, workspace_id: &str, user_id: &str) -> String {
        store.with_conn_for_tests(|c| {
            c.query_row(
                "SELECT role FROM memberships WHERE workspace_id=?1 AND user_id=?2",
                [workspace_id, user_id],
                |r| r.get(0),
            )
            .unwrap()
        })
    }

    /// `api_set_role` used to stop at `mutation_user`, so a suspended or
    /// waitlisted team owner could still re-assign roles. It now answers 403
    /// `access_not_active`; an active owner is unaffected.
    #[tokio::test]
    async fn set_role_requires_an_active_account() {
        let store = WorkspaceStore::open_memory();
        // `owner` is the bootstrap user in `app_state` and always passes the
        // gate, so the team owner under test is somebody else.
        store
            .ensure_user("owner", "owner@example.com", None)
            .unwrap();
        store.ensure_user("boss", "boss@example.com", None).unwrap();
        store.ensure_user("mate", "mate@example.com", None).unwrap();
        store.activate_access("boss", "tests").unwrap();
        let team = store.create_organization("boss", "Team", "boss").unwrap();
        let wid = team["workspaceId"].as_str().unwrap().to_string();
        store.with_conn_for_tests(|c| {
            c.execute(
                "INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?1,'mate','member',1)",
                [&wid],
            )
            .unwrap()
        });
        let token = store.create_auth_session("boss", 30).unwrap();
        let db = temp_db();
        let st = app_state(store.clone(), &db);

        // Active owner: the change goes through.
        let (status, body) = set_role(&st, &token, &wid, "mate", "manager").await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
        assert_eq!(role_of(&store, &wid, "mate"), "manager");

        // Suspended owner: refused with the access state, nothing changes.
        store.suspend_access("boss", "tests", None).unwrap();
        let (status, body) = set_role(&st, &token, &wid, "mate", "member").await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(body["error"], "access_not_active");
        assert_eq!(body["state"], "suspended");
        assert_eq!(role_of(&store, &wid, "mate"), "manager");
        cleanup(&db);
    }

    async fn invite(st: &AppState, token: &str, wid: &str, body: Value) -> (StatusCode, Value) {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
        let res = api_invite(
            AxumPath(wid.to_string()),
            State(st.clone()),
            headers,
            Json(body),
        )
        .await;
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 16)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// `with_edition` is thread-local, so the async body runs on this thread.
    #[test]
    fn invite_by_telegram_needs_telegram_login_and_a_valid_username() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        crate::edition::with_edition(crate::edition::Edition::External, || {
            rt.block_on(invite_by_telegram_body())
        });
        crate::edition::with_edition(crate::edition::Edition::Internal, || {
            rt.block_on(invite_by_telegram_internal_body())
        });
    }

    async fn invite_by_telegram_internal_body() {
        let store = WorkspaceStore::open_memory();
        store.ensure_user("boss", "boss@example.com", None).unwrap();
        store.activate_access("boss", "tests").unwrap();
        let team = store.create_organization("boss", "Team", "boss").unwrap();
        let wid = team["workspaceId"].as_str().unwrap().to_string();
        let token = store.create_auth_session("boss", 30).unwrap();
        let db = temp_db();
        let st = app_state(store.clone(), &db);
        let (status, body) = invite(&st, &token, &wid, json!({"telegram": "vasya_pupkin"})).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(
            body["error"],
            "Приглашение по Telegram доступно только на своём сервере"
        );
        let (status, _) = invite(&st, &token, &wid, json!({"email": "not-an-email"})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = invite(&st, &token, &wid, json!({"email": "tg-x@Users.Invalid"})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "synthetic seat domain");
        cleanup(&db);
    }

    async fn invite_by_telegram_body() {
        let store = WorkspaceStore::open_memory();
        store.ensure_user("boss", "boss@example.com", None).unwrap();
        store.activate_access("boss", "tests").unwrap();
        let team = store.create_organization("boss", "Team", "boss").unwrap();
        let wid = team["workspaceId"].as_str().unwrap().to_string();
        let token = store.create_auth_session("boss", 30).unwrap();
        let db = temp_db();
        let mut st = app_state(store.clone(), &db);

        // Telegram sign-in is off on this hub: 409 with the reason in Russian.
        let (status, body) = invite(&st, &token, &wid, json!({"telegram": "@Vasya_Pupkin"})).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(
            body["error"],
            "На этом сервере не включён вход через Telegram"
        );

        st.tg_login = Some(crate::telegram_login_api::TgLoginConfig {
            secret: "s".repeat(40),
            bot: "MyHubBot".into(),
        });
        let (status, body) = invite(&st, &token, &wid, json!({"telegram": "ab"})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        let (status, body) = invite(
            &st,
            &token,
            &wid,
            json!({"telegram": "@Vasya_Pupkin", "role": "member"}),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        assert_eq!(body["telegram"], "vasya_pupkin");
        assert_eq!(body["botUrl"], "https://t.me/MyHubBot");
        assert!(body.get("setupUrl").is_none() && body.get("token").is_none());
        let stored: (String, String) = store.with_conn_for_tests(|c| {
            c.query_row(
                "SELECT telegram_username,email FROM invitations WHERE invitation_id=?1",
                [body["invitationId"].as_str().unwrap()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap()
        });
        assert_eq!(stored, ("vasya_pupkin".to_string(), String::new()));
        cleanup(&db);
    }
}

#[cfg(test)]
mod exchange_quota_tests {
    use super::*;

    #[test]
    fn the_exchange_quota_follows_the_trusted_peer_not_a_spoofable_header() {
        let mut headers = HeaderMap::new();
        headers.insert("x-real-ip", HeaderValue::from_static("203.0.113.9"));
        // A direct caller (not our proxy) cannot pick its bucket.
        let direct: std::net::SocketAddr = "198.51.100.7:5555".parse().unwrap();
        assert_eq!(
            exchange_quota_key(direct, &headers),
            "enroll-exchange:198.51.100.7"
        );
        headers.insert("x-real-ip", HeaderValue::from_static("203.0.113.10"));
        assert_eq!(
            exchange_quota_key(direct, &headers),
            "enroll-exchange:198.51.100.7"
        );
        // Behind the loopback nginx the real client is the header's address.
        let proxy: std::net::SocketAddr = "127.0.0.1:40000".parse().unwrap();
        assert_eq!(
            exchange_quota_key(proxy, &headers),
            "enroll-exchange:203.0.113.10"
        );
    }
}
