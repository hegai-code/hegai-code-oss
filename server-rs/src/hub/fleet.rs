//! The fleet API's half inside the hub: start, continue and watch sessions on
//! the owner's behalf with nobody attached (`fleet_api.rs` is the HTTP half).
//!
//! Every call names the owner it acts for, and every machine it touches must
//! belong to that owner and must not be a sandbox — checked here against
//! `devices`, never trusted from the caller or from what an agent says about
//! itself. A sandbox is refused as a TARGET as well as a key holder: a session
//! the dispatcher opens there reads files the sandbox's people wrote, and its
//! answer flows back into a dispatcher that holds the whole fleet.
//!
//! Continuing a session goes through `resume_session`, the same core a
//! browser's `open` uses, so the single-writer layers (livePid refusal,
//! per-session lock, agent-side re-check) are the ones every other writer
//! meets. A fleet caller can never take over: `force` is always false.

use super::*;

/// Most of a final answer a status read carries back. A report is a few KB; a
/// runaway dump should not become a multi-megabyte HTTP body.
const FLEET_LAST_TEXT_MAX: usize = 64_000;

/// Refusal with the HTTP status the API should answer with.
pub(crate) type FleetError = (u16, String);

/// What a `send` / `status` addresses: a run the caller already holds, or a
/// session by machine and id.
pub(crate) enum FleetTarget {
    Run(String),
    Session { machine: String, session_id: String },
}

/// Why a machine counts as a sandbox, if it does. `kind` alone is not honest:
/// the employee sandbox `devbox` was enrolled `personal` and is recognisable
/// only by the project shares that put other people on it
/// (`WorkspaceStore::device_has_shares`).
pub(crate) fn sandbox_sign(
    kind: Option<&str>,
    machine_id: &str,
    name: Option<&str>,
    has_shares: bool,
) -> Option<&'static str> {
    if kind == Some("sandbox") {
        return Some("enrolled as a sandbox");
    }
    if machine_id.starts_with("sb-") || name.is_some_and(|n| n.starts_with("sb-")) {
        return Some("an sb- sandbox");
    }
    if has_shares {
        return Some("shared with other people");
    }
    None
}

/// One of the owner's enrolled machines, as the `devices` table knows it.
struct OwnedMachine {
    machine_id: String,
    /// The name recorded at enrollment — not the one an agent announces in
    /// `register`, which a process on that box could change.
    name: String,
}

impl Hub {
    /// The owner's machines a fleet call may touch: enrolled to them, not
    /// revoked, not a sandbox. A database error refuses (empty list).
    fn fleet_machines_of(&self, owner_user_id: &str) -> Vec<OwnedMachine> {
        let Ok(devices) = self.workspaces.devices_for_user(owner_user_id) else {
            return Vec::new();
        };
        devices
            .into_iter()
            .filter(|d| d["revoked"] != true)
            .filter_map(|d| {
                let machine_id = d["machineId"].as_str()?.to_string();
                let name = d["name"].as_str().unwrap_or_default().to_string();
                let kind = self.workspaces.device_kind(&machine_id).ok()?;
                let shares = self.workspaces.device_has_shares(&machine_id).ok()?;
                sandbox_sign(kind.as_deref(), &machine_id, Some(&name), shares)
                    .is_none()
                    .then_some(OwnedMachine { machine_id, name })
            })
            .collect()
    }

    pub(super) fn fleet_may_touch(&self, owner_user_id: &str, machine_id: &str) -> bool {
        self.fleet_machines_of(owner_user_id)
            .iter()
            .any(|m| m.machine_id == machine_id)
    }

