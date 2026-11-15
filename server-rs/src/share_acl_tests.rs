//! The list on a share (`project_share_members`): none = the whole team as
//! before, any = only the people on it (plus the workspace owner and the
//! device owner). The hub-level consequences (starting, reading files,
//! session visibility) are in `hub/tests.rs`; the HTTP side is in
//! `service_api.rs`.

use rusqlite::params;
use serde_json::json;

use crate::workspace::WorkspaceStore;

/// Team with owner `boss` (also the device owner of `box`), and members
/// `ann`, `bob`, `cat`. Returns the store and the workspace id.
fn team() -> (WorkspaceStore, String) {
    let s = WorkspaceStore::open_memory();
    s.ensure_user("boss", "boss@x", Some("Boss")).unwrap();
    let w = s.create_organization("boss", "Team", "boss").unwrap();
    let wid = w["workspaceId"].as_str().unwrap().to_string();
    for (id, name) in [("ann", "Anna"), ("bob", "Bob"), ("cat", "Cat")] {
        s.ensure_user(id, &format!("{id}@x"), Some(name)).unwrap();
        let invite = s
            .invite("boss", &wid, &format!("{id}@x"), "member")
            .unwrap();
        s.accept_invitation(id, invite["token"].as_str().unwrap())
            .unwrap();
    }
    s.register_legacy_device(
        "boss",
        &json!({"machineId":"box","name":"Box","os":"linux","agentVersion":"1"}),
    )
    .unwrap();
    (s, wid)
}

/// Restrict the share and make `users` exactly its list.
fn set_list(s: &WorkspaceStore, share_id: &str, users: &[&str]) {
    s.with_conn_for_tests(|c| {
        c.execute(
            "UPDATE project_shares SET restricted=1 WHERE project_share_id=?1",
            params![share_id],
        )
        .unwrap();
        c.execute(
            "DELETE FROM project_share_members WHERE project_share_id=?1",
            params![share_id],
        )
        .unwrap();
        for u in users {
            c.execute(
                "INSERT INTO project_share_members VALUES(?1,?2,'member',1)",
                params![share_id, u],
            )
            .unwrap();
        }
    });
}

fn roots(s: &WorkspaceStore, wid: &str, user: &str) -> Option<Vec<String>> {
    let a = s.ui_access(user, Some(wid), false).unwrap();
    let m = s.machine_access(&a, "box").unwrap();
    if m.can_view {
        m.roots
    } else {
        None
    }
}

#[test]
fn a_listed_user_gets_in_and_an_unlisted_member_does_not() {
    let (s, wid) = team();
    let share = s
        .share_project("boss", &wid, "box", "/p/case1", "Case", "control", "team")
        .unwrap();
    let id = share["projectShareId"].as_str().unwrap().to_string();
    // No list: the whole team, as always.
    assert_eq!(roots(&s, &wid, "ann"), Some(vec!["/p/case1".into()]));
    assert_eq!(roots(&s, &wid, "bob"), Some(vec!["/p/case1".into()]));

    set_list(&s, &id, &["ann"]);
    let ann = s.ui_access("ann", Some(&wid), false).unwrap();
    let a = s.machine_access(&ann, "box").unwrap();
    assert!(a.can_view && a.can_start && !a.can_control);
    // A listed share is a room: the device owner's sessions are shown too.
    assert_eq!(a.open_roots, vec!["/p/case1".to_string()]);
    let bob = s.ui_access("bob", Some(&wid), false).unwrap();
    let b = s.machine_access(&bob, "box").unwrap();
    assert!(!b.can_view && !b.can_start && b.roots.is_none());
    // The device owner is not on the list and still gets everything.
    let boss = s.ui_access("boss", Some(&wid), false).unwrap();
    assert!(s.machine_access(&boss, "box").unwrap().can_control);
    // The list of projects follows the same rule.
    let seen = |user: &str| s.projects(user, &wid).unwrap().len();
    assert_eq!(seen("ann"), 1);
    assert_eq!(seen("bob"), 0);
    assert_eq!(seen("boss"), 1);
    let listed = s.projects("ann", &wid).unwrap();
    assert_eq!(listed[0]["members"][0]["userId"], "ann");
    assert_eq!(listed[0]["members"][0]["name"], "Anna");
    // An emptied list does NOT reopen a restricted share...
    set_list(&s, &id, &[]);
    assert_eq!(seen("bob"), 0);
    // ...only a share that is not restricted is the whole team's.
    s.with_conn_for_tests(|c| {
        c.execute("UPDATE project_shares SET restricted=0", [])
            .unwrap();
    });
    assert_eq!(seen("bob"), 1);
    assert!(s.projects("bob", &wid).unwrap()[0].get("members").is_none());
}

