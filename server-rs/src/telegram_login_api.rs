//! HTTP side of signing in with Telegram (store: `telegram_login.rs`).
//!
//! - `POST /api/auth/telegram/start` — open for a sign-in; a signed-in,
//!   active, same-origin mutation for `intent: "link"`. Rate-limited per
//!   address. Answers the code for the bot, the poll token, and the MATCH
//!   number the client must show.
//! - `POST /api/auth/telegram/poll`  — the client picks the result up; the
//!   session is minted HERE, so no session token ever passes through the bot.
//! - `POST /api/auth/telegram/confirm` — the bot, and only the bot: its own
//!   credential class (`CC_REMOTE_TG_LOGIN_SECRET`), never the fleet token,
//!   the SSO secret or an owner session.
//! - `POST /api/auth/telegram/link` — «Да, это мой @username»: the signed-in,
//!   active account that asked for a link makes it (see telegram_login.rs for
//!   why a press in Telegram only proposes one).
//!
//! Unset or too-short secret => all four answer 404, like provisioning.

use super::*;
use crate::provisioning_api::ct_eq;
use crate::rate_window::rate_ip;
use crate::telegram_login::{session_days, Press, TgUser};

/// Same floor as every other secret on this hub.
const SECRET_MIN: usize = 32;
/// Sign-ins started per address per hour: a person retrying fits, a scanner
/// filling the open-login cap does not.
const STARTS_PER_HOUR: usize = 20;
/// Polls per address per minute: one client every 2 s is 30.
const POLLS_PER_MINUTE: usize = 120;
/// The only device labels a client may name itself with. Free text would be
/// a line of the confirmation card written by whoever started the login —
/// «iPhone · проверка безопасности» is exactly what a phisher would send.
const DEVICE_NAMES: [&str; 6] = ["iPhone", "iPad", "Android", "Mac", "Windows", "Linux"];

#[derive(Clone)]
pub(crate) struct TgLoginConfig {
    pub secret: String,
    /// The bot's username, for `t.me/<bot>?start=login_<code>`.
    pub bot: String,
}

/// `None` — every route 404 — when the secret is unset, short, or already
/// doing another job (reusing one would fold two credential classes).
pub(crate) fn load_tg_login_config(
    secret: Option<&str>,
    bot: Option<&str>,
    other_secrets: &[Option<&str>],
) -> Option<TgLoginConfig> {
    let secret = secret?.trim();
    if secret.len() < SECRET_MIN {
        eprintln!("[tg-login] CC_REMOTE_TG_LOGIN_SECRET is shorter than {SECRET_MIN} characters — Telegram sign-in stays off");
        return None;
    }
    if other_secrets.iter().flatten().any(|s| s.trim() == secret) {
        eprintln!("[tg-login] CC_REMOTE_TG_LOGIN_SECRET equals another hub secret — refusing to reuse it; Telegram sign-in stays off");
        return None;
    }
    let bot = bot
        .map(|b| b.trim().trim_start_matches('@').to_string())
        .filter(|b| !b.is_empty() && b.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or_else(|| "Hegaicodebot".to_string());
    Some(TgLoginConfig {
        secret: secret.to_string(),
        bot,
    })
}

fn not_configured() -> Response {
    api_error(
        StatusCode::NOT_FOUND,
        "telegram sign-in is not configured on this hub",
    )
}

/// `web` (a tab: a week), `pwa` / `native` (an installed app: 90 days) —
/// the same split `sso_callback` makes.
fn client_kind(body: &Value) -> &'static str {
    match body.get("client").and_then(Value::as_str) {
        Some("native") => "native",
        Some("pwa") => "pwa",
        _ => "web",
    }
}

/// What the bot shows as «with which device»: one of `DEVICE_NAMES` when the
/// client names itself (the apps know they are «iPhone»), else a guess from
/// the User-Agent. Never text the client chose freely.
pub(crate) fn device_label(headers: &HeaderMap, body: &Value) -> String {
    if let Some(d) = body.get("device").and_then(Value::as_str) {
        if let Some(name) = DEVICE_NAMES.iter().find(|n| **n == d.trim()) {
            return (*name).to_string();
        }
    }
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let browser = if ua.contains("Edg/") {
        "Edge"
    } else if ua.contains("YaBrowser") {
        "Яндекс Браузер"
    } else if ua.contains("Firefox/") {
        "Firefox"
    } else if ua.contains("Chrome/") {
        "Chrome"
    } else if ua.contains("Safari/") {
        "Safari"
    } else {
        "браузер"
    };
    let os = if ua.contains("iPhone") || ua.contains("iPad") {
        "iOS"
    } else if ua.contains("Android") {
        "Android"
    } else if ua.contains("Windows") {
        "Windows"
    } else if ua.contains("Mac OS X") || ua.contains("Macintosh") {
        "macOS"
    } else if ua.contains("Linux") {
        "Linux"
    } else {
        ""
    };
    if os.is_empty() {
        browser.to_string()
    } else {
        format!("{browser} · {os}")
    }
}

