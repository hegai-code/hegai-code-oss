use super::wire::{message, ValueFields};
use super::*;
use crate::push_payload::excerpt;

/// Upper bound on sessions ONE machine may hold guarded as «process may still
/// be exiting» at once. Per machine, not global: a hostile agent spraying
/// closing frames must only exhaust its own share, never keep another
/// machine's real guard from being armed. Expired guards are dropped first;
/// past this nothing more is armed for that machine.
pub(super) const CLOSING_WRITERS_PER_MACHINE_MAX: usize = 256;

impl Hub {
    /// Route agent frames that belong to one writable run. Returns true when
    /// the message was recognized so the broader agent router can stop.
    ///
    /// Frames from a SUPERSEDED socket are recognized and then dropped. Since an
    /// agent now carries its runs across a reconnect, a straggler from the dead
    /// socket would otherwise settle a run the new socket has already reclaimed
    /// — and a late `run_status: ended` releases the run, freeing the session's
    /// single-writer lock while the agent's subprocess is still appending to the
    /// transcript. Only the machine's current connection may move run state.
    pub(super) fn route_agent_run_message(&mut self, conn: ConnId, ty: &str, v: &Value) -> bool {
        if !matches!(
            ty,
            message::STREAM
                | message::TOOL_REQUEST
                | message::RUN_STATUS
                | message::WRITER_RELEASED
                | message::SESSION_STARTED
                | message::SESSION_ORIGIN
                | message::RUN_MODE
                | message::RUN_SETTINGS
                | message::CONTEXT_USAGE
                | message::RUN_INVENTORY
        ) {
            return false;
        }
        // The superseded-socket guard matters more for RUN_INVENTORY than for
        // anything else routed here. A stale agent process draining its send
        // queue reports the runs IT holds — typically none — and acting on that
        // would close the live agent's runs on the strength of a dead socket's
        // word. Every other frame here is additive; this one deletes.
        if !self.is_current_agent_conn(conn) {
            return true;
        }
        // A machine speaks only for its own runs. `runId` comes from the frame,
        // and every run is visible by id to the viewers of that session — so
        // without this, any enrolled agent could stream into, hold `working`
        // (a `background_tasks` list that never empties), or `run_status: ended`
        // someone else's run on another machine, the last of which frees that
        // session's single-writer lock while its real writer is still going.
        if let Some(run) = v
            .get("runId")
            .and_then(Value::as_str)
            .and_then(|id| self.runs.get(id))
        {
            if self.conn_machine.get(&conn) != Some(&run.machine_id) {
                println!(
                    "[hub] dropped {ty} for run on {} from another machine's socket",
                    run.machine_id
                );
                return true;
            }
        }
        match ty {
            message::SESSION_ORIGIN => self.agent_session_origin(conn, v),
            message::RUN_INVENTORY => self.agent_run_inventory(conn, v),
            message::STREAM => self.agent_stream(v),
            message::TOOL_REQUEST => self.agent_tool_request(v),
            message::RUN_STATUS => self.agent_run_status(conn, v),
            message::WRITER_RELEASED => self.agent_writer_released(conn, v),
            message::SESSION_STARTED => self.agent_session_started(conn, v),
            message::RUN_MODE => self.agent_run_mode(v),
            message::RUN_SETTINGS => self.agent_run_settings(v),
            message::CONTEXT_USAGE => self.agent_context_usage(v),
            _ => unreachable!("guarded by the matches! above"),
        }
        true
    }

    fn agent_session_origin(&mut self, conn: ConnId, v: &Value) {
        let Some(machine) = self.conn_machine.get(&conn).cloned() else {
            return;
        };
        let Some(run) = v
            .field_str("runId")
            .filter(|s| !s.is_empty() && s.len() <= 128)
        else {
            return;
        };
        let result = match v.get("sessionId") {
            Some(Value::Null) => {
                if self.runs.get(run).is_some_and(|r| !r.session_id.is_empty()) {
                    return;
                }
                self.workspaces.forget_failed_session_start(run, &machine)
            }
            Some(Value::String(session)) if !session.is_empty() && session.len() <= 512 => {
                let result = self
                    .workspaces
                    .resolve_pending_session(run, &machine, session);
                if result.is_ok() {
                    self.refresh_session_owner(&machine, session);
                }
                result.map(|_| ())
            }
            _ => return,
        };
        if result.is_err() {
            return;
        }
        self.erased_sessions = self.workspaces.erased_session_keys().ok();
        self.send_to(conn, &json!({"type":"session_origin_ack","runId":run}));
    }

