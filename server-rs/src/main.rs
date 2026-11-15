//! cc-remote central service (Rust / axum) — drop-in replacement for the Node
//! Fastify hub. Speaks the exact same JSON wire protocol, so the Node agents
//! and the React web app connect unchanged.

/// Take a gate's `Ok`, or answer its refusal from the handler. The one-line
/// form of `match gate { Ok(v) => v, Err(response) => return response }` that
/// every HTTP handler opens with (`authenticated_user`, `mutation_user`,
/// `admin_mutation_user`, `require_active`). Declared before the modules so
/// they all see it.
macro_rules! gate {
    ($gate:expr) => {
        match $gate {
            Ok(value) => value,
            Err(response) => return response,
        }
    };
}

mod access;
mod access_api;
mod access_registration;
mod account;
mod account_deletion;
mod account_deletion_api;
mod agent_release;
mod android_auth;
mod apple_auth;
mod avatar;
mod board;
mod board_api;
mod browser;
#[cfg(test)]
mod cookie_tests;
mod edition;
mod fcm;
mod fleet_api;
mod github_grant;
mod github_login;
mod google_login;
mod host_enroll;
mod hub;
mod identity;
mod images;
mod live_activity;
mod llm_api;
mod llm_usage;
mod llmgw;
mod local_login;
mod mfa;
#[cfg(test)]
mod mfa_tests;
mod notify;
mod oidc_login;
mod polish;
mod privacy_guard;
mod provisioning;
mod provisioning_api;
mod public_config;
mod push_action;
mod push_payload;
mod push_relay;
mod rate_window;
mod release_signing;
mod replica;
mod reports;
mod review_login;
mod roadmap;
mod runtime_alert;
mod selfhost;
mod service_api;
#[cfg(test)]
mod service_api_tests;
mod session_reads;
#[cfg(test)]
mod share_acl_tests;
mod support_access;
mod support_api;
mod tasks;
mod telegram_login;
mod telegram_login_api;
mod timefmt;
mod totp;
mod transcribe_api;
mod user_totp;
mod watch_api;
mod watch_history;
mod workspace;
mod workspace_api;
mod ws_api;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::{
    body::{Body, Bytes},
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Path as AxumPath, Query, Request, State,
    },
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc::channel, Semaphore};
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

use access_api::*;
use board_api::*;
use hub::{spawn_hub, HubCmd, HubHandle};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
#[cfg(test)]
use jsonwebtoken::{encode, EncodingKey, Header};
use llm_api::*;
use provisioning_api::*;
use serde::Deserialize;
use serde_json::{json, Value};
use transcribe_api::*;
use uuid::Uuid;
use watch_api::*;
use workspace::{now_ms, DeviceCredential, WorkspaceStore};
use workspace_api::*;
use ws_api::*;

#[derive(Clone)]
struct AppState {
    hub: HubHandle,
    token: String,
    /// `CC_REMOTE_FLEET_UI=1`: let the fleet token open `/ui` as the bootstrap
    /// owner even on a production hub. Off by default — see `ui_user`.
    fleet_ui: bool,
    /// Pending native SSO handshakes: `state` -> when it was issued.
    /// `ASWebAuthenticationSession` keeps its own cookie jar, so the browser
    /// flow's state cookie cannot be relied on; the hub remembers the state
    /// itself and expires it after ten minutes.
    native_sso_states: Arc<Mutex<HashMap<String, Instant>>>,
    /// Redeemed SSO token ids (`jti`), three minutes. See `SsoJtiCache`.
    sso_jti: Arc<Mutex<SsoJtiCache>>,
    android_auth: Arc<android_auth::AndroidAuth>,
    apple_auth: Option<Arc<apple_auth::AppleAuth>>,
    google_auth: Option<Arc<google_login::GoogleAuth>>,
    /// Sign in with GitHub (`github_login.rs`, `GITHUB_CLIENT_*`).
    github_auth: Option<Arc<github_login::GithubAuth>>,
    /// Read access to the private repository on activation (`github_grant.rs`,
    /// `GITHUB_GRANT_REPO` + `GITHUB_APP_*`). `None` = off.
    github_grant: Option<Arc<github_grant::GrantConfig>>,
    /// Generic OpenID Connect sign-in (`oidc_login.rs`, `OIDC_*`). `None` =>
    /// `/api/auth/oidc/*` answer 404.
    oidc_auth: Option<Arc<oidc_login::OidcAuth>>,
    /// GPU speech-to-text (faster-whisper on buildbox-pc), reached through a
    /// reverse SSH tunnel that terminates on this box. Preferred over Azure
    /// when set; see `transcribe`.
    stt_url: Option<String>,
    stt_token: Option<String>,
    /// Full Azure OpenAI transcription URL (incl. deployment + api-version).
    azure_url: Option<String>,
    azure_key: Option<String>,
    azure_model: String,
    /// Recognition glossary, read once at startup (see `polish::glossary_from_env`).
    transcribe_glossary: Arc<str>,
    /// `TRANSCRIBE_PROMPT=0` turns the recognition prompt off.
    transcribe_prompt_on: bool,
    /// `TRANSCRIBE_PRIMARY=cloud` (or `azure`) tries the cloud before the GPU.
    transcribe_primary_azure: bool,
    /// Last word from the GPU box's `/health` (`watch_stt_health`).
    stt_health: Arc<SttHealth>,
    /// Bounds simultaneous paid transcription calls.
    transcribe_limit: Arc<Semaphore>,
    /// Shared async client for Azure transcription proxy calls.
    azure_http: reqwest::Client,
    /// Dictation clean-up through the LLM gateway (`polish.rs`). `None` →
    /// `/polish` answers 503 and the web inserts what whisper wrote.
    polisher: Option<Arc<polish::Polisher>>,
    /// The login bot's token, for profile photos only (`avatar.rs`). `None`
    /// → `/api/avatar/*` is always 404 and the web draws initials.
    avatar_bot_token: Option<String>,
    /// Loopback-only LLM gateway (Bifrost) governance client. The admin API has
    /// no authentication of its own and is bound to 127.0.0.1, so this hub is
    /// the only thing that may talk to it: it reads back a caller's *own* seat
    /// and creates community seats on activation (`llmgw.rs`). `None` (no
    /// `LLM_GATEWAY_URL`) => `/api/llm-access` reports "not configured" and
    /// seats are marked ready without a gateway so a dev hub still flows.
    llmgw: Option<Arc<llmgw::LlmGateway>>,
    /// Public base URL clients point their agent at (the inference endpoint).
    llm_public_url: String,
    /// The sandbox provisioner's credential (`CC_REMOTE_PROVISIONER_TOKEN`),
    /// its own class — never the fleet token. Unset => `/api/provisioning/*`
    /// is 404. See `provisioning_api.rs`.
    provisioner_token: Option<String>,
    sandbox_erasure_only: bool,
    /// What each provisioner host reported on its last claim
    /// (`host -> (capacity, seen_at_ms)`), for the admin hosts view. In memory
    /// on purpose: it is a liveness readout, not a record.
    provision_hosts: Arc<Mutex<HashMap<String, (Value, i64)>>>,
    /// Users whose gateway seat is being made right now, so the activation
    /// hook and the reconciler never run two `ensure_seat` calls for one email.
    seat_inflight: Arc<Mutex<HashSet<String>>>,
    /// Path to the shared-subscription quota snapshot written by the gateway's
    /// quota-probe cron (percentages + reset time, no secrets). Shown as a bar on
    /// the access page so users see how much of the shared Codex plan is left.
    llm_quota_file: Option<String>,
    /// Signing secret for gateway access links (`/access?t=…`). These hand a
    /// person their own gateway key with no login at all, so the link *is* the
    /// credential — deliberately, for members who have no HegAI account. Kept
    /// separate from `sso_secret`: that one is shared with the external IdP, and
    /// a leak there must not also mint access links. Unset => links rejected.
    access_link_secret: Option<String>,
    /// Signing secret for admin sign-in links (`/api/auth/signin-link?t=…`),
    /// which open a browser session AS another account. Root on this box can
    /// already mint any session through `sso_secret`, so this adds no new class
    /// of power — what it adds is a path that is one-shot, expiring and audited
    /// in the target's own trail instead of a silent hand-rolled cookie. Kept
    /// its own secret so a leaked SSO or access-link key does not also open it,
    /// and it never targets a platform admin. Unset => the route is 404.
    signin_link_secret: Option<String>,
    /// Signing in with Telegram (`telegram_login_api.rs`): the bot's own
    /// credential and username. `None` => the three routes answer 404.
    tg_login: Option<telegram_login_api::TgLoginConfig>,
    /// The store-review account (`review_login.rs`): one email + password for
    /// app-store reviewers, `CC_REMOTE_REVIEW_LOGIN`. `None` => the route 404s.
    review_login: Option<review_login::ReviewLoginConfig>,
    workspaces: WorkspaceStore,
    bootstrap_user_id: String,
    platform_admins: HashSet<String>,
    /// Product areas (project → group), the same config the hub loop puts in
    /// the snapshot; the task board groups its cards by it at read time.
    roadmap: roadmap::RoadmapConfig,
    sso_authorize_url: String,
    sso_secret: Option<String>,
    public_url: String,
    /// Extra hostnames whose pages may open `/ui` (`CC_REMOTE_UI_ORIGINS`,
    /// comma-separated) beyond the request's own host and `public_url`.
    ui_origins: Arc<Vec<String>>,
    /// Ports on the public host that also reach the hub — the relay's spare
    /// doors (`:2096`, `:8443`) for people whose middlebox breaks `:443`. A
    /// login started on one of them must return to the SAME port, or the SSO
    /// hop lands the person back on the door that was shut. Empty = only
    /// `public_url` (`CC_REMOTE_PUBLIC_ALT_PORTS`, comma-separated).
    public_alt_ports: Vec<u16>,
    /// Other names this hub answers on with the LIGHT shell (`remote.acme.test`,
    /// `CC_REMOTE_LITE_HOSTS`). One list does two jobs, because a host that is
    /// served a shell and cannot sign in is useless: it picks the bundle
    /// (`StaticSites`) and it is the only set of names besides `public_url`'s a
    /// Google sign-in may return to (`callback_origin`, `google_login::start`).
    lite_hosts: Arc<Vec<String>>,
    /// Where a filed backend spec is allowed to come from and where it lands.
    /// Unset => `/api/backend-requests` is closed. Never taken from the request:
    /// the caller is a sandbox that must not get to name the machine it opens a
    /// session on.
    backend_requests: Option<BackendRequestConfig>,
    /// Filed-spec timestamps per source machine, for the daily cap. In memory on
    /// purpose — a hub restart forgiving the day's count is a better failure than
    /// a schema migration for a runaway-loop guard.
    backend_request_log: Arc<Mutex<HashMap<String, Vec<i64>>>>,
    /// Keys of the fleet API (`fleet_api.rs`). None => its endpoints are 404.
    fleet_api_keys: Option<Arc<fleet_api::FleetApiKeys>>,
    /// Integration keys (`service_api.rs`, `CC_REMOTE_SERVICE_KEYS_FILE`).
    /// None => `/api/service/*` and `/api/auth/service-signin` are 404.
    service_keys: Option<Arc<Vec<service_api::ServiceKey>>>,
    /// The cloud browser (`browser.rs`). None => its endpoints are 404.
    browser: Option<Arc<browser::BrowserConfig>>,
    /// Per-address rolling windows for the open endpoints (`rate_window.rs`):
    /// bounded, swept by each key's own window, separate from the
    /// backend-spec log above so a flood of one cannot starve the other.
    window_log: Arc<Mutex<rate_window::WindowLog>>,
}

/// Intake policy for backend specs filed from a sandbox machine.
#[derive(Clone)]
struct BackendRequestConfig {
    /// Machines whose device token may file. A sandbox is trusted to *ask*, and
    /// nothing more — approval still happens in front of a human.
    source_machines: HashSet<String>,
    /// Machine the session is opened on, and the directory it opens in.
    target_machine: String,
    target_cwd: String,
    /// Specs per source machine per rolling 24h. A looping agent that files the
    /// same spec forever would otherwise open a session for each one.
    daily_limit: usize,
}

#[derive(Debug, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SsoClaims {
    user_id: String,
    email: String,
    full_name: Option<String>,
    exp: usize,
    iss: String,
    aud: String,
    /// Not sent by acme.test today (it mints iat/iss/aud/exp only). When a
    /// token carries one it is single-use here — see `SsoJtiCache`.
    #[serde(default)]
    jti: Option<String>,
}

/// How long a used SSO `jti` is remembered: the token lives 60 s plus the 5 s
/// leeway, so three minutes covers every moment it could still verify.
const SSO_JTI_TTL: Duration = Duration::from_secs(180);
const SSO_JTI_CAP: usize = 10_000;

/// In-memory record of SSO token ids already redeemed. A restart forgets it,
/// which only matters inside the token's own ~65 s lifetime.
#[derive(Default)]
struct SsoJtiCache(HashMap<String, Instant>);

impl SsoJtiCache {
    /// True the first time `jti` is seen inside the window; false on reuse. A
    /// full cache refuses new ids (fail closed) rather than evicting a live one.
    fn first_use(&mut self, jti: &str, now: Instant) -> bool {
        self.0.retain(|_, at| now.duration_since(*at) < SSO_JTI_TTL);
        if self.0.contains_key(jti) || self.0.len() >= SSO_JTI_CAP {
            return false;
        }
        self.0.insert(jti.to_string(), now);
        true
    }
}

/// Claims of a gateway access link. `sub` is the member's email — the only thing
/// the gateway lookup needs. Deliberately has no `exp`: these links are handed
/// out once and must keep working, so revocation is deactivating the virtual key
/// upstream, not waiting for a token to lapse.
#[derive(Debug, Deserialize, serde::Serialize)]
struct AccessLinkClaims {
    sub: String,
    iss: String,
    aud: String,
}

/// Claims of an admin sign-in link. `sub` is the target's email — the same
/// identifier SSO speaks, so minting one needs no database. `by` is a free-text
/// label for whoever asked for the link; it is what the audit row names as the
/// actor, because "someone with the ops secret" is the honest answer and
/// borrowing a real admin's id would put a click in their trail they never made.
#[derive(Debug, Deserialize, serde::Serialize)]
struct SigninLinkClaims {
    sub: String,
    by: String,
    jti: String,
    iss: String,
    aud: String,
    /// Required (pentest 11.11.2026): with `exp` it bounds the link's whole
    /// lifetime, so a mint-side mistake cannot make a year-long credential.
    /// Links minted before this field existed simply stop working.
    iat: usize,
    exp: usize,
}

/// Audience that separates access links from SSO tokens even if the two secrets
/// are ever mistakenly set to the same value.
const ACCESS_LINK_AUDIENCE: &str = "cc-remote-access";
const ACCESS_LINK_ISSUER: &str = "acme.test";
/// Same separation for sign-in links, which are a much bigger deal than an
/// access link: one opens a gateway key, the other opens the account.
const SIGNIN_LINK_AUDIENCE: &str = "cc-remote-signin";
const SIGNIN_LINK_ISSUER: &str = "cc-remote-ops";
/// How long the session a sign-in link mints lasts. Deliberately not the week a
/// browser SSO login gets: this one is for looking around as a member, and the
/// shorter it lives the less there is to inherit if that account's standing ever
/// changes.
const SIGNIN_LINK_SESSION_HOURS: i64 = 12;

const INSTALL_WINDOWS: &str = include_str!("../../deploy/install-win.ps1");
const INSTALL_MACOS: &str = include_str!("../../deploy/install-mac.sh");
const INSTALL_LINUX: &str = include_str!("../../deploy/install-linux.sh");
/// `curl -fsSL https://code.acme.test/go | bash` — the one-command path: picks
/// the installer for the OS and runs it with no credential, so the agent asks
/// for a code the person approves on /link.
const GO_SH: &str = include_str!("../../deploy/go.sh");
const GO_PS1: &str = include_str!("../../deploy/go.ps1");
// The CLIENT APP one-liner (`curl … | bash`), not the machine agent: it pulls
// the hand-uploaded notarized zip from /dl/HegaiCode.zip and installs it into
// «Программы». Companion of the /install/app page.
const INSTALL_APP_MACOS: &str = include_str!("../../deploy/install-app-mac.sh");
// The Mac SHELL — the Tauri build that renders this same SPA instead of a UI of
// its own, so its interface ships with every web deploy. Served beside the
// native installer rather than replacing it: while the shell is proving itself,
// the old one-liner is the way back.
const INSTALL_APP_MACOS_SHELL: &str = include_str!("../../deploy/install-app-mac-shell.sh");
// The Windows counterpart. Pulls the NSIS installer from
// /dl/HegaiCode-win-setup.exe and runs it per-user, no admin — same reasoning
// as install-win.ps1's user-context Scheduled Task.
const INSTALL_APP_WINDOWS: &str = include_str!("../../deploy/install-app-win.ps1");
const INSTALL_PACKAGE: &str = include_str!("../../deploy/package.json");
const INSTALL_AGENT: &[u8] = include_bytes!("../../deploy/agent.mjs");

// Generic (non-personalized) one-line installers, served publicly. The member's
// key is NOT baked in — it is passed as $HEGAI_API_KEY on the paste line, so these
// need no auth and work via `curl … | bash` / `irm … | iex`. base/model are
// templated in at serve time to stay in sync with the gateway config.
const CODEX_GATEWAY_SH: &str = include_str!("../assets/codex-gateway.sh");
const CODEX_GATEWAY_PS1: &str = include_str!("../assets/codex-gateway.ps1");

/// `CC_REMOTE_DB_PATH`, else `cc-remote.sqlite3` beside the binary.
fn db_path_from_env() -> PathBuf {
    std::env::var("CC_REMOTE_DB_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(PathBuf::from))
                .unwrap_or_else(|| PathBuf::from("."))
                .join("cc-remote.sqlite3")
        })
}