    /// Accept a machine id or its enrolled name — the caller types names —
    /// among the machines this owner may touch.
    pub(super) fn fleet_resolve_machine(
        &self,
        owner_user_id: &str,
        wanted: &str,
    ) -> Result<String, FleetError> {
        let mine = self.fleet_machines_of(owner_user_id);
        // A private machine (docs/E2EE.md) is content-blind to this hub: the
        // dispatcher can neither send it text (it would be plaintext on the
        // hub) nor read its status back. Refused by name, not hidden, so the
        // caller learns why.
        let private = |id: &str| -> Result<String, FleetError> {
            if self.machine_private(id) {
                Err((403, "private_machine: this machine is end-to-end encrypted; the fleet API cannot send to it or read it.".into()))
            } else {
                Ok(id.to_string())
            }
        };
        if let Some(m) = mine.iter().find(|m| m.machine_id == wanted) {
            return private(&m.machine_id);
        }
        let hits: Vec<&OwnedMachine> = mine.iter().filter(|m| m.name == wanted).collect();
        match hits.as_slice() {
            [one] => private(&one.machine_id),
            [] => Err((404, format!("no machine «{wanted}» of yours"))),
            _ => Err((
                409,
                format!("«{wanted}» names several machines; pass the machine id"),
            )),
        }
    }

    fn fleet_owner_name(&self, owner_user_id: &str) -> Option<String> {
        self.user_display
            .get(owner_user_id)
            .and_then(|u| {
                u.get("fullName")
                    .or_else(|| u.get("email"))
                    .and_then(Value::as_str)
            })
            .map(str::to_string)
    }

    pub(super) fn fleet_machines(&self, owner_user_id: &str) -> Value {
        let mut list: Vec<Value> = self
            .fleet_machines_of(owner_user_id)
            .into_iter()
            .map(|m| {
                json!({
                    "machineId": m.machine_id,
                    "name": m.name,
                    "online": self.agent_online(&m.machine_id),
                    "gatewaySessions": self.agents.get(&m.machine_id)
                        .and_then(|a| a.machine.get("gatewaySessions"))
                        .and_then(Value::as_bool).unwrap_or(false),
                })
            })
            .collect();
        list.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        json!({ "machines": list })
    }

    pub(super) fn fleet_spawn(
        &mut self,
        owner_user_id: &str,
        machine: &str,
        cwd: &str,
        message: &str,
        settings: &Value,
        task: Option<&TaskTag>,
    ) -> Result<Value, FleetError> {
        // Before anything is spawned: a task that is not there refuses the call.
        if let Some(tag) = task {
            self.fleet_task_must_exist(owner_user_id, &tag.task_id)?;
        }
        let machine_id = self.fleet_resolve_machine(owner_user_id, machine)?;
        if !cwd.starts_with('/') && cwd.chars().nth(1) != Some(':') {
            return Err((400, "cwd must be an absolute path".into()));
        }
        let require_gateway = match settings.get("requireGateway") {
            None | Some(Value::Null) => false,
            Some(Value::Bool(value)) => *value,
            _ => return Err((400, "requireGateway must be a boolean".into())),
        };
        let picked = start_settings(settings, false);
        let source = settings
            .get("source")
            .and_then(Value::as_str)
            .filter(|s| *s == "claude" || *s == "codex")
            .map(str::to_string);
        if require_gateway && source.as_deref() != Some("codex") {
            return Err((400, "Internal gateway jobs require source codex".into()));
        }
        let run_id = self
            .spawn_session(SpawnSpec {
                sealed: None,
                machine_id: machine_id.clone(),
                cwd: cwd.to_string(),
                message: Some(message.to_string()),
                images: None,
                files: None,
                category: None,
                source,
                require_gateway,
                // The machine's own default, as for a session started from a
                // phone without touching the picker.
                permission_mode: None,
                model: picked.model,
                effort: picked.effort,
                owner_user_id: Some(owner_user_id.to_string()),
                owner_name: self.fleet_owner_name(owner_user_id),
                origin: Some("fleet".into()),
                attach: None,
                run_by: None,
            })
            .map_err(|m| (503, m))?;
        let mut out = json!({"runId": run_id, "machineId": machine_id, "resumed": false});
        if let Some(tag) = task {
            // The session is not known yet: the link waits for session_started.
            self.fleet_tag_result(owner_user_id, tag, Some(cwd), &mut out);
        }
        Ok(out)
    }

