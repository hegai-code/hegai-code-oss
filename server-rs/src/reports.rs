//! Отчёты — HTML-страницы, которые сессия публикует на хабе и которые потом
//! открываются по ссылке `/w/reports/<id>` (04.10.2026, by request: «отчётом на
//! платформе code.acme.test, сохрани его там, чтобы по ссылке можно было
//! открыть, плюс раздел отчёты на вебе»).
//!
//! What this is careful about:
//! - **Who may look.** The author and the platform admins — nobody else, and
//!   everyone else gets the same 404 as «no such report». SSO admits the whole
//!   a.test community (~2000 people) to this origin, and the first report is an
//!   infrastructure audit with every server's address in it.
//! - **The page never runs as code.acme.test.** `/content` is served with a CSP
//!   `sandbox` WITHOUT `allow-same-origin`, so its scripts live in an opaque
//!   origin: no session cookie, no `/api`, no `/ui`. `connect-src 'none'` and an
//!   image policy of `data:`/`blob:` keep it from phoning anywhere; popups it
//!   opens inherit the sandbox (no `allow-popups-to-escape-sandbox`), and it
//!   cannot start downloads. A browser NAVIGATING to `/content` (not framing
//!   it) is sent to `/w/reports/<id>`, so a report is always seen inside the
//!   app's frame, under its title — never as a bare page on the hub's URL that
//!   could pass for a sign-in screen.
//! - **Who may write.** A signed-in active user (same-origin), or a fleet key
//!   (`fleet_api.rs`) acting as its machine's owner — that is how a session on
//!   `stage` publishes with `hegai-fleet report publish`. A key is never admin:
//!   it reads and writes its owner's reports only. Sandboxes are refused by the
//!   key's own check. Only the author edits; author or admin deletes.
//! - **Size.** The caller is checked BEFORE the body is read, and the body
//!   parses straight into a typed struct. One report ≤ `MAX_REPORT_BYTES`, which
//!   is what the hub may buffer per request. There is deliberately no cap on how
//!   many reports a person keeps, their total size or the write rate (Owner,
//!   05.11.2026: the 200-report cap stopped a publish). The HTML sits in SQLite
//!   next to its metadata: one row, one transaction, and account erasure takes
//!   it with the user (`ON DELETE CASCADE`).

use super::*;
use rusqlite::{params, Connection, OptionalExtension};

pub(crate) const MAX_REPORT_BYTES: usize = 100 * 1024 * 1024;
/// The body is read only AFTER the caller is known, and parsed straight into
/// `ReportBody` (never a `Value` tree), so this is a ceiling on what one
/// signed-in writer may make the hub buffer. JSON escaping of ordinary HTML
/// (quotes, newlines) stays well under 2×.
pub(crate) const MAX_BODY_BYTES: usize = 2 * MAX_REPORT_BYTES + 64 * 1024;
const MAX_TITLE_CHARS: usize = 200;
const MAX_DESCRIPTION_CHARS: usize = 1000;

/// The policy the page itself runs under. `sandbox allow-scripts` without
/// `allow-same-origin` is the load-bearing part; the rest lets a typical
/// self-contained report page (inline CSS/JS, Google Fonts, a charting
/// library from a CDN) render.
pub(crate) const REPORT_CSP: &str = "sandbox allow-scripts allow-popups; \
default-src 'none'; \
script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com; \
style-src 'unsafe-inline' https://fonts.googleapis.com; \
font-src https://fonts.gstatic.com data:; \
img-src data: blob:; \
media-src data: blob:; \
connect-src 'none'; \
base-uri 'none'; \
form-action 'none'; \
frame-ancestors 'self'";