pub(crate) async fn api_tg_login_start(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let Some(cfg) = st.tg_login.clone() else {
        return not_configured();
    };
    let link_user = match body.get("intent").and_then(Value::as_str) {
        // Adding a way in is a change to an account: signed in, same-origin,
        // and through the access gate like every other change (CLAUDE.md,
        // rule 5) — a waitlisted or suspended account does not add one.
        Some("link") => match mutation_user(&headers, &st) {
            Ok(user) => {
                gate!(require_active(&st, &user));
                Some(user)
            }
            Err(response) => return response,
        },
        None | Some("login") => None,
        Some(_) => return api_error(StatusCode::BAD_REQUEST, "unknown intent"),
    };
    // The full address goes to the audit trail; the /64 is what limits count.
    let ip = client_ip(&headers);
    let rate = rate_ip(ip.as_deref());
    let key = match check_window_quota(
        &st,
        &format!("tg-login-start:{}", rate.as_deref().unwrap_or("?")),
        STARTS_PER_HOUR,
        60 * 60 * 1000,
        "too many sign-in attempts from this address",
    ) {
        Ok(key) => key,
        Err(r) => return r,
    };
    let client = client_kind(&body);
    let device = device_label(&headers, &body);
    match st.workspaces.start_telegram_login(
        link_user.as_deref(),
        client,
        &device,
        ip.as_deref(),
        rate.as_deref(),
    ) {
        Ok(mut v) => {
            record_window_hit(&st, &key, 60 * 60 * 1000);
            let code = v["code"].as_str().unwrap_or("").to_string();
            v["bot"] = json!(cfg.bot);
            v["url"] = json!(format!("https://t.me/{}?start=login_{code}", cfg.bot));
            (StatusCode::CREATED, Json(v)).into_response()
        }
        Err(e) if e.contains("this address") => refusal(StatusCode::TOO_MANY_REQUESTS, e),
        Err(e) => refusal(StatusCode::SERVICE_UNAVAILABLE, e),
    }
}

pub(crate) async fn api_tg_login_poll(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if st.tg_login.is_none() {
        return not_configured();
    }
    let ip = rate_ip(client_ip(&headers).as_deref());
    let key = match check_window_quota(
        &st,
        &format!("tg-login-poll:{}", ip.as_deref().unwrap_or("?")),
        POLLS_PER_MINUTE,
        60 * 1000,
        "polling too fast",
    ) {
        Ok(key) => key,
        Err(r) => return r,
    };
    let token = body.get("pollToken").and_then(Value::as_str).unwrap_or("");
    if token.is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "pollToken required");
    }
    // Counted after the cheap refusal: a token-less request costs no slot.
    record_window_hit(&st, &key, 60 * 1000);
    let result = match st.workspaces.poll_telegram_login(token) {
        Ok(v) => v,
        Err(e) => return store_failure(e),
    };
    // `pending`, `denied`, `expired`, `used`, `unknown`, and a link's
    // `confirm_link` go back as they are.
    if result["status"] != "approved" {
        return Json(result).into_response();
    }
    let user_id = result["userId"].as_str().unwrap_or_default();
    let client = result["client"].as_str().unwrap_or("web");
    let ttl_days = session_days(client);
    // A native client that can ask for the code itself (`"mfa": "code"`, the
    // Android app since 1.0.7) gets the PENDING session and posts the code to
    // `/api/auth/mfa/verify` with it as a bearer — exactly what the web poll
    // does with a pending cookie. The pending session opens nothing else and
    // lapses in `mfa::PENDING_TTL_MS`. An older app has no code screen: refuse
    // in words rather than hand out a session that opens nothing. A person
    // who owes a code but has no authenticator (an admin held to
    // `CC_REMOTE_ADMIN_MFA`) cannot verify anywhere: same refusal.
    let asks_code = client == "native" && body.get("mfa").and_then(Value::as_str) == Some("code");
    if client == "native" && st.workspaces.mfa_required(user_id) {
        let enrolled = st
            .workspaces
            .with_conn_mfa(|c| crate::user_totp::is_enrolled(c, user_id))
            .unwrap_or(false);
        if !(asks_code && enrolled) {
            return crate::mfa_browser_required();
        }
    }
    let session = match st
        .workspaces
        .mint_telegram_session(token, user_id, ttl_days)
    {
        Ok(v) => v,
        // Its Telegram was unlinked or moved since the press: no session.
        Err(e) if e == "identity_moved" => {
            return Json(json!({"status": "denied"})).into_response()
        }
        Err(e) => {
            // Hand the approval back so the next poll can take it again: a
            // login confirmed in Telegram must not be lost to a busy disk.
            let _ = st.workspaces.unpick_telegram_login(token);
            return store_failure(e);
        }
    };
    // Close the check-then-mint gap: what was really minted decides.
    let pending = client == "native"
        && matches!(st.workspaces.authenticate_pending(&session), Ok(Some(m)) if m.pending);
    let enrolled = pending
        && st
            .workspaces
            .with_conn_mfa(|c| crate::user_totp::is_enrolled(c, user_id))
            .unwrap_or(false);
    if pending && !(asks_code && enrolled) {
        st.workspaces.drop_session(&session);
        return crate::mfa_browser_required();
    }
    println!("[tg-login] signed in {user_id} ({client})");
    // Who signed in, so the client can say «Вы вошли как @x (Имя)» with a
    // way out — the last line against a code seen on a shared screen.
    let mut out = json!({
        // `mfa`: the session is pending; the app asks for the code and sends
        // it to `/api/auth/mfa/verify` before using it.
        "status": if pending { "mfa" } else { "approved" },
        "userId": user_id,
        "created": result["created"],
        "telegram": result["telegram"],
        "account": result["account"],
    });
    if client == "native" {
        // The app has no cookie jar on this origin; it stores the session in
        // the Keychain like the one `ccremote://auth?session=` hands it.
        out["session"] = json!(session);
        return Json(out).into_response();
    }
    let mut response = Json(out).into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        set_cookie_header(
            AUTH_COOKIE,
            &session,
            ttl_days * 24 * 60 * 60,
            st.public_url.starts_with("https://"),
        ),
    );
    response
}