    /// Reconcile what we believe this machine is running against what it says.
    ///
    /// The hub's run map is only ever corrected by the agent volunteering a
    /// terminal `run_status`. Every path where the agent stops driving a run
    /// without managing to say so leaves us holding a run that is `working`
    /// forever, with its single-writer lock still taken and every viewer
    /// watching a turn that will never produce another frame. That is not
    /// hypothetical: on 21.09.2026 run b1c58d7e sat open for four hours and
    /// only a hub redeploy cleared it.
    ///
    /// `settle_agent_runs` has always done exactly this reconciliation, but
    /// only at reconnect, and only for runs parked in `orphaned_runs`. The
    /// incident had no socket drop, so nothing ever ran.
    fn agent_run_inventory(&mut self, conn: ConnId, v: &Value) {
        let Some(machine_id) = self.conn_machine.get(&conn).cloned() else {
            return;
        };
        // An agent too old to carry `runIds` must not be read as "I drive
        // nothing" — that would close every run on the machine the moment it
        // connects. Absent field => no opinion => leave everything alone. This
        // is also why the schema makes the field required rather than optional:
        // a NEW agent with nothing running still has to be able to say so.
        let Some(list) = v.get("runIds").and_then(Value::as_array) else {
            return;
        };
        let held: HashSet<&str> = list.iter().filter_map(Value::as_str).collect();
        let now = now_ms();
        let orphans: Vec<String> = self
            .runs
            .iter()
            .filter(|(run_id, r)| {
                r.machine_id == machine_id
                    && !held.contains(run_id.as_str())
                    // A run whose agent socket is down is NOT settled here: it
                    // is parked in `orphaned_runs` under its own lease and the
                    // reconnect path owns it. Two mechanisms racing for the
                    // same run is how a carried run gets killed mid-turn.
                    && !self.orphaned_runs.contains_key(run_id.as_str())
                    && now - r.opened_at >= RUN_RECONCILE_GRACE_MS
            })
            .map(|(run_id, _)| run_id.clone())
            .collect();
        if orphans.is_empty() {
            return;
        }
        println!(
            "[hub] {} run(s) on {machine_id} have no writer — the agent does not hold them",
            orphans.len()
        );
        for run_id in orphans {
            // Order it closed THERE before forgetting it HERE. If the agent is
            // mid-start — the one way a healthy machine can be legitimately
            // absent from the list — this cancels the pending start (`end()`
            // deletes it) so it cannot launch a writer seconds after we have
            // freed its lock. Dropping the run without this is precisely how a
            // second writer into one transcript would be manufactured.
            self.send_to_agent(&machine_id, &json!({"type":"close","runId":run_id}));
            self.fail_run(
                &run_id,
                "the agent on this machine is no longer running this session — nothing was driving it",
            );
        }
        self.broadcast_activity();
    }