pub(crate) fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS reports (
          report_id     TEXT PRIMARY KEY,
          owner_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
          title         TEXT NOT NULL,
          description   TEXT NOT NULL DEFAULT '',
          html          BLOB NOT NULL,
          size_bytes    INTEGER NOT NULL,
          source        TEXT NOT NULL DEFAULT '',
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS reports_owner ON reports(owner_user_id, updated_at);
        "#,
    )
    .map_err(|e| e.to_string())?;
    // Folders (one per project) and the sync ref arrived later: add them to
    // databases created before, idempotently.
    let mut have = Vec::new();
    {
        let mut stmt = conn
            .prepare("PRAGMA table_info(reports)")
            .map_err(|e| e.to_string())?;
        let names = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .map_err(|e| e.to_string())?;
        for n in names {
            have.push(n.map_err(|e| e.to_string())?);
        }
    }
    for col in ["folder", "sync_ref"] {
        if !have.iter().any(|h| h == col) {
            conn.execute(
                &format!("ALTER TABLE reports ADD COLUMN {col} TEXT NOT NULL DEFAULT ''"),
                [],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS reports_folder ON reports(owner_user_id, folder);",
    )
    .map_err(|e| e.to_string())
}

/// What a write asks for, already validated.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ReportInput {
    pub title: String,
    /// `None` = the request left it out: an update keeps the stored one.
    pub description: Option<String>,
    pub html: String,
    /// `None` = left out: create stores `''` (Hegai Code), update keeps it.
    pub folder: Option<String>,
    /// `None` = left out: create stores `''`, update keeps it.
    pub sync_ref: Option<String>,
}

/// Why a store call refused — mapped to a status by the handlers.
#[derive(Debug, PartialEq)]
pub(crate) enum ReportError {
    NotFound,
    Forbidden,
    Db(String),
}

impl From<rusqlite::Error> for ReportError {
    fn from(e: rusqlite::Error) -> Self {
        ReportError::Db(crate::workspace::db_err(e))
    }
}

fn meta_json(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let mut m = json!({
        "id": row.get::<_, String>(0)?,
        "title": row.get::<_, String>(1)?,
        "description": row.get::<_, String>(2)?,
        "sizeBytes": row.get::<_, i64>(3)?,
        "createdAt": row.get::<_, i64>(4)?,
        "updatedAt": row.get::<_, i64>(5)?,
        "ownerUserId": row.get::<_, String>(6)?,
        "ownerName": row.get::<_, Option<String>>(7)?.unwrap_or_default(),
        "ownerEmail": row.get::<_, Option<String>>(8)?.unwrap_or_default(),
        "folder": row.get::<_, String>(9)?,
    });
    // Optional fields are absent, never null.
    let sync_ref = row.get::<_, String>(10)?;
    if !sync_ref.is_empty() {
        m["syncRef"] = Value::String(sync_ref);
    }
    Ok(m)
}

const META_SELECT: &str =
    "SELECT r.report_id, r.title, r.description, r.size_bytes, r.created_at, \
     r.updated_at, r.owner_user_id, u.full_name, u.email, r.folder, r.sync_ref \
     FROM reports r LEFT JOIN users u ON u.user_id = r.owner_user_id";

