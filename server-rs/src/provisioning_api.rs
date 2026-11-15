//! HTTP surface of the provisioning queue: the three routes the provisioner
//! daemon dials (claim / heartbeat / result), the platform-admin views of the
//! queue, and the minute reconciler. Queue logic is in `provisioning.rs`.
//!
//! The daemon authenticates with `CC_REMOTE_PROVISIONER_TOKEN` — its own
//! credential class. It is deliberately NOT the fleet token: that one can open
//! `/ui` as the bootstrap owner on a dev hub, and a provisioner box must never
//! hold anything that reaches a browser session. Unset ⇒ the routes are 404,
//! the same pattern as the backend-spec intake.

use super::*;
use crate::provisioning::{is_job_kind, JobOutcome, JobResult};
use crate::timefmt::iso8601_utc;

/// Floor on the provisioner token, like the SSO and access-link secrets.
const PROVISIONER_TOKEN_MIN: usize = 32;
/// How much of a failed job's journal tail reaches the hub log.
const JOURNAL_TAIL_CAP: usize = 2000;
/// Hosts must be safe to echo into logs and file names.
const HOST_MAX: usize = 64;

/// The provisioner credential from the environment. `None` — and therefore
/// 404 on every `/api/provisioning/*` route — when unset, shorter than the
/// floor, or the same string as the fleet token (which would quietly fold
/// two credential classes into one).
pub(crate) fn load_provisioner_token(raw: Option<&str>, fleet_token: &str) -> Option<String> {
    let token = raw?.trim();
    if token.len() < PROVISIONER_TOKEN_MIN {
        eprintln!("[provisioning] CC_REMOTE_PROVISIONER_TOKEN is shorter than {PROVISIONER_TOKEN_MIN} characters — provisioning routes stay closed");
        return None;
    }
    if token == fleet_token {
        eprintln!("[provisioning] CC_REMOTE_PROVISIONER_TOKEN equals CC_REMOTE_TOKEN — refusing to reuse the fleet token; provisioning routes stay closed");
        return None;
    }
    Some(token.to_string())
}