    fn agent_stream(&mut self, v: &Value) {
        let run_id = v.field_string("runId").unwrap_or_default();
        let event = v.field_value("event");
        let kind = event.field_string("kind").unwrap_or_default();
        let text = event.field_string("text").unwrap_or_default();
        let code = event.field_string("code").unwrap_or_default();
        // The session's plan count, for the Live Activity row only: the
        // browsers draw the plan from the transcript itself. Not forwarded,
        // not replayed and not «work» — it is a sign of life and nothing else.
        if code == "plan_progress" {
            let count = |k: &str| {
                event
                    .get("data")
                    .and_then(|d| d.get(k))
                    .and_then(Value::as_u64)
                    .map(|n| n.min(u64::from(u32::MAX)) as u32)
            };
            let plan = match (count("done"), count("total")) {
                (Some(done), Some(total)) if total > 0 => Some(PlanState {
                    done: done.min(total),
                    total,
                    active: event
                        .get("data")
                        .and_then(|d| d.get("active"))
                        .and_then(Value::as_str)
                        .map(|a| excerpt(a.trim(), 160))
                        .filter(|a| !a.is_empty()),
                    steps: event
                        .get("data")
                        .and_then(|d| d.get("steps"))
                        .and_then(Value::as_array)
                        .map(|rows| {
                            rows.iter()
                                .filter_map(|row| {
                                    let text = row.get("text").and_then(Value::as_str)?.trim();
                                    if text.is_empty() {
                                        return None;
                                    }
                                    let status = row
                                        .get("status")
                                        .and_then(Value::as_str)
                                        .filter(|s| {
                                            matches!(*s, "completed" | "in_progress" | "pending")
                                        })
                                        .unwrap_or("pending");
                                    Some((excerpt(text, 80), status.to_string()))
                                })
                                .take(12)
                                .collect()
                        })
                        .unwrap_or_default(),
                }),
                _ => None,
            };
            if let Some(run) = self.runs.get_mut(&run_id) {
                if run.plan != plan {
                    // The Live Activity shows the counts only.
                    let counts = |p: &Option<PlanState>| p.as_ref().map(|p| (p.done, p.total));
                    if counts(&run.plan) != counts(&plan) {
                        self.live_dirty.set(true);
                    }
                    run.plan = plan;
                }
            }
            self.note_run_event(&run_id);
            return;
        }
        let out = json!({
            "type": message::STREAM,
            "runId": run_id,
            "sessionId": v.field_value("sessionId"),
            // kind is REQUIRED (zod enum); never let clean() strip it.
            "event": {
                "kind": if kind.is_empty() { "status" } else { kind.as_str() },
                "text": event.field_value("text"),
                // Rebuilt field by field, so a field is DROPPED until it is
                // named here. `code` was not, for six weeks: the agent sent
                // `budget_exhausted`, the web knew how to draw the card, and
                // this line ate it in between. `data` is opaque numbers for
                // the client (retry counters, token counts, cost).
                "code": event.field_value("code"),
                "data": event.field_value("data"),
            },
        });
        // Private machine: one opaque envelope carries text / raw / data. The
        // hub forwards it and reads nothing from it (so `text` above is empty).
        let mut out = out;
        if let Some(env) = event.get("e2e").filter(|e| e.is_object()) {
            out["event"]["e2e"] = env.clone();
        }
        if code == "background_tasks" {
            let live = event
                .get("data")
                .and_then(|d| d.get("tasks"))
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            if let Some(run) = self.runs.get_mut(&run_id) {
                // Replayed whole on every subscribe, outside the replay
                // window's byte budget — so bounded here (the agent caps the
                // list, this is the hub not trusting that).
                run.background_frame =
                    (live > 0 && json_len(&out) <= BACKGROUND_FRAME_MAX_BYTES).then(|| out.clone());
            }
        }
        // The sub-agent level is a LEVEL: each frame replaces the last. The agent
        // republishes the whole collection on every progress tick, so a frame
        // identical to the one viewers already hold is not sent again (the
        // heartbeat below still counts it as a sign of life).
        //
        // Compared against the frame the run RETAINS for late subscribers
        // (`subagents_frame`): one too big or too empty to be retained is always
        // forwarded, so no viewer can be left holding a level it was never told.
        let repeated_level = code == "subagents"
            && self
                .runs
                .get(&run_id)
                .is_some_and(|run| run.subagents_frame.as_ref() == Some(&out));
        if !repeated_level {
            self.to_run_browsers(&run_id, &out);
        }
        // A tool call is the one silence that means nothing is wrong. The CLI
        // emits `requesting` on every API request, so while the MODEL works the
        // frames keep coming; inside a tool it makes no requests and says
        // nothing at all. In this product that is most of the time — a release
        // build is four minutes, a deploy is four minutes — so «нет событий
        // 2 мин» over a running `Bash` was the badge crying wolf on ordinary
        // work. Remember what the last frame was; the client holds its tongue
        // accordingly.
        if let Some(run) = self.runs.get_mut(&run_id) {
            run.awaiting_tool = kind == "tool_use";
        }
        self.note_run_event(&run_id);
        // Keep the turn's frames so a client that opens the session mid-turn is
        // shown what has already happened. Without this it subscribes to silence:
        // the hub replays nothing, and the transcript on disk does not have the
        // in-flight turn yet, so the pane stays empty until the turn lands.
        //
        // Not the sub-agent level: it is replayed on its own (`subagents_frame`),
        // and its progress ticks would push the turn's own frames out.
        if code == "subagents" {
            let agents = event
                .get("data")
                .and_then(|d| d.get("agents"))
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            if let Some(run) = self.runs.get_mut(&run_id) {
                run.subagents_frame = (agents > 0 && json_len(&out) <= SUBAGENTS_FRAME_MAX_BYTES)
                    .then(|| out.clone());
            }
        } else {
            self.remember_stream_frame(&run_id, &out);
        }

        // The compaction bracket, remembered so a late subscriber inherits it.
        match code.as_str() {
            "compact_started" => {
                if let Some(run) = self.runs.get_mut(&run_id) {
                    run.compacting = true;
                }
            }
            "compact_done" | "compact_failed" => {
                if let Some(run) = self.runs.get_mut(&run_id) {
                    run.compacting = false;
                }
            }
            _ => {}
        }

        match kind.as_str() {
            "partial" => {
                self.turn_moved_on(&run_id);
                if let Some(run) = self.runs.get_mut(&run_id) {
                    run.text_buf.push_str(&text);
                }
            }
            "assistant" => {
                self.turn_moved_on(&run_id);
                if !text.is_empty() {
                    if let Some(run) = self.runs.get_mut(&run_id) {
                        run.text_buf = text;
                    }
                }
            }
            "tool_use" => self.turn_moved_on(&run_id),
            "result" => self.run_idle(&run_id),
            // A failed TURN: the agent follows it with `run_status: idle` and
            // keeps the run. The error state is shown until then.
            "error" => self.run_error(&run_id),
            // A `status` used to mean "the turn moved on" too, and it cleared
            // the pending approval — but the agent sends a status for every
            // line the CLI writes to stderr, for a queued compaction, for an
            // API retry. None of those means the model answered the question
            // it is stopped on, so none may forget it. They still count as
            // work in progress for the state.
            //
            // Two statuses say the OPPOSITE of work and must not flip an idle
            // run back to working: `turn_settled` (the agent's "the person has
            // the floor") and the CLI's own `session_state: idle`, both of
            // which arrive AFTER the `result` that made the run idle.
            "system" | "status" if !is_quiet_status(&code, &event) => self.run_working(&run_id),
            _ => {}
        }
    }

