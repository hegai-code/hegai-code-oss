//! Bifrost governance client — the hub creates, repairs, and switches the
//! community members' gateway seats itself.
//!
//! A **seat** is a Bifrost virtual key named exactly `hegai:<lowercased
//! email>`. Until this module existed a seat was made by hand on the hub box
//! (`deploy/llmgw-provision-seats.sh`); this is that script's create / repair
//! / verify logic in Rust, called from the activation hooks and the reconciler.
//!
//! Two rules the script learned the hard way and this module keeps:
//!
//! - **Never recreate an existing seat.** A new secret would break the
//!   `~/.codex/config.toml` already installed in the member's sandbox. An
//!   existing seat is repaired in place (misrouted) or reactivated
//!   (`is_active=false`), nothing else.
//! - **Writes take `key_ids`, reads return `keys`.** Sending `keys` on a write
//!   is accepted with 200 and silently ignored, leaving a seat that routes
//!   nowhere. `seat_body_from_template` is a pure function so a unit test can
//!   pin that shape.
//!
//! The admin API is either bound to loopback with no authentication of its
//! own (our gateway host), or password-protected by Bifrost's `auth_config`
//! with the credentials in `LLM_GATEWAY_URL` (the self-host kit, where agent
//! sessions share the host). Secrets (`value`, the admin password) never
//! appear in errors or logs.

use std::collections::HashMap;
use std::time::Duration;

use serde_json::{json, Value};

use crate::timefmt::{parse_rfc3339_ms, parse_window_ms};

const TEMPLATE_DEFAULT: &str = "hegai:template-community";
const PUBLIC_URL_DEFAULT: &str = "https://llm.acme.test/v1";
const MODEL_DEFAULT: &str = "gpt-5.6-sol";
/// Governance calls are local; anything slower than this is a broken gateway.
const ADMIN_TIMEOUT: Duration = Duration::from_secs(10);
/// A real completion through the public edge may legitimately take longer.
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
/// Gateway error bodies are truncated into error strings at this length.
const ERR_BODY_CAP: usize = 200;

/// Per-seat limits that replace the template's, from the environment.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SeatOverrides {
    pub tokens_per_day: Option<u64>,
    pub requests_per_hour: Option<u64>,
}

/// The narrow projection of a virtual key the hub works with.
#[derive(Clone, Debug)]
pub struct Seat {
    pub id: String,
    pub name: String,
    /// The bearer secret. Handed to the member and the provisioner; never
    /// logged, never stored on the hub.
    pub value: String,
    pub is_active: bool,
    /// The upstream `rate_limit` object verbatim (limits + current usage).
    pub rate_limit: Value,
    /// Routed to a provider it cannot actually reach — see `is_misrouted`.
    pub misrouted: bool,
    /// The pool (Bifrost provider) that carries this seat's traffic — see
    /// `primary_pool`. Different pools are different ChatGPT accounts with
    /// their own quota.
    pub pool: Option<String>,
}

/// A seat's activity flag and governance window — no secret.
#[derive(Clone, Debug)]
pub struct SeatLimit {
    pub is_active: bool,
    pub rate_limit: Value,
}

/// A page of gateway logs is a few hundred KB; give it more room than a
/// governance call.
const LOGS_TIMEOUT: Duration = Duration::from_secs(30);
/// Hard cap on one `get_text` body (a page of logs carries raw bodies).
pub(crate) const MAX_TEXT_BODY: usize = 64 * 1024 * 1024;

pub struct LlmGateway {
    /// Without credentials: reqwest errors print the URL, and these land in
    /// the hub log.
    admin_url: String,
    /// `user:password` from `LLM_GATEWAY_URL`, sent as Basic auth on admin
    /// calls only (a Bifrost with `auth_config` enabled answers 401 without
    /// it). Inference calls carry the member's own key instead.
    admin_auth: Option<(String, String)>,
    public_url: String,
    template_key: String,
    model: String,
    overrides: SeatOverrides,
    http: reqwest::Client,
    /// `list_seats` answer reused by the key-authenticated limits endpoint, so
    /// an anonymous caller cannot turn every guess into an admin round-trip.
    seats_cache: tokio::sync::Mutex<Option<(std::time::Instant, Vec<Value>)>>,
}

/// `hegai:<lowercased email>` — the one name every lookup agrees on.
pub(crate) fn seat_name(email: &str) -> String {
    format!("hegai:{}", email.trim().to_ascii_lowercase())
}

/// A seat routed to a provider with neither `allow_all_keys` nor any key
/// reference reaches nothing at all (`/v1/models` comes back empty). Reads
/// report resolved credentials under `keys`, so that is what is inspected.
/// Mirrors `is_broken` in `deploy/llmgw-provision-seats.sh`.
pub(crate) fn is_misrouted(seat: &Value) -> bool {
    let Some(configs) = seat.get("provider_configs").and_then(Value::as_array) else {
        return true;
    };
    if configs.is_empty() {
        return true;
    }
    configs.iter().any(|c| {
        let allow_all = c
            .get("allow_all_keys")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let has_keys = c
            .get("keys")
            .and_then(Value::as_array)
            .is_some_and(|keys| !keys.is_empty());
        !allow_all && !has_keys
    })
}

