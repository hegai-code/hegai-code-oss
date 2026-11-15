//! Sign in with Google: OpenID Connect authorization code + PKCE, finished on
//! the hub so the browser, the native apps and the desktop shells all go
//! through one redirect and one callback (`/api/auth/google/{start,callback}`)
//! and come back the same way the HegAI SSO did — cookie, `ccremote://auth`,
//! or the Android one-use code (`begin_login` / `finish_login` in main.rs).
//!
//! The hub exchanges the code itself (it holds the client secret), verifies
//! the ID token's signature, issuer, audience, nonce and expiry, and refuses
//! an address Google has not verified. Who the person IS is decided by
//! `google_login`: a known `('google', sub)` opens its account; otherwise a
//! verified address that already belongs to an account opens THAT account
//! (and the identity is recorded, so the next login no longer depends on the
//! address); otherwise a fresh community account is born, claiming an admin's
//! pre-authorization for the address if there is one. Any account, privileged
//! ones included, may sign in with Google.
//!
//! LINKING (a signed-in person adds Google to their own account) rides the same
//! hop with `link` on the start: `link=1` takes the account from the session
//! cookie the browser sends on a same-origin navigation; `link=<ticket>` takes
//! it from a one-use ticket the app minted with its bearer session
//! (`POST /api/auth/google/link`) — `ASWebAuthenticationSession` carries no
//! session of ours. Either way the account is bound into the PENDING login on
//! the hub, keyed by its one-use state, so nothing the callback receives can
//! point the link at anybody else. The callback then attaches the Google
//! identity to that account (`identity::attach`) instead of signing in.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use jsonwebtoken::jwk::JwkSet;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::provisioning_api::ct_eq;
use crate::workspace::{db_err, insert_audit, normalize_email, opaque_token, EnsuredUser};

pub(crate) const PROVIDER_GOOGLE: &str = "google";

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const JWKS_URL: &str = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS: [&str; 2] = ["https://accounts.google.com", "accounts.google.com"];
const PENDING_TTL: Duration = Duration::from_secs(600);
const MAX_PENDING: usize = 512;
/// One address cannot hold more than this many unfinished logins: the global
/// cap alone lets one client lock everybody else out for ten minutes.
const MAX_PENDING_PER_SOURCE: usize = 20;

pub(crate) struct GoogleAuth {
    client_id: String,
    client_secret: String,
    /// `GOOGLE_ALLOWED_DOMAINS` (comma list): when set, a sign-in needs an
    /// address in one of them and, if Google names a hosted domain, that
    /// domain too. Unset = every Google account, as before.
    allowed_domains: Vec<String>,
    http: reqwest::Client,
    pending: Mutex<HashMap<String, Pending>>,
    keys: tokio::sync::Mutex<Option<(Instant, JwkSet)>>,
    limit: Semaphore,
    /// One-use link tickets: hash of the ticket -> (account, hash of the
    /// bearer session that minted it, minted).
    link_tickets: Mutex<HashMap<String, (String, String, Instant)>>,
    /// Native links Google has answered, waiting for the app that minted the
    /// ticket to confirm them: hash of the result token -> what to attach.
    staged: Mutex<HashMap<String, StagedLink>>,
}

/// A Google identity proven for a native link, not attached yet. Only the
/// app session that minted the ticket can turn it into a link
/// (`POST /api/auth/google/link/confirm`): whoever opened the start URL —
/// possibly a victim the ticket's URL was forwarded to — never holds that
/// session, so their Google cannot be attached to someone else's account.
struct StagedLink {
    user: String,
    session_hash: String,
    sub: String,
    label: String,
    created: Instant,
}

/// How long a minted link ticket waits for its start hop.
const LINK_TICKET_TTL: Duration = Duration::from_secs(120);
const MAX_LINK_TICKETS: usize = 256;

struct Pending {
    source: String,
    /// Set when this hop links Google to a signed-in account instead of
    /// signing in — bound here, at the start, never read from the callback.
    link_user: Option<String>,
    /// A ticket link: the minting session, so the result is staged for it.
    link_session: Option<String>,
    /// The session that started a link, as a token hash. The callback requires
    /// it to be STILL alive for `link_user`: signing the account out (the
    /// Telegram «Это был не я» undo) kills every link in flight with it.
    link_bound: Option<String>,
    verifier: String,
    nonce: String,
    redirect_uri: String,
    created: Instant,
}

#[derive(Deserialize)]
struct IdClaims {
    sub: String,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    email_verified: bool,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    nonce: Option<String>,
    /// The Workspace domain, present only for a Google Workspace account.
    #[serde(default)]
    hd: Option<String>,
}

/// May Google vouch for who holds this ADDRESS today? Only for the domains
/// Google itself runs the mailboxes of: gmail.com, and a Workspace domain
/// the token names in `hd` (the admin of that domain controls it). For any
/// other address `email_verified` only says it was verified when the Google
/// account was made — after the address changes hands, the old holder's
/// Google account still carries it. Such a login may open its OWN account
/// (by subject) but must never be matched to someone else's by address, nor
/// claim an admin's pre-authorization for it.
fn google_vouches_for(email: &str, hd: Option<&str>) -> bool {
    let Some((_, domain)) = email.rsplit_once('@') else {
        return false;
    };
    if domain == "gmail.com" || domain == "googlemail.com" {
        return true;
    }
    hd.is_some_and(|hd| hd.eq_ignore_ascii_case(domain))
}

#[derive(Deserialize)]
struct TokenResponse {
    id_token: String,
}

