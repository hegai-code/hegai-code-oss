//! HTTP surface of the community rollout: the platform-admin access tab and
//! the one user-facing call from the waiting screen. Store logic is in
//! `access.rs`; this file only parses, authorizes and sequences.

use super::*;

/// `GET /api/admin/access?state=&limit=&offset=` →
/// `{users:[AccessRow…], counts, pending:[PreauthorizedEmail…]}`. `pending`
/// ignores `state` and is always present: an address opened for someone who
/// has never signed in belongs to no list, and must not vanish from the page
/// that just added it.
pub(crate) async fn api_admin_access(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let actor = gate!(authenticated_user(&headers, &st));
    if !st.platform_admins.contains(&actor) {
        return api_error(StatusCode::FORBIDDEN, "platform admin required");
    }
    let state = params
        .get("state")
        .map(String::as_str)
        .filter(|s| matches!(*s, "waitlist" | "active" | "suspended"));
    let limit = params
        .get("limit")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(200)
        .clamp(1, 1000);
    let offset = params
        .get("offset")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    let users = match st.workspaces.access_rows(state, limit, offset) {
        Ok(rows) => rows,
        Err(error) => return store_failure(error),
    };
    let counts = match st.workspaces.access_counts() {
        Ok(counts) => counts,
        Err(error) => return store_failure(error),
    };
    let pending = match st.workspaces.pending_preauthorizations() {
        Ok(rows) => rows,
        Err(error) => return store_failure(error),
    };
    // Repository access still owed back for deleted accounts (tombstones).
    let revocations = st
        .workspaces
        .pending_github_revocations()
        .unwrap_or_default();
    Json(json!({"users": users, "counts": counts, "pending": pending, "githubRevocations": revocations}))
        .into_response()
}

/// `POST /api/admin/access/activate {userIds}` →
/// `{activated:[{userId,email}], skipped:[{userId, reason}]}`. Row buttons on
/// the access tab; opening the product for an ADDRESS is `grant` below, which
/// is the one path that also works for someone who has never signed in.
pub(crate) async fn api_admin_activate(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let actor = gate!(admin_mutation_user(&headers, &st));
    let targets: Vec<String> = string_list(body.get("userIds"));
    let mut skipped: Vec<Value> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut activated: Vec<Value> = Vec::new();
    for user_id in targets {
        if !seen.insert(user_id.clone()) {
            continue;
        }
        match activate_user(&st, &actor, &user_id) {
            Ok(entry) => activated.push(entry),
            Err(reason) => skipped.push(json!({"userId": user_id, "reason": reason})),
        }
    }
    Json(json!({"activated": activated, "skipped": skipped})).into_response()
}

