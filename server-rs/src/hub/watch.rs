//! The hub's half of the watch / smart-push feature (docs/WATCH.md): what a
//! push says, answering a run from outside the WebSocket, the watch inbox and
//! the fleet Live Activity.
//!
//! Answering reuses the WebSocket's access gate verbatim. `ui_can_drive_run`
//! and the helpers under it judge a *connection* (`ui_access[conn]`), so an
//! action borrows a connection id that no socket can ever have, files the
//! person's `UiAccess` under it for the length of one synchronous check, and
//! removes it again (`drives_as`). One gate, not a second copy that could drift
//! from it; nothing awaits between insert and remove.

use serde_json::{json, Map, Value};

use super::*;
use crate::live_activity::{self, LiveAction};
use crate::push_action::{self, ActionError, Kind, Outcome, Pending};
use crate::push_payload::{excerpt, strip_markdown, PushContent};
use crate::watch_history;
use crate::workspace::UiAccess;

/// A connection id no socket gets: ids are handed out from 1 upwards.
const VIRTUAL_CONN: ConnId = ConnId::MAX;
/// Most items the watch inbox lists (the counts cover everything).
const INBOX_ITEMS_MAX: usize = 40;
const INBOX_PLAN_MAX: usize = 1500;
const INBOX_TEXT_MAX: usize = 400;
/// How long after an idle transition the watch is told a digest may still
/// come (`digestPending`): the summary call gives up after 7 s.
const DIGEST_PENDING_MS: i64 = 30_000;
/// How far back a session without a run still counts as recent work.
const RECENT_WINDOW_MS: i64 = 48 * 3_600_000;
/// What the summary model and the plain body read of the turn's text.
const ASSISTANT_TAIL_CHARS: usize = 6000;

/// An action as the HTTP layer hands it over, credential already checked.
#[derive(Debug, Clone)]
pub struct PushActionReq {
    pub user_id: String,
    /// The token's workspace; None in session mode (found from the run).
    pub workspace_id: Option<String>,
    /// Is the user a platform admin (feeds `ui_access`).
    pub admin: bool,
    pub run_id: String,
    pub request_id: Option<String>,
    pub token_kind: Option<Kind>,
    pub token: Option<TokenUse>,
    pub action: String,
    pub text: Option<String>,
    pub answers: Option<Map<String, Value>>,
}

#[derive(Debug, Clone)]
pub struct TokenUse {
    pub jti: String,
    pub exp: i64,
}

#[derive(Debug, Clone)]
pub enum LiveOp {
    Start {
        token: String,
    },
    Activity {
        id: String,
        token: String,
    },
    Ended {
        id: String,
    },
    /// The app is signing out: these tokens leave every user.
    Signout {
        tokens: Vec<String>,
    },
}

impl LiveOp {
    fn kind(&self) -> &'static str {
        match self {
            LiveOp::Start { .. } => "start",
            LiveOp::Activity { .. } => "activity",
            LiveOp::Ended { .. } => "ended",
            LiveOp::Signout { .. } => "signout",
        }
    }
}

/// The one ownership rule for the watch's lists: recorded as the caller's, or
/// unrecorded on a device the caller owns.
pub(super) fn is_callers(user: &str, owner: Option<&str>, device_owner: Option<&str>) -> bool {
    match owner {
        Some(o) => o == user,
        None => device_owner == Some(user),
    }
}

fn tail_chars(s: &str, max: usize) -> &str {
    let count = s.chars().count();
    if count <= max {
        return s;
    }
    let skip = s.char_indices().nth(count - max).map_or(0, |(i, _)| i);
    &s[skip..]
}

fn state_rank(state: &str) -> u8 {
    match state {
        "needs_attention" => 0,
        "error" => 1,
        "working" => 2,
        _ => 3,
    }
}

impl Hub {
    pub(super) fn watch_cfg(&self) -> &push_action::WatchConfig {
        self.watch_cfg
            .as_ref()
            .unwrap_or_else(|| push_action::config())
    }

    /// What a run is called in a push, the inbox and the activity: the session
    /// title, or the machine's name when the title is content the hub must not
    /// read (a private machine).
    pub(super) fn run_title(&self, r: &ActiveRun) -> String {
        if self.machine_private(&r.machine_id) {
            r.machine_name.clone()
        } else {
            r.title
                .clone()
                .unwrap_or_else(|| r.session_id.chars().take(8).collect())
        }
    }

