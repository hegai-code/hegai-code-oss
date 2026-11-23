use super::*;

pub(crate) async fn preview(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let user = gate!(authenticated_user(&headers, &st));
    match st.workspaces.deletion_preview(&user) {
        Ok(v) => Json(v).into_response(),
        Err(e) => store_failure(e),
    }
}

pub(crate) async fn request(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let user = gate!(mutation_user(&headers, &st));
    // Like sign-out/leaving a team, deletion must remain available to suspended
    // and waitlisted people. It grants no product access and starts no AI work.
    if body["confirm"] != "DELETE" || body["userId"] != user {
        return api_error(
            StatusCode::BAD_REQUEST,
            "Подтвердите удаление текущего аккаунта.",
        );
    }
    let (reply, receive) = tokio::sync::oneshot::channel();
    st.hub.send(HubCmd::RequestAccountDeletion {
        user_id: user,
        transfers: body["transfers"].clone(),
        receipt: body["receipt"].as_str().unwrap_or_default().to_string(),
        reply,
    });
    match receive.await {
        Ok(Ok(receipt)) => (
            StatusCode::ACCEPTED,
            Json(json!({"status":"pending","receipt":receipt})),
        )
            .into_response(),
        Ok(Err(e)) => refusal(StatusCode::CONFLICT, e),
        Err(_) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Удаление недоступно. Повторите попытку.",
        ),
    }
}

/// Random receipt in a POST body, never an account id or credential in a URL.
pub(crate) async fn status(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let ip = rate_window::rate_ip(client_ip(&headers).as_deref());
    let key = match check_window_quota(
        &st,
        &format!("deletion-status:{}", ip.as_deref().unwrap_or("?")),
        60,
        60_000,
        "too many status requests",
    ) {
        Ok(key) => key,
        Err(response) => return response,
    };
    record_window_hit(&st, &key, 60_000);
    let receipt = body["receipt"].as_str().unwrap_or("");
    if receipt.len() != 64 || !receipt.bytes().all(|b| b.is_ascii_hexdigit()) {
        return api_error(StatusCode::NOT_FOUND, "receipt not found");
    }
    match st.workspaces.deletion_status(receipt) {
        Ok(Some(status)) => Json(json!({"status":status})).into_response(),
        Ok(None) => api_error(StatusCode::NOT_FOUND, "receipt not found"),
        Err(e) => store_failure(e),
    }
}

pub(crate) async fn reconcile(st: AppState) {
    loop {
        if let Ok(users) = st.workspaces.pending_deletions() {
            for user in users {
                if let Err(error) = process(&st, &user).await {
                    // No names, addresses, tokens or external response bodies.
                    eprintln!("[account-deletion] cleanup pending: {error}");
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(15)).await;
    }
}

async fn process(st: &AppState, user: &str) -> Result<(), &'static str> {
    {
        let mut inflight = st
            .seat_inflight
            .lock()
            .map_err(|_| "gateway operation lock")?;
        if !inflight.insert(user.to_string()) {
            return Ok(());
        }
    }
    let result = process_exclusive(st, user).await;
    st.seat_inflight
        .lock()
        .map_err(|_| "gateway operation lock")?
        .remove(user);
    result
}

async fn process_exclusive(st: &AppState, user: &str) -> Result<(), &'static str> {
    // Wait for an already-claimed create/resume to finish, then erase its result.
    if st
        .workspaces
        .has_provisioning_in_flight(user)
        .map_err(|_| "provisioning lookup")?
    {
        return Ok(());
    }
    let access = st
        .workspaces
        .access_state(user)
        .map_err(|_| "access lookup")?;
    if st.llmgw.is_none() && access.seat_status != "none" {
        return Err("gateway configuration required to verify erasure");
    }
    if !st
        .workspaces
        .ensure_sandbox_erasure(user)
        .map_err(|_| "sandbox erasure inventory")?
    {
        return Ok(());
    }
    if let (Some(gateway), Some(email)) = (&st.llmgw, st.workspaces.seat_key(user)) {
        if gateway
            .find_seat(&email)
            .await
            .map_err(|_| "gateway lookup")?
            .is_some()
        {
            gateway
                .erase_seat(&email)
                .await
                .map_err(|_| "gateway revocation")?;
        }
    }
    if !st
        .workspaces
        .apple_tokens(user)
        .map_err(|_| "Apple identity lookup")?
        .is_empty()
    {
        st.apple_auth
            .as_ref()
            .ok_or("Apple configuration required for revocation")?
            .revoke_account(&st.workspaces, user)
            .await?;
    }
    // The cloud browser keeps the person's live logins outside the hub's DB.
    crate::browser::erase_owner(st, user).await?;
    let (reply, receive) = tokio::sync::oneshot::channel();
    st.hub.send(HubCmd::EraseAccount {
        user_id: user.to_string(),
        reply,
    });
    receive
        .await
        .map_err(|_| "hub unavailable")?
        .map_err(|_| "database erasure")
}
