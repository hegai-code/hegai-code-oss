//! Read access to the private repository for people an admin activates.
//!
//! Hegai Code is distributed as self-host open source, but the repository is
//! private: access is shared through GitHub. When an admin activates a person
//! who signed in with GitHub (`github_login.rs`), the hub — as a GitHub App
//! installed on the repository — invites THEIR GitHub account to it with
//! `pull` (read) permission.
//!
//! Off unless `GITHUB_GRANT_REPO` is set (and then `GITHUB_APP_ID`,
//! `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_APP_INSTALLATION_ID` must be too).
//! Activation only QUEUES a row in `github_grants`; the minute reconciler
//! works the queue (like gateway seats, `access_api::reconcile_seats`) with a
//! backoff and a cap on attempts, and a failure never touches the activation
//! that already committed. An admin can retry a failed grant by hand.
//!
//! Out of scope on purpose: suspending or deleting a person does NOT take the
//! repository access back. An admin removes the collaborator on GitHub.
use super::*;
use jsonwebtoken::{encode, EncodingKey, Header};
use rusqlite::{params, Connection, OptionalExtension};

use crate::workspace::db_err;
use std::collections::HashSet;

/// Attempts before a grant is left `failed` for an admin.
const MAX_ATTEMPTS: i64 = 5;
/// Pause after the n-th failed attempt, in seconds.
const BACKOFF_SECS: [i64; 5] = [60, 300, 1800, 7200, 21600];
/// A claimed row is not offered again for this long (a task may be slow).
const LEASE_MS: i64 = 10 * 60 * 1000;
/// How often an `invited` row is checked for acceptance.
const INVITED_POLL_MS: i64 = 30 * 60 * 1000;
/// GitHub drops an unanswered invitation after a week; polling stops after
/// eight days. An admin's retry sends a new one.
const INVITATION_LIFETIME_MS: i64 = 8 * 24 * 60 * 60 * 1000;
/// Pages of 100 invitations searched for an account.
const MAX_INVITATION_PAGES: usize = 50;
/// Rows worked per sweep.
const BATCH: usize = 10;

pub(crate) struct GrantConfig {
    app_id: String,
    key: EncodingKey,
    installation_id: String,
    owner: String,
    repo: String,
    /// `GITHUB_GRANT_REPO_ID`: when known the installation token is narrowed
    /// with `repository_ids`, else with the repository's name.
    repo_id: Option<u64>,
    api_base: String,
    http: reqwest::Client,
    /// Installation tokens by repository (`owner/name`), each narrowed to it.
    token: tokio::sync::Mutex<HashMap<String, (Instant, String)>>,
}

/// What GitHub did with the invitation request.
#[derive(Debug, PartialEq)]
enum Outcome {
    /// 201: an invitation was sent; the person must accept it on GitHub.
    Invited {
        login: String,
        invitation_id: Option<i64>,
    },
    /// 204: they already have access.
    Granted { login: String },
}

#[derive(Debug)]
struct GrantError {
    message: String,
    /// Retrying cannot help (the account is gone, GitHub refuses the grant).
    permanent: bool,
}

impl GrantError {
    fn transient(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            permanent: false,
        }
    }
    fn permanent(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            permanent: true,
        }
    }
}

/// The App's private key opens the repository: refuse a file anyone but its
/// owner can read, or one the hub's own user does not own (as the provisioner
/// credentials are handled). `chmod 600` it.
#[cfg(unix)]
fn check_key_file(path: &str) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::metadata(path)
        .map_err(|e| format!("GITHUB_APP_PRIVATE_KEY_PATH is unreadable: {e}"))?;
    if !meta.is_file() {
        return Err("GITHUB_APP_PRIVATE_KEY_PATH is not a regular file".into());
    }
    if meta.mode() & 0o077 != 0 {
        return Err(
            "GITHUB_APP_PRIVATE_KEY_PATH is readable by group or others — chmod 600 it".into(),
        );
    }
    // SAFETY: geteuid has no preconditions and cannot fail.
    if meta.uid() != unsafe { libc::geteuid() } {
        return Err("GITHUB_APP_PRIVATE_KEY_PATH must be owned by the hub's user".into());
    }
    Ok(())
}

#[cfg(not(unix))]
fn check_key_file(_path: &str) -> Result<(), String> {
    Ok(())
}

fn valid_repo_part(part: &str) -> bool {
    !part.is_empty()
        && part.len() <= 100
        && part
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

impl GrantConfig {
    pub fn from_env() -> Result<Option<Arc<Self>>, String> {
        let get = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        let Some(repo) = get("GITHUB_GRANT_REPO") else {
            return Ok(None);
        };
        let (Some(app_id), Some(key_path), Some(installation_id)) = (
            get("GITHUB_APP_ID"),
            get("GITHUB_APP_PRIVATE_KEY_PATH"),
            get("GITHUB_APP_INSTALLATION_ID"),
        ) else {
            return Err("incomplete GitHub repository grant configuration".into());
        };
        check_key_file(&key_path)?;
        let pem = std::fs::read(&key_path)
            .map_err(|e| format!("GITHUB_APP_PRIVATE_KEY_PATH is unreadable: {e}"))?;
        let repo_id = match get("GITHUB_GRANT_REPO_ID") {
            Some(v) => Some(
                v.trim()
                    .parse::<u64>()
                    .map_err(|_| "GITHUB_GRANT_REPO_ID must be a number".to_string())?,
            ),
            None => None,
        };
        Self::new(
            &app_id,
            &pem,
            &installation_id,
            repo.trim(),
            repo_id,
            "https://api.github.com".into(),
        )
        .map(|c| Some(Arc::new(c)))
    }

    fn new(
        app_id: &str,
        pem: &[u8],
        installation_id: &str,
        repo: &str,
        repo_id: Option<u64>,
        api_base: String,
    ) -> Result<Self, String> {
        let (owner, name) = repo
            .split_once('/')
            .filter(|(o, n)| valid_repo_part(o) && valid_repo_part(n))
            .ok_or("GITHUB_GRANT_REPO must be owner/name")?;
        if !installation_id.chars().all(|c| c.is_ascii_digit()) || installation_id.is_empty() {
            return Err("GITHUB_APP_INSTALLATION_ID must be a number".into());
        }
        Ok(Self {
            app_id: app_id.trim().to_string(),
            key: EncodingKey::from_rsa_pem(pem)
                .map_err(|_| "GITHUB_APP_PRIVATE_KEY_PATH is not an RSA private key".to_string())?,
            installation_id: installation_id.to_string(),
            owner: owner.to_string(),
            repo: name.to_string(),
            repo_id,
            api_base,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "GitHub HTTP configuration".to_string())?,
            token: tokio::sync::Mutex::new(HashMap::new()),
        })
    }

    /// `owner/name`, as stored and shown.
    pub fn full_name(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }

    /// The App's own JWT: RS256, `iss` = app id, issued a minute in the past
    /// (clock skew), valid nine minutes (GitHub's ceiling is ten).
    fn app_jwt(&self) -> Result<String, GrantError> {
        let now = (workspace::now_ms() / 1000) as u64;
        let claims =
            json!({"iss": self.app_id, "iat": now.saturating_sub(60), "exp": now + 9 * 60});
        encode(&Header::new(Algorithm::RS256), &claims, &self.key)
            .map_err(|_| GrantError::permanent("could not sign the GitHub App token"))
    }

    fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        bearer: &str,
    ) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}{path}", self.api_base))
            .header(header::AUTHORIZATION, format!("Bearer {bearer}"))
            .header(header::ACCEPT, "application/vnd.github+json")
            .header(header::USER_AGENT, "hegai-code-hub")
            .header("X-GitHub-Api-Version", "2022-11-28")
    }

    /// An installation token for the configured repository.
    async fn installation_token(&self) -> Result<String, GrantError> {
        self.token_for(&self.full_name()).await
    }

    /// An installation token that can add and remove collaborators of ONE
    /// repository (`administration: write`), cached for most of its hour. A
    /// row written for an earlier `GITHUB_GRANT_REPO` is revoked against its
    /// own repository, so the token is asked for per repository.
    async fn token_for(&self, repo_full: &str) -> Result<String, GrantError> {
        let (_, name) = split_repo(repo_full)?;
        let mut cache = self.token.lock().await;
        if let Some((at, token)) = cache.get(repo_full) {
            if at.elapsed() < Duration::from_secs(50 * 60) {
                return Ok(token.clone());
            }
        }
        let mut body = json!({"permissions": {"administration": "write"}});
        match self.repo_id {
            Some(id) if repo_full == self.full_name() => body["repository_ids"] = json!([id]),
            _ => body["repositories"] = json!([name]),
        }
        let response = self
            .request(
                reqwest::Method::POST,
                &format!("/app/installations/{}/access_tokens", self.installation_id),
                &self.app_jwt()?,
            )
            .json(&body)
            .send()
            .await
            .map_err(|_| GrantError::transient("GitHub is unavailable"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(GrantError::transient(describe(status, response).await));
        }
        let token = response
            .json::<Value>()
            .await
            .ok()
            .and_then(|v| v.get("token").and_then(Value::as_str).map(str::to_string))
            .filter(|t| !t.is_empty())
            .ok_or_else(|| GrantError::transient("GitHub answered unexpectedly"))?;
        cache.insert(repo_full.to_string(), (Instant::now(), token.clone()));
        Ok(token)
    }

    async fn forget_token(&self) {
        self.token.lock().await.clear();
    }

    /// The login that numeric id carries today (a login can be renamed or
    /// reused; the id cannot). A missing account is permanent.
    async fn login_for(&self, github_id: &str) -> Result<String, GrantError> {
        let token = self.installation_token().await?;
        let response = self
            .request(reqwest::Method::GET, &format!("/user/{github_id}"), &token)
            .send()
            .await
            .map_err(|_| GrantError::transient("GitHub is unavailable"))?;
        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err(GrantError::permanent("the GitHub account no longer exists"));
        }
        if !status.is_success() {
            if status == reqwest::StatusCode::UNAUTHORIZED {
                self.forget_token().await;
            }
            return Err(GrantError::transient(describe(status, response).await));
        }
        response
            .json::<Value>()
            .await
            .ok()
            .and_then(|v| {
                let same_id = v.get("id").map(|i| i.to_string()) == Some(github_id.to_string());
                v.get("login")
                    .and_then(Value::as_str)
                    .filter(|l| same_id && crate::github_login::valid_login(l))
                    .map(str::to_string)
            })
            .ok_or_else(|| GrantError::transient("GitHub answered unexpectedly"))
    }

    /// Resolve the login by numeric id right before granting, then invite it
    /// with `pull`.
    async fn grant(&self, github_id: &str) -> Result<Outcome, GrantError> {
        let login = self.login_for(github_id).await?;
        let token = self.installation_token().await?;
        let response = self
            .request(
                reqwest::Method::PUT,
                &format!("/repos/{}/{}/collaborators/{login}", self.owner, self.repo),
                &token,
            )
            .json(&json!({"permission": "pull"}))
            .send()
            .await
            .map_err(|_| GrantError::transient("GitHub is unavailable"))?;
        match response.status().as_u16() {
            201 => {
                let invitation_id = response
                    .json::<Value>()
                    .await
                    .ok()
                    .and_then(|v| v.get("id").and_then(Value::as_i64));
                Ok(Outcome::Invited {
                    login,
                    invitation_id,
                })
            }
            204 => Ok(Outcome::Granted { login }),
            401 => {
                self.forget_token().await;
                Err(GrantError::transient(
                    describe(response.status(), response).await,
                ))
            }
            // The account cannot be invited (an owner, a blocked user …).
            422 => Err(GrantError::permanent(
                describe(response.status(), response).await,
            )),
            _ => Err(GrantError::transient(
                describe(response.status(), response).await,
            )),
        }
    }

    /// Has the invited person accepted? `204` = a collaborator, `404` = not yet.
    async fn is_collaborator(&self, login: &str) -> Result<bool, GrantError> {
        self.collaborator_in(&self.full_name(), login).await
    }

    async fn collaborator_in(&self, repo_full: &str, login: &str) -> Result<bool, GrantError> {
        if !crate::github_login::valid_login(login) {
            return Err(GrantError::permanent("invalid GitHub login"));
        }
        let (owner, name) = split_repo(repo_full)?;
        let token = self.token_for(repo_full).await?;
        let response = self
            .request(
                reqwest::Method::GET,
                &format!("/repos/{owner}/{name}/collaborators/{login}"),
                &token,
            )
            .send()
            .await
            .map_err(|_| GrantError::transient("GitHub is unavailable"))?;
        match response.status().as_u16() {
            204 => Ok(true),
            404 => Ok(false),
            401 => {
                self.forget_token().await;
                Err(GrantError::transient("GitHub rejected the token"))
            }
            _ => Err(GrantError::transient(
                describe(response.status(), response).await,
            )),
        }
    }

    /// The open invitation GitHub holds for this account id, if any — every
    /// page of the repository's invitations.
    async fn find_invitation(
        &self,
        repo_full: &str,
        github_id: &str,
    ) -> Result<Option<i64>, GrantError> {
        let (owner, name) = split_repo(repo_full)?;
        let token = self.token_for(repo_full).await?;
        for page in 1..=MAX_INVITATION_PAGES {
            let response = self
                .request(
                    reqwest::Method::GET,
                    &format!("/repos/{owner}/{name}/invitations?per_page=100&page={page}"),
                    &token,
                )
                .send()
                .await
                .map_err(|_| GrantError::transient("GitHub is unavailable"))?;
            let status = response.status();
            if !status.is_success() {
                if status == reqwest::StatusCode::UNAUTHORIZED {
                    self.forget_token().await;
                }
                return Err(GrantError::transient(describe(status, response).await));
            }
            let list = response
                .json::<Value>()
                .await
                .map_err(|_| GrantError::transient("GitHub answered unexpectedly"))?;
            let items = list.as_array().cloned().unwrap_or_default();
            let found = items.iter().find_map(|i| {
                let same = i["invitee"]["id"]
                    .as_i64()
                    .map(|n| n.to_string())
                    .as_deref()
                    == Some(github_id);
                same.then(|| i["id"].as_i64()).flatten()
            });
            if found.is_some() {
                return Ok(found);
            }
            if items.len() < 100 {
                return Ok(None);
            }
        }
        Err(GrantError::transient("too many open invitations to search"))
    }

    /// `DELETE path`; `204` and `404` (already gone) both mean done.
    async fn delete(&self, repo_full: &str, path: &str) -> Result<(), GrantError> {
        let token = self.token_for(repo_full).await?;
        let response = self
            .request(reqwest::Method::DELETE, path, &token)
            .send()
            .await
            .map_err(|_| GrantError::transient("GitHub is unavailable"))?;
        match response.status().as_u16() {
            204 | 404 => Ok(()),
            401 => {
                self.forget_token().await;
                Err(GrantError::transient("GitHub rejected the token"))
            }
            _ => Err(GrantError::transient(
                describe(response.status(), response).await,
            )),
        }
    }

    /// Take the repository access back, in the row's OWN repository: cancel
    /// the open invitation (the stored id, else found by the account's id) and
    /// remove the collaborator, the login resolved by numeric id; then look
    /// again — only an access that is verifiably gone counts as revoked. An
    /// account GitHub no longer knows has no access to take. Idempotent.
    async fn revoke(
        &self,
        repo_full: &str,
        github_id: &str,
        invitation_id: Option<i64>,
    ) -> Result<String, GrantError> {
        let (owner, name) = split_repo(repo_full)?;
        let login = match self.login_for(github_id).await {
            Ok(login) => Some(login),
            Err(e) if e.permanent => None,
            Err(e) => return Err(e),
        };
        let invitation = match invitation_id {
            Some(id) => Some(id),
            None => self.find_invitation(repo_full, github_id).await?,
        };
        if let Some(id) = invitation {
            self.delete(
                repo_full,
                &format!("/repos/{owner}/{name}/invitations/{id}"),
            )
            .await?;
        }
        if let Some(login) = &login {
            self.delete(
                repo_full,
                &format!("/repos/{owner}/{name}/collaborators/{login}"),
            )
            .await?;
            if self.collaborator_in(repo_full, login).await? {
                return Err(GrantError::transient("still a collaborator after removal"));
            }
        }
        if self.find_invitation(repo_full, github_id).await?.is_some() {
            return Err(GrantError::transient(
                "an invitation is still open after cancelling",
            ));
        }
        Ok(login.unwrap_or_default())
    }
}

