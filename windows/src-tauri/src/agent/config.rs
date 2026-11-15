//! Finding the agent install and starting it the way it already starts.
//!
//! The supervisor does NOT invent a launch recipe. `deploy/install-win.ps1`
//! writes `run-agent.cmd` and that file is the machine's configuration: the
//! node it chose (possibly a portable one it downloaded), the hub URL, the
//! machine name and the credential. Reading it means a machine keeps whatever
//! it was enrolled with, and a supervisor restart is indistinguishable from the
//! Scheduled Task's own start.

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// No console flash on restart, and the agent outlives this app: it is a
/// daemon, and quitting the tray must not take the machine out of the fleet.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;

/// The legacy hub name. nginx still proxies it for websockets, so an agent
/// pointed there keeps working — which is exactly why it goes unnoticed.
const LEGACY_HUB: &str = "claude.acme.test";

static LEGACY_NOTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[derive(Debug, Clone)]
pub struct Install {
    pub dir: PathBuf,
    /// `agent.mjs` — also the fingerprint that identifies the process.
    pub entry: PathBuf,
    pub node: PathBuf,
    pub log: PathBuf,
    /// Environment from `run-agent.cmd`. Holds the device credential, so this
    /// is never logged or shown.
    pub env: BTreeMap<String, String>,
    /// Why this install cannot be started, when that is knowable before trying.
    /// `launch` refuses rather than spawning something that cannot work — see
    /// the note on the launcher in `find_install`.
    pub blocked: Option<String>,
}

pub fn find_install() -> Option<Install> {
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from)?;
    let dir = home.join("cc-remote-agent");
    let entry = dir.join("agent.mjs");
    if !entry.is_file() {
        return None;
    }
    let launcher = dir.join("run-agent.cmd");
    // A missing or unreadable launcher used to fall back to an EMPTY
    // environment, and that is not a degraded start — it is a broken one. The
    // agent would come up with no `CC_REMOTE_TOKEN` and no `CENTRAL_URL`, fall
    // back to its own dev defaults, fail to reach the hub and exit, and the
    // supervisor would respawn it forever. Say so instead: the tray already has
    // a line for "installed but cannot start".
    let (env, blocked) = match std::fs::read_to_string(&launcher) {
        Ok(s) => (parse_env(&s), None),
        Err(e) => (
            BTreeMap::new(),
            Some(format!("{} не читается: {e}", launcher.display())),
        ),
    };

    if env
        .get("CENTRAL_URL")
        .is_some_and(|u| u.contains(LEGACY_HUB))
        // Once per run: this is called on every supervisor poll, and a note
        // repeated every fifteen seconds stops being read.
        && !LEGACY_NOTED.swap(true, std::sync::atomic::Ordering::Relaxed)
    {
        // Warned, not rewritten. Pointing someone's agent at a different host
        // is a decision, not a side effect of a restart.
        println!(
            "[agent] note: CENTRAL_URL still points at {LEGACY_HUB} (legacy name; code.acme.test is canonical)"
        );
    }

    Some(Install {
        node: resolve_node(&dir, &env),
        log: dir.join("agent.log"),
        entry,
        env,
        blocked,
        dir,
    })
}

/// `set "KEY=VALUE"` lines from the launcher. Anything else in the file — the
/// `@echo off`, the node invocation, the redirect — is not configuration.
fn parse_env(cmd: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for line in cmd.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("set ").or_else(|| line.strip_prefix("SET ")) else {
            continue;
        };
        let rest = rest.trim().trim_matches('"');
        let Some((key, value)) = rest.split_once('=') else {
            continue;
        };
        let key = key.trim().trim_matches('"');
        if key.is_empty() {
            continue;
        }
        out.insert(key.to_string(), value.trim_matches('"').to_string());
    }
    out
}