    /// The open run a target names, if the caller may drive it. A run on a
    /// machine they may not touch reads as closed (no probing for run ids);
    /// a run someone ELSE opened on their machine — a teammate on a shared
    /// root — is refused: input from the dispatcher does not go into work a
    /// person is driving.
    pub(super) fn fleet_run_for(
        &self,
        owner_user_id: &str,
        target: &FleetTarget,
    ) -> Result<Option<String>, FleetError> {
        let run_id = match target {
            FleetTarget::Run(run_id) => run_id.clone(),
            FleetTarget::Session {
                machine,
                session_id,
            } => {
                let machine_id = self.fleet_resolve_machine(owner_user_id, machine)?;
                match self.lock_by_key.get(&format!("{machine_id}::{session_id}")) {
                    Some(run_id) => run_id.clone(),
                    None => return Ok(None),
                }
            }
        };
        let Some(run) = self.runs.get(&run_id) else {
            return Ok(None);
        };
        if !self.fleet_may_touch(owner_user_id, &run.machine_id) {
            return Ok(None);
        }
        if self.machine_private(&run.machine_id) {
            return Err((
                403,
                "private_machine: this machine is end-to-end encrypted; the fleet API cannot send to it or read it.".into(),
            ));
        }
        if run
            .owner_user_id
            .as_deref()
            .is_some_and(|o| o != owner_user_id)
        {
            return Err((
                409,
                format!("run {run_id} belongs to someone else; open it in Hegai Code"),
            ));
        }
        Ok(Some(run_id))
    }

    /// Hand a session its next turn. An open idle run takes it as input; no run
    /// at all resumes the session; a run that is working, waiting on a
    /// question or errored is refused — the caller waits, it does not queue.
    pub(super) fn fleet_send(
        &mut self,
        owner_user_id: &str,
        target: &FleetTarget,
        message: &str,
        settings: &Value,
        task: Option<&TaskTag>,
    ) -> Result<Value, FleetError> {
        if let Some(tag) = task {
            self.fleet_task_must_exist(owner_user_id, &tag.task_id)?;
            self.fleet_task_target_free(owner_user_id, &tag.task_id, target)?;
        }
        let mut out = self.fleet_send_turn(owner_user_id, target, message, settings)?;
        if let Some(tag) = task {
            self.fleet_tag_result(owner_user_id, tag, None, &mut out);
        }
        Ok(out)
    }

    fn fleet_send_turn(
        &mut self,
        owner_user_id: &str,
        target: &FleetTarget,
        message: &str,
        settings: &Value,
    ) -> Result<Value, FleetError> {
        let Some(run_id) = self.fleet_run_for(owner_user_id, target)? else {
            return match target {
                FleetTarget::Session {
                    machine,
                    session_id,
                } => {
                    let machine_id = self.fleet_resolve_machine(owner_user_id, machine)?;
                    self.fleet_resume(&machine_id, session_id, message, settings)
                }
                FleetTarget::Run(_) => Err((
                    409,
                    "that run is closed; continue by machine:sessionId".into(),
                )),
            };
        };
        // An open run keeps its model; only a resume can pick one. Saying so
        // beats running the turn on something the caller did not ask for.
        if !settings["model"].is_null() || !settings["effort"].is_null() {
            return Err((
                400,
                "the run is open; model/effort apply only when resuming a closed session".into(),
            ));
        }
        let Some(run) = self.runs.get(&run_id) else {
            return Err((
                409,
                "that run is closed; continue by machine:sessionId".into(),
            ));
        };
        let machine_id = run.machine_id.clone();
        let session_id = run.session_id.clone();
        match run.state.as_str() {
            "idle" => {}
            "needs_attention" => {
                return Err((
                    409,
                    format!("run {run_id} is waiting on a question — answer it in Hegai Code"),
                ))
            }
            other => {
                return Err((
                    409,
                    format!("run {run_id} is {other}; wait for it to finish"),
                ))
            }
        }
        if !self.agent_online(&machine_id) {
            return Err((
                503,
                "Machine is reconnecting; try again in a moment.".into(),
            ));
        }
        let turn = user_turn_frame(&run_id, &session_id, Some(message), None, None);
        self.send_to_agent(
            &machine_id,
            &json!({"type":"input","runId":run_id,"text":message,"images":Value::Null,"files":Value::Null}),
        );
        // Working NOW, not when the agent's first frame lands: a status read in
        // between would otherwise see the previous turn's idle and its answer.
        self.run_working(&run_id);
        self.announce_user_turn(&run_id, turn);
        println!("[hub] fleet input to run {run_id} on {machine_id}");
        Ok(
            json!({"runId": run_id, "machineId": machine_id, "sessionId": session_id, "resumed": false}),
        )
    }

