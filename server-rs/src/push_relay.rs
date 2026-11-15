//! «Наш push-релей»: phone pushes for self-hosted hubs.
//!
//! A self-hosted hub (external edition) has no APNs key / FCM service account
//! for OUR App Store / Google Play apps, so it cannot reach a phone by itself.
//! It asks our hub (code.acme.test), which holds the keys, to send the push.
//!
//! What crosses the wire is content-free by construction: `SendBody` has no
//! field for a title, an assistant text, a tool, a request id or an action
//! token - only the device token, the state and three ids. The VENDOR builds
//! the notification text itself from the state (three fixed strings).
//!
//! Two halves in one file:
//!  - vendor: `POST /api/push-relay/register` and `/send` (404 on an external
//!    hub and on a hub with neither APNs nor FCM configured);
//!  - customer: `Relay`, a backend of the notifier (`notify.rs`) that signs and
//!    posts `SendBody` to the relay.
//!
//! Registration is two-phase and not anonymous: `register/start` returns a
//! private challenge id plus a nonce; the customer publishes only the nonce and
//! calls `register/finish {challengeId}`, and the vendor fetches
//! `https://<claimed host>/.well-known/hegai-push-relay` (served by every hub
//! edition, see `api_well_known`) and requires it to return that nonce. The
//! challenge id never appears on the public page, so a reader of the nonce
//! cannot finish someone else's registration. Failure -> 422 `domain proof
//! failed` (customer pauses 1 h; 403 `revoked` pauses 24 h).
//!
//! Operator notes (vendor): revoke an instance with
//! `sqlite3 <db> "UPDATE push_relay_instances SET revoked_at=strftime('%s','now')*1000 WHERE instance_id='<id>'"`.
//! Instance secrets sit in that table in clear (HMAC needs the key itself).

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use ring::hmac;
use ring::rand::{SecureRandom, SystemRandom};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::Mutex as AsyncMutex;

use crate::hub::HubCmd;
use crate::notify::{Apns, ApnsConfig, ApnsOutcome, PushEvent};
use crate::workspace::now_ms;
use crate::*;

const TITLE: &str = "Hegai Code";
const SKEW_MS: i64 = 5 * 60 * 1000;
const MAX_TOKEN: usize = 4096;
const MAX_ID: usize = 128;
const MAX_URL: usize = 256;
const PER_MINUTE: usize = 120;
const PER_DAY: usize = 5000;
const PER_TOKEN_MS: i64 = 10_000;
const REGISTER_PER_HOUR: usize = 5;
const REGISTER_PER_DAY_ALL: usize = 200;
const MINUTE_MS: i64 = 60_000;
const DAY_MS: i64 = 24 * 60 * 60_000;
const HOUR_MS: i64 = 60 * 60_000;

/// The only text a relayed push ever carries.
fn generic_text(state: &str) -> Option<&'static str> {
    match state {
        "needs_attention" => Some("Агент ждёт ваш ответ"),
        "error" => Some("Ошибка в сессии"),
        "idle" => Some("Есть ответ в сессии"),
        _ => None,
    }
}

/// The relay request. Both sides use this one type, so what the customer sends
/// and what the vendor accepts cannot drift apart. Unknown fields are refused.
#[derive(Serialize, Deserialize, Debug, PartialEq, Eq, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct SendBody {
    pub platform: String,
    pub token: String,
    pub state: String,
    pub session_id: String,
    pub machine_id: String,
    pub user_id: String,
    /// The Android app switches to it before opening the session; without it
    /// a push from another workspace cannot be opened. Optional on the wire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

impl SendBody {
    fn validate(&self) -> Result<(), &'static str> {
        if self.platform != "ios" && self.platform != "android" {
            return Err("unknown platform");
        }
        if generic_text(&self.state).is_none() {
            return Err("unknown state");
        }
        if self.token.is_empty() || self.token.len() > MAX_TOKEN {
            return Err("bad token");
        }
        for id in [&self.session_id, &self.machine_id, &self.user_id] {
            if id.is_empty() || id.len() > MAX_ID {
                return Err("bad id");
            }
        }
        if self
            .workspace_id
            .as_ref()
            .is_some_and(|w| w.is_empty() || w.len() > MAX_ID)
        {
            return Err("bad id");
        }
        Ok(())
    }
}

fn parse_send_body(raw: &[u8]) -> Result<SendBody, &'static str> {
    let body: SendBody = serde_json::from_slice(raw).map_err(|_| "invalid body")?;
    body.validate()?;
    Ok(body)
}

// ------------------------------------------------------------- signature

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) || !s.is_ascii() {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

/// hex HMAC-SHA256(secret, `<ts>.<rawBody>`).
fn sign(secret: &str, ts_ms: i64, raw: &[u8]) -> String {
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    let mut msg = format!("{ts_ms}.").into_bytes();
    msg.extend_from_slice(raw);
    to_hex(hmac::sign(&key, &msg).as_ref())
}

/// Fresh timestamp and a constant-time signature check (`ring::hmac::verify`).
fn verify(secret: &str, ts: &str, raw: &[u8], signature: &str, now: i64) -> bool {
    let Ok(ts_ms) = ts.trim().parse::<i64>() else {
        return false;
    };
    if (now - ts_ms).abs() > SKEW_MS {
        return false;
    }
    let Some(sig) = from_hex(signature.trim()) else {
        return false;
    };
    let key = hmac::Key::new(hmac::HMAC_SHA256, secret.as_bytes());
    let mut msg = format!("{ts_ms}.").into_bytes();
    msg.extend_from_slice(raw);
    hmac::verify(&key, &msg, &sig).is_ok()
}

// ---------------------------------------------------------------- vendor

fn ensure_table(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS push_relay_instances (
            instance_id TEXT PRIMARY KEY,
            secret TEXT NOT NULL,
            public_url TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            revoked_at INTEGER,
            last_seen_at INTEGER,
            reg_host TEXT NOT NULL DEFAULT '',
            reg_ip TEXT NOT NULL DEFAULT ''
        );",
    )
}

fn random_hex(bytes: usize) -> Option<String> {
    let mut buf = vec![0u8; bytes];
    SystemRandom::new().fill(&mut buf).ok()?;
    Some(to_hex(&buf))
}

