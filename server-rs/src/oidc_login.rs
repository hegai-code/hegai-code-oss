//! Sign in with any OpenID Connect provider (Google Workspace, Keycloak,
//! Entra ID, Authentik, …): authorization code + PKCE, finished on the hub, the
//! same hops as Google (`/api/auth/oidc/{start,callback}` through
//! `begin_login` / `check_login_state` / `finish_login`), so the browser, the
//! apps and the desktop shells all come back the way they already do.
//!
//! Configuration is the customer's, all through the environment:
//!
//! | variable | meaning |
//! |---|---|
//! | `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | all three or none |
//! | `OIDC_DISPLAY_NAME` | the button's name (default `SSO`) |
//! | `OIDC_SCOPES` | default `openid email profile` |
//! | `OIDC_ALLOWED_DOMAINS` | comma list; the address AND (when present) `hd` must match |
//! | `OIDC_TRUST_UNVERIFIED_EMAIL=1` | accept a token with no `email_verified` claim |
//!
//! The hub fetches `{issuer}/.well-known/openid-configuration` (cached), the
//! JWKS (cached, refetched at most once a minute for an unknown key) and
//! verifies RS256 / ES256 signatures, `iss`, `aud`, `exp` and the nonce.
//!
//! Who the person IS: a known `(oidc:<issuer>, sub)` opens its account. A new
//! subject opens an existing account by its address ONLY when the address is in
//! `OIDC_ALLOWED_DOMAINS` (the customer vouches for those mailboxes); with no
//! list set every login is a new account of its own, without an address.

use super::*;
use jsonwebtoken::jwk::JwkSet;
use rusqlite::{params, OptionalExtension};

use crate::provisioning_api::ct_eq;
use crate::workspace::{db_err, insert_audit, normalize_email, opaque_token, EnsuredUser};

const PENDING_TTL: Duration = Duration::from_secs(600);
const MAX_PENDING: usize = 512;
const MAX_PENDING_PER_SOURCE: usize = 20;
const DISCOVERY_TTL: Duration = Duration::from_secs(3600);
const JWKS_TTL: Duration = Duration::from_secs(3600);
const JWKS_MIN_REFETCH: Duration = Duration::from_secs(60);

// ------------------------------------------------------------ domain rules

/// `Acme.com, @example.org` -> `["acme.com", "example.org"]`.
pub(crate) fn parse_domains(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or("")
        .split(',')
        .map(|d| d.trim().trim_start_matches('@').to_ascii_lowercase())
        .filter(|d| !d.is_empty())
        .collect()
}

/// Whether a login may proceed for `email` under a domain list. An empty list
/// is "no restriction" (and vouches for nobody; `require_hd` has nothing to
/// compare against then). Otherwise the address's domain
/// must be listed and, when the provider names a hosted domain (`hd`), that one
/// must be listed too. `require_hd` (Google's issuer, `OIDC_REQUIRE_HD=1`,
/// `GOOGLE_ALLOWED_DOMAINS`) makes `hd` mandatory: a consumer Google account
/// can carry a corporate address as its login, but has no hosted domain, so the
/// address alone proves nothing about who controls the mailbox.
pub(crate) fn domain_allowed(
    email: &str,
    hd: Option<&str>,
    allowed: &[String],
    require_hd: bool,
) -> bool {
    let hd = hd.map(str::trim).filter(|h| !h.is_empty());
    if allowed.is_empty() {
        return true;
    }
    let Some((_, domain)) = email.rsplit_once('@') else {
        return false;
    };
    let listed = |d: &str| allowed.iter().any(|a| a.eq_ignore_ascii_case(d));
    if require_hd && hd.is_none() {
        return false;
    }
    listed(domain) && hd.is_none_or(listed)
}

/// An address-based link to an account that has its own way in (a local
/// password) or is the owner/an admin is never made by a login: it could only
/// be made from inside an already signed-in session, which is not built yet.
pub(crate) const EMAIL_LINK_REFUSED: &str = "Этот адрес принадлежит учётной записи с входом по паролю или администратору. Войдите в неё обычным способом — привязать вход через провайдера автоматически нельзя.";

impl WorkspaceStore {
    /// External edition only: would linking a new subject to `holder` by address
    /// be a takeover path? (Reads the open transaction.)
    pub(crate) fn email_link_blocked(
        &self,
        tx: &rusqlite::Connection,
        holder: &str,
    ) -> Result<bool, String> {
        if !crate::edition::is_external() {
            return Ok(false);
        }
        if self.is_privileged(holder) {
            return Ok(true);
        }
        tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM local_credentials WHERE user_id=?1)",
            params![holder],
            |r| r.get(0),
        )
        .map_err(db_err)
    }
}

// ----------------------------------------------------------------- claims

#[derive(Deserialize)]
pub(crate) struct OidcClaims {
    sub: String,
    #[serde(default)]
    email: Option<String>,
    /// A boolean at most providers, the string "true" at a few.
    #[serde(default)]
    email_verified: Option<Value>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    nonce: Option<String>,
    #[serde(default)]
    hd: Option<String>,
}

/// A login the policy let through.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Accepted {
    pub sub: String,
    pub email: String,
    pub name: Option<String>,
    /// The customer's domain list covers this address, so it may open an
    /// existing account and be recorded on a new one.
    pub vouched: bool,
}

