// No console window behind the app in release. In debug we keep it: the hub
// client and the agent supervisor print there, and losing that output is worse
// than a stray console while developing.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Every `println!`/`eprintln!` in this crate ALSO goes to `shell.log`.
///
/// Textual-scope `macro_rules!` shadow std's prelude macros for everything
/// below them — which is why these sit above the `mod` lines. The first try
/// pointed the process's stdout at a pipe instead (`SetStdHandle`), and on
/// buildbox-pc it worked for a copy started from PowerShell and not for the
/// copy the installer started: that one logged its banner and not one
/// `println!`. A log that depends on how the app was launched is not a log.
macro_rules! println {
    ($($arg:tt)*) => {{
        let line = format!($($arg)*);
        $crate::shelllog::line(&line);
        ::std::println!("{}", line);
    }};
}
macro_rules! eprintln {
    ($($arg:tt)*) => {{
        let line = format!($($arg)*);
        $crate::shelllog::line(&line);
        ::std::eprintln!("{}", line);
    }};
}

/// The agent supervisor is Windows-only in substance, not just in spelling: it
/// exists because Windows was the one fleet OS whose daemon had no
/// restart-on-failure. macOS has launchd `KeepAlive` (`deploy/install-mac.sh`)
/// and Linux has systemd `Restart=always`, so on those platforms this module
/// would be a second supervisor racing the real one.
///
/// The cfg also carries the module's Windows-only calls — `CommandExt` and
/// `.creation_flags()` (`agent/config.rs`) — which are what stopped this crate
/// compiling anywhere else.
#[cfg(windows)]
mod agent;
mod appmenu;
mod enroll;
mod hub;
mod hubconf;
mod offline;
mod shelllog;
mod update;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;
use url::Url;

/// The default hub. The configured hub (`hub_base`) is the only origin whose
/// pages are the app: overridable by env for a dev hub, and by the `hub-url`
/// file for a customer's own hub (tray «Сервер…», or the installer).
const DEFAULT_HUB: &str = "https://code.acme.test";
/// Where the window opens. `/w/` is the SPA's prefix — the hub owns the bare
/// paths (`/api`, `/ui`, `/install`), so a GET on those never reaches the app.
const START_PATH: &str = "/w/sessions";
const MAIN_WINDOW: &str = "main";
/// The window title. Invisible on both platforms now (macOS hides it, Windows
/// has no bar to draw it in), but it is still what the taskbar, the window
/// switcher and the dock label read.
const APP_TITLE: &str = "Hegai Code";
/// The tray lives as long as the app does; the hub client updates its tooltip.
const TRAY_ID: &str = "main";
/// Prefix the selftest puts on `document.title` to smuggle a result to stdout.
const SELFTEST_MARK: &str = "HEGAI-SELFTEST";
/// Start into the tray with no window: the launch was a machine's, not a
/// person's.
///
/// Орлов (`hegaivoice`, `electron/features/settings/supervisor.ts`) starts this
/// app at logon for one reason — the agent needs a supervisor, and Windows is
/// the only platform whose daemon had none. Nobody asked for a window then, and
/// one arriving on top of whatever the machine was already doing is the same
/// complaint the waiting room earned.
///
/// A person launching the app — the Start menu, the installer's last step, a
/// second double-click — passes no flag and gets a window, as they should.
const BACKGROUND_FLAG: &str = "--background";

/// Was this process started by a supervisor rather than by a person?
fn started_in_background() -> bool {
    is_background_launch(std::env::args().skip(1))
}

/// The rule itself, apart from the process, so it can be tested.
fn is_background_launch<I: IntoIterator<Item = String>>(args: I) -> bool {
    args.into_iter().any(|a| a == BACKGROUND_FLAG)
}

/// Set once the main window's webview exists and can answer questions.
///
/// This is not the same as "the app started". On Windows the WebView2
/// controller is created asynchronously, so it is still absent in `setup` AND
/// in `RunEvent::Ready` — the event loop is running, the window is on screen,
/// and the webview behind it is not there yet. Asking it for cookies in that
/// gap is fatal, not merely early: `cookies_for_url` waits on a channel whose
/// sender Tauri drops, and Tauri's own `rx.recv().unwrap()`
/// (tauri-runtime-wry `lib.rs:1796`) turns that into a panic — an abort, in the
/// release profile.
///
/// A navigation STARTING is the earliest honest proof the webview exists, and
/// unlike a finished load it still arrives when the hub is down.
static WEBVIEW_READY: AtomicBool = AtomicBool::new(false);