fn insert_instance(
    conn: &Connection,
    public_url: &str,
    reg_ip: &str,
    now: i64,
) -> Result<(String, String), String> {
    ensure_table(conn).map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let secret = random_hex(32).ok_or("no randomness")?;
    conn.execute(
        "INSERT INTO push_relay_instances(instance_id,secret,public_url,created_at,reg_host,reg_ip) VALUES(?1,?2,?3,?4,?5,?6)",
        params![id, secret, public_url, now, url_host(public_url), reg_ip],
    )
    .map_err(|e| e.to_string())?;
    Ok((id, secret))
}

/// The secret of a live (not revoked) instance.
fn live_secret(conn: &Connection, id: &str) -> Option<String> {
    ensure_table(conn).ok()?;
    conn.query_row(
        "SELECT secret FROM push_relay_instances WHERE instance_id=?1 AND revoked_at IS NULL",
        [id],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

fn instance_revoked(conn: &Connection, id: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM push_relay_instances WHERE instance_id=?1 AND revoked_at IS NOT NULL",
        [id],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

fn url_host(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
        .unwrap_or_default()
}

/// Registration is anonymous, so revocation cannot be bound to a verified
/// identity. It is bound to what we can see: the claimed host (case and path
/// ignored) and the registering address (/64 for IPv6). A revoked instance's
/// host or address cannot mint a new one.
fn source_revoked(conn: &Connection, public_url: &str, reg_ip: &str) -> bool {
    ensure_table(conn).is_ok()
        && conn
            .query_row(
                "SELECT 1 FROM push_relay_instances WHERE revoked_at IS NOT NULL
                   AND (reg_host=?1 OR (reg_ip<>'' AND reg_ip=?2)) LIMIT 1",
                params![url_host(public_url), reg_ip],
                |_| Ok(()),
            )
            .optional()
            .ok()
            .flatten()
            .is_some()
}

struct Senders {
    http: reqwest::Client,
    apns: Option<(Apns, ApnsConfig)>,
    route: HashMap<String, bool>,
    fcm: Option<crate::fcm::Fcm>,
}

static SENDERS: tokio::sync::OnceCell<Option<AsyncMutex<Senders>>> =
    tokio::sync::OnceCell::const_new();

/// The vendor's senders, or `None` when this hub is not the vendor (external
/// edition) or holds neither key: then the relay endpoints do not exist.
async fn senders() -> Option<&'static AsyncMutex<Senders>> {
    if crate::edition::is_external() {
        return None;
    }
    SENDERS
        .get_or_init(|| async {
            let apns = ApnsConfig::from_env()
                .and_then(|cfg| crate::notify::build_apns(&cfg).map(|a| (a, cfg)));
            let fcm = crate::fcm::Fcm::from_env();
            if apns.is_none() && fcm.is_none() {
                return None;
            }
            let http = reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap_or_default();
            Some(AsyncMutex::new(Senders {
                http,
                apns,
                route: HashMap::new(),
                fcm,
            }))
        })
        .await
        .as_ref()
}

fn status_json(status: StatusCode, message: &str) -> Response {
    api_error(status, message)
}

fn valid_public_url(url: &str) -> bool {
    url.len() <= MAX_URL
        && url.starts_with("https://")
        && reqwest::Url::parse(url).is_ok_and(|u| u.host_str().is_some())
}

// ---------------------------------------------------------- domain proof

const PROOF_PATH: &str = "/.well-known/hegai-push-relay";
const NONCE_TTL: Duration = Duration::from_secs(120);
const PROOF_MAX_BYTES: usize = 256;

type NonceSlot = std::sync::Mutex<Option<(String, Instant)>>;

/// The nonce of the registration this (customer) hub has in flight.
static PENDING_NONCE: NonceSlot = std::sync::Mutex::new(None);

fn fresh_nonce(slot: &NonceSlot, now: Instant) -> Option<String> {
    let guard = slot.lock().ok()?;
    guard
        .as_ref()
        .filter(|(_, at)| now.saturating_duration_since(*at) < NONCE_TTL)
        .map(|(n, _)| n.clone())
}

/// `GET /.well-known/hegai-push-relay`: public, every edition. The pending
/// nonce (valid 2 minutes) or 404.
pub(crate) async fn api_well_known() -> Response {
    match fresh_nonce(&PENDING_NONCE, Instant::now()) {
        Some(n) => (
            [
                (
                    axum::http::header::CONTENT_TYPE,
                    "text/plain; charset=utf-8",
                ),
                (axum::http::header::CACHE_CONTROL, "no-store"),
            ],
            n,
        )
            .into_response(),
        None => (
            StatusCode::NOT_FOUND,
            [(axum::http::header::CACHE_CONTROL, "no-store")],
        )
            .into_response(),
    }
}

/// Not a destination a customer hub can legitimately have: loopback, private,
/// link-local, unique-local, unspecified, multicast, CGNAT, documentation,
/// benchmarking, reserved. IPv4-mapped / NAT64 IPv6 follow their IPv4 part.
fn is_public_ip(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_multicast()
                || v4.is_broadcast()
                || v4.is_documentation()
                || o[0] == 0
                || (o[0] == 100 && (o[1] & 0xc0) == 64) // 100.64.0.0/10
                || (o[0] == 192 && o[1] == 0 && o[2] == 0) // 192.0.0.0/24
                || (o[0] == 198 && (o[1] & 0xfe) == 18) // 198.18.0.0/15
                || o[0] >= 240)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(v4));
            }
            let s = v6.segments();
            if s[0] == 0x64 && s[1] == 0xff9b && s[2..6].iter().all(|x| *x == 0) {
                // 64:ff9b::/96 embeds an IPv4 address in the last 32 bits
                let v4 = std::net::Ipv4Addr::new(
                    (s[6] >> 8) as u8,
                    s[6] as u8,
                    (s[7] >> 8) as u8,
                    s[7] as u8,
                );
                return is_public_ip(IpAddr::V4(v4));
            }
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // fc00::/7
                || (s[0] & 0xffc0) == 0xfe80 // fe80::/10
                || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation
                || (s[0] == 0x0100 && s[1..4].iter().all(|x| *x == 0))) // discard-only
        }
    }
}

