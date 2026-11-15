//! The registration form a newcomer fills while they wait for access
//! (`POST /api/access/registration`): who they are and what they want Hegai
//! Code for, so the admin who opens access understands whom they are letting
//! in. One row per account, replaced on every submit. Answers are free text
//! for a human to read — they decide nothing by themselves.
use super::*;
use rusqlite::{params, Connection, OptionalExtension};

use crate::workspace::db_err;

const ROLE_MAX: usize = 100;
const PURPOSE_MAX: usize = 1000;
const COMPANY_MAX: usize = 100;
const SOURCE_MAX: usize = 100;
/// Submits per account per hour: a form is filled once, edited a few times.
const SUBMITS_PER_HOUR: usize = 20;

pub(crate) fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS access_registration (
          user_id    TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
          role       TEXT NOT NULL,
          purpose    TEXT NOT NULL,
          company    TEXT,
          telegram   TEXT,
          source     TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        "#,
    )
    .map_err(db_err)
}

/// A validated submission; `telegram` is already the `@handle` form.
#[derive(Debug, PartialEq)]
pub(crate) struct Registration {
    pub role: String,
    pub purpose: String,
    pub company: Option<String>,
    pub telegram: Option<String>,
    pub source: Option<String>,
}

/// `@handle` for a Telegram username (5–32 on Telegram's side, 4 allowed
/// here), or `None` for an empty input; `Err` for anything else.
fn normalize_telegram(raw: &str) -> Result<Option<String>, &'static str> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let handle = raw.strip_prefix('@').unwrap_or(raw);
    let ok = (4..=32).contains(&handle.len())
        && handle
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !ok {
        return Err("Telegram: от 4 до 32 символов — латиница, цифры и «_».");
    }
    Ok(Some(format!("@{handle}")))
}

fn text(body: &Value, key: &str) -> String {
    body.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string()
}

fn optional(
    body: &Value,
    key: &str,
    max: usize,
    what: &'static str,
) -> Result<Option<String>, String> {
    let value = text(body, key);
    if value.chars().count() > max {
        return Err(format!("{what}: не длиннее {max} символов."));
    }
    Ok((!value.is_empty()).then_some(value))
}

/// Validate the form. The `Err` is the sentence the person reads.
pub(crate) fn parse(body: &Value) -> Result<Registration, String> {
    let role = text(body, "role");
    if role.is_empty() {
        return Err("Расскажи, кто ты и чем занимаешься.".into());
    }
    if role.chars().count() > ROLE_MAX {
        return Err(format!("Кто ты: не длиннее {ROLE_MAX} символов."));
    }
    let purpose = text(body, "purpose");
    if purpose.is_empty() {
        return Err("Напиши, зачем тебе Hegai Code.".into());
    }
    if purpose.chars().count() > PURPOSE_MAX {
        return Err(format!(
            "Зачем тебе Hegai Code: не длиннее {PURPOSE_MAX} символов."
        ));
    }
    Ok(Registration {
        role,
        purpose,
        company: optional(body, "company", COMPANY_MAX, "Компания")?,
        telegram: normalize_telegram(&text(body, "telegram"))?,
        source: optional(body, "source", SOURCE_MAX, "Откуда узнал")?,
    })
}

impl WorkspaceStore {
    /// Store (or replace) the answers; `created_at` stays from the first one.
    pub fn save_registration(&self, user_id: &str, r: &Registration) -> Result<(), String> {
        let now = workspace::now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.execute(
            "INSERT INTO access_registration(user_id,role,purpose,company,telegram,source,created_at,updated_at) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?7) \
             ON CONFLICT(user_id) DO UPDATE SET role=excluded.role,purpose=excluded.purpose,\
             company=excluded.company,telegram=excluded.telegram,source=excluded.source,\
             updated_at=excluded.updated_at",
            params![user_id, r.role, r.purpose, r.company, r.telegram, r.source, now],
        )
        .map_err(db_err)?;
        Ok(())
    }

    /// Has this account filled the form in? The external edition asks nobody
    /// anything: its owner knows who they invite, so it counts as done.
    pub fn is_registered(&self, user_id: &str) -> bool {
        if crate::edition::is_external() {
            return true;
        }
        let Ok(conn) = self.conn.lock() else {
            return true;
        };
        conn.query_row(
            "SELECT 1 FROM access_registration WHERE user_id=?1",
            params![user_id],
            |_| Ok(()),
        )
        .optional()
        .ok()
        .flatten()
        .is_some()
    }
}

