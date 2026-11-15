//! Sign in with GitHub: a GitHub App's user authorization (OAuth web flow +
//! PKCE), finished on the hub through the same redirect and the same callback
//! plumbing as Google (`/api/auth/github/{start,callback}`; `begin_login`,
//! `check_login_state`, `finish_login` in main.rs).
//!
//! WHO the person is: the numeric GitHub user id, nothing else. A known
//! `('github', id)` opens its account; an unknown one is born as `gh-<uuid>`
//! with NO address — a GitHub e-mail is never trusted to link to, or vouch
//! for, anybody (the person types nothing we can verify there) — and waits on
//! the waitlist for an admin. The user's access token is used once, for
//! `GET /user`, and dropped.
//!
//! What GitHub says about the person (login, name, age of the account, repos,
//! followers, bio) goes to `github_profiles`, refreshed on every login: the
//! admin deciding on a waitlisted person reads it next to their registration
//! answers. It is information for a human, not an authority.
use super::*;
use rusqlite::{params, Connection};

use crate::workspace::{db_err, insert_audit, opaque_token, EnsuredUser};

pub(crate) const PROVIDER_GITHUB: &str = "github";

const WEB_BASE: &str = "https://github.com";
const API_BASE: &str = "https://api.github.com";
const PENDING_TTL: Duration = Duration::from_secs(600);
const MAX_PENDING: usize = 512;
/// One address cannot hold more than this many unfinished logins.
const MAX_PENDING_PER_SOURCE: usize = 20;
/// Sign-in starts per address per hour (the /64 for IPv6), like Telegram's.
const STARTS_PER_HOUR: usize = 30;

pub(crate) struct GithubAuth {
    client_id: String,
    client_secret: String,
    http: reqwest::Client,
    /// `https://github.com` / `https://api.github.com`; only tests point them
    /// at a fake.
    web_base: String,
    api_base: String,
    pending: Mutex<HashMap<String, Pending>>,
    limit: Semaphore,
}

struct Pending {
    source: String,
    verifier: String,
    redirect_uri: String,
    created: Instant,
}

/// What `GET /user` tells us. Everything but `id` and `login` is decoration.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct GithubUser {
    pub id: i64,
    pub login: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub public_repos: Option<i64>,
    #[serde(default)]
    pub followers: Option<i64>,
    #[serde(default)]
    pub bio: Option<String>,
    #[serde(default)]
    pub blog: Option<String>,
    #[serde(default)]
    pub company: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    #[serde(default)]
    access_token: Option<String>,
}

/// A GitHub login name: ASCII letters, digits and single hyphens, at most 39.
/// It ends up in a URL path (`/repos/…/collaborators/{login}`), so anything
/// else is refused rather than escaped.
pub(crate) fn valid_login(login: &str) -> bool {
    !login.is_empty()
        && login.len() <= 39
        && login.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn cut(value: &Option<String>, max: usize) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.chars().take(max).collect())
}