    /// Any frame from the agent about this run is a sign of life. Dated here
    /// so a viewer can tell a long think from a hang (`lastEventAt`).
    ///
    /// Dating it is not enough: `activity` is only broadcast when a run's STATE
    /// changes, so a run that stays `working` for ten minutes pushed this value
    /// once — when the turn began — and the browser diffed that stamp against
    /// its own clock forever. The badge then read «нет событий 9 мин» over a
    /// transcript that was filling in front of you, because it was measuring
    /// the age of the turn. So re-broadcast on a heartbeat while frames keep
    /// arriving. 30 s: the badge only appears past 90 s of silence, so a third
    /// of that is finer than the thing it feeds, and it costs one small push
    /// per active run per half-minute rather than one per token.
    fn note_run_event(&mut self, run_id: &str) {
        let now = now_ms();
        let mut stale_on_the_wire = false;
        if let Some(run) = self.runs.get_mut(run_id) {
            run.last_event_at = now;
            if now - run.last_event_sent_at >= 30_000 {
                run.last_event_sent_at = now;
                stale_on_the_wire = true;
            }
        }
        if stale_on_the_wire {
            // Not one broadcast per run: with twenty runs working that was
            // forty full boards a minute to every viewer. The heartbeat only
            // marks the board stale; the hub's 500 ms tick publishes it ONCE
            // for every run that is due (`Hub::coalesce_tick`), and state
            // changes — which do not wait — carry it earlier when they can.
            self.activity_dirty.set(true);
        }
    }

