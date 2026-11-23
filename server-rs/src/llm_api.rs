//! HTTP surface of the personal LLM gateway access: the signed-in member's own
//! key and limits (`/api/llm-access`, `/api/budget`), the shared-quota meter
//! (`/api/gateway-quota`) and the one-click Codex installers
//! (`/api/llm-access/installer`), with the store-only ZIP that carries the
//! macOS script's executable bit.

use super::*;

// Personal HegAI-gateway installers, templated per user with __KEY__/__BASE__/__MODEL__.
// They merge a `[model_providers.hegai]` block into ~/.codex/config.toml and set it
// as the default provider — idempotently (a sentinel-marked block + a stripped-then-
// re-added hegai table), preserving every other setting and backing up the old file.
// Root keys (model / model_provider) are re-emitted at the very top because TOML
// requires them before the first table header; a naive append would misfile them.
const MAC_INSTALLER_TMPL: &str = include_str!("../assets/install-hegai-mac.command");
const WIN_INSTALLER_TMPL: &str = include_str!("../assets/install-hegai-win.bat");

/// Personal LLM gateway credentials for the signed-in user.
///
/// Everyone who can complete HegAI SSO reaches this route — that is ~1900 active
/// community members, not just staff. So access is *opt-in by provisioning*: we
/// return a key only when a virtual key named exactly `hegai:<email>` already
/// exists upstream. No key provisioned => `{"hasAccess": false}`. This endpoint
/// never creates keys and never returns anyone else's.
///
/// Matching is on the full lowercased email, not its local-part: local-parts are
/// not unique across the member table and many members have no email at all.
pub(crate) async fn api_llm_access(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    // Two ways in, resolving to the same thing — an email. Everything below this
    // block is identical for both, which is why the link path adds no new surface
    // beyond "who are you": it can still only read that one person's own key.
    let (email, plan) = match params.get("t") {
        // Access links are the legacy hand-provisioned program (members with
        // no HegAI account) — the employee shape of the page.
        Some(link) => match email_from_access_link(&st, link) {
            Some(email) => (email, "employee".to_string()),
            None => return api_error(StatusCode::UNAUTHORIZED, "invalid access link"),
        },
        None => {
            let user = gate!(authenticated_user(&headers, &st));
            let plan = st
                .workspaces
                .access_state(&user)
                .map(|a| a.plan)
                .unwrap_or_else(|_| "community".into());
            // Not a 403: the access page renders the waiting / suspended state
            // from `reason`, and a key is not something a waitlisted member
            // may even look up (it appears together with activation).
            if let Err(state) = access_gate_state(&st.workspaces, &user) {
                return Json(json!({
                    "hasAccess": false,
                    "configured": true,
                    "reason": state,
                    "plan": plan,
                }))
                .into_response();
            }
            let admin = st.platform_admins.contains(&user);
            match st.workspaces.ui_access(&user, None, admin) {
                Ok(access) => {
                    let email = access
                        .viewer
                        .get("email")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .trim()
                        .to_ascii_lowercase();
                    // A Telegram-only member of a self-hosted hub has no
                    // address; their seat is keyed by a synthetic one.
                    let email = if email.is_empty() {
                        st.workspaces.seat_key(&user).unwrap_or_default()
                    } else {
                        email
                    };
                    (email, plan)
                }
                Err(e) => return store_failure(e),
            }
        }
    };
    let Some(gw) = st.llmgw.clone() else {
        return Json(json!({"hasAccess": false, "configured": false, "plan": plan}))
            .into_response();
    };
    if email.is_empty() {
        return Json(json!({"hasAccess": false, "configured": true, "plan": plan})).into_response();
    }
    let seat = match gw.find_seat(&email).await {
        Ok(Some(seat)) => seat,
        Ok(None) => {
            return Json(json!({"hasAccess": false, "configured": true, "plan": plan}))
                .into_response()
        }
        Err(e) => return refusal(StatusCode::BAD_GATEWAY, e),
    };

    // Deliberately narrow projection: only this user's own secret and their own
    // limits. Everything else in the upstream record stays server-side. The
    // model list is best-effort — a failure there must not withhold the key.
    let models = gw.models_for(&seat.value).await.unwrap_or_default();
    let pick = |k: &str| seat.rate_limit.get(k).cloned().unwrap_or(Value::Null);
    let api_key = if seat.value.is_empty() {
        Value::Null
    } else {
        Value::String(seat.value.clone())
    };
    let mut out = json!({
        "hasAccess": seat.is_active,
        "configured": true,
        "email": email,
        "plan": plan,
        "apiKey": api_key,
        "baseUrl": st.llm_public_url,
        "models": models,
        // What the installers write; the web's Codex switch passes them on.
        "installerModel": installer_model(),
        "installerEffort": installer_effort(),
        "limits": {
            "requests": pick("request_max_limit"),
            "requestsWindow": pick("request_reset_duration"),
            "requestsUsed": pick("request_current_usage"),
            "tokens": pick("token_max_limit"),
            "tokensWindow": pick("token_reset_duration"),
            "tokensUsed": pick("token_current_usage"),
        },
    });
    // Shared-subscription quota (the same metric Codex itself shows), read from
    // the cron-written snapshot. Employees only: a community member gets their
    // own limits, not the team's shared counter. Best-effort; absence hides the bar.
    if plan != "community" {
        out["gatewayQuota"] = read_gateway_quota(&st, seat.pool.as_deref());
    }
    Json(out).into_response()
}

