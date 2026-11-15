//! Android OAuth handoff: the exported URI contains a short-lived one-use code,
//! never a session bearer. S256 PKCE binds exchange to the initiating app.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use uuid::Uuid;

const LOGIN_TTL: Duration = Duration::from_secs(600);
const CODE_TTL: Duration = Duration::from_secs(120);
const MAX_PENDING: usize = 4096;

pub struct Handshake {
    challenge: String,
    pub client_state: String,
    created: Instant,
    source: String,
}
struct Code {
    challenge: String,
    user_id: String,
    /// The `(provider, subject)` that proved the login: the session is minted
    /// only if it still opens `user_id` at exchange time.
    identity: Option<(String, String)>,
    /// Hash of the browser session this code waits for: a sign-in whose
    /// second factor is still owed releases the code only after THAT session
    /// has passed `/api/auth/mfa/verify`.
    gate: Option<String>,
    created: Instant,
}
/// What a successful exchange yields.
pub struct Exchanged {
    pub user_id: String,
    pub identity: Option<(String, String)>,
    /// The code was released by a verified second factor.
    pub gated: bool,
    /// Hash of the browser session the code waited for: it has done its job.
    pub gate: Option<String>,
}
impl Code {
    fn ttl(&self) -> Duration {
        if self.gate.is_some() {
            LOGIN_TTL
        } else {
            CODE_TTL
        }
    }
}
#[derive(Default)]
pub struct AndroidAuth {
    handshakes: Mutex<HashMap<String, Handshake>>,
    codes: Mutex<HashMap<String, Code>>,
}
fn url_safe(value: &str) -> bool {
    value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}