#[test]
fn the_workspace_owner_sees_a_listed_share_on_someone_elses_machine() {
    let (s, wid) = team();
    // ann owns the device; boss owns the workspace and is not on the list.
    s.with_conn_for_tests(|c| {
        c.execute(
            "UPDATE devices SET owner_user_id='ann' WHERE machine_id='box'",
            [],
        )
        .unwrap();
    });
    let share = s
        .share_project("ann", &wid, "box", "/p/c", "C", "control", "team")
        .unwrap();
    set_list(&s, share["projectShareId"].as_str().unwrap(), &["bob"]);
    assert_eq!(roots(&s, &wid, "boss"), Some(vec!["/p/c".into()]));
    assert_eq!(s.projects("boss", &wid).unwrap().len(), 1);
    assert_eq!(roots(&s, &wid, "cat"), None);
}

fn id_of(share: &serde_json::Value) -> String {
    share["projectShareId"].as_str().unwrap().to_string()
}

fn access_of(s: &WorkspaceStore, wid: &str, user: &str) -> crate::workspace::MachineAccess {
    let a = s.ui_access(user, Some(wid), false).unwrap();
    s.machine_access(&a, "box").unwrap()
}

/// The attorney-privilege case: a BROADER share a person is in never reopens a
/// restricted share nested inside it that they are not on.
#[test]
fn a_broader_share_never_reopens_a_nested_restricted_one() {
    let (s, wid) = team();
    s.share_project("boss", &wid, "box", "/p", "All", "control", "team")
        .unwrap();
    let secret = s
        .share_project(
            "boss",
            &wid,
            "box",
            "/p/secret",
            "Secret",
            "control",
            "team",
        )
        .unwrap();
    set_list(&s, &id_of(&secret), &["bob"]);

    // ann: in /p, not on /p/secret.
    let ann = access_of(&s, &wid, "ann");
    assert!(ann.can_start);
    // (/p itself is above the closed root: see the next test.)
    assert!(ann.allows_path("/p/app") && ann.allows_path("/p/app/src"));
    assert!(ann.allows_start_path("/p/app"));
    for inside in [
        "/p/secret",
        "/p/secret/",
        "/p/secret/x/y",
        "/p/./secret/x",
        "/p/app/../secret/x",
    ] {
        assert!(!ann.allows_path(inside), "{inside} is closed to ann");
        assert!(
            !ann.allows_start_path(inside),
            "{inside} cannot be started in"
        );
    }
    assert!(
        ann.allows_path("/p/secret-two"),
        "a sibling with the same prefix is open"
    );
    // bob is on it, and in /p.
    let bob = access_of(&s, &wid, "bob");
    assert!(bob.allows_path("/p/secret/x") && bob.allows_start_path("/p/secret/x"));
    // The workspace owner and the device owner are exempt.
    assert!(access_of(&s, &wid, "boss").can_control);

    // A restricted share nested in a restricted one: the deeper one decides.
    let outer = s
        .share_project("boss", &wid, "box", "/q", "Q", "control", "team")
        .unwrap();
    let inner = s
        .share_project("boss", &wid, "box", "/q/in", "In", "control", "team")
        .unwrap();
    set_list(&s, &id_of(&outer), &["bob"]);
    set_list(&s, &id_of(&inner), &["ann"]);
    let ann = access_of(&s, &wid, "ann");
    assert!(ann.allows_path("/q/in/x"), "listed on the deeper share");
    assert!(!ann.allows_path("/q/other"), "but not on the broader one");
    let bob = access_of(&s, &wid, "bob");
    assert!(bob.allows_path("/q/other"));
    assert!(
        !bob.allows_path("/q/in/x"),
        "bob is on the broader share only"
    );
}

