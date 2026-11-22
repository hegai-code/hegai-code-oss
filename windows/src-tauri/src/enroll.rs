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
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// The hub revoked this machine, or the agent was removed from a computer
    /// that had one. Not a fault to fix by itself: re-enrolling on our own is
    /// exactly what brought a revoked Mac back, so we wait for the person.
    Disconnected(String),
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
            Phase::Disconnected(_) => "агент: компьютер отключён".into(),
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
            Phase::Disconnected(why) => json!({"phase":"disconnected","reason":why}),
        }
    }
}

pub struct EnrollState(pub Mutex<Phase>);

/// How often to look while signed out or already installed.
const IDLE_POLL: Duration = Duration::from_secs(5);
const INSTALLED_POLL: Duration = Duration::from_secs(60);
const RETRY_MAX: Duration = Duration::from_secs(15 * 60);
/// How long an agent may sit with a machineId and no device token (trading
/// its code) before a revoked machine reads as disconnected again.
const ENROLL_GRACE: Duration = Duration::from_secs(10 * 60);

pub fn spawn(app: AppHandle) {
    app.manage(EnrollState(Mutex::new(Phase::Checking)));
    tauri::async_runtime::spawn(async move {
        supervise(app).await;
    });
}

/// Set by the tray's «Подключить этот компьютер». Global because the menu
/// handler has no handle to the supervisor loop.
pub static RECONNECT: AtomicBool = AtomicBool::new(false);

/// File in the app config dir listing the hubs this computer has had an agent
/// enrolled on, one origin per line. «No agent» alone cannot tell a fresh
/// computer from one whose person removed the agent on purpose.
const HUBS_MARKER: &str = "agent-hubs";

/// What one pass of the loop should do, decided from facts only.
#[derive(Debug, PartialEq, Eq)]
enum Action {
    /// Agent present; the caller still asks the hub whether it was revoked.
    Installed,
    NotSignedIn,
    /// Agent gone from a computer that had one on this hub: do not reinstall.
    Disconnected,
    /// Enroll. `retire_config` when the person asked to reconnect, because a
    /// leftover agent.json (deviceToken) outranks the fresh code.
    Install { retire_config: bool },
}

fn decide(installed: bool, hub_known: bool, reconnect: bool, signed_in: bool) -> Action {
    if installed {
        return Action::Installed;
    }
    if !signed_in {
        return Action::NotSignedIn;
    }
    if reconnect {
        return Action::Install { retire_config: true };
    }
    if hub_known {
        return Action::Disconnected;
    }
    Action::Install { retire_config: false }
}

/// What the current hub says about this machine.
#[derive(Debug, PartialEq, Eq)]
enum Listing {
    /// On this person's list, active.
    Active,
    /// On the list, revoked.
    Revoked,
    /// Not on the list (another hub's agent, someone else's machine) or no
    /// usable answer. Never «disconnected»: a hiccup must not tell a working
    /// computer it was cut off.
    Unknown,
}

/// `/api/devices` answers `{"devices":[{"machineId","revoked",…}]}`.
fn listing(body: &str, machine_id: &str) -> Listing {
    let Ok(v) = serde_json::from_str::<Value>(body) else {
        return Listing::Unknown;
    };
    let Some(d) = v
        .get("devices")
        .and_then(Value::as_array)
        .and_then(|list| list.iter().find(|d| d.get("machineId").and_then(Value::as_str) == Some(machine_id)))
    else {
        return Listing::Unknown;
    };
    if d.get("revoked").and_then(Value::as_bool) == Some(true) {
        Listing::Revoked
    } else {
        Listing::Active
    }
}

async fn device_listing(token: &str, machine_id: &str) -> Listing {
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(15)).build() else {
        return Listing::Unknown;
    };
    let res = client
        .get(format!("{}/api/devices", hub_base()))
        .bearer_auth(token)
        .header("sec-fetch-site", "same-origin")
        .send()
        .await;
    let Ok(res) = res else { return Listing::Unknown };
    if !res.status().is_success() {
        return Listing::Unknown;
    }
    match res.text().await {
        Ok(body) => listing(&body, machine_id),
        Err(_) => Listing::Unknown,
    }
}

fn hub_listed(marker: &std::path::Path, hub: &str) -> bool {
    let hub = hub.trim_end_matches('/');
    std::fs::read_to_string(marker)
        .map(|s| s.lines().any(|l| l.trim().trim_end_matches('/') == hub))
        .unwrap_or(false)
}