/// The cron-written snapshot of the subscription behind `pool`, or `null`.
/// Each pool is a separate ChatGPT account (the bureau's seats sit on
/// `pool-c`), so a member must see their own pool's counter, not pool-a's.
fn read_gateway_quota(st: &AppState, pool: Option<&str>) -> Value {
    st.llm_quota_file
        .as_ref()
        .and_then(|base| llmgw::quota_file_for_pool(base, pool))
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(|q| q.get("ok").and_then(Value::as_bool).unwrap_or(false))
        .unwrap_or(Value::Null)
}

/// `GET /api/budget` → `{plan, limits}` — the signed-in user's own gateway
/// limits and usage, projected from the seat's `rate_limit` exactly as
/// `/api/llm-access` does, minus the key. Any signed-in user (active or not);
/// `limits` is `{}` when there is no seat. Optional fields are omitted, not
/// null. Cheap enough for a header meter to poll.
pub(crate) async fn api_budget(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let user = gate!(authenticated_user(&headers, &st));
    let plan = st
        .workspaces
        .access_state(&user)
        .map(|a| a.plan)
        .unwrap_or_else(|_| "community".into());
    let empty = || Json(json!({"plan": plan, "limits": {}})).into_response();
    let (Some(gw), Some(email)) = (st.llmgw.clone(), st.workspaces.seat_key(&user)) else {
        return empty();
    };
    let seat = match gw.find_seat(&email).await {
        Ok(Some(seat)) => seat,
        Ok(None) => return empty(),
        Err(e) => return refusal(StatusCode::BAD_GATEWAY, e),
    };
    let limits = llmgw::limits_projection(&seat.rate_limit);
    Json(json!({"plan": plan, "limits": limits})).into_response()
}

/// `from`/`to` of a usage request, validated; a bad pair is a 400.
fn usage_period(params: &HashMap<String, String>) -> Result<(String, String), Response> {
    llm_usage::parse_period(
        params.get("from").map(String::as_str),
        params.get("to").map(String::as_str),
        crate::workspace::now_ms(),
    )
    .map_err(|e| refusal(StatusCode::BAD_REQUEST, e))
}

/// `GET /api/workspaces/{id}/usage?from&to` — «Расходы»: per person, gateway
/// tokens / requests by model and day, the seat's budget window and the
/// latest own-subscription limits. The owner sees every member, a manager the
/// members assigned to them, a member only themselves. Without a gateway the
/// answer is `configured: false` and no people.
pub(crate) async fn api_workspace_usage(
    AxumPath(workspace_id): AxumPath<String>,
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let actor = gate!(authenticated_user(&headers, &st));
    let (from, to) = match usage_period(&params) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let (scope, subjects) = match st.workspaces.usage_subjects(&actor, &workspace_id) {
        Ok(v) => v,
        Err(e) => return refusal(StatusCode::FORBIDDEN, e),
    };
    usage_response(&st, scope, &subjects, &from, &to).await
}

