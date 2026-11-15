//! External edition: which agent bundle the hub serves, and who allowed it.
//!
//! In the internal edition a hub deploy IS the rollout and none of this runs.
//! On a customer's hub (`CC_REMOTE_EDITION=external`) a new agent reaches the
//! customer's machines only if
//!
//!   1. it carries OUR release signature — an Ed25519 signature over a small
//!      manifest (`hegai-code-agent-release/1`, edition=external, version, sha256) made by
//!      `deploy/release-signer/` against a code from Owner's authenticator —
//!      verified here against `deploy/release-keys.txt`, and
//!   2. the customer's owner approved it with THEIR authenticator code.
//!
//! The hub never serves the bundle it was built with. The OFFERED bundle (what
//! the image carries) lives in `CC_REMOTE_AGENT_RELEASE_DIR` (default
//! `/app/agent-release`: `agent-external.mjs` + `.release` + `.sig`). The
//! APPROVED bundle lives in the data volume (`<data>/agent-release/approved.*`,
//! the previous one as `previous.*` for rollback) and is what
//! `/install/agent.mjs*` serves. Agents verify the same signature themselves
//! (`agent/src/self-update.ts`), so a compromised hub or volume cannot make
//! them install an unsigned file; approval is the customer's veto on top.
//!
//! First boot with nothing approved: a validly signed offered bundle is
//! approved automatically (the owner has just installed that very version).
//! Afterwards a different valid sha waits as "pending".

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ring::signature::{UnparsedPublicKey, ED25519};
use rusqlite::Connection;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::*;

/// The same list the external agent bundle compiles in.
const RELEASE_KEYS_TXT: &str = include_str!("../../deploy/release-keys.txt");
/// `schema_meta` key written, and never removed, the first time a bundle is
/// approved. It lives in the database, apart from the files it guards.
pub(crate) const INITIALIZED_KEY: &str = "agent_release_initialized";
const DEFAULT_OFFERED_DIR: &str = "/app/agent-release";
const OFFERED_STEM: &str = "agent-external.mjs";
/// Wrong authenticator codes per admin before approvals pause.
const MAX_CODE_FAILURES: usize = 5;
const CODE_FAILURE_WINDOW_MS: i64 = 15 * 60_000;
/// 12-byte DER prefix of an Ed25519 SubjectPublicKeyInfo, then the 32-byte key.
const SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

// ---------------------------------------------------------------- pure parts

/// Raw 32-byte Ed25519 keys from the text of `release-keys.txt`: base64 SPKI
/// DER, one per line, `#` comments. A line that is not such a key is skipped —
/// the hub must never trust something it cannot read.
pub(crate) fn parse_keys(text: &str) -> Vec<[u8; 32]> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| B64.decode(l).ok())
        .filter(|der| der.len() == 44 && der[..12] == SPKI_PREFIX)
        .filter_map(|der| der[12..].try_into().ok())
        .collect()
}

/// `(version, sha256)` of a manifest, only for its exact canonical bytes —
/// LF endings, trailing LF, nothing else (the signature covers those bytes).
/// The manifest must attest `edition=external`: a signed INTERNAL bundle is
/// not a release this hub (or any external agent) may offer.
pub(crate) fn parse_manifest(text: &str) -> Option<(String, String)> {
    let body = text.strip_suffix('\n')?;
    let mut lines = body.split('\n');
    if lines.next()? != "hegai-code-agent-release/1" {
        return None;
    }
    if lines.next()? != "edition=external" {
        return None;
    }
    let version = lines.next()?.strip_prefix("version=")?;
    let sha = lines.next()?.strip_prefix("sha256=")?;
    if lines.next().is_some() || version.is_empty() || version.contains('\r') {
        return None;
    }
    let sha_ok = sha.len() == 64
        && sha
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    sha_ok.then(|| (version.to_string(), sha.to_string()))
}

pub(crate) fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The three files of a release, as read from disk.
#[derive(Clone)]
pub(crate) struct Bundle {
    /// Reference-counted: serving a download clones a pointer, not 1.7 MB.
    bytes: axum::body::Bytes,
    manifest: String,
    sig_b64: String,
    pub(crate) sha: String,
    pub(crate) version: String,
}

impl Bundle {
    /// `<stem>`, `<stem>.release`, `<stem>.sig` in `dir`. `Err` when a file is
    /// missing or the manifest does not describe THIS bundle.
    fn read(dir: &Path, stem: &str) -> Result<Bundle, String> {
        let read = |suffix: &str| -> Result<Vec<u8>, String> {
            let p = dir.join(format!("{stem}{suffix}"));
            fs::read(&p).map_err(|e| format!("{}: {e}", p.display()))
        };
        let bytes = read("")?;
        let manifest = String::from_utf8(read(".release")?).map_err(|_| "manifest is not UTF-8")?;
        let sig_b64 = String::from_utf8(read(".sig")?).map_err(|_| "signature is not UTF-8")?;
        let sha = sha256_hex(&bytes);
        let (version, manifest_sha) =
            parse_manifest(&manifest).ok_or("the release manifest is malformed")?;
        if manifest_sha != sha {
            return Err("the release manifest is for a different file".into());
        }
        Ok(Bundle {
            bytes: bytes.into(),
            manifest,
            sig_b64,
            sha,
            version,
        })
    }

    /// True when one of `keys` signed exactly the manifest bytes.
    fn signature_ok(&self, keys: &[[u8; 32]]) -> bool {
        verify_signature(&self.manifest, &self.sig_b64, keys).is_some()
    }
}

/// Index of the first of `keys` whose Ed25519 signature `sig_b64` (base64 of
/// 64 bytes) covers exactly the `manifest` bytes.
pub(crate) fn verify_signature(manifest: &str, sig_b64: &str, keys: &[[u8; 32]]) -> Option<usize> {
    let sig = B64.decode(sig_b64.trim()).ok()?;
    if sig.len() != 64 {
        return None;
    }
    keys.iter().position(|k| {
        UnparsedPublicKey::new(&ED25519, k)
            .verify(manifest.as_bytes(), &sig)
            .is_ok()
    })
}

