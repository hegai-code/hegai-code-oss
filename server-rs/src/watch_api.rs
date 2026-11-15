//! HTTP for the watch and smart pushes (docs/WATCH.md §3-§5):
//! `POST /api/push-action`, `GET /api/watch/inbox`, `POST /api/push/live-activity`, `POST /api/watch/session`.
//!
//! The handlers authenticate and shape the request; the decision to act, and
//! every access check, happen in the hub loop (`hub/watch.rs`) so they share
//! the WebSocket's gate.

use super::*;
use crate::hub::{LiveOp, PushActionReq, TokenUse};
use crate::push_action::{ActionError, TokenError};

/// A session token from `Authorization: Bearer` only. The cookie is not
/// accepted on these POSTs: a cookie rides along on cross-site requests, a
/// bearer header does not.
fn bearer_user(headers: &HeaderMap, st: &AppState) -> Result<String, Response> {
    let Some(token) = bearer_token(headers) else {
        return Err(api_error(
            StatusCode::UNAUTHORIZED,
            "authentication required",
        ));
    };
    match st.workspaces.authenticate(&token) {
        // Support access reads through the audited UI, not through the watch
        // surface, whose reads and answers leave no support trace.
        Ok(Some((user_id, _))) if crate::support_access::is_support_user(&user_id) => {
            Err(api_error(StatusCode::FORBIDDEN, "not available"))
        }
        // A service-minted session is held to its service's conditions, and a
        // watch session minted from it would outlive them. The watch surface
        // takes neither.
        Ok(Some((user_id, _))) => match st.workspaces.session_is_service(&token) {
            Ok(false) => Ok(user_id),
            Ok(true) => Err(api_error(StatusCode::FORBIDDEN, "not available")),
            Err(e) => Err(store_failure(e)),
        },
        Ok(None) => Err(api_error(
            StatusCode::UNAUTHORIZED,
            "authentication required",
        )),
        Err(e) => Err(store_failure(e)),
    }
}

/// Like `bearer_user`, but an Apple Watch session (`ui_scope='watch'`) is
/// good too: the only two endpoints that take one.
fn bearer_user_or_watch(headers: &HeaderMap, st: &AppState) -> Result<String, Response> {
    if let Some(token) = bearer_token(headers) {
        if let Ok(Some(user)) = st.workspaces.authenticate_watch(&token) {
            return Ok(user);
        }
    }
    bearer_user(headers, st)
}

/// The rollout gate of what leaves the hub through APNs: action tokens only
/// reach admins' pushes (docs/WATCH.md §1). The watch app and the Live Activity
/// are open to every active user, under that user's own access.
fn admin_only(st: &AppState, user: &str) -> Result<(), Response> {
    if st.platform_admins.contains(user) {
        Ok(())
    } else {
        Err(api_error(StatusCode::FORBIDDEN, "not available"))
    }
}

fn action_error(e: &ActionError) -> Response {
    let status = StatusCode::from_u16(e.status()).unwrap_or(StatusCode::BAD_REQUEST);
    (status, Json(json!({"error": e.code()}))).into_response()
}

/// What a body's optional string field is: absent, or a string; else a 400.
fn opt_str(obj: &serde_json::Map<String, Value>, key: &str) -> Result<Option<String>, Response> {
    match obj.get(key) {
        None => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(api_error(
            StatusCode::BAD_REQUEST,
            format!("{key} must be a string"),
        )),
    }
}