/// Where the proof is fetched: the HOST of the claimed URL only (path, query
/// and credentials ignored). https on 443, and a name, not an address literal.
fn proof_host(public_url: &str) -> Option<String> {
    let u = reqwest::Url::parse(public_url).ok()?;
    if u.scheme() != "https" || u.port().is_some() {
        return None;
    }
    let h = u.host_str()?.to_ascii_lowercase();
    // an address literal (v4, or v6 in brackets) is not a name
    if h.starts_with('[') || h.parse::<std::net::IpAddr>().is_ok() {
        return None;
    }
    Some(h)
}

/// Constant-time equality (length is not secret: nonces have a fixed size).
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Fetch `https://<host>/.well-known/hegai-push-relay` from the resolved,
/// checked address only and compare it with the nonce.
async fn prove_domain(public_url: &str, nonce: &str) -> bool {
    if nonce.len() < 32 || nonce.len() > 128 {
        return false;
    }
    let Some(host) = proof_host(public_url) else {
        return false;
    };
    let Ok(addrs) = tokio::net::lookup_host((host.as_str(), 443)).await else {
        return false;
    };
    let addrs: Vec<_> = addrs.collect();
    if addrs.is_empty() || !addrs.iter().all(|a| is_public_ip(a.ip())) {
        return false;
    }
    let Ok(client) = reqwest::Client::builder()
        .resolve(&host, addrs[0])
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
    else {
        return false;
    };
    let Ok(mut resp) = client
        .get(format!("https://{host}{PROOF_PATH}"))
        .send()
        .await
    else {
        return false;
    };
    if !resp.status().is_success() {
        return false;
    }
    let mut got: Vec<u8> = Vec::new();
    while let Ok(Some(chunk)) = resp.chunk().await {
        got.extend_from_slice(&chunk);
        if got.len() > PROOF_MAX_BYTES {
            return false;
        }
    }
    let Ok(text) = std::str::from_utf8(&got) else {
        return false;
    };
    ct_eq(text.trim().as_bytes(), nonce.as_bytes())
}

const CHALLENGE_TTL: Duration = Duration::from_secs(120);
const MAX_CHALLENGES: usize = 1000;
const FINISH_PER_HOUR: usize = 10;

struct Challenge {
    nonce: String,
    public_url: String,
    expires: Instant,
}

type Challenges = std::sync::Mutex<HashMap<String, (Challenge, Instant)>>;

/// Open registrations, in memory: id -> challenge (+ creation time for eviction).
static CHALLENGES: std::sync::LazyLock<Challenges> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

/// Remember a challenge; expired ones go first, then the oldest, so the map
/// never holds more than `MAX_CHALLENGES`.
fn challenge_put(map: &Challenges, id: String, c: Challenge, now: Instant) -> bool {
    let Ok(mut m) = map.lock() else {
        return false;
    };
    m.retain(|_, (c, _)| c.expires > now);
    while m.len() >= MAX_CHALLENGES {
        let Some(oldest) = m
            .iter()
            .min_by_key(|(_, (_, at))| *at)
            .map(|(k, _)| k.clone())
        else {
            break;
        };
        m.remove(&oldest);
    }
    m.insert(id, (c, now));
    true
}