impl GithubAuth {
    /// `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET`, both or neither.
    pub fn from_env() -> Result<Option<Arc<Self>>, &'static str> {
        let id = std::env::var("GITHUB_CLIENT_ID")
            .ok()
            .filter(|v| !v.is_empty());
        let secret = std::env::var("GITHUB_CLIENT_SECRET")
            .ok()
            .filter(|v| !v.is_empty());
        let (client_id, client_secret) = match (id, secret) {
            (None, None) => return Ok(None),
            (Some(i), Some(s)) => (i, s),
            _ => return Err("incomplete GitHub sign-in configuration"),
        };
        Ok(Some(Arc::new(Self::new(
            client_id,
            client_secret,
            WEB_BASE.into(),
            API_BASE.into(),
        )?)))
    }

    fn new(
        client_id: String,
        client_secret: String,
        web_base: String,
        api_base: String,
    ) -> Result<Self, &'static str> {
        Ok(Self {
            client_id,
            client_secret,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "GitHub HTTP configuration")?,
            web_base,
            api_base,
            pending: Mutex::new(HashMap::new()),
            limit: Semaphore::new(8),
        })
    }

    /// Remember what the callback must prove, keyed by the login's `state`
    /// (one use), and build the URL that sends the person to GitHub.
    fn begin(&self, state: &str, redirect_uri: &str, source: &str) -> Result<String, &'static str> {
        // Counted per address (an IPv6 one as its /64), not per spelling.
        let source =
            crate::rate_window::rate_ip(Some(source)).unwrap_or_else(|| source.to_string());
        let verifier = format!("{}{}", opaque_token(), opaque_token());
        let challenge = crate::google_login::pkce_challenge(&verifier);
        {
            let mut values = self.pending.lock().map_err(|_| "sign-in unavailable")?;
            values.retain(|_, p| p.created.elapsed() < PENDING_TTL);
            if values.values().filter(|p| p.source == source).count() >= MAX_PENDING_PER_SOURCE {
                return Err("sign-in busy, try later");
            }
            // A full table must not lock everybody out: the oldest unfinished
            // login of ANOTHER address makes room.
            if values.len() >= MAX_PENDING {
                let oldest = values
                    .iter()
                    .filter(|(_, p)| p.source != source)
                    .min_by_key(|(_, p)| p.created)
                    .map(|(k, _)| k.clone());
                match oldest {
                    Some(key) => {
                        values.remove(&key);
                    }
                    None => return Err("sign-in busy, try later"),
                }
            }
            values.insert(
                state.to_string(),
                Pending {
                    source,
                    verifier,
                    redirect_uri: redirect_uri.to_string(),
                    created: Instant::now(),
                },
            );
        }
        Ok(format!(
            "{}/login/oauth/authorize?client_id={}&redirect_uri={}&state={}\
             &code_challenge={}&code_challenge_method=S256&allow_signup=true",
            self.web_base,
            urlencoding::encode(&self.client_id),
            urlencoding::encode(redirect_uri),
            urlencoding::encode(state),
            urlencoding::encode(&challenge),
        ))
    }

    fn take(&self, state: &str) -> Option<Pending> {
        let mut values = self.pending.lock().ok()?;
        values.retain(|_, p| p.created.elapsed() < PENDING_TTL);
        values.remove(state)
    }

    /// Spend the code at GitHub, read who it belongs to, and forget the token.
    async fn exchange(&self, code: &str, pending: &Pending) -> Result<GithubUser, &'static str> {
        let response = self
            .http
            .post(format!("{}/login/oauth/access_token", self.web_base))
            .header(header::ACCEPT, "application/json")
            .form(&[
                ("client_id", self.client_id.as_str()),
                ("client_secret", self.client_secret.as_str()),
                ("code", code),
                ("redirect_uri", pending.redirect_uri.as_str()),
                ("code_verifier", pending.verifier.as_str()),
            ])
            .send()
            .await
            .map_err(|_| "GitHub is unavailable")?;
        if !response.status().is_success() {
            return Err("GitHub refused the sign-in code");
        }
        // GitHub answers 200 with `{"error": …}` for a bad code.
        let token = response
            .json::<TokenResponse>()
            .await
            .map_err(|_| "GitHub answered unexpectedly")?
            .access_token
            .filter(|t| !t.is_empty())
            .ok_or("GitHub refused the sign-in code")?;
        let response = self
            .http
            .get(format!("{}/user", self.api_base))
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::ACCEPT, "application/vnd.github+json")
            .header(header::USER_AGENT, "hegai-code-hub")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send()
            .await
            .map_err(|_| "GitHub is unavailable")?;
        if !response.status().is_success() {
            return Err("GitHub did not tell who this is");
        }
        let user = response
            .json::<GithubUser>()
            .await
            .map_err(|_| "GitHub answered unexpectedly")?;
        if user.id <= 0 || !valid_login(&user.login) {
            return Err("GitHub answered unexpectedly");
        }
        Ok(user)
    }
}