/// The keys compiled into this hub from `deploy/release-keys.txt`.
pub(crate) fn compiled_keys() -> Vec<[u8; 32]> {
    parse_keys(RELEASE_KEYS_TXT)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Meta {
    pub(crate) sha: String,
    pub(crate) version: String,
    pub(crate) approved_by: String,
    pub(crate) approved_at: i64,
}

impl Meta {
    fn to_json(&self) -> Value {
        json!({"sha": self.sha, "version": self.version, "approvedBy": self.approved_by, "approvedAt": self.approved_at})
    }
    fn from_json(v: &Value) -> Option<Meta> {
        Some(Meta {
            sha: v.get("sha")?.as_str()?.to_string(),
            version: v.get("version")?.as_str()?.to_string(),
            approved_by: v.get("approvedBy")?.as_str()?.to_string(),
            approved_at: v.get("approvedAt")?.as_i64()?,
        })
    }
}

/// What the image carries.
pub(crate) enum Offered {
    /// No bundle in the release directory.
    Missing,
    /// There, but not usable: the reason, and the sha when it can be computed.
    Invalid {
        sha: Option<String>,
        version: Option<String>,
        reason: String,
    },
    /// Manifest matches and the signature verifies against a trusted key.
    Valid(Bundle),
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ReleaseError {
    /// The offered bundle is not there, not valid, or not the one the admin saw.
    OfferChanged,
    AlreadyApproved,
    NoPrevious,
    Io(String),
}

pub(crate) fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("x");
    let tmp = path.with_file_name(format!(".{name}.tmp"));
    fs::write(&tmp, data).map_err(|e| format!("{}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

// --------------------------------------------------------------------- store

pub(crate) struct ReleaseStore {
    offered_dir: PathBuf,
    /// `<data>/agent-release`.
    state_dir: PathBuf,
    keys: Vec<[u8; 32]>,
    /// Serialises writers (and readers of `previous`) of the approved/previous
    /// files. Never taken to serve a download and never held together with the
    /// database connection lock by a caller that then waits for it.
    lock: Mutex<()>,
    /// The approved bundle, verified once (at start-up and whenever it is
    /// written) and served from memory: `/install/agent.mjs*` is open to the
    /// internet, so a request must cost neither a disk read, a hash nor a
    /// signature check.
    approved_cache: RwLock<Option<Arc<(Bundle, Meta)>>>,
    /// A bundle has been approved on this installation before (the irreversible
    /// marker in the database, `INITIALIZED_KEY`, mirrored here). Once set, a
    /// missing or damaged approved slot is NOT a first boot: nothing is
    /// auto-approved and the owner must approve with their authenticator.
    initialized: AtomicBool,
    /// Wrong codes per user (unix ms), for the approval throttle.
    failures: Mutex<HashMap<String, Vec<i64>>>,
    /// An audit event waiting for a workspace to be written into (a fresh
    /// install auto-approves before anybody has signed in).
    deferred_audit: Mutex<Option<(String, Value)>>,
}

impl ReleaseStore {
    pub(crate) fn new(offered_dir: PathBuf, data_dir: &Path, keys: Vec<[u8; 32]>) -> ReleaseStore {
        let store = ReleaseStore {
            offered_dir,
            state_dir: data_dir.join("agent-release"),
            keys,
            lock: Mutex::new(()),
            approved_cache: RwLock::new(None),
            initialized: AtomicBool::new(false),
            failures: Mutex::new(HashMap::new()),
            deferred_audit: Mutex::new(None),
        };
        // The one place the approved slot is read back from disk and checked
        // against the trusted keys: a key removed from release-keys.txt makes
        // the approved bundle unservable from the next start on.
        let loaded = store.load("approved").map(Arc::new);
        store.set_cache(loaded);
        store
    }

    fn set_cache(&self, entry: Option<Arc<(Bundle, Meta)>>) {
        if let Ok(mut slot) = self.approved_cache.write() {
            *slot = entry;
        }
    }

    /// Mirror the database marker into memory (start-up).
    fn set_initialized(&self, v: bool) {
        self.initialized.store(v, Ordering::SeqCst);
    }

    /// An approval happened here before, but nothing is servable now.
    fn approved_lost(&self) -> bool {
        self.initialized.load(Ordering::SeqCst) && self.approved().is_none()
    }

    pub(crate) fn trusted_keys(&self) -> usize {
        self.keys.len()
    }

    pub(crate) fn offered(&self) -> Offered {
        let main = self.offered_dir.join(OFFERED_STEM);
        if !main.exists() {
            return Offered::Missing;
        }
        match Bundle::read(&self.offered_dir, OFFERED_STEM) {
            Err(reason) => {
                let sha = fs::read(&main).ok().map(|b| sha256_hex(&b));
                Offered::Invalid {
                    sha,
                    version: None,
                    reason,
                }
            }
            Ok(b) if !b.signature_ok(&self.keys) => Offered::Invalid {
                sha: Some(b.sha.clone()),
                version: Some(b.version.clone()),
                reason: if self.keys.is_empty() {
                    "no release key is built into this hub".into()
                } else {
                    "the signature does not verify against a trusted release key".into()
                },
            },
            Ok(b) => Offered::Valid(b),
        }
    }

    fn load(&self, prefix: &str) -> Option<(Bundle, Meta)> {
        let meta: Value =
            serde_json::from_slice(&fs::read(self.state_dir.join(format!("{prefix}.json"))).ok()?)
                .ok()?;
        let meta = Meta::from_json(&meta)?;
        let bundle = Bundle::read(&self.state_dir, &format!("{prefix}.mjs")).ok()?;
        (bundle.sha == meta.sha && bundle.signature_ok(&self.keys)).then_some((bundle, meta))
    }

    /// The approved bundle, from memory (verified when it was loaded or
    /// written). A file that rots on the volume afterwards does not change what
    /// a running hub serves; the next start re-verifies it.
    pub(crate) fn approved(&self) -> Option<Arc<(Bundle, Meta)>> {
        self.approved_cache.read().ok()?.clone()
    }

    pub(crate) fn previous(&self) -> Option<(Bundle, Meta)> {
        let _g = self.lock.lock().ok()?;
        self.load("previous")
    }

    /// Write one slot. The manifest and signature go first and the `.json`
    /// that names the slot last; a reader that sees mismatching files treats
    /// the slot as empty (`load` checks hash and signature).
    fn put(&self, prefix: &str, b: &Bundle, meta: &Meta) -> Result<(), ReleaseError> {
        let io = ReleaseError::Io;
        fs::create_dir_all(&self.state_dir).map_err(|e| io(e.to_string()))?;
        let p = |suffix: &str| self.state_dir.join(format!("{prefix}.mjs{suffix}"));
        write_atomic(&p(".release"), b.manifest.as_bytes()).map_err(io)?;
        write_atomic(&p(".sig"), b.sig_b64.as_bytes()).map_err(io)?;
        write_atomic(&p(""), &b.bytes).map_err(io)?;
        write_atomic(
            &self.state_dir.join(format!("{prefix}.json")),
            meta.to_json().to_string().as_bytes(),
        )
        .map_err(io)
    }

    /// Approve the offered bundle `sha`. The current approved one becomes the
    /// rollback target. `now_ms` and `by` go into the record.
    pub(crate) fn approve(&self, sha: &str, by: &str, now_ms: i64) -> Result<Meta, ReleaseError> {
        let _g = self
            .lock
            .lock()
            .map_err(|_| ReleaseError::Io("lock".into()))?;
        let Offered::Valid(offered) = self.offered() else {
            return Err(ReleaseError::OfferChanged);
        };
        if offered.sha != sha {
            return Err(ReleaseError::OfferChanged);
        }
        let current = self.approved();
        if current.as_ref().is_some_and(|c| c.1.sha == offered.sha) {
            return Err(ReleaseError::AlreadyApproved);
        }
        if let Some(c) = &current {
            self.put("previous", &c.0, &c.1)?;
        }
        let meta = Meta {
            sha: offered.sha.clone(),
            version: offered.version.clone(),
            approved_by: by.to_string(),
            approved_at: now_ms,
        };
        self.put("approved", &offered, &meta)?;
        self.set_cache(Some(Arc::new((offered, meta.clone()))));
        self.initialized.store(true, Ordering::SeqCst);
        Ok(meta)
    }

    /// Swap approved and previous: the rolled-back-from bundle becomes the new
    /// previous, so a second rollback undoes the first.
    pub(crate) fn rollback(&self, by: &str, now_ms: i64) -> Result<Meta, ReleaseError> {
        let _g = self
            .lock
            .lock()
            .map_err(|_| ReleaseError::Io("lock".into()))?;
        let (prev, prev_meta) = self.load("previous").ok_or(ReleaseError::NoPrevious)?;
        let current = self.approved();
        let meta = Meta {
            approved_by: by.to_string(),
            approved_at: now_ms,
            ..prev_meta
        };
        self.put("approved", &prev, &meta)?;
        if let Some(c) = &current {
            self.put("previous", &c.0, &c.1)?;
        }
        self.set_cache(Some(Arc::new((prev, meta.clone()))));
        self.initialized.store(true, Ordering::SeqCst);
        Ok(meta)
    }

    /// First boot only: nothing was ever approved on this installation (no
    /// database marker AND no approved slot on disk), and the offered bundle is
    /// validly signed. A missing or damaged slot after a bundle HAS been
    /// approved is NOT first boot — it is reported (`status_json`), and nothing
    /// is approved behind the owner's back.
    pub(crate) fn auto_approve_first(&self, now_ms: i64) -> Option<Meta> {
        let ever = self.initialized.load(Ordering::SeqCst)
            || self.state_dir.join("approved.json").exists();
        if ever {
            return None;
        }
        let Offered::Valid(b) = self.offered() else {
            return None;
        };
        self.approve(&b.sha, "system", now_ms).ok()
    }

    /// Record a wrong code; `true` while the admin is still allowed to try.
    fn code_attempts_left(&self, user: &str, now_ms: i64) -> bool {
        let Ok(mut map) = self.failures.lock() else {
            return false;
        };
        let list = map.entry(user.to_string()).or_default();
        list.retain(|t| now_ms - t < CODE_FAILURE_WINDOW_MS);
        list.len() < MAX_CODE_FAILURES
    }

    fn note_code_failure(&self, user: &str, now_ms: i64) {
        if let Ok(mut map) = self.failures.lock() {
            map.entry(user.to_string()).or_default().push(now_ms);
        }
    }

    fn clear_code_failures(&self, user: &str) {
        if let Ok(mut map) = self.failures.lock() {
            map.remove(user);
        }
    }
}

// ------------------------------------------------------------ the one store

static STORE: OnceLock<ReleaseStore> = OnceLock::new();

pub(crate) fn store() -> Option<&'static ReleaseStore> {
    STORE.get()
}

/// Called once at start-up, external edition only.
pub(crate) fn init(db_path: &Path, workspaces: &WorkspaceStore, bootstrap_user_id: &str) {
    let offered = std::env::var("CC_REMOTE_AGENT_RELEASE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(DEFAULT_OFFERED_DIR));
    let data = std::env::var("CC_REMOTE_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            db_path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from("."))
        });
    let keys = parse_keys(RELEASE_KEYS_TXT);
    let st = ReleaseStore::new(offered.clone(), &data, keys);
    println!(
        "[agent-release] external edition: offered={} state={} trusted keys={}",
        offered.display(),
        st.state_dir.display(),
        st.trusted_keys()
    );
    let marked = workspaces
        .conn
        .lock()
        .map(|c| marker_present(&c))
        .unwrap_or(false);
    st.set_initialized(marked);
    if marked && st.approved().is_none() {
        eprintln!(
            "[agent-release] a bundle was approved here before but the approved copy is missing or damaged: nothing is served until the owner approves one"
        );
    }
    if let Some(meta) = st.auto_approve_first(now_ms()) {
        println!(
            "[agent-release] first boot: approved signed bundle {} ({})",
            &meta.sha[..12],
            meta.version
        );
        let event = json!({"sha": meta.sha, "version": meta.version});
        if !write_audit_for(
            workspaces,
            bootstrap_user_id,
            "system",
            "agent_release.auto_approve",
            &meta.sha,
            &event,
        ) {
            // No workspace yet on a fresh install: written at the first admin call.
            if let Ok(mut slot) = st.deferred_audit.lock() {
                *slot = Some(("agent_release.auto_approve".into(), event));
            }
        }
    }
    // An installation from before the marker (or a manual first approval):
    // whatever is approved now makes the marker permanent.
    if st.approved().is_some() {
        if let Ok(conn) = workspaces.conn.lock() {
            set_marker(&conn, now_ms());
        }
    }
    let _ = STORE.set(st);
}

fn marker_present(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM schema_meta WHERE key=?1)",
        [INITIALIZED_KEY],
        |r| r.get(0),
    )
    .unwrap_or(false)
}

/// Written once, never deleted: from now on an empty approved slot means
/// «lost», not «first boot».
fn set_marker(conn: &Connection, now_ms: i64) {
    let _ = conn.execute(
        "INSERT OR IGNORE INTO schema_meta(key,value) VALUES(?1,?2)",
        rusqlite::params![INITIALIZED_KEY, now_ms.to_string()],
    );
}

fn write_audit_for(
    workspaces: &WorkspaceStore,
    audit_user: &str,
    actor: &str,
    action: &str,
    target: &str,
    meta: &Value,
) -> bool {
    let Ok(conn) = workspaces.conn.lock() else {
        return false;
    };
    write_audit(&conn, audit_user, actor, action, target, meta)
}

fn write_audit(
    conn: &Connection,
    audit_user: &str,
    actor: &str,
    action: &str,
    target: &str,
    meta: &Value,
) -> bool {
    let Ok(Some(ws)) = crate::access::audit_workspace_in(conn, audit_user) else {
        return false;
    };
    crate::workspace::insert_audit(conn, &ws, actor, action, "agent_release", target, meta).is_ok()
}

// ------------------------------------------------------------------ serving

fn not_found() -> Response {
    api_error(StatusCode::NOT_FOUND, "no approved agent bundle")
}

/// `which`: "" (bundle), ".sha256", ".release", ".sig".
async fn serve(which: &'static str) -> Response {
    // From memory: no disk, no hashing, no signature check, no lock.
    let Some(approved) = store().and_then(ReleaseStore::approved) else {
        return not_found();
    };
    let b = &approved.0;
    match which {
        "" => public_download(
            b.bytes.clone(),
            "text/javascript; charset=utf-8",
            "agent.mjs",
        ),
        ".sha256" => public_download(
            format!("{}\n", b.sha),
            "text/plain; charset=utf-8",
            "agent.mjs.sha256",
        ),
        ".release" => public_download(
            b.manifest.clone(),
            "text/plain; charset=utf-8",
            "agent.mjs.release",
        ),
        _ => public_download(
            format!("{}\n", b.sig_b64.trim()),
            "text/plain; charset=utf-8",
            "agent.mjs.sig",
        ),
    }
}

/// `/install/agent.mjs` in the external edition. The caller checked the edition.
pub(crate) async fn serve_bundle() -> Response {
    serve("").await
}

pub(crate) async fn serve_sha256() -> Response {
    serve(".sha256").await
}

/// `/install/agent.mjs.release` — 404 on the internal hub.
pub(crate) async fn download_agent_release() -> Response {
    if !edition::is_external() {
        return api_error(StatusCode::NOT_FOUND, "not found");
    }
    serve(".release").await
}

/// `/install/agent.mjs.sig` — 404 on the internal hub.
pub(crate) async fn download_agent_sig() -> Response {
    if !edition::is_external() {
        return api_error(StatusCode::NOT_FOUND, "not found");
    }
    serve(".sig").await
}

// ---------------------------------------------------------------- admin API

/// Everything but the machines list: `approved`, `pending`, `previous`.
pub(crate) fn status_json(s: &ReleaseStore) -> Value {
    let approved = s.approved();
    let mut out = json!({"trustedKeys": s.trusted_keys()});
    if s.approved_lost() {
        // Installs 404 until the owner approves a bundle again.
        out["approvedLost"] = json!(true);
    }
    if let Some(m) = approved.as_deref().map(|a| &a.1) {
        out["approved"] = json!({
            "sha": m.sha, "version": m.version,
            "approvedAt": m.approved_at, "approvedBy": m.approved_by,
        });
    }
    let approved_sha = approved.as_ref().map(|a| a.0.sha.as_str());
    match s.offered() {
        Offered::Missing => {}
        Offered::Valid(b) if Some(b.sha.as_str()) == approved_sha => {}
        Offered::Valid(b) => {
            out["pending"] = json!({"sha": b.sha, "version": b.version, "signatureOk": true});
        }
        Offered::Invalid {
            sha,
            version,
            reason,
        } => {
            if sha.as_deref() != approved_sha {
                let mut p = json!({"signatureOk": false, "error": reason});
                if let Some(sha) = sha {
                    p["sha"] = json!(sha);
                }
                if let Some(v) = version {
                    p["version"] = json!(v);
                }
                out["pending"] = p;
            }
        }
    }
    if let Some((_, m)) = s.previous() {
        out["previous"] = json!({"sha": m.sha, "version": m.version});
    }
    out
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum GateError {
    /// The admin has no confirmed authenticator.
    NotEnrolled,
    /// Too many wrong codes recently.
    Throttled,
    WrongCode,
    Db(String),
}

/// The second factor for an approval or rollback: a confirmed authenticator,
/// not throttled, and a code `user_totp::verify` accepts (once per step).
pub(crate) fn check_code(
    s: &ReleaseStore,
    conn: &Connection,
    user: &str,
    code: &str,
    unix_secs: u64,
    now_ms: i64,
) -> Result<(), GateError> {
    if !crate::user_totp::is_enrolled(conn, user)
        .map_err(|e| GateError::Db(crate::workspace::db_err(e)))?
    {
        return Err(GateError::NotEnrolled);
    }
    if !s.code_attempts_left(user, now_ms) {
        return Err(GateError::Throttled);
    }
    match crate::user_totp::verify(conn, user, code, unix_secs) {
        Ok(true) => {
            s.clear_code_failures(user);
            Ok(())
        }
        Ok(false) => {
            s.note_code_failure(user, now_ms);
            Err(GateError::WrongCode)
        }
        Err(e) => Err(GateError::Db(crate::workspace::db_err(e))),
    }
}

#[track_caller]
fn gate_response(e: GateError) -> Response {
    match e {
        GateError::NotEnrolled => (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "authenticator_required",
                "message": "Сначала подключите приложение-аутентификатор в своём профиле: без него обновления агента подтвердить нельзя.",
            })),
        )
            .into_response(),
        GateError::Throttled => (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({"error": "too_many_attempts", "message": "Слишком много неверных кодов. Подождите 15 минут."})),
        )
            .into_response(),
        GateError::WrongCode => (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "invalid_code", "message": "Код не подошёл. Возьмите свежий код из приложения."})),
        )
            .into_response(),
        GateError::Db(e) => store_failure(e),
    }
}

