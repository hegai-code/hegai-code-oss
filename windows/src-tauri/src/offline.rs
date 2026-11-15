//! What the window shows when the hub cannot be reached.
//!
//! The plan called this a hybrid, and the shape of the hybrid matters. The web
//! app refuses a service worker on purpose, and the reason is written down in
//! `web/index.html:19-22`: a cached shell in front of a live WebSocket control
//! plane means an old build talking to a newer hub protocol, and there is no
//! offline story worth having because the app is useless without the socket.
//!
//! That objection applies here too, so the bundled page is NOT a copy of the
//! SPA pretending to work. The main window always loads the remote origin for
//! real work; this is a separate, local window that appears when the hub is
//! unreachable and NEVER opens a socket. A waiting room, not an offline mode.
//!
//! It is a separate WINDOW rather than a navigation of the main one for a
//! reason found the hard way: navigating the main window to a hand-built
//! `tauri://localhost/...` URL sent it through the navigation policy, which saw
//! an unknown scheme, correctly called it external, and handed it to Windows —
//! which asked the user to find an app that opens `tauri` links. Letting Tauri
//! resolve `WebviewUrl::App` for its own window avoids inventing that URL at
//! all, and keeps the main window's page intact underneath.
//!
//! # The waiting room never takes the screen
//!
//! The first version parked on the FIRST failed probe and called `set_focus()`
//! on both sides of the swap. This app spends its life in the tray, so the
//! usual effect was not "the person sees why the app is blank" but "a window
//! nobody asked for jumps in front of a fullscreen game, twice, because the
//! Wi-Fi blinked". Two rules follow, and both are load-bearing:
//!
//! - **One failed probe is not a dead hub.** It is a DNS blip, a VPN route
//!   flapping, a machine waking up, or a link saturated by the game that is
//!   about to lose its focus. `FAILURES_BEFORE_PARK` in a row is a dead hub.
//! - **Parking is a state change, not a screen change.** The waiting room only
//!   ever REPLACES a page somebody is currently reading. With the app in the
//!   tray, behind another window, or minimised, parking is silent; the window
//!   gets built later, when someone actually opens the app (`present`).
//!
//! Nothing here calls `set_focus()` on a timer. Focus is taken only in answer
//! to a person clicking the tray.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use crate::{hub_base, start_url, MAIN_WINDOW};

/// Between probes while the hub is up. Slow on purpose: this is a liveness
/// check, not a heartbeat, and the socket notices trouble faster anyway.
const PROBE_OK: Duration = Duration::from_secs(30);
/// While the hub is down, so the window comes back promptly.
const PROBE_DOWN: Duration = Duration::from_secs(5);
/// Long enough for a redeploy's cold start, short enough that a dead network
/// does not hold the check open.
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
/// Consecutive failed probes before the hub counts as down.
///
/// Three, not one. A single probe fails for reasons that have nothing to do
/// with the hub, and it recovers before anyone could have read the page — the
/// old behaviour was a window that appeared and vanished within seconds, twice
/// stealing the screen on the way. Three failures is at least ~15s of a hub
/// that genuinely is not answering.
const FAILURES_BEFORE_PARK: u32 = 3;

/// The waiting room's window label. Visible to the crate because the
/// close-to-tray rule has to name the windows it does NOT apply to — this one
/// is closed for real by `unpark`.
pub(crate) const OFFLINE_WINDOW: &str = "offline";

/// True while the hub is unreachable, whether or not anything is on screen.
static PARKED: AtomicBool = AtomicBool::new(false);
/// True while the waiting room stands IN PLACE OF the main window.
///
/// Distinct from `PARKED` because parking is usually invisible: the app is in
/// the tray and no window was touched. Only a swap we actually performed is
/// undone on the way back.
static TOOK_OVER: AtomicBool = AtomicBool::new(false);

pub fn spawn(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        watch(app).await;
    });
}