/// Single use: the challenge is removed whether or not it is still fresh.
fn challenge_take(map: &Challenges, id: &str, now: Instant) -> Option<Challenge> {
    let (c, _) = map.lock().ok()?.remove(id)?;
    (c.expires > now).then_some(c)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StartBody {
    public_url: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FinishBody {
    challenge_id: String,
}

fn register_ip(peer: std::net::SocketAddr, headers: &HeaderMap) -> String {
    crate::rate_window::rate_ip(Some(&client_address(peer, headers))).unwrap_or_default()
}

/// `POST /api/push-relay/register/start` `{publicUrl}` -> `{challengeId, nonce}`.
/// The id is the secret half (only the caller sees it); the nonce is what the
/// caller publishes at the well-known path.
pub(crate) async fn api_register_start(
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    State(st): State<AppState>,
    headers: HeaderMap,
    raw: Bytes,
) -> Response {
    if senders().await.is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let reg_ip = register_ip(peer, &headers);
    if let Err(r) = admit_all(
        &st,
        &[(
            format!("push-relay-start:{reg_ip}"),
            REGISTER_PER_HOUR,
            HOUR_MS,
        )],
        "too many registrations",
    ) {
        return r;
    }
    let Ok(body) = serde_json::from_slice::<StartBody>(&raw) else {
        return status_json(StatusCode::BAD_REQUEST, "invalid body");
    };
    if !valid_public_url(&body.public_url) || proof_host(&body.public_url).is_none() {
        return status_json(
            StatusCode::BAD_REQUEST,
            "publicUrl must be https on 443, a DNS name, up to 256 chars",
        );
    }
    if st
        .workspaces
        .conn
        .lock()
        .is_ok_and(|conn| source_revoked(&conn, &body.public_url, &reg_ip))
    {
        return status_json(StatusCode::FORBIDDEN, "revoked");
    }
    let (Some(id), Some(nonce)) = (random_hex(32), random_hex(32)) else {
        return status_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
    };
    let now = Instant::now();
    let c = Challenge {
        nonce: nonce.clone(),
        public_url: body.public_url,
        expires: now + CHALLENGE_TTL,
    };
    if !challenge_put(&CHALLENGES, id.clone(), c, now) {
        return status_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error");
    }
    Json(json!({"challengeId": id, "nonce": nonce})).into_response()
}

/// `POST /api/push-relay/register/finish` `{challengeId}` -> `{instanceId, secret}`.
pub(crate) async fn api_register_finish(
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    State(st): State<AppState>,
    headers: HeaderMap,
    raw: Bytes,
) -> Response {
    if senders().await.is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let reg_ip = register_ip(peer, &headers);
    if let Err(r) = admit_all(
        &st,
        &[(
            format!("push-relay-finish:{reg_ip}"),
            FINISH_PER_HOUR,
            HOUR_MS,
        )],
        "too many registrations",
    ) {
        return r;
    }
    let Ok(body) = serde_json::from_slice::<FinishBody>(&raw) else {
        return status_json(StatusCode::BAD_REQUEST, "invalid body");
    };
    if body.challenge_id.len() > MAX_ID {
        return status_json(StatusCode::BAD_REQUEST, "invalid body");
    }
    // Taken (removed) first: one challenge, one proof attempt.
    let Some(c) = challenge_take(&CHALLENGES, &body.challenge_id, Instant::now()) else {
        return status_json(StatusCode::UNPROCESSABLE_ENTITY, "domain proof failed");
    };
    if !prove_domain(&c.public_url, &c.nonce).await {
        return status_json(StatusCode::UNPROCESSABLE_ENTITY, "domain proof failed");
    }
    // The ceiling for everyone together counts only proven registrations, so
    // garbage cannot burn it.
    if let Err(r) = admit_all(
        &st,
        &[(
            "push-relay-register:all".to_string(),
            REGISTER_PER_DAY_ALL,
            DAY_MS,
        )],
        "too many registrations",
    ) {
        return r;
    }
    let made = match st.workspaces.conn.lock() {
        Ok(conn) if source_revoked(&conn, &c.public_url, &reg_ip) => {
            return status_json(StatusCode::FORBIDDEN, "revoked");
        }
        Ok(conn) => insert_instance(&conn, &c.public_url, &reg_ip, now_ms()),
        Err(_) => Err("lock poisoned".into()),
    };
    match made {
        Ok((id, secret)) => {
            println!("[push-relay] registered instance {id}");
            Json(json!({"instanceId": id, "secret": secret})).into_response()
        }
        Err(e) => {
            eprintln!("[push-relay] register failed: {e}");
            status_json(StatusCode::INTERNAL_SERVER_ERROR, "internal error")
        }
    }
}

/// What the vendor sends to APNs: fixed text, thread and ids, no category (so
/// no action buttons) and no `act`. `private` keeps the app from offering a
/// one-tap answer from the banner.
fn ios_payload(b: &SendBody) -> Value {
    let text = generic_text(&b.state).unwrap_or("");
    let mut payload = json!({
        "aps": {
            "alert": {"title": TITLE, "body": text},
            "sound": "default",
            "thread-id": b.session_id,
            "interruption-level": if b.state == "needs_attention" { "time-sensitive" } else { "active" },
            "mutable-content": 0
        },
        "machineId": b.machine_id,
        "sessionId": b.session_id,
        "state": b.state,
        "private": true
    });
    if let Some(w) = &b.workspace_id {
        payload["workspaceId"] = json!(w);
    }
    payload
}

/// Data-only FCM message; the app shows it only if `userId` is the signed-in
/// owner, so the customer hub's user id passes through untouched.
fn android_message(b: &SendBody) -> Value {
    let text = generic_text(&b.state).unwrap_or("");
    let mut data = json!({
        "userId": b.user_id, "machineId": b.machine_id, "sessionId": b.session_id,
        "state": b.state, "title": text, "private": "true",
        // The app keys the notification by runId and drops a push without
        // one; the session id stands in (no decision intents: no requestId).
        "runId": b.session_id
    });
    if let Some(w) = &b.workspace_id {
        data["workspaceId"] = json!(w);
    }
    json!({"message": {
        "token": b.token,
        "android": {"priority": "high", "ttl": "300s"},
        "data": data
    }})
}

fn token_key(token: &str) -> String {
    format!(
        "push-relay-token:{}",
        to_hex(&Sha256::digest(token.as_bytes()))
    )
}

/// Check every `(key, limit, window)` against one `now` and record all of them,
/// under ONE lock: concurrent requests cannot all pass before any is counted.
/// Nothing is recorded unless every check passes.
fn admit_all(st: &AppState, checks: &[(String, usize, i64)], why: &str) -> Result<(), Response> {
    let Ok(mut log) = st.window_log.lock() else {
        return Err(api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "rate limiter unavailable",
        ));
    };
    let now = now_ms();
    let mut keys = Vec::with_capacity(checks.len());
    for (key, limit, window) in checks {
        match log.check(key, *limit, *window, now) {
            Ok(k) => keys.push(k),
            Err(()) => return Err(refusal(StatusCode::TOO_MANY_REQUESTS, why)),
        }
    }
    for (k, (_, _, window)) in keys.iter().zip(checks) {
        log.record(k, *window, now);
    }
    Ok(())
}

/// Per instance (minute, day) and per token (one per 10 s). Checked together,
/// counted only when all pass.
fn admit(st: &AppState, instance: &str, token: &str, state: &str) -> Result<(), Response> {
    // Per token AND state: «needs attention» then «idle» seconds later are
    // two different pushes, a repeat of the same state is not.
    admit_all(
        st,
        &[
            (format!("push-relay-min:{instance}"), PER_MINUTE, MINUTE_MS),
            (format!("push-relay-day:{instance}"), PER_DAY, DAY_MS),
            (format!("{}:{state}", token_key(token)), 1, PER_TOKEN_MS),
        ],
        "rate limit",
    )
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> &'a str {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
}

/// `POST /api/push-relay/send`: 200 sent, 410 token dead, 429 limit, 401 auth.
pub(crate) async fn api_send(
    State(st): State<AppState>,
    headers: HeaderMap,
    raw: Bytes,
) -> Response {
    let Some(senders) = senders().await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let unauthorized = || status_json(StatusCode::UNAUTHORIZED, "unauthorized");
    let instance = header(&headers, "x-relay-instance").to_string();
    if instance.is_empty() || instance.len() > MAX_ID {
        return unauthorized();
    }
    let secret = match st.workspaces.conn.lock() {
        Ok(conn) => live_secret(&conn, &instance),
        Err(_) => None,
    };
    let Some(secret) = secret else {
        // Revoked is final: 403 tells the customer hub to stop, where a 401
        // would make it register a fresh instance and carry on.
        let revoked = st
            .workspaces
            .conn
            .lock()
            .ok()
            .is_some_and(|conn| instance_revoked(&conn, &instance));
        return if revoked {
            status_json(StatusCode::FORBIDDEN, "revoked")
        } else {
            unauthorized()
        };
    };
    if !verify(
        &secret,
        header(&headers, "x-relay-timestamp"),
        &raw,
        header(&headers, "x-relay-signature"),
        now_ms(),
    ) {
        return unauthorized();
    }
    if let Ok(conn) = st.workspaces.conn.lock() {
        let _ = conn.execute(
            "UPDATE push_relay_instances SET last_seen_at=?2 WHERE instance_id=?1",
            params![instance, now_ms()],
        );
    }
    let body = match parse_send_body(&raw) {
        Ok(b) => b,
        Err(e) => return status_json(StatusCode::BAD_REQUEST, e),
    };
    if let Err(r) = admit(&st, &instance, &body.token, &body.state) {
        return r;
    }
    let mut s = senders.lock().await;
    let s = &mut *s;
    let outcome = if body.platform == "ios" {
        let Some((apns, cfg)) = s.apns.as_mut() else {
            return status_json(StatusCode::SERVICE_UNAVAILABLE, "ios push not configured");
        };
        match crate::notify::send_prebuilt(
            apns,
            cfg,
            &mut s.route,
            &body.token,
            &body.session_id,
            &ios_payload(&body),
        )
        .await
        {
            ApnsOutcome::Sent => Delivery::Sent,
            ApnsOutcome::WrongEnvironment | ApnsOutcome::Unregistered(_) => Delivery::Dead,
            ApnsOutcome::Failed => Delivery::Failed,
        }
    } else {
        let Some(fcm) = s.fcm.as_mut() else {
            return status_json(
                StatusCode::SERVICE_UNAVAILABLE,
                "android push not configured",
            );
        };
        match fcm.post_message(&s.http, &android_message(&body)).await {
            crate::fcm::FcmOutcome::Sent => Delivery::Sent,
            crate::fcm::FcmOutcome::Unregistered => Delivery::Dead,
            crate::fcm::FcmOutcome::Failed => Delivery::Failed,
        }
    };
    // Counts only: never the token.
    println!(
        "[push-relay] instance={instance} platform={} state={} -> {}",
        body.platform,
        body.state,
        match outcome {
            Delivery::Sent => "sent",
            Delivery::Dead => "unregistered",
            Delivery::Failed => "failed",
        }
    );
    match outcome {
        Delivery::Sent => Json(json!({"ok": true})).into_response(),
        Delivery::Dead => status_json(StatusCode::GONE, "token unregistered"),
        Delivery::Failed => status_json(StatusCode::BAD_GATEWAY, "push provider failed"),
    }
}

enum Delivery {
    Sent,
    Dead,
    Failed,
}

// -------------------------------------------------------------- customer

#[derive(Serialize, Deserialize, Clone)]
struct Creds {
    #[serde(rename = "instanceId")]
    instance_id: String,
    secret: String,
    #[serde(rename = "relayUrl")]
    relay_url: String,
}

/// Notifier backend of an external-edition hub with no push keys of its own.
pub(crate) struct Relay {
    http: reqwest::Client,
    url: String,
    public_url: String,
    state_path: PathBuf,
    creds: Option<Creds>,
    /// After a failed registration: do not try again before this.
    retry_after: Option<Instant>,
}

/// Explicit opt-in: only `on` / `1` / `true` / `yes`; unset means off.
fn relay_on(v: Option<&str>) -> bool {
    matches!(
        v.map(|s| s.trim().to_ascii_lowercase()).as_deref(),
        Some("on" | "1" | "true" | "yes")
    )
}

fn relay_url_ok(url: &str) -> bool {
    let Ok(u) = reqwest::Url::parse(url) else {
        return false;
    };
    match u.scheme() {
        "https" => u.host_str().is_some(),
        "http" => matches!(u.host_str(), Some("localhost" | "127.0.0.1")),
        _ => false,
    }
}

fn data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("CC_REMOTE_DATA_DIR") {
        return PathBuf::from(d);
    }
    std::env::var("CC_REMOTE_DB_PATH")
        .ok()
        .map(PathBuf::from)
        .and_then(|p| p.parent().map(PathBuf::from))
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn write_private(path: &std::path::Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = path.with_extension("tmp");
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&tmp)?;
    f.write_all(data)?;
    f.sync_all()?;
    std::fs::rename(&tmp, path)
}

