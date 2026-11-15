//! Outbound notifications on attention transitions. One tokio task owns all
//! network I/O so the hub loop never blocks on it. Backends are optional and
//! no-op when their env vars are unset:
//!
//!  - Telegram (phase 1b, works today without an Apple account):
//!    TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
//!  - APNs (phase 2, after a paid Apple Developer account + .p8 key):
//!    APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_ENV
//!    Both APNs endpoints are live; APNS_ENV only says which one to try first
//!    (see `Apns`), so Xcode builds and TestFlight builds coexist.
//!
//! Genuine-transition diffing happens in the hub (see run_needs/run_error/
//! run_idle); this task additionally de-dupes repeats within 60s per (run, kind).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde_json::Value;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

use crate::hub::HubCmd;
use crate::live_activity::LiveOutcome;
use crate::workspace::now_ms;

/// A notification-worthy transition, snapshotted from the run at emit time. The
/// hub attaches the current device-token list so this task stays stateless.
#[derive(Clone, Debug)]
pub struct PushEvent {
    pub run_id: String,
    pub title: String,
    pub machine: String,
    pub machine_id: String,
    pub session_id: String,
    /// "needs_attention" | "error" | "idle"
    pub state: String,
    /// The pending tool-approval id + name (only set for needs_attention). Present
    /// => the push carries actionable Allow/Deny buttons the phone answers directly.
    pub request_id: Option<String>,
    pub tool: Option<String>,
    pub device_tokens: Vec<String>,
    pub owner_user_id: Option<String>,
    pub workspace_id: Option<String>,
    /// What the APNs payload says beyond the transition (docs/WATCH.md §1).
    pub content: crate::push_payload::PushContent,
}

/// A Live Activity push (docs/WATCH.md §5), decided by the hub's aggregation
/// and only delivered here.
#[derive(Clone, Debug)]
pub struct LivePush {
    pub user_id: String,
    pub kind: crate::live_activity::LiveKind,
    pub tokens: Vec<String>,
    /// `apns-priority`: 10 or 5.
    pub priority: u8,
    pub body: Value,
}

/// Everything the notifier task is asked to send.
#[derive(Clone, Debug)]
pub enum Outbound {
    Push(Box<PushEvent>),
    Live(LivePush),
}

/// Spawn the notifier task if any backend is configured; else return None so the
/// hub cheaply skips emitting events.
pub fn spawn_notifier(
    hub_tx: UnboundedSender<HubCmd>,
    workspaces: crate::workspace::WorkspaceStore,
) -> Option<UnboundedSender<Outbound>> {
    let telegram = TelegramConfig::from_env();
    let apns = ApnsConfig::from_env();
    let fcm = crate::fcm::Fcm::from_env();
    // A self-hosted hub has no push keys for our apps: ask our relay instead.
    // Content-free by construction, see push_relay.rs.
    let relay = if apns.is_none() && fcm.is_none() && crate::edition::is_external() {
        crate::push_relay::Relay::from_env()
    } else {
        None
    };
    if telegram.is_none() && apns.is_none() && fcm.is_none() && relay.is_none() {
        return None;
    }
    if relay.is_some() {
        println!("[notify] push relay backend enabled");
    }
    if telegram.is_some() {
        println!("[notify] telegram backend enabled");
    }
    if apns.is_some() {
        println!("[notify] apns backend enabled");
    }
    if fcm.is_some() {
        println!("[notify] FCM backend enabled");
    }
    let (tx, rx) = unbounded_channel::<Outbound>();
    tokio::spawn(run_notifier(
        rx, telegram, apns, fcm, relay, hub_tx, workspaces,
    ));
    Some(tx)
}

struct TelegramConfig {
    bot_token: String,
    chat_id: String,
}

impl TelegramConfig {
    fn from_env() -> Option<Self> {
        let bot_token = std::env::var("TELEGRAM_BOT_TOKEN")
            .ok()
            .filter(|s| !s.is_empty())?;
        let chat_id = std::env::var("TELEGRAM_CHAT_ID")
            .ok()
            .filter(|s| !s.is_empty())?;
        Some(TelegramConfig { bot_token, chat_id })
    }
}

