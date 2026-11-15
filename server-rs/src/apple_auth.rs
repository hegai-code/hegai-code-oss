//! Native Sign in with Apple. Authorization codes are exchanged server-side;
//! refresh tokens are encrypted solely for revocation (account deletion, or
//! unlinking Apple from an account).
//!
//! `exchange` with a valid `Authorization: Bearer` session LINKS instead of
//! signing in: the Apple identity is attached to that account
//! (`identity::attach`, which also moves it off an empty duplicate an
//! earlier Apple sign-in created) and no new session is minted.
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use jsonwebtoken::{jwk::JwkSet, EncodingKey};
use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};
use rusqlite::params;
use serde::Serialize;

const ISSUER: &str = "https://appleid.apple.com";
const CHALLENGE_TTL: Duration = Duration::from_secs(600);

pub(crate) struct AppleAuth {
    team: String,
    key_id: String,
    client_id: String,
    signer: EncodingKey,
    cipher: aead::LessSafeKey,
    http: reqwest::Client,
    challenges: Mutex<HashMap<String, Instant>>,
    keys: tokio::sync::Mutex<Option<(Instant, JwkSet)>>,
    limit: Semaphore,
}

#[derive(Deserialize, Clone)]
struct Claims {
    sub: String,
    nonce: String,
    iat: u64,
}

