use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::access::{
    ENROLLMENTS_PER_HOUR, ENROLLMENT_RATE_ERR, MAX_PENDING_INVITATIONS, MEMBER_CAP_ERR,
};

#[derive(Clone)]
pub struct WorkspaceStore {
    pub(crate) conn: Arc<Mutex<Connection>>,
    pub(crate) privacy_guard: Option<std::path::PathBuf>,
    /// User ids reported `active/employee` whatever their `user_access` row says:
    /// the bootstrap owner and every platform admin. Set once at startup from
    /// the environment (`set_always_active`); shared by every clone.
    pub(crate) always_active: Arc<RwLock<HashSet<String>>>,
    /// Who must prove a second factor at sign-in (`mfa.rs`). Set once at
    /// startup; shared by every clone.
    pub(crate) mfa: Arc<crate::mfa::MfaPolicy>,
    /// Open support grants (`support_access.rs`): empty unless an owner opened
    /// one. Shared by every clone.
    pub(crate) support: crate::support_access::SharedSupport,
    /// A gateway can be read, so «Расходы» exists. Set once at startup
    /// (`enable_llm_usage`) before the store is cloned; carried in every viewer
    /// (/api/me AND the socket snapshot, which replaces it in the web).
    pub(crate) llm_usage: bool,
}

#[derive(Clone, Debug)]
pub struct UiAccess {
    pub user_id: String,
    pub workspace_id: String,
    pub role: String,
    pub kind: String,
    /// `waitlist` | `active` | `suspended` — cached here so the hub loop can
    /// gate a browser message without a database hit per frame.
    pub access_state: String,
    pub viewer: Value,
    /// Set on a connection opened with a service UI pass (`ui_scope` on its
    /// `auth_sessions` row): a NARROWING on top of the normal ACL. See
    /// `UiScope` and `WorkspaceStore::machine_access`.
    pub ui_scope: Option<UiScope>,
}

impl UiAccess {
    pub fn is_active(&self) -> bool {
        self.access_state == "active"
    }

    /// The same person, confined to `scope`: the scope is attached and the
    /// viewer's workspace list shrinks to the one workspace the pass is for
    /// (the page behind a pass has no business learning the person's other
    /// teams).
    pub fn with_scope(mut self, scope: UiScope) -> Self {
        let selected = self
            .viewer
            .get("workspace")
            .cloned()
            .filter(Value::is_object);
        if let Some(selected) = selected {
            self.viewer["workspaces"] = json!([selected]);
        }
        self.ui_scope = Some(scope);
        self
    }
}

/// What a UI pass minted by a service key (`POST /api/service/ui-tokens`) is
/// confined to: the key's workspace, its machines, and the restricted shares
/// strictly under its `rootPrefix` that the person is listed on. Carried by
/// the connection (`UiAccess::ui_scope`), so every question the hub asks about
/// it is answered inside this fence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UiScope {
    pub issuer: String,
    pub workspace_id: String,
    pub machine_ids: Vec<String>,
    pub root_prefix: String,
}

/// The `ui_scope` value of a service UI pass in `auth_sessions`.
pub(crate) const UI_SCOPE_SERVICE: &str = "service-ui";

/// The `ui_scope` value of an Apple Watch session (`POST /api/watch/session`):
/// an ordinary `authenticate` refuses it, so it opens nothing but the two
/// endpoints that call `authenticate_watch` (`/api/watch/inbox`,
/// `/api/push-action`), never `/ui` and never another HTTP route.
pub(crate) const UI_SCOPE_WATCH: &str = "watch";
/// Live watch sessions a person may hold; minting another ends the oldest.
pub(crate) const WATCH_SESSIONS_MAX: i64 = 3;

/// A service UI pass, resolved: who it is for and which key issued it.
#[derive(Clone, Debug)]
pub(crate) struct UiPass {
    pub user_id: String,
    pub issuer: String,
    pub workspace_id: String,
}

#[derive(Clone, Debug, Default)]
pub struct MachineAccess {
    pub can_view: bool,
    pub can_control: bool,
    /// May start and drive sessions (a control-share member) without full machine
    /// control. Always true when `can_control` is true. False for view-only access.
    pub can_start: bool,
    /// Restrict visible sessions to those owned by a workspace member other than
    /// the device owner (hides the owner's own + legacy/unowned sessions). Set for
    /// control-share members; false for owners/managers (their view is unchanged).
    pub owner_scoped: bool,
    /// None means every cwd on the machine is visible; Some is a bounded set of
    /// shared roots (an empty vec means the machine is not visible).
    pub roots: Option<Vec<String>>,
    /// Subset of `roots` shared with `visibility='everyone'`: inside these the
    /// device owner's own sessions are visible too (a community team working
    /// on one sandbox). Empty for the employee model, where the owner's work
    /// stays private. Only meaningful when `owner_scoped`.
    pub open_roots: Vec<String>,
    /// Where a viewer without full control may START sessions and read files:
    /// every share root for a member, only the shares they are listed on for a
    /// workspace owner or manager (`WorkspaceStore::machine_access`).
    pub start_roots: Vec<String>,
    /// Roots of restricted shares on this machine the viewer is NOT admitted
    /// to. Nothing inside one is reachable, whatever broader share they are in.
    pub denied_roots: Vec<String>,
    /// Roots of EVERY restricted share the viewer is not listed on — the
    /// denied ones plus those a workspace owner may still SEE. Nobody works in
    /// (starts, drives, reads files of) one without being on its list.
    pub unlisted_roots: Vec<String>,
    /// Roots of restricted shares the viewer IS listed on: a nested one beats a
    /// broader denied root.
    pub reopen_roots: Vec<String>,
}

impl MachineAccess {
    /// Is `path` inside a restricted share this viewer is shut out of? The
    /// deepest restricted root containing it decides: a nested restricted share
    /// the viewer is on reopens it, a broader share never does.
    pub fn path_denied(&self, path: &str) -> bool {
        restricted_path_denied(path, &self.denied_roots, &self.reopen_roots)
    }

    /// Does the folder `path` CONTAIN a restricted root this viewer is shut out
    /// of? A session whose working folder is above one can read it from disk, so
    /// such a folder is no more theirs than the root itself.
    pub fn contains_denied(&self, path: &str) -> bool {
        self.denied_roots
            .iter()
            .any(|denied| path_is_within(denied, path))
    }

    /// Is `path` a working folder (of a session) closed to this viewer: inside a
    /// denied root, or above one?
    pub fn session_path_denied(&self, path: &str) -> bool {
        self.path_denied(path) || self.contains_denied(path)
    }

    /// Is `path` inside what this viewer may see as a SESSION's folder (their
    /// roots, and neither inside nor above a restricted share they are shut out
    /// of)? Full-control viewers have no roots.
    pub fn allows_path(&self, path: &str) -> bool {
        !self.session_path_denied(path)
            && self
                .roots
                .as_ref()
                .is_none_or(|roots| roots.iter().any(|root| path_is_within(path, root)))
    }

    /// Is `path` somewhere a viewer without full control may START (or drive) a
    /// session: in `start_roots`, and neither inside nor above a restricted
    /// share they are shut out of?
    pub fn allows_start_path(&self, path: &str) -> bool {
        self.allows_read_path(path)
            && !self
                .unlisted_roots
                .iter()
                .any(|root| path_is_within(root, path))
    }

    /// Is `path` inside a restricted share the viewer is not LISTED on — even
    /// one a workspace owner may see? (Working there needs the list.)
    pub fn path_closed_for_work(&self, path: &str) -> bool {
        restricted_path_denied(path, &self.unlisted_roots, &self.reopen_roots)
    }

    /// Is `path` somewhere such a viewer may BROWSE and read files: in
    /// `start_roots` and not inside a restricted share they are not listed on.
    /// (Listing a folder above one is fine — the file RPCs judge the path they
    /// reach into separately.)
    pub fn allows_read_path(&self, path: &str) -> bool {
        !self.path_closed_for_work(path)
            && self
                .start_roots
                .iter()
                .any(|root| path_is_within(path, root))
    }
}

/// The folder a file RPC really touches: `rel` as the agent resolves it. An
/// absolute `rel` (POSIX `/…`, UNC or `\…`, or a drive `X:`) stands on its own;
/// anything else is joined onto `dir`. Lexical, like every check here.
pub(crate) fn requested_path(dir: &str, rel: &str) -> String {
    let rel = rel.trim();
    let bytes = rel.as_bytes();
    let absolute = rel.starts_with('/')
        || rel.starts_with('\\')
        || (bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic());
    if rel.is_empty() {
        dir.to_string()
    } else if absolute {
        rel.to_string()
    } else {
        format!("{}/{}", dir.trim_end_matches(['/', '\\']), rel)
    }
}

/// Adds the immutable service markers to `auth_sessions`. The moment they are
/// added is a migration boundary: a session minted by a service key BEFORE it
/// carried them cannot be re-checked or revoked by issuer, so those are ended
/// (the `label` they were minted with may since have been replaced by a device
/// name, and the one-shot row swept, so they are found by what is permanent:
/// the `auth.service_signin` audit row of the person — every session of such a
/// person is ended, once; the `service:` label and the not-yet-swept one-shot
/// row are matched too). The service sign-in shipped together with these
/// columns, so none should exist in practice. A later start finds the columns
/// present and touches nothing.
///
/// All of it — the columns and the clean-up — happens in ONE transaction and
/// every error propagates (a failed clean-up must not leave the columns in
/// place, or it would never be retried).
pub(crate) fn migrate_service_session_columns(conn: &Connection) -> Result<(), String> {
    let has = |column: &str| -> Result<bool, String> {
        conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('auth_sessions') WHERE name=?1",
            params![column],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n > 0)
        .map_err(db_err)
    };
    // Either column being new is the boundary.
    let (issuer, workspace) = (has("service_issuer")?, has("service_workspace_id")?);
    if issuer && workspace {
        return Ok(());
    }
    let tx = conn.unchecked_transaction().map_err(db_err)?;
    if !issuer {
        tx.execute(
            "ALTER TABLE auth_sessions ADD COLUMN service_issuer TEXT",
            [],
        )
        .map_err(db_err)?;
    }
    if !workspace {
        tx.execute(
            "ALTER TABLE auth_sessions ADD COLUMN service_workspace_id TEXT",
            [],
        )
        .map_err(db_err)?;
    }
    // Anyone who EVER got a session through a service key left a permanent
    // `auth.service_signin` audit row (an entry from before the outcome was
    // recorded, or `issued`; people only redirected to sign in themselves never
    // had one from the key), which neither the label nor the swept one-shot row
    // can claim to be. Those people lose every session once and sign in again;
    // everyone else is untouched.
    tx.execute(
        "DELETE FROM auth_sessions WHERE label LIKE 'service:%' \
         OR user_id IN (SELECT target_id FROM audit_events WHERE action='auth.service_signin' AND COALESCE(json_extract(metadata_json,'$.outcome'),'issued')='issued') \
         OR EXISTS(SELECT 1 FROM signin_links l WHERE l.user_id=auth_sessions.user_id AND l.used_at=auth_sessions.created_at AND l.expires_at IS NOT NULL)",
        [],
    )
    .map_err(db_err)?;
    tx.commit().map_err(db_err)
}

/// Adds `auth_sessions.ui_scope`: NULL for every ordinary session,
/// `service-ui` for a pass minted by `POST /api/service/ui-tokens`. Additive
/// and idempotent; existing rows keep NULL, i.e. stay exactly what they were.
pub(crate) fn migrate_ui_scope_column(conn: &Connection) -> Result<(), String> {
    let present: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('auth_sessions') WHERE name='ui_scope'",
            [],
            |r| r.get(0),
        )
        .map_err(db_err)?;
    if present == 0 {
        conn.execute("ALTER TABLE auth_sessions ADD COLUMN ui_scope TEXT", [])
            .map_err(db_err)?;
    }
    Ok(())
}

/// Why a folder that a list closed cannot simply be published again.
/// A private machine's content is ciphertext to the hub (docs/E2EE.md): there
/// is nothing a teammate could read, and a share would only suggest otherwise.
pub(crate) const PRIVATE_MACHINE_ERR: &str = "private_machine: the content of a private machine is end-to-end encrypted and cannot be shared with the team.";
pub(crate) const RESTRICTED_ROOT_ERR: &str = "Папка закрыта списком: откройте её через интеграцию или снимите ограничение (отзовите пустую запись о ней ещё раз).";

/// The rule behind `MachineAccess::path_denied`: the deepest denied restricted
/// root containing `path` closes it unless a STRICTLY deeper restricted root
/// the viewer is listed on reopens it. Equal depth stays closed.
pub(crate) fn restricted_path_denied(path: &str, denied: &[String], reopen: &[String]) -> bool {
    let deepest = |roots: &[String]| {
        roots
            .iter()
            .filter(|root| path_is_within(path, root))
            .map(|root| normalize_root(root).len())
            .max()
    };
    match deepest(denied) {
        None => false,
        Some(closed) => deepest(reopen).is_none_or(|open| open <= closed),
    }
}

/// Whether a session is visible to a viewer with the given machine access.
/// - full control (`can_control`) or non-owner-scoped access → everything;
/// - owner-scoped (control-share member) → every session under an
///   `open_roots` entry (an `everyone` share), else only sessions owned by a
///   member who is NOT the device owner. Unowned (legacy) sessions outside an
///   open root are therefore hidden.
pub fn session_visible(
    access: &MachineAccess,
    session_owner: Option<&str>,
    device_owner: Option<&str>,
    cwd: Option<&str>,
) -> bool {
    if access.can_control || !access.owner_scoped {
        return true;
    }
    if cwd.is_some_and(|cwd| {
        access
            .open_roots
            .iter()
            .any(|root| path_is_within(cwd, root))
    }) {
        return true;
    }
    matches!(session_owner, Some(o) if Some(o) != device_owner)
}

#[derive(Clone, Debug)]
pub struct DeviceCredential {
    pub machine_id: String,
    pub user_id: String,
}

/// One memory file, owned by a user and replicated to the machines its scope
/// covers. `content` is populated only by `read_memory`; `memory_catalog`
/// leaves it None so a catalog exchange stays cheap as the corpus grows — the
/// agent diffs on `content_sha256` and fetches only what actually changed.
#[derive(Clone, Debug)]
pub struct MemoryRecord {
    /// Filled from the row for completeness; no reader keys on it yet (the
    /// catalog is addressed by scope), which is why clippy sees it as dead.
    #[allow(dead_code)]
    pub owner_user_id: String,
    pub scope: String,
    pub scope_key: String,
    pub path: String,
    pub content: Option<String>,
    pub content_sha256: String,
    pub revision: i64,
    pub updated_at: i64,
    /// Body size in bytes, so clients can show what a corpus costs without
    /// fetching every body. Zero on rows read by `read_memory`, which already
    /// carries the content itself.
    pub bytes: i64,
    /// Tombstone marker. Only `memory_catalog` ever reports this true — the
    /// agent needs it to stop re-pushing a deleted note. Views meant for people
    /// (`memory_list`) filter tombstones out instead.
    pub deleted: bool,
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn sha256_hex(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// However much a session is used, it ends this long after sign-in.
pub(crate) const SESSION_MAX_MS: i64 = 180 * 24 * 60 * 60 * 1000;

pub(crate) fn hash_token(token: &str) -> String {
    sha256_hex(token)
}

/// How a service UI pass is stored: under its OWN hash domain, not the one of
/// ordinary sessions. The `ui_scope` column already keeps a pass from being a
/// session here; the separate domain keeps it from being one on a hub that does
/// not know the column (a rollback to an earlier binary), where the same hash
/// would otherwise be a full sign-in.
pub(crate) fn hash_ui_pass(token: &str) -> String {
    sha256_hex(&format!("service-ui:{token}"))
}

pub(crate) fn opaque_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

/// A Telegram username as people type it (`@name` or `name`), validated the
/// way Telegram does (5-32 of `A-Za-z0-9_`) and lowercased for matching.
pub(crate) fn normalize_telegram_username(raw: &str) -> Option<String> {
    let name = raw.trim().trim_start_matches('@');
    let ok = (5..=32).contains(&name.len())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    ok.then(|| name.to_ascii_lowercase())
}

pub(crate) fn normalize_email(email: &str) -> String {
    email.trim().to_ascii_lowercase()
}

/// A user's address into a JSON object — or nothing. Accounts without one
/// (Telegram-only, since identities) exist, and the wire rule is that an
/// optional field is ABSENT, never `null` (zod `optional` rejects null).
pub(crate) fn put_email(v: &mut Value, email: Option<String>) {
    if let Some(e) = email {
        v["email"] = Value::String(e);
    }
}

/// A SQLite failure as the stores' `String` error. The mark is what lets an
/// HTTP handler keep the text out of a response (`store_failure` in main.rs):
/// it names tables and columns.
pub(crate) fn db_err(e: rusqlite::Error) -> String {
    format!("{}{e}", crate::DB_ERROR_MARK)
}

/// A positive integer from the environment, else the default. Used for the
/// community caps so a wave can be retuned without a rebuild.
pub(crate) fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(default)
}

/// What an SSO login resolved to; see `WorkspaceStore::ensure_user`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnsuredUser {
    /// The hub account the login opened — sessions, hooks and audit use this,
    /// never the raw SSO subject.
    pub user_id: String,
    pub claimed_preauth: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnsureUserError {
    /// The address belongs to another hub account.
    EmailTaken {
        email: String,
        holder: String,
    },
    /// An account with this id exists but is not linked to this HegAI
    /// subject (unlinked, or created by another way of signing in).
    Unlinked {
        user_id: String,
    },
    Db(String),
}

impl From<String> for EnsureUserError {
    fn from(e: String) -> Self {
        Self::Db(e)
    }
}

impl std::fmt::Display for EnsureUserError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmailTaken { email, .. } => {
                write!(f, "{email} already belongs to another account")
            }
            Self::Unlinked { user_id } => {
                write!(f, "account {user_id} is not linked to this HegAI login")
            }
            Self::Db(e) => f.write_str(e),
        }
    }
}

impl From<EnsureUserError> for String {
    fn from(e: EnsureUserError) -> Self {
        e.to_string()
    }
}

/// `(machine_id, session_id, owner_user_id, category, stage, origin)`.
pub(crate) type SessionMetaRows = Vec<(
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
)>;

