//! Fleet API: a session on one of the owner's machines starts and continues
//! sessions on the others — the hands of the dispatcher at `/srv/hub`
//! (`hegai-fleet` is the client, `deploy/hegai-fleet.mjs`).
//!
//! Its own credential class. Neither the shared fleet token (every legacy
//! agent carries it, and it names no owner) nor a device token (the employee
//! sandbox `devbox` holds one and is enrolled under the owner's account — with
//! device tokens, a sandbox would drive every machine the owner has). A fleet
//! key is issued by hand to ONE machine and lives in the hub's environment as
//! a sha256 digest: `CC_REMOTE_FLEET_API_KEYS=<machineId>:<sha256hex>,...`.
//! Unset => every endpoint here is 404.
//!
//! The key acts as that machine's owner, on that owner's machines only. It is
//! refused outright when the holding machine is a sandbox by any of the three
//! signs this hub knows (`kind = sandbox`, an `sb-` id or name, project shares
//! that put other people on the box) — a key accidentally issued to one must
//! not work, whatever the config says.
//!
//! The task registry (`/api/fleet/tasks…`, `taskId` on spawn / send) is open to
//! every key that passes the checks above: it was Teo-only by environment, Teo
//! is gone, and the key already names the machine and the owner
//! (`hub/fleet_tasks.rs`).

use super::*;
use crate::hub::{sandbox_sign, FleetError, FleetTarget, FleetTaskOp, TaskTag};
use axum::extract::Path;

/// Turns (spawn + send) one key may start per rolling hour — a dispatcher
/// looping on a failure should stall, not open a hundred sessions.
const FLEET_TURNS_PER_HOUR: usize = 120;
const HOUR_MS: i64 = 60 * 60 * 1000;
/// Status reads per key per minute: `wait` polls every 4 s (15/min), so this
/// leaves room for a few parallel waits and stops a tight loop.
const FLEET_STATUS_PER_MINUTE: usize = 90;
const MINUTE_MS: i64 = 60 * 1000;
/// A turn is a prompt, not a document; same cap as a filed backend spec.
const FLEET_MESSAGE_MAX: usize = 32_000;

/// sha256 hex of a key -> the machine id it was issued to.
pub(crate) type FleetApiKeys = HashMap<String, String>;

pub(crate) fn load_fleet_api_keys() -> Option<Arc<FleetApiKeys>> {
    let raw = std::env::var("CC_REMOTE_FLEET_API_KEYS").ok()?;
    let keys = parse_fleet_api_keys(&raw);
    if keys.is_empty() {
        return None;
    }
    println!("[hub] fleet API open to {} key(s)", keys.len());
    Some(Arc::new(keys))
}

fn parse_fleet_api_keys(raw: &str) -> FleetApiKeys {
    raw.split(',')
        .filter_map(|entry| {
            let (machine, digest) = entry.trim().split_once(':')?;
            let digest = digest.trim().to_ascii_lowercase();
            let valid = digest.len() == 64 && digest.chars().all(|c| c.is_ascii_hexdigit());
            if machine.trim().is_empty() || !valid {
                eprintln!("[hub] ignoring a malformed CC_REMOTE_FLEET_API_KEYS entry");
                return None;
            }
            Some((digest, machine.trim().to_string()))
        })
        .collect()
}

/// Who a request acts for.
pub(crate) struct FleetCaller {
    pub(crate) machine_id: String,
    pub(crate) owner_user_id: String,
}