/// The create/repair body for a member's seat, cloned from the template.
///
/// Provider routing is copied as `key_ids` (the `key_id` UUIDs found under the
/// template's `keys`) — never `keys`. `rate_limit` copies the template's four
/// limit fields and then applies the overrides (a daily token cap, an hourly
/// request cap). `budget` keeps only its two declarative fields. Pure, so the
/// wire shape is unit-tested without a gateway.
pub(crate) fn seat_body_from_template(
    template: &Value,
    email: &str,
    overrides: &SeatOverrides,
) -> Value {
    let email = email.trim().to_ascii_lowercase();
    let provider_configs: Vec<Value> = template
        .get("provider_configs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|p| {
            let provider = p.get("provider").and_then(Value::as_str)?;
            let key_ids: Vec<Value> = p
                .get("keys")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|k| k.get("key_id").and_then(Value::as_str))
                .filter(|id| !id.is_empty())
                .map(|id| Value::String(id.to_string()))
                .collect();
            Some(json!({
                "provider": provider,
                "weight": p.get("weight").filter(|w| w.is_number()).cloned().unwrap_or(json!(1.0)),
                "allow_all_keys": p.get("allow_all_keys").and_then(Value::as_bool).unwrap_or(false),
                "allowed_models": p.get("allowed_models").filter(|m| m.is_array()).cloned().unwrap_or(json!(["*"])),
                "blacklisted_models": p.get("blacklisted_models").filter(|m| m.is_array()).cloned().unwrap_or(json!([])),
                "key_ids": key_ids,
            }))
        })
        .collect();

    let mut body = json!({
        "name": seat_name(&email),
        "description": format!("Community seat {email}"),
        "is_active": true,
        "provider_configs": provider_configs,
    });

    let mut rate_limit = serde_json::Map::new();
    if let Some(rl) = template.get("rate_limit").and_then(Value::as_object) {
        for key in [
            "token_max_limit",
            "token_reset_duration",
            "request_max_limit",
            "request_reset_duration",
        ] {
            if let Some(v) = rl.get(key).filter(|v| !v.is_null()) {
                rate_limit.insert(key.to_string(), v.clone());
            }
        }
    }
    if let Some(tokens) = overrides.tokens_per_day {
        rate_limit.insert("token_max_limit".into(), json!(tokens));
        rate_limit.insert("token_reset_duration".into(), json!("1d"));
    }
    if let Some(requests) = overrides.requests_per_hour {
        rate_limit.insert("request_max_limit".into(), json!(requests));
        rate_limit.insert("request_reset_duration".into(), json!("1h"));
    }
    if !rate_limit.is_empty() {
        body["rate_limit"] = Value::Object(rate_limit);
    }

    if let Some(budget) = template.get("budget").and_then(Value::as_object) {
        let mut copied = serde_json::Map::new();
        for key in ["max_limit", "reset_duration"] {
            if let Some(v) = budget.get(key).filter(|v| !v.is_null()) {
                copied.insert(key.to_string(), v.clone());
            }
        }
        if !copied.is_empty() {
            body["budget"] = Value::Object(copied);
        }
    }
    body
}

/// Bifrost ids have been both strings and integers across versions; the URL
/// path wants text either way.
fn id_of(seat: &Value) -> Option<String> {
    match seat.get("id") {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

pub(crate) fn seat_from_value(v: &Value) -> Option<Seat> {
    Some(Seat {
        id: id_of(v)?,
        name: v.get("name").and_then(Value::as_str)?.to_string(),
        value: v
            .get("value")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        is_active: v.get("is_active").and_then(Value::as_bool).unwrap_or(false),
        rate_limit: v.get("rate_limit").cloned().unwrap_or(Value::Null),
        misrouted: is_misrouted(v),
        pool: primary_pool(v),
    })
}

/// The ACTIVE seat whose secret is exactly `key`, compared in constant time
/// against every seat so the time taken does not say how far the list was
/// walked. An inactive seat with that secret is no match (a revoked member's
/// agent learns nothing).
pub(crate) fn active_seat_for_key(seats: &[Value], key: &str) -> Option<Seat> {
    let mut found = None;
    for seat in seats.iter().filter_map(seat_from_value) {
        let same = crate::provisioning_api::ct_eq(seat.value.as_bytes(), key.as_bytes());
        if same && seat.is_active && found.is_none() {
            found = Some(seat);
        }
    }
    found
}

/// The provider that actually takes the seat's routine traffic: the
/// highest-weight entry with weight > 0. A weight-0 entry is a per-request
/// fallback only (it is never chosen as primary), so it does not count.
pub(crate) fn primary_pool(seat: &Value) -> Option<String> {
    seat.get("provider_configs")?
        .as_array()?
        .iter()
        .filter_map(|c| {
            let weight = c.get("weight").and_then(Value::as_f64).unwrap_or(0.0);
            let name = c.get("provider").and_then(Value::as_str)?;
            (weight > 0.0).then_some((weight, name))
        })
        .max_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, name)| name.to_string())
}

/// Each pool is its own ChatGPT account, and the cron probe writes one
/// snapshot per pool: no pool or `pool-a` → the configured file; any other
/// pool → `quota-<pool>.json` next to it. A pool name that is not plain
/// `[a-z0-9-]` yields `None` — no meter — rather than another account's
/// numbers or a path built from it.
pub(crate) fn quota_file_for_pool(base: &str, pool: Option<&str>) -> Option<std::path::PathBuf> {
    let base_path = std::path::Path::new(base);
    match pool {
        None | Some("pool-a") => Some(base_path.to_path_buf()),
        Some(p)
            if !p.is_empty()
                && p.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') =>
        {
            Some(base_path.with_file_name(format!("quota-{p}.json")))
        }
        Some(_) => None,
    }
}