async fn watch(app: tauri::AppHandle) {
    let mut failures = 0u32;
    loop {
        let up = probe().await;
        failures = if up { 0 } else { failures.saturating_add(1) };
        let down = failures >= FAILURES_BEFORE_PARK;

        match (down, up, PARKED.load(Ordering::SeqCst)) {
            (true, _, false) => {
                println!("[offline] hub unreachable after {failures} probes — parking");
                park(&app);
            }
            (_, true, true) => {
                println!("[offline] hub is back — returning to the app");
                unpark(&app);
            }
            _ => {}
        }
        tokio::time::sleep(if up { PROBE_OK } else { PROBE_DOWN }).await;
    }
}

/// Can anything be reached at the hub's host and port?
///
/// A TCP connect, not an HTTP GET: no HTTP client is pulled in for one probe,
/// and the question being asked is only "is anything listening". A hub that
/// answers the port but not the route is a different failure, and the socket
/// in `hub/` reports that one.
async fn probe() -> bool {
    let Some(target) = host_port(&hub_base()) else {
        return false;
    };
    matches!(
        tokio::time::timeout(PROBE_TIMEOUT, tokio::net::TcpStream::connect(target)).await,
        Ok(Ok(_))
    )
}

/// `host:port`, defaulting the port from the scheme.
///
/// `host_str()` already returns an IPv6 literal in its brackets, so this needs
/// no special case — the test below is what says so, because "add the brackets
/// back" is a plausible-looking fix that produces `[[::1]]:4319`.
fn host_port(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let host = parsed.host_str()?;
    let port = parsed.port_or_known_default()?;
    Some(format!("{host}:{port}"))
}

/// Is somebody reading the app's page right now?
///
/// Not "is the window open". This app lives in the tray and its window is
/// usually hidden, minimised, or behind whatever the person is actually doing.
/// Only a window that is visible, restored AND focused means the stale page is
/// in front of someone — the one case where replacing it earns a window
/// appearing on screen.
fn reading_the_app(handle: &tauri::AppHandle) -> bool {
    handle
        .get_webview_window(MAIN_WINDOW)
        .map(|w| {
            w.is_visible().unwrap_or(false)
                && !w.is_minimized().unwrap_or(false)
                && w.is_focused().unwrap_or(false)
        })
        .unwrap_or(false)
}

fn park(app: &tauri::AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        PARKED.store(true, Ordering::SeqCst);
        if !reading_the_app(&handle) {
            // Nobody is looking at a dead page, so there is nothing to replace.
            // The waiting room gets built if and when someone opens the app.
            println!("[offline] parked quietly — nothing on screen to replace");
            return;
        }
        take_over(&handle, true);
    });
}

/// Put the waiting room where the main window was.
///
/// `focus` is true only when a PERSON caused this — they were reading the app
/// as it went down, or they just clicked the tray. A swap that happens on a
/// timer never focuses: a fullscreen game loses focus for good when another
/// window grabs it, and a hub that blinked is not worth that.
fn take_over(handle: &tauri::AppHandle, focus: bool) {
    if let Some(existing) = handle.get_webview_window(OFFLINE_WINDOW) {
        let _ = existing.show();
        if focus {
            let _ = existing.set_focus();
        }
    } else {
        // `WebviewUrl::App` is resolved by Tauri for the current platform.
        // Building that URL by hand is what produced the "which app opens
        // tauri:// links" dialog.
        match WebviewWindowBuilder::new(handle, OFFLINE_WINDOW, WebviewUrl::App("index.html".into()))
            .title("Hegai Code — нет связи")
            .inner_size(560.0, 420.0)
            .resizable(false)
            .center()
            // Built unfocused unless a person asked for it. `.focused(false)`
            // is the only way to put a window on screen without activating it —
            // building it and hoping is what took the screen before.
            .focused(focus)
            // The page must name the host it could not reach, and it lives on
            // its own origin, so it cannot read anything the SPA stored. It is
            // told before its first script runs — `eval` after the fact races
            // the page and loses, which is how it ended up showing the default
            // hostname during a test against a completely different hub.
            .initialization_script(&format!(
                "window.__HEGAI_HUB__ = {};",
                serde_json::to_string(&hub_base()).unwrap_or_else(|_| "null".into())
            ))
            .build()
        {
            Ok(_) => {}
            Err(e) => {
                eprintln!("[offline] could not open the waiting room: {e}");
                return;
            }
        }
    }
    // The main window is left alone underneath, still holding whatever it had.
    // Hiding it rather than navigating it means nothing is lost when the hub
    // comes back.
    if let Some(main) = handle.get_webview_window(MAIN_WINDOW) {
        let _ = main.hide();
    }
    TOOK_OVER.store(true, Ordering::SeqCst);
}