    /// The part of a push beyond the bare transition: the pending question or
    /// plan, the turn's last text, the action token.
    pub(super) fn push_content(
        &self,
        run_id: &str,
        r: &ActiveRun,
        state: &str,
        owner: Option<&str>,
        workspace_id: Option<&str>,
        private: bool,
        releasing: bool,
    ) -> PushContent {
        let cfg = self.watch_cfg();
        let admin = owner.is_some_and(|o| cfg.admins.contains(o));
        // Rollout gate: the words of a run (question, plan, error, assistant
        // text) and every way to answer it from outside leave the hub for
        // admins only. Everyone else gets the generic Russian texts.
        let show = admin && !private;
        let act = (|| {
            if !show {
                return None;
            }
            let secret = cfg.secret.as_deref()?;
            let (owner, workspace) = (owner?, workspace_id?);
            let (request, kind) = match state {
                "needs_attention" => (
                    Some(r.pending_request_id.as_deref()?),
                    Kind::of_tool(r.pending_tool.as_deref()),
                ),
                // A run that is being released cannot be replied to.
                "error" if releasing => return None,
                "idle" | "error" => (None, Kind::Reply),
                _ => return None,
            };
            push_action::mint(
                secret,
                owner,
                workspace,
                run_id,
                request,
                kind,
                now_ms() / 1000,
            )
        })();
        PushContent {
            tool_input: r.pending_tool_input.clone().filter(|_| show),
            assistant_text: if state == "idle" && show {
                tail_chars(&r.text_buf, ASSISTANT_TAIL_CHARS).to_string()
            } else {
                String::new()
            },
            error: r.last_error.clone().filter(|_| state == "error" && show),
            act,
            no_actions: releasing && state == "error",
            summary: None,
            replies: Vec::new(),
            private,
        }
    }

    /// The person's access in the workspace that gives them a hand on this
    /// machine (the first such, as `emit_push` picks for a push).
    fn watch_access(&self, user: &str, machine_id: &str, admin: bool) -> Option<UiAccess> {
        let workspaces = self.workspaces.workspaces(user).ok()?;
        workspaces.iter().find_map(|workspace| {
            let id = workspace.get("workspaceId")?.as_str()?;
            let access = self.workspaces.ui_access(user, Some(id), admin).ok()?;
            let machine = self.workspaces.machine_access(&access, machine_id).ok()?;
            (machine.can_control || machine.can_start).then_some(access)
        })
    }

    /// May `access` drive this run — the WebSocket's `ui_can_drive_run`, asked
    /// about a person instead of a socket.
    pub(super) fn drives_as(&mut self, access: &UiAccess, run_id: &str) -> bool {
        self.ui_access.insert(VIRTUAL_CONN, access.clone());
        let ok = self
            .runs
            .get(run_id)
            .is_some_and(|run| self.ui_can_drive_run(VIRTUAL_CONN, run));
        self.ui_access.remove(&VIRTUAL_CONN);
        ok
    }

    // -------------------------------------------------------- push action

