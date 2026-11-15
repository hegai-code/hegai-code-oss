//! The task registry through the fleet API: a session files, moves and links
//! tasks (`tape_tasks`, `tape_task_links`) and starts work for them
//! (`spawn --task`). `fleet_api.rs` is the HTTP half; the rows are
//! `crate::tasks`, the in-memory lookups `hub/tasks.rs`.
//!
//! Who may use it: any fleet key. The registry was Teo-only by environment
//! once; Teo is gone, and the key already names the machine and the owner — `fleet_api::fleet_caller` refuses a
//! key whose machine is a sandbox (403) or is not enrolled (401), so nothing
//! more is asked here. Every machine a link names goes through
//! `fleet_resolve_machine` and every run through `fleet_run_for`, so sandboxes
//! and other people's runs stay as unreachable as they are for `send`.
//!
//! All of it runs in the hub's command loop, so two writers of the same task
//! never interleave.

use super::*;
use crate::tasks::{
    normalize_status, StoredTask, TaskLink, STATUS_BY_TEO, TASK_STATUSES, TITLE_MAX_CHARS,
};

/// A task's intent / lane are notes, not documents.
const INTENT_MAX_CHARS: usize = 4_000;
const LANE_MAX_CHARS: usize = 40;
const LIST_DEFAULT: usize = 50;
const LIST_MAX: usize = 200;

/// `--task <id>` of a spawn or send: the link to write and who asked for it.
pub(crate) struct TaskTag {
    pub(crate) task_id: String,
    /// The calling key's machine, recorded as `linked_by`.
    pub(crate) linked_by: String,
}

/// One call on the registry.
pub(crate) enum FleetTaskOp {
    List {
        all: bool,
        limit: Option<usize>,
    },
    Get {
        id: String,
    },
    Create {
        title: String,
        status: Option<String>,
        intent: Option<String>,
        lane: Option<String>,
    },
    /// `intent` / `lane` given as an empty string clear the field.
    Update {
        id: String,
        title: Option<String>,
        status: Option<String>,
        intent: Option<String>,
        lane: Option<String>,
    },
    Link {
        id: String,
        target: FleetTarget,
        linked_by: String,
    },
}

fn storage(e: String) -> FleetError {
    eprintln!("[tasks] task registry storage error: {e}");
    (500, "task storage failed".into())
}

fn clipped(what: &str, text: &str, max: usize) -> Result<String, FleetError> {
    let t = text.trim();
    if t.chars().count() > max {
        return Err((400, format!("{what} is too long (max {max} characters)")));
    }
    Ok(t.to_string())
}

fn status_of(raw: &str) -> Result<&'static str, FleetError> {
    normalize_status(raw).ok_or_else(|| {
        (
            400,
            format!("status must be one of {}", TASK_STATUSES.join(", ")),
        )
    })
}

fn some_text(t: String) -> Option<String> {
    (!t.is_empty()).then_some(t)
}

impl Hub {
    fn fleet_task_get(&self, owner: &str, id: &str) -> Result<StoredTask, FleetError> {
        self.workspaces
            .task_get(owner, id)
            .map_err(storage)?
            .ok_or_else(|| (404, format!("no task «{id}»")))
    }

    /// 404 unless the owner has this task — checked before anything is started.
    pub(super) fn fleet_task_must_exist(&self, owner: &str, id: &str) -> Result<(), FleetError> {
        self.fleet_task_get(owner, id).map(|_| ())
    }

    fn task_json(&self, owner: &str, task: &StoredTask) -> Result<Value, FleetError> {
        let links = self
            .workspaces
            .task_links_of(owner, &task.id)
            .map_err(storage)?;
        Ok(task.api_json(&links))
    }