/// Wait for the webview to exist. Callers are background tasks, so this is a
/// poll rather than a signal; the wait happens once per process.
pub async fn await_webview() {
    while !WEBVIEW_READY.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// The company's apex domain. `acme.test` itself and any subdomain of it may
/// render INSIDE the app window; everything else is a link out.
///
/// This is a domain rule rather than a list of hosts because sign-in is a
/// CHAIN, and enumerating it was already wrong once. The hub's configured
/// provider is `admin.acme.test` (`server-rs/src/main.rs:265-266`), so that is
/// what a reading of the config yields — but `admin` only issues another
/// redirect, and the actual login form lives on the apex:
///
///   code.acme.test/api/auth/sso/start
///     -> admin.acme.test/api/community/auth/sso/authorize
///     -> acme.test/login?sso=1&next=...
///
/// With `acme.test` missing, the window refused the last hop and pushed the
/// login form into the system browser, which reads exactly like "login is
/// broken". A rule that covers the domain survives the next hop being added.
///
/// The legacy hub name `claude.acme.test` is covered by the same rule; nginx
/// 301s it to `code.acme.test`, and that redirect must land in-window.
///
/// Sibling subdomains cannot read the hub's session cookie — it is set on
/// `code.acme.test` with no `Domain` attribute, so it is host-only.
const APP_DOMAIN: &str = "acme.test";

/// One host spelling for every comparison. `url` already lowercases the host,
/// but the trailing root dot survives, and `code.acme.test.` is the same host
/// as `code.acme.test` — normalizing in only one of two comparisons is how the
/// hub check and the domain check disagreed.
fn norm_host(host: &str) -> String {
    host.trim_end_matches('.').to_ascii_lowercase()
}

fn is_company_host(host: &str) -> bool {
    // The leading dot is what makes this a domain check and not a substring
    // one: it rejects `evil-acme.test`, and `acme.test.evil.test` fails on the
    // suffix anyway.
    let host = norm_host(host);
    host == APP_DOMAIN || host.ends_with(&format!(".{APP_DOMAIN}"))
}

/// Telegram's deep-link hosts. A `t.me/<bot>?start=…` link is meant for the
/// Telegram app, and the only thing that can hand it there is the system
/// browser: rendered inside this window it is a web page whose «Open in
/// Telegram» button is a `tg:` link — which `decide` blocks, rightly.
/// `oauth.telegram.org` is NOT here: that is the login WIDGET the platform's
/// sign-in hosts as a popup talking to its opener (see `popup_plan`).
const TELEGRAM_LINK_HOSTS: &[&str] = &["t.me", "telegram.me"];

fn is_telegram_link(target: &Url) -> bool {
    target.host_str().is_some_and(|h| {
        let h = norm_host(h);
        TELEGRAM_LINK_HOSTS
            .iter()
            .any(|t| h == *t || h.ends_with(&format!(".{t}")))
    })
}

/// How long a sign-in excursion may stay open. Long enough for a password
/// manager, a 2FA prompt and an account chooser; short enough that a flow the
/// user abandoned does not leave the window permissive for the rest of the day.
const AUTH_WINDOW: Duration = Duration::from_secs(10 * 60);

/// The hub path that starts a sign-in. Everything under it is still the flow:
/// `/api/auth/sso/start` opens the excursion and `/api/auth/sso/callback` is the
/// provider handing control back.
///
/// Only the FIRST of these arms the clock. Re-arming on every auth hop meant
/// `AUTH_WINDOW` bounded the last hop rather than the excursion, so a callback
/// that errors and never redirects — or any flow that keeps touching this
/// prefix — left the window permissive for a fresh ten minutes each time. The
/// excursion still ends the moment a normal hub path is reached (`Nav::Enter`).
const AUTH_PATH_PREFIX: &str = "/api/auth/";

/// Sign-in is a bounded EXCURSION, not a list of addresses.
///
/// The first version enumerated provider hosts, and that shape cannot work.
/// Google's consent is followed by a cookie-sync fan-out across country and
/// YouTube domains, observed live as:
///
///   accounts.google.com/o/oauth2/v2/auth   -> consent
///   accounts.google.com/CheckCookie
///   accounts.youtube.com/accounts/SetSID
///   accounts.google.ru/accounts/SetSID     <- and there are dozens more ccTLDs
///
/// An allowlist loses that race by construction. So the rule is temporal: once
/// the window navigates to the hub's own `/api/auth/…`, a sign-in is in flight
/// and the excursion may go wherever the provider sends it, until it lands back
/// on the hub — or until `AUTH_WINDOW` runs out.
///
/// Outside that window the strict rule still holds, which is the case that
/// matters: a transcript is full of links to strangers' sites, and clicking one
/// must not repaint a window that has no address bar and holds a live session.
struct AuthFlow {
    started: Mutex<Option<Instant>>,
    /// One return trip per excursion. If the hub sends us straight back out to
    /// sign in again, bouncing a second time would be a loop between the app
    /// and the platform with no way for the user to stop it.
    bounced: AtomicBool,
}

impl AuthFlow {
    fn new() -> Self {
        Self {
            started: Mutex::new(None),
            bounced: AtomicBool::new(false),
        }
    }
    fn begin(&self) {
        if let Ok(mut g) = self.started.lock() {
            *g = Some(Instant::now());
        }
        self.bounced.store(false, Ordering::SeqCst);
    }
    fn end(&self) {
        if let Ok(mut g) = self.started.lock() {
            *g = None;
        }
        self.bounced.store(false, Ordering::SeqCst);
    }
    /// Also expires a stale excursion, so the permissive state cannot outlive
    /// an abandoned login.
    fn active(&self) -> bool {
        let Ok(mut g) = self.started.lock() else {
            return false;
        };
        match *g {
            Some(started) if started.elapsed() < AUTH_WINDOW => true,
            Some(_) => {
                *g = None;
                false
            }
            None => false,
        }
    }
    /// True exactly once per excursion.
    fn claim_bounce(&self) -> bool {
        !self.bounced.swap(true, Ordering::SeqCst)
    }
}

/// Paths on the platform that are genuinely part of signing in. Anything else
/// there is the platform's own site, which this window is not for.
const PLATFORM_AUTH_PATHS: &[&str] = &["/login", "/api/", "/oauth", "/auth"];

/// Former names of the hub. nginx answers them and 301s browsers to
/// `code.acme.test` (`deploy/nginx-code.acme.test.conf`), so they are the app
/// arriving by an old link, not the platform — the redirect has to land in the
/// window rather than open a browser.
const LEGACY_HUB_HOSTS: &[&str] = &["claude.acme.test"];

/// What the window should do with a navigation.
#[derive(Debug, PartialEq, Eq)]
enum Nav {
    /// Render it, and treat sign-in as finished.
    Enter,
    /// Render it; a sign-in is starting or still running.
    Signin,
    /// Render it without changing sign-in state.
    Allow,
    /// Sign-in finished but dropped us on the platform instead of the hub.
    /// Refuse it and send the window home.
    BackToApp,
    /// Hand it to the system browser and refuse it here.
    External,
    /// Refuse it and hand it to NOBODY. The distinction from `External` is the
    /// point: `External` trusts the OS to open the thing, which is wrong for a
    /// scheme a web page chose (`file:`, `javascript:`, a registered handler).
    Blocked,
}

/// The whole navigation policy, as a pure function so it can be tested against
/// a real captured sign-in chain rather than reasoned about.
fn decide(raw: &str, signing_in: bool) -> Nav {
    let Ok(target) = Url::parse(raw) else {
        return Nav::Blocked;
    };
    // The webview's own about: hops (about:blank when a window is created).
    //
    // `data:` used to be waved through with them, unconditionally. It is not a
    // hop — it is arbitrary attacker-authored HTML rendered inside a chromeless
    // window that holds a live session, reachable from any transcript link. The
    // webview's own about:blank does not need it.
    if target.scheme() == "about" {
        return Nav::Allow;
    }
    // Nothing below this line is reachable by a scheme the web does not use.
    // `file:`, `javascript:`, `ms-msdt:` and every other registered handler used
    // to fall through to `External`, which means this app HANDED THEM TO
    // WINDOWS — `file:///C:/Windows/System32/cmd.exe` included, and a test
    // pinned that as correct. A page cannot be trusted to name the program the
    // OS should open.
    if !matches!(target.scheme(), "http" | "https" | "mailto") {
        return Nav::Blocked;
    }
    if is_hub_url(&target) {
        // The hub is the app. Its auth paths are the excursion's two ends.
        return if target.path().starts_with(AUTH_PATH_PREFIX) {
            // Already inside one: this is a continuation, not a new start, so
            // it must not restart the clock. See AUTH_PATH_PREFIX.
            if signing_in {
                Nav::Allow
            } else {
                Nav::Signin
            }
        } else {
            Nav::Enter
        };
    }
    if target.scheme() == "https"
        && target
            .host_str()
            .is_some_and(|h| LEGACY_HUB_HOSTS.contains(&norm_host(h).as_str()))
    {
        // An old name for this same app. Let the 301 through.
        return Nav::Allow;
    }
    if target.scheme() == "https" && target.host_str().is_some_and(is_company_host) {
        // Company-owned, but not the hub: the HegAI platform. Its login page
        // and auth APIs are part of the flow.
        let path = target.path();
        if PLATFORM_AUTH_PATHS.iter().any(|p| path.starts_with(p)) {
            return Nav::Allow;
        }
        // Anything else there is the platform's own site. Reaching it means the
        // login finished and the SSO `next` was dropped on the way back — the
        // observed dead end was `acme.test/api/community/auth/google/callback`
        // followed by `acme.test/`, leaving the user parked on the community
        // homepage inside a window that says "Hegai Code".
        //
        // This app is not a browser for the platform. Go home: the hub re-runs
        // SSO, and the platform session that was just established makes the
        // second pass silent.
        return if signing_in { Nav::BackToApp } else { Nav::External };
    }
    // «Войти через Telegram» (ours, and the platform's own button during a
    // HegAI sign-in) opens a bot link. It goes to the Telegram app through the
    // system browser EVEN mid-sign-in: the excursion below would otherwise
    // render it in-window, where it dead-ends on a blocked `tg:` link.
    if is_telegram_link(&target) {
        return Nav::External;
    }
    if signing_in && target.scheme() == "https" {
        // Wherever the provider goes. Bounded by AUTH_WINDOW, by landing back
        // on the hub — and by `https`: the excursion used to accept ANY scheme,
        // so for ten minutes a `file:` or `data:` URL was renderable in-window.
        // The one legitimate plaintext origin, a dev hub on loopback, is already
        // matched by `is_hub_url` above.
        return Nav::Allow;
    }
    Nav::External
}

/// Is this the configured hub? Scheme, host and port all have to agree — see
/// the note in `is_company_host` about why the scheme is not optional.
fn is_hub_url(target: &Url) -> bool {
    let Ok(base) = Url::parse(&hub_base()) else {
        return false;
    };
    base.scheme() == target.scheme()
        && base.host_str().is_some()
        && base.host_str().map(norm_host) == target.host_str().map(norm_host)
        && base.port_or_known_default() == target.port_or_known_default()
}

struct AppFlags {
    /// Distinguishes "user closed the window" (hide to tray) from "user chose
    /// Quit" (actually exit). Without it, close-to-tray makes the app
    /// unquittable from the window.
    quitting: AtomicBool,
}

/// env `CC_HEGAI_URL` → the `hub-url` file (loaded once in `setup`) → the
/// default. See `hubconf`.
pub fn hub_base() -> String {
    hubconf::resolve_hub(
        std::env::var("CC_HEGAI_URL").ok().as_deref(),
        hubconf::file_hub().as_deref(),
    )
}

/// Where the app opens: the list, asking the page to put back the screen it
/// showed last time (`RESTORE_FLAG` in web/src/router.ts) — «если перезагружаешь
/// приложение — открывай последние открытые вкладки» (10.10.2026). A page from
/// before the flag ignores the query and shows the list, as it always did.
pub fn start_url() -> String {
    format!("{}{START_PATH}?restore=1", hub_base())
}

fn show_main(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// What "open the app" means, from the tray or from a second launch.
///
/// While the hub is unreachable the main window holds the page that died with
/// the connection — a blank frame with nothing to say. `offline::present`
/// answers with the waiting room instead and reports that it did.
///
/// This is also the ONLY place a window may take focus. The offline watcher
/// swaps windows on a timer and deliberately does not; opening the app is a
/// person's gesture, and a gesture is allowed an answer.
pub(crate) fn open_app(app: &tauri::AppHandle) {
    if offline::present(app) {
        return;
    }
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        show_main(&w);
    }
}

fn build_main_window(
    app: &tauri::AppHandle,
    auth: Arc<AuthFlow>,
    visible: bool,
) -> tauri::Result<WebviewWindow> {
    let url = Url::parse(&start_url()).expect("hub URL must parse");
    // Owned by the closures, which outlive this function.
    let nav_handle = app.clone();
    let nav_auth = auth.clone();
    let popup_handle = app.clone();
    shell_window(WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::External(url)))
        .title(APP_TITLE)
        .inner_size(1280.0, 860.0)
        // Tell the page it is inside this shell.
        //
        // The SPA notifies on its own — `new Notification` whenever the
        // document is hidden — and in here that is one machine with two
        // notifiers for the same event, from two separate sockets. The tray's
        // is the one to keep: it survives the window being hidden, which is
        // exactly when WebView2 freezes the page and the SPA's stops. The
        // marker also lets the page HUSH its socket when hidden instead of
        // letting the hub queue frames at a window nobody is draining.
        //
        // Runs before any page script on every navigation, so a reload or a
        // sign-in round trip cannot lose it.
        //
        // The SPA only tests the marker for truthiness (`NATIVE_SHELL` in
        // `web/src/useCentral.ts`), so naming the platform costs nothing today
        // and is the signal a page needs the day the two shells have to differ.
        // On Windows the same script installs the window bridge — see
        // `shell_init_script`.
        .initialization_script(&shell_init_script())
        // Hidden is a real window with a real webview, not a deferred one: it
        // navigates, `on_navigation` fires, and WEBVIEW_READY opens the gate the
        // tray's cookie read waits on. That matters — `await_webview` polls
        // forever with no timeout, so a webview that never loaded would leave
        // the app supervising the agent while the tray never connects.
        .visible(visible)
        // Anything that is not the hub or the identity provider opens in the
        // user's browser and the navigation is refused here. A transcript is
        // full of links to other people's sites; following one in-window would
        // strand the user with no back button and no address bar — and it would
        // put a stranger's page in a window that holds a live session cookie.
        //
        // Refusing without opening would make such links silently dead, which
        // reads as a broken app, so the two always happen together.
        .on_navigation(move |url| {
            // Earliest honest proof the webview exists: this handler is called
            // BY it. Earlier than `on_page_load`, and unlike a load it still
            // fires when the hub is unreachable — otherwise the tray would wait
            // forever on a machine that booted with no network.
            WEBVIEW_READY.store(true, Ordering::SeqCst);
            apply_nav(&nav_handle, &nav_auth, url.as_str(), "hegai")
        })
        // `window.open()` never reaches the navigation handler — it is a
        // separate WebView2 event, and with nobody answering it wry claims the
        // request and drops it (`args.SetHandled(true)` at
        // wry `webview2/mod.rs:781`). That silence is what made the Telegram
        // button do nothing at all.
        .on_new_window(move |url, features| {
            use tauri::webview::NewWindowResponse;
            // `Host` is the ONLY answer that opens a window. `MainWindow` has
            // already moved the window we have, and `Refuse` has already handed
            // the URL to the browser where that was the right answer — both are
            // a `Deny` here, which is what stops the second «Hegai Code» window
            // a person expected their browser to be.
            if !matches!(popup_plan(&popup_handle, &auth, url.as_str()), PopupPlan::Host) {
                return NewWindowResponse::Deny;
            }
            // On macOS the answer has to be `Allow`, and it is not a preference.
            //
            // Building a Tauri window from inside this handler ABORTS the
            // process there. The handler is a WKUIDelegate callback, so it runs
            // on the main thread inside the event loop — and `send_user_message`
            // takes its inline branch on the main thread, re-entering state wry
            // is already holding for this very callback (`new_windows
            // .borrow_mut()` sits beside the branch that would serve us). The
            // panic surfaces as «panic in a function that cannot unwind», which
            // with `panic = "abort"` is the whole app gone. Found by running the
            // popup selftest on the mini, 21.09.2026: Abort trap: 6, and the
            // person at the keyboard saw «Hegai Code quit unexpectedly».
            //
            // wry's own `Allow` is a real NSWindow carrying a WKWebView built on
            // the OPENER's configuration — so `window.open()` still returns a
            // live object and the widget still arms its `closed` poll, which is
            // the whole requirement.
            //
            // What it costs, stated plainly: that popup's later hops do not go
            // through `decide`, so only its first URL was ever judged. The
            // exposure is bounded by the fact that a popup is only hosted at all
            // during a sign-in (`PopupPlan::Host`), and an excursion expires
            // with `AUTH_WINDOW`. A narrower window than that needs a runtime
            // that will let us build the child off this call stack; an app that
            // aborts when someone presses «Войти» is not a safer alternative.
            #[cfg(target_os = "macos")]
            {
                let _ = features;
                println!("[popup] handing to the system webview: {}", brief(url.as_str()));
                return NewWindowResponse::Allow;
            }
            // Windows keeps `Create`, not `Allow`. Both keep `window.open()`
            // returning a live window, which is what the login widget needs —
            // but `Allow` hands the child to WebView2 and the app never sees it
            // again, so only its FIRST url is ever checked. One
            // `p.location = 'https://…'` after that, or one redirect, and a
            // chromeless window carrying this app's session cookie is on a
            // stranger's page. `Create` hands WebView2 a window of ours instead,
            // so every hop inside the popup goes through the same `decide` as
            // the main window.
            #[cfg(not(target_os = "macos"))]
            {
            let label = format!("popup-{}", POPUP_SEQ.fetch_add(1, Ordering::SeqCst));
            let nav_handle = popup_handle.clone();
            let nav_auth = auth.clone();
            let blank = match "about:blank".parse() {
                Ok(u) => u,
                Err(_) => return NewWindowResponse::Deny,
            };
            // `about:blank` on purpose: WebView2 navigates the window it is
            // given to the real target itself. Building it already pointed at
            // the target would race that.
            match WebviewWindowBuilder::new(&popup_handle, label, WebviewUrl::External(blank))
                // Carries the opener's WebView2 environment — required on
                // Windows for a hosted new window — plus the size the page
                // asked for, so a 550×470 login form is not a full-size window.
                .window_features(features)
                .title("Вход")
                .on_navigation(move |u| apply_nav(&nav_handle, &nav_auth, u.as_str(), "popup"))
                .build()
            {
                Ok(window) => NewWindowResponse::Create { window },
                Err(e) => {
                    eprintln!("[popup] could not open the window: {e}");
                    NewWindowResponse::Deny
                }
            }
            }
        })
        // The webview is alive by the time it reports a navigation — this is
        // the gate the tray's cookie read waits on. See WEBVIEW_READY.
        .on_page_load(|_, _| WEBVIEW_READY.store(true, Ordering::SeqCst))
        // The page's only way to report back without an IPC bridge. Used by
        // `popup_selftest`; silent for every real title the hub sets.
        .on_document_title_changed(|_, title| {
            if let Some(rest) = title.strip_prefix(SELFTEST_MARK) {
                println!("[selftest]{rest}");
            }
        })
        .build()
}