#[tokio::main]
async fn main() {
    // `cc-remote-server --review-login-hash <email> <password>`: print the
    // `CC_REMOTE_REVIEW_LOGIN` value and exit (review_login.rs).
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--initialize-privacy-guard") {
        let (Some(db), Some(mark)) = (args.get(2), args.get(3)) else {
            eprintln!("usage: cc-remote-server --initialize-privacy-guard <database> <absolute-watermark-path>");
            std::process::exit(2);
        };
        if !std::path::Path::new(db).is_file() {
            eprintln!("privacy guard bootstrap requires an existing database");
            std::process::exit(2);
        }
        let store = WorkspaceStore::open(std::path::Path::new(db)).expect("open existing database");
        store
            .initialize_privacy_guard(std::path::Path::new(mark))
            .expect("initialize independent privacy watermark");
        println!("privacy watermark initialized");
        return;
    }
    if args.get(1).map(String::as_str) == Some("--review-login-hash") {
        // The password is read from stdin, never argv (shell history, ps on a shared box).
        let Some(email) = args.get(2) else {
            eprintln!("usage: cc-remote-server --review-login-hash <email>   (password on stdin)");
            std::process::exit(2);
        };
        let mut line = String::new();
        let _ = std::io::stdin().read_line(&mut line);
        let password = line.trim_end_matches(['\r', '\n']).to_string();
        if password.chars().count() < 20 {
            eprintln!("password must be at least 20 characters");
            std::process::exit(2);
        }
        let password = &password;
        println!(
            "CC_REMOTE_REVIEW_LOGIN={}",
            review_login::env_value(email, password)
        );
        return;
    }
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(4319);
    // `cc-remote-server setup-link --email <e> [--hours N]`: print a one-time
    // link to set a local password and authenticator (local_login.rs).
    if args.get(1).map(String::as_str) == Some("setup-link") {
        let public_url = std::env::var("CC_REMOTE_PUBLIC_URL")
            .unwrap_or_else(|_| format!("http://127.0.0.1:{port}"));
        std::process::exit(local_login::run_setup_link_cli(
            &args[2..],
            &db_path_from_env(),
            &public_url,
        ));
    }
    // `cc-remote-server mint-tool-session --user <id> --ttl <dur> --note <name>`
    // prints a satisfied session for an internal tool; `mfa-reset --email <e>`
    // deletes a lost authenticator (mfa.rs). Both run on the hub box as root.
    if args.get(1).map(String::as_str) == Some("mint-tool-session") {
        std::process::exit(mfa::run_tool_session_cli(&args[2..], &db_path_from_env()));
    }
    if args.get(1).map(String::as_str) == Some("mfa-enroll-link") {
        let public_url = std::env::var("CC_REMOTE_PUBLIC_URL")
            .unwrap_or_else(|_| format!("http://127.0.0.1:{port}"));
        std::process::exit(mfa::run_enroll_link_cli(
            &args[2..],
            &db_path_from_env(),
            &public_url,
        ));
    }
    if args.get(1).map(String::as_str) == Some("mfa-reset") {
        std::process::exit(mfa::run_mfa_reset_cli(&args[2..], &db_path_from_env()));
    }
    let token = std::env::var("CC_REMOTE_TOKEN").unwrap_or_else(|_| "dev-token".to_string());
    // On the default token every anonymous request is the owner, so a hub
    // nobody configured listens on loopback only; binding it to the world
    // takes an explicit HOST, and `unsafe_public_config` refuses that too.
    let host = std::env::var("HOST").unwrap_or_else(|_| {
        if token == "dev-token" {
            "127.0.0.1".to_string()
        } else {
            "0.0.0.0".to_string()
        }
    });
    let web_dist = std::env::var("WEB_DIST").unwrap_or_else(|_| "web/dist".to_string());
    let web_lite_dist = std::env::var("WEB_LITE_DIST")
        .ok()
        .filter(|s| !s.is_empty());
    let lite_hosts: Arc<Vec<String>> = Arc::new(parse_host_list(
        &std::env::var("CC_REMOTE_LITE_HOSTS").unwrap_or_default(),
    ));
    let stt_url = std::env::var("STT_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches('/').to_string());
    let stt_token = std::env::var("STT_TOKEN").ok().filter(|s| !s.is_empty());
    // The cloud speech-to-text engine (OpenAI-compatible). One namespace,
    // whole: `CLOUD_STT_*` when its URL is set, else the older Azure names —
    // never a cloud URL with an Azure key (that would hand the key to someone else).
    let env = |k: &str| std::env::var(k).ok().filter(|s| !s.is_empty());
    let (azure_url, azure_key, azure_model) = if env("CLOUD_STT_URL").is_some() {
        (
            env("CLOUD_STT_URL"),
            env("CLOUD_STT_KEY"),
            env("CLOUD_STT_MODEL"),
        )
    } else {
        (
            env("AZURE_TRANSCRIBE_URL"),
            env("AZURE_TRANSCRIBE_KEY"),
            env("AZURE_TRANSCRIBE_MODEL"),
        )
    };
    let azure_model = azure_model.unwrap_or_else(|| "gpt-4o-transcribe".to_string());
    let transcribe_concurrency = std::env::var("TRANSCRIBE_CONCURRENCY")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| (1..=16).contains(value))
        .unwrap_or(3);

    // LLM gateway (Bifrost) lives on loopback next to this hub. No
    // LLM_GATEWAY_URL => feature off (dev: seats are marked ready unprovisioned).
    let llmgw = llmgw::LlmGateway::from_env().map(Arc::new);
    // The URL members' tools reach the gateway on. HegAI's own for the internal
    // hub; empty (feature off) for a customer's until they name theirs.
    // An explicitly empty LLM_PUBLIC_URL= switches the installers off, as before.
    let llm_public_url = llmgw::public_url_from_env().unwrap_or_default();
    let provisioner_token = load_provisioner_token(
        std::env::var("CC_REMOTE_PROVISIONER_TOKEN").ok().as_deref(),
        &token,
    );
    let llm_quota_file = std::env::var("LLM_QUOTA_FILE")
        .ok()
        .filter(|s| !s.is_empty());
    // Same ≥32-char floor as the SSO secret: a short HS256 key is brute-forceable,
    // and this one guards a paid subscription with no second factor behind it.
    let access_link_secret = std::env::var("CC_REMOTE_ACCESS_LINK_SECRET")
        .ok()
        .filter(|s| s.len() >= 32);
    // Same floor, and never a value that is already doing another job: reusing
    // the fleet token or the IdP secret here would quietly widen what a leak of
    // either one buys.
    let signin_link_secret = std::env::var("CC_REMOTE_SIGNIN_LINK_SECRET")
        .ok()
        .filter(|s| {
            s.len() >= 32
                && *s != token
                && Some(s) != access_link_secret.as_ref()
                && std::env::var("CC_REMOTE_SSO_SECRET").as_ref() != Ok(s)
        });

    let db_path = db_path_from_env();
    let mut workspaces = WorkspaceStore::open(&db_path).expect("initialize workspace database");
    if let Some(path) = std::env::var_os("CC_REMOTE_PRIVACY_GUARD_PATH") {
        workspaces
            .enable_privacy_guard(PathBuf::from(path))
            .expect("validate database privacy watermark before serving");
    }
    if llmgw.is_some() {
        workspaces.enable_llm_usage();
    }
    let bootstrap_user_id =
        std::env::var("CC_REMOTE_BOOTSTRAP_USER_ID").unwrap_or_else(|_| "legacy-owner".to_string());
    if edition::is_external() {
        agent_release::init(&db_path, &workspaces, &bootstrap_user_id);
    }
    let bootstrap_email = std::env::var("CC_REMOTE_BOOTSTRAP_EMAIL")
        .unwrap_or_else(|_| "owner@localhost".to_string());
    // No name: CC_REMOTE_BOOTSTRAP_USER_ID is a REAL person on any deployment
    // that adopted legacy machines, and this line runs on every start. Passing a
    // placeholder here renamed that person to "Legacy owner" at every restart,
    // clobbering whatever SSO had written at their last login. ensure_user now
    // coalesces, so None means "I don't know the name", which is the truth.
    workspaces
        .ensure_user_vouched(&bootstrap_user_id, &bootstrap_email, None, true)
        .expect("bootstrap user");
    if edition::is_external() {
        host_enroll::seed_from_env(&workspaces, &bootstrap_user_id);
    }
    let adopted = workspaces
        .adopt_legacy_machines(&bootstrap_user_id)
        .expect("adopt legacy machines");
    let platform_admins: HashSet<String> = std::env::var("CC_REMOTE_PLATFORM_ADMIN_IDS")
        .unwrap_or_else(|_| bootstrap_user_id.clone())
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    // The owner and the admins are active employees whatever their access row
    // says — they are the ones opening the waves.
    workspaces.set_always_active(
        platform_admins
            .iter()
            .cloned()
            .chain(std::iter::once(bootstrap_user_id.clone())),
    );
    // Platform admins hold a second factor at sign-in once the hub says so
    // (CC_REMOTE_ADMIN_MFA=required, set on prod after the admins enrolled).
    // Anyone with a confirmed authenticator is asked for it regardless.
    workspaces.set_admin_mfa(platform_admins.iter().cloned(), mfa::admin_mfa_from_env());
    let demoted = workspaces.demote_stale_admin_sessions();
    if demoted > 0 {
        println!("[mfa] {demoted} admin session(s) older than their authenticator now owe a code");
    }
    let fleet_ui = std::env::var("CC_REMOTE_FLEET_UI").as_deref() == Ok("1");
    if let Ok(ids) = std::env::var("CC_REMOTE_FLEET_MACHINE_IDS") {
        println!(
            "[hub] fleet token limited to {} machine id(s)",
            ids.split(',').filter(|s| !s.trim().is_empty()).count()
        );
    }
    let public_url = std::env::var("CC_REMOTE_PUBLIC_URL")
        .unwrap_or_else(|_| format!("http://127.0.0.1:{port}"));
    HTTPS_HUB.store(
        public_url.starts_with("https://"),
        std::sync::atomic::Ordering::Relaxed,
    );
    if let Some(reason) = unsafe_public_config(&token, &public_url, &host) {
        eprintln!("[hub] refusing to start: {reason}");
        std::process::exit(2);
    }
    if let Some(reason) = selfhost::weak_external_token(&token, edition::is_external()) {
        eprintln!("[hub] refusing to start: {reason}");
        std::process::exit(2);
    }
    let trusted_proxies = selfhost::trusted_proxies();
    if trusted_proxies.len() > 0 {
        println!(
            "[hub] X-Real-IP is believed from loopback and {} configured proxy range(s)",
            trusted_proxies.len()
        );
    }
    // The customer's hub starts with nobody but its owner: the owner gets a
    // one-hour link in the log to set a password and an authenticator, at every
    // start, until they have both. Needed even with OIDC configured: an OIDC /
    // Google sign-in never takes over the owner's account by address, and the
    // authenticator is what approves agent updates.
    if edition::is_external() {
        local_login::announce_owner_setup(
            &workspaces,
            &bootstrap_user_id,
            &bootstrap_email,
            &public_url,
        );
    }
    let public_alt_ports: Vec<u16> = std::env::var("CC_REMOTE_PUBLIC_ALT_PORTS")
        .ok()
        .map(|v| v.split(',').filter_map(|p| p.trim().parse().ok()).collect())
        .unwrap_or_default();
    if !public_alt_ports.is_empty() {
        println!("[hub] sign-in also returns to alternate ports {public_alt_ports:?}");
    }
    let sso_authorize_url = std::env::var("HEGAI_SSO_AUTHORIZE_URL").unwrap_or_else(|_| {
        edition::hegai_default("https://admin.acme.test/api/community/auth/sso/authorize")
    });
    let sso_secret = std::env::var("CC_REMOTE_SSO_SECRET")
        .ok()
        .filter(|s| s.len() >= 32);
    let azure_http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .expect("build Azure HTTP client");
    let backend_requests = load_backend_request_config();
    if let Some(cfg) = &backend_requests {
        println!(
            "[hub] backend-spec intake: {} source machine(s) -> {} in {} (max {}/day)",
            cfg.source_machines.len(),
            cfg.target_machine,
            cfg.target_cwd,
            cfg.daily_limit
        );
    }

    // Telegram sign-in: its own secret, never one already doing another job.
    let tg_login = telegram_login_api::load_tg_login_config(
        std::env::var("CC_REMOTE_TG_LOGIN_SECRET").ok().as_deref(),
        std::env::var("CC_REMOTE_TG_LOGIN_BOT").ok().as_deref(),
        &[
            Some(token.as_str()),
            std::env::var("CC_REMOTE_SSO_SECRET").ok().as_deref(),
            signin_link_secret.as_deref(),
            access_link_secret.as_deref(),
            provisioner_token.as_deref(),
        ],
    );
    if let Some(cfg) = &tg_login {
        println!("[tg-login] Telegram sign-in enabled via @{}", cfg.bot);
    }
    let review_login = review_login::load_review_login_config(
        std::env::var("CC_REMOTE_REVIEW_LOGIN").ok().as_deref(),
    );
    if let Some(cfg) = &review_login {
        println!(
            "[review-login] store review sign-in enabled for {}",
            cfg.email
        );
    }
    let roadmap = roadmap::load_roadmap_config();
    let browser = browser::load_config(&platform_admins, &bootstrap_user_id);
    // Action tokens (docs/WATCH.md §2): the same floor as the other link
    // secrets, and never a value that already does another job.
    let action_secret_raw = std::env::var("CC_REMOTE_ACTION_TOKEN_SECRET").ok();
    let action_secret = push_action::valid_secret(
        action_secret_raw.as_deref(),
        &[
            Some(token.as_str()),
            std::env::var("CC_REMOTE_SSO_SECRET").ok().as_deref(),
            std::env::var("CC_REMOTE_TG_LOGIN_SECRET").ok().as_deref(),
            signin_link_secret.as_deref(),
            access_link_secret.as_deref(),
            provisioner_token.as_deref(),
        ],
    );
    if action_secret_raw.is_some() && action_secret.is_none() {
        eprintln!("[push-action] CC_REMOTE_ACTION_TOKEN_SECRET ignored: shorter than 32 bytes or equal to another secret");
    }
    push_action::init(push_action::WatchConfig {
        secret: action_secret,
        admins: platform_admins.clone(),
    });
    let state = AppState {
        hub: spawn_hub(
            &db_path,
            workspaces.clone(),
            bootstrap_user_id.clone(),
            roadmap.clone(),
        ),
        token: token.clone(),
        fleet_ui,
        native_sso_states: Arc::new(Mutex::new(HashMap::new())),
        sso_jti: Arc::new(Mutex::new(SsoJtiCache::default())),
        android_auth: Arc::new(android_auth::AndroidAuth::default()),
        apple_auth: apple_auth::AppleAuth::from_env().expect("Apple sign-in configuration"),
        google_auth: google_login::GoogleAuth::from_env().expect("Google sign-in configuration"),
        github_auth: github_login::GithubAuth::from_env().expect("GitHub sign-in configuration"),
        github_grant: github_grant::GrantConfig::from_env()
            .expect("GitHub repository grant configuration"),
        oidc_auth: oidc_login::OidcAuth::from_env().expect("OIDC sign-in configuration"),
        stt_url,
        stt_token,
        azure_url,
        azure_key,
        azure_model,
        transcribe_glossary: Arc::from(polish::glossary_from_env()),
        transcribe_prompt_on: std::env::var("TRANSCRIBE_PROMPT").ok().as_deref() != Some("0"),
        transcribe_primary_azure: std::env::var("TRANSCRIBE_PRIMARY").ok().is_some_and(|v| {
            let v = v.trim();
            v.eq_ignore_ascii_case("azure") || v.eq_ignore_ascii_case("cloud")
        }),
        stt_health: Arc::new(SttHealth::default()),
        transcribe_limit: Arc::new(Semaphore::new(transcribe_concurrency)),
        azure_http,
        polisher: polish::Polisher::from_env().map(Arc::new),
        avatar_bot_token: std::env::var("CC_REMOTE_AVATAR_BOT_TOKEN")
            .ok()
            .filter(|t| !t.trim().is_empty()),
        llmgw,
        llm_public_url,
        provisioner_token,
        sandbox_erasure_only: std::env::var("CC_REMOTE_SANDBOX_ERASURE_ONLY")
            .ok()
            .as_deref()
            == Some("1"),
        provision_hosts: Arc::new(Mutex::new(HashMap::new())),
        seat_inflight: Arc::new(Mutex::new(HashSet::new())),
        llm_quota_file,
        access_link_secret,
        signin_link_secret,
        tg_login,
        review_login,
        workspaces,
        bootstrap_user_id,
        platform_admins,
        roadmap,
        sso_authorize_url,
        sso_secret,
        public_url,
        ui_origins: Arc::new(
            std::env::var("CC_REMOTE_UI_ORIGINS")
                .unwrap_or_default()
                .split(',')
                .filter_map(origin_host)
                .collect(),
        ),
        public_alt_ports,
        lite_hosts: lite_hosts.clone(),
        backend_requests,
        backend_request_log: Arc::new(Mutex::new(HashMap::new())),
        fleet_api_keys: fleet_api::load_fleet_api_keys(),
        service_keys: service_api::load_service_keys(),
        browser,
        window_log: Arc::new(Mutex::new(rate_window::WindowLog::default())),
    };
    let transcribe_ready =
        state.stt_url.is_some() || (state.azure_url.is_some() && state.azure_key.is_some());
    let cloud_ok = state.azure_url.is_some() && state.azure_key.is_some();
    let transcribe_backend = if state.stt_url.is_some() && cloud_ok {
        "GPU (buildbox-pc) raced by cloud"
    } else if state.stt_url.is_some() {
        "GPU (buildbox-pc, faster-whisper)"
    } else if state.azure_url.is_some() {
        "cloud"
    } else {
        "none"
    };

    // Which built shell a request gets is decided by its `Host` — see
    // `StaticSites`. `/assets` is part of each site, not a route of its own.
    let sites = StaticSites {
        full: static_site(&web_dist),
        lite: web_lite_dist.as_deref().map(static_site),
        lite_hosts: lite_hosts.clone(),
    };
    let app = Router::new()
        .route("/api/auth/sso/start", get(sso_start))
        .route(
            "/api/auth/android/exchange",
            post(android_exchange).layer(DefaultBodyLimit::max(4096)),
        )
        .route("/api/auth/sso/callback", get(sso_callback))
        .route("/api/auth/google/start", get(google_login::start))
        .route("/api/auth/google/callback", get(google_login::callback))
        .route("/api/auth/github/start", get(github_login::start))
        .route("/api/auth/github/callback", get(github_login::callback))
        .route(
            "/api/auth/google/link",
            post(google_login::link_ticket).layer(DefaultBodyLimit::max(4096)),
        )
        .route(
            "/api/auth/google/link/confirm",
            post(google_login::link_confirm).layer(DefaultBodyLimit::max(4096)),
        )
        .route("/api/auth/oidc/start", get(oidc_login::start))
        .route("/api/auth/oidc/callback", get(oidc_login::callback))
        .route("/api/public-config", get(public_config::api_public_config))
        .route(
            "/api/auth/local/setup/begin",
            post(local_login::api_setup_begin).layer(DefaultBodyLimit::max(4096)),
        )
        .route(
            "/api/auth/local/setup/finish",
            post(local_login::api_setup_finish).layer(DefaultBodyLimit::max(4096)),
        )
        .route(
            "/api/auth/totp/begin",
            post(local_login::api_totp_begin).layer(DefaultBodyLimit::max(1024)),
        )
        .route(
            "/api/auth/totp/confirm",
            post(local_login::api_totp_confirm).layer(DefaultBodyLimit::max(4096)),
        )
        .route(
            "/api/auth/local/login",
            post(local_login::api_login).layer(DefaultBodyLimit::max(4096)),
        )
        .route(
            "/api/auth/local/native-handoff",
            post(local_login::api_native_handoff).layer(DefaultBodyLimit::max(4096)),
        )
        .route(
            "/api/admin/local-users",
            post(local_login::api_admin_create).layer(DefaultBodyLimit::max(4096)),
        )
        .route(
            "/api/admin/local-users/{user_id}/reset",
            post(local_login::api_admin_reset),
        )
        .route("/api/auth/signin-link", get(auth_signin_link))
        .route(
            "/api/privacy",
            get(|| async {
                if edition::is_external() {
                    return selfhost::external_legal_page("privacy");
                }
                axum::response::Html(include_str!("../../web/public/privacy/index.html"))
                    .into_response()
            }),
        )
        .route(
            "/api/support",
            get(|| async {
                if edition::is_external() {
                    return selfhost::external_legal_page("support");
                }
                axum::response::Html(include_str!("../assets/support.html")).into_response()
            }),
        )
        .route("/api/auth/apple/start", post(apple_auth::start))
        .route("/api/auth/apple/exchange", post(apple_auth::exchange))
        .route(
            "/api/auth/telegram/start",
            post(telegram_login_api::api_tg_login_start).layer(DefaultBodyLimit::max(4096)),
        )
        .route(
            "/api/auth/telegram/poll",
            post(telegram_login_api::api_tg_login_poll).layer(DefaultBodyLimit::max(4096)),
        )
        .route(
            "/api/auth/telegram/confirm",
            post(telegram_login_api::api_tg_login_confirm).layer(DefaultBodyLimit::max(4096)),
        )
        .route(
            "/api/auth/telegram/link",
            post(telegram_login_api::api_tg_login_link).layer(DefaultBodyLimit::max(4096)),
        )
        .route(
            "/api/account/deletion",
            get(account_deletion_api::preview).post(account_deletion_api::request),
        )
        .route(
            "/api/account/deletion/status",
            post(account_deletion_api::status),
        )
        .route(
            "/api/auth/review-login",
            post(review_login::api_review_login).layer(DefaultBodyLimit::max(4096)),
        )
        .route("/api/me", get(api_me))
        .route("/api/auth/mfa/state", get(mfa::api_mfa_state))
        .route(
            "/api/auth/mfa/enroll-link/open",
            post(mfa::api_enroll_link_open).layer(DefaultBodyLimit::max(1024)),
        )
        .route(
            "/api/auth/mfa/verify",
            post(mfa::api_mfa_verify).layer(DefaultBodyLimit::max(1024)),
        )
        .route(
            "/api/auth/totp/disable",
            post(mfa::api_totp_disable).layer(DefaultBodyLimit::max(1024)),
        )
        .route(
            "/api/auth/totp/recovery",
            post(mfa::api_totp_recovery).layer(DefaultBodyLimit::max(1024)),
        )
        .route("/api/me/identities", get(api_my_identities))
        .route(
            "/api/me/identities/unlink",
            post(api_unlink_identity).layer(DefaultBodyLimit::max(4096)),
        )
        .route("/api/avatar/{user_id}", get(avatar::api_avatar))
        .route("/api/logout", post(api_logout))
        .route("/api/auth/sessions", get(api_sessions))
        .route("/api/auth/sessions/revoke", post(api_revoke_session))
        .route(
            "/api/auth/sessions/revoke-others",
            post(api_revoke_other_sessions),
        )
        .route(
            "/api/account/delete",
            post(account::api_account_delete).layer(DefaultBodyLimit::max(4096)),
        )
        .route("/api/admin/workspaces", post(api_create_workspace))
        .route(
            "/api/admin/agent-release",
            get(agent_release::api_admin_agent_release),
        )
        .route(
            "/api/admin/agent-release/approve",
            post(agent_release::api_admin_agent_release_approve).layer(DefaultBodyLimit::max(4096)),
        )
        .route(
            "/api/admin/agent-release/rollback",
            post(agent_release::api_admin_agent_release_rollback)
                .layer(DefaultBodyLimit::max(4096)),
        )
        .route(
            "/api/release-signing/pending",
            get(release_signing::api_pending),
        )
        .route(
            "/api/release-signing/signature",
            post(release_signing::api_signature).layer(DefaultBodyLimit::max(4096)),
        )
        .route(
            "/api/push-relay/register/start",
            post(push_relay::api_register_start).layer(DefaultBodyLimit::max(1024)),
        )
        .route(
            "/api/push-relay/register/finish",
            post(push_relay::api_register_finish).layer(DefaultBodyLimit::max(1024)),
        )
        .route(
            "/.well-known/hegai-push-relay",
            get(push_relay::api_well_known),
        )
        .route(
            "/api/push-relay/send",
            post(push_relay::api_send).layer(DefaultBodyLimit::max(8192)),
        )
        .route("/api/admin/access", get(api_admin_access))
        .route("/api/admin/access/activate", post(api_admin_activate))
        .route("/api/admin/access/grant", post(api_admin_grant))
        .route("/api/admin/access/revoke", post(api_admin_revoke))
        .route("/api/admin/access/suspend", post(api_admin_suspend))
        .route("/api/admin/access/reactivate", post(api_admin_reactivate))
        .route(
            "/api/admin/access/{user_id}/verify-seat",
            post(api_admin_verify_seat),
        )
        .route(
            "/api/admin/access/{user_id}/retry-seat",
            post(api_admin_retry_seat),
        )
        .route(
            "/api/admin/access/{user_id}/retry-github-grant",
            post(github_grant::api_admin_retry_github_grant),
        )
        .route(
            "/api/admin/access/{user_id}/sandbox/{kind}",
            post(api_admin_sandbox_enqueue),
        )
        .route(
            "/api/admin/provisioning/jobs",
            get(api_admin_provision_jobs),
        )
        .route(
            "/api/admin/provisioning/jobs/{job_id}/retry",
            post(api_admin_provision_retry),
        )
        .route(
            "/api/admin/provisioning/hosts",
            get(api_admin_provision_hosts),
        )
        .route("/api/provisioning/jobs/claim", post(api_provision_claim))
        .route(
            "/api/provisioning/jobs/{job_id}/heartbeat",
            post(api_provision_heartbeat),
        )
        .route(
            "/api/provisioning/jobs/{job_id}/result",
            post(api_provision_result),
        )
        .route("/api/access/request", post(api_access_request))
        .route(
            "/api/access/registration",
            post(access_registration::api_access_registration)
                .layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route("/api/budget", get(api_budget))
        .route("/api/workspaces", post(api_create_workspace_self))
        .route(
            "/api/workspaces/{workspace_id}",
            delete(api_delete_workspace),
        )
        .route(
            "/api/workspaces/{workspace_id}/transfer",
            post(api_transfer_workspace),
        )
        .route("/api/workspaces/{workspace_id}/members", get(api_members))
        .route(
            "/api/workspaces/{workspace_id}/invitations",
            post(api_invite),
        )
        .route("/api/invitations/accept", post(api_accept_invitation))
        .route(
            "/api/invitations/preview",
            post(api_invitation_preview).layer(DefaultBodyLimit::max(2048)),
        )
        .route(
            "/api/workspaces/{workspace_id}/members/{user_id}",
            patch(api_set_role).delete(api_remove_member),
        )
        .route(
            "/api/workspaces/{workspace_id}/assignments",
            post(api_assign_manager),
        )
        .route(
            "/api/workspaces/{workspace_id}/projects",
            get(api_projects).post(api_share_project),
        )
        .route(
            "/api/workspaces/{workspace_id}/projects/{share_id}",
            delete(api_remove_project),
        )
        .route("/api/workspaces/{workspace_id}/audit", get(api_audit))
        .route(
            "/api/workspaces/{workspace_id}/usage",
            get(api_workspace_usage),
        )
        .route("/api/me/usage", get(api_me_usage))
        // Support access on request: the owner opens it for N hours, the link
        // signs a dedicated account in, every action lands in the owner's log.
        .route(
            "/api/workspaces/{workspace_id}/support-grants",
            get(support_api::api_support_grants)
                .post(support_api::api_support_grant_create)
                .layer(DefaultBodyLimit::max(4096)),
        )
        .route(
            "/api/workspaces/{workspace_id}/support-grants/{grant_id}/revoke",
            post(support_api::api_support_grant_revoke),
        )
        .route(
            "/api/workspaces/{workspace_id}/support-grants/{grant_id}/log",
            get(support_api::api_support_grant_log),
        )
        .route(
            "/api/auth/support-login",
            post(support_api::api_support_login).layer(DefaultBodyLimit::max(4096)),
        )
        // The task board («Доска»): cards assembled from sessions, and a hand edit.
        .route("/api/board", get(api_board))
        .route("/api/board/cards/{card_id}", post(api_board_patch_card))
        .route(
            "/api/push-action",
            post(api_push_action).layer(DefaultBodyLimit::max(16 * 1024)),
        )
        .route("/api/watch/inbox", get(api_watch_inbox))
        .route("/api/watch/history", get(api_watch_history))
        .route(
            "/api/watch/session",
            post(watch_api::api_watch_session).layer(DefaultBodyLimit::max(1024)),
        )
        .route(
            "/api/push/live-activity",
            post(api_live_activity).layer(DefaultBodyLimit::max(4096)),
        )
        .route(
            "/api/reports",
            get(reports::api_reports)
                .post(reports::api_report_create)
                .layer(DefaultBodyLimit::max(reports::MAX_BODY_BYTES)),
        )
        .route(
            "/api/reports/{report_id}",
            get(reports::api_report_meta)
                .put(reports::api_report_update)
                .patch(reports::api_report_move)
                .delete(reports::api_report_delete)
                .layer(DefaultBodyLimit::max(reports::MAX_BODY_BYTES)),
        )
        .route(
            "/api/reports/{report_id}/content",
            get(reports::api_report_content),
        )
        // The cloud browser (browser.rs): profiles, hands, and the screen.
        .route("/api/browser", get(browser::api_browser))
        .route(
            "/api/browser/profiles",
            get(browser::api_profiles).post(browser::api_profile_create),
        )
        .route(
            "/api/browser/profiles/{profile_id}",
            axum::routing::delete(browser::api_profile_delete),
        )
        .route(
            "/api/browser/profiles/{profile_id}/cmd",
            post(browser::api_profile_cmd).layer(DefaultBodyLimit::max(browser::MAX_CMD_BYTES)),
        )
        .route(
            "/api/browser/profiles/{profile_id}/vnc",
            get(browser::ws_profile_vnc),
        )
        .route(
            "/api/browser/profiles/{profile_id}/{action}",
            post(browser::api_profile_action),
        )
        .route("/api/enrollments", post(api_create_enrollment))
        .route("/api/enrollments/exchange", post(api_exchange_enrollment))
        // The reverse direction: the machine asks, the person approves on /link.
        .route("/api/enrollments/request", post(api_request_enrollment))
        .route(
            "/api/enrollments/request/{code}",
            get(api_enrollment_request_info),
        )
        .route("/api/enrollments/approve", post(api_approve_enrollment))
        .route("/api/enrollments/deny", post(api_deny_enrollment))
        .route("/api/enrollments/poll", post(api_poll_enrollment))
        .route("/api/backend-requests", post(api_backend_request))
        .route("/api/fleet/machines", get(fleet_api::api_fleet_machines))
        .route("/api/fleet/spawn", post(fleet_api::api_fleet_spawn))
        .route("/api/fleet/send", post(fleet_api::api_fleet_send))
        .route("/api/fleet/status", get(fleet_api::api_fleet_status))
        .route(
            "/api/fleet/tasks",
            get(fleet_api::api_fleet_tasks).post(fleet_api::api_fleet_task_create),
        )
        .route(
            "/api/fleet/tasks/{id}",
            get(fleet_api::api_fleet_task_get).post(fleet_api::api_fleet_task_update),
        )
        .route(
            "/api/fleet/tasks/{id}/links",
            post(fleet_api::api_fleet_task_link),
        )
        .route(
            "/api/service/shares",
            get(service_api::api_service_list_shares)
                .put(service_api::api_service_put_share)
                .delete(service_api::api_service_delete_share),
        )
        .route(
            "/api/service/ui-tokens",
            post(service_api::api_service_ui_token),
        )
        .route(
            "/api/auth/service-signin",
            get(service_api::api_service_signin),
        )
        .route("/api/llm-access", get(api_llm_access))
        .route("/api/llm-access/installer", get(api_llm_installer))
        .route("/api/gateway-quota", get(api_gateway_quota))
        .route("/api/gateway/key-limits", get(api_gateway_key_limits))
        .route("/api/devices", get(api_devices))
        .route("/api/devices/{machine_id}", delete(api_revoke_device))
        .route(
            "/api/devices/{machine_id}/restore",
            post(api_restore_device),
        )
        .route("/install/install-win.ps1", get(download_windows_installer))
        .route("/install/install-mac.sh", get(download_macos_installer))
        .route("/install/install-linux.sh", get(download_linux_installer))
        .route("/go", get(download_go_sh))
        .route("/go.sh", get(download_go_sh))
        .route("/go.ps1", get(download_go_ps1))
        .route("/install/app-mac.sh", get(download_macos_app_installer))
        .route(
            "/install/app-mac-shell.sh",
            get(download_macos_shell_app_installer),
        )
        .route("/install/app-win.ps1", get(download_windows_app_installer))
        .route("/install/codex-gateway.sh", get(download_codex_gateway_sh))
        .route(
            "/install/codex-gateway.ps1",
            get(download_codex_gateway_ps1),
        )
        .route("/install/package.json", get(download_agent_package))
        .route("/install/agent.mjs", get(download_agent_bundle))
        .route(
            "/install/agent.mjs.sha256",
            get(download_agent_bundle_sha256),
        )
        .route(
            "/install/agent.mjs.release",
            get(agent_release::download_agent_release),
        )
        .route(
            "/install/agent.mjs.sig",
            get(agent_release::download_agent_sig),
        )
        .route("/app/qr.svg", get(host_enroll::app_qr_svg))
        .route("/agent", get(ws_agent))
        .route("/ui", get(ws_ui))
        // The apps dial /mobile/ui; nginx rewrites it to /ui and adds rate
        // limits. Serving it here lets a plain reverse proxy (Caddy) forward
        // every path as-is.
        .route("/mobile/ui", get(ws_ui))
        .route(
            "/health",
            get(|| async { Json(serde_json::json!({ "ok": true })) }),
        )
        // audio dictation: browser posts an audio blob, we proxy to Azure with
        // the server-side key. 25MB cap matches Azure's transcription limit.
        .route(
            "/transcribe",
            post(transcribe).layer(DefaultBodyLimit::max(25 * 1024 * 1024)),
        )
        // Dictation clean-up: the recognised text in, what was meant out.
        .route(
            "/polish",
            post(polish_text).layer(DefaultBodyLimit::max(256 * 1024)),
        )
        .merge(external_legal_routes())
        .fallback(move |req: Request| sites.clone().serve(req))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            refresh_auth_cookie,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            support_api::audit_support_http,
        ))
        .with_state(state.clone());

    let addr = format!("{host}:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    println!(
        "[server-rs] listening on http://{addr}  (token: {})",
        if token == "dev-token" {
            "dev-token"
        } else {
            "set"
        }
    );
    println!("[server-rs] serving web from {web_dist}");
    match (&web_lite_dist, lite_hosts.is_empty()) {
        (Some(dist), false) => {
            println!("[server-rs] serving the light shell from {dist} on {lite_hosts:?}")
        }
        (None, false) => eprintln!(
            "[server-rs] CC_REMOTE_LITE_HOSTS is set without WEB_LITE_DIST: {lite_hosts:?} answer 503"
        ),
        (Some(_), true) => {
            eprintln!("[server-rs] WEB_LITE_DIST is set without CC_REMOTE_LITE_HOSTS: never served")
        }
        (None, true) => {}
    }
    println!("[server-rs] session database: {}", db_path.display());
    if adopted > 0 {
        println!("[server-rs] legacy devices assigned to bootstrap user: {adopted}");
    }
    if state.sso_secret.is_some() {
        println!("[server-rs] native SSO enabled (ccremote://auth)");
    }
    println!(
        "[server-rs] transcription: {}",
        if transcribe_ready {
            transcribe_backend
        } else {
            "disabled (no STT_URL and no CLOUD_STT_URL/KEY)"
        }
    );
    println!(
        "[server-rs] dictation polish: {}",
        match &state.polisher {
            Some(p) => p.model().to_string(),
            None => "disabled (no LLM_POLISH_URL/KEY or LLM_ENRICH_URL/KEY, or LLM_POLISH=0)"
                .to_string(),
        }
    );
    println!(
        "[server-rs] Google sign-in: {}",
        if state.google_auth.is_some() {
            "enabled (/api/auth/google/start)"
        } else {
            "disabled (no GOOGLE_CLIENT_ID)"
        }
    );
    println!(
        "[server-rs] GitHub sign-in: {}",
        if state.github_auth.is_some() {
            "enabled (/api/auth/github/start)"
        } else {
            "disabled (no GITHUB_CLIENT_ID)"
        }
    );
    println!(
        "[server-rs] GitHub repository grants: {}",
        match &state.github_grant {
            Some(g) => format!("enabled ({})", g.full_name()),
            None => "disabled (no GITHUB_GRANT_REPO)".to_string(),
        }
    );
    println!(
        "[server-rs] HegAI SSO: {}",
        if state.sso_secret.is_some() {
            "enabled"
        } else {
            "disabled (no CC_REMOTE_SSO_SECRET)"
        }
    );
    println!(
        "[server-rs] LLM gateway seats: {}",
        if state.llmgw.is_some() {
            "hub-managed (LLM_GATEWAY_URL set)"
        } else {
            "not configured — community seats are marked ready without a gateway"
        }
    );
    println!(
        "[server-rs] sandbox provisioning: {}",
        if state.provisioner_token.is_some() {
            "enabled (/api/provisioning/*)"
        } else {
            "disabled (no CC_REMOTE_PROVISIONER_TOKEN)"
        }
    );
    println!(
        "[server-rs] admin sign-in links: {}",
        if state.signin_link_secret.is_some() {
            "enabled (/api/auth/signin-link)"
        } else {
            "disabled (no usable CC_REMOTE_SIGNIN_LINK_SECRET)"
        }
    );
    // Stale running jobs and unfinished seats, once a minute.
    tokio::spawn(reconciler_loop(state.clone()));
    if state.stt_url.is_some() {
        tokio::spawn(watch_stt_health(state.clone()));
    }
    tokio::spawn(account_deletion_api::reconcile(state.clone()));
    // «Расходы»: fold the gateway's request log into daily counts.
    if let Some(gw) = state.llmgw.clone() {
        tokio::spawn(llm_usage::collector_loop(gw, state.workspaces.clone()));
    }
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await
    .expect("serve");
}