impl AndroidAuth {
    pub fn begin(
        &self,
        state: String,
        challenge: &str,
        client_state: &str,
        source: &str,
    ) -> Result<(), &'static str> {
        if challenge.len() != 43
            || !url_safe(challenge)
            || !(32..=128).contains(&client_state.len())
            || !url_safe(client_state)
        {
            return Err("invalid Android PKCE parameters");
        }
        let mut entries = self.handshakes.lock().map_err(|_| "login unavailable")?;
        entries.retain(|_, value| value.created.elapsed() < LOGIN_TTL);
        if entries.len() >= MAX_PENDING
            || entries.values().filter(|v| v.source == source).count() >= 12
        {
            return Err("too many pending logins");
        }
        entries.insert(
            state,
            Handshake {
                challenge: challenge.into(),
                client_state: client_state.into(),
                created: Instant::now(),
                source: source.into(),
            },
        );
        Ok(())
    }
    pub fn take(&self, state: &str) -> Option<Handshake> {
        self.handshakes
            .lock()
            .ok()?
            .remove(state)
            .filter(|value| value.created.elapsed() < LOGIN_TTL)
    }
    #[cfg(test)]
    pub fn issue(&self, handshake: Handshake, user_id: &str) -> Result<String, &'static str> {
        self.issue_bound(handshake, user_id, None)
    }
    pub fn issue_bound(
        &self,
        handshake: Handshake,
        user_id: &str,
        identity: Option<(String, String)>,
    ) -> Result<String, &'static str> {
        self.issue_with(handshake, user_id, identity, None)
    }
    /// A code that exchanges only once the session with token hash `gate` is
    /// satisfied (the person still has to enter the second factor, which takes
    /// longer than `CODE_TTL` — a gated code lives as long as a login).
    pub fn issue_gated(
        &self,
        handshake: Handshake,
        user_id: &str,
        identity: Option<(String, String)>,
        gate: String,
    ) -> Result<String, &'static str> {
        self.issue_with(handshake, user_id, identity, Some(gate))
    }
    fn issue_with(
        &self,
        handshake: Handshake,
        user_id: &str,
        identity: Option<(String, String)>,
        gate: Option<String>,
    ) -> Result<String, &'static str> {
        let mut entries = self.codes.lock().map_err(|_| "login unavailable")?;
        entries.retain(|_, value| value.created.elapsed() < value.ttl());
        if entries.len() >= MAX_PENDING {
            return Err("too many pending logins");
        }
        let code = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        entries.insert(
            code.clone(),
            Code {
                challenge: handshake.challenge,
                user_id: user_id.into(),
                identity,
                gate,
                created: Instant::now(),
            },
        );
        Ok(code)
    }
    #[cfg(test)]
    pub fn exchange(&self, code: &str, verifier: &str) -> Option<String> {
        self.exchange_bound(code, verifier).map(|(user, _)| user)
    }
    #[cfg(test)]
    pub fn exchange_bound(
        &self,
        code: &str,
        verifier: &str,
    ) -> Option<(String, Option<(String, String)>)> {
        self.exchange_released(code, verifier, |_, _| true)
            .map(|done| (done.user_id, done.identity))
    }
    /// `released(gate_hash, user_id)` says whether the session a gated code
    /// waits for has met its second factor; until then the code is refused
    /// and NOT spent (the app only receives it after the browser verified).
    pub fn exchange_released(
        &self,
        code: &str,
        verifier: &str,
        released: impl Fn(&str, &str) -> bool,
    ) -> Option<Exchanged> {
        if code.len() != 64
            || !(43..=128).contains(&verifier.len())
            || !verifier
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~'))
        {
            return None;
        }
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut entries = self.codes.lock().ok()?;
        entries.retain(|_, value| value.created.elapsed() < value.ttl());
        let value = entries.get(code)?;
        if value.challenge != challenge {
            return None;
        }
        if let Some(gate) = &value.gate {
            if !released(gate, &value.user_id) {
                return None;
            }
        }
        entries.remove(code).map(|value| Exchanged {
            gated: value.gate.is_some(),
            gate: value.gate.clone(),
            user_id: value.user_id,
            identity: value.identity,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn login(auth: &AndroidAuth) -> String {
        let verifier = "a".repeat(43);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        auth.begin("server-state".into(), &challenge, &"b".repeat(43), "test")
            .unwrap();
        auth.issue(auth.take("server-state").unwrap(), "user-1")
            .unwrap()
    }
    #[test]
    fn code_is_bound_to_verifier_and_single_use() {
        let auth = AndroidAuth::default();
        let code = login(&auth);
        assert!(auth.exchange(&code, &"c".repeat(43)).is_none());
        assert_eq!(auth.exchange(&code, &"a".repeat(43)), Some("user-1".into()));
        assert!(auth.exchange(&code, &"a".repeat(43)).is_none());
        assert!(auth.take("server-state").is_none());
    }
    #[test]
    fn expired_code_does_not_exchange() {
        let auth = AndroidAuth::default();
        let code = login(&auth);
        auth.codes.lock().unwrap().get_mut(&code).unwrap().created = Instant::now() - CODE_TTL;
        assert!(auth.exchange(&code, &"a".repeat(43)).is_none());
    }
    #[test]
    fn expired_login_and_malformed_parameters_are_rejected() {
        let auth = AndroidAuth::default();
        assert!(auth.begin("s".into(), "plain", "state", "test").is_err());
        let _ = login(&auth);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest("a".repeat(43)));
        auth.begin("s".into(), &challenge, &"x".repeat(32), "test")
            .unwrap();
        auth.handshakes
            .lock()
            .unwrap()
            .get_mut("s")
            .unwrap()
            .created = Instant::now() - LOGIN_TTL;
        assert!(auth.take("s").is_none());
    }
    #[test]
    fn pending_limit_is_scoped_to_source_and_released_by_callback() {
        let auth = AndroidAuth::default();
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest("a".repeat(43)));
        for index in 0..12 {
            auth.begin(index.to_string(), &challenge, &"s".repeat(32), "one")
                .unwrap();
        }
        assert!(auth
            .begin("overflow".into(), &challenge, &"s".repeat(32), "one")
            .is_err());
        assert!(auth
            .begin("other".into(), &challenge, &"s".repeat(32), "two")
            .is_ok());
        assert!(auth.take("0").is_some());
        assert!(auth
            .begin("next".into(), &challenge, &"s".repeat(32), "one")
            .is_ok());
    }
}
