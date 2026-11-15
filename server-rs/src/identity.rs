//! Ways to sign in, kept apart from who the person is.
//!
//! Until September 2026 the hub had one way in — HegAI SSO — and used the
//! platform's `userId` as its own primary key: `users.user_id` WAS the HegAI
//! id, and fifteen tables hang off it. That made "someone who is not on the
//! platform" impossible to represent. `identities` breaks the equation without
//! re-keying anything: a row `(provider, subject) → user_id` says which hub
//! account a proven identity opens.
//!
//! - Every account that existed before this table gets `('hegai', user_id)`
//!   once (the backfill below), so an SSO login resolves to exactly the account
//!   it resolved to before — nobody's id moves.
//! - A new HegAI login with no row yet keeps the old rule (hub id = HegAI id)
//!   and records it; see `WorkspaceStore::ensure_user`.
//! - A later provider (Telegram) mints a fresh hub id and links it here.
//!
//! The same migration makes `users.email` optional: a Telegram-only person has
//! no address, and `NOT NULL` would force a fake one — the `@tg.local` rows the
//! hub already carries show where that leads (a fake address can collide with
//! the real one later and break that person's first SSO login for good).

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::workspace::{db_err, insert_audit, now_ms};

/// HegAI platform SSO; `subject` is the platform `user.id` from the SSO claim.
pub(crate) const PROVIDER_HEGAI: &str = "hegai";

const BACKFILL_KEY: &str = "identities_backfill";

/// The `users` shape this migration knows how to copy. Anything else is left
/// alone and reported: guessing at a column we have never seen is how a
/// rebuild silently drops data.
const USERS_COLUMNS: [&str; 4] = ["user_id", "email", "full_name", "created_at"];

/// Runs after `init_access_schema` (it needs `schema_meta`). Idempotent: every
/// step checks the state it is about to change.
pub(crate) fn init_identity_schema(conn: &Connection) -> Result<(), String> {
    make_email_optional(conn)?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS identities (
          provider     TEXT NOT NULL,
          subject      TEXT NOT NULL,
          user_id      TEXT NOT NULL,
          created_at   INTEGER NOT NULL,
          last_used_at INTEGER,
          PRIMARY KEY(provider, subject),
          FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS identities_user ON identities(user_id);
        -- A way in the account's owner removed on purpose. A login that
        -- would otherwise adopt the account by address (Google) must not
        -- quietly re-link it; only an explicit `attach` clears the row.
        CREATE TABLE IF NOT EXISTS identity_unlinks (
          provider    TEXT NOT NULL,
          subject     TEXT NOT NULL,
          user_id     TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
          unlinked_at INTEGER NOT NULL,
          PRIMARY KEY(provider, subject, user_id)
        );
        -- An account emptied by an identity move (`close_merged_account`)
        -- gets no new session, whichever login was already in flight when its
        -- last way in moved (a resolved Google callback, a picked Telegram
        -- poll). An admin's reactivation clears the reason and lifts this.
        CREATE TRIGGER IF NOT EXISTS no_session_for_merged_account
        BEFORE INSERT ON auth_sessions WHEN EXISTS
          (SELECT 1 FROM user_access WHERE user_id=NEW.user_id AND state='suspended'
             AND suspend_reason LIKE 'merged into %')
        BEGIN SELECT RAISE(ABORT, 'account merged into another'); END;
        "#,
    )
    .map_err(db_err)?;
    // What a person recognises the way in by (`@username` for Telegram).
    // Display only — nothing resolves on it. Idempotent: an existing column
    // errors with "duplicate column", ignored on purpose.
    // Checked, not `let _ =`: a failure other than "already there" (a busy
    // database at start) must stop the hub, not leave every Telegram
    // approval failing on a missing column with nothing in the log.
    let has_label: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('identities') WHERE name='label')",
            [],
            |r| r.get(0),
        )
        .map_err(db_err)?;
    if !has_label {
        conn.execute("ALTER TABLE identities ADD COLUMN label TEXT", [])
            .map_err(db_err)?;
    }
    backfill_hegai_identities(conn)
}

/// Every account that predates this table was created by an SSO login (or by
/// the bootstrap seeding, which uses a HegAI id on every real deployment), so
/// its HegAI subject IS its user_id. Recording that keeps resolution exactly
/// as it was. The two synthetic rows on production (`legacy-owner`,
/// `local-owner-timoshin`) get one too: no SSO token will ever carry those
/// subjects, so the row is inert, and skipping them would need a rule for
/// "which ids are real" that nothing else in the hub has.
///
/// Once, keyed in `schema_meta`: a later unlink must not be undone by the
/// next restart.
fn backfill_hegai_identities(conn: &Connection) -> Result<(), String> {
    let done: Option<String> = conn
        .query_row(
            "SELECT value FROM schema_meta WHERE key=?1",
            params![BACKFILL_KEY],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_err)?;
    if done.is_some() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction().map_err(db_err)?;
    let linked = tx
        .execute(
            "INSERT OR IGNORE INTO identities(provider,subject,user_id,created_at) \
             SELECT ?1, user_id, user_id, created_at FROM users",
            params![PROVIDER_HEGAI],
        )
        .map_err(db_err)?;
    tx.execute(
        "INSERT INTO schema_meta(key,value) VALUES(?1,?2)",
        params![BACKFILL_KEY, now_ms().to_string()],
    )
    .map_err(db_err)?;
    tx.commit().map_err(db_err)?;
    println!("[identity] backfill: {linked} account(s) linked to their HegAI id");
    Ok(())
}

