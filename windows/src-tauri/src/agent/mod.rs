//! Keeping the machine agent alive.
//!
//! Windows used to be the only platform in the fleet with no restart-on-failure:
//!
//!   macOS   launchd, `KeepAlive true`            (deploy/install-mac.sh:101)
//!   Linux   systemd, `Restart=always`            (deploy/cc-remote-agent.service:16)
//!   Windows `schtasks /SC ONLOGON`               — nothing
//!
//! A crashed agent there stayed down until the next logon, and the only thing
//! holding it up in between was the `uncaughtException` guard in
//! `agent/src/main.ts:20-21` — whose own comment names the reason it exists:
//! "node-pty helper hiccups on Windows". So Windows was simultaneously the
//! platform with a known crash source and the one with no supervisor.
//!
//! This app is already running and already watching the fleet, so it was the
//! cheapest place to close that gap.
//!
//! Since 01.09.2026 it is no longer the ONLY thing closing it: the Scheduled
//! Task `install-win.ps1` registers now carries a repetition trigger, which
//! restarts a dead agent within minutes whether or not this app is running.
//! Keep BOTH: the task covers the machine when the app is closed, and this
//! covers the gap between firings (and is what puts the agent's state in the
//! tray where a person can see it).
//!
//! They do overlap, and the overlap is not free — an earlier version of this
//! note claimed "the two do not fight" and was wrong. `MultipleInstances=
//! IgnoreNew` drops a firing that lands on a live TASK INSTANCE; it knows
//! nothing about an agent THIS supervisor started. So whenever the app wins the
//! race, the task has no instance to collide with and fires on every interval
//! forever, each time starting a node that exits at once because the machine is
//! already claimed. Harmless in itself — but until 05.09.2026 the task ran a
//! `.cmd` directly, which meant a console window on the interactive desktop
//! every few minutes, taking the screen from whatever was fullscreen. The task
//! now goes through a hidden wrapper (`run-agent-hidden.vbs`); if you ever
//! change how it is registered, keep it windowless.

mod config;
mod process;

use std::path::PathBuf;
use std::time::Duration;

use tauri::AppHandle;

pub use process::Running;

/// How often to look. The agent takes a few seconds to register with the hub,
/// so polling faster would only race its own startup.
const POLL: Duration = Duration::from_secs(15);
/// After a restart, wait before judging it again — a process that dies during
/// startup must not be respawned in a tight loop.
const SETTLE: Duration = Duration::from_secs(20);
/// Consecutive failed starts before backing off to a slow retry. At that point
/// something is wrong that respawning will not fix.
///
/// A "failed start" is one that did not RESULT IN A RUNNING AGENT, not one that
/// `spawn` refused. Those are different failures and only the first is common:
/// a bad token or an unreachable hub lets node start and exit a second later,
/// so `spawn` keeps succeeding while nothing ever stays up. Counting only spawn
/// errors let that loop run forever at one restart per SETTLE, appending to a
/// log file that is never truncated by design.
const GIVE_UP_AFTER: u32 = 5;
const SLOW_RETRY: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Default)]
pub struct Status {
    /// Where the agent bundle lives, if it is installed at all.
    pub install: Option<PathBuf>,
    /// The live process, if one is running.
    pub running: Option<Running>,
    /// How many times THIS app has restarted it since launch.
    pub restarts: u32,
    /// Set when the agent is installed but cannot be started, with the reason.
    pub blocked: Option<String>,
}

impl Status {
    pub fn summary(&self) -> String {
        match (&self.install, &self.running, &self.blocked) {
            (None, _, _) => "агент не установлен".into(),
            (_, _, Some(why)) => format!("агент не запускается: {why}"),
            (_, Some(r), _) => {
                let restarts = if self.restarts > 0 {
                    format!(", перезапусков: {}", self.restarts)
                } else {
                    String::new()
                };
                format!("агент работает (pid {}){restarts}", r.pid)
            }
            (_, None, _) => "агент остановлен".into(),
        }
    }
}

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        supervise(app).await;
    });
}

async fn supervise(app: AppHandle) {
    let mut status = Status::default();
    let mut consecutive_failures = 0u32;
    let mut announced_missing = false;

    loop {
        let Some(install) = config::find_install() else {
            if !announced_missing {
                // Said once, not every fifteen seconds.
                println!("[agent] not installed under %USERPROFILE%\\cc-remote-agent — nothing to supervise");
                announced_missing = true;
            }
            status.install = None;
            status.running = None;
            publish(&app, &status);
            tokio::time::sleep(SLOW_RETRY).await;
            continue;
        };
        announced_missing = false;
        status.install = Some(install.dir.clone());

        match process::running(&install) {
            Some(r) => {
                if consecutive_failures > 0 {
                    println!("[agent] back up (pid {})", r.pid);
                }
                consecutive_failures = 0;
                status.running = Some(r);
                status.blocked = None;
                publish(&app, &status);
                tokio::time::sleep(POLL).await;
            }
            None => {
                // The gap this module exists to close.
                println!("[agent] not running — starting it");
                status.running = None;
                match config::launch(&install) {
                    Ok(pid) => {
                        status.restarts += 1;
                        // NOT a success yet — `spawn` returning a pid only means
                        // the OS created a process. The next poll finding it
                        // alive is what clears this counter (see the `Some(r)`
                        // arm above); a process that dies inside SETTLE lands
                        // back here and counts against GIVE_UP_AFTER.
                        consecutive_failures += 1;
                        status.blocked = None;
                        println!(
                            "[agent] started (pid {pid}); restarts this session: {}",
                            status.restarts
                        );
                        publish(&app, &status);
                        back_off(consecutive_failures).await;
                    }
                    Err(e) => {
                        consecutive_failures += 1;
                        eprintln!("[agent] could not start: {e}");
                        status.blocked = Some(e);
                        publish(&app, &status);
                        back_off(consecutive_failures).await;
                    }
                }
            }
        }
    }
}

/// Wait before the next attempt: SETTLE while a restart still looks like it
/// might take, SLOW_RETRY once the agent has failed to stay up GIVE_UP_AFTER
/// times in a row.
async fn back_off(consecutive_failures: u32) {
    if consecutive_failures >= GIVE_UP_AFTER {
        eprintln!(
            "[agent] {consecutive_failures} starts in a row did not stick; backing off for {}s",
            SLOW_RETRY.as_secs()
        );
        tokio::time::sleep(SLOW_RETRY).await;
    } else {
        tokio::time::sleep(SETTLE).await;
    }
}

/// Put the current state where a person can see it without reading a log.
fn publish(app: &AppHandle, status: &Status) {
    crate::set_agent_status(app, &status.summary());
}