pub(crate) fn fleet_caller(st: &AppState, headers: &HeaderMap) -> Result<FleetCaller, Response> {
    let Some(keys) = st.fleet_api_keys.as_ref() else {
        return Err(api_error(
            StatusCode::NOT_FOUND,
            "the fleet API is not configured on this hub",
        ));
    };
    let Some(token) = bearer_token(headers) else {
        return Err(api_error(StatusCode::UNAUTHORIZED, "unauthorized"));
    };
    let Some(machine_id) = keys.get(&crate::workspace::hash_token(&token)) else {
        return Err(api_error(StatusCode::UNAUTHORIZED, "invalid fleet key"));
    };
    let owner = match st.workspaces.device_owner(machine_id) {
        Ok(Some(owner)) => owner,
        // Revoked or never enrolled: the key dies with the machine.
        Ok(None) => {
            return Err(api_error(
                StatusCode::UNAUTHORIZED,
                "the key's machine is not enrolled",
            ))
        }
        Err(e) => return Err(store_failure(e)),
    };
    // Fail closed: every lookup below that errors refuses the call, rather
    // than reading as «not a sandbox».
    let kind = st
        .workspaces
        .device_kind(machine_id)
        .map_err(|e| store_failure(e))?;
    let name = st
        .workspaces
        .devices_for_user(&owner)
        .map_err(|e| store_failure(e))?
        .into_iter()
        .find(|d| d["machineId"].as_str() == Some(machine_id.as_str()))
        .and_then(|d| d["name"].as_str().map(str::to_string));
    let has_shares = st
        .workspaces
        .device_has_shares(machine_id)
        .map_err(|e| store_failure(e))?;
    if let Some(why) = sandbox_sign(kind.as_deref(), machine_id, name.as_deref(), has_shares) {
        eprintln!("[hub] fleet key of {machine_id} refused: {why}");
        return Err(api_error(
            StatusCode::FORBIDDEN,
            format!("sandboxes may not use the fleet API ({why})"),
        ));
    }
    require_active(st, &owner)?;
    Ok(FleetCaller {
        machine_id: machine_id.clone(),
        owner_user_id: owner,
    })
}

fn fleet_reply(
    result: Result<Result<Value, FleetError>, tokio::sync::oneshot::error::RecvError>,
) -> Response {
    match result {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err((code, message))) => api_error(
            StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_REQUEST),
            message,
        ),
        Err(_) => api_error(StatusCode::INTERNAL_SERVER_ERROR, "hub is not responding"),
    }
}

fn str_field<'a>(body: &'a Value, key: &str) -> Option<&'a str> {
    body.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn turn_message(body: &Value) -> Result<String, Response> {
    let message = str_field(body, "message").unwrap_or("");
    if message.is_empty() {
        return Err(api_error(StatusCode::BAD_REQUEST, "message is required"));
    }
    if message.len() > FLEET_MESSAGE_MAX {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            format!("message is too long (max {FLEET_MESSAGE_MAX} bytes)"),
        ));
    }
    Ok(message.to_string())
}

fn settings_of(body: &Value) -> Value {
    json!({
        "model": body.get("model").cloned().unwrap_or(Value::Null),
        "effort": body.get("effort").cloned().unwrap_or(Value::Null),
        "source": body.get("source").cloned().unwrap_or(Value::Null),
        "requireGateway": body.get("requireGateway").cloned().unwrap_or(Value::Null),
    })
}

fn target_of(fields: &Value) -> Result<FleetTarget, Response> {
    if let Some(run_id) = str_field(fields, "runId") {
        return Ok(FleetTarget::Run(run_id.to_string()));
    }
    match (str_field(fields, "machine"), str_field(fields, "sessionId")) {
        (Some(machine), Some(session_id)) => Ok(FleetTarget::Session {
            machine: machine.to_string(),
            session_id: session_id.to_string(),
        }),
        _ => Err(api_error(
            StatusCode::BAD_REQUEST,
            "pass runId, or machine and sessionId",
        )),
    }
}

/// Check and count in ONE critical section. `check_window_quota` +
/// `record_window_hit` after the work lets a burst of parallel calls all pass
/// the check before any is counted; here the slot is taken up front and a
/// refused turn still costs it — a loop that keeps failing should stall too.
fn reserve(
    st: &AppState,
    key: &str,
    limit: usize,
    window_ms: i64,
    why: &str,
) -> Result<(), Response> {
    let Ok(mut log) = st.window_log.lock() else {
        return Err(api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "rate limiter unavailable",
        ));
    };
    let now = crate::workspace_api::chrono_now_ms();
    log.check(key, limit, window_ms, now)
        .map_err(|()| refusal(StatusCode::TOO_MANY_REQUESTS, why))?;
    log.record(key, window_ms, now);
    Ok(())
}