impl GoogleAuth {
    /// `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`, both or neither: a half
    /// configuration is a typo worth refusing to start over.
    pub fn from_env() -> Result<Option<Arc<Self>>, &'static str> {
        let id = std::env::var("GOOGLE_CLIENT_ID")
            .ok()
            .filter(|v| !v.is_empty());
        let secret = std::env::var("GOOGLE_CLIENT_SECRET")
            .ok()
            .filter(|v| !v.is_empty());
        let (client_id, client_secret) = match (id, secret) {
            (None, None) => return Ok(None),
            (Some(i), Some(s)) => (i, s),
            _ => return Err("incomplete Google sign-in configuration"),
        };
        Ok(Some(Arc::new(Self {
            client_id,
            client_secret,
            allowed_domains: crate::oidc_login::parse_domains(
                std::env::var("GOOGLE_ALLOWED_DOMAINS").ok().as_deref(),
            ),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "Google HTTP configuration")?,
            pending: Mutex::new(HashMap::new()),
            keys: tokio::sync::Mutex::new(None),
            limit: Semaphore::new(8),
            link_tickets: Mutex::new(HashMap::new()),
            staged: Mutex::new(HashMap::new()),
        })))
    }

    /// A one-use ticket that names `user` for ONE link hop. Only its hash is
    /// kept; it dies at its first use or after `LINK_TICKET_TTL`.
    fn mint_link_ticket(&self, user: &str, session_hash: &str) -> Result<String, &'static str> {
        let ticket = opaque_token();
        let mut tickets = self.link_tickets.lock().map_err(|_| "link unavailable")?;
        // One outstanding ticket per account: a new one replaces the last, so
        // one person cannot fill the table for everybody.
        tickets.retain(|_, (u, _, t)| t.elapsed() < LINK_TICKET_TTL && u != user);
        if tickets.len() >= MAX_LINK_TICKETS {
            return Err("link busy, try later");
        }
        tickets.insert(
            workspace::hash_token(&ticket),
            (user.to_string(), session_hash.to_string(), Instant::now()),
        );
        Ok(ticket)
    }

    /// `(account, minting session hash)` of a live ticket, spent.
    fn take_link_ticket(&self, ticket: &str) -> Option<(String, String)> {
        let mut tickets = self.link_tickets.lock().ok()?;
        let (user, session, minted) = tickets.remove(&workspace::hash_token(ticket))?;
        (minted.elapsed() < LINK_TICKET_TTL).then_some((user, session))
    }

    fn stage_link(&self, link: StagedLink) -> Result<String, &'static str> {
        let token = opaque_token();
        let mut staged = self.staged.lock().map_err(|_| "link unavailable")?;
        staged.retain(|_, s| s.created.elapsed() < LINK_TICKET_TTL && s.user != link.user);
        if staged.len() >= MAX_LINK_TICKETS {
            return Err("link busy, try later");
        }
        staged.insert(workspace::hash_token(&token), link);
        Ok(token)
    }

    #[cfg(test)]
    fn take_staged(&self, token: &str) -> Option<StagedLink> {
        let mut staged = self.staged.lock().ok()?;
        staged
            .remove(&workspace::hash_token(token))
            .filter(|s| s.created.elapsed() < LINK_TICKET_TTL)
    }

    /// Spend a staged result only for the account AND session it was staged
    /// for; anyone else presenting it leaves it in place for the real app.
    fn take_staged_for(&self, token: &str, user: &str, session_hash: &str) -> Option<StagedLink> {
        let mut staged = self.staged.lock().ok()?;
        let key = workspace::hash_token(token);
        let ok = staged.get(&key).is_some_and(|s| {
            s.created.elapsed() < LINK_TICKET_TTL
                && s.user == user
                && ct_eq(s.session_hash.as_bytes(), session_hash.as_bytes())
        });
        if ok {
            staged.remove(&key)
        } else {
            None
        }
    }

    /// Remember what the callback must prove, keyed by the login's `state`, and
    /// build the URL that sends the person to Google.
    fn begin(
        &self,
        state: &str,
        redirect_uri: &str,
        source: &str,
        link_user: Option<String>,
        link_session: Option<String>,
        link_bound: Option<String>,
    ) -> Result<String, &'static str> {
        let verifier = format!("{}{}", opaque_token(), opaque_token());
        let nonce = opaque_token();
        let challenge = pkce_challenge(&verifier);
        {
            let mut values = self.pending.lock().map_err(|_| "sign-in unavailable")?;
            values.retain(|_, p| p.created.elapsed() < PENDING_TTL);
            if values.values().filter(|p| p.source == source).count() >= MAX_PENDING_PER_SOURCE
                || values.len() >= MAX_PENDING
            {
                return Err("sign-in busy, try later");
            }
            values.insert(
                state.to_string(),
                Pending {
                    source: source.to_string(),
                    link_user,
                    link_session,
                    link_bound,
                    verifier,
                    nonce: nonce.clone(),
                    redirect_uri: redirect_uri.to_string(),
                    created: Instant::now(),
                },
            );
        }
        Ok(authorize_url(
            &self.client_id,
            redirect_uri,
            state,
            &nonce,
            &challenge,
        ))
    }

    fn take(&self, state: &str) -> Option<Pending> {
        let mut values = self.pending.lock().ok()?;
        values.retain(|_, p| p.created.elapsed() < PENDING_TTL);
        values.remove(state)
    }

    async fn exchange(&self, code: &str, pending: &Pending) -> Result<IdClaims, &'static str> {
        let response = self
            .http
            .post(TOKEN_URL)
            .form(&[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("client_id", self.client_id.as_str()),
                ("client_secret", self.client_secret.as_str()),
                ("redirect_uri", pending.redirect_uri.as_str()),
                ("code_verifier", pending.verifier.as_str()),
            ])
            .send()
            .await
            .map_err(|_| "Google is unavailable")?;
        if !response.status().is_success() {
            return Err("Google refused the sign-in code");
        }
        let token = response
            .json::<TokenResponse>()
            .await
            .map_err(|_| "Google answered unexpectedly")?
            .id_token;
        self.verify(&token, &pending.nonce).await
    }

    async fn verify(&self, token: &str, nonce: &str) -> Result<IdClaims, &'static str> {
        let header = jsonwebtoken::decode_header(token).map_err(|_| "invalid Google identity")?;
        if header.alg != Algorithm::RS256 {
            return Err("invalid Google identity algorithm");
        }
        let kid = header.kid.ok_or("missing Google signing key")?;
        let mut cache = self.keys.lock().await;
        let stale = cache.as_ref().is_none_or(|(t, keys)| {
            t.elapsed() > Duration::from_secs(3600) || keys.find(&kid).is_none()
        });
        // A key we do not know may simply be new: refetch once, but not on
        // every bad token (a forged `kid` must not turn into a Google request
        // per attempt).
        let refetch_ok = cache
            .as_ref()
            .is_none_or(|(t, _)| t.elapsed() > Duration::from_secs(60));
        if stale && refetch_ok {
            let response = self
                .http
                .get(JWKS_URL)
                .send()
                .await
                .map_err(|_| "Google keys unavailable")?;
            if !response.status().is_success() {
                return Err("Google keys unavailable");
            }
            let keys = response
                .json::<JwkSet>()
                .await
                .map_err(|_| "Google keys unavailable")?;
            *cache = Some((Instant::now(), keys));
        }
        let jwk = cache
            .as_ref()
            .and_then(|(_, keys)| keys.find(&kid))
            .ok_or("unknown Google signing key")?;
        let key = DecodingKey::from_jwk(jwk).map_err(|_| "invalid Google signing key")?;
        verify_claims(token, nonce, &self.client_id, &key)
    }
}