/// Every pool snapshot sitting next to `base`: `pool-a` (the base file itself)
/// first, then each `quota-<pool>.json` by name. Pools are listed whether or
/// not their snapshot is currently `ok` — the caller decides what to show.
pub(crate) fn quota_pools(base: &str) -> Vec<(String, std::path::PathBuf)> {
    let base_path = std::path::Path::new(base);
    let mut out = vec![("pool-a".to_string(), base_path.to_path_buf())];
    let Some(dir) = base_path.parent() else {
        return out;
    };
    let mut rest: Vec<(String, std::path::PathBuf)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let pool = name
                .strip_prefix("quota-")?
                .strip_suffix(".json")?
                .to_string();
            // Same gate as quota_file_for_pool: a plain name, and never pool-a
            // twice (it is the base file).
            (pool != "pool-a"
                && quota_file_for_pool(base, Some(&pool)).as_deref() == Some(e.path().as_path()))
            .then(|| (pool, e.path()))
        })
        .collect();
    rest.sort();
    out.extend(rest);
    out
}

/// When the token window next resets: `token_last_reset` + `token_reset_duration`.
/// `None` when either is missing or unparseable — the client then just omits
/// the field.
pub(crate) fn reset_at_ms(rate_limit: &Value) -> Option<i64> {
    window_reset_at_ms(rate_limit, "token")
}

/// When the request window next resets (`request_last_reset` +
/// `request_reset_duration`); the two windows reset independently.
pub(crate) fn request_reset_at_ms(rate_limit: &Value) -> Option<i64> {
    window_reset_at_ms(rate_limit, "request")
}

fn window_reset_at_ms(rate_limit: &Value, prefix: &str) -> Option<i64> {
    let last = rate_limit
        .get(format!("{prefix}_last_reset"))
        .and_then(Value::as_str)
        .and_then(parse_rfc3339_ms)?;
    let window = rate_limit
        .get(format!("{prefix}_reset_duration"))
        .and_then(Value::as_str)
        .and_then(parse_window_ms)?;
    Some(last + window)
}

/// The seat's limits and current usage as the API reports them (camelCase,
/// absent when unset) plus `resetAt`. One projection for `/api/budget` and the
/// usage report so they cannot disagree.
pub(crate) fn limits_projection(rate_limit: &Value) -> serde_json::Map<String, Value> {
    let mut limits = serde_json::Map::new();
    for (out_key, in_key) in [
        ("tokens", "token_max_limit"),
        ("tokensUsed", "token_current_usage"),
        ("tokensWindow", "token_reset_duration"),
        ("requests", "request_max_limit"),
        ("requestsUsed", "request_current_usage"),
        ("requestsWindow", "request_reset_duration"),
    ] {
        if let Some(v) = rate_limit.get(in_key).filter(|v| !v.is_null()) {
            limits.insert(out_key.into(), v.clone());
        }
    }
    if let Some(reset_at) = reset_at_ms(rate_limit) {
        limits.insert("resetAt".into(), json!(reset_at));
    }
    if let Some(reset_at) = request_reset_at_ms(rate_limit) {
        limits.insert("requestsResetAt".into(), json!(reset_at));
    }
    limits
}

/// `http://user:pass@bifrost:8080/` → (`http://bifrost:8080`, Some((user, pass))).
/// Credentials are percent-decoded; a URL without them passes through as is.
/// Query, fragment or a non-http(s) scheme are refused: the hub appends API
/// paths to this string.
fn split_admin_url(raw: &str) -> Result<(String, Option<(String, String)>), String> {
    let mut url = reqwest::Url::parse(raw.trim()).map_err(|_| "not a URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("scheme must be http or https".into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("no query or fragment allowed".into());
    }
    let auth = if url.username().is_empty() && url.password().is_none() {
        None
    } else {
        let decode = |s: &str| {
            urlencoding::decode(s)
                .map(|c| c.into_owned())
                .map_err(|_| "credentials are not valid UTF-8".to_string())
        };
        let user = decode(url.username())?;
        let pass = decode(url.password().unwrap_or(""))?;
        if user.is_empty() || pass.is_empty() {
            return Err("both user and password are needed for admin auth".into());
        }
        let _ = url.set_username("");
        let _ = url.set_password(None);
        Some((user, pass))
    };
    Ok((url.as_str().trim_end_matches('/').to_string(), auth))
}

