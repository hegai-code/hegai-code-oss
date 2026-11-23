//! Signing in with Telegram, through @Hegaicodebot.
//!
//! The shape is the device flow «Подключить машину» already uses
//! (`enrollment_requests`): the client asks for a login, gets a code for the
//! bot and a poll secret it keeps, and polls; the person proves who they are
//! by pressing a button in Telegram. Telegram vouches for `from.id` on every
//! update the bot receives — that numeric id is the identity. A username is
//! only a label: it can be released and taken by someone else, so nothing
//! here ever matches on it.
//!
//! 1. `start` — a code (goes to Telegram in `t.me/<bot>?start=login_<code>`),
//!    a poll token (never leaves the client), and a two-digit MATCH number the
//!    client shows on its screen. Only hashes of code and token are stored.
//! 2. `peek` — the bot saw `/start login_<code>`; the login is bound to that
//!    Telegram account (first one wins) and the bot shows what is about to
//!    happen, with three numbers to choose from.
//! 3. `decide` — the same Telegram account pressed a number (or «Это не я»).
//!    The WRONG number kills the login. Approving a sign-in resolves
//!    `('telegram', id)` through `identities`, or creates an account on the
//!    waitlist for a stranger.
//! 4. `poll` — the client picks the result up once; the handler mints the
//!    session there, so a session token never passes through the bot.
//!
//! Why the number. A device flow is phishable by construction: an attacker
//! starts a login and sends the victim the `t.me` link, and the victim's
//! press signs the ATTACKER in. The card alone cannot stop that — the victim
//! sees their own account named on it, which reassures rather than warns.
//! The number is on the screen of whoever started the login, so a victim who
//! did not start one has nothing to match, and two presses in three kill it.
//!
//! Linking (a signed-in person adds Telegram to their own account) has a
//! second step on purpose: the bot's approval only PROPOSES the link; it is
//! made by `finish_telegram_link`, called from inside the account that asked,
//! after it was shown which `@username` pressed. Whoever sees the code first
//! (a shared screen, a QR over a shoulder) could otherwise press first and
//! attach their Telegram to someone else's account for good.
//!
//! What this does NOT decide: whether the person may use the product. A new
//! account lands where every new account lands (`default_access_state`), and
//! the access gate is untouched. Every account may have Telegram as a way
//! in, platform admins and the hub's owner included (the owner's decision of
//! 09.10.2026: one person, one account, every way in).
//!
//! A Telegram account that already opens ANOTHER account (an empty one its
//! first sign-in created) is moved by a confirmed link — `identity::attach`
//! — unless that account holds anything of its own.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::identity;
use crate::workspace::{db_err, hash_token, insert_audit, now_ms, opaque_token, WorkspaceStore};

pub(crate) const PROVIDER_TELEGRAM: &str = "telegram";
/// How long a started login waits for the button.
const TTL_MS: i64 = 10 * 60 * 1000;
/// How long past `expires_at` an APPROVED login can still be collected by its
/// poller (the person may confirm in Telegram at minute 9 and switch back later).
const PICKUP_GRACE_MS: i64 = 10 * 60 * 1000;
/// Unfinished logins hub-wide; past it `start` refuses instead of growing.
const OPEN_CAP: i64 = 500;
/// Unfinished logins per client address: a person retrying fits, one
/// address filling the hub-wide cap for everyone does not.
const OPEN_PER_IP: i64 = 5;
/// What the client is told to wait between polls.
pub(crate) const POLL_SECS: i64 = 2;
/// How long a completed login stays for the undo: the longest session it mints.
const UNDO_WINDOW_MS: i64 = 90 * 24 * 60 * 60 * 1000;
/// Items of the «Проверьте» list kept in an undo answer (one more is read, so
/// `truncated` is exact).
const REVIEW_MAX: i64 = 50;
/// How long a fetched notice is held for the bot before it is handed out again.
const NOTICE_LEASE_MS: i64 = 60 * 1000;
/// A sign-in older than this is no longer announced (a bot that was down).
const NOTICE_WINDOW_MS: i64 = 30 * 60 * 1000;
/// Longest name kept from Telegram's first/last name.
const NAME_MAX: usize = 80;
/// Numbers on the card. One is on the client's screen; a blind press is
/// right one time in this many.
const CHOICES: usize = 5;
/// After a wrong number, how long that Telegram account cannot open another
/// login: a phisher's second and third link just do not open.
const WRONG_MATCH_LOCK_MS: i64 = 30 * 60 * 1000;

pub(crate) fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        -- One row per «Войти через Telegram». Only hashes of the code and of the
        -- poll token are kept; the row dies with its TTL and is swept an hour
        -- later. `telegram_id` is bound at the first peek: from then on only
        -- that Telegram account can decide it. `match_code` is the number the
        -- client shows — a confirmation, not a secret.
        CREATE TABLE IF NOT EXISTS telegram_logins (
          poll_hash         TEXT PRIMARY KEY,
          code_hash         TEXT NOT NULL UNIQUE,
          match_code        TEXT NOT NULL,
          -- The three numbers the card offers, fixed at start: were they drawn
          -- again on every peek, opening the link twice would show the right
          -- one as the only number both cards share.
          choices           TEXT NOT NULL,
          link_user_id      TEXT,
          client            TEXT NOT NULL,
          device            TEXT,
          client_ip         TEXT,
          -- What the per-address cap counts: the IPv4 address, or the IPv6 /64.
          -- `client_ip` keeps the full address for the audit trail.
          rate_key          TEXT,
          created_at        INTEGER NOT NULL,
          expires_at        INTEGER NOT NULL,
          telegram_id       TEXT,
          telegram_username TEXT,
          telegram_name     TEXT,
          approved_at       INTEGER,
          denied_at         INTEGER,
          -- Why it died: 'not_me', 'wrong_match', 'claimed_by_other'. A wrong
          -- number locks that Telegram account out of new logins for a while.
          denied_reason     TEXT,
          user_id           TEXT,
          created_account   INTEGER NOT NULL DEFAULT 0,
          picked_at         INTEGER
        );
        "#,
    )
    .map_err(db_err)?;
    // «Новый вход»: which session a pickup minted, and whether the bot has been
    // told. Additive and idempotent, like `mfa::migrate_session_columns`.
    for (column, ddl) in [
        (
            "session_hash",
            "ALTER TABLE telegram_logins ADD COLUMN session_hash TEXT",
        ),
        (
            "notified_at",
            "ALTER TABLE telegram_logins ADD COLUMN notified_at INTEGER",
        ),
        // The undo is single-use: when it ran, and the answer it gave.
        // A notice handed to the bot is leased; it counts as delivered only
        // when the bot acknowledges it.
        (
            "leased_until",
            "ALTER TABLE telegram_logins ADD COLUMN leased_until INTEGER",
        ),
        (
            "undone_at",
            "ALTER TABLE telegram_logins ADD COLUMN undone_at INTEGER",
        ),
        (
            "undone_result",
            "ALTER TABLE telegram_logins ADD COLUMN undone_result TEXT",
        ),
    ] {
        let present: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('telegram_logins') WHERE name=?1",
                params![column],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if present == 0 {
            conn.execute(ddl, []).map_err(db_err)?;
        }
    }
    Ok(())
}

/// What «Это был не я» did, for the caller: the answer for the bot, and what
/// the hub must drop from memory (`fresh` is false for a repeated press).
#[derive(Debug)]
pub(crate) struct UndoOutcome {
    pub body: Value,
    pub user_id: String,
    pub since_ms: i64,
    pub live_tokens: Vec<String>,
    pub fresh: bool,
}

/// The Telegram account behind an update, as the bot saw it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TgUser {
    pub id: i64,
    pub username: Option<String>,
    /// First + last name, trimmed; `None` when empty.
    pub name: Option<String>,
}

impl TgUser {
    pub fn new(id: i64, username: Option<&str>, first: Option<&str>, last: Option<&str>) -> Self {
        let clean = |s: Option<&str>| s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let name = [clean(first), clean(last)]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");
        let name: String = name.chars().take(NAME_MAX).collect();
        Self {
            id,
            username: clean(username).map(|u| u.trim_start_matches('@').to_string()),
            name: (!name.is_empty()).then_some(name),
        }
    }

    pub(crate) fn subject(&self) -> String {
        self.id.to_string()
    }
}

/// What a person recognises a Telegram account by: `@username`, else the id.
fn label(username: Option<&str>, id: &str) -> String {
    match username {
        Some(u) => format!("@{u}"),
        None => format!("tg:{id}"),
    }
}

/// What the person pressed on the card.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Press {
    /// One of the numbers; only the one on the client's screen approves.
    Number(String),
    /// «Это не я».
    NotMe,
}

/// Session length by client kind — the same split `sso_callback` makes.
pub(crate) fn session_days(client: &str) -> i64 {
    if client == "web" {
        7
    } else {
        90
    }
}

/// A random two-digit number, 10–99. The OS RNG behind UUID v4.
fn two_digits() -> String {
    let b = Uuid::new_v4();
    let n = u16::from_le_bytes([b.as_bytes()[0], b.as_bytes()[1]]) % 90 + 10;
    n.to_string()
}

/// The right number and `CHOICES - 1` others, in a random order.
fn choices(right: &str) -> Vec<String> {
    let mut out = vec![right.to_string()];
    while out.len() < CHOICES {
        let n = two_digits();
        if !out.contains(&n) {
            out.push(n);
        }
    }
    let pos = (Uuid::new_v4().as_bytes()[0] as usize) % CHOICES;
    out.swap(0, pos);
    out
}

/// A login row as `peek`/`decide`/`finish` need it.
struct Row {
    match_code: String,
    choices: String,
    link_user_id: Option<String>,
    client: String,
    device: Option<String>,
    client_ip: Option<String>,
    created_at: i64,
    expires_at: i64,
    telegram_id: Option<String>,
    telegram_username: Option<String>,
    approved_at: Option<i64>,
    denied_at: Option<i64>,
    user_id: Option<String>,
    picked_at: Option<i64>,
}

const ROW_COLUMNS: &str =
    "match_code,choices,link_user_id,client,device,client_ip,created_at,expires_at,\
    telegram_id,telegram_username,approved_at,denied_at,user_id,picked_at";

fn read_row_where(conn: &Connection, column: &str, hash: &str) -> Result<Option<Row>, String> {
    conn.query_row(
        &format!("SELECT {ROW_COLUMNS} FROM telegram_logins WHERE {column}=?1"),
        params![hash],
        |r| {
            Ok(Row {
                match_code: r.get(0)?,
                choices: r.get(1)?,
                link_user_id: r.get(2)?,
                client: r.get(3)?,
                device: r.get(4)?,
                client_ip: r.get(5)?,
                created_at: r.get(6)?,
                expires_at: r.get(7)?,
                telegram_id: r.get(8)?,
                telegram_username: r.get(9)?,
                approved_at: r.get(10)?,
                denied_at: r.get(11)?,
                user_id: r.get(12)?,
                picked_at: r.get(13)?,
            })
        },
    )
    .optional()
    .map_err(db_err)
}

/// `Err` with a stable code the API maps to a status and the bot to words.
fn check_open(row: &Row, tg: &TgUser, now: i64) -> Result<(), String> {
    // A SECOND Telegram account comes first: it must reach — and kill — a
    // login that is already approved but not yet picked up by its client, or
    // a stranger who pressed the number off someone's screen a second earlier
    // would still win the race.
    let other = row
        .telegram_id
        .as_ref()
        .is_some_and(|bound| *bound != tg.subject());
    if other && row.denied_at.is_none() && row.picked_at.is_none() {
        return Err("claimed_by_other".into());
    }
    if row.approved_at.is_some() || row.denied_at.is_some() {
        return Err("decided".into());
    }
    if row.expires_at <= now {
        return Err("expired".into());
    }
    if row
        .telegram_id
        .as_ref()
        .is_some_and(|bound| *bound != tg.subject())
    {
        return Err("claimed_by_other".into());
    }
    Ok(())
}

fn row_code_hash(conn: &Connection, poll_hash: &str) -> Result<String, String> {
    conn.query_row(
        "SELECT code_hash FROM telegram_logins WHERE poll_hash=?1",
        params![poll_hash],
        |r| r.get(0),
    )
    .map_err(db_err)
}

/// Did this Telegram account press a wrong number within the lock window?
fn is_locked(conn: &Connection, telegram_id: &str, now: i64) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM telegram_logins WHERE telegram_id=?1 \
         AND denied_reason='wrong_match' AND denied_at>?2)",
        params![telegram_id, now - WRONG_MATCH_LOCK_MS],
        |r| r.get(0),
    )
    .map_err(db_err)
}

/// End a login for good, with the reason on the row.
fn kill(conn: &Connection, code_hash: &str, now: i64, reason: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE telegram_logins SET denied_at=?2,denied_reason=?3 WHERE code_hash=?1",
        params![code_hash, now, reason],
    )
    .map_err(db_err)?;
    Ok(())
}

/// When a SECOND Telegram account reaches a login already bound to another,
/// the login dies: two people holding one code means one of them saw someone
/// else's screen, and letting the first presser win would sign the screen's
/// owner into the presser's account. Returns the error for the caller to
/// commit and return (a transaction commits by value).
fn check_open_or_kill(
    tx: &rusqlite::Transaction,
    row: &Row,
    code_hash: &str,
    tg: &TgUser,
    now: i64,
) -> Result<(), (String, bool)> {
    match check_open(row, tg, now) {
        Err(e) if e == "claimed_by_other" => {
            kill(tx, code_hash, now, "claimed_by_other").map_err(|db| (db, false))?;
            Err((e, true))
        }
        Err(e) => Err((e, false)),
        Ok(()) => Ok(()),
    }
}