/// Reports `viewer` may see, newest first: their own, or all of them for an admin.
pub(crate) fn list(
    conn: &Connection,
    viewer: &str,
    admin: bool,
) -> Result<Vec<Value>, ReportError> {
    let sql = format!(
        "{META_SELECT} WHERE ?1 OR r.owner_user_id = ?2 ORDER BY r.updated_at DESC, r.report_id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![admin, viewer], meta_json)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// The owner of a report, if it exists AND the viewer may see it. Anything else
/// is `NotFound` — the endpoint does not answer «exists, but not yours».
fn visible_owner(
    conn: &Connection,
    id: &str,
    viewer: &str,
    admin: bool,
) -> Result<String, ReportError> {
    let owner: Option<String> = conn
        .query_row(
            "SELECT owner_user_id FROM reports WHERE report_id = ?1",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    match owner {
        Some(owner) if admin || owner == viewer => Ok(owner),
        _ => Err(ReportError::NotFound),
    }
}

pub(crate) fn meta(
    conn: &Connection,
    id: &str,
    viewer: &str,
    admin: bool,
) -> Result<Value, ReportError> {
    visible_owner(conn, id, viewer, admin)?;
    let sql = format!("{META_SELECT} WHERE r.report_id = ?1");
    Ok(conn.query_row(&sql, [id], meta_json)?)
}

/// The page and its owner (so a read by an admin who is not the author can be
/// audited).
pub(crate) fn content(
    conn: &Connection,
    id: &str,
    viewer: &str,
    admin: bool,
) -> Result<(String, Vec<u8>), ReportError> {
    let owner = visible_owner(conn, id, viewer, admin)?;
    let html = conn.query_row("SELECT html FROM reports WHERE report_id = ?1", [id], |r| {
        r.get::<_, Vec<u8>>(0)
    })?;
    Ok((owner, html))
}

pub(crate) fn create(
    conn: &Connection,
    owner: &str,
    input: &ReportInput,
    source: &str,
    now: i64,
) -> Result<Value, ReportError> {
    let id = Uuid::new_v4().simple().to_string();
    conn.execute(
        "INSERT INTO reports(report_id, owner_user_id, title, description, html, size_bytes, source, created_at, updated_at, folder, sync_ref) \
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, ?10)",
        params![
            id,
            owner,
            input.title,
            input.description.as_deref().unwrap_or_default(),
            input.html.as_bytes(),
            input.html.len() as i64,
            source,
            now,
            input.folder.as_deref().unwrap_or_default(),
            input.sync_ref.as_deref().unwrap_or_default()
        ],
    )?;
    meta(conn, &id, owner, false)
}

/// Replace a report in place — the link stays the same. Author only: an admin
/// may read and delete anyone's report, but not put words in it.
pub(crate) fn update(
    conn: &Connection,
    id: &str,
    actor: &str,
    admin: bool,
    input: &ReportInput,
    source: &str,
    now: i64,
) -> Result<Value, ReportError> {
    let owner = visible_owner(conn, id, actor, admin)?;
    if owner != actor {
        return Err(ReportError::Forbidden);
    }
    conn.execute(
        "UPDATE reports SET title = ?2, description = COALESCE(?3, description), html = ?4, \
         size_bytes = ?5, source = ?6, updated_at = ?7, \
         folder = COALESCE(?8, folder), sync_ref = COALESCE(?9, sync_ref) WHERE report_id = ?1",
        params![
            id,
            input.title,
            input.description,
            input.html.as_bytes(),
            input.html.len() as i64,
            source,
            now,
            input.folder,
            input.sync_ref
        ],
    )?;
    meta(conn, id, actor, admin)
}

/// Move a report to another folder (`''` = Hegai Code). Author or admin; the
/// page and `updated_at` are left alone. Returns the old folder and the meta.
pub(crate) fn move_to(
    conn: &Connection,
    id: &str,
    actor: &str,
    admin: bool,
    folder: &str,
) -> Result<(String, Value), ReportError> {
    visible_owner(conn, id, actor, admin)?;
    let from: String = conn.query_row(
        "SELECT folder FROM reports WHERE report_id = ?1",
        [id],
        |r| r.get(0),
    )?;
    conn.execute(
        "UPDATE reports SET folder = ?2 WHERE report_id = ?1",
        params![id, folder],
    )?;
    Ok((from, meta(conn, id, actor, admin)?))
}

/// A folder name: empty (Hegai Code) or a lowercase slug.
pub(crate) fn valid_folder(f: &str) -> bool {
    if f.is_empty() {
        return true;
    }
    let b = f.as_bytes();
    b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(c))
}

fn valid_sync_ref(r: &str) -> bool {
    r.chars().count() <= 200
        && r.chars()
            .all(|c| c.is_ascii_alphanumeric() || ":._/-".contains(c))
}

pub(crate) fn delete(
    conn: &Connection,
    id: &str,
    actor: &str,
    admin: bool,
) -> Result<String, ReportError> {
    let owner = visible_owner(conn, id, actor, admin)?;
    conn.execute("DELETE FROM reports WHERE report_id = ?1", [id])?;
    Ok(owner)
}

/// The wire shape of a write. Typed, so a hostile body (a 20 MB array of
/// zeros) fails at its first token instead of becoming a `Value` tree; unknown
/// keys refused so a typo (`descripton`) is an error, not an empty field.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReportBody {
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: Option<String>,
    html: Option<String>,
    #[serde(default)]
    folder: Option<String>,
    #[serde(default, rename = "syncRef")]
    sync_ref: Option<String>,
}

/// `PATCH /api/reports/{id}`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MoveBody {
    folder: String,
}