    fn agent_tool_request(&mut self, v: &Value) {
        let run_id = v.field_string("runId").unwrap_or_default();
        let input = v
            .get("input")
            .cloned()
            .filter(|value| !value.is_null())
            .unwrap_or_else(|| json!({}));
        let mut out = json!({
            "type": message::TOOL_REQUEST,
            "runId": run_id,
            "sessionId": v.field_value("sessionId"),
            "requestId": v.field_value("requestId"),
            "tool": v.field_value("tool"),
            "input": input,
            "title": v.field_value("title"),
        });
        let sealed = v.get("e2e").filter(|e| e.is_object()).cloned();
        if let Some(env) = &sealed {
            out["e2e"] = env.clone();
        }
        self.to_run_deciders(&run_id, &out);
        self.note_run_event(&run_id);
        if let Some(run) = self.runs.get_mut(&run_id) {
            run.pending_request_id = v.field_string("requestId");
            run.pending_tool = v.field_string("tool");
            run.pending_tool_input = Some(input);
            run.pending_tool_title = v.field_string("title");
            run.pending_tool_e2e = sealed;
        }
        let replay = v.get("replay").and_then(Value::as_bool).unwrap_or(false);
        self.run_needs(&run_id, !replay);
    }

    fn agent_run_status(&mut self, conn: ConnId, v: &Value) {
        let run_id = v.field_string("runId").unwrap_or_default();
        let state = v.field_string("state").unwrap_or_default();
        // `closing` is hub-internal and never travels on: the frame below is
        // rebuilt field by field, so it is dropped there by construction. Only a
        // terminal state can carry it, and only `Some(true)` counts — absent
        // (every old agent, every Claude run) releases the session at once.
        let closing_key = (v.field_bool("closing") == Some(true)
            && matches!(state.as_str(), "ended" | "error" | "yielded"))
        .then(|| self.closing_writer_key(conn, &run_id, v))
        .flatten();
        let mut clock_changed = false;
        if let Some(start) = v
            .get("taskStartedAt")
            .and_then(Value::as_i64)
            .filter(|t| *t > 0)
        {
            if let Some(run) = self.runs.get_mut(&run_id) {
                let start = start.min(now_ms());
                if run.task_started_at.is_none_or(|old| start > old) {
                    run.task_started_at = Some(start);
                    clock_changed = true;
                }
            }
        }
        let out = json!({
            "type": message::RUN_STATUS,
            "runId": run_id,
            "sessionId": v.field_value("sessionId"),
            "state": state,
            "taskStartedAt": self.runs.get(&run_id).and_then(|r| r.task_started_at),
            "error": v.field_value("error"),
            // Private machine: the error text arrives sealed.
            "e2e": v.field_value("e2e"),
            // Why: `resume_refused` is what tells a client to put the message
            // it sent with the `open` back into the composer.
            "code": v.field_value("code"),
        });
        self.to_run_browsers(&run_id, &out);
        self.note_run_event(&run_id);
        match state.as_str() {
            "started" => self.run_working(&run_id),
            "idle" => self.run_idle(&run_id),
            "ended" | "yielded" => {
                self.release_run(&run_id);
                self.broadcast_activity();
            }
            "error" => {
                // What the agent said went wrong: the failure push quotes it.
                // A private machine's text arrives sealed (`e2e`) and stays so.
                if let Some(run) = self.runs.get_mut(&run_id) {
                    run.last_error = v
                        .field_string("error")
                        .map(|e| truncate(e.trim(), 300))
                        .filter(|e| !e.is_empty());
                }
                self.run_error_for(&run_id, true);
                self.release_run(&run_id);
                self.broadcast_activity();
            }
            _ => {}
        }
        if let Some(key) = closing_key {
            // The run is released like any other terminal one — clients are
            // told, the board moves on — but its process may still be writing,
            // so the session stays refused until `writer_released` or the
            // deadline. An enrolled agent could spray closing frames with made-up
            // ids for runs the hub never held; each machine's share is bounded —
            // expired entries go first, and a full share arms nothing more for
            // that machine (the old behaviour: the lock alone), rather than
            // growing until the reaper or crowding out other machines' guards.
            let prefix = format!(
                "{}::",
                self.conn_machine.get(&conn).cloned().unwrap_or_default()
            );
            let held = |m: &HashMap<String, ClosingWriter>| {
                m.keys().filter(|k| k.starts_with(&prefix)).count()
            };
            if held(&self.closing_writers) >= CLOSING_WRITERS_PER_MACHINE_MAX {
                self.expire_closing_writers();
            }
            if held(&self.closing_writers) >= CLOSING_WRITERS_PER_MACHINE_MAX {
                eprintln!(
                    "[hub] closing guard not armed for {key}: this machine already holds {CLOSING_WRITERS_PER_MACHINE_MAX}"
                );
                if clock_changed {
                    self.broadcast_activity();
                }
                return;
            }
            println!(
                "[hub] run {run_id} is over but its process may still be exiting — guarding {key} for up to {RUN_CLOSING_MAX_MS}ms"
            );
            self.closing_writers.insert(
                key,
                ClosingWriter {
                    run_id: run_id.clone(),
                    until_ms: now_ms() + RUN_CLOSING_MAX_MS,
                },
            );
        }
        if clock_changed {
            self.broadcast_activity();
        }
    }