impl WorkspaceStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(db_err)?;
        // The replica store holds a second connection on the same file, and an
        // agent's inventory write landing during an access mutation surfaced as
        // "database is locked" in the wave smoke. WAL lets the readers through;
        // the writers still queue, so give them a few seconds instead of failing.
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(db_err)?;
        let store = Self {
            conn: Arc::new(Mutex::new(conn)),
            privacy_guard: None,
            always_active: Arc::new(RwLock::new(HashSet::new())),
            mfa: Default::default(),
            llm_usage: false,
            support: crate::support_access::new_registry(),
        };
        store.init()?;
        Ok(store)
    }

    #[cfg(test)]
    pub fn open_memory() -> Self {
        let store = Self {
            conn: Arc::new(Mutex::new(Connection::open_in_memory().unwrap())),
            privacy_guard: None,
            always_active: Arc::new(RwLock::new(HashSet::new())),
            mfa: Default::default(),
            llm_usage: false,
            support: crate::support_access::new_registry(),
        };
        store.init().unwrap();
        store
    }

    #[cfg(test)]
    pub(crate) fn with_conn_for_tests<T>(&self, f: impl FnOnce(&Connection) -> T) -> T {
        f(&self.conn.lock().unwrap())
    }

    pub(crate) fn init(&self) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys=ON;
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS users (
              user_id TEXT PRIMARY KEY, email TEXT UNIQUE, full_name TEXT, created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS workspaces (
              workspace_id TEXT PRIMARY KEY, name TEXT NOT NULL,
              kind TEXT NOT NULL CHECK(kind IN ('personal','organization')),
              owner_user_id TEXT NOT NULL, created_at INTEGER NOT NULL,
              FOREIGN KEY(owner_user_id) REFERENCES users(user_id)
            );
            CREATE TABLE IF NOT EXISTS memberships (
              workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
              role TEXT NOT NULL CHECK(role IN ('owner','manager','member')),
              created_at INTEGER NOT NULL,
              PRIMARY KEY(workspace_id,user_id),
              FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
              FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS auth_sessions (
              token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
              created_at INTEGER NOT NULL, FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS signin_links (
              jti_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, used_at INTEGER NOT NULL,
              FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS invitations (
              invitation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, email TEXT NOT NULL,
              role TEXT NOT NULL CHECK(role IN ('manager','member')), token_hash TEXT NOT NULL UNIQUE,
              created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
              accepted_by TEXT, accepted_at INTEGER,
              FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS devices (
              machine_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, name TEXT NOT NULL,
              os TEXT NOT NULL, agent_version TEXT NOT NULL, last_seen INTEGER NOT NULL,
              created_at INTEGER NOT NULL, revoked_at INTEGER,
              FOREIGN KEY(owner_user_id) REFERENCES users(user_id)
            );
            CREATE TABLE IF NOT EXISTS device_credentials (
              credential_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
              created_at INTEGER NOT NULL, revoked_at INTEGER,
              FOREIGN KEY(machine_id) REFERENCES devices(machine_id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS enrollments (
              code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL,
              expires_at INTEGER NOT NULL, used_at INTEGER,
              FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS project_shares (
              project_share_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, machine_id TEXT NOT NULL,
              owner_user_id TEXT NOT NULL, root TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL,
              access TEXT NOT NULL DEFAULT 'view',
              restricted INTEGER NOT NULL DEFAULT 0,
              UNIQUE(workspace_id,machine_id,root),
              FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
              FOREIGN KEY(machine_id) REFERENCES devices(machine_id) ON DELETE CASCADE
            );
            -- Who may use a share. NO rows = the whole team, as before; any rows =
            -- only these people (plus the workspace owner and the device owner).
            -- `role` is a label for the interface, the rights are equal.
            CREATE TABLE IF NOT EXISTS project_share_members (
              project_share_id TEXT NOT NULL, user_id TEXT NOT NULL,
              role TEXT NOT NULL CHECK(role IN ('lead','member','partner')),
              added_at INTEGER NOT NULL,
              PRIMARY KEY(project_share_id,user_id),
              FOREIGN KEY(project_share_id) REFERENCES project_shares(project_share_id) ON DELETE CASCADE,
              FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS project_share_members_user ON project_share_members(user_id);
            CREATE TABLE IF NOT EXISTS session_owners (
              machine_id TEXT NOT NULL, session_id TEXT NOT NULL,
              owner_user_id TEXT NOT NULL, category TEXT, created_at INTEGER NOT NULL,
              stage TEXT,
              PRIMARY KEY(machine_id,session_id),
              FOREIGN KEY(owner_user_id) REFERENCES users(user_id)
            );
            CREATE TABLE IF NOT EXISTS manager_assignments (
              workspace_id TEXT NOT NULL, manager_user_id TEXT NOT NULL,
              target_kind TEXT NOT NULL CHECK(target_kind IN ('member','project')),
              target_id TEXT NOT NULL, created_at INTEGER NOT NULL,
              PRIMARY KEY(workspace_id,manager_user_id,target_kind,target_id),
              FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS audit_events (
              audit_event_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, actor_user_id TEXT NOT NULL,
              action TEXT NOT NULL, target_kind TEXT NOT NULL, target_id TEXT NOT NULL,
              metadata_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL,
              FOREIGN KEY(workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS audit_workspace_recent ON audit_events(workspace_id,created_at DESC);
            CREATE INDEX IF NOT EXISTS project_shares_machine ON project_shares(machine_id,workspace_id);
            CREATE TABLE IF NOT EXISTS memories (
              memory_id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL,
              scope TEXT NOT NULL CHECK(scope IN ('fleet','machine','project')),
              scope_key TEXT NOT NULL DEFAULT '',
              path TEXT NOT NULL, content TEXT NOT NULL, content_sha256 TEXT NOT NULL,
              revision INTEGER NOT NULL DEFAULT 1, deleted INTEGER NOT NULL DEFAULT 0,
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
              UNIQUE(owner_user_id,scope,scope_key,path),
              FOREIGN KEY(owner_user_id) REFERENCES users(user_id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS memories_owner_scope ON memories(owner_user_id,scope,scope_key,deleted);
            "#,
        ).map_err(db_err)?;
        // Idempotent migration: DBs created before the `access` column predate
        // control-shares. Fresh DBs already have it (CREATE TABLE above), so this
        // errors with "duplicate column" — ignored on purpose.
        let _ = conn.execute(
            "ALTER TABLE project_shares ADD COLUMN access TEXT NOT NULL DEFAULT 'view'",
            [],
        );
        // When a service sign-in token's row may be forgotten (NULL = never:
        // the operator links keep theirs for as long as their `exp` may be).
        let _ = conn.execute("ALTER TABLE signin_links ADD COLUMN expires_at INTEGER", []);
        // A restricted share is closed to everyone not on its list. The flag is
        // its own column — NOT «has list rows» — so deleting the last listed
        // person (an account erasure cascades) cannot reopen the share.
        let _ = conn.execute(
            "ALTER TABLE project_shares ADD COLUMN restricted INTEGER NOT NULL DEFAULT 0",
            [],
        );
        // A share that already carries list rows was meant to be closed.
        conn.execute(
            "UPDATE project_shares SET restricted=1 WHERE restricted=0 AND EXISTS(SELECT 1 FROM project_share_members m WHERE m.project_share_id=project_shares.project_share_id)",
            [],
        )
        .map_err(db_err)?;
        // Whether accepting the invitation INSERTED the membership (a brand-new
        // member) rather than changing an existing one's role. The Telegram
        // sign-in undo removes exactly the memberships it created. Rows from
        // before this column read 0: unknown, so never removed.
        let _ = conn.execute(
            "ALTER TABLE invitations ADD COLUMN created_membership INTEGER NOT NULL DEFAULT 0",
            [],
        );
        // The session that issued the invitation (token hash), so an undo of a
        // phished sign-in touches only that session's invitations. NULL for
        // rows from before the column and for invitations made without one.
        let _ = conn.execute(
            "ALTER TABLE invitations ADD COLUMN created_session TEXT",
            [],
        );
        // An invitation addressed to a Telegram @username instead of an e-mail
        // (lowercase, no `@`). Such a row keeps `email` = '' (the column is
        // NOT NULL and an empty address never matches an account).
        let _ = conn.execute(
            "ALTER TABLE invitations ADD COLUMN telegram_username TEXT",
            [],
        );
        // Idempotent migration: the kanban `stage` column postdates `session_owners`.
        // Fresh DBs already have it (CREATE TABLE above) → "duplicate column", ignored.
        let _ = conn.execute("ALTER TABLE session_owners ADD COLUMN stage TEXT", []);
        // Sign-in sessions a person can see and end (profile → «Где я вошёл»):
        // what the device called itself and when it was last used.
        let _ = conn.execute("ALTER TABLE auth_sessions ADD COLUMN label TEXT", []);
        let _ = conn.execute("ALTER TABLE auth_sessions ADD COLUMN last_seen INTEGER", []);
        // A session minted by a service key (`service_api.rs`) remembers which
        // key and workspace vouched for it. Unlike `label` these are never
        // rewritten by `note_session`, so a rotation can revoke exactly these
        // sessions, and every use re-checks that the person is still the plain
        // member the key may sign in.
        migrate_service_session_columns(&conn)?;
        migrate_ui_scope_column(&conn)?;
        crate::mfa::migrate_session_columns(&conn)?;
        // A service-minted session is void for good the moment its person stops
        // being a plain member — in the same statement that changes them, not at
        // the next time somebody happens to check, so removing and re-adding, or
        // promoting and demoting, cannot bring it back. (The current-state check
        // in `authenticate` stays as defence in depth; becoming an administrator
        // is not in the database, so only that check covers it.)
        //
        // That is the rule for a service SIGN-IN (a browser session). A UI pass
        // (`ui_scope` set) lives by a wider one — any role, any other team, a
        // device of their own change nothing about what the fence lets it
        // reach — so only leaving the workspace ends it here
        // (`service_sessions_member_left`); the other four skip it, and
        // `ui_scope_holds` is its current-state check. The four are re-created
        // on every start so a database that has the earlier, unqualified
        // versions gets the qualified ones.
        conn.execute_batch(
            "DROP TRIGGER IF EXISTS service_sessions_role_changed;
             DROP TRIGGER IF EXISTS service_sessions_joined_a_team;
             DROP TRIGGER IF EXISTS service_sessions_got_a_device;
             DROP TRIGGER IF EXISTS service_sessions_got_a_device_back;
             CREATE TRIGGER IF NOT EXISTS service_sessions_member_left AFTER DELETE ON memberships
             BEGIN
               DELETE FROM auth_sessions WHERE user_id=OLD.user_id AND service_workspace_id=OLD.workspace_id;
             END;
             CREATE TRIGGER service_sessions_role_changed AFTER UPDATE OF role ON memberships
             WHEN NEW.role<>'member'
             BEGIN
               DELETE FROM auth_sessions WHERE user_id=NEW.user_id AND service_workspace_id=NEW.workspace_id AND ui_scope IS NULL;
             END;
             CREATE TRIGGER service_sessions_joined_a_team AFTER INSERT ON memberships
             WHEN (SELECT kind FROM workspaces WHERE workspace_id=NEW.workspace_id)<>'personal'
             BEGIN
               DELETE FROM auth_sessions WHERE user_id=NEW.user_id AND service_workspace_id IS NOT NULL AND service_workspace_id<>NEW.workspace_id AND ui_scope IS NULL;
             END;
             CREATE TRIGGER service_sessions_got_a_device AFTER INSERT ON devices
             BEGIN
               DELETE FROM auth_sessions WHERE user_id=NEW.owner_user_id AND service_workspace_id IS NOT NULL AND ui_scope IS NULL;
             END;
             CREATE TRIGGER service_sessions_got_a_device_back AFTER UPDATE OF owner_user_id,revoked_at ON devices
             WHEN NEW.revoked_at IS NULL
             BEGIN
               DELETE FROM auth_sessions WHERE user_id=NEW.owner_user_id AND service_workspace_id IS NOT NULL AND ui_scope IS NULL;
             END;",
        )
        .map_err(db_err)?;
        // Community rollout: access states, self-serve teams, device kinds.
        // Same idempotent style; see access.rs for the DDL and the backfill.
        crate::access::init_access_schema(&conn)?;
        // Ways to sign in, apart from the account (identity.rs). Last: the
        // backfill reads `schema_meta`, which the access schema creates.
        crate::identity::init_identity_schema(&conn)?;
        // The task board («Доска»): cards the hourly assembler writes and the
        // web reads. Hub-owned DDL so a fresh hub serves an empty board.
        crate::board::init_board_schema(&conn)?;
        crate::telegram_login::init_schema(&conn)?;
        crate::github_login::init_schema(&conn)?;
        crate::github_grant::init_schema(&conn)?;
        crate::access_registration::init_schema(&conn)?;
        crate::avatar::init_avatar_schema(&conn)?;
        crate::reports::init_schema(&conn)?;
        crate::llm_usage::init_schema(&conn)?;
        crate::tasks::init_schema(&conn)?;
        // The tape («Лента») was removed on 16.10.2026. Its tables hold user text
        // (turns narrated, cards quoting a child's last message, the dispatcher's
        // and the front's logs) that retention no longer purges: drop them.
        // Idempotent; `tape_tasks` and `tape_task_links` are the task registry
        // (`tasks.rs`) and stay. Delete this block once every host has started
        // on this version.
        conn.execute_batch(
            "DROP TABLE IF EXISTS tape_replies;
             DROP TABLE IF EXISTS tape_segments;
             DROP TABLE IF EXISTS tape_cards;
             DROP TABLE IF EXISTS tape_dispatch;
             DROP TABLE IF EXISTS tape_dispatch_projects;
             DROP TABLE IF EXISTS tape_front;",
        )
        .map_err(db_err)?;
        crate::session_reads::init_schema(&conn)?;
        crate::live_activity::init_schema(&conn)?;
        crate::push_action::init_schema(&conn)?;
        crate::account_deletion::init_schema(&conn)?;
        crate::apple_auth::init_schema(&conn)?;
        crate::user_totp::init_schema(&conn).map_err(|e| e.to_string())?;
        crate::local_login::init_schema(&conn)?;
        crate::support_access::init_schema(&conn)?;
        drop(conn);
        // Grants still open from before a restart gate requests from memory.
        self.load_support_registry()
    }

    /// Upsert the account a HegAI SSO login just proved, and answer what the
    /// caller must act on: which hub account it opened, and whether this login
    /// claimed a pre-authorization (`claimed_preauth` means the person is
    /// already active and the post-activation hooks — seat, sandbox — still
    /// have to run; only the caller has the `AppState` they need).
    ///
    /// `hegai_subject` is the platform `userId` from the SSO claim. It resolves
    /// through `identities`; an unseen subject keeps the pre-identities rule
    /// (hub id = HegAI id) so nothing about an existing login changes.
    ///
    /// An address already held by a DIFFERENT account is refused as
    /// `EmailTaken` instead of surfacing as a UNIQUE violation (a 500 at the
    /// SSO callback). Merging two accounts because they share an address is a
    /// decision for a person, not for a login.
    pub fn ensure_user(
        &self,
        hegai_subject: &str,
        email: &str,
        full_name: Option<&str>,
    ) -> Result<EnsuredUser, EnsureUserError> {
        self.ensure_user_vouched(hegai_subject, email, full_name, false)
    }

    /// `ensure_user` with the external edition's «somebody vouched for this
    /// account» bit: the bootstrap owner is, a HegAI SSO login is not. It only
    /// matters for a brand-new account (see `access::new_account_state`).
    pub fn ensure_user_vouched(
        &self,
        hegai_subject: &str,
        email: &str,
        full_name: Option<&str>,
        vouched: bool,
    ) -> Result<EnsuredUser, EnsureUserError> {
        let now = now_ms();
        let normalized = normalize_email(email);
        let default_state = crate::access::new_account_state(vouched);
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let resolved =
            match crate::identity::resolve(&tx, crate::identity::PROVIDER_HEGAI, hegai_subject)? {
                Some(user_id) => user_id,
                None => {
                    // The pre-identities rule (hub id = HegAI id) may only CREATE
                    // an account, or adopt one that has no way in recorded at all
                    // (written by an older binary after a rollback). An account
                    // that has identities but not this one was deliberately
                    // unlinked from HegAI, or never belonged to it (a Telegram
                    // account): opening it because the ids happen to match would
                    // hand it to whoever holds that subject.
                    let guarded: bool = tx
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM identities WHERE user_id=?1)",
                            params![hegai_subject],
                            |r| r.get(0),
                        )
                        .map_err(db_err)?;
                    if guarded {
                        return Err(EnsureUserError::Unlinked {
                            user_id: hegai_subject.to_string(),
                        });
                    }
                    hegai_subject.to_string()
                }
            };
        let user_id = resolved.as_str();
        let holder: Option<String> = tx
            .query_row(
                // lower(trim()) like normalize_email: rows written before
                // addresses were normalized must still count as taken.
                "SELECT user_id FROM users WHERE lower(trim(email))=?1 AND user_id<>?2",
                params![normalized, user_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        if let Some(holder) = holder {
            return Err(EnsureUserError::EmailTaken {
                email: normalized,
                holder,
            });
        }
        let personal_id = format!("personal:{user_id}");
        tx.execute(
            // A name, once learned, is kept: a later login only fills one in
            // when there is none. Two ways a login renamed a real person:
            // the bootstrap seeding in main.rs runs on every hub start (that
            // one passes no name), and an agent's test login under a real user
            // id signed with the same SSO secret — «Owner (verify)» replaced
            // Owner's name everywhere on 10.10.2026, and nothing in the token
            // tells such a login from a real one. The cost: a name changed on
            // the platform does not follow here; fix it in `users` by hand.
            r#"INSERT INTO users(user_id,email,full_name,created_at) VALUES(?1,?2,?3,?4)
               ON CONFLICT(user_id) DO UPDATE SET
                 email=excluded.email,
                 full_name=COALESCE(users.full_name, excluded.full_name)"#,
            params![user_id, normalized, full_name, now],
        )
        .map_err(db_err)?;
        crate::identity::link(
            &tx,
            crate::identity::PROVIDER_HEGAI,
            hegai_subject,
            user_id,
            now,
        )?;
        tx.execute(
            r#"INSERT OR IGNORE INTO workspaces(workspace_id,name,kind,owner_user_id,created_at)
               VALUES(?1,'Моя работа','personal',?2,?3)"#,
            params![personal_id, user_id, now],
        )
        .map_err(db_err)?;
        tx.execute(
            "INSERT OR IGNORE INTO memberships(workspace_id,user_id,role,created_at) VALUES(?1,?2,'owner',?3)",
            params![personal_id, user_id, now],
        ).map_err(db_err)?;
        // An admin may have opened access for this address before anyone
        // signed in with it. Claiming it here, in the transaction that creates
        // the account, is what keeps the waiting screen from flashing between
        // two commits — and the personal workspace the audit row needs was
        // inserted a few lines up.
        let state: Option<String> = tx
            .query_row(
                "SELECT state FROM user_access WHERE user_id=?1",
                params![user_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        let claimed = match state.as_deref() {
            None | Some("waitlist") => {
                crate::access::claim_preauthorization(&tx, user_id, &normalized, now)?
            }
            _ => false,
        };
        if !claimed {
            // A first login lands on the waitlist; the one-time backfill in
            // access.rs already made every pre-existing user an active
            // employee, so OR IGNORE never demotes anyone.
            tx.execute(
                "INSERT OR IGNORE INTO user_access(user_id,state,plan,requested_at,updated_at) VALUES(?1,?2,'community',?3,?3)",
                params![user_id, default_state, now],
            )
            .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        Ok(EnsuredUser {
            user_id: resolved,
            claimed_preauth: claimed,
        })
    }

    /// One-time legacy migration: machines that predate identity/device tables
    /// are adopted by the configured bootstrap user, including offline rows.
    pub fn adopt_legacy_machines(&self, user_id: &str) -> Result<usize, String> {
        let machines: Vec<Value> = {
            let conn = self
                .conn
                .lock()
                .map_err(|_| "workspace database lock poisoned".to_string())?;
            let exists:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='machines')",[],|r|r.get(0)).map_err(db_err)?;
            if !exists {
                return Ok(0);
            }
            let mut stmt = conn
                .prepare("SELECT machine_json FROM machines")
                .map_err(db_err)?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(db_err)?
                .filter_map(Result::ok)
                .filter_map(|raw| serde_json::from_str(&raw).ok())
                .collect();
            rows
        };
        for machine in &machines {
            self.register_legacy_device(user_id, machine)?;
        }
        Ok(machines.len())
    }

    /// `ttl_days` is the session lifetime: a browser tab gets a week, a native
    /// client 90 days (it has no cookie to silently refresh and no tab to
    /// re-open).
    ///
    /// The second factor is NOT proven here: when the person needs one
    /// (`mfa_required`) the session is born pending and opens nothing until
    /// `POST /api/auth/mfa/verify`. A path that checked a code itself uses
    /// `create_auth_session_as(.., Factor::Proven)`.
    pub fn create_auth_session(&self, user_id: &str, ttl_days: i64) -> Result<String, String> {
        self.create_auth_session_as(user_id, ttl_days, crate::mfa::Factor::Unproven)
            .map(|(token, _)| token)
    }

    /// `create_auth_session` that says whether the session is pending.
    pub fn create_auth_session_as(
        &self,
        user_id: &str,
        ttl_days: i64,
        factor: crate::mfa::Factor,
    ) -> Result<(String, bool), String> {
        let token = opaque_token();
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let pending = self.mfa_pending_in(&conn, user_id, factor);
        conn.execute("INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at,mfa_pending) VALUES(?1,?2,?3,?4,?5)",
            params![hash_token(&token),user_id,now + ttl_days * 24 * 60 * 60 * 1000_i64,now,pending]).map_err(db_err)?;
        Ok((token, pending == 1))
    }

    /// Burn a sign-in link and hand back the session it mints. The session is
    /// `fixed_expiry`: it ends at its stated hour and never slides (an operator
    /// session must not turn into a 180-day one by being used).
    ///
    /// The `signin_links` row IS the one-shot: a second click hits the primary
    /// key and is refused even while the token is still inside its window, so a
    /// link that leaks after use is already spent.
    ///
    /// All three writes share one transaction, and that is the point. The audit
    /// row is not a side effect of entering someone's account — it is part of
    /// entering it, so a session can never exist without the trace that explains
    /// it. For the same reason an account with no workspace to write the trace
    /// into is refused rather than entered quietly.
    pub fn consume_signin_link(
        &self,
        jti: &str,
        user_id: &str,
        by: &str,
        ttl_hours: i64,
    ) -> Result<String, String> {
        let token = opaque_token();
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let inserted = tx
            .execute(
                "INSERT OR IGNORE INTO signin_links(jti_hash,user_id,used_at) VALUES(?1,?2,?3)",
                params![hash_token(jti), user_id, now],
            )
            .map_err(db_err)?;
        if inserted == 0 {
            return Err("already_used".into());
        }
        let Some(workspace) = crate::access::audit_workspace_in(&tx, user_id)? else {
            return Err("no_audit_trail".into());
        };
        tx.execute(
            "INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at,mfa_pending,fixed_expiry) VALUES(?1,?2,?3,?4,?5,1)",
            params![
                hash_token(&token),
                user_id,
                now + ttl_hours * 60 * 60 * 1000_i64,
                now,
                // An operator link must not open an account whose owner turned a
                // second factor on: the person behind the link still needs it.
                self.mfa_pending_in(&tx, user_id, crate::mfa::Factor::Unproven)
            ],
        )
        .map_err(db_err)?;
        insert_audit(
            &tx,
            &workspace,
            by,
            "auth.signin_link",
            "user",
            user_id,
            &json!({"by": by}),
        )?;
        tx.commit().map_err(db_err)?;
        Ok(token)
    }

    /// Resolve a session token to its user and the moment that session now
    /// runs out, sliding the expiry forward once the session is past its
    /// halfway point. Without the slide a phone that is used daily would still
    /// be logged out on a fixed schedule.
    ///
    /// The expiry comes back because the COOKIE has to be re-stamped with it.
    /// It is issued once, at login, and the slide below used to be invisible to
    /// the browser: seven days in, the cookie was dropped while the session it
    /// carried was still good, and an open tab — which never reloads, so never
    /// meets the sign-in redirect — just sat there reconnecting a socket the
    /// hub had started refusing. See `refresh_auth_cookie`.
    pub fn authenticate(&self, token: &str) -> Result<Option<(String, i64)>, String> {
        let Some((user_id, expires_at, service_workspace)) = self.authenticate_row(token)? else {
            return Ok(None);
        };
        // A support account is good only while its grant is, and only on the
        // session its login link minted: judged here by the clock, so an
        // expired grant is refused before the sweep has run.
        if crate::support_access::is_support_user(&user_id)
            && !self.support_session_gate(&user_id, &hash_token(token))
        {
            return Ok(None);
        }
        // A session a service key minted holds only while its person is still
        // the plain member the key may sign in. Promoted, given a machine, or
        // joined to another team since: the session is void (and gone), and
        // the person signs in themselves.
        if let Some(workspace_id) = service_workspace {
            if !self.service_session_holds(&user_id, &workspace_id)? {
                self.delete_session(token);
                return Ok(None);
            }
        }
        Ok(Some((user_id, expires_at)))
    }

    /// Whether a service-minted session for `user_id` is still within what its
    /// key may vouch for: a plain member of `workspace_id`, and not a platform
    /// administrator.
    pub(crate) fn service_session_holds(
        &self,
        user_id: &str,
        workspace_id: &str,
    ) -> Result<bool, String> {
        let admin = self
            .always_active
            .read()
            .map(|set| set.contains(user_id))
            .unwrap_or(true);
        let (_, plain) = self.service_signin_profile(user_id, workspace_id)?;
        Ok(plain && !admin)
    }

    /// Whether a service UI pass for `user_id` still holds: the person is
    /// still a member of the key's workspace (any role) and is still active.
    /// Platform-admin status is irrelevant: the scope, not the person's
    /// status, bounds what the pass reaches. Wider than `service_session_holds` on purpose — the
    /// people who use the pass include a firm's owner — because the pass cannot
    /// reach anything beyond the scope the hub confines it to.
    pub(crate) fn ui_scope_holds(&self, user_id: &str, workspace_id: &str) -> Result<bool, String> {
        if !self.is_active(user_id) {
            return Ok(false);
        }
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM memberships WHERE workspace_id=?1 AND user_id=?2)",
            params![workspace_id, user_id],
            |r| r.get(0),
        )
        .map_err(db_err)
    }

    /// Resolve a service UI pass (`POST /api/service/ui-tokens`) presented on
    /// `/ui`. `None` for anything else — an ordinary session is never a pass,
    /// and a pass is never an ordinary session (`authenticate` skips them). A
    /// pass does not slide: it ends at the `expires_at` it was minted with. One
    /// whose person no longer holds (`ui_scope_holds`) is deleted.
    pub(crate) fn authenticate_ui_pass(&self, token: &str) -> Result<Option<UiPass>, String> {
        let hash = hash_ui_pass(token);
        let now = now_ms();
        let row: Option<(String, Option<String>, Option<String>)> = {
            let conn = self
                .conn
                .lock()
                .map_err(|_| "workspace database lock poisoned".to_string())?;
            conn.query_row(
                "SELECT user_id,service_issuer,service_workspace_id FROM auth_sessions WHERE token_hash=?1 AND ui_scope=?2 AND expires_at>?3 AND created_at>?4 AND mfa_pending=0",
                params![hash, UI_SCOPE_SERVICE, now, now - SESSION_MAX_MS],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(db_err)?
        };
        let Some((user_id, Some(issuer), Some(workspace_id))) = row else {
            return Ok(None);
        };
        if !self.ui_scope_holds(&user_id, &workspace_id)? {
            if let Ok(conn) = self.conn.lock() {
                let _ = conn.execute(
                    "DELETE FROM auth_sessions WHERE token_hash=?1",
                    params![hash],
                );
            }
            return Ok(None);
        }
        Ok(Some(UiPass {
            user_id,
            issuer,
            workspace_id,
        }))
    }

    /// Mint the session an Apple Watch keeps (docs/WATCH.md §7): its own
    /// `auth_sessions` row, labelled «Apple Watch» so «Где я вошёл» lists and
    /// revokes it, confined by `ui_scope='watch'`. At most `WATCH_SESSIONS_MAX`
    /// per person; the oldest go first.
    ///
    /// MFA: exempt on purpose, with no `mfa_pending` — it is minted only from a
    /// request that already passed `authenticate` (`watch_api.rs`), so the
    /// session behind it has met the second factor; and `ui_scope='watch'` keeps
    /// it out of `authenticate` altogether.
    pub fn create_watch_session(&self, user_id: &str) -> Result<String, String> {
        let token = opaque_token();
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        tx.execute(
            "DELETE FROM auth_sessions WHERE user_id=?1 AND ui_scope=?2 AND (expires_at<=?3 OR token_hash NOT IN \
             (SELECT token_hash FROM auth_sessions WHERE user_id=?1 AND ui_scope=?2 AND expires_at>?3 \
              ORDER BY created_at DESC, rowid DESC LIMIT ?4))",
            params![user_id, UI_SCOPE_WATCH, now, WATCH_SESSIONS_MAX - 1],
        )
        .map_err(db_err)?;
        tx.execute(
            "INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at,label,ui_scope) VALUES(?1,?2,?3,?4,'Apple Watch',?5)",
            params![hash_token(&token), user_id, now + SESSION_MAX_MS, now, UI_SCOPE_WATCH],
        )
        .map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(token)
    }

    /// Was this session minted by a service key? Unknown tokens count as yes:
    /// the caller refuses on yes.
    pub(crate) fn session_is_service(&self, token: &str) -> Result<bool, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.query_row(
            "SELECT service_workspace_id IS NOT NULL FROM auth_sessions WHERE token_hash=?1",
            params![hash_token(token)],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_err)
        .map(|v| v.unwrap_or(true))
    }

    /// The person behind an Apple Watch session, if the token is one and has
    /// not expired. Does not slide.
    pub fn authenticate_watch(&self, token: &str) -> Result<Option<String>, String> {
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.query_row(
            "SELECT user_id FROM auth_sessions WHERE token_hash=?1 AND ui_scope=?2 AND expires_at>?3 AND created_at>?4",
            params![hash_token(token), UI_SCOPE_WATCH, now, now - SESSION_MAX_MS],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_err)
    }

    fn delete_session(&self, token: &str) {
        if let Ok(conn) = self.conn.lock() {
            let _ = conn.execute(
                "DELETE FROM auth_sessions WHERE token_hash=?1",
                params![hash_token(token)],
            );
        }
    }

    /// The session behind a token: its person, its (slid) expiry and, for a
    /// service-minted one, the workspace that vouched for it.
    fn authenticate_row(
        &self,
        token: &str,
    ) -> Result<Option<(String, i64, Option<String>)>, String> {
        let hash = hash_token(token);
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let row: Option<(String, i64, i64, Option<String>, i64)> = conn
            .query_row(
                "SELECT user_id,expires_at,created_at,service_workspace_id,fixed_expiry FROM auth_sessions WHERE token_hash=?1 AND expires_at>?2 AND ui_scope IS NULL AND mfa_pending=0",
                params![hash, now],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()
            .map_err(db_err)?;
        let Some((user_id, expires_at, created_at, service_workspace, fixed_expiry)) = row else {
            return Ok(None);
        };
        // An absolute ceiling: a session that is used keeps sliding, but not
        // forever. A token lifted from a phone backup or a log used to stay
        // good for as long as somebody kept using it.
        let hard_end = created_at + SESSION_MAX_MS;
        if now >= hard_end {
            return Ok(None);
        }
        let ttl = expires_at - created_at;
        let mut expires_at = expires_at;
        // A support session ends with its grant and never slides past it.
        // A tool session (`mint-tool-session`) ends when it was minted to end.
        if ttl > 0
            && fixed_expiry == 0
            && expires_at - now < ttl / 2
            && expires_at < hard_end
            && !crate::support_access::is_support_user(&user_id)
        {
            let slid = (now + ttl).min(hard_end);
            // Only claim the slide the database actually took: the cookie is
            // stamped from this number, and a cookie outliving its session is
            // the failure this whole path exists to prevent.
            if conn
                .execute(
                    "UPDATE auth_sessions SET expires_at=?1 WHERE token_hash=?2",
                    params![slid, hash],
                )
                .is_ok()
            {
                expires_at = slid;
            }
        }
        Ok(Some((user_id, expires_at, service_workspace)))
    }

    /// Name the device behind a session and note that it is in use. Throttled
    /// to one write per five minutes per session: it runs on every `/ui` open.
    pub fn note_session(&self, token: &str, label: &str) {
        let now = now_ms();
        if let Ok(conn) = self.conn.lock() {
            let _ = conn.execute(
                "UPDATE auth_sessions SET label=?1, last_seen=?2 WHERE token_hash=?3 AND fixed_expiry=0 AND (last_seen IS NULL OR last_seen<?4)",
                params![label, now, hash_token(token), now - 5 * 60 * 1000],
            );
        }
    }

    /// Whether the session behind this id (`session_id`) still exists — how
    /// the hub drops a live socket whose sign-in was ended elsewhere. An `Err`
    /// (poisoned lock, SQLite failure) means "could not tell", not "ended": the
    /// caller keeps the socket open and reports the error, so a transient
    /// database fault neither signs everyone out nor goes unnoticed.
    pub fn session_alive(&self, session_id: &str) -> Result<bool, String> {
        let row: Option<(String, Option<String>, Option<String>)> = {
            let conn = self
                .conn
                .lock()
                .map_err(|_| "workspace database lock poisoned".to_string())?;
            conn.query_row(
                "SELECT user_id,service_workspace_id,ui_scope FROM auth_sessions WHERE token_hash=?1 AND expires_at>?2 AND created_at>?3 AND (ui_scope IS NOT NULL OR mfa_pending=0)",
                params![session_id, now_ms(), now_ms() - SESSION_MAX_MS],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(db_err)?
        };
        let Some((user_id, service_workspace, ui_scope)) = row else {
            return Ok(false);
        };
        if !self.support_session_gate(&user_id, session_id) {
            return Ok(false);
        }
        // A service-minted sign-in that its person has outgrown ends here too,
        // so the socket it holds open goes with it (see `authenticate`). A UI
        // pass has its own, wider rule: still in the workspace and active.
        if let Some(workspace_id) = service_workspace {
            let holds = if ui_scope.is_some() {
                self.ui_scope_holds(&user_id, &workspace_id)?
            } else {
                self.service_session_holds(&user_id, &workspace_id)?
            };
            if !holds {
                if let Ok(conn) = self.conn.lock() {
                    let _ = conn.execute(
                        "DELETE FROM auth_sessions WHERE token_hash=?1",
                        params![session_id],
                    );
                }
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// The device label of one sign-in («приложение», «Chrome · macOS»…), so an
    /// audit row can say WHICH of a person's clients acted, not only who.
    pub fn session_label(&self, session_id: &str) -> Option<String> {
        let conn = self.conn.lock().ok()?;
        conn.query_row(
            "SELECT label FROM auth_sessions WHERE token_hash=?1",
            params![session_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()
        .ok()
        .flatten()
        .flatten()
    }

    /// A person's live sign-ins, newest use first. `id` is the token HASH —
    /// it names the session without being able to open it.
    pub fn list_sessions(&self, user_id: &str) -> Result<Vec<Value>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT token_hash,label,created_at,last_seen,expires_at FROM auth_sessions
                 WHERE user_id=?1 AND expires_at>?2 AND created_at>?3 ORDER BY COALESCE(last_seen,created_at) DESC LIMIT 100",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![user_id, now_ms(), now_ms() - SESSION_MAX_MS], |r| {
                let created: i64 = r.get(2)?;
                let expires: i64 = r.get(4)?;
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "label": r.get::<_, Option<String>>(1)?,
                    "createdAt": created,
                    "lastSeen": r.get::<_, Option<i64>>(3)?,
                    "expiresAt": expires.min(created + SESSION_MAX_MS),
                }))
            })
            .map_err(db_err)?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    /// End one of `user_id`'s sessions by id. `false` when it was not theirs
    /// or was already gone — never somebody else's.
    pub fn revoke_session(&self, user_id: &str, session_id: &str) -> Result<bool, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.execute(
            "DELETE FROM auth_sessions WHERE token_hash=?1 AND user_id=?2",
            params![session_id, user_id],
        )
        .map(|n| n > 0)
        .map_err(db_err)
    }

    /// End every session of `user_id` except `keep` (the one asking). Returns
    /// how many went.
    pub fn revoke_other_sessions(
        &self,
        user_id: &str,
        keep: Option<&str>,
    ) -> Result<usize, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.execute(
            "DELETE FROM auth_sessions WHERE user_id=?1 AND token_hash IS NOT ?2",
            params![user_id, keep],
        )
        .map_err(db_err)
    }

    /// `true` when a session with this token existed and is now gone. A service
    /// UI pass (stored under its own hash, `hash_ui_pass`) ends the same way:
    /// whoever holds the token can always end it. The caller tells the hub
    /// (`HubCmd::SweepUiPasses`) so the sockets riding it close at once.
    /// Is the session with this token hash alive and `user`'s own (not a
    /// pending second-factor or service pass)?
    pub(crate) fn session_alive_for(&self, token_hash: &str, user_id: &str) -> bool {
        let Ok(conn) = self.conn.lock() else {
            return false;
        };
        conn.query_row(
            "SELECT 1 FROM auth_sessions WHERE token_hash=?1 AND user_id=?2 AND expires_at>?3 \
             AND ui_scope IS NULL AND mfa_pending=0",
            params![token_hash, user_id, now_ms()],
            |_| Ok(()),
        )
        .optional()
        .map(|r| r.is_some())
        .unwrap_or(false)
    }

    pub fn logout(&self, token: &str) -> bool {
        let Ok(conn) = self.conn.lock() else {
            return false;
        };
        conn.execute(
            "DELETE FROM auth_sessions WHERE token_hash IN (?1,?2)",
            params![hash_token(token), hash_ui_pass(token)],
        )
        .map(|n| n > 0)
        .unwrap_or(false)
    }

    pub fn workspaces(&self, user_id: &str) -> Result<Vec<Value>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                r#"SELECT w.workspace_id,w.name,w.kind,m.role,w.slug,w.self_serve FROM memberships m
               JOIN workspaces w ON w.workspace_id=m.workspace_id WHERE m.user_id=?1
               ORDER BY CASE w.kind WHEN 'personal' THEN 0 ELSE 1 END,w.name"#,
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![user_id], |r| {
                let mut v = json!({
                    "workspaceId":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,
                    "kind":r.get::<_,String>(2)?,"role":r.get::<_,String>(3)?
                });
                // Both optional on the wire (zod optional = absent, never null).
                if let Some(slug) = r.get::<_, Option<String>>(4)? {
                    v["slug"] = Value::String(slug);
                }
                if r.get::<_, i64>(5)? != 0 {
                    v["selfServe"] = Value::Bool(true);
                }
                Ok(v)
            })
            .map_err(db_err)?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn enable_llm_usage(&mut self) {
        self.llm_usage = true;
    }

    /// The workspace a client lands in when it names none (or one the user
    /// left): a team whenever the user has one — the team they own first, as
    /// web and iOS pick. A team already shows the user's own machines in full
    /// (`machine_access_inner`: owner ⇒ full access in any workspace) plus what
    /// the team shares, so «Моя работа» adds nothing there and only confuses;
    /// it stays the landing place for someone with no team at all.
    pub(crate) fn default_workspace(workspaces: &[Value]) -> Option<&Value> {
        fn field<'v>(w: &'v Value, key: &str) -> &'v str {
            w.get(key).and_then(Value::as_str).unwrap_or("")
        }
        let teams = || workspaces.iter().filter(|w| field(w, "kind") != "personal");
        teams()
            .find(|w| field(w, "role") == "owner")
            .or_else(|| teams().next())
            .or_else(|| workspaces.first())
    }

    /// The user's own personal workspace, if they still have one (a store
    /// review account's was converted into an organization).
    pub(crate) fn personal_workspace_of(&self, user_id: &str) -> Option<String> {
        self.workspaces(user_id)
            .ok()?
            .iter()
            .find(|w| {
                w.get("kind").and_then(Value::as_str) == Some("personal")
                    && w.get("role").and_then(Value::as_str) == Some("owner")
            })
            .and_then(|w| w.get("workspaceId").and_then(Value::as_str))
            .map(str::to_string)
    }

    /// Access in `requested`, or the user's own (first, personal) workspace.
    /// Internal callers — audit rows for reports, board, browser profiles —
    /// rely on that fallback being personal; keep it so.
    pub fn ui_access(
        &self,
        user_id: &str,
        requested: Option<&str>,
        platform_admin: bool,
    ) -> Result<UiAccess, String> {
        self.ui_access_inner(user_id, requested, platform_admin, false)
    }

    /// What a client opens on connect (`/ui`, `/api/me`): like `ui_access`,
    /// but with no valid request it lands on `default_workspace`, so a
    /// machineless member sees their team instead of an empty «Моя работа».
    pub fn ui_landing(
        &self,
        user_id: &str,
        requested: Option<&str>,
        platform_admin: bool,
    ) -> Result<UiAccess, String> {
        self.ui_access_inner(user_id, requested, platform_admin, true)
    }

    fn ui_access_inner(
        &self,
        user_id: &str,
        requested: Option<&str>,
        platform_admin: bool,
        landing: bool,
    ) -> Result<UiAccess, String> {
        if self.deletion_pending(user_id)? {
            return Err("account deletion in progress".into());
        }
        if !self.support_gate(user_id) {
            return Err("workspace access denied".into());
        }
        let workspaces = self.workspaces(user_id)?;
        let requested = requested.and_then(|id| {
            workspaces
                .iter()
                .find(|w| w.get("workspaceId").and_then(Value::as_str) == Some(id))
        });
        let selected = match requested {
            Some(w) => Some(w),
            None if landing => Self::default_workspace(&workspaces),
            None => workspaces.first(),
        }
        .cloned()
        .ok_or_else(|| "user has no workspace".to_string())?;
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let (email, full_name): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT email,full_name FROM users WHERE user_id=?1",
                params![user_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(db_err)?;
        let workspace_id = selected
            .get("workspaceId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let role = selected
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("member")
            .to_string();
        let kind = selected
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("organization")
            .to_string();
        let mut viewer = json!({"userId":user_id,"platformAdmin":platform_admin,"workspace":selected,"workspaces":workspaces});
        if let Some(email) = email {
            viewer["email"] = Value::String(email);
        }
        if self.llm_usage {
            viewer["llmUsage"] = Value::Bool(true);
        }
        // The linked Telegram account, for «Привязан @x» in Настройки.
        let telegram: Option<(Option<String>, String)> = conn
            .query_row(
                "SELECT label,subject FROM identities WHERE provider='telegram' AND user_id=?1 LIMIT 1",
                params![user_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(db_err)?;
        if let Some((label, subject)) = telegram {
            viewer["telegram"] = Value::String(label.unwrap_or_else(|| format!("tg:{subject}")));
        }
        if let Some(name) = full_name {
            viewer["fullName"] = Value::String(name);
        }
        // Built here, not in a separate endpoint, so /api/me, the /ui handshake
        // and refresh_workspace_state all carry it — an open tab learns about
        // its activation without a reload.
        drop(conn);
        let access = self.access_state(user_id)?;
        let access_state = access.state.clone();
        viewer["access"] = self.viewer_access_json(&access)?;
        Ok(UiAccess {
            user_id: user_id.to_string(),
            workspace_id,
            role,
            kind,
            access_state,
            viewer,
            ui_scope: None,
        })
    }

    pub fn create_organization(
        &self,
        actor: &str,
        name: &str,
        owner_user_id: &str,
    ) -> Result<Value, String> {
        self.create_organization_inner(actor, name, owner_user_id, None)
    }

    /// Shared by the admin form (no slug, not self-serve) and the self-serve
    /// path in access.rs (slug + `self_serve=1`).
    pub(crate) fn create_organization_inner(
        &self,
        actor: &str,
        name: &str,
        owner_user_id: &str,
        slug: Option<&str>,
    ) -> Result<Value, String> {
        let id = Uuid::new_v4().to_string();
        let now = now_ms();
        let self_serve = slug.is_some();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        tx.execute("INSERT INTO workspaces(workspace_id,name,kind,owner_user_id,created_at,slug,self_serve) VALUES(?1,?2,'organization',?3,?4,?5,?6)", params![id,name.trim(),owner_user_id,now,slug,self_serve as i64]).map_err(db_err)?;
        tx.execute("INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?1,?2,'owner',?3)", params![id,owner_user_id,now]).map_err(db_err)?;
        insert_audit(
            &tx,
            &id,
            actor,
            "workspace.created",
            "workspace",
            &id,
            &json!({"name":name,"slug":slug,"selfServe":self_serve}),
        )?;
        tx.commit().map_err(db_err)?;
        let mut out = json!({"workspaceId":id,"name":name,"kind":"organization","role":"owner"});
        if let Some(slug) = slug {
            out["slug"] = Value::String(slug.to_string());
            out["selfServe"] = Value::Bool(true);
        }
        Ok(out)
    }

    /// Without a session: what tests and tools use (production goes through
    /// `invite_from`, see `api_invite`).
    #[cfg(test)]
    pub fn invite(
        &self,
        actor: &str,
        workspace_id: &str,
        email: &str,
        role: &str,
    ) -> Result<Value, String> {
        self.invite_from(actor, workspace_id, email, role, None)
    }

    /// `invite` that remembers WHICH session issued it (`created_session`, the
    /// token hash): the Telegram sign-in undo withdraws only what the phished
    /// session itself issued, not what the person did from their own sessions
    /// meanwhile. `None` — no session (tools, tests), or rows from before the
    /// column — is never matched by an undo.
    pub fn invite_from(
        &self,
        actor: &str,
        workspace_id: &str,
        email: &str,
        role: &str,
        session_hash: Option<&str>,
    ) -> Result<Value, String> {
        self.invite_row(
            actor,
            workspace_id,
            &normalize_email(email),
            None,
            role,
            session_hash,
        )
    }

    /// An invitation addressed to a Telegram `@username`: the person's first
    /// Telegram sign-in on this hub joins the team (`telegram_login`). The
    /// response carries no token — there is no link to hand out.
    pub fn invite_telegram_from(
        &self,
        actor: &str,
        workspace_id: &str,
        username: &str,
        role: &str,
        session_hash: Option<&str>,
    ) -> Result<Value, String> {
        let name = normalize_telegram_username(username)
            .ok_or("invalid Telegram username (5-32 letters, digits or _)")?;
        let mut v = self.invite_row(actor, workspace_id, "", Some(&name), role, session_hash)?;
        if let Some(map) = v.as_object_mut() {
            map.remove("token");
            map.remove("email");
            map.insert("telegram".into(), Value::String(name));
        }
        Ok(v)
    }

    fn invite_row(
        &self,
        actor: &str,
        workspace_id: &str,
        normalized: &str,
        telegram: Option<&str>,
        role: &str,
        session_hash: Option<&str>,
    ) -> Result<Value, String> {
        if role != "manager" && role != "member" {
            return Err("invalid invitation role".into());
        }
        self.require_role(actor, workspace_id, &["owner"])?;
        let id = Uuid::new_v4().to_string();
        let token = opaque_token();
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        // The issuing session must still be live, satisfied and the actor's,
        // checked under the same lock as the insert: either the invitation
        // commits before a Telegram undo (and that undo withdraws it), or the
        // undo wins and this request is refused.
        if let Some(hash) = session_hash {
            let live: Option<i64> = tx
                .query_row(
                    "SELECT 1 FROM auth_sessions WHERE token_hash=?1 AND user_id=?2 AND expires_at>?3 AND mfa_pending=0",
                    params![hash, actor, now],
                    |r| r.get(0),
                )
                .optional()
                .map_err(db_err)?;
            if live.is_none() {
                return Err("authentication required".into());
            }
        }
        // Team size is capped per wave: members already in plus invitations
        // still open count against `member_cap` (per team, else the fleet
        // default), and a pile of unanswered invitations is capped on its own.
        let member_cap: Option<i64> = tx
            .query_row(
                "SELECT member_cap FROM workspaces WHERE workspace_id=?1",
                params![workspace_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?
            .flatten();
        let cap = member_cap
            .filter(|n| *n > 0)
            .map(|n| n as usize)
            .unwrap_or_else(|| env_usize("CC_REMOTE_ORG_MEMBER_CAP", 25));
        let members: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM memberships WHERE workspace_id=?1",
                params![workspace_id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        let pending: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM invitations WHERE workspace_id=?1 AND accepted_at IS NULL AND expires_at>?2",
                params![workspace_id, now],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if (members + pending) as usize >= cap || pending >= MAX_PENDING_INVITATIONS {
            return Err(MEMBER_CAP_ERR.into());
        }
        tx.execute("INSERT INTO invitations(invitation_id,workspace_id,email,role,token_hash,created_by,created_at,expires_at,created_session,telegram_username) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![id,workspace_id,normalized,role,hash_token(&token),actor,now,now+7*24*60*60*1000_i64,session_hash,telegram]).map_err(db_err)?;
        insert_audit(
            &tx,
            workspace_id,
            actor,
            "invitation.created",
            "invitation",
            &id,
            &match telegram {
                Some(t) => json!({"telegram":t,"role":role}),
                None => json!({"email":normalized,"role":role}),
            },
        )?;
        tx.commit().map_err(db_err)?;
        Ok(
            json!({"invitationId":id,"email":normalized,"role":role,"token":token,"expiresAt":now+7*24*60*60*1000_i64}),
        )
    }

    /// What a live invitation token says about itself, for the page the invited
    /// person lands on before signing in: `(team name, inviter, email)`.
    pub fn invitation_preview(
        &self,
        token: &str,
    ) -> Result<Option<(String, String, String)>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.query_row(
            "SELECT w.name, COALESCE(NULLIF(trim(u.full_name),''), u.email, ''), i.email
             FROM invitations i JOIN workspaces w ON w.workspace_id=i.workspace_id
             LEFT JOIN users u ON u.user_id=i.created_by
             WHERE i.token_hash=?1 AND i.accepted_at IS NULL AND i.expires_at>?2",
            params![hash_token(token), now_ms()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(db_err)
    }

    /// Returns the workspace joined and who invited — the inviter is what
    /// activation-by-invitation needs, and only this transaction has proven
    /// that the invitation was theirs and matched this person's email.
    pub fn accept_invitation(
        &self,
        user_id: &str,
        token: &str,
    ) -> Result<(String, String), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let joined = Self::accept_invitation_in(&tx, user_id, &hash_token(token), false)?;
        tx.commit().map_err(db_err)?;
        Ok(joined)
    }

    /// The body of `accept_invitation` inside the caller's transaction (which
    /// commits). `key` is the token hash, or the invitation id when `by_id`
    /// (a setup link that carries its invitation server-side).
    pub(crate) fn accept_invitation_in(
        tx: &Connection,
        user_id: &str,
        key: &str,
        by_id: bool,
    ) -> Result<(String, String), String> {
        let now = now_ms();
        let user_email: Option<String> = tx
            .query_row(
                "SELECT email FROM users WHERE user_id=?1",
                params![user_id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        let lookup = if by_id { "invitation_id" } else { "token_hash" };
        let invitation:Option<(String,String,String,String,String)>=tx.query_row(&format!("SELECT invitation_id,workspace_id,email,role,created_by FROM invitations WHERE {lookup}=?1 AND accepted_at IS NULL AND expires_at>?2"),params![key,now],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(db_err)?;
        let (invitation_id, workspace_id, email, role, created_by) =
            invitation.ok_or("invalid or expired invitation")?;
        // An invitation is addressed to an email; an account without one
        // (Telegram-only) cannot prove it is that address.
        let Some(user_email) = user_email.filter(|_| !email.is_empty()) else {
            return Err("invitation belongs to another email".into());
        };
        if normalize_email(&user_email) != normalize_email(&email) {
            return Err("invitation belongs to another email".into());
        }
        // An invitation must never change an owner's role: a stale or
        // self-addressed invitation would demote the owner and leave the team
        // without one. Refuse up front (and leave the invitation unused) so the
        // caller is told; the `WHERE` below is the same rule at the write.
        let existing_role: Option<String> = tx
            .query_row(
                "SELECT role FROM memberships WHERE workspace_id=?1 AND user_id=?2",
                params![workspace_id, user_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        if existing_role.as_deref() == Some("owner") {
            return Err("you already own this team".into());
        }
        tx.execute("INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?1,?2,?3,?4) ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role WHERE memberships.role<>'owner'",params![workspace_id,user_id,role,now]).map_err(db_err)?;
        tx.execute(
            "UPDATE invitations SET accepted_by=?2,accepted_at=?3,created_membership=?4 WHERE invitation_id=?1",
            params![
                invitation_id,
                user_id,
                now,
                i64::from(existing_role.is_none())
            ],
        )
        .map_err(db_err)?;
        // An invitation that CHANGED an existing member's role is a role change
        // like any other: audited (actor = whoever issued the invitation, so it
        // shows in that person's review list) with from → to.
        if let Some(from) = existing_role.as_deref().filter(|from| *from != role) {
            insert_audit(
                tx,
                &workspace_id,
                &created_by,
                "membership.role_changed",
                "member",
                user_id,
                &json!({"role": role, "from": from, "via": "invitation"}),
            )?;
        }
        insert_audit(
            tx,
            &workspace_id,
            user_id,
            "invitation.accepted",
            "invitation",
            &invitation_id,
            &json!({}),
        )?;
        Ok((workspace_id, created_by))
    }

    pub fn members(&self, actor: &str, workspace_id: &str) -> Result<Vec<Value>, String> {
        self.require_member(actor, workspace_id)?;
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let mut stmt=conn.prepare("SELECT u.user_id,u.email,u.full_name,m.role,m.created_at FROM memberships m JOIN users u ON u.user_id=m.user_id WHERE m.workspace_id=?1 ORDER BY u.full_name,u.email").map_err(db_err)?;
        let rows=stmt.query_map(params![workspace_id],|r| { let name:Option<String>=r.get(2)?; let mut v=json!({"userId":r.get::<_,String>(0)?,"role":r.get::<_,String>(3)?,"joinedAt":r.get::<_,i64>(4)?}); put_email(&mut v, r.get(1)?); if let Some(n)=name {v["fullName"]=Value::String(n)} Ok(v)}).map_err(db_err)?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn set_member_role(
        &self,
        actor: &str,
        workspace_id: &str,
        user_id: &str,
        role: &str,
    ) -> Result<(), String> {
        self.require_role(actor, workspace_id, &["owner"])?;
        if role != "manager" && role != "member" {
            return Err("owner role cannot be reassigned".into());
        }
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let changed=tx.execute("UPDATE memberships SET role=?3 WHERE workspace_id=?1 AND user_id=?2 AND role<>'owner'",params![workspace_id,user_id,role]).map_err(db_err)?;
        if changed == 0 {
            return Err("member not found or is workspace owner".into());
        }
        insert_audit(
            &tx,
            workspace_id,
            actor,
            "membership.role_changed",
            "member",
            user_id,
            &json!({"role":role}),
        )?;
        tx.commit().map_err(db_err)
    }

    pub fn assign_manager(
        &self,
        actor: &str,
        workspace_id: &str,
        manager_id: &str,
        target_kind: &str,
        target_id: &str,
    ) -> Result<(), String> {
        self.require_role(actor, workspace_id, &["owner"])?;
        if target_kind != "member" && target_kind != "project" {
            return Err("invalid assignment target".into());
        }
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let is_manager: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM memberships WHERE workspace_id=?1 AND user_id=?2 AND role='manager')", params![workspace_id, manager_id], |r| r.get(0)).map_err(db_err)?;
        if !is_manager {
            return Err("manager is not a Manager in this workspace".into());
        }
        let target_exists: bool = if target_kind == "member" {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM memberships WHERE workspace_id=?1 AND user_id=?2)",
                params![workspace_id, target_id],
                |r| r.get(0),
            )
            .map_err(db_err)?
        } else {
            conn.query_row("SELECT EXISTS(SELECT 1 FROM project_shares WHERE workspace_id=?1 AND project_share_id=?2)", params![workspace_id, target_id], |r| r.get(0)).map_err(db_err)?
        };
        if !target_exists {
            return Err("assignment target is not in this workspace".into());
        }
        conn.execute("INSERT OR IGNORE INTO manager_assignments(workspace_id,manager_user_id,target_kind,target_id,created_at) VALUES(?1,?2,?3,?4,?5)",params![workspace_id,manager_id,target_kind,target_id,now_ms()]).map_err(db_err)?;
        drop(conn);
        self.audit(
            workspace_id,
            actor,
            "manager.assigned",
            target_kind,
            target_id,
            &json!({"managerUserId":manager_id}),
        )
    }

    pub fn create_enrollment(&self, user_id: &str) -> Result<Value, String> {
        self.create_enrollment_for(user_id, "device")
    }

    /// Mint a one-time machine-registration code. `purpose` is copied onto the
    /// device at exchange time (`devices.kind`): `device` = a personal machine,
    /// `sandbox` = a hosted one the provisioner registers on the user's behalf.
    /// Personal codes are rate-limited per user (a code is a credential); the
    /// sandbox path is minted by the hub itself and is not counted.
    pub fn create_enrollment_for(&self, user_id: &str, purpose: &str) -> Result<Value, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        mint_enrollment(&conn, user_id, purpose)
    }

    pub fn exchange_enrollment(&self, code: &str, machine: &Value) -> Result<Value, String> {
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let (user_id, purpose): (String, String) = tx
            .query_row(
                "SELECT user_id,purpose FROM enrollments WHERE code_hash=?1 AND used_at IS NULL AND expires_at>?2",
                params![hash_token(&code.to_ascii_uppercase()), now],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(db_err)?
            .ok_or("invalid or expired enrollment code")?;
        let out = self.enroll_device_tx(&tx, &user_id, &purpose, machine, now)?;
        tx.execute(
            "UPDATE enrollments SET used_at=?2 WHERE code_hash=?1",
            params![hash_token(&code.to_ascii_uppercase()), now],
        )
        .map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        Ok(out)
    }

    /// The device half of an enrollment — the part that does not care how the
    /// code got here: a code the person typed on the machine, or a request the
    /// machine made and the person approved on `/link`. Owner conflict, the
    /// plan's device cap, the `devices` row, a fresh credential (the old ones
    /// revoked). Runs inside the caller's transaction.
    pub(crate) fn enroll_device_tx(
        &self,
        tx: &Connection,
        user_id: &str,
        purpose: &str,
        machine: &Value,
        now: i64,
    ) -> Result<Value, String> {
        let machine_id = machine
            .get("machineId")
            .and_then(Value::as_str)
            .ok_or("machineId required")?;
        let name = machine
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(machine_id);
        let os = machine.get("os").and_then(Value::as_str).unwrap_or("linux");
        let version = machine
            .get("agentVersion")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let kind = if purpose == "sandbox" {
            "sandbox"
        } else {
            "personal"
        };
        let existing_owner: Option<String> = tx
            .query_row(
                "SELECT owner_user_id FROM devices WHERE machine_id=?1",
                params![machine_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        if existing_owner
            .as_deref()
            .is_some_and(|owner| owner != user_id)
        {
            return Err("machine is already enrolled by another user".into());
        }
        // Personal devices are capped per plan; a sandbox is the hub's own
        // machine and never counts, and re-enrolling a machine already on the
        // list does not cost a slot.
        if kind == "personal" {
            let cap = self.device_cap_for(tx, user_id)?;
            let personal: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM devices WHERE owner_user_id=?1 AND kind='personal' AND revoked_at IS NULL AND machine_id<>?2",
                    params![user_id, machine_id],
                    |r| r.get(0),
                )
                .map_err(db_err)?;
            if personal as usize >= cap {
                return Err(format!(
                    "Лимит устройств: {cap} — отзовите старое в Настройках"
                ));
            }
        }
        tx.execute("INSERT INTO devices(machine_id,owner_user_id,name,os,agent_version,last_seen,created_at,kind) VALUES(?1,?2,?3,?4,?5,?6,?6,?7) ON CONFLICT(machine_id) DO UPDATE SET owner_user_id=excluded.owner_user_id,name=excluded.name,os=excluded.os,agent_version=excluded.agent_version,revoked_at=NULL,kind=excluded.kind",params![machine_id,user_id,name,os,version,now,kind]).map_err(db_err)?;
        tx.execute("UPDATE device_credentials SET revoked_at=?2 WHERE machine_id=?1 AND revoked_at IS NULL",params![machine_id,now]).map_err(db_err)?;
        let token = opaque_token();
        tx.execute("INSERT INTO device_credentials(credential_id,machine_id,token_hash,created_at) VALUES(?1,?2,?3,?4)",params![Uuid::new_v4().to_string(),machine_id,hash_token(&token),now]).map_err(db_err)?;
        Ok(
            json!({"deviceToken":token,"machineId":machine_id,"ownerUserId":user_id,"kind":kind,"name":name}),
        )
    }

    pub fn device_credential(&self, token: &str) -> Result<Option<DeviceCredential>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.query_row(r#"SELECT d.machine_id,d.owner_user_id FROM device_credentials c JOIN devices d ON d.machine_id=c.machine_id WHERE c.token_hash=?1 AND c.revoked_at IS NULL AND d.revoked_at IS NULL"#,params![hash_token(token)],|r|Ok(DeviceCredential{machine_id:r.get(0)?,user_id:r.get(1)?})).optional().map_err(db_err)
    }

    pub fn devices_for_user(&self, user_id: &str) -> Result<Vec<Value>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let mut stmt=conn.prepare("SELECT machine_id,name,os,agent_version,last_seen,revoked_at FROM devices WHERE owner_user_id=?1 ORDER BY last_seen DESC").map_err(db_err)?;
        let rows=stmt.query_map(params![user_id],|r|{let revoked:Option<i64>=r.get(5)?;Ok(json!({"machineId":r.get::<_,String>(0)?,"ownerUserId":user_id,"name":r.get::<_,String>(1)?,"os":r.get::<_,String>(2)?,"agentVersion":r.get::<_,String>(3)?,"lastSeen":r.get::<_,i64>(4)?,"online":false,"revoked":revoked.is_some()}))}).map_err(db_err)?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn revoke_device(&self, user_id: &str, machine_id: &str) -> Result<(), String> {
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let changed=conn.execute("UPDATE devices SET revoked_at=?3 WHERE machine_id=?1 AND owner_user_id=?2 AND revoked_at IS NULL",params![machine_id,user_id,now]).map_err(db_err)?;
        if changed == 0 {
            return Err("device not found".into());
        }
        conn.execute("UPDATE device_credentials SET revoked_at=?2 WHERE machine_id=?1 AND revoked_at IS NULL",params![machine_id,now]).map_err(db_err)?;
        Ok(())
    }

    /// Whether this machine's device has been revoked. Checked at `register`,
    /// not at connect: an agent on the shared fleet token carries no device
    /// identity in its credential, so the machineId is only known once it
    /// registers. Without this a revoked device kept connecting happily and was
    /// merely hidden from the UI — a revocation that revoked nothing.
    pub fn device_revoked(&self, machine_id: &str) -> Result<bool, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.query_row(
            "SELECT revoked_at IS NOT NULL FROM devices WHERE machine_id=?1",
            params![machine_id],
            |r| r.get::<_, bool>(0),
        )
        .optional()
        .map_err(db_err)
        .map(|found| found.unwrap_or(false))
    }

    /// Undo a revocation. Deliberately does NOT resurrect the device's old
    /// credentials — those stay revoked and the machine re-enrolls or falls back
    /// to the fleet token. Restoring access is not the same as restoring a
    /// secret that may be why it was revoked.
    pub fn restore_device(&self, user_id: &str, machine_id: &str) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let changed = conn
            .execute(
                "UPDATE devices SET revoked_at=NULL WHERE machine_id=?1 AND owner_user_id=?2 AND revoked_at IS NOT NULL",
                params![machine_id, user_id],
            )
            .map_err(db_err)?;
        if changed == 0 {
            return Err("device not found or not revoked".into());
        }
        Ok(())
    }

    pub fn register_legacy_device(&self, user_id: &str, machine: &Value) -> Result<(), String> {
        let machine_id = machine
            .get("machineId")
            .and_then(Value::as_str)
            .ok_or("machineId required")?;
        let name = machine
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(machine_id);
        let os = machine.get("os").and_then(Value::as_str).unwrap_or("linux");
        let version = machine
            .get("agentVersion")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.execute("INSERT OR IGNORE INTO devices(machine_id,owner_user_id,name,os,agent_version,last_seen,created_at) VALUES(?1,?2,?3,?4,?5,?6,?6)",params![machine_id,user_id,name,os,version,now_ms()]).map_err(db_err)?;
        Ok(())
    }

    pub fn touch_device(&self, machine: &Value, user_id: &str) -> Result<(), String> {
        self.register_legacy_device(user_id, machine)?;
        let machine_id = machine
            .get("machineId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.execute(
            "UPDATE devices SET name=?2,os=?3,agent_version=?4,last_seen=?5 WHERE machine_id=?1",
            params![
                machine_id,
                machine
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or(machine_id),
                machine.get("os").and_then(Value::as_str).unwrap_or("linux"),
                machine
                    .get("agentVersion")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown"),
                now_ms()
            ],
        )
        .map_err(db_err)?;
        Ok(())
    }

    /// The agent reported `private: true` when it registered (the replica's
    /// `machines` row shares this database). Unknown or unreadable = not private.
    pub fn machine_is_private(&self, machine_id: &str) -> bool {
        let Ok(conn) = self.conn.lock() else {
            return false;
        };
        conn.query_row(
            "SELECT json_extract(machine_json,'$.private') FROM machines WHERE machine_id=?1",
            params![machine_id],
            |r| r.get::<_, Option<i64>>(0),
        )
        .ok()
        .flatten()
        .is_some_and(|v| v == 1)
    }

    /// Drop every project share of a machine (and the member lists on them).
    /// A machine that became private cannot be shared (docs/E2EE.md); shares
    /// made while it was not private must not outlive the switch.
    pub fn revoke_project_shares_for_machine(&self, machine_id: &str) -> Result<usize, String> {
        let conn = self.conn.lock().map_err(|_| "lock poisoned".to_string())?;
        conn.execute(
            "DELETE FROM project_share_members WHERE project_share_id IN (SELECT project_share_id FROM project_shares WHERE machine_id=?1)",
            params![machine_id],
        )
        .map_err(db_err)?;
        conn.execute(
            "DELETE FROM project_shares WHERE machine_id=?1",
            params![machine_id],
        )
        .map_err(db_err)
    }

    pub fn share_project(
        &self,
        actor: &str,
        workspace_id: &str,
        machine_id: &str,
        root: &str,
        name: &str,
        access: &str,
        visibility: &str,
    ) -> Result<Value, String> {
        self.require_member(actor, workspace_id)?;
        let owner = self.device_owner(machine_id)?.ok_or("device not found")?;
        if owner != actor {
            return Err("only the device owner can publish a project".into());
        }
        if self.machine_is_private(machine_id) {
            return Err(PRIVATE_MACHINE_ERR.into());
        }
        let access = if access == "control" {
            "control"
        } else {
            "view"
        };
        // `everyone` opens the owner's own sessions under this root to the
        // team; `team` (the default) keeps them private, as today.
        let visibility = if visibility == "everyone" {
            "everyone"
        } else {
            "team"
        };
        let id = Uuid::new_v4().to_string();
        let now = now_ms();
        let normalized = normalize_root(root);
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        // A root that was closed by a list (a restricted share, or its tombstone
        // after a withdrawal) is not opened to the team by publishing it again.
        let closed: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM project_shares WHERE workspace_id=?1 AND machine_id=?2 AND root=?3 AND restricted=1)",
                params![workspace_id, machine_id, normalized],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if closed {
            return Err(RESTRICTED_ROOT_ERR.into());
        }
        tx.execute("INSERT INTO project_shares(project_share_id,workspace_id,machine_id,owner_user_id,root,name,created_at,access,visibility) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",params![id,workspace_id,machine_id,actor,normalized,name.trim(),now,access,visibility]).map_err(db_err)?;
        insert_audit(
            &tx,
            workspace_id,
            actor,
            "project.shared",
            "project",
            &id,
            &json!({"machineId":machine_id,"root":normalized,"access":access,"visibility":visibility}),
        )?;
        tx.commit().map_err(db_err)?;
        Ok(
            json!({"projectShareId":id,"workspaceId":workspace_id,"machineId":machine_id,"ownerUserId":actor,"root":normalized,"name":name,"createdAt":now,"access":access,"visibility":visibility}),
        )
    }

    pub fn remove_project(
        &self,
        actor: &str,
        workspace_id: &str,
        share_id: &str,
    ) -> Result<(), String> {
        let role = self.require_member(actor, workspace_id)?;
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let owner:Option<String>=conn.query_row("SELECT owner_user_id FROM project_shares WHERE workspace_id=?1 AND project_share_id=?2",params![workspace_id,share_id],|r|r.get(0)).optional().map_err(db_err)?;
        if role != "owner" && owner.as_deref() != Some(actor) {
            return Err("only the project owner or workspace owner can revoke it".into());
        }
        let had_people: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM project_share_members WHERE project_share_id=?1)",
                params![share_id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        conn.execute(
            "DELETE FROM project_share_members WHERE project_share_id IN (SELECT project_share_id FROM project_shares WHERE workspace_id=?1 AND project_share_id=?2)",
            params![workspace_id, share_id],
        )
        .map_err(db_err)?;
        // Withdrawing a restricted share that still has people on it leaves a
        // TOMBSTONE: the list is emptied and the row stays restricted, so a
        // broader share cannot swallow its folder (only the workspace owner and
        // the device owner still reach it). The tombstone is not revived by an
        // ordinary publish (`share_project` refuses) — only a service `PUT` on
        // the root does. Revoking the EMPTY tombstone once more deletes it for
        // good: that is the explicit way to lift the restriction, after which
        // the folder can be published as an ordinary share.
        let tombstoned = if had_people {
            conn.execute(
                "UPDATE project_shares SET access='view' WHERE workspace_id=?1 AND project_share_id=?2 AND restricted=1",
                params![workspace_id, share_id],
            )
            .map_err(db_err)?
        } else {
            0
        };
        if tombstoned > 0 {
            drop(conn);
            return self.audit(
                workspace_id,
                actor,
                "project.revoked",
                "project",
                share_id,
                &json!({"tombstone": true}),
            );
        }
        conn.execute(
            "DELETE FROM project_shares WHERE workspace_id=?1 AND project_share_id=?2",
            params![workspace_id, share_id],
        )
        .map_err(db_err)?;
        drop(conn);
        self.audit(
            workspace_id,
            actor,
            "project.revoked",
            "project",
            share_id,
            &json!({}),
        )
    }

    pub fn projects(&self, actor: &str, workspace_id: &str) -> Result<Vec<Value>, String> {
        let role = self.require_member(actor, workspace_id)?;
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let acl = share_acl_clause("p", "?2");
        let listed = share_listed_sql("p", "?2");
        let cols = "p.project_share_id,p.machine_id,p.owner_user_id,p.root,p.name,p.created_at,p.access,p.visibility";
        let (sql, scoped) = match role.as_str() {
            "owner" => (format!("SELECT {cols} FROM project_shares p WHERE p.workspace_id=?1 ORDER BY p.created_at DESC"), false),
            // A share with a list is for the people on it: an assignment alone
            // does not open it, being on the list does.
            "manager" => (format!("SELECT {cols} FROM project_shares p WHERE p.workspace_id=?1 AND ((EXISTS(SELECT 1 FROM manager_assignments a WHERE a.workspace_id=p.workspace_id AND a.manager_user_id=?2 AND ((a.target_kind='member' AND a.target_id=p.owner_user_id) OR (a.target_kind='project' AND a.target_id=p.project_share_id))) AND {acl}) OR {listed}) ORDER BY p.created_at DESC"), true),
            // Members see their own shares plus any control-share (a startable team
            // machine) — StartScreen uses control-shares as new-session targets.
            _ => (format!("SELECT {cols} FROM project_shares p WHERE p.workspace_id=?1 AND (p.owner_user_id=?2 OR (p.access='control' AND {acl})) ORDER BY p.created_at DESC"), true),
        };
        let mut stmt = conn.prepare(&sql).map_err(db_err)?;
        let map_row = |r: &rusqlite::Row<'_>| {
            Ok(
                json!({"projectShareId":r.get::<_,String>(0)?,"workspaceId":workspace_id,"machineId":r.get::<_,String>(1)?,"ownerUserId":r.get::<_,String>(2)?,"root":r.get::<_,String>(3)?,"name":r.get::<_,String>(4)?,"createdAt":r.get::<_,i64>(5)?,"access":r.get::<_,String>(6)?,"visibility":r.get::<_,String>(7)?}),
            )
        };
        let rows = if scoped {
            stmt.query_map(params![workspace_id, actor], map_row)
                .map_err(db_err)?
        } else {
            stmt.query_map(params![workspace_id], map_row)
                .map_err(db_err)?
        };
        let mut out: Vec<Value> = rows.filter_map(Result::ok).collect();
        // The people a restricted share is limited to (possibly nobody). Absent
        // = the whole team (optional on the wire: absent, never null). An
        // e-mail address is shown as a name to the workspace owner only.
        drop(stmt);
        for project in &mut out {
            let id = project["projectShareId"].as_str().unwrap_or("").to_string();
            let restricted: bool = conn
                .query_row(
                    "SELECT restricted FROM project_shares WHERE project_share_id=?1",
                    params![id],
                    |r| r.get(0),
                )
                .map_err(db_err)?;
            if restricted {
                project["members"] = Value::Array(share_members_json(&conn, &id, role == "owner")?);
            }
        }
        Ok(out)
    }

    pub fn audit_events(&self, actor: &str, workspace_id: &str) -> Result<Vec<Value>, String> {
        let role = self.require_member(actor, workspace_id)?;
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let base = "SELECT a.audit_event_id,a.actor_user_id,u.full_name,u.email,a.action,a.target_kind,a.target_id,a.metadata_json,a.created_at FROM audit_events a LEFT JOIN users u ON u.user_id=a.actor_user_id";
        let sql = if role == "owner" {
            format!("{base} WHERE a.workspace_id=?1 AND a.action NOT IN ('support.ui','support.http') ORDER BY a.created_at DESC LIMIT 250")
        } else {
            format!("{base} WHERE a.workspace_id=?1 AND a.action NOT IN ('support.ui','support.http') AND (a.actor_user_id=?2 OR json_extract(a.metadata_json,'$.machineId') IN (SELECT machine_id FROM devices WHERE owner_user_id=?2)) ORDER BY a.created_at DESC LIMIT 250")
        };
        let mut stmt = conn.prepare(&sql).map_err(db_err)?;
        let map_row = |r: &rusqlite::Row<'_>| {
            let full: Option<String> = r.get(2)?;
            let email: Option<String> = r.get(3)?;
            let raw: String = r.get(7)?;
            let mut v = json!({"auditEventId":r.get::<_,String>(0)?,"workspaceId":workspace_id,"actorUserId":r.get::<_,String>(1)?,"action":r.get::<_,String>(4)?,"targetKind":r.get::<_,String>(5)?,"targetId":r.get::<_,String>(6)?,"createdAt":r.get::<_,i64>(8)?,"metadata":serde_json::from_str::<Value>(&raw).unwrap_or_else(|_|json!({}))});
            if let Some(n) = full.or(email) {
                v["actorName"] = Value::String(n)
            }
            Ok(v)
        };
        let rows = if role == "owner" {
            stmt.query_map(params![workspace_id], map_row)
                .map_err(db_err)?
        } else {
            stmt.query_map(params![workspace_id, actor], map_row)
                .map_err(db_err)?
        };
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn audit(
        &self,
        workspace_id: &str,
        actor: &str,
        action: &str,
        target_kind: &str,
        target_id: &str,
        metadata: &Value,
    ) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        insert_audit(
            &conn,
            workspace_id,
            actor,
            action,
            target_kind,
            target_id,
            metadata,
        )
    }

    fn machine_access_inner(
        &self,
        access: &UiAccess,
        machine_id: &str,
    ) -> Result<MachineAccess, String> {
        let Some(owner) = self.device_owner(machine_id)? else {
            return Ok(MachineAccess::default());
        };
        if access.kind == "personal" {
            let mine = owner == access.user_id;
            return Ok(MachineAccess {
                can_view: mine,
                can_control: mine,
                can_start: mine,
                owner_scoped: false,
                roots: if mine { None } else { Some(vec![]) },
                open_roots: Vec::new(),
                ..MachineAccess::default()
            });
        }
        if owner == access.user_id {
            return Ok(MachineAccess {
                can_view: true,
                can_control: true,
                can_start: true,
                owner_scoped: false,
                roots: None,
                open_roots: Vec::new(),
                ..MachineAccess::default()
            });
        }
        // Members get session-start rights only through a 'control' project-share,
        // and only see sessions owned by a member other than the device owner —
        // unless the share is `everyone`, which opens the owner's own too.
        if access.role == "member" {
            let conn = self
                .conn
                .lock()
                .map_err(|_| "workspace database lock poisoned".to_string())?;
            // A share with a list admits only the people on it, and for them it
            // is a team room: everyone listed sees everyone's sessions, the
            // device owner's included — so it counts as `everyone`.
            let acl = share_acl_clause("p", "?3");
            let mut stmt = conn
                .prepare(&format!("SELECT p.root,CASE WHEN p.restricted=1 THEN 'everyone' ELSE p.visibility END FROM project_shares p WHERE p.workspace_id=?1 AND p.machine_id=?2 AND p.access='control' AND {acl}"))
                .map_err(db_err)?;
            let shares: Vec<(String, String)> = stmt
                .query_map(
                    params![access.workspace_id, machine_id, access.user_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(db_err)?
                .filter_map(Result::ok)
                .collect();
            if shares.is_empty() {
                return Ok(MachineAccess::default());
            }
            let open_roots: Vec<String> = shares
                .iter()
                .filter(|(_, visibility)| visibility == "everyone")
                .map(|(root, _)| root.clone())
                .collect();
            let roots: Vec<String> = shares.into_iter().map(|(root, _)| root).collect();
            return Ok(MachineAccess {
                can_view: true,
                can_control: false,
                can_start: true,
                owner_scoped: true,
                roots: Some(roots),
                open_roots,
                ..MachineAccess::default()
            });
        }
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let mut sql =
            "SELECT p.root FROM project_shares p WHERE p.workspace_id=?1 AND p.machine_id=?2"
                .to_string();
        if access.role == "manager" {
            sql.push_str(&format!(" AND ((EXISTS(SELECT 1 FROM manager_assignments a WHERE a.workspace_id=p.workspace_id AND a.manager_user_id=?3 AND ((a.target_kind='member' AND a.target_id=p.owner_user_id) OR (a.target_kind='project' AND a.target_id=p.project_share_id))) AND {}) OR {})", share_acl_clause("p", "?3"), share_listed_sql("p", "?3")));
        } else if access.role != "owner" {
            return Ok(MachineAccess::default());
        }
        let mut stmt = conn.prepare(&sql).map_err(db_err)?;
        let roots: Vec<String> = if access.role == "manager" {
            stmt.query_map(
                params![access.workspace_id, machine_id, access.user_id],
                |r| r.get(0),
            )
            .map_err(db_err)?
            .filter_map(Result::ok)
            .collect()
        } else {
            stmt.query_map(params![access.workspace_id, machine_id], |r| r.get(0))
                .map_err(db_err)?
                .filter_map(Result::ok)
                .collect()
        };
        Ok(MachineAccess {
            can_view: !roots.is_empty(),
            can_control: false,
            can_start: false,
            owner_scoped: false,
            roots: Some(roots),
            open_roots: Vec::new(),
            ..MachineAccess::default()
        })
    }

    /// What `viewer` may do on `machine_id`: the base answer
    /// (`machine_access_inner`) narrowed and widened by restricted shares.
    ///
    /// A restricted share (`project_shares.restricted`) is closed to everyone
    /// but the people on its list, its workspace's owner and the device owner —
    /// whatever BROADER share the viewer is in. So every restricted share on
    /// the machine the viewer is not admitted to (in any workspace) becomes a
    /// `denied_root` that no path inside can escape, and the ones the viewer is
    /// listed on are `reopen_roots` (a nested restricted share they are on
    /// beats a broader one they are not).
    ///
    /// A workspace owner or manager who is LISTED on a control share may start
    /// sessions in it (the owner of a firm who is also a partner in a matter):
    /// `start_roots` is what a non-controlling viewer may start and read files
    /// in — every share root for a member, the listed ones for the rest.
    pub fn machine_access(
        &self,
        access: &UiAccess,
        machine_id: &str,
    ) -> Result<MachineAccess, String> {
        // A connection opened with a service UI pass has its own, narrower
        // question: none of the owner / device-owner / manager exemptions below
        // apply to it.
        if let Some(scope) = &access.ui_scope {
            return self.scoped_machine_access(access, scope, machine_id);
        }
        let mut m = self.machine_access_inner(access, machine_id)?;
        if m.can_control || !m.can_view {
            return Ok(m);
        }
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(&format!("SELECT p.root,p.workspace_id,p.access,{},EXISTS(SELECT 1 FROM memberships o WHERE o.workspace_id=p.workspace_id AND o.user_id=?2 AND o.role='owner') FROM project_shares p WHERE p.machine_id=?1 AND p.restricted=1", share_listed_sql("p", "?2")))
            .map_err(db_err)?;
        let rows: Vec<(String, String, String, bool, bool)> = stmt
            .query_map(params![machine_id, access.user_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .map_err(db_err)?
            .filter_map(Result::ok)
            .collect();
        let mut listed_control: Vec<String> = Vec::new();
        for (root, workspace_id, share_access, listed, workspace_owner) in rows {
            if listed {
                if share_access == "control" && workspace_id == access.workspace_id {
                    listed_control.push(root.clone());
                }
                m.reopen_roots.push(root);
            } else {
                m.unlisted_roots.push(root.clone());
                if !workspace_owner {
                    m.denied_roots.push(root);
                }
            }
        }
        if m.owner_scoped {
            m.start_roots = m.roots.clone().unwrap_or_default();
        } else {
            m.can_start = !listed_control.is_empty();
            m.start_roots = listed_control;
        }
        Ok(m)
    }

    /// What a connection confined to a service UI pass may do on `machine_id`.
    ///
    /// A narrowing, not a second ACL: the answer is the intersection of the
    /// normal rule ("a restricted share is open to the people on its list")
    /// with the pass's fence — the key's workspace, the key's machines and
    /// shares STRICTLY under its `rootPrefix`. The exemptions the normal rule
    /// grants (the workspace owner sees every share, the device owner controls
    /// the whole machine, a manager sees the people they manage) are exactly
    /// what the pass must not inherit, so none is consulted here: the person
    /// sees, starts and reads only in the restricted shares they are LISTED on.
    /// Every other restricted share on the machine — a list they are not on, or
    /// one outside the fence — is a closed root that nothing inside can escape.
    fn scoped_machine_access(
        &self,
        access: &UiAccess,
        scope: &UiScope,
        machine_id: &str,
    ) -> Result<MachineAccess, String> {
        if access.workspace_id != scope.workspace_id
            || !scope.machine_ids.iter().any(|m| m == machine_id)
            || self.device_owner(machine_id)?.is_none()
        {
            return Ok(MachineAccess::default());
        }
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(&format!("SELECT p.root,p.workspace_id,p.access,{} FROM project_shares p WHERE p.machine_id=?1 AND p.restricted=1", share_listed_sql("p", "?2")))
            .map_err(db_err)?;
        let rows: Vec<(String, String, String, bool)> = stmt
            .query_map(params![machine_id, access.user_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .map_err(db_err)?
            .filter_map(Result::ok)
            .collect();
        let prefix = normalize_root(&scope.root_prefix);
        let mut roots: Vec<String> = Vec::new();
        let mut closed: Vec<String> = Vec::new();
        for (root, workspace_id, share_access, listed) in rows {
            let inside = path_is_within(&root, &prefix) && normalize_root(&root) != prefix;
            if listed && inside && workspace_id == scope.workspace_id && share_access == "control" {
                roots.push(root);
            } else {
                closed.push(root);
            }
        }
        let any = !roots.is_empty();
        Ok(MachineAccess {
            can_view: any,
            can_control: false,
            can_start: any,
            // A listed restricted share is a team room: everyone on the list
            // sees everyone's sessions in it, the device owner's included.
            owner_scoped: true,
            roots: Some(roots.clone()),
            open_roots: roots.clone(),
            start_roots: roots.clone(),
            denied_roots: closed.clone(),
            unlisted_roots: closed,
            reopen_roots: roots,
        })
    }

    /// `personal` | `sandbox` for a live device, None when unknown or revoked.
    pub fn device_kind(&self, machine_id: &str) -> Result<Option<String>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.query_row(
            "SELECT kind FROM devices WHERE machine_id=?1 AND revoked_at IS NULL",
            params![machine_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_err)
    }

    /// Does anybody besides the owner work on this box?
    ///
    /// This is the honest answer to "is the machine shared", and `kind` is NOT:
    /// `kind` records how a device was ENROLLED, so it says `sandbox` only for
    /// the hosted seats the provisioner registers. The employee sandbox was
    /// enrolled as an ordinary device — on the live hub `devbox` reads
    /// `personal` while carrying nine `control` shares, and exactly one machine
    /// in the whole table says `sandbox`. A project share is the thing that
    /// actually puts a second person on a machine, so it is the thing to ask
    /// about. Covered by `project_shares_machine`.
    pub fn device_has_shares(&self, machine_id: &str) -> Result<bool, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM project_shares WHERE machine_id=?1)",
            params![machine_id],
            |r| r.get(0),
        )
        .map_err(db_err)
    }

    /// Whether an agent on the shared fleet token may register as `machine_id`.
    ///
    /// The fleet token carries no machine identity, so without this anyone
    /// holding it could register ANY machine id — a community member's laptop
    /// included — supersede the real agent's socket and receive its prompts,
    /// terminal input and file RPCs. The token is the legacy door for the
    /// bootstrap owner's own boxes, so it may only open those: a machine that
    /// belongs to someone else, or that has enrolled a device credential of its
    /// own, is refused. A machine the hub has never seen is allowed (that is how
    /// a new fleet box appears); `CC_REMOTE_FLEET_MACHINE_IDS` narrows further.
    pub fn fleet_token_may_register(
        &self,
        machine_id: &str,
        bootstrap_user_id: &str,
    ) -> Result<bool, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let owner: Option<String> = conn
            .query_row(
                "SELECT owner_user_id FROM devices WHERE machine_id=?1",
                params![machine_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        if owner.as_deref().is_some_and(|o| o != bootstrap_user_id) {
            return Ok(false);
        }
        let enrolled: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM device_credentials WHERE machine_id=?1 AND revoked_at IS NULL)",
                params![machine_id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        Ok(!enrolled)
    }

    /// Machines of the OTHER members of the viewer's organization, which the
    /// workspace owner and every manager may see on the machines screen —
    /// hardware and runtime health only, read-only. This is deliberately NOT a
    /// `MachineAccess`: `can_view` there opens session lists and transcripts, and
    /// this grants none of that.
    ///
    /// Empty unless the viewer is an active owner/manager of an organization on
    /// a normal login (a service UI pass never gets it). The viewer's own
    /// devices are left out (they are already in their `machines`).
    pub fn team_hardware_machine_ids(&self, access: &UiAccess) -> Result<Vec<String>, String> {
        if access.kind != "organization"
            || !matches!(access.role.as_str(), "owner" | "manager")
            || !access.is_active()
            || access.ui_scope.is_some()
        {
            return Ok(Vec::new());
        }
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let mut stmt = conn
            // The viewer's role is re-read here, not trusted from the socket's
            // cached UiAccess: a manager demoted or removed a moment ago must
            // stop getting team frames before RefreshWorkspaceState reaches them.
            .prepare("SELECT d.machine_id FROM devices d JOIN memberships m ON m.user_id=d.owner_user_id WHERE m.workspace_id=?1 AND d.revoked_at IS NULL AND d.owner_user_id<>?2 AND EXISTS(SELECT 1 FROM memberships v WHERE v.workspace_id=?1 AND v.user_id=?2 AND v.role IN ('owner','manager')) ORDER BY d.machine_id")
            .map_err(db_err)?;
        let ids = stmt
            .query_map(params![access.workspace_id, access.user_id], |r| r.get(0))
            .map_err(db_err)?
            .filter_map(Result::ok)
            .collect();
        Ok(ids)
    }

    pub fn device_owner(&self, machine_id: &str) -> Result<Option<String>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.query_row(
            "SELECT owner_user_id FROM devices WHERE machine_id=?1 AND revoked_at IS NULL",
            params![machine_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_err)
    }

    pub fn owner_json(&self, machine_id: &str) -> Result<Option<Value>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.query_row(r#"SELECT u.user_id,u.email,u.full_name FROM devices d JOIN users u ON u.user_id=d.owner_user_id WHERE d.machine_id=?1"#,params![machine_id],|r|{let name:Option<String>=r.get(2)?;let mut v=json!({"userId":r.get::<_,String>(0)?});put_email(&mut v, r.get(1)?);if let Some(n)=name{v["fullName"]=Value::String(n)}Ok(v)}).optional().map_err(db_err)
    }

    /// `{userId,email,fullName?}` for a user id (mirror of `owner_json`), used to
    /// render session owner badges. Returns None for an unknown user.
    pub fn user_json(&self, user_id: &str) -> Result<Option<Value>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.query_row(
            "SELECT user_id,email,full_name FROM users WHERE user_id=?1",
            params![user_id],
            |r| {
                let name: Option<String> = r.get(2)?;
                let mut v = json!({"userId":r.get::<_,String>(0)?});
                put_email(&mut v, r.get(1)?);
                if let Some(n) = name {
                    v["fullName"] = Value::String(n)
                }
                Ok(v)
            },
        )
        .optional()
        .map_err(db_err)
    }

    /// Record who created a session (first writer wins — resume never rewrites it),
    /// with its category. Idempotent.
    pub fn record_session_owner(
        &self,
        machine_id: &str,
        session_id: &str,
        owner_user_id: &str,
        category: Option<&str>,
    ) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.execute(
            "INSERT OR IGNORE INTO session_owners(machine_id,session_id,owner_user_id,category,created_at) VALUES(?1,?2,?3,?4,?5)",
            params![machine_id, session_id, owner_user_id, category, now_ms()],
        )
        .map_err(db_err)?;
        Ok(())
    }

    /// Set (or clear) a session's kanban stage. MUTABLE, unlike
    /// `record_session_owner` — the Flow board updates it repeatedly. Upserts:
    /// if no ownership row exists yet (resumed/legacy session), it inserts one with
    /// the acting user as owner (owner_user_id is NOT NULL), otherwise it updates
    /// only `stage` and leaves owner/category untouched. `stage = None` clears it.
    pub fn set_session_stage(
        &self,
        machine_id: &str,
        session_id: &str,
        actor_user_id: &str,
        stage: Option<&str>,
    ) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.execute(
            "INSERT INTO session_owners(machine_id,session_id,owner_user_id,category,created_at,stage) \
             VALUES(?1,?2,?3,NULL,?4,?5) \
             ON CONFLICT(machine_id,session_id) DO UPDATE SET stage=excluded.stage",
            params![machine_id, session_id, actor_user_id, now_ms(), stage],
        )
        .map_err(db_err)?;
        Ok(())
    }

    /// Normalize a memory scope key. `fleet` rows are forced to an empty key:
    /// SQLite treats NULLs as DISTINCT in a UNIQUE constraint, so a nullable
    /// key would silently permit duplicate fleet rows for the same path.
    /// `machine`/`project` rows must carry a non-empty key or they would
    /// collapse into the fleet namespace.
    fn memory_key<'a>(scope: &str, scope_key: &'a str) -> Result<&'a str, String> {
        match scope {
            "fleet" => Ok(""),
            "machine" | "project" => {
                if scope_key.is_empty() {
                    Err(format!("memory scope '{scope}' requires a scope key"))
                } else {
                    Ok(scope_key)
                }
            }
            other => Err(format!("unknown memory scope: {other}")),
        }
    }

    /// Insert or update a memory file, bumping its revision. Resurrects a
    /// tombstoned row rather than colliding with it, so re-creating a deleted
    /// path works and the bumped revision still propagates the change.
    /// Returns the new revision.
    pub fn upsert_memory(
        &self,
        owner_user_id: &str,
        scope: &str,
        scope_key: &str,
        path: &str,
        content: &str,
    ) -> Result<i64, String> {
        let key = Self::memory_key(scope, scope_key)?;
        let now = now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.execute(
            "INSERT INTO memories(memory_id,owner_user_id,scope,scope_key,path,content,content_sha256,revision,deleted,created_at,updated_at) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,1,0,?8,?8) \
             ON CONFLICT(owner_user_id,scope,scope_key,path) DO UPDATE SET \
               content=excluded.content, content_sha256=excluded.content_sha256, \
               revision=memories.revision+1, deleted=0, updated_at=excluded.updated_at",
            params![
                Uuid::new_v4().to_string(),
                owner_user_id,
                scope,
                key,
                path,
                content,
                sha256_hex(content),
                now
            ],
        )
        .map_err(db_err)?;
        conn.query_row(
            "SELECT revision FROM memories WHERE owner_user_id=?1 AND scope=?2 AND scope_key=?3 AND path=?4",
            params![owner_user_id, scope, key, path],
            |r| r.get(0),
        )
        .map_err(db_err)
    }

    /// Metadata for every memory that could apply to a given machine: the
    /// user's fleet-wide rows, anything pinned to that machine, and ALL project
    /// rows. Content is left None on purpose — see `MemoryRecord`.
    ///
    /// Tombstones are INCLUDED here, unlike in `memory_list`. The agent offers
    /// every local file upward, so a deleted row that simply vanished from the
    /// catalog would look like "the hub is missing this" and be pushed back on
    /// the next reconcile. The marker is what lets deletion stick.
    ///
    /// Project rows are not filtered here because the hub does not know which
    /// repositories a machine has checked out — they are keyed on a git remote,
    /// and only the agent can map that to a local directory. Filtering them
    /// server-side would send an empty catalog to a machine that does hold the
    /// checkout, and it would push its notes forever without ever receiving
    /// any. The agent keeps the rows whose key it recognizes and ignores the
    /// rest; the payload is metadata for one user's own notes.
    pub fn memory_catalog(
        &self,
        owner_user_id: &str,
        machine_id: &str,
    ) -> Result<Vec<MemoryRecord>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT scope,scope_key,path,content_sha256,revision,updated_at,deleted,length(cast(content as blob)) FROM memories \
                 WHERE owner_user_id=?1 \
                   AND (scope='fleet' OR scope='project' OR (scope='machine' AND scope_key=?2)) \
                 ORDER BY path",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![owner_user_id, machine_id], |r| {
                Ok(MemoryRecord {
                    owner_user_id: owner_user_id.to_string(),
                    scope: r.get(0)?,
                    scope_key: r.get(1)?,
                    path: r.get(2)?,
                    content: None,
                    content_sha256: r.get(3)?,
                    revision: r.get(4)?,
                    updated_at: r.get(5)?,
                    deleted: r.get::<_, i64>(6)? != 0,
                    bytes: r.get(7)?,
                })
            })
            .map_err(db_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
    }

    /// Every live memory this user owns, across every scope. The browser view
    /// is user-wide, not machine-wide: `memory_catalog` answers "what should
    /// THIS host hold", which deliberately hides other machines' pinned notes,
    /// and a person looking at their own store wants all of it. Content is left
    /// None — see `MemoryRecord`.
    pub fn memory_list(&self, owner_user_id: &str) -> Result<Vec<MemoryRecord>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT scope,scope_key,path,content_sha256,revision,updated_at,length(cast(content as blob)) FROM memories \
                 WHERE owner_user_id=?1 AND deleted=0 \
                 ORDER BY scope,scope_key,path",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![owner_user_id], |r| {
                Ok(MemoryRecord {
                    owner_user_id: owner_user_id.to_string(),
                    scope: r.get(0)?,
                    scope_key: r.get(1)?,
                    path: r.get(2)?,
                    content: None,
                    content_sha256: r.get(3)?,
                    revision: r.get(4)?,
                    updated_at: r.get(5)?,
                    bytes: r.get(6)?,
                    // The query already excludes tombstones — people's views
                    // show what exists, not what used to.
                    deleted: false,
                })
            })
            .map_err(db_err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_err)
    }

    /// One memory with its content. None if absent or tombstoned.
    pub fn read_memory(
        &self,
        owner_user_id: &str,
        scope: &str,
        scope_key: &str,
        path: &str,
    ) -> Result<Option<MemoryRecord>, String> {
        let key = Self::memory_key(scope, scope_key)?;
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.query_row(
            "SELECT content,content_sha256,revision,updated_at FROM memories \
             WHERE owner_user_id=?1 AND scope=?2 AND scope_key=?3 AND path=?4 AND deleted=0",
            params![owner_user_id, scope, key, path],
            |r| {
                Ok(MemoryRecord {
                    owner_user_id: owner_user_id.to_string(),
                    scope: scope.to_string(),
                    scope_key: key.to_string(),
                    path: path.to_string(),
                    content: Some(r.get(0)?),
                    content_sha256: r.get(1)?,
                    revision: r.get(2)?,
                    updated_at: r.get(3)?,
                    bytes: 0,       // the caller has the content; size is redundant here
                    deleted: false, // the query refuses tombstones outright
                })
            },
        )
        .optional()
        .map_err(db_err)
    }

    /// Tombstone a memory. The row survives with `deleted=1` and a bumped
    /// revision so the delete replicates to machines that still hold the file;
    /// dropping it outright would look identical to "never synced" and the
    /// file would come straight back. Content is cleared. Returns whether a
    /// live row was actually tombstoned.
    ///
    /// Reached from the UI `memory_delete` message (`Hub::ui_memory_delete`).
    /// Only the catalog carries the tombstone to agents; the agent retires its
    /// own local file, the hub never removes it.
    pub fn delete_memory(
        &self,
        owner_user_id: &str,
        scope: &str,
        scope_key: &str,
        path: &str,
    ) -> Result<bool, String> {
        let key = Self::memory_key(scope, scope_key)?;
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let changed = conn
            .execute(
                "UPDATE memories SET deleted=1, content='', content_sha256=?5, \
                   revision=revision+1, updated_at=?6 \
                 WHERE owner_user_id=?1 AND scope=?2 AND scope_key=?3 AND path=?4 AND deleted=0",
                params![owner_user_id, scope, key, path, sha256_hex(""), now_ms()],
            )
            .map_err(db_err)?;
        Ok(changed > 0)
    }

    /// All `(machine_id, session_id, owner_user_id, category, stage, origin)` rows, for the
    /// hub's in-memory session-meta cache (loaded once at startup).
    pub fn all_session_meta(&self) -> Result<SessionMetaRows, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT machine_id,session_id,owner_user_id,category,stage,origin FROM session_owners",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                ))
            })
            .map_err(db_err)?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub(crate) fn require_member(
        &self,
        user_id: &str,
        workspace_id: &str,
    ) -> Result<String, String> {
        if !self.support_gate(user_id) {
            return Err("workspace access denied".into());
        }
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.query_row(
            "SELECT role FROM memberships WHERE workspace_id=?1 AND user_id=?2",
            params![workspace_id, user_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_err)?
        .ok_or_else(|| "workspace access denied".into())
    }

    // `column_sets` / `create_column_set` / `update_column_set` /
    // `delete_column_set` and the `column_sets` table are gone. They persisted
    // «Наборы» — saved splits, per user per workspace — which existed because
    // the split was a screen you arrived at EMPTY and refilled by hand from a
    // picker. A pane is added from the session list's own right-click menu now,
    // so a split costs one click to rebuild and there is nothing worth a table.
    // The URL still carries the set, which is what made a split shareable.
    //
    // No DROP migration: existing rows are harmless, and a drop is the one
    // migration that cannot be undone by re-deploying the previous binary.

    pub(crate) fn require_role(
        &self,
        user_id: &str,
        workspace_id: &str,
        roles: &[&str],
    ) -> Result<(), String> {
        let role = self.require_member(user_id, workspace_id)?;
        if roles.contains(&role.as_str()) {
            Ok(())
        } else {
            Err("insufficient workspace role".into())
        }
    }
}

/// The body of `create_enrollment_for`, on an open connection or transaction:
/// the provisioning claim mints a sandbox code inside its own transaction
/// (the store mutex is not re-entrant). `purpose='device'` codes are
/// rate-limited per user; sandbox codes are the hub's own and are not counted.
pub(crate) fn mint_enrollment(
    conn: &Connection,
    user_id: &str,
    purpose: &str,
) -> Result<Value, String> {
    let purpose = if purpose == "sandbox" {
        "sandbox"
    } else {
        "device"
    };
    let raw = Uuid::new_v4().simple().to_string()[..10].to_ascii_uppercase();
    let code = format!("{}-{}", &raw[..5], &raw[5..]);
    let now = now_ms();
    if purpose == "device" {
        let recent: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM enrollments WHERE user_id=?1 AND purpose='device' AND created_at>?2",
                params![user_id, now - 60 * 60 * 1000],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if recent as usize >= ENROLLMENTS_PER_HOUR {
            return Err(ENROLLMENT_RATE_ERR.into());
        }
    }
    conn.execute(
        "INSERT INTO enrollments(code_hash,user_id,created_at,expires_at,purpose) VALUES(?1,?2,?3,?4,?5)",
        params![hash_token(&code), user_id, now, now + 15 * 60 * 1000, purpose],
    )
    .map_err(db_err)?;
    Ok(json!({"code":code,"expiresAt":now+15*60*1000,"purpose":purpose}))
}

pub(crate) fn insert_audit(
    conn: &Connection,
    workspace_id: &str,
    actor: &str,
    action: &str,
    target_kind: &str,
    target_id: &str,
    metadata: &Value,
) -> Result<(), String> {
    conn.execute("INSERT INTO audit_events(audit_event_id,workspace_id,actor_user_id,action,target_kind,target_id,metadata_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![Uuid::new_v4().to_string(),workspace_id,actor,action,target_kind,target_id,metadata.to_string(),now_ms()]).map_err(db_err)?;
    Ok(())
}
/// SQL: the share `alias` is open to the user in parameter `user_param` — it is
/// not restricted (the whole team, as before) or the user is on its list. The
/// workspace owner and the device owner never go through this.
/// owner and the device owner never go through this: they see every share.
pub(crate) fn share_acl_clause(alias: &str, user_param: &str) -> String {
    format!(
        "({alias}.restricted=0 OR {})",
        share_listed_sql(alias, user_param)
    )
}

/// SQL: the user in `user_param` is on the list of share `alias` AND is
/// currently a member of that share's workspace. A list row outlives a person
/// leaving the team (it is also deleted on removal); the membership join makes
/// sure a stale row never counts.
pub(crate) fn share_listed_sql(alias: &str, user_param: &str) -> String {
    format!(
        "EXISTS(SELECT 1 FROM project_share_members l JOIN memberships lm ON lm.workspace_id={alias}.workspace_id AND lm.user_id=l.user_id WHERE l.project_share_id={alias}.project_share_id AND l.user_id={user_param})"
    )
}

/// `[{userId, role, name?}]` of a share's list, in the order they were added.
///
/// A person without a name is shown by their e-mail only when `email_ok`; to
/// anyone else the id's first characters stand in, so a list on a share does
/// not hand out addresses.
pub(crate) fn share_members_json(
    conn: &Connection,
    share_id: &str,
    email_ok: bool,
) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare("SELECT m.user_id,m.role,u.full_name,u.email FROM project_share_members m LEFT JOIN users u ON u.user_id=m.user_id WHERE m.project_share_id=?1 ORDER BY m.added_at,m.rowid")
        .map_err(db_err)?;
    let rows = stmt
        .query_map(params![share_id], |r| {
            let full: Option<String> = r.get(2)?;
            let email: Option<String> = r.get(3)?;
            let user_id: String = r.get(0)?;
            let name = full
                .filter(|n| !n.trim().is_empty())
                .or(if email_ok { email } else { None })
                .unwrap_or_else(|| user_id.chars().take(8).collect());
            Ok(json!({"userId":user_id,"role":r.get::<_,String>(1)?,"name":name}))
        })
        .map_err(db_err)?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// Split off the part of a path that cannot be climbed out of — the UNC share,
/// the drive letter, or the leading slash — from the traversable remainder.
/// Returns `(prefix, absolute, rest)`; a normalized path is rebuilt on top of
/// `prefix`, and `absolute == false` means the input was relative.
fn split_root_prefix(path: &str) -> (String, bool, &str) {
    if let Some(after) = path.strip_prefix("//") {
        // UNC: server and share belong to the root, not to the traversable tail.
        let mut it = after.splitn(3, '/');
        let server = it.next().unwrap_or("");
        let share = it.next().unwrap_or("");
        let tail = it.next().unwrap_or("");
        if !server.is_empty() && !share.is_empty() {
            return (format!("//{server}/{share}"), true, tail);
        }
        return ("/".to_string(), true, after);
    }
    if path.len() >= 2 && path.as_bytes()[1] == b':' {
        let (drive, rest) = path.split_at(2);
        return (drive.to_string(), true, rest.trim_start_matches('/'));
    }
    if let Some(rest) = path.strip_prefix('/') {
        return (String::new(), true, rest);
    }
    (String::new(), false, path)
}

/// Canonicalize a path *lexically* — resolving `.` and `..` without touching
/// the filesystem, which the hub could not do anyway since the path names a
/// directory on some other machine.
///
/// Resolving `..` is a security property, not tidiness. `path_is_within` is the
/// gate on a control-share member's roots, and a prefix comparison against an
/// unresolved path accepts `/repo/../etc` as being inside `/repo`, which hands
/// a member every directory on the box.
pub fn normalize_root(root: &str) -> String {
    let raw = root.trim();
    let windows_path = raw.starts_with(r#"\\"#) || (raw.len() >= 2 && raw.as_bytes()[1] == b':');
    let mut out = raw.replace('\\', "/");
    if windows_path {
        out = out.to_ascii_lowercase();
    }
    let (prefix, absolute, rest) = split_root_prefix(&out);
    let mut parts: Vec<&str> = Vec::new();
    for segment in rest.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !absolute {
                    // A relative path may legitimately begin above itself;
                    // dropping the `..` would silently rebase it. Inside an
                    // absolute path a leading `..` is a no-op — there is
                    // nothing above the root to climb to.
                    parts.push("..");
                }
            }
            other => parts.push(other),
        }
    }
    let joined = parts.join("/");
    if absolute {
        format!("{prefix}/{joined}")
    } else {
        joined
    }
}

pub fn path_is_within(cwd: &str, root: &str) -> bool {
    let cwd = normalize_root(cwd);
    let root = normalize_root(root);
    // A filesystem root (`/`, `c:/`) already ends in the separator: everything
    // that starts with it is below it.
    if root.ends_with('/') {
        return cwd.starts_with(&root);
    }
    cwd == root
        || cwd
            .strip_prefix(&root)
            .is_some_and(|rest| rest.starts_with('/'))
}

#[cfg(test)]
mod tests {

    /// A client that names no workspace lands in a team whenever the user has
    /// one (owned team first) — machine or not; personal only without a team.
    /// An explicit request always wins; internal callers keep personal.
    #[test]
    fn landing_prefers_a_team_and_keeps_personal_for_internal_callers() {
        let s = WorkspaceStore::open_memory();
        for u in ["dima", "owner", "solo"] {
            s.ensure_user(u, &format!("{u}@x"), None).unwrap();
        }
        {
            let c = s.conn.lock().unwrap();
            c.execute("INSERT INTO workspaces(workspace_id,name,kind,owner_user_id,created_at) VALUES('team','Hegai Team','organization','owner',1),('aaa','Aaa','organization','dima',1)", []).unwrap();
            c.execute("INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES('team','dima','member',1),('team','owner','owner',1),('aaa','owner','member',1)", []).unwrap();
            c.execute("INSERT INTO devices(machine_id,owner_user_id,name,os,agent_version,last_seen,created_at) VALUES('m1','owner','mac','darwin','1',1,1)", []).unwrap();
        }
        let personal = |u: &str| format!("personal:{u}");
        let land = |u: &str, r: Option<&str>| s.ui_landing(u, r, false).unwrap().workspace_id;
        assert_eq!(land("dima", None), "team");
        assert_eq!(land("dima", Some("gone")), "team");
        assert_eq!(land("dima", Some(&personal("dima"))), personal("dima"));
        // A machine owner too: the team shows their machines in full.
        // Owned team wins over a team listed earlier by name.
        assert_eq!(land("owner", None), "team");
        assert_eq!(land("solo", None), personal("solo"));
        // Internal callers (audit rows) keep the personal fallback.
        assert_eq!(
            s.ui_access("dima", None, false).unwrap().workspace_id,
            personal("dima")
        );
    }

    #[test]
    fn a_service_session_is_told_apart_and_an_unknown_token_counts_as_one() {
        let ws = WorkspaceStore::open_memory();
        ws.ensure_user("u", "u@example.com", None).unwrap();
        let token = ws.create_auth_session("u", 7).unwrap();
        assert_eq!(ws.session_is_service(&token), Ok(false));
        assert_eq!(ws.session_is_service("no-such-token"), Ok(true));
        ws.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE auth_sessions SET service_workspace_id='w' WHERE user_id='u'",
                [],
            )
            .unwrap();
        assert_eq!(ws.session_is_service(&token), Ok(true));
    }

    /// The hub seeds CC_REMOTE_BOOTSTRAP_USER_ID on every start, and on any
    /// deployment that adopted legacy machines that id belongs to a real person.
    /// A later call that does not know their name must not erase it — otherwise
    /// every restart renames them.
    #[test]
    fn ensure_user_never_erases_a_known_name() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("u1", "u1@x", Some("Владелец Орлов")).unwrap();
        s.ensure_user("u1", "u1@x", None).unwrap();
        let conn = s.conn.lock().unwrap();
        let name: Option<String> = conn
            .query_row("SELECT full_name FROM users WHERE user_id='u1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(name.as_deref(), Some("Владелец Орлов"));
    }

    /// ...and a user who has no name yet gets the first one a login brings.
    #[test]
    fn ensure_user_accepts_a_newer_name() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("u1", "u1@x", None).unwrap();
        s.ensure_user("u1", "u1@x", Some("Real Name")).unwrap();
        let conn = s.conn.lock().unwrap();
        let name: Option<String> = conn
            .query_row("SELECT full_name FROM users WHERE user_id='u1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(name.as_deref(), Some("Real Name"));
    }

    /// An agent's test login under a real id carried «Owner (verify)» and
    /// renamed Owner everywhere (10.10.2026). A known name is kept.
    #[test]
    fn a_later_login_does_not_rename_a_known_user() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("u1", "u1@x", Some("Владелец Орлов")).unwrap();
        s.ensure_user("u1", "u1@x", Some("Owner (verify)")).unwrap();
        let conn = s.conn.lock().unwrap();
        let name: Option<String> = conn
            .query_row("SELECT full_name FROM users WHERE user_id='u1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(name.as_deref(), Some("Владелец Орлов"));
    }
    use super::*;
    #[test]
    fn memory_scope_isolates_fleet_from_machine() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("u1", "u1@x", None).unwrap();
        s.ensure_user("u2", "u2@x", None).unwrap();

        s.upsert_memory("u1", "fleet", "", "hub.md", "hub lives on hub-vps-01")
            .unwrap();
        s.upsert_memory(
            "u1",
            "machine",
            "mac-mini",
            "launchd.md",
            "kickstart to fix",
        )
        .unwrap();
        s.upsert_memory(
            "u1",
            "project",
            "github.com/me/repo",
            "repo.md",
            "repo note",
        )
        .unwrap();
        s.upsert_memory("u2", "fleet", "", "other.md", "not yours")
            .unwrap();

        // The Mac mini sees its own pinned note; stage does not.
        let mac: Vec<_> = s
            .memory_catalog("u1", "mac-mini")
            .unwrap()
            .into_iter()
            .map(|m| m.path)
            .collect();
        assert_eq!(mac, vec!["hub.md", "launchd.md", "repo.md"]);
        let stage: Vec<_> = s
            .memory_catalog("u1", "stage")
            .unwrap()
            .into_iter()
            .map(|m| m.path)
            .collect();
        // Project rows reach EVERY machine: they are keyed on a git remote and
        // only the agent knows which repos it has. Withholding them here is
        // what would strand a checkout pushing forever and receiving nothing.
        assert_eq!(stage, vec!["hub.md", "repo.md"]);

        // Another user's fleet memory never leaks in.
        assert!(!stage.contains(&"other.md".to_string()));
        // Catalog stays cheap: metadata only.
        assert!(s.memory_catalog("u1", "stage").unwrap()[0]
            .content
            .is_none());
    }

    #[test]
    fn memory_upsert_bumps_revision_and_delete_tombstones() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("u1", "u1@x", None).unwrap();

        assert_eq!(s.upsert_memory("u1", "fleet", "", "n.md", "v1").unwrap(), 1);
        assert_eq!(s.upsert_memory("u1", "fleet", "", "n.md", "v2").unwrap(), 2);
        let got = s.read_memory("u1", "fleet", "", "n.md").unwrap().unwrap();
        assert_eq!(got.content.as_deref(), Some("v2"));
        assert_eq!(got.content_sha256, sha256_hex("v2"));

        // Tombstone: refused by reads, and by the people-facing list, but STILL
        // PRESENT in the agent catalog and marked deleted. That marker is what
        // makes deletion stick: agents offer every local file upward, so a row
        // that merely vanished would read as "the hub is missing this" and be
        // pushed back on the next reconcile.
        assert!(s.delete_memory("u1", "fleet", "", "n.md").unwrap());
        assert!(s.read_memory("u1", "fleet", "", "n.md").unwrap().is_none());
        assert!(s.memory_list("u1").unwrap().is_empty());
        let catalog = s.memory_catalog("u1", "any").unwrap();
        assert_eq!(catalog.len(), 1);
        assert!(catalog[0].deleted);
        assert!(!s.delete_memory("u1", "fleet", "", "n.md").unwrap());

        // Re-creating the path resurrects the row and keeps climbing, so the
        // revival outranks the tombstone every machine already replicated.
        assert_eq!(s.upsert_memory("u1", "fleet", "", "n.md", "v3").unwrap(), 4);
        let revived = s.memory_catalog("u1", "any").unwrap();
        assert_eq!(revived.len(), 1);
        assert!(!revived[0].deleted);
        assert_eq!(s.memory_list("u1").unwrap().len(), 1);
        // Size travels with the catalog so clients can watch a corpus grow
        // without fetching bodies.
        assert_eq!(revived[0].bytes, 2);
    }

    #[test]
    fn memory_rejects_bad_scopes() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("u1", "u1@x", None).unwrap();
        // A machine note with no machine would collapse into the fleet namespace.
        assert!(s.upsert_memory("u1", "machine", "", "n.md", "x").is_err());
        assert!(s.upsert_memory("u1", "nonsense", "k", "n.md", "x").is_err());
        // A fleet key is ignored, not silently stored as a second namespace.
        s.upsert_memory("u1", "fleet", "ignored", "n.md", "x")
            .unwrap();
        assert_eq!(
            s.read_memory("u1", "fleet", "", "n.md")
                .unwrap()
                .unwrap()
                .scope_key,
            ""
        );
    }

    /// `path_is_within` gates a control-share member's roots, including which
    /// cwd they may start a session in. Before `normalize_root` resolved `..`
    /// this returned true for `/repo/../etc`, so a share on one directory was
    /// a share on the whole machine.
    #[test]
    fn a_share_cannot_be_escaped_with_dot_dot() {
        assert!(!path_is_within("/repo/../etc", "/repo"));
        assert!(!path_is_within("/repo/../../root", "/repo"));
        assert!(!path_is_within("/repo/sub/../../etc", "/repo"));
        assert!(!path_is_within(
            r#"C:\Work\Repo\..\Secrets"#,
            r#"c:\work\repo"#
        ));
        // Climbing out of the root is a no-op, not an escape hatch.
        assert!(!path_is_within("/../etc", "/repo"));
        // Traversal that stays inside is still allowed.
        assert!(path_is_within("/repo/sub/../src", "/repo"));
        assert!(path_is_within("/repo/./src", "/repo"));
        assert!(path_is_within("/repo/", "/repo"));
    }

    #[test]
    fn roots_respect_boundaries_and_windows_case() {
        assert!(path_is_within(r#"C:\Work\Repo\src"#, r#"c:\work\repo"#));
        assert!(path_is_within(
            r#"\\server\share\Repo\src"#,
            r#"\\SERVER\SHARE\repo"#
        ));
        assert!(!path_is_within("/repo-other", "/repo"));
    }
    #[test]
    fn role_and_project_scope_isolated() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("owner", "o@x", Some("Owner")).unwrap();
        s.ensure_user("manager", "m@x", None).unwrap();
        s.ensure_user("member", "e@x", None).unwrap();
        let w = s.create_organization("owner", "Team", "owner").unwrap();
        let wid = w["workspaceId"].as_str().unwrap();
        let manager_invite = s.invite("owner", wid, "m@x", "manager").unwrap();
        let member_invite = s.invite("owner", wid, "e@x", "member").unwrap();
        s.ensure_user("manager", "m@x", None).unwrap();
        s.ensure_user("member", "e@x", None).unwrap();
        s.accept_invitation("manager", manager_invite["token"].as_str().unwrap())
            .unwrap();
        s.accept_invitation("member", member_invite["token"].as_str().unwrap())
            .unwrap();
        s.register_legacy_device(
            "member",
            &json!({"machineId":"box","name":"Box","os":"linux","agentVersion":"1"}),
        )
        .unwrap();
        let p = s
            .share_project("member", wid, "box", "/repo", "Repo", "view", "team")
            .unwrap();
        let a = s.ui_access("manager", Some(wid), false).unwrap();
        assert!(!s.machine_access(&a, "box").unwrap().can_view);
        s.assign_manager(
            "owner",
            wid,
            "manager",
            "project",
            p["projectShareId"].as_str().unwrap(),
        )
        .unwrap();
        assert!(s.machine_access(&a, "box").unwrap().can_view);
    }

    #[test]
    fn team_hardware_machines_are_for_owner_and_manager_only() {
        let s = WorkspaceStore::open_memory();
        for (id, mail) in [
            ("owner", "o@x"),
            ("manager", "m@x"),
            ("member", "e@x"),
            ("stranger", "s@x"),
        ] {
            s.ensure_user(id, mail, None).unwrap();
            s.activate_access(id, "tests").unwrap();
        }
        let w = s.create_organization("owner", "Team", "owner").unwrap();
        let wid = w["workspaceId"].as_str().unwrap();
        for (user, mail, role) in [("manager", "m@x", "manager"), ("member", "e@x", "member")] {
            let invite = s.invite("owner", wid, mail, role).unwrap();
            s.accept_invitation(user, invite["token"].as_str().unwrap())
                .unwrap();
        }
        let reg = |user: &str, id: &str| {
            s.register_legacy_device(
                user,
                &json!({"machineId":id,"name":id,"os":"linux","agentVersion":"1"}),
            )
            .unwrap()
        };
        reg("owner", "own-box");
        reg("manager", "mgr-box");
        reg("member", "mem-box");
        reg("member", "mem-old");
        reg("stranger", "other-box");
        s.revoke_device("member", "mem-old").unwrap();

        let ids = |user: &str| {
            let a = s.ui_access(user, Some(wid), false).unwrap();
            s.team_hardware_machine_ids(&a).unwrap()
        };
        assert_eq!(ids("owner"), vec!["mem-box", "mgr-box"]);
        assert_eq!(ids("manager"), vec!["mem-box", "own-box"]);
        assert!(ids("member").is_empty());

        // Granting this never widens what the viewer may open.
        let a = s.ui_access("manager", Some(wid), false).unwrap();
        assert!(!s.machine_access(&a, "mem-box").unwrap().can_view);

        // A service pass never gets it; a personal workspace has no team.
        let scoped = a.clone().with_scope(UiScope {
            issuer: "legal".into(),
            workspace_id: wid.into(),
            machine_ids: vec!["own-box".into()],
            root_prefix: "/x".into(),
        });
        assert!(s.team_hardware_machine_ids(&scoped).unwrap().is_empty());
        let personal = s.ui_access("owner", None, false).unwrap();
        assert_eq!(personal.kind, "personal");
        assert!(s.team_hardware_machine_ids(&personal).unwrap().is_empty());

        // The role is re-read from the database: a socket still holding the old
        // manager access gets nothing once the membership is demoted.
        let stale = s.ui_access("manager", Some(wid), false).unwrap();
        s.set_member_role("owner", wid, "manager", "member")
            .unwrap();
        assert!(s.team_hardware_machine_ids(&stale).unwrap().is_empty());
    }

    #[test]
    fn member_control_share_grants_start_not_control() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("owner", "o@x", Some("Owner")).unwrap();
        s.ensure_user("member", "e@x", None).unwrap();
        let w = s.create_organization("owner", "Team", "owner").unwrap();
        let wid = w["workspaceId"].as_str().unwrap();
        let invite = s.invite("owner", wid, "e@x", "member").unwrap();
        s.accept_invitation("member", invite["token"].as_str().unwrap())
            .unwrap();
        // Owner owns the device (stage-like), shares a root with 'control'.
        s.register_legacy_device(
            "owner",
            &json!({"machineId":"stage","name":"Stage","os":"linux","agentVersion":"1"}),
        )
        .unwrap();
        let member = s.ui_access("member", Some(wid), false).unwrap();
        // A view-only share grants the member nothing (700-member invariant).
        s.share_project("owner", wid, "stage", "/work", "Stage", "view", "team")
            .unwrap();
        assert!(!s.machine_access(&member, "stage").unwrap().can_view);
        // A control share grants start rights but NOT full control.
        s.share_project("owner", wid, "stage", "/work2", "Stage2", "control", "team")
            .unwrap();
        let a = s.machine_access(&member, "stage").unwrap();
        assert!(a.can_view && a.can_start && !a.can_control && a.owner_scoped);
        assert_eq!(a.roots.as_deref(), Some(&["/work2".to_string()][..]));

        // The file manager's read access rides these roots and nothing else.
        // `hub/rpc.rs` lets a control-share member call fs.list/read/download
        // only for a cwd inside one of them, so the containment test IS the
        // permission — worth pinning here, next to the share that defines it.
        let roots = a.roots.clone().unwrap();
        assert!(roots.iter().any(|r| path_is_within("/work2", r)));
        assert!(roots.iter().any(|r| path_is_within("/work2/app/src", r)));
        // The root that was shared view-only never becomes readable, and
        // neither does the owner's home.
        assert!(!roots.iter().any(|r| path_is_within("/work", r)));
        assert!(!roots.iter().any(|r| path_is_within("/home/owner/.ssh", r)));
        // The classic prefix trap: a sibling directory whose name merely starts
        // the same way is not inside the share.
        assert!(!roots.iter().any(|r| path_is_within("/work2-secrets", r)));
        // The device owner still has full, non-scoped control.
        let owner = s.ui_access("owner", Some(wid), false).unwrap();
        let oa = s.machine_access(&owner, "stage").unwrap();
        assert!(oa.can_control && oa.can_start && !oa.owner_scoped);
    }

    #[test]
    fn session_visible_owner_scoping() {
        let control = MachineAccess {
            can_view: true,
            can_control: false,
            can_start: true,
            owner_scoped: true,
            roots: Some(vec![]),
            open_roots: Vec::new(),
            ..MachineAccess::default()
        };
        let dev = Some("owner");
        // Owner-scoped viewer: unowned hidden, device-owner hidden, member visible.
        assert!(!session_visible(&control, None, dev, Some("/work")));
        assert!(!session_visible(
            &control,
            Some("owner"),
            dev,
            Some("/work")
        ));
        assert!(session_visible(&control, Some("olya"), dev, Some("/work")));
        // Full control sees everything, including unowned.
        let full = MachineAccess {
            can_view: true,
            can_control: true,
            can_start: true,
            owner_scoped: false,
            roots: None,
            open_roots: Vec::new(),
            ..MachineAccess::default()
        };
        assert!(session_visible(&full, None, dev, None));
        assert!(session_visible(&full, Some("owner"), dev, None));
    }

    /// An `everyone` share opens the owner's own sessions to the team — but
    /// only under that root. Everywhere else the employee rule still holds.
    #[test]
    fn an_everyone_share_shows_the_owners_sessions_only_under_its_root() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("owner", "o@x", Some("Owner")).unwrap();
        s.ensure_user("member", "e@x", None).unwrap();
        let w = s.create_organization("owner", "Team", "owner").unwrap();
        let wid = w["workspaceId"].as_str().unwrap();
        let invite = s.invite("owner", wid, "e@x", "member").unwrap();
        s.accept_invitation("member", invite["token"].as_str().unwrap())
            .unwrap();
        s.register_legacy_device(
            "owner",
            &json!({"machineId":"sb","name":"Sandbox","os":"linux","agentVersion":"1"}),
        )
        .unwrap();
        let open = s
            .share_project(
                "owner",
                wid,
                "sb",
                "/home/sb/work/app",
                "App",
                "control",
                "everyone",
            )
            .unwrap();
        assert_eq!(open["visibility"], "everyone");
        s.share_project(
            "owner",
            wid,
            "sb",
            "/home/sb/work/private",
            "Private",
            "control",
            "team",
        )
        .unwrap();
        // The list carries the flag so the team form can show it.
        let listed = s.projects("owner", wid).unwrap();
        assert!(listed.iter().any(|p| p["visibility"] == "everyone"));
        assert!(listed.iter().any(|p| p["visibility"] == "team"));

        let member = s.ui_access("member", Some(wid), false).unwrap();
        let a = s.machine_access(&member, "sb").unwrap();
        assert!(a.owner_scoped);
        assert_eq!(a.open_roots, vec!["/home/sb/work/app".to_string()]);
        let dev = Some("owner");
        // Under the open root the owner's own (and even unowned) sessions show.
        assert!(session_visible(
            &a,
            Some("owner"),
            dev,
            Some("/home/sb/work/app/src")
        ));
        assert!(session_visible(&a, None, dev, Some("/home/sb/work/app")));
        // Under the team-visibility root the owner stays private, as today.
        assert!(!session_visible(
            &a,
            Some("owner"),
            dev,
            Some("/home/sb/work/private")
        ));
        assert!(session_visible(
            &a,
            Some("member"),
            dev,
            Some("/home/sb/work/private")
        ));
        // No cwd known: the owner rule decides.
        assert!(!session_visible(&a, Some("owner"), dev, None));
        // A sibling that merely shares a prefix is not inside the open root.
        assert!(!session_visible(
            &a,
            Some("owner"),
            dev,
            Some("/home/sb/work/app-two")
        ));
    }
    /// Revoking has to actually turn the machine away. It used to only hide it
    /// from the UI, so an agent on the shared fleet token reconnected for hours
    /// after being revoked — visible in the hub log, invisible in the product.
    #[test]
    fn revoking_a_device_turns_it_away_and_restoring_lets_it_back() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("u", "u@x", None).unwrap();
        let machine = json!({"machineId":"m","name":"M","os":"windows","agentVersion":"1"});
        s.register_legacy_device("u", &machine).unwrap();
        assert!(!s.device_revoked("m").unwrap(), "a fresh device is usable");

        s.revoke_device("u", "m").unwrap();
        assert!(
            s.device_revoked("m").unwrap(),
            "register must refuse it now"
        );

        // The reconnect path must NOT quietly clear the revocation: touch_device
        // runs on every register and used to leave revoked_at alone, which is
        // what made the state unrecoverable from the product.
        s.touch_device(&machine, "u").unwrap();
        assert!(
            s.device_revoked("m").unwrap(),
            "reconnecting cannot self-restore"
        );

        s.restore_device("u", "m").unwrap();
        assert!(!s.device_revoked("m").unwrap(), "restore gives it back");

        // Restoring twice is not a silent no-op — the caller learns nothing changed.
        assert!(s.restore_device("u", "m").is_err());
        // And only the owner may restore.
        s.revoke_device("u", "m").unwrap();
        assert!(s.restore_device("someone-else", "m").is_err());
        assert!(s.device_revoked("m").unwrap());
    }

    /// The shared fleet token used to register as ANY machine id, superseding
    /// the real agent and receiving its prompts and terminal. It may now speak
    /// only for the bootstrap owner's own, non-enrolled boxes.
    #[test]
    fn fleet_token_cannot_register_someone_elses_or_an_enrolled_machine() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("boot", "boot@x", None).unwrap();
        s.ensure_user("anna", "anna@x", None).unwrap();
        let m = |id: &str| json!({"machineId":id,"name":id,"os":"linux","agentVersion":"1"});

        // never seen: a new fleet box may appear
        assert!(s.fleet_token_may_register("new-box", "boot").unwrap());
        // the owner's own legacy box: still fine
        s.register_legacy_device("boot", &m("legacy")).unwrap();
        assert!(s.fleet_token_may_register("legacy", "boot").unwrap());
        // somebody else's machine: refused
        let code = s.create_enrollment("anna").unwrap();
        s.exchange_enrollment(code["code"].as_str().unwrap(), &m("annas-laptop"))
            .unwrap();
        assert!(!s.fleet_token_may_register("annas-laptop", "boot").unwrap());
        // the owner's machine that enrolled its own credential: refused too —
        // it has a better key and the shared one must not stand in for it
        let code = s.create_enrollment("boot").unwrap();
        s.exchange_enrollment(code["code"].as_str().unwrap(), &m("enrolled"))
            .unwrap();
        assert!(!s.fleet_token_may_register("enrolled", "boot").unwrap());
    }

    #[test]
    fn a_used_session_still_ends_at_the_ceiling() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("u", "u@x", None).unwrap();
        let token = s.create_auth_session("u", 90).unwrap();
        assert!(s.authenticate(&token).unwrap().is_some());
        // Signed in 179 days ago and used all along: still in, but the slide
        // never reaches past the ceiling.
        let now = now_ms();
        {
            let conn = s.conn.lock().unwrap();
            conn.execute(
                "UPDATE auth_sessions SET created_at=?1, expires_at=?2 WHERE token_hash=?3",
                params![
                    now - SESSION_MAX_MS + 3_600_000,
                    now + 1000,
                    hash_token(&token)
                ],
            )
            .unwrap();
        }
        let (_, expires) = s.authenticate(&token).unwrap().unwrap();
        assert!(expires <= now + 3_600_000 + 1000, "slid past the ceiling");
        // A day later it is over, however much it is used.
        {
            let conn = s.conn.lock().unwrap();
            conn.execute(
                "UPDATE auth_sessions SET created_at=?1, expires_at=?2 WHERE token_hash=?3",
                params![
                    now - SESSION_MAX_MS - 1,
                    now + 86_400_000,
                    hash_token(&token)
                ],
            )
            .unwrap();
        }
        assert!(s.authenticate(&token).unwrap().is_none());
    }

    #[test]
    fn sessions_are_listed_and_ended_by_their_owner_only() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("u", "u@x", None).unwrap();
        s.ensure_user("v", "v@x", None).unwrap();
        let phone = s.create_auth_session("u", 90).unwrap();
        let laptop = s.create_auth_session("u", 7).unwrap();
        let thief = s.create_auth_session("u", 7).unwrap();
        let other = s.create_auth_session("v", 7).unwrap();
        s.note_session(&phone, "приложение · iOS");
        let list = s.list_sessions("u").unwrap();
        assert_eq!(list.len(), 3);
        assert!(list.iter().any(|x| x["label"] == "приложение · iOS"));
        assert!(list.iter().all(|x| x["id"].as_str().unwrap().len() == 64));
        // Not somebody else's.
        assert!(!s.revoke_session("v", &hash_token(&thief)).unwrap());
        assert!(s.session_alive(&hash_token(&thief)).unwrap());
        // One by id.
        assert!(s.revoke_session("u", &hash_token(&thief)).unwrap());
        assert!(!s.session_alive(&hash_token(&thief)).unwrap());
        assert!(s.authenticate(&thief).unwrap().is_none());
        // Everything but this one.
        assert_eq!(
            s.revoke_other_sessions("u", Some(&hash_token(&laptop)))
                .unwrap(),
            1
        );
        assert!(s.authenticate(&laptop).unwrap().is_some());
        assert!(s.authenticate(&phone).unwrap().is_none());
        assert!(
            s.authenticate(&other).unwrap().is_some(),
            "another person is untouched"
        );
    }

    #[test]
    fn enrollment_rotates_device_credentials() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("u", "u@x", None).unwrap();
        let first = s.create_enrollment("u").unwrap();
        let one = s
            .exchange_enrollment(
                first["code"].as_str().unwrap(),
                &json!({"machineId":"m","name":"M","os":"linux","agentVersion":"1"}),
            )
            .unwrap();
        assert!(s
            .device_credential(one["deviceToken"].as_str().unwrap())
            .unwrap()
            .is_some());
        let second = s.create_enrollment("u").unwrap();
        let two = s
            .exchange_enrollment(
                second["code"].as_str().unwrap(),
                &json!({"machineId":"m","name":"M","os":"linux","agentVersion":"2"}),
            )
            .unwrap();
        assert!(s
            .device_credential(one["deviceToken"].as_str().unwrap())
            .unwrap()
            .is_none());
        assert!(s
            .device_credential(two["deviceToken"].as_str().unwrap())
            .unwrap()
            .is_some());
    }

    /// A phone has no cookie to refresh silently and no tab to reopen, so its
    /// session is long AND slides forward while it is being used. A fresh
    /// session must not slide (that would hide expiry bugs behind a moving
    /// target).
    #[test]
    fn a_session_past_its_halfway_point_slides_forward() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("u1", "u1@x", None).unwrap();
        let token = s.create_auth_session("u1", 90).unwrap();
        let hash = hash_token(&token);
        let expiry = |s: &WorkspaceStore| -> i64 {
            s.conn
                .lock()
                .unwrap()
                .query_row(
                    "SELECT expires_at FROM auth_sessions WHERE token_hash=?1",
                    params![hash],
                    |r| r.get(0),
                )
                .unwrap()
        };

        let fresh = expiry(&s);
        assert_eq!(
            s.authenticate(&token).unwrap().map(|(u, _)| u).as_deref(),
            Some("u1")
        );
        assert_eq!(expiry(&s), fresh, "a young session should not be extended");

        // Age it past halfway: created long ago, expiring soon.
        let now = now_ms();
        s.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE auth_sessions SET created_at=?1, expires_at=?2 WHERE token_hash=?3",
                params![now - 89 * 86_400_000_i64, now + 86_400_000_i64, hash],
            )
            .unwrap();
        let (user, reported) = s.authenticate(&token).unwrap().unwrap();
        assert_eq!(user, "u1");
        assert!(
            expiry(&s) > now + 80 * 86_400_000_i64,
            "use should renew the session"
        );
        // The cookie is stamped from what `authenticate` reports, so reporting
        // the PRE-slide expiry would hand the browser a cookie that dies while
        // the session lives — the exact drift this return value exists to close.
        assert_eq!(
            reported,
            expiry(&s),
            "the reported expiry must be the stored one"
        );
    }

    #[test]
    fn invitation_is_one_time_and_email_bound() {
        let s = WorkspaceStore::open_memory();
        s.ensure_user("owner", "owner@x", None).unwrap();
        s.ensure_user("right", "right@x", None).unwrap();
        s.ensure_user("wrong", "wrong@x", None).unwrap();
        let workspace = s.create_organization("owner", "Team", "owner").unwrap();
        let invite = s
            .invite(
                "owner",
                workspace["workspaceId"].as_str().unwrap(),
                "right@x",
                "member",
            )
            .unwrap();
        let token = invite["token"].as_str().unwrap();
        assert!(s.accept_invitation("wrong", token).is_err());
        assert!(s.accept_invitation("right", token).is_ok());
        assert!(s.accept_invitation("right", token).is_err());
    }

    /// The removed tape's tables hold user text retention no longer purges:
    /// the schema init drops them (twice is fine) and keeps the task registry.
    #[test]
    fn init_drops_the_removed_tape_tables_and_keeps_the_task_registry() {
        let s = WorkspaceStore::open_memory();
        let tables = |s: &WorkspaceStore| -> Vec<String> {
            s.with_conn_for_tests(|c| {
                c.prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'tape_%'",
                )
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .filter_map(Result::ok)
                .collect()
            })
        };
        let mut kept = tables(&s);
        kept.sort();
        assert_eq!(kept, ["tape_task_links", "tape_tasks"]);
        s.with_conn_for_tests(|c| {
            for t in [
                "tape_replies",
                "tape_segments",
                "tape_cards",
                "tape_dispatch",
                "tape_dispatch_projects",
                "tape_front",
            ] {
                c.execute(&format!("CREATE TABLE {t} (x TEXT)"), [])
                    .unwrap();
            }
        });
        assert_eq!(tables(&s).len(), 8);
        s.init().unwrap();
        s.init().unwrap();
        let mut left = tables(&s);
        left.sort();
        assert_eq!(left, ["tape_task_links", "tape_tasks"]);
    }

    #[test]
    fn a_watch_session_is_labelled_listed_confined_and_capped_at_three() {
        let ws = WorkspaceStore::open_memory();
        ws.ensure_user("u", "u@example.com", None).unwrap();
        let normal = ws.create_auth_session("u", 90).unwrap();
        let mut tokens = Vec::new();
        for _ in 0..4 {
            tokens.push(ws.create_watch_session("u").unwrap());
        }
        // Never an ordinary session: `/ui` and every other route refuse it.
        assert!(ws.authenticate(&tokens[3]).unwrap().is_none());
        // ...and the ordinary one is not a watch session.
        assert!(ws.authenticate_watch(&normal).unwrap().is_none());
        assert_eq!(
            ws.authenticate_watch(&tokens[3]).unwrap().as_deref(),
            Some("u")
        );
        // Four minted, three live: the oldest went.
        assert!(ws.authenticate_watch(&tokens[0]).unwrap().is_none());
        for t in &tokens[1..] {
            assert!(ws.authenticate_watch(t).unwrap().is_some());
        }
        let listed = ws.list_sessions("u").unwrap();
        let watches: Vec<_> = listed
            .iter()
            .filter(|x| x["label"] == "Apple Watch")
            .collect();
        assert_eq!(watches.len(), 3);
        // Revocable from «Где я вошёл».
        let id = watches[0]["id"].as_str().unwrap().to_string();
        assert!(ws.revoke_session("u", &id).unwrap());
        assert_eq!(
            tokens[1..]
                .iter()
                .filter(|t| ws.authenticate_watch(t).unwrap().is_some())
                .count(),
            2
        );
        assert!(ws.authenticate(&normal).unwrap().is_some());
    }
}