/// Title, description and HTML out of a request body.
pub(crate) fn parse_input(bytes: &[u8]) -> Result<ReportInput, String> {
    let body: ReportBody =
        serde_json::from_slice(bytes).map_err(|e| format!("invalid report body: {e}"))?;
    let title = body.title.trim().to_string();
    let description = body.description.map(|d| d.trim().to_string());
    let Some(html) = body.html else {
        return Err("html is required".into());
    };
    // Titles and descriptions are printed by `hegai-fleet report list` into
    // terminals and agent transcripts: no escape sequences there.
    if title.chars().any(char::is_control)
        || description
            .as_deref()
            .is_some_and(|d| d.chars().any(|c| c.is_control() && c != '\n'))
    {
        return Err("title and description may not contain control characters".into());
    }
    if body.folder.as_deref().is_some_and(|f| !valid_folder(f)) {
        return Err("folder must be empty or match ^[a-z0-9][a-z0-9._-]{0,63}$".into());
    }
    if body.sync_ref.as_deref().is_some_and(|r| !valid_sync_ref(r)) {
        return Err("syncRef must be at most 200 characters of [A-Za-z0-9:._/-]".into());
    }
    if title.is_empty() {
        return Err("title is required".into());
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(format!(
            "title is too long (max {MAX_TITLE_CHARS} characters)"
        ));
    }
    if description
        .as_deref()
        .is_some_and(|d| d.chars().count() > MAX_DESCRIPTION_CHARS)
    {
        return Err(format!(
            "description is too long (max {MAX_DESCRIPTION_CHARS} characters)"
        ));
    }
    if html.trim().is_empty() {
        return Err("html is empty".into());
    }
    if html.len() > MAX_REPORT_BYTES {
        return Err(format!(
            "report is too large (max {} MB)",
            MAX_REPORT_BYTES / (1024 * 1024)
        ));
    }
    Ok(ReportInput {
        title,
        description,
        html,
        folder: body.folder,
        sync_ref: body.sync_ref,
    })
}

// ---------------------------------------------------------------- HTTP

/// Who is asking, and with what authority.
struct ReportCaller {
    user_id: String,
    admin: bool,
    /// `web` for a browser session, the machine id for a fleet key.
    source: String,
}

fn is_admin(st: &AppState, user: &str) -> bool {
    st.platform_admins.contains(user) || st.bootstrap_user_id == user
}

/// A fleet key if the bearer IS one (checked by digest, before the session
/// lookup, so a key never reads as «invalid session»); otherwise a signed-in
/// user — same-origin when the call writes. Both must be active.
fn caller(st: &AppState, headers: &HeaderMap, writes: bool) -> Result<ReportCaller, Response> {
    let is_fleet_key = match (st.fleet_api_keys.as_ref(), bearer_token(headers)) {
        (Some(keys), Some(token)) => keys.contains_key(&crate::workspace::hash_token(&token)),
        _ => false,
    };
    if is_fleet_key {
        let fleet = crate::fleet_api::fleet_caller(st, headers)?;
        // Never admin through a key: it acts as its machine's owner on that
        // owner's OWN reports. A session on `stage` (or the dispatcher that
        // works on other people's tasks) must not read the community's.
        return Ok(ReportCaller {
            admin: false,
            user_id: fleet.owner_user_id,
            source: fleet.machine_id,
        });
    }
    let user = if writes {
        mutation_user(headers, st)?
    } else {
        authenticated_user(headers, st)?
    };
    require_active(st, &user)?;
    Ok(ReportCaller {
        admin: is_admin(st, &user),
        user_id: user,
        source: "web".into(),
    })
}

/// Auth, then the body — in that order, so an anonymous caller never makes the
/// hub buffer or parse anything.
async fn write_input(st: &AppState, req: Request) -> Result<(ReportCaller, ReportInput), Response> {
    let c = caller(st, req.headers(), true)?;
    let bytes = axum::body::to_bytes(req.into_body(), MAX_BODY_BYTES)
        .await
        .map_err(|_| {
            api_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                format!(
                    "report is too large (max {} MB)",
                    MAX_REPORT_BYTES / (1024 * 1024)
                ),
            )
        })?;
    let input = parse_input(&bytes).map_err(|e| refusal(StatusCode::BAD_REQUEST, e))?;
    Ok((c, input))
}

