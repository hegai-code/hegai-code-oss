//! Облачный браузер (10.10.2026, «давай такой же шторкой настроим открытие
//! внутреннего браузера … для входа в разные сервисы, а потом чтобы платформа
//! могла управлять сессиями там»). Each person has their own Camoufox
//! profile on the hub box (`deploy/browser`); the web shows it in a side sheet
//! over noVNC, and sessions drive it with the same verbs as `hegai-browser`.
//!
//! The hub is the only door. `browserd` listens on a root-only unix socket and
//! trusts the `owner` the hub passes; it re-checks ownership of every profile,
//! but WHO the owner is comes from here:
//! - **a signed-in, active person** (cookie or bearer; writes and the VNC
//!   socket same-origin only) — their own profiles, never anyone else's. Not
//!   even an admin opens another person's browser: it holds live logins;
//! - **a fleet key** (`fleet_api.rs`) — acts as its machine's owner, on that
//!   owner's profiles only, never as admin. That is how a session on `stage`
//!   drives the browser its owner signed in to.
//!
//! `CC_REMOTE_BROWSER_SOCKET` turns the feature on; `CC_REMOTE_BROWSER_USERS`
//! (`*` or a comma list of user ids, default: the platform admins) says who
//! sees it, so it can be rolled out to Owner first.

use super::*;
use axum::extract::ws::CloseFrame;
use axum::extract::Path;
use std::path::PathBuf;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

/// browserd's socket (`browserd.py` SOCK) — for erasure even when the flag is off.
const DEFAULT_SOCKET: &str = "/run/hegai-browserd.sock";
/// Where browserd keeps each awake profile's sockets (`browserd.py` RUN).
const RUN_DIR: &str = "/run/hegai-browser";
/// Commands can wait on a page load (45 s in the runner) plus a cold start.
const BROWSERD_TIMEOUT: Duration = Duration::from_secs(250); // > browserd's cold start (180 s run + 60 s ready)
/// How often an open viewer tells browserd «someone is watching».
const TOUCH_EVERY: Duration = Duration::from_secs(60);
/// How often an open screen re-checks the sign-in it was opened with.
const REAUTH_EVERY: Duration = Duration::from_secs(10);
/// Biggest command body: `insert_text` of a long paste.
pub(crate) const MAX_CMD_BYTES: usize = 1024 * 1024;
/// Biggest browserd answer: a full-page screenshot as base64.
const MAX_REPLY_BYTES: usize = 24 * 1024 * 1024;

/// What a session (fleet key) may do in a person's browser, verb by verb,
/// and with WHICH params: look, click, type, move around. Not `eval` (script
/// in the person's signed-in pages), not `insert_text`/`new_tab` and not
/// `navigate` with `new_tab` — the sheet's own conveniences. Params are
/// rebuilt from this list, so a field the runner happens to understand never
/// rides along. A prompt injection that reaches a session should find the
/// narrowest hands here.
fn fleet_params(verb: &str) -> Option<&'static [&'static str]> {
    Some(match verb {
        "navigate" => &["url"],
        "read_text" => &["max"],
        "get_dom" | "back" | "forward" | "reload" | "list_tabs" | "status" => &[],
        "click" => &["id"],
        "click_by_text" => &["text"],
        "type" => &["id", "text", "enter", "clear", "delay"],
        "key" => &["key"],
        "scroll" => &["direction", "amount"],
        "switch_tab" => &["index"],
        "screenshot" => &["full"],
        _ => return None,
    })
}

fn fleet_body(verb: &str, params: &Value) -> Option<Value> {
    let allowed = fleet_params(verb)?;
    let mut out = serde_json::Map::new();
    for key in allowed {
        if let Some(v) = params.get(*key) {
            out.insert((*key).to_string(), v.clone());
        }
    }
    Some(json!({ "type": verb, "params": out }))
}

pub(crate) struct BrowserConfig {
    socket: PathBuf,
    /// None = everyone who is active.
    users: Option<HashSet<String>>,
}

