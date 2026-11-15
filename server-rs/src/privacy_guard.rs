//! An independent high-water mark makes restoring a pre-erasure DB fail closed.
//! Keep this file outside database backups; never roll it back with the database.
use crate::workspace::{db_err, WorkspaceStore};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Debug, PartialEq)]
struct Watermark {
    database_id: String,
    revision: i64,
}

fn current(c: &Connection) -> Result<Watermark, String> {
    c.query_row(
        "SELECT g.database_id,p.revision FROM privacy_database g CROSS JOIN privacy_generation p WHERE g.singleton=1 AND p.singleton=1",
        [], |r| Ok(Watermark { database_id: r.get(0)?, revision: r.get(1)? }),
    ).map_err(db_err)
}

fn read(path: &Path) -> Result<Watermark, String> {
    validate_directory(path)?;
    let metadata =
        std::fs::symlink_metadata(path).map_err(|_| "privacy watermark missing or unreadable")?;
    if !metadata.is_file() {
        return Err("privacy watermark must be a regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if !trusted_owner(metadata.uid()) || metadata.mode() & 0o022 != 0 {
            return Err("privacy watermark has an untrusted owner or permissions".into());
        }
    }
    let bytes = std::fs::read(path).map_err(|_| "privacy watermark missing or unreadable")?;
    let value: Watermark =
        serde_json::from_slice(&bytes).map_err(|_| "invalid privacy watermark")?;
    if value.database_id.is_empty() || value.revision < 0 {
        return Err("invalid privacy watermark".into());
    }
    Ok(value)
}

#[cfg(unix)]
fn trusted_owner(uid: u32) -> bool {
    // SAFETY: geteuid has no arguments or memory-safety preconditions.
    uid == 0 || uid == unsafe { libc::geteuid() }
}

fn validate_directory(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("privacy watermark requires an absolute path without parent traversal".into());
    }
    let direct_parent = parent(path)?;
    for dir in direct_parent.ancestors() {
        let metadata =
            std::fs::symlink_metadata(dir).map_err(|_| "privacy watermark ancestor unreadable")?;
        if !metadata.is_dir() {
            return Err(
                "privacy watermark ancestors must be real directories, not symlinks".into(),
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            // A root-owned sticky ancestor such as /tmp cannot be used by
            // another UID to replace our owned child. Never allow it as the
            // direct parent, where the watermark itself would be exposed.
            let sticky_root =
                dir != direct_parent && metadata.uid() == 0 && metadata.mode() & 0o1000 != 0;
            if !trusted_owner(metadata.uid()) || (metadata.mode() & 0o022 != 0 && !sticky_root) {
                return Err(
                    "privacy watermark ancestor has an untrusted owner or permissions".into(),
                );
            }
        }
    }
    Ok(())
}

fn write_new(path: &Path, value: &Watermark) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "cannot create privacy watermark")?;
    let bytes = serde_json::to_vec(value).map_err(|_| "cannot encode privacy watermark")?;
    file.write_all(&bytes)
        .map_err(|_| "cannot write privacy watermark")?;
    file.sync_all()
        .map_err(|_| "cannot sync privacy watermark".into())
}

fn parent(path: &Path) -> Result<&Path, String> {
    path.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "privacy watermark requires an absolute path".into())
}

fn sync_parent(path: &Path) -> Result<(), String> {
    File::open(parent(path)?)
        .and_then(|f| f.sync_all())
        .map_err(|_| "cannot sync privacy watermark directory".into())
}

pub(crate) fn init_schema(c: &Connection) -> Result<(), String> {
    c.execute_batch("CREATE TABLE IF NOT EXISTS privacy_database(singleton INTEGER PRIMARY KEY CHECK(singleton=1), database_id TEXT NOT NULL);").map_err(db_err)?;
    c.execute(
        "INSERT OR IGNORE INTO privacy_database VALUES(1,?1)",
        params![uuid::Uuid::new_v4().to_string()],
    )
    .map_err(db_err)?;
    Ok(())
}

impl WorkspaceStore {
    /// One-time operator bootstrap, before enabling the startup requirement.
    /// Refuses to replace an existing watermark, including a corrupt one.
    pub(crate) fn initialize_privacy_guard(&self, path: &Path) -> Result<(), String> {
        validate_directory(path)?;
        let c = self.conn.lock().map_err(|_| "database lock poisoned")?;
        let tx = c.unchecked_transaction().map_err(db_err)?;
        // Obtain the writer lock so a deletion cannot race this baseline.
        tx.execute("UPDATE privacy_generation SET revision=revision", [])
            .map_err(db_err)?;
        write_new(path, &current(&tx)?)?;
        sync_parent(path)?;
        tx.commit().map_err(db_err)
    }

    /// Called before starting the hub actor or opening any listening socket.
    pub(crate) fn enable_privacy_guard(&mut self, path: PathBuf) -> Result<(), String> {
        if !path.is_absolute() {
            return Err("privacy watermark requires an absolute path".into());
        }
        let c = self.conn.lock().map_err(|_| "database lock poisoned")?;
        let db = current(&c)?;
        let mark = read(&path)?;
        if mark.database_id != db.database_id || mark.revision != db.revision {
            return Err(
                "database privacy watermark mismatch; refusing possible pre-erasure restore".into(),
            );
        }
        self.privacy_guard = Some(path);
        Ok(())
    }