/// `owner/name`, as stored on a row, split (validated like the configuration).
fn split_repo(repo_full: &str) -> Result<(&str, &str), GrantError> {
    repo_full
        .split_once('/')
        .filter(|(o, n)| valid_repo_part(o) && valid_repo_part(n))
        .ok_or_else(|| GrantError::permanent("invalid repository name"))
}

/// `HTTP 422: <GitHub's message>` — cut short, never a credential.
async fn describe(status: reqwest::StatusCode, response: reqwest::Response) -> String {
    let message = response
        .json::<Value>()
        .await
        .ok()
        .and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default();
    let message: String = message.chars().take(200).collect();
    format!("GitHub HTTP {}: {message}", status.as_u16())
}

pub(crate) fn init_schema(conn: &Connection) -> Result<(), String> {
    // No foreign key on purpose: when an account is deleted the row stays, as a
    // tombstone (GitHub id, login, repository, status — no profile), until the
    // revoker has taken the repository access back; only then is it removed.
    //
    // `version` is bumped by EVERY write, and a step that has been working on
    // a row writes back only if the status AND version it claimed are still
    // there (compare-and-set): a suspension, a deletion or an admin's retry
    // that landed meanwhile wins, and the finished step does nothing.
    // `claimed_until` leases a row to one sweep. `requeue_repo` is set by a
    // reactivation that arrives while the access is being revoked: when the
    // revocation is confirmed the row starts a new grant for that repository
    // instead of ending revoked.
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS github_grants (
          user_id       TEXT PRIMARY KEY,
          repo          TEXT NOT NULL,
          github_id     TEXT NOT NULL,
          login         TEXT,
          status        TEXT NOT NULL CHECK(status IN ('pending','invited','granted','failed','revoking','revoked')),
          error         TEXT,
          attempts      INTEGER NOT NULL DEFAULT 0,
          next_at       INTEGER,
          invited_at    INTEGER,
          invitation_id INTEGER,
          version       INTEGER NOT NULL DEFAULT 0,
          requeue_repo  TEXT,
          claimed_until INTEGER,
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS github_grants_due ON github_grants(status,next_at);
        CREATE INDEX IF NOT EXISTS github_grants_github ON github_grants(github_id);
        "#,
    )
    .map_err(db_err)
}

/// Suspension, or a deletion request: whatever access the row stands for is to
/// be taken back, and any pending re-grant is cancelled. `?1` user, `?2` now.
/// Shared with account deletion so both mark a row the same way.
pub(crate) const MARK_REVOKING_SQL: &str =
    "UPDATE github_grants SET status='revoking',requeue_repo=NULL,error=NULL,\
     attempts=CASE WHEN status='revoking' THEN attempts ELSE 0 END,next_at=?2,claimed_until=NULL,\
     version=version+1,updated_at=?2 \
     WHERE user_id=?1 AND status IN ('pending','invited','granted','failed','revoking')";

/// One GitHub operation per account at a time, process-wide: a sweep, an
/// admin's retry and a tombstone's revocation never touch the same GitHub
/// account concurrently (keyed by the GitHub id, which is what GitHub sees —
/// a deleted account's tombstone and a new account with the same GitHub id
/// share it).
fn inflight() -> &'static Mutex<HashSet<String>> {
    static SET: std::sync::OnceLock<Mutex<HashSet<String>>> = std::sync::OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

struct Flight(String);

impl Flight {
    fn enter(store: &WorkspaceStore, github_id: &str) -> Option<Flight> {
        let key = flight_key(store, github_id);
        let mut set = inflight().lock().unwrap_or_else(|e| e.into_inner());
        set.insert(key.clone()).then(|| Flight(key))
    }
}

impl Drop for Flight {
    fn drop(&mut self) {
        inflight()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

/// Keyed by the store as well, so two hubs in one process (tests) do not
/// block each other; a real hub has exactly one store.
fn flight_key(store: &WorkspaceStore, github_id: &str) -> String {
    format!("{:p}/{github_id}", Arc::as_ptr(&store.conn))
}

fn in_flight(store: &WorkspaceStore, github_id: &str) -> bool {
    inflight()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(&flight_key(store, github_id))
}

/// A queue row a sweep has taken, as it was at claim time: its status and
/// version are what every write of this step must still find.
struct Job {
    user_id: String,
    repo: String,
    github_id: String,
    login: Option<String>,
    status: String,
    attempts: i64,
    invited_at: Option<i64>,
    invitation_id: Option<i64>,
    version: i64,
}

/// What a step writes back.
struct Step<'a> {
    status: &'a str,
    login: Option<&'a str>,
    error: Option<&'a str>,
    attempts: i64,
    next_at: Option<i64>,
    invited_at: Option<i64>,
    invitation_id: Option<i64>,
}

impl<'a> Step<'a> {
    fn new(status: &'a str, attempts: i64) -> Self {
        Self {
            status,
            login: None,
            error: None,
            attempts,
            next_at: None,
            invited_at: None,
            invitation_id: None,
        }
    }
}

/// The row as the screens see it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct GrantRow {
    pub repo: String,
    pub status: String,
    pub error: Option<String>,
    pub attempts: i64,
}

impl GrantRow {
    /// `{status, repo}` for the person; the admin also sees the error and the
    /// attempts.
    pub(crate) fn json(&self, admin: bool) -> Value {
        let mut v = json!({"status": self.status, "repo": self.repo});
        if admin {
            v["attempts"] = json!(self.attempts);
            if let Some(e) = &self.error {
                v["error"] = Value::String(e.clone());
            }
        }
        v
    }
}

/// A row that starts a new grant for `repo` (clears everything the last one
/// left). `?1` user, `?2` repo, `?3` now.
const RESET_PENDING_SQL: &str =
    "UPDATE github_grants SET repo=?2,status='pending',login=NULL,error=NULL,attempts=0,\
     next_at=?3,invited_at=NULL,invitation_id=NULL,requeue_repo=NULL,claimed_until=NULL,\
     version=version+1,updated_at=?3 WHERE user_id=?1";

impl WorkspaceStore {
    /// Queue a grant for this account's GitHub identity. False when the
    /// account has none.
    ///
    /// - no row: a new one;
    /// - `failed` / `revoked`: starts over; `granted`: starts over too, which
    ///   re-checks the collaborator by id and re-invites if it is gone;
    /// - `pending` / `invited`: left alone;
    /// - `revoking` (reactivated before the access was taken back): NOT
    ///   flipped — the revocation finishes, then a new grant starts
    ///   (`requeue_repo`);
    /// - a row for another repository: its access is revoked first, then the
    ///   new grant starts.
    pub fn enqueue_github_grant(&self, user_id: &str, repo: &str) -> Result<bool, String> {
        self.queue_github_grant(user_id, repo, false)
    }

    /// An admin's retry: like `enqueue_github_grant`, but a queued or invited
    /// row starts over as well (a new invitation).
    pub fn restart_github_grant(&self, user_id: &str, repo: &str) -> Result<bool, String> {
        self.queue_github_grant(user_id, repo, true)
    }