pub(crate) fn load_config(admins: &HashSet<String>, bootstrap: &str) -> Option<Arc<BrowserConfig>> {
    let socket = std::env::var("CC_REMOTE_BROWSER_SOCKET").ok()?;
    let socket = socket.trim();
    if socket.is_empty() {
        return None;
    }
    let users = match std::env::var("CC_REMOTE_BROWSER_USERS")
        .ok()
        .as_deref()
        .map(str::trim)
    {
        Some("*") => None,
        Some(list) if !list.is_empty() => Some(
            list.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
        ),
        _ => {
            let mut set = admins.clone();
            set.insert(bootstrap.to_string());
            Some(set)
        }
    };
    Some(Arc::new(BrowserConfig {
        socket: PathBuf::from(socket),
        users,
    }))
}

fn valid_profile_id(id: &str) -> bool {
    id.len() == 16
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The VNC socket of a profile — computed here, never taken from browserd's
/// answer, so the hub can only ever connect inside RUN_DIR.
fn vnc_socket(id: &str) -> PathBuf {
    PathBuf::from(RUN_DIR).join(id).join("vnc.sock")
}

/// Who is asking. A KIND, not a string: machine ids are chosen at enrollment
/// and one could be literally "web" (gateway review 10.10.2026).
enum Via {
    Web,
    Fleet { machine_id: String },
}

struct Caller {
    user_id: String,
    via: Via,
}

impl Caller {
    fn is_web(&self) -> bool {
        matches!(self.via, Via::Web)
    }
    fn source(&self) -> &str {
        match &self.via {
            Via::Web => "web",
            Via::Fleet { machine_id } => machine_id,
        }
    }
}

/// Creating, deleting, waking/sleeping a profile and watching its screen are
/// the person's own acts in the web; a session drives an existing browser and
/// nothing more — it must not be able to erase someone's saved logins.
fn web_only(c: &Caller) -> Result<(), Response> {
    if c.is_web() {
        Ok(())
    } else {
        Err(api_error(
            StatusCode::FORBIDDEN,
            "only the person, in the browser sheet, can do this",
        ))
    }
}

/// 404 (not 403) when the feature is off or not for this person: the web
/// reads «no browser here» from it and hides the button.
fn caller(
    st: &AppState,
    headers: &HeaderMap,
    writes: bool,
) -> Result<(Arc<BrowserConfig>, Caller), Response> {
    let Some(cfg) = st.browser.clone() else {
        return Err(api_error(
            StatusCode::NOT_FOUND,
            "cloud browser is not enabled on this hub",
        ));
    };
    let is_fleet_key = match (st.fleet_api_keys.as_ref(), bearer_token(headers)) {
        (Some(keys), Some(token)) => keys.contains_key(&crate::workspace::hash_token(&token)),
        _ => false,
    };
    let c = if is_fleet_key {
        let fleet = crate::fleet_api::fleet_caller(st, headers)?;
        Caller {
            user_id: fleet.owner_user_id,
            via: Via::Fleet {
                machine_id: fleet.machine_id,
            },
        }
    } else {
        let user = if writes {
            mutation_user(headers, st)?
        } else {
            authenticated_user(headers, st)?
        };
        require_active(st, &user)?;
        Caller {
            user_id: user,
            via: Via::Web,
        }
    };
    if let Some(users) = &cfg.users {
        if !users.contains(&c.user_id) {
            return Err(api_error(
                StatusCode::NOT_FOUND,
                "cloud browser is not enabled for you",
            ));
        }
    }
    Ok((cfg, c))
}

/// One HTTP/1.0 exchange with browserd over its unix socket. HTTP/1.0 with
/// `Connection: close` semantics: browserd answers and hangs up, so the
/// whole reply is «read to EOF».
async fn browserd(
    cfg: &BrowserConfig,
    method: &str,
    path: &str,
    body: Option<&[u8]>,
) -> Result<(StatusCode, Value), Response> {
    let exchange = async {
        let mut s = UnixStream::connect(&cfg.socket).await?;
        let body = body.unwrap_or(b"");
        let head = format!(
            "{method} {path} HTTP/1.0\r\nHost: browserd\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            body.len()
        );
        s.write_all(head.as_bytes()).await?;
        s.write_all(body).await?;
        let mut buf = Vec::new();
        (&mut s)
            .take(MAX_REPLY_BYTES as u64)
            .read_to_end(&mut buf)
            .await?;
        Ok::<_, std::io::Error>(buf)
    };
    let raw = match tokio::time::timeout(BROWSERD_TIMEOUT, exchange).await {
        Ok(Ok(raw)) => raw,
        Ok(Err(e)) => {
            eprintln!("[browser] browserd unreachable: {e}");
            return Err(api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "cloud browser service is down",
            ));
        }
        Err(_) => {
            return Err(api_error(
                StatusCode::GATEWAY_TIMEOUT,
                "cloud browser did not answer in time",
            ))
        }
    };
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n");
    let (head, payload) = match split {
        Some(i) => (&raw[..i], &raw[i + 4..]),
        None => {
            return Err(api_error(
                StatusCode::BAD_GATEWAY,
                "bad answer from cloud browser service",
            ))
        }
    };
    let status = std::str::from_utf8(head)
        .ok()
        .and_then(|h| h.split_whitespace().nth(1))
        .and_then(|c| c.parse::<u16>().ok())
        .and_then(|c| StatusCode::from_u16(c).ok())
        .unwrap_or(StatusCode::BAD_GATEWAY);
    let value = serde_json::from_slice(payload)
        .unwrap_or_else(|_| json!({"error": "bad answer from cloud browser service"}));
    Ok((status, value))
}