/// `GET /api/auth/github/start` — the same query as the other redirect
/// logins (`native`, `pwa`, `android` …), a redirect to GitHub instead.
pub(crate) async fn start(
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    Query(params): Query<HashMap<String, String>>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let Some(github) = st.github_auth.as_ref() else {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Вход через GitHub на этом сервере не настроен.",
        );
    };
    let source = client_address(peer, &headers);
    let rate = crate::rate_window::rate_ip(Some(&source));
    let quota = match check_window_quota(
        &st,
        &format!("gh-login-start:{}", rate.as_deref().unwrap_or("?")),
        STARTS_PER_HOUR,
        60 * 60 * 1000,
        "too many sign-in attempts from this address",
    ) {
        Ok(key) => key,
        Err(response) => return response,
    };
    let state = match begin_login(&st, peer, &params, &headers) {
        Ok(v) => v,
        Err(response) => return response,
    };
    // The login must come back to the host it began on (the state cookie is
    // host-only); see `google_login::start` for the reasoning.
    let forwarded_host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(header::HOST))
        .and_then(|v| v.to_str().ok());
    let redirect_uri = format!(
        "{}/api/auth/github/callback",
        callback_origin(&st.public_url, &[], &st.lite_hosts, forwarded_host)
    );
    let location = match github.begin(&state, &redirect_uri, &source) {
        Ok(v) => v,
        Err(error) => return refusal(StatusCode::SERVICE_UNAVAILABLE, error),
    };
    record_window_hit(&st, &quota, 60 * 60 * 1000);
    let mut response = StatusCode::FOUND.into_response();
    if let Ok(value) = HeaderValue::from_str(&location) {
        response.headers_mut().insert(header::LOCATION, value);
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
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

/// `GET /api/auth/github/callback` — GitHub's answer.
pub(crate) async fn callback(
    Query(params): Query<HashMap<String, String>>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let Some(github) = st.github_auth.as_ref() else {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Вход через GitHub на этом сервере не настроен.",
        );
    };
    // The permit comes BEFORE any one-use state is spent: a busy answer must
    // leave the person able to retry the very same callback.
    let permit = if params.contains_key("code") && !params.contains_key("error") {
        match github.limit.try_acquire() {
            Ok(permit) => Some(permit),
            Err(_) => return api_error(StatusCode::SERVICE_UNAVAILABLE, "sign-in busy, try later"),
        }
    } else {
        None
    };
    let (state, native, android) = match check_login_state(&st, &params, &headers) {
        Ok(v) => v,
        Err(response) => return response,
    };
    if let Some(reason) = params.get("error") {
        let reason: String = reason.chars().take(64).collect();
        eprintln!("[auth] GitHub refused the sign-in: {reason:?}");
        github.take(&state);
        return api_error(
            StatusCode::UNAUTHORIZED,
            "GitHub не подтвердил вход. Вернитесь в приложение и попробуйте ещё раз.",
        );
    }
    let Some(code) = params.get("code").filter(|c| !c.is_empty()) else {
        return api_error(StatusCode::BAD_REQUEST, "missing GitHub code");
    };
    let Some(pending) = github.take(&state) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid or expired sign-in");
    };
    let user = match github.exchange(code, &pending).await {
        Ok(v) => v,
        Err(error) => {
            eprintln!("[auth] GitHub sign-in failed: {error}");
            return refusal(StatusCode::UNAUTHORIZED, error);
        }
    };
    drop(permit);
    let ensured = match st.workspaces.github_login(&user) {
        Ok(v) => v,
        Err(error) => return store_failure(error),
    };
    let subject = user.id.to_string();
    finish_login(
        &st,
        &state,
        native,
        android,
        &ensured.user_id,
        Some((PROVIDER_GITHUB, subject.as_str())),
        &headers,
        crate::mfa::Factor::Unproven,
    )
}

/// `github_profiles`: what GitHub said about the person at their last login.
pub(crate) fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS github_profiles (
          user_id      TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
          github_id    TEXT NOT NULL,
          login        TEXT NOT NULL,
          name         TEXT,
          avatar_url   TEXT,
          created_at   TEXT,
          public_repos INTEGER,
          followers    INTEGER,
          bio          TEXT,
          blog         TEXT,
          company      TEXT,
          updated_at   INTEGER NOT NULL
        );
        "#,
    )
    .map_err(db_err)
}