/// `GET /api/me/usage?from&to` — the signed-in person's own row.
pub(crate) async fn api_me_usage(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let user = gate!(authenticated_user(&headers, &st));
    let (from, to) = match usage_period(&params) {
        Ok(v) => v,
        Err(e) => return e,
    };
    let me = match st.workspaces.usage_self(&user) {
        Ok(v) => v,
        Err(e) => return store_failure(e),
    };
    usage_response(&st, "self", &[me], &from, &to).await
}

async fn usage_response(
    st: &AppState,
    scope: &str,
    subjects: &[llm_usage::Subject],
    from: &str,
    to: &str,
) -> Response {
    let Some(gw) = st.llmgw.clone() else {
        return Json(
            json!({"from": from, "to": to, "configured": false, "scope": scope, "members": []}),
        )
        .into_response();
    };
    let limits = llm_usage::seat_limits_cached(&gw).await;
    match llm_usage::build_report(
        &st.workspaces,
        scope,
        subjects,
        limits.as_ref(),
        from,
        to,
        crate::workspace::now_ms(),
    ) {
        Ok(v) => Json(v).into_response(),
        Err(e) => store_failure(e),
    }
}

/// Default model written into a generated Codex config. Matches the shared
/// `~/.codex` gateway profile; move it here if the gateway's default changes.
pub(crate) const LLM_INSTALLER_MODEL: &str = "gpt-5.6-sol";

/// The model the installers and provisioning jobs write: `CC_REMOTE_LLM_INSTALLER_MODEL`,
/// else [`LLM_INSTALLER_MODEL`].
pub(crate) fn installer_model() -> String {
    env_or("CC_REMOTE_LLM_INSTALLER_MODEL", LLM_INSTALLER_MODEL)
}

/// The effort they write: `CC_REMOTE_LLM_INSTALLER_EFFORT`, else [`LLM_INSTALLER_EFFORT`].
pub(crate) fn installer_effort() -> String {
    let v = env_or("CC_REMOTE_LLM_INSTALLER_EFFORT", LLM_INSTALLER_EFFORT);
    if matches!(v.as_str(), "minimal" | "low" | "medium" | "high" | "xhigh") {
        v
    } else {
        eprintln!("[llm] CC_REMOTE_LLM_INSTALLER_EFFORT={v} is not a reasoning effort - using {LLM_INSTALLER_EFFORT}");
        LLM_INSTALLER_EFFORT.to_string()
    }
}

/// The value goes verbatim into shell / PowerShell installers and TOML: only a
/// plain model-id alphabet is accepted, anything else falls back (and says so).
fn env_or(name: &str, default: &str) -> String {
    let Some(v) = std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    else {
        return default.to_string();
    };
    if v.len() <= 64
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '/'))
    {
        v
    } else {
        eprintln!("[llm] {name} has characters a model id cannot have - using {default}");
        default.to_string()
    }
}

/// Reasoning effort written alongside it. NOT cosmetic: a config that names no
/// effort starts Codex at `reasoning effort: none` (measured 19.09.2026 on a
/// profile the installer had written), because the gateway's models declare
/// their own default as `low` and the profile overrode nothing. Every member
/// installed before this was coding on a model with reasoning switched off.
/// `medium` and not `high`: one shared subscription backs the whole fleet, and
/// effort is the per-turn knob the composer already exposes for the rest.
pub(crate) const LLM_INSTALLER_EFFORT: &str = "medium";

/// One-click installer for the HegAI gateway. Returns a platform script with the
/// caller's own key already inlined, so a non-technical member can point Codex /
/// the ChatGPT app at the gateway without hand-editing `~/.codex/config.toml`.
/// `os=mac` → a zipped `.command` (the zip carries the +x bit a bare download
/// would lack); `os=win` → a `.bat` that runs an inlined PowerShell script.
/// Same SSO gate and the same `hegai:{email}` key lookup as `/api/llm-access`.
pub(crate) async fn api_llm_installer(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let user = gate!(authenticated_user(&headers, &st));
    gate!(require_active(&st, &user));
    let (key, base) = match installer_gateway_key(&st, &user).await {
        Ok(v) => v,
        Err(e) => return e,
    };
    match params.get("os").map(String::as_str) {
        Some("win") => {
            let script = render_win_installer(&key, &base, &installer_model());
            public_download(script, "application/octet-stream", "HegAI-Codex-Setup.bat")
        }
        Some("mac") | None => {
            let script = render_mac_installer(&key, &base, &installer_model());
            let zip = zip_single("HegAI Setup.command", script.as_bytes(), 0o100_755);
            public_download(zip, "application/zip", "HegAI-Codex-Setup.command.zip")
        }
        Some(other) => api_error(StatusCode::BAD_REQUEST, format!("unknown os '{other}'")),
    }
}