/// `POST /api/admin/access/suspend {userIds, reason?}`.
pub(crate) async fn api_admin_suspend(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let actor = gate!(admin_mutation_user(&headers, &st));
    let reason = body
        .get("reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|r| !r.is_empty());
    let mut suspended: Vec<Value> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    for user_id in string_list(body.get("userIds")) {
        // An admin cannot lock themselves (or the owner) out: those ids are
        // always active anyway, so the row change would only mislead the page.
        if st.platform_admins.contains(&user_id) || st.bootstrap_user_id == user_id {
            skipped.push(json!({"userId": user_id, "reason": "privileged"}));
            continue;
        }
        match st.workspaces.suspend_access(&user_id, &actor, reason) {
            Ok(true) => {
                let email = st.workspaces.user_email(&user_id);
                println!(
                    "[access] suspended {} ({user_id}) reason={}",
                    email.as_deref().unwrap_or("-"),
                    reason.unwrap_or("-")
                );
                after_suspend_hooks(&st, &user_id);
                let mut row = json!({"userId": user_id});
                crate::workspace::put_email(&mut row, email);
                suspended.push(row);
            }
            Ok(false) => skipped.push(json!({"userId": user_id, "reason": "already_suspended"})),
            Err(reason) => skipped.push(json!({"userId": user_id, "reason": reason})),
        }
    }
    if !suspended.is_empty() {
        st.hub.send(HubCmd::RefreshWorkspaceState);
    }
    Json(json!({"suspended": suspended, "skipped": skipped})).into_response()
}

/// `POST /api/admin/access/reactivate {userIds}`.
pub(crate) async fn api_admin_reactivate(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let actor = gate!(admin_mutation_user(&headers, &st));
    let mut reactivated: Vec<Value> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    for user_id in string_list(body.get("userIds")) {
        match st.workspaces.reactivate_access(&user_id, &actor) {
            Ok(true) => {
                let email = st.workspaces.user_email(&user_id);
                println!(
                    "[access] reactivated {} ({user_id})",
                    email.as_deref().unwrap_or("-")
                );
                after_reactivate_hooks(&st, &user_id);
                let mut row = json!({"userId": user_id});
                crate::workspace::put_email(&mut row, email);
                reactivated.push(row);
            }
            Ok(false) => skipped.push(json!({"userId": user_id, "reason": "not_suspended"})),
            Err(reason) => skipped.push(json!({"userId": user_id, "reason": reason})),
        }
    }
    if !reactivated.is_empty() {
        st.hub.send(HubCmd::RefreshWorkspaceState);
    }
    Json(json!({"reactivated": reactivated, "skipped": skipped})).into_response()
}

/// Shape-only validation: HegAI SSO is the authority on what an address is,
/// so this refuses the obviously-not-an-email and nothing else.
fn valid_email(email: &str) -> bool {
    !email.is_empty()
        && email.len() <= 254
        && email.contains('@')
        && !email.chars().any(char::is_whitespace)
}

/// `POST /api/admin/access/grant {email, note?, plan?}` → one of
/// `{status:"activated", userId, email}` — the account existed and is open now;
/// `{status:"pending", email, pending}` — nobody has signed in with that
/// address, so the promise waits and is claimed at their first SSO login;
/// `{status:"skipped", email, reason}` — `already_active`, `suspended`
/// (the verb for that is reactivate, and "add this person" must not silently
/// undo a moderation decision) or `already_pending` (the existing promise is
/// returned untouched).
///
/// One address per call: the whole point of this page is that access is opened
/// by hand, one person at a time, and one target gives one unambiguous answer.
pub(crate) async fn api_admin_grant(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let actor = gate!(admin_mutation_user(&headers, &st));
    let email =
        crate::workspace::normalize_email(body.get("email").and_then(Value::as_str).unwrap_or(""));
    if !valid_email(&email) {
        return api_error(StatusCode::BAD_REQUEST, "invalid email");
    }
    let note = body
        .get("note")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|n| !n.is_empty());
    let plan = match body.get("plan").and_then(Value::as_str) {
        Some("employee") => "employee",
        _ => "community",
    };
    let found = match st
        .workspaces
        .user_ids_by_email(std::slice::from_ref(&email))
    {
        Ok(found) => found,
        Err(error) => return store_failure(error),
    };
    if let Some((user_id, _)) = found.into_iter().next() {
        return match activate_user(&st, &actor, &user_id) {
            Ok(_) => {
                // Found BY this address, so it has one; `email` stays the
                // looked-up value rather than whatever the entry carries.
                Json(json!({"status":"activated","userId":user_id,"email":email})).into_response()
            }
            Err(reason) => {
                Json(json!({"status":"skipped","email":email,"reason":reason})).into_response()
            }
        };
    }
    match st.workspaces.preauthorize(&email, &actor, note, plan) {
        Ok((true, row)) => {
            println!("[access] preauthorized {email} (by {actor})");
            Json(json!({"status":"pending","email":email,"pending":row})).into_response()
        }
        Ok((false, row)) => {
            Json(json!({"status":"skipped","email":email,"reason":"already_pending","pending":row}))
                .into_response()
        }
        Err(error) => store_failure(error),
    }
}

/// `POST /api/admin/access/revoke {email}` → `{removed, email}`. Takes back a
/// promise nobody has used yet; `removed:false` when the address is unknown or
/// its promise was already claimed — that person has an account, and the verb
/// for them is suspend.
pub(crate) async fn api_admin_revoke(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let actor = gate!(admin_mutation_user(&headers, &st));
    let email =
        crate::workspace::normalize_email(body.get("email").and_then(Value::as_str).unwrap_or(""));
    if !valid_email(&email) {
        return api_error(StatusCode::BAD_REQUEST, "invalid email");
    }
    match st.workspaces.revoke_preauthorization(&email, &actor) {
        Ok(removed) => Json(json!({"removed": removed, "email": email})).into_response(),
        Err(error) => store_failure(error),
    }
}

