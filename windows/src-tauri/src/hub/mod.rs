//! The tray's own connection to the hub.
//!
//! The window renders the real SPA and speaks the whole protocol. This second,
//! much smaller connection exists because the SPA's socket cannot be relied on
//! while nobody is looking at it: a hidden or minimised WebView2 is throttled —
//! timers are clamped and the page can be frozen outright — so the count of
//! sessions waiting on an answer would stop updating exactly when the tray is
//! the only thing showing it.
//!
//! Note what this is NOT: closing the window does not destroy the webview. The
//! close is prevented and the window is hidden (`main.rs`, `CloseRequested`),
//! so the SPA and its socket are still there. The reason above is the real one;
//! "the webview is gone" was the original justification here and it was wrong.
//!
//! It authenticates with the SAME credential the window uses. The hub's own
//! comment says why that is legitimate (`server-rs/src/main.rs:511-513`): the
//! bearer token a native client presents IS the workspace session the browser
//! keeps in a cookie, and `authenticated_user` validates both through one
//! `workspaces.authenticate`. So the cookie value is read out of the webview
//! and passed as `?token=` — one sign-in, two consumers, no second login and no
//! change to the hub.

mod notify;
mod wire;

use std::sync::atomic::{AtomicU8, Ordering};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio_tungstenite::tungstenite::Message;

use crate::{hub_base, MAIN_WINDOW, TRAY_ID};
use notify::{Policy, Toast, Watcher};
use wire::Frame;

pub use notify::Policy as NotifyPolicy;

/// The hub's session cookie (`AUTH_COOKIE`, `server-rs/src/main.rs`): always
/// under the `__Host-` prefix on https.
const AUTH_COOKIE: &str = "__Host-cc-remote-auth";
/// The bare name a plain-http dev hub uses (it cannot store `__Host-`). An https
/// hub does not accept it, so it is read only for an `http://` hub.
const BARE_AUTH_COOKIE: &str = "cc-remote-auth";

/// nginx proxies `/mobile/ui` to `/ui` with a rate limit, and that is the door
/// native clients are expected to use (`deploy/nginx-code.acme.test.conf`).
const UI_PATH: &str = "/mobile/ui";

/// Every one of these numbers is copied from `CentralClient.swift`, where each
/// is commented with the symptom it fixes. They are not guesses to re-tune.
const KEEPALIVE: Duration = Duration::from_secs(25);
/// No frame at all for this long means the socket is a corpse holding a handle.
const STALE_AFTER: Duration = Duration::from_secs(40);
const BACKOFF_MAX: Duration = Duration::from_secs(10);
/// How long to wait before looking for the session again when nobody is signed
/// in yet. Not a failure — the app opens before the user logs in.
const SIGNED_OUT_RETRY: Duration = Duration::from_secs(5);

/// How often held news is re-examined.
///
/// A finished run waits out `IDLE_GRACE` before it is announced, and the hub
/// goes quiet when nothing is happening — so without a clock of its own, a run
/// that finished into silence would wait for the next unrelated delta to be
/// announced, which on a calm fleet can be minutes.
const TICK: Duration = Duration::from_secs(2);

pub fn spawn(app: AppHandle) {
    // `HEGAI_TOAST_SELFTEST=1` fires one toast at startup. Unpackaged Win32
    // apps are exactly where Windows toasts fail — they need an AppUserModelID
    // and a Start-menu shortcut, which the installer provides and a raw
    // `cargo run` does not. Being able to answer "do toasts work on THIS
    // machine" without waiting for a real agent question is worth one env var.
    if std::env::var("HEGAI_TOAST_SELFTEST").is_ok_and(|v| v == "1") {
        match app
            .notification()
            .builder()
            .title("Hegai Code")
            .body("Проверка уведомлений — если вы это видите, тосты работают.")
            .show()
        {
            Ok(()) => println!("[hub] selftest toast accepted by the OS"),
            Err(e) => eprintln!("[hub] selftest toast REJECTED: {e}"),
        }
    }
    tauri::async_runtime::spawn(async move {
        supervise(app).await;
    });
}