/// Resolve the caller's own gateway secret + public base URL. Mirrors the
/// key-lookup half of `api_llm_access`, kept separate so that endpoint stays
/// untouched. The `Err` arm is a ready-to-return response for the no-access cases.
async fn installer_gateway_key(st: &AppState, user: &str) -> Result<(String, String), Response> {
    let Some(gw) = st.llmgw.clone() else {
        return Err(api_error(StatusCode::NOT_FOUND, "gateway not configured"));
    };
    let admin = st.platform_admins.contains(user);
    let email = match st.workspaces.ui_access(user, None, admin) {
        Ok(access) => access
            .viewer
            .get("email")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase(),
        Err(e) => return Err(store_failure(e)),
    };
    let email = if email.is_empty() {
        st.workspaces.seat_key(user).unwrap_or_default()
    } else {
        email
    };
    if email.is_empty() {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "no gateway access for this account",
        ));
    }
    let seat = match gw.find_seat(&email).await {
        Ok(Some(seat)) => seat,
        Ok(None) => {
            return Err(api_error(
                StatusCode::FORBIDDEN,
                "no gateway key for this account",
            ))
        }
        Err(e) => return Err(refusal(StatusCode::BAD_GATEWAY, e)),
    };
    if !seat.is_active || seat.value.is_empty() {
        return Err(api_error(StatusCode::FORBIDDEN, "gateway key inactive"));
    }
    Ok((seat.value, st.llm_public_url.clone()))
}

fn render_mac_installer(key: &str, base: &str, model: &str) -> String {
    MAC_INSTALLER_TMPL
        .replace("__KEY__", key)
        .replace("__BASE__", base)
        .replace("__MODEL__", model)
        .replace("__EFFORT__", &installer_effort())
}