#[track_caller]
fn release_error_response(e: ReleaseError) -> Response {
    match e {
        ReleaseError::OfferChanged => (
            StatusCode::CONFLICT,
            Json(json!({"error": "offer_changed", "message": "Предложенная сборка изменилась или не подписана. Обновите страницу."})),
        )
            .into_response(),
        ReleaseError::AlreadyApproved => (
            StatusCode::CONFLICT,
            Json(json!({"error": "already_approved", "message": "Эта сборка уже одобрена."})),
        )
            .into_response(),
        ReleaseError::NoPrevious => (
            StatusCode::CONFLICT,
            Json(json!({"error": "no_previous", "message": "Откатываться некуда: предыдущей сборки нет."})),
        )
            .into_response(),
        ReleaseError::Io(e) => internal_error(e),
    }
}

/// External edition + platform admin; the hub answers 404 on the internal one.
fn admin_gate(st: &AppState, actor: &str) -> Result<&'static ReleaseStore, Response> {
    let Some(store) = store().filter(|_| edition::is_external()) else {
        return Err(api_error(StatusCode::NOT_FOUND, "not found"));
    };
    if !st.platform_admins.contains(actor) {
        return Err(api_error(StatusCode::FORBIDDEN, "platform admin required"));
    }
    Ok(store)
}