/// Session and login-state cookies carry the `__Host-` prefix (pentest
/// 11.11.2026, finding 2): the browser refuses to store such a cookie unless it
/// is `Secure`, `Path=/` and has NO `Domain`, so a page on a sibling subdomain
/// (`preview-sbN.acme.test`, code written by community members) can neither
/// plant nor overwrite it. On a plain-http hub (local dev, a LAN self-host) a
/// `__Host-` cookie cannot be stored at all, so `set_cookie_header` drops the
/// prefix there and the readers below follow.
const AUTH_COOKIE: &str = "__Host-cc-remote-auth";
/// The session cookie's name WITHOUT the prefix: what a plain-http hub (dev,
/// smokes, LAN self-host) sets and reads. An https hub never accepts it — the
/// old pre-`__Host-` cookies simply stop working (people sign in once more),
/// because accepting one is what a planted sibling-subdomain cookie needs. An
/// https hub only EXPIRES a stale one (`clear_auth_cookies`, the refresh layer).
const BARE_AUTH_COOKIE: &str = "cc-remote-auth";
/// Short-lived (ten minutes), no fallback: an unmatched state just restarts the
/// login.
const SSO_STATE_COOKIE: &str = "__Host-cc-remote-sso-state";
/// Where to send a person after a sign-in the hub itself did not complete (the
/// service sign-in fallback): a `/w/…` path, URL-encoded, ten minutes.
pub(crate) const RETURN_COOKIE: &str = "cc-remote-return";
/// Marks a login that began from an INSTALLED PWA — see `sso_start`. Carried in
/// the SSO state itself, so it survives the provider round trip without a
/// second cookie and without the hub having to remember anything.
const PWA_STATE_PREFIX: &str = "pwa-";

/// An embedded text asset without its byte-order mark.
///
/// The two Russian-language `.ps1` assets carry a UTF-8 BOM ON DISK so Windows
/// PowerShell 5.1 can run a saved copy with `-File`. Without it 5.1 decodes a
/// BOM-less script as the system ANSI codepage, and under cp1251 the UTF-8
/// bytes of `Б В Г Д ё` land exactly on the quote characters U+2018..U+201D,
/// which terminate a string early and fail the parse of the whole file. That is
/// a property of the LETTERS, not of typography — no amount of dash-cleaning
/// fixes it, only the BOM does.
///
/// The BOM must not reach the wire, though: the published one-liner is
/// `irm … | iex`, and `iex` chokes on a leading U+FEFF ("The term '﻿Write-Host'
/// is not recognized as the name of a cmdlet"). So the file keeps it and the
/// download drops it — both callers stay correct.
fn without_bom(s: &str) -> &str {
    s.strip_prefix('\u{feff}').unwrap_or(s)
}

