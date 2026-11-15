//! Self-hosted hub: the server it runs on joins as the owner's machine without
//! a code typed by hand (`deploy/selfhost/connect-host.sh`), and `/app/qr.svg`
//! hands the phone-app page a QR code.
//!
//! `CC_REMOTE_HOST_ENROLLMENT_SECRET` (>= 32 chars) is seeded at start as ONE
//! ordinary enrollment code of the bootstrap owner: single use, the exchange
//! path is the normal one (`exchange_enrollment`), so a used secret stays used
//! across restarts. Whoever can read `.env` can enroll one machine as the owner.

use axum::extract::State;
use axum::http::{header, HeaderMap};
use axum::response::{IntoResponse, Response};
use qrcode::{render::svg, QrCode};
use rusqlite::params;

use super::*;
use crate::workspace::{db_err, hash_token, now_ms, WorkspaceStore};

const MIN_SECRET_CHARS: usize = 32;
const TEN_YEARS_MS: i64 = 10 * 365 * 24 * 3600 * 1000;

impl WorkspaceStore {
    /// Seed the host enrollment code for `user_id`. Idempotent: the row is
    /// keyed by the code hash, so a restart never re-arms a used secret.
    /// `exchange_enrollment` uppercases the code before hashing; so do we.
    pub(crate) fn seed_host_enrollment(&self, user_id: &str, secret: &str) -> Result<(), String> {
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.execute(
            "INSERT OR IGNORE INTO enrollments(code_hash,user_id,created_at,expires_at,purpose) VALUES(?1,?2,?3,?4,'device')",
            params![
                hash_token(&secret.to_ascii_uppercase()),
                user_id,
                now,
                now + TEN_YEARS_MS
            ],
        )
        .map_err(db_err)?;
        Ok(())
    }
}

/// Startup hook: read the env, seed, log. A short secret is ignored loudly.
pub(crate) fn seed_from_env(workspaces: &WorkspaceStore, owner_user_id: &str) {
    let Ok(secret) = std::env::var("CC_REMOTE_HOST_ENROLLMENT_SECRET") else {
        return;
    };
    if secret.is_empty() {
        return;
    }
    if secret.chars().count() < MIN_SECRET_CHARS {
        eprintln!(
            "[host-enroll] CC_REMOTE_HOST_ENROLLMENT_SECRET is shorter than {MIN_SECRET_CHARS} characters - ignored"
        );
        return;
    }
    match workspaces.seed_host_enrollment(owner_user_id, &secret) {
        Ok(()) => println!("[host-enroll] host enrollment secret armed for the owner (single use)"),
        Err(e) => eprintln!("[host-enroll] could not seed the host enrollment secret: {e}"),
    }
}

/// `scheme://host` the visitor reached: `public_url` when it is a real address,
/// else the request's own Host (a dev hub on loopback).
fn app_origin(public_url: &str, headers: &HeaderMap) -> String {
    let configured = public_url.trim_end_matches('/');
    let loopback = configured.contains("://127.0.0.1") || configured.contains("://localhost");
    if !configured.is_empty() && !loopback {
        return configured.to_string();
    }
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .filter(|h| {
            !h.is_empty()
                && h.chars()
                    .all(|c| c.is_ascii_alphanumeric() || ".-:[]".contains(c))
        });
    match host {
        Some(h) => format!("http://{h}"),
        None => configured.to_string(),
    }
}

fn qr_svg(data: &str) -> Option<String> {
    let code = QrCode::new(data.as_bytes()).ok()?;
    Some(
        code.render::<svg::Color>()
            .min_dimensions(224, 224)
            .quiet_zone(true)
            .dark_color(svg::Color("#000000"))
            .light_color(svg::Color("#ffffff"))
            .build(),
    )
}

/// `GET /app/qr.svg` — public; the QR of `<origin>/app`.
pub(crate) async fn app_qr_svg(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let url = format!("{}/app", app_origin(&st.public_url, &headers));
    match qr_svg(&url) {
        Some(svg) => (
            [
                (header::CONTENT_TYPE, "image/svg+xml"),
                (header::CACHE_CONTROL, "public, max-age=3600"),
            ],
            svg,
        )
            .into_response(),
        None => axum::http::StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SECRET: &str = "abcdef0123456789abcdef0123456789abcdef0123456789";

    fn machine() -> serde_json::Value {
        json!({"machineId":"host-1","name":"srv","os":"linux","agentVersion":"1"})
    }

    #[test]
    fn host_secret_exchanges_once_and_restart_does_not_rearm() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("owner", "o@x", None).unwrap();
        s.seed_host_enrollment("owner", SECRET).unwrap();
        let out = s.exchange_enrollment(SECRET, &machine()).unwrap();
        assert_eq!(out["ownerUserId"], "owner");
        assert!(s.exchange_enrollment(SECRET, &machine()).is_err());
        // a restart seeds again: still used
        s.seed_host_enrollment("owner", SECRET).unwrap();
        assert!(s.exchange_enrollment(SECRET, &machine()).is_err());
    }

    #[test]
    fn origin_prefers_public_url_then_host() {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, "code.example.com".parse().unwrap());
        assert_eq!(
            app_origin("https://hub.example.com/", &h),
            "https://hub.example.com"
        );
        assert_eq!(
            app_origin("http://127.0.0.1:4319", &h),
            "http://code.example.com"
        );
    }

    #[test]
    fn qr_is_svg() {
        assert!(qr_svg("https://x.example/app").unwrap().contains("<svg"));
    }
}
