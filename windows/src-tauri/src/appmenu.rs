//! What the page's menu bar may ask of the shell — Windows only.
//!
//! The web draws «Файл · Правка · Вид · Перейти · Справка» in the frameless
//! title bar (`web/src/shell/MenuBar.tsx`). Almost every row is something the
//! page does itself — «Правка» included (`execCommand`, and the clipboard API
//! for «Вставить», under WebView2's own permission). Two are not, and the page
//! has no way to do them from a remote origin:
//!
//! * **Выход** — closing the main window only hides it to the tray
//!   (`close_hides`); quitting was the tray menu's alone.
//! * **Проверить обновления** — the updater's commands are deliberately denied
//!   to the webview (a remote page must never trigger a download-and-install).
//!   The page gets the tray row instead: its label, and «press it». What the
//!   press does is exactly what the tray's press does (`update::on_menu_click`).
//!
//! **Trust.** The caller is a remote page; if the hub were ever compromised,
//! these are its levers. So the two that change the process — quitting, and
//! installing an update (which restarts the app) — are confirmed by the
//! person in a dialog the SHELL draws (`confirm`), which a page can neither
//! draw nor click. Checking for updates needs no confirmation; the row cannot
//! be pressed more than once in ten seconds, and from the page a failed update
//! re-checks instead of opening the browser (security review, 13.10.2026). An earlier draft also pressed Ctrl+V for the page via
//! `SendInput`; it was dropped in review: a page that can trigger a paste into
//! a field of its own reads the clipboard on its own schedule, which is exactly
//! what WebView2's clipboard permission exists to prevent.
//!
//! Granted by `capabilities/app-menu.json` to the hub's origin and to
//! `main`/`window-*` only — never to the sign-in popup or the offline window —
//! and declared in `build.rs` so nothing else of the app's becomes invocable.

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::AppFlags;

/// «Выход»: the tray's own quit, once the person has said yes in the shell's
/// own dialog.
#[tauri::command]
pub async fn shell_quit(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    let yes = confirm(
        &window,
        "Hegai Code",
        "Выйти из Hegai Code?\n\nАгент на этом компьютере продолжит работать — сессии не прервутся.",
    )
    .await;
    if !yes {
        return Err("отменено".into());
    }
    app.state::<AppFlags>().quitting.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

/// The update row as the tray shows it right now, and whether it is pressable.
#[derive(serde::Serialize)]
pub struct UpdateRow {
    label: String,
    enabled: bool,
}

#[tauri::command]
pub fn shell_update_row() -> UpdateRow {
    UpdateRow {
        label: crate::update::menu_label(),
        enabled: crate::update::menu_enabled(),
    }
}

/// Press the update row — check, or install what a check found. At most once
/// in ten seconds: an install restarts the app, and a page in a loop must not
/// be able to restart it at will.
#[tauri::command]
pub async fn shell_update(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    static LAST: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);
    {
        let mut last = LAST.lock().map_err(|_| "занято")?;
        if last.is_some_and(|t| t.elapsed() < Duration::from_secs(10)) {
            return Err("слишком часто".into());
        }
        *last = Some(Instant::now());
    }
    use crate::update::PagePress;
    match crate::update::page_press() {
        PagePress::Busy => Ok(()),
        PagePress::Check => {
            crate::update::page_check(&app);
            Ok(())
        }
        // An install restarts the app: the person says so first, and what is
        // installed is the version the dialog named, or nothing.
        PagePress::Install(version) => {
            let text = format!(
                "Установить Hegai Code {version}?\n\nПриложение закроется на несколько секунд и откроется снова."
            );
            if !confirm(&window, "Обновление Hegai Code", &text).await {
                return Err("отменено".into());
            }
            if crate::update::page_install(&app, &version) {
                Ok(())
            } else {
                Err("обновление изменилось — откройте меню ещё раз".into())
            }
        }
    }
}

/// OK / Cancel in a system message box owned by the calling window. Drawn by
/// the shell, outside the webview: the page cannot render it, script it or
/// press it. Run off the async runtime — the box has its own modal loop.
/// One shell dialog at a time: a page calling in a loop must not stack them.
static PROMPT_OPEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Releases `PROMPT_OPEN` on every way out of `confirm`.
struct PromptGuard;
impl Drop for PromptGuard {
    fn drop(&mut self) {
        PROMPT_OPEN.store(false, Ordering::SeqCst);
    }
}

async fn confirm(window: &tauri::WebviewWindow, title: &str, text: &str) -> bool {
    if PROMPT_OPEN.swap(true, Ordering::SeqCst) {
        return false;
    }
    let _guard = PromptGuard;
    #[cfg(windows)]
    {
        let owner = window.hwnd().map(|h| h.0 as isize).unwrap_or(0);
        let (title, text) = (title.to_string(), text.to_string());
        tauri::async_runtime::spawn_blocking(move || {
            use windows::core::HSTRING;
            use windows::Win32::Foundation::HWND;
            use windows::Win32::UI::WindowsAndMessaging::{
                MessageBoxW, IDOK, MB_DEFBUTTON2, MB_ICONQUESTION, MB_OKCANCEL, MB_SETFOREGROUND,
            };
            // SAFETY: both strings outlive the call; `owner` is our own window
            // handle or null, either of which MessageBoxW accepts.
            let pressed = unsafe {
                MessageBoxW(
                    Some(HWND(owner as *mut core::ffi::c_void)),
                    &HSTRING::from(text),
                    &HSTRING::from(title),
                    // Cancel is the default: Enter held down must not agree.
                    MB_OKCANCEL | MB_ICONQUESTION | MB_DEFBUTTON2 | MB_SETFOREGROUND,
                )
            };
            pressed == IDOK
        })
        .await
        .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        // The capability that grants these commands is Windows-only.
        let _ = (window, title, text);
        false
    }
}