    /// The guard key ("machine::session") for a terminal `run_status` that says
    /// `closing`, or None when there is nothing to guard. The machine is the
    /// SOCKET's, never a field of the frame, so an agent can only guard its own
    /// sessions; the session comes from the run when the hub still holds it
    /// (the hub may have released it already — a reaper, a failed run — while
    /// the process was still exiting) and from the frame otherwise.
    fn closing_writer_key(&self, conn: ConnId, run_id: &str, v: &Value) -> Option<String> {
        // A run id is a UUID; anything longer is not one of ours and must not
        // be stored (the frame itself may be megabytes).
        if run_id.is_empty() || run_id.len() > 64 {
            return None;
        }
        let machine = self.conn_machine.get(&conn)?;
        let session = self
            .runs
            .get(run_id)
            .map(|run| run.session_id.as_str())
            .filter(|s| !s.is_empty())
            .or_else(|| v.field_str("sessionId"))
            .filter(|s| !s.is_empty() && s.len() <= 512)?;
        let key = format!("{machine}::{session}");
        // Another run already holds the session: this frame is a straggler
        // from a writer that was replaced, and the live one is guarded by its
        // own lock.
        match self.lock_by_key.get(&key) {
            Some(holder) if holder != run_id => None,
            _ => Some(key),
        }
    }

    /// The agent confirms the process behind a closing run is gone: the
    /// session's guard ends now instead of at its deadline. Only the run that
    /// set the guard can clear it, and only on the machine that set it (the key
    /// is built from this socket's machine).
    fn agent_writer_released(&mut self, conn: ConnId, v: &Value) {
        let Some(machine) = self.conn_machine.get(&conn) else {
            return;
        };
        let (Some(session), Some(run_id)) = (v.field_str("sessionId"), v.field_str("runId")) else {
            return;
        };
        let key = format!("{machine}::{session}");
        if self
            .closing_writers
            .get(&key)
            .is_some_and(|closing| closing.run_id == run_id)
        {
            self.closing_writers.remove(&key);
            println!("[hub] writer of run {run_id} confirmed gone — {key} is open again");
        }
    }