fn render_win_installer(key: &str, base: &str, model: &str) -> String {
    WIN_INSTALLER_TMPL
        .replace("__KEY__", key)
        .replace("__BASE__", base)
        .replace("__MODEL__", model)
        .replace("__EFFORT__", &installer_effort())
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// Minimal store-only (no compression) ZIP wrapping a single file with an explicit
/// unix mode. We zip the macOS `.command` purely so its executable bit survives the
/// download — a bare script served over HTTP arrives 0644 and double-clicking it
/// fails with "permission denied".
fn zip_single(name: &str, data: &[u8], unix_mode: u32) -> Vec<u8> {
    let name_b = name.as_bytes();
    let crc = crc32(data);
    let size = data.len() as u32;
    let nlen = name_b.len() as u16;
    let mut out: Vec<u8> = Vec::new();

    // Local file header.
    out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
    out.extend_from_slice(&20u16.to_le_bytes()); // version needed
    out.extend_from_slice(&0u16.to_le_bytes()); // flags
    out.extend_from_slice(&0u16.to_le_bytes()); // method: store
    out.extend_from_slice(&0u16.to_le_bytes()); // mod time
    out.extend_from_slice(&0u16.to_le_bytes()); // mod date
    out.extend_from_slice(&crc.to_le_bytes());
    out.extend_from_slice(&size.to_le_bytes()); // compressed
    out.extend_from_slice(&size.to_le_bytes()); // uncompressed
    out.extend_from_slice(&nlen.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // extra len
    out.extend_from_slice(name_b);
    out.extend_from_slice(data);

    let cd_offset = out.len() as u32;

    // Central directory header.
    out.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
    out.extend_from_slice(&0x0314u16.to_le_bytes()); // version made by: unix, v20
    out.extend_from_slice(&20u16.to_le_bytes()); // version needed
    out.extend_from_slice(&0u16.to_le_bytes()); // flags
    out.extend_from_slice(&0u16.to_le_bytes()); // method
    out.extend_from_slice(&0u16.to_le_bytes()); // mod time
    out.extend_from_slice(&0u16.to_le_bytes()); // mod date
    out.extend_from_slice(&crc.to_le_bytes());
    out.extend_from_slice(&size.to_le_bytes());
    out.extend_from_slice(&size.to_le_bytes());
    out.extend_from_slice(&nlen.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // extra len
    out.extend_from_slice(&0u16.to_le_bytes()); // comment len
    out.extend_from_slice(&0u16.to_le_bytes()); // disk number start
    out.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
    out.extend_from_slice(&(unix_mode << 16).to_le_bytes()); // external attrs
    out.extend_from_slice(&0u32.to_le_bytes()); // local header offset
    out.extend_from_slice(name_b);

    let cd_size = out.len() as u32 - cd_offset;

    // End of central directory.
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // this disk
    out.extend_from_slice(&0u16.to_le_bytes()); // cd start disk
    out.extend_from_slice(&1u16.to_le_bytes()); // entries this disk
    out.extend_from_slice(&1u16.to_le_bytes()); // entries total
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // comment len
    out
}

/// The shared Codex subscription's remaining quota (global, no secrets), for the
/// header usage meter. Available to any signed-in user — it's a team-health figure,
/// not gated on having a personal gateway key like /api/llm-access is. A valid
/// access link counts as identification too, so a link-only member still sees how
/// much of the shared plan is left.
pub(crate) async fn api_gateway_quota(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    let link_email = params
        .get("t")
        .and_then(|link| email_from_access_link(&st, link));
    // A platform admin also gets every pool's counter (`pools`), so the popover
    // can show pool-a, the bureau's pool-c and OpenCode Go side by side. Only
    // a signed-in admin: an access link never unlocks it.
    let mut admin = false;
    let email = match link_email {
        Some(email) => Some(email),
        None => match authenticated_user(&headers, &st) {
            Ok(user) => {
                admin = st.platform_admins.contains(&user) || st.bootstrap_user_id == user;
                st.workspaces.seat_key(&user)
            }
            Err(e) => return e,
        },
    };
    // Which account's counter: the pool the caller's own seat routes to. No
    // seat (a link-only or community member) shows pool-a as before. A failed
    // seat lookup hides the meter: guessing pool-a would show a bureau member
    // another account's numbers as if they were theirs.
    // `own_pool`: which of `pools` is the caller's, so the popover can put
    // the gateway machines under it. `None` when the lookup failed.
    let (quota, own_pool) = match (st.llmgw.clone(), email) {
        (Some(gw), Some(email)) => match gw.find_seat(&email).await {
            Ok(seat) => {
                let pool = seat.and_then(|s| s.pool);
                (
                    read_gateway_quota(&st, pool.as_deref()),
                    Some(pool.unwrap_or_else(|| "pool-a".into())),
                )
            }
            Err(_) => (Value::Null, None),
        },
        _ => (read_gateway_quota(&st, None), Some("pool-a".into())),
    };
    let mut out = json!({ "gatewayQuota": quota });
    if admin {
        out["pools"] = Value::Array(read_all_pool_quotas(&st));
        out["ownPool"] = json!(own_pool);
    }
    Json(out).into_response()
}

/// `GET /api/gateway/key-limits` with `Authorization: Bearer sk-bf-…` →
/// `{pool, limits, quota}` for THAT key only: its own budget window
/// (`limits_projection`, the same shape as `/api/budget`) and the snapshot of
/// the subscription its traffic goes to. No hub account is involved — the
/// caller is an agent whose Codex points at this gateway, on any hub
/// (including a customer's self-hosted one that knows nothing of Bifrost), and
/// the key it already holds is its identification. Also served on the gateway
/// host as `/hegai/limits` (nginx), which is where agents look.
///
/// The key is matched in constant time against active seats; anything else is
/// a plain 401 with no hint of which part was wrong. Nothing secret comes
/// back: no key, no seat name, no email.
pub(crate) async fn api_gateway_key_limits(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let unauthorized = || refusal(StatusCode::UNAUTHORIZED, "unknown gateway key");
    let Some(key) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|k| k.starts_with("sk-bf-") && (16..=200).contains(&k.len()))
    else {
        return unauthorized();
    };
    let Some(gw) = st.llmgw.clone() else {
        return refusal(StatusCode::NOT_FOUND, "no gateway on this hub");
    };
    // Cached: the caller is unauthenticated until the key matches, and a fresh
    // admin listing per guess would load the process that serves inference.
    let seats = match gw
        .list_seats_cached(std::time::Duration::from_secs(30))
        .await
    {
        Ok(seats) => seats,
        Err(e) => {
            // The admin API's own error text names internal URLs: log it, say less.
            log_internal(&e);
            return api_error(StatusCode::BAD_GATEWAY, INTERNAL_ERROR_BODY);
        }
    };
    let found = llmgw::active_seat_for_key(&seats, key);
    let Some(seat) = found else {
        return unauthorized();
    };
    let pool = seat.pool.clone().unwrap_or_else(|| "pool-a".into());
    Json(json!({
        "pool": pool,
        "limits": llmgw::limits_projection(&seat.rate_limit),
        "quota": read_gateway_quota(&st, Some(&pool)),
    }))
    .into_response()
}

/// `[{pool, quota}]` for every pool whose snapshot is `ok` and fresh. The
/// probes run every 5 minutes; a snapshot older than 30 is a probe that is no
/// longer scheduled (or a leftover file), and its numbers are not current.
fn read_all_pool_quotas(st: &AppState) -> Vec<Value> {
    const MAX_AGE_SECS: i64 = 30 * 60;
    let Some(base) = st.llm_quota_file.as_deref() else {
        return Vec::new();
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    llmgw::quota_pools(base)
        .into_iter()
        .filter_map(|(pool, path)| {
            let quota = std::fs::read_to_string(path)
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .filter(|q| q.get("ok").and_then(Value::as_bool).unwrap_or(false))
                .filter(|q| {
                    q.get("updated_at")
                        .and_then(Value::as_i64)
                        .is_some_and(|t| now - t < MAX_AGE_SECS)
                })?;
            Some(json!({ "pool": pool, "quota": quota }))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installer_defaults_are_valid_for_the_agent() {
        let m = installer_model();
        assert!(!m.is_empty() && m.len() <= 64);
        assert!(m
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:/-".contains(c)));
        assert!(matches!(
            installer_effort().as_str(),
            "minimal" | "low" | "medium" | "high" | "xhigh"
        ));
    }

    #[test]
    fn crc32_matches_the_standard_check_vector() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(crc32(b""), 0);
    }

    #[test]
    fn zip_single_carries_the_executable_bit() {
        let z = zip_single("HegAI Setup.command", b"#!/bin/bash\necho hi\n", 0o100_755);
        // Local + central + end-of-central-directory signatures present.
        assert_eq!(&z[0..4], &0x0403_4b50u32.to_le_bytes());
        let cd = z
            .windows(4)
            .position(|w| w == 0x0201_4b50u32.to_le_bytes())
            .expect("central directory header");
        // External attributes (mode << 16) sit 38 bytes into the central header.
        let ext = u32::from_le_bytes(z[cd + 38..cd + 42].try_into().unwrap());
        assert_eq!(ext >> 16, 0o100_755);
    }

    #[test]
    fn installers_inline_the_key_and_leave_no_placeholders() {
        let mac = render_mac_installer("sk-bf-abc", "https://llm.acme.test/v1", "gpt-5.6-sol");
        assert!(mac.contains("sk-bf-abc") && mac.contains("gpt-5.6-sol"));
        assert!(
            !mac.contains("__KEY__") && !mac.contains("__BASE__") && !mac.contains("__MODEL__")
        );
        let win = render_win_installer("sk-bf-abc", "https://llm.acme.test/v1", "gpt-5.6-sol");
        assert!(win.contains("sk-bf-abc"));
        assert!(
            !win.contains("__KEY__") && !win.contains("__BASE__") && !win.contains("__MODEL__")
        );
        // A profile that names no effort starts Codex at `reasoning effort:
        // none` — so the line is as load-bearing as the model, and an
        // unsubstituted `__EFFORT__` would write a config Codex refuses to
        // parse. Both scripts, both placeholders.
        // The scripts EMIT that line rather than contain it (awk / PowerShell
        // rebuild the TOML), so assert on the pair: the key is written, and the
        // level reached the template.
        for script in [&mac, &win] {
            assert!(script.contains("model_reasoning_effort"));
            assert!(script.contains(LLM_INSTALLER_EFFORT));
            assert!(!script.contains("__EFFORT__"));
        }
    }
}
