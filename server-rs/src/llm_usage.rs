//! «Расходы» — who spends how much, from two sources that are never pooled.
//!
//! 1. **The gateway.** Every member has a Bifrost virtual key named
//!    `hegai:<email>` (`llmgw.rs`). A collector pulls Bifrost's request log
//!    incrementally and folds it into `llm_usage_daily` — one row per day, key
//!    and model with counts only. **No prompt text is stored**: Bifrost's log
//!    rows carry `raw_request` / `raw_response` (and an embedded copy of the
//!    virtual key, secret included). The wire structs below simply do not name
//!    those fields, so serde skips them while parsing and they are never held,
//!    logged or written; the parser is tested with bodies in the fixture.
//! 2. **The person's own subscription.** When an agent reports its Claude /
//!    Codex limits (`usage` / `codex_usage`), the hub keeps a compact sample
//!    per owner, account and window (`sub_limit_samples`): the latest reading
//!    and the day's peak, 90 days. A manager sees who keeps hitting a limit.
//!
//! Collection is exactly-once per log id (`llm_usage_seen`, pruned) with a
//! look-back, because Bifrost stamps a log with the request START and writes
//! it at the end: a long stream lands behind newer rows.
//!
//! Visibility (`usage_subjects`): the owner sees every member, a manager the
//! members assigned to them (plus themselves), a member only themselves.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::llmgw::{self, LlmGateway, SeatLimit};
use crate::timefmt::{iso8601_utc, parse_rfc3339_ms};
use crate::workspace::{db_err, now_ms, WorkspaceStore};

const DAY_MS: i64 = 86_400_000;
/// How far back the very first collection reaches.
const BACKFILL_DAYS: i64 = 30;
/// Re-read this much before the cursor on every run (late-written logs).
const LOOKBACK_MS: i64 = 15 * 60_000;
/// An unfinished row older than this stops holding the cursor back.
const HOLD_MAX_MS: i64 = 2 * 3_600_000;
/// Logs per request. Pages are a few hundred KB; keep them small.
const PAGE: usize = 50;
/// Pages per run: bounds a backfill so one run cannot hog the gateway.
const MAX_PAGES_PER_RUN: usize = 240;
const IDLE_SLEEP: Duration = Duration::from_secs(600);
const CATCH_UP_SLEEP: Duration = Duration::from_secs(20);
/// Daily usage rows are kept this long.
const RETENTION_DAYS: i64 = 400;
/// Subscription samples are kept this long.
const SAMPLE_RETENTION_DAYS: i64 = 90;
/// A window at or above this used-percent counts as "hit the limit" that day.
const HIT_PERCENT: f64 = 90.0;
/// Hit on this many days of the period = "часто упирается".
const FREQUENT_HIT_DAYS: i64 = 2;
/// Longest period a report may ask for.
const MAX_PERIOD_DAYS: i64 = 92;