/// `POST /api/access/request {note?}` — the waiting screen's "what do you
/// want to build?". Any signed-in user; idempotent; answers the current
/// `viewer.access` so the page can re-render without a second call.
pub(crate) async fn api_access_request(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let actor = gate!(mutation_user(&headers, &st));
    let note = body.get("note").and_then(Value::as_str);
    if let Err(error) = st.workspaces.request_access(&actor, note) {
        return store_failure(error);
    }
    match st.workspaces.access_state(&actor) {
        Ok(access) => match st.workspaces.viewer_access_json(&access) {
            Ok(value) => Json(value).into_response(),
            Err(error) => store_failure(error),
        },
        Err(error) => store_failure(error),
    }
}

/// Open the product for one person. In order: the state change and its audit
/// row (one transaction, in the workspace they own), the open tabs
/// (`RefreshWorkspaceState` re-derives every viewer, so a waiting screen
/// flips without a reload), then the provisioning hooks. Idempotent:
/// `Err("already_active")` for a second call, `Err("suspended")` when the
/// right verb is reactivate.
pub(crate) fn activate_user(st: &AppState, actor: &str, user_id: &str) -> Result<Value, String> {
    let changed = st.workspaces.activate_access(user_id, actor)?;
    if !changed {
        return Err("already_active".into());
    }
    let email = st.workspaces.user_email(user_id);
    println!(
        "[access] activated {} ({user_id})",
        email.as_deref().unwrap_or("-")
    );
    st.hub.send(HubCmd::RefreshWorkspaceState);
    after_activate_hooks(st, user_id);
    let mut row = json!({"userId": user_id});
    crate::workspace::put_email(&mut row, email);
    Ok(row)
}

/// Activation by a team invitation (see `WorkspaceStore::activate_by_invitation`).
/// True when this acceptance opened access; false when there was nothing to
/// open, or the store refused (suspended, inactive inviter, cap) — the person
/// is still in the team either way, and an admin can still open access by
/// hand in «Доступ».
pub(crate) fn activate_user_by_invitation(st: &AppState, inviter: &str, invitee: &str) -> bool {
    let cap = std::env::var("CC_REMOTE_INVITE_ACTIVATIONS_PER_MONTH")
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(crate::access::INVITE_ACTIVATIONS_PER_MONTH_DEFAULT);
    match st.workspaces.activate_by_invitation(invitee, inviter, cap) {
        Ok(crate::access::InviteActivation::Activated) => {
            let email = st.workspaces.user_email(invitee);
            println!(
                "[access] activated {} ({invitee}) by invitation from {inviter}",
                email.as_deref().unwrap_or("-")
            );
            st.hub.send(HubCmd::RefreshWorkspaceState);
            after_activate_hooks(st, invitee);
            true
        }
        Ok(other) => {
            if other != crate::access::InviteActivation::AlreadyActive {
                println!(
                    "[access] invitation from {inviter} did not activate {invitee}: {other:?}"
                );
            }
            false
        }
        Err(e) => {
            eprintln!("[access] activation by invitation failed for {invitee}: {e}");
            false
        }
    }
}

/// Attempts on a gateway seat before it is left `failed` for an admin.
pub(crate) const SEAT_MAX_ATTEMPTS: i64 = 5;
/// Pause after the n-th failed attempt, in seconds.
const SEAT_BACKOFF_SECS: [u64; 5] = [1, 5, 30, 120, 600];

