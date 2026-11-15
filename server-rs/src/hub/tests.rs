use super::*;
use tokio::sync::mpsc::{channel, Receiver};

const UI_CONN: ConnId = 1;
const AGENT_CONN: ConnId = 2;

const MB: usize = 1024 * 1024;

/// The next alert push the hub handed the notifier.
fn pushed(rx: &mut UnboundedReceiver<crate::notify::Outbound>) -> crate::notify::PushEvent {
    match rx.try_recv().expect("an emitted push") {
        crate::notify::Outbound::Push(event) => *event,
        other => panic!("expected an alert push, got {other:?}"),
    }
}

/// base64 payload of `len` characters, for the attachment budget tests.
fn b64(len: usize) -> String {
    "A".repeat(len)
}

fn arr_len(v: Option<Value>) -> usize {
    v.and_then(|v| v.as_array().map(Vec::len)).unwrap_or(0)
}

/// The regression this budget exists for: every file here is individually
/// legal under `sanitize_files` (4 files, 12MB of base64 each), yet together
/// they are 48MB in one frame — which the socket answers by closing, not by
/// erroring. The tail must be dropped here instead.
#[test]
fn four_individually_legal_files_cannot_blow_the_frame() {
    let files = json!([
        { "name": "a.bin", "data": b64(12 * MB) },
        { "name": "b.bin", "data": b64(12 * MB) },
        { "name": "c.bin", "data": b64(12 * MB) },
        { "name": "d.bin", "data": b64(12 * MB) },
    ]);
    let (_, fls) = sanitize_attachments(None, Some(&files));
    assert_eq!(
        arr_len(fls),
        1,
        "only what fits the 20MB turn budget survives"
    );
}

/// Images are charged before files, so the screenshot a person is actually
/// looking at is the attachment that survives a tight budget.
#[test]
fn the_image_is_charged_first() {
    let images = json!([{ "media_type": "image/png", "data": b64(7 * MB) }]);
    let files = json!([
        { "name": "a.bin", "data": b64(12 * MB) },
        { "name": "b.bin", "data": b64(2 * MB) },
    ]);
    let (img, fls) = sanitize_attachments(Some(&images), Some(&files));
    assert_eq!(arr_len(img), 1);
    assert_eq!(
        arr_len(fls),
        1,
        "7MB + 12MB leaves no room for a third attachment"
    );
}

#[test]
fn attachments_under_budget_are_untouched() {
    let images = json!([{ "media_type": "image/png", "data": b64(1024) }]);
    let files = json!([
        { "name": "a.bin", "data": b64(1024) },
        { "name": "b.bin", "data": b64(1024) },
    ]);
    let (img, fls) = sanitize_attachments(Some(&images), Some(&files));
    assert_eq!(arr_len(img), 1);
    assert_eq!(arr_len(fls), 2);
}

fn test_hub(session: Value) -> (Hub, Receiver<String>, Receiver<String>) {
    let workspaces = WorkspaceStore::open_memory();
    workspaces
        .ensure_user("owner", "owner@example.com", Some("Owner"))
        .unwrap();
    // A fresh store puts everyone on the waitlist; the owner of the test
    // fleet is an activated person like any employee.
    workspaces.activate_access("owner", "tests").unwrap();
    let machine = json!({
        "machineId": "machine-1",
        "name": "Machine",
        "os": "linux",
        "agentVersion": "test",
    });
    workspaces
        .register_legacy_device("owner", &machine)
        .unwrap();
    let access = workspaces.ui_access("owner", None, false).unwrap();

    let (self_tx, _self_rx) = unbounded_channel();
    let mut hub = Hub::new(
        self_tx,
        None,
        ReplicaStore::open_memory(),
        workspaces,
        "owner".into(),
        RoadmapConfig::default(),
    );
    let (ui_tx, ui_rx) = channel(128);
    let (agent_tx, agent_rx) = channel(128);
    hub.conns.insert(UI_CONN, ui_tx);
    hub.conns.insert(AGENT_CONN, agent_tx);
    hub.ui_clients.insert(UI_CONN);
    hub.ui_access.insert(UI_CONN, access);
    hub.conn_machine.insert(AGENT_CONN, "machine-1".into());
    // Modern agent by default: it reported a process id, which is what marks
    // it as able to carry runs across a blip. `a_legacy_agent_*` clears this
    // to exercise the older bundles still in the fleet.
    hub.agent_instance
        .insert("machine-1".into(), "instance-1".into());
    hub.agents.insert(
        "machine-1".into(),
        AgentConn {
            machine,
            conn: AGENT_CONN,
            liveness: collect_liveness(std::slice::from_ref(&session)),
            sessions: vec![session],
            last_seen: now_ms(),
            usage: Value::Null,
            codex_usage: Value::Null,
            profile: Value::Null,
            stats: Value::Null,
            runtimes: Value::Null,
            // Undeclared, like an agent too old to send it — the tests then
            // exercise the default deadline.
            approval_timeout_ms: None,
            // Nothing seen on the wire yet, so the first inventory a test
            // sends still counts as news.
            inventory_sig: None,
            inventory_ui_sig: None,
            published_sessions: HashMap::new(),
        },
    );
    (hub, ui_rx, agent_rx)
}

/// Let the coalescing window pass and pay what the hub deferred: the trailing
/// snapshot, the activity heartbeat. In production the 500 ms tick does this.
fn settle_coalescing(hub: &mut Hub) {
    hub.last_snapshot_at = 0;
    hub.coalesce_tick();
}

/// A second agent, on machine-2, that the UI may NOT control.
fn add_foreign_agent(hub: &mut Hub, conn: ConnId) -> Receiver<String> {
    let (tx, rx) = channel(128);
    hub.conns.insert(conn, tx);
    hub.conn_machine.insert(conn, "machine-2".into());
    rx
}

/// Only the machine a terminal was opened on may feed it. Another agent
/// that learns the termId (it is in the audit trail) gets nothing through.
#[test]
fn terminal_frames_from_another_machine_are_dropped() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    hub.terminals
        .insert("t-1".into(), (UI_CONN, "machine-1".into()));
    let _foreign_rx = add_foreign_agent(&mut hub, 3);
    drain(&mut ui_rx);

    hub.on_agent_msg(
        3,
        json!({"type":"term_data","termId":"t-1","data":"forged"}),
    );
    hub.on_agent_msg(3, json!({"type":"term_exit","termId":"t-1","code":0}));
    assert!(
        drain(&mut ui_rx)
            .iter()
            .all(|m| m["type"] != "term_data" && m["type"] != "term_exit"),
        "nothing from machine-2 reaches the browser"
    );
    assert!(
        hub.terminals.contains_key("t-1"),
        "a forged exit does not close it"
    );

    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"term_data","termId":"t-1","data":"real"}),
    );
    let got = drain(&mut ui_rx);
    assert!(got
        .iter()
        .any(|m| m["type"] == "term_data" && m["data"] == "real"));
}

/// An RPC answer counts only from the machine the request went to; a
/// forged one leaves the request pending for the real answer.
#[test]
fn rpc_answers_from_another_machine_are_dropped() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    hub.pending_rpc.insert(
        "r-1".into(),
        PendingRpc {
            conn: UI_CONN,
            machine_id: "machine-1".into(),
            method: "fs.read".into(),
            cwd: None,
            history: None,
            deleting: None,
            ..Default::default()
        },
    );
    let _foreign_rx = add_foreign_agent(&mut hub, 3);
    drain(&mut ui_rx);

    hub.on_agent_msg(
        3,
        json!({"type":"rpc_response","requestId":"r-1","ok":true,"result":{"forged":true}}),
    );
    assert!(drain(&mut ui_rx).is_empty());
    assert!(hub.pending_rpc.contains_key("r-1"));

    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"rpc_response","requestId":"r-1","ok":true,"result":{"real":true}}),
    );
    let got = drain(&mut ui_rx);
    assert!(got
        .iter()
        .any(|m| m["type"] == "rpc_response" && m["result"]["real"] == true));
    assert!(!hub.pending_rpc.contains_key("r-1"));
}

/// A browser cannot take over another browser's terminal by re-using its
/// client-chosen termId.
#[test]
fn a_terminal_id_held_by_another_browser_is_not_taken_over() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    let mut colleague_rx = add_colleague(&mut hub, 5);
    hub.terminals.insert("t-1".into(), (5, "machine-1".into()));
    drain(&mut ui_rx);
    drain(&mut agent_rx);

    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"term_open","termId":"t-1","machineId":"machine-1"}),
    );
    assert_eq!(
        hub.terminals.get("t-1").map(|(c, _)| *c),
        Some(5),
        "still the colleague's"
    );
    assert!(drain(&mut agent_rx)
        .iter()
        .all(|m| m["type"] != "term_open"));
    drain(&mut colleague_rx);
}

/// The owner's memory goes to their own boxes, never to a sandbox (a
/// member's code runs there) nor, with the allowlist set, to anything not
/// on it. Checked on the hub: the agent-side flag is not a boundary.
#[test]
fn memory_is_not_synced_to_sandboxes_or_unlisted_machines() {
    let catalog_len = |hub: &mut Hub, rx: &mut Receiver<String>| -> Option<usize> {
        drain(rx);
        hub.send_memory_catalog(AGENT_CONN, "machine-1");
        hub.memory_fetch(
            AGENT_CONN,
            &json!({"want":[{"scope":"fleet","scopeKey":"","path":"note.md"}]}),
        );
        let got = drain(rx);
        got.iter()
            .find(|m| m["type"] == "memory_catalog")
            .map(|m| m["memories"].as_array().map_or(0, Vec::len))
    };
    let (mut hub, _ui_rx, mut agent_rx) = test_hub(session(None));
    hub.workspaces
        .upsert_memory("owner", "fleet", "", "note.md", "secret plan")
        .unwrap();
    assert_eq!(
        catalog_len(&mut hub, &mut agent_rx),
        Some(1),
        "a personal box syncs"
    );

    hub.memory_sync_machines = Some(["other-box".to_string()].into_iter().collect());
    assert_eq!(
        catalog_len(&mut hub, &mut agent_rx),
        None,
        "not on the allowlist"
    );
    hub.memory_sync_machines = None;

    hub.workspaces
        .conn
        .lock()
        .unwrap()
        .execute(
            "UPDATE devices SET kind='sandbox' WHERE machine_id='machine-1'",
            [],
        )
        .unwrap();
    assert_eq!(
        catalog_len(&mut hub, &mut agent_rx),
        None,
        "a sandbox never syncs"
    );
    hub.memory_push(
        AGENT_CONN,
        &json!({"scope":"fleet","scopeKey":"","path":"note.md","content":"planted"}),
    );
    let kept = hub
        .workspaces
        .read_memory("owner", "fleet", "", "note.md")
        .unwrap()
        .unwrap();
    assert_eq!(
        kept.content.as_deref(),
        Some("secret plan"),
        "a sandbox cannot write it either"
    );
}

fn session(live_pid: Option<i64>) -> Value {
    let mut value = json!({
        "sessionId": "session-1",
        "title": "Session",
        "cwd": "/repo",
        "source": "claude",
    });
    if let Some(pid) = live_pid {
        value["livePid"] = json!(pid);
        value["entrypoint"] = json!("claude-vscode");
    }
    value
}

fn open(hub: &mut Hub, force: bool) {
    hub.open_run(
        UI_CONN,
        &json!({"machineId":"machine-1","sessionId":"session-1"}),
        force,
    );
}

/// A second person at the same workspace, on their own socket — the
/// colleague who picks up a session someone else started.
fn add_colleague(hub: &mut Hub, conn: ConnId) -> Receiver<String> {
    let access = hub.workspaces.ui_access("owner", None, false).unwrap();
    let (tx, rx) = channel(128);
    hub.conns.insert(conn, tx);
    hub.ui_clients.insert(conn);
    hub.ui_access.insert(conn, access);
    rx
}

/// The composer's model / effort picked before «continue» ride the resume
/// to the agent, validated the way `new_session`'s are: a bad effort is
/// dropped, never a refused open.
#[test]
fn open_carries_the_picked_model_and_effort_to_the_resume() {
    let (mut hub, _ui_rx, mut agent_rx) = test_hub(session(None));
    hub.open_run(
        UI_CONN,
        &json!({"machineId":"machine-1","sessionId":"session-1","model":"opus","effort":"high"}),
        false,
    );
    let resume = drain(&mut agent_rx)
        .into_iter()
        .find(|m| m["type"] == "resume")
        .expect("the agent must be told to resume");
    assert_eq!(resume["model"], "opus");
    assert_eq!(resume["effort"], "high");

    let (mut hub, _ui_rx, mut agent_rx) = test_hub(session(None));
    hub.open_run(
        UI_CONN,
        &json!({"machineId":"machine-1","sessionId":"session-1","effort":"ludicrous"}),
        false,
    );
    let resume = drain(&mut agent_rx)
        .into_iter()
        .find(|m| m["type"] == "resume")
        .expect("a bad effort must not cost the open");
    assert!(resume.get("effort").is_none());
    assert!(resume.get("model").is_none());
}

fn drain(receiver: &mut Receiver<String>) -> Vec<Value> {
    let mut out = Vec::new();
    while let Ok(raw) = receiver.try_recv() {
        out.push(serde_json::from_str(&raw).unwrap());
    }
    out
}

/// Re-seat the UI connection as a `member` of a team whose machine-1 is
/// owned by someone else and shared with `control` on /repo — the
/// employee-on-a-colleague's-box shape.
fn seat_as_team_member(hub: &mut Hub) {
    let ws = hub.workspaces.clone();
    ws.ensure_user("mate", "mate@example.com", Some("Mate"))
        .unwrap();
    ws.activate_access("mate", "tests").unwrap();
    let team = ws.create_organization("mate", "Team", "mate").unwrap();
    let wid = team["workspaceId"].as_str().unwrap();
    let invite = ws
        .invite("mate", wid, "owner@example.com", "member")
        .unwrap();
    ws.accept_invitation("owner", invite["token"].as_str().unwrap())
        .unwrap();
    ws.conn
        .lock()
        .unwrap()
        .execute(
            "UPDATE devices SET owner_user_id='mate' WHERE machine_id='machine-1'",
            [],
        )
        .unwrap();
    ws.share_project("mate", wid, "machine-1", "/repo", "Repo", "control", "team")
        .unwrap();
    let access = ws.ui_access("owner", Some(wid), false).unwrap();
    assert_eq!(access.role, "member");
    hub.ui_access.insert(UI_CONN, access);
}

fn started_source(rx: &mut Receiver<String>) -> Value {
    drain(rx)
        .into_iter()
        .find(|m| m["type"] == "new_session")
        .expect("the agent must be told to start a session")
}

/// Agents re-push their whole inventory on a debounce whether or not
/// anything moved, and every push used to fan a full snapshot at every
/// browser: on the real fleet that measured 765 KB every ~7.5 seconds into
/// an idle phone, which both burned mobile data and filled the outbound
/// channel that `send_raw` drops a peer over. A repeat of the same list is
/// news to nobody — but a list that genuinely changed still has to arrive.
#[test]
fn a_repeated_inventory_is_not_rebroadcast_but_a_changed_one_is() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(Some(4242)));
    hub.store
        .record_machine(
            &json!({"machineId":"machine-1","name":"Machine","os":"linux","agentVersion":"test"}),
            now_ms(),
        )
        .unwrap();
    let inventory = json!({"type":"inventory","sessions":[session(Some(4242))],"complete":true});

    drain(&mut ui_rx);
    hub.on_agent_msg(AGENT_CONN, inventory.clone());
    let first: Vec<Value> = drain(&mut ui_rx);
    assert!(
        first.iter().any(|m| m["type"] == "snapshot"),
        "the first inventory is news and must reach the browser"
    );

    hub.on_agent_msg(AGENT_CONN, inventory.clone());
    hub.on_agent_msg(AGENT_CONN, inventory);
    let repeats: Vec<Value> = drain(&mut ui_rx);
    assert!(
        !repeats.iter().any(|m| m["type"] == "snapshot"),
        "an identical inventory says nothing and must not cost a snapshot"
    );

    // A moved mtime is the change the live fleet actually produces, over and
    // over, as somebody types: it only moves a relative timestamp and a sort
    // position, so it waits for company instead of costing every browser a
    // frame carrying every machine.
    let mut ticked = session(Some(4242));
    ticked["lastModified"] = json!(now_ms());
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"inventory","sessions":[ticked],"complete":true}),
    );
    let deferred: Vec<Value> = drain(&mut ui_rx);
    assert!(
        !deferred.iter().any(|m| m["type"] == "snapshot"),
        "a mtime-only change must not interrupt anyone on its own"
    );
    assert!(
        hub.pending_machines.contains("machine-1"),
        "…but it is still owed"
    );
    hub.flush_snapshot();
    settle_coalescing(&mut hub);
    assert!(
        drain(&mut ui_rx).iter().any(|m| m["type"] == "snapshot"),
        "the flush tick pays what is owed"
    );
    assert!(hub.pending_machines.is_empty());

    // The editor let go of the session — that is a real change, and the
    // board's take-over affordance depends on seeing it at once.
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"inventory","sessions":[session(None)],"complete":true}),
    );
    // (A viewer that takes no deltas gets its snapshot at the leading edge of
    // the coalescing window, or at its end.)
    settle_coalescing(&mut hub);
    let changed: Vec<Value> = drain(&mut ui_rx);
    assert!(
        changed.iter().any(|m| m["type"] == "snapshot"),
        "a changed inventory must still be broadcast"
    );
}

/// The delta is opt-in, and the reason is compatibility, not taste: a build
/// that does not know `machine_sessions` ignores it silently, so if the hub
/// sent it to everyone an older TestFlight app would sit on a session list
/// that never changed again. A client that asked gets the one machine; a
/// client that did not still gets the whole fleet.
#[test]
fn only_a_client_that_asked_is_sent_session_deltas() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(Some(4242)));
    hub.store
        .record_machine(
            &json!({"machineId":"machine-1","name":"Machine","os":"linux","agentVersion":"test"}),
            now_ms(),
        )
        .unwrap();

    // No `hello` yet — the shape of every client shipped before this.
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"inventory","sessions":[session(Some(4242))],"complete":true}),
    );
    let legacy = drain(&mut ui_rx);
    assert!(
        legacy.iter().any(|m| m["type"] == "snapshot"),
        "a client that asked for nothing must keep getting whole snapshots"
    );
    assert!(!legacy.iter().any(|m| m["type"] == "machine_sessions"));

    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"hello","client":"web","caps":["sessionDelta"]}),
    );
    drain(&mut ui_rx);
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"inventory","sessions":[session(None)],"complete":true}),
    );
    let modern = drain(&mut ui_rx);
    let delta = modern
        .iter()
        .find(|m| m["type"] == "machine_sessions")
        .expect("a client that asked gets the delta");
    assert!(
        !modern.iter().any(|m| m["type"] == "snapshot"),
        "…and not the snapshot as well — that would be strictly worse"
    );
    assert_eq!(delta["machine"]["machine"]["machineId"], "machine-1");
    assert_eq!(delta["machine"]["online"], true);
    // The payload has to be the same entry the snapshot carries, or the
    // client's merged copy quietly diverges from a reconnect's.
    let from_snapshot = &hub.snapshot_for(UI_CONN)["machines"][0];
    assert_eq!(&delta["machine"], from_snapshot);
}

/// The finest of the three grades: only the sessions that actually differ.
/// A machine's whole list is ~90 KB on this fleet and the thing that usually
/// provokes it is one session moving, so this is the difference between a
/// phone paying kilobytes and paying hundreds of bytes.
#[test]
fn a_session_patch_carries_only_what_changed_and_what_went_away() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(Some(4242)));
    hub.store
        .record_machine(
            &json!({"machineId":"machine-1","name":"Machine","os":"linux","agentVersion":"test"}),
            now_ms(),
        )
        .unwrap();
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"hello","client":"web","caps":["sessionDelta","sessionPatch"]}),
    );
    let other = json!({"sessionId":"session-2","title":"Other","cwd":"/repo","source":"claude"});

    // Baseline: both sessions published.
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"inventory","sessions":[session(Some(4242)), other],"complete":true}),
    );
    drain(&mut ui_rx);

    // The editor let go of session-1; session-2 did not move at all.
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"inventory","sessions":[session(None), other],"complete":true}),
    );
    let msgs = drain(&mut ui_rx);
    let patch = msgs
        .iter()
        .find(|m| m["type"] == "session_updates")
        .expect("a sessionPatch client gets the patch");
    assert!(!msgs.iter().any(|m| m["type"] == "machine_sessions"));
    assert!(!msgs.iter().any(|m| m["type"] == "snapshot"));
    let carried = patch["sessions"].as_array().unwrap();
    assert_eq!(carried.len(), 1, "only the session that moved travels");
    assert_eq!(carried[0]["sessionId"], "session-1");
    assert!(
        carried[0].get("livePid").is_none(),
        "the whole entry is replaced, so a pid that stopped being reported is gone"
    );

    // An unchanged inventory is not a patch — it is nothing.
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"inventory","sessions":[session(None), other],"complete":true}),
    );
    assert!(
        !drain(&mut ui_rx)
            .iter()
            .any(|m| m["type"] == "session_updates"),
        "nothing changed, so nothing is owed"
    );

    // session-2 disappears from the machine entirely.
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"inventory","sessions":[session(None)],"complete":true}),
    );
    let msgs = drain(&mut ui_rx);
    let patch = msgs
        .iter()
        .find(|m| m["type"] == "session_updates")
        .expect("a removal is a patch too");
    assert_eq!(patch["removed"], json!(["session-2"]));
    assert_eq!(
        patch["sessions"].as_array().map(Vec::len),
        Some(0),
        "…and nothing else needed to travel with it"
    );
}

/// Agents order the inventory by mtime, so two sessions swapping places is
/// the SAME list — fingerprinting it in order would call that structural and
/// undo the whole saving on exactly the busy fleet that needs it.
#[test]
fn reordering_the_same_sessions_is_not_a_structural_change() {
    let a = json!({"sessionId":"a","title":"A","cwd":"/repo","lastModified":1});
    let b = json!({"sessionId":"b","title":"B","cwd":"/repo","lastModified":2});
    assert_ne!(
        inventory_fingerprints(std::slice::from_ref(&a)),
        inventory_fingerprints(std::slice::from_ref(&b)),
        "different sessions must fingerprint differently"
    );
    let (exact_ab, shape_ab) = inventory_fingerprints(&[a.clone(), b.clone()]);
    let (exact_ba, shape_ba) = inventory_fingerprints(&[b, a]);
    assert_eq!(exact_ab, exact_ba);
    assert_eq!(shape_ab, shape_ba);
}

/// A Claude session's file cursor moves on every bookkeeping write (a
/// process exit appends `cost-state`) while its sort key stays put. That is
/// an mtime-only change, not a structural one worth an instant snapshot.
#[test]
fn a_moved_file_cursor_is_not_a_structural_change() {
    let before = json!({"sessionId":"a","title":"A","cwd":"/repo","lastModified":1,"fileMtime":5});
    let after = json!({"sessionId":"a","title":"A","cwd":"/repo","lastModified":1,"fileMtime":9});
    let (exact_before, shape_before) = inventory_fingerprints(std::slice::from_ref(&before));
    let (exact_after, shape_after) = inventory_fingerprints(std::slice::from_ref(&after));
    assert_ne!(exact_before, exact_after);
    assert_eq!(shape_before, shape_after);
}

/// The durable catalog strips `livePid` on purpose, but the UI snapshot is
/// served from it — so an inventory that reports an editor-held session must
/// still reach a browser with the pid attached. Without the overlay every
/// session reads as dormant: the web offers a plain resume the agent then
/// refuses, and Mirror / take-over (gated on `livePid`) go unreachable.
#[test]
fn an_inventory_keeps_live_pid_visible_through_the_durable_catalog() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(Some(4242)));
    drain(&mut ui_rx);
    // `register` normally does this; the sessions table keys off it.
    hub.store
        .record_machine(
            &json!({"machineId":"machine-1","name":"Machine","os":"linux","agentVersion":"test"}),
            now_ms(),
        )
        .unwrap();

    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"inventory","sessions":[session(Some(4242))],"complete":true}),
    );

    let snapshot = hub.snapshot_for(UI_CONN);
    let sessions = snapshot["machines"][0]["sessions"].as_array().unwrap();
    let s = sessions
        .iter()
        .find(|s| s["sessionId"] == "session-1")
        .expect("session survives the merge");
    assert_eq!(
        s.get("livePid").and_then(Value::as_i64),
        Some(4242),
        "livePid must survive the durable-catalog round trip"
    );
    assert_eq!(
        s.get("entrypoint").and_then(Value::as_str),
        Some("claude-vscode"),
    );

    // …and it must disappear the moment the agent stops reporting it, or the
    // UI would offer a take-over against a pid that is already gone.
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"inventory","sessions":[session(None)],"complete":true}),
    );
    let snapshot = hub.snapshot_for(UI_CONN);
    let sessions = snapshot["machines"][0]["sessions"].as_array().unwrap();
    let s = sessions
        .iter()
        .find(|s| s["sessionId"] == "session-1")
        .unwrap();
    assert!(
        s.get("livePid").is_none(),
        "a released session must not keep a stale pid"
    );
}

/// `liveStatus` is what tells an editor window left open (idle) from one
/// mid-turn (busy); the web lights «идёт работа» only on the second. It is
/// process state like `livePid`, so it rides the same overlay: reaches the
/// snapshot, is never persisted, and cannot survive its pid.
#[test]
fn live_status_rides_the_liveness_overlay_and_dies_with_the_pid() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(Some(4242)));
    drain(&mut ui_rx);
    hub.store
        .record_machine(
            &json!({"machineId":"machine-1","name":"Machine","os":"linux","agentVersion":"test"}),
            now_ms(),
        )
        .unwrap();
    let status_of = |hub: &mut Hub| {
        let snapshot = hub.snapshot_for(UI_CONN);
        snapshot["machines"][0]["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["sessionId"] == "session-1")
            .unwrap()
            .get("liveStatus")
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let with_status = |status: &str| {
        let mut s = session(Some(4242));
        s["liveStatus"] = json!(status);
        s
    };

    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"inventory","sessions":[with_status("busy")],"complete":true}),
    );
    assert_eq!(status_of(&mut hub).as_deref(), Some("busy"));

    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"inventory","sessions":[with_status("idle")],"complete":true}),
    );
    assert_eq!(status_of(&mut hub).as_deref(), Some("idle"));

    // An unknown value is not passed on — the web's enum would reject the
    // whole snapshot over it.
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"inventory","sessions":[with_status("thinking")],"complete":true}),
    );
    assert_eq!(status_of(&mut hub), None);

    // A status without a pid is a status of nothing.
    let mut orphan = session(None);
    orphan["liveStatus"] = json!("busy");
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"inventory","sessions":[orphan],"complete":true}),
    );
    assert_eq!(status_of(&mut hub), None);

    let stored = hub.store.sessions_for_machine("machine-1").unwrap();
    assert!(
        stored.iter().all(|s| s.get("liveStatus").is_none()),
        "liveStatus must never be persisted"
    );
}

/// A paused (backgrounded) UI conn must receive NOTHING — a suspended app
/// cannot drain its socket, and filling its bounded queue got it dropped as
/// a slow peer (the "hub falls off on every app switch" bug). `resume`
/// lifts the gate and re-syncs with exactly one fresh snapshot.
#[test]
fn a_paused_ui_conn_is_silent_until_resume_resyncs_it() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    drain(&mut ui_rx);

    hub.on_ui_msg(UI_CONN, json!({"type":"pause"}));
    hub.broadcast_snapshot();
    hub.broadcast_activity();
    assert!(
        ui_rx.try_recv().is_err(),
        "a paused conn must not receive fan-out"
    );

    // A plain pause (iOS) gates even the acks: that client resubscribes on
    // resume and must not believe it is already attached.
    hub.send_to(
        UI_CONN,
        &json!({"type":"session_started","runId":"r1","sessionId":"s1"}),
    );
    assert!(ui_rx.try_recv().is_err(), "plain pause gates acks too");

    hub.on_ui_msg(UI_CONN, json!({"type":"resume"}));
    let frame = ui_rx.try_recv().expect("resume answers with a snapshot");
    let v: Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(v["type"], "snapshot");
    drain(&mut ui_rx);

    // A pause with `acks` (the web) still gets the answers to what it asked
    // (20.10.2026: a window hidden right after «Начать сессию» lost `opened`
    // and `session_started`, and its pane never learned its run).
    hub.on_ui_msg(UI_CONN, json!({"type":"pause","acks":true}));
    hub.send_to(
        UI_CONN,
        &json!({"type":"session_started","runId":"r1","sessionId":"s1"}),
    );
    let ack: Value =
        serde_json::from_str(&ui_rx.try_recv().expect("ack passes the pause")).unwrap();
    assert_eq!(ack["type"], "session_started");
    hub.send_to(UI_CONN, &json!({"type":"stream","runId":"r1"}));
    hub.broadcast_snapshot();
    assert!(
        ui_rx.try_recv().is_err(),
        "the stream and fan-out stay gated"
    );

    hub.on_ui_msg(UI_CONN, json!({"type":"resume"}));
    let frame = ui_rx.try_recv().expect("resume answers with a snapshot");
    let v: Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(v["type"], "snapshot");
    // The gate is actually lifted: subsequent fan-out flows again.
    hub.last_snapshot_at = 0; // (the coalescing window is not what is tested)
    hub.broadcast_snapshot();
    assert!(ui_rx.try_recv().is_ok(), "fan-out resumes after resume");

    // A resume without a matching pause stays quiet (no snapshot storm on
    // clients that resume defensively).
    drain(&mut ui_rx);
    hub.on_ui_msg(UI_CONN, json!({"type":"resume"}));
    assert!(ui_rx.try_recv().is_err());
}

/// A capped inventory (`complete:false`) carries only the newest N sessions.
/// An editor can hold a session that hasn't been touched in days, so absence
/// from a capped frame must NOT read as "the writer is gone" — otherwise the
/// UI offers a plain resume for a session VS Code still owns.
#[test]
fn a_capped_inventory_does_not_clear_liveness_it_never_mentioned() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(Some(4242)));
    drain(&mut ui_rx);
    hub.store
        .record_machine(
            &json!({"machineId":"machine-1","name":"Machine","os":"linux","agentVersion":"test"}),
            now_ms(),
        )
        .unwrap();
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"inventory","sessions":[session(Some(4242))],"complete":true}),
    );

    // A capped frame about some OTHER session must leave session-1 alone.
    let other = json!({
        "sessionId": "session-2",
        "title": "Other",
        "cwd": "/repo",
        "source": "claude",
    });
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"inventory","sessions":[other],"complete":false}),
    );

    let held = hub.agents["machine-1"]
        .sessions
        .iter()
        .find(|s| s["sessionId"] == "session-1")
        .expect("session-1 still in the catalog");
    assert_eq!(
        held.get("livePid").and_then(Value::as_i64),
        Some(4242),
        "a capped frame that never mentioned session-1 must not drop its pid"
    );

    // But a capped frame that DOES mention it, reporting no writer, clears it.
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"inventory","sessions":[session(None)],"complete":false}),
    );
    let released = hub.agents["machine-1"]
        .sessions
        .iter()
        .find(|s| s["sessionId"] == "session-1")
        .unwrap();
    assert!(
        released.get("livePid").is_none(),
        "the frame reported session-1 with no writer, so the pid must go"
    );
}

fn test_run(browsers: &[ConnId]) -> ActiveRun {
    ActiveRun {
        opened_at: now_ms(),
        machine_id: "machine-1".into(),
        machine_name: "Machine".into(),
        session_id: "session-1".into(),
        title: None,
        project: None,
        origin: Some("web".into()),
        browsers: browsers.iter().copied().collect(),
        state: "working".into(),
        preview: None,
        text_buf: String::new(),
        replay: VecDeque::new(),
        mode_frame: None,
        settings_frame: None,
        background_frame: None,
        subagents_frame: None,
        plan: None,
        context_frame: None,
        replay_bytes: 0,
        since: 0,
        task_started_at: None,
        pending_request_id: None,
        pending_tool: None,
        pending_tool_input: None,
        pending_tool_title: None,
        last_user_text: String::new(),
        last_error: None,
        pending_tool_e2e: None,
        last_event_at: 0,
        last_event_sent_at: 0,
        awaiting_tool: false,
        compacting: false,
        turn_failed: false,
        owner_user_id: None,
        owner_name: None,
        category: None,
        cwd: None,
        source: None,
    }
}

#[test]
fn browser_disconnect_detaches_without_releasing_runs() {
    let mut runs = HashMap::from([
        ("sole-viewer".into(), test_run(&[7])),
        ("shared-viewers".into(), test_run(&[7, 8])),
    ]);

    detach_browser_from_runs(&mut runs, 7);

    assert_eq!(runs.len(), 2, "a UI disconnect must not own run lifetime");
    assert!(runs["sole-viewer"].browsers.is_empty());
    assert_eq!(runs["shared-viewers"].browsers, HashSet::from([8]));
}

/// An agent socket blip must not cost the user a live run: the subprocess on
/// the agent never stopped, so the hub holds the run (lock included) and the
/// reconnecting agent reclaims it by declaring it on `register`.
#[tokio::test]
async fn a_reconnecting_agent_reclaims_the_runs_it_still_drives() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.lock_by_key["machine-1::session-1"].clone();
    drain(&mut ui_rx);

    hub.on_disconnect(AGENT_CONN);

    assert!(
        hub.runs.contains_key(&run_id),
        "the run must survive the blip"
    );
    assert!(
        hub.lock_by_key.contains_key("machine-1::session-1"),
        "holding the lock is what stops a second writer during the grace",
    );
    assert!(
        !drain(&mut ui_rx)
            .iter()
            .any(|m| m["type"] == "run_status" && m["state"] == "error"),
        "viewers must not be told a run died that is still running",
    );

    // The agent comes back and declares the run it kept driving.
    hub.settle_agent_runs(
        AGENT_CONN,
        "machine-1",
        "Machine",
        &[declared(&run_id, "session-1", Some("/repo"))],
    );
    assert!(hub.runs.contains_key(&run_id));
    assert!(
        hub.orphaned_runs.is_empty(),
        "a reclaimed run is no longer orphaned"
    );

    // A later grace expiry for that dead socket must not touch it.
    hub.release_orphaned_runs(AGENT_CONN, "machine-1");
    assert!(
        hub.runs.contains_key(&run_id),
        "grace must not reap a reclaimed run"
    );
}

/// The other half: an agent that comes back WITHOUT a run (it restarted, or
/// the subprocess died) frees the lock immediately, and a grace that expires
/// with nobody reclaiming releases the run and tells its viewers.
#[tokio::test]
async fn unreclaimed_runs_are_released_and_reported() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.lock_by_key["machine-1::session-1"].clone();
    drain(&mut ui_rx);

    hub.on_disconnect(AGENT_CONN);
    // Reconnect declaring nothing: the agent no longer has this run.
    hub.settle_agent_runs(AGENT_CONN, "machine-1", "Machine", &[]);

    assert!(!hub.runs.contains_key(&run_id));
    assert!(
        !hub.lock_by_key.contains_key("machine-1::session-1"),
        "a run the agent disowned must free its session lock at once",
    );
    let errors: Vec<Value> = drain(&mut ui_rx)
        .into_iter()
        .filter(|m| m["type"] == "run_status" && m["state"] == "error")
        .collect();
    assert_eq!(errors.len(), 1, "viewers learn the run is gone");
    assert_eq!(errors[0]["runId"], json!(run_id));
}

/// The bug of 21.09.2026: the hub opened run b1c58d7e, the agent never got
/// as far as driving it and never said so, and because the socket stayed up
/// nothing reconciled. The run sat `working` with its lock held for four
/// hours, until a deploy restarted the hub. The phone showed a turn that was
/// never coming.
#[tokio::test]
async fn a_run_the_agent_does_not_hold_is_closed_and_its_lock_freed() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.lock_by_key["machine-1::session-1"].clone();
    // Age it past the start-race grace: the agent has had its say.
    hub.runs.get_mut(&run_id).unwrap().opened_at = now_ms() - RUN_RECONCILE_GRACE_MS - 1;
    drain(&mut ui_rx);
    drain(&mut agent_rx);

    hub.on_agent_msg(AGENT_CONN, json!({"type":"run_inventory","runIds":[]}));

    assert!(!hub.runs.contains_key(&run_id), "the run is forgotten");
    assert!(
        !hub.lock_by_key.contains_key("machine-1::session-1"),
        "and the session is writable again — a lock held for a run nobody \
             drives is what makes the session look permanently busy",
    );
    let errors: Vec<Value> = drain(&mut ui_rx)
        .into_iter()
        .filter(|m| m["type"] == "run_status" && m["state"] == "error")
        .collect();
    assert_eq!(errors.len(), 1, "the viewer is told, instead of waiting");
    assert_eq!(errors[0]["runId"], json!(run_id));
    // The order that keeps the single-writer invariant: the agent is told to
    // close BEFORE we free the lock, so a start still in flight is cancelled
    // rather than left to launch a writer nothing guards.
    let closes: Vec<Value> = drain(&mut agent_rx)
        .into_iter()
        .filter(|m| m["type"] == "close")
        .collect();
    assert_eq!(closes.len(), 1, "the agent is ordered to drop it too");
    assert_eq!(closes[0]["runId"], json!(run_id));
}

/// The start race, which is the only way a HEALTHY machine is legitimately
/// missing from its own inventory: the hub has opened the run and the agent
/// is still in its pre-launch liveness and transcript-size checks. On a box
/// under memory pressure those took minutes — closing the run there would
/// kill the session the person just asked for.
#[tokio::test]
async fn a_freshly_opened_run_survives_an_inventory_that_lacks_it() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.lock_by_key["machine-1::session-1"].clone();
    drain(&mut ui_rx);

    hub.on_agent_msg(AGENT_CONN, json!({"type":"run_inventory","runIds":[]}));

    assert!(
        hub.runs.contains_key(&run_id),
        "inside the grace the agent has not had time to answer yet",
    );
    assert!(hub.lock_by_key.contains_key("machine-1::session-1"));
}

/// An agent too old to send `runIds` has no opinion, and no opinion must not
/// read as "I drive nothing" — that would close every run on the machine on
/// its first heartbeat. Half the fleet runs a bundle older than this change.
#[tokio::test]
async fn an_inventory_without_run_ids_changes_nothing() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.lock_by_key["machine-1::session-1"].clone();
    hub.runs.get_mut(&run_id).unwrap().opened_at = now_ms() - RUN_RECONCILE_GRACE_MS - 1;
    drain(&mut ui_rx);

    hub.on_agent_msg(AGENT_CONN, json!({"type":"run_inventory"}));

    assert!(
        hub.runs.contains_key(&run_id),
        "a silent agent is not evidence that the run is dead",
    );
}

/// The everyday case: the agent lists the run it is driving, and a long
/// quiet turn is none of the reconciler's business.
#[tokio::test]
async fn a_run_the_agent_still_holds_is_left_alone() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.lock_by_key["machine-1::session-1"].clone();
    hub.runs.get_mut(&run_id).unwrap().opened_at = now_ms() - RUN_RECONCILE_GRACE_MS - 1;
    drain(&mut ui_rx);

    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"run_inventory","runIds":[run_id.clone()]}),
    );

    assert!(hub.runs.contains_key(&run_id));
    assert!(
        drain(&mut ui_rx).into_iter().all(|m| m["state"] != "error"),
        "a live run must not be disturbed by the sweep",
    );
}

/// A superseded socket reports the runs IT holds — usually none. Acting on
/// that would let a dead connection close the live agent's work.
#[tokio::test]
async fn an_inventory_from_a_superseded_socket_is_ignored() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.lock_by_key["machine-1::session-1"].clone();
    hub.runs.get_mut(&run_id).unwrap().opened_at = now_ms() - RUN_RECONCILE_GRACE_MS - 1;
    drain(&mut ui_rx);

    // The machine's current socket is someone else now.
    const NEW_AGENT_CONN: ConnId = 43;
    let (new_tx, _new_rx) = channel(128);
    hub.conns.insert(NEW_AGENT_CONN, new_tx);
    hub.conn_machine.insert(NEW_AGENT_CONN, "machine-1".into());
    if let Some(agent) = hub.agents.get_mut("machine-1") {
        agent.conn = NEW_AGENT_CONN;
    }

    hub.on_agent_msg(AGENT_CONN, json!({"type":"run_inventory","runIds":[]}));

    assert!(
        hub.runs.contains_key(&run_id),
        "only the machine's current connection may retire its runs",
    );
}

/// Regression guard for the supersede branch. When an agent's re-register is
/// processed BEFORE its old socket's close, the hub used to blanket-release
/// every run on the machine ("agent reconnected") — which silently undid the
/// whole re-adoption path, because this is the ordering the logs show most.
#[tokio::test]
async fn a_superseding_register_keeps_the_runs_the_agent_declares() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.lock_by_key["machine-1::session-1"].clone();
    drain(&mut ui_rx);

    // No Disconnected processed yet: the agent dials in on a fresh conn and
    // declares the run it never stopped driving.
    const NEW_AGENT_CONN: ConnId = 42;
    let (new_tx, _new_rx) = channel(128);
    hub.conns.insert(NEW_AGENT_CONN, new_tx);
    hub.on_agent_msg(
        NEW_AGENT_CONN,
        json!({
            "type": "register",
            "protocol": 1,
            "machine": {
                "machineId": "machine-1",
                "name": "Machine",
                "os": "linux",
                "agentVersion": "test",
            },
            "liveRuns": [{ "runId": run_id, "sessionId": "session-1" }],
        }),
    );

    assert!(
        hub.runs.contains_key(&run_id),
        "a supersede must not kill a run the agent is still driving",
    );
    assert!(hub.lock_by_key.contains_key("machine-1::session-1"));
    assert!(!drain(&mut ui_rx)
        .iter()
        .any(|m| m["type"] == "run_status" && m["state"] == "error"),);
}

/// Closing a run from one client must not leave its other viewers staring at
/// a composer that went quiet. They used to get NOTHING: `release_run` drops
/// the run before the agent's `ended` arrives, and `to_run_browsers` then has
/// no run to deliver it to.
#[tokio::test]
async fn closing_a_run_tells_everyone_watching_it_why() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.lock_by_key["machine-1::session-1"].clone();
    drain(&mut ui_rx);

    hub.end_run(&run_id, "closed from a Hegai Code client");

    let told: Vec<Value> = drain(&mut ui_rx)
        .into_iter()
        .filter(|m| m["type"] == "run_status")
        .collect();
    assert_eq!(told.len(), 1, "the viewer must hear about it exactly once");
    assert_eq!(told[0]["state"], json!("ended"));
    assert_eq!(told[0]["error"], json!("closed from a Hegai Code client"));
    assert_eq!(told[0]["runId"], json!(run_id));
    assert!(
        !hub.runs.contains_key(&run_id),
        "and the run is still released"
    );
    assert!(!hub.lock_by_key.contains_key("machine-1::session-1"));
}

/// A run that ENDS while it is waiting on a person must leave the counters.
///
/// `end_run`/`fail_run` told only the clients attached to that run, through
/// `run_status`. Every other UI — a second tab, the board, and the desktop
/// shell's tray socket, which is attached to no run at all — heard nothing
/// and kept the dead run in its list at its LAST state. When that state was
/// `needs_attention` the tray badge sat at «1 ждёт ответа» with nothing
/// anywhere to answer, until some unrelated run happened to change state.
/// Reported from a menu bar showing 1 against a hub holding zero.
///
/// `release_machine_runs` already broadcast for exactly this reason — its
/// own comment says «so dead cards don't linger on other UIs». These two
/// paths simply never got it.
#[tokio::test]
async fn a_run_that_ends_while_waiting_leaves_the_counters() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.lock_by_key["machine-1::session-1"].clone();
    hub.runs.get_mut(&run_id).unwrap().state = "needs_attention".into();
    drain(&mut ui_rx);

    hub.end_run(&run_id, "closed from a Hegai Code client");

    let seen = drain(&mut ui_rx);
    let activity = seen
        .iter()
        .find(|m| m["type"] == "activity")
        .expect("every UI has to hear that the run is gone, not just its viewers");
    assert_eq!(
        activity["runs"].as_array().map(Vec::len),
        Some(0),
        "and the list it hears must no longer carry the run"
    );
}

fn declared(run_id: &str, session_id: &str, cwd: Option<&str>) -> DeclaredRun {
    DeclaredRun {
        run_id: run_id.into(),
        session_id: session_id.into(),
        cwd: cwd.map(str::to_string),
    }
}

/// The hub-restart shape: our `runs` are empty (a deploy restarts the
/// process) but the agent still declares a run whose subprocess is writing.
///
/// This used to be ordered closed, which is how every hub deploy silently
/// killed every live run in the fleet. It must be adopted instead — AND the
/// single-writer lock taken in the same step, because a run in `runs` with
/// no `lock_by_key` entry is exactly the unguarded writer the old code was
/// right to fear.
#[tokio::test]
async fn a_run_the_hub_never_heard_of_is_adopted_with_its_lock() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    const NEW_AGENT_CONN: ConnId = 43;
    let (new_tx, mut new_rx) = channel(128);
    hub.conns.insert(NEW_AGENT_CONN, new_tx);
    assert!(hub.runs.is_empty(), "a restarted hub starts with no runs");

    hub.settle_agent_runs(
        NEW_AGENT_CONN,
        "machine-1",
        "Machine",
        &[declared("carried-run", "session-1", Some("/repo"))],
    );

    assert!(
        !drain(&mut new_rx).iter().any(|m| m["type"] == "close"),
        "a carried run must not be ordered closed",
    );
    let run = hub.runs.get("carried-run").expect("the run is adopted");
    assert_eq!(run.session_id, "session-1");
    assert_eq!(run.cwd.as_deref(), Some("/repo"));
    assert_eq!(run.project.as_deref(), Some("repo"));
    assert_eq!(
        hub.lock_by_key.get("machine-1::session-1"),
        Some(&"carried-run".to_string()),
        "adoption without the lock would allow a second writer",
    );
}

/// A hub restart re-adopts an idle run. Its `since` is the stored finish, not
/// the restart: a device that last saw the run working would otherwise light
/// a dot at a time no earlier read mark covers (an answer already read on the
/// web came back unread after every deploy).
#[tokio::test]
async fn an_adopted_idle_run_keeps_its_stored_finish_time() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    const NEW_AGENT_CONN: ConnId = 43;
    let (new_tx, _new_rx) = channel(128);
    hub.conns.insert(NEW_AGENT_CONN, new_tx);
    hub.workspaces
        .record_session_owner("machine-1", "session-1", "owner", None)
        .unwrap();
    hub.workspaces
        .session_completion_upsert("owner", "machine-1", "session-1", 1_000, 10)
        .unwrap();
    hub.settle_agent_runs(
        NEW_AGENT_CONN,
        "machine-1",
        "Machine",
        &[declared("carried-run", "session-1", Some("/repo"))],
    );
    let run = hub.runs.get("carried-run").expect("adopted");
    assert_eq!(run.owner_user_id.as_deref(), Some("owner"));
    assert_eq!(run.since, 1_000);
}

/// The one case where adoption really would create a second writer: the hub
/// already locked that session for a different run. Then, and only then, the
/// declared run is ordered closed.
#[tokio::test]
async fn a_carried_run_whose_session_is_already_locked_is_closed() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let holder = hub.lock_by_key["machine-1::session-1"].clone();

    const NEW_AGENT_CONN: ConnId = 45;
    let (new_tx, mut new_rx) = channel(128);
    hub.conns.insert(NEW_AGENT_CONN, new_tx);
    // The agent declares the run we already hold (kept, as always) AND a
    // second one claiming the same session. Only the second is a problem.
    hub.settle_agent_runs(
        NEW_AGENT_CONN,
        "machine-1",
        "Machine",
        &[
            declared(&holder, "session-1", Some("/repo")),
            declared("intruder", "session-1", Some("/repo")),
        ],
    );

    let closes: Vec<Value> = drain(&mut new_rx)
        .into_iter()
        .filter(|m| m["type"] == "close")
        .collect();
    assert_eq!(closes.len(), 1, "the second writer must be stopped");
    assert_eq!(closes[0]["runId"], json!("intruder"));
    assert!(!hub.runs.contains_key("intruder"));
    assert_eq!(
        hub.lock_by_key["machine-1::session-1"], holder,
        "the original holder keeps the lock",
    );
}

/// A run that cannot be rebuilt well enough to be locked or made visible: no
/// session id (a `new_session` that never got one), or an agent too old to
/// declare a cwd. Closing these is the honest outcome — an adopted run with
/// no cwd would be invisible to the project-share filter anyway.
#[tokio::test]
async fn a_carried_run_that_cannot_be_rebuilt_is_closed() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    const NEW_AGENT_CONN: ConnId = 46;
    let (new_tx, mut new_rx) = channel(128);
    hub.conns.insert(NEW_AGENT_CONN, new_tx);

    hub.settle_agent_runs(
        NEW_AGENT_CONN,
        "machine-1",
        "Machine",
        &[
            declared("no-session", "", Some("/repo")),
            declared("no-cwd", "session-9", None),
        ],
    );

    let closed: Vec<String> = drain(&mut new_rx)
        .into_iter()
        .filter(|m| m["type"] == "close")
        .map(|m| m["runId"].as_str().unwrap_or("").to_string())
        .collect();
    assert_eq!(closed, vec!["no-session", "no-cwd"]);
    assert!(hub.runs.is_empty());
    assert!(
        hub.lock_by_key.is_empty(),
        "no half-built locks left behind"
    );
}

/// A straggler from the superseded socket must not settle a reclaimed run:
/// `run_status: ended` releases the run and frees its session lock, which
/// would strand the agent's still-writing subprocess without one.
#[tokio::test]
async fn a_superseded_socket_cannot_settle_a_reclaimed_run() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.lock_by_key["machine-1::session-1"].clone();

    // A newer socket takes over the machine.
    const NEW_AGENT_CONN: ConnId = 44;
    let (new_tx, _new_rx) = channel(128);
    hub.conns.insert(NEW_AGENT_CONN, new_tx);
    hub.conn_machine.insert(NEW_AGENT_CONN, "machine-1".into());
    if let Some(a) = hub.agents.get_mut("machine-1") {
        a.conn = NEW_AGENT_CONN;
    }

    // The dead socket's queued frame lands late.
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"run_status","runId":run_id,"sessionId":"session-1","state":"ended"}),
    );

    assert!(
        hub.runs.contains_key(&run_id),
        "a fenced frame must not end the run"
    );
    assert!(
        hub.lock_by_key.contains_key("machine-1::session-1"),
        "and must not free the session lock",
    );

    // The same frame from the live socket still works.
    hub.on_agent_msg(
        NEW_AGENT_CONN,
        json!({"type":"run_status","runId":run_id,"sessionId":"session-1","state":"ended"}),
    );
    assert!(!hub.runs.contains_key(&run_id));
}

/// Older agent bundles still kill their runs the moment the socket drops, so
/// there is nothing to re-adopt — holding their locks for the lease would
/// strand the session for a minute. They are recognised by never having
/// reported a process id.
#[tokio::test]
async fn a_legacy_agent_still_gets_the_immediate_release() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    hub.agent_instance.remove("machine-1");
    open(&mut hub, false);
    let run_id = hub.lock_by_key["machine-1::session-1"].clone();
    drain(&mut ui_rx);

    hub.on_disconnect(AGENT_CONN);

    assert!(
        !hub.runs.contains_key(&run_id),
        "no lease for an agent that self-kills"
    );
    assert!(!hub.lock_by_key.contains_key("machine-1::session-1"));
    assert!(hub.orphaned_runs.is_empty());
    assert!(drain(&mut ui_rx)
        .iter()
        .any(|m| m["type"] == "run_status" && m["state"] == "error"),);
}

#[tokio::test]
async fn an_expired_grace_releases_a_run_nobody_reclaimed() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.lock_by_key["machine-1::session-1"].clone();
    drain(&mut ui_rx);

    hub.on_disconnect(AGENT_CONN);
    hub.release_orphaned_runs(AGENT_CONN, "machine-1");

    assert!(!hub.runs.contains_key(&run_id));
    assert!(!hub.lock_by_key.contains_key("machine-1::session-1"));
    assert!(hub.orphaned_runs.is_empty());
    assert!(
        drain(&mut ui_rx)
            .iter()
            .any(|m| m["type"] == "run_status" && m["state"] == "error"),
        "an unreclaimed run must not vanish silently",
    );
}

/// A session that stopped on a question — a tool approval, a plan to confirm
/// — used to be unanswerable by anyone but its original owner: the prompt was
/// routed to them alone, so a colleague continuing the session saw a paused
/// run and no way to unpause it.
#[test]
fn whoever_picks_up_a_paused_session_can_answer_its_question() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    // The run belongs to someone else — a teammate, not this connection.
    if let Some(run) = hub.runs.get_mut(&run_id) {
        run.owner_user_id = Some("teammate".into());
    }
    let mut mate_rx = add_colleague(&mut hub, 7);
    hub.on_ui_msg(7, json!({"type":"subscribe","runId":run_id}));
    drain(&mut ui_rx);
    drain(&mut mate_rx);

    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"tool_request","runId":run_id,"sessionId":"session-1",
                   "requestId":"req-1","tool":"Bash","input":{"command":"ls"},"title":"List"}),
    );
    let asked = |rx: &mut Receiver<String>| {
        drain(rx)
            .iter()
            .any(|m| m["type"] == "tool_request" && m["requestId"] == "req-1")
    };
    assert!(asked(&mut mate_rx), "the colleague must see the question");

    // And someone attaching after the run already stopped on it inherits it.
    let mut late_rx = add_colleague(&mut hub, 8);
    hub.on_ui_msg(8, json!({"type":"subscribe","runId":run_id}));
    assert!(
        asked(&mut late_rx),
        "a client attaching to an already-paused run must inherit the prompt",
    );
}

/// The question goes to everyone who may answer it, so the ANSWER has to as
/// well. It did not: whoever pressed the button cleared their own modal and
/// every other viewer kept the prompt — a second tab, a phone, or the shell
/// behind a pane of the split, which is why one plan looked like two.
#[test]
fn answering_a_question_closes_it_for_every_other_viewer() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    let mut mate_rx = add_colleague(&mut hub, 7);
    hub.on_ui_msg(7, json!({"type":"subscribe","runId":run_id}));
    drain(&mut ui_rx);
    drain(&mut mate_rx);

    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"tool_request","runId":run_id,"sessionId":"session-1",
                   "requestId":"req-1","tool":"ExitPlanMode","input":{"plan":"do it"}}),
    );
    drain(&mut ui_rx);
    drain(&mut mate_rx);
    drain(&mut agent_rx);

    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"tool_decision","runId":run_id,"requestId":"req-1","allow":true}),
    );
    let resolved = |rx: &mut Receiver<String>| {
        drain(rx)
            .iter()
            .any(|m| m["type"] == "tool_resolved" && m["requestId"] == "req-1")
    };
    assert!(
        resolved(&mut mate_rx),
        "the viewer who did NOT answer must be told the question is settled",
    );
    assert!(
        drain(&mut agent_rx)
            .iter()
            .any(|m| m["type"] == "tool_decision"),
        "the decision still reaches the agent",
    );
    assert!(hub.runs[&run_id].pending_request_id.is_none());
}

/// The composer's model / mode / effort pickers had no way back to the truth:
/// `set_model` and `set_effort` only travel outward, so every reload showed
/// "default" for a run that was on something else entirely.
#[test]
fn a_late_subscriber_is_told_what_the_run_is_actually_set_to() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();

    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"run_mode","runId":run_id,"sessionId":"session-1","mode":"plan"}),
    );
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"run_settings","runId":run_id,"sessionId":"session-1",
                   "model":"opus","activeModel":"claude-opus-5","effort":"xhigh"}),
    );
    drain(&mut ui_rx); // the client that started the run already saw both

    hub.on_ui_msg(UI_CONN, json!({"type":"subscribe","runId":run_id}));
    let seen = drain(&mut ui_rx);
    let mode = seen.iter().find(|m| m["type"] == "run_mode");
    let settings = seen.iter().find(|m| m["type"] == "run_settings");
    assert_eq!(
        mode.map(|m| m["mode"].clone()),
        Some(json!("plan")),
        "a late subscriber must be told the run's permission mode",
    );
    let settings = settings.expect("a late subscriber must be told the run's settings");
    assert_eq!(settings["model"], json!("opus"));
    assert_eq!(settings["activeModel"], json!("claude-opus-5"));
    assert_eq!(settings["effort"], json!("xhigh"));
    // Absent, never null — the web zod schemas read optional as `T | absent`.
    assert!(settings.get("ultracode").is_none());
}

/// Opening a session while its turn is in flight used to show nothing: the
/// hub replayed no backlog and the transcript on disk has no in-flight turn,
/// so the pane stayed empty until you left and came back.
#[test]
fn a_client_attaching_mid_turn_is_shown_the_turn_so_far() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    let stream = |kind: &str, text: &str| {
        json!({"type":"stream","runId":run_id,"sessionId":"session-1",
                   "event":{"kind":kind,"text":text}})
    };

    hub.on_agent_msg(AGENT_CONN, stream("tool_use", "Read README.md"));
    hub.on_agent_msg(AGENT_CONN, stream("assistant", "первый кусок"));
    drain(&mut ui_rx); // the client that started the run already saw both

    hub.on_ui_msg(UI_CONN, json!({"type":"subscribe","runId":run_id}));
    let replayed: Vec<String> = drain(&mut ui_rx)
        .into_iter()
        .filter(|m| m["type"] == "stream")
        .map(|m| m["event"]["text"].as_str().unwrap_or_default().to_string())
        .collect();
    assert_eq!(
        replayed,
        vec!["Read README.md".to_string(), "первый кусок".to_string()],
        "a late subscriber must receive the turn's frames, in order",
    );

    // Once the turn lands the transcript is the record — replaying it again
    // would double what the client reads from disk.
    hub.on_agent_msg(AGENT_CONN, stream("result", "done"));
    drain(&mut ui_rx);
    hub.on_ui_msg(UI_CONN, json!({"type":"subscribe","runId":run_id}));
    assert!(
        !drain(&mut ui_rx).iter().any(|m| m["type"] == "stream"),
        "a finished turn must not be replayed",
    );
}

/// A long turn used to fill the replay window with one frame per token, and
/// every open of the session replayed them all: the client folded hundreds of
/// frames and the steps visibly played back from the start (24.10.2026). The
/// window now holds what the client will end up showing, in fewer frames.
#[test]
fn the_replay_window_folds_deltas_and_keeps_one_heartbeat_per_code() {
    // `session_state` is not a heartbeat here: web reads `running` as an event.
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    let ev = |event: Value| json!({"type":"stream","runId":run_id,"sessionId":"session-1","event":event});
    let usage = |n: u64| {
        ev(json!({"kind":"status","code":"turn_usage","text":"","data":{"totalTokens":n}}))
    };

    hub.on_agent_msg(
        AGENT_CONN,
        ev(json!({"kind":"tool_use","text":"Read a.md"})),
    );
    hub.on_agent_msg(AGENT_CONN, usage(100));
    hub.on_agent_msg(AGENT_CONN, ev(json!({"kind":"partial","text":"Пер"})));
    hub.on_agent_msg(AGENT_CONN, ev(json!({"kind":"partial","text":"вый"})));
    // A status between deltas does not close the sentence, and one the client
    // shows stays after it.
    hub.on_agent_msg(
        AGENT_CONN,
        ev(json!({"kind":"status","code":"requesting","text":""})),
    );
    hub.on_agent_msg(
        AGENT_CONN,
        ev(json!({"kind":"status","code":"api_retry","text":"повтор"})),
    );
    hub.on_agent_msg(AGENT_CONN, ev(json!({"kind":"assistant","text":"Первый"})));
    hub.on_agent_msg(AGENT_CONN, usage(250));
    hub.on_agent_msg(AGENT_CONN, ev(json!({"kind":"tool_use","text":"Bash ls"})));
    // The sentence in progress: its deltas are one frame.
    hub.on_agent_msg(
        AGENT_CONN,
        ev(json!({"kind":"status","code":"session_state","text":"","data":{"state":"running"}})),
    );
    for piece in ["Вто", "рой \"", "ход\"\n"] {
        hub.on_agent_msg(AGENT_CONN, ev(json!({"kind":"partial","text":piece})));
    }
    hub.on_agent_msg(
        AGENT_CONN,
        ev(json!({"kind":"status","code":"requesting","text":""})),
    );
    drain(&mut ui_rx);

    hub.on_ui_msg(UI_CONN, json!({"type":"subscribe","runId":run_id}));
    let replayed: Vec<String> = drain(&mut ui_rx)
        .into_iter()
        .filter(|m| m["type"] == "stream")
        .map(|m| {
            let e = &m["event"];
            let code = e["code"].as_str().unwrap_or_default();
            let tokens = e["data"]["totalTokens"]
                .as_u64()
                .map(|n| format!(" {n}"))
                .unwrap_or_default();
            format!(
                "{}{}{}:{}",
                e["kind"].as_str().unwrap(),
                if code.is_empty() { "" } else { "/" },
                code,
                e["text"].as_str().unwrap_or_default()
            ) + &tokens
        })
        .collect();
    assert_eq!(
        replayed,
        vec![
            "tool_use:Read a.md",
            "assistant:Первый",
            "status/api_retry:повтор",
            "status/turn_usage: 250",
            "tool_use:Bash ls",
            "status/session_state:",
            "partial:Второй \"ход\"\n",
            "status/requesting:",
        ],
    );
    let run = &hub.runs[&run_id];
    let bytes: usize = run.replay.iter().map(|f| f.to_string().len()).sum();
    assert_eq!(
        run.replay_bytes, bytes,
        "the byte budget tracks the folded frames"
    );
}

#[test]
fn the_agent_picker_is_honoured_but_a_member_stays_on_codex() {
    let (mut hub, _ui_rx, mut agent_rx) = test_hub(session(None));
    let started = |rx: &mut Receiver<String>| -> Value {
        drain(rx)
            .into_iter()
            .find(|m| m["type"] == "new_session")
            .expect("the agent must be told to start a session")
    };

    hub.new_session(
        UI_CONN,
        &json!({"machineId":"machine-1","cwd":"/repo","message":"x","source":"codex"}),
    );
    assert_eq!(started(&mut agent_rx)["source"], "codex", "the pick wins");

    hub.new_session(
        UI_CONN,
        &json!({"machineId":"machine-1","cwd":"/repo","message":"x"}),
    );
    assert!(
        started(&mut agent_rx).get("source").is_none(),
        "no pick means Claude, the agent's own default",
    );

    hub.new_session(
        UI_CONN,
        &json!({"machineId":"machine-1","cwd":"/repo","message":"x","source":"nonsense"}),
    );
    assert!(
        started(&mut agent_rx).get("source").is_none(),
        "an unknown source is dropped, not forwarded",
    );

    // A member on a colleague's machine (control-share) is pinned.
    seat_as_team_member(&mut hub);
    hub.new_session(
        UI_CONN,
        &json!({"machineId":"machine-1","cwd":"/repo","message":"x","source":"claude"}),
    );
    assert_eq!(
        started(&mut agent_rx)["source"],
        "codex",
        "an employee asking for Claude would spend the device owner's login",
    );
}

/// The `member` role alone is not the trigger: a member on a machine they
/// own themselves (their own sandbox, in their personal workspace) spends
/// their own login, so the picker stays theirs.
#[test]
fn a_device_owner_member_is_not_pinned_to_codex() {
    let (mut hub, _ui_rx, mut agent_rx) = test_hub(session(None));
    if let Some(access) = hub.ui_access.get_mut(&UI_CONN) {
        access.role = "member".into();
    }
    hub.new_session(
        UI_CONN,
        &json!({"machineId":"machine-1","cwd":"/repo","message":"x","source":"claude"}),
    );
    assert_eq!(started_source(&mut agent_rx)["source"], "claude");
    hub.new_session(
        UI_CONN,
        &json!({"machineId":"machine-1","cwd":"/repo","message":"x"}),
    );
    assert!(started_source(&mut agent_rx).get("source").is_none());
}

/// A hosted sandbox has no Claude login: every new session there goes to
/// Codex on the gateway whoever asks, and the snapshot says what it is.
#[test]
fn a_sandbox_owner_is_not_pinned_to_codex() {
    let (mut hub, _ui_rx, mut agent_rx) = test_hub(session(None));
    assert!(
        hub.snapshot_for(UI_CONN)["machines"][0]
            .get("kind")
            .is_none(),
        "a personal device omits `kind` (optional = absent)",
    );
    hub.workspaces
        .conn
        .lock()
        .unwrap()
        .execute(
            "UPDATE devices SET kind='sandbox' WHERE machine_id='machine-1'",
            [],
        )
        .unwrap();
    assert_eq!(hub.snapshot_for(UI_CONN)["machines"][0]["kind"], "sandbox");
    hub.new_session(
        UI_CONN,
        &json!({"machineId":"machine-1","cwd":"/repo","message":"x","source":"claude"}),
    );
    assert_eq!(
            started_source(&mut agent_rx)["source"], "claude",
            "the owner of a sandbox picks the runtime like on any machine — Claude logs in there too since 24.09.2026",
        );
}

/// Until activation the product is the waiting screen: no machines in the
/// snapshot (not even control-shares), no runs, and every frame that
/// would touch a machine is refused with the reason.
#[test]
fn a_waitlisted_viewer_sees_nothing_and_cannot_start() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    if let Some(access) = hub.ui_access.get_mut(&UI_CONN) {
        access.access_state = "waitlist".into();
    }
    let snap = hub.snapshot_for(UI_CONN);
    assert_eq!(snap["machines"].as_array().unwrap().len(), 0);
    assert_eq!(snap["activeRuns"].as_array().unwrap().len(), 0);
    drain(&mut ui_rx);
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"new_session","machineId":"machine-1","cwd":"/repo","message":"x"}),
    );
    let refusal = drain(&mut ui_rx)
        .into_iter()
        .find(|m| m["type"] == "error")
        .expect("the frame is refused, not dropped");
    assert_eq!(
        refusal["message"],
        "Доступ ещё не открыт — вы в списке ожидания."
    );
    assert!(drain(&mut agent_rx).is_empty(), "nothing reaches the agent");
    // The socket-keeping frames still pass.
    hub.on_ui_msg(UI_CONN, json!({"type":"hello","client":"web"}));
    assert!(drain(&mut ui_rx).iter().all(|m| m["type"] != "error"));
    // Suspended wording differs.
    if let Some(access) = hub.ui_access.get_mut(&UI_CONN) {
        access.access_state = "suspended".into();
    }
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"open","machineId":"machine-1","sessionId":"session-1"}),
    );
    let refusal = drain(&mut ui_rx)
        .into_iter()
        .find(|m| m["type"] == "error")
        .unwrap();
    assert_eq!(refusal["message"], "Доступ приостановлен.");
}

/// The fleet token is the legacy escape; with CC_REMOTE_FLEET_MACHINE_IDS
/// set, a machine outside the list is turned away at `register`.
#[test]
fn a_fleet_token_agent_outside_the_allowlist_is_refused_at_register() {
    let (mut hub, _ui_rx, mut agent_rx) = test_hub(session(None));
    hub.fleet_machine_ids = Some(["allowed-box".to_string()].into_iter().collect());
    // A fleet-token socket: authorized machine is the empty sentinel.
    hub.agent_users
        .insert(AGENT_CONN, ("owner".into(), Some(String::new())));
    hub.on_agent_msg(
            AGENT_CONN,
            json!({"type":"register","machine":{"machineId":"machine-1","name":"Machine","os":"linux","agentVersion":"test"}}),
        );
    let refusal = drain(&mut agent_rx)
        .into_iter()
        .find(|m| m["type"] == "error")
        .expect("the registration is refused");
    assert!(refusal["message"].as_str().unwrap().contains("fleet token"));
    assert!(
        !hub.conns.contains_key(&AGENT_CONN),
        "the socket is dropped"
    );

    // A device-token socket is never subject to the fleet list.
    let (mut hub, _ui_rx, mut agent_rx) = test_hub(session(None));
    hub.fleet_machine_ids = Some(["allowed-box".to_string()].into_iter().collect());
    hub.agent_users
        .insert(AGENT_CONN, ("owner".into(), Some("machine-1".into())));
    hub.on_agent_msg(
            AGENT_CONN,
            json!({"type":"register","machine":{"machineId":"machine-1","name":"Machine","os":"linux","agentVersion":"test"}}),
        );
    assert!(drain(&mut agent_rx).iter().all(|m| m["type"] != "error"));
    assert!(hub.conns.contains_key(&AGENT_CONN));
}

/// What a machine's runtimes ARE travels like `usage`: stored on the
/// machine, fanned privately, kept across a reconnect that does not
/// restate it, replaced by one that does. And never invented — an agent
/// that has not said stays absent (the browser draws «нет данных»).
#[test]
fn runtime_status_is_stored_fanned_privately_and_kept_across_reconnect() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    hub.agent_users
        .insert(AGENT_CONN, ("owner".into(), Some("machine-1".into())));
    let snap = hub.snapshot_for(UI_CONN);
    assert!(
        snap["machines"][0].get("runtimes").is_none(),
        "an agent that never said has no field — absent, never null"
    );

    let first = json!({"codex":{"present":false,"auth":"none","provider":"own","error":"not_found","checkedAt":1},
                           "claude":{"present":true,"auth":"oauth","account":"ilya@example.com","checkedAt":1}});
    drain(&mut ui_rx);
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"runtime_status","runtimes":first}),
    );
    let fanned = drain(&mut ui_rx)
        .into_iter()
        .find(|m| m["type"] == "runtime_status")
        .expect("controllers hear the delta");
    assert_eq!(fanned["machineId"], "machine-1");
    assert_eq!(fanned["runtimes"]["codex"]["error"], "not_found");
    assert_eq!(hub.snapshot_for(UI_CONN)["machines"][0]["runtimes"], first);

    // A reconnect without the field keeps the last reading…
    hub.on_agent_msg(
            AGENT_CONN,
            json!({"type":"register","machine":{"machineId":"machine-1","name":"Machine","os":"linux","agentVersion":"test"}}),
        );
    assert_eq!(hub.snapshot_for(UI_CONN)["machines"][0]["runtimes"], first);

    // …and one that restates it wins.
    let second = json!({"codex":{"present":true,"auth":"chatgpt","account":"ilya@example.com","plan":"plus","provider":"own","checkedAt":2}});
    hub.on_agent_msg(
            AGENT_CONN,
            json!({"type":"register","machine":{"machineId":"machine-1","name":"Machine","os":"linux","agentVersion":"test"},"runtimes":second}),
        );
    assert_eq!(hub.snapshot_for(UI_CONN)["machines"][0]["runtimes"], second);
}

#[test]
fn paused_owner_gets_no_claude_quota_even_from_an_old_agent_but_codex_stays_live() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    hub.claude_monitoring_paused_owners.insert("owner".into());
    hub.agent_users
        .insert(AGENT_CONN, ("owner".into(), Some("machine-1".into())));
    let quota = json!({"updatedAt":1,"limits":[{"key":"session","label":"Session","percent":10}]});
    hub.agents.get_mut("machine-1").unwrap().usage = quota.clone();
    hub.on_agent_msg(AGENT_CONN, json!({"type":"register","agentInstanceId":"instance-1",
            "machine":{"machineId":"machine-1","name":"Machine","os":"linux","agentVersion":"test"}}));
    let ack = drain(&mut agent_rx)
        .into_iter()
        .find(|m| m["type"] == "register_ack")
        .unwrap();
    assert_eq!(ack["claudeUsageEnabled"], false);
    assert!(hub.agents["machine-1"].usage.is_null());
    drain(&mut ui_rx);
    hub.on_agent_msg(AGENT_CONN, json!({"type":"usage","usage":quota}));
    assert!(hub.agents["machine-1"].usage.is_null());
    assert!(!drain(&mut ui_rx).iter().any(|m| m["type"] == "usage"));
    assert!(hub.snapshot_for(UI_CONN)["machines"][0]
        .get("usage")
        .is_none());
    hub.on_agent_msg(AGENT_CONN, json!({"type":"codex_usage","usage":quota}));
    assert_eq!(hub.agents["machine-1"].codex_usage, quota);
    assert!(drain(&mut ui_rx).iter().any(|m| m["type"] == "codex_usage"));
}

#[test]
fn claude_quota_exception_enables_only_one_machine_and_can_be_removed() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    hub.claude_monitoring_paused_owners.insert("owner".into());
    hub.claude_usage_enabled_machines.insert("machine-1".into());
    hub.agent_users
        .insert(AGENT_CONN, ("owner".into(), Some("machine-1".into())));
    let register = json!({"type":"register","agentInstanceId":"instance-1",
            "machine":{"machineId":"machine-1","name":"Stage","os":"linux","agentVersion":"test"},
            "runtimes":{"claude":{"present":true,"auth":"oauth","account":"new@example.com","checkedAt":1}}});
    hub.on_agent_msg(AGENT_CONN, register.clone());
    let ack = drain(&mut agent_rx)
        .into_iter()
        .find(|m| m["type"] == "register_ack")
        .unwrap();
    assert_eq!(ack["claudeUsageEnabled"], true);

    // A second machine of the SAME owner stays paused, even with the
    // allowed machine's display name and provider account in its payload.
    let sibling = 3;
    let (tx, mut sibling_rx) = channel(128);
    hub.conns.insert(sibling, tx);
    hub.agent_users
        .insert(sibling, ("owner".into(), Some("machine-2".into())));
    hub.workspaces
        .register_legacy_device(
            "owner",
            &json!({
                "machineId":"machine-2","name":"Stage","os":"linux","agentVersion":"test"
            }),
        )
        .unwrap();
    hub.on_agent_msg(sibling, json!({"type":"register","agentInstanceId":"instance-2",
            "machine":{"machineId":"machine-2","name":"Stage","os":"linux","agentVersion":"test"},
            "runtimes":{"claude":{"present":true,"auth":"oauth","account":"new@example.com","checkedAt":1}}}));
    let ack = drain(&mut sibling_rx)
        .into_iter()
        .find(|m| m["type"] == "register_ack")
        .unwrap();
    assert_eq!(ack["claudeUsageEnabled"], false);
    assert!(!hub.claude_usage_enabled("unregistered-legacy-machine"));

    let quota = json!({"account":"new@example.com","updatedAt":1,
            "limits":[{"key":"session","label":"Session","percent":10}]});
    drain(&mut ui_rx);
    hub.on_agent_msg(AGENT_CONN, json!({"type":"usage","usage":quota}));
    assert_eq!(hub.agents["machine-1"].usage, quota);
    assert!(drain(&mut ui_rx)
        .iter()
        .any(|m| m["type"] == "usage" && m["machineId"] == "machine-1" && m["usage"] == quota));
    hub.on_agent_msg(sibling, json!({"type":"usage","usage":quota}));
    assert!(hub.agents["machine-2"].usage.is_null());
    assert!(!drain(&mut ui_rx).iter().any(|m| m["type"] == "usage"));

    // Removing the exception and reconnecting clears the old meter and
    // rejects subsequent readings, including those from older agents.
    hub.claude_usage_enabled_machines.remove("machine-1");
    hub.on_agent_msg(AGENT_CONN, register);
    let ack = drain(&mut agent_rx)
        .into_iter()
        .find(|m| m["type"] == "register_ack")
        .unwrap();
    assert_eq!(ack["claudeUsageEnabled"], false);
    assert!(hub.agents["machine-1"].usage.is_null());
    drain(&mut ui_rx);
    hub.on_agent_msg(AGENT_CONN, json!({"type":"usage","usage":quota}));
    assert!(hub.agents["machine-1"].usage.is_null());
    assert!(!drain(&mut ui_rx).iter().any(|m| m["type"] == "usage"));
}

#[test]
fn claude_pause_follows_authenticated_device_owner_and_can_be_removed() {
    let (mut hub, _ui_rx, mut agent_rx) = test_hub(session(None));
    hub.claude_monitoring_paused_owners
        .insert("another-owner".into());
    hub.agent_users
        .insert(AGENT_CONN, ("owner".into(), Some("machine-1".into())));
    let register = json!({"type":"register","agentInstanceId":"instance-1",
            "machine":{"machineId":"machine-1","name":"Machine","os":"linux","agentVersion":"test"},
            "runtimes":{"claude":{"account":"another-owner","present":true,"auth":"oauth","checkedAt":1}}});
    hub.on_agent_msg(AGENT_CONN, register.clone());
    let ack = drain(&mut agent_rx)
        .into_iter()
        .find(|m| m["type"] == "register_ack")
        .unwrap();
    assert_eq!(
        ack["claudeUsageEnabled"], true,
        "an agent-supplied account cannot choose the policy"
    );
    hub.claude_monitoring_paused_owners.insert("owner".into());
    assert!(!hub.claude_usage_enabled("machine-1"));
    hub.claude_monitoring_paused_owners.remove("owner");
    hub.on_agent_msg(AGENT_CONN, register);
    let ack = drain(&mut agent_rx)
        .into_iter()
        .find(|m| m["type"] == "register_ack")
        .unwrap();
    assert_eq!(ack["claudeUsageEnabled"], true);
    let quota = json!({"updatedAt":2});
    hub.on_agent_msg(AGENT_CONN, json!({"type":"usage","usage":quota}));
    assert_eq!(hub.agents["machine-1"].usage, quota);
    assert!(hub.claude_usage_enabled("unregistered-legacy-machine"));
    hub.claude_monitoring_paused_owners.insert("owner".into());
    assert!(
        !hub.claude_usage_enabled("unregistered-legacy-machine"),
        "legacy devices use the bootstrap owner"
    );
}

#[test]
fn paused_claude_failures_and_recoveries_are_silent_while_codex_alerts_continue() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    let healthy = json!({"claude":{"present":true,"auth":"oauth","checkedAt":1},
            "codex":{"present":true,"auth":"chatgpt","provider":"own","checkedAt":1}});
    hub.agents.get_mut("machine-1").unwrap().runtimes = healthy.clone();
    assert!(hub.observe_runtimes("machine-1", false).is_empty());
    let mut broken = healthy.clone();
    broken["claude"]["error"] = json!("token_rejected");
    hub.agents.get_mut("machine-1").unwrap().runtimes = broken.clone();
    assert_eq!(hub.observe_runtimes("machine-1", false).len(), 1);
    hub.claude_monitoring_paused_owners.insert("owner".into());
    hub.agents.get_mut("machine-1").unwrap().runtimes = healthy.clone();
    hub.claude_usage_enabled_machines.insert("machine-1".into());
    assert!(hub.claude_usage_enabled("machine-1"));
    assert!(
        hub.observe_runtimes("machine-1", false).is_empty(),
        "quota exception does not resume owner ops alerts"
    );
    broken["codex"]["error"] = json!("not_logged_in");
    hub.agents.get_mut("machine-1").unwrap().runtimes = broken;
    let said = hub.observe_runtimes("machine-1", false);
    assert_eq!(said.len(), 1);
    assert!(said[0].contains("Codex") && !said[0].contains("Claude"));
    assert!(hub.observe_runtimes("machine-1", false).is_empty());
    hub.agents.get_mut("machine-1").unwrap().runtimes = healthy;
    let said = hub.observe_runtimes("machine-1", false);
    assert_eq!(said.len(), 1);
    assert!(said[0].contains("Codex"));
}

/// Installing a coder and logging into one are the device owner's acts.
/// The owner's request is forwarded to the agent; a control-share member
/// — who may drive sessions inside a published root — is refused with a
/// sentence, not silently ignored.
#[test]
fn runtime_rpcs_are_for_the_device_owner_only() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    let req = |id: &str| {
        json!({"type":"rpc_request","requestId":id,"machineId":"machine-1",
                   "method":"runtime.login.start","params":{"runtime":"codex"}})
    };
    drain(&mut ui_rx);
    drain(&mut agent_rx);
    hub.on_ui_msg(UI_CONN, req("own"));
    let forwarded = drain(&mut agent_rx)
        .into_iter()
        .find(|m| m["type"] == "rpc_request")
        .expect("the owner's login request reaches the agent");
    assert_eq!(forwarded["requestId"], "own");

    seat_as_team_member(&mut hub);
    drain(&mut ui_rx);
    drain(&mut agent_rx);
    hub.on_ui_msg(UI_CONN, req("mate"));
    assert!(
        drain(&mut agent_rx)
            .iter()
            .all(|m| m["type"] != "rpc_request"),
        "a control-share member's login request never reaches the agent"
    );
    let refusal = drain(&mut ui_rx)
        .into_iter()
        .find(|m| m["type"] == "rpc_response" && m["requestId"] == "mate")
        .expect("and is answered");
    assert_eq!(refusal["ok"], false);
    assert!(refusal["error"].as_str().unwrap_or("").contains("владелец"));
}

/// The reading names an account, so a viewer who cannot control the
/// machine does not get it — same rule as `usage`.
#[test]
fn runtimes_are_stripped_for_a_viewer_without_control() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    if let Some(a) = hub.agents.get_mut("machine-1") {
        a.runtimes = json!({"codex":{"present":true,"auth":"chatgpt","account":"mate@example.com","provider":"own","checkedAt":1}});
    }
    assert!(hub.snapshot_for(UI_CONN)["machines"][0]
        .get("runtimes")
        .is_some());
    seat_as_team_member(&mut hub);
    let m = &hub.snapshot_for(UI_CONN)["machines"][0];
    assert_eq!(
        m["machine"]["machineId"], "machine-1",
        "the machine itself is still listed"
    );
    assert!(
        m.get("runtimes").is_none(),
        "but whose account runs on it is not"
    );
}

/// `project_pushed` from the agent and a successful `projects.create`
/// answer both land in the audit log of the person who did it.
#[test]
fn pushes_and_created_projects_are_audited() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"project_pushed","cwd":"/repo","remoteHost":"github.com"}),
    );
    hub.pending_rpc.insert(
        "r1".into(),
        PendingRpc {
            conn: UI_CONN,
            machine_id: "machine-1".into(),
            method: "projects.create".into(),
            cwd: None,
            history: None,
            deleting: None,
            ..Default::default()
        },
    );
    hub.on_agent_msg(
            AGENT_CONN,
            json!({"type":"rpc_response","requestId":"r1","ok":true,"result":{"cwd":"/home/x/work/app","created":true}}),
        );
    // A failed answer is relayed but never audited.
    hub.pending_rpc.insert(
        "r2".into(),
        PendingRpc {
            conn: UI_CONN,
            machine_id: "machine-1".into(),
            method: "projects.remove".into(),
            cwd: Some("/home/x/work/app".into()),
            history: None,
            deleting: None,
            ..Default::default()
        },
    );
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"rpc_response","requestId":"r2","ok":false,"error":"live session inside"}),
    );
    let events = hub
        .workspaces
        .audit_events("owner", "personal:owner")
        .unwrap();
    let actions: Vec<&str> = events
        .iter()
        .map(|e| e["action"].as_str().unwrap())
        .collect();
    assert!(actions.contains(&"project.pushed"));
    assert!(actions.contains(&"project.created"));
    assert!(!actions.contains(&"project.removed"));
    let pushed = events
        .iter()
        .find(|e| e["action"] == "project.pushed")
        .unwrap();
    assert_eq!(pushed["metadata"]["remoteHost"], "github.com");
    assert_eq!(
        pushed["actorUserId"], "owner",
        "no session → the device owner"
    );
    let created = events
        .iter()
        .find(|e| e["action"] == "project.created")
        .unwrap();
    assert_eq!(created["metadata"]["cwd"], "/home/x/work/app");
}

#[test]
fn fleet_gateway_validation_preserves_explicit_product_runtime() {
    let (mut hub, _ui_rx, mut agent_rx) = test_hub(session(None));
    for settings in [
        json!({"requireGateway":"true","source":"codex"}),
        json!({"requireGateway":true,"source":"claude"}),
    ] {
        assert_eq!(
            hub.fleet_spawn("owner", "machine-1", "/work", "spec", &settings, None)
                .unwrap_err()
                .0,
            400
        );
    }
    assert!(hub
        .fleet_spawn(
            "owner",
            "machine-1",
            "/work",
            "spec",
            &json!({"requireGateway":true,"source":"codex"}),
            None
        )
        .is_err());
    assert!(!drain(&mut agent_rx)
        .iter()
        .any(|m| m["type"] == "new_session"));
    hub.agents.get_mut("machine-1").unwrap().machine["gatewaySessions"] = json!(true);
    assert_eq!(
        hub.fleet_machines("owner")["machines"][0]["gatewaySessions"],
        true
    );
    for (source, required) in [("codex", true), ("claude", false)] {
        hub.fleet_spawn(
            "owner",
            "machine-1",
            "/work",
            "spec",
            &json!({"source":source,"requireGateway":required}),
            None,
        )
        .unwrap();
        let frames = drain(&mut agent_rx);
        let frame = frames.iter().find(|m| m["type"] == "new_session").unwrap();
        assert_eq!(frame["source"], source);
        if required {
            assert_eq!(frame["requireGateway"], true);
        } else {
            assert!(frame.get("requireGateway").is_none());
        }
    }
    assert!(hub
        .fleet_spawn(
            "stranger",
            "machine-1",
            "/work",
            "spec",
            &json!({"source":"codex","requireGateway":true}),
            None
        )
        .is_err());
}

// ── the task registry ─────────────────────────────────────────────────

/// The agent reports the session a run started.
fn session_started(hub: &mut Hub, run_id: &str, session_id: &str) {
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"session_started","runId":run_id,"sessionId":session_id}),
    );
}

/// Teo's registry call, as the HTTP layer makes it.
fn teo_task(hub: &mut Hub, op: FleetTaskOp) -> Result<Value, FleetError> {
    hub.fleet_task("owner", op)
}

fn create_task(hub: &mut Hub, title: &str) -> String {
    teo_task(
        hub,
        FleetTaskOp::Create {
            title: title.into(),
            status: None,
            intent: None,
            lane: None,
        },
    )
    .unwrap()["task"]["id"]
        .as_str()
        .unwrap()
        .to_string()
}

#[test]
fn a_task_is_filed_by_the_key_and_moves_on_a_near_miss_status() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    let id = create_task(&mut hub, "Договор");
    let made = teo_task(&mut hub, FleetTaskOp::Get { id: id.clone() }).unwrap();
    assert_eq!(made["task"]["statusBy"], "teo");
    assert_eq!(made["task"]["anchorTurnId"], "");
    // The registry knows no origin session: only what work is linked to it.
    assert_eq!(made["links"], json!([]));

    // Teo moves it to «waiting» with a near-miss word.
    let moved = teo_task(
        &mut hub,
        FleetTaskOp::Update {
            id: id.clone(),
            title: None,
            status: Some("waiting-owner".into()),
            intent: Some("подписать до пятницы".into()),
            lane: Some("legal".into()),
        },
    )
    .unwrap();
    assert_eq!(moved["task"]["status"], "waiting");
    assert_eq!(moved["task"]["intent"], "подписать до пятницы");
    assert_eq!(moved["task"]["lane"], "legal");
    let bad = FleetTaskOp::Update {
        id: id.clone(),
        title: None,
        status: Some("урgent".into()),
        intent: None,
        lane: None,
    };
    assert_eq!(teo_task(&mut hub, bad).unwrap_err().0, 400);
}

#[test]
fn a_run_released_before_its_session_leaves_no_ghost_child() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    let id = create_task(&mut hub, "Отчёт");
    let settings = json!({"source":"claude","requireGateway":false});
    let tag = TaskTag {
        task_id: id.clone(),
        linked_by: "machine-1".into(),
    };
    let out = hub
        .fleet_spawn("owner", "machine-1", "/work", "x", &settings, Some(&tag))
        .unwrap();
    let run_id = out["runId"].as_str().unwrap().to_string();
    assert!(hub.task_links.pending.contains_key(&run_id));

    hub.release_run(&run_id);

    assert!(hub.task_links.pending.is_empty());
    let links = hub.workspaces.task_links_of("owner", &id).unwrap();
    assert!(!links.iter().any(|l| l.role == "child"));
}

#[test]
fn spawn_with_a_task_links_the_run_and_then_its_session() {
    let (mut hub, _ui_rx, mut agent_rx) = test_hub(session(None));
    let id = create_task(&mut hub, "Отчёт");
    let other = create_task(&mut hub, "Другое");
    let settings = json!({"source":"claude","requireGateway":false});
    let tag = |task: &str| TaskTag {
        task_id: task.into(),
        linked_by: "machine-1".into(),
    };

    // A task that is not there: refused before anything starts.
    drain(&mut agent_rx);
    let err = hub
        .fleet_spawn(
            "owner",
            "machine-1",
            "/work",
            "x",
            &settings,
            Some(&tag("nope")),
        )
        .unwrap_err();
    assert_eq!(err.0, 404);
    assert!(!drain(&mut agent_rx)
        .iter()
        .any(|m| m["type"] == "new_session"));

    let out = hub
        .fleet_spawn(
            "owner",
            "machine-1",
            "/work",
            "x",
            &settings,
            Some(&tag(&id)),
        )
        .unwrap();
    assert_eq!(out["taskId"], id.as_str());
    let run_id = out["runId"].as_str().unwrap().to_string();
    let links = hub.workspaces.task_links_of("owner", &id).unwrap();
    let child = links.iter().find(|l| l.role == "child").unwrap();
    assert_eq!(child.run_id.as_deref(), Some(run_id.as_str()));
    assert_eq!(child.session_id, "");
    assert!(hub.task_links.pending.contains_key(&run_id));

    // The agent reports the session: the link learns it, the lookup too.
    session_started(&mut hub, &run_id, "work-1");
    let child = hub
        .workspaces
        .task_link_by_session("owner", "machine-1", "work-1")
        .unwrap()
        .unwrap();
    assert_eq!(child.task_id, id);
    assert!(hub.task_links.pending.is_empty());
    let listed = teo_task(
        &mut hub,
        FleetTaskOp::List {
            all: false,
            limit: None,
        },
    )
    .unwrap();
    let mine = listed["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == id.as_str())
        .unwrap();
    assert_eq!(mine["children"][0]["sessionId"], "work-1");
    assert_eq!(mine["children"][0]["role"], "child");

    // The same session cannot work for a second task; nothing is sent.
    drain(&mut agent_rx);
    let target = FleetTarget::Session {
        machine: "machine-1".into(),
        session_id: "work-1".into(),
    };
    let err = hub
        .fleet_send("owner", &target, "ещё", &json!({}), Some(&tag(&other)))
        .unwrap_err();
    assert_eq!(err.0, 409);
    assert!(drain(&mut agent_rx).is_empty());
    // Linking it by hand is refused the same way, and idempotent for its own.
    let link = |hub: &mut Hub, task: &str| {
        teo_task(
            hub,
            FleetTaskOp::Link {
                id: task.into(),
                target: FleetTarget::Session {
                    machine: "machine-1".into(),
                    session_id: "work-1".into(),
                },
                linked_by: "machine-1".into(),
            },
        )
    };
    assert_eq!(link(&mut hub, &other).unwrap_err().0, 409);
    let again = link(&mut hub, &id).unwrap();
    assert_eq!(again["link"]["linkId"], child.link_id.as_str());
    // A machine that is not the owner's, and a missing task.
    let stranger = FleetTaskOp::Link {
        id: id.clone(),
        target: FleetTarget::Session {
            machine: "not-mine".into(),
            session_id: "s".into(),
        },
        linked_by: "machine-1".into(),
    };
    assert_eq!(teo_task(&mut hub, stranger).unwrap_err().0, 404);
    assert_eq!(link(&mut hub, "nope").unwrap_err().0, 404);
}

#[test]
fn the_registry_links_survive_a_restart() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    // A task is filed and work is spawned for it, no questions asked.
    let id = create_task(&mut hub, "Без ленты");
    let made = teo_task(&mut hub, FleetTaskOp::Get { id: id.clone() }).unwrap();
    assert_eq!(made["links"], json!([]));
    // Neither is the work spawned for it.
    let settings = json!({"source":"claude","requireGateway":false});
    let tag = TaskTag {
        task_id: id.clone(),
        linked_by: "machine-1".into(),
    };
    let out = hub
        .fleet_spawn("owner", "machine-1", "/work", "x", &settings, Some(&tag))
        .unwrap();
    let run_id = out["runId"].as_str().unwrap().to_string();
    // The hub restarts before the agent reports the session: the lookup is
    // rebuilt from the stored links.
    let reloaded = tasks::TaskLinks::load(&hub.workspaces);
    assert_eq!(
        reloaded.pending.get(&run_id),
        Some(&("owner".to_string(), id.clone()))
    );
    hub.task_links = reloaded;
    session_started(&mut hub, &run_id, "work-9");
    assert!(hub.task_links.pending.is_empty());
    // The session link is stored: the next start has nothing left pending.
    let again = tasks::TaskLinks::load(&hub.workspaces);
    assert!(again.pending.is_empty());
    let child = hub
        .workspaces
        .task_link_by_session("owner", "machine-1", "work-9")
        .unwrap()
        .unwrap();
    assert_eq!(child.task_id, id);
}

/// A second person with their own socket and no share on `machine-1`.
fn add_stranger(hub: &mut Hub, conn: ConnId) -> Receiver<String> {
    hub.workspaces
        .ensure_user("stranger", "stranger@example.com", Some("S"))
        .unwrap();
    hub.workspaces.activate_access("stranger", "tests").unwrap();
    let access = hub.workspaces.ui_access("stranger", None, false).unwrap();
    let (tx, rx) = channel(128);
    hub.conns.insert(conn, tx);
    hub.ui_clients.insert(conn);
    hub.ui_access.insert(conn, access);
    rx
}

fn reads_of(frames: &[Value]) -> Vec<&Value> {
    frames
        .iter()
        .filter(|m| m["type"] == "session_reads")
        .collect()
}

#[test]
fn a_read_mark_reaches_the_persons_other_sockets_and_nobody_else() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    let mut other_device = add_colleague(&mut hub, 77);
    let mut stranger = add_stranger(&mut hub, 78);
    drain(&mut ui_rx);
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"session_read","machineId":"machine-1","sessionId":"session-1"}),
    );
    let mine = drain(&mut ui_rx);
    let frame = reads_of(&mine)[0].clone();
    assert_eq!(frame["reads"][0]["machineId"], "machine-1");
    assert_eq!(frame["reads"][0]["sessionId"], "session-1");
    assert!(frame["reads"][0]["at"].as_i64().unwrap() > 0);
    assert_eq!(reads_of(&drain(&mut other_device)).len(), 1);
    assert!(reads_of(&drain(&mut stranger)).is_empty());
}

#[test]
fn a_read_of_a_machine_the_person_cannot_see_is_ignored() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    let _owner_second = add_colleague(&mut hub, 77);
    let mut stranger = add_stranger(&mut hub, 78);
    drain(&mut ui_rx);
    hub.on_ui_msg(
        78,
        json!({"type":"session_read","machineId":"machine-1","sessionId":"session-1"}),
    );
    assert!(drain(&mut stranger).is_empty());
    assert!(hub
        .workspaces
        .session_reads_recent("stranger", 0, 10)
        .unwrap()
        .is_empty());
}

#[test]
fn a_quick_repeat_is_stored_but_not_rebroadcast() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    drain(&mut ui_rx);
    let msg = json!({"type":"session_read","machineId":"machine-1","sessionId":"session-1"});
    hub.on_ui_msg(UI_CONN, msg.clone());
    assert_eq!(reads_of(&drain(&mut ui_rx)).len(), 1);
    hub.on_ui_msg(UI_CONN, msg);
    assert!(reads_of(&drain(&mut ui_rx)).is_empty());
}

#[test]
fn a_read_of_an_unknown_session_is_ignored() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    drain(&mut ui_rx);
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"session_read","machineId":"machine-1","sessionId":"no-such-session"}),
    );
    assert!(reads_of(&drain(&mut ui_rx)).is_empty());
    assert!(hub
        .workspaces
        .session_reads_recent("owner", 0, 10)
        .unwrap()
        .is_empty());
}

#[test]
fn a_fast_duplicate_is_stored_but_not_rebroadcast() {
    // Clients announce on a change of what is on screen and throttle to one
    // mark per 10 s; a repeat inside the hub's 5 s window is a duplicate
    // (two tabs, a reconnect) and is not sent to the other sockets again.
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    drain(&mut ui_rx);
    let msg = json!({"type":"session_read","machineId":"machine-1","sessionId":"session-1"});
    hub.on_ui_msg(UI_CONN, msg.clone());
    assert_eq!(reads_of(&drain(&mut ui_rx)).len(), 1);
    hub.on_ui_msg(UI_CONN, msg);
    assert!(reads_of(&drain(&mut ui_rx)).is_empty());
}

#[test]
fn a_mark_after_the_duplicate_window_is_rebroadcast() {
    // Past the 5 s window a repeat is news — e.g. the read of a result that
    // finished and whose run the hub already released — so every other
    // socket of the person hears it.
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    hub.workspaces
        .session_read_upsert("owner", "machine-1", "session-1", now_ms() - 10_000, 10)
        .unwrap();
    drain(&mut ui_rx);
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"session_read","machineId":"machine-1","sessionId":"session-1"}),
    );
    assert_eq!(reads_of(&drain(&mut ui_rx)).len(), 1);
}

#[test]
fn the_snapshot_marks_need_an_active_person_and_a_viewable_session() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    hub.workspaces
        .session_read_upsert("owner", "machine-1", "session-1", now_ms() - 5, 10)
        .unwrap();
    hub.workspaces
        .session_read_upsert("owner", "machine-9", "hidden", now_ms() - 6, 10)
        .unwrap();
    drain(&mut ui_rx);
    hub.send_session_reads(UI_CONN);
    let frames = drain(&mut ui_rx);
    let reads = reads_of(&frames)[0]["reads"].as_array().unwrap().clone();
    assert_eq!(reads.len(), 1);
    assert_eq!(reads[0]["sessionId"], "session-1");
    hub.ui_access.get_mut(&UI_CONN).unwrap().access_state = "waitlist".into();
    hub.send_session_reads(UI_CONN);
    assert!(drain(&mut ui_rx).is_empty());
}

#[test]
fn a_new_socket_gets_the_recent_marks_after_the_snapshot() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    drain(&mut ui_rx);
    hub.send_session_reads(UI_CONN);
    assert!(drain(&mut ui_rx).is_empty(), "no marks, no frame");
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"session_read","machineId":"machine-1","sessionId":"session-1"}),
    );
    drain(&mut ui_rx);
    hub.send_session_reads(UI_CONN);
    let frames = drain(&mut ui_rx);
    assert_eq!(reads_of(&frames)[0]["reads"].as_array().unwrap().len(), 1);
}

/// 31.10.2026: four answers finished overnight, the agent restarted for an
/// update at 06:54 and took every run with it, and the phone — asleep, last
/// seen them working — woke to no dots. A finished turn is stored, and a
/// socket that connects later is told about it after the read marks.
#[test]
fn a_finished_turn_outlives_its_run_and_reaches_a_later_socket() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let id = hub.runs.keys().next().unwrap().clone();
    // The recorded owner of the session (the client keys unread on it).
    hub.runs.get_mut(&id).unwrap().owner_user_id = Some("owner".into());
    hub.run_working(&id);
    hub.run_idle(&id);
    let since = hub.runs[&id].since;
    // A replayed idle is not a second finish.
    hub.run_idle(&id);
    hub.end_run(&id, "agent restarted");
    assert!(hub.runs.is_empty());
    drain(&mut ui_rx);
    hub.send_session_reads(UI_CONN);
    let frames = drain(&mut ui_rx);
    let done: Vec<&Value> = frames
        .iter()
        .filter(|f| f["type"] == "session_completions")
        .collect();
    assert_eq!(done.len(), 1, "{frames:?}");
    let list = done[0]["completions"].as_array().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["sessionId"], "session-1");
    assert_eq!(list[0]["at"], since);
    // Somebody else's socket on the same fleet hears nothing of it.
    let mut stranger = add_stranger(&mut hub, 78);
    hub.send_session_reads(78);
    assert!(drain(&mut stranger)
        .iter()
        .all(|f| f["type"] != "session_completions"));
}

#[test]
fn an_idle_that_was_never_working_is_not_a_finished_turn() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let id = hub.runs.keys().next().unwrap().clone();
    hub.runs.get_mut(&id).unwrap().owner_user_id = Some("owner".into());
    hub.runs.get_mut(&id).unwrap().state = "starting".into();
    hub.run_idle(&id);
    drain(&mut ui_rx);
    hub.send_session_reads(UI_CONN);
    assert!(drain(&mut ui_rx)
        .iter()
        .all(|f| f["type"] != "session_completions"));
}

#[test]
fn internal_backend_jobs_require_capability_and_preserve_plan_and_owner() {
    let (mut hub, _ui_rx, mut agent_rx) = test_hub(session(None));
    let original_runs = hub.runs.len();
    let original_locks = hub.lock_by_key.len();
    for supported in [false, true] {
        hub.agents.get_mut("machine-1").unwrap().machine["gatewaySessions"] = json!(supported);
        let (reply, response) = tokio::sync::oneshot::channel();
        hub.handle(HubCmd::SpawnForOwner {
            machine_id: "machine-1".into(),
            cwd: "/srv/project".into(),
            message: "propose a backend change".into(),
            category: Some("tz".into()),
            permission_mode: Some("plan".into()),
            owner_user_id: "owner".into(),
            owner_name: Some("Owner".into()),
            reply,
        });
        let result = response.blocking_recv().unwrap();
        let frames = drain(&mut agent_rx);
        if !supported {
            assert!(result.unwrap_err().contains("updated"));
            assert_eq!(hub.runs.len(), original_runs);
            assert_eq!(hub.lock_by_key.len(), original_locks);
            assert!(!frames.iter().any(|m| m["type"] == "new_session"));
        } else {
            let run_id = result.unwrap();
            let frame = frames.iter().find(|m| m["type"] == "new_session").unwrap();
            assert_eq!(frame["source"], "codex");
            assert_eq!(frame["requireGateway"], true);
            assert_eq!(frame["permissionMode"], "plan");
            assert_eq!(frame["message"], "propose a backend change");
            assert_eq!(hub.runs[&run_id].owner_user_id.as_deref(), Some("owner"));
        }
    }
}

#[test]
fn a_session_started_for_an_absent_owner_still_belongs_to_them() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));

    let run_id = hub
        .spawn_session(SpawnSpec {
            sealed: None,
            machine_id: "machine-1".into(),
            cwd: "/srv/acme".into(),
            message: Some("add a column".into()),
            images: None,
            files: None,
            category: Some("tz".into()),
            source: None,
            require_gateway: false,
            permission_mode: Some("plan".into()),
            model: None,
            effort: None,
            owner_user_id: Some("owner-user".into()),
            owner_name: Some("Owner".into()),
            origin: Some("backend-request".into()),
            attach: None,
            run_by: None,
        })
        .expect("the machine is online, so the run starts");

    let started = drain(&mut agent_rx)
        .into_iter()
        .find(|m| m["type"] == "new_session")
        .expect("the agent must be told to start a session");
    assert_eq!(
        started["permissionMode"], "plan",
        "proposed, not done unasked"
    );
    assert_eq!(
        started["message"], "/backend-tz add a column",
        "the tz category opens the session already in that workflow",
    );

    let run = hub.runs.get(&run_id).expect("the run is tracked");
    assert_eq!(
        run.owner_user_id.as_deref(),
        Some("owner-user"),
        "approvals and pushes follow the run's owner, who is not the filer",
    );
    assert!(
        run.browsers.is_empty(),
        "nobody is watching yet — the owner opens it whenever they get to it",
    );
    assert!(
        drain(&mut ui_rx).iter().all(|m| m["type"] != "opened"),
        "with no browser attached there is nothing to attach to the run",
    );
}

#[test]
fn each_machine_keeps_its_own_approval_deadline() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    assert_eq!(
        hub.tool_approval_ttl_ms("machine-1"),
        TOOL_APPROVAL_TTL_MS_DEFAULT,
        "an agent that declares nothing is using the default, so assume it",
    );
    assert_eq!(
        hub.tool_approval_ttl_ms("machine-never-seen"),
        TOOL_APPROVAL_TTL_MS_DEFAULT,
        "a disconnected machine must not read as 'waits forever'",
    );

    // The sandbox box that waits hours for a filed spec to be approved.
    if let Some(agent) = hub.agents.get_mut("machine-1") {
        agent.approval_timeout_ms = Some(12 * 60 * 60 * 1000);
    }
    assert_eq!(
        hub.tool_approval_ttl_ms("machine-1"),
        12 * 60 * 60 * 1000,
        "raising one machine's deadline must not require raising the fleet's",
    );
    assert_eq!(
        hub.tool_approval_ttl_ms("machine-never-seen"),
        TOOL_APPROVAL_TTL_MS_DEFAULT,
        "and must not leak onto machines that still give up in five minutes — \
             replaying a dead prompt there is the 'I approved it and nothing happened' bug",
    );
}

/// `needs_attention` has to say WHICH kind of waiting it is.
///
/// One state covers "the agent asked you something" and "a tool wants
/// permission to run". Every client printed one of the two words for both,
/// so half the time it lied: the web said «ждёт ответа» for a `Write`
/// prompt and sent the owner hunting for a question nobody asked, while
/// iOS said «ждёт подтверждения» for a real question. The state stays
/// single; `pendingKind` carries the meaning.
#[test]
fn a_pending_tool_says_whether_it_is_a_question_or_a_permission() {
    assert_eq!(pending_kind_of("AskUserQuestion"), "question");
    assert_eq!(
        pending_kind_of("ExitPlanMode"),
        "question",
        "an approved plan is an answer, not a permission"
    );
    for tool in ["Write", "Edit", "Bash", "WebFetch", "mcp__whatever__do"] {
        assert_eq!(
            pending_kind_of(tool),
            "permission",
            "{tool} is asking to be allowed to act"
        );
    }
}

#[test]
fn a_run_waiting_on_a_tool_publishes_what_it_waits_for() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().cloned().expect("run");
    {
        let run = hub.runs.get_mut(&run_id).unwrap();
        run.state = "needs_attention".into();
        run.pending_tool = Some("Write".into());
    }
    let json = hub.run_json(&run_id, hub.runs.get(&run_id).unwrap());
    assert_eq!(json["pendingKind"], "permission");
    assert_eq!(json["pendingTool"], "Write");

    hub.runs.get_mut(&run_id).unwrap().pending_tool = Some("AskUserQuestion".into());
    let json = hub.run_json(&run_id, hub.runs.get(&run_id).unwrap());
    assert_eq!(json["pendingKind"], "question");

    // Nothing pending: the fields stay absent rather than claiming a kind.
    hub.runs.get_mut(&run_id).unwrap().pending_tool = None;
    let json = hub.run_json(&run_id, hub.runs.get(&run_id).unwrap());
    assert!(json["pendingKind"].is_null());
    assert!(json["pendingTool"].is_null());
}

/// A replica that stopped receiving updates must not keep answering for a
/// session that is still being written.
///
/// This is the "my session hangs — I send a message and it disappears" bug.
/// The agent skips replication once a transcript passes `REPLICA_MAX_BYTES`
/// (32 MB session, 26 MB cap, observed on dev-box-1), while the CLI keeps
/// writing the file. The hub answered `session.messages` from the frozen
/// replica and never asked the machine, so every client — web, iOS, the
/// Telegram bot — showed a snapshot taken before the message was sent.
#[test]
fn a_replica_that_stopped_keeping_up_stops_answering_for_a_live_session() {
    let mut live = session(None);
    live["lastModified"] = json!(3_000.0);
    let (mut hub, _ui_rx, _agent_rx) = test_hub(live);

    // No replica at all: nothing to be stale, the old path stands.
    assert!(
        hub.replica_is_current("machine-1", "claude", "session-1"),
        "with no committed replica the request has to reach the agent anyway"
    );

    // Replica caught up to the same stat the inventory reports.
    hub.store
        .set_state_for_test("machine-1", "claude", "session-1", 1, 3_000.0);
    assert!(
        hub.replica_is_current("machine-1", "claude", "session-1"),
        "a replica level with the inventory is the cheap, durable source — keep using it"
    );

    // The transcript moved on; replication did not.
    hub.agents.get_mut("machine-1").unwrap().sessions[0]["lastModified"] = json!(9_000.0);
    assert!(
        !hub.replica_is_current("machine-1", "claude", "session-1"),
        "a frozen replica must yield to the machine that still has the text on disk"
    );

    // Machine offline: stale history still beats no history.
    hub.agents.remove("machine-1");
    assert!(
        hub.replica_is_current("machine-1", "claude", "session-1"),
        "offline, the replica is the only archive there is"
    );
}

/// The replica cursor is the file's mtime, not the sort key. A Claude
/// session's `lastModified` settles back onto its last real message while
/// the CLI keeps appending bookkeeping, and the agent then sends the raw
/// mtime as `fileMtime`; comparing the replica with the sort key would
/// call a replica current that is missing records written after it.
#[test]
fn replica_freshness_follows_the_file_cursor_not_the_sort_key() {
    let mut live = session(None);
    live["lastModified"] = json!(3_000.0);
    live["fileMtime"] = json!(9_000.0);
    let (hub, _ui_rx, _agent_rx) = test_hub(live);

    hub.store
        .set_state_for_test("machine-1", "claude", "session-1", 1, 3_000.0);
    assert!(
        !hub.replica_is_current("machine-1", "claude", "session-1"),
        "synced at the sort key while the file moved on: stale"
    );

    hub.store
        .set_state_for_test("machine-1", "claude", "session-1", 2, 9_000.0);
    assert!(
        hub.replica_is_current("machine-1", "claude", "session-1"),
        "synced at the file's own mtime: current, whatever the sort key says"
    );
}

/// And the check has to be WIRED IN, not merely present.
///
/// The first version of this test only called `replica_is_current`, so
/// deleting its use in `route_rpc_request` left the suite green — the exact
/// regression that would bring the bug back. This one drives the request.
#[test]
fn a_history_request_skips_a_stale_replica_and_asks_the_machine() {
    let mut live = session(None);
    live["lastModified"] = json!(5_000.0);
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(live);
    hub.store
        .set_state_for_test("machine-1", "claude", "session-1", 1, 5_000.0);
    hub.store.put_messages_for_test(
        "machine-1",
        "claude",
        "session-1",
        &[json!({"role":"assistant","blocks":[{"kind":"text","text":"из реплики"}]})],
    );
    drain(&mut ui_rx);
    drain(&mut agent_rx);

    let ask = json!({
        "type":"rpc_request","requestId":"r1","machineId":"machine-1",
        "method":"session.messages","params":{"sessionId":"session-1","source":"claude"}
    });

    // Replica level with the inventory: it answers, the machine is spared.
    hub.on_ui_msg(UI_CONN, ask.clone());
    let replied = ui_rx.try_recv().expect("the replica answers");
    assert!(
        replied.contains("из реплики"),
        "a current replica is the cheap path and must stay so"
    );
    assert!(
        agent_rx.try_recv().is_err(),
        "no reason to wake the machine for history the hub already has"
    );

    // Transcript moved on, replication did not: the request must travel.
    hub.agents.get_mut("machine-1").unwrap().sessions[0]["lastModified"] = json!(9_000.0);
    hub.on_ui_msg(UI_CONN, ask);
    assert!(
        !ui_rx
            .try_recv()
            .map(|frame| frame.contains("из реплики"))
            .unwrap_or(false),
        "a frozen replica must not answer — that is the message that 'disappeared'"
    );
    let forwarded = agent_rx.try_recv().expect("the machine is asked instead");
    assert!(forwarded.contains("session.messages"));

    // ...and if the machine sits on it past the deadline, the frozen replica
    // answers after all, marked as such — a minute-old transcript beats a
    // pane that stays blank until the browser gives up (26.09.2026).
    hub.history_deadline("r1");
    let late = ui_rx
        .try_recv()
        .expect("the replica answers at the deadline");
    assert!(late.contains("из реплики") && late.contains("\"stale\":true"));
    assert!(
        !hub.pending_rpc.contains_key("r1"),
        "the request is settled; the machine's late answer must find nothing"
    );
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"rpc_response","requestId":"r1","ok":true,"result":{"messages":[]}}),
    );
    assert!(
        ui_rx.try_recv().is_err(),
        "a late agent reply after the replica answered is dropped, not double-delivered"
    );
    // A second deadline for a request nobody has is a no-op.
    hub.history_deadline("r1");
    assert!(ui_rx.try_recv().is_err());
}

/// The agent chooses which copy of a session id to read or delete by the cwd it
/// is sent. Access was judged against the hub's record, so the hub's record is
/// what travels - a caller's own `cwd` must not steer the agent to another
/// matter's copy of the same id. A session the hub cannot place keeps the cwd.
#[test]
fn the_hubs_own_cwd_replaces_the_callers_for_session_reads_deletes_and_mirrors() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    drain(&mut ui_rx);
    drain(&mut agent_rx);
    for (i, method) in [
        "session.image",
        "session.subagent",
        "session.delete",
        "session.messages",
    ]
    .iter()
    .enumerate()
    {
        hub.on_ui_msg(
            UI_CONN,
            json!({
                "type":"rpc_request","requestId":format!("forge-{i}"),"machineId":"machine-1",
                "method":method,
                "params":{"sessionId":"session-1","cwd":"/other-matter","ref":"x","id":"c","source":"claude"}
            }),
        );
        let frame = agent_rx
            .try_recv()
            .unwrap_or_else(|_| panic!("{method} reaches the machine"));
        assert!(
            frame.contains("\"cwd\":\"/repo\"") && !frame.contains("/other-matter"),
            "{method} must carry the hub's cwd, got {frame}"
        );
    }
    // A session the hub does not place: the old behaviour, the cwd is left alone.
    hub.on_ui_msg(
        UI_CONN,
        json!({
            "type":"rpc_request","requestId":"unknown-1","machineId":"machine-1",
            "method":"session.subagent",
            "params":{"sessionId":"never-seen","cwd":"/theirs","id":"c","source":"codex"}
        }),
    );
    if let Ok(frame) = agent_rx.try_recv() {
        assert!(
            frame.contains("/theirs"),
            "an unplaced session keeps the supplied cwd: {frame}"
        );
    }
    // mirror_open: the folder the agent is told is the hub's.
    drain(&mut agent_rx);
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"mirror_open","mirrorId":"m1","machineId":"machine-1",
               "sessionId":"session-1","cwd":"/other-matter"}),
    );
    let frame = agent_rx
        .try_recv()
        .expect("mirror_open reaches the machine");
    assert!(
        frame.contains("mirror_open")
            && frame.contains("\"cwd\":\"/repo\"")
            && !frame.contains("/other-matter"),
        "mirror_open must carry the hub's cwd, got {frame}"
    );
}

#[test]
fn a_headless_start_reports_an_offline_machine_instead_of_pretending() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    let result = hub.spawn_session(SpawnSpec {
        sealed: None,
        machine_id: "machine-missing".into(),
        cwd: "/srv/acme".into(),
        message: Some("x".into()),
        images: None,
        files: None,
        category: Some("tz".into()),
        source: None,
        require_gateway: false,
        permission_mode: Some("plan".into()),
        model: None,
        effort: None,
        owner_user_id: Some("owner-user".into()),
        owner_name: None,
        origin: None,
        attach: None,
        run_by: None,
    });
    assert_eq!(
        result.err().as_deref(),
        Some("Machine is offline."),
        "the filer is told why, so they can retry rather than wonder",
    );
}

#[test]
fn a_new_run_is_named_after_the_task_not_after_nothing() {
    assert_eq!(provisional_title(None), "New session");
    assert_eq!(provisional_title(Some("   ")), "New session");
    assert_eq!(
        provisional_title(Some("почини ранкер\n\nподробности ниже")),
        "почини ранкер",
        "the first non-empty line names the run",
    );
    let long = "я".repeat(80);
    let short = provisional_title(Some(&long));
    assert_eq!(short.chars().count(), 61, "60 chars plus the ellipsis");
    assert!(short.ends_with('…'));
}

#[test]
fn the_inventory_replaces_a_placeholder_title() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    hub.new_session(
        UI_CONN,
        &json!({"machineId":"machine-1","cwd":"/repo","message":"почини ранкер"}),
    );
    let run_id = hub.runs.keys().next().unwrap().clone();
    assert_eq!(hub.runs[&run_id].title.as_deref(), Some("почини ранкер"));

    // The agent mints the id, then scans the transcript it just wrote.
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"session_started","runId":run_id,"sessionId":"session-2"}),
    );
    if let Some(agent) = hub.agents.get_mut("machine-1") {
        agent.sessions = vec![json!({
            "sessionId": "session-2",
            "title": "Ранкер: пороги и веса",
            "cwd": "/repo",
            "project": "hegai",
        })];
    }
    hub.refresh_run_titles("machine-1");

    assert_eq!(
        hub.runs[&run_id].title.as_deref(),
        Some("Ранкер: пороги и веса"),
        "the real title must win once the transcript exists",
    );
    assert!(
        drain(&mut ui_rx)
            .iter()
            .any(|m| m["type"] == "activity" || m["type"] == "snapshot"),
        "a renamed run must reach the board",
    );
}

#[test]
fn an_idle_run_nobody_watches_is_reaped_and_frees_its_lock() {
    let (mut hub, _ui_rx, mut agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"run_status","runId":run_id,"sessionId":"session-1","state":"idle"}),
    );

    hub.reap_idle_runs();
    assert_eq!(hub.runs.len(), 1, "a watched run is never reaped");

    hub.runs.get_mut(&run_id).unwrap().browsers.clear();
    hub.reap_idle_runs();
    assert_eq!(hub.runs.len(), 1, "a fresh run is never reaped");

    hub.runs.get_mut(&run_id).unwrap().since = now_ms() - IDLE_RUN_TTL_MS - 1;
    hub.reap_idle_runs();
    assert!(hub.runs.is_empty(), "an old unwatched idle run is closed");
    assert!(hub.lock_by_key.is_empty(), "and its session is reopenable");
    assert!(
        drain(&mut agent_rx)
            .iter()
            .any(|m| m["type"] == "close" && m["runId"] == run_id.as_str()),
        "the agent must be told, or its CLI process leaks",
    );
}

#[test]
fn single_writer_refuses_a_second_open_and_releases_on_terminal_states() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));

    open(&mut hub, false);
    assert_eq!(hub.runs.len(), 1);
    assert_eq!(hub.lock_by_key.len(), 1);
    let first_run = hub.runs.keys().next().unwrap().clone();
    drain(&mut ui_rx);

    open(&mut hub, false);
    assert_eq!(hub.runs.len(), 1, "a second writer must not be created");
    assert!(drain(&mut ui_rx).iter().any(|message| {
        message.get("type").and_then(Value::as_str) == Some("error")
                && message
                    .get("message")
                    .and_then(Value::as_str)
                    .is_some_and(|text| text.contains("already has an active run"))
                // The refusal must NAME the run holding the lock, so the client
                // can subscribe to it instead of fighting (b0503f9 in the web).
                && message.get("code").and_then(Value::as_str) == Some("run_active")
                && message.get("runId").and_then(Value::as_str) == Some(first_run.as_str())
    }));

    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"run_status","runId":first_run,"sessionId":"session-1","state":"idle"}),
    );
    assert_eq!(hub.runs.len(), 1, "idle keeps the writer lock");

    for state in ["ended", "error", "yielded"] {
        let run_id = hub.runs.keys().next().unwrap().clone();
        hub.on_agent_msg(
            AGENT_CONN,
            json!({"type":"run_status","runId":run_id,"sessionId":"session-1","state":state}),
        );
        assert!(hub.runs.is_empty(), "{state} must remove the run");
        assert!(hub.lock_by_key.is_empty(), "{state} must release the lock");
        drain(&mut ui_rx);

        if state != "yielded" {
            open(&mut hub, false);
            assert_eq!(hub.runs.len(), 1, "session must reopen after {state}");
            drain(&mut ui_rx);
        }
    }
}

#[test]
fn live_pid_refuses_resume_but_force_takeover_still_gets_one_lock() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(Some(4242)));

    open(&mut hub, false);
    assert!(hub.runs.is_empty());
    assert!(hub.lock_by_key.is_empty());
    assert!(drain(&mut ui_rx).iter().any(|message| {
        message
            .get("message")
            .and_then(Value::as_str)
            .is_some_and(|text| text.contains("refusing to open a second writer"))
    }));

    open(&mut hub, true);
    assert_eq!(hub.runs.len(), 1);
    assert_eq!(hub.lock_by_key.len(), 1);
    assert!(drain(&mut agent_rx).iter().any(|message| {
        message.get("type").and_then(Value::as_str) == Some("takeover")
            && message.get("sessionId").and_then(Value::as_str) == Some("session-1")
    }));
}

/// A terminal `run_status` as an agent whose runtime process may still be
/// exiting sends it: the run is over, the process is not yet confirmed gone.
fn end_closing(hub: &mut Hub, run_id: &str, state: &str) {
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"run_status","runId":run_id,"sessionId":"session-1","state":state,"closing":true}),
    );
}

/// machine-2 as a CURRENT agent (its socket is the one the hub routes), so its
/// frames get past the superseded-socket guard and reach the handlers — what a
/// buggy or hostile enrolled agent on another machine would look like.
fn add_current_agent(hub: &mut Hub, conn: ConnId, machine_id: &str) {
    let (tx, _rx) = channel(128);
    hub.conns.insert(conn, tx);
    hub.conn_machine.insert(conn, machine_id.into());
    hub.agents.insert(
        machine_id.into(),
        AgentConn {
            machine: json!({"machineId": machine_id, "name": machine_id, "os": "linux"}),
            conn,
            liveness: collect_liveness(&[]),
            sessions: vec![],
            last_seen: now_ms(),
            usage: Value::Null,
            codex_usage: Value::Null,
            profile: Value::Null,
            stats: Value::Null,
            runtimes: Value::Null,
            approval_timeout_ms: None,
            inventory_sig: None,
            inventory_ui_sig: None,
            published_sessions: HashMap::new(),
        },
    );
}

fn refused_as_closing(frames: &[Value]) -> bool {
    frames.iter().any(|message| {
        message.get("type").and_then(Value::as_str) == Some("error")
            && message.get("message").and_then(Value::as_str) == Some(WRITER_CLOSING_REFUSAL)
    })
}

/// The Codex app-server behind a run outlives the close by up to the kill
/// grace and leaves no pid file, so the terminal `run_status` that frees the
/// lock cannot also say the writer is gone. Until the agent confirms it
/// (`writer_released`) or the deadline passes, the session is not handed on.
#[test]
fn a_closing_writer_refuses_the_next_open_until_the_agent_confirms_it_gone() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    add_current_agent(&mut hub, 3, "machine-2");

    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    drain(&mut ui_rx);
    drain(&mut agent_rx);

    end_closing(&mut hub, &run_id, "ended");
    assert!(
        hub.runs.is_empty(),
        "the run is over for everyone, as always"
    );
    assert!(hub.lock_by_key.is_empty());
    let told = drain(&mut ui_rx);
    let status = told
        .iter()
        .find(|m| m["type"] == "run_status" && m["state"] == "ended")
        .expect("the viewers are told the run ended");
    assert!(
        status.get("closing").is_none(),
        "`closing` is hub-internal: an old client must never see it, {status}"
    );
    let guard = &hub.closing_writers["machine-1::session-1"];
    assert_eq!(guard.run_id, run_id);
    let left = guard.until_ms - now_ms();
    assert!(
        left > RUN_CLOSING_MAX_MS - 1_000 && left <= RUN_CLOSING_MAX_MS,
        "the deadline is RUN_CLOSING_MAX_MS from now, got {left}ms"
    );
    drain(&mut ui_rx);

    open(&mut hub, false);
    assert!(hub.runs.is_empty(), "no second writer next to a dying one");
    assert!(refused_as_closing(&drain(&mut ui_rx)));
    assert!(
        drain(&mut agent_rx)
            .iter()
            .all(|m| m["type"] != "resume" && m["type"] != "takeover"),
        "the agent is not asked to start anything"
    );

    // Nobody but the run that set the guard, on the machine that set it, can
    // lift it: the key is built from the SOCKET's machine, never the frame's.
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"writer_released","sessionId":"session-1","runId":"some-other-run"}),
    );
    hub.on_agent_msg(
        3,
        json!({"type":"writer_released","sessionId":"session-1","runId":run_id}),
    );
    assert!(hub.closing_writers.contains_key("machine-1::session-1"));

    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"writer_released","sessionId":"session-1","runId":run_id}),
    );
    assert!(
        hub.closing_writers.is_empty(),
        "confirmed gone: free at once"
    );
    drain(&mut ui_rx);
    open(&mut hub, false);
    assert_eq!(
        hub.runs.len(),
        1,
        "the session reopens after writer_released"
    );
}

#[test]
fn a_closing_guard_expires_on_its_own_when_writer_released_never_comes() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    end_closing(&mut hub, &run_id, "error");
    drain(&mut ui_rx);

    open(&mut hub, false);
    assert!(
        refused_as_closing(&drain(&mut ui_rx)),
        "inside the deadline"
    );

    // The agent exited before the process did (the update path), or its socket
    // was down when the process went: the deadline is the only way out.
    hub.closing_writers
        .get_mut("machine-1::session-1")
        .unwrap()
        .until_ms = now_ms() - 1;
    open(&mut hub, false);
    assert_eq!(hub.runs.len(), 1, "an expired guard counts as free");
    assert!(hub.closing_writers.is_empty(), "and is dropped when seen");
}

#[test]
fn the_housekeeping_tick_sweeps_expired_closing_guards_only() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    for (key, until_ms) in [
        ("machine-1::old", now_ms() - 1),
        ("machine-1::fresh", now_ms() + RUN_CLOSING_MAX_MS),
    ] {
        hub.closing_writers.insert(
            key.into(),
            ClosingWriter {
                run_id: "r".into(),
                until_ms,
            },
        );
    }
    hub.handle(HubCmd::ReapIdleRuns);
    assert_eq!(
        hub.closing_writers.keys().collect::<Vec<_>>(),
        ["machine-1::fresh"],
        "the map does not grow with closes whose confirmation never came"
    );
}

/// What every old agent sends, and every Claude run: no `closing`, so the
/// guard is never raised and the session reopens at once — the behavior the
/// test above pins for `ended`, `error` and `yielded` alike.
#[test]
fn a_terminal_status_without_closing_frees_the_session_at_once() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    for (state, closing) in [
        ("ended", None),
        ("error", None),
        ("yielded", None),
        // Only `true` counts; a stray `false` is not a closing writer.
        ("ended", Some(false)),
    ] {
        open(&mut hub, false);
        assert_eq!(hub.runs.len(), 1, "opens before {state}");
        let run_id = hub.runs.keys().next().unwrap().clone();
        let mut frame =
            json!({"type":"run_status","runId":run_id,"sessionId":"session-1","state":state});
        if let Some(closing) = closing {
            frame["closing"] = json!(closing);
        }
        hub.on_agent_msg(AGENT_CONN, frame);
        assert!(hub.runs.is_empty());
        assert!(hub.closing_writers.is_empty(), "{state} raised no guard");
        drain(&mut ui_rx);
    }
    // `closing` on a state that is not terminal means nothing.
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"run_status","runId":run_id,"sessionId":"session-1","state":"idle","closing":true}),
    );
    assert!(hub.closing_writers.is_empty());
    assert_eq!(hub.runs.len(), 1, "idle keeps the run");
}

/// A takeover kills what a pid file names — and a Codex app-server names itself
/// nowhere. After an agent restart the new process has no `dying` entry to
/// wait on, so the hub's guard is the only thing between a force takeover and
/// a second writer: force waits too, until the agent confirms the exit.
#[test]
fn a_force_takeover_waits_for_the_old_writer_to_be_confirmed_gone() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let old_run = hub.runs.keys().next().unwrap().clone();
    end_closing(&mut hub, &old_run, "ended");
    drain(&mut ui_rx);
    drain(&mut agent_rx);

    open(&mut hub, true);
    assert!(
        hub.runs.is_empty(),
        "no run while the old process may still write"
    );
    assert!(hub.lock_by_key.is_empty());
    assert!(
        refused_as_closing(&drain(&mut ui_rx)),
        "force is refused like any open"
    );
    assert!(
        !drain(&mut agent_rx).iter().any(|m| m["type"] == "takeover"),
        "the agent is not told to take over"
    );

    // The confirmation lifts the guard; the same takeover then goes ahead.
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"writer_released","sessionId":"session-1","runId":old_run}),
    );
    open(&mut hub, true);
    assert_eq!(hub.runs.len(), 1);
    assert_eq!(hub.lock_by_key.len(), 1);
    assert!(
        drain(&mut agent_rx)
            .iter()
            .any(|m| m["type"] == "takeover" && m["sessionId"] == "session-1"),
        "the agent is told to take over"
    );
    assert!(hub.closing_writers.is_empty());
}

/// An enrolled agent could spray `closing` frames with invented ids for runs
/// the hub never held (the fallback takes the session from the frame). The
/// guard map is bounded and a run id longer than a UUID is not stored at all.
#[test]
fn closing_guards_are_bounded_and_reject_oversized_run_ids() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"run_status","runId":"x".repeat(65),"sessionId":"session-1","state":"ended","closing":true}),
    );
    assert!(
        hub.closing_writers.is_empty(),
        "an oversized run id arms nothing"
    );

    let cap = super::agent_run::CLOSING_WRITERS_PER_MACHINE_MAX;
    for i in 0..(cap + 50) {
        hub.on_agent_msg(
            AGENT_CONN,
            json!({"type":"run_status","runId":format!("run-{i}"),"sessionId":format!("s-{i}"),"state":"ended","closing":true}),
        );
    }
    assert_eq!(
        hub.closing_writers.len(),
        cap,
        "one machine stops at its share"
    );

    // A second machine's real guard is not kept out by the first one's spray.
    let other: ConnId = 777;
    add_current_agent(&mut hub, other, "machine-2");
    hub.on_agent_msg(
        other,
        json!({"type":"run_status","runId":"run-real","sessionId":"s-real","state":"ended","closing":true}),
    );
    assert_eq!(hub.closing_writers.len(), cap + 1);
    assert!(hub.closing_writers.contains_key("machine-2::s-real"));
}

/// The hub can close a run before the agent says anything (the idle reaper,
/// "mark finished", a failed run): the lock is gone, the process is not. The
/// agent's `closing` frame arrives for a run the hub no longer holds and must
/// still raise the guard — unless a NEWER run already owns the session.
#[test]
fn a_closing_status_for_a_run_the_hub_already_released_still_guards_the_session() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    hub.end_run(&run_id, "closed by someone");
    assert!(hub.runs.is_empty());
    drain(&mut ui_rx);

    end_closing(&mut hub, &run_id, "ended");
    assert!(hub.closing_writers.contains_key("machine-1::session-1"));
    open(&mut hub, false);
    assert!(refused_as_closing(&drain(&mut ui_rx)));

    // A straggler for a replaced writer: the session already has a new run.
    hub.closing_writers.clear();
    open(&mut hub, false);
    let newer = hub.runs.keys().next().unwrap().clone();
    assert_ne!(newer, run_id);
    end_closing(&mut hub, &run_id, "ended");
    assert!(
        hub.closing_writers.is_empty(),
        "the live run's lock is its guard; a straggler must not shadow it"
    );
    assert_eq!(hub.runs.len(), 1);
}

#[test]
fn session_started_rekeys_the_temporary_new_session_lock() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));

    hub.new_session(UI_CONN, &json!({"machineId":"machine-1","cwd":"/repo/new"}));
    assert_eq!(hub.runs.len(), 1);
    let run_id = hub.runs.keys().next().unwrap().clone();
    let temporary = format!("machine-1::__new__::{run_id}");
    assert_eq!(hub.lock_by_key.get(&temporary), Some(&run_id));

    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"session_started","runId":run_id,"sessionId":"minted-session"}),
    );
    assert!(!hub.lock_by_key.contains_key(&temporary));
    assert_eq!(
        hub.lock_by_key.get("machine-1::minted-session"),
        Some(&run_id),
    );
    assert_eq!(hub.runs[&run_id].session_id, "minted-session");

    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"run_status","runId":run_id,"sessionId":"minted-session","state":"ended"}),
    );
    assert!(hub.runs.is_empty());
    assert!(hub.lock_by_key.is_empty());
}

#[test]
fn apns_pruning_preserves_a_token_registered_after_unregistered_timestamp() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    hub.push_devices
        .insert("token".into(), (200, "owner".into()));

    hub.handle(HubCmd::PrunePushToken {
        token: "token".into(),
        invalidated_at_ms: Some(100),
    });
    assert!(hub.push_devices.contains_key("token"));

    hub.handle(HubCmd::PrunePushToken {
        token: "token".into(),
        invalidated_at_ms: Some(200),
    });
    assert!(!hub.push_devices.contains_key("token"));

    hub.push_devices
        .insert("bad-token".into(), (300, "owner".into()));
    hub.handle(HubCmd::PrunePushToken {
        token: "bad-token".into(),
        invalidated_at_ms: None,
    });
    assert!(!hub.push_devices.contains_key("bad-token"));
}

/// A run the hub could not attribute — one the agent found already running,
/// so there is no `session_owners` row naming a person — falls back to the
/// owner of the BOX. That is only sound where the box has one human on it.
///
/// The trigger is a project share, deliberately not `devices.kind`: `kind`
/// records how a machine was ENROLLED, and on the live hub the shared
/// employee sandbox reads `personal` while carrying nine control-shares. A
/// kind gate would have gone on pushing strangers' sessions to its owner —
/// the very complaint — while looking like it fixed something.
#[test]
fn an_unowned_run_pushes_only_from_a_box_nobody_shares() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    let (notify_tx, mut notify_rx) = unbounded_channel();
    hub.notify = Some(notify_tx);
    hub.push_devices
        .insert("owner-phone".into(), (now_ms(), "owner".into()));
    // `test_run` carries no owner_user_id — the unattributed case exactly.
    hub.runs.insert("run-1".into(), test_run(&[]));

    hub.emit_push("run-1", "needs_attention");
    let event = pushed(&mut notify_rx);
    assert_eq!(
        event.device_tokens,
        vec!["owner-phone".to_string()],
        "nobody else works on this machine, so the box's owner is the person"
    );

    // The same machine once a teammate has a project on it. Enrolment did
    // not change and `kind` is still `personal`; the share is the change.
    hub.workspaces
            .conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO project_shares(project_share_id,workspace_id,machine_id,owner_user_id,root,name,created_at,access,visibility) \
                 VALUES('s1','personal:owner','machine-1','owner','/home/devbox/work/crm','crm',1,'control','team')",
                [],
            )
            .unwrap();
    assert_eq!(
        hub.workspaces.device_kind("machine-1").unwrap().as_deref(),
        Some("personal"),
        "the label stayed personal — which is why it cannot be the gate",
    );

    hub.emit_push("run-1", "needs_attention");
    let event = pushed(&mut notify_rx);
    assert!(
        event.device_tokens.is_empty(),
        "a run nobody owns on a box somebody shares belongs to no phone",
    );

    // An attributed run is unaffected either way: it goes to ITS owner.
    if let Some(run) = hub.runs.get_mut("run-1") {
        run.owner_user_id = Some("owner".into());
    }
    hub.emit_push("run-1", "needs_attention");
    assert_eq!(
        pushed(&mut notify_rx).device_tokens,
        vec!["owner-phone".to_string()],
    );
}

/// The same fact the push gate uses, told to the browser: `shared` is
/// present only when somebody else works on the box, and `kind` cannot
/// stand in for it.
#[test]
fn the_snapshot_says_when_a_machine_is_somebody_elses_too() {
    let (hub, _ui_rx, _agent_rx) = test_hub(session(None));
    assert!(
        hub.snapshot_for(UI_CONN)["machines"][0]
            .get("shared")
            .is_none(),
        "a box nobody shares omits the field (optional = absent, never null)",
    );
    hub.workspaces
            .conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO project_shares(project_share_id,workspace_id,machine_id,owner_user_id,root,name,created_at,access,visibility) \
                 VALUES('s1','personal:owner','machine-1','owner','/repo','repo',1,'control','team')",
                [],
            )
            .unwrap();
    let machine = &hub.snapshot_for(UI_CONN)["machines"][0];
    assert_eq!(machine["shared"], true);
    assert!(
        machine.get("kind").is_none(),
        "and it is still enrolled as a personal device — the two are not the same question",
    );
}

/// Model / effort / mode picked on a start screen: what survives the trip.
///
/// The rule these all express is that a BAD pick costs the pick, never the
/// session. `new_session` is one zod object on the agent side, so anything
/// forwarded that the agent refuses takes the whole start down with it —
/// and a session that silently never appears is the worst failure this path
/// has.
#[test]
fn a_start_pick_that_does_not_parse_costs_the_pick_and_not_the_session() {
    // The ordinary case: all three named, all three legal.
    let picked = json!({"permissionMode":"plan","model":"opus","effort":"xhigh"});
    assert_eq!(
        start_settings(&picked, false),
        StartSettings {
            permission_mode: Some("plan".into()),
            model: Some("opus".into()),
            effort: Some("xhigh".into()),
        }
    );

    // Nothing named at all — every session before the picker existed.
    assert_eq!(start_settings(&json!({}), true), StartSettings::default());

    // A stale or hand-made client naming values off the enum. Each field is
    // dropped ALONE: the mode being nonsense must not cost the model.
    let junk = json!({"permissionMode":"yolo","effort":"max","model":"opus"});
    assert_eq!(
        start_settings(&junk, true),
        StartSettings {
            model: Some("opus".into()),
            ..Default::default()
        },
        "`max` is a real CLI level and still not on our wire — see EffortLevel"
    );

    // Wrong TYPES, which is what a buggy client sends rather than a bad enum.
    let typed = json!({"permissionMode":42,"effort":true,"model":["opus"]});
    assert_eq!(start_settings(&typed, true), StartSettings::default());

    // A model id is a free string, so it needs a bound of its own.
    let long = json!({ "model": "m".repeat(MODEL_ID_MAX + 1) });
    assert_eq!(start_settings(&long, true), StartSettings::default());
    assert_eq!(
        start_settings(&json!({"model":"  opus  "}), true)
            .model
            .as_deref(),
        Some("opus"),
        "trimmed, because a picker that pads its value should not pin a model nothing matches"
    );
    assert_eq!(
        start_settings(&json!({"model":"   "}), true),
        StartSettings::default()
    );
}

/// `bypassPermissions` is the one mode whose availability is the MACHINE's
/// call, and the safe reading of an agent that never mentioned it is "no".
#[test]
fn a_machine_that_withholds_bypass_is_not_talked_into_it() {
    let asked = json!({"permissionMode":"bypassPermissions"});
    assert_eq!(start_settings(&asked, false), StartSettings::default());
    assert_eq!(
        start_settings(&asked, true).permission_mode.as_deref(),
        Some("bypassPermissions")
    );
    // And withholding it costs only that mode.
    assert_eq!(
        start_settings(&json!({"permissionMode":"plan"}), false)
            .permission_mode
            .as_deref(),
        Some("plan")
    );
}

/// An agent too old to publish `permissionModes` has also never said it
/// withholds anything — and reading that silence as consent would run a
/// machine without approval prompts on the strength of a message it never
/// sent.
#[test]
fn an_agent_that_never_named_its_modes_is_not_consent() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    assert!(
        !hub.machine_offers_bypass("machine-1", None),
        "silence is not yes"
    );
    assert!(!hub.machine_offers_bypass("machine-missing", None));

    if let Some(agent) = hub.agents.get_mut("machine-1") {
        agent.machine["permissionModes"] = json!(["default", "plan", "acceptEdits"]);
    }
    assert!(
        !hub.machine_offers_bypass("machine-1", None),
        "listed, and not listed"
    );

    if let Some(agent) = hub.agents.get_mut("machine-1") {
        agent.machine["permissionModes"] = json!(["default", "plan", "bypassPermissions"]);
    }
    assert!(hub.machine_offers_bypass("machine-1", None));
}

/// One box, two runtimes, two answers. The Claude list is decided by a
/// PreToolUse hook that never runs on the Codex path, so letting it speak
/// for Codex opens a door the machine only ever opened for Claude.
#[test]
fn codex_asks_its_own_gate_not_claudes() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    if let Some(agent) = hub.agents.get_mut("machine-1") {
        agent.machine["permissionModes"] = json!(["default", "plan", "bypassPermissions"]);
        agent.machine["codexPermissionModes"] = json!(["default", "plan"]);
    }
    assert!(hub.machine_offers_bypass("machine-1", Some("claude")));
    assert!(
        !hub.machine_offers_bypass("machine-1", Some("codex")),
        "Claude's yes is not Codex's yes"
    );

    // And an agent too old to publish the Codex list is silence, not consent
    // — the same asymmetry, on the newer field.
    if let Some(agent) = hub.agents.get_mut("machine-1") {
        agent
            .machine
            .as_object_mut()
            .unwrap()
            .remove("codexPermissionModes");
    }
    assert!(!hub.machine_offers_bypass("machine-1", Some("codex")));
}

/// The two refusals every deployment hits: a hub with no LLM_ENRICH_* env
/// answers "not configured" (the web latches it and keeps its heuristics),
/// and a conn the hub never authenticated is refused before anything else.
/// Both must echo the requestId — the client correlates by it — and carry
/// no `enrichment` field at all (absent, never null).
#[test]
fn enrich_refuses_cleanly_when_unconfigured_or_unauthenticated() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    hub.enrich = None; // the test box's env must not decide this test
    drain(&mut ui_rx);
    let req = |id: &str| {
        json!({"type":"enrich_request","requestId":id,"machineId":"machine-1",
                   "sessionId":"session-1","uuid":"a1-p0","text":"Раскатывать?"})
    };

    hub.on_ui_msg(UI_CONN, req("e1"));
    let frames = drain(&mut ui_rx);
    let r = frames
        .iter()
        .find(|f| f["type"] == "enrich_result")
        .expect("an enrich_request is always answered");
    assert_eq!(r["requestId"], "e1");
    assert_eq!(r["ok"], false);
    assert_eq!(r["error"], "enrichment not configured");
    assert!(r.get("enrichment").is_none());

    let (tx, mut stranger_rx) = channel(8);
    hub.conns.insert(99, tx);
    hub.on_ui_msg(99, req("e2"));
    let frames = drain(&mut stranger_rx);
    assert_eq!(frames[0]["ok"], false);
    assert_eq!(frames[0]["error"], "not authenticated");
}

// ------------------------------------------------------------------
// Contract checks against the TypeScript side of the wire. The Rust hub
// cannot import `shared/`, so these read it from disk at compile time.
// ------------------------------------------------------------------

const WEB_PROTOCOL_TS: &str = include_str!("../../../shared/src/web-protocol.ts");
const LIMITS_TS: &str = include_str!("../../../shared/src/limits.ts");
const HUB_RS: &str = include_str!("../hub.rs");
const WIRE_RS: &str = include_str!("wire.rs");

/// Every member of `BrowserToCentral` and the `type` literal it declares.
fn browser_message_types() -> Vec<String> {
    // `const Name = z.object({ type: z.literal('x')` → Name ↦ x
    let mut literal_of = HashMap::new();
    for (i, _) in WEB_PROTOCOL_TS.match_indices("const ") {
        let rest = &WEB_PROTOCOL_TS[i + 6..];
        let Some(name_end) = rest.find(" = z.object({") else {
            continue;
        };
        let name = &rest[..name_end];
        let body = &rest[name_end..];
        let Some(lit) = body.find("type: z.literal('") else {
            continue;
        };
        // The literal must belong to THIS object: no other `const` in between.
        if body[..lit].contains("\nconst ") || body[..lit].contains("export const ") {
            continue;
        }
        let lit_start = lit + "type: z.literal('".len();
        let lit_end = body[lit_start..].find('\'').unwrap() + lit_start;
        literal_of.insert(name.to_string(), body[lit_start..lit_end].to_string());
    }
    let start = WEB_PROTOCOL_TS
        .find("export const BrowserToCentral = z.discriminatedUnion('type', [")
        .expect("BrowserToCentral union");
    let list = &WEB_PROTOCOL_TS[start..];
    let list = &list[..list.find("]);").unwrap()];
    list.lines()
        .skip(1)
        .map(|l| l.trim().trim_end_matches(','))
        .filter(|l| !l.is_empty())
        .map(|name| {
            literal_of
                .get(name)
                .cloned()
                .unwrap_or_else(|| panic!("{name} has no `type: z.literal(...)`"))
        })
        .collect()
}

/// The body of `on_ui_msg`, with `message::CONST` references replaced by
/// the literal they stand for, so a route written either way is found.
fn on_ui_msg_body() -> String {
    let start = HUB_RS.find("    fn on_ui_msg(&mut self").unwrap();
    let body = &HUB_RS[start..];
    let end = body[10..]
        .find("\n    fn ")
        .map(|i| i + 10)
        .unwrap_or(body.len());
    let mut body = body[..end].to_string();
    for line in WIRE_RS.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("pub const ") {
            if let Some((name, value)) = rest.split_once(": &str = ") {
                let value = value.trim_end_matches(';');
                body = body.replace(&format!("message::{name}"), value);
            }
        }
    }
    body
}

/// The regression that hid «Сжать» for six weeks: `compact` had an agent
/// route, a schema and a button, and `on_ui_msg` still let it fall to
/// `_ => {}` because one token was missing from one list. A message a
/// client can send and the hub does not name is a message the hub drops.
#[test]
fn every_browser_message_type_is_routed_by_on_ui_msg() {
    let types = browser_message_types();
    assert!(types.len() > 20, "parsed the union: {types:?}");
    let body = on_ui_msg_body();
    let missing: Vec<_> = types
        .iter()
        .filter(|t| !body.contains(&format!("\"{t}\"")))
        .collect();
    assert!(missing.is_empty(), "on_ui_msg has no arm for {missing:?}");
}

/// `export const NAME = <int-expression>;` from shared/src/limits.ts.
fn shared_limit(name: &str) -> usize {
    let key = format!("export const {name} = ");
    let start = LIMITS_TS
        .find(&key)
        .unwrap_or_else(|| panic!("{name} in limits.ts"))
        + key.len();
    let expr = &LIMITS_TS[start..LIMITS_TS[start..].find(';').unwrap() + start];
    expr.split('*')
        .map(|part| part.trim().parse::<usize>().unwrap())
        .product()
}

/// The four copies of each attachment limit (web, agent zod, this file)
/// agree, or the hub truncates what the others let through — in silence,
/// until `attachments_dropped` said so; loudly now, but still wrongly.
#[test]
fn attachment_limits_match_shared() {
    assert_eq!(MAX_ATTACH_B64_TOTAL, shared_limit("ATTACH_B64_TOTAL_MAX"));
    assert_eq!(
        crate::images::MAX_EDGE as usize,
        shared_limit("IMAGE_MAX_EDGE")
    );
    // The per-item bounds live inside the sanitizers; probe them.
    let over =
        json!([{ "media_type": "image/png", "data": b64(shared_limit("IMAGE_B64_MAX") + 1) }]);
    assert!(
        sanitize_images(&over).is_none(),
        "one over the shared image bound is dropped"
    );
    let at = json!([{ "media_type": "image/png", "data": b64(shared_limit("IMAGE_B64_MAX")) }]);
    assert_eq!(
        arr_len(sanitize_images(&at)),
        1,
        "exactly the shared image bound passes"
    );
    let over = json!([{ "name": "a", "data": b64(shared_limit("FILE_B64_MAX") + 1) }]);
    assert!(sanitize_files(&over).is_none());
    let nine: Vec<Value> = (0..9)
        .map(|_| json!({ "media_type": "image/png", "data": b64(16) }))
        .collect();
    assert_eq!(
        arr_len(sanitize_images(&Value::Array(nine))),
        shared_limit("MAX_IMAGES_PER_MESSAGE")
    );
    let five: Vec<Value> = (0..5)
        .map(|i| json!({ "name": format!("f{i}"), "data": b64(16) }))
        .collect();
    assert_eq!(
        arr_len(sanitize_files(&Value::Array(five))),
        shared_limit("MAX_FILES_PER_MESSAGE")
    );
}

/// The deadline of a closing writer is written in two languages; the agent's
/// kill grace behind it lives in a third (`KILL_GRACE_MS`).
#[test]
fn run_closing_limit_matches_shared() {
    assert_eq!(
        RUN_CLOSING_MAX_MS as usize,
        shared_limit("RUN_CLOSING_MAX_MS")
    );
}

#[test]
fn dropped_attachments_are_named_not_swallowed() {
    let images = json!([
        { "media_type": "image/png", "data": b64(7 * MB) },
        { "media_type": "image/png", "data": b64(7 * MB) },
        { "media_type": "image/png", "data": b64(7 * MB) },
    ]);
    let (img, fls) = sanitize_attachments(Some(&images), None);
    let loss = attachment_loss(Some(&images), None, img.as_ref(), fls.as_ref())
        .expect("the third did not fit");
    assert!(loss.starts_with("1 of 3 image(s)"), "{loss}");
    assert!(attachment_loss(Some(&images), None, Some(&images), None).is_none());
}

/// For up to the whole run lease after an agent socket drops, the hub used
/// to accept `input` for its runs and hand the frame to `send_to_agent`,
/// which found no socket and did nothing — the person's message vanished
/// from a session that looked perfectly healthy. Only `close` checked.
#[test]
fn a_command_for_an_offline_agent_is_refused_with_a_code() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    drain(&mut ui_rx);
    drain(&mut agent_rx);
    // The socket is gone, the run is held under lease.
    hub.conns.remove(&AGENT_CONN);

    for ty in ["input", "interrupt", "compact", "tool_decision"] {
        hub.on_ui_msg(
            UI_CONN,
            json!({"type":ty,"runId":run_id,"text":"hello","requestId":"r","allow":true}),
        );
        let seen = drain(&mut ui_rx);
        let err = seen
            .iter()
            .find(|m| m["type"] == "error")
            .unwrap_or_else(|| panic!("{ty}: no error frame"));
        assert_eq!(err["code"], json!("machine_offline"), "{ty}");
    }
    assert!(
        drain(&mut agent_rx).is_empty(),
        "nothing was sent into the void"
    );
}

/// `turn_settled` and the CLI's `session_state: idle` come AFTER the
/// `result` that made the run idle. Read as ordinary statuses they flipped
/// the run straight back to «working» — the pane said «Работает» over a
/// finished turn, and the suggestion strip (gated on not-busy) never came.
#[test]
fn the_turn_is_over_signals_do_not_restart_the_run() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    let stream =
        |ev: Value| json!({"type":"stream","runId":run_id,"sessionId":"session-1","event":ev});
    hub.on_agent_msg(
        AGENT_CONN,
        stream(json!({"kind":"assistant","text":"Готово."})),
    );
    hub.on_agent_msg(AGENT_CONN, stream(json!({"kind":"result","text":"done"})));
    assert_eq!(hub.runs[&run_id].state, "idle");
    hub.on_agent_msg(
        AGENT_CONN,
        stream(json!({"kind":"status","code":"session_state","text":"","data":{"state":"idle"}})),
    );
    hub.on_agent_msg(
        AGENT_CONN,
        stream(json!({"kind":"status","code":"turn_settled","text":""})),
    );
    assert_eq!(
        hub.runs[&run_id].state, "idle",
        "the turn is over, not restarted"
    );
    // The CLI waking itself (a background task's notification) IS work.
    hub.on_agent_msg(
        AGENT_CONN,
        stream(
            json!({"kind":"status","code":"session_state","text":"","data":{"state":"running"}}),
        ),
    );
    assert_eq!(hub.runs[&run_id].state, "working");
}

/// A command that outlives the stop of its turn still reports what it
/// printed. 28.09.2026 a Codex `nmap` finished 72 s after the interrupt,
/// its `command_output` flipped the idle run back to «working», and no
/// `result` was ever coming to end it: «работает… 273:14» over an idle
/// thread.
#[test]
fn a_late_command_output_does_not_restart_the_run() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    let stream =
        |ev: Value| json!({"type":"stream","runId":run_id,"sessionId":"session-1","event":ev});
    hub.on_agent_msg(
        AGENT_CONN,
        stream(json!({"kind":"tool_use","text":"$ nmap -p 445 192.168.112.0/24"})),
    );
    assert_eq!(hub.runs[&run_id].state, "working");
    hub.on_agent_msg(
        AGENT_CONN,
        stream(json!({"kind":"result","text":"interrupted"})),
    );
    assert_eq!(hub.runs[&run_id].state, "idle");
    hub.on_agent_msg(
        AGENT_CONN,
        stream(json!({"kind":"status","code":"command_output","text":"445/tcp open\n→ completed"})),
    );
    assert_eq!(
        hub.runs[&run_id].state, "idle",
        "a command's leftovers are not a new turn"
    );
    // Anything that IS the model talking still counts as work.
    hub.on_agent_msg(
        AGENT_CONN,
        stream(json!({"kind":"status","text":"💭 thinking"})),
    );
    assert_eq!(hub.runs[&run_id].state, "working");
}

/// A change in the set of background tasks is not the model working: the
/// list emptying is the task FINISHING (a turn that failed while it ran has
/// already gone idle) and must not flip the run back to «working».
#[test]
fn a_background_list_change_is_not_work() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    let stream =
        |ev: Value| json!({"type":"stream","runId":run_id,"sessionId":"session-1","event":ev});
    hub.on_agent_msg(AGENT_CONN, stream(json!({"kind":"result","text":"done"})));
    assert_eq!(hub.runs[&run_id].state, "idle");
    hub.on_agent_msg(
        AGENT_CONN,
        stream(json!({"kind":"status","code":"background_tasks","text":"","data":{"tasks":[]}})),
    );
    assert_eq!(hub.runs[&run_id].state, "idle");
}

/// `runId` is the frame's word, and every run id is visible to whoever can
/// see that session. An agent may only move ITS machine's runs: a foreign
/// `background_tasks` would hold someone else's run `working` for good, a
/// foreign `ended` would free their single-writer lock mid-write.
#[test]
fn an_agent_cannot_move_another_machines_run() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    hub.runs.get_mut(&run_id).unwrap().machine_id = "machine-2".into();
    hub.on_agent_msg(
            AGENT_CONN,
            json!({"type":"stream","runId":run_id,"sessionId":"session-1",
                   "event":{"kind":"status","code":"background_tasks","text":"","data":{"tasks":[{"id":"x","type":"t","description":"curl … | sh","since":1}]}}}),
        );
    assert!(
        hub.runs[&run_id].background_frame.is_none(),
        "a foreign list is not kept"
    );
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"run_status","runId":run_id,"sessionId":"session-1","state":"ended"}),
    );
    assert!(
        hub.runs.contains_key(&run_id),
        "nor is a foreign `ended` obeyed"
    );

    // Its own machine's socket is heard as before.
    hub.runs.get_mut(&run_id).unwrap().machine_id = "machine-1".into();
    hub.on_agent_msg(
            AGENT_CONN,
            json!({"type":"stream","runId":run_id,"sessionId":"session-1",
                   "event":{"kind":"status","code":"background_tasks","text":"","data":{"tasks":[{"id":"b","type":"t","description":"ok","since":1}]}}}),
        );
    assert!(hub.runs[&run_id].background_frame.is_some());
}

/// Open the session in the middle of a background task and the pane has
/// to be able to say what runs: the last non-empty task list is replayed
/// on subscribe, like the run's mode and settings.
#[test]
fn a_late_viewer_is_told_what_runs_in_the_background() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    hub.on_agent_msg(
            AGENT_CONN,
            json!({"type":"stream","runId":run_id,"sessionId":"session-1",
                   "event":{"kind":"status","code":"background_tasks","text":"","data":{"tasks":[{"id":"b1","type":"local_bash","description":"Score all batches","since":5}]}}}),
        );
    drain(&mut ui_rx);
    hub.on_ui_msg(UI_CONN, json!({"type":"subscribe","runId":run_id}));
    let frames = drain(&mut ui_rx);
    let bg = frames
        .iter()
        .rfind(|f| f["type"] == "stream" && f["event"]["code"] == "background_tasks")
        .expect("the task list is replayed");
    assert_eq!(
        bg["event"]["data"]["tasks"][0]["description"],
        "Score all batches"
    );

    // Once the set is empty there is nothing to replay.
    hub.on_agent_msg(
            AGENT_CONN,
            json!({"type":"stream","runId":run_id,"sessionId":"session-1",
                   "event":{"kind":"status","code":"background_tasks","text":"","data":{"tasks":[]}}}),
        );
    assert!(hub.runs[&run_id].background_frame.is_none());
}

/// The sub-agent cards are a level: the latest set is re-stated to a late
/// viewer, its ticks stay out of the turn's replay window, and a set
/// arriving after the turn ended does not re-open the run.
#[test]
fn a_late_viewer_gets_the_subagent_cards_and_ticks_do_not_flood_the_replay() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    let frame = |n: u32| {
        json!({"type":"stream","runId":run_id,"sessionId":"session-1",
                   "event":{"kind":"status","code":"subagents","text":"",
                            "data":{"agents":[{"id":"t1","kind":"Explore","description":"Проверить вход",
                                               "status":"running","startedAt":1,"toolUses":n}]}}})
    };
    let window = hub.runs[&run_id].replay.len();
    for n in 0..50 {
        hub.on_agent_msg(AGENT_CONN, frame(n));
    }
    assert_eq!(
        hub.runs[&run_id].replay.len(),
        window,
        "ticks are not the turn's frames"
    );
    drain(&mut ui_rx);
    hub.on_ui_msg(UI_CONN, json!({"type":"subscribe","runId":run_id}));
    let frames = drain(&mut ui_rx);
    let cards = frames
        .iter()
        .filter(|f| f["type"] == "stream" && f["event"]["code"] == "subagents")
        .collect::<Vec<_>>();
    assert_eq!(cards.len(), 1, "one level frame, the latest");
    assert_eq!(cards[0]["event"]["data"]["agents"][0]["toolUses"], 49);

    hub.on_agent_msg(
            AGENT_CONN,
            json!({"type":"stream","runId":run_id,"sessionId":"session-1","event":{"kind":"result","text":""}}),
        );
    hub.on_agent_msg(AGENT_CONN, frame(50));
    assert_eq!(hub.runs[&run_id].state, "idle", "a card update is not work");
}

#[test]
fn task_clock_survives_attention_replay_and_updates_on_user_input() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let id = hub.runs.keys().next().unwrap().clone();
    let start = now_ms() - 600_000;
    let status = |stamp| json!({"type":"run_status","runId":id,"sessionId":"session-1","state":"started","taskStartedAt":stamp});
    hub.on_agent_msg(AGENT_CONN, status(start));
    hub.run_needs(&id, false);
    hub.on_agent_msg(AGENT_CONN, status(start));
    assert_eq!(hub.runs[&id].task_started_at, Some(start));
    hub.turn_moved_on(&id);
    assert_eq!(hub.runs[&id].task_started_at, Some(start));
    drain(&mut ui_rx);
    hub.on_agent_msg(AGENT_CONN, status(start + 300_000));
    assert!(drain(&mut ui_rx)
        .iter()
        .any(|frame| frame["type"] == "activity"
            && frame["runs"][0]["taskStartedAt"] == start + 300_000));
    // Stale replay cannot put the new task's clock back.
    hub.on_agent_msg(AGENT_CONN, status(start));
    assert_eq!(hub.runs[&id].task_started_at, Some(start + 300_000));
    hub.run_idle(&id);
    hub.runs.get_mut(&id).unwrap().since = 123;
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"run_status","runId":id,"sessionId":"session-1","state":"idle"}),
    );
    assert_eq!(
        hub.runs[&id].since, 123,
        "idle replay is not a fresh unread answer"
    );
}

/// The agent sends a `status` for every line the CLI writes to stderr.
/// `run_working` used to treat any status as "the turn moved on" and forget
/// the approval the run was stopped on — after which a subscriber was shown
/// «working» and no prompt, while the CLI sat on a question for an hour.
#[test]
fn a_status_line_does_not_forget_a_pending_approval_but_a_token_does() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"tool_request","runId":run_id,"sessionId":"session-1",
                   "requestId":"req-9","tool":"Bash","input":{"command":"ls"}}),
    );
    assert_eq!(hub.runs[&run_id].state, "needs_attention");

    let stream = |kind: &str, code: Option<&str>| {
        let mut ev = json!({"kind":kind,"text":"…"});
        if let Some(c) = code {
            ev["code"] = json!(c);
        }
        json!({"type":"stream","runId":run_id,"sessionId":"session-1","event":ev})
    };
    hub.on_agent_msg(AGENT_CONN, stream("status", Some("stderr")));
    hub.on_agent_msg(AGENT_CONN, stream("status", Some("api_retry")));
    hub.on_agent_msg(AGENT_CONN, stream("system", None));
    assert_eq!(
        hub.runs[&run_id].pending_request_id.as_deref(),
        Some("req-9"),
        "status and system lines are not an answer to the question",
    );
    // Nor do they move the run off `needs_attention`: it is still stopped
    // on a person, and flipping to `working` and back is a fresh
    // transition every notifier announces again.
    assert_eq!(
        hub.runs[&run_id].state, "needs_attention",
        "still blocked on the question"
    );
    drain(&mut ui_rx);
    hub.on_ui_msg(UI_CONN, json!({"type":"subscribe","runId":run_id}));
    let replayed = drain(&mut ui_rx);
    assert!(
        replayed
            .iter()
            .any(|m| m["type"] == "tool_request" && m["requestId"] == "req-9"),
        "a late subscriber still gets the prompt",
    );

    hub.on_agent_msg(AGENT_CONN, stream("partial", None));
    assert!(
        hub.runs[&run_id].pending_request_id.is_none(),
        "a token means the model moved on"
    );
}

/// Three sessions failing every retry for half an hour pushed «сессия
/// упала» per attempt. Once per session per window; a new run of the same
/// session is not new news.
#[test]
fn a_session_that_keeps_failing_is_pushed_once() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    let (notify_tx, mut notify_rx) = unbounded_channel();
    hub.notify = Some(notify_tx);
    hub.runs.insert("run-1".into(), test_run(&[]));
    hub.run_error("run-1");
    assert!(notify_rx.try_recv().is_ok(), "the first failure is news");

    // The retry: a new run of the same session fails too.
    hub.runs.remove("run-1");
    hub.runs.insert("run-2".into(), test_run(&[]));
    hub.run_error("run-2");
    assert!(
        notify_rx.try_recv().is_err(),
        "the same session again is not"
    );

    // Past the window it is said again.
    for at in hub.error_pushed.values_mut() {
        *at -= ERROR_PUSH_REPEAT_MS + 1;
    }
    hub.runs.insert("run-3".into(), test_run(&[]));
    hub.run_error("run-3");
    assert!(notify_rx.try_recv().is_ok());
}

/// «🟧 … ждёт решения» in Telegram after every deploy: a restarted hub
/// adopts the run as idle, the agent re-announces it, and the SAME prompt
/// arrived as a fresh needs_attention. A replayed prompt is shown, never
/// pushed; a new one still is.
#[test]
fn a_replayed_prompt_is_shown_but_not_pushed_again() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    let (notify_tx, mut notify_rx) = unbounded_channel();
    hub.notify = Some(notify_tx);
    drain(&mut ui_rx);

    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"tool_request","runId":run_id,"sessionId":"session-1",
                   "requestId":"req-1","tool":"AskUserQuestion","input":{},"replay":true}),
    );
    assert_eq!(
        hub.runs[&run_id].state, "needs_attention",
        "viewers still see the question"
    );
    assert!(
        notify_rx.try_recv().is_err(),
        "but nobody's phone is told again"
    );

    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"tool_decision","runId":run_id,"requestId":"req-1","allow":true}),
    );
    hub.on_agent_msg(
            AGENT_CONN,
            json!({"type":"stream","runId":run_id,"sessionId":"session-1","event":{"kind":"assistant","text":"…"}}),
        );
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"tool_request","runId":run_id,"sessionId":"session-1",
                   "requestId":"req-2","tool":"Bash","input":{}}),
    );
    assert!(notify_rx.try_recv().is_ok(), "a new question is news");
}

/// One window, one socket, several panes: what the hub sends back while
/// handling a pane's message names that pane, and nothing else does.
#[test]
fn a_reply_names_the_pane_that_asked_and_news_names_nobody() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    drain(&mut ui_rx);

    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"subscribe","runId":run_id,"ref":"pane-2"}),
    );
    let replies = drain(&mut ui_rx);
    let opened = replies
        .iter()
        .find(|m| m["type"] == "opened")
        .expect("subscribe is acked");
    assert_eq!(opened["ref"], json!("pane-2"));

    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"input","runId":"no-such-run","text":"hi","ref":"pane-3"}),
    );
    let refused = drain(&mut ui_rx);
    let err = refused
        .iter()
        .find(|m| m["type"] == "error")
        .expect("refused");
    assert_eq!(
        err["ref"],
        json!("pane-3"),
        "the refusal goes back to the composer that sent it"
    );

    // An agent frame afterwards is news for every pane: no ref.
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"stream","runId":run_id,"sessionId":"session-1",
                   "event":{"kind":"assistant","text":"…"}}),
    );
    let news = drain(&mut ui_rx);
    let stream = news
        .iter()
        .find(|m| m["type"] == "stream")
        .expect("streamed");
    assert!(stream.get("ref").is_none(), "{stream}");

    // And a message without a ref leaves replies untagged, as before.
    hub.on_ui_msg(UI_CONN, json!({"type":"subscribe","runId":run_id}));
    let plain = drain(&mut ui_rx);
    assert!(plain.iter().all(|m| m.get("ref").is_none()), "{plain:?}");
}

/// «Мусорные» уведомления: every agent reconnect re-announces its runs as
/// `run_status: started` plus the same `tool_request`, and the hub used to
/// walk a waiting run through needs_attention → working → needs_attention.
/// Every notifier heard a brand-new question. The re-announce must be
/// invisible: no state change on the wire, and the prompt's id published so
/// a client that lost its memory (hub restart) can still recognise it.
#[test]
fn a_reconnecting_agent_does_not_ask_the_same_question_twice() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    let ask = json!({"type":"tool_request","runId":run_id,"sessionId":"session-1",
                         "requestId":"req-7","tool":"AskUserQuestion","input":{}});
    hub.on_agent_msg(AGENT_CONN, ask.clone());
    let first = drain(&mut ui_rx);
    let activity = first
        .iter()
        .rev()
        .find(|m| m["type"] == "activity")
        .expect("asked");
    assert_eq!(activity["runs"][0]["state"], json!("needs_attention"));
    assert_eq!(activity["runs"][0]["pendingRequestId"], json!("req-7"));

    // What `announceState` sends after the socket comes back.
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"run_status","runId":run_id,"sessionId":"session-1","state":"started"}),
    );
    hub.on_agent_msg(AGENT_CONN, ask);
    let states: Vec<Value> = drain(&mut ui_rx)
        .iter()
        .filter(|m| m["type"] == "activity")
        .map(|m| m["runs"][0]["state"].clone())
        .collect();
    assert!(
        states.iter().all(|s| s == "needs_attention"),
        "the run never left needs_attention: {states:?}",
    );

    // Answering is what moves it on.
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"tool_decision","runId":run_id,"requestId":"req-7","allow":true}),
    );
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"run_status","runId":run_id,"sessionId":"session-1","state":"started"}),
    );
    assert_eq!(hub.runs[&run_id].state, "working");
}

/// `code` and `data` used to be eaten by the hub's field-by-field rebuild
/// of the stream frame, so the quota card never rendered from this path.
#[test]
fn stream_code_and_data_reach_the_browser_and_date_the_run() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    hub.runs.get_mut(&run_id).unwrap().last_event_at = 0;
    drain(&mut ui_rx);
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"stream","runId":run_id,"sessionId":"session-1",
                   "event":{"kind":"status","text":"API 529 — retry 2/10 in 30s","code":"api_retry",
                            "data":{"attempt":2,"max_retries":10}}}),
    );
    let seen = drain(&mut ui_rx);
    let frame = seen
        .iter()
        .find(|m| m["type"] == "stream")
        .expect("relayed");
    assert_eq!(frame["event"]["code"], json!("api_retry"));
    assert_eq!(frame["event"]["data"]["attempt"], json!(2));
    assert!(
        hub.runs[&run_id].last_event_at > 0,
        "the frame dated the run"
    );
    let activity = seen
        .iter()
        .find(|m| m["type"] == "activity")
        .expect("state changed to working");
    assert!(activity["runs"][0]["lastEventAt"].as_i64().unwrap() > 0);
}

/// «Нет событий 2 мин» under a transcript that was visibly filling.
///
/// `last_event_at` moved on every frame, but `activity` only goes out when
/// a run's STATE changes — and a run that is already `working` does not
/// change state again until `result`. So the browser kept the stamp it got
/// when the turn began and diffed it against its own clock: the badge was
/// reading the age of the TURN and calling it silence. It started lying at
/// 90 s into any healthy run and grew from there.
#[test]
fn a_working_run_keeps_telling_viewers_it_is_alive() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    let token = || {
        json!({"type":"stream","runId":run_id,"sessionId":"session-1",
                   "event":{"kind":"assistant","text":"…"}})
    };

    // First frame: the run goes idle -> working, so activity goes out on
    // the state change and everyone's stamp is fresh.
    hub.on_agent_msg(AGENT_CONN, token());
    drain(&mut ui_rx);

    // More frames in the same turn. Nothing changes state, and inside the
    // 30 s window nothing needs re-sending either.
    hub.on_agent_msg(AGENT_CONN, token());
    assert!(
        !drain(&mut ui_rx).iter().any(|m| m["type"] == "activity"),
        "a token is not worth an activity push of its own",
    );

    // Half a minute of frames later, the stamp on the wire is stale even
    // though the run is plainly alive — that is what has to be corrected.
    let run = hub.runs.get_mut(&run_id).unwrap();
    run.last_event_sent_at = now_ms() - 31_000;
    // (and the stamp viewers hold really is old, so the board differs)
    run.last_event_at = now_ms() - 31_000;
    std::thread::sleep(std::time::Duration::from_millis(3));
    drain(&mut ui_rx);
    hub.on_agent_msg(AGENT_CONN, token());
    assert!(
        !drain(&mut ui_rx).iter().any(|m| m["type"] == "activity"),
        "the heartbeat waits for the coalescing tick instead of broadcasting itself",
    );
    settle_coalescing(&mut hub);
    let pushed = drain(&mut ui_rx);
    let activity = pushed
        .iter()
        .find(|m| m["type"] == "activity")
        .expect("the heartbeat re-dates the run for viewers");
    let sent = activity["runs"][0]["lastEventAt"].as_i64().unwrap();
    assert!(
        now_ms() - sent < 1_000,
        "viewers get the CURRENT stamp, not the one from the turn's start",
    );
    assert_eq!(
        activity["runs"][0]["state"],
        json!("working"),
        "still the same turn"
    );
}

/// Inside a tool call the runtime says nothing, and that is not a symptom.
///
/// The CLI heartbeats on every API request, so while the MODEL works the
/// frames keep arriving. Inside a tool it makes no requests at all — and in
/// this product that is most of the time, because the tools are builds and
/// deploys measured in minutes. Viewers need to be able to tell the two
/// silences apart, so the hub reports which one this is.
#[test]
fn a_running_tool_is_a_silence_the_client_can_recognise() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    let frame = |kind: &str| {
        json!({"type":"stream","runId":run_id,"sessionId":"session-1",
                   "event":{"kind":kind,"text":"…"}})
    };

    hub.on_agent_msg(AGENT_CONN, frame("assistant"));
    assert!(
        !hub.runs[&run_id].awaiting_tool,
        "talking to the model is not a tool"
    );

    hub.on_agent_msg(AGENT_CONN, frame("tool_use"));
    assert!(
        hub.runs[&run_id].awaiting_tool,
        "the run is inside a tool now"
    );

    // And viewers are told, or they cannot tell the two apart.
    hub.runs.get_mut(&run_id).unwrap().last_event_sent_at = now_ms() - 31_000;
    drain(&mut ui_rx);
    hub.on_agent_msg(AGENT_CONN, frame("tool_use"));
    settle_coalescing(&mut hub);
    let pushed = drain(&mut ui_rx);
    let activity = pushed
        .iter()
        .find(|m| m["type"] == "activity")
        .expect("re-dated");
    assert_eq!(activity["runs"][0]["awaitingTool"], json!(true));

    // The tool came back and the model spoke again.
    hub.on_agent_msg(AGENT_CONN, frame("partial"));
    assert!(!hub.runs[&run_id].awaiting_tool, "the tool is done");
}

/// The «Сжимаю…» state lived in one browser tab. A reload, a second tab,
/// the phone — all showed an idle button while the queued `/compact` was
/// still pending, and pressing it again ended in «Not enough messages».
#[test]
fn a_pending_compaction_is_replayed_to_a_late_subscriber() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    let stream = |code: &str| {
        json!({"type":"stream","runId":run_id,"sessionId":"session-1",
                   "event":{"kind":"status","text":"…","code":code}})
    };
    hub.on_agent_msg(AGENT_CONN, stream("compact_started"));
    // The turn the compaction was queued behind ends — the replay window
    // is cleared, the compaction is still pending.
    hub.on_agent_msg(AGENT_CONN, json!({"type":"stream","runId":run_id,"sessionId":"session-1","event":{"kind":"result","text":"done"}}));
    drain(&mut ui_rx);
    hub.on_ui_msg(UI_CONN, json!({"type":"subscribe","runId":run_id}));
    let seen = drain(&mut ui_rx);
    assert!(
        seen.iter()
            .any(|m| m["type"] == "stream" && m["event"]["code"] == "compact_started"),
        "the pending compaction is re-stated: {seen:?}",
    );
    hub.on_agent_msg(AGENT_CONN, stream("compact_done"));
    drain(&mut ui_rx);
    hub.on_ui_msg(UI_CONN, json!({"type":"subscribe","runId":run_id}));
    let seen = drain(&mut ui_rx);
    assert!(
        !seen.iter().any(|m| m["event"]["code"] == "compact_started"),
        "done — nothing to re-state"
    );
}
/// 28.09.2026: a message typed on the phone never appeared on the desktop
/// following the same run — the answer streamed in with no question above
/// it. A person's turn is now a frame of its own, for every screen on the
/// run and for the one that attaches mid-turn; once the turn lands it is
/// the transcript's to show.
#[test]
fn a_persons_turn_reaches_every_screen_on_the_run() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    let mut desk_rx = add_colleague(&mut hub, 7);
    hub.on_ui_msg(7, json!({"type":"subscribe","runId":run_id}));
    drain(&mut ui_rx);
    drain(&mut desk_rx);
    drain(&mut agent_rx);

    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"input","runId":run_id,"text":"1-4 гоу",
                   "files":[{"name":"plan.md","data":"aGk="}]}),
    );
    assert!(
        drain(&mut agent_rx).iter().any(|m| m["type"] == "input"),
        "the agent still gets the input"
    );
    // What the agent says as it hands the turn to the runtime (`deliver`).
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"run_status","runId":run_id,"sessionId":"session-1","state":"started"}),
    );
    let turn = |rx: &mut Receiver<String>| {
        drain(rx)
            .into_iter()
            .find(|m| m["type"] == "user_turn" && m["text"] == "1-4 гоу")
    };
    let desk = turn(&mut desk_rx).expect("the other screen sees the turn");
    assert_eq!(desk["runId"], json!(run_id));
    assert_eq!(desk["files"], json!(["plan.md"]));
    assert!(desk.get("images").is_none(), "no pictures, no count");
    assert!(desk["turnId"].as_str().is_some_and(|t| !t.is_empty()));
    let own = turn(&mut ui_rx).expect("the sender's pane gets it to fold into its echo");
    assert_eq!(own["turnId"], desk["turnId"], "one turn, one id");

    // A socket still in `browsers` whose rights are gone (a share revoked,
    // an account suspended since it subscribed) is asked again — and gets
    // nothing.
    let (tx, mut gone_rx) = channel(128);
    hub.conns.insert(11, tx);
    hub.ui_clients.insert(11);
    hub.runs.get_mut(&run_id).unwrap().browsers.insert(11);
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"input","runId":run_id,"text":"второе"}),
    );
    assert!(
        !drain(&mut gone_rx).iter().any(|m| m["type"] == "user_turn"),
        "no rights, no words"
    );
    drain(&mut ui_rx);
    drain(&mut desk_rx);

    // Opened mid-turn — the desktop after the phone sent.
    let mut late_rx = add_colleague(&mut hub, 8);
    hub.on_ui_msg(8, json!({"type":"subscribe","runId":run_id}));
    assert!(
        turn(&mut late_rx).is_some(),
        "a late screen inherits the question"
    );

    // The turn lands: from here the transcript carries it.
    hub.on_agent_msg(
            AGENT_CONN,
            json!({"type":"stream","runId":run_id,"sessionId":"session-1","event":{"kind":"result","text":"done"}}),
        );
    let mut after_rx = add_colleague(&mut hub, 9);
    hub.on_ui_msg(9, json!({"type":"subscribe","runId":run_id}));
    assert!(
        turn(&mut after_rx).is_none(),
        "a landed turn is not replayed"
    );

    // A paste is shown, not carried: capped, and says so.
    let long = "я".repeat(USER_TURN_TEXT_MAX + 10);
    let capped = user_turn_frame("r", "s", Some(&long), None, None).unwrap();
    assert_eq!(
        capped["text"].as_str().unwrap().chars().count(),
        USER_TURN_TEXT_MAX
    );
    assert_eq!(capped["truncated"], json!(true));

    // A bare resume says nothing.
    assert!(user_turn_frame("r", "s", Some("  "), None, Some(&json!([]))).is_none());
    assert_eq!(
        user_turn_frame(
            "r",
            "s",
            None,
            Some(&json!([{"media_type":"image/png","data":"x"}])),
            None
        )
        .unwrap()["images"],
        json!(1)
    );
}

#[tokio::test]
async fn confirmed_failed_start_replay_unblocks_deletion_but_foreign_agent_cannot() {
    let (mut hub, _, mut agent) = test_hub(session(None));
    hub.workspaces
        .ensure_user("alice", "alice@example.test", None)
        .unwrap();
    hub.workspaces
        .remember_pending_session("failed-run", "machine-1", "alice", None, None)
        .unwrap();
    let (reply, result) = tokio::sync::oneshot::channel();
    hub.handle(HubCmd::RequestAccountDeletion {
        user_id: "alice".into(),
        transfers: json!([]),
        receipt: "d".repeat(64),
        reply,
    });
    assert!(result.await.unwrap().is_ok());
    let outcome = json!({"type":"session_origin","runId":"failed-run","sessionId":null});
    hub.on_agent_msg(UI_CONN, outcome.clone());
    assert!(hub.workspaces.erase_account("alice").is_err());
    drain(&mut agent);
    hub.on_agent_msg(AGENT_CONN, outcome);
    assert!(drain(&mut agent)
        .iter()
        .any(|v| v["type"] == "session_origin_ack"));
    hub.workspaces.erase_account("alice").unwrap();
    assert!(!hub.session_erased("machine-1", "other-session"));
}

#[test]
fn reconnect_resolves_pending_owner_before_adopting_run() {
    let (mut hub, _, _) = test_hub(session(None));
    hub.workspaces
        .ensure_user("alice", "alice@example.test", None)
        .unwrap();
    hub.workspaces
        .remember_pending_session("new-run", "machine-1", "alice", Some("rambling"), None)
        .unwrap();
    hub.adopt_declared_run(
        "machine-1",
        "Machine",
        "new-run",
        "new-session",
        "/repo".into(),
    );
    assert_eq!(hub.runs["new-run"].owner_user_id.as_deref(), Some("alice"));
    assert_eq!(hub.runs["new-run"].category.as_deref(), Some("rambling"));
    assert_eq!(
        hub.session_meta["machine-1::new-session"].owner_user_id,
        "alice"
    );
}

#[tokio::test]
async fn late_new_session_is_tombstoned_after_deletion_and_run_loss() {
    let (mut hub, mut ui, mut agent) = test_hub(session(None));
    hub.workspaces
        .ensure_user("alice", "alice@example.test", None)
        .unwrap();
    let run = hub
        .spawn_session(SpawnSpec {
            sealed: None,
            machine_id: "machine-1".into(),
            cwd: "/repo".into(),
            message: Some("private".into()),
            images: None,
            files: None,
            category: None,
            source: None,
            require_gateway: false,
            permission_mode: None,
            model: None,
            effort: None,
            owner_user_id: Some("alice".into()),
            owner_name: None,
            origin: None,
            attach: None,
            run_by: None,
        })
        .unwrap();
    let (reply, result) = tokio::sync::oneshot::channel();
    hub.handle(HubCmd::RequestAccountDeletion {
        user_id: "alice".into(),
        transfers: json!([]),
        receipt: "b".repeat(64),
        reply,
    });
    assert!(result.await.unwrap().is_ok());
    assert!(hub.session_erased("machine-1", "unknown-late-session"));
    assert!(hub.workspaces.erase_account("alice").is_err());
    // Simulate losing ephemeral run state during a restart/reconciliation.
    hub.end_run(&run, "restart");
    drain(&mut ui);
    drain(&mut agent);
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"session_started","runId":run,"sessionId":"late-session"}),
    );
    assert!(hub.session_erased("machine-1", "late-session"));
    assert!(!hub.session_erased("machine-1", "unrelated-session"));
    assert!(drain(&mut agent)
        .iter()
        .any(|v| v["type"] == "close" && v["runId"] == run));
    assert!(!drain(&mut ui).iter().any(|v| v["type"] == "opened"));
    hub.workspaces.erase_account("alice").unwrap();
    hub.adopt_declared_run("machine-1", "Machine", &run, "late-session", "/repo".into());
    assert!(!hub.runs.contains_key(&run));
}

#[tokio::test]
async fn account_erasure_blocks_shared_machine_reopen_stream_and_reconnect() {
    let (mut hub, mut ui, mut agent) = test_hub(session(None));
    hub.workspaces
        .ensure_user("alice", "alice@example.test", None)
        .unwrap();
    hub.workspaces
        .record_session_owner("machine-1", "session-1", "alice", None)
        .unwrap();
    hub.session_meta.insert(
        "machine-1::session-1".into(),
        SessionMeta {
            owner_user_id: "alice".into(),
            category: None,
            stage: None,
            origin: None,
        },
    );
    hub.adopt_declared_run(
        "machine-1",
        "Machine",
        "running",
        "session-1",
        "/repo".into(),
    );
    hub.runs
        .get_mut("running")
        .unwrap()
        .browsers
        .insert(UI_CONN);
    assert!(hub.ui_can_drive_run(UI_CONN, &hub.runs["running"]));
    hub.adopt_declared_run("machine-1", "Machine", "late", "session-1", "/repo".into());
    let mut stale = hub.runs.remove("late").unwrap();
    stale.browsers.insert(UI_CONN);
    let (reply, result) = tokio::sync::oneshot::channel();
    hub.handle(HubCmd::RequestAccountDeletion {
        user_id: "alice".into(),
        transfers: json!([]),
        receipt: "a".repeat(64),
        reply,
    });
    assert!(result.await.unwrap().is_ok());
    assert!(hub.runs.is_empty());
    assert!(!hub.ui_can_view_session(UI_CONN, "machine-1", "session-1", Some("/repo")));
    assert!(!hub.ui_can_drive_run(UI_CONN, &stale));
    drain(&mut agent);
    drain(&mut ui);
    open(&mut hub, false);
    open(&mut hub, true);
    hub.route_rpc_request(UI_CONN, &json!({"machineId":"machine-1","requestId":"q","method":"session.messages","params":{"sessionId":"session-1"}}));
    assert!(drain(&mut agent).is_empty());
    hub.runs.insert("late".into(), stale);
    drain(&mut ui);
    hub.to_run_browsers("late", &json!({"type":"stream","event":{"text":"private"}}));
    assert!(drain(&mut ui).is_empty());
    let (reply, result) = tokio::sync::oneshot::channel();
    hub.handle(HubCmd::EraseAccount {
        user_id: "alice".into(),
        reply,
    });
    assert!(result.await.unwrap().is_ok());
    assert!(hub.runs.is_empty());
    hub.adopt_declared_run(
        "machine-1",
        "Machine",
        "reconnected",
        "session-1",
        "/repo".into(),
    );
    assert!(!hub.runs.contains_key("reconnected"));
    let snapshot = hub.snapshot_for(UI_CONN);
    assert!(snapshot["machines"][0]["sessions"]
        .as_array()
        .unwrap()
        .is_empty());
}

/// Put `session-1` in the store as the agent reported it, with a committed
/// replica, then take its file away when `gone` — an archived session.
fn store_session(hub: &mut Hub, gone: bool) {
    hub.store
        .set_state_for_test("machine-1", "claude", "session-1", 1, 1.0);
    let machine = hub.agents["machine-1"].machine.clone();
    hub.store.record_machine(&machine, 1).unwrap();
    hub.store
        .record_inventory("machine-1", &[session(None)], true, 2)
        .unwrap();
    if gone {
        hub.store
            .record_inventory("machine-1", &[], true, 3)
            .unwrap();
        hub.agents.get_mut("machine-1").unwrap().sessions.clear();
    }
}

fn rpc(hub: &mut Hub, id: &str, method: &str) {
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"rpc_request","requestId":id,"machineId":"machine-1","method":method,
                   "params":{"sessionId":"session-1","cwd":"/repo"}}),
    );
}

fn snapshot_ids(hub: &Hub) -> Vec<(String, bool)> {
    hub.snapshot_for(UI_CONN)["machines"][0]["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| {
            (
                s["sessionId"].as_str().unwrap().to_string(),
                s["archived"] == true,
            )
        })
        .collect()
}

/// Sessions started through the fleet API are agent jobs: the snapshot stamps
/// `automated` on them (clients hide those like cron runs), and only on them.
#[test]
fn snapshot_marks_fleet_origin_sessions_automated() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    store_session(&mut hub, false);
    let key = "machine-1::session-1".to_string();
    let meta = |origin: Option<&str>| SessionMeta {
        owner_user_id: "owner".into(),
        category: None,
        stage: None,
        origin: origin.map(str::to_string),
    };
    hub.session_meta.insert(key.clone(), meta(None));
    let snap = hub.snapshot_for(UI_CONN);
    assert!(snap["machines"][0]["sessions"][0]
        .get("automated")
        .is_none());
    hub.session_meta.insert(key, meta(Some("fleet")));
    let snap = hub.snapshot_for(UI_CONN);
    assert_eq!(snap["machines"][0]["sessions"][0]["automated"], true);
}

/// `sync_forget`: the owner stopped syncing a folder. The session is gone
/// from the hub — not archived, not readable — and only for the machine on
/// the socket that said so.
#[test]
fn sync_forget_drops_the_session_and_its_history() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    store_session(&mut hub, false);
    assert_eq!(snapshot_ids(&hub), vec![("session-1".to_string(), false)]);
    assert!(hub.store.has_session("machine-1", "session-1"));

    // A socket that is not this machine's agent speaks for nobody.
    hub.on_agent_msg(
        UI_CONN,
        json!({"type":"sync_forget","sessions":[{"source":"claude","sessionId":"session-1"}]}),
    );
    assert!(hub.store.has_session("machine-1", "session-1"));

    drain(&mut ui_rx);
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"sync_forget","sessions":[{"source":"claude","sessionId":"session-1"}]}),
    );
    assert!(
        !hub.store.has_session("machine-1", "session-1"),
        "row and history gone"
    );
    assert!(!drain(&mut ui_rx).is_empty(), "UIs are told");
    // The owner's next inventory no longer lists it: nothing comes back as archived.
    hub.store
        .record_inventory("machine-1", &[], true, 4)
        .unwrap();
    hub.agents.get_mut("machine-1").unwrap().sessions.clear();
    assert!(snapshot_ids(&hub).is_empty());
}

/// Retention the machine declared: sessions idle past N days leave the hub,
/// a session with a live process stays whatever its age, and the agent is
/// handed a fresh catalog so a session picked up again syncs from scratch.
/// A machine that never declared a period keeps everything.
#[test]
fn retention_purges_idle_sessions_of_a_machine_that_declared_it() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    let day = 86_400_000_i64;
    let now = 400 * day;
    let s = |id: &str, age: i64| {
        json!({"sessionId":id,"source":"codex","title":"t","cwd":"/srv/legal/projects/a",
                   "lastModified": (now - age * day) as f64})
    };
    let machine = hub.agents["machine-1"].machine.clone();
    hub.store.record_machine(&machine, 1).unwrap();
    hub.store
        .record_inventory(
            "machine-1",
            &[s("old", 9), s("busy", 9), s("fresh", 1)],
            true,
            2,
        )
        .unwrap();
    hub.agents.get_mut("machine-1").unwrap().liveness.insert(
        "busy".into(),
        Live {
            pid: Some(4242),
            active: Some(true),
            status: None,
        },
    );

    hub.purge_expired_transcripts_at(now);
    assert!(
        hub.store.has_session("machine-1", "old"),
        "no declaration, no purge"
    );

    let mut declared = machine.clone();
    declared["policy"] = json!({"chatOnly":false,"sync":"all","transcriptRetentionDays":7});
    hub.store.record_machine(&declared, 3).unwrap();
    hub.agents.get_mut("machine-1").unwrap().machine = declared;
    drain(&mut ui_rx);
    drain(&mut agent_rx);
    hub.purge_expired_transcripts_at(now);

    assert!(
        !hub.store.has_session("machine-1", "old"),
        "idle past seven days: gone"
    );
    assert!(
        hub.store.has_session("machine-1", "busy"),
        "a live process keeps its session"
    );
    assert!(hub.store.has_session("machine-1", "fresh"));
    let catalog = drain(&mut agent_rx)
        .into_iter()
        .find(|m| m["type"] == "session_sync_catalog")
        .expect("the agent learns what the hub still holds");
    assert!(catalog["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .all(|st| st["sessionId"] != "old"));
    assert!(!drain(&mut ui_rx).is_empty(), "UIs are told");
    assert!(hub.agents["machine-1"]
        .sessions
        .iter()
        .all(|x| x["sessionId"] != "old"));
}

/// A session whose file vanished is listed as archived, cannot be resumed,
/// and deleting it is the hub's own job (the agent has nothing to delete):
/// answered at once, gone from the list, its history no longer readable.
#[test]
fn an_archived_session_is_listed_refuses_resume_and_is_deleted_by_the_hub() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    store_session(&mut hub, true);
    assert_eq!(snapshot_ids(&hub), vec![("session-1".to_string(), true)]);

    drain(&mut ui_rx);
    open(&mut hub, false);
    let refusal = drain(&mut ui_rx)
        .into_iter()
        .find(|m| m["type"] == "error")
        .expect("open of an archived session is refused");
    assert!(refusal["message"].as_str().unwrap().contains("архиве"));

    drain(&mut agent_rx);
    rpc(&mut hub, "del", "session.delete");
    assert!(
        drain(&mut agent_rx)
            .iter()
            .all(|m| m["type"] != "rpc_request"),
        "nothing for the agent to delete"
    );
    let answer = drain(&mut ui_rx)
        .into_iter()
        .find(|m| m["type"] == "rpc_response" && m["requestId"] == "del")
        .expect("answered by the hub");
    assert_eq!(answer["ok"], true);
    assert!(snapshot_ids(&hub).is_empty());

    rpc(&mut hub, "read", "session.messages");
    let read = drain(&mut ui_rx)
        .into_iter()
        .find(|m| m["type"] == "rpc_response" && m["requestId"] == "read")
        .expect("answered");
    assert_eq!(read["ok"], false, "a deleted session is not readable by id");

    rpc(&mut hub, "sub", "session.subagent");
    let sub = drain(&mut ui_rx)
        .into_iter()
        .find(|m| m["type"] == "rpc_response" && m["requestId"] == "sub")
        .expect("answered");
    assert_eq!(sub["ok"], false, "nor are its sub-agents' transcripts");
}

/// A delete the agent refuses is taken back: when the file later vanishes
/// the session archives like any other. One the agent carries out stays
/// gone.
#[test]
fn a_refused_delete_is_taken_back_a_done_one_is_not() {
    for (ok, listed) in [(false, true), (true, false)] {
        let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
        store_session(&mut hub, false);
        drain(&mut agent_rx);
        rpc(&mut hub, "del", "session.delete");
        assert!(drain(&mut agent_rx)
            .iter()
            .any(|m| m["type"] == "rpc_request"));
        hub.on_agent_msg(
            AGENT_CONN,
            json!({"type":"rpc_response","requestId":"del","ok":ok,"error":"nope"}),
        );
        drain(&mut ui_rx);
        hub.store
            .record_inventory("machine-1", &[], true, 3)
            .unwrap();
        hub.agents.get_mut("machine-1").unwrap().sessions.clear();
        assert_eq!(!snapshot_ids(&hub).is_empty(), listed, "agent ok={ok}");
    }
}

/// The acting person's id and email ride new_session / resume / takeover to
/// the agent (HEGAI_RUN_USER_*); fleet-started runs carry none.
#[test]
fn run_by_travels_with_ui_starts_and_not_with_fleet() {
    let (mut hub, _ui_rx, mut agent_rx) = test_hub(session(None));
    let email = hub.ui_access[&UI_CONN].viewer["email"]
        .as_str()
        .expect("test viewer has an email")
        .to_string();
    let user = hub.ui_access[&UI_CONN].user_id.clone();
    let find = |rx: &mut Receiver<String>, ty: &str| -> Value {
        drain(rx)
            .into_iter()
            .find(|m| m["type"] == ty)
            .unwrap_or_else(|| panic!("no {ty} frame"))
    };

    hub.new_session(UI_CONN, &json!({"machineId":"machine-1","cwd":"/repo"}));
    let frame = find(&mut agent_rx, "new_session");
    assert_eq!(frame["runBy"]["userId"], user);
    assert_eq!(frame["runBy"]["email"], email);

    open(&mut hub, false);
    let frame = find(&mut agent_rx, "resume");
    assert_eq!(frame["runBy"]["userId"], user);
    assert_eq!(frame["runBy"]["email"], email);

    let (mut hub, _ui_rx, mut agent_rx) = test_hub(session(Some(4242)));
    open(&mut hub, true);
    let frame = find(&mut agent_rx, "takeover");
    assert_eq!(frame["runBy"]["userId"], user);

    let (mut hub, _ui_rx, mut agent_rx) = test_hub(session(None));
    hub.fleet_spawn("owner", "machine-1", "/work", "spec", &json!({}), None)
        .unwrap();
    assert!(find(&mut agent_rx, "new_session").get("runBy").is_none());
    hub.resume_session(ResumeSpec {
        sealed: None,
        machine_id: "machine-1".into(),
        session_id: "session-1".into(),
        message: Some("go".into()),
        images: None,
        files: None,
        force: false,
        picked: start_settings(&json!({}), false),
        attach: None,
        can_control: true,
        origin: Some("fleet".into()),
        run_by: None,
    })
    .unwrap();
    assert!(find(&mut agent_rx, "resume").get("runBy").is_none());
}

/// A member (can_start, no control) on someone else's machine may rename a
/// session they can see, and create ONE new folder directly inside a shared
/// root — nothing nested, hidden, relative or outside the share.
#[test]
fn member_may_rename_and_make_a_single_folder_in_a_shared_root() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    let last_params = std::cell::RefCell::new(Value::Null);
    let mut call = |hub: &mut Hub, id: &str, method: &str, params: Value| -> (bool, String) {
        hub.pending_rpc.clear(); // the agent never answers here; ids repeat
        drain(&mut agent_rx);
        drain(&mut ui_rx);
        hub.on_ui_msg(
            UI_CONN,
            json!({"type":"rpc_request","requestId":id,"machineId":"machine-1",
                   "method":method,"params":params}),
        );
        let sent = drain(&mut agent_rx)
            .into_iter()
            .find(|m| m["type"] == "rpc_request" && m["requestId"] == id);
        let forwarded = sent.is_some();
        if let Some(m) = sent {
            *last_params.borrow_mut() = m["params"].clone();
        }
        let err = drain(&mut ui_rx)
            .into_iter()
            .find(|m| m["type"] == "rpc_response" && m["requestId"] == id)
            .and_then(|m| m["error"].as_str().map(str::to_string))
            .unwrap_or_default();
        (forwarded, err)
    };
    // The owner is unaffected, even for a nested path.
    let (ok, _) = call(
        &mut hub,
        "o",
        "fs.mkdir",
        json!({"cwd":"/elsewhere","path":"a/b"}),
    );
    assert!(ok, "the owner keeps full mkdir");

    seat_as_team_member(&mut hub);
    let (ok, err) = call(
        &mut hub,
        "m1",
        "fs.mkdir",
        json!({"cwd":"/repo","path":"Новая папка"}),
    );
    assert!(ok, "single segment under the shared root: {err}");
    // The cwd must BE the root: a deeper (maybe missing, maybe symlinked) cwd
    // would let the agent create parents or step out of the share.
    let (ok, err) = call(
        &mut hub,
        "m1b",
        "fs.mkdir",
        json!({"cwd":"/repo/sub","path":"x"}),
    );
    assert!(
        !ok && err.contains("Read-only"),
        "nested cwd refused: {err}"
    );
    for same in ["/repo/", "/repo//", "/repo/."] {
        let (ok, err) = call(&mut hub, "m1c", "fs.mkdir", json!({"cwd":same,"path":"y"}));
        assert!(ok, "{same:?} is the root: {err}");
    }
    // The forwarded frame is a plain non-recursive mkdir, whatever the client said.
    let (ok, _) = call(
        &mut hub,
        "m1d",
        "fs.mkdir",
        json!({"cwd":"/repo","path":"z","recursive":true}),
    );
    assert!(ok);
    assert_eq!(last_params.borrow()["recursive"], false);
    for bad in [
        "a/b",
        "..",
        ".",
        ".hidden",
        "",
        "a\\b",
        "c:",
        &"x".repeat(65),
    ] {
        let (ok, err) = call(
            &mut hub,
            "m2",
            "fs.mkdir",
            json!({"cwd":"/repo","path":bad}),
        );
        assert!(!ok, "{bad:?} must not reach the agent");
        assert!(err.contains("Имя папки"), "{bad:?}: {err}");
    }
    let (ok, err) = call(
        &mut hub,
        "m3",
        "fs.mkdir",
        json!({"cwd":"/elsewhere","path":"x"}),
    );
    assert!(!ok && err.contains("Read-only"), "outside the share: {err}");
    let (ok, _) = call(
        &mut hub,
        "m4",
        "fs.write",
        json!({"cwd":"/repo","path":"x"}),
    );
    assert!(!ok, "no other write opens");

    // A teammate's session (not the member's, not the device owner's).
    hub.session_meta.insert(
        "machine-1::session-1".into(),
        SessionMeta {
            owner_user_id: "colleague".into(),
            category: None,
            stage: None,
            origin: None,
        },
    );
    let (ok, err) = call(
        &mut hub,
        "r1",
        "session.rename",
        json!({"sessionId":"session-1","cwd":"/repo","title":"Новое имя"}),
    );
    assert!(ok, "a visible session can be renamed: {err}");

    // Someone with no access to the machine gets neither.
    let ws = hub.workspaces.clone();
    ws.ensure_user("stranger", "s@example.com", None).unwrap();
    ws.activate_access("stranger", "tests").unwrap();
    let access = ws.ui_access("stranger", None, false).unwrap();
    hub.ui_access.insert(UI_CONN, access);
    let (ok, _) = call(
        &mut hub,
        "s1",
        "fs.mkdir",
        json!({"cwd":"/repo","path":"x"}),
    );
    assert!(!ok, "no can_start, no mkdir");
}

/// A UI turn carries the typist's identity, taken from the SENDING connection
/// at send time, not from whoever started the run; resume's first turn too.
#[test]
fn ui_input_frames_carry_the_sender_not_the_run_starter() {
    let (mut hub, _ui_rx, mut agent_rx) = test_hub(session(None));
    hub.new_session(UI_CONN, &json!({"machineId":"machine-1","cwd":"/repo"}));
    let started = drain(&mut agent_rx)
        .into_iter()
        .find(|m| m["type"] == "new_session")
        .unwrap();
    let run_id = started["runId"].as_str().unwrap().to_string();
    let starter_email = started["runBy"]["email"].as_str().unwrap().to_string();
    // The person at this socket is now someone else (another viewer, same run).
    hub.ui_access.get_mut(&UI_CONN).unwrap().viewer["email"] = json!("typist@example.com");
    hub.on_ui_msg(UI_CONN, json!({"type":"input","runId":run_id,"text":"hi"}));
    let input = drain(&mut agent_rx)
        .into_iter()
        .find(|m| m["type"] == "input")
        .expect("the turn reaches the agent");
    assert_eq!(input["by"]["email"], "typist@example.com");
    assert_ne!(input["by"]["email"], starter_email.as_str());
    assert_eq!(input["by"]["userId"], started["runBy"]["userId"]);

    // resume with a first message: the follow-up input names the opener.
    let (mut hub, _ui_rx, mut agent_rx) = test_hub(session(None));
    hub.open_run(
        UI_CONN,
        &json!({"machineId":"machine-1","sessionId":"session-1","message":"go"}),
        false,
    );
    let frames = drain(&mut agent_rx);
    let input = frames.iter().find(|m| m["type"] == "input").unwrap();
    assert_eq!(
        input["by"]["userId"],
        frames.iter().find(|m| m["type"] == "resume").unwrap()["runBy"]["userId"]
    );
}

/// An answer (plan accepted, question answered) names who gave it, since it can
/// launch a turn; the agent counts it for authorship.
#[test]
fn ui_tool_decisions_carry_the_answering_user() {
    let (mut hub, _ui_rx, mut agent_rx) = test_hub(session(None));
    hub.new_session(UI_CONN, &json!({"machineId":"machine-1","cwd":"/repo"}));
    let run_id = drain(&mut agent_rx)
        .into_iter()
        .find(|m| m["type"] == "new_session")
        .unwrap()["runId"]
        .as_str()
        .unwrap()
        .to_string();
    hub.ui_access.get_mut(&UI_CONN).unwrap().viewer["email"] = json!("approver@example.com");
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"tool_decision","runId":run_id,"requestId":"q1","allow":true}),
    );
    let frame = drain(&mut agent_rx)
        .into_iter()
        .find(|m| m["type"] == "tool_decision")
        .expect("the decision reaches the agent");
    assert_eq!(frame["by"]["email"], "approver@example.com");
    assert!(frame["by"]["userId"].as_str().is_some());
}

/// The member-mkdir root check compares normalised roots: trailing slashes
/// and Windows case/separator variants are the same root, a child is not.
#[test]
fn shared_root_equality_ignores_slashes_and_windows_case() {
    assert_eq!(
        normalize_root("C:\\Work\\Share\\"),
        normalize_root("c:/work/share")
    );
    assert_eq!(normalize_root("/srv/share//"), normalize_root("/srv/share"));
    assert_ne!(
        normalize_root("/srv/share/sub"),
        normalize_root("/srv/share")
    );
    assert_ne!(normalize_root("/srv/Share"), normalize_root("/srv/share"));
}

/// A member's folder leaves a `dir.created` row with who, where and what name.
#[test]
fn a_members_folder_is_audited_with_actor_cwd_and_name() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    seat_as_team_member(&mut hub);
    hub.pending_rpc.insert(
        "d1".into(),
        PendingRpc {
            conn: UI_CONN,
            machine_id: "machine-1".into(),
            method: "fs.mkdir".into(),
            cwd: Some("/repo".into()),
            history: None,
            deleting: None,
            ..Default::default()
        },
    );
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"rpc_response","requestId":"d1","ok":true,"result":{"path":"newdir","created":true}}),
    );
    let wid = hub.ui_access[&UI_CONN].workspace_id.clone();
    let mut events = hub
        .workspaces
        .audit_events("owner", &wid)
        .unwrap_or_default();
    events.extend(
        hub.workspaces
            .audit_events("owner", "personal:owner")
            .unwrap_or_default(),
    );
    let row = events
        .iter()
        .find(|e| e["action"] == "dir.created")
        .expect("the member's mkdir is audited");
    assert_eq!(row["actorUserId"], "owner");
    assert_eq!(row["metadata"]["machineId"], "machine-1");
    assert_eq!(row["metadata"]["cwd"], "/repo");
    assert_eq!(row["metadata"]["path"], "newdir");
}

/// A share with a list (`project_share_members`) is closed to a workspace
/// member who is not on it — start, files, transcripts — and opens, as a room
/// where the device owner's sessions show too, for one who is. An empty list
/// is the old behaviour.
#[test]
fn a_share_with_a_list_is_closed_to_the_unlisted_and_open_to_the_listed() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    seat_as_team_member(&mut hub);
    let share_id: String = hub
        .workspaces
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT project_share_id FROM project_shares WHERE root='/repo'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let set_list = |hub: &Hub, users: &[&str]| {
        let conn = hub.workspaces.conn.lock().unwrap();
        conn.execute(
            "UPDATE project_shares SET restricted=1 WHERE project_share_id=?1",
            [&share_id],
        )
        .unwrap();
        conn.execute(
            "DELETE FROM project_share_members WHERE project_share_id=?1",
            [&share_id],
        )
        .unwrap();
        for u in users {
            conn.execute(
                "INSERT INTO project_share_members VALUES(?1,?2,'member',1)",
                [&share_id, &u.to_string()],
            )
            .unwrap();
        }
    };
    let start = |hub: &mut Hub, rx: &mut Receiver<String>| -> bool {
        drain(rx);
        hub.new_session(
            UI_CONN,
            &json!({"machineId":"machine-1","cwd":"/repo/app","message":"x"}),
        );
        drain(rx).iter().any(|m| m["type"] == "new_session")
    };
    let list_dir =
        |hub: &mut Hub, agent_rx: &mut Receiver<String>, ui_rx: &mut Receiver<String>| {
            hub.pending_rpc.clear();
            drain(agent_rx);
            drain(ui_rx);
            hub.on_ui_msg(
                UI_CONN,
                json!({"type":"rpc_request","requestId":"ls","machineId":"machine-1",
                   "method":"fs.list","params":{"cwd":"/repo","path":"."}}),
            );
            drain(agent_rx).iter().any(|m| m["requestId"] == "ls")
        };

    // No list: the whole team, as before.
    assert!(start(&mut hub, &mut agent_rx));
    assert!(list_dir(&mut hub, &mut agent_rx, &mut ui_rx));
    assert!(
        !hub.ui_can_view_session(UI_CONN, "machine-1", "session-1", Some("/repo")),
        "an unowned session stays hidden in a plain team share"
    );

    // A list the viewer is not on: nothing opens.
    set_list(&hub, &["mate"]);
    assert!(!start(&mut hub, &mut agent_rx), "new_session is refused");
    assert!(
        !list_dir(&mut hub, &mut agent_rx, &mut ui_rx),
        "so is fs.list"
    );
    assert!(!hub.ui_can_view_session(UI_CONN, "machine-1", "session-1", Some("/repo")));
    let shown = hub.snapshot_for(UI_CONN);
    assert!(
        shown["machines"]
            .as_array()
            .map(|m| m.iter().all(|m| m["machineId"] != "machine-1"))
            .unwrap_or(true),
        "the machine is not even listed for them"
    );

    // On the list: start, read files, and see the room's sessions.
    set_list(&hub, &["owner", "mate"]);
    assert!(start(&mut hub, &mut agent_rx));
    assert!(list_dir(&mut hub, &mut agent_rx, &mut ui_rx));
    assert!(
        hub.ui_can_view_session(UI_CONN, "machine-1", "session-1", Some("/repo")),
        "a listed share shows everyone's sessions, the device owner's included"
    );
    // Writing stays the owner's: only the single-folder mkdir is open.
    drain(&mut agent_rx);
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"rpc_request","requestId":"w","machineId":"machine-1",
               "method":"fs.write","params":{"cwd":"/repo","path":"a","content":"x"}}),
    );
    assert!(drain(&mut agent_rx).iter().all(|m| m["requestId"] != "w"));

    // Emptied, a restricted share stays shut; only lifting the restriction
    // gives it back to the whole team.
    set_list(&hub, &[]);
    assert!(!start(&mut hub, &mut agent_rx));
    hub.workspaces
        .conn
        .lock()
        .unwrap()
        .execute("UPDATE project_shares SET restricted=0", [])
        .unwrap();
    assert!(start(&mut hub, &mut agent_rx));
    assert!(!hub.ui_can_view_session(UI_CONN, "machine-1", "session-1", Some("/repo")));
}

/// The service API asks an agent for a folder through the hub: the request is
/// the device owner's `fs.mkdir`, only that machine may answer it, and an
/// offline machine is a plain «no answer».
#[test]
fn a_service_mkdir_reaches_the_agent_and_only_it_can_answer() {
    let (mut hub, _ui_rx, mut agent_rx) = test_hub(session(None));
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    hub.handle(HubCmd::ServiceMkdir {
        machine_id: "machine-1".into(),
        cwd: "/srv/legal/projects".into(),
        path: "_personal/42".into(),
        reply: tx,
    });
    let mut answer = rx.try_recv().unwrap().expect("the machine is online");
    let sent = drain(&mut agent_rx)
        .into_iter()
        .find(|m| m["type"] == "rpc_request")
        .expect("the agent is asked");
    assert_eq!(sent["method"], "fs.mkdir");
    assert_eq!(sent["params"]["cwd"], "/srv/legal/projects");
    assert_eq!(sent["params"]["path"], "_personal/42");
    assert_eq!(sent["params"]["recursive"], true);
    let id = sent["requestId"].as_str().unwrap().to_string();

    // Another machine's socket cannot answer for it.
    let _foreign = add_foreign_agent(&mut hub, 9);
    hub.on_agent_msg(9, json!({"type":"rpc_response","requestId":id,"ok":true}));
    assert!(answer.try_recv().is_err(), "still waiting");
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"rpc_response","requestId":id,"ok":true,"result":{"created":true}}),
    );
    assert_eq!(answer.try_recv().ok(), Some(true));

    // Offline: no receiver at all.
    hub.conns.remove(&AGENT_CONN);
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    hub.handle(HubCmd::ServiceMkdir {
        machine_id: "machine-1".into(),
        cwd: "/x".into(),
        path: "y".into(),
        reply: tx,
    });
    assert!(rx.try_recv().unwrap().is_none());
}

/// The viewer ("owner", a member) works in the team share `/repo`; nested in it
/// is a restricted `/repo/secret` that only the device owner ("mate") is on.
fn seat_with_a_secret_inside(hub: &mut Hub) {
    seat_as_team_member(hub);
    let ws = hub.workspaces.clone();
    let wid = hub.ui_access[&UI_CONN].workspace_id.clone();
    let secret = ws
        .share_project(
            "mate",
            &wid,
            "machine-1",
            "/repo/secret",
            "Secret",
            "control",
            "team",
        )
        .unwrap();
    let id = secret["projectShareId"].as_str().unwrap().to_string();
    let conn = ws.conn.lock().unwrap();
    conn.execute(
        "UPDATE project_shares SET restricted=1 WHERE project_share_id=?1",
        [&id],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO project_share_members VALUES(?1,'mate','lead',1)",
        [&id],
    )
    .unwrap();
}

/// Two sessions of the viewer's own: one in `/repo/app`, one under the secret.
fn add_open_and_secret_sessions(hub: &mut Hub) {
    let agent = hub.agents.get_mut("machine-1").unwrap();
    agent
        .sessions
        .push(json!({"sessionId":"s-open","title":"Open","cwd":"/repo/app","source":"claude"}));
    agent.sessions.push(
        json!({"sessionId":"s-secret","title":"Secret","cwd":"/repo/secret/a","source":"claude"}),
    );
    for sid in ["s-open", "s-secret"] {
        hub.session_meta.insert(
            format!("machine-1::{sid}"),
            SessionMeta {
                owner_user_id: "owner".into(),
                category: None,
                stage: None,
                origin: None,
            },
        );
    }
}

/// A broader share does not reopen a restricted share nested in it — not to
/// start in, not to read files from (not even through a relative `path`), not
/// to see, mirror or resume — and owning a session in there changes nothing.
#[test]
fn a_nested_restricted_share_is_closed_through_every_door() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    seat_with_a_secret_inside(&mut hub);
    add_open_and_secret_sessions(&mut hub);

    // Seeing.
    assert!(hub.ui_can_view_session(UI_CONN, "machine-1", "s-open", Some("/repo/app")));
    assert!(
        !hub.ui_can_view_session(UI_CONN, "machine-1", "s-secret", Some("/repo/app")),
        "the hub's own record of where it lives wins, and the owner bypass is gone"
    );
    let entry = json!({
        "machine": {"machineId": "machine-1"},
        "online": true,
        "sessions": hub.agents["machine-1"].sessions.clone(),
    });
    let scoped = hub
        .scoped_machine(UI_CONN, entry)
        .expect("the machine is visible");
    let listed: Vec<String> = scoped["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|s| s["sessionId"].as_str().map(str::to_string))
        .collect();
    assert!(listed.contains(&"s-open".to_string()));
    assert!(!listed.contains(&"s-secret".to_string()), "{listed:?}");

    // Starting.
    let start = |hub: &mut Hub, rx: &mut Receiver<String>, cwd: &str| -> bool {
        drain(rx);
        hub.new_session(
            UI_CONN,
            &json!({"machineId":"machine-1","cwd":cwd,"message":"x"}),
        );
        drain(rx).iter().any(|m| m["type"] == "new_session")
    };
    assert!(start(&mut hub, &mut agent_rx, "/repo/app"));
    for cwd in ["/repo/secret", "/repo/secret/x", "/repo/app/../secret/x"] {
        assert!(!start(&mut hub, &mut agent_rx, cwd), "{cwd}");
    }

    // Reading files: the cwd AND the path it reaches into.
    let mut forwarded = |hub: &mut Hub, params: Value| -> bool {
        drain(&mut agent_rx);
        drain(&mut ui_rx);
        hub.pending_rpc.clear();
        hub.on_ui_msg(
            UI_CONN,
            json!({"type":"rpc_request","requestId":"f","machineId":"machine-1",
                   "method":"fs.list","params":params}),
        );
        drain(&mut agent_rx).iter().any(|m| m["requestId"] == "f")
    };
    assert!(forwarded(&mut hub, json!({"cwd":"/repo","path":"app"})));
    assert!(forwarded(&mut hub, json!({"cwd":"/repo","path":"."})));
    assert!(!forwarded(
        &mut hub,
        json!({"cwd":"/repo/secret","path":"."})
    ));
    assert!(!forwarded(&mut hub, json!({"cwd":"/repo","path":"secret"})));
    assert!(!forwarded(
        &mut hub,
        json!({"cwd":"/repo","path":"app/../secret/x"})
    ));
    assert!(!forwarded(
        &mut hub,
        json!({"cwd":"/repo/app","path":"../secret"})
    ));

    // Mirroring and resuming.
    drain(&mut ui_rx);
    drain(&mut agent_rx);
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"mirror_open","machineId":"machine-1","sessionId":"s-secret","cwd":"/repo/secret/a"}),
    );
    assert!(drain(&mut agent_rx)
        .iter()
        .all(|m| m["type"] != "mirror_open"));
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"open","machineId":"machine-1","sessionId":"s-secret"}),
    );
    assert!(drain(&mut agent_rx).iter().all(|m| m["type"] != "resume"));
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"open","machineId":"machine-1","sessionId":"s-open"}),
    );
    assert!(drain(&mut agent_rx).iter().any(|m| m["type"] == "resume"));

    // The board draws the same line.
    let scope = hub.workspaces.board_scope("owner", false).unwrap();
    assert_eq!(
        scope.denied_roots,
        vec![("machine-1".to_string(), "/repo/secret".to_string())]
    );
}

/// Owning an established session no longer lets you subscribe to it, stage it,
/// close it or rename it once the share it sits in is shut to you; a brand-new
/// run without an id keeps the bypass — outside restricted roots.
#[test]
fn owning_a_session_does_not_outlive_the_share_acl() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    seat_with_a_secret_inside(&mut hub);
    add_open_and_secret_sessions(&mut hub);
    let run = |sid: &str, cwd: &str| {
        let mut r = test_run(&[]);
        r.session_id = sid.into();
        r.cwd = Some(cwd.into());
        r.owner_user_id = Some("owner".into());
        r
    };
    hub.runs.insert("r-open".into(), run("s-open", "/repo/app"));
    hub.runs
        .insert("r-secret".into(), run("s-secret", "/repo/secret/a"));
    hub.runs.insert("r-new".into(), run("", "/repo/app"));
    hub.runs
        .insert("r-new-secret".into(), run("", "/repo/secret/b"));
    drain(&mut ui_rx);
    for id in ["r-open", "r-secret", "r-new", "r-new-secret"] {
        hub.on_ui_msg(UI_CONN, json!({"type":"subscribe","runId":id}));
    }
    let attached = |hub: &Hub, id: &str| hub.runs[id].browsers.contains(&UI_CONN);
    assert!(attached(&hub, "r-open"));
    assert!(
        !attached(&hub, "r-secret"),
        "established session under a denied root"
    );
    assert!(attached(&hub, "r-new"), "a brand-new run keeps the bypass");
    assert!(
        !attached(&hub, "r-new-secret"),
        "but not inside a denied root"
    );
    let visible: Vec<Value> = hub
        .active_runs_json_for(UI_CONN)
        .as_array()
        .cloned()
        .unwrap();
    assert_eq!(visible.len(), 2, "{visible:?}");

    drain(&mut agent_rx);
    drain(&mut ui_rx);
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"set_stage","machineId":"machine-1","sessionId":"s-secret","stage":"done"}),
    );
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"close","machineId":"machine-1","sessionId":"s-secret"}),
    );
    let denied: Vec<Value> = drain(&mut ui_rx)
        .into_iter()
        .filter(|m| m["type"] == "error")
        .collect();
    assert_eq!(denied.len(), 2, "stage and close are refused: {denied:?}");
    assert!(drain(&mut agent_rx).iter().all(|m| m["type"] != "close"));
    for (id, ok) in [("rn1", false), ("rn2", true)] {
        let (sid, cwd) = if ok {
            ("s-open", "/repo/app")
        } else {
            ("s-secret", "/repo/secret/a")
        };
        hub.on_ui_msg(
            UI_CONN,
            json!({"type":"rpc_request","requestId":id,"machineId":"machine-1",
                   "method":"session.rename","params":{"sessionId":sid,"cwd":cwd,"title":"t"}}),
        );
        let sent = drain(&mut agent_rx).iter().any(|m| m["requestId"] == id);
        assert_eq!(sent, ok, "{id}");
    }
}

/// Taking someone off a list (or any ACL change) reaches the sockets that
/// already hold the session open: the stream detaches and the mirror closes.
#[test]
fn revoking_access_closes_what_a_live_connection_already_holds() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    seat_as_team_member(&mut hub);
    let share_id: String = hub
        .workspaces
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT project_share_id FROM project_shares WHERE root='/repo'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let list = |hub: &Hub, who: &str| {
        let conn = hub.workspaces.conn.lock().unwrap();
        conn.execute(
            "UPDATE project_shares SET restricted=1 WHERE project_share_id=?1",
            [&share_id],
        )
        .unwrap();
        conn.execute(
            "DELETE FROM project_share_members WHERE project_share_id=?1",
            [&share_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_share_members VALUES(?1,?2,'member',1)",
            [&share_id, &who.to_string()],
        )
        .unwrap();
    };
    list(&hub, "owner");
    // The person is on the list and has both a stream and a mirror open.
    let mut run = test_run(&[UI_CONN]);
    run.cwd = Some("/repo".into());
    hub.runs.insert("run-1".into(), run);
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"mirror_open","mirrorId":"m1","machineId":"machine-1","sessionId":"session-1","cwd":"/repo"}),
    );
    assert!(hub.mirrors.contains_key("m1"));
    drain(&mut ui_rx);
    drain(&mut agent_rx);
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"mirror_data","mirrorId":"m1","messages":[]}),
    );
    assert!(
        drain(&mut ui_rx).iter().any(|m| m["type"] == "mirror_data"),
        "flows while listed"
    );

    // A refresh with nothing changed keeps both.
    hub.handle(HubCmd::RefreshWorkspaceState);
    assert!(hub.mirrors.contains_key("m1") && hub.runs["run-1"].browsers.contains(&UI_CONN));

    // Taken off the list.
    list(&hub, "mate");
    hub.handle(HubCmd::RefreshWorkspaceState);
    assert!(
        hub.runs["run-1"].browsers.is_empty(),
        "the stream is detached"
    );
    assert!(
        hub.mirrors.is_empty() && hub.mirror_sessions.is_empty(),
        "the mirror is closed"
    );
    assert!(drain(&mut agent_rx)
        .iter()
        .any(|m| m["type"] == "mirror_close"));
    assert!(drain(&mut ui_rx).iter().any(|m| m["type"] == "mirror_exit"));
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"mirror_data","mirrorId":"m1","messages":[]}),
    );
    assert!(drain(&mut ui_rx).iter().all(|m| m["type"] != "mirror_data"));
}

/// A workspace owner who is also listed on a matter (the firm's owner is a
/// partner in every matter) starts there — and is pinned off the device
/// owner's Claude login.
#[test]
fn a_listed_workspace_owner_starts_in_the_matter_on_codex() {
    let (mut hub, _ui_rx, mut agent_rx) = test_hub(session(None));
    seat_as_team_member(&mut hub);
    let ws = hub.workspaces.clone();
    let wid = hub.ui_access[&UI_CONN].workspace_id.clone();
    // The viewer becomes the workspace owner; the device is still mate's.
    ws.with_conn_for_tests(|c| {
        c.execute(
            "UPDATE memberships SET role='owner' WHERE workspace_id=?1 AND user_id='owner'",
            [&wid],
        )
        .unwrap();
    });
    hub.ui_access
        .insert(UI_CONN, ws.ui_access("owner", Some(&wid), false).unwrap());
    let start = |hub: &mut Hub, rx: &mut Receiver<String>| -> Option<Value> {
        drain(rx);
        hub.new_session(
            UI_CONN,
            &json!({"machineId":"machine-1","cwd":"/repo/x","message":"x","source":"claude"}),
        );
        drain(rx).into_iter().find(|m| m["type"] == "new_session")
    };
    // Not listed on a restricted /repo yet: an unrestricted share lets an owner
    // see but not start, as it always did.
    assert!(start(&mut hub, &mut agent_rx).is_none());
    let share_id: String = ws
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT project_share_id FROM project_shares WHERE root='/repo'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    ws.with_conn_for_tests(|c| {
        c.execute(
            "UPDATE project_shares SET restricted=1 WHERE project_share_id=?1",
            [&share_id],
        )
        .unwrap();
        c.execute(
            "INSERT INTO project_share_members VALUES(?1,'owner','partner',1)",
            [&share_id],
        )
        .unwrap();
    });
    let started = start(&mut hub, &mut agent_rx).expect("listed: may start");
    assert_eq!(started["source"], "codex");
}

/// `path` is judged where the AGENT puts it: an absolute path stands on its own
/// and is not "inside cwd" just because cwd is. fs.read / fs.list / fs.download / fs.peek
/// alike, POSIX and Windows spellings.
#[test]
fn an_absolute_path_cannot_reach_a_closed_root_from_an_open_cwd() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    seat_with_a_secret_inside(&mut hub);
    let mut forwarded = |hub: &mut Hub, method: &str, cwd: &str, path: &str| -> bool {
        drain(&mut agent_rx);
        drain(&mut ui_rx);
        hub.pending_rpc.clear();
        hub.on_ui_msg(
            UI_CONN,
            json!({"type":"rpc_request","requestId":"f","machineId":"machine-1",
                   "method":method,"params":{"cwd":cwd,"path":path}}),
        );
        drain(&mut agent_rx).iter().any(|m| m["requestId"] == "f")
    };
    for method in ["fs.read", "fs.list", "fs.download", "fs.peek"] {
        assert!(
            forwarded(&mut hub, method, "/repo", "app/x.txt"),
            "{method}"
        );
        assert!(
            forwarded(&mut hub, method, "/repo", "/repo/app/x.txt"),
            "{method}: an absolute path inside"
        );
        for closed in [
            "/repo/secret/x",
            "/repo/secret",
            "/repo/app/../secret/x",
            "/etc/passwd",
            r"\repo\secret\x",
            "C:/repo/secret/x",
        ] {
            assert!(
                !forwarded(&mut hub, method, "/repo", closed),
                "{method} {closed}"
            );
        }
    }
}

/// A working folder ABOVE a closed root can read it from disk, so it is no
/// place to start or to resume a session; browsing the folder stays possible.
#[test]
fn a_folder_that_contains_a_closed_root_cannot_host_a_session() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    seat_with_a_secret_inside(&mut hub);
    // A session whose folder is /repo itself, and one deeper in the open part.
    hub.agents
        .get_mut("machine-1")
        .unwrap()
        .sessions
        .push(json!({"sessionId":"s-top","title":"Top","cwd":"/repo","source":"claude"}));
    hub.session_meta.insert(
        "machine-1::s-top".into(),
        SessionMeta {
            owner_user_id: "owner".into(),
            category: None,
            stage: None,
            origin: None,
        },
    );
    drain(&mut agent_rx);
    hub.new_session(
        UI_CONN,
        &json!({"machineId":"machine-1","cwd":"/repo","message":"x"}),
    );
    assert!(drain(&mut agent_rx)
        .iter()
        .all(|m| m["type"] != "new_session"));
    assert!(!hub.ui_can_view_session(UI_CONN, "machine-1", "s-top", Some("/repo")));
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"open","machineId":"machine-1","sessionId":"s-top"}),
    );
    assert!(drain(&mut agent_rx).iter().all(|m| m["type"] != "resume"));
    // Driving a live run there is refused as well.
    let mut run = test_run(&[]);
    run.session_id = "s-top".into();
    run.cwd = Some("/repo".into());
    run.owner_user_id = Some("owner".into());
    hub.runs.insert("r-top".into(), run);
    assert!(!hub.ui_can_drive_run(UI_CONN, &hub.runs["r-top"]));
    // Browsing /repo is still allowed.
    drain(&mut agent_rx);
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"rpc_request","requestId":"ls","machineId":"machine-1",
               "method":"fs.list","params":{"cwd":"/repo","path":"."}}),
    );
    assert!(drain(&mut agent_rx).iter().any(|m| m["requestId"] == "ls"));
    drain(&mut ui_rx);
}

/// The brand-new-run bypass is not a lease: when the share the run was
/// started under is withdrawn, the next refresh detaches its owner too.
#[test]
fn an_id_less_run_is_detached_when_its_share_is_withdrawn() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    seat_as_team_member(&mut hub);
    let mut run = test_run(&[UI_CONN]);
    run.session_id = String::new();
    run.cwd = Some("/repo/app".into());
    run.owner_user_id = Some("owner".into());
    hub.runs.insert("r-new".into(), run);
    // Also one in a folder no share covers: never visible to begin with.
    let mut stray = test_run(&[UI_CONN]);
    stray.session_id = String::new();
    stray.cwd = Some("/elsewhere".into());
    stray.owner_user_id = Some("owner".into());
    hub.runs.insert("r-stray".into(), stray);

    hub.handle(HubCmd::RefreshWorkspaceState);
    assert!(
        hub.runs["r-new"].browsers.contains(&UI_CONN),
        "still under the share"
    );
    assert!(
        hub.runs["r-stray"].browsers.is_empty(),
        "outside every root: fail closed"
    );

    let wid = hub.ui_access[&UI_CONN].workspace_id.clone();
    let share_id: String = hub
        .workspaces
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT project_share_id FROM project_shares WHERE root='/repo'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    hub.workspaces
        .remove_project("mate", &wid, &share_id)
        .unwrap();
    drain(&mut ui_rx);
    hub.handle(HubCmd::RefreshWorkspaceState);
    assert!(
        hub.runs["r-new"].browsers.is_empty(),
        "the share is gone: detached"
    );
    assert!(
        drain(&mut ui_rx)
            .iter()
            .any(|m| m["code"] == "access_revoked"),
        "and told why"
    );
}

/// A push says what a run is doing: the person who started it, but is now shut
/// out of its share, is not told.
#[test]
fn nobody_is_pushed_about_a_run_in_a_share_they_are_shut_out_of() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    let (notify_tx, mut notify_rx) = unbounded_channel();
    hub.notify = Some(notify_tx);
    seat_with_a_secret_inside(&mut hub);
    hub.push_devices
        .insert("phone".into(), (now_ms(), "owner".into()));
    let run = |cwd: &str| {
        let mut r = test_run(&[]);
        r.cwd = Some(cwd.into());
        r.owner_user_id = Some("owner".into());
        r
    };
    hub.runs.insert("open".into(), run("/repo/app"));
    hub.runs.insert("closed".into(), run("/repo/secret/a"));
    hub.runs.insert("above".into(), run("/repo"));
    hub.emit_push("open", "needs_attention");
    assert_eq!(
        pushed(&mut notify_rx).device_tokens,
        vec!["phone".to_string()]
    );
    hub.emit_push("closed", "needs_attention");
    hub.emit_push("above", "needs_attention");
    assert!(notify_rx.try_recv().is_err(), "nothing for either");
}

/// A workspace owner sees every share of the team but works only where they
/// are listed: resuming, typing into a live run, renaming and closing a
/// session in a restricted share they are NOT on are refused, while the same
/// in the one they ARE on works.
#[test]
fn an_owner_listed_on_one_restricted_share_cannot_work_in_another() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    seat_as_team_member(&mut hub);
    let ws = hub.workspaces.clone();
    let wid = hub.ui_access[&UI_CONN].workspace_id.clone();
    ws.with_conn_for_tests(|c| {
        c.execute(
            "UPDATE memberships SET role='owner' WHERE workspace_id=?1 AND user_id='owner'",
            [&wid],
        )
        .unwrap();
    });
    hub.ui_access
        .insert(UI_CONN, ws.ui_access("owner", Some(&wid), false).unwrap());
    for (root, who) in [("/a", "owner"), ("/b", "mate")] {
        let share = ws
            .share_project("mate", &wid, "machine-1", root, root, "control", "team")
            .unwrap();
        let id = share["projectShareId"].as_str().unwrap().to_string();
        ws.with_conn_for_tests(|c| {
            c.execute(
                "UPDATE project_shares SET restricted=1 WHERE project_share_id=?1",
                [&id],
            )
            .unwrap();
            c.execute(
                "INSERT INTO project_share_members VALUES(?1,?2,'member',1)",
                [&id, &who.to_string()],
            )
            .unwrap();
        });
    }
    let agent = hub.agents.get_mut("machine-1").unwrap();
    agent
        .sessions
        .push(json!({"sessionId":"s-a","title":"A","cwd":"/a/x","source":"claude"}));
    agent
        .sessions
        .push(json!({"sessionId":"s-b","title":"B","cwd":"/b/x","source":"claude"}));

    // Seeing: both (an owner sees the whole team's shares).
    assert!(hub.ui_can_view_session(UI_CONN, "machine-1", "s-a", None));
    assert!(hub.ui_can_view_session(UI_CONN, "machine-1", "s-b", None));
    // Working: only where listed.
    assert!(hub.ui_can_work_in(UI_CONN, "machine-1", "s-a", None));
    assert!(!hub.ui_can_work_in(UI_CONN, "machine-1", "s-b", None));

    drain(&mut agent_rx);
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"open","machineId":"machine-1","sessionId":"s-b"}),
    );
    assert!(
        drain(&mut agent_rx).iter().all(|m| m["type"] != "resume"),
        "no resume in B"
    );
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"open","machineId":"machine-1","sessionId":"s-a"}),
    );
    assert!(
        drain(&mut agent_rx).iter().any(|m| m["type"] == "resume"),
        "resume in A"
    );

    // A live run in each: only A's can be driven.
    let run = |sid: &str, cwd: &str| {
        let mut r = test_run(&[]);
        r.session_id = sid.into();
        r.cwd = Some(cwd.into());
        r
    };
    hub.runs.insert("r-a".into(), run("s-a", "/a/x"));
    hub.runs.insert("r-b".into(), run("s-b", "/b/x"));
    assert!(hub.ui_can_drive_run(UI_CONN, &hub.runs["r-a"]));
    assert!(!hub.ui_can_drive_run(UI_CONN, &hub.runs["r-b"]));
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"set_model","runId":"r-b","model":"opus"}),
    );
    assert!(drain(&mut agent_rx)
        .iter()
        .all(|m| m["type"] != "set_model"));

    // Renaming, stopping a helper, deleting.
    for (id, method, sid, cwd, ok) in [
        ("n1", "session.rename", "s-a", "/a/x", true),
        ("n2", "session.rename", "s-b", "/b/x", false),
        ("n3", "run.stopSubagent", "s-b", "/b/x", false),
        // The agent prefers a session over a folder: naming B's session with
        // A's folder does not make it A's.
        ("n4", "commands.list", "s-b", "/a/x", false),
        ("n5", "commands.list", "s-a", "/a/x", true),
    ] {
        hub.pending_rpc.clear();
        drain(&mut agent_rx);
        hub.on_ui_msg(
            UI_CONN,
            json!({"type":"rpc_request","requestId":id,"machineId":"machine-1","method":method,
                   "params":{"sessionId":sid,"cwd":cwd,"title":"t"}}),
        );
        let sent = drain(&mut agent_rx).iter().any(|m| m["requestId"] == id);
        assert_eq!(sent, ok, "{id}");
    }
    drain(&mut ui_rx);
}

/// A session the hub cannot place is not worked in on the strength of a folder
/// the CALLER names: an owner listed on `/a` claiming `cwd=/a` for a session
/// that lives elsewhere gets nothing.
#[test]
fn a_claimed_cwd_does_not_authorize_work_on_a_session_the_hub_cannot_place() {
    let (mut hub, _ui_rx, mut agent_rx) = test_hub(session(None));
    seat_as_team_member(&mut hub);
    let ws = hub.workspaces.clone();
    let wid = hub.ui_access[&UI_CONN].workspace_id.clone();
    ws.with_conn_for_tests(|c| {
        c.execute(
            "UPDATE memberships SET role='owner' WHERE workspace_id=?1 AND user_id='owner'",
            [&wid],
        )
        .unwrap();
    });
    hub.ui_access
        .insert(UI_CONN, ws.ui_access("owner", Some(&wid), false).unwrap());
    let share = ws
        .share_project("mate", &wid, "machine-1", "/a", "A", "control", "team")
        .unwrap();
    let id = share["projectShareId"].as_str().unwrap().to_string();
    ws.with_conn_for_tests(|c| {
        c.execute(
            "UPDATE project_shares SET restricted=1 WHERE project_share_id=?1",
            [&id],
        )
        .unwrap();
        c.execute(
            "INSERT INTO project_share_members VALUES(?1,'owner','member',1)",
            [&id],
        )
        .unwrap();
    });
    assert!(!hub.ui_can_work_in(UI_CONN, "machine-1", "ghost", None));
    drain(&mut agent_rx);
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"rpc_request","requestId":"g","machineId":"machine-1","method":"session.rename",
               "params":{"sessionId":"ghost","cwd":"/a/x","title":"t"}}),
    );
    assert!(drain(&mut agent_rx).iter().all(|m| m["requestId"] != "g"));
}

/// An answer that has already changed something is reported as it happened,
/// even if the asker has since lost access: a refusal would invite a retry.
#[test]
fn a_completed_mutation_is_reported_even_after_a_revocation() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    seat_as_team_member(&mut hub);
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"rpc_request","requestId":"mk","machineId":"machine-1","method":"fs.mkdir",
               "params":{"cwd":"/repo","path":"new"}}),
    );
    assert!(drain(&mut agent_rx).iter().any(|m| m["requestId"] == "mk"));
    let share_id: String = hub
        .workspaces
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT project_share_id FROM project_shares WHERE root='/repo'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    {
        let conn = hub.workspaces.conn.lock().unwrap();
        conn.execute(
            "UPDATE project_shares SET restricted=1 WHERE project_share_id=?1",
            [&share_id],
        )
        .unwrap();
    }
    hub.handle(HubCmd::RefreshWorkspaceState);
    drain(&mut ui_rx);
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"rpc_response","requestId":"mk","ok":true,"result":{"path":"new","created":true}}),
    );
    let got = drain(&mut ui_rx);
    let m = got
        .iter()
        .find(|m| m["requestId"] == "mk")
        .expect("answered");
    assert_eq!(m["ok"], true);
}

/// What an agent answers after the asker lost their rights is not forwarded.
#[test]
fn an_rpc_answer_that_arrives_after_a_revocation_is_not_forwarded() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    seat_as_team_member(&mut hub);
    let share_id: String = hub
        .workspaces
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT project_share_id FROM project_shares WHERE root='/repo'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let list = |hub: &Hub, who: &str| {
        let conn = hub.workspaces.conn.lock().unwrap();
        conn.execute(
            "UPDATE project_shares SET restricted=1 WHERE project_share_id=?1",
            [&share_id],
        )
        .unwrap();
        conn.execute(
            "DELETE FROM project_share_members WHERE project_share_id=?1",
            [&share_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_share_members VALUES(?1,?2,'member',1)",
            [&share_id, &who.to_string()],
        )
        .unwrap();
    };
    list(&hub, "owner");
    let ask = |hub: &mut Hub, id: &str, method: &str, params: Value| {
        hub.on_ui_msg(
            UI_CONN,
            json!({"type":"rpc_request","requestId":id,"machineId":"machine-1","method":method,"params":params}),
        );
    };
    ask(
        &mut hub,
        "file",
        "fs.read",
        json!({"cwd":"/repo","path":"a.txt"}),
    );
    ask(
        &mut hub,
        "hist",
        "session.messages",
        json!({"sessionId":"session-1","cwd":"/repo"}),
    );
    ask(
        &mut hub,
        "ok",
        "fs.read",
        json!({"cwd":"/repo","path":"b.txt"}),
    );
    let forwarded: Vec<Value> = drain(&mut agent_rx)
        .into_iter()
        .filter(|m| m["type"] == "rpc_request")
        .collect();
    assert_eq!(
        forwarded.len(),
        3,
        "all three went to the agent while listed"
    );

    // Same answer, one before and ... first the one that arrives in time.
    drain(&mut ui_rx);
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"rpc_response","requestId":"ok","ok":true,"result":{"content":"fine"}}),
    );
    assert!(drain(&mut ui_rx)
        .iter()
        .any(|m| m["requestId"] == "ok" && m["ok"] == true));

    // Taken off the list while the others are in flight.
    list(&hub, "mate");
    hub.handle(HubCmd::RefreshWorkspaceState);
    drain(&mut ui_rx);
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"rpc_response","requestId":"file","ok":true,"result":{"content":"secret"}}),
    );
    hub.on_agent_msg(AGENT_CONN, json!({"type":"rpc_response","requestId":"hist","ok":true,"result":{"messages":[{"text":"secret"}]}}));
    let got = drain(&mut ui_rx);
    for id in ["file", "hist"] {
        let m = got.iter().find(|m| m["requestId"] == id).expect("answered");
        assert_eq!(m["ok"], false, "{id}");
        assert!(m.get("result").is_none(), "{id}: no payload");
    }
    assert!(hub.pending_rpc.is_empty());
}

/// A request id still in flight cannot be reused — not even by the connection
/// that owns it, which could otherwise swap the rights its answer is judged by —
/// and a folder's command list is held back like any other payload.
#[test]
fn an_in_flight_request_id_is_not_reused_and_command_lists_are_rechecked() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    seat_as_team_member(&mut hub);
    let share_id: String = hub
        .workspaces
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT project_share_id FROM project_shares WHERE root='/repo'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let set = |hub: &Hub, who: &str| {
        let conn = hub.workspaces.conn.lock().unwrap();
        conn.execute(
            "UPDATE project_shares SET restricted=1 WHERE project_share_id=?1",
            [&share_id],
        )
        .unwrap();
        conn.execute(
            "DELETE FROM project_share_members WHERE project_share_id=?1",
            [&share_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO project_share_members VALUES(?1,?2,'member',1)",
            [&share_id, &who.to_string()],
        )
        .unwrap();
    };
    set(&hub, "owner");
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"rpc_request","requestId":"x","machineId":"machine-1","method":"fs.read",
               "params":{"cwd":"/repo","path":"a.txt"}}),
    );
    drain(&mut ui_rx);
    // Same id, same connection, a different request: dropped without a word
    // (an answer under that id would settle the ORIGINAL early), the first intact.
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"rpc_request","requestId":"x","machineId":"machine-1","method":"fs.read",
               "params":{"cwd":"/repo","path":"b.txt"}}),
    );
    assert!(drain(&mut ui_rx).iter().all(|m| m["requestId"] != "x"));
    assert_eq!(hub.pending_rpc["x"].touched.as_deref(), Some("/repo/a.txt"));
    // Another connection reusing it is told, and the first is still intact.
    let mut other_rx = add_colleague(&mut hub, 5);
    hub.on_ui_msg(
        5,
        json!({"type":"rpc_request","requestId":"x","machineId":"machine-1","method":"fs.read",
               "params":{"cwd":"/repo","path":"c.txt"}}),
    );
    assert!(drain(&mut other_rx)
        .iter()
        .any(|m| m["requestId"] == "x" && m["ok"] == false));
    assert_eq!(hub.pending_rpc["x"].conn, UI_CONN);

    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"rpc_request","requestId":"cmds","machineId":"machine-1","method":"commands.list",
               "params":{"cwd":"/repo"}}),
    );
    assert!(drain(&mut agent_rx)
        .iter()
        .any(|m| m["requestId"] == "cmds"));
    set(&hub, "mate");
    hub.handle(HubCmd::RefreshWorkspaceState);
    drain(&mut ui_rx);
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"rpc_response","requestId":"cmds","ok":true,"result":{"commands":[{"name":"secret-skill"}]}}),
    );
    let got = drain(&mut ui_rx);
    let m = got
        .iter()
        .find(|m| m["requestId"] == "cmds")
        .expect("answered");
    assert_eq!(m["ok"], false);
    assert!(m.get("result").is_none());
}

/// Nothing is delivered to a person suspended while their request was in
/// flight — acknowledgements included — and a transcript the hub has since let
/// go of (sync policy, retention) is not delivered even to the machine's
/// controller.
#[test]
fn late_answers_go_to_nobody_suspended_and_nothing_the_hub_let_go_of() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    let pend = |hub: &mut Hub, id: &str, method: &str, placed: bool| {
        hub.pending_rpc.insert(
            id.into(),
            PendingRpc {
                conn: UI_CONN,
                machine_id: "machine-1".into(),
                method: method.into(),
                session_id: "gone".into(),
                placed,
                ..Default::default()
            },
        );
    };
    let answer = |hub: &mut Hub, rx: &mut Receiver<String>, id: &str| -> Value {
        hub.on_agent_msg(
            AGENT_CONN,
            json!({"type":"rpc_response","requestId":id,"ok":true,"result":{"x":1}}),
        );
        drain(rx)
            .into_iter()
            .find(|m| m["requestId"] == id)
            .expect("answered")
    };
    // The controller gets a live answer; a placed session that vanished is held back.
    pend(&mut hub, "p1", "projects.list", false);
    assert_eq!(answer(&mut hub, &mut ui_rx, "p1")["ok"], true);
    pend(&mut hub, "t1", "session.messages", true);
    let m = answer(&mut hub, &mut ui_rx, "t1");
    assert_eq!(m["ok"], false, "the hub no longer holds that session");
    // Suspended while it was in flight: not even a plain acknowledgement.
    pend(&mut hub, "p2", "projects.list", false);
    // (Committed in the database; the hub's cached copy has not been refreshed.)
    hub.workspaces
        .suspend_access("owner", "admin", None)
        .unwrap();
    let m = answer(&mut hub, &mut ui_rx, "p2");
    assert_eq!(m["ok"], false);
    assert!(m.get("result").is_none());
}

/// A removal that has committed but whose hub refresh is still queued already
/// decides the answer: the late file read is judged by the database, not by the
/// rights the socket cached when it opened.
#[test]
fn a_late_answer_is_judged_by_committed_rights_not_the_cache() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    seat_as_team_member(&mut hub);
    let wid = hub.ui_access[&UI_CONN].workspace_id.clone();
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"rpc_request","requestId":"late","machineId":"machine-1","method":"fs.read",
               "params":{"cwd":"/repo","path":"a.txt"}}),
    );
    assert!(drain(&mut agent_rx)
        .iter()
        .any(|m| m["requestId"] == "late"));
    // mate (the team's owner) removes the person; no RefreshWorkspaceState yet.
    hub.workspaces.remove_member("mate", &wid, "owner").unwrap();
    drain(&mut ui_rx);
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"rpc_response","requestId":"late","ok":true,"result":{"content":"x"}}),
    );
    let got = drain(&mut ui_rx);
    let m = got
        .iter()
        .find(|m| m["requestId"] == "late")
        .expect("answered");
    assert_eq!(m["ok"], false);
    assert!(m.get("result").is_none());
}

/// What only a controller of the machine may ask (project and process lists,
/// git, sync, runtime…) is not delivered once they no longer control it, while
/// what a share's member may call and that already happened is reported.
#[test]
fn a_controller_only_answer_needs_control_at_delivery() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    let pend = |hub: &mut Hub, id: &str, method: &str| {
        hub.pending_rpc.insert(
            id.into(),
            PendingRpc {
                conn: UI_CONN,
                machine_id: "machine-1".into(),
                method: method.into(),
                ..Default::default()
            },
        );
    };
    let answer = |hub: &mut Hub, rx: &mut Receiver<String>, id: &str| -> Value {
        hub.on_agent_msg(
            AGENT_CONN,
            json!({"type":"rpc_response","requestId":id,"ok":true,"result":{"x":1}}),
        );
        drain(rx)
            .into_iter()
            .find(|m| m["requestId"] == id)
            .expect("answered")
    };
    pend(&mut hub, "a", "git.status");
    assert_eq!(
        answer(&mut hub, &mut ui_rx, "a")["ok"],
        true,
        "a controller gets it"
    );
    // The same person after the machine stopped being theirs: it is shared
    // with them in a team now, as a member.
    seat_as_team_member(&mut hub);
    pend(&mut hub, "b", "git.status");
    pend(&mut hub, "c", "projects.list");
    pend(&mut hub, "d", "fs.mkdir");
    pend(&mut hub, "e", "models.list");
    assert_eq!(
        answer(&mut hub, &mut ui_rx, "e")["ok"],
        true,
        "a member who can still start may list models"
    );
    // Taken off the share: nothing left to start, so no model list either.
    hub.workspaces
        .conn
        .lock()
        .unwrap()
        .execute("DELETE FROM project_shares", [])
        .unwrap();
    pend(&mut hub, "f", "models.list");
    assert_eq!(answer(&mut hub, &mut ui_rx, "f")["ok"], false);
    assert_eq!(answer(&mut hub, &mut ui_rx, "b")["ok"], false);
    assert_eq!(answer(&mut hub, &mut ui_rx, "c")["ok"], false);
    assert_eq!(
        answer(&mut hub, &mut ui_rx, "d")["ok"],
        true,
        "a mutation a member may make is reported as it happened"
    );
}

/// An id that is in flight is refused for EVERY kind of request — also those
/// the hub would answer itself — and the original entry is left as it was.
#[test]
fn an_in_flight_id_is_refused_before_anything_answers_under_it() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    store_session(&mut hub, false);
    hub.pending_rpc.insert(
        "x".into(),
        PendingRpc {
            conn: UI_CONN,
            machine_id: "machine-1".into(),
            method: "fs.read".into(),
            touched: Some("/repo/a".into()),
            ..Default::default()
        },
    );
    drain(&mut ui_rx);
    rpc(&mut hub, "x", "session.messages");
    assert!(
        drain(&mut ui_rx).iter().all(|m| m["requestId"] != "x"),
        "nothing answers under an id that is in flight"
    );
    assert_eq!(hub.pending_rpc["x"].method, "fs.read");
}

/// A transcript read that was in flight when the session was deleted is not
/// delivered — not even to the machine's own controller.
#[test]
fn a_transcript_in_flight_when_its_session_is_deleted_is_not_delivered() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    store_session(&mut hub, false);
    drain(&mut agent_rx);
    // The read is in flight to the agent (a replica that is not current sends
    // it there; the entry is what such a send leaves behind).
    hub.pending_rpc.insert(
        "t".into(),
        PendingRpc {
            conn: UI_CONN,
            machine_id: "machine-1".into(),
            method: "session.messages".into(),
            session_id: "session-1".into(),
            cwd: Some("/repo".into()),
            ..Default::default()
        },
    );
    // The person asks for it to be deleted: while the agent is still at it (the
    // hub is waiting on that call) nothing of the transcript goes out.
    hub.pending_rpc.insert(
        "del".into(),
        PendingRpc {
            conn: UI_CONN,
            machine_id: "machine-1".into(),
            method: "session.delete".into(),
            session_id: "session-1".into(),
            deleting: Some("session-1".into()),
            ..Default::default()
        },
    );
    drain(&mut ui_rx);
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"rpc_response","requestId":"t","ok":true,"result":{"messages":[{"text":"private"}]}}),
    );
    let got = drain(&mut ui_rx);
    let m = got
        .iter()
        .find(|m| m["requestId"] == "t")
        .expect("answered");
    assert_eq!(m["ok"], false);
    assert!(m.get("result").is_none());
}

/// The moment the agent confirms a deletion it is final: a transcript read
/// answered right after the delete reply, or asked for right after, finds
/// nothing — no waiting for the next inventory to notice the file is gone.
#[test]
fn a_confirmed_deletion_is_final_before_the_next_inventory() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    store_session(&mut hub, false);
    drain(&mut agent_rx);
    hub.pending_rpc.insert(
        "t".into(),
        PendingRpc {
            conn: UI_CONN,
            machine_id: "machine-1".into(),
            method: "session.messages".into(),
            session_id: "session-1".into(),
            cwd: Some("/repo".into()),
            ..Default::default()
        },
    );
    hub.store
        .mark_user_deleted("machine-1", "session-1")
        .unwrap();
    hub.pending_rpc.insert(
        "del".into(),
        PendingRpc {
            conn: UI_CONN,
            machine_id: "machine-1".into(),
            method: "session.delete".into(),
            session_id: "session-1".into(),
            deleting: Some("session-1".into()),
            ..Default::default()
        },
    );
    // The delete reply arrives FIRST, then the transcript read's.
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"rpc_response","requestId":"del","ok":true,"result":{"ok":true}}),
    );
    drain(&mut ui_rx);
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"rpc_response","requestId":"t","ok":true,"result":{"messages":[{"text":"private"}]}}),
    );
    let got = drain(&mut ui_rx);
    let m = got
        .iter()
        .find(|m| m["requestId"] == "t")
        .expect("answered");
    assert_eq!(m["ok"], false);
    assert!(m.get("result").is_none());
    // And a read asked for afterwards is refused at the door.
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"rpc_request","requestId":"again","machineId":"machine-1","method":"session.messages",
               "params":{"sessionId":"session-1","cwd":"/repo"}}),
    );
    let got = drain(&mut ui_rx);
    assert!(got
        .iter()
        .any(|m| m["requestId"] == "again" && m["ok"] == false));
}

/// A mirror's bookkeeping goes with the mirror, however it ends.
#[test]
fn mirror_sessions_follow_mirrors_out() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    let open = |hub: &mut Hub, id: &str| {
        hub.on_ui_msg(
            UI_CONN,
            json!({"type":"mirror_open","mirrorId":id,"machineId":"machine-1","sessionId":"session-1","cwd":"/repo"}),
        );
    };
    open(&mut hub, "m1");
    open(&mut hub, "m2");
    open(&mut hub, "m3");
    assert_eq!(hub.mirror_sessions.len(), 3);
    hub.on_ui_msg(UI_CONN, json!({"type":"mirror_close","mirrorId":"m1"}));
    assert!(!hub.mirror_sessions.contains_key("m1") && !hub.mirrors.contains_key("m1"));
    // The machine going away takes its mirrors...
    hub.drop_machine_streams("machine-1");
    assert!(hub.mirrors.is_empty() && hub.mirror_sessions.is_empty());
    // ...and so does the browser leaving.
    open(&mut hub, "m4");
    assert_eq!(hub.mirror_sessions.len(), 1);
    hub.on_disconnect(UI_CONN);
    assert!(hub.mirrors.is_empty() && hub.mirror_sessions.is_empty());
}

// ------------------------------------------------- service UI pass (UiScope)

const LEGAL_PREFIX: &str = "/srv/legal/projects";

fn legal_scope(wid: &str) -> UiScope {
    UiScope {
        issuer: "legal".into(),
        workspace_id: wid.into(),
        machine_ids: vec!["machine-1".into()],
        root_prefix: LEGAL_PREFIX.into(),
    }
}

/// The firm's shape: `owner` is BOTH the owner of workspace «Team» and the owner
/// of the device `machine-1`, and the only person on the list of matter `a`.
/// Matter `b` is listed for `mate` alone; `c` is a restricted share OUTSIDE the
/// key's prefix that `owner` is also on. Four sessions, one per folder plus
/// `/repo`, are in the inventory. The connection is then seated on a UI pass.
fn seat_on_a_ui_pass(hub: &mut Hub) -> String {
    let ws = hub.workspaces.clone();
    ws.ensure_user("mate", "mate@example.com", Some("Mate"))
        .unwrap();
    ws.activate_access("mate", "tests").unwrap();
    let team = ws.create_organization("owner", "Team", "owner").unwrap();
    let wid = team["workspaceId"].as_str().unwrap().to_string();
    let invite = ws
        .invite("owner", &wid, "mate@example.com", "member")
        .unwrap();
    ws.accept_invitation("mate", invite["token"].as_str().unwrap())
        .unwrap();
    for (root, listed) in [
        ("/srv/legal/projects/a", "owner"),
        ("/srv/legal/projects/b", "mate"),
        ("/srv/other/c", "owner"),
    ] {
        let share = ws
            .share_project("owner", &wid, "machine-1", root, root, "control", "team")
            .unwrap();
        let id = share["projectShareId"].as_str().unwrap().to_string();
        ws.with_conn_for_tests(|c| {
            c.execute(
                "UPDATE project_shares SET restricted=1 WHERE project_share_id=?1",
                [&id],
            )
            .unwrap();
            c.execute(
                "INSERT INTO project_share_members VALUES(?1,?2,'lead',1)",
                [&id, &listed.to_string()],
            )
            .unwrap();
        });
    }
    hub.store
        .record_machine(
            &json!({"machineId":"machine-1","name":"Machine","os":"linux","agentVersion":"test"}),
            now_ms(),
        )
        .unwrap();
    let sessions: Vec<Value> = [
        ("s-a", "/srv/legal/projects/a"),
        ("s-b", "/srv/legal/projects/b"),
        ("s-c", "/srv/other/c"),
        ("s-repo", "/repo"),
    ]
    .iter()
    .map(|(id, cwd)| json!({"sessionId":id,"title":id,"cwd":cwd,"source":"codex"}))
    .collect();
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"inventory","sessions":sessions,"complete":true}),
    );
    let access = ws
        .ui_access("owner", Some(&wid), false)
        .unwrap()
        .with_scope(legal_scope(&wid));
    hub.ui_access.insert(UI_CONN, access);
    seat_pass_of(hub, "owner", &wid);
    wid
}

/// Revoke a pass the way its holder does: the store-level `logout`.
fn drop_pass(hub: &Hub, token: &str) -> bool {
    hub.workspaces.logout(token)
}

/// Mint the pass the connection rides on and record it where the hub keeps it.
fn seat_pass_of(hub: &mut Hub, user: &str, wid: &str) -> String {
    let (token, _) = hub
        .workspaces
        .mint_service_ui_pass("legal", user, wid)
        .unwrap();
    hub.ui_sessions
        .insert(UI_CONN, crate::workspace::hash_ui_pass(&token));
    token
}

fn snapshot_session_ids(hub: &Hub) -> Vec<String> {
    let snap = hub.snapshot_for(UI_CONN);
    let mut ids: Vec<String> = snap["machines"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|m| m["sessions"].as_array().cloned().unwrap_or_default())
        .map(|s| s["sessionId"].as_str().unwrap().to_string())
        .collect();
    ids.sort();
    ids
}

/// The owner of the workspace AND of the device — both exemptions the normal
/// ACL grants — see only the matters they are listed on through a pass, and
/// only on the key's machines; the same person without a pass sees all.
#[test]
fn a_ui_pass_snapshot_holds_only_the_listed_matters_even_for_the_owners() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    let wid = seat_on_a_ui_pass(&mut hub);
    drain(&mut ui_rx);

    assert_eq!(snapshot_session_ids(&hub), vec!["s-a"]);
    let snap = hub.snapshot_for(UI_CONN);
    assert!(snap.get("roadmap").is_none(), "no roadmap for a pass");
    assert_eq!(
        snap["viewer"]["workspaces"].as_array().map(Vec::len),
        Some(1),
        "the viewer's other workspaces are not for a pass"
    );
    assert!(
        snap["machines"][0].get("owner").is_none(),
        "no device owner identity"
    );
    assert_eq!(snap["machines"][0]["canControl"], false);

    // The same person on an ordinary connection: everything (device owner).
    let plain = hub
        .workspaces
        .ui_access("owner", Some(&wid), false)
        .unwrap();
    hub.ui_access.insert(UI_CONN, plain);
    assert_eq!(
        snapshot_session_ids(&hub),
        vec!["s-a", "s-b", "s-c", "s-repo"]
    );

    // A pass for another machine list shows no machine at all.
    let mut scope = legal_scope(&wid);
    scope.machine_ids = vec!["some-other-box".into()];
    let access = hub
        .workspaces
        .ui_access("owner", Some(&wid), false)
        .unwrap()
        .with_scope(scope);
    hub.ui_access.insert(UI_CONN, access);
    assert!(hub.snapshot_for(UI_CONN)["machines"]
        .as_array()
        .unwrap()
        .is_empty());

    // …and a prefix that excludes `a` leaves nothing either.
    let mut scope = legal_scope(&wid);
    scope.root_prefix = "/srv/legal/projects/zzz".into();
    let access = hub
        .workspaces
        .ui_access("owner", Some(&wid), false)
        .unwrap()
        .with_scope(scope);
    hub.ui_access.insert(UI_CONN, access);
    assert!(hub.snapshot_for(UI_CONN)["machines"]
        .as_array()
        .unwrap()
        .is_empty());
}

/// Runs, deltas, reads and the session rights all answer inside the fence.
#[test]
fn a_ui_pass_connection_sees_runs_deltas_and_reads_only_inside_its_matters() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    seat_on_a_ui_pass(&mut hub);
    for (run_id, session_id, cwd) in [
        ("run-a", "s-a", "/srv/legal/projects/a"),
        ("run-b", "s-b", "/srv/legal/projects/b"),
        ("run-c", "s-c", "/srv/other/c"),
        ("run-repo", "s-repo", "/repo"),
    ] {
        let mut run = test_run(&[]);
        run.session_id = session_id.into();
        run.cwd = Some(cwd.into());
        hub.runs.insert(run_id.into(), run);
    }
    let active = hub.active_runs_json_for(UI_CONN);
    let ids: Vec<&str> = active
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["runId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["run-a"]);

    drain(&mut ui_rx);
    hub.broadcast_activity();
    let activity: Vec<Value> = drain(&mut ui_rx)
        .into_iter()
        .filter(|m| m["type"] == "activity")
        .collect();
    assert_eq!(activity.len(), 1);
    assert_eq!(activity[0]["runs"].as_array().unwrap().len(), 1);

    // A session list delta carries only the matter's sessions.
    hub.ui_caps
        .insert(UI_CONN, HashSet::from([CAP_SESSION_PATCH.to_string()]));
    drain(&mut ui_rx);
    hub.broadcast_machine_sessions(&["machine-1".to_string()]);
    for frame in drain(&mut ui_rx) {
        let text = frame.to_string();
        assert!(
            !text.contains("s-b") && !text.contains("s-c") && !text.contains("s-repo"),
            "{text}"
        );
    }

    // Reading a transcript, and the read mark, are judged the same way.
    assert!(hub.ui_can_view_session(UI_CONN, "machine-1", "s-a", None));
    for hidden in ["s-b", "s-c", "s-repo"] {
        assert!(
            !hub.ui_can_view_session(UI_CONN, "machine-1", hidden, None),
            "{hidden}"
        );
        // Not even when the client names the cwd of a matter it is on.
        assert!(
            !hub.ui_can_view_session(UI_CONN, "machine-1", hidden, Some("/srv/legal/projects/a")),
            "{hidden} with a claimed cwd"
        );
    }
    hub.ui_session_read(UI_CONN, &json!({"machineId":"machine-1","sessionId":"s-b"}));
    hub.ui_session_read(UI_CONN, &json!({"machineId":"machine-1","sessionId":"s-a"}));
    let reads = hub
        .workspaces
        .session_reads_recent("owner", 0, 100)
        .unwrap();
    assert_eq!(
        reads.iter().map(|(_, s, _)| s.as_str()).collect::<Vec<_>>(),
        vec!["s-a"]
    );
}

/// The terminal, mirrors, the board, files, projects, policy and the rest of
/// the browser protocol are refused with `scope_refused`; the session surface
/// is not.
#[test]
fn a_ui_pass_connection_may_only_send_the_session_frames() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    seat_on_a_ui_pass(&mut hub);
    drain(&mut ui_rx);
    drain(&mut agent_rx);
    for ty in [
        "term_open",
        "term_input",
        "term_resize",
        "term_close",
        "mirror_open",
        "mirror_close",
        "takeover",
        "set_stage",
        "end_session",
        "set_model",
        "set_permission_mode",
        "set_effort",
        "compact",
        "rescan",
        "enrich_request",
        "memory_list",
        "memory_read",
        "memory_delete",
        "register_push",
        "unregister_push",
        "something_new",
    ] {
        hub.on_ui_msg(
            UI_CONN,
            json!({"type":ty,"ref":"p1","machineId":"machine-1","sessionId":"s-a","runId":"run-a"}),
        );
        let got = drain(&mut ui_rx);
        assert!(
            got.iter()
                .any(|m| m["type"] == "error" && m["code"] == "scope_refused" && m["ref"] == "p1"),
            "{ty}: {got:?}"
        );
        assert!(drain(&mut agent_rx).is_empty(), "{ty} reached the agent");
    }
    assert!(hub.terminals.is_empty() && hub.mirrors.is_empty());
    // The allowed ones draw no `scope_refused`.
    for ty in ["ping", "hello", "subscribe", "unsubscribe", "session_read"] {
        hub.on_ui_msg(
            UI_CONN,
            json!({"type":ty,"machineId":"machine-1","sessionId":"s-a","runId":"nope"}),
        );
        assert!(
            drain(&mut ui_rx)
                .iter()
                .all(|m| m["code"] != "scope_refused"),
            "{ty}"
        );
    }
}

/// `rpc_request` is four methods; a refused one is an `rpc_response` error and
/// nothing is forwarded.
#[test]
fn a_ui_pass_connection_may_call_four_rpc_methods_inside_its_matters() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    seat_on_a_ui_pass(&mut hub);
    let call = |hub: &mut Hub, id: &str, method: &str, params: Value| {
        hub.on_ui_msg(
            UI_CONN,
            json!({"type":"rpc_request","requestId":id,"machineId":"machine-1",
                   "method":method,"params":params}),
        );
    };
    drain(&mut ui_rx);
    drain(&mut agent_rx);
    for (i, method) in [
        "fs.list",
        "fs.read",
        "fs.download",
        "fs.peek",
        "fs.mkdir",
        "fs.write",
        "projects.list",
        "session.delete",
        "session.subagent",
        "commands.list",
        "run.stopSubagent",
        "git.status",
        "git.push",
        "git.pr.create",
        "git.worktree.add",
        "git.diff",
        "runtime.status",
        "sync.forget",
    ]
    .iter()
    .enumerate()
    {
        let id = format!("r{i}");
        call(
            &mut hub,
            &id,
            method,
            json!({"cwd":"/srv/legal/projects/a","path":"x","sessionId":"s-a"}),
        );
        assert!(
            drain(&mut ui_rx)
                .iter()
                .any(|m| m["requestId"] == id.as_str() && m["ok"] == false),
            "{method} answered with an error"
        );
        assert!(
            drain(&mut agent_rx)
                .iter()
                .all(|m| m["requestId"] != id.as_str()),
            "{method} was forwarded"
        );
    }
    // The ones that are allowed, inside a matter the person is on.
    for (id, method, params) in [
        ("ok1", "models.list", json!({})),
        (
            "ok2",
            "session.rename",
            json!({"sessionId":"s-a","title":"x"}),
        ),
    ] {
        call(&mut hub, id, method, params);
        assert!(
            drain(&mut agent_rx).iter().any(|m| m["requestId"] == id),
            "{method} reaches the agent"
        );
    }
    // …and the same methods on a matter they are not on are refused.
    drain(&mut ui_rx);
    call(
        &mut hub,
        "no1",
        "session.rename",
        json!({"sessionId":"s-b","title":"x"}),
    );
    call(
        &mut hub,
        "no2",
        "session.messages",
        json!({"sessionId":"s-b","cwd":"/srv/legal/projects/a"}),
    );
    call(&mut hub, "no3", "session.image", json!({"sessionId":"s-c"}));
    let got = drain(&mut ui_rx);
    for id in ["no1", "no2", "no3"] {
        assert!(
            got.iter().any(|m| m["requestId"] == id && m["ok"] == false),
            "{id}: {got:?}"
        );
    }
    assert!(drain(&mut agent_rx).is_empty());
}

/// Starting and resuming: only inside a matter the person is on, always Codex.
#[test]
fn a_ui_pass_connection_starts_and_resumes_only_inside_its_matters() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    seat_on_a_ui_pass(&mut hub);
    drain(&mut ui_rx);
    let start = |hub: &mut Hub, rx: &mut Receiver<String>, cwd: &str| -> Option<Value> {
        drain(rx);
        hub.on_ui_msg(
            UI_CONN,
            json!({"type":"new_session","machineId":"machine-1","cwd":cwd,"message":"x","source":"claude"}),
        );
        drain(rx).into_iter().find(|m| m["type"] == "new_session")
    };
    let started =
        start(&mut hub, &mut agent_rx, "/srv/legal/projects/a").expect("a matter the person is on");
    assert_eq!(started["source"], "codex", "pinned off the owner's Claude");
    assert!(start(&mut hub, &mut agent_rx, "/srv/legal/projects/a/sub").is_some());
    for cwd in [
        "/srv/legal/projects/b",
        "/srv/legal/projects",
        "/srv/legal",
        "/srv/legal/projects/a/../b",
        "/srv/other/c",
        "/repo",
        "/",
    ] {
        assert!(
            start(&mut hub, &mut agent_rx, cwd).is_none(),
            "{cwd} must be refused"
        );
    }
    // Resuming a session of a matter they are not on goes nowhere.
    for session_id in ["s-b", "s-c", "s-repo"] {
        drain(&mut agent_rx);
        hub.on_ui_msg(
            UI_CONN,
            json!({"type":"open","machineId":"machine-1","sessionId":session_id}),
        );
        assert!(
            drain(&mut agent_rx).iter().all(|m| m["type"] != "resume"),
            "{session_id}"
        );
    }
    drain(&mut agent_rx);
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"open","machineId":"machine-1","sessionId":"s-a"}),
    );
    assert!(
        drain(&mut agent_rx).iter().any(|m| m["type"] == "resume"),
        "their own matter resumes"
    );
}

/// A run in another matter cannot be subscribed to, typed into or stopped.
#[test]
fn a_ui_pass_connection_cannot_reach_a_run_outside_its_matters() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    seat_on_a_ui_pass(&mut hub);
    let mut run = test_run(&[]);
    run.session_id = "s-b".into();
    run.cwd = Some("/srv/legal/projects/b".into());
    hub.runs.insert("run-b".into(), run);
    drain(&mut ui_rx);
    drain(&mut agent_rx);
    for frame in [
        json!({"type":"subscribe","runId":"run-b"}),
        json!({"type":"input","runId":"run-b","text":"hi"}),
        json!({"type":"interrupt","runId":"run-b"}),
        json!({"type":"close","runId":"run-b"}),
        json!({"type":"tool_decision","runId":"run-b","requestId":"q","allow":true}),
    ] {
        hub.on_ui_msg(UI_CONN, frame.clone());
        assert!(drain(&mut agent_rx).is_empty(), "{frame} reached the agent");
    }
    assert!(hub.runs["run-b"].browsers.is_empty());
    assert!(hub.runs.contains_key("run-b"));
}

/// The pass is re-derived inside its fence on every refresh: it survives a
/// quiet one with its scope, and the socket goes when the person LEAVES the
/// workspace — and the pass row with it. Becoming an administrator changes
/// nothing: the scope still wins.
#[test]
fn a_ui_pass_connection_is_revalidated_on_every_refresh() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    let wid = seat_on_a_ui_pass(&mut hub);
    let (token, _) = hub
        .workspaces
        .mint_service_ui_pass("legal", "owner", &wid)
        .unwrap();
    hub.ui_sessions
        .insert(UI_CONN, crate::workspace::hash_ui_pass(&token));
    drain(&mut ui_rx);

    hub.handle(HubCmd::RefreshWorkspaceState);
    let kept = &hub.ui_access[&UI_CONN];
    assert_eq!(kept.ui_scope, Some(legal_scope(&wid)), "scope survives");
    assert_eq!(snapshot_session_ids(&hub), vec!["s-a"]);
    assert!(hub.ui_clients.contains(&UI_CONN));
    assert!(hub
        .workspaces
        .authenticate_ui_pass(&token)
        .unwrap()
        .is_some());

    // The owner of the firm becomes a platform administrator: nothing widens.
    hub.workspaces.set_always_active(["owner".to_string()]);
    hub.handle(HubCmd::RefreshWorkspaceState);
    assert_eq!(
        hub.ui_access[&UI_CONN].ui_scope,
        Some(legal_scope(&wid)),
        "an administrator keeps the scope"
    );
    assert_eq!(snapshot_session_ids(&hub), vec!["s-a"]);
    assert!(hub
        .workspaces
        .authenticate_ui_pass(&token)
        .unwrap()
        .is_some());

    // …and leaving the workspace ends the pass, administrator or not.
    hub.workspaces.with_conn_for_tests(|c| {
        c.execute(
            "DELETE FROM memberships WHERE workspace_id=?1 AND user_id='owner'",
            [&wid],
        )
        .unwrap();
    });
    hub.handle(HubCmd::RefreshWorkspaceState);
    assert!(
        !hub.ui_access.contains_key(&UI_CONN) && !hub.ui_clients.contains(&UI_CONN),
        "a person who left the workspace holds no pass"
    );
    assert!(hub
        .workspaces
        .authenticate_ui_pass(&token)
        .unwrap()
        .is_none());
}

/// A platform administrator (and the bootstrap user, who is always active
/// too) on a pass sees exactly what the pass's fence allows: the matters they
/// are LISTED on under the prefix, on the key's machine — not their other
/// machine, not the matters they are not listed on, not the one outside the
/// prefix — and no administrator flag reaches the viewer. The same person on
/// an ordinary connection still sees everything.
#[test]
fn an_administrators_ui_pass_is_no_wider_than_anybody_elses() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    let wid = seat_on_a_ui_pass(&mut hub);
    hub.workspaces.set_always_active(["owner".to_string()]);
    // The administrator's OTHER machine, online.
    hub.workspaces
        .register_legacy_device(
            "owner",
            &json!({"machineId":"machine-2","name":"Mine","os":"linux","agentVersion":"test"}),
        )
        .unwrap();
    add_current_agent(&mut hub, 3, "machine-2");
    // The pass the person holds is minted and re-derived like any other.
    let token = seat_pass_of(&mut hub, "owner", &wid);
    assert!(hub
        .workspaces
        .authenticate_ui_pass(&token)
        .unwrap()
        .is_some());
    hub.handle(HubCmd::RefreshWorkspaceState);
    drain(&mut ui_rx);

    let access = hub.ui_access[&UI_CONN].clone();
    assert_eq!(access.viewer["platformAdmin"], false);
    assert_eq!(snapshot_session_ids(&hub), vec!["s-a"]);
    let snap = hub.snapshot_for(UI_CONN);
    let machines: Vec<&str> = snap["machines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["machine"]["machineId"].as_str().unwrap())
        .collect();
    assert_eq!(
        machines,
        vec!["machine-1"],
        "not the administrator's other box"
    );
    assert_eq!(snap["machines"][0]["canControl"], false);
    assert!(snap["machines"][0].get("owner").is_none());
    assert!(hub
        .workspaces
        .machine_access(&access, "machine-2")
        .map(|m| !m.can_view)
        .unwrap());
    // The listed matter only: the unlisted matter and the one outside the
    // prefix are closed roots.
    let m = hub.workspaces.machine_access(&access, "machine-1").unwrap();
    assert_eq!(m.roots, Some(vec!["/srv/legal/projects/a".to_string()]));
    assert!(!m.allows_path("/srv/legal/projects/b/x") && !m.allows_path("/srv/other/c"));

    // The same person, no pass: the whole of it.
    let plain = hub.workspaces.ui_access("owner", Some(&wid), true).unwrap();
    hub.ui_access.insert(UI_CONN, plain);
    let ids = snapshot_session_ids(&hub);
    assert!(ids.contains(&"s-b".to_string()) && ids.contains(&"s-c".to_string()));
    let machines = hub.snapshot_for(UI_CONN)["machines"]
        .as_array()
        .unwrap()
        .len();
    assert_eq!(machines, 2);
    // A pass is no HTTP credential (the board and the rest are HTTP-only for
    // an administrator): it authenticates nowhere else.
    assert!(hub.workspaces.authenticate(&token).unwrap().is_none());
}

#[test]
fn a_ui_pass_connection_closes_when_its_person_is_removed_from_the_workspace() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    let wid = seat_on_a_ui_pass(&mut hub);
    // `mate` is the person on the pass this time.
    let access = hub
        .workspaces
        .ui_access("mate", Some(&wid), false)
        .unwrap()
        .with_scope(legal_scope(&wid));
    hub.ui_access.insert(UI_CONN, access);
    let (token, _) = hub
        .workspaces
        .mint_service_ui_pass("legal", "mate", &wid)
        .unwrap();
    hub.ui_sessions
        .insert(UI_CONN, crate::workspace::hash_ui_pass(&token));
    assert_eq!(snapshot_session_ids(&hub), vec!["s-b"]);
    drain(&mut ui_rx);

    hub.workspaces.remove_member("owner", &wid, "mate").unwrap();
    hub.handle(HubCmd::RefreshWorkspaceState);
    assert!(
        !hub.ui_access.contains_key(&UI_CONN) && !hub.ui_clients.contains(&UI_CONN),
        "the socket is closed"
    );
    assert!(
        hub.workspaces
            .authenticate_ui_pass(&token)
            .unwrap()
            .is_none(),
        "and the pass is gone"
    );
}

/// A pass that has run out, been evicted by the per-person cap or been revoked
/// ends the connection on its very next frame — and on the housekeeping tick
/// for one that only listens. Nothing is answered first.
#[test]
fn a_ui_pass_connection_does_not_outlive_its_pass() {
    for end in ["expires", "revoked", "evicted"] {
        let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
        let wid = seat_on_a_ui_pass(&mut hub);
        let first = seat_pass_of(&mut hub, "owner", &wid);
        let hash = crate::workspace::hash_ui_pass(&first);
        match end {
            "expires" => hub.workspaces.with_conn_for_tests(|c| {
                c.execute(
                    "UPDATE auth_sessions SET expires_at=?1 WHERE token_hash=?2",
                    rusqlite::params![crate::workspace::now_ms() - 1, hash],
                )
                .unwrap();
            }),
            "revoked" => assert!(drop_pass(&hub, &first)),
            _ => {
                // 20 more by the same person push the first one out.
                for _ in 0..20 {
                    hub.workspaces
                        .mint_service_ui_pass("legal", "owner", &wid)
                        .unwrap();
                }
            }
        }
        drain(&mut ui_rx);
        drain(&mut agent_rx);
        hub.on_ui_msg(UI_CONN, json!({"type":"ping"}));
        hub.on_ui_msg(
            UI_CONN,
            json!({"type":"new_session","machineId":"machine-1","cwd":"/srv/legal/projects/a","message":"x"}),
        );
        assert!(!hub.ui_access.contains_key(&UI_CONN), "{end}: closed");
        assert!(drain(&mut ui_rx).is_empty(), "{end}: nothing answered");
        assert!(drain(&mut agent_rx).is_empty(), "{end}: nothing started");
    }

    // A connection that never speaks is closed by the tick.
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    let wid = seat_on_a_ui_pass(&mut hub);
    hub.handle(HubCmd::SweepUiPasses);
    assert!(hub.ui_access.contains_key(&UI_CONN), "a good pass stays");
    let token = seat_pass_of(&mut hub, "owner", &wid);
    assert!(drop_pass(&hub, &token));
    hub.handle(HubCmd::SweepUiPasses);
    assert!(!hub.ui_access.contains_key(&UI_CONN));

    // And a scoped connection with no pass on record is never alive.
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    seat_on_a_ui_pass(&mut hub);
    hub.ui_sessions.remove(&UI_CONN);
    assert!(!hub.scoped_pass_alive(UI_CONN));
}

/// Starts are Codex-only for a pass, so resumes are too: a Claude session in the
/// matter would run on the device owner's Claude login.
#[test]
fn a_ui_pass_connection_resumes_codex_sessions_only() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    seat_on_a_ui_pass(&mut hub);
    let sessions = vec![
        json!({"sessionId":"s-codex","title":"x","cwd":"/srv/legal/projects/a","source":"codex"}),
        json!({"sessionId":"s-claude","title":"y","cwd":"/srv/legal/projects/a","source":"claude"}),
        json!({"sessionId":"s-legacy","title":"z","cwd":"/srv/legal/projects/a"}),
    ];
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"inventory","sessions":sessions,"complete":true}),
    );
    drain(&mut ui_rx);
    for (session_id, resumed) in [("s-codex", true), ("s-claude", false), ("s-legacy", false)] {
        drain(&mut agent_rx);
        hub.on_ui_msg(
            UI_CONN,
            json!({"type":"open","machineId":"machine-1","sessionId":session_id}),
        );
        assert_eq!(
            drain(&mut agent_rx).iter().any(|m| m["type"] == "resume"),
            resumed,
            "{session_id}"
        );
        hub.runs.clear();
        hub.lock_by_key.clear();
    }
}

/// The hub places a session by ITS record (catalog, or a live run), never by the
/// `cwd` the caller supplies: the agent resolves a transcript by id and ignores
/// `cwd`, so "an id the hub does not know + my own shared root" must not read.
/// Holds for a pass and for an ordinary control-share member alike.
#[test]
fn an_unknown_session_id_is_not_placed_by_the_callers_cwd() {
    let rpc = |hub: &mut Hub, id: &str, method: &str, params: Value| {
        hub.on_ui_msg(
            UI_CONN,
            json!({"type":"rpc_request","requestId":id,"machineId":"machine-1",
                   "method":method,"params":params}),
        );
    };

    // A pass.
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    seat_on_a_ui_pass(&mut hub);
    drain(&mut ui_rx);
    drain(&mut agent_rx);
    for (i, method) in ["session.messages", "session.image", "session.rename"]
        .iter()
        .enumerate()
    {
        let id = format!("u{i}");
        rpc(
            &mut hub,
            &id,
            method,
            json!({"sessionId":"never-heard-of","cwd":"/srv/legal/projects/a","title":"x"}),
        );
        assert!(
            drain(&mut ui_rx)
                .iter()
                .any(|m| m["requestId"] == id.as_str() && m["ok"] == false),
            "{method}"
        );
        assert!(
            drain(&mut agent_rx)
                .iter()
                .all(|m| m["requestId"] != id.as_str()),
            "{method} forwarded"
        );
    }
    // A foreign session with the right cwd claimed (the same hole, other id).
    rpc(
        &mut hub,
        "f1",
        "session.messages",
        json!({"sessionId":"s-b","cwd":"/srv/legal/projects/a"}),
    );
    assert!(drain(&mut agent_rx).is_empty());
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"open","machineId":"machine-1","sessionId":"never-heard-of"}),
    );
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"subscribe","runId":"never-heard-of"}),
    );
    assert!(drain(&mut agent_rx).is_empty());
    // A session the hub knows only through a LIVE run in the matter is placed
    // by that run.
    let mut run = test_run(&[]);
    run.session_id = "fresh".into();
    run.cwd = Some("/srv/legal/projects/a".into());
    hub.runs.insert("run-fresh".into(), run);
    assert!(hub.ui_can_view_session(UI_CONN, "machine-1", "fresh", None));
    assert!(!hub.ui_can_view_session(
        UI_CONN,
        "machine-1",
        "stranger",
        Some("/srv/legal/projects/a")
    ));

    // An ordinary member of a control share on /repo.
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    seat_as_team_member(&mut hub);
    hub.session_meta.insert(
        "machine-1::session-1".into(),
        SessionMeta {
            owner_user_id: "owner".into(),
            category: None,
            stage: None,
            origin: None,
        },
    );
    drain(&mut ui_rx);
    drain(&mut agent_rx);
    assert!(hub.ui_can_view_session(UI_CONN, "machine-1", "session-1", Some("/repo")));
    assert!(
        !hub.ui_can_view_session(UI_CONN, "machine-1", "never-heard-of", Some("/repo")),
        "an id the hub cannot place is not theirs because they name their root"
    );
    rpc(
        &mut hub,
        "m1",
        "session.messages",
        json!({"sessionId":"never-heard-of","cwd":"/repo"}),
    );
    assert!(drain(&mut ui_rx)
        .iter()
        .any(|m| m["requestId"] == "m1" && m["ok"] == false));
    assert!(drain(&mut agent_rx).is_empty());
}

/// A `Connected` queued behind the revocation of its pass does not resurrect
/// the socket or send it a snapshot.
#[test]
fn a_connect_with_a_dead_pass_is_dropped_before_any_snapshot() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    let wid = seat_on_a_ui_pass(&mut hub);
    let token = seat_pass_of(&mut hub, "owner", &wid);
    assert!(drop_pass(&hub, &token));
    hub.ui_access.clear();
    hub.ui_sessions.clear();
    let (tx, mut rx) = channel(8);
    hub.handle(HubCmd::Connected {
        conn: 9,
        tx,
        is_agent: false,
        user_id: "owner".into(),
        workspace_id: Some(wid.clone()),
        viewer: None,
        authorized_machine_id: None,
        auth_session: Some(crate::workspace::hash_ui_pass(&token)),
        ui_scope: Some(legal_scope(&wid)),
        gate: Default::default(),
    });
    assert!(!hub.conns.contains_key(&9) && !hub.ui_access.contains_key(&9));
    assert!(drain(&mut rx).is_empty());
}

/// A Claude run in the matter (somebody else started it) is not driven from a
/// pass — it would spend the device owner's Claude login — while a Codex run
/// in the same matter is.
#[test]
fn a_ui_pass_connection_drives_codex_runs_only() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    seat_on_a_ui_pass(&mut hub);
    for (run_id, session_id, source) in [
        ("run-codex", "s-a", Some("codex")),
        ("run-claude", "s-a2", Some("claude")),
        ("run-legacy", "s-a3", None),
        ("run-fresh-claude", "", Some("claude")),
    ] {
        let mut run = test_run(&[]);
        run.session_id = session_id.into();
        run.cwd = Some("/srv/legal/projects/a".into());
        run.source = source.map(str::to_string);
        hub.runs.insert(run_id.into(), run);
    }
    drain(&mut ui_rx);
    drain(&mut agent_rx);
    for run_id in ["run-claude", "run-legacy", "run-fresh-claude"] {
        for frame in [
            json!({"type":"input","runId":run_id,"text":"hi"}),
            json!({"type":"interrupt","runId":run_id}),
            json!({"type":"close","runId":run_id}),
            json!({"type":"tool_decision","runId":run_id,"requestId":"q","allow":true}),
        ] {
            hub.on_ui_msg(UI_CONN, frame.clone());
            assert!(drain(&mut agent_rx).is_empty(), "{frame} reached the agent");
        }
    }
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"input","runId":"run-codex","text":"hi"}),
    );
    assert!(
        drain(&mut agent_rx).iter().any(|m| m["type"] == "input"),
        "a Codex run in the matter is driven"
    );
}

/// A run adopted after a hub restart learns its runtime from the next
/// inventory, and a pass that asked for session patches is still sent its own
/// scoped list — never the global `removed` ids of a patch.
#[test]
fn a_ui_pass_gets_scoped_lists_and_adopted_runs_learn_their_runtime() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    seat_on_a_ui_pass(&mut hub);
    let mut run = test_run(&[]);
    run.session_id = "s-a".into();
    run.cwd = Some("/srv/legal/projects/a".into());
    hub.runs.insert("adopted".into(), run);
    hub.backfill_run_sources("machine-1");
    assert_eq!(hub.runs["adopted"].source.as_deref(), Some("codex"));

    hub.ui_caps
        .insert(UI_CONN, HashSet::from([CAP_SESSION_PATCH.to_string()]));
    drain(&mut ui_rx);
    hub.last_snapshot_at = 0;
    hub.broadcast_machine_sessions(&["machine-1".to_string()]);
    let frames = drain(&mut ui_rx);
    assert!(frames.iter().all(|m| m["type"] != "session_updates"));
    assert!(frames.iter().any(|m| m["type"] == "snapshot"));
}

/// Rights lost mid-flight CLOSE a pass's socket (at all three revoke points of
/// `refresh_ui_access_now`): it must not stay open without an entry, outside
/// the pass check and the frame whitelist, holding its run subscriptions.
#[test]
fn a_ui_pass_socket_is_closed_when_the_rpc_answer_path_finds_it_revoked() {
    for how in ["pass-deleted", "left-workspace"] {
        let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
        let wid = seat_on_a_ui_pass(&mut hub);
        let token = seat_pass_of(&mut hub, "owner", &wid);
        let mut run = test_run(&[UI_CONN]);
        run.session_id = "s-a".into();
        run.cwd = Some("/srv/legal/projects/a".into());
        hub.runs.insert("run-a".into(), run);
        match how {
            "pass-deleted" => assert!(drop_pass(&hub, &token)),
            _ => hub.workspaces.with_conn_for_tests(|c| {
                // Past the member_left trigger: the row is already gone, so
                // make it come back to exercise the keep_scope branch.
                c.execute(
                    "DELETE FROM memberships WHERE workspace_id=?1 AND user_id='owner'",
                    [&wid],
                )
                .unwrap();
            }),
        }
        drain(&mut ui_rx);
        assert!(!hub.refresh_ui_access_now(UI_CONN), "{how}");
        assert!(!hub.conns.contains_key(&UI_CONN), "{how}: socket closed");
        assert!(!hub.ui_clients.contains(&UI_CONN), "{how}");
        assert!(hub.runs["run-a"].browsers.is_empty(), "{how}: detached");
        hub.to_run_browsers(
            "run-a",
            &json!({"type":"stream","runId":"run-a","event":{"kind":"text","text":"x"}}),
        );
        assert!(drain(&mut ui_rx).is_empty(), "{how}: no further run frames");
    }
}

/// A pass is stored under its own hash domain: its token is nothing as an
/// ordinary session even if the `ui_scope` filter were not there (a hub rolled
/// back to a binary that does not know the column).
#[test]
fn a_ui_pass_token_is_not_an_ordinary_session_token_at_the_hash_level() {
    let (hub, _ui_rx, _agent_rx) = test_hub(session(None));
    let wid = {
        let ws = hub.workspaces.clone();
        let team = ws.create_organization("owner", "Team", "owner").unwrap();
        team["workspaceId"].as_str().unwrap().to_string()
    };
    let (token, _) = hub
        .workspaces
        .mint_service_ui_pass("legal", "owner", &wid)
        .unwrap();
    assert_ne!(
        crate::workspace::hash_ui_pass(&token),
        crate::workspace::hash_token(&token)
    );
    let as_session: i64 = hub.workspaces.with_conn_for_tests(|c| {
        c.query_row(
            "SELECT COUNT(*) FROM auth_sessions WHERE token_hash=?1 AND expires_at>?2",
            rusqlite::params![crate::workspace::hash_token(&token), 0],
            |r| r.get(0),
        )
        .unwrap()
    });
    assert_eq!(as_session, 0, "the plain session hash finds nothing");
    assert!(hub.workspaces.authenticate(&token).unwrap().is_none());
    assert!(hub
        .workspaces
        .authenticate_ui_pass(&token)
        .unwrap()
        .is_some());
}

/// The device owner is not named to a pass — not on the sessions or the runs
/// they own inside an allowed matter — while a listed colleague still is.
#[test]
fn a_ui_pass_is_not_told_who_the_device_owner_is() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    seat_on_a_ui_pass(&mut hub);
    let sessions = vec![
        json!({"sessionId":"own","title":"x","cwd":"/srv/legal/projects/a","source":"codex"}),
        json!({"sessionId":"mate-s","title":"y","cwd":"/srv/legal/projects/a","source":"codex"}),
    ];
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"inventory","sessions":sessions,"complete":true}),
    );
    for (sid, who) in [("own", "owner"), ("mate-s", "mate")] {
        hub.session_meta.insert(
            format!("machine-1::{sid}"),
            SessionMeta {
                owner_user_id: who.into(),
                category: None,
                stage: None,
                origin: None,
            },
        );
        hub.user_display.insert(
            who.into(),
            json!({"userId":who,"email":format!("{who}@example.com")}),
        );
    }
    drain(&mut ui_rx);
    let snap = hub.snapshot_for(UI_CONN);
    let listed = snap["machines"][0]["sessions"].as_array().unwrap();
    let by_id = |id: &str| listed.iter().find(|s| s["sessionId"] == id).unwrap();
    assert!(by_id("own").get("owner").is_none(), "device owner hidden");
    assert_eq!(by_id("mate-s")["owner"]["userId"], "mate");
    assert!(!snap["machines"].to_string().contains("owner@example.com"));

    for (run_id, session_id, who) in [("r1", "own", "owner"), ("r2", "mate-s", "mate")] {
        let mut run = test_run(&[]);
        run.session_id = session_id.into();
        run.cwd = Some("/srv/legal/projects/a".into());
        run.owner_user_id = Some(who.into());
        run.owner_name = Some(who.into());
        hub.runs.insert(run_id.into(), run);
    }
    let runs = hub.active_runs_json_for(UI_CONN);
    let run = |id: &str| {
        runs.as_array()
            .unwrap()
            .iter()
            .find(|r| r["runId"] == id)
            .unwrap()
            .clone()
    };
    assert!(run("r1").get("ownerUserId").is_none() && run("r1").get("ownerName").is_none());
    assert_eq!(run("r2")["ownerUserId"], "mate");
}

/// iOS sends `rescan` on every return to the app; a share member who may not
/// control the machine used to see «Machine control denied.» for it. The nudge
/// is dropped quietly now — no error, and the agent is still never asked.
#[test]
fn a_members_rescan_is_dropped_without_an_error() {
    let (mut hub, mut ui_rx, mut agent_rx) = test_hub(session(None));
    seat_as_team_member(&mut hub);
    drain(&mut ui_rx);
    drain(&mut agent_rx);
    hub.on_ui_msg(UI_CONN, json!({"type":"rescan","machineId":"machine-1"}));
    let got = drain(&mut ui_rx);
    assert!(got.iter().all(|m| m["type"] != "error"), "{got:?}");
    assert!(
        drain(&mut agent_rx).iter().all(|m| m["type"] != "rescan"),
        "a member's rescan reached the agent"
    );
}

// ---------------------------------------------------------------------------
// Battery / load: what the hub no longer sends, and what it must still send.
// ---------------------------------------------------------------------------

fn stats_sample(cpu: f64) -> Value {
    json!({"ts": 1, "cpuPercent": cpu, "platform": "linux"})
}

fn send_stats(hub: &mut Hub, cpu: f64) {
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"machine_stats","stats":stats_sample(cpu)}),
    );
}

fn types_of(frames: &[Value]) -> Vec<String> {
    frames
        .iter()
        .map(|m| m["type"].as_str().unwrap_or("").to_string())
        .collect()
}

/// `statsOnDemand`: a client WITHOUT the cap keeps the always-on stream; one
/// WITH it is sent samples only while its last `stats_interest` said `on`, gets
/// the last stored sample at once on the transition, and nothing after `off`.
#[test]
fn machine_stats_follow_stats_interest_for_clients_that_asked() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    drain(&mut ui_rx);

    // No `hello` (every client shipped before the cap): always on.
    send_stats(&mut hub, 1.0);
    assert_eq!(types_of(&drain(&mut ui_rx)), ["machine_stats"]);
    // …and its `stats_interest` changes nothing (nothing to switch, nothing to replay).
    hub.on_ui_msg(UI_CONN, json!({"type":"stats_interest","on":true}));
    assert!(drain(&mut ui_rx).is_empty());
    hub.on_ui_msg(UI_CONN, json!({"type":"stats_interest","on":false}));
    send_stats(&mut hub, 2.0);
    assert_eq!(types_of(&drain(&mut ui_rx)), ["machine_stats"]);

    // The cap, no interest yet: silence.
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"hello","client":"app","caps":["sessionPatch","statsOnDemand"]}),
    );
    send_stats(&mut hub, 3.0);
    assert!(drain(&mut ui_rx).is_empty(), "no interest, no sample");

    // Interest on: the LAST sample arrives immediately, then the stream.
    hub.on_ui_msg(UI_CONN, json!({"type":"stats_interest","on":true}));
    let first = drain(&mut ui_rx);
    assert_eq!(types_of(&first), ["machine_stats"]);
    assert_eq!(first[0]["machineId"], "machine-1");
    assert_eq!(first[0]["stats"]["cpuPercent"], json!(3.0));
    // Saying it again is not a transition: nothing is re-sent.
    hub.on_ui_msg(UI_CONN, json!({"type":"stats_interest","on":true}));
    assert!(drain(&mut ui_rx).is_empty());
    send_stats(&mut hub, 4.0);
    assert_eq!(types_of(&drain(&mut ui_rx)), ["machine_stats"]);

    // Off: the stream stops; on again replays the newest stored sample.
    hub.on_ui_msg(UI_CONN, json!({"type":"stats_interest","on":false}));
    send_stats(&mut hub, 5.0);
    assert!(drain(&mut ui_rx).is_empty());
    hub.on_ui_msg(UI_CONN, json!({"type":"stats_interest","on":true}));
    assert_eq!(drain(&mut ui_rx)[0]["stats"]["cpuPercent"], json!(5.0));

    // A re-`hello` without the cap puts the client back on the always-on stream.
    hub.on_ui_msg(UI_CONN, json!({"type":"stats_interest","on":false}));
    hub.on_ui_msg(UI_CONN, json!({"type":"hello","client":"app","caps":[]}));
    send_stats(&mut hub, 6.0);
    assert_eq!(types_of(&drain(&mut ui_rx)), ["machine_stats"]);

    // The interest dies with the socket.
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"hello","client":"app","caps":["statsOnDemand"]}),
    );
    hub.on_ui_msg(UI_CONN, json!({"type":"stats_interest","on":true}));
    drain(&mut ui_rx);
    hub.on_disconnect(UI_CONN);
    assert!(!hub.ui_stats_interest.contains(&UI_CONN));
}

/// Interest never widens rights: a viewer that does not control a machine is
/// not replayed its sample.
#[test]
fn stats_interest_replays_only_machines_the_viewer_controls() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    seat_as_team_member(&mut hub);
    send_stats(&mut hub, 1.0);
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"hello","client":"app","caps":["statsOnDemand"]}),
    );
    drain(&mut ui_rx);
    hub.on_ui_msg(UI_CONN, json!({"type":"stats_interest","on":true}));
    assert!(
        !types_of(&drain(&mut ui_rx)).contains(&"machine_stats".to_string()),
        "a team member does not control the box"
    );
}

/// The 180 s quota poll repeats the same limits with a new `updatedAt`: that is
/// not news. A changed limit is.
#[test]
fn usage_is_broadcast_only_when_the_reading_changes() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    hub.claude_usage_enabled_machines.insert("machine-1".into());
    let reading = |pct: f64, at: i64| json!({"type":"usage","usage":{"limits":[{"label":"5h","percentage":pct}],"updatedAt":at}});
    drain(&mut ui_rx);
    hub.on_agent_msg(AGENT_CONN, reading(10.0, 1));
    assert_eq!(
        types_of(&drain(&mut ui_rx)),
        ["usage"],
        "the first reading is news"
    );
    hub.on_agent_msg(AGENT_CONN, reading(10.0, 2));
    assert!(drain(&mut ui_rx).is_empty(), "only updatedAt moved");
    assert_eq!(
        hub.agents["machine-1"].usage["updatedAt"],
        json!(2),
        "the freshest reading is still stored for snapshots"
    );
    hub.on_agent_msg(AGENT_CONN, reading(11.0, 3));
    assert_eq!(types_of(&drain(&mut ui_rx)), ["usage"]);

    let codex = |pct: f64, at: i64| json!({"type":"codex_usage","usage":{"limits":[{"label":"5h","percentage":pct}],"updatedAt":at}});
    hub.on_agent_msg(AGENT_CONN, codex(5.0, 1));
    assert_eq!(types_of(&drain(&mut ui_rx)), ["codex_usage"]);
    hub.on_agent_msg(AGENT_CONN, codex(5.0, 2));
    assert!(drain(&mut ui_rx).is_empty());
    hub.on_agent_msg(AGENT_CONN, codex(6.0, 3));
    assert_eq!(types_of(&drain(&mut ui_rx)), ["codex_usage"]);
}

fn second_working_run(hub: &mut Hub) -> String {
    let mut run = test_run(&[]);
    run.session_id = "session-2".into();
    run.last_event_at = now_ms();
    hub.runs.insert("run-b".into(), run);
    "run-b".into()
}

/// Twenty working runs used to push twenty boards every half minute. Their
/// heartbeats are paid by ONE broadcast on the coalescing tick, and after it
/// no run is due again until a full period has passed.
#[test]
fn the_heartbeats_of_all_runs_are_one_broadcast() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_a = hub.runs.keys().find(|k| *k != "run-b").unwrap().clone();
    let run_b = second_working_run(&mut hub);
    hub.runs.get_mut(&run_a).unwrap().state = "working".into();
    let stale = now_ms() - 31_000;
    for id in [&run_a, &run_b] {
        let run = hub.runs.get_mut(id).unwrap();
        run.last_event_sent_at = stale;
        run.last_event_at = stale;
    }
    drain(&mut ui_rx);
    hub.activity_sent.borrow_mut().clear();

    // Both runs speak: neither broadcasts by itself.
    for id in [&run_a, &run_b] {
        let session = if *id == run_a {
            "session-1"
        } else {
            "session-2"
        };
        hub.on_agent_msg(
            AGENT_CONN,
            json!({"type":"stream","runId":id,"sessionId":session,
                   "event":{"kind":"assistant","text":"…"}}),
        );
    }
    assert!(
        !types_of(&drain(&mut ui_rx)).contains(&"activity".to_string()),
        "no heartbeat broadcasts on its own"
    );
    settle_coalescing(&mut hub);
    let frames = drain(&mut ui_rx);
    let boards: Vec<&Value> = frames.iter().filter(|m| m["type"] == "activity").collect();
    assert_eq!(boards.len(), 1, "one board for every run: {frames:?}");
    assert!(boards[0]["runs"].as_array().unwrap().len() >= 2);
    // Nothing is owed any more…
    settle_coalescing(&mut hub);
    assert!(drain(&mut ui_rx).is_empty());
    // …and neither run re-arms a heartbeat inside the period.
    assert!(
        now_ms() - hub.runs[&run_b].last_event_sent_at < 1_000,
        "the one broadcast paid every run's heartbeat"
    );
}

/// The same board is not sent to the same viewer twice; any change is; and a
/// snapshot (which carries its own board) resets what the viewer holds, so a
/// revert to an older board is never muted.
#[test]
fn an_identical_activity_board_is_not_resent_to_the_same_viewer() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    drain(&mut ui_rx);
    hub.activity_sent.borrow_mut().clear();

    hub.broadcast_activity();
    assert_eq!(types_of(&drain(&mut ui_rx)), ["activity"]);
    hub.broadcast_activity();
    assert!(drain(&mut ui_rx).is_empty(), "same board, same viewer");

    // A change goes out.
    let run_id = hub.runs.keys().next().unwrap().clone();
    hub.runs.get_mut(&run_id).unwrap().state = "working".into();
    hub.broadcast_activity();
    assert_eq!(types_of(&drain(&mut ui_rx)), ["activity"]);

    // A snapshot carries a board of its own: after one, even the board the
    // viewer was last sent as `activity` must be sent again.
    hub.last_snapshot_at = 0;
    hub.broadcast_snapshot();
    assert_eq!(types_of(&drain(&mut ui_rx)), ["snapshot"]);
    hub.broadcast_activity();
    assert_eq!(types_of(&drain(&mut ui_rx)), ["activity"]);

    // Paused: nothing, and nothing recorded as sent.
    hub.on_ui_msg(UI_CONN, json!({"type":"pause"}));
    hub.runs.get_mut(&run_id).unwrap().state = "idle".into();
    hub.broadcast_activity();
    assert!(drain(&mut ui_rx).is_empty());
    hub.on_ui_msg(UI_CONN, json!({"type":"resume"}));
    assert_eq!(types_of(&drain(&mut ui_rx))[0], "snapshot");
}

/// A board that differs only in runs this viewer cannot see is the same board
/// to them, so a stranger's heartbeat costs them nothing.
#[test]
fn a_run_the_viewer_cannot_see_does_not_cost_them_a_frame() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    seat_as_team_member(&mut hub);
    drain(&mut ui_rx);
    hub.activity_sent.borrow_mut().clear();
    hub.broadcast_activity();
    drain(&mut ui_rx);
    // A run on a machine the viewer has no part in.
    let mut run = test_run(&[]);
    run.machine_id = "machine-9".into();
    run.session_id = "elsewhere".into();
    hub.runs.insert("hidden".into(), run);
    hub.broadcast_activity();
    assert!(drain(&mut ui_rx).is_empty());
}

/// A viewer that takes patches is told about a re-registering agent with that
/// ONE machine's entry (it carries the online flag a patch cannot); a viewer
/// that takes nothing still gets a whole snapshot. Never the fleet for the
/// first kind.
#[test]
fn registering_an_agent_sends_one_machine_to_clients_that_take_deltas() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    let legacy = UI_CONN + 10;
    let mut legacy_rx = add_colleague(&mut hub, legacy);
    hub.ui_access.insert(
        legacy,
        hub.workspaces.ui_access("owner", None, false).unwrap(),
    );
    hub.ui_caps
        .insert(UI_CONN, HashSet::from([CAP_SESSION_PATCH.to_string()]));
    drain(&mut ui_rx);
    drain(&mut legacy_rx);
    hub.last_snapshot_at = 0;
    let machine = hub.agents["machine-1"].machine.clone();
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"register","machine":machine,"agentInstanceId":"instance-1"}),
    );
    let patching = types_of(&drain(&mut ui_rx));
    assert!(
        patching.contains(&"machine_sessions".to_string()),
        "{patching:?}"
    );
    assert!(!patching.contains(&"snapshot".to_string()), "{patching:?}");
    let old = types_of(&drain(&mut legacy_rx));
    assert!(old.contains(&"snapshot".to_string()), "{old:?}");
}

/// Repeated snapshot requests inside the window cost ONE extra snapshot, sent
/// when the window ends — not one each.
#[test]
fn repeated_snapshot_requests_are_coalesced() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    drain(&mut ui_rx);
    hub.last_snapshot_at = 0;
    for _ in 0..5 {
        hub.broadcast_snapshot();
    }
    assert_eq!(
        types_of(&drain(&mut ui_rx)),
        ["snapshot"],
        "the leading edge"
    );
    assert!(hub.snapshot_dirty);
    settle_coalescing(&mut hub);
    assert_eq!(
        types_of(&drain(&mut ui_rx)),
        ["snapshot"],
        "one trailing snapshot"
    );
    settle_coalescing(&mut hub);
    assert!(drain(&mut ui_rx).is_empty(), "nothing owed any more");
}

/// A paused viewer is skipped before anything is built for it, and `resume`
/// answers with its own snapshot (so skipping loses nothing).
#[test]
fn a_paused_viewer_is_skipped_by_every_session_broadcast() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    hub.ui_caps
        .insert(UI_CONN, HashSet::from([CAP_SESSION_PATCH.to_string()]));
    hub.on_ui_msg(UI_CONN, json!({"type":"pause"}));
    drain(&mut ui_rx);
    hub.last_snapshot_at = 0;
    hub.broadcast_snapshot();
    hub.broadcast_machine_sessions(&["machine-1".to_string()]);
    hub.broadcast_machine_entry(&["machine-1".to_string()]);
    assert!(drain(&mut ui_rx).is_empty());
    hub.on_ui_msg(UI_CONN, json!({"type":"resume"}));
    assert_eq!(types_of(&drain(&mut ui_rx))[0], "snapshot");
}

/// The replica cursor (`fileMtime`) moves on every bookkeeping write. The hub
/// keeps it (replication reads it off the stored inventory) but no viewer is
/// told: nothing a screen draws changed.
#[test]
fn a_moved_replica_cursor_alone_tells_no_viewer_anything() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    hub.store
        .record_machine(
            &json!({"machineId":"machine-1","name":"Machine","os":"linux","agentVersion":"test"}),
            now_ms(),
        )
        .unwrap();
    hub.ui_caps
        .insert(UI_CONN, HashSet::from([CAP_SESSION_PATCH.to_string()]));
    let with_cursor = |cursor: f64| {
        let mut s = session(None);
        s["lastModified"] = json!(1000.0);
        s["fileMtime"] = json!(cursor);
        json!({"type":"inventory","sessions":[s],"complete":true})
    };
    hub.on_agent_msg(AGENT_CONN, with_cursor(1000.0));
    drain(&mut ui_rx);

    hub.on_agent_msg(AGENT_CONN, with_cursor(1500.0));
    settle_coalescing(&mut hub);
    hub.flush_snapshot();
    assert!(drain(&mut ui_rx).is_empty(), "nobody has anything to learn");
    assert!(hub.pending_machines.is_empty(), "and nothing is owed later");
    let stored = hub.agents["machine-1"]
        .sessions
        .iter()
        .find(|s| s["sessionId"] == "session-1")
        .unwrap();
    assert_eq!(
        stored["fileMtime"],
        json!(1500.0),
        "the hub's own copy keeps the replica cursor"
    );

    // A visible change still goes out as a patch carrying the session.
    let mut moved = session(None);
    moved["lastModified"] = json!(2000.0);
    moved["fileMtime"] = json!(2000.0);
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"inventory","sessions":[moved],"complete":true}),
    );
    settle_coalescing(&mut hub);
    hub.flush_snapshot();
    assert!(types_of(&drain(&mut ui_rx)).contains(&"session_updates".to_string()));
}

/// The 15 s context poll repeats itself for an idle run: only a changed tuple
/// is forwarded, and a viewer that attaches later is told the current one.
#[test]
fn context_usage_is_forwarded_on_change_and_replayed_to_a_late_subscriber() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    let reading = |tokens: i64| {
        json!({"type":"context_usage","runId":run_id,"sessionId":"session-1",
               "totalTokens":tokens,"maxTokens":200000,"percentage":1.0,"autoCompactEnabled":true})
    };
    drain(&mut ui_rx);
    hub.on_agent_msg(AGENT_CONN, reading(1000));
    assert_eq!(types_of(&drain(&mut ui_rx)), ["context_usage"]);
    hub.on_agent_msg(AGENT_CONN, reading(1000));
    hub.on_agent_msg(AGENT_CONN, reading(1000));
    assert!(drain(&mut ui_rx).is_empty(), "the same tuple is not news");
    hub.on_agent_msg(AGENT_CONN, reading(2000));
    assert_eq!(types_of(&drain(&mut ui_rx)), ["context_usage"]);

    // A viewer attaching now never sees another repeat, so it is told here.
    hub.on_ui_msg(UI_CONN, json!({"type":"subscribe","runId":run_id}));
    let replay = drain(&mut ui_rx);
    let ctx = replay
        .iter()
        .find(|m| m["type"] == "context_usage")
        .expect("the current budget is replayed");
    assert_eq!(ctx["totalTokens"], json!(2000));
}

/// The agent republishes the whole sub-agent collection on every progress tick;
/// an identical one is not forwarded again, a changed one is.
#[test]
fn an_identical_subagent_collection_is_not_forwarded_again() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    let frame = |status: &str| {
        json!({"type":"stream","runId":run_id,"sessionId":"session-1",
               "event":{"kind":"status","text":"","code":"subagents",
                        "data":{"agents":[{"id":"a1","kind":"Explore","description":"d",
                                           "status":status,"startedAt":1}]}}})
    };
    drain(&mut ui_rx);
    hub.on_agent_msg(AGENT_CONN, frame("running"));
    let first = drain(&mut ui_rx);
    assert!(first.iter().any(|m| m["event"]["code"] == "subagents"));
    hub.on_agent_msg(AGENT_CONN, frame("running"));
    assert!(
        !drain(&mut ui_rx)
            .iter()
            .any(|m| m["event"]["code"] == "subagents"),
        "same collection, same viewers"
    );
    hub.on_agent_msg(AGENT_CONN, frame("completed"));
    assert!(drain(&mut ui_rx)
        .iter()
        .any(|m| m["event"]["code"] == "subagents"));
}

/// The byte budget: a frame at an empty queue always goes (however big) and is
/// charged at most an eighth of the budget, so a huge frame never makes the
/// small ones behind it an overrun; enough frames to pass the budget drop the
/// peer and tell the writer to hang up instead of draining stale state first.
#[test]
fn an_outbound_queue_over_its_byte_budget_drops_a_ui_peer() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    let gate = std::sync::Arc::new(OutGate::default());
    hub.out_gates.insert(UI_CONN, gate.clone());
    drain(&mut ui_rx);

    // One enormous frame, then small ones: nobody is dropped.
    hub.send_raw(UI_CONN, "x".repeat(OUT_BYTES_CAP * 2));
    for _ in 0..10 {
        hub.send_raw(UI_CONN, "y".repeat(1024));
    }
    assert!(
        !gate.is_dropped(),
        "a big frame is not an overrun by itself"
    );

    // A backlog that really exceeds the budget is.
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    let gate = std::sync::Arc::new(OutGate::default());
    hub.out_gates.insert(UI_CONN, gate.clone());
    let frame = "x".repeat(OUT_BYTES_CAP / 8);
    for _ in 0..8 {
        hub.send_raw(UI_CONN, frame.clone());
    }
    assert!(!gate.is_dropped(), "exactly the budget fits");
    hub.send_raw(UI_CONN, frame.clone());
    assert!(
        gate.is_dropped(),
        "the frame past the budget drops the peer"
    );
    assert_eq!(drain_raw(&mut ui_rx).len(), 8, "it was not queued");

    // Big frames are charged an eighth each, but their REAL size is capped
    // too: a backlog of several huge frames is an overrun.
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    let gate = std::sync::Arc::new(OutGate::default());
    hub.out_gates.insert(UI_CONN, gate.clone());
    let huge = "x".repeat(OUT_REAL_BYTES_CAP / 2 + 1);
    hub.send_raw(UI_CONN, huge.clone());
    hub.send_raw(UI_CONN, huge.clone());
    assert!(
        gate.is_dropped(),
        "two half-of-real-cap frames: the second overruns"
    );
    assert_eq!(drain_raw(&mut ui_rx).len(), 1, "the second was not queued");

    // Draining frees the budget again (a healthy peer is never dropped).
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    let gate = std::sync::Arc::new(OutGate::default());
    hub.out_gates.insert(UI_CONN, gate.clone());
    for _ in 0..40 {
        hub.send_raw(UI_CONN, frame.clone());
        while let Ok(sent) = ui_rx.try_recv() {
            gate.drained(sent.len());
        }
    }
    assert!(!gate.is_dropped());
}

fn drain_raw(receiver: &mut Receiver<String>) -> Vec<String> {
    let mut out = Vec::new();
    while let Ok(raw) = receiver.try_recv() {
        out.push(raw);
    }
    out
}

/// The capability names are strings both ends must spell the same: a rename on
/// one side silently turns the feature off (or on) for every client.
#[test]
fn capability_names_match_shared() {
    for (name, value) in [
        ("CAP_STATS_ON_DEMAND", CAP_STATS_ON_DEMAND),
        ("CAP_SESSION_DELTA", CAP_SESSION_DELTA),
        ("CAP_SESSION_PATCH", CAP_SESSION_PATCH),
    ] {
        if name == "CAP_STATS_ON_DEMAND" {
            assert!(
                WEB_PROTOCOL_TS.contains(&format!("export const {name} = '{value}';")),
                "{name} in web-protocol.ts"
            );
        } else {
            // The session caps live in the hello doc comment of shared.
            assert!(
                WEB_PROTOCOL_TS.contains(&format!("`{value}`")),
                "{value} in shared"
            );
        }
    }
}

// ---- support access: the hub's side of a grant --------------------------

const SUPPORT_CONN: ConnId = 7;

/// A hub with a team workspace and a support account signed in over a socket.
/// Returns the hub, the grant id, the support user and the team's workspace.
fn hub_with_support_socket() -> (Hub, String, String, String) {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    let team = hub
        .workspaces
        .create_organization("owner", "Team", "owner")
        .unwrap();
    let wid = team["workspaceId"].as_str().unwrap().to_string();
    let (grant, token) = hub
        .workspaces
        .create_support_grant("owner", &wid, 2, "manager", None)
        .unwrap();
    hub.workspaces.consume_support_login(&token).unwrap();
    let user = grant["supportUserId"].as_str().unwrap().to_string();
    let access = hub.workspaces.ui_access(&user, Some(&wid), false).unwrap();
    let (tx, _rx) = channel(128);
    hub.conns.insert(SUPPORT_CONN, tx);
    hub.ui_clients.insert(SUPPORT_CONN);
    hub.ui_access.insert(SUPPORT_CONN, access);
    (
        hub,
        grant["grantId"].as_str().unwrap().to_string(),
        user,
        wid,
    )
}

fn audit_count(hub: &Hub, action: &str) -> i64 {
    hub.workspaces.with_conn_for_tests(|c| {
        c.query_row(
            "SELECT COUNT(*) FROM audit_events WHERE action=?1",
            [action],
            |r| r.get(0),
        )
        .unwrap()
    })
}

/// Every frame from a support socket is in the owner's log by type and target,
/// whatever the handler then does; the bodies are not.
#[test]
fn a_support_socket_s_frames_are_logged_without_their_bodies() {
    let (mut hub, gid, user, wid) = hub_with_support_socket();
    hub.on_ui_msg(
        SUPPORT_CONN,
        json!({"type":"input","sessionId":"s-1","machineId":"machine-1","text":"the customer's prompt"}),
    );
    hub.on_ui_msg(
        SUPPORT_CONN,
        json!({"type":"term_open","machineId":"machine-1","termId":"t-1","cwd":"/srv/app"}),
    );
    hub.on_ui_msg(
        SUPPORT_CONN,
        json!({"type":"rpc_request","machineId":"machine-1","requestId":"q","method":"files.read","params":{"path":"/srv/app/.env"}}),
    );
    hub.on_ui_msg(SUPPORT_CONN, json!({"type":"ping"}));
    hub.on_ui_msg(SUPPORT_CONN, json!({"type":"term_resize","termId":"t-1"}));
    let log = hub
        .workspaces
        .support_grant_log("owner", &wid, &gid, None)
        .unwrap()
        .0;
    let ui: Vec<&Value> = log.iter().filter(|e| e["action"] == "support.ui").collect();
    assert_eq!(ui.len(), 3, "ping and resize are noise: {log:?}");
    let by_type = |t: &str| ui.iter().find(|e| e["metadata"]["type"] == t).copied();
    assert_eq!(by_type("input").unwrap()["metadata"]["sessionId"], "s-1");
    assert_eq!(
        by_type("rpc_request").unwrap()["metadata"]["path"],
        "/srv/app/.env"
    );
    assert_eq!(
        by_type("rpc_request").unwrap()["metadata"]["method"],
        "files.read"
    );
    assert_eq!(by_type("term_open").unwrap()["metadata"]["cwd"], "/srv/app");
    assert!(log.iter().all(|e| e["actorUserId"] == user.as_str()
        || e["action"].as_str().unwrap().starts_with("support.")));
    assert!(!serde_json::to_string(&log).unwrap().contains("prompt"));
    // The terminal was refused (no share gives this account the machine), and
    // the attempt is in the log all the same.
    assert!(!log.iter().any(|e| e["action"] == "terminal.opened"));
}

/// Keystrokes are one frame each: one row per terminal per window.
#[test]
fn terminal_keystrokes_are_logged_once_per_window() {
    let (mut hub, ..) = hub_with_support_socket();
    for _ in 0..20 {
        hub.on_ui_msg(
            SUPPORT_CONN,
            json!({"type":"term_input","termId":"t-1","data":"ls\r"}),
        );
    }
    hub.on_ui_msg(
        SUPPORT_CONN,
        json!({"type":"term_input","termId":"t-2","data":"ls\r"}),
    );
    assert_eq!(audit_count(&hub, "support.ui"), 2);
}

/// The grant's end is judged on the frame itself: no sweep needed.
#[test]
fn an_expired_grant_drops_the_socket_on_its_next_frame() {
    let (mut hub, gid, _user, _wid) = hub_with_support_socket();
    hub.workspaces
        .set_support_expiry_for_tests(&gid, now_ms() - 1);
    hub.on_ui_msg(
        SUPPORT_CONN,
        json!({"type":"input","sessionId":"s-1","machineId":"machine-1","text":"x"}),
    );
    assert!(!hub.ui_access.contains_key(&SUPPORT_CONN));
    assert!(!hub.conns.contains_key(&SUPPORT_CONN));
    assert_eq!(
        audit_count(&hub, "support.ui"),
        0,
        "a dead grant leaves no trace of acting"
    );
}

/// The sweep tick closes the sockets of a grant that ran out while idle, and
/// a revoke does the same through the same path.
#[test]
fn the_sweep_closes_idle_support_sockets_and_writes_the_expiry() {
    let (mut hub, gid, _user, _wid) = hub_with_support_socket();
    hub.handle(HubCmd::SweepUiPasses);
    assert!(
        hub.ui_access.contains_key(&SUPPORT_CONN),
        "still within the grant"
    );
    hub.workspaces
        .set_support_expiry_for_tests(&gid, now_ms() - 1);
    hub.handle(HubCmd::SweepUiPasses);
    assert!(!hub.ui_access.contains_key(&SUPPORT_CONN));
    assert_eq!(audit_count(&hub, "support.expired"), 1);

    let (mut hub, gid, _user, wid) = hub_with_support_socket();
    hub.workspaces
        .revoke_support_grant("owner", &wid, &gid)
        .unwrap();
    hub.handle(HubCmd::SweepUiPasses);
    assert!(!hub.ui_access.contains_key(&SUPPORT_CONN));
}

/// Nothing changes for a person who is not a support account.
#[test]
fn an_ordinary_viewer_produces_no_support_rows() {
    let (mut hub, _gid, _user, _wid) = hub_with_support_socket();
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"input","sessionId":"s-1","machineId":"machine-1","text":"hello"}),
    );
    hub.on_ui_msg(UI_CONN, json!({"type":"ping"}));
    assert_eq!(audit_count(&hub, "support.ui"), 0);
    assert!(hub.ui_access.contains_key(&UI_CONN));
}

/// The same row again in the window is the same act: one row for twenty
/// identical upload chunks, but a different target is a different row.
#[test]
fn identical_support_frames_inside_the_window_are_one_row() {
    let (mut hub, ..) = hub_with_support_socket();
    for _ in 0..20 {
        hub.on_ui_msg(
            SUPPORT_CONN,
            json!({"type":"rpc_request","machineId":"machine-1","requestId":"q","method":"fs.upload.chunk","params":{"path":"/srv/app/big.bin","uploadId":"u1"}}),
        );
    }
    hub.on_ui_msg(
        SUPPORT_CONN,
        json!({"type":"rpc_request","machineId":"machine-1","requestId":"q2","method":"fs.upload.chunk","params":{"path":"/srv/app/other.bin","uploadId":"u2"}}),
    );
    assert_eq!(audit_count(&hub, "support.ui"), 2);
}

/// If the trace cannot be written the frame does not run.
#[test]
fn a_support_frame_is_not_run_when_its_trace_cannot_be_written() {
    let (mut hub, ..) = hub_with_support_socket();
    hub.workspaces.with_conn_for_tests(|c| {
        c.execute_batch("ALTER TABLE audit_events RENAME TO audit_gone")
            .unwrap();
    });
    let (tx, mut rx) = channel(128);
    hub.conns.insert(SUPPORT_CONN, tx);
    hub.on_ui_msg(
        SUPPORT_CONN,
        json!({"type":"input","sessionId":"s-1","machineId":"machine-1","text":"x"}),
    );
    let got = drain(&mut rx);
    assert!(got.iter().any(|m| m["type"] == "error"), "{got:?}");
    assert!(
        got.iter().all(|m| m["code"] != "run_gone"),
        "the handler never ran"
    );
}

/// A support account gets no pushes about the customer's sessions, and a token
/// that slipped in goes with the grant.
#[test]
fn a_support_account_registers_no_push_device() {
    let (mut hub, gid, _user, wid) = hub_with_support_socket();
    hub.on_ui_msg(
        SUPPORT_CONN,
        json!({"type":"register_push","deviceToken":"abc","platform":"ios"}),
    );
    assert!(hub.push_devices.is_empty());
    hub.push_devices.insert(
        "planted".into(),
        (now_ms(), hub.ui_access[&SUPPORT_CONN].user_id.clone()),
    );
    hub.push_devices
        .insert("owners".into(), (now_ms(), "owner".into()));
    hub.workspaces
        .revoke_support_grant("owner", &wid, &gid)
        .unwrap();
    // What the revoke endpoint sends.
    hub.handle(HubCmd::SweepUiPasses);
    assert!(!hub.push_devices.contains_key("planted"));
    assert!(hub.push_devices.contains_key("owners"));
}

/// «Это был не я»: push tokens a user registered since the pickup go, older
/// ones and other people's stay.
#[test]
fn the_signin_undo_drops_push_tokens_registered_since_the_pickup() {
    let (mut hub, ..) = hub_with_support_socket();
    let t0 = now_ms();
    hub.push_devices
        .insert("old".into(), (t0 - 10_000, "victim".into()));
    hub.push_devices
        .insert("new".into(), (t0 + 5, "victim".into()));
    hub.push_devices
        .insert("theirs".into(), (t0 + 5, "other".into()));
    hub.handle(HubCmd::UndoSignIn {
        user_id: "victim".into(),
        since_ms: t0,
        live_tokens: vec![],
    });
    assert!(hub.push_devices.contains_key("old"));
    assert!(!hub.push_devices.contains_key("new"));
    assert!(hub.push_devices.contains_key("theirs"));
}

/// The short tick closes a socket that only listens, within seconds of the
/// deadline; while no grant is open it does nothing.
#[test]
fn the_support_tick_closes_a_listening_socket_after_the_deadline() {
    let (mut hub, gid, ..) = hub_with_support_socket();
    hub.handle(HubCmd::SweepSupport);
    assert!(hub.ui_access.contains_key(&SUPPORT_CONN));
    hub.workspaces
        .set_support_expiry_for_tests(&gid, now_ms() - 1);
    hub.handle(HubCmd::SweepSupport);
    assert!(!hub.ui_access.contains_key(&SUPPORT_CONN));
}

// ---- Private machine (docs/E2EE.md) -----------------------------------------
// The hub is content-blind for a machine whose agent registered `private:true`:
// it forwards envelopes, stores them, and builds nothing from them.

const PRIVATE_MARK: &str = "SYNTHETIC-MARKER-7f3a";

fn envelope(tag: &str) -> Value {
    // Opaque to the hub: only the outer shape is looked at.
    json!({"e2e":1,"kid":"0011223344556677","n":"bm9uY2U=","c":format!("Y2lwaGVy-{tag}")})
}

fn private_hub() -> (Hub, Receiver<String>, Receiver<String>) {
    let (mut hub, ui_rx, agent_rx) = test_hub(session(None));
    hub.agents.get_mut("machine-1").unwrap().machine["private"] = json!(true);
    (hub, ui_rx, agent_rx)
}

#[test]
fn a_private_machines_stream_is_forwarded_sealed_and_never_becomes_a_preview() {
    let (mut hub, mut ui_rx, mut agent_rx) = private_hub();
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    drain(&mut ui_rx);
    drain(&mut agent_rx);

    for i in 0..3 {
        hub.on_agent_msg(
            AGENT_CONN,
            json!({"type":"stream","runId":run_id,"sessionId":"session-1",
                   "event":{"kind":"partial","e2e":envelope(&format!("p{i}"))}}),
        );
    }
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"stream","runId":run_id,"sessionId":"session-1",
               "event":{"kind":"assistant","e2e":envelope("a")}}),
    );
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"stream","runId":run_id,"sessionId":"session-1","event":{"kind":"result"}}),
    );

    let frames: Vec<Value> = drain(&mut ui_rx)
        .into_iter()
        .filter(|m| m["type"] == "stream")
        .collect();
    assert_eq!(frames.len(), 5);
    assert_eq!(frames[0]["event"]["e2e"], envelope("p0"));
    assert_eq!(frames[3]["event"]["e2e"], envelope("a"));
    let run = hub.runs.get(&run_id).unwrap();
    assert!(
        run.preview.is_none(),
        "no preview is built from sealed text"
    );
    assert!(run.text_buf.is_empty());
    // Not merged: three sealed deltas stay three frames in the replay window.
    assert_eq!(
        run.replay
            .iter()
            .filter(|f| f["event"]["kind"] == "partial")
            .count(),
        0,
        "the idle transition clears the window, nothing was concatenated"
    );
}

#[test]
fn sealed_partials_in_the_replay_window_are_not_merged() {
    let (mut hub, _ui_rx, _agent_rx) = private_hub();
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    for i in 0..3 {
        hub.on_agent_msg(
            AGENT_CONN,
            json!({"type":"stream","runId":run_id,"sessionId":"session-1",
                   "event":{"kind":"partial","e2e":envelope(&format!("p{i}"))}}),
        );
    }
    let run = hub.runs.get(&run_id).unwrap();
    let kept: Vec<&Value> = run
        .replay
        .iter()
        .filter(|f| f["event"]["kind"] == "partial")
        .collect();
    assert_eq!(kept.len(), 3);
    assert_eq!(kept[1]["event"]["e2e"], envelope("p1"));
}

#[test]
fn plaintext_input_to_a_private_machine_is_refused_and_sealed_input_is_forwarded_untouched() {
    let (mut hub, mut ui_rx, mut agent_rx) = private_hub();
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    drain(&mut ui_rx);
    drain(&mut agent_rx);

    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"input","runId":run_id,"text":PRIVATE_MARK}),
    );
    assert!(
        drain(&mut agent_rx).iter().all(|m| m["type"] != "input"),
        "nothing typed in the clear reaches the agent"
    );
    let ui = drain(&mut ui_rx);
    assert!(ui.iter().any(|m| m["code"] == "private_machine"));
    assert!(
        ui.iter().all(|m| m["type"] != "user_turn"),
        "and no screen is shown it"
    );

    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"input","runId":run_id,"text":"","e2e":envelope("in"),"turnE2e":envelope("turn")}),
    );
    let sent: Vec<Value> = drain(&mut agent_rx)
        .into_iter()
        .filter(|m| m["type"] == "input")
        .collect();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["e2e"], envelope("in"));
    assert_eq!(sent[0]["text"], "");
    let turn = drain(&mut ui_rx)
        .into_iter()
        .find(|m| m["type"] == "user_turn")
        .expect("the other screens get the sender's turn envelope");
    assert_eq!(turn["e2e"], envelope("turn"));
    assert_eq!(turn["text"], "");
    assert!(!hub
        .runs
        .get(&run_id)
        .unwrap()
        .replay
        .iter()
        .any(|f| f.to_string().contains(PRIVATE_MARK)));
}

#[test]
fn a_plaintext_tool_answer_to_a_private_machine_is_refused_and_leaves_the_approval_pending() {
    let (mut hub, mut ui_rx, mut agent_rx) = private_hub();
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    hub.runs.get_mut(&run_id).unwrap().pending_request_id = Some("q1".into());
    drain(&mut ui_rx);
    drain(&mut agent_rx);

    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"tool_decision","runId":run_id,"requestId":"q1","allow":true,
               "updatedInput":{"answer":PRIVATE_MARK},"message":PRIVATE_MARK}),
    );
    assert!(drain(&mut agent_rx)
        .iter()
        .all(|m| m["type"] != "tool_decision"));
    assert!(drain(&mut ui_rx)
        .iter()
        .any(|m| m["code"] == "private_machine"));
    assert_eq!(hub.runs[&run_id].pending_request_id.as_deref(), Some("q1"));

    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"tool_decision","runId":run_id,"requestId":"q1","allow":true,"e2e":envelope("ans")}),
    );
    let sent: Vec<Value> = drain(&mut agent_rx)
        .into_iter()
        .filter(|m| m["type"] == "tool_decision")
        .collect();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["e2e"], envelope("ans"));
    assert!(hub.runs[&run_id].pending_request_id.is_none());
}

#[test]
fn a_malformed_envelope_does_not_pass_for_sealed_content() {
    let (mut hub, _ui_rx, mut agent_rx) = private_hub();
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    drain(&mut agent_rx);
    for bad in [
        json!({"e2e":1,"c":null}),
        json!({"e2e":1,"kid":"k","n":"n","c":null}),
        json!({"e2e":1,"kid":"","n":"n","c":"x"}),
        json!({"e2e":1,"kid":"k","n":"n","c":""}),
        json!({"e2e":2,"kid":"k","n":"n","c":"x"}),
    ] {
        hub.on_ui_msg(
            UI_CONN,
            json!({"type":"input","runId":run_id,"text":"","e2e":bad}),
        );
    }
    assert!(
        drain(&mut agent_rx).iter().all(|m| m["type"] != "input"),
        "nothing malformed is forwarded as sealed content"
    );
}

#[test]
fn a_new_session_on_a_private_machine_has_no_title_project_or_provisional_text() {
    let (mut hub, mut ui_rx, mut agent_rx) = private_hub();
    drain(&mut ui_rx);
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"new_session","machineId":"machine-1","cwd":"/work/secret-project",
               "message":PRIVATE_MARK}),
    );
    assert!(drain(&mut agent_rx)
        .iter()
        .all(|m| m["type"] != "new_session"));
    assert!(hub.runs.is_empty());

    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"new_session","machineId":"machine-1","cwd":"/work/secret-project",
               "e2e":envelope("first"),"turnE2e":envelope("turn")}),
    );
    let cmd = drain(&mut agent_rx)
        .into_iter()
        .find(|m| m["type"] == "new_session")
        .expect("sealed first turn starts the session");
    assert_eq!(cmd["e2e"], envelope("first"));
    assert!(cmd.get("message").is_none_or(Value::is_null));
    let run = hub.runs.values().next().unwrap();
    assert!(run.title.is_none(), "no provisional title from content");
    assert!(run.project.is_none());
    assert_eq!(run.state, "working");
}

#[test]
fn a_tool_request_is_sealed_end_to_end_and_replayed_sealed() {
    let (mut hub, mut ui_rx, _agent_rx) = private_hub();
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    drain(&mut ui_rx);
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"tool_request","runId":run_id,"sessionId":"session-1","requestId":"q1",
               "tool":"Bash","input":{},"e2e":envelope("tool")}),
    );
    let first = drain(&mut ui_rx)
        .into_iter()
        .find(|m| m["type"] == "tool_request")
        .unwrap();
    assert_eq!(first["e2e"], envelope("tool"));
    assert_eq!(first["tool"], "Bash");
    // A late subscriber is told the same sealed question.
    hub.on_ui_msg(UI_CONN, json!({"type":"subscribe","runId":run_id}));
    let replay = drain(&mut ui_rx)
        .into_iter()
        .find(|m| m["type"] == "tool_request")
        .expect("the pending question is replayed");
    assert_eq!(replay["e2e"], envelope("tool"));
}

#[test]
fn sealed_history_is_stored_and_served_as_ciphertext_only() {
    let (mut hub, mut ui_rx, _agent_rx) = private_hub();
    drain(&mut ui_rx);
    let sealed_message = json!({"type":"user","uuid":"u1","blocks":[],"e2e":envelope("m1")});
    hub.store
        .record_machine(
            &json!({"machineId":"machine-1","name":"Machine","private":true}),
            1,
        )
        .unwrap();
    hub.store
        .record_inventory(
            "machine-1",
            &[json!({"sessionId":"session-1","source":"claude","title":"Зашифровано","lastModified":1})],
            true,
            1,
        )
        .unwrap();
    hub.store.put_messages_for_test(
        "machine-1",
        "claude",
        "session-1",
        std::slice::from_ref(&sealed_message),
    );
    let mut messages = vec![sealed_message.clone()];
    rpc::trim_tool_payloads(&mut messages, 0);
    assert_eq!(
        messages[0], sealed_message,
        "trim leaves sealed messages alone"
    );
    let raw = hub.store.raw_messages_for_test("machine-1");
    assert_eq!(raw.len(), 1);
    assert!(!raw[0].contains(PRIVATE_MARK));
    assert!(raw[0].contains("\"e2e\""));
}

#[test]
fn the_fleet_api_refuses_a_private_machine() {
    let (mut hub, _ui_rx, _agent_rx) = private_hub();
    let target = FleetTarget::Session {
        machine: "machine-1".into(),
        session_id: "session-1".into(),
    };
    let err = hub
        .fleet_send("owner", &target, "hello", &json!({}), None)
        .expect_err("a dispatcher cannot type into a private machine");
    assert_eq!(err.0, 403);
    assert!(err.1.starts_with("private_machine"));
    let err = hub
        .fleet_status("owner", &target)
        .expect_err("nor read its status");
    assert_eq!(err.0, 403);
    let err = hub
        .fleet_spawn("owner", "machine-1", "/repo", "hello", &json!({}), None)
        .expect_err("nor start work on it");
    assert_eq!(err.0, 403);
}

#[test]
fn becoming_private_purges_the_plaintext_the_hub_already_holds() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    hub.store
        .record_machine(&json!({"machineId":"machine-1","name":"Machine"}), 1)
        .unwrap();
    hub.store
        .record_inventory(
            "machine-1",
            &[json!({"sessionId":"session-1","source":"claude","title":"t","lastModified":1})],
            true,
            1,
        )
        .unwrap();
    hub.store.put_messages_for_test(
        "machine-1",
        "claude",
        "session-1",
        &[json!({"type":"user","uuid":"u1","blocks":[{"kind":"text","text":PRIVATE_MARK}]})],
    );
    assert!(!hub.store.raw_messages_for_test("machine-1").is_empty());

    // The agent re-registers, now private.
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"register","protocol":1,
               "machine":{"machineId":"machine-1","name":"Machine","os":"linux","agentVersion":"t","private":true}}),
    );
    assert!(hub.store.raw_messages_for_test("machine-1").is_empty());
    assert!(hub.machine_private("machine-1"));
}

#[test]
fn becoming_private_clears_live_run_text_and_revokes_project_shares_once() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    hub.store
        .record_machine(&json!({"machineId":"machine-1","name":"Machine"}), 1)
        .unwrap();
    let ws = hub.workspaces.clone();
    let team = ws.create_organization("owner", "Team", "owner").unwrap();
    let wid = team["workspaceId"].as_str().unwrap().to_string();
    ws.share_project("owner", &wid, "machine-1", "/repo", "Repo", "view", "team")
        .unwrap();
    let mut run = test_run(&[UI_CONN]);
    run.title = Some(PRIVATE_MARK.into());
    run.preview = Some(PRIVATE_MARK.into());
    run.text_buf = PRIVATE_MARK.into();
    run.pending_tool_input = Some(json!({"cmd": PRIVATE_MARK}));
    run.background_frame = Some(json!({"data": PRIVATE_MARK}));
    run.subagents_frame = Some(json!({"data": PRIVATE_MARK}));
    run.project = Some(PRIVATE_MARK.into());
    run.cwd = Some(PRIVATE_MARK.into());
    hub.runs.insert("run-1".into(), run);

    let register = json!({"type":"register","protocol":1,
        "machine":{"machineId":"machine-1","name":"Machine","os":"linux","agentVersion":"t","private":true},
        "liveRuns":[{"runId":"run-1","sessionId":"session-1"}]});
    hub.on_agent_msg(AGENT_CONN, register);
    let run = hub
        .runs
        .get("run-1")
        .expect("the declared run survives the register");
    assert!(run.title.is_none() && run.preview.is_none());
    assert!(run.text_buf.is_empty() && run.pending_tool_input.is_none());
    assert!(run.background_frame.is_none() && run.subagents_frame.is_none());
    assert!(run.project.is_none() && run.cwd.is_none());
    let shares: i64 = ws
        .conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT count(*) FROM project_shares WHERE machine_id='machine-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(shares, 0);
}

#[test]
fn going_back_to_not_private_purges_the_sealed_replica_every_time() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    for round in 0..2 {
        hub.store
            .record_machine(
                &json!({"machineId":"machine-1","name":"Machine","private":true}),
                1,
            )
            .unwrap();
        hub.store
            .record_inventory(
                "machine-1",
                &[json!({"sessionId":"session-1","source":"claude","title":"t","lastModified":1})],
                true,
                1,
            )
            .unwrap();
        hub.store.put_messages_for_test(
            "machine-1",
            "claude",
            "session-1",
            &[json!({"type":"user","uuid":"u1","blocks":[],"e2e":envelope("old")})],
        );
        assert!(
            !hub.store.raw_messages_for_test("machine-1").is_empty(),
            "round {round}"
        );
        hub.on_agent_msg(
            AGENT_CONN,
            json!({"type":"register","protocol":1,
                   "machine":{"machineId":"machine-1","name":"Machine","os":"linux","agentVersion":"t"}}),
        );
        assert!(
            hub.store.raw_messages_for_test("machine-1").is_empty(),
            "ciphertext must not outlive the switch (round {round})"
        );
    }
}

#[test]
fn a_private_machine_cannot_be_shared_with_a_team() {
    let (hub, _ui_rx, _agent_rx) = private_hub();
    let ws = hub.workspaces.clone();
    let team = ws.create_organization("owner", "Team", "owner").unwrap();
    let wid = team["workspaceId"].as_str().unwrap().to_string();
    assert!(ws
        .share_project("owner", &wid, "machine-1", "/repo", "Repo", "view", "team")
        .is_ok());
    ws.conn
        .lock()
        .unwrap()
        .execute_batch(crate::replica::SCHEMA)
        .unwrap();
    ws.conn
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO machines(machine_id, machine_json, last_seen) VALUES('machine-1', ?1, 1)",
            [json!({"machineId":"machine-1","private":true}).to_string()],
        )
        .unwrap();
    let err = ws
        .share_project(
            "owner",
            &wid,
            "machine-1",
            "/repo2",
            "Repo2",
            "view",
            "team",
        )
        .unwrap_err();
    assert_eq!(err, crate::workspace::PRIVATE_MACHINE_ERR);
}

#[test]
fn suggestions_are_not_made_for_a_private_machine() {
    let (mut hub, mut ui_rx, _agent_rx) = private_hub();
    drain(&mut ui_rx);
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"enrich_request","requestId":"r1","machineId":"machine-1",
               "sessionId":"session-1","uuid":"u","text":PRIVATE_MARK}),
    );
    let reply = drain(&mut ui_rx)
        .into_iter()
        .find(|m| m["type"] == "enrich_result")
        .unwrap();
    assert_eq!(reply["ok"], false);
    assert_eq!(reply["error"], "private_machine");
}

// ------------------------------------------------------------- watch / smart push

mod watch_push {
    use super::*;
    use crate::notify::Outbound;
    use crate::push_action::{ActionError, Kind, WatchConfig};

    const SECRET: &str = "0123456789abcdef0123456789abcdef-test-secret";

    /// A hub with the watch feature on for "owner" and one open run owned by
    /// them. Returns the run id.
    fn watch_hub() -> (Hub, Receiver<String>, String) {
        let (mut hub, _ui_rx, agent_rx) = test_hub(session(None));
        hub.watch_cfg = Some(WatchConfig {
            secret: Some(SECRET.into()),
            admins: ["owner".to_string()].into_iter().collect(),
        });
        open(&mut hub, false);
        let run_id = hub.runs.keys().next().unwrap().clone();
        hub.runs.get_mut(&run_id).unwrap().owner_user_id = Some("owner".into());
        hub.live_grace_until_ms = 0;
        (hub, agent_rx, run_id)
    }

    fn ask(hub: &mut Hub, run_id: &str, request: &str, tool: &str, input: Value) {
        hub.on_agent_msg(
            AGENT_CONN,
            json!({"type":"tool_request","runId":run_id,"sessionId":"session-1",
                   "requestId":request,"tool":tool,"input":input}),
        );
    }

    fn req(hub: &Hub, run_id: &str, action: &str, kind: Option<Kind>) -> PushActionReq {
        let access = hub.workspaces.ui_access("owner", None, true).unwrap();
        PushActionReq {
            user_id: "owner".into(),
            workspace_id: Some(access.workspace_id),
            admin: true,
            run_id: run_id.into(),
            request_id: Some("req-1".into()),
            token_kind: kind,
            token: None,
            action: action.into(),
            text: None,
            answers: None,
        }
    }

    fn sent_to_agent(rx: &mut Receiver<String>, ty: &str) -> Option<Value> {
        drain(rx).into_iter().find(|m| m["type"] == ty)
    }

    #[test]
    fn a_question_is_answered_with_text_and_the_token_is_single_use() {
        let (mut hub, mut agent_rx, run_id) = watch_hub();
        let questions = json!({"questions":[{"id":"db","question":"Which DB?",
            "options":[{"label":"SQLite"},{"label":"PG"}],"multiSelect":false}]});
        ask(
            &mut hub,
            &run_id,
            "req-1",
            "AskUserQuestion",
            questions.clone(),
        );
        drain(&mut agent_rx);

        let mut r = req(&hub, &run_id, "answer", Some(Kind::Ask));
        r.text = Some("SQLite".into());
        r.token = Some(TokenUse {
            jti: "jti-1".into(),
            exp: now_ms() / 1000 + 600,
        });
        hub.handle_push_action(r.clone()).unwrap();
        let sent =
            sent_to_agent(&mut agent_rx, "tool_decision").expect("decision reaches the agent");
        assert_eq!(sent["requestId"], "req-1");
        assert_eq!(sent["allow"], true);
        assert_eq!(sent["updatedInput"]["answers"], json!({"db": "SQLite"}));
        assert_eq!(sent["updatedInput"]["questions"], questions["questions"]);
        assert_eq!(sent["by"]["userId"], "owner");
        assert!(hub.runs[&run_id].pending_request_id.is_none());

        // The same token again: spent, refused before anything is sent.
        ask(&mut hub, &run_id, "req-1", "AskUserQuestion", questions);
        drain(&mut agent_rx);
        assert_eq!(hub.handle_push_action(r), Err(ActionError::Used));
        assert!(drain(&mut agent_rx)
            .iter()
            .all(|m| m["type"] != "tool_decision"));
    }

    #[test]
    fn several_questions_with_text_become_a_denial_with_the_words() {
        let (mut hub, mut agent_rx, run_id) = watch_hub();
        let qs = json!({"questions":[
            {"question":"A?","options":[]},{"question":"B?","options":[]}]});
        ask(&mut hub, &run_id, "req-1", "AskUserQuestion", qs);
        drain(&mut agent_rx);
        let mut r = req(&hub, &run_id, "answer", None);
        r.text = Some("do neither".into());
        hub.handle_push_action(r).unwrap();
        let sent = sent_to_agent(&mut agent_rx, "tool_decision").unwrap();
        assert_eq!(sent["allow"], false);
        assert_eq!(sent["message"], "do neither");
    }

    #[test]
    fn plan_accept_modes_and_revise_map_to_the_native_choices() {
        for (action, mode) in [
            ("plan_accept", "default"),
            ("plan_accept_edits", "acceptEdits"),
        ] {
            let (mut hub, mut agent_rx, run_id) = watch_hub();
            ask(
                &mut hub,
                &run_id,
                "req-1",
                "ExitPlanMode",
                json!({"plan":"1. go"}),
            );
            drain(&mut agent_rx);
            hub.handle_push_action(req(&hub, &run_id, action, Some(Kind::Plan)))
                .unwrap();
            let sent = sent_to_agent(&mut agent_rx, "tool_decision").unwrap();
            assert_eq!(sent["allow"], true);
            assert_eq!(sent["permissionMode"], mode);
            assert_eq!(sent["updatedInput"], json!({"plan":"1. go"}));
        }
        let (mut hub, mut agent_rx, run_id) = watch_hub();
        ask(
            &mut hub,
            &run_id,
            "req-1",
            "ExitPlanMode",
            json!({"plan":"1. go"}),
        );
        drain(&mut agent_rx);
        let mut r = req(&hub, &run_id, "plan_revise", Some(Kind::Plan));
        r.text = Some("split step 1".into());
        hub.handle_push_action(r).unwrap();
        let sent = sent_to_agent(&mut agent_rx, "tool_decision").unwrap();
        assert_eq!(sent["allow"], false);
        assert_eq!(sent["message"], "split step 1");
    }

    #[test]
    fn a_stale_request_a_gone_run_and_an_offline_machine_are_refused_without_sending() {
        let (mut hub, mut agent_rx, run_id) = watch_hub();
        ask(
            &mut hub,
            &run_id,
            "req-1",
            "ExitPlanMode",
            json!({"plan":"p"}),
        );
        drain(&mut agent_rx);
        let mut stale = req(&hub, &run_id, "plan_accept", Some(Kind::Plan));
        stale.request_id = Some("req-OLD".into());
        assert_eq!(hub.handle_push_action(stale), Err(ActionError::Stale));
        let gone = req(&hub, "no-such-run", "plan_accept", None);
        assert_eq!(hub.handle_push_action(gone), Err(ActionError::RunGone));
        hub.agents.remove("machine-1");
        assert_eq!(
            hub.handle_push_action(req(&hub, &run_id, "plan_accept", None)),
            Err(ActionError::MachineOffline)
        );
        assert!(drain(&mut agent_rx).is_empty());
        assert!(
            hub.runs[&run_id].pending_request_id.is_some(),
            "still pending"
        );
    }

    #[test]
    fn someone_who_cannot_drive_the_run_is_refused() {
        let (mut hub, mut agent_rx, run_id) = watch_hub();
        ask(
            &mut hub,
            &run_id,
            "req-1",
            "ExitPlanMode",
            json!({"plan":"p"}),
        );
        drain(&mut agent_rx);
        hub.workspaces
            .ensure_user("stranger", "s@example.com", Some("S"))
            .unwrap();
        hub.workspaces.activate_access("stranger", "tests").unwrap();
        // Session mode: no workspace of the stranger gives a hand on the machine.
        let mut r = req(&hub, &run_id, "plan_accept", None);
        r.user_id = "stranger".into();
        r.workspace_id = None;
        r.admin = false;
        assert_eq!(hub.handle_push_action(r), Err(ActionError::Forbidden));
        // Token mode with the owner's workspace id: the store falls back to the
        // stranger's own workspace, which is not the one the token names.
        let owner_ws = hub
            .workspaces
            .ui_access("owner", None, false)
            .unwrap()
            .workspace_id;
        let mut r = req(&hub, &run_id, "plan_accept", Some(Kind::Plan));
        r.user_id = "stranger".into();
        r.workspace_id = Some(owner_ws);
        r.admin = false;
        assert_eq!(hub.handle_push_action(r), Err(ActionError::Forbidden));
        // A user the store does not know at all.
        let mut r = req(&hub, &run_id, "plan_accept", None);
        r.user_id = "nobody".into();
        r.workspace_id = None;
        assert_eq!(hub.handle_push_action(r), Err(ActionError::Forbidden));
        assert!(drain(&mut agent_rx).is_empty());
        assert!(hub.runs[&run_id].pending_request_id.is_some());
    }

    #[test]
    fn a_waitlisted_account_cannot_answer() {
        let (mut hub, mut agent_rx, run_id) = watch_hub();
        ask(
            &mut hub,
            &run_id,
            "req-1",
            "ExitPlanMode",
            json!({"plan":"p"}),
        );
        drain(&mut agent_rx);
        // The gate in the hub is `UiAccess::is_active`; a waitlisted access
        // is refused whatever else it holds.
        let mut access = hub.workspaces.ui_access("owner", None, false).unwrap();
        access.access_state = "waitlist".into();
        assert!(!hub.drives_as(&access, &run_id));
    }

    #[test]
    fn a_reply_types_into_the_run_and_is_remembered_for_the_summary() {
        let (mut hub, mut agent_rx, run_id) = watch_hub();
        drain(&mut agent_rx);
        let mut r = req(&hub, &run_id, "reply", Some(Kind::Reply));
        r.request_id = None;
        r.text = Some("  ship it ".into());
        hub.handle_push_action(r).unwrap();
        let sent = sent_to_agent(&mut agent_rx, "input").unwrap();
        assert_eq!(sent["text"], "ship it");
        assert_eq!(sent["runId"], run_id.as_str());
        assert_eq!(hub.runs[&run_id].last_user_text, "ship it");
    }

    #[test]
    fn an_admins_push_carries_the_token_and_a_non_admins_does_not() {
        let (mut hub, _agent_rx, run_id) = watch_hub();
        let (tx, mut rx) = unbounded_channel::<Outbound>();
        hub.notify = Some(tx);
        let questions = json!({"questions":[{"question":"Go?","options":[{"label":"Yes"}]}]});
        ask(
            &mut hub,
            &run_id,
            "req-1",
            "AskUserQuestion",
            questions.clone(),
        );
        let Outbound::Push(ev) = rx.try_recv().expect("a push was emitted") else {
            panic!("expected a push")
        };
        let act = ev
            .content
            .act
            .clone()
            .expect("admin push has an action token");
        let (claims, kind) = crate::push_action::verify(SECRET, &act, now_ms() / 1000).unwrap();
        assert_eq!(kind, Kind::Ask);
        assert_eq!(
            (claims.sub.as_str(), claims.run.as_str()),
            ("owner", run_id.as_str())
        );
        assert_eq!(claims.req.as_deref(), Some("req-1"));
        assert!(claims.ws.len() > 4);
        let payload = crate::push_payload::build_payload(&ev, 4096);
        assert_eq!(payload["aps"]["category"], "HEGAI_ASK");
        assert_eq!(payload["aps"]["alert"]["subtitle"], "Machine");
        assert_eq!(payload["ask"]["questions"][0]["key"], "Go?");
        assert_eq!(payload["act"], act.as_str());

        // Same hub, admin list empty: texts and categories, no token.
        hub.watch_cfg.as_mut().unwrap().admins.clear();
        // The first question was answered; the run moves on to a plan.
        hub.settle_tool_request(&run_id, Some("req-1".into()));
        hub.runs.get_mut(&run_id).unwrap().state = "working".into();
        hub.on_agent_msg(
            AGENT_CONN,
            json!({"type":"tool_request","runId":run_id,"sessionId":"session-1",
                   "requestId":"req-2","tool":"ExitPlanMode","input":{"plan":"Do it"},"replay":false}),
        );
        let Outbound::Push(ev) = rx.try_recv().expect("second push") else {
            panic!("expected a push")
        };
        assert!(ev.content.act.is_none());
        let payload = crate::push_payload::build_payload(&ev, 4096);
        assert_eq!(payload["aps"]["category"], "HEGAI_PLAN");
        assert!(payload.get("act").is_none());
    }

    #[test]
    fn the_inbox_orders_waiting_error_working_idle_newest_first() {
        let (mut hub, _agent_rx, run_id) = watch_hub();
        hub.runs.remove(&run_id);
        let mut add = |id: &str, state: &str, since: i64| {
            let mut r = test_run(&[]);
            r.owner_user_id = Some("owner".into());
            r.state = state.into();
            r.since = since;
            r.title = Some(format!("T-{id}"));
            hub.runs.insert(id.into(), r);
        };
        add("idle-new", "idle", 90);
        add("work-old", "working", 10);
        add("err", "error", 50);
        add("wait-old", "needs_attention", 20);
        add("work-new", "working", 70);
        add("wait-new", "needs_attention", 60);
        // Someone else's run never appears.
        let mut foreign = test_run(&[]);
        foreign.owner_user_id = Some("teammate".into());
        hub.runs.insert("foreign".into(), foreign);
        {
            let r = hub.runs.get_mut("wait-new").unwrap();
            r.pending_request_id = Some("req-9".into());
            r.pending_tool = Some("AskUserQuestion".into());
            r.pending_tool_input = Some(json!({"questions":[{"id":"k","question":"Q?",
                "options":[{"label":"A"}],"multiSelect":true}]}));
            r.text_buf = "**done** so far".into();
        }
        {
            let r = hub.runs.get_mut("wait-old").unwrap();
            r.pending_request_id = Some("req-8".into());
            r.pending_tool = Some("ExitPlanMode".into());
            r.pending_tool_input = Some(json!({"plan":"# План\n\n- шаг"}));
        }
        let inbox = hub.handle_watch_inbox("owner");
        assert_eq!(
            (inbox["waiting"].as_u64(), inbox["working"].as_u64()),
            (Some(2), Some(2))
        );
        let ids: Vec<&str> = inbox["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["runId"].as_str().unwrap())
            .collect();
        assert_eq!(
            ids,
            ["wait-new", "wait-old", "err", "work-new", "work-old", "idle-new"]
        );
        let first = &inbox["items"][0];
        assert_eq!(first["requestId"], "req-9");
        assert_eq!(first["tool"], "AskUserQuestion");
        assert_eq!(first["title"], "T-wait-new");
        assert_eq!(first["machine"], "Machine");
        assert_eq!(first["sinceMs"], 60);
        assert_eq!(
            first["questions"],
            json!([{"key":"k","question":"Q?","options":["A"],"multiSelect":true}])
        );
        assert_eq!(first["lastText"], "done so far");
        assert_eq!(inbox["items"][1]["plan"], "План\n\nшаг");
        // Optional keys are absent, never null.
        assert!(!inbox.to_string().contains("null"));
        assert!(inbox["items"][2].get("requestId").is_none());
    }

    #[test]
    fn plan_progress_steps_are_parsed_clipped_and_wake_the_live_activity_only_on_counts() {
        let (mut hub, _rx, run_id) = watch_hub();
        let send = |hub: &mut Hub, data: Value| {
            hub.on_agent_msg(
                AGENT_CONN,
                json!({"type":"stream","runId":run_id,"sessionId":"session-1",
                       "event":{"kind":"status","text":"","code":"plan_progress","data":data}}),
            );
        };
        hub.live_dirty.set(false);
        let steps: Vec<Value> = (0..15)
            .map(|i| {
                json!({"text": if i == 0 { "я".repeat(120) } else { format!("s{i}") },
                            "status": if i == 1 { "weird" } else { "completed" }})
            })
            .collect();
        send(
            &mut hub,
            json!({"done":2,"total":15,"active":"я".repeat(300),"steps":steps}),
        );
        let plan = hub.runs[&run_id].plan.clone().unwrap();
        assert_eq!((plan.done, plan.total), (2, 15));
        assert_eq!(plan.active.as_ref().unwrap().chars().count(), 160);
        assert_eq!(plan.steps.len(), 12);
        assert_eq!(plan.steps[0].0.chars().count(), 80);
        assert_eq!(plan.steps[1], ("s1".to_string(), "pending".to_string()));
        assert_eq!(plan.steps[2].1, "completed");
        assert!(hub.live_dirty.get());
        // Same counts, new text: the Live Activity is not woken.
        hub.live_dirty.set(false);
        send(&mut hub, json!({"done":2,"total":15,"active":"другое"}));
        assert_eq!(
            hub.runs[&run_id].plan.as_ref().unwrap().active.as_deref(),
            Some("другое")
        );
        assert!(hub.runs[&run_id].plan.as_ref().unwrap().steps.is_empty());
        assert!(!hub.live_dirty.get());
        // Counts only (an older agent), then a count change.
        send(&mut hub, json!({"done":3,"total":15}));
        assert!(hub.live_dirty.get());
        assert_eq!(hub.runs[&run_id].plan.as_ref().unwrap().active, None);
        // 0/0 clears.
        send(&mut hub, json!({"done":0,"total":0}));
        assert!(hub.runs[&run_id].plan.is_none());
    }

    #[test]
    fn the_inbox_item_carries_progress_context_and_background_unless_private() {
        let (mut hub, _rx, run_id) = watch_hub();
        {
            let r = hub.runs.get_mut(&run_id).unwrap();
            r.state = "working".into();
            r.task_started_at = Some(5000);
            r.plan = Some(PlanState {
                done: 1,
                total: 3,
                active: Some("Делаю".into()),
                steps: vec![
                    ("a".into(), "completed".into()),
                    ("b".into(), "in_progress".into()),
                ],
            });
            r.context_frame = Some(json!({"type":"context_usage","percentage":61.6}));
            r.background_frame = Some(json!({"type":"stream","event":{"kind":"status",
                "code":"background_tasks","data":{"tasks":[{"id":"1"},{"id":"2"}]}}}));
        }
        let inbox = hub.handle_watch_inbox("owner");
        let item = &inbox["items"][0];
        assert_eq!(
            item["progress"],
            json!({"done":1,"total":3,"active":"Делаю",
                   "steps":[{"text":"a","status":"completed"},{"text":"b","status":"in_progress"}]})
        );
        assert_eq!(item["startedMs"], 5000);
        assert_eq!(item["contextPct"], 62);
        assert_eq!(item["background"], 2);
        assert!(!inbox.to_string().contains("null"));
        // Counts only: no active / steps keys.
        hub.runs.get_mut(&run_id).unwrap().plan = Some(PlanState {
            done: 1,
            total: 3,
            ..Default::default()
        });
        let inbox = hub.handle_watch_inbox("owner");
        assert_eq!(inbox["items"][0]["progress"], json!({"done":1,"total":3}));
        // A private machine: the hub cannot read any of it.
        hub.agents.get_mut("machine-1").unwrap().machine["private"] = json!(true);
        let inbox = hub.handle_watch_inbox("owner");
        let item = &inbox["items"][0];
        for key in [
            "progress",
            "startedMs",
            "contextPct",
            "background",
            "summary",
        ] {
            assert!(item.get(key).is_none(), "{key} leaked");
        }
    }

    fn digest(since: i64, made_ms: i64) -> WatchDigest {
        WatchDigest {
            summary: "Итог хода".into(),
            replies: vec![crate::push_payload::Reply {
                label: "Да".into(),
                send: "делай".into(),
            }],
            since,
            made_ms,
        }
    }

    #[test]
    fn a_live_idle_run_shows_its_digest_only_for_the_same_since_and_an_admin() {
        let (mut hub, _rx, run_id) = watch_hub();
        {
            let r = hub.runs.get_mut(&run_id).unwrap();
            r.state = "idle".into();
            r.since = 1000;
        }
        let key = "machine-1::session-1".to_string();
        hub.watch_digests.insert(key.clone(), digest(1000, 1));
        let inbox = hub.handle_watch_inbox("owner");
        assert_eq!(inbox["items"][0]["summary"], "Итог хода");
        assert_eq!(
            inbox["items"][0]["replies"],
            json!([{"label":"Да","send":"делай"}])
        );
        // No replies: the key is omitted.
        hub.watch_digests.get_mut(&key).unwrap().replies.clear();
        assert!(hub.handle_watch_inbox("owner")["items"][0]
            .get("replies")
            .is_none());
        // The run moved on.
        hub.runs.get_mut(&run_id).unwrap().since = 2000;
        assert!(hub.handle_watch_inbox("owner")["items"][0]
            .get("summary")
            .is_none());
        // Same since but the caller is not an admin.
        hub.runs.get_mut(&run_id).unwrap().since = 1000;
        hub.watch_cfg = Some(WatchConfig {
            secret: Some(SECRET.into()),
            admins: HashSet::new(),
        });
        assert!(hub.handle_watch_inbox("owner")["items"][0]
            .get("summary")
            .is_none());
    }

    #[test]
    fn digests_go_with_the_sessions_they_describe() {
        let (mut hub, _rx, run_id) = watch_hub();
        // A private machine's request is not offered: every action on it is refused.
        {
            let r = hub.runs.get_mut(&run_id).unwrap();
            r.state = "needs_attention".into();
            r.pending_request_id = Some("req-1".into());
            r.pending_tool = Some("Bash".into());
        }
        assert_eq!(
            hub.handle_watch_inbox("owner")["items"][0]["requestId"],
            "req-1"
        );
        hub.agents.get_mut("machine-1").unwrap().machine["private"] = json!(true);
        let inbox = hub.handle_watch_inbox("owner");
        assert!(inbox["items"][0].get("requestId").is_none());
        assert_eq!(inbox["items"][0]["tool"], "Bash");
        hub.agents.get_mut("machine-1").unwrap().machine["private"] = json!(false);
        {
            let r = hub.runs.get_mut(&run_id).unwrap();
            r.state = "idle".into();
            r.since = now_ms();
        }
        // No gateway configured: no summary can come, so the watch is not
        // told to wait for one.
        assert!(hub.handle_watch_inbox("owner")["items"][0]
            .get("digestPending")
            .is_none());
        let key = "machine-1::session-1".to_string();
        let other = "machine-2::session-9".to_string();
        hub.watch_digests.insert(key.clone(), digest(1, 1));
        hub.watch_digests.insert(other.clone(), digest(1, 1));
        // Retention / private purge path.
        hub.forget_enrichment("machine-1", &[("claude".into(), "session-1".into())]);
        assert!(!hub.watch_digests.contains_key(&key));
        assert!(hub.watch_digests.contains_key(&other));
        // Account deletion / erasure path.
        hub.clear_enrichment_cache();
        assert!(hub.watch_digests.is_empty());
        // A new turn through the hub spends the digest, whatever the
        // agent's clock says about `lastModified`.
        hub.watch_digests.insert(key.clone(), digest(1, 1));
        hub.run_working(&run_id);
        assert!(!hub.watch_digests.contains_key(&key));
        // So does a human turn the hub routed, before the agent says working.
        hub.watch_digests.insert(key.clone(), digest(1, 1));
        hub.note_user_text(&run_id, "дальше");
        assert!(!hub.watch_digests.contains_key(&key));
    }

    #[test]
    fn a_recent_session_shows_its_digest_until_it_changes_again() {
        let (mut hub, _rx) = quiet_hub(vec![recent("session-1", 5000)]);
        let key = "machine-1::session-1".to_string();
        let at = hub.agents["machine-1"].sessions[0]["lastModified"]
            .as_f64()
            .unwrap() as i64;
        hub.watch_digests.insert(key.clone(), digest(1, at + 10));
        let inbox = hub.handle_watch_inbox("owner");
        assert_eq!(inbox["items"][0]["summary"], "Итог хода");
        // The session changed after the digest.
        hub.watch_digests.get_mut(&key).unwrap().made_ms = at - 1;
        assert!(hub.handle_watch_inbox("owner")["items"][0]
            .get("summary")
            .is_none());
        // Private machine and non-admin never.
        hub.watch_digests.get_mut(&key).unwrap().made_ms = at + 10;
        hub.agents.get_mut("machine-1").unwrap().machine["private"] = json!(true);
        assert!(hub.handle_watch_inbox("owner")["items"][0]
            .get("summary")
            .is_none());
        hub.agents.get_mut("machine-1").unwrap().machine["private"] = json!(false);
        hub.watch_cfg = Some(WatchConfig {
            secret: Some(SECRET.into()),
            admins: HashSet::new(),
        });
        assert!(hub.handle_watch_inbox("owner")["items"][0]
            .get("summary")
            .is_none());
    }

    #[test]
    fn push_summary_ready_remembers_the_digest_after_its_gates_and_caps_the_map() {
        let (mut hub, _rx, run_id) = watch_hub();
        {
            let r = hub.runs.get_mut(&run_id).unwrap();
            r.state = "idle".into();
            r.since = 1000;
        }
        let mk = |hub: &Hub| crate::notify::PushEvent {
            run_id: run_id.clone(),
            title: "t".into(),
            machine: "m".into(),
            machine_id: "machine-1".into(),
            session_id: "session-1".into(),
            state: "idle".into(),
            request_id: None,
            tool: None,
            device_tokens: vec![],
            owner_user_id: Some("owner".into()),
            workspace_id: None,
            content: hub.push_content(
                &run_id,
                &hub.runs[&run_id],
                "idle",
                Some("owner"),
                None,
                false,
                false,
            ),
        };
        // No summary: nothing remembered. Stale since: nothing remembered.
        hub.push_summary_ready(mk(&hub), 1000, None, vec![]);
        hub.push_summary_ready(mk(&hub), 999, Some("старый".into()), vec![]);
        assert!(hub.watch_digests.is_empty());
        hub.push_summary_ready(mk(&hub), 1000, Some("Итог".into()), vec![]);
        let d = &hub.watch_digests["machine-1::session-1"];
        assert_eq!((d.summary.as_str(), d.since), ("Итог", 1000));
        // Cap: the smallest made_ms leaves.
        for i in 0..210 {
            hub.remember_digest(format!("m::s{i}"), digest(1, 10 + i));
        }
        assert_eq!(hub.watch_digests.len(), 200);
        assert!(!hub.watch_digests.contains_key("m::s0"));
        assert!(hub.watch_digests.contains_key("m::s209"));
    }

    /// The watch hub with no run at all and the machine's inventory replaced.
    fn quiet_hub(sessions: Vec<Value>) -> (Hub, Receiver<String>) {
        let (mut hub, agent_rx, _run_id) = watch_hub();
        hub.runs.clear();
        hub.lock_by_key.clear();
        hub.agents.get_mut("machine-1").unwrap().sessions = sessions;
        (hub, agent_rx)
    }

    fn recent(id: &str, age_ms: i64) -> Value {
        json!({"sessionId": id, "title": format!("T-{id}"), "cwd": "/repo",
               "lastModified": (now_ms() - age_ms) as f64})
    }

    fn inbox_ids(hub: &mut Hub) -> Vec<String> {
        hub.handle_watch_inbox("owner")["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["sessionId"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn the_inbox_lists_recent_sessions_without_a_run_newest_first() {
        const H: i64 = 3_600_000;
        let mut codex = recent("codex-new", H / 2);
        codex["source"] = json!("codex");
        let mut automated = recent("auto", H);
        automated["origin"] = json!("fleet");
        let (mut hub, _rx) = quiet_hub(vec![
            recent("a-1h", H),
            codex,
            recent("old", 72 * H),
            recent("erased", H),
            recent("theirs", H),
            recent("auto", H),
            recent("live", H),
            json!({"sessionId":"nostamp","title":"x","cwd":"/repo"}),
        ]);
        hub.erased_sessions
            .as_mut()
            .unwrap()
            .insert("machine-1::erased".into());
        hub.session_meta.insert(
            "machine-1::theirs".into(),
            SessionMeta {
                owner_user_id: "teammate".into(),
                category: None,
                stage: None,
                origin: None,
            },
        );
        hub.session_meta.insert(
            "machine-1::auto".into(),
            SessionMeta {
                owner_user_id: "owner".into(),
                category: None,
                stage: None,
                origin: Some("fleet".into()),
            },
        );
        let mut r = test_run(&[]);
        r.owner_user_id = Some("owner".into());
        r.session_id = "live".into();
        r.state = "working".into();
        hub.runs.insert("run-live".into(), r);
        let inbox = hub.handle_watch_inbox("owner");
        let items = inbox["items"].as_array().unwrap();
        let ids: Vec<&str> = items
            .iter()
            .map(|i| i["sessionId"].as_str().unwrap())
            .collect();
        // The live run first, then recent sessions newest first.
        assert_eq!(ids, ["live", "codex-new", "a-1h"]);
        assert!(items[0].get("runId").is_some());
        assert!(items[1].get("runId").is_none());
        assert_eq!(items[1]["source"], "codex");
        assert_eq!(items[2]["source"], "claude");
        assert_eq!(items[2]["title"], "T-a-1h");
        assert_eq!(items[2]["machine"], "Machine");
        assert_eq!(items[2]["machineId"], "machine-1");
        assert_eq!(items[2]["state"], "idle");
        assert!(items[2]["lastModifiedMs"].as_i64().unwrap() > 0);
        assert!(items[2].get("sinceMs").is_none());
        assert_eq!(inbox["working"], 1);
        // Someone who is not the device owner sees none of them.
        assert!(hub.handle_watch_inbox("teammate")["items"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(!inbox.to_string().contains("null"));
    }

    #[test]
    fn an_ownerless_run_on_the_callers_device_is_listed_once() {
        let (mut hub, _rx) = quiet_hub(vec![recent("live", 3_600_000), recent("other", 3_600_000)]);
        let mut r = test_run(&[]);
        r.owner_user_id = None;
        r.session_id = "live".into();
        r.state = "working".into();
        hub.runs.insert("run-live".into(), r);
        let inbox = hub.handle_watch_inbox("owner");
        let items = inbox["items"].as_array().unwrap();
        let live: Vec<_> = items.iter().filter(|i| i["sessionId"] == "live").collect();
        assert_eq!(live.len(), 1);
        assert_eq!(live[0]["runId"], "run-live");
        assert_eq!(inbox["working"], 1);
        assert!(items.iter().any(|i| i["sessionId"] == "other"));
    }

    #[test]
    fn someone_elses_run_is_not_the_callers() {
        assert!(super::watch::is_callers("owner", None, Some("owner")));
        assert!(super::watch::is_callers("owner", Some("owner"), None));
        assert!(!super::watch::is_callers("teammate", None, Some("owner")));
        assert!(!super::watch::is_callers(
            "owner",
            Some("teammate"),
            Some("owner")
        ));
        let (mut hub, _rx) = quiet_hub(vec![]);
        let mut r = test_run(&[]);
        r.owner_user_id = Some("teammate".into());
        r.state = "working".into();
        hub.runs.insert("run-t".into(), r);
        assert!(hub.handle_watch_inbox("owner")["items"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn a_private_machines_recent_session_is_named_by_the_machine() {
        let (mut hub, _rx) = quiet_hub(vec![recent("p", 1000)]);
        hub.agents.get_mut("machine-1").unwrap().machine["private"] = json!(true);
        let inbox = hub.handle_watch_inbox("owner");
        assert_eq!(inbox["items"][0]["title"], "Machine");
    }

    #[test]
    fn the_whole_inbox_is_capped_and_runs_stay_first() {
        let sessions = (0..60)
            .map(|i| recent(&format!("s{i}"), 1000 + i))
            .collect();
        let (mut hub, _rx) = quiet_hub(sessions);
        let mut r = test_run(&[]);
        r.owner_user_id = Some("owner".into());
        r.session_id = "running".into();
        hub.runs.insert("run-1".into(), r);
        let ids = inbox_ids(&mut hub);
        assert_eq!(ids.len(), 40);
        assert_eq!(ids[0], "running");
        assert_eq!(ids[1], "s0");
    }

    fn seed_history(hub: &Hub, source: &str, n: usize) {
        hub.store
            .set_state_for_test("machine-1", source, "session-1", 1, 1.0);
        let rows: Vec<Value> = (0..n)
            .map(|i| {
                json!({"type": if i % 2 == 0 {"user"} else {"assistant"}, "uuid": format!("u{i}"),
                       "blocks":[{"kind":"text","text":format!("m{i}")}]})
            })
            .collect();
        hub.store
            .put_messages_for_test("machine-1", source, "session-1", &rows);
    }

    #[test]
    fn history_is_simplified_limited_and_says_when_there_is_more() {
        let (mut hub, _rx) = quiet_hub(vec![session(None)]);
        seed_history(&hub, "claude", 30);
        let out = hub
            .handle_watch_history("owner", "machine-1", "session-1", None, 5)
            .unwrap();
        let texts: Vec<&str> = out["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["text"].as_str().unwrap())
            .collect();
        assert_eq!(texts, ["m25", "m26", "m27", "m28", "m29"]);
        assert_eq!(out["items"][4]["role"], "assistant");
        assert_eq!(out["more"], true);
        let all = hub
            .handle_watch_history("owner", "machine-1", "session-1", Some("claude"), 40)
            .unwrap();
        assert_eq!(all["items"].as_array().unwrap().len(), 30);
        assert_eq!(all["more"], false);
        // A Codex transcript is found when no source is given.
        seed_history(&hub, "codex", 2);
        hub.store.put_messages_for_test(
            "machine-1",
            "codex",
            "session-1",
            &[json!({"type":"user","uuid":"c","blocks":[{"kind":"text","text":"codex"}]})],
        );
        let codex = hub
            .handle_watch_history("owner", "machine-1", "session-1", Some("codex"), 40)
            .unwrap();
        assert_eq!(codex["items"][0]["text"], "codex");
    }

    #[test]
    fn history_is_refused_where_the_web_would_refuse_it() {
        let (mut hub, _rx) = quiet_hub(vec![session(None)]);
        seed_history(&hub, "claude", 3);
        let ask = |hub: &mut Hub, user: &str, session: &str| {
            hub.handle_watch_history(user, "machine-1", session, None, 10)
                .unwrap_err()
        };
        // Not found in the replica.
        assert_eq!(ask(&mut hub, "owner", "nope"), (404, "not_found"));
        // A person with no hand on the machine.
        assert_eq!(ask(&mut hub, "nobody", "session-1"), (403, "forbidden"));
        // Erased.
        hub.erased_sessions
            .as_mut()
            .unwrap()
            .insert("machine-1::session-1".into());
        assert_eq!(ask(&mut hub, "owner", "session-1"), (403, "forbidden"));
        hub.erased_sessions.as_mut().unwrap().clear();
        // Private machine.
        hub.agents.get_mut("machine-1").unwrap().machine["private"] = json!(true);
        assert_eq!(
            ask(&mut hub, "owner", "session-1"),
            (403, "private_machine")
        );
    }

    #[test]
    fn a_reply_without_a_run_resumes_the_session_and_respects_the_writer_lock() {
        let (mut hub, mut agent_rx) = quiet_hub(vec![session(None)]);
        drain(&mut agent_rx);
        hub.handle_watch_session_reply(
            "owner",
            "machine-1",
            "session-1",
            Some("claude"),
            Some(" go on "),
        )
        .unwrap();
        let sent = drain(&mut agent_rx);
        let resume = sent.iter().find(|m| m["type"] == "resume").expect("resume");
        assert_eq!(resume["sessionId"], "session-1");
        let input = sent.iter().find(|m| m["type"] == "input").expect("input");
        assert_eq!(input["text"], "go on");
        let run_id = hub.lock_by_key["machine-1::session-1"].clone();
        // No in-memory stamp; the run is still the device owner's, listed once.
        assert_eq!(hub.runs[&run_id].owner_user_id, None);
        assert_eq!(inbox_ids(&mut hub), ["session-1"]);
        // The run is live now: the next reply is a plain input to it.
        hub.handle_watch_session_reply("owner", "machine-1", "session-1", None, Some("more"))
            .unwrap();
        let sent = drain(&mut agent_rx);
        assert!(sent.iter().all(|m| m["type"] != "resume"));
        assert_eq!(
            sent.iter().find(|m| m["type"] == "input").unwrap()["runId"],
            run_id.as_str()
        );
    }

    #[test]
    fn a_reply_without_a_run_is_refused_for_a_foreign_writer_a_stranger_and_an_absent_machine() {
        // Another process (an editor) holds the session.
        let (mut hub, mut agent_rx) = quiet_hub(vec![session(Some(4242))]);
        drain(&mut agent_rx);
        assert_eq!(
            hub.handle_watch_session_reply("owner", "machine-1", "session-1", None, Some("hi")),
            Err(ActionError::Busy)
        );
        assert!(drain(&mut agent_rx).is_empty());
        assert!(hub.runs.is_empty() && hub.lock_by_key.is_empty());
        // Not the owner.
        let (mut hub, _rx) = quiet_hub(vec![session(None)]);
        assert_eq!(
            hub.handle_watch_session_reply("nobody", "machine-1", "session-1", None, Some("hi")),
            Err(ActionError::Forbidden)
        );
        // No text, wrong source, unknown session.
        assert_eq!(
            hub.handle_watch_session_reply("owner", "machine-1", "session-1", None, Some("  ")),
            Err(ActionError::BadRequest("text_required"))
        );
        assert_eq!(
            hub.handle_watch_session_reply(
                "owner",
                "machine-1",
                "session-1",
                Some("codex"),
                Some("x")
            ),
            Err(ActionError::BadRequest("source_mismatch"))
        );
        assert_eq!(
            hub.handle_watch_session_reply("owner", "machine-1", "ghost", None, Some("x")),
            Err(ActionError::SessionGone)
        );
        // The machine has gone.
        hub.agents.remove("machine-1");
        assert_eq!(
            hub.handle_watch_session_reply("owner", "machine-1", "session-1", None, Some("x")),
            Err(ActionError::MachineOffline)
        );
    }

    #[test]
    fn live_tokens_persist_and_a_busy_fleet_starts_one_activity() {
        let (mut hub, _agent_rx, run_id) = watch_hub();
        let (tx, mut rx) = unbounded_channel::<Outbound>();
        hub.notify = Some(tx);
        hub.handle_live_activity(
            "owner",
            LiveOp::Start {
                token: "aabb".into(),
            },
        )
        .unwrap();
        assert_eq!(hub.workspaces.live_tokens_all().unwrap().len(), 1);
        hub.runs.get_mut(&run_id).unwrap().state = "working".into();
        hub.live_tick();
        assert!(
            rx.try_recv().is_err(),
            "debounce: nothing in the first instant"
        );
        hub.live.age_changes(5_000);
        hub.live_tick();
        let Outbound::Live(push) = rx.try_recv().expect("start push") else {
            panic!("expected a live push")
        };
        assert_eq!(push.tokens, vec!["aabb".to_string()]);
        assert_eq!(push.priority, 10);
        assert_eq!(push.body["aps"]["event"], "start");
        assert_eq!(push.body["aps"]["content-state"]["working"], 1);
        // The app reports its activity; the fleet goes quiet; it is ended.
        hub.handle_live_activity(
            "owner",
            LiveOp::Activity {
                id: "act-1".into(),
                token: "ccdd".into(),
            },
        )
        .unwrap();
        hub.runs.get_mut(&run_id).unwrap().state = "idle".into();
        hub.broadcast_activity();
        hub.live_tick();
        hub.live.age_changes(5_000);
        hub.live_tick();
        let Outbound::Live(push) = rx.try_recv().expect("end push") else {
            panic!("expected a live push")
        };
        assert_eq!(push.tokens, vec!["ccdd".to_string()]);
        assert_eq!(push.body["aps"]["event"], "end");
        assert!(rx.try_recv().is_err());
        // Not confirmed yet: the only token able to end it is still stored.
        assert_eq!(hub.workspaces.live_tokens_all().unwrap().len(), 2);
        hub.live_sent(
            "owner",
            push.kind,
            &[("ccdd".to_string(), crate::live_activity::LiveOutcome::Ok)],
        );
        // Confirmed: the ended activity's token is gone, the start token stays.
        let rows = hub.workspaces.live_tokens_all().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].token, "aabb");
    }

    #[test]
    fn a_spent_token_stays_spent_in_the_store_not_just_in_memory() {
        let (mut hub, mut agent_rx, run_id) = watch_hub();
        let q = json!({"questions":[{"question":"A?","options":[]}]});
        ask(&mut hub, &run_id, "req-1", "AskUserQuestion", q.clone());
        drain(&mut agent_rx);
        let mut r = req(&hub, &run_id, "answer", Some(Kind::Ask));
        r.text = Some("yes".into());
        r.token = Some(TokenUse {
            jti: "jti-persist".into(),
            exp: now_ms() / 1000 + 600,
        });
        hub.handle_push_action(r.clone()).unwrap();
        assert!(hub.workspaces.jti_is_spent("jti-persist").unwrap());
        ask(&mut hub, &run_id, "req-1", "AskUserQuestion", q);
        assert_eq!(hub.handle_push_action(r), Err(ActionError::Used));
    }

    #[test]
    fn a_pending_start_survives_a_hub_restart_and_goes_when_a_token_comes_back() {
        let (mut hub, _agent_rx, run_id) = watch_hub();
        let (tx, mut rx) = unbounded_channel::<Outbound>();
        hub.notify = Some(tx);
        hub.handle_live_activity(
            "owner",
            LiveOp::Start {
                token: "aabb".into(),
            },
        )
        .unwrap();
        hub.runs.get_mut(&run_id).unwrap().state = "working".into();
        hub.live_tick();
        hub.live.age_changes(5_000);
        hub.live_tick();
        let Outbound::Live(push) = rx.try_recv().expect("start push") else {
            panic!("expected a live push")
        };
        assert_eq!(push.body["aps"]["input-push-token"], 1);
        let stored = hub.workspaces.live_pending_starts_all().unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].0, "owner");
        // What a restart rebuilds the registry from.
        let reborn = crate::live_activity::LiveRegistry::from_store(&hub.workspaces);
        assert_eq!(reborn.unconfirmed_start("owner"), Some(stored[0].1));
        // The app finally reports its activity.
        hub.handle_live_activity(
            "owner",
            LiveOp::Activity {
                id: "a1".into(),
                token: "ccdd".into(),
            },
        )
        .unwrap();
        assert!(hub.workspaces.live_pending_starts_all().unwrap().is_empty());
    }

    #[test]
    fn a_start_with_no_notifier_to_carry_it_leaves_no_hold_behind() {
        let (mut hub, _agent_rx, run_id) = watch_hub();
        hub.notify = None;
        hub.handle_live_activity(
            "owner",
            LiveOp::Start {
                token: "aabb".into(),
            },
        )
        .unwrap();
        hub.runs.get_mut(&run_id).unwrap().state = "working".into();
        hub.live_tick();
        hub.live.age_changes(5_000);
        hub.live_tick();
        assert_eq!(hub.live.unconfirmed_start("owner"), None);
        assert!(hub.workspaces.live_pending_starts_all().unwrap().is_empty());
    }

    #[test]
    fn nothing_goes_to_the_live_activity_during_the_start_grace_then_it_evaluates() {
        let (mut hub, _agent_rx, run_id) = watch_hub();
        let (tx, mut rx) = unbounded_channel::<Outbound>();
        hub.notify = Some(tx);
        hub.live_grace_until_ms = now_ms() + 60_000;
        hub.handle_live_activity(
            "owner",
            LiveOp::Activity {
                id: "a".into(),
                token: "ccdd".into(),
            },
        )
        .unwrap();
        // A fresh hub: runs have not re-registered, the fleet looks idle.
        hub.runs.remove(&run_id);
        hub.live_tick();
        hub.live.age_changes(5_000);
        hub.live_tick();
        assert!(rx.try_recv().is_err(), "no `end` inside the grace");
        assert_eq!(hub.workspaces.live_tokens_all().unwrap().len(), 1);
        assert!(hub.live_dirty.get(), "still owed an evaluation");
        hub.live_grace_until_ms = 0;
        hub.live_tick();
        hub.live.age_changes(5_000);
        hub.live_tick();
        assert!(matches!(rx.try_recv(), Ok(Outbound::Live(_))));
    }

    #[test]
    fn a_non_admin_gets_the_watch_and_live_activity_for_their_own_runs_only() {
        let (mut hub, _agent_rx, run_id) = watch_hub();
        let (tx, mut rx) = unbounded_channel::<Outbound>();
        hub.notify = Some(tx);
        hub.handle_live_activity(
            "owner",
            LiveOp::Start {
                token: "aabb".into(),
            },
        )
        .unwrap();
        hub.runs.get_mut(&run_id).unwrap().state = "working".into();
        hub.watch_cfg.as_mut().unwrap().admins.clear();

        // Their own run reaches both surfaces.
        assert_eq!(inbox_ids(&mut hub), vec!["session-1".to_string()]);
        assert!(!hub.live_snapshot("owner").is_idle());
        hub.live_tick();
        hub.live.age_changes(5_000);
        hub.live_tick();
        assert!(rx.try_recv().is_ok());

        // Another active account on the same hub sees and drives nothing of it.
        hub.workspaces
            .ensure_user("stranger", "stranger@example.com", Some("S"))
            .unwrap();
        hub.workspaces.activate_access("stranger", "tests").unwrap();
        let inbox = hub.handle_watch_inbox("stranger");
        assert_eq!(inbox["items"], json!([]));
        assert_eq!(inbox["working"], json!(0));
        assert!(hub.live_snapshot("stranger").is_idle());
        assert!(hub
            .handle_watch_history("stranger", "machine-1", "session-1", None, 10)
            .is_err());
        assert!(matches!(
            hub.handle_watch_session_reply("stranger", "machine-1", "session-1", None, Some("hi")),
            Err(ActionError::Forbidden)
        ));
    }

    #[test]
    fn reading_a_session_without_control_from_the_watch_leaves_an_audit_row() {
        let (mut hub, _rx) = quiet_hub(vec![session(None)]);
        // "mate" owns the device; "owner" is a member under a control share.
        seat_as_team_member(&mut hub);
        hub.watch_cfg.as_mut().unwrap().admins.clear();
        hub.session_meta.insert(
            "machine-1::session-1".into(),
            SessionMeta {
                owner_user_id: "owner".into(),
                category: None,
                stage: None,
                origin: None,
            },
        );
        seed_history(&hub, "claude", 3);
        let rows = |hub: &Hub, who: &str| -> i64 {
            hub.workspaces
                .conn
                .lock()
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM audit_events WHERE action='session.viewed' AND actor_user_id=?1",
                    [who],
                    |r| r.get(0),
                )
                .unwrap()
        };
        hub.handle_watch_history("mate", "machine-1", "session-1", None, 10)
            .unwrap();
        assert_eq!(rows(&hub, "mate"), 0, "full control of the machine: no row");
        hub.handle_watch_history("owner", "machine-1", "session-1", None, 10)
            .unwrap();
        assert_eq!(rows(&hub, "owner"), 1);
    }

    #[test]
    fn a_terminal_failure_offers_no_reply_but_a_failed_turn_does() {
        let (mut hub, _agent_rx, run_id) = watch_hub();
        let (tx, mut rx) = unbounded_channel::<Outbound>();
        hub.notify = Some(tx);
        hub.on_agent_msg(
            AGENT_CONN,
            json!({"type":"run_status","runId":run_id,"state":"error","error":"boom"}),
        );
        assert!(!hub.runs.contains_key(&run_id), "released");
        let Outbound::Push(ev) = rx.try_recv().expect("failure push") else {
            panic!("expected a push")
        };
        assert!(ev.content.act.is_none());
        let payload = crate::push_payload::build_payload(&ev, 4096);
        assert!(payload["aps"].get("category").is_none());
        assert!(payload.get("act").is_none());
        assert_eq!(payload["aps"]["alert"]["body"], "Ошибка: boom");

        // A failed turn keeps the run: still answerable.
        let (mut hub, _agent_rx, run_id) = watch_hub();
        let (tx, mut rx) = unbounded_channel::<Outbound>();
        hub.notify = Some(tx);
        hub.run_error(&run_id);
        let Outbound::Push(ev) = rx.try_recv().expect("turn failure push") else {
            panic!("expected a push")
        };
        assert!(ev.content.act.is_some());
        let payload = crate::push_payload::build_payload(&ev, 4096);
        assert_eq!(payload["aps"]["category"], "HEGAI_ERROR");
    }

    #[test]
    fn non_admin_pushes_are_generic_and_a_tool_approval_never_shows_the_command() {
        let (mut hub, _agent_rx, run_id) = watch_hub();
        let (tx, mut rx) = unbounded_channel::<Outbound>();
        hub.notify = Some(tx);
        hub.watch_cfg.as_mut().unwrap().admins.clear();
        ask(
            &mut hub,
            &run_id,
            "req-1",
            "AskUserQuestion",
            json!({"questions":[{"question":"secret question?","options":[{"label":"x"}]}]}),
        );
        let Outbound::Push(ev) = rx.try_recv().unwrap() else {
            panic!()
        };
        let p = crate::push_payload::build_payload(&ev, 4096);
        assert_eq!(p["aps"]["alert"]["body"], "Нужен ваш ответ");
        for key in ["ask", "plan", "replies", "act"] {
            assert!(p.get(key).is_none(), "{key}");
        }
        assert!(!p.to_string().contains("secret"));

        hub.settle_tool_request(&run_id, Some("req-1".into()));
        hub.runs.get_mut(&run_id).unwrap().state = "working".into();
        ask(
            &mut hub,
            &run_id,
            "req-2",
            "ExitPlanMode",
            json!({"plan":"secret plan"}),
        );
        let Outbound::Push(ev) = rx.try_recv().unwrap() else {
            panic!()
        };
        let p = crate::push_payload::build_payload(&ev, 4096);
        assert_eq!(p["aps"]["alert"]["body"], "План готов");
        assert!(p.get("plan").is_none() && !p.to_string().contains("secret"));

        // Idle and error: the words of the run stay home.
        {
            let r = hub.runs.get_mut(&run_id).unwrap();
            r.state = "working".into();
            r.text_buf = "secret result".into();
            r.last_error = Some("secret failure".into());
        }
        hub.run_idle(&run_id);
        let Outbound::Push(ev) = rx.try_recv().unwrap() else {
            panic!()
        };
        let p = crate::push_payload::build_payload(&ev, 4096);
        assert_eq!(p["aps"]["alert"]["body"], "Готово");
        assert!(p.get("replies").is_none() && p.get("act").is_none());
        hub.run_error(&run_id);
        let Outbound::Push(ev) = rx.try_recv().unwrap() else {
            panic!()
        };
        let p = crate::push_payload::build_payload(&ev, 4096);
        assert_eq!(p["aps"]["alert"]["body"], "Ошибка");
        assert!(p.get("act").is_none() && !p.to_string().contains("secret"));

        // The command line (the tool's title) is not shown to an admin either.
        let (mut hub, _agent_rx, run_id) = watch_hub();
        let (tx, mut rx) = unbounded_channel::<Outbound>();
        hub.notify = Some(tx);
        hub.on_agent_msg(
            AGENT_CONN,
            json!({"type":"tool_request","runId":run_id,"sessionId":"session-1",
                   "requestId":"req-1","tool":"Bash","title":"Run rm -rf /","input":{"command":"rm -rf /"}}),
        );
        let Outbound::Push(ev) = rx.try_recv().unwrap() else {
            panic!()
        };
        let p = crate::push_payload::build_payload(&ev, 4096);
        assert_eq!(p["aps"]["alert"]["body"], "Хочет запустить Bash");
        assert!(!p.to_string().contains("rm -rf"));
    }

    #[test]
    fn a_slow_summary_never_overwrites_a_newer_push() {
        let (mut hub, _agent_rx, run_id) = watch_hub();
        let (tx, mut rx) = unbounded_channel::<Outbound>();
        hub.notify = Some(tx);
        let event = |hub: &Hub| crate::notify::PushEvent {
            run_id: run_id.clone(),
            title: "t".into(),
            machine: "m".into(),
            machine_id: "machine-1".into(),
            session_id: "session-1".into(),
            state: "idle".into(),
            request_id: None,
            tool: None,
            device_tokens: vec![],
            owner_user_id: Some("owner".into()),
            workspace_id: None,
            content: hub.push_content(
                &run_id,
                &hub.runs[&run_id],
                "idle",
                Some("owner"),
                None,
                false,
                false,
            ),
        };
        {
            let r = hub.runs.get_mut(&run_id).unwrap();
            r.state = "idle".into();
            r.since = 1000;
        }
        let reply = crate::push_payload::Reply {
            label: "ok".into(),
            send: "go".into(),
        };
        // Still the same idle transition: the summary push goes out.
        hub.push_summary_ready(event(&hub), 1000, Some("Итог".into()), vec![reply.clone()]);
        let Outbound::Push(ev) = rx.try_recv().expect("sent") else {
            panic!()
        };
        assert_eq!(ev.content.summary.as_deref(), Some("Итог"));
        // A summary failure still sends the plain push.
        hub.push_summary_ready(event(&hub), 1000, None, vec![]);
        assert!(matches!(rx.try_recv(), Ok(Outbound::Push(_))));
        // The run moved on (a question asked / new turn): dropped.
        hub.runs.get_mut(&run_id).unwrap().state = "needs_attention".into();
        hub.push_summary_ready(event(&hub), 1000, Some("Итог".into()), vec![reply.clone()]);
        hub.runs.get_mut(&run_id).unwrap().state = "idle".into();
        hub.runs.get_mut(&run_id).unwrap().since = 2000;
        hub.push_summary_ready(event(&hub), 1000, Some("Итог".into()), vec![reply]);
        hub.runs.remove(&run_id);
        hub.push_summary_ready(event_gone(), 1000, None, vec![]);
        assert!(rx.try_recv().is_err());
    }

    fn event_gone() -> crate::notify::PushEvent {
        crate::notify::PushEvent {
            run_id: "gone".into(),
            title: String::new(),
            machine: String::new(),
            machine_id: String::new(),
            session_id: String::new(),
            state: "idle".into(),
            request_id: None,
            tool: None,
            device_tokens: vec![],
            owner_user_id: None,
            workspace_id: None,
            content: Default::default(),
        }
    }

    #[test]
    fn live_tokens_follow_the_latest_user_and_signout_removes_them_everywhere() {
        let (mut hub, _agent_rx, _run_id) = watch_hub();
        hub.workspaces
            .ensure_user("other", "o@example.com", None)
            .unwrap();
        hub.handle_live_activity(
            "owner",
            LiveOp::Start {
                token: "aabb".into(),
            },
        )
        .unwrap();
        hub.handle_live_activity(
            "owner",
            LiveOp::Activity {
                id: "a1".into(),
                token: "ccdd".into(),
            },
        )
        .unwrap();
        hub.handle_live_activity(
            "other",
            LiveOp::Start {
                token: "aabb".into(),
            },
        )
        .unwrap();
        let rows = hub.workspaces.live_tokens_all().unwrap();
        assert!(rows
            .iter()
            .filter(|r| r.token == "aabb")
            .all(|r| r.user_id == "other"));
        hub.handle_live_activity(
            "owner",
            LiveOp::Signout {
                tokens: vec!["aabb".into(), "ccdd".into()],
            },
        )
        .unwrap();
        assert!(hub.workspaces.live_tokens_all().unwrap().is_empty());
        assert!(hub.live.activities_of("owner").is_empty());
    }

    #[test]
    fn a_late_summary_is_rechecked_against_the_owner_and_devices() {
        let (mut hub, _agent_rx, run_id) = watch_hub();
        let (tx, mut rx) = unbounded_channel::<Outbound>();
        hub.notify = Some(tx);
        {
            let r = hub.runs.get_mut(&run_id).unwrap();
            r.state = "idle".into();
            r.since = 1000;
        }
        hub.push_devices.insert("dev-1".into(), (1, "owner".into()));
        let event = |hub: &Hub| crate::notify::PushEvent {
            run_id: run_id.clone(),
            title: "t".into(),
            machine: "m".into(),
            machine_id: "machine-1".into(),
            session_id: "session-1".into(),
            state: "idle".into(),
            request_id: None,
            tool: None,
            device_tokens: vec!["stale".into()],
            owner_user_id: Some("owner".into()),
            workspace_id: None,
            content: hub.push_content(
                &run_id,
                &hub.runs[&run_id],
                "idle",
                Some("owner"),
                None,
                false,
                false,
            ),
        };
        // Devices are the current ones, not the captured list.
        hub.push_summary_ready(event(&hub), 1000, Some("Итог".into()), vec![]);
        let Outbound::Push(ev) = rx.try_recv().expect("sent") else {
            panic!()
        };
        assert_eq!(ev.device_tokens, vec!["dev-1".to_string()]);
        // The run changed hands: dropped.
        hub.runs.get_mut(&run_id).unwrap().owner_user_id = Some("someone".into());
        hub.push_summary_ready(event(&hub), 1000, Some("Итог".into()), vec![]);
        assert!(rx.try_recv().is_err());
        hub.runs.get_mut(&run_id).unwrap().owner_user_id = Some("owner".into());
        // The owner lost admin meanwhile: dropped.
        hub.watch_cfg = Some(WatchConfig {
            secret: Some(SECRET.into()),
            admins: Default::default(),
        });
        hub.push_summary_ready(event(&hub), 1000, Some("Итог".into()), vec![]);
        assert!(rx.try_recv().is_err());
    }
}

/// The session's plan count rides to the Live Activity row and nowhere else:
/// browsers draw the plan from the transcript, so the frame is not forwarded,
/// and it never makes an idle run «working».
#[test]
fn a_plan_count_feeds_the_live_activity_and_is_not_forwarded() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    open(&mut hub, false);
    let run_id = hub.runs.keys().next().unwrap().clone();
    drain(&mut ui_rx);
    let plan = |hub: &mut Hub, done: u64, total: u64| {
        hub.on_agent_msg(
            AGENT_CONN,
            json!({"type":"stream","runId":run_id,"sessionId":"session-1",
                   "event":{"kind":"status","code":"plan_progress","text":"","data":{"done":done,"total":total}}}),
        );
    };
    plan(&mut hub, 2, 5);
    assert_eq!(
        hub.runs[&run_id].plan.as_ref().map(|p| (p.done, p.total)),
        Some((2, 5))
    );
    assert!(
        !drain(&mut ui_rx)
            .iter()
            .any(|f| f["event"]["code"] == "plan_progress"),
        "not a viewer's frame"
    );
    plan(&mut hub, 9, 5);
    assert_eq!(
        hub.runs[&run_id].plan.as_ref().map(|p| (p.done, p.total)),
        Some((5, 5)),
        "done never passes total"
    );
    plan(&mut hub, 0, 0);
    assert_eq!(hub.runs[&run_id].plan, None, "the agent's 0/0 clears it");
    // The person's next turn clears it on the hub's own word: the agent's
    // 0/0 can be lost to a socket that drops right after the input.
    plan(&mut hub, 3, 7);
    hub.on_ui_msg(
        UI_CONN,
        json!({"type":"input","runId":run_id,"text":"дальше"}),
    );
    hub.on_agent_msg(
        AGENT_CONN,
        json!({"type":"run_status","runId":run_id,"sessionId":"session-1","state":"started"}),
    );
    assert_eq!(hub.runs[&run_id].plan, None, "a human turn is a new task");
}

/// What a member does on their OWN machine stays in their personal log even
/// when the socket landed in a team (the default now): the team owner reads
/// the team log in full. On a machine the team shares, the row stays in the team.
#[test]
fn own_machine_audit_rows_stay_personal_when_the_socket_is_in_a_team() {
    let (mut hub, _ui_rx, _agent_rx) = test_hub(session(None));
    let ws = hub.workspaces.clone();
    ws.ensure_user("mate", "mate@example.com", Some("Mate"))
        .unwrap();
    ws.activate_access("mate", "tests").unwrap();
    let team = ws.create_organization("mate", "Team", "mate").unwrap();
    let wid = team["workspaceId"].as_str().unwrap().to_string();
    let invite = ws
        .invite("mate", &wid, "owner@example.com", "member")
        .unwrap();
    ws.accept_invitation("owner", invite["token"].as_str().unwrap())
        .unwrap();
    // machine-1 is still the owner's own; the socket sits in mate's team.
    hub.ui_access
        .insert(UI_CONN, ws.ui_access("owner", Some(&wid), false).unwrap());
    hub.audit_ui(
        UI_CONN,
        "terminal.opened",
        "machine",
        "machine-1",
        json!({"machineId": "machine-1", "cwd": "/private/stuff"}),
    );
    let team_log = ws.audit_events("mate", &wid).unwrap_or_default();
    assert!(
        !team_log.iter().any(|e| e["action"] == "terminal.opened"),
        "an unshared machine's terminal must not reach the team log"
    );
    let own_log = ws
        .audit_events("owner", "personal:owner")
        .unwrap_or_default();
    assert!(own_log.iter().any(|e| e["action"] == "terminal.opened"));
    // Sharing one project of it does not open the rest: the team log is read
    // whole, so the owner's own actions stay personal.
    ws.share_project(
        "owner",
        &wid,
        "machine-1",
        "/repo",
        "Repo",
        "control",
        "team",
    )
    .unwrap();
    hub.audit_ui(
        UI_CONN,
        "terminal.opened",
        "machine",
        "machine-1",
        json!({"machineId": "machine-1", "cwd": "/private/other"}),
    );
    let team_log = ws.audit_events("mate", &wid).unwrap_or_default();
    assert!(!team_log.iter().any(|e| e["action"] == "terminal.opened"));
}

// ---- team machines: the owner / manager see members' hardware, nothing else --

/// An organization with `boss` (owner), `mgr` (manager), `mate` (member, owns
/// `mate-box`, online with a stats sample and a runtimes reading that name an
/// account) and `stranger` (another organization's owner). Returns the id.
fn seat_team_machines(hub: &mut Hub) -> String {
    for (id, mail) in [
        ("boss", "boss@x"),
        ("mgr", "mgr@x"),
        ("mate", "mate@x"),
        ("stranger", "stranger@x"),
    ] {
        hub.workspaces.ensure_user(id, mail, None).unwrap();
        hub.workspaces.activate_access(id, "tests").unwrap();
    }
    let w = hub
        .workspaces
        .create_organization("boss", "Team", "boss")
        .unwrap();
    let wid = w["workspaceId"].as_str().unwrap().to_string();
    for (user, mail, role) in [("mgr", "mgr@x", "manager"), ("mate", "mate@x", "member")] {
        let invite = hub.workspaces.invite("boss", &wid, mail, role).unwrap();
        hub.workspaces
            .accept_invitation(user, invite["token"].as_str().unwrap())
            .unwrap();
    }
    hub.workspaces
        .create_organization("stranger", "Other", "stranger")
        .unwrap();
    for (user, id) in [("mate", "mate-box"), ("stranger", "other-box")] {
        hub.workspaces
            .register_legacy_device(
                user,
                &json!({"machineId":id,"name":id,"os":"linux","agentVersion":"1"}),
            )
            .unwrap();
        add_current_agent(hub, if id == "mate-box" { 30 } else { 31 }, id);
    }
    hub.agents.get_mut("mate-box").unwrap().machine = json!({"machineId":"mate-box","name":"mate-box","os":"linux",
        "agentVersion":"9","hostname":"mate-laptop","skills":["x"],"permissionModes":["default"],"policy":{"a":1},"e2eEpoch":3});
    hub.agents.get_mut("mate-box").unwrap().stats = team_sample_stats();
    hub.agents.get_mut("mate-box").unwrap().runtimes = team_sample_runtimes();
    wid
}

fn team_sample_stats() -> Value {
    json!({"ts":1,"platform":"linux","cpuCount":4,"load1":0.5,"load5":0.5,"load15":0.5,
        "cpuPercent":10.0,"memTotal":8,"memUsed":4,"swapTotal":0,"swapUsed":0,"diskTotal":100,
        "diskUsed":50,"uptimeSec":9,"agentRss":1,"agentCpuPercent":0.1,
        "top":[{"pid":1,"name":"secret-customer-job","cpu":1.0,"mem":1}]})
}

fn team_sample_runtimes() -> Value {
    json!({
        "claude":{"present":true,"auth":"oauth","version":"2.1","account":"mate@private.example",
            "plan":"max","error":"token_expiring","expiresAt":42,"detail":"secret path","checkedAt":7},
        "codex":{"present":true,"path":"/home/mate/bin/codex","auth":"chatgpt","account":"mate@private.example",
            "plan":"pro","provider":"gateway","providerName":"corp-gw","error":"timeout","detail":"x","checkedAt":8}
    })
}

fn sit_as(hub: &mut Hub, user: &str, wid: Option<&str>) {
    let access = hub.workspaces.ui_access(user, wid, false).unwrap();
    hub.ui_access.insert(UI_CONN, access);
}

fn assert_team_view_is_stripped(team: &Value) {
    assert_eq!(team["machine"]["machineId"], "mate-box");
    assert_eq!(team["owner"]["userId"], "mate");
    assert_eq!(team["online"], true);
    assert_eq!(team["stats"]["top"], json!([]));
    assert_eq!(team["stats"]["cpuPercent"], 10.0);
    let claude = team["runtimes"]["claude"].as_object().unwrap();
    let codex = team["runtimes"]["codex"].as_object().unwrap();
    for key in ["account", "plan", "path", "detail", "providerName"] {
        assert!(
            !claude.contains_key(key) && !codex.contains_key(key),
            "{key}"
        );
    }
    assert_eq!(claude["auth"], "oauth");
    assert_eq!(claude["expiresAt"], 42);
    assert_eq!(claude["error"], "token_expiring");
    assert_eq!(codex["error"], "timeout");
    let machine = team["machine"].as_object().unwrap();
    for key in [
        "skills",
        "hostname",
        "policy",
        "e2eEpoch",
        "permissionModes",
    ] {
        assert!(!machine.contains_key(key), "{key}");
    }
    assert_eq!(machine["agentVersion"], "9");
    assert_eq!(codex["provider"], "gateway");
    let text = team.to_string();
    assert!(!text.contains("private.example") && !text.contains("secret"));
    assert!(team.get("sessions").is_none());
}

#[test]
fn the_owner_and_a_manager_see_members_machines_read_only_in_the_snapshot() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    let wid = seat_team_machines(&mut hub);
    drain(&mut ui_rx);
    for user in ["boss", "mgr"] {
        sit_as(&mut hub, user, Some(&wid));
        let snap = hub.snapshot_for(UI_CONN);
        let team = snap["teamMachines"].as_array().unwrap();
        let ids: Vec<&str> = team
            .iter()
            .map(|t| t["machine"]["machineId"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["mate-box"], "{user}");
        assert_team_view_is_stripped(&team[0]);
        let in_machines = snap["machines"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["machine"]["machineId"] == "mate-box");
        assert!(!in_machines, "{user}: not among the machines");
        assert!(snap["machines"].to_string().find("mate-box").is_none());
    }
}

#[test]
fn a_member_another_organization_and_a_pass_get_no_team_machines() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    let wid = seat_team_machines(&mut hub);
    drain(&mut ui_rx);
    sit_as(&mut hub, "mate", Some(&wid));
    assert!(hub.snapshot_for(UI_CONN).get("teamMachines").is_none());
    sit_as(&mut hub, "stranger", None);
    let snap = hub.snapshot_for(UI_CONN);
    assert!(snap.get("teamMachines").is_none());
    assert!(!snap.to_string().contains("mate-box"));
    let access = hub
        .workspaces
        .ui_access("boss", Some(&wid), false)
        .unwrap()
        .with_scope(legal_scope(&wid));
    hub.ui_access.insert(UI_CONN, access);
    assert!(hub.snapshot_for(UI_CONN).get("teamMachines").is_none());
}

#[test]
fn a_manager_cannot_reach_a_members_machine_through_the_team_list() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    let wid = seat_team_machines(&mut hub);
    sit_as(&mut hub, "mgr", Some(&wid));
    drain(&mut ui_rx);
    for method in [
        "runtime.login.start",
        "projects.list",
        "session.messages",
        "fs.list",
        "proc.list",
    ] {
        hub.route_rpc_request(
            UI_CONN,
            &json!({"machineId":"mate-box","requestId":format!("r-{method}"),"method":method,
                "params":{"sessionId":"s-1","cwd":"/home/mate"}}),
        );
        assert!(hub.pending_rpc.is_empty(), "{method} was forwarded");
    }
    let access = hub.ui_access[&UI_CONN].clone();
    let rights = hub.workspaces.machine_access(&access, "mate-box").unwrap();
    assert!(!rights.can_view && !rights.can_control && !rights.can_start);
}

#[test]
fn stats_and_runtime_deltas_reach_team_viewers_stripped() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    let wid = seat_team_machines(&mut hub);
    sit_as(&mut hub, "mgr", Some(&wid));
    drain(&mut ui_rx);

    hub.on_agent_msg(
        30,
        json!({"type":"machine_stats","stats":team_sample_stats()}),
    );
    let frames = drain(&mut ui_rx);
    let stats = frames
        .iter()
        .find(|m| m["type"] == "machine_stats")
        .expect("team viewer gets machine_stats");
    assert_eq!(stats["machineId"], "mate-box");
    assert_eq!(stats["stats"]["top"], json!([]));
    assert!(!stats.to_string().contains("secret-customer-job"));

    hub.on_agent_msg(
        30,
        json!({"type":"runtime_status","runtimes":team_sample_runtimes()}),
    );
    let frames = drain(&mut ui_rx);
    let rt = frames
        .iter()
        .find(|m| m["type"] == "runtime_status")
        .expect("team viewer gets runtime_status");
    assert!(rt["runtimes"]["claude"].get("account").is_none());
    assert!(!rt.to_string().contains("private.example"));

    // The other organization's owner gets neither; the machine's own owner
    // gets the unstripped private deltas as before, not a team copy.
    assert_eq!(hub.team_viewers_of("mate-box", |_| true), vec![UI_CONN]);
    sit_as(&mut hub, "mate", Some(&wid));
    assert!(hub.team_viewers_of("mate-box", |_| true).is_empty());
    {
        let (user, ws) = ("stranger", None);
        sit_as(&mut hub, user, ws);
        drain(&mut ui_rx);
        hub.on_agent_msg(
            30,
            json!({"type":"machine_stats","stats":team_sample_stats()}),
        );
        assert!(
            drain(&mut ui_rx)
                .iter()
                .all(|m| m["type"] != "machine_stats"),
            "{user}"
        );
    }
}

#[test]
fn a_view_only_shared_machine_is_still_listed_for_its_hardware_and_online_is_coalesced() {
    let (mut hub, mut ui_rx, _agent_rx) = test_hub(session(None));
    let wid = seat_team_machines(&mut hub);
    let p = hub
        .workspaces
        .share_project("mate", &wid, "mate-box", "/repo", "Repo", "view", "team")
        .unwrap();
    hub.workspaces
        .assign_manager(
            "boss",
            &wid,
            "mgr",
            "project",
            p["projectShareId"].as_str().unwrap(),
        )
        .unwrap();
    sit_as(&mut hub, "mgr", Some(&wid));
    let snap = hub.snapshot_for(UI_CONN);
    let in_machines = snap["machines"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["machine"]["machineId"] == "mate-box");
    assert!(in_machines, "the share still gives the sessions");
    assert_eq!(snap["teamMachines"][0]["machine"]["machineId"], "mate-box");

    // A session starting (broadcast_machine_entry) sends no snapshot; only a
    // registration owes one, and it is paid by the tick, once.
    hub.ui_caps
        .insert(UI_CONN, HashSet::from([CAP_SESSION_PATCH.to_string()]));
    drain(&mut ui_rx);
    hub.broadcast_machine_entry(&["mate-box".to_string()]);
    assert!(drain(&mut ui_rx).iter().all(|m| m["type"] != "snapshot"));
    hub.owe_team_snapshot("mate-box");
    hub.owe_team_snapshot("mate-box");
    hub.last_snapshot_at = 0;
    hub.coalesce_tick();
    let n = drain(&mut ui_rx)
        .iter()
        .filter(|m| m["type"] == "snapshot")
        .count();
    assert_eq!(n, 1);
}

#[test]
fn team_runtimes_pass_only_known_error_codes() {
    let out = team_runtimes(&json!({
        "claude": {"present": true, "auth": "oauth", "error": "token_rejected", "account": "a@b", "detail": "x"},
        "codex": {"present": true, "auth": "chatgpt", "error": "failed at /home/anna/.codex: anna@corp.example", "provider": "own"}
    }))
    .unwrap();
    assert_eq!(out["claude"]["error"], "token_rejected");
    assert!(out["claude"].get("account").is_none() && out["claude"].get("detail").is_none());
    assert_eq!(out["codex"]["error"], "other");
}