/// SQLite cannot drop `NOT NULL` in place; the documented route is a rebuild
/// (https://www.sqlite.org/lang_altertable.html#otheralter). The dangerous
/// step is `DROP TABLE users`: with foreign keys ON it would cascade-delete
/// every session, membership and memory in the hub. So foreign keys are
/// switched off *and read back* before anything is touched — the pragma is
/// silently ignored inside a transaction, and trusting it blind is the one
/// mistake here that cannot be undone.
fn make_email_optional(conn: &Connection) -> Result<(), String> {
    let columns = users_columns(conn)?;
    let Some(email) = columns.iter().find(|c| c.name == "email") else {
        return Err("users table has no email column".to_string());
    };
    if !email.not_null {
        return Ok(());
    }
    let names: Vec<&str> = columns.iter().map(|c| c.name.as_str()).collect();
    if names != USERS_COLUMNS {
        // Fail closed but keep the hub up: email stays required, which is
        // exactly today's behaviour. The Telegram sign-in that needs the
        // relaxed column refuses on its own when it cannot insert.
        eprintln!(
            "[identity] users has columns {names:?}, expected {USERS_COLUMNS:?}; \
             leaving email NOT NULL"
        );
        return Ok(());
    }

    conn.execute_batch("PRAGMA foreign_keys=OFF")
        .map_err(db_err)?;
    let result = rebuild_users(conn);
    // Back on whatever happened: every later statement on this connection
    // relies on cascades. A hub with foreign keys off must not come up, so
    // THIS error still propagates.
    conn.execute_batch("PRAGMA foreign_keys=ON")
        .map_err(db_err)?;
    // A failed rebuild rolled back to the old table, which is exactly
    // today's behaviour; refusing to start over it would turn a missing
    // nicety into an outage on every restart.
    if let Err(e) = result {
        eprintln!("[identity] users rebuild failed, email stays NOT NULL: {e}");
    }
    Ok(())
}

/// Rows `PRAGMA foreign_key_check` reports for the tables that reference
/// `users` — the only references a rebuild of `users` can break.
///
/// Scoped, not whole-database: on the production hub (2.2 GB, 25.09.2026) one
/// unscoped check took 89 s, the rebuild runs two, and the hub does this
/// BEFORE it listens — so `deploy-hub.sh`, which gives a restart 3 s, rolled
/// the release back. The eleven tables that point at `users` check in 0.01 s.
fn fk_violations(conn: &Connection) -> Result<usize, String> {
    let tables: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(db_err)?;
        rows.collect::<Result<_, _>>().map_err(db_err)?
    };
    let mut total = 0;
    for table in tables {
        let refs_users: bool = conn
            .query_row(
                "SELECT count(*) > 0 FROM pragma_foreign_key_list(?1) WHERE \"table\" = 'users' COLLATE NOCASE",
                [&table],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if !refs_users {
            continue;
        }
        let mut stmt = conn
            .prepare("SELECT count(*) FROM pragma_foreign_key_check(?1)")
            .map_err(db_err)?;
        let n: i64 = stmt.query_row([&table], |r| r.get(0)).map_err(db_err)?;
        total += n as usize;
    }
    Ok(total)
}

fn rebuild_users(conn: &Connection) -> Result<(), String> {
    let fk: i64 = conn
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .map_err(db_err)?;
    if fk != 0 {
        return Err("refusing to rebuild users: foreign keys are still on".to_string());
    }
    let before: i64 = conn
        .query_row("SELECT count(*) FROM users", [], |r| r.get(0))
        .map_err(db_err)?;
    // Dangling references that were already there (a row deleted by hand
    // with foreign keys off, say) are not this rebuild's doing; only new ones
    // are.
    let dangling_before = fk_violations(conn)?;
    let tx = conn.unchecked_transaction().map_err(db_err)?;
    tx.execute_batch(
        r#"
        CREATE TABLE users__rebuild (
          user_id TEXT PRIMARY KEY, email TEXT UNIQUE, full_name TEXT, created_at INTEGER NOT NULL
        );
        INSERT INTO users__rebuild(user_id,email,full_name,created_at)
          SELECT user_id,email,full_name,created_at FROM users;
        DROP TABLE users;
        ALTER TABLE users__rebuild RENAME TO users;
        "#,
    )
    .map_err(db_err)?;
    let after: i64 = tx
        .query_row("SELECT count(*) FROM users", [], |r| r.get(0))
        .map_err(db_err)?;
    if after != before {
        return Err(format!(
            "users rebuild copied {after} of {before} rows; rolled back"
        ));
    }
    let dangling = fk_violations(&tx)?;
    if dangling > dangling_before {
        return Err(format!(
            "users rebuild left {dangling} dangling foreign key(s), {dangling_before} before; rolled back"
        ));
    }
    tx.commit().map_err(db_err)?;
    println!("[identity] users.email is optional now ({after} account(s) carried over)");
    Ok(())
}

struct Column {
    name: String,
    not_null: bool,
}

fn users_columns(conn: &Connection) -> Result<Vec<Column>, String> {
    let mut stmt = conn.prepare("PRAGMA table_info(users)").map_err(db_err)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Column {
                name: r.get(1)?,
                not_null: r.get::<_, i64>(3)? != 0,
            })
        })
        .map_err(db_err)?;
    rows.collect::<Result<_, _>>().map_err(db_err)
}

/// Did `user_id` ever give up a `provider` identity on purpose (unlinked, or
/// moved to another account)? Then no login of that provider adopts it by
/// address any more — not the old subject, and not a new one that holds the
/// same address now (a reassigned Workspace mailbox). Linking from inside the
/// account (`attach`) still works.
pub(crate) fn gave_up_provider(
    conn: &Connection,
    provider: &str,
    user_id: &str,
) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM identity_unlinks WHERE provider=?1 AND user_id=?2)",
        params![provider, user_id],
        |r| r.get(0),
    )
    .map_err(db_err)
}

/// The account a proven identity opens, if it has been seen before.
pub(crate) fn resolve(
    conn: &Connection,
    provider: &str,
    subject: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT user_id FROM identities WHERE provider=?1 AND subject=?2",
        params![provider, subject],
        |r| r.get(0),
    )
    .optional()
    .map_err(db_err)
}

/// Record that `(provider, subject)` opens `user_id`, or stamp its use.
/// Never re-points an existing row: a LOGIN must never move an identity
/// between accounts. The one way an identity moves is `attach`, called only
/// when the person proved the identity again from inside the account it is
/// moving to.
pub(crate) fn link(
    conn: &Connection,
    provider: &str,
    subject: &str,
    user_id: &str,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO identities(provider,subject,user_id,created_at,last_used_at) \
         VALUES(?1,?2,?3,?4,?4) \
         ON CONFLICT(provider,subject) DO UPDATE SET last_used_at=excluded.last_used_at",
        params![provider, subject, user_id, now],
    )
    .map_err(db_err)?;
    Ok(())
}

/// Apple Sign in; `subject` is Apple's stable `sub` for this app.
pub(crate) const PROVIDER_APPLE: &str = "apple";