    pub(super) fn handle_push_action(&mut self, req: PushActionReq) -> Result<(), ActionError> {
        let now_s = now_ms() / 1000;
        let Some(run) = self.runs.get(&req.run_id) else {
            return Err(ActionError::RunGone);
        };
        let machine_id = run.machine_id.clone();
        let access = match &req.workspace_id {
            Some(ws) => self
                .workspaces
                .ui_access(&req.user_id, Some(ws), req.admin)
                .ok()
                // `ui_access` falls back to the first workspace for an unknown
                // id; a token names ONE workspace and gets that one or nothing.
                .filter(|a| &a.workspace_id == ws),
            None => self.watch_access(&req.user_id, &machine_id, req.admin),
        };
        let Some(access) = access else {
            return Err(ActionError::Forbidden);
        };
        if !self.drives_as(&access, &req.run_id) {
            return Err(ActionError::Forbidden);
        }
        if let Some(t) = &req.token {
            match self.workspaces.jti_is_spent(&t.jti) {
                Ok(false) => {}
                Ok(true) => return Err(ActionError::Used),
                Err(_) => return Err(ActionError::Internal),
            }
        }
        // The run is alive but its agent has no socket: the frame would fall on
        // the floor. Same refusal as `route_to_agent`.
        if !self.agent_online(&machine_id) {
            return Err(ActionError::MachineOffline);
        }
        // A private machine takes an answer's content only sealed, and a push
        // action cannot seal it.
        if self.machine_private(&machine_id) {
            return Err(ActionError::PrivateMachine);
        }
        let run = self.runs.get(&req.run_id).ok_or(ActionError::RunGone)?;
        let pending = Pending {
            request_id: run.pending_request_id.as_deref(),
            tool: run.pending_tool.as_deref(),
            input: run.pending_tool_input.as_ref(),
        };
        let outcome = push_action::resolve(
            req.token_kind,
            &req.action,
            req.text.as_deref(),
            req.answers.as_ref(),
            req.request_id.as_deref(),
            &pending,
        )?;
        // Check-and-spend is one statement; whoever loses the race gets `used`.
        // Everything that could refuse the action has been judged by now, so a
        // spent token always means the action went out.
        if let Some(t) = &req.token {
            match self.workspaces.jti_spend(&t.jti, t.exp, now_s) {
                Ok(true) => {}
                Ok(false) => return Err(ActionError::Used),
                Err(_) => return Err(ActionError::Internal),
            }
        }
        let by = run_by_of(&access);
        match outcome {
            Outcome::Decision(d) => {
                let mut frame = json!({
                    "type": "tool_decision",
                    "requestId": d.request_id,
                    "allow": d.allow,
                    "updatedInput": d.updated_input.unwrap_or(Value::Null),
                    "permissionMode": d.permission_mode.map_or(Value::Null, |m| json!(m)),
                    "message": d.message.map_or(Value::Null, Value::String),
                });
                if let Some(by) = by {
                    frame["by"] = by;
                }
                self.send_to_agent(&machine_id, &frame);
                self.settle_tool_request(&req.run_id, Some(d.request_id));
            }
            Outcome::Input(text) => {
                let session_id = run.session_id.clone();
                let turn = user_turn_frame(
                    &req.run_id,
                    &session_id,
                    Some(&text),
                    Some(&Value::Null),
                    Some(&Value::Null),
                );
                let mut input = json!({
                    "type": "input", "runId": req.run_id, "text": text,
                    "images": Value::Null, "files": Value::Null,
                });
                if let Some(by) = by {
                    input["by"] = by;
                }
                self.send_to_agent(&machine_id, &input);
                self.announce_user_turn(&req.run_id, turn);
                self.note_user_text(&req.run_id, &text);
            }
        }
        Ok(())
    }

    /// Remember what a person last typed (the push summary's context).
    pub(super) fn note_user_text(&mut self, run_id: &str, text: &str) {
        if let Some(r) = self.runs.get_mut(run_id) {
            r.last_user_text = truncate(text.trim(), 2000);
            // A human turn went in: the last turn's «что дальше» is spent even
            // before the agent reports the run working (WATCH.md §4).
            let key = format!("{}::{}", r.machine_id, r.session_id);
            self.watch_digests.remove(&key);
        }
    }

    /// The decision went out: forget the pending approval and tell every other
    /// viewer it is settled (shared by the WebSocket and push actions).
    pub(super) fn settle_tool_request(&mut self, run_id: &str, request_id: Option<String>) {
        if let Some(r) = self.runs.get_mut(run_id) {
            r.pending_request_id = None;
            r.pending_tool = None;
            r.pending_tool_input = None;
            r.pending_tool_title = None;
            r.pending_tool_e2e = None;
        }
        // The question was asked of EVERY viewer that may drive this run
        // (`to_run_deciders`), so the answer has to reach them too.
        if let Some(request_id) = request_id {
            self.to_run_deciders(
                run_id,
                &json!({
                    "type": message::TOOL_RESOLVED,
                    "runId": run_id,
                    "requestId": request_id,
                }),
            );
        }
    }

    // -------------------------------------------------------------- inbox

    pub(super) fn handle_watch_inbox(&mut self, user: &str) -> Value {
        let admin = self.watch_cfg().admins.contains(user);
        let mut device_owners: HashMap<String, Option<String>> = HashMap::new();
        let mut ids: Vec<String> = Vec::new();
        for (id, r) in &self.runs {
            let device_owner = device_owners
                .entry(r.machine_id.clone())
                .or_insert_with(|| self.workspaces.device_owner(&r.machine_id).ok().flatten());
            if is_callers(user, r.owner_user_id.as_deref(), device_owner.as_deref()) {
                ids.push(id.clone());
            }
        }
        let mut busy: HashSet<String> = HashSet::new();
        let mut access_by_machine: HashMap<String, Option<UiAccess>> = HashMap::new();
        let mut rows: Vec<(u8, i64, Value)> = Vec::new();
        let (mut waiting, mut working) = (0u32, 0u32);
        for id in ids {
            let Some(machine) = self.runs.get(&id).map(|r| r.machine_id.clone()) else {
                continue;
            };
            let access = access_by_machine
                .entry(machine.clone())
                .or_insert_with(|| self.watch_access(user, &machine, admin))
                .clone();
            let Some(access) = access else { continue };
            if !self.drives_as(&access, &id) {
                continue;
            }
            let Some(r) = self.runs.get(&id) else {
                continue;
            };
            busy.insert(format!("{}::{}", r.machine_id, r.session_id));
            match r.state.as_str() {
                "needs_attention" => waiting += 1,
                "working" => working += 1,
                _ => {}
            }
            rows.push((
                state_rank(&r.state),
                r.since,
                self.inbox_item(&id, r, admin),
            ));
        }
        rows.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
        let mut items: Vec<Value> = rows
            .into_iter()
            .take(INBOX_ITEMS_MAX)
            .map(|(_, _, v)| v)
            .collect();
        // Live runs first; what is left of the cap goes to recent sessions.
        let room = INBOX_ITEMS_MAX - items.len();
        if room > 0 {
            items.extend(
                self.recent_session_items(user, admin, &busy)
                    .into_iter()
                    .take(room),
            );
        }
        json!({ "waiting": waiting, "working": working, "items": items })
    }