fn quota_key(caller: &FleetCaller) -> String {
    format!("fleet:{}", caller.machine_id)
}

fn audit(
    st: &AppState,
    caller: &FleetCaller,
    action: &str,
    target_type: &str,
    target_id: &str,
    meta: Value,
) {
    if let Some(workspace_id) = audit_workspace_for(st, &caller.owner_user_id) {
        let _ = st.workspaces.audit(
            &workspace_id,
            &caller.owner_user_id,
            action,
            target_type,
            target_id,
            &meta,
        );
    }
}

pub(crate) async fn api_fleet_machines(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let caller = match fleet_caller(&st, &headers) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    st.hub.send(HubCmd::FleetMachines {
        owner_user_id: caller.owner_user_id,
        reply: tx,
    });
    match rx.await {
        Ok(v) => Json(v).into_response(),
        Err(_) => api_error(StatusCode::INTERNAL_SERVER_ERROR, "hub is not responding"),
    }
}

pub(crate) async fn api_fleet_spawn(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let caller = match fleet_caller(&st, &headers) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let task = match task_tag(&caller, &body) {
        Ok(t) => t,
        Err(r) => return r,
    };
    let (Some(machine), Some(cwd)) = (str_field(&body, "machine"), str_field(&body, "cwd")) else {
        return api_error(StatusCode::BAD_REQUEST, "machine and cwd are required");
    };
    let message = match turn_message(&body) {
        Ok(m) => m,
        Err(r) => return r,
    };
    if let Err(r) = reserve(
        &st,
        &quota_key(&caller),
        FLEET_TURNS_PER_HOUR,
        HOUR_MS,
        "fleet turn limit reached for this hour",
    ) {
        return r;
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    st.hub.send(HubCmd::FleetSpawn {
        owner_user_id: caller.owner_user_id.clone(),
        machine: machine.to_string(),
        cwd: cwd.to_string(),
        message,
        settings: settings_of(&body),
        task,
        reply: tx,
    });
    let result = rx.await;
    if let Ok(Ok(v)) = &result {
        let run_id = v["runId"].as_str().unwrap_or_default();
        audit(
            &st,
            &caller,
            "fleet.spawn",
            "run",
            run_id,
            json!({"from": caller.machine_id, "machineId": v["machineId"], "cwd": cwd, "taskId": v["taskId"]}),
        );
        println!(
            "[hub] fleet spawn from {} -> run {run_id} in {cwd}",
            caller.machine_id
        );
    }
    fleet_reply(result)
}

pub(crate) async fn api_fleet_send(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let caller = match fleet_caller(&st, &headers) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let task = match task_tag(&caller, &body) {
        Ok(t) => t,
        Err(r) => return r,
    };
    let target = match target_of(&body) {
        Ok(t) => t,
        Err(r) => return r,
    };
    let message = match turn_message(&body) {
        Ok(m) => m,
        Err(r) => return r,
    };
    if let Err(r) = reserve(
        &st,
        &quota_key(&caller),
        FLEET_TURNS_PER_HOUR,
        HOUR_MS,
        "fleet turn limit reached for this hour",
    ) {
        return r;
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    st.hub.send(HubCmd::FleetSend {
        owner_user_id: caller.owner_user_id.clone(),
        target,
        message,
        settings: settings_of(&body),
        task,
        reply: tx,
    });
    let result = rx.await;
    if let Ok(Ok(v)) = &result {
        let run_id = v["runId"].as_str().unwrap_or_default();
        audit(
            &st,
            &caller,
            "fleet.send",
            "run",
            run_id,
            json!({"from": caller.machine_id, "machineId": v["machineId"], "sessionId": v["sessionId"], "resumed": v["resumed"], "taskId": v["taskId"]}),
        );
    }
    fleet_reply(result)
}

pub(crate) async fn api_fleet_status(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let caller = match fleet_caller(&st, &headers) {
        Ok(c) => c,
        Err(r) => return r,
    };
    if let Err(r) = reserve(
        &st,
        &format!("fleet-status:{}", caller.machine_id),
        FLEET_STATUS_PER_MINUTE,
        MINUTE_MS,
        "too many status reads; poll slower",
    ) {
        return r;
    }
    let fields = json!(params);
    let target = match target_of(&fields) {
        Ok(t) => t,
        Err(r) => return r,
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    st.hub.send(HubCmd::FleetStatus {
        owner_user_id: caller.owner_user_id,
        target,
        reply: tx,
    });
    fleet_reply(rx.await)
}

// ── the task registry ──────────────────────────────────────────────────────
//
// `tape_tasks` is the one task registry (`hub/fleet_tasks.rs`). Anything that
// touches it — these endpoints and `--task` on spawn / send — needs nothing
// beyond `fleet_caller`: the key's machine is not a sandbox (403 otherwise,
// «sandboxes may not use the fleet API») and its owner is active.

/// Writes to the registry per key per hour (a looping dispatcher should stall).
const FLEET_TASK_WRITES_PER_HOUR: usize = 240;

/// `taskId` of a spawn / send body: absent is no task.
fn task_tag(caller: &FleetCaller, body: &Value) -> Result<Option<TaskTag>, Response> {
    // Absent is no task; a present `null` is a caller bug, not "no task" —
    // it would start the work detached from the task it meant.
    let Some(raw) = body.get("taskId") else {
        return Ok(None);
    };
    let Some(task_id) = raw.as_str().map(str::trim).filter(|t| !t.is_empty()) else {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "taskId must be a non-empty string",
        ));
    };
    Ok(Some(TaskTag {
        task_id: task_id.to_string(),
        linked_by: caller.machine_id.clone(),
    }))
}

/// A text field that may be absent: `Some("")` clears, a non-string (null
/// included) is a 400.
fn opt_text(body: &Value, key: &str) -> Result<Option<String>, Response> {
    match body.get(key) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.trim().to_string())),
        Some(_) => Err(api_error(
            StatusCode::BAD_REQUEST,
            format!("{key} must be a string"),
        )),
    }
}