/// Proof that a popup is real, without a human finding a login button.
/// `HEGAI_POPUP_SELFTEST=1`.
///
/// It asserts the exact predicate the Telegram widget branches on. `window.open`
/// returning an object is not cosmetic: `if (popup)` is what arms the `message`
/// listener and the `closed` poll, so a falsy return means the widget never
/// even starts waiting for an answer. Reading `popup.closed` proves the handle
/// is live rather than an inert stub.
///
/// **The URL has to be one the policy answers with `Host`.** It used to be
/// `acme.test/login`, which cannot be: that is a company host on an auth path,
/// so `decide` says `Allow`, and outside a sign-in excursion `popup_outcome`
/// turns `Allow` into `MainWindow` — the popup is refused BY DESIGN and
/// `window.open` correctly returns null. So the test reported failure on a
/// healthy app, on both platforms, and navigated the main window off the app as
/// it went. The hub's own `/api/auth/sso/start` is `Nav::Signin`, which is
/// `Host` unconditionally — and it is what a sign-in popup actually is, which
/// makes this the real rehearsal rather than a near one.
fn popup_selftest(window: &WebviewWindow) {
    let mode = std::env::var("HEGAI_POPUP_SELFTEST").unwrap_or_default();
    if mode == "window" {
        own_window_selftest(window);
        return;
    }
    if mode != "1" {
        return;
    }
    let w = window.clone();
    tauri::async_runtime::spawn(async move {
        // After the first page has settled; a popup from about:blank proves
        // nothing about the real one.
        tokio::time::sleep(Duration::from_secs(8)).await;
        let js = format!(
            r#"(function(){{
                 try {{
                   var p = window.open('{hub}/api/auth/sso/start?popup-selftest=1','_blank','width=550,height=470');
                   document.title = '{mark} window.open -> ' + (p ? 'live object, closed=' + p.closed : 'NULL (widget would give up here)');
                 }} catch (e) {{ document.title = '{mark} threw: ' + e.message; }}
               }})()"#,
            hub = hub_base(),
            mark = SELFTEST_MARK
        );
        match w.eval(&js) {
            Ok(()) => println!("[selftest] asked the page to open a popup"),
            Err(e) => eprintln!("[selftest] could not run: {e}"),
        }
    });
}

/// «Открыть в новом окне», pressed by the page itself — `HEGAI_POPUP_SELFTEST=window`.
///
/// The one control that froze the app (27.09.2026) is a menu item, and the
/// only Windows box within reach runs the app in session 0 through its agent,
/// where nobody can right-click anything. So the page makes the exact call the
/// menu makes (`window.open(<session url>?w=1, '_blank', 'noopener')`), and ten
/// seconds later asks the MAIN window for a sign of life. In `shell.log` a good
/// run reads: queued → second window loaded → «main alive», with no watchdog
/// line between them; the frozen build never gets past «queued».
fn own_window_selftest(window: &WebviewWindow) {
    let w = window.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(8)).await;
        let js = format!(
            r#"(function(){{
                 try {{
                   window.open('{hub}/w/sessions?{flag}=1','_blank','noopener');
                   document.title = '{mark} own window requested';
                 }} catch (e) {{ document.title = '{mark} threw: ' + e.message; }}
               }})()"#,
            hub = hub_base(),
            flag = OWN_WINDOW_FLAG,
            mark = SELFTEST_MARK
        );
        match w.eval(&js) {
            Ok(()) => println!("[selftest] asked the page to open its own window"),
            Err(e) => eprintln!("[selftest] could not run: {e}"),
        }
        tokio::time::sleep(Duration::from_secs(10)).await;
        let alive = format!("document.title = '{SELFTEST_MARK} main alive ' + Date.now()");
        match w.eval(&alive) {
            Ok(()) => println!("[selftest] pinged the main window"),
            Err(e) => eprintln!("[selftest] could not ping the main window: {e}"),
        }
    });
}

/// The navigation policy, APPLIED — `decide` says what should happen, this
/// carries it out and moves the sign-in state machine.
///
/// Shared by the main window and the popup because those two had already
/// drifted: the popup ran `decide` for its opening URL, acted on `External`
/// alone, and threw away every state transition — so a sign-in started in a
/// popup never opened the excursion, and a popup that finished one never closed
/// it. `who` is only the log prefix.
fn apply_nav(app: &tauri::AppHandle, auth: &AuthFlow, raw: &str, who: &str) -> bool {
    match decide(raw, auth.active()) {
        Nav::Signin => {
            auth.begin();
            println!("[{who}] nav (sign-in) {}", brief(raw));
            true
        }
        Nav::Enter => {
            auth.end();
            println!("[{who}] nav {}", brief(raw));
            true
        }
        Nav::Allow => {
            println!("[{who}] nav {}", brief(raw));
            true
        }
        Nav::BackToApp => {
            if auth.claim_bounce() {
                println!("[{who}] platform dead end at {} -> back to the app", brief(raw));
                go_home(app);
                false
            } else {
                // Already tried once. Rendering it is worse than a loop, but a
                // loop is the one thing the user cannot escape, so let the page
                // through and let them see it.
                println!("[{who}] platform again at {} -> giving up, rendering", brief(raw));
                auth.end();
                true
            }
        }
        Nav::External => {
            // Logged, not silent: when a flow bounces somewhere nobody
            // predicted, this line is the only thing that says so.
            println!("[{who}] refused -> browser: {}", brief(raw));
            open_externally(app, raw);
            false
        }
        Nav::Blocked => {
            println!("[{who}] blocked: {}", brief(raw));
            false
        }
    }
}

/// Does closing this window HIDE it, or actually close it?
///
/// Only the main window hides. Every other window this app opens is one a
/// person expects to be able to close for good, and the difference is not
/// cosmetic:
///
///  - a `popup-*` sign-in window is watched BY THE PAGE that opened it. The
///    Telegram widget polls `popup.closed` (see `popup_outcome`), and a popup
///    that only ever hides is never closed as far as that poll is concerned —
///    so cancelling a sign-in leaves the widget waiting for an answer that can
///    never arrive.
///  - the offline waiting room is closed by `unpark` when the hub comes back.
///    Refusing that close leaves the app holding a hidden window it believes it
///    has disposed of, on top of the one it just restored.
///
/// The tray keeps the app alive; the main window is what it keeps alive FOR.
fn close_hides(label: &str) -> bool {
    label == MAIN_WINDOW
}

/// The tray's agent line. Held so the supervisor can rewrite it in place —
/// rebuilding the whole menu on every poll would close it under the cursor.
///
/// Both platforms since the app installs the agent itself (`enroll.rs`):
/// the row shows the install's progress and then, on Windows, the running
/// process (its supervisor takes the row over); on macOS launchd keeps the
/// process, so the row simply says it is installed.
struct AgentMenuItem(MenuItem<tauri::Wry>);

/// Show the agent's state where someone can see it without reading a log.
/// Disabled by design: it is a readout, not a button.
pub fn set_agent_status(app: &tauri::AppHandle, text: &str) {
    if let Some(item) = app.try_state::<AgentMenuItem>() {
        let _ = item.0.set_text(text);
    }
}

/// «Подключить этот компьютер». Enabled only while the agent is disconnected
/// (`enroll::publish` drives it, independent of the status row, which on
/// Windows another supervisor also writes).
struct ReconnectMenuItem(MenuItem<tauri::Wry>);

pub fn set_reconnect_enabled(app: &tauri::AppHandle, on: bool) {
    if let Some(item) = app.try_state::<ReconnectMenuItem>() {
        let _ = item.0.set_enabled(on);
    }
}

/// The notification rows, kept so the check marks can be moved when the choice
/// changes. Tray menus are built once; without a handle the ticked row would
/// stay on whatever was ticked at startup.
struct NotifyMenuItems([CheckMenuItem<tauri::Wry>; 3]);

/// Rebuild the check marks from the stored setting.
fn sync_notify_menu(app: &tauri::AppHandle) {
    let Some(items) = app.try_state::<NotifyMenuItems>() else {
        return;
    };
    let current = hub::current_policy();
    for (item, p) in items.0.iter().zip(NOTIFY_CHOICES) {
        let _ = item.set_checked(p == current);
    }
}

/// The three answers to «насколько меня дёргать», in menu order.
const NOTIFY_CHOICES: [hub::NotifyPolicy; 3] = [
    hub::NotifyPolicy::All,
    hub::NotifyPolicy::Blocking,
    hub::NotifyPolicy::Off,
];

fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Открыть", true, None::<&str>)?;
    // The agent readout — see AgentMenuItem.
    let agent_status = MenuItem::with_id(app, "agent", "агент: проверяю…", false, None::<&str>)?;
    let agent_reconnect =
        MenuItem::with_id(app, "agent_reconnect", "Подключить этот компьютер", false, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    // The off switch that did not exist. Closing the window only HIDES it
    // (`CloseRequested` below), so until now there was no gesture anywhere in
    // this app — or in the web UI it renders — that stopped the toasts.
    let current = hub::current_policy();
    let notify_head = MenuItem::with_id(app, "notify_head", "Уведомления", false, None::<&str>)?;
    let notify_all = CheckMenuItem::with_id(
        app,
        "notify_all",
        "все события",
        true,
        current == hub::NotifyPolicy::All,
        None::<&str>,
    )?;
    let notify_blocking = CheckMenuItem::with_id(
        app,
        "notify_blocking",
        "только когда нужен я",
        true,
        current == hub::NotifyPolicy::Blocking,
        None::<&str>,
    )?;
    let notify_off = CheckMenuItem::with_id(
        app,
        "notify_off",
        "выключить",
        true,
        current == hub::NotifyPolicy::Off,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
    // The shell is the one part of this product that does not ship itself — see
    // update.rs. Built from the module's own state so the row is correct even
    // though the menu exists long before the first check.
    let sep_upd = PredefinedMenuItem::separator(app)?;
    let update = MenuItem::with_id(
        app,
        "update",
        update::menu_label(),
        update::menu_enabled(),
        None::<&str>,
    )?;
    let server = MenuItem::with_id(app, "server", "Сервер…", true, None::<&str>)?;
    let mut items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = vec![
        &open,
        &sep,
        &notify_head,
        &notify_all,
        &notify_blocking,
        &notify_off,
    ];
    items.extend([
        &sep_upd as &dyn tauri::menu::IsMenuItem<tauri::Wry>,
        &update,
        &server,
    ]);
    items.extend([
        &sep3 as &dyn tauri::menu::IsMenuItem<tauri::Wry>,
        &agent_status,
        &agent_reconnect,
    ]);
    items.extend([
        &sep2 as &dyn tauri::menu::IsMenuItem<tauri::Wry>,
        &quit,
    ]);
    let menu = Menu::with_items(app, &items)?;
    drop(items);
    app.manage(AgentMenuItem(agent_status));
    app.manage(ReconnectMenuItem(agent_reconnect));
    app.manage(NotifyMenuItems([notify_all, notify_blocking, notify_off]));
    app.manage(update::UpdateMenuItem(update));

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Hegai Code")
        .menu(&menu)
        // On Windows: left click raises the window, and the menu is the
        // right-click gesture a tray icon is expected to answer.
        //
        // On macOS a menu bar extra has no such split — ANY click opens the
        // menu — so the flag flips and «Открыть» becomes the way to the window.
        // The click handler below is gated to match: the macOS tray sends mouse
        // events regardless of the menu, so leaving it on would open the menu
        // and raise the window from one click.
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => open_app(app),
            "notify_all" | "notify_blocking" | "notify_off" => {
                let p = match event.id().as_ref() {
                    "notify_blocking" => hub::NotifyPolicy::Blocking,
                    "notify_off" => hub::NotifyPolicy::Off,
                    _ => hub::NotifyPolicy::All,
                };
                hub::set_policy(app, p);
                // A CheckMenuItem ticks ITSELF on click, so without this the
                // menu would end up with two or three rows ticked at once.
                sync_notify_menu(app);
            }
            "agent_reconnect" => enroll::request_reconnect(app),
            "update" => update::on_menu_click(app),
            "server" => hubconf::open_server_window(app),
            "quit" => {
                app.state::<AppFlags>().quitting.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // macOS opens the menu on the same click — see the flag above.
            if cfg!(target_os = "macos") {
                return;
            }
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                open_app(tray.app_handle());
            }
        });

    // macOS: a menu bar extra is a monochrome TEMPLATE, not the app icon. The
    // window icon (a navy tile with two lines of text inside the macOS icon
    // grid's margins) was scaled to the 18 pt bar and came out a ~14 px dark
    // square whose text nobody could read, invisible on a dark menu bar
    // (seen on the mini 28.09.2026). Then came the «a.test» wordmark, which
    // was readable but a wide strip of text among square icons; since 0.1.23
    // (30.09.2026, by request) it is a rounded square with the «h» of that
    // same wordmark cut out (`icons/tray-macos.png`, 36×36 = 18 pt @2x). As a
    // template macOS tints it to the bar's own colour in both themes.
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray-macos.png"))?)
            .icon_as_template(true);
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn main() {
    // First, so everything after it — including a panic in setup — is on file.
    shelllog::install();
    tauri::Builder::default()
        .manage(AppFlags {
            quitting: AtomicBool::new(false),
        })
        // Must be registered FIRST: it decides whether this process lives at
        // all, and a second instance should hand its focus request over before
        // any window or tray work happens.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A second launch is usually a person double-clicking an app that
            // is already in the tray, and raising the window is the answer they
            // want. It can also be the supervisor spawning us again because its
            // liveness check missed — that one carries the flag, and has to be
            // as quiet as the launch it is duplicating. Otherwise the one path
            // left that puts a window on screen unasked is the one that runs
            // unattended.
            if is_background_launch(args.into_iter().skip(1)) {
                return;
            }
            open_app(app);
        }))
        // Geometry ONLY — not visibility, not decorations, and the exclusions
        // are load-bearing. `StateFlags::default()` is `all()`, which hands the
        // plugin two BUILD decisions to carry across upgrades as if they were
        // preferences:
        //
        //   • DECORATIONS restores `decorated` out of a state file an OLDER
        //     version wrote. A machine that ever ran 0.1.7 has `true` in there,
        //     so it would undo the frameless window on exactly the machines
        //     people use and never on a developer's clean one.
        //   • VISIBLE restores `visible`, and `close_hides` hides the main
        //     window to the tray — so the app would come back from its own
        //     tray-quit with no window and nothing on screen to say why.
        //
        // What is left is what the plugin is actually here for: where the
        // window was and how big.
        //
        // Read off the plugin's own source (2.4.1: `StateFlags::default` is
        // `all()`; `restore_state` applies `decorated` and `visible`), NOT off
        // a reproduction — a Windows GUI cannot be observed from the agent's
        // terminal, which runs in session 0. See deploy/FLEET.md.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        // WITHOUT the plugin's click hijack. By default it injects `init-iife.js`
        // into every page: a window `click` listener that calls `preventDefault()`
        // on any `<a target="_blank">` and asks `plugin:opener|open_url` over IPC
        // instead. The hub's origin is not granted that command (capabilities
        // carry only the window chrome), so the IPC call is refused and the
        // click is already cancelled: a left click on a transcript link did
        // NOTHING, while «Открыть в новом окне» from the context menu — which
        // bypasses the listener — worked (10.10.2026, caught live on buildbox-pc
        // through WebView2 DevTools: capture `defaultPrevented=false`, window
        // bubble `true`). Links must reach WebView2's NewWindowRequested, where
        // `on_new_window` → `popup_plan` decides; Rust still opens URLs through
        // the plugin (`open_externally`).
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        // In-app updates for the shell itself. Registering it makes
        // `plugins.updater` in tauri.conf.json MANDATORY — `pubkey` has no
        // default, so a missing block is a fatal startup error rather than a
        // quietly disabled feature. There is deliberately no `capabilities/`
        // directory: the plugin's four commands stay denied to the webview,
        // which loads a REMOTE origin and must never be able to trigger a
        // download-and-install.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // The page's menu bar — «Выход» and «Проверить обновления».
        // Invocable only where `capabilities/app-menu.json` says (Windows, the
        // hub's origin, the app's own windows); see `appmenu`.
        .invoke_handler(tauri::generate_handler![
            appmenu::shell_quit,
            appmenu::shell_update_row,
            appmenu::shell_update,
            hubconf::shell_set_hub,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            // First thing: every `hub_base()` after this line sees the chosen
            // hub, and the bridges exist before the window loads its page.
            hubconf::load(&handle);
            hubconf::init_bridges(&handle);
            shelllog::watch_main_thread(handle.clone());
            let auth = Arc::new(AuthFlow::new());
            // Popups are decided by `popup_policy`, wired into the window
            // builder itself — see build_main_window.
            // A switch of hub from the tray («Сервер…») restarts with the same
            // argv — on Windows that is the logon task's `--background`, which
            // would bring the app back with no window while the person waits
            // for one. `shell_set_hub` leaves a one-shot flag for that.
            let show_once = update::read_word(&handle, hubconf::SHOW_ONCE).is_some();
            if show_once {
                update::clear_word(&handle, hubconf::SHOW_ONCE);
            }
            let background = started_in_background() && !show_once;
            // Before the tray, which renders the choice as check marks.
            hub::load_policy(&handle);
            let window = build_main_window(&handle, auth, !background)?;
            if show_once {
                // Restarted from «Сервер…»: the person is waiting for this window.
                let _ = window.set_focus();
            }
            popup_selftest(&window);
            setup_tray(&handle)?;
            if background {
                println!("[hegai] started in the tray -> {}", start_url());
            } else {
                println!("[hegai] window -> {}", start_url());
            }
            // Background tasks are NOT started here — see `RunEvent::Ready`.
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if app.state::<AppFlags>().quitting.load(Ordering::SeqCst) {
                    return;
                }
                if !close_hides(window.label()) {
                    return;
                }
                // Closing hides. The tray icon is the app's real lifetime: it
                // carries the count of sessions waiting on an answer, and that
                // has to survive the window going away.
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Hegai Code")
        // Background work starts when the event loop is RUNNING, not in
        // `setup`.
        //
        // `setup` runs before the loop begins pumping. The tray's first act is
        // to read the session cookie out of the webview, and that call crosses
        // to the main thread and waits on a channel — one Tauri answers by
        // dropping the sender when the webview is not there yet. The receiving
        // end is `rx.recv().unwrap()` inside Tauri itself
        // (tauri-runtime-wry `lib.rs:1796`), so the process does not get an
        // error back: it panics, and with `panic = "abort"` in the release
        // profile the whole app dies on startup.
        //
        // `RunEvent::Ready` does NOT close that gap on its own — the webview can
        // still be absent here, which is what made the first attempt at this fix
        // fail. `WEBVIEW_READY` is what removes the race; starting from Ready is
        // kept because background work has nothing to do before the loop runs.
        .run(|handle, event| {
            // Clicking the dock icon of a running app with no window on screen.
            //
            // On Windows closing hides to the tray and the tray icon is the way
            // back. macOS has the same hidden-app state but a different gesture
            // for it, and without this the dock icon answers a click by doing
            // nothing at all — the app is running, so the OS has nothing to
            // launch, and no window volunteers itself.
            // Borrowed, not moved: `event` is still needed by the check below,
            // and the variant is `#[non_exhaustive]`, so the `..` is required
            // rather than decorative.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = &event
            {
                if !has_visible_windows {
                    open_app(handle);
                }
                return;
            }
            if matches!(event, tauri::RunEvent::Ready) {
                // The tray's own connection — it reads the session out of the
                // window's cookie jar.
                hub::spawn(handle.clone());
                // Windows is the only platform where a crashed agent stays down
                // until the next logon. This app is already running; it can
                // close that.
                #[cfg(windows)]
                agent::spawn(handle.clone());
                // Install and enroll the agent after sign-in, on both
                // platforms — the app IS the agent from the person's side.
                enroll::spawn(handle.clone());
                // Park the window on a local page when the hub cannot be
                // reached, and bring it back when it can.
                offline::spawn(handle.clone());
                // Watch for a newer shell and offer it in the tray. Last of the
                // four because it is the only one nobody is waiting on.
                update::spawn(handle.clone());
            }
        });
}

/// Origin + path for the log. Google's sign-in URLs run to several thousand
/// characters of opaque state; printed whole they bury every other line, and
/// the part that identifies a hop is the front.
fn brief(raw: &str) -> String {
    match Url::parse(raw) {
        Ok(u) => {
            let origin = match (u.scheme(), u.host_str()) {
                (s, Some(h)) => format!("{s}://{h}"),
                (s, None) => s.to_string(),
            };
            let q = if u.query().is_some() { "?…" } else { "" };
            format!("{origin}{}{q}", u.path())
        }
        Err(_) => raw.chars().take(120).collect(),
    }
}

/// Did the page ASK for a window of its own?
///
/// `window.open()` cannot say this: every caller looks identical by the time it
/// reaches us, and the shell's standing rule is that an app route moves the
/// window you already have rather than duplicating the whole SPA, its socket
/// and its session. That rule is right for a `target="_blank"` inside a
/// transcript, and wrong for the one control whose entire purpose is a second
/// window — «Открыть в новом окне» in the session list's context menu.
///
/// So the SPA marks its intent in the URL (`?w=1`, `web/src/shell/useSessionMenu.ts`)
/// and strips the flag once the page has loaded, so a shared or reloaded link
/// is an ordinary one. Only OUR OWN origin is trusted to ask: a stranger's page
/// carrying the same query gets the same answer it always did.
fn wants_own_window(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw) else { return false };
    if !is_hub_url(&url) {
        return false;
    }
    url.query_pairs().any(|(k, v)| k == OWN_WINDOW_FLAG && v == "1")
}

/// The query the SPA sets to ask for a window of its own — see `wants_own_window`.
const OWN_WINDOW_FLAG: &str = "w";