    /// The person's own sessions with activity in the last 48 h and no run,
    /// newest first (docs/WATCH.md §4a). Read from what the hub already holds
    /// (the agents' inventories and the catalog of machines that are away):
    /// no transcript is opened. Each machine is judged as the web's session
    /// list judges it (`scoped_machine`, under the person's own access), so
    /// roots, erasure and share rules are the list's, not a copy of them.
    fn recent_session_items(
        &mut self,
        user: &str,
        admin: bool,
        busy: &HashSet<String>,
    ) -> Vec<Value> {
        let since = (now_ms() - RECENT_WINDOW_MS) as f64;
        let recent = |s: &Value| {
            s.get("lastModified")
                .and_then(Value::as_f64)
                .is_some_and(|t| t > since)
        };
        // Resolved once: this runs on the hub loop, for every machine with recent
        // sessions, on behalf of any active user.
        let accesses: Vec<UiAccess> = self
            .workspaces
            .workspaces(user)
            .unwrap_or_default()
            .iter()
            .filter_map(|w| {
                let id = w.get("workspaceId")?.as_str()?;
                self.workspaces.ui_access(user, Some(id), admin).ok()
            })
            .collect();
        let access_on = |hub: &Self, machine: &str| {
            accesses
                .iter()
                .find(|a| {
                    hub.workspaces
                        .machine_access(a, machine)
                        .is_ok_and(|m| m.can_control || m.can_start)
                })
                .cloned()
        };
        let mut by_machine: HashMap<String, (Value, bool, Vec<Value>)> = HashMap::new();
        for (id, agent) in &self.agents {
            // Other tenants' inventories are not even copied.
            if !agent.sessions.iter().any(&recent) || access_on(&*self, id).is_none() {
                continue;
            }
            let sessions: Vec<Value> = agent
                .sessions
                .iter()
                .filter(|s| recent(s))
                .cloned()
                .collect();
            by_machine.insert(id.clone(), (agent.machine.clone(), true, sessions));
        }
        let online: HashSet<String> = self.agents.keys().cloned().collect();
        // The cap counts only machines this person reaches: other tenants' busy
        // machines must not push their own sessions out of it.
        let recent_rows = {
            let hub = &*self;
            hub.store.recent_sessions(
                since,
                &online,
                &mut |machine| access_on(hub, machine).is_some(),
                INBOX_ITEMS_MAX * 5,
            )
        };
        match recent_rows {
            Ok(rows) => {
                for (id, machine, session) in rows {
                    by_machine
                        .entry(id)
                        .or_insert_with(|| (machine, false, Vec::new()))
                        .2
                        .push(session);
                }
            }
            Err(e) => eprintln!("[hub] watch inbox: recent sessions read failed: {e}"),
        }
        let mut out: Vec<(i64, Value)> = Vec::new();
        for (machine_id, (machine, is_online, sessions)) in by_machine {
            let Some(access) = access_on(self, &machine_id) else {
                continue;
            };
            let machine_name = machine
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let private = self.machine_private(&machine_id);
            let device_owner = self.workspaces.device_owner(&machine_id).ok().flatten();
            self.ui_access.insert(VIRTUAL_CONN, access);
            let scoped = self.scoped_machine(
                VIRTUAL_CONN,
                json!({"machine": machine, "online": is_online, "sessions": sessions}),
            );
            self.ui_access.remove(&VIRTUAL_CONN);
            let Some(scoped) = scoped else { continue };
            let Some(list) = scoped.get("sessions").and_then(Value::as_array) else {
                continue;
            };
            for s in list {
                let Some(sid) = s.get("sessionId").and_then(Value::as_str) else {
                    continue;
                };
                if busy.contains(&format!("{machine_id}::{sid}"))
                    || s.get("automated").and_then(Value::as_bool) == Some(true)
                    || s.get("archived").and_then(Value::as_bool) == Some(true)
                    || self.session_deletion_in_flight_or_done(&machine_id, sid)
                {
                    continue;
                }
                // «Own»: recorded as the person's, or unrecorded on their device.
                if !is_callers(
                    user,
                    self.session_owner(&machine_id, sid),
                    device_owner.as_deref(),
                ) {
                    continue;
                }
                let at = s.get("lastModified").and_then(Value::as_f64).unwrap_or(0.0) as i64;
                let title = if private {
                    machine_name.clone()
                } else {
                    s.get("title")
                        .and_then(Value::as_str)
                        .filter(|t| !t.trim().is_empty())
                        .map_or_else(|| sid.chars().take(8).collect(), str::to_string)
                };
                let mut item = json!({
                    "machineId": machine_id,
                    "sessionId": sid,
                    "source": s.get("source").and_then(Value::as_str).unwrap_or("claude"),
                    "title": title,
                    "machine": machine_name,
                    "state": "idle",
                    "lastModifiedMs": at,
                });
                // The digest still describes the session if nothing was
                // written after it was made.
                if admin && !private && !self.session_erased(&machine_id, sid) {
                    if let Some(d) = self
                        .watch_digests
                        .get(&format!("{machine_id}::{sid}"))
                        .filter(|d| at <= d.made_ms)
                    {
                        Self::put_digest(&mut item, d);
                    }
                }
                out.push((at, item));
            }
        }
        out.sort_by_key(|row| std::cmp::Reverse(row.0));
        out.into_iter().map(|(_, v)| v).collect()
    }