fn verify_claims(
    token: &str,
    nonce: &str,
    audience: &str,
    key: &DecodingKey,
) -> Result<IdClaims, &'static str> {
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&[audience]);
    validation.set_issuer(&ISSUERS);
    validation.leeway = 30;
    validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
    let claims = decode::<IdClaims>(token, key, &validation)
        .map_err(|_| "invalid Google identity")?
        .claims;
    if claims.sub.is_empty() || claims.sub.len() > 255 || claims.nonce.as_deref() != Some(nonce) {
        return Err("Google identity does not match this sign-in");
    }
    Ok(claims)
}

/// S256 code challenge for a verifier.
pub(crate) fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn authorize_url(
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    nonce: &str,
    challenge: &str,
) -> String {
    format!(
        "{AUTH_URL}?client_id={}&redirect_uri={}&response_type=code&scope={}&state={}&nonce={}\
         &code_challenge={}&code_challenge_method=S256&prompt=select_account",
        urlencoding::encode(client_id),
        urlencoding::encode(redirect_uri),
        urlencoding::encode("openid email profile"),
        urlencoding::encode(state),
        urlencoding::encode(nonce),
        urlencoding::encode(challenge),
    )
}

/// `GET /api/auth/google/start` — the same query as the HegAI `sso/start`
/// (`native`, `pwa`, `android` …), a redirect to Google instead.
pub(crate) async fn start(
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    Query(params): Query<HashMap<String, String>>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let Some(google) = st.google_auth.as_ref() else {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Вход через Google на этом сервере не настроен.",
        );
    };
    let (link_user, link_session, link_bound) = match params.get("link").map(String::as_str) {
        None | Some("") | Some("0") => (None, None, None),
        Some(link) => match link_account(&st, google, link, &params, &headers) {
            Ok((user, session, bound)) => (Some(user), session, Some(bound)),
            Err(response) => return response,
        },
    };
    let state = match begin_login(&st, peer, &params, &headers) {
        Ok(v) => v,
        Err(response) => return response,
    };
    // Google compares redirect URIs EXACTLY: the alternative ports the HegAI
    // login could ride are not registered there, so no port is ever taken from
    // the request. The NAME is: a login begun on the light shell's host
    // (`CC_REMOTE_LITE_HOSTS`) must come back to that host, because the state
    // cookie set below is host-only — returned to `public_url` it would not be
    // found, and the session would be opened on the wrong site. Each such name
    // has its own redirect URI registered with the Google client.
    //
    // nginx says which name the person is on in `X-Forwarded-Host`; a hub
    // reached directly (a dev hub, a proxy that only preserves `Host`) says it
    // in `Host`. Either is the client's word and only ever SELECTS among the
    // names we listed (`callback_origin`), so falling back is as safe as the
    // header itself.
    let forwarded_host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(header::HOST))
        .and_then(|v| v.to_str().ok());
    let redirect_uri = format!(
        "{}/api/auth/google/callback",
        callback_origin(&st.public_url, &[], &st.lite_hosts, forwarded_host)
    );
    let location = match google.begin(
        &state,
        &redirect_uri,
        &client_address(peer, &headers),
        link_user,
        link_session,
        link_bound,
    ) {
        Ok(v) => v,
        Err(error) => return refusal(StatusCode::SERVICE_UNAVAILABLE, error),
    };
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

/// `GET /api/auth/google/callback` — Google's answer.
pub(crate) async fn callback(
    Query(params): Query<HashMap<String, String>>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let Some(google) = st.google_auth.as_ref() else {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Вход через Google на этом сервере не настроен.",
        );
    };
    // The permit comes BEFORE any one-use state is spent (the native/Android
    // handshakes in `check_login_state` included): a busy answer must leave the
    // person able to retry the very same callback.
    let permit = if params.contains_key("code") && !params.contains_key("error") {
        match google.limit.try_acquire() {
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
        // Free text from the query string: escaped and cut, so a crafted value
        // cannot forge a log line.
        let reason: String = reason.chars().take(64).collect();
        eprintln!("[auth] Google refused the sign-in: {reason:?}");
        // A cancelled LINK still ends where it began (settings / the app's
        // sheet), or the native sheet never closes.
        if google.take(&state).is_some_and(|p| p.link_user.is_some()) {
            return finish_link(&st, native, Err("link_cancelled"));
        }
        return api_error(
            StatusCode::UNAUTHORIZED,
            "Google не подтвердил вход. Вернитесь в приложение и попробуйте ещё раз.",
        );
    }
    let Some(code) = params.get("code").filter(|c| !c.is_empty()) else {
        return api_error(StatusCode::BAD_REQUEST, "missing Google code");
    };
    let Some(pending) = google.take(&state) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid or expired sign-in");
    };
    // A LINK is proven by the state cookie on EVERY client, the native one
    // included (its web sheet keeps the cookie the start hop set). The native
    // handshake map alone only says the hub began this login — not that the
    // person now at Google is the one who began it: an attacker could start a
    // link to his own account and send the consent URL to a victim, whose
    // Google would then open the attacker's account. Checked before the code
    // is spent at Google.
    if pending.link_user.is_some()
        && !link_state_proven(&headers, &state, st.public_url.starts_with("https://"))
    {
        eprintln!("[auth] Google link refused: the state cookie does not match");
        return finish_link(&st, native, Err("link_failed"));
    }
    // The session that began the link must still be alive for that account.
    if let (Some(user), Some(bound)) = (pending.link_user.as_deref(), pending.link_bound.as_deref())
    {
        if !st.workspaces.session_alive_for(bound, user) {
            eprintln!("[auth] Google link refused: the session that began it is gone");
            return finish_link(&st, native, Err("link_failed"));
        }
    }
    let claims = match google.exchange(code, &pending).await {
        Ok(v) => v,
        Err(error) => {
            eprintln!("[auth] Google sign-in failed: {error}");
            return refusal(StatusCode::UNAUTHORIZED, error);
        }
    };
    let email = claims
        .email
        .as_deref()
        .map(normalize_email)
        .filter(|e| e.contains('@'));
    if let Some(target) = pending.link_user.as_deref() {
        drop(permit);
        // Only the subject is the identity; the address is a label here and
        // matches nothing, so an unverified one is shown, not refused.
        let label = email.as_deref().unwrap_or("Google");
        // A ticket link only STAGES the result for the app that minted the
        // ticket; that app attaches it with its own session.
        if let Some(session_hash) = pending.link_session.clone() {
            let staged = google.stage_link(StagedLink {
                user: target.to_string(),
                session_hash,
                sub: claims.sub.clone(),
                label: label.to_string(),
                created: Instant::now(),
            });
            return match staged {
                Ok(token) => redirect_no_store(&format!(
                    "{NATIVE_CALLBACK}?link_result={}",
                    urlencoding::encode(&token)
                )),
                Err(_) => finish_link(&st, native, Err("link_failed")),
            };
        }
        // Suspended since the start hop: no new way into it.
        let result = match access_gate_state(&st.workspaces, target) {
            Ok(()) => {
                st.workspaces
                    .attach_identity(PROVIDER_GOOGLE, &claims.sub, target, Some(label))
            }
            Err(_) => Err("access_not_active".to_string()),
        };
        let outcome = match &result {
            Ok(attached) => {
                println!("[auth] {target} linked Google ({attached:?})");
                st.hub.send(HubCmd::RefreshWorkspaceState);
                Ok(())
            }
            Err(code) => {
                eprintln!("[auth] Google link for {target} refused: {code}");
                Err(link_error_code(code))
            }
        };
        return finish_link(&st, native, outcome);
    }
    let Some(email) = email.filter(|_| claims.email_verified) else {
        return api_error(
            StatusCode::FORBIDDEN,
            "Google не подтвердил адрес почты этой учётки — войти с ней нельзя.",
        );
    };
    // A consumer Google account can use a corporate address as its login but
    // has no hosted domain: with a list set, `hd` is mandatory.
    if !crate::oidc_login::domain_allowed(
        &email,
        claims.hd.as_deref(),
        &google.allowed_domains,
        true,
    ) {
        eprintln!("[auth] Google sign-in refused: {email} is not in GOOGLE_ALLOWED_DOMAINS");
        return api_error(
            StatusCode::FORBIDDEN,
            "Адрес почты не входит в список разрешённых доменов.",
        );
    }
    let vouched = google_vouches_for(&email, claims.hd.as_deref());
    drop(permit);
    let ensured = match st.workspaces.google_login(
        &claims.sub,
        &email,
        claims.name.as_deref(),
        vouched,
        !google.allowed_domains.is_empty(),
    ) {
        Ok(v) => v,
        Err(error) if error == crate::oidc_login::EMAIL_LINK_REFUSED => {
            eprintln!("[auth] Google sign-in refused: {email} would take over a protected account");
            return refusal(StatusCode::FORBIDDEN, error);
        }
        Err(error) => return store_failure(error),
    };
    if ensured.claimed_preauth {
        println!("[access] preauthorized {email} activated at first Google login");
        access_api::after_activate_hooks(&st, &ensured.user_id);
    }
    finish_login(
        &st,
        &state,
        native,
        android,
        &ensured.user_id,
        Some((PROVIDER_GOOGLE, claims.sub.as_str())),
        &headers,
        crate::mfa::Factor::Unproven,
    )
}