fn owner_q(c: &Caller) -> String {
    format!("owner={}", urlencoding::encode(&c.user_id))
}

fn reply(r: Result<(StatusCode, Value), Response>) -> Response {
    match r {
        Ok((status, value)) => (status, Json(value)).into_response(),
        Err(e) => e,
    }
}

fn audit(st: &AppState, c: &Caller, action: &str, id: &str, meta: Value) {
    let admin = st.platform_admins.contains(&c.user_id);
    let workspace = match st.workspaces.ui_access(&c.user_id, None, admin) {
        Ok(access) => access.workspace_id,
        Err(e) => {
            eprintln!("[browser] audit skipped: {e}");
            return;
        }
    };
    let mut meta = meta;
    meta["source"] = json!(c.source());
    if let Err(e) =
        st.workspaces
            .audit(&workspace, &c.user_id, action, "browser_profile", id, &meta)
    {
        eprintln!("[browser] audit write failed: {e}");
    }
}

/// Account erasure: stop and erase every profile of `user` (their saved
/// logins). An error keeps the deletion pending, to be retried — it must not
/// read «deleted» while cookies sit on the hub box.
pub(crate) async fn erase_owner(st: &AppState, user: &str) -> Result<(), &'static str> {
    // Not tied to the rollout flag: a hub whose browser env was removed may
    // still have profiles on disk. browserd's socket existing is enough.
    let cfg = match st.browser.clone() {
        Some(cfg) => cfg,
        None if std::path::Path::new(DEFAULT_SOCKET).exists() => Arc::new(BrowserConfig {
            socket: PathBuf::from(DEFAULT_SOCKET),
            users: Some(HashSet::new()),
        }),
        None => return Ok(()),
    };
    let path = format!("/owners/purge?owner={}", urlencoding::encode(user));
    match browserd(&cfg, "POST", &path, Some(b"{}")).await {
        Ok((status, _)) if status.is_success() => Ok(()),
        _ => Err("cloud browser erasure"),
    }
}

/// `GET /api/browser` — is there a browser for me, and is its exit up.
pub(crate) async fn api_browser(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let (cfg, _c) = match caller(&st, &headers, false) {
        Ok(v) => v,
        Err(e) => return e,
    };
    match browserd(&cfg, "GET", "/health", None).await {
        Ok((_, v)) => Json(json!({
            "enabled": true,
            "egress": v["egress"].as_bool().unwrap_or(false),
        }))
        .into_response(),
        Err(_) => Json(json!({"enabled": true, "egress": false, "down": true})).into_response(),
    }
}

