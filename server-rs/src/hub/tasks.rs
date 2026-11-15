//! The task registry's in-memory lookup and the hooks that keep it, and the
//! stored child links, true as runs start and end. The calls on the registry are
//! `fleet_tasks.rs`; the rows are `crate::tasks`.
//!
//! A child link is written when a run is spawned for a task (`spawn --task`),
//! before the agent has told the hub the run's session. The hub therefore holds
//! one map, loaded once at start from the links and then moved by the hooks
//! below: the runs still waiting for their session. Everything here runs in the
//! hub's command loop.

use super::*;

/// What the hub remembers of `tape_task_links`, so a hook on a run is a map
/// lookup and not a query.
#[derive(Default)]
pub(super) struct TaskLinks {
    /// run_id -> `(user_id, task_id)` of a child link still waiting for the
    /// run's `session_started`.
    pub(super) pending: HashMap<String, (String, String)>,
}

impl TaskLinks {
    /// The pending map from the stored links. A link pending longer than a day
    /// is dropped in the process (`task_link_pending`): its run is long gone.
    pub(super) fn load(workspaces: &WorkspaceStore) -> Self {
        let pending = workspaces
            .task_link_pending()
            .unwrap_or_else(|e| {
                eprintln!("[tasks] could not load pending task links: {e}");
                Vec::new()
            })
            .into_iter()
            .map(|(run, user, task)| (run, (user, task)))
            .collect();
        TaskLinks { pending }
    }
}

impl Hub {
    /// `session_started` of a run a child link is waiting on.
    pub(super) fn task_links_on_session_started(&mut self, run_id: &str, session_id: &str) {
        // Leave the pending entry in place until the session is recorded: a
        // failed write keeps the retry trigger for the next session_started.
        if self.task_links.pending.contains_key(run_id) && self.fill_task_links(run_id, session_id)
        {
            self.task_links.pending.remove(run_id);
        }
    }

    /// A run released before its session was known never became a child:
    /// forget the pending link in memory and in the registry.
    pub(super) fn task_links_on_run_released(&mut self, run_id: &str) {
        if self.task_links.pending.remove(run_id).is_none() {
            return;
        }
        if let Err(e) = self.workspaces.task_links_drop_pending(run_id) {
            eprintln!("[tasks] could not drop the pending task link of run {run_id}: {e}");
        }
    }

    /// Fill `session_id` into the links that waited for `run_id`'s session.
    /// `false` when it was not recorded.
    pub(super) fn fill_task_links(&self, run_id: &str, session_id: &str) -> bool {
        match self.workspaces.task_links_set_session(run_id, session_id) {
            Ok(()) => true,
            Err(e) => {
                eprintln!("[tasks] could not record the session of run {run_id} on its task: {e}");
                false
            }
        }
    }
}