/// Name, then address, then id — the same order as `displayName` on the web.
fn account_summary(conn: &Connection, user_id: &str) -> Result<Value, String> {
    let (email, full_name): (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT email,full_name FROM users WHERE user_id=?1",
            params![user_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(db_err)?
        .unwrap_or((None, None));
    let state: Option<String> = conn
        .query_row(
            "SELECT state FROM user_access WHERE user_id=?1",
            params![user_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_err)?;
    let display = full_name
        .or(email)
        .unwrap_or_else(|| format!("Участник {}", user_id.chars().take(6).collect::<String>()));
    Ok(
        json!({"userId": user_id, "displayName": display, "state": state.unwrap_or_else(|| "active".into())}),
    )
}

/// A fresh account for a Telegram-only person: no address, a hub-owned id
/// that can never collide with a platform UUID, the personal workspace every
/// account has, and the access state every new account gets.
fn create_account(conn: &Connection, tg: &TgUser, now: i64) -> Result<String, String> {
    let user_id = format!("tg-{}", Uuid::new_v4().simple());
    let personal = format!("personal:{user_id}");
    conn.execute(
        "INSERT INTO users(user_id,email,full_name,created_at) VALUES(?1,NULL,?2,?3)",
        params![user_id, tg.name, now],
    )
    .map_err(db_err)?;
    conn.execute(
        "INSERT OR IGNORE INTO workspaces(workspace_id,name,kind,owner_user_id,created_at) VALUES(?1,'Моя работа','personal',?2,?3)",
        params![personal, user_id, now],
    )
    .map_err(db_err)?;
    conn.execute(
        "INSERT OR IGNORE INTO memberships(workspace_id,user_id,role,created_at) VALUES(?1,?2,'owner',?3)",
        params![personal, user_id, now],
    )
    .map_err(db_err)?;
    conn.execute(
        "INSERT OR IGNORE INTO user_access(user_id,state,plan,requested_at,updated_at) VALUES(?1,?2,'community',?3,?3)",
        params![user_id, crate::access::new_account_state(false), now],
    )
    .map_err(db_err)?;
    Ok(user_id)
}

/// A live invitation addressed to a Telegram username.
struct TgInvite {
    id: String,
    workspace_id: String,
    role: String,
    created_by: String,
}

/// Pending, unexpired invitations for `username` (case-insensitive; stored
/// lowercase), oldest first.
fn pending_telegram_invites(
    conn: &Connection,
    username: Option<&str>,
    now: i64,
) -> Result<Vec<TgInvite>, String> {
    let Some(name) = username.map(|u| u.trim().trim_start_matches('@').to_ascii_lowercase()) else {
        return Ok(Vec::new());
    };
    if name.is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare(
            "SELECT invitation_id,workspace_id,role,created_by FROM invitations \
             WHERE telegram_username=?1 AND accepted_at IS NULL AND expires_at>?2 \
             ORDER BY created_at",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![name, now], |r| {
            Ok(TgInvite {
                id: r.get(0)?,
                workspace_id: r.get(1)?,
                role: r.get(2)?,
                created_by: r.get(3)?,
            })
        })
        .map_err(db_err)?
        .filter_map(Result::ok)
        .collect();
    Ok(rows)
}

fn inviter_is_active(conn: &Connection, inviter: &str) -> bool {
    conn.query_row(
        "SELECT state FROM user_access WHERE user_id=?1",
        params![inviter],
        |r| r.get::<_, String>(0),
    )
    .map(|s| s == "active")
    .unwrap_or(false)
}

/// Join `user_id` to the invitations' teams (never changing an owner's role),
/// mark them accepted and audit it like the e-mail path. Opens access for an
/// account that was waiting. Returns whether access was opened here.
fn accept_telegram_invites(
    tx: &Connection,
    user_id: &str,
    invites: &[TgInvite],
    now: i64,
) -> Result<bool, String> {
    for inv in invites {
        let existing_role: Option<String> = tx
            .query_row(
                "SELECT role FROM memberships WHERE workspace_id=?1 AND user_id=?2",
                params![inv.workspace_id, user_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        if existing_role.as_deref() == Some("owner") {
            // Already the owner: the invitation is used up, nothing changes.
            tx.execute(
                "UPDATE invitations SET accepted_by=?2,accepted_at=?3,created_membership=0 WHERE invitation_id=?1",
                params![inv.id, user_id, now],
            )
            .map_err(db_err)?;
            continue;
        }
        // An invitation never lowers an existing member's role (a manager
        // invited as «member» stays a manager); a raise is audited like any
        // other role change.
        let rank = |r: &str| if r == "manager" { 1 } else { 0 };
        match existing_role.as_deref() {
            None => {
                tx.execute(
                    "INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?1,?2,?3,?4)",
                    params![inv.workspace_id, user_id, inv.role, now],
                )
                .map_err(db_err)?;
            }
            Some(from) if rank(&inv.role) > rank(from) => {
                tx.execute(
                    "UPDATE memberships SET role=?3 WHERE workspace_id=?1 AND user_id=?2 AND role<>'owner'",
                    params![inv.workspace_id, user_id, inv.role],
                )
                .map_err(db_err)?;
                insert_audit(
                    tx,
                    &inv.workspace_id,
                    &inv.created_by,
                    "membership.role_changed",
                    "member",
                    user_id,
                    &json!({"role": inv.role, "from": from, "via": "invitation"}),
                )?;
            }
            Some(_) => {}
        }
        tx.execute(
            "UPDATE invitations SET accepted_by=?2,accepted_at=?3,created_membership=?4 WHERE invitation_id=?1",
            params![inv.id, user_id, now, i64::from(existing_role.is_none())],
        )
        .map_err(db_err)?;
        insert_audit(
            tx,
            &inv.workspace_id,
            user_id,
            "invitation.accepted",
            "invitation",
            &inv.id,
            &json!({"via": "telegram"}),
        )?;
    }
    let state: Option<String> = tx
        .query_row(
            "SELECT state FROM user_access WHERE user_id=?1",
            params![user_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_err)?;
    let waiting = !matches!(state.as_deref(), Some("active") | Some("suspended") | None);
    if !waiting {
        return Ok(false);
    }
    // Opening access is the inviter's monthly allowance, same as an e-mail
    // invitation: over the cap the person joins the team but waits for an admin.
    let cap = crate::access::invite_activation_cap();
    let mut inviter = None;
    for inv in invites {
        if !crate::access::invite_cap_reached(tx, &inv.created_by, cap)? {
            inviter = Some(&inv.created_by);
            break;
        }
    }
    let Some(inviter) = inviter else {
        if let Some(ws) = crate::access::audit_workspace_in(tx, user_id)? {
            insert_audit(
                tx,
                &ws,
                &invites[0].created_by,
                "access.activation_refused",
                "user",
                user_id,
                &json!({"source": "invitation", "via": "telegram", "reason": "invite_cap"}),
            )?;
        }
        return Ok(false);
    };
    tx.execute(
        "UPDATE user_access SET state='active',activated_at=?2,activated_by=?3,updated_at=?2 WHERE user_id=?1",
        params![user_id, now, inviter],
    )
    .map_err(db_err)?;
    if let Some(ws) = crate::access::audit_workspace_in(tx, user_id)? {
        insert_audit(
            tx,
            &ws,
            inviter,
            "access.activated",
            "user",
            user_id,
            &json!({"source": "invitation", "invitedBy": inviter, "via": "telegram"}),
        )?;
    }
    Ok(true)
}

/// Link `('telegram', id)` to `user_id` and stamp its label.
fn link_telegram(
    conn: &Connection,
    subject: &str,
    username: Option<&str>,
    user_id: &str,
    now: i64,
) -> Result<(), String> {
    identity::link(conn, PROVIDER_TELEGRAM, subject, user_id, now)?;
    conn.execute(
        "UPDATE identities SET label=?3 WHERE provider=?1 AND subject=?2",
        params![PROVIDER_TELEGRAM, subject, label(username, subject)],
    )
    .map_err(db_err)?;
    Ok(())
}

impl WorkspaceStore {
    /// Begin a login. `link_user` is set when a signed-in person is adding
    /// Telegram to their own account; `None` is a plain sign-in.
    pub fn start_telegram_login(
        &self,
        link_user: Option<&str>,
        client: &str,
        device: &str,
        client_ip: Option<&str>,
        rate_key: Option<&str>,
    ) -> Result<Value, String> {
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        // Unfinished and denied logins go an hour after they lapse. A COMPLETED
        // one (it minted a session) is kept — its `session_hash`, undo reference
        // and consumed marker are what «Это был не я» needs — for the longest
        // session it could have minted.
        conn.execute(
            "DELETE FROM telegram_logins WHERE (session_hash IS NULL AND expires_at < ?1) \
             OR (session_hash IS NOT NULL AND COALESCE(picked_at,expires_at) < ?2)",
            params![now - 60 * 60 * 1000, now - UNDO_WINDOW_MS],
        )
        .map_err(db_err)?;
        let open_where = "expires_at>?1 AND approved_at IS NULL AND denied_at IS NULL";
        let open: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM telegram_logins WHERE {open_where}"),
                params![now],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if open >= OPEN_CAP {
            return Err("too many open logins — try again in a few minutes".into());
        }
        if let Some(ip) = rate_key {
            let mine: i64 = conn
                .query_row(
                    &format!(
                        "SELECT COUNT(*) FROM telegram_logins WHERE {open_where} AND rate_key=?2"
                    ),
                    params![now, ip],
                    |r| r.get(0),
                )
                .map_err(db_err)?;
            if mine >= OPEN_PER_IP {
                return Err("too many open logins from this address — finish one first".into());
            }
        }
        // 128 random bits, hex: fits Telegram's `start` parameter (≤64 chars
        // of [A-Za-z0-9_-]) with the `login_` prefix.
        let code = Uuid::new_v4().simple().to_string();
        let poll_token = opaque_token();
        let match_code = two_digits();
        let offered = serde_json::to_string(&choices(&match_code)).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO telegram_logins(poll_hash,code_hash,match_code,choices,link_user_id,client,device,client_ip,rate_key,created_at,expires_at) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                hash_token(&poll_token),
                hash_token(&code),
                match_code,
                offered,
                link_user,
                client,
                device,
                client_ip,
                rate_key,
                now,
                now + TTL_MS
            ],
        )
        .map_err(db_err)?;
        Ok(json!({
            "code": code,
            "pollToken": poll_token,
            "match": match_code,
            "expiresAt": now + TTL_MS,
            "interval": POLL_SECS,
        }))
    }

    /// The bot saw `/start login_<code>` from `tg`. Binds the login to that
    /// Telegram account and says what pressing would do, with the numbers to
    /// choose from.
    pub fn peek_telegram_login(&self, code: &str, tg: &TgUser) -> Result<Value, String> {
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let code_hash = hash_token(code);
        let row = read_row_where(&tx, "code_hash", &code_hash)?.ok_or("unknown")?;
        // Pressed a wrong number recently: no new login opens for this
        // Telegram account for a while (the phishing retry stops here).
        if is_locked(&tx, &tg.subject(), now)? {
            return Err("locked".into());
        }
        if let Err((e, killed)) = check_open_or_kill(&tx, &row, &code_hash, tg, now) {
            if killed {
                tx.commit().map_err(db_err)?;
            }
            return Err(e);
        }
        tx.execute(
            "UPDATE telegram_logins SET telegram_id=?2,telegram_username=?3,telegram_name=?4 \
             WHERE code_hash=?1 AND (telegram_id IS NULL OR telegram_id=?2)",
            params![code_hash, tg.subject(), tg.username, tg.name],
        )
        .map_err(db_err)?;
        let mut out = json!({
            "intent": if row.link_user_id.is_some() { "link" } else { "login" },
            "client": row.client,
            "sessionDays": session_days(&row.client),
            "choices": serde_json::from_str::<Value>(&row.choices).unwrap_or_else(|_| json!([])),
            "createdAt": row.created_at,
            "expiresAt": row.expires_at,
        });
        if let Some(d) = row.device {
            out["device"] = Value::String(d);
        }
        // No address on the card: whoever opens a code they saw on someone
        // else's screen would learn that person's IP from it.
        // Which account a SIGN-IN will open. A LINK names the account it
        // attaches to (`linkTo`, its display name only), and — when this
        // Telegram opens another account now — that it will move from there
        // (`willMove` + `moveFrom`; `moveBlocked` when that account holds work
        // and the link will be refused). The person in Telegram must know
        // which account they are giving their Telegram to.
        let holder = identity::resolve(&tx, PROVIDER_TELEGRAM, &tg.subject())?;
        match (&row.link_user_id, holder) {
            (None, Some(uid)) => out["account"] = account_summary(&tx, &uid)?,
            (None, None) => {}
            (Some(target), holder) => {
                out["linkTo"] =
                    json!({"displayName": account_summary(&tx, target)?["displayName"]});
                if let Some(from) = holder.filter(|h| h != target) {
                    out["moveFrom"] =
                        json!({"displayName": account_summary(&tx, &from)?["displayName"]});
                    if identity::account_has_data(&tx, &from)? {
                        out["moveBlocked"] = json!(true);
                    } else {
                        out["willMove"] = json!(true);
                        // Closed only when Telegram is its last way in.
                        let ways: i64 = tx
                            .query_row(
                                "SELECT count(*) FROM identities WHERE user_id=?1",
                                params![from],
                                |r| r.get(0),
                            )
                            .map_err(db_err)?;
                        if ways <= 1 {
                            out["willClose"] = json!(true);
                        }
                    }
                }
            }
        }
        tx.commit().map_err(db_err)?;
        Ok(out)
    }

    /// The press. A number that is not the client's kills the login, like
    /// «Это не я». Approving a sign-in resolves or creates the account; the
    /// session itself is minted by `poll`, on the client's side. Approving a
    /// LINK only proposes it — `finish_telegram_link` makes it.
    pub fn decide_telegram_login(
        &self,
        code: &str,
        tg: &TgUser,
        press: &Press,
    ) -> Result<Value, String> {
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let code_hash = hash_token(code);
        let row = read_row_where(&tx, "code_hash", &code_hash)?.ok_or("unknown")?;
        if let Err((e, killed)) = check_open_or_kill(&tx, &row, &code_hash, tg, now) {
            if killed {
                tx.commit().map_err(db_err)?;
            }
            return Err(e);
        }
        // A button only exists on a card the bot sent after a peek, which
        // bound the login. A press with nothing bound is not the bot's flow.
        if row.telegram_id.is_none() {
            return Err("not_peeked".into());
        }
        // Cards opened BEFORE a wrong press still have live buttons; the lock
        // must hold there too, or a phisher's several links are several
        // blind tries. «Это не я» stays available.
        if matches!(press, Press::Number(_)) && is_locked(&tx, &tg.subject(), now)? {
            kill(&tx, &code_hash, now, "wrong_match")?;
            tx.commit().map_err(db_err)?;
            return Err("locked".into());
        }
        match press {
            Press::NotMe => {
                kill(&tx, &code_hash, now, "not_me")?;
                tx.commit().map_err(db_err)?;
                return Ok(json!({"status": "denied"}));
            }
            Press::Number(n) if *n != row.match_code => {
                kill(&tx, &code_hash, now, "wrong_match")?;
                tx.commit().map_err(db_err)?;
                return Err("wrong_match".into());
            }
            Press::Number(_) => {}
        }
        let subject = tg.subject();
        let existing = identity::resolve(&tx, PROVIDER_TELEGRAM, &subject)?;

        if let Some(target) = &row.link_user_id {
            // A proposal only: checked now so the person hears «no» in
            // Telegram, and checked again when the account confirms. A
            // Telegram account that opens an EMPTY other account may be
            // moved here (`identity::attach`); one whose account holds work
            // may not.
            if let Some(holder) = existing.as_ref().filter(|h| *h != target) {
                if identity::account_has_data(&tx, holder)? {
                    // Dead for the client too, not «pending» for ten minutes.
                    kill(&tx, &code_hash, now, identity::OWNER_HAS_DATA)?;
                    tx.commit().map_err(db_err)?;
                    return Err(identity::OWNER_HAS_DATA.into());
                }
            }
            tx.execute(
                "UPDATE telegram_logins SET approved_at=?2,user_id=?3 WHERE code_hash=?1",
                params![code_hash, now, target],
            )
            .map_err(db_err)?;
            tx.commit().map_err(db_err)?;
            return Ok(json!({"status": "approved", "intent": "link"}));
        }

        // An owner may have invited this @username: the first sign-in then
        // joins the team (and, for a newcomer, opens access) instead of
        // waiting on the waitlist.
        let invites: Vec<TgInvite> = if crate::edition::is_external() {
            pending_telegram_invites(&tx, tg.username.as_deref(), now)?
        } else {
            Vec::new()
        }
        .into_iter()
        .filter(|i| self.is_privileged(&i.created_by) || inviter_is_active(&tx, &i.created_by))
        .collect();
        let (user_id, created) = match existing {
            Some(holder) => (holder, false),
            None => (create_account(&tx, tg, now)?, true),
        };
        let mut invite_outcome = None;
        if !invites.is_empty() {
            invite_outcome = Some(accept_telegram_invites(&tx, &user_id, &invites, now)?);
        }
        link_telegram(&tx, &subject, tg.username.as_deref(), &user_id, now)?;
        tx.execute(
            "UPDATE telegram_logins SET approved_at=?2,user_id=?3,created_account=?4 WHERE code_hash=?1",
            params![code_hash, now, user_id, created as i64],
        )
        .map_err(db_err)?;
        if let Some(ws) = crate::access::audit_workspace_in(&tx, &user_id)? {
            insert_audit(
                &tx,
                &ws,
                &user_id,
                "auth.telegram",
                "user",
                &user_id,
                &json!({
                    "telegramId": subject,
                    "username": tg.username,
                    "client": row.client,
                    "ip": row.client_ip,
                    "created": created,
                }),
            )?;
        }
        let account = account_summary(&tx, &user_id)?;
        tx.commit().map_err(db_err)?;
        let mut out = json!({"status": "approved", "intent": "login", "created": created, "account": account});
        if let Some(activated) = invite_outcome {
            // The handler runs the post-activation hooks (seat, sandbox).
            out["invitationJoined"] = json!(true);
            out["invitationActivated"] = json!(activated);
        }
        Ok(out)
    }

    /// The client's side. A sign-in's `approved` is handed out exactly once,
    /// with what the handler needs to mint the session. A link answers
    /// `confirm_link` with the `@username` that pressed, and waits for
    /// `finish_telegram_link`.
    pub fn poll_telegram_login(&self, poll_token: &str) -> Result<Value, String> {
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let poll_hash = hash_token(poll_token);
        let Some(row) = read_row_where(&tx, "poll_hash", &poll_hash)? else {
            return Ok(json!({"status": "unknown"}));
        };
        if row.denied_at.is_some() {
            return Ok(json!({"status": "denied"}));
        }
        if row.picked_at.is_some() {
            return Ok(json!({"status": "used"}));
        }
        if let (Some(_), Some(user_id)) = (row.approved_at, row.user_id.clone()) {
            // An approval waits for its client a bounded time, not until the
            // hourly sweep: a poll secret found later must not mint a session.
            // Linking gets no grace: `finish_telegram_link` cuts at `expires_at`.
            let deadline = if row.link_user_id.is_some() {
                row.expires_at
            } else {
                row.expires_at + PICKUP_GRACE_MS
            };
            if deadline <= now {
                return Ok(json!({"status": "expired"}));
            }
            if row.link_user_id.is_some() {
                let tg = row.telegram_id.clone().unwrap_or_default();
                return Ok(json!({
                    "status": "confirm_link",
                    "telegram": label(row.telegram_username.as_deref(), &tg),
                }));
            }
            let created: i64 = tx
                .query_row(
                    "SELECT created_account FROM telegram_logins WHERE poll_hash=?1",
                    params![poll_hash],
                    |r| r.get(0),
                )
                .map_err(db_err)?;
            tx.execute(
                "UPDATE telegram_logins SET picked_at=?2 WHERE poll_hash=?1",
                params![poll_hash, now],
            )
            .map_err(db_err)?;
            let account = account_summary(&tx, &user_id)?;
            tx.commit().map_err(db_err)?;
            return Ok(json!({
                "status": "approved",
                "userId": user_id,
                "client": row.client,
                "created": created != 0,
                // So the client can say «Вы вошли как @x (Имя)» with a way
                // out — the last line against a code seen on a shared screen.
                "telegram": label(row.telegram_username.as_deref(), row.telegram_id.as_deref().unwrap_or_default()),
                "account": account,
            }));
        }
        if row.expires_at <= now {
            return Ok(json!({"status": "expired"}));
        }
        Ok(json!({"status": "pending"}))
    }

    /// Mint the session a picked sign-in hands out — in one transaction with
    /// the check that its Telegram account still opens `user_id`. Between the
    /// pick and this, the Telegram may have been unlinked or moved to another
    /// account; then the login dies (`identity_moved`) instead of opening the
    /// account it no longer belongs to.
    pub fn mint_telegram_session(
        &self,
        poll_token: &str,
        user_id: &str,
        ttl_days: i64,
    ) -> Result<String, String> {
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let poll_hash = hash_token(poll_token);
        let row = read_row_where(&tx, "poll_hash", &poll_hash)?.ok_or("unknown")?;
        let subject = row.telegram_id.clone().ok_or("unknown")?;
        if row.user_id.as_deref() != Some(user_id)
            || identity::resolve(&tx, PROVIDER_TELEGRAM, &subject)?.as_deref() != Some(user_id)
        {
            kill(&tx, &row_code_hash(&tx, &poll_hash)?, now, "identity_moved")?;
            tx.commit().map_err(db_err)?;
            return Err("identity_moved".into());
        }
        let token = opaque_token();
        tx.execute(
            "INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at,mfa_pending) VALUES(?1,?2,?3,?4,?5)",
            params![
                hash_token(&token),
                user_id,
                now + ttl_days * 24 * 60 * 60 * 1000,
                now,
                // Telegram proves the account, not a second factor: pending
                // when the person needs one (a web poll gets a cookie that opens
                // the code screen; the native poll is refused before it gets here).
                self.mfa_pending_in(&tx, user_id, crate::mfa::Factor::Unproven)
            ],
        )
        .map_err(db_err)?;
        // Remember WHICH session this login produced, so «Это был не я» can end
        // exactly that one (and nothing else of the person's).
        tx.execute(
            "UPDATE telegram_logins SET session_hash=?2 WHERE poll_hash=?1",
            params![poll_hash, hash_token(&token)],
        )
        .map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(token)
    }

    /// The bot delivered these notices: only now are they spent (until then a
    /// fetched notice is merely leased and comes back when the lease lapses).
    /// Unknown refs are ignored.
    pub fn telegram_login_notices_ack(&self, refs: &[String]) -> Result<(), String> {
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        for r in refs {
            conn.execute(
                "UPDATE telegram_logins SET notified_at=?2 WHERE substr(code_hash,1,32)=?1 AND notified_at IS NULL",
                params![r, now],
            )
            .map_err(db_err)?;
        }
        Ok(())
    }

    /// Sign-ins the bot has not yet been acknowledged to have told their
    /// person about, leased for a minute each: `{ref, telegramId, device, at, ip}`. `ref` is the first 32 hex of
    /// the code hash — enough to find the row again, useless as a credential
    /// (revoking also needs the bot's secret AND the bound Telegram id).
    /// `ip` is the IPv4 address or the IPv6 /64 the login was started from.
    pub fn telegram_login_notices(&self, limit: usize) -> Result<Vec<Value>, String> {
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let rows: Vec<(String, String, Option<String>, i64, Option<String>)> = {
            let mut stmt = tx
                .prepare(
                    "SELECT code_hash,telegram_id,device,picked_at,rate_key FROM telegram_logins \
                     WHERE session_hash IS NOT NULL AND notified_at IS NULL AND link_user_id IS NULL \
                     AND (leased_until IS NULL OR leased_until<?3) \
                     AND telegram_id IS NOT NULL AND picked_at>?1 ORDER BY picked_at LIMIT ?2",
                )
                .map_err(db_err)?;
            let found = stmt
                .query_map(params![now - NOTICE_WINDOW_MS, limit as i64, now], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                })
                .map_err(db_err)?
                .filter_map(Result::ok)
                .collect();
            found
        };
        let mut out = Vec::new();
        for (code_hash, telegram_id, device, at, ip) in rows {
            tx.execute(
                "UPDATE telegram_logins SET leased_until=?2 WHERE code_hash=?1",
                params![code_hash, now + NOTICE_LEASE_MS],
            )
            .map_err(db_err)?;
            // Absent optional fields are omitted, never `null`.
            let mut notice = json!({
                "ref": &code_hash[..32],
                "telegramId": telegram_id,
                "at": at,
            });
            if let Some(device) = device {
                notice["device"] = json!(device);
            }
            if let Some(ip) = ip {
                notice["ip"] = json!(ip);
            }
            out.push(notice);
        }
        tx.commit().map_err(db_err)?;
        Ok(out)
    }

    /// «Это был не я — завершить». Whoever got in through that login, as the
    /// person's own account, could do more than hold a session: add a way in,
    /// connect a machine, enrol their own authenticator. So this undoes
    /// everything done from `t0` — the moment the login was picked up — in ONE
    /// transaction keyed by the account:
    ///
    /// * every session of the account (including service UI passes) — signed
    ///   out everywhere, the person signs in again;
    /// * identities linked at/after `t0`, except the Telegram account that
    ///   pressed this button (it is the way back in), each recorded in
    ///   `identity_unlinks` so a later login does not quietly re-adopt it;
    /// * device credentials issued at/after `t0`, and devices first seen then;
    /// * an authenticator created or confirmed at/after `t0` — otherwise the
    ///   attacker's second factor would lock the victim out of their own account;
    /// * one audit row listing it.
    ///
    /// Only the Telegram account the login was bound to may do it. SINGLE-USE:
    /// the first press stores a consumed marker and its answer in the same
    /// transaction; a repeat returns that stored answer (`repeat: true`) and
    /// undoes nothing new — so a replayed press cannot wipe what the person
    /// did after signing in again. The caller closes the sockets and tells the
    /// hub (`UndoOutcome`).
    pub fn revoke_telegram_login_session(
        &self,
        reference: &str,
        tg: &TgUser,
    ) -> Result<UndoOutcome, String> {
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let found: Option<(String, Option<i64>, Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT user_id,picked_at,session_hash,undone_result FROM telegram_logins \
                 WHERE substr(code_hash,1,32)=?1 AND telegram_id=?2 AND link_user_id IS NULL",
                params![reference, tg.subject()],
                |r| {
                    Ok((
                        r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                    ))
                },
            )
            .optional()
            .map_err(db_err)?;
        let Some((user_id, Some(t0), Some(login_session), stored)) = found else {
            return Err("unknown".into());
        };
        if user_id.is_empty() {
            return Err("unknown".into());
        }
        if let Some(stored) = stored {
            let mut body: Value = serde_json::from_str(&stored).map_err(|e| e.to_string())?;
            body["repeat"] = json!(true);
            return Ok(UndoOutcome {
                body,
                user_id,
                since_ms: t0,
                live_tokens: Vec::new(),
                fresh: false,
            });
        }
        let sessions = tx
            .execute(
                "DELETE FROM auth_sessions WHERE user_id=?1",
                params![user_id],
            )
            .map_err(db_err)?;
        // Identities linked since, other than the pressing Telegram account.
        let mut identities: Vec<(String, String)> = Vec::new();
        {
            let mut stmt = tx
                .prepare(
                    "SELECT provider,subject FROM identities WHERE user_id=?1 AND created_at>=?2 \
                     AND NOT (provider=?3 AND subject=?4)",
                )
                .map_err(db_err)?;
            let rows = stmt
                .query_map(params![user_id, t0, PROVIDER_TELEGRAM, tg.subject()], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .map_err(db_err)?;
            for row in rows {
                identities.push(row.map_err(db_err)?);
            }
        }
        for (provider, subject) in &identities {
            tx.execute(
                "DELETE FROM identities WHERE provider=?1 AND subject=?2 AND user_id=?3",
                params![provider, subject, user_id],
            )
            .map_err(db_err)?;
            tx.execute(
                "INSERT OR REPLACE INTO identity_unlinks(provider,subject,user_id,unlinked_at) VALUES(?1,?2,?3,?4)",
                params![provider, subject, user_id, now],
            )
            .map_err(db_err)?;
        }
        // Machines connected since: credentials first, then the device rows
        // that did not exist before.
        let mut machines: Vec<String> = Vec::new();
        {
            let mut stmt = tx
                .prepare(
                    "SELECT DISTINCT d.machine_id,d.name FROM devices d \
                     JOIN device_credentials c ON c.machine_id=d.machine_id \
                     WHERE d.owner_user_id=?1 AND c.created_at>=?2 AND c.revoked_at IS NULL",
                )
                .map_err(db_err)?;
            let rows = stmt
                .query_map(params![user_id, t0], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .map_err(db_err)?;
            for row in rows {
                let (machine_id, name) = row.map_err(db_err)?;
                tx.execute(
                    "UPDATE device_credentials SET revoked_at=?3 WHERE machine_id=?1 AND created_at>=?2 AND revoked_at IS NULL",
                    params![machine_id, t0, now],
                )
                .map_err(db_err)?;
                tx.execute(
                    "UPDATE devices SET revoked_at=?3 WHERE machine_id=?1 AND created_at>=?2 AND revoked_at IS NULL",
                    params![machine_id, t0, now],
                )
                .map_err(db_err)?;
                machines.push(name.chars().take(40).collect());
            }
        }
        // An authenticator that appeared since (confirmed, or begun and left
        // pending) is the attacker's.
        let totp = tx
            .execute(
                "DELETE FROM user_totp WHERE user_id=?1 AND (confirmed_at>=?2 OR (confirmed_at IS NULL AND created_at>=?2))",
                params![user_id, t0],
            )
            .map_err(db_err)?
            > 0;
        // Notification registrations since: Live Activity tokens (the hub drops
        // push device tokens itself, see `HubCmd::UndoSignIn`), a start still
        // waiting for its activity, and enrolment codes made and not yet used.
        let live_tokens: Vec<String> = {
            let mut stmt = tx
                .prepare(
                    "SELECT token FROM live_activity_tokens WHERE user_id=?1 AND updated_ms>=?2",
                )
                .map_err(db_err)?;
            let rows = stmt
                .query_map(params![user_id, t0], |r| r.get::<_, String>(0))
                .map_err(db_err)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(db_err)?);
            }
            out
        };
        tx.execute(
            "DELETE FROM live_activity_tokens WHERE user_id=?1 AND updated_ms>=?2",
            params![user_id, t0],
        )
        .map_err(db_err)?;
        tx.execute(
            "DELETE FROM live_activity_pending_start WHERE user_id=?1 AND started_ms>=?2",
            params![user_id, t0],
        )
        .map_err(db_err)?;
        let codes = tx
            .execute(
                "DELETE FROM enrollments WHERE user_id=?1 AND used_at IS NULL AND created_at>=?2",
                params![user_id, t0],
            )
            .map_err(db_err)?;
        // Workspace authorization, precisely. Withdrawn: invitations this user
        // made since t0 that nobody accepted, and the memberships that
        // accepting such an invitation CREATED (`created_membership`: a
        // brand-new member, not an existing one whose role it changed) — the
        // attacker must not keep team access through an invitation the stolen
        // session issued. Removed with the SAME cleanup as a normal member
        // removal (`remove_membership_rows`), never an owner, never this user.
        // Everything else that took effect — role changes (including a role an
        // invitation changed), ownership transfers, removals — is only REPORTED
        // for the person to decide: an automatic revert could delete or
        // overwrite legitimate team data. An invitation with no recorded
        // session (made before `created_session` existed, or without a
        // session at all) cannot be told apart, so since t0 it is treated as
        // the stolen session's — the safe side for access.
        let invitations = tx
            .execute(
                "DELETE FROM invitations WHERE created_by=?1 AND created_at>=?2 AND accepted_at IS NULL \
                 AND (created_session=?3 OR created_session IS NULL)",
                params![user_id, t0, login_session],
            )
            .map_err(db_err)?;
        let created: Vec<(String, String)> = {
            let mut stmt = tx
                .prepare(
                    "SELECT DISTINCT i.workspace_id,i.accepted_by FROM invitations i \
                     JOIN memberships m ON m.workspace_id=i.workspace_id AND m.user_id=i.accepted_by \
                     AND m.created_at=i.accepted_at \
                     WHERE i.created_by=?1 AND i.created_at>=?2 AND i.created_membership=1 \
                     AND (i.created_session=?3 OR i.created_session IS NULL) AND i.accepted_by IS NOT NULL AND i.accepted_by<>?1 AND m.role<>'owner'",
                )
                .map_err(db_err)?;
            let rows = stmt
                .query_map(params![user_id, t0, login_session], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .map_err(db_err)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(db_err)?);
            }
            out
        };
        let who_is = |id: &str| -> Result<String, String> {
            let found: Option<String> = tx
                .query_row(
                    "SELECT COALESCE(email,full_name,user_id) FROM users WHERE user_id=?1",
                    params![id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(db_err)?;
            Ok(found
                .unwrap_or_else(|| id.to_string())
                .chars()
                .take(80)
                .collect())
        };
        let mut removed_members: Vec<Value> = Vec::new();
        for (workspace_id, member) in &created {
            let name: String = tx
                .query_row(
                    "SELECT COALESCE(name,'') FROM workspaces WHERE workspace_id=?1",
                    params![workspace_id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(db_err)?
                .unwrap_or_default();
            crate::access::remove_membership_rows(&tx, workspace_id, member)?;
            removed_members.push(json!({
                "workspace": name.chars().take(60).collect::<String>(),
                "member": who_is(member)?,
            }));
        }
        // (when, item): newest first, one more than shown so «truncated» is exact.
        let mut found: Vec<(i64, Value)> = Vec::new();
        {
            let mut stmt = tx
                .prepare(
                    "SELECT a.action,a.target_id,a.metadata_json,COALESCE(w.name,''),a.created_at \
                     FROM audit_events a LEFT JOIN workspaces w ON w.workspace_id=a.workspace_id \
                     WHERE a.actor_user_id=?1 AND a.created_at>=?2 \
                     AND a.action IN ('membership.role_changed','workspace.ownership_transferred','membership.removed') \
                     ORDER BY a.created_at DESC LIMIT ?3",
                )
                .map_err(db_err)?;
            let rows = stmt
                .query_map(params![user_id, t0, REVIEW_MAX + 1], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, i64>(4)?,
                    ))
                })
                .map_err(db_err)?;
            for row in rows {
                let (action, target, meta, workspace, at) = row.map_err(db_err)?;
                let meta: Value = serde_json::from_str(&meta).unwrap_or(Value::Null);
                let mut item = json!({
                    "kind": match action.as_str() {
                        "membership.role_changed" => "role_changed",
                        "workspace.ownership_transferred" => "ownership_transferred",
                        _ => "removed",
                    },
                    "workspace": workspace.chars().take(60).collect::<String>(),
                    "member": who_is(&target)?,
                });
                if let Some(role) = meta.get("role").and_then(Value::as_str) {
                    item["role"] = json!(role);
                }
                found.push((at, item));
            }
        }
        found.sort_by_key(|(at, _)| std::cmp::Reverse(*at));
        // The exact number of items that did not fit (counted, not inferred
        // from the over-read).
        let total: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM audit_events WHERE actor_user_id=?1 AND created_at>=?2 \
                 AND action IN ('membership.role_changed','workspace.ownership_transferred','membership.removed')",
                params![user_id, t0],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        let truncated = (total - REVIEW_MAX).max(0);
        found.truncate(REVIEW_MAX as usize);
        let review: Vec<Value> = found.into_iter().map(|(_, item)| item).collect();
        let labels: Vec<String> = identities
            .iter()
            .map(|(p, s)| {
                if p == PROVIDER_TELEGRAM {
                    format!("telegram {s}")
                } else {
                    p.clone()
                }
            })
            .collect();
        if let Some(workspace) = crate::access::audit_workspace_in(&tx, &user_id)? {
            insert_audit(
                &tx,
                &workspace,
                &user_id,
                "auth.telegram_signin_undone",
                "user",
                &user_id,
                &json!({
                    "sessions": sessions,
                    "identities": labels,
                    "machines": machines,
                    "authenticator": totp,
                    "notificationTokens": live_tokens.len(),
                    "enrollmentCodes": codes,
                    "invitations": invitations,
                    "membershipsRemoved": removed_members.len(),
                    "toReview": review,
                    "toReviewTruncated": truncated,
                    "since": t0,
                }),
            )?;
        }
        let body = json!({
            "status": "revoked",
            "undone": {
                "sessions": sessions,
                "identities": labels,
                "machines": machines,
                "authenticator": totp,
                "enrollmentCodes": codes,
                "invitations": invitations,
                "membershipsRemoved": removed_members.len(),
                "removedMembers": removed_members,
            },
            "review": review,
            "truncated": truncated,
        });
        // The consumed marker and the answer, in the same transaction.
        tx.execute(
            "UPDATE telegram_logins SET undone_at=?2,undone_result=?3 WHERE substr(code_hash,1,32)=?1",
            params![reference, now, body.to_string()],
        )
        .map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(UndoOutcome {
            body,
            user_id,
            since_ms: t0,
            live_tokens,
            fresh: true,
        })
    }

    /// Undo `poll`'s pick when the session could not be minted, so the
    /// approval is not lost.
    pub fn unpick_telegram_login(&self, poll_token: &str) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.execute(
            "UPDATE telegram_logins SET picked_at=NULL WHERE poll_hash=?1",
            params![hash_token(poll_token)],
        )
        .map_err(db_err)?;
        Ok(())
    }

    /// «Да, это мой @username» — from inside the account that asked for the
    /// link, after it was shown who pressed. Only now does the Telegram
    /// account become a way into it. Re-checks everything `decide` checked:
    /// time has passed. A Telegram account that opened an empty account of
    /// its own is moved here (`identity::attach`).
    pub fn finish_telegram_link(&self, poll_token: &str, actor: &str) -> Result<Value, String> {
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let poll_hash = hash_token(poll_token);
        let row = read_row_where(&tx, "poll_hash", &poll_hash)?.ok_or("unknown")?;
        let Some(target) = row.link_user_id.clone() else {
            return Err("not_a_link".into());
        };
        // Only the account that started it; nobody links Telegram to someone
        // else's account by holding their poll token.
        if target != actor {
            return Err("unknown".into());
        }
        if row.picked_at.is_some() || row.denied_at.is_some() {
            return Err("decided".into());
        }
        if row.approved_at.is_none() {
            return Err("not_approved".into());
        }
        // The same window as the press: a proposal left for later is dead.
        if row.expires_at <= now {
            return Err("expired".into());
        }
        let subject = row.telegram_id.clone().ok_or("not_approved")?;
        let moved = identity::attach(
            &tx,
            PROVIDER_TELEGRAM,
            &subject,
            &target,
            Some(&label(row.telegram_username.as_deref(), &subject)),
            now,
        )?;
        tx.execute(
            "UPDATE telegram_logins SET picked_at=?2 WHERE poll_hash=?1",
            params![poll_hash, now],
        )
        .map_err(db_err)?;
        let telegram = label(row.telegram_username.as_deref(), &subject);
        if let Some(ws) = crate::access::audit_workspace_in(&tx, &target)? {
            insert_audit(
                &tx,
                &ws,
                &target,
                "auth.telegram_linked",
                "user",
                &target,
                &json!({"telegramId": subject, "telegram": telegram, "ip": row.client_ip}),
            )?;
        }
        tx.commit().map_err(db_err)?;
        let mut out = json!({"status": "linked", "telegram": telegram});
        if let identity::Attached::Moved { from, .. } = moved {
            out["movedFrom"] = json!(from);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tg(id: i64) -> TgUser {
        TgUser::new(id, Some("danis_latypov"), Some("Данис"), Some("Латыпов"))
    }

    struct Started {
        code: String,
        poll: String,
        number: String,
    }

    fn start(s: &WorkspaceStore, link: Option<&str>) -> Started {
        let v = s
            .start_telegram_login(
                link,
                "web",
                "Chrome · macOS",
                Some("203.0.113.7"),
                Some("203.0.113.7"),
            )
            .unwrap();
        Started {
            code: v["code"].as_str().unwrap().to_string(),
            poll: v["pollToken"].as_str().unwrap().to_string(),
            number: v["match"].as_str().unwrap().to_string(),
        }
    }

    /// Peek as `who`, then press the right number.
    fn approve(s: &WorkspaceStore, st: &Started, who: &TgUser) -> Result<Value, String> {
        s.peek_telegram_login(&st.code, who)?;
        s.decide_telegram_login(&st.code, who, &Press::Number(st.number.clone()))
    }

    #[test]
    fn a_stranger_gets_a_new_waitlisted_account_without_email_and_the_client_one_session() {
        let s = WorkspaceStore::open_memory();
        let st = start(&s, None);
        assert_eq!(st.code.len(), 32);
        assert_eq!(st.number.len(), 2);
        assert_eq!(
            s.poll_telegram_login(&st.poll).unwrap()["status"],
            "pending"
        );

        let peek = s.peek_telegram_login(&st.code, &tg(7001)).unwrap();
        assert_eq!(peek["intent"], "login");
        assert_eq!(peek["device"], "Chrome · macOS");
        assert_eq!(peek["sessionDays"], 7);
        let choices: Vec<String> = serde_json::from_value(peek["choices"].clone()).unwrap();
        assert_eq!(choices.len(), CHOICES);
        assert!(
            choices.contains(&st.number),
            "the right number is among them"
        );
        assert!(peek.get("ip").is_none(), "no address on the card");
        assert!(
            peek.get("account").is_none(),
            "a stranger has no account yet"
        );

        let done = s
            .decide_telegram_login(&st.code, &tg(7001), &Press::Number(st.number.clone()))
            .unwrap();
        assert_eq!(done["status"], "approved");
        assert_eq!(done["created"], true);
        let uid = done["account"]["userId"].as_str().unwrap().to_string();
        assert!(
            uid.starts_with("tg-"),
            "hub-owned id, never a platform UUID: {uid}"
        );
        assert_eq!(done["account"]["displayName"], "Данис Латыпов");
        assert_eq!(done["account"]["state"], "waitlist");

        let picked = s.poll_telegram_login(&st.poll).unwrap();
        assert_eq!(picked["status"], "approved");
        assert_eq!(picked["userId"], uid);
        assert_eq!(
            picked["telegram"], "@danis_latypov",
            "the client can say who signed in"
        );
        assert_eq!(picked["account"]["displayName"], "Данис Латыпов");
        assert_eq!(
            s.poll_telegram_login(&st.poll).unwrap()["status"],
            "used",
            "handed out once"
        );

        s.with_conn_for_tests(|c| {
            let email: Option<String> = c
                .query_row("SELECT email FROM users WHERE user_id=?1", [&uid], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(email, None, "NULL, never an empty string");
            let label: Option<String> = c
                .query_row(
                    "SELECT label FROM identities WHERE provider='telegram' AND subject='7001'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(label.as_deref(), Some("@danis_latypov"));
        });
    }

    #[test]
    fn a_pickup_is_announced_once_and_only_its_telegram_can_press_undo() {
        let s = WorkspaceStore::open_memory();
        let st = start(&s, None);
        let who = tg(7);
        let approved = approve(&s, &st, &who).unwrap();
        let user = approved["account"]["userId"].as_str().unwrap().to_string();
        assert!(s.telegram_login_notices(10).unwrap().is_empty());
        assert_eq!(
            s.poll_telegram_login(&st.poll).unwrap()["status"],
            "approved"
        );
        let session = s.mint_telegram_session(&st.poll, &user, 7).unwrap();
        let notices = s.telegram_login_notices(10).unwrap();
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0]["telegramId"], "7");
        assert_eq!(notices[0]["device"], "Chrome · macOS");
        assert_eq!(notices[0]["ip"], "203.0.113.7");
        assert!(s.telegram_login_notices(10).unwrap().is_empty(), "leased");
        let reference = notices[0]["ref"].as_str().unwrap().to_string();
        let reference = reference.as_str();
        // Not acknowledged (Telegram failed): handed out again once the lease lapses.
        s.conn
            .lock()
            .unwrap()
            .execute("UPDATE telegram_logins SET leased_until=1", [])
            .unwrap();
        assert_eq!(s.telegram_login_notices(10).unwrap().len(), 1, "retried");
        s.telegram_login_notices_ack(&[reference.to_string()])
            .unwrap();
        s.conn
            .lock()
            .unwrap()
            .execute("UPDATE telegram_logins SET leased_until=1", [])
            .unwrap();
        assert!(
            s.telegram_login_notices(10).unwrap().is_empty(),
            "acknowledged: spent"
        );
        // The hourly sweep keeps a completed login (the undo needs it) but not
        // an unfinished one.
        s.conn
            .lock()
            .unwrap()
            .execute("UPDATE telegram_logins SET expires_at=1", [])
            .unwrap();
        let open = start(&s, None);
        s.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE telegram_logins SET expires_at=1 WHERE session_hash IS NULL",
                [],
            )
            .unwrap();
        let _ = start(&s, None);
        let left = |sql: &str| -> i64 {
            s.conn
                .lock()
                .unwrap()
                .query_row(sql, [], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(
            left("SELECT COUNT(*) FROM telegram_logins WHERE session_hash IS NOT NULL"),
            1
        );
        assert_eq!(
            left(
                "SELECT COUNT(*) FROM telegram_logins WHERE expires_at=1 AND session_hash IS NULL"
            ),
            0
        );
        let _ = open;
        assert_eq!(
            s.revoke_telegram_login_session(reference, &tg(8))
                .unwrap_err(),
            "unknown"
        );
        assert!(s.authenticate(&session).unwrap().is_some());
    }

    /// «Это был не я» must undo what the phished session could have done:
    /// everything since the pickup, nothing before it.
    #[test]
    fn this_was_not_me_undoes_everything_done_since_the_pickup() {
        let s = WorkspaceStore::open_memory();
        let st = start(&s, None);
        let who = tg(7);
        let approved = approve(&s, &st, &who).unwrap();
        let user = approved["account"]["userId"].as_str().unwrap().to_string();
        let ws = s.create_organization(&user, "Team", &user).ok();
        let _ = ws;
        // Before the pickup: an older identity, device and authenticator that
        // belong to the real person.
        {
            let c = s.conn.lock().unwrap();
            c.execute("INSERT INTO identities(provider,subject,user_id,created_at) VALUES('google','old-google',?1,1000)", params![user]).unwrap();
            c.execute("INSERT INTO devices(machine_id,owner_user_id,name,os,agent_version,last_seen,created_at) VALUES('old-box',?1,'Старый',  'linux','1',1000,1000)", params![user]).unwrap();
            c.execute("INSERT INTO device_credentials(credential_id,machine_id,token_hash,created_at) VALUES('c-old','old-box','h-old',1000)", params![]).unwrap();
            c.execute("INSERT INTO user_totp(user_id,secret,confirmed_at,created_at) VALUES(?1,'AAAA',1000,1000)", params![user]).unwrap();
        }
        let other = s.create_auth_session(&user, 7).unwrap();
        assert_eq!(
            s.poll_telegram_login(&st.poll).unwrap()["status"],
            "approved"
        );
        let phished = s.mint_telegram_session(&st.poll, &user, 7).unwrap();
        let reference = s.telegram_login_notices(10).unwrap()[0]["ref"]
            .as_str()
            .unwrap()
            .to_string();
        let t0 = now_ms();
        // What the intruder did with the session.
        {
            let c = s.conn.lock().unwrap();
            c.execute("INSERT INTO identities(provider,subject,user_id,created_at) VALUES('google','evil-google',?1,?2)", params![user, t0 + 5]).unwrap();
            c.execute("INSERT INTO devices(machine_id,owner_user_id,name,os,agent_version,last_seen,created_at) VALUES('evil-box',?1,'Чужой',  'linux','1',?2,?2)", params![user, t0 + 5]).unwrap();
            c.execute("INSERT INTO device_credentials(credential_id,machine_id,token_hash,created_at) VALUES('c-evil','evil-box','h-evil',?1)", params![t0 + 5]).unwrap();
            c.execute(
                "UPDATE user_totp SET confirmed_at=?2 WHERE user_id=?1",
                params![user, t0 + 9],
            )
            .unwrap();
        }
        {
            let c = s.conn.lock().unwrap();
            c.execute("INSERT INTO live_activity_tokens(user_id,token,activity_id,updated_ms) VALUES(?1,'abcd01','act',?2)", params![user, t0 + 6]).unwrap();
            c.execute("INSERT INTO live_activity_tokens(user_id,token,activity_id,updated_ms) VALUES(?1,'abcd02',NULL,1000)", params![user]).unwrap();
            c.execute("INSERT INTO enrollments(code_hash,user_id,created_at,expires_at) VALUES('code-evil',?1,?2,?3)", params![user, t0 + 7, t0 + 900_000]).unwrap();
            c.execute("INSERT INTO enrollments(code_hash,user_id,created_at,expires_at) VALUES('code-old',?1,1000,?2)", params![user, t0 + 900_000]).unwrap();
        }
        let out = s.revoke_telegram_login_session(&reference, &who).unwrap();
        assert!(out.fresh);
        assert_eq!(out.live_tokens, vec!["abcd01".to_string()]);
        let done = out.body.clone();
        assert_eq!(done["status"], "revoked");
        assert_eq!(done["undone"]["sessions"], 2);
        assert_eq!(done["undone"]["identities"], json!(["google"]));
        assert_eq!(done["undone"]["machines"], json!(["Чужой"]));
        assert_eq!(done["undone"]["authenticator"], true);
        // Signed out everywhere, not just the phished session.
        assert!(s.authenticate(&phished).unwrap().is_none());
        assert!(s.authenticate(&other).unwrap().is_none());
        let c = s.conn.lock().unwrap();
        let count = |sql: &str| -> i64 { c.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert_eq!(
            count("SELECT COUNT(*) FROM identities WHERE subject='evil-google'"),
            0
        );
        assert_eq!(
            count("SELECT COUNT(*) FROM identity_unlinks WHERE subject='evil-google'"),
            1
        );
        assert_eq!(
            count("SELECT COUNT(*) FROM identities WHERE subject='old-google'"),
            1,
            "older ways in stay"
        );
        assert_eq!(
            count("SELECT COUNT(*) FROM identities WHERE provider='telegram' AND subject='7'"),
            1,
            "the pressing Telegram is the way back in"
        );
        assert_eq!(count("SELECT COUNT(*) FROM device_credentials WHERE credential_id='c-evil' AND revoked_at IS NOT NULL"), 1);
        assert_eq!(count("SELECT COUNT(*) FROM devices WHERE machine_id='evil-box' AND revoked_at IS NOT NULL"), 1);
        assert_eq!(count("SELECT COUNT(*) FROM device_credentials WHERE credential_id='c-old' AND revoked_at IS NULL"), 1, "the real machine is untouched");
        assert_eq!(
            count("SELECT COUNT(*) FROM devices WHERE machine_id='old-box' AND revoked_at IS NULL"),
            1
        );
        assert_eq!(
            count("SELECT COUNT(*) FROM user_totp WHERE user_id IS NOT NULL"),
            0,
            "the authenticator confirmed since is gone"
        );
        drop(c);
        // Single-use: the person signs in again and sets things up; pressing
        // the old button again returns the stored answer and undoes nothing.
        let again_session = s.create_auth_session(&user, 7).unwrap();
        {
            let c = s.conn.lock().unwrap();
            c.execute("INSERT INTO identities(provider,subject,user_id,created_at) VALUES('google','new-google',?1,?2)", params![user, t0 + 50]).unwrap();
        }
        let again = s.revoke_telegram_login_session(&reference, &who).unwrap();
        assert!(!again.fresh && again.live_tokens.is_empty());
        assert_eq!(again.body["repeat"], true);
        assert_eq!(
            again.body["undone"]["sessions"], 2,
            "the stored answer, not a new count"
        );
        assert!(
            s.authenticate(&again_session).unwrap().is_some(),
            "nothing new was undone"
        );
        let c = s.conn.lock().unwrap();
        let kept: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM identities WHERE subject='new-google'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kept, 1);
        // A link in flight dies with its session.
        drop(c);
        let hash = crate::workspace::hash_token(&again_session);
        assert!(s.session_alive_for(&hash, &user));
        s.logout(&again_session);
        assert!(!s.session_alive_for(&hash, &user));
    }

    /// The precise version: the undo withdraws unaccepted invitations and
    /// removes exactly the memberships an invitation of the stolen session
    /// CREATED (with the normal removal's cleanup); an existing member whose
    /// role an invitation changed stays and is reported; an owner and the
    /// victim are never removed; ownership changes are reported, not reverted.
    #[test]
    fn the_undo_removes_memberships_its_invitations_created_and_reports_the_rest() {
        let s = WorkspaceStore::open_memory();
        let st = start(&s, None);
        let who = tg(7);
        let approved = approve(&s, &st, &who).unwrap();
        let user = approved["account"]["userId"].as_str().unwrap().to_string();
        for (id, email) in [
            ("new1", "n1@x"),
            ("old", "old@x"),
            ("heir", "heir@x"),
            ("col", "col@x"),
        ] {
            s.ensure_user(id, email, None).unwrap();
        }
        let team = s.create_organization(&user, "Команда", &user).unwrap();
        let wid = team["workspaceId"].as_str().unwrap().to_string();
        // A long-standing member, from before the stolen session.
        let before = s.invite(&user, &wid, "old@x", "member").unwrap();
        s.accept_invitation("old", before["token"].as_str().unwrap())
            .unwrap();
        s.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE invitations SET created_at=1000, accepted_at=1000",
                [],
            )
            .unwrap();
        assert_eq!(
            s.poll_telegram_login(&st.poll).unwrap()["status"],
            "approved"
        );
        let phished = s.mint_telegram_session(&st.poll, &user, 7).unwrap();
        let ph = crate::workspace::hash_token(&phished);
        let own_token = s.create_auth_session(&user, 7).unwrap();
        let own = crate::workspace::hash_token(&own_token);
        let reference = s.telegram_login_notices(10).unwrap()[0]["ref"]
            .as_str()
            .unwrap()
            .to_string();

        // The intruder: invites a brand-new person (accepted); invites the
        // existing member as manager (accepted: a ROLE CHANGE, no new
        // membership); invites the heir and hands them the team; leaves one
        // invitation pending.
        let i1 = s
            .invite_from(&user, &wid, "n1@x", "manager", Some(&ph))
            .unwrap();
        s.accept_invitation("new1", i1["token"].as_str().unwrap())
            .unwrap();
        let i2 = s
            .invite_from(&user, &wid, "old@x", "manager", Some(&ph))
            .unwrap();
        s.accept_invitation("old", i2["token"].as_str().unwrap())
            .unwrap();
        let i3 = s
            .invite_from(&user, &wid, "heir@x", "member", Some(&ph))
            .unwrap();
        s.accept_invitation("heir", i3["token"].as_str().unwrap())
            .unwrap();
        // Meanwhile the REAL owner, from their own session, invites a colleague
        // (accepted) and leaves another invitation pending.
        let i4 = s
            .invite_from(&user, &wid, "col@x", "member", Some(&own))
            .unwrap();
        s.accept_invitation("col", i4["token"].as_str().unwrap())
            .unwrap();
        s.transfer_ownership(&user, &wid, "heir").unwrap();
        // The brand-new member owns a share and sits on a manager assignment.
        {
            let c = s.conn.lock().unwrap();
            c.execute("INSERT INTO devices(machine_id,owner_user_id,name,os,agent_version,last_seen,created_at) VALUES('m','new1','M','linux','1',1,1)", []).unwrap();
            c.execute("INSERT INTO project_shares(project_share_id,workspace_id,machine_id,owner_user_id,root,name,created_at) VALUES('sh1',?1,'m','new1','/p','a',1)", params![wid]).unwrap();
            c.execute("INSERT INTO manager_assignments(workspace_id,manager_user_id,target_kind,target_id,created_at) VALUES(?1,'new1','member','old',1)", params![wid]).unwrap();
            c.execute(
                "INSERT INTO invitations(invitation_id,workspace_id,email,role,token_hash,created_by,created_at,expires_at,created_session) VALUES('pend',?1,'z@x','member','th',?2,?3,?4,?5)",
                params![wid, user, now_ms(), now_ms() + 100_000, ph],
            )
            .unwrap();
            c.execute(
                "INSERT INTO invitations(invitation_id,workspace_id,email,role,token_hash,created_by,created_at,expires_at,created_session) VALUES('pend-own',?1,'w@x','member','th2',?2,?3,?4,?5)",
                params![wid, user, now_ms(), now_ms() + 100_000, own],
            )
            .unwrap();
        }

        let out = s.revoke_telegram_login_session(&reference, &who).unwrap();
        assert!(out.body["undone"]["invitations"].as_i64().unwrap() >= 1);
        assert_eq!(out.body["undone"]["membershipsRemoved"], 1);
        assert_eq!(out.body["undone"]["removedMembers"][0]["member"], "n1@x");
        let c = s.conn.lock().unwrap();
        let has = |u: &str| -> i64 {
            c.query_row(
                "SELECT COUNT(*) FROM memberships WHERE workspace_id=?1 AND user_id=?2",
                params![wid, u],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(has("new1"), 0, "the brand-new invitee is removed");
        let count = |sql: &str| -> i64 { c.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert_eq!(
            count("SELECT COUNT(*) FROM project_shares WHERE owner_user_id='new1'"),
            0,
            "…with the shares they owned"
        );
        assert_eq!(
            count("SELECT COUNT(*) FROM manager_assignments WHERE manager_user_id='new1'"),
            0,
            "…and their assignments"
        );
        assert_eq!(
            has("old"),
            1,
            "an existing member whose role an invitation changed is NOT removed"
        );
        assert_eq!(
            has("heir"),
            1,
            "an owner is never removed; the transfer is not reverted"
        );
        assert_eq!(has(&user), 1, "the victim's own membership stays");
        let owner: String = c
            .query_row(
                "SELECT owner_user_id FROM workspaces WHERE workspace_id=?1",
                params![wid],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(owner, "heir");
        assert_eq!(
            count("SELECT COUNT(*) FROM invitations WHERE invitation_id='pend'"),
            0
        );
        assert_eq!(
            count("SELECT COUNT(*) FROM invitations WHERE invitation_id='pend-own'"),
            1,
            "a pending invitation from the owner's own session survives"
        );
        assert_eq!(
            has("col"),
            1,
            "a colleague invited from the owner's own session stays"
        );
        let review = out.body["review"].as_array().unwrap();
        assert!(
            review.iter().any(|r| r["kind"] == "role_changed"
                && r["member"] == "old@x"
                && r["role"] == "manager"),
            "the invitation's role change is reported: {review:?}"
        );
        assert!(
            review.iter().any(|r| r["kind"] == "ownership_transferred"
                && r["workspace"] == "Команда"
                && r["member"] == "heir@x"),
            "the ownership change is reported: {review:?}"
        );
        assert_eq!(out.body["truncated"], 0);
    }

    /// Accepting an invitation records whether it created the membership.
    #[test]
    fn accepting_records_whether_the_membership_was_created() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("o", "o@x", None).unwrap();
        s.ensure_user("a", "a@x", None).unwrap();
        let team = s.create_organization("o", "T", "o").unwrap();
        let wid = team["workspaceId"].as_str().unwrap();
        let first = s.invite("o", wid, "a@x", "member").unwrap();
        s.accept_invitation("a", first["token"].as_str().unwrap())
            .unwrap();
        let again = s.invite("o", wid, "a@x", "manager").unwrap();
        s.accept_invitation("a", again["token"].as_str().unwrap())
            .unwrap();
        let flags: Vec<i64> = {
            let c = s.conn.lock().unwrap();
            let mut stmt = c
                .prepare("SELECT created_membership FROM invitations ORDER BY created_at,rowid")
                .unwrap();
            stmt.query_map([], |r| r.get(0))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        assert_eq!(flags, vec![1, 0]);
    }

    #[test]
    fn a_notice_omits_absent_optional_fields() {
        let s = WorkspaceStore::open_memory();
        let v = s
            .start_telegram_login(None, "web", "Chrome · macOS", None, None)
            .unwrap();
        let code = v["code"].as_str().unwrap().to_string();
        let poll = v["pollToken"].as_str().unwrap().to_string();
        let number = v["match"].as_str().unwrap().to_string();
        let who = tg(9);
        s.peek_telegram_login(&code, &who).unwrap();
        let approved = s
            .decide_telegram_login(&code, &who, &Press::Number(number))
            .unwrap();
        let user = approved["account"]["userId"].as_str().unwrap().to_string();
        s.poll_telegram_login(&poll).unwrap();
        s.mint_telegram_session(&poll, &user, 7).unwrap();
        let notices = s.telegram_login_notices(10).unwrap();
        assert!(
            notices[0].get("ip").is_none(),
            "no null ip: {:?}",
            notices[0]
        );
        assert_eq!(notices[0]["device"], "Chrome · macOS");
    }

    #[test]
    fn the_wrong_number_kills_the_login_and_creates_nothing() {
        let s = WorkspaceStore::open_memory();
        let st = start(&s, None);
        s.peek_telegram_login(&st.code, &tg(7020)).unwrap();
        let wrong = if st.number == "10" { "11" } else { "10" };
        assert_eq!(
            s.decide_telegram_login(&st.code, &tg(7020), &Press::Number(wrong.into()))
                .unwrap_err(),
            "wrong_match"
        );
        assert_eq!(s.poll_telegram_login(&st.poll).unwrap()["status"], "denied");
        // The right number after a wrong one does nothing: the login is dead.
        assert_eq!(
            s.decide_telegram_login(&st.code, &tg(7020), &Press::Number(st.number.clone()))
                .unwrap_err(),
            "decided"
        );
        s.with_conn_for_tests(|c| {
            let n: i64 = c
                .query_row(
                    "SELECT count(*) FROM identities WHERE provider='telegram'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 0);
        });
    }

    #[test]
    fn opening_the_link_twice_shows_the_same_numbers() {
        let s = WorkspaceStore::open_memory();
        let st = start(&s, None);
        let a = s.peek_telegram_login(&st.code, &tg(7030)).unwrap()["choices"].clone();
        let b = s.peek_telegram_login(&st.code, &tg(7030)).unwrap()["choices"].clone();
        assert_eq!(a, b, "no second draw whose overlap gives the answer away");
        assert_eq!(a.as_array().unwrap().len(), CHOICES);
    }

    #[test]
    fn the_same_telegram_account_opens_the_same_account_next_time() {
        let s = WorkspaceStore::open_memory();
        let first = approve(&s, &start(&s, None), &tg(7002)).unwrap();
        let st2 = start(&s, None);
        let peek = s.peek_telegram_login(&st2.code, &tg(7002)).unwrap();
        assert_eq!(peek["account"]["userId"], first["account"]["userId"]);
        let second = s
            .decide_telegram_login(&st2.code, &tg(7002), &Press::Number(st2.number.clone()))
            .unwrap();
        assert_eq!(second["created"], false);
        assert_eq!(second["account"]["userId"], first["account"]["userId"]);
    }

    #[test]
    fn a_second_telegram_account_on_one_code_kills_the_login() {
        let s = WorkspaceStore::open_memory();
        let st = start(&s, None);
        let right = Press::Number(st.number.clone());
        assert_eq!(
            s.decide_telegram_login(&st.code, &tg(1), &right)
                .unwrap_err(),
            "not_peeked",
            "no peek, no button"
        );
        s.peek_telegram_login(&st.code, &tg(1)).unwrap();
        // Someone else opened the same code: one of them saw a screen that
        // was not theirs, so nobody signs in with it.
        assert_eq!(
            s.peek_telegram_login(&st.code, &tg(2)).unwrap_err(),
            "claimed_by_other"
        );
        assert_eq!(
            s.decide_telegram_login(&st.code, &tg(1), &right)
                .unwrap_err(),
            "decided"
        );
        assert_eq!(s.poll_telegram_login(&st.poll).unwrap()["status"], "denied");
        assert_eq!(
            s.peek_telegram_login("0".repeat(32).as_str(), &tg(1))
                .unwrap_err(),
            "unknown"
        );
    }

    #[test]
    fn a_wrong_number_locks_that_telegram_account_out_of_new_logins_for_a_while() {
        let s = WorkspaceStore::open_memory();
        let st = start(&s, None);
        s.peek_telegram_login(&st.code, &tg(7040)).unwrap();
        let wrong = if st.number == "10" { "11" } else { "10" };
        s.decide_telegram_login(&st.code, &tg(7040), &Press::Number(wrong.into()))
            .unwrap_err();
        let next = start(&s, None);
        assert_eq!(
            s.peek_telegram_login(&next.code, &tg(7040)).unwrap_err(),
            "locked"
        );
        // Another Telegram account is not affected.
        assert!(s.peek_telegram_login(&next.code, &tg(7041)).is_ok());
        // And the lock ends.
        s.with_conn_for_tests(|c| {
            c.execute(
                "UPDATE telegram_logins SET denied_at=1 WHERE denied_reason='wrong_match'",
                [],
            )
            .unwrap();
        });
        let later = start(&s, None);
        assert!(s.peek_telegram_login(&later.code, &tg(7040)).is_ok());
    }

    #[test]
    fn this_is_not_me_kills_the_login_and_creates_nothing() {
        let s = WorkspaceStore::open_memory();
        let st = start(&s, None);
        s.peek_telegram_login(&st.code, &tg(7003)).unwrap();
        assert_eq!(
            s.decide_telegram_login(&st.code, &tg(7003), &Press::NotMe)
                .unwrap()["status"],
            "denied"
        );
        assert_eq!(s.poll_telegram_login(&st.poll).unwrap()["status"], "denied");
    }

    #[test]
    fn a_second_account_kills_even_an_approved_login_its_client_has_not_picked_up() {
        let s = WorkspaceStore::open_memory();
        let st = start(&s, None);
        // The stranger who saw the screen presses first…
        approve(&s, &st, &tg(8001)).unwrap();
        // …the screen's owner opens the same code a second later.
        assert_eq!(
            s.peek_telegram_login(&st.code, &tg(8002)).unwrap_err(),
            "claimed_by_other"
        );
        assert_eq!(
            s.poll_telegram_login(&st.poll).unwrap()["status"],
            "denied",
            "no session for anyone"
        );
    }

    #[test]
    fn a_card_opened_before_a_wrong_press_is_locked_too() {
        let s = WorkspaceStore::open_memory();
        let a = start(&s, None);
        let b = start(&s, None);
        s.peek_telegram_login(&a.code, &tg(8010)).unwrap();
        s.peek_telegram_login(&b.code, &tg(8010)).unwrap();
        let wrong = if a.number == "10" { "11" } else { "10" };
        s.decide_telegram_login(&a.code, &tg(8010), &Press::Number(wrong.into()))
            .unwrap_err();
        assert_eq!(
            s.decide_telegram_login(&b.code, &tg(8010), &Press::Number(b.number.clone()))
                .unwrap_err(),
            "locked",
            "the second card's right number does not get through"
        );
        assert_eq!(s.poll_telegram_login(&b.poll).unwrap()["status"], "denied");
    }

    #[test]
    fn an_expired_login_cannot_be_approved() {
        let s = WorkspaceStore::open_memory();
        let st = start(&s, None);
        s.peek_telegram_login(&st.code, &tg(7004)).unwrap();
        s.with_conn_for_tests(|c| {
            c.execute("UPDATE telegram_logins SET expires_at=1", [])
                .unwrap();
        });
        assert_eq!(
            s.decide_telegram_login(&st.code, &tg(7004), &Press::Number(st.number.clone()))
                .unwrap_err(),
            "expired"
        );
        assert_eq!(
            s.poll_telegram_login(&st.poll).unwrap()["status"],
            "expired"
        );
    }

    #[test]
    fn a_link_is_only_proposed_by_the_press_and_made_by_the_account_that_asked() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("member", "member@x", Some("Member")).unwrap();
        let st = start(&s, Some("member"));
        let peek = s.peek_telegram_login(&st.code, &tg(7005)).unwrap();
        assert_eq!(peek["intent"], "link");
        assert!(peek.get("account").is_none(), "no account login: {peek}");
        assert_eq!(peek["linkTo"]["displayName"], "Member", "names the target");
        assert!(
            peek.get("willMove").is_none(),
            "this Telegram opens nothing yet"
        );
        let done = s
            .decide_telegram_login(&st.code, &tg(7005), &Press::Number(st.number.clone()))
            .unwrap();
        assert_eq!(done["intent"], "link");
        // Nothing is linked yet: the account has not seen who pressed.
        s.with_conn_for_tests(|c| {
            assert_eq!(resolve_tg(c, 7005), None);
        });
        let proposal = s.poll_telegram_login(&st.poll).unwrap();
        assert_eq!(proposal["status"], "confirm_link");
        assert_eq!(proposal["telegram"], "@danis_latypov");
        // Someone else holding the poll token cannot finish it.
        assert_eq!(
            s.finish_telegram_link(&st.poll, "intruder").unwrap_err(),
            "unknown"
        );
        let linked = s.finish_telegram_link(&st.poll, "member").unwrap();
        assert_eq!(linked["status"], "linked");
        assert_eq!(
            s.finish_telegram_link(&st.poll, "member").unwrap_err(),
            "decided"
        );
        s.with_conn_for_tests(|c| {
            assert_eq!(resolve_tg(c, 7005).as_deref(), Some("member"));
        });
        // The same Telegram account now signs in as that member.
        let again = approve(&s, &start(&s, None), &tg(7005)).unwrap();
        assert_eq!(again["account"]["userId"], "member");
    }

    fn resolve_tg(c: &Connection, id: i64) -> Option<String> {
        identity::resolve(c, PROVIDER_TELEGRAM, &id.to_string()).unwrap()
    }

    /// The owner's decision of 09.10.2026: an administrator (or the hub's
    /// owner) links Telegram like anyone else and then signs in with it.
    /// Nothing in the store knows who is privileged any more.
    #[test]
    fn an_admin_links_telegram_and_then_signs_in_with_it() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("admin", "admin@x", Some("Admin")).unwrap();
        let st = start(&s, Some("admin"));
        approve(&s, &st, &tg(7006)).unwrap();
        assert_eq!(
            s.poll_telegram_login(&st.poll).unwrap()["status"],
            "confirm_link"
        );
        assert_eq!(
            s.finish_telegram_link(&st.poll, "admin").unwrap()["status"],
            "linked"
        );
        let login = start(&s, None);
        let done = approve(&s, &login, &tg(7006)).unwrap();
        assert_eq!(done["account"]["userId"], "admin");
        assert_eq!(done["created"], false);
        let picked = s.poll_telegram_login(&login.poll).unwrap();
        assert_eq!(picked["status"], "approved");
        assert_eq!(picked["userId"], "admin");
    }

    #[test]
    fn a_telegram_account_whose_account_holds_work_is_never_moved() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("member", "member@x", None).unwrap();
        s.ensure_user("other", "other@x", None).unwrap();
        let st = start(&s, Some("member"));
        approve(&s, &st, &tg(7005)).unwrap();
        s.finish_telegram_link(&st.poll, "member").unwrap();
        // member has a machine: its Telegram stays where its work is.
        s.with_conn_for_tests(|c| {
            c.execute(
                "INSERT INTO devices(machine_id,owner_user_id,name,os,agent_version,last_seen,created_at) \
                 VALUES('m1','member','Mac','darwin','1',1,1)",
                [],
            )
            .unwrap();
        });
        let st2 = start(&s, Some("other"));
        let peek = s.peek_telegram_login(&st2.code, &tg(7005)).unwrap();
        assert_eq!(peek["moveBlocked"], true, "{peek}");
        assert!(peek.get("willMove").is_none());
        assert_eq!(
            approve(&s, &st2, &tg(7005)).unwrap_err(),
            identity::OWNER_HAS_DATA,
            "refused already in Telegram"
        );
        assert_eq!(
            s.poll_telegram_login(&st2.poll).unwrap()["status"],
            "denied",
            "and the client hears it at once"
        );
        // The machine appeared between the press and «Да»: refused at finish.
        s.ensure_user("third", "third@x", None).unwrap();
        let dup = approve(&s, &start(&s, None), &tg(7008)).unwrap();
        let dup_id = dup["account"]["userId"].as_str().unwrap().to_string();
        let st3 = start(&s, Some("third"));
        approve(&s, &st3, &tg(7008)).unwrap();
        s.with_conn_for_tests(|c| {
            c.execute(
                "INSERT INTO devices(machine_id,owner_user_id,name,os,agent_version,last_seen,created_at) \
                 VALUES('m2',?1,'PC','linux','1',1,1)",
                [&dup_id],
            )
            .unwrap();
        });
        assert_eq!(
            s.finish_telegram_link(&st3.poll, "third").unwrap_err(),
            identity::OWNER_HAS_DATA
        );
        s.with_conn_for_tests(|c| {
            assert_eq!(resolve_tg(c, 7005).as_deref(), Some("member"));
            assert_eq!(resolve_tg(c, 7008).as_deref(), Some(dup_id.as_str()));
        });
        assert_eq!(s.access_state(&dup_id).unwrap().state, "waitlist");
    }

    /// The owner's case: an earlier Telegram sign-in made an empty `tg-…`
    /// account. Linking that Telegram from the real account moves it there
    /// and closes the duplicate.
    #[test]
    fn linking_moves_telegram_off_an_empty_duplicate_and_suspends_it() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("main", "main@x", Some("Main")).unwrap();
        let first = start(&s, None);
        let dup = approve(&s, &first, &tg(7020)).unwrap();
        assert_eq!(dup["created"], true);
        let dup_id = dup["account"]["userId"].as_str().unwrap().to_string();
        s.poll_telegram_login(&first.poll).unwrap();
        s.create_auth_session(&dup_id, 7).unwrap();

        let st = start(&s, Some("main"));
        let peek = s.peek_telegram_login(&st.code, &tg(7020)).unwrap();
        assert_eq!(peek["linkTo"]["displayName"], "Main");
        assert_eq!(
            peek["willMove"], true,
            "the card says the Telegram moves: {peek}"
        );
        assert_eq!(peek["moveFrom"]["displayName"], "Данис Латыпов");
        assert_eq!(peek["willClose"], true, "and that the empty account closes");
        approve(&s, &st, &tg(7020)).unwrap();
        let linked = s.finish_telegram_link(&st.poll, "main").unwrap();
        assert_eq!(linked["status"], "linked");
        assert_eq!(linked["movedFrom"], dup_id.as_str());

        s.with_conn_for_tests(|c| {
            assert_eq!(resolve_tg(c, 7020).as_deref(), Some("main"));
            let sessions: i64 = c
                .query_row(
                    "SELECT count(*) FROM auth_sessions WHERE user_id=?1",
                    [&dup_id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(sessions, 0, "the duplicate's sign-ins end");
            let audits: i64 = c
                .query_row(
                    "SELECT count(*) FROM audit_events WHERE action='identity.relinked'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert!(audits >= 1);
            let old_rows: i64 = c
                .query_row(
                    "SELECT count(*) FROM telegram_logins WHERE user_id=?1",
                    [&dup_id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(
                old_rows, 1,
                "finished logins stay the old account's history"
            );
        });
        let access = s.access_state(&dup_id).unwrap();
        assert_eq!(access.state, "suspended");
        assert_eq!(access.suspend_reason.as_deref(), Some("merged into main"));
        // Signing in with that Telegram opens the real account now.
        let again = approve(&s, &start(&s, None), &tg(7020)).unwrap();
        assert_eq!(again["account"]["userId"], "main");
    }

    #[test]
    fn an_approved_login_not_yet_picked_up_dies_when_its_telegram_moves() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("main", "main@x", None).unwrap();
        let first = start(&s, None);
        approve(&s, &first, &tg(7040)).unwrap();
        s.poll_telegram_login(&first.poll).unwrap();
        // A second sign-in for the duplicate is approved but not collected.
        let pending = start(&s, None);
        approve(&s, &pending, &tg(7040)).unwrap();
        let st = start(&s, Some("main"));
        approve(&s, &st, &tg(7040)).unwrap();
        s.finish_telegram_link(&st.poll, "main").unwrap();
        assert_eq!(
            s.poll_telegram_login(&pending.poll).unwrap()["status"],
            "denied",
            "the old poll token opens neither account"
        );
    }

    #[test]
    fn a_picked_login_mints_no_session_once_its_telegram_moved() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("main", "main@x", None).unwrap();
        let dup = approve(&s, &start(&s, None), &tg(7050)).unwrap();
        let dup_id = dup["account"]["userId"].as_str().unwrap().to_string();
        let login = start(&s, None);
        approve(&s, &login, &tg(7050)).unwrap();
        // Picked, but the session is not minted yet…
        assert_eq!(
            s.poll_telegram_login(&login.poll).unwrap()["status"],
            "approved"
        );
        // …when the Telegram moves to the real account.
        let st = start(&s, Some("main"));
        approve(&s, &st, &tg(7050)).unwrap();
        s.finish_telegram_link(&st.poll, "main").unwrap();
        assert_eq!(
            s.mint_telegram_session(&login.poll, &dup_id, 7)
                .unwrap_err(),
            "identity_moved"
        );
        // A login picked for the current holder still mints.
        let ok = start(&s, None);
        approve(&s, &ok, &tg(7050)).unwrap();
        s.poll_telegram_login(&ok.poll).unwrap();
        assert!(s.mint_telegram_session(&ok.poll, "main", 7).is_ok());
    }

    #[test]
    fn a_duplicate_that_keeps_another_way_in_is_not_suspended() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("main", "main@x", None).unwrap();
        let dup = approve(&s, &start(&s, None), &tg(7030)).unwrap();
        let dup_id = dup["account"]["userId"].as_str().unwrap().to_string();
        s.with_conn_for_tests(|c| {
            identity::link(c, "google", "g-sub", &dup_id, 1).unwrap();
        });
        let st = start(&s, Some("main"));
        approve(&s, &st, &tg(7030)).unwrap();
        s.finish_telegram_link(&st.poll, "main").unwrap();
        assert_eq!(s.access_state(&dup_id).unwrap().state, "waitlist");
        s.with_conn_for_tests(|c| {
            assert_eq!(resolve_tg(c, 7030).as_deref(), Some("main"));
        });
    }

    #[test]
    fn an_approval_is_not_lost_when_the_session_could_not_be_minted() {
        let s = WorkspaceStore::open_memory();
        let st = start(&s, None);
        approve(&s, &st, &tg(7011)).unwrap();
        let first = s.poll_telegram_login(&st.poll).unwrap();
        assert_eq!(first["status"], "approved");
        s.unpick_telegram_login(&st.poll).unwrap();
        let again = s.poll_telegram_login(&st.poll).unwrap();
        assert_eq!(again["status"], "approved");
        assert_eq!(again["userId"], first["userId"]);
    }

    #[test]
    fn one_address_cannot_hold_more_than_a_few_open_logins() {
        let s = WorkspaceStore::open_memory();
        for _ in 0..OPEN_PER_IP {
            start(&s, None);
        }
        assert!(s
            .start_telegram_login(None, "web", "x", Some("203.0.113.7"), Some("203.0.113.7"))
            .unwrap_err()
            .contains("this address"));
        assert!(s
            .start_telegram_login(None, "web", "x", Some("198.51.100.1"), Some("198.51.100.1"))
            .is_ok());
    }

    #[test]
    fn the_numbers_are_distinct_two_digit_ones_with_the_right_one_among_them() {
        for _ in 0..200 {
            let right = two_digits();
            let n: u32 = right.parse().unwrap();
            assert!((10..=99).contains(&n));
            let c = choices(&right);
            assert_eq!(c.len(), CHOICES);
            assert!(c.contains(&right));
            let unique: std::collections::HashSet<&String> = c.iter().collect();
            assert_eq!(unique.len(), CHOICES);
        }
    }

    #[test]
    fn names_are_trimmed_and_usernames_are_only_labels() {
        let t = TgUser::new(5, Some("@Nick"), Some("  "), Some(" Last "));
        assert_eq!(t.name.as_deref(), Some("Last"));
        assert_eq!(label(t.username.as_deref(), "5"), "@Nick");
        let bare = TgUser::new(5, None, None, None);
        assert_eq!(bare.name, None);
        assert_eq!(label(bare.username.as_deref(), "5"), "tg:5");
    }
    /// The list is newest first and capped; `truncated` says how many more.
    #[test]
    fn the_review_list_is_newest_first_and_reports_how_many_were_cut() {
        let s = WorkspaceStore::open_memory();
        let st = start(&s, None);
        let who = tg(7);
        let approved = approve(&s, &st, &who).unwrap();
        let user = approved["account"]["userId"].as_str().unwrap().to_string();
        let team = s.create_organization(&user, "Команда", &user).unwrap();
        let wid = team["workspaceId"].as_str().unwrap().to_string();
        s.poll_telegram_login(&st.poll).unwrap();
        s.mint_telegram_session(&st.poll, &user, 7).unwrap();
        let reference = s.telegram_login_notices(10).unwrap()[0]["ref"]
            .as_str()
            .unwrap()
            .to_string();
        let t0 = now_ms();
        {
            let c = s.conn.lock().unwrap();
            for i in 0..60i64 {
                c.execute(
                    "INSERT INTO audit_events(audit_event_id,workspace_id,actor_user_id,action,target_kind,target_id,metadata_json,created_at) VALUES(?1,?2,?3,'membership.role_changed','member',?4,'{\"role\":\"manager\"}',?5)",
                    params![format!("ev{i}"), wid, user, format!("target-{i}"), t0 + i],
                )
                .unwrap();
            }
        }
        let out = s.revoke_telegram_login_session(&reference, &who).unwrap();
        let review = out.body["review"].as_array().unwrap();
        assert_eq!(review.len(), 50);
        assert_eq!(out.body["truncated"], 10);
        assert_eq!(review[0]["member"], "target-59", "newest first");
        assert_eq!(review[49]["member"], "target-10");
    }
    /// A membership the stolen session's invitation created, then ended, then
    /// re-created another way (a later, legitimate rejoin) is a different
    /// generation: the undo must not remove the rejoined member or their shares.
    #[test]
    fn the_undo_leaves_a_later_rejoin_of_a_removed_invitee_alone() {
        let s = WorkspaceStore::open_memory();
        let st = start(&s, None);
        let who = tg(7);
        let approved = approve(&s, &st, &who).unwrap();
        let user = approved["account"]["userId"].as_str().unwrap().to_string();
        s.ensure_user("new1", "n1@x", None).unwrap();
        let team = s.create_organization(&user, "Команда", &user).unwrap();
        let wid = team["workspaceId"].as_str().unwrap().to_string();
        s.poll_telegram_login(&st.poll).unwrap();
        s.mint_telegram_session(&st.poll, &user, 7).unwrap();
        let reference = s.telegram_login_notices(10).unwrap()[0]["ref"]
            .as_str()
            .unwrap()
            .to_string();
        let i1 = s.invite(&user, &wid, "n1@x", "member").unwrap();
        s.accept_invitation("new1", i1["token"].as_str().unwrap())
            .unwrap();
        {
            let c = s.conn.lock().unwrap();
            // Removed, then back through another path, as a NEW membership row.
            c.execute(
                "DELETE FROM memberships WHERE workspace_id=?1 AND user_id='new1'",
                params![wid],
            )
            .unwrap();
            c.execute(
                "INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?1,'new1','member',?2)",
                params![wid, now_ms() + 5_000],
            )
            .unwrap();
            c.execute("INSERT INTO devices(machine_id,owner_user_id,name,os,agent_version,last_seen,created_at) VALUES('m','new1','M','linux','1',1,1)", []).unwrap();
            c.execute("INSERT INTO project_shares(project_share_id,workspace_id,machine_id,owner_user_id,root,name,created_at) VALUES('sh1',?1,'m','new1','/p','a',1)", params![wid]).unwrap();
        }
        let out = s.revoke_telegram_login_session(&reference, &who).unwrap();
        assert_eq!(out.body["undone"]["membershipsRemoved"], 0);
        let c = s.conn.lock().unwrap();
        let count = |sql: &str| -> i64 { c.query_row(sql, [], |r| r.get(0)).unwrap() };
        let in_team: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM memberships WHERE workspace_id=?1 AND user_id='new1'",
                params![wid],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(in_team, 1, "the rejoined member stays");
        assert_eq!(
            count("SELECT COUNT(*) FROM project_shares WHERE owner_user_id='new1'"),
            1,
            "…with their share"
        );
    }
    /// An invitation with no recorded session (made before `created_session`
    /// existed) after t0 cannot be attributed, so the undo treats it as the
    /// stolen session's: pending withdrawn, created membership removed.
    #[test]
    fn the_undo_treats_an_unattributed_invitation_since_t0_as_stolen() {
        let s = WorkspaceStore::open_memory();
        let st = start(&s, None);
        let who = tg(7);
        let approved = approve(&s, &st, &who).unwrap();
        let user = approved["account"]["userId"].as_str().unwrap().to_string();
        s.ensure_user("new1", "n1@x", None).unwrap();
        let team = s.create_organization(&user, "Команда", &user).unwrap();
        let wid = team["workspaceId"].as_str().unwrap().to_string();
        s.poll_telegram_login(&st.poll).unwrap();
        s.mint_telegram_session(&st.poll, &user, 7).unwrap();
        let reference = s.telegram_login_notices(10).unwrap()[0]["ref"]
            .as_str()
            .unwrap()
            .to_string();
        let i1 = s.invite_from(&user, &wid, "n1@x", "member", None).unwrap();
        s.accept_invitation("new1", i1["token"].as_str().unwrap())
            .unwrap();
        s.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO invitations(invitation_id,workspace_id,email,role,token_hash,created_by,created_at,expires_at) VALUES('legacy',?1,'q@x','member','th9',?2,?3,?4)",
                params![wid, user, now_ms(), now_ms() + 100_000],
            )
            .unwrap();
        let out = s.revoke_telegram_login_session(&reference, &who).unwrap();
        assert_eq!(out.body["undone"]["membershipsRemoved"], 1);
        let c = s.conn.lock().unwrap();
        let count = |sql: &str| -> i64 { c.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert_eq!(
            count("SELECT COUNT(*) FROM invitations WHERE invitation_id='legacy'"),
            0
        );
        let in_team: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM memberships WHERE workspace_id=?1 AND user_id='new1'",
                params![wid],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(in_team, 0);
    }

    #[test]
    fn telegram_username_validation() {
        use crate::workspace::normalize_telegram_username as n;
        assert_eq!(n("@Vasya_Pupkin").as_deref(), Some("vasya_pupkin"));
        assert_eq!(n("  abcde ").as_deref(), Some("abcde"));
        assert_eq!(n("abcd"), None, "too short");
        assert_eq!(n(&"a".repeat(33)), None, "too long");
        assert_eq!(n("ab cde"), None);
        assert_eq!(n("ab-cde"), None);
        assert_eq!(n("пользователь"), None);
        assert_eq!(n("a@b.ru"), None);
    }

    fn owner_with_team(s: &WorkspaceStore) -> String {
        s.ensure_user("boss", "boss@example.com", None).unwrap();
        s.activate_access("boss", "tests").unwrap();
        let team = s.create_organization("boss", "Team", "boss").unwrap();
        team["workspaceId"].as_str().unwrap().to_string()
    }

    fn state_of(s: &WorkspaceStore, user: &str) -> String {
        s.access_state(user).unwrap().state
    }

    fn role_in(s: &WorkspaceStore, wid: &str, user: &str) -> Option<String> {
        s.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT role FROM memberships WHERE workspace_id=?1 AND user_id=?2",
                params![wid, user],
                |r| r.get(0),
            )
            .optional()
            .unwrap()
    }

    #[test]
    fn a_matching_username_invitation_creates_an_active_member_with_identity() {
        crate::edition::with_edition(crate::edition::Edition::External, || {
            let s = WorkspaceStore::open_memory();
            let wid = owner_with_team(&s);
            let inv = s
                .invite_telegram_from("boss", &wid, "@Danis_Latypov", "manager", None)
                .unwrap();
            let st = start(&s, None);
            // tg() presses as `danis_latypov`: case-insensitive match.
            let done = approve(&s, &st, &tg(7100)).unwrap();
            assert_eq!(done["created"], true);
            assert_eq!(done["invitationJoined"], true);
            assert_eq!(done["invitationActivated"], true);
            assert_eq!(done["account"]["state"], "active");
            let uid = done["account"]["userId"].as_str().unwrap().to_string();
            assert_eq!(state_of(&s, &uid), "active");
            assert_eq!(role_in(&s, &wid, &uid).as_deref(), Some("manager"));
            {
                let c = s.conn.lock().unwrap();
                let (by, at, created): (String, Option<i64>, i64) = c
                .query_row(
                    "SELECT accepted_by,accepted_at,created_membership FROM invitations WHERE invitation_id=?1",
                    params![inv["invitationId"].as_str().unwrap()],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .unwrap();
                assert_eq!(by, uid);
                assert!(at.is_some());
                assert_eq!(created, 1);
                let label: String = c
                    .query_row(
                        "SELECT label FROM identities WHERE provider='telegram' AND subject='7100'",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap();
                assert_eq!(label, "@danis_latypov");
                let audits: i64 = c
                .query_row(
                    "SELECT COUNT(*) FROM audit_events WHERE action IN ('invitation.accepted','access.activated') AND target_id IN (?1,?2)",
                    params![uid, inv["invitationId"].as_str().unwrap()],
                    |r| r.get(0),
                )
                .unwrap();
                assert_eq!(audits, 2);
            }
            // The invitation is used up: another account with that username gets
            // the ordinary waitlist.
            let again = approve(&s, &start(&s, None), &tg(7101)).unwrap();
            assert_eq!(again["account"]["state"], "waitlist");
            assert!(again.get("invitationJoined").is_none());
        });
    }

    #[test]
    fn expired_or_foreign_username_invitations_change_nothing() {
        crate::edition::with_edition(crate::edition::Edition::External, || {
            let s = WorkspaceStore::open_memory();
            let wid = owner_with_team(&s);
            let inv = s
                .invite_telegram_from("boss", &wid, "danis_latypov", "member", None)
                .unwrap();
            s.conn
                .lock()
                .unwrap()
                .execute(
                    "UPDATE invitations SET expires_at=1 WHERE invitation_id=?1",
                    params![inv["invitationId"].as_str().unwrap()],
                )
                .unwrap();
            let expired = approve(&s, &start(&s, None), &tg(7200)).unwrap();
            assert_eq!(expired["account"]["state"], "waitlist");
            assert!(expired.get("invitationJoined").is_none());

            s.invite_telegram_from("boss", &wid, "someone_else", "member", None)
                .unwrap();
            let other = approve(&s, &start(&s, None), &tg(7201)).unwrap();
            assert_eq!(other["account"]["state"], "waitlist");
            assert!(other.get("invitationJoined").is_none());
            let uid = other["account"]["userId"].as_str().unwrap();
            assert_eq!(role_in(&s, &wid, uid), None);
        });
    }

    #[test]
    fn a_known_telegram_account_joins_the_team_on_sign_in() {
        crate::edition::with_edition(crate::edition::Edition::External, || {
            let s = WorkspaceStore::open_memory();
            let wid = owner_with_team(&s);
            let first = approve(&s, &start(&s, None), &tg(7300)).unwrap();
            let uid = first["account"]["userId"].as_str().unwrap().to_string();
            assert_eq!(state_of(&s, &uid), "waitlist");
            s.invite_telegram_from("boss", &wid, "danis_latypov", "member", None)
                .unwrap();
            let done = approve(&s, &start(&s, None), &tg(7300)).unwrap();
            assert_eq!(done["created"], false);
            assert_eq!(done["invitationJoined"], true);
            assert_eq!(role_in(&s, &wid, &uid).as_deref(), Some("member"));
            assert_eq!(state_of(&s, &uid), "active");
        });
    }

    #[test]
    fn an_inactive_inviter_does_not_open_access() {
        crate::edition::with_edition(crate::edition::Edition::External, || {
            let s = WorkspaceStore::open_memory();
            let wid = owner_with_team(&s);
            s.invite_telegram_from("boss", &wid, "danis_latypov", "member", None)
                .unwrap();
            s.suspend_access("boss", "tests", None).unwrap();
            let done = approve(&s, &start(&s, None), &tg(7400)).unwrap();
            assert_eq!(done["account"]["state"], "waitlist");
            assert!(done.get("invitationJoined").is_none());
        });
    }

    #[test]
    fn invitation_never_lowers_a_role_and_respects_the_activation_cap() {
        crate::edition::with_edition(crate::edition::Edition::External, || {
            let s = WorkspaceStore::open_memory();
            let wid = owner_with_team(&s);
            let first = approve(&s, &start(&s, None), &tg(7500)).unwrap();
            let uid = first["account"]["userId"].as_str().unwrap().to_string();
            s.conn
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?1,?2,'manager',1)",
                    params![wid, uid],
                )
                .unwrap();
            s.invite_telegram_from("boss", &wid, "danis_latypov", "member", None)
                .unwrap();
            approve(&s, &start(&s, None), &tg(7500)).unwrap();
            assert_eq!(role_in(&s, &wid, &uid).as_deref(), Some("manager"));

            // A cap of zero: joins the team, stays on the waitlist, audited.
            let s = WorkspaceStore::open_memory();
            let wid = owner_with_team(&s);
            s.invite_telegram_from("boss", &wid, "danis_latypov", "member", None)
                .unwrap();
            std::env::set_var("CC_REMOTE_INVITE_ACTIVATIONS_PER_MONTH", "0");
            let done = approve(&s, &start(&s, None), &tg(7501));
            std::env::remove_var("CC_REMOTE_INVITE_ACTIVATIONS_PER_MONTH");
            let done = done.unwrap();
            assert_eq!(done["invitationActivated"], false);
            assert_eq!(done["account"]["state"], "waitlist");
            let refused: i64 = s
                .conn
                .lock()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM audit_events WHERE action='access.activation_refused'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(refused, 1);
        });
    }

    #[test]
    fn internal_edition_ignores_username_invitations() {
        crate::edition::with_edition(crate::edition::Edition::Internal, || {
            let s = WorkspaceStore::open_memory();
            let wid = owner_with_team(&s);
            s.invite_telegram_from("boss", &wid, "danis_latypov", "member", None)
                .unwrap();
            let done = approve(&s, &start(&s, None), &tg(7600)).unwrap();
            assert_eq!(done["account"]["state"], "waitlist");
            assert!(done.get("invitationJoined").is_none());
        });
    }

    #[test]
    fn an_owner_invited_to_their_own_team_still_uses_up_the_invitation() {
        crate::edition::with_edition(crate::edition::Edition::External, || {
            let s = WorkspaceStore::open_memory();
            let wid = owner_with_team(&s);
            let first = approve(&s, &start(&s, None), &tg(7700)).unwrap();
            let uid = first["account"]["userId"].as_str().unwrap().to_string();
            s.conn
                .lock()
                .unwrap()
                .execute(
                    "UPDATE memberships SET role='owner' WHERE workspace_id=?1 AND user_id=?2",
                    params![wid, uid],
                )
                .map(|n| assert_eq!(n, 0))
                .unwrap();
            s.conn
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?1,?2,'owner',1)",
                    params![wid, uid],
                )
                .unwrap();
            let inv = s
                .invite_telegram_from("boss", &wid, "danis_latypov", "member", None)
                .unwrap();
            approve(&s, &start(&s, None), &tg(7700)).unwrap();
            assert_eq!(role_in(&s, &wid, &uid).as_deref(), Some("owner"));
            let accepted: Option<String> = s
                .conn
                .lock()
                .unwrap()
                .query_row(
                    "SELECT accepted_by FROM invitations WHERE invitation_id=?1",
                    params![inv["invitationId"].as_str().unwrap()],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(accepted.as_deref(), Some(uid.as_str()));
        });
    }
}