fn verified_flag(v: &Option<Value>) -> Option<bool> {
    match v {
        Some(Value::Bool(b)) => Some(*b),
        Some(Value::String(s)) => Some(s.eq_ignore_ascii_case("true")),
        _ => None,
    }
}

/// The hub's policy over a verified token.
pub(crate) fn accept(
    claims: &OidcClaims,
    allowed: &[String],
    trust_unverified: bool,
    require_hd: bool,
) -> Result<Accepted, &'static str> {
    let email = claims
        .email
        .as_deref()
        .map(normalize_email)
        .filter(|e| e.contains('@') && e.len() <= 254)
        .ok_or("Провайдер входа не передал адрес почты — войти нельзя.")?;
    match verified_flag(&claims.email_verified) {
        Some(true) => {}
        None if trust_unverified => {}
        _ => return Err("Провайдер входа не подтвердил адрес почты — войти нельзя."),
    }
    if !domain_allowed(&email, claims.hd.as_deref(), allowed, require_hd) {
        return Err("Адрес почты не входит в список разрешённых доменов.");
    }
    Ok(Accepted {
        sub: claims.sub.clone(),
        email,
        name: claims
            .name
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(|n| n.chars().take(120).collect()),
        vouched: !allowed.is_empty(),
    })
}

/// Google as an OIDC issuer: a consumer account has no `hd`.
pub(crate) fn is_google_issuer(issuer: &str) -> bool {
    matches!(
        issuer.trim_end_matches('/'),
        "https://accounts.google.com" | "accounts.google.com"
    )
}

fn allowed_alg(alg: Algorithm) -> bool {
    matches!(alg, Algorithm::RS256 | Algorithm::ES256)
}

/// Signature, `iss`, `aud`, `exp` and nonce. The algorithm comes from the
/// token's header but must be on the whitelist, and `jsonwebtoken` refuses a
/// key of another family — a token cannot pick its own verification.
fn verify_claims(
    token: &str,
    alg: Algorithm,
    key: &DecodingKey,
    issuer: &str,
    audience: &str,
    nonce: &str,
) -> Result<OidcClaims, &'static str> {
    if !allowed_alg(alg) {
        return Err("invalid identity algorithm");
    }
    let mut validation = Validation::new(alg);
    validation.set_audience(&[audience]);
    validation.set_issuer(&[issuer]);
    validation.leeway = 30;
    validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
    let claims = decode::<OidcClaims>(token, key, &validation)
        .map_err(|_| "invalid identity")?
        .claims;
    if claims.sub.is_empty()
        || claims.sub.len() > 255
        || !claims
            .nonce
            .as_deref()
            .is_some_and(|n| ct_eq(n.as_bytes(), nonce.as_bytes()))
    {
        return Err("identity does not match this sign-in");
    }
    Ok(claims)
}

// -------------------------------------------------------------- discovery

#[derive(Clone, Deserialize)]
struct Discovery {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
    #[serde(default)]
    token_endpoint_auth_methods_supported: Option<Vec<String>>,
}

/// https, or plain http to this machine (a dev IdP).
fn secure_url(url: &str) -> bool {
    if url.starts_with("https://") {
        return true;
    }
    url.starts_with("http://") && origin_host(url).is_some_and(|h| is_loopback_host(&h))
}

fn same_issuer(a: &str, b: &str) -> bool {
    a.trim_end_matches('/') == b.trim_end_matches('/')
}

fn validate_discovery(doc: &Discovery, configured_issuer: &str) -> Result<(), &'static str> {
    if !same_issuer(&doc.issuer, configured_issuer) {
        return Err("the provider's issuer does not match OIDC_ISSUER");
    }
    for url in [
        &doc.authorization_endpoint,
        &doc.token_endpoint,
        &doc.jwks_uri,
    ] {
        if !secure_url(url) {
            return Err("the provider advertises an insecure endpoint");
        }
    }
    Ok(())
}

impl Discovery {
    /// RFC 8414: client_secret_basic is the default, but most providers take
    /// the post form; use basic only when the provider lists it and not post.
    fn wants_basic_auth(&self) -> bool {
        self.token_endpoint_auth_methods_supported
            .as_ref()
            .is_some_and(|m| {
                m.iter().any(|x| x == "client_secret_basic")
                    && !m.iter().any(|x| x == "client_secret_post")
            })
    }
}

// ------------------------------------------------------------------ state

struct Pending {
    source: String,
    verifier: String,
    nonce: String,
    redirect_uri: String,
    created: Instant,
}

pub(crate) struct OidcAuth {
    issuer: String,
    /// `identities.provider` of every account this provider opens.
    pub(crate) provider: String,
    client_id: String,
    client_secret: String,
    pub(crate) name: String,
    scopes: String,
    allowed_domains: Vec<String>,
    trust_unverified: bool,
    /// The token's `hd` claim is mandatory: always for Google's own issuer,
    /// `OIDC_REQUIRE_HD=1` for any other.
    require_hd: bool,
    http: reqwest::Client,
    pending: Mutex<HashMap<String, Pending>>,
    discovery: tokio::sync::Mutex<Option<(Instant, Discovery)>>,
    keys: tokio::sync::Mutex<Option<(Instant, JwkSet)>>,
    limit: Semaphore,
}

#[derive(Deserialize)]
struct TokenResponse {
    id_token: String,
}