/// Add `hub` once. Returns whether the file changed.
fn remember_hub(marker: &std::path::Path, hub: &str) -> std::io::Result<bool> {
    if hub_listed(marker, hub) {
        return Ok(false);
    }
    let mut text = std::fs::read_to_string(marker).unwrap_or_default();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(hub.trim_end_matches('/'));
    text.push('\n');
    std::fs::write(marker, text)?;
    Ok(true)
}

/// Drop the old (revoked) device token from agent.json, keeping a backup.
/// The agent prefers its stored deviceToken over an enrollment code, so a
/// reconnect would otherwise keep presenting the dead token. `machineId` and
/// the name stay: exchanging a code for the same machine id re-activates that
/// device row (history, no second slot) instead of creating a new machine.
/// Returns the backup's path, `None` when there was nothing to retire.
fn retire_agent_config(home: &std::path::Path, stamp_ms: u128) -> std::io::Result<Option<PathBuf>> {
    let dir = home.join(".cc-remote");
    let cfg = dir.join("agent.json");
    let Ok(text) = std::fs::read_to_string(&cfg) else {
        return Ok(None);
    };
    let backup = dir.join(format!("agent.json.disconnected-{stamp_ms}"));
    std::fs::copy(&cfg, &backup)?;
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(mut map)) => {
            map.remove("deviceToken");
            let out = serde_json::to_string_pretty(&Value::Object(map))
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
            // Temp file + rename: an agent restarting right now must never read
            // a truncated file — it would mint a new machineId and keep it.
            let tmp = dir.join(format!("agent.json.tmp-{stamp_ms}"));
            std::fs::write(&tmp, out)?;
            if let Ok(meta) = std::fs::metadata(&cfg) {
                let _ = std::fs::set_permissions(&tmp, meta.permissions());
            }
            std::fs::rename(&tmp, &cfg)?;
        }
        // Unreadable: nothing worth keeping in place, a fresh one is better.
        _ => std::fs::remove_file(&cfg)?,
    }
    Ok(Some(backup))
}

fn has_token(path: &std::path::Path) -> bool {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .is_some_and(|v| v.get("deviceToken").is_some())
}

/// Undo `retire_agent_config` after an installer that did not get through,
/// unless the agent already holds a new token by then. The tokenless file is
/// claimed by a rename first and the backup put in with a hard link (which
/// refuses an existing target), so a fresh token the agent writes meanwhile
/// is never overwritten.
fn restore_agent_config(home: &std::path::Path, backup: &std::path::Path) -> std::io::Result<bool> {
    let dir = home.join(".cc-remote");
    let cfg = dir.join("agent.json");
    if has_token(&cfg) || !backup.exists() {
        return Ok(false);
    }
    let staged = dir.join("agent.json.restore");
    let _ = std::fs::remove_file(&staged);
    std::fs::copy(backup, &staged)?;
    let claimed = dir.join("agent.json.tokenless");
    let _ = std::fs::remove_file(&claimed);
    let had_cfg = std::fs::rename(&cfg, &claimed).is_ok();
    if had_cfg && has_token(&claimed) {
        // The agent wrote its fresh token between the check and the claim.
        let _ = std::fs::hard_link(&claimed, &cfg);
        let _ = std::fs::remove_file(&claimed);
        let _ = std::fs::remove_file(&staged);
        return Ok(false);
    }
    match std::fs::hard_link(&staged, &cfg) {
        Ok(()) => {
            let _ = std::fs::remove_file(&staged);
            let _ = std::fs::remove_file(&claimed);
            Ok(true)
        }
        // Someone created agent.json in the meantime: theirs wins.
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let _ = std::fs::remove_file(&staged);
            let _ = std::fs::remove_file(&claimed);
            Ok(false)
        }
        // No link possible: never leave the machine without its identity —
        // put the claimed (tokenless, machineId intact) file back.
        Err(e) => {
            if had_cfg && !cfg.exists() {
                let _ = std::fs::rename(&claimed, &cfg);
            }
            let _ = std::fs::remove_file(&staged);
            Err(e)
        }
    }
}

/// Is the loop showing «отключён»? The Windows process supervisor asks before
/// it writes the tray row, or «агент работает» would paper over it.
pub fn is_disconnected(app: &AppHandle) -> bool {
    app.try_state::<EnrollState>()
        .map(|st| matches!(*st.0.lock().unwrap(), Phase::Disconnected(_)))
        .unwrap_or(false)
}

/// One-shot wake-up for `nap`, separate from `RECONNECT`: the request may
/// have to wait for a sign-in, and a nap that woke on it would spin.
static WAKE: AtomicBool = AtomicBool::new(false);