pub(crate) fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        -- Gateway usage, counts only: one row per UTC day, key and model.
        -- `email` is '' for service keys, which stay under their own name.
        CREATE TABLE IF NOT EXISTS llm_usage_daily (
          day               TEXT NOT NULL,
          virtual_key_name  TEXT NOT NULL,
          email             TEXT NOT NULL DEFAULT '',
          model             TEXT NOT NULL,
          requests          INTEGER NOT NULL DEFAULT 0,
          errors            INTEGER NOT NULL DEFAULT 0,
          prompt_tokens     INTEGER NOT NULL DEFAULT 0,
          completion_tokens INTEGER NOT NULL DEFAULT 0,
          cached_tokens     INTEGER NOT NULL DEFAULT 0,
          -- The person the key's e-mail belonged to WHEN the row was counted:
          -- reports go by this, so an address reused later shows nothing old.
          user_id           TEXT NOT NULL DEFAULT '',
          PRIMARY KEY(day, virtual_key_name, model, user_id)
        );
        CREATE INDEX IF NOT EXISTS llm_usage_daily_email ON llm_usage_daily(email, day);
        -- Log ids already folded in (the exactly-once guard). Pruned behind the cursor.
        CREATE TABLE IF NOT EXISTS llm_usage_seen (log_id TEXT PRIMARY KEY, ts INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS llm_usage_seen_ts ON llm_usage_seen(ts);
        CREATE TABLE IF NOT EXISTS llm_usage_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
        -- The person's own Claude / Codex subscription windows, as agents report them.
        CREATE TABLE IF NOT EXISTS sub_limit_samples (
          user_id     TEXT NOT NULL,
          provider    TEXT NOT NULL CHECK(provider IN ('claude','codex')),
          account     TEXT NOT NULL DEFAULT '',
          window_key  TEXT NOT NULL,
          day         TEXT NOT NULL,
          label       TEXT NOT NULL DEFAULT '',
          percent     REAL NOT NULL,
          resets_at   INTEGER,
          sampled_at  INTEGER NOT NULL,
          max_percent REAL NOT NULL,
          -- 1 = the agent reported an EMPTY reading (switched to the gateway,
          -- logged out): the latest row no longer counts as a current limit.
          retired     INTEGER NOT NULL DEFAULT 0,
          -- The machine whose agent wrote the latest reading: an empty reading
          -- from ANOTHER machine of the same person must not retire it.
          source      TEXT NOT NULL DEFAULT '',
          PRIMARY KEY(user_id, provider, account, window_key, day)
        );
        CREATE INDEX IF NOT EXISTS sub_limit_samples_day ON sub_limit_samples(day);
        -- Erased people (sha256 of the lowercased email): a log that finishes
        -- after the erasure must not bring their usage back.
        CREATE TABLE IF NOT EXISTS llm_usage_erased (email_sha256 TEXT PRIMARY KEY, erased_at INTEGER NOT NULL DEFAULT 0);
        "#,
    )
    .map_err(db_err)?;
    // A table made before `retired` existed.
    let has_retired: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('sub_limit_samples') WHERE name='retired')",
            [],
            |r| r.get(0),
        )
        .map_err(db_err)?;
    if !has_retired {
        conn.execute(
            "ALTER TABLE sub_limit_samples ADD COLUMN retired INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(db_err)?;
    }
    let has_user: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('llm_usage_daily') WHERE name='user_id')",
            [],
            |r| r.get(0),
        )
        .map_err(db_err)?;
    if !has_user {
        conn.execute(
            "ALTER TABLE llm_usage_daily ADD COLUMN user_id TEXT NOT NULL DEFAULT ''",
            [],
        )
        .map_err(db_err)?;
    }
    conn.execute(
        "CREATE INDEX IF NOT EXISTS llm_usage_daily_user ON llm_usage_daily(user_id, day)",
        [],
    )
    .map_err(db_err)?;
    let has_source: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('sub_limit_samples') WHERE name='source')",
            [],
            |r| r.get(0),
        )
        .map_err(db_err)?;
    if !has_source {
        conn.execute(
            "ALTER TABLE sub_limit_samples ADD COLUMN source TEXT NOT NULL DEFAULT ''",
            [],
        )
        .map_err(db_err)?;
    }
    Ok(())
}