impl OidcAuth {
    /// `None` when unconfigured. A half configuration is a typo worth
    /// refusing to start over.
    pub fn from_env() -> Result<Option<Arc<Self>>, String> {
        let var = |k: &str| {
            std::env::var(k)
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        let (issuer, id, secret) = (
            var("OIDC_ISSUER"),
            var("OIDC_CLIENT_ID"),
            var("OIDC_CLIENT_SECRET"),
        );
        let (issuer, client_id, client_secret) = match (issuer, id, secret) {
            (None, None, None) => return Ok(None),
            (Some(i), Some(c), Some(s)) => (i, c, s),
            _ => {
                return Err(
                    "incomplete OIDC configuration: OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET go together"
                        .into(),
                )
            }
        };
        if !secure_url(&issuer) {
            return Err("OIDC_ISSUER must be an https URL".into());
        }
        let issuer = issuer.trim_end_matches('/').to_string();
        let require_hd =
            is_google_issuer(&issuer) || var("OIDC_REQUIRE_HD").as_deref() == Some("1");
        Ok(Some(Arc::new(Self {
            provider: format!("oidc:{issuer}"),
            issuer,
            client_id,
            client_secret,
            name: var("OIDC_DISPLAY_NAME").unwrap_or_else(|| "SSO".to_string()),
            scopes: var("OIDC_SCOPES").unwrap_or_else(|| "openid email profile".to_string()),
            allowed_domains: parse_domains(var("OIDC_ALLOWED_DOMAINS").as_deref()),
            trust_unverified: var("OIDC_TRUST_UNVERIFIED_EMAIL").as_deref() == Some("1"),
            require_hd,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "OIDC HTTP configuration".to_string())?,
            pending: Mutex::new(HashMap::new()),
            discovery: tokio::sync::Mutex::new(None),
            keys: tokio::sync::Mutex::new(None),
            limit: Semaphore::new(8),
        })))
    }

    async fn discovery(&self) -> Result<Discovery, &'static str> {
        let mut cache = self.discovery.lock().await;
        if let Some((t, doc)) = cache.as_ref() {
            if t.elapsed() < DISCOVERY_TTL {
                return Ok(doc.clone());
            }
        }
        let fetched = async {
            let url = format!("{}/.well-known/openid-configuration", self.issuer);
            let response = self.http.get(url).send().await.ok()?;
            if !response.status().is_success() {
                return None;
            }
            response.json::<Discovery>().await.ok()
        }
        .await;
        match fetched {
            Some(doc) => {
                validate_discovery(&doc, &self.issuer)?;
                *cache = Some((Instant::now(), doc.clone()));
                Ok(doc)
            }
            // A provider that blinks keeps working on what we already know.
            None => cache
                .as_ref()
                .map(|(_, doc)| doc.clone())
                .ok_or("the sign-in provider is unavailable"),
        }
    }

    fn begin(
        &self,
        disc: &Discovery,
        state: &str,
        redirect_uri: &str,
        source: &str,
    ) -> Result<String, &'static str> {
        let verifier = format!("{}{}", opaque_token(), opaque_token());
        let nonce = opaque_token();
        let challenge = crate::google_login::pkce_challenge(&verifier);
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
                    verifier,
                    nonce: nonce.clone(),
                    redirect_uri: redirect_uri.to_string(),
                    created: Instant::now(),
                },
            );
        }
        Ok(authorize_url(
            &disc.authorization_endpoint,
            &self.client_id,
            redirect_uri,
            state,
            &nonce,
            &challenge,
            &self.scopes,
        ))
    }

    fn take(&self, state: &str) -> Option<Pending> {
        let mut values = self.pending.lock().ok()?;
        values.retain(|_, p| p.created.elapsed() < PENDING_TTL);
        values.remove(state)
    }

    async fn exchange(&self, code: &str, pending: &Pending) -> Result<OidcClaims, &'static str> {
        let disc = self.discovery().await?;
        let mut form = vec![
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", pending.redirect_uri.as_str()),
            ("code_verifier", pending.verifier.as_str()),
        ];
        let mut request = self.http.post(&disc.token_endpoint);
        if disc.wants_basic_auth() {
            request = request.basic_auth(
                urlencoding::encode(&self.client_id).into_owned(),
                Some(urlencoding::encode(&self.client_secret).into_owned()),
            );
        } else {
            form.push(("client_id", self.client_id.as_str()));
            form.push(("client_secret", self.client_secret.as_str()));
        }
        let response = request
            .form(&form)
            .send()
            .await
            .map_err(|_| "the sign-in provider is unavailable")?;
        if !response.status().is_success() {
            return Err("the sign-in provider refused the code");
        }
        let token = response
            .json::<TokenResponse>()
            .await
            .map_err(|_| "the sign-in provider answered unexpectedly")?
            .id_token;
        self.verify(&token, &pending.nonce, &disc).await
    }

    async fn verify(
        &self,
        token: &str,
        nonce: &str,
        disc: &Discovery,
    ) -> Result<OidcClaims, &'static str> {
        let header = jsonwebtoken::decode_header(token).map_err(|_| "invalid identity")?;
        if !allowed_alg(header.alg) {
            return Err("invalid identity algorithm");
        }
        let mut cache = self.keys.lock().await;
        let find = |keys: &JwkSet| match header.kid.as_deref() {
            Some(kid) => keys.find(kid).cloned(),
            // No `kid`: only unambiguous when the provider publishes one key.
            None if keys.keys.len() == 1 => keys.keys.first().cloned(),
            None => None,
        };
        let known = cache
            .as_ref()
            .is_some_and(|(t, keys)| t.elapsed() <= JWKS_TTL && find(keys).is_some());
        // An unknown key may simply be new: refetch, but not on every bad
        // token (a forged `kid` must not become a request per attempt).
        let may_refetch = cache
            .as_ref()
            .is_none_or(|(t, _)| t.elapsed() > JWKS_MIN_REFETCH);
        if !known && may_refetch {
            let response = self
                .http
                .get(&disc.jwks_uri)
                .send()
                .await
                .map_err(|_| "signing keys unavailable")?;
            if !response.status().is_success() {
                return Err("signing keys unavailable");
            }
            let keys = response
                .json::<JwkSet>()
                .await
                .map_err(|_| "signing keys unavailable")?;
            *cache = Some((Instant::now(), keys));
        }
        let jwk = cache
            .as_ref()
            .and_then(|(_, keys)| find(keys))
            .ok_or("unknown signing key")?;
        let key = DecodingKey::from_jwk(&jwk).map_err(|_| "invalid signing key")?;
        verify_claims(
            token,
            header.alg,
            &key,
            &disc.issuer,
            &self.client_id,
            nonce,
        )
    }
}