/// Did our own page ask for this link to open in the person's BROWSER?
///
/// A link in agent prose is something to read, not a place in the app: «ссылка
/// открывается в самом аппе, а нужно в браузере» (Owner, 10.10.2026, Windows).
/// Before this flag a report link (`/w/reports/<id>`) in a transcript became a
/// second chromeless app window — with no address bar to copy it from and no
/// tab to keep it in. The SPA marks such links (`BROWSER_FLAG` in
/// `web/src/router.ts`, set by `mdLinkHref`) only when this shell says it
/// understands the flag (`__HEGAI_LINKS_TO_BROWSER__`, `shell_init_script`), so
/// an older shell keeps its old answer instead of a URL it would misread.
///
/// Same trust rule as `wants_own_window`: only the origin we serve may ask. A
/// stranger's URL is External long before this is consulted anyway.
fn wants_browser(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw) else { return false };
    if !is_hub_url(&url) {
        return false;
    }
    url.query_pairs().any(|(k, v)| k == BROWSER_FLAG && v == "1")
}

/// The query the SPA sets to send one of OUR links to the browser — see
/// `wants_browser`. Must match `BROWSER_FLAG` in `web/src/router.ts`.
const BROWSER_FLAG: &str = "ext";

/// The URL the browser should get: our own request flags removed, so the
/// address a person sees, copies and shares is the plain one.
fn without_shell_flags(raw: &str) -> String {
    let Ok(mut url) = Url::parse(raw) else { return raw.to_string() };
    let kept: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| k != BROWSER_FLAG && k != OWN_WINDOW_FLAG)
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if kept.is_empty() {
        url.set_query(None);
    } else {
        url.query_pairs_mut().clear().extend_pairs(kept);
    }
    url.to_string()
}

/// A page's request for the browser, applied on top of `popup_outcome`. Only
/// an app route is redirected: a sign-in keeps its hosted popup (the widget
/// needs `window.opener`), and a refusal has already gone where it goes.
fn browser_override(plan: PopupPlan, asked_for_browser: bool) -> PopupPlan {
    match plan {
        PopupPlan::MainWindow | PopupPlan::OwnWindow if asked_for_browser => PopupPlan::Browser,
        other => other,
    }
}

/// What the policy decided about a `window.open()`.
enum PopupPlan {
    /// Open it as a window of ours, under the same navigation policy.
    Host,
    /// Send the MAIN window there instead of opening a second one.
    MainWindow,
    /// Build a SECOND app window for it, off this call stack.
    ///
    /// Deliberately not `Host`. `Host` hands the child to the platform webview
    /// (`Allow` on macOS, so its later hops are never judged again), which is
    /// the bargain the sign-in widget needs and nothing else should pay. This
    /// one is a window of OURS with its own `on_navigation`, created after the
    /// callback returns — building one inside it aborts the process on macOS
    /// (see the note in `on_new_window`).
    OwnWindow,
    /// One of our own links that the page asked to open in the system browser
    /// (`wants_browser`). Refused here, handed to the browser by `popup_plan`.
    Browser,
    /// Do not open it here. Handing it to the browser, when that is the right
    /// answer, has already happened.
    Refuse,
}

/// Should a `window.open()` become a second app window?
///
/// Almost never, and that is the correction. A hosted popup is a chromeless
/// window with no address bar, carrying this app's live session — it exists for
/// exactly one thing, the sign-in widget that talks to its opener through
/// `window.opener.postMessage` (see `popup_plan`). Everything else that reached
/// it did so because it happened to pass the navigation policy, and the result
/// was a second «Hegai Code» window where a person expected their browser.
///
/// So the gate is now the EXCURSION, not the address: a popup is hosted only
/// while a sign-in is actually in flight, or by the navigation that starts one.
/// Outside that,
///   - a link to this app's own UI moves the window you already have, because
///     opening a duplicate of the app to show one session is worse than both
///     alternatives;
///   - everything else goes to the browser, which is where a link to the web
///     belongs and where the person can see what they are looking at.
///
/// Pure, so the rule can be tested rather than reasoned about — `popup_plan`
/// keeps the side effects (opening the browser, logging).
fn popup_outcome(nav: &Nav, signing_in: bool, asked_for_a_window: bool) -> PopupPlan {
    match nav {
        Nav::External | Nav::Blocked => PopupPlan::Refuse,
        // A sign-in that STARTS in a popup has to open the excursion, or the
        // provider's next hop is refused.
        Nav::Signin => PopupPlan::Host,
        Nav::Enter | Nav::Allow | Nav::BackToApp => {
            if signing_in {
                PopupPlan::Host
            } else if asked_for_a_window {
                // The page asked, in the only way it can, and it is our own
                // page asking — see `wants_own_window`. A transcript link that
                // happens to open in a new tab still lands on the branch below.
                PopupPlan::OwnWindow
            } else {
                PopupPlan::MainWindow
            }
        }
    }
}

/// What to do with a `window.open()` from the page.
///
/// This has to be WebView2's OWN popup, not a window of ours, and the reason is
/// the whole bug. The Telegram login widget is not a link — it is a protocol
/// between two documents:
///
/// ```js
/// var popup = window.open(popup_url, 'telegram_oauth_bot' + bot_id, '...');
/// if (popup) {                    // ← everything hangs off this
///   addEvent(window, 'message', onMessage);
///   checkClose(bot_id);           // polls popup.closed every 100ms
/// }
/// ```
///
/// The opened page answers through `window.opener.postMessage`, and the opener
/// polls `popup.closed` to know the user gave up. Build the popup as a separate
/// window with its own webview and BOTH halves are severed: `window.open`
/// hands back nothing, so the listener is never even attached, and the child
/// has no opener to answer through. The widget then waits forever — which is
/// exactly what a person sees: a blank panel that goes nowhere and does not
/// close itself.
///
/// `NewWindowResponse::Allow` makes wry answer WebView2 with `SetHandled(false)`
/// (wry `webview2/mod.rs:770`), so WebView2 creates the child itself, in the
/// same environment and profile, with the opener relationship intact. The
/// session cookie still lands in this app's jar — which is why handing the URL
/// to the system browser is not an option here.
///
/// Policy still runs first: a popup is not automatically trustworthy, since the
/// SPA can open a transcript link with `target=_blank` and it arrives here the
/// same way a login widget does.
fn popup_plan(app: &tauri::AppHandle, auth: &Arc<AuthFlow>, raw: &str) -> PopupPlan {
    println!("[popup] requested: {}", brief(raw));
    let nav = decide(raw, auth.active());
    let plan = browser_override(
        popup_outcome(&nav, auth.active(), wants_own_window(raw)),
        wants_browser(raw),
    );
    match (&nav, &plan) {
        // Refusing without opening would make the link silently dead, which
        // reads as a broken app, so the two always happen together.
        (Nav::External, _) => {
            println!("[popup] refused -> browser: {}", brief(raw));
            open_externally(app, raw);
        }
        (Nav::Blocked, _) => println!("[popup] blocked: {}", brief(raw)),
        (Nav::Signin, _) => auth.begin(),
        (_, PopupPlan::MainWindow) => {
            println!("[popup] app route -> this window: {}", brief(raw));
            navigate_main(app, raw);
        }
        (_, PopupPlan::OwnWindow) => {
            println!("[popup] app route -> its own window: {}", brief(raw));
            open_second_window(app, auth, raw);
        }
        (_, PopupPlan::Browser) => {
            let clean = without_shell_flags(raw);
            println!("[popup] app link -> browser: {}", brief(&clean));
            open_externally(app, &clean);
        }
        // NOT `auth.end()` here. The excursion belongs to the main window, and
        // a popup opening a hub URL is not the window arriving home — ending it
        // from here would slam the door on a sign-in still in flight.
        _ => {}
    }
    plan
}

/// Popup labels have to be unique, and a widget that opens twice is normal.
static POPUP_SEQ: AtomicUsize = AtomicUsize::new(0);

/// Send the window back to the hub. Deferred to the main thread: this is called
/// from inside the navigation handler, and navigating the webview from within
/// its own navigation callback is re-entrant.
fn go_home(app: &tauri::AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Ok(url) = Url::parse(&start_url()) else {
            return;
        };
        if let Some(w) = handle.get_webview_window(MAIN_WINDOW) {
            if let Err(e) = w.navigate(url) {
                eprintln!("[hegai] could not return to the app: {e}");
            }
        }
    });
}

/// Point the window we already have at an app route, and raise it.
///
/// The answer to a `target="_blank"` on one of the hub's own links: a second
/// «Hegai Code» window showing one session is worse than either alternative —
/// it duplicates the whole SPA, its socket and its session, to render a route
/// the existing window could have gone to. Deferred to the main thread for the
/// same reason `go_home` is: this runs inside a webview callback.
fn navigate_main(app: &tauri::AppHandle, raw: &str) {
    let Ok(url) = Url::parse(raw) else { return };
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = handle.get_webview_window(MAIN_WINDOW) {
            if let Err(e) = w.navigate(url) {
                eprintln!("[popup] could not follow the link: {e}");
                return;
            }
            show_main(&w);
        }
    });
}

/// The window chrome, in one place, for every window the shell owns.
///
/// **macOS: `Overlay` + `hidden_title`, like Claude's own app (30.09.2026, by
/// request).** No title strip at all: the page runs to the window's top edge,
/// the traffic lights float over the left end of the app's own top bar, and
/// the bar leaves room for them.
///
/// Until 0.1.21 this was `Transparent`, on the argument that Overlay is "a
/// window that cannot be moved": Tauri's docs say it needs a custom drag
/// region, and the page is REMOTE with no Tauri IPC. The second half stopped
/// being true when the Windows shell got its bridge — the page CAN reach
/// `start_dragging` from `code.acme.test`, over a capability scoped to that
/// origin and to our own windows. So the Mac gets the same bridge, cut to the
/// two commands a Mac title bar does (drag, and double-click to zoom), granted
/// by `capabilities/window-drag-mac.json`. The system still draws and drives
/// the three buttons; fullscreen stays the system's.
///
/// The price, still true: WKWebView ignores `-webkit-app-region`, so every
/// drag is the PAGE calling the bridge (`installMacChrome` in
/// `web/src/shell/WindowChrome.tsx`). The sign-in popup and the offline window
/// are not built by this function and keep their frame. KNOWN GAP: a sign-in
/// excursion that runs IN the main window (the provider's pages, `Nav::Allow`
/// while signing in) has no bridge there — for that minute the window cannot
/// be dragged and the lights sit over the provider's top-left corner. Switching
/// the style per navigation was weighed and not done: it has to happen off the
/// navigation callback (see `open_second_window` for why), and the inset from
/// `TRAFFIC_LIGHTS` would push the lights out of a 28pt strip anyway.
///
/// `TRAFFIC_LIGHTS` centres the buttons on the web's 56px `.topbar`; the page
/// pads that bar by `--mac-lights` to clear them. Change one, change the other.
///
/// **Windows: `decorations(false)`, and the page draws the rest.** It is the
/// only frameless mode Windows has and it takes the minimise, maximise and
/// CLOSE buttons with the frame, so the app has to draw all three — and be able
/// to ACT on them from a remote origin. That is what `WINDOW_BRIDGE` and
/// `capabilities/window-chrome.json` are for: four commands and one question,
/// granted to the hub's origin and to `main`/`window-*` only.
///
/// The bargain, stated: a window with no visible identity is a hazard this file
/// names twice, and the answer is that this window's identity is the app it
/// renders — the same session list, the same top bar. The sign-in popup, where
/// the page belongs to somebody else, keeps its frame and gets no bridge.
///
/// What is NOT frameless on either platform: the sign-in popup and the offline
/// window. A chromeless window carrying a live session with no visible identity
/// is the hazard this file names twice already, and a login window is exactly
/// where a frame earns its pixels.
/// Where the traffic lights sit in an `Overlay` window, in points from the
/// top-left corner: x as the system draws it, y chosen to centre a 14pt button
/// on the web's 56px top bar. See `shell_window`.
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHTS: (f64, f64) = (20.0, 26.0);