/// `GET /api/browser/profiles`
pub(crate) async fn api_profiles(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let (cfg, c) = match caller(&st, &headers, false) {
        Ok(v) => v,
        Err(e) => return e,
    };
    reply(browserd(&cfg, "GET", &format!("/profiles?{}", owner_q(&c)), None).await)
}

/// `POST /api/browser/profiles` `{name}`
pub(crate) async fn api_profile_create(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let (cfg, c) = match caller(&st, &headers, true) {
        Ok(v) => v,
        Err(e) => return e,
    };
    if let Err(e) = web_only(&c) {
        return e;
    }
    let name: String = body["name"]
        .as_str()
        .unwrap_or("Браузер")
        .chars()
        .take(60)
        .collect();
    let payload = json!({ "name": name }).to_string();
    let r = browserd(
        &cfg,
        "POST",
        &format!("/profiles?{}", owner_q(&c)),
        Some(payload.as_bytes()),
    )
    .await;
    if let Ok((status, v)) = &r {
        if status.is_success() {
            audit(
                &st,
                &c,
                "browser.profile.create",
                v["id"].as_str().unwrap_or(""),
                json!({"name": name}),
            );
        }
    }
    reply(r)
}

/// `DELETE /api/browser/profiles/{id}` — stops it and erases its logins.
pub(crate) async fn api_profile_delete(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let (cfg, c) = match caller(&st, &headers, true) {
        Ok(v) => v,
        Err(e) => return e,
    };
    if let Err(e) = web_only(&c) {
        return e;
    }
    if !valid_profile_id(&id) {
        return api_error(StatusCode::NOT_FOUND, "no such profile");
    }
    let r = browserd(
        &cfg,
        "DELETE",
        &format!("/profiles/{id}?{}", owner_q(&c)),
        None,
    )
    .await;
    if matches!(&r, Ok((s, _)) if s.is_success()) {
        audit(&st, &c, "browser.profile.delete", &id, json!({}));
    }
    reply(r)
}

/// `POST /api/browser/profiles/{id}/{start|stop}`
pub(crate) async fn api_profile_action(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path((id, action)): Path<(String, String)>,
) -> Response {
    let (cfg, c) = match caller(&st, &headers, true) {
        Ok(v) => v,
        Err(e) => return e,
    };
    if let Err(e) = web_only(&c) {
        return e;
    }
    if !valid_profile_id(&id) || !matches!(action.as_str(), "start" | "stop") {
        return api_error(StatusCode::NOT_FOUND, "not found");
    }
    let r = browserd(
        &cfg,
        "POST",
        &format!("/profiles/{id}/{action}?{}", owner_q(&c)),
        Some(b"{}"),
    )
    .await;
    // The socket path is ours to know, not the client's.
    reply(r.map(|(s, mut v)| {
        if let Some(obj) = v.as_object_mut() {
            obj.remove("vnc");
        }
        (s, v)
    }))
}

/// `POST /api/browser/profiles/{id}/cmd` `{type, params}` — the hands. Wakes
/// a sleeping profile. Audited without params (they can carry typed text).
pub(crate) async fn api_profile_cmd(
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: axum::body::Bytes,
) -> Response {
    let (cfg, c) = match caller(&st, &headers, true) {
        Ok(v) => v,
        Err(e) => return e,
    };
    if !valid_profile_id(&id) {
        return api_error(StatusCode::NOT_FOUND, "no such profile");
    }
    let Ok(parsed) = serde_json::from_slice::<Value>(&body) else {
        return api_error(StatusCode::BAD_REQUEST, "body must be JSON");
    };
    let kind = parsed["type"].as_str().unwrap_or("").to_string();
    if kind.is_empty() || kind.len() > 32 {
        return api_error(StatusCode::BAD_REQUEST, "type is required");
    }
    let forwarded: Vec<u8> = if c.is_web() {
        body.to_vec()
    } else {
        match fleet_body(&kind, &parsed["params"]) {
            Some(v) => v.to_string().into_bytes(),
            None => {
                return api_error(
                    StatusCode::FORBIDDEN,
                    "this command is for the person in the browser sheet, not for a fleet key",
                )
            }
        }
    };
    let r = browserd(
        &cfg,
        "POST",
        &format!("/profiles/{id}/cmd?{}", owner_q(&c)),
        Some(&forwarded),
    )
    .await;
    // Done acts only, verb only (params carry typed text and URLs with
    // tokens); not the sheet's 4-second `status` poll.
    if kind != "status" && matches!(&r, Ok((s, _)) if s.is_success()) {
        audit(&st, &c, "browser.profile.cmd", &id, json!({ "type": kind }));
    }
    reply(r)
}