fn authorize_url(
    endpoint: &str,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    nonce: &str,
    challenge: &str,
    scopes: &str,
) -> String {
    let sep = if endpoint.contains('?') { '&' } else { '?' };
    format!(
        "{endpoint}{sep}client_id={}&redirect_uri={}&response_type=code&scope={}&state={}&nonce={}\
         &code_challenge={}&code_challenge_method=S256",
        urlencoding::encode(client_id),
        urlencoding::encode(redirect_uri),
        urlencoding::encode(scopes),
        urlencoding::encode(state),
        urlencoding::encode(nonce),
        urlencoding::encode(challenge),
    )
}

// ------------------------------------------------------------------- HTTP

fn not_configured() -> Response {
    api_error(
        StatusCode::NOT_FOUND,
        "Вход через SSO на этом сервере не настроен.",
    )
}

/// `GET /api/auth/oidc/start` — a redirect to the provider.
pub(crate) async fn start(
    axum::extract::ConnectInfo(peer): axum::extract::ConnectInfo<std::net::SocketAddr>,
    Query(params): Query<HashMap<String, String>>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let Some(oidc) = st.oidc_auth.as_ref() else {
        return not_configured();
    };
    let state = match begin_login(&st, peer, &params, &headers) {
        Ok(v) => v,
        Err(response) => return response,
    };
    let disc = match oidc.discovery().await {
        Ok(d) => d,
        Err(error) => {
            eprintln!("[auth] OIDC discovery failed: {error}");
            return refusal(StatusCode::BAD_GATEWAY, error);
        }
    };
    let forwarded_host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(header::HOST))
        .and_then(|v| v.to_str().ok());
    let redirect_uri = format!(
        "{}/api/auth/oidc/callback",
        callback_origin(&st.public_url, &[], &st.lite_hosts, forwarded_host)
    );
    let location = match oidc.begin(
        &disc,
        &state,
        &redirect_uri,
        &client_address(peer, &headers),
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

/// `GET /api/auth/oidc/callback` — the provider's answer.
pub(crate) async fn callback(
    Query(params): Query<HashMap<String, String>>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let Some(oidc) = st.oidc_auth.as_ref() else {
        return not_configured();
    };
    // The permit comes BEFORE any one-use state is spent: a busy answer must
    // leave the person able to retry the very same callback.
    let permit = if params.contains_key("code") && !params.contains_key("error") {
        match oidc.limit.try_acquire() {
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
        eprintln!("[auth] OIDC provider refused the sign-in: {reason:?}");
        oidc.take(&state);
        return api_error(
            StatusCode::UNAUTHORIZED,
            "Провайдер входа не подтвердил вход. Вернитесь и попробуйте ещё раз.",
        );
    }
    let Some(code) = params.get("code").filter(|c| !c.is_empty()) else {
        return api_error(StatusCode::BAD_REQUEST, "missing sign-in code");
    };
    let Some(pending) = oidc.take(&state) else {
        return api_error(StatusCode::BAD_REQUEST, "invalid or expired sign-in");
    };
    let claims = match oidc.exchange(code, &pending).await {
        Ok(v) => v,
        Err(error) => {
            eprintln!("[auth] OIDC sign-in failed: {error}");
            return refusal(StatusCode::UNAUTHORIZED, error);
        }
    };
    drop(permit);
    let accepted = match accept(
        &claims,
        &oidc.allowed_domains,
        oidc.trust_unverified,
        oidc.require_hd,
    ) {
        Ok(a) => a,
        Err(reason) => {
            eprintln!("[auth] OIDC sign-in refused: {reason}");
            return refusal(StatusCode::FORBIDDEN, reason);
        }
    };
    let ensured = match st.workspaces.oidc_login(&oidc.provider, &accepted) {
        Ok(v) => v,
        Err(error) if error == EMAIL_LINK_REFUSED => {
            eprintln!(
                "[auth] OIDC sign-in refused: {} would take over a protected account",
                accepted.email
            );
            return refusal(StatusCode::FORBIDDEN, error);
        }
        Err(error) => return store_failure(error),
    };
    if ensured.claimed_preauth {
        println!(
            "[access] preauthorized {} activated at first SSO login",
            accepted.email
        );
        access_api::after_activate_hooks(&st, &ensured.user_id);
    }
    finish_login(
        &st,
        &state,
        native,
        android,
        &ensured.user_id,
        Some((oidc.provider.as_str(), accepted.sub.as_str())),
        &headers,
        crate::mfa::Factor::Unproven,
    )
}

impl WorkspaceStore {
    /// Resolve an OIDC login to an account — see the module doc for the rule.
    pub fn oidc_login(&self, provider: &str, a: &Accepted) -> Result<EnsuredUser, String> {
        let now = workspace::now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let (user_id, created, linked_by_email) = match identity::resolve(&tx, provider, &a.sub)? {
            Some(user_id) => (user_id, false, false),
            None => {
                let holder: Option<String> = if a.vouched {
                    tx.query_row(
                        "SELECT user_id FROM users WHERE lower(trim(email))=?1",
                        params![a.email],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(db_err)?
                } else {
                    None
                };
                match holder {
                    Some(holder) => {
                        // An address moves to a login by itself only for an
                        // account that has none of this provider yet, and was
                        // not unlinked from it on purpose.
                        let already: bool = tx
                            .query_row(
                                "SELECT EXISTS(SELECT 1 FROM identities WHERE user_id=?1 AND provider=?2)",
                                params![holder, provider],
                                |r| r.get(0),
                            )
                            .map_err(db_err)?;
                        let unlinked = identity::gave_up_provider(&tx, provider, &holder)?;
                        if !already && !unlinked && self.email_link_blocked(&tx, &holder)? {
                            return Err(EMAIL_LINK_REFUSED.to_string());
                        }
                        if already || unlinked {
                            let id = crate::local_login::create_hub_account(
                                &tx,
                                "o",
                                None,
                                a.name.as_deref(),
                                now,
                                a.vouched,
                            )?;
                            (id, true, false)
                        } else {
                            (holder, false, true)
                        }
                    }
                    None => {
                        let id = crate::local_login::create_hub_account(
                            &tx,
                            "o",
                            a.vouched.then_some(a.email.as_str()),
                            a.name.as_deref(),
                            now,
                            a.vouched,
                        )?;
                        (id, true, false)
                    }
                }
            }
        };
        identity::link(&tx, provider, &a.sub, &user_id, now)?;
        tx.execute(
            "UPDATE identities SET label=?3 WHERE provider=?1 AND subject=?2",
            params![provider, a.sub, a.email],
        )
        .map_err(db_err)?;
        let mut claimed = false;
        if a.vouched {
            let state: Option<String> = tx
                .query_row(
                    "SELECT state FROM user_access WHERE user_id=?1",
                    params![user_id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(db_err)?;
            if matches!(state.as_deref(), None | Some("waitlist")) {
                claimed = crate::access::claim_preauthorization(&tx, &user_id, &a.email, now)?;
            }
        }
        if created || linked_by_email {
            if let Some(ws) = crate::access::audit_workspace_in(&tx, &user_id)? {
                insert_audit(
                    &tx,
                    &ws,
                    &user_id,
                    "auth.oidc",
                    "user",
                    &user_id,
                    &json!({"email": a.email, "provider": provider, "created": created, "linkedByEmail": linked_by_email}),
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

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use ring::rand::SystemRandom;
    use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};

    const ISS: &str = "https://idp.acme.test/realms/acme";
    const AUD: &str = "hegai-code";
    const NONCE: &str = "n-123";

    /// A throwaway P-256 key: the signing half for tokens and the public half
    /// as a JWK, so the whole `kid` -> `DecodingKey::from_jwk` path runs.
    struct Idp {
        enc: EncodingKey,
        jwks: JwkSet,
    }

    fn idp() -> Idp {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
        let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng)
            .unwrap();
        let public = pair.public_key().as_ref();
        assert_eq!(public.len(), 65);
        let jwks: JwkSet = serde_json::from_value(json!({"keys": [{
            "kty": "EC", "crv": "P-256", "kid": "k1", "use": "sig", "alg": "ES256",
            "x": URL_SAFE_NO_PAD.encode(&public[1..33]),
            "y": URL_SAFE_NO_PAD.encode(&public[33..65]),
        }]}))
        .unwrap();
        Idp {
            enc: EncodingKey::from_ec_der(pkcs8.as_ref()),
            jwks,
        }
    }

    fn now() -> i64 {
        workspace::now_ms() / 1000
    }

    fn token(idp: &Idp, claims: Value) -> String {
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some("k1".into());
        encode(&header, &claims, &idp.enc).unwrap()
    }

    fn claims(extra: Value) -> Value {
        let mut base = json!({
            "iss": ISS, "aud": AUD, "sub": "u-1", "exp": now() + 300, "nonce": NONCE,
            "email": "Anna@Acme.Test", "email_verified": true, "name": "Anna",
        });
        for (k, v) in extra.as_object().unwrap() {
            if v.is_null() {
                base.as_object_mut().unwrap().remove(k);
            } else {
                base[k] = v.clone();
            }
        }
        base
    }

    fn check(idp: &Idp, tok: &str) -> Result<OidcClaims, &'static str> {
        let jwk = idp.jwks.find("k1").unwrap();
        let key = DecodingKey::from_jwk(jwk).unwrap();
        let alg = jsonwebtoken::decode_header(tok).map_err(|_| "header")?.alg;
        verify_claims(tok, alg, &key, ISS, AUD, NONCE)
    }

    #[test]
    fn a_good_es256_token_verifies_and_every_binding_is_enforced() {
        let idp = idp();
        let ok = check(&idp, &token(&idp, claims(json!({})))).unwrap();
        assert_eq!(ok.sub, "u-1");
        for (what, extra) in [
            ("issuer", json!({"iss": "https://evil.test"})),
            ("audience", json!({"aud": "someone-else"})),
            ("expiry", json!({"exp": now() - 3600})),
            ("nonce", json!({"nonce": "other"})),
            ("missing nonce", json!({"nonce": null})),
            ("empty subject", json!({"sub": ""})),
        ] {
            assert!(check(&idp, &token(&idp, claims(extra))).is_err(), "{what}");
        }
        // another key's signature
        let other = Idp {
            enc: idp_enc(),
            jwks: idp.jwks.clone(),
        };
        assert!(check(&idp, &token(&other, claims(json!({})))).is_err());
        // a plain `aud` array that includes ours is fine
        assert!(check(&idp, &token(&idp, claims(json!({"aud": [AUD, "x"]})))).is_ok());
    }

    fn idp_enc() -> EncodingKey {
        idp().enc
    }

    #[test]
    fn only_rs256_and_es256_are_accepted_and_a_token_cannot_choose_hmac() {
        assert!(allowed_alg(Algorithm::RS256));
        assert!(allowed_alg(Algorithm::ES256));
        for alg in [
            Algorithm::HS256,
            Algorithm::HS512,
            Algorithm::RS512,
            Algorithm::ES384,
            Algorithm::PS256,
            Algorithm::EdDSA,
        ] {
            assert!(!allowed_alg(alg), "{alg:?}");
        }
        // alg confusion: an HS256 token "signed" with the public key bytes
        let idp = idp();
        let forged = encode(
            &Header::new(Algorithm::HS256),
            &claims(json!({})),
            &EncodingKey::from_secret(b"public-key-bytes"),
        )
        .unwrap();
        assert!(check(&idp, &forged).is_err());
        // and an RS256 header over an EC key is refused by the key family
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some("k1".into());
        let key = DecodingKey::from_jwk(idp.jwks.find("k1").unwrap()).unwrap();
        let fake = format!(
            "{}.{}.AAAA",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).unwrap()),
            URL_SAFE_NO_PAD.encode(claims(json!({})).to_string())
        );
        assert!(verify_claims(&fake, Algorithm::RS256, &key, ISS, AUD, NONCE).is_err());
    }

    fn parsed(extra: Value) -> OidcClaims {
        serde_json::from_value(claims(extra)).unwrap()
    }

    #[test]
    fn email_and_domain_policy() {
        let none: Vec<String> = vec![];
        let acme = parse_domains(Some(" Acme.test, @other.org ,"));
        assert_eq!(acme, ["acme.test", "other.org"]);
        // verified address, no list: accepted, not vouched
        let a = accept(&parsed(json!({})), &none, false, false).unwrap();
        assert_eq!((a.email.as_str(), a.vouched), ("anna@acme.test", false));
        // with a list: vouched
        assert!(
            accept(&parsed(json!({})), &acme, false, false)
                .unwrap()
                .vouched
        );
        // not in the list
        assert!(accept(
            &parsed(json!({"email": "bob@gmail.com"})),
            &acme,
            false,
            false
        )
        .is_err());
        // hd must match too when present
        assert!(accept(&parsed(json!({"hd": "acme.test"})), &acme, false, false).is_ok());
        assert!(accept(&parsed(json!({"hd": "evil.test"})), &acme, false, false).is_err());
        // unverified / absent / string forms
        assert!(accept(
            &parsed(json!({"email_verified": false})),
            &none,
            false,
            false
        )
        .is_err());
        assert!(
            accept(
                &parsed(json!({"email_verified": false})),
                &none,
                true,
                false
            )
            .is_err(),
            "false is never trusted"
        );
        assert!(accept(
            &parsed(json!({"email_verified": null})),
            &none,
            false,
            false
        )
        .is_err());
        assert!(accept(&parsed(json!({"email_verified": null})), &none, true, false).is_ok());
        assert!(accept(
            &parsed(json!({"email_verified": "true"})),
            &none,
            false,
            false
        )
        .is_ok());
        assert!(accept(
            &parsed(json!({"email_verified": "false"})),
            &none,
            false,
            false
        )
        .is_err());
        // no address at all
        assert!(accept(&parsed(json!({"email": null})), &none, true, false).is_err());
        assert!(accept(
            &parsed(json!({"email": "not-an-address"})),
            &none,
            true,
            false
        )
        .is_err());
    }

    #[test]
    fn the_domain_rule_is_shared_with_google() {
        let list = parse_domains(Some("acme.test"));
        assert!(
            domain_allowed("a@gmail.com", None, &[], false),
            "unset = unchanged"
        );
        assert!(domain_allowed("a@acme.test", None, &list, false));
        assert!(domain_allowed(
            "a@ACME.test",
            Some("Acme.Test"),
            &list,
            false
        ));
        assert!(!domain_allowed("a@gmail.com", None, &list, false));
        assert!(!domain_allowed(
            "a@acme.test",
            Some("evil.test"),
            &list,
            false
        ));
        assert!(!domain_allowed("no-at-sign", None, &list, false));
        assert!(domain_allowed("a@acme.test", Some(""), &list, false));
    }

    #[test]
    fn a_required_hd_must_be_present_and_listed() {
        let list = parse_domains(Some("acme.test"));
        // a consumer Google account on a corporate address has no hd
        assert!(domain_allowed("a@acme.test", None, &list, false));
        assert!(!domain_allowed("a@acme.test", None, &list, true));
        assert!(!domain_allowed("a@acme.test", Some(""), &list, true));
        assert!(!domain_allowed(
            "a@acme.test",
            Some("evil.test"),
            &list,
            true
        ));
        assert!(domain_allowed(
            "a@acme.test",
            Some("Acme.Test"),
            &list,
            true
        ));
        // no list, nothing to compare: unchanged
        assert!(domain_allowed("a@gmail.com", None, &[], true));
        let none = parse_domains(None);
        assert!(accept(&parsed(json!({})), &list, false, true).is_err());
        assert!(accept(&parsed(json!({"hd": "acme.test"})), &list, false, true).is_ok());
        assert!(accept(&parsed(json!({})), &none, false, true).is_ok());
        assert!(is_google_issuer("https://accounts.google.com"));
        assert!(is_google_issuer("https://accounts.google.com/"));
        assert!(!is_google_issuer("https://idp.acme.test"));
    }

    #[test]
    fn discovery_must_name_our_issuer_and_secure_endpoints() {
        let doc = |iss: &str, token: &str| Discovery {
            issuer: iss.into(),
            authorization_endpoint: "https://idp.acme.test/auth".into(),
            token_endpoint: token.into(),
            jwks_uri: "https://idp.acme.test/jwks".into(),
            token_endpoint_auth_methods_supported: None,
        };
        assert!(validate_discovery(&doc(ISS, "https://idp.acme.test/token"), ISS).is_ok());
        assert!(
            validate_discovery(&doc(&format!("{ISS}/"), "https://idp.acme.test/token"), ISS)
                .is_ok()
        );
        assert!(validate_discovery(
            &doc("https://other.test", "https://idp.acme.test/token"),
            ISS
        )
        .is_err());
        assert!(validate_discovery(&doc(ISS, "http://idp.acme.test/token"), ISS).is_err());
        assert!(validate_discovery(&doc(ISS, "http://127.0.0.1:8080/token"), ISS).is_ok());
        let mut d = doc(ISS, "https://idp.acme.test/token");
        assert!(!d.wants_basic_auth());
        d.token_endpoint_auth_methods_supported = Some(vec!["client_secret_basic".into()]);
        assert!(d.wants_basic_auth());
        d.token_endpoint_auth_methods_supported = Some(vec![
            "client_secret_basic".into(),
            "client_secret_post".into(),
        ]);
        assert!(!d.wants_basic_auth());
    }

    #[test]
    fn the_authorize_url_carries_every_binding() {
        let url = authorize_url(
            "https://idp.test/auth?tenant=1",
            "cid",
            "https://hub.test/cb",
            "st",
            "no",
            "ch",
            "openid email",
        );
        for part in [
            "https://idp.test/auth?tenant=1&client_id=cid",
            "redirect_uri=https%3A%2F%2Fhub.test%2Fcb",
            "scope=openid%20email",
            "state=st",
            "nonce=no",
            "code_challenge=ch",
            "code_challenge_method=S256",
        ] {
            assert!(url.contains(part), "{part} missing from {url}");
        }
        assert!(!url.contains("secret"));
    }

    fn test_auth() -> OidcAuth {
        OidcAuth {
            issuer: ISS.into(),
            provider: format!("oidc:{ISS}"),
            client_id: AUD.into(),
            client_secret: "s".into(),
            name: "SSO".into(),
            scopes: "openid email profile".into(),
            allowed_domains: vec![],
            require_hd: false,
            trust_unverified: false,
            http: reqwest::Client::new(),
            pending: Mutex::new(HashMap::new()),
            discovery: tokio::sync::Mutex::new(None),
            keys: tokio::sync::Mutex::new(None),
            limit: Semaphore::new(1),
        }
    }

    #[test]
    fn a_pending_login_is_spent_once_and_one_source_cannot_fill_the_table() {
        let a = test_auth();
        let disc = Discovery {
            issuer: ISS.into(),
            authorization_endpoint: "https://idp.acme.test/auth".into(),
            token_endpoint: "https://idp.acme.test/token".into(),
            jwks_uri: "https://idp.acme.test/jwks".into(),
            token_endpoint_auth_methods_supported: None,
        };
        assert!(a
            .begin(&disc, "s1", "https://hub.test/cb", "1.2.3.4")
            .unwrap()
            .contains("state=s1"));
        assert_eq!(a.take("s1").unwrap().redirect_uri, "https://hub.test/cb");
        assert!(a.take("s1").is_none());
        for i in 0..MAX_PENDING_PER_SOURCE {
            a.begin(&disc, &format!("x{i}"), "https://hub.test/cb", "9.9.9.9")
                .unwrap();
        }
        assert!(a
            .begin(&disc, "overflow", "https://hub.test/cb", "9.9.9.9")
            .is_err());
        assert!(a
            .begin(&disc, "elsewhere", "https://hub.test/cb", "8.8.8.8")
            .is_ok());
    }

    fn accepted(sub: &str, email: &str, vouched: bool) -> Accepted {
        Accepted {
            sub: sub.into(),
            email: email.into(),
            name: Some("A".into()),
            vouched,
        }
    }

    #[test]
    fn a_vouched_address_opens_the_account_that_holds_it_and_an_unvouched_one_never_does() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("boss", "boss@acme.test", Some("Boss"))
            .unwrap();
        let p = "oidc:https://idp.acme.test";
        // unvouched: a new account of its own, without the address
        let first = s
            .oidc_login(p, &accepted("sub-x", "boss@acme.test", false))
            .unwrap();
        assert_ne!(first.user_id, "boss");
        assert!(first.user_id.starts_with("o-"));
        // vouched, new subject: the existing account, remembered by subject
        let second = s
            .oidc_login(p, &accepted("sub-b", "boss@acme.test", true))
            .unwrap();
        assert_eq!(second.user_id, "boss");
        let again = s
            .oidc_login(p, &accepted("sub-b", "elsewhere@acme.test", false))
            .unwrap();
        assert_eq!(
            again.user_id, "boss",
            "the subject, not the address, is the identity"
        );
        // another subject claiming the same address cannot take over an account
        // that already has this provider
        let third = s
            .oidc_login(p, &accepted("sub-c", "boss@acme.test", true))
            .unwrap();
        assert_ne!(third.user_id, "boss");
        // a vouched newcomer keeps the address on the new account
        let new = s
            .oidc_login(p, &accepted("sub-n", "new@acme.test", true))
            .unwrap();
        let email: Option<String> = s.with_conn_for_tests(|c| {
            c.query_row(
                "SELECT email FROM users WHERE user_id=?1",
                [&new.user_id],
                |r| r.get(0),
            )
            .unwrap()
        });
        assert_eq!(email.as_deref(), Some("new@acme.test"));
        // and it has a workspace and an access row
        assert_eq!(
            s.access_state(&new.user_id).unwrap().state,
            crate::access::new_account_state(true)
        );
    }

    #[test]
    fn external_edition_only_a_listed_domain_opens_an_account_by_itself() {
        use crate::edition::{with_edition, Edition};
        let p = "oidc:https://idp.acme.test";
        with_edition(Edition::External, || {
            let s = WorkspaceStore::open_memory();
            let listed = s
                .oidc_login(p, &accepted("sub-1", "a@acme.test", true))
                .unwrap();
            assert_eq!(s.access_state(&listed.user_id).unwrap().state, "active");
            // no domain list: a stranger waits for the owner
            let open = s
                .oidc_login(p, &accepted("sub-2", "b@gmail.com", false))
                .unwrap();
            assert_eq!(s.access_state(&open.user_id).unwrap().state, "waitlist");
        });
        with_edition(Edition::Internal, || {
            let s = WorkspaceStore::open_memory();
            let listed = s
                .oidc_login(p, &accepted("sub-1", "a@acme.test", true))
                .unwrap();
            assert_eq!(s.access_state(&listed.user_id).unwrap().state, "waitlist");
        });
    }

    #[test]
    fn external_edition_never_links_a_new_subject_to_an_owner_or_a_password_account() {
        use crate::edition::{with_edition, Edition};
        let p = "oidc:https://idp.acme.test";
        with_edition(Edition::External, || {
            let s = WorkspaceStore::open_memory();
            s.ensure_user("boss", "boss@acme.test", Some("Boss"))
                .unwrap();
            s.set_always_active(["boss".to_string()]);
            let err = s
                .oidc_login(p, &accepted("evil", "boss@acme.test", true))
                .unwrap_err();
            assert_eq!(err, EMAIL_LINK_REFUSED);
            // nothing was created or linked
            assert!(identity::resolve(&s.conn.lock().unwrap(), p, "evil")
                .unwrap()
                .is_none());
            // an employee with a local password is protected as well
            let (emp, _) = s
                .local_create_account("emp@acme.test", None, "boss")
                .unwrap();
            s.with_conn_for_tests(|c| {
                c.execute(
                    "INSERT INTO local_credentials(user_id,email,password_hash,created_at,updated_at) VALUES(?1,'emp@acme.test','x',1,1)",
                    [&emp],
                )
                .unwrap();
            });
            assert_eq!(
                s.oidc_login(p, &accepted("evil2", "emp@acme.test", true))
                    .unwrap_err(),
                EMAIL_LINK_REFUSED
            );
            // an ordinary account without either is still matched by address
            s.ensure_user("plain", "plain@acme.test", None).unwrap();
            assert_eq!(
                s.oidc_login(p, &accepted("sub-p", "plain@acme.test", true))
                    .unwrap()
                    .user_id,
                "plain"
            );
            // its own subject keeps working for the protected account
            s.with_conn_for_tests(|c| identity::link(c, p, "boss-sub", "boss", 1).unwrap());
            assert_eq!(
                s.oidc_login(p, &accepted("boss-sub", "boss@acme.test", true))
                    .unwrap()
                    .user_id,
                "boss"
            );
        });
        // internal hub: unchanged
        with_edition(Edition::Internal, || {
            let s = WorkspaceStore::open_memory();
            s.ensure_user("boss", "boss@acme.test", Some("Boss"))
                .unwrap();
            s.set_always_active(["boss".to_string()]);
            assert_eq!(
                s.oidc_login(p, &accepted("sub", "boss@acme.test", true))
                    .unwrap()
                    .user_id,
                "boss"
            );
        });
    }
}