/// Overlay only where the drag bridge is granted: `code.acme.test` by the
/// static capability, any other configured hub by `hubconf::grant_bridges` at
/// startup. If that grant failed (or `CC_HEGAI_URL` points somewhere the
/// capability does not cover), the window would have no title bar and a bridge
/// whose every call is refused — immovable. There it keeps the 0.1.21 chrome:
/// a real transparent title bar, no bridge.
fn mac_overlay() -> bool {
    cfg!(target_os = "macos") && hubconf::bridges_granted()
}

fn shell_window(
    builder: WebviewWindowBuilder<'_, tauri::Wry, tauri::AppHandle>,
) -> WebviewWindowBuilder<'_, tauri::Wry, tauri::AppHandle> {
    let builder = builder
        .min_inner_size(720.0, 520.0)
        .resizable(true)
        // Hand dropped files to the PAGE, not to us. Tauri installs its own
        // OS-level drag-drop handler by default, and on WebView2 that handler
        // consumes the drop before the DOM sees it: no `dragover`, no `drop`,
        // so the composer's `onDrop` never runs and dragging a file into the
        // message box does nothing. Disabling is REQUIRED for HTML5 drag and
        // drop on Windows (`WindowConfig::drag_drop_enabled`), and nothing here
        // listens for Tauri's own DragDropEvent, so it costs no behaviour.
        .disable_drag_drop_handler();
    #[cfg(target_os = "macos")]
    {
        if mac_overlay() {
            builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(tauri::LogicalPosition::new(TRAFFIC_LIGHTS.0, TRAFFIC_LIGHTS.1))
        } else {
            builder.title_bar_style(tauri::TitleBarStyle::Transparent).hidden_title(true)
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder.decorations(false)
    }
}

/// The four window controls, handed to the page — Windows only.
///
/// Windows has exactly one frameless mode and it takes the minimise, maximise
/// and CLOSE buttons with the frame. So either the window wears a system bar
/// saying «Hegai Code» above an app that draws its own, or the app draws the
/// buttons too. It cannot draw them without a way to act on them, and the page
/// is a REMOTE origin (`code.acme.test`) — which is why this bridge and the
/// capability beside it (`capabilities/window-chrome.json`) exist at all.
///
/// Deliberately NOT `withGlobalTauri`. That injects the whole API object into
/// every webview this app makes, and one of them is the sign-in popup, where
/// the page is the identity PROVIDER's. This is four named functions, on our
/// own windows only, over the invoke bridge that already exists; the capability
/// is what actually decides whether a call is allowed, and it is scoped to the
/// hub's origin and to `main`/`window-*`.
///
/// `isMaximized` is a question, not an action — the page needs it to draw the
/// restore glyph rather than the maximise one.
const WINDOW_BRIDGE: &str = r#"
(() => {
  const invoke = (cmd, args) =>
    window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke
      ? window.__TAURI_INTERNALS__.invoke('plugin:window|' + cmd, args || {})
      : Promise.reject(new Error('no bridge'));
  window.__HEGAI_WINDOW__ = {
    startDragging: () => invoke('start_dragging'),
    minimize: () => invoke('minimize'),
    toggleMaximize: () => invoke('toggle_maximize'),
    close: () => invoke('close'),
    isMaximized: () => invoke('is_maximized'),
  };
})();
"#;

/// The menu bar's half (0.1.27+), Windows only: what the page cannot do on
/// its own — quit and the update row (`appmenu`), plus the version for «О
/// программе». Its OWN global, so a web that does not know it simply never
/// draws «Выход» or «Справка», and a page that sees it knows the shell can
/// honour every row.
/// `__VERSION__` is replaced in `shell_init_script`.
// Used only in the Windows branch of a RUNTIME `cfg!` — so it must exist on
// every target (the Mac compiles that branch too), and is dead code there.
#[cfg_attr(target_os = "macos", allow(dead_code))]
const APP_BRIDGE: &str = r#"
(() => {
  const invoke = (cmd, args) =>
    window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke
      ? window.__TAURI_INTERNALS__.invoke(cmd, args || {})
      : Promise.reject(new Error('no bridge'));
  window.__HEGAI_APP__ = {
    version: '__VERSION__',
    quit: () => invoke('shell_quit'),
    updateRow: () => invoke('shell_update_row'),
    update: () => invoke('shell_update'),
  };
})();
"#;

/// The Mac's half of the bridge: a title bar there has two behaviours the page
/// must now provide — drag, and double-click to zoom — plus one question, «is
/// this native fullscreen?», which decides whether the page leaves room for
/// the traffic lights (a zoomed window with an auto-hidden menu bar is the
/// size of the screen too, so geometry cannot answer it). The three buttons
/// stay the system's. Granted by `capabilities/window-drag-mac.json`.
///
/// Its OWN global, not `__HEGAI_WINDOW__`: a web build from before 0.1.22
/// reads that name as «the Windows bridge» and calls `isMaximized` on it —
/// a TypeError in an effect, and with no error boundary an empty window. A
/// rolled-back hub or a cached page must not be able to do that to this shell.
const MAC_WINDOW_BRIDGE: &str = r#"
(() => {
  const invoke = (cmd, args) =>
    window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke
      ? window.__TAURI_INTERNALS__.invoke('plugin:window|' + cmd, args || {})
      : Promise.reject(new Error('no bridge'));
  window.__HEGAI_MAC_WINDOW__ = {
    startDragging: () => invoke('start_dragging'),
    toggleMaximize: () => invoke('toggle_maximize'),
    isFullscreen: () => invoke('is_fullscreen'),
  };
})();
"#;

/// What every window the shell owns runs before the page's own scripts: the
/// shell marker, and the window bridge for the platform.
///
/// **It must not touch the DOM.** The script runs when the document is CREATED
/// (WebView2 `AddScriptToExecuteOnDocumentCreated`), before a single tag is
/// parsed — `document.documentElement` is `null` there. 0.1.8 and 0.1.9 set a
/// CSS variable on it on the line between the marker and the bridge: that line
/// threw, the bridge below it never ran, and the page drew no window buttons
/// and no drag region in a window that had no frame. The result was a window
/// that could not be moved, restored or closed — stuck «fullscreen», since the
/// window-state plugin brings it back maximised. The marker, set on the line
/// ABOVE, survived, which is why everything else looked fine. Reproduced on
/// Chromium 144 with `evaluateOnNewDocument` (same mechanism, same engine):
/// `String(document.documentElement)` is `"null"` and nothing after the throw
/// runs. The CSS variable had no reader in `web/` anyway.
///
/// So: plain assignments to `window`, bridge right after the marker, and a test
/// (`init_script_*`) that fails the day someone puts `document.` back in here.
fn shell_init_script() -> String {
    // The agent's phase is pushed by `enroll::publish` as it changes; this is
    // only the placeholder a page sees before the first push.
    let agent = "window.__HEGAI_AGENT__ = window.__HEGAI_AGENT__ || {phase:'checking'};\n";
    // «This shell builds a second window without hanging» — see
    // `open_second_window`. The page offers «Открыть в новом окне» inside a
    // shell only when it sees this, because every shell up to 0.1.17 froze
    // (Windows) or quit (macOS) on it, and those stay installed until updated.
    let agent = format!("{agent}window.__HEGAI_OWN_WINDOWS__ = 1;\n");
    // «This shell sends a link flagged `ext=1` to the browser» — see
    // `wants_browser`. Without it the page keeps the own-window flag, which is
    // the right answer for a shell that cannot read the new one.
    let agent = format!("{agent}window.__HEGAI_LINKS_TO_BROWSER__ = 1;\n");
    if cfg!(target_os = "macos") {
        let bridge = if mac_overlay() { MAC_WINDOW_BRIDGE } else { "" };
        format!("window.__HEGAI_SHELL__ = 'mac';\n{agent}{bridge}")
    } else {
        // The version is ours (Cargo.toml, three-way checked by a test), digits
        // and dots only — nothing a quote could break out of.
        // Only where `app-menu` is granted (the default hub statically, any
        // other hub at runtime): where it is not, every call would be refused,
        // so the page must not be told these rows exist.
        let app = if hubconf::bridges_granted() {
            APP_BRIDGE.replace("__VERSION__", env!("CARGO_PKG_VERSION"))
        } else {
            String::new()
        };
        format!("window.__HEGAI_SHELL__ = 'windows';\n{agent}{WINDOW_BRIDGE}{app}")
    }
}

/// A SECOND app window, on the same session, for a page that asked for one.
///
/// Built AFTER the `on_new_window` callback returns, and it has to be a real
/// "after". `run_on_main_thread` alone is NOT a deferral: called from the main
/// thread — which is where every webview callback runs — tauri-runtime-wry's
/// `send_user_message` runs the task INLINE (`lib.rs`, the `main_thread_id`
/// branch). So until 27.09.2026 the window was built inside the callback after
/// all, and each platform paid its own way:
///
/// - **Windows: the app froze.** wry creates the WebView2 controller and then
///   waits for it in `wait_with_pump`; WebView2 does not complete that creation
///   while its own `NewWindowRequested` handler is still on the stack, so the
///   pump spins forever. «Открыть в новом окне» → the whole app hangs.
/// - **macOS:** the callback is a `WKUIDelegate` method inside wry's event
///   loop, and building a window there re-enters state wry holds — «panic in a
///   function that cannot unwind», the whole app gone (see `on_new_window`).
///
/// Hence a thread, and `build()` called from it: off the main thread Tauri only
/// queues the creation as a message, and the event loop performs it on a later
/// turn with no webview callback underneath. Verified on a live Windows box
/// with the shell log (`shelllog.rs`) before release, not only reasoned. The caller does not need
/// the handle back: the control that opens this is a menu item, not the login
/// widget, and nobody is polling `popup.closed`.
///
/// It is a window of OURS, so `on_navigation` applies the same `decide` to
/// every hop inside it — unlike a `Host`ed popup on macOS, whose later hops go
/// unjudged. It carries no tray, no agent supervisor and no auth callbacks:
/// one window owns those (`MAIN_WINDOW`), and `close_hides` keeps hiding to the
/// tray a main-window-only behaviour, so closing this one really closes it.
fn open_second_window(app: &tauri::AppHandle, auth: &Arc<AuthFlow>, raw: &str) {
    let Ok(url) = Url::parse(raw) else { return };
    let handle = app.clone();
    let nav_handle = app.clone();
    let nav_auth = auth.clone();
    let popup_handle = app.clone();
    let popup_auth = auth.clone();
    let label = format!("window-{}", POPUP_SEQ.fetch_add(1, Ordering::SeqCst));
    let build = move || {
        match shell_window(WebviewWindowBuilder::new(&handle, &label, WebviewUrl::External(url)))
            .title(APP_TITLE)
            .inner_size(1100.0, 800.0)
            // The same marker and the same bridge as the main window: this one
            // is frameless too, so its page has to draw and drive its chrome.
            .initialization_script(&shell_init_script())
            .on_navigation(move |u| apply_nav(&nav_handle, &nav_auth, u.as_str(), "window"))
            // A link clicked HERE goes through the same policy as one in the
            // main window. Without a handler wry denies the request silently,
            // so a transcript link in a second window did nothing (review of
            // 0.1.26). Never hosted: sign-in belongs to the main window, and
            // every useful answer (browser, main window, another window) has
            // already been carried out by `popup_plan`.
            .on_new_window(move |u, _features| {
                let _ = popup_plan(&popup_handle, &popup_auth, u.as_str());
                tauri::webview::NewWindowResponse::Deny
            })
            .on_page_load(|w, p| {
                if matches!(p.event(), tauri::webview::PageLoadEvent::Finished) {
                    println!("[popup] second window {} loaded {}", w.label(), brief(p.url().as_str()));
                }
            })
            .build()
        {
            // `Ok` means QUEUED: the event loop creates the webview on a later
            // turn, and a failure there is logged by the runtime, not returned.
            Ok(_) => println!("[popup] second window {label} queued"),
            Err(e) => eprintln!("[popup] could not open a second window: {e}"),
        }
    };
    // From a thread, so `build()` does not run on the main thread inside this
    // webview callback: off the main thread it only queues the creation, and
    // the event loop performs it on a later turn, after the callback returned.
    println!("[popup] second window: handing the build to a thread");
    std::thread::spawn(build);
}