impl WorkspaceStore {
    /// Resolve a GitHub login to an account: the known `('github', id)`, or a
    /// fresh waitlisted `gh-…` one. Never matched by an address — there is
    /// none to match. The profile is refreshed either way.
    pub fn github_login(&self, gh: &GithubUser) -> Result<EnsuredUser, String> {
        let subject = gh.id.to_string();
        let now = workspace::now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let (user_id, created) = match identity::resolve(&tx, PROVIDER_GITHUB, &subject)? {
            Some(user_id) => (user_id, false),
            None => (create_account(&tx, gh, now)?, true),
        };
        identity::link(&tx, PROVIDER_GITHUB, &subject, &user_id, now)?;
        // The login may be renamed on GitHub; the label follows it.
        tx.execute(
            "UPDATE identities SET label=?3 WHERE provider=?1 AND subject=?2",
            params![PROVIDER_GITHUB, subject, gh.login],
        )
        .map_err(db_err)?;
        tx.execute(
            "INSERT INTO github_profiles(user_id,github_id,login,name,avatar_url,created_at,public_repos,followers,bio,blog,company,updated_at) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) \
             ON CONFLICT(user_id) DO UPDATE SET github_id=excluded.github_id,login=excluded.login,\
             name=excluded.name,avatar_url=excluded.avatar_url,created_at=excluded.created_at,\
             public_repos=excluded.public_repos,followers=excluded.followers,bio=excluded.bio,\
             blog=excluded.blog,company=excluded.company,updated_at=excluded.updated_at",
            params![
                user_id,
                subject,
                gh.login,
                cut(&gh.name, 200),
                cut(&gh.avatar_url, 300).filter(|u| u.starts_with("https://")),
                cut(&gh.created_at, 40),
                gh.public_repos,
                gh.followers,
                cut(&gh.bio, 500),
                cut(&gh.blog, 200),
                cut(&gh.company, 200),
                now
            ],
        )
        .map_err(db_err)?;
        if created {
            if let Some(ws) = crate::access::audit_workspace_in(&tx, &user_id)? {
                insert_audit(
                    &tx,
                    &ws,
                    &user_id,
                    "auth.github",
                    "user",
                    &user_id,
                    &json!({"githubId": subject, "login": gh.login, "created": true}),
                )?;
            }
        }
        tx.commit().map_err(db_err)?;
        Ok(EnsuredUser {
            user_id,
            claimed_preauth: false,
        })
    }
}