/// A folder ABOVE a closed root is no more theirs than the root: a session
/// started there can read it. Browsing is separate (the RPCs judge the path).
#[test]
fn a_folder_above_a_closed_root_is_closed_to_start_and_drive() {
    let (s, wid) = team();
    s.share_project("boss", &wid, "box", "/p", "All", "control", "team")
        .unwrap();
    let secret = s
        .share_project(
            "boss",
            &wid,
            "box",
            "/p/secret",
            "Secret",
            "control",
            "team",
        )
        .unwrap();
    set_list(&s, &id_of(&secret), &["bob"]);
    let ann = access_of(&s, &wid, "ann");
    assert!(!ann.allows_start_path("/p"), "contains /p/secret");
    assert!(!ann.allows_path("/p"), "a session at /p could read it");
    assert!(ann.allows_start_path("/p/app") && ann.allows_path("/p/app"));
    assert!(
        ann.allows_read_path("/p"),
        "but the folder can still be listed"
    );
    assert!(!ann.allows_read_path("/p/secret"));
    // bob is on it: nothing is closed to him.
    let bob = access_of(&s, &wid, "bob");
    assert!(bob.allows_start_path("/p") && bob.allows_path("/p"));
}

#[test]
fn a_requested_path_is_taken_absolute_when_it_is_absolute() {
    use crate::workspace::requested_path as rp;
    assert_eq!(rp("/repo", ""), "/repo");
    assert_eq!(rp("/repo", "a/b"), "/repo/a/b");
    assert_eq!(rp("/repo/", "a"), "/repo/a");
    assert_eq!(rp("/repo", "/repo/secret/x"), "/repo/secret/x");
    assert_eq!(rp("/repo", "/etc/passwd"), "/etc/passwd");
    assert_eq!(rp(r"C:\repo", r"D:\x"), r"D:\x");
    assert_eq!(rp(r"C:\repo", r"\\srv\share"), r"\\srv\share");
    assert_eq!(rp(r"C:\repo", r"\x"), r"\x");
    assert_eq!(rp(r"C:\repo\", "a"), r"C:\repo/a");
}

/// A workspace owner sees every restricted share, but works only in those they
/// are listed on — and a listing on a BROADER share does not carry into an
/// unlisted one nested in it.
#[test]
fn an_owner_listed_on_a_broader_share_cannot_work_in_an_unlisted_nested_one() {
    let (s, wid) = team();
    // ann owns the device, so boss is a workspace owner who does not control it.
    s.with_conn_for_tests(|c| {
        c.execute(
            "UPDATE devices SET owner_user_id='ann' WHERE machine_id='box'",
            [],
        )
        .unwrap();
    });
    let outer = s
        .share_project("ann", &wid, "box", "/m", "M", "control", "team")
        .unwrap();
    let inner = s
        .share_project(
            "ann",
            &wid,
            "box",
            "/m/private",
            "Private",
            "control",
            "team",
        )
        .unwrap();
    set_list(&s, &id_of(&outer), &["boss"]);
    set_list(&s, &id_of(&inner), &["bob"]);
    let boss = access_of(&s, &wid, "boss");
    // Seeing: everything (the owner's exemption).
    assert!(boss.allows_path("/m/private/x") && boss.allows_path("/m/x"));
    // Working: the broader share's own ground, not the nested one's.
    assert!(boss.allows_start_path("/m/work"));
    assert!(!boss.allows_start_path("/m/private/x"));
    assert!(
        !boss.allows_start_path("/m"),
        "a folder above it can read it"
    );
    assert!(boss.allows_read_path("/m") && !boss.allows_read_path("/m/private/x"));
    // Listed on the nested one too: it opens.
    set_list(&s, &id_of(&inner), &["bob", "boss"]);
    let boss = access_of(&s, &wid, "boss");
    assert!(boss.allows_start_path("/m/private/x") && boss.allows_start_path("/m"));
}

/// Adding the service markers is a migration boundary: service sessions that
/// predate them cannot be re-checked or revoked by issuer, so they are ended;
/// ordinary ones and a later start are left alone.
#[test]
fn adding_the_service_markers_ends_the_sessions_that_predate_them() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT, label TEXT, created_at INTEGER);
         CREATE TABLE signin_links (jti_hash TEXT PRIMARY KEY, user_id TEXT, used_at INTEGER, expires_at INTEGER);
         -- a service session still labelled, and one whose label a browser has since replaced
         INSERT INTO auth_sessions VALUES('old-service','ann','service:legal',1000);
         INSERT INTO auth_sessions VALUES('renamed-service','bob','Chrome on Mac',2000);
         INSERT INTO signin_links VALUES('svc','bob',2000,2150000);
         -- an ordinary browser login, and an operator link (no expiry on its row)
         INSERT INTO auth_sessions VALUES('browser','ann','Chrome',3000);
         INSERT INTO auth_sessions VALUES('operator','cat','Safari',4000);
         INSERT INTO signin_links VALUES('op','cat',4000,NULL);
         -- a person who once signed in through a key: the label renamed, the
         -- one-shot row long swept — only the permanent audit row remembers
         INSERT INTO auth_sessions VALUES('swept','dan','Firefox',6000);
         INSERT INTO auth_sessions VALUES('swept-too','dan','Edge',6500);
         CREATE TABLE audit_events (action TEXT, target_id TEXT, metadata_json TEXT);
         INSERT INTO audit_events VALUES('auth.service_signin','dan','{\"by\":\"legal\"}');
         -- one who was only sent to sign in themselves keeps their own sessions
         INSERT INTO auth_sessions VALUES('own-login','eve','Chrome',7000);
         INSERT INTO audit_events VALUES('auth.service_signin','eve','{\"outcome\":\"login_required\"}');",
    )
    .unwrap();
    crate::workspace::migrate_service_session_columns(&conn).unwrap();
    let left: Vec<String> = conn
        .prepare("SELECT token_hash FROM auth_sessions")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    assert_eq!(left, ["browser", "operator", "own-login"]);
    // The columns exist now, and a session minted with them survives the next start.
    conn.execute(
        "INSERT INTO auth_sessions(token_hash,user_id,label,created_at,service_issuer,service_workspace_id) VALUES('new','ann','service:legal',5000,'legal','w')",
        [],
    )
    .unwrap();
    crate::workspace::migrate_service_session_columns(&conn).unwrap();
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM auth_sessions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 4);
}