fn task_write_limit(st: &AppState, caller: &FleetCaller) -> Result<(), Response> {
    reserve(
        st,
        &format!("fleet-task:{}", caller.machine_id),
        FLEET_TASK_WRITES_PER_HOUR,
        HOUR_MS,
        "too many task writes this hour",
    )
}

/// Run one registry call in the hub: the answer, or the refusal as a response.
async fn task_run(st: &AppState, caller: &FleetCaller, op: FleetTaskOp) -> Result<Value, Response> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    st.hub.send(HubCmd::FleetTask {
        owner_user_id: caller.owner_user_id.clone(),
        op,
        reply: tx,
    });
    match rx.await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err((code, message))) => Err(api_error(
            StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_REQUEST),
            message,
        )),
        Err(_) => Err(api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "hub is not responding",
        )),
    }
}

/// `task_run` for a write: a success is logged as a `task` action.
async fn task_write(
    st: &AppState,
    caller: &FleetCaller,
    action: &str,
    op: FleetTaskOp,
) -> Response {
    match task_run(st, caller, op).await {
        Ok(value) => {
            let task_id = value["task"]["id"]
                .as_str()
                .or_else(|| value["link"]["taskId"].as_str())
                .unwrap_or_default();
            audit(
                st,
                caller,
                action,
                "task",
                task_id,
                json!({"from": caller.machine_id}),
            );
            Json(value).into_response()
        }
        Err(r) => r,
    }
}

