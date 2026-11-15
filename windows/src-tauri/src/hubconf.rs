//! Which hub the shell talks to — chosen once per install, remembered in a word
//! file, changeable from the tray («Сервер…»).
//!
//! Resolution (`resolve_hub`): env `CC_HEGAI_URL` (dev) → the `hub-url` file in
//! the app config dir → `DEFAULT_HUB`. The file is read ONCE at the top of
//! `setup` into a `OnceLock`, before the first caller, so `hub_base()` stays a
//! cheap function and cannot change under a running window.
//!
//! **Bridges.** The page-side bridges (window chrome, the menu bar) are granted
//! by static capability files to `https://code.acme.test/*`. For any other hub
//! the same permission lists are granted at runtime (`grant_bridges`), built from
//! those very files so the two cannot drift.
//!
//! **Trust.** `shell_set_hub` repoints the app. It is granted ONLY to the local
//! «Сервер» window (`capabilities/server-window.json`, `local: true`) and checks
//! the caller's label again; a hub page can never reach it.

use std::sync::OnceLock;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use url::{Host, Url};

use crate::update::{read_word, state_path};
use crate::DEFAULT_HUB;

pub const HUB_FILE: &str = "hub-url";
pub const SERVER_WINDOW: &str = "server";
/// One-shot: the next start shows the window even if argv says `--background`.
pub const SHOW_ONCE: &str = "show-once";

static FILE_HUB: OnceLock<Option<String>> = OnceLock::new();

/// The hub chosen in the file, if any. `None` before `load` and when no valid
/// file exists.
pub fn file_hub() -> Option<String> {
    FILE_HUB.get().cloned().flatten()
}

/// A hub address as typed → its origin, or `None` if it is not one. `https`
/// only; `http` only for loopback (a dev hub). No path, query, fragment or
/// credentials; a trailing slash is fine.
pub fn parse_hub(raw: &str) -> Option<String> {
    let url = Url::parse(raw.trim()).ok()?;
    if url.path() != "/" && !url.path().is_empty() {
        return None;
    }
    if url.query().is_some() || url.fragment().is_some() {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let loopback = match url.host()? {
        Host::Domain(d) => d.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(ip) => ip.is_loopback(),
        Host::Ipv6(ip) => ip.is_loopback(),
    };
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => return None,
    }
    Some(url.origin().ascii_serialization())
}

/// env → file → default. Pure, so the order is testable.
pub fn resolve_hub(env: Option<&str>, file: Option<&str>) -> String {
    env.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches('/').to_string())
        .or_else(|| file.map(str::to_string))
        .unwrap_or_else(|| DEFAULT_HUB.to_string())
}

/// Read the `hub-url` file into the process-wide cell. An invalid file is
/// ignored (and logged) — the default hub is a safe place to land.
pub fn load(app: &AppHandle) {
    let hub = read_word(app, HUB_FILE).and_then(|raw| match parse_hub(&raw) {
        Some(h) => Some(h),
        None => {
            eprintln!("[hub] {HUB_FILE} is not a valid hub address — using the default");
            None
        }
    });
    let _ = FILE_HUB.set(hub);
}

const BRIDGE_CAPABILITIES: [(&str, &str); 3] = [
    ("app-menu", include_str!("../capabilities/app-menu.json")),
    ("window-chrome", include_str!("../capabilities/window-chrome.json")),
    ("window-drag-mac", include_str!("../capabilities/window-drag-mac.json")),
];

/// The static capability JSON, re-aimed at `hub` (an origin, no trailing slash).
fn bridge_capability(id: &str, json: &str, hub: &str) -> Result<String, String> {
    let mut v: serde_json::Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let obj = v.as_object_mut().ok_or("capability is not an object")?;
    obj.insert("identifier".into(), format!("{id}-hub").into());
    obj.remove("$schema");
    let remote = obj.get_mut("remote").and_then(|r| r.as_object_mut()).ok_or("no remote block")?;
    remote.insert("urls".into(), serde_json::json!([format!("{hub}/*")]));
    Ok(v.to_string())
}

/// Grant the three bridges to a non-default hub. Returns whether all landed;
/// on `false` the callers keep the degraded behaviour (no bridge, no overlay).
/// NOTE: a malformed pattern panics inside tauri rather than returning `Err` —
/// callers must pass a clean origin (`init_bridges` checks with `parse_hub`).
pub fn grant_bridges(app: &AppHandle, hub: &str) -> bool {
    let mut ok = true;
    for (id, json) in BRIDGE_CAPABILITIES {
        let res = bridge_capability(id, json, hub).and_then(|c| app.add_capability(c).map_err(|e| e.to_string()));
        if let Err(e) = res {
            eprintln!("[hub] could not grant {id} to {hub}: {e}");
            ok = false;
        }
    }
    ok
}

static BRIDGES: OnceLock<bool> = OnceLock::new();

/// Call at the start of `setup`, after `load`. Records whether the configured
/// hub has its bridges (always true for the default hub).
pub fn init_bridges(app: &AppHandle) {
    let hub = crate::hub_base();
    // `add_capability` PANICS on a pattern it cannot parse (tauri 2.11:
    // `.expect("invalid capability")`), and with `panic = "abort"` that is the
    // whole app on every launch. The file is always a clean origin, but
    // `CC_HEGAI_URL` is not validated — so grant only to a clean origin and
    // leave anything else on the degraded path.
    let ok = hub == DEFAULT_HUB
        || (parse_hub(&hub).as_deref() == Some(hub.as_str()) && grant_bridges(app, &hub));
    let _ = BRIDGES.set(ok);
}