impl Relay {
    /// `None` (with one log line) when switched off or the hub does not know
    /// its own public address.
    pub(crate) fn from_env() -> Option<Self> {
        if !relay_on(std::env::var("CC_REMOTE_PUSH_RELAY").ok().as_deref()) {
            println!(
                "[notify] push relay off: set CC_REMOTE_PUSH_RELAY=on to deliver phone pushes via HegAI"
            );
            return None;
        }
        let public_url = std::env::var("CC_REMOTE_PUBLIC_URL")
            .ok()
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty());
        let Some(public_url) = public_url else {
            println!("[notify] push relay disabled: CC_REMOTE_PUBLIC_URL is not set");
            return None;
        };
        // No baked-in default: the public source snapshot does not name the
        // vendor's host (the export rewrites it), so the address comes from
        // the vendor, like CC_REMOTE_APP_DL.
        let url = std::env::var("CC_REMOTE_PUSH_RELAY_URL")
            .ok()
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty());
        let Some(url) = url else {
            println!("[notify] push relay disabled: set CC_REMOTE_PUSH_RELAY_URL to the relay address your vendor gave you");
            return None;
        };
        if !relay_url_ok(&url) {
            println!("[notify] push relay disabled: CC_REMOTE_PUSH_RELAY_URL must be https");
            return None;
        }
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .ok()?;
        let state_path = data_dir().join("push-relay.json");
        let creds = std::fs::read(&state_path)
            .ok()
            .and_then(|d| serde_json::from_slice::<Creds>(&d).ok())
            .filter(|c| c.relay_url == url);
        Some(Relay {
            http,
            url,
            public_url,
            state_path,
            creds,
            retry_after: None,
        })
    }

    /// One POST to the relay; `Err` is how long to stay quiet afterwards.
    async fn call(&self, path: &str, body: &Value) -> Result<Value, Duration> {
        let result = self
            .http
            .post(format!("{}/api/push-relay/{path}", self.url))
            .json(body)
            .send()
            .await;
        match result {
            Ok(r) if r.status().is_success() => r
                .json::<Value>()
                .await
                .map_err(|_| Duration::from_secs(300)),
            Ok(r) if r.status() == reqwest::StatusCode::UNPROCESSABLE_ENTITY => {
                eprintln!(
                    "[notify] push relay could not verify CC_REMOTE_PUBLIC_URL (it must be a public https name on 443 serving /.well-known/hegai-push-relay); pausing 1 h"
                );
                Err(Duration::from_secs(3600))
            }
            Ok(r) if r.status() == reqwest::StatusCode::FORBIDDEN => {
                eprintln!("[notify] push relay refused this hub (revoked); pausing 24 h");
                Err(Duration::from_secs(86_400))
            }
            Ok(r) => {
                eprintln!(
                    "[notify] push relay registration failed: HTTP {}",
                    r.status()
                );
                Err(Duration::from_secs(300))
            }
            Err(_) => {
                eprintln!("[notify] push relay registration failed (network/timeout)");
                Err(Duration::from_secs(300))
            }
        }
    }

    /// Two phases: `start` returns a private challenge id and the nonce; only
    /// the nonce is published, the id never leaves this hub and the relay.
    async fn register_flow(&self) -> Result<Value, Duration> {
        let started = self
            .call("register/start", &json!({"publicUrl": self.public_url}))
            .await?;
        let (Some(id), Some(nonce)) = (
            started.get("challengeId").and_then(Value::as_str),
            started.get("nonce").and_then(Value::as_str),
        ) else {
            return Err(Duration::from_secs(300));
        };
        if let Ok(mut slot) = PENDING_NONCE.lock() {
            *slot = Some((nonce.to_string(), Instant::now()));
        }
        self.call("register/finish", &json!({"challengeId": id}))
            .await
    }

    async fn register(&mut self) -> Option<Creds> {
        if self.retry_after.is_some_and(|t| Instant::now() < t) {
            return None;
        }
        let parsed = self.register_flow().await;
        if let Ok(mut slot) = PENDING_NONCE.lock() {
            *slot = None;
        }
        let parsed = match parsed {
            Ok(v) => Some(v),
            Err(pause) => {
                self.retry_after = Some(Instant::now() + pause);
                return None;
            }
        };
        let creds = parsed.and_then(|v| {
            Some(Creds {
                instance_id: v.get("instanceId")?.as_str()?.to_string(),
                secret: v.get("secret")?.as_str()?.to_string(),
                relay_url: self.url.clone(),
            })
        });
        let Some(creds) = creds.filter(|c| !c.instance_id.is_empty() && !c.secret.is_empty())
        else {
            self.retry_after = Some(Instant::now() + Duration::from_secs(300));
            return None;
        };
        if let Ok(data) = serde_json::to_vec(&creds) {
            if let Err(e) = write_private(&self.state_path, &data) {
                eprintln!("[notify] push relay state not saved: {e}");
            }
        }
        println!("[notify] push relay registered");
        self.creds = Some(creds.clone());
        Some(creds)
    }

    /// One signed POST. `Ok(status)`; network errors are `Err`.
    async fn post(&self, creds: &Creds, body: &SendBody) -> Result<reqwest::StatusCode, ()> {
        let raw = serde_json::to_vec(body).map_err(|_| ())?;
        let ts = now_ms();
        let signature = sign(&creds.secret, ts, &raw);
        self.http
            .post(format!("{}/api/push-relay/send", self.url))
            .header("content-type", "application/json")
            .header("x-relay-instance", &creds.instance_id)
            .header("x-relay-timestamp", ts.to_string())
            .header("x-relay-signature", signature)
            .body(raw)
            .send()
            .await
            .map(|r| r.status())
            .map_err(|_| eprintln!("[notify] push relay request failed (network/timeout)"))
    }

    pub(crate) async fn send(&mut self, event: &PushEvent, hub: &UnboundedSender<HubCmd>) {
        let bodies = relay_requests(event);
        if bodies.is_empty() {
            return;
        }
        let mut creds = match self.creds.clone() {
            Some(c) => c,
            None => match self.register().await {
                Some(c) => c,
                None => return,
            },
        };
        let mut reregistered = false;
        for (registered, body) in bodies {
            let sent_at = now_ms();
            let mut status = self.post(&creds, &body).await;
            if status == Ok(reqwest::StatusCode::UNAUTHORIZED) && !reregistered {
                reregistered = true;
                self.creds = None;
                match self.register().await {
                    Some(fresh) => {
                        creds = fresh;
                        status = self.post(&creds, &body).await;
                        if status == Ok(reqwest::StatusCode::UNAUTHORIZED) {
                            // A fresh secret refused too: our clock, not the
                            // secret. Do not mint an instance per event.
                            eprintln!("[notify] push relay: signature refused, check the clock; pausing 1 h");
                            self.creds = None;
                            self.retry_after = Some(Instant::now() + Duration::from_secs(3600));
                            return;
                        }
                    }
                    None => return,
                }
            }
            match status {
                Ok(s) if s.is_success() => {}
                Ok(reqwest::StatusCode::GONE) => {
                    let _ = hub.send(HubCmd::PrunePushToken {
                        token: registered,
                        invalidated_at_ms: Some(sent_at),
                    });
                }
                Ok(reqwest::StatusCode::TOO_MANY_REQUESTS) => {
                    eprintln!("[notify] push relay: rate limited, push dropped");
                }
                Ok(reqwest::StatusCode::FORBIDDEN) => {
                    eprintln!(
                        "[notify] push relay: this hub was revoked by the relay; pausing 24 h"
                    );
                    self.creds = None;
                    self.retry_after = Some(Instant::now() + Duration::from_secs(86_400));
                    return;
                }
                Ok(s) => eprintln!("[notify] push relay send failed: HTTP {s}, push dropped"),
                Err(()) => {}
            }
        }
    }
}