/// A start interrupted between the two ALTERs still cleans up on the next one.
#[test]
fn a_half_finished_migration_still_ends_the_legacy_service_sessions() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT, label TEXT, created_at INTEGER, service_issuer TEXT);
         CREATE TABLE signin_links (jti_hash TEXT PRIMARY KEY, user_id TEXT, used_at INTEGER, expires_at INTEGER);
         CREATE TABLE audit_events (action TEXT, target_id TEXT, metadata_json TEXT);
         INSERT INTO auth_sessions VALUES('legacy','ann','Chrome',1,NULL);
         INSERT INTO audit_events VALUES('auth.service_signin','ann','{\"outcome\":\"issued\"}');
         INSERT INTO auth_sessions VALUES('other','bob','Chrome',2,NULL);",
    )
    .unwrap();
    // `service_issuer` already exists; `service_workspace_id` is added now.
    crate::workspace::migrate_service_session_columns(&conn).unwrap();
    let left: Vec<String> = conn
        .prepare("SELECT token_hash FROM auth_sessions")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    assert_eq!(left, ["other"]);
}

/// Withdrawing a restricted share from the team's own screen leaves the same
/// tombstone the service API does: the broader share does not swallow it.
#[test]
fn revoking_a_restricted_share_leaves_it_closed() {
    let (s, wid) = team();
    s.share_project("boss", &wid, "box", "/p", "All", "control", "team")
        .unwrap();
    let secret = s
        .share_project(
            "boss",
            &wid,
            "box",
            "/p/secret",
            "Secret",
            "control",
            "team",
        )
        .unwrap();
    let id = id_of(&secret);
    set_list(&s, &id, &["bob"]);
    s.remove_project("boss", &wid, &id).unwrap();
    let ann = access_of(&s, &wid, "ann");
    assert!(!ann.allows_path("/p/secret/x"), "still closed");
    assert!(ann.allows_path("/p/app"));
    let bob = access_of(&s, &wid, "bob");
    assert!(!bob.allows_path("/p/secret/x"), "bob's list went with it");
    // The tombstone is still there for the owner to see, with nobody on it.
    let seen = s.projects("boss", &wid).unwrap();
    let tomb = seen.iter().find(|p| p["root"] == "/p/secret").unwrap();
    assert_eq!(tomb["members"], serde_json::json!([]));
    // An ordinary share is simply deleted.
    let team_share = s
        .share_project("boss", &wid, "box", "/q", "Q", "control", "team")
        .unwrap();
    s.remove_project("boss", &wid, &id_of(&team_share)).unwrap();
    assert!(s
        .projects("boss", &wid)
        .unwrap()
        .iter()
        .all(|p| p["root"] != "/q"));
}