/// Stable refusal codes of `attach` / `unlink` — the API maps them to a
/// status, the clients to words. Anything else `Err` is a database failure.
pub(crate) const OWNER_HAS_DATA: &str = "identity_owner_has_data";
pub(crate) const LAST_IDENTITY: &str = "last_identity";
pub(crate) const NOT_LINKED: &str = "not_linked";
pub(crate) const TARGET_DELETING: &str = "account_deleting";
pub(crate) const APPLE_TOKEN_CHANGED: &str = "apple_token_changed";
pub(crate) const IDENTITY_MOVED: &str = "identity_moved";
pub(crate) const BOOTSTRAP_HEGAI: &str = "bootstrap_hegai";

/// What `attach` did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Attached {
    /// The identity opened nobody; it opens `target` now.
    New,
    /// It already opened `target`; only its use was stamped.
    AlreadyHere,
    /// It opened `from`, an account with nothing of its own, and was moved.
    /// `suspended`: `from` had no other way in left and was closed.
    Moved { from: String, suspended: bool },
}

/// Does `user_id` hold anything beyond the bare account a login creates — its
/// personal workspace, its access row, its sign-ins? Machines, sessions,
/// teams, memory, reports, a sandbox or a gateway seat, or an erasure in
/// progress all count: moving an identity away from such an account would
/// hand the person a different account than the one their work lives in,
/// and merging work between accounts is not something a sign-in does.
pub(crate) fn account_has_data(conn: &Connection, user_id: &str) -> Result<bool, String> {
    let personal = format!("personal:{user_id}");
    let own: [&str; 8] = [
        "SELECT EXISTS(SELECT 1 FROM devices WHERE owner_user_id=?1)",
        "SELECT EXISTS(SELECT 1 FROM session_owners WHERE owner_user_id=?1)",
        "SELECT EXISTS(SELECT 1 FROM pending_session_runs WHERE owner_user_id=?1)",
        "SELECT EXISTS(SELECT 1 FROM project_shares WHERE owner_user_id=?1)",
        "SELECT EXISTS(SELECT 1 FROM memories WHERE owner_user_id=?1 AND deleted=0)",
        "SELECT EXISTS(SELECT 1 FROM reports WHERE owner_user_id=?1)",
        // A live sandbox or gateway key: resources that would outlive the
        // account unseen. A failed or revoked one is history, not data.
        "SELECT EXISTS(SELECT 1 FROM user_access WHERE user_id=?1 AND \
         (sandbox_status IN ('queued','ready','suspended') OR sandbox_machine_id IS NOT NULL \
          OR seat_status IN ('pending','ready')))",
        "SELECT EXISTS(SELECT 1 FROM account_deletions WHERE user_id=?1)",
    ];
    for sql in own {
        let found: bool = conn
            .query_row(sql, params![user_id], |r| r.get(0))
            .map_err(db_err)?;
        if found {
            return Ok(true);
        }
    }
    // Teams: any membership or ownership beyond the personal workspace.
    let beyond_personal: [&str; 2] = [
        "SELECT EXISTS(SELECT 1 FROM memberships WHERE user_id=?1 AND workspace_id<>?2)",
        "SELECT EXISTS(SELECT 1 FROM workspaces WHERE owner_user_id=?1 AND workspace_id<>?2)",
    ];
    for sql in beyond_personal {
        let found: bool = conn
            .query_row(sql, params![user_id, personal], |r| r.get(0))
            .map_err(db_err)?;
        if found {
            return Ok(true);
        }
    }
    Ok(false)
}

fn deletion_pending(conn: &Connection, user_id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM account_deletions WHERE user_id=?1)",
        params![user_id],
        |r| r.get(0),
    )
    .map_err(db_err)
}

/// Attach `(provider, subject)` to `target` — the signed-in account whose
/// session proved the identity just now. Run inside the caller's transaction.
///
/// This is the ONE place an identity row is re-pointed (see `link`). The
/// case it exists for: someone signed in with Telegram, Google or Apple
/// before linking them, and each first login created an empty account of its
/// own (`tg-…`, `g-…`, `apple-…`). Proving that identity again from the
/// account they actually work in moves it there, along with the state that
/// belongs to the identity rather than to an account (Apple's revocation
/// token, the Telegram login rows). An account left with no way in at all is
/// suspended with the reason «merged into <target>», its sign-ins end and its
/// address is released, so nothing keeps resolving to it.
///
/// An account that holds anything of its own (`account_has_data`) is never
/// emptied this way: `OWNER_HAS_DATA`, and nothing changes.
pub(crate) fn attach(
    conn: &Connection,
    provider: &str,
    subject: &str,
    target: &str,
    label: Option<&str>,
    now: i64,
) -> Result<Attached, String> {
    if deletion_pending(conn, target)? {
        return Err(TARGET_DELETING.into());
    }
    // Proven again from inside THIS account: an earlier unlink from it is
    // undone. Unlinks recorded for other accounts stay.
    conn.execute(
        "DELETE FROM identity_unlinks WHERE provider=?1 AND subject=?2 AND user_id=?3",
        params![provider, subject, target],
    )
    .map_err(db_err)?;
    let holder = resolve(conn, provider, subject)?;
    let outcome = match holder {
        None => {
            link(conn, provider, subject, target, now)?;
            if let Some(ws) = crate::access::audit_workspace_in(conn, target)? {
                insert_audit(
                    conn,
                    &ws,
                    target,
                    "identity.linked",
                    "user",
                    target,
                    &json!({"provider": provider}),
                )?;
            }
            Attached::New
        }
        Some(h) if h == target => {
            link(conn, provider, subject, target, now)?;
            Attached::AlreadyHere
        }
        Some(from) => {
            if account_has_data(conn, &from)? {
                return Err(OWNER_HAS_DATA.into());
            }
            conn.execute(
                "UPDATE identities SET user_id=?3,created_at=?4,last_used_at=?4 \
                 WHERE provider=?1 AND subject=?2",
                params![provider, subject, target, now],
            )
            .map_err(db_err)?;
            if provider == PROVIDER_APPLE {
                conn.execute(
                    "UPDATE apple_tokens SET user_id=?2 WHERE subject=?1",
                    params![subject, target],
                )
                .map_err(db_err)?;
            }
            if provider == crate::telegram_login::PROVIDER_TELEGRAM {
                // Finished logins stay the history of the account they opened.
                // One approved for `from` but not yet picked up dies: its poll
                // token must not open anything now.
                conn.execute(
                    "UPDATE telegram_logins SET denied_at=?3,denied_reason='identity_moved' \
                     WHERE telegram_id=?1 AND user_id=?2 AND picked_at IS NULL AND denied_at IS NULL",
                    params![subject, from, now],
                )
                .map_err(db_err)?;
            }
            // `from` gave this identity up: a later login must not hand `from`
            // back to it by address either.
            conn.execute(
                "INSERT OR REPLACE INTO identity_unlinks(provider,subject,user_id,unlinked_at) VALUES(?1,?2,?3,?4)",
                params![provider, subject, from, now],
            )
            .map_err(db_err)?;
            let left: i64 = conn
                .query_row(
                    "SELECT count(*) FROM identities WHERE user_id=?1",
                    params![from],
                    |r| r.get(0),
                )
                .map_err(db_err)?;
            let suspended = left == 0;
            if suspended {
                close_merged_account(conn, &from, target, now)?;
            }
            let meta = json!({
                "provider": provider,
                "from": from,
                "to": target,
                "fromSuspended": suspended,
            });
            for (ws_of, actor) in [(target, target), (from.as_str(), target)] {
                if let Some(ws) = crate::access::audit_workspace_in(conn, ws_of)? {
                    insert_audit(conn, &ws, actor, "identity.relinked", "user", ws_of, &meta)?;
                }
            }
            println!("[identity] {provider} identity moved from {from} to {target} (suspended={suspended})");
            Attached::Moved { from, suspended }
        }
    };
    if let Some(label) = label {
        conn.execute(
            "UPDATE identities SET label=?3 WHERE provider=?1 AND subject=?2",
            params![provider, subject, label],
        )
        .map_err(db_err)?;
    }
    Ok(outcome)
}