/// A fresh account for a GitHub-only person: no address, a hub-owned id that
/// can never collide with a platform UUID, the personal workspace every
/// account has, and the access state every new account gets (never vouched:
/// nobody vouched for them yet).
fn create_account(conn: &Connection, gh: &GithubUser, now: i64) -> Result<String, String> {
    let user_id = format!("gh-{}", Uuid::new_v4().simple());
    let personal = format!("personal:{user_id}");
    let name = cut(&gh.name, 200).unwrap_or_else(|| gh.login.clone());
    conn.execute(
        "INSERT INTO users(user_id,email,full_name,created_at) VALUES(?1,NULL,?2,?3)",
        params![user_id, name, now],
    )
    .map_err(db_err)?;
    conn.execute(
        "INSERT OR IGNORE INTO workspaces(workspace_id,name,kind,owner_user_id,created_at) VALUES(?1,'Моя работа','personal',?2,?3)",
        params![personal, user_id, now],
    )
    .map_err(db_err)?;
    conn.execute(
        "INSERT OR IGNORE INTO memberships(workspace_id,user_id,role,created_at) VALUES(?1,?2,'owner',?3)",
        params![personal, user_id, now],
    )
    .map_err(db_err)?;
    conn.execute(
        "INSERT OR IGNORE INTO user_access(user_id,state,plan,requested_at,updated_at) VALUES(?1,?2,'community',?3,?3)",
        params![user_id, crate::access::new_account_state(false), now],
    )
    .map_err(db_err)?;
    Ok(user_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::{get, post};

    fn count(s: &WorkspaceStore, sql: &str) -> i64 {
        let conn = s.conn.lock().unwrap();
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    fn gh(id: i64, login: &str) -> GithubUser {
        GithubUser {
            id,
            login: login.into(),
            name: Some("Имя".into()),
            avatar_url: Some("https://avatars.test/u/1".into()),
            created_at: Some("2015-01-02T03:04:05Z".into()),
            public_repos: Some(7),
            followers: Some(3),
            bio: Some("bio".into()),
            blog: Some("https://blog.test".into()),
            company: Some("Acme".into()),
        }
    }

    fn auth(web: &str, api: &str) -> GithubAuth {
        GithubAuth::new("cid".into(), "secret".into(), web.into(), api.into()).unwrap()
    }

    #[test]
    fn the_authorize_url_carries_pkce_and_state_and_nothing_secret() {
        let g = auth(WEB_BASE, API_BASE);
        let url = g.begin("st-1", "https://x.test/cb", "1.2.3.4").unwrap();
        assert!(url.starts_with("https://github.com/login/oauth/authorize?"));
        for part in [
            "client_id=cid",
            "redirect_uri=https%3A%2F%2Fx.test%2Fcb",
            "state=st-1",
            "code_challenge=",
            "code_challenge_method=S256",
        ] {
            assert!(url.contains(part), "{part} missing from {url}");
        }
        assert!(!url.contains("secret"));
        let pending = g.take("st-1").expect("pending");
        assert_eq!(pending.redirect_uri, "https://x.test/cb");
        assert!(g.take("st-1").is_none(), "a state is spent by its callback");
        assert!(g.take("never-issued").is_none());
    }

    #[test]
    fn one_source_cannot_fill_the_pending_table_for_everybody() {
        let g = auth(WEB_BASE, API_BASE);
        for i in 0..MAX_PENDING_PER_SOURCE {
            g.begin(&format!("s{i}"), "https://x.test/cb", "9.9.9.9")
                .unwrap();
        }
        assert!(g.begin("more", "https://x.test/cb", "9.9.9.9").is_err());
        assert!(g.begin("other", "https://x.test/cb", "8.8.8.8").is_ok());
    }

    #[test]
    fn a_full_table_evicts_another_sources_oldest_and_ipv6_counts_by_its_64() {
        let g = auth(WEB_BASE, API_BASE);
        // Fill the table from many sources, oldest first.
        for i in 0..MAX_PENDING {
            g.begin(
                &format!("s{i}"),
                "https://x.test/cb",
                &format!("10.0.{}.{}", i / 200, i % 200),
            )
            .unwrap();
        }
        // A newcomer is not locked out: the oldest entry makes room.
        assert!(g.begin("new", "https://x.test/cb", "9.9.9.9").is_ok());
        assert!(
            g.take("s0").is_none(),
            "the oldest of another source was evicted"
        );
        assert!(g.take("new").is_some());
        // One IPv6 /64 is one source however the low bits vary.
        let g = auth(WEB_BASE, API_BASE);
        for i in 0..MAX_PENDING_PER_SOURCE {
            g.begin(
                &format!("v{i}"),
                "https://x.test/cb",
                &format!("2001:db8:1:2::{i:x}"),
            )
            .unwrap();
        }
        assert!(g
            .begin("more", "https://x.test/cb", "2001:db8:1:2:ffff::1")
            .is_err());
        assert!(g
            .begin("other", "https://x.test/cb", "2001:db8:1:3::1")
            .is_ok());
    }

    #[test]
    fn login_names_that_cannot_sit_in_a_url_path_are_refused() {
        assert!(valid_login("octo-cat"));
        assert!(valid_login("A1"));
        assert!(!valid_login(""));
        assert!(!valid_login("a/b"));
        assert!(!valid_login("a b"));
        assert!(!valid_login("../x"));
        assert!(!valid_login(&"a".repeat(40)));
    }

    #[test]
    fn a_new_github_person_gets_a_waitlisted_account_without_an_address() {
        let s = WorkspaceStore::open_memory();
        let got = s.github_login(&gh(42, "octo")).unwrap();
        assert!(got.user_id.starts_with("gh-"));
        assert!(!got.claimed_preauth);
        assert_eq!(
            count(&s, "SELECT COUNT(*) FROM users WHERE email IS NULL"),
            1
        );
        assert_eq!(
            count(&s, "SELECT COUNT(*) FROM workspaces WHERE kind='personal'"),
            1
        );
        assert_eq!(s.access_state(&got.user_id).unwrap().state, "waitlist");
        assert_eq!(
            count(
                &s,
                "SELECT COUNT(*) FROM identities WHERE provider='github' AND subject='42' AND label='octo'"
            ),
            1
        );
        assert_eq!(
            count(
                &s,
                "SELECT COUNT(*) FROM audit_events WHERE action='auth.github'"
            ),
            1
        );
    }

    #[test]
    fn the_same_github_id_opens_the_same_account_and_refreshes_the_profile() {
        let s = WorkspaceStore::open_memory();
        let first = s.github_login(&gh(42, "octo")).unwrap();
        let mut renamed = gh(42, "octo-new");
        renamed.followers = Some(99);
        renamed.bio = None;
        let again = s.github_login(&renamed).unwrap();
        assert_eq!(again.user_id, first.user_id);
        assert_eq!(count(&s, "SELECT COUNT(*) FROM users"), 1);
        assert_eq!(count(&s, "SELECT COUNT(*) FROM identities"), 1);
        assert_eq!(count(&s, "SELECT COUNT(*) FROM github_profiles"), 1);
        assert_eq!(
            count(
                &s,
                "SELECT COUNT(*) FROM github_profiles WHERE login='octo-new' AND followers=99 AND bio IS NULL"
            ),
            1
        );
        assert_eq!(
            count(&s, "SELECT COUNT(*) FROM identities WHERE label='octo-new'"),
            1
        );
        // Only the birth is audited.
        assert_eq!(
            count(
                &s,
                "SELECT COUNT(*) FROM audit_events WHERE action='auth.github'"
            ),
            1
        );
    }

    #[test]
    fn two_github_ids_are_two_accounts_and_an_existing_address_is_never_touched() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("hegai-uuid", "octo@x.test", Some("Octo"))
            .unwrap();
        let a = s.github_login(&gh(1, "octo")).unwrap();
        let b = s.github_login(&gh(2, "other")).unwrap();
        assert_ne!(a.user_id, b.user_id);
        assert_ne!(a.user_id, "hegai-uuid");
        assert_eq!(count(&s, "SELECT COUNT(*) FROM users"), 3);
        assert_eq!(
            count(
                &s,
                "SELECT COUNT(*) FROM identities WHERE user_id='hegai-uuid' AND provider='github'"
            ),
            0
        );
    }

    /// A fake GitHub on a loopback port: the token endpoint and `GET /user`.
    async fn fake_github(token_ok: bool) -> String {
        let app =
            axum::Router::new()
                .route(
                    "/login/oauth/access_token",
                    post(
                        move |axum::extract::Form(f): axum::extract::Form<
                            HashMap<String, String>,
                        >| async move {
                            if token_ok
                                && f.get("code").is_some_and(|c| c == "good")
                                && f.get("code_verifier").is_some_and(|v| v.len() >= 43)
                                && f.get("client_secret").is_some_and(|v| v == "secret")
                            {
                                Json(json!({"access_token": "tok", "token_type": "bearer"}))
                            } else {
                                Json(json!({"error": "bad_verification_code"}))
                            }
                        },
                    ),
                )
                .route(
                    "/user",
                    get(|headers: HeaderMap| async move {
                        if headers
                            .get(header::AUTHORIZATION)
                            .and_then(|v| v.to_str().ok())
                            == Some("Bearer tok")
                        {
                            Json(
                                json!({"id": 42, "login": "octo", "name": null, "public_repos": 3}),
                            )
                            .into_response()
                        } else {
                            StatusCode::UNAUTHORIZED.into_response()
                        }
                    }),
                );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        base
    }

    #[tokio::test]
    async fn the_code_is_exchanged_with_the_verifier_and_the_user_is_read() {
        let base = fake_github(true).await;
        let g = auth(&base, &base);
        g.begin("s", "https://x.test/cb", "1.1.1.1").unwrap();
        let pending = g.take("s").unwrap();
        let user = g.exchange("good", &pending).await.unwrap();
        assert_eq!((user.id, user.login.as_str()), (42, "octo"));
        assert_eq!(user.public_repos, Some(3));
        assert!(user.name.is_none());
    }

    #[tokio::test]
    async fn a_bad_code_or_an_error_answer_is_a_refusal_not_a_login() {
        let base = fake_github(true).await;
        let g = auth(&base, &base);
        g.begin("s", "https://x.test/cb", "1.1.1.1").unwrap();
        let pending = g.take("s").unwrap();
        assert!(g.exchange("forged", &pending).await.is_err());
        let base = fake_github(false).await;
        let g = auth(&base, &base);
        assert!(g.exchange("good", &pending).await.is_err());
        // Nothing listens there.
        let g = auth("http://127.0.0.1:1", "http://127.0.0.1:1");
        assert!(g.exchange("good", &pending).await.is_err());
    }
}