pub(crate) async fn api_push_action(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let Some(obj) = body.as_object() else {
        return api_error(StatusCode::BAD_REQUEST, "body must be an object");
    };
    let action = match opt_str(obj, "action") {
        Ok(Some(a)) if !a.is_empty() && a.len() <= 40 => a,
        Ok(_) => return api_error(StatusCode::BAD_REQUEST, "action required"),
        Err(e) => return e,
    };
    let text = match opt_str(obj, "text") {
        Ok(t) => t,
        Err(e) => return e,
    };
    let answers = match obj.get("answers") {
        None => None,
        Some(Value::Object(m)) => Some(m.clone()),
        Some(_) => return api_error(StatusCode::BAD_REQUEST, "answers must be an object"),
    };

    let req = match opt_str(obj, "token") {
        Err(e) => return e,
        // Token mode: no cookie, no session — the token is the credential.
        Ok(Some(token)) => {
            let Some(secret) = push_action::config().secret.as_deref() else {
                return api_error(StatusCode::SERVICE_UNAVAILABLE, "push actions are off");
            };
            let (claims, kind) = match push_action::verify(secret, &token, now_ms() / 1000) {
                Ok(v) => v,
                Err(TokenError::Invalid) => {
                    return api_error(StatusCode::UNAUTHORIZED, "invalid or expired token")
                }
            };
            // [admin] too: a token minted for someone who is no longer one
            // (or a leaked secret) opens nothing.
            if let Err(e) = admin_only(&st, &claims.sub) {
                return e;
            }
            PushActionReq {
                user_id: claims.sub,
                workspace_id: Some(claims.ws),
                admin: false,
                run_id: claims.run,
                request_id: claims.req,
                token_kind: Some(kind),
                token: Some(TokenUse {
                    jti: claims.jti,
                    exp: claims.exp,
                }),
                action,
                text,
                answers,
            }
        }
        // Session mode: the watch app, a Bearer session.
        Ok(None) => {
            let user = match bearer_user_or_watch(&headers, &st) {
                Ok(u) => u,
                Err(e) => return e,
            };
            let run_id = match opt_str(obj, "runId") {
                Ok(Some(r)) if !r.is_empty() => r,
                // No run: only a reply to a named session (docs/WATCH.md §4c).
                Ok(_) => return session_reply(&st, user, action, obj, text).await,
                Err(e) => return e,
            };
            let request_id = match opt_str(obj, "requestId") {
                Ok(r) => r.filter(|r| !r.is_empty()),
                Err(e) => return e,
            };
            PushActionReq {
                user_id: user,
                workspace_id: None,
                admin: false,
                run_id,
                request_id,
                token_kind: None,
                token: None,
                action,
                text,
                answers,
            }
        }
    };
    if let Err(error) = require_active(&st, &req.user_id) {
        return error;
    }
    let admin = st.platform_admins.contains(&req.user_id);
    let req = PushActionReq { admin, ..req };
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    st.hub.send(HubCmd::PushAction {
        req: Box::new(req),
        reply: reply_tx,
    });
    match reply_rx.await {
        Ok(Ok(())) => Json(json!({"ok": true})).into_response(),
        Ok(Err(e)) => action_error(&e),
        Err(_) => api_error(StatusCode::INTERNAL_SERVER_ERROR, "hub is not responding"),
    }
}

/// `reply` to a session that has no live run: `machineId` + `sessionId`
/// (+ `source`) + `text`. The hub resumes the session through the same core
/// `/api/fleet/send` uses.
async fn session_reply(
    st: &AppState,
    user: String,
    action: String,
    obj: &serde_json::Map<String, Value>,
    text: Option<String>,
) -> Response {
    if action != "reply" {
        return api_error(StatusCode::BAD_REQUEST, "runId required");
    }
    let field = |k: &str| match opt_str(obj, k) {
        Ok(v) => Ok(v.filter(|v| !v.is_empty())),
        Err(e) => Err(e),
    };
    let (machine_id, session_id, source) =
        match (field("machineId"), field("sessionId"), field("source")) {
            (Ok(Some(m)), Ok(Some(s)), Ok(source)) => (m, s, source),
            (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => return e,
            _ => return api_error(StatusCode::BAD_REQUEST, "runId required"),
        };
    if !matches!(source.as_deref(), None | Some("claude") | Some("codex")) {
        return api_error(StatusCode::BAD_REQUEST, "bad source");
    }
    if let Err(error) = require_active(st, &user) {
        return error;
    }
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    st.hub.send(HubCmd::WatchSessionReply {
        user_id: user,
        machine_id,
        session_id,
        source,
        text,
        reply: reply_tx,
    });
    match reply_rx.await {
        Ok(Ok(())) => Json(json!({"ok": true})).into_response(),
        Ok(Err(e)) => action_error(&e),
        Err(_) => api_error(StatusCode::INTERNAL_SERVER_ERROR, "hub is not responding"),
    }
}

/// `GET /api/watch/history?machineId=&sessionId=&limit=&source=` (docs/WATCH.md §4b).
pub(crate) async fn api_watch_history(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let user = match bearer_user_or_watch(&headers, &st) {
        Ok(u) => u,
        Err(e) => return e,
    };
    gate!(require_active(&st, &user));
    let get = |k: &str| params.get(k).map(String::as_str).filter(|v| !v.is_empty());
    let (Some(machine_id), Some(session_id)) = (get("machineId"), get("sessionId")) else {
        return api_error(StatusCode::BAD_REQUEST, "machineId and sessionId required");
    };
    let source = match get("source") {
        None => None,
        Some(s @ ("claude" | "codex")) => Some(s.to_string()),
        Some(_) => return api_error(StatusCode::BAD_REQUEST, "bad source"),
    };
    let limit = match get("limit") {
        None => watch_history::LIMIT_DEFAULT,
        Some(l) => match l.parse::<usize>() {
            Ok(n) if n >= 1 => n.min(watch_history::LIMIT_MAX),
            _ => return api_error(StatusCode::BAD_REQUEST, "bad limit"),
        },
    };
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    st.hub.send(HubCmd::WatchHistory {
        user_id: user,
        machine_id: machine_id.to_string(),
        session_id: session_id.to_string(),
        source,
        limit,
        reply: reply_tx,
    });
    match reply_rx.await {
        Ok(Ok(v)) => ([(header::CACHE_CONTROL, "no-store")], Json(v)).into_response(),
        Ok(Err((status, code))) => (
            StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST),
            Json(json!({"error": code})),
        )
            .into_response(),
        Err(_) => api_error(StatusCode::INTERNAL_SERVER_ERROR, "hub is not responding"),
    }
}