/// Open an external URL in the system browser — the other half of every
/// navigation the window refuses.
fn open_externally(app: &tauri::AppHandle, url: &str) {
    if let Err(e) = app.opener().open_url(url, None::<&str>) {
        eprintln!("[hegai] could not open {url}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The init script runs before `<html>` exists; any `document.` access in it
    /// throws and silently takes every line after it down — which is how 0.1.8
    /// and 0.1.9 shipped a frameless window with no buttons. See
    /// `shell_init_script`.
    #[test]
    fn init_script_never_touches_the_dom() {
        let script = shell_init_script();
        assert!(!script.contains("document."), "init script touches the DOM:\n{script}");
        assert!(script.starts_with("window.__HEGAI_SHELL__ = "));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn init_script_installs_the_window_bridge() {
        let script = shell_init_script();
        assert!(script.contains("window.__HEGAI_WINDOW__ = {"));
        for cmd in ["start_dragging", "minimize", "toggle_maximize", "close", "is_maximized"] {
            assert!(script.contains(&format!("invoke('{cmd}')")), "bridge lost {cmd}");
        }
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn init_script_installs_the_app_menu_bridge_with_the_version() {
        // Only where the bridge is granted — see `shell_init_script`.
        if !hubconf::bridges_granted() {
            return;
        }
        let script = shell_init_script();
        assert!(script.contains("window.__HEGAI_APP__ = {"));
        assert!(script.contains(&format!("version: '{}'", env!("CARGO_PKG_VERSION"))));
        assert!(!script.contains("__VERSION__"));
        for cmd in ["shell_quit", "shell_update_row", "shell_update"] {
            assert!(script.contains(&format!("invoke('{cmd}'")), "bridge lost {cmd}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn init_script_installs_the_mac_drag_bridge() {
        let script = shell_init_script();
        // Only where the overlay is on — see `mac_overlay`.
        if !mac_overlay() {
            return;
        }
        assert!(script.contains("window.__HEGAI_MAC_WINDOW__ = {"));
        assert!(!script.contains("window.__HEGAI_WINDOW__"), "old webs read that name as the Windows bridge");
        for cmd in ["start_dragging", "toggle_maximize", "is_fullscreen"] {
            assert!(script.contains(&format!("invoke('{cmd}')")), "bridge lost {cmd}");
        }
        assert!(!script.contains("invoke('close')"));
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn only_the_supervisor_starts_without_a_window() {
        // Орлов passes the flag at logon; nothing else does.
        assert!(is_background_launch(args(&["--background"])));
        // A person: the Start menu, the installer's last step, a double-click.
        assert!(!is_background_launch(args(&[])));
        // Near misses are not the flag. Guessing here would mean an app that
        // silently never shows itself, and no window is much harder to
        // diagnose than an unwanted one.
        assert!(!is_background_launch(args(&["--backgrounded"])));
        assert!(!is_background_launch(args(&["background"])));
    }

    #[test]
    fn a_telegram_bot_link_always_goes_to_the_telegram_app() {
        let link = "https://t.me/Hegaicodebot?start=login_0123456789abcdef0123456789abcdef";
        // Outside a sign-in, and — the case this rule exists for — inside one,
        // where any https page would otherwise render in the window.
        assert_eq!(decide(link, false), Nav::External);
        assert_eq!(decide(link, true), Nav::External);
        assert_eq!(decide("https://telegram.me/hegailoginbot?start=auth_x", true), Nav::External);
        // As a `target=_blank` popup (how the page opens it): refused here and
        // handed to the browser, never a window of ours.
        assert!(matches!(
            popup_outcome(&decide(link, true), true, false),
            PopupPlan::Refuse
        ));
        assert!(matches!(
            popup_outcome(&decide(link, false), false, false),
            PopupPlan::Refuse
        ));
        // The platform's login widget is not a bot link: mid-sign-in it still
        // renders, so its popup can talk to its opener.
        assert_eq!(
            decide("https://oauth.telegram.org/auth?bot_id=1&origin=https%3A%2F%2Facme.test", true),
            Nav::Allow
        );
        // A lookalike is not Telegram.
        assert_eq!(decide("https://t.me.evil.test/x", true), Nav::Allow);
        assert_eq!(decide("https://t.me.evil.test/x", false), Nav::External);
        // And the `tg:` scheme itself stays blocked: a page does not get to
        // name a program for the OS to open.
        assert_eq!(decide("tg://resolve?domain=Hegaicodebot", false), Nav::Blocked);
    }

    #[test]
    fn the_platform_homepage_is_a_dead_end_and_sends_the_window_home() {
        // Exactly the observed dead end: Google callback lands on the platform
        // root, the SSO `next` having been dropped.
        assert_eq!(decide("https://acme.test/", true), Nav::BackToApp);
        assert_eq!(decide("https://acme.test/feed", true), Nav::BackToApp);
        // Still part of signing in, so these must NOT bounce.
        assert_eq!(decide("https://acme.test/login?sso=1", true), Nav::Allow);
        assert_eq!(
            decide("https://acme.test/api/community/auth/google/callback?code=x", true),
            Nav::Allow
        );
        assert_eq!(
            decide("https://api.acme.test/api/community/auth/google/start", true),
            Nav::Allow
        );
    }

    #[test]
    fn the_platform_is_a_link_out_when_no_sign_in_is_running() {
        // Nothing to complete, so it is just someone else's site.
        assert_eq!(decide("https://acme.test/", false), Nav::External);
    }

    #[test]
    fn the_window_returns_home_only_once_per_excursion() {
        let flow = AuthFlow::new();
        flow.begin();
        assert!(flow.claim_bounce(), "first return trip is allowed");
        assert!(!flow.claim_bounce(), "a second would be a loop the user cannot escape");
        flow.begin();
        assert!(flow.claim_bounce(), "a fresh excursion may try again");
    }

    /// The selftest has to ask for a popup the policy would actually HOST.
    ///
    /// Its old URL (`acme.test/login`) is an auth path on a company host, which
    /// `decide` answers with `Allow` — and outside an excursion that becomes
    /// `MainWindow`, i.e. no popup at all. The test therefore printed «NULL
    /// (widget would give up here)» against a perfectly healthy app on both
    /// platforms, which is worse than having no test.
    #[test]
    fn the_popup_selftest_asks_for_something_that_can_be_hosted() {
        let start = format!("{}/api/auth/sso/start?popup-selftest=1", hub_base());
        assert!(
            matches!(popup_outcome(&decide(&start, false), false, false), PopupPlan::Host),
            "the selftest URL must be one the policy hosts, or it tests nothing"
        );
        let old = "https://acme.test/login?popup-selftest=1";
        assert!(
            !matches!(popup_outcome(&decide(old, false), false, false), PopupPlan::Host),
            "kept as the counter-example: this is why the old selftest could not pass"
        );
    }

    /// A sign-in popup must really close, or the page that opened it waits
    /// forever on `popup.closed`; the waiting room must really close, or
    /// `unpark` leaves a hidden window behind the restored one. Only the window
    /// the tray exists for is allowed to merely hide.
    #[test]
    fn only_the_main_window_hides_when_it_is_closed() {
        assert!(close_hides(MAIN_WINDOW));
        assert!(!close_hides("popup-0"), "a cancelled sign-in has to be observable");
        assert!(!close_hides(offline::OFFLINE_WINDOW), "unpark closes this one for real");
    }

    /// Drive `decide` the way the window does, threading sign-in state through
    /// a sequence of hops. Returns the decision for each.
    fn walk(chain: &[&str]) -> Vec<Nav> {
        let mut signing_in = false;
        chain
            .iter()
            .map(|raw| {
                let d = decide(raw, signing_in);
                match d {
                    Nav::Signin => signing_in = true,
                    Nav::Enter => signing_in = false,
                    _ => {}
                }
                d
            })
            .collect()
    }

    /// The Google sign-in chain EXACTLY as the running app logged it, hop by
    /// hop, ending on the one that used to be refused.
    ///
    /// The last three hops are Google's cookie-sync fan-out. `accounts.google.ru`
    /// is why an allowlist of provider hosts cannot work: the set is dozens of
    /// country domains deep and not ours to enumerate.
    #[test]
    fn the_real_google_chain_completes_without_leaving_the_window() {
        let chain = [
            "https://code.acme.test/w/sessions",
            "https://code.acme.test/api/auth/sso/start",
            "https://admin.acme.test/api/community/auth/sso/authorize?client=cc-remote&state=b4c6",
            "https://acme.test/login?sso=1&next=https%3A%2F%2Fadmin.acme.test%2F",
            "https://api.acme.test/api/community/auth/google/start",
            "https://accounts.google.com/o/oauth2/v2/auth?client_id=268982671238-x&state=mMSp",
            "https://accounts.google.com/v3/signin/identifier?flowName=GeneralOAuthFlow",
            "https://accounts.google.com/CheckCookie?continue=x&checkedDomains=youtube",
            "https://accounts.youtube.com/accounts/SetSID?ssdc=1&continue=x",
            "https://accounts.google.ru/accounts/SetSID?ssdc=1&continue=x",
            "https://acme.test/api/community/auth/google/callback?code=abc&state=mMSp",
            "https://admin.acme.test/api/community/auth/sso/authorize?client=cc-remote&state=b4c6",
            "https://code.acme.test/api/auth/sso/callback?state=b4c6",
            "https://code.acme.test/",
        ];
        let seen = walk(&chain);
        for (url, d) in chain.iter().zip(&seen) {
            assert_ne!(*d, Nav::External, "this hop must stay in the window: {url}");
        }
        // Landing back on the hub closes the excursion.
        assert_eq!(seen.last(), Some(&Nav::Enter));
    }

    #[test]
    fn the_excursion_closes_when_the_hub_is_reached_again() {
        // After sign-in ends, the very same provider host is a link out again.
        let after = decide("https://accounts.google.ru/accounts/SetSID", false);
        assert_eq!(after, Nav::External);
    }

    #[test]
    fn a_transcript_link_never_repaints_the_window() {
        // The case the whole policy exists for: no sign-in in flight, so a
        // link out of a transcript goes to the browser.
        for url in [
            "https://github.com/anthropics/claude-code",
            "https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
            "https://evil.test/?next=https://code.acme.test",
            "https://code.acme.test.evil.test/w/sessions",
            "https://evil-acme.test/login",
            "mailto:owner@x.test",
        ] {
            assert_eq!(decide(url, false), Nav::External, "should be external: {url}");
        }
    }

    #[test]
    fn a_scheme_the_web_does_not_use_is_handed_to_nobody() {
        // This used to assert `External`, which means the app called the
        // Windows opener on a URL a web page chose — `cmd.exe` included.
        // Refusing without opening is the whole point of `Blocked`.
        for url in [
            "file:///C:/Windows/System32/cmd.exe",
            "javascript:alert(1)",
            "data:text/html,<h1>not the app</h1>",
            "ms-msdt:/id PCWDiagnostic",
            "",
            "not a url at all",
        ] {
            assert_eq!(decide(url, false), Nav::Blocked, "should be blocked: {url}");
        }
    }

    #[test]
    fn the_sign_in_excursion_is_not_a_free_pass_for_every_scheme() {
        // Ten minutes of "wherever the provider goes" used to include `file:`
        // and `data:`. The excursion is about unpredictable HOSTS, not schemes.
        assert_eq!(decide("https://accounts.google.ru/accounts/SetSID", true), Nav::Allow);
        assert_eq!(decide("file:///C:/Windows/System32/cmd.exe", true), Nav::Blocked);
        assert_eq!(decide("data:text/html,<h1>hi</h1>", true), Nav::Blocked);
        // A plaintext hop is not a provider redirect worth rendering.
        assert_eq!(decide("http://accounts.google.ru/x", true), Nav::External);
    }

    #[test]
    fn the_hub_and_the_company_domain_are_always_the_app() {
        assert_eq!(decide("https://code.acme.test/w/sessions", false), Nav::Enter);
        assert_eq!(decide("https://acme.test/login", false), Nav::Allow);
        // The legacy hub name; nginx 301s it and the redirect must land here.
        assert_eq!(decide("https://claude.acme.test/w/sessions", false), Nav::Allow);
        assert_eq!(decide("https://CODE.ACME.TEST/w/sessions", false), Nav::Enter);
        assert_eq!(decide("https://code.acme.test./w/sessions", false), Nav::Enter);
    }

    #[test]
    fn plain_http_is_never_the_hub() {
        // Downgrade would put the session cookie on the wire in clear. Only an
        // explicitly configured dev hub may be http, through CC_HEGAI_URL.
        assert_eq!(decide("http://code.acme.test/w/sessions", false), Nav::External);
    }

    #[test]
    fn an_auth_path_opens_the_excursion_and_a_normal_path_closes_it() {
        assert_eq!(decide("https://code.acme.test/api/auth/sso/start", false), Nav::Signin);
        assert_eq!(decide("https://code.acme.test/w/sessions", true), Nav::Enter);
    }

    #[test]
    fn a_later_auth_hop_does_not_restart_the_clock() {
        // The callback is the provider handing control back, not a second
        // sign-in. Returning Signin here re-armed AUTH_WINDOW, so a callback
        // that errors without redirecting bought another ten permissive
        // minutes — and any flow touching this prefix could do it forever.
        assert_eq!(
            decide("https://code.acme.test/api/auth/sso/callback?x=1", true),
            Nav::Allow
        );
        // But it is still rendered, and it still opens the excursion when one
        // is not already running.
        assert_eq!(
            decide("https://code.acme.test/api/auth/sso/callback?x=1", false),
            Nav::Signin
        );
    }

    #[test]
    fn an_abandoned_sign_in_stops_being_permissive() {
        let flow = AuthFlow::new();
        flow.begin();
        assert!(flow.active());
        // Reach past the clock rather than sleeping for ten minutes.
        *flow.started.lock().unwrap() = Some(Instant::now() - AUTH_WINDOW - Duration::from_secs(1));
        assert!(!flow.active(), "a stale excursion must expire");
        assert!(flow.started.lock().unwrap().is_none(), "and clear itself");
    }

    #[test]
    fn the_log_line_stays_readable() {
        // Google's real URLs are thousands of characters of opaque state.
        assert_eq!(
            brief("https://accounts.google.ru/accounts/SetSID?ssdc=1&sidt=ALWU2cs…"),
            "https://accounts.google.ru/accounts/SetSID?…"
        );
        assert_eq!(brief("https://code.acme.test/w/sessions"), "https://code.acme.test/w/sessions");
    }

    /// The popup decision, as a table. `Allow` is not a courtesy here — it is
    /// the only response that leaves `window.open()` returning a live window,
    /// which is the predicate the Telegram widget branches on before it arms
    /// anything. Downgrading a sign-in hop to `Deny` looks harmless in a diff
    /// and reproduces the blank-panel bug exactly.
    #[test]
    fn a_sign_in_popup_is_allowed_and_a_stranger_is_not() {
        // Not signing in yet: the widget's own popup opens the excursion.
        assert!(matches!(decide("https://acme.test/login", false), Nav::Allow | Nav::Signin));
        // Mid-excursion, the provider roams — oauth.telegram.org is not ours.
        assert!(matches!(decide("https://oauth.telegram.org/auth?bot_id=1", true), Nav::Allow));
        // The same host with no excursion open is a link out, not a popup.
        assert!(matches!(decide("https://oauth.telegram.org/auth?bot_id=1", false), Nav::External));
        // The hub itself ends the excursion rather than opening a window.
        assert!(matches!(decide("https://code.acme.test/w/sessions", true), Nav::Enter));
    }

    /// A `window.open()` becomes a second app window ONLY during a sign-in.
    ///
    /// The bug this pins: a chromeless «Hegai Code» window, holding a live
    /// session and offering no address bar, opened for anything that happened
    /// to pass the navigation policy — where the person was expecting their
    /// browser. The popup exists for one thing, the login widget that answers
    /// through `window.opener`, and that thing is always inside an excursion.
    #[test]
    fn a_link_opens_the_browser_and_not_a_second_app_window() {
        // A link to the web, no sign-in running: refused here, and `popup_plan`
        // hands it to the system browser.
        assert!(matches!(
            popup_outcome(&decide("https://github.com/anthropics", false), false, false),
            PopupPlan::Refuse
        ));
        // A scheme a page chose is refused and handed to NOBODY.
        assert!(matches!(
            popup_outcome(&decide("file:///C:/Windows/System32/cmd.exe", false), false, false),
            PopupPlan::Refuse
        ));
        // The hub's own route: move the window we have, never duplicate the app.
        assert!(matches!(
            popup_outcome(&decide("https://code.acme.test/w/s/m1/s1", false), false, false),
            PopupPlan::MainWindow
        ));
        // An old name for the same app is the same answer.
        assert!(matches!(
            popup_outcome(&decide("https://claude.acme.test/w/sessions", false), false, false),
            PopupPlan::MainWindow
        ));
    }

    /// The other half, and the one a careless tightening breaks: the login
    /// widget needs a REAL window back from `window.open()`, because it hangs
    /// everything on the returned handle and answers through
    /// `window.opener.postMessage`. Refusing these reproduces the blank-panel
    /// bug that `popup_plan` was written to fix.
    #[test]
    fn only_our_own_page_may_ask_for_a_window_of_its_own() {
        // The flag is a REQUEST, and only from the origin we serve. A stranger
        // copying the query gets the answer every stranger gets.
        assert!(wants_own_window("https://code.acme.test/w/s/m1/s1?w=1"));
        assert!(wants_own_window("https://code.acme.test/w/sessions/columns?s=m:s&w=1"));
        assert!(!wants_own_window("https://evil.example/x?w=1"));
        assert!(!wants_own_window("https://code.acme.test/w/s/m1/s1"));
        assert!(!wants_own_window("https://code.acme.test/w/s/m1/s1?w=0"));
        // Not a URL at all.
        assert!(!wants_own_window("javascript:alert(1)?w=1"));
    }

    #[test]
    fn asking_for_a_window_gets_one_and_not_asking_still_moves_this_one() {
        // «Открыть в новом окне» in the session menu — the one control whose
        // whole purpose is a second window.
        assert!(matches!(
            popup_outcome(&decide("https://code.acme.test/w/s/m1/s1?w=1", false), false, true),
            PopupPlan::OwnWindow
        ));
        // The standing rule is untouched: a `target=_blank` on one of our own
        // links still moves the window we already have. This is the pair that
        // stops "open in a new window" from becoming "every link spawns one".
        assert!(matches!(
            popup_outcome(&decide("https://code.acme.test/w/s/m1/s1", false), false, false),
            PopupPlan::MainWindow
        ));
        // And a stranger is still a stranger, flag or no flag: `decide` answers
        // External long before the flag is consulted.
        assert!(matches!(
            popup_outcome(&decide("https://github.com/anthropics?w=1", false), false, false),
            PopupPlan::Refuse
        ));
        // Mid-sign-in the excursion wins: the widget needs a hosted popup with
        // a live `window.opener`, which `OwnWindow` deliberately does not give.
        assert!(matches!(
            popup_outcome(&decide("https://code.acme.test/w/s/m1/s1?w=1", true), true, true),
            PopupPlan::Host
        ));
    }

    /// «Ссылка открывается в самом аппе, а нужно в браузере» (10.10.2026): a
    /// transcript link to one of our own pages, flagged by the SPA, leaves the
    /// app for the system browser — without the flag in the address.
    #[test]
    fn a_flagged_app_link_goes_to_the_browser() {
        let link = "https://code.acme.test/w/reports/abc?ext=1";
        assert!(wants_browser(link));
        assert!(matches!(
            browser_override(popup_outcome(&decide(link, false), false, wants_own_window(link)), true),
            PopupPlan::Browser
        ));
        // Only our own origin may ask; a stranger is External regardless.
        assert!(!wants_browser("https://evil.example/x?ext=1"));
        assert!(!wants_browser("https://code.acme.test/w/reports/abc"));
        assert!(!wants_browser("https://code.acme.test/w/reports/abc?ext=0"));
        // Mid-sign-in the hosted popup wins: the widget needs `window.opener`.
        assert!(matches!(
            browser_override(popup_outcome(&decide(link, true), true, false), true),
            PopupPlan::Host
        ));
        // A refusal stays a refusal (it has already been handed over).
        assert!(matches!(
            browser_override(popup_outcome(&decide("https://github.com/x?ext=1", false), false, false), true),
            PopupPlan::Refuse
        ));
        // Unflagged, the old answers stand.
        assert!(matches!(
            browser_override(popup_outcome(&decide("https://code.acme.test/w/s/m1/s1", false), false, false), false),
            PopupPlan::MainWindow
        ));
    }

    #[test]
    fn the_browser_gets_the_plain_address() {
        assert_eq!(
            without_shell_flags("https://code.acme.test/w/reports/abc?ext=1"),
            "https://code.acme.test/w/reports/abc"
        );
        assert_eq!(
            without_shell_flags("https://code.acme.test/w/sessions/columns?s=m%3As&ext=1&w=1#x"),
            "https://code.acme.test/w/sessions/columns?s=m%3As#x"
        );
    }

    #[test]
    fn a_sign_in_still_gets_a_real_window() {
        // The navigation that STARTS an excursion, before the flag is set.
        assert!(matches!(
            popup_outcome(&decide("https://code.acme.test/api/auth/sso/start", false), false, false),
            PopupPlan::Host
        ));
        // Mid-excursion the provider roams wherever it likes.
        assert!(matches!(
            popup_outcome(&decide("https://oauth.telegram.org/auth?bot_id=1", true), true, false),
            PopupPlan::Host
        ));
        assert!(matches!(
            popup_outcome(&decide("https://accounts.google.ru/accounts/SetSID", true), true, false),
            PopupPlan::Host
        ));
        // And the same host once the excursion is over is a link out again —
        // this is what stops a stale popup window from being a permanent hole.
        assert!(matches!(
            popup_outcome(&decide("https://oauth.telegram.org/auth?bot_id=1", false), false, false),
            PopupPlan::Refuse
        ));
    }
}
