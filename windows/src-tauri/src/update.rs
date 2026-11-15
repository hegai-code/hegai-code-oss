//! Keeping the SHELL current — the one part of this product that does not ship
//! itself.
//!
//! The window renders `code.acme.test`, so the interface arrives with every web
//! deploy and the SPA even nags about it (`web/src/buildWatch.ts`). The Rust
//! around it had no such path: a fix in this crate reached nobody until someone
//! re-ran the install one-liner by hand, and the only way to learn what version
//! was live anywhere was to read the date on a file in `/dl/`.
//!
//! # Two things here are not obvious
//!
//! **The endpoint is per-platform** — `updates-{{target}}.json`, and `{{target}}`
//! is the bare OS (`windows` / `darwin`), not a Rust triple. A STATIC Tauri
//! manifest carries ONE top-level `version` while the platform entries carry
//! only a url and a signature. Windows and macOS are built on different machines
//! at different times, so a shared manifest declaring the newer of the two would
//! tell the other platform's clients that a version exists and then hand them
//! the older payload. They would install it, still be behind, and be told again
//! — forever. Two files cannot do that to each other.
//!
//! **A failed check in the BACKGROUND never reaches the menu.** A tray that
//! reads «не удалось обновить» because a laptop lid closed is the same noise
//! `offline.rs` spent `FAILURES_BEFORE_PARK` on. `Stage::Failed` is reachable
//! only from a click, where somebody is waiting for an answer.
//!
//! # What cannot be tested here
//!
//! `check`/`download`/`install`, the NSIS Restart Manager and the relaunch all
//! need a bundled, signed app talking to a real manifest. The pure half — every
//! label, the once-only announcement, the progress throttle, the backoff, and
//! the shape of the config — is tested at the bottom of this file. The rest is
//! proved by a real version hop on a real machine (deploy/FLEET.md).

use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::hub;

/// Before the FIRST check. Long enough that a cold start, a VPN coming up and
/// `offline.rs`'s own liveness probe all happen first — a check racing the login
/// screen is a check that fails for reasons that have nothing to do with
/// updates, and the first thing a person would see is a wrong answer.
const FIRST_CHECK: Duration = Duration::from_secs(90);
/// Between checks after that. This app lives in the tray for weeks at a time, so
/// the interval is what actually decides whether anyone ever hears about a
/// release; four times a day is plenty and costs one 400-byte GET.
const INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// First backoff after a failed background check, doubling up to `INTERVAL`.
const RETRY_MIN: Duration = Duration::from_secs(10 * 60);

/// The version we have already announced. Without it the toast would fire every
/// six hours for as long as somebody puts off updating.
const SEEN_FILE: &str = "update-seen";
/// The version we were installing when we handed control to the installer.
/// Written immediately BEFORE the install, read and cleared on the next start.
const PENDING_FILE: &str = "update-pending";

/// What the tray row knows. One value, because the row is one row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Stage {
    /// Nothing asked yet. The label is an invitation.
    Unknown,
    Checking,
    /// This build is the newest one. Carries the RUNNING version, because
    /// «обновлений нет» with no number is a sentence people do not believe.
    Current(String),
    /// A newer build exists. Carries the NEW version.
    Ready(String),
    /// Bytes are moving. `None` when the server sent no Content-Length.
    Downloading(Option<u8>),
    /// The last attempt A PERSON MADE failed. Never set from the poll loop.
    Failed,
}

static STAGE: Mutex<Stage> = Mutex::new(Stage::Unknown);
/// The update `check()` handed us, kept so the click that follows does not have
/// to ask again.
static FOUND: Mutex<Option<Update>> = Mutex::new(None);

/// The tray's update row. Held so it can be rewritten in place — rebuilding the
/// menu would close it under the cursor (see `AgentMenuItem` in main.rs), and
/// this is the row most likely to change WHILE the menu is open, because that is
/// where the download reports itself.
pub(crate) struct UpdateMenuItem(pub(crate) MenuItem<tauri::Wry>);

// ---------------------------------------------------------------------------
// pure — everything below this line down to `render` is testable without Tauri
// ---------------------------------------------------------------------------

