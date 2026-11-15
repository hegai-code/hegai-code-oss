//! Profile photos — `GET /api/avatar/{user_id}` (27.09.2026, by request:
//! «иконку ПХ сделаем круглую и мою фотку из тг добавим, для остальных тоже»).
//!
//! The only photo this hub can honestly get is Telegram's: an account that
//! signed in with Telegram or linked it (Настройки → «Привязать Telegram") has
//! an `identities` row with the Telegram id, and the login bot may read that
//! user's profile photo through the Bot API. The a.test SSO carries no picture.
//!
//! What this is careful about:
//! - **The bot token never leaves the hub.** Telegram's file URL embeds it
//!   (`/file/bot<token>/…`), so the bytes are fetched here and served from
//!   here. Errors are mapped to fixed words before they are logged — a reqwest
//!   error's Display carries the URL, and with it the token.
//! - **Who may look.** The person themselves and anyone they share a
//!   workspace with — the same circle that already sees their name on a
//!   session. Everyone else gets the same 404 as «no photo», so the endpoint
//!   does not answer «does this user exist / have Telegram».
//! - **Telegram is asked rarely.** One row per user in `avatars`: a photo for
//!   a day, «none» for six hours, so a page full of initials does not become
//!   a request per render.
//!
//! Token: `CC_REMOTE_AVATAR_BOT_TOKEN` (the login bot's). Unset → every
//! request is 404 and the web draws initials, as it always did.

use super::*;
use rusqlite::{params, Connection, OptionalExtension};

const TTL_PHOTO_MS: i64 = 24 * 3600 * 1000;
const TTL_NONE_MS: i64 = 6 * 3600 * 1000;
/// A profile photo at the size asked for is ~10–30 KB; anything past this is
/// not what we asked for.
const MAX_BYTES: usize = 512 * 1024;
/// The smallest Telegram size at least this wide — a 40px avatar at 3× is 120.
const WANT_WIDTH: u64 = 160;
/// Each Bot API call may take this long, not the shared client's 90 s.
const CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
/// After a FAILED fetch (Telegram down, 429), how long to answer «none»
/// without asking again — short, so a hiccup does not hide photos for hours,
/// and long enough that a page of avatars cannot turn into a request storm.
const RETRY_AFTER_MS: i64 = 5 * 60 * 1000;

/// At most two Telegram fetches at once, hub-wide. The token is the LOGIN
/// bot's: a burst of avatar misses that earned it a 429 would break «Войти
/// через Telegram» for everyone. Past the limit a request is simply «no photo
/// yet» — the initials stay and the next render asks again.
static FETCHING: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

/// A Bot API answer is `{"ok":true,"result":…}`; anything else (429, 401,
/// 400) is a failure to report, not an empty result to cache as «none».
fn ok(v: Value) -> Result<Value, &'static str> {
    if v.get("ok") == Some(&Value::Bool(true)) {
        Ok(v)
    } else {
        Err("telegram said no")
    }
}

/// What the bytes ARE, by their magic — never by the name Telegram gave the
/// file. Served from our origin with the session cookie, a mislabelled
/// payload must not be able to become anything but a picture.
pub(crate) fn sniff(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if b.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("image/png")
    } else if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

pub(crate) fn init_avatar_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS avatars (
          user_id      TEXT PRIMARY KEY,
          content_type TEXT,
          bytes        BLOB,
          fetched_at   INTEGER NOT NULL,
          FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
        );
        "#,
    )
    .map_err(crate::workspace::db_err)
}

/// May `viewer` see `target`'s photo? Themselves, or a shared workspace.
pub(crate) fn may_view(conn: &Connection, viewer: &str, target: &str) -> Result<bool, String> {
    if viewer == target {
        return Ok(true);
    }
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM memberships a JOIN memberships b ON a.workspace_id=b.workspace_id \
         WHERE a.user_id=?1 AND b.user_id=?2)",
        params![viewer, target],
        |r| r.get::<_, bool>(0),
    )
    .map_err(crate::workspace::db_err)
}

