//! Release signing drop box (internal hub only, off unless configured).
//!
//! `deploy/release-signer/stage-release.sh` puts a built external-edition
//! bundle into `CC_REMOTE_RELEASE_DROP_DIR/<version>/agent-external.mjs` and
//! writes `pending.json` there. The native signer app on Owner's Mac reads
//! `GET /api/release-signing/pending`, signs the manifest after Touch ID and
//! posts the signature to `POST /api/release-signing/signature`.
//!
//! Both endpoints are public: the signature IS the authentication. The hub
//! writes nothing unless the Ed25519 signature verifies against the keys
//! compiled in from `deploy/release-keys.txt` and the staged file's sha256 is
//! the one that was signed. Unset env = both routes answer 404.

use std::fs;
use std::path::{Path, PathBuf};

use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue};
use axum::response::IntoResponse;

use crate::agent_release::{compiled_keys, sha256_hex, verify_signature, write_atomic};
use crate::*;

const DROP_DIR_ENV: &str = "CC_REMOTE_RELEASE_DROP_DIR";
const BUNDLE: &str = "agent-external.mjs";
const POSTS_PER_WINDOW: usize = 20;
const WINDOW_MS: i64 = 10 * 60 * 1000;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SignError {
    /// 400: malformed input or a signature no trusted key made.
    Bad(&'static str),
    /// 409: does not match the pending release / the staged file.
    Conflict(&'static str),
    /// 500
    Io(String),
}

fn valid_version(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 64
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._+-".contains(&b))
        && v != "."
        && v != ".."
}

fn valid_sha(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn manifest(version: &str, sha: &str) -> String {
    format!("hegai-code-agent-release/1\nedition=external\nversion={version}\nsha256={sha}\n")
}

/// `(version, sha)` of pending.json plus the raw object, `Ok(None)` when absent.
fn read_pending(dir: &Path) -> Result<Option<(String, String, Value)>, SignError> {
    let raw = match fs::read(dir.join("pending.json")) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(SignError::Io(e.to_string())),
    };
    let v: Value =
        serde_json::from_slice(&raw).map_err(|_| SignError::Bad("pending.json is not JSON"))?;
    let version = v.get("version").and_then(Value::as_str).unwrap_or("");
    let sha = v.get("sha256").and_then(Value::as_str).unwrap_or("");
    if !valid_version(version) || !valid_sha(sha) {
        return Err(SignError::Bad(
            "pending.json has an invalid version or sha256",
        ));
    }
    Ok(Some((version.to_string(), sha.to_string(), v)))
}

/// The pending release plus `signed`; `None` when nothing is staged.
pub(crate) fn pending_json(dir: &Path, keys: &[[u8; 32]]) -> Result<Option<Value>, SignError> {
    let Some((version, sha, v)) = read_pending(dir)? else {
        return Ok(None);
    };
    let sig = fs::read_to_string(dir.join(&version).join(format!("{BUNDLE}.sig"))).ok();
    let signed =
        sig.is_some_and(|s| verify_signature(&manifest(&version, &sha), &s, keys).is_some());
    let mut out = json!({ "version": version, "sha256": sha });
    // Absent stays absent (never null).
    for k in ["url", "commit", "createdAt"] {
        if let Some(x) = v.get(k).filter(|x| x.is_string()) {
            out[k] = x.clone();
        }
    }
    out["signed"] = json!(signed);
    Ok(Some(out))
}

/// Accept a signature for the pending release; returns the key index.
pub(crate) fn accept_signature(
    dir: &Path,
    keys: &[[u8; 32]],
    version: &str,
    sha: &str,
    sig_b64: &str,
) -> Result<(usize, bool), SignError> {
    if !valid_version(version) || !valid_sha(sha) {
        return Err(SignError::Bad("invalid version or sha256"));
    }
    let Some((pv, psha, _)) = read_pending(dir)? else {
        return Err(SignError::Conflict("nothing is pending"));
    };
    if pv != version || psha != sha {
        return Err(SignError::Conflict("not the pending release"));
    }
    let man = manifest(version, sha);
    let Some(index) = verify_signature(&man, sig_b64, keys) else {
        return Err(SignError::Bad(
            "signature does not verify against a trusted key",
        ));
    };
    let rel = dir.join(version);
    let sig_line = format!("{}\n", sig_b64.trim());
    let sig_path = rel.join(format!("{BUNDLE}.sig"));
    // A repeat of the stored signature needs no work (and must not cost a hash
    // of the whole bundle per request: the .sig is public once signed).
    match fs::read_to_string(&sig_path) {
        Ok(existing) if existing == sig_line => return Ok((index, false)),
        Ok(_) => return Err(SignError::Conflict("a different signature already exists")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(SignError::Io(e.to_string())),
    }
    let bytes = fs::read(rel.join(BUNDLE))
        .map_err(|_| SignError::Conflict("the staged bundle is missing"))?;
    if sha256_hex(&bytes) != sha {
        return Err(SignError::Conflict(
            "the staged bundle differs from the pending sha256",
        ));
    }
    write_atomic(&rel.join(format!("{BUNDLE}.release")), man.as_bytes()).map_err(SignError::Io)?;
    write_atomic(&sig_path, sig_line.as_bytes()).map_err(SignError::Io)?;
    Ok((index, true))
}

fn drop_dir() -> Option<PathBuf> {
    let v = std::env::var(DROP_DIR_ENV).ok()?;
    let v = v.trim();
    (!v.is_empty()).then(|| PathBuf::from(v))
}

fn no_store(mut r: Response) -> Response {
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

fn sign_error(e: SignError) -> Response {
    match e {
        SignError::Bad(m) => refusal(StatusCode::BAD_REQUEST, m),
        SignError::Conflict(m) => refusal(StatusCode::CONFLICT, m),
        SignError::Io(m) => {
            eprintln!("[release-signing] io error: {m}");
            api_error(StatusCode::INTERNAL_SERVER_ERROR, "release drop box error")
        }
    }
}

pub(crate) async fn api_pending() -> Response {
    let Some(dir) = drop_dir() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let res = tokio::task::spawn_blocking(move || pending_json(&dir, &compiled_keys())).await;
    no_store(match res {
        Ok(Ok(Some(v))) => Json(v).into_response(),
        Ok(Ok(None)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(e)) => sign_error(e),
        Err(_) => api_error(StatusCode::INTERNAL_SERVER_ERROR, "release drop box error"),
    })
}

/// `POST /api/release-signing/signature`.
///
/// Authorization model, deliberately NOT a hub session: the only authority that
/// can bless a release is the offline signing key (deploy/release-keys.txt,
/// compiled in). The signer runs on a machine outside the fleet with no hub
/// login, so a session would add nothing an attacker with a session lacks -
/// whereas a valid Ed25519 signature over exactly the pending (version, sha256)
/// is unforgeable. The endpoint only stores public bytes next to a bundle that
/// is already published; it cannot change which bundle is pending.
pub(crate) async fn api_signature(
    State(st): State<AppState>,
    headers: HeaderMap,
    raw: axum::body::Bytes,
) -> Response {
    let Some(dir) = drop_dir() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(body) = serde_json::from_slice::<Value>(&raw) else {
        return no_store(
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "invalid JSON"})),
            )
                .into_response(),
        );
    };
    let ip = crate::rate_window::rate_ip(client_ip(&headers).as_deref());
    // No client address (a path around the proxy): refuse rather than share one
    // bucket that anyone could exhaust for the real signer.
    let Some(ip) = ip else {
        return no_store(
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "no client address"})),
            )
                .into_response(),
        );
    };
    let key = match check_window_quota(
        &st,
        &format!("release-sign:{ip}"),
        POSTS_PER_WINDOW,
        WINDOW_MS,
        "too many signature submissions",
    ) {
        Ok(k) => k,
        Err(r) => return no_store(r),
    };
    record_window_hit(&st, &key, WINDOW_MS);
    let field = |n: &str| {
        body.get(n)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let (version, sha, sig) = (field("version"), field("sha256"), field("signature"));
    let (v2, s2) = (version.clone(), sha.clone());
    // One submission at a time: two valid signatures racing must not overwrite
    // each other (or share the temp file) - the second sees the first's .sig.
    static SIGN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let res = tokio::task::spawn_blocking(move || {
        let _one = SIGN_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        accept_signature(&dir, &compiled_keys(), &v2, &s2, &sig)
    })
    .await;
    no_store(match res {
        Ok(Ok((index, fresh))) => {
            // A replay of the public signature is a no-op: no log, no Telegram.
            if fresh {
                let line = format!("signed {version} {}", &sha[..12]);
                eprintln!("[release-signing] {line}");
                notify_ops(format!("[release-signing] {line}"));
            }
            Json(json!({"ok": true, "keyIndex": index})).into_response()
        }
        Ok(Err(e)) => sign_error(e),
        Err(_) => api_error(StatusCode::INTERNAL_SERVER_ERROR, "release drop box error"),
    })
}