    // ------------------------------------------------------------ history

    /// `GET /api/watch/history` (docs/WATCH.md §4b): the tail of a session's
    /// transcript from the replica, shrunk for the watch. Same view gate as the
    /// WebSocket's `session.messages`. The read is the one `session.messages`
    /// does on this loop (a bounded tail of an indexed table).
    pub(super) fn handle_watch_history(
        &mut self,
        user: &str,
        machine_id: &str,
        session_id: &str,
        source: Option<&str>,
        limit: usize,
    ) -> Result<Value, (u16, &'static str)> {
        let admin = self.watch_cfg().admins.contains(user);
        let Some(access) = self.watch_access(user, machine_id, admin) else {
            return Err((403, "forbidden"));
        };
        self.ui_access.insert(VIRTUAL_CONN, access.clone());
        let allowed = self.ui_can_view_session(VIRTUAL_CONN, machine_id, session_id, None);
        self.ui_access.remove(&VIRTUAL_CONN);
        if !allowed || self.session_deletion_in_flight_or_done(machine_id, session_id) {
            return Err((403, "forbidden"));
        }
        // The replica of a private machine is sealed; the hub cannot read it.
        if self.machine_private(machine_id) {
            return Err((403, "private_machine"));
        }
        // Reading someone else's transcript leaves the same row as `session.messages`.
        let can_control = self
            .workspaces
            .machine_access(&access, machine_id)
            .is_ok_and(|m| m.can_control);
        if !can_control {
            if let Err(e) = self.workspaces.audit(
                &access.workspace_id,
                &access.user_id,
                "session.viewed",
                "session",
                session_id,
                &json!({ "machineId": machine_id }),
            ) {
                eprintln!("[hub] audit session.viewed failed: {e}");
            }
        }
        let sources: &[&str] = match source {
            Some("codex") => &["codex"],
            Some(_) => &["claude"],
            None => &["claude", "codex"],
        };
        let mut raw = None;
        for src in sources {
            match self.store.read_history_tail(
                machine_id,
                src,
                session_id,
                Some(watch_history::RAW_TAIL + 1),
            ) {
                Ok(Some(rows)) => {
                    raw = Some(rows);
                    break;
                }
                Ok(None) => {}
                Err(e) => {
                    eprintln!("[hub] watch history read failed for {machine_id}/{session_id}: {e}");
                    return Err((500, "internal"));
                }
            }
        }
        let Some(mut rows) = raw else {
            return Err((404, "not_found"));
        };
        let mut more = rows.len() > watch_history::RAW_TAIL;
        if more {
            rows.remove(0);
        }
        let mut items = watch_history::simplify(&rows);
        if items.len() > limit {
            items.drain(..items.len() - limit);
            more = true;
        }
        Ok(json!({ "items": items, "more": more }))
    }

    // -------------------------------------------- reply without a live run

