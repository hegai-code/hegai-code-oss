//! «Приложение = агент». After the person signs in, install and enroll the
//! machine's agent ourselves — the way the ChatGPT app or Tailscale connect a
//! computer — instead of sending them to a website for a 15-minute code to
//! paste into a terminal.
//!
//! The shell already has everything this needs: the hub's address, the
//! session cookie (which the hub accepts as a bearer token on
//! `POST /api/enrollments`), and the installers the hub serves. The agent
//! swaps the code for a device token by itself, so the hub needs no change.
//!
//! What this module adds is the glue and its visibility: a state machine
//! (`Phase`) shown in the tray row and handed to the page as
//! `window.__HEGAI_AGENT__`, so «Начало» can say «Этот компьютер» and draw
//! the install's progress instead of a copy-paste block.
//!
//! Platform split: Windows keeps its supervisor (`agent::supervise`) for the
//! running process; macOS has launchd. This module only INSTALLS, once.

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::{await_webview, hub_base, MAIN_WINDOW};

/// Where the install stands. `Installed` is terminal for this module; the
/// others are polled.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Phase {
    Checking,
    NotSignedIn,
    Installing,
    Installed { machine_id: Option<String> },
    /// Signed in but the hub will not hand out a code yet (access not open,
    /// the hourly cap). The message is what the tray shows.
    Waiting(String),
    Failed(String),
}

impl Phase {
    pub fn summary(&self) -> String {
        match self {
            Phase::Checking => "агент: проверяю…".into(),
            Phase::NotSignedIn => "агент: подключу после входа".into(),
            Phase::Installing => "агент: устанавливаю…".into(),
            Phase::Installed { .. } => {
                if cfg!(target_os = "macos") {
                    "агент установлен (launchd)".into()
                } else {
                    "агент установлен".into()
                }
            }
            Phase::Waiting(why) => format!("агент: {why}"),
            Phase::Failed(why) => format!("агент не установился: {why}"),
        }
    }

    /// The object the page reads. No secrets: a phase, a machine id, a reason.
    pub fn to_json(&self) -> Value {
        match self {
            Phase::Checking => json!({"phase":"checking"}),
            Phase::NotSignedIn => json!({"phase":"signed_out"}),
            Phase::Installing => json!({"phase":"installing"}),
            Phase::Installed { machine_id } => json!({"phase":"installed","machineId":machine_id}),
            Phase::Waiting(why) => json!({"phase":"waiting","reason":why}),
            Phase::Failed(why) => json!({"phase":"failed","reason":why}),
        }
    }
}

pub struct EnrollState(pub Mutex<Phase>);

/// How often to look while signed out or already installed.
const IDLE_POLL: Duration = Duration::from_secs(5);
const INSTALLED_POLL: Duration = Duration::from_secs(60);
const RETRY_MAX: Duration = Duration::from_secs(15 * 60);
/// npm install of two deps plus, when needed, a portable Node download.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);

pub fn spawn(app: AppHandle) {
    app.manage(EnrollState(Mutex::new(Phase::Checking)));
    tauri::async_runtime::spawn(async move {
        supervise(app).await;
    });
}

async fn supervise(app: AppHandle) {
    await_webview().await;
    let mut retry = IDLE_POLL;
    loop {
        if let Some(found) = installed(&home_dir()) {
            publish(&app, Phase::Installed { machine_id: found.machine_id });
            tokio::time::sleep(INSTALLED_POLL).await;
            continue;
        }
        let Some(token) = crate::hub::session_token(&app) else {
            publish(&app, Phase::NotSignedIn);
            tokio::time::sleep(IDLE_POLL).await;
            continue;
        };
        publish(&app, Phase::Installing);
        match install(&token).await {
            Ok(()) => {
                println!("[enroll] agent installed and enrolled");
                retry = IDLE_POLL;
            }
            Err(Refusal::Wait(why)) => {
                println!("[enroll] not yet: {why}");
                publish(&app, Phase::Waiting(why));
                tokio::time::sleep(retry).await;
                retry = (retry * 2).min(RETRY_MAX);
            }
            Err(Refusal::Failed(why)) => {
                eprintln!("[enroll] install failed: {why}");
                publish(&app, Phase::Failed(why));
                tokio::time::sleep(retry.max(Duration::from_secs(60))).await;
                retry = (retry * 2).min(RETRY_MAX);
            }
        }
    }
}