/// The account an e-mail belongs to now ('' when none, or no users table).
fn owner_of(conn: &Connection, email: &str) -> String {
    if email.is_empty() {
        return String::new();
    }
    conn.query_row(
        "SELECT user_id FROM users WHERE lower(email)=?1",
        params![email],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .unwrap_or_default()
}

/// The tombstone key of an erased person's email.
pub(crate) fn erased_key(email: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(email.trim().to_ascii_lowercase().as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

// ---------------------------------------------------------------------------
// Gateway log parsing — narrow on purpose.
// ---------------------------------------------------------------------------

/// What the collector keeps of one Bifrost log row. Deliberately no text.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct LogRow {
    pub id: String,
    pub ts_ms: i64,
    pub key_name: String,
    pub model: String,
    pub status: String,
    pub prompt: u64,
    pub completion: u64,
    pub cached: u64,
}

#[derive(Deserialize)]
struct PageWire {
    #[serde(default)]
    logs: Vec<LogWire>,
}

// NOTE: no `raw_request`, `raw_response` or `virtual_key` here. Unknown fields
// are skipped by serde without being kept.
#[derive(Deserialize)]
struct LogWire {
    id: Option<String>,
    timestamp: Option<String>,
    model: Option<String>,
    status: Option<String>,
    virtual_key_name: Option<String>,
    token_usage: Option<TokenWire>,
}

#[derive(Deserialize)]
struct TokenWire {
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
    prompt_tokens_details: Option<DetailsWire>,
}

#[derive(Deserialize)]
struct DetailsWire {
    cached_tokens: Option<u64>,
}

/// Parse one `/api/logs` page → the rows worth keeping and how many log
/// entries the page held (rows without an id or a timestamp are dropped but
/// still count toward paging).
pub(crate) fn parse_logs_page(body: &str) -> Result<(Vec<LogRow>, usize), String> {
    let page: PageWire =
        serde_json::from_str(body).map_err(|_| "gateway logs: unexpected response".to_string())?;
    let raw_len = page.logs.len();
    let rows = page
        .logs
        .into_iter()
        .filter_map(|l| {
            let id = l.id.filter(|i| !i.is_empty())?;
            let ts_ms = l.timestamp.as_deref().and_then(parse_rfc3339_ms)?;
            let tokens = l.token_usage;
            Some(LogRow {
                id,
                ts_ms,
                key_name: l.virtual_key_name.unwrap_or_default(),
                model: l
                    .model
                    .filter(|m| !m.is_empty())
                    .unwrap_or_else(|| "unknown".into()),
                status: l.status.unwrap_or_default(),
                prompt: tokens.as_ref().and_then(|t| t.prompt_tokens).unwrap_or(0),
                completion: tokens
                    .as_ref()
                    .and_then(|t| t.completion_tokens)
                    .unwrap_or(0),
                cached: tokens
                    .as_ref()
                    .and_then(|t| t.prompt_tokens_details.as_ref())
                    .and_then(|d| d.cached_tokens)
                    .unwrap_or(0),
            })
        })
        .collect();
    Ok((rows, raw_len))
}

/// `hegai:<email>` → the lowercased email. Service keys
/// (`hegai:service-*`) and anything else (`agent:*`) have none.
pub(crate) fn key_email(name: &str) -> String {
    let Some(rest) = name.strip_prefix("hegai:") else {
        return String::new();
    };
    let rest = rest.trim().to_ascii_lowercase();
    if rest.contains('@') && !rest.starts_with("service-") {
        rest
    } else {
        String::new()
    }
}

fn day_of(ms: i64) -> String {
    iso8601_utc(ms)[..10].to_string()
}

#[derive(Default, Debug, PartialEq)]
pub(crate) struct Agg {
    pub requests: i64,
    pub errors: i64,
    pub prompt: i64,
    pub completion: i64,
    pub cached: i64,
}

/// Fold rows into per-(day, key, model) sums. A row still `processing` is
/// not final and is left for a later pass (the caller does not mark it seen).
pub(crate) fn aggregate(rows: &[&LogRow]) -> HashMap<(String, String, String), Agg> {
    let mut out: HashMap<(String, String, String), Agg> = HashMap::new();
    for r in rows {
        let a = out
            .entry((day_of(r.ts_ms), r.key_name.clone(), r.model.clone()))
            .or_default();
        a.requests += 1;
        if r.status == "error" {
            a.errors += 1;
        }
        a.prompt += r.prompt as i64;
        a.completion += r.completion as i64;
        a.cached += r.cached as i64;
    }
    out
}

fn is_final(status: &str) -> bool {
    !matches!(status, "processing" | "pending" | "")
}

#[derive(Debug, Default, PartialEq)]
pub(crate) struct IngestStats {
    pub folded: usize,
    pub duplicates: usize,
}

pub(crate) fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT v FROM llm_usage_meta WHERE k=?1",
        params![key],
        |r| r.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

pub(crate) fn cursor_ms(conn: &Connection) -> Option<i64> {
    meta_get(conn, "cursor_ms").and_then(|v| v.parse().ok())
}

/// Fold a page into the tables, once per log id, in one transaction. Moves
/// the cursor to the newest final row and prunes what is behind it — but never
/// past an unfinished row (`hold`, carried across the pages of one pass): Bifrost
/// stamps a row with the request's START, so a long stream must stay inside the
/// re-read window until it finishes, or it is never counted. A row unfinished
/// for over two hours stops holding (a stuck entry must not freeze the cursor).
pub(crate) fn ingest(
    conn: &Connection,
    rows: &[LogRow],
    now: i64,
    hold: &mut Option<i64>,
) -> Result<IngestStats, String> {
    let tx = conn.unchecked_transaction().map_err(db_err)?;
    let mut stats = IngestStats::default();
    let mut fresh: Vec<&LogRow> = Vec::new();
    let prev = cursor_ms(&tx).unwrap_or(0);
    let mut newest = prev;
    for r in rows
        .iter()
        .filter(|r| !is_final(&r.status) && r.ts_ms > now - HOLD_MAX_MS)
    {
        *hold = Some(hold.map_or(r.ts_ms, |h| h.min(r.ts_ms)));
    }
    // Only requests that STARTED before the erasure: a later account with the
    // same address counts as usual.
    let erased = |key: &str, ts: i64| -> bool {
        let email = key_email(key);
        !email.is_empty()
            && tx
                .query_row(
                    "SELECT 1 FROM llm_usage_erased WHERE email_sha256=?1 AND erased_at>=?2",
                    params![erased_key(&email), ts],
                    |_| Ok(()),
                )
                .optional()
                .ok()
                .flatten()
                .is_some()
    };
    for r in rows.iter().filter(|r| is_final(&r.status)) {
        let inserted = tx
            .execute(
                "INSERT OR IGNORE INTO llm_usage_seen(log_id,ts) VALUES(?1,?2)",
                params![r.id, r.ts_ms],
            )
            .map_err(db_err)?;
        newest = newest.max(r.ts_ms);
        if inserted == 0 {
            stats.duplicates += 1;
            continue;
        }
        if erased(&r.key_name, r.ts_ms) {
            continue;
        }
        stats.folded += 1;
        fresh.push(r);
    }
    if let Some(h) = *hold {
        newest = newest.min(h + LOOKBACK_MS - 1).max(prev);
    }
    for ((day, key, model), a) in aggregate(&fresh) {
        let email = key_email(&key);
        tx.execute(
            "INSERT INTO llm_usage_daily(day,virtual_key_name,email,model,requests,errors,prompt_tokens,completion_tokens,cached_tokens,user_id)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
             ON CONFLICT(day,virtual_key_name,model,user_id) DO UPDATE SET
               requests=requests+excluded.requests, errors=errors+excluded.errors,
               prompt_tokens=prompt_tokens+excluded.prompt_tokens,
               completion_tokens=completion_tokens+excluded.completion_tokens,
               cached_tokens=cached_tokens+excluded.cached_tokens",
            params![day, key, email, model, a.requests, a.errors, a.prompt, a.completion, a.cached, owner_of(&tx, &email)],
        )
        .map_err(db_err)?;
    }
    if newest > 0 {
        tx.execute(
            "INSERT INTO llm_usage_meta(k,v) VALUES('cursor_ms',?1) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
            params![newest.to_string()],
        )
        .map_err(db_err)?;
        // Ids older than twice the look-back can no longer come back.
        tx.execute(
            "DELETE FROM llm_usage_seen WHERE ts<?1",
            params![newest - 2 * LOOKBACK_MS],
        )
        .map_err(db_err)?;
    }
    tx.execute(
        "DELETE FROM llm_usage_daily WHERE day<?1",
        params![day_of(now - RETENTION_DAYS * DAY_MS)],
    )
    .map_err(db_err)?;
    tx.commit().map_err(db_err)?;
    Ok(stats)
}

// ---------------------------------------------------------------------------
// The collector
// ---------------------------------------------------------------------------

/// One collection pass. Returns `true` when the page budget ran out with more
/// to read (a backfill in progress), so the loop comes back soon.
pub(crate) async fn collect_once(gw: &LlmGateway, ws: &WorkspaceStore) -> Result<bool, String> {
    let now = now_ms();
    let cursor = {
        let conn = ws
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        cursor_ms(&conn)
    };
    let since = match cursor {
        Some(c) => (c - LOOKBACK_MS).max(now - RETENTION_DAYS * DAY_MS),
        None => now - BACKFILL_DAYS * DAY_MS,
    };
    let start = iso8601_utc(since);
    let mut offset = 0usize;
    let mut hold = None;
    for _ in 0..MAX_PAGES_PER_RUN {
        let path = format!(
            "/api/logs?limit={PAGE}&offset={offset}&sort_by=timestamp&order=asc&start_time={start}"
        );
        let body = gw.get_text(&path).await?;
        let (rows, raw_len) = parse_logs_page(&body)?;
        drop(body);
        {
            let conn = ws
                .conn
                .lock()
                .map_err(|_| "workspace database lock poisoned".to_string())?;
            ingest(&conn, &rows, now, &mut hold)?;
        }
        if raw_len < PAGE {
            return Ok(false);
        }
        offset += raw_len;
    }
    Ok(true)
}

/// Runs for the life of the hub; only spawned when a gateway is configured.
pub(crate) async fn collector_loop(gw: Arc<LlmGateway>, ws: WorkspaceStore) {
    tokio::time::sleep(Duration::from_secs(30)).await;
    loop {
        let wait = match collect_once(&gw, &ws).await {
            Ok(true) => CATCH_UP_SLEEP,
            Ok(false) => IDLE_SLEEP,
            Err(e) => {
                println!("[llm-usage] collection failed: {e}");
                IDLE_SLEEP
            }
        };
        tokio::time::sleep(wait).await;
    }
}

// ---------------------------------------------------------------------------
// Subscription samples
// ---------------------------------------------------------------------------

/// The limit rows of an agent `UsageInfo`: `limits[]` when present, else the
/// legacy five-hour / seven-day pair. `(key, label, percent, resets_at)`.
pub(crate) fn usage_windows(usage: &Value) -> Vec<(String, String, f64, Option<i64>)> {
    let mut out = Vec::new();
    if let Some(limits) = usage.get("limits").and_then(Value::as_array) {
        for l in limits.iter().take(12) {
            let (Some(key), Some(percent)) = (
                l.get("key").and_then(Value::as_str),
                l.get("percent").and_then(Value::as_f64),
            ) else {
                continue;
            };
            let label = l.get("label").and_then(Value::as_str).unwrap_or(key);
            out.push((
                key.chars().take(60).collect(),
                label.chars().take(80).collect(),
                percent,
                l.get("resetsAt").and_then(Value::as_i64),
            ));
        }
    } else {
        for (field, key, label) in [
            ("fiveHour", "session", "Сессия (5 ч)"),
            ("sevenDay", "weekly_all", "Неделя"),
        ] {
            if let Some(w) = usage.get(field) {
                if let Some(percent) = w.get("utilization").and_then(Value::as_f64) {
                    out.push((
                        key.into(),
                        label.into(),
                        percent,
                        w.get("resetsAt").and_then(Value::as_i64),
                    ));
                }
            }
        }
    }
    out
}

/// Keep the latest reading and the day's peak of each window of `usage`.
/// `provider` is `claude` or `codex`.
pub(crate) fn record_subscription_sample(
    ws: &WorkspaceStore,
    user_id: &str,
    machine_id: &str,
    provider: &str,
    usage: &Value,
    now: i64,
) -> Result<(), String> {
    let windows = usage_windows(usage);
    if windows.is_empty() {
        // An empty reading is the agent saying «no personal limits any more»:
        // retire what we hold, so the report stops showing a stale limit. The
        // history (hit days) stays.
        let conn = ws
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.execute(
            "UPDATE sub_limit_samples SET retired=1 WHERE user_id=?1 AND provider=?2 AND source=?3 AND retired=0",
            params![user_id, provider, machine_id],
        )
        .map_err(db_err)?;
        conn.execute(
            "DELETE FROM sub_limit_samples WHERE day<?1",
            params![day_of(now - SAMPLE_RETENTION_DAYS * DAY_MS)],
        )
        .map_err(db_err)?;
        return Ok(());
    }
    let account: String = usage
        .get("account")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .chars()
        .take(120)
        .collect();
    let conn = ws
        .conn
        .lock()
        .map_err(|_| "workspace database lock poisoned".to_string())?;
    let tx = conn.unchecked_transaction().map_err(db_err)?;
    let day = day_of(now);
    for (key, label, percent, resets_at) in windows {
        tx.execute(
            "INSERT INTO sub_limit_samples(user_id,provider,account,window_key,day,label,percent,resets_at,sampled_at,max_percent,retired,source)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?7,0,?10)
             ON CONFLICT(user_id,provider,account,window_key,day) DO UPDATE SET
               label=excluded.label, percent=excluded.percent, resets_at=excluded.resets_at,
               sampled_at=excluded.sampled_at, max_percent=MAX(max_percent, excluded.percent), retired=0,
               source=excluded.source",
            params![user_id, provider, account, key, day, label, percent, resets_at, now, machine_id],
        )
        .map_err(db_err)?;
    }
    tx.execute(
        "DELETE FROM sub_limit_samples WHERE day<?1",
        params![day_of(now - SAMPLE_RETENTION_DAYS * DAY_MS)],
    )
    .map_err(db_err)?;
    tx.commit().map_err(db_err)
}

// ---------------------------------------------------------------------------
// Who may see whom
// ---------------------------------------------------------------------------

/// A person a report is about.
#[derive(Clone, Debug)]
pub(crate) struct Subject {
    pub user_id: String,
    pub email: Option<String>,
    pub full_name: Option<String>,
    pub role: String,
}

impl WorkspaceStore {
    /// The scope (`all` | `assigned` | `self`) and people `actor` may see in
    /// `workspace_id`. Owner: every member. Manager: themselves and the
    /// members assigned to them. Member: themselves.
    pub(crate) fn usage_subjects(
        &self,
        actor: &str,
        workspace_id: &str,
    ) -> Result<(&'static str, Vec<Subject>), String> {
        let role = self.require_member(actor, workspace_id)?;
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let (scope, sql) = match role.as_str() {
            "owner" => ("all", "SELECT u.user_id,u.email,u.full_name,m.role FROM memberships m JOIN users u ON u.user_id=m.user_id WHERE m.workspace_id=?1 AND ?2=?2 ORDER BY u.full_name,u.email"),
            "manager" => ("assigned", "SELECT u.user_id,u.email,u.full_name,m.role FROM memberships m JOIN users u ON u.user_id=m.user_id WHERE m.workspace_id=?1 AND (m.user_id=?2 OR EXISTS(SELECT 1 FROM manager_assignments a WHERE a.workspace_id=m.workspace_id AND a.manager_user_id=?2 AND a.target_kind='member' AND a.target_id=m.user_id)) ORDER BY u.full_name,u.email"),
            _ => ("self", "SELECT u.user_id,u.email,u.full_name,m.role FROM memberships m JOIN users u ON u.user_id=m.user_id WHERE m.workspace_id=?1 AND m.user_id=?2"),
        };
        let mut stmt = conn.prepare(sql).map_err(db_err)?;
        let rows = stmt
            .query_map(params![workspace_id, actor], |r| {
                Ok(Subject {
                    user_id: r.get(0)?,
                    email: r.get::<_, Option<String>>(1)?.filter(|e| !e.is_empty()),
                    full_name: r.get::<_, Option<String>>(2)?.filter(|e| !e.is_empty()),
                    role: r.get(3)?,
                })
            })
            .map_err(db_err)?;
        Ok((scope, rows.filter_map(Result::ok).collect()))
    }

    /// The signed-in person as a report subject, whatever workspace.
    pub(crate) fn usage_self(&self, user_id: &str) -> Result<Subject, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.query_row(
            "SELECT email,full_name FROM users WHERE user_id=?1",
            params![user_id],
            |r| {
                Ok(Subject {
                    user_id: user_id.to_string(),
                    email: r.get::<_, Option<String>>(0)?.filter(|e| !e.is_empty()),
                    full_name: r.get::<_, Option<String>>(1)?.filter(|e| !e.is_empty()),
                    role: String::new(),
                })
            },
        )
        .map_err(db_err)
    }

    pub(crate) fn usage_collected_at(&self) -> Option<i64> {
        self.conn.lock().ok().and_then(|c| cursor_ms(&c))
    }
}

// ---------------------------------------------------------------------------
// Seat limits, briefly cached
// ---------------------------------------------------------------------------

type LimitsCache = std::sync::Mutex<Option<(std::time::Instant, HashMap<String, SeatLimit>)>>;
static LIMITS_CACHE: std::sync::OnceLock<LimitsCache> = std::sync::OnceLock::new();
const LIMITS_TTL: Duration = Duration::from_secs(30);

/// Every seat's governance window, at most one gateway read per half minute
/// however many people open the page. `None` when the gateway cannot be read.
pub(crate) async fn seat_limits_cached(gw: &LlmGateway) -> Option<HashMap<String, SeatLimit>> {
    // One refresh at a time: the rest wait and then find it fresh.
    static REFRESH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let cache = LIMITS_CACHE.get_or_init(|| std::sync::Mutex::new(None));
    let fresh = || -> Option<HashMap<String, SeatLimit>> {
        let guard = cache.lock().ok()?;
        let (at, map) = guard.as_ref()?;
        (at.elapsed() < LIMITS_TTL).then(|| map.clone())
    };
    if let Some(map) = fresh() {
        return Some(map);
    }
    let _refresh = REFRESH.lock().await;
    if let Ok(guard) = cache.lock() {
        if let Some((at, map)) = guard.as_ref() {
            if at.elapsed() < LIMITS_TTL {
                return Some(map.clone());
            }
        }
    }
    let map = gw.seat_limits().await.ok()?;
    if let Ok(mut guard) = cache.lock() {
        *guard = Some((std::time::Instant::now(), map.clone()));
    }
    Some(map)
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/// Validate a `from`/`to` pair (`YYYY-MM-DD`, inclusive, UTC days). Absent
/// bounds default to the last 7 days ending today.
pub(crate) fn parse_period(
    from: Option<&str>,
    to: Option<&str>,
    now: i64,
) -> Result<(String, String), String> {
    let valid = |d: &str| d.len() == 10 && parse_rfc3339_ms(&format!("{d}T00:00:00Z")).is_some();
    let to = to.map(str::to_string).unwrap_or_else(|| day_of(now));
    let from = from
        .map(str::to_string)
        .unwrap_or_else(|| day_of(now - 6 * DAY_MS));
    if !valid(&from) || !valid(&to) {
        return Err("from/to must be YYYY-MM-DD".into());
    }
    if from > to {
        return Err("from is after to".into());
    }
    let span = (parse_rfc3339_ms(&format!("{to}T00:00:00Z")).unwrap_or(0)
        - parse_rfc3339_ms(&format!("{from}T00:00:00Z")).unwrap_or(0))
        / DAY_MS;
    if span >= MAX_PERIOD_DAYS {
        return Err(format!("period is limited to {MAX_PERIOD_DAYS} days"));
    }
    Ok((from, to))
}

fn window_rank(key: &str) -> u8 {
    match key {
        "session" => 0,
        "weekly_all" => 1,
        _ => 2,
    }
}

/// Gateway usage of one person over the period, as the `gateway` object.
fn gateway_section(
    conn: &Connection,
    user_id: &str,
    from: &str,
    to: &str,
) -> Result<Value, String> {
    let mut models: Vec<(String, i64, i64)> = Vec::new();
    let mut days: HashMap<String, (i64, i64)> = HashMap::new();
    let (mut requests, mut errors, mut prompt, mut completion, mut cached) =
        (0i64, 0i64, 0i64, 0i64, 0i64);
    if !user_id.is_empty() {
        let mut stmt = conn
            .prepare(
                "SELECT day,model,SUM(requests),SUM(errors),SUM(prompt_tokens),SUM(completion_tokens),SUM(cached_tokens)
                 FROM llm_usage_daily WHERE user_id=?1 AND day>=?2 AND day<=?3 GROUP BY day,model",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![user_id, from, to], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, i64>(6)?,
                ))
            })
            .map_err(db_err)?;
        let mut by_model: HashMap<String, (i64, i64)> = HashMap::new();
        for (day, model, rq, er, p, c, ca) in rows.filter_map(Result::ok) {
            requests += rq;
            errors += er;
            prompt += p;
            completion += c;
            cached += ca;
            let d = days.entry(day).or_default();
            d.0 += p + c;
            d.1 += rq;
            let m = by_model.entry(model).or_default();
            m.0 += rq;
            m.1 += p + c;
        }
        models = by_model
            .into_iter()
            .map(|(m, (rq, t))| (m, rq, t))
            .collect();
    }
    models.sort_by(|a, b| b.2.cmp(&a.2).then(b.1.cmp(&a.1)).then(a.0.cmp(&b.0)));
    let mut days: Vec<_> = days.into_iter().collect();
    days.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(json!({
        "requests": requests,
        "errors": errors,
        "promptTokens": prompt,
        "completionTokens": completion,
        "cachedTokens": cached,
        "totalTokens": prompt + completion,
        "models": models.iter().take(5).map(|(m, rq, t)| json!({"model": m, "requests": rq, "tokens": t})).collect::<Vec<_>>(),
        "days": days.iter().map(|(d, (t, rq))| json!({"day": d, "tokens": t, "requests": rq})).collect::<Vec<_>>(),
    }))
}