/// A tombstone is not quietly reopened by publishing the root again, and there
/// is an explicit way out: revoke the empty tombstone once more.
#[test]
fn a_tombstoned_root_cannot_be_republished_until_the_tombstone_is_lifted() {
    let (s, wid) = team();
    let share = s
        .share_project("boss", &wid, "box", "/p/c", "C", "control", "team")
        .unwrap();
    let id = id_of(&share);
    set_list(&s, &id, &["ann"]);
    // Still restricted: publishing again is refused, with a reason a person can act on.
    let err = s
        .share_project("boss", &wid, "box", "/p/c", "C again", "control", "team")
        .unwrap_err();
    assert!(err.contains("закрыта списком"), "{err}");
    // First revoke: tombstone. Publishing is still refused; nobody got in.
    s.remove_project("boss", &wid, &id).unwrap();
    assert!(s
        .share_project("boss", &wid, "box", "/p/c", "C again", "control", "team")
        .unwrap_err()
        .contains("закрыта списком"));
    assert_eq!(roots(&s, &wid, "bob"), None);
    // Second revoke of the EMPTY tombstone lifts the restriction for good...
    s.remove_project("boss", &wid, &id).unwrap();
    assert!(s.projects("boss", &wid).unwrap().is_empty());
    // ...and the folder is an ordinary share again, deliberately.
    let again = s
        .share_project("boss", &wid, "box", "/p/c", "C", "control", "team")
        .unwrap();
    assert_eq!(roots(&s, &wid, "bob"), Some(vec!["/p/c".into()]));
    assert_ne!(id_of(&again), id);
}