enum Refusal {
    /// Try again later; nothing is wrong with the machine.
    Wait(String),
    /// Something on the machine or the network did not work; say so.
    Failed(String),
}

/// Mint a code as the signed-in person, fetch the installer the hub serves
/// for this OS and run it with that code. The installer registers the
/// LaunchAgent / Scheduled Task, and the agent exchanges the code itself.
async fn install(token: &str) -> Result<(), Refusal> {
    let hub = hub_base();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| Refusal::Failed(format!("http: {e}")))?;
    let res = client
        .post(format!("{hub}/api/enrollments"))
        .bearer_auth(token)
        .header("sec-fetch-site", "same-origin")
        .header("content-type", "application/json")
        .body("{}")
        .send()
        .await
        .map_err(|e| Refusal::Failed(format!("хаб недоступен: {e}")))?;
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    let code = match status.as_u16() {
        201 => body
            .get("code")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| Refusal::Failed("хаб не дал код".into()))?,
        401 => return Err(Refusal::Wait("нужно войти".into())),
        403 => return Err(Refusal::Wait("доступ ещё не открыт".into())),
        429 => return Err(Refusal::Wait("лимит кодов на час — попробую позже".into())),
        other => {
            return Err(Refusal::Failed(format!(
                "код подключения: HTTP {other} {}",
                body.get("error").and_then(Value::as_str).unwrap_or("")
            )))
        }
    };

    let script_name = if cfg!(target_os = "macos") { "install-mac.sh" } else { "install-win.ps1" };
    let script = client
        .get(format!("{hub}/install/{script_name}"))
        .send()
        .await
        .map_err(|e| Refusal::Failed(format!("установщик не скачался: {e}")))?
        .error_for_status()
        .map_err(|e| Refusal::Failed(format!("установщик: {e}")))?
        .text()
        .await
        .map_err(|e| Refusal::Failed(format!("установщик: {e}")))?;
    let dir = std::env::temp_dir().join("hegai-code-enroll");
    std::fs::create_dir_all(&dir).map_err(|e| Refusal::Failed(format!("temp: {e}")))?;
    let path = dir.join(script_name);
    std::fs::write(&path, script).map_err(|e| Refusal::Failed(format!("temp: {e}")))?;

    let name = machine_name();
    let ws = ws_url(&hub);
    let path_for_task = path.clone();
    let run = tokio::task::spawn_blocking(move || run_installer(&path_for_task, &code, &name, &ws));
    let out = tokio::time::timeout(INSTALL_TIMEOUT, run)
        .await
        .map_err(|_| Refusal::Failed("установщик не завершился за 10 минут".into()))?
        .map_err(|e| Refusal::Failed(format!("установщик: {e}")))??;
    let _ = std::fs::remove_file(&path);
    println!("[enroll] installer: {}", tail(&out, 400));
    Ok(())
}