fn public_download(
    body: impl Into<Body>,
    content_type: &'static str,
    filename: &'static str,
) -> Response {
    Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        .header(header::CACHE_CONTROL, "no-cache")
        .body(body.into())
        .expect("valid public download response")
}

/// The static legal pages that ship inside the web build (`/privacy`,
/// `/delete-account`) name HegAI's operator. A customer's hub answers them from
/// `CC_REMOTE_LEGAL_DIR` or with a neutral notice instead; the internal hub
/// adds no routes and the build's own pages are served as before.
fn external_legal_routes() -> Router<AppState> {
    let routes = Router::new();
    if !edition::is_external() {
        return routes;
    }
    let privacy = || async { selfhost::external_legal_page("privacy") };
    let deletion = || async { selfhost::external_legal_page("delete-account") };
    routes
        .route("/privacy", get(privacy))
        .route("/privacy/", get(privacy))
        .route("/privacy/index.html", get(privacy))
        .route("/delete-account", get(deletion))
        .route("/delete-account/", get(deletion))
        .route("/delete-account/index.html", get(deletion))
}

/// An installer script pointed at THIS hub (`selfhost::localize_installer`):
/// a no-op on code.acme.test, the customer's own name everywhere else.
fn installer(
    st: &AppState,
    script: &str,
    content_type: &'static str,
    filename: &'static str,
) -> Response {
    let body = selfhost::localize_installer(script, &st.public_url);
    let body = match selfhost::app_download_base() {
        Some(dl) => selfhost::point_app_downloads(&body, dl),
        None => body,
    };
    public_download(body, content_type, filename)
}

async fn download_windows_installer(State(st): State<AppState>) -> Response {
    installer(
        &st,
        INSTALL_WINDOWS,
        "text/plain; charset=utf-8",
        "install-win.ps1",
    )
}

async fn download_macos_installer(State(st): State<AppState>) -> Response {
    installer(
        &st,
        INSTALL_MACOS,
        "text/x-shellscript; charset=utf-8",
        "install-mac.sh",
    )
}

async fn download_linux_installer(State(st): State<AppState>) -> Response {
    installer(
        &st,
        INSTALL_LINUX,
        "text/x-shellscript; charset=utf-8",
        "install-linux.sh",
    )
}

async fn download_go_sh(State(st): State<AppState>) -> Response {
    installer(&st, GO_SH, "text/x-shellscript; charset=utf-8", "go.sh")
}

async fn download_go_ps1(State(st): State<AppState>) -> Response {
    installer(&st, GO_PS1, "text/plain; charset=utf-8", "go.ps1")
}

async fn download_macos_app_installer(State(st): State<AppState>) -> Response {
    installer(
        &st,
        INSTALL_APP_MACOS,
        "text/x-shellscript; charset=utf-8",
        "app-mac.sh",
    )
}

async fn download_macos_shell_app_installer(State(st): State<AppState>) -> Response {
    installer(
        &st,
        INSTALL_APP_MACOS_SHELL,
        "text/x-shellscript; charset=utf-8",
        "app-mac-shell.sh",
    )
}

async fn download_windows_app_installer(State(st): State<AppState>) -> Response {
    installer(
        &st,
        without_bom(INSTALL_APP_WINDOWS),
        "text/plain; charset=utf-8",
        "app-win.ps1",
    )
}

async fn download_agent_package() -> Response {
    public_download(
        INSTALL_PACKAGE,
        "application/json; charset=utf-8",
        "package.json",
    )
}

/// The gateway installers exist only where a gateway does: a hub without
/// `LLM_PUBLIC_URL` (every external one by default) has none to configure.
fn no_gateway() -> Response {
    api_error(
        StatusCode::NOT_FOUND,
        "no LLM gateway is configured on this hub",
    )
}

async fn download_codex_gateway_sh(State(st): State<AppState>) -> Response {
    if st.llm_public_url.is_empty() {
        return no_gateway();
    }
    let body = selfhost::localize_installer(CODEX_GATEWAY_SH, &st.public_url)
        .replace("__BASE__", &st.llm_public_url)
        .replace("__MODEL__", &installer_model())
        .replace("__EFFORT__", &installer_effort());
    public_download(
        body,
        "text/x-shellscript; charset=utf-8",
        "codex-gateway.sh",
    )
}

async fn download_codex_gateway_ps1(State(st): State<AppState>) -> Response {
    if st.llm_public_url.is_empty() {
        return no_gateway();
    }
    let body = selfhost::localize_installer(without_bom(CODEX_GATEWAY_PS1), &st.public_url)
        .replace("__BASE__", &st.llm_public_url)
        .replace("__MODEL__", &installer_model())
        .replace("__EFFORT__", &installer_effort());
    public_download(body, "text/plain; charset=utf-8", "codex-gateway.ps1")
}

async fn download_agent_bundle() -> Response {
    // External edition: only the bundle the owner approved (agent_release.rs).
    if edition::is_external() {
        return agent_release::serve_bundle().await;
    }
    public_download(INSTALL_AGENT, "text/javascript; charset=utf-8", "agent.mjs")
}

/// SHA-256 of the embedded agent bundle, hex. Agents poll this to update
/// themselves (`agent/src/self-update.ts`). Served by the hub rather than only
/// from nginx's `/dl/` because some agents reach the hub by a path nginx is not
/// on — the Mac mini rides an ssh tunnel straight to :4318 — and because the
/// hash and the bundle then come out of the same binary and cannot disagree.
fn agent_bundle_sha256() -> &'static str {
    static SHA: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    SHA.get_or_init(|| {
        use sha2::{Digest, Sha256};
        Sha256::digest(INSTALL_AGENT)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    })
}

async fn download_agent_bundle_sha256() -> Response {
    if edition::is_external() {
        return agent_release::serve_sha256().await;
    }
    public_download(
        format!("{}\n", agent_bundle_sha256()),
        "text/plain; charset=utf-8",
        "agent.mjs.sha256",
    )
}

/// Every value sent under `name`, across all `Cookie` headers (HTTP/2 may split
/// them), in the order received.
fn cookie_values(headers: &HeaderMap, name: &str) -> Vec<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|line| line.split(';'))
        .filter_map(|part| {
            let (key, value) = part.trim().split_once('=')?;
            (key == name).then(|| value.to_string())
        })
        .collect()
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    cookie_values(headers, name).into_iter().next()
}

/// `name` without the `__Host-` prefix: what a plain-http hub uses instead.
fn unprefixed(name: &str) -> &str {
    name.strip_prefix("__Host-").unwrap_or(name)
}

/// The one value sent under `name`. Two cookies of one name mean one of them
/// came from somewhere else (a parent domain or a sibling subdomain), and which
/// is which is not knowable from the header — refuse rather than guess.
fn sole_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let mut all = cookie_values(headers, name);
    (all.len() == 1)
        .then(|| all.remove(0))
        .filter(|v| !v.is_empty())
}

/// Set once at startup from `CC_REMOTE_PUBLIC_URL`: an https hub reads only the
/// `__Host-` session cookie. (A process-wide fact, so the many cookie readers
/// that have no `AppState` in hand need not each be threaded one.)
static HTTPS_HUB: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn session_cookie_accepts_bare() -> bool {
    !HTTPS_HUB.load(std::sync::atomic::Ordering::Relaxed)
}

/// The browser's session cookie. `__Host-cc-remote-auth` always; the bare name
/// only where `accept_bare` (a plain-http hub). A `__Host-` cookie that is
/// present but unusable never falls through to the bare one.
fn session_cookie_with(headers: &HeaderMap, accept_bare: bool) -> Option<String> {
    if !cookie_values(headers, AUTH_COOKIE).is_empty() {
        return sole_cookie(headers, AUTH_COOKIE);
    }
    if accept_bare {
        return sole_cookie(headers, BARE_AUTH_COOKIE);
    }
    None
}

fn auth_cookie_token(headers: &HeaderMap) -> Option<String> {
    session_cookie_with(headers, session_cookie_accepts_bare())
}

/// The login-state cookie as THIS hub sets it (`__Host-` on https, plain on a
/// plain-http hub). No legacy fallback.
fn state_cookie(headers: &HeaderMap, secure: bool) -> Option<String> {
    let name = if secure {
        SSO_STATE_COOKIE
    } else {
        unprefixed(SSO_STATE_COOKIE)
    };
    sole_cookie(headers, name)
}

fn set_cookie_header(name: &str, value: &str, max_age: i64, secure: bool) -> HeaderValue {
    let name = if secure { name } else { unprefixed(name) };
    let secure = if secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{name}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}"
    ))
    .expect("valid cookie header")
}

/// Both session cookies, expired: logout and the like also sweep a stale bare
/// cookie left from before the `__Host-` prefix.
fn clear_auth_cookies(secure: bool) -> [HeaderValue; 2] {
    [
        set_cookie_header(AUTH_COOKIE, "", 0, secure),
        set_cookie_header(BARE_AUTH_COOKIE, "", 0, secure),
    ]
}

fn api_error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({"error":message.into()}))).into_response()
}

/// Stamped by `workspace::db_err` on every SQLite failure, so a handler can
/// tell a broken database from a refusal in words.
pub(crate) const DB_ERROR_MARK: &str = "database error: ";

/// What a client reads instead of the text of an infrastructure failure.
const INTERNAL_ERROR_BODY: &str = "internal error";

fn is_infrastructure_failure(message: &str) -> bool {
    message.contains(DB_ERROR_MARK) || message.contains("lock poisoned")
}

#[track_caller]
fn log_internal(cause: &dyn std::fmt::Display) {
    let at = std::panic::Location::caller();
    eprintln!(
        "[api] internal error at {}:{}: {cause}",
        at.file(),
        at.line()
    );
}

/// A store's `Err(String)` as an error response with `status`.
///
/// The stores use one `String` for two different things: a refusal the caller
/// is meant to read («device not found», «insufficient workspace role») and
/// the text of a broken database («UNIQUE constraint failed: users.email»,
/// «database is locked», «workspace database lock poisoned»). The first goes
/// to the client as written. The second names tables and columns to whoever
/// asks — some of these endpoints answer before sign-in — so it goes to the
/// log with the call site and the client reads `internal error`. The status
/// is the handler's either way: this hides words, it does not re-route flows.
///
/// A wrapper that calls this for many sites carries `#[track_caller]` too, or
/// the log names the wrapper.
#[track_caller]
fn refusal(status: StatusCode, message: impl Into<String>) -> Response {
    let message = message.into();
    if is_infrastructure_failure(&message) {
        log_internal(&message);
        return api_error(status, INTERNAL_ERROR_BODY);
    }
    api_error(status, message)
}

/// `refusal` for the usual case: the handler has no better status than 500.
#[track_caller]
fn store_failure(message: impl Into<String>) -> Response {
    refusal(StatusCode::INTERNAL_SERVER_ERROR, message)
}

/// A failure that is never the client's to read (SQLite, I/O): the text goes
/// to the log with the call site, the client reads `internal error`.
#[track_caller]
fn internal_error(cause: impl std::fmt::Display) -> Response {
    log_internal(&cause);
    api_error(StatusCode::INTERNAL_SERVER_ERROR, INTERNAL_ERROR_BODY)
}

/// The same rule for an error that leaves over a socket frame instead of an
/// HTTP body: a database failure is logged and replaced, words pass.
#[track_caller]
pub(crate) fn client_safe_error(message: &str) -> &str {
    if is_infrastructure_failure(message) {
        log_internal(&message);
        return INTERNAL_ERROR_BODY;
    }
    message
}

#[cfg(test)]
mod store_failure_tests {
    use super::{
        client_safe_error, internal_error, refusal, store_failure, Response, StatusCode, Value,
    };

    async fn error_of(res: Response) -> (StatusCode, String) {
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 16)
            .await
            .expect("body");
        let body: Value = serde_json::from_slice(&bytes).expect("json body");
        (
            status,
            body["error"].as_str().unwrap_or_default().to_string(),
        )
    }

    fn sqlite_failure() -> String {
        let conn = rusqlite::Connection::open_in_memory().expect("sqlite");
        let error = conn
            .execute("INSERT INTO secret_table (secret_column) VALUES (1)", [])
            .expect_err("the table does not exist");
        crate::workspace::db_err(error)
    }

    #[tokio::test]
    async fn a_database_failure_does_not_reach_the_client() {
        let text = sqlite_failure();
        assert!(
            text.contains("secret_table"),
            "the fixture must carry what would leak: {text}"
        );
        let (status, error) = error_of(store_failure(text)).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(error, "internal error");
    }

    #[tokio::test]
    async fn a_database_failure_wrapped_in_context_is_hidden_too() {
        let wrapped = format!("could not record the sign-in: {}", sqlite_failure());
        let (status, error) = error_of(store_failure(wrapped)).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(error, "internal error");
    }

    #[tokio::test]
    async fn a_poisoned_lock_does_not_reach_the_client() {
        for text in [
            "workspace database lock poisoned",
            "database lock poisoned",
            "lock poisoned",
        ] {
            let (status, error) = error_of(store_failure(text)).await;
            assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
            assert_eq!(error, "internal error", "{text}");
        }
    }

    #[tokio::test]
    async fn a_refusal_in_words_is_passed_through() {
        let (status, error) = error_of(store_failure("device not found")).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(error, "device not found");
    }

    #[tokio::test]
    async fn a_refusal_keeps_its_status_and_hides_only_a_database_failure() {
        let (status, error) = error_of(refusal(StatusCode::BAD_REQUEST, sqlite_failure())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error, "internal error");
        let (status, error) = error_of(refusal(
            StatusCode::FORBIDDEN,
            "insufficient workspace role",
        ))
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(error, "insufficient workspace role");
    }

    #[test]
    fn a_socket_error_follows_the_same_rule() {
        let failure = sqlite_failure();
        assert_eq!(client_safe_error(&failure), "internal error");
        assert_eq!(
            client_safe_error("workspace database lock poisoned"),
            "internal error"
        );
        assert_eq!(client_safe_error("session not found"), "session not found");
    }

    #[tokio::test]
    async fn internal_error_never_echoes_its_cause() {
        let (status, error) =
            error_of(internal_error("/home/cc-remote-hub/x.sqlite3: disk I/O")).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(error, "internal error");
    }
}

/// `Err(state)` for a viewer who may not use the product yet — `waitlist`
/// or `suspended`. The bootstrap owner and platform admins always pass (the
/// store applies that override). A lookup failure reads as `waitlist`: a
/// broken row must never open the product.
pub(crate) fn access_gate_state(store: &WorkspaceStore, user_id: &str) -> Result<(), String> {
    match store.access_state(user_id) {
        Ok(access) if access.state == "active" => Ok(()),
        Ok(access) => Err(access.state),
        Err(_) => Err("waitlist".into()),
    }
}

/// The one HTTP gate for the community rollout. Before activation the
/// product is the waiting screen: every mutation that would reach a machine,
/// a team or the gateway answers 403 `access_not_active` with the state, so
/// the web can render the right screen instead of a generic error.
fn require_active(st: &AppState, user_id: &str) -> Result<(), Response> {
    access_gate_state(&st.workspaces, user_id).map_err(|state| {
        (
            StatusCode::FORBIDDEN,
            Json(json!({"error":"access_not_active","state":state})),
        )
            .into_response()
    })
}

/// A hub that faces the internet must not run on the guessable default token.
///
/// With `CC_REMOTE_TOKEN` unset the token is `dev-token`, and then every
/// unauthenticated request is the bootstrap owner (`authenticated_user`) and
/// any agent that says `dev-token` may register. That is the right default on
/// a laptop and a catastrophe on code.acme.test, and the hub used to only
/// print `(token: dev-token)` and carry on. An https public URL is the signal
/// that this is not a laptop.
fn unsafe_public_config(token: &str, public_url: &str, host: &str) -> Option<String> {
    if token != "dev-token" {
        return None;
    }
    if public_url.starts_with("https://") {
        return Some(format!(
            "CC_REMOTE_TOKEN is unset (dev-token) while CC_REMOTE_PUBLIC_URL={public_url} is public; every request would be the owner"
        ));
    }
    if !is_loopback_host(host) {
        return Some(format!(
            "CC_REMOTE_TOKEN is unset (dev-token) while HOST={host} is reachable from outside; every request would be the owner"
        ));
    }
    None
}

/// Whether the shared fleet token may open `/ui` as the bootstrap owner.
/// Only on a dev hub (the default token) or when `CC_REMOTE_FLEET_UI=1`
/// opts in: in production the fleet token is a machine credential that every
/// legacy agent carries, and letting it double as the owner's browser login
/// made every agent box an admin console.
fn fleet_token_opens_ui(fleet_token: &str, fleet_ui_env: bool) -> bool {
    fleet_token == "dev-token" || fleet_ui_env
}

/// `Authorization: Bearer <session>` — how a native client (which has no cookie
/// jar we control) presents the same workspace session the browser keeps in a
/// cookie.
fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    raw.strip_prefix("Bearer ")
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

fn authenticated_user(headers: &HeaderMap, st: &AppState) -> Result<String, Response> {
    for token in [auth_cookie_token(headers), bearer_token(headers)]
        .into_iter()
        .flatten()
    {
        match st.workspaces.authenticate(&token) {
            Ok(Some((user_id, _))) => return Ok(user_id),
            Ok(None) => {}
            Err(e) => return Err(store_failure(e)),
        }
    }
    // Local/dev compatibility only. Production always configures a non-default
    // fleet token and requires the HegAI SSO cookie.
    if st.token == "dev-token" {
        return Ok(st.bootstrap_user_id.clone());
    }
    Err(api_error(
        StatusCode::UNAUTHORIZED,
        "authentication required",
    ))
}

/// Re-stamp the session cookie for as long as the session behind it lives.
///
/// The cookie is issued once, at login, with a fixed `Max-Age`, while
/// `WorkspaceStore::authenticate` slides the session in the database forward on
/// every use. The two drifted apart: seven days after signing in the browser
/// silently dropped a cookie whose session was still perfectly good. Nothing
/// looked broken server-side — the row was alive — and a tab that had been open
/// the whole time never reloads, so it never met the sign-in redirect either.
/// It just started getting 401 on its `/ui` upgrade and reconnected forever.
/// On 2026-09-21 that emptied the screen for five people whose cookies fell due
/// within four hours of each other; it read as a hung hub.
///
/// So: any request that arrives with a valid cookie leaves with a fresh one,
/// cut to the session's own remaining life.
async fn refresh_auth_cookie(State(st): State<AppState>, req: Request, next: Next) -> Response {
    // Content-hashed assets carry the cookie too and are the bulk of the
    // traffic; they have no business taking the session database's lock.
    let skip = req.uri().path().starts_with("/assets/");
    let secure = st.public_url.starts_with("https://");
    let cookie = if skip {
        None
    } else {
        session_cookie_with(req.headers(), !secure)
    };
    // On an https hub a bare `cc-remote-auth` is dead weight (and a tossing
    // target): expire it so the browser stops sending it.
    let stale_bare = secure && !skip && !cookie_values(req.headers(), BARE_AUTH_COOKIE).is_empty();
    let mut res = next.run(req).await;
    // A handler that spoke about this cookie owns the last word on it — logout
    // clears it, and a refresh racing in behind would put it straight back.
    let spoke = res
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .any(|v| v.starts_with(AUTH_COOKIE) || v.starts_with(BARE_AUTH_COOKIE));
    if spoke {
        return res;
    }
    if stale_bare {
        res.headers_mut().append(
            header::SET_COOKIE,
            set_cookie_header(BARE_AUTH_COOKIE, "", 0, secure),
        );
    }
    let Some(token) = cookie else { return res };
    let Ok(Some((_, expires_at))) = st.workspaces.authenticate(&token) else {
        return res;
    };
    let max_age = (expires_at - now_ms()) / 1000;
    if max_age <= 0 {
        return res;
    }
    res.headers_mut().append(
        header::SET_COOKIE,
        set_cookie_header(AUTH_COOKIE, &token, max_age, secure),
    );
    res
}