/// An install (first or reconnect) is running, or a reconnect was asked for
/// and has not finished. The Windows process supervisor holds off restarting
/// the agent meanwhile: the installer stops and starts it itself, and a second
/// launch next to it would put two daemons on one machineId (single writer).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn reconnect_in_progress() -> bool {
    RECONNECT.load(Ordering::SeqCst) || INSTALLING.load(Ordering::SeqCst)
}

/// Set for exactly the span of `install()` — which now always waits for the
/// installer process to end, so the flag cannot outlive or undercut it.
static INSTALLING: AtomicBool = AtomicBool::new(false);

/// Tray click: ask the loop to enroll again and show that something happens.
pub fn request_reconnect(app: &AppHandle) {
    RECONNECT.store(true, Ordering::SeqCst);
    WAKE.store(true, Ordering::SeqCst);
    publish(app, Phase::Installing);
}

/// Sleep, but wake early (once) when the person clicks «Подключить».
async fn nap(d: Duration) {
    let mut left = d;
    while !left.is_zero() && !WAKE.swap(false, Ordering::SeqCst) {
        let step = left.min(Duration::from_secs(1));
        tokio::time::sleep(step).await;
        left -= step;
    }
}

async fn supervise(app: AppHandle) {
    await_webview().await;
    let mut retry = IDLE_POLL;
    // Since when agent.json has had a machineId but no device token. A
    // reconnect strips the token; if the agent never trades its code for a new
    // one (code expired, installer timed out) the revoked machine must not sit
    // as «installed» with the reconnect item disabled forever.
    let mut unenrolled_since: Option<std::time::Instant> = None;
    loop {
        let marker = crate::update::state_path(&app, HUBS_MARKER);
        let hub = hub_base();
        let found = installed(&home_dir());
        let token = crate::hub::session_token(&app);
        let hub_known = marker.as_deref().map(|m| hub_listed(m, &hub)).unwrap_or(false);
        let reconnect = RECONNECT.load(Ordering::SeqCst);
        let action = decide(found.is_some(), hub_known, reconnect, token.is_some());
        match action {
            Action::Installed => {
                let found = found.expect("decide returned Installed");
                if let Some(id) = found.machine_id.as_deref() {
                    if let Some(t) = token.as_deref() {
                        // An explicit click is honoured whatever the device row
                        // says now: «Вернуть» on the site clears the row's
                        // revoked bit but leaves the agent's credential dead.
                        if reconnect {
                            reconnect_install(&app, t, &mut retry).await;
                            unenrolled_since = None;
                            continue;
                        }
                        let listed = device_listing(t, id).await;
                        // Remember the hub only once it lists this machine: after
                        // «Сервер…» the agent on disk may still belong to the old
                        // hub, and marking the new one would later read a removal
                        // there as deliberate.
                        if listed != Listing::Unknown {
                            if let Some(m) = marker.as_deref() {
                                if let Err(e) = remember_hub(m, &hub) {
                                    eprintln!("[enroll] cannot write {HUBS_MARKER}: {e}");
                                }
                            }
                        }
                        if found.enrolled {
                            unenrolled_since = None;
                        } else if unenrolled_since.is_none() {
                            unenrolled_since = Some(std::time::Instant::now());
                        }
                        let stuck = unenrolled_since.is_some_and(|t| t.elapsed() > ENROLL_GRACE);
                        if listed == Listing::Revoked && (found.enrolled || stuck) {
                            publish(&app, Phase::Disconnected("отключён на сервере".into()));
                            nap(INSTALLED_POLL).await;
                            continue;
                        }
                    }
                }
                // A click while signed out waits for the sign-in, as in `decide`.
                if token.is_some() {
                    RECONNECT.store(false, Ordering::SeqCst);
                }
                publish(&app, Phase::Installed { machine_id: found.machine_id });
                nap(INSTALLED_POLL).await;
            }
            Action::NotSignedIn => {
                publish(&app, Phase::NotSignedIn);
                nap(IDLE_POLL).await;
            }
            Action::Disconnected => {
                publish(&app, Phase::Disconnected("агент удалён с компьютера".into()));
                nap(INSTALLED_POLL).await;
            }
            Action::Install { retire_config } => {
                let token = token.expect("decide checked the session");
                if retire_config {
                    reconnect_install(&app, &token, &mut retry).await;
                } else {
                    install_once(&app, &token, &mut retry).await;
                }
            }
        }
    }
}

/// Reconnect: retire the stale agent.json, enroll, and drop the request
/// whether or not it worked (a failure shows as Failed; the menu item lets
/// the person try again from Disconnected).
async fn reconnect_install(app: &AppHandle, token: &str, retry: &mut Duration) {
    install_with(app, token, retry, true).await;
    RECONNECT.store(false, Ordering::SeqCst);
}