/// Does the configured hub have the bridges the page expects?
pub fn bridges_granted() -> bool {
    BRIDGES.get().copied().unwrap_or(crate::hub_base() == DEFAULT_HUB)
}

/// Tray «Сервер…».
pub fn open_server_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(SERVER_WINDOW) {
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let init = format!(
        "window.__HEGAI_HUB__ = {}; window.__HEGAI_DEFAULT_HUB__ = {};",
        serde_json::to_string(&crate::hub_base()).unwrap_or_else(|_| "null".into()),
        serde_json::to_string(DEFAULT_HUB).unwrap_or_else(|_| "null".into()),
    );
    match WebviewWindowBuilder::new(app, SERVER_WINDOW, WebviewUrl::App("server.html".into()))
        .title("Hegai Code — сервер")
        .inner_size(520.0, 420.0)
        .resizable(false)
        .center()
        .initialization_script(&init)
        .build()
    {
        Ok(w) => {
            // A tray click does not activate the app on macOS: without this
            // the window opens behind whatever was in front (seen on 0.1.28-rc).
            let _ = w.set_focus();
        }
        Err(e) => eprintln!("[hub] could not open the server window: {e}"),
    }
}

/// Save (or, with `None`, clear) the hub and restart. Local «Сервер» window only.
#[tauri::command]
pub async fn shell_set_hub(
    app: AppHandle,
    window: tauri::WebviewWindow,
    url: Option<String>,
) -> Result<(), String> {
    if window.label() != SERVER_WINDOW {
        return Err("недоступно".into());
    }
    match url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => {
            if let Some(p) = state_path(&app, HUB_FILE) {
                match std::fs::remove_file(&p) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(format!("не удалось сбросить: {e}")),
                }
            }
        }
        Some(raw) => {
            let hub = parse_hub(raw).ok_or(
                "Нужен адрес вида https://code.example.com — без пути и параметров (http только для localhost).",
            )?;
            let path = state_path(&app, HUB_FILE).ok_or("нет папки настроек")?;
            std::fs::write(path, &hub).map_err(|e| format!("не удалось сохранить: {e}"))?;
        }
    }
    crate::update::write_word(&app, SHOW_ONCE, "1");
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_plain_https_origins() {
        assert_eq!(parse_hub("https://code.aisurfers.ai").as_deref(), Some("https://code.aisurfers.ai"));
        assert_eq!(parse_hub("  https://Code.Example.com/ \n").as_deref(), Some("https://code.example.com"));
        assert_eq!(parse_hub("https://hub.example.com:8443").as_deref(), Some("https://hub.example.com:8443"));
        assert_eq!(parse_hub("https://hub.example.com:443").as_deref(), Some("https://hub.example.com"));
    }

    #[test]
    fn http_only_on_loopback() {
        assert_eq!(parse_hub("http://localhost:4319").as_deref(), Some("http://localhost:4319"));
        assert_eq!(parse_hub("http://127.0.0.1:4319/").as_deref(), Some("http://127.0.0.1:4319"));
        assert_eq!(parse_hub("http://[::1]:4319").as_deref(), Some("http://[::1]:4319"));
        assert_eq!(parse_hub("http://code.example.com"), None);
        assert_eq!(parse_hub("http://10.0.0.5:4319"), None);
    }

    #[test]
    fn rejects_everything_that_is_not_an_origin() {
        for bad in [
            "",
            "   ",
            "code.example.com",
            "ftp://code.example.com",
            "https://code.example.com/w/sessions",
            "https://code.example.com?x=1",
            "https://code.example.com/?",
            "https://code.example.com#x",
            "https://user:pw@code.example.com",
            "https://",
            "javascript:alert(1)",
        ] {
            assert_eq!(parse_hub(bad), None, "{bad:?} must be refused");
        }
    }

    #[test]
    fn env_beats_file_beats_default() {
        assert_eq!(resolve_hub(Some("http://localhost:4319/"), Some("https://a.example")), "http://localhost:4319");
        assert_eq!(resolve_hub(None, Some("https://a.example")), "https://a.example");
        assert_eq!(resolve_hub(Some("  "), Some("https://a.example")), "https://a.example");
        assert_eq!(resolve_hub(None, None), DEFAULT_HUB);
    }

    #[test]
    fn runtime_capability_copies_the_static_permissions() {
        for (id, json) in BRIDGE_CAPABILITIES {
            let src: serde_json::Value = serde_json::from_str(json).unwrap();
            let out: serde_json::Value =
                serde_json::from_str(&bridge_capability(id, json, "https://code.aisurfers.ai").unwrap()).unwrap();
            assert_eq!(out["permissions"], src["permissions"]);
            assert_eq!(out["windows"], src["windows"]);
            assert_eq!(out["platforms"], src["platforms"]);
            assert_eq!(out["remote"]["urls"], serde_json::json!(["https://code.aisurfers.ai/*"]));
            assert_eq!(out["identifier"], format!("{id}-hub"));
        }
    }

    #[test]
    fn the_hub_setter_is_granted_to_the_local_window_only() {
        let v: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/server-window.json")).unwrap();
        assert_eq!(v["windows"], serde_json::json!([SERVER_WINDOW]));
        assert_eq!(v["permissions"], serde_json::json!(["allow-shell-set-hub"]));
        assert!(v.get("remote").is_none(), "a remote origin must never get shell_set_hub");
        for (_, json) in BRIDGE_CAPABILITIES {
            assert!(!json.contains("shell-set-hub"));
        }
    }
}