fn label(stage: &Stage) -> String {
    match stage {
        Stage::Unknown => "Проверить обновления".to_string(),
        Stage::Checking => "Проверяю обновления…".to_string(),
        Stage::Current(v) => format!("Обновлений нет — версия {v}"),
        Stage::Ready(v) => format!("Обновить до {v}"),
        Stage::Downloading(Some(p)) => format!("Загружаю обновление — {p} %"),
        Stage::Downloading(None) => "Загружаю обновление…".to_string(),
        Stage::Failed => "Не удалось обновить — как поставить вручную".to_string(),
    }
}

/// A row you cannot act on is disabled rather than hidden: a menu that changes
/// LENGTH under the cursor is worse than one that greys a line.
fn enabled(stage: &Stage) -> bool {
    !matches!(stage, Stage::Checking | Stage::Downloading(_))
}

/// Say it once per version, not once per check.
fn should_announce(found: &str, seen: Option<&str>) -> bool {
    seen != Some(found)
}

/// What the last run's install actually did.
#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    Nothing,
    Applied(String),
    DidNotStick { wanted: String, running: String },
}

/// Compare what we were installing with what is actually running now.
///
/// This is the honesty check, and it exists because of two separate traps.
/// On Windows the relaunch reuses the ORIGINAL argv, and the logon task starts
/// this app with `--background` — so for those users the post-update app comes
/// back into the tray with no window, and the toast is the only evidence they
/// will ever get that anything happened. On macOS this is the machine-checkable
/// form of the incident in deploy/FLEET.md («an update that looks applied and is
/// not»): the installer swapped the bundle, `single-instance` handed focus back
/// to the old process, and everyone believed the new version was running.
fn startup_verdict(pending: Option<&str>, running: &str) -> Verdict {
    match pending {
        None => Verdict::Nothing,
        Some(p) if p == running => Verdict::Applied(p.to_string()),
        Some(p) => Verdict::DidNotStick {
            wanted: p.to_string(),
            running: running.to_string(),
        },
    }
}

/// Whether this chunk is worth repainting the menu for.
///
/// `on_chunk` fires per network chunk — hundreds of times a second on a fast
/// link. Rewriting a menu item that often hammers the main thread for no visible
/// gain, so the row only moves when the whole percent does.
fn tick(done: u64, total: Option<u64>, last: Option<u8>) -> Option<u8> {
    let total = total?;
    if total == 0 {
        return None;
    }
    // `min` because a server that understates Content-Length would otherwise
    // produce «Загружаю обновление — 137 %».
    let pct = (done.min(total).saturating_mul(100) / total) as u8;
    if Some(pct) == last {
        None
    } else {
        Some(pct)
    }
}

/// How long to wait before the next background check.
fn poll_delay(failures: u32) -> Duration {
    if failures == 0 {
        return INTERVAL;
    }
    let steps = (failures - 1).min(5);
    RETRY_MIN.saturating_mul(1u32 << steps).min(INTERVAL)
}

/// Where a person is sent when the automatic path failed.
///
/// A PAGE, never a file in `/dl/`. The Windows build carries no Authenticode, so
/// a browser download gets Mark of the Web and SmartScreen refuses to run it —
/// the dialog `deploy/install-app-win.ps1` apologises for. The one-liner on the
/// install page is fetched by PowerShell, which attaches no such mark. (None of
/// this applies to the updater itself: it writes the file from Rust, and Mark of
/// the Web is something a DOWNLOADING APP attaches, not a property of bytes.)
fn manual_help_url() -> String {
    format!("{}/install/app", crate::hub_base())
}

// ---------------------------------------------------------------------------
// state + menu
// ---------------------------------------------------------------------------

fn current_stage() -> Stage {
    STAGE.lock().map(|g| g.clone()).unwrap_or(Stage::Unknown)
}

fn set_stage(app: &AppHandle, next: Stage) {
    if let Ok(mut g) = STAGE.lock() {
        *g = next;
    }
    render(app);
}

/// Rewrite the row from the current stage.
fn render(app: &AppHandle) {
    let stage = current_stage();
    if let Some(item) = app.try_state::<UpdateMenuItem>() {
        let _ = item.0.set_text(label(&stage));
        let _ = item.0.set_enabled(enabled(&stage));
    }
}

/// The label the row is BUILT with, long before any check has run.
pub(crate) fn menu_label() -> String {
    label(&current_stage())
}