/// Stable store error codes -> status. The bot and the clients turn the code
/// into words.
#[track_caller]
fn login_error(code: String) -> Response {
    let status = match code.as_str() {
        "unknown" => StatusCode::NOT_FOUND,
        "expired" => StatusCode::GONE,
        "decided"
        | "claimed_by_other"
        | "not_peeked"
        | "wrong_match"
        | "not_a_link"
        | "not_approved"
        | "identity_owner_has_data"
        | "account_deleting"
        | "locked" => StatusCode::CONFLICT,
        _ => return store_failure(code),
    };
    refusal(status, code)
}

/// What the hub is told after an undo, IN THIS ORDER: close the sockets of the
/// deleted sessions first (`RefreshWorkspaceState`), then drop the
/// notification registrations, then sweep service passes. Cleaning before
/// closing would let a stolen socket that is still open register a push token
/// in between.
fn undo_hub_commands(outcome: &crate::telegram_login::UndoOutcome) -> Vec<HubCmd> {
    vec![
        HubCmd::RefreshWorkspaceState,
        HubCmd::UndoSignIn {
            user_id: outcome.user_id.clone(),
            since_ms: outcome.since_ms,
            live_tokens: outcome.live_tokens.clone(),
        },
        HubCmd::SweepUiPasses,
    ]
}

pub(crate) async fn api_tg_login_confirm(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let Some(cfg) = st.tg_login.clone() else {
        return not_configured();
    };
    match bearer_token(&headers) {
        Some(token) if ct_eq(token.as_bytes(), cfg.secret.as_bytes()) => {}
        _ => return api_error(StatusCode::UNAUTHORIZED, "unauthorized"),
    }
    // Not about one login: the sign-ins the bot should announce.
    if body.get("action").and_then(Value::as_str) == Some("notices") {
        return match st.workspaces.telegram_login_notices(20) {
            Ok(list) => Json(json!({"notices": list})).into_response(),
            Err(e) => store_failure(e),
        };
    }
    if body.get("action").and_then(Value::as_str) == Some("ack") {
        let refs: Vec<String> = body
            .get("refs")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .filter(|r| r.len() == 32 && r.chars().all(|c| c.is_ascii_hexdigit()))
                    .map(str::to_string)
                    .take(50)
                    .collect()
            })
            .unwrap_or_default();
        return match st.workspaces.telegram_login_notices_ack(&refs) {
            Ok(()) => Json(json!({"ok": true})).into_response(),
            Err(e) => store_failure(e),
        };
    }
    let is_revoke = body.get("action").and_then(Value::as_str) == Some("revoke");
    let code = if is_revoke {
        body.get("ref").and_then(Value::as_str).unwrap_or("")
    } else {
        body.get("code").and_then(Value::as_str).unwrap_or("")
    };
    if code.len() != 32 || !code.chars().all(|c| c.is_ascii_hexdigit()) {
        return api_error(StatusCode::BAD_REQUEST, "bad code");
    }
    let tg = &body["telegram"];
    let Some(id) = tg.get("id").and_then(Value::as_i64).filter(|id| *id > 0) else {
        return api_error(StatusCode::BAD_REQUEST, "telegram.id required");
    };
    let who = TgUser::new(
        id,
        tg.get("username").and_then(Value::as_str),
        tg.get("firstName").and_then(Value::as_str),
        tg.get("lastName").and_then(Value::as_str),
    );
    let result = match body.get("action").and_then(Value::as_str) {
        Some("peek") => st.workspaces.peek_telegram_login(code, &who),
        Some("choose") => {
            let Some(choice) = body.get("choice").and_then(Value::as_str) else {
                return api_error(StatusCode::BAD_REQUEST, "choice required");
            };
            st.workspaces
                .decide_telegram_login(code, &who, &Press::Number(choice.to_string()))
        }
        Some("deny") => st
            .workspaces
            .decide_telegram_login(code, &who, &Press::NotMe),
        Some("revoke") => {
            let ended = st.workspaces.revoke_telegram_login_session(code, &who);
            if let Ok(outcome) = &ended {
                if outcome.fresh {
                    println!("[tg-login] telegram {id} undid the sign-in it did not make");
                    for cmd in undo_hub_commands(outcome) {
                        st.hub.send(cmd);
                    }
                }
            }
            ended.map(|o| o.body)
        }
        _ => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "action must be peek, choose, deny, notices, ack or revoke",
            )
        }
    };
    match result {
        Ok(v) => {
            if v["status"] == "approved" {
                println!(
                    "[tg-login] telegram {id} approved {} -> {} (created={})",
                    v["intent"].as_str().unwrap_or("?"),
                    v["account"]["userId"].as_str().unwrap_or("(link proposal)"),
                    v["created"]
                );
            }
            Json(v).into_response()
        }
        Err(code) => {
            if code == "wrong_match" {
                println!("[tg-login] telegram {id} pressed the wrong number — login killed");
            }
            login_error(code)
        }
    }
}