/// A connection has to last at least this long before it counts as "it worked"
/// and the backoff is allowed to reset.
///
/// Without the check, a socket the hub accepts and closes immediately — a
/// rejected token, a hub in the middle of a redeploy — is a CLEAN close, and a
/// clean close used to reset the backoff and loop with no sleep at all. That is
/// a full TCP+TLS handshake per iteration, as fast as the network allows, which
/// is exactly the reconnect storm `deploy/deploy-hub.sh` warns about at the
/// bottom of the file.
const SETTLED_AFTER: Duration = Duration::from_secs(30);

/// Reconnect forever. The tray is only useful if it is still counting after a
/// laptop lid, a VPN flap or a hub redeploy.
async fn supervise(app: AppHandle) {
    // The very first thing this loop does is read a cookie out of the
    // webview, and on Windows the webview does not exist yet when the app
    // starts — asking early aborts the process rather than failing. See
    // WEBVIEW_READY in main.rs.
    crate::await_webview().await;
    let mut backoff = Duration::from_secs(1);
    // One watcher for the life of the app, not one per socket: a reconnect is
    // exactly when the hub re-sends every prompt already waiting, and only a
    // watcher that remembers them can tell those from new ones.
    let mut watcher = Watcher::new();
    loop {
        let Some(token) = session_token(&app) else {
            // Signed out is a normal state, not an error: no backoff growth.
            tokio::time::sleep(SIGNED_OUT_RETRY).await;
            continue;
        };
        let started = tokio::time::Instant::now();
        watcher.reconnected();
        let outcome = session(&app, &token, &mut watcher).await;
        // Whether the socket was USEFUL, not whether it closed politely, is what
        // decides the next delay.
        if started.elapsed() >= SETTLED_AFTER {
            backoff = Duration::from_secs(1);
        }
        match outcome {
            Ok(()) => println!("[hub] disconnected cleanly"),
            Err(e) => eprintln!("[hub] {e}"),
        }
        println!("[hub] reconnecting in {}s", backoff.as_secs());
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

/// Read the hub session out of the window's cookie jar.
///
/// Returns None while the user is signed out, which is why the caller treats
/// that as "wait", not "fail".
pub(crate) fn session_token(app: &AppHandle) -> Option<String> {
    let window = app.get_webview_window(MAIN_WINDOW)?;
    let url = hub_base().parse().ok()?;
    let cookies = window.cookies_for_url(url).ok()?;
    // `__Host-` first; the bare name only for a plain-http (dev) hub, as the hub does.
    let plain_http = hub_base().starts_with("http://");
    [AUTH_COOKIE, BARE_AUTH_COOKIE].into_iter().filter(|n| plain_http || *n == AUTH_COOKIE).find_map(|name| {
        cookies
            .iter()
            .find(|c| c.name() == name)
            .map(|c| c.value().to_string())
            .filter(|v| !v.is_empty())
    })
}

fn ws_url(token: &str) -> String {
    let base = hub_base();
    let ws = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        base
    };
    // The token is a live session; it must never reach a log line.
    format!("{ws}{UI_PATH}?token={}", urlencode(token))
}

/// Percent-encode the few characters that would break a query value. The token
/// is hex in practice, but "in practice" is not a guarantee worth a broken
/// socket.
fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// A connect that never answers is the failure mode with no error to catch:
/// DNS, TCP or TLS can all black-hole, and `connect_async` would then sit inside
/// one attempt forever — the supervisor's backoff never even starts. The agent
/// hit this exact thing and fixed it the same way (`handshakeTimeout` in
/// `agent/src/client.ts`).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

async fn session(app: &AppHandle, token: &str, watcher: &mut Watcher) -> Result<(), String> {
    let (mut ws, _) = tokio::time::timeout(
        CONNECT_TIMEOUT,
        tokio_tungstenite::connect_async(ws_url(token)),
    )
    .await
    .map_err(|_| format!("connect timed out after {}s", CONNECT_TIMEOUT.as_secs()))?
    .map_err(|e| format!("connect failed: {e}"))?;
    println!("[hub] connected");

    // Identify as an app so the hub tags runs `origin=app` and the board can
    // split App from Web (`web-protocol.ts:297-300`).
    ws.send(Message::Text(r#"{"type":"hello","client":"app"}"#.into()))
        .await
        .map_err(|e| format!("hello failed: {e}"))?;

    let mut keepalive = tokio::time::interval(KEEPALIVE);
    keepalive.tick().await; // the first tick is immediate
    let mut ripen = tokio::time::interval(TICK);
    ripen.tick().await;

    // The staleness deadline has to OUTLIVE the loop iteration.
    //
    // It used to be `timeout(STALE_AFTER, ws.next())` built inside the select!.
    // Every keepalive tick won the race, dropped that future, and the next
    // iteration started a fresh 40s timer — and since the keepalive fires every
    // 25s, the 40s deadline was never once reached. The check the constant
    // exists for could not fire at all.
    //
    // The case it is for: a half-open socket. Writes still land in the OS buffer
    // so the keepalive keeps "succeeding", while nothing is ever read back — a
    // VPN flap or a closed lid leaves exactly that. The tray would freeze on its
    // last count and never reconnect.
    let stale = tokio::time::sleep(STALE_AFTER);
    tokio::pin!(stale);
    let mut was_attended = attended(app);

    loop {
        tokio::select! {
            _ = keepalive.tick() => {
                if ws.send(Message::Text(r#"{"type":"ping"}"#.into())).await.is_err() {
                    return Err("keepalive failed".into());
                }
            }
            _ = ripen.tick() => {
                // Deliberately does NOT reset the staleness deadline: this is
                // our own clock, not evidence the socket is alive.
                let looking = attended(app);
                if looking && !was_attended {
                    // The person came back to the app, where every one of
                    // those toasts is answered on screen. Left in the Action
                    // Center they are a stack of stale links that, clicked an
                    // hour later, pull a long-settled session into the window.
                    clear_toasts(app);
                }
                was_attended = looking;
                for toast in watcher.tick(looking, policy(), Instant::now()) {
                    show(app, &toast);
                }
            }
            _ = &mut stale => {
                return Err(format!("no frame for {}s; socket is stale", STALE_AFTER.as_secs()));
            }
            frame = ws.next() => {
                // Only a frame that actually ARRIVED pushes the deadline out.
                stale.as_mut().reset(tokio::time::Instant::now() + STALE_AFTER);
                match frame {
                    None => return Ok(()),
                    Some(Err(e)) => return Err(format!("read failed: {e}")),
                    Some(Ok(Message::Text(text))) => handle(app, watcher, &text),
                    Some(Ok(Message::Close(_))) => return Ok(()),
                    Some(Ok(_)) => {}
                }
            }
        }
    }
}

fn handle(app: &AppHandle, watcher: &mut Watcher, text: &str) {
    let frame: Frame = match serde_json::from_str(text) {
        Ok(f) => f,
        // A frame we cannot parse is not a reason to drop the connection: the
        // hub grows message types faster than this client does.
        Err(_) => return,
    };
    let runs = match &frame {
        Frame::Snapshot { viewer, active_runs } => {
            // Who is looking rides the snapshot and nothing else, so it is read
            // BEFORE the runs are folded in: the hub re-sends a snapshot on
            // every inventory change, and judging its runs against a stale
            // identity is precisely the mix-up this scoping exists to stop.
            if let Some(v) = viewer {
                watcher.set_viewer(&v.user_id);
            }
            active_runs
        }
        Frame::Activity { runs } => runs,
        Frame::Other => return,
    };
    for toast in watcher.ingest(runs, attended(app), policy(), Instant::now()) {
        show(app, &toast);
    }
    set_badge(app, watcher.waiting());
}

/// Is anyone actually looking at this app right now?
///
/// This connection cannot know WHICH session the window shows — it is a second
/// socket, and the window's own state never crosses to it. It can know whether
/// the window is in front of the person, and that answers the complaint that
/// mattered: a toast about the session already on screen. An app in the
/// foreground reports attention itself, in the rail and on the board.
///
/// Minimised counts as not attended even though Windows may still report the
/// window as visible — the two questions are different and only one of them is
/// "can this person see it".
fn attended(app: &AppHandle) -> bool {
    app.get_webview_window(MAIN_WINDOW).is_some_and(|w| {
        w.is_visible().unwrap_or(false)
            && w.is_focused().unwrap_or(false)
            && !w.is_minimized().unwrap_or(false)
    })
}

/// How much this person wants to be interrupted.
///
/// An atomic rather than state threaded through the socket loop: the tray menu
/// changes it from the UI thread while the loop is parked on `select!`, and the
/// loop must see the new value on its very next frame — «выключить уведомления»
/// that takes effect after the next reconnect is not an off switch.
static POLICY: AtomicU8 = AtomicU8::new(0);

fn policy() -> Policy {
    match POLICY.load(Ordering::Relaxed) {
        1 => Policy::Blocking,
        2 => Policy::Off,
        _ => Policy::All,
    }
}

fn policy_code(p: Policy) -> u8 {
    match p {
        Policy::All => 0,
        Policy::Blocking => 1,
        Policy::Off => 2,
    }
}

/// Where the choice is remembered between launches.
///
/// A mute that forgets itself on restart is not a mute. Kept as one word in a
/// file rather than through a store plugin: it is a single enum, and a
/// dependency to hold one word is a dependency to keep current forever.
fn policy_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager as _;
    let dir = app.path().app_config_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("notify-policy"))
}

pub fn load_policy(app: &AppHandle) {
    let word = policy_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default();
    let p = match word.trim() {
        "blocking" => Policy::Blocking,
        "off" => Policy::Off,
        _ => Policy::All,
    };
    POLICY.store(policy_code(p), Ordering::Relaxed);
}

pub fn set_policy(app: &AppHandle, p: Policy) {
    POLICY.store(policy_code(p), Ordering::Relaxed);
    let word = match p {
        Policy::All => "all",
        Policy::Blocking => "blocking",
        Policy::Off => "off",
    };
    if let Some(path) = policy_path(app) {
        let _ = std::fs::write(path, word);
    }
    println!("[hub] notifications: {word}");
}

/// The current setting, for the tray menu's check marks.
pub fn current_policy() -> Policy {
    policy()
}

fn show(app: &AppHandle, toast: &Toast) {
    #[cfg(windows)]
    let target = toast.target().map(|(m, s)| (m.to_string(), s.to_string()));
    #[cfg(not(windows))]
    let target = None;
    emit(app, &toast.title(), &toast.body(), target);
}

/// Put a notification on screen, by whichever backend this platform has.
///
/// Split out of `show` so it can be reached by something that is not a run:
/// `update.rs` announces a new build through it and gets the clickable Windows
/// path for free. `target` names the session to open on click — `None` means
/// "just raise the app", which is the only thing an update notification can
/// sensibly do.
pub(crate) fn emit(
    app: &AppHandle,
    title: &str,
    body: &str,
    #[cfg_attr(not(windows), allow(unused_variables))] target: Option<(String, String)>,
) {
    #[cfg(windows)]
    {
        match win_toast(app, title, body, target) {
            Ok(()) => return,
            Err(e) => {
                // The fallback is the plugin, which cannot carry a click but had
                // been the only path here until the WinRT one existed: losing
                // the gesture is a far smaller regression than losing the
                // notification.
                eprintln!("[hub] click-capable toast failed ({e}); falling back");
            }
        }
    }
    // Everywhere else the plugin IS the path, and asking for a click-capable
    // toast first would print a failure on every single notification.
    //
    // What that costs on macOS, stated plainly so it is not discovered later:
    // the plugin hands the notification to the OS and drops the handle
    // (`tauri-plugin-notification`, desktop.rs), so a click does whatever macOS
    // does by default and cannot open the session the toast is about — and the
    // Allow/Deny buttons the native Mac app put ON the banner are not here
    // either. Both are answered in the window instead. Closing that gap means a
    // notification backend that reports activation (`mac-notification-sys`
    // directly, or notify-rust's `preview-macos-un`), which is a change of
    // dependency, not a change of policy.
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        eprintln!("[hub] toast failed: {e}");
    }
}

/// A toast that can be CLICKED.
///
/// The gap this closes was the whole reason notifications here felt like noise:
/// neither this tray's toast nor the SPA's `new Notification` had a click
/// handler, so the one gesture a notification invites did nothing at all, and a
/// notification that leads nowhere trains a person to dismiss it.
///
/// `tauri-plugin-notification` has no way to attach one — its desktop builder
/// takes a title, a body and an icon, then calls `show()`. So the toast is
/// built directly on the same WinRT crate the plugin uses underneath, with the
/// same app id (the identifier the installer registers as the AppUserModelID —
/// Windows refuses a toast from an app id it does not know, which is why an
/// unpackaged `cargo run` cannot show one at all).
#[cfg(windows)]
fn win_toast(
    app: &AppHandle,
    title: &str,
    body: &str,
    target: Option<(String, String)>,
) -> Result<(), String> {
    let handle = app.clone();
    tauri_winrt_notification::Toast::new(&app.config().identifier)
        .title(title)
        .text1(body)
        .on_activated(move |_action| {
            // Runs on a WinRT callback thread, so every Tauri call here has to
            // be one that is safe off the main thread; `run_on_main_thread`
            // moves the window work where it belongs.
            let app = handle.clone();
            let target = target.clone();
            let _ = handle.run_on_main_thread(move || match &target {
                Some((machine_id, session_id)) => open_session(&app, machine_id, session_id),
                None => crate::open_app(&app),
            });
            Ok(())
        })
        .show()
        .map_err(|e| e.to_string())
}

/// Raise the window ON the session the toast was about.
///
/// Through the SPA's own router, not a page load. This used to be
/// `w.navigate(url)`: a full reload onto `/w/s/…`, which threw away whatever
/// was on screen — the split («Колонки») collapsed to one session, a
/// half-typed message went with it — every time a toast was clicked, and
/// clicking a toast is also how people dismiss one. The SPA's `navigate`
/// already knows what a session chosen from outside the panes means: the pane
/// that holds it takes focus, or it opens in the focused pane
/// (`intoPane`, `web/src/router.ts`). The page publishes that as
/// `__HEGAI_OPEN_SESSION__` inside the shell; a page without it (an older web
/// build, the offline screen, a sign-in page) still gets the full navigation.
///
/// Reached from the WinRT toast's activation handler, which is why it carries
/// that path's cfg: no other backend here reports a click.
#[cfg(windows)]
fn open_session(app: &AppHandle, machine_id: &str, session_id: &str) {
    let url = session_url(machine_id, session_id);
    crate::open_app(app);
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        if let Err(e) = w.eval(&open_session_js(machine_id, session_id, &url)) {
            eprintln!("[hub] could not open the session: {e}");
        }
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn session_url(machine_id: &str, session_id: &str) -> String {
    format!(
        "{}/w/s/{}/{}",
        hub_base(),
        urlencode(machine_id),
        urlencode(session_id)
    )
}

/// The script a toast click runs in the page. Every value goes in as a JSON
/// string literal — ids come off the wire, and a quote in one must not become
/// code.
#[cfg_attr(not(windows), allow(dead_code))]
fn open_session_js(machine_id: &str, session_id: &str, url: &str) -> String {
    let q = |v: &str| serde_json::to_string(v).unwrap_or_else(|_| "\"\"".into());
    format!(
        "(function(m,s,u){{var o=window.__HEGAI_OPEN_SESSION__;\
         if(typeof o==='function'){{try{{o(m,s);return;}}catch(e){{}}}}\
         location.assign(u);}})({},{},{});",
        q(machine_id),
        q(session_id),
        q(url)
    )
}

/// Take this app's toasts out of the Action Center.
///
/// Called when the window comes back in front of the person. Nothing else is
/// possible through `tauri-winrt-notification`, which sets no tag or group, so
/// a single toast cannot be withdrawn — but "all of them, once you are looking
/// at the app that shows the same thing" is the rule the phone follows too.
#[cfg(windows)]
fn clear_toasts(app: &AppHandle) {
    use windows::core::HSTRING;
    use windows::UI::Notifications::ToastNotificationManager;
    let id = HSTRING::from(app.config().identifier.as_str());
    if let Err(e) = ToastNotificationManager::History().and_then(|h| h.ClearWithId(&id)) {
        eprintln!("[hub] could not clear old toasts: {e}");
    }
}

#[cfg(not(windows))]
fn clear_toasts(_app: &AppHandle) {}

/// Last count published, so the log records changes rather than every frame —
/// the hub re-sends the full run list on every delta.
static LAST_BADGE: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(usize::MAX);

/// The tray's tooltip is the badge. Windows tray icons have no numeric overlay,
/// so the count goes where it can actually be read.
///
/// macOS has two places that read better than a tooltip nobody hovers, and both
/// are used: TEXT beside the menu bar icon, and the dock badge. The tooltip is
/// still set — it costs nothing and is the only readout on Windows.
fn set_badge(app: &AppHandle, waiting: usize) {
    if LAST_BADGE.swap(waiting, std::sync::atomic::Ordering::Relaxed) != waiting {
        println!("[hub] waiting: {waiting}");
    }
    let tooltip = match waiting {
        0 => "Hegai Code".to_string(),
        n => format!("Hegai Code — {n} ждут ответа"),
    };
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(&tooltip));
        // Zero is an ABSENCE, not a "0": a menu bar carrying a permanent zero
        // is a worse readout than one that only speaks when it has something
        // to say.
        #[cfg(target_os = "macos")]
        {
            let _ = match waiting {
                0 => tray.set_title(None::<String>),
                n => tray.set_title(Some(n.to_string())),
            };
        }
    }
    #[cfg(target_os = "macos")]
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let _ = match waiting {
            0 => w.set_badge_label(None),
            n => w.set_badge_label(Some(n.to_string())),
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_socket_url_is_the_mobile_door() {
        let url = ws_url("abc123");
        assert!(url.starts_with("wss://code.acme.test/mobile/ui?token="), "{url}");
    }

    #[test]
    fn a_toast_click_routes_inside_the_page_and_cannot_be_injected() {
        let url = session_url("m1", "s1");
        assert_eq!(url, "https://code.acme.test/w/s/m1/s1");
        let js = open_session_js("m1", "s1", &url);
        assert!(js.contains("__HEGAI_OPEN_SESSION__"), "{js}");
        assert!(js.contains("location.assign(u)"), "the full navigation is the fallback");
        assert!(js.ends_with(r#"})("m1","s1","https://code.acme.test/w/s/m1/s1");"#), "{js}");
        let hostile = open_session_js("m\");alert(1);//", "s", "u");
        assert!(hostile.contains(r#""m\");alert(1);//""#), "{hostile}");
    }

    #[test]
    fn a_token_with_awkward_characters_survives_the_query() {
        assert_eq!(urlencode("abc123"), "abc123");
        assert_eq!(urlencode("a b&c=d"), "a%20b%26c%3Dd");
        assert_eq!(urlencode("tok+en/slash"), "tok%2Ben%2Fslash");
    }
}