/// The workspace session token this request authenticated with — cookie,
/// bearer, or (native `/ui`) `?token=` — when it is a real session.
fn presented_session(
    params: &HashMap<String, String>,
    headers: &HeaderMap,
    st: &AppState,
) -> Option<String> {
    [
        auth_cookie_token(headers),
        bearer_token(headers),
        params.get("token").cloned(),
    ]
    .into_iter()
    .flatten()
    .find(|token| matches!(st.workspaces.authenticate(token), Ok(Some(_))))
}

/// A human name for the device behind a sign-in, for «Где я вошёл» — a
/// coarse guess from User-Agent into a FIXED vocabulary. Never free text from
/// the client: the list exists so a person spots a sign-in that is not theirs,
/// and a label the thief chose («MacBook — это устройство») would hide it.
fn device_label(headers: &HeaderMap) -> String {
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let lower = ua.to_ascii_lowercase();
    let os = if lower.contains("iphone") || lower.contains("ipad") {
        "iOS"
    } else if lower.contains("android") {
        "Android"
    } else if lower.contains("mac os") || lower.contains("macintosh") {
        "macOS"
    } else if lower.contains("windows") {
        "Windows"
    } else if lower.contains("linux") {
        "Linux"
    } else {
        ""
    };
    let app =
        if lower.contains("cfnetwork") || lower.contains("ccremote") || lower.contains("okhttp") {
            "приложение"
        } else if lower.contains("tauri") || lower.contains("hegai code") {
            "Hegai Code"
        } else if lower.contains("edg/") {
            "Edge"
        } else if lower.contains("chrome/") {
            "Chrome"
        } else if lower.contains("firefox/") {
            "Firefox"
        } else if lower.contains("safari/") {
            "Safari"
        } else if lower.contains("node") || lower.is_empty() {
            "скрипт"
        } else {
            "браузер"
        };
    if os.is_empty() {
        app.to_string()
    } else {
        format!("{app} · {os}")
    }
}

fn ui_user(
    params: &HashMap<String, String>,
    headers: &HeaderMap,
    st: &AppState,
) -> Result<String, Response> {
    if let Ok(user) = authenticated_user(headers, st) {
        return Ok(user);
    }
    let Some(token) = params.get("token") else {
        return Err(api_error(StatusCode::UNAUTHORIZED, "unauthorized"));
    };
    // A native client cannot set cookies on our origin, so it carries its
    // workspace session in the query string instead. This is the SAME session
    // the browser holds — a real user, with their own workspaces and access —
    // not a shared device token.
    match st.workspaces.authenticate(token) {
        Ok(Some((user_id, _))) => return Ok(user_id),
        Ok(None) => {}
        Err(e) => return Err(store_failure(e)),
    }
    // The fleet token opens `/ui` for the smoke CLIs in `server/src/cli/` on a
    // dev hub only (or with CC_REMOTE_FLEET_UI=1); production smokes carry a
    // real session token. See `fleet_token_opens_ui`.
    if crate::provisioning_api::ct_eq(token.as_bytes(), st.token.as_bytes())
        && fleet_token_opens_ui(&st.token, st.fleet_ui)
    {
        return Ok(st.bootstrap_user_id.clone());
    }
    Err(api_error(StatusCode::UNAUTHORIZED, "unauthorized"))
}

/// Read the backend-spec intake policy from the environment.
///
/// All three settings are required together — a target with no allowlist would
/// let any enrolled machine open sessions on the backend box, and an allowlist
/// with no target has nowhere to send them. Missing or malformed => the route
/// stays closed, which is the safe direction for a feature that starts sessions
/// on someone else's behalf.
fn load_backend_request_config() -> Option<BackendRequestConfig> {
    let source_machines: HashSet<String> = std::env::var("CC_REMOTE_TZ_SOURCE_MACHINES")
        .ok()?
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    if source_machines.is_empty() {
        return None;
    }
    // `<machineId>:<absolute cwd>` — split once from the left, since only the
    // machine id is known to be colon-free.
    let target = std::env::var("CC_REMOTE_TZ_TARGET").ok()?;
    let (target_machine, target_cwd) = target.split_once(':')?;
    if target_machine.is_empty() || !target_cwd.starts_with('/') {
        eprintln!("[hub] ignoring CC_REMOTE_TZ_TARGET={target} (want <machineId>:/absolute/path)");
        return None;
    }
    let daily_limit = std::env::var("CC_REMOTE_TZ_DAILY_LIMIT")
        .ok()
        .and_then(|raw| raw.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(20);
    Some(BackendRequestConfig {
        source_machines,
        target_machine: target_machine.to_string(),
        target_cwd: target_cwd.to_string(),
        daily_limit,
    })
}

fn agent_credential(
    params: &HashMap<String, String>,
    st: &AppState,
) -> Result<DeviceCredential, Response> {
    let Some(token) = params.get("token") else {
        return Err(api_error(StatusCode::UNAUTHORIZED, "unauthorized"));
    };
    // The shared fleet token: the legacy escape for machines that predate
    // device enrollment. It carries no machine identity (empty `machine_id` =
    // "any"), so the hub applies `CC_REMOTE_FLEET_MACHINE_IDS` at `register`,
    // the first moment the machine id is known. Unset = today's behaviour.
    if crate::provisioning_api::ct_eq(token.as_bytes(), st.token.as_bytes()) {
        return Ok(DeviceCredential {
            machine_id: String::new(),
            user_id: st.bootstrap_user_id.clone(),
        });
    }
    match st.workspaces.device_credential(token) {
        Ok(Some(device)) => Ok(device),
        Ok(None) => Err(api_error(
            StatusCode::UNAUTHORIZED,
            "invalid device credential",
        )),
        Err(e) => Err(store_failure(e)),
    }
}

/// A chunk that is not on disk. Explicitly 404, explicitly UNCACHEABLE.
///
/// `/assets/*` used to fall through to the SPA fallback below, so a chunk
/// requested across a deploy came back as index.html with a 200 — and nginx,
/// which cannot see what it is labelling, stamped that HTML `immutable` for
/// a year. The browser and the service worker then held 6 KB of markup under
/// a `.js` URL until somebody cleared the site data.
///
/// `no-store` is not decoration. Rule 8 rolls back by putting the previous
/// `web-dist` back, which brings the OLD hashes back with it — a 404 cached
/// for a year would make that rollback permanently broken for exactly the
/// clients that hit the gap.
async fn asset_missing() -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        [(header::CACHE_CONTROL, "no-store")],
        "asset not found",
    )
}

/// One built shell as a service: its hashed assets and its SPA fallback.
fn static_site(dist: &str) -> Router {
    // Content-hashed build output: the one tree where a miss must stay a miss.
    // Nested, so it wins over the SPA fallback. The immutable header is set HERE
    // rather than in nginx because only this end knows the status code — nginx's
    // `add_header ... always` labelled the misses too.
    let assets = Router::new()
        .fallback_service(
            ServeDir::new(PathBuf::from(dist).join("assets")).fallback(get(asset_missing)),
        )
        .layer(axum::middleware::map_response(
            |mut res: Response| async move {
                if res.status().is_success() {
                    res.headers_mut().insert(
                        header::CACHE_CONTROL,
                        HeaderValue::from_static("public, max-age=31536000, immutable"),
                    );
                }
                res
            },
        ));
    let spa = ServeDir::new(dist)
        .append_index_html_on_directories(true)
        .fallback(ServeFile::new(PathBuf::from(dist).join("index.html")));
    Router::new()
        .nest_service("/assets", assets)
        .fallback_service(spa)
        .layer(axum::middleware::map_response(
            |mut res: Response| async move {
                // The app may not be framed (clickjacking: a page on any
                // *.acme.test — a sandbox preview included — could overlay it),
                // load plugins, or have its relative URLs rebased by an
                // injected <base>. Deliberately NOT a script/img policy: the
                // no-flash theme script in index.html is inline and account
                // photos come from other hosts; remote images in agent prose
                // are handled in the renderer (web/src/render/Blocks.tsx).
                res.headers_mut().insert(
                    header::CONTENT_SECURITY_POLICY,
                    HeaderValue::from_static(SHELL_CSP),
                );
                res
            },
        ))
}

/// See `static_site`.
const SHELL_CSP: &str = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'";

/// The shells this hub serves, chosen by the request's `Host`.
///
/// The full client answers on every name; the light one (`web/lite`, built to
/// `WEB_LITE_DIST`) only on the names in `CC_REMOTE_LITE_HOSTS`. nginx forwards
/// `Host $host` on `/` and `/assets/`, so the name here is the one in the
/// address bar.
///
/// A listed name with no light build answers 503 and NEVER the full shell: the
/// full client registers a service worker, and a worker registered on the light
/// origin would keep serving the wrong application there after the right one
/// arrived.
#[derive(Clone)]
struct StaticSites {
    full: Router,
    lite: Option<Router>,
    lite_hosts: Arc<Vec<String>>,
}

impl StaticSites {
    async fn serve(self, req: Request) -> Response {
        let lite = request_host(req.headers()).is_some_and(|h| self.lite_hosts.contains(&h));
        let site = if lite {
            match self.lite {
                Some(site) => site,
                None => {
                    return (
                        StatusCode::SERVICE_UNAVAILABLE,
                        [(header::CACHE_CONTROL, "no-store")],
                        "this shell is not deployed yet",
                    )
                        .into_response()
                }
            }
        } else {
            self.full
        };
        match site.oneshot(req).await {
            Ok(res) => res,
            Err(never) => match never {},
        }
    }
}

/// The request's own hostname: `Host` without a port, lowercased.
fn request_host(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .and_then(|h| origin_host(&format!("x://{h}")))
}

/// `CC_REMOTE_LITE_HOSTS`: comma-separated bare hostnames, lowercased. An entry
/// written as a URL or with a port is reduced to its name.
fn parse_host_list(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .filter_map(|h| {
            if h.contains("://") {
                origin_host(h)
            } else {
                origin_host(&format!("x://{h}"))
            }
        })
        .collect()
}

/// CSRF gate for cookie-authenticated mutations.
///
/// `SameSite=Lax` sends the session cookie on requests from ANY `*.acme.test`
/// page, and sandbox previews (`preview-sbN.acme.test`) serve a member's own
/// JavaScript — so "not cross-site" is not enough (until 08.10.2026 it was the
/// whole check). Now:
/// - `Sec-Fetch-Site: same-origin` / `none` → allowed;
/// - `same-site` → allowed only when `Origin`'s host is this request's `Host`
///   (the spare doors `:2096`/`:8443` are the same host on another port);
/// - `cross-site` or anything unknown → refused;
/// - no `Sec-Fetch-Site`: a browser that sends `Origin` is held to the same
///   host match; no `Origin` at all is a native client (iOS, tgbot, CLI),
///   which authenticates with a bearer, not an ambient cookie.
fn same_origin(headers: &HeaderMap) -> bool {
    match headers
        .get("sec-fetch-site")
        .map(|v| v.to_str().unwrap_or(""))
    {
        Some("same-origin") | Some("none") => true,
        Some("same-site") => origin_is_request_host(headers),
        Some(_) => false,
        None => headers.get(header::ORIGIN).is_none() || origin_is_request_host(headers),
    }
}

/// `Origin`'s host equals the `Host` header's host (ports ignored), or is
/// loopback (dev). `false` when either is missing or unparsable.
fn origin_is_request_host(headers: &HeaderMap) -> bool {
    let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .and_then(origin_host)
    else {
        return false;
    };
    if is_loopback_host(&origin) {
        return true;
    }
    headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .and_then(|h| origin_host(&format!("x://{h}")))
        .is_some_and(|h| h == origin)
}

/// Hostname of an origin or URL (`https://code.acme.test:8443/x` →
/// `code.acme.test`), lowercased. `None` for anything without a scheme.
fn origin_host(raw: &str) -> Option<String> {
    let rest = raw.trim().split_once("://")?.1;
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = if let Some(v6) = authority.strip_prefix('[') {
        v6.split(']').next()?
    } else {
        authority.split(':').next()?
    };
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

fn is_loopback_host(host: &str) -> bool {
    host == "localhost" || host == "::1" || host.starts_with("127.")
}

/// Whether a `/ui` WebSocket handshake may proceed, judged by `Origin`.
///
/// The socket drives machines — start a session, answer an approval, type
/// into a terminal — and a browser attaches the session cookie to a WebSocket
/// handshake from ANY page on the same site: `SameSite=Lax` stops
/// evil.example, not a compromised or user-content `*.acme.test` subdomain.
/// Browsers always send `Origin` on a WebSocket handshake and a page cannot
/// forge it, so:
/// - no `Origin` → a native client (iOS, Android, tgbot, smokes), allowed —
///   they authenticate with a bearer, not an ambient cookie;
/// - `Origin` whose HOST matches the request's `Host`, `public_url`, an entry
///   in `CC_REMOTE_UI_ORIGINS`, or loopback (dev) → allowed;
/// - anything else → refused.
///
/// Ports are not compared: nginx forwards `$host` without one, and the spare
/// doors (`:2096`, `:8443`) are the same site.
fn ui_origin_allowed(headers: &HeaderMap, public_url: &str, extra: &[String]) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let Some(host) = origin.to_str().ok().and_then(origin_host) else {
        return false;
    };
    if is_loopback_host(&host) || extra.contains(&host) {
        return true;
    }
    if origin_host(public_url).is_some_and(|h| h == host) {
        return true;
    }
    headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .and_then(|h| origin_host(&format!("x://{h}")))
        .is_some_and(|h| h == host)
}

fn verify_sso_claims(token: &str, secret: &str) -> Result<SsoClaims, ()> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_audience(&["cc-remote"]);
    validation.set_issuer(&["acme.test"]);
    // jsonwebtoken defaults to 60 s of slack on top of the 60 s token life,
    // doubling the replay window for a leaked token. Clock skew between two
    // servers on NTP is milliseconds; 5 s is plenty.
    validation.leeway = 5;
    decode::<SsoClaims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map(|data| data.claims)
    .map_err(|_| ())
}

/// Mint a gateway access link token. Only the provisioning tooling signs these in
/// production; the hub carries it so the format has exactly one definition and the
/// round-trip is unit-testable.
/// Signing lives in JS (`mint-signin-link.mjs`); the Rust twins exist so the
/// tests can prove `verify_*` accepts what the minter produces.
#[cfg(test)]
fn sign_access_link(email: &str, secret: &str) -> Result<String, ()> {
    let claims = AccessLinkClaims {
        sub: email.trim().to_ascii_lowercase(),
        iss: ACCESS_LINK_ISSUER.to_string(),
        aud: ACCESS_LINK_AUDIENCE.to_string(),
    };
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|_| ())
}

/// Email behind an access-link token, or `None` when links are not configured or
/// the token does not check out.
fn email_from_access_link(st: &AppState, token: &str) -> Option<String> {
    verify_access_link(token, st.access_link_secret.as_deref()?)
}

/// Email behind an access-link token, or `None` if it is malformed, signed with
/// the wrong secret, or aimed at a different audience.
fn verify_access_link(token: &str, secret: &str) -> Option<String> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_audience(&[ACCESS_LINK_AUDIENCE]);
    validation.set_issuer(&[ACCESS_LINK_ISSUER]);
    // These tokens carry no `exp` on purpose, and jsonwebtoken demands one by
    // default — without both lines every link would be rejected as malformed.
    validation.required_spec_claims.clear();
    validation.validate_exp = false;
    let claims = decode::<AccessLinkClaims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .ok()?
    .claims;
    let email = claims.sub.trim().to_ascii_lowercase();
    (!email.is_empty()).then_some(email)
}

/// Mint an admin sign-in link token. Only `deploy/mint-signin-link.mjs` signs
/// these in production; the hub carries the signer so the format has exactly
/// one definition and the round-trip is unit-testable — same reason as
/// `sign_access_link`.
#[cfg(test)]
fn sign_signin_link(email: &str, by: &str, ttl_secs: u64, secret: &str) -> Result<String, ()> {
    let exp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| ())?
        .as_secs()
        + ttl_secs;
    let claims = SigninLinkClaims {
        sub: email.trim().to_ascii_lowercase(),
        by: by.to_string(),
        jti: Uuid::new_v4().to_string(),
        iss: SIGNIN_LINK_ISSUER.to_string(),
        aud: SIGNIN_LINK_AUDIENCE.to_string(),
        iat: (exp - ttl_secs) as usize,
        exp: exp as usize,
    };
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|_| ())
}

/// The longest a sign-in link may live: `exp - iat`.
const SIGNIN_LINK_MAX_LIFETIME_SECS: u64 = 24 * 60 * 60;
/// How far in the future an `iat` may be (clock skew between mint and hub).
const SIGNIN_LINK_SKEW_SECS: u64 = 5;

/// Claims behind a sign-in link, or `None` if it is malformed, signed with the
/// wrong secret, aimed at another audience, or past its `exp`.
fn verify_signin_link(token: &str, secret: &str) -> Option<SigninLinkClaims> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.set_audience(&[SIGNIN_LINK_AUDIENCE]);
    validation.set_issuer(&[SIGNIN_LINK_ISSUER]);
    // Default leeway is 60s, which would quietly make a 15-minute link a
    // 16-minute one. The same box signs and checks these, so it buys nothing.
    validation.leeway = 0;
    let claims = decode::<SigninLinkClaims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .ok()?
    .claims;
    // `by` is what the audit row names as the actor and what goes in the hub's
    // log line, so an empty one would produce an anonymous trace and a newline
    // in it could forge a log entry. A link that cannot say who asked for it is
    // not a link we honour.
    let by_ok = !claims.by.trim().is_empty()
        && claims.by.chars().count() <= 64
        && !claims.by.chars().any(char::is_control);
    // `iat` must be present (it is not an Option), not in the future beyond a
    // few seconds of clock skew, and the link may live at most a day from it.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (iat, exp) = (claims.iat as u64, claims.exp as u64);
    let lifetime_ok = iat <= now + SIGNIN_LINK_SKEW_SECS
        && exp >= iat
        && exp - iat <= SIGNIN_LINK_MAX_LIFETIME_SECS;
    (lifetime_ok && !claims.sub.trim().is_empty() && !claims.jti.trim().is_empty() && by_ok)
        .then_some(claims)
}

fn mutation_user(headers: &HeaderMap, st: &AppState) -> Result<String, Response> {
    if !same_origin(headers) {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "cross-site request rejected",
        ));
    }
    authenticated_user(headers, st)
}

/// `mutation_user` for the platform-admin endpoints: same-origin, signed in,
/// and listed in `platform_admins`.
fn admin_mutation_user(headers: &HeaderMap, st: &AppState) -> Result<String, Response> {
    let actor = mutation_user(headers, st)?;
    if !st.platform_admins.contains(&actor) {
        return Err(api_error(StatusCode::FORBIDDEN, "platform admin required"));
    }
    Ok(actor)
}

/// Custom-scheme callback the iOS app hands to `ASWebAuthenticationSession`.
const NATIVE_CALLBACK: &str = "ccremote://auth";
const NATIVE_STATE_TTL: Duration = Duration::from_secs(600);