impl AppleAuth {
    pub fn from_env() -> Result<Option<Arc<Self>>, &'static str> {
        let names = [
            "APPLE_SIGNIN_TEAM_ID",
            "APPLE_SIGNIN_KEY_ID",
            "APPLE_SIGNIN_CLIENT_ID",
            "APPLE_SIGNIN_KEY_PATH",
            "APPLE_SIGNIN_ENCRYPTION_KEY_PATH",
        ];
        let values: Vec<_> = names.iter().map(|n| std::env::var(n).ok()).collect();
        if values.iter().all(Option::is_none) {
            return Ok(None);
        }
        let values: Vec<String> = values
            .into_iter()
            .collect::<Option<_>>()
            .ok_or("incomplete Apple sign-in configuration")?;
        let signing = std::fs::read(&values[3]).map_err(|_| "Apple signing key unreadable")?;
        let signer = EncodingKey::from_ec_pem(&signing).map_err(|_| "invalid Apple signing key")?;
        let encryption =
            std::fs::read(&values[4]).map_err(|_| "Apple token encryption key unreadable")?;
        let key = aead::UnboundKey::new(&aead::AES_256_GCM, &encryption)
            .map_err(|_| "Apple token encryption key must be 32 raw bytes")?;
        Ok(Some(Arc::new(Self {
            team: values[0].clone(),
            key_id: values[1].clone(),
            client_id: values[2].clone(),
            signer,
            cipher: aead::LessSafeKey::new(key),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "Apple HTTP configuration")?,
            challenges: Mutex::new(HashMap::new()),
            keys: tokio::sync::Mutex::new(None),
            limit: Semaphore::new(8),
        })))
    }

    fn challenge(&self) -> Result<String, &'static str> {
        let mut values = self.challenges.lock().map_err(|_| "sign-in unavailable")?;
        values.retain(|_, t| t.elapsed() < CHALLENGE_TTL);
        if values.len() >= 512 {
            return Err("sign-in busy, try later");
        }
        let nonce = workspace::opaque_token();
        values.insert(nonce.clone(), Instant::now());
        Ok(nonce)
    }

    fn consume(&self, nonce: &str) -> bool {
        self.challenges
            .lock()
            .ok()
            .and_then(|mut v| v.remove(nonce))
            .is_some_and(|t| t.elapsed() < CHALLENGE_TTL)
    }

    fn client_secret(&self) -> Result<String, &'static str> {
        #[derive(Serialize)]
        struct Secret<'a> {
            iss: &'a str,
            iat: u64,
            exp: u64,
            aud: &'a str,
            sub: &'a str,
        }
        let now = (workspace::now_ms() / 1000) as u64;
        let mut header = jsonwebtoken::Header::new(Algorithm::ES256);
        header.kid = Some(self.key_id.clone());
        jsonwebtoken::encode(
            &header,
            &Secret {
                iss: &self.team,
                iat: now,
                exp: now + 300,
                aud: ISSUER,
                sub: &self.client_id,
            },
            &self.signer,
        )
        .map_err(|_| "Apple client authentication unavailable")
    }

    async fn verify(&self, token: &str, nonce: &str) -> Result<Claims, &'static str> {
        let header = jsonwebtoken::decode_header(token).map_err(|_| "invalid Apple identity")?;
        if header.alg != Algorithm::RS256 {
            return Err("invalid Apple identity algorithm");
        }
        let kid = header.kid.ok_or("missing Apple signing key")?;
        let mut cache = self.keys.lock().await;
        if cache
            .as_ref()
            .is_none_or(|(t, _)| t.elapsed() > Duration::from_secs(3600))
        {
            let response = self
                .http
                .get(format!("{ISSUER}/auth/keys"))
                .send()
                .await
                .map_err(|_| "Apple keys unavailable")?;
            if !response.status().is_success() {
                return Err("Apple keys unavailable");
            }
            let keys = response
                .json::<JwkSet>()
                .await
                .map_err(|_| "Apple keys unavailable")?;
            *cache = Some((Instant::now(), keys));
        }
        let jwk = cache
            .as_ref()
            .and_then(|(_, keys)| keys.find(&kid))
            .ok_or("unknown Apple signing key")?;
        let key = DecodingKey::from_jwk(jwk).map_err(|_| "invalid Apple signing key")?;
        verify_claims(token, nonce, &self.client_id, &key)
    }

    fn seal(&self, subject: &str, token: &str) -> Result<String, &'static str> {
        let mut nonce = [0u8; 12];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| "token encryption unavailable")?;
        let mut data = token.as_bytes().to_vec();
        self.cipher
            .seal_in_place_append_tag(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(subject.as_bytes()),
                &mut data,
            )
            .map_err(|_| "token encryption unavailable")?;
        Ok(STANDARD.encode([nonce.as_slice(), &data].concat()))
    }

    fn unseal(&self, subject: &str, stored: &str) -> Result<String, &'static str> {
        let bytes = STANDARD
            .decode(stored)
            .map_err(|_| "token decryption failed")?;
        if bytes.len() < 28 {
            return Err("token decryption failed");
        }
        let nonce: [u8; 12] = bytes[..12]
            .try_into()
            .map_err(|_| "token decryption failed")?;
        let mut data = bytes[12..].to_vec();
        let token = self
            .cipher
            .open_in_place(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(subject.as_bytes()),
                &mut data,
            )
            .map_err(|_| "token decryption failed")?;
        String::from_utf8(token.to_vec()).map_err(|_| "token decryption failed")
    }

    async fn revoke(&self, token: &str) -> Result<(), &'static str> {
        let secret = self.client_secret()?;
        let response = self
            .http
            .post(format!("{ISSUER}/auth/revoke"))
            .form(&[
                ("client_id", self.client_id.as_str()),
                ("client_secret", &secret),
                ("token", token),
                ("token_type_hint", "refresh_token"),
            ])
            .send()
            .await
            .map_err(|_| "Apple revocation unavailable")?;
        if response.status() != StatusCode::OK {
            return Err("Apple revocation not confirmed");
        }
        Ok(())
    }

    pub async fn revoke_account(
        &self,
        store: &WorkspaceStore,
        user: &str,
    ) -> Result<(), &'static str> {
        let tokens = store
            .apple_tokens(user)
            .map_err(|_| "Apple identity lookup")?;
        self.revoke_tokens(&tokens).await
    }

    /// Revoke stored `(subject, sealed refresh token)` pairs at Apple — what
    /// unlinking Apple from an account does before the rows go.
    pub async fn revoke_tokens(&self, tokens: &[(String, String)]) -> Result<(), &'static str> {
        for (subject, stored) in tokens {
            self.revoke(&self.unseal(subject, stored)?).await?;
        }
        Ok(())
    }
}