    fn agent_session_started(&mut self, conn: ConnId, v: &Value) {
        let run_id = v.field_string("runId").unwrap_or_default();
        let session_id = v.field_string("sessionId").unwrap_or_default();
        if run_id.is_empty() || session_id.is_empty() {
            return;
        }
        let Some(machine) = self.conn_machine.get(&conn).cloned() else {
            return;
        };
        match self
            .workspaces
            .resolve_pending_session(&run_id, &machine, &session_id)
        {
            Ok(deleting) => {
                self.erased_sessions = self.workspaces.erased_session_keys().ok();
                if deleting {
                    self.send_to_agent(&machine, &json!({"type":"close","runId":run_id}));
                    self.end_run(&run_id, "account deletion");
                    return;
                }
            }
            Err(_) => return, // Keep the durable association on a storage failure.
        }
        if self.session_erased(&machine, &session_id) {
            self.send_to_agent(&machine, &json!({"type":"close","runId":run_id}));
            self.end_run(&run_id, "account deletion");
            return;
        }
        if self
            .runs
            .get(&run_id)
            .is_some_and(|r| r.machine_id != machine)
        {
            return;
        }
        let rekey = self.runs.get_mut(&run_id).map(|run| {
            let old = std::mem::replace(&mut run.session_id, session_id.clone());
            (run.machine_id.clone(), old)
        });
        let Some((machine_id, old_session)) = rekey else {
            return;
        };
        let old_key = if old_session.is_empty() {
            format!("{machine_id}::__new__::{run_id}")
        } else {
            format!("{machine_id}::{old_session}")
        };
        self.lock_by_key.remove(&old_key);
        self.lock_by_key
            .insert(format!("{machine_id}::{session_id}"), run_id.clone());

        let owner_info = self.runs.get(&run_id).and_then(|run| {
            run.owner_user_id
                .clone()
                .map(|owner| (owner, run.category.clone()))
        });
        if let Some((owner, category)) = owner_info {
            if let Err(e) = self.workspaces.record_session_owner(
                &machine_id,
                &session_id,
                &owner,
                category.as_deref(),
            ) {
                eprintln!("[hub] record_session_owner failed for session {session_id}: {e}");
            }
            // A category may name where the session BELONGS on the board, not
            // just which skill opens it. `rambling` does: its whole output is a
            // task nobody is working on yet, so it starts in Бэклог rather than
            // appearing as live work and having to be dragged there by hand.
            // Done here rather than in the client because the stage is the
            // hub's to keep — three clients would otherwise each need the rule,
            // and a session started from the phone would land somewhere else.
            let stage = category.as_deref().and_then(category_stage_on_start);
            if let Some(stage) = stage {
                if let Err(e) =
                    self.workspaces
                        .set_session_stage(&machine_id, &session_id, &owner, Some(stage))
                {
                    eprintln!("[hub] set_session_stage failed for session {session_id}: {e}");
                }
            }
            if !self.user_display.contains_key(&owner) {
                if let Ok(Some(user)) = self.workspaces.user_json(&owner) {
                    self.user_display.insert(owner.clone(), user);
                }
            }
            self.session_meta.insert(
                format!("{machine_id}::{session_id}"),
                SessionMeta {
                    owner_user_id: owner,
                    category,
                    stage: stage.map(str::to_string),
                    // Read back what resolve_pending_session persisted: the
                    // run's own origin would also be "fleet" for a human
                    // session merely resumed by `fleet send`.
                    origin: self
                        .workspaces
                        .session_owner_metadata(&machine_id, &session_id)
                        .ok()
                        .flatten()
                        .and_then(|m| m["origin"].as_str().map(str::to_string)),
                },
            );
        }
        self.task_links_on_session_started(&run_id, &session_id);
        self.to_run_browsers(
            &run_id,
            &json!({
                "type":message::SESSION_STARTED,
                "runId":run_id,
                "sessionId":session_id,
            }),
        );
        // A session got its id and its owner: that is news about ONE machine's
        // sessions, not the fleet (viewers that take no deltas still get a
        // coalesced snapshot). The whole entry, not a patch: the new owner can
        // HIDE the session from an owner-scoped viewer, and a patch cannot
        // remove what merely became invisible (review 24.10.2026).
        self.broadcast_machine_entry(std::slice::from_ref(&machine_id));
        self.broadcast_activity();
    }

    /// Relay a run's context budget to its viewers. Numbers only — the hub does
    /// no arithmetic on them, so the indicator can't disagree with the CLI that
    /// produced them.
    ///
    /// The agent re-reads it every 15 s for every run it holds, idle ones
    /// included, so most readings repeat the last one. Only a changed tuple is
    /// forwarded; the last forwarded frame is kept on the run and re-stated to
    /// whoever attaches later (`subscribe`), which is what the repeats used to
    /// do for them by accident.
    fn agent_context_usage(&mut self, v: &Value) {
        let run_id = v.field_string("runId").unwrap_or_default();
        let out = json!({
            "type":message::CONTEXT_USAGE,
            "runId":run_id,
            "sessionId":v.field_value("sessionId"),
            "totalTokens":v.field_value("totalTokens"),
            "maxTokens":v.field_value("maxTokens"),
            "percentage":v.field_value("percentage"),
            "autoCompactThreshold":v.field_value("autoCompactThreshold"),
            "autoCompactEnabled":v.field_value("autoCompactEnabled"),
        });
        if let Some(run) = self.runs.get_mut(&run_id) {
            if run.context_frame.as_ref() == Some(&out) {
                return;
            }
            run.context_frame = Some(out.clone());
        }
        self.to_run_browsers(&run_id, &out);
    }