/// The empty duplicate an identity just left: no way in remains, so it is
/// suspended (the access gate refuses it everywhere), its live sign-ins end,
/// and its address is released — a suspended account must not keep an
/// address another login would be matched to.
fn close_merged_account(
    conn: &Connection,
    from: &str,
    target: &str,
    now: i64,
) -> Result<(), String> {
    let reason = format!("merged into {target}");
    conn.execute(
        "INSERT OR IGNORE INTO user_access(user_id,state,plan,requested_at,updated_at) \
         VALUES(?1,'suspended','community',?2,?2)",
        params![from, now],
    )
    .map_err(db_err)?;
    conn.execute(
        "UPDATE user_access SET state='suspended',suspended_at=?2,suspended_by=?3,suspend_reason=?4,updated_at=?2 \
         WHERE user_id=?1",
        params![from, now, target, reason],
    )
    .map_err(db_err)?;
    conn.execute("DELETE FROM auth_sessions WHERE user_id=?1", params![from])
        .map_err(db_err)?;
    // An unused machine enrollment code would still mint a device for it.
    conn.execute(
        "DELETE FROM enrollments WHERE user_id=?1 AND used_at IS NULL",
        params![from],
    )
    .map_err(db_err)?;
    conn.execute(
        "UPDATE users SET email=NULL WHERE user_id=?1",
        params![from],
    )
    .map_err(db_err)?;
    Ok(())
}

/// Every way into `user_id`, oldest first, for «Способы входа».
pub(crate) fn list(conn: &Connection, user_id: &str) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT provider,subject,label,created_at,last_used_at FROM identities \
             WHERE user_id=?1 ORDER BY created_at ASC, provider ASC",
        )
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![user_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, Option<i64>>(4)?,
            ))
        })
        .map_err(db_err)?;
    let mut out = Vec::new();
    for row in rows {
        let (provider, subject, label, linked_at, last_used) = row.map_err(db_err)?;
        let mut v = json!({"provider": provider, "subject": subject, "linkedAt": linked_at});
        // Absent, never null (the wire rule).
        if let Some(label) = label {
            v["label"] = json!(label);
        }
        if let Some(t) = last_used {
            v["lastUsedAt"] = json!(t);
        }
        out.push(v);
    }
    Ok(out)
}