async fn task_read(st: &AppState, caller: &FleetCaller, op: FleetTaskOp) -> Response {
    match task_run(st, caller, op).await {
        Ok(value) => Json(value).into_response(),
        Err(r) => r,
    }
}

pub(crate) async fn api_fleet_tasks(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let caller = match fleet_caller(&st, &headers) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let all = params
        .get("all")
        .is_some_and(|v| matches!(v.trim(), "1" | "true" | "yes"));
    let limit = params.get("limit").and_then(|v| v.trim().parse().ok());
    task_read(&st, &caller, FleetTaskOp::List { all, limit }).await
}

pub(crate) async fn api_fleet_task_get(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let caller = match fleet_caller(&st, &headers) {
        Ok(c) => c,
        Err(r) => return r,
    };
    task_read(&st, &caller, FleetTaskOp::Get { id }).await
}

pub(crate) async fn api_fleet_task_create(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let caller = match fleet_caller(&st, &headers) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let Some(title) = str_field(&body, "title") else {
        return api_error(StatusCode::BAD_REQUEST, "title is required");
    };
    let (status, intent, lane) = match (
        opt_text(&body, "status"),
        opt_text(&body, "intent"),
        opt_text(&body, "lane"),
    ) {
        (Ok(a), Ok(b), Ok(c)) => (a, b, c),
        (Err(r), _, _) | (_, Err(r), _) | (_, _, Err(r)) => return r,
    };
    if let Err(r) = task_write_limit(&st, &caller) {
        return r;
    }
    task_write(
        &st,
        &caller,
        "fleet.task.create",
        FleetTaskOp::Create {
            title: title.to_string(),
            status,
            intent,
            lane,
        },
    )
    .await
}

pub(crate) async fn api_fleet_task_update(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let caller = match fleet_caller(&st, &headers) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let (title, status, intent, lane) = match (
        opt_text(&body, "title"),
        opt_text(&body, "status"),
        opt_text(&body, "intent"),
        opt_text(&body, "lane"),
    ) {
        (Ok(a), Ok(b), Ok(c), Ok(d)) => (a, b, c, d),
        (Err(r), _, _, _) | (_, Err(r), _, _) | (_, _, Err(r), _) | (_, _, _, Err(r)) => return r,
    };
    if let Err(r) = task_write_limit(&st, &caller) {
        return r;
    }
    task_write(
        &st,
        &caller,
        "fleet.task.update",
        FleetTaskOp::Update {
            id,
            title,
            status,
            intent,
            lane,
        },
    )
    .await
}

pub(crate) async fn api_fleet_task_link(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let caller = match fleet_caller(&st, &headers) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let target = match target_of(&body) {
        Ok(t) => t,
        Err(r) => return r,
    };
    if let Err(r) = task_write_limit(&st, &caller) {
        return r;
    }
    task_write(
        &st,
        &caller,
        "fleet.task.link",
        FleetTaskOp::Link {
            id,
            target,
            linked_by: caller.machine_id.clone(),
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_parse_digests_and_drop_junk() {
        let digest = "a".repeat(64);
        let keys = parse_fleet_api_keys(&format!(
            " m1:{digest} , m2:short, :{digest}, m3:{}",
            "Z".repeat(64)
        ));
        assert_eq!(keys.len(), 1);
        assert_eq!(keys.get(&digest).map(String::as_str), Some("m1"));
    }

    #[test]
    fn every_sandbox_sign_refuses() {
        assert!(sandbox_sign(Some("sandbox"), "m", Some("box"), false).is_some());
        assert!(sandbox_sign(Some("personal"), "sb-anna", None, false).is_some());
        assert!(sandbox_sign(Some("personal"), "uuid", Some("sb-anna"), false).is_some());
        // devbox: enrolled `personal`, carries project shares.
        assert!(sandbox_sign(Some("personal"), "uuid", Some("devbox"), true).is_some());
        assert!(sandbox_sign(Some("personal"), "uuid", Some("stage"), false).is_none());
    }
}