/// `GET /api/browser/profiles/{id}/vnc` — WebSocket: the profile's screen.
/// Wakes it, then pipes RFB bytes between the viewer and Xvnc's unix socket.
pub(crate) async fn ws_profile_vnc(
    ws: WebSocketUpgrade,
    State(st): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if !ui_origin_allowed(&headers, &st.public_url, &st.ui_origins)
        || headers.get(header::ORIGIN).is_none()
    {
        return api_error(StatusCode::FORBIDDEN, "cross-origin connection refused");
    }
    let (cfg, c) = match caller(&st, &headers, true) {
        Ok(v) => v,
        Err(e) => return e,
    };
    if !c.is_web() || !valid_profile_id(&id) {
        return api_error(StatusCode::NOT_FOUND, "no such profile");
    }
    let started = browserd(
        &cfg,
        "POST",
        &format!("/profiles/{id}/start?{}", owner_q(&c)),
        Some(b"{}"),
    )
    .await;
    let container = match started {
        Ok((s, v)) if s.is_success() => v["container"].as_str().unwrap_or("").to_string(),
        other => return reply(other),
    };
    let unix = match UnixStream::connect(vnc_socket(&id)).await {
        // The socket's directory is writable by the container, so the path
        // proves nothing: a symlink there would point the hub (root) at
        // /run/docker.sock or another person's screen. Only a peer that IS
        // this profile's container, as its unprivileged user, gets bytes.
        Ok(u) if peer_is_container(&u, &container) => u,
        Ok(_) => {
            eprintln!("[browser] REFUSED: vnc socket of {id} is not its container");
            return api_error(
                StatusCode::BAD_GATEWAY,
                "browser screen failed the identity check",
            );
        }
        Err(e) => {
            eprintln!("[browser] vnc socket for {id}: {e}");
            return api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "browser screen is not up yet",
            );
        }
    };
    audit(&st, &c, "browser.profile.view", &id, json!({}));
    let owner = owner_q(&c);
    // The sign-in this screen rides on, re-checked while it stays open.
    let Some(token) = [auth_cookie_token(&headers), bearer_token(&headers)]
        .into_iter()
        .flatten()
        .find(|t| matches!(st.workspaces.authenticate(t), Ok(Some((u, _))) if u == c.user_id))
    else {
        return api_error(StatusCode::UNAUTHORIZED, "authentication required");
    };
    let user = c.user_id.clone();
    ws.protocols(["binary"])
        .max_message_size(4 * 1024 * 1024)
        .on_upgrade(move |socket| pump(socket, unix, cfg, id, owner, st, token, user))
}

/// uid inside the browser containers (`browserd.py` UID, Dockerfile `hb`).
const CONTAINER_UID: u32 = 1000;

