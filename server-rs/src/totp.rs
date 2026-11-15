#![allow(dead_code)] // consumed by the external-edition login, rollout and support modules
//! TOTP (RFC 6238) — the six-digit codes of Google Authenticator and every
//! compatible app: HMAC-SHA1, 30-second step, 6 digits, base32 secret.
//!
//! Used by the external edition wherever a password alone is not enough: the
//! local owner's sign-in and the owner's approval of an agent rollout. The
//! secret is generated here, shown once as an `otpauth://` URI (the app scans
//! it as a QR code) and stored by the caller; this module never persists.
//!
//! Replay: a code stays valid for its whole window (±1 step of clock skew), so
//! a caller that must not accept the same code twice passes the last accepted
//! step back in and stores the one returned — `verify` refuses any step at or
//! before it.

use ring::hmac;
use ring::rand::{SecureRandom, SystemRandom};

pub const STEP_SECS: u64 = 30;
pub const DIGITS: u32 = 6;
/// Steps of clock skew accepted on each side of now.
pub const SKEW_STEPS: u64 = 1;

const B32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// A fresh 160-bit secret, base32 without padding (what authenticator apps expect).
pub fn new_secret() -> String {
    let mut raw = [0u8; 20];
    SystemRandom::new()
        .fill(&mut raw)
        .expect("system randomness is available");
    base32_encode(&raw)
}

pub fn base32_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(5) * 8);
    let mut buf: u64 = 0;
    let mut bits = 0u32;
    for &b in data {
        buf = (buf << 8) | u64::from(b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(B32[((buf >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(B32[((buf << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// Decode base32 leniently: case, spaces and `=` padding are ignored (people
/// retype secrets by hand). Any other character is an error.
pub fn base32_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 5 / 8);
    let mut buf: u64 = 0;
    let mut bits = 0u32;
    for c in text.chars() {
        if c == ' ' || c == '=' || c == '-' {
            continue;
        }
        let v = B32
            .iter()
            .position(|&x| x as char == c.to_ascii_uppercase())? as u64;
        buf = (buf << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xff) as u8);
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// The code for one time step.
pub fn code_at(secret: &[u8], step: u64) -> u32 {
    let key = hmac::Key::new(hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, secret);
    let tag = hmac::sign(&key, &step.to_be_bytes());
    let h = tag.as_ref();
    let off = (h[h.len() - 1] & 0x0f) as usize;
    let bin = (u32::from(h[off] & 0x7f) << 24)
        | (u32::from(h[off + 1]) << 16)
        | (u32::from(h[off + 2]) << 8)
        | u32::from(h[off + 3]);
    bin % 10u32.pow(DIGITS)
}

pub fn step_of(unix_secs: u64) -> u64 {
    unix_secs / STEP_SECS
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Check `code` against the base32 `secret` at `unix_secs`.
///
/// Returns the matched step on success. `after_step` is the last step this
/// secret already accepted (None if never): a code from that step or earlier is
/// refused even if it is still inside the window — that is the replay guard.
/// Every candidate step is evaluated; there is no early exit on a match.
pub fn verify(
    secret_b32: &str,
    code: &str,
    unix_secs: u64,
    after_step: Option<u64>,
) -> Option<u64> {
    let code = code.trim().replace(' ', "");
    if code.len() != DIGITS as usize || !code.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let want: u32 = code.parse().ok()?;
    let secret = base32_decode(secret_b32)?;
    let now = step_of(unix_secs);
    let mut matched: Option<u64> = None;
    for step in now.saturating_sub(SKEW_STEPS)..=now + SKEW_STEPS {
        let got = code_at(&secret, step);
        // Evaluate every step; no early return on a hit. One-word XOR, no
        // byte-by-byte early exit.
        let eq = (got ^ want) == 0;
        if eq && matched.is_none() {
            matched = Some(step);
        }
    }
    let step = matched?;
    match after_step {
        Some(last) if step <= last => None,
        _ => Some(step),
    }
}

/// The `otpauth://` URI an authenticator app imports (usually as a QR code).
pub fn otpauth_uri(issuer: &str, account: &str, secret_b32: &str) -> String {
    let label = format!("{}:{}", issuer, account);
    format!(
        "otpauth://totp/{}?secret={}&issuer={}&algorithm=SHA1&digits={}&period={}",
        urlencoding::encode(&label),
        secret_b32,
        urlencoding::encode(issuer),
        DIGITS,
        STEP_SECS
    )
}

/// Ten one-time recovery codes (`xxxx-xxxx`, base32 alphabet) for when the
/// phone is lost. The caller stores only their hashes.
pub fn recovery_codes() -> Vec<String> {
    let rng = SystemRandom::new();
    (0..10)
        .map(|_| {
            let mut raw = [0u8; 5];
            rng.fill(&mut raw).expect("system randomness is available");
            let s = base32_encode(&raw);
            format!("{}-{}", &s[..4], &s[4..8])
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 6238 appendix B, SHA1 seed "12345678901234567890" (8-digit vectors
    // truncated to 6 = the last six digits).
    const SEED: &[u8] = b"12345678901234567890";

    #[test]
    fn rfc6238_vectors() {
        let cases = [
            (59u64, 94287082u32),
            (1111111109, 7081804),
            (1111111111, 14050471),
            (1234567890, 89005924),
            (2000000000, 69279037),
        ];
        for (t, eight) in cases {
            assert_eq!(code_at(SEED, step_of(t)), eight % 1_000_000, "t={t}");
        }
    }

    #[test]
    fn base32_round_trip_and_lenient_decode() {
        let b = base32_encode(SEED);
        assert_eq!(b, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
        assert_eq!(base32_decode(&b).unwrap(), SEED);
        assert_eq!(
            base32_decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq").unwrap(),
            SEED
        );
        assert!(base32_decode("not!base32").is_none());
        assert!(base32_decode("").is_none());
    }

    #[test]
    fn verify_accepts_window_and_refuses_replay() {
        let secret = base32_encode(SEED);
        let t = 1234567890u64;
        let code = format!("{:06}", code_at(SEED, step_of(t)));
        let step = verify(&secret, &code, t, None).expect("valid");
        assert_eq!(step, step_of(t));
        // one step of skew either way
        assert!(verify(&secret, &code, t + STEP_SECS, None).is_some());
        assert!(verify(&secret, &code, t - STEP_SECS, None).is_some());
        assert!(verify(&secret, &code, t + 3 * STEP_SECS, None).is_none());
        // replay of the same step is refused
        assert!(verify(&secret, &code, t, Some(step)).is_none());
        // garbage
        assert!(verify(&secret, "12345", t, None).is_none());
        assert!(verify(&secret, "abcdef", t, None).is_none());
    }

    #[test]
    fn fresh_secret_and_uri() {
        let s = new_secret();
        assert_eq!(s.len(), 32);
        assert_eq!(base32_decode(&s).unwrap().len(), 20);
        let uri = otpauth_uri("Hegai Code", "owner@example.com", &s);
        assert!(uri.starts_with("otpauth://totp/Hegai%20Code%3Aowner%40example.com?secret="));
        let codes = recovery_codes();
        assert_eq!(codes.len(), 10);
        assert!(codes
            .iter()
            .all(|c| c.len() == 9 && c.as_bytes()[4] == b'-'));
    }
}
