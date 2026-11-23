//! Community rollout: who is past the waitlist, self-serve teams, and the
//! per-plan caps. Extends `WorkspaceStore` (same connection, same audit
//! table); `access_api.rs` is the HTTP surface on top.
//!
//! The state machine is deliberately small: `waitlist` → `active` (an admin
//! opens it, by hand, one person at a time) → `suspended` ⇄ `active`. An admin
//! can also open it for an address nobody has signed in with yet: that promise
//! waits in `access_preauth` and is claimed at the first SSO login. Everything
//! a person cannot do before
//! activation is refused at one gate (`require_active` in main.rs for HTTP,
//! `UiAccess::is_active` in the hub loop) rather than sprinkled per feature.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::workspace::{db_err, env_usize, insert_audit, normalize_email, now_ms, WorkspaceStore};

/// Invitations refused past the team cap. One text for both the member cap
/// and the pile-of-unanswered-invitations cap: the person fixing it does the
/// same thing either way (wait for answers, or ask for a bigger cap).
pub(crate) const MEMBER_CAP_ERR: &str = "В команде уже максимум участников";
/// Open (unaccepted, unexpired) invitations a team may hold at once.
pub(crate) const MAX_PENDING_INVITATIONS: i64 = 50;
/// Personal enrollment codes a user may mint per rolling hour.
pub(crate) const ENROLLMENTS_PER_HOUR: usize = 5;
pub(crate) const ENROLLMENT_RATE_ERR: &str = "Слишком много кодов за час";

/// Organizations one person may own (self-serve), unless overridden.
const ORG_CAP_PER_USER_DEFAULT: usize = 3;
const DEVICE_CAP_COMMUNITY_DEFAULT: usize = 2;
const DEVICE_CAP_EMPLOYEE_DEFAULT: usize = 10;

/// Activations by invitation one inviter may spend per rolling 30 days
/// (`CC_REMOTE_INVITE_ACTIVATIONS_PER_MONTH`). Every activation is a sandbox
/// on the host, so the share is what keeps one enthusiastic owner from
/// filling it.
pub const INVITE_ACTIVATIONS_PER_MONTH_DEFAULT: usize = 10;

/// How long a machine's connection request waits for someone to approve it.
pub const ENROLL_REQUEST_TTL_MS: i64 = 10 * 60 * 1000;
/// Open requests hub-wide — the unauthenticated surface's ceiling.
pub const ENROLL_REQUEST_OPEN_CAP: usize = 200;
/// How often the machine should poll, in seconds.
pub const ENROLL_REQUEST_POLL_SECS: u64 = 3;
/// No 0/O, 1/I: a code read aloud or typed from a screen.
const USER_CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/// `K7Q4-M2ZP`: eight symbols from an unambiguous alphabet.
pub(crate) fn new_user_code() -> String {
    let bytes = *Uuid::new_v4().as_bytes();
    let chars: String = bytes[..8]
        .iter()
        .map(|b| USER_CODE_ALPHABET[(*b as usize) % USER_CODE_ALPHABET.len()] as char)
        .collect();
    format!("{}-{}", &chars[..4], &chars[4..])
}

/// What a person typed or pasted, as the hash key: uppercase, letters and
/// digits only, so `k7q4 m2zp` and `K7Q4-M2ZP` are the same request.
pub(crate) fn normalize_user_code(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

/// Whether `machine_id` still holds a credential that has not been revoked.
/// `/link` approval refuses such a machine: see `approve_enrollment_request`.
pub(crate) fn machine_has_live_credential(
    tx: &Connection,
    machine_id: &str,
) -> Result<bool, String> {
    tx.query_row(
        "SELECT 1 FROM device_credentials WHERE machine_id=?1 AND revoked_at IS NULL LIMIT 1",
        params![machine_id],
        |_| Ok(()),
    )
    .optional()
    .map(|r| r.is_some())
    .map_err(db_err)
}

/// Take `user_id` out of `workspace_id` inside the caller's transaction: the
/// membership, their place on every share list of the team (a restricted share
/// keeps its flag, so it does not open), manager assignments naming them in
/// either role, and the shares they own there. ONE definition, used by the
/// normal member removal and by the Telegram sign-in undo, so the two cannot
/// diverge. Checks nothing about WHO may do it — the callers do.
pub(crate) fn remove_membership_rows(
    tx: &Connection,
    workspace_id: &str,
    user_id: &str,
) -> Result<(), String> {
    tx.execute(
        "DELETE FROM memberships WHERE workspace_id=?1 AND user_id=?2",
        params![workspace_id, user_id],
    )
    .map_err(db_err)?;
    tx.execute(
        "DELETE FROM project_share_members WHERE user_id=?2 AND project_share_id IN (SELECT project_share_id FROM project_shares WHERE workspace_id=?1)",
        params![workspace_id, user_id],
    )
    .map_err(db_err)?;
    tx.execute(
        "DELETE FROM manager_assignments WHERE workspace_id=?1 AND (manager_user_id=?2 OR (target_kind='member' AND target_id=?2))",
        params![workspace_id, user_id],
    )
    .map_err(db_err)?;
    tx.execute(
        "DELETE FROM project_shares WHERE workspace_id=?1 AND owner_user_id=?2",
        params![workspace_id, user_id],
    )
    .map_err(db_err)?;
    Ok(())
}

/// What `activate_by_invitation` did, or why not.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum InviteActivation {
    Activated,
    AlreadyActive,
    Suspended,
    InviterInactive,
    CapReached,
    NotFound,
}

/// One `user_access` row, plus the privileged override applied
/// (`access_state` reports the bootstrap owner and platform admins as an
/// active employee whatever the row says).
#[derive(Clone, Debug)]
pub struct AccessRecord {
    pub user_id: String,
    pub state: String,
    pub plan: String,
    pub note: Option<String>,
    pub requested_at: i64,
    pub activated_at: Option<i64>,
    pub suspended_at: Option<i64>,
    pub suspend_reason: Option<String>,
    pub seat_status: String,
    pub seat_error: Option<String>,
    pub sandbox_status: String,
    pub sandbox_machine_id: Option<String>,
    pub sandbox_host: Option<String>,
    pub sandbox_error: Option<String>,
    /// The unix user / machine name of the sandbox is `sb-<slug>`. Assigned
    /// once (when the first `sandbox_create` is queued) and never changed —
    /// the provisioner's steps are keyed on it.
    pub sandbox_slug: Option<String>,
}

/// Tables + columns for the community rollout. Same idempotent style as
/// `WorkspaceStore::init`: CREATE IF NOT EXISTS, ALTERs whose "duplicate
/// column" failure is swallowed on purpose, then a one-time backfill keyed in
/// `schema_meta` so it never runs twice.
pub(crate) fn init_access_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS user_access (
          user_id TEXT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
          state TEXT NOT NULL CHECK(state IN ('waitlist','active','suspended')),
          plan  TEXT NOT NULL DEFAULT 'community' CHECK(plan IN ('employee','community')),
          -- `wave` is history: access came in cohorts once. Nothing writes or
          -- reads it any more (see `claim_preauthorization`), and it is kept
          -- so the backfill's 'legacy' marks and the old cohort labels survive.
          wave TEXT, note TEXT,
          requested_at INTEGER NOT NULL, activated_at INTEGER, activated_by TEXT,
          suspended_at INTEGER, suspended_by TEXT, suspend_reason TEXT,
          seat_status TEXT NOT NULL DEFAULT 'none',
          seat_error TEXT, seat_attempts INTEGER NOT NULL DEFAULT 0,
          sandbox_status TEXT NOT NULL DEFAULT 'none',
          sandbox_machine_id TEXT, sandbox_host TEXT, sandbox_error TEXT,
          sandbox_slug TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT);
        -- An email an admin opened the product for before that person ever
        -- signed in. No user id: HegAI SSO owns that namespace, so the promise
        -- is keyed on the address and claimed at the first login
        -- (`claim_preauthorization`). Claimed rows are kept, not deleted --
        -- they are the record of who let whom in, and they must outlive the
        -- account, which `user_access` does not (ON DELETE CASCADE).
        CREATE TABLE IF NOT EXISTS access_preauth (
          email      TEXT PRIMARY KEY,
          plan       TEXT NOT NULL DEFAULT 'community' CHECK(plan IN ('employee','community')),
          note       TEXT,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          claimed_by TEXT,
          claimed_at INTEGER
        );
        -- A machine asking to be connected (24.09.2026): it minted a short
        -- code and a poll token and is waiting for a signed-in person to
        -- approve the code on /link. Only hashes of both are kept; the device
        -- token the approval mints is held until the machine polls it once,
        -- then cleared. Rows die with their TTL and are swept an hour later.
        CREATE TABLE IF NOT EXISTS enrollment_requests (
          poll_hash      TEXT PRIMARY KEY,
          user_code_hash TEXT NOT NULL UNIQUE,
          machine_json   TEXT NOT NULL,
          client_ip      TEXT,
          created_at     INTEGER NOT NULL,
          expires_at     INTEGER NOT NULL,
          approved_by    TEXT,
          approved_at    INTEGER,
          denied_at      INTEGER,
          device_token   TEXT,
          machine_id     TEXT,
          picked_at      INTEGER
        );
        CREATE TABLE IF NOT EXISTS provision_jobs (
          job_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('sandbox_create','sandbox_suspend','sandbox_resume','sandbox_delete','sandbox_rotate_key')),
          status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed')),
          host TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          enrollment_code_hash TEXT,
          machine_id TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          claimed_at INTEGER,
          heartbeat_at INTEGER,
          finished_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS provision_jobs_status ON provision_jobs(status, created_at);
        -- Sandbox names of deleted accounts. The unix user `sb-<slug>` and its
        -- home outlive the account on the sandbox host (the provisioner only
        -- runs jobs for a living account), and the provisioner ADOPTS an
        -- existing home — so a slug handed out again would give the next
        -- person the previous one's ~/.claude, tokens and projects. Never
        -- reissued (`ensure_slug_in`); an operator removes the home by hand.
        CREATE TABLE IF NOT EXISTS retired_sandbox_slugs (
          slug       TEXT PRIMARY KEY,
          host       TEXT,
          machine_id TEXT,
          retired_at INTEGER NOT NULL
        );
        "#,
    )
    .map_err(db_err)?;
    for ddl in [
        "ALTER TABLE workspaces ADD COLUMN slug TEXT",
        "ALTER TABLE workspaces ADD COLUMN member_cap INTEGER",
        "ALTER TABLE workspaces ADD COLUMN self_serve INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'personal'",
        "ALTER TABLE enrollments ADD COLUMN purpose TEXT NOT NULL DEFAULT 'device'",
        "ALTER TABLE project_shares ADD COLUMN visibility TEXT NOT NULL DEFAULT 'team'",
        "ALTER TABLE user_access ADD COLUMN sandbox_slug TEXT",
    ] {
        // "duplicate column" on every start after the first — ignored, as for
        // the older migrations in workspace.rs.
        let _ = conn.execute(ddl, []);
    }
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS workspaces_slug ON workspaces(slug) WHERE slug IS NOT NULL;
         CREATE UNIQUE INDEX IF NOT EXISTS user_access_sandbox_slug ON user_access(sandbox_slug) WHERE sandbox_slug IS NOT NULL;",
    )
    .map_err(db_err)?;
    backfill_access(conn)
}