/// A cached answer, if still fresh: `Some(Some(photo))`, `Some(None)` = known
/// to have none, `None` = ask Telegram.
type Photo = (String, Vec<u8>);
fn cached(conn: &Connection, user: &str, now: i64) -> Result<Option<Option<Photo>>, String> {
    let row: Option<(Option<String>, Option<Vec<u8>>, i64)> = conn
        .query_row(
            "SELECT content_type, bytes, fetched_at FROM avatars WHERE user_id=?1",
            [user],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(crate::workspace::db_err)?;
    Ok(match row {
        Some((Some(ct), Some(b), at)) if now - at < TTL_PHOTO_MS => Some(Some((ct, b))),
        Some((_, None, at)) if now - at < TTL_NONE_MS => Some(None),
        _ => None,
    })
}

fn store(conn: &Connection, user: &str, photo: Option<&Photo>, now: i64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO avatars(user_id,content_type,bytes,fetched_at) VALUES(?1,?2,?3,?4) \
         ON CONFLICT(user_id) DO UPDATE SET content_type=excluded.content_type, bytes=excluded.bytes, fetched_at=excluded.fetched_at",
        params![user, photo.map(|p| p.0.as_str()), photo.map(|p| p.1.as_slice()), now],
    )
    .map(|_| ())
    .map_err(crate::workspace::db_err)
}

fn telegram_id(conn: &Connection, user: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT subject FROM identities WHERE provider=?1 AND user_id=?2 ORDER BY created_at LIMIT 1",
        params![crate::telegram_login::PROVIDER_TELEGRAM, user],
        |r| r.get(0),
    )
    .optional()
    .map_err(crate::workspace::db_err)
}

/// Pick the file to download from one `getUserProfilePhotos` entry: the
/// smallest size at least `WANT_WIDTH` wide, else the largest there is.
pub(crate) fn pick_size(sizes: &[Value]) -> Option<String> {
    let width = |v: &Value| v.get("width").and_then(Value::as_u64).unwrap_or(0);
    let id = |v: &Value| v.get("file_id").and_then(Value::as_str).map(str::to_string);
    let mut fit: Vec<&Value> = sizes.iter().filter(|v| width(v) >= WANT_WIDTH).collect();
    fit.sort_by_key(|v| width(v));
    fit.first()
        .and_then(|v| id(v))
        .or_else(|| sizes.iter().max_by_key(|v| width(v)).and_then(id))
}

/// Ask Telegram for the photo. `Ok(None)` = the user has none (or hides it
/// from bots). Errors are fixed words — never the request URL.
async fn fetch(
    http: &reqwest::Client,
    token: &str,
    tg_id: &str,
) -> Result<Option<Photo>, &'static str> {
    let api = |method: &str| format!("https://api.telegram.org/bot{token}/{method}");
    let photos: Value = ok(http
        .get(api("getUserProfilePhotos"))
        .query(&[("user_id", tg_id), ("limit", "1")])
        .timeout(CALL_TIMEOUT)
        .send()
        .await
        .map_err(|_| "telegram unreachable")?
        .json()
        .await
        .map_err(|_| "telegram answered garbage")?)?;
    let Some(sizes) = photos.pointer("/result/photos/0").and_then(Value::as_array) else {
        return Ok(None);
    };
    let Some(file_id) = pick_size(sizes) else {
        return Ok(None);
    };
    let file: Value = ok(http
        .get(api("getFile"))
        .query(&[("file_id", file_id.as_str())])
        .timeout(CALL_TIMEOUT)
        .send()
        .await
        .map_err(|_| "telegram unreachable")?
        .json()
        .await
        .map_err(|_| "telegram answered garbage")?)?;
    let Some(path) = file.pointer("/result/file_path").and_then(Value::as_str) else {
        return Ok(None);
    };
    let resp = http
        .get(format!("https://api.telegram.org/file/bot{token}/{path}"))
        .timeout(CALL_TIMEOUT)
        .send()
        .await
        .map_err(|_| "telegram unreachable")?;
    if !resp.status().is_success() {
        return Err("telegram refused the file");
    }
    if resp
        .content_length()
        .is_some_and(|n| n as usize > MAX_BYTES)
    {
        return Err("telegram file of an unexpected size");
    }
    let bytes = resp.bytes().await.map_err(|_| "telegram file cut short")?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err("telegram file of an unexpected size");
    }
    let Some(ct) = sniff(&bytes) else {
        return Err("telegram file is not a picture");
    };
    Ok(Some((ct.to_string(), bytes.to_vec())))
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(header::CACHE_CONTROL, "private, max-age=600")],
    )
        .into_response()
}

fn photo_response(photo: Photo) -> Response {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, photo.0),
            (header::CACHE_CONTROL, "private, max-age=3600".to_string()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_string()),
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; sandbox".to_string(),
            ),
        ],
        photo.1,
    )
        .into_response()
}