    fn agent_run_mode(&mut self, v: &Value) {
        let run_id = v.field_string("runId").unwrap_or_default();
        let out = json!({
            "type":message::RUN_MODE,
            "runId":run_id,
            "sessionId":v.field_value("sessionId"),
            "mode":v.field_value("mode"),
        });
        self.to_run_browsers(&run_id, &out);
        // Kept so a browser that subscribes later is told the mode too. The
        // agent reports it once, when the runtime says so — a client that
        // reloads after that would otherwise sit on its own default.
        if let Some(run) = self.runs.get_mut(&run_id) {
            run.mode_frame = Some(out);
        }
    }

    /// The run's live model / reasoning settings. Forwarded and retained for the
    /// same reason as the mode: `set_model` / `set_effort` only travel outward,
    /// so this frame is the only thing that can put a picker back on the truth.
    fn agent_run_settings(&mut self, v: &Value) {
        let run_id = v.field_string("runId").unwrap_or_default();
        let out = clean(&json!({
            "type":message::RUN_SETTINGS,
            "runId":run_id,
            "sessionId":v.field_value("sessionId"),
            "model":v.field_value("model"),
            "activeModel":v.field_value("activeModel"),
            "effort":v.field_value("effort"),
            // Rebuilt field by field, so a new one is DROPPED until it is named
            // here — the frame is not passed through. `activeEffort` is what a
            // picker shows for a session nobody pinned; without this line the
            // agent reports it, the hub eats it, and the symptom is a UI that
            // still cannot name the level while every other layer looks right.
            "activeEffort":v.field_value("activeEffort"),
            "ultracode":v.field_value("ultracode"),
        }));
        self.to_run_browsers(&run_id, &out);
        if let Some(run) = self.runs.get_mut(&run_id) {
            run.settings_frame = Some(out);
        }
    }
}

/// Largest `background_tasks` frame kept for replay on subscribe.
const BACKGROUND_FRAME_MAX_BYTES: usize = 64 * 1024;
/// 32 agents × a 2000-char summary each fits; anything bigger is not kept.
const SUBAGENTS_FRAME_MAX_BYTES: usize = 128 * 1024;

/// A status frame that is not evidence of work: a stderr log line, or one of
/// the two "the turn is over" signals that follow a `result`.
fn is_quiet_status(code: &str, event: &Value) -> bool {
    match code {
        // A change in the set of background tasks is not the model working:
        // the list emptying is the task FINISHING, and it must not re-open a
        // run that already went idle (a turn that failed while a task ran).
        "stderr" | "turn_settled" | "background_tasks" | "subagents" => true,
        // What a command PRINTED is the tail of work already reported, never
        // the start of new work: in a live turn the `tool_use` before it has
        // made the run «working» already. Read as work, it re-opened finished
        // turns for good: 28.09.2026 a Codex `nmap` outlived the stop that
        // ended its turn, its output arrived 72 s after the `result`, and the
        // run said «работает…» for four hours over a thread that was idle.
        // Claude's `local_command_output` (a slash command's reply) is the
        // same kind of thing — nobody's turn.
        "command_output" => true,
        // A picker change answered or refused — possibly late (a booting CLI
        // answers 20–40 s on), so possibly after the turn went idle. A control
        // is nobody's turn either.
        "control_pending" | "control_applied" | "control_failed" => true,
        "session_state" => event
            .get("data")
            .and_then(|d| d.get("state"))
            .and_then(Value::as_str)
            .is_some_and(|s| s != "running"),
        _ => false,
    }
}