    fn fleet_resume(
        &mut self,
        machine_id: &str,
        session_id: &str,
        message: &str,
        settings: &Value,
    ) -> Result<Value, FleetError> {
        if self.session_erased(machine_id, session_id) {
            return Err((404, "Session not found.".into()));
        }
        let run_id = self
            .resume_session(ResumeSpec {
                sealed: None,
                machine_id: machine_id.to_string(),
                session_id: session_id.to_string(),
                message: Some(message.to_string()),
                images: None,
                files: None,
                force: false,
                picked: start_settings(settings, false),
                attach: None,
                // Ownership (and not-a-sandbox) was checked by the caller.
                can_control: true,
                origin: Some("fleet".into()),
                run_by: None,
            })
            .map_err(|frame| {
                let text = frame["message"].as_str().unwrap_or("refused").to_string();
                // A machine that is away is a retry later, not a refusal.
                let code = if text.starts_with("Machine is") {
                    503
                } else {
                    409
                };
                (code, text)
            })?;
        Ok(
            json!({"runId": run_id, "machineId": machine_id, "sessionId": session_id, "resumed": true}),
        )
    }

    pub(super) fn fleet_status(
        &self,
        owner_user_id: &str,
        target: &FleetTarget,
    ) -> Result<Value, FleetError> {
        let Some(run_id) = self.fleet_run_for(owner_user_id, target)? else {
            let mut out = json!({"state": "closed"});
            if let FleetTarget::Run(run_id) = target {
                out["runId"] = Value::String(run_id.clone());
            }
            return Ok(out);
        };
        let Some(run) = self.runs.get(&run_id) else {
            return Ok(json!({"state": "closed", "runId": run_id}));
        };
        let mut out = json!({
            "runId": run_id,
            "machineId": run.machine_id,
            "machineName": run.machine_name,
            "sessionId": run.session_id,
            "state": run.state,
            "since": run.since,
            "lastEventAt": run.last_event_at,
        });
        if let Some(cwd) = &run.cwd {
            out["cwd"] = Value::String(cwd.clone());
        }
        if let Some(title) = &run.title {
            out["title"] = Value::String(title.clone());
        }
        if let Some(tool) = &run.pending_tool {
            out["pendingTool"] = Value::String(tool.clone());
        }
        // The agent settles a failed turn back to idle within milliseconds;
        // this is what keeps «failed» from reading as «done».
        if run.turn_failed {
            out["failed"] = Value::Bool(true);
        }
        // `text_buf` holds the turn's last assistant message until the next turn
        // starts (`run_working` clears it), so on idle it IS the answer.
        if run.state == "idle" && !run.text_buf.trim().is_empty() {
            let text: String = run.text_buf.chars().take(FLEET_LAST_TEXT_MAX).collect();
            out["lastText"] = Value::String(text);
        }
        Ok(out)
    }
}