/// `audit_workspace_for` on an open connection or transaction: the
/// organization the user owns if there is one (where teammates see it), else
/// their personal workspace. Used by writers that already hold the store
/// mutex and cannot call the locking version.
pub(crate) fn audit_workspace_in(
    conn: &Connection,
    user_id: &str,
) -> Result<Option<String>, String> {
    for kind in ["organization", "personal"] {
        let found: Option<String> = conn
            .query_row(
                "SELECT w.workspace_id FROM workspaces w JOIN memberships m ON m.workspace_id=w.workspace_id \
                 WHERE m.user_id=?1 AND m.role='owner' AND w.kind=?2 ORDER BY w.created_at ASC LIMIT 1",
                params![user_id, kind],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        if found.is_some() {
            return Ok(found);
        }
    }
    Ok(None)
}

/// Claim the promise an admin left for this address, if there is one: the
/// person is active from their very first read, not after a round trip
/// through the waiting screen. Runs inside `ensure_user`'s transaction, which
/// has just created the personal workspace the audit row lands in — hence
/// `audit_workspace_in` and not the locking `audit_workspace_for`.
///
/// Keyed on the address and not on "is this the first login", because
/// `users.email` follows HegAI on every login: whoever proves the address
/// gets in, the same trust an accepted invitation already runs on. The actor
/// on the audit row is the admin who opened it, so the trail answers who let
/// this person in.
pub(crate) fn claim_preauthorization(
    tx: &Connection,
    user_id: &str,
    email: &str,
    now: i64,
) -> Result<bool, String> {
    let row: Option<(String, String, i64)> = tx
        .query_row(
            "SELECT plan,created_by,created_at FROM access_preauth WHERE email=?1 AND claimed_at IS NULL",
            params![email],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(db_err)?;
    let Some((plan, created_by, created_at)) = row else {
        return Ok(false);
    };
    // Compare-and-swap in the same transaction as the state change: two
    // first logins for one address cannot both consume the promise.
    let claimed = tx
        .execute(
            "UPDATE access_preauth SET claimed_by=?2,claimed_at=?3 WHERE email=?1 AND claimed_at IS NULL",
            params![email, user_id, now],
        )
        .map_err(db_err)?;
    if claimed == 0 {
        return Ok(false);
    }
    tx.execute(
        "INSERT INTO user_access(user_id,state,plan,requested_at,activated_at,activated_by,updated_at) \
         VALUES(?1,'active',?2,?3,?3,?4,?3) \
         ON CONFLICT(user_id) DO UPDATE SET state='active',plan=excluded.plan,\
           activated_at=excluded.activated_at,activated_by=excluded.activated_by,updated_at=excluded.updated_at",
        params![user_id, plan, now, created_by],
    )
    .map_err(db_err)?;
    if let Some(ws) = audit_workspace_in(tx, user_id)? {
        insert_audit(
            tx,
            &ws,
            &created_by,
            "access.activated",
            "user",
            user_id,
            &json!({"source":"preauthorization","email":email,"preauthorizedAt":created_at}),
        )?;
    }
    Ok(true)
}

/// Everyone who existed before the rollout is an employee already using the
/// product; they must notice nothing. Runs once per database.
fn backfill_access(conn: &Connection) -> Result<(), String> {
    let done: Option<String> = conn
        .query_row(
            "SELECT value FROM schema_meta WHERE key='access_backfill'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_err)?;
    if done.is_some() {
        return Ok(());
    }
    let now = now_ms();
    let migrated = conn
        .execute(
            "INSERT OR IGNORE INTO user_access(user_id,state,plan,wave,requested_at,activated_at,activated_by,updated_at) \
             SELECT user_id,'active','employee','legacy',created_at,?1,'backfill',?1 FROM users",
            params![now],
        )
        .map_err(db_err)?;
    conn.execute(
        "INSERT INTO schema_meta(key,value) VALUES('access_backfill',?1)",
        params![now.to_string()],
    )
    .map_err(db_err)?;
    if migrated > 0 {
        println!(
            "[access] backfill: {migrated} existing user(s) marked active/employee (wave=legacy)"
        );
    }
    Ok(())
}

/// State a brand-new user lands in, unless a pre-authorization claims them
/// first. `CC_REMOTE_ACCESS_DEFAULT=active` is the dev escape (a laptop hub
/// has no admin to open access); `waitlist` forces the community gate. Unset,
/// the edition decides: the internal hub keeps the gate for everyone; the
/// customer's own (external) hub opens only accounts somebody vouched for
/// (`vouched`: created by the owner/an admin, the bootstrap owner, or a sign-in
/// from a domain the customer listed in `OIDC_ALLOWED_DOMAINS` /
/// `GOOGLE_ALLOWED_DOMAINS`). Telegram, Apple, review and unrestricted OIDC /
/// Google sign-ins wait for the owner's approval in the access screen.
pub(crate) fn new_account_state(vouched: bool) -> &'static str {
    access_state_for(
        std::env::var("CC_REMOTE_ACCESS_DEFAULT").ok().as_deref(),
        crate::edition::is_external(),
        vouched,
    )
}

fn access_state_for(explicit: Option<&str>, external: bool, vouched: bool) -> &'static str {
    match explicit {
        Some("active") => "active",
        Some("waitlist") => "waitlist",
        _ if external && vouched => "active",
        _ => "waitlist",
    }
}

/// Domain of the synthetic seat key of an account without an e-mail. It can
/// never be a real mailbox (`.invalid`), and it is derived from the user id so
/// it is stable for ANY no-email account (Telegram-only, GitHub + Telegram…).
const SEAT_KEY_DOMAIN: &str = "users.invalid";

pub(crate) fn synthetic_seat_key(user_id: &str) -> String {
    format!("{}@{SEAT_KEY_DOMAIN}", user_id.to_ascii_lowercase())
}

/// The user a synthetic seat key belongs to (its account has no e-mail).
pub(crate) fn user_of_seat_key(conn: &Connection, key: &str) -> Option<String> {
    let id = key
        .trim()
        .to_ascii_lowercase()
        .strip_suffix(&format!("@{SEAT_KEY_DOMAIN}"))?
        .to_string();
    conn.query_row(
        "SELECT user_id FROM users WHERE lower(user_id)=?1 AND (email IS NULL OR email='')",
        params![id],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

/// Seats are named `hegai:<key>`: the e-mail, or — on a self-hosted hub only —
/// the synthetic key of an account that has none.
pub(crate) fn seat_key_for(user_id: &str, email: Option<&str>) -> Option<String> {
    // A stored address in the synthetic domain is never a real mailbox: it
    // must not name (or collide with) another account's seat.
    let real = email.map(str::trim).filter(|e| !e.is_empty()).filter(|e| {
        !e.to_ascii_lowercase()
            .ends_with(&format!("@{SEAT_KEY_DOMAIN}"))
    });
    match real {
        Some(e) => Some(e.to_string()),
        None if crate::edition::is_external() => Some(synthetic_seat_key(user_id)),
        None => None,
    }
}

/// Whether `inviter` has used up their invitation activations in the rolling
/// 30 days (counted from the `access.activated` audit rows, so the ledger is
/// the trail). Shared by the e-mail and the Telegram invitation paths.
pub(crate) fn invite_cap_reached(
    conn: &Connection,
    inviter: &str,
    cap: usize,
) -> Result<bool, String> {
    let since = now_ms() - 30 * 24 * 60 * 60 * 1000;
    let spent: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM audit_events WHERE actor_user_id=?1 AND action='access.activated' \
             AND metadata_json LIKE '%\"source\":\"invitation\"%' AND created_at>?2",
            params![inviter, since],
            |r| r.get(0),
        )
        .map_err(db_err)?;
    Ok(spent as usize >= cap)
}

/// Invitation activations per inviter per month (`CC_REMOTE_INVITE_ACTIVATIONS_PER_MONTH`).
pub(crate) fn invite_activation_cap() -> usize {
    std::env::var("CC_REMOTE_INVITE_ACTIVATIONS_PER_MONTH")
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(INVITE_ACTIVATIONS_PER_MONTH_DEFAULT)
}

pub(crate) fn device_cap_for_plan(plan: &str) -> usize {
    if plan == "employee" {
        env_usize("CC_REMOTE_DEVICE_CAP_EMPLOYEE", DEVICE_CAP_EMPLOYEE_DEFAULT)
    } else {
        env_usize(
            "CC_REMOTE_DEVICE_CAP_COMMUNITY",
            DEVICE_CAP_COMMUNITY_DEFAULT,
        )
    }
}

fn read_access_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<AccessRecord> {
    Ok(AccessRecord {
        user_id: r.get(0)?,
        state: r.get(1)?,
        plan: r.get(2)?,
        note: r.get(3)?,
        requested_at: r.get(4)?,
        activated_at: r.get(5)?,
        suspended_at: r.get(6)?,
        suspend_reason: r.get(7)?,
        seat_status: r.get(8)?,
        seat_error: r.get(9)?,
        sandbox_status: r.get(10)?,
        sandbox_machine_id: r.get(11)?,
        sandbox_host: r.get(12)?,
        sandbox_error: r.get(13)?,
        sandbox_slug: r.get(14)?,
    })
}

/// One `access_preauth` row as the shared `PreauthorizedEmail` schema wants
/// it. Optional fields are omitted, never null.
fn preauth_json(email: String, note: Option<String>, created_by: String, created_at: i64) -> Value {
    let mut v = json!({"email": email, "createdBy": created_by, "createdAt": created_at});
    if let Some(n) = note {
        v["note"] = Value::String(n);
    }
    v
}

/// The unclaimed promise for this address, if any. Takes the open transaction.
fn read_preauth(tx: &Connection, email: &str) -> Result<Option<Value>, String> {
    tx.query_row(
        "SELECT email,note,created_by,created_at FROM access_preauth WHERE email=?1 AND claimed_at IS NULL",
        params![email],
        |r| Ok(preauth_json(r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
    .optional()
    .map_err(db_err)
}

const ACCESS_COLUMNS: &str = "user_id,state,plan,note,requested_at,activated_at,suspended_at,suspend_reason,seat_status,seat_error,sandbox_status,sandbox_machine_id,sandbox_host,sandbox_error,sandbox_slug";
/// Number of columns in `ACCESS_COLUMNS`; joined queries read past it. Wrong
/// here means `access_rows` reads the neighbouring column instead of failing.
const ACCESS_COLUMN_COUNT: usize = 15;

/// What the admin list joins onto a row, read past `ACCESS_COLUMN_COUNT + 2`
/// (see `access_rows`): the registration answers, the GitHub profile and the
/// repository grant. Absent parts are absent keys, never nulls.
fn joined_access_json(r: &rusqlite::Row<'_>) -> rusqlite::Result<Vec<(&'static str, Value)>> {
    let base = ACCESS_COLUMN_COUNT + 2;
    let text = |i: usize| r.get::<_, Option<String>>(base + i);
    let mut out = Vec::new();
    if let Some(role) = text(0)? {
        let mut reg = json!({"role": role, "purpose": text(1)?.unwrap_or_default(), "updatedAt": r.get::<_, i64>(base + 5)?});
        for (key, i) in [("company", 2), ("telegram", 3), ("source", 4)] {
            if let Some(v) = text(i)? {
                reg[key] = Value::String(v);
            }
        }
        out.push(("registration", reg));
    }
    if let (Some(id), Some(login)) = (text(6)?, text(7)?) {
        let mut gh = json!({"id": id, "login": login});
        for (key, i) in [
            ("name", 8),
            ("avatarUrl", 9),
            ("createdAt", 10),
            ("bio", 13),
            ("blog", 14),
            ("company", 15),
        ] {
            if let Some(v) = text(i)? {
                gh[key] = Value::String(v);
            }
        }
        for (key, i) in [("publicRepos", 11), ("followers", 12)] {
            if let Some(n) = r.get::<_, Option<i64>>(base + i)? {
                gh[key] = json!(n);
            }
        }
        out.push(("github", gh));
    }
    if let (Some(repo), Some(status)) = (text(16)?, text(17)?) {
        let grant = crate::github_grant::GrantRow {
            repo,
            status,
            error: text(18)?,
            attempts: r.get::<_, Option<i64>>(base + 19)?.unwrap_or(0),
        };
        out.push(("githubGrant", grant.json(true)));
    }
    Ok(out)
}

/// Machine name of a user's sandbox, `sb-<slug>`. Also its unix user.
pub(crate) fn sandbox_machine_name(slug: &str) -> String {
    format!("sb-{slug}")
}

/// Cyrillic → Latin for team slugs. Lossy on purpose: a slug is a handle, not
/// a name, and the name itself is kept verbatim.
const TRANSLIT: &[(char, &str)] = &[
    ('а', "a"),
    ('б', "b"),
    ('в', "v"),
    ('г', "g"),
    ('д', "d"),
    ('е', "e"),
    ('ё', "yo"),
    ('ж', "zh"),
    ('з', "z"),
    ('и', "i"),
    ('й', "y"),
    ('к', "k"),
    ('л', "l"),
    ('м', "m"),
    ('н', "n"),
    ('о', "o"),
    ('п', "p"),
    ('р', "r"),
    ('с', "s"),
    ('т', "t"),
    ('у', "u"),
    ('ф', "f"),
    ('х', "h"),
    ('ц', "ts"),
    ('ч', "ch"),
    ('ш', "sh"),
    ('щ', "sch"),
    ('ъ', ""),
    ('ы', "y"),
    ('ь', ""),
    ('э', "e"),
    ('ю', "yu"),
    ('я', "ya"),
    ('і', "i"),
    ('ї', "yi"),
    ('є', "ye"),
    ('ґ', "g"),
];

/// Lowercase `[a-z0-9-]`, ≤32 chars, no leading/trailing/doubled dashes.
/// Empty input (a name with nothing transliterable) becomes `team`.
pub(crate) fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut dash = true; // suppress a leading dash
    for ch in name.chars().flat_map(|c| c.to_lowercase()) {
        let mapped: String = if ch.is_ascii_alphanumeric() {
            ch.to_string()
        } else if let Some((_, latin)) = TRANSLIT.iter().find(|(cyr, _)| *cyr == ch) {
            (*latin).to_string()
        } else {
            String::new()
        };
        if mapped.is_empty() {
            if !dash && !out.is_empty() {
                out.push('-');
                dash = true;
            }
            continue;
        }
        out.push_str(&mapped);
        dash = false;
    }
    let trimmed: String = out.trim_matches('-').chars().take(32).collect();
    let trimmed = trimmed.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "team".to_string()
    } else {
        trimmed
    }
}

/// Trim, collapse whitespace runs, refuse control characters, 2..=48 chars.
pub(crate) fn normalize_team_name(raw: &str) -> Result<String, String> {
    if raw.chars().any(char::is_control) {
        return Err("Название команды содержит недопустимые символы".into());
    }
    let name = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let len = name.chars().count();
    if !(2..=48).contains(&len) {
        return Err("Название команды — от 2 до 48 символов".into());
    }
    Ok(name)
}

impl WorkspaceStore {
    /// Ids reported active/employee regardless of their row: the bootstrap
    /// owner and every platform admin. Called once from main.rs.
    pub fn set_always_active(&self, ids: impl IntoIterator<Item = String>) {
        if let Ok(mut set) = self.always_active.write() {
            *set = ids.into_iter().collect::<HashSet<String>>();
        }
    }

    pub(crate) fn is_privileged(&self, user_id: &str) -> bool {
        self.always_active
            .read()
            .map(|set| set.contains(user_id))
            .unwrap_or(false)
    }

    /// The user's access record with the privileged override applied. A user
    /// with no row (should not happen after the backfill) reads as a fresh
    /// waitlist entry rather than an error, so a missing row can never open
    /// the product.
    pub fn access_state(&self, user_id: &str) -> Result<AccessRecord, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let row = conn
            .query_row(
                &format!("SELECT {ACCESS_COLUMNS} FROM user_access WHERE user_id=?1"),
                params![user_id],
                read_access_row,
            )
            .optional()
            .map_err(db_err)?;
        drop(conn);
        let mut record = row.unwrap_or_else(|| AccessRecord {
            user_id: user_id.to_string(),
            state: "waitlist".into(),
            plan: "community".into(),
            note: None,
            requested_at: now_ms(),
            activated_at: None,
            suspended_at: None,
            suspend_reason: None,
            seat_status: "none".into(),
            seat_error: None,
            sandbox_status: "none".into(),
            sandbox_machine_id: None,
            sandbox_host: None,
            sandbox_error: None,
            sandbox_slug: None,
        });
        if self.is_privileged(user_id) {
            record.state = "active".into();
            record.plan = "employee".into();
        }
        Ok(record)
    }

    pub fn is_active(&self, user_id: &str) -> bool {
        self.access_state(user_id)
            .map(|a| a.state == "active")
            .unwrap_or(false)
    }

    /// `viewer.access` as the shared `ViewerAccess` schema wants it. Optional
    /// fields are omitted, never null.
    pub(crate) fn viewer_access_json(&self, access: &AccessRecord) -> Result<Value, String> {
        let mut out = json!({
            "state": access.state,
            "plan": access.plan,
            "requestedAt": access.requested_at,
            "seat": {"status": access.seat_status},
            "sandbox": {"status": access.sandbox_status},
            "deviceCap": device_cap_for_plan(&access.plan),
        });
        if let Some(at) = access.activated_at {
            out["activatedAt"] = json!(at);
        }
        // Has the newcomer filled the registration form in (`access_registration.rs`)?
        out["registered"] = json!(self.is_registered(&access.user_id));
        // Where their read access to the private repository stands, if the hub
        // grants it (`github_grant.rs`). Status and repository only.
        let grant = {
            let conn = self
                .conn
                .lock()
                .map_err(|_| "workspace database lock poisoned".to_string())?;
            crate::github_grant::read_grant(&conn, &access.user_id)?
        };
        if let Some(grant) = grant {
            out["githubGrant"] = grant.json(false);
        }
        // The name is known from the moment the job is queued (`sb-<slug>`),
        // so the "machine is being prepared" card can already say which one.
        if let Some(slug) = &access.sandbox_slug {
            out["sandbox"]["machineName"] = Value::String(sandbox_machine_name(slug));
        }
        if let Some(machine_id) = &access.sandbox_machine_id {
            out["sandbox"]["machineId"] = Value::String(machine_id.clone());
            if access.sandbox_slug.is_none() {
                let conn = self
                    .conn
                    .lock()
                    .map_err(|_| "workspace database lock poisoned".to_string())?;
                let name: Option<String> = conn
                    .query_row(
                        "SELECT name FROM devices WHERE machine_id=?1",
                        params![machine_id],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(db_err)?;
                if let Some(name) = name {
                    out["sandbox"]["machineName"] = Value::String(name);
                }
            }
        }
        Ok(out)
    }

    // ------------------------------------------------------------- seats

    /// Record the gateway seat's state. `error` replaces the stored one
    /// (`None` clears it); it must never contain the seat's secret.
    pub fn set_seat_status(
        &self,
        user_id: &str,
        status: &str,
        error: Option<&str>,
    ) -> Result<(), String> {
        let error = error.map(|e| e.chars().take(500).collect::<String>());
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.execute(
            "UPDATE user_access SET seat_status=?2,seat_error=?3,updated_at=?4 WHERE user_id=?1",
            params![user_id, status, error, now_ms()],
        )
        .map_err(db_err)?;
        Ok(())
    }

    /// One more provisioning attempt on the seat; returns the new count.
    pub fn bump_seat_attempts(&self, user_id: &str) -> Result<i64, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.query_row(
            "UPDATE user_access SET seat_attempts=seat_attempts+1,updated_at=?2 WHERE user_id=?1 RETURNING seat_attempts",
            params![user_id, now_ms()],
            |r| r.get(0),
        )
        .map_err(db_err)
    }

    /// Start the seat over: attempts back to zero, status `pending`, error
    /// cleared. The admin "retry" and reactivation both go through here.
    pub fn reset_seat(&self, user_id: &str) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.execute(
            "UPDATE user_access SET seat_attempts=0,seat_status='pending',seat_error=NULL,updated_at=?2 WHERE user_id=?1",
            params![user_id, now_ms()],
        )
        .map_err(db_err)?;
        Ok(())
    }

    /// Active community members whose seat is not ready and still has
    /// attempts left: `(user_id, seat key)`. The reconciler's worklist.
    /// `include_none` (a self-hosted hub with its own gateway) also lists
    /// members whose seat was never requested (`none`): they get one.
    pub fn seats_needing_work(
        &self,
        max_attempts: i64,
        include_none: bool,
    ) -> Result<Vec<(String, String)>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT a.user_id,u.email FROM user_access a JOIN users u ON u.user_id=a.user_id \
                 WHERE a.state='active' AND a.plan='community' \
                   AND ((a.seat_status IN ('pending','failed') AND a.seat_attempts<?1) \
                        OR (?2=1 AND a.seat_status='none' AND EXISTS(\
                              SELECT 1 FROM memberships m JOIN workspaces w ON w.workspace_id=m.workspace_id \
                              WHERE m.user_id=a.user_id AND w.kind<>'personal'))) \
                 ORDER BY a.activated_at ASC",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![max_attempts, include_none as i64], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })
            .map_err(db_err)?
            .filter_map(Result::ok)
            .filter_map(|(id, email)| seat_key_for(&id, email.as_deref()).map(|k| (id, k)))
            .collect();
        Ok(rows)
    }

    /// Whether the user belongs to a team (a non-personal workspace).
    pub fn is_team_member(&self, user_id: &str) -> bool {
        let Ok(conn) = self.conn.lock() else {
            return false;
        };
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM memberships m JOIN workspaces w ON w.workspace_id=m.workspace_id \
             WHERE m.user_id=?1 AND w.kind<>'personal')",
            params![user_id],
            |r| r.get(0),
        )
        .unwrap_or(false)
    }

    /// The name a user's gateway seat is keyed by: the e-mail, or — for a
    /// Telegram-only account on a self-hosted hub — a synthetic address.
    pub fn seat_key(&self, user_id: &str) -> Option<String> {
        seat_key_for(user_id, self.user_email(user_id).as_deref())
    }

    /// A user-level audit row (`gateway.seat_ready`, …) in the workspace the
    /// user owns. Best-effort by design: a missing workspace drops the row,
    /// never the state change it describes.
    pub fn audit_user_event(
        &self,
        user_id: &str,
        actor: &str,
        action: &str,
        metadata: &Value,
    ) -> Result<(), String> {
        let Some(ws) = self.audit_workspace_for(user_id) else {
            return Ok(());
        };
        self.audit(&ws, actor, action, "user", user_id, metadata)
    }

    /// Personal-device cap for a user, by plan. Takes the open transaction so
    /// `exchange_enrollment` can check it without re-entering the lock.
    pub(crate) fn device_cap_for(&self, conn: &Connection, user_id: &str) -> Result<usize, String> {
        if self.is_privileged(user_id) {
            return Ok(device_cap_for_plan("employee"));
        }
        let plan: Option<String> = conn
            .query_row(
                "SELECT plan FROM user_access WHERE user_id=?1",
                params![user_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        Ok(device_cap_for_plan(plan.as_deref().unwrap_or("community")))
    }

    /// Workspace to record a user-level audit row in: the organization they
    /// own if there is one (where teammates see it), else their personal one.
    pub fn audit_workspace_for(&self, user_id: &str) -> Option<String> {
        let workspaces = self.workspaces(user_id).ok()?;
        let pick = |kind: &str| {
            workspaces
                .iter()
                .find(|w| {
                    w.get("kind").and_then(Value::as_str) == Some(kind)
                        && w.get("role").and_then(Value::as_str) == Some("owner")
                })
                .and_then(|w| w.get("workspaceId").and_then(Value::as_str))
                .map(str::to_string)
        };
        pick("organization").or_else(|| pick("personal"))
    }

    // ------------------------------------------------------------ access

    /// Open the product for an address nobody has signed in with yet. The
    /// promise waits here until `claim_preauthorization` takes it at that
    /// person's first SSO login. Returns `(created, row)`: `created == false`
    /// means an unclaimed promise was already there, and it is returned
    /// untouched — silently rewriting an earlier admin's note is a surprise.
    pub fn preauthorize(
        &self,
        email: &str,
        actor: &str,
        note: Option<&str>,
        plan: &str,
    ) -> Result<(bool, Value), String> {
        let email = normalize_email(email);
        let now = now_ms();
        let audit_ws = self.audit_workspace_for(actor);
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        if let Some(existing) = read_preauth(&tx, &email)? {
            return Ok((false, existing));
        }
        tx.execute(
            "INSERT INTO access_preauth(email,plan,note,created_by,created_at) VALUES(?1,?2,?3,?4,?5) \
             ON CONFLICT(email) DO UPDATE SET plan=excluded.plan,note=excluded.note,\
               created_by=excluded.created_by,created_at=excluded.created_at,claimed_by=NULL,claimed_at=NULL",
            params![email, plan, note, actor, now],
        )
        .map_err(db_err)?;
        if let Some(ws) = &audit_ws {
            insert_audit(
                &tx,
                ws,
                actor,
                "access.preauthorized",
                "email",
                &email,
                &json!({"plan":plan,"note":note}),
            )?;
        }
        let row = read_preauth(&tx, &email)?.unwrap_or_else(|| json!({"email": email}));
        tx.commit().map_err(db_err)?;
        Ok((true, row))
    }

    /// Promises still waiting for their first login, oldest first.
    pub fn pending_preauthorizations(&self) -> Result<Vec<Value>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT email,note,created_by,created_at FROM access_preauth \
                 WHERE claimed_at IS NULL ORDER BY created_at ASC",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| {
                let email: String = r.get(0)?;
                let note: Option<String> = r.get(1)?;
                let created_by: String = r.get(2)?;
                let created_at: i64 = r.get(3)?;
                Ok(preauth_json(email, note, created_by, created_at))
            })
            .map_err(db_err)?
            .filter_map(Result::ok)
            .collect();
        Ok(rows)
    }

    /// Take back a promise nobody has used yet. A claimed one is left alone:
    /// that person has an account now, and the verb for them is `suspend`.
    pub fn revoke_preauthorization(&self, email: &str, actor: &str) -> Result<bool, String> {
        let email = normalize_email(email);
        let audit_ws = self.audit_workspace_for(actor);
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let removed = tx
            .execute(
                "DELETE FROM access_preauth WHERE email=?1 AND claimed_at IS NULL",
                params![email],
            )
            .map_err(db_err)?;
        if removed == 0 {
            return Ok(false);
        }
        if let Some(ws) = &audit_ws {
            insert_audit(
                &tx,
                ws,
                actor,
                "access.preauth_revoked",
                "email",
                &email,
                &json!({}),
            )?;
        }
        tx.commit().map_err(db_err)?;
        Ok(true)
    }

    /// waitlist → active. Returns false (and writes nothing) when the user is
    /// already active; refuses a suspended user — that is `reactivate_access`.
    /// The audit row lands in the same transaction as the state change.
    pub fn activate_access(&self, user_id: &str, actor: &str) -> Result<bool, String> {
        self.activate_with_source(user_id, actor, &json!({"source":"admin"}))
    }

    /// Accepting a team invitation opens access, within a share the inviter
    /// has (24.09.2026). The trust is the same one `claim_preauthorization`
    /// relies on: `accept_invitation` has just proven the invitation was
    /// theirs and matched this person's email. Three refusals keep it from
    /// becoming a side door: the invitee must be on the WAITLIST (a suspended
    /// person stays suspended), the inviter must be active themselves, and
    /// each inviter gets `cap` such activations per rolling 30 days —
    /// counted from the audit rows this writes, so the ledger is the trail.
    pub fn activate_by_invitation(
        &self,
        invitee: &str,
        inviter: &str,
        cap: usize,
    ) -> Result<InviteActivation, String> {
        let state = self.access_state(invitee).ok().map(|a| a.state);
        match state.as_deref() {
            None => return Ok(InviteActivation::NotFound),
            Some("active") => return Ok(InviteActivation::AlreadyActive),
            Some("suspended") => return Ok(InviteActivation::Suspended),
            _ => {}
        }
        if !self.is_active(inviter) {
            return Ok(InviteActivation::InviterInactive);
        }
        let capped = {
            let conn = self
                .conn
                .lock()
                .map_err(|_| "workspace database lock poisoned".to_string())?;
            invite_cap_reached(&conn, inviter, cap)?
        };
        if capped {
            return Ok(InviteActivation::CapReached);
        }
        match self.activate_with_source(
            invitee,
            inviter,
            &json!({"source":"invitation","invitedBy":inviter}),
        )? {
            true => Ok(InviteActivation::Activated),
            false => Ok(InviteActivation::AlreadyActive),
        }
    }

    fn activate_with_source(
        &self,
        user_id: &str,
        actor: &str,
        meta: &Value,
    ) -> Result<bool, String> {
        let now = now_ms();
        let audit_ws = self.audit_workspace_for(user_id);
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let state: Option<String> = tx
            .query_row(
                "SELECT state FROM user_access WHERE user_id=?1",
                params![user_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        match state.as_deref() {
            None => return Err("not_found".into()),
            Some("active") => return Ok(false),
            Some("suspended") => return Err("suspended".into()),
            _ => {}
        }
        tx.execute(
            "UPDATE user_access SET state='active',activated_at=?2,activated_by=?3,updated_at=?2 WHERE user_id=?1",
            params![user_id, now, actor],
        )
        .map_err(db_err)?;
        if let Some(ws) = &audit_ws {
            insert_audit(&tx, ws, actor, "access.activated", "user", user_id, meta)?;
        }
        tx.commit().map_err(db_err)?;
        Ok(true)
    }

    /// active → suspended. Returns false when already suspended.
    pub fn suspend_access(
        &self,
        user_id: &str,
        actor: &str,
        reason: Option<&str>,
    ) -> Result<bool, String> {
        let now = now_ms();
        let audit_ws = self.audit_workspace_for(user_id);
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let state: Option<String> = tx
            .query_row(
                "SELECT state FROM user_access WHERE user_id=?1",
                params![user_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        match state.as_deref() {
            None => return Err("not_found".into()),
            Some("suspended") => return Ok(false),
            _ => {}
        }
        tx.execute(
            "UPDATE user_access SET state='suspended',suspended_at=?2,suspended_by=?3,suspend_reason=?4,updated_at=?2 WHERE user_id=?1",
            params![user_id, now, actor, reason],
        )
        .map_err(db_err)?;
        if let Some(ws) = &audit_ws {
            insert_audit(
                &tx,
                ws,
                actor,
                "access.suspended",
                "user",
                user_id,
                &json!({"reason":reason}),
            )?;
        }
        tx.commit().map_err(db_err)?;
        Ok(true)
    }

    /// suspended → active. Returns false unless the user was suspended
    /// (a waitlisted user is activated, not reactivated).
    pub fn reactivate_access(&self, user_id: &str, actor: &str) -> Result<bool, String> {
        let now = now_ms();
        let audit_ws = self.audit_workspace_for(user_id);
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let changed = tx
            .execute(
                "UPDATE user_access SET state='active',suspended_at=NULL,suspended_by=NULL,suspend_reason=NULL,updated_at=?2 WHERE user_id=?1 AND state='suspended'",
                params![user_id, now],
            )
            .map_err(db_err)?;
        if changed == 0 {
            return Ok(false);
        }
        if let Some(ws) = &audit_ws {
            insert_audit(
                &tx,
                ws,
                actor,
                "access.reactivated",
                "user",
                user_id,
                &json!({}),
            )?;
        }
        tx.commit().map_err(db_err)?;
        Ok(true)
    }

    /// "What do you want to build?" from the waiting screen. Idempotent: the
    /// note is replaced, the row is never re-created or re-timestamped.
    pub fn request_access(&self, user_id: &str, note: Option<&str>) -> Result<(), String> {
        let note = note
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(|n| n.chars().take(2000).collect::<String>());
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.execute(
            "UPDATE user_access SET note=COALESCE(?2,note),updated_at=?3 WHERE user_id=?1",
            params![user_id, note, now_ms()],
        )
        .map_err(db_err)?;
        Ok(())
    }

    /// Admin listing: rows in `AccessRow` shape. `state=None` lists everyone.
    /// Waitlist first-come first-served (oldest request first); other states
    /// newest change first.
    pub fn access_rows(
        &self,
        state: Option<&str>,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<Value>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let order = match state {
            Some("waitlist") => "a.requested_at ASC",
            _ => "a.updated_at DESC",
        };
        let sql = format!(
            "SELECT {cols},u.email,u.full_name,\
             r.role,r.purpose,r.company,r.telegram,r.source,r.updated_at,\
             g.github_id,g.login,g.name,g.avatar_url,g.created_at,g.public_repos,g.followers,g.bio,g.blog,g.company,\
             gr.repo,gr.status,gr.error,gr.attempts \
             FROM user_access a JOIN users u ON u.user_id=a.user_id \
             LEFT JOIN access_registration r ON r.user_id=a.user_id \
             LEFT JOIN github_profiles g ON g.user_id=a.user_id \
             LEFT JOIN github_grants gr ON gr.user_id=a.user_id \
             WHERE (?1 IS NULL OR a.state=?1) ORDER BY {order} LIMIT ?2 OFFSET ?3",
            cols = ACCESS_COLUMNS
                .split(',')
                .map(|c| format!("a.{c}"))
                .collect::<Vec<_>>()
                .join(","),
        );
        let mut stmt = conn.prepare(&sql).map_err(db_err)?;
        let rows = stmt
            .query_map(params![state, limit as i64, offset as i64], |r| {
                let record = read_access_row(r)?;
                // Optional since identities: a Telegram-only account has no
                // address. Reading it as String turned that row into an Err,
                // which the filter_map below dropped from the admin list
                // without a trace.
                let email: Option<String> = r.get(ACCESS_COLUMN_COUNT)?;
                let full_name: Option<String> = r.get(ACCESS_COLUMN_COUNT + 1)?;
                Ok((record, email, full_name, joined_access_json(r)?))
            })
            .map_err(db_err)?
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        drop(stmt);
        let mut out = Vec::with_capacity(rows.len());
        for (record, email, full_name, joined) in rows {
            let mut v = json!({
                "userId": record.user_id,
                "state": record.state,
                "plan": record.plan,
                "requestedAt": record.requested_at,
                "seat": {"status": record.seat_status},
                "sandbox": {"status": record.sandbox_status},
            });
            for (key, value) in joined {
                v[key] = value;
            }
            // «Сбросить вход» is only meaningful for an account that signs in
            // with a local password; the admin UI keys its button on this.
            let local: bool = conn
                .query_row(
                    "SELECT 1 FROM identities WHERE provider=?1 AND user_id=?2",
                    params![crate::local_login::PROVIDER_LOCAL, record.user_id],
                    |_| Ok(true),
                )
                .optional()
                .map_err(db_err)?
                .unwrap_or(false);
            if local {
                v["localLogin"] = Value::Bool(true);
            }
            if let Some(e) = &email {
                v["email"] = Value::String(e.clone());
            }
            if let Some(n) = full_name {
                v["fullName"] = Value::String(n);
            }
            if let Some(n) = record.note {
                v["note"] = Value::String(n);
            }
            if let Some(at) = record.activated_at {
                v["activatedAt"] = json!(at);
            }
            if let Some(at) = record.suspended_at {
                v["suspendedAt"] = json!(at);
            }
            if let Some(r) = record.suspend_reason {
                v["suspendReason"] = Value::String(r);
            }
            if let Some(e) = record.seat_error {
                v["seat"]["error"] = Value::String(e);
            }
            if let Some(m) = record.sandbox_machine_id {
                v["sandbox"]["machineId"] = Value::String(m);
            }
            if let Some(slug) = record.sandbox_slug {
                v["sandbox"]["machineName"] = Value::String(sandbox_machine_name(&slug));
            }
            if let Some(h) = record.sandbox_host {
                v["sandbox"]["host"] = Value::String(h);
            }
            if let Some(e) = record.sandbox_error {
                v["sandbox"]["error"] = Value::String(e);
            }
            // Teams that asked for this person — an admin activates them first.
            let mut inv = conn
                .prepare(
                    "SELECT DISTINCT w.name FROM invitations i JOIN workspaces w ON w.workspace_id=i.workspace_id \
                     WHERE i.email=?1 AND (i.accepted_at IS NOT NULL OR i.expires_at>?2) ORDER BY w.name",
                )
                .map_err(db_err)?;
            // Invitations are addressed by email; an account without one
            // cannot have been asked for this way.
            let invited: Vec<String> = match &email {
                Some(email) => inv
                    .query_map(params![normalize_email(email), now_ms()], |r| r.get(0))
                    .map_err(db_err)?
                    .filter_map(Result::ok)
                    .collect(),
                None => Vec::new(),
            };
            if !invited.is_empty() {
                v["invitedTo"] = json!(invited);
            }
            out.push(v);
        }
        Ok(out)
    }

    /// `{waitlist, active, suspended}` totals for the admin page header.
    pub fn access_counts(&self) -> Result<Value, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare("SELECT state,COUNT(*) FROM user_access GROUP BY state")
            .map_err(db_err)?;
        let mut counts = json!({"waitlist":0,"active":0,"suspended":0});
        for row in stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .map_err(db_err)?
            .flatten()
        {
            counts[row.0] = json!(row.1);
        }
        Ok(counts)
    }

    /// User ids for a list of emails (lowercased). Unknown emails are absent
    /// from the result; the caller reports them as skipped.
    pub fn user_ids_by_email(&self, emails: &[String]) -> Result<Vec<(String, String)>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let mut out = Vec::new();
        for email in emails {
            let normalized = normalize_email(email);
            let id: Option<String> = conn
                .query_row(
                    "SELECT user_id FROM users WHERE email=?1",
                    params![normalized],
                    |r| r.get(0),
                )
                .optional()
                .map_err(db_err)?;
            if let Some(id) = id {
                out.push((id, normalized));
            }
        }
        Ok(out)
    }

    /// `None` for an unknown user AND for an account without an address.
    pub fn user_email(&self, user_id: &str) -> Option<String> {
        let conn = self.conn.lock().ok()?;
        conn.query_row(
            "SELECT email FROM users WHERE user_id=?1",
            params![user_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()
        .ok()
        .flatten()
        .flatten()
    }

    // ------------------------------------------------------- self-serve teams

    /// A member creates their own organization: active users only, capped per
    /// owner, name validated, slug transliterated with a suffix on collision.
    pub fn create_organization_self(&self, actor: &str, raw_name: &str) -> Result<Value, String> {
        if !self.is_active(actor) {
            return Err("access_not_active".into());
        }
        let name = normalize_team_name(raw_name)?;
        let cap = env_usize("CC_REMOTE_ORG_CAP_PER_USER", ORG_CAP_PER_USER_DEFAULT);
        let slug = {
            let conn = self
                .conn
                .lock()
                .map_err(|_| "workspace database lock poisoned".to_string())?;
            let owned: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM workspaces WHERE kind='organization' AND owner_user_id=?1",
                    params![actor],
                    |r| r.get(0),
                )
                .map_err(db_err)?;
            if owned as usize >= cap {
                return Err(format!("Можно создать не больше {cap} команд"));
            }
            let base = slugify(&name);
            let taken: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM workspaces WHERE slug=?1)",
                    params![base],
                    |r| r.get(0),
                )
                .map_err(db_err)?;
            if taken {
                let suffix = &Uuid::new_v4().simple().to_string()[..4];
                let head: String = base.chars().take(32 - 5).collect();
                format!("{}-{suffix}", head.trim_end_matches('-'))
            } else {
                base
            }
        };
        self.create_organization_inner(actor, &name, actor, Some(&slug))
    }

    /// Owner hands the team to a member: roles swap, `owner_user_id` follows.
    pub fn transfer_ownership(
        &self,
        actor: &str,
        workspace_id: &str,
        new_owner: &str,
    ) -> Result<(), String> {
        self.require_role(actor, workspace_id, &["owner"])?;
        if actor == new_owner {
            return Err("already the owner".into());
        }
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let kind: String = tx
            .query_row(
                "SELECT kind FROM workspaces WHERE workspace_id=?1",
                params![workspace_id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if kind != "organization" {
            return Err("a personal workspace cannot change hands".into());
        }
        let is_member: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM memberships WHERE workspace_id=?1 AND user_id=?2)",
                params![workspace_id, new_owner],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if !is_member {
            return Err("the new owner must already be a member".into());
        }
        tx.execute(
            "UPDATE memberships SET role='owner' WHERE workspace_id=?1 AND user_id=?2",
            params![workspace_id, new_owner],
        )
        .map_err(db_err)?;
        tx.execute(
            "UPDATE memberships SET role='member' WHERE workspace_id=?1 AND user_id=?2",
            params![workspace_id, actor],
        )
        .map_err(db_err)?;
        // Invitations the previous owner left outstanding were issued in their
        // name; they would otherwise let them (or whoever holds the link) walk
        // back in with a role the new owner never chose.
        tx.execute(
            "DELETE FROM invitations WHERE workspace_id=?1 AND created_by=?2 AND accepted_at IS NULL",
            params![workspace_id, actor],
        )
        .map_err(db_err)?;
        tx.execute(
            "UPDATE workspaces SET owner_user_id=?2 WHERE workspace_id=?1",
            params![workspace_id, new_owner],
        )
        .map_err(db_err)?;
        insert_audit(
            &tx,
            workspace_id,
            actor,
            "workspace.ownership_transferred",
            "member",
            new_owner,
            &json!({"from":actor,"to":new_owner}),
        )?;
        tx.commit().map_err(db_err)
    }

    /// The owner removes a non-owner, or a non-owner removes themselves
    /// (leave). The owner cannot leave — transfer first — and a personal
    /// workspace has no members to remove. Manager assignments naming the
    /// user in either role and their project shares in this workspace go too,
    /// so nothing keeps pointing at someone who is gone.
    pub fn remove_member(
        &self,
        actor: &str,
        workspace_id: &str,
        user_id: &str,
    ) -> Result<(), String> {
        let actor_role = self.require_member(actor, workspace_id)?;
        let leaving = actor == user_id;
        if !leaving && actor_role != "owner" {
            return Err("only the owner can remove members".into());
        }
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let kind: String = tx
            .query_row(
                "SELECT kind FROM workspaces WHERE workspace_id=?1",
                params![workspace_id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if kind != "organization" {
            return Err("a personal workspace has no members to remove".into());
        }
        let target_role: Option<String> = tx
            .query_row(
                "SELECT role FROM memberships WHERE workspace_id=?1 AND user_id=?2",
                params![workspace_id, user_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        match target_role.as_deref() {
            None => return Err("member not found".into()),
            Some("owner") => {
                return Err(if leaving {
                    "the owner cannot leave — transfer the team first".into()
                } else {
                    "the owner cannot be removed".into()
                })
            }
            _ => {}
        }
        remove_membership_rows(&tx, workspace_id, user_id)?;
        insert_audit(
            &tx,
            workspace_id,
            actor,
            if leaving {
                "membership.left"
            } else {
                "membership.removed"
            },
            "member",
            user_id,
            &json!({}),
        )?;
        tx.commit().map_err(db_err)
    }

    /// Owner deletes their organization. With other members still in it the
    /// caller must repeat the team's name; the foreign keys cascade the rest
    /// (memberships, invitations, shares, assignments, audit).
    pub fn delete_organization(
        &self,
        actor: &str,
        workspace_id: &str,
        confirm: Option<&str>,
    ) -> Result<(), String> {
        self.require_role(actor, workspace_id, &["owner"])?;
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let (kind, name): (String, String) = tx
            .query_row(
                "SELECT kind,name FROM workspaces WHERE workspace_id=?1",
                params![workspace_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(db_err)?;
        if kind != "organization" {
            return Err("a personal workspace cannot be deleted".into());
        }
        let members: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM memberships WHERE workspace_id=?1",
                params![workspace_id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if members > 1 && confirm.map(str::trim) != Some(name.as_str()) {
            return Err("В команде есть участники — чтобы удалить её, повторите название".into());
        }
        tx.execute(
            "DELETE FROM workspaces WHERE workspace_id=?1",
            params![workspace_id],
        )
        .map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        println!("[access] organization deleted: {name} ({workspace_id}) by {actor}, {members} member(s)");
        Ok(())
    }
}

impl WorkspaceStore {
    /// A machine asks to be connected. Unauthenticated by nature — the
    /// machine has no credential yet — so it is capped hub-wide and the
    /// caller caps it per address. Returns what the machine shows the
    /// person: the code, where to type it, and a poll token that is the
    /// machine's only handle on the request.
    pub fn request_enrollment(
        &self,
        machine: &Value,
        client_ip: Option<&str>,
    ) -> Result<Value, String> {
        let name = machine
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if machine
            .get("machineId")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        {
            return Err("machineId required".into());
        }
        if name.is_empty() {
            return Err("name required".into());
        }
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.execute(
            "DELETE FROM enrollment_requests WHERE expires_at < ?1",
            params![now - 60 * 60 * 1000],
        )
        .map_err(db_err)?;
        let open: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM enrollment_requests WHERE expires_at>?1 AND approved_at IS NULL AND denied_at IS NULL",
                params![now],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if open as usize >= ENROLL_REQUEST_OPEN_CAP {
            return Err("too many open requests — try again in a few minutes".into());
        }
        let poll_token = crate::workspace::opaque_token();
        // A code collision is a 32^8 event; the UNIQUE index turns it into a
        // retry rather than a wrong approval.
        for _ in 0..3 {
            let code = new_user_code();
            let inserted = conn.execute(
                "INSERT OR IGNORE INTO enrollment_requests(poll_hash,user_code_hash,machine_json,client_ip,created_at,expires_at) VALUES(?1,?2,?3,?4,?5,?6)",
                params![
                    crate::workspace::hash_token(&poll_token),
                    crate::workspace::hash_token(&normalize_user_code(&code)),
                    machine.to_string(),
                    client_ip,
                    now,
                    now + ENROLL_REQUEST_TTL_MS
                ],
            )
            .map_err(db_err)?;
            if inserted == 1 {
                return Ok(json!({
                    "userCode": code,
                    "pollToken": poll_token,
                    "expiresAt": now + ENROLL_REQUEST_TTL_MS,
                    "interval": ENROLL_REQUEST_POLL_SECS,
                }));
            }
        }
        Err("could not mint a code".into())
    }

    /// What `/link` shows before the person decides: the machine's own
    /// description of itself, where the request came from, and how long it
    /// has left. `None` for a code nobody minted.
    pub fn enrollment_request_info(&self, raw_code: &str) -> Result<Option<Value>, String> {
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let row: Option<(String, Option<String>, i64, i64, Option<i64>, Option<i64>, Option<i64>)> = conn
            .query_row(
                "SELECT machine_json,client_ip,created_at,expires_at,approved_at,denied_at,picked_at FROM enrollment_requests WHERE user_code_hash=?1",
                params![crate::workspace::hash_token(&normalize_user_code(raw_code))],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
            )
            .optional()
            .map_err(db_err)?;
        let Some((machine_json, ip, created_at, expires_at, approved_at, denied_at, picked_at)) =
            row
        else {
            return Ok(None);
        };
        let machine: Value = serde_json::from_str(&machine_json).unwrap_or(Value::Null);
        let state = if denied_at.is_some() {
            "denied"
        } else if picked_at.is_some() {
            "used"
        } else if approved_at.is_some() {
            "approved"
        } else if expires_at <= now {
            "expired"
        } else {
            "pending"
        };
        Ok(Some(json!({
            "state": state,
            "machine": {
                "name": machine.get("name").cloned().unwrap_or(Value::Null),
                "os": machine.get("os").cloned().unwrap_or(Value::Null),
                "agentVersion": machine.get("agentVersion").cloned().unwrap_or(Value::Null),
            },
            "clientIp": ip,
            "createdAt": created_at,
            "expiresAt": expires_at,
        })))
    }

    /// The person said yes. Enrolls the machine as theirs — the same device
    /// insert a typed code goes through, cap and owner check included — and
    /// parks the device token for the machine's next poll.
    pub fn approve_enrollment_request(&self, raw_code: &str, actor: &str) -> Result<Value, String> {
        if !self.is_active(actor) {
            return Err("access_not_active".into());
        }
        let now = now_ms();
        let audit_ws = self.audit_workspace_for(actor);
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let code_hash = crate::workspace::hash_token(&normalize_user_code(raw_code));
        let row: Option<(String, String, Option<String>)> = tx
            .query_row(
                "SELECT poll_hash,machine_json,client_ip FROM enrollment_requests WHERE user_code_hash=?1 AND approved_at IS NULL AND denied_at IS NULL AND expires_at>?2",
                params![code_hash, now],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(db_err)?;
        let Some((poll_hash, machine_json, ip)) = row else {
            return Err("код не найден или уже истёк — попросите машину показать новый".into());
        };
        let machine: Value = serde_json::from_str(&machine_json).map_err(|e| e.to_string())?;
        // The machineId in a request is whatever the asking process claimed:
        // `/api/enrollments/request` is unauthenticated by design. Approving
        // must never hand a NEW credential for a machine that already holds a
        // live one — that would revoke the real agent and let whoever asked
        // take its place (terminal, file RPC, runs, memory). A machine that
        // genuinely lost its token is re-linked after "отозвать" in Settings.
        if let Some(mid) = machine.get("machineId").and_then(Value::as_str) {
            if machine_has_live_credential(&tx, mid)? {
                return Err("эта машина уже подключена. Если её действительно нужно подключить заново — сначала отзовите её в Настройках → Устройства, потом повторите вход".into());
            }
        }
        let enrolled = self.enroll_device_tx(&tx, actor, "device", &machine, now)?;
        let token = enrolled["deviceToken"].as_str().unwrap_or("").to_string();
        let machine_id = enrolled["machineId"].as_str().unwrap_or("").to_string();
        tx.execute(
            "UPDATE enrollment_requests SET approved_by=?2,approved_at=?3,device_token=?4,machine_id=?5 WHERE poll_hash=?1",
            params![poll_hash, actor, now, token, machine_id],
        )
        .map_err(db_err)?;
        if let Some(ws) = &audit_ws {
            insert_audit(
                &tx,
                ws,
                actor,
                "device.enrolled",
                "machine",
                &machine_id,
                &json!({"source":"link","name":enrolled["name"],"os":machine.get("os"),"clientIp":ip}),
            )?;
        }
        tx.commit().map_err(db_err)?;
        Ok(json!({"machineId": machine_id, "name": enrolled["name"]}))
    }

    /// The person said no (or did not recognise the machine).
    pub fn deny_enrollment_request(&self, raw_code: &str, actor: &str) -> Result<bool, String> {
        // Same gate as `approve_enrollment_request`: denying is the other
        // decision on somebody's machine, and an account that may not decide
        // «yes» may not decide «no» either.
        if !self.is_active(actor) {
            return Err("access_not_active".into());
        }
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let n = conn
            .execute(
                "UPDATE enrollment_requests SET denied_at=?2 WHERE user_code_hash=?1 AND approved_at IS NULL AND denied_at IS NULL",
                params![crate::workspace::hash_token(&normalize_user_code(raw_code)), now],
            )
            .map_err(db_err)?;
        Ok(n == 1)
    }

    /// The machine asks how its request is doing. `approved` carries the
    /// device token exactly once; the next poll of the same request says
    /// `used`, so a token cannot be fetched twice by anyone holding the poll
    /// token later.
    pub fn poll_enrollment_request(&self, poll_token: &str) -> Result<Value, String> {
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let poll_hash = crate::workspace::hash_token(poll_token);
        let row: Option<(i64, Option<i64>, Option<i64>, Option<String>, Option<String>, Option<String>, Option<i64>)> = tx
            .query_row(
                "SELECT expires_at,approved_at,denied_at,device_token,machine_id,approved_by,picked_at FROM enrollment_requests WHERE poll_hash=?1",
                params![poll_hash],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
            )
            .optional()
            .map_err(db_err)?;
        let Some((expires_at, approved_at, denied_at, token, machine_id, approved_by, picked_at)) =
            row
        else {
            return Ok(json!({"status":"unknown"}));
        };
        if denied_at.is_some() {
            return Ok(json!({"status":"denied"}));
        }
        if picked_at.is_some() {
            return Ok(json!({"status":"used"}));
        }
        if approved_at.is_some() {
            if let Some(token) = token {
                tx.execute(
                    "UPDATE enrollment_requests SET device_token=NULL,picked_at=?2 WHERE poll_hash=?1",
                    params![poll_hash, now],
                )
                .map_err(db_err)?;
                tx.commit().map_err(db_err)?;
                return Ok(
                    json!({"status":"approved","deviceToken":token,"machineId":machine_id,"ownerUserId":approved_by}),
                );
            }
            return Ok(json!({"status":"used"}));
        }
        if expires_at <= now {
            return Ok(json!({"status":"expired"}));
        }
        Ok(json!({"status":"pending","expiresAt":expires_at,"interval":ENROLL_REQUEST_POLL_SECS}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_access_state_follows_the_edition_unless_set() {
        // internal: exactly as before, vouched or not
        for vouched in [false, true] {
            assert_eq!(access_state_for(None, false, vouched), "waitlist");
            assert_eq!(access_state_for(Some("active"), false, vouched), "active");
            assert_eq!(
                access_state_for(Some("anything"), false, vouched),
                "waitlist"
            );
        }
        // external: only a vouched account opens by itself
        assert_eq!(access_state_for(None, true, true), "active");
        assert_eq!(access_state_for(None, true, false), "waitlist");
        // the explicit variable still wins
        assert_eq!(access_state_for(Some("waitlist"), true, true), "waitlist");
        assert_eq!(access_state_for(Some("active"), true, false), "active");
    }
    use crate::workspace::WorkspaceStore;

    fn raw_state(s: &WorkspaceStore, user: &str) -> (String, String) {
        s.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT state,plan FROM user_access WHERE user_id=?1",
                params![user],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap()
    }

    /// The abandoned cohort column, read straight from the table: nothing in
    /// the code touches it any more, and the backfill's marks must survive.
    fn raw_wave(s: &WorkspaceStore, user: &str) -> Option<String> {
        s.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT wave FROM user_access WHERE user_id=?1",
                params![user],
                |r| r.get(0),
            )
            .unwrap()
    }

    fn audit_meta(s: &WorkspaceStore, action: &str, target: &str) -> String {
        s.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT metadata_json FROM audit_events WHERE action=?1 AND target_id=?2",
                params![action, target],
                |r| r.get(0),
            )
            .unwrap()
    }

    fn audit_count(s: &WorkspaceStore, action: &str, target: &str) -> i64 {
        s.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM audit_events WHERE action=?1 AND target_id=?2",
                params![action, target],
                |r| r.get(0),
            )
            .unwrap()
    }

    /// Fresh SSO users wait; everyone who was already here is an employee and
    /// notices nothing. The backfill runs once, keyed in schema_meta.
    #[test]
    fn first_login_lands_on_the_waitlist_and_backfill_keeps_employees_active() {
        let s = WorkspaceStore::open_memory();
        // A pre-rollout database: users without access rows, backfill not yet run.
        {
            let conn = s.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO users(user_id,email,created_at) VALUES('old','old@x',1)",
                [],
            )
            .unwrap();
            conn.execute("DELETE FROM schema_meta WHERE key='access_backfill'", [])
                .unwrap();
        }
        s.init().unwrap();
        assert_eq!(raw_state(&s, "old"), ("active".into(), "employee".into()));
        // The cohort column is history now, but the backfill's mark is still
        // in the table — this is the regression test for "we kept the column".
        assert_eq!(raw_wave(&s, "old").as_deref(), Some("legacy"));
        // Running init again must not touch anyone (the key is set), and
        // neither does the employee's next SSO login (OR IGNORE).
        s.init().unwrap();
        s.ensure_user("old", "old@x", Some("Old Hand")).unwrap();
        assert_eq!(raw_state(&s, "old").0, "active");

        assert!(
            !s.ensure_user("new", "new@x", Some("New Person"))
                .unwrap()
                .claimed_preauth,
            "nothing to claim"
        );
        let (state, plan) = raw_state(&s, "new");
        assert_eq!((state.as_str(), plan.as_str()), ("waitlist", "community"));
        let access = s.ui_access("new", None, false).unwrap();
        assert!(!access.is_active());
        assert_eq!(access.viewer["access"]["state"], "waitlist");
        assert_eq!(access.viewer["access"]["plan"], "community");
        assert_eq!(access.viewer["access"]["deviceCap"], 2);
        assert!(
            access.viewer["access"].get("activatedAt").is_none(),
            "optional = absent, never null"
        );
        // A second login does not reset the row.
        s.ensure_user("new", "new@x", None).unwrap();
        assert_eq!(raw_state(&s, "new").0, "waitlist");
        // Employees carry their plan into the viewer.
        let old = s.ui_access("old", None, false).unwrap();
        assert!(old.is_active());
        assert_eq!(old.viewer["access"]["plan"], "employee");
        assert_eq!(old.viewer["access"]["deviceCap"], 10);
    }

    #[test]
    fn activation_is_idempotent_and_writes_one_audit_row() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("admin", "admin@x", None).unwrap();
        s.ensure_user("u", "u@x", None).unwrap();
        assert!(s.activate_access("u", "admin").unwrap());
        assert!(
            !s.activate_access("u", "admin").unwrap(),
            "second call is a no-op"
        );
        assert_eq!(audit_count(&s, "access.activated", "u"), 1);
        assert!(audit_meta(&s, "access.activated", "u").contains("\"source\":\"admin\""));
        let rec = s.access_state("u").unwrap();
        assert_eq!(rec.state, "active");
        assert!(rec.activated_at.is_some());
        assert!(s.is_active("u"));

        // Suspend / reactivate mirror it, each with its own single audit row.
        assert!(s.suspend_access("u", "admin", Some("abuse")).unwrap());
        assert!(!s.suspend_access("u", "admin", None).unwrap());
        assert_eq!(s.access_state("u").unwrap().state, "suspended");
        assert_eq!(
            s.access_state("u").unwrap().suspend_reason.as_deref(),
            Some("abuse")
        );
        assert!(!s.is_active("u"));
        assert_eq!(s.activate_access("u", "admin").unwrap_err(), "suspended");
        assert!(s.reactivate_access("u", "admin").unwrap());
        assert!(!s.reactivate_access("u", "admin").unwrap());
        assert!(s.is_active("u"));
        assert_eq!(audit_count(&s, "access.suspended", "u"), 1);
        assert_eq!(audit_count(&s, "access.reactivated", "u"), 1);
        assert_eq!(
            s.activate_access("ghost", "admin").unwrap_err(),
            "not_found"
        );

        // The waiting-screen note is stored and never re-timestamps the row.
        let before = s.access_state("u").unwrap().requested_at;
        s.request_access("u", Some("  a chat bot  ")).unwrap();
        s.request_access("u", None).unwrap();
        let after = s.access_state("u").unwrap();
        assert_eq!(after.note.as_deref(), Some("a chat bot"));
        assert_eq!(after.requested_at, before);
    }

    /// The gate itself is exercised through the store: the bootstrap owner and
    /// platform admins pass whatever their row says.
    #[test]
    fn require_active_refuses_waitlist_and_suspended_but_not_admins() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("admin", "admin@x", None).unwrap();
        s.ensure_user("w", "w@x", None).unwrap();
        s.ensure_user("x", "x@x", None).unwrap();
        s.set_always_active(["admin".to_string()]);
        // The admin's raw row is waitlist (fresh DB), yet they are active/employee.
        assert_eq!(raw_state(&s, "admin").0, "waitlist");
        let admin = s.access_state("admin").unwrap();
        assert_eq!(
            (admin.state.as_str(), admin.plan.as_str()),
            ("active", "employee")
        );
        assert!(s.is_active("admin"));
        assert!(!s.is_active("w"));
        s.activate_access("x", "admin").unwrap();
        s.suspend_access("x", "admin", None).unwrap();
        assert!(!s.is_active("x"));
        assert_eq!(crate::access_gate_state(&s, "w").unwrap_err(), "waitlist");
        assert_eq!(crate::access_gate_state(&s, "x").unwrap_err(), "suspended");
        assert!(crate::access_gate_state(&s, "admin").is_ok());
        // An unknown user is refused, never let through by a missing row.
        assert_eq!(
            crate::access_gate_state(&s, "nobody").unwrap_err(),
            "waitlist"
        );
        // Self-serve creation is gated at the store too.
        assert_eq!(
            s.create_organization_self("w", "Team").unwrap_err(),
            "access_not_active"
        );
    }

    #[test]
    fn self_serve_org_respects_the_owned_cap_and_name_rules() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("u", "u@x", None).unwrap();
        s.activate_access("u", "admin").unwrap();
        assert!(s.create_organization_self("u", "x").is_err(), "too short");
        assert!(
            s.create_organization_self("u", &"я".repeat(49)).is_err(),
            "too long"
        );
        assert!(
            s.create_organization_self("u", "Bad\u{7}name").is_err(),
            "control char"
        );
        let a = s
            .create_organization_self("u", "  Команда   Орлов  ")
            .unwrap();
        assert_eq!(a["name"], "Команда Орлов", "whitespace collapsed");
        assert_eq!(a["slug"], "komanda-orlov");
        assert_eq!(a["selfServe"], true);
        let b = s.create_organization_self("u", "Команда Орлов").unwrap();
        let slug_b = b["slug"].as_str().unwrap();
        assert!(
            slug_b.starts_with("komanda-orlov-") && slug_b.len() == "komanda-orlov-".len() + 4,
            "collision gets a 4-hex suffix: {slug_b}"
        );
        s.create_organization_self("u", "Third").unwrap();
        assert_eq!(
            s.create_organization_self("u", "Fourth").unwrap_err(),
            "Можно создать не больше 3 команд"
        );
        // The viewer lists them with slug + selfServe; admin-made ones without.
        s.create_organization("u", "Admin made", "u").unwrap();
        let ws = s.workspaces("u").unwrap();
        let self_serve = ws.iter().filter(|w| w["selfServe"] == true).count();
        assert_eq!(self_serve, 3);
        let admin_made = ws.iter().find(|w| w["name"] == "Admin made").unwrap();
        assert!(admin_made.get("slug").is_none() && admin_made.get("selfServe").is_none());
        // Slug edge cases.
        assert_eq!(slugify("!!!"), "team");
        // Letters with no mapping act as separators, never as silent joins.
        assert_eq!(slugify("Ünïcode — dash  test"), "n-code-dash-test");
        assert!(slugify(&"a".repeat(80)).len() <= 32);
    }

    #[test]
    fn invite_refuses_past_the_member_cap() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("o", "o@x", None).unwrap();
        let w = s.create_organization("o", "Small", "o").unwrap();
        let wid = w["workspaceId"].as_str().unwrap();
        s.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE workspaces SET member_cap=3 WHERE workspace_id=?1",
                params![wid],
            )
            .unwrap();
        // owner (1) + two pending = 3 = cap.
        s.invite("o", wid, "a@x", "member").unwrap();
        s.invite("o", wid, "b@x", "member").unwrap();
        assert_eq!(
            s.invite("o", wid, "c@x", "member").unwrap_err(),
            MEMBER_CAP_ERR
        );
        // An expired invitation frees its slot.
        s.conn
            .lock()
            .unwrap()
            .execute("UPDATE invitations SET expires_at=1 WHERE email='b@x'", [])
            .unwrap();
        s.invite("o", wid, "c@x", "member").unwrap();
    }

    #[test]
    fn invitation_never_demotes_owner_and_transfer_drops_old_invitations() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("o", "o@x", None).unwrap();
        s.ensure_user("m", "m@x", None).unwrap();
        let w = s.create_organization("o", "Team", "o").unwrap();
        let wid = w["workspaceId"].as_str().unwrap();
        // The owner invites their own address and accepts: refused, still owner.
        let self_inv = s.invite("o", wid, "o@x", "manager").unwrap();
        let err = s
            .accept_invitation("o", self_inv["token"].as_str().unwrap())
            .unwrap_err();
        assert!(err.contains("already own"), "{err}");
        let role_of = |s: &WorkspaceStore, who: &str| -> String {
            s.members("o", wid)
                .unwrap()
                .iter()
                .find(|m| m["userId"] == who)
                .map(|m| m["role"].as_str().unwrap().to_string())
                .unwrap_or_default()
        };
        assert_eq!(role_of(&s, "o"), "owner");
        // An invitation left behind by the owner dies with the hand-over.
        let stale = s.invite("o", wid, "o@x", "manager").unwrap();
        let inv = s.invite("o", wid, "m@x", "member").unwrap();
        s.accept_invitation("m", inv["token"].as_str().unwrap())
            .unwrap();
        s.transfer_ownership("o", wid, "m").unwrap();
        assert!(s
            .accept_invitation("o", stale["token"].as_str().unwrap())
            .is_err());
        assert_eq!(role_of(&s, "o"), "member");
        assert_eq!(role_of(&s, "m"), "owner");
    }

    #[test]
    fn ownership_transfer_then_leave() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("o", "o@x", None).unwrap();
        s.ensure_user("m", "m@x", None).unwrap();
        let w = s.create_organization("o", "Team", "o").unwrap();
        let wid = w["workspaceId"].as_str().unwrap();
        // The owner cannot leave, and cannot hand the team to a stranger.
        assert!(s.remove_member("o", wid, "o").is_err());
        assert!(
            s.transfer_ownership("o", wid, "m").is_err(),
            "not a member yet"
        );
        let inv = s.invite("o", wid, "m@x", "member").unwrap();
        s.accept_invitation("m", inv["token"].as_str().unwrap())
            .unwrap();
        // A member cannot remove anyone else.
        assert!(s.remove_member("m", wid, "o").is_err());
        s.transfer_ownership("o", wid, "m").unwrap();
        let roles: Vec<(String, String)> = s
            .members("m", wid)
            .unwrap()
            .iter()
            .map(|m| {
                (
                    m["userId"].as_str().unwrap().into(),
                    m["role"].as_str().unwrap().into(),
                )
            })
            .collect();
        assert!(roles.contains(&("m".into(), "owner".into())));
        assert!(roles.contains(&("o".into(), "member".into())));
        let owner_col: String = s
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT owner_user_id FROM workspaces WHERE workspace_id=?1",
                params![wid],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(owner_col, "m");
        assert_eq!(audit_count(&s, "workspace.ownership_transferred", "m"), 1);
        // Now the old owner leaves; their share in this team goes with them.
        s.register_legacy_device(
            "o",
            &json!({"machineId":"box","name":"B","os":"linux","agentVersion":"1"}),
        )
        .unwrap();
        s.share_project("o", wid, "box", "/repo", "Repo", "control", "team")
            .unwrap();
        s.remove_member("o", wid, "o").unwrap();
        assert!(s.members("o", wid).is_err(), "no longer a member");
        assert!(s.projects("m", wid).unwrap().is_empty());
        assert_eq!(audit_count(&s, "membership.left", "o"), 1);
        // Personal workspaces are untouchable.
        assert!(s.remove_member("m", "personal:m", "m").is_err());
        assert!(s.transfer_ownership("m", "personal:m", "o").is_err());
    }

    #[test]
    fn delete_refuses_with_members_unless_confirmed() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("o", "o@x", None).unwrap();
        s.ensure_user("m", "m@x", None).unwrap();
        let w = s.create_organization("o", "Doomed", "o").unwrap();
        let wid = w["workspaceId"].as_str().unwrap();
        let inv = s.invite("o", wid, "m@x", "member").unwrap();
        s.accept_invitation("m", inv["token"].as_str().unwrap())
            .unwrap();
        assert!(
            s.delete_organization("m", wid, Some("Doomed")).is_err(),
            "members cannot delete"
        );
        assert!(s.delete_organization("o", wid, None).is_err());
        assert!(s.delete_organization("o", wid, Some("wrong")).is_err());
        s.delete_organization("o", wid, Some(" Doomed ")).unwrap();
        assert!(s
            .workspaces("m")
            .unwrap()
            .iter()
            .all(|w| w["workspaceId"] != wid));
        let left: i64 = s
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM memberships WHERE workspace_id=?1",
                params![wid],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(left, 0, "FK cascade cleaned the memberships");
        // Alone, no confirmation is needed; personal is refused.
        let solo = s.create_organization("o", "Solo", "o").unwrap();
        s.delete_organization("o", solo["workspaceId"].as_str().unwrap(), None)
            .unwrap();
        assert!(s
            .delete_organization("o", "personal:o", Some("Моя работа"))
            .is_err());
    }

    #[test]
    fn sandbox_enrollment_marks_the_device_and_skips_the_cap() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("u", "u@x", None).unwrap(); // community: cap 2
        let enroll = |s: &WorkspaceStore, purpose: &str, id: &str| {
            let code = s.create_enrollment_for("u", purpose).unwrap();
            s.exchange_enrollment(
                code["code"].as_str().unwrap(),
                &json!({"machineId":id,"name":id,"os":"linux","agentVersion":"1"}),
            )
        };
        let sb = enroll(&s, "sandbox", "sb-u").unwrap();
        assert_eq!(sb["kind"], "sandbox");
        assert_eq!(s.device_kind("sb-u").unwrap().as_deref(), Some("sandbox"));
        assert_eq!(enroll(&s, "device", "laptop").unwrap()["kind"], "personal");
        enroll(&s, "device", "desktop").unwrap();
        // Third personal device: over the community cap; the sandbox never counted.
        assert_eq!(
            enroll(&s, "device", "third").unwrap_err(),
            "Лимит устройств: 2 — отзовите старое в Настройках"
        );
        // Re-enrolling an existing one costs nothing.
        enroll(&s, "device", "laptop").unwrap();
        // Revoking frees a slot.
        s.revoke_device("u", "desktop").unwrap();
        enroll(&s, "device", "third").unwrap();
        // Employees get the bigger cap.
        s.ensure_user("e", "e@x", None).unwrap();
        s.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE user_access SET plan='employee' WHERE user_id='e'",
                [],
            )
            .unwrap();
        for i in 0..10 {
            let code = s.create_enrollment_for("e", "sandbox").unwrap();
            s.exchange_enrollment(
                code["code"].as_str().unwrap(),
                &json!({"machineId":format!("s{i}"),"name":"x","os":"linux","agentVersion":"1"}),
            )
            .unwrap();
        }
        let code = s.create_enrollment_for("e", "sandbox").unwrap();
        assert!(
            s.exchange_enrollment(
                code["code"].as_str().unwrap(),
                &json!({"machineId":"s-extra","name":"x","os":"linux","agentVersion":"1"})
            )
            .is_ok(),
            "sandboxes are never capped"
        );
    }

    #[test]
    fn enrollment_rate_limit_is_per_hour() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("u", "u@x", None).unwrap();
        for _ in 0..ENROLLMENTS_PER_HOUR {
            s.create_enrollment("u").unwrap();
        }
        assert_eq!(s.create_enrollment("u").unwrap_err(), ENROLLMENT_RATE_ERR);
        // Sandbox codes are minted by the hub itself and are not counted.
        s.create_enrollment_for("u", "sandbox").unwrap();
        assert_eq!(s.create_enrollment("u").unwrap_err(), ENROLLMENT_RATE_ERR);
        // Codes older than an hour fall out of the window.
        s.conn
            .lock()
            .unwrap()
            .execute("UPDATE enrollments SET created_at=created_at-3700000", [])
            .unwrap();
        s.create_enrollment("u").unwrap();
    }

    #[test]
    fn admin_rows_carry_counts_and_invitations() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("o", "o@x", Some("Owner")).unwrap();
        s.activate_access("o", "admin").unwrap();
        s.ensure_user("w", "w@x", None).unwrap();
        let team = s.create_organization("o", "Alpha", "o").unwrap();
        s.invite("o", team["workspaceId"].as_str().unwrap(), "W@x", "member")
            .unwrap();
        let counts = s.access_counts().unwrap();
        assert_eq!(counts["waitlist"], 1);
        assert_eq!(counts["active"], 1);
        let rows = s.access_rows(Some("waitlist"), 50, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["userId"], "w");
        assert_eq!(rows[0]["invitedTo"], json!(["Alpha"]));
        assert!(rows[0].get("fullName").is_none());
        assert!(rows[0].get("localLogin").is_none());
        crate::identity::link(
            &s.conn.lock().unwrap(),
            crate::local_login::PROVIDER_LOCAL,
            "w@x",
            "w",
            1,
        )
        .unwrap();
        let rows = s.access_rows(Some("waitlist"), 50, 0).unwrap();
        assert_eq!(rows[0]["localLogin"], json!(true));
        let all = s.access_rows(None, 50, 0).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(
            s.user_ids_by_email(&["W@X".into(), "nobody@x".into()])
                .unwrap(),
            vec![("w".to_string(), "w@x".to_string())]
        );
    }

    /// The whole point of a pre-authorization: an address nobody has signed in
    /// The reverse enrollment, end to end at the store: the machine asks,
    /// `/api/enrollments/request` takes the machineId on trust. Approving a
    /// request for a machine that is already connected must not mint it a new
    /// credential (and silently revoke the real agent's); after the owner
    /// revokes the device, re-linking works again.
    #[test]
    fn link_approval_refuses_a_machine_that_is_already_connected() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("owner", "owner@x", None).unwrap();
        s.activate_access("owner", "tests").unwrap();
        let machine = json!({"machineId":"m-live","name":"buildbox-pc","os":"windows","agentVersion":"0.4.0"});

        let first = s.request_enrollment(&machine, None).unwrap();
        s.approve_enrollment_request(first["userCode"].as_str().unwrap(), "owner")
            .unwrap();
        let real = s
            .poll_enrollment_request(first["pollToken"].as_str().unwrap())
            .unwrap()["deviceToken"]
            .as_str()
            .unwrap()
            .to_string();

        // Someone else asks for the same machineId; the owner clicks "yes".
        let second = s.request_enrollment(&machine, None).unwrap();
        let err = s
            .approve_enrollment_request(second["userCode"].as_str().unwrap(), "owner")
            .unwrap_err();
        assert!(err.contains("уже подключена"), "{err}");
        assert!(
            s.device_credential(&real).unwrap().is_some(),
            "the real agent keeps its credential"
        );
        assert_eq!(
            s.poll_enrollment_request(second["pollToken"].as_str().unwrap())
                .unwrap()["status"],
            "pending",
            "nothing is handed to the second asker"
        );

        // Genuine recovery: revoke first, then re-link.
        s.revoke_device("owner", "m-live").unwrap();
        let third = s.request_enrollment(&machine, None).unwrap();
        s.approve_enrollment_request(third["userCode"].as_str().unwrap(), "owner")
            .expect("a revoked machine can be linked again");
    }

    /// the person approves, the machine gets its token ONCE.
    #[test]
    fn a_machine_request_is_approved_once_and_polled_once() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("owner", "owner@x", None).unwrap();
        s.activate_access("owner", "tests").unwrap();
        let machine =
            json!({"machineId":"m-link-1","name":"prod-eu-1","os":"linux","agentVersion":"0.3.3"});

        let req = s.request_enrollment(&machine, Some("203.0.113.5")).unwrap();
        let code = req["userCode"].as_str().unwrap().to_string();
        let poll = req["pollToken"].as_str().unwrap().to_string();
        assert_eq!(code.len(), 9, "XXXX-XXXX");
        assert_eq!(
            s.poll_enrollment_request(&poll).unwrap()["status"],
            "pending"
        );

        let info = s
            .enrollment_request_info(&code.to_lowercase().replace('-', " "))
            .unwrap()
            .unwrap();
        assert_eq!(info["state"], "pending");
        assert_eq!(info["machine"]["name"], "prod-eu-1");
        assert_eq!(info["clientIp"], "203.0.113.5");
        assert!(s.enrollment_request_info("ZZZZ-ZZZZ").unwrap().is_none());

        // A waitlisted person cannot approve anything.
        s.ensure_user("wait", "wait@x", None).unwrap();
        assert!(s.approve_enrollment_request(&code, "wait").is_err());

        let ok = s.approve_enrollment_request(&code, "owner").unwrap();
        assert_eq!(ok["machineId"], "m-link-1");
        assert!(
            s.approve_enrollment_request(&code, "owner").is_err(),
            "a code is spent by its approval"
        );
        assert_eq!(audit_count(&s, "device.enrolled", "m-link-1"), 1);

        let first = s.poll_enrollment_request(&poll).unwrap();
        assert_eq!(first["status"], "approved");
        let token = first["deviceToken"].as_str().unwrap().to_string();
        assert_eq!(first["ownerUserId"], "owner");
        assert_eq!(
            s.poll_enrollment_request(&poll).unwrap()["status"],
            "used",
            "the token is handed out once"
        );
        let cred = s
            .device_credential(&token)
            .unwrap()
            .expect("the token opens the socket");
        assert_eq!(cred.machine_id, "m-link-1");
        assert_eq!(cred.user_id, "owner");

        // Denied and expired are words, not silence.
        let req2 = s
            .request_enrollment(
                &json!({"machineId":"m-link-2","name":"laptop","os":"mac"}),
                None,
            )
            .unwrap();
        assert!(s
            .deny_enrollment_request(req2["userCode"].as_str().unwrap(), "owner")
            .unwrap());
        assert_eq!(
            s.poll_enrollment_request(req2["pollToken"].as_str().unwrap())
                .unwrap()["status"],
            "denied"
        );
        let req3 = s
            .request_enrollment(
                &json!({"machineId":"m-link-3","name":"old","os":"linux"}),
                None,
            )
            .unwrap();
        s.conn
            .lock()
            .unwrap()
            .execute("UPDATE enrollment_requests SET expires_at=1", [])
            .unwrap();
        assert_eq!(
            s.poll_enrollment_request(req3["pollToken"].as_str().unwrap())
                .unwrap()["status"],
            "expired"
        );
        assert!(s
            .approve_enrollment_request(req3["userCode"].as_str().unwrap(), "owner")
            .is_err());
        assert_eq!(
            s.poll_enrollment_request("no-such-token").unwrap()["status"],
            "unknown"
        );
    }

    /// Accepting an invitation from an active owner opens access — within
    /// that owner's monthly share, never for a suspended person, never from an
    /// inviter who is not active themselves.
    #[test]
    fn accepting_an_invitation_activates_within_the_inviters_share() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("owner", "owner@x", None).unwrap();
        s.activate_access("owner", "tests").unwrap();
        let org = s.create_organization_self("owner", "Team").unwrap();
        let ws = org["workspaceId"].as_str().unwrap().to_string();

        // Two waitlisted invitees, a share of one.
        s.ensure_user("a", "a@x", None).unwrap();
        s.ensure_user("b", "b@x", None).unwrap();
        let inv_a = s.invite("owner", &ws, "a@x", "member").unwrap();
        let (_, inviter) = s
            .accept_invitation("a", inv_a["token"].as_str().unwrap())
            .unwrap();
        assert_eq!(inviter, "owner", "acceptance names who invited");
        assert_eq!(
            s.activate_by_invitation("a", &inviter, 1).unwrap(),
            InviteActivation::Activated
        );
        assert!(s.is_active("a"));
        assert!(audit_meta(&s, "access.activated", "a").contains("\"source\":\"invitation\""));
        assert_eq!(
            s.activate_by_invitation("a", "owner", 1).unwrap(),
            InviteActivation::AlreadyActive
        );

        let inv_b = s.invite("owner", &ws, "b@x", "member").unwrap();
        s.accept_invitation("b", inv_b["token"].as_str().unwrap())
            .unwrap();
        assert_eq!(
            s.activate_by_invitation("b", "owner", 1).unwrap(),
            InviteActivation::CapReached
        );
        assert!(
            !s.is_active("b"),
            "the second one waits for an admin — in the team, not activated"
        );
        assert_eq!(
            s.activate_by_invitation("b", "owner", 2).unwrap(),
            InviteActivation::Activated
        );

        // A suspended person is not un-suspended by a teammate's link.
        s.ensure_user("c", "c@x", None).unwrap();
        s.activate_access("c", "tests").unwrap();
        s.suspend_access("c", "tests", None).unwrap();
        assert_eq!(
            s.activate_by_invitation("c", "owner", 10).unwrap(),
            InviteActivation::Suspended
        );

        // Nor does an inviter who lost access hand it out.
        s.ensure_user("d", "d@x", None).unwrap();
        s.suspend_access("owner", "tests", None).unwrap();
        assert_eq!(
            s.activate_by_invitation("d", "owner", 10).unwrap(),
            InviteActivation::InviterInactive
        );
    }

    /// with is active from the first read after that first login — never
    /// waitlisted for a moment — and the trail says which admin opened it.
    #[test]
    fn preauthorized_email_activates_at_first_login() {
        let s = WorkspaceStore::open_memory();
        let (created, row) = s
            .preauthorize("  New@X ", "admin", Some("друг Владельца"), "community")
            .unwrap();
        assert!(created);
        assert_eq!(row["email"], "new@x", "normalized on the way in");
        assert_eq!(row["note"], "друг Владельца");

        assert!(
            s.ensure_user("u1", "New@X", Some("New Person"))
                .unwrap()
                .claimed_preauth,
            "claimed"
        );
        assert_eq!(raw_state(&s, "u1"), ("active".into(), "community".into()));
        assert!(s.is_active("u1"));
        let rec = s.access_state("u1").unwrap();
        assert!(rec.activated_at.is_some());
        assert_eq!(audit_count(&s, "access.activated", "u1"), 1);
        let meta = audit_meta(&s, "access.activated", "u1");
        assert!(meta.contains("\"source\":\"preauthorization\""), "{meta}");

        // The promise is spent: it leaves the pending list and a second login
        // neither re-claims it nor writes a second audit row.
        assert!(s.pending_preauthorizations().unwrap().is_empty());
        assert!(!s.ensure_user("u1", "new@x", None).unwrap().claimed_preauth);
        assert_eq!(audit_count(&s, "access.activated", "u1"), 1);
    }

    #[test]
    fn preauthorization_is_idempotent_and_revocable() {
        let s = WorkspaceStore::open_memory();
        assert!(
            s.preauthorize("a@x", "admin", Some("first"), "community")
                .unwrap()
                .0
        );
        let (created, row) = s
            .preauthorize("A@X", "admin", Some("second"), "community")
            .unwrap();
        assert!(!created, "already waiting");
        assert_eq!(
            row["note"], "first",
            "an earlier admin's note is not rewritten"
        );
        assert_eq!(s.pending_preauthorizations().unwrap().len(), 1);

        assert!(s.revoke_preauthorization("A@X", "admin").unwrap());
        assert!(
            !s.revoke_preauthorization("a@x", "admin").unwrap(),
            "already gone"
        );
        assert!(s.pending_preauthorizations().unwrap().is_empty());
        // Revoked means revoked: the next login is an ordinary first login.
        assert!(!s.ensure_user("u2", "a@x", None).unwrap().claimed_preauth);
        assert_eq!(raw_state(&s, "u2").0, "waitlist");
    }

    /// A promise never overrides a decision already made about an account,
    /// and a claimed one cannot be taken back — the verb for that is suspend.
    #[test]
    fn a_claim_never_overrides_an_active_or_suspended_row() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("u", "u@x", None).unwrap();
        s.activate_access("u", "admin").unwrap();
        s.suspend_access("u", "admin", Some("abuse")).unwrap();
        s.preauthorize("u@x", "admin", None, "community").unwrap();
        assert!(
            !s.ensure_user("u", "u@x", None).unwrap().claimed_preauth,
            "suspended stays suspended"
        );
        assert_eq!(raw_state(&s, "u").0, "suspended");
        assert_eq!(
            s.pending_preauthorizations().unwrap().len(),
            1,
            "promise untouched"
        );

        // And a claimed one is not revocable.
        s.preauthorize("v@x", "admin", None, "community").unwrap();
        assert!(s.ensure_user("v", "v@x", None).unwrap().claimed_preauth);
        assert!(!s.revoke_preauthorization("v@x", "admin").unwrap());
    }

    /// Keyed on the address, not on "is this a first login": `users.email`
    /// follows HegAI, so someone already waiting is let in at the next login
    /// after their address is opened.
    #[test]
    fn a_waitlisted_user_claims_a_preauthorization_at_their_next_login() {
        let s = WorkspaceStore::open_memory();
        assert!(!s.ensure_user("u", "u@x", None).unwrap().claimed_preauth);
        assert_eq!(raw_state(&s, "u").0, "waitlist");
        s.preauthorize("u@x", "admin", None, "community").unwrap();
        assert!(s.ensure_user("u", "u@x", None).unwrap().claimed_preauth);
        assert_eq!(raw_state(&s, "u"), ("active".into(), "community".into()));
    }

    /// An employee pre-authorization carries its plan, so a new hire does not
    /// burn a gateway seat and a hosted sandbox they have no use for
    /// (`after_activate_hooks` returns early for a non-community plan).
    #[test]
    fn a_preauthorized_employee_keeps_their_plan() {
        let s = WorkspaceStore::open_memory();
        s.preauthorize("hire@x", "admin", None, "employee").unwrap();
        assert!(s.ensure_user("h", "hire@x", None).unwrap().claimed_preauth);
        assert_eq!(raw_state(&s, "h"), ("active".into(), "employee".into()));
        assert_eq!(s.access_state("h").unwrap().plan, "employee");
    }

    #[test]
    fn seat_key_is_the_email_or_a_synthetic_address_only_on_a_self_hosted_hub() {
        use crate::edition::{with_edition, Edition};
        assert_eq!(
            seat_key_for("u1", Some(" A@X.io ")).as_deref(),
            Some("A@X.io")
        );
        with_edition(Edition::Internal, || {
            assert_eq!(seat_key_for("tg-abc", None), None);
        });
        with_edition(Edition::External, || {
            assert_eq!(
                seat_key_for("tg-abc", None).as_deref(),
                Some("tg-abc@users.invalid")
            );
            assert_eq!(
                seat_key_for("u2", Some("TG-X@users.invalid")).as_deref(),
                Some("u2@users.invalid"),
                "a stored synthetic-domain address is not a real mailbox"
            );
            assert_eq!(
                seat_key_for("gh-ABC", None).as_deref(),
                Some("gh-abc@users.invalid"),
                "any account without an e-mail"
            );
        });
    }

    #[test]
    fn the_seat_sweep_lists_unrequested_seats_only_when_asked() {
        use crate::edition::{with_edition, Edition};
        let s = WorkspaceStore::open_memory();
        s.ensure_user("m", "m@x", None).unwrap();
        s.activate_access("m", "tests").unwrap();
        assert_eq!(s.access_state("m").unwrap().seat_status, "none");
        assert!(s.seats_needing_work(5, false).unwrap().is_empty());
        // Not in a team yet: no seat is requested.
        assert!(!s.is_team_member("m"));
        assert!(s.seats_needing_work(5, true).unwrap().is_empty());
        s.create_organization("m", "Team", "m").unwrap();
        assert!(s.is_team_member("m"));
        let rows = s.seats_needing_work(5, true).unwrap();
        assert_eq!(rows, vec![("m".to_string(), "m@x".to_string())]);
        s.set_seat_status("m", "ready", None).unwrap();
        assert!(s.seats_needing_work(5, true).unwrap().is_empty());
        // A Telegram-only member is listed with the synthetic key on a
        // self-hosted hub, and skipped elsewhere.
        s.with_conn_for_tests(|c| {
            c.execute("INSERT INTO users(user_id,email,created_at) VALUES('tg-1',NULL,1)", [])
                .unwrap();
            c.execute(
                "INSERT INTO user_access(user_id,state,plan,requested_at,updated_at) VALUES('tg-1','active','community',1,1)",
                [],
            )
            .unwrap();
            c.execute(
                "INSERT INTO memberships(workspace_id,user_id,role,created_at) SELECT workspace_id,'tg-1','member',1 FROM workspaces WHERE kind<>'personal' LIMIT 1",
                [],
            )
            .unwrap();
        });
        with_edition(Edition::Internal, || {
            assert!(s.seats_needing_work(5, true).unwrap().is_empty());
        });
        with_edition(Edition::External, || {
            assert_eq!(
                s.seats_needing_work(5, true).unwrap(),
                vec![("tg-1".to_string(), "tg-1@users.invalid".to_string())]
            );
        });
    }
}