fn actor_label(st: &AppState, actor: &str) -> String {
    st.workspaces
        .user_email(actor)
        .unwrap_or_else(|| actor.to_string())
}

async fn machines_json(st: &AppState) -> Vec<Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    st.hub.send(HubCmd::OnlineAgents { reply: tx });
    let online = rx.await.unwrap_or_default();
    let rows: Vec<(String, String, String)> = st
        .workspaces
        .conn
        .lock()
        .ok()
        .map(|conn| {
            conn.prepare(
                "SELECT machine_id,name,agent_version FROM devices WHERE revoked_at IS NULL ORDER BY name",
            )
            .and_then(|mut stmt| {
                stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                    .map(|rows| rows.filter_map(Result::ok).collect())
            })
            .unwrap_or_default()
        })
        .unwrap_or_default();
    rows.into_iter()
        .map(|(id, name, version)| {
            json!({"name": name, "agentVersion": version, "online": online.contains(&id)})
        })
        .collect()
}

/// `GET /api/admin/agent-release` →
/// `{approved?, pending?, previous?, machines, trustedKeys, authenticatorEnrolled}`.
pub(crate) async fn api_admin_agent_release(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let actor = gate!(authenticated_user(&headers, &st));
    let store = match admin_gate(&st, &actor) {
        Ok(s) => s,
        Err(e) => return e,
    };
    flush_deferred_audit(&st, store, &actor);
    let mut out = status_json(store);
    out["machines"] = Value::Array(machines_json(&st).await);
    out["authenticatorEnrolled"] = json!(st
        .workspaces
        .conn
        .lock()
        .ok()
        .and_then(|c| crate::user_totp::is_enrolled(&c, &actor).ok())
        .unwrap_or(false));
    Json(out).into_response()
}