    fn queue_github_grant(&self, user_id: &str, repo: &str, force: bool) -> Result<bool, String> {
        let now = workspace::now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let github_id: Option<String> = tx
            .query_row(
                "SELECT subject FROM identities WHERE provider='github' AND user_id=?1 LIMIT 1",
                params![user_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        let Some(github_id) = github_id else {
            return Ok(false);
        };
        // A tombstone of a DELETED account for this same GitHub id would, once
        // its revocation ran, strip this account's access: the new account
        // supersedes it. Not while that revocation is in flight — then the
        // row stays and this account's grant waits for it (same GitHub id).
        if !in_flight(self, &github_id) {
            tx.execute(
                "DELETE FROM github_grants WHERE github_id=?1 AND repo=?2 AND user_id!=?3 \
                 AND NOT EXISTS(SELECT 1 FROM users u WHERE u.user_id=github_grants.user_id)",
                params![github_id, repo, user_id],
            )
            .map_err(db_err)?;
        }
        let existing: Option<(String, String, String)> = tx
            .query_row(
                "SELECT status,repo,github_id FROM github_grants WHERE user_id=?1",
                params![user_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(db_err)?;
        match existing {
            None => {
                tx.execute(
                    "INSERT INTO github_grants(user_id,repo,github_id,status,attempts,next_at,created_at,updated_at) \
                     VALUES(?1,?2,?3,'pending',0,?4,?4,?4)",
                    params![user_id, repo, github_id, now],
                )
                .map_err(db_err)?;
            }
            Some((status, _, _)) if status == "revoking" => {
                tx.execute(
                    "UPDATE github_grants SET requeue_repo=?2,claimed_until=NULL,next_at=?3,\
                     version=version+1,updated_at=?3 WHERE user_id=?1",
                    params![user_id, repo, now],
                )
                .map_err(db_err)?;
            }
            Some((status, old_repo, old_id)) => {
                if status == "failed" || status == "revoked" {
                    tx.execute(RESET_PENDING_SQL, params![user_id, repo, now])
                        .map_err(db_err)?;
                    tx.execute(
                        "UPDATE github_grants SET github_id=?2 WHERE user_id=?1",
                        params![user_id, github_id],
                    )
                    .map_err(db_err)?;
                } else if old_repo != repo || old_id != github_id {
                    // Access to the OLD repository is taken back first.
                    tx.execute(MARK_REVOKING_SQL, params![user_id, now])
                        .map_err(db_err)?;
                    tx.execute(
                        "UPDATE github_grants SET requeue_repo=?2 WHERE user_id=?1",
                        params![user_id, repo],
                    )
                    .map_err(db_err)?;
                } else if status == "granted" || force {
                    tx.execute(RESET_PENDING_SQL, params![user_id, repo, now])
                        .map_err(db_err)?;
                }
            }
        }
        tx.commit().map_err(db_err)?;
        Ok(true)
    }

    /// Suspension: the access the row stands for is to be taken back. False
    /// when there is nothing to revoke.
    pub(crate) fn mark_github_revoking(&self, user_id: &str) -> Result<bool, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        // Only while the person is STILL not active: a reactivation that won
        // the race against this late hook must not be revoked.
        let n = conn
            .execute(
                &format!(
                    "{MARK_REVOKING_SQL} AND NOT EXISTS(SELECT 1 FROM user_access a WHERE a.user_id=?1 AND a.state='active')"
                ),
                params![user_id, workspace::now_ms()],
            )
            .map_err(db_err)?;
        Ok(n > 0)
    }

    /// Is the row still the one this step claimed?
    fn github_grant_unchanged(&self, job: &Job) -> Result<bool, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM github_grants WHERE user_id=?1 AND status=?2 AND version=?3)",
            params![job.user_id, job.status, job.version],
            |r| r.get(0),
        )
        .map_err(db_err)
    }

    /// `GITHUB_GRANT_REPO` changed: rows for another repository that hold or
    /// may hold access are revoked there (and, for an active person, requeued
    /// for the current one) instead of being left forever.
    fn retarget_github_grants(&self, repo: &str) -> Result<usize, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.execute(
            "UPDATE github_grants SET status='revoking',error=NULL,attempts=0,next_at=?2,claimed_until=NULL,\
             requeue_repo=CASE WHEN EXISTS(SELECT 1 FROM user_access a WHERE a.user_id=github_grants.user_id AND a.state='active') THEN ?1 ELSE NULL END,\
             version=version+1,updated_at=?2 \
             WHERE repo!=?1 AND status IN ('pending','invited','granted','failed')",
            params![repo, workspace::now_ms()],
        )
        .map_err(db_err)
    }

    /// A step found its person inactive on a row that is not `revoking`: the
    /// row becomes `revoking` — only if it is still as claimed. The new
    /// version, or `None` when somebody else changed the row first. The lease
    /// stays: this step goes on to revoke.
    fn mark_github_revoking_cas(&self, job: &Job) -> Result<Option<i64>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let n = conn
            .execute(
                "UPDATE github_grants SET status='revoking',requeue_repo=NULL,error=NULL,attempts=0,next_at=?4,\
                 version=version+1,updated_at=?4 WHERE user_id=?1 AND status=?2 AND version=?3",
                params![job.user_id, job.status, job.version, workspace::now_ms()],
            )
            .map_err(db_err)?;
        Ok((n > 0).then_some(job.version + 1))
    }

    /// Revocations still owed for accounts that no longer exist (deleted):
    /// the tombstones an admin can watch. No profile data beyond the login.
    pub(crate) fn pending_github_revocations(&self) -> Result<Vec<Value>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT login,github_id,repo,error,attempts FROM github_grants g \
                 WHERE status='revoking' AND NOT EXISTS(SELECT 1 FROM users u WHERE u.user_id=g.user_id) \
                 ORDER BY updated_at",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| {
                let mut v = json!({
                    "githubId": r.get::<_, String>(1)?,
                    "repo": r.get::<_, String>(2)?,
                    "attempts": r.get::<_, i64>(4)?,
                });
                if let Some(login) = r.get::<_, Option<String>>(0)? {
                    v["login"] = Value::String(login);
                }
                if let Some(error) = r.get::<_, Option<String>>(3)? {
                    v["error"] = Value::String(error);
                }
                Ok(v)
            })
            .map_err(db_err)?
            .filter_map(Result::ok)
            .collect();
        Ok(rows)
    }

    /// Take the rows that are due, leasing them (`claimed_until`) so a second
    /// sweep does not take them too. Grants and invitation polls are only for
    /// the CURRENT repository; a revocation is worked against the row's own.
    fn claim_github_grants(&self, repo: &str, limit: usize) -> Result<Vec<Job>, String> {
        let now = workspace::now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                "UPDATE github_grants SET claimed_until=?2 WHERE user_id IN (\
                   SELECT user_id FROM github_grants \
                   WHERE ((repo=?1 AND status IN ('pending','invited')) OR status='revoking') \
                   AND next_at IS NOT NULL AND next_at<=?3 AND (claimed_until IS NULL OR claimed_until<=?3) \
                   ORDER BY next_at LIMIT ?4) \
                 RETURNING user_id,repo,github_id,login,status,attempts,invited_at,invitation_id,version",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![repo, now + LEASE_MS, now, limit as i64], |r| {
                Ok(Job {
                    user_id: r.get(0)?,
                    repo: r.get(1)?,
                    github_id: r.get(2)?,
                    login: r.get(3)?,
                    status: r.get(4)?,
                    attempts: r.get(5)?,
                    invited_at: r.get(6)?,
                    invitation_id: r.get(7)?,
                    version: r.get(8)?,
                })
            })
            .map_err(db_err)?
            .filter_map(Result::ok)
            .collect();
        Ok(rows)
    }

    /// The step could not run (the account is busy): let the next sweep have it.
    fn release_github_claim(&self, user_id: &str) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.execute(
            "UPDATE github_grants SET claimed_until=NULL WHERE user_id=?1",
            params![user_id],
        )
        .map_err(db_err)?;
        Ok(())
    }

    /// Write a step's outcome — compare-and-set on the status and version the
    /// step claimed. False: the row changed meanwhile (a suspension, a
    /// deletion, a retry); the finished step does nothing more.
    fn cas_github_grant(&self, job: &Job, to: &Step) -> Result<bool, String> {
        let error = to.error.map(|e| e.chars().take(500).collect::<String>());
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let n = conn
            .execute(
                "UPDATE github_grants SET status=?4,login=COALESCE(?5,login),error=?6,attempts=?7,next_at=?8,\
                 invited_at=COALESCE(?9,invited_at),invitation_id=COALESCE(?10,invitation_id),\
                 claimed_until=NULL,version=version+1,updated_at=?11 \
                 WHERE user_id=?1 AND status=?2 AND version=?3",
                params![
                    job.user_id,
                    job.status,
                    job.version,
                    to.status,
                    to.login,
                    error,
                    to.attempts,
                    to.next_at,
                    to.invited_at,
                    to.invitation_id,
                    workspace::now_ms()
                ],
            )
            .map_err(db_err)?;
        Ok(n > 0)
    }

    /// Unconditional write, for tests that stage a row.
    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    fn update_github_grant(
        &self,
        user_id: &str,
        status: &str,
        login: Option<&str>,
        error: Option<&str>,
        attempts: i64,
        next_at: Option<i64>,
        invited_at: Option<i64>,
    ) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.execute(
            "UPDATE github_grants SET status=?2,login=COALESCE(?3,login),error=?4,attempts=?5,next_at=?6,\
             invited_at=COALESCE(?7,invited_at),claimed_until=NULL,version=version+1,updated_at=?8 WHERE user_id=?1",
            params![user_id, status, login, error, attempts, next_at, invited_at, workspace::now_ms()],
        )
        .map_err(db_err)?;
        Ok(())
    }

    /// The revocation was confirmed — only if the row is still the `revoking`
    /// one this step claimed (else false, nothing written). Then:
    /// - the account is gone: the tombstone is dropped;
    /// - it is active again and a reactivation asked for a new grant
    ///   (`requeue_repo`): the row becomes `pending` for that repository;
    /// - otherwise `revoked`.
    fn finish_github_revocation(&self, job: &Job, login: Option<&str>) -> Result<bool, String> {
        let now = workspace::now_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let row: Option<(String, i64, Option<String>)> = tx
            .query_row(
                "SELECT status,version,requeue_repo FROM github_grants WHERE user_id=?1",
                params![job.user_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(db_err)?;
        let Some((status, version, requeue)) = row else {
            return Ok(false);
        };
        if status != "revoking" || version != job.version {
            return Ok(false);
        }
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM users WHERE user_id=?1)",
                params![job.user_id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        let active: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM user_access WHERE user_id=?1 AND state='active')",
                params![job.user_id],
                |r| r.get(0),
            )
            .map_err(db_err)?;
        if !exists {
            tx.execute(
                "DELETE FROM github_grants WHERE user_id=?1",
                params![job.user_id],
            )
            .map_err(db_err)?;
        } else if let Some(repo) = requeue.filter(|_| active) {
            tx.execute(RESET_PENDING_SQL, params![job.user_id, repo, now])
                .map_err(db_err)?;
            // The new grant targets the account's CURRENT GitHub identity.
            tx.execute(
                "UPDATE github_grants SET github_id=COALESCE((SELECT subject FROM identities \
                 WHERE provider='github' AND user_id=?1 LIMIT 1),github_id) WHERE user_id=?1",
                params![job.user_id],
            )
            .map_err(db_err)?;
        } else {
            tx.execute(
                "UPDATE github_grants SET status='revoked',login=COALESCE(?2,login),error=NULL,next_at=NULL,\
                 invitation_id=NULL,requeue_repo=NULL,claimed_until=NULL,version=version+1,updated_at=?3 \
                 WHERE user_id=?1",
                params![job.user_id, login, now],
            )
            .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        Ok(true)
    }

    /// Who the GitHub identity belongs to now (a deleted account's id may have
    /// been taken by a new account).
    fn github_identity_owner(&self, github_id: &str) -> Result<Option<String>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        conn.query_row(
            "SELECT user_id FROM identities WHERE provider='github' AND subject=?1",
            params![github_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_err)
    }

    pub(crate) fn github_grant(&self, user_id: &str) -> Result<Option<GrantRow>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "workspace database lock poisoned".to_string())?;
        read_grant(&conn, user_id)
    }
}

pub(crate) fn read_grant(conn: &Connection, user_id: &str) -> Result<Option<GrantRow>, String> {
    conn.query_row(
        "SELECT repo,status,error,attempts FROM github_grants WHERE user_id=?1",
        params![user_id],
        |r| {
            Ok(GrantRow {
                repo: r.get(0)?,
                status: r.get(1)?,
                error: r.get(2)?,
                attempts: r.get(3)?,
            })
        },
    )
    .optional()
    .map_err(db_err)
}

/// After an activation: queue the grant (when the feature is on and the
/// person came through GitHub) and start working it. Never fails the caller.
pub(crate) fn queue_for_activated(st: &AppState, user_id: &str) {
    let Some(cfg) = st.github_grant.as_ref() else {
        return;
    };
    match st
        .workspaces
        .enqueue_github_grant(user_id, &cfg.full_name())
    {
        Ok(true) => {
            println!("[github] queued the repository grant for {user_id}");
            reconcile_grants(st);
        }
        Ok(false) => {}
        Err(e) => eprintln!("[github] could not queue the grant for {user_id}: {e}"),
    }
}

/// After a suspension: take the repository access back. Marks the row and
/// starts the sweep; the revoker retries until GitHub confirms.
pub(crate) fn revoke_for_suspended(st: &AppState, user_id: &str) {
    match st.workspaces.mark_github_revoking(user_id) {
        Ok(true) => {
            println!("[github] queued the repository revocation for {user_id}");
            reconcile_grants(st);
        }
        Ok(false) => {}
        Err(e) => eprintln!("[github] could not queue the revocation for {user_id}: {e}"),
    }
}

/// The minute sweep: work the due rows in one background task.
pub(crate) fn reconcile_grants(st: &AppState) {
    let Some(cfg) = st.github_grant.clone() else {
        return;
    };
    if let Err(e) = st.workspaces.retarget_github_grants(&cfg.full_name()) {
        eprintln!("[github] grant reconciler: {e}");
    }
    let jobs = match st.workspaces.claim_github_grants(&cfg.full_name(), BATCH) {
        Ok(jobs) => jobs,
        Err(e) => {
            eprintln!("[github] grant reconciler: {e}");
            return;
        }
    };
    if jobs.is_empty() {
        return;
    }
    let st = st.clone();
    tokio::spawn(async move {
        for job in jobs {
            process(&st, &cfg, job).await;
        }
    });
}