    /// `POST /api/push-action` `reply` naming a session instead of a run
    /// (docs/WATCH.md §4c). A live run takes the text as `input` through
    /// `handle_push_action`; a session with none is resumed through
    /// `resume_session`, the core `/api/fleet/send` and the browser's `open`
    /// share, so the livePid refusal, the per-session lock and the writer-closing
    /// wait are the ones every other writer meets.
    pub(super) fn handle_watch_session_reply(
        &mut self,
        user: &str,
        machine_id: &str,
        session_id: &str,
        source: Option<&str>,
        text: Option<&str>,
    ) -> Result<(), ActionError> {
        let admin = self.watch_cfg().admins.contains(user);
        let none = Pending {
            request_id: None,
            tool: None,
            input: None,
        };
        let Outcome::Input(text) = push_action::resolve(None, "reply", text, None, None, &none)?
        else {
            return Err(ActionError::BadRequest("text_required"));
        };
        let Some(access) = self.watch_access(user, machine_id, admin) else {
            return Err(ActionError::Forbidden);
        };
        // A live run of the session: a normal input.
        if let Some(run_id) = self
            .lock_by_key
            .get(&format!("{machine_id}::{session_id}"))
            .cloned()
        {
            let owner = self.runs.get(&run_id).and_then(|r| r.owner_user_id.clone());
            let device_owner = self.workspaces.device_owner(machine_id).ok().flatten();
            if !is_callers(user, owner.as_deref(), device_owner.as_deref()) {
                return Err(ActionError::Forbidden);
            }
            return self.handle_push_action(PushActionReq {
                user_id: user.to_string(),
                workspace_id: None,
                admin,
                run_id,
                request_id: None,
                token_kind: None,
                token: None,
                action: "reply".into(),
                text: Some(text),
                answers: None,
            });
        }
        self.ui_access.insert(VIRTUAL_CONN, access.clone());
        let allowed = self.ui_can_view_session(VIRTUAL_CONN, machine_id, session_id, None);
        self.ui_access.remove(&VIRTUAL_CONN);
        let can_control = self
            .workspaces
            .machine_access(&access, machine_id)
            .is_ok_and(|m| m.can_control);
        // Resuming runs the owner's coder on the owner's machine: full control
        // of it, not a share's reach.
        if !allowed
            || !can_control
            || self.session_deletion_in_flight_or_done(machine_id, session_id)
        {
            return Err(ActionError::Forbidden);
        }
        if self.machine_private(machine_id) {
            return Err(ActionError::PrivateMachine);
        }
        if !self.agent_online(machine_id) {
            return Err(ActionError::MachineOffline);
        }
        let known = self.agents.get(machine_id).and_then(|a| {
            a.sessions
                .iter()
                .find(|s| s.get("sessionId").and_then(Value::as_str) == Some(session_id))
        });
        let Some(known) = known else {
            return Err(ActionError::SessionGone);
        };
        let known_source = known
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("claude");
        if source.is_some_and(|s| s != known_source) {
            return Err(ActionError::BadRequest("source_mismatch"));
        }
        self.resume_session(ResumeSpec {
            sealed: None,
            machine_id: machine_id.to_string(),
            session_id: session_id.to_string(),
            message: Some(text),
            images: None,
            files: None,
            force: false,
            picked: start_settings(&Value::Null, false),
            attach: None,
            can_control: true,
            origin: Some("app".into()),
            run_by: run_by_of(&access),
        })
        .map_err(|frame| {
            let message = frame["message"].as_str().unwrap_or_default();
            if frame["code"] == "run_active"
                || message.starts_with("Session is live in")
                || message == WRITER_CLOSING_REFUSAL
            {
                ActionError::Busy
            } else if message.starts_with("Machine is") {
                ActionError::MachineOffline
            } else if frame["code"] == "private_machine" {
                ActionError::PrivateMachine
            } else if message.starts_with("Session access denied") {
                ActionError::Forbidden
            } else {
                ActionError::SessionGone
            }
        })?;
        // No ownership stamp: a run with no recorded owner is the person's when
        // the device is theirs (`is_callers`), and the push falls back to the
        // machine owner, so nothing depends on an in-memory stamp.
        Ok(())
    }

