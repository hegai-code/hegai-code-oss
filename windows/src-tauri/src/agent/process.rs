//! Is the agent running, and which process is it?
//!
//! Matching on the executable name is not enough. A developer box runs several
//! `node.exe` at once — this machine had five while this was written: an MCP
//! filesystem server, a Vite dev server, a production script, an npx shim, and
//! the agent. The only thing that distinguishes them is the script path on the
//! command line, which is why `update-win.ps1:50-52` filters the same way when
//! it kills a stale agent.

use std::path::{Path, PathBuf};

use sysinfo::{ProcessRefreshKind, RefreshKind, System};

use super::config::Install;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Running {
    pub pid: u32,
}

/// Find the agent process, if it is up.
///
/// Deliberately conservative: when in doubt this reports "running", because the
/// cost of a false negative is a SECOND agent for the same machine — two
/// registrations of one machineId, which is worse than a supervisor that waits
/// another fifteen seconds.
pub fn running(install: &Install) -> Option<Running> {
    // Processes only, and of those only the command line — the one field that
    // identifies the agent. Refreshing everything would walk disks and networks
    // every fifteen seconds for nothing.
    let system = System::new_with_specifics(
        RefreshKind::new()
            .with_processes(ProcessRefreshKind::new().with_cmd(sysinfo::UpdateKind::Always)),
    );
    running_in(&system, install, std::fs::read_to_string(pid_file()).ok())
}

/// Where the agent publishes its own pid (`agent/src/config.ts: pidFile`).
fn pid_file() -> PathBuf {
    let home = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_default();
    home.join(".cc-remote").join("agent.pid")
}

/// The decision itself, with the world passed in so it can be tested.
///
/// The pid file comes FIRST, and it is the half that matters. Scanning command
/// lines cannot see an agent started by the scheduled task: that process lives
/// in session 0 under its own S4U logon, and this supervisor — same user, but a
/// different logon session and an unelevated token — is refused its command
/// line. `sysinfo` then hands back an empty `cmd()`, the scan concludes «no
/// agent», and a SECOND daemon starts for a machineId that already has one.
/// That is not theory: buildbox-pc ran two agents for a day on 20.09.2026, and
/// the pair took the machine from each other in a loop.
///
/// A pid is different — whether it is alive, and what its process is called,
/// are readable without any right to inspect it.
fn running_in(system: &System, install: &Install, pid_text: Option<String>) -> Option<Running> {
    if let Some(pid) = pid_text.as_deref().and_then(parse_pid) {
        // A stale file outlives a crash, so the pid must still be a live node —
        // otherwise the number belongs to whoever the OS gave it to next.
        if let Some(p) = system.process(sysinfo::Pid::from_u32(pid)) {
            if is_node(p.name().to_string_lossy().as_ref()) {
                return Some(Running { pid });
            }
        }
    }
    // Fallback for an agent older than the pid file, and for the moment between
    // its start and its first write.
    let needle = install.entry.as_path();
    system
        .processes()
        .values()
        .find(|p| p.cmd().iter().any(|arg| arg_matches(arg.to_string_lossy().as_ref(), needle)))
        .map(|p| Running { pid: p.pid().as_u32() })
}

fn parse_pid(text: &str) -> Option<u32> {
    text.trim().parse::<u32>().ok().filter(|pid| *pid != 0)
}

fn is_node(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name == "node.exe" || name == "node"
}