/// Remember a native handshake and drop expired ones (the map only ever holds
/// in-flight logins, so a linear sweep is free).
fn remember_native_state(st: &AppState, state: &str) {
    if let Ok(mut map) = st.native_sso_states.lock() {
        let now = Instant::now();
        map.retain(|_, issued| now.duration_since(*issued) < NATIVE_STATE_TTL);
        map.insert(state.to_string(), now);
    }
}

fn take_native_state(st: &AppState, state: &str) -> bool {
    st.native_sso_states
        .lock()
        .ok()
        .and_then(|mut map| map.remove(state))
        .is_some_and(|issued| Instant::now().duration_since(issued) < NATIVE_STATE_TTL)
}

/// The origin a sign-in must come back to. Normally `public_url`. When the
/// request arrived on one of the relay's spare doors — the same host name, a
/// port from the allow-list — the callback keeps that port, because for the
/// person on that door `:443` is the one that does not open (a middlebox
/// intercepting TLS: 23.09.2026, port 80 answering a foreign nginx, 443 reset).
///
/// When it arrived on another name this hub is served under (`alt_hosts`, the
/// light shell's `remote.acme.test`), the callback keeps that NAME: the session
/// cookie and the state cookie are host-only, so a sign-in begun there and
/// returned to `public_url` would find no state cookie and fail, and one that
/// succeeded would have signed the person in on the wrong site.
///
/// nginx hands the client's `Host` over as `X-Forwarded-Host` (`$host` strips
/// the port). The header is the client's word, so it only ever SELECTS: the
/// name must be `public_url`'s or one from the allow-list and is emitted in our
/// spelling, the port must be `public_url`'s own or one from the allow-list. A
/// forged header cannot steer the return anywhere else — and the platform's own
/// allow-list is the second wall.
fn callback_origin(
    public_url: &str,
    alt_ports: &[u16],
    alt_hosts: &[String],
    forwarded_host: Option<&str>,
) -> String {
    let base = public_url.trim_end_matches('/');
    let Some(fwd) = forwarded_host.map(str::trim).filter(|h| !h.is_empty()) else {
        return base.to_string();
    };
    let (scheme, rest) = match base.split_once("://") {
        Some(v) => v,
        None => return base.to_string(),
    };
    let public_host = rest.split('/').next().unwrap_or(rest);
    let (public_name, public_port) = match public_host.rsplit_once(':') {
        Some((n, p)) if !n.contains(']') || n.ends_with(']') => (n, p.parse::<u16>().ok()),
        _ => (public_host, None),
    };
    let (fwd_name, fwd_port) = match fwd.rsplit_once(':') {
        Some((n, p)) if !n.contains(']') || n.ends_with(']') => (n, p.parse::<u16>().ok()),
        _ => (fwd, None),
    };
    if fwd_name.eq_ignore_ascii_case(public_name) {
        return match fwd_port {
            Some(port) if alt_ports.contains(&port) => format!("{scheme}://{public_name}:{port}"),
            _ => base.to_string(),
        };
    }
    let Some(alt) = alt_hosts.iter().find(|h| h.eq_ignore_ascii_case(fwd_name)) else {
        return base.to_string();
    };
    match fwd_port {
        Some(port) if alt_ports.contains(&port) || public_port == Some(port) => {
            format!("{scheme}://{alt}:{port}")
        }
        _ => format!("{scheme}://{alt}"),
    }
}

/// The address a login hop came from. Only a trusted reverse proxy may supply
/// it (`x-real-ip`) — our loopback nginx, plus whatever
/// `CC_REMOTE_TRUSTED_PROXIES` names (a container network's proxy); anything
/// else is its own peer address.
fn client_address(peer: std::net::SocketAddr, headers: &HeaderMap) -> String {
    client_address_with(peer, headers, selfhost::trusted_proxies())
}

fn client_address_with(
    peer: std::net::SocketAddr,
    headers: &HeaderMap,
    trusted: &selfhost::TrustedProxies,
) -> String {
    let address = if trusted.trusts(peer.ip()) {
        headers
            .get("x-real-ip")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<std::net::IpAddr>().ok())
            .unwrap_or(peer.ip())
    } else {
        peer.ip()
    };
    address.to_string()
}

/// The first half of every browser/native login hop, whichever identity
/// provider answers it: decide the `state`, and remember it where the callback
/// will look (the native map, the Android handshake, or — for the plain
/// browser — the cookie the caller sets). Returns the state to send out.
fn begin_login(
    st: &AppState,
    peer: std::net::SocketAddr,
    params: &HashMap<String, String>,
    headers: &HeaderMap,
) -> Result<String, Response> {
    let native = params
        .get("native")
        .is_some_and(|v| v == "1" || v == "true");
    // An INSTALLED PWA says so at the start of the hop. It is not a native
    // client — it keeps the cookie flow, because a standalone web app has a
    // cookie jar of its own and can perfectly well hold one — it only wants the
    // session length, for exactly the reason the native branch below gives: an
    // icon on a home screen that logs you out every week is not an app.
    //
    // The flag rides in the STATE rather than a second cookie or another map:
    // the state already makes the full round trip through the provider and
    // comes back to be compared against the cookie, so a prefix is carried for
    // free and the comparison is unchanged — both sides see the same string.
    let pwa = params.get("pwa").is_some_and(|v| v == "1" || v == "true");
    let state = if pwa {
        format!("{PWA_STATE_PREFIX}{}", Uuid::new_v4().simple())
    } else {
        Uuid::new_v4().simple().to_string()
    };
    if params.get("android").is_some_and(|v| v == "1") {
        if native || pwa {
            return Err(api_error(
                StatusCode::BAD_REQUEST,
                "conflicting login modes",
            ));
        }
        let challenge = params
            .get("code_challenge")
            .map(String::as_str)
            .unwrap_or("");
        let client_state = params.get("client_state").map(String::as_str).unwrap_or("");
        if let Err(error) = st.android_auth.begin(
            state.clone(),
            challenge,
            client_state,
            &client_address(peer, headers),
        ) {
            return Err(refusal(StatusCode::BAD_REQUEST, error));
        }
    } else if native {
        remember_native_state(st, &state);
    }
    Ok(state)
}

async fn sso_start(
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    Query(params): Query<HashMap<String, String>>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    if st.sso_secret.is_none() {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "HegAI SSO is not configured",
        );
    }
    let state = match begin_login(&st, peer, &params, &headers) {
        Ok(v) => v,
        Err(response) => return response,
    };
    let forwarded_host = headers
        .get("x-forwarded-host")
        .and_then(|v| v.to_str().ok());
    let callback = format!(
        "{}/api/auth/sso/callback",
        // No other names: this login has had no button in the web since
        // 06.10.2026, and the platform's allow-list names only `public_url`'s.
        callback_origin(&st.public_url, &st.public_alt_ports, &[], forwarded_host)
    );
    let location = format!(
        "{}?client=cc-remote&return_to={}&state={}",
        st.sso_authorize_url,
        urlencoding::encode(&callback),
        urlencoding::encode(&state)
    );
    let mut response = StatusCode::FOUND.into_response();
    response
        .headers_mut()
        .insert(header::LOCATION, HeaderValue::from_str(&location).unwrap());
    response.headers_mut().append(
        header::SET_COOKIE,
        set_cookie_header(
            SSO_STATE_COOKIE,
            &state,
            600,
            st.public_url.starts_with("https://"),
        ),
    );
    response
}

/// The second hop's proof that this callback belongs to a login THIS hub began:
/// the native map, the Android handshake, or the browser's state cookie.
/// Shared by every identity provider that comes back through a redirect.
fn check_login_state(
    st: &AppState,
    params: &HashMap<String, String>,
    headers: &HeaderMap,
) -> Result<(String, bool, Option<android_auth::Handshake>), Response> {
    let state = params
        .get("state")
        .map(String::as_str)
        .unwrap_or("")
        .to_string();
    // The browser that finishes a login must be the one that began it, for
    // EVERY mode (pentest 11.11.2026, finding 3). The start hop sets the state
    // cookie in the same auth browser — ASWebAuthenticationSession / the Custom
    // Tab — whether the login is a plain browser one, iOS-native or Android, so
    // a callback link forwarded to someone else's browser has no matching
    // cookie. The hub's own native map / Android handshake only say the state
    // was issued here; they no longer stand in for the cookie.
    //
    // Both halves must be present: with no cookie and no `state` the old
    // `None == None` passed, so a link carrying someone else's valid assertion
    // signed the victim into that account (login CSRF).
    let proven = state_cookie(headers, st.public_url.starts_with("https://"))
        .is_some_and(|c| !state.is_empty() && ct_eq(c.as_bytes(), state.as_bytes()));
    if !proven {
        return Err(api_error(StatusCode::BAD_REQUEST, "invalid SSO state"));
    }
    let native = take_native_state(st, &state);
    let android = st.android_auth.take(&state);
    Ok((state, native, android))
}

/// The last hop: the proven account becomes a session — an Android code, the
/// native app's custom scheme, or the browser cookie. Provider-agnostic.
fn finish_login(
    st: &AppState,
    state: &str,
    native: bool,
    android: Option<android_auth::Handshake>,
    user_id: &str,
    // The `(provider, subject)` that proved this login: the session is minted
    // only while it still opens `user_id` (an unlink or a move may have landed
    // between resolving the login and here).
    identity: Option<(&str, &str)>,
    // The request that completed the login: it may carry the return path a
    // service sign-in left (`RETURN_COOKIE`).
    request: &HeaderMap,
    // `Proven` when this very login already checked a second factor (a local
    // sign-in with its authenticator code). Otherwise a person who needs one
    // gets a PENDING session (mfa.rs) and a native hand-off is held back until
    // `/api/auth/mfa/verify`.
    factor: mfa::Factor,
) -> Response {
    // A phone is not a browser tab: re-authenticating every week through a
    // web sheet is the kind of friction that makes people stop opening the app,
    // so a native session lasts 90 days (and slides forward on use). An
    // installed PWA is the same thing wearing a different coat — it launched
    // from a home-screen icon, not from a tab — and gets the same length. It
    // still proved its state against the cookie above; only the TTL differs.
    let needs_mfa = factor == mfa::Factor::Unproven && st.workspaces.mfa_required(user_id);
    // Android with a second factor owed: no code leaves yet. A browser session
    // (pending, cookie) is minted below, the code is issued bound to it and
    // kept server-side as that session's hand-off.
    let (android, held_android) = if needs_mfa {
        (None, android)
    } else {
        (android, None)
    };
    if let Some(handshake) = android {
        let client_state = handshake.client_state.clone();
        let owned = identity.map(|(p, s)| (p.to_string(), s.to_string()));
        return match st.android_auth.issue_bound(handshake, user_id, owned) {
            Ok(code) => android_redirect(&code, &client_state),
            Err(error) => refusal(StatusCode::SERVICE_UNAVAILABLE, error),
        };
    }
    let pwa = state.starts_with(PWA_STATE_PREFIX);
    let ttl_days = if native || pwa { 90 } else { 7 };
    let (session, pending) = match st
        .workspaces
        .create_auth_session_for_as(identity, user_id, ttl_days, factor)
    {
        Ok(v) => v,
        Err(e) if e == crate::identity::IDENTITY_MOVED => {
            return api_error(
                StatusCode::CONFLICT,
                "Этот способ входа только что отвязали. Войдите снова.",
            )
        }
        Err(e) => return store_failure(e),
    };
    let mut handed_off = false;
    // `needs_mfa` was read before the session existed; what the session really
    // is (`pending`) decides from here. A reset in between must not drop the
    // Android code the app waits for: it gets an ordinary one.
    let held_android = if pending {
        held_android
    } else if let Some(handshake) = held_android {
        st.workspaces.drop_session(&session);
        let client_state = handshake.client_state.clone();
        let owned = identity.map(|(p, s)| (p.to_string(), s.to_string()));
        return match st.android_auth.issue_bound(handshake, user_id, owned) {
            Ok(code) => android_redirect(&code, &client_state),
            Err(error) => refusal(StatusCode::SERVICE_UNAVAILABLE, error),
        };
    } else {
        None
    };
    if pending {
        // The cookie below opens only the code screen. What the app waits for
        // is built HERE (never taken from the client) and held on the session.
        let held = if let Some(handshake) = held_android {
            let client_state = handshake.client_state.clone();
            let owned = identity.map(|(p, s)| (p.to_string(), s.to_string()));
            match st.android_auth.issue_gated(
                handshake,
                user_id,
                owned,
                crate::workspace::hash_token(&session),
            ) {
                Ok(code) => Some(format!(
                    "hegai-code://auth?code={code}&state={client_state}"
                )),
                Err(error) => {
                    st.workspaces.drop_session(&session);
                    return refusal(StatusCode::SERVICE_UNAVAILABLE, error);
                }
            }
        } else if native {
            Some("native".to_string())
        } else {
            None
        };
        if let Some(held) = held {
            if let Err(e) = st.workspaces.set_mfa_next(&session, &held) {
                st.workspaces.drop_session(&session);
                return store_failure(e);
            }
            handed_off = true;
        }
    }
    if native && !handed_off {
        // Hand the session to the app through its custom scheme; nothing is set
        // on this origin, and `ASWebAuthenticationSession` closes on this hop.
        let location = format!(
            "{NATIVE_CALLBACK}?session={}",
            urlencoding::encode(&session)
        );
        let mut response = StatusCode::FOUND.into_response();
        if let Ok(value) = HeaderValue::from_str(&location) {
            response.headers_mut().insert(header::LOCATION, value);
        }
        return response;
    }
    let mut response = StatusCode::FOUND.into_response();
    // Back to where a service sign-in was heading, if it sent the person here
    // (only ever a `/w/…` path of ours — `safe_next` — never another origin).
    let back = cookie_value(request, RETURN_COOKIE)
        .and_then(|v| urlencoding::decode(&v).ok().map(|v| v.into_owned()))
        .filter(|v| v.starts_with("/w/"))
        .map(|v| service_api::safe_next(Some(&v)));
    response.headers_mut().insert(
        header::LOCATION,
        back.as_deref()
            .and_then(|v| HeaderValue::from_str(v).ok())
            .unwrap_or_else(|| HeaderValue::from_static("/")),
    );
    if back.is_some() || cookie_value(request, RETURN_COOKIE).is_some() {
        response.headers_mut().append(
            header::SET_COOKIE,
            set_cookie_header(RETURN_COOKIE, "", 0, st.public_url.starts_with("https://")),
        );
    }
    response.headers_mut().append(
        header::SET_COOKIE,
        set_cookie_header(
            AUTH_COOKIE,
            &session,
            // The COOKIE has to last as long as the session it carries.
            //
            // This was a hardcoded week while `ttl_days` above already said 90
            // for an installed PWA, so the longer session was real in the
            // database and invisible in practice: the browser dropped the
            // cookie on day seven and the app asked for a login the server
            // would have been happy to skip. A desktop shell has the same
            // shape — its own cookie jar, launched from an icon — and would
            // have inherited the same surprise.
            ttl_days * 24 * 60 * 60,
            st.public_url.starts_with("https://"),
        ),
    );
    response.headers_mut().append(
        header::SET_COOKIE,
        set_cookie_header(
            SSO_STATE_COOKIE,
            "",
            0,
            st.public_url.starts_with("https://"),
        ),
    );
    response
}

async fn sso_callback(
    Query(params): Query<HashMap<String, String>>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let Some(secret) = st.sso_secret.as_ref() else {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "HegAI SSO is not configured",
        );
    };
    let Some(token) = params.get("token") else {
        return api_error(StatusCode::BAD_REQUEST, "missing SSO token");
    };
    let (state, native, android) = match check_login_state(&st, &params, &headers) {
        Ok(v) => v,
        Err(response) => return response,
    };
    let claims = match verify_sso_claims(token, secret) {
        Ok(v) => v,
        Err(_) => return api_error(StatusCode::UNAUTHORIZED, "invalid SSO token"),
    };
    let _ = (&claims.exp, &claims.iss, &claims.aud);
    if let Some(jti) = claims.jti.as_deref() {
        let fresh = st
            .sso_jti
            .lock()
            .map(|mut cache| cache.first_use(jti, Instant::now()))
            .unwrap_or(false);
        if !fresh {
            return api_error(StatusCode::UNAUTHORIZED, "invalid SSO token");
        }
    }
    let ensured =
        match st
            .workspaces
            .ensure_user(&claims.user_id, &claims.email, claims.full_name.as_deref())
        {
            Ok(v) => v,
            // Another hub account already holds this address. Refuse in words
            // rather than with the UNIQUE violation this used to surface as (a bare
            // 500): which account is the real one is a question for an admin.
            Err(workspace::EnsureUserError::EmailTaken { email, holder }) => {
                eprintln!(
                    "[auth] SSO for {} refused: {email} already belongs to account {holder}",
                    claims.user_id
                );
                return api_error(
                    StatusCode::CONFLICT,
                    "Этот адрес почты уже привязан к другой учётке Hegai Code. \
                 Напишите администратору — учётки объединяют вручную.",
                );
            }
            // The id exists but is not linked to this HegAI login (unlinked
            // on purpose, or born through another way in).
            Err(workspace::EnsureUserError::Unlinked { user_id }) => {
                eprintln!("[auth] SSO for {user_id} refused: that account is not linked to HegAI");
                return api_error(
                    StatusCode::CONFLICT,
                    "Эта учётка Hegai Code не привязана к входу через HegAI. \
                     Войдите тем способом, которым входили раньше.",
                );
            }
            Err(e) => return store_failure(e.to_string()),
        };
    // The account this login opened. Today it equals the SSO subject for
    // everyone (identity.rs backfill); a linked identity may point elsewhere.
    let user_id = ensured.user_id.as_str();
    // An admin had opened access for this address before anyone signed in
    // with it: the account was born active, and the seat and sandbox it
    // needs are queued here, where the `AppState` lives. Going through the
    // shared hook is also what keeps a privileged or employee account from
    // being handed a sandbox it has no use for.
    if ensured.claimed_preauth {
        println!(
            "[access] preauthorized {} activated at first login",
            claims.email
        );
        access_api::after_activate_hooks(&st, user_id);
    }
    finish_login(
        &st,
        &state,
        native,
        android,
        user_id,
        Some((crate::identity::PROVIDER_HEGAI, claims.user_id.as_str())),
        &headers,
        mfa::Factor::Unproven,
    )
}

/// Case-insensitive header equality, for the `Sec-Fetch-*` navigation hints.
fn header_is(headers: &HeaderMap, name: &str, expected: &str) -> bool {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case(expected))
}