/// `POST /api/access/registration {role, purpose, company?, telegram?, source?}`
/// — a waitlisted or active account fills (or updates) the form; a suspended
/// one is refused. Answers the current `viewer.access`, like `/request`.
pub(crate) async fn api_access_registration(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let actor = gate!(mutation_user(&headers, &st));
    let access = match st.workspaces.access_state(&actor) {
        Ok(access) => access,
        Err(error) => return store_failure(error),
    };
    if !matches!(access.state.as_str(), "waitlist" | "active") {
        return api_error(StatusCode::FORBIDDEN, "access suspended");
    }
    let registration = match parse(&body) {
        Ok(r) => r,
        Err(message) => return api_error(StatusCode::BAD_REQUEST, message),
    };
    let quota = match check_window_quota(
        &st,
        &format!("access-registration:{actor}"),
        SUBMITS_PER_HOUR,
        60 * 60 * 1000,
        "too many attempts, try later",
    ) {
        Ok(key) => key,
        Err(response) => return response,
    };
    record_window_hit(&st, &quota, 60 * 60 * 1000);
    if let Err(error) = st.workspaces.save_registration(&actor, &registration) {
        return store_failure(error);
    }
    // Admins' open tabs and the waiting screen both re-derive from this.
    st.hub.send(HubCmd::RefreshWorkspaceState);
    match st.workspaces.viewer_access_json(&access) {
        Ok(value) => Json(value).into_response(),
        Err(error) => store_failure(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn form(extra: Value) -> Value {
        let mut base = json!({"role": "Разработчик", "purpose": "Хочу поставить у себя"});
        if let (Some(b), Some(e)) = (base.as_object_mut(), extra.as_object()) {
            for (k, v) in e {
                b.insert(k.clone(), v.clone());
            }
        }
        base
    }

    #[test]
    fn role_and_purpose_are_required_and_bounded() {
        assert!(parse(&json!({"purpose": "x"})).is_err());
        assert!(parse(&json!({"role": "x"})).is_err());
        assert!(parse(&form(json!({"role": "   "}))).is_err());
        assert!(parse(&form(json!({"role": "я".repeat(ROLE_MAX)}))).is_ok());
        assert!(parse(&form(json!({"role": "я".repeat(ROLE_MAX + 1)}))).is_err());
        assert!(parse(&form(json!({"purpose": "я".repeat(PURPOSE_MAX)}))).is_ok());
        assert!(parse(&form(json!({"purpose": "я".repeat(PURPOSE_MAX + 1)}))).is_err());
        assert!(parse(&form(json!({"company": "я".repeat(COMPANY_MAX + 1)}))).is_err());
        assert!(parse(&form(json!({"source": "я".repeat(SOURCE_MAX + 1)}))).is_err());
        // Not strings: treated as empty, so a required one fails.
        assert!(parse(&json!({"role": 5, "purpose": "x"})).is_err());
    }

    #[test]
    fn the_telegram_handle_is_normalized_or_refused() {
        let got = |t: &str| parse(&form(json!({"telegram": t}))).map(|r| r.telegram);
        assert_eq!(got("").unwrap(), None);
        assert_eq!(got("  ").unwrap(), None);
        assert_eq!(got("durov").unwrap().as_deref(), Some("@durov"));
        assert_eq!(got("@Dur_ov1").unwrap().as_deref(), Some("@Dur_ov1"));
        assert!(got("abc").is_err(), "too short");
        assert!(got(&"a".repeat(33)).is_err(), "too long");
        assert!(got("@du rov").is_err());
        assert!(got("@дуров1").is_err());
        assert!(got("https://t.me/durov").is_err());
    }

    #[test]
    fn optional_answers_are_trimmed_and_empty_ones_dropped() {
        let r = parse(&form(json!({"company": "  Acme ", "source": ""}))).unwrap();
        assert_eq!(r.company.as_deref(), Some("Acme"));
        assert_eq!(r.source, None);
        assert_eq!(r.telegram, None);
    }

    #[test]
    fn saving_replaces_the_answers_and_keeps_the_first_timestamp() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("u", "u@x.test", None).unwrap();
        assert!(!s.is_registered("u"));
        s.save_registration("u", &parse(&form(json!({}))).unwrap())
            .unwrap();
        assert!(s.is_registered("u"));
        let first: i64 = {
            let c = s.conn.lock().unwrap();
            c.query_row("SELECT created_at FROM access_registration", [], |r| {
                r.get(0)
            })
            .unwrap()
        };
        s.save_registration(
            "u",
            &parse(&form(json!({"role": "Дизайнер", "telegram": "@abcd"}))).unwrap(),
        )
        .unwrap();
        let c = s.conn.lock().unwrap();
        let (n, role, tg, created): (i64, String, Option<String>, i64) = c
            .query_row(
                "SELECT COUNT(*),role,telegram,created_at FROM access_registration",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            (n, role.as_str(), tg.as_deref()),
            (1, "Дизайнер", Some("@abcd"))
        );
        assert_eq!(created, first);
    }

    #[test]
    fn the_external_edition_asks_nobody() {
        use crate::edition::{with_edition, Edition};
        let s = WorkspaceStore::open_memory();
        s.ensure_user("u", "u@x.test", None).unwrap();
        with_edition(Edition::External, || assert!(s.is_registered("u")));
    }
}