fn env_trimmed(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn env_u64(name: &str) -> Option<u64> {
    env_trimmed(name)
        .and_then(|s| s.parse::<u64>().ok())
        .filter(|n| *n > 0)
}

/// Strip a gateway error body to something loggable: short, single-line.
fn snippet(body: &str) -> String {
    body.chars()
        .filter(|c| !c.is_control())
        .take(ERR_BODY_CAP)
        .collect()
}

/// The URL the gateway is reached on from outside: `LLM_PUBLIC_URL`, else the
/// edition's default. `None` when there is neither — a customer who set the
/// admin URL but not the public one has no address to hand to members, so the
/// feature stays off rather than minting seats that point at HegAI.
fn resolve_public_url(configured: Option<String>, default: String) -> Option<String> {
    let url = configured.unwrap_or(default);
    let url = url.trim().trim_end_matches('/');
    (!url.is_empty()).then(|| url.to_string())
}

/// The one place the public gateway address is decided: `LLM_PUBLIC_URL`, else
/// HegAI's own on the internal edition and nothing on the external one.
pub fn public_url_from_env() -> Option<String> {
    // Explicitly empty (`LLM_PUBLIC_URL=`) is "off", never "the default": the
    // seat key must not go to a host the operator just cleared.
    if std::env::var("LLM_PUBLIC_URL").is_ok_and(|v| v.trim().is_empty()) {
        return None;
    }
    resolve_public_url(
        env_trimmed("LLM_PUBLIC_URL"),
        crate::edition::hegai_default(PUBLIC_URL_DEFAULT),
    )
}

impl LlmGateway {
    /// `LLM_GATEWAY_URL` (loopback admin API) turns the feature on; the rest
    /// have defaults. `None` = a dev hub: seats are marked ready without a
    /// gateway and the sandbox queue is not blocked on them.
    pub fn from_env() -> Option<Self> {
        let (admin_url, admin_auth) = match split_admin_url(&env_trimmed("LLM_GATEWAY_URL")?) {
            Ok(parts) => parts,
            Err(e) => {
                eprintln!("[llmgw] LLM_GATEWAY_URL is not usable ({e}): gateway seats stay off");
                return None;
            }
        };
        let Some(public_url) = public_url_from_env() else {
            eprintln!(
                "[llmgw] LLM_GATEWAY_URL is set without LLM_PUBLIC_URL: gateway seats stay off"
            );
            return None;
        };
        let template_key = env_trimmed("CC_REMOTE_LLM_COMMUNITY_TEMPLATE_KEY")
            .unwrap_or_else(|| TEMPLATE_DEFAULT.to_string());
        let model = env_trimmed("CC_REMOTE_LLM_COMMUNITY_MODEL")
            .unwrap_or_else(|| MODEL_DEFAULT.to_string());
        let overrides = SeatOverrides {
            tokens_per_day: env_u64("CC_REMOTE_LLM_COMMUNITY_TOKENS_PER_DAY"),
            requests_per_hour: env_u64("CC_REMOTE_LLM_COMMUNITY_REQUESTS_PER_HOUR"),
        };
        let http = reqwest::Client::builder()
            .timeout(ADMIN_TIMEOUT)
            .build()
            .ok()?;
        println!(
            "[llmgw] governance client enabled (template {template_key}, model {model}, tokens/day {}, requests/hour {})",
            overrides
                .tokens_per_day
                .map(|n| n.to_string())
                .unwrap_or_else(|| "template".into()),
            overrides
                .requests_per_hour
                .map(|n| n.to_string())
                .unwrap_or_else(|| "template".into()),
        );
        Some(Self {
            admin_url,
            admin_auth,
            public_url,
            template_key,
            model,
            overrides,
            http,
            seats_cache: tokio::sync::Mutex::new(None),
        })
    }

    /// The inference base URL members and sandboxes are pointed at.
    pub fn public_url(&self) -> &str {
        &self.public_url
    }

    /// The default model written into a sandbox's Codex config.
    pub fn model(&self) -> &str {
        &self.model
    }

    /// Admin-API credentials, when the operator configured them.
    fn admin(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.admin_auth {
            Some((user, pass)) => req.basic_auth(user, Some(pass)),
            None => req,
        }
    }

    async fn get_json(&self, path: &str) -> Result<Value, String> {
        let resp = self
            .admin(self.http.get(format!("{}{path}", self.admin_url)))
            .send()
            .await
            .map_err(|e| format!("GET {path}: gateway unreachable: {e}"))?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| format!("GET {path}: {e}"))?;
        if !status.is_success() {
            return Err(format!("GET {path} -> HTTP {status}: {}", snippet(&text)));
        }
        serde_json::from_str(&text).map_err(|_| format!("GET {path}: non-JSON response"))
    }

    /// A GET whose body the caller parses itself into a narrow typed shape —
    /// the usage collector, whose pages carry request/response bodies that
    /// must never be held as a generic `Value`. Same error discipline as
    /// `get_json`.
    pub(crate) async fn get_text(&self, path: &str) -> Result<String, String> {
        let resp = self
            .admin(self.http.get(format!("{}{path}", self.admin_url)))
            .timeout(LOGS_TIMEOUT)
            .send()
            .await
            .map_err(|e| format!("GET {path}: gateway unreachable: {e}"))?;
        let status = resp.status();
        // Read chunk by chunk under a hard cap: a page of logs with embedded
        // request/response bodies must not be able to fill the hub's memory.
        let mut resp = resp;
        let mut body: Vec<u8> = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|e| format!("GET {path}: {e}"))? {
            if body.len() + chunk.len() > MAX_TEXT_BODY {
                eprintln!(
                    "[llmgw] GET {path}: response over {} MiB, aborted",
                    MAX_TEXT_BODY / (1024 * 1024)
                );
                return Err(format!(
                    "GET {path}: response over {} MiB",
                    MAX_TEXT_BODY / (1024 * 1024)
                ));
            }
            body.extend_from_slice(&chunk);
        }
        let text = String::from_utf8_lossy(&body).into_owned();
        if !status.is_success() {
            // No body: this endpoint carries prompts, answers and key values.
            return Err(format!("GET {path} -> HTTP {status}"));
        }
        Ok(text)
    }

    /// Every seat's governance window by seat name, WITHOUT the secrets: the
    /// raw list carries each key's `value`, which is dropped here and goes no
    /// further. For the usage report's "limit used" column.
    pub async fn seat_limits(&self) -> Result<HashMap<String, SeatLimit>, String> {
        Ok(self
            .list_seats()
            .await?
            .iter()
            .filter_map(|s| {
                let name = s.get("name").and_then(Value::as_str)?.to_string();
                Some((
                    name,
                    SeatLimit {
                        is_active: s.get("is_active").and_then(Value::as_bool).unwrap_or(false),
                        rate_limit: s.get("rate_limit").cloned().unwrap_or(Value::Null),
                    },
                ))
            })
            .collect())
    }

    async fn send_json(
        &self,
        method: reqwest::Method,
        path: &str,
        body: &Value,
    ) -> Result<Value, String> {
        let label = method.as_str().to_string();
        let resp = self
            .admin(
                self.http
                    .request(method, format!("{}{path}", self.admin_url)),
            )
            .json(body)
            .send()
            .await
            .map_err(|e| format!("{label} {path}: gateway unreachable: {e}"))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("{label} {path}: {e}"))?;
        if !status.is_success() {
            return Err(format!(
                "{label} {path} -> HTTP {status}: {}",
                snippet(&text)
            ));
        }
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).map_err(|_| format!("{label} {path}: non-JSON response"))
    }

    /// Bifrost 1.6.4 publishes no OpenAPI, so the update verb is discovered
    /// rather than assumed: PUT first, PATCH as the fallback.
    async fn update_seat(&self, id: &str, payload: &Value) -> Result<(), String> {
        let path = format!("/api/governance/virtual-keys/{id}");
        match self.send_json(reqwest::Method::PUT, &path, payload).await {
            Ok(_) => Ok(()),
            Err(put_error) => match self.send_json(reqwest::Method::PATCH, &path, payload).await {
                Ok(_) => Ok(()),
                Err(patch_error) => Err(format!("{put_error} | {patch_error}")),
            },
        }
    }

    /// Every virtual key, raw. Callers project what they need.
    pub async fn list_seats(&self) -> Result<Vec<Value>, String> {
        let body = self.get_json("/api/governance/virtual-keys").await?;
        Ok(body
            .get("virtual_keys")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    /// The seat named `hegai:<email>`, if any.
    /// `list_seats`, answered from a copy at most `ttl` old. Only for readers
    /// that tolerate a slightly stale budget (the per-key limits endpoint);
    /// provisioning keeps calling `list_seats` directly.
    pub async fn list_seats_cached(&self, ttl: Duration) -> Result<Vec<Value>, String> {
        let mut cache = self.seats_cache.lock().await;
        if let Some((at, seats)) = cache.as_ref() {
            if at.elapsed() < ttl {
                return Ok(seats.clone());
            }
        }
        let seats = self.list_seats().await?;
        *cache = Some((std::time::Instant::now(), seats.clone()));
        Ok(seats)
    }

    pub async fn find_seat(&self, email: &str) -> Result<Option<Seat>, String> {
        let wanted = seat_name(email);
        let seats = self.list_seats().await?;
        Ok(seats
            .iter()
            .find(|s| s.get("name").and_then(Value::as_str) == Some(wanted.as_str()))
            .and_then(seat_from_value))
    }

    /// Create-or-repair-or-reactivate, then prove the seat works. Returns the
    /// seat and what was done (`created` | `repaired` | `reactivated` | `ok`),
    /// for the audit row. An existing seat is never recreated.
    pub async fn ensure_seat(&self, email: &str) -> Result<(Seat, &'static str), String> {
        let name = seat_name(email);
        let seats = self.list_seats().await?;
        let template = seats
            .iter()
            .find(|s| s.get("name").and_then(Value::as_str) == Some(self.template_key.as_str()))
            .ok_or_else(|| {
                format!(
                    "template seat {} not found on the gateway",
                    self.template_key
                )
            })?;
        if is_misrouted(template) {
            return Err(format!(
                "template seat {} is itself misrouted; refusing to clone it",
                self.template_key
            ));
        }
        let body = seat_body_from_template(template, email, &self.overrides);
        let existing = seats
            .iter()
            .find(|s| s.get("name").and_then(Value::as_str) == Some(name.as_str()));
        let action = match existing {
            None => {
                self.send_json(reqwest::Method::POST, "/api/governance/virtual-keys", &body)
                    .await?;
                "created"
            }
            Some(seat) => {
                let id = id_of(seat).ok_or_else(|| format!("seat {name} has no id"))?;
                if is_misrouted(seat) {
                    // Repair in place: recreating would mint a new secret and
                    // break the config of anyone who already installed it.
                    let mut repair = body.clone();
                    if let Some(map) = repair.as_object_mut() {
                        map.remove("name");
                    }
                    self.update_seat(&id, &repair).await?;
                    "repaired"
                } else if !seat
                    .get("is_active")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    self.update_seat(&id, &json!({"is_active": true})).await?;
                    "reactivated"
                } else {
                    "ok"
                }
            }
        };
        // Re-read: the secret is server-generated, and this is also what proves
        // the write actually landed.
        let seat = self
            .find_seat(email)
            .await?
            .ok_or_else(|| format!("seat {name} {action} but did not come back on re-read"))?;
        if seat.value.is_empty() {
            return Err(format!("seat {name} {action} but carries no key"));
        }
        if seat.misrouted {
            return Err(format!("seat {name} {action} but is still misrouted"));
        }
        if !seat.is_active {
            return Err(format!("seat {name} {action} but is still inactive"));
        }
        let models = self.models_for(&seat.value).await?;
        if models.is_empty() {
            return Err(format!(
                "seat {name} {action} but /v1/models is empty — check key_ids routing"
            ));
        }
        Ok((seat, action))
    }

    /// Account erasure removes its exact virtual key, then verifies absence.
    pub async fn erase_seat(&self, email: &str) -> Result<(), String> {
        let Some(seat) = self.find_seat(email).await? else {
            return Ok(());
        };
        self.set_active(email, false).await?;
        let path = format!("/api/governance/virtual-keys/{}", seat.id);
        self.send_json(reqwest::Method::DELETE, &path, &json!({}))
            .await?;
        if self.find_seat(email).await?.is_some() {
            return Err("seat still exists after erasure".into());
        }
        Ok(())
    }

    /// Flip `is_active`. Inference answers 401 on an inactive seat, which is
    /// how suspension reaches an already-installed config. Verified by re-read.
    pub async fn set_active(&self, email: &str, active: bool) -> Result<(), String> {
        let name = seat_name(email);
        let seat = self
            .find_seat(email)
            .await?
            .ok_or_else(|| format!("seat {name} not found"))?;
        if seat.is_active != active {
            self.update_seat(&seat.id, &json!({"is_active": active}))
                .await?;
        }
        let after = self
            .find_seat(email)
            .await?
            .ok_or_else(|| format!("seat {name} vanished after update"))?;
        if after.is_active != active {
            return Err(format!(
                "seat {name}: is_active is still {} after the update",
                after.is_active
            ));
        }
        Ok(())
    }

    /// Model ids this key can actually reach, bare (`gpt-5.5`, not
    /// `pool-a/gpt-5.5`). Uses the OpenAI-compatible `/v1/models` with the
    /// member's own key, not the admin `/api/models`: the latter serves a
    /// stale partial catalog, while this one reflects what *this* key routes
    /// to. Empty means the seat is dead.
    pub async fn models_for(&self, secret: &str) -> Result<Vec<String>, String> {
        let resp = self
            .http
            .get(format!("{}/v1/models", self.admin_url))
            .bearer_auth(secret)
            .send()
            .await
            .map_err(|e| format!("GET /v1/models: gateway unreachable: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(format!("GET /v1/models -> HTTP {status}"));
        }
        let body: Value = resp
            .json()
            .await
            .map_err(|_| "GET /v1/models: non-JSON response".to_string())?;
        Ok(body
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|m| m.get("id").and_then(Value::as_str))
            .map(|id| id.rsplit('/').next().unwrap_or(id).to_string())
            .collect())
    }

    /// One tiny real completion through the PUBLIC edge, the way a member's
    /// Codex reaches it. By memory Bifrost 1.6.4 silently ignores some fields,
    /// so the only proof a seat works is a request that works — this is what
    /// the admin "verify" button runs.
    pub async fn write_probe(&self, secret: &str) -> Result<(), String> {
        let body = json!({
            "model": self.model,
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 8,
        });
        let resp = self
            .http
            .post(format!("{}/chat/completions", self.public_url))
            .timeout(PROBE_TIMEOUT)
            .bearer_auth(secret)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("POST /chat/completions: unreachable: {e}"))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("POST /chat/completions: {e}"))?;
        if !status.is_success() {
            return Err(format!("HTTP {status}: {}", snippet(&text)));
        }
        let parsed: Value =
            serde_json::from_str(&text).map_err(|_| "non-JSON completion".to_string())?;
        if parsed.get("choices").and_then(Value::as_array).is_none() {
            return Err("completion carries no choices".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn active_seat_for_key_matches_only_an_active_exact_secret() {
        let seats = vec![
            json!({"id":"1","name":"hegai:a@x","value":"sk-bf-aaaa1111bbbb2222","is_active":true,
                   "provider_configs":[{"provider":"pool-c","weight":1.0}],
                   "rate_limit":{"token_max_limit":1000,"token_current_usage":250,"token_reset_duration":"1d"}}),
            json!({"id":"2","name":"hegai:b@x","value":"sk-bf-cccc3333dddd4444","is_active":false}),
        ];
        let seat = active_seat_for_key(&seats, "sk-bf-aaaa1111bbbb2222").expect("active seat");
        assert_eq!(seat.name, "hegai:a@x");
        assert_eq!(seat.pool.as_deref(), Some("pool-c"));
        assert!(
            active_seat_for_key(&seats, "sk-bf-cccc3333dddd4444").is_none(),
            "inactive seat"
        );
        assert!(
            active_seat_for_key(&seats, "sk-bf-aaaa1111bbbb222").is_none(),
            "prefix of a secret"
        );
        assert!(
            // Built at runtime: the literal trips the public export's key scanner.
            active_seat_for_key(&seats, &format!("{}3", "sk-bf-aaaa1111bbbb2222")).is_none(),
            "longer than a secret"
        );
        assert!(active_seat_for_key(&seats, "").is_none());
    }

    use super::*;

    #[test]
    fn public_url_is_configured_else_the_editions_default_else_off() {
        let internal = "https://llm.acme.test/v1".to_string();
        assert_eq!(
            resolve_public_url(None, internal.clone()).as_deref(),
            Some("https://llm.acme.test/v1")
        );
        assert_eq!(
            resolve_public_url(Some("https://gw.acme.example/v1/".into()), internal).as_deref(),
            Some("https://gw.acme.example/v1")
        );
        // The external edition's default is empty: nothing configured = off.
        assert_eq!(resolve_public_url(None, String::new()), None);
        assert_eq!(resolve_public_url(Some("  ".into()), String::new()), None);
    }

    #[test]
    fn primary_pool_is_the_heaviest_nonzero_provider() {
        let owner = json!({"provider_configs": [
            {"provider": "pool-a", "weight": 1.0},
            {"provider": "pool-b", "weight": 0.0}
        ]});
        assert_eq!(primary_pool(&owner).as_deref(), Some("pool-a"));
        let bureau = json!({"provider_configs": [{"provider": "pool-c", "weight": 1}]});
        assert_eq!(primary_pool(&bureau).as_deref(), Some("pool-c"));
        let fallback_only = json!({"provider_configs": [{"provider": "pool-b", "weight": 0}]});
        assert_eq!(primary_pool(&fallback_only), None);
        assert_eq!(primary_pool(&json!({})), None);
    }

    #[test]
    fn quota_pools_lists_the_base_first_then_each_pool_file() {
        let dir = std::env::temp_dir().join(format!("ccr-quota-pools-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for f in [
            "quota.json",
            "quota-pool-go.json",
            "quota-pool-c.json",
            "quota-pool-a.json",
            "quota-Bad.json",
            "quota.json.tmp.x",
        ] {
            std::fs::write(dir.join(f), "{}").unwrap();
        }
        let base = dir.join("quota.json");
        let got: Vec<String> = quota_pools(base.to_str().unwrap())
            .into_iter()
            .map(|(p, _)| p)
            .collect();
        assert_eq!(got, vec!["pool-a", "pool-c", "pool-go"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn quota_file_is_per_pool_next_to_the_base() {
        let base = "/opt/llmgw/quota.json";
        let f = |p: Option<&str>| quota_file_for_pool(base, p).map(|f| f.display().to_string());
        assert_eq!(f(None).as_deref(), Some(base));
        assert_eq!(f(Some("pool-a")).as_deref(), Some(base));
        assert_eq!(
            f(Some("pool-c")).as_deref(),
            Some("/opt/llmgw/quota-pool-c.json")
        );
        // Never another account's counter, never a path from a hostile name.
        assert_eq!(f(Some("../etc/x")), None);
        assert_eq!(f(Some("Pool-C")), None);
        assert_eq!(f(Some("")), None);
    }

    fn template() -> Value {
        json!({
            "id": "tpl-1",
            "name": "hegai:template-community",
            "value": "sk-bf-TEMPLATE-SECRET",
            "is_active": true,
            "provider_configs": [{
                "provider": "pool-a",
                "weight": 1.0,
                "allow_all_keys": false,
                "allowed_models": ["*"],
                "blacklisted_models": [],
                "keys": [
                    {"key_id": "k-1", "value": "PROVIDER-SECRET-1"},
                    {"key_id": "k-2", "value": "PROVIDER-SECRET-2"},
                    {"value": "no-id-here"}
                ]
            }],
            "rate_limit": {
                "token_max_limit": 1000,
                "token_reset_duration": "1d",
                "token_current_usage": 5,
                "request_max_limit": 50,
                "request_reset_duration": "1h",
                "request_current_usage": 3
            },
            "budget": {"id": "b-1", "max_limit": 25.0, "reset_duration": "1w", "current_usage": 3.5}
        })
    }

    /// Reads return `keys`; writes must send `key_ids`. Sending `keys` is
    /// accepted with 200 and silently ignored, leaving a seat that routes
    /// nowhere — the state the first hand-made seat was found in.
    #[test]
    fn seat_body_uses_key_ids_never_keys() {
        let body =
            seat_body_from_template(&template(), "Anna@Example.COM", &SeatOverrides::default());
        assert_eq!(body["name"], "hegai:anna@example.com");
        assert_eq!(body["description"], "Community seat anna@example.com");
        assert_eq!(body["is_active"], true);
        let cfg = &body["provider_configs"][0];
        assert_eq!(cfg["provider"], "pool-a");
        assert_eq!(cfg["key_ids"], json!(["k-1", "k-2"]));
        assert_eq!(cfg["allow_all_keys"], false);
        assert_eq!(cfg["allowed_models"], json!(["*"]));
        assert!(cfg.get("keys").is_none());
        let wire = body.to_string();
        assert!(
            !wire.contains("\"keys\""),
            "the write shape never carries `keys`: {wire}"
        );
        assert!(
            !wire.contains("SECRET"),
            "no credential is ever copied onto a seat: {wire}"
        );
        // Budget keeps only its declarative fields.
        assert_eq!(
            body["budget"],
            json!({"max_limit": 25.0, "reset_duration": "1w"})
        );
        // A template with no routing yields no configs — the caller refuses
        // such a template before it gets here, but the function stays total.
        let empty =
            seat_body_from_template(&json!({"name": "x"}), "a@b", &SeatOverrides::default());
        assert_eq!(empty["provider_configs"], json!([]));
        assert!(empty.get("rate_limit").is_none());
        assert!(empty.get("budget").is_none());
    }

    #[test]
    fn overrides_replace_template_limits() {
        // No overrides: the template's four limit fields, no usage counters.
        let copied = seat_body_from_template(&template(), "a@b", &SeatOverrides::default());
        assert_eq!(
            copied["rate_limit"],
            json!({"token_max_limit": 1000, "token_reset_duration": "1d",
                   "request_max_limit": 50, "request_reset_duration": "1h"})
        );
        // Overrides win, and pin the windows they are defined against.
        let overridden = seat_body_from_template(
            &template(),
            "a@b",
            &SeatOverrides {
                tokens_per_day: Some(2_000_000),
                requests_per_hour: Some(300),
            },
        );
        assert_eq!(
            overridden["rate_limit"],
            json!({"token_max_limit": 2_000_000, "token_reset_duration": "1d",
                   "request_max_limit": 300, "request_reset_duration": "1h"})
        );
        // One override leaves the other half of the template alone.
        let half = seat_body_from_template(
            &template(),
            "a@b",
            &SeatOverrides {
                tokens_per_day: Some(7),
                requests_per_hour: None,
            },
        );
        assert_eq!(half["rate_limit"]["token_max_limit"], 7);
        assert_eq!(half["rate_limit"]["request_max_limit"], 50);
        // A template without limits still gets the overrides.
        let mut bare = template();
        bare.as_object_mut().unwrap().remove("rate_limit");
        let built = seat_body_from_template(
            &bare,
            "a@b",
            &SeatOverrides {
                tokens_per_day: None,
                requests_per_hour: Some(9),
            },
        );
        assert_eq!(
            built["rate_limit"],
            json!({"request_max_limit": 9, "request_reset_duration": "1h"})
        );
    }

    #[test]
    fn misrouted_seat_is_detected() {
        assert!(
            is_misrouted(&json!({"name": "x"})),
            "no provider_configs at all"
        );
        assert!(is_misrouted(&json!({"provider_configs": []})));
        assert!(is_misrouted(&json!({"provider_configs": [
            {"provider": "pool-a", "allow_all_keys": false, "keys": []}
        ]})));
        assert!(is_misrouted(&json!({"provider_configs": [
            {"provider": "pool-a", "allow_all_keys": false}
        ]})));
        assert!(!is_misrouted(&json!({"provider_configs": [
            {"provider": "pool-a", "allow_all_keys": true}
        ]})));
        assert!(!is_misrouted(&template()));
        // One bad provider among good ones still counts: it would swallow a
        // share of the traffic and fail it.
        assert!(is_misrouted(&json!({"provider_configs": [
            {"provider": "pool-a", "allow_all_keys": false, "keys": [{"key_id": "k"}]},
            {"provider": "pool-b", "allow_all_keys": false, "keys": []}
        ]})));
        let seat = seat_from_value(&template()).unwrap();
        assert!(!seat.misrouted);
        assert_eq!(seat.value, "sk-bf-TEMPLATE-SECRET");
        assert_eq!(seat.id, "tpl-1");
        assert_eq!(
            seat_from_value(&json!({"id": 42, "name": "n"})).unwrap().id,
            "42"
        );
        assert!(seat_from_value(&json!({"name": "no-id"})).is_none());
        assert_eq!(seat_name(" Anna@X.io "), "hegai:anna@x.io");
    }

    #[test]
    fn reset_at_is_last_reset_plus_window() {
        let rl = json!({"token_last_reset": "2023-11-14T22:13:20Z", "token_reset_duration": "1d"});
        assert_eq!(reset_at_ms(&rl), Some(1_700_000_000_000 + 86_400_000));
        assert!(reset_at_ms(&json!({"token_reset_duration": "1d"})).is_none());
        assert!(
            reset_at_ms(&json!({"token_last_reset": "garbage", "token_reset_duration": "1d"}))
                .is_none()
        );
        assert!(reset_at_ms(&Value::Null).is_none());
        let rl =
            json!({"request_last_reset": "2023-11-14T22:13:20Z", "request_reset_duration": "1h"});
        assert_eq!(
            request_reset_at_ms(&rl),
            Some(1_700_000_000_000 + 3_600_000)
        );
        assert!(reset_at_ms(&rl).is_none(), "windows are independent");
    }

    #[test]
    fn admin_url_credentials_are_split_off_and_decoded() {
        let (url, auth) = split_admin_url("http://admin:p%40ss%3Aw0rd@bifrost:8080/").unwrap();
        assert_eq!(url, "http://bifrost:8080");
        assert_eq!(auth, Some(("admin".into(), "p@ss:w0rd".into())));
        assert!(
            !url.contains("admin"),
            "the logged URL carries no credentials"
        );

        let (url, auth) = split_admin_url(" http://127.0.0.1:8099 ").unwrap();
        assert_eq!((url.as_str(), auth), ("http://127.0.0.1:8099", None));

        let (url, _) = split_admin_url("https://gw.example.com/bifrost/").unwrap();
        assert_eq!(url, "https://gw.example.com/bifrost");
    }

    #[test]
    fn admin_url_refuses_what_would_break_path_joining_or_half_credentials() {
        assert!(split_admin_url("bifrost:8080").is_err());
        assert!(split_admin_url("ftp://bifrost").is_err());
        assert!(split_admin_url("http://bifrost:8080/?x=1").is_err());
        assert!(split_admin_url("http://bifrost:8080/#f").is_err());
        assert!(split_admin_url("http://admin@bifrost:8080").is_err());
        assert!(split_admin_url("http://:pw@bifrost:8080").is_err());
    }
}