/// Fire-and-forget Telegram line when `CC_REMOTE_OPS_TG_*` is configured.
fn notify_ops(text: String) {
    let token = std::env::var("CC_REMOTE_OPS_TG_BOT_TOKEN").unwrap_or_default();
    let chat = std::env::var("CC_REMOTE_OPS_TG_CHAT_ID").unwrap_or_default();
    if token.trim().is_empty() || chat.trim().is_empty() {
        return;
    }
    tokio::spawn(async move {
        let url = format!("https://api.telegram.org/bot{}/sendMessage", token.trim());
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        // The url embeds the bot token: never print the error itself.
        if client
            .post(&url)
            .json(&json!({"chat_id": chat.trim(), "text": text}))
            .send()
            .await
            .is_err()
        {
            eprintln!("[release-signing] telegram request failed");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    use ring::rand::SystemRandom;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    fn kp() -> Ed25519KeyPair {
        let p = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        Ed25519KeyPair::from_pkcs8(p.as_ref()).unwrap()
    }
    fn pubkey(k: &Ed25519KeyPair) -> [u8; 32] {
        k.public_key().as_ref().try_into().unwrap()
    }
    fn sign(k: &Ed25519KeyPair, v: &str, sha: &str) -> String {
        B64.encode(k.sign(manifest(v, sha).as_bytes()).as_ref())
    }

    /// A drop dir with a staged bundle and pending.json; returns (dir, sha).
    fn rig(version: &str) -> (PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("release-drop-{}", Uuid::new_v4()));
        fs::create_dir_all(dir.join(version)).unwrap();
        let body = b"console.log('agent')";
        fs::write(dir.join(version).join(BUNDLE), body).unwrap();
        let sha = sha256_hex(body);
        fs::write(
            dir.join("pending.json"),
            json!({"version": version, "sha256": sha, "url": "u", "commit": "c", "createdAt": "t"})
                .to_string(),
        )
        .unwrap();
        (dir, sha)
    }

    #[test]
    fn pending_absent_present_and_invalid() {
        let k = kp();
        let dir = std::env::temp_dir().join(format!("release-drop-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(pending_json(&dir, &[pubkey(&k)]), Ok(None));
        let (dir, sha) = rig("1.2.3");
        let v = pending_json(&dir, &[pubkey(&k)]).unwrap().unwrap();
        assert_eq!(v["version"], "1.2.3");
        assert_eq!(v["sha256"], sha);
        assert_eq!(v["signed"], false);
        // Path traversal and bad sha never reach a path.
        for (ver, s) in [("../x", sha.as_str()), ("1.0", "zz")] {
            fs::write(
                dir.join("pending.json"),
                json!({"version": ver, "sha256": s}).to_string(),
            )
            .unwrap();
            assert!(matches!(
                pending_json(&dir, &[pubkey(&k)]),
                Err(SignError::Bad(_))
            ));
        }
    }

    #[test]
    fn good_signature_is_stored_and_reported_signed() {
        let k = kp();
        let (dir, sha) = rig("1.2.3");
        let sig = sign(&k, "1.2.3", &sha);
        let other = kp();
        let keys = [pubkey(&other), pubkey(&k)];
        assert_eq!(
            accept_signature(&dir, &keys, "1.2.3", &sha, &sig).map(|r| r.0),
            Ok(1)
        );
        let rel = dir.join("1.2.3");
        assert_eq!(
            fs::read_to_string(rel.join("agent-external.mjs.release")).unwrap(),
            manifest("1.2.3", &sha)
        );
        assert_eq!(
            fs::read_to_string(rel.join("agent-external.mjs.sig")).unwrap(),
            format!("{sig}\n")
        );
        assert_eq!(pending_json(&dir, &keys).unwrap().unwrap()["signed"], true);
        // Idempotent.
        assert_eq!(
            accept_signature(&dir, &keys, "1.2.3", &sha, &sig).map(|r| r.0),
            Ok(1)
        );
    }

    #[test]
    fn bad_signature_is_400_and_writes_nothing() {
        let (k, stranger) = (kp(), kp());
        let (dir, sha) = rig("1.2.3");
        let keys = [pubkey(&k)];
        for sig in [
            sign(&stranger, "1.2.3", &sha),
            "!!".to_string(),
            String::new(),
        ] {
            assert!(matches!(
                accept_signature(&dir, &keys, "1.2.3", &sha, &sig),
                Err(SignError::Bad(_))
            ));
        }
        // Signature over a different manifest.
        let wrong = sign(&k, "9.9.9", &sha);
        assert!(matches!(
            accept_signature(&dir, &keys, "1.2.3", &sha, &wrong),
            Err(SignError::Bad(_))
        ));
        assert!(!dir.join("1.2.3").join("agent-external.mjs.sig").exists());
    }

    #[test]
    fn wrong_version_or_sha_is_409() {
        let k = kp();
        let (dir, sha) = rig("1.2.3");
        let keys = [pubkey(&k)];
        let other_sha = "0".repeat(64);
        for (v, s) in [("1.2.4", sha.as_str()), ("1.2.3", other_sha.as_str())] {
            let sig = sign(&k, v, s);
            assert!(matches!(
                accept_signature(&dir, &keys, v, s, &sig),
                Err(SignError::Conflict(_))
            ));
        }
        fs::remove_file(dir.join("pending.json")).unwrap();
        let sig = sign(&k, "1.2.3", &sha);
        assert!(matches!(
            accept_signature(&dir, &keys, "1.2.3", &sha, &sig),
            Err(SignError::Conflict(_))
        ));
    }

    #[test]
    fn staged_file_that_differs_is_refused() {
        let k = kp();
        let (dir, sha) = rig("1.2.3");
        fs::write(dir.join("1.2.3").join(BUNDLE), b"tampered").unwrap();
        let sig = sign(&k, "1.2.3", &sha);
        assert!(matches!(
            accept_signature(&dir, &[pubkey(&k)], "1.2.3", &sha, &sig),
            Err(SignError::Conflict(_))
        ));
        assert!(!dir.join("1.2.3").join("agent-external.mjs.sig").exists());
    }

    #[test]
    fn a_different_existing_signature_is_not_overwritten() {
        let (k, k2) = (kp(), kp());
        let (dir, sha) = rig("1.2.3");
        let keys = [pubkey(&k), pubkey(&k2)];
        let first = sign(&k, "1.2.3", &sha);
        accept_signature(&dir, &keys, "1.2.3", &sha, &first).unwrap();
        let second = sign(&k2, "1.2.3", &sha);
        assert!(matches!(
            accept_signature(&dir, &keys, "1.2.3", &sha, &second),
            Err(SignError::Conflict(_))
        ));
        assert_eq!(
            fs::read_to_string(dir.join("1.2.3").join("agent-external.mjs.sig")).unwrap(),
            format!("{first}\n")
        );
    }
}