pub(crate) fn menu_enabled() -> bool {
    enabled(&current_stage())
}

// ---------------------------------------------------------------------------
// remembered between launches — one word per file, exactly like the hub's
// notify-policy: a dependency to hold one word is a dependency to keep current
// forever.
// ---------------------------------------------------------------------------

pub(crate) fn state_path(app: &AppHandle, name: &str) -> Option<std::path::PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join(name))
}

pub(crate) fn read_word(app: &AppHandle, name: &str) -> Option<String> {
    let raw = state_path(app, name).and_then(|p| std::fs::read_to_string(p).ok())?;
    let word = raw.trim().to_string();
    if word.is_empty() {
        None
    } else {
        Some(word)
    }
}

pub(crate) fn write_word(app: &AppHandle, name: &str, word: &str) {
    if let Some(path) = state_path(app, name) {
        let _ = std::fs::write(path, word);
    }
}

pub(crate) fn clear_word(app: &AppHandle, name: &str) {
    if let Some(path) = state_path(app, name) {
        let _ = std::fs::remove_file(path);
    }
}

fn running_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------

pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Before the first sleep: this is about the LAST run, and the person may
        // well be looking at the tray right now wondering what just happened.
        greet_on_start(&app);
        tokio::time::sleep(FIRST_CHECK).await;
        let mut failures = 0u32;
        loop {
            match check(&app).await {
                Ok(()) => failures = 0,
                Err(e) => {
                    failures = failures.saturating_add(1);
                    // The plugin logs through `log`, and this app installs no
                    // logger — these prints are the only diagnostics that exist.
                    eprintln!("[update] проверка не удалась ({failures}): {e}");
                }
            }
            tokio::time::sleep(poll_delay(failures)).await;
        }
    });
}

/// Unlike `hub::supervise` this does NOT wait for `await_webview()`: nothing
/// here touches the webview, so the gate would only delay the first check.
async fn check(app: &AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(found)) => {
            let version = found.version.clone();
            if let Ok(mut g) = FOUND.lock() {
                *g = Some(found);
            }
            set_stage(app, Stage::Ready(version.clone()));
            announce(app, &version);
            Ok(())
        }
        Ok(None) => {
            set_stage(app, Stage::Current(running_version(app)));
            Ok(())
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Toast about a version once, ever.
fn announce(app: &AppHandle, version: &str) {
    if !should_announce(version, read_word(app, SEEN_FILE).as_deref()) {
        return;
    }
    // Recorded even when the toast is suppressed: somebody who turned
    // notifications off should not be shouted at the moment they turn them on.
    write_word(app, SEEN_FILE, version);
    if hub::current_policy() == hub::NotifyPolicy::Off {
        return;
    }
    hub::emit(
        app,
        "Hegai Code",
        &format!("Вышла версия {version} — «Обновить приложение» в меню значка"),
        None,
    );
}

/// What the last install did, said out loud.
fn greet_on_start(app: &AppHandle) {
    let pending = read_word(app, PENDING_FILE);
    let running = running_version(app);
    match startup_verdict(pending.as_deref(), &running) {
        Verdict::Nothing => {}
        Verdict::Applied(v) => {
            clear_word(app, PENDING_FILE);
            println!("[update] обновление до {v} применилось");
            if hub::current_policy() != hub::NotifyPolicy::Off {
                hub::emit(app, "Hegai Code", &format!("Обновлено до {v}"), None);
            }
        }
        Verdict::DidNotStick { wanted, running } => {
            clear_word(app, PENDING_FILE);
            eprintln!("[update] обновление до {wanted} не встало — работает {running}");
            // Offer it again rather than pretend it happened. `FOUND` is empty
            // on a fresh process, so the click falls through to a re-check,
            // which is exactly right.
            set_stage(app, Stage::Ready(wanted));
        }
    }
}

// ---------------------------------------------------------------------------
// the click
// ---------------------------------------------------------------------------

pub fn on_menu_click(app: &AppHandle) {
    match current_stage() {
        // Disabled in the menu; guarded here too, because a menu item's enabled
        // state is a hint and not a lock.
        Stage::Checking | Stage::Downloading(_) => {}
        Stage::Ready(_) => start_install(app),
        Stage::Failed => crate::open_externally(app, &manual_help_url()),
        // Somebody clicking a row that says «обновлений нет» is asking «точно?».
        Stage::Unknown | Stage::Current(_) => start_check(app),
    }
}

/// What a press of the row from the PAGE's menu bar will do, decided once
/// (`appmenu::shell_update`). The page's press is two steps with a dialog in
/// between, and the stage can move meanwhile (a background check finds a
/// build); so the decision is taken first and carried out exactly as taken —
/// a prepared check never turns into an install, and an install confirmed for
/// one version never installs another.
pub(crate) enum PagePress {
    /// Nothing to do right now (a check or a download is already running).
    Busy,
    /// Look for a build. Never installs.
    Check,
    /// Install exactly this version, once the person has said yes.
    Install(String),
}

pub(crate) fn page_press() -> PagePress {
    match current_stage() {
        Stage::Checking | Stage::Downloading(_) => PagePress::Busy,
        // After a failure the tray opens the manual-install page in the
        // browser; the page only gets to re-check, so it cannot open browser
        // tabs by pressing this in a loop.
        Stage::Unknown | Stage::Current(_) | Stage::Failed => PagePress::Check,
        Stage::Ready(v) => PagePress::Install(v),
    }
}

/// Carry out `PagePress::Check`: a check, and only if nothing else started.
pub(crate) fn page_check(app: &AppHandle) {
    if matches!(current_stage(), Stage::Unknown | Stage::Current(_) | Stage::Failed) {
        start_check(app);
    }
}

/// Carry out a confirmed `PagePress::Install(version)`: install the update
/// held right now only if it IS that version. False when the moment passed.
pub(crate) fn page_install(app: &AppHandle, version: &str) -> bool {
    let Ok(update) = claim_install(app, Some(version)) else {
        return false;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = apply(&app, update).await {
            eprintln!("[update] обновление не встало: {e}");
            set_stage(&app, Stage::Failed);
        }
    });
    true
}