/// The page a sign-in link shows to anything that is not a browser navigation.
///
/// Deliberately dull: no preview metadata, and it never names the account. What
/// unfurls a link pasted into a chat should learn nothing from it and, above
/// all, spend nothing — the button is the only thing that opens the session.
fn signin_link_gate(token: &str) -> Response {
    let href = format!(
        "/api/auth/signin-link?t={}&go=1",
        urlencoding::encode(token)
    );
    let body = format!(
        r#"<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Hegai Code</title>
<style>
  body {{ margin:0; min-height:100vh; display:grid; place-items:center;
          background:#FBFAF7; color:#171716;
          font-family:Onest,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }}
  main {{ max-width:34rem; padding:2rem; }}
  .eyebrow {{ font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:.75rem;
             letter-spacing:.08em; text-transform:uppercase; color:#5B5B57; margin:0 0 .75rem; }}
  .eyebrow::before {{ content:""; display:inline-block; width:8px; height:8px;
                     background:#C2410C; margin-right:.5rem; vertical-align:baseline; }}
  h1 {{ font-size:1.5rem; margin:0 0 .75rem; font-weight:600; }}
  p {{ margin:0 0 1.5rem; line-height:1.55; color:#3D3D3A; }}
  a.btn {{ display:inline-block; background:#06463D; color:#FBFAF7; text-decoration:none;
          padding:.75rem 1.25rem; border-radius:12px; font-weight:500; }}
</style></head>
<body><main>
  <p class="eyebrow">Hegai Code</p>
  <h1>Ссылка для входа</h1>
  <p>Она сработает один раз. До нажатия ссылка цела — так что можно спокойно
     переслать её и открыть, когда будет удобно.</p>
  <a class="btn" href="{href}">Войти</a>
</main></body></html>
"#
    );
    let mut response = (StatusCode::OK, body).into_response();
    let head = response.headers_mut();
    head.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    head.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

/// `GET /api/auth/signin-link?t=<token>` — open a browser session AS the
/// account the link names.
///
/// An operator tool, not a product feature. Root on this box can already mint
/// any session through the SSO secret, so the power is not new; what this route
/// adds is the shape of it. The link is signed with its own secret, spends
/// itself on first use, expires, never targets a platform admin, and leaves an
/// `auth.signin_link` row in that account's own audit trail — so being entered
/// is something the account can see afterwards.
///
/// It replaces the visitor's own cookie on this origin: an operator who wants
/// to keep their own session opens the link in a private window.
async fn auth_signin_link(
    method: Method,
    Query(params): Query<HashMap<String, String>>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let Some(secret) = st.signin_link_secret.as_deref() else {
        return api_error(StatusCode::NOT_FOUND, "sign-in links are not configured");
    };
    let Some(token) = params.get("t") else {
        return api_error(StatusCode::BAD_REQUEST, "missing link token");
    };
    let Some(claims) = verify_signin_link(token, secret) else {
        return api_error(StatusCode::UNAUTHORIZED, "invalid or expired sign-in link");
    };
    let email = claims.sub.trim().to_ascii_lowercase();
    let found = match st
        .workspaces
        .user_ids_by_email(std::slice::from_ref(&email))
    {
        Ok(rows) => rows,
        Err(e) => return store_failure(e),
    };
    let Some((user_id, _)) = found.into_iter().next() else {
        return api_error(StatusCode::NOT_FOUND, "no account with that email");
    };
    // A platform admin is out of scope on purpose: this exists to stand where a
    // member stands, not to borrow the owner's authority.
    if st.platform_admins.contains(&user_id) || st.bootstrap_user_id == user_id {
        return api_error(
            StatusCode::FORBIDDEN,
            "sign-in links do not target platform admins",
        );
    }
    // Only a real navigation may SPEND the link. A one-shot GET is eaten by the
    // first thing that fetches it, and the first thing that fetches a link
    // pasted into a chat is the messenger's preview bot — measured: a bare HEAD
    // gets the 302 and the human who clicks afterwards gets 410. Browsers mark
    // a top-level navigation with `Sec-Fetch-Dest: document`; bots send no
    // Sec-Fetch headers at all, and `go=1` is the way through for a client too
    // old to send them. Anything else gets a page that spends nothing.
    let navigating = method == Method::GET
        && (header_is(&headers, "sec-fetch-dest", "document")
            || params.get("go").is_some_and(|v| v == "1"));
    if !navigating {
        return signin_link_gate(token);
    }
    // Half a day, not the week a browser login gets. Long enough to look around
    // as the member, short enough that a session made this way does not sit
    // around waiting to be interesting — if that account is ever promoted to
    // platform admin, an old link session would pass the admin checks like any
    // other session of theirs.
    let session = match st.workspaces.consume_signin_link(
        &claims.jti,
        &user_id,
        &claims.by,
        SIGNIN_LINK_SESSION_HOURS,
    ) {
        Ok(session) => session,
        Err(e) if e == "already_used" => {
            // Not an audit row (that would let a replayed token write to the
            // trail at will), but a line an operator can find: someone is
            // clicking a link that is already spent.
            println!(
                "[auth] sign-in link for {email} was already used, refused (issued by {})",
                claims.by
            );
            return api_error(StatusCode::GONE, "this sign-in link has already been used");
        }
        Err(e) if e == "no_audit_trail" => {
            return api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "this account has no workspace to record the sign-in in",
            )
        }
        Err(e) => return store_failure(e),
    };
    println!(
        "[auth] sign-in link opened {email} ({user_id}), issued by {}",
        claims.by
    );
    let mut response = StatusCode::FOUND.into_response();
    response
        .headers_mut()
        .insert(header::LOCATION, HeaderValue::from_static("/"));
    // The token is in the URL, so the page we land on must not pass it onward.
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response.headers_mut().append(
        header::SET_COOKIE,
        set_cookie_header(
            AUTH_COOKIE,
            &session,
            SIGNIN_LINK_SESSION_HOURS * 60 * 60,
            st.public_url.starts_with("https://"),
        ),
    );
    response
}

async fn api_devices(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let actor = gate!(authenticated_user(&headers, &st));
    match st.workspaces.devices_for_user(&actor) {
        Ok(v) => Json(json!({"devices":v})).into_response(),
        Err(e) => store_failure(e),
    }
}
async fn api_revoke_device(
    AxumPath(machine_id): AxumPath<String>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let actor = gate!(mutation_user(&headers, &st));
    gate!(require_active(&st, &actor));
    match st.workspaces.revoke_device(&actor, &machine_id) {
        Ok(()) => {
            st.hub.send(HubCmd::RefreshWorkspaceState);
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => refusal(StatusCode::NOT_FOUND, e),
    }
}

/// Undo an accidental revoke. Revoking is one click and, until this existed,
/// had no way back short of editing the database or reinstalling the agent on
/// the machine itself — which is a bad shape for a destructive button.
async fn api_restore_device(
    AxumPath(machine_id): AxumPath<String>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let actor = gate!(mutation_user(&headers, &st));
    gate!(require_active(&st, &actor));
    match st.workspaces.restore_device(&actor, &machine_id) {
        Ok(()) => {
            st.hub.send(HubCmd::RefreshWorkspaceState);
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => refusal(StatusCode::NOT_FOUND, e),
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::{
        backend_requests_in_window, callback_origin, cookie_value, fleet_token_opens_ui,
        same_origin, sign_access_link, sign_signin_link, verify_access_link, verify_signin_link,
        verify_sso_claims, without_bom, SigninLinkClaims, SsoClaims, SsoJtiCache,
        CODEX_GATEWAY_PS1, INSTALL_APP_WINDOWS, INSTALL_WINDOWS, SSO_JTI_TTL,
    };
    use super::{origin_host, ui_origin_allowed, unsafe_public_config};
    use super::{parse_host_list, static_site, StaticSites};
    use std::sync::Arc;

    fn ws_headers(origin: Option<&str>, host: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, host.parse().unwrap());
        if let Some(o) = origin {
            h.insert(header::ORIGIN, o.parse().unwrap());
        }
        h
    }

    #[test]
    fn client_address_believes_x_real_ip_only_from_a_trusted_proxy() {
        use super::client_address_with;
        use crate::selfhost::TrustedProxies;
        let mut h = HeaderMap::new();
        h.insert("x-real-ip", "198.51.100.7".parse().unwrap());
        let peer = |s: &str| s.parse::<std::net::SocketAddr>().unwrap();
        let none = TrustedProxies::parse("");
        let docker = TrustedProxies::parse("172.18.0.0/16");
        // Loopback nginx: as before.
        assert_eq!(
            client_address_with(peer("127.0.0.1:5000"), &h, &none),
            "198.51.100.7"
        );
        // A caddy on the compose network is believed only when listed.
        assert_eq!(
            client_address_with(peer("172.18.0.2:5000"), &h, &none),
            "172.18.0.2"
        );
        assert_eq!(
            client_address_with(peer("172.18.0.2:5000"), &h, &docker),
            "198.51.100.7"
        );
        // Anyone else cannot choose their own address.
        assert_eq!(
            client_address_with(peer("203.0.113.9:5000"), &h, &docker),
            "203.0.113.9"
        );
        // A trusted proxy that sends junk falls back to the peer.
        let mut junk = HeaderMap::new();
        junk.insert("x-real-ip", "not-an-ip".parse().unwrap());
        assert_eq!(
            client_address_with(peer("172.18.0.2:5000"), &junk, &docker),
            "172.18.0.2"
        );
    }

    #[test]
    fn ui_origin_admits_own_site_and_native_clients() {
        let public = "https://code.acme.test";
        let none: Vec<String> = vec![];
        // native client: no Origin at all
        assert!(ui_origin_allowed(
            &ws_headers(None, "code.acme.test"),
            public,
            &none
        ));
        // same host, any spare port
        for o in [
            "https://code.acme.test",
            "https://code.acme.test:8443",
            "https://code.acme.test:2096",
        ] {
            assert!(
                ui_origin_allowed(&ws_headers(Some(o), "code.acme.test"), public, &none),
                "{o}"
            );
        }
        // the other domain serving the same hub matches its own Host
        assert!(ui_origin_allowed(
            &ws_headers(Some("https://claude.acme.test"), "claude.acme.test"),
            public,
            &none
        ));
        // local dev
        assert!(ui_origin_allowed(
            &ws_headers(Some("http://localhost:5173"), "127.0.0.1:4319"),
            "http://127.0.0.1:4319",
            &none
        ));
        // explicit extra
        assert!(ui_origin_allowed(
            &ws_headers(Some("https://app.a.test"), "code.acme.test"),
            public,
            &["app.a.test".to_string()]
        ));
    }

    #[test]
    fn ui_origin_refuses_foreign_pages() {
        let public = "https://code.acme.test";
        let none: Vec<String> = vec![];
        for o in [
            "https://evil.example",
            "https://files.acme.test",
            "https://code.acme.test.evil.example",
            "null",
            "garbage",
        ] {
            assert!(
                !ui_origin_allowed(&ws_headers(Some(o), "code.acme.test"), public, &none),
                "{o}"
            );
        }
    }

    #[test]
    fn origin_host_parses_the_shapes_we_meet() {
        assert_eq!(
            origin_host("https://Code.Acme.test:8443/x?y").as_deref(),
            Some("code.acme.test")
        );
        assert_eq!(origin_host("http://[::1]:5173").as_deref(), Some("::1"));
        assert_eq!(
            origin_host("https://u:p@h.example").as_deref(),
            Some("h.example")
        );
        assert_eq!(origin_host("null"), None);
    }

    #[test]
    fn public_hub_refuses_the_default_token() {
        assert!(unsafe_public_config("dev-token", "https://code.acme.test", "127.0.0.1").is_some());
        assert!(unsafe_public_config("dev-token", "http://127.0.0.1:4319", "0.0.0.0").is_some());
        assert!(unsafe_public_config("dev-token", "http://127.0.0.1:4319", "127.0.0.1").is_none());
        assert!(
            unsafe_public_config("a-real-secret", "https://code.acme.test", "0.0.0.0").is_none()
        );
    }
    use super::{json, StatusCode, Value, WorkspaceStore};
    use axum::http::{header, HeaderMap, HeaderValue};
    use jsonwebtoken::{encode, EncodingKey, Header};
    use std::collections::HashMap;

    /// The fleet token is a machine credential every legacy agent carries.
    /// A sign-in that came in through one of the relay's spare doors returns
    /// to that door; anything else — a foreign name, an unlisted port, no
    /// forwarded host at all — returns to `public_url` as before.
    #[test]
    fn sign_in_returns_to_the_spare_door_it_came_through() {
        let pub_url = "https://code.acme.test/";
        let alt = [2096u16, 8443];
        assert_eq!(
            callback_origin(pub_url, &alt, &[], None),
            "https://code.acme.test"
        );
        assert_eq!(
            callback_origin(pub_url, &alt, &[], Some("code.acme.test")),
            "https://code.acme.test"
        );
        assert_eq!(
            callback_origin(pub_url, &alt, &[], Some("code.acme.test:8443")),
            "https://code.acme.test:8443"
        );
        assert_eq!(
            callback_origin(pub_url, &alt, &[], Some("CODE.acme.test:2096")),
            "https://code.acme.test:2096"
        );
        // An unlisted port and a forged name both fall back — the header is
        // the client's word, and only the port may be taken from it.
        assert_eq!(
            callback_origin(pub_url, &alt, &[], Some("code.acme.test:9443")),
            "https://code.acme.test"
        );
        assert_eq!(
            callback_origin(pub_url, &alt, &[], Some("evil.example:8443")),
            "https://code.acme.test"
        );
        assert_eq!(
            callback_origin(pub_url, &[], &[], Some("code.acme.test:8443")),
            "https://code.acme.test"
        );
        // A dev hub named with a port keeps working on its own port.
        assert_eq!(
            callback_origin(
                "http://127.0.0.1:4319",
                &[4320],
                &[],
                Some("127.0.0.1:4320")
            ),
            "http://127.0.0.1:4320"
        );
        assert_eq!(
            callback_origin(
                "http://127.0.0.1:4319",
                &[4320],
                &[],
                Some("127.0.0.1:4319")
            ),
            "http://127.0.0.1:4319"
        );
    }

    /// A sign-in begun on the light shell's name returns to that name — in our
    /// spelling, never the header's — and to nowhere the list does not name.
    #[test]
    fn sign_in_returns_to_the_listed_name_it_came_through() {
        let pub_url = "https://code.acme.test";
        let alt = [2096u16, 8443];
        let hosts = vec!["remote.acme.test".to_string()];
        assert_eq!(
            callback_origin(pub_url, &alt, &hosts, Some("remote.acme.test")),
            "https://remote.acme.test"
        );
        assert_eq!(
            callback_origin(pub_url, &alt, &hosts, Some("REMOTE.Acme.test:8443")),
            "https://remote.acme.test:8443"
        );
        // An unlisted port is dropped, the listed name stays: the state cookie
        // lives on that name, and `public_url` would not find it.
        assert_eq!(
            callback_origin(pub_url, &alt, &hosts, Some("remote.acme.test:9443")),
            "https://remote.acme.test"
        );
        // The public name is untouched by the list.
        assert_eq!(
            callback_origin(pub_url, &alt, &hosts, Some("code.acme.test:2096")),
            "https://code.acme.test:2096"
        );
        // A name on nobody's list, and a listed name glued to a foreign one.
        for forged in [
            "evil.example",
            "remote.acme.test.evil.example",
            "evil.example/remote.acme.test",
            "remote.acme.test@evil.example",
        ] {
            assert_eq!(
                callback_origin(pub_url, &alt, &hosts, Some(forged)),
                "https://code.acme.test",
                "{forged}"
            );
        }
        // Without the list the name is a stranger, as before.
        assert_eq!(
            callback_origin(pub_url, &alt, &[], Some("remote.acme.test")),
            "https://code.acme.test"
        );
        // A dev hub: the light name on the hub's own port.
        assert_eq!(
            callback_origin(
                "http://127.0.0.1:4319",
                &[],
                &["lite.localhost".to_string()],
                Some("lite.localhost:4319")
            ),
            "http://lite.localhost:4319"
        );
    }

    #[test]
    fn lite_host_list_is_bare_lowercase_names() {
        assert_eq!(
            parse_host_list(
                " Remote.Acme.test , https://lite.example:8443/x ,, lite.localhost:4319 "
            ),
            vec!["remote.acme.test", "lite.example", "lite.localhost"]
        );
        assert!(parse_host_list("").is_empty());
    }

    fn site_dir(marker: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ccr-site-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("index.html"), format!("<html>{marker}</html>")).unwrap();
        std::fs::write(dir.join("assets").join(format!("{marker}.js")), marker).unwrap();
        dir
    }

    async fn fetch(sites: &StaticSites, host: &str, path: &str) -> (u16, String, String) {
        let req = axum::http::Request::builder()
            .uri(path)
            .header(header::HOST, host)
            .body(axum::body::Body::empty())
            .unwrap();
        let res = sites.clone().serve(req).await;
        let status = res.status().as_u16();
        let cache = res
            .headers()
            .get(header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        let body = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        (status, cache, String::from_utf8_lossy(&body).into_owned())
    }

    /// Each name gets its own shell, its own assets, and its own misses.
    #[tokio::test]
    async fn the_host_picks_the_shell() {
        let (full, lite) = (site_dir("full"), site_dir("lite"));
        let sites = StaticSites {
            full: static_site(full.to_str().unwrap()),
            lite: Some(static_site(lite.to_str().unwrap())),
            lite_hosts: Arc::new(vec!["remote.acme.test".to_string()]),
        };
        for (host, marker, other) in [
            ("code.acme.test", "full", "lite"),
            ("remote.acme.test", "lite", "full"),
            ("REMOTE.acme.test:8443", "lite", "full"),
            ("anything.example", "full", "lite"),
        ] {
            let (status, _, body) = fetch(&sites, host, "/").await;
            assert_eq!((status, body.contains(marker)), (200, true), "{host} /");
            // A deep link is the same document.
            let (status, _, body) = fetch(&sites, host, "/w/s/m1/abc").await;
            assert_eq!((status, body.contains(marker)), (200, true), "{host} deep");
            let (status, cache, body) = fetch(&sites, host, &format!("/assets/{marker}.js")).await;
            assert_eq!((status, body.as_str()), (200, marker), "{host} own asset");
            assert!(cache.contains("immutable"), "{host}: {cache}");
            // The other shell's chunk is a miss here, not index.html.
            let (status, cache, _) = fetch(&sites, host, &format!("/assets/{other}.js")).await;
            assert_eq!(
                (status, cache.as_str()),
                (404, "no-store"),
                "{host} foreign asset"
            );
        }
        let _ = std::fs::remove_dir_all(full);
        let _ = std::fs::remove_dir_all(lite);
    }

    /// The shell may not be framed, and the policy stays narrow enough not to
    /// break the inline theme script or remote account photos.
    #[tokio::test]
    async fn the_shell_refuses_to_be_framed() {
        let full = site_dir("full");
        let sites = StaticSites {
            full: static_site(full.to_str().unwrap()),
            lite: None,
            lite_hosts: Arc::new(Vec::new()),
        };
        for path in ["/", "/w/s/m1/abc", "/assets/full.js"] {
            let req = axum::http::Request::builder()
                .uri(path)
                .header(header::HOST, "code.acme.test")
                .body(axum::body::Body::empty())
                .unwrap();
            let res = sites.clone().serve(req).await;
            let csp = res
                .headers()
                .get(header::CONTENT_SECURITY_POLICY)
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_string();
            assert!(csp.contains("frame-ancestors 'none'"), "{path}: {csp}");
            assert!(
                !csp.contains("script-src") && !csp.contains("img-src"),
                "{path}: {csp}"
            );
        }
        let _ = std::fs::remove_dir_all(full);
    }

    /// A listed name with no light build is refused, never handed the full
    /// shell (and its service worker).
    #[tokio::test]
    async fn a_listed_host_without_a_build_is_refused() {
        let full = site_dir("full");
        let sites = StaticSites {
            full: static_site(full.to_str().unwrap()),
            lite: None,
            lite_hosts: Arc::new(vec!["remote.acme.test".to_string()]),
        };
        let (status, cache, body) = fetch(&sites, "remote.acme.test", "/").await;
        assert_eq!((status, cache.as_str()), (503, "no-store"));
        assert!(!body.contains("full"));
        let (status, _, _) = fetch(&sites, "remote.acme.test", "/assets/full.js").await;
        assert_eq!(status, 503);
        let (status, _, body) = fetch(&sites, "code.acme.test", "/").await;
        assert_eq!((status, body.contains("full")), (200, true));
        let _ = std::fs::remove_dir_all(full);
    }

    /// On a production hub (a real token) it must not open `/ui` as the
    /// owner unless the operator opts in explicitly.
    #[test]
    fn fleet_token_no_longer_opens_ui_in_production() {
        assert!(
            fleet_token_opens_ui("dev-token", false),
            "a dev hub keeps the smoke CLIs working"
        );
        assert!(!fleet_token_opens_ui("a-real-production-token", false));
        assert!(
            fleet_token_opens_ui("a-real-production-token", true),
            "CC_REMOTE_FLEET_UI=1 is the explicit escape"
        );
    }

    #[test]
    fn the_backend_spec_cap_counts_a_rolling_day_per_machine() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let day = 24 * 60 * 60 * 1000;
        let mut log: HashMap<String, Vec<i64>> = HashMap::new();
        log.insert(
            "sandbox".into(),
            vec![now - 2 * day, now - day - 1000, now - 60_000, now - 1000],
        );
        log.insert("other".into(), vec![now - 1000]);

        assert_eq!(
            backend_requests_in_window(&mut log, "sandbox"),
            2,
            "only filings inside the last 24h count — the cap is rolling, not a calendar day",
        );
        assert_eq!(
            log["sandbox"].len(),
            2,
            "expired entries are dropped as they are counted, so the map cannot grow forever",
        );
        assert_eq!(
            backend_requests_in_window(&mut log, "other"),
            1,
            "one machine's filings never count against another's allowance",
        );
        assert_eq!(
            backend_requests_in_window(&mut log, "never-filed"),
            0,
            "a machine that has never filed starts with a full allowance",
        );
    }

    /// A sign-in link opens an account, so every part of it has to hold: the
    /// secret, the audience that keeps it apart from an access link, and the
    /// expiry. A token that survives any of those being wrong is a standing
    /// key to somebody's workspace.
    #[test]
    fn a_signin_link_holds_only_with_its_own_secret_audience_and_window() {
        let secret = "signin-secret-0123456789-0123456789";
        let token = sign_signin_link("Member@Example.com", "ops", 900, secret).unwrap();
        let claims = verify_signin_link(&token, secret).expect("round-trips");
        assert_eq!(
            claims.sub, "member@example.com",
            "the email is normalised at signing"
        );
        assert_eq!(claims.by, "ops");
        assert!(!claims.jti.is_empty(), "the one-shot needs an id to spend");

        assert!(verify_signin_link(&token, "another-secret-0123456789-01234567").is_none());
        // An access link is signed with a different audience; even the same
        // secret must not let one stand in for the other.
        let access = sign_access_link("member@example.com", secret).unwrap();
        assert!(verify_signin_link(&access, secret).is_none());
        assert!(verify_access_link(&token, secret).is_none());
        // A lapsed link is just invalid — signed by hand so the past `exp` is
        // unambiguous rather than a race with the clock.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let stale = encode(
            &Header::default(),
            &SigninLinkClaims {
                sub: "member@example.com".into(),
                by: "ops".into(),
                jti: "jti".into(),
                iss: "cc-remote-ops".into(),
                aud: "cc-remote-signin".into(),
                iat: (now - 60) as usize,
                exp: (now - 30) as usize,
            },
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .unwrap();
        assert!(verify_signin_link(&stale, secret).is_none());
    }

    /// Two clicks on one link must not make two sessions — the second is
    /// refused even though the token itself is still inside its window.
    #[test]
    fn a_signin_link_is_spent_by_its_first_use() {
        let store = crate::workspace::WorkspaceStore::open_memory();
        store
            .ensure_user("u1", "member@example.com", Some("Member"))
            .unwrap();
        let session = store.consume_signin_link("jti-1", "u1", "ops", 12).unwrap();
        assert_eq!(
            store
                .authenticate(&session)
                .unwrap()
                .map(|(u, _)| u)
                .as_deref(),
            Some("u1")
        );
        assert_eq!(
            store
                .consume_signin_link("jti-1", "u1", "ops", 12)
                .unwrap_err(),
            "already_used"
        );
        // A different link for the same person still works.
        assert!(store.consume_signin_link("jti-2", "u1", "ops", 12).is_ok());
        // Entering the account and recording it are one write: two uses, two rows.
        let traces: i64 = store
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM audit_events WHERE action='auth.signin_link' AND target_id='u1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            traces, 2,
            "every session a link mints carries its own audit row"
        );
    }

    #[test]
    fn signin_link_session_does_not_slide_and_link_lifetime_is_capped() {
        let store = WorkspaceStore::open_memory();
        store.ensure_user("u1", "u1@x", None).unwrap();
        let session = store.consume_signin_link("jti-s", "u1", "ops", 12).unwrap();
        let hash = crate::workspace::hash_token(&session);
        // Eleven hours in: well past halfway, where an ordinary session slides.
        let now = crate::workspace::now_ms();
        let hour = 60 * 60 * 1000_i64;
        let expiry_then = now + hour;
        store
            .conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE auth_sessions SET created_at=?2, expires_at=?3 WHERE token_hash=?1",
                rusqlite::params![hash, now - 11 * hour, expiry_then],
            )
            .unwrap();
        assert!(store.authenticate(&session).unwrap().is_some());
        let after: i64 = store
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT expires_at FROM auth_sessions WHERE token_hash=?1",
                rusqlite::params![hash],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(after, expiry_then, "a link session ends at its 12 h");

        // The link itself: a day is fine, a week is refused.
        let secret = "01234567890123456789012345678901";
        let day = sign_signin_link("a@x", "ops", 23 * 60 * 60, secret).unwrap();
        assert!(verify_signin_link(&day, secret).is_some());
        let week = sign_signin_link("a@x", "ops", 7 * 24 * 60 * 60, secret).unwrap();
        assert!(verify_signin_link(&week, secret).is_none());
        // `iat` is mandatory and honest: an old link without one, one issued in
        // the future, and one whose exp-iat is over a day all stop working.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let hand = |iat: Option<u64>, exp: u64| {
            let mut c = serde_json::json!({
                "sub": "a@x", "by": "ops", "jti": "j", "iss": crate::SIGNIN_LINK_ISSUER,
                "aud": crate::SIGNIN_LINK_AUDIENCE, "exp": exp,
            });
            if let Some(iat) = iat {
                c["iat"] = serde_json::json!(iat);
            }
            encode(
                &Header::default(),
                &c,
                &EncodingKey::from_secret(secret.as_bytes()),
            )
            .unwrap()
        };
        assert!(verify_signin_link(&hand(Some(now), now + 600), secret).is_some());
        assert!(verify_signin_link(&hand(None, now + 600), secret).is_none());
        assert!(verify_signin_link(&hand(Some(now + 3600), now + 7200), secret).is_none());
        assert!(verify_signin_link(&hand(Some(now - 100_000), now + 600), secret).is_none());
    }

    #[test]
    fn sso_jti_is_single_use_and_leeway_is_short() {
        let secret = "01234567890123456789012345678901";
        let now_s = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let mint = |exp: u64, jti: Option<&str>| {
            let claims = SsoClaims {
                user_id: "u1".into(),
                email: "u@example.com".into(),
                full_name: None,
                exp: exp as usize,
                iss: "acme.test".into(),
                aud: "cc-remote".into(),
                jti: jti.map(str::to_string),
            };
            encode(
                &Header::default(),
                &claims,
                &EncodingKey::from_secret(secret.as_bytes()),
            )
            .unwrap()
        };
        // 30 s past expiry: the old 60 s default leeway accepted this.
        assert!(verify_sso_claims(&mint(now_s - 30, None), secret).is_err());
        // A token without jti (acme.test today) still verifies.
        let plain = verify_sso_claims(&mint(now_s + 60, None), secret).unwrap();
        assert!(plain.jti.is_none());
        let with = verify_sso_claims(&mint(now_s + 60, Some("abc")), secret).unwrap();
        assert_eq!(with.jti.as_deref(), Some("abc"));
        // The cache: first use passes, replay is refused, expiry forgets.
        let mut cache = SsoJtiCache::default();
        let t0 = Instant::now();
        assert!(cache.first_use("abc", t0));
        assert!(!cache.first_use("abc", t0 + Duration::from_secs(60)));
        assert!(cache.first_use("other", t0 + Duration::from_secs(60)));
        assert!(cache.first_use("abc", t0 + SSO_JTI_TTL + Duration::from_secs(1)));
    }

    #[test]
    fn sso_requires_expected_audience_issuer_and_cookie_state() {
        let secret = "01234567890123456789012345678901";
        let claims = SsoClaims {
            user_id: "u1".into(),
            email: "u@example.com".into(),
            full_name: Some("User".into()),
            exp: (std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs()
                + 60) as usize,
            iss: "acme.test".into(),
            aud: "cc-remote".into(),
            jti: None,
        };
        let token = encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .unwrap();
        assert_eq!(verify_sso_claims(&token, secret).unwrap().user_id, "u1");
        assert!(verify_sso_claims(&token, "wrong-secret-wrong-secret-wrong!!").is_err());
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("other=x; cc-remote-sso-state=state-1"),
        );
        assert_eq!(
            cookie_value(&headers, "cc-remote-sso-state").as_deref(),
            Some("state-1")
        );
    }

    #[test]
    fn access_links_round_trip_and_reject_foreign_tokens() {
        let secret = "01234567890123456789012345678901";
        let token = sign_access_link("User01@Acme.test", secret).unwrap();
        // Signing normalizes, because the upstream key is named `hegai:<lowercased>`.
        assert_eq!(
            verify_access_link(&token, secret).as_deref(),
            Some("user01@acme.test")
        );
        assert!(verify_access_link(&token, "wrong-secret-wrong-secret-wrong!!").is_none());
        assert!(verify_access_link("not-a-jwt", secret).is_none());

        // An SSO token must not open an access link even on a shared secret: the
        // audience is what keeps the two credential families apart.
        let sso = SsoClaims {
            user_id: "u1".into(),
            email: "u@example.com".into(),
            full_name: None,
            exp: (std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs()
                + 60) as usize,
            iss: "acme.test".into(),
            aud: "cc-remote".into(),
            jti: None,
        };
        let sso_token = encode(
            &Header::default(),
            &sso,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .unwrap();
        assert!(verify_access_link(&sso_token, secret).is_none());
    }

    #[test]
    fn access_links_are_accepted_without_an_expiry() {
        // jsonwebtoken requires `exp` by default; these tokens deliberately carry
        // none, so a regression in the Validation setup would reject every link.
        let secret = "01234567890123456789012345678901";
        let token = sign_access_link("user02@acme.test", secret).unwrap();
        let payload = token.split('.').nth(1).expect("jwt payload segment");
        assert!(!payload.is_empty());
        assert!(verify_access_link(&token, secret).is_some());
    }

    #[test]
    fn browser_mutations_reject_cross_site_requests() {
        let mut headers = HeaderMap::new();
        headers.insert("sec-fetch-site", HeaderValue::from_static("cross-site"));
        assert!(!same_origin(&headers));
        headers.insert("sec-fetch-site", HeaderValue::from_static("same-origin"));
        assert!(same_origin(&headers));
    }

    /// A sandbox preview on `preview-sb1.acme.test` is same-SITE with
    /// `code.acme.test` and the session cookie is Lax: same-site is only
    /// trusted when Origin is the very host the request went to.
    #[test]
    fn same_site_subdomains_cannot_mutate_with_the_cookie() {
        let h = |pairs: &[(&'static str, &'static str)]| {
            let mut m = HeaderMap::new();
            for (k, v) in pairs {
                m.insert(*k, HeaderValue::from_static(v));
            }
            m
        };
        // preview page → hub
        assert!(!same_origin(&h(&[
            ("sec-fetch-site", "same-site"),
            ("origin", "https://preview-sb1.acme.test"),
            ("host", "code.acme.test"),
        ])));
        // same-site without Origin: not provable, refused
        assert!(!same_origin(&h(&[
            ("sec-fetch-site", "same-site"),
            ("host", "code.acme.test")
        ])));
        // spare door: same host, other port
        assert!(same_origin(&h(&[
            ("sec-fetch-site", "same-site"),
            ("origin", "https://code.acme.test:8443"),
            ("host", "code.acme.test"),
        ])));
        // old browser without Sec-Fetch-Site but with a foreign Origin
        assert!(!same_origin(&h(&[
            ("origin", "https://preview-sb1.acme.test"),
            ("host", "code.acme.test")
        ])));
        assert!(same_origin(&h(&[
            ("origin", "https://code.acme.test"),
            ("host", "code.acme.test")
        ])));
        // native client: neither header
        assert!(same_origin(&h(&[("host", "code.acme.test")])));
        // a typed URL / bookmark
        assert!(same_origin(&h(&[("sec-fetch-site", "none")])));
        // unknown value
        assert!(!same_origin(&h(&[("sec-fetch-site", "weird")])));
    }

    /// Both halves of the PowerShell encoding trap, which cost a silently
    /// unrunnable installer once already.
    ///
    /// On disk the Russian-language scripts MUST keep a UTF-8 BOM, or Windows
    /// PowerShell 5.1 reads them as cp1251 and the bytes of `Б В Г Д ё` become
    /// quote characters that break the parse. On the wire they MUST NOT have
    /// one, because the published install line is `irm … | iex` and `iex`
    /// rejects a leading U+FEFF.
    #[test]
    fn russian_ps1_assets_keep_their_bom_on_disk_but_never_on_the_wire() {
        for (name, raw) in [
            ("install-app-win.ps1", INSTALL_APP_WINDOWS),
            ("codex-gateway.ps1", CODEX_GATEWAY_PS1),
        ] {
            assert!(
                raw.starts_with('\u{feff}'),
                "{name} lost its UTF-8 BOM; a saved copy run with -File will not parse under Windows PowerShell 5.1"
            );
            assert!(
                !without_bom(raw).starts_with('\u{feff}'),
                "{name} would be served with a BOM, and `iex` chokes on it"
            );
            // The dangerous letters are exactly why the BOM is required; if the
            // text ever became ASCII-only the BOM could go, but until then this
            // documents the reason next to the assertion.
            assert!(
                raw.chars().any(|c| matches!(c, 'Б' | 'В' | 'Г' | 'Д' | 'ё')),
                "{name} no longer contains the cp1251-dangerous letters — re-check whether the BOM is still needed"
            );
        }
    }

    /// The ASCII-only installers are the ones people run with `-File`, and they
    /// stay ASCII precisely so no decoding can break them.
    #[test]
    fn file_run_installers_stay_ascii() {
        // One installer today; keep the (name, raw) shape so a second one is a
        // one-line addition — clippy objects to a loop over a single element.
        let installers = [("install-win.ps1", INSTALL_WINDOWS)];
        for (name, raw) in installers {
            assert!(
                raw.is_ascii(),
                "{name} gained a non-ASCII character; under Windows PowerShell 5.1 a BOM-less \
                 script is decoded as the system ANSI codepage and some of those bytes parse as \
                 string terminators. Keep it ASCII, or give it a BOM and serve it through without_bom()."
            );
        }
    }

    /// One answer from a device handler: status plus the JSON body, if any.
    async fn device_call(
        st: &super::AppState,
        token: &str,
        restore: bool,
        machine_id: &str,
    ) -> (StatusCode, Value) {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
        let path = axum::extract::Path(machine_id.to_string());
        let state = axum::extract::State(st.clone());
        let res = if restore {
            super::api_restore_device(path, state, headers).await
        } else {
            super::api_revoke_device(path, state, headers).await
        };
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 16)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// Revoking and restoring a device act on credentials, so they sit behind
    /// `require_active` like every other mutation: a suspended account cannot
    /// touch the hub at all, and an active one still can.
    #[tokio::test]
    async fn device_revoke_and_restore_require_an_active_account() {
        use crate::account::tests::{app_state, cleanup, temp_db};
        let store = WorkspaceStore::open_memory();
        // `owner` is the bootstrap user in `app_state`; the gate waves it
        // through, so the account under test is somebody else.
        store
            .ensure_user("owner", "owner@example.com", None)
            .unwrap();
        store.ensure_user("anna", "anna@example.com", None).unwrap();
        store.activate_access("anna", "tests").unwrap();
        store
            .register_legacy_device(
                "anna",
                &json!({"machineId":"m","name":"M","os":"linux","agentVersion":"1"}),
            )
            .unwrap();
        let token = store.create_auth_session("anna", 30).unwrap();
        let db = temp_db();
        let st = app_state(store.clone(), &db);

        // Active: revoke works.
        let (status, _) = device_call(&st, &token, false, "m").await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert!(store.device_revoked("m").unwrap());

        // Suspended: restore is refused and the device stays revoked.
        store
            .suspend_access("anna", "tests", Some("abuse"))
            .unwrap();
        let (status, body) = device_call(&st, &token, true, "m").await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(body["error"], "access_not_active");
        assert_eq!(body["state"], "suspended");
        assert!(store.device_revoked("m").unwrap());

        // Suspended: revoke is refused and a live device stays live.
        store.restore_device("anna", "m").unwrap();
        let (status, body) = device_call(&st, &token, false, "m").await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(body["error"], "access_not_active");
        assert!(!store.device_revoked("m").unwrap());
        cleanup(&db);
    }
}

/// The 302 that hands an Android one-use code to the app.
fn android_redirect(code: &str, client_state: &str) -> Response {
    let location = format!("hegai-code://auth?code={code}&state={client_state}");
    let mut response = StatusCode::FOUND.into_response();
    response
        .headers_mut()
        .insert(header::LOCATION, HeaderValue::from_str(&location).unwrap());
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    response
}

/// What a path with no browser (a native Telegram poll, Apple's exchange, an
/// Android code issued before the person enrolled) answers instead of handing
/// out a session that could open nothing.
pub(crate) fn mfa_browser_required_code() -> &'static str {
    "mfa_browser_required"
}

pub(crate) fn mfa_browser_required() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({
            "error": "mfa_browser_required",
            "message": "Включена двухфакторная защита — войдите через браузер",
        })),
    )
        .into_response()
}

