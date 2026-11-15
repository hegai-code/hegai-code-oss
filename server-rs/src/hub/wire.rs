use serde_json::Value;

/// Message discriminants used by more than one routing module. Keeping these
/// names in one place prevents silent typos in stringly-typed forwarding code.
pub(super) mod message {
    pub const STREAM: &str = "stream";
    pub const TOOL_REQUEST: &str = "tool_request";
    /// Hub → browsers: the pending request was decided. Sent to everyone the
    /// matching `tool_request` went to, because that fan-out reaches every
    /// viewer that may drive the run — a second tab, a phone, another pane of
    /// the split — and only the one that answered clears itself.
    pub const TOOL_RESOLVED: &str = "tool_resolved";
    /// Hub → browsers: what a person said into a run, so every OTHER screen on
    /// it shows the turn too. The composer that sent it already shows its own
    /// echo; without this a message typed on the phone never appeared on the
    /// desktop following the same run (28.09.2026) — the answer streamed in
    /// under the previous one with the question missing.
    pub const USER_TURN: &str = "user_turn";
    pub const RUN_STATUS: &str = "run_status";
    /// Agent → hub: the runtime process of a run that reported
    /// `run_status` with `closing: true` is confirmed gone, so its session may
    /// have a new writer at once. Never forwarded to a browser.
    pub const WRITER_RELEASED: &str = "writer_released";
    pub const SESSION_STARTED: &str = "session_started";
    pub const SESSION_ORIGIN: &str = "session_origin";
    pub const RUN_MODE: &str = "run_mode";
    pub const RUN_SETTINGS: &str = "run_settings";
    pub const CONTEXT_USAGE: &str = "context_usage";
    pub const RPC_REQUEST: &str = "rpc_request";
    /// Agent → hub: the project in `cwd` reached its own remote. Becomes an
    /// audit row, never a browser frame.
    pub const PROJECT_PUSHED: &str = "project_pushed";
    /// Agent → hub: every run that agent is actually driving, on a heartbeat.
    /// The whole truth for the machine — a run we hold that is missing from it
    /// has no writer behind it. Never forwarded to a browser.
    pub const RUN_INVENTORY: &str = "run_inventory";
    /// Agent → hub → controlling browsers: what the machine's Claude and Codex
    /// ARE (found, logged in as whom, own login or a gateway). Sent on change;
    /// the first reading rides on `register` under `field::RUNTIMES`.
    pub const RUNTIME_STATUS: &str = "runtime_status";
}

/// Field names the hub writes onto payloads it otherwise forwards verbatim.
pub(super) mod field {
    /// `MachineSnapshot.kind`: present only as `"sandbox"`; a personal device
    /// omits it (zod optional = absent, never null).
    pub const MACHINE_KIND: &str = "kind";
    pub const MACHINE_KIND_SANDBOX: &str = "sandbox";
    /// `MachineSnapshot.shared`: present only as `true`, when the machine
    /// carries at least one project share. Absent = nobody but the owner works
    /// there. Separate from `kind` because `kind` cannot answer this — it
    /// records how the device was enrolled, and the shared employee sandbox is
    /// enrolled as an ordinary personal device.
    pub const MACHINE_SHARED: &str = "shared";
    /// `Register.runtimes` and `MachineSnapshot.runtimes`: present only once
    /// the agent has reported it. Absent = an agent too old to say, which the
    /// browser draws as «нет данных», never as a warning.
    pub const RUNTIMES: &str = "runtimes";
    /// `RegisterAck`: owner-scoped Claude background monitoring switch.
    pub const CLAUDE_USAGE_ENABLED: &str = "claudeUsageEnabled";
}

/// Small typed readers for the handful of fields the hub inspects while still
/// forwarding the rest of each JSON payload verbatim.
pub(super) trait ValueFields {
    fn field_str(&self, key: &str) -> Option<&str>;
    fn field_string(&self, key: &str) -> Option<String>;
    fn field_bool(&self, key: &str) -> Option<bool>;
    fn field_value(&self, key: &str) -> Value;
}

impl ValueFields for Value {
    fn field_str(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Value::as_str)
    }

    fn field_string(&self, key: &str) -> Option<String> {
        self.field_str(key).map(str::to_string)
    }

    fn field_bool(&self, key: &str) -> Option<bool> {
        self.get(key).and_then(Value::as_bool)
    }

    fn field_value(&self, key: &str) -> Value {
        self.get(key).cloned().unwrap_or(Value::Null)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn typed_fields_do_not_coerce_wrong_json_types() {
        let value = json!({"name":"box","enabled":true,"limit":3,"missing":null});
        assert_eq!(value.field_str("name"), Some("box"));
        assert_eq!(value.field_bool("enabled"), Some(true));
        assert_eq!(value.field_str("limit"), None);
        assert!(value.field_value("missing").is_null());
    }
}