fn verify_claims(
    token: &str,
    nonce: &str,
    audience: &str,
    key: &DecodingKey,
) -> Result<Claims, &'static str> {
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&[audience]);
    validation.set_issuer(&[ISSUER]);
    validation.leeway = 30;
    validation.set_required_spec_claims(&["exp", "iss", "aud", "sub", "iat"]);
    let claims = decode::<Claims>(token, key, &validation)
        .map_err(|_| "invalid Apple identity")?
        .claims;
    let now = (workspace::now_ms() / 1000) as u64;
    if claims.sub.is_empty()
        || claims.sub.len() > 255
        || claims.nonce != nonce
        || claims.iat > now + 30
        || now.saturating_sub(claims.iat) > 600
    {
        return Err("Apple identity does not match this sign-in");
    }
    Ok(claims)
}

pub(crate) fn init_schema(c: &rusqlite::Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS apple_tokens(subject TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE, encrypted_refresh TEXT NOT NULL);").map_err(workspace::db_err)
}

impl WorkspaceStore {
    pub fn apple_tokens(&self, user: &str) -> Result<Vec<(String, String)>, String> {
        let c = self.conn.lock().map_err(|_| "database lock poisoned")?;
        let mut stmt = c
            .prepare("SELECT subject,encrypted_refresh FROM apple_tokens WHERE user_id=?1")
            .map_err(workspace::db_err)?;
        let rows = stmt
            .query_map([user], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(workspace::db_err)?;
        rows.collect::<Result<_, _>>().map_err(workspace::db_err)
    }

    /// Attach a proven Apple identity to the signed-in `target`, with its
    /// revocation token, in one transaction.
    fn apple_link(
        &self,
        subject: &str,
        target: &str,
        encrypted: &str,
    ) -> Result<identity::Attached, String> {
        let c = self.conn.lock().map_err(|_| "database lock poisoned")?;
        let tx = c.unchecked_transaction().map_err(workspace::db_err)?;
        let now = workspace::now_ms();
        let out = identity::attach(
            &tx,
            identity::PROVIDER_APPLE,
            subject,
            target,
            Some("Apple ID"),
            now,
        )?;
        tx.execute("INSERT INTO apple_tokens VALUES(?1,?2,?3) ON CONFLICT(subject) DO UPDATE SET user_id=excluded.user_id,encrypted_refresh=excluded.encrypted_refresh", params![subject,target,encrypted]).map_err(workspace::db_err)?;
        tx.commit().map_err(workspace::db_err)?;
        Ok(out)
    }

    fn apple_account(
        &self,
        subject: &str,
        name: Option<&str>,
        encrypted: &str,
    ) -> Result<String, String> {
        let c = self.conn.lock().map_err(|_| "database lock poisoned")?;
        let tx = c.unchecked_transaction().map_err(workspace::db_err)?;
        let now = workspace::now_ms();
        let user = match identity::resolve(&tx, "apple", subject)? {
            Some(user) => user,
            None => {
                let user = format!("apple-{}", uuid::Uuid::new_v4().simple());
                let personal = format!("personal:{user}");
                // Email is deliberately neither requested nor used as an identity.
                tx.execute(
                    "INSERT INTO users(user_id,email,full_name,created_at) VALUES(?1,NULL,?2,?3)",
                    params![user, name, now],
                )
                .map_err(workspace::db_err)?;
                tx.execute("INSERT INTO workspaces(workspace_id,name,kind,owner_user_id,created_at) VALUES(?1,'Моя работа','personal',?2,?3)", params![personal,user,now]).map_err(workspace::db_err)?;
                tx.execute(
                    "INSERT INTO memberships VALUES(?1,?2,'owner',?3)",
                    params![personal, user, now],
                )
                .map_err(workspace::db_err)?;
                tx.execute("INSERT INTO user_access(user_id,state,plan,requested_at,updated_at) VALUES(?1,?2,'community',?3,?3)", params![user,access::new_account_state(false),now]).map_err(workspace::db_err)?;
                user
            }
        };
        let pending: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM account_deletions WHERE user_id=?1)",
                [&user],
                |r| r.get(0),
            )
            .map_err(workspace::db_err)?;
        if pending {
            return Err("account deletion in progress".into());
        }
        identity::link(&tx, "apple", subject, &user, now)?;
        tx.execute("INSERT INTO apple_tokens VALUES(?1,?2,?3) ON CONFLICT(subject) DO UPDATE SET encrypted_refresh=excluded.encrypted_refresh", params![subject,user,encrypted]).map_err(workspace::db_err)?;
        tx.commit().map_err(workspace::db_err)?;
        Ok(user)
    }
}