#[derive(Deserialize)]
struct AndroidExchange {
    code: String,
    code_verifier: String,
}
async fn android_exchange(
    State(st): State<AppState>,
    Json(body): Json<AndroidExchange>,
) -> Response {
    // A code issued while a second factor was still owed is released only once
    // the browser session it waits for has passed `/api/auth/mfa/verify`.
    let Some(done) =
        st.android_auth
            .exchange_released(&body.code, &body.code_verifier, |gate, user| {
                st.workspaces.session_satisfied_for(gate, user)
            })
    else {
        return api_error(
            StatusCode::UNAUTHORIZED,
            "invalid or expired Android sign-in code",
        );
    };
    let (user_id, identity) = (done.user_id, done.identity);
    // The browser session the code waited for would otherwise stay in the
    // system browser (a satisfied week-long cookie nobody needs): end it.
    if let Some(gate) = &done.gate {
        st.workspaces.drop_session_hash(gate);
    }
    let bound = identity.as_ref().map(|(p, s)| (p.as_str(), s.as_str()));
    let factor = if done.gated {
        mfa::Factor::Proven
    } else {
        mfa::Factor::Unproven
    };
    let token = match st
        .workspaces
        .create_auth_session_for_as(bound, &user_id, 90, factor)
    {
        // The person turned a second factor on after the code was issued: the
        // app has no browser here to ask for it, so no pending token goes out.
        Ok((token, true)) => {
            st.workspaces.drop_session(&token);
            return mfa_browser_required();
        }
        Ok((token, false)) => token,
        Err(error) if error == crate::identity::IDENTITY_MOVED => {
            return refusal(StatusCode::CONFLICT, error)
        }
        Err(error) => return store_failure(error),
    };
    let mut response = Json(json!({"session": token})).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