/// One content-free request per device. Everything else in the event (title,
/// machine name, tool, request id, assistant text, action token) is dropped
/// here, before anything is serialised. The `String` is the token as the hub
/// registered it (android tokens carry the `fcm:` prefix), for pruning.
fn relay_requests(ev: &PushEvent) -> Vec<(String, SendBody)> {
    let Some(owner) = ev.owner_user_id.as_ref() else {
        return Vec::new();
    };
    ev.device_tokens
        .iter()
        .filter_map(|registered| {
            let (platform, token) = match registered.strip_prefix("fcm:") {
                Some(t) => ("android", t),
                None => ("ios", registered.as_str()),
            };
            let body = SendBody {
                platform: platform.into(),
                token: token.into(),
                state: ev.state.clone(),
                session_id: ev.session_id.clone(),
                machine_id: ev.machine_id.clone(),
                user_id: owner.clone(),
                workspace_id: ev.workspace_id.clone(),
            };
            body.validate().ok()?;
            Some((registered.clone(), body))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rate_window::WindowLog;

    fn body() -> SendBody {
        SendBody {
            platform: "ios".into(),
            token: "abc123".into(),
            state: "needs_attention".into(),
            session_id: "sess-1".into(),
            machine_id: "mac-1".into(),
            user_id: "user-1".into(),
            workspace_id: None,
        }
    }

    #[test]
    fn signature_ok_bad_and_stale() {
        let raw = serde_json::to_vec(&body()).unwrap();
        let now = 1_000_000_000_000;
        let sig = sign("s3cret", now, &raw);
        assert!(verify("s3cret", &now.to_string(), &raw, &sig, now + 1000));
        assert!(!verify("other", &now.to_string(), &raw, &sig, now));
        let mut tampered = raw.clone();
        tampered.push(b' ');
        assert!(!verify("s3cret", &now.to_string(), &tampered, &sig, now));
        assert!(!verify("s3cret", &now.to_string(), &raw, "zz", now));
        // stale and far-future timestamps, even with a valid signature
        assert!(!verify(
            "s3cret",
            &now.to_string(),
            &raw,
            &sig,
            now + SKEW_MS + 1
        ));
        assert!(!verify(
            "s3cret",
            &now.to_string(),
            &raw,
            &sig,
            now - SKEW_MS - 1
        ));
        // a timestamp swapped under the same signature
        assert!(!verify("s3cret", &(now + 1).to_string(), &raw, &sig, now));
    }

    #[test]
    fn strict_body_rejects_extra_fields_and_oversize() {
        let good = serde_json::to_vec(&body()).unwrap();
        assert!(parse_send_body(&good).is_ok());
        let mut v: Value = serde_json::from_slice(&good).unwrap();
        v["title"] = json!("secret plan");
        assert!(parse_send_body(&serde_json::to_vec(&v).unwrap()).is_err());
        for (field, len) in [("token", MAX_TOKEN + 1), ("sessionId", MAX_ID + 1)] {
            let mut v: Value = serde_json::from_slice(&good).unwrap();
            v[field] = json!("x".repeat(len));
            assert!(parse_send_body(&serde_json::to_vec(&v).unwrap()).is_err());
        }
        let mut v: Value = serde_json::from_slice(&good).unwrap();
        v["state"] = json!("running");
        assert!(parse_send_body(&serde_json::to_vec(&v).unwrap()).is_err());
        v = serde_json::from_slice(&good).unwrap();
        v["platform"] = json!("web");
        assert!(parse_send_body(&serde_json::to_vec(&v).unwrap()).is_err());
    }

    #[test]
    fn vendor_payloads_carry_only_generic_text() {
        for state in ["needs_attention", "error", "idle"] {
            let mut b = body();
            b.state = state.into();
            let ios = ios_payload(&b);
            assert_eq!(ios["aps"]["alert"]["title"], TITLE);
            assert_eq!(ios["aps"]["alert"]["body"], generic_text(state).unwrap());
            assert_eq!(ios["aps"]["thread-id"], "sess-1");
            assert!(ios["aps"].get("category").is_none());
            assert!(ios.get("act").is_none() && ios.get("requestId").is_none());
            assert!(ios.get("tool").is_none() && ios["aps"]["alert"].get("subtitle").is_none());
            assert_eq!(ios["private"], true);
            let android = android_message(&b);
            let data = android["message"]["data"].as_object().unwrap();
            assert_eq!(data["title"], generic_text(state).unwrap());
            assert_eq!(data["userId"], "user-1");
            assert_eq!(data["private"], "true");
            assert!(data.values().all(Value::is_string));
            assert!(android["message"].get("notification").is_none());
            let mut keys: Vec<_> = data.keys().cloned().collect();
            keys.sort();
            assert_eq!(
                keys,
                [
                    "machineId",
                    "private",
                    "runId",
                    "sessionId",
                    "state",
                    "title",
                    "userId"
                ]
            );
        }
    }

    #[test]
    fn customer_request_has_no_session_content() {
        let ev = PushEvent {
            run_id: "run-1".into(),
            title: "Deploy the secret project".into(),
            machine: "Owner's Mac".into(),
            machine_id: "mac-1".into(),
            session_id: "sess-1".into(),
            state: "needs_attention".into(),
            request_id: Some("req-1".into()),
            tool: Some("Bash".into()),
            device_tokens: vec!["fcm:andtok".into(), "iostok".into()],
            owner_user_id: Some("user-1".into()),
            workspace_id: Some("ws".into()),
            content: crate::push_payload::PushContent {
                assistant_text: "the password is hunter2".into(),
                act: Some("act-token".into()),
                ..Default::default()
            },
        };
        let reqs = relay_requests(&ev);
        assert_eq!(reqs.len(), 2);
        assert_eq!(reqs[0].0, "fcm:andtok");
        assert_eq!(reqs[0].1.platform, "android");
        assert_eq!(reqs[0].1.token, "andtok");
        assert_eq!(reqs[1].1.platform, "ios");
        for (_, b) in &reqs {
            let wire = serde_json::to_string(b).unwrap();
            for leaked in [
                "secret project",
                "Mac",
                "req-1",
                "Bash",
                "hunter2",
                "act-token",
                "run-1",
            ] {
                assert!(!wire.contains(leaked), "{leaked} leaked: {wire}");
            }
            let keys: Vec<_> = serde_json::to_value(b)
                .unwrap()
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect();
            assert_eq!(keys.len(), 7); // six ids/fields + workspaceId
        }
        let mut anon = ev.clone();
        anon.owner_user_id = None;
        assert!(relay_requests(&anon).is_empty());
    }

    #[test]
    fn per_token_window_allows_one_per_ten_seconds() {
        let mut log = WindowLog::default();
        let key = token_key("tok");
        let k = log.check(&key, 1, PER_TOKEN_MS, 0).unwrap();
        log.record(&k, PER_TOKEN_MS, 0);
        assert!(log.check(&key, 1, PER_TOKEN_MS, 5_000).is_err());
        assert!(log
            .check(&token_key("other"), 1, PER_TOKEN_MS, 5_000)
            .is_ok());
        assert!(log.check(&key, 1, PER_TOKEN_MS, 10_001).is_ok());
        assert!(!key.contains("tok:") && key.len() > 40);
    }

    #[test]
    fn instances_register_authenticate_and_revoke() {
        let conn = Connection::open_in_memory().unwrap();
        let (id, secret) =
            insert_instance(&conn, "https://hub.example.com", "203.0.113.7", 1).unwrap();
        assert_eq!(secret.len(), 64);
        assert_eq!(live_secret(&conn, &id), Some(secret));
        assert_eq!(live_secret(&conn, "nope"), None);
        conn.execute(
            "UPDATE push_relay_instances SET revoked_at=5 WHERE instance_id=?1",
            [&id],
        )
        .unwrap();
        assert_eq!(live_secret(&conn, &id), None);
        assert!(instance_revoked(&conn, &id));
        // Same host in another spelling, or the same address: refused.
        assert!(source_revoked(
            &conn,
            "https://HUB.example.com/x",
            "198.51.100.1"
        ));
        assert!(source_revoked(
            &conn,
            "https://other.example",
            "203.0.113.7"
        ));
        assert!(!source_revoked(
            &conn,
            "https://other.example",
            "198.51.100.1"
        ));
    }

    #[test]
    fn urls_and_switch() {
        assert!(valid_public_url("https://hub.example.com"));
        assert!(!valid_public_url("http://hub.example.com"));
        assert!(!valid_public_url(&format!(
            "https://{}.com",
            "a".repeat(300)
        )));
        assert!(relay_on(Some("on")) && relay_on(Some(" YES ")) && relay_on(Some("1")));
        assert!(relay_on(Some("True")));
        assert!(!relay_on(None) && !relay_on(Some("off")) && !relay_on(Some("")));
        assert!(relay_url_ok("https://code.acme.test") && !relay_url_ok("http://evil.test"));
        assert!(relay_url_ok("http://localhost:8080") && relay_url_ok("http://127.0.0.1:9"));
        for bad in [
            "http://localhost.evil.example",
            "http://localhost@evil.example",
            "http://127.0.0.1.evil.example",
            "ftp://localhost",
            "not a url",
        ] {
            assert!(!relay_url_ok(bad), "{bad}");
        }
    }

    #[test]
    fn private_addresses_are_not_public() {
        for bad in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.5.5",
            "192.168.1.1",
            "169.254.169.254",
            "0.0.0.0",
            "100.64.0.1",
            "100.127.255.255",
            "192.0.2.5",
            "198.51.100.1",
            "203.0.113.9",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "::",
            "::ffff:10.0.0.1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "febf::1",
            "ff02::1",
            "2001:db8::1",
            "64:ff9b::a00:1",
        ] {
            assert!(!is_public_ip(bad.parse().unwrap()), "{bad}");
        }
        for good in [
            "8.8.8.8",
            "1.1.1.1",
            "100.63.0.1",
            "100.128.0.1",
            "2606:4700::1111",
            "::ffff:8.8.8.8",
        ] {
            assert!(is_public_ip(good.parse().unwrap()), "{good}");
        }
    }

    #[test]
    fn proof_target_is_the_host_only() {
        assert_eq!(
            proof_host("https://Hub.Example.com").as_deref(),
            Some("hub.example.com")
        );
        assert_eq!(
            proof_host("https://hub.example.com/some/path?q=1").as_deref(),
            Some("hub.example.com")
        );
        assert_eq!(
            proof_host("https://hub.example.com:443").as_deref(),
            Some("hub.example.com")
        );
        assert_eq!(proof_host("https://hub.example.com:8443"), None);
        assert_eq!(proof_host("http://hub.example.com"), None);
        assert_eq!(proof_host("https://10.0.0.1"), None);
        assert_eq!(proof_host("https://[::1]"), None);
    }

    #[test]
    fn challenges_are_single_use_expire_and_bounded() {
        let map: Challenges = std::sync::Mutex::new(HashMap::new());
        let t0 = Instant::now();
        let mk = |n: &str, ttl: u64| Challenge {
            nonce: n.into(),
            public_url: "https://h.example".into(),
            expires: t0 + Duration::from_secs(ttl),
        };
        assert!(challenge_put(&map, "a".into(), mk("n1", 120), t0));
        let got = challenge_take(&map, "a", t0 + Duration::from_secs(1)).unwrap();
        assert_eq!(got.nonce, "n1");
        assert!(challenge_take(&map, "a", t0).is_none()); // second take
        assert!(challenge_put(&map, "b".into(), mk("n2", 120), t0));
        assert!(challenge_take(&map, "b", t0 + Duration::from_secs(121)).is_none());
        assert!(challenge_take(&map, "zz", t0).is_none());
        for i in 0..MAX_CHALLENGES + 50 {
            let at = t0 + Duration::from_millis(i as u64);
            assert!(challenge_put(&map, format!("k{i}"), mk("n", 120), at));
        }
        assert_eq!(map.lock().unwrap().len(), MAX_CHALLENGES);
        // the oldest were evicted, the newest kept
        assert!(challenge_take(&map, "k0", t0).is_none());
        assert!(challenge_take(&map, &format!("k{}", MAX_CHALLENGES + 49), t0).is_some());
    }

    #[test]
    fn nonce_endpoint_state() {
        assert!(ct_eq(b"abc", b"abc") && !ct_eq(b"abc", b"abd") && !ct_eq(b"ab", b"abc"));
        let slot: NonceSlot = std::sync::Mutex::new(None);
        let t0 = Instant::now();
        assert_eq!(fresh_nonce(&slot, t0), None);
        *slot.lock().unwrap() = Some(("abc".into(), t0));
        assert_eq!(
            fresh_nonce(&slot, t0 + Duration::from_secs(60)).as_deref(),
            Some("abc")
        );
        assert_eq!(
            fresh_nonce(&slot, t0 + NONCE_TTL + Duration::from_secs(1)),
            None
        );
    }
}