fn flush_deferred_audit(st: &AppState, store: &ReleaseStore, actor: &str) {
    let pending = store.deferred_audit.lock().ok().and_then(|mut s| s.take());
    if let Some((action, meta)) = pending {
        let sha = meta["sha"].as_str().unwrap_or_default().to_string();
        if !write_audit_for(&st.workspaces, actor, "system", &action, &sha, &meta) {
            if let Ok(mut slot) = store.deferred_audit.lock() {
                *slot = Some((action, meta));
            }
        }
    }
}

/// The sync half of an approval. The database lock is taken twice and never
/// while waiting for the release store's lock: the code is checked in one scope
/// (which releases the connection), the files are swapped under the store's
/// lock only, and the audit row is written under a fresh connection lock. A
/// flood of approvals can therefore never hold up the rest of the hub.
fn approve_locked(
    st: &AppState,
    store: &ReleaseStore,
    actor: &str,
    sha: &str,
    code: &str,
) -> Result<(), Response> {
    let now = now_ms();
    // Before the connection lock: looking the address up takes it too.
    let label = actor_label(st, actor);
    check_actor_code(st, store, actor, code, now)?;
    let previous = store.approved().map(|a| a.1.sha.clone());
    let meta = store
        .approve(sha, &label, now)
        .map_err(release_error_response)?;
    mark_initialized(st);
    audit_release(
        st,
        actor,
        "agent_release.approve",
        &meta.sha,
        &json!({"version": meta.version, "previousSha": previous}),
    );
    println!(
        "[agent-release] {actor} approved {} ({})",
        &meta.sha[..12],
        meta.version
    );
    Ok(())
}

/// `check_code` in its own connection-lock scope.
fn check_actor_code(
    st: &AppState,
    store: &ReleaseStore,
    actor: &str,
    code: &str,
    now: i64,
) -> Result<(), Response> {
    let Ok(conn) = st.workspaces.conn.lock() else {
        return Err(api_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "database lock poisoned",
        ));
    };
    check_code(store, &conn, actor, code, totp::now_secs(), now).map_err(gate_response)
}

fn mark_initialized(st: &AppState) {
    if let Ok(conn) = st.workspaces.conn.lock() {
        set_marker(&conn, now_ms());
    }
}

fn audit_release(st: &AppState, actor: &str, action: &str, target: &str, meta: &Value) {
    if let Ok(conn) = st.workspaces.conn.lock() {
        write_audit(&conn, actor, actor, action, target, meta);
    }
}

fn rollback_locked(
    st: &AppState,
    store: &ReleaseStore,
    actor: &str,
    code: &str,
) -> Result<(), Response> {
    let now = now_ms();
    let label = actor_label(st, actor);
    check_actor_code(st, store, actor, code, now)?;
    let from = store.approved().map(|a| a.1.sha.clone());
    let meta = store
        .rollback(&label, now)
        .map_err(release_error_response)?;
    mark_initialized(st);
    audit_release(
        st,
        actor,
        "agent_release.rollback",
        &meta.sha,
        &json!({"version": meta.version, "fromSha": from}),
    );
    println!(
        "[agent-release] {actor} rolled back to {} ({})",
        &meta.sha[..12],
        meta.version
    );
    Ok(())
}

async fn status_with_machines(st: &AppState, store: &ReleaseStore) -> Response {
    let mut out = status_json(store);
    out["machines"] = Value::Array(machines_json(st).await);
    Json(out).into_response()
}