/// Constant-time byte comparison: the reply never leaks how many leading
/// bytes of a guess were right.
pub(crate) fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// 404 when the feature is off, 401 for a missing or wrong bearer.
pub(crate) fn provisioner_gate_status(
    presented: Option<&str>,
    configured: Option<&str>,
) -> Result<(), StatusCode> {
    let Some(configured) = configured else {
        return Err(StatusCode::NOT_FOUND);
    };
    match presented {
        Some(token) if ct_eq(token.as_bytes(), configured.as_bytes()) => Ok(()),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

fn provisioner_gate(headers: &HeaderMap, st: &AppState) -> Result<(), Response> {
    let presented = bearer_token(headers);
    provisioner_gate_status(presented.as_deref(), st.provisioner_token.as_deref()).map_err(
        |status| {
            let message = if status == StatusCode::NOT_FOUND {
                "provisioning is not configured on this hub"
            } else {
                "unauthorized"
            };
            refusal(status, message)
        },
    )
}

/// The hub's WebSocket origin for a sandbox's `CENTRAL_URL`.
pub(crate) fn ws_url(public_url: &str) -> String {
    let trimmed = public_url.trim().trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        trimmed.to_string()
    }
}

fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= HOST_MAX
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

fn log_outcome(outcome: &JobOutcome) {
    match outcome.status.as_str() {
        "done" => println!(
            "[provisioning] job {} ({}) done for {} on {} machine={}",
            outcome.job_id,
            outcome.kind,
            outcome.email.as_deref().unwrap_or(&outcome.user_id),
            outcome.host.as_deref().unwrap_or("-"),
            outcome.machine_id.as_deref().unwrap_or("-")
        ),
        "queued" => println!(
            "[provisioning] job {} ({}) for {} requeued after attempt {}: {}",
            outcome.job_id,
            outcome.kind,
            outcome.email.as_deref().unwrap_or(&outcome.user_id),
            outcome.attempts,
            outcome.error.as_deref().unwrap_or("-")
        ),
        _ => eprintln!(
            "[provisioning] job {} ({}) FAILED for {} ({}) after {} attempt(s): {}",
            outcome.job_id,
            outcome.kind,
            outcome.email.as_deref().unwrap_or(&outcome.user_id),
            outcome.user_id,
            outcome.attempts,
            outcome.error.as_deref().unwrap_or("-")
        ),
    }
}

/// `POST /api/provisioning/jobs/claim {host, capacity}` → the job payload,
/// or 204 when there is nothing for this host. The enrollment code is minted
/// here and the gateway key is read here — neither is stored on the job.
pub(crate) async fn api_provision_claim(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = provisioner_gate(&headers, &st) {
        return e;
    }
    let host = body
        .get("host")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if !valid_host(host) {
        return api_error(
            StatusCode::BAD_REQUEST,
            "host required ([A-Za-z0-9._-], ≤64 chars)",
        );
    }
    let capacity = body.get("capacity").cloned().unwrap_or_else(|| json!({}));
    if let Ok(mut hosts) = st.provision_hosts.lock() {
        hosts.insert(host.to_string(), (capacity, workspace::now_ms()));
    }
    let result = if st.sandbox_erasure_only {
        st.workspaces.claim_erasure_job(host)
    } else {
        st.workspaces.claim_job(host)
    };
    let claimed = match result {
        Ok(Some(job)) => job,
        Ok(None) => return StatusCode::NO_CONTENT.into_response(),
        Err(e) => return store_failure(e),
    };
    let name = access::sandbox_machine_name(&claimed.slug);
    let wants_gateway = matches!(
        claimed.kind.as_str(),
        "sandbox_create" | "sandbox_resume" | "sandbox_rotate_key"
    );
    let gateway = if !wants_gateway {
        None
    } else {
        match &st.llmgw {
            // Dev hub: no gateway, but the provisioner still has to run end to
            // end, so it gets a placeholder key it can write into config.toml.
            // No public URL either (external hub without a gateway): no Codex
            // gateway block at all rather than a key with no address.
            None if st.llm_public_url.is_empty() => None,
            None => Some(json!({
                "baseUrl": st.llm_public_url,
                "apiKey": "sk-bf-dev",
                "model": installer_model(),
            })),
            // A seat is named `hegai:<email>`: an account without an address
            // cannot have one, which is the same "no seat" case as below.
            Some(_) if claimed.email.is_none() => None,
            Some(gw) => match gw
                .find_seat(claimed.email.as_deref().unwrap_or_default())
                .await
            {
                Ok(Some(seat)) if seat.is_active && !seat.value.is_empty() => Some(json!({
                    "baseUrl": gw.public_url(),
                    "apiKey": seat.value,
                    "model": gw.model(),
                })),
                // No seat, or an inactive one: normal now. Activation stopped
                // minting seats, so a new member's `sandbox_create` arrives
                // here with nothing to look up — the job goes out without a
                // gateway block and the provisioner leaves `config.toml`
                // without a model provider. This arm used to hand the job
                // BACK and mark the seat failed, which after that change would
                // have parked every new member's sandbox in a repair loop for
                // a seat nobody intends to create. A member who still has a
                // live seat (they were activated before this) keeps getting it
                // through the arm above.
                Ok(_) => None,
                Err(e) => {
                    let _ = st.workspaces.unclaim_job(&claimed.job_id);
                    eprintln!("[provisioning] job {} handed back: {e}", claimed.job_id);
                    return api_error(StatusCode::SERVICE_UNAVAILABLE, "gateway unavailable");
                }
            },
        }
    };
    let mut user_json = json!({"userId": claimed.user_id});
    crate::workspace::put_email(&mut user_json, claimed.email.clone());
    let mut job = json!({
        "jobId": claimed.job_id,
        "kind": claimed.kind,
        // `email` absent for an account without one; the provisioner then
        // writes `<unixUser>@sandbox.invalid` as the git identity.
        "user": user_json,
        "sandbox": {"unixUser": name, "machineName": name},
        "hub": {"centralUrl": ws_url(&st.public_url)},
    });
    if claimed.kind == "sandbox_delete"
        && st
            .workspaces
            .deletion_pending(&claimed.user_id)
            .unwrap_or(false)
    {
        job["erasePersonalData"] = json!(true);
    }
    if let Some(full_name) = &claimed.full_name {
        job["user"]["fullName"] = Value::String(full_name.clone());
    }
    if let Some(machine_id) = &claimed.machine_id {
        job["sandbox"]["machineId"] = Value::String(machine_id.clone());
    }
    if let Some((code, expires_at)) = &claimed.enrollment {
        job["enrollment"] = json!({"code": code, "expiresAt": iso8601_utc(*expires_at)});
    }
    if let Some(gateway) = gateway {
        job["gateway"] = gateway;
    }
    println!(
        "[provisioning] job {} ({}) claimed by {host} for {} attempt {}",
        claimed.job_id,
        claimed.kind,
        claimed.email.as_deref().unwrap_or(&claimed.user_id),
        claimed.attempts
    );
    st.hub.send(HubCmd::RefreshWorkspaceState);
    Json(job).into_response()
}

/// `POST /api/provisioning/jobs/{id}/heartbeat` — 204, or 404 when the job
/// is not running (the reconciler may have taken it back).
pub(crate) async fn api_provision_heartbeat(
    AxumPath(job_id): AxumPath<String>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    if let Err(e) = provisioner_gate(&headers, &st) {
        return e;
    }
    match st.workspaces.heartbeat_job(&job_id) {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => api_error(StatusCode::NOT_FOUND, "job is not running"),
        Err(e) => store_failure(e),
    }
}

/// `POST /api/provisioning/jobs/{id}/result` with the daemon's
/// `{ok:true, machineId, …}` or `{ok:false, stage, error, retryable, journalTail?}`.
/// A stale result (job no longer running) is acknowledged with
/// `accepted:false` rather than an error, so the daemon does not keep
/// re-posting it.
pub(crate) async fn api_provision_result(
    AxumPath(job_id): AxumPath<String>,
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = provisioner_gate(&headers, &st) {
        return e;
    }
    let Some(ok) = body.get("ok").and_then(Value::as_bool) else {
        return api_error(StatusCode::BAD_REQUEST, "ok (boolean) required");
    };
    let text = |key: &str| {
        body.get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    if ok
        && st.workspaces.job_requires_erasure(&job_id).unwrap_or(true)
        && body["personalDataErased"] != true
    {
        return api_error(
            StatusCode::CONFLICT,
            "provisioner must confirm personal data erasure; upgrade and retry",
        );
    }
    let result = if ok {
        JobResult::Ok {
            machine_id: text("machineId"),
            archive: text("archive"),
        }
    } else {
        JobResult::Failed {
            stage: text("stage").unwrap_or_else(|| "unknown".into()),
            error: text("error").unwrap_or_else(|| "unknown error".into()),
            retryable: body
                .get("retryable")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        }
    };
    match st.workspaces.apply_job_result(&job_id, &result) {
        Ok(outcome) => {
            log_outcome(&outcome);
            if !ok {
                if let Some(tail) = text("journalTail") {
                    let tail: String = tail.chars().take(JOURNAL_TAIL_CAP).collect();
                    eprintln!("[provisioning] job {job_id} journal tail:\n{tail}");
                }
            }
            st.hub.send(HubCmd::RefreshWorkspaceState);
            Json(json!({"accepted": true, "status": outcome.status})).into_response()
        }
        Err(e) if e == "not_found" => api_error(StatusCode::NOT_FOUND, "job not found"),
        Err(e) if e == "job is not running" => {
            println!("[provisioning] job {job_id}: late result ignored ({e})");
            Json(json!({"accepted": false, "reason": e})).into_response()
        }
        Err(e) => store_failure(e),
    }
}

fn admin_only(headers: &HeaderMap, st: &AppState, mutation: bool) -> Result<(), Response> {
    let actor = if mutation {
        mutation_user(headers, st)?
    } else {
        authenticated_user(headers, st)?
    };
    if !st.platform_admins.contains(&actor) {
        return Err(api_error(StatusCode::FORBIDDEN, "platform admin required"));
    }
    Ok(())
}

/// `GET /api/admin/provisioning/jobs?status=&limit=` → `{jobs:[ProvisionJob]}`.
pub(crate) async fn api_admin_provision_jobs(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if let Err(e) = admin_only(&headers, &st, false) {
        return e;
    }
    let status = params
        .get("status")
        .map(String::as_str)
        .filter(|s| matches!(*s, "queued" | "running" | "done" | "failed"));
    let limit = params
        .get("limit")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(200)
        .clamp(1, 500);
    match st.workspaces.provision_jobs(status, limit) {
        Ok(jobs) => Json(json!({"jobs": jobs})).into_response(),
        Err(e) => store_failure(e),
    }
}

/// `POST /api/admin/provisioning/jobs/{id}/retry` — a failed job back to the
/// queue with its attempts reset.
pub(crate) async fn api_admin_provision_retry(
    AxumPath(job_id): AxumPath<String>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    if let Err(e) = admin_only(&headers, &st, true) {
        return e;
    }
    match st.workspaces.retry_job(&job_id) {
        Ok(true) => {
            println!("[provisioning] job {job_id} retried by admin");
            st.hub.send(HubCmd::RefreshWorkspaceState);
            Json(json!({"ok": true})).into_response()
        }
        Ok(false) => api_error(StatusCode::CONFLICT, "only a failed job can be retried"),
        Err(e) => store_failure(e),
    }
}

/// `POST /api/admin/access/{userId}/sandbox/{kind}` — queue any job kind by
/// hand (`sandbox_delete`, `sandbox_rotate_key`, a fresh `sandbox_create`).
pub(crate) async fn api_admin_sandbox_enqueue(
    AxumPath((user_id, kind)): AxumPath<(String, String)>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    if let Err(e) = admin_only(&headers, &st, true) {
        return e;
    }
    if st.sandbox_erasure_only {
        return api_error(
            StatusCode::CONFLICT,
            "hosted sandboxes are disabled; provisioner handles account erasure only",
        );
    }
    if !is_job_kind(&kind) {
        return api_error(StatusCode::BAD_REQUEST, "unknown job kind");
    }
    match st.workspaces.enqueue_job(&user_id, &kind) {
        Ok((job_id, created)) => {
            if created {
                println!("[provisioning] {kind} for {user_id} queued by admin as job {job_id}");
            }
            st.hub.send(HubCmd::RefreshWorkspaceState);
            Json(json!({"jobId": job_id, "created": created})).into_response()
        }
        Err(e) if e == "not_found" => api_error(StatusCode::NOT_FOUND, "user not found"),
        Err(e) => store_failure(e),
    }
}

/// `GET /api/admin/provisioning/hosts` → what each provisioner reported on
/// its last claim, in memory since the hub started.
pub(crate) async fn api_admin_provision_hosts(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    if let Err(e) = admin_only(&headers, &st, false) {
        return e;
    }
    let mut hosts: Vec<Value> = st
        .provision_hosts
        .lock()
        .map(|map| {
            map.iter()
                .map(|(host, (capacity, seen_at))| json!({"host": host, "capacity": capacity, "seenAt": seen_at}))
                .collect()
        })
        .unwrap_or_default();
    hosts.sort_by(|a, b| a["host"].as_str().cmp(&b["host"].as_str()));
    Json(json!({"hosts": hosts, "configured": st.provisioner_token.is_some()})).into_response()
}

/// The minute sweep: running jobs whose daemon went silent are requeued or
/// failed, and seats that still need making are picked up (a restart mid-
/// backoff, a gateway that was down at activation). First pass shortly after
/// start so a dev hub marks pending seats ready without waiting a minute.
pub(crate) async fn reconciler_loop(st: AppState) {
    let mut delay = Duration::from_secs(5);
    loop {
        tokio::time::sleep(delay).await;
        delay = Duration::from_secs(60);
        match st.workspaces.requeue_stale_jobs() {
            Ok(outcomes) => {
                for outcome in &outcomes {
                    log_outcome(outcome);
                }
                if !outcomes.is_empty() {
                    st.hub.send(HubCmd::RefreshWorkspaceState);
                }
            }
            Err(e) => eprintln!("[provisioning] reconciler: {e}"),
        }
        reconcile_seats(&st);
        crate::github_grant::reconcile_grants(&st);
    }
}

#[cfg(test)]
mod tests {
    use super::{load_provisioner_token, provisioner_gate_status, ws_url};
    use axum::http::StatusCode;

    /// The provisioner box holds a credential that may open exactly
    /// `/api/provisioning/*` — never the fleet token, which on a dev hub opens
    /// `/ui` as the owner.
    #[test]
    fn provisioner_token_is_required_and_separate_from_the_fleet_token() {
        let fleet = "fleet-token-fleet-token-fleet-token!";
        let good = "provisioner-secret-provisioner-secret";
        assert!(load_provisioner_token(None, fleet).is_none());
        assert!(load_provisioner_token(Some(""), fleet).is_none());
        assert!(
            load_provisioner_token(Some("too-short"), fleet).is_none(),
            "under the 32-char floor"
        );
        assert!(
            load_provisioner_token(Some(fleet), fleet).is_none(),
            "the fleet token is refused as a provisioner token"
        );
        assert_eq!(
            load_provisioner_token(Some(&format!("  {good} ")), fleet).as_deref(),
            Some(good)
        );

        // Unconfigured: the routes do not exist, whatever is presented.
        assert_eq!(
            provisioner_gate_status(None, None),
            Err(StatusCode::NOT_FOUND)
        );
        assert_eq!(
            provisioner_gate_status(Some(good), None),
            Err(StatusCode::NOT_FOUND)
        );
        // Configured: only the exact token passes; the fleet token does not.
        assert_eq!(
            provisioner_gate_status(None, Some(good)),
            Err(StatusCode::UNAUTHORIZED)
        );
        assert_eq!(
            provisioner_gate_status(Some(fleet), Some(good)),
            Err(StatusCode::UNAUTHORIZED)
        );
        assert_eq!(
            provisioner_gate_status(Some(&good[..good.len() - 1]), Some(good)),
            Err(StatusCode::UNAUTHORIZED)
        );
        assert_eq!(
            provisioner_gate_status(Some(&format!("{good}x")), Some(good)),
            Err(StatusCode::UNAUTHORIZED)
        );
        assert_eq!(provisioner_gate_status(Some(good), Some(good)), Ok(()));
    }

    #[test]
    fn central_url_is_the_websocket_form_of_the_public_url() {
        assert_eq!(ws_url("https://code.acme.test/"), "wss://code.acme.test");
        assert_eq!(ws_url("http://127.0.0.1:4319"), "ws://127.0.0.1:4319");
        assert_eq!(ws_url("wss://already"), "wss://already");
    }
}