fn rate(st: &AppState, headers: &HeaderMap) -> Result<(), Response> {
    if !same_origin(headers) {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            "cross-site sign-in refused",
        ));
    }
    let ip = rate_window::rate_ip(client_ip(headers).as_deref());
    let key = check_window_quota(
        st,
        &format!("apple-signin:{}", ip.as_deref().unwrap_or("?")),
        40,
        3600000,
        "too many sign-in attempts",
    )?;
    record_window_hit(st, &key, 3600000);
    Ok(())
}

pub(crate) async fn start(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let Some(apple) = &st.apple_auth else {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Apple sign-in is not configured",
        );
    };
    if let Err(e) = rate(&st, &headers) {
        return e;
    }
    match apple.challenge() {
        Ok(nonce) => Json(json!({"nonce":nonce})).into_response(),
        Err(e) => refusal(StatusCode::SERVICE_UNAVAILABLE, e),
    }
}

pub(crate) async fn exchange(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let Some(apple) = &st.apple_auth else {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Apple sign-in is not configured",
        );
    };
    if let Err(e) = rate(&st, &headers) {
        return e;
    }
    // A bearer session means «add Apple to THIS account». A bearer that does
    // not authenticate is refused, never read as a plain sign-in: the app
    // asked to link, and creating a second account would be the opposite.
    let link_user = match bearer_token(&headers) {
        None => None,
        Some(token) => match st.workspaces.authenticate(&token) {
            Ok(Some((user, _))) => {
                gate!(require_active(&st, &user));
                Some(user)
            }
            Ok(None) => return api_error(StatusCode::UNAUTHORIZED, "authentication required"),
            Err(e) => return store_failure(e),
        },
    };
    let Ok(_permit) = apple.limit.try_acquire() else {
        return api_error(StatusCode::TOO_MANY_REQUESTS, "Apple sign-in busy");
    };
    let nonce = body["nonce"].as_str().unwrap_or("");
    let code = body["code"].as_str().unwrap_or("");
    let token = body["identityToken"].as_str().unwrap_or("");
    if nonce.len() != 64
        || code.is_empty()
        || code.len() > 4096
        || token.len() > 16384
        || !apple.consume(nonce)
    {
        return api_error(StatusCode::BAD_REQUEST, "sign-in expired; try again");
    }
    let mut refused: Option<String> = None;
    let outcome: Result<Option<String>, &'static str> = async {
        let native = apple.verify(token, nonce).await?;
        let secret = apple.client_secret()?;
        let response = apple
            .http
            .post(format!("{ISSUER}/auth/token"))
            .form(&[
                ("client_id", apple.client_id.as_str()),
                ("client_secret", &secret),
                ("code", code),
                ("grant_type", "authorization_code"),
            ])
            .send()
            .await
            .map_err(|_| "Apple sign-in unavailable")?;
        if !response.status().is_success() {
            return Err("Apple authorization code was not accepted");
        }
        let tokens: Value = response
            .json()
            .await
            .map_err(|_| "invalid Apple token response")?;
        let exchanged = apple
            .verify(
                tokens["id_token"]
                    .as_str()
                    .ok_or("missing Apple identity")?,
                nonce,
            )
            .await?;
        if native.sub != exchanged.sub {
            return Err("Apple identity mismatch");
        }
        let refresh = tokens["refresh_token"]
            .as_str()
            .filter(|t| !t.is_empty() && t.len() <= 16384)
            .ok_or("missing Apple revocation token")?;
        let encrypted = apple.seal(&native.sub, refresh)?;
        if let Some(target) = link_user.as_deref() {
            // Suspended while Apple was being asked: no new way into it.
            let attached = match access_gate_state(&st.workspaces, target) {
                Ok(()) => st.workspaces.apple_link(&native.sub, target, &encrypted),
                Err(_) => Err("access_not_active".to_string()),
            };
            return match attached {
                Ok(attached) => {
                    println!("[auth] {target} linked Apple ({attached:?})");
                    Ok(None)
                }
                Err(code) => {
                    // Nothing was stored. Revoking at Apple ends the person's
                    // authorization for the app as a whole, so only when no
                    // account holds this Apple ID — otherwise the refusal
                    // would break the holder's own Apple sign-in.
                    let held = st
                        .workspaces
                        .identity_holder(identity::PROVIDER_APPLE, &native.sub)
                        .map_err(|_| "Apple identity lookup")?;
                    if held.is_none() {
                        apple.revoke(refresh).await?;
                    }
                    refused = Some(code);
                    Err("Apple link refused")
                }
            };
        }
        let name = body["name"].as_str().map(|n| {
            n.chars()
                .filter(|c| !c.is_control())
                .take(100)
                .collect::<String>()
        });
        let user = match st
            .workspaces
            .apple_account(&native.sub, name.as_deref(), &encrypted)
        {
            Ok(user) => user,
            Err(_) => {
                apple.revoke(refresh).await?;
                return Err("account sign-in unavailable");
            }
        };
        // No browser on this path to ask for a second factor: mint, then look at
        // what was really minted (a check-then-mint gap would let an
        // enrolment slip in between), and turn a pending session away.
        let (session, pending) = st
            .workspaces
            .create_auth_session_for_as(
                Some((identity::PROVIDER_APPLE, &native.sub)),
                &user,
                90,
                crate::mfa::Factor::Unproven,
            )
            .map_err(|_| "account session unavailable")?;
        if pending {
            st.workspaces.drop_session(&session);
            return Err(crate::mfa_browser_required_code());
        }
        Ok(Some(session))
    }
    .await;
    if let Some(code) = refused {
        let known = matches!(
            code.as_str(),
            identity::OWNER_HAS_DATA | identity::TARGET_DELETING | "access_not_active"
        );
        eprintln!("[auth] Apple link refused: {code}");
        return api_error(
            StatusCode::CONFLICT,
            if known { code } else { "link_failed".into() },
        );
    }
    match outcome {
        Ok(None) => {
            st.hub.send(HubCmd::RefreshWorkspaceState);
            (
                [(header::CACHE_CONTROL, "no-store")],
                Json(json!({"linked": "apple"})),
            )
                .into_response()
        }
        Ok(Some(session)) => {
            st.hub.send(HubCmd::RefreshWorkspaceState);
            (
                [(header::CACHE_CONTROL, "no-store")],
                Json(json!({"session":session})),
            )
                .into_response()
        }
        Err(e) if e == crate::mfa_browser_required_code() => crate::mfa_browser_required(),
        Err(e) => refusal(StatusCode::UNAUTHORIZED, e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::process::{Command, Stdio};

    fn config() -> AppleAuth {
        AppleAuth {
            team: "TEST".into(),
            key_id: "TEST".into(),
            client_id: "net.hegai.ccremote".into(),
            signer: EncodingKey::from_secret(b"unused-test-signer"),
            cipher: aead::LessSafeKey::new(
                aead::UnboundKey::new(&aead::AES_256_GCM, &[7; 32]).unwrap(),
            ),
            http: reqwest::Client::new(),
            challenges: Mutex::new(HashMap::new()),
            keys: tokio::sync::Mutex::new(None),
            limit: Semaphore::new(8),
        }
    }

    #[test]
    fn challenges_are_one_use_expiring_and_bounded() {
        let cfg = config();
        let nonce = cfg.challenge().unwrap();
        assert!(cfg.consume(&nonce));
        assert!(!cfg.consume(&nonce));
        cfg.challenges
            .lock()
            .unwrap()
            .insert("old".into(), Instant::now() - CHALLENGE_TTL);
        assert!(!cfg.consume("old"));
        for _ in 0..512 {
            cfg.challenge().unwrap();
        }
        assert!(cfg.challenge().is_err());
    }

    #[test]
    fn encrypted_revocation_tokens_are_bound_to_the_apple_subject() {
        let cfg = config();
        let token = cfg.seal("alice", "refresh-secret").unwrap();
        assert!(!token.contains("refresh-secret"));
        assert_eq!(cfg.unseal("alice", &token).unwrap(), "refresh-secret");
        assert!(cfg.unseal("bob", &token).is_err());
        assert_ne!(token, cfg.seal("alice", "refresh-secret").unwrap());
        let mut corrupted = STANDARD.decode(token).unwrap();
        corrupted[20] ^= 1;
        assert!(cfg.unseal("alice", &STANDARD.encode(corrupted)).is_err());
    }

    #[test]
    fn signed_identity_rejects_wrong_nonce_audience_issuer_age_and_algorithm() {
        // Generate disposable test keys in memory; no real or checked-in secret.
        let private = Command::new("openssl")
            .args(["genrsa", "2048"])
            .output()
            .unwrap();
        assert!(private.status.success());
        let mut child = Command::new("openssl")
            .args(["rsa", "-pubout"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&private.stdout)
            .unwrap();
        let public = child.wait_with_output().unwrap();
        assert!(public.status.success());
        let signer = EncodingKey::from_rsa_pem(&private.stdout).unwrap();
        let verifier = DecodingKey::from_rsa_pem(&public.stdout).unwrap();
        let now = (workspace::now_ms() / 1000) as u64;
        let claims = json!({"iss":ISSUER,"aud":"net.hegai.ccremote","sub":"alice","nonce":"n","iat":now,"exp":now+300});
        let sign = |v: &Value| {
            jsonwebtoken::encode(&jsonwebtoken::Header::new(Algorithm::RS256), v, &signer).unwrap()
        };
        assert_eq!(
            verify_claims(&sign(&claims), "n", "net.hegai.ccremote", &verifier)
                .unwrap()
                .sub,
            "alice"
        );
        for (field, value) in [
            ("nonce", json!("other")),
            ("aud", json!("another-app")),
            ("iss", json!("https://evil.invalid")),
            // Well past the 600 s / 30 s limits: `now` is taken before the
            // RSA keygen above, and under a loaded CI box the second ticked
            // over before verify — `now + 31` then sat exactly ON the limit
            // and was accepted (flaked on d0dad92).
            ("iat", json!(now - 660)),
            ("iat", json!(now + 60)),
            ("exp", json!(now - 120)),
            ("sub", json!("")),
        ] {
            let mut changed = claims.clone();
            changed[field] = value;
            assert!(
                verify_claims(&sign(&changed), "n", "net.hegai.ccremote", &verifier).is_err(),
                "accepted bad {field}"
            );
        }
        let forged = jsonwebtoken::encode(
            &jsonwebtoken::Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(&public.stdout),
        )
        .unwrap();
        assert!(verify_claims(&forged, "n", "net.hegai.ccremote", &verifier).is_err());
    }

    #[test]
    fn apple_identity_is_stable_independent_and_blocked_during_deletion() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("existing", "alice@example.test", Some("Alice"))
            .unwrap();
        let first = s
            .apple_account("apple-sub", Some("Alice"), "encrypted-one")
            .unwrap();
        assert_ne!(first, "existing");
        assert_eq!(
            s.apple_account("apple-sub", None, "encrypted-two").unwrap(),
            first
        );
        assert!(s.user_email(&first).is_none());
        assert_eq!(s.access_state(&first).unwrap().state, "waitlist");
        assert_eq!(
            s.apple_tokens(&first).unwrap(),
            vec![("apple-sub".into(), "encrypted-two".into())]
        );
        s.request_account_deletion(&first, &json!([])).unwrap();
        assert!(s.apple_account("apple-sub", None, "new-token").is_err());
        assert!(s.create_auth_session(&first, 90).is_err());
    }

    #[test]
    fn linking_apple_while_signed_in_attaches_it_and_its_token_to_that_account() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("main", "main@x", Some("Main")).unwrap();
        assert_eq!(
            s.apple_link("apple-new", "main", "enc-1").unwrap(),
            identity::Attached::New
        );
        assert_eq!(s.apple_account("apple-new", None, "enc-2").unwrap(), "main");
        // An earlier Apple sign-in made an empty duplicate.
        let dup = s.apple_account("apple-dup", None, "enc-dup").unwrap();
        assert!(dup.starts_with("apple-"));
        assert_eq!(
            s.apple_link("apple-dup", "main", "enc-dup-2").unwrap(),
            identity::Attached::Moved {
                from: dup.clone(),
                suspended: true
            }
        );
        let mut tokens = s.apple_tokens("main").unwrap();
        tokens.sort();
        assert_eq!(
            tokens,
            vec![
                ("apple-dup".into(), "enc-dup-2".into()),
                ("apple-new".into(), "enc-2".into())
            ],
            "the revocation tokens follow their identities"
        );
        assert!(s.apple_tokens(&dup).unwrap().is_empty());
        assert_eq!(s.access_state(&dup).unwrap().state, "suspended");
        assert_eq!(s.apple_account("apple-dup", None, "enc-3").unwrap(), "main");
    }

    #[test]
    fn unlinking_apple_drops_only_the_token_that_was_revoked() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("main", "main@x", None).unwrap();
        s.apple_link("apple-sub", "main", "enc-old").unwrap();
        let snapshot = s.apple_tokens_for("main", None).unwrap();
        // A new exchange stores a fresh token between the revoke and the delete.
        s.apple_account("apple-sub", None, "enc-new").unwrap();
        assert_eq!(
            s.unlink_identity("main", identity::PROVIDER_APPLE, None, &snapshot)
                .unwrap_err(),
            identity::APPLE_TOKEN_CHANGED
        );
        assert_eq!(
            s.apple_tokens("main").unwrap().len(),
            1,
            "kept for revocation"
        );
        let fresh = s.apple_tokens_for("main", None).unwrap();
        s.unlink_identity("main", identity::PROVIDER_APPLE, None, &fresh)
            .unwrap();
        assert!(s.apple_tokens("main").unwrap().is_empty());
    }

    #[test]
    fn an_account_emptied_by_a_move_gets_no_new_session() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("main", "main@x", None).unwrap();
        let dup = s.apple_account("apple-dup", None, "enc").unwrap();
        // A login resolved `dup` before the move; its session comes later.
        s.apple_link("apple-dup", "main", "enc-2").unwrap();
        assert!(s.create_auth_session(&dup, 90).is_err());
        assert!(s.create_auth_session("main", 90).is_ok());
    }
}