fn start_check(app: &AppHandle) {
    set_stage(app, Stage::Checking);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = check(&app).await {
            eprintln!("[update] проверка по кнопке не удалась: {e}");
            set_stage(&app, Stage::Failed);
        }
    });
}

/// Take the held update for installing — atomically: under the stage lock it
/// checks the row still says `Ready` (and, from the page, the very version the
/// person confirmed), and flips it to `Downloading` before letting go. The
/// tray and the page can therefore never both start an install.
/// `Err(true)` = `Ready` but nothing held (see `start_install`).
fn claim_install(app: &AppHandle, expected: Option<&str>) -> Result<Update, bool> {
    let claimed = {
        let Ok(mut stage) = STAGE.lock() else { return Err(false) };
        let ready = match &*stage {
            Stage::Ready(v) => v.clone(),
            _ => return Err(false),
        };
        if expected.is_some_and(|e| e != ready) {
            return Err(false);
        }
        let Some(update) = FOUND.lock().ok().and_then(|g| g.clone()) else {
            return Err(true);
        };
        if update.version != ready {
            return Err(false);
        }
        *stage = Stage::Downloading(None);
        update
    };
    render(app);
    Ok(claimed)
}

fn start_install(app: &AppHandle) {
    let update = match claim_install(app, None) {
        Ok(u) => u,
        // Offered but not held — the only way here is `DidNotStick`, which sets
        // `Ready` on a process that never ran a check.
        Err(true) => {
            start_check(app);
            return;
        }
        Err(false) => return,
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = apply(&app, update).await {
            eprintln!("[update] обновление не встало: {e}");
            set_stage(&app, Stage::Failed);
            // The menu may well be closed; a failure nobody can see is a failure
            // that gets reported as «я нажал, и ничего».
            hub::emit(
                &app,
                "Hegai Code",
                "Не удалось обновить — в меню значка есть ручной способ",
                None,
            );
        }
    });
}

/// A progress callback that owns its own counters — no shared state, so nothing
/// to lock and nothing to poison.
fn progress_cb(app: &AppHandle) -> impl FnMut(usize, Option<u64>) + Send + 'static {
    let app = app.clone();
    let mut done = 0u64;
    let mut last: Option<u8> = None;
    move |chunk, total| {
        done = done.saturating_add(chunk as u64);
        if let Some(pct) = tick(done, total, last) {
            last = Some(pct);
            set_stage(&app, Stage::Downloading(Some(pct)));
        }
    }
}