fn audit(st: &AppState, user_id: &str, action: &str, metadata: Value) {
    let _ = st.workspaces.audit_user_event(
        user_id,
        crate::provisioning::SYSTEM_ACTOR,
        action,
        &metadata,
    );
}

fn backoff_ms(attempt: i64) -> i64 {
    let idx = (attempt.max(1) as usize - 1).min(BACKOFF_SECS.len() - 1);
    BACKOFF_SECS[idx] * 1000
}

/// Work one claimed row. One GitHub operation per account at a time; every
/// write is a compare-and-set on what was claimed; and whoever is not active
/// (suspended, deleted) never ends `granted` or `invited`: a row of theirs
/// that is not already `revoking` becomes so first.
async fn process(st: &AppState, cfg: &GrantConfig, mut job: Job) {
    let Some(_flight) = Flight::enter(&st.workspaces, &job.github_id) else {
        // Busy with this account (maybe under another row): try next sweep.
        let _ = st.workspaces.release_github_claim(&job.user_id);
        return;
    };
    // The row may have moved on between the claim and this step (a retry, a
    // suspension, another step): a stale snapshot does nothing.
    if !st.workspaces.github_grant_unchanged(&job).unwrap_or(false) {
        return;
    }
    // A database error is not «inactive»: skip, retry on the next sweep.
    let Ok(active) = is_active_checked(st, &job.user_id) else {
        let _ = st.workspaces.release_github_claim(&job.user_id);
        return;
    };
    if job.status != "revoking" && !active {
        match st.workspaces.mark_github_revoking_cas(&job) {
            Ok(Some(version)) => {
                job.status = "revoking".into();
                job.version = version;
                job.attempts = 0;
            }
            // Changed under us: the writer's state stands; the sweep re-reads it.
            _ => return,
        }
    }
    match job.status.as_str() {
        "revoking" => process_revoke(st, cfg, &job).await,
        "invited" => process_invited(st, cfg, &job).await,
        _ => process_pending(st, cfg, &job).await,
    }
    st.hub.send(HubCmd::RefreshWorkspaceState);
}

/// Is this person active — with a database failure kept apart from «no».
fn is_active_checked(st: &AppState, user: &str) -> Result<bool, String> {
    st.workspaces
        .access_state(user)
        .map(|a| a.state == "active")
}

async fn process_revoke(st: &AppState, cfg: &GrantConfig, job: &Job) {
    let user = job.user_id.as_str();
    let attempt = job.attempts + 1;
    // A deleted account's tombstone must not strip a NEW account that now owns
    // the same GitHub identity and is active.
    // Only for the repository the new account is being granted: an old
    // repository's access is revoked whoever owns the id now.
    if job.repo == cfg.full_name() {
        if let Ok(Some(owner)) = st.workspaces.github_identity_owner(&job.github_id) {
            if owner != user {
                match is_active_checked(st, &owner) {
                    Ok(true) => {
                        let _ = st.workspaces.finish_github_revocation(job, None);
                        return;
                    }
                    Ok(false) => {}
                    // Unknown: change nothing, look again next sweep.
                    Err(_) => {
                        let _ = st.workspaces.release_github_claim(user);
                        return;
                    }
                }
            }
        }
    }
    match cfg
        .revoke(&job.repo, &job.github_id, job.invitation_id)
        .await
    {
        Ok(login) => {
            let login = (!login.is_empty()).then_some(login).or(job.login.clone());
            if st
                .workspaces
                .finish_github_revocation(job, login.as_deref())
                .unwrap_or(false)
            {
                audit(
                    st,
                    user,
                    "github.revoke",
                    json!({"status": "revoked", "repo": job.repo, "login": login, "githubId": job.github_id}),
                );
                println!("[github] revoked {} access of {user}", job.repo);
            }
        }
        Err(e) => {
            // Never given up on: an access that stays is worse than a retry.
            eprintln!(
                "[github] revoking {user} attempt {attempt} failed: {}",
                e.message
            );
            let mut step = Step::new("revoking", attempt);
            step.error = Some(&e.message);
            step.next_at = Some(workspace::now_ms() + backoff_ms(attempt));
            let _ = st.workspaces.cas_github_grant(job, &step);
        }
    }
}

async fn process_invited(st: &AppState, cfg: &GrantConfig, job: &Job) {
    let now = workspace::now_ms();
    let user = job.user_id.as_str();
    // The login by numeric id each time: it may have been renamed meanwhile.
    let polled = async {
        let login = cfg.login_for(&job.github_id).await?;
        let accepted = cfg.is_collaborator(&login).await?;
        Ok::<_, GrantError>((login, accepted))
    }
    .await;
    match polled {
        Ok((login, true)) => {
            let mut step = Step::new("granted", job.attempts);
            step.login = Some(&login);
            if st.workspaces.cas_github_grant(job, &step).unwrap_or(false) {
                audit(
                    st,
                    user,
                    "github.grant",
                    json!({"status": "granted", "repo": job.repo, "login": login, "githubId": job.github_id}),
                );
                println!("[github] {login} accepted the invitation to {}", job.repo);
            }
        }
        other => {
            let (login, error) = match other {
                Ok((login, _)) => (Some(login), None),
                Err(e) => (None, Some(e.message)),
            };
            if job
                .invited_at
                .is_some_and(|at| now - at > INVITATION_LIFETIME_MS)
            {
                // GitHub dropped it: failed, so a retry or a reactivation requeues.
                let mut step = Step::new("failed", job.attempts);
                step.login = login.as_deref();
                step.error = Some("invitation expired");
                if st.workspaces.cas_github_grant(job, &step).unwrap_or(false) {
                    audit(
                        st,
                        user,
                        "github.grant",
                        json!({"status": "failed", "repo": job.repo, "error": "invitation expired"}),
                    );
                }
            } else {
                let mut step = Step::new("invited", job.attempts);
                step.login = login.as_deref();
                step.error = error.as_deref();
                step.next_at = Some(now + INVITED_POLL_MS);
                let _ = st.workspaces.cas_github_grant(job, &step);
            }
        }
    }
}

async fn process_pending(st: &AppState, cfg: &GrantConfig, job: &Job) {
    let now = workspace::now_ms();
    let user = job.user_id.as_str();
    let attempt = job.attempts + 1;
    match cfg.grant(&job.github_id).await {
        Ok(outcome) => {
            let (status, login, next, invited_at, invitation_id) = match outcome {
                Outcome::Invited {
                    login,
                    invitation_id,
                } => (
                    "invited",
                    login,
                    Some(now + INVITED_POLL_MS),
                    Some(now),
                    invitation_id,
                ),
                Outcome::Granted { login } => ("granted", login, None, None, None),
            };
            // Suspended while GitHub was working: never record `granted` for
            // an inactive person — the access just given is taken back.
            let Ok(active) = is_active_checked(st, user) else {
                // Cannot tell: write nothing; the grant is idempotent and the
                // next sweep repeats it.
                let _ = st.workspaces.release_github_claim(user);
                return;
            };
            let inactive = !active;
            let mut step = if inactive {
                let mut s = Step::new("revoking", 0);
                s.next_at = Some(now);
                s
            } else {
                let mut s = Step::new(status, attempt);
                s.next_at = next;
                s
            };
            step.login = Some(&login);
            step.invited_at = invited_at;
            step.invitation_id = invitation_id;
            if !st.workspaces.cas_github_grant(job, &step).unwrap_or(false) {
                // The row changed while GitHub worked (suspension, deletion,
                // retry). Whoever changed it owns the next step; an access
                // given meanwhile is found and removed by the revoker.
                return;
            }
            if !inactive {
                audit(
                    st,
                    user,
                    "github.grant",
                    json!({"status": status, "repo": job.repo, "login": login, "githubId": job.github_id, "attempts": attempt}),
                );
                println!("[github] {status}: {login} -> {}", job.repo);
            }
        }
        Err(e) if e.permanent || attempt >= MAX_ATTEMPTS => {
            eprintln!("[github] grant for {user} failed: {}", e.message);
            let mut step = Step::new("failed", attempt);
            step.error = Some(&e.message);
            if st.workspaces.cas_github_grant(job, &step).unwrap_or(false) {
                audit(
                    st,
                    user,
                    "github.grant",
                    json!({"status": "failed", "repo": job.repo, "error": e.message, "attempts": attempt}),
                );
            }
        }
        Err(e) => {
            eprintln!(
                "[github] grant attempt {attempt}/{MAX_ATTEMPTS} for {user} failed: {}",
                e.message
            );
            let mut step = Step::new("pending", attempt);
            step.error = Some(&e.message);
            step.next_at = Some(now + backoff_ms(attempt));
            let _ = st.workspaces.cas_github_grant(job, &step);
        }
    }
}