/// Latest reading per window and how often each hit the mark in the period.
fn subscriptions_section(
    conn: &Connection,
    user_id: &str,
    from: &str,
    to: &str,
) -> Result<(Vec<Value>, bool), String> {
    // (provider, account, window) -> (hit days, peak)
    let mut stats: HashMap<(String, String, String), (i64, f64)> = HashMap::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT provider,account,window_key,SUM(max_percent>=?4),MAX(max_percent)
                 FROM sub_limit_samples WHERE user_id=?1 AND day>=?2 AND day<=?3
                 GROUP BY provider,account,window_key",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![user_id, from, to, HIT_PERCENT], |r| {
                Ok((
                    (
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ),
                    (r.get::<_, i64>(3)?, r.get::<_, f64>(4)?),
                ))
            })
            .map_err(db_err)?;
        stats.extend(rows.filter_map(Result::ok));
    }
    let mut stmt = conn
        .prepare(
            "SELECT s.provider,s.account,s.window_key,s.label,s.percent,s.resets_at,s.sampled_at
             FROM sub_limit_samples s
             WHERE s.user_id=?1 AND s.retired=0 AND s.sampled_at=(SELECT MAX(t.sampled_at) FROM sub_limit_samples t
               WHERE t.user_id=s.user_id AND t.provider=s.provider AND t.account=s.account AND t.window_key=s.window_key)",
        )
        .map_err(db_err)?;
    type Latest = (String, String, String, String, f64, Option<i64>, i64);
    let mut latest: Vec<Latest> = stmt
        .query_map(params![user_id], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        })
        .map_err(db_err)?
        .filter_map(Result::ok)
        .collect();
    latest.sort_by(|a, b| {
        (&a.0, &a.1, window_rank(&a.2), &a.2).cmp(&(&b.0, &b.1, window_rank(&b.2), &b.2))
    });
    let mut subs: Vec<Value> = Vec::new();
    let mut frequent = false;
    for (provider, account, key, label, percent, resets_at, sampled_at) in latest {
        let (hit_days, peak) = stats
            .get(&(provider.clone(), account.clone(), key.clone()))
            .copied()
            .unwrap_or((0, 0.0));
        if hit_days >= FREQUENT_HIT_DAYS {
            frequent = true;
        }
        let mut w = json!({
            "key": key, "label": label, "percent": percent, "sampledAt": sampled_at,
            "hitDays": hit_days, "peakPercent": peak,
        });
        if let Some(r) = resets_at {
            w["resetsAt"] = json!(r);
        }
        let same = subs.last().is_some_and(|s| {
            s["provider"] == json!(provider)
                && s.get("account").and_then(Value::as_str).unwrap_or("") == account
        });
        if !same {
            let mut s = json!({"provider": provider, "windows": []});
            if !account.is_empty() {
                s["account"] = json!(account);
            }
            subs.push(s);
        }
        if let Some(arr) = subs.last_mut().and_then(|s| s["windows"].as_array_mut()) {
            arr.push(w);
        }
    }
    Ok((subs, frequent))
}