/// Which account a `link` start hop links to. `1`: the session the browser
/// sent on this navigation — only on a same-origin one, so another site cannot
/// start a link in someone's name. Anything else: a ticket from
/// `POST /api/auth/google/link`. Android has no link screen and is refused.
fn link_account(
    st: &AppState,
    google: &GoogleAuth,
    link: &str,
    params: &HashMap<String, String>,
    headers: &HeaderMap,
) -> Result<(String, Option<String>, String), Response> {
    if params.get("android").is_some_and(|v| v == "1") {
        return Err(api_error(
            StatusCode::BAD_REQUEST,
            "conflicting login modes",
        ));
    }
    let (user, session, bound) = if link == "1" {
        if !same_origin(headers) {
            return Err(api_error(
                StatusCode::FORBIDDEN,
                "cross-site request rejected",
            ));
        }
        let user = authenticated_user(headers, st)?;
        let bound = crate::workspace_api::current_session(headers, st)
            .ok_or_else(|| api_error(StatusCode::UNAUTHORIZED, "authentication required"))?;
        (user, None, bound)
    } else {
        // A ticket is the app's: its result goes back through `ccremote://`
        // and is confirmed by the app's session, so only a native hop.
        if !params
            .get("native")
            .is_some_and(|v| v == "1" || v == "true")
        {
            return Err(api_error(
                StatusCode::BAD_REQUEST,
                "link ticket needs native=1",
            ));
        }
        let (user, session) = google.take_link_ticket(link).ok_or_else(|| {
            api_error(
                StatusCode::BAD_REQUEST,
                "Ссылка для привязки устарела. Начните заново.",
            )
        })?;
        (user, Some(session.clone()), session)
    };
    require_active(st, &user)?;
    Ok((user, session, bound))
}

fn redirect_no_store(location: &str) -> Response {
    let mut response = StatusCode::FOUND.into_response();
    if let Ok(value) = HeaderValue::from_str(location) {
        response.headers_mut().insert(header::LOCATION, value);
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// `POST /api/auth/google/link/confirm` `{result}` — the app that minted the
/// link ticket attaches the Google identity its web sheet proved. Only the
/// SAME bearer session that minted the ticket may: a result that reached
/// anyone else (a forwarded start URL) attaches nothing.
pub(crate) async fn link_confirm(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let Some(google) = st.google_auth.as_ref() else {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Вход через Google на этом сервере не настроен.",
        );
    };
    if !same_origin(&headers) {
        return api_error(StatusCode::FORBIDDEN, "cross-site request rejected");
    }
    let Some(bearer) = bearer_token(&headers) else {
        return api_error(StatusCode::UNAUTHORIZED, "authentication required");
    };
    let user = match st.workspaces.authenticate(&bearer) {
        Ok(Some((user, _))) => user,
        Ok(None) => return api_error(StatusCode::UNAUTHORIZED, "authentication required"),
        Err(e) => return store_failure(e),
    };
    gate!(require_active(&st, &user));
    let Some(result) = body.get("result").and_then(Value::as_str) else {
        return api_error(StatusCode::BAD_REQUEST, "result required");
    };
    let Some(staged) = google.take_staged_for(result, &user, &workspace::hash_token(&bearer))
    else {
        return api_error(StatusCode::BAD_REQUEST, "link_failed");
    };
    match st
        .workspaces
        .attach_identity(PROVIDER_GOOGLE, &staged.sub, &user, Some(&staged.label))
    {
        Ok(attached) => {
            println!("[auth] {user} linked Google ({attached:?})");
            st.hub.send(HubCmd::RefreshWorkspaceState);
            Json(json!({"linked": "google"})).into_response()
        }
        Err(code) => api_error(StatusCode::CONFLICT, link_error_code(&code)),
    }
}

/// `POST /api/auth/google/link` — for a client whose web sheet carries no
/// session of ours (the iOS app): mint a one-use ticket for the signed-in,
/// active account and answer the start URL to open.
pub(crate) async fn link_ticket(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let Some(google) = st.google_auth.as_ref() else {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Вход через Google на этом сервере не настроен.",
        );
    };
    let user = gate!(mutation_user(&headers, &st));
    gate!(require_active(&st, &user));
    let quota = match check_window_quota(
        &st,
        &format!("google-link:{user}"),
        20,
        60 * 60 * 1000,
        "too many link attempts, try later",
    ) {
        Ok(key) => key,
        Err(response) => return response,
    };
    record_window_hit(&st, &quota, 60 * 60 * 1000);
    // The ticket is bound to the bearer session that asked: only it can
    // confirm the result (`link_confirm`).
    let Some(bearer) = bearer_token(&headers) else {
        return api_error(StatusCode::UNAUTHORIZED, "bearer session required");
    };
    match google.mint_link_ticket(&user, &workspace::hash_token(&bearer)) {
        Ok(ticket) => (
            [(header::CACHE_CONTROL, "no-store")],
            Json(json!({
                "ticket": ticket,
                "path": format!("/api/auth/google/start?native=1&link={ticket}"),
                "expiresIn": LINK_TICKET_TTL.as_secs(),
            })),
        )
            .into_response(),
        Err(error) => refusal(StatusCode::SERVICE_UNAVAILABLE, error),
    }
}

