use super::wire::{message, ValueFields};
use super::*;

/// How long a forwarded `session.messages` may wait on the agent before the
/// replica answers instead. Well inside the browser's 30 s RPC timeout, and
/// longer than a healthy agent needs (a 300-message page reads in ~0.3 s;
/// under a full re-sync it was measured at 3 s).
pub(super) const HISTORY_AGENT_DEADLINE_MS: u64 = 6_000;

/// Calls one connection may have outstanding at once. See the comment at the
/// check itself — this bounds the hub's outbound queue in BYTES, which the frame
/// counter cannot do now that a single frame can be a 700KB download window.
const MAX_PENDING_RPC_PER_CONN: usize = 32;

/// Shorten one oversized transcript payload, naming what it holds back.
///
/// The counterpart of `clipPayload` in `agent/src/history.ts`, and it has to
/// exist twice because the two paths are genuinely different: the agent trims
/// what it reads off disk, while nearly every read in production is answered
/// from the hub's own replica below and never reaches a machine at all.
fn clip_payload(text: &str, cap: usize) -> Option<String> {
    // Char offsets, not byte offsets — a Cyrillic transcript would otherwise
    // get sliced through the middle of a code point.
    let (cut, _) = text.char_indices().nth(cap)?;
    let dropped = text[cut..].chars().count();
    let size = if dropped >= 1024 {
        format!("{} KB", dropped.div_ceil(1024))
    } else {
        format!("{dropped} chars")
    };
    Some(format!("{}\n… truncated · {size} more", &text[..cut]))
}

/// Cut the bulk out of a transcript's tool calls, leaving its structure alone.
///
/// Measured on this fleet, `tool_use` inputs and `tool_result` bodies are
/// 95-99% of a session's bytes — file dumps, diffs and greps that every client
/// folds behind a disclosure and clips on screen anyway — while their sizes are
/// long-tailed enough (median ~130 chars, p90 ~1.2k, single blocks past half a
/// megabyte) that a modest cap leaves nine blocks in ten untouched. Every block
/// still exists, in order, with its name and id.
pub(super) fn trim_tool_payloads(messages: &mut [Value], cap: usize) {
    for message in messages.iter_mut() {
        // A sealed message (private machine) has no blocks the hub may read.
        if message.get("e2e").is_some() {
            continue;
        }
        let Some(blocks) = message.get_mut("blocks").and_then(Value::as_array_mut) else {
            continue;
        };
        for block in blocks.iter_mut() {
            match block.get("kind").and_then(Value::as_str) {
                Some("tool_result") => {
                    let clipped = block
                        .get("text")
                        .and_then(Value::as_str)
                        .and_then(|text| clip_payload(text, cap));
                    if let Some(clipped) = clipped {
                        block["text"] = Value::String(clipped);
                    }
                }
                Some("tool_use") => match block.get_mut("input") {
                    // Top-level strings only. That is where the weight is
                    // (`content`, `old_string`, `command`, `prompt`), and it
                    // leaves a structured input like TodoWrite's array whole.
                    Some(Value::Object(fields)) => {
                        for value in fields.values_mut() {
                            if let Value::String(text) = value {
                                if let Some(clipped) = clip_payload(text, cap) {
                                    *text = clipped;
                                }
                            }
                        }
                    }
                    Some(Value::String(text)) => {
                        if let Some(clipped) = clip_payload(text, cap) {
                            *text = clipped;
                        }
                    }
                    _ => {}
                },
                _ => {}
            }
        }
    }
}