pub(crate) async fn api_avatar(
    State(st): State<AppState>,
    AxumPath(user): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    let viewer = gate!(authenticated_user(&headers, &st));
    // A waitlisted viewer sees nothing of anyone else (rule 5).
    if viewer != user && require_active(&st, &viewer).is_err() {
        return not_found();
    }
    let now = now_ms();
    let lookup = {
        let Ok(conn) = st.workspaces.conn.lock() else {
            return not_found();
        };
        match may_view(&conn, &viewer, &user) {
            Ok(true) => {}
            _ => return not_found(),
        }
        match cached(&conn, &user, now) {
            Ok(Some(Some(photo))) => return photo_response(photo),
            Ok(Some(None)) => return not_found(),
            Ok(None) => {}
            Err(_) => return not_found(),
        }
        telegram_id(&conn, &user)
    };
    let Ok(Some(tg)) = lookup else {
        return not_found();
    };
    let Some(token) = st.avatar_bot_token.as_deref() else {
        return not_found();
    };
    let Ok(_permit) = FETCHING.try_acquire() else {
        return not_found();
    };
    match fetch(&st.azure_http, token, &tg).await {
        Ok(photo) => {
            if let Ok(conn) = st.workspaces.conn.lock() {
                let _ = store(&conn, &user, photo.as_ref(), now);
            }
            match photo {
                Some(p) => photo_response(p),
                None => not_found(),
            }
        }
        Err(why) => {
            // Cached as «none» for RETRY_AFTER_MS only: a hiccup must not pin
            // «no photo» for six hours, nor make every render ask again.
            eprintln!("[avatar] {user}: {why}");
            if let Ok(conn) = st.workspaces.conn.lock() {
                let _ = store(&conn, &user, None, now - TTL_NONE_MS + RETRY_AFTER_MS);
            }
            not_found()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE users(user_id TEXT PRIMARY KEY);
             CREATE TABLE memberships(workspace_id TEXT, user_id TEXT);
             CREATE TABLE identities(provider TEXT, subject TEXT, user_id TEXT, created_at INTEGER);
             INSERT INTO users VALUES('a'),('b'),('c');
             INSERT INTO memberships VALUES('w1','a'),('w1','b'),('w2','c');",
        )
        .unwrap();
        init_avatar_schema(&c).unwrap();
        c
    }

    #[test]
    fn only_self_and_workspace_mates_may_look() {
        let c = db();
        assert!(may_view(&c, "a", "a").unwrap());
        assert!(may_view(&c, "a", "b").unwrap());
        assert!(!may_view(&c, "a", "c").unwrap());
        assert!(!may_view(&c, "c", "b").unwrap());
    }

    #[test]
    fn cache_keeps_a_photo_a_day_and_none_six_hours() {
        let c = db();
        let now = 1_000_000_000_000;
        store(&c, "a", Some(&("image/jpeg".into(), vec![1, 2, 3])), now).unwrap();
        store(&c, "b", None, now).unwrap();
        assert!(matches!(
            cached(&c, "a", now + 3_600_000).unwrap(),
            Some(Some(_))
        ));
        assert!(cached(&c, "a", now + TTL_PHOTO_MS + 1).unwrap().is_none());
        assert!(matches!(
            cached(&c, "b", now + 3_600_000).unwrap(),
            Some(None)
        ));
        assert!(cached(&c, "b", now + TTL_NONE_MS + 1).unwrap().is_none());
        assert!(cached(&c, "c", now).unwrap().is_none());
    }

    #[test]
    fn a_picture_is_known_by_its_bytes_not_its_name() {
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff(b"\x89PNG\r\n"), Some("image/png"));
        assert_eq!(sniff(b"<svg xmlns"), None);
        assert_eq!(sniff(b"<html>"), None);
        assert!(ok(json!({"ok": false, "error_code": 429})).is_err());
        assert!(ok(json!({"ok": true, "result": {}})).is_ok());
    }

    #[test]
    fn picks_the_smallest_size_that_is_wide_enough() {
        let sizes = vec![
            json!({"file_id":"s","width":160,"height":160}),
            json!({"file_id":"m","width":320,"height":320}),
            json!({"file_id":"xs","width":80,"height":80}),
        ];
        assert_eq!(pick_size(&sizes).as_deref(), Some("s"));
        let small = vec![
            json!({"file_id":"xs","width":80}),
            json!({"file_id":"t","width":40}),
        ];
        assert_eq!(pick_size(&small).as_deref(), Some("xs"));
        assert_eq!(pick_size(&[]), None);
    }
}