#[track_caller]
fn store_error(e: ReportError) -> Response {
    match e {
        ReportError::NotFound => api_error(StatusCode::NOT_FOUND, "report not found"),
        ReportError::Forbidden => {
            api_error(StatusCode::FORBIDDEN, "only the author may edit a report")
        }
        ReportError::Db(e) => store_failure(e),
    }
}

fn with_db<T>(
    st: &AppState,
    f: impl FnOnce(&Connection) -> Result<T, ReportError>,
) -> Result<T, Response> {
    let Ok(conn) = st.workspaces.conn.lock() else {
        return Err(api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "workspace database lock poisoned",
        ));
    };
    f(&conn).map_err(store_error)
}

fn link(st: &AppState, id: &str) -> String {
    format!("{}/w/reports/{id}", st.public_url.trim_end_matches('/'))
}

fn with_link(st: &AppState, mut meta: Value) -> Value {
    if let Some(id) = meta["id"].as_str().map(str::to_string) {
        meta["url"] = Value::String(link(st, &id));
    }
    meta
}

/// The audit row lands in the actor's own (first) workspace, like the board's.
fn audit(st: &AppState, actor: &str, action: &str, id: &str, meta: Value) {
    let workspace = match st.workspaces.ui_access(actor, None, is_admin(st, actor)) {
        Ok(access) => access.workspace_id,
        Err(e) => {
            eprintln!("[reports] audit skipped: {e}");
            return;
        }
    };
    if let Err(e) = st
        .workspaces
        .audit(&workspace, actor, action, "report", id, &meta)
    {
        eprintln!("[reports] audit write failed: {e}");
    }
}

pub(crate) async fn api_reports(State(st): State<AppState>, headers: HeaderMap) -> Response {
    let c = match caller(&st, &headers, false) {
        Ok(c) => c,
        Err(e) => return e,
    };
    match with_db(&st, |conn| list(conn, &c.user_id, c.admin)) {
        Ok(items) => {
            let items: Vec<Value> = items.into_iter().map(|m| with_link(&st, m)).collect();
            Json(json!({ "reports": items, "admin": c.admin })).into_response()
        }
        Err(e) => e,
    }
}

pub(crate) async fn api_report_meta(
    AxumPath(id): AxumPath<String>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let c = match caller(&st, &headers, false) {
        Ok(c) => c,
        Err(e) => return e,
    };
    match with_db(&st, |conn| meta(conn, &id, &c.user_id, c.admin)) {
        Ok(m) => Json(with_link(&st, m)).into_response(),
        Err(e) => e,
    }
}

/// A browser asking for `/content` as a top-level page (typed URL, a link, a
/// «open in new tab») rather than as the viewer's frame.
fn navigated_to(headers: &HeaderMap) -> bool {
    headers
        .get("sec-fetch-dest")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v == "document")
}

pub(crate) async fn api_report_content(
    AxumPath(id): AxumPath<String>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    if navigated_to(&headers) {
        // Ids are generated hex; anything else has no page to go to.
        let target = if id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()) {
            format!("/w/reports/{id}")
        } else {
            "/w/reports".to_string()
        };
        return axum::response::Redirect::to(&target).into_response();
    }
    let c = match caller(&st, &headers, false) {
        Ok(c) => c,
        Err(e) => return e,
    };
    match with_db(&st, |conn| content(conn, &id, &c.user_id, c.admin)) {
        Ok((owner, html)) => {
            if owner != c.user_id {
                audit(
                    &st,
                    &c.user_id,
                    "report.read",
                    &id,
                    json!({ "owner": owner }),
                );
            }
            (
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                    (header::CACHE_CONTROL, "private, no-cache"),
                    (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
                    (header::REFERRER_POLICY, "no-referrer"),
                    (header::CONTENT_SECURITY_POLICY, REPORT_CSP),
                ],
                html,
            )
                .into_response()
        }
        Err(e) => e,
    }
}

pub(crate) async fn api_report_create(State(st): State<AppState>, req: Request) -> Response {
    let (c, input) = match write_input(&st, req).await {
        Ok(v) => v,
        Err(e) => return e,
    };
    match with_db(&st, |conn| {
        create(conn, &c.user_id, &input, &c.source, now_ms())
    }) {
        Ok(m) => {
            let id = m["id"].as_str().unwrap_or_default().to_string();
            audit(
                &st,
                &c.user_id,
                "report.create",
                &id,
                json!({ "title": input.title, "source": c.source }),
            );
            (StatusCode::CREATED, Json(with_link(&st, m))).into_response()
        }
        Err(e) => e,
    }
}