    pub(super) fn fleet_task(&mut self, owner: &str, op: FleetTaskOp) -> Result<Value, FleetError> {
        match op {
            FleetTaskOp::List { all, limit } => {
                let limit = limit.unwrap_or(LIST_DEFAULT).clamp(1, LIST_MAX);
                let tasks = if all {
                    self.workspaces.task_list(owner, limit)
                } else {
                    self.workspaces.task_list_open(owner, limit)
                }
                .map_err(storage)?;
                let mut children = self.workspaces.task_children(owner).map_err(storage)?;
                let tasks: Vec<Value> = tasks
                    .iter()
                    .map(|t| t.api_json(&children.remove(&t.id).unwrap_or_default()))
                    .collect();
                Ok(json!({ "tasks": tasks }))
            }
            FleetTaskOp::Get { id } => {
                let task = self.fleet_task_get(owner, &id)?;
                let links = self.workspaces.task_links_of(owner, &id).map_err(storage)?;
                Ok(json!({
                    "task": task.api_json(&links),
                    "links": links.iter().map(TaskLink::json).collect::<Vec<_>>(),
                }))
            }
            FleetTaskOp::Create {
                title,
                status,
                intent,
                lane,
            } => {
                let title = clipped("title", &title, TITLE_MAX_CHARS)?;
                if title.is_empty() {
                    return Err((400, "title is required".into()));
                }
                let status = status.as_deref().map_or(Ok("open"), status_of)?;
                let intent = intent
                    .map(|t| clipped("intent", &t, INTENT_MAX_CHARS))
                    .transpose()?
                    .and_then(some_text);
                let lane = lane
                    .map(|t| clipped("lane", &t, LANE_MAX_CHARS))
                    .transpose()?
                    .and_then(some_text);
                let now = now_ms();
                // Ids stay 8 hex like the older rows', so a fresh one must not
                // land on an existing task: the upsert below would move it.
                let mut id = String::new();
                for _ in 0..8 {
                    let candidate = Uuid::new_v4().simple().to_string()[..8].to_string();
                    if self
                        .workspaces
                        .task_get(owner, &candidate)
                        .map_err(storage)?
                        .is_none()
                    {
                        id = candidate;
                        break;
                    }
                }
                if id.is_empty() {
                    return Err(storage("could not pick a free task id".to_string()));
                }
                let task = StoredTask {
                    id,
                    title,
                    status: status.to_string(),
                    // No anchor: nothing files turns under a registry task.
                    anchor_turn_id: String::new(),
                    last_turn_id: String::new(),
                    created_at: now,
                    updated_at: now,
                    intent,
                    lane,
                    status_by: STATUS_BY_TEO.into(),
                    status_at: Some(now),
                };
                self.workspaces.task_upsert(owner, &task).map_err(storage)?;
                Ok(json!({ "task": self.task_json(owner, &task)? }))
            }
            FleetTaskOp::Update {
                id,
                title,
                status,
                intent,
                lane,
            } => {
                if title.is_none() && status.is_none() && intent.is_none() && lane.is_none() {
                    return Err((400, "pass title, status, intent or lane".into()));
                }
                let mut task = self.fleet_task_get(owner, &id)?;
                let now = now_ms();
                if let Some(t) = title {
                    let t = clipped("title", &t, TITLE_MAX_CHARS)?;
                    if t.is_empty() {
                        return Err((400, "title must not be empty".into()));
                    }
                    task.title = t;
                }
                if let Some(raw) = status {
                    task.status = status_of(&raw)?.to_string();
                    task.status_by = STATUS_BY_TEO.into();
                    task.status_at = Some(now);
                }
                if let Some(t) = intent {
                    task.intent = some_text(clipped("intent", &t, INTENT_MAX_CHARS)?);
                }
                if let Some(t) = lane {
                    task.lane = some_text(clipped("lane", &t, LANE_MAX_CHARS)?);
                }
                task.updated_at = now;
                self.workspaces.task_upsert(owner, &task).map_err(storage)?;
                Ok(json!({ "task": self.task_json(owner, &task)? }))
            }
            FleetTaskOp::Link {
                id,
                target,
                linked_by,
            } => {
                self.fleet_task_must_exist(owner, &id)?;
                let (machine_id, session_id, run_id, cwd) =
                    self.fleet_link_target(owner, &target)?;
                let link = self.task_link_child(
                    owner,
                    &id,
                    &machine_id,
                    &session_id,
                    run_id.as_deref(),
                    cwd.as_deref(),
                    &linked_by,
                )?;
                Ok(json!({ "link": link.json() }))
            }
        }
    }

    /// The machine, session, run and folder a link names. A run must be open
    /// and the owner's (`fleet_run_for`: refused like `send` refuses it); a
    /// session is addressed by a machine the owner may touch.
    #[allow(clippy::type_complexity)]
    fn fleet_link_target(
        &self,
        owner: &str,
        target: &FleetTarget,
    ) -> Result<(String, String, Option<String>, Option<String>), FleetError> {
        match target {
            FleetTarget::Run(_) => {
                let Some(run_id) = self.fleet_run_for(owner, target)? else {
                    return Err((404, "no such open run of yours".into()));
                };
                let run = self
                    .runs
                    .get(&run_id)
                    .ok_or((404, "no such open run of yours".to_string()))?;
                Ok((
                    run.machine_id.clone(),
                    run.session_id.clone(),
                    Some(run_id),
                    run.cwd.clone(),
                ))
            }
            FleetTarget::Session {
                machine,
                session_id,
            } => {
                let machine_id = self.fleet_resolve_machine(owner, machine)?;
                if self.session_erased(&machine_id, session_id) {
                    return Err((404, "Session not found.".into()));
                }
                // A run that holds the session now, if it is the owner's.
                let run_id = self
                    .fleet_run_for(owner, target)?
                    .filter(|r| self.runs.contains_key(r));
                let cwd = run_id
                    .as_ref()
                    .and_then(|r| self.runs.get(r))
                    .and_then(|r| r.cwd.clone());
                Ok((machine_id, session_id.clone(), run_id, cwd))
            }
        }
    }