fn run_installer(path: &std::path::Path, code: &str, name: &str, ws: &str) -> Result<String, Refusal> {
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = Command::new("/bin/bash");
        c.arg(path).arg("--enrollment-code").arg(code).arg("--name").arg(name).arg("--url").arg(ws);
        // The GUI's PATH has no nvm/volta; the installer's own detection of
        // `codex` runs in this environment, so give it the usual dirs at least.
        c.env("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
        c
    } else {
        let mut c = Command::new("powershell.exe");
        c.arg("-NoProfile")
            .arg("-ExecutionPolicy")
            .arg("Bypass")
            .arg("-File")
            .arg(path)
            .arg("-EnrollmentCode")
            .arg(code)
            .arg("-Name")
            .arg(name)
            .arg("-Url")
            .arg(ws);
        c
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().map_err(|e| Refusal::Failed(format!("не запустился: {e}")))?;
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if output.status.success() {
        Ok(text)
    } else {
        Err(Refusal::Failed(format!("код {}: {}", output.status.code().unwrap_or(-1), tail(&text, 300))))
    }
}

/// `wss://host[:port]` from the hub's `https://host[:port]`.
pub fn ws_url(hub: &str) -> String {
    hub.replacen("https://", "wss://", 1).replacen("http://", "ws://", 1)
}

fn machine_name() -> String {
    if cfg!(target_os = "macos") {
        if let Ok(out) = Command::new("/usr/sbin/scutil").arg("--get").arg("ComputerName").output() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() {
                return s;
            }
        }
    }
    std::env::var("COMPUTERNAME")
        .ok()
        .or_else(|| std::env::var("HOSTNAME").ok())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Этот компьютер".into())
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub struct Found {
    pub machine_id: Option<String>,
}

/// Is the agent installed here? The bundle plus its autostart registration;
/// a device token in `agent.json` says it is also enrolled, and carries the
/// machine id the page uses to say «this computer». A bundle with no token
/// counts as installed too: that is the agent waiting on a `/link` approval,
/// not a job for us.
pub fn installed(home: &std::path::Path) -> Option<Found> {
    let bundle = home.join("cc-remote-agent").join("agent.mjs");
    if !bundle.exists() {
        return None;
    }
    let registered = if cfg!(target_os = "macos") {
        home.join("Library/LaunchAgents/ai.heg.ccremote.agent.plist").exists()
    } else {
        home.join("cc-remote-agent").join("run-agent.cmd").exists()
    };
    let config = home.join(".cc-remote").join("agent.json");
    let machine_id = std::fs::read_to_string(&config)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("machineId").and_then(Value::as_str).map(str::to_string));
    if registered || machine_id.is_some() {
        Some(Found { machine_id })
    } else {
        None
    }
}

fn tail(s: &str, n: usize) -> String {
    let t: String = s.chars().rev().take(n).collect::<Vec<_>>().into_iter().rev().collect();
    t.trim().replace('\n', " · ")
}

/// Tray row, app state, and the page — all three read the same phase.
fn publish(app: &AppHandle, phase: Phase) {
    let changed = match app.try_state::<EnrollState>() {
        Some(st) => {
            let mut cur = st.0.lock().unwrap();
            let changed = *cur != phase;
            *cur = phase.clone();
            changed
        }
        None => true,
    };
    // On Windows the running-process supervisor owns the row once the
    // install exists; we only speak before that.
    let speak = !(cfg!(windows) && matches!(phase, Phase::Installed { .. }));
    if speak {
        crate::set_agent_status(app, &phase.summary());
    }
    if changed || matches!(phase, Phase::Installed { .. }) {
        if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
            let _ = w.eval(&page_script(&phase));
        }
    }
}

/// What the page learns. Plain assignment plus an event, so a component can
/// both read it on mount and re-render when it changes.
pub fn page_script(phase: &Phase) -> String {
    format!(
        "window.__HEGAI_AGENT__ = {}; window.dispatchEvent(new Event('hegai-agent'));",
        phase.to_json()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_reads_the_bundle_and_the_registration() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        assert!(installed(home).is_none(), "nothing there");
        std::fs::create_dir_all(home.join("cc-remote-agent")).unwrap();
        std::fs::write(home.join("cc-remote-agent/agent.mjs"), "x").unwrap();
        assert!(installed(home).is_none(), "a bundle alone is a half-finished install");
        std::fs::create_dir_all(home.join(".cc-remote")).unwrap();
        std::fs::write(home.join(".cc-remote/agent.json"), r#"{"machineId":"m-1","deviceToken":"t"}"#).unwrap();
        let found = installed(home).expect("token means enrolled");
        assert_eq!(found.machine_id.as_deref(), Some("m-1"));
    }

    #[test]
    fn the_page_gets_a_phase_and_an_event_and_no_secrets() {
        let js = page_script(&Phase::Installed { machine_id: Some("m-1".into()) });
        assert!(js.contains(r#""phase":"installed""#));
        assert!(js.contains(r#""machineId":"m-1""#));
        assert!(js.contains("new Event('hegai-agent')"));
        assert_eq!(page_script(&Phase::Waiting("доступ ещё не открыт".into())).contains("waiting"), true);
    }

    #[test]
    fn ws_url_follows_the_hub_including_a_spare_port() {
        assert_eq!(ws_url("https://code.acme.test"), "wss://code.acme.test");
        assert_eq!(ws_url("https://code.acme.test:8443"), "wss://code.acme.test:8443");
        assert_eq!(ws_url("http://127.0.0.1:4319"), "ws://127.0.0.1:4319");
    }
}