/// What happens after a person is activated, beyond the state change
/// (community plan only; employees have no hosted sandbox): a `sandbox_create`
/// job goes on the provisioning queue. Safe to call twice — the queue
/// deduplicates — and it never fails the activation that already committed.
///
/// It no longer mints a gateway seat, and that is a product decision rather
/// than a cleanup: a new member brings their own Codex (or their own Claude
/// Code) instead of drawing on the community's shared subscription. Seats that
/// already exist are untouched — `reconcile_seats`, suspension, reactivation
/// and the admin repair endpoint all still work on them, so nobody who has a
/// key loses it. What changes is only that activation stops handing out new
/// ones.
///
/// The two consequences are load-bearing and live elsewhere: `claim_job` no
/// longer makes `sandbox_create` wait for a ready seat (`provisioning.rs`), and
/// the provisioner writes no `[model_providers.hegai]` block when the job
/// carries no key (`deploy/sandbox/provisioner.mjs`). Without both, a new
/// member would simply never get a machine.
///
/// Since 24.09.2026 a hub WITHOUT `CC_REMOTE_PROVISIONER_TOKEN` queues no
/// sandbox jobs at all (Owner: hosted sandboxes are not offered — a member
/// brings their own machine through the app or `/link`). The token is the
/// switch on purpose: without it no daemon could ever claim the job, so a
/// queued `sandbox_create` would only pin the member's «Начало» on «песочница
/// готовится» forever. The two existing sandboxes were deleted the same day;
/// the stage provisioner is stopped and disabled.
pub(crate) fn after_activate_hooks(st: &AppState, user_id: &str) {
    // The repository grant is its own queue and independent of the plan and of
    // hosted sandboxes: whoever came through GitHub gets read access.
    crate::github_grant::queue_for_activated(st, user_id);
    let Ok(access) = st.workspaces.access_state(user_id) else {
        return;
    };
    if access.plan != "community" || !sandboxes_offered(st) {
        return;
    }
    enqueue_sandbox_job(st, user_id, "sandbox_create");
    st.hub.send(HubCmd::RefreshWorkspaceState);
}

/// Hosted sandboxes exist only where a provisioner can claim the jobs. The
/// same condition `main.rs` prints at startup as «sandbox provisioning:
/// enabled/disabled».
fn sandboxes_offered(st: &AppState) -> bool {
    st.provisioner_token.is_some() && !st.sandbox_erasure_only
}

/// Suspension: the seat goes inactive (inference answers 401 to the
/// installed config) and the sandbox unit is stopped.
pub(crate) fn after_suspend_hooks(st: &AppState, user_id: &str) {
    // The private repository goes with the access, whatever the plan.
    crate::github_grant::revoke_for_suspended(st, user_id);
    let Ok(access) = st.workspaces.access_state(user_id) else {
        return;
    };
    if access.plan != "community" {
        return;
    }
    if access.sandbox_machine_id.is_some()
        || matches!(access.sandbox_status.as_str(), "ready" | "running")
    {
        enqueue_sandbox_job(st, user_id, "sandbox_suspend");
    }
    let Some(gw) = st.llmgw.clone() else {
        let _ = st.workspaces.set_seat_status(user_id, "inactive", None);
        return;
    };
    let Some(email) = st.workspaces.user_email(user_id) else {
        return;
    };
    let st = st.clone();
    let user_id = user_id.to_string();
    tokio::spawn(async move {
        match gw.set_active(&email, false).await {
            Ok(()) => {
                let _ = st.workspaces.set_seat_status(&user_id, "inactive", None);
                println!("[llmgw] seat for {email} set inactive");
            }
            Err(e) => {
                eprintln!("[llmgw] could not deactivate the seat for {email}: {e}");
                let _ = st.workspaces.set_seat_status(&user_id, "failed", Some(&e));
            }
        }
        st.hub.send(HubCmd::RefreshWorkspaceState);
    });
}

/// Reactivation: the seat comes back through the same create-or-repair-or-
/// reactivate path as activation (it also verifies the key still routes),
/// and the sandbox is resumed — or created, for someone suspended before
/// they ever got one.
pub(crate) fn after_reactivate_hooks(st: &AppState, user_id: &str) {
    // Re-arms a grant that failed while the person was not active.
    crate::github_grant::queue_for_activated(st, user_id);
    let Ok(access) = st.workspaces.access_state(user_id) else {
        return;
    };
    if access.plan != "community" {
        return;
    }
    if sandboxes_offered(st) {
        match access.sandbox_status.as_str() {
            "suspended" => enqueue_sandbox_job(st, user_id, "sandbox_resume"),
            "none" => enqueue_sandbox_job(st, user_id, "sandbox_create"),
            _ => {}
        }
    }
    let _ = st.workspaces.reset_seat(user_id);
    start_seat_provisioning(st, user_id);
    st.hub.send(HubCmd::RefreshWorkspaceState);
}