pub(crate) async fn api_report_update(
    AxumPath(id): AxumPath<String>,
    State(st): State<AppState>,
    req: Request,
) -> Response {
    let (c, input) = match write_input(&st, req).await {
        Ok(v) => v,
        Err(e) => return e,
    };
    match with_db(&st, |conn| {
        update(conn, &id, &c.user_id, c.admin, &input, &c.source, now_ms())
    }) {
        Ok(m) => {
            audit(
                &st,
                &c.user_id,
                "report.update",
                &id,
                json!({ "title": input.title, "source": c.source }),
            );
            Json(with_link(&st, m)).into_response()
        }
        Err(e) => e,
    }
}

const MAX_MOVE_BODY_BYTES: usize = 1024;

pub(crate) async fn api_report_move(
    AxumPath(id): AxumPath<String>,
    State(st): State<AppState>,
    req: Request,
) -> Response {
    let c = match caller(&st, req.headers(), true) {
        Ok(c) => c,
        Err(e) => return e,
    };
    let bytes = match axum::body::to_bytes(req.into_body(), MAX_MOVE_BODY_BYTES).await {
        Ok(b) => b,
        Err(_) => return api_error(StatusCode::PAYLOAD_TOO_LARGE, "body too large"),
    };
    let body: MoveBody = match serde_json::from_slice(&bytes) {
        Ok(b) => b,
        Err(e) => return api_error(StatusCode::BAD_REQUEST, format!("invalid body: {e}")),
    };
    if !valid_folder(&body.folder) {
        return api_error(
            StatusCode::BAD_REQUEST,
            "folder must be empty or match ^[a-z0-9][a-z0-9._-]{0,63}$",
        );
    }
    match with_db(&st, |conn| {
        move_to(conn, &id, &c.user_id, c.admin, &body.folder)
    }) {
        Ok((from, m)) => {
            audit(
                &st,
                &c.user_id,
                "report.move",
                &id,
                json!({ "from": from, "to": body.folder }),
            );
            Json(with_link(&st, m)).into_response()
        }
        Err(e) => e,
    }
}