fn unpark(app: &tauri::AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        PARKED.store(false, Ordering::SeqCst);
        let took_over = TOOK_OVER.swap(false, Ordering::SeqCst);
        if let Some(off) = handle.get_webview_window(OFFLINE_WINDOW) {
            let _ = off.close();
        }
        if let Some(main) = handle.get_webview_window(MAIN_WINDOW) {
            // The page under it failed to load while the hub was down, so it
            // needs a fresh navigation, not just a show. This runs whether or
            // not anyone is watching — it is what makes a quiet park invisible
            // in both directions.
            if let Ok(url) = start_url().parse() {
                let _ = main.navigate(url);
            }
            // Give back only a window we took. If parking was quiet the app was
            // in the tray, and recovering from a network blip is not a reason to
            // appear on someone's screen. No `set_focus()` either: by now the
            // person may be three windows away, and a hub reconnecting must not
            // drag them back.
            if took_over {
                let _ = main.show();
            }
        }
    });
}

/// Show the waiting room because a PERSON asked to open the app.
///
/// Returns true when it handled the request, so the caller can stop. Without
/// this, opening the app while the hub is down lands on the main window — the
/// page that died with the connection — which is a blank frame and no
/// explanation. This is the one path allowed to take focus: it is the direct
/// answer to a click.
pub fn present(app: &tauri::AppHandle) -> bool {
    if !PARKED.load(Ordering::SeqCst) {
        return false;
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || take_over(&handle, true));
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_probe_target_is_the_hub_host_and_port() {
        assert_eq!(
            host_port("https://code.acme.test").unwrap(),
            "code.acme.test:443"
        );
        // A dev hub carries an explicit port.
        assert_eq!(host_port("http://localhost:4319").unwrap(), "localhost:4319");
        assert_eq!(host_port("http://127.0.0.1:4319").unwrap(), "127.0.0.1:4319");
    }

    #[test]
    fn an_ipv6_dev_hub_keeps_its_brackets() {
        // `url` keeps the brackets in `host_str()`. Stated as a test because the
        // opposite is easy to assume, and "fixing" it yields `[[::1]]:4319` —
        // a target that resolves to nothing, so a running hub reads as offline
        // and the window parks on the error page.
        assert_eq!(host_port("http://[::1]:4319").unwrap(), "[::1]:4319");
        assert_eq!(
            host_port("https://[2001:db8::1]").unwrap(),
            "[2001:db8::1]:443"
        );
    }

    #[test]
    fn a_broken_url_yields_no_target_rather_than_a_panic() {
        assert!(host_port("not a url").is_none());
        assert!(host_port("").is_none());
    }

    /// The counter `watch` keeps, extracted so the parking rule can be tested
    /// without a network or an event loop.
    fn fold(failures: u32, up: bool) -> u32 {
        if up {
            0
        } else {
            failures.saturating_add(1)
        }
    }

    #[test]
    fn a_blip_never_reaches_the_parking_threshold() {
        // down, down, up — the shape of a DNS hiccup, and the exact sequence
        // that used to open the waiting room and close it seconds later.
        let mut failures = 0u32;
        for up in [false, false, true] {
            failures = fold(failures, up);
            assert!(
                failures < FAILURES_BEFORE_PARK,
                "a blip must not park the window"
            );
        }
        assert_eq!(failures, 0, "one good probe clears the count");
    }

    #[test]
    fn a_hub_that_stays_down_does_park() {
        let mut failures = 0u32;
        for _ in 0..FAILURES_BEFORE_PARK {
            failures = fold(failures, false);
        }
        assert!(failures >= FAILURES_BEFORE_PARK, "a real outage must park");
    }
}