/// Compare a command-line argument against the agent's entry script.
///
/// Windows paths are case-insensitive and come back with either separator
/// depending on who spawned the process, so a plain `==` misses a process that
/// is plainly the agent. `run-agent.cmd` writes a backslash path; a shell may
/// pass a forward-slash one.
fn arg_matches(arg: &str, entry: &Path) -> bool {
    let norm = |s: &str| s.replace('\\', "/").to_ascii_lowercase();
    let arg = norm(arg.trim_matches('"'));
    let entry = norm(&entry.to_string_lossy());
    arg == entry
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn entry() -> PathBuf {
        PathBuf::from(r"C:\Users\buildbox\cc-remote-agent\agent.mjs")
    }

    #[test]
    fn the_real_command_line_matches() {
        // Exactly what `Get-CimInstance Win32_Process` reports for the agent on
        // this machine, quotes and all.
        assert!(arg_matches(
            r#""C:\Users\buildbox\cc-remote-agent\agent.mjs""#,
            &entry()
        ));
        assert!(arg_matches(
            r"C:\Users\buildbox\cc-remote-agent\agent.mjs",
            &entry()
        ));
    }

    #[test]
    fn separators_and_case_do_not_hide_the_agent() {
        // A false negative here starts a SECOND agent for one machine.
        assert!(arg_matches(
            "C:/Users/buildbox/cc-remote-agent/agent.mjs",
            &entry()
        ));
        assert!(arg_matches(
            r"c:\users\BUILDBOX\cc-remote-agent\AGENT.MJS",
            &entry()
        ));
    }

    #[test]
    fn the_other_node_processes_on_this_box_are_not_the_agent() {
        // All five were running side by side while this was written.
        for other in [
            r"C:\Program Files\nodejs\node_modules\npm\bin\npx-cli.js",
            r"D:\npm-cache\_npx\a3241bba59c344f5\node_modules\@modelcontextprotocol\server-filesystem\dist\index.js",
            "scripts/run-prod.cjs",
            "D:/Hegai_VScode/open-generative-ai/node_modules/vite/bin/vite.js",
            r"C:\Users\buildbox\cc-remote-agent\agent.mjs.bak-20260805",
        ] {
            assert!(!arg_matches(other, &entry()), "matched by mistake: {other}");
        }
    }

    #[test]
    fn a_different_users_agent_is_not_ours() {
        // The task is per-user by design (install-win.ps1 explains why), so
        // another profile's agent must not count as this one's.
        assert!(!arg_matches(
            r"C:\Users\someone-else\cc-remote-agent\agent.mjs",
            &entry()
        ));
    }

    #[test]
    fn a_pid_file_is_read_leniently_but_never_loosely() {
        assert_eq!(parse_pid("4184"), Some(4184));
        assert_eq!(parse_pid("4184\n"), Some(4184), "the agent writes no newline, a person might");
        assert_eq!(parse_pid(" 4184 \r\n"), Some(4184));
        // 0 is not a pid; the rest is a file somebody else wrote.
        for junk in ["", "   ", "0", "-1", "nope", "4184 4185"] {
            assert_eq!(parse_pid(junk), None, "accepted junk: {junk:?}");
        }
    }

    #[test]
    fn only_a_node_process_answers_for_the_agent() {
        for yes in ["node.exe", "NODE.EXE", "node"] {
            assert!(is_node(yes), "rejected: {yes}");
        }
        for no in ["notepad.exe", "nodemon.exe", "hegai-code.exe", ""] {
            assert!(!is_node(no), "accepted: {no}");
        }
    }

    fn scan() -> System {
        System::new_with_specifics(
            RefreshKind::new()
                .with_processes(ProcessRefreshKind::new().with_cmd(sysinfo::UpdateKind::Always)),
        )
    }

    fn install_pointing_nowhere() -> Install {
        Install {
            dir: PathBuf::from(r"C:\Users\nobody\cc-remote-agent"),
            entry: PathBuf::from(r"C:\Users\nobody\cc-remote-agent\agent.mjs"),
            node: PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
            log: PathBuf::from(r"C:\Users\nobody\cc-remote-agent\agent.log"),
            env: Default::default(),
            blocked: None,
        }
    }

    /// The dangerous direction. A pid file outlives a crash, and if a stale one
    /// were believed the supervisor would sit forever reporting a healthy agent
    /// that is not there — the machine offline with nobody to restart it, which
    /// is the failure this whole module exists to prevent.
    #[test]
    fn a_stale_pid_file_never_masks_a_dead_agent() {
        let dead = scan();
        let highest = u32::MAX.to_string();
        assert_eq!(
            running_in(&dead, &install_pointing_nowhere(), Some(highest)),
            None,
        );
    }

    /// The other way a pid file goes wrong: the number is alive, but the OS
    /// handed it to something else entirely after the agent died.
    #[test]
    fn a_recycled_pid_belonging_to_another_program_is_not_the_agent() {
        let system = scan();
        // This test process: certainly alive, certainly not node.
        let ours = std::process::id().to_string();
        assert_eq!(running_in(&system, &install_pointing_nowhere(), Some(ours)), None);
    }

    #[test]
    fn no_pid_file_still_falls_back_to_the_command_line_scan() {
        // Older agents write no pid file at all, so the scan must remain the
        // floor rather than being replaced by it.
        let system = scan();
        assert_eq!(running_in(&system, &install_pointing_nowhere(), None), None);
    }
}