pub(crate) async fn api_report_delete(
    AxumPath(id): AxumPath<String>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let c = match caller(&st, &headers, true) {
        Ok(c) => c,
        Err(e) => return e,
    };
    match with_db(&st, |conn| delete(conn, &id, &c.user_id, c.admin)) {
        Ok(owner) => {
            audit(
                &st,
                &c.user_id,
                "report.delete",
                &id,
                json!({ "owner": owner, "source": c.source }),
            );
            // A body, not 204: JSON clients (hegai-fleet) parse every answer.
            Json(json!({ "ok": true, "id": id })).into_response()
        }
        Err(e) => e,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE users(user_id TEXT PRIMARY KEY, email TEXT, full_name TEXT, created_at INTEGER);
             INSERT INTO users VALUES('alice','a@x','Alice',0),('bob','b@x','Bob',0);",
        )
        .unwrap();
        init_schema(&c).unwrap();
        c
    }

    fn input(title: &str) -> ReportInput {
        ReportInput {
            title: title.into(),
            description: Some("d".into()),
            html: "<!doctype html><p>hi</p>".into(),
            folder: None,
            sync_ref: None,
        }
    }

    fn body(v: Value) -> Vec<u8> {
        serde_json::to_vec(&v).unwrap()
    }

    #[test]
    fn only_author_and_admin_see_a_report() {
        let c = db();
        let m = create(&c, "alice", &input("Audit"), "web", 1).unwrap();
        let id = m["id"].as_str().unwrap();
        assert_eq!(m["ownerName"], "Alice");
        assert!(meta(&c, id, "alice", false).is_ok());
        assert_eq!(meta(&c, id, "bob", false), Err(ReportError::NotFound));
        assert_eq!(content(&c, id, "bob", false), Err(ReportError::NotFound));
        assert_eq!(content(&c, id, "bob", true).unwrap().0, "alice");
        assert_eq!(list(&c, "bob", false).unwrap().len(), 0);
        assert_eq!(list(&c, "bob", true).unwrap().len(), 1);
        assert_eq!(list(&c, "alice", false).unwrap().len(), 1);
    }

    #[test]
    fn update_keeps_the_id_and_is_author_only() {
        let c = db();
        let id = create(&c, "alice", &input("v1"), "web", 1).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        let v2 = ReportInput {
            html: "<p>v2</p>".into(),
            description: None,
            ..input("v2")
        };
        let m = update(&c, &id, "alice", false, &v2, "stage", 2).unwrap();
        assert_eq!(m["id"], id.as_str());
        assert_eq!(m["title"], "v2");
        // Left out of the update => the stored description survives.
        assert_eq!(m["description"], "d");
        assert_eq!(m["createdAt"], 1);
        assert_eq!(m["updatedAt"], 2);
        assert_eq!(content(&c, &id, "alice", false).unwrap().1, b"<p>v2</p>");
        // An admin sees it but may not rewrite it; a stranger does not see it.
        assert_eq!(
            update(&c, &id, "bob", true, &v2, "web", 3),
            Err(ReportError::Forbidden)
        );
        assert_eq!(
            update(&c, &id, "bob", false, &v2, "web", 3),
            Err(ReportError::NotFound)
        );
    }

    #[test]
    fn delete_is_author_or_admin_and_cascades_with_the_user() {
        let c = db();
        let id = create(&c, "alice", &input("x"), "web", 1).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(delete(&c, &id, "bob", false), Err(ReportError::NotFound));
        assert_eq!(delete(&c, &id, "bob", true).unwrap(), "alice");
        create(&c, "alice", &input("y"), "web", 1).unwrap();
        c.execute("DELETE FROM users WHERE user_id='alice'", [])
            .unwrap();
        let left: i64 = c
            .query_row("SELECT COUNT(*) FROM reports", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn parse_input_validates() {
        let ok = parse_input(&body(json!({"title":"T","html":"<p>x</p>"}))).unwrap();
        assert_eq!(ok.description, None);
        assert!(parse_input(&body(json!({"html":"<p>x</p>"}))).is_err());
        assert!(parse_input(&body(json!({"title":"T"}))).is_err());
        assert!(parse_input(&body(json!({"title":"T","html":"  "}))).is_err());
        assert!(parse_input(&body(json!({"title":"T","html":"x","descripton":"typo"}))).is_err());
        assert!(parse_input(&body(json!([0, 0, 0]))).is_err());
        assert!(parse_input(&body(json!({"title":"T\u{1b}]8;;x","html":"x"}))).is_err());
        assert!(parse_input(&body(json!({"title":"T","description":"a\nb","html":"x"}))).is_ok());
        let huge = "x".repeat(MAX_REPORT_BYTES + 1);
        assert!(parse_input(&body(json!({"title":"T","html":huge}))).is_err());
        let long_title = "т".repeat(MAX_TITLE_CHARS + 1);
        assert!(parse_input(&body(json!({"title":long_title,"html":"x"}))).is_err());
    }

    fn first_id(c: &Connection, who: &str, i: &ReportInput) -> String {
        create(c, who, i, "web", 1).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn folder_and_sync_ref_round_trip_and_survive_update() {
        let c = db();
        let plain = create(&c, "alice", &input("p"), "web", 1).unwrap();
        assert_eq!(plain["folder"], "");
        assert!(plain.get("syncRef").is_none());
        let i = ReportInput {
            folder: Some("shop-app".into()),
            sync_ref: Some("shop-app:report/12".into()),
            ..input("f")
        };
        let m = create(&c, "alice", &i, "web", 1).unwrap();
        assert_eq!(m["folder"], "shop-app");
        assert_eq!(m["syncRef"], "shop-app:report/12");
        let id = m["id"].as_str().unwrap();
        let again = ReportInput {
            html: "<p>v2</p>".into(),
            ..input("f2")
        };
        let m = update(&c, id, "alice", false, &again, "web", 2).unwrap();
        assert_eq!(m["folder"], "shop-app");
        assert_eq!(m["syncRef"], "shop-app:report/12");
        let to_root = ReportInput {
            folder: Some(String::new()),
            ..again
        };
        let m = update(&c, id, "alice", false, &to_root, "web", 3).unwrap();
        assert_eq!(m["folder"], "");
    }

    #[test]
    fn folder_and_sync_ref_are_validated() {
        let ok = |f: Value| parse_input(&body(json!({"title":"T","html":"x","folder":f})));
        assert!(ok(json!("")).is_ok());
        assert!(ok(json!("hegai.media")).is_ok());
        assert!(ok(json!("0-x_y")).is_ok());
        assert!(ok(json!("Upper")).is_err());
        assert!(ok(json!("-lead")).is_err());
        assert!(ok(json!("a b")).is_err());
        assert!(ok(json!("a/b")).is_err());
        assert!(ok(json!("a".repeat(65))).is_err());
        assert!(ok(json!("a".repeat(64))).is_ok());
        let sr = |r: Value| parse_input(&body(json!({"title":"T","html":"x","syncRef":r})));
        assert!(sr(json!("p:a/b_c-1.2")).is_ok());
        assert!(sr(json!("a b")).is_err());
        assert!(sr(json!("я")).is_err());
        assert!(sr(json!("a".repeat(201))).is_err());
    }

    #[test]
    fn move_by_author_and_admin_but_not_a_stranger() {
        let c = db();
        let id = first_id(&c, "alice", &input("x"));
        let (from, m) = move_to(&c, &id, "alice", false, "chatapp").unwrap();
        assert_eq!((from.as_str(), m["folder"].as_str()), ("", Some("chatapp")));
        let (from, m) = move_to(&c, &id, "bob", true, "hegai.media").unwrap();
        assert_eq!(from, "chatapp");
        assert_eq!(m["folder"], "hegai.media");
        assert_eq!(
            move_to(&c, &id, "bob", false, "x").map(|_| ()),
            Err(ReportError::NotFound)
        );
        assert_eq!(
            meta(&c, &id, "alice", false).unwrap()["folder"],
            "hegai.media"
        );
    }

    #[test]
    fn schema_migrates_an_old_table() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE users(user_id TEXT PRIMARY KEY, email TEXT, full_name TEXT, created_at INTEGER);
             INSERT INTO users VALUES('alice','a@x','Alice',0);
             CREATE TABLE reports (
               report_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, title TEXT NOT NULL,
               description TEXT NOT NULL DEFAULT '', html BLOB NOT NULL, size_bytes INTEGER NOT NULL,
               source TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             INSERT INTO reports VALUES('old','alice','t','',x'00',1,'',0,0);",
        )
        .unwrap();
        init_schema(&c).unwrap();
        init_schema(&c).unwrap();
        let m = meta(&c, "old", "alice", false).unwrap();
        assert_eq!(m["folder"], "");
        assert!(m.get("syncRef").is_none());
    }

    #[test]
    fn csp_sandboxes_without_same_origin_or_escape() {
        assert!(REPORT_CSP.starts_with("sandbox "));
        assert!(!REPORT_CSP.contains("allow-same-origin"));
        assert!(!REPORT_CSP.contains("escape-sandbox"));
        assert!(!REPORT_CSP.contains("allow-downloads"));
        assert!(REPORT_CSP.contains("connect-src 'none'"));
    }

    #[test]
    fn top_level_navigation_is_detected() {
        let mut h = HeaderMap::new();
        assert!(!navigated_to(&h));
        h.insert("sec-fetch-dest", "iframe".parse().unwrap());
        assert!(!navigated_to(&h));
        h.insert("sec-fetch-dest", "document".parse().unwrap());
        assert!(navigated_to(&h));
    }

    #[test]
    fn no_cap_on_how_many_reports_a_person_keeps() {
        let c = db();
        c.execute(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1500) \
             INSERT INTO reports(report_id, owner_user_id, title, html, size_bytes, created_at, updated_at) \
             SELECT 'r' || i, 'alice', 't', x'00', 1024 * 1024, 0, 0 FROM n",
            [],
        )
        .unwrap();
        // Past the old 200 reports, 200 MB and the listing's 1000 rows.
        assert!(create(&c, "alice", &input("next"), "web", 1).is_ok());
        assert_eq!(list(&c, "alice", false).unwrap().len(), 1501);
    }
}
