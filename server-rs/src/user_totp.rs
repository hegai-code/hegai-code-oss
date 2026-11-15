#![allow(dead_code)] // consumed by local login (sign-in 2FA) and the rollout approval
//! A user's authenticator (TOTP) enrolment, stored in the hub's SQLite.
//!
//! One row per user. Enrolment is two steps so a typo in the phone never locks
//! anyone out: `begin` stores an UNCONFIRMED secret and returns it for the QR
//! code; `confirm` accepts it only after the user types a code it produced,
//! and returns ten recovery codes (shown once, stored as hashes).
//!
//! `verify` is the only way a code is checked anywhere in the hub. It accepts a
//! current TOTP code — once: the step it matched is written back atomically and
//! an equal or earlier step is refused afterwards — or one unused recovery
//! code, which is then burned.

use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::totp;

pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS user_totp (
            user_id       TEXT PRIMARY KEY,
            secret        TEXT NOT NULL,
            confirmed_at  INTEGER,
            last_step     INTEGER,
            recovery_json TEXT NOT NULL DEFAULT '[]',
            created_at    INTEGER NOT NULL
        );",
    )
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn hash_recovery(code: &str) -> String {
    let norm: String = code
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    hex(&Sha256::digest(
        format!("hegai-totp-recovery:{norm}").as_bytes(),
    ))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// True once the user has a CONFIRMED authenticator.
pub fn is_enrolled(conn: &Connection, user_id: &str) -> rusqlite::Result<bool> {
    let row: Option<Option<i64>> = conn
        .query_row(
            "SELECT confirmed_at FROM user_totp WHERE user_id = ?1",
            params![user_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(matches!(row, Some(Some(_))))
}

#[derive(Debug, PartialEq, Eq)]
pub enum BeginError {
    /// A confirmed authenticator exists; replacing it needs `reset` first
    /// (an admin action, audited by the caller).
    AlreadyEnrolled,
    Db(String),
}

/// Start (or restart) enrolment: a fresh secret, unconfirmed. Returns the
/// base32 secret; the caller shows it with `totp::otpauth_uri`.
pub fn begin(conn: &Connection, user_id: &str) -> Result<String, BeginError> {
    if is_enrolled(conn, user_id).map_err(|e| BeginError::Db(crate::workspace::db_err(e)))? {
        return Err(BeginError::AlreadyEnrolled);
    }
    let secret = totp::new_secret();
    conn.execute(
        "INSERT INTO user_totp (user_id, secret, confirmed_at, last_step, recovery_json, created_at)
         VALUES (?1, ?2, NULL, NULL, '[]', ?3)
         ON CONFLICT(user_id) DO UPDATE SET secret = excluded.secret, confirmed_at = NULL,
             last_step = NULL, recovery_json = '[]', created_at = excluded.created_at
         WHERE user_totp.confirmed_at IS NULL",
        params![user_id, secret, now_ms()],
    )
    .map_err(|e| BeginError::Db(crate::workspace::db_err(e)))?;
    Ok(secret)
}

/// Confirm enrolment with a code from the app. On success returns the ten
/// recovery codes in clear — the only time they exist outside the user's hands.
pub fn confirm(
    conn: &Connection,
    user_id: &str,
    code: &str,
    unix_secs: u64,
) -> rusqlite::Result<Option<Vec<String>>> {
    let row: Option<(String, Option<i64>)> = conn
        .query_row(
            "SELECT secret, confirmed_at FROM user_totp WHERE user_id = ?1",
            params![user_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((secret, None)) = row else {
        return Ok(None);
    };
    let Some(step) = totp::verify(&secret, code, unix_secs, None) else {
        return Ok(None);
    };
    let codes = totp::recovery_codes();
    let hashes: Vec<String> = codes.iter().map(|c| hash_recovery(c)).collect();
    let changed = conn.execute(
        "UPDATE user_totp SET confirmed_at = ?2, last_step = ?3, recovery_json = ?4
         WHERE user_id = ?1 AND confirmed_at IS NULL",
        params![
            user_id,
            now_ms(),
            step as i64,
            serde_json::to_string(&hashes).unwrap_or_else(|_| "[]".into())
        ],
    )?;
    Ok(if changed == 1 { Some(codes) } else { None })
}

/// Check a code for a user with a confirmed authenticator: a TOTP code (once)
/// or an unused recovery code (burned). False for anything else, including a
/// user who never enrolled.
pub fn verify(
    conn: &Connection,
    user_id: &str,
    code: &str,
    unix_secs: u64,
) -> rusqlite::Result<bool> {
    let row: Option<(String, Option<i64>, Option<i64>, String)> = conn
        .query_row(
            "SELECT secret, confirmed_at, last_step, recovery_json FROM user_totp WHERE user_id = ?1",
            params![user_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((secret, Some(_), last_step, recovery_json)) = row else {
        return Ok(false);
    };
    let digits: String = code.chars().filter(|c| !c.is_whitespace()).collect();
    if digits.len() == totp::DIGITS as usize && digits.bytes().all(|b| b.is_ascii_digit()) {
        let Some(step) = totp::verify(&secret, &digits, unix_secs, last_step.map(|s| s as u64))
        else {
            return Ok(false);
        };
        // Compare-and-set: two requests racing with the same code — one wins.
        let changed = conn.execute(
            "UPDATE user_totp SET last_step = ?2
             WHERE user_id = ?1 AND (last_step IS NULL OR last_step < ?2)",
            params![user_id, step as i64],
        )?;
        return Ok(changed == 1);
    }
    // Recovery code.
    let want = hash_recovery(code);
    let mut hashes: Vec<String> = serde_json::from_str(&recovery_json).unwrap_or_default();
    let Some(pos) = hashes.iter().position(|h| h == &want) else {
        return Ok(false);
    };
    hashes.remove(pos);
    let changed = conn.execute(
        "UPDATE user_totp SET recovery_json = ?2 WHERE user_id = ?1 AND recovery_json = ?3",
        params![
            user_id,
            serde_json::to_string(&hashes).unwrap_or_else(|_| "[]".into()),
            recovery_json
        ],
    )?;
    Ok(changed == 1)
}

/// Replace the recovery codes of a CONFIRMED authenticator with ten fresh ones
/// (shown once); the old ones stop working. `None` if the user has none.
pub fn regenerate_recovery(
    conn: &Connection,
    user_id: &str,
) -> rusqlite::Result<Option<Vec<String>>> {
    let codes = totp::recovery_codes();
    let hashes: Vec<String> = codes.iter().map(|c| hash_recovery(c)).collect();
    let changed = conn.execute(
        "UPDATE user_totp SET recovery_json = ?2 WHERE user_id = ?1 AND confirmed_at IS NOT NULL",
        params![
            user_id,
            serde_json::to_string(&hashes).unwrap_or_else(|_| "[]".into())
        ],
    )?;
    Ok((changed == 1).then_some(codes))
}

/// How many recovery codes the user has left.
pub fn recovery_left(conn: &Connection, user_id: &str) -> rusqlite::Result<usize> {
    let json: Option<String> = conn
        .query_row(
            "SELECT recovery_json FROM user_totp WHERE user_id = ?1",
            params![user_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(json
        .and_then(|j| serde_json::from_str::<Vec<String>>(&j).ok())
        .map(|v| v.len())
        .unwrap_or(0))
}

/// Remove the user's authenticator (lost phone, handled by an admin). The
/// caller writes the audit event.
pub fn reset(conn: &Connection, user_id: &str) -> rusqlite::Result<bool> {
    Ok(conn.execute("DELETE FROM user_totp WHERE user_id = ?1", params![user_id])? == 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init_schema(&c).unwrap();
        c
    }

    fn code_now(secret: &str, t: u64) -> String {
        let raw = totp::base32_decode(secret).unwrap();
        format!("{:06}", totp::code_at(&raw, totp::step_of(t)))
    }

    #[test]
    fn enrol_confirm_verify_once() {
        let c = db();
        let t = 1_800_000_000u64;
        assert!(!is_enrolled(&c, "u").unwrap());
        let s = begin(&c, "u").unwrap();
        // a wrong code does not confirm
        let wrong = if code_now(&s, t) == "000000" {
            "111111"
        } else {
            "000000"
        };
        assert!(confirm(&c, "u", wrong, t).unwrap().is_none());
        let codes = confirm(&c, "u", &code_now(&s, t), t)
            .unwrap()
            .expect("confirmed");
        assert_eq!(codes.len(), 10);
        assert!(is_enrolled(&c, "u").unwrap());
        assert_eq!(begin(&c, "u"), Err(BeginError::AlreadyEnrolled));
        // the confirmation step itself is spent
        assert!(!verify(&c, "u", &code_now(&s, t), t).unwrap());
        // next step works once
        let t2 = t + totp::STEP_SECS;
        assert!(verify(&c, "u", &code_now(&s, t2), t2).unwrap());
        assert!(!verify(&c, "u", &code_now(&s, t2), t2).unwrap());
        // recovery code works once
        assert_eq!(recovery_left(&c, "u").unwrap(), 10);
        assert!(verify(&c, "u", &codes[3].to_lowercase(), t2).unwrap());
        assert!(!verify(&c, "u", &codes[3], t2).unwrap());
        assert_eq!(recovery_left(&c, "u").unwrap(), 9);
        // reset
        assert!(reset(&c, "u").unwrap());
        assert!(!verify(&c, "u", &codes[4], t2).unwrap());
    }

    #[test]
    fn unconfirmed_or_unknown_never_verifies() {
        let c = db();
        let t = 1_800_000_000u64;
        assert!(!verify(&c, "nobody", "123456", t).unwrap());
        let s = begin(&c, "u").unwrap();
        assert!(!verify(&c, "u", &code_now(&s, t), t).unwrap());
    }
}