pub(crate) async fn api_watch_inbox(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let user = match bearer_user_or_watch(&headers, &st) {
        Ok(u) => u,
        Err(e) => return e,
    };
    gate!(require_active(&st, &user));
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    st.hub.send(HubCmd::WatchInbox {
        user_id: user,
        reply: reply_tx,
    });
    match reply_rx.await {
        Ok(v) => ([(header::CACHE_CONTROL, "no-store")], Json(v)).into_response(),
        Err(_) => api_error(StatusCode::INTERNAL_SERVER_ERROR, "hub is not responding"),
    }
}

pub(crate) async fn api_live_activity(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let user = match bearer_user(&headers, &st) {
        Ok(u) => u,
        Err(e) => return e,
    };
    let Some(obj) = body.as_object() else {
        return api_error(StatusCode::BAD_REQUEST, "body must be an object");
    };
    // Every mutation passes the active-user gate (AGENTS.md invariant 4). An
    // inactive account gets no Live Activity pushes anyway (`live_snapshot`
    // fails closed), so refusing its signout leaves nothing on its screen.
    gate!(require_active(&st, &user));
    let field = |k: &str| obj.get(k).and_then(Value::as_str).map(str::to_string);
    let token = field("token").map(|t| t.to_ascii_lowercase());
    let id = field("activityId");
    let op = match obj.get("kind").and_then(Value::as_str) {
        Some("start") => match token {
            Some(t) if live_activity::token_ok(&t) => LiveOp::Start { token: t },
            _ => return api_error(StatusCode::BAD_REQUEST, "bad token"),
        },
        Some("activity") => match (id, token) {
            (Some(id), Some(t)) if live_activity::id_ok(&id) && live_activity::token_ok(&t) => {
                LiveOp::Activity { id, token: t }
            }
            _ => return api_error(StatusCode::BAD_REQUEST, "bad activityId or token"),
        },
        Some("ended") => match id {
            Some(id) if live_activity::id_ok(&id) => LiveOp::Ended { id },
            _ => return api_error(StatusCode::BAD_REQUEST, "bad activityId"),
        },
        Some("signout") => {
            let tokens: Option<Vec<String>> = obj
                .get("tokens")
                .and_then(Value::as_array)
                .filter(|t| t.len() <= 32)
                .and_then(|t| {
                    t.iter()
                        .map(|v| v.as_str().map(str::to_ascii_lowercase))
                        .collect()
                });
            match tokens {
                Some(t) if t.iter().all(|t| live_activity::token_ok(t)) => {
                    LiveOp::Signout { tokens: t }
                }
                _ => return api_error(StatusCode::BAD_REQUEST, "bad tokens"),
            }
        }
        _ => return api_error(StatusCode::BAD_REQUEST, "unknown kind"),
    };
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    st.hub.send(HubCmd::LiveActivity {
        user_id: user,
        op,
        reply: reply_tx,
    });
    match reply_rx.await {
        Ok(Ok(())) => Json(json!({"ok": true})).into_response(),
        Ok(Err(e)) => store_failure(e),
        Err(_) => api_error(StatusCode::INTERNAL_SERVER_ERROR, "hub is not responding"),
    }
}

/// `POST /api/watch/session` (docs/WATCH.md §7): the iPhone asks for the
/// session its watch keeps. A normal session mints it (a watch session cannot
/// mint another: `bearer_user` refuses it).
pub(crate) async fn api_watch_session(State(st): State<AppState>, headers: HeaderMap) -> Response {
    if !same_origin(&headers) {
        return api_error(StatusCode::FORBIDDEN, "cross-site request rejected");
    }
    let user = match bearer_user(&headers, &st) {
        Ok(u) => u,
        Err(e) => return e,
    };
    gate!(require_active(&st, &user));
    match st.workspaces.create_watch_session(&user) {
        Ok(token) => (
            [(header::CACHE_CONTROL, "no-store")],
            Json(json!({ "token": token })),
        )
            .into_response(),
        Err(e) => store_failure(e),
    }
}