    /// Persist BEFORE the SQL commit: a crash may conservatively refuse startup,
    /// but must never acknowledge erasure while leaving a stale restore gate.
    /// The caller holds the store writer lock/transaction across this operation.
    pub(crate) fn advance_privacy_guard(&self, c: &Connection) -> Result<(), String> {
        let Some(path) = &self.privacy_guard else {
            return Ok(());
        };
        let next = current(c)?;
        let previous = read(path)?;
        if previous.database_id != next.database_id || next.revision < previous.revision {
            return Err("privacy watermark would move backwards".into());
        }
        let temp = parent(path)?.join(format!(".privacy-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            write_new(&temp, &next)?;
            std::fs::rename(&temp, path).map_err(|_| "cannot replace privacy watermark")?;
            sync_parent(path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temp);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Fixture {
        dir: PathBuf,
        db: PathBuf,
        mark: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir()
                .canonicalize()
                .unwrap()
                .join(format!("privacy-guard-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&dir).unwrap();
            // The guard refuses a group/world-writable directory, so the
            // fixture must not depend on the caller's umask.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
            }
            Self {
                db: dir.join("hub.sqlite3"),
                mark: dir.join("guard.json"),
                dir,
            }
        }
        fn open(&self) -> WorkspaceStore {
            WorkspaceStore::open(&self.db).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn old_backup_cannot_resurrect_deleted_account_or_credentials() {
        let f = Fixture::new();
        let mut store = f.open();
        store
            .ensure_user("alice", "alice@example.test", None)
            .unwrap();
        store.ensure_user("bob", "bob@example.test", None).unwrap();
        store.create_auth_session("alice", 30).unwrap();
        store.initialize_privacy_guard(&f.mark).unwrap();
        store.enable_privacy_guard(f.mark.clone()).unwrap();
        let backup = f.dir.join("before.sqlite3");
        store.with_conn_for_tests(|c| {
            c.execute("VACUUM INTO ?1", [backup.to_str().unwrap()])
                .unwrap()
        });
        store.request_account_deletion("alice", &json!([])).unwrap();
        store.erase_account("alice").unwrap();
        assert_eq!(read(&f.mark).unwrap().revision, 2);
        store.with_conn_for_tests(|c| {
            assert_eq!(
                c.query_row("SELECT count(*) FROM users WHERE user_id='bob'", [], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap(),
                1
            );
            assert_eq!(
                c.query_row(
                    "SELECT count(*) FROM users WHERE user_id='alice'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                0
            );
        });
        drop(store);
        let mut reopened = f.open();
        reopened.enable_privacy_guard(f.mark.clone()).unwrap();
        drop(reopened);
        std::fs::copy(backup, &f.db).unwrap();
        let mut restored = f.open();
        assert!(restored
            .enable_privacy_guard(f.mark.clone())
            .unwrap_err()
            .contains("mismatch"));
    }

    #[test]
    fn missing_corrupt_and_foreign_watermarks_fail_closed() {
        let f = Fixture::new();
        let mut s = f.open();
        assert!(s.enable_privacy_guard(f.mark.clone()).is_err());
        s.initialize_privacy_guard(&f.mark).unwrap();
        assert!(s.initialize_privacy_guard(&f.mark).is_err());
        let other = Fixture::new();
        assert!(other.open().enable_privacy_guard(f.mark.clone()).is_err());
        std::fs::write(&f.mark, b"broken").unwrap();
        assert!(s.enable_privacy_guard(f.mark.clone()).is_err());
    }

    #[test]
    fn missing_watermark_during_deletion_rolls_back_request() {
        let f = Fixture::new();
        let mut s = f.open();
        s.ensure_user("alice", "alice@example.test", None).unwrap();
        s.initialize_privacy_guard(&f.mark).unwrap();
        s.enable_privacy_guard(f.mark.clone()).unwrap();
        std::fs::remove_file(&f.mark).unwrap();
        assert!(s.request_account_deletion("alice", &json!([])).is_err());
        assert!(!s.deletion_pending("alice").unwrap());
    }

    #[test]
    fn crash_after_watermark_before_sql_commit_refuses_startup() {
        let f = Fixture::new();
        let mut s = f.open();
        s.initialize_privacy_guard(&f.mark).unwrap();
        s.enable_privacy_guard(f.mark.clone()).unwrap();
        s.with_conn_for_tests(|c| {
            let tx = c.unchecked_transaction().unwrap();
            tx.execute("UPDATE privacy_generation SET revision=revision+1", [])
                .unwrap();
            s.advance_privacy_guard(&tx).unwrap();
            // Dropping the transaction models a failed commit/crash.
        });
        drop(s);
        assert!(f.open().enable_privacy_guard(f.mark.clone()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_writable_parent_and_symlink_ancestors() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let f = Fixture::new();
        let s = f.open();
        std::fs::set_permissions(&f.dir, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(s.initialize_privacy_guard(&f.mark).is_err());
        assert!(!f.mark.exists());
        std::fs::set_permissions(&f.dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        s.initialize_privacy_guard(&f.mark).unwrap();
        let alias = f.dir.join("alias");
        symlink(&f.dir, &alias).unwrap();
        assert!(read(&alias.join("guard.json")).is_err());
        let file_alias = f.dir.join("alias.json");
        symlink(&f.mark, &file_alias).unwrap();
        assert!(read(&file_alias).is_err());
    }
}