fn enqueue_sandbox_job(st: &AppState, user_id: &str, kind: &str) {
    match st.workspaces.enqueue_job(user_id, kind) {
        Ok((job_id, true)) => {
            println!("[provisioning] queued {kind} for {user_id} as job {job_id}")
        }
        Ok((_, false)) => {}
        Err(e) => eprintln!("[provisioning] could not queue {kind} for {user_id}: {e}"),
    }
}

/// Kick off (or resume, after a restart) the background task that makes
/// this user's seat. One task per user at a time — the reconciler and the
/// hooks both come through here, and `seat_inflight` keeps them from racing
/// two `ensure_seat` calls for one email. Without a gateway (a dev hub) the
/// seat is simply marked ready so the sandbox queue is not blocked.
pub(crate) fn start_seat_provisioning(st: &AppState, user_id: &str) {
    if st.workspaces.deletion_pending(user_id).unwrap_or(true) {
        return;
    }
    // Seats are named `hegai:<email>`: an account without an address
    // (Telegram-only) has none, and leaving it `pending` shows «ключ делается»
    // forever — the reconciler skips such rows by design.
    if st.workspaces.user_email(user_id).is_none() {
        let _ = st.workspaces.set_seat_status(user_id, "none", None);
        return;
    }
    let Some(gw) = st.llmgw.clone() else {
        let _ = st.workspaces.set_seat_status(user_id, "ready", None);
        println!(
            "[llmgw] not configured — seat for {user_id} marked ready without a gateway (dev)"
        );
        return;
    };
    {
        let Ok(mut inflight) = st.seat_inflight.lock() else {
            return;
        };
        if st.workspaces.deletion_pending(user_id).unwrap_or(true)
            || !inflight.insert(user_id.to_string())
        {
            return;
        }
    }
    let _ = st.workspaces.set_seat_status(user_id, "pending", None);
    let st = st.clone();
    let user_id = user_id.to_string();
    tokio::spawn(async move {
        seat_task(&st, gw, &user_id).await;
        if let Ok(mut inflight) = st.seat_inflight.lock() {
            inflight.remove(&user_id);
        }
    });
}

/// `ensure_seat` with retries. The row stays `pending` (with the last error
/// on it) between attempts and becomes `failed` only when the attempts are
/// spent, so the member's page keeps saying "the key is being made" for as
/// long as that is true. Stops quietly if the user is suspended meanwhile.
async fn seat_task(st: &AppState, gw: Arc<crate::llmgw::LlmGateway>, user_id: &str) {
    let Some(email) = st.workspaces.user_email(user_id) else {
        return;
    };
    loop {
        let Ok(access) = st.workspaces.access_state(user_id) else {
            return;
        };
        if access.state != "active" {
            return;
        }
        let attempt = match st.workspaces.bump_seat_attempts(user_id) {
            Ok(n) => n,
            Err(e) => {
                eprintln!("[llmgw] {email}: {e}");
                return;
            }
        };
        match gw.ensure_seat(&email).await {
            Ok((seat, action)) => {
                // Suspended while the gateway was working: undo, do not hand
                // out a live key to a suspended person.
                if !st.workspaces.is_active(user_id) {
                    let _ = gw.set_active(&email, false).await;
                    let _ = st.workspaces.set_seat_status(user_id, "inactive", None);
                    return;
                }
                let _ = st.workspaces.set_seat_status(user_id, "ready", None);
                let _ = st.workspaces.audit_user_event(
                    user_id,
                    crate::provisioning::SYSTEM_ACTOR,
                    "gateway.seat_ready",
                    &json!({"seat": seat.name, "action": action, "attempts": attempt}),
                );
                println!(
                    "[llmgw] seat {} {action} for {email} (attempt {attempt})",
                    seat.name
                );
                st.hub.send(HubCmd::RefreshWorkspaceState);
                return;
            }
            Err(e) => {
                eprintln!(
                    "[llmgw] seat attempt {attempt}/{SEAT_MAX_ATTEMPTS} for {email} failed: {e}"
                );
                if attempt >= SEAT_MAX_ATTEMPTS {
                    let _ = st.workspaces.set_seat_status(user_id, "failed", Some(&e));
                    let _ = st.workspaces.audit_user_event(
                        user_id,
                        crate::provisioning::SYSTEM_ACTOR,
                        "gateway.seat_failed",
                        &json!({"error": e, "attempts": attempt}),
                    );
                    st.hub.send(HubCmd::RefreshWorkspaceState);
                    return;
                }
                let _ = st.workspaces.set_seat_status(user_id, "pending", Some(&e));
                let idx = (attempt.max(1) as usize - 1).min(SEAT_BACKOFF_SECS.len() - 1);
                tokio::time::sleep(std::time::Duration::from_secs(SEAT_BACKOFF_SECS[idx])).await;
            }
        }
    }
}