/// Filesystem roots: a share rooted at `/` or `D:\` covers everything below,
/// so a closed root inside it is above/below the right things.
#[test]
fn a_filesystem_root_contains_everything_below_it() {
    use crate::workspace::path_is_within as within;
    assert!(within("/repo", "/") && within("/", "/") && within("/a/b", "/"));
    assert!(within(r"d:\repo\x", r"D:\") && within("d:/", r"D:\"));
    assert!(!within("e:/repo", r"D:\"));
    assert!(!within("/repo2", "/repo") && within("/repo/x", "/repo/"));

    let (s, wid) = team();
    // A share over the whole disk, and a closed folder inside it.
    s.share_project("boss", &wid, "box", "/", "Disk", "control", "team")
        .unwrap();
    let secret = s
        .share_project(
            "boss",
            &wid,
            "box",
            "/repo/secret",
            "Secret",
            "control",
            "team",
        )
        .unwrap();
    set_list(&s, &id_of(&secret), &["bob"]);
    let ann = access_of(&s, &wid, "ann");
    assert!(
        ann.contains_denied("/"),
        "the disk root is above the closed folder"
    );
    assert!(!ann.allows_start_path("/"), "so no session starts at /");
    assert!(!ann.allows_path("/") && !ann.allows_path("/repo"));
    assert!(ann.allows_start_path("/home") && ann.allows_read_path("/"));
    assert!(!ann.allows_start_path("/repo/secret/x"));

    // The Windows spelling.
    let (s, wid) = team();
    s.share_project("boss", &wid, "box", r"D:\", "Disk", "control", "team")
        .unwrap();
    let secret = s
        .share_project(
            "boss",
            &wid,
            "box",
            r"D:\repo\secret",
            "Secret",
            "control",
            "team",
        )
        .unwrap();
    set_list(&s, &id_of(&secret), &["bob"]);
    let ann = access_of(&s, &wid, "ann");
    assert!(!ann.allows_start_path(r"D:\"));
    assert!(!ann.allows_start_path(r"d:\repo\secret\x"));
    assert!(ann.allows_start_path(r"D:\work"));
}

/// A list row of someone who left the team counts for nothing: it is removed
/// with them, and even a stale one is ignored on read — they do not reopen the
/// closed root through another workspace's broader share.
#[test]
fn leaving_the_team_takes_you_off_its_lists() {
    let (s, wid) = team();
    // A second team on the same machine whose share is BROADER than the secret.
    let w2 = s.create_organization("boss", "Second", "boss").unwrap();
    let wid2 = w2["workspaceId"].as_str().unwrap().to_string();
    let invite = s.invite("boss", &wid2, "ann@x", "member").unwrap();
    s.accept_invitation("ann", invite["token"].as_str().unwrap())
        .unwrap();
    s.share_project("boss", &wid2, "box", "/p", "Wide", "control", "team")
        .unwrap();
    let secret = s
        .share_project(
            "boss",
            &wid,
            "box",
            "/p/secret",
            "Secret",
            "control",
            "team",
        )
        .unwrap();
    let secret = id_of(&secret);
    set_list(&s, &secret, &["ann", "bob"]);
    let in_second = |s: &WorkspaceStore| {
        let a = s.ui_access("ann", Some(&wid2), false).unwrap();
        s.machine_access(&a, "box").unwrap()
    };
    assert!(
        in_second(&s).allows_path("/p/secret/x"),
        "listed (and a member) in the first team: it reopens"
    );
    s.remove_member("boss", &wid, "ann").unwrap();
    let left: i64 = s.with_conn_for_tests(|c| {
        c.query_row(
            "SELECT COUNT(*) FROM project_share_members WHERE user_id='ann'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    });
    assert_eq!(left, 0, "the rows went with the membership");
    assert!(
        !in_second(&s).allows_path("/p/secret/x"),
        "closed to her now"
    );
    // A stale row (as if the delete had been missed) is ignored on read.
    s.with_conn_for_tests(|c| {
        c.execute(
            "INSERT INTO project_share_members VALUES(?1,'ann','member',1)",
            [&secret],
        )
        .unwrap();
    });
    assert!(!in_second(&s).allows_path("/p/secret/x"));
    assert_eq!(roots(&s, &wid, "bob"), Some(vec!["/p/secret".into()]));
}

/// Restricted is a flag, not a count of list rows: erasing the only listed
/// person (their rows cascade) must not open the share to the team.
#[test]
fn a_restricted_share_whose_people_are_gone_stays_closed() {
    let (s, wid) = team();
    let share = s
        .share_project("boss", &wid, "box", "/p/c", "C", "control", "team")
        .unwrap();
    let id = id_of(&share);
    set_list(&s, &id, &["ann"]);
    assert_eq!(roots(&s, &wid, "ann"), Some(vec!["/p/c".into()]));
    // What erasing the account does to the list: its rows go (the foreign key
    // cascades them); the share row, and its `restricted` flag, stay.
    s.with_conn_for_tests(|c| {
        c.execute("DELETE FROM project_share_members WHERE user_id='ann'", [])
            .unwrap();
    });
    let rows: i64 = s.with_conn_for_tests(|c| {
        c.query_row("SELECT COUNT(*) FROM project_share_members", [], |r| {
            r.get(0)
        })
        .unwrap()
    });
    assert_eq!(rows, 0, "the cascade took the only row");
    assert_eq!(
        roots(&s, &wid, "bob"),
        None,
        "and the share stays closed to the team"
    );
    assert!(s.projects("bob", &wid).unwrap().is_empty());
    // Only the workspace owner (and the device owner) can still see it.
    assert_eq!(s.projects("boss", &wid).unwrap().len(), 1);
    assert_eq!(
        s.projects("boss", &wid).unwrap()[0]["members"],
        serde_json::json!([])
    );
}

/// The owner of the firm who is also a partner in a matter works in it: a
/// workspace owner or manager who IS listed may start there, and only there.
#[test]
fn a_listed_owner_or_manager_can_start_in_their_matters_only() {
    let (s, wid) = team();
    // ann owns the device, so boss (workspace owner) is a plain non-controller.
    s.with_conn_for_tests(|c| {
        c.execute(
            "UPDATE devices SET owner_user_id='ann' WHERE machine_id='box'",
            [],
        )
        .unwrap();
    });
    let mine = s
        .share_project("ann", &wid, "box", "/m/mine", "Mine", "control", "team")
        .unwrap();
    let other = s
        .share_project("ann", &wid, "box", "/m/other", "Other", "control", "team")
        .unwrap();
    set_list(&s, &id_of(&mine), &["boss", "bob"]);
    set_list(&s, &id_of(&other), &["cat"]);
    let boss = access_of(&s, &wid, "boss");
    assert!(boss.can_view && boss.can_start && !boss.can_control);
    assert!(boss.allows_start_path("/m/mine/x"));
    assert!(
        !boss.allows_start_path("/m/other/x"),
        "an owner starts only where listed"
    );
    assert!(
        boss.allows_path("/m/other/x"),
        "but still sees every share of the workspace"
    );
    // A manager listed on a matter (no assignment) gets the same.
    s.set_member_role("boss", &wid, "bob", "manager").unwrap();
    let bob = access_of(&s, &wid, "bob");
    assert!(bob.can_start && bob.allows_start_path("/m/mine/x"));
    assert!(!bob.allows_start_path("/m/other/x") && !bob.allows_path("/m/other/x"));
    // An unlisted owner on an unrestricted share cannot start (as before).
    s.share_project("ann", &wid, "box", "/m/team", "Team", "control", "team")
        .unwrap();
    s.with_conn_for_tests(|c| {
        c.execute("DELETE FROM project_share_members", []).unwrap();
        c.execute("UPDATE project_shares SET restricted=0", [])
            .unwrap();
    });
    assert!(!access_of(&s, &wid, "boss").can_start);
}

/// Member names on a share are not a way to read e-mail addresses.
#[test]
fn share_member_names_do_not_fall_back_to_email_below_the_workspace_owner() {
    let (s, wid) = team();
    s.with_conn_for_tests(|c| {
        c.execute("UPDATE users SET full_name=NULL WHERE user_id='ann'", [])
            .unwrap();
    });
    let share = s
        .share_project("boss", &wid, "box", "/p/c", "C", "control", "team")
        .unwrap();
    set_list(&s, &id_of(&share), &["ann", "bob"]);
    let as_bob = s.projects("bob", &wid).unwrap();
    let names: Vec<&str> = as_bob[0]["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["ann", "Bob"], "the id stands in for a missing name");
    assert!(!as_bob[0].to_string().contains("@x"));
    let as_boss = s.projects("boss", &wid).unwrap();
    assert_eq!(as_boss[0]["members"][0]["name"], "ann@x");
}

#[test]
fn a_manager_needs_the_list_not_just_an_assignment() {
    let (s, wid) = team();
    s.set_member_role("boss", &wid, "ann", "manager").unwrap();
    let share = s
        .share_project("boss", &wid, "box", "/p/c", "C", "control", "team")
        .unwrap();
    let id = share["projectShareId"].as_str().unwrap().to_string();
    s.assign_manager("boss", &wid, "ann", "project", &id)
        .unwrap();
    assert_eq!(roots(&s, &wid, "ann"), Some(vec!["/p/c".into()]));
    set_list(&s, &id, &["bob"]);
    assert_eq!(roots(&s, &wid, "ann"), None, "assigned but not listed");
    assert!(s.projects("ann", &wid).unwrap().is_empty());
    set_list(&s, &id, &["ann"]);
    assert_eq!(roots(&s, &wid, "ann"), Some(vec!["/p/c".into()]));
}

#[test]
fn revoking_a_share_takes_its_list_with_it() {
    let (s, wid) = team();
    let share = s
        .share_project("boss", &wid, "box", "/p/c", "C", "control", "team")
        .unwrap();
    let id = share["projectShareId"].as_str().unwrap().to_string();
    set_list(&s, &id, &["ann"]);
    s.remove_project("boss", &wid, &id).unwrap();
    let left: i64 = s.with_conn_for_tests(|c| {
        c.query_row("SELECT COUNT(*) FROM project_share_members", [], |r| {
            r.get(0)
        })
        .unwrap()
    });
    assert_eq!(left, 0);
}