/// The browser at the callback is the one that began this link: it carries
/// the state cookie the start hop set, equal to the state Google returned.
fn link_state_proven(headers: &HeaderMap, state: &str, secure: bool) -> bool {
    !state.is_empty()
        && state_cookie(headers, secure).is_some_and(|c| ct_eq(c.as_bytes(), state.as_bytes()))
}

/// The stable codes a link ends with, for the page or the app to word.
fn link_error_code(code: &str) -> &'static str {
    match code {
        identity::OWNER_HAS_DATA => identity::OWNER_HAS_DATA,
        identity::TARGET_DELETING => identity::TARGET_DELETING,
        "access_not_active" => "access_not_active",
        _ => "link_failed",
    }
}

/// Where a link hop lands: the app's custom scheme, or the web's settings —
/// with `linked=google` or `link_error=<code>`. No session is minted: the
/// person is already signed in.
fn finish_link(st: &AppState, native: bool, outcome: Result<(), &'static str>) -> Response {
    let query = match outcome {
        Ok(()) => "linked=google".to_string(),
        Err(code) => format!("link_error={code}&provider=google"),
    };
    let location = if native {
        format!("{NATIVE_CALLBACK}?{query}")
    } else {
        format!("/w/settings?{query}")
    };
    let mut response = StatusCode::FOUND.into_response();
    if let Ok(value) = HeaderValue::from_str(&location) {
        response.headers_mut().insert(header::LOCATION, value);
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if !native {
        response.headers_mut().append(
            header::SET_COOKIE,
            set_cookie_header(
                SSO_STATE_COOKIE,
                "",
                0,
                st.public_url.starts_with("https://"),
            ),
        );
    }
    response
}

impl WorkspaceStore {
    /// Resolve a Google login to an account. `email` is already normalized and
    /// Google-verified. `vouched`: Google vouches for the address (may open the
    /// account that holds it). `domain_vouched`: the customer's
    /// `GOOGLE_ALLOWED_DOMAINS` list covers it (a new account may be active in
    /// the external edition).
    pub fn google_login(
        &self,
        sub: &str,
        email: &str,
        name: Option<&str>,
        vouched: bool,
        domain_vouched: bool,
    ) -> Result<EnsuredUser, String> {
        let now = workspace::now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let (user_id, created, linked_by_email) = match identity::resolve(
            &tx,
            PROVIDER_GOOGLE,
            sub,
        )? {
            Some(user_id) => (user_id, false, false),
            None => {
                // lower(trim()) like normalize_email: rows written before
                // addresses were normalized must still match.
                let holder: Option<String> = tx
                    .query_row(
                        "SELECT user_id FROM users WHERE lower(trim(email))=?1",
                        params![email],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(db_err)?;
                // An address moves to a login by itself only for an account
                // that has no Google identity yet. One that already has one
                // belongs to THAT subject: a reassigned Workspace address
                // must not hand the previous holder's account to its new
                // holder (nor give the old subject a second owner).
                let already_google = match &holder {
                        Some(holder) => tx
                            .query_row(
                                "SELECT EXISTS(SELECT 1 FROM identities WHERE user_id=?1 AND provider=?2)",
                                params![holder, PROVIDER_GOOGLE],
                                |r| r.get::<_, bool>(0),
                            )
                            .map_err(db_err)?,
                        None => false,
                    };
                // Unlinked from that account by its owner: the address must
                // not hand it straight back.
                let unlinked = match &holder {
                    Some(holder) => identity::gave_up_provider(&tx, PROVIDER_GOOGLE, holder)?,
                    None => false,
                };
                match holder {
                    Some(user_id) if vouched && !already_google && !unlinked => {
                        if self.email_link_blocked(&tx, &user_id)? {
                            return Err(crate::oidc_login::EMAIL_LINK_REFUSED.to_string());
                        }
                        (user_id, false, true)
                    }
                    // Held by someone Google cannot hand this person to: a
                    // new account WITHOUT the address, so the existing one
                    // stays untouched.
                    Some(_) => (create_account(&tx, None, name, now)?, true, false),
                    None => (
                        create_account(&tx, vouched.then_some(email), name, now)?,
                        true,
                        false,
                    ),
                }
            }
        };
        identity::link(&tx, PROVIDER_GOOGLE, sub, &user_id, now)?;
        tx.execute(
            "UPDATE identities SET label=?3 WHERE provider=?1 AND subject=?2",
            params![PROVIDER_GOOGLE, sub, email],
        )
        .map_err(db_err)?;
        // An admin may have opened access for this address before — or after —
        // the account existed: claim it for a missing or waitlisted account,
        // exactly as `ensure_user` does for the HegAI login.
        let mut claimed = false;
        if vouched {
            let state: Option<String> = tx
                .query_row(
                    "SELECT state FROM user_access WHERE user_id=?1",
                    params![user_id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(db_err)?;
            if matches!(state.as_deref(), None | Some("waitlist")) {
                claimed = crate::access::claim_preauthorization(&tx, &user_id, email, now)?;
            }
        }
        if created && !claimed {
            tx.execute(
                "INSERT OR IGNORE INTO user_access(user_id,state,plan,requested_at,updated_at) VALUES(?1,?2,'community',?3,?3)",
                params![user_id, crate::access::new_account_state(domain_vouched), now],
            )
            .map_err(db_err)?;
        }
        if created || linked_by_email {
            if let Some(ws) = crate::access::audit_workspace_in(&tx, &user_id)? {
                insert_audit(
                    &tx,
                    &ws,
                    &user_id,
                    "auth.google",
                    "user",
                    &user_id,
                    &json!({"email": email, "created": created, "linkedByEmail": linked_by_email}),
                )?;
            }
        }
        tx.commit().map_err(db_err)?;
        Ok(EnsuredUser {
            user_id,
            claimed_preauth: claimed,
        })
    }
}

/// A fresh account for a person Google vouches for. Its id is hub-owned
/// (`g-…`), never a platform UUID, like the Telegram ones.
fn create_account(
    conn: &Connection,
    email: Option<&str>,
    name: Option<&str>,
    now: i64,
) -> Result<String, String> {
    let user_id = format!("g-{}", Uuid::new_v4().simple());
    let personal = format!("personal:{user_id}");
    conn.execute(
        "INSERT INTO users(user_id,email,full_name,created_at) VALUES(?1,?2,?3,?4)",
        params![user_id, email, name, now],
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
    Ok(user_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn count(s: &WorkspaceStore, sql: &str) -> i64 {
        let conn = s.conn.lock().unwrap();
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn the_pkce_challenge_is_the_rfc_7636_example() {
        // RFC 7636 appendix B.
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn the_authorize_url_carries_every_binding_and_nothing_secret() {
        let url = authorize_url("cid", "https://x.test/cb?a=b", "st", "no", "ch");
        assert!(url.starts_with(AUTH_URL));
        for part in [
            "client_id=cid",
            "redirect_uri=https%3A%2F%2Fx.test%2Fcb%3Fa%3Db",
            "response_type=code",
            "scope=openid%20email%20profile",
            "state=st",
            "nonce=no",
            "code_challenge=ch",
            "code_challenge_method=S256",
        ] {
            assert!(url.contains(part), "{part} missing from {url}");
        }
    }

    #[test]
    fn begin_remembers_exactly_one_login_per_state_and_take_spends_it() {
        let g = GoogleAuth::from_env_for_test();
        let url = g
            .begin("s1", "https://x.test/cb", "1.2.3.4", None, None, None)
            .unwrap();
        assert!(url.contains("state=s1"));
        let pending = g.take("s1").expect("pending");
        assert_eq!(pending.redirect_uri, "https://x.test/cb");
        assert!(g.take("s1").is_none(), "a state is spent by its callback");
        assert!(g.take("never-issued").is_none());
    }

    impl GoogleAuth {
        fn from_env_for_test() -> Self {
            Self {
                client_id: "cid".into(),
                client_secret: "secret".into(),
                allowed_domains: Vec::new(),
                http: reqwest::Client::new(),
                pending: Mutex::new(HashMap::new()),
                keys: tokio::sync::Mutex::new(None),
                limit: Semaphore::new(1),
                link_tickets: Mutex::new(HashMap::new()),
                staged: Mutex::new(HashMap::new()),
            }
        }
    }

    #[test]
    fn a_new_google_person_gets_a_community_account_with_a_workspace() {
        let s = WorkspaceStore::open_memory();
        let got = s
            .google_login("sub-1", "new@x.test", Some("Новый"), true, false)
            .unwrap();
        assert!(got.user_id.starts_with("g-"));
        assert!(!got.claimed_preauth);
        assert_eq!(
            count(&s, "SELECT COUNT(*) FROM users WHERE email='new@x.test'"),
            1
        );
        assert_eq!(
            count(&s, "SELECT COUNT(*) FROM workspaces WHERE kind='personal'"),
            1
        );
        assert_eq!(
            count(
                &s,
                "SELECT COUNT(*) FROM user_access WHERE plan='community'"
            ),
            1
        );
        // The same person again: the same account, no second row of anything.
        let again = s
            .google_login("sub-1", "new@x.test", None, true, false)
            .unwrap();
        assert_eq!(again.user_id, got.user_id);
        assert_eq!(count(&s, "SELECT COUNT(*) FROM users"), 1);
        assert_eq!(count(&s, "SELECT COUNT(*) FROM identities"), 1);
    }

    #[test]
    fn a_verified_address_opens_the_account_that_already_owns_it_and_is_remembered() {
        let s = WorkspaceStore::open_memory();
        // A HegAI account, as every existing one is.
        s.ensure_user("hegai-uuid", "Owner@x.test", Some("Владелец"))
            .unwrap();
        let got = s
            .google_login("g-sub", "owner@x.test", Some("P"), true, false)
            .unwrap();
        assert_eq!(got.user_id, "hegai-uuid");
        assert_eq!(count(&s, "SELECT COUNT(*) FROM users"), 1);
        assert_eq!(
            count(
                &s,
                "SELECT COUNT(*) FROM identities WHERE provider='google'"
            ),
            1
        );
        // Linked by identity from now on: the address may change under it.
        let later = s
            .google_login("g-sub", "other@x.test", None, true, false)
            .unwrap();
        assert_eq!(later.user_id, "hegai-uuid");
        assert_eq!(count(&s, "SELECT COUNT(*) FROM users"), 1);
        // The audit trail says how it was opened.
        assert_eq!(
            count(
                &s,
                "SELECT COUNT(*) FROM audit_events WHERE action='auth.google'"
            ),
            1
        );
    }

    #[test]
    fn an_account_born_by_google_never_steals_another_one_by_subject() {
        let s = WorkspaceStore::open_memory();
        let a = s
            .google_login("sub-a", "a@x.test", None, true, false)
            .unwrap();
        let b = s
            .google_login("sub-b", "b@x.test", None, true, false)
            .unwrap();
        assert_ne!(a.user_id, b.user_id);
        assert_eq!(count(&s, "SELECT COUNT(*) FROM users"), 2);
    }

    #[test]
    fn only_gmail_and_a_named_workspace_domain_vouch_for_an_address() {
        assert!(google_vouches_for("a@gmail.com", None));
        assert!(google_vouches_for("a@googlemail.com", None));
        assert!(google_vouches_for("a@a.test", Some("a.test")));
        assert!(google_vouches_for("a@a.test", Some("A.test")));
        // Verified once, long ago, on a mailbox Google does not run.
        assert!(!google_vouches_for("a@a.test", None));
        // A Workspace domain cannot vouch for somebody else's domain.
        assert!(!google_vouches_for("a@a.test", Some("evil.test")));
        assert!(!google_vouches_for("not-an-address", Some("x")));
    }

    #[test]
    fn an_unvouched_address_never_opens_the_account_that_holds_it() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("hegai-uuid", "boss@corp.test", Some("Босс"))
            .unwrap();
        let got = s
            .google_login(
                "old-holder-sub",
                "boss@corp.test",
                Some("Бывший"),
                false,
                false,
            )
            .unwrap();
        assert_ne!(
            got.user_id, "hegai-uuid",
            "must not take the holder's account"
        );
        assert!(got.user_id.starts_with("g-"));
        assert_eq!(count(&s, "SELECT COUNT(*) FROM users"), 2);
        // The newcomer carries no address; the holder keeps theirs.
        assert_eq!(
            count(
                &s,
                "SELECT COUNT(*) FROM users WHERE email='boss@corp.test'"
            ),
            1
        );
        assert_eq!(
            count(
                &s,
                "SELECT COUNT(*) FROM identities WHERE provider='google' AND user_id='hegai-uuid'"
            ),
            0
        );
        // Their own subject still opens their own account next time.
        let again = s
            .google_login("old-holder-sub", "boss@corp.test", None, false, false)
            .unwrap();
        assert_eq!(again.user_id, got.user_id);
    }

    #[test]
    fn an_unvouched_new_account_does_not_claim_a_pre_authorization() {
        let s = WorkspaceStore::open_memory();
        {
            let conn = s.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO access_preauth(email,plan,created_by,created_at) VALUES('fresh@corp.test','employee','admin',1)",
                [],
            )
            .unwrap();
        }
        let got = s
            .google_login("sub-x", "fresh@corp.test", None, false, false)
            .unwrap();
        assert!(!got.claimed_preauth);
        assert_eq!(
            count(
                &s,
                "SELECT COUNT(*) FROM access_preauth WHERE claimed_at IS NULL"
            ),
            1
        );
        let vouched = s
            .google_login("sub-y", "fresh@corp.test", None, true, false)
            .unwrap();
        assert!(vouched.claimed_preauth);
    }

    #[test]
    fn one_source_cannot_fill_the_pending_table_for_everybody() {
        let g = GoogleAuth::from_env_for_test();
        for i in 0..MAX_PENDING_PER_SOURCE {
            g.begin(
                &format!("s{i}"),
                "https://x.test/cb",
                "9.9.9.9",
                None,
                None,
                None,
            )
            .unwrap();
        }
        assert!(g
            .begin("one-more", "https://x.test/cb", "9.9.9.9", None, None, None)
            .is_err());
        // Somebody else is unaffected.
        assert!(g
            .begin("other", "https://x.test/cb", "8.8.8.8", None, None, None)
            .is_ok());
    }

    #[test]
    fn a_reassigned_workspace_address_does_not_hand_over_the_old_holders_account() {
        let s = WorkspaceStore::open_memory();
        // The previous holder signed in with Google; the address is later
        // given to somebody else, whose Google account is a new subject.
        let old = s
            .google_login("sub-old", "seat@corp.test", None, true, false)
            .unwrap();
        let new = s
            .google_login("sub-new", "seat@corp.test", None, true, false)
            .unwrap();
        assert_ne!(old.user_id, new.user_id);
        assert_eq!(
            count(
                &s,
                "SELECT COUNT(*) FROM identities WHERE provider='google' AND user_id IN (SELECT user_id FROM users WHERE email='seat@corp.test')"
            ),
            1,
            "the old holder's account keeps exactly its own subject"
        );
    }

    #[test]
    fn an_existing_waitlisted_account_claims_a_later_pre_authorization() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("hegai-uuid", "late@corp.test", None).unwrap();
        {
            let conn = s.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO access_preauth(email,plan,created_by,created_at) VALUES('late@corp.test','employee','admin',1)",
                [],
            )
            .unwrap();
        }
        let got = s
            .google_login("sub-late", "late@corp.test", None, true, false)
            .unwrap();
        assert_eq!(got.user_id, "hegai-uuid");
        assert!(got.claimed_preauth);
    }

    #[test]
    fn a_link_ticket_names_one_account_once_and_binds_into_the_pending_login() {
        let g = GoogleAuth::from_env_for_test();
        let ticket = g.mint_link_ticket("main", "sess").unwrap();
        assert_eq!(
            g.take_link_ticket(&ticket).map(|t| t.0).as_deref(),
            Some("main")
        );
        assert!(g.take_link_ticket(&ticket).is_none(), "one use");
        assert!(g.take_link_ticket("forged").is_none());
        let first = g.mint_link_ticket("main", "sess").unwrap();
        let second = g.mint_link_ticket("main", "sess").unwrap();
        assert!(
            g.take_link_ticket(&first).is_none(),
            "replaced by the next one"
        );
        assert_eq!(
            g.take_link_ticket(&second).map(|t| t.0).as_deref(),
            Some("main")
        );
        for _ in 0..(MAX_LINK_TICKETS * 2) {
            g.mint_link_ticket("spammer", "sess").unwrap();
        }
        assert!(g.mint_link_ticket("someone-else", "sess").is_ok());
        g.begin(
            "s-link",
            "https://x.test/cb",
            "1.2.3.4",
            Some("main".into()),
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            g.take("s-link").unwrap().link_user.as_deref(),
            Some("main"),
            "the callback reads the account from the hub, never from the request"
        );
    }

    #[test]
    fn linking_google_while_signed_in_attaches_it_to_that_account() {
        use crate::identity::Attached;
        let s = WorkspaceStore::open_memory();
        s.ensure_user("main", "main@a.test", None).unwrap();
        assert_eq!(
            s.attach_identity(PROVIDER_GOOGLE, "sub-new", "main", Some("p@gmail.com"))
                .unwrap(),
            Attached::New
        );
        assert_eq!(
            s.google_login("sub-new", "p@gmail.com", None, true, false)
                .unwrap()
                .user_id,
            "main",
            "and the next Google sign-in opens it"
        );
        // An earlier Google sign-in made an empty duplicate: linking moves it.
        let dup = s
            .google_login("sub-dup", "dup@gmail.com", None, true, false)
            .unwrap()
            .user_id;
        assert!(dup.starts_with("g-"));
        assert_eq!(
            s.attach_identity(PROVIDER_GOOGLE, "sub-dup", "main", Some("dup@gmail.com"))
                .unwrap(),
            Attached::Moved {
                from: dup.clone(),
                suspended: true
            }
        );
        assert_eq!(
            s.google_login("sub-dup", "dup@gmail.com", None, true, false)
                .unwrap()
                .user_id,
            "main"
        );
        assert_eq!(s.access_state(&dup).unwrap().state, "suspended");
        assert_eq!(
            s.user_email(&dup),
            None,
            "the duplicate's address is released"
        );
    }

    #[test]
    fn an_unlinked_google_account_does_not_come_back_by_its_address() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("main", "p@gmail.com", None).unwrap();
        // Adopted by address, then unlinked on purpose.
        assert_eq!(
            s.google_login("sub-p", "p@gmail.com", None, true, false)
                .unwrap()
                .user_id,
            "main"
        );
        s.unlink_identity("main", PROVIDER_GOOGLE, None, &[])
            .unwrap();
        let again = s
            .google_login("sub-p", "p@gmail.com", None, true, false)
            .unwrap()
            .user_id;
        assert_ne!(again, "main", "the unlink holds");
        assert_eq!(s.user_email("main").as_deref(), Some("p@gmail.com"));
        // Linking it again from inside the account is explicit and wins —
        // it moves off the empty account the login just made.
        s.attach_identity(PROVIDER_GOOGLE, "sub-p", "main", None)
            .unwrap();
        assert_eq!(
            s.google_login("sub-p", "p@gmail.com", None, true, false)
                .unwrap()
                .user_id,
            "main"
        );
    }

    #[test]
    fn a_google_moved_off_an_account_does_not_come_back_to_it_by_address() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("a", "a@gmail.com", None).unwrap();
        s.ensure_user("b", "b@x", None).unwrap();
        // A keeps HegAI and its address; its Google moves to B, then B drops it.
        assert_eq!(
            s.google_login("sub-a", "a@gmail.com", None, true, false)
                .unwrap()
                .user_id,
            "a"
        );
        assert_eq!(
            s.attach_identity(PROVIDER_GOOGLE, "sub-a", "b", None)
                .unwrap(),
            identity::Attached::Moved {
                from: "a".into(),
                suspended: false
            },
            "A still has HegAI, so it stays open"
        );
        s.unlink_identity("b", PROVIDER_GOOGLE, None, &[]).unwrap();
        assert_ne!(
            s.google_login("sub-a", "a@gmail.com", None, true, false)
                .unwrap()
                .user_id,
            "a",
            "A gave this Google up; its address does not hand A back"
        );
    }

    #[test]
    fn after_an_unlink_no_google_subject_adopts_the_account_by_address() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("main", "boss@corp.test", None).unwrap();
        s.attach_identity(PROVIDER_GOOGLE, "old-sub", "main", None)
            .unwrap();
        s.unlink_identity("main", PROVIDER_GOOGLE, None, &[])
            .unwrap();
        // The Workspace mailbox now belongs to someone else's Google account.
        let new_holder = s
            .google_login("new-sub", "boss@corp.test", None, true, false)
            .unwrap()
            .user_id;
        assert_ne!(new_holder, "main");
    }

    #[test]
    fn a_link_callback_needs_the_state_cookie_of_the_browser_that_began_it() {
        let mut headers = HeaderMap::new();
        assert!(
            !link_state_proven(&headers, "st-1", true),
            "no cookie: someone else's browser"
        );
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("{SSO_STATE_COOKIE}=st-other")).unwrap(),
        );
        assert!(
            !link_state_proven(&headers, "st-1", true),
            "another login's cookie"
        );
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("{SSO_STATE_COOKIE}=st-1")).unwrap(),
        );
        assert!(link_state_proven(&headers, "st-1", true));
        assert!(!link_state_proven(&headers, "", true));
    }

    #[test]
    fn a_staged_native_link_is_spent_once_and_only_by_its_minting_session() {
        let g = GoogleAuth::from_env_for_test();
        let staged = |user: &str| StagedLink {
            user: user.into(),
            session_hash: "sess-a".into(),
            sub: "sub-v".into(),
            label: "v@gmail.com".into(),
            created: Instant::now(),
        };
        let token = g.stage_link(staged("a")).unwrap();
        let got = g.take_staged(&token).unwrap();
        assert_eq!(
            (got.user.as_str(), got.session_hash.as_str()),
            ("a", "sess-a")
        );
        assert!(g.take_staged(&token).is_none(), "one use");
        assert!(g.take_staged("forged").is_none());
        // A new stage for the same account replaces the old one.
        let held = g.stage_link(staged("a")).unwrap();
        assert!(
            g.take_staged_for(&held, "a", "sess-other").is_none(),
            "another session"
        );
        assert!(
            g.take_staged_for(&held, "b", "sess-a").is_none(),
            "another account"
        );
        assert!(
            g.take_staged_for(&held, "a", "sess-a").is_some(),
            "kept for the real app"
        );
        let first = g.stage_link(staged("a")).unwrap();
        let _second = g.stage_link(staged("a")).unwrap();
        assert!(g.take_staged(&first).is_none());
    }

    #[test]
    fn external_edition_access_follows_the_domain_list_and_protects_the_owner() {
        use crate::edition::{with_edition, Edition};
        with_edition(Edition::External, || {
            let s = WorkspaceStore::open_memory();
            // GOOGLE_ALLOWED_DOMAINS covered the address: active
            let listed = s
                .google_login("g1", "ann@corp.test", None, true, true)
                .unwrap();
            assert_eq!(s.access_state(&listed.user_id).unwrap().state, "active");
            // no list (anyone with a Google account): the owner approves
            let anyone = s
                .google_login("g2", "bob@gmail.com", None, true, false)
                .unwrap();
            assert_eq!(s.access_state(&anyone.user_id).unwrap().state, "waitlist");
            // the owner's account is never taken over by address
            s.ensure_user_vouched("boss", "boss@corp.test", None, true)
                .unwrap();
            s.set_always_active(["boss".to_string()]);
            assert_eq!(
                s.google_login("g3", "boss@corp.test", None, true, true)
                    .unwrap_err(),
                crate::oidc_login::EMAIL_LINK_REFUSED
            );
            // a plain account is still matched
            s.ensure_user("plain", "plain@corp.test", None).unwrap();
            assert_eq!(
                s.google_login("g4", "plain@corp.test", None, true, true)
                    .unwrap()
                    .user_id,
                "plain"
            );
        });
    }
}