async fn install_once(app: &AppHandle, token: &str, retry: &mut Duration) {
    install_with(app, token, retry, false).await;
}

async fn install_with(app: &AppHandle, token: &str, retry: &mut Duration, retire: bool) {
    publish(app, Phase::Installing);
    INSTALLING.store(true, Ordering::SeqCst);
    let outcome = install(token, retire).await;
    INSTALLING.store(false, Ordering::SeqCst);
    match outcome {
        Ok(()) => {
            println!("[enroll] agent installed and enrolled");
            *retry = IDLE_POLL;
        }
        Err(Refusal::Wait(why)) => {
            println!("[enroll] not yet: {why}");
            publish(app, Phase::Waiting(why));
            nap(*retry).await;
            *retry = (*retry * 2).min(RETRY_MAX);
        }
        Err(Refusal::Failed(why)) => {
            eprintln!("[enroll] install failed: {why}");
            publish(app, Phase::Failed(why));
            nap((*retry).max(Duration::from_secs(60))).await;
            *retry = (*retry * 2).min(RETRY_MAX);
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
///
/// `retire`: a reconnect. Only once the code and the installer are in hand
/// (a 429 or a dead network must not touch the machine) the old agent.json is
/// moved aside and, on Windows, the running revoked agent stopped; a failed
/// installer puts agent.json back.
async fn install(token: &str, retire: bool) -> Result<(), Refusal> {
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
    let home = home_dir();
    let retired = if retire {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        // macOS: unload the revoked agent and wait for it to be gone before
        // the installer runs. Older installers (self-hosted hubs keep theirs)
        // bootstrap right after bootout and fail with EIO while it exits.
        let p = match retire_agent_config(&home, stamp) {
            Ok(p) => p,
            Err(e) => return Err(Refusal::Failed(format!("agent.json: {e}"))),
        };
        #[cfg(target_os = "macos")]
        unload_mac_agent().await;
        p
    } else {
        None
    };
    let path_for_task = path.clone();
    let run = tokio::task::spawn_blocking(move || run_installer(&path_for_task, &code, &name, &ws));
    // Wait for the installer to END, however long it takes. With a timeout a
    // still-running installer (it may yet start the agent) would race the
    // restore of agent.json, the Windows supervisor and the next install
    // attempt; «устанавливаю…» in the tray is the honest state meanwhile.
    let result = match run.await {
        Err(e) => Err(Refusal::Failed(format!("установщик: {e}"))),
        Ok(r) => r,
    };
    let _ = std::fs::remove_file(&path);
    let out = match result {
        Ok(out) => out,
        Err(e) => {
            if let Some(p) = retired.as_deref() {
                if let Err(err) = restore_agent_config(&home, p) {
                    eprintln!("[enroll] cannot put agent.json back: {err}");
                }
            }
            // A reconnect unloaded the old agent; a failed install must not
            // leave the Mac with no agent at all until the next login.
            #[cfg(target_os = "macos")]
            {
                if retire {
                    reload_mac_agent(&home);
                }
            }
            return Err(e);
        }
    };
    println!("[enroll] installer: {}", tail(&out, 400));
    Ok(())
}

#[cfg(target_os = "macos")]
async fn unload_mac_agent() {
    const LABEL: &str = "ai.heg.ccremote.agent";
    let uid = match Command::new("/usr/bin/id").arg("-u").output() {
        Ok(o) => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        Err(_) => return,
    };
    let target = format!("gui/{uid}/{LABEL}");
    let _ = Command::new("/bin/launchctl").arg("bootout").arg(&target).output();
    for _ in 0..30 {
        let loaded = Command::new("/bin/launchctl")
            .arg("print")
            .arg(&target)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !loaded {
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    eprintln!("[enroll] {LABEL} still loaded after 15 s; installing anyway");
}

#[cfg(target_os = "macos")]
fn reload_mac_agent(home: &std::path::Path) {
    let plist = home.join("Library/LaunchAgents/ai.heg.ccremote.agent.plist");
    if !plist.exists() {
        return;
    }
    let Ok(o) = Command::new("/usr/bin/id").arg("-u").output() else {
        return;
    };
    let uid = String::from_utf8_lossy(&o.stdout).trim().to_string();
    // The old job may still be leaving launchd (EIO meanwhile): retry.
    for _ in 0..10 {
        // Only a bootstrap that succeeded counts: `print` may still see the
        // old job on its way out.
        let ok = Command::new("/bin/launchctl")
            .arg("bootstrap")
            .arg(format!("gui/{uid}"))
            .arg(&plist)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if ok {
            return;
        }
        std::thread::sleep(Duration::from_millis(1500));
    }
    eprintln!("[enroll] could not load the agent back after a failed reconnect");
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
    /// agent.json holds a device token. Without one the agent is still
    /// exchanging its code (or waiting on `/link`): the hub may report the
    /// machine revoked for a few more seconds, and that is not «disconnected».
    pub enrolled: bool,
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
    let parsed = std::fs::read_to_string(&config)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok());
    let machine_id = parsed
        .as_ref()
        .and_then(|v| v.get("machineId").and_then(Value::as_str).map(str::to_string));
    let enrolled = parsed.as_ref().is_some_and(|v| v.get("deviceToken").is_some());
    if registered || machine_id.is_some() {
        Some(Found { machine_id, enrolled })
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
    crate::set_reconnect_enabled(app, matches!(phase, Phase::Disconnected(_)));
    // Installed and Disconnected are re-sent on every pass: a reloaded page
    // starts at «checking» and would otherwise never hear them again.
    if changed || matches!(phase, Phase::Installed { .. } | Phase::Disconnected(_)) {
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

    #[test]
    fn revoked_is_read_from_the_devices_list() {
        let body = r#"{"devices":[{"machineId":"a","revoked":true},{"machineId":"b","revoked":false}]}"#;
        assert_eq!(listing(body, "a"), Listing::Revoked);
        assert_eq!(listing(body, "b"), Listing::Active);
        assert_eq!(listing(body, "zzz"), Listing::Unknown, "someone else's machine");
        assert_eq!(listing("not json", "a"), Listing::Unknown);
        assert_eq!(listing(r#"{"devices":"x"}"#, "a"), Listing::Unknown);
        assert_eq!(listing(r#"[{"machineId":"a","revoked":true}]"#, "a"), Listing::Unknown);
    }

    #[test]
    fn decide_never_reinstalls_on_its_own_after_an_agent_was_here() {
        use Action::*;
        assert_eq!(decide(true, true, false, true), Installed);
        assert_eq!(decide(false, false, false, false), NotSignedIn);
        assert_eq!(decide(false, true, true, false), NotSignedIn, "request waits for sign-in");
        assert_eq!(decide(false, false, false, true), Install { retire_config: false });
        assert_eq!(decide(false, true, false, true), Disconnected);
        assert_eq!(decide(false, true, true, true), Install { retire_config: true });
    }

    #[test]
    fn hub_marker_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let m = dir.path().join("agent-hubs");
        assert!(!hub_listed(&m, "https://a.example"));
        assert!(remember_hub(&m, "https://a.example").unwrap());
        assert!(!remember_hub(&m, "https://a.example/").unwrap());
        assert!(remember_hub(&m, "https://b.example").unwrap());
        assert!(hub_listed(&m, "https://a.example"));
        assert!(hub_listed(&m, "https://b.example"));
        assert!(!hub_listed(&m, "https://c.example"));
        assert_eq!(std::fs::read_to_string(&m).unwrap().lines().count(), 2);
    }

    #[test]
    fn retiring_the_config_moves_it_aside() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        let cfg = home.join(".cc-remote/agent.json");
        let read = || serde_json::from_str::<Value>(&std::fs::read_to_string(&cfg).unwrap()).unwrap();
        assert!(retire_agent_config(home, 1).unwrap().is_none());
        std::fs::create_dir_all(home.join(".cc-remote")).unwrap();
        std::fs::write(&cfg, r#"{"machineId":"m-1","name":"Mac","deviceToken":"dead"}"#).unwrap();
        let backup = retire_agent_config(home, 42).unwrap().expect("retired");
        // The identity stays, only the dead token goes.
        assert_eq!(read()["machineId"], "m-1");
        assert_eq!(read()["name"], "Mac");
        assert!(read().get("deviceToken").is_none());
        assert!(home.join(".cc-remote/agent.json.disconnected-42").exists());
        // A failed installer: the old file comes back.
        assert!(restore_agent_config(home, &backup).unwrap());
        assert_eq!(read()["deviceToken"], "dead");
        // The agent already got a fresh token: never overwrite it.
        let backup = retire_agent_config(home, 43).unwrap().expect("retired");
        std::fs::write(&cfg, r#"{"machineId":"m-1","deviceToken":"fresh"}"#).unwrap();
        assert!(!restore_agent_config(home, &backup).unwrap());
        assert_eq!(read()["deviceToken"], "fresh");
    }
}