pub(crate) struct ApnsConfig {
    key_path: String,
    key_id: String,
    team_id: String,
    bundle_id: String,
    /// Which endpoint to try first, not the only one served.
    production: bool,
}

impl ApnsConfig {
    pub(crate) fn from_env() -> Option<Self> {
        let key_path = std::env::var("APNS_KEY_PATH")
            .ok()
            .filter(|s| !s.is_empty())?;
        let key_id = std::env::var("APNS_KEY_ID")
            .ok()
            .filter(|s| !s.is_empty())?;
        let team_id = std::env::var("APNS_TEAM_ID")
            .ok()
            .filter(|s| !s.is_empty())?;
        let bundle_id = std::env::var("APNS_BUNDLE_ID")
            .ok()
            .filter(|s| !s.is_empty())?;
        let production = std::env::var("APNS_ENV")
            .map(|e| e == "production")
            .unwrap_or(false);
        Some(ApnsConfig {
            key_path,
            key_id,
            team_id,
            bundle_id,
            production,
        })
    }
}

async fn run_notifier(
    mut rx: UnboundedReceiver<Outbound>,
    telegram: Option<TelegramConfig>,
    apns: Option<ApnsConfig>,
    mut fcm: Option<crate::fcm::Fcm>,
    mut relay: Option<crate::push_relay::Relay>,
    hub_tx: UnboundedSender<HubCmd>,
    workspaces: crate::workspace::WorkspaceStore,
) {
    // Timeout so a hung Telegram call can't stall the sequential notifier loop —
    // every APNs push queues behind it.
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut apns_client = apns.as_ref().and_then(build_apns);
    // Per (run, state) de-dupe: suppress repeats within this window.
    let mut last_sent: HashMap<(String, String), Instant> = HashMap::new();
    // Which APNs endpoint a device token turned out to belong to, learned from a
    // BadDeviceToken on the other one. Keeps the mismatch cost to one extra
    // request per device rather than one per push.
    let mut apns_route: HashMap<String, bool> = HashMap::new();
    const DEBOUNCE: Duration = Duration::from_secs(60);

    while let Some(msg) = rx.recv().await {
        let ev = match msg {
            Outbound::Push(ev) => *ev,
            Outbound::Live(live) => {
                let results = if let (Some(client), Some(cfg)) = (apns_client.as_mut(), &apns) {
                    send_live(client, cfg, &live, &mut apns_route).await
                } else {
                    live.tokens
                        .iter()
                        .map(|t| (t.clone(), LiveOutcome::Transient))
                        .collect()
                };
                let _ = hub_tx.send(HubCmd::LiveSent {
                    user_id: live.user_id,
                    kind: live.kind,
                    results,
                });
                continue;
            }
        };
        if ev
            .owner_user_id
            .as_deref()
            .is_some_and(|owner| !workspaces.is_active(owner))
        {
            continue;
        }
        let key = (ev.run_id.clone(), ev.state.clone());
        let now = Instant::now();
        // Prune stale entries so the de-dupe map doesn't grow forever (run ids are
        // unique per run, so keys accumulate otherwise).
        last_sent.retain(|_, t| now.duration_since(*t) < DEBOUNCE);
        if let Some(prev) = last_sent.get(&key) {
            if now.duration_since(*prev) < DEBOUNCE {
                continue;
            }
        }
        last_sent.insert(key, now);

        if let Some(cfg) = &telegram {
            send_telegram(&http, cfg, &ev).await;
        }
        if let Some(fcm) = fcm.as_mut() {
            fcm.send(&http, &ev, &hub_tx).await;
        }
        if let Some(relay) = relay.as_mut() {
            relay.send(&ev, &hub_tx).await;
        }
        if let (Some(client), Some(cfg)) = (apns_client.as_mut(), &apns) {
            send_apns(client, cfg, &ev, &hub_tx, &mut apns_route).await;
        }
    }
}

fn verb(state: &str) -> &'static str {
    match state {
        "needs_attention" => "needs your approval",
        "error" => "hit an error",
        "idle" => "finished",
        _ => "updated",
    }
}