/// Remove ways into `user_id`: one `(provider, subject)`, or every identity of
/// `provider` when `subject` is `None`. Refuses to leave the account with no
/// way in at all (`LAST_IDENTITY`). Returns the removed subjects. Apple's
/// stored revocation tokens go with their identities — the caller revokes
/// them at Apple BEFORE calling this.
pub(crate) fn unlink(
    conn: &Connection,
    user_id: &str,
    provider: &str,
    subject: Option<&str>,
    revoked_apple: &[(String, String)],
) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT provider,subject FROM identities WHERE user_id=?1")
        .map_err(db_err)?;
    let all: Vec<(String, String)> = stmt
        .query_map(params![user_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(db_err)?
        .collect::<Result<_, _>>()
        .map_err(db_err)?;
    let removed: Vec<String> = all
        .iter()
        .filter(|(p, s)| p == provider && subject.is_none_or(|want| want == s))
        .map(|(_, s)| s.clone())
        .collect();
    if removed.is_empty() {
        return Err(NOT_LINKED.into());
    }
    if removed.len() == all.len() {
        return Err(LAST_IDENTITY.into());
    }
    if provider == PROVIDER_APPLE {
        // Only what the caller revoked at Apple may go: a token stored by an
        // exchange that landed meanwhile would be lost unrevoked.
        let mut stmt = conn
            .prepare("SELECT subject,encrypted_refresh FROM apple_tokens WHERE user_id=?1")
            .map_err(db_err)?;
        let mut current: Vec<(String, String)> = stmt
            .query_map(params![user_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?
            .into_iter()
            .filter(|(s, _): &(String, String)| removed.contains(s))
            .collect();
        let mut revoked = revoked_apple.to_vec();
        current.sort();
        revoked.sort();
        if current != revoked {
            return Err(APPLE_TOKEN_CHANGED.into());
        }
    }
    for s in &removed {
        conn.execute(
            "DELETE FROM identities WHERE provider=?1 AND subject=?2 AND user_id=?3",
            params![provider, s, user_id],
        )
        .map_err(db_err)?;
        conn.execute(
            "INSERT OR REPLACE INTO identity_unlinks(provider,subject,user_id,unlinked_at) VALUES(?1,?2,?3,?4)",
            params![provider, s, user_id, now_ms()],
        )
        .map_err(db_err)?;
        if provider == PROVIDER_APPLE {
            conn.execute(
                "DELETE FROM apple_tokens WHERE subject=?1 AND user_id=?2",
                params![s, user_id],
            )
            .map_err(db_err)?;
        }
        if provider == crate::telegram_login::PROVIDER_TELEGRAM {
            // An approved sign-in not yet collected must not open the account
            // after its Telegram was removed.
            conn.execute(
                "UPDATE telegram_logins SET denied_at=?3,denied_reason='identity_unlinked' \
                 WHERE telegram_id=?1 AND user_id=?2 AND picked_at IS NULL AND denied_at IS NULL",
                params![s, user_id, now_ms()],
            )
            .map_err(db_err)?;
        }
    }
    if let Some(ws) = crate::access::audit_workspace_in(conn, user_id)? {
        insert_audit(
            conn,
            &ws,
            user_id,
            "identity.unlinked",
            "user",
            user_id,
            &json!({"provider": provider, "count": removed.len()}),
        )?;
    }
    Ok(removed)
}

impl crate::workspace::WorkspaceStore {
    /// Mint a sign-in session for `user_id`, checking in the SAME transaction
    /// that the identity which proved the login still opens it — an unlink or
    /// a move may have landed between the provider's answer and here.
    /// `None` skips the check (paths with no provider identity).
    #[cfg(test)]
    pub fn create_auth_session_for(
        &self,
        identity: Option<(&str, &str)>,
        user_id: &str,
        ttl_days: i64,
    ) -> Result<String, String> {
        self.create_auth_session_for_as(identity, user_id, ttl_days, crate::mfa::Factor::Unproven)
            .map(|(token, _)| token)
    }

    /// `create_auth_session_for` for a path that may have checked a second
    /// factor itself (`Factor::Proven`); says whether the session is pending.
    pub fn create_auth_session_for_as(
        &self,
        identity: Option<(&str, &str)>,
        user_id: &str,
        ttl_days: i64,
        factor: crate::mfa::Factor,
    ) -> Result<(String, bool), String> {
        let Some((provider, subject)) = identity else {
            return self.create_auth_session_as(user_id, ttl_days, factor);
        };
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        if resolve(&tx, provider, subject)?.as_deref() != Some(user_id) {
            return Err(IDENTITY_MOVED.into());
        }
        let token = crate::workspace::opaque_token();
        let pending = self.mfa_pending_in(&tx, user_id, factor);
        tx.execute(
            "INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at,mfa_pending) VALUES(?1,?2,?3,?4,?5)",
            params![
                crate::workspace::hash_token(&token),
                user_id,
                now + ttl_days * 24 * 60 * 60 * 1000,
                now,
                pending
            ],
        )
        .map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok((token, pending == 1))
    }

    /// Which account `(provider, subject)` opens now, if any.
    pub fn identity_holder(&self, provider: &str, subject: &str) -> Result<Option<String>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        resolve(&conn, provider, subject)
    }

    /// «Способы входа» of the signed-in account.
    pub fn identities(&self, user_id: &str) -> Result<Vec<Value>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        list(&conn, user_id)
    }

    /// `attach` in its own transaction — for providers whose proof arrives in
    /// one request (Google's callback). Telegram and Apple attach inside
    /// their own transactions, next to the state they also write.
    pub fn attach_identity(
        &self,
        provider: &str,
        subject: &str,
        target: &str,
        label: Option<&str>,
    ) -> Result<Attached, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let out = attach(&tx, provider, subject, target, label, now_ms())?;
        tx.commit().map_err(db_err)?;
        Ok(out)
    }

    /// The stored Apple revocation tokens `unlink_identity` would drop, so
    /// the caller can revoke them at Apple first.
    pub fn apple_tokens_for(
        &self,
        user_id: &str,
        subject: Option<&str>,
    ) -> Result<Vec<(String, String)>, String> {
        Ok(self
            .apple_tokens(user_id)?
            .into_iter()
            .filter(|(s, _)| subject.is_none_or(|want| want == s))
            .collect())
    }

    /// `revoked_apple`: the Apple tokens the caller revoked first (what
    /// `apple_tokens_for` answered); anything else stored refuses the unlink.
    pub fn unlink_identity(
        &self,
        user_id: &str,
        provider: &str,
        subject: Option<&str>,
        revoked_apple: &[(String, String)],
    ) -> Result<Vec<String>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let out = unlink(&tx, user_id, provider, subject, revoked_apple)?;
        tx.commit().map_err(db_err)?;
        Ok(out)
    }

    /// Would `unlink_identity` refuse? Checked before Apple is asked to
    /// revoke anything, so a refused unlink never revokes a live token.
    pub fn check_unlink(
        &self,
        user_id: &str,
        provider: &str,
        subject: Option<&str>,
    ) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        unlink(&tx, user_id, provider, subject, &[])
            .map(|_| ())
            .or_else(|e| {
                if e == APPLE_TOKEN_CHANGED {
                    Ok(())
                } else {
                    Err(e)
                }
            })
        // dropped without commit: a dry run
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::{EnsureUserError, WorkspaceStore};

    struct TempDb(std::path::PathBuf);
    impl TempDb {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!(
                "cc-remote-identity-{}.sqlite3",
                uuid::Uuid::new_v4()
            )))
        }
        fn raw(&self) -> Connection {
            Connection::open(&self.0).unwrap()
        }
    }
    impl Drop for TempDb {
        fn drop(&mut self) {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", self.0.display()));
            }
        }
    }

    /// The pre-September shape: `email NOT NULL`, and the children whose
    /// `ON DELETE CASCADE` a careless `DROP TABLE users` would fire.
    fn seed_old_schema(db: &TempDb) {
        db.raw()
            .execute_batch(
                r#"
                PRAGMA foreign_keys=ON;
                CREATE TABLE users (
                  user_id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, full_name TEXT, created_at INTEGER NOT NULL
                );
                CREATE TABLE workspaces (
                  workspace_id TEXT PRIMARY KEY, name TEXT NOT NULL,
                  kind TEXT NOT NULL CHECK(kind IN ('personal','organization')),
                  owner_user_id TEXT NOT NULL, created_at INTEGER NOT NULL,
                  FOREIGN KEY(owner_user_id) REFERENCES users(user_id)
                );
                CREATE TABLE memberships (
                  workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
                  role TEXT NOT NULL CHECK(role IN ('owner','manager','member')),
                  created_at INTEGER NOT NULL,
                  PRIMARY KEY(workspace_id,user_id),
                  FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
                  FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
                );
                CREATE TABLE auth_sessions (
                  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
                  created_at INTEGER NOT NULL, FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
                );
                INSERT INTO users VALUES('11111111-aaaa','a@x','A',1),('local-synthetic','s@tg.local',NULL,2);
                INSERT INTO workspaces VALUES('personal:11111111-aaaa','Моя работа','personal','11111111-aaaa',1);
                INSERT INTO memberships VALUES('personal:11111111-aaaa','11111111-aaaa','owner',1);
                INSERT INTO auth_sessions VALUES('h1','11111111-aaaa',9999999999999,1),('h2','local-synthetic',9999999999999,1);
                "#,
            )
            .unwrap();
    }

    fn email_not_null(conn: &Connection) -> bool {
        users_columns(conn)
            .unwrap()
            .into_iter()
            .find(|c| c.name == "email")
            .unwrap()
            .not_null
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn an_old_database_keeps_every_row_and_child_when_email_becomes_optional() {
        let db = TempDb::new();
        seed_old_schema(&db);
        assert!(email_not_null(&db.raw()));

        let store = WorkspaceStore::open(&db.0).unwrap();
        let conn = db.raw();
        assert!(
            !email_not_null(&conn),
            "email is optional after the rebuild"
        );
        assert_eq!(count(&conn, "SELECT count(*) FROM users"), 2);
        // The children a cascading DROP would have wiped.
        assert_eq!(count(&conn, "SELECT count(*) FROM auth_sessions"), 2);
        assert_eq!(count(&conn, "SELECT count(*) FROM memberships"), 1);
        assert_eq!(
            conn.prepare("PRAGMA foreign_key_check")
                .unwrap()
                .query_map([], |_| Ok(()))
                .unwrap()
                .count(),
            0
        );
        // Every existing account opens with its own id as its HegAI subject.
        let mut pairs: Vec<(String, String)> = conn
            .prepare(
                "SELECT subject,user_id FROM identities WHERE provider='hegai' ORDER BY subject",
            )
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        pairs.sort();
        assert_eq!(
            pairs,
            vec![
                ("11111111-aaaa".to_string(), "11111111-aaaa".to_string()),
                ("local-synthetic".to_string(), "local-synthetic".to_string()),
            ]
        );
        // Cascades are live again on the store's own connection — the one
        // every later statement uses: deleting a user through it takes that
        // user's sessions along, as before the rebuild.
        store.with_conn_for_tests(|c| {
            let fk: i64 = c
                .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
                .unwrap();
            assert_eq!(fk, 1);
            c.execute(
                "DELETE FROM user_access WHERE user_id='local-synthetic'",
                [],
            )
            .unwrap();
            c.execute("DELETE FROM identities WHERE user_id='local-synthetic'", [])
                .unwrap();
            c.execute("DELETE FROM users WHERE user_id='local-synthetic'", [])
                .unwrap();
            assert_eq!(count(c, "SELECT count(*) FROM auth_sessions"), 1);
        });
        assert_eq!(
            store
                .ensure_user("11111111-aaaa", "a@x", None)
                .unwrap()
                .user_id,
            "11111111-aaaa"
        );
    }

    #[test]
    fn the_migration_and_the_backfill_run_once() {
        let db = TempDb::new();
        seed_old_schema(&db);
        drop(WorkspaceStore::open(&db.0).unwrap());
        // An unlinked identity must stay unlinked across a restart.
        db.raw()
            .execute("DELETE FROM identities WHERE subject='local-synthetic'", [])
            .unwrap();
        drop(WorkspaceStore::open(&db.0).unwrap());
        let conn = db.raw();
        assert_eq!(count(&conn, "SELECT count(*) FROM identities"), 1);
        assert_eq!(count(&conn, "SELECT count(*) FROM users"), 2);
        assert_eq!(count(&conn, "SELECT count(*) FROM auth_sessions"), 2);
    }

    #[test]
    fn a_fresh_database_is_born_with_optional_email_and_allows_many_without_one() {
        let db = TempDb::new();
        drop(WorkspaceStore::open(&db.0).unwrap());
        let conn = db.raw();
        assert!(!email_not_null(&conn));
        conn.execute_batch(
            "INSERT INTO users(user_id,email,created_at) VALUES('t1',NULL,1),('t2',NULL,1)",
        )
        .unwrap();
        assert_eq!(
            count(&conn, "SELECT count(*) FROM users WHERE email IS NULL"),
            2
        );
    }

    #[test]
    fn a_login_resolves_through_its_identity_and_records_new_ones() {
        let store = WorkspaceStore::open_memory();
        // Unseen subject: the old rule, hub id = HegAI id, and it is recorded.
        let first = store.ensure_user("hegai-1", "one@x", Some("One")).unwrap();
        assert_eq!(first.user_id, "hegai-1");
        store.with_conn_for_tests(|c| {
            assert_eq!(
                resolve(c, PROVIDER_HEGAI, "hegai-1").unwrap().as_deref(),
                Some("hegai-1")
            );
        });

        // A subject linked to a different hub account opens THAT account and
        // creates nothing under the subject's own id.
        let store = WorkspaceStore::open_memory();
        store.ensure_user("hub-1", "linked@x", None).unwrap();
        store.with_conn_for_tests(|c| {
            link(c, PROVIDER_HEGAI, "hegai-9", "hub-1", 1).unwrap();
        });
        let again = store
            .ensure_user("hegai-9", "linked@x", Some("Linked"))
            .unwrap();
        assert_eq!(again.user_id, "hub-1");
        store.with_conn_for_tests(|c| {
            assert_eq!(
                count(c, "SELECT count(*) FROM users WHERE user_id='hegai-9'"),
                0
            );
            assert_eq!(
                c.query_row(
                    "SELECT full_name FROM users WHERE user_id='hub-1'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
                "Linked"
            );
        });
    }

    #[test]
    fn an_address_held_by_another_account_is_refused_and_nothing_is_written() {
        let store = WorkspaceStore::open_memory();
        store.ensure_user("a", "shared@x", None).unwrap();
        let err = store.ensure_user("b", "Shared@X", Some("B")).unwrap_err();
        assert_eq!(
            err,
            EnsureUserError::EmailTaken {
                email: "shared@x".into(),
                holder: "a".into()
            }
        );
        store.with_conn_for_tests(|c| {
            assert_eq!(count(c, "SELECT count(*) FROM users WHERE user_id='b'"), 0);
            assert_eq!(
                count(c, "SELECT count(*) FROM identities WHERE subject='b'"),
                0
            );
            assert_eq!(
                count(
                    c,
                    "SELECT count(*) FROM workspaces WHERE workspace_id='personal:b'"
                ),
                0
            );
        });
        // The holder itself still signs in, including under a changed case.
        assert_eq!(
            store.ensure_user("a", "SHARED@x", None).unwrap().user_id,
            "a"
        );
    }

    #[test]
    fn a_dangling_reference_from_before_does_not_block_the_rebuild() {
        let db = TempDb::new();
        seed_old_schema(&db);
        // A session whose user was deleted by hand with foreign keys off.
        db.raw()
            .execute_batch(
                "PRAGMA foreign_keys=OFF; \
                 INSERT INTO auth_sessions VALUES('orphan','gone-user',9999999999999,1);",
            )
            .unwrap();
        drop(WorkspaceStore::open(&db.0).unwrap());
        let conn = db.raw();
        assert!(!email_not_null(&conn), "the rebuild still happened");
        assert_eq!(count(&conn, "SELECT count(*) FROM auth_sessions"), 3);
        assert_eq!(
            fk_violations(&conn).unwrap(),
            1,
            "nothing new, nothing hidden"
        );
    }

    #[test]
    fn a_failed_rebuild_rolls_back_and_the_hub_still_starts() {
        let db = TempDb::new();
        seed_old_schema(&db);
        // Make the rebuild's CREATE fail.
        db.raw()
            .execute_batch("CREATE TABLE users__rebuild(x)")
            .unwrap();
        let store = WorkspaceStore::open(&db.0).expect("the hub comes up anyway");
        let conn = db.raw();
        assert!(email_not_null(&conn), "old table kept");
        assert_eq!(count(&conn, "SELECT count(*) FROM users"), 2);
        assert_eq!(count(&conn, "SELECT count(*) FROM auth_sessions"), 2);
        store.with_conn_for_tests(|c| {
            let fk: i64 = c
                .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
                .unwrap();
            assert_eq!(fk, 1, "cascades back on after the failure");
        });
        assert_eq!(
            store
                .ensure_user("11111111-aaaa", "a@x", None)
                .unwrap()
                .user_id,
            "11111111-aaaa"
        );
    }

    #[test]
    fn a_matching_id_does_not_open_an_account_linked_some_other_way() {
        let store = WorkspaceStore::open_memory();
        store.ensure_user("x", "x@x", None).unwrap();
        // Unlinked from HegAI, reachable only through another provider now.
        store.with_conn_for_tests(|c| {
            c.execute(
                "DELETE FROM identities WHERE provider='hegai' AND subject='x'",
                [],
            )
            .unwrap();
            link(c, "telegram", "12345", "x", 1).unwrap();
        });
        assert_eq!(
            store.ensure_user("x", "x@x", None).unwrap_err(),
            EnsureUserError::Unlinked {
                user_id: "x".into()
            }
        );
        store.with_conn_for_tests(|c| {
            assert_eq!(
                resolve(c, PROVIDER_HEGAI, "x").unwrap(),
                None,
                "the unlink held"
            );
        });
    }

    #[test]
    fn an_account_written_by_an_older_binary_is_adopted_and_linked() {
        let store = WorkspaceStore::open_memory();
        // A rollback to the pre-identities binary creates users with no row here.
        store.with_conn_for_tests(|c| {
            c.execute(
                "INSERT INTO users(user_id,email,created_at) VALUES('old-bin','o@x',1)",
                [],
            )
            .unwrap();
        });
        assert_eq!(
            store.ensure_user("old-bin", "o@x", None).unwrap().user_id,
            "old-bin"
        );
        store.with_conn_for_tests(|c| {
            assert_eq!(
                resolve(c, PROVIDER_HEGAI, "old-bin").unwrap().as_deref(),
                Some("old-bin")
            );
        });
    }

    #[test]
    fn an_address_stored_before_normalization_still_counts_as_taken() {
        let store = WorkspaceStore::open_memory();
        store.with_conn_for_tests(|c| {
            c.execute(
                "INSERT INTO users(user_id,email,created_at) VALUES('legacy',' Foo@X ',1)",
                [],
            )
            .unwrap();
        });
        assert!(matches!(
            store.ensure_user("other", "foo@x", None).unwrap_err(),
            EnsureUserError::EmailTaken { holder, .. } if holder == "legacy"
        ));
    }

    /// An account the way a Telegram sign-in will create it: no address.
    fn account_without_email(store: &WorkspaceStore, id: &str, name: &str) {
        store
            .ensure_user(id, &format!("{id}@placeholder"), Some(name))
            .unwrap();
        store.with_conn_for_tests(|c| {
            c.execute("UPDATE users SET email=NULL WHERE user_id=?1", [id])
                .unwrap();
        });
    }

    #[test]
    fn an_account_without_email_stays_in_the_admin_list_and_can_be_activated() {
        let store = WorkspaceStore::open_memory();
        store
            .ensure_user("with", "with@x", Some("With Mail"))
            .unwrap();
        account_without_email(&store, "tg-1", "Данис");
        let rows = store.access_rows(None, 50, 0).unwrap();
        let tg = rows
            .iter()
            .find(|r| r["userId"] == "tg-1")
            .expect("the row is listed, not silently dropped");
        assert!(tg.get("email").is_none(), "absent, never null: {tg}");
        assert_eq!(tg["fullName"], "Данис");
        assert_eq!(rows.len(), 2);
        assert!(store.activate_access("tg-1", "admin").unwrap());
        assert_eq!(store.user_email("tg-1"), None);
    }

    #[test]
    fn an_account_without_email_is_listed_as_a_member_and_as_the_viewer() {
        let store = WorkspaceStore::open_memory();
        store
            .ensure_user("owner", "owner@x", Some("Owner"))
            .unwrap();
        account_without_email(&store, "tg-2", "Без Почты");
        let team = store.create_organization("owner", "Team", "owner").unwrap();
        let ws = team["workspaceId"].as_str().unwrap().to_string();
        store.with_conn_for_tests(|c| {
            c.execute(
                "INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?1,'tg-2','member',1)",
                [&ws],
            )
            .unwrap();
        });
        let members = store.members("owner", &ws).unwrap();
        assert_eq!(
            members.len(),
            2,
            "one address-less member must not sink the list"
        );
        let tg = members.iter().find(|m| m["userId"] == "tg-2").unwrap();
        assert!(tg.get("email").is_none());
        assert_eq!(tg["fullName"], "Без Почты");

        let viewer = store.ui_access("tg-2", None, false).unwrap().viewer;
        assert!(
            viewer.get("email").is_none(),
            "absent, never null: {viewer}"
        );
        assert_eq!(viewer["userId"], "tg-2");
        let owner = store.user_json("tg-2").unwrap().unwrap();
        assert!(owner.get("email").is_none());
    }

    #[test]
    fn an_account_without_email_cannot_take_an_emailed_invitation() {
        let store = WorkspaceStore::open_memory();
        store.ensure_user("owner", "owner@x", None).unwrap();
        account_without_email(&store, "tg-3", "T");
        let team = store.create_organization("owner", "Team", "owner").unwrap();
        let invite = store
            .invite(
                "owner",
                team["workspaceId"].as_str().unwrap(),
                "someone@x",
                "member",
            )
            .unwrap();
        let err = store
            .accept_invitation("tg-3", invite["token"].as_str().unwrap())
            .unwrap_err();
        assert_eq!(err, "invitation belongs to another email");
    }

    #[test]
    fn unlink_refuses_the_last_way_in_and_removes_the_others() {
        let store = WorkspaceStore::open_memory();
        store.ensure_user("u", "u@x", None).unwrap();
        // Only the HegAI identity: removing it would lock the account out.
        assert_eq!(
            store
                .unlink_identity("u", PROVIDER_HEGAI, None, &[])
                .unwrap_err(),
            LAST_IDENTITY
        );
        assert_eq!(
            store.unlink_identity("u", "google", None, &[]).unwrap_err(),
            NOT_LINKED
        );
        store
            .attach_identity("google", "g1", "u", Some("u@gmail.com"))
            .unwrap();
        store.attach_identity("google", "g2", "u", None).unwrap();
        let listed = store.identities("u").unwrap();
        assert_eq!(listed.len(), 3);
        let g1 = listed.iter().find(|v| v["subject"] == "g1").unwrap();
        assert_eq!(g1["label"], "u@gmail.com");
        assert!(g1["linkedAt"].as_i64().is_some());
        let hegai = listed.iter().find(|v| v["provider"] == "hegai").unwrap();
        assert!(hegai.get("label").is_none(), "absent, never null: {hegai}");
        // One subject, then the provider as a whole.
        assert_eq!(
            store
                .unlink_identity("u", "google", Some("g1"), &[])
                .unwrap(),
            vec!["g1".to_string()]
        );
        // A dry run changes nothing.
        store.check_unlink("u", "google", None).unwrap();
        assert_eq!(store.identities("u").unwrap().len(), 2);
        store.unlink_identity("u", "google", None, &[]).unwrap();
        assert_eq!(
            store
                .unlink_identity("u", PROVIDER_HEGAI, None, &[])
                .unwrap_err(),
            LAST_IDENTITY
        );
        store.with_conn_for_tests(|c| {
            assert_eq!(resolve(c, "google", "g2").unwrap(), None);
            assert_eq!(
                count(
                    c,
                    "SELECT count(*) FROM audit_events WHERE action='identity.unlinked'"
                ),
                2
            );
        });
    }

    #[test]
    fn an_identity_whose_account_has_a_team_is_not_moved() {
        let store = WorkspaceStore::open_memory();
        store.ensure_user("main", "main@x", None).unwrap();
        store.ensure_user("other", "other@x", None).unwrap();
        store.create_organization("other", "Team", "other").unwrap();
        store.with_conn_for_tests(|c| {
            link(c, "google", "g-other", "other", 1).unwrap();
            assert!(account_has_data(c, "other").unwrap());
            assert!(!account_has_data(c, "main").unwrap());
        });
        assert_eq!(
            store
                .attach_identity("google", "g-other", "main", None)
                .unwrap_err(),
            OWNER_HAS_DATA
        );
        store.with_conn_for_tests(|c| {
            assert_eq!(
                resolve(c, "google", "g-other").unwrap().as_deref(),
                Some("other")
            );
        });
        assert_eq!(store.access_state("other").unwrap().state, "waitlist");
        // Attaching what is already here only stamps it.
        assert_eq!(
            store
                .attach_identity("hegai", "main", "main", None)
                .unwrap(),
            Attached::AlreadyHere
        );
    }

    #[test]
    fn a_live_seat_or_sandbox_counts_as_data_and_a_revoked_one_does_not() {
        let store = WorkspaceStore::open_memory();
        store.ensure_user("dup", "dup@x", None).unwrap();
        store.with_conn_for_tests(|c| {
            c.execute(
                "INSERT OR IGNORE INTO user_access(user_id,state,plan,requested_at,updated_at) \
                 VALUES('dup','active','community',1,1)",
                [],
            )
            .unwrap();
            for (seat, sandbox, data) in [
                ("none", "none", false),
                ("inactive", "failed", false),
                ("ready", "none", true),
                ("none", "ready", true),
            ] {
                c.execute(
                    "UPDATE user_access SET seat_status=?1,sandbox_status=?2 WHERE user_id='dup'",
                    params![seat, sandbox],
                )
                .unwrap();
                assert_eq!(
                    account_has_data(c, "dup").unwrap(),
                    data,
                    "{seat}/{sandbox}"
                );
            }
        });
    }

    #[test]
    fn a_session_is_minted_only_while_its_identity_still_opens_the_account() {
        let store = WorkspaceStore::open_memory();
        store.ensure_user("u", "u@x", None).unwrap();
        store.attach_identity("google", "g1", "u", None).unwrap();
        assert!(store
            .create_auth_session_for(Some(("google", "g1")), "u", 7)
            .is_ok());
        // Unlinked between the provider's answer and the mint.
        store.unlink_identity("u", "google", None, &[]).unwrap();
        assert_eq!(
            store
                .create_auth_session_for(Some(("google", "g1")), "u", 7)
                .unwrap_err(),
            IDENTITY_MOVED
        );
        assert!(store
            .create_auth_session_for(Some((PROVIDER_HEGAI, "u")), "u", 7)
            .is_ok());
    }
}