/// The node the installer chose, in the order `install-win.ps1` would.
fn resolve_node(dir: &Path, env: &BTreeMap<String, String>) -> PathBuf {
    // A portable node vendored next to the agent wins: the installer puts one
    // there precisely when the system had no usable version on PATH.
    let portable = dir.join("node").join("node.exe");
    if portable.is_file() {
        return portable;
    }
    if let Some(explicit) = env.get("CC_REMOTE_NODE").filter(|s| !s.is_empty()) {
        return PathBuf::from(explicit);
    }
    // Otherwise whatever PATH resolves — the same thing the .cmd does.
    PathBuf::from("node.exe")
}

pub fn launch(install: &Install) -> Result<u32, String> {
    // Refuse rather than spawn something known to be unstartable — a restart
    // loop is worse than a tray line saying what is wrong.
    if let Some(why) = &install.blocked {
        return Err(why.clone());
    }
    let log = open_log(&install.log)?;
    let errlog = log.try_clone().map_err(|e| format!("log handle: {e}"))?;

    let mut cmd = Command::new(&install.node);
    cmd.arg(&install.entry)
        .current_dir(&install.dir)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(errlog))
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    for (k, v) in &install.env {
        cmd.env(k, v);
    }
    cmd.spawn()
        .map(|child| child.id())
        .map_err(|e| format!("{}: {e}", install.node.display()))
}

/// Append, never truncate: `agent.log` is the only record of why the agent died
/// last time, and a supervisor that restarts it must not erase the evidence.
fn open_log(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The launcher exactly as `install-win.ps1:82-91` writes it, and as it
    /// exists on this machine.
    const REAL: &str = r#"@echo off
set "CC_REMOTE_TOKEN=deadbeef"
set "CENTRAL_URL=wss://claude.acme.test"
set "MACHINE_NAME=buildbox-pc"
"C:\Program Files\nodejs\node.exe" "C:\Users\buildbox\cc-remote-agent\agent.mjs" >> "C:\Users\buildbox\cc-remote-agent\agent.log" 2>&1
"#;

    #[test]
    fn the_real_launcher_yields_its_configuration() {
        let env = parse_env(REAL);
        assert_eq!(env.get("MACHINE_NAME").unwrap(), "buildbox-pc");
        assert_eq!(env.get("CENTRAL_URL").unwrap(), "wss://claude.acme.test");
        assert_eq!(env.get("CC_REMOTE_TOKEN").unwrap(), "deadbeef");
        // The node invocation and the redirect are not configuration.
        assert_eq!(env.len(), 3, "only the three `set` lines: {env:?}");
    }

    #[test]
    fn an_enrollment_code_install_parses_too() {
        // The other credential shape install-win.ps1 writes.
        let env = parse_env("@echo off\r\nset \"CC_REMOTE_ENROLLMENT_CODE=ABC-123\"\r\n");
        assert_eq!(env.get("CC_REMOTE_ENROLLMENT_CODE").unwrap(), "ABC-123");
    }

    #[test]
    fn a_value_containing_an_equals_sign_survives() {
        // Tokens are hex today, but splitting on the LAST `=` would corrupt any
        // base64 credential the installer starts writing tomorrow.
        let env = parse_env(r#"set "CC_REMOTE_TOKEN=abc==""#);
        assert_eq!(env.get("CC_REMOTE_TOKEN").unwrap(), "abc==");
    }

    #[test]
    fn an_empty_or_odd_launcher_does_not_panic() {
        assert!(parse_env("").is_empty());
        assert!(parse_env("@echo off\nrem nothing here\n").is_empty());
        // `set` with no assignment is not configuration.
        assert!(parse_env("set \"\"\nset\n").is_empty());
    }

    #[test]
    fn a_portable_node_is_preferred_over_path() {
        // install-win.ps1 vendors one exactly when the system node is unusable,
        // so it must win over whatever PATH happens to resolve.
        let env = BTreeMap::new();
        let missing = Path::new(r"C:\definitely\not\here");
        assert_eq!(resolve_node(missing, &env), PathBuf::from("node.exe"));
    }
}