    /// `spawn` / `send --task` must not take a session another task already
    /// has — refused before the turn starts, like the 404 for a missing task.
    pub(super) fn fleet_task_target_free(
        &self,
        owner: &str,
        task_id: &str,
        target: &FleetTarget,
    ) -> Result<(), FleetError> {
        let (machine_id, session_id, run_id) = match target {
            FleetTarget::Run(run_id) => match self.runs.get(run_id) {
                Some(run) => (
                    run.machine_id.clone(),
                    run.session_id.clone(),
                    Some(run_id.clone()),
                ),
                None => return Ok(()),
            },
            FleetTarget::Session {
                machine,
                session_id,
            } => (
                self.fleet_resolve_machine(owner, machine)?,
                session_id.clone(),
                None,
            ),
        };
        let held = if !session_id.is_empty() {
            self.workspaces
                .task_link_by_session(owner, &machine_id, &session_id)
        } else if let Some(run_id) = &run_id {
            self.workspaces.task_link_by_run(owner, run_id)
        } else {
            Ok(None)
        }
        .map_err(storage)?;
        match held {
            Some(link) if link.task_id != task_id => Err((
                409,
                format!("that session already works for task {}", link.task_id),
            )),
            _ => Ok(()),
        }
    }

    /// Write the `--task` link of a spawn / send that went through. The turn has
    /// already started, so a failure here cannot undo it: it is reported in the
    /// answer (`taskLinkError`) rather than as a refusal the caller would retry.
    pub(super) fn fleet_tag_result(
        &mut self,
        owner: &str,
        tag: &TaskTag,
        cwd: Option<&str>,
        out: &mut Value,
    ) {
        let text = |key: &str| out.get(key).and_then(Value::as_str).map(str::to_string);
        let (Some(machine_id), run_id) = (text("machineId"), text("runId")) else {
            return;
        };
        let session_id = text("sessionId").unwrap_or_default();
        match self.task_link_child(
            owner,
            &tag.task_id,
            &machine_id,
            &session_id,
            run_id.as_deref(),
            cwd,
            &tag.linked_by,
        ) {
            Ok(_) => out["taskId"] = json!(tag.task_id),
            Err((_, message)) => {
                eprintln!("[hub] task link for {} failed: {message}", tag.task_id);
                out["taskLinkError"] = json!(message);
            }
        }
    }

    /// Link a session (or a run still without one) to a task as its child.
    /// Idempotent for the same task; another task's session is a 409.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn task_link_child(
        &mut self,
        owner: &str,
        task_id: &str,
        machine_id: &str,
        session_id: &str,
        run_id: Option<&str>,
        cwd: Option<&str>,
        linked_by: &str,
    ) -> Result<TaskLink, FleetError> {
        let held = if !session_id.is_empty() {
            self.workspaces
                .task_link_by_session(owner, machine_id, session_id)
        } else if let Some(run_id) = run_id {
            self.workspaces.task_link_by_run(owner, run_id)
        } else {
            return Err((400, "a link needs a session or a run".into()));
        }
        .map_err(storage)?;
        if let Some(link) = held {
            return if link.task_id == task_id {
                Ok(link)
            } else {
                Err((
                    409,
                    format!("that session already works for task {}", link.task_id),
                ))
            };
        }
        let link = TaskLink {
            link_id: Uuid::new_v4().simple().to_string(),
            task_id: task_id.to_string(),
            role: "child".into(),
            machine_id: machine_id.to_string(),
            session_id: session_id.to_string(),
            run_id: run_id.map(str::to_string),
            cwd: cwd.map(str::to_string),
            linked_at: now_ms(),
            linked_by: linked_by.to_string(),
        };
        self.workspaces
            .task_link_insert(owner, &link)
            .map_err(storage)?;
        if link.session_id.is_empty() {
            if let Some(run_id) = &link.run_id {
                self.task_links
                    .pending
                    .insert(run_id.clone(), (owner.to_string(), task_id.to_string()));
            }
        }
        Ok(link)
    }
}