/// Windows: the plugin hands the NSIS installer the running app's own argv and
/// then calls `process::exit(0)` — **nothing after this returns on success**.
///
/// The installer's `CheckIfAppIsRunning` macro force-closes the live
/// `hegai-code.exe` through the Restart Manager, so none of the `Stop-Process`
/// choreography in `deploy/install-app-win.ps1` is needed here. That also means
/// `installMode` must stay `passive`: the template only honours the relaunch
/// flag when passive or silent, and silent would make the app vanish and return
/// with no feedback at all.
#[cfg(windows)]
async fn apply(app: &AppHandle, update: Update) -> Result<(), String> {
    write_word(app, PENDING_FILE, &update.version);
    update
        .download_and_install(progress_cb(app), || {})
        .await
        .map_err(|e| e.to_string())
}

/// macOS: `download_and_install` is the wrong call here, and the split is
/// load-bearing three times over.
///
/// 1. `install()` must not run on the main thread — its permission-denied branch
///    does `run_on_main_thread` and then blocks on the reply, which from the
///    main thread is a deadlock, and the `unwrap` there would be an abort under
///    `panic = "abort"`.
/// 2. On macOS `install()` does NOT relaunch: it returns `Ok` with the old
///    binary still in memory. Windows exits for you; here we have to ask.
/// 3. `restart()` off the main thread reaches `RunEvent::Exit` properly, and
///    plugins get `Exit` BEFORE the successor is spawned — which is what lets
///    `single-instance` drop its socket in time for the new process to claim it.
///    `greet_on_start` is the safety net if that reasoning is ever wrong.
///
/// If the bundle is not writable the plugin escalates through AppleScript and
/// the person gets a system credential prompt; declining lands in
/// `Stage::Failed`, which is the right answer. Note for whoever proposes
/// renaming the product: that escalation path builds a shell string and
/// `expect`s it to compile, so an apostrophe in the bundle path would abort the
/// app. Ours is `/Applications/Hegai Code.app`.
#[cfg(not(windows))]
async fn apply(app: &AppHandle, update: Update) -> Result<(), String> {
    let bytes = update
        .download(progress_cb(app), || {})
        .await
        .map_err(|e| e.to_string())?;
    write_word(app, PENDING_FILE, &update.version);
    tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_row_says_which_version_it_means() {
        // Ready names the NEW version, Current the RUNNING one. Getting these
        // backwards produces a menu that reads plausibly and lies, and the swap
        // is invisible in review.
        assert_eq!(label(&Stage::Ready("0.1.6".into())), "Обновить до 0.1.6");
        assert_eq!(
            label(&Stage::Current("0.1.5".into())),
            "Обновлений нет — версия 0.1.5"
        );
    }

    #[test]
    fn every_stage_has_a_label_and_the_busy_ones_are_disabled() {
        assert_eq!(label(&Stage::Unknown), "Проверить обновления");
        assert_eq!(label(&Stage::Checking), "Проверяю обновления…");
        assert_eq!(
            label(&Stage::Downloading(Some(42))),
            "Загружаю обновление — 42 %"
        );
        assert_eq!(label(&Stage::Downloading(None)), "Загружаю обновление…");
        assert_eq!(
            label(&Stage::Failed),
            "Не удалось обновить — как поставить вручную"
        );

        assert!(enabled(&Stage::Unknown));
        assert!(enabled(&Stage::Current("0.1.5".into())));
        assert!(enabled(&Stage::Ready("0.1.6".into())));
        assert!(enabled(&Stage::Failed));
        assert!(!enabled(&Stage::Checking));
        assert!(!enabled(&Stage::Downloading(None)));
        assert!(!enabled(&Stage::Downloading(Some(7))));
    }

    #[test]
    fn a_version_is_announced_once_and_a_newer_one_again() {
        assert!(should_announce("0.1.6", None));
        assert!(!should_announce("0.1.6", Some("0.1.6")));
        assert!(should_announce("0.1.7", Some("0.1.6")));
    }

    #[test]
    fn an_update_that_did_not_stick_is_not_reported_as_applied() {
        // deploy/FLEET.md records the real incident: the bundle was replaced,
        // single-instance handed focus back to the OLD process, and everyone
        // believed the new version was running. This is that, checkable.
        assert_eq!(startup_verdict(None, "0.1.5"), Verdict::Nothing);
        assert_eq!(
            startup_verdict(Some("0.1.6"), "0.1.6"),
            Verdict::Applied("0.1.6".into())
        );
        assert_eq!(
            startup_verdict(Some("0.1.6"), "0.1.5"),
            Verdict::DidNotStick {
                wanted: "0.1.6".into(),
                running: "0.1.5".into(),
            }
        );
    }

    #[test]
    fn progress_repaints_only_when_the_whole_percent_moves() {
        assert_eq!(tick(50, Some(100), None), Some(50));
        assert_eq!(tick(50, Some(100), Some(50)), None);
        assert_eq!(tick(51, Some(100), Some(50)), Some(51));
    }

    #[test]
    fn progress_survives_a_server_that_lies_about_the_size() {
        // No Content-Length at all: the row stays on the indeterminate label
        // rather than dividing by a number it does not have.
        assert_eq!(tick(1_000, None, None), None);
        // A zero total would be a division by zero.
        assert_eq!(tick(1_000, Some(0), None), None);
        // An understated total must not produce «137 %».
        assert_eq!(tick(1_370, Some(1_000), None), Some(100));
    }

    #[test]
    fn a_failed_check_backs_off_and_never_past_the_normal_interval() {
        assert_eq!(poll_delay(0), INTERVAL);
        assert_eq!(poll_delay(1), RETRY_MIN);
        assert!(poll_delay(2) > poll_delay(1));
        assert!(poll_delay(3) > poll_delay(2));
        for failures in 0..50 {
            assert!(
                poll_delay(failures) <= INTERVAL,
                "backoff ran past the interval at {failures}"
            );
        }
    }

    #[test]
    fn the_manual_fallback_is_a_page_and_not_a_download() {
        // Linking /dl/HegaiCode-win-setup.exe is the plausible-looking change
        // this test exists to stop: that build is unsigned, a BROWSER download
        // marks it with the zone identifier, and SmartScreen then refuses to run
        // it. The install page hands over a PowerShell one-liner instead, which
        // attaches no such mark.
        let url = manual_help_url();
        assert!(url.ends_with("/install/app"), "{url}");
        assert!(!url.contains("/dl/"), "{url}");
    }

    #[test]
    fn the_updater_config_is_present_per_platform_and_signed() {
        // Guards three separate ways to break this silently:
        //   * removing `plugins.updater` — the plugin has no default for
        //     `pubkey`, so a missing key is a FATAL STARTUP ERROR, not a
        //     disabled feature;
        //   * dropping `{{target}}` — one shared manifest cannot serve two
        //     platforms that ship independently (see the module docs);
        //   * dropping `createUpdaterArtifacts` — the build would then emit no
        //     signature and every published update would be unverifiable.
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");

        let updater = &conf["plugins"]["updater"];
        let endpoints = updater["endpoints"]
            .as_array()
            .expect("plugins.updater.endpoints");
        assert_eq!(endpoints.len(), 1);
        let endpoint = endpoints[0].as_str().unwrap_or_default();
        assert!(
            endpoint.starts_with("https://code.acme.test/dl/"),
            "{endpoint}"
        );
        assert!(endpoint.contains("{{target}}"), "{endpoint}");

        assert!(!updater["pubkey"].as_str().unwrap_or_default().is_empty());
        assert_eq!(updater["windows"]["installMode"], "passive");
        assert_eq!(conf["bundle"]["createUpdaterArtifacts"], true);
    }

    #[test]
    fn the_three_version_files_agree() {
        // A forgotten bump used to be a silent no-op (NSIS ignores a same-version
        // package). With an updater it is worse: the manifest would advertise a
        // version the installed binary then fails to report, and the client
        // would install it again on every check, forever.
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let pkg: serde_json::Value =
            serde_json::from_str(include_str!("../../package.json")).expect("package.json");
        assert_eq!(conf["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(pkg["version"], env!("CARGO_PKG_VERSION"));
    }
}