impl Hub {
    /// Can the replica still answer for this session, or has it fallen behind?
    ///
    /// The replica is the normal source for history — it survives the machine
    /// going offline, which is the whole point of keeping one. But it can STOP
    /// receiving updates while the session keeps being written: the agent skips
    /// replication above `REPLICA_MAX_BYTES` (`agent/src/client.ts`), and a
    /// reconnecting agent needs time to catch up. Answering from a frozen
    /// replica is worse than asking the machine, because it looks like the
    /// session died: the owner sends a message, the optimistic echo shows, the
    /// client re-reads history, and the message vanishes into a snapshot taken
    /// before it was sent. That is how a live 32 MB session read as "hanging"
    /// in every client at once — the hub never asked the agent, which had the
    /// text on disk the whole time.
    ///
    /// So: when the machine is ONLINE and its inventory reports a transcript
    /// newer than the revision the replica committed, the replica is stale and
    /// the request goes to the agent (which tail-reads the real file). Offline,
    /// or no inventory entry to compare against, the replica still answers —
    /// stale history beats no history.
    ///
    /// `syncedMtime` and the session's file cursor are the same number from
    /// the same stat (`agent/src/client.ts` sends `syncedMtime:
    /// replicaCursor(session)`), so this compares like with like. The cursor is
    /// `fileMtime` when present: `lastModified` is the sort key, and for a
    /// Claude session it settles back onto the last real message while the
    /// file keeps growing with bookkeeping (11.10.2026).
    pub(super) fn replica_is_current(
        &self,
        machine_id: &str,
        source: &str,
        session_id: &str,
    ) -> bool {
        let Some(agent) = self.agents.get(machine_id) else {
            return true; // offline: the replica is all there is
        };
        let inventory_mtime = agent.sessions.iter().find_map(|session| {
            if session_id_of(session)? != session_id {
                return None;
            }
            let session_source = session
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or("claude");
            if session_source != source {
                return None;
            }
            session
                .get("fileMtime")
                .or_else(|| session.get("lastModified"))
                .and_then(Value::as_f64)
        });
        let Some(inventory_mtime) = inventory_mtime else {
            return true; // not in the inventory: nothing to compare, keep the old path
        };
        match self.store.state(machine_id, source, session_id) {
            // The agent treats these as equal/behind with the same comparison
            // it uses to decide whether to sync at all; 1 ms of slack keeps a
            // float round-trip from reading as a difference.
            Ok(state) => state.synced_mtime + 1.0 >= inventory_mtime,
            Err(_) => true,
        }
    }