    fn inbox_item(&self, run_id: &str, r: &ActiveRun, admin: bool) -> Value {
        let private = self.machine_private(&r.machine_id);
        let mut item = json!({
            "runId": run_id,
            "machineId": r.machine_id,
            "sessionId": r.session_id,
            "title": self.run_title(r),
            "machine": r.machine_name,
            "state": r.state,
            "sinceMs": r.since,
        });
        if r.state == "needs_attention" {
            // A private machine refuses every push action (it takes answers
            // sealed only), so its request is not offered as one to answer.
            if let Some(req) = r.pending_request_id.as_ref().filter(|_| !private) {
                item["requestId"] = json!(req);
            }
            if let Some(tool) = &r.pending_tool {
                item["tool"] = json!(tool);
            }
            if !private {
                match (r.pending_tool.as_deref(), &r.pending_tool_input) {
                    (Some("AskUserQuestion"), Some(input)) => {
                        let qs: Vec<Value> = push_action::parse_questions(input)
                            .into_iter()
                            .take(4)
                            .map(|q| {
                                json!({
                                    "key": q.key,
                                    "question": q.question,
                                    "options": q.options.into_iter().take(8).collect::<Vec<_>>(),
                                    "multiSelect": q.multi_select,
                                })
                            })
                            .collect();
                        if !qs.is_empty() {
                            item["questions"] = Value::Array(qs);
                        }
                    }
                    (Some("ExitPlanMode"), Some(input)) => {
                        if let Some(plan) = input.get("plan").and_then(Value::as_str) {
                            let plain = strip_markdown(plan);
                            if !plain.is_empty() {
                                item["plan"] = json!(excerpt(&plain, INBOX_PLAN_MAX));
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        if !private {
            let text = if r.text_buf.trim().is_empty() {
                r.preview.as_deref().unwrap_or("")
            } else {
                tail_chars(&r.text_buf, 2000)
            };
            let plain = strip_markdown(text);
            if !plain.is_empty() {
                item["lastText"] = json!(excerpt(&plain, INBOX_TEXT_MAX));
            }
            // Absent when unknown, never null (docs/WATCH.md §4).
            if let Some(plan) = &r.plan {
                let mut progress = json!({"done": plan.done, "total": plan.total});
                if let Some(active) = &plan.active {
                    progress["active"] = json!(active);
                }
                if !plan.steps.is_empty() {
                    progress["steps"] = Value::Array(
                        plan.steps
                            .iter()
                            .map(|(text, status)| json!({"text": text, "status": status}))
                            .collect(),
                    );
                }
                item["progress"] = progress;
            }
            // `task_started_at` is the last human turn the agent accepted.
            if let Some(started) = r.task_started_at {
                item["startedMs"] = json!(started);
            }
            if let Some(pct) = r
                .context_frame
                .as_ref()
                .and_then(|f| f.get("percentage"))
                .and_then(Value::as_f64)
                .filter(|p| p.is_finite())
            {
                item["contextPct"] = json!(pct.round().clamp(0.0, 100.0) as u32);
            }
            // The frame is only kept while the list is non-empty, and the
            // agent lists live tasks only: every entry is still running.
            let background = r
                .background_frame
                .as_ref()
                .and_then(|f| f.get("event"))
                .and_then(|e| e.get("data"))
                .and_then(|d| d.get("tasks"))
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            if background > 0 {
                item["background"] = json!(background);
            }
            if admin && r.state == "idle" && !self.session_erased(&r.machine_id, &r.session_id) {
                let key = format!("{}::{}", r.machine_id, r.session_id);
                if let Some(d) = self.watch_digests.get(&key).filter(|d| d.since == r.since) {
                    Self::put_digest(&mut item, d);
                } else if self.enrich.is_some()
                    && self.notify.is_some()
                    && r.owner_user_id
                        .as_deref()
                        .is_some_and(|o| self.watch_cfg().admins.contains(o))
                    && now_ms() - r.since < DIGEST_PENDING_MS
                {
                    // The summary job runs for a few seconds after the idle
                    // transition (PUSH_SUMMARY_TIMEOUT): tell the watch to wait
                    // for it, and only where one can come at all.
                    item["digestPending"] = json!(true);
                }
            }
        }
        item
    }

    /// `summary` and `replies` (omitted when none) of a remembered digest.
    fn put_digest(item: &mut Value, d: &WatchDigest) {
        item["summary"] = json!(d.summary);
        if !d.replies.is_empty() {
            item["replies"] = Value::Array(
                d.replies
                    .iter()
                    .map(|r| json!({"label": r.label, "send": r.send}))
                    .collect(),
            );
        }
    }

    // ------------------------------------------------------ live activity

    pub(super) fn handle_live_activity(&mut self, user: &str, op: LiveOp) -> Result<(), String> {
        let now = now_ms();
        // No token in the log; which kinds arrive is what a stuck card turns on.
        println!("[live] app reported: {}", op.kind());
        match &op {
            LiveOp::Start { token } => {
                self.workspaces.live_token_put(user, token, None, now)?;
                self.live.add_start(user, token);
            }
            LiveOp::Activity { id, token } => {
                self.workspaces.live_token_put(user, token, Some(id), now)?;
                self.live.set_activity(user, id, token);
            }
            LiveOp::Ended { id } => {
                self.workspaces.live_token_delete_activity(user, id)?;
                self.live.activity_ended(user, id);
            }
            LiveOp::Signout { tokens } => {
                self.workspaces.live_tokens_delete_many(tokens)?;
                for token in tokens {
                    self.live.forget_token(token);
                }
            }
        }
        self.live_pending_start_save(user);
        // Look at the fleet afresh: a new token may be owed a start.
        self.live_dirty.set(true);
        Ok(())
    }

    fn live_pending_start_save(&self, user: &str) {
        let pending = self.live.unconfirmed_start(user);
        if let Err(e) = self.workspaces.live_pending_start_set(user, pending) {
            eprintln!("[live] pending start not saved: {e}");
        }
    }

    /// The notifier's report on a Live Activity push: state commits only on
    /// success, a transient failure retries (bounded), dead tokens and ended
    /// activities leave the database.
    pub(super) fn live_sent(
        &mut self,
        user: &str,
        kind: live_activity::LiveKind,
        results: &[(String, live_activity::LiveOutcome)],
    ) {
        let dropped = self.live.sent(user, kind, results, now_ms());
        if !dropped.is_empty() {
            let _ = self.workspaces.live_tokens_delete_many(&dropped);
        }
        self.live_pending_start_save(user);
    }

    /// The user's runs that count for the activity: working or waiting, theirs,
    /// still visible to them.
    pub(super) fn live_snapshot(&self, user: &str) -> live_activity::Snapshot {
        // Fail closed: tokens outlive a person's active state in the database.
        if !self.workspaces.is_active(user) {
            return live_activity::Snapshot::default();
        }
        let runs: Vec<(String, &str, i64, Option<(u32, u32)>)> = self
            .runs
            .values()
            .filter(|r| {
                r.owner_user_id.as_deref() == Some(user)
                    && matches!(r.state.as_str(), "working" | "needs_attention")
                    && !self.session_erased(&r.machine_id, &r.session_id)
                    && self.owner_may_see_run(user, r)
            })
            .map(|r| {
                let state = if r.state == "working" {
                    "working"
                } else {
                    "needs_attention"
                };
                (
                    self.run_title(r),
                    state,
                    r.since,
                    r.plan.as_ref().map(|p| (p.done, p.total)),
                )
            })
            .collect();
        live_activity::snapshot_with_plans(&runs)
    }

    /// Called from the 500 ms coalescing tick: take fresh snapshots when some
    /// run moved, then send whatever the state machine says is due. Never
    /// waits on the network — the notifier task delivers.
    pub(super) fn live_tick(&mut self) {
        if self.live.is_empty() {
            self.live_dirty.set(false);
            return;
        }
        let now = now_ms();
        // After a restart `runs` is empty until the agents re-register: judged
        // now, every activity would be ended and started again.
        if now < self.live_grace_until_ms {
            return;
        }
        if self.live_dirty.replace(false) {
            for user in self.live.users() {
                let snap = self.live_snapshot(&user);
                self.live.observe(&user, snap, now);
            }
        }
        for (user, action, snap) in self.live.due(now) {
            let (priority, body) = live_activity::request(&action, &snap, now);
            let tokens = match &action {
                LiveAction::Start { tokens } => tokens.clone(),
                LiveAction::Update { tokens, .. } | LiveAction::End { tokens } => tokens.clone(),
            };
            let kind = action.kind();
            let queued = self.notify.as_ref().is_some_and(|tx| {
                tx.send(crate::notify::Outbound::Live(crate::notify::LivePush {
                    user_id: user.clone(),
                    kind,
                    tokens: tokens.clone(),
                    priority,
                    body,
                }))
                .is_ok()
            });
            if queued {
                self.live_pending_start_save(&user);
            } else {
                // No notifier will ever report on this push: say so here, or a
                // start that never left would hold back the next one for hours.
                let failed: Vec<_> = tokens
                    .into_iter()
                    .map(|t| (t, live_activity::LiveOutcome::Transient))
                    .collect();
                self.live_sent(&user, kind, &failed);
            }
        }
    }
}

/// The ACTING person as the wire `runBy` object — the one clicking, never the
/// device owner.
pub(super) fn run_by_of(a: &UiAccess) -> Option<Value> {
    if a.user_id.is_empty() {
        return None;
    }
    let mut by = json!({"userId": a.user_id});
    if let Some(email) = a.viewer.get("email").and_then(Value::as_str) {
        if !email.is_empty() {
            by["email"] = json!(email);
        }
    }
    Some(by)
}