// -------------------------------------------------------------- Telegram

async fn send_telegram(client: &reqwest::Client, cfg: &TelegramConfig, ev: &PushEvent) {
    let text = format!("🔔 {} on {} — {}", ev.title, ev.machine, verb(&ev.state));
    let url = format!("https://api.telegram.org/bot{}/sendMessage", cfg.bot_token);
    let body = serde_json::json!({ "chat_id": cfg.chat_id, "text": text });
    // Don't print the url/error (they embed the bot token) — just the status.
    match client.post(&url).json(&body).send().await {
        Ok(r) if !r.status().is_success() => {
            eprintln!("[notify] telegram send failed: HTTP {}", r.status())
        }
        Err(_) => eprintln!("[notify] telegram request failed (network/timeout)"),
        _ => {}
    }
}

// ------------------------------------------------------------------ APNs

const APNS_PRODUCTION_URL: &str = "https://api.push.apple.com";
const APNS_SANDBOX_URL: &str = "https://api.development.push.apple.com";
/// Apple rejects a provider token older than 60 minutes (ExpiredProviderToken)
/// and one refreshed more often than every 20 (TooManyProviderTokenUpdates), so
/// one token is reused for 55 minutes.
const APNS_TOKEN_TTL: Duration = Duration::from_secs(55 * 60);
/// `apns-collapse-id` may not exceed 64 bytes; a longer id is left off the push.
const APNS_COLLAPSE_ID_MAX: usize = 64;

#[derive(serde::Serialize)]
struct ApnsClaims<'a> {
    iss: &'a str,
    iat: u64,
}

/// Both APNs endpoints off one signing key. A device token is bound to the
/// environment its build was signed for, and one hub serves both at once: the
/// owner's Xcode builds are sandbox while everyone on TestFlight is production.
/// Talking to only one endpoint doesn't merely drop the other half's pushes —
/// APNs answers BadDeviceToken, which used to prune those devices for good.
///
/// One HTTP/2 client serves both hosts (the pool is per host) and one ES256
/// provider token authorises both: it is bound to the team and key, not to the
/// environment.
pub(crate) struct Apns {
    http: reqwest::Client,
    key: EncodingKey,
    key_id: String,
    team_id: String,
    /// The signed provider token and when it was minted.
    token: Option<(String, Instant, u64)>,
}

impl Apns {
    /// The provider token to authorise with, minting a new one only when the
    /// cached one is `APNS_TOKEN_TTL` old. `now` and `unix_secs` are parameters
    /// so the cache decision can be tested without waiting an hour.
    pub(crate) fn bearer(&mut self, now: Instant, unix_secs: u64) -> Option<String> {
        if let Some((jwt, minted, iat)) = &self.token {
            // Both clocks: `Instant` stops while the VM is paused, Apple judges
            // `iat` by the wall clock (over 60 min → ExpiredProviderToken, and
            // nothing here would have dropped the cached token).
            if now.saturating_duration_since(*minted) < APNS_TOKEN_TTL
                && unix_secs >= *iat
                && unix_secs - *iat < APNS_TOKEN_TTL.as_secs()
            {
                return Some(jwt.clone());
            }
        }
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some(self.key_id.clone());
        let claims = ApnsClaims {
            iss: &self.team_id,
            iat: unix_secs,
        };
        let jwt = encode(&header, &claims, &self.key)
            .map_err(|e| eprintln!("[notify] apns token signing failed: {e}"))
            .ok()?;
        self.token = Some((jwt.clone(), now, unix_secs));
        Some(jwt)
    }
}

pub(crate) fn build_apns(cfg: &ApnsConfig) -> Option<Apns> {
    let pem = std::fs::read(&cfg.key_path)
        .map_err(|e| eprintln!("[notify] apns key open failed: {e}"))
        .ok()?;
    let key = EncodingKey::from_ec_pem(&pem)
        .map_err(|e| eprintln!("[notify] apns client build failed: {e}"))
        .ok()?;
    // Its own client, not the notifier's shared 10 s one: APNs is HTTP/2-only
    // (prior knowledge pins ALPN to h2) and wants its connections kept open, and
    // every request carries our provider token, so nothing may redirect it or
    // downgrade it to plain http.
    let http = reqwest::Client::builder()
        .use_rustls_tls()
        .http2_prior_knowledge()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .pool_idle_timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| eprintln!("[notify] apns client build failed: {e}"))
        .ok()?;
    Some(Apns {
        http,
        key,
        key_id: cfg.key_id.clone(),
        team_id: cfg.team_id.clone(),
        token: None,
    })
}