/// «Да, это мой @username». The account that started the link, and only it,
/// makes the link after seeing which Telegram account pressed.
pub(crate) async fn api_tg_login_link(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if st.tg_login.is_none() {
        return not_configured();
    }
    let actor = gate!(mutation_user(&headers, &st));
    gate!(require_active(&st, &actor));
    let token = body.get("pollToken").and_then(Value::as_str).unwrap_or("");
    if token.is_empty() {
        return api_error(StatusCode::BAD_REQUEST, "pollToken required");
    }
    match st.workspaces.finish_telegram_link(token, &actor) {
        Ok(v) => {
            println!(
                "[tg-login] {actor} linked Telegram {}{}",
                v["telegram"].as_str().unwrap_or("?"),
                v["movedFrom"]
                    .as_str()
                    .map(|f| format!(" (moved from {f})"))
                    .unwrap_or_default()
            );
            st.hub.send(HubCmd::RefreshWorkspaceState);
            Json(v).into_response()
        }
        Err(code) => login_error(code),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_undo_closes_sockets_before_it_cleans_registrations() {
        let outcome = crate::telegram_login::UndoOutcome {
            body: json!({}),
            user_id: "u".into(),
            since_ms: 1,
            live_tokens: vec![],
            fresh: true,
        };
        let cmds = undo_hub_commands(&outcome);
        assert!(matches!(cmds[0], HubCmd::RefreshWorkspaceState));
        assert!(matches!(cmds[1], HubCmd::UndoSignIn { .. }));
        assert!(matches!(cmds[2], HubCmd::SweepUiPasses));
    }

    #[test]
    fn the_bot_secret_is_its_own_class() {
        let long = "x".repeat(40);
        assert!(load_tg_login_config(None, None, &[]).is_none());
        assert!(load_tg_login_config(Some("short"), None, &[]).is_none());
        assert!(
            load_tg_login_config(Some(&long), None, &[Some(long.as_str())]).is_none(),
            "never the same string as another hub secret"
        );
        let cfg = load_tg_login_config(Some(&long), Some("@SomeBot"), &[Some("other")]).unwrap();
        assert_eq!(cfg.bot, "SomeBot");
        let default = load_tg_login_config(Some(&long), Some("bad bot!"), &[]).unwrap();
        assert_eq!(default.bot, "Hegaicodebot");
    }

    #[test]
    fn the_device_label_is_never_text_the_client_chose() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::USER_AGENT,
            HeaderValue::from_static("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"),
        );
        assert_eq!(device_label(&headers, &json!({})), "Chrome · macOS");
        assert_eq!(
            device_label(&headers, &json!({"device": "iPhone"})),
            "iPhone"
        );
        assert_eq!(
            device_label(
                &headers,
                &json!({"device": "iPhone · проверка безопасности"})
            ),
            "Chrome · macOS",
            "anything off the list falls back to the User-Agent"
        );
        assert_eq!(device_label(&HeaderMap::new(), &json!({})), "браузер");
    }
}