/// `POST /api/admin/access/{userId}/retry-github-grant` — start the repository
/// grant over (attempts reset). Active members with a GitHub identity only.
pub(crate) async fn api_admin_retry_github_grant(
    AxumPath(user_id): AxumPath<String>,
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    gate!(admin_mutation_user(&headers, &st));
    let Some(cfg) = st.github_grant.as_ref() else {
        return api_error(
            StatusCode::CONFLICT,
            "repository grants are not configured on this hub",
        );
    };
    match st.workspaces.access_state(&user_id) {
        Ok(access) if access.state == "active" => {}
        Ok(_) => {
            return api_error(
                StatusCode::CONFLICT,
                "only an active member can be granted the repository",
            )
        }
        Err(e) => return store_failure(e),
    }
    let queued = st
        .workspaces
        .restart_github_grant(&user_id, &cfg.full_name());
    match queued {
        Ok(true) => {}
        Ok(false) => return api_error(StatusCode::CONFLICT, "the account has no GitHub identity"),
        Err(e) => return store_failure(e),
    }
    reconcile_grants(&st);
    st.hub.send(HubCmd::RefreshWorkspaceState);
    match st.workspaces.github_grant(&user_id) {
        Ok(Some(row)) => Json(json!({"ok": true, "githubGrant": row.json(true)})).into_response(),
        Ok(None) => Json(json!({"ok": true})).into_response(),
        Err(e) => store_failure(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::State as AxState;
    use axum::routing::{get, post, put};
    use jsonwebtoken::{decode, DecodingKey, Validation};

    // A throwaway 2048-bit RSA key, body only: the PEM header is added at run
    // time so no private-key block sits in the repository.
    const KEY_BODY: &str = "MIIEogIBAAKCAQEAqvJB3F+kJOQoPB8Yz7Jd4oGp188iDg0+zv3vxsEnX/vGLOVOfaIpzpOz5FASzTR4bu56yN581PlNQd9OetExaTQNeTF0aByFmS9XcFIzUR5OW0OUhDsYKKBmLtZOLsji59ES+uEvAVGfXUdPIuuC1ktepQIf8903cd1XAgh9U6q0njQj3PqvMEIIsXpaRP74IBr6RXanN7e6xNNwnoAwXgPVeiPTd4/FCTqpjswQXo2OslqJkv2epJiXK1q/+p9x07oQ3bPLRHITjzDyfo2pD07sP60VYwMJnqYp3GGZXtlTKBS94gpABTETmfwjC+0O1HGcvS2o41QzVj7y6u5fJwIDAQABAoIBAAvEjIsenF6bxDdLTrpxhWwD0AzWqfn8qG+4ZGqyvkKpwt0xVeNpJ+acHVygtIKi042TZilww3gnx007EZx7zSJ4XlsS7/gAyqOeci79waGaa/t1XgJyTPny/MXJo+0tkA00Q9G4cbNuCoHx2D1HqCSXYKcMS+XOOzRf787ohbQeJddbTPY0aeFmk6zgoB3d3xVuS+IYXxoV55xNWSUf9ffCcHVBTgXgDesK8VtS6t+qTE1z3CfKESjq6sHuBy5SxmxuzqqCd5Pdv0fXlw8KeETtdQKj8Bb5owqM0vdkm7qLrURwDzGo5R7AsvULUCJ4MTZq38yG7FNvztAWpaAXeRkCgYEA4nshdTKmgh/jJkXRFUtDsPYRST1PUIFz+8oiQ9i4YThWvg2B/nxjXFca0iX1dGv48SAdfXOP//n3zeDD06Mu8AQ7Zl9aEsmxaQgSxCzr5YL4mxJ97N89a3wzKs+p7wk00LU6QoIgwjRyjXULzUaA3fXD15+ncbPFNWbMUWXGfhkCgYEAwTohncFft/SDBqdzwqKhYJF9Hn83W5Dl/nbD0XkkUyY4cS6f4wsdNp0jFOBajkvFrCPkCdgzty5E/j356BgdpaHqllTc9tm5MitBw9Tg/MB40iZZeePwoO7KouKjOw0Sky58pgFX5i/4gRvQ6sr+S8ngkmRT+ipqaAYehj287z8CgYBaMhddCVLut6xK7bsa8+J9c0HnHRedRDDgsdt7ka+8aCeDgPWoV/lqKPZxgtSCDQ4TWWrlL0TF+NMLltvmSTLEO6s8VfUVTmXtIl326rz3pnVDrNWhpDZdvBTUk+dlXxE9nS8alaBeN2z3kQmmMtHXk6zvDpIs4h9D6TCtqg6m4QKBgBaAfomwi0UQ5HFR7tkrtz9XsgprJjczmJUZn5Q1V1WXjdsgYt493RkPE5bKycDocgyp4VSEKQGcEczJyuCMbmdrg7YeC91zXW3KO85ibBEDGQ7gCGt5b/xN0qtFWVz3GMKrFzj9zw6vZ3EhnCK7oQGScOSbamwnpFyY2dUoO2hhAoGAWoYIRobgXOZP4EfUrZd1JgsJByQtf7uxpQD5BdJeDL0Jwf6GaEedTVsENodqgMQeUjj50DgrSpSW51v/sVjM+UrwNxXVNFQoq23GPSGXUMzqbqYIwxpaDl991+sfTbKLxTS2rma/iz97r5uZ99Z2sHAJjpf89ovfw+4I7ntLh9M=";
    const KEY_N: &str = "qvJB3F-kJOQoPB8Yz7Jd4oGp188iDg0-zv3vxsEnX_vGLOVOfaIpzpOz5FASzTR4bu56yN581PlNQd9OetExaTQNeTF0aByFmS9XcFIzUR5OW0OUhDsYKKBmLtZOLsji59ES-uEvAVGfXUdPIuuC1ktepQIf8903cd1XAgh9U6q0njQj3PqvMEIIsXpaRP74IBr6RXanN7e6xNNwnoAwXgPVeiPTd4_FCTqpjswQXo2OslqJkv2epJiXK1q_-p9x07oQ3bPLRHITjzDyfo2pD07sP60VYwMJnqYp3GGZXtlTKBS94gpABTETmfwjC-0O1HGcvS2o41QzVj7y6u5fJw";

    fn pem() -> Vec<u8> {
        let lines: Vec<&str> = KEY_BODY
            .as_bytes()
            .chunks(64)
            .map(|c| std::str::from_utf8(c).unwrap())
            .collect();
        format!(
            "-----BEGIN RSA PRIVATE KEY-----\n{}\n-----END RSA PRIVATE KEY-----\n", // gitleaks:allow (template; the key is throwaway)
            lines.join("\n")
        )
        .into_bytes()
    }

    #[derive(Default)]
    struct Fake {
        calls: Mutex<Vec<String>>,
        /// Status the collaborator PUT answers with.
        put_status: Mutex<u16>,
        /// Whether GET collaborators/{login} says «is a collaborator».
        collaborator: Mutex<bool>,
        user_missing: Mutex<bool>,
        /// What `GET /user/{id}` calls the account (default `octo`).
        login: Mutex<String>,
        /// Whether the repository lists an open invitation for id 42.
        has_invitation: Mutex<bool>,
        /// DELETE collaborator answers 204 but changes nothing.
        stubborn: Mutex<bool>,
        /// The invitation list has 100 entries on page one, id 42 on page two.
        many_invitations: Mutex<bool>,
    }

    type Shared = Arc<Fake>;

    async fn fake_github(fake: Shared) -> String {
        let app = axum::Router::new()
            .route(
                "/app/installations/{id}/access_tokens",
                post(
                    |AxState(f): AxState<Shared>, headers: HeaderMap, Json(body): Json<Value>| async move {
                        let jwt = headers
                            .get(header::AUTHORIZATION)
                            .and_then(|v| v.to_str().ok())
                            .and_then(|v| v.strip_prefix("Bearer "))
                            .unwrap_or("")
                            .to_string();
                        let mut validation = Validation::new(Algorithm::RS256);
                        validation.validate_aud = false;
                        let key = DecodingKey::from_rsa_components(KEY_N, "AQAB").unwrap();
                        let claims = decode::<Value>(&jwt, &key, &validation)
                            .expect("a valid RS256 App JWT")
                            .claims;
                        let (iat, exp) = (claims["iat"].as_u64().unwrap(), claims["exp"].as_u64().unwrap());
                        assert_eq!(claims["iss"], "123");
                        assert!(exp - iat <= 10 * 60, "GitHub's ten minute ceiling");
                        f.calls.lock().unwrap().push(format!("token {}", body));
                        (StatusCode::CREATED, Json(json!({"token": "inst-tok", "expires_at": "x"})))
                    },
                ),
            )
            .route(
                "/user/{id}",
                get(|AxState(f): AxState<Shared>, AxumPath(id): AxumPath<String>, headers: HeaderMap| async move {
                    assert_eq!(
                        headers.get(header::AUTHORIZATION).unwrap(),
                        "Bearer inst-tok"
                    );
                    f.calls.lock().unwrap().push(format!("user {id}"));
                    if *f.user_missing.lock().unwrap() {
                        return StatusCode::NOT_FOUND.into_response();
                    }
                    let login = f.login.lock().unwrap().clone();
                    let login = if login.is_empty() { "octo".to_string() } else { login };
                    Json(json!({"id": id.parse::<i64>().unwrap(), "login": login})).into_response()
                }),
            )
            .route(
                "/repos/{owner}/{repo}/collaborators/{login}",
                put(|AxState(f): AxState<Shared>, AxumPath((o, r, l)): AxumPath<(String, String, String)>, Json(body): Json<Value>| async move {
                    f.calls.lock().unwrap().push(format!("put {o}/{r}/{l} {body}"));
                    let status = *f.put_status.lock().unwrap();
                    (StatusCode::from_u16(status).unwrap(), Json(json!({"id": 9001, "message": "Validation Failed"})))
                })
                .get(|AxState(f): AxState<Shared>, AxumPath((_, _, l)): AxumPath<(String, String, String)>| async move {
                    f.calls.lock().unwrap().push(format!("get-collab {l}"));
                    if *f.collaborator.lock().unwrap() {
                        StatusCode::NO_CONTENT
                    } else {
                        StatusCode::NOT_FOUND
                    }
                })
                .delete(|AxState(f): AxState<Shared>, AxumPath((_, _, l)): AxumPath<(String, String, String)>| async move {
                    f.calls.lock().unwrap().push(format!("delete-collab {l}"));
                    if !*f.stubborn.lock().unwrap() {
                        *f.collaborator.lock().unwrap() = false;
                    }
                    StatusCode::NO_CONTENT
                }),
            )
            .route(
                "/repos/{owner}/{repo}/invitations",
                get(|AxState(f): AxState<Shared>, Query(q): Query<HashMap<String, String>>| async move {
                    f.calls.lock().unwrap().push("list-invitations".into());
                    if *f.many_invitations.lock().unwrap() {
                        return if q.get("page").map(String::as_str) == Some("2") {
                            Json(json!([{"id": 9001, "invitee": {"id": 42}}]))
                        } else {
                            Json(Value::Array((0..100).map(|i| json!({"id": 100 + i, "invitee": {"id": 7}})).collect()))
                        };
                    }
                    if *f.has_invitation.lock().unwrap() {
                        Json(json!([{"id": 9001, "invitee": {"id": 42}}, {"id": 5, "invitee": {"id": 7}}]))
                    } else {
                        Json(json!([{"id": 5, "invitee": {"id": 7}}]))
                    }
                }),
            )
            .route(
                "/repos/{owner}/{repo}/invitations/{id}",
                axum::routing::delete(|AxState(f): AxState<Shared>, AxumPath((_, _, id)): AxumPath<(String, String, String)>| async move {
                    f.calls.lock().unwrap().push(format!("delete-invitation {id}"));
                    *f.has_invitation.lock().unwrap() = false;
                    StatusCode::NO_CONTENT
                }),
            )
            .with_state(fake);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        base
    }

    fn config(base: &str, repo_id: Option<u64>) -> GrantConfig {
        GrantConfig::new(
            "123",
            &pem(),
            "77",
            "hegai-code/hegai-code",
            repo_id,
            base.into(),
        )
        .unwrap()
    }

    #[test]
    fn the_configuration_is_all_or_nothing_and_checks_its_shape() {
        let new = |repo: &str, inst: &str| {
            GrantConfig::new("1", &pem(), inst, repo, None, "http://x".into())
        };
        assert!(new("hegai-code/hegai-code", "77").is_ok());
        assert!(new("hegai-code", "77").is_err(), "owner/name");
        assert!(new("a/b/c", "77").is_err());
        assert!(new("a/../b", "77").is_err());
        assert!(new("a/b", "x").is_err());
        assert!(GrantConfig::new("1", b"not a key", "77", "a/b", None, "http://x".into()).is_err());
    }

    #[tokio::test]
    async fn an_invitation_is_sent_to_the_login_resolved_from_the_id_with_pull_only() {
        let fake = Shared::default();
        *fake.put_status.lock().unwrap() = 201;
        let base = fake_github(fake.clone()).await;
        let cfg = config(&base, None);
        let got = cfg.grant("42").await.unwrap();
        assert_eq!(
            got,
            Outcome::Invited {
                login: "octo".into(),
                invitation_id: Some(9001)
            }
        );
        let calls = fake.calls.lock().unwrap().clone();
        assert!(calls[0].starts_with("token "));
        assert!(calls[0].contains(r#""administration":"write""#));
        assert!(calls[0].contains(r#""repositories":["hegai-code"]"#));
        assert_eq!(calls[1], "user 42");
        assert_eq!(
            calls[2],
            r#"put hegai-code/hegai-code/octo {"permission":"pull"}"#
        );
        // The installation token is cached: a second grant asks for none.
        *fake.put_status.lock().unwrap() = 204;
        assert_eq!(
            cfg.grant("42").await.unwrap(),
            Outcome::Granted {
                login: "octo".into()
            }
        );
        let tokens = fake
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.starts_with("token "))
            .count();
        assert_eq!(tokens, 1);
    }

    #[tokio::test]
    async fn a_known_repository_id_narrows_the_token_by_id() {
        let fake = Shared::default();
        *fake.put_status.lock().unwrap() = 201;
        let base = fake_github(fake.clone()).await;
        config(&base, Some(555)).grant("42").await.unwrap();
        let first = fake.calls.lock().unwrap()[0].clone();
        assert!(first.contains(r#""repository_ids":[555]"#), "{first}");
        assert!(!first.contains("repositories"));
    }

    #[tokio::test]
    async fn a_missing_account_or_a_refused_invitation_is_permanent_a_5xx_is_not() {
        let fake = Shared::default();
        let base = fake_github(fake.clone()).await;
        let cfg = config(&base, None);
        *fake.user_missing.lock().unwrap() = true;
        assert!(cfg.grant("42").await.unwrap_err().permanent);
        *fake.user_missing.lock().unwrap() = false;
        *fake.put_status.lock().unwrap() = 422;
        let e = cfg.grant("42").await.unwrap_err();
        assert!(e.permanent);
        assert!(e.message.contains("422"), "{}", e.message);
        *fake.put_status.lock().unwrap() = 502;
        assert!(!cfg.grant("42").await.unwrap_err().permanent);
        // Nothing listens: transient, and no panic.
        let down = config("http://127.0.0.1:1", None);
        assert!(!down.grant("42").await.unwrap_err().permanent);
    }

    #[tokio::test]
    async fn acceptance_is_read_from_the_collaborator_check() {
        let fake = Shared::default();
        let base = fake_github(fake.clone()).await;
        let cfg = config(&base, None);
        assert!(!cfg.is_collaborator("octo").await.unwrap());
        *fake.collaborator.lock().unwrap() = true;
        assert!(cfg.is_collaborator("octo").await.unwrap());
        assert!(cfg.is_collaborator("../x").await.is_err());
    }

    fn store_with_github_user() -> (WorkspaceStore, String) {
        let s = WorkspaceStore::open_memory();
        let user = s
            .github_login(&crate::github_login::GithubUser {
                id: 42,
                login: "octo".into(),
                name: None,
                avatar_url: None,
                created_at: None,
                public_repos: None,
                followers: None,
                bio: None,
                blog: None,
                company: None,
            })
            .unwrap()
            .user_id;
        (s, user)
    }

    #[test]
    fn only_an_account_with_a_github_identity_is_queued_and_the_queue_is_idempotent() {
        let (s, user) = store_with_github_user();
        s.ensure_user("plain", "p@x.test", None).unwrap();
        assert!(!s.enqueue_github_grant("plain", "o/r").unwrap());
        assert!(s.github_grant("plain").unwrap().is_none());
        assert!(s.enqueue_github_grant(&user, "o/r").unwrap());
        let row = s.github_grant(&user).unwrap().unwrap();
        assert_eq!((row.status.as_str(), row.repo.as_str()), ("pending", "o/r"));
        // An invited row is not reset by a second activation …
        s.update_github_grant(&user, "invited", Some("octo"), None, 1, None, Some(1))
            .unwrap();
        assert!(s.enqueue_github_grant(&user, "o/r").unwrap());
        assert_eq!(s.github_grant(&user).unwrap().unwrap().status, "invited");
        // … a failed one starts over, and so does one for another repository.
        s.update_github_grant(&user, "failed", None, Some("x"), 5, None, None)
            .unwrap();
        s.enqueue_github_grant(&user, "o/r").unwrap();
        let row = s.github_grant(&user).unwrap().unwrap();
        assert_eq!(
            (row.status.as_str(), row.attempts, row.error),
            ("pending", 0, None)
        );
        s.update_github_grant(&user, "granted", None, None, 1, None, None)
            .unwrap();
        s.enqueue_github_grant(&user, "o/other").unwrap();
        let row = s.github_grant(&user).unwrap().unwrap();
        // Another repository: the access to the old one is revoked FIRST.
        assert_eq!(
            (row.status.as_str(), row.repo.as_str()),
            ("revoking", "o/r")
        );
    }

    #[test]
    fn a_sweep_takes_due_rows_once_and_only_for_its_repository() {
        let (s, user) = store_with_github_user();
        s.enqueue_github_grant(&user, "o/r").unwrap();
        assert!(s.claim_github_grants("o/elsewhere", 10).unwrap().is_empty());
        let jobs = s.claim_github_grants("o/r", 10).unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].github_id, "42");
        assert!(
            s.claim_github_grants("o/r", 10).unwrap().is_empty(),
            "leased: a second sweep does not take it"
        );
        // A row with no next time is never due (granted, failed, expired).
        s.update_github_grant(&user, "pending", None, None, 0, None, None)
            .unwrap();
        assert!(s.claim_github_grants("o/r", 10).unwrap().is_empty());
        // The admin's retry makes it due again.
        assert!(s.restart_github_grant(&user, "o/r").unwrap());
        assert_eq!(s.claim_github_grants("o/r", 10).unwrap().len(), 1);
        assert!(!s.restart_github_grant("nobody", "o/r").unwrap());
    }

    #[test]
    fn the_person_sees_status_and_repo_the_admin_also_sees_the_error() {
        let row = GrantRow {
            repo: "o/r".into(),
            status: "failed".into(),
            error: Some("GitHub HTTP 422: nope".into()),
            attempts: 5,
        };
        assert_eq!(row.json(false), json!({"status": "failed", "repo": "o/r"}));
        assert_eq!(row.json(true)["error"], "GitHub HTTP 422: nope");
        assert_eq!(row.json(true)["attempts"], 5);
    }

    fn app_with(cfg: GrantConfig, s: WorkspaceStore) -> (AppState, std::path::PathBuf) {
        let db = crate::account::tests::temp_db();
        let mut st = crate::account::tests::app_state(s, &db);
        st.github_grant = Some(Arc::new(cfg));
        (st, db)
    }

    fn make_due(s: &WorkspaceStore, user: &str) {
        let conn = s.conn.lock().unwrap();
        conn.execute(
            "UPDATE github_grants SET next_at=1,claimed_until=NULL WHERE user_id=?1",
            params![user],
        )
        .unwrap();
    }

    #[tokio::test]
    async fn a_sweep_invites_then_notices_acceptance_and_audits_both() {
        let fake = Shared::default();
        *fake.put_status.lock().unwrap() = 201;
        let base = fake_github(fake.clone()).await;
        let (s, user) = store_with_github_user();
        assert!(s.activate_access(&user, "admin").unwrap());
        let (st, db) = app_with(config(&base, None), s.clone());
        let cfg = st.github_grant.clone().unwrap();
        s.enqueue_github_grant(&user, &cfg.full_name()).unwrap();
        for job in s.claim_github_grants(&cfg.full_name(), 10).unwrap() {
            process(&st, &cfg, job).await;
        }
        assert_eq!(s.github_grant(&user).unwrap().unwrap().status, "invited");
        // Not accepted yet: stays invited and is polled again later.
        make_due(&s, &user);
        for job in s.claim_github_grants(&cfg.full_name(), 10).unwrap() {
            process(&st, &cfg, job).await;
        }
        assert_eq!(s.github_grant(&user).unwrap().unwrap().status, "invited");
        *fake.collaborator.lock().unwrap() = true;
        make_due(&s, &user);
        for job in s.claim_github_grants(&cfg.full_name(), 10).unwrap() {
            process(&st, &cfg, job).await;
        }
        assert_eq!(s.github_grant(&user).unwrap().unwrap().status, "granted");
        let audits: i64 = s
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM audit_events WHERE action='github.grant'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(audits, 2);
        crate::account::tests::cleanup(&db);
    }

    #[tokio::test]
    async fn failures_back_off_then_fail_and_never_touch_activation() {
        let fake = Shared::default();
        *fake.put_status.lock().unwrap() = 502;
        let base = fake_github(fake.clone()).await;
        let (s, user) = store_with_github_user();
        s.activate_access(&user, "admin").unwrap();
        let (st, db) = app_with(config(&base, None), s.clone());
        let cfg = st.github_grant.clone().unwrap();
        s.enqueue_github_grant(&user, &cfg.full_name()).unwrap();
        for attempt in 1..=MAX_ATTEMPTS {
            make_due(&s, &user);
            for job in s.claim_github_grants(&cfg.full_name(), 10).unwrap() {
                process(&st, &cfg, job).await;
            }
            let row = s.github_grant(&user).unwrap().unwrap();
            assert_eq!(row.attempts, attempt);
            assert_eq!(
                row.status,
                if attempt < MAX_ATTEMPTS {
                    "pending"
                } else {
                    "failed"
                }
            );
        }
        assert!(s.is_active(&user), "activation stands");
        // A suspended person is not invited.
        s.enqueue_github_grant(&user, &cfg.full_name()).unwrap();
        s.restart_github_grant(&user, &cfg.full_name()).unwrap();
        s.suspend_access(&user, "admin", None).unwrap();
        make_due(&s, &user);
        for job in s.claim_github_grants(&cfg.full_name(), 10).unwrap() {
            process(&st, &cfg, job).await;
        }
        let row = s.github_grant(&user).unwrap().unwrap();
        assert_eq!(
            row.status, "revoked",
            "a suspended person is never invited: the row is revoked"
        );
        crate::account::tests::cleanup(&db);
    }

    async fn sweep(st: &AppState, s: &WorkspaceStore, cfg: &GrantConfig, user: &str) {
        make_due(s, user);
        for job in s.claim_github_grants(&cfg.full_name(), 10).unwrap() {
            process(st, cfg, job).await;
        }
    }

    #[tokio::test]
    async fn suspending_cancels_the_invitation_and_removes_the_collaborator() {
        let fake = Shared::default();
        *fake.put_status.lock().unwrap() = 201;
        let base = fake_github(fake.clone()).await;
        let (s, user) = store_with_github_user();
        s.activate_access(&user, "admin").unwrap();
        let (st, db) = app_with(config(&base, None), s.clone());
        let cfg = st.github_grant.clone().unwrap();
        s.enqueue_github_grant(&user, &cfg.full_name()).unwrap();
        sweep(&st, &s, &cfg, &user).await;
        assert_eq!(s.github_grant(&user).unwrap().unwrap().status, "invited");
        *fake.has_invitation.lock().unwrap() = true;
        *fake.collaborator.lock().unwrap() = true;
        // Suspension marks the row; the sweep takes the access back.
        s.suspend_access(&user, "admin", None).unwrap();
        assert!(s.mark_github_revoking(&user).unwrap());
        sweep(&st, &s, &cfg, &user).await;
        assert_eq!(s.github_grant(&user).unwrap().unwrap().status, "revoked");
        let calls = fake.calls.lock().unwrap().clone();
        assert!(
            calls.contains(&"delete-invitation 9001".to_string()),
            "{calls:?}"
        );
        assert!(
            calls.contains(&"delete-collab octo".to_string()),
            "{calls:?}"
        );
        assert!(!*fake.collaborator.lock().unwrap());
        let revokes: i64 = s
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM audit_events WHERE action='github.revoke'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(revokes, 1);
        // Reactivation re-invites: a revoked row starts over.
        s.reactivate_access(&user, "admin").unwrap();
        s.enqueue_github_grant(&user, &cfg.full_name()).unwrap();
        assert_eq!(s.github_grant(&user).unwrap().unwrap().status, "pending");
        crate::account::tests::cleanup(&db);
    }

    #[tokio::test]
    async fn an_invitation_with_no_stored_id_is_found_by_the_account_id() {
        let fake = Shared::default();
        let base = fake_github(fake.clone()).await;
        *fake.has_invitation.lock().unwrap() = true;
        let login = config(&base, None)
            .revoke("hegai-code/hegai-code", "42", None)
            .await
            .unwrap();
        assert_eq!(login, "octo");
        let calls = fake.calls.lock().unwrap().clone();
        assert!(calls.contains(&"list-invitations".to_string()));
        assert!(
            calls.contains(&"delete-invitation 9001".to_string()),
            "{calls:?}"
        );
        // A GitHub account that no longer exists has nothing to take back.
        *fake.user_missing.lock().unwrap() = true;
        assert_eq!(
            config(&base, None)
                .revoke("hegai-code/hegai-code", "42", Some(1))
                .await
                .unwrap(),
            ""
        );
    }

    #[tokio::test]
    async fn a_failing_revocation_is_retried_not_given_up() {
        let (s, user) = store_with_github_user();
        s.activate_access(&user, "admin").unwrap();
        // Nothing listens: every attempt fails and the row stays `revoking`.
        let (st, db) = app_with(config("http://127.0.0.1:1", None), s.clone());
        let cfg = st.github_grant.clone().unwrap();
        s.enqueue_github_grant(&user, &cfg.full_name()).unwrap();
        s.suspend_access(&user, "admin", None).unwrap();
        s.mark_github_revoking(&user).unwrap();
        for attempt in 1..=(MAX_ATTEMPTS + 2) {
            sweep(&st, &s, &cfg, &user).await;
            let row = s.github_grant(&user).unwrap().unwrap();
            assert_eq!((row.status.as_str(), row.attempts), ("revoking", attempt));
            assert!(row.error.is_some());
        }
        crate::account::tests::cleanup(&db);
    }

    #[tokio::test]
    async fn a_deleted_account_leaves_a_tombstone_until_the_access_is_gone() {
        let fake = Shared::default();
        let base = fake_github(fake.clone()).await;
        let (s, user) = store_with_github_user();
        s.activate_access(&user, "admin").unwrap();
        let (st, db) = app_with(config(&base, None), s.clone());
        let cfg = st.github_grant.clone().unwrap();
        s.enqueue_github_grant(&user, &cfg.full_name()).unwrap();
        s.update_github_grant(&user, "granted", Some("octo"), None, 1, None, None)
            .unwrap();
        // What account deletion does to the row, then the user row is gone.
        force_revoking(&s, &user);
        s.conn
            .lock()
            .unwrap()
            .execute_batch(&format!(
                "PRAGMA foreign_keys=OFF; DELETE FROM users WHERE user_id='{user}'; PRAGMA foreign_keys=ON;"
            ))
            .unwrap();
        assert_eq!(s.github_grant(&user).unwrap().unwrap().status, "revoking");
        let owed = s.pending_github_revocations().unwrap();
        assert_eq!(owed.len(), 1);
        assert_eq!(owed[0]["login"], "octo");
        assert_eq!(owed[0]["githubId"], "42");
        sweep(&st, &s, &cfg, &user).await;
        assert!(
            s.github_grant(&user).unwrap().is_none(),
            "tombstone dropped after revoking"
        );
        assert!(s.pending_github_revocations().unwrap().is_empty());
        crate::account::tests::cleanup(&db);
    }

    #[tokio::test]
    async fn a_grant_that_lands_after_suspension_is_not_recorded_as_granted() {
        let fake = Shared::default();
        *fake.put_status.lock().unwrap() = 204;
        let base = fake_github(fake.clone()).await;
        let (s, user) = store_with_github_user();
        s.activate_access(&user, "admin").unwrap();
        let (st, db) = app_with(config(&base, None), s.clone());
        let cfg = st.github_grant.clone().unwrap();
        s.enqueue_github_grant(&user, &cfg.full_name()).unwrap();
        let jobs = s.claim_github_grants(&cfg.full_name(), 10).unwrap();
        // The person is suspended while the claimed job is in flight.
        s.suspend_access(&user, "admin", None).unwrap();
        s.mark_github_revoking(&user).unwrap();
        for job in jobs {
            process(&st, &cfg, job).await;
        }
        let row = s.github_grant(&user).unwrap().unwrap();
        assert_ne!(row.status, "granted");
        assert_ne!(row.status, "invited");
        crate::account::tests::cleanup(&db);
    }

    #[tokio::test]
    async fn acceptance_follows_a_renamed_login_and_an_expired_invitation_fails() {
        let fake = Shared::default();
        *fake.put_status.lock().unwrap() = 201;
        let base = fake_github(fake.clone()).await;
        let (s, user) = store_with_github_user();
        s.activate_access(&user, "admin").unwrap();
        let (st, db) = app_with(config(&base, None), s.clone());
        let cfg = st.github_grant.clone().unwrap();
        s.enqueue_github_grant(&user, &cfg.full_name()).unwrap();
        sweep(&st, &s, &cfg, &user).await;
        // Renamed on GitHub, then accepted: polled by id, login updated.
        *fake.login.lock().unwrap() = "octo-new".into();
        *fake.collaborator.lock().unwrap() = true;
        sweep(&st, &s, &cfg, &user).await;
        assert_eq!(s.github_grant(&user).unwrap().unwrap().status, "granted");
        let login: String = s
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT login FROM github_grants WHERE user_id=?1",
                params![user],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(login, "octo-new");
        let polled = fake
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|c| c == "get-collab octo-new");
        assert!(polled);
        // A new invitation nobody accepts for over eight days: failed, requeueable.
        s.enqueue_github_grant(&user, &cfg.full_name()).unwrap();
        *fake.collaborator.lock().unwrap() = false;
        sweep(&st, &s, &cfg, &user).await;
        assert_eq!(s.github_grant(&user).unwrap().unwrap().status, "invited");
        s.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE github_grants SET invited_at=1 WHERE user_id=?1",
                params![user],
            )
            .unwrap();
        sweep(&st, &s, &cfg, &user).await;
        let row = s.github_grant(&user).unwrap().unwrap();
        assert_eq!(
            (row.status.as_str(), row.error.as_deref()),
            ("failed", Some("invitation expired"))
        );
        s.enqueue_github_grant(&user, &cfg.full_name()).unwrap();
        assert_eq!(s.github_grant(&user).unwrap().unwrap().status, "pending");
        crate::account::tests::cleanup(&db);
    }

    #[tokio::test]
    async fn a_granted_row_is_revalidated_by_a_retry_and_reinvites_if_the_access_is_gone() {
        let fake = Shared::default();
        *fake.put_status.lock().unwrap() = 201;
        let base = fake_github(fake.clone()).await;
        let (s, user) = store_with_github_user();
        s.activate_access(&user, "admin").unwrap();
        let (st, db) = app_with(config(&base, None), s.clone());
        let cfg = st.github_grant.clone().unwrap();
        s.enqueue_github_grant(&user, &cfg.full_name()).unwrap();
        s.update_github_grant(&user, "granted", Some("octo"), None, 1, None, None)
            .unwrap();
        // Activation/reactivation or the admin's retry on a granted row.
        s.enqueue_github_grant(&user, &cfg.full_name()).unwrap();
        assert_eq!(s.github_grant(&user).unwrap().unwrap().status, "pending");
        sweep(&st, &s, &cfg, &user).await;
        assert_eq!(
            s.github_grant(&user).unwrap().unwrap().status,
            "invited",
            "the collaborator was gone: invited again"
        );
        s.update_github_grant(&user, "granted", Some("octo"), None, 1, None, None)
            .unwrap();
        assert!(s.restart_github_grant(&user, &cfg.full_name()).unwrap());
        *fake.put_status.lock().unwrap() = 204;
        sweep(&st, &s, &cfg, &user).await;
        assert_eq!(s.github_grant(&user).unwrap().unwrap().status, "granted");
        crate::account::tests::cleanup(&db);
    }

    #[cfg(unix)]
    #[test]
    fn the_key_file_must_be_private_to_its_owner() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("gh-key-{}", Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("app.pem");
        std::fs::write(&path, b"x").unwrap();
        let p = path.to_str().unwrap();
        for mode in [0o644, 0o640, 0o604, 0o660] {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
            assert!(check_key_file(p).is_err(), "{mode:o}");
        }
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(check_key_file(p).is_ok());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o400)).unwrap();
        assert!(check_key_file(p).is_ok());
        assert!(check_key_file(dir.to_str().unwrap()).is_err(), "not a file");
        assert!(check_key_file("/nonexistent/app.pem").is_err());
        std::fs::remove_dir_all(dir).ok();
    }

    /// What an account deletion does to the row (no suspension hook involved).
    fn force_revoking(s: &WorkspaceStore, user: &str) {
        s.conn
            .lock()
            .unwrap()
            .execute(MARK_REVOKING_SQL, params![user, workspace::now_ms()])
            .unwrap();
    }

    fn job_of(s: &WorkspaceStore, user: &str) -> Job {
        s.claim_github_grants("hegai-code/hegai-code", 10)
            .unwrap()
            .into_iter()
            .find(|j| j.user_id == user)
            .expect("a due row")
    }

    fn row_field(s: &WorkspaceStore, user: &str, col: &str) -> Option<String> {
        s.conn
            .lock()
            .unwrap()
            .query_row(
                &format!("SELECT CAST({col} AS TEXT) FROM github_grants WHERE user_id=?1"),
                params![user],
                |r| r.get(0),
            )
            .unwrap()
    }

    #[test]
    fn a_stale_step_changes_nothing_every_write_is_compare_and_set() {
        let (s, user) = store_with_github_user();
        s.activate_access(&user, "admin").unwrap();
        s.enqueue_github_grant(&user, "hegai-code/hegai-code")
            .unwrap();
        let job = job_of(&s, &user);
        // A suspension lands while the step works.
        s.suspend_access(&user, "admin", None).unwrap();
        s.mark_github_revoking(&user).unwrap();
        // The finished grant step cannot move the row back …
        let mut step = Step::new("granted", 1);
        step.login = Some("octo");
        assert!(!s.cas_github_grant(&job, &step).unwrap());
        assert_eq!(s.github_grant(&user).unwrap().unwrap().status, "revoking");
        // … nor can a stale revocation end it (it was claimed as pending).
        assert!(!s.finish_github_revocation(&job, Some("octo")).unwrap());
        assert_eq!(s.github_grant(&user).unwrap().unwrap().status, "revoking");
        // A revocation's own failure write is checked too: a restart wins.
        let revoking = job_of_after_due(&s, &user);
        s.mark_github_revoking(&user).unwrap(); // bumps the version
        let mut fail = Step::new("revoking", 9);
        fail.error = Some("late");
        assert!(!s.cas_github_grant(&revoking, &fail).unwrap());
        assert!(!s.finish_github_revocation(&revoking, None).unwrap());
        assert_ne!(row_field(&s, &user, "attempts").as_deref(), Some("9"));
    }

    fn job_of_after_due(s: &WorkspaceStore, user: &str) -> Job {
        make_due(s, user);
        job_of(s, user)
    }

    #[test]
    fn a_reactivation_during_a_revocation_waits_for_it_then_grants_anew() {
        let (s, user) = store_with_github_user();
        s.activate_access(&user, "admin").unwrap();
        s.enqueue_github_grant(&user, "hegai-code/hegai-code")
            .unwrap();
        s.update_github_grant(&user, "granted", Some("octo"), None, 1, None, None)
            .unwrap();
        s.suspend_access(&user, "admin", None).unwrap();
        s.mark_github_revoking(&user).unwrap();
        let job = job_of(&s, &user);
        // Reactivated while the revoker is mid-way: still `revoking`.
        s.reactivate_access(&user, "admin").unwrap();
        s.enqueue_github_grant(&user, "hegai-code/hegai-code")
            .unwrap();
        assert_eq!(s.github_grant(&user).unwrap().unwrap().status, "revoking");
        assert_eq!(
            row_field(&s, &user, "requeue_repo").as_deref(),
            Some("hegai-code/hegai-code")
        );
        // The in-flight revocation read the old version: it must run again.
        assert!(!s.finish_github_revocation(&job, Some("octo")).unwrap());
        let again = job_of_after_due(&s, &user);
        assert!(s.finish_github_revocation(&again, Some("octo")).unwrap());
        let row = s.github_grant(&user).unwrap().unwrap();
        assert_eq!(
            row.status, "pending",
            "a new grant starts after the revocation"
        );
        assert_eq!(row_field(&s, &user, "requeue_repo"), None);
        // Without the reactivation it ends revoked.
        s.suspend_access(&user, "admin", None).unwrap();
        s.mark_github_revoking(&user).unwrap();
        let job = job_of_after_due(&s, &user);
        assert!(s.finish_github_revocation(&job, None).unwrap());
        assert_eq!(s.github_grant(&user).unwrap().unwrap().status, "revoked");
    }

    #[tokio::test]
    async fn a_row_of_an_inactive_person_is_marked_revoking_before_any_step() {
        let fake = Shared::default();
        *fake.put_status.lock().unwrap() = 201;
        let base = fake_github(fake.clone()).await;
        let (s, user) = store_with_github_user();
        s.activate_access(&user, "admin").unwrap();
        let (st, db) = app_with(config(&base, None), s.clone());
        let cfg = st.github_grant.clone().unwrap();
        s.enqueue_github_grant(&user, &cfg.full_name()).unwrap();
        s.update_github_grant(
            &user,
            "invited",
            Some("octo"),
            None,
            1,
            Some(1),
            Some(workspace::now_ms()),
        )
        .unwrap();
        // Suspended with no hook (a direct state change): the step notices.
        s.suspend_access(&user, "admin", None).unwrap();
        sweep(&st, &s, &cfg, &user).await;
        assert_eq!(s.github_grant(&user).unwrap().unwrap().status, "revoked");
        assert!(
            !fake
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|c| c.starts_with("put ")),
            "no invitation is ever sent for an inactive person"
        );
        crate::account::tests::cleanup(&db);
    }

    #[tokio::test]
    async fn one_operation_per_account_at_a_time() {
        let (s, user) = store_with_github_user();
        s.activate_access(&user, "admin").unwrap();
        let (st, db) = app_with(config("http://127.0.0.1:1", None), s.clone());
        let cfg = st.github_grant.clone().unwrap();
        s.enqueue_github_grant(&user, &cfg.full_name()).unwrap();
        let busy = Flight::enter(&s, "42").expect("first");
        assert!(Flight::enter(&s, "42").is_none(), "second is refused");
        // A busy account is skipped and left for the next sweep.
        make_due(&s, &user);
        for job in s.claim_github_grants(&cfg.full_name(), 10).unwrap() {
            process(&st, &cfg, job).await;
        }
        assert_eq!(row_field(&s, &user, "attempts").as_deref(), Some("0"));
        assert_eq!(
            row_field(&s, &user, "claimed_until"),
            None,
            "claim released"
        );
        drop(busy);
        assert!(Flight::enter(&s, "42").is_some());
        crate::account::tests::cleanup(&db);
    }

    #[tokio::test]
    async fn a_new_account_with_the_same_github_id_is_not_stripped_by_an_old_tombstone() {
        let fake = Shared::default();
        *fake.put_status.lock().unwrap() = 201;
        let base = fake_github(fake.clone()).await;
        let (s, old) = store_with_github_user();
        s.activate_access(&old, "admin").unwrap();
        let (st, db) = app_with(config(&base, None), s.clone());
        let cfg = st.github_grant.clone().unwrap();
        s.enqueue_github_grant(&old, &cfg.full_name()).unwrap();
        s.update_github_grant(&old, "granted", Some("octo"), None, 1, None, None)
            .unwrap();
        force_revoking(&s, &old);
        s.conn
            .lock()
            .unwrap()
            .execute_batch(&format!(
                "PRAGMA foreign_keys=OFF; DELETE FROM users WHERE user_id='{old}'; DELETE FROM identities WHERE user_id='{old}'; PRAGMA foreign_keys=ON;"
            ))
            .unwrap();
        // The same person signs up again and is activated: the tombstone goes.
        let new = s
            .github_login(&crate::github_login::GithubUser {
                id: 42,
                login: "octo".into(),
                name: None,
                avatar_url: None,
                created_at: None,
                public_repos: None,
                followers: None,
                bio: None,
                blog: None,
                company: None,
            })
            .unwrap()
            .user_id;
        s.activate_access(&new, "admin").unwrap();
        s.enqueue_github_grant(&new, &cfg.full_name()).unwrap();
        assert!(
            s.github_grant(&old).unwrap().is_none(),
            "tombstone superseded"
        );
        // A tombstone that is mid-revocation is NOT dropped: the new grant waits.
        let busy = Flight::enter(&s, "42").unwrap();
        s.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO github_grants(user_id,repo,github_id,login,status,next_at,created_at,updated_at) VALUES('gone',?1,'42','octo','revoking',1,0,0)",
                params![cfg.full_name()],
            )
            .unwrap();
        s.enqueue_github_grant(&new, &cfg.full_name()).unwrap();
        assert!(s.github_grant("gone").unwrap().is_some());
        drop(busy);
        // And a revocation that does run, with the new account active, calls
        // nothing on GitHub.
        sweep(&st, &s, &cfg, "gone").await;
        assert!(s.github_grant("gone").unwrap().is_none());
        assert!(
            !fake
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|c| c.starts_with("delete-")),
            "the active new owner keeps the access: {:?}",
            fake.calls.lock().unwrap()
        );
        crate::account::tests::cleanup(&db);
    }

    #[tokio::test]
    async fn a_revocation_is_confirmed_by_looking_again_and_uses_the_rows_own_repo() {
        let fake = Shared::default();
        let base = fake_github(fake.clone()).await;
        let (s, user) = store_with_github_user();
        s.activate_access(&user, "admin").unwrap();
        let (st, db) = app_with(config(&base, None), s.clone());
        let cfg = st.github_grant.clone().unwrap();
        // A row left from an EARLIER repository: still revoked, against its own.
        s.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO github_grants(user_id,repo,github_id,login,status,next_at,created_at,updated_at) VALUES(?1,'hegai-code/old-repo','42','octo','revoking',1,0,0)",
                params![user],
            )
            .unwrap();
        s.suspend_access(&user, "admin", None).unwrap();
        *fake.collaborator.lock().unwrap() = true;
        sweep(&st, &s, &cfg, &user).await;
        assert_eq!(s.github_grant(&user).unwrap().unwrap().status, "revoked");
        let calls = fake.calls.lock().unwrap().clone();
        let tokens: Vec<_> = calls.iter().filter(|c| c.starts_with("token ")).collect();
        assert!(
            tokens
                .iter()
                .any(|t| t.contains(r#""repositories":["old-repo"]"#)),
            "{calls:?}"
        );
        // After the DELETE the collaborator and the invitation list were read again.
        let delete_at = calls
            .iter()
            .position(|c| c == "delete-collab octo")
            .unwrap();
        assert!(
            calls[delete_at..].iter().any(|c| c == "get-collab octo"),
            "{calls:?}"
        );
        assert!(
            calls[delete_at..].iter().any(|c| c == "list-invitations"),
            "{calls:?}"
        );
        // Still a collaborator afterwards: not revoked.
        let fake2 = Shared::default();
        let base2 = fake_github(fake2.clone()).await;
        *fake2.stubborn.lock().unwrap() = true;
        *fake2.collaborator.lock().unwrap() = true;
        let err = config(&base2, None)
            .revoke("hegai-code/hegai-code", "42", None)
            .await
            .unwrap_err();
        assert!(
            err.message.contains("still a collaborator"),
            "{}",
            err.message
        );
        crate::account::tests::cleanup(&db);
    }

    #[tokio::test]
    async fn every_page_of_invitations_is_searched() {
        let fake = Shared::default();
        let base = fake_github(fake.clone()).await;
        *fake.many_invitations.lock().unwrap() = true;
        let found = config(&base, None)
            .find_invitation("hegai-code/hegai-code", "42")
            .await
            .unwrap();
        assert_eq!(found, Some(9001), "the invitation is on page two");
    }

    #[test]
    fn the_deletion_request_marks_the_grant_in_its_own_transaction() {
        let (s, user) = store_with_github_user();
        s.activate_access(&user, "admin").unwrap();
        s.enqueue_github_grant(&user, "o/r").unwrap();
        s.update_github_grant(&user, "granted", Some("octo"), None, 1, None, None)
            .unwrap();
        s.request_account_deletion(&user, &json!([])).unwrap();
        assert_eq!(s.github_grant(&user).unwrap().unwrap().status, "revoking");
        assert!(row_field(&s, &user, "next_at").is_some());
    }

    #[tokio::test]
    async fn a_stale_revoking_job_does_nothing_after_the_row_moved_on() {
        let fake = Shared::default();
        let base = fake_github(fake.clone()).await;
        let (s, user) = store_with_github_user();
        s.activate_access(&user, "admin").unwrap();
        let (st, db) = app_with(config(&base, None), s.clone());
        let cfg = st.github_grant.clone().unwrap();
        s.enqueue_github_grant(&user, &cfg.full_name()).unwrap();
        force_revoking(&s, &user);
        let stale = job_of(&s, &user);
        // Reactivated and re-granted before the stale job runs.
        s.update_github_grant(&user, "granted", Some("octo"), None, 1, None, None)
            .unwrap();
        process(&st, &cfg, stale).await;
        assert!(
            !fake
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|c| c.starts_with("delete-")),
            "{:?}",
            fake.calls.lock().unwrap()
        );
        assert_eq!(s.github_grant(&user).unwrap().unwrap().status, "granted");
        crate::account::tests::cleanup(&db);
    }

    #[test]
    fn a_late_suspend_hook_does_not_revoke_a_reactivated_person() {
        let (s, user) = store_with_github_user();
        s.activate_access(&user, "admin").unwrap();
        s.enqueue_github_grant(&user, "o/r").unwrap();
        s.update_github_grant(&user, "granted", Some("octo"), None, 1, None, None)
            .unwrap();
        s.suspend_access(&user, "admin", None).unwrap();
        s.reactivate_access(&user, "admin").unwrap();
        // The hook of the suspension arrives after the reactivation.
        assert!(!s.mark_github_revoking(&user).unwrap());
        assert_eq!(s.github_grant(&user).unwrap().unwrap().status, "granted");
        s.suspend_access(&user, "admin", None).unwrap();
        assert!(
            s.mark_github_revoking(&user).unwrap(),
            "still suspended: revoked"
        );
    }

    #[test]
    fn a_requeued_grant_targets_the_current_github_account() {
        let (s, user) = store_with_github_user();
        s.activate_access(&user, "admin").unwrap();
        s.enqueue_github_grant(&user, "o/r").unwrap();
        s.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE github_grants SET github_id='7' WHERE user_id=?1",
                params![user],
            )
            .unwrap();
        force_revoking(&s, &user);
        s.enqueue_github_grant(&user, "o/r").unwrap(); // requeue_repo set
        let job = job_of_after_due(&s, &user);
        assert!(s.finish_github_revocation(&job, None).unwrap());
        assert_eq!(row_field(&s, &user, "status").as_deref(), Some("pending"));
        assert_eq!(row_field(&s, &user, "github_id").as_deref(), Some("42"));
    }

    #[tokio::test]
    async fn the_new_owner_exemption_is_for_the_current_repository_only() {
        let fake = Shared::default();
        let base = fake_github(fake.clone()).await;
        let (s, new) = store_with_github_user();
        s.activate_access(&new, "admin").unwrap();
        let (st, db) = app_with(config(&base, None), s.clone());
        let cfg = st.github_grant.clone().unwrap();
        let insert = |user: &str, repo: &str| {
            s.conn
                .lock()
                .unwrap()
                .execute(
                    "INSERT INTO github_grants(user_id,repo,github_id,login,status,next_at,created_at,updated_at) VALUES(?1,?2,'42','octo','revoking',1,0,0)",
                    params![user, repo],
                )
                .unwrap();
        };
        insert("gone-cur", &cfg.full_name());
        sweep(&st, &s, &cfg, "gone-cur").await;
        assert!(
            !fake
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|c| c.starts_with("delete-")),
            "current repository: the active new owner keeps it"
        );
        insert("gone-old", "hegai-code/old-repo");
        sweep(&st, &s, &cfg, "gone-old").await;
        assert!(
            fake.calls
                .lock()
                .unwrap()
                .iter()
                .any(|c| c == "delete-collab octo"),
            "an old repository's access is revoked whoever owns the id now"
        );
        crate::account::tests::cleanup(&db);
    }

    #[tokio::test]
    async fn a_database_error_is_not_read_as_inactive() {
        let fake = Shared::default();
        *fake.put_status.lock().unwrap() = 201;
        let base = fake_github(fake.clone()).await;
        let (s, user) = store_with_github_user();
        s.activate_access(&user, "admin").unwrap();
        let (st, db) = app_with(config(&base, None), s.clone());
        let cfg = st.github_grant.clone().unwrap();
        s.enqueue_github_grant(&user, &cfg.full_name()).unwrap();
        let version = row_field(&s, &user, "version");
        s.conn
            .lock()
            .unwrap()
            .execute_batch("ALTER TABLE user_access RENAME TO user_access_away")
            .unwrap();
        sweep(&st, &s, &cfg, &user).await;
        assert_eq!(s.github_grant(&user).unwrap().unwrap().status, "pending");
        assert_eq!(row_field(&s, &user, "version"), version, "no state change");
        assert!(!fake
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|c| c.starts_with("put ")));
        crate::account::tests::cleanup(&db);
    }

    #[tokio::test]
    async fn rows_of_an_earlier_repository_are_moved_to_revoking_by_the_sweep() {
        let (s, user) = store_with_github_user();
        s.activate_access(&user, "admin").unwrap();
        s.enqueue_github_grant(&user, "o/old").unwrap();
        s.update_github_grant(&user, "granted", Some("octo"), None, 1, None, None)
            .unwrap();
        s.ensure_user("other", "o@x.test", None).unwrap();
        // An inactive person's row and a row already for the current repo.
        s.conn
            .lock()
            .unwrap()
            .execute_batch(
                "INSERT INTO github_grants(user_id,repo,github_id,status,created_at,updated_at) VALUES('idle','o/old','9','invited',0,0);
                 INSERT INTO github_grants(user_id,repo,github_id,status,created_at,updated_at) VALUES('cur','o/new','8','granted',0,0);",
            )
            .unwrap();
        assert_eq!(s.retarget_github_grants("o/new").unwrap(), 2);
        assert_eq!(row_field(&s, &user, "status").as_deref(), Some("revoking"));
        assert_eq!(
            row_field(&s, &user, "requeue_repo").as_deref(),
            Some("o/new")
        );
        assert_eq!(row_field(&s, "idle", "status").as_deref(), Some("revoking"));
        assert_eq!(
            row_field(&s, "idle", "requeue_repo"),
            None,
            "not active: no re-grant"
        );
        assert_eq!(row_field(&s, "cur", "status").as_deref(), Some("granted"));
    }

    #[test]
    fn the_admin_list_and_the_viewer_carry_registration_profile_and_grant() {
        let (s, user) = store_with_github_user();
        s.save_registration(
            &user,
            &crate::access_registration::parse(
                &json!({"role": "dev", "purpose": "self-host", "telegram": "abcd"}),
            )
            .unwrap(),
        )
        .unwrap();
        s.enqueue_github_grant(&user, "o/r").unwrap();
        let rows = s.access_rows(Some("waitlist"), 10, 0).unwrap();
        let row = rows.iter().find(|r| r["userId"] == user.as_str()).unwrap();
        assert_eq!(row["registration"]["telegram"], "@abcd");
        assert_eq!(row["github"]["login"], "octo");
        assert_eq!(row["github"]["id"], "42");
        assert_eq!(row["githubGrant"]["status"], "pending");
        assert_eq!(row["githubGrant"]["attempts"], 0);
        let viewer = s
            .viewer_access_json(&s.access_state(&user).unwrap())
            .unwrap();
        assert_eq!(viewer["registered"], true);
        assert_eq!(
            viewer["githubGrant"],
            json!({"status": "pending", "repo": "o/r"})
        );
        // Someone with none of it: no keys, no nulls.
        s.ensure_user("plain", "p@x.test", None).unwrap();
        let rows = s.access_rows(None, 10, 0).unwrap();
        let plain = rows.iter().find(|r| r["userId"] == "plain").unwrap();
        assert!(plain.get("registration").is_none() && plain.get("github").is_none());
        let viewer = s
            .viewer_access_json(&s.access_state("plain").unwrap())
            .unwrap();
        assert_eq!(viewer["registered"], false);
        assert!(viewer.get("githubGrant").is_none());
    }
}