/// The headers (all but `authorization`, which depends on the provider token)
/// and JSON body of one push. The same for every device of the event.
fn apns_request(ev: &PushEvent, cfg: &ApnsConfig) -> (Vec<(&'static str, String)>, Value) {
    let mut headers = vec![
        ("content-type", "application/json".to_string()),
        ("apns-topic", cfg.bundle_id.clone()),
        // Apple requires this on iOS 13+ and falls back to a guess without it.
        // The a2 client this replaces never sent it.
        ("apns-push-type", "alert".to_string()),
    ];
    if ev.run_id.len() <= APNS_COLLAPSE_ID_MAX {
        headers.push(("apns-collapse-id", ev.run_id.clone()));
    }
    // Text, category, thread and the answerable excerpts: `push_payload`.
    (
        headers,
        crate::push_payload::build_payload(ev, crate::push_payload::PAYLOAD_LIMIT),
    )
}

/// `POST <endpoint>/3/device/<token>` with the headers, provider token and body
/// set. The token is client-supplied (`register_push`), so it goes in as one
/// percent-encoded path segment rather than being spliced into the URL.
fn apns_post(
    http: &reqwest::Client,
    production: bool,
    token: &str,
    bearer: &str,
    headers: &[(&'static str, String)],
    body: &Value,
) -> Option<reqwest::RequestBuilder> {
    let mut url = reqwest::Url::parse(if production {
        APNS_PRODUCTION_URL
    } else {
        APNS_SANDBOX_URL
    })
    .ok()?;
    url.path_segments_mut().ok()?.extend(["3", "device", token]);
    let mut request = http.post(url);
    for (name, value) in headers {
        request = request.header(*name, value);
    }
    Some(
        request
            .header("authorization", format!("bearer {bearer}"))
            .json(body),
    )
}

async fn send_apns(
    apns: &mut Apns,
    cfg: &ApnsConfig,
    ev: &PushEvent,
    hub_tx: &UnboundedSender<HubCmd>,
    route: &mut HashMap<String, bool>,
) {
    let tokens: Vec<&String> = ev
        .device_tokens
        .iter()
        .filter(|token| !token.starts_with("fcm:"))
        .collect();
    if tokens.is_empty() {
        return;
    }
    let Some(bearer) = apns.bearer(Instant::now(), (now_ms() / 1000) as u64) else {
        return;
    };
    let (headers, payload) = apns_request(ev, cfg);
    for token in tokens {
        // Start on the endpoint this token is known (or configured) to live on.
        let prefer = route.get(token).copied().unwrap_or(cfg.production);
        let mut outcome = send_one(&apns.http, prefer, token, &bearer, &headers, &payload).await;
        // Wrong environment reads as BadDeviceToken. Try the other one before
        // believing the token is dead — it is how a sandbox hub reaches a
        // TestFlight device, and vice versa.
        if matches!(outcome, ApnsOutcome::WrongEnvironment) {
            outcome = send_one(&apns.http, !prefer, token, &bearer, &headers, &payload).await;
            if matches!(outcome, ApnsOutcome::Sent) {
                route.insert(token.clone(), !prefer);
            }
        }
        let invalidated_at_ms = match outcome {
            ApnsOutcome::Sent => {
                // One line per delivery, no token: the proof an operator reads
                // after a deploy. Apple answers 200 with an empty body.
                println!(
                    "[notify] apns delivered: run {} ({}) via {}",
                    ev.run_id,
                    ev.state,
                    if route.get(token).copied().unwrap_or(cfg.production) {
                        "production"
                    } else {
                        "sandbox"
                    }
                );
                continue;
            }
            ApnsOutcome::WrongEnvironment => Some(None),
            ApnsOutcome::Unregistered(at) => Some(at),
            ApnsOutcome::Failed => None,
        };
        if let Some(invalidated_at_ms) = invalidated_at_ms {
            let _ = hub_tx.send(HubCmd::PrunePushToken {
                token: token.clone(),
                invalidated_at_ms,
            });
        }
    }
}

/// Deliver one prebuilt alert payload to one device token, with the same
/// endpoint learning as `send_apns`. For the push relay (`push_relay.rs`),
/// which builds its own content-free payload.
pub(crate) async fn send_prebuilt(
    apns: &mut Apns,
    cfg: &ApnsConfig,
    route: &mut HashMap<String, bool>,
    token: &str,
    collapse_id: &str,
    payload: &Value,
) -> ApnsOutcome {
    let Some(bearer) = apns.bearer(Instant::now(), (now_ms() / 1000) as u64) else {
        return ApnsOutcome::Failed;
    };
    let mut headers = vec![
        ("content-type", "application/json".to_string()),
        ("apns-topic", cfg.bundle_id.clone()),
        ("apns-push-type", "alert".to_string()),
    ];
    if collapse_id.len() <= APNS_COLLAPSE_ID_MAX {
        headers.push(("apns-collapse-id", collapse_id.to_string()));
    }
    let prefer = route.get(token).copied().unwrap_or(cfg.production);
    let mut outcome = send_one(&apns.http, prefer, token, &bearer, &headers, payload).await;
    if matches!(outcome, ApnsOutcome::WrongEnvironment) {
        outcome = send_one(&apns.http, !prefer, token, &bearer, &headers, payload).await;
        if matches!(outcome, ApnsOutcome::Sent) {
            route.insert(token.to_string(), !prefer);
        }
    }
    outcome
}

/// Deliver one Live Activity push to each of its tokens. Same provider token,
/// same endpoint learning as `send_apns`; the per-token outcomes go back to
/// the hub (`HubCmd::LiveSent`), which commits state only on success.
async fn send_live(
    apns: &mut Apns,
    cfg: &ApnsConfig,
    live: &LivePush,
    route: &mut HashMap<String, bool>,
) -> Vec<(String, LiveOutcome)> {
    let mut results = Vec::new();
    let Some(bearer) = apns.bearer(Instant::now(), (now_ms() / 1000) as u64) else {
        return live
            .tokens
            .iter()
            .map(|t| (t.clone(), LiveOutcome::Transient))
            .collect();
    };
    let headers = vec![
        ("content-type", "application/json".to_string()),
        (
            "apns-topic",
            format!("{}.push-type.liveactivity", cfg.bundle_id),
        ),
        ("apns-push-type", "liveactivity".to_string()),
        ("apns-priority", live.priority.to_string()),
    ];
    for token in &live.tokens {
        let prefer = route.get(token).copied().unwrap_or(cfg.production);
        let mut outcome = send_one(&apns.http, prefer, token, &bearer, &headers, &live.body).await;
        if matches!(outcome, ApnsOutcome::WrongEnvironment) {
            outcome = send_one(&apns.http, !prefer, token, &bearer, &headers, &live.body).await;
            if matches!(outcome, ApnsOutcome::Sent) {
                route.insert(token.clone(), !prefer);
            }
        }
        let verdict = match outcome {
            ApnsOutcome::Sent => {
                println!(
                    "[notify] live activity delivered: {}",
                    live.body["aps"]["event"].as_str().unwrap_or("?")
                );
                LiveOutcome::Ok
            }
            ApnsOutcome::WrongEnvironment | ApnsOutcome::Unregistered(_) => {
                LiveOutcome::Unregistered
            }
            ApnsOutcome::Failed => LiveOutcome::Transient,
        };
        results.push((token.clone(), verdict));
    }
    results
}

/// What APNs said about one token, reduced to the three things we act on.
#[derive(Debug, PartialEq)]
pub(crate) enum ApnsOutcome {
    Sent,
    /// BadDeviceToken — either a genuinely malformed token or the right token on
    /// the wrong endpoint. Only the second send tells them apart.
    WrongEnvironment,
    Unregistered(Option<i64>),
    Failed,
}

/// APNs error bodies: `{"reason":"Unregistered","timestamp":1700000000000}`.
#[derive(serde::Deserialize)]
struct ApnsErrorBody {
    reason: String,
    /// Milliseconds; only sent with `Unregistered`.
    timestamp: Option<i64>,
}

/// The reason is what decides, not the status: BadDeviceToken and
/// Unregistered both ride on 400/410, but so do reasons we must not prune on.
/// A body that is not the documented JSON is a plain failure.
fn classify(status: reqwest::StatusCode, body: &[u8]) -> (ApnsOutcome, String) {
    if status == reqwest::StatusCode::OK {
        return (ApnsOutcome::Sent, String::new());
    }
    match serde_json::from_slice::<ApnsErrorBody>(body) {
        Ok(error) => {
            let outcome = match error.reason.as_str() {
                "BadDeviceToken" => ApnsOutcome::WrongEnvironment,
                "Unregistered" => ApnsOutcome::Unregistered(error.timestamp),
                _ => ApnsOutcome::Failed,
            };
            // Bound what an answer can put in our log.
            (outcome, error.reason.chars().take(64).collect())
        }
        Err(_) => (ApnsOutcome::Failed, String::new()),
    }
}

async fn send_one(
    http: &reqwest::Client,
    production: bool,
    token: &str,
    bearer: &str,
    headers: &[(&'static str, String)],
    payload: &Value,
) -> ApnsOutcome {
    let Some(request) = apns_post(http, production, token, bearer, headers, payload) else {
        eprintln!("[notify] apns send failed: request could not be built");
        return ApnsOutcome::Failed;
    };
    // Log the status and Apple's reason only: an error from reqwest embeds the
    // URL, which ends in the device token.
    let response = match request.send().await {
        Ok(response) => response,
        Err(e) => {
            let kind = if e.is_timeout() {
                "timeout"
            } else if e.is_connect() {
                "connect"
            } else {
                "request"
            };
            eprintln!("[notify] apns send failed: {kind} error");
            return ApnsOutcome::Failed;
        }
    };
    let status = response.status();
    if status == reqwest::StatusCode::OK {
        return ApnsOutcome::Sent;
    }
    let body = response.bytes().await.unwrap_or_default();
    let (outcome, reason) = classify(status, &body);
    eprintln!("[notify] apns send failed: HTTP {status} {reason}");
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
    use base64::Engine as _;
    use jsonwebtoken::{decode, decode_header, DecodingKey, Validation};
    use reqwest::StatusCode;
    use ring::rand::SystemRandom;
    use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
    use serde_json::json;

    fn event() -> PushEvent {
        PushEvent {
            run_id: "run-1".into(),
            title: "Fix the build".into(),
            machine: "Mac".into(),
            machine_id: "mac-1".into(),
            session_id: "sess-1".into(),
            state: "needs_attention".into(),
            request_id: Some("req-1".into()),
            tool: Some("Bash".into()),
            device_tokens: vec![],
            owner_user_id: None,
            workspace_id: None,
            content: Default::default(),
        }
    }

    fn config() -> ApnsConfig {
        ApnsConfig {
            key_path: String::new(),
            key_id: "KEYID12345".into(),
            team_id: "TEAMID1234".into(),
            bundle_id: "net.hegai.code".into(),
            production: false,
        }
    }

    /// A throwaway P-256 key, generated per run so no private key sits in the repo.
    fn signer() -> (Apns, Vec<u8>) {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
        let public =
            EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng)
                .unwrap()
                .public_key()
                .as_ref()
                .to_vec();
        let body = STANDARD.encode(pkcs8.as_ref());
        let lines: Vec<&str> = body
            .as_bytes()
            .chunks(64)
            .map(|c| std::str::from_utf8(c).unwrap())
            .collect();
        let pem = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n", // gitleaks:allow (template; the key is generated in memory above)
            lines.join("\n")
        );
        let cfg = config();
        let apns = Apns {
            http: reqwest::Client::new(),
            key: EncodingKey::from_ec_pem(pem.as_bytes()).unwrap(),
            key_id: cfg.key_id,
            team_id: cfg.team_id,
            token: None,
        };
        (apns, public)
    }

    #[test]
    fn approval_push_headers_and_body_are_pinned() {
        let (headers, body) = apns_request(&event(), &config());
        assert_eq!(
            headers,
            vec![
                ("content-type", "application/json".to_string()),
                ("apns-topic", "net.hegai.code".to_string()),
                ("apns-push-type", "alert".to_string()),
                ("apns-collapse-id", "run-1".to_string()),
            ]
        );
        assert_eq!(
            body,
            json!({
                "aps": {
                    "alert": { "title": "Fix the build", "subtitle": "Mac", "body": "Хочет запустить Bash" },
                    "sound": "default",
                    "thread-id": "sess-1",
                    "interruption-level": "time-sensitive",
                    "category": "TOOL_APPROVAL",
                    "mutable-content": 0,
                },
                "machineId": "mac-1",
                "requestId": "req-1",
                "runId": "run-1",
                "sessionId": "sess-1",
                "state": "needs_attention",
                "tool": "Bash",
            })
        );
    }

    #[test]
    fn plain_push_carries_no_request_or_tool() {
        let mut ev = event();
        ev.state = "idle".into();
        ev.request_id = None;
        ev.tool = None;
        let (_, body) = apns_request(&ev, &config());
        assert_eq!(
            body,
            json!({
                "aps": {
                    "alert": { "title": "Fix the build", "subtitle": "Mac", "body": "Готово" },
                    "sound": "default",
                    "thread-id": "sess-1",
                    "interruption-level": "active",
                    "category": "HEGAI_DONE",
                    "mutable-content": 0,
                },
                "machineId": "mac-1",
                "runId": "run-1",
                "sessionId": "sess-1",
                "state": "idle",
            })
        );
        // Absent, never null: the app tests for presence.
        assert!(body.get("requestId").is_none() && body.get("tool").is_none());
        // Idle carries its own category now (reply from the lock screen).
        assert_eq!(body["aps"]["category"], "HEGAI_DONE");
    }

    #[test]
    fn collapse_id_over_64_bytes_is_left_off() {
        let mut ev = event();
        ev.run_id = "r".repeat(64);
        let (headers, _) = apns_request(&ev, &config());
        assert!(headers.iter().any(|(k, _)| *k == "apns-collapse-id"));
        ev.run_id = "r".repeat(65);
        let (headers, body) = apns_request(&ev, &config());
        assert!(headers.iter().all(|(k, _)| *k != "apns-collapse-id"));
        // The push itself still goes out and still names its run.
        assert_eq!(body["runId"], "r".repeat(65));
    }

    #[test]
    fn request_goes_to_the_right_host_as_one_encoded_path_segment() {
        let (headers, body) = apns_request(&event(), &config());
        let http = reqwest::Client::new();
        let built = |production, token: &str| {
            apns_post(&http, production, token, "JWT", &headers, &body)
                .unwrap()
                .build()
                .unwrap()
        };
        let sandbox = built(false, "abc123");
        assert_eq!(sandbox.method(), "POST");
        assert_eq!(
            sandbox.url().as_str(),
            "https://api.development.push.apple.com/3/device/abc123"
        );
        let production = built(true, "abc123");
        assert_eq!(
            production.url().as_str(),
            "https://api.push.apple.com/3/device/abc123"
        );
        let h = production.headers();
        assert_eq!(h["authorization"], "bearer JWT");
        assert_eq!(h["apns-topic"], "net.hegai.code");
        assert_eq!(h["apns-push-type"], "alert");
        assert_eq!(h["apns-collapse-id"], "run-1");
        assert_eq!(h.get_all("content-type").iter().count(), 1);
        assert_eq!(h["content-type"], "application/json");
        // A token the app made up cannot walk out of /3/device/.
        let hostile = built(true, "../../x?y=1");
        assert_eq!(hostile.url().host_str(), Some("api.push.apple.com"));
        assert!(hostile.url().path().starts_with("/3/device/"));
        assert_eq!(hostile.url().query(), None);
    }

    #[test]
    fn answers_are_classified_by_reason_not_status() {
        let c = |status: u16, body: &str| {
            classify(StatusCode::from_u16(status).unwrap(), body.as_bytes()).0
        };
        assert_eq!(c(200, ""), ApnsOutcome::Sent);
        assert_eq!(
            c(400, r#"{"reason":"BadDeviceToken"}"#),
            ApnsOutcome::WrongEnvironment
        );
        assert_eq!(
            c(
                410,
                r#"{"reason":"Unregistered","timestamp":1700000000000}"#
            ),
            ApnsOutcome::Unregistered(Some(1_700_000_000_000))
        );
        assert_eq!(
            c(410, r#"{"reason":"Unregistered"}"#),
            ApnsOutcome::Unregistered(None)
        );
        // The reason decides: the same 410 with another reason is not a prune.
        assert_eq!(c(410, r#"{"reason":"ExpiredToken"}"#), ApnsOutcome::Failed);
        for (status, body) in [
            (403, r#"{"reason":"ExpiredProviderToken"}"#),
            (429, r#"{"reason":"TooManyRequests"}"#),
            (500, r#"{"reason":"InternalServerError"}"#),
            (503, r#"{"reason":"ServiceUnavailable"}"#),
            // Unparsable or empty bodies are failures, never prunes.
            (400, "<html>bad gateway</html>"),
            (400, ""),
            (410, "{}"),
        ] {
            assert_eq!(c(status, body), ApnsOutcome::Failed, "{status} {body}");
        }
        // Only the reason reaches the log, and only so many characters of it.
        let long = format!(r#"{{"reason":"{}"}}"#, "x".repeat(500));
        assert_eq!(
            classify(StatusCode::BAD_REQUEST, long.as_bytes()).1.len(),
            64
        );
    }

    #[test]
    fn provider_token_is_es256_with_kid_team_and_iat() {
        let (mut apns, public) = signer();
        let jwt = apns.bearer(Instant::now(), 1_700_000_000).unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        // Spec-correct base64url without padding (a2 sent padded standard base64).
        assert!(jwt
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)));

        let header = decode_header(&jwt).unwrap();
        assert_eq!(header.alg, Algorithm::ES256);
        assert_eq!(header.kid.as_deref(), Some("KEYID12345"));
        let claims: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        // Exactly these two claims: Apple does not want exp, aud or sub.
        assert_eq!(
            claims,
            json!({ "iss": "TEAMID1234", "iat": 1_700_000_000u64 })
        );

        // And the signature verifies against the key's public half.
        let mut validation = Validation::new(Algorithm::ES256);
        validation.required_spec_claims.clear();
        validation.validate_exp = false;
        decode::<Value>(&jwt, &DecodingKey::from_ec_der(&public), &validation).unwrap();
    }

    #[test]
    fn provider_token_is_reused_for_55_minutes_then_reminted() {
        let (mut apns, _) = signer();
        let t0 = Instant::now();
        let first = apns.bearer(t0, 1_000).unwrap();
        // Same instant and just inside the window: the cached token, untouched.
        assert_eq!(apns.bearer(t0, 1_001).unwrap(), first);
        let almost = t0 + APNS_TOKEN_TTL - Duration::from_secs(1);
        assert_eq!(apns.bearer(almost, 4_299).unwrap(), first);
        // At 55 minutes it is replaced, carrying the new iat.
        let renewed = apns.bearer(t0 + APNS_TOKEN_TTL, 4_300).unwrap();
        assert_ne!(renewed, first);
        let payload = renewed.split('.').nth(1).unwrap();
        let claims: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).unwrap()).unwrap();
        assert_eq!(claims["iat"], 4_300);
        // The window restarts from the new token, not the old one.
        let later = t0 + APNS_TOKEN_TTL + Duration::from_secs(60);
        assert_eq!(apns.bearer(later, 4_360).unwrap(), renewed);
        assert_eq!(APNS_TOKEN_TTL, Duration::from_secs(55 * 60));
    }
}