fn valid_container_id(cid: &str) -> bool {
    cid.len() == 64
        && cid
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn peer_is_container(u: &UnixStream, container: &str) -> bool {
    if !valid_container_id(container) {
        return false;
    }
    let Ok(cred) = u.peer_cred() else {
        return false;
    };
    if cred.uid() != CONTAINER_UID {
        return false;
    }
    let Some(pid) = cred.pid() else {
        return false;
    };
    std::fs::read_to_string(format!("/proc/{pid}/cgroup")).is_ok_and(|cg| cg.contains(container))
}

/// Whether the sign-in behind an open screen still stands: not signed out,
/// not revoked, the person not suspended.
fn still_allowed(st: &AppState, token: &str, user: &str) -> bool {
    matches!(st.workspaces.authenticate(token), Ok(Some((u, _))) if u == user)
        && access_gate_state(&st.workspaces, user).is_ok()
}

async fn pump(
    socket: WebSocket,
    unix: UnixStream,
    cfg: Arc<BrowserConfig>,
    id: String,
    owner: String,
    st: AppState,
    token: String,
    user: String,
) {
    use futures_util::{SinkExt, StreamExt};
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (mut u_rx, mut u_tx) = unix.into_split();
    let to_vnc = async {
        while let Some(Ok(msg)) = ws_rx.next().await {
            let data = match msg {
                Message::Binary(b) => b,
                Message::Close(_) => break,
                _ => continue,
            };
            if u_tx.write_all(&data).await.is_err() {
                break;
            }
        }
    };
    let to_ws = async {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match u_rx.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if ws_tx
                        .send(Message::Binary(axum::body::Bytes::copy_from_slice(
                            &buf[..n],
                        )))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            }
        }
        let _ = ws_tx
            .send(Message::Close(Some(CloseFrame {
                code: 1011,
                reason: "browser screen closed".into(),
            })))
            .await;
    };
    let touch = async {
        let mut t = tokio::time::interval(TOUCH_EVERY);
        loop {
            t.tick().await;
            let _ = browserd(
                &cfg,
                "POST",
                &format!("/profiles/{id}/touch?{owner}"),
                Some(b"{}"),
            )
            .await;
        }
    };
    // A revoked session or a suspension ends the screen within REAUTH_EVERY.
    let reauth = async {
        let mut t = tokio::time::interval(REAUTH_EVERY);
        loop {
            t.tick().await;
            if !still_allowed(&st, &token, &user) {
                eprintln!("[browser] screen of {id} closed: sign-in no longer valid");
                return;
            }
        }
    };
    tokio::select! {
        _ = to_vnc => {},
        _ = to_ws => {},
        _ = touch => {},
        _ = reauth => {},
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_ids_are_strict() {
        assert!(valid_profile_id("0123456789abcdef"));
        assert!(!valid_profile_id("0123456789ABCDEF"));
        assert!(!valid_profile_id("../../etc/passwd"));
        assert!(!valid_profile_id("0123456789abcde"));
        assert!(!valid_profile_id("0123456789abcdeg"));
    }

    #[test]
    fn vnc_socket_stays_in_run_dir() {
        assert_eq!(
            vnc_socket("0123456789abcdef"),
            PathBuf::from("/run/hegai-browser/0123456789abcdef/vnc.sock")
        );
    }

    #[test]
    fn container_ids_are_strict() {
        assert!(valid_container_id(&"a".repeat(64)));
        assert!(!valid_container_id(""));
        assert!(!valid_container_id(&"a".repeat(63)));
        assert!(!valid_container_id(&"A".repeat(64)));
    }

    #[test]
    fn fleet_keys_get_narrow_hands() {
        assert!(fleet_body("eval", &json!({"js": "1"})).is_none());
        assert!(fleet_body("insert_text", &json!({})).is_none());
        assert!(fleet_body("new_tab", &json!({})).is_none());
        let nav = fleet_body("navigate", &json!({"url": "https://x", "new_tab": true})).unwrap();
        assert_eq!(
            nav,
            json!({"type": "navigate", "params": {"url": "https://x"}})
        );
        let read = fleet_body("read_text", &Value::Null).unwrap();
        assert_eq!(read, json!({"type": "read_text", "params": {}}));
    }

    #[test]
    fn a_machine_named_web_is_still_a_fleet_caller() {
        let c = Caller {
            user_id: "u".into(),
            via: Via::Fleet {
                machine_id: "web".into(),
            },
        };
        assert!(!c.is_web());
        assert!(web_only(&c).is_err());
        assert_eq!(c.source(), "web");
    }

    #[test]
    fn owner_is_url_encoded() {
        let c = Caller {
            user_id: "a b&owner=x".into(),
            via: Via::Web,
        };
        assert_eq!(owner_q(&c), "owner=a%20b%26owner%3Dx");
    }
}