    pub(super) fn route_rpc_request(&mut self, conn: ConnId, v: &Value) {
        let machine_id = v.field_string("machineId").unwrap_or_default();
        let request_id = v.field_string("requestId").unwrap_or_default();
        let method = v.field_str("method").unwrap_or("");
        let params = v.get("params").and_then(Value::as_object);
        let session_id = params
            .and_then(|fields| fields.get("sessionId"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let cwd = params
            .and_then(|fields| fields.get("cwd"))
            .and_then(Value::as_str);
        // A connection on a service UI pass calls four methods and nothing
        // else; every other one is refused before it is looked at.
        if self.is_scoped(conn) && !SCOPED_RPC_METHODS.contains(&method) {
            self.rpc_error(
                conn,
                &request_id,
                "scope_refused: this connection may not call that method.",
            );
            return;
        }
        // `requestId` is the client's choice. Re-using one that is still in
        // flight — another connection's (it would divert that answer here) or
        // this connection's own (it would swap the rights its answer is checked
        // against for another request's) — is refused before ANYTHING else
        // answers or acts under it. Another connection is told; a repeat from
        // the owner is simply dropped, so the answer the original is owed (the
        // id is the same) still reaches it and settles nothing early.
        if self
            .pending_rpc
            .get(&request_id)
            .is_some_and(|pending| pending.conn == conn)
        {
            return;
        }
        if method.starts_with("session.") && self.session_erased(&machine_id, session_id) {
            self.rpc_error(conn, &request_id, "Session access denied.");
            return;
        }
        // A session a person deleted is gone for everyone, even though the
        // replica still holds its history: the list stops offering it, and
        // an id kept in a cache, a link or a push must not read it either.
        if matches!(
            method,
            "session.messages" | "session.image" | "session.subagent"
        ) && self.session_deletion_in_flight_or_done(&machine_id, session_id)
        {
            self.rpc_error(conn, &request_id, "Session was deleted.");
            return;
        }
        let can_control = self.ui_can_control_machine(conn, &machine_id);

        // Installing a coder and logging into one are the DEVICE OWNER's acts:
        // a login is that person's subscription on that person's machine, and
        // a control share — a colleague working inside a published root — must
        // not be able to start one, cancel one, or read the code of one. Owner
        // means the enrollment, not the workspace: the same rule `projects.*`
        // and the file writes follow.
        // Publishing a branch (`git.push`, `git.pr.create`) is the same kind of
        // act: it goes out under the owner's git credentials, not the
        // colleague's. Local git (diff, commit, worktrees) stays with `can_control`.
        let owner_only_git = matches!(method, "git.push" | "git.pr.create");
        if method.starts_with("runtime.") || owner_only_git {
            let viewer = self.ui_access.get(&conn).map(|a| a.user_id.clone());
            let owner = self.workspaces.device_owner(&machine_id).ok().flatten();
            let is_owner = viewer.is_some() && viewer == owner;
            if !can_control || !is_owner {
                self.rpc_error(
                    conn,
                    &request_id,
                    if owner_only_git {
                        "Только владелец машины может отправлять ветки с неё."
                    } else {
                        "Только владелец машины может входить в кодер на ней."
                    },
                );
                return;
            }
        }

        // Fetching one attachment is the same access question as reading the
        // transcript it sits in — it IS the transcript, one block of it — so it
        // goes through the same gate rather than a second one that could drift
        // away from it.
        // A sub-agent's transcript is part of the session's: whoever may read
        // the one may read the other, and nobody else.
        if method == "session.messages" || method == "session.image" || method == "session.subagent"
        {
            if !self.ui_can_view_session(conn, &machine_id, session_id, cwd) {
                self.rpc_error(conn, &request_id, "Session access denied.");
                return;
            }
            if !can_control {
                self.audit_ui(
                    conn,
                    "session.viewed",
                    "session",
                    session_id,
                    json!({"machineId":machine_id}),
                );
            }
        } else if !can_control {
            // Control-share members get a narrow RPC allowlist — never arbitrary
            // filesystem/git/process access on someone else's machine.
            let can_start = self.ui_can_start_machine(conn, &machine_id);
            let viewer_id = self
                .ui_access
                .get(&conn)
                .map(|access| access.user_id.clone());
            // Owning a session never outlives the share ACL: it counts only
            // while the session can still be seen.
            let owns_session = viewer_id.is_some()
                && self.session_owner(&machine_id, session_id) == viewer_id.as_deref()
                && self.ui_can_view_session(conn, &machine_id, session_id, cwd);
            // Reading files a project was SHARED with you is the one filesystem
            // capability a non-owner gets, and it is bounded twice: only these
            // three methods, and only inside the share's roots.
            //
            // Nothing that writes is here but one single-folder `fs.mkdir`
            // (below). `fs.write`, `fs.rename`,
            // `fs.trash` and the whole `fs.upload.*` family stay behind
            // `can_control`, because the roots of a share sit inside the device
            // owner's home and a write there is a write as them.
            let reads_files = matches!(method, "fs.list" | "fs.read" | "fs.download" | "fs.peek");
            // The folder the call really touches is where `path` lands: an
            // absolute `path` is taken as it is (the agent resolves it so), a
            // relative one is joined onto cwd (`..` resolved lexically). A
            // broader share's cwd must not reach into a nested restricted share
            // by either.
            let touched = |dir: &str| {
                let rel = params
                    .and_then(|fields| fields.get("path"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if reads_files {
                    crate::workspace::requested_path(dir, rel)
                } else {
                    dir.to_string()
                }
            };
            let within_shared_root = || {
                cwd.is_some_and(|dir| {
                    self.ui_access
                        .get(&conn)
                        .and_then(|a| self.workspaces.machine_access(a, &machine_id).ok())
                        // Mirrors the control-share start check in hub.rs, which
                        // is the same question about the same roots: where this
                        // viewer works, and not inside a restricted share they
                        // are shut out of.
                        .is_some_and(|ma| {
                            ma.allows_read_path(dir) && ma.allows_read_path(&touched(dir))
                        })
                })
            };
            // For a member's `fs.mkdir` the lexical «inside a root» is not
            // enough: the agent resolves `path` against realpath(cwd), so a
            // deeper or not-yet-existing cwd could create parents, and a
            // symlink inside the share could lead out of it. The cwd must BE a
            // shared root; the folder is then a direct child, made non-recursively.
            let at_shared_root = || {
                cwd.is_some_and(|dir| {
                    self.ui_access
                        .get(&conn)
                        .and_then(|a| self.workspaces.machine_access(a, &machine_id).ok())
                        .is_some_and(|ma| {
                            let dir = normalize_root(dir);
                            !ma.path_closed_for_work(&dir)
                                && ma.start_roots.iter().any(|r| normalize_root(r) == dir)
                        })
                })
            };
            // Renaming is gated on the SAME question as driving the session
            // (`ui_can_drive_run`: your own, or a teammate's you can see), not on
            // owning it. Requiring ownership made the permissions incoherent: a
            // control-share member could take a colleague's live session and type
            // into it — by far the most powerful thing on offer — yet could not
            // fix its title. In a shared project most sessions belong to someone
            // else, so in practice "rename" simply did not work for anyone but
            // the person who happened to start the session.
            //
            // Deleting stays on ownership. It destroys a colleague's transcript,
            // and nothing about a shared project implies that.
            let can_see_session = self.ui_can_view_session(conn, &machine_id, session_id, cwd);
            // Seeing a session is not working in it: whatever changes a session
            // needs start rights in ITS folder, not just somewhere on the machine
            // (a workspace owner sees every share and starts only in theirs).
            // (Not given the caller's `cwd`: that is their claim, not the hub's
            // record of where the session lives.)
            let works_here = self.ui_can_work_in(conn, &machine_id, session_id, None);
            let allowed = can_start
                && match method {
                    "session.rename" | "run.stopSubagent" | "session.delete" => works_here,
                    "commands.list" if cwd.is_none() || !session_id.is_empty() => works_here,
                    _ => true,
                }
                && match method {
                    "models.list" => true,
                    // The composer's «/» menu: skill names and descriptions.
                    // A `cwd` is what the agent reads, so it is what is judged —
                    // a session you may see must not vouch for somebody else's
                    // folder named beside it (the hole `session.messages` once
                    // had). Without one the agent reads only the live run's list.
                    "commands.list" => {
                        if cwd.is_some() {
                            within_shared_root()
                        } else {
                            owns_session || can_see_session
                        }
                    }
                    "session.rename" => owns_session || can_see_session,
                    // Stopping one helper of a run is a smaller act than
                    // stopping the run, which the same viewer may do.
                    "run.stopSubagent" => owns_session || can_see_session,
                    "session.delete" => owns_session,
                    // The one file write a member gets: a single NEW folder
                    // directly inside a shared root, so a shared project can
                    // grow a sibling. Nothing nested, hidden or relative; the
                    // agent's realpath containment still applies, and the hub
                    // forces `recursive:false` below.
                    "fs.mkdir" => {
                        let name = params
                            .and_then(|fields| fields.get("path"))
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        if !at_shared_root() {
                            false
                        } else if let Err(why) = single_folder_name(name) {
                            self.rpc_error(conn, &request_id, why);
                            return;
                        } else {
                            true
                        }
                    }
                    _ if reads_files => within_shared_root(),
                    _ => false,
                };
            if !allowed {
                self.rpc_error(conn, &request_id, "Read-only workspace access.");
                return;
            }
            // `path_is_within` is LEXICAL — the hub cannot resolve a path on a
            // machine it does not have, and says so where it is defined. The
            // agent's own realpath check is therefore load-bearing here, not a
            // second opinion.
            if reads_files {
                self.audit_ui(
                    conn,
                    "file.viewed",
                    "machine",
                    &machine_id,
                    json!({"method": method, "cwd": cwd}),
                );
            }
        }

        // Bound how many calls one connection can have outstanding.
        //
        // Not a rate limit for its own sake: the hub's outbound queue counts
        // FRAMES, not bytes (`OUT_CHANNEL_CAP`), which was harmless while every
        // frame was a token or a status. A download window is ~700KB, so a
        // client that fires requests without waiting — a tree component
        // re-listing per node per render is the realistic version — could queue
        // gigabytes against a stalled browser before the frame count noticed.
        // Capping in-flight requests bounds the queue in bytes without teaching
        // `send_raw` to do byte accounting it has no ownership to do.
        let in_flight = self.pending_rpc.values().filter(|p| p.conn == conn).count();
        if in_flight >= MAX_PENDING_RPC_PER_CONN {
            self.rpc_error(conn, &request_id, "Too many requests in flight.");
            return;
        }

        // History is served from the durable replica whenever one has committed,
        // including while the origin machine is offline — but only while that
        // replica is still keeping up. See `replica_is_current`.
        //
        // When it is NOT keeping up the read goes to the agent — and an agent
        // mid-way through re-uploading its whole corpus (every restart of the
        // fleet does this) can take longer to answer than a browser waits.
        // 26.09.2026: after three hub restarts in an afternoon every session
        // opened blank, because the answer came after the 30 s timeout and the
        // web dropped it. So a stale replica is remembered here and answers
        // instead if the agent misses `HISTORY_AGENT_DEADLINE_MS`.
        let mut history_fallback: Option<HistoryFallback> = None;
        if method == "session.messages" {
            let source = params
                .and_then(|fields| fields.get("source"))
                .and_then(Value::as_str)
                .unwrap_or("claude");
            let limit = params
                .and_then(|fields| fields.get("limit"))
                .and_then(Value::as_u64)
                .unwrap_or(1000)
                .clamp(1, 2000) as usize;
            if params.and_then(|p| p.get("head")).and_then(Value::as_bool) == Some(true) {
                match self
                    .store
                    .read_history_head(&machine_id, source, session_id, limit.min(40))
                {
                    Ok(Some(mut messages)) => {
                        trim_tool_payloads(&mut messages, 0);
                        self.send_to(
                            conn,
                            &json!({"type":"rpc_response", "requestId":request_id,
                            "ok":true,"result":{"messages":messages}}),
                        );
                    }
                    _ => {
                        self.rpc_error(conn, &request_id, "Opening history is not replicated yet.")
                    }
                }
                return;
            }
            // A client that only RENDERS a transcript asks for the tool payloads
            // capped. The replica keeps them whole — it is the durable archive —
            // so this is a read-time trim, applied per request.
            // `as_u64` alone is not enough: a client whose JSON encoder has only
            // one number type (the Swift app) can put this on the wire as
            // `1000.0`, and the difference would silently cost it the trim.
            let tool_chars = params
                .and_then(|fields| fields.get("toolChars"))
                .and_then(|cap| {
                    cap.as_u64()
                        .or_else(|| cap.as_f64().filter(|n| *n >= 0.0).map(|n| n as u64))
                })
                .map(|cap| cap.min(200_000) as usize);
            let current = self.replica_is_current(&machine_id, source, session_id);
            if !current
                && self
                    .store
                    .state(&machine_id, source, session_id)
                    .map(|s| s.revision > 0)
                    .unwrap_or(false)
            {
                history_fallback = Some(HistoryFallback {
                    session_id: session_id.to_string(),
                    source: source.to_string(),
                    limit,
                    tool_chars,
                    asked_at: std::time::Instant::now(),
                });
            }
            match if current {
                self.store
                    .read_history_tail(&machine_id, source, session_id, Some(limit))
            } else {
                Ok(None)
            } {
                Ok(Some(mut messages)) => {
                    if let Some(cap) = tool_chars {
                        trim_tool_payloads(&mut messages, cap);
                    }
                    self.send_to(
                        conn,
                        &json!({
                            "type":"rpc_response",
                            "requestId":request_id,
                            "ok":true,
                            "result":{"messages":messages},
                        }),
                    );
                    return;
                }
                Ok(None) => {}
                Err(error) => eprintln!(
                    "[hub] database history read failed for {machine_id}/{session_id}: {error}"
                ),
            }
        }

        // A deliberate delete, past every permission check above. An
        // ARCHIVED session has no file left for the agent to delete: the hub
        // is the only place it lives, so the hub does it and answers.
        if method == "session.delete" && self.store.is_archived(&machine_id, session_id) {
            if let Err(e) = self.store.mark_user_deleted(&machine_id, session_id) {
                self.rpc_error(conn, &request_id, &format!("Could not delete: {e}"));
                return;
            }
            self.send_to(
                conn,
                &json!({"type":"rpc_response","requestId":request_id,"ok":true,"result":{"ok":true}}),
            );
            self.broadcast_machine_sessions(std::slice::from_ref(&machine_id));
            return;
        }

        if !self.agent_online(&machine_id) {
            self.rpc_error(conn, &request_id, "Machine is offline.");
            return;
        }
        // Only a request that is really forwarded needs an id nobody else's
        // forwarded request holds (the answer is routed by it): another
        // connection's in-flight id is refused HERE, after every answer the hub
        // gives on its own has had its turn.
        if self.pending_rpc.contains_key(&request_id) {
            self.rpc_error(conn, &request_id, "Request id is already in use.");
            return;
        }
        // Remembered before the agent acts, so that when the file disappears
        // the session does not come back as archived
        // (`ReplicaStore::snapshot_sessions`); taken back if the agent refuses
        // (`rpc_response` in hub.rs) or drops. Only for a session the hub
        // knows, so a made-up id writes nothing.
        let deleting = (method == "session.delete"
            && self.store.has_session(&machine_id, session_id)
            && self
                .store
                .mark_user_deleted(&machine_id, session_id)
                .is_ok())
        .then(|| session_id.to_string());
        // A stopped helper cannot be resumed, and «я не нажимал» had no answer
        // (23.10.2026): who stopped it, from which of their clients, is kept —
        // here, once nothing below can refuse the call.
        if method == "run.stopSubagent" {
            let id = params
                .and_then(|fields| fields.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("");
            self.audit_stop(conn, "run.subagent_stopped", &machine_id, session_id, id);
        }
        // The method (and the cwd the caller named) are kept so a successful
        // `projects.create` / `projects.remove` can be written to the audit
        // log when the answer comes back.
        let has_fallback = history_fallback.is_some();
        self.pending_rpc.insert(
            request_id.clone(),
            PendingRpc {
                conn,
                machine_id: machine_id.clone(),
                method: method.to_string(),
                session_id: session_id.to_string(),
                placed: !session_id.is_empty()
                    && self.session_cwd(&machine_id, session_id).is_some(),
                touched: matches!(method, "fs.list" | "fs.read" | "fs.download" | "fs.peek").then(
                    || {
                        let rel = params
                            .and_then(|fields| fields.get("path"))
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        crate::workspace::requested_path(cwd.unwrap_or(""), rel)
                    },
                ),
                cwd: cwd.map(str::to_string),
                history: history_fallback,
                deleting,
            },
        );
        if has_fallback {
            // `try_current`: the synchronous hub tests drive this path with no
            // runtime; there the deadline is fired by hand (`history_deadline`).
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                let tx = self.self_tx.clone();
                let rid = request_id.clone();
                handle.spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(HISTORY_AGENT_DEADLINE_MS))
                        .await;
                    let _ = tx.send(HubCmd::HistoryDeadline { request_id: rid });
                });
            }
        }
        let mut forwarded_params = v.get("params").cloned().unwrap_or_else(|| json!({}));
        // A member's folder is one plain mkdir whatever the client sent.
        if method == "fs.mkdir" && !can_control {
            forwarded_params["recursive"] = json!(false);
        }
        // The agent picks WHICH copy of a session id to read or delete by its
        // folder (on a machine that confines coder runs per matter the same id
        // can exist in two matters). Access was checked against the hub's own
        // record of where the session lives, so that record - never the
        // caller's cwd - is what the agent is told. A session the hub does not
        // place keeps whatever was sent (the old behaviour).
        if matches!(
            method,
            "session.messages" | "session.subagent" | "session.delete" | "session.image"
        ) && !session_id.is_empty()
            && forwarded_params.is_object()
        {
            if let Some(known) = self.known_session_cwd(&machine_id, session_id) {
                forwarded_params["cwd"] = json!(known);
            }
        }
        self.send_to_agent(
            &machine_id,
            &json!({
                "type":message::RPC_REQUEST,
                "requestId":request_id,
                "method":v.field_value("method"),
                "params":forwarded_params,
            }),
        );
    }

    /// The agent has had `HISTORY_AGENT_DEADLINE_MS` to answer a transcript
    /// read and has not. If the request is still open and the replica holds
    /// the session, the replica answers now and the agent's late reply, when
    /// it lands, finds nothing pending and is dropped (`rpc_response` in
    /// hub.rs removes by request id). `stale: true` tells the client what it
    /// got. A request with no replica keeps waiting for the agent.
    pub(super) fn history_deadline(&mut self, request_id: &str) {
        let Some(pending) = self.pending_rpc.get(request_id) else {
            return;
        };
        let Some(fallback) = pending.history.clone() else {
            return;
        };
        let conn = pending.conn;
        let machine_id = pending.machine_id.clone();
        // The viewer was checked when the request was forwarded; six seconds
        // is long enough for a share to be revoked, an account suspended or
        // erased. The hub is answering on its own authority here, so it asks
        // again (`session_erased` and `is_active` sit inside this check).
        if !self.refresh_ui_access_now(conn)
            || !self.ui_can_view_session(conn, &machine_id, &fallback.session_id, None)
        {
            self.pending_rpc.remove(request_id);
            self.rpc_error(conn, request_id, "Session access denied.");
            return;
        }
        // Deleted by a person while the read was in flight: gone for everyone.
        if self.session_deletion_in_flight_or_done(&machine_id, &fallback.session_id) {
            self.pending_rpc.remove(request_id);
            self.rpc_error(conn, request_id, "Session was deleted.");
            return;
        }
        match self.store.read_history_tail(
            &machine_id,
            &fallback.source,
            &fallback.session_id,
            Some(fallback.limit),
        ) {
            Ok(Some(mut messages)) => {
                self.pending_rpc.remove(request_id);
                if let Some(cap) = fallback.tool_chars {
                    trim_tool_payloads(&mut messages, cap);
                }
                println!(
                    "[hub] history for {}/{} answered from the replica after {} ms — agent did not reply in time",
                    machine_id,
                    fallback.session_id,
                    fallback.asked_at.elapsed().as_millis()
                );
                self.send_to(
                    conn,
                    &json!({
                        "type":"rpc_response",
                        "requestId":request_id,
                        "ok":true,
                        "result":{"messages":messages,"stale":true},
                    }),
                );
            }
            Ok(None) => {}
            Err(error) => eprintln!(
                "[hub] replica fallback read failed for {machine_id}/{}: {error}",
                fallback.session_id
            ),
        }
    }

    fn rpc_error(&self, conn: ConnId, request_id: &str, error: &str) {
        self.send_to(
            conn,
            &json!({
                "type":"rpc_response",
                "requestId":request_id,
                "ok":false,
                "error":crate::client_safe_error(error),
            }),
        );
    }
}

/// A name for ONE new folder created by a non-controlling member: no path
/// structure, nothing hidden, nothing a Windows host would read as a drive.
fn single_folder_name(name: &str) -> Result<(), &'static str> {
    let bad = name.trim().is_empty()
        || name.chars().count() > 64
        || name == "."
        || name == ".."
        || name.starts_with('.')
        || name != name.trim()
        || name
            .chars()
            .any(|c| c == '/' || c == '\\' || c == ':' || c.is_control());
    if bad {
        Err("Имя папки: одно имя до 64 символов, без «/», «\\», «:» и точки в начале.")
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blocks(value: Value) -> Vec<Value> {
        vec![json!({"type":"assistant","uuid":"u1","blocks":value})]
    }

    #[test]
    fn an_oversized_tool_result_is_clipped_and_names_what_it_holds_back() {
        let mut messages = blocks(json!([
            {"kind":"tool_result","toolUseId":"t1","text":"x".repeat(50_000)}
        ]));
        trim_tool_payloads(&mut messages, 1000);
        let text = messages[0]["blocks"][0]["text"].as_str().unwrap();
        assert!(text.starts_with(&"x".repeat(1000)));
        assert!(text.ends_with("… truncated · 48 KB more"), "got {text:?}");
    }

    #[test]
    fn the_long_strings_in_a_tool_input_are_clipped_its_structure_is_not() {
        let mut messages = blocks(json!([{
            "kind":"tool_use","id":"t1","name":"Write",
            "input":{"file_path":"/repo/a.ts","content":"y".repeat(9000),
                     "todos":[{"status":"pending"}]}
        }]));
        trim_tool_payloads(&mut messages, 1000);
        let block = &messages[0]["blocks"][0];
        // The path is what the collapsed row shows, and the call's identity is
        // how a result is matched back to it — neither may be touched.
        assert_eq!(block["input"]["file_path"], "/repo/a.ts");
        assert_eq!(block["name"], "Write");
        assert_eq!(block["id"], "t1");
        assert_eq!(block["input"]["todos"], json!([{"status":"pending"}]));
        let content = block["input"]["content"].as_str().unwrap();
        assert!(
            content.ends_with("… truncated · 8 KB more"),
            "got {content:?}"
        );
    }

    #[test]
    fn prose_and_small_payloads_come_through_untouched() {
        let long_prose = "z".repeat(40_000);
        let original = blocks(json!([
            {"kind":"text","text":long_prose},
            {"kind":"thinking","text":"w".repeat(40_000)},
            {"kind":"tool_result","toolUseId":"t1","text":"short"},
        ]));
        let mut messages = original.clone();
        trim_tool_payloads(&mut messages, 1000);
        assert_eq!(messages, original, "only tool payloads are ever cut");
    }

    #[test]
    fn a_cyrillic_payload_is_cut_on_a_character_boundary() {
        // Byte slicing here would panic outright: every character is two bytes.
        let mut messages = blocks(json!([
            {"kind":"tool_result","toolUseId":"t1","text":"я".repeat(5000)}
        ]));
        trim_tool_payloads(&mut messages, 1000);
        let text = messages[0]["blocks"][0]["text"].as_str().unwrap();
        assert_eq!(text.chars().filter(|c| *c == 'я').count(), 1000);
        assert!(text.contains("truncated"));
    }
}