/// The seat's governance window as the `limit` object.
pub(crate) fn seat_limit_value(seat: &SeatLimit, now: i64) -> Value {
    let mut v = llmgw::limits_projection(&seat.rate_limit);
    // Each window resets on its own clock: a window past its reset counts 0
    // used (the stored counter is stale until the next request) and is
    // reported as such.
    for (used, reset) in [
        ("tokensUsed", "resetAt"),
        ("requestsUsed", "requestsResetAt"),
    ] {
        let expired = v
            .get(reset)
            .and_then(Value::as_i64)
            .is_some_and(|r| r <= now);
        if expired && v.contains_key(used) {
            v.insert(used.into(), json!(0));
        }
    }
    let share = |used: &str, max: &str| -> Option<f64> {
        let max = v.get(max)?.as_f64().filter(|m| *m > 0.0)?;
        Some(v.get(used)?.as_f64()? / max * 100.0)
    };
    let percent = match (
        share("tokensUsed", "tokens"),
        share("requestsUsed", "requests"),
    ) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    };
    v.insert("active".into(), json!(seat.is_active));
    if let Some(p) = percent {
        v.insert("percent".into(), json!((p * 10.0).round() / 10.0));
    }
    Value::Object(v)
}

/// One person's row. `limit` is attached by the caller (it needs the async
/// governance read).
pub(crate) fn member_report(
    ws: &WorkspaceStore,
    s: &Subject,
    from: &str,
    to: &str,
) -> Result<Value, String> {
    let conn = ws
        .conn
        .lock()
        .map_err(|_| "workspace database lock poisoned".to_string())?;
    let gateway = gateway_section(&conn, &s.user_id, from, to)?;
    let (subscriptions, hits_limit) = subscriptions_section(&conn, &s.user_id, from, to)?;
    let mut m = json!({
        "userId": s.user_id,
        "gateway": gateway,
        "subscriptions": subscriptions,
        "hitsLimit": hits_limit,
    });
    if let Some(e) = &s.email {
        m["email"] = json!(e);
    }
    if let Some(n) = &s.full_name {
        m["fullName"] = json!(n);
    }
    if !s.role.is_empty() {
        m["role"] = json!(s.role);
    }
    Ok(m)
}

/// The whole report for `subjects`, with seat limits merged in when the
/// governance read succeeded.
pub(crate) fn build_report(
    ws: &WorkspaceStore,
    scope: &str,
    subjects: &[Subject],
    limits: Option<&HashMap<String, SeatLimit>>,
    from: &str,
    to: &str,
    now: i64,
) -> Result<Value, String> {
    let mut members = Vec::new();
    for s in subjects {
        let mut m = member_report(ws, s, from, to)?;
        if let (Some(limits), Some(email)) = (limits, s.email.as_deref()) {
            if let Some(seat) = limits.get(&llmgw::seat_name(email)) {
                m["limit"] = seat_limit_value(seat, now);
            }
        }
        members.push(m);
    }
    let mut out = json!({
        "from": from, "to": to, "configured": true, "scope": scope, "members": members,
    });
    if let Some(at) = ws.usage_collected_at() {
        out["collectedAt"] = json!(at);
    }
    if limits.is_none() {
        out["limitsUnavailable"] = json!(true);
    }
    Ok(out)
}

#[cfg(test)]
#[path = "llm_usage_tests.rs"]
mod tests;