/// The minute sweep for seats: active community members whose seat is not
/// ready and still has attempts left (a hub restart mid-backoff, a gateway
/// that was down at activation). Rows already being worked on are skipped.
pub(crate) fn reconcile_seats(st: &AppState) {
    let rows = match st.workspaces.seats_needing_work(SEAT_MAX_ATTEMPTS) {
        Ok(rows) => rows,
        Err(e) => {
            eprintln!("[llmgw] reconciler: {e}");
            return;
        }
    };
    for (user_id, email) in rows {
        if st.llmgw.is_none() {
            let _ = st.workspaces.set_seat_status(&user_id, "ready", None);
            println!(
                "[llmgw] not configured — seat for {email} marked ready without a gateway (dev)"
            );
            st.hub.send(HubCmd::RefreshWorkspaceState);
            continue;
        }
        start_seat_provisioning(st, &user_id);
    }
}

/// `POST /api/admin/access/{userId}/verify-seat` → `{ok, error?}`. One real
/// completion through the public edge with the member's own key — the only
/// proof a seat works, since Bifrost accepts and ignores some fields.
pub(crate) async fn api_admin_verify_seat(
    AxumPath(user_id): AxumPath<String>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    gate!(admin_mutation_user(&headers, &st));
    let Some(gw) = st.llmgw.clone() else {
        return Json(json!({"ok": false, "error": "gateway not configured"})).into_response();
    };
    let Some(email) = st.workspaces.user_email(&user_id) else {
        return api_error(StatusCode::NOT_FOUND, "user not found");
    };
    let seat = match gw.find_seat(&email).await {
        Ok(Some(seat)) => seat,
        Ok(None) => {
            return Json(json!({"ok": false, "error": "no seat on the gateway"})).into_response()
        }
        Err(e) => return Json(json!({"ok": false, "error": e})).into_response(),
    };
    if !seat.is_active {
        return Json(json!({"ok": false, "error": "seat is inactive"})).into_response();
    }
    if seat.value.is_empty() {
        return Json(json!({"ok": false, "error": "seat carries no key"})).into_response();
    }
    match gw.write_probe(&seat.value).await {
        Ok(()) => {
            println!("[llmgw] verify: seat {} answers a completion", seat.name);
            Json(json!({"ok": true})).into_response()
        }
        Err(e) => {
            eprintln!("[llmgw] verify: seat {} failed: {e}", seat.name);
            Json(json!({"ok": false, "error": e})).into_response()
        }
    }
}

/// `POST /api/admin/access/{userId}/retry-seat` → the seat starts over
/// (attempts reset). Active community members only.
pub(crate) async fn api_admin_retry_seat(
    AxumPath(user_id): AxumPath<String>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    gate!(admin_mutation_user(&headers, &st));
    let access = match st.workspaces.access_state(&user_id) {
        Ok(access) => access,
        Err(e) => return store_failure(e),
    };
    if access.state != "active" || access.plan != "community" {
        return api_error(
            StatusCode::CONFLICT,
            "only an active community member has a hub-managed seat",
        );
    }
    if let Err(e) = st.workspaces.reset_seat(&user_id) {
        return store_failure(e);
    }
    start_seat_provisioning(&st, &user_id);
    st.hub.send(HubCmd::RefreshWorkspaceState);
    match st.workspaces.access_state(&user_id) {
        Ok(access) => {
            Json(json!({"ok": true, "seat": {"status": access.seat_status}})).into_response()
        }
        Err(e) => store_failure(e),
    }
}

/// A JSON array of strings, trimmed, empties dropped. Anything else → empty.
fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}