/// `POST /api/admin/agent-release/approve {sha, code}` → the new status.
pub(crate) async fn api_admin_agent_release_approve(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let actor = gate!(mutation_user(&headers, &st));
    let store = match admin_gate(&st, &actor) {
        Ok(s) => s,
        Err(e) => return e,
    };
    gate!(require_active(&st, &actor));
    let sha = body.get("sha").and_then(Value::as_str).unwrap_or_default();
    let code = body.get("code").and_then(Value::as_str).unwrap_or_default();
    // Look before spending a one-time code on a request that cannot succeed.
    match store.offered() {
        Offered::Valid(b) if b.sha == sha => {}
        _ => return release_error_response(ReleaseError::OfferChanged),
    }
    let (job_st, job_actor, job_sha, job_code) =
        (st.clone(), actor.clone(), sha.to_string(), code.to_string());
    match tokio::task::spawn_blocking(move || {
        approve_locked(&job_st, store, &job_actor, &job_sha, &job_code)
    })
    .await
    {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return e,
        Err(_) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, "approval failed"),
    }
    status_with_machines(&st, store).await
}

/// `POST /api/admin/agent-release/rollback {code}` → the new status.
pub(crate) async fn api_admin_agent_release_rollback(
    State(st): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let actor = gate!(mutation_user(&headers, &st));
    let store = match admin_gate(&st, &actor) {
        Ok(s) => s,
        Err(e) => return e,
    };
    gate!(require_active(&st, &actor));
    let code = body.get("code").and_then(Value::as_str).unwrap_or_default();
    if store.previous().is_none() {
        return release_error_response(ReleaseError::NoPrevious);
    }
    let (job_st, job_actor, job_code) = (st.clone(), actor.clone(), code.to_string());
    match tokio::task::spawn_blocking(move || {
        rollback_locked(&job_st, store, &job_actor, &job_code)
    })
    .await
    {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return e,
        Err(_) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, "rollback failed"),
    }
    status_with_machines(&st, store).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::rand::SystemRandom;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    struct Signer(Ed25519KeyPair);

    impl Signer {
        fn new() -> Signer {
            let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
            Signer(Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap())
        }
        fn key(&self) -> [u8; 32] {
            self.0.public_key().as_ref().try_into().unwrap()
        }
        fn key_line(&self) -> String {
            let mut der = SPKI_PREFIX.to_vec();
            der.extend_from_slice(&self.key());
            B64.encode(der)
        }
        /// Write the three files the image would carry.
        fn release(&self, dir: &Path, stem: &str, body: &[u8], version: &str) {
            fs::create_dir_all(dir).unwrap();
            let manifest = format!(
                "hegai-code-agent-release/1\nedition=external\nversion={version}\nsha256={}\n",
                sha256_hex(body)
            );
            fs::write(dir.join(stem), body).unwrap();
            fs::write(dir.join(format!("{stem}.release")), &manifest).unwrap();
            let sig = B64.encode(self.0.sign(manifest.as_bytes()).as_ref());
            fs::write(dir.join(format!("{stem}.sig")), format!("{sig}\n")).unwrap();
        }
    }

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("agent-release-{}", Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn rig(signer: &Signer) -> (ReleaseStore, PathBuf, PathBuf) {
        let (offered, data) = (tmp(), tmp());
        (
            ReleaseStore::new(offered.clone(), &data, vec![signer.key()]),
            offered,
            data,
        )
    }

    #[test]
    fn keys_file_parsing_skips_comments_and_garbage() {
        let s = Signer::new();
        let text = format!(
            "# comment\n\n{}\nnot base64!!\nAAAA\n  # indented comment\n",
            s.key_line()
        );
        assert_eq!(parse_keys(&text), vec![s.key()]);
        assert!(parse_keys("# only comments\n").is_empty());
        // The shipped file must parse (it may hold no key yet).
        let _ = parse_keys(RELEASE_KEYS_TXT);
    }

    #[test]
    fn manifest_parsing_is_canonical_only() {
        let sha = "a".repeat(64);
        let ok =
            format!("hegai-code-agent-release/1\nedition=external\nversion=0.3.4\nsha256={sha}\n");
        assert_eq!(parse_manifest(&ok), Some(("0.3.4".into(), sha.clone())));
        assert_eq!(parse_manifest(&ok.replace('\n', "\r\n")), None);
        assert_eq!(parse_manifest(ok.trim_end()), None);
        assert_eq!(parse_manifest(&format!("{ok}extra=1\n")), None);
        assert_eq!(parse_manifest(&ok.replace(&sha, &"A".repeat(64))), None);
        assert_eq!(parse_manifest(&ok.replace("/1", "/2")), None);
        // the edition line is mandatory and must say external
        assert_eq!(
            parse_manifest(&ok.replace("edition=external", "edition=internal")),
            None
        );
        assert_eq!(parse_manifest(&ok.replace("edition=external\n", "")), None);
        assert_eq!(
            parse_manifest(&ok.replace("edition=external", "edition=external\nedition=external")),
            None
        );
    }

    #[test]
    fn first_boot_approves_a_signed_bundle_and_serves_it() {
        let s = Signer::new();
        let (store, offered, _d) = rig(&s);
        s.release(&offered, OFFERED_STEM, b"agent v1", "0.3.4");
        assert!(store.approved().is_none());
        let meta = store.auto_approve_first(100).expect("auto-approved");
        assert_eq!(meta.approved_by, "system");
        let approved = store.approved().unwrap();
        assert_eq!(&approved.0.bytes[..], b"agent v1");
        assert_eq!(approved.1.version, "0.3.4");
        // A second boot changes nothing.
        assert!(store.auto_approve_first(200).is_none());
        let st = status_json(&store);
        assert_eq!(st["approved"]["sha"], sha256_hex(b"agent v1"));
        assert!(st.get("pending").is_none());
        assert!(st.get("previous").is_none());
    }

    #[test]
    fn an_unsigned_or_wrongly_signed_bundle_is_never_offered_as_valid() {
        let s = Signer::new();
        let stranger = Signer::new();
        let (store, offered, _d) = rig(&s);
        // Signed by a key the hub does not trust.
        stranger.release(&offered, OFFERED_STEM, b"evil", "9.9.9");
        assert!(matches!(store.offered(), Offered::Invalid { .. }));
        assert!(store.auto_approve_first(1).is_none());
        assert!(store.approved().is_none());
        let st = status_json(&store);
        assert_eq!(st["pending"]["signatureOk"], false);
        assert_eq!(st["pending"]["sha"], sha256_hex(b"evil"));
        assert_eq!(
            store.approve(&sha256_hex(b"evil"), "me", 1),
            Err(ReleaseError::OfferChanged)
        );
        // Signature files missing altogether.
        fs::remove_file(offered.join("agent-external.mjs.sig")).unwrap();
        assert!(matches!(store.offered(), Offered::Invalid { .. }));
        assert!(store.auto_approve_first(1).is_none());
        // Bundle bytes changed after signing.
        s.release(&offered, OFFERED_STEM, b"good", "1.0.0");
        fs::write(offered.join(OFFERED_STEM), b"tampered").unwrap();
        assert!(matches!(store.offered(), Offered::Invalid { .. }));
        // No directory at all.
        let empty = ReleaseStore::new(tmp(), &tmp(), vec![s.key()]);
        assert!(matches!(empty.offered(), Offered::Missing));
        assert!(status_json(&empty).get("pending").is_none());
    }

    #[test]
    fn a_hub_with_no_key_trusts_nothing() {
        let s = Signer::new();
        let (offered, data) = (tmp(), tmp());
        let store = ReleaseStore::new(offered.clone(), &data, vec![]);
        s.release(&offered, OFFERED_STEM, b"agent", "1");
        assert!(store.auto_approve_first(1).is_none());
        assert!(store.approved().is_none());
    }

    #[test]
    fn a_newer_bundle_is_pending_until_approved_and_rollback_swaps_back() {
        let s = Signer::new();
        let (store, offered, _d) = rig(&s);
        s.release(&offered, OFFERED_STEM, b"v1", "1");
        store.auto_approve_first(1).unwrap();
        s.release(&offered, OFFERED_STEM, b"v2", "2");
        // Still serving v1; v2 pending.
        assert_eq!(&store.approved().unwrap().0.bytes[..], b"v1");
        let st = status_json(&store);
        assert_eq!(st["pending"]["sha"], sha256_hex(b"v2"));
        assert_eq!(st["pending"]["signatureOk"], true);
        // A stale sha (the offer changed under the admin) is refused.
        assert_eq!(
            store.approve(&sha256_hex(b"v3"), "me", 2),
            Err(ReleaseError::OfferChanged)
        );
        assert_eq!(&store.approved().unwrap().0.bytes[..], b"v1");
        let m = store.approve(&sha256_hex(b"v2"), "owner@x", 3).unwrap();
        assert_eq!(
            (m.version.as_str(), m.approved_by.as_str()),
            ("2", "owner@x")
        );
        assert_eq!(&store.approved().unwrap().0.bytes[..], b"v2");
        assert_eq!(&store.previous().unwrap().0.bytes[..], b"v1");
        assert_eq!(
            store.approve(&sha256_hex(b"v2"), "me", 4),
            Err(ReleaseError::AlreadyApproved)
        );
        // The offer equals the approved one: nothing pending.
        assert!(status_json(&store).get("pending").is_none());
        // Rollback to v1; v2 is the new previous, and v2 is offered again => pending.
        let r = store.rollback("owner@x", 5).unwrap();
        assert_eq!(r.version, "1");
        assert_eq!(&store.approved().unwrap().0.bytes[..], b"v1");
        assert_eq!(&store.previous().unwrap().0.bytes[..], b"v2");
        assert_eq!(status_json(&store)["pending"]["sha"], sha256_hex(b"v2"));
        // And back.
        store.rollback("owner@x", 6).unwrap();
        assert_eq!(&store.approved().unwrap().0.bytes[..], b"v2");
    }

    #[test]
    fn rollback_without_a_previous_bundle_is_refused() {
        let s = Signer::new();
        let (store, offered, _d) = rig(&s);
        s.release(&offered, OFFERED_STEM, b"v1", "1");
        store.auto_approve_first(1).unwrap();
        assert_eq!(store.rollback("me", 2), Err(ReleaseError::NoPrevious));
    }

    #[test]
    fn a_damaged_approved_slot_is_not_served_after_a_restart_and_does_not_re_approve() {
        let s = Signer::new();
        let (store, offered, data) = rig(&s);
        s.release(&offered, OFFERED_STEM, b"v1", "1");
        store.auto_approve_first(1).unwrap();
        fs::write(data.join("agent-release/approved.mjs"), b"rotten").unwrap();
        // The running hub serves what it verified when it was written…
        assert_eq!(&store.approved().unwrap().0.bytes[..], b"v1");
        // …the next start re-verifies the slot and finds it rotten.
        let restarted = ReleaseStore::new(offered, &data, vec![s.key()]);
        assert!(restarted.approved().is_none(), "never served");
        assert!(restarted.auto_approve_first(2).is_none(), "not first boot");
    }

    #[test]
    fn serving_reads_memory_only_and_a_removed_key_unserves_at_the_next_start() {
        let s = Signer::new();
        let (store, offered, data) = rig(&s);
        s.release(&offered, OFFERED_STEM, b"v1", "1");
        store.auto_approve_first(1).unwrap();
        // Take every file away: a request still costs no disk access.
        fs::remove_dir_all(data.join("agent-release")).unwrap();
        fs::remove_dir_all(&offered).unwrap();
        let (a, b) = (store.approved().unwrap(), store.approved().unwrap());
        assert!(Arc::ptr_eq(&a, &b), "one shared copy, not a re-read");
        assert_eq!(&a.0.bytes[..], b"v1");
        // A key dropped from release-keys.txt: the approved bundle is
        // unservable once the hub restarts (it re-verifies at load).
        let (store, offered, data) = rig(&s);
        s.release(&offered, OFFERED_STEM, b"v1", "1");
        store.auto_approve_first(1).unwrap();
        let other = Signer::new();
        assert!(ReleaseStore::new(offered, &data, vec![other.key()])
            .approved()
            .is_none());
    }

    #[test]
    fn a_lost_approved_slot_after_an_approval_is_never_a_first_boot() {
        let s = Signer::new();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT);")
            .unwrap();
        assert!(!marker_present(&conn));
        let (store, offered, data) = rig(&s);
        s.release(&offered, OFFERED_STEM, b"v1", "1");
        store.auto_approve_first(1).unwrap();
        set_marker(&conn, 1);
        set_marker(&conn, 2); // idempotent, keeps the first value
        assert!(marker_present(&conn));
        // The volume's release directory is gone (DB restored without it), or
        // approved.json was deleted / corrupted: the marker says «not first».
        for damage in ["wipe", "delete-json", "corrupt-json"] {
            let (store, offered, data) = rig(&s);
            s.release(&offered, OFFERED_STEM, b"v1", "1");
            store.auto_approve_first(1).unwrap();
            match damage {
                "wipe" => fs::remove_dir_all(data.join("agent-release")).unwrap(),
                "delete-json" => fs::remove_file(data.join("agent-release/approved.json")).unwrap(),
                _ => fs::write(data.join("agent-release/approved.json"), b"{").unwrap(),
            }
            let restarted = ReleaseStore::new(offered, &data, vec![s.key()]);
            restarted.set_initialized(marker_present(&conn));
            assert!(
                restarted.auto_approve_first(9).is_none(),
                "{damage}: no auto-approval"
            );
            assert!(restarted.approved().is_none(), "{damage}: nothing served");
            let st = status_json(&restarted);
            assert_eq!(st["approvedLost"], true, "{damage}");
            assert_eq!(
                st["pending"]["signatureOk"], true,
                "{damage}: owner can approve"
            );
            // the owner's approval restores service and clears the flag
            restarted.approve(&sha256_hex(b"v1"), "owner", 10).unwrap();
            assert!(restarted.approved().is_some());
            assert!(status_json(&restarted).get("approvedLost").is_none());
        }
        // No marker and no files: a genuine first boot still auto-approves.
        let fresh = ReleaseStore::new(offered.clone(), &tmp(), vec![s.key()]);
        fresh.set_initialized(false);
        assert!(fresh.auto_approve_first(1).is_some());
        let _ = (store, data);
    }

    #[test]
    fn approve_and_rollback_refresh_what_is_served() {
        let s = Signer::new();
        let (store, offered, data) = rig(&s);
        s.release(&offered, OFFERED_STEM, b"v1", "1");
        store.auto_approve_first(1).unwrap();
        s.release(&offered, OFFERED_STEM, b"v2", "2");
        store.approve(&sha256_hex(b"v2"), "me", 2).unwrap();
        assert_eq!(&store.approved().unwrap().0.bytes[..], b"v2");
        store.rollback("me", 3).unwrap();
        assert_eq!(&store.approved().unwrap().0.bytes[..], b"v1");
        // and what is on disk agrees after a restart
        let restarted = ReleaseStore::new(offered, &data, vec![s.key()]);
        assert_eq!(&restarted.approved().unwrap().0.bytes[..], b"v1");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_approval_waiting_for_the_store_does_not_hold_the_database() {
        use crate::account::tests::{app_state, cleanup, temp_db};
        let s = Signer::new();
        let (store, offered, _d) = rig(&s);
        let store: &'static ReleaseStore = Box::leak(Box::new(store));
        s.release(&offered, OFFERED_STEM, b"v1", "1");
        store.auto_approve_first(1).unwrap();
        s.release(&offered, OFFERED_STEM, b"v2", "2");
        let db = temp_db();
        let ws = WorkspaceStore::open(&db).unwrap();
        ws.ensure_user("admin", "admin@x.test", None).unwrap();
        let t = totp::now_secs();
        let secret = ws.with_conn_for_tests(|c| {
            crate::user_totp::init_schema(c).unwrap();
            crate::user_totp::begin(c, "admin").unwrap()
        });
        let raw = totp::base32_decode(&secret).unwrap();
        let code = |at: u64| format!("{:06}", totp::code_at(&raw, totp::step_of(at)));
        // Enrolled one step ago, so the current step's code is still fresh.
        ws.with_conn_for_tests(|c| {
            crate::user_totp::confirm(c, "admin", &code(t - 30), t - 30)
                .unwrap()
                .unwrap()
        });
        let st = app_state(ws, &db);
        // Somebody else (a slow approval, a flood) holds the store's lock.
        let guard = store.lock.lock().unwrap();
        let job_st = st.clone();
        let (sha, fresh) = (sha256_hex(b"v2"), code(t));
        let job = std::thread::spawn(move || approve_locked(&job_st, store, "admin", &sha, &fresh));
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(
            st.workspaces.conn.try_lock().is_ok(),
            "the connection is free while the approval waits for the store"
        );
        assert!(
            store.approved().is_some(),
            "and serving does not wait either"
        );
        drop(guard);
        assert!(job.join().unwrap().is_ok());
        assert_eq!(&store.approved().unwrap().0.bytes[..], b"v2");
        cleanup(&db);
    }

    #[test]
    fn approvals_need_an_authenticator_a_fresh_code_and_are_throttled() {
        let s = Signer::new();
        let (store, _o, _d) = rig(&s);
        let conn = Connection::open_in_memory().unwrap();
        crate::user_totp::init_schema(&conn).unwrap();
        let t = 1_800_000_000u64;
        // No authenticator: refused with its own error.
        assert_eq!(
            check_code(&store, &conn, "u", "123456", t, 0),
            Err(GateError::NotEnrolled)
        );
        let secret = crate::user_totp::begin(&conn, "u").unwrap();
        // Unconfirmed enrolment does not count.
        assert_eq!(
            check_code(&store, &conn, "u", "123456", t, 0),
            Err(GateError::NotEnrolled)
        );
        let raw = totp::base32_decode(&secret).unwrap();
        let code = |at: u64| format!("{:06}", totp::code_at(&raw, totp::step_of(at)));
        crate::user_totp::confirm(&conn, "u", &code(t), t)
            .unwrap()
            .unwrap();
        // The enrolment code is spent; the next step's is fresh.
        assert_eq!(
            check_code(&store, &conn, "u", &code(t), t, 0),
            Err(GateError::WrongCode)
        );
        assert_eq!(
            check_code(&store, &conn, "u", &code(t + 30), t + 30, 0),
            Ok(())
        );
        assert_eq!(
            check_code(&store, &conn, "u", &code(t + 30), t + 30, 0),
            Err(GateError::WrongCode),
            "replay"
        );
        // Five wrong codes (the two above count) pause approvals, even for a right one.
        for _ in 0..3 {
            let _ = check_code(&store, &conn, "u", "000000", t + 60, 1);
        }
        // A success clears the counter, so lock it with fresh failures.
        for _ in 0..MAX_CODE_FAILURES {
            store.note_code_failure("u", 10);
        }
        assert_eq!(
            check_code(&store, &conn, "u", &code(t + 90), t + 90, 11),
            Err(GateError::Throttled)
        );
        // After the window it works again.
        assert_eq!(
            check_code(
                &store,
                &conn,
                "u",
                &code(t + 120),
                t + 120,
                10 + CODE_FAILURE_WINDOW_MS + 1
            ),
            Ok(())
        );
    }
}
